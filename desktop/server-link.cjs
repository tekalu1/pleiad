// main 側の、サーバーとの名前付きパイプの口（段階 1 の 1-2。サーバー側は core/main-link.mjs。docs/zero-downtime-update/design.md §7.1）。
// utilityProcess の worker と同じ形（on('message')・off・once('exit')・postMessage・kill）の包みを返すので、
// desktop/*-bridge.cjs・computer/service.cjs・resident.cjs は worker の代わりにこれを渡すだけでよい。
//   - 'message' はメッセージそのもの（utilityProcess の worker と同じ。サーバー側の口の { data } とは違う）
//   - **つながりが切れたら 'exit'**（computer/service.cjs の releaseAll・computer-overlay.cjs の hideAll が on('exit') で後始末する。つなぎ直しても残る）。
//     つながりをやめたときも、サーバーに切られたときも、サーバーが終わったときも同じ。exit(code): 0 = 静かに終わった（bye・終了）、1 = 異常（つながりの異常・大きすぎる行など）
//   - 切れたあとの postMessage は何もせず false（溜めない）。connect() をもう一度呼べば同じ包みでつなぎ直せる（'message' の登録はそのまま残る。
//     once('exit') は 1 回で消えるので、つなぎ直しのたびに付け直す）
//   - **最初に connect する前**の postMessage だけは溜めて（上限 MAX_QUEUED 件）、つながった直後に順に送る（true を返す）。
//     utilityProcess.fork の直後に main が worker.postMessage する（browser-viewer-bridge の読み込みの方針の依頼など）のと同じ使い方を、つながる前から許すため。
//     つながったことがある包みは溜めない（切れた後は false）。つながらないまま捨てるなら clearQueue()
//   - kill() は「終わらせる」の握手: shutdown のメッセージを送って、つながりを閉じる（サーバーは今の worker.postMessage({ type: 'shutdown' }) と同じに終わる）
//   - **connect() の前に on('message') を付ける**（サーバーはつながった直後に最新の ready を送る。つないだ後に付けると取りこぼす）
// stdout・stderr は無い（パイプの経路ではサーバーが logs\ のファイルに書く。1-4）。
const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const LINK_FILE = 'main-link.json';
const HELLO_REPLY_TIMEOUT_MS = 5000;
const IPC_RANGE = [1, 1];
const MAX_QUEUED = 1000;

/** サーバーが書く main-link.json（{ pipe, secret, ipc, pid, appVersion }）。無い・壊れていれば null */
function readLinkInfo(dataDir) {
  try {
    const info = JSON.parse(fs.readFileSync(path.join(dataDir, LINK_FILE), 'utf8'));
    return info?.version === 1 && typeof info.pipe === 'string' && typeof info.secret === 'string' ? info : null;
  } catch { return null; }
}

let codecPromise = null;
const loadCodec = () => (codecPromise ??= import('../core/link-codec.mjs'));

function linkError(code, message, extra = {}) {
  return Object.assign(new Error(message), { code }, extra);
}

class ServerLink extends EventEmitter {
  /**
   * @param pipe        サーバーのパイプの名前（main-link.json の pipe）。connect({ pipe }) で替えてもよい
   * @param secret      握手の秘密（main-link.json の secret）
   * @param appVersion  この main の版（hello に載せる）
   * @param ipc         話せる口の版の範囲 [min, max]
   */
  constructor({ pipe = null, secret = null, appVersion = '', ipc = IPC_RANGE, helloTimeoutMs = HELLO_REPLY_TIMEOUT_MS, maxLineBytes = undefined, log = () => {} } = {}) {
    super();
    this.options = { pipe, secret, appVersion, ipc, helloTimeoutMs, maxLineBytes, log };
    this.socket = null;
    this.codec = null;
    this.connected = false;
    this.serverInfo = null;   // welcome の { ipc, range, appVersion, pid }
    this.exitReason = null;
    this.everConnected = false;
    this.queue = [];          // 最初に connect する前に postMessage された物
  }

  /** サーバーのプロセス ID（つながっている間と、切れた後の最後の値） */
  get pid() { return this.serverInfo?.pid; }

