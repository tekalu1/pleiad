// 段階 2 の 2c: 保持役に載せた Claude の CLI（stream-json を話す偽物 tests/lib/fake-claude-cli.mjs）を、サーバーの入れ替えをまたいで付け直す
// （docs/zero-downtime-update/plan.md「2c」。載せ方は core/backends/claude-held.mjs、付け直しは claude.mjs の adoptTurn）。
//   1. 載せるかの切り替え: 既定（AGENT_HOST_CLAUDE_HOLDER 無し）と、付け直しを確かめていない CLI の版では、CLI は保持役の子にならない（今の流れ）。
//      on で確かめた版なら保持役の子になり、入れ替えなしの承認も通る
//   2. 途中で引き継ぐ（2d の形: handOffTurn → 札を子に置いて detach → query を閉じる。tests/lib/adopt-server.mjs）。A を止め、同じデータ置き場で B が付け直す。
//      時点: 承認待ち（B に A と同じ id の承認が 1 つだけ出て、答えると続く）・ツールの実行中に受理した途中送信（B で折り込まれ、渡った合図が 1 回）・
//      裏の作業の待ち（phase: waiting が戻り、ゲートを開くと終わる）・hooks（PreCompact）のコールバックの答えが CLI に届かないまま（CLI が取り消して圧縮を続ける）・
//      in-process の MCP（host）の mcp_message の答えが届かないまま（B の SDK が答えて続く）。どれも turnEnd・completedAt・使用量（presentKey の 1 件。
//      費用の基準は札の値で差し引く）が 1 回だけ、restart の中断にならない
//   3. 強制終了（2e の形。手を離す口を経ない）: 承認待ちのまま A を SIGKILL しても、札の置き直し（touchCard）で B が付け直す
//   4. 後片付け: 保持役・偽の CLI が残らない
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startServer, ROOT } from '../lib/server.mjs';
import { open, sleep } from '../lib/ws-client.mjs';
import { readSessions, readUsage } from '../lib/data-store.mjs';
import { createFakeGates } from '../lib/fake-gate.mjs';
import { installFakeClaude } from '../lib/fake-claude.mjs';
import { ensureHolder, connectHolder } from '../../core/holder/client.mjs';

export const name = 'adopt-claude';
export const title = '付け直し: 保持役に載せた Claude の CLI（偽物）を、サーバーの入れ替えをまたいで途中から引き継ぐ';

