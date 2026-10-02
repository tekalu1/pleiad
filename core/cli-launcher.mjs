// pleiad CLI（bin/pleiad.mjs）の起動口と、外の AI に渡す MCP の設定（ADR 0090、docs/design.md「操作の一覧」の CLI）。
//
// - 起動口は bin/ の pleiad.cmd（Windows）と pleiad（シェルスクリプト）。デスクトップ版では resources/app/bin に入り、
//   Ply.exe（mac は Pleiad.app の MacOS/Pleiad）の内蔵 Node で bin/pleiad.mjs を走らせる。リポジトリでは node で走らせる
// - サーバーは起動時に bin/ を自分の PATH の先頭に足す。会話のシェル（Claude・Codex・Antigravity のプロセスと `!` の行）はそれを継ぐ
// - 外の AI の MCP の設定は、起動口ではなく実行ファイルと bin/pleiad.mjs を直に指す（Windows の .cmd はシェル無しでは起動できないため）
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const CLI_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin');
export const CLI_SCRIPT = path.join(CLI_DIR, 'pleiad.mjs');

/** env の中の PATH のキー（Windows は Path のことがある）。無ければ PATH */
export const pathKey = (env) => Object.keys(env).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH';

/** dir を PATH の先頭に足した値（同じ dir が既にあれば先頭へ寄せる。Windows は大文字小文字を区別しない） */
export function prependPath(value, dir, { delimiter = path.delimiter, win = process.platform === 'win32' } = {}) {
  const same = (a) => (win ? a.replace(/[\\/]+$/, '').toLowerCase() === dir.replace(/[\\/]+$/, '').toLowerCase() : a.replace(/\/+$/, '') === dir.replace(/\/+$/, ''));
  return [dir, ...String(value ?? '').split(delimiter).filter((entry) => entry && !same(entry))].join(delimiter);
}

/** env（既定は process.env）の PATH の先頭に CLI の起動口を足す。書き換えた env を返す */
export function addCliToPath(env = process.env, dir = CLI_DIR) {
  const key = pathKey(env);
  env[key] = prependPath(env[key], dir);
  return env;
}

// 貼る先のシェル（PowerShell・cmd・bash）のどれでも同じに読める形。\ と空白を含む値（Windows のパス）は " で囲むだけにする
// （\ を重ねると PowerShell と cmd では 2 つのまま残る）
const quoteArg = (s) => (/^[A-Za-z0-9_\-./:=@]+$/.test(s) ? s : `"${s}"`);

/**
 * 外の AI（Claude Code など）の MCP の設定に貼る pleiad mcp の起動の仕方。
 *   execPath  サーバーを走らせている実行ファイル（デスクトップ版は Ply.exe、npm start は node）
 *   electron  Electron の内蔵 Node か（ELECTRON_RUN_AS_NODE=1 を付ける）
 *   dataDir   サーバーのデータ置き場。既定（~/.agent-host）と違えば AGENT_HOST_DATA を付ける
 * 返り: { command, args, env, json（mcpServers の JSON の文字列）, claude（claude mcp add のコマンド） }
 */
export function mcpSetup({ execPath = process.execPath, electron = Boolean(process.versions.electron), dataDir, script = CLI_SCRIPT, home = os.homedir() } = {}) {
  const env = {
    ...(electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
    ...(dataDir && path.resolve(dataDir) !== path.resolve(home, '.agent-host') ? { AGENT_HOST_DATA: dataDir } : {}),
  };
  const args = [script, 'mcp'];
  const json = JSON.stringify({ mcpServers: { pleiad: { command: execPath, args, ...(Object.keys(env).length ? { env } : {}) } } }, null, 2);
  const claude = ['claude', 'mcp', 'add', '--scope', 'user', 'pleiad', ...Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]), '--', execPath, ...args].map(quoteArg).join(' ');
  return { command: execPath, args, env, json, claude };
}
