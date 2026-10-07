// 無停止の更新 段階 2 の 2c の実機の確かめ: 本物の Claude Code CLI を Pleiad のサーバーから保持役に載せ（置き場 AGENT_HOST_RUNTIME_ROOT を渡す。載せるのは既定）、
// 承認待ちのターンをサーバー A → B で付け直す（2d の形: handOffTurn → 札を子に置いて detach → query を閉じる。tests/lib/adopt-server.mjs）。
// B に A と同じ id の承認が 1 つだけ出て、答えるとターンが続き、turnEnd・completedAt・使用量が 1 回だけ残ることを見る。LLM は haiku で 1 ターン（数セント）。
//
//   node scripts/zero-downtime/claude/held-server.mjs [--keep]
//
// 置き場は worktree の temporary/zdu-2c-real/（データ置き場・実行場所・作業場所）。作業場所の .claude/settings.local.json で、利用者の hooks を止め
// （disableAllHooks）、モデルを haiku にする。~/.claude の設定は書き換えない。終わったら試験の会話の記録（~/.claude/projects と
// %LOCALAPPDATA%\Temp\claude の、作業場所の名前の分）を消す（--keep で残す）。保持役は終わりに shutdown する
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const { startServer } = await import('../../../tests/lib/server.mjs');
const { open, sleep } = await import('../../../tests/lib/ws-client.mjs');
const { readSessions, readUsage } = await import('../../../tests/lib/data-store.mjs');
const { ensureHolder, connectHolder } = await import('../../../core/holder/client.mjs');

const keep = process.argv.includes('--keep');
const scratch = path.join(repo, 'temporary', 'zdu-2c-real');
await fs.rm(scratch, { recursive: true, force: true });
const dataDir = path.join(scratch, 'data'), root = path.join(scratch, 'runtime'), scenesDir = path.join(scratch, 'scenes'), work = path.join(scratch, 'work');
await Promise.all([dataDir, root, scenesDir, path.join(work, '.claude')].map(dir => fs.mkdir(dir, { recursive: true })));
await fs.writeFile(path.join(work, '.claude', 'settings.local.json'), JSON.stringify({ disableAllHooks: true, model: 'haiku' }, null, 2));
const projectName = work.replace(/[^A-Za-z0-9]/g, '-');
const t0 = Date.now();
const log = (...args) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...args);
const until = async (check, ms, label) => {
  const end = Date.now() + ms;
  for (;;) { const v = await check(); if (v) return v; if (Date.now() > end) throw new Error(`timeout: ${label}`); await sleep(50); }
};

