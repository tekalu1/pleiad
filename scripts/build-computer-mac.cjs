// macOS のパッケージを作る前に、同梱する Swift ヘルパーを両 CPU 向けに作る（ADR 0173）。
// Windows のパッケージでは Swift を呼ばない。開発時はこのファイルを node で直接実行する。
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

function build({ root = path.resolve(__dirname, '..'), run = execFileSync } = {}) {
  const cwd = path.join(root, 'desktop', 'computer', 'mac');
  const options = { cwd, stdio: 'inherit' };
  run('swift', ['build', '-c', 'release', '--arch', 'arm64', '--arch', 'x86_64'], options);
  const bin = run('swift', ['build', '-c', 'release', '--arch', 'arm64', '--arch', 'x86_64', '--show-bin-path'], { cwd, encoding: 'utf8' }).trim();
  const source = path.join(bin, 'pleiad-computer-helper');
  run('lipo', ['-verify_arch', 'x86_64', 'arm64', source], options);
  const dist = path.join(cwd, 'dist');
  fs.mkdirSync(dist, { recursive: true });
  fs.copyFileSync(source, path.join(dist, 'pleiad-computer-helper'));
  fs.chmodSync(path.join(dist, 'pleiad-computer-helper'), 0o755);
}

let built = false;
module.exports = async context => {
  if (context.electronPlatformName !== 'darwin' || built) return;
  build({ root: context.packager.projectDir });
  built = true;
};
module.exports.build = build;
if (require.main === module) build();
