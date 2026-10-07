// 段階 2 の 2c: 保持役に載せた Claude の CLI（stream-json を話す偽物 tests/lib/fake-claude-cli.mjs）を、サーバーの入れ替えをまたいで付け直す
// （docs/zero-downtime-update/plan.md「2c」。載せ方は core/backends/claude-held.mjs、付け直しは claude.mjs の adoptTurn）。
//   1. 載せるかの切り替え: 実行場所の置き場が無い（開発・テストのサーバー）・AGENT_HOST_CLAUDE_HOLDER=off・確かめた下限より古い／major が違う CLI の版では、
//      CLI は保持役の子にならない（今の流れ）。置き場があり、確かめた版なら既定で保持役の子になり、入れ替えなしの承認も通る
//   2. 途中で引き継ぐ（2d の形: handOffTurn → 札を子に置いて detach → query を閉じる。tests/lib/adopt-server.mjs）。A を止め、同じデータ置き場で B が付け直す。
//      時点: 承認待ち（B に A と同じ id の承認が 1 つだけ出て、答えると続く）・ツールの実行中に受理した途中送信（B で折り込まれ、渡った合図が 1 回）・
//      裏の作業の待ち（phase: waiting が戻り、ゲートを開くと終わる）・hooks（PreCompact）のコールバックの答えが CLI に届かないまま（CLI が取り消して圧縮を続ける）・
//      in-process の MCP（host）の mcp_message の答えが届かないまま（B の SDK が答えて続く）。どれも turnEnd・completedAt・使用量（presentKey の 1 件。
//      費用の基準は札の値で差し引く）が 1 回だけ、restart の中断にならない
//   3. 強制終了（2e の形。手を離す口を経ない）: 承認待ちのまま A を SIGKILL しても、札の置き直し（touchCard）で B が付け直す
//   5. 引き継ぎ（2d の本物の道。偽の main の handover の依頼 → 新サーバー `--handover`）: 保持役に載った Claude のターンは切り替えを待たせず、承認待ちは同じ id で 1 つ。
//      Pleiad がコンテキストを担当する会話は、新サーバーが ply_context の口を札のトークンで開き直し、外部の stdio MCP を起こし直す（R15。最初の結果に状態が消えた旨）
//   4. 後片付け: 保持役・偽の CLI が残らない
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { startServer, ROOT } from '../lib/server.mjs';
import { open, sleep } from '../lib/ws-client.mjs';
import { readSessions, readUsage } from '../lib/data-store.mjs';
import { createFakeGates } from '../lib/fake-gate.mjs';
import { installFakeClaude } from '../lib/fake-claude.mjs';
import { ensureHolder, connectHolder } from '../../core/holder/client.mjs';

const require = createRequire(import.meta.url);
const { createServerLink, readLinkInfo } = require('../../desktop/server-link.cjs');

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

