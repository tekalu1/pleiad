// 2d のデスクトップのハーネスの指揮役（node。docs/dev-verification.md「デスクトップ版（Electron）」）。使い方: npm run desktop:pack の後、
//   node scripts/zero-downtime/stage2d/prepare-resources.mjs && node scripts/zero-downtime/stage2d/conductor.mjs
// （H_SEED=<会話の数> で大きい置き場・H_ONLY_B=1 で C を省く）。electron を 3 回起こす（A → B → C）:
//   1. A の main: S1（A の版）を起こし、fake の held: のターン（ツールの実行中 T・承認待ち Q）を走らせ、更新の代わりに main-leaving → leave → app.exit(0)
//   2. B の main（ビルドのハッシュが違う）: S1 に付け直し、作業の最中でも待たずに S2 へ引き継ぐ。ターンは中断されず、窓は読み直す
//   3. C の main（壊れた版）: S2 に付け直し、引き継ぐが C は立たない → 前の版（B）で付け直す
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { open, sleep } from '../../../tests/lib/ws-client.mjs';
import { readSessions, readUsage, writeSessions, writeUsage } from '../../../tests/lib/data-store.mjs';
import { connectHolder } from '../../../core/holder/client.mjs';

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
// npm ci は electron の実行ファイルを入れないので、無ければ別の作業ディレクトリの node_modules/electron/dist/electron.exe を H_ELECTRON で渡す
const ELECTRON = process.env.H_ELECTRON || path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const RES = { A: path.join(ROOT, 'temporary', 'harness-res', 'A'), B: path.join(ROOT, 'temporary', 'harness-res', 'B'), C: path.join(ROOT, 'temporary', 'harness-res', 'C') };
const BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'ply-h2d-'));
const DIRS = { data: path.join(BASE, 'data'), runtime: path.join(BASE, 'runtime'), user: path.join(BASE, 'user'), signal: path.join(BASE, 'signal'), log: path.join(BASE, 'harness.log') };
for (const dir of [DIRS.data, DIRS.runtime, DIRS.user, DIRS.signal]) fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(DIRS.data, 'prefs.json'), JSON.stringify({ memoryLearnPaused: true }));

// H_SEED=<会話の数>: 実データに近い大きさの置き場を先に作る（会話ごとに H_SEED_ENTRIES 件の履歴・使用量 H_SEED_USAGE 件）。H_ONLY_B=1: C の場面は走らせない
if (process.env.H_SEED) {
  const n = Number(process.env.H_SEED), entries = Number(process.env.H_SEED_ENTRIES || 150), text = 'x'.repeat(900);
  const sessions = {};
  for (let i = 0; i < n; i++) sessions[`seed-${i}`] = { backend: 'fake', title: `seed ${i}`, cwd: ROOT, createdAt: Date.now() - i * 1000, lastModified: Date.now() - i * 1000, completedAt: Date.now() - i * 1000,
    history: Array.from({ length: entries }, (_, k) => ({ at: Date.now() - k, by: 'human', field: 'title', from: `${text}-a${k}`, to: `${text}-b${k}`, reason: null })) };
  writeSessions(DIRS.data, sessions);
  const records = Array.from({ length: Number(process.env.H_SEED_USAGE || 30000) }, (_, i) => ({ id: `seed-u-${i}`, sessionId: `seed-${i % n}`, at: Date.now() - i, backend: 'fake', input: 10, output: 10 }));
  writeUsage(DIRS.data, { since: Date.now(), records });
  console.log('SEED', n, 'sessions; db', Math.round(fs.statSync(path.join(DIRS.data, 'pleiad.db')).size / 1e6), 'MB');
}
const results = [];
let failures = 0;
const check = (label, ok, detail = '') => { results.push({ label, ok: Boolean(ok), detail }); if (!ok) failures++; console.log(`${ok ? 'OK ' : 'NG '} ${label}${detail ? ` — ${detail}` : ''}`); };
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };
async function until(fn, ms, label) {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error(`timeout: ${label}`); await sleep(50); }
}
const logText = () => { try { return fs.readFileSync(DIRS.log, 'utf8'); } catch { return ''; } };
const logLines = name => logText().split('\n').filter(l => l.includes(` ${name} `));
const control = () => { try { return JSON.parse(fs.readFileSync(path.join(DIRS.data, 'control.json'), 'utf8')); } catch { return null; } };
const steps = list => `held:steps:${JSON.stringify({ steps: list })}`;

