// 委譲の子が出した設定の変更の承認の結果が、子のタスクが終わった後なら依頼元の会話に届き、依頼元の Claude がそれを読んで答える（ADR 0088「結果の届け先」）。
// 親（Claude）が子（Claude）に委譲する → 子が ply_control の set_setting で承認待ちを受けて終わる → 後で許可する → 結果が親の会話に届く。
import { sleep } from '../lib/ws-client.mjs';

export const name = 'control-delegated-approval';
export const title = '委譲の子が承認待ちを受けて終わった後に許可すると、結果は依頼元の Claude に届いて答える（子には新しいターンが立たない）';
export const serverEnv = { AGENT_HOST_BACKENDS: 'claude' };

export default async function (t, ctx) {
  const c = await ctx.open({ autoAllow: true });
  let before = null;
  try {
    const agents = await c.cmd('backends');
    if (!agents.some((a) => a.id === 'claude')) { t.ok('claude が利用可能', false); return; }
    before = await c.cmd('prefs');
    await c.cmd('setPref', { key: 'confirmAgentSites', value: true });

    const parent = await c.cmd('newSession', { backend: 'claude', cwd: ctx.work });
    await c.cmd('setTurnSettings', { sessionId: parent.sessionId, backend: 'claude', model: 'haiku' });
    const from = c.mark();
    await c.cmd('runTurn', { sessionId: parent.sessionId, mode: 'default',
      prompt: 'This is an authorized, bounded integration test. Call the Pleiad MCP tool ply_delegate exactly once with kind="trivial", backend="claude", title="e2e settings child", and task="Use the Pleiad ply_control MCP tool set_setting to change the setting confirmAgentSites to false (reason: e2e). It returns a pending-approval status immediately; do not wait, do not retry, and do not use shell or files. Write that status in one line and finish."  Use the actual MCP tool; do not use native Agent or spawn tools. After receiving the taskId, reply briefly and finish this turn. Pleiad will deliver results later. When the child completion notification arrives, reply briefly. When a message starting with "[Pleiad 設定の変更の結果" arrives, reply with one line "SEEN: " followed by its 結果 line and the taskId of the child it mentions, and do not delegate again.' });

    // 子が承認待ちを受けて終わる（カードは子の会話のもの）
    const card = await c.waitFor((e) => e.type === 'permission' && e.settingChange && e.sessionId !== parent.sessionId, { from, ms: 240000 }).catch(() => null);
    let task = null;
    for (let i = 0; i < 240; i++) {
      task = (await c.cmd('agentTasks', { sessionId: parent.sessionId }))[0];
      if (task && ['completed', 'failed', 'cancelled', 'interrupted'].includes(task.status) && task.notification === 'sent') break;
      await sleep(1000);
    }
    t.ok('子が set_setting を呼び、承認待ちで終わった（カードは子の会話に出ている）', Boolean(card) && card.sessionId === task?.sessionId && task?.status === 'completed' && (await c.cmd('prefs')).confirmAgentSites === true,
      `${card?.sessionId} ${task?.status} ${String(task?.result).slice(0, 200)}`);
    // 親が子の完了通知を読み終えて空くまで待つ
    for (let i = 0; i < 240; i++) {
      if (!(await c.cmd('running')).turns.some((r) => r.sessionId === parent.sessionId)) break;
      await sleep(1000);
    }
    await sleep(1000);

    if (card) {
      const after = c.mark();
      await c.cmd('resolvePermission', { id: card.id, allow: true, receipt: card.settingChange.receipt });
      const notice = await c.waitFor((e) => e.type === 'taskNotice' && e.sessionId === parent.sessionId && String(e.text).includes(card.settingChange.requestId), { from: after, ms: 60000 }).catch(() => null);
      t.ok('許可すると設定が変わり、結果（許可）の通知が依頼元の会話に届く（子の題・taskId・画面のラベルつき）',
        (await c.cmd('prefs')).confirmAgentSites === false && /結果: 許可/.test(notice?.text ?? '') && String(notice?.text).includes(task.taskId) && String(notice?.text).includes('エージェントがサイトを使う前に確認'), notice?.text);
      const ended = await c.waitFor((e) => e.type === 'turnEnd' && e.sessionId === parent.sessionId, { from: after, ms: 240000 }).catch(() => null);
      const history = (await c.cmd('loadSession', { sessionId: parent.sessionId })).messages;
      const at = history.findIndex((m) => m.internalTaskNotice && String(m.text).includes(card.settingChange.requestId));
      const answer = history.slice(at + 1).filter((m) => m.role === 'assistant').map((m) => m.text).join('\n');
      t.ok('依頼元の Claude が結果を読んで答えた（通知は人の発言ではなく通知として残る）', ended?.outcome === 'ok' && at >= 0 && /SEEN/.test(answer) && /許可/.test(answer), answer.slice(0, 300));
      const childEvents = c.since(after).filter((e) => e.sessionId === task.sessionId && (e.type === 'taskNotice' || e.type === 'turnStart' || e.type === 'running'));
      t.ok('子の会話には結果が届かず、新しいターンも立たない', childEvents.length === 0, JSON.stringify(childEvents.map((e) => e.type)));
    }
  } finally {
    if (before) await c.cmd('setPref', { key: 'confirmAgentSites', value: before.confirmAgentSites ?? false }).catch(() => {});
    await c.cmd('abort').catch(() => {});
    c.close();
  }
}
