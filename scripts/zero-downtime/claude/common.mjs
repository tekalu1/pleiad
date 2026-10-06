// 段階 0（Claude）の探りの共通部分。保持役（holder.mjs）への口と、SDK の spawnClaudeCodeProcess に渡す偽の子プロセス。
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { execFileSync } from 'node:child_process';

export const sleep = ms => new Promise(r => setTimeout(r, ms));

export function claudePath() {
  if (process.env.CLAUDE_BIN) return process.env.CLAUDE_BIN;
  const out = execFileSync(process.platform === 'win32' ? 'where' : 'which', ['claude'], { encoding: 'utf8' }).split(/\r?\n/).filter(Boolean);
  return out.find(p => /\.exe$/i.test(p)) ?? out[0];
}

export function pipePath(name) {
  return process.platform === 'win32' ? `\\\\.\\pipe\\${name}` : path.join(os.tmpdir(), `${name}.sock`);
}

/** 保持役への接続。1 行 1 JSON。on(handler) に来たものをそのまま渡す */
export function connectHolder(pipe) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(pipe);
    const handlers = new Set();
    let buf = '';
    sock.setEncoding('utf8');
    sock.on('data', d => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (!line) continue;
        const m = JSON.parse(line);
        for (const h of handlers) h(m);
      }
    });
    sock.on('error', reject);
    sock.on('connect', () => {
      sock.off('error', reject);
      sock.on('error', () => {});
      resolve({
        sock,
        send: obj => sock.write(JSON.stringify(obj) + '\n'),
        on: h => { handlers.add(h); return () => handlers.delete(h); },
        close: () => sock.destroy(),
      });
    });
  });
}

/** 1 つのリクエスト（reqId 付き）→ 応答 */
export function holderRequest(client, msg, replyType, timeoutMs = 5000) {
  const reqId = Math.random().toString(36).slice(2);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { off(); reject(new Error(`holder request timeout: ${msg.t}`)); }, timeoutMs);
    const off = client.on(m => { if (m.t === replyType && m.reqId === reqId) { clearTimeout(timer); off(); resolve(m); } });
    client.send({ ...msg, reqId });
  });
}

/**
 * SDK の spawnClaudeCodeProcess に渡す関数を作る。
 *   mode 'spawn': 保持役に CLI を起動させる（SDK が決めた command / args / env をそのまま渡す）
 *   mode 'attach': 既にある子（id）に付ける。command / args は捨てる。from 以降の記録を流し直してもらう。redeliver なら答えていない依頼の控えも
 * onLine(seq, line, info) は SDK の stdout に流す直前に呼ぶ（記録用）
 */
export function makeSpawn({ client, id, mode, from = 1, redeliver = false, onLine = () => {}, onAttached = () => {}, onProcess = () => {} }) {
  return options => {
    const proc = new EventEmitter();
    const stdout = new PassThrough();
    let exited = false;
    let detached = false;   // 旧サーバーが手を離したあとは、SDK の後始末（stdin の終了・kill・取り消しの応答）を保持役へ送らない
    const stdin = new Writable({
      write(chunk, _enc, cb) { if (!detached) client.send({ t: 'write', id, data: chunk.toString('utf8') }); cb(); },
      final(cb) { if (!detached) client.send({ t: 'end', id }); cb(); },
    });
    Object.assign(proc, { stdin, stdout, killed: false, exitCode: null, signalCode: null });
    proc.kill = () => { proc.killed = true; if (!detached) client.send({ t: 'kill', id }); return true; };
    proc.detach = () => { detached = true; };
    onProcess(proc);
    client.on(m => {
      if (m.id !== id) return;
      if (m.t === 'out') { onLine(m.seq, m.line, m); stdout.write(m.line + '\n'); }
      else if (m.t === 'attached') onAttached(m);
      else if (m.t === 'exit' && !exited) { exited = true; proc.exitCode = m.code ?? null; proc.signalCode = m.signal ?? null; stdout.end(); proc.emit('exit', m.code ?? null, m.signal ?? null); }
    });
    // SDK は返り値を受け取るとすぐ stdin に initialize を書く。spawn / attach を先に送らないと、その書き込みが保持役で捨てられる
    // （最初の版はここを setImmediate にしていて、最初の initialize が CLI に届かなかった）
    if (mode === 'spawn') client.send({ t: 'spawn', id, command: options.command, args: options.args, cwd: options.cwd, env: options.env });
    else client.send({ t: 'attach', id, from, redeliver });
    return proc;
  };
}

/** SDK に渡す入力の流れ。push で user メッセージを足し、close で閉じる（閉じるまで CLI の stdin は閉じない） */
export function createInput() {
  const queue = [];
  let wake = null;
  let closed = false;
  return {
    push(text) { queue.push({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null }); wake?.(); },
    close() { closed = true; wake?.(); },
    async *[Symbol.asyncIterator]() {
      for (;;) {
        if (queue.length) { yield queue.shift(); continue; }
        if (closed) return;
        await new Promise(r => { wake = r; });
        wake = null;
      }
    },
  };
}

export function tmpRoot(name) {
  const dir = path.join(os.tmpdir(), `zdu-claude-${name}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
