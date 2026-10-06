// 版ごとの実行場所（無停止の更新。docs/zero-downtime-update/design.md §3、plan.md 1-3、ADR 0137）。
//
// 更新（NSIS）は $INSTDIR のプロセスだけを止める。サーバーを $INSTDIR の外の実行場所で走らせれば、main の入れ替えを越えて生き残れる。
// この部品は、配布物（resources\app・resources\runtime・resources\agent-browser）から実行場所を組み、使われていない古い版を掃除する。
//   <root>\node\<Node の版>-<sha256 の先頭>\pleiad-node.exe     公式の Node。名前を Ply.exe にしない（NSIS は名前でも止める）
//   <root>\store\<sha256>                                       中身のハッシュで 1 つずつ置く実体
//   <root>\app\<アプリの版>-<ビルドの短いハッシュ>\               store へのハードリンクで組んだ resources\app の写し
//   <root>\agent-browser\<同じ版の名前>\agent-browser.exe        PATH に足す置き場
//   <root>\run\<版の名前>-<pid>.lock.db                          使用中の印（core/runtime-use.mjs）
// 置き場は %LOCALAPPDATA% の下で、$INSTDIR と同じ文字列で始まらない場所（NSIS は Path.StartsWith($INSTDIR) で止めるプロセスを選ぶ）。
// 組むときは、ハッシュと写しを同じ読みで 16 並列に行う（書いたばかりのファイルの最初の読みは Defender で遅いので、二重に払わない）。
// Node の組み込みだけ（main と、ビルド・試験が読む）。
const fs = require('node:fs');
const fsp = fs.promises;
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { pipeline } = require('node:stream/promises');
const { Transform } = require('node:stream');
const { readManifest, shortBuildHash, sha256 } = require('./runtime-manifest.cjs');

const RUNTIME_DIR_NAME = 'agent-host-runtime';
/** $INSTDIR と前方一致してしまうときに移す先（%LOCALAPPDATA% の下。userData と同じ appId の名前） */
const FALLBACK_DIR = path.join('jp.ply.desktop', 'runtime');
const CONCURRENCY = 16;
/** 残す版の数: 今の版・戻し先の直前の版・さらにもう 1 版（使っているシェルの PATH にある bin\ のため。bin\pleiad.mjs は core\ と node_modules を読むので、木ごと残す。ハードリンクなので増えるのは変わった分だけ） */
const KEEP_TREES = 3;
/** 途中の一時ファイル・組み立て中の木が、これより古ければ止まった組み立ての残りとして消す */
const STALE_MS = 10 * 60 * 1000;
const MARKER_FILE = '.runtime.json';
const NODE_POINTER_FILE = 'runtime-node.txt';
const RUNTIME_JSON = 'runtime.json';
const nodeExeName = (platform = process.platform) => (platform === 'win32' ? 'pleiad-node.exe' : 'pleiad-node');

class RuntimeError extends Error {
  constructor(code, message, extra = {}) { super(message); this.name = 'RuntimeError'; this.code = code; Object.assign(this, extra); }
}

// ---- 置き場の決め方

const lowerOn = win => value => (win ? value.toLowerCase() : value);
/** 存在する一番深い祖先を realpath にして、残りをつなぐ（junction・シンボリックリンク・大文字小文字の違いを、NSIS が見る実体のパスに寄せる） */
function realish(target) {
  let current = path.resolve(target);
  const rest = [];
  for (;;) {
    try { return path.join(fs.realpathSync.native(current), ...rest.reverse()); } catch { /* 無ければ 1 つ上へ */ }
    const parent = path.dirname(current);
    if (parent === current) return path.resolve(target);
    rest.push(path.basename(current));
    current = parent;
  }
}

/** root（の下のプロセス）が $INSTDIR の更新で止められる場所か: root のパスが installDir と同じ文字列で始まる（大文字小文字を区別しない。\ の境目でなくても当たる） */
function collidesWithInstall(root, installDir, { win = process.platform === 'win32' } = {}) {
  if (!installDir) return false;
  const lower = lowerOn(win);
  const base = lower(realish(installDir)).replace(/[\\/]+$/, '');
  return lower(realish(root)).startsWith(base) || lower(path.resolve(root)).startsWith(lower(path.resolve(installDir)).replace(/[\\/]+$/, ''));
}

