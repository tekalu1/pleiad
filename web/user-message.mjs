// 自分の発言の描画（docs/design-system.md「自分の発言」、ADR 0059）。
//
// 本文は Markdown（web/render.mjs の renderMarkdown と同じ描画）。本文の中の `[添付] パス` の行のうち、この発言に結び付いた
// human の present（web/timeline.mjs の attachmentMessageIndex / buildItems）とパスが一致するものだけを、その位置で添付の表示
// （画像は縮小、ほかのファイルは札）に置き換える。コードブロックの中の印・一致しないパスは消さない。
// 印が末尾にまとまっている古い形式の発言は位置を推測せず、同じ部品で本文の後ろに並べる（結び付いたのに印の無い present も末尾）。
//
// 出すのはエスケープ済みの HTML 文字列（userBodyHtml）。描いたあとの操作は会話の側の委譲で受ける
// （画像の拡大は .msg-att-zoom の click、ファイルの札は今までのファイルリンク）。
import { el, icon } from './dom.mjs';
import { t } from './i18n.mjs';
import { renderMarkdownBlocks, codeFenceMask, plainTextHtml, presentImg } from './render.mjs';
import { fileReference, baseName } from './file-reference.mjs';
import { ATTACHMENT_LINE, normalizeAttachmentPath } from './timeline.mjs';
import { openAttachmentList } from './attachment-list.mjs';

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ESC[c]);

/** 見せる行数の目安と、畳む側がこれより少なければ畳まない行数 */
export const FOLD_LINES = 8;
const FOLD_MIN_HIDDEN = 3;

/** 添付の名前。新しい記録は captionParams.name、無い過去の記録は保存された見出し「添付: 名前」から、それも無ければパスの末尾 */
export const attachmentName = p =>
  p?.captionParams?.name || String(p?.caption ?? '').replace(/^添付:\s*/, '') || baseName(String(p?.path ?? ''));

/** 画像の src。画像でない・載せられない（大きすぎて中身を外した）ものは、ホストが配る /local-file か null */
export function attachmentImageSrc(p) {
  if (p?.kind !== 'image') return null;
  return presentImg(p.dataUri ?? p.path);
}

/**
 * 本文を、文字の区間と添付に分ける。
 * @param {string} text 送った本文（原文）
 * @param {object[]} presents この発言に結び付いた human の present（path を持つ）
 * @returns {{ type: 'text', text: string } | { type: 'attachment', present: object, trailing: boolean }[]}
 */
export function placeAttachments(text, presents = []) {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
  const fenced = codeFenceMask(lines);
  const pool = new Map();
  for (const p of presents) {
    if (!p?.path) continue;
    const key = normalizeAttachmentPath(p.path);
    pool.set(key, [...(pool.get(key) ?? []), p]);
  }
  const placed = new Set();
  const segments = [];
  let buf = [];
  const flush = () => { if (buf.length) segments.push({ type: 'text', text: buf.join('\n') }); buf = []; };
  lines.forEach((line, i) => {
    const mark = fenced[i] ? null : ATTACHMENT_LINE.exec(line.trim());
    const present = mark ? pool.get(normalizeAttachmentPath(mark[1]))?.shift() : null;
    if (!present) { buf.push(line); return; }
    flush();
    placed.add(present);
    segments.push({ type: 'attachment', present, trailing: false });
  });
  flush();
  for (const p of presents) if (p?.path && !placed.has(p)) segments.push({ type: 'attachment', present: p, trailing: true });
  return segments;
}

