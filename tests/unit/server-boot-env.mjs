// main がサーバーを起こすときにだけ渡す変数（core/boot-env.mjs）を、サーバーが子（エージェントの CLI・`!` の行・外部の MCP）へ渡さない。LLM は呼ばない。
//   - 一覧: desktop/server-boot.cjs の serverEnv と desktop/main.cjs の utilityProcess が渡すもののうち、子へ渡すためのもの（PLEIAD_CLI_*・PATH）以外を全部含む
//   - takeBootEnv: 外して値を返す（大小を区別しない）。PLEIAD_CONTROL_*・AGENT_HOST_DATA・ELECTRON_RUN_AS_NODE は残す
//   - env を組む所ごと: 外した後の process.env から組む Claude の env（会話・使用量・ログイン）・外部の MCP（stdio）・`!` の行のシェル
//   - テストのサーバーの起動（tests/lib/server.mjs の serverBaseEnv）も、実行元のシェルの起動用の変数と PLEIAD_CLI_*・PLEIAD_CONTROL_* を継がない
//   - サーバー越し: 起動用の変数を付けて起こしたサーバーの `!` の行と Codex の CLI に届かない。サーバー自身は読んでいる（使用中の印・main とのパイプ）
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { BOOT_ENV_NAMES, isBootEnvName, takeBootEnv, withoutBootEnv } from '../../core/boot-env.mjs';
import { claudeEnv } from '../../core/claude-accounts.mjs';
import { usageEnv } from '../../core/backends/claude-usage.mjs';
import { loginEnv } from '../../core/claude-login.mjs';
import { mcpTransportConfig } from '../../core/context-runtime.mjs';
import { runHostShell } from '../../core/host-shell.mjs';
import { linkFilePath } from '../../core/main-link.mjs';
import { RUN_DIR } from '../../core/runtime-use.mjs';
import { startServer, ROOT } from '../lib/server.mjs';
import { serverBaseEnv } from '../lib/inherited-env.mjs';
import { open } from '../lib/ws-client.mjs';

export const name = 'server-boot-env';
export const title = '起動用の変数を子へ渡さない: 一覧・外し方・env を組む所ごと・サーバー越しの `!` の行と Codex の CLI';

const require = createRequire(import.meta.url);
const boot = require('../../desktop/server-boot.cjs');
const { stableCliEnv } = require('../../desktop/runtime.cjs');

// 子へ渡すために main が付けるもの（外さない）
const FOR_CHILDREN = new Set(['PATH', 'PLEIAD_CLI_EXEC', 'PLEIAD_CLI_SCRIPT', 'PLEIAD_CLI_ELECTRON']);
const leaked = (names) => names.filter(isBootEnvName);

// 起動用の変数を一通り付けた env（値は偽物。実行場所は一時ディレクトリ）
const bootValues = (scratch) => ({
  AGENT_HOST_HANDOVER: 'on', AGENT_HOST_PORT: '0', AGENT_HOST_BIND: '127.0.0.1', AGENT_HOST_TOKEN: 'boot-token',
  AGENT_HOST_SYSTEM_LOCALE: 'en', AGENT_HOST_SERVER_LOG: path.join(scratch, 'server.log'),
  AGENT_HOST_RUNTIME_ROOT: path.join(scratch, 'runtime'), AGENT_HOST_RUNTIME_KEY: 'test-key',
  AGENT_HOST_RUNTIME_RESOURCES: path.join(scratch, 'resources'), AGENT_HOST_RUNTIME_DIR: path.join(scratch, 'runtime-dir'),
});