/**
 * 実行場所の置き場。環境変数 AGENT_HOST_RUNTIME_DIR（テスト・ハーネス用）があればそれだけを候補にし、
 * 無ければ %LOCALAPPDATA%\agent-host-runtime、$INSTDIR と前方一致するなら %LOCALAPPDATA%\jp.ply.desktop\runtime。
 * どれも $INSTDIR と前方一致するなら、更新で止められない場所が無いので RuntimeError（code: 'runtime-root'）
 */
function resolveRuntimeRoot({ installDir, env = process.env, localAppData = env.LOCALAPPDATA, win = process.platform === 'win32' } = {}) {
  const candidates = env.AGENT_HOST_RUNTIME_DIR
    ? [path.resolve(env.AGENT_HOST_RUNTIME_DIR)]
    : localAppData ? [path.join(localAppData, RUNTIME_DIR_NAME), path.join(localAppData, FALLBACK_DIR)] : [];
  const usable = candidates.find(root => !collidesWithInstall(root, installDir, { win }));
  if (!usable) throw new RuntimeError('runtime-root', `no runtime location outside the install directory (${installDir ?? '?'}): ${candidates.join(', ') || 'LOCALAPPDATA is not set'}`);
  return { root: usable, moved: usable !== candidates[0], candidates };
}

function layout(root) {
  return { root, node: path.join(root, 'node'), store: path.join(root, 'store'), app: path.join(root, 'app'), agentBrowser: path.join(root, 'agent-browser'), run: path.join(root, 'run') };
}

/** 版ごとの置き場の名前: <アプリの版>-<ビルドの短いハッシュ> */
const versionKey = manifest => `${String(manifest.appVersion).replace(/[^\w.+-]/g, '_')}-${shortBuildHash(manifest.buildHash)}`;

// ---- ファイルの小さな部品

const rand = () => crypto.randomBytes(4).toString('hex');
const statOr = async target => { try { return await fsp.stat(target); } catch { return null; } };

/** items を limit 本ずつ処理する。1 つが失敗したら新しい分は始めず、動いている分が終わってから最初の失敗を投げる（失敗の後に書き込みが続かない） */
async function pool(items, limit, fn) {
  let next = 0;
  let failure = null;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (!failure) {
      const index = next++;
      if (index >= items.length) return;
      try { await fn(items[index], index); } catch (error) { failure ??= { error }; }
    }
  }));
  if (failure) throw failure.error;
}

const inside = (root, target) => { const rel = path.relative(path.resolve(root), path.resolve(target)); return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel); };

/**
 * root の中の dir を消す。先に同じ親の下の .trash-* へ名前を替え（使っているプロセスが居れば替えられないので、半分だけ消えた木が残らない）、
 * それから消す。消せなかった残りは次の掃除が拾う。名前を替えられた（または元から無い）なら true、使われていて替えられないなら false
 */
