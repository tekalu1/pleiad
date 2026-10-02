// ply_control（操作の一覧。ADR 0081）が実エージェント（Claude）に渡り、検索と設定の読み出しを呼んで結果を使えること。
// 別の会話に目印を残し、新しい会話で search_sessions に探させ、get_setting で設定の値を読ませる。
import crypto from 'node:crypto';

export const name = 'control';
export const title = 'Claude が ply_control の search_sessions と get_setting を呼び、結果を使う';
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
  } finally {
    if (before) await c.cmd('setPref', { key: 'linkOpen', value: before.linkOpen ?? 'inapp' }).catch(() => {});
    c.close();
  }
}
