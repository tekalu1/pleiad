// ==================== Hooks のカード（設定 › コンテキスト）と、追加・編集のシート ====================
// docs/design-system.md「コンテキスト」の「Hooks」、ADR 0045。
// 実行するのは各エージェント。Pleiad は元の設定ファイル（core/hooks-config.mjs）を読み、利用者が明示した編集だけを書く。
//   担当の 2 択は「設定を誰が用意するか」。今は「エージェントに任せる」だけで、「Pleiad がそろえる」は選べない（理由を出す）
//   ユーザーの段: 見つかった定義を イベント順（既定）／エージェント別 3 列 で並べる。行を押すと定義・出どころ・状態（②）
//   止める操作はエージェントごと: Claude Code はスイッチなし、Codex は信頼状態を取れないので /hooks を案内、Antigravity は名前単位の enabled
//   作業場所の段: 探すファイルの形だけ。場所ごとの定義は会話の右パネル（web/session-context.mjs）
// 追加・編集のシート（③）は command 型だけ。書く前に、書き先ごとの差分を確かめる（書き直しが要る TOML はそこで許可を取る）。
import { el } from './dom.mjs';
import { t } from './i18n.mjs';
import { runMark } from './arc.mjs';
import { codeBlock } from './render.mjs';
import { copyIcon } from './icons.mjs';
import { lineDiff } from './session-context.mjs';

export const HOOK_AGENTS = [['claude', 'Claude Code'], ['codex', 'Codex'], ['antigravity', 'Antigravity']];
export const agentLabel = id => HOOK_AGENTS.find(([k]) => k === id)?.[1] ?? id;
// 「登録なし」でも一覧に出す主なイベント（すべて見るとき）
const MAIN_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'SessionEnd'];
// ツールの名前で絞るイベント（シートの matcher の例）
const TOOL_EVENTS = new Set(['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest', 'PermissionDenied']);
const SHOWN = 7;

// i18n-dynamic: hooks.event.
// i18n-dynamic: hooks.file.allOff
/** イベントの見出し（知らないイベントは名前だけ） */
export const eventLabel = e => { const key = `hooks.event.${e}`, s = t(key); return s === key ? e : s; };
// i18n-dynamic: hooks.scope.
export const scopeLabel = e => e.scope === 'skill' ? t('hooks.scope.skill', { name: e.skill ?? '' }) : t(`hooks.scope.${e.scope}`);
/** 行の名前: Antigravity は定義の名前、ほかはコマンドの要約（http などは型と接続先） */
export const rowName = e => e.name ?? (e.command || e.definition?.url || e.definition?.server || e.type);
/** 行の状態（右端の弱い字）。有効・実行済みとは言わない */
export function stateText(e) {
  if (e.agent === 'codex' && (('trust' in e) || e.trustPending)) return codexState(e);
  if (e.readOnly) return t('hooks.state.readOnly');
  if (e.agent === 'claude') return t('hooks.state.claude');
  if (e.agent === 'codex') return t('hooks.state.codex');
  if (e.stoppedBySameName) return t('hooks.state.agySame');
  return e.enabled ? t('hooks.state.agyOn') : t('hooks.state.agyOff');
}
// i18n-dynamic: hooks.trust.
/** Codex の信頼状態（hooks/list の trustStatus・enabled）。取れなかったときだけ「取得できません」 */
export function codexState(e) {
  if (e.trustPending && !('trust' in e)) return t('hooks.trust.checking');
  if (!e.trust?.status) return t('hooks.state.codex');
  if (!e.trust.enabled) return t('hooks.trust.off');
  const key = `hooks.trust.${e.trust.status}`, s = t(key);
  return s === key ? e.trust.status : s;
}
const codexRuns = e => ['trusted', 'managed'].includes(e.trust?.status) && e.trust.enabled;
export function metaText(e) {
  const bits = [scopeLabel(e)];
  if (e.matcher !== null && e.matcher !== undefined) bits.push(t('hooks.row.matcher', { matcher: e.matcher || '*' }));
  if (e.type !== 'command') bits.push(e.type);
  if (e.async) bits.push('async');
  if (e.adapter) bits.push(t('hooks.row.copied', { agent: agentLabel(e.adapter.from) }));
  return bits.join(' · ');
}
export const order = (scan, ev) => { const i = (scan?.order ?? []).indexOf(ev); return i < 0 ? 999 : i; };
const supports = (scan, agent, ev) => Boolean(scan?.events?.[agent]?.includes(ev));

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
function addButton(text, onClick) {
  const b = button('', 'cx-add', onClick);
  b.append(plus(), document.createTextNode(text));
  return b;
}
const badge = text => el('span', 'cbadge', text);

// i18n-dynamic: hooks.copy.from.
/** 写せない行の理由（辞書のキーの末尾）。写せるなら null。管理者・プラグイン・Skill・command 以外・写した定義（アダプター越し）からは写さない */
export function copyBlocked(e) {
  if (e.readOnly) return e.scope === 'skill' ? 'skill' : 'readOnly';
  if (e.type !== 'command' || !e.editable) return 'notCommand';
  if (e.adapter) return 'alreadyCopy';
  return null;
}

