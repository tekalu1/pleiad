// 無停止の更新・段階 0（Claude）用の「ターンの保持役」の最小の模型。設計（design.md §4）の一部だけを持つ。
//   - CLI の起動・stdin への書き込み・stdout の行への通番・終了の記録
//   - 親（SDK を持つプロセス）が居ないあいだも CLI の stdin を閉じず、stdout を読み続けて溜める
//   - CLI からの control_request のうち、親がまだ答えていないものの控え（再配送は attach の redeliver で選べる）
// 親との口は名前付きパイプ。1 行 1 JSON。使い方: node holder.mjs <パイプ名>
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const pipeName = process.argv[2];
const logDir = process.env.HOLDER_LOG_DIR ?? process.cwd();
const children = new Map();   // id → 子の状態
let subscriber = null;        // いま付いている親（1 つだけ）

const send = (sock, obj) => { if (sock && !sock.destroyed) sock.write(JSON.stringify(obj) + '\n'); };
const toSub = obj => send(subscriber, obj);

function onChildLine(c, line) {
  const seq = ++c.seq;
  let type = '?', uuid = null, reqId = null;
  try {
    const m = JSON.parse(line);
    type = m.type + (m.subtype ? `/${m.subtype}` : '');
    uuid = m.uuid ?? null;
    if (m.type === 'control_request') { reqId = m.request_id; c.pending.set(reqId, { seq, line, sub: m.request?.subtype }); }
    else if (m.type === 'control_cancel_request') c.pending.delete(m.request_id);
  } catch { /* 行ではない出力は記録だけ */ }
  c.lines.push({ seq, line, type, uuid });
  toSub({ t: 'out', id: c.id, seq, line });
}

function onParentWrite(c, text) {
  c.inBuf += text;
  let i;
  while ((i = c.inBuf.indexOf('\n')) >= 0) {
    const line = c.inBuf.slice(0, i); c.inBuf = c.inBuf.slice(i + 1);
    try {
      const m = JSON.parse(line);
      if (m.type === 'control_response' && m.response?.request_id) c.pending.delete(m.response.request_id);
    } catch { /* ignore */ }
  }
  c.proc.stdin.write(text);
}

function doSpawn(msg) {
  const proc = spawn(msg.command, msg.args, { cwd: msg.cwd, env: msg.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: false });
  const c = { id: msg.id, proc, pid: proc.pid, seq: 0, lines: [], pending: new Map(), exit: null, outBuf: '', inBuf: '', stderr: '' };
  children.set(msg.id, c);
  proc.stdout.setEncoding('utf8');
  proc.stdout.on('data', d => {
    c.outBuf += d;
    let i;
    while ((i = c.outBuf.indexOf('\n')) >= 0) {
      const line = c.outBuf.slice(0, i); c.outBuf = c.outBuf.slice(i + 1);
      if (line.trim()) onChildLine(c, line);
    }
  });
  proc.stderr.on('data', d => { c.stderr += d.toString(); fs.appendFileSync(path.join(logDir, `child-${c.id}.stderr`), d); });
  proc.on('exit', (code, signal) => { c.exit = { code, signal, at: Date.now() }; toSub({ t: 'exit', id: c.id, code, signal }); });
  proc.on('error', e => { c.exit = { error: String(e) }; toSub({ t: 'exit', id: c.id, error: String(e) }); });
  proc.stdin.on('error', () => {});
}

function onMessage(sock, msg) {
  const c = children.get(msg.id);
  switch (msg.t) {
    case 'spawn': doSpawn(msg); subscriber = sock; send(sock, { t: 'spawned', id: msg.id, pid: children.get(msg.id).pid }); break;
    case 'attach': {
      if (!c) return send(sock, { t: 'attached', id: msg.id, error: 'no such child' });
      if (subscriber && subscriber !== sock) subscriber.destroy();
      subscriber = sock;
      send(sock, { t: 'attached', id: msg.id, seq: c.seq, exit: c.exit, pid: c.pid, pending: [...c.pending].map(([rid, p]) => ({ rid, seq: p.seq, sub: p.sub })) });
      // 親が見ていた位置（from）より前の、答えていない依頼は控えから先に渡す
      if (msg.redeliver) for (const p of c.pending.values()) if (p.seq < msg.from) send(sock, { t: 'out', id: c.id, seq: p.seq, line: p.line, redelivered: true });
      for (const l of c.lines) if (l.seq >= msg.from) send(sock, { t: 'out', id: c.id, seq: l.seq, line: l.line, replay: true });
      if (c.exit) send(sock, { t: 'exit', id: c.id, ...c.exit });
      break;
    }
    case 'write': if (c && !c.exit) onParentWrite(c, msg.data); break;
    case 'end': if (c && !c.exit) c.proc.stdin.end(); break;
    case 'kill': if (c && !c.exit) { try { process.platform === 'win32' ? spawn('taskkill', ['/PID', String(c.pid), '/T', '/F'], { windowsHide: true }) : c.proc.kill('SIGKILL'); } catch { /* ignore */ } } break;
    case 'dump': send(sock, { t: 'dump', id: msg.id, reqId: msg.reqId, lines: (c?.lines ?? []).map(({ seq, type, uuid, line }) => ({ seq, type, uuid, bytes: line.length })), exit: c?.exit ?? null, alive: Boolean(c && !c.exit) }); break;
    case 'info': send(sock, { t: 'info', reqId: msg.reqId, children: [...children.values()].map(x => ({ id: x.id, pid: x.pid, seq: x.seq, exit: x.exit, pending: x.pending.size })) }); break;
    case 'shutdown': for (const x of children.values()) { try { x.proc.kill(); } catch { /* ignore */ } } setTimeout(() => process.exit(0), 200); break;
    default: break;
  }
}

const server = net.createServer(sock => {
  let buf = '';
  sock.setEncoding('utf8');
  sock.on('data', d => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!line) continue;
      try { onMessage(sock, JSON.parse(line)); } catch (e) { console.error('holder: bad message', e); }
    }
  });
  sock.on('close', () => { if (subscriber === sock) subscriber = null; });
  sock.on('error', () => {});
});
server.listen(pipeName, () => console.log('holder listening'));