/** 添付 1 件の HTML。画像は縮小と名前、ほかは札。画像に出来ないもの（中身を外した・壊れた）は札にする。入力欄の添付（web/md-editor.mjs）も同じ部品 */
export function attachmentHtml(p) {
  const name = attachmentName(p), path = String(p.path ?? '');
  const ref = path ? fileReference(path) : null;
  const src = attachmentImageSrc(p);
  if (src) {
    const label = esc(t('chat.attach.enlarge', { name }));
    return `<figure class="msg-att msg-att-img"><button type="button" class="msg-att-zoom" aria-label="${label}" title="${label}">` +
      `<img src="${esc(src)}" alt="${esc(name)}"${ref ? ` data-file-path="${esc(path)}"` : ''} loading="lazy"></button>` +
      `<figcaption>${esc(name)}</figcaption></figure>`;
  }
  // 札の頭の ▧ はファイルリンクの共通の飾り（web/file-preview.css）。名前を押すと右パネルで開く
  const inner = `<span>${esc(name)}</span>`;
  return ref
    ? `<a class="md-link file-link msg-att msg-att-file" href="/local-file?path=${encodeURIComponent(ref.path)}" data-file-path="${esc(ref.path)}" title="${esc(path)}">${inner}</a>`
    : `<span class="msg-att msg-att-file" title="${esc(path)}">${inner}</span>`;
}

/** 本文の並び: { kind: 'md', html, lines } と、間に本文の無い添付のまとまり { kind: 'atts', items } */
export function bodyUnits(segments) {
  const units = [];
  for (const seg of segments) {
    if (seg.type === 'text') {
      for (const b of renderMarkdownBlocks(seg.text)) units.push({ kind: 'md', html: b.html, lines: b.lines });
      continue;
    }
    const last = units.at(-1);
    if (last?.kind === 'atts') last.items.push(seg.present);
    else units.push({ kind: 'atts', items: [seg.present] });
  }
  return units;
}

/**
 * 畳む位置（見せる単位の数）。畳まないなら -1。
 * 本文の見た目の行数が limit に届くまでを見せ、直前の段落に付いた添付のまとまりは切り離さない。まだ添付が 1 つも見えていなければ、
 * limit 行以内に最初の添付のまとまりがあるときはそこまで見せる。畳む側の本文が FOLD_MIN_HIDDEN 行に満たなければ畳まない
 */
export function foldIndex(units, limit = FOLD_LINES) {
  const total = units.reduce((n, u) => n + (u.kind === 'md' ? u.lines : 0), 0);
  if (total <= limit) return -1;
  let lines = 0, i = 0, seenAtts = false;
  while (i < units.length && lines < limit) {
    if (units[i].kind === 'md') lines += units[i].lines; else seenAtts = true;
    i++;
  }
  if (units[i]?.kind === 'atts') { i++; seenAtts = true; }
  if (!seenAtts) {
    let extra = 0, j = i;
    while (j < units.length && units[j].kind !== 'atts') { extra += units[j].lines; j++; }
    if (j < units.length && extra <= limit) i = j + 1;
  }
  if (i >= units.length) return -1;
  const hidden = units.slice(i).reduce((n, u) => n + (u.kind === 'md' ? u.lines : 0), 0);
  return hidden >= FOLD_MIN_HIDDEN ? i : -1;
}

const unitHtml = u => (u.kind === 'md' ? u.html : `<div class="msg-atts">${u.items.map(attachmentHtml).join('')}</div>`);

/**
 * 自分の発言の本文を HTML にする。
 * @param {string} text 送った本文（原文）
 * @param {object[]} presents この発言に結び付いた human の present
 * @param {{ markdown?: boolean }} opts markdown: false は今までの平文（委譲の子の会話を読む面）。添付も置き換えない
 * @returns {{ html: string, attachments: number, placed: number, folded: boolean }} placed は本文の中の印を置き換えた数
 */
export function userBodyHtml(text, presents = [], { markdown = true } = {}) {
  if (!markdown) return { html: plainTextHtml(text), attachments: 0, placed: 0, folded: false };
  const segments = placeAttachments(text, presents);
  const units = bodyUnits(segments);
  const cut = foldIndex(units);
  const shown = cut < 0 ? units : units.slice(0, cut);
  let html = shown.map(unitHtml).join('');
  if (cut >= 0) {
    html += `<details class="msg-more"><summary><span class="more-open">${esc(t('chat.message.showMore'))}</span>` +
      `<span class="more-close">${esc(t('chat.message.showLess'))}</span></summary>${units.slice(cut).map(unitHtml).join('')}</details>`;
  }
  const attachments = segments.filter(s => s.type === 'attachment');
  return { html, attachments: attachments.length, placed: attachments.filter(s => !s.trailing).length, folded: cut >= 0 };
}

