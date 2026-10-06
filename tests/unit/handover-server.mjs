// 段階 2 の 2d: 引き継ぎ（旧サーバー → 新サーバー）を、本物の 2 つのサーバー（core/server.mjs。AGENT_HOST_HANDOVER=on の名前付きパイプ）と
// 保持役・偽の CLI（台本 held:）・偽の main（desktop/server-link.cjs）で確かめる（docs/zero-downtime-update/plan.md 2d、design.md §5.1）。
//   1. 旧サーバー S1 が held: のターンを走らせたまま、main の handover の依頼で渡して終わる。新サーバー S2 は `--handover` で先に起こしておき
//      （モジュールを読み込んでデータ置き場のロックを待つ）、S1 が放したら取って、預かり物（トークン・ポート）で待ち受け、札から付け直す。
//      ターンは中断されず、turnEnd・completedAt・使用量が 1 回だけ。承認待ちは同じ id で 1 つ。S1 は終わり、S2 は S1 と同じトークン・ポートで待ち受ける
//   2. 引き継げない作業（held: でない fake のターン）があれば S1 は断る（blocked）。S1 は元のまま動き、新しい作業は送信待ちから戻って始まる
//   3. 処理中の MCP の呼び出しは上限（inflightMs）まで待ち、過ぎたら待ち切れた数を答えに載せて進む。その間に送った発言は送信待ちに回り（hold）、S2 が送る（保留にならない）
//   4. 後片付け: 保持役・偽の CLI・サーバーが残らない
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { startServer, ROOT } from '../lib/server.mjs';
import { open, sleep } from '../lib/ws-client.mjs';
import { readSessions, readUsage } from '../lib/data-store.mjs';
import { ensureHolder, connectHolder } from '../../core/holder/client.mjs';

const require = createRequire(import.meta.url);
const { createServerLink, readLinkInfo } = require('../../desktop/server-link.cjs');

export const name = 'handover-server';
export const title = '引き継ぎ: 旧サーバーが held: のターンを渡して終わり、新サーバー（--handover）が同じトークン・ポートで付け直す。引き継げない作業があれば断る';

const WAIT_MS = 25_000;
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

/** 偽の main: パイプにつなぎ、受けたメッセージを溜める（pid が合うサーバーの main-link.json だけを見る） */
async function attachMain(dataDir, pid) {
  const info = await until(() => { const found = readLinkInfo(dataDir); return found?.pid === pid ? found : null; }, WAIT_MS, `main-link.json (pid ${pid})`);
  const link = createServerLink({ pipe: info.pipe, secret: info.secret, appVersion: '0.0.1' });
  const seen = { messages: [], exits: [] };
  link.on('message', message => seen.messages.push(message));
  link.on('exit', code => seen.exits.push(code));
  await link.connect();
  return { link, seen, request: async (type, extra = {}, ms = WAIT_MS) => {
    const id = Math.floor(Math.random() * 1e9);
    link.postMessage({ ...extra, type, id });
    return until(() => seen.messages.find(m => m.type === type && m.id === id), ms, `${type} の答え`);
  } };
}

