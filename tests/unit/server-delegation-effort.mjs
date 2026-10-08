// 委譲の子の思考の強さ（ADR 0164）をサーバー全体で確かめる。委譲先は fake（段を選べる Fast・Smart と、選べない Tiny）。
// 判定器のキーは登録しない（難しさは中）ので、種類 → 段は表の「中」の列で決まる。LLM・実サービスへは送らない
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startServer, ROOT } from '../lib/server.mjs';
import { open, sleep } from '../lib/ws-client.mjs';

export const name = 'server-delegation-effort';
export const title = '委譲の子の思考の強さ: 段の既定・候補ごとの上書き・モデルに合わせる・記録・保存の検査・外した候補の上書きを捨てる';
const prompt = (name, args) => 'ply:' + JSON.stringify({ name, arguments: args });

export default async function (t) {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-routing-effort-'));
  const quota = path.join(scratch, 'quota.json');
  await fs.writeFile(quota, JSON.stringify({ windows: [{ label: 'week', usedPercent: 5, minutes: 10080, resetsAt: new Date(Date.now() + 6 * 86400_000).toISOString() }] }));
  // 会話の既定（設定 › エージェント設定の強さ）は fake が high。tv は「会話の既定に従う」なので、これが子に届く
  await fs.writeFile(path.join(scratch, 'prefs.json'), JSON.stringify({ backends: { fake: { effort: 'high' } },
    delegationRouting: { tiers: { t1: ['fake:fast'], t2: ['fake:tiny'], t3: ['fake:smart'], t4: ['fake:smart'], tv: ['fake:smart'] } } }));
  const server = await startServer({ dataDir: scratch, env: { AGENT_HOST_BACKENDS: 'fake', AGENT_HOST_FAKE_QUOTA: quota, AGENT_HOST_ROUTING_USAGE: 'on' } });
  const c = await open({ port: server.port, token: server.token });
  const turnOn = async (sessionId, text) => {
    for (let i = 0; ; i++) {
      try { return sessionId ? await c.runTurn({ sessionId, prompt: text }) : await c.runTurn({ backend: 'fake', cwd: ROOT, prompt: text }); }
      catch (e) { if (i > 200 || !/切り替え中|実行中|running/.test(e.message)) throw e; await sleep(50); }
    }
  };
  const call = async (sessionId, args) => {
    const from = c.mark();
    const turn = await turnOn(sessionId, prompt('ply_delegate', args));
    const id = sessionId ?? turn.sessionId;
    const ev = await c.waitFor(e => e.type === 'tool.result' && e.sessionId === id, { from, ms: 60000 });
    let data = null;
    try { data = JSON.parse(ev.text); } catch { /* エラーは文 */ }
    return { sessionId: id, isError: ev.isError, text: ev.text, data };
  };
  const save = settings => c.cmd('setDelegationRouting', { settings });
  const rejects = async (settings, re, label) => save(settings).then(() => t.ok(label, false), e => t.ok(label, re.test(e.message), e.message));
  try {
    // ---- 使える候補になるまで待つ
    let state;
    for (let i = 0; i < 200; i++) {
      state = await c.cmd('delegationRouting');
      if (['fake:fast', 'fake:tiny', 'fake:smart'].every(id => state.candidates.find(x => x.candidate === id)?.usable)) break;
      await sleep(100);
    }
    // ---- 状態: 既定値・候補ごとの強さの持ち方・会話の既定
    t.ok('既定の強さ: 段 1 = low・段 2 = medium・段 3 = medium・段 4 = high・創作 = 会話の既定', JSON.stringify(state.defaults.efforts)
      === '{"t1":{"*":"low"},"t2":{"*":"medium"},"t3":{"*":"medium"},"t4":{"*":"high"},"tv":{"*":""}}', JSON.stringify(state.defaults.efforts));
    t.ok('何も保存していなければ設定も既定のまま', JSON.stringify(state.settings.efforts) === JSON.stringify(state.defaults.efforts));
    const cap = id => state.candidates.find(x => x.candidate === id)?.effort;
    t.ok('候補ごとに、そのモデルが持つ強さを返す（持たないモデルは空）', cap('fake:fast')?.levels.join() === 'low,medium,high' && cap('fake:tiny')?.levels.length === 0
      && cap('fake:smart')?.fixed === null, JSON.stringify(state.candidates.map(x => [x.candidate, x.effort])));
    t.ok('会話の既定（エージェント設定の強さ）をエージェントごとに返す', state.conversationEfforts.fake === 'high', JSON.stringify(state.conversationEfforts));

    // ---- 段の既定で決まる
    const sid = (await call(null, { kind: 'trivial', backend: 'fake', task: 'echo:SEED' })).sessionId;
    const t1 = await call(sid, { kind: 'trivial', task: 'echo:T1' });
    t.ok('段 1 の候補は段の既定 low で走る。記録に由来（段の既定・段 1）', !t1.isError && t1.data.routing.tier === 't1' && t1.data.routing.target.effort === 'low'
      && t1.data.routing.effortSource === 'tier' && t1.data.routing.effortTier === 't1' && !('effortAsked' in t1.data.routing), t1.text.slice(0, 400));
    t.ok('タスクの effort も同じ（子の会話の強さ）', t1.data.effort === 'low' || (await c.cmd('agentTasks')).find(x => x.taskId === t1.data.taskId)?.effort === 'low', t1.text.slice(0, 200));
    const t3 = await call(sid, { kind: 'implement', task: 'echo:T3' });
    t.ok('段 3 は medium', t3.data.routing.tier === 't3' && t3.data.routing.target.effort === 'medium' && t3.data.routing.effortSource === 'tier' && t3.data.routing.effortTier === 't3', t3.text.slice(0, 300));
    const t4 = await call(sid, { kind: 'design', task: 'echo:T4' });
    t.ok('段 4 は high', t4.data?.routing?.tier === 't4' && t4.data.routing.target.effort === 'high', t4.text.slice(0, 300));
    const none = await call(sid, { kind: 'mechanical', task: 'echo:NONE' });
    t.ok('強さを持たないモデル（Tiny）には送らない。記録は「調整なし」（none）で、警告も出さない', !none.isError && none.data.routing.tier === 't2' && none.data.routing.target.effort === null
      && none.data.routing.effortSource === 'none' && (await c.cmd('agentTasks')).find(x => x.taskId === none.data.taskId)?.effort === '', none.text.slice(0, 300));
    const tv = await call(sid, { kind: 'visual', task: 'echo:TV' });
    t.ok('創作（tv）は会話の既定に従う（今は high）。記録の強さは走る値', tv.data?.routing?.tier === 'tv' && tv.data.routing.effortSource === 'conversation'
      && tv.data.routing.target.effort === 'high' && !('effortTier' in tv.data.routing), tv.text.slice(0, 300));

    // ---- 設定を変える: 段の既定・上書き・合わせ
    state = await save({ efforts: { t3: { '*': 'max' } } });
    t.ok('段の既定は強さの語彙のどれでも保存できる（モデルが持つかは保存では見ない）', state.settings.efforts.t3['*'] === 'max' && state.settings.efforts.t4['*'] === 'high');
    const fit = await call(sid, { kind: 'implement', task: 'echo:FIT' });
    t.ok('モデルが持たない強さは、近い下の強さに合わせて断らない（max → high）。合わせたことを記録に残す', !fit.isError && fit.data.routing.target.effort === 'high'
      && fit.data.routing.effortSource === 'tier' && fit.data.routing.effortAsked === 'max', fit.text.slice(0, 400));
    state = await save({ efforts: { t3: { '*': 'max', 'fake:smart': 'low' } } });
    const own = await call(sid, { kind: 'implement', task: 'echo:OWN' });
    t.ok('候補の上書きは段の既定に優先する（override）', own.data.routing.target.effort === 'low' && own.data.routing.effortSource === 'override' && own.data.routing.effortTier === 't3'
      && !('effortAsked' in own.data.routing), own.text.slice(0, 300));
    state = await save({ efforts: { t3: { '*': 'max', 'fake:smart': '' } } });
    const conv = await call(sid, { kind: 'implement', task: 'echo:CONV' });
    t.ok('上書きが空なら会話の既定に従う（今は high）', conv.data.routing.target.effort === 'high' && conv.data.routing.effortSource === 'conversation', conv.text.slice(0, 300));
    state = await save({ efforts: { t3: { '*': '' } } });
    const tierConv = await call(sid, { kind: 'implement', task: 'echo:TIERCONV' });
    t.ok('段の既定が空でも会話の既定に従う', tierConv.data.routing.target.effort === 'high' && tierConv.data.routing.effortSource === 'conversation');

    // ---- 固定の委譲は依頼元が書いた値のまま（検査する）
    const pinned = await call(sid, { kind: 'implement', backend: 'fake', model: 'fast', effort: 'low', task: 'echo:PIN' });
    t.ok('固定の委譲は依頼元の強さ。記録にも載る（由来は付けない）', !pinned.isError && pinned.data.routing.mode === 'pinned' && pinned.data.routing.target.effort === 'low' && !('effortSource' in pinned.data.routing), pinned.text.slice(0, 300));
    const badPin = await call(sid, { kind: 'implement', backend: 'fake', model: 'fast', effort: 'max', task: 'echo:BADPIN' });
    t.ok('固定の委譲で持たない強さは今までどおり断る', badPin.isError, badPin.text.slice(0, 200));

    // ---- 別の候補でやり直す: その候補が属する段の強さ
    state = await save({ efforts: null, tiers: { t1: ['fake:fast'], t2: ['fake:tiny'], t3: ['fake:smart'], t4: ['fake:smart', 'fake:fast'], tv: ['fake:smart'] } });
    for (let i = 0; i < 100 && (await c.cmd('agentTasks')).find(x => x.taskId === t1.data.taskId)?.status !== 'completed'; i++) await sleep(100);
    const retried = await c.cmd('retryAgentTask', { taskId: t1.data.taskId, candidate: 'fake:smart', approved: true });
    t.ok('やり直しは、その候補が入っている最初の段（元の段に無ければ）の既定で走る', retried.task?.routing?.mode === 'manual' && retried.task.routing.effortSource === 'tier'
      && retried.task.routing.effortTier === 't3' && retried.task.routing.target.effort === 'medium', JSON.stringify(retried.task?.routing));

    // ---- 保存の検査（形だけ）
    await rejects({ efforts: { t3: { '*': 'extreme' } } }, /不正/, '知らない強さは断る');
    await rejects({ efforts: { t3: { 'nope': 'low' } } }, /不正/, '候補の形でない対象は断る');
    await rejects({ efforts: { t9: { '*': 'low' } } }, /知らない段/, '知らない段は断る');
    await rejects({ efforts: ['low'] }, /形が不正/, '形の違う値は断る');
    await rejects({ efforts: { t3: 'low' } }, /形が不正/, '段の中が形の違う値なら断る');
    state = await save({ efforts: { t3: { '*': 'xhigh', 'claude:sonnet': 'medium' } } });
    t.ok('段に無い候補の上書きは、形が合っていれば断らず持ち越さない', state.settings.efforts.t3['claude:sonnet'] === undefined && state.settings.efforts.t3['*'] === 'xhigh');

    // ---- 外した候補の上書きは捨てる・既定と同じ行は保存しない
    state = await save({ tiers: { t3: ['fake:smart', 'fake:fast'] }, efforts: { t3: { '*': 'medium', 'fake:fast': 'low' } } });
    t.ok('候補の id で結ぶ: 並べ替えても上書きは同じ候補に付く', state.settings.efforts.t3['fake:fast'] === 'low');
    state = await save({ tiers: { t3: ['fake:fast', 'fake:smart'] } });
    t.ok('並べ替えで別の候補に付かない', state.settings.efforts.t3['fake:fast'] === 'low' && state.settings.efforts.t3['fake:smart'] === undefined);
    state = await save({ tiers: { t3: ['fake:smart'] } });
    const prefs = JSON.parse(await fs.readFile(path.join(scratch, 'prefs.json'), 'utf8')).delegationRouting;
    t.ok('候補を外すと、その候補の上書きは保存からも捨てる（段の既定が既定と同じなら行ごと無い）', state.settings.efforts.t3['fake:fast'] === undefined && !JSON.stringify(prefs).includes('fake:fast') && prefs.efforts === undefined, JSON.stringify(prefs));
    state = await save({ efforts: { t3: { '*': 'high' } } });
    t.ok('既定と違う段の既定は保存される（変えた項目だけ）', JSON.parse(await fs.readFile(path.join(scratch, 'prefs.json'), 'utf8')).delegationRouting.efforts?.t3?.['*'] === 'high');
    state = await save({ efforts: null });
    t.ok('null は既定に戻す', JSON.stringify(state.settings.efforts) === JSON.stringify(state.defaults.efforts)
      && JSON.parse(await fs.readFile(path.join(scratch, 'prefs.json'), 'utf8')).delegationRouting.efforts === undefined);

    // 後片付け: 走っている子を止める
    for (const task of await c.cmd('agentTasks')) if (['queued', 'running'].includes(task.status)) await c.cmd('cancelAgentTask', { taskId: task.taskId }).catch(() => {});
  } finally {
    c.close(); await server.stop();
    await fs.rm(scratch, { recursive: true, force: true });
  }
}
