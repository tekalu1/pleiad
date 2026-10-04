const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { parse } = require('yaml');

const runFile = promisify(execFile);

// 配布先は public なので、トークンが無くても更新は取れる（認証なしは 1 IP で 1 時間 60 回まで）。
// トークンがあればレート制限を避けるために使う。取れなければ null を返す。
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
  return null;
}

// electron-updater は /releases の先頭のプレリリースをそのまま最新とみなす。GitHub はこの一覧を
// タグ名の文字列順で返すため v0.1.0-beta.9 が beta.11 より前に来て、beta.10 以降が見えなくなる。
// プレリリースも含めて探すときは、版番号を semver で比べて一番新しいものを選ぶ。
function newestReleaseProvider() {
  const updaterDir = path.dirname(require.resolve('electron-updater/package.json'));
  const semver = require(require.resolve('semver', { paths: [updaterDir] }));
  const { PrivateGitHubProvider } = require('electron-updater/out/providers/PrivateGitHubProvider');
  return class NewestReleaseProvider extends PrivateGitHubProvider {
    constructor(options, updater, runtimeOptions) { super(options, updater, options.token || null, runtimeOptions); }
    // トークンが無いときは authorization を付けない（`token undefined` を送ると 401 になる）。
    configureHeaders(accept) {
      return this.token ? super.configureHeaders(accept) : { accept };
    }
    // インストーラーと blockmap は API の資産の URL（/releases/assets/<番号>）ではなく、公開の配布の URL
    // （/releases/download/v<版>/<名前>）から取る。資産の URL は名前を含まないので、electron-updater が
    // CPU に合う Pleiad-<版>-win-x64.exe を選べず一覧の先頭の両方入り（2 倍の大きさ）を取り、blockmap の URL も
    // 作れずに差分の取得が毎回失敗して全体を取っていた（0.8.0）。配布の URL は API の回数の上限にも数えられない
    resolveFiles(updateInfo) {
      const files = super.resolveFiles(updateInfo).map(file => {
        const name = path.posix.basename(file.info.url).replace(/ /g, '-');
        const asset = updateInfo.assets.find(it => it?.name === name);
        return asset?.browser_download_url ? { ...file, url: new URL(asset.browser_download_url) } : file;
      });
      this.fileSizes = new Map(files.map(file => [file.url.href, file.info.size]));
      return files;
    }
    // 差分の元は、前回の更新で取って手元に残したインストーラー（installer.exe）。0.8.0 までの版は両方入りを取っていたので、
    // それが残っていれば、前の版の blockmap も両方入りのものを使う（中の x64 の部分がそのまま使え、取る量は変わらない）。
    // 違う blockmap と組むと、組み上げた後の検査で落ちて全体を取り直す
    async getBlockMapFiles(baseUrl, oldVersion, newVersion, oldBlockMapFileBaseUrl = null) {
      const [oldUrl, newUrl] = await super.getBlockMapFiles(baseUrl, oldVersion, newVersion, oldBlockMapFileBaseUrl);
      const archName = `-${process.arch}.exe.blockmap`;
      const cacheDir = this.updater.downloadedUpdateHelper?.cacheDir;
      if (!oldUrl.pathname.endsWith(archName) || !cacheDir) return [oldUrl, newUrl];
      // 両方入りは片方だけの約 2 倍の大きさなので、新しいインストーラーとの大きさの比で見分ける
      const newSize = this.fileSizes?.get(baseUrl.href);
      const cachedSize = await fs.stat(path.join(cacheDir, 'installer.exe')).then(s => s.size, () => 0);
      if (!newSize || cachedSize < newSize * 1.5) return [oldUrl, newUrl];
      const combined = new URL(oldUrl);
      combined.pathname = oldUrl.pathname.slice(0, -archName.length) + '.exe.blockmap';
      return [combined, newUrl];
    }
    // 配布先は public なので、取るときにトークンは送らない
    get fileExtraDownloadHeaders() {
      return { accept: 'application/octet-stream' };
    }
    // GitHub の配信は複数の範囲をまとめた要求に 501 を返す。差分は範囲を 1 つずつ取る（標準の GitHubProvider と同じ）
    get isUseMultipleRangeRequest() {
      return false;
    }
    async getLatestVersionInfo(cancellationToken) {
      const json = 'application/vnd.github.v3+json';
      // 標準の実装は失敗を包み直して HTTP の状態コードを落とすので、状態コードでエラー文を分けられるよう自前で取る
      if (!this.updater.allowPrerelease) {
        const url = new URL(`${this.basePath}/latest`, this.baseUrl);
        return JSON.parse(await this.httpRequest(url, this.configureHeaders(json), cancellationToken));
      }
      const url = new URL(`${this.basePath}?per_page=100`, this.baseUrl);
      const list = JSON.parse(await this.httpRequest(url, this.configureHeaders(json), cancellationToken));
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
  // 呼び出し側がエラー文を分けるための印。トークンそのものは返さない。
  return { authenticated: Boolean(token) };
}

module.exports = { resolveGitHubToken, prepareUpdateCheck, newestRelease };
