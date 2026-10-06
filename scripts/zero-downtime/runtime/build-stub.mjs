// 試験用アプリ（stub/）の NSIS インストーラーを 2 版（1.0.0 → 1.0.1）作り、更新の配信用フォルダーに置く。
//   node scripts/zero-downtime/runtime/build-stub.mjs [--port 8765]
// 出力は <リポジトリ>/temporary/zdprobe/ の下（git の対象外）。本物の Pleiad とは appId・製品名・実行ファイル名・更新のキャッシュ名が違う。
// ELECTRON_RUN_AS_NODE が入った環境（Pleiad のシェル）では、`env -u ELECTRON_RUN_AS_NODE` を付けて実行する。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../..');
const work = path.join(root, 'temporary', 'zdprobe');
const stage = path.join(work, 'stage');
const feed = path.join(work, 'feed');
const port = Number(process.argv[process.argv.indexOf('--port') + 1]) || 8765;
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const run = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, { stdio: 'inherit', shell: process.platform === 'win32', ...opts });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed (${r.status})`);
};

fs.mkdirSync(stage, { recursive: true });
fs.mkdirSync(feed, { recursive: true });
for (const f of ['main.cjs', 'spawner.cjs']) fs.copyFileSync(path.join(here, 'stub', f), path.join(stage, f));
fs.copyFileSync(path.join(here, 'job-info.cjs'), path.join(stage, 'job-info.cjs'));
fs.writeFileSync(path.join(stage, 'package.json'), JSON.stringify({
  name: 'zdprobe', version: '1.0.0', main: 'main.cjs', description: 'zero-downtime update probe', author: 'probe',
  dependencies: { koffi: pkg.dependencies.koffi, 'electron-updater': pkg.dependencies['electron-updater'] },
}, null, 2));
if (!fs.existsSync(path.join(stage, 'node_modules', 'electron-updater'))) run('npm', ['install', '--omit=dev', '--no-audit', '--no-fund'], { cwd: stage });

const config = {
  appId: 'jp.ply.zdprobe', productName: 'PlyZdProbe', artifactName: 'PlyZdProbe-${version}.${ext}',
  asar: false, npmRebuild: false, compression: 'store',
  electronDist: path.join(root, 'node_modules', 'electron', 'dist'), electronVersion: '44.5.1',
  directories: { app: stage, output: path.join(work, 'out') },
  win: { executableName: 'PlyZdProbe', target: [{ target: 'nsis', arch: ['x64'] }] },
  nsis: { oneClick: false, perMachine: false, allowToChangeInstallationDirectory: true, include: path.join(root, 'build', 'installer.nsh') },
  publish: { provider: 'generic', url: `http://127.0.0.1:${port}/`, updaterCacheDirName: 'plyzdprobe-updater' },
};
const configFile = path.join(work, 'builder-config.json');
fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
for (const version of ['1.0.0', '1.0.1']) {
  run('npx', ['electron-builder', '--config', configFile, '--win', 'nsis', '--x64', '--publish', 'never', `-c.extraMetadata.version=${version}`], { cwd: root });
  fs.copyFileSync(path.join(work, 'out', `PlyZdProbe-${version}.exe`), path.join(work, `PlyZdProbe-${version}.exe`));
  if (version === '1.0.1') for (const f of ['latest.yml', `PlyZdProbe-${version}.exe`]) fs.copyFileSync(path.join(work, 'out', f), path.join(feed, f));
}
console.log(JSON.stringify({ work, installers: fs.readdirSync(work).filter(f => f.endsWith('.exe')), feed: fs.readdirSync(feed) }));
