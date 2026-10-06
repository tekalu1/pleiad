// 段階 2 の 2b-5: 保持役の子に載せた台本（fake の held:）を、サーバーの入れ替えをまたいで付け直す
// （docs/zero-downtime-update/stage2-server-state.md §6・§6.1。保持役は core/holder/、偽の CLI は core/backends/fake-agent.mjs）。
//   1. 入れ替えなしの held:（旧サーバー A だけ）: 承認待ち → 答えて続く・途中送信が偽の CLI へ届く・終わった子は保持役から捨てる
//   2. 途中で引き継ぐ: A でターンを始め、途中で A が手を離し（handOffTurn → 保持役に札を置いて detach。tests/lib/adopt-server.mjs）、
//      A を止めて、同じデータ置き場で B を起こして付け直す（AGENT_HOST_ADOPT_HOLDER=1）。ターンが最後まで流れ、turnEnd・completedAt・使用量が 1 回だけ。
//      時点: ツールの実行中・承認待ち・終わった直後（偽の CLI は A が読まないうちに終わっている）。承認は A と B で同じ id（ツールの id から決まる。core/approval-id.mjs）で
//      1 つだけ出て、通知の一覧のあなた待ちの行も 1 つのまま（起動の後片付けが決着させない）。B の実行中のスナップショット（loadSession）が A と同じ
//   3. 強制終了（2e。handOff を経ない。A を SIGKILL）: 札はターンの始まりと札の中身が変わるたびに保持役の子へ置き直されているので（touchCard）、B が付け直せる。
//      時点: 承認待ち（A と同じ id・通知の一覧の行が 1 つ）・ツールの実行中・裏の作業の待ち（phase: waiting が戻る）・中断の最中（A の中断が子に届かないまま落ちた。
//      B が中断を送り直し、理由は元のまま）。B の固定のポートが塞がっていても、付け直すターンがあるので空くまで待つ（空きポートへ移らない）
//   4. 準備中（バックエンドを呼ぶ前）: handOffTurn は null・強制終了すると付け直さず restart の中断。固定のポートが上限まで塞がったままなら付け直しをあきらめて
//      そのターンも restart の中断（B は空きポートへ移る）
//   6. 後片付け: 保持役・偽の CLI・サーバーが残らない（保持役は detached なので、終わりに shutdown して pid が消えるまで見る）
//   5. 途中送信と委譲の子（2b-7。渡った合図を後から出す台本 AGENT_HOST_FAKE_STEER_CONFIRM_MS）: 札の steers に、受理した途中送信（pendingSteers）・渡った合図を待つ完了通知
//      （liveNotices）・追加指示（liveInstructions と agentTasks の claim）が載り、B が作り直す。合図が B の再生の側（手を離す前半の後に A が読み捨てて ack）でも続きの側でも、
//      渡った合図・完了通知の一行・返答が 1 回ずつ。捨てられた合図は送信待ちを保留へ・追加指示を待機へ戻す。委譲の子のターンは B が付け直し、タスクは interrupted にならず、
//      結果の確定を agentTasks.adoptRun が引き継いで依頼元へ完了通知を 1 回だけ届ける（単体は agent-tasks-adopt）
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { startServer, ROOT } from '../lib/server.mjs';
import { open, sleep } from '../lib/ws-client.mjs';
import { readSessions, readUsage } from '../lib/data-store.mjs';
import { createFakeGates } from '../lib/fake-gate.mjs';
import { ensureHolder, connectHolder } from '../../core/holder/client.mjs';

export const name = 'adopt-held';
export const title = '付け直し: 保持役の子（held: の偽の CLI）を、サーバーの入れ替えをまたいで途中から引き継ぐ';

const WAIT_MS = 20_000;
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

/** 固定のポートを塞ぐ（holdMs 後に自分で離す。release は離すのを待つ） */
async function holdPort(holdMs) {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const closed = new Promise(resolve => server.once('close', resolve));
  setTimeout(() => server.close(), holdMs).unref();
  return { port, release: () => { server.close(); return closed; } };
}

