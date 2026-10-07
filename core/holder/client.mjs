// サーバー側から保持役を起こす・見つける・つなぐ口（無停止の更新 段階 2 の 2a。docs/zero-downtime-update/design.md §4.2・plan.md「2a 保持役」）。
// 規約は core/holder/protocol.mjs、保持役の本体は core/holder/holder.mjs、起動口は core/holder/main.mjs。**まだサーバーのターンには配線しない**（2b・2c）。
//   ensureHolder  つなげる保持役が居ればつなぐ。居なければ起こしてつなぐ（起こし方は段階 1 のサーバーと同じ: detached・stdio なし・windowsHide。Job の分岐は desktop/job.cjs）
//   connectHolder 居る保持役だけにつなぐ（起こさない）
//   HolderClient  つながった口。spawn・attach・write・ack・detach などと、out・err・exit・overflow の出来事
// つながりが切れても、保持役と子は残る。つなぎ直しは新しい HolderClient で ensureHolder / connectHolder を呼ぶ。
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { encodeLine, decodeLine, createLineReader } from '../link-codec.mjs';
import { HOLDER_RANGE, HOLDER_PROTOCOL, HOLDER_FILE_VERSION, DEFAULT_MAX_FRAME_BYTES, DEFAULT_HELLO_TIMEOUT_MS, ENV, holderPipeName, holderFilePath } from './protocol.mjs';

export const HOLDER_MAIN = fileURLToPath(new URL('./main.mjs', import.meta.url));
const START_TIMEOUT_MS = 15_000;
/** attach・detach・replay の答えを待つ上限 */
const REQUEST_TIMEOUT_MS = 10_000;
const POLL_MS = 50;
const LOG_TAIL_CHARS = 2000;
/** パイプが無い・誰も待っていない・切られた。古いファイルとして扱い、起こし直す */
const STALE_CODES = new Set(['ENOENT', 'ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'HOLDER_CLOSED']);

const holderError = (code, message, extra = {}) => Object.assign(new Error(message), { code }, extra);
const redact = text => String(text).replace(/token=\S+/g, 'token=[redacted]');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

/** 保持役が書いた名前と秘密のファイル。無い・壊れている・形が違うときは null */
export function readHolderFile(file) {
  try {
    const info = JSON.parse(fs.readFileSync(file, 'utf8'));
    return info?.version === HOLDER_FILE_VERSION && typeof info.pipe === 'string' && typeof info.secret === 'string' ? info : null;
  } catch { return null; }
}

/** ログの末尾（起動の失敗の理由。トークンは伏せる） */
export function readLogTail(file, chars = LOG_TAIL_CHARS) {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const { size } = fs.fstatSync(fd);
      const length = Math.min(size, chars * 4);
      const buffer = Buffer.alloc(length);
      fs.readSync(fd, buffer, 0, length, size - length);
      return redact(buffer.toString('utf8')).slice(-chars).replace(/^�+/, '').trim();
    } finally { fs.closeSync(fd); }
  } catch { return ''; }
}

export const holderLogFile = root => path.join(root, 'logs', 'holder.log');

/**
 * 保持役への口。'out' { id, seq, line, redelivered? }・'err' { id, chunk }・'exit' { id, code, signal, error? }・'overflow' { id, reason, ... }・
 * 'fault' { id?, op, reason }（保持役が断った依頼）・'disconnect'（つながりが切れた。reason は保持役の bye か 'closed'）。
 * spawn・attach は、SDK の最初の stdin の書き込みより前に送る（design.md §4.4。同じ接続の中の順序は保たれる）
 */
export class HolderClient extends EventEmitter {
  constructor({ pipe, secret, appVersion = '', range = HOLDER_RANGE, pid = process.pid, helloTimeoutMs = DEFAULT_HELLO_TIMEOUT_MS, requestTimeoutMs = REQUEST_TIMEOUT_MS, maxFrameBytes = DEFAULT_MAX_FRAME_BYTES, log = () => {} } = {}) {
    super();
    this.options = { pipe, secret, appVersion, range, pid, helloTimeoutMs, requestTimeoutMs, maxFrameBytes, log };
    this.socket = null;
    this.connected = false;
    this.welcome = null;       // { protocol, generation, range, appVersion, pid, children, stash }
    this.byeReason = null;
    this.waiters = new Map();  // 答えの待ち（attached:<id>・detached:<id>・replay:<reqId>）
    this.reqSeq = 0;
  }

  get pid() { return this.welcome?.pid; }

