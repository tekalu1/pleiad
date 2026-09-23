// ==================== 設定 › コンテキスト（docs/mockups/context-unified.html の②） ====================
// 新しい会話を始めるときに、エージェントへ何を渡すかを種類ごと（指示・Skills・外部 MCP）に決める 1 画面。
// 範囲は「全体の設定」か場所ごと。開いたときは全体の設定で、場所の設定はプルダウンでその場所を選んだときだけ作る。
// 場所では種類ごとに「全体の設定どおり／このフォルダーだけの設定」。全体の設定を見ているときも、今の会話のフォルダーで
// フォルダーだけの設定が効いている種類には印と「全体の設定に戻す」を出す。
// 変更はその場で保存し（setContextSettings）、「保存しました · 次のターンから反映」を出す。始まっている会話にも次のターンから効く。
// 設定の形と継承は core/context-settings.mjs、外部 MCP のカードの中身と追加シートは web/mcp-config.mjs。
import { el } from './dom.mjs';
import { runMark } from './arc.mjs';
import { renderMarkdown } from './render.mjs';
import { copyIcon, trashIcon } from './icons.mjs';
import { createMcpSection } from './mcp-config.mjs';
import { t } from './i18n.mjs';

const KINDS = ['instruction', 'skill', 'mcp'];
const TEXT = {
  instruction: {
    title: t('context.instruction.title'),
    agent: [t('context.owner.agent'), t('context.instruction.agent')],
    ply: [t('context.owner.ply'), t('context.instruction.ply')],
    note: t('context.instruction.note'),
    list: t('context.instruction.list'), listDefault: t('context.instruction.listDefault'),
    sources: [['common', t('context.instruction.sourceCommon')], ['claude', 'CLAUDE.md'], ['codex', t('context.instruction.sourceCodex')]],
  },
  skill: {
    title: 'Skills',
    agent: [t('context.owner.agent'), t('context.skill.agent')],
    ply: [t('context.owner.ply'), t('context.skill.ply')],
    note: t('context.skill.note'),
    list: t('context.skill.list'), listDefault: t('context.skill.listDefault'),
    sources: [['common', t('context.skill.sourceCommon')], ['claude', '.claude/skills'], ['codex', '.codex/skills']],
  },
  mcp: {
    title: t('context.mcp.title'),
    agent: [t('context.owner.agent'), t('context.mcp.agent')],
    ply: [t('context.owner.ply'), t('context.mcp.ply')],
    list: t('context.mcp.list'), listDefault: t('context.mcp.listDefault'),
    sources: [['claude', t('context.mcp.sourceClaude')], ['codex', t('context.mcp.sourceCodex')]],
  },
};
const SHOWN = 8;   // Skills は多いので最初はこれだけ並べ、「すべて見る」で残りを出す

