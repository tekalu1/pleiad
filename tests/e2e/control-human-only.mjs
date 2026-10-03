// human-only を 5 つに限ったあと（ADR 0094）、実際の Codex 会話が ply_control で外した操作を呼べ、5 つに当たる設定は見えないこと。
// 承認の要る会話（auto）から call_op で worktrees.setSettings（write）を呼ばせ、承認カードなしで変わることを見る。
// 同じターンで list_ops と settings.get（key: mode）を呼ばせ、承認モードの操作が一覧に無く、設定 mode が SETTING_NOT_FOUND になることを見る。
export const name = 'control-human-only';
export const title = 'Codex が ply_control の call_op で worktrees.setSettings を呼び、承認モードは list_ops にも settings.get にも出ない';
export const serverEnv = { AGENT_HOST_BACKENDS: 'codex' };

const MODE_OPS = /(^|\.)(setMode|resolvePermission)$/;

export default async function (t, ctx) {
  const c = await ctx.open();
  try {
    const before = await c.cmd('worktreeSettings');
    if (before.always) await c.cmd('setWorktreeSettings', { always: false });
    const { sessionId } = await c.cmd('newSession', { backend: 'codex', cwd: ctx.work, mode: 'auto' });
    const from = c.mark();
    const turn = await c.runTurn({ sessionId,
      prompt: 'Pleiad の ply_control の MCP ツールだけを使ってください（シェルやファイル操作は使わない）。次を順に 1 回ずつ呼びます。'
        + '1) list_ops を引数なしで呼ぶ。'
        + '2) call_op で op="settings.get", args={"key":"mode"} を呼ぶ。'
        + '3) call_op で op="worktrees.setSettings", args={"always":true} を呼ぶ。'
        + '最後に「LIST=<list_ops に承認モードを変える操作があったら yes、無ければ no> MODE=<2 の code か値> ALWAYS=<3 の always>」の 1 行で答えてください。',
    }, { ms: 300_000 });
    t.ok('Codex のターンが完了した', turn.outcome === 'ok', turn.outcome === 'ok' ? '' : JSON.stringify(turn.events.filter((e) => e.error || e.type === 'turnResult')).slice(-1800));

    const starts = turn.events.filter((e) => e.type === 'tool.start' && e.input?.server === 'ply_control');
    const resultOf = (start) => String(turn.events.find((e) => e.type === 'tool.result' && e.id === start?.id)?.text ?? '');
    const listCall = starts.find((e) => e.input?.tool === 'list_ops');
    const modeCall = starts.find((e) => e.input?.tool === 'call_op' && e.input?.arguments?.op === 'settings.get' && e.input?.arguments?.args?.key === 'mode');
    const setCall = starts.find((e) => e.input?.tool === 'call_op' && e.input?.arguments?.op === 'worktrees.setSettings');
    t.ok('Codex が list_ops・settings.get（mode）・worktrees.setSettings を呼んだ', Boolean(listCall && modeCall && setCall), JSON.stringify(starts.map((e) => e.input)).slice(0, 900));

    // 画面の行は長い結果を切り、MCP の結果の中の JSON はエスケープされているので、JSON として読まずに id の文字列で見る
    const listed = [...resultOf(listCall).matchAll(/\\*"id\\*":\s*\\*"([^"\\]+)/g)].map((m) => m[1]);
    // 一覧の後ろ（worktrees.* など）は切れて見えないことがある。worktrees.setSettings が一覧にあることは、下で呼べたことで確かめる
    t.ok('list_ops に sessions.setModel があり、承認モードを変える操作（setMode・resolvePermission）は無い',
      listed.includes('sessions.setModel') && !listed.some((id) => MODE_OPS.test(id)), listed.join(' ') || resultOf(listCall).slice(0, 400));
    t.ok('settings.get の mode は SETTING_NOT_FOUND（設定 mode は agent に無いのと同じ）', /SETTING_NOT_FOUND/.test(resultOf(modeCall)), resultOf(modeCall).slice(0, 400));

    const now = await c.cmd('worktreeSettings');
    t.ok('worktrees.setSettings で「いつも分ける」が変わった（承認の要る会話でも write は承認カードなし）', now.always === true
      && !c.since(from).some((e) => e.type === 'permission' && e.sessionId === sessionId), JSON.stringify(now));
    t.ok('画面へ worktreeSettings のイベント（always: true）が届いた', c.since(from).some((e) => e.type === 'worktreeSettings' && e.always === true));
    const history = await c.cmd('loadSession', { sessionId });
    const reply = history.messages.filter((m) => m.role === 'assistant').map((m) => m.text).join('\n');
    t.ok('答えに結果を使った（LIST=no・SETTING_NOT_FOUND・ALWAYS=true）', /LIST\s*=\s*no/i.test(reply) && /SETTING_NOT_FOUND/.test(reply) && /ALWAYS\s*=\s*true/i.test(reply), reply.slice(-300));
  } finally {
    await c.cmd('setWorktreeSettings', { always: false }).catch(() => {});
    c.close();
  }
}
