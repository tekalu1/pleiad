// Microsoft Store に出す MSIX（appx ターゲット）の設定（docs/microsoft-store.md）。
// GitHub Releases の NSIS（electron-builder.yml・electron-builder.release.cjs）とは別にする。Store が署名して配るので、ここでは署名しない。
// 自動更新は Store が行う。plyStore: true を焼き込み、更新フィード（publish・app-update.yml）は入れない（desktop/updates.cjs の updaterEnabled）
const fs = require('node:fs');
const path = require('node:path');
const { parse } = require('yaml');
const config = parse(fs.readFileSync(path.join(__dirname, 'electron-builder.yml'), 'utf8'));

// Partner Center が割り当てる値。「製品の管理」→「製品 ID」の Package/Identity/Name・Package/Identity/Publisher・
// Package/Properties/PublisherDisplayName を、そのまま環境変数で渡す。無ければ仮の値で作る（Store は受け付けない）
const PLACEHOLDER = { identityName: 'PleiadPlaceholder.Pleiad', publisher: 'CN=00000000-0000-0000-0000-000000000000', publisherDisplayName: 'Pleiad' };
const identity = {
  identityName: process.env.PLY_STORE_IDENTITY_NAME || PLACEHOLDER.identityName,
  publisher: process.env.PLY_STORE_PUBLISHER || PLACEHOLDER.publisher,
  publisherDisplayName: process.env.PLY_STORE_PUBLISHER_DISPLAY_NAME || PLACEHOLDER.publisherDisplayName,
  // Store で予約した名前。予約した名前と違うと提出で止まる
  displayName: process.env.PLY_STORE_DISPLAY_NAME || 'Pleiad',
};
if (!/^CN=/.test(identity.publisher)) throw new Error('PLY_STORE_PUBLISHER must start with CN= (Partner Center: Package/Identity/Publisher)');
if (process.env.PLY_STORE_REQUIRE_IDENTITY === '1' && identity.identityName === PLACEHOLDER.identityName) {
  throw new Error('PLY_STORE_IDENTITY_NAME / PLY_STORE_PUBLISHER are required for a Store upload');
}

module.exports = {
  ...config,
  win: { ...config.win, target: [{ target: 'appx', arch: ['x64', 'arm64'] }] },
  appx: {
    ...identity,
    // スタートメニューと App Execution Alias の Application Id。AUMID は <パッケージファミリー名>!Pleiad になる
    applicationId: 'Pleiad',
    backgroundColor: 'transparent',
    // 先頭が既定の言語。Store の掲載情報の言語と揃える（web/locales の ja・en）
    languages: ['ja-JP', 'en-US'],
    // uap3 の App Execution Alias を足した manifest（build/appx-manifest.xml）。タイルの画像は build/appx/
    customManifestPath: 'appx-manifest.xml',
    // ConPTY（node-pty）は 1809 以降。Windows 10 で更新が続いている 22H2（19045）を含む 2004（19041）からにする
    minVersion: '10.0.19041.0',
    maxVersionTested: '10.0.26100.0',
    // 中身は appx と同じ形式。Store はどちらの拡張子も受け付ける
    artifactName: 'Pleiad-${version}-store-${arch}.msix',
  },
  extraMetadata: { plyStore: true },
  publish: null,
};