export const pathKey = p => String(p ?? '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
export const within = (dir, file) => pathKey(file) === pathKey(dir) || pathKey(file).startsWith(pathKey(dir) + '/');
function button(text, className = 'btn', onClick) {
  const b = el('button', className, text);
  b.type = 'button';
  if (onClick) b.onclick = onClick;
  return b;
}
const chevron = () => {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('aria-hidden', 'true');
  s.innerHTML = '<path d="m6 9 6 6 6-6"/>';
  return s;
};
const plus = () => {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('aria-hidden', 'true');
  s.innerHTML = '<path d="M12 5v14M5 12h14"/>';
  return s;
};

/** SKILL.md の frontmatter を単純な key: value だけ切り出す。入れ子・配列は値の文字列のまま出す */
export function frontmatter(text) {
  const src = String(text ?? '');
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(src);
  if (!match) return { meta: [], body: src };
  const meta = [];
  for (const line of match[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_][\w.-]*)\s*:\s*(.*)$/.exec(line);
    if (kv) meta.push([kv[1], kv[2].trim().replace(/^["'](.*)["']$/, '$1')]);
    else if (meta.length && line.trim()) meta[meta.length - 1][1] += ` ${line.trim()}`;
  }
  return { meta, body: src.slice(match[0].length) };
}

/** 中身の確認（行を押すと下に開く）。指示は Markdown、Skill は frontmatter の表と本文 */
export function peekDocument(entry, { short = p => p } = {}) {
  const box = el('div', 'cx-peek');
  const line = el('div', 'row-line');
  line.append(el('span', 'cx-path', short(entry.path)));
  const copy = button('', 'btn btn-icon');
  copy.innerHTML = copyIcon; copy.title = t('context.copyPath'); copy.setAttribute('aria-label', t('context.copyPath'));
  copy.onclick = () => navigator.clipboard?.writeText(entry.path).then(() => { copy.title = t('context.copied'); }).catch(() => {});
  line.append(copy);
  box.append(line);
  const { meta, body } = entry.kind === 'skill' ? frontmatter(entry.content) : { meta: [], body: entry.content ?? '' };
  if (meta.length) {
    const table = el('div', 'fm');
    for (const [k, v] of meta) table.append(el('span', 'k', k), el('span', 'v', v));
    box.append(table);
  }
  const text = el('div', 'body');
  text.innerHTML = renderMarkdown(body || t('context.emptyFile'));
  box.append(text);
  return box;
}

export function setupContext({ button: openButton, cmd, current, session = () => null, show, recentPlaces = () => [], backends = () => [] }) {
  const panel = document.getElementById('contextPanel');
  panel.classList.add('context');
  panel.replaceChildren();
  const root = el('div', 'cx');
  const lead = el('p', 'cx-lead', t('context.lead'));
  const status = el('p', 'cx-status'); status.setAttribute('role', 'alert');
  // ---- 範囲のプルダウン
  const place = el('div', 'cx-place');
  const combo = button('', 'cx-combo');
  combo.setAttribute('aria-haspopup', 'listbox'); combo.setAttribute('aria-expanded', 'false');
  const comboValue = el('span', 'v');
  combo.append(comboValue, chevron());
  const pop = el('div', 'pop cx-pop'); pop.hidden = true; pop.setAttribute('role', 'listbox'); pop.setAttribute('aria-label', t('context.scope'));
  place.append(el('span', 'cx-sub', t('context.scope')), combo, pop);
  const cards = Object.fromEntries(KINDS.map(k => [k, el('div', 'cx-card')]));
  const rootsFold = el('details', 'cx-fold');
  const toast = el('div', 'cx-toast', t('context.saved')); toast.setAttribute('role', 'status');
  root.append(lead, status, place, cards.instruction, cards.skill, cards.mcp, rootsFold, toast);
  panel.append(root);

  let cwd = null, view = null, level = 'default', scan = null, scanning = false, ply = null, agents = null;
  const opened = new Set();          // 中身を開いている行（id）
  const expanded = new Set();        // 「すべて見る」を押した種類
  let toastTimer, scanTicket = 0;

  const home = () => view?.home ?? '';
  const short = p => {
    const h = home();
    if (h && within(h, p)) return `~${String(p).slice(h.length)}`;
    return String(p ?? '');
  };
  const levelInfo = () => level === 'default' ? view?.defaults : view?.places.find(p => pathKey(p.path) === pathKey(level)) ?? view?.defaults;
  const isDefault = () => level === 'default' || !view?.places.some(p => pathKey(p.path) === pathKey(level));
  const scanCwd = () => isDefault() ? (cwd || home()) : level;

  function saved() {
    status.textContent = '';
    toast.classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('on'), 1800);
  }
  async function work(fn) {
    try { await fn(); }
    catch (e) { status.textContent = t('context.saveFailed', { error: e.message }); }
  }

  // ---------------------------------------------------------------- 保存（その場で）
  /** 今の範囲の、この種類の設定を書き換えて保存する。場所で上書きが無ければ、受け継いでいた値を写してから変える */
  async function saveKind(kind, mutate, { rescan = true } = {}) {
    const value = structuredClone(levelInfo().kinds[kind].value);
    mutate(value);
    view = await cmd('setContextSettings', { cwd, place: isDefault() ? null : level, kind, value });
    saved();
    renderAll();
    if (rescan) await loadScan();
  }
  async function resetKind(kind, at = level) {
    view = await cmd('setContextSettings', { cwd, place: at, kind, value: null });
    saved();
    renderAll();
    await loadScan();
  }
  async function saveRoots(roots) {
    view = await cmd('setContextSettings', { cwd, place: isDefault() ? null : level, roots });
    saved();
    renderAll();
    await loadScan();
  }

  // ---------------------------------------------------------------- 範囲のプルダウン
  const placeLabel = info => info.id === 'default' ? t('context.place.default') : info.path;
  function placeSub(info) {
    if (info.id === 'default') return t('context.place.defaultSub');
    const bits = [];
    if (info.current) bits.push(t('context.place.current'));
    bits.push(info.overrides ? t('context.place.overrides', { count: info.overrides }) : t('context.place.allDefault'));
    return bits.join(' · ');
  }
  function renderCombo() {
    comboValue.textContent = view ? placeLabel(levelInfo()) : '';
    combo.title = comboValue.textContent;
    combo.disabled = !view;
  }
  function option(info) {
    const b = button('', 'cx-opt2');
    b.setAttribute('role', 'option');
    const selected = info.id === 'default' ? isDefault() : !isDefault() && pathKey(info.path) === pathKey(level);
    b.setAttribute('aria-selected', String(selected));
    b.append(el('span', 'v', placeLabel(info)), el('span', 's', placeSub(info)));
    b.onclick = () => { level = info.id === 'default' ? 'default' : info.path; closePop(); opened.clear(); expanded.clear(); renderAll(); loadScan(); };
    return b;
  }
  /** 保存した場所には「この場所の設定を消す」を添える（今の会話の場所でも、上書きが無ければ保存していないので出さない） */
  function placeRow(info) {
    const opt = option(info);
    if (!info.saved) return opt;
    const row = el('div', 'cx-optrow');
    const del = button('', 'cx-optdel');
    del.innerHTML = trashIcon;
    del.title = t('context.place.remove');
    del.setAttribute('aria-label', t('context.place.removeAria', { path: info.path }));
    del.onclick = e => { e.stopPropagation(); const box = confirmRemove(info, row); row.replaceWith(box); box.querySelector('button')?.focus(); };
    row.append(opt, del);
    return row;
  }
  /** 消す前の確認。プルダウンの中のその行を置き換える */
  function confirmRemove(info, row) {
    const box = el('div', 'cx-confirm');
    box.setAttribute('role', 'group'); box.setAttribute('aria-label', t('context.place.remove'));
    const text = el('div', 't');
    text.append(el('b', null, t('context.place.confirm')), el('span', 'v', info.path),
      el('span', 'cx-sub', info.overrides
        ? t('context.place.confirmOverrides', { count: info.overrides })
        : t('context.place.confirmPlain')));
    const error = el('p', 'err'); error.setAttribute('role', 'alert');
    const acts = el('div', 'acts');
    const cancel = button(t('context.cancel'), 'btn', () => { box.replaceWith(row); row.querySelector('.cx-optdel')?.focus(); });
    const ok = button(t('context.place.removeButton'), 'btn btn-primary', async () => {
      ok.disabled = cancel.disabled = true;
      try { await removePlace(info); }
      catch (e) { error.textContent = t('context.place.removeFailed', { error: e.message }); ok.disabled = cancel.disabled = false; }
    });
    acts.append(cancel, ok);
    box.append(text, error, acts);
    return box;
  }
  async function removePlace(info) {
    view = await cmd('setContextSettings', { cwd, place: info.path, remove: true });
    // 選んでいた場所を消した。今の会話の場所なら（上書きの無い場所として）そのまま、それ以外は既定へ
    if (level !== 'default' && pathKey(level) === pathKey(info.path) && !view.places.some(p => pathKey(p.path) === pathKey(level))) level = 'default';
    saved();
    renderPop();
    (pop.querySelector('[aria-selected=true]') ?? pop.querySelector('button'))?.focus();
    opened.clear(); expanded.clear();
    renderAll();
    await loadScan();
  }
  function renderPop() {
    pop.replaceChildren();
    pop.append(option(view.defaults), ...view.places.map(placeRow), el('div', 'gap'));
    const add = button('', 'cx-add');
    add.append(plus(), document.createTextNode(t('context.place.add')));
    const box = el('div', 'cx-addbox'); box.hidden = true;
    const input = el('input'); input.placeholder = t('context.folderPath'); input.setAttribute('aria-label', t('context.place.addAria')); input.autocomplete = 'off'; input.spellcheck = false;
    const cands = el('div', 'cands');
    const error = el('p', 'err'); error.setAttribute('role', 'alert');
    const acts = el('div', 'acts');
    if (window.plyDesktop?.chooseFolder) acts.append(button(t('context.chooseFolder'), 'btn', async () => {
      const picked = await window.plyDesktop.chooseFolder().catch(() => null);
      const chosen = typeof picked === 'string' ? picked : picked?.path ?? picked?.[0];
      if (chosen) { input.value = chosen; paintCands(); input.focus(); }
    }));
    const ok = button(t('context.add'), 'btn btn-primary', () => addPlace(input.value, error));
    acts.append(ok);
    box.append(input, el('p', 'cx-sub', t('context.place.recent')), cands, error, acts);
    const listed = new Set(view.places.map(p => pathKey(p.path)));
    function paintCands() {
      cands.replaceChildren();
      const q = input.value.trim().toLowerCase();
      const list = recentPlaces().filter(c => !listed.has(pathKey(c.value)) && (!q || c.value.toLowerCase().includes(q))).slice(0, 8);
      for (const c of list) {
        const b = button('', 'cx-opt2');
        b.append(el('span', 'v', c.value), el('span', 's', c.hint ?? ''));
        b.onclick = () => { input.value = c.value; paintCands(); input.focus(); };
        cands.append(b);
      }
      if (!list.length) cands.append(el('p', 'cx-sub', q ? t('context.place.noMatch') : t('context.place.noCandidates')));
    }
    input.oninput = () => { error.textContent = ''; paintCands(); };
    input.onkeydown = e => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); addPlace(input.value, error); } };
    add.onclick = () => { add.hidden = true; box.hidden = false; paintCands(); input.focus(); };
    pop.append(add, box);
  }
  async function addPlace(value, error) {
    const target = String(value ?? '').trim();
    if (!target) { error.textContent = t('context.place.pathRequired'); return; }
    try {
      view = await cmd('setContextSettings', { cwd, place: target, add: true });
      level = view.place ?? target;
      closePop(); renderAll(); await loadScan();
    } catch (e) { error.textContent = e.message; }
  }
  function openPop() {
    renderPop();
    pop.hidden = false; combo.setAttribute('aria-expanded', 'true');
    (pop.querySelector('[aria-selected=true]') ?? pop.querySelector('button'))?.focus();
  }
  function closePop(focus = false) {
    if (pop.hidden) return;
    pop.hidden = true; combo.setAttribute('aria-expanded', 'false');
    if (focus) combo.focus();
  }
  combo.onclick = () => (pop.hidden ? openPop() : closePop());
  pop.addEventListener('keydown', e => {
    if (e.isComposing) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closePop(true); return; }
    if (e.target.tagName === 'INPUT') return;
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const items = [...pop.querySelectorAll('button')].filter(b => b.offsetParent);
    const i = items.indexOf(document.activeElement);
    items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
  });
  document.addEventListener('mousedown', e => { if (!pop.hidden && !place.contains(e.target)) closePop(); });

  // ---------------------------------------------------------------- 種類のカード
  /** 場所 at の上に、この種類を個別に変えた場所があるか（あれば「全体の設定に戻す」ではなく「上の設定に戻す」） */
  const parentOverride = (kind, at) => view.places.some(p => p.saved && p.kinds[kind].override && pathKey(p.path) !== pathKey(at) && within(p.path, at));
  const resetLabel = (kind, at) => parentOverride(kind, at) ? t('context.inherit.resetParent') : t('context.inherit.reset');
  function inheritance(kind) {
    const info = levelInfo(), wrap = el('span', 'cx-inh');
    if (isDefault()) {
      // 全体の設定を見ていても、今の会話のフォルダーでフォルダーだけの設定が効いていれば、全体の変更はそこには効かない
      const here = view.places.find(p => p.current), from = here?.kinds[kind].from;
      if (!from) { wrap.textContent = t('context.inherit.all'); return wrap; }
      wrap.classList.add('over');
      wrap.append(t('context.inherit.hereOverride', { path: short(from) }),
        button(resetLabel(kind, from), 'cx-link', () => work(() => resetKind(kind, from))));
      return wrap;
    }
    const k = info.kinds[kind];
    if (k.override) {
      wrap.classList.add('over');
      wrap.append(t('context.inherit.override'), button(resetLabel(kind, level), 'cx-link', () => work(() => resetKind(kind))));
    } else wrap.textContent = `${k.from ? t('context.inherit.from', { path: short(k.from) }) : t('context.inherit.default')}${t('context.inherit.willOverride')}`;
    return wrap;
  }
  function seg(kind, owner) {
    const box = el('div', 'cx-seg'); box.setAttribute('role', 'radiogroup'); box.setAttribute('aria-label', t('context.ownerAria', { kind: TEXT[kind].title }));
    for (const [id, [title, desc]] of [['native', TEXT[kind].agent], ['ply', TEXT[kind].ply]]) {
      const b = button('', 'cx-opt');
      b.setAttribute('role', 'radio'); b.setAttribute('aria-checked', String(owner === id));
      b.append(el('b', null, title), el('span', null, desc));
      b.onclick = () => { if (owner !== id) work(() => saveKind(kind, v => { v.owner = id; }, { rescan: kind === 'mcp' && !agents })); };
      box.append(b);
    }
    return box;
  }
  /** 探す形式の札。user（home）と directory（Git ルート〜作業場所）の両方を同じに変える */
  function sourceChips(kind, value) {
    const box = el('div', 'cx-chips'); box.setAttribute('role', 'group'); box.setAttribute('aria-label', kind === 'mcp' ? t('context.configFiles') : t('context.formats'));
    for (const [id, label] of TEXT[kind].sources) {
      const b = button(label, 'cx-chip');
      // 移行した設定では home と作業場所で違うことがある。どちらかで探していればオン、押すと両方をそろえる
      const on = [value.user, value.directory].some(s => s?.sources.includes(id));
      b.setAttribute('aria-pressed', String(on));
      b.onclick = () => work(() => saveKind(kind, v => {
        for (const scope of ['user', 'directory']) {
          v[scope] ??= { sources: [], excludePaths: [] };
          v[scope].sources = on ? v[scope].sources.filter(s => s !== id) : [...new Set([...v[scope].sources, id])];
        }
      }));
      box.append(b);
    }
    return box;
  }
  function loading() {
    const p = el('p', 'cx-empty');
    p.append(runMark(t('context.searching')), document.createTextNode(' ' + t('context.searchingDots')));
    return p;
  }
  /** 指示・Skills の行。スイッチはこの範囲の除外（その行が見つかった範囲の excludePaths）を出し入れする */
  function documentRows(kind, value) {
    const list = el('div', 'cx-list');
    const entries = (scan?.entries ?? []).filter(e => e.kind === kind);
    if (!entries.length) { list.append(el('p', 'cx-empty', kind === 'skill' ? t('context.skill.none') : t('context.instruction.none'))); return { list, on: 0 }; }
    const shown = kind === 'skill' && !expanded.has(kind) ? entries.slice(0, SHOWN) : entries;
    for (const entry of shown) {
      const off = entry.status === 'excluded';
      const row = el('div', 'cx-row' + (off ? ' off' : ''));
      const open = button('', 'cx-open');
      open.setAttribute('aria-expanded', String(opened.has(entry.id)));
      const body = el('span', 't');
      body.append(el('span', 'nm', entry.name));
      const note = entry.status === 'shadowed' ? t('context.row.shadowed') : entry.status === 'conditional' ? t('context.row.conditional', { paths: entry.paths.join(', ') }) : '';
      body.append(el('span', 'p', kind === 'skill' ? (entry.description || short(entry.path)) : [short(entry.path.replace(/[\\/][^\\/]+$/, '')), note].filter(Boolean).join(' · ')));
      open.append(body);
      open.onclick = () => { if (opened.has(entry.id)) opened.delete(entry.id); else opened.add(entry.id); renderCard(kind); };
      const sw = button('', 'cx-sw');
      sw.setAttribute('role', 'switch'); sw.setAttribute('aria-checked', String(!off)); sw.setAttribute('aria-label', kind === 'skill' ? t('context.row.offerAria', { name: entry.name }) : t('context.row.provideAria', { name: entry.name }));
      sw.onclick = () => { sw.setAttribute('aria-checked', String(off)); work(() => saveKind(kind, v => toggleExclude(v, entry, off))); };
      row.append(open, sw);
      list.append(row);
      if (opened.has(entry.id)) list.append(peekDocument(entry, { short }));
    }
    if (shown.length < entries.length) list.append(button(t('context.showAll', { n: entries.length }), 'btn cx-more-rows', () => { expanded.add(kind); renderCard(kind); }));
    return { list, on: entries.filter(e => e.status !== 'excluded').length };
  }
  /** 除外の出し入れ。入れるときは、その行を含むフォルダーごとの除外も外す（その行だけを戻す方法が無いので） */
  function toggleExclude(value, entry, include) {
    const scope = entry.scope === 'user' ? 'user' : 'directory';
    value[scope] ??= { sources: [], excludePaths: [] };
    const list = value[scope].excludePaths;
    value[scope].excludePaths = include ? list.filter(p => !within(p, entry.path) && !within(p, entry.realPath ?? entry.path)) : [...list, entry.path];
  }
  /**
   * antigravity は、指示も Pleiad がそろえるときだけ Pleiad のコンテキストを受け取る（core/backends/antigravity-context.mjs の contextRefusal）。
   * Pleiad の渡し方（カスタムエージェント）ではワークスペースの AGENTS.md・GEMINI.md を agy が読まなくなるため、
   * 指示がエージェント任せのまま Skills・MCP だけ Pleiad にした組み合わせは、antigravity の会話ではすべてエージェント任せになる
   */
  function antigravityNote(kind, info) {
    if (kind === 'instruction' || !backends().some(b => b.id === 'antigravity')) return null;
    if (info.kinds[kind].value.owner !== 'ply' || info.kinds.instruction.value.owner === 'ply') return null;
    return el('p', 'cx-sub', t('context.antigravityNote'));
  }
  function renderCard(kind) {
    const card = cards[kind], info = levelInfo(), value = info.kinds[kind].value, ply = value.owner === 'ply';
    card.replaceChildren();
    card.dataset.kind = kind;
    const head = el('div', 'cx-khead');
    head.append(el('h4', null, TEXT[kind].title), inheritance(kind));
    card.append(head, seg(kind, value.owner));
    const agy = antigravityNote(kind, info);
    if (agy) card.append(agy);
    if (kind === 'mcp') { mcp.render(card, mcpContext()); return; }
    const plyBlock = el('div', 'cx-block'), agentBlock = el('p', 'cx-note', TEXT[kind].note);
    plyBlock.hidden = !ply; agentBlock.hidden = ply;
    if (ply) {
      plyBlock.append(el('p', 'cx-sub', t('context.formats')), sourceChips(kind, value));
      const label = el('p', 'cx-sub');
      label.append(isDefault() ? TEXT[kind].listDefault : TEXT[kind].list);
      if (!scan) plyBlock.append(label, loading());
      else {
        const { list, on } = documentRows(kind, value);
        label.append(' ', el('span', 'n', t('context.count', { count: on })));
        plyBlock.append(label, list);
      }
    }
    card.append(plyBlock, agentBlock);
  }
  function mcpContext() {
    return { cmd, cwd, scanCwd: scanCwd(), level, isDefault: isDefault(), info: levelInfo(), scan, ply, agents, short, backends: backends(),
      saveKind: (mutate, options) => work(() => saveKind('mcp', mutate, options)), sourceChips: value => sourceChips('mcp', value),
      reload: () => loadScan(), refreshSettings: async () => { view = await cmd('contextSettings', { cwd }); renderAll(); }, toast: saved, status: text => { status.textContent = text; }, rerender: () => renderCard('mcp'),
      opened, loading, work };
  }
  const mcp = createMcpSection();

  // ---------------------------------------------------------------- 探す場所を増やす（任意）
  function renderRoots() {
    const info = levelInfo(), roots = info.roots;
    const wasOpen = rootsFold.open;
    rootsFold.replaceChildren();
    rootsFold.append(el('summary', null, t('context.roots.summary')));
    const card = el('div', 'cx-card cx-roots');
    card.append(el('p', 'cx-sub', isDefault()
      ? t('context.roots.descDefault')
      : t('context.roots.descPlace')));
    if (!isDefault()) {
      const inh = el('p', 'cx-sub');
      if (roots.override) inh.append(t('context.inherit.override'), button(t('context.inherit.reset'), 'cx-link', () => work(() => saveRoots(null))));
      else if (roots.from) inh.append(t('context.inherit.from', { path: short(roots.from) }));
      if (inh.childNodes.length) card.append(inh);
    }
    const list = el('div', 'cx-list');
    for (const p of roots.value) {
      const row = el('div', 'cx-row');
      const body = el('span', 't'); body.append(el('span', 'nm', p));
      const remove = button(t('context.roots.remove'), 'btn', () => work(() => saveRoots(roots.value.filter(r => r !== p))));
      remove.setAttribute('aria-label', t('context.roots.removeAria', { path: p }));
      row.append(body, remove);
      list.append(row);
    }
    if (roots.value.length) card.append(list);
    if (!isDefault() && view.defaults.roots.value.length) card.append(el('p', 'cx-sub', t('context.roots.defaults', { folders: view.defaults.roots.value.join(t('context.roots.join')) })));
    const line = el('div', 'cx-inline');
    const input = el('input'); input.placeholder = t('context.folderPath'); input.setAttribute('aria-label', t('context.roots.addAria')); input.autocomplete = 'off'; input.spellcheck = false;
    const addRoot = value => { const v = String(value ?? '').trim(); if (v) work(() => saveRoots([...roots.value, v])); };
    input.onkeydown = e => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); addRoot(input.value); } };
    line.append(input);
    if (window.plyDesktop?.chooseFolder) line.append(button(t('context.chooseFolder'), 'btn', async () => {
      const picked = await window.plyDesktop.chooseFolder().catch(() => null);
      const chosen = typeof picked === 'string' ? picked : picked?.path ?? picked?.[0];
      if (chosen) input.value = chosen;
    }));
    line.append(button(t('context.roots.add'), 'btn btn-quiet', () => addRoot(input.value)));
    card.append(line);
    // 入力欄には最近の会話の場所を候補として出す
    const cands = el('div', 'cx-chips');
    for (const c of recentPlaces().filter(c => !roots.value.some(r => pathKey(r) === pathKey(c.value))).slice(0, 4)) {
      const b = button(short(c.value), 'cx-chip', () => { input.value = c.value; input.focus(); });
      b.title = c.value;
      cands.append(b);
    }
    if (cands.childNodes.length) card.append(cands);
    rootsFold.append(card);
    rootsFold.open = wasOpen || roots.value.length > 0;
  }

  function renderAll() {
    if (!view) return;
    renderCombo();
    for (const kind of KINDS) renderCard(kind);
    renderRoots();
  }

  // ---------------------------------------------------------------- 読み込み
  async function loadScan() {
    const ticket = ++scanTicket, target = scanCwd();
    if (!target) { scan = { entries: [], configs: [] }; renderAll(); return; }
    scanning = true;
    try {
      const [found, list, native] = await Promise.all([
        cmd('scanContext', { cwd: target, ...(isDefault() ? { place: 'default' } : {}) }),
        cmd('listPlyMcp', {}).catch(() => null),
        cmd('agentMcp', { cwd: target }).catch(() => null),
      ]);
      if (ticket !== scanTicket) return;
      scan = found; ply = list; agents = native;
    } catch (e) {
      if (ticket !== scanTicket) return;
      status.textContent = e.code === 'SCAN_BUSY' ? '' : t('context.scanFailed', { error: e.message });
      if (e.code === 'SCAN_BUSY') { setTimeout(() => { if (ticket === scanTicket) loadScan(); }, 400); return; }
      scan = { entries: [], configs: [] };
    } finally { if (ticket === scanTicket) scanning = false; }
    renderAll();
  }
  async function open(target) {
    cwd = session()?.cwd || current() || null;
    status.textContent = '';
    try {
      view = await cmd('contextSettings', { cwd });
    } catch (e) {
      view = null;
      status.textContent = t('context.loadFailed', { error: e.message });
      return;
    }
    // 既定の編集先は全体の設定。場所を渡されたときだけその場所を選ぶ（会話から開いても、黙って場所の設定を作らない）
    const wanted = target && view.places.find(p => pathKey(p.path) === pathKey(target));
    level = wanted ? wanted.path : 'default';
    scan = null; opened.clear(); expanded.clear();
    renderAll();
    await loadScan();
  }
  // ログインが済んだら一覧の状態を取り直す（web/client.mjs が mcpAuth を ply:mcp-auth として渡す）
  window.addEventListener('ply:mcp-auth', e => {
    const ev = e.detail ?? {};
    if (ev.phase !== 'done' && ev.phase !== 'error') return;
    if (!document.body.classList.contains('settings') || panel.hidden) return;
    mcp.authEvent(ev);
    cmd('listPlyMcp', {}).then(list => { ply = list; renderCard('mcp'); }).catch(() => {});
  });
  /** 設定のコンテキストのページを開く。place を渡すとその場所の設定を選んだ状態で開く */
  function openPage(target) { show(); return open(target); }
  openButton.onclick = () => openPage();
  return { openPage, get scanning() { return scanning; } };
}
