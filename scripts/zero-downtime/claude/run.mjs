// 段階 0（Claude の付け直し）の項目 1〜3・5 を動かす。LLM は haiku で最小限。
// 使い方: node scripts/zero-downtime/claude/run.mjs <scenario> [key=value ...]
//   perm                 承認待ちの最中に付け直す（項目 1・5）。gap=承認待ちになってから親を殺すまで(ms) absent=親が居ない時間(ms) redeliver=0|1 from=push|zero
//   stream               応答の生成中に付け直す（項目 2）。killAfter=stream_event の数 gap=(ms)
//   tool                 ツール実行中に付け直す（項目 2）。gap=(ms)
//   host-idle            付け直した query で hooks と in-process MCP が効くか（項目 3、待機中に付け直す）
//   host-mcp-inflight    in-process MCP の呼び出しの最中に付け直す（項目 3）。redeliver=0|1
//   host-hook-inflight   hooks のコールバックの最中に付け直す（項目 3）。redeliver=0|1
// 記録は %TEMP%/zdu-claude-<scenario>-<時刻>/ に残る（コミットしない）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { connectHolder, holderRequest, pipePath, sleep } from './common.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const [scenario, ...kv] = process.argv.slice(2);
const opt = Object.fromEntries(kv.map(s => s.split('=')));
const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
const runDir = path.join(os.tmpdir(), `zdu-claude-${scenario}-${stamp}-${process.pid}`);
const workDir = path.join(runDir, 'work');
fs.mkdirSync(workDir, { recursive: true });
const log = (...a) => console.log(`[${((Date.now() - T0) / 1000).toFixed(1).padStart(6)}s]`, ...a);
const T0 = Date.now();
const taskkill = pid => { try { spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch { /* ignore */ } };

const pipe = pipePath(`zdu-holder-${process.pid}-${stamp}`);
const holder = spawn(process.execPath, [path.join(here, 'holder.mjs'), pipe], { env: { ...process.env, HOLDER_LOG_DIR: runDir }, stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true });
await new Promise(r => holder.stdout.once('data', r));
const hc = await connectHolder(pipe);
const parents = [];

function startParent(over) {
  const n = parents.length;
  const cfgFile = path.join(runDir, `parent-${n}.json`);
  const cfg = { pipe, id: 'c1', cwd: workDir, ...over };
  fs.writeFileSync(cfgFile, JSON.stringify(cfg));
  const proc = spawn(process.execPath, [path.join(here, 'parent.mjs'), cfgFile], { cwd: path.join(here, '..', '..', '..'), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const events = [];
  const out = fs.createWriteStream(path.join(runDir, `parent-${n}-${cfg.role}.jsonl`));
  let buf = '';
  const waiters = [];
  proc.stdout.setEncoding('utf8');
  proc.stdout.on('data', d => {
    buf += d; let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      out.write(line + '\n');
      let e; try { e = JSON.parse(line); } catch { continue; }
      events.push(e);
      for (const w of [...waiters]) if (w.pred(e)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(e); }
    }
  });
  proc.stderr.on('data', d => out.write(`STDERR ${d}`));
  const p = {
    proc, events, cfg, exited: false,
    waitFor(pred, ms = 90_000) {
      const hit = events.find(pred);
      if (hit) return Promise.resolve(hit);
      return new Promise(resolve => {
        const w = { pred, resolve };
        waiters.push(w);
        setTimeout(() => { const k = waiters.indexOf(w); if (k >= 0) { waiters.splice(k, 1); resolve(null); } }, ms);
      });
    },
    kill() { spawnSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); p.killedAt = Date.now(); },
    lastPushSeq: () => events.filter(e => e.ev === 'push').reduce((m, e) => Math.max(m, e.seq), 0),
    lastMsgSeq: () => events.filter(e => e.ev === 'msg' && e.seq).reduce((m, e) => Math.max(m, e.seq), 0),
  };
  proc.on('exit', () => { p.exited = true; });
  parents.push(p);
  return p;
}

const summarize = p => {
  const ev = p.events;
  const by = name => ev.filter(e => e.ev === name);
  return {
    role: p.cfg.role,
    canUseTool: by('canUseTool').map(e => ({ ms: e.ms, tool: e.toolName, requestId: e.requestId })),
    canUseToolAllowed: by('canUseTool.allow').length,
    pushed: by('push').length,
    redeliveredPushes: by('push').filter(e => e.redelivered).map(e => ({ seq: e.seq, rid: e.rid, type: e.type })),
    attached: by('attached')[0] ?? null,
    hookPre: by('hook.pre.start').map(e => e.ms), hookPost: by('hook.post').map(e => e.ms),
    mcp: by('mcp.ping.start').map(e => e.ms),
    toolResults: ev.filter(e => e.ev === 'msg' && e.type === 'user').flatMap(e => e.blocks ?? []).filter(b => 'tool_result' in b),
    toolUses: ev.filter(e => e.ev === 'msg' && e.type === 'assistant').flatMap(e => e.blocks ?? []).filter(b => 'tool_use' in b),
    result: by('msg').filter(e => e.type === 'result').map(e => ({ ms: e.ms, is_error: e.is_error, result: e.result, cost: e.cost })),
    errors: by('error').concat(by('unhandledRejection')).map(e => e.error),
    done: by('done').length > 0,
  };
};

async function finish(extra = {}) {
  const dump = await holderRequest(hc, { t: 'dump', id: 'c1' }, 'dump').catch(() => null);
  const summary = { scenario, opt, parents: parents.map(summarize), holder: dump && { lines: dump.lines.length, alive: dump.alive, exit: dump.exit }, ...extra };
  fs.writeFileSync(path.join(runDir, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
  for (const p of parents) if (!p.exited) p.kill();
  hc.send({ t: 'shutdown' });
  await sleep(500);
  taskkill(holder.pid);
  log('run dir:', runDir);
  process.exit(0);
}

const PROMPT = {
  perm: 'Use the Bash tool to run exactly this command: touch PERM_MARK.txt && echo REINIT_OK. Then reply with the single word DONE.',
  stream: 'Do not use any tools. Write the integers from 1 to 300, one per line, nothing else.',
  tool: 'Use the Bash tool to run exactly this command: sleep 12 && echo TOOL_DONE_MARK. Then reply with the single word DONE.',
  ping: 'Call the tool mcp__host__ping once. Then use the Bash tool to run exactly: echo HOOK_PROBE. Then reply with the single word DONE.',
  pingOnly: 'Call the tool mcp__host__ping once, then reply with the single word DONE.',
  bashOnly: 'Use the Bash tool to run exactly: echo HOOK_PROBE. Then reply with the single word DONE.',
};

log('scenario', scenario, JSON.stringify(opt), 'run dir', runDir);
const gap = Number(opt.gap ?? 1000);
const wait = 120_000;

if (scenario === 'perm') {
  const clean = Number(opt.clean ?? 0);   // 1: 旧サーバーが手を離してから query を閉じて終わる 2: 手を離さずに閉じる（対照）
  const p1 = startParent({ role: 'first', prompt: PROMPT.perm, hangPermission: true, ...(clean ? { cleanDetach: clean } : {}) });
  const hit = await p1.waitFor(e => e.ev === 'canUseTool', wait);
  log('p1 canUseTool', JSON.stringify(hit));
  if (!hit) await finish({ error: 'no canUseTool in p1' });
  if (clean) { await p1.waitFor(e => e.ev === 'closed', 20_000); await sleep(1500); log('p1 closed itself; events after close:', JSON.stringify(p1.events.filter(e => ['closing', 'close.error', 'closed'].includes(e.ev)))); }
  else await sleep(gap);
  p1.kill();
  const from = opt.from === 'zero' ? 1 : p1.lastPushSeq() + 1;
  log('p1 killed, attaching from', from, 'redeliver', opt.redeliver ?? 0, 'after absent', opt.absent ?? 300, 'ms');
  await sleep(Number(opt.absent ?? 300));
  const p2 = startParent({ role: 'second', from, redeliver: opt.redeliver === '1', allowDelayMs: 300, exitAfterResult: true });
  const r = await p2.waitFor(e => e.ev === 'msg' && e.type === 'result', clean ? 25_000 : wait);
  log('p2 result', JSON.stringify(r));
  await sleep(1500);
  await finish({ from, resultSeen: Boolean(r) });
}

if (scenario === 'stream') {
  const killAfter = Number(opt.killAfter ?? 30);
  const p1 = startParent({ role: 'first', prompt: PROMPT.stream, bypass: true });
  let n = 0;
  const hit = await p1.waitFor(e => { if (e.ev === 'msg' && e.type === 'stream_event') n++; return n >= killAfter; }, wait);
  if (!hit) log('turn ended before killAfter');
  await sleep(gap);
  p1.kill();
  await sleep(200);
  const pushMark = p1.lastPushSeq();
  const msgMark = p1.lastMsgSeq();
  log('p1 killed. lastPushSeq', pushMark, 'lastMsgSeq(app-processed)', msgMark);
  const from = msgMark + 1;
  const p2 = startParent({ role: 'second', from, exitAfterResult: true });
  const r = await p2.waitFor(e => e.ev === 'msg' && e.type === 'result', wait);
  log('p2 result', JSON.stringify(r));
  await sleep(1500);
  const dump = await holderRequest(hc, { t: 'dump', id: 'c1' }, 'dump');
  const uuidLines = dump.lines.filter(l => l.uuid && l.type !== 'system/session_state_changed');
  const seqs = p => new Set(p.events.filter(e => e.ev === 'msg' && e.seq).map(e => e.seq));
  const s1 = seqs(p1), s2 = seqs(p2);
  const missing = uuidLines.filter(l => !s1.has(l.seq) && !s2.has(l.seq)).map(l => l.seq);
  const dup = [...s1].filter(s => s2.has(s));
  const pushedNotYielded = p1.events.filter(e => e.ev === 'push' && e.uuid && e.type !== 'system/session_state_changed' && !s1.has(e.seq)).map(e => e.seq);
  const noUuid = dump.lines.filter(l => !l.uuid).reduce((m, l) => { m[l.type] = (m[l.type] ?? 0) + 1; return m; }, {});
  await finish({ analysis: { holderLines: dump.lines.length, uuidLines: uuidLines.length, pushMark, msgMark, from, p1Yielded: s1.size, p2Yielded: s2.size, missing, dup, pushedNotYieldedInP1: pushedNotYielded, linesWithoutUuid: noUuid } });
}

if (scenario === 'tool') {
  const p1 = startParent({ role: 'first', prompt: PROMPT.tool, bypass: true });
  const hit = await p1.waitFor(e => e.ev === 'msg' && e.type === 'assistant' && (e.blocks ?? []).some(b => 'tool_use' in b), wait);
  log('p1 tool_use seen', JSON.stringify(hit?.blocks));
  await sleep(1500);
  p1.kill();
  await sleep(200);
  const from = p1.lastMsgSeq() + 1;
  log('p1 killed at', Date.now() - T0, 'ms; waiting', gap, 'ms before attaching from', from);
  await sleep(gap);
  const p2 = startParent({ role: 'second', from, exitAfterResult: true, ...(opt.interrupt ? { interruptAfterMs: 1500 } : {}) });
  const r = await p2.waitFor(e => e.ev === 'msg' && e.type === 'result', wait);
  log('p2 result', JSON.stringify(r), 'interrupt events', JSON.stringify(p2.events.filter(e => e.ev.startsWith('interrupt'))));
  await sleep(1500);
  const dump = await holderRequest(hc, { t: 'dump', id: 'c1' }, 'dump');
  const uuidLines = dump.lines.filter(l => l.uuid && l.type !== 'system/session_state_changed');
  const seqs = p => new Set(p.events.filter(e => e.ev === 'msg' && e.seq).map(e => e.seq));
  const s1 = seqs(p1), s2 = seqs(p2);
  await finish({ analysis: { from, missing: uuidLines.filter(l => !s1.has(l.seq) && !s2.has(l.seq)).map(l => l.seq), dup: [...s1].filter(s => s2.has(s)) } });
}

if (scenario === 'host-idle') {
  const p1 = startParent({ role: 'first', prompt: PROMPT.ping, bypass: true, hooks: true, sdkMcp: true });
  const r1 = await p1.waitFor(e => e.ev === 'msg' && e.type === 'result', wait);
  log('p1 result (baseline)', JSON.stringify(r1));
  await sleep(500);
  p1.kill();
  await sleep(200);
  const from = p1.lastPushSeq() + 1;
  const p2 = startParent({ role: 'second', from, prompt: PROMPT.ping, promptDelayMs: 1500, bypass: true, hooks: true, sdkMcp: true, exitAfterResult: true });
  const r2 = await p2.waitFor(e => e.ev === 'msg' && e.type === 'result', wait);
  log('p2 result', JSON.stringify(r2));
  await sleep(1500);
  await finish({ from });
}

if (scenario === 'host-mcp-inflight') {
  const p1 = startParent({ role: 'first', prompt: PROMPT.pingOnly, bypass: true, hooks: true, sdkMcp: true, mcpDelayMs: 25_000 });
  const hit = await p1.waitFor(e => e.ev === 'mcp.ping.start', wait);
  log('p1 mcp handler started', JSON.stringify(hit));
  if (!hit) await finish({ error: 'no ping' });
  await sleep(gap);
  p1.kill();
  await sleep(200);
  const from = p1.lastPushSeq() + 1;
  const p2 = startParent({ role: 'second', from, redeliver: opt.redeliver === '1', bypass: true, hooks: true, sdkMcp: true, mcpDelayMs: 500, exitAfterResult: true });
  const r = await p2.waitFor(e => e.ev === 'msg' && e.type === 'result', Number(opt.waitMs ?? wait));
  log('p2 result', JSON.stringify(r));
  await sleep(1500);
  await finish({ from });
}

if (scenario === 'host-hook-inflight') {
  const p1 = startParent({ role: 'first', prompt: PROMPT.bashOnly, bypass: true, hooks: true, sdkMcp: true, hookPreDelayMs: 25_000 });
  const hit = await p1.waitFor(e => e.ev === 'hook.pre.start', wait);
  log('p1 hook started', JSON.stringify(hit));
  if (!hit) await finish({ error: 'no hook' });
  await sleep(gap);
  p1.kill();
  await sleep(200);
  const from = p1.lastPushSeq() + 1;
  const p2 = startParent({ role: 'second', from, redeliver: opt.redeliver === '1', bypass: true, hooks: true, sdkMcp: true, hookPreDelayMs: 500, exitAfterResult: true });
  const r = await p2.waitFor(e => e.ev === 'msg' && e.type === 'result', Number(opt.waitMs ?? wait));
  log('p2 result', JSON.stringify(r));
  await sleep(1500);
  await finish({ from });
}

log('unknown scenario');
process.exit(1);
