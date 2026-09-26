// ==================== 設定 › コンテキスト「指示」のカードの「Pleiad の指示」（docs/design-system.md「コンテキスト」） ====================
// Pleiad が会話に毎ターン入れる指示の一覧（core/ply-instructions.mjs）。すべての場所に共通で、ファイルの担当によらない。
//   行: 並べ替えの取っ手（入る順）・名前・札（既定／既定から変更／委譲と連動）・入れる会話（弱い字）・スイッチ。
//   押すと下に中身（Markdown）と「編集」「削除」（既定は「既定に戻す」。委譲と連動は「設定 › 委譲で変える →」だけ）。
//   「＋ 指示を追加」と「編集」は同じシート（<dialog>。外部 MCP の追加シートと同じ形）。
// 変更はその場で保存し（setPlyInstructions）、カードの知らせ「保存しました · 次のターンから反映」を出す。
import { el } from './dom.mjs';
import { t, fmt } from './i18n.mjs';
import { renderMarkdown } from './render.mjs';
import { estimateTokens } from './token-estimate.mjs';

const AGENTS = [['claude', 'Claude Code'], ['codex', 'Codex']];
const TARGETS = ['all', 'parent', 'child'];
const NAME_SLOT = '\u0001';   // core/ply-instructions.mjs の見出しの型の、名前の位置
const HEAVY = 4000;           // これを超えたら弱い警告の一行（毎ターン入るので）

function button(text, className = 'btn', onClick) {
  const b = el('button', className, text);
  b.type = 'button';
  if (onClick) b.onclick = onClick;
  return b;
}
const plus = () => {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('aria-hidden', 'true');
  s.innerHTML = '<path d="M12 5v14M5 12h14"/>';
  return s;
};
const grip = () => {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 8 14'); s.setAttribute('aria-hidden', 'true');
  s.innerHTML = [2, 7, 12].map(y => `<circle cx="2" cy="${y}" r="1.3"/><circle cx="6" cy="${y}" r="1.3"/>`).join('');
  return s;
};

