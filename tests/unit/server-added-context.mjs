// Pleiad の指示（core/ply-instructions.mjs、docs/context-runtime.md「Pleiad の指示」）をサーバー全体で確かめる。
// fake の台本「instructions」は実際に渡った ply_agents の instructions をそのまま返すので、依頼元と子で中身が違うことを
// 渡った文面で見る。Codex は身代わり（tests/lib/fake-codex.mjs）の記録で developerInstructions を見る。LLM は呼ばない
//   - 前の版の委譲の指示のスイッチ（prefs.json の addedContext）を引き継ぐ
//   - 自分で足した指示・入れる会話・エージェント・並べ替え・既定の編集と「既定に戻す」・連動の項目
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startServer, ROOT } from '../lib/server.mjs';
import { open, sleep } from '../lib/ws-client.mjs';
import { agentT } from '../../core/i18n.mjs';
import { changePlyInstructions, normalizePlyInstructions, resolvePlyInstructions, itemText, turnInstructions } from '../../core/ply-instructions.mjs';

export const name = 'server-added-context';
export const title = 'Pleiad の指示: 担当によらず届く・依頼元と子で違う・足した指示・既定の編集・前の版のスイッチを引き継ぐ・記録';
const prompt = (name, args) => 'ply:' + JSON.stringify({ name, arguments: args });

