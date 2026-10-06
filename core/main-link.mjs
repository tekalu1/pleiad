// main への口の、名前付きパイプの実装（段階 1 の 1-2。docs/zero-downtime-update/design.md §7.1、plan.md）。
// サーバーがパイプを作って待ち受け、握手（hello の版・秘密）が合った main だけを、core/main-port.mjs の口につなぐ。
// utilityProcess の parentPort の代わりに createMainPort({ parentPort: link.port }) へ渡す（setMainPortSource）。
// main 側の対は desktop/server-link.cjs。符号化は core/link-codec.mjs。
//
// 運ぶもの: 1 行 1 JSON。**この形は版をまたいで変えない（ipc の版 1）**
//   main -> サーバー  { t: 'hello', ipc: [min, max], appVersion, secret }
//   サーバー -> main  { t: 'welcome', ipc, range: [min, max], appVersion, pid }
//                     { t: 'reject', reason: 'ipc', range: [min, max], appVersion, pid }（秘密が合ったうえで版が合わないときだけ。秘密が合わなければ何も返さず切る）
//   両方向            { t: 'msg', d: <parentPort と同じメッセージ> }・{ t: 'bye', reason }（これから切る。サーバーは新しい main に替わるとき 'replaced'）
// 知らない t は読み捨てる。メッセージの型（secret・computer-*・running・shutdown など）はここでは解釈しない。
// 版を聞く（hello → welcome / reject）・引き継ぎを頼む・終わらせる（shutdown のメッセージ）の 3 つは、版をまたいで形を変えない。
//
// 秘密は起動ごとに作り、データ置き場の main-link.json（権限 0600）に書く。パイプの名前と ipc の範囲は control.json にも足す
// （core/control-file.mjs）。main は main-link.json から名前と秘密を読んで付ける。
// つながっているのは常に 1 つ。後から合格した main があれば古い方を bye('replaced') で切る。
// 切れている間のサーバーからの送信は溜めずに捨て、postMessage が false を返す（機能ごとの扱いは 1-5）。
import net from 'node:net';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { writeAtomic } from './atomic-file.mjs';
import { encodeLine, decodeLine, createLineReader, DEFAULT_MAX_LINE_BYTES } from './link-codec.mjs';

export const LINK_FILE = 'main-link.json';
export const LINK_FILE_VERSION = 1;
/** この版が話せる main との口の版（[min, max]）。握手の形を変えない限り上げない */
export const IPC_RANGE = [1, 1];
export const HELLO_MAX_BYTES = 64 * 1024;
export const DEFAULT_HELLO_TIMEOUT_MS = 5000;
// 書いても読まれずに溜まる量の上限。超えたら溜めずに捨てる（false を返す）
export const DEFAULT_MAX_QUEUED_BYTES = 64 * 1024 * 1024;

export const linkFilePath = dataDir => path.join(dataDir, LINK_FILE);

/** 名前付きパイプを使うか。`AGENT_HOST_HANDOVER=on` のときだけ（既定は off = 今の utilityProcess） */
export function handoverEnabled(env = process.env) {
  return String(env.AGENT_HOST_HANDOVER ?? '').toLowerCase() === 'on';
}

/**
 * データ置き場（と利用者）ごとのパイプの名前。Windows は \\.\pipe\pleiad-main-<ハッシュ>、
 * それ以外は一時フォルダーの unix ソケット（テスト・開発用）
 */
export function mainLinkPipeName(dataDir, { platform = process.platform, user = safeUser(), tmpdir = os.tmpdir() } = {}) {
  const resolved = path.resolve(dataDir);
  const key = platform === 'win32' ? resolved.toLowerCase() : resolved;
  const hash = crypto.createHash('sha256').update(`${key}\n${user}`).digest('hex').slice(0, 16);
  return platform === 'win32' ? `\\\\.\\pipe\\pleiad-main-${hash}` : path.join(tmpdir, `pleiad-main-${hash}.sock`);
}

function safeUser() {
  try { return os.userInfo().username; } catch { return ''; }
}