/** 行の中身（②）。出どころ・定義の単位・matcher・型・timeout・async・状態と、伏せ字の定義 */
export function peekHook(e, { short = p => p, onEdit = null, onDelete = null, onToggle = null, onCopy = null } = {}) {
  const box = el('div', 'cx-peek hk-peek');
  const line = el('div', 'row-line');
  line.append(el('span', 'cx-path', short(e.path)));
  const copy = button('', 'btn btn-icon');
  copy.innerHTML = copyIcon; copy.title = t('context.copyPath'); copy.setAttribute('aria-label', t('context.copyPath'));
  copy.onclick = () => navigator.clipboard?.writeText(e.path).then(() => { copy.title = t('context.copied'); }).catch(() => {});
  line.append(copy);
  box.append(line);
  const facts = el('div', 'fm facts');
  const put = (k, v) => { if (v !== null && v !== undefined && v !== '') facts.append(el('span', 'k', k), el('span', 'v', String(v))); };
  put(t('hooks.fact.unit'), e.agent === 'antigravity' ? t('hooks.fact.unitAgy', { name: e.name }) : t('hooks.fact.unitGroup'));
  put(t('hooks.fact.event'), `${eventLabel(e.event)} · ${e.event}`);
  put('matcher', e.matcher === null || e.matcher === undefined ? t('hooks.fact.none') : e.matcher || '*');
  put('type', e.type);
  put('timeout', e.timeout ? t('hooks.fact.seconds', { n: e.timeout }) : t('hooks.fact.default'));
  put('async', e.agent === 'antigravity' ? t('hooks.fact.asyncAgy') : String(e.async));
  put(t('hooks.fact.state'), stateText(e));
  if (e.trust?.hash) put('hash', e.trust.hash.replace(/^(sha256:.{12}).*$/, '$1…'));
  // 他のエージェントから写した定義（アダプター越し）: 元のエージェントと元のコマンド（伏せ字）
  if (e.adapter) { put(t('hooks.fact.copiedFrom'), t('hooks.fact.copiedFromValue', { agent: agentLabel(e.adapter.from), event: e.adapter.event })); put(t('hooks.fact.originalCommand'), e.adapter.command); }
  box.append(facts);
  // 止める操作の説明（エージェントごと）
  if (e.readOnly) box.append(el('p', 'msg', e.scope === 'skill' ? t('hooks.peek.skill') : t('hooks.peek.readOnly')));
  else if (e.agent === 'claude') box.append(el('p', 'msg', t('hooks.peek.claude')));
  else if (e.agent === 'codex') box.append(el('p', 'msg', !e.trust?.status ? t('hooks.peek.codex') : !e.trust.enabled ? t('hooks.peek.codexOff')
    : codexRuns(e) ? t('hooks.peek.codexTrusted') : t('hooks.peek.codexUntrusted')));
  else {
    // スイッチは行の右端（設定のカード）。渡されたときだけ詳細にも置く
    if (onToggle) {
      const head = el('div', 'row-line hk-toggle');
      head.append(el('span', null, t('hooks.peek.agyToggle', { name: e.name })), agySwitch(e, onToggle));
      box.append(head);
    }
    box.append(el('p', 'msg', t('hooks.peek.agy')));
  }
  if (!e.editable && !e.readOnly) box.append(el('p', 'msg', t('hooks.peek.notCommand')));
  if (e.unknownKeys?.length && e.editable) box.append(el('p', 'msg', t('hooks.peek.unknownKeys', { keys: e.unknownKeys.join(', ') })));
  const def = el('details', 'cx-fold');
  def.open = true;
  def.append(el('summary', null, t('hooks.peek.definition')));
  const code = el('div');
  code.innerHTML = codeBlock(JSON.stringify(e.definition, null, 2), 'json');
  def.append(code);
  box.append(def);
  const acts = el('div', 'acts');
  if (e.editable && onEdit) acts.append(button(t('hooks.edit'), 'btn', () => onEdit(e)));
  if (e.editable && onDelete) acts.append(button(t('hooks.delete'), 'btn', () => onDelete(e)));
  let why = null;
  if (onCopy) {
    // 写せない行も押せないボタンを置き、理由の一行を添える（押せない理由が見えないボタンにしない）
    const blocked = copyBlocked(e);
    const b = button(t('hooks.copy.open'), 'btn', () => onCopy(e));
    if (blocked) { why = el('p', 'msg', t(`hooks.copy.from.${blocked}`)); why.id = `hkCopyWhy-${e.id}`; b.disabled = true; b.setAttribute('aria-describedby', why.id); }
    acts.append(b);
  }
  if (acts.children.length) box.append(acts);
  if (why) box.append(why);
  return box;
}
/** Antigravity の名前単位のスイッチ。同じ名前のすべてのイベントに効く */
export function agySwitch(e, onToggle) {
  const sw = button('', 'cx-sw');
  sw.setAttribute('role', 'switch'); sw.setAttribute('aria-checked', String(e.enabled));
  sw.setAttribute('aria-label', t('hooks.row.agySwitch', { name: e.name }));
  sw.onclick = () => { sw.setAttribute('aria-checked', String(!e.enabled)); sw.disabled = true; onToggle(e, !e.enabled); };
  return sw;
}

