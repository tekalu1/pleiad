import fs from 'node:fs/promises';
import path from 'node:path';
import { nativeSettings } from '../../core/procway-config.mjs';
export const name = 'effort';
export const title = '3エージェントでエフォート指定・再開・既定への復帰';
export default async function(t, ctx) {
  const c = await ctx.open({ autoAllow: true });
  try {
    for (const backend of ['codex', 'claude', 'procway']) {
      const cwd = path.join(ctx.work, backend);
      await fs.mkdir(cwd, { recursive: true });
      let model = backend === 'claude' ? 'sonnet' : '';
      if (backend === 'procway') {
        const { settings, environment } = await nativeSettings(ctx.root);
        const entry = Object.entries(settings.providers).find(([,p]) => p.type === 'openai-codex')
          ?? Object.entries(settings.providers).find(([,p]) => ['openai', 'openai-compatible'].includes(p.type) && environment[p.apiKeyEnv] && !/localhost|127\.0\.0\.1/.test(p.baseUrl || ''));
        if (!entry) { t.ok('procway: 実サービスの接続設定', false); continue; }
        const [id, provider] = entry;
        model = id + '/' + provider.defaultModel;
        await fs.mkdir(path.join(cwd, '.procway/ai-agent'), { recursive: true });
        await fs.writeFile(path.join(cwd, '.procway/ai-agent/settings.json'), JSON.stringify({ defaultProvider: id, providers: { [id]: provider }, session: { autoCompact: { enabled: false } } }));
      }
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
