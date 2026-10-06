// 版ごとの実行場所（無停止の更新 1-3。desktop/runtime.cjs・runtime-manifest.cjs・runtime-boot.cjs・core/runtime-use.mjs。
// docs/zero-downtime-update/plan.md 1-3、design.md §3）。一時のフォルダーで、偽の配布物（resources\app・runtime・agent-browser）から組む。
//   - 置き場: $INSTDIR と同じ文字列で始まらない場所（前方一致・大文字小文字・環境変数の差し替え・どこにも置けない）
//   - 組み立て: store へのハードリンク・manifest との突き合わせ・二重に組まない・版が替わっても同じ中身は共有
//   - 壊れた写し: 元が manifest と合わない・欠けた・切り詰められた・同じ大きさの書き換え（deep だけ）・manifest が壊れている
//   - 掃除: 残す版の数・使っている版を消さない・古い一時ファイルと捨てかけの木・使われない Node と store の実体・root の外は消さない
//   - 使用中の印（別のプロセスで持つ）・起動口（runtime-node.txt の指す pleiad-node）・main の呼び出し口（偽の runtime）
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { markRuntimeInUse, isRuntimeInUse, listRuntimeLockKeys, runtimeLockFile } from '../../core/runtime-use.mjs';

const require = createRequire(import.meta.url);
const runtime = require('../../desktop/runtime.cjs');
const manifestLib = require('../../desktop/runtime-manifest.cjs');
const boot = require('../../desktop/runtime-boot.cjs');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export const name = 'desktop-runtime';
export const title = '版ごとの実行場所: 置き場の決め方・ハードリンクで組む・二重に組まない・壊れた写しの検出・掃除・使用中の版を消さない・起動口';

const sha = data => manifestLib.sha256(data);
const exists = p => fs.existsSync(p);
const bytes = (text, n = 1) => Buffer.from(text.repeat(n));

/** 偽の配布物 resources\ を作る。files は { 相対パス: 中身 }。manifest はビルドと同じ部品で作る */
async function makeResources(dir, { version = '1.0.0', files = {}, nodeBytes = bytes('node-binary-'.repeat(50)), nodeVersion = '24.21.0', agent = bytes('agent-browser-binary') } = {}) {
  const app = path.join(dir, 'app');
  const all = { 'package.json': JSON.stringify({ name: 'agent-host', version }), 'core/server.mjs': 'export const s = 1;\n', 'core/util.mjs': 'export const u = 2;\n', 'web/index.html': '<html></html>\n',
    'node_modules/dep/index.js': 'module.exports = 1;\n', 'node_modules/dep/lib/empty.js': '', 'bin/pleiad.mjs': '// cli\n', ...files };
  for (const [rel, content] of Object.entries(all)) {
    const file = path.join(app, ...rel.split('/'));
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, content);
  }
  const manifest = await manifestLib.buildManifest(app, { appVersion: version });
  await fsp.writeFile(path.join(app, 'manifest.json'), JSON.stringify(manifest));
  await fsp.mkdir(path.join(dir, 'runtime'), { recursive: true });
  await fsp.writeFile(path.join(dir, 'runtime', 'node.exe'), nodeBytes);
  await fsp.mkdir(path.join(dir, 'agent-browser'), { recursive: true });
  await fsp.writeFile(path.join(dir, 'agent-browser', 'agent-browser.exe'), agent);
  await fsp.writeFile(path.join(dir, 'runtime', 'runtime.json'), JSON.stringify({ schema: 1,
    node: { version: nodeVersion, arch: 'x64', file: 'node.exe', size: nodeBytes.length, sha256: sha(nodeBytes) },
    agentBrowser: { dir: 'agent-browser', file: 'agent-browser.exe', size: agent.length, sha256: sha(agent) } }));
  return { dir, manifest, key: runtime.versionKey(manifest) };
}

/** store の実体の数（.tmp を除く） */
const storeCount = root => fs.readdirSync(path.join(root, 'store')).filter(n => /^[0-9a-f]{64}$/.test(n)).length;
const treeKeys = root => fs.readdirSync(path.join(root, 'app')).filter(n => !n.startsWith('.')).sort();
const dotEntries = root => fs.readdirSync(path.join(root, 'app')).filter(n => n.startsWith('.'));

/** 同じボリュームの中でハードリンクを張れない環境（まれ）では nlink を見る試験を飛ばす */
function placeNode(dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  try { fs.linkSync(process.execPath, dest); } catch { fs.copyFileSync(process.execPath, dest); }
}

