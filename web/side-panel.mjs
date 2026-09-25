// 右パネルの枠（docs/mockups/side-panel-shell.html「提案」）。ファイル・可視化・会話のコンテキストが同じ 1 つの枠を使う。
// どのモードで何を出すかは、ここの *Slots だけが決める。枠（applySlots）は渡された部品だけを並べ、
// **渡されなかった部品は必ず隠す**。モードごとに出したり消したりを書き足すと、前のモードの部品が残る
// （可視化にエクスプローラーの枠が残った不具合。docs/design-system.md「右パネル」）。
// 部品は名前（id）で指す。実際のボタンは web/file-preview.mjs が 1 度だけ作り、ここへ渡す。
import { t } from './i18n.mjs';

/**
 * ファイル。取得の前後で呼び直す（⋯・ブラウザーで開く・エクスプローラーで表示・保存は取得できてから）。
 * @param {{ file?:object|null, osActions?:boolean }} s
 */
export function fileSlots({ file = null, osActions = false } = {}) {
  const local = osActions && !!file;
  return {
    mode: 'file',
    label: t('filePreview.panel'),
    kind: t('filePreview.mode.file'),
    head: ['tree', file && 'more', 'wide', 'close'].filter(Boolean),
    views: !!file && typeof file.text === 'string' && file.kind !== 'text' && file.kind !== 'directory',
    // HTML の「ブラウザーで開く」は切り替えのすぐ右（可視化と同じ位置）
    toolbar: [local && file.kind === 'html' && 'browser', 'path', 'reload'].filter(Boolean),
    aside: true,
    footer: ['reveal', 'save', 'use'].filter(id => (id === 'reveal' ? local : id === 'save' ? !!file?.downloadable : true)),
  };
}

/**
 * 会話に保存された可視化（写し）。元のパス（origin）はホスト上の在り処で、分かるときだけ
 * パス・元のファイルを開く・会話で使うを出す。ツリーは中身が無いので出さない。
 * @param {{ origin?:string|null, html?:unknown, canBrowse?:boolean, canUse?:boolean }} s
 *   canBrowse は写しをサーバーから引けるか（会話と記録の印が分かる）
 */
export function visualizationSlots({ origin = null, html = '', canBrowse = true, canUse = true } = {}) {
  return {
    mode: 'visualization',
    label: t('filePreview.visualPanel'),
    kind: t('filePreview.mode.visualization'),
    head: ['more', 'wide', 'close'],
    views: typeof html === 'string',
    toolbar: [canBrowse && 'visualBrowser', origin && 'path', origin && 'origin'].filter(Boolean),
    aside: false,
    note: origin ? t('filePreview.visual.note') : '',
    footer: ['visualSave', origin && canUse && 'use'].filter(Boolean),
  };
}

/** ファイル以外の中身（この会話のコンテキスト）。見出しと本文と閉じるだけ */
export function customSlots({ label = '' } = {}) {
  return { mode: 'custom', label, kind: '', head: ['close'], views: false, toolbar: [], aside: false, footer: null };
}

/**
 * 見出しの下の行。作業ディレクトリの中なら相対、外ならそのまま（区切りは / にそろえる。ファイルと同じ）。
 * 元が無い可視化は、会話に保存された表示であることを書く
 */
export function subtitleFor(path, cwd, fallback = '') {
  if (!path) return fallback;
  const normalized = String(path).replaceAll('\\', '/');
  const base = String(cwd ?? '').replaceAll('\\', '/').replace(/\/+$/, '');
  if (!base) return normalized;
  const windows = /^[a-z]:\//i.test(normalized);
  const head = normalized.slice(0, base.length + 1);
  const inside = windows ? head.toLowerCase() === `${base}/`.toLowerCase() : head === `${base}/`;
  return inside ? normalized.slice(base.length + 1) : normalized;
}

/**
 * 設定を枠に当てる。parts は枠の要素と、id ごとのボタン（parts.buttons）。
 * config = 上の *Slots の結果 + { title, subtitle, note, status, statusTitle, body }
 * 並びは設定の順。設定に無い部品は DOM から外すか隠す
 */
export function applySlots(parts, config) {
  const pick = ids => (ids ?? []).map(id => parts.buttons[id]).filter(Boolean);
  parts.panel.dataset.mode = config.mode;
  parts.panel.classList.toggle('custom', config.mode === 'custom');
  parts.panel.setAttribute('aria-label', config.label ?? '');
  if (config.title !== undefined) parts.name.textContent = config.title;
  if (config.subtitle !== undefined) parts.path.textContent = config.subtitle;
  parts.kind.textContent = config.kind ?? '';
  parts.kind.hidden = !config.kind;
  parts.actions.replaceChildren(...pick(config.head));
  parts.switcher.hidden = !config.views;
  parts.tools.replaceChildren(...pick(config.toolbar));
  parts.toolbar.hidden = !config.views && !config.toolbar?.length;
  // パスの行は「パス」を押したときだけ開く。「パス」が無いモードでは必ず閉じる
  if (!config.toolbar?.includes('path')) parts.location.hidden = true;
  if (config.note !== undefined) { parts.note.textContent = config.note; parts.note.hidden = !config.note; }
  parts.treePane.hidden = !config.aside;
  parts.footer.hidden = !config.footer;
  parts.footActions.replaceChildren(...pick(config.footer));
  if (config.status !== undefined) parts.status.textContent = config.status;
  if (config.statusTitle !== undefined) parts.status.title = config.statusTitle;
  if (config.body) parts.content.replaceChildren(config.body);
}