const env = { AGENT_HOST_BACKENDS: 'claude', AGENT_HOST_RUNTIME_ROOT: root, ADOPT_SCENES_DIR: scenesDir };
let a = null, b = null, ca = null, cb = null, holderPid = null, nativeId = null;
const result = { ok: false };
try {
  const found = await ensureHolder({ dataDir, root, mode: 'detached', idleMs: 60_000, timeoutMs: 20_000 });
  holderPid = found.pid;
  found.client.close();
  log('holder', holderPid);

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
  const { sessionId } = await ca.cmd('newSession', { backend: 'claude', cwd: work });
  log('session', sessionId);
  const markA = ca.mark();
  void ca.cmd('sendMessage', { sessionId, messageId: 'zdu-2c-real-0001', prompt: 'Use the Bash tool to run exactly this command: mkdir zdu-2c-held-dir. After it runs, reply with exactly the word: finished' }).catch(() => {});
  const askA = await ca.waitFor(e => e.type === 'permission' && e.sessionId === sessionId, { ms: 120_000, from: markA });
  log('A: approval', askA.id, askA.toolName);
  await sleep(800);   // 札の置き直し（touchCard）が保持役へ届くまで
  const taken = await scene('handOffClaude', { sessionId });
  nativeId = readSessions(dataDir)[sessionId]?.nativeId ?? sessionId;
  log('A: handed off', JSON.stringify({ waits: taken.card.waits, held: taken.card.backendCard?.held, flag: taken.card.backendCard?.flag ?? null }));
  await sleep(300);
  const aEnds = ca.since(markA).filter(e => e.sessionId === sessionId && ['turnEnd', 'turnResult'].includes(e.type)).length;
  ca.close(); ca = null;
  await a.stop(); a = null;
  {
    const probe = await connectHolder({ dataDir, root });
    const child = probe.welcome.children.find(c => c.label?.sessionId === sessionId);
    log('holder child', JSON.stringify({ alive: child?.alive, seq: child?.seq, acked: child?.acked, pending: child?.pendingRequests?.map(p => p.subtype) }));
    probe.close();
  }

  const tB = Date.now();
  b = await startServer({ env: { ...env, AGENT_HOST_ADOPT_HOLDER: '1' }, dataDir, timeoutMs: 60_000 });
  cb = await open({ port: b.port, token: b.token });
  const askB = await cb.waitFor(e => e.type === 'permission' && e.sessionId === sessionId, { ms: 60_000 });
  log('B: approval', askB.id, `${Date.now() - tB} ms after starting B`);
  await sleep(1000);
  const permissionsB = cb.events.filter(e => e.type === 'permission' && e.sessionId === sessionId).length;
  await cb.cmd('resolvePermission', { id: askB.id, allow: true });
  const end = await cb.waitFor(e => e.type === 'turnEnd' && e.sessionId === sessionId, { ms: 180_000 });
  await sleep(500);
  const meta = readSessions(dataDir)[sessionId];
  const usage = (readUsage(dataDir)?.records ?? []).filter(r => r.id === taken.card.presentKey);
  const loaded = await cb.cmd('loadSession', { sessionId });
  const last = loaded.messages.filter(m => m.role === 'assistant').at(-1)?.text ?? '';
  const tools = loaded.messages.flatMap(m => m.toolCalls ?? []).map(c => `${c.name}: ${String(c.result?.text ?? '').trim().slice(0, 60)}`);
  Object.assign(result, {
    sameApprovalId: askB.id === askA.id, permissionsOnB: permissionsB, aEnds,
    outcome: end.outcome, turnEnds: cb.events.filter(e => e.type === 'turnEnd' && e.sessionId === sessionId).length,
    interrupted: meta?.interrupted ?? null, completedAt: Boolean(meta?.completedAt), turnStartedAt: meta?.turnStartedAt ?? null,
    usage: usage.map(r => ({ costUsd: r.costUsd, inputTokens: r.inputTokens, outputTokens: r.outputTokens })), lastText: last.slice(0, 80), tools,
    adoptedLog: b.tail(200).split('\n').filter(l => l.includes('付け直し')).map(l => l.trim()),
  });
  result.ok = result.sameApprovalId && permissionsB === 1 && aEnds === 0 && end.outcome === 'ok' && result.turnEnds === 1 && !result.interrupted && result.completedAt && usage.length === 1;
} catch (error) {
  result.error = String(error?.stack ?? error);
  result.tailA = a?.tail(30); result.tailB = b?.tail(30);
  result.eventsA = ca?.events.filter(e => e.sessionId).map(e => e.type + (e.outcome ? `:${e.outcome}` : '') + (e.error ? `:${String(e.error).slice(0, 120)}` : '')).slice(-40);
} finally {
  ca?.close(); cb?.close();
  await a?.stop(); await b?.stop();
  if (holderPid) {
    const probe = await connectHolder({ dataDir, root }).catch(() => null);
    probe?.shutdown(); probe?.close();
  }
  await sleep(1500);
  // 利用者の hooks が走っていないこと（knowledge-capture の Stop フックは ~/.claude/hooks/state に会話ごとの印を残す）
  const state = path.join(os.homedir(), '.claude', 'hooks', 'state');
  result.userHookTraces = nativeId ? (await fs.readdir(state).catch(() => [])).filter(name => name.includes(nativeId)) : [];
  if (!keep) {
    const removed = [];
    for (const dir of [path.join(os.homedir(), '.claude', 'projects', projectName), path.join(process.env.LOCALAPPDATA ?? os.tmpdir(), 'Temp', 'claude', projectName)]) {
      if (await fs.stat(dir).catch(() => null)) { await fs.rm(dir, { recursive: true, force: true }); removed.push(dir); }
    }
    result.removedRecords = removed;
    await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.ok ? 0 : 1;
}