export default async function (t) {
  const scratch = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'pleiad-rt-test-')));
  try {
    // ================= 置き場の決め方（$INSTDIR の前方一致に掛からない）
    {
      const local = path.join(scratch, 'Local');
      const install = path.join(local, 'Programs', 'Ply');
      const normal = runtime.resolveRuntimeRoot({ installDir: install, env: {}, localAppData: local });
      t.ok('置き場: %LOCALAPPDATA%\\agent-host-runtime（$INSTDIR と前方一致しない）', normal.root === path.join(local, 'agent-host-runtime') && !normal.moved, normal.root);
      t.ok('置き場: $INSTDIR の下は前方一致する', runtime.collidesWithInstall(path.join(install, 'runtime'), install));
      t.ok('置き場: $INSTDIR と同じ文字列で始まる兄弟（Ply-runtime）も前方一致する（NSIS は文字列の前方一致で止める）', runtime.collidesWithInstall(path.join(local, 'Programs', 'Ply-runtime'), install));
      t.ok('置き場: 前方一致しない別の場所は当たらない', !runtime.collidesWithInstall(path.join(local, 'agent-host-runtime'), install));
      t.ok('置き場: 末尾の区切りがあっても同じ', runtime.collidesWithInstall(path.join(install, 'x'), install + path.sep));
      const win = runtime.collidesWithInstall(path.join(local, 'PROGRAMS', 'ply', 'Runtime'), install, { win: true });
      const unix = runtime.collidesWithInstall(path.join(local, 'PROGRAMS', 'ply', 'Runtime'), install, { win: false });
      t.ok('置き場: Windows は大文字小文字を区別しない', win === true && unix === false);
      // 利用者が選んだ入れ先が %LOCALAPPDATA%\agent-host（既定の置き場の名前の前方）のとき
      const clash = path.join(local, 'agent-host');
      const moved = runtime.resolveRuntimeRoot({ installDir: clash, env: {}, localAppData: local });
      t.ok('置き場: 既定が $INSTDIR と前方一致するなら %LOCALAPPDATA%\\jp.ply.desktop\\runtime へ移す', moved.moved === true && moved.root === path.join(local, 'jp.ply.desktop', 'runtime')
        && !runtime.collidesWithInstall(moved.root, clash), moved.root);
      // どこにも置けない（%LOCALAPPDATA% そのものに入れた）
      let thrown;
      try { runtime.resolveRuntimeRoot({ installDir: local, env: {}, localAppData: local }); } catch (e) { thrown = e; }
      t.ok('置き場: どの候補も前方一致するなら RuntimeError（runtime-root）', thrown?.code === 'runtime-root', String(thrown?.message));
      // 環境変数の差し替え（テスト・ハーネス用）
      const override = path.join(scratch, 'override-root');
      const picked = runtime.resolveRuntimeRoot({ installDir: install, env: { AGENT_HOST_RUNTIME_DIR: override }, localAppData: local });
      t.ok('置き場: AGENT_HOST_RUNTIME_DIR で差し替えられる', picked.root === override && !picked.moved);
      let overrideError;
      try { runtime.resolveRuntimeRoot({ installDir: install, env: { AGENT_HOST_RUNTIME_DIR: path.join(install, 'rt') }, localAppData: local }); } catch (e) { overrideError = e; }
      t.ok('置き場: 差し替えた先が $INSTDIR と前方一致するなら失敗する（黙って別の場所へ移さない）', overrideError?.code === 'runtime-root');
      let noLocal;
      try { runtime.resolveRuntimeRoot({ installDir: install, env: {}, localAppData: undefined }); } catch (e) { noLocal = e; }
      t.ok('置き場: LOCALAPPDATA が無ければ RuntimeError', noLocal?.code === 'runtime-root');
    }

    // ================= manifest
    {
      const res = await makeResources(path.join(scratch, 'm1'));
      const parsed = await manifestLib.readManifest(path.join(res.dir, 'app'));
      t.ok('manifest: 自身（manifest.json）を含まない・全ファイルが SHA-256 と大きさで並ぶ', !('manifest.json' in parsed.files) && parsed.files['core/server.mjs'].size === 'export const s = 1;\n'.length
        && parsed.files['core/server.mjs'].sha256 === sha('export const s = 1;\n') && parsed.files['node_modules/dep/lib/empty.js'].size === 0 && Object.keys(parsed.files).length === 7);
      t.ok('manifest: 同じ中身なら buildHash が同じ（並び・並列度に依らない）', (await manifestLib.buildManifest(path.join(res.dir, 'app'), { appVersion: '1.0.0', concurrency: 1 })).buildHash === parsed.buildHash);
      const edit = (mutate) => { const copy = JSON.parse(JSON.stringify(parsed)); mutate(copy); return JSON.stringify(copy); };
      const bad = text => { try { manifestLib.parseManifest(text); return null; } catch (e) { return e.code; } };
      t.ok('manifest: 壊れた JSON・schema 違い・buildHash の不一致は manifest-invalid', bad('{') === 'manifest-invalid' && bad(edit(m => { m.schema = 9; })) === 'manifest-invalid'
        && bad(edit(m => { m.files['core/server.mjs'].size += 1; })) === 'manifest-invalid');
      t.ok('manifest: 外へ出るパス（..・絶対・\\ 区切り・ドライブ）は受けない', ['../x', '/etc/x', 'a\\b', 'C:/x', 'a//b'].every(rel => bad(edit(m => { m.files[rel] = { size: 1, sha256: 'a'.repeat(64) }; })) === 'manifest-invalid'));
      let missing;
      try { await manifestLib.readManifest(path.join(scratch, 'nowhere')); } catch (e) { missing = e.code; }
      t.ok('manifest: 無ければ manifest-missing', missing === 'manifest-missing');
    }

    // ================= 組み立て
    const root = path.join(scratch, 'runtime-root');
    const res1 = await makeResources(path.join(scratch, 'res1'), { version: '1.0.0' });
    {
      const installed = await runtime.install({ root, resourcesDir: res1.dir });
      t.ok('組む: 版の名前は <版>-<ビルドの短いハッシュ>・木は app\\<版> に出来る', installed.key === `1.0.0-${res1.manifest.buildHash.slice(0, 12)}` && installed.appDir === path.join(root, 'app', installed.key) && !installed.reused);
      const verify = await runtime.verifyTree(installed.appDir, res1.manifest, { deep: true });
      t.ok('組む: 全ファイルが manifest と一致（中身の SHA-256 まで）', verify.ok, JSON.stringify(verify));
      t.ok('組む: store の実体は中身ごとに 1 つ（同じ中身の複数パスは 1 つ）・木は store へのハードリンク', storeCount(root) === new Set(Object.values(res1.manifest.files).map(f => f.sha256)).size + 1 /* agent-browser */
        && fs.statSync(path.join(installed.appDir, 'core', 'server.mjs')).nlink === 2 && fs.statSync(path.join(installed.appDir, 'core', 'server.mjs')).ino === fs.statSync(path.join(root, 'store', res1.manifest.files['core/server.mjs'].sha256)).ino
        && installed.stats.linked === installed.stats.files && installed.stats.copied === 0);
      t.ok('組む: 配布物の写しと中身が同じ（空ファイルも）', fs.readFileSync(path.join(installed.appDir, 'core', 'util.mjs'), 'utf8') === 'export const u = 2;\n' && fs.statSync(path.join(installed.appDir, 'node_modules', 'dep', 'lib', 'empty.js')).size === 0);
      const marker = JSON.parse(fs.readFileSync(path.join(installed.appDir, runtime.MARKER_FILE), 'utf8'));
      t.ok('組む: 完了の印（版・ビルド・組んだ時刻・Node の置き場）', marker.state === 'full' && marker.buildHash === res1.manifest.buildHash && marker.appVersion === '1.0.0' && marker.node === path.basename(installed.nodeDir) && !Number.isNaN(Date.parse(marker.completedAt)));
      t.ok('組む: Node は node\\<版>-<sha256 の先頭>\\pleiad-node.exe に 1 つ・名前は Ply.exe でない', installed.nodeExe === path.join(root, 'node', `24.21.0-${sha(fs.readFileSync(path.join(res1.dir, 'runtime', 'node.exe'))).slice(0, 12)}`, runtime.nodeExeName())
        && fs.readFileSync(installed.nodeExe).equals(fs.readFileSync(path.join(res1.dir, 'runtime', 'node.exe'))) && !/ply\.exe$/i.test(installed.nodeExe));
      t.ok('組む: 起動口が読む runtime-node.txt（Node の置き場の名前 1 行）', fs.readFileSync(path.join(installed.appDir, runtime.NODE_POINTER_FILE), 'utf8') === `${path.basename(installed.nodeDir)}\n`);
      t.ok('組む: agent-browser は agent-browser\\<版>\\ に store へのハードリンクで置く', installed.agentBrowserDir === path.join(root, 'agent-browser', installed.key)
        && fs.readFileSync(path.join(installed.agentBrowserDir, 'agent-browser.exe')).equals(Buffer.from('agent-browser-binary')) && fs.statSync(path.join(installed.agentBrowserDir, 'agent-browser.exe')).nlink >= 2);
      t.ok('組む: 組み立ての残り（staging・一時ファイル）を残さない', dotEntries(root).length === 0 && fs.readdirSync(path.join(root, 'store')).every(n => !n.endsWith('.tmp')));
      t.ok('組む: $INSTDIR の木へはリンクしない（元の配布物とは別の実体。store が持つ）', fs.statSync(path.join(res1.dir, 'app', 'core', 'server.mjs')).ino !== fs.statSync(path.join(installed.appDir, 'core', 'server.mjs')).ino);

      // 二重に組まない
      const storeBefore = storeCount(root);
      const inoBefore = fs.statSync(path.join(installed.appDir, runtime.MARKER_FILE)).ino;
      const markerBefore = fs.readFileSync(path.join(installed.appDir, runtime.MARKER_FILE), 'utf8');
      const again = await runtime.install({ root, resourcesDir: res1.dir });
      t.ok('二重に組まない: 同じ版を 2 回目に頼むと、そのまま使う（印も木も作り直さない）', again.reused === true && again.stats.stored === 0 && again.stats.linked === 0
        && fs.statSync(path.join(again.appDir, runtime.MARKER_FILE)).ino === inoBefore && fs.readFileSync(path.join(again.appDir, runtime.MARKER_FILE), 'utf8') === markerBefore && storeCount(root) === storeBefore);
      const [one, two] = await Promise.all([runtime.install({ root, resourcesDir: res1.dir }), runtime.install({ root, resourcesDir: res1.dir })]);
      t.ok('二重に組まない: 同時に頼んでも 1 つの木・壊れない', one.appDir === two.appDir && (await runtime.verifyTree(one.appDir, res1.manifest, { deep: true })).ok && treeKeys(root).length === 1);
    }

    // ================= 版が替わる: 同じ中身は共有する
    let res2;
    {
      res2 = await makeResources(path.join(scratch, 'res2'), { version: '1.0.1', files: { 'core/server.mjs': 'export const s = 2; // changed\n' } });
      const before = storeCount(root);
      const installed = await runtime.install({ root, resourcesDir: res2.dir, now: () => Date.parse('2026-10-06T00:00:10Z') });
      const t1 = path.join(root, 'app', res1.key, 'core', 'util.mjs'), t2 = path.join(installed.appDir, 'core', 'util.mjs');
      t.ok('2 版目: 木が増える・変わった分（server.mjs と package.json の 2 つ）だけ store が増える', treeKeys(root).length === 2 && storeCount(root) === before + 2 && installed.stats.stored === 2, `${before} -> ${storeCount(root)}`);
      t.ok('2 版目: 変わっていないファイルは 1 版目と同じ実体（ハードリンク 3）・Node と agent-browser の実体も共有', fs.statSync(t1).ino === fs.statSync(t2).ino && fs.statSync(t2).nlink === 3
        && fs.readdirSync(path.join(root, 'node')).length === 1);
      t.ok('2 版目: 1 版目の木は変わらない', (await runtime.verifyTree(path.join(root, 'app', res1.key), res1.manifest, { deep: true })).ok);
    }

    // ================= 壊れた写しの検出
    {
      const appDir = path.join(root, 'app', res2.key);
      // 木が壊れた: 欠けた
      fs.rmSync(path.join(appDir, 'web', 'index.html'));
      const quick = await runtime.verifyTree(appDir, res2.manifest);
      t.ok('壊れた写し: 欠けたファイルを検出する', !quick.ok && quick.missing.includes('web/index.html'), JSON.stringify(quick));
      const rebuilt = await runtime.install({ root, resourcesDir: res2.dir });
      t.ok('壊れた写し: 欠けていれば再利用せず組み直す', rebuilt.reused === false && (await runtime.verifyTree(appDir, res2.manifest, { deep: true })).ok);
      // 切り詰められた（ハードリンクなので store の実体も同じ inode で切り詰められる）
      fs.truncateSync(path.join(appDir, 'core', 'util.mjs'), 3);
      const size = await runtime.verifyTree(appDir, res2.manifest);
      t.ok('壊れた写し: 大きさの違いを検出する', !size.ok && size.sizeMismatch.includes('core/util.mjs'));
      // ハードリンクは運命を共にする: 変わっていない util.mjs は 1 版目の木と store が同じ実体なので、1 版目の木も壊れている
      const shared = await runtime.verifyTree(path.join(root, 'app', res1.key), res1.manifest);
      const afterTruncate = await runtime.install({ root, resourcesDir: res2.dir });
      t.ok('壊れた写し: 切り詰められた実体は store から使わず、元から読み直して組み直す', afterTruncate.reused === false && !shared.ok
        && fs.readFileSync(path.join(appDir, 'core', 'util.mjs'), 'utf8') === 'export const u = 2;\n' && (await runtime.verifyTree(appDir, res2.manifest, { deep: true })).ok);
      const repaired = await runtime.install({ root, resourcesDir: res1.dir });
      t.ok('壊れた写し: 実体を共有していた 1 版目も、使うときの確かめで見つかって直る', repaired.reused === false && (await runtime.verifyTree(path.join(root, 'app', res1.key), res1.manifest, { deep: true })).ok);
      // 同じ大きさのまま書き換えられた: 大きさだけの確かめは通り、deep が見つける
      const victim = path.join(appDir, 'core', 'server.mjs');
      const original = fs.readFileSync(victim);
      fs.writeFileSync(victim, Buffer.alloc(original.length, 0x41));
      const sameSize = await runtime.verifyTree(appDir, res2.manifest);
      const deep = await runtime.verifyTree(appDir, res2.manifest, { deep: true });
      t.ok('壊れた写し: 同じ大きさの書き換えは大きさの確かめでは通り、deep（SHA-256）が見つける', sameSize.ok === true && deep.ok === false && deep.hashMismatch.includes('core/server.mjs'), JSON.stringify(deep));
      fs.writeFileSync(victim, original);   // store の実体と同じ inode なので、元へ戻す
    }
    {
      // 元（配布物）が manifest と合わない
      const bad = await makeResources(path.join(scratch, 'res-bad'), { version: '2.0.0' });
      const target = path.join(bad.dir, 'app', 'core', 'util.mjs');
      await fsp.writeFile(target, 'export const u = 9;\n');   // 同じ長さ・違う中身
      const badRoot = path.join(scratch, 'bad-root');
      let error;
      try { await runtime.install({ root: badRoot, resourcesDir: bad.dir }); } catch (e) { error = e; }
      t.ok('元が合わない: manifest と違う中身は source-mismatch で失敗し、版の木を作らない', error?.code === 'source-mismatch' && !exists(path.join(badRoot, 'app', bad.key)), String(error?.message));
      t.ok('元が合わない: 組みかけ（staging）も、store の一時ファイルも残さない', dotEntries(badRoot).length === 0 && fs.readdirSync(path.join(badRoot, 'store')).every(n => !n.endsWith('.tmp')));
      await fsp.rm(target);
      let gone;
      try { await runtime.install({ root: badRoot, resourcesDir: bad.dir }); } catch (e) { gone = e; }
      t.ok('元が合わない: 欠けたファイルは source-missing', gone?.code === 'source-missing' && !exists(path.join(badRoot, 'app', bad.key)));
      // 元を直せば同じ root で組める（失敗が尾を引かない）
      await fsp.writeFile(target, 'export const u = 2;\n');
      const fixed = await runtime.install({ root: badRoot, resourcesDir: bad.dir });
      t.ok('元が合わない: 元を直せば同じ置き場でそのまま組める', fixed.reused === false && (await runtime.verifyTree(fixed.appDir, bad.manifest, { deep: true })).ok);
      // Node の exe が runtime.json と合わない
      const nodeRes = await makeResources(path.join(scratch, 'res-node'), { version: '2.1.0' });
      await fsp.writeFile(path.join(nodeRes.dir, 'runtime', 'node.exe'), bytes('tampered-node-'.repeat(50)));
      let nodeError;
      try { await runtime.install({ root: path.join(scratch, 'node-root'), resourcesDir: nodeRes.dir }); } catch (e) { nodeError = e; }
      t.ok('Node が合わない: runtime.json の SHA-256 と違えば node-mismatch で、置かない', nodeError?.code === 'node-mismatch' && !exists(path.join(scratch, 'node-root', 'app', nodeRes.key))
        && (!exists(path.join(scratch, 'node-root', 'node')) || fs.readdirSync(path.join(scratch, 'node-root', 'node')).length === 0), String(nodeError?.message));
      // manifest が壊れた・無い
      const noManifest = await makeResources(path.join(scratch, 'res-nomanifest'), { version: '2.2.0' });
      await fsp.rm(path.join(noManifest.dir, 'app', 'manifest.json'));
      let nm;
      try { await runtime.install({ root: path.join(scratch, 'nm-root'), resourcesDir: noManifest.dir }); } catch (e) { nm = e; }
      t.ok('manifest が無い版は組まない（manifest-missing）', nm?.code === 'manifest-missing');
    }
    {
      // ハードリンクが張れない環境は写しに落ちる（別のボリューム・FAT・リンク数の上限）
      const copyRoot = path.join(scratch, 'copy-root');
      const exdev = async () => { throw Object.assign(new Error('cross-device link'), { code: 'EXDEV' }); };
      const installed = await runtime.install({ root: copyRoot, resourcesDir: res1.dir, link: exdev });
      t.ok('リンクが張れなければ写す: 木は manifest と一致・リンク数 1', installed.stats.copied === installed.stats.files && installed.stats.linked === 0
        && (await runtime.verifyTree(installed.appDir, res1.manifest, { deep: true })).ok && fs.statSync(path.join(installed.appDir, 'core', 'server.mjs')).nlink === 1);
    }

    // ================= 掃除
    {
      const cleanRoot = path.join(scratch, 'clean-root');
      const base = Date.parse('2026-10-06T00:00:00Z');
      const versions = [];
      for (let i = 1; i <= 5; i += 1) {
        const r = await makeResources(path.join(scratch, `c${i}`), { version: `3.0.${i}`, files: { 'core/server.mjs': `export const s = ${i};\n` } });
        const installed = await runtime.install({ root: cleanRoot, resourcesDir: r.dir, now: () => base + i * 60_000 });
        versions.push({ ...r, ...installed });
      }
      t.ok('掃除の前: 5 版が並ぶ', treeKeys(cleanRoot).length === 5);
      const later = () => Date.now() + 3 * 60 * 60 * 1000;   // store の実体は、置いて 10 分たったものだけ消す
      const inUse = new Set();
      const swept = await runtime.cleanup({ root: cleanRoot, currentKey: versions[4].key, isInUse: key => inUse.has(key), sweepLocks: async () => false, now: later });
      t.ok('掃除: 今の版・直前の版・さらにもう 1 版（計 3 つ）を残し、古い 2 つを消す', JSON.stringify(treeKeys(cleanRoot)) === JSON.stringify([versions[2].key, versions[3].key, versions[4].key].sort())
        && swept.removed.length === 2 && swept.kept.length === 3, JSON.stringify(swept));
      t.ok('掃除: 消した版の agent-browser の置き場も消える', !exists(path.join(cleanRoot, 'agent-browser', versions[0].key)) && exists(path.join(cleanRoot, 'agent-browser', versions[4].key)));
      const live = new Set(fs.readdirSync(path.join(cleanRoot, 'store')).filter(n => /^[0-9a-f]{64}$/.test(n)));
      t.ok('掃除: どの木からもリンクされない store の実体は消し（消した版にだけあった server.mjs）、残った版の実体は残る',
        !live.has(versions[0].manifest.files['core/server.mjs'].sha256) && !live.has(versions[1].manifest.files['core/server.mjs'].sha256) && live.has(versions[4].manifest.files['core/server.mjs'].sha256)
        && live.has(versions[2].manifest.files['core/server.mjs'].sha256) && swept.store >= 2, `store ${live.size} / 消した ${swept.store}`);
      t.ok('掃除: 残った木は壊れていない', (await runtime.verifyTree(path.join(cleanRoot, 'app', versions[2].key), versions[2].manifest, { deep: true })).ok);
      t.ok('掃除: 使われている Node は消さない', fs.readdirSync(path.join(cleanRoot, 'node')).length === 1);

      // 使っているプロセスがある版は、古くても消さない
      const rollback = await runtime.install({ root: cleanRoot, resourcesDir: versions[0].dir, now: () => base + 60_000 });
      inUse.add(versions[0].key);
      const guarded = await runtime.cleanup({ root: cleanRoot, currentKey: versions[4].key, isInUse: key => inUse.has(key), sweepLocks: async () => false, now: later });
      t.ok('使っている版を消さない: 使用中の印がある古い版は残し、結果に出す', treeKeys(cleanRoot).includes(versions[0].key) && guarded.inUse.includes(versions[0].key) && !guarded.removed.includes(versions[0].key), JSON.stringify(guarded));
      inUse.clear();
      const released = await runtime.cleanup({ root: cleanRoot, currentKey: versions[4].key, isInUse: key => inUse.has(key), sweepLocks: async () => false, now: later });
      t.ok('使っている版を消さない: 印が外れた後の掃除で消える', !treeKeys(cleanRoot).includes(versions[0].key) && released.removed.includes(versions[0].key) && rollback.key === versions[0].key);
      // 今の版が古くても（戻したとき）今の版は消さない
      const oldCurrent = await runtime.cleanup({ root: cleanRoot, currentKey: versions[2].key, isInUse: () => false, sweepLocks: async () => false, keep: 1, now: later });
      t.ok('今の版は、どれだけ古くても消さない（keep が 1 でも）', JSON.stringify(treeKeys(cleanRoot)) === JSON.stringify([versions[2].key]) && oldCurrent.kept.includes(versions[2].key), JSON.stringify(treeKeys(cleanRoot)));
    }
    {
      // 止まった組み立ての残りの後始末・使われない Node
      const leftRoot = path.join(scratch, 'left-root');
      const r = await makeResources(path.join(scratch, 'left-res'), { version: '4.0.0' });
      const installed = await runtime.install({ root: leftRoot, resourcesDir: r.dir });
      const old = new Date(Date.now() - 60 * 60 * 1000);
      const staging = path.join(leftRoot, 'app', '.9.9.9-abc.staging');
      const trash = path.join(leftRoot, 'app', '.trash-deadbeef');
      const fresh = path.join(leftRoot, 'app', '.9.9.8-def.staging');
      for (const dir of [staging, trash, fresh]) { fs.mkdirSync(path.join(dir, 'core'), { recursive: true }); fs.writeFileSync(path.join(dir, 'core', 'x'), 'x'); }
      fs.utimesSync(staging, old, old);
      const staleTmp = path.join(leftRoot, 'store', `${'a'.repeat(64)}.1234.tmp`);
      const freshTmp = path.join(leftRoot, 'store', `${'b'.repeat(64)}.5678.tmp`);
      fs.writeFileSync(staleTmp, 'x'); fs.writeFileSync(freshTmp, 'x');
      fs.utimesSync(staleTmp, old, old);
      const strayNode = path.join(leftRoot, 'node', '23.0.0-oldnode0000');
      fs.mkdirSync(strayNode, { recursive: true }); fs.writeFileSync(path.join(strayNode, runtime.nodeExeName()), 'old');
      const orphan = path.join(leftRoot, 'agent-browser', '0.0.1-gone'); fs.mkdirSync(orphan, { recursive: true }); fs.writeFileSync(path.join(orphan, 'agent-browser.exe'), 'x');
      const result = await runtime.cleanup({ root: leftRoot, currentKey: installed.key, isInUse: () => false, sweepLocks: async () => false });
      t.ok('掃除: 止まった組み立ての残り（古い staging・捨てかけの木・古い一時ファイル）を消し、新しいものは触らない', !exists(staging) && !exists(trash) && exists(fresh) && !exists(staleTmp) && exists(freshTmp));
      t.ok('掃除: どの木も使わない Node・版のない agent-browser の置き場を消し、使っている Node は残す', !exists(strayNode) && !exists(orphan) && exists(installed.nodeExe) && result.node.includes('23.0.0-oldnode0000'));
      t.ok('掃除: 残した版は壊れていない', (await runtime.verifyTree(installed.appDir, r.manifest, { deep: true })).ok);
      // 置き場の外は消さない
      let refused;
      try { await runtime.removeTree(leftRoot, path.join(scratch, 'left-res')); } catch (e) { refused = e; }
      t.ok('置き場の外は消さない（removeTree は root の下だけ）', refused?.code === 'outside-root' && exists(path.join(scratch, 'left-res', 'app')));
      let sameAsRoot;
      try { await runtime.removeTree(leftRoot, leftRoot); } catch (e) { sameAsRoot = e; }
      t.ok('置き場そのものも消さない', sameAsRoot?.code === 'outside-root' && exists(leftRoot));
    }

    // ================= 使用中の印（OS の排他ロック。別のプロセスで持つ）
    {
      const lockRoot = path.join(scratch, 'lock-root');
      const key = '5.0.0-0123456789ab';
      t.ok('使用中の印: 無ければ使われていない', isRuntimeInUse({ root: lockRoot, key }) === false);
      const release = markRuntimeInUse({ root: lockRoot, key });
      t.ok('使用中の印: 付けると、同じプロセスからも使用中に見える・別の版は使われていない', typeof release === 'function' && isRuntimeInUse({ root: lockRoot, key }) === true && isRuntimeInUse({ root: lockRoot, key: 'other' }) === false
        && listRuntimeLockKeys(lockRoot).includes(key) && path.basename(runtimeLockFile(lockRoot, key)) === `${key}-${process.pid}.lock.db`);
      release();
      t.ok('使用中の印: 外すとファイルも消え、使われていない', isRuntimeInUse({ root: lockRoot, key }) === false && listRuntimeLockKeys(lockRoot).length === 0);
      // 別のプロセス（強制終了でも OS が外す）
      const child = spawn(process.execPath, [path.join(ROOT, 'tests', 'lib', 'runtime-lock-holder.mjs'), lockRoot, key], { stdio: ['pipe', 'pipe', 'inherit'] });
      const line = await new Promise((resolve, reject) => { child.stdout.once('data', d => resolve(String(d).trim())); child.once('error', reject); child.once('exit', () => resolve('exit')); });
      t.ok('使用中の印: 別のプロセスが持っている間は使用中', line === 'held' && isRuntimeInUse({ root: lockRoot, key }) === true);
      const closed = new Promise(resolve => child.once('exit', resolve));
      child.kill();   // 強制終了（Windows は TerminateProcess）。OS がロックを外す
      await closed;
      t.ok('使用中の印: プロセスが強制終了されても OS が外し、残った印のファイルは掃除で消える（PID の生死は見ない）', isRuntimeInUse({ root: lockRoot, key }) === false && listRuntimeLockKeys(lockRoot).length === 0);
      // 壊れた印のファイル（SQLite でない）は持ち主のいない印として消す
      fs.mkdirSync(path.join(lockRoot, 'run'), { recursive: true });
      fs.writeFileSync(path.join(lockRoot, 'run', `${key}-999999.lock.db`), 'not a database');
      t.ok('使用中の印: 壊れたファイルは持ち主のいない印として消す', isRuntimeInUse({ root: lockRoot, key }) === false && listRuntimeLockKeys(lockRoot).length === 0);
      // 掃除（既定の isInUse）が、印のある版を消さない
      const useRoot = path.join(scratch, 'use-root');
      const a = await makeResources(path.join(scratch, 'u1'), { version: '6.0.1', files: { 'core/server.mjs': 'a\n' } });
      const b = await makeResources(path.join(scratch, 'u2'), { version: '6.0.2', files: { 'core/server.mjs': 'b\n' } });
      const ia = await runtime.install({ root: useRoot, resourcesDir: a.dir, now: () => 1000 });
      const ib = await runtime.install({ root: useRoot, resourcesDir: b.dir, now: () => 2000 });
      const hold = markRuntimeInUse({ root: useRoot, key: ia.key });
      const guarded = await runtime.cleanup({ root: useRoot, currentKey: ib.key, keep: 1, now: () => Date.now() });
      t.ok('掃除（既定の判定）: 排他ロックの印がある版は消さない', guarded.inUse.includes(ia.key) && exists(ia.appDir) && exists(ib.appDir), JSON.stringify(guarded));
      hold();
      const afterRelease = await runtime.cleanup({ root: useRoot, currentKey: ib.key, keep: 1, now: () => Date.now() });
      t.ok('掃除（既定の判定）: 印が外れれば消える', afterRelease.removed.includes(ia.key) && !exists(ia.appDir) && exists(ib.appDir));
    }

    // ================= 起動口（bin/pleiad.cmd・bin/pleiad）が、runtime-node.txt の指す pleiad-node を使う
    {
      const launchRoot = path.join(scratch, 'launch-root');
      const nodeDir = path.join(launchRoot, 'node', '24.21.0-0123456789ab');
      const binDir = path.join(launchRoot, 'app', '1.0.0-aaaaaaaaaaaa', 'bin');
      fs.mkdirSync(binDir, { recursive: true });
      placeNode(path.join(nodeDir, runtime.nodeExeName()));
      fs.writeFileSync(path.join(launchRoot, 'app', '1.0.0-aaaaaaaaaaaa', runtime.NODE_POINTER_FILE), '24.21.0-0123456789ab\n');
      fs.writeFileSync(path.join(binDir, 'pleiad.mjs'), 'console.log(JSON.stringify({ execPath: process.execPath, electron: process.versions.electron ?? null, args: process.argv.slice(2) }));\n');
      const win = process.platform === 'win32';
      const launcher = path.join(binDir, win ? 'pleiad.cmd' : 'pleiad');
      fs.copyFileSync(path.join(ROOT, 'bin', win ? 'pleiad.cmd' : 'pleiad'), launcher);
      if (!win) fs.chmodSync(launcher, 0o755);
      const run = spawnSync(win ? process.env.ComSpec || 'cmd.exe' : launcher, win ? ['/d', '/c', launcher, 'list', 'a b'] : ['list', 'a b'], { encoding: 'utf8', env: { ...process.env, ELECTRON_RUN_AS_NODE: '' } });
      let out = null;
      try { out = JSON.parse(run.stdout.trim().split(/\r?\n/).pop()); } catch { /* 下で落とす */ }
      t.ok('起動口: 実行場所の版の bin から、runtime-node.txt の指す pleiad-node を走らせ、引数をそのまま渡す', run.status === 0 && out?.execPath && path.resolve(out.execPath).toLowerCase() === path.join(nodeDir, runtime.nodeExeName()).toLowerCase()
        && out.electron === null && JSON.stringify(out.args) === JSON.stringify(['list', 'a b']), `${run.status} ${run.stdout} ${run.stderr}`);
    }

    // ================= main の呼び出し口（runtime-boot）
    {
      const logs = [];
      const timers = [];
      const calls = [];
      const fake = {
        resolveRuntimeRoot: ({ installDir }) => { calls.push(['resolve', installDir]); return { root: '/rt', moved: true }; },
        install: async ({ root: r, resourcesDir }) => { calls.push(['install', r, resourcesDir]); return { key: '1.0.0-abc', appDir: '/rt/app/1.0.0-abc', reused: false, stats: { files: 3, stored: 2, linked: 3, copied: 0, ms: 5 } }; },
        cleanup: async ({ root: r, currentKey }) => { calls.push(['cleanup', r, currentKey]); return { removed: ['0.9.0-old'], node: [] }; },
      };
      const result = await boot.prepareRuntime({ resourcesPath: '/inst/resources', execPath: path.join('/inst', 'Ply.exe'), env: {}, log: line => logs.push(line), runtime: fake, setTimer: (fn, ms) => { timers.push([fn, ms]); return { unref() {} }; } });
      t.ok('呼び出し口: $INSTDIR（実行ファイルのフォルダー）を渡して置き場を決め、配布物の resources から組む', calls[0][0] === 'resolve' && calls[0][1] === path.dirname(path.join('/inst', 'Ply.exe')) && calls[1][0] === 'install' && calls[1][2] === '/inst/resources' && result.key === '1.0.0-abc' && result.root === '/rt');
      t.ok('呼び出し口: 置き場が移ったこと・組んだ結果を記録する', logs.some(l => /moved to \/rt/.test(l)) && logs.some(l => /1\.0\.0-abc/.test(l) && /3 files/.test(l)));
      t.ok('呼び出し口: 掃除はすぐにせず、起動から少し後に裏で行う（今の版を渡す）', timers.length === 1 && timers[0][1] === boot.CLEANUP_DELAY_MS && calls.length === 2);
      timers[0][0]();
      await new Promise(resolve => setImmediate(resolve));
      t.ok('呼び出し口: 時間が来ると、今の版を残して掃除する', calls[2]?.[0] === 'cleanup' && calls[2][2] === '1.0.0-abc' && logs.some(l => /removed 0\.9\.0-old/.test(l)));
      const failing = await boot.prepareRuntime({ resourcesPath: '/x', execPath: '/x/Ply.exe', env: {}, log: line => logs.push(line),
        runtime: { ...fake, install: async () => { throw Object.assign(new Error('boom'), { code: 'source-mismatch' }); } }, setTimer: () => { throw new Error('掃除は予約しない'); } });
      t.ok('呼び出し口: 組めなくても投げない（起動を止めない）・null と記録', failing === null && logs.some(l => /preparation failed \(source-mismatch\): boom/.test(l)));
    }

    // ================= 外の AI に貼る設定は版に依らない起動口（main が env で渡す）
    {
      const env = runtime.stableCliEnv({ execPath: path.join(scratch, 'Programs', 'Ply', 'Ply.exe'), resourcesPath: path.join(scratch, 'Programs', 'Ply', 'resources') });
      t.ok('stableCliEnv: $INSTDIR の Ply.exe と resources\\app\\bin\\pleiad.mjs（実行場所の版ごとのパスを指さない）・Electron の内蔵 Node', env.PLEIAD_CLI_EXEC.endsWith('Ply.exe') && env.PLEIAD_CLI_SCRIPT === path.join(scratch, 'Programs', 'Ply', 'resources', 'app', 'bin', 'pleiad.mjs')
        && env.PLEIAD_CLI_ELECTRON === '1' && !env.PLEIAD_CLI_SCRIPT.includes('agent-host-runtime'));
    }
  } finally {
    await fsp.rm(scratch, { recursive: true, force: true, maxRetries: 5 });
  }
}