  /**
   * パイプにつないで握手する。合格すると welcome で解決する。失敗は code 付きの Error: ENOENT・ECONNREFUSED（居ない）、
   * HOLDER_REJECTED（秘密は合ったが規約の版が合わない。.holder に { range, generation, appVersion, pid }）、HOLDER_CLOSED（秘密が合わないと何も返さず切られる）、HOLDER_TIMEOUT
   */
  connect() {
    if (this.connected) return Promise.resolve(this.welcome);
    const { pipe, secret, appVersion, range, pid, helloTimeoutMs, maxFrameBytes, log } = this.options;
    const socket = net.connect(pipe);
    this.socket = socket;
    this.byeReason = null;
    return new Promise((resolve, reject) => {
      let settled = false;
      const settle = (fn, value) => { if (settled) return; settled = true; clearTimeout(timer); fn(value); };
      const timer = setTimeout(() => { settle(reject, holderError('HOLDER_TIMEOUT', 'no welcome from the holder')); socket.destroy(); }, helloTimeoutMs);
      const reader = createLineReader({
        maxBytes: maxFrameBytes,
        onDrop: ({ bytes }) => log(`dropped an oversize frame (${bytes} bytes)`),
        onLine: text => {
          let frame;
          try { frame = decodeLine(text); } catch { log('dropped an unreadable frame'); return; }
          if (!settled) {
            if (frame?.t === 'welcome') {
              this.welcome = frame;
              this.connected = true;
              settle(resolve, frame);
            } else if (frame?.t === 'reject') {
              settle(reject, holderError('HOLDER_REJECTED', `the holder rejected the connection (${frame.reason})`, { holder: { range: frame.range, generation: frame.generation, appVersion: frame.appVersion, pid: frame.pid } }));
              socket.destroy();
            }
            return;
          }
          this.onFrame(frame);
        },
      });
      socket.on('connect', () => socket.write(`${encodeLine({ t: 'hello', secret, protocol: range, role: 'server', pid, appVersion })}\n`));
      socket.on('data', chunk => reader.push(chunk));
      socket.on('error', error => settle(reject, error));
      socket.on('close', () => {
        reader.reset();
        if (this.socket === socket) this.socket = null;
        if (!settled) return void settle(reject, holderError('HOLDER_CLOSED', 'the holder closed the connection during the handshake'));
        if (!this.connected) return;
        this.connected = false;
        for (const waiter of this.waiters.values()) waiter.reject(holderError('HOLDER_CLOSED', 'the holder connection was closed'));
        this.waiters.clear();
        this.emit('disconnect', this.byeReason ?? 'closed');
      });
    });
  }

  onFrame(frame) {
    switch (frame?.t) {
      case 'out': case 'err': case 'exit': case 'overflow': this.emit(frame.t, frame); break;
      case 'attached': this.settle(`attached:${frame.id}`, frame); break;
      case 'detached': this.settle(`detached:${frame.id ?? '*'}`, frame); break;
      case 'replay': this.onReplay(frame); break;
      case 'error': {
        // 答えを待っている依頼の失敗は、その待ちを断る。待ちが無ければ出来事にする
        const waiter = this.waiters.get(frame.op === 'replay' ? `replay:${frame.reqId}` : frame.op === 'attach' ? `attached:${frame.id}` : `detached:${frame.id ?? '*'}`);
        if (waiter) { this.dropWaiter(waiter); waiter.reject(holderError('HOLDER_FAULT', `${frame.op}: ${frame.reason}`, { reason: frame.reason })); } else this.emit('fault', frame);
        break;
      }
      case 'bye': this.byeReason = typeof frame.reason === 'string' ? frame.reason : 'bye'; break;
      default: break;
    }
  }

