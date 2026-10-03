// チャンネル・スレッドの入力欄（.ch-composer。流れは #chFeedComposer、スレッドは #chThreadComposer）。
// Chats の入力欄と同じ操作を持つ（ADR 0116）: 字の欄は Chats と同じ編集欄（web/md-editor.mjs。要素を渡せば何個でも作れる）、
// 送信は Ctrl+Enter（Enter は改行）、行は 1 行から中身に合わせて伸びる（上限はマウス 10 行・タッチ 6 行。web/composer-layout.mjs）、
// 添付はクリップ・貼り付け・ドロップ（ch-attachments.mjs）、書きかけは入力欄ごと（流れはチャンネル・スレッドはスレッド）に端末へ残す。
// チップは無い（bot の動かし方は bot が持つ）。「@」で bot とメンバーを補完（mention-complete.mjs）。
// 誰も @ していない文では、淡い提案（「@Owl を呼ぶ」）を欄の上に出す。DM は宛先が決まっているので出さない。
import { createMarkdownEditor } from '../md-editor.mjs';
import { isComposingKey } from '../keyboard.mjs';
import { promptMaxHeight } from '../composer-layout.mjs';
import { el, svgEl } from '../dom.mjs';
import { t } from '../i18n.mjs';
import { setupMentionComplete } from './mention-complete.mjs';
import { createChAttachments } from './ch-attachments.mjs';
import { DRAFT_STORE, parseDrafts, serializeDrafts } from './ch-attach-model.mjs';

const sendIcon = () => {
  const svg = svgEl('svg', { class: 'i', viewBox: '0 0 24 24', 'aria-hidden': 'true' });
  svg.append(svgEl('path', { d: 'M21 3L10 14M21 3l-7 18-4-7-7-4z' }));
  return svg;
};

// ---- 書きかけ（端末の localStorage。入力欄どうしで共有する 1 つの入れ物）
let drafts = null;
const draftStore = () => (drafts ??= parseDrafts((() => { try { return localStorage.getItem(DRAFT_STORE); } catch { return null; } })()));
const persistDrafts = () => { try { localStorage.setItem(DRAFT_STORE, serializeDrafts(draftStore())); } catch { /* 入れ物がいっぱい・使えない: 画面の中の写しだけで続ける */ } };
const SAVE_WAIT_MS = 400;

/**
 * @param {object} o
 * @param {string} o.id 入力欄の id（#chFeedComposer / #chThreadComposer）
 * @param {object} o.host setupChannels の host（cmd・whenOnline・openImage・filePreview を添付が使う）
 * @param {() => string|null} o.bucket 添付の置き場の分け先（チャンネルの id）
 * @param {() => object[]} o.candidates @ の候補（mention-complete.mjs の形）
 * @param {() => { id: string, name: string, icon: string }|null} [o.suggest] 誰も @ していないときに勧める bot（無ければ提案を出さない）
 * @param {(backend: string) => string} [o.backendLabel]
 * @param {(post: { text: string, attachments: { path: string, name: string, mime: string }[] }) => Promise<void>} o.onSend 投稿する。失敗したら投げる（字と添付は残る）
 * @returns {{ el: HTMLFormElement, input: HTMLElement, focus(): void, setPlaceholder(text: string): void, setDisabled(on: boolean, reason?: string): void, refresh(): void, clear(): void,
 *   setDraftKey(key: string|null): void, saveDraft(): void, bindDropZone(zone: HTMLElement): void }}
 */
