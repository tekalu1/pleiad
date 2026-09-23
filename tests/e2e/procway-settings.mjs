import fs from 'node:fs/promises';
import path from 'node:path';
import { PROCWAY_CLI } from '../lib/server.mjs';
import { nativeSettings } from '../../core/procway-config.mjs';

export const name = 'procway-settings';
export const title = '既存 API 資格情報で容量設定を適用して実サービスに送信';
export const serverEnv = { AGENT_HOST_BACKENDS: 'procway', AGENT_HOST_PROCWAY_CODE: PROCWAY_CLI };
export default async function(t,{open,work,root,server}) {
  if (!await fs.stat(PROCWAY_CLI).then(s => s.isFile(), () => false)) { t.ok(`procway-code の cli.mjs がある: ${PROCWAY_CLI}`,false,'AGENT_HOST_PROCWAY_CODE で procway-code の src/cli.mjs を指してください'); return; }
  const { settings, environment } = await nativeSettings(root);
  const entry = Object.entries(settings.providers).find(([id,p]) =>
    (process.env.E2E_PROCWAY_PROVIDER ? id === process.env.E2E_PROCWAY_PROVIDER : !/localhost|127\.0\.0\.1/.test(p.baseUrl || '')) &&
    ['openai','openai-compatible','anthropic','anthropic-compatible'].includes(p.type) && environment[p.apiKeyEnv]);
  if (!entry) { t.ok('実サービスの API 接続が設定済み',false,'E2E_PROCWAY_PROVIDER と既存の資格情報を設定してください'); return; }
  const [id,provider] = entry;
  await fs.mkdir(path.join(work,'.procway/ai-agent'),{recursive:true});
  await fs.writeFile(path.join(work,'.procway/ai-agent/settings.json'),JSON.stringify({ defaultProvider:id,providers:{[id]:provider},session:{autoCompact:{enabled:false}} }));
  const client=await open();
  try {
    const {sessionId}=await client.cmd('newSession',{backend:'procway',cwd:work});
    await client.cmd('setTurnSettings',{sessionId,model:id+'/'+provider.defaultModel,procwayLimits:{context:200000,output:2048,compact:false,threshold:150000,keep:10,condense:false,recent:10,chars:6000}});
    const turn=await client.runTurn({sessionId,cwd:work,prompt:'This is a connection test. Do not use tools. Reply only with OK.'},{ms:180000});
    t.ok('API の実応答でターンが完了',turn.outcome==='ok',turn.outcome);
    t.ok('実サービスから本文が返る',turn.events.some(e=>e.type==='text.delta'&&e.text?.trim()));
    const selected=await client.cmd('procwaySettings',{sessionId,cwd:work});
    t.ok('送信後も指定容量を保持',selected.limits.context===200000&&selected.limits.output===2048);
  } finally {
    client.close();
    for (const match of server.tail(200).matchAll(/serve を起動した pid=(\d+)/g)) { try { process.kill(Number(match[1])); } catch {} }
  }
}
