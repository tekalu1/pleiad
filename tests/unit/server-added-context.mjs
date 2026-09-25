// Pleiad が入れる指示（委譲の指示。core/added-context.mjs、docs/context-runtime.md「Pleiad が入れる指示」）をサーバー全体で確かめる。
// fake の台本「instructions」は実際に渡った ply_agents の instructions をそのまま返すので、依頼元と子で中身が違うことを
// 渡った文面で見る。Codex は身代わり（tests/lib/fake-codex.mjs）の記録で developerInstructions を見る。LLM は呼ばない
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startServer, ROOT } from '../lib/server.mjs';
import { open, sleep } from '../lib/ws-client.mjs';
import { agentT } from '../../core/i18n.mjs';
import { delegationParentText, delegationChildText } from '../../core/added-context.mjs';

export const name = 'server-added-context';
export const title = 'Pleiad が入れる委譲の指示: 担当によらず届く・依頼元と子で違う・切り替えと振り分けの有無が次のターンから効く・記録';
const prompt = (name, args) => 'ply:' + JSON.stringify({ name, arguments: args });

export default async function (t) {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-added-context-'));
  const log = path.join(scratch, 'fake-codex.log');
  const server = await startServer({ dataDir: scratch, env: { AGENT_HOST_BACKENDS: 'fake,codex',
    AGENT_HOST_CODEX_BIN: `node "${path.join(ROOT, 'tests/lib/fake-codex.mjs')}"`, FAKE_CODEX_LOG: log } });
  const c = await open({ port: server.port, token: server.token, autoAllow: true });
  const lead = agentT('ja', 'guide.lead'), route = agentT('ja', 'guide.route'), child = delegationChildText('ja');
  const bridge = agentT('ja', 'bridge.instructions');
  const parentFull = delegationParentText('ja', { routing: true });
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
  try {
    // ---- 設定の口
    const state = await c.cmd('addedContext');
    t.ok('既定で入れる。画面用に依頼元と子の文を返す', state.settings.delegation === true && state.routing === true
      && state.items[0].id === 'delegation' && state.items[0].parent === parentFull && state.items[0].child === child, JSON.stringify(state).slice(0, 200));

    // ---- 依頼元の会話（コンテキストの担当は既定のエージェント任せのまま）
    const first = await c.runTurn({ backend: 'fake', cwd: ROOT, prompt: 'instructions' });
    const sid = first.sessionId;
    const text = await lastAnswer(sid);
    t.ok('担当がエージェント任せでも、ply_agents の instructions の後ろに 1〜3 が入る', text === `${bridge}\n\n${parentFull}`, text.slice(-200));
    t.ok('入れた文は 1 回だけ', text.split(lead).length === 2);
    const rec = await added(sid);
    t.ok('会話の記録に何を入れたかが残る（右パネル用）', rec?.length === 1 && rec[0].variant === 'parent' && rec[0].text === parentFull, JSON.stringify(rec));

    // ---- 子の会話
    await c.runTurn({ sessionId: sid, prompt: prompt('ply_delegate', { kind: 'mechanical', backend: 'fake', task: 'instructions' }) });
    let rows;
    for (let i = 0; i < 1200; i++) { rows = await c.cmd('agentTasks'); if (rows[0]?.status === 'completed' && rows[0].notification === 'sent') break; await sleep(50); }
    const task = rows[0];
    t.ok('子の会話には「さらに委譲しない」だけが入り、1〜3 は入らない', task?.result === `${bridge}\n\n${child}` && !task.result.includes(lead), task?.result?.slice(-160));
    const childRec = await added(task.sessionId);
    t.ok('子の会話の記録は variant: child', childRec?.[0]?.variant === 'child' && childRec[0].text === child);

    // ---- 切り替え（始まっている会話にも次のターンから）
    const off = await c.cmd('setAddedContext', { delegation: false });
    t.ok('オフを保存する', off.settings.delegation === false && off.items[0].enabled === false);
    const offText = await ask(sid);
    t.ok('オフにすると次のターンから入らない（ply_agents の instructions だけ）', offText === bridge, offText.slice(-120));
    const offRec = await added(sid);
    t.ok('入れなかったことと理由を記録する', offRec?.[0]?.variant === null && offRec[0].reason === 'off');
    await c.cmd('setAddedContext', { delegation: true });
    const bad = await c.cmd('setAddedContext', { delegation: 'yes' }).then(() => null, e => e);
    t.ok('真偽以外は断る', Boolean(bad));

    // ---- 振り分けを無効にすると 3 を入れない
    await c.cmd('setDelegationRouting', { settings: { enabled: false } });
    const manual = await ask(sid);
    t.ok('委譲先の自動選択が無効なら 3 を除いた 1・2 だけ', manual.includes(lead) && !manual.includes(route) && manual.endsWith(delegationParentText('ja', { routing: false })), manual.slice(-160));
    t.ok('記録は parentManual', (await added(sid))?.[0]?.variant === 'parentManual');
    t.ok('画面の文も振り分けに合わせる', (await c.cmd('addedContext')).items[0].parent === delegationParentText('ja', { routing: false }));
    await c.cmd('setDelegationRouting', { settings: { enabled: null } });

    // ---- Codex: developerInstructions に入り、ロード済みのスレッドでも次のターンから変わる
    const { sessionId: cx } = await c.cmd('newSession', { backend: 'codex', cwd: ROOT });
    await c.runTurn({ sessionId: cx, prompt: 'hello' });
    const turnsOf = async () => (await entries()).filter(e => e.method === 'turn/start');
    const firstTurn = (await turnsOf()).at(-1);
    t.ok('Codex の developerInstructions に 1〜3 が入る', firstTurn?.developerInstructions?.includes(parentFull) && firstTurn.developerInstructions.includes(bridge), String(firstTurn?.developerInstructions).slice(-120));
    await c.runTurn({ sessionId: cx, prompt: 'again' });
    const unchanged = await entries();
    t.ok('指示が同じなら外さない（読み込み直さない）', !unchanged.some(e => e.method === 'thread/unsubscribe'));
    await c.cmd('setAddedContext', { delegation: false });
    await c.runTurn({ sessionId: cx, prompt: 'after off' });
    const after = await entries();
    const offTurn = after.filter(e => e.method === 'turn/start').at(-1);
    t.ok('ロード済みのスレッドは外してから読み直し、新しい指示で走る', after.some(e => e.method === 'thread/unsubscribe' && e.threadId === offTurn?.threadId)
      && !offTurn?.developerInstructions?.includes(lead) && offTurn?.developerInstructions?.includes(bridge), JSON.stringify(after.map(e => e.method)));

    // ---- 読み取りのモードでは委譲できないので入れない
    await c.cmd('setAddedContext', { delegation: true });
    await c.cmd('setTurnSettings', { sessionId: cx, mode: 'readonly' });
    await c.runTurn({ sessionId: cx, prompt: 'readonly' });
    const ro = (await turnsOf()).at(-1);
    t.ok('読み取りのモードの依頼元には入れず、理由を記録する', !ro?.developerInstructions?.includes(lead) && (await added(cx))?.[0]?.reason === 'readOnly');
  } finally {
    c.close();
    await server.stop();
    await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}
