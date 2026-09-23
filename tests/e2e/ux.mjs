import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
export const name = 'ux';
export const title = '保存済みの空セッションから実エージェントを開始・再開する';
export const serverEnv = { AGENT_HOST_BACKENDS: 'claude,codex,procway' };
export default async function(t, ctx) {
  const c = await ctx.open({ autoAllow: true });
  try {
    const agents = await c.cmd('backends');
    for (const backend of ['claude', 'codex', 'procway']) {
      if (!agents.some(a => a.id === backend)) { t.ok(`${backend} が利用可能`, false); continue; }
      const models = await c.cmd('models', { backend });
      const model = backend === 'claude' ? 'haiku' : '';
      t.ok(`${backend} のモデル候補を取得`, Object.hasOwn(models, model));
      const { sessionId } = await c.cmd('newSession', { backend, cwd: ctx.work });
      await c.cmd('setTurnSettings', { sessionId, backend, model });
      const first = await c.runTurn({ sessionId, prompt: 'Reply with exactly UX_OK. Do not use tools or change files.' }, { ms: 180000 });
      t.ok(`${backend}: 保存済みIDで初回ターンを完了`, first.outcome === 'ok', first.outcome ?? first.events.find(e=>e.error)?.error);
      t.ok(`${backend}: ホストIDを維持`, first.events.every(e=>!e.sessionId || e.sessionId===sessionId));
      const nextCwd = path.join(ctx.work, `next-${backend}`);
      await fs.mkdir(nextCwd, { recursive: true });
      const proof = crypto.randomUUID();
      await fs.writeFile(path.join(nextCwd, 'cwd-proof.txt'), proof);
      await c.cmd('setTurnSettings', { sessionId, cwd: nextCwd });
      const second = await c.runTurn({ sessionId, prompt: 'Run a command that prints the current working directory and reads cwd-proof.txt from that directory. Reply with UX_CONTINUE and both outputs. Do not change files.' }, { ms: 180000 });
      t.ok(`${backend}: 同じIDで再開`, second.outcome === 'ok', second.outcome ?? second.events.find(e=>e.error)?.error);
      const history = await c.cmd('loadSession', { sessionId });
      const reply = history.messages.filter(m=>m.role==='assistant').map(m=>m.text).join('\n');
      t.ok(`${backend}: 次の作業場所を使用`, reply.includes(proof) && reply.replaceAll('\\', '/').includes(`/next-${backend}`), reply);
      t.ok(`${backend}: 両方のユーザー発言を保存`, history.messages.filter(m=>m.role==='user').length === 2);
      t.ok(`${backend}: 両方の返答を保存`, history.messages.filter(m=>m.role==='assistant').map(m=>m.text).join('\n').includes('UX_OK') && history.messages.some(m=>m.text?.includes('UX_CONTINUE')));
    }
  } finally { c.close(); }
}