const WAIT_MS = 20_000;
const script = steps => `script:${JSON.stringify({ steps })}`;
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
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-adopt-claude-'));
  const dataDir = path.join(scratch, 'data');
  const root = path.join(scratch, 'runtime');
  const scenesDir = path.join(scratch, 'scenes');
  const work = path.join(scratch, 'work');
  const cliLog = path.join(scratch, 'cli.log');
  await Promise.all([scenesDir, work].map(dir => fs.mkdir(dir, { recursive: true })));
  const gates = await createFakeGates(scratch);
  const fake = await installFakeClaude(path.join(scratch, 'cli'));
  const sessionMeta = id => readSessions(dataDir)[id] ?? null;
  const usageOf = key => (readUsage(dataDir)?.records ?? []).filter(r => r.id === key);
  // 偽の CLI の起動の記録（"<pid> start <会話> resume=… ppid=<親>"）。保持役の子かを親の pid で見る
  const starts = async () => (await fs.readFile(cliLog, 'utf8').catch(() => '')).split('\n')
    .map(line => /^\S+ (\d+) start (\S+) resume=\S+ ppid=(\d+)/.exec(line)).filter(Boolean).map(m => ({ pid: Number(m[1]), session: m[2], ppid: Number(m[3]) }));
  const base = { AGENT_HOST_BACKENDS: 'claude', ...fake.env, CLAUDE_CONFIG_DIR: path.join(scratch, 'claude'), FAKE_CLAUDE_LOG: cliLog, ...gates.env };
  const env = { ...base, AGENT_HOST_CLAUDE_HOLDER: 'on', AGENT_HOST_RUNTIME_ROOT: root, ADOPT_SCENES_DIR: scenesDir };
  let a = null, b = null, ca = null, cb = null, holderPid = null;
  const childPids = new Set();
  try {
    const found = await ensureHolder({ dataDir, root, mode: 'detached', idleMs: 20_000, timeoutMs: 20_000 });
    holderPid = found.pid;
    found.client.close();

    // 1. 切り替え: 既定と、確かめていない版は保持役に載せない
    for (const [label, extra] of [['既定（AGENT_HOST_CLAUDE_HOLDER 無し）', { AGENT_HOST_RUNTIME_ROOT: root }], ['確かめていない版（2.1.290）', { ...env, FAKE_CLAUDE_VERSION: '2.1.290' }]]) {
      const s = await startServer({ env: { ...base, ...extra }, dataDir, timeoutMs: 30_000 });
      const c = await open({ port: s.port, token: s.token });
      try {
        const res = await c.runTurn({ backend: 'claude', cwd: work, prompt: 'plain' }, { ms: WAIT_MS });
        assert.equal(res.outcome, 'ok', `${label}: ${s.tail(10)}`);
        const mine = (await starts()).filter(x => x.session === sessionMeta(res.sessionId)?.nativeId || x.session === res.sessionId);
        assert.ok(mine.length && mine.every(x => x.ppid !== holderPid), `${label}: CLI は保持役の子にならない`);
      } finally { c.close(); await s.stop(); }
    }
    t.ok('切り替え: 既定と、付け直しを確かめていない CLI の版では保持役に載せない（今の流れ）', true);

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
    const ids = {};
    for (const k of ['P', 'Q', 'S', 'G', 'H', 'M']) {
      const res = await ca.runTurn({ backend: 'claude', cwd: work, prompt: `hello ${k}` }, { ms: WAIT_MS });
      assert.equal(res.outcome, 'ok', a.tail(10));
      ids[k] = res.sessionId;
    }
    const nativeOf = k => sessionMeta(ids[k])?.nativeId ?? ids[k];

    // 入れ替えなし: 保持役の子の CLI で承認待ち → 答えると続く
    {
      const from = ca.mark();
      void ca.cmd('runTurn', { sessionId: ids.P, prompt: script([{ tool: 'Bash', input: { command: 'p' }, result: 'ran p', ask: true }, { text: 'final P' }]) }).catch(() => {});
      const ask = await ca.waitFor(e => e.type === 'permission' && e.sessionId === ids.P, { ms: WAIT_MS, from });
      await ca.cmd('resolvePermission', { id: ask.id, allow: true });
      const end = await ca.waitFor(e => e.type === 'turnEnd' && e.sessionId === ids.P, { ms: WAIT_MS, from });
      assert.equal(end.outcome, 'ok');
      const mine = (await starts()).filter(x => x.session === nativeOf('P'));
      assert.ok(mine.length >= 2 && mine.every(x => x.ppid === holderPid), 'on: CLI は保持役の子として起きる');
      const loaded = await ca.cmd('loadSession', { sessionId: ids.P });
      assert.equal(loaded.messages.filter(m => m.role === 'assistant' && m.text === 'final P').length, 1);
      t.ok('on（確かめた版）: CLI は保持役の子として起き、承認待ち → 答えると続く', true);
    }

    // 2. 途中で引き継ぐ
    const before = Object.fromEntries(Object.entries(ids).map(([k, id]) => [k, sessionMeta(id)?.completedAt]));
    const markA = ca.mark();
    const scripts = {
      Q: script([{ tool: 'Bash', input: { command: 'q' }, result: 'ran q', ask: true }, { text: 'final Q' }]),
      S: script([{ tool: 'Read', input: { file_path: 's' }, result: 'read s', gate: 's-tool' }, { text: 'final S' }]),
      G: script([{ bg: { gate: 'g-bg' } }, { text: 'final G' }]),
      H: script([{ tool: 'Read', input: { file_path: 'h' }, result: 'pre h', gate: 'h-pre' }, { compact: true }, { text: 'final H' }]),
      M: script([{ tool: 'Read', input: { file_path: 'm' }, result: 'pre m', gate: 'm-pre' }, { mcp: { server: 'host', tool: 'set_status', arguments: { status: 'mcp-ok' } } }, { text: 'final M' }]),
    };
    for (const k of Object.keys(scripts)) void ca.cmd('sendMessage', { sessionId: ids[k], messageId: `adopt-${k}-0001`, prompt: scripts[k] }).catch(() => {});
    const askQ = await ca.waitFor(e => e.type === 'permission' && e.sessionId === ids.Q, { ms: WAIT_MS, from: markA });
    await ca.waitFor(e => e.type === 'tool.start' && e.sessionId === ids.S, { ms: WAIT_MS, from: markA });
    await ca.cmd('sendMessage', { sessionId: ids.S, messageId: 's-steer-0001', prompt: 'steer-S' });
    await ca.waitFor(e => e.type === 'userMessage' && e.messageId === 's-steer-0001' && e.pending, { ms: WAIT_MS, from: markA });
    await ca.waitFor(e => e.type === 'phase' && e.sessionId === ids.G && e.state === 'waiting', { ms: WAIT_MS, from: markA });
    // H・M: 答えが CLI に届かないようにしてから、hooks のコールバック・MCP の呼び出しを起こす（A の SDK は処理して答えるが、捨てられる）
    for (const k of ['H', 'M']) {
      await ca.waitFor(e => e.type === 'tool.start' && e.sessionId === ids[k], { ms: WAIT_MS, from: markA });
      await scene('muteClaude', { sessionId: ids[k], muted: true });
      await gates.open(`${k.toLowerCase()}-pre`);
    }
    await ca.waitFor(e => e.type === 'compaction' && e.phase === 'start' && e.sessionId === ids.H, { ms: WAIT_MS, from: markA });
    await ca.waitFor(e => e.type === 'tool.start' && e.sessionId === ids.M && e.name === 'mcp__host__set_status', { ms: WAIT_MS, from: markA });
    await sleep(800);   // A の SDK が依頼を処理して（捨てられる）答えを書くまで・札の置き直しが届くまで
    const cards = {};
    for (const k of Object.keys(scripts)) cards[k] = (await scene('handOffClaude', { sessionId: ids[k] }).catch(e => { throw new Error(`${k}: ${e.message}\n${a.tail(15)}`); })).card;
    for (const k of Object.keys(scripts)) {
      assert.equal(cards[k].backendCard?.held, true, `${k}: 札に Claude の欄`);
      assert.ok(cards[k].backendCard.costBase?.modelUsage, `${k}: 札に費用の基準（前のターンの cost-state）`);
    }
    assert.deepEqual(cards.Q.waits, [askQ.id], 'Q: 札に出している承認の id');
    assert.deepEqual(cards.S.backendCard.steers.map(x => [x.id, typeof x.uuid, typeof x.hash]), [['s-steer-0001', 'string', 'string']], 'S: 札に途中送信の控え（uuid とハッシュ。本文は入れない）');
    assert.ok(!JSON.stringify(cards.S).includes('steer-S'), 'S: 途中送信の本文は札に無い');
    await sleep(300);
    for (const k of Object.keys(scripts)) assert.equal(ca.since(markA).filter(e => e.sessionId === ids[k] && ['turnEnd', 'turnResult'].includes(e.type)).length, 0, `A は ${k} を締めない`);
    ca.close(); ca = null;
    await a.stop(); a = null;

    // 保持役の子: 札つきで走り続けている（B より前にテストがつなぐ。親は 1 つ）
    {
      const probe = await connectHolder({ dataDir, root });
      for (const k of Object.keys(scripts)) {
        const child = probe.welcome.children.find(c => c.label?.sessionId === ids[k]);
        assert.ok(child, `${k}: 札つきの子が残る`);
        assert.equal(child.alive, true, `${k}: CLI は走り続けている`);
        assert.equal(child.policy, 'claude-control');
        childPids.add(child.pid);
      }
      assert.ok(probe.welcome.children.find(c => c.label?.sessionId === ids.M).pendingRequests.some(p => p.subtype === 'mcp_message'), 'M: 答えの届いていない mcp_message が控えにある');
      probe.close();
    }

    b = await startServer({ env: { ...env, AGENT_HOST_ADOPT_HOLDER: '1' }, dataDir, timeoutMs: 30_000 });
    cb = await open({ port: b.port, token: b.token });
    const askB = await cb.waitFor(e => e.type === 'permission' && e.sessionId === ids.Q, { ms: WAIT_MS });
    await sleep(500);
    assert.equal(cb.events.filter(e => e.type === 'permission' && e.sessionId === ids.Q).length, 1, 'Q: B に承認が 1 つだけ（pending_permission_requests と記録の続きが 1 回に畳まれる）');
    assert.equal(askB.id, askQ.id, 'Q: 承認の id は A と同じ');
    {
      const turnG = (await cb.cmd('running')).turns.find(x => x.sessionId === ids.G);
      assert.equal(turnG?.phase, 'waiting', 'G: phase: waiting が戻る');
      assert.equal(turnG?.background?.length, 1, 'G: 裏の作業が戻る');
    }
    await cb.cmd('resolvePermission', { id: askB.id, allow: true });
    await gates.open('s-tool');
    await cb.waitFor(e => e.type === 'userMessage.delivered' && e.messageId === 's-steer-0001', { ms: WAIT_MS });
    await gates.open('g-bg');
    for (const k of Object.keys(scripts)) await cb.waitFor(e => e.type === 'turnEnd' && e.sessionId === ids[k], { ms: WAIT_MS }).catch(e => { throw new Error(`${k}: ${e.message}\n${b.tail(20)}`); });
    await sleep(500);
    for (const k of Object.keys(scripts)) {
      const id = ids[k];
      const ends = cb.events.filter(e => e.type === 'turnEnd' && e.sessionId === id);
      assert.equal(ends.length, 1, `${k}: turnEnd は 1 回`);
      assert.equal(ends[0].outcome, 'ok', `${k}: 最後まで流れて ok`);
      const meta = sessionMeta(id);
      assert.equal(meta.interrupted ?? null, null, `${k}: restart の中断にならない`);
      assert.equal(meta.turnStartedAt ?? null, null, `${k}: 走っている印は片付く`);
      assert.ok(meta.completedAt > before[k], `${k}: 完了時刻を書く`);
      const usage = usageOf(cards[k].presentKey);
      assert.equal(usage.length, 1, `${k}: 使用量は presentKey で 1 件`);
      // 偽の CLI は内部ターンごとに 0.001 USD（G は裏の作業の後の再開でもう 1 回）。札の基準で差し引くので、前のターンの分は入らない
      assert.equal(usage[0].costUsd, k === 'G' ? 0.002 : 0.001, `${k}: 使用量はこのターンの分（${usage[0].costUsd}）`);
      const loaded = await cb.cmd('loadSession', { sessionId: id });
      const finals = loaded.messages.filter(m => m.role === 'assistant' && String(m.text).startsWith(`final ${k}`));
      assert.equal(finals.length, 1, `${k}: 最後の本文は履歴に 1 回`);
      if (k === 'S') assert.ok(finals[0].text.includes('受け取った: steer-S'), 'S: 途中送信が折り込まれて答えに入る');
    }
    assert.equal(cb.events.filter(e => e.type === 'userMessage.delivered' && e.messageId === 's-steer-0001').length, 1, 'S: 渡った合図は 1 回');
    assert.ok(cb.events.some(e => e.type === 'compaction' && e.phase === 'complete' && e.sessionId === ids.H), 'H: 取り消された PreCompact の後も圧縮が続き、B で終わる');
    {
      const m = await cb.cmd('loadSession', { sessionId: ids.M });
      const call = m.messages.flatMap(x => x.toolCalls ?? []).find(c => c.name === 'mcp__host__set_status');
      assert.ok(call && !call.result.isError && !String(call.result.text).startsWith('mcp error'), `M: B の SDK が mcp_message に答えて続く（${call?.result?.text}）`);
      const q = await cb.cmd('loadSession', { sessionId: ids.Q });
      assert.deepEqual(q.messages.flatMap(x => x.toolCalls ?? []).map(c => c.result.text), ['ran q'], 'Q: 承認の後のツールの結果が 1 回');
    }
    {
      // 偽の CLI の側から見た付け直し: 2 回目の initialize で承認待ちを送り直し（Q）、答えの届かなかった hooks のコールバックを取り消した（H）
      const log = await fs.readFile(cliLog, 'utf8');
      const pidOf = k => starts().then(list => list.filter(x => x.session === nativeOf(k)).at(-1)?.pid);
      const linesOf = async k => { const pid = await pidOf(k); return log.split('\n').filter(line => line.split(' ')[1] === String(pid)); };
      assert.ok((await linesOf('Q')).some(line => line.includes('initialize #2 pending=1')), 'Q: CLI は 2 回目の initialize で承認待ちを 1 つ送り直した');
      assert.ok((await linesOf('H')).some(line => line.includes('hook PreCompact cancelled')), 'H: CLI は答えの届かない PreCompact を取り消した');
      for (const k of Object.keys(scripts)) assert.ok((await linesOf(k)).some(line => line.includes('initialize #2')), `${k}: 同じ CLI に 2 回目の initialize が届いた（query の作り直し）`);
    }
    assert.ok(!b.tail(200).includes('[unhandledRejection]'), b.tail(20));
    assert.ok(b.tail(200).includes('ターンを付け直した'), b.tail(20));
    t.ok('承認待ち: B に A と同じ id の承認が 1 つだけ出て、答えると続き、1 回だけ締まる', true);
    t.ok('途中送信（受理済み・折り込み前）: 札の控え（uuid）で B が渡った合図を 1 回出し、答えに入る', true);
    t.ok('裏の作業の待ち・hooks（PreCompact）の答えが届かない・mcp_message の答えが届かない: B で続いて 1 回だけ締まる。turnEnd・completedAt・使用量（札の費用の基準）が 1 回', true);
    cb.close(); cb = null;
    await b.stop(); b = null;
    {
      const probe = await connectHolder({ dataDir, root });
      assert.deepEqual(probe.welcome.children.map(c => c.id), [], '終わった子の記録は捨てられている');
      probe.close();
    }

    // 3. 強制終了: 承認待ちのまま A2 を落とす。札は子を起こした直後と中身が変わるたびに置き直されている
    {
      a = await startServer({ env, dataDir, timeoutMs: 30_000, entry: path.join(ROOT, 'tests', 'lib', 'adopt-server.mjs') });
      ca = await open({ port: a.port, token: a.token });
      const markK = ca.mark();
      void ca.cmd('sendMessage', { sessionId: ids.Q, messageId: 'crash-Q-0001', prompt: script([{ tool: 'Bash', input: { command: 'k' }, result: 'ran k', ask: true }, { text: 'final K' }]) }).catch(() => {});
      const askK = await ca.waitFor(e => e.type === 'permission' && e.sessionId === ids.Q, { ms: WAIT_MS, from: markK });
      const doneBefore = sessionMeta(ids.Q).completedAt;
      await sleep(600);
      ca.close(); ca = null;
      await a.kill(); a = null;
      b = await startServer({ env: { ...env, AGENT_HOST_ADOPT_HOLDER: '1' }, dataDir, timeoutMs: 30_000 });
      cb = await open({ port: b.port, token: b.token });
      const askB2 = await cb.waitFor(e => e.type === 'permission' && e.sessionId === ids.Q, { ms: WAIT_MS });
      assert.equal(askB2.id, askK.id, '強制終了しても承認の id は A2 と同じ');
      await cb.cmd('resolvePermission', { id: askB2.id, allow: true });
      const end = await cb.waitFor(e => e.type === 'turnEnd' && e.sessionId === ids.Q, { ms: WAIT_MS });
      await sleep(300);
      assert.equal(end.outcome, 'ok');
      assert.equal(cb.events.filter(e => e.type === 'turnEnd' && e.sessionId === ids.Q).length, 1);
      assert.ok(sessionMeta(ids.Q).completedAt > doneBefore);
      assert.equal(sessionMeta(ids.Q).interrupted ?? null, null);
      const records = (readUsage(dataDir)?.records ?? []).filter(r => r.sessionId === ids.Q);
      assert.equal(new Set(records.map(r => r.id)).size, records.length, '使用量の id は重ならない');
      t.ok('強制終了（手を離す口を経ない）: 札の置き直しで B が付け直し、同じ id の承認に答えると続いて 1 回だけ締まる', true);
      cb.close(); cb = null;
      await b.stop(); b = null;
    }

    // 4. 後片付け
    for (const x of await starts()) childPids.add(x.pid);
    {
      const probe = await connectHolder({ dataDir, root });
      for (const child of probe.welcome.children) if (child.pid) childPids.add(child.pid);
      probe.shutdown();
      probe.close();
    }
    await until(() => !alive(holderPid), 10_000, '保持役が終わる');
    for (const pid of childPids) await until(() => !alive(pid), 10_000, `偽の CLI（${pid}）が終わる`);
    holderPid = null;
    t.ok('後片付け: 保持役・偽の CLI が残らない', true);
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
