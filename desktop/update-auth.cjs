const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { parse } = require('yaml');

const AUTH_MESSAGE = '更新の確認に GitHub の認証が必要です。GitHub CLI で gh auth login --hostname github.com を実行してから再試行してください。';
const runFile = promisify(execFile);

async function resolveGitHubToken({ env = process.env, run = runFile, platform = process.platform } = {}) {
  // Credentials stay in Electron main memory: never save them in update
  // preferences, the renderer, package metadata, or the server environment.
  const existing = env.GH_TOKEN || env.GITHUB_TOKEN;
  if (existing?.trim()) return existing.trim();
  const commands = ['gh'];
  if (platform === 'win32') {
    if (env.ProgramFiles) commands.push(path.join(env.ProgramFiles, 'GitHub CLI', 'gh.exe'));
    if (env.LOCALAPPDATA) commands.push(path.join(env.LOCALAPPDATA, 'Programs', 'GitHub CLI', 'gh.exe'));
  }
  for (const command of commands) {
    try {
      const { stdout } = await run(command, ['auth', 'token', '--hostname', 'github.com'], {
        encoding: 'utf8', timeout: 10000, maxBuffer: 16384, windowsHide: true, env,
      });
      if (stdout.trim()) return stdout.trim();
    } catch { /* CLI errors can contain credentials; never forward them. */ }
  }
  const error = new Error(AUTH_MESSAGE);
  error.code = 'PLY_UPDATE_AUTH';
  throw error;
}

// electron-updater は /releases の先頭のプレリリースをそのまま最新とみなす。GitHub はこの一覧を
// タグ名の文字列順で返すため v0.1.0-beta.9 が beta.11 より前に来て、beta.10 以降が見えなくなる。
// プレリリースも含めて探すときは、版番号を semver で比べて一番新しいものを選ぶ。
function newestReleaseProvider() {
  const updaterDir = path.dirname(require.resolve('electron-updater/package.json'));
  const semver = require(require.resolve('semver', { paths: [updaterDir] }));
  const { PrivateGitHubProvider } = require('electron-updater/out/providers/PrivateGitHubProvider');
  return class NewestReleaseProvider extends PrivateGitHubProvider {
    constructor(options, updater, runtimeOptions) { super(options, updater, options.token, runtimeOptions); }
    async getLatestVersionInfo(cancellationToken) {
      if (!this.updater.allowPrerelease) return super.getLatestVersionInfo(cancellationToken);
      const url = new URL(`${this.basePath}?per_page=100`, this.baseUrl);
      const list = JSON.parse(await this.httpRequest(url, this.configureHeaders('application/vnd.github.v3+json'), cancellationToken));
      return newestRelease(list, semver);
    }
  };
}

function newestRelease(list, semver) {
  const version = release => semver.valid(String(release.tag_name ?? '').replace(/^v/, ''));
  const newest = list.filter(release => !release.draft && version(release))
    .sort((a, b) => semver.rcompare(version(a), version(b)))[0];
  if (newest) return newest;
  const error = new Error('No release found');
  error.code = 'ERR_UPDATER_LATEST_VERSION_NOT_FOUND';
  throw error;
}

async function prepareUpdateCheck(updater, configFile, authOptions) {
  const config = parse(await fs.readFile(configFile, 'utf8'));
  if (config.provider !== 'github' || config.private !== true) return;
  // Only the GitHub host for which we resolve authentication may receive it.
  if (config.host && config.host !== 'github.com') throw new Error('Unsupported private update host');
  const token = await resolveGitHubToken(authOptions);
  updater.setFeedURL({ ...config, token, provider: 'custom', updateProvider: newestReleaseProvider() });
}

module.exports = { AUTH_MESSAGE, resolveGitHubToken, prepareUpdateCheck, newestRelease };