  /** 答えの待ち。保持役が答えなければ requestTimeoutMs で HOLDER_TIMEOUT にする */
  wait(key, extra = {}) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.waiters.delete(key); reject(holderError('HOLDER_TIMEOUT', `no answer from the holder (${key})`)); }, this.options.requestTimeoutMs);
      timer.unref?.();
      const waiter = { key, resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); }, ...extra };
      this.waiters.set(key, waiter);
    });
  }
  dropWaiter(waiter) { this.waiters.delete(waiter.key); }
  settle(key, value) {
    const waiter = this.waiters.get(key);
    if (!waiter) return;
    this.waiters.delete(key);
    waiter.resolve(value);
  }
  onReplay(frame) {
    const waiter = this.waiters.get(`replay:${frame.reqId}`);
    if (!waiter) return;
    for (const [seq, line] of frame.lines ?? []) waiter.lines.push({ seq, line });
    if (frame.done) { this.waiters.delete(waiter.key); waiter.resolve({ lines: waiter.lines, first: frame.first, last: frame.last, truncated: frame.truncated }); }
  }

  /** 保持役へ送る。送れたら true。つながっていない・上限を超える・JSON にできないときは何もせず false */
  send(frame) {
    const socket = this.socket;
    if (!this.connected || !socket || socket.destroyed || !socket.writable) return false;
    let line;
    try { line = `${encodeLine(frame)}\n`; } catch (error) { this.options.log(`unsendable frame: ${error?.message ?? error}`); return false; }
    if (Buffer.byteLength(line) - 1 > this.options.maxFrameBytes) { this.options.log(`dropped an oversize frame (${frame.t})`); return false; }
    socket.write(line);
    return true;
  }

  /**
   * 子を起こさせる。policy は 'claude-control' | 'jsonrpc' | 'none'。env は子の環境変数の全部（保持役の環境は渡さない）。出力は out・exit の出来事で届く。
   * keepMs: 親が居ない状態がこれだけ続いたら、保持役が子を木ごと止める（終わらない子の保険。古い保持役は知らない欄で、読み捨てる）
   */
  spawn({ id, command, args = [], cwd, env, policy = 'none', label = null, keepMs = 0 }) {
    return this.send({ t: 'spawn', id, command, args, cwd, env, framing: 'lines', policy, label, ...(keepMs > 0 ? { keepMs } : {}) });
  }
  /** 既存の子に付ける。from（既定は ack の次）から記録を流し直す。答えは子の状態。控えの渡し直し（redelivered の out）と記録の続きが、その後に続く */
  attach(id, { from } = {}) {
    const answer = this.wait(`attached:${id}`);
    if (!this.send({ t: 'attach', id, ...(from ? { from } : {}) })) { this.waiters.delete(`attached:${id}`); return Promise.reject(holderError('HOLDER_CLOSED', 'not connected')); }
    return answer;
  }
  write(id, data) { return this.send({ t: 'write', id, data }); }
  end(id) { return this.send({ t: 'end', id }); }
  kill(id, { tree = false } = {}) { return this.send({ t: 'kill', id, tree }); }
  ack(id, seq) { return this.send({ t: 'ack', id, seq }); }
  mark(id, name, seq) { return this.send({ t: 'mark', id, name, ...(seq ? { seq } : {}) }); }
  unmark(id, name) { return this.send({ t: 'unmark', id, name }); }
  label(id, label) { return this.send({ t: 'label', id, label }); }
  stash(stash) { return this.send({ t: 'stash', stash }); }
  release(id) { return this.send({ t: 'release', id }); }
  /** 手を離す（id 無しは全部）。答えが来た時点で、この親からの write・end・kill は転送されない。その後に SDK の query を閉じる（design.md §4.4） */
  detach(id) {
    const answer = this.wait(`detached:${id ?? '*'}`);
    if (!this.send({ t: 'detach', ...(id ? { id } : {}) })) { this.waiters.delete(`detached:${id ?? '*'}`); return Promise.reject(holderError('HOLDER_CLOSED', 'not connected')); }
    return answer;
  }
  /** 記録の [from, to] を読み直す（再生用）。記録から落ちた分があれば truncated */
  replay(id, from, to) {
    const reqId = `r${++this.reqSeq}`;
    const answer = this.wait(`replay:${reqId}`, { id, lines: [] });
    if (!this.send({ t: 'replay', id, from, to, reqId })) { this.waiters.delete(`replay:${reqId}`); return Promise.reject(holderError('HOLDER_CLOSED', 'not connected')); }
    return answer;
  }
  /** 保持役に、子を木ごと止めて終わらせる */
  shutdown() { return this.send({ t: 'shutdown' }); }
  /** つながりだけをやめる（保持役と子は残る） */
  close() {
    const socket = this.socket;
    if (!socket || socket.destroyed) return;
    if (this.connected && socket.writable) socket.write(`${encodeLine({ t: 'bye', reason: 'leaving' })}\n`);
    socket.end();
  }
}

/**
 * 居る保持役につなぐ（起こさない）。居なければ code 'HOLDER_NONE'。つなげたが付けられないときは connect のエラー。
 * generation はつなぐ保持役の世代（規約の版。既定はこの版が起こす世代。1 つ前の世代の保持役の子を付け直すときは、その版で呼ぶ。design.md §4.3）
 */
export async function connectHolder({ dataDir, root, appVersion = '', generation = HOLDER_PROTOCOL, platform, log = () => {}, ...options } = {}) {
  const range = [generation, generation];
  const info = readHolderFile(holderFilePath(root, dataDir, { protocol: generation, platform }));
  if (!info) throw holderError('HOLDER_NONE', 'no holder file');
  const client = new HolderClient({ pipe: info.pipe, secret: info.secret, appVersion, range, log, ...options });
  try {
    await client.connect();
  } catch (error) {
    if (STALE_CODES.has(error.code)) throw holderError('HOLDER_NONE', `stale holder file (${error.code})`);
    throw error;
  }
  log(`connected to the holder (pid ${client.pid}, generation ${client.welcome.generation})`);
  return client;
}

