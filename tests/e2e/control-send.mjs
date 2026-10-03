// 別の会話への送信（sessions.send。ADR 0096）を実際の Codex の会話から呼ぶ。
// 1) 同じ強さ（auto）の宛先へ送ると、宛先の Codex がそれを受けて答え、宛先の履歴に送り手の印が付く。
// 2) 送り手より強い宛先（full: 自律 never）へ送ると、承認待ち（PENDING_APPROVAL）が返り、送り手の会話に承認カードが出る。拒否すれば宛先には届かない。
export const name = 'control-send';
export const title = 'Codex が ply_control の call_op で sessions.send を呼び、別の会話が受けて答える。強い宛先へは承認待ち';
export const serverEnv = { AGENT_HOST_BACKENDS: 'codex' };

const WORD = 'PLY_RELAY_7Q';

export default async function (t, ctx) {
  const c = await ctx.open();
  try {
    const conversation = async (mode, prompt) => {
      const { sessionId } = await c.cmd('newSession', { backend: 'codex', cwd: ctx.work, mode });
      const first = await c.runTurn({ sessionId, mode, prompt }, { ms: 300_000 });
      return { sessionId, outcome: first.outcome };
    };
    const sender = await conversation('auto', '「準備できました」とだけ答えてください。');
    const target = await conversation('auto', '「待っています」とだけ答えてください。');
    const strong = await conversation('full', '「待っています」とだけ答えてください。');
    t.ok('送り手・宛先・強い宛先の会話ができた', [sender, target, strong].every((x) => x.outcome === 'ok'));

    const callSend = (to, text) => 'Pleiad の ply_control の MCP ツールだけを使ってください（シェルやファイル操作は使わない）。'
      + `call_op を 1 回だけ呼びます: op="sessions.send", args={"sessionId":"${to}","text":"${text}","reason":"e2e の確認"}。`
      + '最後に「CODE=<結果の code。無ければ ok> STATUS=<結果の status>」の 1 行で答えてください。';

    // ---- 1) 同じ強さの宛先へ送る
    let from = c.mark();
    const turn = await c.runTurn({ sessionId: sender.sessionId, mode: 'auto', prompt: callSend(target.sessionId, `合言葉 ${WORD} を含めて、1 行で返事してください。`) }, { ms: 300_000 });
    t.ok('送り手の Codex のターンが完了した', turn.outcome === 'ok', JSON.stringify(turn.events.filter((e) => e.error || e.type === 'turnResult')).slice(-1200));
    const call = turn.events.find((e) => e.type === 'tool.start' && e.input?.server === 'ply_control' && e.input?.tool === 'call_op' && e.input?.arguments?.op === 'sessions.send');
    const result = String(turn.events.find((e) => e.type === 'tool.result' && e.id === call?.id)?.text ?? '');
    t.ok('Codex が call_op で sessions.send を呼び、送れた（messageId）', Boolean(call) && /send-[0-9a-f-]{8,}/.test(result) && !/"ok":\s*false/.test(result), result.slice(0, 600));
    await c.waitFor((e) => e.type === 'turnEnd' && e.sessionId === target.sessionId, { from, ms: 300_000 });
    const got = (await c.cmd('loadSession', { sessionId: target.sessionId })).messages;
    const relayed = got.find((m) => m.role === 'user' && m.text?.includes(WORD));
    t.ok('宛先の履歴の発言に送り手の印（送り手の会話）', relayed?.sentBy?.sessionId === sender.sessionId && relayed.sentBy.by === 'agent', JSON.stringify(relayed));
    const answer = got.filter((m) => m.role === 'assistant').at(-1)?.text ?? '';
    t.ok('宛先の Codex がそれを受けて答えた（合言葉を含む）', answer.includes(WORD), answer.slice(0, 300));

    // ---- 2) 送り手より強い宛先へ送る
    from = c.mark();
    const turn2 = await c.runTurn({ sessionId: sender.sessionId, mode: 'auto', prompt: callSend(strong.sessionId, '「届きました」とだけ答えてください。') }, { ms: 300_000 });
    const afterTurn2 = c.mark();
    const call2 = turn2.events.find((e) => e.type === 'tool.start' && e.input?.server === 'ply_control' && e.input?.tool === 'call_op' && e.input?.arguments?.op === 'sessions.send');
    const result2 = String(turn2.events.find((e) => e.type === 'tool.result' && e.id === call2?.id)?.text ?? '');
    t.ok('強い宛先へは承認待ち（PENDING_APPROVAL）が返る', Boolean(call2) && /PENDING_APPROVAL/.test(result2), result2.slice(0, 600));
    const card = c.since(from).find((e) => e.type === 'permission' && e.settingChange?.op === 'sessions.send' && e.sessionId === sender.sessionId);
    t.ok('送り手の会話に承認カードが出た', Boolean(card), JSON.stringify(card?.settingChange ?? null).slice(0, 400));
    if (card) {
      await c.cmd('resolvePermission', { id: card.id, allow: false, messageKey: 'userDenied', receipt: card.settingChange.receipt });
      await c.waitFor((e) => e.type === 'settingApproval' && e.requestId === card.settingChange.requestId, { from, ms: 30_000 });
    }
    const outbox = await c.cmd('listMessages', { sessionId: strong.sessionId });
    t.ok('拒否したら強い宛先には積まれない', !outbox.some((m) => /届きました/.test(m.args?.prompt ?? '')), JSON.stringify(outbox).slice(0, 300));
    // 拒否の結果の通知で送り手のターンが 1 回走る。終わってから閉じる
    await c.waitFor((e) => e.type === 'turnEnd' && e.sessionId === sender.sessionId, { from: afterTurn2, ms: 120_000 }).catch(() => {});
  } finally {
    c.close();
  }
}