/** main-link.json を読む。無い・壊れている・形が違うときは null */
export function readLinkFile(dataDir) {
  try {
    const info = JSON.parse(fs.readFileSync(linkFilePath(dataDir), 'utf8'));
    if (info?.version !== LINK_FILE_VERSION || typeof info.pipe !== 'string' || typeof info.secret !== 'string') return null;
    return info;
  } catch { return null; }
}

/** 自分（pid が同じ）が書いたものだけ消す。同期（process.on('exit') から呼ぶ） */
export function removeLinkFile({ dataDir, pid = process.pid }) {
  try {
    if (readLinkFile(dataDir)?.pid === pid) fs.rmSync(linkFilePath(dataDir), { force: true });
  } catch { /* 無い・読めないものは消さない */ }
}

const sameSecret = (a, b) => {
  const left = crypto.createHash('sha256').update(String(a)).digest();
  const right = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(left, right);
};

const validRange = range => Array.isArray(range) && range.length === 2 && range.every(n => Number.isInteger(n) && n >= 0) && range[0] <= range[1];

/** 口の中身。parentPort と同じ on / off / postMessage に、connected と 'connect'・'disconnect' を足した形 */
class MainLinkPort extends EventEmitter {
  constructor(link) { super(); this.link = link; }
  get connected() { return this.link.isConnected(); }
  /** 切れても次の main が付け直す（機能ごとの扱いは core/main-away.mjs・1-5） */
  get resumable() { return true; }
  postMessage(message) { return this.link.send(message); }
  /** つながっている main の握手の中身（{ appVersion, ipc }）。切れていれば null */
  get peer() { return this.link.peerInfo(); }
}

/**
 * @param dataDir     データ置き場（パイプの名前・main-link.json の置き場）
 * @param appVersion  この版（welcome・reject に載せる）
 * @param ipc         話せる口の版の範囲（テストが差し替える）
 * @param secret      握手の秘密（既定は起動ごとの乱数。テストが差し替える）
 * @param pipe        パイプの名前（テストが差し替える）
 * @returns { port, listen, close, dispose, info, pipe, secret }
 */
