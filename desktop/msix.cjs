// Microsoft Store の MSIX のパッケージとして動くときの違い（docs/microsoft-store.md）。Electron に依らないのでテストから読める
const fs = require('node:fs');
const path = require('node:path');

/**
 * パッケージの識別子付きで動いているか。Electron は識別子（GetCurrentPackageFullName）で process.windowsStore を立てる。
 * スタートメニュー・App Execution Alias からの起動は true、パッケージの中の実行ファイルを直に起動したときは false
 */
function packagedIdentity(proc = process) { return proc.platform === 'win32' && proc.windowsStore === true; }

/**
 * 版に依らない Ply.exe の起動口。パッケージの中の実行ファイル（process.execPath）は版ごとのフォルダーにあり、
 * 直に起動すると識別子が付かない（userData が別の場所になる）。App Execution Alias（build/appx-manifest.xml の Ply.exe）があればそれを返す
 */
function stableLauncher({ proc = process, env = process.env, exists = fs.existsSync } = {}) {
  if (!packagedIdentity(proc) || !env.LOCALAPPDATA) return proc.execPath;
  const alias = path.win32.join(env.LOCALAPPDATA, 'Microsoft', 'WindowsApps', 'Ply.exe');
  return exists(alias) ? alias : proc.execPath;
}

module.exports = { packagedIdentity, stableLauncher };
