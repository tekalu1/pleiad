// 発言の操作（docs/design-system.md「メインパネルの情報整理」10、ADR 0067）。
// 発言者の行の右に、コピー（時刻の左）と ⋯（操作の列）を置く。⋯ と右クリック（タッチは長押し）は同じメニューを開く。
// 「エージェントに渡した原文を見る」は、添付の一覧と同じ作りの <dialog> のモーダルで見せる。
import { el, svgEl } from './dom.mjs';
import { t } from './i18n.mjs';
import { isComposingKey } from './keyboard.mjs';
import { openExternalLink } from './link-open.mjs';

export const COPIED_MS = 1200;
export function aiReportUrl() {
  return 'https://github.com/tekalu1/pleiad/issues/new?' + new URLSearchParams({
    title: t('chat.message.reportTitle'), body: t('chat.message.reportBody'),
  });
}

export function reportAiContent() { return openExternalLink(aiReportUrl(), { external: true }); }

const svg = (paths, extra = {}) => {
  const s = svgEl('svg', { viewBox: '0 0 24 24', 'aria-hidden': 'true', ...extra });
  for (const p of paths) s.append(p);
  return s;
};
const path = (d) => svgEl('path', { d });

/** コピーの絵（重なった 2 枚）と、コピーできたときの ✓ */
export function copyGlyphs() {
  const copy = svg([svgEl('rect', { x: 8, y: 8, width: 12, height: 12, rx: 2.5 }), path('M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2')], { class: 'cp' });
  const ok = svg([path('M5 12.5l4.5 4.5L19 7.5')], { class: 'ok' });
  return [copy, ok];
}

/** ⋯ の絵 */
function dots() {
  const s = svg([]);
  for (const cx of [5, 12, 19]) s.append(svgEl('circle', { cx, cy: 12, r: 1.3 }));
  return s;
}

/**
 * 発言者の行に置くボタン 2 つ。名前は「コピー」「この発言の操作」。押したときの中身は呼び手が付ける
 * @returns {{ copy: HTMLButtonElement, more: HTMLButtonElement }}
 */
export function actionButtons() {
  const copy = el('button', 'who-btn who-copy');
  copy.type = 'button';
  copy.setAttribute('aria-label', t('chat.message.copy'));
  copy.title = t('chat.message.copy');
  copy.append(...copyGlyphs());
  const more = el('button', 'who-btn who-more');
  more.type = 'button';
  more.setAttribute('aria-label', t('chat.message.more'));
  more.setAttribute('aria-haspopup', 'menu');
  more.setAttribute('aria-expanded', 'false');
  more.title = t('chat.message.more');
  more.append(dots());
  return { copy, more };
}

// ---------------------------------------------------------------- コピー

let live = null;
/** 読み上げだけの知らせ（見た目には出さない） */
export function announce(text) {
  if (!live?.isConnected) {
    live = el('div', 'sr-live');
    live.setAttribute('role', 'status');
    live.setAttribute('aria-live', 'polite');
    document.body.append(live);
  }
  live.textContent = '';
  // 同じ文が続けて来ても読み直されるよう、置き直しを 1 コマ遅らせる
  requestAnimationFrame(() => { live.textContent = text; });
}

/** 字をクリップボードへ写す。写せたら true */
export async function writeClipboard(text) {
  try { await navigator.clipboard.writeText(String(text ?? '')); return true; } catch { return false; }
}

/** コピーできた印（1.2 秒の ✓）と読み上げ。button が無ければ読み上げだけ */
export function flashCopied(button, message = t('chat.message.copied')) {
  announce(message);
  if (!button) return;
  button.classList.add('done');
  clearTimeout(button.doneTimer);
  button.doneTimer = setTimeout(() => button.classList.remove('done'), COPIED_MS);
}

/** 写して印を出す。button は ⋯ から開いたメニューの項目では null（読み上げだけ）、発言者の行のコピーではそのボタン */
export async function copyToClipboard(text, button = null) {
  if (!(await writeClipboard(text))) return false;
  flashCopied(button);
  return true;
}

// ---------------------------------------------------------------- メニューの中身

/**
 * メニューの項目の並び（順と有無。押したときの動きは呼び手が key で決める）。
 * kind: 'user' 自分の発言 / 'ai' エージェントの返答 / 'cmd' スラッシュコマンド・! の行
 * part: 続きの発言（見出しの行の無い、同じ返答の後ろの部分）を右クリックしたとき。分岐の文言が「この発言から分岐」になる
 * touch: 時刻の行を先頭に置く（ホバーが無く、時刻を出す手段が押すことしか無いので）
 * @returns {{ key: string, label: string, sep?: boolean }[]}
 */
export function messageMenuPlan({ kind = 'user', part = false, canFork = true, shell = false, source = false, editable = true } = {}) {
  const items = [{ key: 'copy', label: kind === 'ai' ? t('chat.message.copyReply') : t('chat.message.copy') }];
  if (shell) items.push({ key: 'toComposer', label: t('chat.system.copyToComposer') });
  if (canFork) items.push({ key: 'fork', label: part ? t('chat.message.forkPart') : t('chat.message.fork') });
  if (kind === 'user') {
    // 編集・再送信は、保存済み（uuid が分かっている）の発言だけ
    if (editable) items.push({ key: 'sep', sep: true }, { key: 'edit', label: t('chat.message.editResend') }, { key: 'resend', label: t('chat.message.resend') });
    if (source) items.push(...(editable ? [] : [{ key: 'sep', sep: true }]), { key: 'source', label: t('chat.message.showSource') });
  }
  if (kind === 'ai') items.push({ key: 'sep', sep: true }, { key: 'report', label: t('chat.message.reportAi') });
  return items;
}

