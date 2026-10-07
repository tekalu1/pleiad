// 無停止の更新 段階 3: 保持役に載せた Codex の共有の app-server（fake の app-server。tests/lib/fake-codex.mjs）を、サーバーの入れ替えをまたいで引き継ぐ
// （docs/zero-downtime-update/stage3-codex.md。載せ方は core/backends/codex-held.mjs、再生は codex-rpc.mjs の adoptThread・codex.mjs の adoptTurn）。
//   1. 載せるかの切り替え: AGENT_HOST_CODEX_HOLDER=off では app-server は保持役の子にならない（今の流れ）。既定（置き場があって何も書かない）は保持役の子
//   2. 途中で引き継ぐ（tests/lib/adopt-server.mjs の handOffCodex）: 共有の app-server を 1 回だけ detach し、新しいサーバー B が同じ app-server を引き継ぐ（initialize は送らない）。
//      同時に走る 3 つのターン: 承認待ち（B に A と同じ id の承認が 1 つだけ）・ツールの実行中（ゲートを開くと B で終わる）・サブエージェント（子の承認が親の会話に出る）。
//      どれも turnEnd・completedAt・使用量が 1 回だけ、restart の中断にならない
//   3. 終わった直後: A が app-server の出力を読まないうちにターンが終わる（B が続きの側で締める）
//   4. 裏の端末: 引き継ぎで止まらない（running の background は held）。B が app-server に聞き直して数え直し、止めると終わる
//   5. 強制終了（手を離す口を経ない）: 承認待ちのまま A を SIGKILL しても、札の置き直しで B が付け直す
//   6. 引き継ぎ（本物の道: 偽の main の handover の依頼 → 新サーバー --handover）: 保持役に載った Codex のターンは切り替えを待たせず、承認は同じ id で 1 つ
//   7. 後片付け: 保持役・fake の app-server が残らない
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { startServer, ROOT } from '../lib/server.mjs';
import { open, sleep } from '../lib/ws-client.mjs';
import { readSessions, readUsage } from '../lib/data-store.mjs';
import { createFakeGates } from '../lib/fake-gate.mjs';
import { ensureHolder, connectHolder } from '../../core/holder/client.mjs';

const require = createRequire(import.meta.url);
const { createServerLink, readLinkInfo } = require('../../desktop/server-link.cjs');

export const name = 'adopt-codex';
export const title = '付け直し: 保持役に載せた Codex の共有の app-server（偽物）を、サーバーの入れ替えをまたいで途中から引き継ぐ';

const WAIT_MS = 20_000;
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