// ---------------------------------------------------------------- 設定 › コンテキストのカード
export function createHooksCard({ cmd, work, saved, opened }) {
  const root = el('section', 'cx-card hk-card');
  root.dataset.kind = 'hooks';
  let scan = null, loading = false, layout = 'events', expanded = false, home = '';
  const short = p => (home && String(p).toLowerCase().replace(/\\/g, '/').startsWith(home.toLowerCase().replace(/\\/g, '/')) ? `~${String(p).slice(home.length)}` : String(p ?? ''));

  let ticket = 0;
  /** 一覧を先に出し、Codex の信頼状態（hooks/list。app-server の起動を待つことがある）は後から重ねる */
  async function load() {
    const mine = ++ticket;
    loading = true; render();
    try { const first = await cmd('scanHooks', { scope: 'user' }); if (mine !== ticket) return; scan = first; home = scan.home ?? ''; }
    catch (e) { if (mine !== ticket) return; scan = { entries: [], files: [], failed: e.message }; }
    finally { if (mine === ticket) loading = false; }
    render();
    if (!scan.trustPending) return;
    const withTrust = await cmd('scanHooks', { scope: 'user', trust: true }).catch(() => null);
    if (mine !== ticket || !withTrust) return;
    scan = withTrust;
    render();
  }
  const reload = () => load();
  /** Antigravity の enabled を元ファイルへ書く */
  function toggle(e, enabled) {
    const file = scan.files.find(f => f.path === e.path);
    return work(async () => {
      const r = await cmd('saveHooks', { items: [{ op: 'enable', agent: e.agent, scope: e.scope, base: e.base, file: e.path, revision: file?.revision, loc: { name: e.name }, enabled }] });
      if (!r.results[0].ok) { await reload(); throw new Error(r.results[0].error); }
      saved(); await reload();
    });
  }
  const sheetCtx = () => ({ cmd, scan, short, onSaved: async () => { saved(); await reload(); } });

  function seg() {
    const box = el('div', 'cx-seg'); box.setAttribute('role', 'radiogroup'); box.setAttribute('aria-label', t('hooks.ownerAria'));
    for (const [id, title, desc] of [['native', t('context.owner.agent'), t('hooks.owner.agent')], ['ply', t('context.owner.ply'), t('hooks.owner.ply')]]) {
      const b = button('', 'cx-opt');
      b.setAttribute('role', 'radio'); b.setAttribute('aria-checked', String(id === 'native')); b.dataset.owner = id;
      b.append(el('b', null, title), el('span', null, desc));
      // 第 1 段では選べない（ADR 0045）。押せない理由は下の文で示す
      if (id === 'ply') { b.disabled = true; b.setAttribute('aria-describedby', 'hkOwnerNote'); }
      box.append(b);
    }
    return box;
  }
  function row(list, e) {
    const r = el('div', 'cx-row' + (e.agent === 'antigravity' && !e.enabled ? ' off' : ''));
    const open = button('', 'cx-open');
    open.setAttribute('aria-expanded', String(opened.has(`hook:${e.id}`)));
    const body = el('span', 't');
    const nm = el('span', 'nm');
    nm.append(el('span', e.name ? null : 'hk-cmd', rowName(e)), badge(agentLabel(e.agent)));
    body.append(nm, el('span', 'p', metaText(e)));
    if (e.name && e.command) body.append(el('span', 'p hk-cmd', e.command));
    open.append(body);
    open.onclick = () => { const k = `hook:${e.id}`; if (opened.has(k)) opened.delete(k); else opened.add(k); render(); root.querySelector(`[data-hook="${e.id}"] .cx-open`)?.focus(); };
    r.dataset.hook = e.id;
    r.append(open, el('span', 'hk-state', stateText(e)));
    if (e.agent === 'antigravity' && !e.readOnly) r.append(agySwitch(e, toggle));
    list.append(r);
    if (opened.has(`hook:${e.id}`)) list.append(peekHook(e, { short,
      onEdit: x => openHookSheet(sheetCtx(), { entry: x }), onDelete: x => openHookSheet(sheetCtx(), { entry: x, remove: true }),
      onCopy: x => openCopySheet(sheetCtx(), x) }));
  }
  function eventList(entries, { all = false, max = SHOWN } = {}) {
    const list = el('div', 'cx-list');
    list.setAttribute('role', 'group'); list.setAttribute('aria-label', t('hooks.listAria'));
    const events = [...new Set([...entries.map(e => e.event), ...(all ? MAIN_EVENTS : [])])].sort((a, b) => order(scan, a) - order(scan, b));
    let shown = 0;
    for (const ev of events) {
      const rows = entries.filter(e => e.event === ev);
      if (!all && shown >= max) break;
      const head = el('div', 'hk-ev');
      head.append(el('b', null, eventLabel(ev)), el('span', 'cx-mono', ev));
      if (!rows.length) head.append(el('span', null, t('hooks.none')));
      list.append(head);
      for (const e of rows) { if (!all && shown >= max) break; row(list, e); shown++; }
    }
    if (!entries.length && !all) list.append(el('p', 'cx-empty', t('hooks.emptyUser')));
    const nEvents = new Set(entries.map(e => e.event)).size;
    if (entries.length > max || expanded) list.append(button(expanded ? t('hooks.collapse') : t('hooks.showAll', { events: nEvents, n: entries.length }), 'btn cx-more-rows', () => { expanded = !expanded; render(); }));
    return list;
  }
  function agentColumns(entries) {
    const cols = el('div', 'cx-cols hk-cols');
    for (const [id, label] of HOOK_AGENTS) {
      const col = el('div', 'cx-col');
      const mine = entries.filter(e => e.agent === id);
      const h = el('b', null, label); h.append(badge(t('hooks.count', { n: mine.length })));
      col.append(h);
      if (mine.length) col.append(eventList(mine, { all: false, max: expanded ? Infinity : SHOWN }));
      else {
        col.append(el('span', 'cx-sub', t('hooks.agentNone')));
        for (const f of (scan.files ?? []).filter(f => f.agent === id && f.scope === 'user')) col.append(el('span', 'cx-path', short(f.path)));
      }
      col.append(addButton(t('hooks.add'), () => openHookSheet(sheetCtx(), { agents: [id] })));
      cols.append(col);
    }
    return cols;
  }
  /** 読めなかったファイル・全体の停止。0 件と取り違えないよう一覧の上に出す */
  function fileNotes(tier) {
    for (const f of (scan.files ?? []).filter(f => f.status === 'error' || f.partial)) {
      const n = el('p', 'cx-note');
      n.append(el('span', 'cx-strong', f.status === 'error' ? t('hooks.file.error', { agent: agentLabel(f.agent) }) : t('hooks.file.partial', { agent: agentLabel(f.agent) })), ` ${short(f.path)} · ${f.error ?? ''}`);
      tier.append(n);
    }
    for (const f of (scan.files ?? []).filter(f => f.allOff)) tier.append(el('p', 'cx-note', t(f.agent === 'claude' ? 'hooks.file.allOffClaude' : 'hooks.file.allOffCodex', { path: short(f.path) })));
  }
  function render() {
    root.replaceChildren();
    const head = el('div', 'cx-khead');
    const title = el('h4', null, 'Hooks'); title.id = 'cxKind-hooks';
    root.setAttribute('aria-labelledby', title.id);
    head.append(title, el('span', 'cx-sub hk-lead', t('hooks.lead')));
    if (loading && scan) { const label = el('span', 'pending-label'); label.append(runMark(t('pending.searching')), t('pending.searching')); head.append(label); }
    root.append(head, seg());
    const note = el('p', 'cx-sub', t('hooks.owner.plyLater')); note.id = 'hkOwnerNote';
    root.append(note, el('p', 'cx-sub', t('hooks.runBy')));
    const tier = el('div', 'cx-tier');
    const entries = (scan?.entries ?? []).slice().sort((a, b) => order(scan, a.event) - order(scan, b.event));
    const counts = HOOK_AGENTS.map(([id, label]) => t('hooks.agentCount', { agent: label, n: entries.filter(e => e.agent === id).length })).join(' / ');
    const th = el('div', 'cx-tierh');
    th.append(el('span', 'n', t('context.tier.user')), el('span', null, scan ? t('hooks.found', { counts }) : ''));
    tier.append(th);
    if (!scan) {
      const p = el('p', 'cx-empty'); p.append(runMark(t('context.searching')), document.createTextNode(' ' + t('context.searchingDots')));
      tier.append(p); root.append(tier); return;
    }
    if (scan.failed) tier.append(el('p', 'cx-note', t('hooks.scanFailed', { error: scan.failed })));
    fileNotes(tier);
    const bar = el('div', 'hk-bar');
    bar.append(el('span', 'cx-sub', t('hooks.summary', { events: new Set(entries.map(e => e.event)).size, n: entries.length })));
    const chips = el('div', 'cx-chips'); chips.setAttribute('role', 'group'); chips.setAttribute('aria-label', t('hooks.layoutAria'));
    for (const [id, text] of [['events', t('hooks.layout.events')], ['agents', t('hooks.layout.agents')]]) {
      const b = button(text, 'cx-chip', () => { layout = id; render(); root.querySelector(`[data-layout=${id}]`)?.focus(); });
      b.dataset.layout = id; b.setAttribute('aria-pressed', String(layout === id));
      chips.append(b);
    }
    bar.append(chips);
    tier.append(bar);
    tier.append(layout === 'events' ? eventList(entries, { all: expanded }) : agentColumns(entries));
    if (layout === 'events') tier.append(addButton(t('hooks.add'), () => openHookSheet(sheetCtx(), {})));
    tier.append(el('p', 'cx-sub', t('hooks.userFoot')));
    const place = el('div', 'cx-tier');
    const ph = el('div', 'cx-tierh');
    ph.append(el('span', 'n', t('context.tier.place')), el('span', null, t('context.tier.placeSub')));
    place.append(ph, el('p', 'cx-sub cx-mono', '.claude/settings.json · .claude/settings.local.json · .codex/hooks.json · .codex/config.toml · .agents/hooks.json'),
      el('p', 'cx-sub', t('hooks.placeNote')));
    root.append(tier, place);
  }
  render();
  return { root, load, reload };
}

// ---------------------------------------------------------------- 追加・編集・削除のシート（③）と書く前の確認
/**
 * ctx: { cmd, scan, short, onSaved }
 * opts: { entry }（編集。remove: true なら削除の確認だけ） / { agents, scope, base }（追加。右パネルからは場所を引き継ぐ）
 */
