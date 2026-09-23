// Explicit opt-in probe. Starts native engines, but sends no user turn or LLM request.
// All preferences and instruction fixtures live under a temporary home.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { rpc } from '../../core/backends/codex-rpc.mjs';
import { containsPath } from '../../core/context-settings.mjs';
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-native-context-'));
const repo = path.join(tmp, 'repo'), claudeHome = path.join(tmp, 'claude'), codexHome = path.join(tmp, 'codex');
const write = async (p, s) => { await fs.mkdir(path.dirname(p), { recursive: true }); await fs.writeFile(p, s); };
let release;
const report = [];
try {
  await fs.mkdir(path.join(repo, '.git'), { recursive: true });
  await fs.mkdir(claudeHome); await fs.mkdir(codexHome);
  await write(path.join(repo, 'CLAUDE.md'), 'PLY_PROJECT_SENTINEL');
  await write(path.join(claudeHome, 'CLAUDE.md'), 'PLY_USER_SENTINEL');
  await write(path.join(repo, '.mcp.json'), JSON.stringify({ mcpServers: { plyDisk: { command: process.execPath, args: [path.join(tmp, 'mcp.mjs')] } } }));
  await write(path.join(tmp, 'mcp.mjs'), `import readline from 'node:readline';
for await (const line of readline.createInterface({input:process.stdin})) {
  const m = JSON.parse(line); if (m.id === undefined) continue;
  const result = m.method === 'initialize' ? {protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'plyDisk',version:'1'}} : m.method === 'tools/list' ? {tools:[]} : {};
  process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');
}`);
  for (const dir of [path.join(repo, '.claude/skills/ply-probe'), path.join(repo, '.agents/skills/ply-probe')]) await write(path.join(dir, 'SKILL.md'), '---\nname: ply-probe\ndescription: Only for a local probe\n---\nPLY_SKILL_SENTINEL');
  const keepSources = ['user', 'project', 'local'];
  for (const [label, extra] of [
    ['native', { settingSources: keepSources, skills: 'all', settings: { enableAllProjectMcpServers: true } }],
    ['isolated', { settingSources: [], skills: [], strictMcpConfig: true }],
    ['selective', { settingSources: keepSources, skills: [], strictMcpConfig: true,
      settings: { claudeMdExcludes: ['**/CLAUDE.md', '**/CLAUDE.local.md', '**/.claude/rules/**'], enableAllProjectMcpServers: true },
      mcpServers: { plyExplicit: { command: process.execPath, args: [path.join(tmp, 'mcp.mjs')] } } }],
  ]) {
    const gate = new Promise(resolve => { release = resolve; });
    async function* prompt() { await gate; }
    const abortController = new AbortController();
    const timer = setTimeout(() => abortController.abort(), 30000);
    const q = query({ prompt: prompt(), options: { cwd: repo, abortController, ...extra,
      env: { ...process.env, CLAUDE_CONFIG_DIR: claudeHome, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' },
      systemPrompt: { type: 'preset', preset: 'claude_code' }, persistSession: false,
    } });
    try {
      await q.initializationResult();
      const usage = await q.getContextUsage({ detail: 'summary' });
      const commands = await q.supportedCommands();
      report.push({ backend: 'claude', label, memoryFiles: usage.memoryFiles?.map(f => path.relative(tmp, f.path)),
        probeSkillListed: commands.some(s => s.name === 'ply-probe'),
        probeSkillInContext: usage.skills?.skillFrontmatter?.some(s => s.name === 'ply-probe') ?? null,
        mcpServers: (await q.mcpServerStatus()).map(s => ({ name: s.name, status: s.status })) });
    } catch (e) { report.push({ backend: 'claude', label, error: e.name, message: '初期化またはコンテキスト照会に失敗' }); }
    finally { clearTimeout(timer); release(); q.close(); }
  }
  process.env.CODEX_HOME = codexHome;
  // launch() inherits cwd; isolate ancestor configuration discovery too.
  process.chdir(repo);
  for (const [label, disabled] of [['native', false], ['disabled-folder', true], ['disabled-file', true]]) {
    const skill = path.join(repo, '.agents/skills/ply-probe', label === 'disabled-file' ? 'SKILL.md' : '').replaceAll('\\', '/');
    await write(path.join(codexHome, 'config.toml'), `${disabled ? 'project_doc_max_bytes = 0\n' : ''}[[skills.config]]\npath = ${JSON.stringify(skill)}\nenabled = ${!disabled}\n`);
    try {
      const response = await rpc.request('skills/list', { cwds: [repo], forceReload: true });
      const found = response.data?.flatMap(d => d.skills ?? []).find(s => s.name === 'ply-probe');
      const config = await rpc.request('config/read', { cwd: repo, includeLayers: false });
      report.push({ backend: 'codex', label, probeSkillFound: Boolean(found), enabled: found?.enabled, projectDocMaxBytes: config.config?.project_doc_max_bytes ?? null });
    } catch (e) { report.push({ backend: 'codex', label, error: e.name, message: '設定照会に失敗' }); }
    finally { rpc.stop(); }
  }
  console.log(JSON.stringify({ noTurnsSent: true, observations: report }, null, 2));
} finally {
  rpc.stop(); release?.(); process.chdir(os.tmpdir());
  if (!containsPath(os.tmpdir(), tmp) || !path.basename(tmp).startsWith('ply-native-context-')) throw new Error('unexpected probe path');
  await fs.rm(tmp, { recursive: true, maxRetries: 5, retryDelay: 200 });
}
