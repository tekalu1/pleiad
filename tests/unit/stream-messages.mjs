// 作業の詳細（Pleiad タスクの子）に、走っているターンの途中を出す（docs/design.md「バックグラウンドの統合」）。
// 出来事（loadSession の live が返す stream.events）を仮の発言に畳む web/stream-messages.mjs と、
// 詳細・メインパネルの配線（client.mjs は文字列で）、fake のサーバーで走っている子を live で読んだ結果を見る
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { streamMessages } from '../../web/stream-messages.mjs';
import { renderToolCall, applyToolResult } from '../../web/render.mjs';
import { startServer, ROOT } from '../lib/server.mjs';
import { open, sleep } from '../lib/ws-client.mjs';

export const name = 'stream-messages';
export const title = '作業の詳細: 走っている子の出来事を仮の発言に畳み、ツールカード・本文を出す（詳細とメインパネルは発言の描き方を共有）';

const seq = (events) => events.map((e, i) => ({ sessionId: 'child', streamSeq: i + 1, ...e }));
const json = (x) => JSON.stringify(x);

export default async function (t) {
  // ---- 畳む関数
  t.ok('出来事が無ければ何も足さない（走っていないときは今までと同じ）',
    json(streamMessages(undefined)) === json({ messages: [], presents: [] }) && json(streamMessages([])) === json({ messages: [], presents: [] }));

  const basic = streamMessages(seq([
    { type: 'activity', state: 'writing' },
    { type: 'text.delta', text: '調べ' }, { type: 'text.delta', text: 'ます' },
    { type: 'tool.start', id: 'c1', name: 'Bash', input: { command: 'ls' } },
    { type: 'tool.result', id: 'c1', text: 'a.txt', isError: false, truncated: false, commandBackground: true },
    { type: 'tool.start', id: 'c2', name: 'Read', input: { file_path: 'a.txt' } },
  ]), { backend: 'antigravity', model: 'gemini-3.8-flash-high' });
  const m0 = basic.messages[0];
  t.ok('本文とツールは 1 つの AI の発言に入る', basic.messages.length === 1 && m0.role === 'assistant' && m0.text === '調べます'
    && m0.toolCalls.map(c => c.name).join() === 'Bash,Read', json(basic.messages));
  t.ok('ツールの結果は出来事の中身だけ（type・id・sessionId・streamSeq を外す）',
    json(m0.toolCalls[0].result) === json({ text: 'a.txt', isError: false, truncated: false, commandBackground: true }), json(m0.toolCalls[0].result));
  t.ok('結果がまだのツールは result を持たない（走っているカード）', !('result' in m0.toolCalls[1]));
  t.ok('発言者は渡したエージェントとモデル', m0.backend === 'antigravity' && m0.model === 'gemini-3.8-flash-high');

  const split = streamMessages(seq([
    { type: 'text.delta', text: 'A' }, { type: 'text.end', uuid: 'u1' },
    { type: 'text.end', uuid: 'u2' }, { type: 'tool.start', id: 't1', name: 'Grep', input: {} },
    { type: 'text.delta', text: 'B' },
    { type: 'tool.start', id: 't1', name: 'Grep', input: {} },
  ]));
  t.ok('text.end で閉じ、閉じた後の text.end とツールは次の発言（Claude のツールだけの発言）、その後の本文はさらに次',
    json(split.messages.map(m => [m.text, (m.toolCalls ?? []).map(c => c.id)])) === json([['A', []], ['', ['t1']], ['B', []]]), json(split.messages));
  t.ok('同じ id の tool.start は 1 枚にする', split.messages[1].toolCalls.length === 1);

  const after = streamMessages(seq([
    { type: 'text.delta', text: 'A' }, { type: 'text.end' }, { type: 'tool.start', id: 'x', name: 'Bash', input: {} }, { type: 'text.delta', text: 'B' },
  ]));
  t.ok('閉じた発言に続くツールは同じ発言、その後の本文は新しい発言', json(after.messages.map(m => [m.text, (m.toolCalls ?? []).length])) === json([['A', 1], ['B', 0]]));

  const para = streamMessages(seq([
    { type: 'text.delta', text: 'A' }, { type: 'tool.start', id: 'x', name: 'Bash', input: {} }, { type: 'text.delta', text: 'B' },
  ]));
  t.ok('ツールを挟んだ本文は段落を分けて同じ発言に続ける', para.messages.length === 1 && para.messages[0].text === 'A\n\nB');

  const think = streamMessages(seq([
    { type: 'thinking.start' }, { type: 'thinking.delta', estimatedTokens: 30 },
    { type: 'thinking.delta', text: '考え' }, { type: 'thinking.delta', text: '中' }, { type: 'text.delta', text: '答え' },
  ]));
  t.ok('考えた内容は平文が来た分だけ畳む', think.messages.length === 1 && think.messages[0].thinking === '考え中' && think.messages[0].text === '答え');
  t.ok('平文の無い考え中（Claude の署名だけ）は空の発言を作らない',
    streamMessages(seq([{ type: 'thinking.start' }, { type: 'thinking.delta', estimatedTokens: 9 }, { type: 'text.end' }])).messages.length === 0);

  const users = streamMessages(seq([
    { type: 'userMessage', messageId: 'm0', text: '依頼', initial: true, pending: true },
    { type: 'userMessage.delivered', messageId: 'm0' },
    { type: 'text.delta', text: 'A' },
    { type: 'userMessage', messageId: 'm1', text: '追加の指示', at: '2026-09-29T01:00:00.000Z', pending: true },
    { type: 'userMessage', messageId: 'm2', text: 'まだ渡していない', pending: true },
    { type: 'userMessage.delivered', messageId: 'm3' },
    { type: 'userMessage', messageId: 'm3', text: '合図が先', pending: true },
    { type: 'userMessage', messageId: 'm4', text: '取り下げ' },
    { type: 'userMessage.dropped', messageId: 'm4' },
    { type: 'userMessage.delivered', messageId: 'm1' },
    { type: 'text.delta', text: 'B' },
  ]), { initialMessageId: 'm0' });
  t.ok('ターンを始めた発言は足さない（サーバーが履歴の末尾に足し済み）', !users.messages.some(m => m.text === '依頼'));
  t.ok('渡った途中送信だけを人の発言にする（渡る前は指示の一覧に出ている）。取り下げは消す',
    json(users.messages.map(m => [m.role, m.text])) === json([['assistant', 'A'], ['user', '追加の指示'], ['user', '合図が先'], ['assistant', 'B']]), json(users.messages));
  t.ok('人の発言の時刻は出来事の時刻', users.messages[1].at === '2026-09-29T01:00:00.000Z');

  const misc = streamMessages(seq([
    { type: 'taskNotice', text: '孫の結果' },
    { type: 'present', kind: 'image', path: 'a.png', at: '2026-09-29T01:00:00.000Z' },
    { type: 'turnResult', outcome: 'aborted', at: 1_790_000_000_000 },
    { type: 'compaction', phase: 'start' }, { type: 'contextWindow', usedTokens: 1 },
  ]));
  t.ok('完了通知は履歴と同じ internalTaskNotice の発言', misc.messages[0].internalTaskNotice === true && misc.messages[0].text === '孫の結果');
  t.ok('提示は presents に畳む（出来事の印を外す）', json(misc.presents) === json([{ kind: 'image', path: 'a.png', at: '2026-09-29T01:00:00.000Z' }]));
  t.ok('中断は履歴と同じ interrupt の行（時刻は ISO）', misc.messages[1].kind === 'interrupt' && misc.messages[1].at === new Date(1_790_000_000_000).toISOString());
  t.ok('圧縮・文脈の量は発言にしない', misc.messages.length === 2);

  // ---- 畳んだツール呼び出しは履歴と同じ部品でカードになる
  const card = renderToolCall(m0.toolCalls[0].name, m0.toolCalls[0].input, { id: m0.toolCalls[0].id });
  applyToolResult(card, m0.toolCalls[0].result);
  t.ok('畳んだツールからカードが描ける（入力と結果が出る）', card.dataset.tool === 'Bash' && card.outerHTML.includes('&quot;ls&quot;') && card.outerHTML.includes('<code>a.txt</code>'), card.outerHTML.slice(0, 200));

  // ---- 配線（client.mjs）
  const source = (await fs.readFile(new URL('../../web/client.mjs', import.meta.url), 'utf8')).replaceAll('\r\n', '\n');
  const body = (name) => { const start = source.indexOf(`function ${name}(`); return source.slice(start, source.indexOf('\n}', start) + 2); };
  const task = body('taskThread');
  t.ok('詳細は live で読み、watch は付けない（メインパネルで見ている会話を書き換えない）',
    task.includes("cmd('loadSession', { sessionId: item.childId, live: true })") && !task.includes('watch'));
  t.ok('詳細は出来事を畳んで保存済みの履歴の後ろに足す',
    task.includes('streamMessages(data.stream?.events') && task.includes('[...(data.messages ?? []), ...live.messages]'));
  t.ok('指示の一覧は畳んだ発言も数える（渡った途中送信を二重に出さない）', task.includes('visibleTaskInstructions(instructionData.instructions ?? [], messages)'));
  const main = body('paintHistoryRows'), readonly = body('readonlyThread'), row = body('historyRow');
  t.ok('メインパネルと詳細は発言 1 件を historyRow で描く', main.includes('historyRow(it.m') && readonly.includes('historyRow(it.m')
    && !main.includes('renderToolCall') && !readonly.includes('renderToolCall'));
  t.ok('詳細は readonly: toolCards に登録せず、委譲のカードに「開く」を付けない',
    readonly.includes('readonly: true') && row.includes('if (c.id && !readonly) state.toolCards.set') && row.includes('if (!readonly) linkDelegateCard'));
  t.ok('接続先の一文は描いている会話で引く', row.includes('noteEndpointFailure(card, c.result, sessionId)') && task.includes('sessionId: item.childId'));

  // ---- サーバー越し: 走っている子を live で読むと、途中のツールと本文が出来事で返る
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-stream-messages-'));
  const server = await startServer({ dataDir: scratch, env: { AGENT_HOST_BACKENDS: 'fake' } });
  const c = await open({ port: server.port, token: server.token, autoAllow: true });
  try {
    const from = c.mark();
    await c.cmd('runTurn', { backend: 'fake', cwd: ROOT, prompt: 'bg-shell 途中の報告' });
    const ev = await c.waitFor(e => e.type === 'phase' && e.state === 'waiting', { from, ms: 20000 });
    const data = await c.cmd('loadSession', { sessionId: ev.sessionId, live: true });
    const folded = streamMessages(data.stream?.events, { backend: 'fake', initialMessageId: data.initialMessageId });
    const all = [...data.messages, ...folded.messages];
    const ai = all.find(m => m.role === 'assistant');
    t.ok('走っている会話を live で読むと、ターン前の履歴と依頼の後に途中の発言が畳める',
      all[0]?.role === 'user' && all[0].text === 'bg-shell 途中の報告' && all.filter(m => m.role === 'user').length === 1, json(all));
    t.ok('途中のツール（結果つき）と本文が 1 つの発言に入る', ai?.toolCalls?.[0]?.name === 'Bash' && ai.toolCalls[0].result?.text === 'launched'
      && ai.text === '途中の報告', json(ai));
    await c.cmd('abort', { sessionId: ev.sessionId });
    await c.waitFor(e => e.type === 'turnEnd' && e.sessionId === ev.sessionId, { from, ms: 10000 });
    const done = await c.cmd('loadSession', { sessionId: ev.sessionId, live: true });
    t.ok('終わった会話は出来事を返さない（保存済みの履歴だけを描く）', !done.stream && json(streamMessages(done.stream?.events).messages) === '[]');
    await sleep(10);
  } finally {
    c.close();
    await server.stop();
    await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}
