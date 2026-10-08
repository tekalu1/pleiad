import { backend as claude, setClaudeSdkForTest, DELEGATED_CHILD_DISALLOWED_TOOLS } from '../../core/backends/claude.mjs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const name = 'claude-delegated-child';
export const title = 'Claude の委譲の子: 使わない組み込みの道具を外す・指示を二重にしない（ADR 0169）';

export default async function (t) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ply-claude-child-'));
  const prevConfig = process.env.CLAUDE_CONFIG_DIR;
  let restoreSdk = null;
  try {
    process.env.CLAUDE_CONFIG_DIR = dir;
    let options = null;
    restoreSdk = setClaudeSdkForTest({ executable: () => 'claude-fake', query: ({ prompt, options: o }) => {
      options = o;
      (async () => { for await (const _ of prompt) { /* 入力は読み捨てる */ } })();
      const done = { type: 'result', subtype: 'success', num_turns: 1, session_id: 's-1', total_cost_usd: 0 };
      return { close() {}, interrupt: async () => ({}), async *[Symbol.asyncIterator]() { yield done; } };
    } });
    const run = (extra = {}) => claude.runTurn({ prompt: 'x', sessionId: null, cwd: dir, mode: 'default', emit() {}, askPermission: async () => ({ allow: true }),
      signal: new AbortController(), control: {}, hostSessionId: 'h', ...extra });
    const agentRuntime = { url: 'http://127.0.0.1:1/mcp/agents', headers: {}, instructions: 'AGENTS-GUIDE' };

    await run({ delegatedChild: true, agentRuntime, controlRuntime: { url: 'http://127.0.0.1:1/mcp/control', headers: {}, instructions: null, env: {} }, botFolders: { readOnlyRoots: ['C:\ro'] } });
    t.ok('委譲の子は Workflow・ScheduleWakeup・ReportFindings・ListAgents を外す', DELEGATED_CHILD_DISALLOWED_TOOLS.length === 4
      && DELEGATED_CHILD_DISALLOWED_TOOLS.every(x => options.disallowedTools?.includes(x)), JSON.stringify(options.disallowedTools));
    t.ok('bot の読み取り専用の deny ルールと合わせて渡す', options.disallowedTools.some(x => x.startsWith('Edit(')));
    t.ok('AskUserQuestion・Agent・Bash・PowerShell は外さない', !['AskUserQuestion', 'Agent', 'Bash', 'PowerShell'].some(x => options.disallowedTools.includes(x)));
    t.ok('ply_control の指示を渡さない（MCP は残す）', !options.systemPrompt.append.includes('CONTROL-GUIDE'));
    t.ok('指示は append に 1 回だけ入る', options.systemPrompt.append.split('AGENTS-GUIDE').length === 2);

    await run({ agentRuntime, controlRuntime: { url: 'http://127.0.0.1:1/mcp/control', headers: {}, instructions: 'CONTROL-GUIDE', env: {} }, visualizeInstructions: 'VIZ-GUIDE' });
    t.ok('親の会話は道具を外さない', !options.disallowedTools);
    t.ok('親の会話は ply_control と可視化の指示を渡す', Object.keys(options.mcpServers).some(k => k.includes('control'))
      && options.systemPrompt.append.includes('CONTROL-GUIDE') && options.systemPrompt.append.includes('VIZ-GUIDE'));
  } finally {
    restoreSdk?.();
    if (prevConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = prevConfig;
    await fsp.rm(dir, { recursive: true, force: true });
  }
}