export default async function (t) {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-adopt-held-'));
  const dataDir = path.join(scratch, 'data');
  const root = path.join(scratch, 'runtime');
  const scenesDir = path.join(scratch, 'scenes');
  await fs.mkdir(scenesDir);
  const gates = await createFakeGates(scratch);
  const sessionMeta = id => readSessions(dataDir)[id] ?? null;
  const usageOf = key => (readUsage(dataDir)?.records ?? []).filter(r => r.id === key);
  const usageOfSession = sessionId => (readUsage(dataDir)?.records ?? []).filter(r => r.sessionId === sessionId);
  // 通知の一覧のあなた待ちの行（承認の成立で載り、決着で resolvedAt・outcome が付く）
  const inboxWaits = async (client, sessionId) => (await client.cmd('invoke', { op: 'notifications.list', args: { filter: 'wait' } })).items.filter(x => x.target.sessionId === sessionId);
  // 実行中のスナップショット（loadSession live）の、A と B で同じになるはずの部分: 承認・ツールと本文の出来事・このターンの人の発言
  // （fake の履歴はプロセスのメモリなので、前のターンまでの発言は B に無い。Claude などは transcript から戻る）
  const shapeOf = snap => ({
    permissions: snap.permissions.map(p => [p.id, p.toolName]),
    events: snap.stream.events.filter(e => ['tool.start', 'tool.result', 'text.end'].includes(e.type)).map(e => [e.type, e.id ?? e.uuid ?? null]),
    user: snap.messages.filter(m => m.role === 'user').at(-1)?.text ?? null,
  });
  const env = { AGENT_HOST_BACKENDS: 'fake', AGENT_HOST_FAKE_USAGE: '1', AGENT_HOST_RUNTIME_ROOT: root, ADOPT_SCENES_DIR: scenesDir, ...gates.env };
  let a = null, b = null, ca = null, cb = null, holderPid = null;
  const childPids = new Set();
  try {
    // 保持役を先に起こしておく（detached。誰もつながず子も無ければ 20 秒で終わる）。サーバーの fake は ensureHolder で同じ保持役につなぐ
    const found = await ensureHolder({ dataDir, root, mode: 'detached', idleMs: 20_000, timeoutMs: 20_000 });
    holderPid = found.pid;
    found.client.close();

    a = await startServer({ env, dataDir, timeoutMs: 30_000, entry: path.join(ROOT, 'tests', 'lib', 'adopt-server.mjs') });
    const scene = async (sceneName, input = {}) => {
      const done = path.join(scenesDir, `${sceneName}.done`);
      await fs.writeFile(path.join(scenesDir, `${sceneName}.tmp`), JSON.stringify(input));
      await fs.rename(path.join(scenesDir, `${sceneName}.tmp`), path.join(scenesDir, `${sceneName}.go`));
      const text = await until(() => fs.readFile(done, 'utf8').catch(() => null), WAIT_MS, `場面 ${sceneName}\n${a.tail(10)}`);
      await fs.rm(done);
      const out = JSON.parse(text);
      if (!out.ok) throw new Error(out.error);
      return out.value;
    };
    ca = await open({ port: a.port, token: a.token });
    // P: 入れ替えなしの承認 / S: 途中送信 / T: ツールの実行中に引き継ぐ / Q: 承認待ちで引き継ぐ / F: 偽の CLI が終わった後に引き継ぐ
    const ids = {};
    for (const k of ['P', 'S', 'T', 'Q', 'F']) {
      const res = await ca.runTurn({ backend: 'fake', cwd: ROOT, prompt: `echo:${k}` }, { ms: WAIT_MS });
      assert.equal(res.outcome, 'ok');
      ids[k] = res.sessionId;
    }
    const before = Object.fromEntries(Object.entries(ids).map(([k, id]) => [k, sessionMeta(id)?.completedAt]));
    const textsOf = (client, sessionId) => client.events.filter(e => e.type === 'text.end' && e.sessionId === sessionId).length;
    const permissions = (client, sessionId) => client.events.filter(e => e.type === 'permission' && e.sessionId === sessionId);

    // 1. 入れ替えなし: 承認待ち → 答えると続く。出来事は偽の CLI（別プロセス）のもの
    {
      const from = ca.mark();
      void ca.cmd('runTurn', { sessionId: ids.P, prompt: steps([{ tool: 'Bash', input: { command: 'ls' }, result: 'listing', ms: 20, ask: true }, { text: 'final P' }]) }).catch(() => {});
      const ask = await ca.waitFor(e => e.type === 'permission' && e.sessionId === ids.P, { ms: WAIT_MS, from });
      await ca.cmd('resolvePermission', { id: ask.id, allow: true });
      await ca.waitFor(e => e.type === 'turnEnd' && e.sessionId === ids.P, { ms: WAIT_MS, from });
      const slice = ca.since(from).filter(e => e.sessionId === ids.P || e.sessionId == null);
      assert.equal(slice.filter(e => e.type === 'turnEnd' && e.sessionId === ids.P).length, 1, 'turnEnd は 1 回');
      assert.equal(slice.filter(e => e.type === 'tool.result' && e.text === 'listing').length, 1, '承認の後にツールの結果が出る');
      assert.equal(slice.filter(e => e.type === 'text.end').length, 1);
      const loaded = await ca.cmd('loadSession', { sessionId: ids.P });
      assert.equal(loaded.messages.filter(m => m.role === 'assistant' && m.text === 'final P').length, 1, '履歴に本文が 1 回');
      assert.ok(sessionMeta(ids.P).completedAt > before.P);
      t.ok('held: 入れ替えなし: 偽の CLI の承認待ちが画面に出て、答えると続き、turnEnd・本文・ツールの結果が 1 回', true);
    }
    // 途中送信: 偽の CLI の control.steer が受け、返答が出る（bg は裏の子をゲートで待つ）
    {
      const from = ca.mark();
      void ca.cmd('runTurn', { sessionId: ids.S, prompt: 'held:bg 1 gate:held-bg' }).catch(() => {});
      await ca.waitFor(e => e.type === 'phase' && e.sessionId === ids.S && e.state === 'waiting', { ms: WAIT_MS, from });
      await ca.cmd('sendMessage', { sessionId: ids.S, messageId: 'held-steer-0001', prompt: 'steer-me' });
      await until(() => textsOf({ events: ca.since(from) }, ids.S) >= 2, WAIT_MS, '途中送信の返答');
      await gates.open('held-bg');
      await ca.waitFor(e => e.type === 'turnEnd' && e.sessionId === ids.S, { ms: WAIT_MS, from });
      const loaded = await ca.cmd('loadSession', { sessionId: ids.S });
      assert.ok(loaded.messages.some(m => m.role === 'assistant' && String(m.text).includes('受け取った: steer-me')), '途中送信が偽の CLI に届いて返答になる');
      t.ok('held: 途中送信（control.steer）が保持役を通って偽の CLI に届く', true);
    }

    // 2. 途中で引き継ぐ。A で 3 つのターンを始める
    const markA = ca.mark();
    const scripts = {
      T: steps([{ tool: 'Grep', input: { pattern: 'a' }, result: 'r1', ms: 50 }, { tool: 'Read', input: { path: 'b' }, result: 'r2', ms: 6000 }, { text: 'final T' }]),
      Q: steps([{ tool: 'Bash', input: { command: 'x' }, result: 'ran', ms: 20, ask: true }, { text: 'final Q' }]),
      F: steps([{ tool: 'Wait', input: {}, result: 'w', ms: 800 }, { text: 'final F' }]),
    };
    for (const k of ['T', 'Q', 'F']) void ca.cmd('sendMessage', { sessionId: ids[k], messageId: `adopt-${k}-0001`, prompt: scripts[k] }).catch(() => {});
    await ca.waitFor(e => e.type === 'tool.start' && e.sessionId === ids.T && e.name === 'Read', { ms: WAIT_MS, from: markA });
    const askQ = await ca.waitFor(e => e.type === 'permission' && e.sessionId === ids.Q, { ms: WAIT_MS, from: markA });
    const rowsQ = await until(async () => { const rows = await inboxWaits(ca, ids.Q); return rows.length ? rows : null; }, WAIT_MS, 'A の通知の一覧のあなた待ち');
    const shapeQA = shapeOf(await ca.cmd('loadSession', { sessionId: ids.Q, live: true }));
    // F: A は偽の CLI の出力を読まなくする。CLI は 0.8 秒のツールの後に本文を出して終わる（A が締める前に終わっている）
    await until(async () => scene('pauseHeld', { sessionId: ids.F, paused: true }).then(() => true, () => false), 5000, 'F の held のターン');
    await sleep(2500);
    const cards = {};
    for (const k of ['T', 'Q', 'F']) cards[k] = (await scene('handOffHeld', { sessionId: ids[k] }).catch(e => { throw new Error(`${k}: ${e.message}
${a.tail(15)}`); })).card;
    assert.equal(cards.T.sessionId, ids.T);
    assert.ok(cards.T.presentKey && cards.T.connectionTokens.control);
    assert.deepEqual(cards.Q.waits, [askQ.id], 'Q: 札に出している承認の id');
    assert.deepEqual(cards.T.waits, [], 'T: 出している承認は無い');
    // 手を離した A は締めない（B が締める）
    await sleep(300);
    for (const k of ['T', 'Q', 'F']) assert.equal(ca.since(markA).filter(e => e.sessionId === ids[k] && ['turnEnd', 'turnResult'].includes(e.type)).length, 0, `A は ${k} を締めない`);
    ca.close(); ca = null;
    await a.stop(); a = null;

    // 保持役の子の状態（札・印・生死）。B より前にテストがつなぐ（親は 1 つ。B の hello で入れ替わる）
    {
      const probe = await connectHolder({ dataDir, root });
      const children = probe.welcome.children;
      for (const child of children) if (child.pid) childPids.add(child.pid);
      for (const k of ['T', 'Q', 'F']) {
        const child = children.find(c => c.label?.sessionId === ids[k]);
        assert.ok(child, `${k} の子が札つきで残る`);
        assert.equal(child.marks.turn, 1);
        assert.equal(child.label.presentKey, cards[k].presentKey);
        if (k === 'F') { assert.equal(child.alive, false, '偽の CLI は A が読まないうちに終わっている'); assert.ok(child.acked < child.seq, 'A は最後まで ack していない'); }
        else { assert.equal(child.alive, true, `${k} の偽の CLI は走り続けている`); assert.ok(child.acked >= 2, `${k}: A が処理した分（B は再生で作る）がある`); }
      }
      probe.close();
    }

    // B: 同じデータ置き場で起こし、保持役の子を付け直す
    b = await startServer({ env: { ...env, AGENT_HOST_ADOPT_HOLDER: '1' }, dataDir, timeoutMs: 30_000 });
    cb = await open({ port: b.port, token: b.token });
    const askB = await cb.waitFor(e => e.type === 'permission' && e.sessionId === ids.Q, { ms: WAIT_MS });
    await sleep(500);
    assert.equal(permissions(cb, ids.Q).length, 1, 'B に承認が 1 つだけ出る');
    assert.equal(askB.id, askQ.id, '承認の id は A と同じ（ツールの id から決まる）');
    {
      const rows = await inboxWaits(cb, ids.Q);
      assert.deepEqual(rows.map(r => [r.id, r.resolvedAt ?? null]), [[rowsQ[0].id, null]], '通知の一覧のあなた待ちは A の行のまま 1 つ（起動の後片付けが決着させない）');
      assert.deepEqual(shapeOf(await cb.cmd('loadSession', { sessionId: ids.Q, live: true })), shapeQA, 'B の実行中のスナップショットが A と同じ（承認・ツールと本文の出来事・人の発言）');
    }
    await cb.cmd('resolvePermission', { id: askB.id, allow: true });
    assert.equal((await until(async () => (await inboxWaits(cb, ids.Q)).find(r => r.outcome), WAIT_MS, 'あなた待ちの決着')).outcome, 'allowed', '答えると同じ行が allowed で決着');
    for (const k of ['T', 'Q', 'F']) await cb.waitFor(e => e.type === 'turnEnd' && e.sessionId === ids[k], { ms: WAIT_MS });
    await sleep(500);

    for (const k of ['T', 'Q', 'F']) {
      const id = ids[k];
      const ends = cb.events.filter(e => e.type === 'turnEnd' && e.sessionId === id);
      assert.equal(ends.length, 1, `${k}: turnEnd は 1 回`);
      assert.equal(ends[0].outcome, 'ok', `${k}: 最後まで流れて ok`);
      const meta = sessionMeta(id);
      assert.equal(meta.interrupted ?? null, null, `${k}: restart の中断にならない`);
      assert.equal(meta.turnStartedAt ?? null, null, `${k}: 走っている印は片付く`);
      assert.ok(meta.completedAt > before[k], `${k}: 完了時刻を書く`);
      assert.equal(usageOf(cards[k].presentKey).length, 1, `${k}: 使用量は presentKey で 1 件`);
      const loaded = await cb.cmd('loadSession', { sessionId: id });
      const finals = loaded.messages.filter(m => m.role === 'assistant' && m.text === `final ${k}`);
      assert.equal(finals.length, 1, `${k}: 最後の本文は履歴に 1 回`);
      assert.equal(loaded.messages.filter(m => m.role === 'user' && m.text === scripts[k]).length, 1, `${k}: 人の発言は 1 回`);
    }
    // ツールは、再生と続きの両方に出ても 1 回ずつ
    {
      const loaded = await cb.cmd('loadSession', { sessionId: ids.T });
      const calls = loaded.messages.flatMap(m => m.toolCalls ?? []);
      assert.deepEqual(calls.map(c => c.result.text), ['r1', 'r2'], 'T: ツールの結果が欠けず重ならない');
      const q = await cb.cmd('loadSession', { sessionId: ids.Q });
      assert.deepEqual(q.messages.flatMap(m => m.toolCalls ?? []).map(c => c.result.text), ['ran'], 'Q: 承認の後のツールの結果');
    }
    t.ok('ツールの実行中に手を離したターン: B が再生と続きで最後まで流し、turnEnd・completedAt・使用量が 1 回・ツールの結果と本文が 1 回ずつ', true);
    t.ok('承認待ちで手を離したターン: B に承認が A と同じ id で 1 つだけ出て、通知の一覧の行も 1 つのまま。実行中のスナップショットが A と同じ。答えると偽の CLI が続き、1 回だけ締まる', true);
    t.ok('終わった直後（偽の CLI が A の読むより先に終わった）: B が記録だけで締める。turnEnd・completedAt・使用量が 1 回', true);
    assert.ok(!b.tail(200).includes('[unhandledRejection]'), b.tail(20));
    assert.ok(b.tail(200).includes('ターンを付け直した'), b.tail(20));
    cb.close(); cb = null;
    await b.stop(); b = null;

    // 付け直した子は、終わりの記録を処理した後に保持役から捨てられている
    {
      const probe = await connectHolder({ dataDir, root });
      assert.deepEqual(probe.welcome.children.map(c => c.id), [], '終わった子の記録は捨てられている');
      probe.close();
    }

    // 3. 強制終了（handOff を経ない）。A2 は 4 つのターンを持ったまま SIGKILL。札はターンの始まりと札の中身が変わるたびに置き直されている
    {
      const names = ['K1', 'K2', 'K3', 'K4'];
      a = await startServer({ env, dataDir, timeoutMs: 30_000, entry: path.join(ROOT, 'tests', 'lib', 'adopt-server.mjs') });
      ca = await open({ port: a.port, token: a.token });
      const kid = {};
      for (const k of names) {
        const res = await ca.runTurn({ backend: 'fake', cwd: ROOT, prompt: `echo:${k}` }, { ms: WAIT_MS });
        assert.equal(res.outcome, 'ok');
        kid[k] = res.sessionId;
      }
      const usageBefore = Object.fromEntries(names.map(k => [k, usageOfSession(kid[k]).length]));
      const doneBefore = Object.fromEntries(names.map(k => [k, sessionMeta(kid[k])?.completedAt]));
      const kscripts = {
        K1: steps([{ tool: 'Bash', input: { command: 'k1' }, result: 'ran k1', ms: 20, ask: true }, { text: 'final K1' }]),
        K2: steps([{ tool: 'Grep', input: { pattern: 'k2' }, result: 'k2 r1', ms: 50 }, { tool: 'Read', input: { path: 'k2' }, result: 'k2 r2', ms: 4000 }, { text: 'final K2' }]),
        K3: 'held:bg 1 gate:crash-bg',
        K4: 'held:slow',
      };
      const markK = ca.mark();
      for (const k of names) void ca.cmd('sendMessage', { sessionId: kid[k], messageId: `crash-${k}-0001`, prompt: kscripts[k] }).catch(() => {});
      const askK1 = await ca.waitFor(e => e.type === 'permission' && e.sessionId === kid.K1, { ms: WAIT_MS, from: markK });
      await ca.waitFor(e => e.type === 'tool.start' && e.sessionId === kid.K2 && e.name === 'Read', { ms: WAIT_MS, from: markK });
      await ca.waitFor(e => e.type === 'phase' && e.sessionId === kid.K3 && e.state === 'waiting', { ms: WAIT_MS, from: markK });
      // K4: 中断が偽の CLI に届かないまま落ちる形（A2 の中断は子へ書かれず捨てられる）。中断の理由は update（既定の user と見分ける）
      await until(async () => scene('muteHeld', { sessionId: kid.K4, muted: true }).then(() => true, () => false), 5000, 'K4 の held のターン');
      await ca.cmd('abort', { sessionId: kid.K4, reason: 'update' });
      await ca.waitFor(e => e.type === 'activity' && e.sessionId === kid.K4 && e.state === 'stopping', { ms: WAIT_MS, from: markK });
      const rowsK1 = await until(async () => { const rows = await inboxWaits(ca, kid.K1); return rows.length ? rows : null; }, WAIT_MS, 'A2 の通知の一覧のあなた待ち');
      const shapeK1A = shapeOf(await ca.cmd('loadSession', { sessionId: kid.K1, live: true }));
      assert.equal(shapeK1A.permissions.length, 1);
      await sleep(600);   // 札の置き直し（touchCard は同じ tick にまとめて置く）が保持役へ届くまで
      ca.close(); ca = null;
      await a.kill(); a = null;

      // 保持役の子の札（A2 が置き直した分）: 手を離す口（handOffHeld）を通っていないのに、札と印がある
      {
        const probe = await connectHolder({ dataDir, root });
        for (const child of probe.welcome.children) if (child.pid) childPids.add(child.pid);
        for (const k of names) {
          const child = probe.welcome.children.find(c => c.label?.sessionId === kid[k]);
          assert.ok(child, `${k}: 強制終了でも札つきの子が残る`);
          assert.equal(child.marks.turn, 1);
          assert.equal(child.alive, true);
          if (k === 'K1') assert.deepEqual(child.label.waits, [askK1.id], 'K1: 札に出している承認の id');
          else assert.deepEqual(child.label.waits, [], `${k}: 出している承認は無い`);
          if (k === 'K4') assert.deepEqual([child.label.abort.stopping, child.label.abort.reason], [true, 'update'], 'K4: 札に中断の始まりと理由');
          else assert.equal(child.label.abort.stopping, false);
        }
        probe.close();
      }

      // B2: 固定のポートが 4 秒塞がっている（B の起動より長く。短いと、起動の間に空いて待たずに取れてしまう）。付け直すターンがあるので、空きポートへ移らず空くまで待つ
      const busy = await holdPort(4000);
      b = await startServer({ env: { ...env, AGENT_HOST_ADOPT_HOLDER: '1', AGENT_HOST_PORT: String(busy.port) }, dataDir, timeoutMs: 30_000 });
      assert.equal(b.port, busy.port, '付け直すターンがあるので、同じポートが空くまで待って取る');
      assert.ok(b.tail(200).includes('付け直すターンがあるので'), b.tail(20));
      cb = await open({ port: b.port, token: b.token });
      const askB1 = await cb.waitFor(e => e.type === 'permission' && e.sessionId === kid.K1, { ms: WAIT_MS });
      await sleep(500);
      assert.equal(askB1.id, askK1.id, 'K1: 強制終了しても承認の id は A2 と同じ');
      assert.equal(permissions(cb, kid.K1).length, 1, 'K1: B に承認が 1 つだけ');
      {
        const rows = await inboxWaits(cb, kid.K1);
        assert.deepEqual(rows.map(r => [r.id, r.resolvedAt ?? null]), [[rowsK1[0].id, null]], 'K1: 通知の一覧のあなた待ちは A2 の行のまま 1 つ（決着させない）');
        const shapeK1B = shapeOf(await cb.cmd('loadSession', { sessionId: kid.K1, live: true }));
        assert.deepEqual(shapeK1B, shapeK1A, 'K1: B の実行中のスナップショットが A2 と同じ（ツール・本文・承認・発言）');
      }
      await cb.cmd('resolvePermission', { id: askB1.id, allow: true });
      const settledRow = await until(async () => (await inboxWaits(cb, kid.K1)).find(r => r.outcome), WAIT_MS, 'あなた待ちの決着');
      assert.equal(settledRow.outcome, 'allowed', 'K1: 答えると同じ行が allowed で決着');
      // K3: 裏の作業の待ち。phase: waiting とサブエージェントが B の実行中のスナップショットに戻る。ゲートを開くと終わる
      {
        // phase と background は流れの出来事ではなく、走っているターンの状態（running の turns）
        const turnK3 = (await cb.cmd('running')).turns.find(x => x.sessionId === kid.K3);
        assert.equal(turnK3?.phase, 'waiting', 'K3: phase: waiting が戻る');
        assert.equal(turnK3?.background?.length, 1, 'K3: 裏の作業（background）が戻る');
        await gates.open('crash-bg');
      }
      for (const k of names) await cb.waitFor(e => e.type === 'turnEnd' && e.sessionId === kid[k], { ms: WAIT_MS });
      await sleep(500);
      for (const k of names) {
        const id = kid[k];
        const ends = cb.events.filter(e => e.type === 'turnEnd' && e.sessionId === id);
        assert.equal(ends.length, 1, `${k}: turnEnd は 1 回`);
        const meta = sessionMeta(id);
        assert.ok(meta.completedAt > doneBefore[k], `${k}: 完了時刻を書く`);
        assert.equal(meta.turnStartedAt ?? null, null, `${k}: 走っている印は片付く`);
        assert.equal(usageOfSession(id).length, usageBefore[k] + 1, `${k}: 使用量はこのターンの分が 1 件だけ`);
        if (k === 'K4') {
          assert.equal(ends[0].outcome, 'aborted', 'K4: B が中断を送り直して止まる');
          assert.equal(meta.interrupted?.reason, 'update', 'K4: 中断の理由は元のまま（update）');
        } else {
          assert.equal(ends[0].outcome, 'ok', `${k}: 最後まで流れて ok`);
          assert.equal(meta.interrupted ?? null, null, `${k}: restart の中断にならない`);
        }
      }
      {
        const loaded = await cb.cmd('loadSession', { sessionId: kid.K2 });
        assert.deepEqual(loaded.messages.flatMap(m => m.toolCalls ?? []).map(c => c.result.text), ['k2 r1', 'k2 r2'], 'K2: ツールの結果が欠けず重ならない');
        assert.equal(loaded.messages.filter(m => m.role === 'assistant' && m.text === 'final K2').length, 1);
        const k1 = await cb.cmd('loadSession', { sessionId: kid.K1 });
        assert.deepEqual(k1.messages.flatMap(m => m.toolCalls ?? []).map(c => c.result.text), ['ran k1'], 'K1: 承認の後のツールの結果');
      }
      assert.ok(!b.tail(200).includes('[unhandledRejection]'), b.tail(20));
      t.ok('強制終了（handOff を経ない）の後の付け直し: 札は置き直されていて、B が 4 つのターンを最後まで流す。turnEnd・completedAt・使用量が 1 回だけ', true);
      t.ok('承認待ちで強制終了: B に承認が A と同じ id で 1 つだけ出る。通知の一覧のあなた待ちは同じ行のまま 1 つで、答えるとその行が決着する。実行中のスナップショットが A と同じ', true);
      t.ok('裏の作業の待ち（phase: waiting）で強制終了: B で phase と background が戻り、ゲートを開くと終わる', true);
      t.ok('中断の最中で強制終了（A の中断が子に届かないまま）: B が中断を送り直し、中断の理由は元のまま。turnEnd・completedAt が 1 回', true);
      t.ok('付け直すターンがあるときは、固定のポートが塞がっていても空きポートへ移らず、空くまで待って同じポートを取る', true);
      cb.close(); cb = null;
      await b.stop(); b = null;
      await busy.release();
    }

    // 4. 準備中（バックエンドを呼ぶ前）の強制終了と、ポートが取れないままのとき。A3: 準備中の会話 P（外部の MCP が答えない）と、ツールの実行中の会話 R
    {
      const cwdP = path.join(scratch, 'prepare-cwd');
      await fs.mkdir(path.join(cwdP, '.git'), { recursive: true });
      // 答えない MCP（initialize に返事をしない）。A3 が落ちて stdin が閉じたら終わる
      await fs.writeFile(path.join(cwdP, 'stall.mjs'), "process.stdin.on('end', () => process.exit(0)); process.stdin.resume(); setInterval(() => {}, 1000);\n");
      await fs.writeFile(path.join(cwdP, '.mcp.json'), JSON.stringify({ mcpServers: { stall: { command: process.execPath, args: [path.join(cwdP, 'stall.mjs')] } } }));
      a = await startServer({ env, dataDir, timeoutMs: 30_000, entry: path.join(ROOT, 'tests', 'lib', 'adopt-server.mjs') });
      ca = await open({ port: a.port, token: a.token });
      const R = (await ca.runTurn({ backend: 'fake', cwd: ROOT, prompt: 'echo:R' }, { ms: WAIT_MS })).sessionId;
      const none = { sources: [], excludePaths: [] };
      await ca.cmd('setContextSettings', { cwd: cwdP, place: cwdP, kind: 'mcp', value: { owner: 'ply', user: none, directory: { sources: ['claude'], excludePaths: [] } } });
      const P = (await ca.cmd('newSession', { cwd: cwdP, backend: 'fake' })).sessionId;
      const markR = ca.mark();
      void ca.cmd('sendMessage', { sessionId: R, messageId: 'abandon-R-0001', prompt: steps([{ tool: 'Read', input: { path: 'r' }, result: 'r1', ms: 8000 }, { text: 'final R' }]) }).catch(() => {});
      void ca.cmd('sendMessage', { sessionId: P, messageId: 'prepare-P-0001', prompt: 'held:slow' }).catch(() => {});
      await ca.waitFor(e => e.type === 'tool.start' && e.sessionId === R && e.name === 'Read', { ms: WAIT_MS, from: markR });
      await ca.waitFor(e => e.type === 'activity' && e.sessionId === P && e.state === 'preparing', { ms: WAIT_MS, from: markR });
      assert.equal(await scene('handOffNow', { sessionId: P }), null, 'P: 準備中のターンは手を離せない（バックエンドを呼ぶ前）');
      assert.equal(sessionMeta(P).turnStartedAt > 0, true, 'P: 走っている印は立っている');
      await sleep(600);
      ca.close(); ca = null;
      await a.kill(); a = null;
      // B3: 固定のポートが付け直しの待ちの上限（1 秒）を過ぎても塞がったまま
      const busy = await holdPort(8000);
      b = await startServer({ env: { ...env, AGENT_HOST_ADOPT_HOLDER: '1', AGENT_HOST_PORT: String(busy.port), AGENT_HOST_ADOPT_PORT_WAIT_MS: '1000' }, dataDir, timeoutMs: 30_000 });
      assert.notEqual(b.port, busy.port, '上限を過ぎたら空きポートへ移る');
      assert.ok(b.tail(200).includes('付け直すターンは中断として残す'), b.tail(20));
      await until(() => sessionMeta(R)?.turnStartedAt == null && sessionMeta(R)?.interrupted, WAIT_MS, 'R の中断');
      assert.equal(sessionMeta(R).interrupted.reason, 'restart', 'R: 付け直しをあきらめたターンは restart の中断');
      assert.equal(sessionMeta(P).interrupted?.reason, 'restart', 'P: 準備中に落ちたターンは付け直さず restart の中断');
      assert.equal(sessionMeta(P).turnStartedAt ?? null, null);
      assert.ok(sessionMeta(R).completedAt > 0 && sessionMeta(P).completedAt > 0, 'どちらも完了時刻を書く');
      assert.ok(!b.tail(200).includes('[unhandledRejection]'), b.tail(20));
      t.ok('準備中（バックエンドを呼ぶ前）のターンは手を離さず（null）、強制終了すると付け直さず restart の中断', true);
      t.ok('固定のポートが付け直しの待ちの上限まで塞がっていたら、付け直しをあきらめて空きポートへ移り、そのターンは restart の中断', true);
      await b.stop(); b = null;
      await busy.release();
    }

    // 5. 途中送信と委譲の子（2b-7）。渡った合図を後から出す台本（steerConfirms）で、受理した途中送信・完了通知・追加指示が合図を待っている間に手を離す。
    //    N: 手を離す前半と後半の間に合図が出る（A が読み捨てて ack し、B の再生の側に来る）。人の途中送信が渡る・完了通知が渡る
    //    D: 同じ形で、人の途中送信が読まれずに捨てられる（dropped）
    //    L: 手を離した後、B で合図が出る（B の続きの側）。人の途中送信が渡る・完了通知が渡る
    //    C1・C2: 委譲の子（held:）のターン。追加指示（ply_task_send）が渡る・捨てられる。結果は B が依頼元へ 1 回だけ届ける
    {
      const ply = (toolName, args) => `ply:${JSON.stringify({ name: toolName, arguments: args })}`;
      const delegate = task => ply('ply_delegate', { kind: 'mechanical', backend: 'fake', task });
      const env6 = { ...env, AGENT_HOST_FAKE_STEER_CONFIRM_MS: '20' };
      a = await startServer({ env: env6, dataDir, timeoutMs: 30_000, entry: path.join(ROOT, 'tests', 'lib', 'adopt-server.mjs') });
      ca = await open({ port: a.port, token: a.token, autoAllow: true });
      const taskOf = async (client, parent) => (await client.cmd('agentTasks')).find(r => r.parentSessionId === parent) ?? null;
      const waitTask = (client, parent, check, label) => until(async () => { const r = await taskOf(client, parent); return r && check(r) ? r : null; }, WAIT_MS, label);
      const stateOf = async (client, task) => (await client.cmd('agentTaskInstructions', { taskId: task.taskId })).instructions.map(x => `${x.text}:${x.state}`).join();
      const outboxOf = (sessionId, messageId) => sessionMeta(sessionId)?.outbox?.find(m => m.id === messageId) ?? null;
      const runTurn = async prompt => (await ca.runTurn({ backend: 'fake', cwd: ROOT, prompt }, { ms: WAIT_MS })).sessionId;

      const P = { N: await runTurn(delegate('bg 1 gate:n-child HOLD_CONFIRM:n-notice')), L: await runTurn(delegate('bg 1 gate:l-child HOLD_CONFIRM:l-notice')),
        D: await runTurn('echo:D'), C1: await runTurn(delegate('held:bg 1 gate:c1-child')), C2: await runTurn(delegate('held:bg 1 gate:c2-child')) };
      const child = {
        N: await waitTask(ca, P.N, r => r.status === 'running', 'N の子'), L: await waitTask(ca, P.L, r => r.status === 'running', 'L の子'),
        C1: await waitTask(ca, P.C1, r => r.status === 'running', 'C1 の子'), C2: await waitTask(ca, P.C2, r => r.status === 'running', 'C2 の子'),
      };
      const mark6 = ca.mark();
      for (const k of ['N', 'L', 'D']) void ca.cmd('sendMessage', { sessionId: P[k], messageId: `${k.toLowerCase()}-turn-0001`, prompt: `held:bg 1 gate:${k.toLowerCase()}-parent` }).catch(() => {});
      for (const k of ['N', 'L', 'D']) await ca.waitFor(e => e.type === 'phase' && e.sessionId === P[k] && e.state === 'waiting', { ms: WAIT_MS, from: mark6 });
      // 子のターンは委譲の時点から走っている（phase は流れの出来事ではないので、running で見る）
      for (const k of ['C1', 'C2']) await until(async () => (await ca.cmd('running')).turns.find(x => x.sessionId === child[k].sessionId)?.phase === 'waiting', WAIT_MS, `${k} の子のターンが待ちに入る`);
      // 人の途中送信: 偽の CLI が受理して、ゲートが開くまで渡った合図を出さない（D は開いたら読まれずに捨てる）
      const human = { N: 'echo:HUMAN-N HOLD_CONFIRM:n-hold', L: 'echo:HUMAN-L HOLD_CONFIRM:l-hold', D: 'echo:HUMAN-D HOLD_CONFIRM:d-hold DROP_STEER' };
      for (const k of ['N', 'L', 'D']) {
        await ca.cmd('sendMessage', { sessionId: P[k], messageId: `${k.toLowerCase()}-human-0001`, prompt: human[k] });
        await ca.waitFor(e => e.type === 'userMessage' && e.messageId === `${k.toLowerCase()}-human-0001` && e.pending, { ms: WAIT_MS, from: mark6 });
        assert.equal(outboxOf(P[k], `${k.toLowerCase()}-human-0001`)?.status, 'sent', `${k}: 受理された途中送信は sent で、渡った合図を待つ`);
      }
      // 完了通知: 子が終わると、走っている依頼元のターンへ途中送信で渡る（受理されて、合図を待つ）
      await gates.open('n-child');
      await gates.open('l-child');
      for (const k of ['N', 'L']) await waitTask(ca, P[k], r => r.notification === 'sent', `${k} の完了通知が受理される`);
      // 追加指示: 子のターンへ途中送信で渡る（受理されて、合図を待つ = sending）
      const sendAdd = async (k, text) => {
        await ca.runTurn({ sessionId: P[k], prompt: ply('ply_task_send', { taskId: child[k].taskId, message: text }) }, { ms: WAIT_MS });
        await until(async () => (await stateOf(ca, child[k])).endsWith(':sending'), WAIT_MS, `${k}: 追加指示が渡った合図を待つ`);
      };
      await sendAdd('C1', 'echo:I1 HOLD_CONFIRM:c1-hold');
      await sendAdd('C2', 'echo:I2 HOLD_CONFIRM:c2-hold DROP_STEER');
      const usageBefore = Object.fromEntries([['N', P.N], ['L', P.L], ['D', P.D], ['C1', child.C1.sessionId], ['C2', child.C2.sessionId]].map(([k, id]) => [k, usageOfSession(id).length]));
      const doneBefore = Object.fromEntries(['N', 'L', 'D'].map(k => [k, sessionMeta(P[k]).completedAt]));

      // 手を離す。N・D は前半だけして、合図を出させてから後半（A は合図を読み捨てて ack する）。L・C1・C2 は合図の前に手を離す
      const cards6 = {};
      const sessionOf = { N: P.N, L: P.L, D: P.D, C1: child.C1.sessionId, C2: child.C2.sessionId };
      for (const k of ['N', 'D']) await scene('handOffTurnOnly', { sessionId: sessionOf[k] });
      for (const gate of ['n-hold', 'n-notice', 'd-hold']) await gates.open(gate);
      await sleep(1200);   // 偽の CLI が合図を出し、A が読み捨てて ack するまで（出し遅れても、B の続きの側で同じ結果になる）
      for (const k of ['N', 'D']) cards6[k] = (await scene('handOffDetach', { sessionId: sessionOf[k] })).card;
      for (const k of ['L', 'C1', 'C2']) cards6[k] = (await scene('handOffHeld', { sessionId: sessionOf[k] }).catch(e => { throw new Error(`${k}: ${e.message}
${a.tail(25)}`); })).card;
      const steerOf = (k, waiter) => Object.entries(cards6[k].steers).filter(([, entry]) => entry.waiters.includes(waiter));
      assert.deepEqual(steerOf('N', 'pendingSteers').map(([id]) => id), ['n-human-0001'], 'N: 札に受理した途中送信');
      assert.equal(steerOf('N', 'liveNotices').length, 1, 'N: 札に渡った合図を待つ完了通知');
      assert.deepEqual(steerOf('D', 'pendingSteers').map(([id]) => id), ['d-human-0001'], 'D: 札に受理した途中送信');
      assert.deepEqual(steerOf('L', 'pendingSteers').map(([id]) => id), ['l-human-0001'], 'L: 札に受理した途中送信');
      assert.equal(steerOf('L', 'liveNotices').length, 1, 'L: 札に渡った合図を待つ完了通知');
      for (const k of ['C1', 'C2']) {
        const [[itemId, entry]] = steerOf(k, 'liveInstructions');
        assert.ok(itemId.startsWith('task-send-'), `${k}: 札に渡った合図を待つ追加指示`);
        assert.deepEqual(entry.waiters, ['liveInstructions', 'agentTasks']);
        assert.equal(entry.taskId, child[k].taskId);
        assert.equal(cards6[k].input.taskId, child[k].taskId, `${k}: 札に委譲のタスクの id`);
      }
      assert.ok(JSON.stringify(cards6.N).length < 8000, '札は小さいまま');
      await sleep(300);
      for (const k of Object.keys(sessionOf)) assert.equal(ca.since(mark6).filter(e => e.sessionId === sessionOf[k] && ['turnEnd', 'turnResult'].includes(e.type)).length, 0, `A は ${k} を締めない`);
      assert.equal((await taskOf(ca, P.C1)).status, 'running', 'C1: 手を離した旧サーバーは子の結果を書かない');
      assert.equal((await taskOf(ca, P.C1)).notification, 'none');
      ca.close(); ca = null;
      await a.stop(); a = null;

      // B: 同じデータ置き場で起こし、保持役の子を付け直す。委譲の子のタスクは interrupted にならない
      b = await startServer({ env: { ...env6, AGENT_HOST_ADOPT_HOLDER: '1' }, dataDir, timeoutMs: 30_000 });
      cb = await open({ port: b.port, token: b.token, autoAllow: true });
      const turnsOf = async () => (await cb.cmd('running')).turns.map(x => x.sessionId);
      await until(async () => { const ids = await turnsOf(); return Object.values(sessionOf).every(id => ids.includes(id)); }, WAIT_MS, 'B が 5 つのターンを付け直す');
      for (const k of ['C1', 'C2']) {
        assert.equal((await taskOf(cb, P[k])).status, 'running', `${k}: 委譲の子のタスクは付け直しても running のまま（interrupted にしない）`);
        assert.ok((await stateOf(cb, child[k])).endsWith(':sending'), `${k}: 追加指示は渡った合図を待ったまま`);
      }
      const liveOf = async sessionId => (await cb.cmd('loadSession', { sessionId, live: true })).stream.events;
      const countOf = (events, type, messageId = null) => events.filter(e => e.type === type && (messageId == null || e.messageId === messageId)).length;
      // N: 合図は B の再生の側にあった（A が読み捨てて ack した）。再生は画面へ送らず、実行中のスナップショットだけに積む
      await until(async () => countOf(await liveOf(P.N), 'taskNotice') === 1, WAIT_MS, 'N: 再生で完了通知の一行が 1 回');
      assert.equal(countOf(await liveOf(P.N), 'userMessage.delivered', 'n-human-0001'), 1, 'N: 人の途中送信の渡った合図は 1 回');
      assert.ok(cb.events.filter(e => e.type === 'taskNotice' && e.sessionId === P.N).length <= 1, 'N: 再生の分は画面へ送らない（A が読む前に出ていれば続きの側で 1 回）');
      // D: 捨てられた合図は、札が控えていた途中送信だけ再生でも処理する。送信待ちへ戻る（保留）
      await until(() => outboxOf(P.D, 'd-human-0001')?.status === 'paused', WAIT_MS, 'D: 捨てられた途中送信が保留へ戻る');
      assert.equal(countOf(await liveOf(P.D), 'userMessage.dropped', 'd-human-0001'), 1, 'D: 捨てられた合図は 1 回');
      // L: 合図はまだ出ていない。出すと B の続きで渡る
      assert.equal(countOf(await liveOf(P.L), 'taskNotice'), 0);
      for (const gate of ['l-hold', 'l-notice', 'c1-hold', 'c2-hold']) await gates.open(gate);
      await cb.waitFor(e => e.type === 'taskNotice' && e.sessionId === P.L, { ms: WAIT_MS });
      await cb.waitFor(e => e.type === 'userMessage.delivered' && e.messageId === 'l-human-0001', { ms: WAIT_MS });
      assert.equal((await taskOf(cb, P.L)).notification, 'sent', 'L: 完了通知は sent のまま（送り直さない）');
      await until(async () => (await stateOf(cb, child.C1)) === 'echo:I1 HOLD_CONFIRM:c1-hold:delivered', WAIT_MS, 'C1: 追加指示が配送済みになる');
      await until(async () => (await stateOf(cb, child.C2)) === 'echo:I2 HOLD_CONFIRM:c2-hold DROP_STEER:queued', WAIT_MS, 'C2: 捨てられた追加指示が待機へ戻る');
      // 終わらせる: 子と依頼元のターン
      for (const gate of ['c1-child', 'c2-child', 'n-parent', 'l-parent', 'd-parent']) await gates.open(gate);
      for (const id of Object.values(sessionOf)) await cb.waitFor(e => e.type === 'turnEnd' && e.sessionId === id, { ms: WAIT_MS });
      const done1 = await waitTask(cb, P.C1, r => r.status === 'completed' && r.notification === 'sent', 'C1 が完了し、通知が依頼元へ届く');
      const done2 = await waitTask(cb, P.C2, r => r.status === 'completed' && r.notification === 'sent', 'C2 が完了し、通知が依頼元へ届く');
      await sleep(800);

      for (const k of ['N', 'L', 'D', 'C1', 'C2']) {
        const id = sessionOf[k];
        const ends = cb.events.filter(e => e.type === 'turnEnd' && e.sessionId === id);
        assert.equal(ends.length, k === 'C2' ? 2 : 1, `${k}: turnEnd は付け直したターンの 1 回（C2 は捨てられた指示の次のターンの分が加わる）`);
        assert.equal(ends[0].outcome, 'ok', `${k}: 最後まで流れて ok`);
        const meta = sessionMeta(id);
        assert.equal(meta.interrupted ?? null, null, `${k}: restart の中断にならない`);
        assert.equal(meta.turnStartedAt ?? null, null, `${k}: 走っている印は片付く`);
        assert.equal(usageOfSession(id).length, usageBefore[k] + (k === 'C2' ? 2 : 1), `${k}: 使用量はこのターンの分が 1 件だけ（C2 は次のターンの分が加わる）`);
        if (doneBefore[k]) assert.ok(meta.completedAt > doneBefore[k], `${k}: 完了時刻を書く`);
      }
      // 人の途中送信: 渡った合図は 1 回、返答は 1 回。N（再生の側）も L（続きの側）も同じ
      for (const k of ['N', 'L']) {
        const loaded = await cb.cmd('loadSession', { sessionId: P[k] });
        const replies = loaded.messages.filter(m => m.role === 'assistant' && String(m.text).includes(`受け取った: ${human[k]}`));
        assert.equal(replies.length, 1, `${k}: 人の途中送信への返答は 1 回`);
        assert.equal(outboxOf(P[k], `${k.toLowerCase()}-human-0001`)?.status, 'sent', `${k}: 送信待ちの項目は sent のまま`);
        // 完了通知: 渡った通知への返答も 1 回で、新しいターンで送り直さない
        assert.equal(loaded.messages.filter(m => m.role === 'assistant' && String(m.text).includes('受け取った:') && String(m.text).includes(child[k].taskId)).length, 1, `${k}: 完了通知は 1 回だけ届く`);
        assert.equal((await taskOf(cb, P[k])).notification, 'sent');
      }
      assert.equal(cb.events.filter(e => e.type === 'taskNotice' && e.sessionId === P.L).length, 1, 'L: 完了通知の一行は 1 回');
      assert.equal(cb.events.filter(e => e.type === 'userMessage.delivered' && e.messageId === 'l-human-0001').length, 1, 'L: 渡った合図は 1 回');
      {
        const loaded = await cb.cmd('loadSession', { sessionId: P.D });
        assert.equal(loaded.messages.filter(m => String(m.text).includes('HUMAN-D')).filter(m => m.role === 'assistant').length, 0, 'D: 捨てられた途中送信には返答しない');
        assert.equal(outboxOf(P.D, 'd-human-0001')?.status, 'paused', 'D: 捨てられた途中送信は保留のまま 1 つ');
      }
      // 委譲の子: 結果は B が確定して依頼元へ 1 回だけ届ける
      {
        assert.equal(done1.error ?? null, null);
        assert.ok(done1.result.includes('が終わった'), `C1: 子の最後の返答が結果になる（${done1.result}）`);
        assert.equal(await stateOf(cb, child.C1), 'echo:I1 HOLD_CONFIRM:c1-hold:delivered', 'C1: 追加指示は配送済み 1 回');
        const loaded = await cb.cmd('loadSession', { sessionId: child.C1.sessionId });
        assert.equal(loaded.messages.filter(m => m.role === 'assistant' && String(m.text).includes('受け取った: echo:I1')).length, 1, 'C1: 追加指示への返答は子の履歴に 1 回');
        assert.equal(cb.events.filter(e => e.type === 'taskNotice' && e.sessionId === P.C1).length, 1, 'C1: 依頼元へ完了通知が 1 回');
        assert.equal(done2.result, 'I2 HOLD_CONFIRM:c2-hold DROP_STEER', 'C2: 捨てられた追加指示は次のターンで 1 回だけ配送され、結果になる');
        assert.equal(await stateOf(cb, child.C2), 'echo:I2 HOLD_CONFIRM:c2-hold DROP_STEER:delivered', 'C2: 追加指示は配送済み 1 回');
        assert.equal(cb.events.filter(e => e.type === 'taskNotice' && e.sessionId === P.C2).length, 1, 'C2: 依頼元へ完了通知が 1 回');
        const c2 = await cb.cmd('loadSession', { sessionId: child.C2.sessionId });
        assert.equal(c2.messages.filter(m => m.role === 'user' && m.text === 'echo:I2 HOLD_CONFIRM:c2-hold DROP_STEER').length, 1, 'C2: 追加指示は子の履歴に 1 回');
      }
      assert.ok(!b.tail(300).includes('[unhandledRejection]'), b.tail(20));
      t.ok('渡った合図の前に手を離した（人の途中送信・完了通知）: 合図が B の続きで届き、渡った合図・完了通知の一行・返答が 1 回ずつ。完了通知は送り直さない', true);
      t.ok('手を離した後に A が読み捨てて ack した合図（B の再生の側）: 札が控えていた途中送信・完了通知は再生でも処理される（渡った合図・完了通知の一行は 1 回、捨てられた途中送信は保留へ戻る）', true);
      t.ok('委譲の子のターン: B が付け直し、タスクは interrupted にならず、結果の確定を引き継ぐ。追加指示の渡った合図・捨てられた合図を処理し、完了通知は依頼元へ 1 回だけ届く', true);
      cb.close(); cb = null;
      await b.stop(); b = null;
    }

    // 6. 後片付け: 付け直しをあきらめた子など、残った子の記録を含めて保持役を終わらせる
    {
      const probe = await connectHolder({ dataDir, root });
      for (const child of probe.welcome.children) if (child.pid) childPids.add(child.pid);
      probe.shutdown();
      probe.close();
    }
    await until(() => !alive(holderPid), 10_000, '保持役が終わる');
    for (const pid of childPids) await until(() => !alive(pid), 10_000, `偽の CLI（${pid}）が終わる`);
    holderPid = null;
    t.ok('後片付け: 保持役・偽の CLI が残らない（サーバーは stop・kill で終わる）', true);
  } finally {
    ca?.close();
    cb?.close();
    await a?.stop();
    await b?.stop();
    if (holderPid && alive(holderPid)) {
      const probe = await connectHolder({ dataDir, root }).catch(() => null);
      probe?.shutdown();
      probe?.close();
      await until(() => !alive(holderPid), 10_000, '保持役が終わる').catch(() => { try { process.kill(holderPid); } catch { /* 既に終わっている */ } });
    }
    await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}