export function createMainLink({ dataDir, appVersion = '', ipc = IPC_RANGE, secret = crypto.randomBytes(32).toString('hex'), pipe = mainLinkPipeName(dataDir),
  maxLineBytes = DEFAULT_MAX_LINE_BYTES, maxQueuedBytes = DEFAULT_MAX_QUEUED_BYTES, helloTimeoutMs = DEFAULT_HELLO_TIMEOUT_MS,
  platform = process.platform, log = () => {} } = {}) {
  const port = new MainLinkPort({ isConnected: () => Boolean(current), send: message => send(message), peerInfo: () => current?.peer ?? null });
  let server = null;
  let current = null;                 // 握手が済んだ接続 { socket, peer }
  const sockets = new Set();          // 握手の前も含む全部の接続

  function emit(type, ...args) {
    try { port.emit(type, ...args); } catch (error) { log(`${type} listener threw: ${error?.message ?? error}`); }
  }

  function writeLine(socket, frame, { limit = maxLineBytes } = {}) {
    if (socket.destroyed || !socket.writable) return false;
    let line;
    try { line = `${encodeLine(frame)}\n`; } catch (error) { log(`unsendable value: ${error?.message ?? error}`); return false; }
    const bytes = Buffer.byteLength(line);
    if (bytes - 1 > limit) { log(`dropped an oversize line (${bytes} bytes)`); return false; }
    if (socket.writableLength + bytes > maxQueuedBytes) { log('dropped a message: too much queued'); return false; }
    socket.write(line);
    return true;
  }

  function send(message) {
    return current ? writeLine(current.socket, { t: 'msg', d: message }) : false;
  }

  function detach(entry, reason) {
    if (current !== entry) return;
    current = null;
    log(`main disconnected (${reason})`);
    emit('disconnect');
  }

  function onConnection(socket) {
    sockets.add(socket);
    const entry = { socket, peer: null };
    let authed = false;
    const timer = setTimeout(() => socket.destroy(), helloTimeoutMs);
    timer.unref?.();

    const reader = createLineReader({
      maxBytes: HELLO_MAX_BYTES,
      onDrop: ({ bytes }) => { log(`dropped an oversize line (${bytes} bytes)`); if (!authed) socket.destroy(); },
      onLine: text => {
        let frame;
        try { frame = decodeLine(text); } catch { if (!authed) socket.destroy(); return; }
        if (!authed) return void handshake(frame);
        if (frame?.t === 'msg') emit('message', { data: frame.d });
        else if (frame?.t === 'bye') socket.end();
      },
    });

    function handshake(hello) {
      // 秘密が合うまでは何も返さない（パイプの既定の権限は同じ利用者以外にも開いているかもしれない。design.md §4.2）
      if (hello?.t !== 'hello' || typeof hello.secret !== 'string' || !sameSecret(hello.secret, secret)) return void socket.destroy();
      const base = { range: ipc, appVersion, pid: process.pid };
      if (!validRange(hello.ipc) || hello.ipc[1] < ipc[0] || hello.ipc[0] > ipc[1]) {
        writeLine(socket, { t: 'reject', reason: 'ipc', ...base });
        socket.end();
        return;
      }
      clearTimeout(timer);
      authed = true;
      reader.maxBytes = maxLineBytes;
      entry.peer = { appVersion: typeof hello.appVersion === 'string' ? hello.appVersion : '', ipc: hello.ipc };
      const chosen = Math.min(hello.ipc[1], ipc[1]);
      if (current) {          // 後から来た main が勝つ（二重起動・落ちかけの main の取り残し）
        const old = current;
        writeLine(old.socket, { t: 'bye', reason: 'replaced' });
        detach(old, 'replaced');
        old.socket.end();             // bye を流しきってから閉じる
      }
      writeLine(socket, { t: 'welcome', ipc: chosen, ...base });
      current = entry;
      log(`main connected (ipc ${chosen}, version ${entry.peer.appVersion || '?'})`);
      emit('connect');
    }

    socket.on('data', chunk => reader.push(chunk));
    socket.on('error', () => {});
    socket.on('close', () => {
      clearTimeout(timer);
      reader.reset();
      sockets.delete(socket);
      detach(entry, 'closed');
    });
  }

  const info = () => ({ pipe, ipc });

  return {
    port, pipe, secret, info,
    isConnected: () => Boolean(current),
    /** パイプを作って待ち受け、main-link.json を書く。2 回目以降は何もしない。パイプが取れなければ投げる */
    async listen() {
      if (server) return info();
      if (platform !== 'win32') await fs.promises.rm(pipe, { force: true });
      const created = net.createServer(onConnection);
      await new Promise((resolve, reject) => { created.once('error', reject); created.listen(pipe, () => { created.off('error', reject); resolve(); }); });
      created.on('error', error => log(`pipe error: ${error?.message ?? error}`));
      server = created;
      if (platform !== 'win32') await fs.promises.chmod(pipe, 0o600).catch(() => {});
      await fs.promises.mkdir(dataDir, { recursive: true });
      await writeAtomic(linkFilePath(dataDir), `${JSON.stringify({ version: LINK_FILE_VERSION, pid: process.pid, pipe, ipc, appVersion, secret, startedAt: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600 });
      return info();
    },
    /** つながりを全部切り、パイプを閉じ、main-link.json を消す */
    async close() {
      const closing = server;
      server = null;
      if (current) { writeLine(current.socket, { t: 'bye', reason: 'closing' }); current.socket.end(); }
      // bye を流しきる間だけ待つ。閉じない相手は切る
      const stuck = setTimeout(() => { for (const socket of sockets) socket.destroy(); }, 1000);
      for (const socket of sockets) if (socket !== current?.socket) socket.destroy();
      if (closing) await new Promise(resolve => closing.close(() => resolve()));
      clearTimeout(stuck);
      removeLinkFile({ dataDir });
    },
    /** 同期の後片付け（process.on('exit') から）。main-link.json だけ消す。パイプはプロセスと一緒に消える */
    dispose() { removeLinkFile({ dataDir }); },
  };
}
