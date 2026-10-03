// 別の会話への送信（sessions.send）・送信待ちの取り消しと送り直し（sessions.messageAction）・既読（sessions.markRead）の中身（ADR 0104）。
// サーバーを立てずに、偽の依存を渡した invoke で確かめる（サーバー越しの検査は server-ops-send）。
//   - 強さの比べ方: 宛先の承認の強さ（範囲・自律のどちらか）が送り手より上なら guarded、同じか弱い方へは write
//   - bypass の送り手は確認なし、読み取り専用の会話は READ_ONLY_MODE、束縛なしは NEEDS_UI
//   - 歯止め: 自分自身・委譲の親子・連鎖の上限・回数の上限。断ったら送り手の会話の記録に残す
//   - 宛先の履歴に出す送り手（sentBy）と、承認モードを渡さないこと
import { createRegistry } from '../../core/ops/registry.mjs';
import { conversationOps, createSendLimiter, strongerMode, RELAY_HOPS_MAX, SEND_RATE } from '../../core/ops/conversations.mjs';

export const name = 'ops-send';
export const title = '別の会話への送信（sessions.send）: 強さの比べ方・bypass・読み取り専用・自分自身と委譲の親子・連鎖と回数の上限・送り手の印、messageAction・markRead';

const ASK = { scope: 'workspace', autonomy: 'ask', label: '都度確認' };
const NEVER = { scope: 'workspace', autonomy: 'never', label: 'auto' };
const PLAN = { scope: 'readonly', autonomy: 'ask', label: 'plan' };
const BYPASS = { scope: 'full', autonomy: 'never', label: 'bypass' };

const agent = (sessionId, via = 'mcp') => ({ by: 'agent', via, ...(sessionId ? { sessionId } : {}) });

