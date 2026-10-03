// 実際の Codex 会話から、host と同じ sessions.setTitle を ply_control 経由で呼ぶ。
export const name = 'control-stage3';
export const title = 'Codex が ply_control の sessions.setTitle を呼ぶ';
export const serverEnv = { AGENT_HOST_BACKENDS: 'codex' };

export default async function (t, ctx) {
  const c = await ctx.open();
  try {
    const { sessionId } = await c.cmd('newSession', { backend: 'codex', cwd: ctx.work, mode: 'yolo' });
    const title = 'Codex 操作一覧の確認';
    const turn = await c.runTurn({ sessionId,
      prompt: `Pleiad の ply_control の MCP ツールを使って、call_op で op="sessions.setTitle", args={"title":"${title}","reason":"段階 3 の e2e"} を一度だけ呼んでください。シェルやファイル操作は使わず、結果を一行で答えてください。`,
    }, { ms: 240_000 });
    const row = (await c.cmd('listSessions')).find((s) => s.id === sessionId);
    t.ok('Codex のターンが完了した', turn.outcome === 'ok', turn.outcome === 'ok' ? '' : JSON.stringify(turn.events.filter((e) => e.error || e.type === 'turnResult')).slice(-1800));
    const called = turn.events.some((e) => e.type === 'tool.start' && e.input?.server === 'ply_control'
      && e.input?.tool === 'call_op' && e.input?.arguments?.op === 'sessions.setTitle');
    t.ok('Codex が ply_control の call_op を呼んだ', called, called ? '' : JSON.stringify(turn.events.filter((e) => e.type === 'tool.start')).slice(0, 700));
    t.ok('sessions.setTitle が題を変えた', row?.title === title, row?.title);
    const changes = await c.cmd('sessionChanges', { sessionId });
    t.ok('変更の記録に agent と理由が残る', changes.changes.some((x) => x.field === 'title' && x.to === title && x.by === 'agent' && x.reason === '段階 3 の e2e'));
  } finally { c.close(); }
}
