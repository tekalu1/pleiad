// 実際の Codex 会話から ply_control の読み取り操作を呼び、廃止した設定操作が見えないことを確かめる。
export const name = 'control-human-only';
export const title = 'Codex が ply_control の worktrees.check を呼び、廃止した設定操作は一覧に出ない';
export const serverEnv = { AGENT_HOST_BACKENDS: 'codex' };

export default async function (t, ctx) {
  const c = await ctx.open();
  try {
    const { sessionId } = await c.cmd('newSession', { backend: 'codex', cwd: ctx.work, mode: 'auto' });
    const turn = await c.runTurn({ sessionId,
      prompt: 'Pleiad の ply_control の MCP ツールだけを使ってください（シェルやファイル操作は使わない）。'
        + 'list_ops を呼び、続けて call_op で op="settings.get", args={"key":"mode"}、'
        + 'op="worktrees.check", args={} を順に呼んでください。'
        + '最後に「MODE=<settings.get の code> CHECK=<worktrees.check に canSplit があれば yes、無ければ no>」の 1 行で答えてください。',
    }, { ms: 300_000 });
    t.ok('Codex のターンが完了した', turn.outcome === 'ok', turn.outcome === 'ok' ? '' : JSON.stringify(turn.events.filter((e) => e.error || e.type === 'turnResult')).slice(-1800));

    const starts = turn.events.filter((e) => e.type === 'tool.start' && e.input?.server === 'ply_control');
    const resultOf = (start) => String(turn.events.find((e) => e.type === 'tool.result' && e.id === start?.id)?.text ?? '');
    const listCall = starts.find((e) => e.input?.tool === 'list_ops');
    const modeCall = starts.find((e) => e.input?.tool === 'call_op' && e.input?.arguments?.op === 'settings.get' && e.input?.arguments?.args?.key === 'mode');
    const checkCall = starts.find((e) => e.input?.tool === 'call_op' && e.input?.arguments?.op === 'worktrees.check');
    t.ok('Codex が list_ops・settings.get（mode）・worktrees.check を呼んだ', Boolean(listCall && modeCall && checkCall), JSON.stringify(starts.map((e) => e.input)).slice(0, 900));
    const listed = resultOf(listCall);
    t.ok('廃止した worktree 設定操作と承認モードの操作は一覧に無い',
      listed.includes('sessions.setModel') && !/worktrees\.(settings|setSettings)|sessions\.setMode|resolvePermission/.test(listed), listed.slice(0, 400));
    t.ok('settings.get の mode は SETTING_NOT_FOUND', /SETTING_NOT_FOUND/.test(resultOf(modeCall)), resultOf(modeCall).slice(0, 400));
    t.ok('worktrees.check は canSplit を返す', /canSplit/.test(resultOf(checkCall)), resultOf(checkCall).slice(0, 400));
    const history = await c.cmd('loadSession', { sessionId });
    const reply = history.messages.filter((m) => m.role === 'assistant').map((m) => m.text).join('\n');
    t.ok('答えに結果を使った', /SETTING_NOT_FOUND/.test(reply) && /CHECK\s*=\s*yes/i.test(reply), reply.slice(-300));
  } finally {
    c.close();
  }
}
