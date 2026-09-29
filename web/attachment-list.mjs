// 添付の一覧の面（docs/design-system.md「添付の一覧」、ADR 0059）。
// デスクトップは動線（呼び出したボタン）の近くに浮く面、700px 以下は下からのシート。native の <dialog>（showModal）なので、
// Tab は面の中に留まり、Esc で閉じ、閉じたら呼び出したボタンへフォーカスを戻す。
//
// 送信後の発言（web/user-message.mjs）は読み取り用（開く・パスをコピー）。段階 2 の入力欄は同じ面に、行の操作
// （文中の位置へ移動・外す）と、送信中の進み具合・区分（文中の添付 / 文末に付く）を差し替えて出す。
// そのため行の操作は actions(item) で渡し、行の中身は items の欄（status・progress・section）で決める。更新は update(items)。
import { el } from './dom.mjs';
import { t } from './i18n.mjs';
import { formatBytes } from './folder-upload.mjs';
import { fileIcon } from './icons.mjs';

// i18n-dynamic: chat.attachList.origin.
const ORIGIN_MARK = { host: '⇄', device: '▯' };
let open = null;

/**
 * 一覧の行（items）:
 *   id        行の印（actions・update が使う）
 *   kind      'image' | 'file'
 *   name      名前
 *   path      パス（等幅・弱い字。無ければ出さない）
 *   thumb     画像の縮小の src（画像だけ。無ければ札のアイコン）
 *   origin    'host' | 'device' | null（分かるときだけ）
 *   size      バイト数 | null（分かるときだけ）
 *   status    弱い字で添える一語（「送信済み」「送信中」など）| null
 *   progress  0〜100 | null（送信中の進み具合。あれば細い棒を出す）
 *   section   区分の見出し（前の行と違うときだけ行の上に出す）| null
 * actions(item) は [{ label, run(item), keepOpen? }]。押すと面を閉じてから run する（keepOpen は閉じない）。
 * @returns {{ close(): void, update(items: object[]): void, dialog: HTMLDialogElement }}
 */
export function openAttachmentList({ anchor = null, title, items = [], actions = () => [], onClose = null }) {
  open?.close();
  const dialog = el('dialog', 'att-list');
  const titleId = `attListTitle${Math.random().toString(36).slice(2, 8)}`;
  dialog.setAttribute('aria-labelledby', titleId);
  const inner = el('div', 'att-list-in');
  const head = el('div', 'att-list-head');
  const heading = el('h3', null, title);
  heading.id = titleId;
  const closeButton = el('button', 'btn btn-quiet att-list-close');
  closeButton.type = 'button';
  closeButton.append(el('span', null, t('chat.attachList.close')), el('span', null, '×'));
  closeButton.lastChild.setAttribute('aria-hidden', 'true');
  head.append(heading, closeButton);
  const body = el('div', 'att-list-body');
  inner.append(el('div', 'att-list-handle'), head, body);
  dialog.append(inner);

  let list = items;
  const close = () => { if (dialog.open) dialog.close(); };
  const paint = () => {
    let section = null;
    body.replaceChildren(...list.flatMap(item => {
      const rows = [];
      if (item.section && item.section !== section) rows.push(el('div', 'att-list-caption', item.section));
      section = item.section ?? section;
      rows.push(row(item, actions(item), close));
      return rows;
    }));
  };
  paint();

  closeButton.onclick = close;
  // ダイアログ自身が click の対象になるのは背後の覆いを押したときだけ（中身は inner が覆う）
  dialog.addEventListener('click', event => { if (event.target === dialog) close(); });
  dialog.addEventListener('close', () => {
    if (open?.dialog === dialog) open = null;
    dialog.remove();
    // 閉じたら呼び出したボタンへ戻す。ただし「開く」で右パネルなどが先にフォーカスを取っていれば奪わない
    const active = document.activeElement;
    if (anchor?.isConnected && (!active || active === document.body || dialog.contains(active))) anchor.focus?.({ preventScroll: true });
    onClose?.();
  });
  document.body.append(dialog);
  dialog.showModal();
  place(dialog, anchor);
  (dialog.querySelector('.att-list-row button') ?? closeButton).focus?.({ preventScroll: true });
  open = { dialog, close };
  return {
    dialog, close,
    update(next) { list = next; paint(); place(dialog, anchor); },
  };
}

function row(item, actions, close) {
  const r = el('div', 'att-list-row');
  r.dataset.id = item.id;
  if (item.thumb) {
    const img = el('img', 'att-list-thumb');
    img.src = item.thumb; img.alt = ''; img.loading = 'lazy';
    r.append(img);
  } else {
    const mark = el('span', 'att-list-file');
    mark.innerHTML = fileIcon;
    r.append(mark);
  }
  const copy = el('div', 'att-list-copy');
  copy.append(el('b', 'att-list-name', item.name));
  const meta = [item.origin ? `${ORIGIN_MARK[item.origin] ?? ''} ${t(`chat.attachList.origin.${item.origin}`)}`.trim() : null,
    item.size ? formatBytes(item.size) : null, item.status].filter(Boolean);
  if (meta.length) copy.append(el('small', 'att-list-meta', meta.join(' · ')));
  if (item.progress != null) {
    const bar = el('span', 'att-list-bar');
    bar.setAttribute('role', 'progressbar');
    bar.setAttribute('aria-valuenow', String(Math.round(item.progress)));
    bar.setAttribute('aria-valuemin', '0'); bar.setAttribute('aria-valuemax', '100');
    bar.style.setProperty('--p', `${Math.round(item.progress)}%`);
    copy.append(bar);
  }
  if (item.path) copy.append(el('span', 'att-list-path', item.path));
  const buttons = actions.filter(Boolean);
  if (buttons.length) {
    const bar = el('div', 'att-list-actions');
    for (const action of buttons) {
      const b = el('button', 'att-list-action', action.label);
      b.type = 'button';
      b.onclick = () => { if (!action.keepOpen) close(); action.run(item); };
      bar.append(b);
    }
    copy.append(bar);
  }
  r.append(copy);
  return r;
}

/** 動線の近くに浮かせる（デスクトップ）。下に余白があれば下、無ければ上。700px 以下は CSS が下からのシートにする */
function place(dialog, anchor) {
  const style = dialog.style;
  if (!anchor?.getBoundingClientRect || matchMedia('(max-width:700px)').matches) { style.left = style.top = ''; return; }
  const r = anchor.getBoundingClientRect();
  const w = dialog.offsetWidth, h = dialog.offsetHeight;
  const left = Math.max(12, Math.min(r.left, innerWidth - w - 12));
  const below = innerHeight - r.bottom - 12;
  const top = below >= h || below >= r.top - 12 ? Math.min(r.bottom + 6, Math.max(12, innerHeight - h - 12)) : Math.max(12, r.top - h - 6);
  style.left = `${left}px`;
  style.top = `${top}px`;
}
