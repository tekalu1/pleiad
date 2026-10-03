// 実際の Codex 会話から、会話・委譲の読み取りの操作を ply_control の call_op で呼ぶ（ADR 0091 追記）。
// 別の会話に目印を残し、新しい会話で list_ops（prefix）・sessions.list・sessions.read（別の会話の発言）・sessions.outbox・delegation.tasks を呼ばせ、結果を答えに使わせる。
import crypto from 'node:crypto';

export const name = 'control-conversations';
export const title = 'Codex が ply_control の call_op で会話の一覧・別の会話の発言・送信待ち・委譲の一覧を読む';
export const serverEnv = { AGENT_HOST_BACKENDS: 'codex' };

export default async function (t, ctx) {
  const c = await ctx.open();
  try {
    // 1. 読まれる側の会話: 目印を含む発言を残す
    const marker = `CONV_${crypto.randomBytes(5).toString('hex').toUpperCase()}`;
    const target = await c.cmd('newSession', { backend: 'codex', cwd: ctx.work, mode: 'yolo' });
    const seeded = await c.runTurn({ sessionId: target.sessionId, prompt: `Reply with exactly ${marker}. Do not use tools or change files.` }, { ms: 240_000 });
    t.ok('目印の会話を作れた', seeded.outcome === 'ok', seeded.outcome ?? seeded.events.find((e) => e.error)?.error);

    // 2. 読む側の会話: call_op で 5 つの読み取りを呼ばせる
    const asker = await c.cmd('newSession', { backend: 'codex', cwd: ctx.work, mode: 'yolo' });
    const turn = await c.runTurn({
      sessionId: asker.sessionId,
      prompt: `Pleiad の ply_control の MCP ツールだけを使って答えて（シェルやファイル操作は使わない。各 1 回ずつ）。`
        + `1) list_ops に prefix="delegation." を渡して、返った操作の数を数える。`
        + `2) call_op で op="sessions.list" args={"limit":50} を呼び、返った total を書く。`
        + `3) call_op で op="sessions.read" args={"sessionId":"${target.sessionId}"} を呼び、その会話の最後の assistant の発言の text を一字も変えずに書く。`
        + `4) call_op で op="sessions.outbox" args={"sessionId":"${target.sessionId}"} を呼び、返った total を書く。`
        + `5) call_op で op="delegation.tasks" args={} を呼び、返った total を書く。`
        + `最後に「OPS=<1 の数> SESSIONS=<2 の total> TEXT=<3 の text> OUTBOX=<4 の total> TASKS=<5 の total>」の 1 行で答える。`,
    }, { ms: 300_000 });
    t.ok('ターンが完了した', turn.outcome === 'ok', turn.outcome === 'ok' ? '' : JSON.stringify(turn.events.filter((e) => e.error || e.type === 'turnResult')).slice(-1500));
    const calls = turn.events.filter((e) => e.type === 'tool.start' && e.input?.server === 'ply_control');
    const called = (op) => calls.some((e) => e.input?.tool === 'call_op' && e.input?.arguments?.op === op);
    t.ok('list_ops を prefix つきで呼んだ', calls.some((e) => e.input?.tool === 'list_ops' && e.input?.arguments?.prefix === 'delegation.'), JSON.stringify(calls.map((e) => [e.input?.tool, e.input?.arguments])).slice(0, 600));
    t.ok('call_op で sessions.list・sessions.read・sessions.outbox・delegation.tasks を呼んだ', ['sessions.list', 'sessions.read', 'sessions.outbox', 'delegation.tasks'].every(called), JSON.stringify(calls.map((e) => e.input?.arguments?.op)));
    const results = turn.events.filter((e) => e.type === 'tool.result').map((e) => String(e.text ?? e.output ?? ''));
    t.ok('sessions.read の返りに別の会話の発言（目印）がある', results.some((x) => x.includes(marker)), results.map((x) => x.slice(0, 80)).join(' | '));
    t.ok('sessions.list の返りに別の会話の id がある', results.some((x) => x.includes(target.sessionId) && x.includes('"sessions"')), results.map((x) => x.slice(0, 80)).join(' | '));
    const history = await c.cmd('loadSession', { sessionId: asker.sessionId });
    const reply = history.messages.filter((m) => m.role === 'assistant').map((m) => m.text).join('\n');
    t.ok('答えに目印と各件数を使った', reply.includes(marker) && /OPS\s*=\s*\d+/.test(reply) && /SESSIONS\s*=\s*\d+/.test(reply) && /TASKS\s*=\s*\d+/.test(reply), reply.slice(-300));
  } finally { c.close(); }
}
