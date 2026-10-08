// Microsoft Store の MSIX のパッケージとして動くときの違い（docs/microsoft-store.md）。Electron に依らないのでテストから読める
const path = require('node:path');

/**
 * パッケージの識別子付きで動いているか。Electron は識別子（GetCurrentPackageFullName）で process.windowsStore を立てる。
 * スタートメニュー・App Execution Alias からの起動は true、パッケージの中の実行ファイルを直に起動したときは false
 */
function packagedIdentity(proc = process) { return proc.platform === 'win32' && proc.windowsStore === true; }

/**
 * 版に依らない Ply.exe の起動口。パッケージの中の実行ファイル（process.execPath）は版ごとのフォルダーにあり、
 * 直に起動すると識別子が付かない（userData が別の場所になる）。Store 版では App Execution Alias（build/appx-manifest.xml の Ply.exe）を返す
 */
function stableLauncher({ proc = process, env = process.env,
  store = require('./updates.cjs').isStoreBuild({ pkg: require('../package.json'), windowsStore: proc.windowsStore }) } = {}) {
  if (!store) return proc.execPath;
  return env.LOCALAPPDATA ? path.win32.join(env.LOCALAPPDATA, 'Microsoft', 'WindowsApps', 'Ply.exe') : 'Ply.exe';
}

module.exports = { packagedIdentity, stableLauncher };