const cleanEnv = () => {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^(AGENT_HOST_|PLEIAD_|PLY_|AGENT_BROWSER_|ELECTRON_RUN_AS_NODE)/.test(k)) env[k] = v;
  return env;
};
function startElectron(name) {
  fs.rmSync(path.join(DIRS.signal, 'leave'), { force: true });
  fs.rmSync(path.join(DIRS.signal, 'quit'), { force: true });
  const env = { ...cleanEnv(), H_APP: path.join(RES[name], 'app'), H_LOG: DIRS.log, H_SIGNAL: DIRS.signal, H_USERDATA: DIRS.user, H_NAME: name,
    AGENT_HOST_HANDOVER: 'on', AGENT_HOST_RUNTIME_RESOURCES: RES[name], AGENT_HOST_RUNTIME_DIR: DIRS.runtime, AGENT_HOST_DATA: DIRS.data, AGENT_HOST_BACKENDS: 'fake', AGENT_HOST_FAKE_USAGE: '1',
    AGENT_HOST_LOCALE: 'ja', AGENT_HOST_ROUTING_USAGE: 'off', AGENT_HOST_ANTHROPIC_API: 'off', AGENT_HOST_GIT_SNAPSHOTS: 'off', AGENT_HOST_WORKTREES: 'off', AGENT_HOST_GRACE_MS: '600000',
    AGENT_HOST_OPENROUTER_API: 'http://127.0.0.1:9', AGENT_HOST_CEREBRAS_API: 'http://127.0.0.1:9', AGENT_HOST_VOICE_API: 'http://127.0.0.1:9' };
  const child = spawn(ELECTRON, [path.join(import.meta.dirname, 'entry.cjs')], { env, stdio: 'ignore', windowsHide: false });
  const exited = new Promise(resolve => child.once('exit', code => resolve(code)));
  return { child, exited };
}
const signal = name => fs.writeFileSync(path.join(DIRS.signal, name), '');
const urlOf = line => { const m = /(http:\/\/[^ ]+)/.exec(line); const u = new URL(m[1]); return { origin: u.origin, port: Number(u.port), token: u.searchParams.get('token') }; };
const sessionMeta = id => readSessions(DIRS.data)[id] ?? null;
const usageCount = id => (readUsage(DIRS.data)?.records ?? []).filter(r => r.sessionId === id).length;
const exePath = pid => { try { return execFileSync('powershell', ['-NoProfile', '-Command', `(Get-Process -Id ${pid}).Path`], { encoding: 'utf8' }).trim(); } catch { return ''; } };

