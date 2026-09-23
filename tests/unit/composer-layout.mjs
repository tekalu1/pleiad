// 入力欄と上端の見直し（承認済みのモック docs/mockups/phone-composer-header.html、docs/design-system.md「入力欄」「入力欄の設定」）。
//   - 字の欄の上限（マウス 10 行・タッチ 6 行・画面の 40%）、モデルのチップの「名前 · 段」の分け方
//   - 添付の出どころを選ばせる接続の判定（plyRemote・osActions === false）と札の出どころ
//   - ホストのファイルの面のパンくず・パスのつなぎ方
//   - 規則が載っているか（箱・1 行・チップの字をそろえる・700px 以下のタイトル行・塗りをやめた帯）。見た目は tests/browser と手で確かめる
import fs from 'node:fs';
import { promptMaxHeight, PROMPT_LINES, splitChipLabel, attachSources, attachOrigin, crumbs, joinPath } from '../../web/composer-layout.mjs';

export const name = 'composer-layout';
export const title = '入力欄と上端: 字の欄の上限・チップの字・添付の出どころ・パンくず・規則';

export default async function (t) {
  // ---- 字の欄の上限
  t.ok('上限の行数はマウス 10・タッチ 6', PROMPT_LINES.mouse === 10 && PROMPT_LINES.touch === 6);
  t.ok('マウス: 22.4px × 10 行 + 余白 12px', promptMaxHeight({ line: 22.4, pad: 12, touch: false, viewport: 2000 }) === 236);
  t.ok('タッチ: 24px × 6 行 + 余白 12px', promptMaxHeight({ line: 24, pad: 12, touch: true, viewport: 2000 }) === 156);
  t.ok('画面が低い（キーボード）ときは画面の 40% で止める', promptMaxHeight({ line: 24, pad: 12, touch: true, viewport: 300 }) === 120);
  t.ok('それでも 1 行より低くはしない', promptMaxHeight({ line: 24, pad: 12, touch: true, viewport: 50 }) === 36);

  // ---- モデルのチップ
  t.ok('「名前 · 段」は最後の区切りで分ける（段は削らない側）', JSON.stringify(splitChipLabel('Opus 5.5 · high')) === JSON.stringify({ head: 'Opus 5.5', tail: ' · high' }));
  t.ok('区切りが無ければ全部が名前', JSON.stringify(splitChipLabel('既定（agy の設定）')) === JSON.stringify({ head: '既定（agy の設定）', tail: '' }));
  t.ok('接続先 · モデル · 段は段だけを後ろに残す', splitChipLabel('OpenRouter · Kimi K2 · high').head === 'OpenRouter · Kimi K2');

  // ---- 添付の出どころ
  const HOST = 'trleh4p5diok2b3hxpcck5nsba';
  t.ok('デスクトップ版のリモートの窓: 選ばせる（フォルダーを送るも）', JSON.stringify(attachSources({ remote: { hostId: HOST, shell: 'desktop' } })) === '{"folder":true}');
  t.ok('モバイル版の殻: 選ばせる（フォルダーを送るは出さない）', JSON.stringify(attachSources({ remote: { hostId: HOST, shell: 'mobile' } })) === '{"folder":false}');
  t.ok('ホストの画面ではないブラウザー（osActions === false）: 選ばせる', JSON.stringify(attachSources({ osActions: false })) === '{"folder":false}');
  t.ok('ホストの画面（osActions === true）・まだ分からない: 選ばせない（クリップはすぐファイルを選ぶ）',
    attachSources({ osActions: true }) === null && attachSources({}) === null && attachSources({ remote: {}, osActions: undefined }) === null);
  const on = { folder: false };
  t.ok('札の出どころ: 印があればそれ', attachOrigin({ from: 'host' }, on) === 'host' && attachOrigin({ from: 'device' }, on) === 'device');
  t.ok('札の出どころ: 印の無い古い下書きは画像だけ端末', attachOrigin({ dataUri: 'data:image/png;base64,' }, on) === 'device' && attachOrigin({ path: 'x' }, on) === null);
  t.ok('札の出どころ: 選べない接続（ホストの画面）では付けない', attachOrigin({ from: 'host' }, null) === null);

  // ---- パンくず
  t.ok('Windows のパンくず: ドライブから', JSON.stringify(crumbs('D:\\dev\\pleiad')) === JSON.stringify([{ name: 'D:', path: 'D:\\' }, { name: 'dev', path: 'D:\\dev' }, { name: 'pleiad', path: 'D:\\dev\\pleiad' }]), JSON.stringify(crumbs('D:\\dev\\pleiad')));
  t.ok('Windows のドライブの根', JSON.stringify(crumbs('C:\\')) === JSON.stringify([{ name: 'C:', path: 'C:\\' }]));
  t.ok('POSIX のパンくず: / から', JSON.stringify(crumbs('/home/me')) === JSON.stringify([{ name: '/', path: '/' }, { name: 'home', path: '/home' }, { name: 'me', path: '/home/me' }]));
  t.ok('パスをつなぐ（区切りはパスに合わせる・根の区切りを重ねない）', joinPath('D:\\dev', 'a.txt') === 'D:\\dev\\a.txt' && joinPath('C:\\', 'x') === 'C:\\x' && joinPath('/', 'etc') === '/etc' && joinPath('/home/me', 'a') === '/home/me/a');

  // ---- 規則が載っているか
  const css = fs.readFileSync(new URL('../../web/style.css', import.meta.url), 'utf8');
  const html = fs.readFileSync(new URL('../../web/index.html', import.meta.url), 'utf8');
  const box = html.slice(html.indexOf('class="cbox"'), html.indexOf('id="cwdPop"'));
  t.ok('箱の中に 添付 → 字の欄 → チップと送信の行', box.indexOf('id="attached"') < box.indexOf('id="prompt"') && box.indexOf('id="prompt"') < box.indexOf('class="crow"')
    && ['id="attach"', 'id="cwdChip"', 'id="modelChip"', 'id="modeChip"', 'id="abort"', 'id="send"', 'id="draftSaved"'].every(k => box.includes(k)));
  t.ok('字の欄は 1 行から', /id="prompt"[^>]*rows="1"/.test(html));
  t.ok('作業ディレクトリのチップは等幅にしない（逸脱 a）', /id="cwdChip"/.test(html) && !/class="chip mono/.test(html) && !/\.chip\.mono\{/.test(css));
  t.ok('チップの行は折り返さない（700px 以下の flex-wrap:wrap を外した）', /\.crow\{[^}]*flex-wrap:nowrap/.test(css) && !/\.crow\{flex-wrap:wrap\}/.test(css));
  const chip = /\n\.chip\{([^}]*)\}/.exec(css)?.[1] ?? '';
  t.ok('チップは 3 つとも同じ字（本文の書体・14px・400）と高さ 30px・余白 0 8px', /font:400 var\(--fs\)\/1\.5 var\(--font\)/.test(chip) && /height:30px/.test(chip) && /padding:0 8px/.test(chip), chip);
  t.ok('YOLO は太字にしない（逸脱 b）', /\.chip\.danger\{color:var\(--ink-strong\)\}/.test(css) && !/\.chip\.danger\{[^}]*font-weight/.test(css));
  t.ok('1 行に収める順: 承認モードの短い名前 → モデルの段を外す → モデル名 → 作業ディレクトリ（fitRow の印と縮める比）',
    /\.crow\.fit-short \.chip\.mode \.v \.short\{display:inline\}/.test(css) && /\.crow\.fit-noef \.chip \.v \.ef\{display:none\}/.test(css)
      && /\.crow\.measuring > \*\{flex-shrink:0\}/.test(css) && /\.chip\.model\{flex-shrink:20\}/.test(css) && /\.chip\.folder\{flex-shrink:1\}/.test(css) && /\.chip\.mode\{flex-shrink:0\}/.test(css));
  const controlsSrc = fs.readFileSync(new URL('../../web/composer-controls.mjs', import.meta.url), 'utf8');
  t.ok('名前の最小の幅は作業ディレクトリ 9 字・モデル 6 字から段々に下げる', /\[\[9, 6\], \[7, 4\], \[5, 3\], \[3, 2\]\]/.test(controlsSrc) && /fit-short/.test(controlsSrc) && /fit-noef/.test(controlsSrc));
  t.ok('タッチではチップも 36px', /@media \(pointer:coarse\)\{[^@]*\.chip\{height:36px\}/s.test(css));
  t.ok('480px 以下は ▾ を省き、中断はアイコンだけ', /@media \(max-width:480px\)\{[^@]*\.chip svg\.caret\{display:none\}[^@]*\.abort span\{display:none\}/s.test(css));
  t.ok('700px 以下は「保存済み」を出さない（失敗だけ出す）', /\.crow \.draft-saved:not\(\[data-state=failed\]\)\{display:none\}/.test(css));
  t.ok('700px 以下は ✦ を隠し、コンテキストをアイコン + 数字に', /#titleWand\{display:none\}/.test(css) && /\.ctxlink > span:not\(\.n,\.chg\)\{display:none\}/.test(css));
  t.ok('モバイル版の殻の 700px 以下はタイトルの下の添え字（帯は 701px 以上だけ）', /@media \(max-width:700px\)\{[^@]*:root\.remote-mobile \.host-sub\{display:inline-flex\}/s.test(css)
    && /@media \(min-width:701px\)\{[^@]*:root\.remote-mobile \.host-bar\{display:flex/s.test(css));
  t.ok('リモートの帯を塗らない（--fill-primary を帯・殻の帯に使わない）', !/:root\.remote \.titlebar\{[^}]*fill-primary/.test(css) && !/\.host-bar\{[^}]*fill-primary/.test(css)
    && /:root\.desktop\.remote body > \.titlebar\{background:var\(--surface-0\)/.test(css));
  t.ok('リモートの窓の 701px 以上はタイトル行を帯に上げる', /@media \(min-width:701px\)\{[^@]*:root\.desktop\.remote:not\(\.remote-mobile\) body > main > \.top\{position:fixed;top:0/s.test(css));
}
