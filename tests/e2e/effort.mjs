import fs from 'node:fs/promises';
import path from 'node:path';
export const name = 'effort';
export const title = '2エージェントでエフォート指定・再開・既定への復帰';
export default async function(t, ctx) {
  const c = await ctx.open({ autoAllow: true });
  try {
    for (const backend of ['codex', 'claude']) {
      const cwd = path.join(ctx.work, backend);
      await fs.mkdir(cwd, { recursive: true });
      const model = backend === 'claude' ? 'sonnet' : '';
      const { sessionId } = await c.cmd('newSession', { backend, cwd, model });
      for (const effort of ['low', '']) {
        await c.cmd('setTurnSettings', { sessionId, effort });
        const turn = await c.runTurn({ sessionId, prompt: 'Connection test. Do not use tools or change files. Reply only with OK.' }, { ms: 180000 });
        t.ok(`${backend}: effort=${effort || 'default'} で応答`, turn.outcome === 'ok', turn.events.filter(e => e.type === 'error' || e.type === 'turnResult').map(e => e.error || e.message || e.outcome).join(' '));
        const s = (await c.cmd('listSessions')).find(s => s.id === sessionId);
        t.ok(`${backend}: 適用後の設定`, s.effort === effort && s.nextSettings === null);
      }
    }
  } finally { c.close(); }
}
