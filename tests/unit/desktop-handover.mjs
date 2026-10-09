// 引き継ぎを main の切り替えの流れごと通す（無停止の更新 段階 2 の 2d。desktop/switch.cjs の createSwitch + createSwitchEffects。docs/zero-downtime-update/plan.md 2d）。
// 別プロセスの本物のサーバー（core/server.mjs）を main の包み（desktop/server-link.cjs）につなぎ、保持役に載った fake の台本（held:）のターンを走らせたまま:
//   A. 作業の最中でも切り替わる（待たない。update-lock を取らない）: S2 を --handover で起こし、S1 に handover を頼み、S1 が渡して終わり、同じ包みが S2 につながる。
//      S2 は同じトークン・ポートで、ターンは中断されず続き、turnEnd・completedAt・使用量が 1 回。承認は同じ id で S2 に 1 つ。間（S1 の放す → S2 の ready）を測る
//   B. 新しいサーバーが立たなければ前の版で付け直す: S1 は渡して終わったのに S2（壊れた版）が立たないとき、前の版（S1 と同じ版）を --handover で起こし直し、
//      そのサーバーが札を読んで付け直す。ターンは中断されず 1 回だけ締まる。窓は読み直し、前の版で動いている旨（fallback）を出す
//   C. 引き継げない作業（held: でない fake のターン）があれば、切り替えは待つ（作業が終われば引き継ぐ）
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { ROOT } from '../lib/server.mjs';
import { open, sleep } from '../lib/ws-client.mjs';
import { readSessions, readUsage } from '../lib/data-store.mjs';
import { ensureHolder, connectHolder } from '../../core/holder/client.mjs';

const require = createRequire(import.meta.url);
const sw = require('../../desktop/switch.cjs');
const boot = require('../../desktop/server-boot.cjs');
const { createServerLink } = require('../../desktop/server-link.cjs');

export const name = 'desktop-handover';
export const title = '引き継ぎを切り替えの流れごと: 作業の最中でも待たずに替わる・S2 が立たなければ前の版で付け直す・引き継げない作業があれば待つ';

