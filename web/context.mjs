// ==================== 設定 › コンテキスト（docs/design-system.md「コンテキスト」） ====================
// エージェントへ何を渡すかを種類ごと（指示・Skills・外部 MCP）に決める 1 画面。**全体の設定だけ**を扱う（ADR 0025）。
// フォルダーごとの設定（places）は会話の右パネルの「この場所だけ変える」から（web/session-context.mjs）。
// 各カードは担当（エージェントに任せる／Pleiad がそろえる。ユーザーと作業場所で共通。ADR 0014）の下に 2 段:
//   - ユーザー（~/.claude・~/.codex と足した場所）: 探す形式と、見つかったもの（スイッチ）と「＋ 探す場所を足す」（その種類にだけ効く）
//   - 作業場所（Git のルートから作業フォルダーまで）: 探す形式だけ。何が見つかるかは場所ごとなので、会話の右パネルで見る
// 「指示」のカードの上には「Pleiad の指示」（web/ply-instructions-card.mjs。担当によらず毎ターン入る）。
// 変更はその場で保存し（setContextSettings / setPlyInstructions）、「保存しました · 次のターンから反映」を出す。始まっている会話にも次のターンから効く。
// 設定の形と継承は core/context-settings.mjs、外部 MCP の一覧と追加シートは web/mcp-config.mjs。
import { el } from './dom.mjs';
import { runMark } from './arc.mjs';
import { renderMarkdown } from './render.mjs';
import { copyIcon } from './icons.mjs';
import { createMcpSection } from './mcp-config.mjs';
import { createPlyInstructions } from './ply-instructions-card.mjs';
import { t } from './i18n.mjs';

const KINDS = ['instruction', 'skill', 'mcp'];
const TEXT = {
  instruction: {
    title: t('context.instruction.title'), owned: t('context.instruction.files'),
    agent: [t('context.owner.agent'), t('context.instruction.agent')],
    ply: [t('context.owner.ply'), t('context.instruction.ply')],
    note: t('context.instruction.note'),
    formats: { user: [['common', t('context.instruction.sourceCommon')], ['claude', 'CLAUDE.md'], ['codex', t('context.instruction.sourceCodex')]] },
  },
  skill: {
    title: 'Skills', owned: 'Skills',
    agent: [t('context.owner.agent'), t('context.skill.agent')],
    ply: [t('context.owner.ply'), t('context.skill.ply')],
    note: t('context.skill.note'),
    formats: { user: [['common', t('context.skill.sourceCommon')], ['claude', '.claude/skills'], ['codex', '.codex/skills']] },
  },
  mcp: {
    title: t('context.mcp.title'), owned: t('context.mcp.title'),
    agent: [t('context.owner.agent'), t('context.mcp.agent')],
    ply: [t('context.owner.ply'), t('context.mcp.ply')],
    // ユーザーはエージェントの設定（~/.claude.json・~/.codex/config.toml）、作業場所はプロジェクトの設定ファイル
    formats: { user: [['claude', t('context.mcp.sourceClaude')], ['codex', t('context.mcp.sourceCodex')]], directory: [['claude', '.mcp.json'], ['codex', '.codex/config.toml']] },
  },
};
const SHOWN = 8;   // Skills は多いので最初はこれだけ並べ、「すべて見る」で残りを出す

