// 別の会話への送信（sessions.send。ADR 0104）をサーバー越しに（fake バックエンド。LLM もネットワークも要らない）。
//   - 会話に束縛された接続から送ると、宛先の会話の送信待ちに積まれ、宛先の承認モードで走る（fake は echo: の本文を返す）
//   - 宛先の履歴と流れに送り手の印（sentBy）。宛先の変更の記録に誰が・どこから・なぜ
//   - 送り手より強い宛先は承認カード（許可したら送る）、自分自身は断って記録に残す
//   - 連鎖の上限: 別の会話から来た発言で始まったターンが送り続けると、3 回を超えたところで断る
//   - sessions.markRead と、画面の markRead（まとめて送る形）・messageAction が今までどおり動く
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startServer, ROOT } from '../lib/server.mjs';
import { open } from '../lib/ws-client.mjs';
import { RELAY_HOPS_MAX } from '../../core/ops/conversations.mjs';

export const name = 'server-ops-send';
export const title = '別の会話への送信をサーバー越しに: 宛先で走る・送り手の印・承認カード・自分自身・連鎖の上限・既読';

export default async function (t) {
  const scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'agent-host-ops-send-')));
  const server = await startServer({ env: { AGENT_HOST_BACKENDS: 'fake' }, dataDir: path.join(scratch, 'data'), timeoutMs: 60_000 });
  const c = await open({ port: server.port, token: server.token });
  const base = `http://127.0.0.1:${server.port}`;
  try {
    const api = async (token, op, body) => {
      const res = await fetch(`${base}/api/ops/${op}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
      return { status: res.status, body: await res.json().catch(() => null) };
    };
    const start = async (mode, title) => {
      const turn = await c.runTurn({ prompt: 'control-info', sessionId: null, cwd: ROOT, backend: 'fake', mode }, { ms: 30_000 });
      if (title) await c.cmd('setTitle', { sessionId: turn.sessionId, title });
      const loaded = await c.cmd('loadSession', { sessionId: turn.sessionId });
      return { sessionId: turn.sessionId, token: JSON.parse(loaded.messages.at(-1).text).token };
    };
    const turnEnd = (sessionId, from) => c.waitFor((e) => e.type === 'turnEnd' && e.sessionId === sessionId, { from, ms: 30_000 });
    const messagesOf = async (sessionId) => (await c.cmd('loadSession', { sessionId })).messages;
    const changesOf = async (token, sessionId) => (await api(token, 'sessions.changes', { sessionId, limit: 100 })).body.result.changes;

    const sender = await start('default', '送り手');
    const target = await start('default', '宛先');
    const strong = await start('auto', '強い宛先');

    // ---- 同じ強さの会話へ送る
    let from = c.mark();
    const sent = await api(sender.token, 'sessions.send', { sessionId: target.sessionId, text: 'echo:代わりに返事', reason: '結果を渡す' });
    t.ok('束縛された接続から同じ強さの会話へ送れる（200・messageId）', sent.status === 200 && sent.body.ok && /^send-/.test(sent.body.result.messageId), JSON.stringify(sent.body));
    await turnEnd(target.sessionId, from);
    const live = c.events.slice(from).find((e) => e.type === 'userMessage' && e.sessionId === target.sessionId && e.messageId === sent.body.result.messageId);
    t.ok('流れの発言（userMessage）に送り手の印（会話の id・題）。連鎖の数は出さない', live?.sentBy?.sessionId === sender.sessionId && live.sentBy.title === '送り手' && !('hops' in live.sentBy), JSON.stringify(live));
    const after = await messagesOf(target.sessionId);
    const relayed = after.find((m) => m.role === 'user' && m.text === 'echo:代わりに返事');
    t.ok('宛先の履歴の発言に送り手の印（読み直しても残る）', relayed?.sentBy?.sessionId === sender.sessionId && relayed.sentBy.by === 'agent' && relayed.sentBy.via === 'cli', JSON.stringify(relayed));
    t.ok('宛先で走って答える（宛先のターン）', after.at(-1).role === 'assistant' && after.at(-1).text === '代わりに返事', JSON.stringify(after.at(-1)));
    t.ok('人の発言には印が付かない', !after.find((m) => m.role === 'user' && m.text === 'control-info')?.sentBy);
    const targetChange = (await changesOf(sender.token, target.sessionId)).find((x) => x.field === 'message' && x.to === sent.body.result.messageId);
    t.ok('宛先の変更の記録: by agent・via・送り手の会話・理由', targetChange?.by === 'agent' && targetChange.via === 'cli' && targetChange.bySession === sender.sessionId && targetChange.reason === '結果を渡す', JSON.stringify(targetChange));
    t.ok('送り手の変更の記録: 呼んだ操作（field: op）', (await changesOf(sender.token, sender.sessionId)).some((x) => x.field === 'op' && x.to === 'sessions.send'));

    // ---- 強い会話へは承認カード
    from = c.mark();
    const asked = await api(sender.token, 'sessions.send', { sessionId: strong.sessionId, text: 'echo:許可された送信' });
    const card = await c.waitFor((e) => e.type === 'permission' && e.settingChange && e.sessionId === sender.sessionId, { from, ms: 15_000 });
    t.ok('送り手より強い宛先へは承認待ち（202・PENDING_APPROVAL）と、送り手の会話に承認カード', asked.status === 202 && asked.body.result.code === 'PENDING_APPROVAL'
      && card.settingChange.op === 'sessions.send' && /強い宛先/.test(card.settingChange.note), JSON.stringify({ body: asked.body, change: card.settingChange }));
    t.ok('許可するまでは宛先に積まない', !(await c.cmd('listMessages', { sessionId: strong.sessionId })).some((m) => m.args?.prompt === 'echo:許可された送信'));
    await c.cmd('resolvePermission', { id: card.id, allow: true, receipt: card.settingChange.receipt });
    await turnEnd(strong.sessionId, from);
    const strongMessages = await messagesOf(strong.sessionId);
    t.ok('許可したら送られ、宛先が答える', strongMessages.some((m) => m.role === 'user' && m.text === 'echo:許可された送信' && m.sentBy?.sessionId === sender.sessionId) && strongMessages.at(-1).text === '許可された送信');
    await turnEnd(sender.sessionId, from);   // 承認の結果の通知で送り手のターンが 1 回走る

    // ---- 自分自身
    const self = await api(sender.token, 'sessions.send', { sessionId: sender.sessionId, text: 'echo:x' });
    t.ok('自分自身へは断る（403・SEND_SELF）', self.status === 403 && self.body.code === 'SEND_SELF', JSON.stringify(self.body));
    t.ok('断った理由が送り手の会話の記録に残る（field: opRefused）', (await changesOf(sender.token, sender.sessionId)).some((x) => x.field === 'opRefused' && x.to === 'sessions.send' && x.reason === 'SEND_SELF'));

    // ---- 連鎖の上限。人が a に頼む → a が b へ → b が c へ → c が d へ → d が e へ（ここで上限を超える）
    const chain = [];
    for (const name of ['a', 'b', 'c', 'd', 'e']) chain.push(await start('default', `連鎖 ${name}`));
    const sendCall = (to, text) => `control:${JSON.stringify({ name: 'call_op', arguments: { op: 'sessions.send', args: { sessionId: to, text } } })}`;
    let prompt = 'echo:届かないはず';
    for (let i = chain.length - 1; i >= 1; i--) prompt = sendCall(chain[i].sessionId, prompt);
    from = c.mark();
    await c.runTurn({ prompt, sessionId: chain[0].sessionId, cwd: ROOT, backend: 'fake', mode: 'default' }, { ms: 30_000 });
    await turnEnd(chain[RELAY_HOPS_MAX].sessionId, from);
    const last = (await messagesOf(chain[RELAY_HOPS_MAX].sessionId)).at(-1);
    t.ok(`連鎖 ${RELAY_HOPS_MAX} の会話からの送信は断る（RELAY_LIMIT）`, last.role === 'assistant' && last.text.includes('RELAY_LIMIT'), last.text);
    t.ok('連鎖の上限までの会話には届いている（b・c・d の履歴に送り手の印）', (await Promise.all(chain.slice(1, RELAY_HOPS_MAX + 1).map((s, i) => messagesOf(s.sessionId)
      .then((ms) => ms.some((m) => m.role === 'user' && m.sentBy?.sessionId === chain[i].sessionId))))).every(Boolean));
    t.ok('上限を超えた先（e）には届かない', !(await messagesOf(chain.at(-1).sessionId)).some((m) => m.text === 'echo:届かないはず'));

    // ---- 既読
    from = c.mark();
    const read = await api(sender.token, 'sessions.markRead', { sessionId: target.sessionId });
    t.ok('sessions.markRead: at を省くと今の完了まで既読にし、全画面へ read を知らせる', read.status === 200 && read.body.result.changed === true && read.body.result.readAt > 0
      && c.events.slice(from).some((e) => e.type === 'read' && e.reads.some(([id]) => id === target.sessionId)), JSON.stringify(read.body));
    t.ok('sessions.markRead: もう一度は changed: false（巻き戻らない）', (await api(sender.token, 'sessions.markRead', { sessionId: target.sessionId, at: 1 })).body.result.changed === false);
    const bulk = await c.cmd('markRead', { reads: [[strong.sessionId, Date.now() + 60_000]] });
    t.ok('画面の markRead（まとめて送る形）は今までどおり変わった分を返す', Array.isArray(bulk.reads) && bulk.reads.length === 1 && bulk.reads[0][0] === strong.sessionId, JSON.stringify(bulk));
    const single = await c.cmd('markRead', { sessionId: target.sessionId, at: 1 });
    t.ok('画面の markRead（1 件の形）は sessions.markRead を通る', Array.isArray(single.reads) && single.reads.length === 0, JSON.stringify(single));
  } finally {
    c.close();
    await server.stop();
    await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}
