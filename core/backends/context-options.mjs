import { CodexRpc } from './codex-rpc.mjs';
import { t } from '../i18n.mjs';

// 指示を Pleiad が担当するとき、Claude Code に読ませない指示ファイル。
// AGENTS.md も含める: CLI 2.1.280 は CLAUDE.md と同じく Project の指示として読む（2026-09-23 確認）。
// 読んだかどうかは最初のプロンプトを処理するまで memoryFiles に出ないので、claude.mjs の起動時の確認では見逃す
export const CLAUDE_MD_EXCLUDES = ['**/CLAUDE.md', '**/CLAUDE.local.md', '**/AGENTS.md', '**/.claude/rules/**'];

/**
 * Pleiad の担当の分の query() のオプション。hooks: Hooks を Pleiad がそろえる会話（ADR 0049）なら、フラグ設定に disableAllHooks を入れて
 * ユーザー・プロジェクト・ローカル・プラグインの hooks を止める（管理者の hooks は止まらない）。登録はコールバックで渡す（claude.mjs）
 * bot: bot の会話（ADR 0109）。Claude Code の組み込みの自動メモリを切る。「覚えて」は Pleiad の記憶（memory.write）に入れるもので、
 * 組み込みのメモリは本物のホーム（~/.claude/projects/…/memory）へ確認なしに書いてしまう（2026-10-03 の実機の確認）
 */
export function claudeContextOptions(context, { compact = false, hooks = false, bot = false } = {}) {
  const settings = {
    ...(context?.owners.instruction === 'ply' ? { claudeMdExcludes: CLAUDE_MD_EXCLUDES } : {}),
    ...(context?.owners.instruction === 'ply' || bot ? { autoMemoryEnabled: false } : {}),
    ...(hooks ? { disableAllHooks: true } : {}),
  };
  const withSettings = Object.keys(settings).length ? { settings } : {};
  if (!context) return withSettings;
  const { owners } = context;
  return {
    ...withSettings,
    ...(owners.skill === 'ply' ? { skills: [], ...(!compact ? { extraArgs: { 'disable-slash-commands': null } } : {}), disallowedTools: ['Skill'] } : {}),
    ...(owners.mcp === 'ply' ? { strictMcpConfig: true } : {}),
    ...(context.prompt ? { systemPrompt: { type: 'preset', preset: 'claude_code', append: context.prompt } } : {}),
  };
}

export function claudeQueryExtraArgs(contextOptions) {
  return { 'replay-user-messages': null, ...contextOptions.extraArgs };
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
    if (!Array.isArray(data)) throw new Error(t('backends.context.codexSkills'));
    config['skills.config'] = data.flatMap(d => d.skills ?? []).map(s => ({ path: s.path, enabled: false }));
    config['features.plugins'] = false;
  }
  if (context.owners.mcp === 'ply') {
    const result = await nativeRpc.request('config/read', { cwd, includeLayers: false });
    if (!result.config) throw new Error(t('backends.context.codexMcp'));
    // Replace the map with disabled, credential-free placeholders. Codex's -c
    // dotted-path parser does not support quoted server names containing dots.
    config.mcp_servers = Object.fromEntries(Object.keys(result.config.mcp_servers ?? {}).map(name => [name, { command: process.execPath, enabled: false, required: false }]));
    config['features.plugins'] = false;
  }
  return new CodexRpc(config);
}