export const pathKey = p => String(p ?? '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
export const within = (dir, file) => pathKey(file) === pathKey(dir) || pathKey(file).startsWith(pathKey(dir) + '/');
const parent = p => String(p ?? '').replace(/[\\/][^\\/]+$/, '');
/**
 * 指示・Skills の行のスイッチ（設定のカードと、会話の右パネルの「この場所だけ変える」）。value は種類の設定 K で、書き換える。
 * その行が見つかった範囲の除外（excludePaths）を出し入れする。入れるときは、その行を含むフォルダーごとの除外も外す（その行だけを戻す方法が無いので）
 */
export function toggleExclude(value, entry, include) {
  const scope = (entry.scope ?? entry.origins?.[0]?.scope) === 'user' ? 'user' : 'directory';
  value[scope] ??= { sources: [], excludePaths: [] };
  const list = value[scope].excludePaths;
  value[scope].excludePaths = include ? list.filter(p => !within(p, entry.path) && !within(p, entry.realPath ?? entry.path)) : [...list, entry.path];
}
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

export function setupContext({ button: openButton, cmd, show, recentPlaces = () => [], backends = () => [], openDelegation = null }) {
  const panel = document.getElementById('contextPanel');
  panel.classList.add('context');
  panel.replaceChildren();
  const root = el('div', 'cx');
  const lead = el('p', 'cx-lead', t('context.lead'));
  const status = el('p', 'cx-status'); status.setAttribute('role', 'alert');
  const cards = Object.fromEntries(KINDS.map(k => [k, el('section', 'cx-card')]));
  const toast = el('div', 'cx-toast', t('context.saved')); toast.setAttribute('role', 'status');
  root.append(lead, status, cards.instruction, cards.skill, cards.mcp, toast);
  panel.append(root);

  let view = null, scan = null, scanning = false, scanVisible = false, ply = null, agents = null, adding = null;
  const opened = new Set();          // 中身を開いている行（id）
  const expanded = new Set();        // 「すべて見る」を押した種類
  let toastTimer, scanTicket = 0;

  const home = () => view?.home ?? '';
  const short = p => {
    const h = home();
    if (h && within(h, p)) return `~${String(p).slice(h.length)}`;
    return String(p ?? '');
  };
  const info = () => view.defaults;

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
  const plyInstructions = createPlyInstructions({ cmd, work, saved, openDelegation, opened });

  // ---------------------------------------------------------------- 保存（その場で。全体の設定）
  async function saveKind(kind, mutate, { rescan = true } = {}) {
    const value = structuredClone(info().kinds[kind].value);
    mutate(value);
    view = await cmd('setContextSettings', { place: null, kind, value });
    saved();
    renderAll();
    if (rescan) await loadScan();
  }
  async function saveRoots(kind, roots) {
    view = await cmd('setContextSettings', { place: null, kind, roots });
    saved();
    renderAll();
    await loadScan();
  }

  // ---------------------------------------------------------------- 種類のカード
  function seg(kind, owner) {
    const box = el('div', 'cx-seg'); box.setAttribute('role', 'radiogroup'); box.setAttribute('aria-label', t('context.ownerAria', { kind: TEXT[kind].owned }));
    for (const [id, [title, desc]] of [['native', TEXT[kind].agent], ['ply', TEXT[kind].ply]]) {
      const b = button('', 'cx-opt');
      b.setAttribute('role', 'radio'); b.setAttribute('aria-checked', String(owner === id));
      b.append(el('b', null, title), el('span', null, desc));
      b.onclick = () => { if (owner !== id) work(() => saveKind(kind, v => { v.owner = id; }, { rescan: kind === 'mcp' && !agents })); };
      box.append(b);
    }
    return box;
  }
  /** 探す形式の札。その段（user = ユーザー、directory = 作業場所）だけを変える */
  function formats(kind, scope, value) {
    const row = el('div', 'cx-fmt');
    const label = scope === 'user' ? t('context.tier.user') : t('context.tier.place');
    const box = el('div', 'cx-chips'); box.setAttribute('role', 'group'); box.setAttribute('aria-label', t('context.tier.formatsAria', { tier: label }));
    for (const [id, text] of TEXT[kind].formats[scope] ?? TEXT[kind].formats.user) {
      const b = button(text, 'cx-chip');
      const on = Boolean(value[scope]?.sources.includes(id));
      b.setAttribute('aria-pressed', String(on));
      b.onclick = () => work(() => saveKind(kind, v => {
        v[scope] ??= { sources: [], excludePaths: [] };
        v[scope].sources = on ? v[scope].sources.filter(s => s !== id) : [...new Set([...v[scope].sources, id])];
      }));
      box.append(b);
    }
    row.append(el('span', 'cx-sub', t('context.formats')), box);
    return row;
  }
  function loading() {
    const p = el('p', 'cx-empty');
    p.append(runMark(t('context.searching')), document.createTextNode(' ' + t('context.searchingDots')));
    return p;
  }
  /** 指示・Skills の行（ユーザーの範囲で見つかったもの）。スイッチはユーザーの除外（excludePaths）を出し入れする */
  function documentRows(list, kind) {
    // 外したファイルは探索が出典ごとに別の行で返すので、同じ行（id）は 1 つにする
    const seen = new Set();
    const entries = (scan?.entries ?? []).filter(e => e.kind === kind && !seen.has(e.id) && seen.add(e.id));
    if (!entries.length) { list.append(el('p', 'cx-empty', kind === 'skill' ? t('context.skill.none') : t('context.instruction.none'))); return; }
    const shown = kind === 'skill' && !expanded.has(kind) ? entries.slice(0, SHOWN) : entries;
    for (const entry of shown) {
      const off = entry.status === 'excluded';
      const row = el('div', 'cx-row' + (off ? ' off' : ''));
      const open = button('', 'cx-open');
      open.setAttribute('aria-expanded', String(opened.has(entry.id)));
      const body = el('span', 't');
      body.append(el('span', 'nm', entry.name));
      const where = kind === 'skill' ? parent(parent(entry.path)) : parent(entry.path);
      const note = entry.status === 'shadowed' ? t('context.row.shadowed') : entry.status === 'conditional' ? t('context.row.conditional', { paths: entry.paths.join(', ') }) : '';
      body.append(el('span', 'p', [short(where), entry.root ? t('context.roots.extra') : '', note].filter(Boolean).join(' · ')));
      open.append(body);
      open.onclick = () => { if (opened.has(entry.id)) opened.delete(entry.id); else opened.add(entry.id); renderCard(kind); };
      const sw = button('', 'cx-sw');
      sw.setAttribute('role', 'switch'); sw.setAttribute('aria-checked', String(!off));
      sw.setAttribute('aria-label', kind === 'skill' ? t('context.row.offerAria', { name: entry.name }) : t('context.row.provideAria', { name: entry.name }));
      sw.onclick = () => { sw.setAttribute('aria-checked', String(off)); work(() => saveKind(kind, v => toggleExclude(v, entry, off))); };
      row.append(open, sw);
      list.append(row);
      if (opened.has(entry.id)) {
        const peek = peekDocument(entry, { short });
        if (entry.root) peek.append(rootActs(kind, entry.root));
        list.append(peek);
      }
    }
    if (shown.length < entries.length) list.append(button(t('context.showAll', { n: entries.length }), 'btn cx-more-rows', () => { expanded.add(kind); renderCard(kind); }));
  }

  // ---------------------------------------------------------------- 探す場所を足す（種類ごと。ユーザーの段）
  const rootsOf = kind => info().roots[kind]?.value ?? [];
  function rootActs(kind, root) {
    const acts = el('div', 'acts');
    const remove = button(t('context.roots.remove'), 'btn', () => work(() => saveRoots(kind, rootsOf(kind).filter(r => pathKey(r) !== pathKey(root)))));
    remove.setAttribute('aria-label', t('context.roots.removeAria', { path: root }));
    acts.append(remove);
    return acts;
  }
  /** 足したのに何も見つからない場所。行が無いと外せないので、場所そのものを 1 行で出す */
  function emptyRoots(list, kind) {
    if (!scan) return;
    for (const r of rootsOf(kind)) {
      if ((scan.entries ?? []).some(e => e.kind === kind && e.root && pathKey(e.root) === pathKey(r))) continue;
      const row = el('div', 'cx-row cx-root');
      const body = el('span', 't');
      body.append(el('span', 'nm', short(r)), el('span', 'p', t('context.roots.nothing')));
      const remove = button(t('context.roots.remove'), 'btn', () => work(() => saveRoots(kind, rootsOf(kind).filter(x => pathKey(x) !== pathKey(r)))));
      remove.setAttribute('aria-label', t('context.roots.removeAria', { path: r }));
      row.append(body, remove);
      list.append(row);
    }
  }
  function addPlace(kind) {
    if (adding !== kind) {
      const add = button('', 'cx-add', () => { adding = kind; renderCard(kind); cards[kind].querySelector('.cx-addbox input')?.focus(); });
      add.dataset.addPlace = kind;
      add.append(plus(), document.createTextNode(t('context.roots.add')));
      return add;
    }
    const box = el('div', 'cx-addbox');
    const input = el('input'); input.placeholder = t('context.folderPath'); input.setAttribute('aria-label', t('context.roots.addAria')); input.autocomplete = 'off'; input.spellcheck = false;
    const cands = el('div', 'cands');
    const error = el('p', 'err'); error.setAttribute('role', 'alert');
    const close = () => { adding = null; renderCard(kind); cards[kind].querySelector(`[data-add-place="${kind}"]`)?.focus(); };
    const go = async () => {
      const value = input.value.trim();
      if (!value) { error.textContent = t('context.place.pathRequired'); return; }
      try { adding = null; await saveRoots(kind, [...rootsOf(kind), value]); }
      catch (e) { adding = kind; renderCard(kind); const again = cards[kind].querySelector('.cx-addbox'); again.querySelector('input').value = value; again.querySelector('.err').textContent = e.message; again.querySelector('input').focus(); }
    };
    function paintCands() {
      cands.replaceChildren();
      const q = input.value.trim().toLowerCase();
      const listed = new Set(rootsOf(kind).map(pathKey));
      const found = recentPlaces().filter(c => !listed.has(pathKey(c.value)) && (!q || c.value.toLowerCase().includes(q))).slice(0, 6);
      for (const c of found) {
        const b = button('', 'cx-opt2', () => { input.value = c.value; paintCands(); input.focus(); });
        b.append(el('span', 'v', c.value), el('span', 's', c.hint ?? ''));
        cands.append(b);
      }
      if (!found.length) cands.append(el('p', 'cx-sub', q ? t('context.place.noMatch') : t('context.place.noCandidates')));
    }
    input.oninput = () => { error.textContent = ''; paintCands(); };
    input.onkeydown = e => {
      if (e.isComposing) return;
      if (e.key === 'Enter') { e.preventDefault(); go(); }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
    };
    const acts = el('div', 'acts');
    if (window.plyDesktop?.chooseFolder) acts.append(button(t('context.chooseFolder'), 'btn', async () => {
      const picked = await window.plyDesktop.chooseFolder().catch(() => null);
      const chosen = typeof picked === 'string' ? picked : picked?.path ?? picked?.[0];
      if (chosen) { input.value = chosen; paintCands(); input.focus(); }
    }));
    acts.append(button(t('context.cancel'), 'btn', close), button(t('context.add'), 'btn btn-quiet', go));
    box.append(input, el('p', 'cx-sub', t('context.place.recent')), cands, error, acts);
    paintCands();
    return box;
  }

  // ---------------------------------------------------------------- 段（ユーザー／作業場所）
  function tierHead(name, sub) {
    const h = el('div', 'cx-tierh');
    h.append(el('span', 'n', name));
    if (sub) h.append(el('span', null, sub));
    return h;
  }
  function userTier(kind, value) {
    const tier = el('div', 'cx-tier');
    tier.append(tierHead(t('context.tier.user')), formats(kind, 'user', value));
    const list = el('div', 'cx-list');
    list.setAttribute('role', 'group'); list.setAttribute('aria-label', t('context.tier.listAria', { kind: TEXT[kind].title }));
    if (!scan) list.append(loading());
    else if (kind === 'mcp') mcp.renderList(list, mcpContext());
    else documentRows(list, kind);
    emptyRoots(list, kind);
    if (kind === 'mcp') list.append(mcp.addButton(mcpContext()));
    list.append(addPlace(kind));
    tier.append(list);
    return tier;
  }
  function placeTier(kind, value) {
    const tier = el('div', 'cx-tier');
    tier.append(tierHead(t('context.tier.place'), t('context.tier.placeSub')), formats(kind, 'directory', value));
    return tier;
  }
  /**
   * antigravity は、指示も Pleiad がそろえるときだけ Pleiad のコンテキストを受け取る（core/backends/antigravity-context.mjs の contextRefusal）。
   * Pleiad の渡し方（カスタムエージェント）ではワークスペースの AGENTS.md・GEMINI.md を agy が読まなくなるため、
   * 指示がエージェント任せのまま Skills・MCP だけ Pleiad にした組み合わせは、antigravity の会話ではすべてエージェント任せになる
   */
  function antigravityNote(kind) {
    if (kind === 'instruction' || !backends().some(b => b.id === 'antigravity')) return null;
    if (info().kinds[kind].value.owner !== 'ply' || info().kinds.instruction.value.owner === 'ply') return null;
    return el('p', 'cx-sub', t('context.antigravityNote'));
  }
  function renderCard(kind) {
    const card = cards[kind], value = info().kinds[kind].value;
    card.replaceChildren();
    card.dataset.kind = kind;
    const head = el('div', 'cx-khead');
    const title = el('h4', null, TEXT[kind].title);
    title.id = `cxKind-${kind}`;
    card.setAttribute('aria-labelledby', title.id);
    head.append(title);
    if (scanning && scanVisible) { const label = el('span', 'pending-label'); label.append(runMark(t('pending.searching')), t('pending.searching')); head.append(label); }
    card.append(head);
    let host = card;
    if (kind === 'instruction') {
      // 上に Pleiad の指示、下にファイルの指示（担当と 2 段）
      card.append(plyInstructions.root);
      host = el('div', 'cx-block');
      const sec = el('div', 'cx-sec');
      sec.append(el('span', 'n', t('context.instruction.fileTitle')));
      host.append(sec);
      card.append(host);
    }
    host.append(seg(kind, value.owner));
    const agy = antigravityNote(kind);
    if (agy) host.append(agy);
    if (value.owner !== 'ply') {
      if (kind === 'mcp') mcp.renderAgents(host, mcpContext());
      else host.append(el('p', 'cx-note', TEXT[kind].note));
      return;
    }
    host.append(userTier(kind, value), placeTier(kind, value));
    if (kind === 'mcp') mcp.renderExtras(host, mcpContext());
  }
  function mcpContext() {
    return { cmd, cwd: home(), scanCwd: home(), scan, ply, agents, short, backends: backends(), info: info(),
      saveKind: (mutate, options) => work(() => saveKind('mcp', mutate, options)),
      reload: () => loadScan(), refreshSettings: async () => { view = await cmd('contextSettings', {}); renderAll(); }, toast: saved, status: text => { status.textContent = text; }, rerender: () => renderCard('mcp'),
      opened, loading, work };
  }
  const mcp = createMcpSection();

  function renderAll() {
    if (!view) return;
    for (const kind of KINDS) renderCard(kind);
  }

  // ---------------------------------------------------------------- 読み込み
  /** ユーザーの範囲（home と足した場所）だけを探す。作業場所のファイルは場所ごとなので、ここには出さない */
  async function loadScan() {
    const ticket = ++scanTicket, target = home();
    if (!target) { scan = { entries: [], configs: [] }; renderAll(); return; }
    scanning = true;
    scanVisible = false;
    renderAll();
    const timer = setTimeout(() => { if (ticket === scanTicket) { scanVisible = true; renderAll(); } }, 150);
    try {
      const [found, list, native] = await Promise.all([
        cmd('scanContext', { cwd: target, place: 'default', scope: 'user' }),
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
    } finally { clearTimeout(timer); if (ticket === scanTicket) { scanning = false; scanVisible = false; } }
    renderAll();
  }
  async function open() {
    status.textContent = '';
    try {
      view = await cmd('contextSettings', {});
    } catch (e) {
      view = null;
      status.textContent = t('context.loadFailed', { error: e.message });
      return;
    }
    scan = null; adding = null; opened.clear(); expanded.clear();
    renderAll();
    await Promise.all([plyInstructions.load(), loadScan()]);
  }
  // ログインが済んだら一覧の状態を取り直す（web/client.mjs が mcpAuth を ply:mcp-auth として渡す）
  window.addEventListener('ply:mcp-auth', e => {
    const ev = e.detail ?? {};
    if (ev.phase !== 'done' && ev.phase !== 'error') return;
    if (!document.body.classList.contains('settings') || panel.hidden) return;
    mcp.authEvent(ev);
    cmd('listPlyMcp', {}).then(list => { ply = list; renderCard('mcp'); }).catch(() => {});
  });
  /** 設定のコンテキストのページを開く（いつも全体の設定） */
  function openPage() { show(); return open(); }
  openButton.onclick = () => openPage();
  return { openPage, get scanning() { return scanning; } };
}