const pidsToKill = new Set();
let client = null;
let timingOut = null;
try {
  // ---- 1. A
  const a = startElectron('A');
  const first = await until(() => logLines('load').find(l => l.includes('?token=')), 90_000, 'A の窓');
  const conn1 = urlOf(first);
  const s1 = await until(() => control(), 30_000, 'control.json');
  pidsToKill.add(s1.pid);
  check('A: サーバー S1 が実行場所の pleiad-node.exe で走る（main の子でない）', /pleiad-node\.exe$/i.test(exePath(s1.pid)), exePath(s1.pid));
  client = await open({ port: conn1.port, token: conn1.token });
  const ids = {};
  for (const k of ['T', 'Q']) {
    const res = await client.runTurn({ backend: 'fake', cwd: ROOT, prompt: `echo:${k}` }, { ms: 30_000 });
    ids[k] = res.sessionId;
  }
  const before = Object.fromEntries(Object.entries(ids).map(([k, id]) => [k, sessionMeta(id)?.completedAt]));
  const mark = client.mark();
  const scripts = {
    T: steps([{ tool: 'Grep', input: { pattern: 'a' }, result: 'r1', ms: 50 }, { tool: 'Read', input: { path: 'b' }, result: 'r2', ms: 30_000 }, { text: 'final T' }]),
    Q: steps([{ tool: 'Bash', input: { command: 'x' }, result: 'ran', ms: 20, ask: true }, { text: 'final Q' }]),
  };
  for (const k of ['T', 'Q']) void client.cmd('sendMessage', { sessionId: ids[k], messageId: `h2d-${k}-0001`, prompt: scripts[k] }).catch(() => {});
  await client.waitFor(e => e.type === 'tool.start' && e.sessionId === ids.T && e.name === 'Read', { ms: 30_000, from: mark });
  const askQ = await client.waitFor(e => e.type === 'permission' && e.sessionId === ids.Q, { ms: 30_000, from: mark });
  const running = await client.cmd('running');
  check('A: S1 の running が held と handover を載せる（T・Q が held）', running.handover?.held === running.count && running.handover?.blocking === 0 && running.turns.every(t => t.held), JSON.stringify(running.handover));
  client.close(); client = null;
  const tLeave = Date.now();
  signal('leave');
  await a.exited;
  check('A: main が終わってもサーバー S1 は居る（main の子でない）', alive(s1.pid));

  // ---- 2. B
  const b = startElectron('B');
  const switchLines = () => logLines('warn').filter(l => l.includes('[server] switch:'));
  await until(() => switchLines().some(l => /switch: (done|failed)/.test(l)), 90_000, 'B の切り替えの終わり');
  const tDone = Date.now();
  const states = switchLines().map(l => l.replace(/^.*switch: /, ''));
  console.log('B: switch log', states);
  check('B: 作業の最中でも待たずに引き継ぐ（handing → done。waiting・locking が無い）', states.some(s => s.startsWith('handing')) && states.some(s => s.startsWith('done')) && !states.some(s => /^(waiting|locking|stopping)/.test(s)), states.join(' | '));
  const handedLine = switchLines().find(l => l.includes('handed over:'));
  const handed = handedLine ? JSON.parse(/handed over: (\{.*\})/.exec(handedLine)[1]) : null;
  console.log('B: handed over', JSON.stringify(handed));
  const s2 = control();
  pidsToKill.add(s2.pid);
  check('B: S2 は別のプロセス・同じ origin（ポート）', s2.pid !== s1.pid && !alive(s1.pid) && s2.origin === s1.origin, `${s1.pid} -> ${s2.pid}`);
  const loads = logLines('load').filter(l => l.includes('?token='));
  check('B: 窓を読み直す（同じ URL・トークンで 2 回目の読み込み）', loads.length >= 2 && urlOf(loads.at(-1)).token === conn1.token && urlOf(loads.at(-1)).port === conn1.port, `${loads.length} loads`);
  client = await open({ port: conn1.port, token: conn1.token });
  const askB = await client.waitFor(e => e.type === 'permission' && e.sessionId === ids.Q, { ms: 30_000 });
  check('B: 承認は S1 と同じ id で S2 に出る', askB.id === askQ.id);
  await client.cmd('resolvePermission', { id: askB.id, allow: true });
  for (const k of ['T', 'Q']) await client.waitFor(e => e.type === 'turnEnd' && e.sessionId === ids[k], { ms: 60_000 });
  await sleep(800);
  for (const k of ['T', 'Q']) {
    const ends = client.events.filter(e => e.type === 'turnEnd' && e.sessionId === ids[k]);
    const meta = sessionMeta(ids[k]);
    check(`B: ${k} は中断されず 1 回だけ終わる（turnEnd 1・ok・interrupted なし・completedAt・使用量 1 件増）`, ends.length === 1 && ends[0].outcome === 'ok' && !meta.interrupted && meta.completedAt > before[k] && usageCount(ids[k]) === 2,
      JSON.stringify({ ends: ends.length, outcome: ends[0]?.outcome, interrupted: meta.interrupted ?? null, usage: usageCount(ids[k]) }));
  }
  const loadedT = await client.cmd('loadSession', { sessionId: ids.T });
  check('B: T のツールの結果が欠けず重ならない', JSON.stringify(loadedT.messages.flatMap(m => m.toolCalls ?? []).map(c => c.result.text)) === JSON.stringify(['r1', 'r2']));
  const timing = { leaveToDoneMs: tDone - tLeave, handed };
  // サーバーのログから間（S1 が放した → S2 が待ち受けた）を読む
  const serverLog = fs.readFileSync(path.join(DIRS.runtime, 'logs', 'server.log'), 'utf8');
  const released = [...serverLog.matchAll(/released the data lock at=(\d+)/g)].map(m => Number(m[1])).at(-1);
  const listening = [...serverLog.matchAll(/listening at=(\d+)/g)].map(m => Number(m[1])).at(-1);
  console.log('B: released', released, 'listening', listening, 'gap', listening - released);
  timing.releasedToListeningMs = listening - released;
  timingOut = timing;
  check('B: 間（S1 がロックを放す → S2 が待ち受ける）が測れて数秒以内', Number.isFinite(timing.releasedToListeningMs) && timing.releasedToListeningMs >= 0 && timing.releasedToListeningMs < 5000, String(timing.releasedToListeningMs));

  if (process.env.H_ONLY_B) { signal('quit'); await b.exited; await until(() => !alive(s2.pid), 20_000, 'S2 が終わる').catch(() => {}); throw new Error('H_ONLY_B: stop here (not a failure)'); }
  // ---- 3. C: 次のターン T2 を S2 で走らせたまま、壊れた版 C へ切り替える
  const id2 = (await client.runTurn({ backend: 'fake', cwd: ROOT, prompt: 'echo:T2' }, { ms: 30_000 })).sessionId;
  const mark2 = client.mark();
  void client.cmd('sendMessage', { sessionId: id2, messageId: 'h2d-T2-0001', prompt: steps([{ tool: 'Read', input: { path: 'c' }, result: 'c1', ms: 40_000 }, { text: 'final T2' }]) }).catch(() => {});
  await client.waitFor(e => e.type === 'tool.start' && e.sessionId === id2 && e.name === 'Read', { ms: 30_000, from: mark2 });
  client.close(); client = null;
  signal('leave');
  await b.exited;
  check('C 前: サーバー S2 は main が終わっても居る', alive(s2.pid));
  const switchBefore = switchLines().length;
  const c = startElectron('C');
  await until(() => switchLines().slice(switchBefore).some(l => /switch: (done|failed)/.test(l)), 120_000, 'C の切り替えの終わり');
  const statesC = switchLines().slice(switchBefore).map(l => l.replace(/^.*switch: /, ''));
  console.log('C: switch log', statesC);
  const s3 = control();
  pidsToKill.add(s3.pid);
  check('C: 壊れた版は立たず、前の版（B）で起こし直す（fallback → done）', statesC.some(s => s.startsWith('fallback')) && statesC.some(s => s.startsWith('done')) && s3.pid !== s2.pid && !alive(s2.pid), statesC.join(' | '));
  check('C: 前の版で動いている旨のダイアログ（fallback）を出す', logLines('dialog').some(l => l.includes('前の版')) || logLines('dialog').length > 0, logLines('dialog').at(-1) ?? '');
  client = await open({ port: conn1.port, token: conn1.token });
  await client.waitFor(e => e.type === 'turnEnd' && e.sessionId === id2, { ms: 90_000 });
  await sleep(800);
  const ends2 = client.events.filter(e => e.type === 'turnEnd' && e.sessionId === id2);
  const meta2 = sessionMeta(id2);
  check('C: T2 は中断されず前の版が付け直して 1 回だけ終わる', ends2.length === 1 && ends2[0].outcome === 'ok' && !meta2.interrupted && usageCount(id2) === 2, JSON.stringify({ ends: ends2.length, outcome: ends2[0]?.outcome, usage: usageCount(id2) }));
  client.close(); client = null;
  signal('quit');
  await c.exited;
  await until(() => !alive(s3.pid), 20_000, '前の版のサーバーが終わる').catch(() => {});
  check('後片付け: app.quit でサーバーが終わる', !alive(s3.pid));
  fs.writeFileSync(path.join(BASE, 'timing.json'), JSON.stringify(timing, null, 2));
  console.log('TIMING', JSON.stringify(timing));
} catch (error) {
  if (!String(error?.message).startsWith('H_ONLY_B')) { failures++; console.log('NG  harness error:', error?.stack ?? error); }
  else console.log('TIMING', JSON.stringify(timingOut ?? null));
} finally {
  client?.close();
  try {
    const probe = await connectHolder({ dataDir: DIRS.data, root: DIRS.runtime }).catch(() => null);
    if (probe) { for (const ch of probe.welcome.children) if (ch.pid) pidsToKill.add(ch.pid); probe.shutdown(); probe.close(); }
  } catch { /* 無ければ何もしない */ }
  await sleep(1500);
  for (const pid of pidsToKill) if (alive(pid)) { try { process.kill(pid); } catch { /* 済み */ } }
  console.log(`\nHARNESS ${results.filter(r => r.ok).length} / ${results.length} 通過、失敗 ${failures}`);
  console.log('BASE', BASE);
}
process.exit(failures ? 1 : 0);
