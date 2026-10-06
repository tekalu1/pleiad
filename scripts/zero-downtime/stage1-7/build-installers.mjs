// 試験用の NSIS インストーラー（署名なし）を、版の違う変種で作る。利用者のインストール版とは appId・製品名・実行ファイル名・
// インストール先・更新のキャッシュ名・userData が違う（lib.mjs の ZD。名前の上の重なりは assertIsolated が確かめる）。
//   node scripts/zero-downtime/stage1-7/build-installers.mjs [--work temporary/zd17] [--variants A,B,C,D,E,F]
// 変種（どれも最初に本物のビルド（A）を作り、B 以降は A の win-unpacked を写して一部を書き換え、manifest を作り直して NSIS にする）:
//   A 0.10.2  今のコード（旧版）
//   B 0.10.3  A と同じコードで版だけ違う（新版。core のビルドのハッシュが変わるので切り替えが起きる）
//   C 0.10.4  core/server.mjs の頭で throw する（新しいサーバーが立たない版。前の版へ戻すことの確認）
//   D 0.10.5  データの形式番号（core/data-schema.mjs の DATA_SCHEMA）を 1 つ上げた版（自動で切り替えない確認）
//   E 0.10.6・F 0.10.7  A と同じコードで版だけ違う（B → E → F と更新を重ねて、実行場所の古い版の掃除を見る）
// 出力: <work>/<変種>/（installer・latest.yml・win-unpacked）。electron は env -u ELECTRON_RUN_AS_NODE で動かす必要は無い（electron-builder は node で動く）
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { assertIsolated, cleanEnv, repoRoot, ZD } from './lib.mjs';

const require = createRequire(import.meta.url);
const { buildManifest, MANIFEST_FILE } = require('../../../desktop/runtime-manifest.cjs');
const yaml = require('yaml');

const arg = (name, fallback) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : fallback; };
const work = path.resolve(repoRoot, arg('--work', 'temporary/zd17'));
const wanted = arg('--variants', 'A,B,C,D,E,F').split(',');
const VERSIONS = { A: '0.10.2', B: '0.10.3', C: '0.10.4', D: '0.10.5', E: '0.10.6', F: '0.10.7' };
assertIsolated();

const cli = path.join(repoRoot, 'node_modules', 'electron-builder', 'cli.js');
function builder(args) {
  const r = spawnSync(process.execPath, [cli, ...args], { cwd: repoRoot, stdio: 'inherit', env: cleanEnv({ CSC_IDENTITY_AUTO_DISCOVERY: 'false' }) });
  if (r.status !== 0) throw new Error(`electron-builder ${args.join(' ')} failed (${r.status})`);
}

const base = yaml.parse(fs.readFileSync(path.join(repoRoot, 'electron-builder.yml'), 'utf8'));
const config = {
  ...base,
  appId: ZD.appId, productName: ZD.productName, artifactName: `${ZD.productName}-\${version}.\${ext}`,
  afterPack: path.join(repoRoot, 'scripts', 'after-pack.cjs'),
  compression: 'store',
  files: [...base.files, 'scripts/zero-downtime/stage1-7/entry.cjs'],
  win: { ...base.win, icon: path.join(repoRoot, 'desktop', 'icon.ico'), executableName: ZD.productName, target: [{ target: 'nsis', arch: ['x64'] }] },
  nsis: { ...base.nsis, include: path.join(repoRoot, 'build', 'installer.nsh') },
  publish: { provider: 'generic', url: `http://127.0.0.1:${ZD.feedPort}/`, updaterCacheDirName: ZD.updaterCache },
};
const extraMetadata = version => ({ name: ZD.packageName, version, main: 'scripts/zero-downtime/stage1-7/entry.cjs', plyRelease: true });
const writeConfig = (file, version) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify({ ...config, extraMetadata: extraMetadata(version) }, null, 2)); return file; };

const dirOf = variant => path.join(work, variant);
const unpacked = variant => path.join(dirOf(variant), 'win-unpacked');
const appOf = variant => path.join(unpacked(variant), 'resources', 'app');

async function rebuildManifest(variant) {
  const app = appOf(variant);
  const version = JSON.parse(fs.readFileSync(path.join(app, 'package.json'), 'utf8')).version;
  fs.rmSync(path.join(app, MANIFEST_FILE), { force: true });
  const manifest = await buildManifest(app, { appVersion: version });
  fs.writeFileSync(path.join(app, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest.buildHash.slice(0, 12);
}

function patchVariant(variant) {
  const app = appOf(variant);
  const pkgFile = path.join(app, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
  pkg.version = VERSIONS[variant];
  fs.writeFileSync(pkgFile, `${JSON.stringify(pkg, null, 2)}\n`);
  if (variant === 'C') {
    const file = path.join(app, 'core', 'server.mjs');
    fs.writeFileSync(file, `throw new Error('zdtest: this build is made to fail at startup');\n${fs.readFileSync(file, 'utf8')}`);
  }
  if (variant === 'D') {
    const file = path.join(app, 'core', 'data-schema.mjs');
    const text = fs.readFileSync(file, 'utf8');
    if (!/export const DATA_SCHEMA = 2;/.test(text)) throw new Error('DATA_SCHEMA line not found');
    fs.writeFileSync(file, text.replace('export const DATA_SCHEMA = 2;', 'export const DATA_SCHEMA = 3;'));
  }
}

const summary = {};
if (wanted.includes('A') || !fs.existsSync(unpacked('A'))) {
  const configFile = writeConfig(path.join(work, 'builder-A.json'), VERSIONS.A);
  builder(['--config', configFile, '--win', 'nsis', '--x64', '--publish', 'never', `-c.directories.output=${dirOf('A')}`]);
}
summary.A = { version: VERSIONS.A, build: JSON.parse(fs.readFileSync(path.join(appOf('A'), MANIFEST_FILE), 'utf8')).buildHash.slice(0, 12) };

for (const variant of wanted.filter(v => v !== 'A')) {
  fs.rmSync(dirOf(variant), { recursive: true, force: true });
  fs.mkdirSync(dirOf(variant), { recursive: true });
  fs.cpSync(unpacked('A'), unpacked(variant), { recursive: true });
  patchVariant(variant);
  summary[variant] = { version: VERSIONS[variant], build: await rebuildManifest(variant) };
  const configFile = writeConfig(path.join(work, `builder-${variant}.json`), VERSIONS[variant]);
  builder(['--config', configFile, '--prepackaged', unpacked(variant), '--win', 'nsis', '--x64', '--publish', 'never', `-c.directories.output=${dirOf(variant)}`]);
}
for (const variant of Object.keys(summary)) summary[variant].files = fs.readdirSync(dirOf(variant)).filter(f => /\.(exe|yml|blockmap)$/.test(f));
console.log(JSON.stringify({ work, summary }, null, 2));