/** 吹き出し（.body）に自分の発言を描く。原文は dataset.raw に持つ（履歴との突き合わせ・添付の突き合わせが読む） */
export function paintUserBody(body, text, presents = [], { markdown = true } = {}) {
  const r = userBodyHtml(text, presents, { markdown });
  body.innerHTML = r.html;
  body.dataset.raw = String(text ?? '');
  body.classList.toggle('md-user', markdown);
  return r;
}

/** 一覧の面の 1 行にする */
export function attachmentListItem(p, index) {
  const src = attachmentImageSrc(p);
  const bytes = p.dataUri ? Math.floor((String(p.dataUri).length - String(p.dataUri).indexOf(',') - 1) * 3 / 4) : null;
  return {
    id: String(index), kind: src ? 'image' : 'file', name: attachmentName(p), path: String(p.path ?? ''),
    thumb: src, size: Number.isFinite(p.size) ? p.size : bytes && bytes > 0 ? bytes : null, origin: p.origin ?? null,
    status: p.origin === 'host' ? t('chat.attachList.byPath') : t('chat.attachList.sent'),
  };
}

/**
 * 発言の下の弱い字の行（添付 N 件 ▾・エージェントに渡した原文を見る）。添付が無ければ null。
 * openItem(item) は一覧の「開く」（画像は拡大、ほかは右パネル）。原文の面は行の直後に置く（source 要素）
 * @returns {{ row: HTMLElement, source: HTMLElement } | null}
 */
export function userTools({ raw, presents = [], openItem, copyPath }) {
  if (!presents.length) return null;
  const row = el('div', 'msg-tools');
  const button = el('button', 'msg-tool msg-tool-atts');
  button.type = 'button';
  button.setAttribute('aria-haspopup', 'dialog');
  // 「📎 6 ▾」。字は「添付」を外して件数だけ。名前と title は「添付 6 件の一覧を開く」
  const label = t('chat.attachList.openList', { count: presents.length, n: presents.length });
  button.setAttribute('aria-label', label);
  button.title = label;
  button.append(
    icon('M21.4 11.05l-9.2 9.2a6 6 0 0 1-8.5-8.5l9.9-9.9a4 4 0 0 1 5.66 5.66l-9.9 9.9a2 2 0 0 1-2.83-2.83l9.2-9.2'),
    el('span', 'msg-tool-n', String(presents.length)),
    el('span', 'msg-tool-caret', '▾'),
  );
  button.lastChild.setAttribute('aria-hidden', 'true');
  button.children[1].setAttribute('aria-hidden', 'true');
  button.onclick = () => openAttachmentList({
    anchor: button, title: t('chat.attachList.count', { count: presents.length }),
    items: presents.map(attachmentListItem),
    actions: item => [
      { label: t('chat.attachList.open'), run: () => openItem?.(item, presents[Number(item.id)]) },
      { label: t('chat.attachList.copyPath'), run: () => copyPath?.(item.path) },
    ],
  });
  row.append(button);
  const source = el('pre', 'msg-source', String(raw ?? ''));
  source.hidden = true;
  const toggle = el('button', 'msg-tool', t('chat.message.showSource'));
  toggle.type = 'button';
  toggle.setAttribute('aria-expanded', 'false');
  toggle.onclick = () => {
    const open = source.hidden;
    source.hidden = !open;
    toggle.setAttribute('aria-expanded', String(open));
    toggle.textContent = open ? t('chat.message.hideSource') : t('chat.message.showSource');
  };
  row.append(toggle);
  return { row, source };
}