export default async function (t) {
  // ---- 保存の形（純粋な計算）
  t.ok('前の版で委譲の指示を切っていたら、委譲の既定の 2 項目を切った状態で引き継ぐ（前の版に無かった codexPolicy は入れたまま）', normalizePlyInstructions(undefined, { delegation: false }).map(i => `${i.id}:${i.on}`).join() === 'delegate:false,child:false,codexPolicy:true'
    && normalizePlyInstructions(undefined, null).every(i => i.on === true) && normalizePlyInstructions(undefined, null).map(i => i.id).join() === 'delegate,child,codexPolicy');
  t.ok('壊れた項目は落とし、既定の項目が欠けていれば足す', normalizePlyInstructions({ items: [{ id: 'u-abcd12', name: 'x' }, { id: 'child', on: false }, { id: '../x' }] }).map(i => `${i.id}:${i.on}`).join() === 'delegate:true,child:false,codexPolicy:true');
  const base = normalizePlyInstructions(undefined);
  const same = changePlyInstructions(base, { action: 'save', id: 'delegate', name: agentT('ja', 'guide.names.delegate'), body: resolvePlyInstructions(base, 'ja')[0].body, target: 'parent', agents: ['claude', 'codex'] }, 'ja');
  t.ok('既定と同じ内容で保存しても「既定から変更」にしない', !resolvePlyInstructions(same, 'ja')[0].modified);
  t.ok('連動の項目はいつも最後で、編集・並べ替えの対象にしない', resolvePlyInstructions(base, 'ja').at(-1).id === 'route'
    && (() => { try { changePlyInstructions(base, { action: 'toggle', id: 'route', on: false }, 'ja'); return false; } catch { return true; } })());
  t.ok('既定の項目は削除できない', (() => { try { changePlyInstructions(base, { action: 'delete', id: 'child' }, 'ja'); return false; } catch { return true; } })());

  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-added-context-'));
  const log = path.join(scratch, 'fake-codex.log');
  // 前の版で委譲の指示を切っていた（prefs.json の addedContext）
  await fs.writeFile(path.join(scratch, 'prefs.json'), JSON.stringify({ addedContext: { delegation: false } }));
  const server = await startServer({ dataDir: scratch, env: { AGENT_HOST_BACKENDS: 'fake,codex',
    AGENT_HOST_CODEX_BIN: `node "${path.join(ROOT, 'tests/lib/fake-codex.mjs')}"`, FAKE_CODEX_LOG: log } });
  const c = await open({ port: server.port, token: server.token, autoAllow: true });
  const bridge = agentT('ja', 'bridge.instructions');
  const listJa = () => resolvePlyInstructions(normalizePlyInstructions(undefined), 'ja');
  const text = id => itemText('ja', listJa().find(i => i.id === id));
  const delegateText = text('delegate'), childText = text('child'), routeText = text('route'), codexPolicyText = text('codexPolicy');
  const lastAnswer = async sessionId => (await c.cmd('loadSession', { sessionId })).messages.findLast(m => m.role === 'assistant')?.text ?? '';
  // 子の完了通知が依頼元の会話で走っている間は次のターンを始められない。空くまで待って頼み直す
  const turnOn = async (sessionId, text) => {
    for (let i = 0; ; i++) {
      try { return await c.runTurn({ sessionId, prompt: text }); }
      catch (e) { if (i > 200 || !/切り替え中|実行中|running/.test(e.message)) throw e; await sleep(50); }
    }
  };
  const ask = async sessionId => { await turnOn(sessionId, 'instructions'); return lastAnswer(sessionId); };
  const added = async sessionId => (await c.cmd('sessionContext', { sessionId }))?.added ?? null;
  const entries = async () => (await fs.readFile(log, 'utf8').catch(() => '')).split('\n').filter(Boolean).map(l => JSON.parse(l));
  const prefs = async () => JSON.parse(await fs.readFile(path.join(scratch, 'prefs.json'), 'utf8'));
  try {
    // ---- 前の版のスイッチを引き継ぐ
    let state = await c.cmd('plyInstructions');
    t.ok('前の版で切っていた委譲の指示は、既定の 2 項目が切れた状態で出る', state.items.map(i => `${i.id}:${i.tag}:${i.on}`).join() === 'delegate:default:false,child:default:false,codexPolicy:default:true,route:linked:true', JSON.stringify(state.items.map(i => [i.id, i.on])));
    t.ok('合計のトークン数は入る項目だけ（切った項目は数えない）', state.total === state.items.find(i => i.id === 'route').tokens + state.items.find(i => i.id === 'codexPolicy').tokens && state.items.every(i => i.tokens > 0));
    const first = await c.runTurn({ backend: 'fake', cwd: ROOT, prompt: 'instructions' });
    const sid = first.sessionId;
    let answer = await lastAnswer(sid);
    t.ok('切った既定は入らず、連動の項目（振り分けの使い方）だけが入る', answer === `${bridge}\n\n${routeText}`, answer.slice(-200));
    let rec = await added(sid);
    t.ok('項目ごとに入れたか・入れなかった理由を記録する', rec?.map(r => `${r.id}:${r.inserted}:${r.reason ?? ''}`).join() === 'delegate:false:off,child:false:off,codexPolicy:false:target,route:true:', JSON.stringify(rec));

    // ---- スイッチを入れる（始まっている会話にも次のターンから）。保存すると前の版の値は消える
    await c.cmd('setPlyInstructions', { action: 'toggle', id: 'delegate', on: true });
    state = await c.cmd('setPlyInstructions', { action: 'toggle', id: 'child', on: true });
    t.ok('スイッチを保存し、前の版の addedContext は消す', state.items.every(i => i.on) && !Object.hasOwn(await prefs(), 'addedContext') && (await prefs()).plyInstructions.items.length === 3);
    answer = await ask(sid);
    t.ok('担当がエージェント任せでも、ply_agents の instructions の後ろに入る（依頼元には委譲の進め方と振り分けの使い方）', answer === `${bridge}\n\n${delegateText}\n\n${routeText}`, answer.slice(-240));
    t.ok('入れた文は項目ごとに見出しが付く', delegateText.startsWith(agentT('ja', 'guide.heading', { name: agentT('ja', 'guide.names.delegate') })));

    // ---- 子の会話
    await c.runTurn({ sessionId: sid, prompt: prompt('ply_delegate', { kind: 'mechanical', backend: 'fake', task: 'instructions' }) });
    let rows;
    for (let i = 0; i < 1200; i++) { rows = await c.cmd('agentTasks'); if (rows[0]?.status === 'completed' && rows[0].notification === 'sent') break; await sleep(50); }
    const task = rows[0];
    // fake はどのエージェントの項目も入れる（Codex だけの codexPolicy も。Claude の子に入らないことは tests/unit/codex-rejections.mjs）
    t.ok('子の会話には子向けの項目だけが入る', task?.result === `${bridge}\n\n${childText}\n\n${codexPolicyText}`, task?.result?.slice(-160));
    const childRec = await added(task.sessionId);
    t.ok('子の会話の記録: 依頼元向けの項目は理由 target', childRec?.find(r => r.id === 'child')?.inserted === true && childRec.find(r => r.id === 'delegate')?.reason === 'target');

    // ---- 自分で足す・入れる会話・エージェント
    state = await c.cmd('setPlyInstructions', { action: 'save', name: '返答は短く', body: '- 結論から書く。', target: 'all', agents: ['claude', 'codex'] });
    const mine = state.items.find(i => i.tag === null);
    t.ok('足した指示は連動の項目の前（保存した並びの最後）に入る', state.items.map(i => i.id).join() === `delegate,child,codexPolicy,${mine?.id},route` && mine.on && mine.tokens > 0);
    const mineText = itemText('ja', mine);
    answer = await ask(sid);
    t.ok('並びの順に入る', answer === `${bridge}\n\n${delegateText}\n\n${mineText}\n\n${routeText}`, answer.slice(-240));
    await c.cmd('setPlyInstructions', { action: 'order', ids: [mine.id, 'delegate', 'child', 'codexPolicy'] });
    answer = await ask(sid);
    t.ok('並べ替えると入る順も変わる', answer === `${bridge}\n\n${mineText}\n\n${delegateText}\n\n${routeText}`, answer.slice(-240));
    await c.cmd('setPlyInstructions', { action: 'save', id: mine.id, name: '返答は短く', body: '- 結論から書く。', target: 'child', agents: ['claude', 'codex'] });
    answer = await ask(sid);
    t.ok('入れる会話を「委譲された会話だけ」にすると依頼元には入らない', !answer.includes(mineText) && (await added(sid)).find(r => r.id === mine.id)?.reason === 'target');
    await c.cmd('setPlyInstructions', { action: 'save', id: mine.id, name: '返答は短く', body: '- 結論から書く。', target: 'all', agents: ['codex'] });
    const badSave = await c.cmd('setPlyInstructions', { action: 'save', name: '', body: 'x', target: 'all', agents: ['claude'] }).then(() => null, e => e);
    const badAgent = await c.cmd('setPlyInstructions', { action: 'save', name: 'x', body: 'x', target: 'all', agents: ['antigravity'] }).then(() => null, e => e);
    t.ok('名前の無い指示・渡す口の無いエージェントは断る', Boolean(badSave) && Boolean(badAgent));

    // ---- 既定の編集と「既定に戻す」
    state = await c.cmd('setPlyInstructions', { action: 'save', id: 'delegate', name: '委譲の進め方', body: '- 3 ファイルまでは自分でやる。', target: 'parent', agents: ['claude', 'codex'] });
    t.ok('既定を編集すると「既定から変更」', state.items[1].id === 'delegate' && state.items[1].modified && state.items[1].tag === 'default');
    answer = await ask(sid);
    t.ok('編集した文が入る', answer.includes('- 3 ファイルまでは自分でやる。') && !answer.includes(agentT('ja', 'guide.delegate')));
    state = await c.cmd('setPlyInstructions', { action: 'reset', id: 'delegate' });
    t.ok('「既定に戻す」で辞書の文へ戻る（編集していない既定は Pleiad の更新で新しい文面になる）', !state.items.find(i => i.id === 'delegate').modified
      && !Object.hasOwn((await prefs()).plyInstructions.items.find(i => i.id === 'delegate'), 'body'));
    await c.cmd('setPlyInstructions', { action: 'delete', id: mine.id });

    // ---- 振り分けを無効にすると連動の項目を入れない
    await c.cmd('setDelegationRouting', { settings: { enabled: false } });
    answer = await ask(sid);
    t.ok('委譲先の自動選択が無効なら振り分けの使い方は入らない', answer === `${bridge}\n\n${delegateText}`, answer.slice(-160));
    t.ok('記録は routingOff', (await added(sid)).find(r => r.id === 'route')?.reason === 'routingOff');
    t.ok('画面の合計にも数えない', (await c.cmd('plyInstructions')).routing === false);
    await c.cmd('setDelegationRouting', { settings: { enabled: null } });

    // ---- Codex: developerInstructions に入り、ロード済みのスレッドでも次のターンから変わる。エージェントで絞れる
    await c.cmd('setPlyInstructions', { action: 'save', name: 'Codex だけ', body: 'CODEX-ONLY', target: 'all', agents: ['codex'] });
    const { sessionId: cx } = await c.cmd('newSession', { backend: 'codex', cwd: ROOT });
    await c.runTurn({ sessionId: cx, prompt: 'hello' });
    const turnsOf = async () => (await entries()).filter(e => e.method === 'turn/start');
    const firstTurn = (await turnsOf()).at(-1);
    t.ok('Codex の developerInstructions に入る（Codex だけの項目も）', firstTurn?.developerInstructions?.includes(delegateText) && firstTurn.developerInstructions.includes('CODEX-ONLY') && firstTurn.developerInstructions.includes(bridge), String(firstTurn?.developerInstructions).slice(-160));
    const stored = normalizePlyInstructions((await prefs()).plyInstructions);
    const forClaude = turnInstructions({ list: stored, locale: 'ja', child: false, routing: true, supported: true, canDelegate: true, agent: 'claude' });
    t.ok('Claude Code の会話には Codex だけの項目を入れず、理由 agent を記録する', forClaude.find(r => r.name === 'Codex だけ')?.reason === 'agent'
      && turnInstructions({ list: stored, locale: 'ja', child: false, routing: true, supported: false, canDelegate: true, agent: null }) === null);
    await c.runTurn({ sessionId: cx, prompt: 'again' });
    const unchanged = await entries();
    t.ok('指示が同じなら外さない（読み込み直さない）', !unchanged.some(e => e.method === 'thread/unsubscribe'));
    await c.cmd('setPlyInstructions', { action: 'toggle', id: 'delegate', on: false });
    await c.runTurn({ sessionId: cx, prompt: 'after off' });
    const after = await entries();
    const offTurn = after.filter(e => e.method === 'turn/start').at(-1);
    t.ok('ロード済みのスレッドは外してから読み直し、新しい指示で走る', after.some(e => e.method === 'thread/unsubscribe' && e.threadId === offTurn?.threadId)
      && !offTurn?.developerInstructions?.includes(delegateText) && offTurn?.developerInstructions?.includes(bridge), JSON.stringify(after.map(e => e.method)));

    // ---- 読み取りのモードでは委譲できないので委譲の項目は入れない（ほかの項目は入る）
    await c.cmd('setPlyInstructions', { action: 'toggle', id: 'delegate', on: true });
    await c.cmd('setTurnSettings', { sessionId: cx, mode: 'readonly' });
    await c.runTurn({ sessionId: cx, prompt: 'readonly' });
    const ro = (await turnsOf()).at(-1);
    const roRec = await added(cx);
    t.ok('読み取りのモードの依頼元には委譲の項目を入れず、理由を記録する', !ro?.developerInstructions?.includes(delegateText) && roRec.find(r => r.id === 'delegate')?.reason === 'readOnly'
      && roRec.find(r => r.id === 'route')?.reason === 'readOnly' && ro.developerInstructions.includes('CODEX-ONLY'));
  } finally {
    c.close();
    await server.stop();
    await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}