const WAIT_MS = 30_000;
const steps = list => `held:steps:${JSON.stringify({ steps: list })}`;
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };
async function until(check, ms, label) {
  const end = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timeout: ${label}`);
    await sleep(25);
  }
}

export default async function (t) {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-desktop-handover-'));
  const pids = new Set();
  const childPids = new Set();
  let holderRoot = null, holderDir = null, holderPid = null;
  let client = null;
  const cleanup = [];
  /** 切り替えの 1 場面。旧サーバー S1 を起こし、台本のターンを走らせて、切り替えの流れを通す */
  async function scene(label, { broken = false, blocked = false, scripts }) {
    const dataDir = path.join(scratch, `${label}-data`);
    const root = path.join(scratch, `${label}-runtime`);
    await fs.mkdir(dataDir, { recursive: true });
    await fs.writeFile(path.join(dataDir, 'prefs.json'), JSON.stringify({ memoryLearnPaused: true }));
    holderRoot = root; holderDir = dataDir;
    const found = await ensureHolder({ dataDir, root, mode: 'detached', idleMs: 30_000, timeoutMs: 20_000 });
    holderPid = found.pid;
    found.client.close();
    const baseEnv = { ...process.env, AGENT_HOST_DATA: dataDir, AGENT_HOST_BACKENDS: 'fake', AGENT_HOST_FAKE_USAGE: '1', AGENT_HOST_ANTHROPIC_API: 'off', AGENT_HOST_ROUTING_USAGE: 'off', AGENT_HOST_OPENROUTER_API: 'http://127.0.0.1:9',
      AGENT_HOST_VOICE_API: 'http://127.0.0.1:9', AGENT_HOST_GIT_SNAPSHOTS: 'off', AGENT_HOST_WORKTREES: 'off', AGENT_HOST_LOCALE: 'ja', AGENT_HOST_GRACE_MS: '600000' };
    delete baseEnv.AGENT_HOST_TOKEN;
    const link = createServerLink({ appVersion: '0.0.1' });
    const messages = [];
    link.on('message', m => messages.push(m));
    const request = (type, extra = {}, { timeoutMs = 10_000 } = {}) => new Promise((resolve, reject) => {
      const id = `${type}-${Math.random()}`;
      const timer = setTimeout(() => { link.off('message', on); reject(new Error(`${type}: no answer`)); }, timeoutMs);
      const on = m => { if (m.type === type && m.id === id) { clearTimeout(timer); link.off('message', on); resolve(m); } };
      link.on('message', on);
      link.postMessage({ ...extra, type, id });
    });
    const runningWork = () => new Promise((resolve, reject) => {
      const timer = setTimeout(() => { link.off('message', on); reject(new Error('running: no answer')); }, 10_000);
      const on = m => { if (m.type === 'running') { clearTimeout(timer); link.off('message', on); resolve(m.work); } };
      link.on('message', on);
      link.postMessage({ type: 'running' });
    });
    const s1Env = boot.serverEnv({ baseEnv, root, key: 'test-old', logFile: boot.serverLogFile(root), port: 0 });
    const first = await boot.startAndConnect({ link, dataDir, logFile: boot.serverLogFile(root), timeoutMs: 60_000,
      launch: () => boot.launchServer({ mode: 'detached', nodeExe: process.execPath, args: [path.join(ROOT, 'core', 'server.mjs')], cwd: ROOT, env: s1Env }) });
    pids.add(first.pid);
    const s1Ready = await until(() => messages.find(m => m.type === 'ready'), 15_000, 'S1 の ready');
    client = await open({ port: s1Ready.port, token: s1Ready.token });
    const ids = {};
    for (const k of Object.keys(scripts)) {
      const res = await client.runTurn({ backend: 'fake', cwd: ROOT, prompt: `echo:${k}` }, { ms: WAIT_MS });
      assert.equal(res.outcome, 'ok');
      ids[k] = res.sessionId;
    }
    const before = Object.fromEntries(Object.entries(ids).map(([k, id]) => [k, readSessions(dataDir)[id]?.completedAt]));
    const mark = client.mark();
    for (const k of Object.keys(scripts)) void client.cmd('sendMessage', { sessionId: ids[k], messageId: `${label}-${k}-0001`, prompt: scripts[k] }).catch(() => {});
    return { dataDir, root, link, messages, request, runningWork, baseEnv, first, s1Ready, ids, before, mark };
  }
  /** 切り替えの流れ。prepared の実行場所は ROOT（壊れた版は appDir を空の core にしたもの） */
  async function runSwitch(s, { broken = false } = {}) {
    let appDir = ROOT;
    if (broken) {
      appDir = path.join(scratch, 'broken-app');
      await fs.mkdir(path.join(appDir, 'core'), { recursive: true });
      await fs.writeFile(path.join(appDir, 'core', 'server.mjs'), 'console.error("this version cannot start"); process.exit(3);\n');
    }
    const reloaded = [];
    const fallbacks = [];
    const current = { root: s.root, key: 'test-new', appDir, nodeExe: process.execPath, agentBrowserDir: null };
    const previous = { root: s.root, key: 'test-old', appDir: ROOT, nodeExe: process.execPath, agentBrowserDir: null };
    const effects = sw.createSwitchEffects({ link: s.link, ready: s.s1Ready, prepared: Promise.resolve(current), dataDir: s.dataDir, resourcesPath: ROOT, execPath: process.execPath, cwd: ROOT, env: s.baseEnv,
      request: s.request, runningWork: s.runningWork, abortAll: async () => {}, check: ({ nodeExe, dataDir }) => sw.runHandoverCheck({ nodeExe, appDir: ROOT, dataDir }),
      job: () => ({ inspectJob: () => ({}), decideLaunch: () => ({ mode: 'detached', reason: 'test' }) }),
      runtimeLib: () => ({ stableCliEnv: () => ({}), locate: async ({ key }) => (key === 'test-old' ? previous : null) }),
      reload: async ready => { reloaded.push(ready); }, rearm: () => {}, restart: async () => {}, fallback: async error => { fallbacks.push(error); }, failed: async () => {}, ask: async () => 'later',
      readyTimeoutMs: 30_000, stopTimeoutMs: 20_000 });
    const control = sw.createSwitch({ server: { appVersion: s.s1Ready.appVersion, build: 'a'.repeat(12) }, target: { appVersion: s.s1Ready.appVersion, build: 'b'.repeat(12) }, effects, pollMs: 100 });
    const states = [];
    control.onState(snap => states.push(snap.state));
    return { control, reloaded, fallbacks, states };
  }
  const usageOf = (dataDir, sessionId) => (readUsage(dataDir)?.records ?? []).filter(r => r.sessionId === sessionId);
  try {
    // ---- A. 作業の最中でも待たずに切り替わる
    {
      const s = await scene('a', { scripts: {
        T: steps([{ tool: 'Grep', input: { pattern: 'a' }, result: 'r1', ms: 50 }, { tool: 'Read', input: { path: 'b' }, result: 'r2', ms: 7000 }, { text: 'final T' }]),
        Q: steps([{ tool: 'Bash', input: { command: 'x' }, result: 'ran', ms: 20, ask: true }, { text: 'final Q' }]),
      } });
      await client.waitFor(e => e.type === 'tool.start' && e.sessionId === s.ids.T && e.name === 'Read', { ms: WAIT_MS, from: s.mark });
      const askQ = await client.waitFor(e => e.type === 'permission' && e.sessionId === s.ids.Q, { ms: WAIT_MS, from: s.mark });
      const work = await until(async () => { const w = await s.runningWork(); return w.handover?.held === w.count && w.count >= 2 ? w : null; }, WAIT_MS, '全部が held');
      assert.equal(work.handover.blocking, 0);
      const flow = await runSwitch(s);
      const snap = await flow.control.run();
      assert.equal(snap.state, 'done', JSON.stringify({ state: snap.state, error: snap.error }));
      assert.equal(snap.previous, false);
      const s2 = flow.reloaded[0];
      if (s2?.pid) pids.add(s2.pid);
      assert.ok(s2 && s2.pid !== s.first.pid, '新しいプロセス');
      assert.equal(s2.token, s.s1Ready.token, '同じトークン');
      assert.equal(s2.port, s.s1Ready.port, '同じポート');
      assert.ok(!alive(s.first.pid), 'S1 は終わっている');
      assert.ok(!flow.states.includes('waiting') && !flow.states.includes('locking'), `待たず・update-lock を取らない: ${flow.states.join()}`);
      assert.deepEqual([...snap.handover.handed].sort(), [s.ids.T, s.ids.Q].sort());
      assert.ok(snap.handover.adopted === 2, JSON.stringify(snap.handover));
      assert.ok(Number.isFinite(snap.handover.gapMs) && snap.handover.gapMs >= 0, JSON.stringify(snap.handover));
      assert.ok(s.link.connected && s.link.pid === s2.pid, '同じ包みが S2 につながる');
      console.log(`  [desktop-handover] 作業の最中の切り替え: ${JSON.stringify({ ...snap.handover, handed: undefined })}`);
      client.close();
      client = await open({ port: s2.port, token: s2.token });
      const askB = await client.waitFor(e => e.type === 'permission' && e.sessionId === s.ids.Q, { ms: WAIT_MS });
      assert.equal(askB.id, askQ.id, '承認は S1 と同じ id で S2 に出る');
      await client.cmd('resolvePermission', { id: askB.id, allow: true });
      for (const k of ['T', 'Q']) await client.waitFor(e => e.type === 'turnEnd' && e.sessionId === s.ids[k], { ms: WAIT_MS });
      await sleep(500);
      for (const k of ['T', 'Q']) {
        const ends = client.events.filter(e => e.type === 'turnEnd' && e.sessionId === s.ids[k]);
        assert.equal(ends.length, 1, `${k}: turnEnd は 1 回`);
        assert.equal(ends[0].outcome, 'ok', `${k}: 中断されない`);
        const meta = readSessions(s.dataDir)[s.ids[k]];
        assert.equal(meta.interrupted ?? null, null);
        assert.ok(meta.completedAt > s.before[k], `${k}: 完了時刻`);
        assert.equal(usageOf(s.dataDir, s.ids[k]).length, 2, `${k}: 使用量は 1 ターンにつき 1 件（echo と台本）`);
        const loaded = await client.cmd('loadSession', { sessionId: s.ids[k] });
        assert.equal(loaded.messages.filter(m => m.role === 'assistant' && m.text === `final ${k}`).length, 1, `${k}: 本文は 1 回`);
      }
      t.ok('作業の最中でも待たずに切り替わる（update-lock なし）。S2 は同じトークン・ポート・同じ包み。ターンは中断されず、turnEnd・completedAt・使用量が 1 回、承認は同じ id', true);
      t.ok(`間: S1 がロックを放してから S2 が ready を送るまで ${snap.handover.gapMs} ms・S1 の中の時間 ${JSON.stringify(snap.handover.old)}`, true);
      client.close(); client = null;
      s.link.kill();
      await until(() => !alive(s2.pid), 20_000, 'S2 が終わる');
      const probe = await connectHolder({ dataDir: s.dataDir, root: s.root }).catch(() => null);
      if (probe) { for (const child of probe.welcome.children) if (child.pid) childPids.add(child.pid); probe.shutdown(); probe.close(); }
      await until(() => !alive(holderPid), 10_000, '保持役が終わる').catch(() => {});
    }

    // ---- B. 新しいサーバーが立たなければ前の版で付け直す
    {
      const s = await scene('b', { scripts: { T: steps([{ tool: 'Grep', input: { pattern: 'a' }, result: 'r1', ms: 50 }, { tool: 'Read', input: { path: 'b' }, result: 'r2', ms: 12_000 }, { text: 'final T' }]) } });
      await client.waitFor(e => e.type === 'tool.start' && e.sessionId === s.ids.T && e.name === 'Read', { ms: WAIT_MS, from: s.mark });
      await until(async () => (await s.runningWork()).handover?.held === 1, WAIT_MS, 'T が held');
      const flow = await runSwitch(s, { broken: true });
      const snap = await flow.control.run();
      assert.equal(snap.state, 'done', JSON.stringify({ state: snap.state, error: snap.error }));
      assert.equal(snap.previous, true, '前の版で動いている');
      assert.equal(flow.fallbacks.length, 1, '前の版で動いている旨を知らせる');
      assert.ok(flow.states.includes('handing') && flow.states.includes('fallback'), flow.states.join());
      const back = flow.reloaded[0];
      if (back?.pid) pids.add(back.pid);
      assert.ok(back && back.pid !== s.first.pid && back.token === s.s1Ready.token && back.port === s.s1Ready.port, '前の版のサーバーが同じトークン・ポートで立つ');
      assert.equal(back.handover?.adopted, 1, '前の版が札を読んで付け直した');
      client.close();
      client = await open({ port: back.port, token: back.token });
      await client.waitFor(e => e.type === 'turnEnd' && e.sessionId === s.ids.T, { ms: WAIT_MS });
      await sleep(400);
      const ends = client.events.filter(e => e.type === 'turnEnd' && e.sessionId === s.ids.T);
      assert.equal(ends.length, 1, 'turnEnd は 1 回');
      assert.equal(ends[0].outcome, 'ok', '中断されない');
      assert.equal(readSessions(s.dataDir)[s.ids.T].interrupted ?? null, null);
      assert.equal(usageOf(s.dataDir, s.ids.T).length, 2, '使用量は 1 回');
      t.ok('新しいサーバーが立たなければ（S1 は渡して終わっている）、前の版を --handover で起こし直して札から付け直す。ターンは中断されず、窓は読み直し、前の版で動いている旨を出す', true);
      client.close(); client = null;
      s.link.kill();
      await until(() => !alive(back.pid), 20_000, '前の版のサーバーが終わる');
      const probe = await connectHolder({ dataDir: s.dataDir, root: s.root }).catch(() => null);
      if (probe) { for (const child of probe.welcome.children) if (child.pid) childPids.add(child.pid); probe.shutdown(); probe.close(); }
      await until(() => !alive(holderPid), 10_000, '保持役が終わる').catch(() => {});
    }

    // ---- C. 引き継げない作業（held: でないターン）があれば待つ。終われば引き継ぐ
    {
      const s = await scene('c', { scripts: { T: steps([{ tool: 'Read', input: { path: 'b' }, result: 'r2', ms: 12_000 }, { text: 'final T' }]), B: 'slow' } });
      await client.waitFor(e => e.type === 'tool.start' && e.sessionId === s.ids.T && e.name === 'Read', { ms: WAIT_MS, from: s.mark });
      const work = await until(async () => { const w = await s.runningWork(); return w.turns.some(x => x.sessionId === s.ids.B) ? w : null; }, WAIT_MS, 'B が走る');
      assert.equal(work.handover.blocking, 1, '載っていないターン 1 件が待たせる作業');
      const flow = await runSwitch(s);
      const running = flow.control.run();
      await until(() => flow.states.includes('waiting'), 10_000, '待ちに入る');
      assert.ok(!flow.states.includes('handing'), '載っていないターンの間は引き継がない');
      assert.ok(alive(s.first.pid), 'S1 は居る');
      await client.cmd('abort', { sessionId: s.ids.B }).catch(() => {});
      const snap = await running;
      assert.equal(snap.state, 'done', JSON.stringify({ state: snap.state, error: snap.error }));
      const s2 = flow.reloaded[0];
      if (s2?.pid) pids.add(s2.pid);
      assert.equal(snap.handover.adopted, 1, '載っていたターン 1 件を引き継ぐ');
      client.close();
      client = await open({ port: s2.port, token: s2.token });
      await client.waitFor(e => e.type === 'turnEnd' && e.sessionId === s.ids.T, { ms: WAIT_MS });
      assert.equal(client.events.filter(e => e.type === 'turnEnd' && e.sessionId === s.ids.T && e.outcome === 'ok').length, 1);
      t.ok('引き継げない作業（held: でないターン）があれば切り替えは待ち、終わったら引き継ぐ（載っていたターンは中断されない）', true);
      client.close(); client = null;
      s.link.kill();
      await until(() => !alive(s2.pid), 20_000, 'S2 が終わる');
      const probe = await connectHolder({ dataDir: s.dataDir, root: s.root }).catch(() => null);
      if (probe) { for (const child of probe.welcome.children) if (child.pid) childPids.add(child.pid); probe.shutdown(); probe.close(); }
      await until(() => !alive(holderPid), 10_000, '保持役が終わる').catch(() => {});
    }
  } finally {
    client?.close();
    for (const pid of pids) if (alive(pid)) { try { process.kill(pid); } catch { /* 済み */ } }
    if (holderPid && alive(holderPid) && holderRoot) {
      const probe = await connectHolder({ dataDir: holderDir, root: holderRoot }).catch(() => null);
      if (probe) { for (const child of probe.welcome.children) if (child.pid) childPids.add(child.pid); probe.shutdown(); probe.close(); }
      await until(() => !alive(holderPid), 10_000, '保持役が終わる').catch(() => { try { process.kill(holderPid); } catch { /* 済み */ } });
    }
    for (const pid of childPids) if (alive(pid)) { try { process.kill(pid); } catch { /* 済み */ } }
    for (const fn of cleanup) await fn();
    await sleep(300);
    await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}