export function createChComposer({ id, host, bucket = () => null, candidates, suggest = () => null, backendLabel, onSend, idPrefix = id }) {
  const form = el('form', 'ch-composer');
  form.id = id;
  form.noValidate = true;
  const hint = el('div', 'ch-hint');
  hint.hidden = true;
  const list = el('ul', 'mention-list');
  list.id = `${id}Mentions`;
  list.setAttribute('role', 'listbox');
  list.setAttribute('aria-label', t('channels:feed.mention.label'));
  list.hidden = true;
  const box = el('div', 'ch-box');
  const input = el('div', 'ch-input');
  input.id = `${id}Input`;
  input.setAttribute('aria-label', t('channels:feed.composer.label'));
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-haspopup', 'listbox');
  input.setAttribute('aria-controls', list.id);
  const row = el('div', 'ch-row');
  const note = el('span', 'ch-note');
  note.setAttribute('role', 'status');
  const send = el('button', 'btn btn-primary ch-send');
  send.type = 'submit';
  send.title = t('channels:feed.composer.send');
  send.setAttribute('aria-label', t('channels:feed.composer.send'));
  send.append(sendIcon());

  let busy = false, disabled = false, noteTimer = null, draftKey = null, saveTimer = null;

  const say = (text, sticky = false) => {
    clearTimeout(noteTimer);
    note.textContent = text;
    if (text && !sticky) noteTimer = setTimeout(() => { note.textContent = ''; }, 6000);
  };

  // ---- 書きかけ
  function saveDraft() {
    clearTimeout(saveTimer);
    saveTimer = null;
    if (!draftKey) return;
    const d = { text: input.value ?? '', attached: attach.items, at: Date.now() };
    if (!d.text.trim() && !d.attached.length) draftStore().delete(draftKey); else draftStore().set(draftKey, d);
    persistDrafts();
  }
  const saveDraftSoon = () => { if (saveTimer === null) saveTimer = setTimeout(saveDraft, SAVE_WAIT_MS); };
  /** 送っている間に別の入力欄へ移った後に届いた添付を、持ち主の下書きへ入れる（位置は持たない: 文末に付く） */
  function adopt(owner, item) {
    const d = draftStore().get(owner) ?? { text: '', attached: [], at: 0 };
    draftStore().set(owner, { ...d, attached: [...d.attached, item], at: Date.now() });
    persistDrafts();
  }

  const attach = createChAttachments({
    host, bucket, owner: () => draftKey ?? '', accepts: () => !disabled, say, adopt,
    onChange: () => { saveDraft(); paintHint(); },
  });
  row.append(attach.button, note, send);
  box.append(attach.strip, input, row);
  form.append(hint, list, box, attach.fileInput);

  const editor = createMarkdownEditor(input, { resolve: () => null, ...attach.editorOptions });
  attach.bind(editor, input);
  const mention = setupMentionComplete({ input, list, candidates, idPrefix: `${idPrefix}-mention`, backendLabel, onChange: () => paintHint() });

  // ---- 高さ。1 行から始めて中身に合わせて伸び（CSS）、上限はマウス 10 行・タッチ 6 行（Chats の fitPrompt と同じ決まり）
  function fit() {
    if (!input.isConnected) return;
    const css = getComputedStyle(input);
    const line = parseFloat(css.lineHeight) || 22;
    const pad = (parseFloat(css.paddingTop) || 0) + (parseFloat(css.paddingBottom) || 0);
    form.style.setProperty('--ch-input-max', `${promptMaxHeight({ line, pad, touch: matchMedia('(pointer:coarse)').matches, viewport: innerHeight })}px`);
  }
  addEventListener('resize', fit);
  form.addEventListener('focusin', fit);

  function paintHint() {
    const text = input.value.trim();
    const bot = text && !disabled ? suggest() : null;
    if (!bot || /@/.test(text)) { hint.hidden = true; return; }
    hint.replaceChildren(el('span', null, t('channels:feed.hint.nobody')));
    const b = el('button', null, t('channels:feed.hint.call', { name: bot.name }));
    b.type = 'button';
    b.onmousedown = (e) => e.preventDefault();
    b.onclick = () => {
      input.setRangeText(`@${bot.name} `, 0, 0, 'end');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.focus();
    };
    hint.append(b);
    hint.hidden = false;
  }

  async function submit() {
    if (busy || disabled) return;
    // 送っている途中・失敗の添付があるうちは送らない（欠けた添付を前提に bot が動き出さないように）。札が理由と外す・再試行を持つ
    const body = attach.compose(input.value);
    if (!body.text.trim() && !body.attachments.length) return;
    const block = attach.blockReason();
    if (block) { say(block); attach.flash(); return; }
    busy = true;
    send.disabled = true;
    say('');
    try {
      await onSend(body);
      input.value = '';
      attach.clear();
      saveDraft();
      paintHint();
    } catch (err) {
      say(t('channels:feed.composer.failed', { error: err?.message ?? String(err) }), true);
    } finally {
      busy = false;
      send.disabled = disabled;
    }
  }

  form.addEventListener('submit', (e) => { e.preventDefault(); submit(); });
  input.addEventListener('keydown', (e) => {
    if (isComposingKey(e)) return;
    if (mention.keydown(e)) return;
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); submit(); }
  });
  input.addEventListener('input', () => { if (note.textContent && !busy) say(''); paintHint(); saveDraftSoon(); });
  input.addEventListener('blur', saveDraft);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') saveDraft(); });
  addEventListener('pagehide', saveDraft);
  // 箱のどこを押しても字の欄へ（Chats の入力欄と同じ）
  box.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button, .md-b, [contenteditable]')) return;
    e.preventDefault();
    input.focus();
  });

  return {
    el: form,
    input,
    editor,
    attach,
    focus: () => input.focus({ preventScroll: true }),
    setPlaceholder(text) { input.placeholder = text; },
    setDisabled(on, reason = '') {
      disabled = on;
      input.disabled = on;
      send.disabled = on || busy;
      attach.button.disabled = on;
      form.classList.toggle('disabled', on);
      say(on ? reason : '', true);
      paintHint();
    },
    refresh() { paintHint(); fit(); },
    /** 入力欄の下の一行（失敗など）。sticky でなければ数秒で消える */
    say,
    clear() { input.value = ''; attach.clear(); say(''); saveDraft(); paintHint(); },
    mention,
    /**
     * この入力欄の書きかけの持ち主（流れ = チャンネル・スレッド = スレッド）。変わったら、今の書きかけを元の持ち主へ残し、
     * 新しい持ち主の書きかけ（字と添付）を出す。null は持ち主のいない間（何も残さない）
     */
    setDraftKey(key) {
      if (key === draftKey) return;
      saveDraft();
      draftKey = key;
      const d = key ? draftStore().get(key) : null;
      attach.restore(d?.attached);   // 添付の実体が先（本文の印は、ここにあるものだけが札になる）
      input.value = d?.text ?? '';
      say('');
      paintHint();
    },
    saveDraft,
    /** zone（流れ・スレッドの板）に落としたファイルをこの入力欄の添付にする */
    bindDropZone: (zone) => attach.bindDropZone(zone),
  };
}
