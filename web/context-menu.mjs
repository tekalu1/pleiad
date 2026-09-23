import { isComposingKey } from "./keyboard.mjs";
import { el } from "./dom.mjs";
import { t } from "./i18n.mjs";

/** One menu chain, shared by pointer, touch, and keyboard. */
export function createContextMenu() {
  let panels = [], opener, openTimer, closeTimer;
  // Pointer hover must not destroy the field that owns keyboard focus.
  const editing = () => panels.some(p => p.contains(document.activeElement) && document.activeElement?.matches('input, textarea, [contenteditable]'));
  const cancelTimers = () => { clearTimeout(openTimer); clearTimeout(closeTimer); };
  function scheduleTrim(depth) {
    cancelTimers();
    closeTimer = setTimeout(() => { if (!editing()) trim(depth); }, 250);
  }
  const buttons = panel => [...panel.querySelectorAll(':scope > button, :scope > input')];
  function trim(depth) {
    for (const p of panels.splice(depth)) { p.trigger?.setAttribute('aria-expanded', 'false'); p.remove(); }
  }
  function close(restore = false) {
    clearTimeout(openTimer); clearTimeout(closeTimer); trim(0);
    document.removeEventListener('pointerdown', outside, true);
    document.removeEventListener('keydown', key, true);
    if (restore && opener?.isConnected) opener.focus({ preventScroll: true });
  }
  function outside(e) { if (!panels.some(p => p.contains(e.target))) close(); }
  function key(e) {
    if (isComposingKey(e)) return;
    const panel = panels.find(p => p.contains(e.target)) ?? panels.at(-1);
    if (!panel) return;
    const depth = panels.indexOf(panel), rows = buttons(panel), at = rows.indexOf(document.activeElement);
    if (e.key === 'Escape') { e.preventDefault(); if (depth > 0) { const trigger = panel.trigger; trim(depth); trigger.focus(); } else close(true); }
    else if (e.key === 'ArrowLeft' && depth > 0 && e.target.tagName !== 'INPUT') { e.preventDefault(); const trigger = panel.trigger; trim(depth); trigger.focus(); }
    else if (e.key === 'ArrowRight' && document.activeElement?.openSub) { e.preventDefault(); document.activeElement.openSub(true); }
    else if (['ArrowDown','ArrowUp','Home','End'].includes(e.key) && e.target.tagName !== 'INPUT') {
      e.preventDefault();
      const next = e.key === 'Home' ? 0 : e.key === 'End' ? rows.length - 1 : (at + (e.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length;
      rows[next]?.focus();
    }
  }
  function panelAt(items, title, depth, x, y, trigger) {
    trim(depth);
    const panel = el('div', 'pop menu');
    panel.setAttribute('role', 'menu'); panel.trigger = trigger;
    if (title) panel.append(el('div', 'head', title));
    panel.onpointerenter = () => { clearTimeout(closeTimer); };
    panel.onfocusin = cancelTimers;
    panel.onpointerleave = e => {
      clearTimeout(openTimer);
      if (panels.some(p => p.contains(e.relatedTarget))) return;
      scheduleTrim(1);
    };
    for (const item of items) {
      if (item.sep) { panel.append(el('div', 'sep')); continue; }
      if (item.input) {
        const input = el('input', 'field');
        input.placeholder = item.input.placeholder ?? ''; input.value = item.input.value ?? '';
        input.setAttribute('aria-label', input.placeholder || title || t('common.input'));
        input.onkeydown = e => { if (isComposingKey(e)) return; if (e.key === 'Enter') { e.preventDefault(); const v = input.value.trim(); if (v) { close(true); item.input.onCommit(v); } } };
        panel.append(input); continue;
      }
      const row = el('button', 'li' + (item.checked ? ' on' : ''));
      row.type = 'button'; row.setAttribute('role', 'menuitem');
      // 今は押せない項目（タイトル行の「…」のタイトルを生成: 生成中・未送信など）
      if (item.disabled) { row.disabled = true; row.setAttribute('aria-disabled', 'true'); }
      row.append(el('span', 'lbl', item.label));
      if (item.hint) row.append(el('span', 'hint', item.hint));
      if (item.sub) {
        row.append(el('span', 'more', '▸'));
        row.setAttribute('aria-haspopup', 'menu'); row.setAttribute('aria-expanded', 'false');
        row.openSub = focus => {
          clearTimeout(openTimer); clearTimeout(closeTimer);
          if (panels[depth + 1]?.trigger !== row) {
            const r = row.getBoundingClientRect();
            const sub = panelAt(item.sub(), item.label, depth + 1, r.right + 6, r.top, row);
            row.setAttribute('aria-expanded', 'true');
            if (focus) buttons(sub)[0]?.focus();
          } else if (focus) buttons(panels[depth + 1])[0]?.focus();
        };
        row.onpointerenter = e => { if (e.pointerType === 'touch') return; cancelTimers(); openTimer = setTimeout(() => { if (!editing()) row.openSub(false); }, 150); };
        row.onfocus = () => { clearTimeout(closeTimer); };
        // 指で開いたときは中へフォーカスを移さない（先頭が入力欄だとキーボードが勝手に出る）
        row.onclick = e => row.openSub(e?.pointerType !== 'touch');
      } else {
        row.onpointerenter = () => { scheduleTrim(depth + 1); };
        row.onclick = () => { close(true); item.onClick?.(); };
      }
      panel.append(row);
    }
    document.body.append(panel); panels.push(panel);
    const r = panel.getBoundingClientRect();
    if (trigger && x + r.width > innerWidth - 8) {
      // 右に入らなければ左へ返す。左にも入らない狭い画面（スマホ）では、押した行の下へ少しずらして重ねる
      const tr = trigger.getBoundingClientRect();
      if (tr.left - r.width - 6 >= 8) x = tr.left - r.width - 6;
      else { x = tr.left + 12; y = tr.bottom + 2; }
    }
    panel.style.left = `${Math.max(8, Math.min(x, innerWidth - r.width - 8))}px`;
    panel.style.top = `${Math.max(8, Math.min(y, innerHeight - r.height - 8))}px`;
    return panel;
  }
  return { close, open(x, y, items, title) {
    close(); opener = document.activeElement;
    const panel = panelAt(items, title, 0, x, y);
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('keydown', key, true);
    buttons(panel)[0]?.focus({ preventScroll: true });
  } };
}
