// 途中送信（control.steer）の本番確認。バックエンドごとに経路が別物なので、
// 使うバックエンドの分だけ回す（codex は turn/steer、claude は開けたままの CLI の stdin）。
export async function checkSteer(t, { server, work }, backend) {
  const { open } = await import('../lib/ws-client.mjs');
  const c = await open({ ...server, autoAllow: true });
  let sessionId;
  try {
    ({ sessionId } = await c.cmd('newSession', { backend, cwd: work, mode: 'auto' }));
    await c.cmd('sendMessage', { sessionId, messageId: 'live-initial-0001',
      prompt: 'This is an integration test. Run a shell command that waits 8 seconds, then answer READY. Do not read or modify files. A follow-up instruction may arrive while waiting.' });
    await c.waitFor(e => e.sessionId === sessionId && e.type === 'tool.start', { ms: 90000 });
    await c.cmd('sendMessage', { sessionId, messageId: 'live-steer-0001', prompt: 'Additional instruction: in your final answer include PLY_STEER_CONFIRMED.' });
    const said = await c.waitFor(e => e.type === 'userMessage' && e.messageId === 'live-steer-0001', { ms: 30000 });
    // 受理の記録が壊れると（例外を投げる steer など）status が unknown で止まり、人は再送して二重に届く
    const queued = await c.cmd('listMessages', { sessionId }).catch(() => null);
    const item = (Array.isArray(queued) ? queued : []).find(m => m.id === 'live-steer-0001');
    t.ok(`${backend}: 受理が unknown で止まらない`, !item || item.status === 'sent', JSON.stringify(item));
    // 「渡った」合図を出せるバックエンド（steerConfirms）では、走っているターンの中で渡ること。
    // 出せない相手は pending が立たない＝受理した時点で渡った扱いなので、この検査は飛ばす
    if (said.pending) {
      const delivered = await c.waitFor(e => e.type === 'userMessage.delivered' && e.messageId === 'live-steer-0001', { ms: 120000 });
      t.ok(`${backend}: 同じターンの中で渡る（ターンの終わりを待たない）`,
        !c.events.slice(0, c.events.indexOf(delivered)).some(e => e.type === 'turnEnd' && e.sessionId === sessionId));
    }
    await c.waitFor(e => e.type === 'turnEnd' && e.sessionId === sessionId, { ms: 120000 });
    const loaded = await c.cmd('loadSession', { sessionId });
    t.ok(`${backend}: 追加指示が一度だけ履歴に残る`, loaded.messages.filter(m => m.role === 'user' && m.text.includes('Additional instruction:')).length === 1);
    t.ok(`${backend}: 追加指示が実際の返答に反映される`, loaded.messages.some(m => m.role === 'assistant' && m.text?.includes('PLY_STEER_CONFIRMED')));
  } finally {
    if (sessionId) await c.cmd('abort', { sessionId }).catch(() => {});
    c.close();
  }
}