  /**
   * パイプにつないで握手する。合格すると welcome（{ ipc, range, appVersion, pid }）で解決する。
   * 失敗は code 付きの Error: ENOENT・ECONNREFUSED（サーバーが居ない・古い main-link.json）、LINK_REJECTED（秘密は合ったが ipc の範囲が合わない。
   * .server に { range, appVersion, pid }）、LINK_CLOSED（握手の途中で切られた。秘密が合わないと何も返さず切られる）、LINK_TIMEOUT
   */
  async connect({ pipe = this.options.pipe, secret = this.options.secret } = {}) {
    if (this.connected) return this.serverInfo;
    if (this.socket) throw linkError('LINK_BUSY', 'already connecting');
    if (!pipe || !secret) throw linkError('LINK_NO_TARGET', 'pipe and secret are required');
    this.options.pipe = pipe; this.options.secret = secret;
    const codec = this.codec ??= await loadCodec();
    const { appVersion, ipc, helloTimeoutMs, maxLineBytes, log } = this.options;
    const socket = net.connect(pipe);
    this.socket = socket;
    this.exitReason = null;
    return new Promise((resolve, reject) => {
      let settled = false;
      let byeReason = null;
      let failed = false;
      const settle = (fn, value) => { if (settled) return; settled = true; clearTimeout(timer); fn(value); };
      const timer = setTimeout(() => { settle(reject, linkError('LINK_TIMEOUT', 'no welcome from the server')); socket.destroy(); }, helloTimeoutMs);

      const reader = codec.createLineReader({
        maxBytes: maxLineBytes,
        onDrop: ({ bytes }) => { log(`dropped an oversize line (${bytes} bytes)`); },
        onLine: text => {
          let frame;
          try { frame = codec.decodeLine(text); } catch { log('dropped an unreadable line'); return; }
          if (!settled) {
            if (frame?.t === 'welcome') {
              this.serverInfo = { ipc: frame.ipc, range: frame.range, appVersion: frame.appVersion, pid: frame.pid };
              this.connected = true;
              this.everConnected = true;
              const queued = this.queue.splice(0);
              for (const message of queued) this.postMessage(message);
              log(`connected to the server (ipc ${frame.ipc}, version ${frame.appVersion || '?'}, pid ${frame.pid})`);
              settle(resolve, this.serverInfo);
            } else if (frame?.t === 'reject') {
              failed = true;
              settle(reject, linkError('LINK_REJECTED', `server rejected the link (${frame.reason})`, { reason: frame.reason, server: { range: frame.range, appVersion: frame.appVersion, pid: frame.pid } }));
              socket.destroy();
            }
            return;
          }
          if (frame?.t === 'msg') {
            try { this.emit('message', frame.d); } catch (error) { log(`message listener threw: ${error?.message ?? error}`); }
          } else if (frame?.t === 'bye') {
            byeReason = typeof frame.reason === 'string' ? frame.reason : 'bye';
          }
        },
      });

      socket.on('connect', () => {
        const hello = { t: 'hello', ipc, appVersion, secret };
        socket.write(`${codec.encodeLine(hello)}\n`);
      });
      socket.on('data', chunk => reader.push(chunk));
      socket.on('error', error => { failed = true; settle(reject, error); });
      socket.on('close', () => {
        reader.reset();
        if (this.socket === socket) this.socket = null;
        if (!settled) return void settle(reject, linkError('LINK_CLOSED', 'the server closed the link during the handshake'));
        if (!this.connected) return;
        this.connected = false;
        this.exitReason = byeReason ?? (failed ? 'error' : 'closed');
        this.emit('exit', failed ? 1 : 0);
      });
    });
  }

  /** サーバーへ送る。送れたら true。つながっていない・行の上限を超える・JSON にできないときは何もせず false（溜めない） */
  postMessage(message) {
    if (!this.everConnected) {
      if (this.queue.length >= MAX_QUEUED) return false;
      this.queue.push(message);
      return true;
    }
    const socket = this.socket;
    if (!this.connected || !socket || socket.destroyed || !socket.writable || !this.codec) return false;
    let line;
    try { line = `${this.codec.encodeLine({ t: 'msg', d: message })}\n`; } catch (error) { this.options.log(`unsendable value: ${error?.message ?? error}`); return false; }
    const limit = this.options.maxLineBytes ?? 16 * 1024 * 1024;
    if (Buffer.byteLength(line) - 1 > limit) { this.options.log(`dropped an oversize line (${Buffer.byteLength(line)} bytes)`); return false; }
    socket.write(line);
    return true;
  }

  /** つなぐ前に溜めた物を捨てる */
  clearQueue() { this.queue.length = 0; }

  /** 「終わらせる」の握手。shutdown を送ってから閉じる（utilityProcess の worker.kill() の代わり） */
  kill() {
    const sent = this.postMessage({ type: 'shutdown' });
    this.leave('kill');
    return sent;
  }

  /** サーバーは動かしたまま、つながりだけをやめる（main が終わるとき・付け直しの前）。'exit' は切れた後に 1 回出る */
  leave(reason = 'leaving') {
    const socket = this.socket;
    if (!socket || socket.destroyed) return;
    if (this.connected && this.codec && socket.writable) socket.write(`${this.codec.encodeLine({ t: 'bye', reason })}\n`);
    socket.end();
  }
}

/** worker と同じ形の包みを作る（つなぐのは connect()）。options は ServerLink の引数 */
function createServerLink(options) {
  return new ServerLink(options);
}

module.exports = { createServerLink, readLinkInfo, LINK_FILE };
