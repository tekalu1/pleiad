// ファイルの操作メニュー（docs/design-system.md「ファイルの操作」）。
// ⋯ ボタン・右クリック・Shift+F10 のどれでも同じ中身を開く。場所（右パネルの頭・ツリー・画像・会話のリンク）で変えない。
// 開くのは web/client.mjs の showMenu（会話一覧と同じ 1 つのメニュー。2 つ持つと同時に開きうる）。
// OS の操作（エクスプローラー・ブラウザー）はサーバーのある PC の画面から見ているときだけ出す。
// 出さないだけでなく、サーバーも断る（core/server.mjs の revealPath / openPath）。
import { el } from './dom.mjs';
import { t } from './i18n.mjs';

const isHtml = path => /\.html?$/i.test(String(path ?? ''));

/**
 * メニューの項目。run(action) が実際の操作をする（file-preview.mjs）。
 * @param {{ path:string, kind?:'file'|'directory'|null }} target
 * @param {{ osActions:boolean, current?:boolean, canUse?:boolean, run:(action:string)=>void }} env
 *   current は右パネルに今出ているファイル（「右パネルで開く」を出さない）
 */
export function fileMenuItems(target, { osActions, current = false, canUse = true, run }) {
  const directory = target.kind === 'directory';
  const item = (label, action) => ({ label, onClick: () => run(action) });
  const groups = [
    [
      !current && item(t('files.menu.openInPanel'), 'panel'),
      osActions && !directory && isHtml(target.path) && item(t('files.menu.openInBrowser'), 'browser'),
      osActions && item(directory ? t('files.menu.revealFolder') : t('files.menu.revealFile'), 'reveal'),
    ],
    [item(t('files.menu.copyPath'), 'copy'), item(t('files.menu.copyRelative'), 'copyRelative')],
    directory ? [] : [item(t('files.menu.save'), 'save'), canUse && item(t('files.menu.use'), 'use')],
  ].map(group => group.filter(Boolean)).filter(group => group.length);
  return groups.flatMap((group, i) => (i ? [{ sep: true }, ...group] : group));
}

/**
 * 会話に保存された可視化の操作メニュー（右パネルの ⋯。docs/design-system.md「右パネルの枠」）。
 * 対象は元のパス（origin）。元が分からなければパス・元のファイル・会話で使うは出さない。
 * 並びはファイルと同じ考え方: 写す → 開く → 持ち出す。run(action) は web/file-preview.mjs
 * @param {{ origin?:string|null }} target
 * @param {{ osActions:boolean, canUse?:boolean, canBrowse?:boolean, run:(action:string)=>void }} env
 */
export function visualizationMenuItems({ origin = null } = {}, { osActions, canUse = true, canBrowse = true, run }) {
  const item = (label, action) => ({ label, onClick: () => run(action) });
  const groups = [
    origin ? [item(t('files.menu.copyOriginPath'), 'copy'), item(t('files.menu.copyRelative'), 'copyRelative')] : [],
    [
      canBrowse && item(t('files.menu.openInBrowser'), 'browser'),
      origin && item(t('files.menu.openOrigin'), 'origin'),
      origin && osActions && item(t('files.menu.revealFile'), 'reveal'),
    ],
    [item(t('files.menu.saveHtml'), 'saveHtml'), origin && canUse && item(t('files.menu.use'), 'use')],
  ].map(group => group.filter(Boolean)).filter(group => group.length);
  return groups.flatMap((group, i) => (i ? [{ sep: true }, ...group] : group));
}

/**
 * パスをクリップボードへ写し、短い知らせを出す。relative は相対パスか（知らせの文言だけが違う）。
 * 右パネルの ⋯・会話の可視化のカードが同じものを使う（挙動と文言をそろえる）
 */
export async function copyPathText(text, relative = false) {
  try { await navigator.clipboard.writeText(text); notify(relative ? t('files.copiedRelative') : t('files.copiedPath')); }
  catch { notify(relative ? t('files.copyRelativeFailed') : t('files.copyPathFailed')); }
}

/** 作業ディレクトリからの相対パス。外にあれば null */
export function relativeTo(path, cwd) {
  if (!path || !cwd) return null;
  const norm = s => String(s).replaceAll('\\', '/').replace(/\/+$/, '');
  const p = norm(path), base = norm(cwd);
  const windows = /^[a-z]:\//i.test(p);
  const same = (a, b) => (windows ? a.toLowerCase() === b.toLowerCase() : a === b);
  if (same(p, base)) return '.';
  if (!same(p.slice(0, base.length + 1), `${base}/`)) return null;
  const rel = p.slice(base.length + 1);
  return windows ? rel.replaceAll('/', '\\') : rel;
}

/** 同じファイルか（区切りの違い、Windows の大文字小文字を無視する） */
export function samePath(a, b) {
  if (!a || !b) return false;
  const norm = s => String(s).replaceAll('\\', '/').replace(/\/+$/, '');
  const x = norm(a), y = norm(b);
  return /^[a-z]:\//i.test(x) ? x.toLowerCase() === y.toLowerCase() : x === y;
}

let toastTimer;
/**
 * 短い知らせ（コピーした・開けなかった）。数秒で消える。
 * 拡大表示（モーダルの dialog）が開いていればその中に出す（外に出すと背景の幕の下に隠れる）
 */
export function notify(text) {
  const host = document.querySelector('dialog[open]') ?? document.body;
  let box = document.querySelector('.file-toast');
  if (!box) { box = el('div', 'file-toast'); box.setAttribute('role', 'status'); }
  if (box.parentNode !== host) host.append(box);
  box.textContent = text; box.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { box.hidden = true; }, 4000);
}

/** ダウンロードを始める（<a download> を押すのと同じ）。殻でもブラウザーでも既定のダウンロードになる */
export function download(href, name = '') {
  const a = el('a'); a.href = href; a.download = name; a.hidden = true;
  document.body.append(a); a.click(); a.remove();
}
