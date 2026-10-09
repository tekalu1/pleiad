// モバイルのアイコン・スプラッシュ: 置いてある PNG が SVG からの再生成と一致し、Android・iOS の宣言が揃っている（Android Studio・Xcode 不要）。
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const name = 'mobile-icons';
export const title = 'モバイルのアイコン: 生成物が SVG と一致・テーマアイコン・暗いスプラッシュの宣言';
const root = fileURLToPath(new URL('../../', import.meta.url));
const read = p => fs.readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');
const RES = 'mobile/android/app/src/main/res';

export default async function (t) {
  const r = spawnSync(process.execPath, ['mobile/scripts/generate-icons.mjs', '--check'], { cwd: root, encoding: 'utf8' });
  t.ok(`生成スクリプトの --check が通る（古い PNG・足りない PNG が無い）${r.status === 0 ? '' : `: ${r.stdout}${r.stderr}`}`, r.status === 0);

  for (const f of ['ic_launcher', 'ic_launcher_round']) {
    const xml = read(`${RES}/mipmap-anydpi-v26/${f}.xml`);
    t.ok(`${f}: 前景・地に加えて monochrome（Android 13 のテーマアイコン）を宣言`,
      xml.includes('@mipmap/ic_launcher_foreground') && xml.includes('<monochrome android:drawable="@mipmap/ic_launcher_monochrome"/>'));
  }
  t.ok('adaptive の地は favicon・デスクトップと同じ #3a499e', /#3a499e/i.test(read(`${RES}/values/ic_launcher_background.xml`)));
  t.ok('使われていない雛形のアイコンを残さない', !fs.existsSync(new URL(`../../${RES}/drawable/ic_launcher_background.xml`, import.meta.url))
    && !fs.existsSync(new URL(`../../${RES}/drawable-v24/ic_launcher_foreground.xml`, import.meta.url)));
  t.ok('通知の小アイコンは P の線画のまま', fs.existsSync(new URL(`../../${RES}/drawable/ic_stat_pleiad.xml`, import.meta.url)));

  const contents = JSON.parse(read('mobile/ios/App/App/Assets.xcassets/Splash.imageset/Contents.json'));
  const dark = contents.images.filter(i => i.appearances?.some(a => a.appearance === 'luminosity' && a.value === 'dark'));
  const light = contents.images.filter(i => !i.appearances);
  t.ok('iOS の Splash は 1x/2x/3x の明・暗が揃う', dark.length === 3 && light.length === 3
    && ['1x', '2x', '3x'].every(s => dark.some(i => i.scale === s) && light.some(i => i.scale === s)));
  t.ok('iOS の Splash の宣言したファイルが全部ある', contents.images.every(i => fs.existsSync(
    new URL(`../../mobile/ios/App/App/Assets.xcassets/Splash.imageset/${i.filename}`, import.meta.url))));
}
