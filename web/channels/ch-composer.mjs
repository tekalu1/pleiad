// チャンネル・スレッドの入力欄（.ch-composer。流れは #chFeedComposer、スレッドは #chThreadComposer）。
// 字の欄は Chats と同じ編集欄（web/md-editor.mjs。要素を渡せば何個でも作れる）。送信のボタンだけで、チップは無い（bot の動かし方は bot が持つ）。
// 送信は Ctrl+Enter（Enter は改行。Chats と同じ）。「@」で bot とメンバーを補完（mention-complete.mjs）。
// 誰も @ していない文では、淡い提案（「@Owl を呼ぶ」）を欄の上に出す。DM は宛先が決まっているので出さない。
import { createMarkdownEditor } from '../md-editor.mjs';
import { isComposingKey } from '../keyboard.mjs';
import { el, svgEl } from '../dom.mjs';
import { t } from '../i18n.mjs';
import { setupMentionComplete } from './mention-complete.mjs';

const sendIcon = () => {
  const svg = svgEl('svg', { class: 'i', viewBox: '0 0 24 24', 'aria-hidden': 'true' });
  svg.append(svgEl('path', { d: 'M21 3L10 14M21 3l-7 18-4-7-7-4z' }));
  return svg;
};

/**
 * @param {object} o
 * @param {string} o.id 入力欄の id（#chFeedComposer / #chThreadComposer）
 * @param {() => object[]} o.candidates @ の候補（mention-complete.mjs の形）
 * @param {() => { id: string, name: string, icon: string }|null} [o.suggest] 誰も @ していないときに勧める bot（無ければ提案を出さない）
 * @param {(backend: string) => string} [o.backendLabel]
 * @param {(text: string) => Promise<void>} o.onSend 投稿する。失敗したら投げる（字は残る）
 * @returns {{ el: HTMLFormElement, input: HTMLElement, focus(): void, setPlaceholder(text: string): void, setDisabled(on: boolean, reason?: string): void, refresh(): void, clear(): void }}
 */
export function createChComposer({ id, candidates, suggest = () => null, backendLabel, onSend, idPrefix = id }) {
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
  row.append(note, send);
  box.append(input, row);
  form.append(hint, list, box);

  const editor = createMarkdownEditor(input, { resolve: () => null });
  const mention = setupMentionComplete({ input, list, candidates, idPrefix: `${idPrefix}-mention`, backendLabel, onChange: () => paintHint() });
  let busy = false, disabled = false, noteTimer = null;

  const say = (text, sticky = false) => {
    clearTimeout(noteTimer);
    note.textContent = text;
    if (text && !sticky) noteTimer = setTimeout(() => { note.textContent = ''; }, 6000);
  };

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
    const text = input.value.trim();
    if (!text || busy || disabled) return;
    busy = true;
    send.disabled = true;
    say('');
    try {
      await onSend(text);
      input.value = '';
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
  input.addEventListener('input', () => { if (note.textContent && !busy) say(''); paintHint(); });
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
    focus: () => input.focus({ preventScroll: true }),
    setPlaceholder(text) { input.placeholder = text; },
    setDisabled(on, reason = '') {
      disabled = on;
      input.disabled = on;
      send.disabled = on || busy;
      form.classList.toggle('disabled', on);
      say(on ? reason : '', true);
      paintHint();
    },
    refresh: paintHint,
    /** 入力欄の下の一行（失敗など）。sticky でなければ数秒で消える */
    say,
    clear() { input.value = ''; say(''); paintHint(); },
    mention,
  };
}
