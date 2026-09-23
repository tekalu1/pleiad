import fs from 'node:fs/promises';
import path from 'node:path';
import { PROCWAY_CLI } from '../lib/server.mjs';
import { nativeSettings } from '../../core/procway-config.mjs';
import { checkVisualize } from './visualize-shared.mjs';
export const name = 'visualize-procway';
export const title = '実物 procway serve と実サービスで共通 Visualize・再開・保存を検証';
export const serverEnv = { AGENT_HOST_BACKENDS: 'procway', AGENT_HOST_PROCWAY_CODE: PROCWAY_CLI };
export default async function(t, ctx) {
  if (!await fs.stat(PROCWAY_CLI).then(s => s.isFile(), () => false)) { t.ok(`procway-code の cli.mjs がある: ${PROCWAY_CLI}`, false, 'AGENT_HOST_PROCWAY_CODE で procway-code の src/cli.mjs を指してください'); return; }
  const { settings, environment } = await nativeSettings(ctx.root);
  const entry = Object.entries(settings.providers).find(([id, p]) =>
    (process.env.E2E_PROCWAY_PROVIDER ? id === process.env.E2E_PROCWAY_PROVIDER : !/localhost|127\.0\.0\.1/.test(p.baseUrl || '')) &&
    ['openai', 'openai-compatible', 'anthropic', 'anthropic-compatible'].includes(p.type) && environment[p.apiKeyEnv]);
  if (!entry) { t.ok('実サービスの API 接続が設定済み', false, 'E2E_PROCWAY_PROVIDER と既存の資格情報を設定してください'); return; }
  const [id, provider] = entry;
  await fs.mkdir(path.join(ctx.work, '.procway/ai-agent'), { recursive: true });
  await fs.writeFile(path.join(ctx.work, '.procway/ai-agent/settings.json'), JSON.stringify({ defaultProvider: id, providers: { [id]: provider }, session: { autoCompact: { enabled: false } } }));
  try {
    await checkVisualize(t, { ...ctx, open: () => ctx.open({ autoAllow: true }) }, 'procway');
  } finally {
    for (const match of ctx.server.tail(200).matchAll(/serve を起動した pid=(\d+)/g)) { try { process.kill(Number(match[1])); } catch {} }
  }
}