/** 触れる手段が押すことしか無い端末（ホバーが無い）か */
export const hoverless = () => typeof matchMedia === 'function' && matchMedia('(hover:none)').matches;

// ---------------------------------------------------------------- 右クリック・キーボード

// 今までのメニュー（ブラウザーの、リンク・ファイル・コードなどの）を優先する場所
const OWN_MENU = 'a, [data-file-path], [data-file-menu], pre, code, .code-block, img, input, textarea, select, summary, .tc-details, .table-wrap';

/**
 * 会話の列（root）の発言の右クリック・長押し・キーボード（Shift+F10・メニューキー）を受ける。
 * resolve(target) は { m, part } か null（メニューを出さない場所）、open(hit, at) がメニューを開く。
 * at は { x, y } と、キーボードなら key: true（⋯ の位置に出す）
 */
export function setupMessageMenu(root, { resolve, open }) {
  const own = (target) => Boolean(target?.closest?.(OWN_MENU)) && !target.closest('.who-btn');
  root.addEventListener('contextmenu', (e) => {
    if (e.defaultPrevented || own(e.target)) return;
    // 字を選んでいるとき（マウス）はブラウザーのメニュー。長押し（合成の contextmenu）は OS が語を選ぶことがあるので見ない
    if (e.isTrusted && String(getSelection?.() ?? '').trim()) return;
    const hit = resolve(e.target);
    if (!hit) return;
    e.preventDefault();
    const keyboard = !e.clientX && !e.clientY;
    open(hit, { x: e.clientX, y: e.clientY, key: keyboard });
  });
  // Shift+F10・メニューキーは、ブラウザーが contextmenu を起こさないことがあるので自分でも受ける
  root.addEventListener('keydown', (e) => {
    if (e.defaultPrevented || isComposingKey(e)) return;
    if (!(e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey))) return;
    if (own(e.target)) return;
    const hit = resolve(e.target);
    if (!hit) return;
    e.preventDefault();
    open(hit, { x: 0, y: 0, key: true });
  });
}

// ---------------------------------------------------------------- 原文のモーダル

let openDialog = null;

/**
 * 「エージェントに渡した原文」のモーダル。添付の一覧の面（web/attachment-list.mjs）と同じ作り。
 * 700px 以下は下からのシート。Esc・閉じる・背後の押下で閉じ、フォーカスは opener（⋯）へ戻す。
 * variants を渡すと、頭に切り替え（チャンネルのスレッドで bot ごとに渡した原文。web/channels/thread.mjs）
 * @param {{ text?: string, at?: string, opener?: HTMLElement | null, variants?: { label: string, text: string, at?: string }[] }} o
 */
export function openSourceDialog({ text = '', at = '', opener = null, variants = null }) {
  if (variants?.length) ({ text, at = '' } = variants[0]);
  openDialog?.close();
  const dialog = el('dialog', 'src-dlg');
  const titleId = `srcTitle${Math.random().toString(36).slice(2, 8)}`;
  dialog.setAttribute('aria-labelledby', titleId);
  const inner = el('div', 'src-in');
  const head = el('div', 'src-head');
  const heading = el('h3', null, t('chat.message.sourceTitle'));
  heading.id = titleId;
  head.append(heading);
  if (at) head.append(el('span', 'src-time', at));
  const copy = el('button', 'btn btn-quiet src-btn');
  copy.type = 'button';
  const [glyph, done] = copyGlyphs();
  const copyLabel = el('span', null, t('chat.message.copy'));
  copy.append(glyph, done, copyLabel);
  const close = el('button', 'btn btn-quiet src-btn');
  close.type = 'button';
  close.append(el('span', null, t('chat.attachList.close')), el('span', null, '×'));
  close.lastChild.setAttribute('aria-hidden', 'true');
  head.append(copy, close);
  const body = el('pre', 'src-body', String(text ?? ''));
  body.tabIndex = 0;
  const time = head.querySelector('.src-time');
  let tabs = null;
  if (variants?.length > 1) {
    tabs = el('div', 'src-tabs');
    tabs.setAttribute('role', 'group');
    tabs.setAttribute('aria-label', t('chat.message.sourceFor'));
    variants.forEach((v, i) => {
      const b = el('button', 'src-tab', v.label);
      b.type = 'button';
      b.setAttribute('aria-pressed', String(i === 0));
      b.onclick = () => {
        text = v.text;
        body.textContent = v.text;
        if (time) time.textContent = v.at ?? '';
        for (const x of tabs.children) x.setAttribute('aria-pressed', String(x === b));
      };
      tabs.append(b);
    });
  }
  inner.append(el('div', 'src-handle'), head, ...(tabs ? [tabs] : []), body);
  dialog.append(inner);

  let timer = 0;
  copy.onclick = async () => {
    if (!(await writeClipboard(text))) return;
    announce(t('chat.message.copied'));
    copyLabel.textContent = t('chat.message.copied');
    copy.classList.add('done');
    clearTimeout(timer);
    timer = setTimeout(() => { copyLabel.textContent = t('chat.message.copy'); copy.classList.remove('done'); }, COPIED_MS);
  };
  const shut = () => { if (dialog.open) dialog.close(); };
  close.onclick = shut;
  // ダイアログ自身が click の対象になるのは背後の覆いを押したときだけ（中身は inner が覆う）
  dialog.addEventListener('click', (e) => { if (e.target === dialog) shut(); });
  dialog.addEventListener('close', () => {
    clearTimeout(timer);
    if (openDialog?.dialog === dialog) openDialog = null;
    dialog.remove();
    if (opener?.isConnected) opener.focus?.({ preventScroll: true });
  });
  document.body.append(dialog);
  dialog.showModal();
  body.focus({ preventScroll: true });
  openDialog = { dialog, close: shut };
  return openDialog;
}