/** 偽の main（tests/unit/handover-server.mjs と同じ）: パイプにつなぎ、受けたメッセージを溜める */
async function attachMain(dataDir, pid) {
  const info = await until(() => { const found = readLinkInfo(dataDir); return found?.pid === pid ? found : null; }, WAIT_MS, `main-link.json (pid ${pid})`);
  const link = createServerLink({ pipe: info.pipe, secret: info.secret, appVersion: '0.0.1' });
  const seen = { messages: [] };
  link.on('message', message => seen.messages.push(message));
  await link.connect();
  return { link, seen, request: async (type, extra = {}, ms = 40_000) => {
    const id = Math.floor(Math.random() * 1e9);
    link.postMessage({ ...extra, type, id });
    return until(() => seen.messages.find(m => m.type === type && m.id === id), ms, `${type} の答え`);
  } };
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
  // AGENT_HOST_CLAUDE_HOLDER は付けない（既定で載る。実行場所の置き場があるときだけ）
  const env = { ...base, AGENT_HOST_RUNTIME_ROOT: root, ADOPT_SCENES_DIR: scenesDir };
  let a = null, b = null, ca = null, cb = null, m1 = null, m2 = null, holderPid = null;
  try {
    const found = await ensureHolder({ dataDir, root, mode: 'detached', idleMs: 20_000, timeoutMs: 20_000 });
    holderPid = found.pid;
    found.client.close();

    // 1. 切り替え: 実行場所の置き場が無い（開発・テストのサーバー）・off の明示・確かめた下限より古い版・major が違う版は保持役に載せない
    for (const [label, extra] of [
      ['実行場所の置き場が無い（既定）', {}],
      ['off の明示（AGENT_HOST_CLAUDE_HOLDER=off）', { ...env, AGENT_HOST_CLAUDE_HOLDER: 'off' }],
      ['下限より古い版（2.1.267）', { ...env, FAKE_CLAUDE_VERSION: '2.1.267' }],
      ['major が違う版（3.0.0）', { ...env, FAKE_CLAUDE_VERSION: '3.0.0' }],
    ]) {
      const s = await startServer({ env: { ...base, ...extra }, dataDir, timeoutMs: 30_000 });
      const c = await open({ port: s.port, token: s.token });
      try {
        const res = await c.runTurn({ backend: 'claude', cwd: work, prompt: 'plain' }, { ms: WAIT_MS });
        assert.equal(res.outcome, 'ok', `${label}: ${s.tail(10)}`);
        const mine = (await starts()).filter(x => x.session === sessionMeta(res.sessionId)?.nativeId || x.session === res.sessionId);
        assert.ok(mine.length && mine.every(x => x.ppid !== holderPid), `${label}: CLI は保持役の子にならない`);
      } finally { c.close(); await s.stop(); }
    }
    t.ok('切り替え: 置き場が無い・off の明示・下限より古い／major が違う CLI の版では保持役に載せない（今の流れ）', true);

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
      assert.ok(mine.length >= 2 && mine.every(x => x.ppid === holderPid), '既定: CLI は保持役の子として起きる');
      const loaded = await ca.cmd('loadSession', { sessionId: ids.P });
      assert.equal(loaded.messages.filter(m => m.role === 'assistant' && m.text === 'final P').length, 1);
      t.ok('既定（置き場があり、確かめた版）: CLI は保持役の子として起き、承認待ち → 答えると続く', true);
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

    // 5. 引き継ぎ（2d の本物の道: main の handover の依頼 → 旧サーバーが札を取って control.holder.handOff → 新サーバー `--handover` が付け直す）。
    //    承認待ち（Q）と、Pleiad がコンテキストを担当する会話（R。ply_context の口を札のトークンで開き直し、外部の stdio MCP を起こし直す。R15）
    {
      const workCtx = path.join(scratch, 'work-ctx');
      const launches = path.join(scratch, 'fixture-launches.txt');
      await fs.mkdir(path.join(workCtx, '.git'), { recursive: true });
      const fixture = path.join(scratch, 'fixture-mcp.mjs');
      // 状態を持つ外部の MCP（呼ぶたびに数が増える）。起こすたびに 1 行残す
      await fs.writeFile(fixture, `import fs from 'node:fs';import readline from 'node:readline';fs.appendFileSync(${JSON.stringify(launches)},'launch\\n');let n=0;for await(const line of readline.createInterface({input:process.stdin})){const m=JSON.parse(line);if(m.id===undefined)continue;const result=m.method==='initialize'?{protocolVersion:'2025-06-18',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}}:m.method==='tools/list'?{tools:[{name:'count',description:'count',inputSchema:{type:'object'}}]}:m.method==='tools/call'?{content:[{type:'text',text:'count='+(++n)}]}:{};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');}`);
      await fs.writeFile(path.join(workCtx, '.mcp.json'), JSON.stringify({ mcpServers: { fixture: { command: process.execPath, args: [fixture] } } }));
      const launchCount = async () => (await fs.readFile(launches, 'utf8').catch(() => '')).split('\n').filter(Boolean).length;
      const envH = { ...env, AGENT_HOST_HANDOVER: 'on', AGENT_HOST_GRACE_MS: '600000' };
      a = await startServer({ env: envH, dataDir, timeoutMs: 40_000, entry: path.join(ROOT, 'tests', 'lib', 'adopt-server.mjs') });
      m1 = await attachMain(dataDir, a.child.pid);
      ca = await open({ port: a.port, token: a.token });
      const none = { sources: [], excludePaths: [] };
      await ca.cmd('setContextSettings', { cwd: workCtx, place: workCtx, kind: 'mcp', value: { owner: 'ply', user: none, directory: { sources: ['claude'], excludePaths: [] } } });
      const first = await ca.runTurn({ backend: 'claude', cwd: workCtx, prompt: 'hello R' }, { ms: WAIT_MS });
      assert.equal(first.outcome, 'ok', a.tail(10));
      ids.R = first.sessionId;
      const doneBefore = { Q: sessionMeta(ids.Q).completedAt, R: sessionMeta(ids.R).completedAt };
      const usageBefore = { Q: readUsage(dataDir).records.filter(r => r.sessionId === ids.Q).length, R: readUsage(dataDir).records.filter(r => r.sessionId === ids.R).length };
      const count = { http: { server: 'ply_context', tool: '[fixture / count]' } };
      const markH = ca.mark();
      void ca.cmd('sendMessage', { sessionId: ids.Q, messageId: 'handover-Q-0001', prompt: script([{ tool: 'Bash', input: { command: 'hq' }, result: 'ran hq', ask: true }, { text: 'final HQ' }]) }).catch(() => {});
      void ca.cmd('sendMessage', { sessionId: ids.R, messageId: 'handover-R-0001', prompt: script([count, { tool: 'Read', input: { file_path: 'r' }, result: 'read r', gate: 'r-tool' }, count, { text: 'final R' }]) }).catch(() => {});
      const askHQ = await ca.waitFor(e => e.type === 'permission' && e.sessionId === ids.Q, { ms: WAIT_MS, from: markH });
      await ca.waitFor(e => e.type === 'tool.start' && e.sessionId === ids.R && e.name === 'Read', { ms: WAIT_MS, from: markH });
      const launchesBefore = await launchCount();
      {
        const running = await until(async () => { const r = await ca.cmd('running'); return r.turns.filter(x => x.held).length === 2 ? r : null; }, WAIT_MS, 'Claude の 2 つのターンが held');
        assert.equal(running.handover.blocking, 0, '保持役に載った Claude のターンは、切り替えを待たせない');
        assert.ok(running.permissions.find(p => p.id === askHQ.id)?.held, '承認待ちも held');
      }
      b = await startServer({ env: envH, dataDir, timeoutMs: 60_000, args: ['--handover'], lazy: true });
      await sleep(800);
      const reply = await m1.request('handover');
      assert.equal(reply.ok, true, JSON.stringify(reply));
      assert.deepEqual([...reply.handed].sort(), [ids.Q, ids.R].sort(), '渡したターン');
      await until(() => a.child.exitCode !== null, 20_000, 'S1 が終わる');
      await b.ready();
      assert.equal(b.port, a.port, 'S2 は S1 と同じポートで待ち受ける');
      m2 = await attachMain(dataDir, b.child.pid);
      ca.close(); ca = null;
      cb = await open({ port: a.port, token: a.token });
      const askB = await cb.waitFor(e => e.type === 'permission' && e.sessionId === ids.Q, { ms: WAIT_MS });
      await sleep(500);
      assert.equal(askB.id, askHQ.id, 'Q: 承認の id は S1 と同じ');
      assert.equal(cb.events.filter(e => e.type === 'permission' && e.sessionId === ids.Q).length, 1, 'Q: S2 に承認が 1 つだけ');
      await cb.cmd('resolvePermission', { id: askB.id, allow: true });
      await gates.open('r-tool');
      for (const k of ['Q', 'R']) await cb.waitFor(e => e.type === 'turnEnd' && e.sessionId === ids[k], { ms: WAIT_MS }).catch(e => { throw new Error(`${k}: ${e.message}\n${b.tail(20)}`); });
      await sleep(500);
      for (const k of ['Q', 'R']) {
        const ends = cb.events.filter(e => e.type === 'turnEnd' && e.sessionId === ids[k]);
        assert.deepEqual(ends.map(e => e.outcome), ['ok'], `${k}: turnEnd は 1 回で ok`);
        assert.equal(sessionMeta(ids[k]).interrupted ?? null, null, `${k}: 中断にならない`);
        assert.ok(sessionMeta(ids[k]).completedAt > doneBefore[k], `${k}: 完了時刻を書く`);
        assert.equal(readUsage(dataDir).records.filter(r => r.sessionId === ids[k]).length, usageBefore[k] + 1, `${k}: 使用量はこのターンの分が 1 件`);
      }
      {
        const loaded = await cb.cmd('loadSession', { sessionId: ids.R });
        const calls = loaded.messages.flatMap(m => m.toolCalls ?? []).filter(c => String(c.name).startsWith('mcp__ply_context__')).map(c => String(c.result.text));
        assert.equal(calls.length, 2, `R: ply_context の呼び出しが 2 回（${JSON.stringify(calls)}）`);
        assert.equal(calls[0], 'count=1', 'R: S1 での呼び出し');
        assert.ok(calls[1].includes('起こし直した') && calls[1].includes('count=1'), `R: S2 は ply_context の口を同じトークンで開き直し、外部の MCP を起こし直す（状態は消え、最初の結果にその旨が添わる）: ${calls[1]}
${b.tail(40)}`);
        assert.equal(await launchCount(), launchesBefore + 1, 'R: 外部の MCP は S2 で 1 回だけ起こし直す');
      }
      assert.ok(!b.tail(300).includes('[unhandledRejection]'), b.tail(20));
      t.ok('引き継ぎ（2d）: 保持役に載った Claude のターン（承認待ち・ツールの実行中）は切り替えを待たせず、S1 が渡して終わり、S2（--handover）が同じトークン・ポートで付け直す。承認は同じ id で 1 つ、turnEnd・completedAt・使用量は 1 回', true);
      t.ok('R15: Pleiad がコンテキストを担当する会話は、S2 が ply_context の口を札のトークンで開き直し、外部の stdio MCP を起こし直す（同じツールの名前。起こし直した後の最初の結果に、状態が消えた旨を添える）', true);
      cb.close(); cb = null;
      m2.link.leave(); m2 = null;
      try { m1.link.kill(); } catch { /* S1 は終わっている */ }
      m1 = null;
      await b.stop(); b = null;
      a = null;
    }

    // 4. 後片付け
    // 終わりを待つのは、保持役が今生きていると言う子と、その下で起きた偽の CLI（起動の記録の ppid がその子の pid。Windows は claude.cmd の下の node）だけ。
    // 起動の記録の pid を全部待つと、とっくに終わって別のプロセスへ使い回された pid（Windows は早く使い回す）を「終わらない」と取り違える
    const heldPids = new Set();
    {
      const probe = await connectHolder({ dataDir, root });
      for (const child of probe.welcome.children) if (child.pid && child.alive) heldPids.add(child.pid);
      for (const x of await starts()) if (heldPids.has(x.ppid)) heldPids.add(x.pid);
      probe.shutdown();
      probe.close();
    }
    await until(() => !alive(holderPid), 10_000, '保持役が終わる');
    for (const pid of heldPids) await until(() => !alive(pid), 10_000, `偽の CLI（${pid}）が終わる`);
    holderPid = null;
    t.ok('後片付け: 保持役・偽の CLI が残らない', true);
  } finally {
    ca?.close();
    cb?.close();
    for (const m of [m1, m2]) { try { m?.link?.kill(); } catch { /* 終わっていれば何もしない */ } }
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
