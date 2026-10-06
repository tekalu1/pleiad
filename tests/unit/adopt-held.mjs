// 段階 2 の 2b-5: 保持役の子に載せた台本（fake の held:）を、サーバーの入れ替えをまたいで付け直す
// （docs/zero-downtime-update/stage2-server-state.md §6・§6.1。保持役は core/holder/、偽の CLI は core/backends/fake-agent.mjs）。
//   1. 入れ替えなしの held:（旧サーバー A だけ）: 承認待ち → 答えて続く・途中送信が偽の CLI へ届く・終わった子は保持役から捨てる
//   2. 途中で引き継ぐ: A でターンを始め、途中で A が手を離し（handOffTurn → 保持役に札を置いて detach。tests/lib/adopt-server.mjs）、
//      A を止めて、同じデータ置き場で B を起こして付け直す（AGENT_HOST_ADOPT_HOLDER=1）。ターンが最後まで流れ、turnEnd・completedAt・使用量が 1 回だけ。
//      時点: ツールの実行中・承認待ち・終わった直後（偽の CLI は A が読まないうちに終わっている）。残りの時点（準備中・渡った合図の前・裏の作業の待ち・
//      委譲の子・中断の最中）は 2b-6・2b-7（stage2-server-state.md §6.1）
//   3. 後片付け: 保持役・偽の CLI・サーバーが残らない（保持役は detached なので、終わりに shutdown して pid が消えるまで見る）
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
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

export default async function (t) {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-adopt-held-'));
  const dataDir = path.join(scratch, 'data');
  const root = path.join(scratch, 'runtime');
  const scenesDir = path.join(scratch, 'scenes');
  await fs.mkdir(scenesDir);
  const gates = await createFakeGates(scratch);
  const sessionMeta = id => readSessions(dataDir)[id] ?? null;
  const usageOf = key => (readUsage(dataDir)?.records ?? []).filter(r => r.id === key);
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
    for (const k of ['T', 'Q', 'F']) void ca.cmd('runTurn', { sessionId: ids[k], prompt: scripts[k] }).catch(() => {});
    await ca.waitFor(e => e.type === 'tool.start' && e.sessionId === ids.T && e.name === 'Read', { ms: WAIT_MS, from: markA });
    const askQ = await ca.waitFor(e => e.type === 'permission' && e.sessionId === ids.Q, { ms: WAIT_MS, from: markA });
    // F: A は偽の CLI の出力を読まなくする。CLI は 0.8 秒のツールの後に本文を出して終わる（A が締める前に終わっている）
    await until(async () => scene('pauseHeld', { sessionId: ids.F, paused: true }).then(() => true, () => false), 5000, 'F の held のターン');
    await sleep(2500);
    const cards = {};
    for (const k of ['T', 'Q', 'F']) cards[k] = (await scene('handOffHeld', { sessionId: ids[k] }).catch(e => { throw new Error(`${k}: ${e.message}
${a.tail(15)}`); })).card;
    assert.equal(cards.T.sessionId, ids.T);
    assert.ok(cards.T.presentKey && cards.T.connectionTokens.control);
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
    await cb.cmd('resolvePermission', { id: askB.id, allow: true });
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
    t.ok('承認待ちで手を離したターン: B に承認が 1 つだけ出て、答えると偽の CLI が続き、1 回だけ締まる', true);
    t.ok('終わった直後（偽の CLI が A の読むより先に終わった）: B が記録だけで締める。turnEnd・completedAt・使用量が 1 回', true);
    assert.ok(!b.tail(200).includes('[unhandledRejection]'), b.tail(20));
    assert.ok(b.tail(200).includes('ターンを付け直した'), b.tail(20));
    cb.close(); cb = null;
    await b.stop(); b = null;

    // 3. 付け直した子は、終わりの記録を処理した後に保持役から捨てられている
    {
      const probe = await connectHolder({ dataDir, root });
      assert.deepEqual(probe.welcome.children.map(c => c.id), [], '終わった子の記録は捨てられている');
      probe.shutdown();
      probe.close();
    }
    await until(() => !alive(holderPid), 10_000, '保持役が終わる');
    for (const pid of childPids) await until(() => !alive(pid), 10_000, `偽の CLI（${pid}）が終わる`);
    holderPid = null;
    t.ok('後片付け: 保持役・偽の CLI が残らない（サーバーは stop で終わる）', true);
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
