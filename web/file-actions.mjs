// ファイルの操作メニュー（docs/mockups/file-actions.html §2）。
// ⋯ ボタン・右クリック・Shift+F10 のどれでも同じ中身を開く。場所（右パネルの頭・ツリー・画像・会話のリンク）で変えない。
// 開くのは web/client.mjs の showMenu（会話一覧と同じ 1 つのメニュー。2 つ持つと同時に開きうる）。
// OS の操作（エクスプローラー・ブラウザー）はサーバーのある PC の画面から見ているときだけ出す。
// 出さないだけでなく、サーバーも断る（core/server.mjs の revealPath / openPath）。
import { el } from './dom.mjs';

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
      !current && item('右パネルで開く', 'panel'),
      osActions && !directory && isHtml(target.path) && item('ブラウザーで開く', 'browser'),
      osActions && item(directory ? 'エクスプローラーで開く' : 'エクスプローラーで表示', 'reveal'),
    ],
    [item('パスをコピー', 'copy'), item('相対パスをコピー', 'copyRelative')],
    directory ? [] : [item('保存', 'save'), canUse && item('会話で使う', 'use')],
  ].map(group => group.filter(Boolean)).filter(group => group.length);
  return groups.flatMap((group, i) => (i ? [{ sep: true }, ...group] : group));
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
