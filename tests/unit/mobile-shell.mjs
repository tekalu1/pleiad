// モバイル版の殻（mobile/、issue #16・docs/remote.md §8.2・§8.3）の取り決め。Android のビルドはしない（Gradle は
// mobile/android の JVM の試験が受け持つ）。ここでは web/ と殻の間の約束と、殻の設定の守りを文字列で確かめる。
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { remoteInfo, badgeView } from '../../web/remote-badge.mjs';

export const name = 'mobile-shell';
export const title = 'モバイルの殻: plyRemote の形・平文はループバックだけ・依存の版の固定・殻の辞書';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
const APP = 'mobile/android/app/src/main';

export default async function (t) {
  // ---- plyRemote（HostActivity が入れるもの）を web/remote-badge.mjs が読める
  const host = read(`${APP}/kotlin/com/procway/pleiad/HostActivity.kt`);
  const script = host.slice(host.indexOf('private fun remoteScript'), host.indexOf('private fun pushStatus'));
  const keys = ['hostId:', 'hostName:', 'relay:', 'device:', "shell: 'mobile'", 'status:', 'onStatus:', 'retry:', 'backToHosts:', 'closeWindow:'];
  t.ok('plyRemote に web/ が使う口がそろう（status・onStatus・retry・closeWindow・backToHosts・shell: mobile）',
    keys.every(k => script.includes(k)), keys.filter(k => !script.includes(k)).join(', '));
  t.ok('plyRemote は凍結し、書き換え・再定義できない', script.includes('Object.freeze') && /writable: false, configurable: false/.test(script));
  t.ok('注入は殻のプロキシのオリジンだけ（本体フレームの確認つき）。Capacitor のブリッジは使わない',
    /addDocumentStartJavaScript\(w, remoteScript\(info\), setOf\(origin\)\)/.test(host) && /addWebMessageListener\(w, BRIDGE, setOf\(origin\)\)/.test(host)
      && /!isMainFrame \|\| sourceOrigin\.toString\(\) != origin/.test(host) && !/com\.getcapacitor/.test(host));
  t.ok('window.backToHosts も plyRemote.backToHosts と同じものを入れる（再定義できない）', /defineProperty\(window, 'backToHosts', \{ value: api\.backToHosts, writable: false, configurable: false/.test(script));
  t.ok('ホストの窓は edge-to-edge（安全領域は web/ の env() が受け持つ。状態バーの記号は明るく）', /isAppearanceLightStatusBars = false/.test(host) && /setDecorFitsSystemWindows\(window, false\)/.test(host));
  t.ok('戻るボタンはまず画面に plyremote:back（取り消せる）を投げる', /new CustomEvent\('plyremote:back', \{ cancelable: true \}\)/.test(host));
  const info = remoteInfo({ hostId: 'trleh4p5diok2b3hxpcck5nsba', hostName: 'desk', relay: 'https://relay.example', device: 'Pixel', shell: 'mobile' });
  t.ok('remoteInfo はモバイルの形を受ける（shell: mobile）', info?.shell === 'mobile' && info.host === 'desk');
  t.ok('殻の状態の名前はバッジの状態と同じ（revoked）', badgeView(info, { state: 'revoked' }).state === 'revoked');

  // ---- 平文はループバックだけ・バックアップしない
  const nsc = read(`${APP}/res/xml/network_security_config.xml`);
  t.ok('network_security_config: 既定は平文禁止、127.0.0.1 だけ許す（サブドメインなし）',
    /<base-config cleartextTrafficPermitted="false">/.test(nsc) && /<domain-config cleartextTrafficPermitted="true">\s*<domain includeSubdomains="false">127\.0\.0\.1<\/domain>\s*<\/domain-config>/.test(nsc)
      && (nsc.match(/<domain /g) ?? []).length === 1 && !/src="user"/.test(nsc));
  const manifest = read(`${APP}/AndroidManifest.xml`);
  t.ok('Manifest: networkSecurityConfig・allowBackup=false・HostActivity は外から開けない',
    /android:networkSecurityConfig="@xml\/network_security_config"/.test(manifest) && /android:allowBackup="false"/.test(manifest)
      && /android:name="\.HostActivity"[\s\S]*?android:exported="false"/.test(manifest));

  // ---- 依存の版の固定・ルートに Capacitor を入れない
  const pkg = JSON.parse(read('mobile/package.json'));
  const all = { ...pkg.dependencies, ...pkg.devDependencies };
  t.ok('mobile/package.json の依存は版を固定する（^ ~ なし）', Object.values(all).every(v => /^\d+\.\d+\.\d+$/.test(v)), JSON.stringify(all));
  const root = JSON.parse(read('package.json'));
  t.ok('ルートの package.json に Capacitor を入れない', !Object.keys({ ...root.dependencies, ...root.devDependencies }).some(k => k.startsWith('@capacitor')));
  const vars = read('mobile/android/variables.gradle');
  t.ok('最低の版は Android 13（API 33。標準の XDH が使える最初の版）', /minSdkVersion = 33\b/.test(vars));
  const x = read('mobile/android/remote-core/src/main/kotlin/com/procway/pleiad/remote/X25519.kt');
  t.ok('X25519 は標準の XDH だけ（自前の実装を持たない）', /KeyAgreement\.getInstance\("XDH"\)/.test(x) && !/scalarMult|car25519|Portable/.test(x));

  // ---- 殻の辞書（mobile/www/i18n.js）の ja と en がそろう
  const sandbox = { navigator: { language: 'ja' }, document: { documentElement: {} }, window: {}, Intl };
  vm.runInNewContext(read('mobile/www/i18n.js'), sandbox);
  const { dict, t: tr } = sandbox.window.shellI18n;
  const ja = Object.keys(dict.ja).sort(), en = Object.keys(dict.en).sort();
  t.ok('殻の辞書の ja と en のキーがそろう', JSON.stringify(ja) === JSON.stringify(en), ja.filter(k => !en.includes(k)).concat(en.filter(k => !ja.includes(k))).join(', '));
  const app = read('mobile/www/app.js') + read('mobile/www/index.html');
  const used = [...app.matchAll(/(?:t\(|data-t(?:-label|-placeholder)?=)['"`]([a-z-]+\.[\w.-]+)['"`]/g)].map(m => m[1]);
  t.ok('殻の画面が使うキーは辞書にある', used.length > 10 && used.every(k => k in dict.en), used.filter(k => !(k in dict.en)).join(', '));
  const codes = ['payload', 'relay-url', 'denied', 'expired', 'ticket', 'rate', 'host-offline', 'offline', 'cancelled', 'aborted', 'timeout', 'handshake', 'bad-response', 'storage', 'unknown-host', 'internal'];
  t.ok('ネイティブが返す失敗のコードはどれも殻で訳せる', codes.every(c => `err.${c}` in dict.en && `err.${c}` in dict.ja));
  t.ok('殻の文言の差し込み', tr('pair.approveOn', { host: 'desk' }) === 'desk の画面で承認してください');
}
