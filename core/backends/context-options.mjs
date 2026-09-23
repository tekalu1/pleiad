import { CodexRpc } from './codex-rpc.mjs';

export function claudeContextOptions(context) {
  if (!context) return {};
  const { owners } = context;
  return {
    ...(owners.instruction === 'ply' ? { settings: { claudeMdExcludes: ['**/CLAUDE.md','**/CLAUDE.local.md','**/.claude/rules/**'], autoMemoryEnabled: false } } : {}),
    ...(owners.skill === 'ply' ? { skills: [], extraArgs: { 'disable-slash-commands': null }, disallowedTools: ['Skill'] } : {}),
    ...(owners.mcp === 'ply' ? { strictMcpConfig: true } : {}),
    ...(context.prompt ? { systemPrompt: { type: 'preset', preset: 'claude_code', append: context.prompt } } : {}),
  };
}
/**
 * MCP を Pleiad が担当する Claude の会話で、止められなかったネイティブ MCP の名前。
 * Pleiad 自身が渡したもの（host・ply_agents・ply_context など mcpServers に入れた名前）はネイティブではない。
 * 固定の名前の一覧で許すと、Pleiad が渡す MCP を足したとき（beta.15 の ply_agents）に必ず止まる
 */
export function unexpectedNativeMcp(status, passed) {
  const own = new Set(['ply', ...passed]);
  return (status ?? []).map(s => s.name).filter(name => !own.has(name));
}
export async function codexContextRpc(context, cwd, nativeRpc) {
  const config = {};
  if (context.owners.instruction === 'ply') config.project_doc_max_bytes = 0;
  if (context.owners.skill === 'ply') {
    const { data } = await nativeRpc.request('skills/list', { cwds: [cwd], forceReload: true });
    if (!Array.isArray(data)) throw new Error('Codex の Skills 一覧を確認できず、探索を停止できません');
    config['skills.config'] = data.flatMap(d => d.skills ?? []).map(s => ({ path: s.path, enabled: false }));
    config['features.plugins'] = false;
  }
  if (context.owners.mcp === 'ply') {
    const result = await nativeRpc.request('config/read', { cwd, includeLayers: false });
    if (!result.config) throw new Error('Codex の MCP 設定を確認できず、接続を停止できません');
    // Replace the map with disabled, credential-free placeholders. Codex's -c
    // dotted-path parser does not support quoted server names containing dots.
    config.mcp_servers = Object.fromEntries(Object.keys(result.config.mcp_servers ?? {}).map(name => [name, { command: process.execPath, enabled: false, required: false }]));
    config['features.plugins'] = false;
  }
  return new CodexRpc(config);
}

export function procwayContextSettings(native, context) {
  if (!context) return native;
  const settings = structuredClone(native);
  settings.context ??= {};
  if (context.owners.instruction === 'ply') {
    settings.context.instructionScanners = [];
    settings.rules = { all: [] };
  }
  if (context.owners.skill === 'ply') settings.context.skillScanners = [];
  settings.rules ??= {};
  settings.rules.all = [...(settings.rules.all ?? []), context.prompt];
  // Project buckets otherwise shadow the global bucket in procway's resolver.
  for (const key of Object.keys(settings.rules.projects ?? {})) settings.rules.projects[key] = [...settings.rules.projects[key], context.prompt];
  if (context.owners.mcp === 'ply') settings.mcpServers = {};
  settings.mcpServers = { ...settings.mcpServers, ply_context: { transport: 'http', baseUrl: context.url, headers: context.headers } };
  return settings;
}
