'use strict';
// macOS のヘルパー（desktop/computer/mac/ の pleiad-computer-helper）を子プロセスとして 1 つ起こし、標準入出力の JSON Lines で話す（ADR 0173 §1）。
// 頼み: {"id":1,"op":"capture","args":{...}} / 答え: {"id":1,"ok":true,"data":{...}} か {"id":1,"ok":false,"error":{"code":"...","message":"..."}}
// 起きたら最初に {"event":"hello","protocol":1,...} を 1 行出す。落ちたら待っていた頼みは failed で返し、次の頼みで起こし直す。
// spawn は注入する（試験は偽のヘルパーを渡す）。
const childProcess = require('node:child_process');
const { StringDecoder } = require('node:string_decoder');
const { ComputerError } = require('./errors.cjs');

const PROTOCOL = 1;
const REQUEST_TIMEOUT_MS = 10_000;
const HELLO_TIMEOUT_MS = 5_000;
const MAX_LINE = 64 * 1024 * 1024; // 撮影の base64（長辺 1568 の JPEG でも数 MB）より十分大きく

/** 1 行の答えを、頼みの結果（data）か ComputerError にする。形の崩れた行は null */
function parseLine(line) {
  let message;
  try { message = JSON.parse(line); } catch { return null; }
  if (!message || typeof message !== 'object') return null;
  if (message.event === 'hello') return { hello: message };
  if (!Number.isInteger(message.id)) return null;
  if (message.ok === true) return { id: message.id, data: message.data ?? {} };
  const error = message.error ?? {};
  const { code, message: text, ...extra } = error;
  return { id: message.id, error: new ComputerError(code, String(text ?? 'helper failed'), extra) };
}

/** Buffer の塊を行に分ける（CR を落とし、空行は飛ばす） */
function createLineReader(onLine, { maxLine = MAX_LINE } = {}) {
  let pending = '';
  const decoder = new StringDecoder('utf8');
  return chunk => {
    pending += decoder.write(chunk);
    let index;
    while ((index = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, index).replace(/\r$/, '');
      pending = pending.slice(index + 1);
      if (line.length <= maxLine && line.trim()) onLine(line);
    }
    if (pending.length > maxLine) pending = ''; // 改行の来ない巨大な出力は捨てる
  };
}

/**
 * @param {object} deps
 * @param {string} deps.command ヘルパーの実行ファイルのパス
 * @param {Function} [deps.spawn] child_process.spawn と同じ形
 * @param {(line: string) => void} [deps.log]
 */
function createHelperClient({ command, args = [], spawn = childProcess.spawn, log = () => {}, timeouts = {} }) {
  const requestTimeout = timeouts.request ?? REQUEST_TIMEOUT_MS;
  const helloTimeout = timeouts.hello ?? HELLO_TIMEOUT_MS;
  let child = null;
  let ready = null; // hello を待つ Promise
  let hello = null;
  let cancelHello = null;
  let nextId = 1;
  const pending = new Map(); // id → { resolve, reject, timer, op }

  function failAll(error) {
    for (const [id, entry] of pending) { clearTimeout(entry.timer); entry.reject(error); pending.delete(id); }
  }

  function start() {
    let proc;
    try {
      proc = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    } catch (error) {
      return Promise.reject(new ComputerError('unsupported', `could not start the helper: ${error.message}`));
    }
    child = proc;
    hello = null;
    ready = new Promise((resolve, reject) => {
      const helloTimer = setTimeout(() => { reject(new ComputerError('failed', 'the helper did not say hello')); stop(); }, helloTimeout);
      cancelHello = () => { clearTimeout(helloTimer); reject(new ComputerError('failed', 'the helper was stopped')); };
      const onLine = line => {
        if (child !== proc) return;
        const parsed = parseLine(line);
        if (!parsed) { log(`helper: ignored line ${line.slice(0, 120)}`); return; }
        if (parsed.hello) {
          clearTimeout(helloTimer);
          cancelHello = null;
          hello = parsed.hello;
          if (hello.supported === false) { reject(new ComputerError('unsupported', 'the helper does not support this OS')); stop(); return; }
          if (hello.protocol !== PROTOCOL) { reject(new ComputerError('unsupported', `helper protocol ${hello.protocol} (want ${PROTOCOL})`)); stop(); return; }
          resolve(hello);
          return;
        }
        const entry = pending.get(parsed.id);
        if (!entry) return;
        pending.delete(parsed.id);
        clearTimeout(entry.timer);
        if (parsed.error) entry.reject(parsed.error); else entry.resolve(parsed.data);
      };
      proc.stdout.on('data', createLineReader(onLine));
      proc.stderr?.on('data', chunk => { const text = chunk.toString('utf8').trim(); if (text) log(`helper: ${text.slice(0, 500)}`); });
      const gone = reason => {
        clearTimeout(helloTimer);
        if (child !== proc) return;
        child = null; ready = null;
        cancelHello = null;
        const error = new ComputerError('failed', `the helper exited (${reason})`);
        reject(error);
        failAll(error);
      };
      proc.on('error', error => gone(error.message));
      proc.on('exit', (code, signal) => gone(signal ?? `code ${code}`));
      proc.stdin.on('error', () => {}); // 落ちた後の書き込みの EPIPE は exit で扱う
    });
    ready.catch(() => {}); // 誰も待っていないときの unhandled を防ぐ
    return ready;
  }

  function ensure() { return child && ready ? ready : start(); }

  /** @returns {Promise<object>} data。失敗は ComputerError */
  async function call(op, args = {}, { timeout = requestTimeout, signal } = {}) {
    if (signal?.aborted) throw new ComputerError('stopped', 'stopped');
    await ensure();
    if (signal?.aborted) throw new ComputerError('stopped', 'stopped');
    const proc = child;
    if (!proc) throw new ComputerError('failed', 'the helper is not running');
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new ComputerError('timeout', `helper ${op} timed out`)); stop(); }, timeout);
      pending.set(id, { resolve, reject, timer, op });
      try { proc.stdin.write(`${JSON.stringify({ id, op, args })}\n`); } catch (error) {
        clearTimeout(timer); pending.delete(id); reject(new ComputerError('failed', `could not write to the helper: ${error.message}`));
      }
    });
  }

  /** 終わらせる（標準入力を閉じると、ヘルパーは押したままを離して終わる） */
  function stop() {
    const proc = child;
    cancelHello?.(); cancelHello = null;
    child = null; ready = null;
    if (!proc) return;
    failAll(new ComputerError('failed', 'the helper was restarted'));
    try { proc.stdin.end(); } catch { /* もう閉じている */ }
    const killer = setTimeout(() => { try { proc.kill(); } catch { /* 終わっている */ } }, 1000);
    killer.unref?.();
    proc.once?.('exit', () => clearTimeout(killer));
  }

  return { call, stop, get hello() { return hello; }, get running() { return !!child; } };
}

module.exports = { createHelperClient, parseLine, createLineReader, PROTOCOL };
