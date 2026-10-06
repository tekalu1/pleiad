// electron-builder の afterPack（scripts/after-pack.cjs から、pack-agent-browser.cjs の後に呼ばれる）。
// 無停止の更新の「版ごとの実行場所」（docs/zero-downtime-update/design.md §3、ADR 0151）の材料を配布物に入れる:
//   - resources\runtime\node.exe        公式の Node（scripts/node-runtime.json の版・SHA-256 で固定。実行場所では pleiad-node.exe の名前で使う）
//   - resources\runtime\runtime.json    その Node と agent-browser の SHA-256・大きさ（main が実行場所へ写すときに突き合わせる）
//   - resources\app\manifest.json       resources\app のファイルごとの SHA-256・大きさ（desktop/runtime-manifest.cjs）
// Windows だけ。manifest は resources\app が出来上がった後（署名・Electron の fuse は resources\app のファイルを変えない）に作る。
// manifest は「インストールした後の木」と一致していなければならないので、動かさない OS・CPU の node-pty の prebuild は先に外す（pruneOtherPrebuilds）。
const fs = require('node:fs');
const fsp = fs.promises;
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { pipeline } = require('node:stream/promises');
const { Readable } = require('node:stream');
const { buildManifest, MANIFEST_FILE } = require('../desktop/runtime-manifest.cjs');

const RUNTIME_SCHEMA = 1;
const CONFIG = path.join(__dirname, 'node-runtime.json');

/** ファイルの SHA-256 と大きさ（ストリームで読む。Node の exe は 90 MB 台） */
async function hashFile(file) {
  const hash = crypto.createHash('sha256');
  let size = 0;
  for await (const chunk of fs.createReadStream(file)) { hash.update(chunk); size += chunk.length; }
  return { sha256: hash.digest('hex'), size };
}

/** 取得元の既定: fetch で file へ書く（リダイレクトは fetch が追う） */
async function downloadTo(url, file) {
  const response = await fetch(url);
  if (!response.ok || !response.body) throw new Error(`download failed: ${url} (HTTP ${response.status})`);
  await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(file));
}

/** 取得済みのファイルを置くキャッシュ（リリースの CI は actions/cache で PLEIAD_NODE_CACHE を引き継ぐ） */
const defaultCacheDir = () => process.env.PLEIAD_NODE_CACHE || path.join(os.homedir(), '.cache', 'pleiad', 'node-runtime');

/**
 * 公式の Node の exe を用意して、その場所を返す。キャッシュにあって SHA-256 が合えばそれを使い、無い・合わなければ取り直す。
 * 取ったものが固定の SHA-256 と合わなければ、置かずに失敗する（配布物に未確認の実行ファイルを入れない）
 */
async function ensureNodeExe(entry, { version, arch, cacheDir = defaultCacheDir(), download = downloadTo } = {}) {
  const file = path.join(cacheDir, `node-v${version}-win-${arch}.exe`);
  const check = async target => { try { const got = await hashFile(target); return got.sha256 === entry.sha256 && got.size === entry.size; } catch { return false; } };
  if (await check(file)) return file;
  await fsp.mkdir(cacheDir, { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    await download(entry.url, tmp);
    if (!await check(tmp)) {
      const got = await hashFile(tmp).catch(() => ({ sha256: '(unreadable)', size: -1 }));
      throw new Error(`Node ${version} (${arch}) does not match scripts/node-runtime.json: sha256 ${got.sha256} (expected ${entry.sha256}), size ${got.size} (expected ${entry.size})`);
    }
    await fsp.rename(tmp, file);
  } finally { await fsp.rm(tmp, { force: true }); }
  return file;
}

/**
 * node-pty の prebuilds は全 OS・CPU の分が入る。NSIS のインストーラーは、別 CPU（x64 の配布物の中の win32-arm64）の .exe・.dll を
 * 新しい 7-Zip の ARM64 フィルターで固め、インストーラーの古い展開器がそれを読めずに黙って落とす（インストール版にだけ無い。2026-10-06 の実機の確認で、
 * manifest と合わず実行場所を組めなかった）。この配布物で動かす win32-<arch> 以外の分は、動かさないので外す
 */
async function pruneOtherPrebuilds(appDir, arch) {
  const dir = path.join(appDir, 'node_modules', 'node-pty', 'prebuilds');
  let names;
  try { names = await fsp.readdir(dir); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const removed = names.filter(name => name !== `win32-${arch}`).sort();
  for (const name of removed) await fsp.rm(path.join(dir, name), { recursive: true, force: true });
  return removed;
}

/** resources\runtime と resources\app\manifest.json を作る。context は electron-builder の afterPack の引数（appOutDir・arch・electronPlatformName） */
async function packRuntime(context, { config = JSON.parse(fs.readFileSync(CONFIG, 'utf8')), ...options } = {}) {
  if (context.electronPlatformName !== 'win32') return null;
  const arch = context.arch === 3 ? 'arm64' : 'x64';
  const entry = config.win32?.[arch];
  if (!entry) throw new Error(`scripts/node-runtime.json has no entry for win32 ${arch}`);
  const resources = path.join(context.appOutDir, 'resources');
  const appDir = path.join(resources, 'app');
  const runtimeDir = path.join(resources, 'runtime');
  const nodeExe = await ensureNodeExe(entry, { version: config.version, arch, ...options });
  await fsp.mkdir(runtimeDir, { recursive: true });
  await fsp.copyFile(nodeExe, path.join(runtimeDir, 'node.exe'));
  const runtime = { schema: RUNTIME_SCHEMA, node: { version: config.version, arch, file: 'node.exe', size: entry.size, sha256: entry.sha256 } };
  // agent-browser は pack-agent-browser.cjs が resources\agent-browser に置く。実行場所にもハードリンクで置くので、中身の SHA-256 を控える
  const agentBrowser = path.join(resources, 'agent-browser', 'agent-browser.exe');
  if (fs.existsSync(agentBrowser)) runtime.agentBrowser = { dir: 'agent-browser', file: 'agent-browser.exe', ...await hashFile(agentBrowser) };
  await fsp.writeFile(path.join(runtimeDir, 'runtime.json'), `${JSON.stringify(runtime, null, 2)}\n`);
  const appVersion = JSON.parse(await fsp.readFile(path.join(appDir, 'package.json'), 'utf8')).version;
  const pruned = await pruneOtherPrebuilds(appDir, arch);
  const manifest = await buildManifest(appDir, { appVersion });
  await fsp.writeFile(path.join(appDir, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`);
  return { runtime, pruned, manifest: { appVersion, buildHash: manifest.buildHash, files: Object.keys(manifest.files).length } };
}

module.exports = packRuntime;
module.exports.packRuntime = packRuntime;
module.exports.ensureNodeExe = ensureNodeExe;
module.exports.pruneOtherPrebuilds = pruneOtherPrebuilds;
module.exports.hashFile = hashFile;
module.exports.RUNTIME_SCHEMA = RUNTIME_SCHEMA;
