// ターンの保持役の本体（無停止の更新 段階 2 の 2a。docs/zero-downtime-update/design.md §4、plan.md「2a 保持役」）。
// エージェントの CLI を子として起こし、stdin・stdout・stderr と終了コードを持つ。サーバーが入れ替わっても子は止まらない。規約は core/holder/protocol.mjs。
//   - 子の stdout・stderr は、親が居ても居なくても、親が読んでいなくても**常に読む**（読まないと CLI が止まる。stage0-claude §5）。行ごとに通番を振って記録する
//   - 記録は、印（mark）と ack より前を捨てる。上限（maxRecordBytes）を超えたら古い行から捨てて truncated を立てる
//   - 親へは記録のカーソルから送る。親が読まなければ書いたまま溜めず（highWaterBytes）、drain まで待つ（保持役のメモリは記録の上限で止まる）
//   - 答えていない依頼の控え（policy）: claude-control は control_request を request_id で控え、付け直した親へ渡し直すのは mcp_message と elicitation だけ。
//     jsonrpc は id と method を持つ依頼を控える。none は行だけ
//   - detach の後は、その親からの write・end・kill を転送しない。親が切れても子の stdin は閉じない。親の書き込みが行の途中で切れたら、その行は捨てる
// やらないこと: エージェントのプロトコルの解釈（上の見分け以外）・JSON-RPC の id の付け替え・initialize の答え・HTTP・データ置き場への書き込み。
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { spawn } from 'node:child_process';
import { writeAtomic } from '../atomic-file.mjs';
import { encodeLine, decodeLine, createLineReader } from '../link-codec.mjs';
import {
  HOLDER_RANGE, HOLDER_FILE_VERSION, POLICIES, DEFAULT_MAX_LINE_BYTES, DEFAULT_MAX_FRAME_BYTES, HELLO_MAX_BYTES, DEFAULT_HELLO_TIMEOUT_MS,
  DEFAULT_MAX_RECORD_BYTES, DEFAULT_HIGH_WATER_BYTES, DEFAULT_IDLE_MS, STDERR_TAIL_BYTES, STASH_MAX_BYTES, LABEL_MAX_BYTES,
} from './protocol.mjs';

/** 1 回に親へ流す量。これを超えたら setImmediate で一度イベントループへ返す（記録が大きくても止めない） */
const PUMP_BATCH_BYTES = 1024 * 1024;
const REPLAY_CHUNK_BYTES = 1024 * 1024;
const MAX_PENDING = 1000;
/** claude-control で付け直した親へ渡し直す control_request の種類。CLI が再送しないもの（in-process の MCP と stdio の MCP の elicitation）だけ。
 *  can_use_tool は再 initialize の pending_permission_requests で戻り、hook_callback は CLI が自分で取り消す */
const REDELIVER_SUBTYPES = new Set(['mcp_message', 'elicitation']);

const sameSecret = (a, b) => {
  const left = crypto.createHash('sha256').update(String(a)).digest();
  const right = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(left, right);
};
const validRange = range => Array.isArray(range) && range.length === 2 && range.every(n => Number.isInteger(n) && n >= 0) && range[0] <= range[1];
const parseJson = line => { try { const value = JSON.parse(line); return value && typeof value === 'object' ? value : null; } catch { return null; } };
const jsonBytes = value => { try { return Buffer.byteLength(JSON.stringify(value) ?? 'null'); } catch { return Infinity; } };
const isNonEmptyString = value => typeof value === 'string' && value.length > 0;

