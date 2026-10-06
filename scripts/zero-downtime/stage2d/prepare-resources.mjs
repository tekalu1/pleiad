// A = desktop:pack の resources を写したもの。B = A に app の 1 ファイルを足したもの。C = A の app/core/server.mjs の頭に throw を足したもの。
// どれも manifest.json を作り直す（版は同じ・ビルドのハッシュが変わる）。パッケージ版でない入口（electron で起こす）が app の node_modules の
// agent-browser の exe を探すので、pack が resources\agent-browser へ移した exe を写す
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const { buildManifest, MANIFEST_FILE } = require(path.join(ROOT, 'desktop', 'runtime-manifest.cjs'));
const A = path.join(ROOT, 'dist-desktop', 'win-unpacked', 'resources');
const OUT = path.join(ROOT, 'temporary', 'harness-res');
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
const appVersion = JSON.parse(fs.readFileSync(path.join(A, 'app', 'package.json'), 'utf8')).version;
for (const name of ['A', 'B', 'C']) {
  const dir = path.join(OUT, name);
  fs.cpSync(A, dir, { recursive: true });
  const binDir = path.join(dir, 'app', 'node_modules', 'agent-browser', 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  fs.copyFileSync(path.join(A, 'agent-browser', 'agent-browser.exe'), path.join(binDir, 'agent-browser-win32-x64.exe'));
  if (name === 'B') fs.writeFileSync(path.join(dir, 'app', 'harness-b.txt'), 'version B\n');
  if (name === 'C') {
    const file = path.join(dir, 'app', 'core', 'server.mjs');
    fs.writeFileSync(file, `throw new Error('harness: this version cannot start');\n${fs.readFileSync(file, 'utf8')}`);
  }
  const manifest = await buildManifest(path.join(dir, 'app'), { appVersion });
  fs.writeFileSync(path.join(dir, 'app', MANIFEST_FILE), `${JSON.stringify(manifest)}\n`);
  console.log(name, 'built', manifest.buildHash?.slice(0, 12));
}
