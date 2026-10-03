// 入力欄の「@」の補完（bot とメンバー）。web/slash-skills.mjs の「/」の補完と同じ判定・同じキー・同じ面（.clist）で作る。
// 判定: 行頭・空白・CJK・開き括弧の直後の `@` だけ（メールの形や URL の中では出さない）。
// キー: ↑↓ で選び、Enter / Tab / クリックで確定、Esc で閉じる。Ctrl+Enter は送信のまま（keydown が false を返す）。
// 確定すると `@名前 ` まで入り、続けて本文を打てる。slash-skills.mjs は候補の id と CSS が / 専用なので、写して接頭辞だけ替えた（共通化は後で）。
import { isComposingKey } from '../keyboard.mjs';
import { el } from '../dom.mjs';
import { t } from '../i18n.mjs';
import { backendLogo } from '../side.mjs';

const fold = (s) => String(s ?? '').normalize('NFKC').toLowerCase();

/** カーソル位置の `@名前` を取り出す。候補を出す条件を満たさなければ null */
export function mentionToken(value, caret = String(value ?? '').length, end = caret) {
  const text = String(value ?? '');
  if (caret !== end || caret < 0 || caret > text.length) return null;
  const start = text.lastIndexOf('@', caret - 1);
  if (start < 0 || start >= caret) return null;
  if (start && !/[\s\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}（(「『、。，,]/u.test(text[start - 1])) return null;
  const query = text.slice(start + 1, caret);
  if (/[\s@]/.test(query) || query.length > 40) return null;
  // 名前の途中（後ろに名前の続きがある）なら、続きまで置き換える
  const tail = /^[^\s@]*/.exec(text.slice(caret))[0];
  return { query, start, end: caret + tail.length };
}

/**
 * 候補の絞り込み。名前の前方一致 → 部分一致。元の並び（メンバーの並び）は保つ。
 * @param {{ name: string }[]} candidates
 */
export function filterCandidates(candidates, query) {
  const needle = fold(query);
  const rank = (c) => {
    const name = fold(c.name);
    if (!needle || name.startsWith(needle)) return 0;
    return name.includes(needle) ? 1 : -1;
  };
  return candidates.map((c, i) => ({ c, r: rank(c), i })).filter((x) => x.r >= 0).sort((a, b) => a.r - b.r || a.i - b.i).map((x) => x.c);
}

/**
 * @param {object} o
 * @param {HTMLElement} o.input 編集欄（value・selectionStart / End・setRangeText を持つ。web/md-editor.mjs）
 * @param {HTMLElement} o.list 候補の ul（.mention-list）
 * @param {() => { id: string, name: string, icon: string, backend?: string|null, you?: boolean, hint?: string }[]} o.candidates 今の候補（毎回呼ぶ）
 * @param {string} o.idPrefix 候補の要素の id の接頭辞（流れとスレッドの入力欄が同じ画面に並ぶので、重ならないようにする）
 * @param {(backend: string) => string} [o.backendLabel]
 * @param {() => void} [o.onChange] 候補を挿入して値が変わった
 */
export function setupMentionComplete({ input, list, candidates, idPrefix = 'mention', backendLabel = (b) => b, onChange = () => {} }) {
  let items = [], active = 0;
  const token = () => mentionToken(input.value, input.selectionStart, input.selectionEnd);
  const isOpen = () => !list.hidden;

  const close = () => {
    if (!isOpen()) return;
    list.hidden = true;
    list.replaceChildren();
    items = [];
    input.removeAttribute('aria-activedescendant');
  };

  const paint = () => {
    list.replaceChildren(el('li', 'head', t('channels:feed.mention.head')));
    list.firstChild.setAttribute('role', 'presentation');
    items.forEach((c, i) => {
      const li = el('li', `it${i === active ? ' on' : ''}`);
      li.id = `${idPrefix}-option-${i}`;
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', String(i === active));
      li.dataset.id = c.id;
      const av = el('span', `mention-av${c.you ? ' you' : ''}`, c.icon);
      av.setAttribute('aria-hidden', 'true');
      li.append(av, el('span', 'lbl', c.name));
      if (c.backend) li.append(backendLogo(c.backend, backendLabel(c.backend)));
      if (c.hint) li.append(el('span', 'hint', c.hint));
      // click だと blur が先に走る。mousedown で取る（slash-skills と同じ）
      li.onmousedown = (e) => { e.preventDefault(); commit(i); };
      list.append(li);
    });
    list.hidden = false;
    input.setAttribute('aria-activedescendant', `${idPrefix}-option-${active}`);
    list.querySelector(`#${idPrefix}-option-${active}`)?.scrollIntoView?.({ block: 'nearest' });
  };

  const sync = () => {
    const at = token();
    if (!at) return close();
    const next = filterCandidates(candidates(), at.query);
    if (!next.length) return close();
    if (next.length !== items.length || next.some((c, i) => c.id !== items[i]?.id)) active = 0;
    items = next;
    paint();
  };

  const commit = (i) => {
    const c = items[i];
    const at = token();
    if (!c || !at) return close();
    const suffix = input.value.slice(at.end);
    const insertion = `@${c.name}${/^\s/.test(suffix) ? '' : ' '}`;
    if (typeof input.setRangeText === 'function') input.setRangeText(insertion, at.start, at.end, 'end');
    else input.value = input.value.slice(0, at.start) + insertion + suffix;
    const caret = at.start + insertion.length + (/^\s/.test(suffix) ? 1 : 0);
    close();
    input.focus?.();
    input.setSelectionRange?.(caret, caret);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    onChange();
  };

  input.addEventListener('input', sync);
  input.addEventListener('focus', sync);
  input.addEventListener('click', sync);
  input.addEventListener('keyup', (e) => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) sync(); });
  input.addEventListener('blur', () => { setTimeout(close, 120); });

  /** 候補が開いている間のキーを取る。取ったら true（呼び出し側は以降を処理しない） */
  const keydown = (e) => {
    if (isComposingKey(e)) return false;
    if (e.ctrlKey || e.metaKey || e.altKey) return false;
    if (!isOpen()) return false;
    if (!token()) { close(); return false; }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!items.length) return true;
      active = (active + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      paint();
      return true;
    }
    if (e.key === 'Enter' || e.key === 'Tab') {
      if (!items.length) return false;
      e.preventDefault();
      commit(active);
      return true;
    }
    if (e.key === 'Escape') { e.preventDefault(); close(); return true; }
    return false;
  };

  return { keydown, close, isOpen, sync };
}