async function removeTree(root, dir) {
  if (!inside(root, dir)) throw new RuntimeError('outside-root', `refusing to remove outside the runtime location: ${dir}`);
  if (!await statOr(dir)) return true;
  const trash = path.join(path.dirname(dir), `.trash-${rand()}`);
  try { await fsp.rename(dir, trash); } catch { return false; }
  await fsp.rm(trash, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
  return true;
}

/** 組み立ての順を 1 本にする（組み立てと掃除が同じ root で重ならないように） */
const queues = new Map();
function serial(root, task) {
  const key = path.resolve(root);
  const run = (queues.get(key) ?? Promise.resolve()).catch(() => {}).then(task);
  queues.set(key, run);
  const clean = () => { if (queues.get(key) === run) queues.delete(key); };
  run.then(clean, clean);
  return run;
}

// ---- store・木の組み立て

/** store に <sha256> の実体があること。あれば読まない。無ければ元を 1 回だけ読み、ハッシュを確かめながら一時ファイルへ書いて置く。戻り値は新しく置いたか */
async function ensureStored(store, sha, size, source) {
  const dest = path.join(store, sha);
  const existing = await statOr(dest);
  if (existing?.isFile() && existing.size === size) return false;
  let data;
  try { data = await fsp.readFile(source); }
  catch (error) { throw new RuntimeError('source-missing', `cannot read ${source}: ${error.message}`, { file: source }); }
  if (data.length !== size || sha256(data) !== sha) throw new RuntimeError('source-mismatch', `${source} does not match the manifest`, { file: source });
  const tmp = path.join(store, `${sha}.${rand()}.tmp`);
  await fsp.writeFile(tmp, data);
  try { await fsp.rename(tmp, dest); }
  catch (error) {
    await fsp.rm(tmp, { force: true });
    const now = await statOr(dest);
    if (!(now?.isFile() && now.size === size)) throw error;   // 同時に別の組み立てが置いたのなら、それでよい
  }
  return true;
}

/** src を dest へ写しながら SHA-256 を取る（大きい 1 ファイル用。Node の exe）。合わなければ消して RuntimeError */
async function copyVerified(src, dest, { sha256: wantSha, size: wantSize }, code) {
  const hash = crypto.createHash('sha256');
  let size = 0;
  const tap = new Transform({ transform(chunk, _enc, done) { hash.update(chunk); size += chunk.length; done(null, chunk); } });
  try { await pipeline(fs.createReadStream(src), tap, fs.createWriteStream(dest)); }
  catch (error) { await fsp.rm(dest, { force: true }); throw new RuntimeError(`${code}-missing`, `cannot copy ${src}: ${error.message}`, { file: src }); }
  if (size !== wantSize || hash.digest('hex') !== wantSha) { await fsp.rm(dest, { force: true }); throw new RuntimeError(`${code}-mismatch`, `${src} does not match runtime.json`, { file: src }); }
}

/** store の実体へのハードリンクを張る。張れない（別のボリューム・ハードリンクの無いファイルシステム・リンク数の上限）なら写す。戻り値は写したか */
async function linkOrCopy(from, to, link) {
  try { await link(from, to); return false; }
  catch (error) {
    if (error.code === 'EEXIST') return false;
    await fsp.copyFile(from, to);
    return true;
  }
}

/**
 * dir が manifest のとおりか。全部のファイルが在って大きさが合う（deep なら中身の SHA-256 も読み直す）。
 * 戻り値 { ok, missing, sizeMismatch, hashMismatch }（それぞれ相対パスの配列。多いと切り詰める）
 */
async function verifyTree(dir, manifest, { deep = false, concurrency = CONCURRENCY } = {}) {
  const missing = [], sizeMismatch = [], hashMismatch = [];
  await pool(Object.keys(manifest.files), concurrency, async rel => {
    const want = manifest.files[rel];
    const file = path.join(dir, ...rel.split('/'));
    const st = await statOr(file);
    if (!st?.isFile()) { missing.push(rel); return; }
    if (st.size !== want.size) { sizeMismatch.push(rel); return; }
    if (deep) { try { if (sha256(await fsp.readFile(file)) !== want.sha256) hashMismatch.push(rel); } catch { missing.push(rel); } }
  });
  return { ok: !missing.length && !sizeMismatch.length && !hashMismatch.length, missing: missing.slice(0, 20), sizeMismatch: sizeMismatch.slice(0, 20), hashMismatch: hashMismatch.slice(0, 20) };
}

async function readMarker(dir) {
  try { return JSON.parse(await fsp.readFile(path.join(dir, MARKER_FILE), 'utf8')); } catch { return null; }
}

/** 組み終えた木か（印が在り、ビルドが同じで、中身が manifest のとおり） */
async function isCompleteTree(dir, manifest, options) {
  const marker = await readMarker(dir);
  if (marker?.buildHash !== manifest.buildHash || marker.state !== 'full') return false;
  return (await verifyTree(dir, manifest, options)).ok;
}

async function readRuntimeJson(runtimeSrc) {
  let parsed;
  try { parsed = JSON.parse(await fsp.readFile(path.join(runtimeSrc, RUNTIME_JSON), 'utf8')); }
  catch (error) { throw new RuntimeError('runtime-json-missing', `runtime.json is missing or broken: ${error.message}`); }
  const node = parsed?.node;
  if (parsed?.schema !== 1 || !node?.version || !node.file || !Number.isInteger(node.size) || !/^[0-9a-f]{64}$/.test(node.sha256 ?? '')) throw new RuntimeError('runtime-json-invalid', 'runtime.json is invalid');
  return parsed;
}

/** pleiad-node.exe を node\<版>-<sha256 の先頭>\ に 1 つ置く（Node の版ごとに 1 つ。版をまたいで共有）。戻り値 { dirName, exe, reused } */
async function ensureNode(paths, runtimeSrc, runtime) {
  const { node } = runtime;
  const dirName = `${node.version}-${node.sha256.slice(0, 12)}`;
  const dir = path.join(paths.node, dirName);
  const exe = path.join(dir, nodeExeName());
  const existing = await statOr(exe);
  if (existing?.isFile() && existing.size === node.size) return { dirName, dir, exe, reused: true };
  await fsp.mkdir(paths.node, { recursive: true });
  const tmpDir = path.join(paths.node, `.${dirName}.${rand()}.tmp`);
  await fsp.mkdir(tmpDir);
  try {
    await copyVerified(path.join(runtimeSrc, node.file), path.join(tmpDir, nodeExeName()), node, 'node');
    if (!await removeTree(paths.root, dir)) throw new RuntimeError('node-busy', `${dir} is in use and does not match runtime.json`);
    await fsp.rename(tmpDir, dir);
  } finally { await removeTree(paths.root, tmpDir); }
  return { dirName, dir, exe, reused: false };
}

/** agent-browser を agent-browser\<key>\ に置く（store の実体へのハードリンク）。runtime.json に無ければ何もしない */
async function ensureAgentBrowser(paths, resourcesDir, runtime, key, link) {
  const spec = runtime.agentBrowser;
  if (!spec) return null;
  const source = path.join(resourcesDir, spec.dir, spec.file);
  await ensureStored(paths.store, spec.sha256, spec.size, source);
  const dir = path.join(paths.agentBrowser, key);
  const target = path.join(dir, spec.file);
  const existing = await statOr(target);
  if (existing?.isFile() && existing.size === spec.size) return dir;
  await removeTree(paths.root, dir);
  await fsp.mkdir(dir, { recursive: true });
  await linkOrCopy(path.join(paths.store, spec.sha256), target, link);
  return dir;
}

/**
 * 実行場所へ版を組む（無ければ。組んであって manifest と合えば何もしない）。
 *   root          置き場（resolveRuntimeRoot の root）
 *   resourcesDir  配布物の resources\（app\・runtime\・agent-browser\ がある）
 * 戻り値 { key, appDir, nodeExe, nodeDir, agentBrowserDir, reused, stats }。
 * 元が manifest と合わない・読めないときは RuntimeError（source-mismatch など）で、組みかけを残さない
 */
function install({ root, resourcesDir, concurrency = CONCURRENCY, link = fsp.link, now = () => Date.now() }) {
  return serial(root, async () => {
    const started = performance.now();
    const paths = layout(root);
    const appSrc = path.join(resourcesDir, 'app');
    const runtimeSrc = path.join(resourcesDir, 'runtime');
    const manifest = await readManifest(appSrc);
    const runtime = await readRuntimeJson(runtimeSrc);
    const key = versionKey(manifest);
    const finalDir = path.join(paths.app, key);
    const stats = { files: Object.keys(manifest.files).length, stored: 0, linked: 0, copied: 0 };
    await fsp.mkdir(paths.store, { recursive: true });
    await fsp.mkdir(paths.app, { recursive: true });
    const nodeInfo = await ensureNode(paths, runtimeSrc, runtime);
    const agentBrowserDir = await ensureAgentBrowser(paths, resourcesDir, runtime, key, link);
    const done = (reused) => ({ key, appDir: finalDir, nodeExe: nodeInfo.exe, nodeDir: nodeInfo.dir, agentBrowserDir, reused, stats: { ...stats, ms: Math.round(performance.now() - started) } });

    if (await isCompleteTree(finalDir, manifest, { concurrency })) return done(true);
    // 壊れている・途中で止まった写しは、新しく組む（使われていて消せないなら、触らずに失敗する）
    if (!await removeTree(root, finalDir)) throw new RuntimeError('tree-busy', `${finalDir} does not match the manifest and is in use`);

    const staging = path.join(paths.app, `.${key}.staging`);
    await removeTree(root, staging);
    await fsp.mkdir(staging, { recursive: true });
    try {
      // 1 つ目の読み: 中身ごとに 1 回だけ読み、ハッシュを確かめながら store へ置く
      const bySha = new Map();
      for (const rel of Object.keys(manifest.files)) if (!bySha.has(manifest.files[rel].sha256)) bySha.set(manifest.files[rel].sha256, rel);
      await pool([...bySha], concurrency, async ([sha, rel]) => {
        if (await ensureStored(paths.store, sha, manifest.files[rel].size, path.join(appSrc, ...rel.split('/')))) stats.stored++;
      });
      // 木: store の実体へのハードリンク
      const dirs = new Set(Object.keys(manifest.files).map(rel => path.dirname(path.join(staging, ...rel.split('/')))));
      for (const dir of dirs) await fsp.mkdir(dir, { recursive: true });
      await pool(Object.keys(manifest.files), concurrency, async rel => {
        const copied = await linkOrCopy(path.join(paths.store, manifest.files[rel].sha256), path.join(staging, ...rel.split('/')), link);
        if (copied) stats.copied++; else stats.linked++;
      });
      const check = await verifyTree(staging, manifest, { concurrency });
      if (!check.ok) throw new RuntimeError('tree-mismatch', `the runtime copy does not match the manifest: ${JSON.stringify(check)}`, { check });
      await fsp.writeFile(path.join(staging, NODE_POINTER_FILE), `${nodeInfo.dirName}\n`);
      await fsp.writeFile(path.join(staging, MARKER_FILE), JSON.stringify({ schema: 1, key, appVersion: manifest.appVersion, buildHash: manifest.buildHash, state: 'full', node: nodeInfo.dirName, completedAt: new Date(now()).toISOString() }));
      try { await fsp.rename(staging, finalDir); }
      catch (error) {
        // 同時に別の組み立てが済ませていたならそれを使う
        if (!await isCompleteTree(finalDir, manifest, { concurrency })) throw error;
      }
    } finally { await removeTree(root, staging); }
    return done(false);
  });
}

// ---- 掃除

async function listTrees(paths) {
  let names;
  try { names = await fsp.readdir(paths.app); } catch { return []; }
  const trees = [];
  for (const name of names) {
    if (name.startsWith('.')) continue;
    const dir = path.join(paths.app, name);
    const marker = await readMarker(dir);
    trees.push({ key: name, dir, marker, completedAt: Date.parse(marker?.completedAt) || 0 });
  }
  return trees;
}

/** 組み立ての残り（古い一時ファイル・組みかけの木・捨てかけの木）を消す */
async function sweepLeftovers(paths, now) {
  const stale = st => now - st.mtimeMs > STALE_MS;
  for (const parent of [paths.app, paths.node, paths.agentBrowser]) {
    let names;
    try { names = await fsp.readdir(parent); } catch { continue; }
    for (const name of names) {
      if (!name.startsWith('.')) continue;
      const dir = path.join(parent, name);
      const st = await statOr(dir);
      if (st && (name.startsWith('.trash-') || stale(st))) await removeTree(paths.root, dir);
    }
  }
  let entries;
  try { entries = await fsp.readdir(paths.store); } catch { return; }
  for (const name of entries.filter(entry => entry.endsWith('.tmp'))) {
    const file = path.join(paths.store, name);
    const st = await statOr(file);
    if (st && stale(st)) await fsp.rm(file, { force: true });
  }
}

/**
 * 使われていない古い版を消す。
 *   currentKey  今の版（消さない）
 *   isInUse     (key) => boolean。その版を使っているプロセスが居るか（既定は core/runtime-use.mjs の排他ロックの印）。居る版は消さない
 *   keep        残す版の数（今の版を含む。新しい順）
 * 戻り値 { removed, kept, inUse, failed, node, store }
 */
function cleanup({ root, currentKey, isInUse, sweepLocks, keep = KEEP_TREES, now = () => Date.now() }) {
  return serial(root, async () => {
    const paths = layout(root);
    const result = { removed: [], kept: [], inUse: [], failed: [], node: [], agentBrowser: [], store: 0 };
    if (!isInUse) {
      const use = await import('../core/runtime-use.mjs');
      isInUse = key => use.isRuntimeInUse({ root, key });
      sweepLocks ??= () => use.isRuntimeInUse({ root });
    }
    await sweepLeftovers(paths, now());

    // 印の無い木（組み終えていない・壊れた）は残す数に入れない
    const trees = (await listTrees(paths)).sort((a, b) => b.completedAt - a.completedAt);
    const keepKeys = new Set(currentKey ? [currentKey] : []);
    for (const tree of trees) if (tree.marker && keepKeys.size < keep) keepKeys.add(tree.key);
    for (const tree of trees) {
      if (keepKeys.has(tree.key)) { result.kept.push(tree.key); continue; }
      if (await isInUse(tree.key)) { result.inUse.push(tree.key); continue; }
      if (await removeTree(root, tree.dir)) result.removed.push(tree.key); else result.failed.push(tree.key);
    }

    // 木の無い版の agent-browser の置き場と、どの木も使わない Node
    const remaining = (await listTrees(paths)).filter(tree => tree.marker);
    const remainingKeys = new Set(remaining.map(tree => tree.key));
    for (const name of await fsp.readdir(paths.agentBrowser).catch(() => [])) {
      if (name.startsWith('.') || remainingKeys.has(name)) continue;
      if (await removeTree(root, path.join(paths.agentBrowser, name))) result.agentBrowser.push(name);
    }
    const usedNodes = new Set(remaining.map(tree => tree.marker.node).filter(Boolean));
    for (const name of await fsp.readdir(paths.node).catch(() => [])) {
      if (name.startsWith('.') || usedNodes.has(name)) continue;
      // 走っている pleiad-node.exe があれば名前を替えられない（消さない）
      if (await removeTree(root, path.join(paths.node, name))) result.node.push(name);
    }

    // どの木からもリンクされていない store の実体（リンク数 1）。組み立ての途中のものを巻き込まないよう、置いてから時間がたったものだけ
    const names = await fsp.readdir(paths.store).catch(() => []);
    await pool(names.filter(name => /^[0-9a-f]{64}$/.test(name)), CONCURRENCY, async name => {
      const file = path.join(paths.store, name);
      const st = await statOr(file);
      if (st?.isFile() && st.nlink === 1 && now() - st.mtimeMs > STALE_MS) { await fsp.rm(file, { force: true }); result.store++; }
    });
    // 持ち主のいない使用中の印を片付ける
    await sweepLocks?.();
    return result;
  });
}

// ---- main からの使い方

/**
 * 実行場所で走るサーバーが、外の AI（Claude Code など）に貼る設定の起動口。実行場所の Node・スクリプトは版ごとのパスで、
 * 古い版の掃除で壊れるので、版に依らない $INSTDIR の起動口（Ply.exe + resources\app\bin\pleiad.mjs）を指す（core/cli-launcher.mjs の stableCli）。
 * サーバーの env に足す
 */
function stableCliEnv({ execPath = process.execPath, resourcesPath = process.resourcesPath } = {}) {
  return { PLEIAD_CLI_EXEC: execPath, PLEIAD_CLI_SCRIPT: path.join(resourcesPath, 'app', 'bin', 'pleiad.mjs'), PLEIAD_CLI_ELECTRON: '1' };
}

module.exports = {
  RuntimeError, RUNTIME_DIR_NAME, FALLBACK_DIR, CONCURRENCY, KEEP_TREES, STALE_MS, MARKER_FILE, NODE_POINTER_FILE, RUNTIME_JSON,
  nodeExeName, collidesWithInstall, resolveRuntimeRoot, layout, versionKey, verifyTree, removeTree, install, cleanup, stableCliEnv,
};