/**
 * 保持役を、サーバーの子でない形で起こす。戻り値 { pid }。
 *   mode 'detached'   Node の child_process（detached・stdio なし・windowsHide）。段階 1 のサーバーと同じ
 *   mode 'breakaway'  koffi の CreateProcessW + CREATE_BREAKAWAY_FROM_JOB（desktop/job.cjs）
 *   mode 'auto'（既定）自分の Job の制限を調べて分ける（desktop/job.cjs の inspectJob・decideLaunch）。unsupported なら code 'HOLDER_UNSUPPORTED'
 */
export async function launchHolder({ dataDir, root, key = '', appVersion = '', nodeExe = process.execPath, script = HOLDER_MAIN, env = process.env, cwd = undefined, idleMs = undefined,
  mode = 'auto', spawnProcess = spawn, jobModule = () => createRequire(import.meta.url)('../../desktop/job.cjs'), log = () => {} } = {}) {
  let chosen = mode;
  let job = null;
  if (mode === 'auto' || mode === 'breakaway') {
    try { job = jobModule(); } catch (error) { if (mode === 'breakaway') throw error; }
  }
  if (mode === 'auto') {
    const decision = job ? job.decideLaunch(job.inspectJob()) : { mode: 'detached', reason: 'no job module' };
    log(`job: ${decision.mode} (${decision.reason})`);
    if (decision.mode === 'unsupported') throw holderError('HOLDER_UNSUPPORTED', `the holder cannot outlive the server: ${decision.reason}`);
    chosen = decision.mode;
  }
  const holderEnv = { ...env, [ENV.data]: dataDir, [ENV.root]: root, [ENV.key]: key, [ENV.appVersion]: appVersion };
  delete holderEnv.AGENT_HOST_TOKEN;          // 保持役は画面のトークンを要らない
  delete holderEnv.ELECTRON_RUN_AS_NODE;
  if (idleMs !== undefined) holderEnv[ENV.idleMs] = String(idleMs);
  if (chosen === 'breakaway') return job.launchBreakaway({ exe: nodeExe, args: [script], cwd, env: holderEnv });
  const child = spawnProcess(nodeExe, [script], { cwd, env: holderEnv, detached: true, stdio: 'ignore', windowsHide: true });
  await new Promise((resolve, reject) => { child.once('error', reject); child.once('spawn', resolve); });
  child.on('error', () => {});
  child.unref();
  return { pid: child.pid };
}

/**
 * つなげる保持役が居ればつなぐ。居なければ起こして、つなげるまで待つ（上限 timeoutMs）。戻り値 { client, started, pid }
 * 同時に 2 つ起こされても、パイプを作れるのは最初の 1 つだけ（負けた方は何も書かずに終わる）。待つ側は、誰かが書いたファイルにつなげれば足りる
 */
export async function ensureHolder({ dataDir, root, key = '', appVersion = '', timeoutMs = START_TIMEOUT_MS, pollMs = POLL_MS, log = () => {}, launch = launchHolder, ...options } = {}) {
  const connectOptions = { dataDir, root, appVersion, log, ...(options.client ?? {}) };
  try { const client = await connectHolder(connectOptions); return { client, started: false, pid: client.pid }; }
  catch (error) { if (error.code !== 'HOLDER_NONE') throw error; }
  let started;
  try { started = await launch({ dataDir, root, key, appVersion, log, ...options }); }
  catch (error) { throw error.code === 'HOLDER_UNSUPPORTED' ? error : holderError('HOLDER_LAUNCH', `could not start the holder: ${error.message}`, { cause: error }); }
  log(`started the holder (pid ${started.pid})`);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try { const client = await connectHolder(connectOptions); return { client, started: true, pid: client.pid }; }
    catch (error) { if (error.code !== 'HOLDER_NONE') throw error; }
    if (!isAlive(started.pid)) {
      // 負けた方は先に終わる。勝った保持役が書いたファイルが現れるのを、もう少しだけ待つ
      const lateDeadline = Date.now() + 2000;
      while (Date.now() < lateDeadline) {
        try { const client = await connectHolder(connectOptions); return { client, started: true, pid: client.pid }; }
        catch (error) { if (error.code !== 'HOLDER_NONE') throw error; }
        await sleep(pollMs);
      }
      throw holderError('HOLDER_EXITED', 'the holder exited during startup', { detail: readLogTail(holderLogFile(root)) });
    }
    if (Date.now() >= deadline) throw holderError('HOLDER_TIMEOUT', 'the holder did not come up in time', { detail: readLogTail(holderLogFile(root)) });
    await sleep(pollMs);
  }
}

export { holderPipeName, holderFilePath };
