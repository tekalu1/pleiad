// 段階 1 の 1-7 の実機の確認（本物のインストーラーで更新する）の共通の部品。
// 試験用のアプリは、利用者のインストール版（appId jp.ply.desktop・%LOCALAPPDATA%\Programs\Ply・~/.agent-host・
// %LOCALAPPDATA%\agent-host-runtime・%APPDATA%\agent-host）と、名前・場所・ポートの全部が重ならない（docs/zero-downtime-update/stage1-7.md）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
export const LOCAL = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');

/** 試験用の構成。利用者のものと重ならない名前・場所・ポート */
export const ZD = {
  appId: 'jp.ply.zdtest',
  productName: 'PleiadZdTest',
  exe: 'PleiadZdTest.exe',
  packageName: 'pleiad-zdtest',
  updaterCache: 'pleiad-zdtest-updater',
  installDir: path.join(LOCAL, 'Programs', 'PleiadZdTest'),
  /** データ置き場・実行場所・userData・設定。$INSTDIR の前方一致にならない場所 */
  home: path.join(LOCAL, 'pleiad-zdtest'),
  port: 17420,
  feedPort: 17499,
};
export const zdPaths = home => ({
  data: path.join(home, 'data'), runtime: path.join(home, 'runtime'), userData: path.join(home, 'userdata'), config: path.join(home, 'config.json'),
});

/** 利用者のインストール版の場所（触れない。重ならないことの確認に使う） */
export const USER_INSTALL = {
  installDir: path.join(LOCAL, 'Programs', 'Ply'),
  data: path.join(os.homedir(), '.agent-host'),
  runtime: path.join(LOCAL, 'agent-host-runtime'),
  userData: path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'agent-host'),
  appId: 'jp.ply.desktop',
  port: 7420,
};

const norm = p => path.resolve(p).toLowerCase().replace(/[\\/]+$/, '');
/** a が b と同じ・b の中・b と同じ文字列で始まる（NSIS の前方一致）か */
export const overlaps = (a, b) => norm(a).startsWith(norm(b)) || norm(b).startsWith(norm(a));

/** 試験用の構成が、利用者のインストール版と重ならないことを確かめる。重なれば投げる */
export function assertIsolated(zd = ZD, user = USER_INSTALL) {
  const paths = zdPaths(zd.home);
  const mine = { installDir: zd.installDir, home: zd.home, data: paths.data, runtime: paths.runtime, userData: paths.userData };
  const theirs = { installDir: user.installDir, data: user.data, runtime: user.runtime, userData: user.userData };
  const found = [];
  for (const [a, pa] of Object.entries(mine)) for (const [b, pb] of Object.entries(theirs)) if (overlaps(pa, pb)) found.push(`${a} ${pa} <-> ${b} ${pb}`);
  if (zd.appId === user.appId) found.push(`appId ${zd.appId}`);
  if (zd.port === user.port) found.push(`port ${zd.port}`);
  if (found.length) throw new Error(`the test setup overlaps the user's install:\n${found.join('\n')}`);
  return { mine, theirs };
}

/** Pleiad のシェルから引き継がれた変数（ポート・制御・ブラウザー・Node 化）を外した env */
export function cleanEnv(extra = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(AGENT_HOST_|PLEIAD_|AGENT_BROWSER_|ELECTRON_RUN_AS_NODE$)/.test(key)) delete env[key];
  }
  return { ...env, ...extra };
}

export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export function ps(script, { timeout = 60000 } = {}) {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', timeout });
  return { status: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}

/** 実行ファイルのパスが dir の下（または前方一致）のプロセス。{ pid, name, path, parent } */
export function processesUnder(prefixes) {
  const list = Array.isArray(prefixes) ? prefixes : [prefixes];
  const conds = list.map(p => `$_.ExecutablePath -and $_.ExecutablePath.StartsWith('${p.replace(/'/g, "''")}', [StringComparison]::OrdinalIgnoreCase)`).join(' -or ');
  const r = ps(`Get-CimInstance Win32_Process | Where-Object { ${conds} } | ForEach-Object { '{0}|{1}|{2}|{3}' -f $_.ProcessId, $_.Name, $_.ExecutablePath, $_.ParentProcessId }`);
  return r.out.split(/\r?\n/).filter(Boolean).map(line => { const [pid, name, exe, parent] = line.split('|'); return { pid: Number(pid), name, path: exe, parent: Number(parent) }; });
}

export const isAlive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
