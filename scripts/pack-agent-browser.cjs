const fs = require('node:fs/promises');
const path = require('node:path');

module.exports = async function packAgentBrowser(context) {
  const platform = context.electronPlatformName;
  const arch = context.arch === 3 ? 'arm64' : 'x64';
  const target = platform === 'win32' && arch === 'arm64' ? 'x64' : arch;
  const ext = platform === 'win32' ? '.exe' : '';
  const source = path.join(__dirname, '..', 'node_modules', 'agent-browser', 'bin', `agent-browser-${platform}-${target}${ext}`);
  const resources = platform === 'darwin' ? path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Resources') : path.join(context.appOutDir, 'resources');
  const dir = path.join(resources, 'agent-browser');
  await fs.mkdir(dir, { recursive: true });
  const destination = path.join(dir, `agent-browser${ext}`);
  await fs.copyFile(source, destination);
  if (platform !== 'win32') await fs.chmod(destination, 0o755);
};
