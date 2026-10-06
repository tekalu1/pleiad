// 設定 › API キー（承認済み 2026-10-07。docs/design-system.md「設定 › API キー」）の部品。
// 設定 › API キーのページと、使う側の 3 画面（接続先のフォーム・通話・委譲の判定器）が同じものを使う:
//   - キーの状態の 1 行（登録済み · 確認 ✓ / ⚠ 確認に失敗）
//   - 「使うキー」の選択（既存の .pop のリストボックス。↑↓ Enter Esc。標準の select ではない）
//   - その場の登録欄（登録先は API キー）
// キーの値は画面に持たない（入力欄を出すだけで、送ったら捨てる）。
import { el } from './dom.mjs';
import { t, fmt } from './i18n.mjs';
import { providerName } from './api-keys-model.mjs';

const when = iso => fmt.dateTime(iso, { month: 'numeric', day: 'numeric' });

export async function apiKeyList(cmd) {
  const list = await cmd('invoke', { op: 'apiKeys.list', args: {} });
  if (!Array.isArray(list?.keys)) throw new Error('apiKeys.list');
  return list;
}

/** キー 1 件の名前。プロバイダー名を持つキーは label のまま（label が空のときだけプロバイダー名） */
export const keyName = key => key.label || providerName(key.provider) || t('apiKeys.unnamed');

/** 確認の結果の文（「登録済み · 確認 ✓ 10/7」「確認に失敗: …（10/7）」「登録済み」）。失敗の文だけ強い字にするため { text, failed } で返す */
export function statusParts(key) {
  const c = key.lastCheck;
  if (!c) return { text: t('apiKeys.status.registered'), failed: false };
  if (c.ok) return { text: t('apiKeys.status.checked', { when: when(c.at) }), failed: false };
  // i18n-dynamic: apiKeys.status.reason.
  const reason = t(`apiKeys.status.reason.${c.code === 'invalid' ? 'invalid' : 'unreachable'}`);
  return { text: t('apiKeys.status.failed', { reason, when: when(c.at) }), failed: true };
}
export const statusText = key => { const s = statusParts(key); return s.text; };

/** 「登録済み」を言い終えた後ろに続ける確認の結果（「確認 ✓ 10/7」「⚠ 確認に失敗: …」）。まだ確かめていなければ null */
export function checkParts(key) {
  const c = key.lastCheck;
  if (!c) return null;
  const s = statusParts(key);
  return { text: c.ok ? t('apiKeys.status.checkedBare', { when: when(c.at) }) : s.text, failed: s.failed };
}

/** 状態の 1 行を、要素（small）へ。失敗のときは「登録済み · 」の後ろだけ強くする */
export function statusLine(key, cls = '') {
  const s = statusParts(key);
  const small = el('small', cls);
  if (s.failed) small.append(`${t('apiKeys.status.registeredPrefix')} `, el('span', 'mp-warn', s.text));
  else small.textContent = s.text;
  return small;
}

/** 暗号化できない起動のときだけ出す一文（storage は apiKeys.list・voice.status の storage） */
export const notEncryptedNote = storage => storage && storage.encrypted === false ? el('p', 'mp-warn ak-warn', `⚠ ${t('apiKeys.notEncrypted')}`) : null;

export const CHEV = '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>';
const chev = () => { const s = el('span', 'ak-chev'); s.setAttribute('aria-hidden', 'true'); s.innerHTML = CHEV; return s; };

/** 回る弧（既存の .run。確かめている間） */
export function spinner(label) {
  const s = el('span', 'run'); s.setAttribute('role', 'img'); s.setAttribute('aria-label', label || t('apiKeys.checking'));
  s.innerHTML = '<svg viewBox="0 0 14 14"><path d="M7 1.5a5.5 5.5 0 1 1 0 11a5.5 5.5 0 1 1 0-11" stroke-dasharray="10 100"/></svg>';
  return s;
}

/**
 * 「使うキー」の選択。押すと既存の .pop のリスト（リストボックス）が開き、↑↓ で動き、Enter で選び、Esc で閉じて元のボタンへ戻る。
 * @param {object} o
 * @param {Array} o.keys  選べるキー（プロバイダーで絞った apiKeys.list の keys）
 * @param {string|null} o.current  今選んでいるキーの id（null は使わない）
 * @param {string} o.label  読み上げの名前（「通話に使うキー」）
 * @param {string} o.focusKey  描き直した後にフォーカスを戻す印（data-fk）
 * @param {(id: string|null) => void} o.choose
 * @param {string} [o.provider]  未登録のとき「＋ <プロバイダー> のキーを登録…」を出すプロバイダー
 * @param {() => void} [o.register]  その場の登録欄を開く
 * @param {'left'|'right'} [o.align]
 */