export async function openHookSheet(ctx, opts = {}) {
  document.querySelector('dialog.hk-sheet')?.remove();
  const dialog = el('dialog', 'mcp-sheet hk-sheet');
  const form = el('form');
  dialog.append(form);
  dialog.addEventListener('close', () => dialog.remove());
  document.body.append(dialog);
  const entry = opts.entry ?? null, editing = Boolean(entry);
  const scan = ctx.scan ?? (await ctx.cmd('scanHooks', { scope: 'user' }).catch(() => null));
  const events = scan?.order ?? [];
  let original = null;
  if (editing) {
    try { original = await ctx.cmd('readHook', { agent: entry.agent, scope: entry.scope, base: entry.base, file: entry.path, loc: { event: entry.event, group: entry.group, handler: entry.handler, name: entry.name } }); }
    catch (e) {
      dialog.setAttribute('aria-label', opts.remove ? t('hooks.sheet.deleteTitle') : t('hooks.sheet.editTitle'));
      const failed = el('p', 'mcp-error', e.message); failed.setAttribute('role', 'alert');
      form.append(failed, button(t('mcp.cancel'), 'btn', () => dialog.close())); dialog.showModal(); return;
    }
  }
  const heading = el('h3', null, opts.remove ? t('hooks.sheet.deleteTitle') : editing ? t('hooks.sheet.editTitle') : t('hooks.add'));
  heading.tabIndex = -1;
  dialog.setAttribute('aria-label', heading.textContent);
  if (opts.remove) return confirmStep([{ op: 'delete', agent: entry.agent, scope: entry.scope, base: entry.base, file: entry.path, revision: original.revision,
    loc: { event: entry.event, group: entry.group, handler: entry.handler, name: entry.name } }], { back: null });

  const state = {
    agents: editing ? [entry.agent] : opts.agents ?? ['claude'],
    event: editing ? entry.event : 'PreToolUse',
    scope: editing ? entry.scope : opts.scope ?? 'user',
    base: editing ? entry.base ?? '' : opts.base ?? '',
    matchers: editing ? { [entry.agent]: original.matcher ?? '' } : {},
  };
  const lead = el('p', 'mcp-note', editing ? t('hooks.sheet.editLead') : t('hooks.sheet.addLead'));
  // 名前（Antigravity の定義のキー。ほかのエージェントには書かない）
  // 欄の見出しと入力は <label>、補足の文はその外（label の中身は文の要素に限るので p を入れない）
  const field = (text, control, ...notes) => {
    const box = el('div', 'mcp-field'), label = el('label', 'hk-label');
    label.append(text, control);
    box.append(label, ...notes);
    return box;
  };
  const name = el('input'); name.className = 'hk-input'; name.value = editing ? entry.name ?? '' : ''; name.placeholder = 'audit'; name.autocomplete = 'off'; name.spellcheck = false;
  const nameField = field(t('hooks.sheet.name'), name, el('p', 'mcp-note', t('hooks.sheet.nameNote')));
  // 対象エージェント（複数選択）
  const agentField = el('fieldset', 'mcp-field hk-fieldset');
  agentField.append(el('legend', null, t('hooks.sheet.agents')));
  const checks = el('div', 'cx-chips');
  const agentBoxes = HOOK_AGENTS.map(([id, label]) => {
    const l = el('label', 'hk-check'), c = el('input');
    c.type = 'checkbox'; c.value = id; c.checked = state.agents.includes(id); c.disabled = editing;
    c.onchange = () => { state.agents = agentBoxes.filter(x => x.checked).map(x => x.value); paint(); };
    l.append(c, document.createTextNode(label));
    checks.append(l);
    return c;
  });
  agentField.append(checks);
  // イベント
  const eventSelect = el('select'); eventSelect.className = 'hk-input';
  for (const ev of events) { const o = el('option', null, `${ev} — ${eventLabel(ev)}`); o.value = ev; eventSelect.append(o); }
  eventSelect.value = state.event;
  eventSelect.onchange = () => { state.event = eventSelect.value; paint(); };
  const support = el('p', 'mcp-note hk-support');
  const eventField = field(t('hooks.sheet.event'), eventSelect, support);
  // matcher（エージェントごと）
  const matcherField = el('div', 'mcp-field');
  const matcherBox = el('div', 'hk-map');
  const matcherNote = el('p', 'mcp-note');
  matcherField.append(t('hooks.sheet.matcher'), matcherBox, matcherNote);
  // コマンド
  const command = el('input'); command.className = 'hk-input mono'; command.value = editing ? original.command ?? '' : ''; command.placeholder = 'node ~/hooks/audit.cjs'; command.autocomplete = 'off'; command.spellcheck = false;
  // Antigravity は引用符付きのバックスラッシュのパスを解決できない（実機で確認。2026-09-27）。スラッシュ形式に直せるようにする
  const slashNote = el('div', 'hk-slash');
  const slashFix = button(t('hooks.sheet.slashFix'), 'btn', () => { command.value = command.value.replace(/\\/g, '/'); paintSlash(); command.focus(); });
  slashNote.append(el('p', 'mcp-note cx-strong', t('hooks.sheet.slashAgy')), slashFix);
  const paintSlash = () => { slashNote.hidden = !(state.agents.includes('antigravity') && command.value.includes('\\')); };
  command.oninput = paintSlash;
  const cmdField = field(t('hooks.sheet.command'), command, slashNote, el('p', 'mcp-note', t('hooks.sheet.commandNote')));
  // timeout / async。元の timeout が欄で扱えない値（文字列・小数・範囲外）なら欄は空にし、空のまま保存すれば元の値を残す
  const pair = el('div', 'hk-pair');
  const validTimeout = v => Number.isInteger(v) && v >= 1 && v <= 86400;
  const oddTimeout = editing && original.timeout !== null && original.timeout !== undefined && !validTimeout(original.timeout);
  const timeout = el('input'); timeout.className = 'hk-input'; timeout.type = 'number'; timeout.min = '1'; timeout.step = '1'; timeout.value = editing && validTimeout(original.timeout) ? String(original.timeout) : '';
  timeout.placeholder = oddTimeout ? t('hooks.sheet.timeoutKeepHint') : t('hooks.sheet.timeoutDefault');
  const timeoutField = field(t('hooks.sheet.timeout'), timeout);
  const asyncSelect = el('select'); asyncSelect.className = 'hk-input';
  for (const [v, text] of [['false', t('hooks.sheet.sync')], ['true', t('hooks.sheet.async')]]) { const o = el('option', null, text); o.value = v; asyncSelect.append(o); }
  asyncSelect.value = editing && original.async === true ? 'true' : 'false';
  const asyncField = field('async', asyncSelect);
  pair.append(timeoutField, asyncField);
  const timeoutNote = el('p', 'mcp-note', oddTimeout ? t('hooks.sheet.timeoutKept', { value: JSON.stringify(original.timeout) }) : '');
  timeoutNote.hidden = !oddTimeout;
  const asyncNote = el('p', 'mcp-note');
  // 書き先
  const scopeSelect = el('select'); scopeSelect.className = 'hk-input';
  for (const [v, text] of [['user', t('hooks.scope.user')], ['project', t('hooks.scope.project')], ['local', t('hooks.sheet.localOnly')]]) { const o = el('option', null, text); o.value = v; scopeSelect.append(o); }
  scopeSelect.value = state.scope; scopeSelect.disabled = editing;
  scopeSelect.onchange = () => { state.scope = scopeSelect.value; paint(); paintTargets(); };
  const scopeField = field(t('hooks.sheet.scope'), scopeSelect);
  const base = el('input'); base.className = 'hk-input mono'; base.value = state.base; base.placeholder = t('context.folderPath'); base.disabled = editing; base.autocomplete = 'off'; base.spellcheck = false;
  base.onchange = () => { state.base = base.value.trim(); paintTargets(); };
  const baseField = field(t('hooks.sheet.base'), base);
  const where = el('div', 'cx-note hk-where');
  const foot = el('p', 'mcp-note', t('hooks.sheet.foot'));
  const otherKeys = editing ? (original.keys ?? []).filter(k => !['type', 'command', 'timeout', 'async'].includes(k)) : [];
  if (otherKeys.length) foot.textContent = `${t('hooks.sheet.keepKeys', { keys: otherKeys.join(', ') })} ${foot.textContent}`;
  const error = el('p', 'mcp-error'); error.setAttribute('role', 'alert');
  const acts = el('div', 'mcp-acts');
  const go = button(t('hooks.sheet.review'), 'btn btn-primary'); go.type = 'submit';
  acts.append(button(t('mcp.cancel'), 'btn', () => dialog.close()), go);
  const sheetParts = [heading, lead, agentField, nameField, eventField, matcherField, cmdField, pair, timeoutNote, asyncNote, scopeField, baseField, where, foot, error, acts];
  form.append(...sheetParts);

  let targets = {};
  function paint() {
    error.textContent = '';
    const agents = state.agents, ev = state.event, tool = TOOL_EVENTS.has(ev);
    nameField.hidden = !agents.includes('antigravity');
    name.disabled = editing && entry.agent !== 'antigravity';
    support.textContent = HOOK_AGENTS.map(([id, label]) => `${label}: ${supports(scan, id, ev) ? t('hooks.sheet.supported') : t('hooks.sheet.unsupported')}`).join(t('hooks.sheet.sep'));
    // matcher はエージェントごと。Antigravity はツールのイベントだけ（ほかは無視される）
    const old = Object.fromEntries([...matcherBox.querySelectorAll('input')].map(i => [i.dataset.agent, i.value]));
    matcherBox.replaceChildren();
    for (const a of agents) {
      const l = el('label', 'hk-maprow'), i = el('input');
      i.className = 'hk-input mono'; i.dataset.agent = a; i.setAttribute('aria-label', t('hooks.sheet.matcherAria', { agent: agentLabel(a) }));
      i.value = old[a] ?? state.matchers[a] ?? (tool ? (a === 'antigravity' ? 'run_command' : 'Bash') : '');
      i.placeholder = tool ? '*' : t('hooks.sheet.matcherNone');
      i.disabled = a === 'antigravity' && !['PreToolUse', 'PostToolUse'].includes(ev);
      i.oninput = () => { state.matchers[a] = i.value; };
      l.append(el('span', null, agentLabel(a)), i);
      matcherBox.append(l);
    }
    matcherField.hidden = !agents.length;
    matcherNote.textContent = tool ? t('hooks.sheet.matcherTool') : t('hooks.sheet.matcherOther');
    const hasAgy = agents.includes('antigravity');
    asyncSelect.disabled = hasAgy;
    if (hasAgy) asyncSelect.value = 'false';
    asyncNote.textContent = hasAgy ? t('hooks.sheet.asyncAgy') : '';
    asyncNote.hidden = !hasAgy;
    paintSlash();
    const localOption = scopeSelect.querySelector('[value=local]');
    localOption.disabled = !(agents.length === 1 && agents[0] === 'claude');
    if (localOption.disabled && state.scope === 'local' && !editing) { state.scope = 'user'; scopeSelect.value = 'user'; }
    baseField.hidden = state.scope === 'user';
    paintWhere();
  }
  function paintWhere() {
    where.replaceChildren(el('b', null, t('hooks.sheet.where')));
    for (const a of state.agents) {
      const target = editing ? { path: entry.path } : targets[a];
      const line = el('div', 'hk-whereline');
      line.append(el('span', null, agentLabel(a)), el('span', 'cx-mono', target?.path ? ctx.short(target.path) : target?.error ?? (state.scope !== 'user' && !state.base ? t('hooks.sheet.baseNeeded') : '…')));
      where.append(line);
    }
    where.append(el('p', null, state.scope === 'user' ? t('hooks.sheet.userScope') : t('hooks.sheet.projectScope')));
  }
  let targetTicket = 0;
  async function paintTargets() {
    if (editing) return;
    const ticket = ++targetTicket;
    if (state.scope !== 'user' && !state.base) { targets = {}; paintWhere(); return; }
    try { const r = await ctx.cmd('hookTargets', { scope: state.scope, base: state.base || undefined }); if (ticket === targetTicket) targets = r; }
    catch (e) { if (ticket === targetTicket) targets = Object.fromEntries(HOOK_AGENTS.map(([id]) => [id, { error: e.message }])); }
    if (ticket === targetTicket) paintWhere();
  }
  // 確認の段は送信を止める。「戻る」でシートへ戻したら、この処理を付け直す
  const submit = async ev => {
    ev.preventDefault();
    error.textContent = '';
    const agents = state.agents;
    const fail = text => { error.textContent = text; };
    if (!agents.length) return fail(t('hooks.error.agents'));
    const unsupported = agents.filter(a => !supports(scan, a, state.event));
    if (unsupported.length) return fail(t('hooks.error.unsupported', { agents: unsupported.map(agentLabel).join(', ') }));
    if (!command.value.trim()) return fail(t('hooks.error.command'));
    if (agents.includes('antigravity') && !name.value.trim()) return fail(t('hooks.error.name'));
    if (state.scope !== 'user' && !state.base) return fail(t('hooks.sheet.baseNeeded'));
    const common = { event: state.event, command: command.value.trim(), timeout: timeout.value.trim() ? Number(timeout.value) : null, async: asyncSelect.value === 'true',
      ...(oddTimeout && !timeout.value.trim() ? { keepTimeout: true } : {}) };
    const matcherOf = a => matcherBox.querySelector(`input[data-agent="${a}"]`)?.value.trim() ?? '';
    const items = editing
      ? [{ op: 'edit', agent: entry.agent, scope: entry.scope, base: entry.base, file: entry.path, revision: original.revision,
        loc: { event: entry.event, group: entry.group, handler: entry.handler, name: entry.name }, name: entry.agent === 'antigravity' ? name.value.trim() : undefined,
        matcher: matcherOf(entry.agent), ...common }]
      : agents.map(a => ({ op: 'add', agent: a, scope: state.scope, base: state.base || undefined, name: a === 'antigravity' ? name.value.trim() : undefined,
        matcher: matcherOf(a), ...common, async: a === 'antigravity' ? false : common.async }));
    confirmStep(items, { back: () => { form.replaceChildren(...sheetParts); form.onsubmit = submit; heading.focus(); } });
  };
  form.onsubmit = submit;

  /** 書く前の確認。dryRun で書き先ごとの前後を取り、確かめてから書く。部分成功は行ごとに結果を出す */
  async function confirmStep(items, { back }) {
    form.onsubmit = e => e.preventDefault();
    const box = el('div', 'hk-confirm');
    form.replaceChildren(heading, box);
    if (!dialog.open) dialog.showModal();
    box.append(el('p', 'cx-sub', t('hooks.confirm.loading')));
    let dry;
    try { dry = await ctx.cmd('saveHooks', { items, dryRun: true }); }
    catch (e) { box.replaceChildren(el('p', 'mcp-error', e.message), actsOf()); return; }
    box.replaceChildren();
    const userScope = items.some(i => i.scope === 'user');
    const q = el('p', 'hk-q', items[0].op === 'delete' ? t('hooks.confirm.deleteLead') : t('hooks.confirm.lead'));
    box.append(q);
    if (userScope && items[0].op !== 'delete') box.append(el('p', 'cx-strong hk-warn', t('hooks.confirm.outside')));
    const rows = dry.results.map((r, i) => {
      const card = el('div', 'hk-target');
      const h = el('div', 'row-line');
      h.append(el('b', null, agentLabel(items[i].agent)), el('span', 'cx-path', r.path ? ctx.short(r.path) : ''));
      card.append(h);
      if (!r.ok) { card.append(el('p', 'cx-strong', t('hooks.confirm.cannot', { error: r.error }))); return { card, ok: false }; }
      // 実際に書く本文（伏せ字済み）の行の差分。形式（TOML / JSON）の札を付ける
      card.append(el('span', 'hk-lang', String(r.format ?? '').toUpperCase()), diffView(lineDiff(r.before ?? '', r.after ?? '')));
      if (r.hiddenChange) card.append(el('p', 'mcp-note cx-strong', t('hooks.confirm.hiddenChange')));
      if (items[i].agent === 'codex' && items[i].op !== 'delete') card.append(el('p', 'mcp-note', t('hooks.confirm.codexTrust')));
      let allow = null;
      if (r.reformatsFile) {
        const l = el('label', 'hk-check'); allow = el('input'); allow.type = 'checkbox';
        const why = r.reason === 'comments' ? t('hooks.confirm.lostComments', { n: r.lostComments })
          : r.reason === 'jsonValues' ? t('hooks.confirm.jsonValues') : t('hooks.confirm.reformat', { n: r.lostComments ?? 0 });
        l.append(allow, document.createTextNode(why));
        card.append(l);
      }
      box.append(card);
      return { card, ok: true, allow, item: { ...items[i], revision: r.revision } };
    });
    for (const r of rows) if (!r.ok) box.append(r.card);
    const ackLabel = el('label', 'hk-check'), ack = el('input'); ack.type = 'checkbox';
    ackLabel.append(ack, document.createTextNode(items[0].op === 'delete' ? t('hooks.confirm.ackDelete') : t('hooks.confirm.ack')));
    const ready = rows.filter(r => r.ok);
    const go = button('', 'btn btn-primary');
    const paintGo = () => { go.textContent = items[0].op === 'delete' ? t('hooks.confirm.delete') : t('hooks.confirm.write', { n: ready.length }); go.disabled = !ack.checked || !ready.length || ready.some(r => r.allow && !r.allow.checked); };
    ack.onchange = paintGo;
    for (const r of ready) if (r.allow) r.allow.onchange = paintGo;
    paintGo();
    const status = el('p', 'mcp-error'); status.setAttribute('role', 'alert');
    go.onclick = async () => {
      go.disabled = true;
      status.textContent = '';
      let result;
      try { result = await ctx.cmd('saveHooks', { items: ready.map(r => r.item), allowReformat: ready.some(r => r.allow?.checked) }); }
      catch (e) { status.textContent = e.message; paintGo(); return; }
      const failed = result.results.filter(r => !r.ok);
      if (!failed.length) { dialog.close(); await ctx.onSaved?.(); return; }
      // 部分成功: 書けた先と書けなかった先を分けて見せる。書けた分は戻さない
      result.results.forEach((r, i) => ready[i].card.append(el('p', r.ok ? 'cx-sub' : 'cx-strong', r.ok ? t('hooks.confirm.written') : t('hooks.confirm.failed', { error: r.error }))));
      status.textContent = t('hooks.confirm.partial', { ok: result.results.length - failed.length, failed: failed.length });
      go.remove();
      await ctx.onSaved?.();
    };
    box.append(ackLabel, status, actsOf(go));
    function actsOf(primary) {
      const a = el('div', 'mcp-acts');
      if (back) a.append(button(t('hooks.confirm.back'), 'btn', () => back()));
      a.append(button(t('mcp.cancel'), 'btn', () => dialog.close()));
      if (primary) a.append(primary);
      return a;
    }
    heading.focus();
  }

  paint();
  paintTargets();
  dialog.showModal();
  heading.focus();
}

