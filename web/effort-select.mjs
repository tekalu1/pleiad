// 設定 › 委譲の「思考の強さ」の選択（段の見出しの「段の既定」と、候補の行の「思考 medium · 段の既定」。docs/design-system.md「設定 › 委譲」）。
// pill のボタン + リストボックス（設定 › API キーの「使うキー」＝ web/api-key-ui.mjs の keySelect と同じ作り。開閉 240ms・↑↓・Esc）。
// 値の決め方・選択肢は web/delegation-effort.mjs（DOM を触らない）。ここは描くだけで、選んだ値は pick(value) で返す。
import { el } from './dom.mjs';
import { t } from './i18n.mjs';
import { CHEV } from './api-key-ui.mjs';

const chev = () => { const s = el('span', 'ef-chev'); s.setAttribute('aria-hidden', 'true'); s.innerHTML = CHEV; return s; };

/**
 * pill とリストボックス。
 *   parts   … pill に並べる文字 [{ text, cls? }]（「思考」「medium」「段の既定」など）
 *   label   … ボタンのアクセシブルな名前（値まで含める）と、リストボックスの名前
 *   head    … リストボックスの見出し
 *   rows    … [{ label, hint?, on?, pick }] か { sep: true } か { foot: 文 }
 *   changed … 既定から外した値（青い字）
 *   align   … 'right'（既定。右端に揃える）| 'left'
 *   focusKey… 描き直した後にフォーカスを戻すための印（data-fk）
 */
export function effortSelect({ parts, label, head, rows, changed = false, align = 'right', focusKey = '' }) {
  const wrap = el('span', 'ef-wrap');
  const btn = el('button', 'ef-btn' + (changed ? ' changed' : ''));
  btn.type = 'button';
  btn.setAttribute('aria-haspopup', 'listbox'); btn.setAttribute('aria-expanded', 'false');
  btn.setAttribute('aria-label', label);
  if (focusKey) btn.dataset.fk = focusKey;
  for (const p of parts) btn.append(el('span', p.cls ?? 'ef-l', p.text));
  btn.append(chev());
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
  function open() {
    if (pop) { close(true); return; }
    pop = el('div', 'pop ef-pop' + (align === 'left' ? ' left' : ''));
    pop.setAttribute('role', 'listbox'); pop.setAttribute('aria-label', label);
    if (head) pop.append(el('div', 'head wrap', head));
    const opts = [];
    for (const r of rows) {
      if (r.sep) { pop.append(el('div', 'sep')); continue; }
      if (r.foot) { pop.append(el('div', 'ef-foot', r.foot)); continue; }
      const li = el('button', 'li' + (r.on ? ' on' : '')); li.type = 'button'; li.setAttribute('role', 'option'); li.setAttribute('aria-selected', String(Boolean(r.on))); li.tabIndex = -1;
      li.append(el('span', 'lbl', r.label)); if (r.hint) li.append(el('span', 'hint', r.hint));
      li.onclick = () => { close(false); r.pick(); };
      pop.append(li); opts.push(li);
    }
    wrap.append(pop);
    btn.setAttribute('aria-expanded', 'true');
    document.addEventListener('pointerdown', onDoc, true);
    (opts.find(x => x.classList.contains('on')) ?? opts[0])?.focus();
    pop.onkeydown = e => {
      const i = opts.indexOf(document.activeElement);
      if (e.key === 'ArrowDown') { e.preventDefault(); opts[Math.min(opts.length - 1, i + 1)].focus(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); opts[Math.max(0, i - 1)].focus(); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(true); }
      else if (e.key === 'Tab') close(false);
    };
  }
  btn.onclick = open;
  btn.onkeydown = e => { if (e.key === 'ArrowDown' && !pop) { e.preventDefault(); open(); } };
  return { element: wrap, button: btn, open: () => { if (!pop) open(); } };
}

/** 選べない候補の表示（選択は出さず、理由を 1 語）。value があれば「思考 high · モデル名で決まる」、無ければ「思考 調整なし」 */
export function effortFixed({ value = '', reason, title }) {
  const s = el('span', 'ef-fixed');
  s.title = title;
  s.append(el('span', 'ef-l', t('routing.effort.label')));
  if (value) s.append(el('b', null, value), el('small', null, reason));
  else s.append(el('span', 'ef-none', reason));
  return s;
}
