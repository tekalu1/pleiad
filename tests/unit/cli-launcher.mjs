// pleiad CLI の起動口と配り方（ADR 0090）。LLM は呼ばない。
//   - PATH の先頭に bin/ を足す（Windows の Path のキー・重ねて足さない）
//   - 外の AI に渡す MCP の設定の形（Electron なら ELECTRON_RUN_AS_NODE・既定でないデータ置き場なら AGENT_HOST_DATA・claude mcp add の形）
//   - 起動口の改行（sh は LF、.cmd は CRLF）と、デスクトップ版の同梱（electron-builder.yml の files）
//   - サーバー越し: 会話の `!` の行で pleiad が起動口から動く・画面の app.cliSetup
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CLI_DIR, CLI_SCRIPT, addCliToPath, mcpSetup, pathKey, prependPath, stableCli } from '../../core/cli-launcher.mjs';
import { agentDefinition } from '../../core/backends/antigravity-context.mjs';
import { startServer, ROOT } from '../lib/server.mjs';
import { open } from '../lib/ws-client.mjs';

export const name = 'cli-launcher';
export const title = 'pleiad CLI の起動口: 会話のシェルの PATH・外の AI の MCP の設定・同梱';

export default async function (t) {
  // ---- PATH
  t.ok('prependPath: 先頭に足す', prependPath('/a:/b', '/cli', { delimiter: ':', win: false }) === '/cli:/a:/b');
  t.ok('prependPath: 同じものがあれば先頭へ寄せる（重ねない）', prependPath('/a:/cli/:/b', '/cli', { delimiter: ':', win: false }) === '/cli:/a:/b');
  t.ok('prependPath: Windows は大文字小文字と末尾の \\ を区別しない',
    prependPath('C:\\Windows;D:\\Pleiad\\BIN\\', 'D:\\pleiad\\bin', { delimiter: ';', win: true }) === 'D:\\pleiad\\bin;C:\\Windows');
  t.ok('prependPath: 空の PATH', prependPath(undefined, '/cli', { delimiter: ':', win: false }) === '/cli');
  t.ok('pathKey: Windows の Path をそのまま使う（PATH を別に作らない）', pathKey({ Path: 'x' }) === 'Path' && pathKey({}) === 'PATH');
  const env = addCliToPath({ Path: 'C:\\Windows' });
  t.ok('addCliToPath: 既存のキーに足す', Object.keys(env).length === 1 && env.Path.startsWith(CLI_DIR) && env.Path.endsWith('C:\\Windows'), JSON.stringify(env));

  // ---- 外の AI の MCP の設定
  const home = path.join(os.tmpdir(), 'home');
  const desktop = mcpSetup({ execPath: 'C:\\Users\\me\\AppData\\Local\\Programs\\Pleiad\\Ply.exe', electron: true, dataDir: path.join(home, '.agent-host'), home,
    script: 'C:\\Users\\me\\AppData\\Local\\Programs\\Pleiad\\resources\\app\\bin\\pleiad.mjs' });
  const server = JSON.parse(desktop.json).mcpServers?.pleiad;
  t.ok('デスクトップ版: command は実行ファイル、args は [pleiad.mjs, mcp]、env は ELECTRON_RUN_AS_NODE だけ',
    server?.command.endsWith('Ply.exe') && server.args.length === 2 && server.args[0].endsWith('pleiad.mjs') && server.args[1] === 'mcp'
    && JSON.stringify(server.env) === '{"ELECTRON_RUN_AS_NODE":"1"}', desktop.json);
  t.ok('デスクトップ版: claude mcp add は -e で env を付け、\\ を含むパスは " で囲む（重ねない）',
    desktop.claude === 'claude mcp add --scope user pleiad -e ELECTRON_RUN_AS_NODE=1 -- "C:\\Users\\me\\AppData\\Local\\Programs\\Pleiad\\Ply.exe" "C:\\Users\\me\\AppData\\Local\\Programs\\Pleiad\\resources\\app\\bin\\pleiad.mjs" mcp', desktop.claude);
  const repo = mcpSetup({ execPath: '/usr/bin/node', electron: false, dataDir: '/tmp/pleiad-data', home, script: '/src/pleiad/bin/pleiad.mjs' });
  t.ok('npm start・別のデータ置き場: ELECTRON_RUN_AS_NODE は付けず、AGENT_HOST_DATA を付ける',
    JSON.stringify(JSON.parse(repo.json).mcpServers.pleiad) === JSON.stringify({ command: '/usr/bin/node', args: ['/src/pleiad/bin/pleiad.mjs', 'mcp'], env: { AGENT_HOST_DATA: '/tmp/pleiad-data' } })
    && repo.claude === 'claude mcp add --scope user pleiad -e AGENT_HOST_DATA=/tmp/pleiad-data -- /usr/bin/node /src/pleiad/bin/pleiad.mjs mcp', `${repo.json}\n${repo.claude}`);
  const plain = mcpSetup({ execPath: '/usr/bin/node', electron: false, dataDir: path.join(home, '.agent-host'), home });
  t.ok('既定のデータ置き場の npm start: env を付けない・script は bin/pleiad.mjs',
    !('env' in JSON.parse(plain.json).mcpServers.pleiad) && plain.args[0] === CLI_SCRIPT, plain.json);

  // ---- 実行場所で走るサーバー（無停止の更新 1-3）: 外の AI に貼る設定は版に依らない起動口を指す
  t.ok('stableCli: env が無ければ null（npm start・今のデスクトップ版は変わらない）', stableCli({}) === null && stableCli({ PLEIAD_CLI_EXEC: 'x' }) === null);
  const stableEnv = { PLEIAD_CLI_EXEC: 'C:/Users/me/AppData/Local/Programs/Pleiad/Ply.exe', PLEIAD_CLI_SCRIPT: 'C:/Users/me/AppData/Local/Programs/Pleiad/resources/app/bin/pleiad.mjs', PLEIAD_CLI_ELECTRON: '1' };
  const stable = mcpSetup({ stable: stableCli(stableEnv), dataDir: path.join(home, '.agent-host'), home });
  t.ok('実行場所のサーバー: 貼る設定は $INSTDIR の Ply.exe と resources/app/bin/pleiad.mjs・ELECTRON_RUN_AS_NODE（実行場所の版ごとのパスを含まない）',
    stable.command === stableEnv.PLEIAD_CLI_EXEC && stable.args[0] === stableEnv.PLEIAD_CLI_SCRIPT && JSON.stringify(stable.env) === '{"ELECTRON_RUN_AS_NODE":"1"}' && !/agent-host-runtime|pleiad-node/.test(stable.json), stable.json);
  const stableNode = mcpSetup({ stable: stableCli({ ...stableEnv, PLEIAD_CLI_ELECTRON: '' }), dataDir: path.join(home, '.agent-host'), home });
  t.ok('実行場所のサーバー: 起動口が素の Node なら ELECTRON_RUN_AS_NODE は付けない', !('env' in JSON.parse(stableNode.json).mcpServers.pleiad));
  // agy の relay: サーバーが実行場所の pleiad-node.exe（素の Node）で走ると、relay も同じ実行ファイルで、Electron 用の env は付かない
  const relayNode = String(agentDefinition({ owners: {}, prompt: 'p', cwd: home, home, execPath: 'C:/rt/node/24.21.0-abc/pleiad-node.exe', electron: false }));
  t.ok('agy の relay: 実行場所の pleiad-node.exe で走り、ELECTRON_RUN_AS_NODE を付けない', relayNode.includes('pleiad-node.exe') && !relayNode.includes('ELECTRON_RUN_AS_NODE'), relayNode.slice(0, 400));
  const relayElectron = String(agentDefinition({ owners: {}, prompt: 'p', cwd: home, home, execPath: 'C:/Pleiad/Ply.exe', electron: true }));
  t.ok('agy の relay: 今のデスクトップ版（Ply.exe）は ELECTRON_RUN_AS_NODE=1 を付ける（変えない）', relayElectron.includes('ELECTRON_RUN_AS_NODE'));

  // ---- 起動口と同梱
  const sh = await fs.readFile(path.join(CLI_DIR, 'pleiad'), 'utf8');
  const cmd = await fs.readFile(path.join(CLI_DIR, 'pleiad.cmd'), 'utf8');
  t.ok('起動口: シェルスクリプトは LF（CRLF だと sh が読めない）', sh.startsWith('#!/bin/sh\n') && !sh.includes('\r'));
  t.ok('起動口: .cmd は CRLF・内蔵 Node で走らせる', cmd.split('\n').slice(0, -1).every(line => line.endsWith('\r')) && cmd.includes('ELECTRON_RUN_AS_NODE=1') && cmd.includes('Ply.exe'));
  t.ok('起動口: 実行場所の版の bin では runtime-node.txt の指す pleiad-node を先に探す（.cmd・sh とも）', cmd.includes('runtime-node.txt') && cmd.includes('pleiad-node.exe') && sh.includes('runtime-node.txt') && sh.includes('pleiad-node'));
  const builder = await fs.readFile(path.join(ROOT, 'electron-builder.yml'), 'utf8');
  t.ok('デスクトップ版に bin/ を同梱する（electron-builder.yml の files）', /^\s*- bin\/\*\*\s*$/m.test(builder));

  // ---- サーバー越し
  const scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'agent-host-cli-')));
  const dataDir = path.join(scratch, 'data');
  // 外から継いだ会話の接続（PLEIAD_CONTROL_*）は空にして、このサーバーの control.json でつなぐ
  const running = await startServer({ env: { AGENT_HOST_BACKENDS: 'fake', PLEIAD_CONTROL_URL: '', PLEIAD_CONTROL_TOKEN: '' }, dataDir, timeoutMs: 60_000 });
  const c = await open({ ...running, autoAllow: true });
  try {
    const { sessionId } = await c.cmd('newSession', { backend: 'fake', cwd: ROOT });
    const from = c.mark();
    await c.cmd('runShell', { sessionId, runId: 'cli-path-run-0001', command: 'command -v pleiad; pleiad status --json', cwd: ROOT });
    const done = await c.waitFor(e => e.type === 'shell.done' && e.runId === 'cli-path-run-0001', { from, ms: 30_000 });
    const out = c.since(from).filter(e => e.type === 'shell.output' && e.runId === 'cli-path-run-0001').map(e => e.text).join('');
    let status = null;
    try { status = JSON.parse(out.slice(out.indexOf('{'))); } catch {}
    const found = out.split(/\r?\n/)[0].replace(/\\/g, '/');
    t.ok('会話の `!` の行で、PATH の起動口（このリポジトリの bin/）から pleiad が動き、このサーバーにつながる',
      found.endsWith(`${path.basename(ROOT)}/bin/pleiad`) && done.exitCode === 0 && typeof status?.version === 'string', `${done.exitCode} ${out}`);

    const setup = await c.cmd('invoke', { op: 'app.cliSetup', args: {} });
    const entry = JSON.parse(setup.json).mcpServers.pleiad;
    t.ok('画面の app.cliSetup: このサーバーの実行ファイル・bin/pleiad.mjs・別のデータ置き場の AGENT_HOST_DATA',
      entry.command === process.execPath && entry.args[0] === CLI_SCRIPT && entry.args[1] === 'mcp' && entry.env?.AGENT_HOST_DATA === dataDir, setup.json);
  } finally {
    c.close();
    await running.stop();
    await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}
