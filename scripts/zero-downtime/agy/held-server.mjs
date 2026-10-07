// 無停止の更新 段階 3（agy）の実機の確かめ: 本物の agy を Pleiad のサーバーから保持役に載せ（AGENT_HOST_RUNTIME_ROOT を渡すと既定で載る）、ツールの実行中のターンを
// サーバー A → B で付け直す（2d の形: handOffTurn → 札を子に置いて detach。tests/lib/adopt-server.mjs の場面 handOffAgy）。
// B が印からの再生と続きで締め、turnEnd・completedAt・使用量が 1 回だけ残り、本文とツールの結果が履歴に 1 回ずつあることを見る。
// LLM は gemini-3.8-flash-low で 2 ターン（1 つ目は会話を作るだけ。2 つ目が数秒かかる ping のシェル）。agy の会話は ~/.gemini/antigravity-cli に残る。
//
//   node scripts/zero-downtime/agy/held-server.mjs [--model <id>] [--keep]
//
// 置き場は worktree の temporary/zdu-agy-server/（データ置き場・実行場所・作業場所）。保持役は終わりに shutdown する
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const { startServer } = await import('../../../tests/lib/server.mjs');
const { open, sleep } = await import('../../../tests/lib/ws-client.mjs');
const { readSessions, readUsage } = await import('../../../tests/lib/data-store.mjs');
const { ensureHolder, connectHolder } = await import('../../../core/holder/client.mjs');

const flag = (name, fallback) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : fallback);
const model = flag('--model', 'gemini-3.8-flash-low');
const keep = process.argv.includes('--keep');
const scratch = path.join(repo, 'temporary', 'zdu-agy-server');
await fs.rm(scratch, { recursive: true, force: true });
const dataDir = path.join(scratch, 'data'), root = path.join(scratch, 'runtime'), scenesDir = path.join(scratch, 'scenes'), work = path.join(scratch, 'work');
await Promise.all([dataDir, root, scenesDir, work].map(dir => fs.mkdir(dir, { recursive: true })));
const t0 = Date.now();
const log = (...args) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...args);
const until = async (check, ms, label) => {
  const end = Date.now() + ms;
  for (;;) { const v = await check(); if (v) return v; if (Date.now() > end) throw new Error(`timeout: ${label}`); await sleep(50); }
};

const env = { AGENT_HOST_BACKENDS: 'antigravity', AGENT_HOST_RUNTIME_ROOT: root, ADOPT_SCENES_DIR: scenesDir };
let a = null, b = null, ca = null, cb = null, holderPid = null, sessionId = null;
const result = { ok: false };
try {
  const found = await ensureHolder({ dataDir, root, mode: 'detached', idleMs: 60_000, timeoutMs: 20_000 });
  holderPid = found.pid;
  found.client.close();
  log('holder', holderPid, 'model', model);

  a = await startServer({ env, dataDir, timeoutMs: 60_000, entry: path.join(repo, 'tests', 'lib', 'adopt-server.mjs') });
  const scene = async (name, input) => {
    const done = path.join(scenesDir, `${name}.done`);
    await fs.writeFile(path.join(scenesDir, `${name}.tmp`), JSON.stringify(input));
    await fs.rename(path.join(scenesDir, `${name}.tmp`), path.join(scenesDir, `${name}.go`));
    const out = JSON.parse(await until(() => fs.readFile(done, 'utf8').catch(() => null), 20_000, name));
    await fs.rm(done);
    if (!out.ok) throw new Error(out.error);
    return out.value;
  };
  ca = await open({ port: a.port, token: a.token });
  const first = await ca.runTurn({ backend: 'antigravity', cwd: work, model, prompt: 'Reply with exactly one word: ready' }, { ms: 180_000 });
  sessionId = first.sessionId;
  log('A: conversation', sessionId, first.outcome);
  const markA = ca.mark();
  void ca.cmd('sendMessage', { sessionId, messageId: 'zdu-agy-real-0001', model, prompt: 'Run this exact shell command with your shell tool (it takes about 6 seconds): ping -n 7 127.0.0.1 . After it finishes, reply with exactly one word: finished' }).catch(() => {});
  const toolA = await ca.waitFor(e => e.type === 'tool.start' && e.sessionId === sessionId, { ms: 180_000, from: markA });
  log('A: tool started', toolA.name);
  const taken = await scene('handOffAgy', { sessionId });
  const agyCard = taken.card.backendCard?.agy;
  log('A: handed off', JSON.stringify({ held: taken.card.backendCard?.held, resumed: agyCard?.resumed, keys: Object.keys(agyCard?.keys ?? {}) }));
  await sleep(200);
  const aEnds = ca.since(markA).filter(e => e.sessionId === sessionId && ['turnEnd', 'turnResult'].includes(e.type)).length;
  ca.close(); ca = null;
  await a.stop(); a = null;
  let childAfterA = null;
  {
    const probe = await connectHolder({ dataDir, root });
    const child = probe.welcome.children.find(c => c.label?.sessionId === sessionId);
    childAfterA = child && { alive: child.alive, seq: child.seq, acked: child.acked, mark: child.marks?.turn };
    log('holder child after A stopped', JSON.stringify(childAfterA));
    probe.close();
  }

  const tB = Date.now();
  b = await startServer({ env: { ...env, AGENT_HOST_ADOPT_HOLDER: '1' }, dataDir, timeoutMs: 60_000 });
  cb = await open({ port: b.port, token: b.token });
  const end = await cb.waitFor(e => e.type === 'turnEnd' && e.sessionId === sessionId, { ms: 180_000 });
  log('B: turnEnd', end.outcome, `${Date.now() - tB} ms after starting B`);
  await sleep(500);
  const meta = readSessions(dataDir)[sessionId];
  const usage = (readUsage(dataDir)?.records ?? []).filter(r => r.id === taken.card.presentKey);
  const loaded = await cb.cmd('loadSession', { sessionId });
  const assistant = loaded.messages.filter(m => m.role === 'assistant');
  const tools = loaded.messages.flatMap(m => m.toolCalls ?? []).map(c => `${c.name}: ${String(c.result?.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 60)}`);
  Object.assign(result, {
    aEnds, outcome: end.outcome, turnEnds: cb.events.filter(e => e.type === 'turnEnd' && e.sessionId === sessionId).length,
    interrupted: meta?.interrupted ?? null, completedAt: Boolean(meta?.completedAt), turnStartedAt: meta?.turnStartedAt ?? null,
    usage: usage.map(r => ({ inputTokens: r.inputTokens, outputTokens: r.outputTokens })), lastText: String(assistant.at(-1)?.text ?? '').slice(0, 80), tools,
    userMessages: loaded.messages.filter(m => m.role === 'user').map(m => String(m.text).slice(0, 40)),
    childAfterA, adoptedLog: b.tail(200).split('\n').filter(l => l.includes('付け直し')).map(l => l.trim()),
  });
  result.ok = aEnds === 0 && end.outcome === 'ok' && result.turnEnds === 1 && !result.interrupted && result.completedAt && usage.length === 1
    && tools.length >= 1 && /finished/i.test(result.lastText);
} catch (error) {
  result.error = String(error?.stack ?? error);
  result.tailA = a?.tail(30); result.tailB = b?.tail(30);
} finally {
  ca?.close(); cb?.close();
  await a?.stop(); await b?.stop();
  if (holderPid) {
    const probe = await connectHolder({ dataDir, root }).catch(() => null);
    probe?.shutdown(); probe?.close();
  }
  await sleep(1500);
  log('CONVERSATION_ID(for cleanup):', sessionId);
  if (!keep) await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.ok ? 0 : 1;
}
