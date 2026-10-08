// 接続の子（ADR 0167）。Chrome への ws を持つ、保持役（core/holder/）の子。サーバーが入れ替わっても（引き継ぎ・異常終了）、main が入れ替わっても切れない。
// 持つのは ws だけ（つなぐ途中＝確認を待っている upgrade も含む）。状態機械・中継・窓の台帳はサーバーに残す。
//   Chrome ──ws── このプロセス ──名前付きパイプ（core/chrome/link-wire.mjs の約束）── サーバー（core/chrome/link.mjs）
// 起こされ方: 環境変数 PLEIAD_LINK_PIPE・PLEIAD_LINK_SECRET（パイプの名前と挨拶の秘密。保持役の札と同じ値）、PLEIAD_LINK_ROOT・PLEIAD_LINK_KEY（使用中の印）。
// stdout には何も書かない（保持役の記録に積まない）。stdin が閉じたら（保持役が居なくなったら）終わる。
//
// 大きい行（映像のフレーム・撮影の答え。BIG_LINE_BYTES 以上）は JSON を解かず、先頭の数百バイトで id と method を読むだけで流す。
// つなぎ手（サーバー）が居ない間:
//   - Fetch.requestPaused は Fetch.failRequest（BlockedByClient）を同じ sessionId で返す（サイトの利用の確認を、居ない間も「疑わしきは通さない」にする）
//     大きい行（64 KB 以上の URL・ヘッダーなど）の requestPaused も、requestId と sessionId を読むために解いて同じに扱う
//   - つなぎ手が居ても、そのつなぎ手が Fetch.enable を送っていないセッションの requestPaused は、前のサーバーの置き土産で誰も答えない。同じく failRequest で返す
//   - つなぎ手に流して答えが来ていない requestPaused は覚えておき、つなぎ手が替わる・切れるときに failRequest で返す（答える者が居なくなる）
//   - ほかのイベントと答えは捨てる。Target.attachedToTarget・detachedFromTarget だけは見て、セッションの一覧を保つ（新しいサーバーが外して付け直す）
// 新しいつなぎ手には firstId = （前のつなぎ手が振った最大の id）+ ID_GAP を渡し、それ未満の id の答えは流さない。
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { markRuntimeInUse } from '../runtime-use.mjs';
import { LINK_VERSION, BIG_LINE_BYTES, CARRY_MAX_BYTES, HELLO_TIMEOUT_MS, ID_GAP, NEWLINE, LineReader, controlLine, parseControl, peekLine } from './link-wire.mjs';

/** つなぎ手に溜まって書けない量の上限（超えたらつなぎ手を切る。サーバーが読まなくなったときに、このプロセスのメモリを増やさない） */
const CLIENT_BACKLOG_BYTES = 64 * 1024 * 1024;

