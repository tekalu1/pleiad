// 委譲先の自動振り分けをサーバー全体で確かめる。判定器は手元の偽の Jev（OpenRouter の decisions の形）、
// 委譲先は偽の agy（tests/lib/fake-agy.mjs。使用量とモデル一覧を返す）。本物の判定サービス・LLM へは送らない
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { startServer, ROOT } from '../lib/server.mjs';
import { open, sleep } from '../lib/ws-client.mjs';

export const name = 'server-delegation-routing';
export const title = '委譲先の自動振り分け: kind の検査・自動で選んで子を作る・記録・設定とキーの口・キーを出さない';
const prompt = (name, args) => 'ply:' + JSON.stringify({ name, arguments: args });
const SIGNALS = ['diagnose', 'choose', 'long_procedure', 'many_parts', 'writes_shared', 'security_gate'];

export default async function (t) {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-routing-'));
  const KEY = 'sk-or-routing-test-SECRET-9f3a';
  // 偽の Jev。依頼文に FAIL を含めば 500 を返す
  const jevCalls = [];
  const jev = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      jevCalls.push({ url: req.url, auth: req.headers.authorization, body });
      if (String(body.state?.task).includes('FAIL')) { res.writeHead(500); return res.end('{}'); }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ answers: Object.fromEntries(SIGNALS.map(k => [k, { type: 'noul', noul: 0.01 }])) }));
    });
  });
  await new Promise(r => jev.listen(0, '127.0.0.1', r));
  const server = await startServer({ dataDir: scratch, env: {
    AGENT_HOST_BACKENDS: 'fake,antigravity', AGENT_HOST_AGY_BIN: `node "${path.join(ROOT, 'tests/lib/fake-agy.mjs')}"`,
    FAKE_AGY_EXTRA_MODELS: 'gemini-3.8-flash-high,gemini-3.8-pro-high', AGENT_HOST_ROUTING_USAGE: 'on',
    AGENT_HOST_OPENROUTER_API: `http://127.0.0.1:${jev.address().port}/api` } });
  // antigravity の子は親より強い（yolo）ので、委譲のたびに親の会話で 1 回聞かれる。ここでは許す
  const c = await open({ port: server.port, token: server.token, onEvent: async (ev, api) => {
    if (ev.type === 'permission') await api.cmd('resolvePermission', { id: ev.id, allow: true }).catch(() => {});
  } });
  // 子の完了通知が依頼元の会話で走っている間は、その会話で次のターンを始められない。空くまで待って頼み直す
  const turnOn = async (sessionId, text) => {
    for (let i = 0; ; i++) {
      try { return sessionId ? await c.runTurn({ sessionId, prompt: text }) : await c.runTurn({ backend: 'fake', cwd: ROOT, prompt: text }); }
      catch (e) { if (i > 200 || !/切り替え中|実行中|running/.test(e.message)) throw e; await sleep(50); }
    }
  };
  const call = async (sessionId, args) => {
    const from = c.mark();
    const turn = await turnOn(sessionId, prompt('ply_delegate', args));
    const ev = await c.waitFor(e => e.type === 'tool.result' && e.sessionId === turn.sessionId, { from, ms: 60000 });
    let data = null;
    try { data = JSON.parse(ev.text); } catch { /* エラーは文 */ }
    return { sessionId: turn.sessionId, isError: ev.isError, text: ev.text, data };
  };
  try {
    // ---- 設定と使用量（段 B の画面が読む口）
    let state;
    for (let i = 0; i < 200; i++) {
      state = await c.cmd('delegationRouting');
      if (state.candidates.find(x => x.candidate === 'antigravity:gemini-3.8-flash-high')?.usable) break;
      await sleep(100);
    }
    t.ok('設定は既定値（有効）で、9 種類・段・判定器の一覧を返す', state.settings.enabled === true && state.kinds.length === 9 && state.tiers.join() === 't1,t2,t3,t4,tv'
      && state.judges.join() === 'jev,cerebras,none' && state.settings.judgeByKind.visual === 'none');
    const gem = state.candidates.find(x => x.candidate === 'antigravity:gemini-3.8-flash-high');
    t.ok('候補ごとに今の使用量と使えるかどうかを返す（agy の使用量を定期的に取っている）', gem?.usable === true && gem.windows.length === 2 && gem.checkedAt
      && state.candidates.find(x => x.candidate === 'claude:opus').reason === 'unavailable', JSON.stringify(gem));
    t.ok('今の一覧に無い候補・使えないバックエンドを知らせる', state.warnings.some(w => w.candidate === 'codex:gpt-6-sol' && w.reason === 'unavailable')
      && state.warnings.some(w => w.candidate === 'antigravity:claude-opus-4-6-thinking' && w.reason === 'model_unknown'));
    t.ok('キーは未登録', state.keys.openrouter.hasKey === false && state.keys.cerebras.hasKey === false);

    // ---- kind の検査
    const noKind = await call(null, { task: 'echo:X' });
    t.ok('kind が無ければ 9 種類の一覧を付けたエラー（会話の言語）', noKind.isError && ['trivial', 'mechanical', 'investigate', 'implement', 'review', 'design', 'ux_change', 'ux_new', 'visual'].every(k => noKind.text.includes(`- ${k}: `))
      && noKind.text.includes('kind を'), noKind.text.slice(0, 120));
    const sid = noKind.sessionId;
    const badKind = await call(sid, { kind: 'cooking', task: 'echo:X' });
    t.ok('不正な kind もエラー', badKind.isError && badKind.text.includes('ux_change'));
    const pinModel = await call(sid, { kind: 'implement', task: 'echo:X', model: 'haiku' });
    t.ok('backend 無しの model・effort は断る（黙って無視しない）', pinModel.isError && pinModel.text.includes('backend'));

    // ---- キーが無い: 外へは送らず難しさは mid
    const noKey = await call(sid, { kind: 'trivial', task: 'agy-auto-nokey' });
    t.ok('キーが無ければ判定器へ送らず、難しさ mid で選ぶ（fallback: no_key）', !noKey.isError && noKey.data.routing.mode === 'auto' && noKey.data.routing.fallback === 'no_key'
      && noKey.data.routing.judge === 'none' && noKey.data.routing.difficulty === 'mid' && jevCalls.length === 0, noKey.text.slice(0, 300));
    t.ok('自動で選んだ委譲先で子を作る（antigravity の gemini）', noKey.data.backend === 'antigravity' && noKey.data.routing.target.backend === 'antigravity'
      && noKey.data.routing.target.model === 'gemini-3.8-flash-high' && noKey.data.routing.target.account === null && noKey.data.routing.tier === 't1');

    // ---- キーを登録して Jev に聞く
    await c.cmd('setDelegationRoutingKey', { service: 'nope', key: 'x' }).then(() => t.ok('知らないサービスは断る', false), () => t.ok('知らないサービスは断る', true));
    await c.cmd('setDelegationRoutingKey', { service: 'openrouter', key: 'has space' }).then(() => t.ok('形の悪いキーは断る', false), () => t.ok('形の悪いキーは断る', true));
    state = await c.cmd('setDelegationRoutingKey', { service: 'openrouter', key: KEY });
    t.ok('キーの登録後も画面へは hasKey だけ', state.keys.openrouter.hasKey === true && !JSON.stringify(state).includes(KEY));
    const auto = await call(sid, { kind: 'trivial', task: 'agy-auto-task' });
    const r = auto.data?.routing;
    t.ok('Jev の手がかりから難しさを出し、段・委譲先を選ぶ', !auto.isError && r.judge === 'jev' && r.fallback === null && r.difficulty === 'low' && r.tier === 't1'
      && Object.keys(r.signals).length === 6 && r.probabilities.diagnose === 0.01 && r.usageAt, auto.text.slice(0, 300));
    const sent = jevCalls.at(-1);
    t.ok('Jev へは kind と依頼文だけを、キーを付けて送る', sent.url === '/api/alpha/decisions' && sent.auth === `Bearer ${KEY}` && sent.body.state.kind === 'trivial'
      && sent.body.state.task === 'agy-auto-task' && !JSON.stringify(sent.body).includes('usage'));
    const failed = await call(sid, { kind: 'trivial', task: 'agy-auto FAIL' });
    t.ok('Jev が失敗したら mid で続け、理由を残す（http_500）', !failed.isError && failed.data.routing.fallback === 'http_500' && failed.data.routing.difficulty === 'mid');

    // ---- 固定
    const pinned = await call(sid, { kind: 'review', backend: 'fake', task: 'echo:PINNED' });
    t.ok('backend を書けば固定。kind は記録する', !pinned.isError && pinned.data.routing.mode === 'pinned' && pinned.data.routing.kind === 'review' && pinned.data.routing.target.backend === 'fake');

    // ---- 記録
    const tasks = await c.cmd('agentTasks');
    const row = tasks.find(x => x.taskId === auto.data.taskId);
    t.ok('タスクに routing を保存する（確率つき）', row?.routing?.mode === 'auto' && row.routing.probabilities.choose === 0.01 && tasks.find(x => x.taskId === pinned.data.taskId).routing.mode === 'pinned');
    const sessions = await c.cmd('listSessions');
    t.ok('子の会話のメタデータにも routing', sessions.find(s => s.id === row.sessionId)?.routing?.target?.model === 'gemini-3.8-flash-high');
    const status = await call(sid, { kind: 'trivial', task: 'agy-auto-status' });
    await sleep(100);
    const listed = await turnOn(sid, prompt('ply_task_status', { taskId: status.data.taskId }));
    t.ok('ply_task_status でも routing を読める', JSON.parse(listed.events.find(e => e.type === 'tool.result').text).routing?.mode === 'auto');

    t.ok('選んだ候補に効いた枠の使用率を routing に残す（委譲カードの内訳）', r.targetWindows?.length === 2 && r.targetWindows.every(w => typeof w.usedPercent === 'number' && w.label), JSON.stringify(r.targetWindows));

    // ---- 別の候補でやり直す（委譲カードの操作。retryAgentTask）
    await c.cmd('setDelegationRouting', { settings: { tiers: { t1: ['antigravity:gemini-3.8-flash-high', 'antigravity:gemini-3.8-pro-high'] } } });
    let pro;
    for (let i = 0; i < 100; i++) {
      pro = (await c.cmd('delegationRouting')).candidates.find(x => x.candidate === 'antigravity:gemini-3.8-pro-high');
      if (pro?.usable) break;
      await sleep(100);
    }
    t.ok('足した候補も使用量を読んで使えるかを返す', pro?.usable === true, JSON.stringify(pro));
    const origin = await call(sid, { kind: 'trivial', task: 'agy-retry-origin', context: 'CTX-RETRY-7' });
    const retryErr = async (args, re, label) => c.cmd('retryAgentTask', { taskId: origin.data.taskId, ...args })
      .then(() => t.ok(label, false), e => t.ok(label, re.test(e.message), e.message));
    await retryErr({ candidate: 'antigravity:gemini-3.8-flash-high' }, /同じ/, '元と同じ委譲先ではやり直さない');
    await retryErr({ candidate: 'claude:haiku' }, /使えません/, '今使えない候補ではやり直さない');
    await retryErr({ candidate: 'nope' }, /形/, '候補の形が不正なら断る');
    for (let i = 0; i < 200 && (await c.cmd('agentTasks')).find(x => x.taskId === origin.data.taskId)?.status !== 'completed'; i++) await sleep(100);
    const asked = await c.cmd('retryAgentTask', { taskId: origin.data.taskId, candidate: 'antigravity:gemini-3.8-pro-high' });
    t.ok('依頼元より強い承認モードになるなら、作らずに確かめる（confirm）', asked.confirm?.agent && asked.confirm.mode && !asked.task
      && (await c.cmd('agentTasks')).every(x => x.routing?.retry?.of !== origin.data.taskId), JSON.stringify(asked));
    const retried = await c.cmd('retryAgentTask', { taskId: origin.data.taskId, candidate: 'antigravity:gemini-3.8-pro-high', approved: true });
    const rr = retried.task?.routing;
    t.ok('やり直しは新しいタスク。元のタスクと「人が委譲先を変えた」を routing に残す', retried.task?.taskId !== origin.data.taskId && rr?.mode === 'manual'
      && rr.retry?.of === origin.data.taskId && rr.retry.by === 'user' && rr.retry.from?.model === 'gemini-3.8-flash-high' && rr.kind === 'trivial'
      && rr.target.model === 'gemini-3.8-pro-high' && retried.task.model === 'gemini-3.8-pro-high' && retried.task.parentSessionId === sid, JSON.stringify(retried));
    // 完了通知のターンが終わるまで待ち、依頼元の会話に届いた通知の本文を見る。
    // agent-tasks.json はサーバーが書き換えている最中に読むと Windows で書き換えが失敗するので、ここでは読まない
    for (let i = 0; i < 1200 && (await c.cmd('agentTasks')).find(x => x.taskId === retried.task.taskId)?.notification !== 'sent'; i++) await sleep(100);
    const retriedRow = (await c.cmd('agentTasks')).find(x => x.taskId === retried.task.taskId);
    t.ok('同じ依頼（context も）を渡し直す。context は一覧・状態には載せない', retriedRow?.task === 'agy-retry-origin' && retriedRow.result.includes('CTX-RETRY-7')
      && (await c.cmd('agentTasks')).every(x => !('context' in x)), retriedRow?.result);
    const parentText = JSON.stringify((await c.cmd('loadSession', { sessionId: sid })).messages ?? []);
    t.ok('やり直したタスクの完了通知には、人がやり直したことを添える', parentText.includes(`${origin.data.taskId} を別の委譲先でやり直した`), retriedRow?.notification);
    // 動いている元のタスク: 止めるかどうかを選ばせる
    const slow = await call(null, { kind: 'trivial', backend: 'fake', task: 'slow' });
    t.ok('（準備）止まらない子を固定で作る', Boolean(slow.data?.taskId), slow.text.slice(0, 200));
    for (let i = 0; i < 200 && (await c.cmd('agentTasks')).find(x => x.taskId === slow.data.taskId)?.status !== 'running'; i++) await sleep(50);
    await c.cmd('retryAgentTask', { taskId: slow.data.taskId, candidate: 'antigravity:gemini-3.8-pro-high', approved: true })
      .then(() => t.ok('動いている元のタスクは、止めるかどうかを選ばないと断る', false), e => t.ok('動いている元のタスクは、止めるかどうかを選ばないと断る', /止める/.test(e.message), e.message));
    const stopped = await c.cmd('retryAgentTask', { taskId: slow.data.taskId, candidate: 'antigravity:gemini-3.8-pro-high', approved: true, stop: true });
    const slowRow = (await c.cmd('agentTasks')).find(x => x.taskId === slow.data.taskId);
    t.ok('stop なら元のタスクを止めてからやり直す', stopped.task?.routing?.retry?.of === slow.data.taskId && ['cancelling', 'cancelled'].includes(slowRow.status), slowRow.status);
    await c.cmd('setDelegationRouting', { settings: { tiers: null } });

    // ---- 全部だめ・無効
    await c.cmd('setDelegationRouting', { settings: { avoidPercent: 0 } }).then(() => t.ok('不正な設定は断る', false), e => t.ok('不正な設定は断る', /avoidPercent/.test(e.message), e.message));
    state = await c.cmd('setDelegationRouting', { settings: { tiers: { t1: ['claude:haiku'], t2: ['claude:sonnet'], t3: ['codex:gpt-6-sol'], t4: ['claude:opus'] } } });
    t.ok('設定は prefs に重ねて保存し、既定で補う', state.settings.tiers.t1.join() === 'claude:haiku' && state.settings.tiers.tv.join() === 'codex:gpt-6-astra' && state.settings.avoidPercent === 80);
    const none = await call(sid, { kind: 'trivial', task: 'agy-none' });
    t.ok('全部の候補がだめならエラー（飛ばした候補と理由つき）', none.isError && none.text.includes('claude:haiku (t1): unavailable') && none.text.includes('claude:opus (t4): unavailable') && none.text.includes('backend'), none.text);
    state = await c.cmd('setDelegationRouting', { settings: { tiers: null, enabled: false } });
    t.ok('null の項目は既定に戻す', state.settings.tiers.t1.join() === 'antigravity:gemini-3.8-flash-high,claude:haiku' && state.settings.enabled === false);
    const off = await call(sid, { kind: 'trivial', task: 'agy-off' });
    t.ok('無効なら backend を求める', off.isError && off.text.includes('backend'));
    const prefs = JSON.parse(await fs.readFile(path.join(scratch, 'prefs.json'), 'utf8'));
    t.ok('prefs.json には変えた項目だけ', JSON.stringify(prefs.delegationRouting) === '{"enabled":false}', JSON.stringify(prefs.delegationRouting));
    await c.cmd('setDelegationRouting', { settings: { enabled: null } });

    // ---- キーを消す・どこにも残さない
    state = await c.cmd('deleteDelegationRoutingKey', { service: 'openrouter' });
    const before = jevCalls.length;
    const gone = await call(sid, { kind: 'trivial', task: 'agy-after-delete' });
    t.ok('キーを消せば送らない', state.keys.openrouter.hasKey === false && gone.data?.routing?.fallback === 'no_key' && jevCalls.length === before);
    const files = await Promise.all(['agent-tasks.json', 'sessions.json', 'prefs.json'].map(f => fs.readFile(path.join(scratch, f), 'utf8').catch(() => '')));
    t.ok('キーをタスク・会話の記録・設定に書かない', files.every(f => !f.includes(KEY)) && files[0].includes('"routing"'));
    t.ok('キーをサーバーのログに出さない', !server.tail(200).includes(KEY));
    // 後片付け: 走っている子を止める
    for (const task of await c.cmd('agentTasks')) if (['queued', 'running'].includes(task.status)) await c.cmd('cancelAgentTask', { taskId: task.taskId }).catch(() => {});
  } finally {
    c.close(); await server.stop();
    jev.closeAllConnections?.(); await new Promise(r => jev.close(r));
    await fs.rm(scratch, { recursive: true, force: true });
  }
}