export function keySelect({ keys, current, label, focusKey, choose, provider, register, align = 'right' }) {
  const cur = keys.find(k => k.id === current);
  const text = cur ? keyName(cur) : t('apiKeys.select.none');
  const wrap = el('span', 'ak-selwrap');
  const btn = el('button', 'ak-selbtn'); btn.type = 'button';
  btn.setAttribute('aria-haspopup', 'listbox'); btn.setAttribute('aria-expanded', 'false');
  btn.setAttribute('aria-label', `${label}: ${text}`);
  if (focusKey) btn.dataset.fk = focusKey;
  btn.append(el('span', 'ak-seltxt', text), chev());
  wrap.append(btn);
  let pop = null;
  // 描き直しで外れていたら、開いたままの外側クリックの監視を残さず閉じる
  const onDoc = e => { if (pop && (!wrap.isConnected || !wrap.contains(e.target))) close(false); };
  function close(refocus) {
    if (!pop) return;
    pop.remove(); pop = null; btn.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', onDoc, true);
    if (refocus) btn.focus();
  }
  function pick(id) { close(false); btn.focus(); choose(id); }
  function open() {
    if (pop) { close(true); return; }
    pop = el('div', 'pop ak-pop' + (align === 'left' ? ' left' : ''));
    pop.setAttribute('role', 'listbox'); pop.setAttribute('aria-label', label);
    const opts = [];
    const item = (name, hint, on, act) => {
      const li = el('button', 'li' + (on ? ' on' : '')); li.type = 'button'; li.setAttribute('role', 'option'); li.setAttribute('aria-selected', String(on)); li.tabIndex = -1;
      li.append(el('span', 'lbl', name)); if (hint) li.append(el('span', 'hint', hint));
      li.onclick = act; opts.push(li); return li;
    };
    for (const k of keys) {
      const c = k.lastCheck;
      pop.append(item(keyName(k), c && c.ok === false ? t('apiKeys.select.failedHint') : c?.ok ? t('apiKeys.select.checkedHint', { when: when(c.at) }) : '', k.id === current, () => pick(k.id)));
    }
    if (keys.length) pop.append(el('div', 'sep'));
    pop.append(item(t('apiKeys.select.none'), '', !cur, () => pick(null)));
    if (!keys.length && register) {
      pop.append(el('div', 'sep'));
      pop.append(item(t('apiKeys.select.register', { provider: providerName(provider) || provider }), '', false, () => { close(false); btn.focus(); register(); }));
    }
    wrap.append(pop);
    btn.setAttribute('aria-expanded', 'true');
    document.addEventListener('pointerdown', onDoc, true);
    (opts.find(x => x.classList.contains('on')) ?? opts[0]).focus();
    pop.onkeydown = e => {
      const i = opts.indexOf(document.activeElement);
      if (e.key === 'ArrowDown') { e.preventDefault(); opts[(i + 1) % opts.length].focus(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); opts[(i - 1 + opts.length) % opts.length].focus(); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(true); }
      else if (e.key === 'Tab') close(false);
    };
  }
  btn.onclick = open;
  btn.onkeydown = e => { if (e.key === 'ArrowDown' && !pop) { e.preventDefault(); open(); } };
  return { element: wrap, button: btn, open: () => { if (!pop) open(); } };
}

/** 値を打つ欄（伏せ字＋表示/隠す）。値は呼び出し側が submit で受け取ったら捨てる */
export function keyInput({ ariaLabel, placeholder = '', focusKey = '' }) {
  const input = el('input'); input.type = 'password'; input.autocomplete = 'new-password'; input.spellcheck = false; input.placeholder = placeholder;
  input.setAttribute('aria-label', ariaLabel);
  if (focusKey) input.dataset.fk = focusKey;
  const show = el('button', 'btn', t('apiKeys.show')); show.type = 'button';
  show.onclick = () => { input.type = input.type === 'password' ? 'text' : 'password'; show.textContent = input.type === 'password' ? t('apiKeys.show') : t('apiKeys.hide'); };
  const row = el('div', 'mp-keyrow'); row.append(input, show);
  return { row, input };
}

/**
 * その場の登録欄（通話・委譲の「＋ キーを登録…」）。登録先は API キー。
 * @param {object} o  { provider, label（読み上げ）, storage, onSubmit(value), onCancel, focusKey }
 */
export function registerForm({ provider, label, storage, onSubmit, onCancel, focusKey }) {
  const form = el('form', 'rt-key-form'); form.setAttribute('aria-label', label);
  const { row, input } = keyInput({ ariaLabel: label, placeholder: provider === 'cerebras' ? 'csk-…' : 'sk-or-…', focusKey });
  const submit = el('button', 'btn btn-primary', t('apiKeys.register.useNow')); submit.type = 'submit';
  const cancel = el('button', 'btn', t('apiKeys.cancel')); cancel.type = 'button'; cancel.onclick = () => onCancel();
  const actions = el('div', 'mp-card-actions'); actions.append(cancel, submit);
  form.append(row, el('small', 'ak-cost', t('apiKeys.register.hint')));
  const warn = notEncryptedNote(storage); if (warn) form.append(warn);
  form.append(actions);
  form.onsubmit = e => { e.preventDefault(); const v = input.value.trim(); input.value = ''; if (v) onSubmit(v); };
  form.onkeydown = e => { if (e.key === 'Escape') { e.stopPropagation(); onCancel(); } };
  return form;
}

/** 描き直しの前後でフォーカスを戻す（data-fk の印）。root の中にフォーカスがあったときだけ */
export function keepFocus(root, wanted = null) {
  const fk = wanted ?? (root.contains(document.activeElement) ? document.activeElement.dataset?.fk : null);
  return () => { if (!fk) return; const target = root.querySelector(`[data-fk="${CSS.escape(fk)}"]`); target?.focus({ preventScroll: true }); };
}

/** 使っているキーの管理へのリンク（設定 › API キーへ移る） */
export function manageLink(openPage) {
  const b = el('button', 'ak-link', t('apiKeys.manage')); b.type = 'button'; b.onclick = () => openPage('apiKeys');
  return b;
}
