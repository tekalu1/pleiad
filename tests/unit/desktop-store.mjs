// Microsoft Store の MSIX（docs/microsoft-store.md）の、Electron を起こさずに確かめられる部分。
//   - 自動更新の分岐（desktop/updates.cjs の isStoreBuild・updaterEnabled と、Updates の store）
//   - パッケージの識別子と版に依らない起動口（desktop/msix.cjs）
//   - Store 用の設定（electron-builder.store.cjs）と manifest（build/appx-manifest.xml）・タイルの画像（build/appx/）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const { Updates, isStoreBuild, updaterEnabled } = require('../../desktop/updates.cjs');
const { packagedIdentity, stableLauncher } = require('../../desktop/msix.cjs');

export const name = 'desktop-store';
export const title = 'Microsoft Store (MSIX) build: updater off, package identity, store config';

/** 環境変数を替えて Store 用の設定を読み直す */
function loadStoreConfig(env) {
  const file = path.join(ROOT, 'electron-builder.store.cjs');
  const saved = {};
  for (const key of Object.keys(env)) { saved[key] = process.env[key]; if (env[key] === undefined) delete process.env[key]; else process.env[key] = env[key]; }
  try { delete require.cache[require.resolve(file)]; return require(file); }
  finally { for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
}

export default async function (t) {
  // ---------------------------------------------------------------- 自動更新の分岐
  const feed = { packaged: true, feed: true };
  t.ok('release 設定の配布版は自動更新する', updaterEnabled({ ...feed, pkg: { plyRelease: true }, windowsStore: false }) === true);
  t.ok('plyStore を焼き込んだ版は、フィードがあっても自動更新しない', updaterEnabled({ ...feed, pkg: { plyRelease: true, plyStore: true }, windowsStore: false }) === false);
  t.ok('MSIX のパッケージとして動いていれば、plyStore が無くても自動更新しない', updaterEnabled({ ...feed, pkg: { plyRelease: true }, windowsStore: true }) === false);
  t.ok('開発起動・フィードの無い版は今までどおり自動更新しない',
    updaterEnabled({ packaged: false, feed: true, pkg: { plyRelease: true } }) === false && updaterEnabled({ packaged: true, feed: false, pkg: { plyRelease: true } }) === false);
  t.ok('Store の版の見分け', isStoreBuild({ pkg: { plyStore: true } }) && isStoreBuild({ pkg: {}, windowsStore: true }) && !isStoreBuild({ pkg: { plyRelease: true }, windowsStore: undefined }));

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ply-store-test-'));
  try {
    const updater = new EventEmitter();
    let checks = 0;
    updater.checkForUpdates = async () => { checks++; };
    const updates = new Updates({ updater, version: '0.9.2', file: path.join(dir, 'updates.json'), enabled: true, store: true, install: async () => {} });
    await updates.init();
    const state = updates.snapshot();
    t.ok('Store の版は enabled でも確認しない状態で始まる（画面は Store の案内を出す）', state.store === true && state.enabled === false && state.phase === 'unavailable');
    t.ok('Store の版は自動の確認をしない', await updates.auto() === false && checks === 0);
    let refused = false;
    try { await updates.command('check'); } catch { refused = true; }
    t.ok('Store の版は手動の確認も断る', refused && checks === 0);
    const direct = new Updates({ updater: new EventEmitter(), version: '0.9.2', file: path.join(dir, 'direct.json'), enabled: true, install: async () => {} });
    t.ok('GitHub Releases の版は store を持たない', direct.snapshot().store === false && direct.snapshot().phase === 'idle');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }

  // ---------------------------------------------------------------- 識別子と起動口
  const store = { platform: 'win32', windowsStore: true, execPath: 'C:\\Program Files\\WindowsApps\\Pleiad_0.9.2.0_x64__abc\\app\\Ply.exe' };
  const plain = { platform: 'win32', execPath: 'C:\\Users\\u\\AppData\\Local\\Programs\\Pleiad\\Ply.exe' };
  const alias = 'C:\\Users\\u\\AppData\\Local\\Microsoft\\WindowsApps\\Ply.exe';
  t.ok('識別子は Windows の windowsStore だけで決まる', packagedIdentity(store) && !packagedIdentity(plain) && !packagedIdentity({ platform: 'darwin', windowsStore: true }));
  t.ok('Store の版の起動口は App Execution Alias', stableLauncher({ proc: store, env: { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' }, exists: p => p === alias }) === alias);
  t.ok('エイリアスが無ければパッケージの中の実行ファイル', stableLauncher({ proc: store, env: { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' }, exists: () => false }) === store.execPath);
  t.ok('NSIS の版は今までどおり実行ファイル', stableLauncher({ proc: plain, env: { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' }, exists: () => true }) === plain.execPath);

  // ---------------------------------------------------------------- Store 用の設定
  const placeholder = loadStoreConfig({ PLY_STORE_IDENTITY_NAME: undefined, PLY_STORE_PUBLISHER: undefined, PLY_STORE_REQUIRE_IDENTITY: undefined });
  const base = require('yaml').parse(fs.readFileSync(path.join(ROOT, 'electron-builder.yml'), 'utf8'));
  t.ok('Store 用は appx だけを作り、更新フィードを入れない', JSON.stringify(placeholder.win.target) === JSON.stringify([{ target: 'appx', arch: ['x64', 'arm64'] }]) && placeholder.publish === null);
  t.ok('Store 用は plyStore を焼き込み、plyRelease は入れない', placeholder.extraMetadata.plyStore === true && placeholder.extraMetadata.plyRelease === undefined);
  t.ok('識別子（appId・実行ファイル名・package の name）は NSIS と同じ（ADR 0019）',
    placeholder.appId === 'jp.ply.desktop' && placeholder.win.executableName === 'Ply' && placeholder.extraMetadata.name === undefined && base.win.target[0].target === 'nsis');
  t.ok('Store が割り当てる値が無ければ仮の値', placeholder.appx.identityName === 'PleiadPlaceholder.Pleiad' && /^CN=0{8}-/.test(placeholder.appx.publisher));
  const assigned = loadStoreConfig({ PLY_STORE_IDENTITY_NAME: '12345Example.Pleiad', PLY_STORE_PUBLISHER: 'CN=11111111-2222-3333-4444-555555555555', PLY_STORE_PUBLISHER_DISPLAY_NAME: 'Example' });
  t.ok('Partner Center の値は環境変数から入る', assigned.appx.identityName === '12345Example.Pleiad' && assigned.appx.publisher === 'CN=11111111-2222-3333-4444-555555555555' && assigned.appx.publisherDisplayName === 'Example');
  let required = false;
  try { loadStoreConfig({ PLY_STORE_IDENTITY_NAME: undefined, PLY_STORE_REQUIRE_IDENTITY: '1' }); } catch { required = true; }
  t.ok('提出用（PLY_STORE_REQUIRE_IDENTITY=1）は仮の値で作らない', required);

  const manifest = fs.readFileSync(path.join(ROOT, 'build', placeholder.appx.customManifestPath), 'utf8');
  t.ok('manifest に App Execution Alias の Ply.exe がある', /<uap3:Extension Category="windows\.appExecutionAlias" Executable="\$\{executable\}"/.test(manifest) && /<desktop:ExecutionAlias Alias="Ply\.exe" \/>/.test(manifest));
  t.ok('manifest の差し込みは electron-builder の知っているものだけ',
    [...manifest.matchAll(/\$\{([a-zA-Z0-9]+)\}/g)].every(m => ['publisher', 'publisherDisplayName', 'version', 'applicationId', 'identityName', 'executable', 'displayName', 'description', 'backgroundColor', 'logo', 'square150x150Logo', 'square44x44Logo', 'lockScreen', 'defaultTile', 'splashScreen', 'arch', 'resourceLanguages', 'capabilities', 'extensions', 'minVersion', 'maxVersionTested'].includes(m[1])));
  const assets = fs.readdirSync(path.join(ROOT, 'build', 'appx'));
  t.ok('タイルの画像がそろっている', ['StoreLogo.png', 'Square44x44Logo.png', 'Square150x150Logo.png', 'Wide310x150Logo.png'].every(a => assets.includes(a)));
  t.ok('manifest は画像の置き場の外にある（build/appx/ の中は全部パッケージの assets に入る）', !assets.some(a => a.endsWith('.xml')));
}
