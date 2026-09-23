import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
const pkg = JSON.parse(await fs.readFile('package.json', 'utf8'));
if (process.env.RELEASE_TAG !== `v${pkg.version}` || !/^\d+\.\d+\.\d+(?:-beta\.\d+)?$/.test(pkg.version)) throw new Error('Tag must match package version');
createRequire(import.meta.url)('../electron-builder.release.cjs');
// node-pty は optionalDependencies（Linux の CI でビルドに失敗しても npm ci を止めないため）。
// 配布物には必ず入れる（Claude のアカウントの認可が疑似端末を使う。core/claude-login.mjs）。win / mac は prebuild を使う
const pty = createRequire(import.meta.url)('node-pty');
for (const arch of process.platform === 'win32' ? ['x64', 'arm64'] : process.platform === 'darwin' ? ['x64', 'arm64'] : []) {
  await fs.access(new URL(`../node_modules/node-pty/prebuilds/${process.platform}-${arch}/pty.node`, import.meta.url));
}
if (typeof pty.spawn !== 'function') throw new Error('node-pty を読み込めません');