export function startLinkChild({ pipe, secret, root = '', key = '', log = () => {} } = {}) {
  if (!pipe || !secret) throw new Error('link child needs pipe and secret');
  const releaseUse = root && key ? markRuntimeInUse({ root, key }) : null;
  const state = { phase: 'idle', gen: 0, ws: null, port: null, path: null, upgradeAt: null, maxId: 0, sessions: new Map(), carry: null, carryInvalid: false };
  let client = null;   // 今のつなぎ手のソケット
  const pending = new Map();   // 今のつなぎ手に流して、答え（continue・fail・fulfill…）がまだ来ていない requestPaused: requestId -> sessionId
  const bound = new Set();     // 今のつなぎ手が Fetch.enable したセッション（sessionId。ブラウザー全体は ''）
  let quitting = false;

  const writeControl = (socket, name, value) => { if (socket && !socket.destroyed) socket.write(controlLine(name, value)); };
  const toClient = (name, value) => writeControl(client, name, value);
  const resetWs = () => { state.phase = 'idle'; state.ws = null; state.port = null; state.path = null; state.upgradeAt = null; state.sessions.clear(); pending.clear(); bound.clear(); };

  // ---- Chrome からの行 ----------------------------------------------------------------------
  function trackSession(method, buf) {
    if (buf.length >= BIG_LINE_BYTES) return;
    let message;
    try { message = JSON.parse(buf.toString('utf8')); } catch { return; }
    const params = message?.params;
    if (method === 'Target.attachedToTarget' && params?.sessionId) state.sessions.set(params.sessionId, params.targetInfo?.targetId ?? null);
    else if (method === 'Target.detachedFromTarget' && params?.sessionId) state.sessions.delete(params.sessionId);
  }

  /** requestPaused の行から { requestId, sessionId }。大きい行も解く（読めなければ null） */
  function pausedOf(buf) {
    let message;
    try { message = JSON.parse(buf.toString('utf8')); } catch { return null; }
    const requestId = message?.params?.requestId;
    return requestId ? { requestId, sessionId: message.sessionId ?? '' } : null;
  }

  function failRequest({ requestId, sessionId }) {
    if (!state.ws || state.ws.readyState !== WebSocket.OPEN) return;
    // この id は番号の空間の外（サーバーの番号は firstId から）。答えは「つなぎ手が居ない」ので捨てる id を使う
    state.ws.send(JSON.stringify({ id: ++state.maxId, method: 'Fetch.failRequest', params: { requestId, errorReason: 'BlockedByClient' }, ...(sessionId ? { sessionId } : {}) }));
  }

  /** つなぎ手が替わる・切れる: 流してあって答えの来ていない止まった要求を全部断る（答える者が居なくなる）。つなぎ手の持ち物も捨てる */
  function dropClientState() {
    for (const [requestId, sessionId] of pending) failRequest({ requestId, sessionId });
    pending.clear(); bound.clear();
  }

  let firstId = 1;   // 今のつなぎ手に渡した番号の始まり
  function fromChrome(buf) {
    const peek = peekLine(buf);
    if (peek.kind === 'event') {
      if (peek.method === 'Target.attachedToTarget' || peek.method === 'Target.detachedFromTarget') trackSession(peek.method, buf);
      if (peek.method === 'Fetch.requestPaused') {
        const paused = pausedOf(buf);
        if (!client || (paused && !bound.has(paused.sessionId))) { if (paused) failRequest(paused); return; }
        if (paused) pending.set(paused.requestId, paused.sessionId);
      } else if (!client) return;
    } else {
      if (!client) return;
      if (peek.kind === 'id' && peek.id < firstId) return;   // 前のつなぎ手への答え
    }
    if (client.writableLength > CLIENT_BACKLOG_BYTES) { log('chrome-link: client backlog too large, dropping client'); client.destroy(); return; }
    client.cork();
    client.write(buf); client.write(NEWLINE);
    client.uncork();
  }

  // ---- ws -----------------------------------------------------------------------------------
  // opened・fail・closed には、それが指す接続の世代（gen。サーバーが !open で付けた番号）を載せる。サーバーは今の接続のものだけを受ける
  function endWs(ws, gen, { status = 0, code = null } = {}) {
    if (state.ws !== ws) return;   // 自分で閉じた・もう次の接続になっている
    const wasOpen = state.phase === 'open';
    resetWs();
    if (wasOpen) toClient('closed', { code, gen });
    else toClient('fail', { status, code, gen });
  }

  function openWs(url, gen) {
    if (state.phase !== 'idle') { toClient('fail', { status: 0, code: 'EBUSY', gen }); return; }
    let parsed;
    try { parsed = new URL(url); } catch { toClient('fail', { status: 0, code: 'EINVAL', gen }); return; }
    state.gen = gen;
    state.phase = 'upgrading'; state.upgradeAt = Date.now(); state.port = Number(parsed.port) || null; state.path = parsed.pathname + parsed.search;
    const ws = new WebSocket(url, { perMessageDeflate: false });
    state.ws = ws;
    let errorCode = null;
    ws.on('open', () => { if (state.ws !== ws) return; state.phase = 'open'; toClient('opened', { gen }); });
    // 確認を閉じた・「キャンセル」を押したとき、Chrome は HTTP 403 で断る（core/chrome/connection.mjs）
    ws.on('unexpected-response', (_req, res) => {
      const status = res.statusCode;
      try { res.resume(); } catch { /* 読み捨て */ }
      try { ws.terminate(); } catch { /* 同上 */ }
      endWs(ws, gen, { status });
    });
    ws.on('error', error => { errorCode = error?.code ?? null; });
    ws.on('close', code => endWs(ws, gen, { code: errorCode ?? code }));
    ws.on('message', (data, isBinary) => { if (!isBinary) fromChrome(Buffer.isBuffer(data) ? data : Buffer.from(data)); });
  }

  function closeWs() {
    const ws = state.ws;
    resetWs();
    try { ws?.terminate(); } catch { /* 閉じていてもよい */ }   // サーバーが自分で閉じた接続には答えない（サーバーは閉じた時点で終わりにしている）
  }

  // ---- つなぎ手（サーバー） -------------------------------------------------------------------
  const FETCH_METHOD = /^\{"id":\d+,"method":"(Fetch\.[A-Za-z]+)"/;
  const FETCH_ANSWERS = new Set(['Fetch.continueRequest', 'Fetch.failRequest', 'Fetch.fulfillRequest', 'Fetch.continueWithAuth', 'Fetch.continueResponse']);
  /** つなぎ手の Fetch の行を見て、どのセッションが答える側か・どの止まった要求に答えたかを覚える */
  function watchFetch(buf) {
    const method = FETCH_METHOD.exec(buf.toString('latin1', 0, Math.min(buf.length, 256)))?.[1];
    if (!method || (method !== 'Fetch.enable' && method !== 'Fetch.disable' && !FETCH_ANSWERS.has(method))) return;
    let message;
    try { message = JSON.parse(buf.toString('utf8')); } catch { return; }
    if (method === 'Fetch.enable') bound.add(message.sessionId ?? '');
    else if (method === 'Fetch.disable') bound.delete(message.sessionId ?? '');
    else if (message.params?.requestId) pending.delete(message.params.requestId);
  }

  function toChrome(buf) {
    const peek = peekLine(buf);
    if (peek.kind === 'id' && peek.id > state.maxId) state.maxId = peek.id;
    watchFetch(buf);
    const ws = state.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(buf.toString('utf8'));
  }

  function onControl(socket, control) {
    const { name, value } = control;
    if (name === 'open') { if (typeof value?.url === 'string') openWs(value.url, Number(value.gen) || 0); else writeControl(socket, 'fail', { status: 0, code: 'EINVAL', gen: Number(value?.gen) || 0 }); return; }
    if (name === 'close') { closeWs(); return; }
    if (name === 'carry') {
      const carry = value?.carry;
      // 預けられなかった（大きすぎる）ときは、古い carry を残さず「無効」の印にする（新しいサーバーは、古い一時停止・停止の印を信じずに全部止めて始める）
      if (value?.invalid === true) { state.carry = null; state.carryInvalid = true; return; }
      state.carryInvalid = false;
      if (carry === undefined || carry === null) state.carry = null;
      else if (Buffer.byteLength(JSON.stringify(carry), 'utf8') <= CARRY_MAX_BYTES) state.carry = carry;
      else { state.carry = null; state.carryInvalid = true; }
      return;
    }
    if (name === 'quit') { quit(); }
  }

  function welcome(socket) {
    firstId = state.maxId + ID_GAP;
    writeControl(socket, 'welcome', {
      v: LINK_VERSION, phase: state.phase, gen: state.gen, port: state.port, path: state.path, upgradeAt: state.upgradeAt, firstId,
      sessions: [...state.sessions].map(([sessionId, targetId]) => ({ sessionId, targetId })), carry: state.carry, carryInvalid: state.carryInvalid,
    });
    // 新しい番号の空間は firstId から。以後このつなぎ手が振る番号が maxId に届くので、ここで追いつかせる
    state.maxId = Math.max(state.maxId, firstId - 1);
  }

  const server = net.createServer(socket => {
    let greeted = false;
    const timer = setTimeout(() => { if (!greeted) socket.destroy(); }, HELLO_TIMEOUT_MS);
    socket.setNoDelay?.(true);
    const reader = new LineReader({
      onLine(line) {
        const control = parseControl(line);
        if (!greeted) {
          if (control?.name !== 'hello' || control.value?.secret !== secret) { socket.destroy(); return; }
          greeted = true; clearTimeout(timer);
          // 版が合わないときも挨拶は受ける（welcome.v で相手が見分け、quit を送ってくる）
          if (client && client !== socket) { dropClientState(); client.destroy(); }   // 新しいつなぎ手が古いほうを切る
          client = socket;
          welcome(socket);
          return;
        }
        if (client !== socket) return;
        if (control) onControl(socket, control); else toChrome(line);
      },
      onOverflow: () => log('chrome-link: oversized line dropped'),
    });
    socket.on('data', chunk => reader.push(chunk));
    socket.on('error', () => {});
    socket.on('close', () => { clearTimeout(timer); if (client === socket) { dropClientState(); client = null; } });
  });
  server.on('error', error => { log(`chrome-link: pipe error ${error?.code ?? error?.message}`); });

  const listening = new Promise((resolve, reject) => {
    if (process.platform !== 'win32') { try { fs.rmSync(pipe, { force: true }); } catch { /* 無ければよい */ } }
    server.once('error', reject);
    server.listen(pipe, () => { server.off('error', reject); resolve(); });
  });

  function quit() {
    if (quitting) return;
    quitting = true;
    const ws = state.ws;
    resetWs();
    try { ws?.terminate(); } catch { /* 閉じていてもよい */ }
    if (client) { try { client.destroy(); } catch { /* 同上 */ } }
    try { server.close(); } catch { /* 同上 */ }
    if (process.platform !== 'win32') { try { fs.rmSync(pipe, { force: true }); } catch { /* 同上 */ } }
    releaseUse?.();
    setImmediate(() => process.exit(0));
  }

  return { listening, quit, state };
}

// 保持役の子として起こされたとき
if (process.env.PLEIAD_LINK_PIPE && process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const child = startLinkChild({ pipe: process.env.PLEIAD_LINK_PIPE, secret: process.env.PLEIAD_LINK_SECRET, root: process.env.PLEIAD_LINK_ROOT, key: process.env.PLEIAD_LINK_KEY });
  child.listening.catch(() => process.exit(1));
  // 保持役が居なくなったら（stdin が閉じる）終わる
  process.stdin.on('end', () => child.quit());
  process.stdin.on('error', () => child.quit());
  process.stdin.resume();
}
