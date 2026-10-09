// iOS の殻が共通画面へ渡す API と、ホストの JS の実際の振る舞い（Xcode 不要）。
import fs from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

export const name = 'ios-shell';
export const title = 'iOS の殻: JS の受け渡し・フレーム境界・プラグイン API・ビルド対象';
const read = p => fs.readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');
const APP = 'mobile/ios/App/App';

export default async function (t) {
  const template = read(`${APP}/plyremote.js`);
  const info = { hostId: 'host', hostName: '机"\n</script>', relay: 'https://relay.example', device: 'iPad' };
  const source = template.replaceAll('__PLY_ORIGIN__', JSON.stringify('http://127.0.0.1:51234'))
    .replaceAll('__PLY_RECEIVER__', JSON.stringify('__receive')).replaceAll('__PLY_INFO__', JSON.stringify(info));
  function load({ origin = 'http://127.0.0.1:51234', frame = false, opener = false } = {}) {
    const sent = [];
    const w = { origin, opener, webkit: { messageHandlers: { plyRemoteBridge: { postMessage: s => sent.push(JSON.parse(s)) } } } };
    w.top = frame ? {} : w;
    vm.runInNewContext(source, { window: w });
    return { w, sent };
  }
  const { w, sent } = load();
  t.ok('ホスト名の引用符・改行を壊さず渡す', w.plyRemote.hostName === info.hostName);
  t.ok('開いたら hello を一度送る', sent.length === 1 && sent[0].type === 'hello');
  t.ok('API は書換え・再定義できない', Object.isFrozen(w.plyRemote) && !Object.getOwnPropertyDescriptor(w, 'plyRemote').configurable);
  t.ok('初期状態は未受信', await w.plyRemote.status() === null);
  let received = 0;
  const off = w.plyRemote.onStatus(() => { received++; });
  w.plyRemote.onStatus(() => { throw new Error('listener'); });
  w.__receive('{broken');
  w.__receive(JSON.stringify({ type: 'status', status: { state: 'connected' } }));
  t.ok('状態を記憶し、他の購読の例外で止まらない', received === 1 && (await w.plyRemote.status()).state === 'connected');
  off();
  w.__receive(JSON.stringify({ type: 'status', status: { state: 'offline' } }));
  t.ok('購読を解除できる', received === 1 && (await w.plyRemote.status()).state === 'offline');
  await w.plyRemote.retry();
  w.plyRemote.setTheme(true, { top: '#123456', bottom: '#abcdef' });
  w.backToHosts();
  w.plyRemote.closeWindow();
  t.ok('操作がネイティブの受ける形になる', JSON.stringify(sent.slice(1)) === JSON.stringify([
    { type: 'retry' }, { type: 'theme', dark: true, top: '#123456', bottom: '#abcdef' }, { type: 'back' }, { type: 'back' },
  ]));
  for (const options of [{ origin: 'https://evil.example' }, { origin: 'null' }, { frame: true }, { opener: {} }]) {
    const blocked = load(options);
    t.ok(`外部・子フレーム・別窓に API を渡さない ${JSON.stringify(options)}`, !blocked.w.plyRemote && blocked.sent.length === 0);
  }
  const plugin = read(`${APP}/PleiadRemotePlugin.swift`);
  const methods = [...plugin.matchAll(/CAPPluginMethod\(name: "([^"]+)"/g)].map(m => m[1]).sort();
  const android = read('mobile/android/app/src/main/kotlin/dev/pleiad/app/PleiadRemotePlugin.kt');
  const expected = [...android.matchAll(/@PluginMethod(?:\([^\n]*\))?\s+fun (\w+)/g)].map(m => m[1]).filter(n => !n.startsWith('notify')).sort();
  t.ok('通知以外の Android の API が揃う', JSON.stringify(methods) === JSON.stringify(expected), JSON.stringify(methods));
  t.ok('公開メソッドに実装がある', methods.every(n => plugin.includes(`@objc func ${n}(`)));
  const scanner = read(`${APP}/QRScannerPlugin.swift`);
  const www = read('mobile/www/app.js');
  const scannerCalls = [...www.matchAll(/Scanner\.(\w+)\(/g)].map(m => m[1]);
  t.ok('www のスキャナー呼出しをそのまま受ける', scannerCalls.every(n => scanner.includes(`CAPPluginMethod(name: "${n}"`)));
  const host = read(`${APP}/HostViewController.swift`);
  t.ok('ネイティブでも窓・main frame・オリジンを確認する', host.includes('message.webView === web') && host.includes('message.frameInfo.isMainFrame') && host.includes('message.frameInfo.securityOrigin') && host.includes('== origin') && !host.includes('import Capacitor'));
  const pbx = read('mobile/ios/App/App.xcodeproj/project.pbxproj');
  const dir = fileURLToPath(new URL(`../../${APP}/`, import.meta.url));
  t.ok('殻の Swift ファイルをすべてビルドに登録する', fs.readdirSync(dir).filter(n => n.endsWith('.swift')).every(n => pbx.includes(`${n} in Sources`)));
  t.ok('CLI の生成物と別に remote-core を取り込む', pbx.includes('relativePath = "../remote-core"') && pbx.includes('PleiadRemote in Frameworks'));
  const plist = read(`${APP}/Info.plist`);
  t.ok('カメラの用途・URL スキーム・ローカル通信を宣言し任意の平文を許さない', plist.includes('NSCameraUsageDescription') && plist.includes('<string>pleiad</string>') && plist.includes('NSAllowsLocalNetworking') && !plist.includes('NSAllowsArbitraryLoads'));
  const pkg = JSON.parse(read('mobile/package.json'));
  const spm = read('mobile/ios/App/CapApp-SPM/Package.swift');
  t.ok('Capacitor の版が npm と SPM で一致する', pkg.dependencies['@capacitor/ios'] === pkg.dependencies['@capacitor/core'] && spm.includes(`exact: "${pkg.dependencies['@capacitor/ios']}"`));
}