// ---------------------------------------------------------------- 他のエージェントへ写す（④。ADR 0047）
// i18n-dynamic: hooks.copy.reason.
// i18n-dynamic: hooks.copy.warn.
// i18n-dynamic: hooks.copy.status.
/**
 * 1 つの定義を他のエージェントへ写す前の確認（外部 MCP・追加のシートと同じ <dialog>）。
 * 写す先ごとに、元 → 写した後（イベント・matcher・timeout・コマンド）、実際に書く本文の差分（サーバーの dryRun）、書き先、
 * 写せない・確認が必要な理由、確かめること（意味の違い）を並べる。行のスイッチは既定オフで、写せる（ready）行だけ選べる。
 * 実行範囲の確認のチェックを入れ、1 件以上選ぶまで確定できない。元の定義はサーバーがファイルから読み直す（画面の値は使わない）
 */
export async function openCopySheet(ctx, entry) {
  document.querySelector('dialog.hk-sheet')?.remove();
  const dialog = el('dialog', 'mcp-sheet hk-sheet hk-copy-sheet');
  const form = el('form');
  form.onsubmit = ev => ev.preventDefault();
  dialog.append(form);
  dialog.addEventListener('close', () => dialog.remove());
  document.body.append(dialog);
  const heading = el('h3', null, t('hooks.copy.title'));
  heading.tabIndex = -1;
  dialog.setAttribute('aria-label', heading.textContent);
  const to = HOOK_AGENTS.map(([id]) => id).filter(a => a !== entry.agent);
  const fileRev = ctx.scan?.files?.find(f => f.path === entry.path)?.revision;
  const source = { agent: entry.agent, scope: entry.scope, base: entry.base ?? undefined, file: entry.path,
    loc: { event: entry.event, group: entry.group, handler: entry.handler, name: entry.name }, ...(fileRev ? { revision: fileRev } : {}) };
  const state = { scope: entry.scope === 'user' ? 'user' : 'project', base: entry.base ?? '',
    rows: Object.fromEntries(to.map(a => [a, { on: false, name: '', matcher: '', allow: false }])) };
  let dry = null, ticket = 0, busy = false;
  const matcherText = m => (m === null || m === undefined ? t('hooks.fact.none') : m || '*');
  const seconds = n => (Number.isFinite(n) ? t('hooks.fact.seconds', { n }) : t('hooks.fact.default'));

  // 元の定義（どの写し先でも同じなので 1 回だけ）
  const src = el('div', 'cx-note hk-where hk-src');
  const srcHead = el('div', 'hk-whereline');
  srcHead.append(el('b', null, t('hooks.copy.source')), el('span', null, `${agentLabel(entry.agent)} · ${scopeLabel(entry)} · ${eventLabel(entry.event)} · ${entry.event}`));
  const srcCode = el('div');
  srcCode.innerHTML = codeBlock(JSON.stringify(entry.matcher === null || entry.matcher === undefined ? entry.definition : { matcher: entry.matcher, ...entry.definition }, null, 2), 'json');
  src.append(srcHead, el('span', 'cx-mono', ctx.short(entry.path)), srcCode);
  // 書き先のスコープ
  const field = (text, control) => { const box = el('div', 'mcp-field'), label = el('label', 'hk-label'); label.append(text, control); box.append(label); return box; };
  const scopeSelect = el('select'); scopeSelect.className = 'hk-input';
  for (const [v, text] of [['user', t('hooks.scope.user')], ['project', t('hooks.scope.project')]]) { const o = el('option', null, text); o.value = v; scopeSelect.append(o); }
  scopeSelect.value = state.scope;
  const base = el('input'); base.className = 'hk-input mono'; base.value = state.base; base.placeholder = t('context.folderPath'); base.autocomplete = 'off'; base.spellcheck = false;
  const baseField = field(t('hooks.sheet.base'), base);
  const changed = () => { ack.checked = false; for (const row of Object.values(state.rows)) { row.on = false; row.allow = false; } refresh(); };
  scopeSelect.onchange = () => { state.scope = scopeSelect.value; baseField.hidden = state.scope === 'user'; changed(); };
  base.onchange = () => { state.base = base.value.trim(); changed(); };
  baseField.hidden = state.scope === 'user';
  const range = el('p', 'cx-strong hk-warn');
  const rowsBox = el('div', 'hk-copyrows');
  const ackLabel = el('label', 'hk-check'), ack = el('input'); ack.type = 'checkbox';
  ackLabel.append(ack, document.createTextNode(t('hooks.copy.ack')));
  ack.onchange = () => paintGo();
  const status = el('p', 'mcp-error'); status.setAttribute('role', 'alert');
  const go = button('', 'btn btn-primary');
  const acts = el('div', 'mcp-acts');
  acts.append(button(t('mcp.cancel'), 'btn', () => dialog.close()), go);
  const box = el('div', 'hk-confirm');
  box.append(el('p', 'mcp-note', t('hooks.copy.lead', { agent: agentLabel(entry.agent) })), src, field(t('hooks.sheet.scope'), scopeSelect), baseField, range, rowsBox, ackLabel, status, acts);
  form.append(heading, box);

  const targetOf = a => ({ agent: a, scope: state.scope, ...(state.scope === 'user' ? {} : { base: state.base }),
    ...(a === 'antigravity' && state.rows[a].name ? { name: state.rows[a].name } : {}), ...(state.rows[a].matcher ? { matcher: state.rows[a].matcher } : {}) });
  const selectable = r => r.ok && r.status === 'ready';
  const chosen = () => (dry?.results ?? []).filter(r => selectable(r) && state.rows[r.agent]?.on);
  function paintGo() {
    const list = chosen();
    go.textContent = t('hooks.copy.go', { n: list.length });
    go.disabled = busy || !ack.checked || !list.length || list.some(r => r.reformatsFile && !state.rows[r.agent].allow);
  }
  /** 書かずに変換の結果と書く本文を取り直す（スコープ・名前・matcher を変えたとき） */
  async function refresh() {
    const mine = ++ticket;
    range.textContent = state.scope === 'user' ? t('hooks.copy.rangeUser') : t('hooks.copy.rangeProject');
    dry = null; paintGo();
    if (state.scope !== 'user' && !state.base) { rowsBox.replaceChildren(el('p', 'mcp-note', t('hooks.sheet.baseNeeded'))); return; }
    rowsBox.replaceChildren(el('p', 'cx-sub', t('hooks.copy.loading')));
    let r;
    try { r = await ctx.cmd('copyHooks', { source, targets: to.map(targetOf), dryRun: true }); }
    catch (e) { if (mine === ticket) { const p = el('p', 'mcp-error', e.message); p.setAttribute('role', 'alert'); rowsBox.replaceChildren(p); } return; }
    if (mine !== ticket) return;
    dry = r;
    rowsBox.replaceChildren(...r.results.map(rowCard));
    paintGo();
  }
  /** 写す先を 1 つ入れ直す欄（Antigravity の名前・写す先の matcher）。「確かめる」で dryRun を取り直す */
  function redo(label, value, placeholder, apply) {
    const line = el('div', 'hk-redo');
    const i = el('input'); i.className = 'hk-input mono'; i.value = value; i.placeholder = placeholder; i.autocomplete = 'off'; i.spellcheck = false;
    const l = el('label', 'hk-label'); l.append(label, i);
    const b = button(t('hooks.copy.recheck'), 'btn', () => { apply(i.value.trim()); changed(); });
    i.onkeydown = ev => { if (ev.key === 'Enter') { ev.preventDefault(); b.click(); } };
    line.append(l, b);
    return line;
  }
  function rowCard(r) {
    const a = r.agent, st = state.rows[a];
    if (!selectable(r)) st.on = false;
    const card = el('div', 'hk-target hk-copyrow'); card.dataset.agent = a;
    const head = el('div', 'row-line hk-copyhead');
    const sw = button('', 'cx-sw');
    sw.setAttribute('role', 'switch'); sw.setAttribute('aria-checked', String(st.on)); sw.setAttribute('aria-label', t('hooks.copy.switch', { agent: agentLabel(a) }));
    sw.disabled = !selectable(r);
    sw.onclick = () => { st.on = !st.on; sw.setAttribute('aria-checked', String(st.on)); paintGo(); };
    head.append(el('b', null, t('hooks.copy.to', { agent: agentLabel(a) })), el('span', 'hk-state', t(`hooks.copy.status.${r.error ? 'blocked' : r.status}`)), sw);
    card.append(head);
    if (r.error) { card.append(el('p', 'cx-strong', t('hooks.confirm.cannot', { error: r.error }))); return card; }
    // 写せない理由・確認が必要な理由（強い字）
    if (r.reasons?.length) {
      const ul = el('ul', 'hk-reasons cx-strong');
      for (const x of r.reasons) ul.append(el('li', null, t(`hooks.copy.reason.${x.code}`, x.params ?? {})));
      card.append(ul);
      if (!selectable(r)) sw.setAttribute('aria-describedby', ul.id = `hk-copy-reason-${a}`);
    }
    const blocked = r.status === 'blocked';
    // 元 → 写した後
    const facts = el('div', 'fm facts');
    const put = (k, v) => facts.append(el('span', 'k', k), el('span', 'v', v));
    // 対応するイベントが無い先は、matcher を並べない（写した後の形が無い）
    const noEvent = r.reasons?.some(x => x.code === 'event');
    put(t('hooks.fact.event'), noEvent ? `${r.event} → ${t('hooks.copy.noEvent')}` : r.event);
    if (!noEvent) put('matcher', `${matcherText(dry.source.matcher)} → ${r.matcher === null ? t('hooks.fact.none') : r.matcher === '' && r.matcherStatus === 'review' ? '—' : matcherText(r.matcher)}`);
    if (!blocked) {
      put('timeout', `${seconds(dry.source.timeout)} → ${seconds(r.timeout)}${r.innerTimeout ? ` ${t('hooks.copy.innerTimeout', { n: r.innerTimeout })}` : ''}`);
      if (r.name) put(t('hooks.sheet.name'), r.name);
      put(t('hooks.copy.command'), r.adapter ? t('hooks.copy.viaAdapter') : t('hooks.copy.sameCommand'));
    }
    card.append(facts);
    // 入れ直す欄: agy の名前（いつでも変えられる）、写す先の matcher（自動で訳せないとき）
    if (!blocked && a === 'antigravity') card.append(redo(t('hooks.copy.name'), st.name || r.name || '', 'audit', v => { st.name = v; }));
    if (!blocked && (r.reasons.some(x => x.review === 'matcher') || r.matcherStatus === 'chosen'))
      card.append(redo(t('hooks.copy.matcher', { agent: agentLabel(a) }), st.matcher, a === 'antigravity' ? 'run_command' : 'Bash', v => { st.matcher = v; }));
    if (r.adapter && !blocked) {
      card.append(el('p', 'mcp-note', r.adapter.exists ? t('hooks.copy.adapterReuse', { path: ctx.short(r.adapter.path) }) : t('hooks.copy.adapterWrite', { path: ctx.short(r.adapter.path) })));
      if (state.scope === 'project') card.append(el('p', 'cx-strong', t('hooks.copy.projectAdapterRepo')));
    }
    // 実際に書く本文の差分（伏せ字済み）
    // matcher を確かめる前は、仮の matcher（全件）で作った本文を見せない
    if (r.reasons?.some(x => x.review === 'matcher')) card.append(el('p', 'mcp-note', t('hooks.copy.diffPending')));
    else if (r.after !== undefined) {
      card.append(el('span', 'hk-lang', t('hooks.copy.diff', { format: String(r.format ?? '').toUpperCase() })), diffView(lineDiff(r.before ?? '', r.after ?? '')));
      if (r.hiddenChange) card.append(el('p', 'mcp-note cx-strong', t('hooks.confirm.hiddenChange')));
    }
    if (r.path) card.append(el('p', 'cx-sub hk-copywhere', t('hooks.copy.where', { scope: t(`hooks.scope.${r.scope === 'local' ? 'local' : r.scope}`), path: ctx.short(r.path) })));
    // 確かめること（意味の違い）
    if (r.warnings?.length) {
      const d = el('div', 'hk-warns');
      d.append(el('b', null, t('hooks.copy.warnTitle', { n: r.warnings.length })));
      const ul = el('ul');
      for (const w of r.warnings) ul.append(el('li', null, t(`hooks.copy.warn.${w.code}`, w.params ?? {})));
      d.append(ul);
      card.append(d);
    }
    if (a === 'codex' && !blocked) card.append(el('p', 'mcp-note', t('hooks.copy.codexBefore')));
    if (r.reformatsFile && !blocked) {
      const l = el('label', 'hk-check'), allow = el('input'); allow.type = 'checkbox'; allow.checked = st.allow;
      allow.onchange = () => { st.allow = allow.checked; paintGo(); };
      l.append(allow, document.createTextNode(r.reason === 'comments' ? t('hooks.confirm.lostComments', { n: r.lostComments })
        : r.reason === 'jsonValues' ? t('hooks.confirm.jsonValues') : t('hooks.confirm.reformat', { n: r.lostComments ?? 0 })));
      card.append(l);
    }
    return card;
  }
  go.onclick = async () => {
    const list = chosen();
    busy = true; paintGo(); status.textContent = '';
    let result;
    try {
      result = await ctx.cmd('copyHooks', { source: { ...source, revision: dry.source.revision },
        targets: list.map(r => ({ ...targetOf(r.agent), revision: r.revision })), allowReformat: list.some(r => r.reformatsFile && state.rows[r.agent].allow) });
    } catch (e) { busy = false; status.textContent = e.message; paintGo(); return; }
    // 結果: 書けた先と書けなかった先を分けて出す（書けた分は戻さない）。Codex は写しても審査するまで動かない
    const done = el('div', 'hk-confirm');
    const failed = result.results.filter(r => !r.ok).length;
    done.append(el('p', 'hk-q', failed ? t('hooks.copy.partial', { ok: result.results.length - failed, failed }) : t('hooks.copy.done', { n: result.results.length })));
    for (const r of result.results) {
      const card = el('div', 'hk-target');
      const h = el('div', 'row-line');
      h.append(el('b', null, t('hooks.copy.to', { agent: agentLabel(r.agent) })), el('span', 'cx-path', r.path ? ctx.short(r.path) : ''));
      card.append(h, el('p', r.ok ? 'cx-sub' : 'cx-strong', r.ok ? t('hooks.copy.written') : t('hooks.confirm.failed', { error: r.error || r.reasons?.map(x => t(`hooks.copy.reason.${x.code}`, x.params ?? {})).join(' ') || t('hooks.copy.status.blocked') })));
      if (r.ok && r.agent === 'codex') card.append(el('p', 'cx-strong', t('hooks.copy.codexAfter')));
      if (r.ok && r.name) card.append(el('p', 'cx-sub', t('hooks.copy.agyAfter', { name: r.name })));
      done.append(card);
    }
    const close = el('div', 'mcp-acts');
    close.append(button(t('hooks.copy.close'), 'btn btn-primary', () => dialog.close()));
    done.append(close);
    form.replaceChildren(heading, done);
    heading.focus();
    await ctx.onSaved?.();
  };
  paintGo();
  dialog.showModal();
  heading.focus();
  await refresh();
}

/** 差分の行（web/session-context.mjs の差分と同じ見た目。色ではなく − / + の記号と面の階調）。変わった行の前後 2 行だけ残し、あとは「n 行同じ」に畳む */
function diffView(ops) {
  const box = el('div', 'scx-lines');
  const keep = ops.map((o, i) => o.t !== ' ' || ops.slice(Math.max(0, i - 2), i + 3).some(n => n.t !== ' '));
  for (let i = 0; i < ops.length;) {
    if (!keep[i]) {
      let j = i;
      while (j < ops.length && !keep[j]) j++;
      box.append(el('div', 'skip', t('sessionContext.diff.same', { count: j - i })));
      i = j;
      continue;
    }
    const o = ops[i++];
    const r = el('div', o.t === '-' ? 'del' : o.t === '+' ? 'add' : '');
    r.append(el('span', 'g', o.t === '-' ? '−' : o.t === '+' ? '+' : ''), el('span', null, o.s || ' '));
    box.append(r);
  }
  return box;
}