export default async function (t) {
  const scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'agent-host-boot-env-')));

  // ---- 一覧
  const fromBoot = boot.serverEnv({ baseEnv: {}, agentBrowserDir: 'D', root: 'r', key: 'k', logFile: 'l', port: 7421, token: 'tok', systemLocale: 'ja',
    stableCliEnv: stableCliEnv({ execPath: 'C:\\Ply\\Ply.exe', resourcesPath: 'C:\\Ply\\resources' }) });
  const bootMissing = Object.keys(fromBoot).filter(k => !FOR_CHILDREN.has(k) && !isBootEnvName(k));
  t.ok('serverEnv が渡すもの（PATH・PLEIAD_CLI_* 以外）は全部一覧にある', bootMissing.length === 0, JSON.stringify(bootMissing));
  const mainSource = await fs.readFile(path.join(ROOT, 'desktop', 'main.cjs'), 'utf8');
  const forkEnv = /utilityProcess\.fork\([\s\S]*?env: \{([^\n]*)\}/.exec(mainSource)?.[1] ?? '';
  const forkNames = [...forkEnv.matchAll(/\b([A-Z][A-Z0-9_]+):/g)].map(m => m[1]);
  t.ok('utilityProcess が渡すもの（PATH 以外）も全部一覧にある', forkNames.length >= 4 && forkNames.every(k => FOR_CHILDREN.has(k) || isBootEnvName(k)), JSON.stringify(forkNames));
  t.ok('子へ渡すもの（PLEIAD_CONTROL_*・PLEIAD_CLI_*・AGENT_HOST_DATA・ELECTRON_RUN_AS_NODE）は一覧にない',
    !['PLEIAD_CONTROL_URL', 'PLEIAD_CONTROL_TOKEN', 'PLEIAD_CLI_EXEC', 'AGENT_HOST_DATA', 'ELECTRON_RUN_AS_NODE', 'PATH'].some(isBootEnvName));

  // ---- takeBootEnv・withoutBootEnv
  const env = { ...bootValues(scratch), agent_host_port: '7421', PLEIAD_CONTROL_URL: 'http://127.0.0.1:1', PLEIAD_CLI_EXEC: 'x', AGENT_HOST_DATA: 'd', ELECTRON_RUN_AS_NODE: '1', Path: 'p' };
  const copy = withoutBootEnv(env);
  t.ok('withoutBootEnv: 写しから除き、元は書き換えない', leaked(Object.keys(copy)).length === 0 && env.AGENT_HOST_HANDOVER === 'on' && copy.PLEIAD_CONTROL_URL === env.PLEIAD_CONTROL_URL);
  const taken = takeBootEnv(env);
  t.ok('takeBootEnv: 一覧の変数を全部外す（小文字の名前も）', leaked(Object.keys(env)).length === 0, JSON.stringify(Object.keys(env)));
  t.ok('takeBootEnv: 外した値を一覧の名前で返す', taken.AGENT_HOST_HANDOVER === 'on' && taken.AGENT_HOST_RUNTIME_KEY === 'test-key' && taken.AGENT_HOST_PORT !== undefined
    && Object.keys(taken).every(k => BOOT_ENV_NAMES.includes(k)) && Object.isFrozen(taken), JSON.stringify(taken));
  t.ok('takeBootEnv: 子へ渡すものは残す', env.PLEIAD_CONTROL_URL && env.PLEIAD_CLI_EXEC && env.AGENT_HOST_DATA && env.ELECTRON_RUN_AS_NODE && env.Path);

  // ---- テストのサーバーの起動（tests/lib/server.mjs）は、実行元のシェルの起動用の変数と、会話のシェルへ渡す PLEIAD_CLI_*・PLEIAD_CONTROL_* を継がない
  const base = serverBaseEnv({ ...bootValues(scratch), PLEIAD_CLI_EXEC: 'Ply.exe', PLEIAD_CLI_SCRIPT: 's', PLEIAD_CLI_ELECTRON: '1', PLEIAD_CONTROL_URL: 'u',
    PLY_CONTEXT_URL: 'c', AGENT_BROWSER_SESSION: 'b', PLEIAD_TEST_GUARD_HOME: 'g', AGENT_HOST_DATA: 'd', AGENT_HOST_CODEX_BIN: 'codex', Path: 'p' });
  t.ok('serverBaseEnv: 起動用の変数・PLEIAD_CLI_*・PLEIAD_CONTROL_*・PLY_*・AGENT_BROWSER_* を除き、PLEIAD_TEST_*・テストが入れる AGENT_HOST_* は残す',
    JSON.stringify(Object.keys(base).sort()) === JSON.stringify(['AGENT_HOST_CODEX_BIN', 'AGENT_HOST_DATA', 'PLEIAD_TEST_GUARD_HOME', 'Path']), JSON.stringify(Object.keys(base)));

  // ---- env を組む所ごと（サーバーと同じく process.env から外した後に組む）
  const saved = Object.fromEntries(BOOT_ENV_NAMES.map(k => [k, process.env[k]]));
  Object.assign(process.env, bootValues(scratch));
  try {
    takeBootEnv(process.env);
    t.ok('Claude の会話の env（claudeEnv）に入らない', leaked(Object.keys(claudeEnv(process.env, { token: 'x', extra: { CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: '0' } }))).length === 0);
    t.ok('Claude の使用量の env（usageEnv）に入らない', leaked(Object.keys(usageEnv(process.env, { configDir: scratch }))).length === 0);
    t.ok('Claude のログインの env（loginEnv）に入らない', leaked(Object.keys(loginEnv(process.env, { configDir: scratch }))).length === 0);
    const item = source => ({ name: 'fixture', definition: { command: process.execPath, args: ['x.mjs'], env: { TOKEN: 'v' } }, origins: [{ source }] });
    for (const source of ['claude', 'codex']) {
      const mcp = mcpTransportConfig(item(source), scratch);
      t.ok(`外部の MCP（stdio・${source} の登録）の env に入らない`, mcp.type === 'stdio' && mcp.env.TOKEN === 'v' && leaked(Object.keys(mcp.env)).length === 0);
    }
    const printer = path.join(scratch, 'print-env.mjs');
    await fs.writeFile(printer, "console.log('ENV=' + JSON.stringify(Object.keys(process.env)));\n");
    const shell = await runHostShell({ command: `node "${printer.replaceAll('\\', '/')}"`, cwd: scratch, timeoutMs: 30_000 });
    const names = JSON.parse(/ENV=(\[.*\])/.exec(shell.stdout)?.[1] ?? 'null');
    t.ok('`!` の行のシェル（runHostShell）に入らない', Array.isArray(names) && names.length > 0 && leaked(names).length === 0, JSON.stringify(Array.isArray(names) ? leaked(names) : shell.stdout + shell.stderr));
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }

  // ---- サーバー越し: 起動用の変数を付けて起こす（AGENT_HOST_SERVER_LOG は付けない。出力がファイルへ向き、起動の合図が見えない）
  const dataDir = path.join(scratch, 'data');
  const codexEnvFile = path.join(scratch, 'codex-env.json');
  const codexWrapper = path.join(scratch, 'codex-wrapper.mjs');
  await fs.writeFile(codexWrapper, [
    "import fs from 'node:fs';",
    `fs.writeFileSync(${JSON.stringify(codexEnvFile)}, JSON.stringify(Object.keys(process.env)));`,
    `await import(${JSON.stringify(new URL('../lib/fake-codex.mjs', import.meta.url).href)});`,
  ].join('\n'));
  const values = bootValues(scratch);
  delete values.AGENT_HOST_SERVER_LOG;
  delete values.AGENT_HOST_PORT;   // startServer が 0 を渡す
  delete values.AGENT_HOST_TOKEN;
  await fs.mkdir(values.AGENT_HOST_RUNTIME_ROOT, { recursive: true });
  const server = await startServer({
    env: { ...values, AGENT_HOST_BACKENDS: 'fake,codex', AGENT_HOST_CODEX_BIN: `node "${codexWrapper}"`, FAKE_CODEX_LOG: path.join(scratch, 'codex.log') },
    dataDir, timeoutMs: 60_000,
  });
  const c = await open({ ...server, autoAllow: true });
  try {
    t.ok('サーバーは起動用の変数を読んでいる（AGENT_HOST_HANDOVER=on の main とのパイプ）', existsSync(linkFilePath(dataDir)));
    const marks = await fs.readdir(path.join(values.AGENT_HOST_RUNTIME_ROOT, RUN_DIR)).catch(() => []);
    t.ok('サーバーは起動用の変数を読んでいる（AGENT_HOST_RUNTIME_ROOT・KEY の使用中の印）', marks.some(f => f.startsWith('test-key-')), JSON.stringify(marks));

    const { sessionId } = await c.cmd('newSession', { backend: 'fake', cwd: ROOT });
    const from = c.mark();
    const printer = path.join(scratch, 'print-env.mjs').replaceAll('\\', '/');
    await c.cmd('runShell', { sessionId, runId: 'boot-env-run-0001', command: `node "${printer}"`, cwd: ROOT });
    await c.waitFor(e => e.type === 'shell.done' && e.runId === 'boot-env-run-0001', { from, ms: 30_000 });
    const out = c.since(from).filter(e => e.type === 'shell.output' && e.runId === 'boot-env-run-0001').map(e => e.text).join('');
    const shellNames = JSON.parse(/ENV=(\[.*\])/.exec(out)?.[1] ?? 'null');
    t.ok('サーバー越し: `!` の行に起動用の変数が届かない', Array.isArray(shellNames) && leaked(shellNames).length === 0, JSON.stringify(Array.isArray(shellNames) ? leaked(shellNames) : out));

    await c.runTurn({ backend: 'codex', prompt: 'hello', cwd: ROOT });
    const codexNames = JSON.parse(await fs.readFile(codexEnvFile, 'utf8').catch(() => 'null'));
    t.ok('サーバー越し: エージェントの CLI（Codex）に起動用の変数が届かない', Array.isArray(codexNames) && leaked(codexNames).length === 0, JSON.stringify(Array.isArray(codexNames) ? leaked(codexNames) : codexNames));
  } finally {
    await c.close?.();
    await server.stop();
    await fs.rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
  }
}