/** 偽の main（tests/unit/adopt-claude.mjs と同じ）: パイプにつなぎ、受けたメッセージを溜める */
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
  const scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ply-adopt-codex-')));
  const dataDir = path.join(scratch, 'data');
  const root = path.join(scratch, 'runtime');
  const scenesDir = path.join(scratch, 'scenes');
  const work = path.join(scratch, 'work');
  const home = path.join(scratch, 'home');
  const codexLog = path.join(scratch, 'codex.log');
  await Promise.all([scenesDir, work, home].map(dir => fs.mkdir(dir, { recursive: true })));
  const gates = await createFakeGates(scratch);
  const fake = path.join(ROOT, 'tests', 'lib', 'fake-codex.mjs');
  const sessionMeta = id => readSessions(dataDir)[id] ?? null;
  const usageOf = key => (readUsage(dataDir)?.records ?? []).filter(r => r.id === key);
  // fake の app-server の記録（FAKE_CODEX_LOG。1 行 1 JSON。pid つき）。initialize が何回届いたか・どのプロセスが何を受けたか
  const calls = async () => (await fs.readFile(codexLog, 'utf8').catch(() => '')).split('\n').filter(Boolean).map(line => JSON.parse(line));
  const base = {
    AGENT_HOST_BACKENDS: 'codex', HOME: home, USERPROFILE: home, CODEX_HOME: path.join(home, '.codex'), CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
    AGENT_HOST_CODEX_BIN: `node "${fake}"`, FAKE_CODEX_LOG: codexLog, ...gates.env,
  };
  const env = { ...base, AGENT_HOST_RUNTIME_ROOT: root, ADOPT_SCENES_DIR: scenesDir };
  const holderChildren = async () => {
    const probe = await connectHolder({ dataDir, root });
    try { return probe.welcome.children; } finally { probe.close(); }
  };
  let a = null, b = null, ca = null, cb = null, m1 = null, m2 = null, holderPid = null;
  try {
    const found = await ensureHolder({ dataDir, root, mode: 'detached', idleMs: 20_000, timeoutMs: 20_000 });
    holderPid = found.pid;
    found.client.close();

    // 1. 載せるかの切り替え: off では保持役の子にならない
    {
      const s = await startServer({ env: { ...base, AGENT_HOST_RUNTIME_ROOT: root, AGENT_HOST_CODEX_HOLDER: 'off' }, dataDir, timeoutMs: 30_000 });
      const c = await open({ port: s.port, token: s.token, autoAllow: true });
      try {
        const res = await c.runTurn({ backend: 'codex', cwd: work, prompt: 'plain' }, { ms: WAIT_MS });
        assert.equal(res.outcome, 'ok', s.tail(10));
        assert.deepEqual((await holderChildren()).map(x => x.id), [], 'off: app-server は保持役の子にならない');
      } finally { c.close(); await s.stop(); }
      t.ok('切り替え: AGENT_HOST_CODEX_HOLDER=off では app-server は保持役の子にならない（今の流れ）', true);
    }

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
    // 承認は、準備の間だけ自動で通す（auto）。測るターンの承認は自分で見て答える
    let auto = true;
    const approver = async (ev, self) => { if (auto && ev.type === 'permission') await self.cmd('resolvePermission', { id: ev.id, allow: true }).catch(() => {}); };
    ca = await open({ port: a.port, token: a.token, onEvent: approver });
    const ids = {};
    // 会話を作るターン（承認なしのゲートのターン。fake の承認はツールの id が毎回同じで、同じプロセスの 2 回目の承認の id が乱数になってしまう）
    await gates.open('hello');
    for (const k of ['Q', 'S', 'D']) {
      const res = await ca.runTurn({ backend: 'codex', cwd: work, prompt: `gate:hello ${k}` }, { ms: WAIT_MS });
      assert.equal(res.outcome, 'ok', a.tail(10));
      ids[k] = res.sessionId;
    }
    // 既定（何も書かない）は保持役の子。同じ app-server が、会話をまたいで 1 本
    {
      const children = await holderChildren();
      assert.deepEqual(children.map(x => [x.id, x.alive, x.policy]), [['codex-app-server', true, 'jsonrpc']], '既定: 共有の app-server が保持役の子（1 本）');
      assert.equal((await calls()).filter(c => c.method === 'initialize').length, 2, 'initialize は 1 回ずつ（off の A で 1 回・既定の A で 1 回）');
    }
    t.ok('既定（置き場があって何も書かない）: 共有の app-server は保持役の子 1 本。会話をまたいで同じ app-server', true);
    const appServerPid = (await holderChildren())[0].pid;
    auto = false;

    // 2. 途中で引き継ぐ: 承認待ち（Q）・ツールの実行中（S）・サブエージェントの子の承認待ち（D）を、1 回の入れ替えで
    const before = Object.fromEntries(Object.entries(ids).map(([k, id]) => [k, sessionMeta(id)?.completedAt]));
    const markA = ca.mark();
    const prompts = { Q: 'approve Q', S: 'gate:s-tool', D: 'subagent D' };
    for (const k of Object.keys(prompts)) void ca.cmd('sendMessage', { sessionId: ids[k], messageId: `adopt-${k}-0001`, prompt: prompts[k] }).catch(() => {});
    const askQ = await ca.waitFor(e => e.type === 'permission' && e.sessionId === ids.Q, { ms: WAIT_MS, from: markA });
    const askD = await ca.waitFor(e => e.type === 'permission' && e.sessionId === ids.D, { ms: WAIT_MS, from: markA });
    await ca.waitFor(e => e.type === 'tool.start' && e.sessionId === ids.S, { ms: WAIT_MS, from: markA });
    await sleep(400);   // 札の置き直しが保持役へ届くまで
    const taken = await scene('handOffCodex', { sessionIds: Object.values(ids) }).catch(e => { throw new Error(`${e.message}
${a.tail(15)}`); });
    for (const k of Object.keys(prompts)) assert.ok(taken[ids[k]].card.backendCard?.held, `${k}: 札に Codex の欄`);
    assert.deepEqual(taken[ids.Q].card.waits, [askQ.id], 'Q: 札に出している承認の id');
    await sleep(300);
    for (const k of Object.keys(prompts)) assert.equal(ca.since(markA).filter(e => e.sessionId === ids[k] && ['turnEnd', 'turnResult'].includes(e.type)).length, 0, `A は ${k} を締めない`);
    ca.close(); ca = null;
    await a.stop(); a = null;

    // 保持役の子: 札つきで走り続けている（B より前にテストがつなぐ。親は 1 つ）
    {
      const [child] = await holderChildren();
      assert.equal(child.alive, true, 'app-server は走り続けている');
      assert.equal(child.pid, appServerPid, '同じ app-server');
      assert.deepEqual(Object.keys(child.label.turns).sort(), Object.values(ids).map(id => sessionMeta(id).nativeId ?? id).sort(), '札に 3 つのターン');
      assert.equal(child.pendingRequests.length, 2, '答えていない依頼が控えにある（Q の承認と D の子の承認）');
    }

    b = await startServer({ env: { ...env, AGENT_HOST_ADOPT_HOLDER: '1' }, dataDir, timeoutMs: 30_000 });
    cb = await open({ port: b.port, token: b.token, onEvent: approver });
    const askBQ = await cb.waitFor(e => e.type === 'permission' && e.sessionId === ids.Q, { ms: WAIT_MS });
    const askBD = await cb.waitFor(e => e.type === 'permission' && e.sessionId === ids.D, { ms: WAIT_MS });
    await sleep(500);
    assert.equal(askBQ.id, askQ.id, 'Q: 承認の id は A と同じ');
    assert.equal(askBD.id, askD.id, 'D: 子の承認の id は A と同じ');
    assert.equal(cb.events.filter(e => e.type === 'permission' && e.sessionId === ids.Q).length, 1, 'Q: B に承認が 1 つだけ');
    assert.equal(cb.events.filter(e => e.type === 'permission' && e.sessionId === ids.D).length, 1, 'D: B に子の承認が 1 つだけ');
    await cb.cmd('resolvePermission', { id: askBQ.id, allow: true });
    await cb.cmd('resolvePermission', { id: askBD.id, allow: true });
    await gates.open('s-tool');
    for (const k of Object.keys(prompts)) await cb.waitFor(e => e.type === 'turnEnd' && e.sessionId === ids[k], { ms: WAIT_MS }).catch(e => { throw new Error(`${k}: ${e.message}
${b.tail(20)}`); });
    await sleep(500);
    for (const k of Object.keys(prompts)) {
      const id = ids[k];
      const ends = cb.events.filter(e => e.type === 'turnEnd' && e.sessionId === id);
      assert.equal(ends.length, 1, `${k}: turnEnd は 1 回`);
      assert.equal(ends[0].outcome, 'ok', `${k}: 最後まで流れて ok`);
      const meta = sessionMeta(id);
      assert.equal(meta.interrupted ?? null, null, `${k}: restart の中断にならない`);
      assert.equal(meta.turnStartedAt ?? null, null, `${k}: 走っている印は片付く`);
      assert.ok(meta.completedAt > before[k], `${k}: 完了時刻を書く`);
      const usage = usageOf(taken[id].card.presentKey);
      assert.ok(usage.length === 1 || (k === 'D' && usage.length === 0), `${k}: 使用量は presentKey で 1 件（${usage.length}）`);
    }
    {
      const finalOf = async (k, text) => (await cb.cmd('loadSession', { sessionId: ids[k] })).messages.filter(m => m.role === 'assistant' && String(m.text).startsWith(text));
      assert.equal((await finalOf('Q', '了解: approve Q')).length, 1, 'Q: 最後の本文は履歴に 1 回');
      assert.equal((await finalOf('S', 'start end s-tool')).length, 1, 'S: 最後の本文は履歴に 1 回');
      assert.equal((await finalOf('D', '子の承認: accept')).length, 1, 'D: 子の承認に答えて親が続き、最後の本文は 1 回');
      const q = await cb.cmd('loadSession', { sessionId: ids.Q });
      assert.equal(q.messages.flatMap(x => x.toolCalls ?? []).filter(c => String(c.result?.text).endsWith('hi')).length, 1, 'Q: 承認の後のツールの結果が 1 回');
    }
    assert.equal((await holderChildren())[0].pid, appServerPid, 'B も同じ app-server を使っている');
    assert.equal((await calls()).filter(c => c.method === 'initialize').length, 2, 'B は initialize を送らない（付け直した app-server は initialize 済み）');
    assert.ok(!b.tail(200).includes('[unhandledRejection]'), b.tail(20));
    assert.ok(b.tail(200).includes('ターンを付け直した'), b.tail(20));
    t.ok('承認待ち・子の承認待ち・ツールの実行中: 1 回の入れ替えで共有の app-server を引き継ぎ、B に同じ id の承認が 1 つずつ出て、答える・ゲートを開くと続いて 1 回だけ締まる（initialize は送らない）', true);
    cb.close(); cb = null;
    await b.stop(); b = null;
  } catch (error) {
    // 失敗したときの手がかり（直近のイベントとサーバーの出力）
    const brief = client => (client?.events ?? []).slice(-25).map(e => `${e.type}${e.sessionId ? `:${String(e.sessionId).slice(-6)}` : ''}`).join(' ');
    error.message += `
  A events: ${brief(ca)}
  B events: ${brief(cb)}
  A tail: ${a?.tail(15)}
  B tail: ${b?.tail(15)}`;
    throw error;
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