export default async function (t) {
  // ---- 強さの比べ方（純関数）
  t.ok('強さ: 自律が上（ask → never）は強い', strongerMode(NEVER, ASK) === true);
  t.ok('強さ: 範囲が上（workspace → full）は強い', strongerMode(BYPASS, ASK) === true);
  t.ok('強さ: 同じは強くない', strongerMode(ASK, ASK) === false && strongerMode(BYPASS, BYPASS) === false);
  t.ok('強さ: 弱い方へは強くない（never → ask・full → readonly）', strongerMode(ASK, NEVER) === false && strongerMode(PLAN, BYPASS) === false);
  t.ok('強さ: 範囲が下でも自律が上なら強い（readonly・never は workspace・ask より強い）', strongerMode({ scope: 'readonly', autonomy: 'never' }, ASK) === true);
  t.ok('強さ: 宣言の無いモードは弱い側（workspace・ask）として比べる', strongerMode(undefined, ASK) === false && strongerMode(ASK, undefined) === false && strongerMode(NEVER, undefined) === true);

  let clock = 0;
  const limiter = createSendLimiter({ max: 2, windowMs: 1000, now: () => clock });
  limiter.note('a'); limiter.note('a');
  const blocked = !limiter.allowed('a') && limiter.allowed('b');
  clock = 1000;
  t.ok('回数の上限: 窓の中で max 件を超えると断り、窓を過ぎると戻る（送り手ごと）', blocked && limiter.allowed('a'));

  // ---- 偽の依存
  const registry = createRegistry({ ops: conversationOps });
  const row = (id, over = {}) => ({ id, title: `会話 ${id}`, backend: 'fake', delegation: null, ...over });
  const rows = {
    ask: row('ask'), never: row('never'), plan: row('plan'), bypass: row('bypass'), relayed: row('relayed'), busy: row('busy'),
    child: row('child', { delegation: { parentSessionId: 'ask' } }),
  };
  const modes = { ask: ASK, never: NEVER, plan: PLAN, bypass: BYPASS, relayed: ASK, busy: ASK, child: ASK };
  const hops = { relayed: RELAY_HOPS_MAX };
  let sent = [], refused = [], audits = [], approvals = [], reads = [], actions = [];
  const outbox = { never: [{ id: 'q1', status: 'failed', args: { prompt: 'x' } }], ask: [{ id: 'q2', status: 'queued', args: { prompt: 'y' } }] };
  const deps = ({ approve } = {}) => ({
    locale: 'ja',
    modeOf: async (id) => modes[id],
    audit: (e) => audits.push(e),
    ...(approve ? { approve } : {}),
    sessions: { get: async (id) => (rows[id] ? { row: rows[id], children: [], history: [] } : null) },
    conversations: {
      modesOf: async (id) => (modes[id] ? [modes[id]] : []),
      relayHops: (id) => hops[id] ?? 0,
      refused: async (x) => { refused.push(x); },
      send: async (x) => { sent.push(x); return { id: `send-${sent.length}`, status: 'queued' }; },
      outbox: async (id) => structuredClone(outbox[id] ?? []),
      messageAction: async (...a) => { actions.push(a); },
      markRead: async (id, at) => { reads.push([id, at]); return { sessionId: id, readAt: at ?? 5, changed: true }; },
    },
  });
  const send = (from, to, extra = {}, d = deps()) => registry.invoke(agent(from), 'sessions.send', { sessionId: to, text: 'こんにちは', ...extra }, d);

  // ---- 強さと承認
  const same = await send('ask', 'busy', { reason: '調べた結果を渡す' });
  t.ok('同じ強さの会話へは write で送れる（承認なし）', same.ok && !same.pending && same.result.messageId === 'send-1' && same.result.status === 'queued', JSON.stringify(same));
  t.ok('送り手の印: by・via・送り手の会話の id・題・エージェント・連鎖の数。承認モードは渡さない（宛先のモードで走る）',
    sent[0].sentBy.by === 'agent' && sent[0].sentBy.via === 'mcp' && sent[0].sentBy.sessionId === 'ask' && sent[0].sentBy.title === '会話 ask'
      && sent[0].sentBy.backend === 'fake' && sent[0].sentBy.hops === 1 && !('mode' in sent[0]) && sent[0].reason === '調べた結果を渡す', JSON.stringify(sent[0]));
  t.ok('記録: 送り手の会話に op の記録（write）', audits.some((e) => e.op === 'sessions.send' && e.risk === 'write' && e.actor.sessionId === 'ask'));
  t.ok('弱い会話へは write（never → ask）', (await send('never', 'ask')).ok === true);
  const weakToStrong = await send('ask', 'never');
  t.ok('弱い → 強い（ask → never）は guarded。承認の口が無ければ NEEDS_APPROVAL', !weakToStrong.ok && weakToStrong.code === 'NEEDS_APPROVAL', JSON.stringify(weakToStrong));
  const before = sent.length;
  const card = await send('ask', 'bypass', {}, deps({ approve: async (x) => { approvals.push(x); return { pending: true, requestId: 'setting-1' }; } }));
  t.ok('弱い → 強い（範囲 workspace → full）は承認カード（待たずに PENDING_APPROVAL）。まだ送らない', card.ok && card.pending && card.result.code === 'PENDING_APPROVAL' && sent.length === before, JSON.stringify(card));
  t.ok('承認カードの一文: 宛先の題・宛先の承認モード・本文', approvals[0]?.op === 'sessions.send' && /会話 bypass/.test(approvals[0].change.note) && /bypass/.test(approvals[0].change.note) && /こんにちは/.test(approvals[0].change.note), JSON.stringify(approvals[0]?.change));
  await approvals[0].proceed();
  t.ok('許可されたら送る（受領証が合えば）', sent.length === before + 1 && sent.at(-1).sessionId === 'bypass');
  const fromBypass = await send('bypass', 'never');
  t.ok('bypass（範囲 full・自律 never）の送り手は確認なしで通る', fromBypass.ok && !fromBypass.pending);
  const plan = await send('plan', 'ask');
  t.ok('読み取り専用の会話からは断る（READ_ONLY_MODE）', !plan.ok && plan.code === 'READ_ONLY_MODE', JSON.stringify(plan));
  const unbound = await registry.invoke({ by: 'agent', via: 'cli' }, 'sessions.send', { sessionId: 'ask', text: 'x' }, deps());
  t.ok('会話に束縛されていない呼び出し（外の CLI）は NEEDS_UI', !unbound.ok && unbound.code === 'NEEDS_UI', JSON.stringify(unbound));
  t.ok('人（画面）の口には出していない（画面の送信は WS の sendMessage）', (await registry.invoke({ by: 'human', via: 'ui', local: true }, 'sessions.send', { sessionId: 'ask', text: 'x' }, deps())).code === 'NOT_FOUND');

  // ---- 歯止め
  refused = [];
  const self = await send('ask', 'ask');
  t.ok('自分自身へは断る（SEND_SELF）', !self.ok && self.code === 'SEND_SELF', JSON.stringify(self));
  t.ok('断った理由を送り手の会話の記録に残す', refused.some((r) => r.code === 'SEND_SELF' && r.actor.sessionId === 'ask' && r.op === 'sessions.send' && r.sessionId === 'ask'));
  t.ok('自分が委譲した子へは断る（ply_task_send へ誘導）', (await send('ask', 'child')).code === 'SEND_TO_CHILD');
  t.ok('委譲の子から依頼元へは断る（結果は自動で届く）', (await send('child', 'ask')).code === 'SEND_TO_PARENT');
  const chained = await send('relayed', 'ask');
  t.ok(`連鎖の上限: 別の会話からの発言で始まったターン（連鎖 ${RELAY_HOPS_MAX}）からは送れない（RELAY_LIMIT）`, !chained.ok && chained.code === 'RELAY_LIMIT' && chained.error.includes(String(RELAY_HOPS_MAX)), JSON.stringify(chained));
  hops.relayed = RELAY_HOPS_MAX - 1;
  const last = sent.length;
  t.ok('連鎖の上限の 1 つ手前までは送れ、連鎖の数を 1 つ足して渡す', (await send('relayed', 'ask')).ok && sent[last].sentBy.hops === RELAY_HOPS_MAX);
  t.ok('無い会話は SESSION_NOT_FOUND（承認カードの前）', (await send('ask', 'nothing')).code === 'SESSION_NOT_FOUND');
  t.ok('空の本文は INVALID', (await send('ask', 'busy', { text: '  ' })).code === 'INVALID');
  // 回数の上限（送り手ごと）。ask はここまでに送った分も数える
  let rate = null;
  for (let i = 0; i < SEND_RATE.max + 1 && !rate; i++) {
    const r = await send('ask', 'busy');
    if (!r.ok) rate = r;
  }
  t.ok(`回数の上限: 同じ送り手から ${SEND_RATE.windowMs / 60_000} 分に ${SEND_RATE.max} 件を超えると断る（SEND_RATE）`, rate?.code === 'SEND_RATE', JSON.stringify(rate));
  t.ok('回数の上限は送り手ごと（別の会話からは送れる）', (await send('never', 'busy')).ok === true);

  // ---- messageAction
  const cancel = await registry.invoke(agent('ask'), 'sessions.messageAction', { messageId: 'q2', action: 'cancel' }, deps());
  t.ok('messageAction: AI は sessionId を省けば自分の会話。取り消しは write', cancel.ok && actions.at(-1).join() === 'ask,q2,cancel' && cancel.result.messageId === 'q2', JSON.stringify(cancel));
  const retryStrong = await registry.invoke(agent('ask'), 'sessions.messageAction', { sessionId: 'never', messageId: 'q1', action: 'retry' }, deps());
  t.ok('messageAction: 強い会話の送り直しは guarded（NEEDS_APPROVAL）', retryStrong.code === 'NEEDS_APPROVAL', JSON.stringify(retryStrong));
  const cancelStrong = await registry.invoke(agent('ask'), 'sessions.messageAction', { sessionId: 'never', messageId: 'q1', action: 'cancel' }, deps());
  t.ok('messageAction: 強い会話でも取り消しは write', cancelStrong.ok === true);
  t.ok('messageAction: 送信待ちに無い id は MESSAGE_NOT_FOUND', (await registry.invoke(agent('ask'), 'sessions.messageAction', { messageId: 'zz', action: 'cancel' }, deps())).code === 'MESSAGE_NOT_FOUND');
  const ui = await registry.invoke({ by: 'human', via: 'ui', local: true }, 'sessions.messageAction', { sessionId: 'never', messageId: 'q1', action: 'retry' }, deps());
  t.ok('messageAction: 画面（人）は送信待ちの全部を読む（今までの返り）', ui.ok && Array.isArray(ui.result) && ui.result[0].id === 'q1', JSON.stringify(ui));

  // ---- markRead
  const read = await registry.invoke(agent('ask'), 'sessions.markRead', { sessionId: 'never' }, deps());
  t.ok('markRead: write。at を省くと今の完了まで（本体に undefined を渡す）', read.ok && reads.at(-1)[0] === 'never' && reads.at(-1)[1] === undefined && read.result.changed === true, JSON.stringify(read));
  const readUi = await registry.invoke({ by: 'human', via: 'ui', local: true }, 'sessions.markRead', { sessionId: 'never', at: 7 }, deps());
  t.ok('markRead: 画面は変わった分（reads）を読む', readUi.ok && JSON.stringify(readUi.result) === JSON.stringify({ reads: [['never', 7]] }), JSON.stringify(readUi));
  t.ok('markRead: 読み取り専用の会話からは断る', (await registry.invoke(agent('plan'), 'sessions.markRead', { sessionId: 'ask' }, deps())).code === 'READ_ONLY_MODE');
}