// i18n-dynamic: context.ply.target.
// i18n-dynamic: context.ply.targetOpt.
export function createPlyInstructions({ cmd, work, saved, openDelegation, opened }) {
  const root = el('div', 'cx-block cx-ply');
  let state = null, dragId = null;
  const key = id => `ply:${id}`;

  async function load() {
    state = await cmd('plyInstructions', {}).catch(() => null);
    render();
  }
  async function change(args, focus) {
    state = await cmd('setPlyInstructions', args);
    saved();
    render();
    if (focus) root.querySelector(focus)?.focus();
  }
  const movable = () => state.items.filter(i => i.tag !== 'linked');
  const order = ids => work(() => change({ action: 'order', ids }));
  const heading = name => String(state?.heading ?? NAME_SLOT).replace(NAME_SLOT, name);

  function render() {
    root.replaceChildren();
    const sec = el('div', 'cx-sec');
    const title = el('span', 'n', t('context.ply.title'));
    title.id = 'cxPlyTitle';
    sec.append(title, el('span', 'r', state ? t('context.ply.scope', { tokens: fmt.number(state.total) }) : t('context.ply.scopePlain')));
    root.append(sec);
    if (!state) { root.append(el('p', 'cx-empty', t('context.ply.unavailable'))); return; }
    const list = el('div', 'cx-list');
    list.setAttribute('role', 'group'); list.setAttribute('aria-labelledby', title.id);
    for (const item of state.items) {
      list.append(row(item));
      if (opened.has(key(item.id))) list.append(peek(item));
    }
    const add = button('', 'cx-add', () => openSheet(null, add));
    add.append(plus(), document.createTextNode(t('context.ply.add')));
    list.append(add);
    root.append(list);
    if (state.total > HEAVY) root.append(el('p', 'cx-sub', t('context.ply.heavy')));
  }

  function row(item) {
    const linked = item.tag === 'linked', off = !item.on || (linked && !state.routing);
    const r = el('div', 'cx-row' + (off ? ' off' : ''));
    r.dataset.id = item.id;
    if (linked) { const gap = el('span', 'cx-grip-gap'); gap.setAttribute('aria-hidden', 'true'); r.append(gap); }
    else {
      r.draggable = true;
      const g = button('', 'cx-grip');
      g.append(grip());
      g.setAttribute('aria-label', t('context.ply.gripAria', { name: item.name }));
      g.title = t('context.ply.gripTitle');
      g.onkeydown = e => {
        if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
        e.preventDefault();
        const ids = movable().map(i => i.id), i = ids.indexOf(item.id), j = i + (e.key === 'ArrowUp' ? -1 : 1);
        if (j < 0 || j >= ids.length) return;
        [ids[i], ids[j]] = [ids[j], ids[i]];
        work(() => change({ action: 'order', ids }, `.cx-row[data-id="${item.id}"] .cx-grip`));
      };
      r.append(g);
    }
    const open = button('', 'cx-open');
    open.setAttribute('aria-expanded', String(opened.has(key(item.id))));
    const body = el('span', 't');
    const nm = el('span', 'nm', item.name);
    const badge = item.tag === 'default' ? (item.modified ? t('context.ply.badge.modified') : t('context.ply.badge.default')) : linked ? t('context.ply.badge.linked') : '';
    if (badge) nm.append(el('span', 'cbadge', badge));
    const only = item.agents.length === AGENTS.length ? '' : t('context.ply.onlyAgent', { agent: item.agents.map(a => AGENTS.find(([id]) => id === a)?.[1] ?? a).join(t('context.ply.agentJoin')) });
    const sub = [t(`context.ply.target.${item.target}`), only, linked && !state.routing ? t('context.ply.routingOff') : ''].filter(Boolean).join(' · ');
    body.append(nm, el('span', 'p', sub));
    open.append(body);
    open.onclick = () => {
      if (opened.has(key(item.id))) opened.delete(key(item.id)); else opened.add(key(item.id));
      render();
      root.querySelector(`.cx-row[data-id="${item.id}"] .cx-open`)?.focus();
    };
    r.append(open);
    if (!linked) {
      const sw = button('', 'cx-sw');
      sw.setAttribute('role', 'switch'); sw.setAttribute('aria-checked', String(item.on)); sw.setAttribute('aria-label', t('context.ply.switchAria', { name: item.name }));
      sw.onclick = () => { sw.setAttribute('aria-checked', String(!item.on)); work(() => change({ action: 'toggle', id: item.id, on: !item.on }, `.cx-row[data-id="${item.id}"] .cx-sw`)); };
      r.append(sw);
    }
    return r;
  }

  function peek(item) {
    const box = el('div', 'cx-peek');
    const text = el('div', 'body');
    text.innerHTML = renderMarkdown(item.body);
    const acts = el('div', 'acts');
    if (item.tag === 'linked') acts.append(button(t('context.ply.gotoDelegation'), 'cx-link', () => openDelegation?.()));
    else {
      const edit = button(t('context.ply.edit'), 'btn btn-quiet', () => openSheet(item, edit));
      acts.append(edit);
      if (item.tag === 'default') { if (item.modified) acts.append(button(t('context.ply.reset'), 'btn', () => work(() => change({ action: 'reset', id: item.id })))); }
      else {
        // 取り消せないので 2 回押して消す（外部 MCP の削除と同じ）
        const del = button(t('context.ply.delete'), 'btn');
        let armed = null;
        del.onclick = () => {
          if (!armed) { del.textContent = t('context.ply.deleteConfirm'); armed = setTimeout(() => { armed = null; del.textContent = t('context.ply.delete'); }, 3000); return; }
          clearTimeout(armed);
          opened.delete(key(item.id));
          work(() => change({ action: 'delete', id: item.id }, '.cx-ply .cx-add'));
        };
        acts.append(del);
      }
    }
    box.append(text, acts);
    return box;
  }

  // ---- ドラッグで並べ替え（連動の行は動かさない・その上に落とさない）
  const dragRow = target => { const r = target?.closest?.('.cx-row[draggable=true]'); return r && root.contains(r) ? r : null; };
  const clearDrop = () => root.querySelectorAll('.drop-before,.dragging').forEach(x => x.classList.remove('drop-before', 'dragging'));
  root.addEventListener('dragstart', e => {
    const r = dragRow(e.target);
    if (!r) return;
    dragId = r.dataset.id; r.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', dragId);
  });
  root.addEventListener('dragover', e => {
    const r = dragRow(e.target);
    if (!dragId || !r) return;
    e.preventDefault();
    root.querySelectorAll('.drop-before').forEach(x => x.classList.remove('drop-before'));
    if (r.dataset.id !== dragId) r.classList.add('drop-before');
  });
  root.addEventListener('drop', e => {
    const r = dragRow(e.target);
    if (!dragId || !r) return;
    e.preventDefault();
    const ids = movable().map(i => i.id).filter(id => id !== dragId);
    ids.splice(ids.indexOf(r.dataset.id), 0, dragId);
    dragId = null; clearDrop();
    order(ids);
  });
  root.addEventListener('dragend', () => { dragId = null; clearDrop(); });

  // ---- 追加・編集のシート
  function openSheet(item, returnTo) {
    document.querySelector('dialog.ply-sheet')?.remove();
    const dialog = el('dialog', 'mcp-sheet ply-sheet');
    const form = el('form');
    const titleText = item ? t('context.ply.sheet.editTitle') : t('context.ply.sheet.addTitle');
    const head = el('h3', null, titleText);
    head.id = 'plySheetTitle'; head.tabIndex = -1;
    dialog.setAttribute('aria-labelledby', head.id);
    const nameField = el('label', 'mcp-field');
    const name = el('input'); name.value = item?.name ?? ''; name.placeholder = t('context.ply.sheet.namePlaceholder'); name.autocomplete = 'off';
    nameField.append(t('context.ply.sheet.name'), name);
    const bodyField = el('label', 'mcp-field');
    const body = el('textarea'); body.rows = 7; body.spellcheck = false; body.value = item?.body ?? '';
    const count = el('span', 'cnt');
    bodyField.append(t('context.ply.sheet.body'), body, count);
    const paintCount = () => { count.textContent = t('context.ply.sheet.tokens', { tokens: fmt.number(estimateTokens(`${heading(name.value.trim())}\n${body.value.trim()}`)) }); };
    // 入れる会話（1 つ選ぶ）
    let target = item?.target ?? 'all';
    const targetField = el('div', 'mcp-field');
    const targetLabel = el('span', null, t('context.ply.sheet.target')); targetLabel.id = 'plySheetTarget';
    const targetChips = el('div', 'cx-chips'); targetChips.setAttribute('role', 'radiogroup'); targetChips.setAttribute('aria-labelledby', targetLabel.id);
    const targetButtons = TARGETS.map(id => {
      const b = button(t(`context.ply.targetOpt.${id}`), 'cx-chip', () => { target = id; paint(); });
      b.setAttribute('role', 'radio'); b.dataset.v = id;
      targetChips.append(b);
      return b;
    });
    targetField.append(targetLabel, targetChips);
    // エージェント（1 つ以上）。Antigravity は会話ごとの指示を渡す口が無いので選べない
    let agents = item ? [...item.agents] : AGENTS.map(([id]) => id);
    const agentField = el('div', 'mcp-field');
    const agentLabel = el('span', null, t('context.ply.sheet.agents')); agentLabel.id = 'plySheetAgents';
    const agentChips = el('div', 'cx-chips'); agentChips.setAttribute('role', 'group'); agentChips.setAttribute('aria-labelledby', agentLabel.id);
    const agentButtons = AGENTS.map(([id, label]) => {
      const b = button(label, 'cx-chip', () => {
        agents = agents.includes(id) ? (agents.length > 1 ? agents.filter(a => a !== id) : agents) : [...agents, id];
        paint();
      });
      b.dataset.v = id;
      agentChips.append(b);
      return b;
    });
    const agy = button('Antigravity', 'cx-chip');
    agy.disabled = true; agy.setAttribute('aria-pressed', 'false'); agy.setAttribute('aria-describedby', 'plySheetAgy');
    agentChips.append(agy);
    const why = el('p', null, t('context.ply.sheet.agyWhy')); why.id = 'plySheetAgy';
    agentField.append(agentLabel, agentChips, why);
    const error = el('p', 'mcp-error'); error.setAttribute('role', 'alert');
    const acts = el('div', 'mcp-acts');
    const go = button(t('context.ply.sheet.save'), 'btn btn-primary'); go.type = 'submit';
    acts.append(button(t('context.cancel'), 'btn', () => dialog.close()), go);
    form.append(head, nameField, bodyField, targetField, agentField, error, acts);
    dialog.append(form);
    function paint() {
      for (const b of targetButtons) b.setAttribute('aria-checked', String(b.dataset.v === target));
      for (const b of agentButtons) b.setAttribute('aria-pressed', String(agents.includes(b.dataset.v)));
    }
    name.oninput = paintCount;
    body.oninput = paintCount;
    form.onsubmit = async e => {
      e.preventDefault();
      error.textContent = '';
      if (!name.value.trim()) { error.textContent = t('context.ply.sheet.nameRequired'); name.focus(); return; }
      if (!body.value.trim()) { error.textContent = t('context.ply.sheet.bodyRequired'); body.focus(); return; }
      go.disabled = true;
      try {
        await change({ action: 'save', ...(item ? { id: item.id } : {}), name: name.value.trim(), body: body.value.trim(), target, agents });
        if (item) opened.add(key(item.id));
        dialog.close();
        render();
      } catch (err) { error.textContent = err.message; }
      finally { go.disabled = false; }
    };
    dialog.addEventListener('close', () => {
      dialog.remove();
      (returnTo?.isConnected ? returnTo : item ? root.querySelector(`.cx-row[data-id="${item.id}"] .cx-open`) : root.querySelector('.cx-add'))?.focus();
    });
    document.body.append(dialog);
    paint(); paintCount();
    dialog.showModal();
    (item ? head : name).focus();
  }

  return { root, load, render };
}
