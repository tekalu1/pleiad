import fs from 'node:fs/promises';
import path from 'node:path';
import { nativeSettings } from '../../core/procway-config.mjs';
import { sleep } from '../lib/ws-client.mjs';
export const name = 'agent-delegation';
export const title = '実サービスで Claude → Codex → procway → Claude の Pleiad 委譲';
export const serverEnv = { AGENT_HOST_BACKENDS: 'claude,codex,procway' };
export default async function(t, { open, work, root, server }) {
  const { settings, environment } = await nativeSettings(root);
  const entry = Object.entries(settings.providers).find(([,p]) => ['openai', 'openai-compatible', 'anthropic', 'anthropic-compatible'].includes(p.type) && environment[p.apiKeyEnv] && !/localhost|127\.0\.0\.1/.test(p.baseUrl ?? ''));
  if (!entry) throw new Error('procway の実サービス接続がありません');
  await fs.mkdir(path.join(work, '.procway/ai-agent'), { recursive: true });
  await fs.mkdir(path.join(work, '.git'));
  await fs.writeFile(path.join(work, '.procway/ai-agent/settings.json'), JSON.stringify({ defaultProvider: entry[0], providers: { [entry[0]]: entry[1] }, session: { autoCompact: { enabled: false } } }));
  const c = await open({ autoAllow: true, onEvent: e => { if (e.type === 'tool.start') console.log(`  tool: ${e.name}`); } });
  const pairs = [['claude', 'codex'], ['codex', 'procway'], ['procway', 'claude']];
  try {
    for (const [parent, child] of pairs.filter(([parent]) => !process.env.E2E_DELEGATION_PARENT || process.env.E2E_DELEGATION_PARENT === parent)) {
      const { sessionId } = await c.cmd('newSession', { backend: parent, cwd: work });
      const code = `PLY_${parent.toUpperCase()}_${child.toUpperCase()}_OK`;
      const mark = c.mark();
      await c.cmd('runTurn', { sessionId, mode: parent === 'claude' ? 'acceptEdits' : parent === 'codex' ? 'full' : 'full-auto',
        ...(parent === 'procway' ? { model: entry[0] + '/' + entry[1].defaultModel } : {}),
        prompt: `This is an authorized, bounded integration test. Call the Pleiad MCP tool ply_delegate exactly once, backend="${child}", task="Reply with exactly ${code}. Do not call any tools, create child agents, or modify files."${child === 'procway' ? `, model="${entry[0]}/${entry[1].defaultModel}"` : ''}. Use the actual MCP tool; do not use shell or simulate it. ${parent === 'procway' ? 'Also call the separate native spawn_agent exactly once with runInBackground:true, task="Reply NATIVE_CHILD_OK without using any tools". These are two separate tasks with separate ID types. Native spawn_agent does not replace ply_delegate.' : 'Do not use native spawn_agent, Agent, or agent_job.'} After receiving taskId, reply briefly and finish this turn. Pleiad will deliver the result later. When that completion notification arrives, reply with the received code and do not delegate again.` });
      let task;
      for (let i = 0; i < 240; i++) {
        task = (await c.cmd('agentTasks', { sessionId }))[0];
        if (task && (task.notification === 'sent' || ['failed', 'interrupted', 'cancelled'].includes(task.status))) break;
        await sleep(1000);
      }
      t.ok(`${parent} → ${child}: Pleiad MCP が子を開始`, task?.backend === child && task.parentSessionId === sessionId, task?.error ?? task?.status ?? 'タスクなし');
      t.ok(`${parent} → ${child}: 子が実サービスで完了`, task?.status === 'completed' && task.result.includes(code), task?.error ?? task?.result ?? '');
      t.ok(`${parent}: 完了通知で親が再開`, task?.notification === 'sent' && c.since(mark).some(e => e.type === 'taskNotice' && e.sessionId === sessionId));
      if (parent === 'procway') t.ok('procway: native と Pleiad の委譲を別々に呼ぶ', c.since(mark).some(e => e.type === 'tool.start' && e.name === 'spawn_agent') && c.since(mark).some(e => e.type === 'tool.start' && e.name === 'mcp__ply_agents__ply_delegate'));
      const transcript = await c.cmd('loadSession', { sessionId });
      t.ok(`${parent}: 通知後の回答を保存`, transcript.messages.some(m => m.internalTaskNotice) && transcript.messages.findLast(m => m.role === 'assistant' && m.text)?.text.includes(code));
      if (task?.notification !== 'sent') await c.cmd('abort', { sessionId });
    }
  } finally {
    await c.cmd('abort').catch(() => {}); c.close();
    for (const m of server.tail(200).matchAll(/serve を起動した pid=(\d+)/g)) { try { process.kill(Number(m[1])); } catch {} }
  }
}
