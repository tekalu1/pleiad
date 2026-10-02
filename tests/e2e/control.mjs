// ply_control（操作の一覧。ADR 0081）が実エージェント（Claude）に渡り、検索と設定の読み出しを呼んで結果を使えること。
// 別の会話に目印を残し、新しい会話で search_sessions に探させ、get_setting で設定の値を読ませる。
// 承認が要る設定の変更（set_setting で確認を切る）は待たずに承認待ちで返ってターンが終わり、後で許可すると、結果の通知がその会話に届いて Claude が答える（ADR 0088）。
import crypto from 'node:crypto';

export const name = 'control';
export const title = 'Claude が ply_control の search_sessions と get_setting を呼び、結果を使う。set_setting の承認は待たずに返り、許可の結果が会話に届く';
export const serverEnv = { AGENT_HOST_BACKENDS: 'claude' };

export default async function (t, ctx) {
  const c = await ctx.open({ autoAllow: true });
  let before = null;
  try {
    const agents = await c.cmd('backends');
    if (!agents.some((a) => a.id === 'claude')) { t.ok('claude が利用可能', false); return; }
    before = await c.cmd('prefs');
    await c.cmd('setPref', { key: 'linkOpen', value: 'external' });

    // 1. 探される側の会話: 目印を含む発言を残す
    const marker = `CTRL_${crypto.randomBytes(5).toString('hex').toUpperCase()}`;
    const target = await c.cmd('newSession', { backend: 'claude', cwd: ctx.work });
    await c.cmd('setTurnSettings', { sessionId: target.sessionId, backend: 'claude', model: 'haiku' });
    const seeded = await c.runTurn({ sessionId: target.sessionId, prompt: `Reply with exactly ${marker}. Do not use tools or change files.` }, { ms: 180000 });
    t.ok('目印の会話を作れた', seeded.outcome === 'ok', seeded.outcome ?? seeded.events.find((e) => e.error)?.error);

    // 2. 探す側の会話: ply_control のツールを使わせる
    const asker = await c.cmd('newSession', { backend: 'claude', cwd: ctx.work });
    await c.cmd('setTurnSettings', { sessionId: asker.sessionId, backend: 'claude', model: 'haiku' });
    const turn = await c.runTurn({
      sessionId: asker.sessionId,
      prompt: `Pleiad の ply_control の MCP ツールを使って答えて（シェルやファイル操作は使わない）。1) search_sessions で ${marker} を検索し、見つかった会話の sessionId をそのまま書く。2) get_setting で key が linkOpen の設定の value を書く。最後に「SESSION=<sessionId> LINKOPEN=<value>」の 1 行で答える。`,
    }, { ms: 240000 });
    t.ok('ターンが完了した', turn.outcome === 'ok', turn.outcome ?? turn.events.find((e) => e.error)?.error);
    t.ok('search_sessions が呼ばれた（mcp__ply_control__search_sessions）', turn.tools.some((n) => /ply_control.*search_sessions/.test(n)), turn.tools.join(', '));
    t.ok('get_setting が呼ばれた（mcp__ply_control__get_setting）', turn.tools.some((n) => /ply_control.*get_setting/.test(n)), turn.tools.join(', '));
    const history = await c.cmd('loadSession', { sessionId: asker.sessionId });
    const reply = history.messages.filter((m) => m.role === 'assistant').map((m) => m.text).join('\n');
    t.ok('検索の結果（目印の会話の id）を答えに使った', reply.includes(target.sessionId), reply.slice(-300));
    t.ok('設定の値（linkOpen = external）を答えに使った', /LINKOPEN\s*=\s*external/i.test(reply), reply.slice(-300));

    // 3. 承認が要る設定の変更: 待たずに返り、ターンは終わる。後で許可すると、結果がその会話に届く
    await c.cmd('setPref', { key: 'confirmAgentSites', value: true });
    const changer = await c.cmd('newSession', { backend: 'claude', cwd: ctx.work });
    await c.cmd('setTurnSettings', { sessionId: changer.sessionId, backend: 'claude', model: 'haiku' });
    const from = c.mark();
    const asked = await c.runTurn({
      sessionId: changer.sessionId,
      prompt: 'Pleiad の ply_control の set_setting で、key が confirmAgentSites の設定を false に変えて（reason は「e2e の確認」）。返りの status をそのまま 1 行で書いて、ターンを終えて。承認を待ったり、同じ変更を繰り返したりしないで。シェルやファイル操作は使わない。',
    }, { ms: 240000 });
    const card = c.since(from).find((e) => e.type === 'permission' && e.settingChange && e.sessionId === changer.sessionId);
    const toolOut = asked.events.filter((e) => e.type === 'tool.result').map((e) => String(e.text ?? '')).find((x) => x.includes('PENDING_APPROVAL')) ?? '';
    t.ok('set_setting が呼ばれ、承認を待たずに承認待ち（PENDING_APPROVAL）が返ってターンが終わった', asked.outcome === 'ok' && asked.tools.some((n) => /ply_control.*set_setting/.test(n)) && toolOut.includes(card?.settingChange?.requestId ?? '-'),
      `${asked.outcome} ${asked.tools.join(', ')} ${toolOut.slice(0, 200)}`);
    t.ok('会話に承認カードが残り、設定はまだ変わっていない', Boolean(card) && (await c.cmd('running')).permissions.some((p) => p.id === card.id) && (await c.cmd('prefs')).confirmAgentSites === true);
    if (card) {
      const after = c.mark();
      await c.cmd('resolvePermission', { id: card.id, allow: true, receipt: card.settingChange.receipt });
      const notice = await c.waitFor((e) => e.type === 'taskNotice' && e.sessionId === changer.sessionId && String(e.text).includes(card.settingChange.requestId), { from: after, ms: 60000 }).catch(() => null);
      t.ok('許可すると設定が変わり、結果（許可）の通知がその会話に届く', (await c.cmd('prefs')).confirmAgentSites === false && /結果: 許可/.test(notice?.text ?? ''), notice?.text);
      const ended = await c.waitFor((e) => e.type === 'turnEnd' && e.sessionId === changer.sessionId, { from: after, ms: 240000 }).catch(() => null);
      const answered = (await c.cmd('loadSession', { sessionId: changer.sessionId })).messages;
      const at = answered.findIndex((m) => m.internalTaskNotice && String(m.text).includes(card.settingChange.requestId));
      t.ok('通知で始まったターンで Claude が答えた（通知は人の発言ではなく通知として残る）', ended?.outcome === 'ok' && at >= 0 && answered.slice(at + 1).some((m) => m.role === 'assistant' && m.text),
        JSON.stringify(answered.slice(at >= 0 ? at : -2).map((m) => ({ role: m.role, notice: m.internalTaskNotice, text: String(m.text).slice(0, 120) }))));
    }
  } finally {
    if (before) await c.cmd('setPref', { key: 'linkOpen', value: before.linkOpen ?? 'inapp' }).catch(() => {});
    if (before) await c.cmd('setPref', { key: 'confirmAgentSites', value: before.confirmAgentSites ?? false }).catch(() => {});
    c.close();
  }
}