export default async function (t) {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-handover-'));
  const dataDir = path.join(scratch, 'data');
  const root = path.join(scratch, 'runtime');
  const scenesDir = path.join(scratch, 'scenes');
  await fs.mkdir(scenesDir);
  const env = { AGENT_HOST_BACKENDS: 'fake', AGENT_HOST_FAKE_USAGE: '1', AGENT_HOST_RUNTIME_ROOT: root, AGENT_HOST_HANDOVER: 'on', AGENT_HOST_GRACE_MS: '600000', ADOPT_SCENES_DIR: scenesDir };
  // S1 の入口は tests/lib/adopt-server.mjs（本物の core/server.mjs に、画面からは入れない場面を足したもの）
  const scene = async (sceneName, input = {}) => {
    const done = path.join(scenesDir, `${sceneName}.done`);
    await fs.writeFile(path.join(scenesDir, `${sceneName}.tmp`), JSON.stringify(input));
    await fs.rename(path.join(scenesDir, `${sceneName}.tmp`), path.join(scenesDir, `${sceneName}.go`));
    const text = await until(() => fs.readFile(done, 'utf8').catch(() => null), WAIT_MS, `場面 ${sceneName}`);
    await fs.rm(done);
    const out = JSON.parse(text);
    if (!out.ok) throw new Error(out.error);
    return out.value;
  };
  const sessionMeta = id => readSessions(dataDir)[id] ?? null;
  let s1 = null, s2 = null, c1 = null, c2 = null, m1 = null, m2 = null, holderPid = null;
  const childPids = new Set();
  try {
    // 保持役を先に起こしておく（detached）。サーバーは同じ保持役につなぐ
    const found = await ensureHolder({ dataDir, root, mode: 'detached', idleMs: 20_000, timeoutMs: 20_000 });
    holderPid = found.pid;
    found.client.close();

    s1 = await startServer({ env, dataDir, timeoutMs: 40_000, entry: path.join(ROOT, 'tests', 'lib', 'adopt-server.mjs') });
    m1 = await attachMain(dataDir, s1.child.pid);
    c1 = await open({ port: s1.port, token: s1.token });
    const ids = {};
    for (const k of ['T', 'Q', 'B', 'X']) {
      const res = await c1.runTurn({ backend: 'fake', cwd: ROOT, prompt: `echo:${k}` }, { ms: WAIT_MS });
      assert.equal(res.outcome, 'ok');
      ids[k] = res.sessionId;
    }
    const before = Object.fromEntries(Object.entries(ids).map(([k, id]) => [k, sessionMeta(id)?.completedAt]));
    const scripts = {
      T: steps([{ tool: 'Grep', input: { pattern: 'a' }, result: 'r1', ms: 50 }, { tool: 'Read', input: { path: 'b' }, result: 'r2', ms: 5000 }, { text: 'final T' }]),
      Q: steps([{ tool: 'Bash', input: { command: 'x' }, result: 'ran', ms: 20, ask: true }, { text: 'final Q' }]),
    };

    // ---- 2. 引き継げない作業があれば断る（先に。S1 が元のまま動くことも見る）
    {
      const from = c1.mark();
      void c1.cmd('sendMessage', { sessionId: ids.B, messageId: 'handover-b-0001', prompt: 'slow' }).catch(() => {});
      await c1.waitFor(e => e.type === 'turn.started' || e.type === 'session' || e.type === 'activity', { ms: WAIT_MS, from }).catch(() => {});
      const running = await until(async () => { const r = await c1.cmd('running'); return r.turns.some(x => x.sessionId === ids.B) ? r : null; }, WAIT_MS, 'running の B');
      assert.equal(running.handover.v, 1, 'running に handover の版');
      assert.equal(running.turns.find(x => x.sessionId === ids.B).held ?? false, false, '保持役に載っていないターンは held でない');
      assert.equal(running.handover.blocking, running.count, '渡せない作業は待たせる作業');
      const declined = await m1.request('handover');
      assert.equal(declined.ok, false);
      assert.equal(declined.reason, 'blocked', JSON.stringify(declined));
      assert.ok(String(declined.detail).includes(ids.B), declined.detail);
      // S1 は元のまま（落ちていない・新しい作業は送信待ちのままにならない）
      await c1.cmd('abort', { sessionId: ids.B }).catch(() => {});
      await c1.waitFor(e => e.type === 'turnEnd' && e.sessionId === ids.B, { ms: WAIT_MS, from });
      assert.ok(alive(s1.child.pid), 'S1 は断った後も居る');
      const again = await c1.runTurn({ sessionId: ids.B, prompt: 'echo:after' }, { ms: WAIT_MS });
      assert.equal(again.outcome, 'ok', '断った後に新しい作業を始められる（hold は戻っている）');
      t.ok('引き継げない作業（held: でないターン）があれば S1 は断り（blocked）、元のまま動く。送信待ちに回していた新しい作業も戻る', true);
    }

    // ---- 1. 引き継ぐ
    const from1 = c1.mark();
    for (const k of ['T', 'Q']) void c1.cmd('sendMessage', { sessionId: ids[k], messageId: `handover-${k}-0001`, prompt: scripts[k] }).catch(() => {});
    await c1.waitFor(e => e.type === 'tool.start' && e.sessionId === ids.T && e.name === 'Read', { ms: WAIT_MS, from: from1 });
    const askQ = await c1.waitFor(e => e.type === 'permission' && e.sessionId === ids.Q, { ms: WAIT_MS, from: from1 });
    {
      const running = await until(async () => { const r = await c1.cmd('running'); return r.turns.filter(x => x.held).length === 2 ? r : null; }, WAIT_MS, '2 つのターンが held');
      assert.equal(running.handover.blocking, 0, '全部が渡せる作業: 待たせる作業は 0 件（作業の最中でも切り替わる）');
      assert.ok(running.count >= 2 && running.handover.held === running.count, JSON.stringify(running.handover));
      assert.ok(running.permissions.find(p => p.id === askQ.id)?.held, '承認待ちも held');
    }
    // S2 を先に起こす（--handover。モジュールを読み込んで、データ置き場のロックを待つ）。待ち受けない
    s2 = await startServer({ env, dataDir, timeoutMs: 60_000, args: ['--handover'], lazy: true });
    await sleep(800);
    assert.equal(s2.child.exitCode, null, 'S2 はロックを待って居る');
    assert.ok(!s2.tail(50).includes('agent-host  http'), 'S2 はロックが取れるまで待ち受けない');
    const releasedAt = { s1: null };
    // 処理中の MCP の呼び出しが 8 秒続いている形を作る。上限（inflightMs 1.2 秒）で待つのをやめて進む。待っている間（新しい作業の開始を送信待ちに回している間）に送った発言は、S2 が送る
    await scene('slowCall', { ms: 8000 });
    const markHold = c1.mark();
    const pendingReply = m1.request('handover', { inflightMs: 1200 }, 40_000);
    await sleep(300);
    void c1.cmd('sendMessage', { sessionId: ids.X, messageId: 'handover-x-0001', prompt: 'echo:held-by-handover' }).catch(() => {});
    const queued = await c1.waitFor(e => e.type === 'outbox' && e.sessionId === ids.X && e.messages.some(m => m.id === 'handover-x-0001' && m.status === 'queued' && m.waiting?.detail === 'handover'), { ms: 5000, from: markHold });
    assert.ok(queued, '引き継ぎの間に送った発言は送信待ちに回る（始まらない）');
    assert.ok(!c1.since(markHold).some(e => e.sessionId === ids.X && e.type === 'turn.started'), 'S1 では始まらない');
    const reply = await pendingReply;
    assert.equal(reply.ok, true, JSON.stringify(reply));
    assert.equal(reply.droppedCalls, 1, '待ち切れなかった処理中の呼び出しの数');
    assert.ok(reply.ms.inflight >= 1000 && reply.ms.inflight < 4000, `処理中の呼び出しを待った時間は上限まで: ${reply.ms.inflight} ms`);
    assert.deepEqual([...reply.handed].sort(), [ids.T, ids.Q].sort(), '渡したターン');
    assert.equal(reply.aborted.length, 0);
    releasedAt.s1 = reply.at;
    await until(() => s1.child.exitCode !== null, 20_000, 'S1 が終わる');
    assert.equal(s1.child.exitCode, 0, `S1 は正常に終わる\n${s1.tail(20)}`);
    await s2.ready();
    assert.equal(s2.port, s1.port, 'S2 は S1 と同じポートで待ち受ける（預かり物）');
    m2 = await attachMain(dataDir, s2.child.pid);
    const ready2 = await until(() => m2.seen.messages.find(m => m.type === 'ready'), WAIT_MS, 'S2 の ready');
    assert.equal(ready2.token, s1.token, 'S2 は S1 と同じ画面のトークン（預かり物。startServer が S2 に渡した別のトークンではない）');
    assert.equal(ready2.port, s1.port);
    assert.ok(ready2.handover && ready2.handover.adopted === 2, `ready の handover: ${JSON.stringify(ready2.handover)}`);
    const gapMs = ready2.handover.at - releasedAt.s1;
    console.log(`  [handover-server] S1 released → S2 ready: ${gapMs} ms (lock wait ${ready2.handover.lockWaitedMs} ms; S1 timings ${JSON.stringify(reply.ms)})`);
    assert.ok(gapMs >= 0 && gapMs < 15_000, `間: ${gapMs} ms`);

    c1.close(); c1 = null;
    c2 = await open({ port: s1.port, token: s1.token });
    const askB = await c2.waitFor(e => e.type === 'permission' && e.sessionId === ids.Q, { ms: WAIT_MS });
    await sleep(500);
    assert.equal(c2.events.filter(e => e.type === 'permission' && e.sessionId === ids.Q).length, 1, 'S2 に承認が 1 つだけ出る');
    assert.equal(askB.id, askQ.id, '承認の id は S1 と同じ（ツールの id から決まる）');
    await c2.cmd('resolvePermission', { id: askB.id, allow: true });
    for (const k of ['T', 'Q']) await c2.waitFor(e => e.type === 'turnEnd' && e.sessionId === ids[k], { ms: WAIT_MS });
    // 送信待ちに回っていた発言は S2 が送った（保留にならず、1 回だけ）
    await until(() => sessionMeta(ids.X)?.outbox?.find(m => m.id === 'handover-x-0001')?.status === 'sent', WAIT_MS, 'S2 が送信待ちの発言を送る');
    await until(async () => (await c2.cmd('loadSession', { sessionId: ids.X })).messages.filter(m => m.role === 'assistant' && String(m.text).includes('held-by-handover')).length === 1, WAIT_MS, 'X の返答');
    await sleep(500);
    for (const k of ['T', 'Q']) {
      const ends = c2.events.filter(e => e.type === 'turnEnd' && e.sessionId === ids[k]);
      assert.equal(ends.length, 1, `${k}: turnEnd は 1 回`);
      assert.equal(ends[0].outcome, 'ok', `${k}: 中断されず最後まで流れる`);
      const meta = sessionMeta(ids[k]);
      assert.equal(meta.interrupted ?? null, null, `${k}: 中断の印は無い`);
      assert.ok(meta.completedAt > before[k], `${k}: 完了時刻を書く`);
      const loaded = await c2.cmd('loadSession', { sessionId: ids[k] });
      assert.equal(loaded.messages.filter(m => m.role === 'assistant' && m.text === `final ${k}`).length, 1, `${k}: 最後の本文は 1 回`);
    }
    {
      const loaded = await c2.cmd('loadSession', { sessionId: ids.T });
      assert.deepEqual(loaded.messages.flatMap(m => m.toolCalls ?? []).map(c => c.result.text), ['r1', 'r2'], 'T: ツールの結果が欠けず重ならない');
    }
    // 使用量は 1 ターンにつき 1 件（旧サーバーが記録していても重ねない）
    for (const k of ['T', 'Q']) {
      const records = (readUsage(dataDir)?.records ?? []).filter(r => r.sessionId === ids[k]);
      assert.equal(records.length, 2, `${k}: 使用量は echo のターンと引き継いだターンの 2 件（重ならない）`);
    }
    assert.ok(!s2.tail(300).includes('[unhandledRejection]'), s2.tail(20));
    assert.ok(s2.tail(300).includes('[handover] got the data lock'), s2.tail(20));
    t.ok('旧サーバーが held: のターン（ツールの実行中・承認待ち）を渡して終わり、新サーバー（--handover）が同じトークン・ポートで付け直す。ターンは中断されず、turnEnd・completedAt・使用量が 1 回、承認は同じ id で 1 つ', true);
    t.ok(`引き継ぎの間（S1 がロックを放してから S2 が ready を送るまで）は ${gapMs} ms`, true);
    t.ok('処理中の MCP の呼び出しは上限まで待って進み（待ち切れた数を答える）、その間に送った発言は送信待ちに回って S2 が 1 回だけ送る', true);
    c2.close(); c2 = null;
    m2.link.leave(); m2 = null;
    await s2.stop(); s2 = null;
  } finally {
    c1?.close();
    c2?.close();
    for (const m of [m1, m2]) { try { m?.link?.kill(); } catch { /* 終わっていれば何もしない */ } }
    await s1?.stop();
    await s2?.stop();
    if (holderPid) {
      const probe = await connectHolder({ dataDir, root }).catch(() => null);
      if (probe) for (const child of probe.welcome.children) if (child.pid) childPids.add(child.pid);
      probe?.shutdown();
      probe?.close();
      await until(() => !alive(holderPid), 10_000, '保持役が終わる').catch(() => { try { process.kill(holderPid); } catch { /* 既に終わっている */ } });
      for (const pid of childPids) await until(() => !alive(pid), 10_000, `偽の CLI（${pid}）が終わる`).catch(() => { try { process.kill(pid); } catch { /* 既に終わっている */ } });
    }
    await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}
