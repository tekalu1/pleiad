// 段階 2-0 の R15: Pleiad のサーバーが直の子として起こす外部の stdio MCP（core/context-bridge.mjs）を、引き継ぎでどう扱うか。CLI は使わない。
//   A. 起こし直す: StdioClientTransport で probe-mcp.mjs を起こし、connect（initialize）と tools/list が済むまでの時間（3 回）
//   B. 保持役の子にする: holder.mjs に probe-mcp.mjs を起こさせ、MCP の Client を保持役のパイプ越しにつなぐ。
//      counter を 2 回呼んだ後、最初のクライアントを捨て（サーバーの入れ替わりの代わり）、新しい Client で付け直す。
//      付け直しは (1) initialize からやり直す（Client.connect）、(2) initialize を送らずに tools/call だけ送る、の 2 通り
//      さらに、slow の最中に捨てて付け直したとき、旧いクライアントの id への応答が新しいクライアントに届くか
// 使い方: node scripts/zero-downtime/claude/s-r15-stdio-mcp.mjs
import path from 'node:path';
import fs from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { connectHolder, holderRequest, pipePath, sleep } from './common.mjs';
import { here, tempRoot } from './harness.mjs';

const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
const runDir = path.join(tempRoot, `r15-${stamp}-${process.pid}`);
fs.mkdirSync(runDir, { recursive: true });
const probeLog = path.join(runDir, 'probe-mcp.jsonl');
const probe = path.join(here, 'probe-mcp.mjs');
const out = {};

// A. 起こし直す時間
out.respawn = [];
for (let i = 0; i < 3; i++) {
  const t = Date.now();
  const transport = new StdioClientTransport({ command: process.execPath, args: [probe], env: { ...process.env, PROBE_LOG: probeLog }, stderr: 'pipe' });
  const client = new Client({ name: 'r15', version: '0' }, { capabilities: {} });
  await client.connect(transport);
  const tools = await client.listTools();
  out.respawn.push({ ms: Date.now() - t, tools: tools.tools.length });
  await client.close();
}

// B. 保持役の子にして付け直す
const pipe = pipePath(`zdu2-r15-${process.pid}-${stamp}`);
const holder = spawn(process.execPath, [path.join(here, 'holder.mjs'), pipe], { env: { ...process.env, HOLDER_LOG_DIR: runDir }, stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true });
await new Promise(r => holder.stdout.once('data', r));

/** 保持役のパイプを MCP の Transport に見せる。mode 'spawn' は子を起こす、'attach' は既存の子に付ける（from 以降を流し直す） */
async function holderTransport(mode, from = 1 << 30) {
  const hc = await connectHolder(pipe);
  const t = {
    hc,
    async start() {
      hc.on(m => { if (m.id !== 'mcp') return; if (m.t === 'out') { try { t.onmessage?.(JSON.parse(m.line)); } catch (e) { t.onerror?.(e); } } else if (m.t === 'exit') t.onclose?.(); });
      if (mode === 'spawn') hc.send({ t: 'spawn', id: 'mcp', command: process.execPath, args: [probe], cwd: runDir, env: { ...process.env, PROBE_LOG: probeLog } });
      else hc.send({ t: 'attach', id: 'mcp', from });
    },
    async send(msg) { hc.send({ t: 'write', id: 'mcp', data: JSON.stringify(msg) + '\n' }); },
    async close() { hc.close(); t.onclose?.(); },
  };
  return t;
}
const text = r => r?.content?.[0]?.text ?? JSON.stringify(r).slice(0, 200);

const t1 = await holderTransport('spawn');
const c1 = new Client({ name: 'server-old', version: '0' }, { capabilities: {} });
await c1.connect(t1);
out.first = [text(await c1.callTool({ name: 'counter', arguments: {} })), text(await c1.callTool({ name: 'counter', arguments: {} }))];
const seqAfterFirst = (await holderRequest(t1.hc, { t: 'info' }, 'info')).children.find(c => c.id === 'mcp').seq;
t1.hc.close();   // 旧サーバーが居なくなった（クライアントは close しない＝子の stdin を閉じない）

// (1) initialize からやり直す
const t2 = await holderTransport('attach', seqAfterFirst + 1);
const c2 = new Client({ name: 'server-new', version: '0' }, { capabilities: {} });
try {
  const t = Date.now();
  await c2.connect(t2);
  out.reinit = { ok: true, ms: Date.now() - t, counter: text(await c2.callTool({ name: 'counter', arguments: {} })) };
} catch (e) { out.reinit = { ok: false, error: String(e?.message ?? e) }; }
const seq2 = (await holderRequest(t2.hc, { t: 'info' }, 'info')).children.find(c => c.id === 'mcp').seq;
t2.hc.close();

// (2) initialize を送らずに tools/call だけ（生の JSON-RPC）
{
  const hc = await connectHolder(pipe);
  const got = new Promise(resolve => hc.on(m => { if (m.id === 'mcp' && m.t === 'out') { const j = JSON.parse(m.line); if (j.id === 'raw-1') resolve(j); } }));
  hc.send({ t: 'attach', id: 'mcp', from: seq2 + 1 });
  await sleep(100);
  hc.send({ t: 'write', id: 'mcp', data: JSON.stringify({ jsonrpc: '2.0', id: 'raw-1', method: 'tools/call', params: { name: 'counter', arguments: {} } }) + '\n' });
  const r = await Promise.race([got, sleep(5000).then(() => null)]);
  out.noInit = r ? text(r.result) : 'no response in 5 s';
  hc.close();
}

// (3) slow の最中に捨てる。旧いクライアントの id（数字）への応答は、付け直したクライアントにどう届くか
{
  const ta = await holderTransport('attach', 1 << 30);
  const ca = new Client({ name: 'server-old2', version: '0' }, { capabilities: {} });
  await ca.connect(ta);
  const pending = ca.callTool({ name: 'slow', arguments: { seconds: 3 } }).catch(e => `old client error: ${e?.message ?? e}`);
  await sleep(500);
  const seq3 = (await holderRequest(ta.hc, { t: 'info' }, 'info')).children.find(c => c.id === 'mcp').seq;
  ta.hc.close();
  const tb = await holderTransport('attach', seq3 + 1);
  const cb = new Client({ name: 'server-new2', version: '0' }, { capabilities: {} });
  const strays = [];
  const origOn = () => {};
  await cb.connect(tb);
  const prev = tb.onmessage;
  tb.onmessage = m => { if (m.id !== undefined && !('method' in m)) strays.push({ id: m.id, text: text(m.result) }); prev?.(m); };
  const counter = text(await cb.callTool({ name: 'counter', arguments: {} }));
  await sleep(3500);
  out.inflight = { newClientCounter: counter, responsesSeenByNewClient: strays, oldPromise: await Promise.race([pending, sleep(100).then(() => 'old client still waiting (its pipe is gone)')]) };
  void origOn;
  tb.hc.close();
}

out.probe = fs.readFileSync(probeLog, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)).map(e => `${e.ev}${e.count ? '#' + e.count : ''}${e.inits ? ' inits=' + e.inits : ''}${e.client ? ' client=' + e.client.name : ''} pid=${e.pid}`);
fs.writeFileSync(path.join(runDir, 'summary.json'), JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
const hc = await connectHolder(pipe);
hc.send({ t: 'shutdown' });
await sleep(500);
spawnSync('taskkill', ['/PID', String(holder.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
process.exit(0);
