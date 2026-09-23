const fs = require('node:fs');
const { parse } = require('yaml');
const config = parse(fs.readFileSync(require('node:path').join(__dirname, 'electron-builder.yml'), 'utf8'));
// 配布版に焼き込む更新フィード（利用者のアプリが見に行く Releases）。アップロード先（GH_REPO）とは分ける。
// GITHUB_REPOSITORY からは導かない。旧リポジトリの Actions で作った版も既定のフィードを見に行くようにするため。
const repository = process.env.PLY_RELEASE_REPOSITORY || 'tekalu1/pleiad';
if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository || '')) throw new Error('PLY_RELEASE_REPOSITORY must be owner/repo');
const [owner, repo] = repository.split('/');
const signing = require('./scripts/release-signing.cjs').releaseSigning();
if (signing.win) config.win = { ...config.win, ...signing.win };
if (signing.mac) config.mac = { ...config.mac, ...signing.mac };
module.exports = { ...config, forceCodeSigning: true, extraMetadata: { plyRelease: true },
  // PrivateGitHubProvider reads latest*.yml even for prereleases. The GitHub
  // release's prerelease flag controls who receives the beta, not the filename.
  publish: [{ provider: 'github', owner, repo, private: true, channel: 'latest', releaseType: 'draft' }],
  generateUpdatesFilesForAllChannels: false,
};
