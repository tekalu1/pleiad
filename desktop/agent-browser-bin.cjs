const fs = require('node:fs');
const path = require('node:path');

function binaryName(platform = process.platform, arch = process.arch) {
  const target = platform === 'win32' && arch === 'arm64' ? 'x64' : arch;
  return `agent-browser-${platform}-${target}${platform === 'win32' ? '.exe' : ''}`;
}
function commandName(platform = process.platform) { return `agent-browser${platform === 'win32' ? '.exe' : ''}`; }
function prepareAgentBrowserBin({ packaged, resourcesPath, root, dataDir } = {}) {
  if (packaged) return path.join(resourcesPath, 'agent-browser');
  const source = path.join(root, 'node_modules', 'agent-browser', 'bin', binaryName());
  const dir = path.join(dataDir, 'agent-browser-bin');
  fs.mkdirSync(dir, { recursive: true });
  const destination = path.join(dir, commandName());
  if (!fs.existsSync(destination) || fs.statSync(destination).size !== fs.statSync(source).size) fs.copyFileSync(source, destination);
  if (process.platform !== 'win32') fs.chmodSync(destination, 0o755);
  return dir;
}
module.exports = { binaryName, commandName, prepareAgentBrowserBin };