/** パイプに誰か居るか（unix ソケットの二重起動の確かめ。Windows の名前付きパイプは最初のインスタンスしか作れない） */
function probe(pipe) {
  return new Promise(resolve => {
    const socket = net.connect(pipe);
    const done = alive => { clearTimeout(timer); socket.destroy(); resolve(alive); };
    const timer = setTimeout(() => done(false), 1000);
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

/**
 * @param pipe       パイプの名前（protocol.mjs の holderPipeName）
 * @param secret     hello の秘密（既定は起動ごとの乱数）
 * @param file       名前と秘密を書くファイル（protocol.mjs の holderFilePath。null なら書かない。listen が済んでから書く）
 * @param range      話せる規約の版 [min, max]（max が世代）
 * @param onIdle     子が 1 つも生きておらず親が idleMs つながっていないとき
 * @param onShutdown 親が shutdown を送ってきたとき（子を止めて終わるのは呼び出し側。close() を呼ぶ）
 * @returns { listen, close, dispose, snapshot, pipe, secret, info }
 */
export function createHolder({ pipe, secret = crypto.randomBytes(32).toString('hex'), appVersion = '', file = null, range = HOLDER_RANGE,
  maxLineBytes = DEFAULT_MAX_LINE_BYTES, maxFrameBytes = DEFAULT_MAX_FRAME_BYTES, maxRecordBytes = DEFAULT_MAX_RECORD_BYTES,
  highWaterBytes = DEFAULT_HIGH_WATER_BYTES, helloTimeoutMs = DEFAULT_HELLO_TIMEOUT_MS, idleMs = DEFAULT_IDLE_MS, exitGraceMs = 2000,
  platform = process.platform, spawnProcess = spawn, onIdle = () => {}, onShutdown = () => {}, log = () => {} } = {}) {
  const generation = range[1];
  const children = new Map();   // id -> 子の状態
  const conns = new Set();      // 握手の前も含む全部の接続
  let current = null;           // 握手が済んだ親
  let stash = {};
  let server = null;
  let idleTimer = null;

  // ---- 送る
  function send(conn, frame) {
    const socket = conn.socket;
    if (socket.destroyed || !socket.writable) return false;
    let line;
    try { line = `${encodeLine(frame)}\n`; } catch (error) { log(`unsendable frame: ${error?.message ?? error}`); return false; }
    if (Buffer.byteLength(line) - 1 > maxFrameBytes) { log(`dropped an oversize frame (${frame.t})`); return false; }
    socket.write(line);
    return true;
  }
  const subOf = (conn, id) => conn.subs?.get(id);

  // ---- 記録（子ごと。通番は連続なので、通番 → 位置は引き算で求まる）
  const first = c => c.entries[c.start]?.seq ?? c.seq + 1;
  const entryAt = (c, seq) => {
    const head = c.entries[c.start];
    return head && seq >= head.seq ? c.entries[c.start + (seq - head.seq)] : undefined;
  };
  function dropFront(c) {
    c.bytes -= c.entries[c.start].bytes;
    c.entries[c.start++] = undefined;
    if (c.start > 4096 && c.start * 2 > c.entries.length) { c.entries = c.entries.slice(c.start); c.start = 0; }
  }
  /** 印と ack より前を捨てる。それでも上限を超えるなら、必要な行まで捨てて truncated */
  function trim(c) {
    const keepFrom = Math.min(c.marks.size ? Math.min(...c.marks.values()) : Infinity, c.acked + 1);
    while (c.start < c.entries.length && c.entries[c.start].seq < keepFrom) dropFront(c);
    while (c.bytes > maxRecordBytes && c.start < c.entries.length - 1) {
      dropFront(c);
      if (!c.truncated) { c.truncated = true; log(`child ${c.id}: the record exceeded ${maxRecordBytes} bytes; dropping lines that are still needed`); }
    }
  }

  // ---- 答えていない依頼の控え
  function observeOutput(c, seq, line) {
    let request = null;
    if (c.policy === 'claude-control' && line.includes('control_')) {
      const m = parseJson(line);
      if (m?.type === 'control_request' && isNonEmptyString(m.request_id)) request = { key: m.request_id, subtype: m.request?.subtype ?? null };
      else if (m?.type === 'control_cancel_request') c.pending.delete(m.request_id);
    } else if (c.policy === 'jsonrpc' && line.includes('"id"')) {
      const m = parseJson(line);
      if (m && m.id !== undefined && m.id !== null && typeof m.method === 'string') request = { key: JSON.stringify(m.id), subtype: m.method };
    }
    if (!request) return;
    c.pending.set(request.key, { seq, line, subtype: request.subtype });
    if (c.pending.size > MAX_PENDING) c.pending.delete(c.pending.keys().next().value);
  }
  function observeInput(c, line) {
    if (c.policy === 'claude-control' && line.includes('control_response')) {
      const m = parseJson(line);
      if (m?.type === 'control_response') c.pending.delete(m.response?.request_id);
    } else if (c.policy === 'jsonrpc' && line.includes('"id"')) {
      const m = parseJson(line);
      if (m && m.id !== undefined && m.id !== null && m.method === undefined) c.pending.delete(JSON.stringify(m.id));
    }
  }
  /** 付け直した親へ渡し直す控え。claude-control は REDELIVER_SUBTYPES だけ */
  const redeliverable = c => [...c.pending.values()].filter(p => c.policy === 'jsonrpc' || REDELIVER_SUBTYPES.has(p.subtype)).sort((a, b) => a.seq - b.seq);

  function snapshotOf(c) {
    return {
      id: c.id, pid: c.pid ?? null, alive: !c.exit, exitCode: c.exit?.code ?? null, signal: c.exit?.signal ?? null, error: c.exit?.error ?? null,
      label: c.label, policy: c.policy, seq: c.seq, first: first(c), acked: c.acked, marks: Object.fromEntries(c.marks), truncated: c.truncated,
      pendingRequests: [...c.pending].map(([requestId, p]) => ({ requestId, seq: p.seq, subtype: p.subtype })), stderr: c.stderr,
    };
  }
  const snapshot = () => ({ pid: process.pid, generation, children: [...children.values()].map(snapshotOf), stash, connected: Boolean(current) });

  // ---- 親へ流す（記録のカーソルから。読まない親には書き溜めない）
  function pump(conn, c) {
    const sub = subOf(conn, c.id);
    if (!sub || sub.detached || sub.scheduled || conn.socket.destroyed) return;
    let sent = 0;
    for (;;) {
      if (conn.socket.writableLength >= highWaterBytes) return;    // 'drain' で続ける
      const head = first(c);
      if (sub.cursor < head) {
        send(conn, { t: 'overflow', id: c.id, reason: 'record', first: head });
        sub.cursor = head;
      }
      const entry = entryAt(c, sub.cursor);
      if (!entry) break;
      send(conn, { t: 'out', id: c.id, seq: entry.seq, line: entry.line });
      sub.cursor++;
      sent += entry.bytes;
      if (sent >= PUMP_BATCH_BYTES) {
        sub.scheduled = true;
        setImmediate(() => { sub.scheduled = false; pump(conn, c); });
        return;
      }
    }
    if (c.exit && !sub.exitSent) {
      sub.exitSent = true;
      send(conn, { t: 'exit', id: c.id, code: c.exit.code, signal: c.exit.signal, ...(c.exit.error ? { error: c.exit.error } : {}) });
    }
  }
  const eachSub = (c, fn) => { for (const conn of conns) { const sub = subOf(conn, c.id); if (sub && !sub.detached) fn(conn, sub); } };
  const pumpAll = c => { for (const conn of conns) pump(conn, c); };

  // ---- 子
  function append(c, text) {
    const seq = ++c.seq;
    const bytes = Buffer.byteLength(text);
    c.entries.push({ seq, line: text, bytes });
    c.bytes += bytes;
    observeOutput(c, seq, text);
    if (c.bytes > maxRecordBytes) trim(c);
  }

  function finish(c) {
    if (c.exit) return;
    clearTimeout(c.exitTimer);
    c.reader.push(Buffer.from('\n'));    // 改行の来なかった最後の行
    c.exit = c.exitInfo ?? { code: null, signal: null };
    log(`child ${c.id}: exited (code ${c.exit.code}, signal ${c.exit.signal}${c.exit.error ? `, ${c.exit.error}` : ''})`);
    pumpAll(c);
    c.resolveDone();
    checkIdle();
  }

  function startChild(conn, f) {
    const id = f.id;
    const c = {
      id, label: f.label ?? null, policy: f.policy, command: path.basename(String(f.command)), proc: null, pid: null, seq: 0, entries: [], start: 0, bytes: 0, acked: 0,
      marks: new Map(), truncated: false, pending: new Map(), exit: null, exitInfo: null, exitTimer: null, stderr: '', reader: null, resolveDone: null,
    };
    c.done = new Promise(resolve => { c.resolveDone = resolve; });
    c.reader = createLineReader({
      maxBytes: maxLineBytes,
      onLine: text => append(c, text),
      onDrop: ({ bytes }) => {
        log(`child ${id}: dropped an oversize line (${bytes} bytes)`);
        eachSub(c, (target) => send(target, { t: 'overflow', id, reason: 'line', bytes }));
      },
    });
    children.set(id, c);
    conn.subs.set(id, { cursor: 1, detached: false, exitSent: false, scheduled: false, inbuf: '' });
    let proc;
    try {
      proc = spawnProcess(f.command, Array.isArray(f.args) ? f.args.map(String) : [], {
        cwd: f.cwd || undefined, env: f.env && typeof f.env === 'object' ? f.env : process.env,
        stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: false,
        detached: platform !== 'win32',     // POSIX は木ごと止めるためにグループを分ける。Windows は libuv の Job で、保持役が落ちれば子も止まる
      });
    } catch (error) {
      c.exitInfo = { code: null, signal: null, error: error?.code ?? String(error?.message ?? error) };
      finish(c);
      return;
    }
    c.proc = proc;
    c.pid = proc.pid ?? null;
    log(`child ${id}: started (${c.command}, pid ${c.pid ?? '-'}, policy ${c.policy})`);
    const decoder = new StringDecoder('utf8');
    proc.stdout.on('data', chunk => { c.reader.push(chunk); pumpAll(c); });
    proc.stderr.on('data', chunk => {
      const text = decoder.write(chunk);
      if (!text) return;
      c.stderr = (c.stderr + text).slice(-STDERR_TAIL_BYTES);
      eachSub(c, (target) => { if (target.socket.writableLength < highWaterBytes) send(target, { t: 'err', id, chunk: text }); });
    });
    proc.stdin.on('error', () => {});
    proc.stdout.on('error', () => {});
    proc.stderr.on('error', () => {});
    // exit は stdout を読み終える前に来ることがある。close（stdio が全部閉じた）か、孫が stdout を握っているときは猶予の後に締める
    proc.on('exit', (code, signal) => { c.exitInfo = { code, signal }; c.exitTimer = setTimeout(() => finish(c), exitGraceMs); c.exitTimer.unref?.(); });
    proc.on('close', () => finish(c));
    proc.on('error', error => {
      if (c.pid) return void log(`child ${id}: ${error?.message ?? error}`);   // 起こした後の失敗（kill の失敗など）
      c.exitInfo = { code: null, signal: null, error: error?.code ?? String(error?.message ?? error) };
      finish(c);
    });
    checkIdle();
  }

  function killChild(c, tree) {
    if (c.exit || !c.proc || !c.pid) return;
    log(`child ${c.id}: kill${tree ? ' (tree)' : ''}`);
    try {
      if (!tree) c.proc.kill();
      else if (platform === 'win32') {
        const killer = spawnProcess('taskkill', ['/PID', String(c.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        killer.on('error', () => { try { c.proc.kill(); } catch { /* 既に終わっている */ } });
      } else process.kill(-c.pid, 'SIGKILL');
    } catch { try { c.proc.kill('SIGKILL'); } catch { /* 既に終わっている */ } }
  }

  /** 親の write は行になった分だけ子へ渡す（行の途中で親が切れたら、その行は捨てる） */
  function forwardWrite(c, sub, data) {
    if (c.exit || typeof data !== 'string') return;
    sub.inbuf += data;
    const end = sub.inbuf.lastIndexOf('\n');
    if (end < 0) {
      if (sub.inbuf.length > maxLineBytes) { log(`child ${c.id}: dropped an oversize partial write`); sub.inbuf = ''; }
      return;
    }
    const complete = sub.inbuf.slice(0, end + 1);
    sub.inbuf = sub.inbuf.slice(end + 1);
    if (c.policy !== 'none') for (const line of complete.split('\n')) if (line) observeInput(c, line);
    if (c.proc.stdin.writable) c.proc.stdin.write(complete);
  }

  // ---- 親の接続
  function checkIdle() {
    clearTimeout(idleTimer);
    idleTimer = null;
    if (!server || !(idleMs > 0) || current || [...children.values()].some(c => !c.exit)) return;
    idleTimer = setTimeout(() => { log('idle: no running child and no parent'); onIdle(); }, idleMs);
    idleTimer.unref?.();
  }

  function onFrame(conn, f) {
    const op = f?.t;
    const c = typeof f?.id === 'string' ? children.get(f.id) : undefined;
    const sub = c ? subOf(conn, c.id) : undefined;
    const fail = reason => send(conn, { t: 'error', ...(typeof f.id === 'string' ? { id: f.id } : {}), ...(f.reqId !== undefined ? { reqId: f.reqId } : {}), op, reason });
    const needChild = () => (c ? true : (fail('unknown'), false));
    const live = () => needChild() && !sub?.detached;      // detach した後の親は、子に触る操作を無視する
    switch (op) {
      case 'spawn': {
        if (!isNonEmptyString(f.id) || !isNonEmptyString(f.command)) return void fail('invalid');
        if (children.has(f.id)) return void fail('exists');
        if (!POLICIES.includes(f.policy) || (f.framing ?? 'lines') !== 'lines') return void fail('invalid');
        if (f.label !== undefined && f.label !== null && jsonBytes(f.label) > LABEL_MAX_BYTES) return void fail('label-too-large');
        startChild(conn, f);
        break;
      }
      case 'attach': {
        if (!needChild()) break;
        const from = Number.isInteger(f.from) && f.from >= 1 ? f.from : c.acked + 1;
        const next = { cursor: from, detached: false, exitSent: false, scheduled: false, inbuf: '' };
        conn.subs.set(c.id, next);
        send(conn, { t: 'attached', ...snapshotOf(c), from });
        for (const p of redeliverable(c)) if (p.seq < from) send(conn, { t: 'out', id: c.id, seq: p.seq, line: p.line, redelivered: true });
        pump(conn, c);
        break;
      }
      case 'write': if (c && sub && !sub.detached) forwardWrite(c, sub, f.data); else if (!c) fail('unknown'); break;
      case 'end':
        if (c && sub && !sub.detached) { sub.inbuf = ''; if (!c.exit && c.proc.stdin.writable) c.proc.stdin.end(); } else if (!c) fail('unknown');
        break;
      case 'kill': if (c && sub && !sub.detached) killChild(c, Boolean(f.tree)); else if (!c) fail('unknown'); break;
      case 'ack':
        if (!live() || !Number.isInteger(f.seq)) break;
        c.acked = Math.max(c.acked, Math.min(f.seq, c.seq));
        trim(c);
        break;
      case 'mark':
        if (!live() || !isNonEmptyString(f.name)) break;
        c.marks.set(f.name, Number.isInteger(f.seq) && f.seq >= 1 ? f.seq : c.seq + 1);
        trim(c);
        break;
      case 'unmark': if (live()) { c.marks.delete(f.name); trim(c); } break;
      case 'label':
        if (!live()) break;
        if (jsonBytes(f.label) > LABEL_MAX_BYTES) return void fail('label-too-large');
        c.label = f.label ?? null;
        break;
      case 'release':
        if (!live()) break;
        if (!c.exit) return void fail('alive');
        children.delete(c.id);
        for (const other of conns) other.subs.delete(c.id);
        break;
      case 'replay': {
        if (!needChild()) break;
        const head = first(c);
        const from = Number.isInteger(f.from) ? Math.max(f.from, 1) : head;
        const to = Number.isInteger(f.to) ? Math.min(f.to, c.seq) : c.seq;
        let lines = [];
        let size = 0;
        for (let seq = Math.max(from, head); seq <= to; seq++) {
          const entry = entryAt(c, seq);
          if (!entry) break;
          lines.push([entry.seq, entry.line]);
          size += entry.bytes;
          if (size >= REPLAY_CHUNK_BYTES) { send(conn, { t: 'replay', id: c.id, reqId: f.reqId, lines, done: false }); lines = []; size = 0; }
        }
        send(conn, { t: 'replay', id: c.id, reqId: f.reqId, lines, done: true, first: head, last: c.seq, truncated: from < head });
        break;
      }
      case 'stash':
        if (jsonBytes(f.stash) > STASH_MAX_BYTES) return void fail('stash-too-large');
        stash = f.stash && typeof f.stash === 'object' ? f.stash : {};
        break;
      case 'detach': {
        const targets = typeof f.id === 'string' ? (c ? [c] : []) : [...children.values()];
        for (const target of targets) { const own = subOf(conn, target.id); if (own) { own.detached = true; own.inbuf = ''; } }
        send(conn, { t: 'detached', ...(typeof f.id === 'string' ? { id: f.id } : {}), children: targets.map(snapshotOf) });
        break;
      }
      case 'shutdown': log('shutdown requested'); onShutdown(); break;
      case 'bye': conn.socket.end(); break;
      default: break;    // 知らない t は読み捨てる
    }
  }

  function onConnection(socket) {
    const conn = { socket, subs: new Map(), authed: false };
    conns.add(conn);
    const timer = setTimeout(() => socket.destroy(), helloTimeoutMs);
    timer.unref?.();
    const reader = createLineReader({
      maxBytes: HELLO_MAX_BYTES,
      onDrop: ({ bytes }) => { log(`dropped an oversize frame (${bytes} bytes)`); if (!conn.authed) socket.destroy(); },
      onLine: text => {
        let frame;
        try { frame = decodeLine(text); } catch { if (!conn.authed) socket.destroy(); return; }
        if (!conn.authed) return void handshake(frame);
        try { onFrame(conn, frame); } catch (error) { log(`frame ${frame?.t} failed: ${error?.stack ?? error}`); }
      },
    });

    function handshake(hello) {
      // 秘密が合うまでは何も返さない（パイプの既定の権限は同じ利用者以外にも開いているかもしれない。design.md §4.2）
      if (hello?.t !== 'hello' || typeof hello.secret !== 'string' || !sameSecret(hello.secret, secret)) { log('rejected a connection: bad hello'); return void socket.destroy(); }
      const base = { range, generation, appVersion, pid: process.pid };
      if (hello.role !== 'server' || !validRange(hello.protocol) || hello.protocol[1] < range[0] || hello.protocol[0] > range[1]) {
        send(conn, { t: 'reject', reason: 'protocol', ...base });
        socket.end();
        return;
      }
      clearTimeout(timer);
      conn.authed = true;
      reader.maxBytes = maxFrameBytes;
      if (current) {          // 後から来た親が勝つ。古い親はこの後、子に何も書けない
        const old = current;
        send(old, { t: 'bye', reason: 'replaced' });
        old.subs.clear();
        old.socket.end();
        current = null;
      }
      current = conn;
      conn.peer = { pid: hello.pid, appVersion: typeof hello.appVersion === 'string' ? hello.appVersion : '' };
      send(conn, { t: 'welcome', protocol: Math.min(hello.protocol[1], range[1]), ...base, children: [...children.values()].map(snapshotOf), stash });
      log(`parent connected (pid ${conn.peer.pid}, version ${conn.peer.appVersion || '?'})`);
      checkIdle();
    }

    socket.on('data', chunk => reader.push(chunk));
    socket.on('drain', () => { for (const id of conn.subs.keys()) { const c = children.get(id); if (c) pump(conn, c); } });
    socket.on('error', () => {});
    socket.on('close', () => {
      clearTimeout(timer);
      reader.reset();
      conns.delete(conn);
      conn.subs.clear();      // 親の途中の行（inbuf）はここで捨てる。子の stdin は閉じない
      if (current === conn) { current = null; log('parent disconnected'); checkIdle(); }
    });
  }

  const info = () => ({ pipe, protocol: range, generation });
  const removeFile = () => {
    try {
      const written = file ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
      if (written?.pid === process.pid && written?.secret === secret) fs.rmSync(file, { force: true });
    } catch { /* 無い・読めないものは消さない */ }
  };

  return {
    pipe, secret, info, snapshot,
    /** パイプを作って待ち受け、名前と秘密のファイルを書く。既に保持役が居れば code 'HOLDER_RUNNING' で投げる（ファイルには触れない） */
    async listen() {
      if (server) return info();
      const running = () => Object.assign(new Error('a holder is already running'), { code: 'HOLDER_RUNNING' });
      const bind = () => {
        const candidate = net.createServer(onConnection);
        return new Promise((resolve, reject) => { candidate.once('error', reject); candidate.listen(pipe, () => { candidate.off('error', reject); resolve(candidate); }); });
      };
      let created;
      try { created = await bind(); } catch (error) {
        if (error?.code !== 'EADDRINUSE') throw error;
        // unix ソケットはファイルなので、残っていても持ち主が居るとは限らない。つながる持ち主が居れば使用中、居なければ（落ちて残った）古いファイルなので消して立て直す。
        // 先に消してから立てると、同時に起きた保持役が先に立てたソケットを消して 2 つとも待ち受けてしまう（bind を先にして、ファイルが残っていたときだけ消す）。
        // 残った古いファイルを同時に 2 つが拾う競合だけは残る（片方が probe の後・rm の前に立てたとき）
        if (platform === 'win32' || await probe(pipe)) throw running();
        await fs.promises.rm(pipe, { force: true });
        created = await bind().catch(retry => { throw retry?.code === 'EADDRINUSE' ? running() : retry; });
      }
      created.on('error', error => log(`pipe error: ${error?.message ?? error}`));
      server = created;
      if (platform !== 'win32') await fs.promises.chmod(pipe, 0o600).catch(() => {});
      if (file) {
        await fs.promises.mkdir(path.dirname(file), { recursive: true });
        await writeAtomic(file, `${JSON.stringify({ version: HOLDER_FILE_VERSION, pid: process.pid, pipe, protocol: range, generation, appVersion, secret, startedAt: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600 });
      }
      log(`listening (generation ${generation})`);
      checkIdle();
      return info();
    },
    /** つながりを閉じ、パイプを閉じ、ファイルを消す。killChildren（既定 true）なら、子を木ごと止めて終わるのを待つ（上限 3 秒） */
    async close({ killChildren = true } = {}) {
      clearTimeout(idleTimer);
      const closing = server;
      server = null;
      if (current) send(current, { t: 'bye', reason: 'closing' });
      const stuck = setTimeout(() => { for (const conn of conns) conn.socket.destroy(); }, 1000);
      for (const conn of conns) conn.socket.end();
      if (killChildren) {
        for (const c of children.values()) killChild(c, true);
        let timer;
        await Promise.race([Promise.all([...children.values()].map(c => c.done)), new Promise(resolve => { timer = setTimeout(resolve, 3000); })]);
        clearTimeout(timer);
      }
      if (closing) await new Promise(resolve => closing.close(() => resolve()));
      clearTimeout(stuck);
      removeFile();
    },
    /** 同期の後片付け（process.on('exit') から）。ファイルだけ消す */
    dispose: removeFile,
  };
}
