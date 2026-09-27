// ==================== Hooks を「Pleiad がそろえる」の画面（ADR 0049） ====================
// docs/design-system.md「Hooks」の「Pleiad がそろえる」。
//   - 切り替えの確認（unifyConfirmPanel）: 担当を変える前にその場で出す面（ADR 0031 に倣う。モーダルは使わない）。
//     止まるネイティブの hooks（行ごとに「Pleiad に取り込む」）、動き続けるもの、Pleiad の登録として動くもの、エージェントごとに渡せないもの。
//     戻すときは再開するネイティブの hooks を見せる。決めると担当と取り込みを 1 回で保存する（setHooksOwner）
//   - Pleiad の登録の一覧（plyRegistryTier）と追加・編集のシート（openPlyHookSheet）。登録は <data>/hooks.json で、エージェントの設定ファイルは書かない
//   - 会話の右パネルの面（unifySessionBox）: 渡した hooks・止めたネイティブ・渡せなかったもの・漏れ
import { el } from './dom.mjs';
import { t } from './i18n.mjs';
import { runMark } from './arc.mjs';
import { HOOK_AGENTS, agentLabel, eventLabel, scopeLabel } from './hooks-card.mjs';

const TOOL_EVENTS = new Set(['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest', 'PermissionDenied']);
function button(text, className = 'btn', onClick) {
  const b = el('button', className, text);
  b.type = 'button';
  if (onClick) b.onclick = onClick;
  return b;
}
const badge = text => el('span', 'cbadge', text);
function sw(on, label, onClick, disabled = false) {
  const b = button('', 'cx-sw', onClick);
  b.setAttribute('role', 'switch'); b.setAttribute('aria-checked', String(on)); b.setAttribute('aria-label', label);
  b.disabled = disabled;
  return b;
}
// i18n-dynamic: hooks.copy.reason.
// i18n-dynamic: hooks.unify.reason.
/** 渡せない理由の文。第 2 段の理由（hooks.copy.reason.*）に無いものは hooks.unify.reason.* */
export function reasonText(r) {
  const own = `hooks.unify.reason.${r.code}`, s = t(own, r.params ?? {});
  if (s !== own) return s;
  const copy = `hooks.copy.reason.${r.code}`, c = t(copy, r.params ?? {});
  return c === copy ? r.code : c;
}
// i18n-dynamic: hooks.unify.importWhy.
const importWhy = code => { const k = `hooks.unify.importWhy.${code}`, s = t(k); return s === k ? code : s; };
// i18n-dynamic: hooks.unify.via.
/** その登録をエージェントへどう渡すか（1 行） */
export function deliveryText(agent, d) {
  if (!d) return t('hooks.unify.notTarget');
  if (d.status !== 'ok') return t('hooks.unify.cannotPass', { reasons: d.reasons.map(reasonText).join(' ') });
  const via = t(`hooks.unify.via.${agent}`);
  return d.adapter ? t('hooks.unify.viaAdapter', { via }) : via;
}
const rowTitle = r => r.name ?? r.command ?? r.event;
function nativeLine(r) {
  const bits = [agentLabel(r.agent), r.plugin ? t('hooks.unify.pluginName', { name: r.plugin }) : scopeLabel(r), `${eventLabel(r.event)} · ${r.event}`];
  if (r.matcher) bits.push(t('hooks.row.matcher', { matcher: r.matcher }));
  return bits.join(' · ');
}

// ---------------------------------------------------------------- 切り替えの確認
/**
 * direction: 'ply'（そろえる）| 'native'（エージェントに任せるへ戻す）。cwd があればその場所の上書きとして保存する（右パネルの「この場所だけ変える」）。
 * onDone(view) は保存した後の担当と登録の形、onCancel は何も保存しない
 */
export function unifyConfirmPanel({ cmd, cwd = null, direction, short = p => p, onDone, onCancel }) {
  const box = el('div', 'cx-confirm hk-unify');
  box.setAttribute('role', 'group');
  const q = el('p', 'q', direction === 'ply' ? t('hooks.unify.question') : t('hooks.unify.returnQuestion'));
  q.id = `hkUnify${Math.random().toString(36).slice(2, 8)}`;
  box.setAttribute('aria-labelledby', q.id);
  const loading = el('p', 'cx-sub');
  loading.append(runMark(t('hooks.unify.loading')), ` ${t('hooks.unify.loading')}`);
  box.append(q, loading);
  const picked = new Set();
  let data = null, busy = false;
  const status = el('p', 'mcp-error'); status.setAttribute('role', 'alert');
  const ackLabel = el('label', 'hk-check'), ack = el('input'); ack.type = 'checkbox';
  ackLabel.append(ack, document.createTextNode(direction === 'ply' ? t('hooks.unify.ack') : t('hooks.unify.ackReturn')));
  const ok = button('', 'btn btn-primary');
  const paintOk = () => {
    ok.textContent = direction === 'ply' ? (picked.size ? t('hooks.unify.confirmImport', { n: picked.size }) : t('hooks.unify.confirm')) : t('hooks.unify.confirmReturn');
    ok.disabled = busy || !data || !ack.checked;
  };
  ack.onchange = paintOk;
  ok.onclick = async () => {
    busy = true; paintOk(); status.textContent = '';
    try {
      const view = await cmd('setHooksOwner', { place: cwd, cwd, value: { owner: direction, disabled: data.owner?.disabled ?? [] }, imports: direction === 'ply' ? [...picked] : [] });
      onDone(view);
    } catch (e) { busy = false; status.textContent = e.message; paintOk(); }
  };
  const acts = el('div', 'acts');
  acts.append(button(t('mcp.cancel'), 'btn', () => onCancel()), ok);
  paintOk();

  const section = (title, count, open = true) => {
    const d = el('details', 'cx-fold hk-unify-sec');
    d.open = open;
    d.append(el('summary', null, t('hooks.unify.section', { title, n: count })));
    return d;
  };
  cmd('hooksUnifyPreview', { cwd, direction }).then(r => {
    data = r;
    loading.remove();
    const warn = el('p', 'cx-strong hk-warn', direction === 'ply' ? t('hooks.unify.warn') : t('hooks.unify.returnWarn'));
    const lead = el('p', 'cx-sub', direction === 'ply' ? (cwd ? t('hooks.unify.leadPlace') : t('hooks.unify.leadUser')) : t('hooks.unify.returnLead'));
    box.insertBefore(warn, null); box.append(lead);
    for (const f of r.files ?? []) box.append(el('p', 'cx-note', t('hooks.unify.fileError', { agent: agentLabel(f.agent), path: short(f.path), error: f.error ?? '' })));
    // 止まる（戻すときは再開する）ネイティブの hooks
    const stops = section(direction === 'ply' ? t('hooks.unify.stops') : t('hooks.unify.resumes'), r.stops.length);
    const list = el('div', 'cx-list');
    for (const s of r.stops) {
      const row = el('div', 'cx-row hk-unify-row');
      const body = el('span', 't');
      body.append(el('span', 'nm hk-cmd', rowTitle(s)), el('span', 'p', nativeLine(s)));
      if (s.name && s.command) body.append(el('span', 'p hk-cmd', s.command));
      if (s.unverified) body.append(el('span', 'p', t('hooks.unify.skillUnverified')));
      row.append(body);
      if (direction === 'ply') {
        if (s.importable) {
          const label = t('hooks.unify.importSwitch', { name: rowTitle(s) });
          const toggle = sw(false, label, () => {
            if (picked.has(s.id)) picked.delete(s.id); else picked.add(s.id);
            toggle.setAttribute('aria-checked', String(picked.has(s.id)));
            paintOk(); paintRegistry();
          });
          const wrap = el('span', 'hk-import');
          wrap.append(el('span', 'hk-state', t('hooks.unify.import')), toggle);
          row.append(wrap);
        } else row.append(el('span', 'hk-state', s.reasons.map(importWhy).join(' ')));
      }
      list.append(row);
    }
    if (!r.stops.length) list.append(el('p', 'cx-empty', direction === 'ply' ? t('hooks.unify.noStops') : t('hooks.unify.noResumes')));
    stops.append(list);
    if (direction === 'ply') stops.append(el('p', 'cx-sub', t('hooks.unify.importNote')));
    box.append(stops);
    // 動き続けるもの（止め方の無い出どころ）
    if (r.keeps.length) {
      const keeps = section(t('hooks.unify.keeps'), r.keeps.length, false);
      const kl = el('div', 'cx-list');
      for (const k of r.keeps) { const row = el('div', 'cx-row'); const b = el('span', 't'); b.append(el('span', 'nm hk-cmd', rowTitle(k)), el('span', 'p', nativeLine(k))); row.append(b); kl.append(row); }
      keeps.append(kl, el('p', 'cx-sub', t('hooks.unify.keepsNote')));
      box.append(keeps);
    }
    // Pleiad の登録として動くもの（戻すときは渡さなくなるもの）と、エージェントごとの渡し方
    const reg = section(direction === 'ply' ? t('hooks.unify.registry') : t('hooks.unify.registryStops'), r.registry.filter(h => h.enabled).length);
    const regList = el('div', 'hk-unify-reg');
    reg.append(regList);
    box.append(reg);
    function paintRegistry() {
      regList.replaceChildren();
      const rows = [...r.registry.filter(h => h.enabled && !h.disabledHere).map(h => ({ ...h, imported: false })),
        ...(direction === 'ply' ? r.stops.filter(s => picked.has(s.id)).map(s => ({ name: rowTitle(s), agent: s.agent, event: s.event, matcher: s.matcher, command: s.command, imported: true,
          targets: Object.fromEntries(HOOK_AGENTS.map(([a]) => [a, a === s.agent ? { status: s.agent === 'claude' && ['SessionStart', 'Setup'].includes(s.event) ? 'blocked' : 'ok',
            reasons: s.agent === 'claude' && ['SessionStart', 'Setup'].includes(s.event) ? [{ code: 'claudeCallback', params: { event: s.event } }] : [], adapter: a === 'antigravity' } : null])) })) : [])];
      for (const h of rows) {
        const card = el('div', 'hk-target');
        const head = el('div', 'row-line');
        head.append(el('b', null, h.name), badge(t('hooks.unify.form', { agent: agentLabel(h.agent) })), ...(h.imported ? [badge(t('hooks.unify.importing'))] : []));
        card.append(head, el('span', 'cx-sub', `${eventLabel(h.event)} · ${h.event}${h.matcher ? ` · ${t('hooks.row.matcher', { matcher: h.matcher })}` : ''}`), el('span', 'cx-mono hk-cmd', h.command ?? ''));
        const facts = el('div', 'fm facts');
        for (const [a, label] of HOOK_AGENTS) { const d = h.targets?.[a]; if (!d) continue; facts.append(el('span', 'k', label), el('span', 'v' + (d.status === 'ok' ? '' : ' cx-strong'), deliveryText(a, d))); }
        card.append(facts);
        regList.append(card);
      }
      if (!rows.length) regList.append(el('p', 'cx-empty', direction === 'ply' ? t('hooks.unify.noRegistry') : t('hooks.unify.noRegistryStops')));
      reg.querySelector('summary').textContent = t('hooks.unify.section', { title: direction === 'ply' ? t('hooks.unify.registry') : t('hooks.unify.registryStops'), n: rows.length });
    }
    paintRegistry();
    // エージェントごとに渡せないもの・止められないもの（報告の制約）
    // i18n-dynamic: hooks.unify.limit.
    const limits = section(t('hooks.unify.limits'), 4, direction === 'ply');
    const ul = el('ul', 'hk-reasons');
    for (const k of ['claudeSessionStart', 'claudeManaged', 'codexPlugins', 'afterStart']) ul.append(el('li', null, t(`hooks.unify.limit.${k}`)));
    limits.append(ul);
    if (direction === 'ply') box.append(limits);
    box.append(ackLabel, status, acts);
    paintOk();
  }).catch(e => { loading.replaceChildren(el('span', 'mcp-error', t('hooks.unify.previewFailed', { error: e.message }))); box.append(acts); });
  return box;
}

// ---------------------------------------------------------------- Pleiad の登録の一覧（担当が Pleiad のとき。モック ①）
/**
 * view: plyHooks の戻り、stopped: 止めているネイティブの行（設定の画面はユーザーの範囲）。onChanged(view) で描き直す
 */
export function plyRegistryTier({ cmd, view, stopped = [], opened, short = p => p, onChanged, work }) {
  const tier = el('div', 'cx-tier');
  const th = el('div', 'cx-tierh');
  th.append(el('span', 'n', t('hooks.unify.registryTier')), el('span', null, t('hooks.unify.registryTierSub')));
  tier.append(th);
  const list = el('div', 'cx-list');
  list.setAttribute('role', 'group'); list.setAttribute('aria-label', t('hooks.unify.registryAria'));
  const hooks = [...(view?.hooks ?? [])].sort((a, b) => a.event.localeCompare(b.event));
  let lastEvent = null;
  for (const h of hooks) {
    if (h.event !== lastEvent) {
      lastEvent = h.event;
      const head = el('div', 'hk-ev');
      head.append(el('b', null, eventLabel(h.event)), el('span', 'cx-mono', h.event));
      list.append(head);
    }
    const r = el('div', 'cx-row' + (h.enabled ? '' : ' off'));
    r.dataset.plyHook = h.id;
    const open = button('', 'cx-open');
    const key = `plyhook:${h.id}`;
    open.setAttribute('aria-expanded', String(opened.has(key)));
    const body = el('span', 't');
    const nm = el('span', 'nm');
    nm.append(el('span', null, h.name), ...h.targets.map(a => badge(agentLabel(a))));
    body.append(nm, el('span', 'p', [t('hooks.unify.form', { agent: agentLabel(h.agent) }), h.matcher ? t('hooks.row.matcher', { matcher: h.matcher }) : null,
      h.importedFrom ? t('hooks.unify.importedFrom', { agent: agentLabel(h.importedFrom.agent), scope: t(`hooks.scope.${h.importedFrom.scope}`) }) : null].filter(Boolean).join(' · ')), el('span', 'p hk-cmd', h.command));
    open.append(body);
    open.onclick = () => { if (opened.has(key)) opened.delete(key); else opened.add(key); onChanged(view); };
    const toggle = sw(h.enabled, t('hooks.unify.toggleAria', { name: h.name }), () => work(async () => {
      toggle.disabled = true;
      onChanged(await cmd('togglePlyHook', { id: h.id, enabled: !h.enabled }), true);
    }));
    r.append(open, toggle);
    list.append(r);
    if (opened.has(key)) list.append(plyPeek(h, { cmd, onChanged, work }));
  }
  if (!hooks.length) list.append(el('p', 'cx-empty', t('hooks.unify.registryEmpty')));
  tier.append(list);
  const add = button('', 'cx-add', () => openPlyHookSheet({ cmd, onSaved: v => onChanged(v, true) }));
  add.append(document.createTextNode(`＋ ${t('hooks.add')}`));
  tier.append(add, el('p', 'cx-sub', t('hooks.unify.registryFoot')));
  // 止めているネイティブの hooks（件数と中身。モック ①）
  const d = el('details', 'cx-fold hk-stopped');
  d.append(el('summary', null, t('hooks.unify.stoppedNative', { n: stopped.length })));
  const sl = el('div', 'cx-list');
  for (const s of stopped) { const row = el('div', 'cx-row'); const b = el('span', 't'); b.append(el('span', 'nm hk-cmd', rowTitle(s)), el('span', 'p', nativeLine(s))); row.append(b); sl.append(row); }
  if (!stopped.length) sl.append(el('p', 'cx-empty', t('hooks.unify.noStops')));
  d.append(sl, el('p', 'cx-sub', t('hooks.unify.stoppedNote')));
  tier.append(d);
  return tier;
}
function plyPeek(h, { cmd, onChanged, work }) {
  const box = el('div', 'cx-peek hk-peek');
  const facts = el('div', 'fm facts');
  const put = (k, v) => { if (v !== null && v !== undefined && v !== '') facts.append(el('span', 'k', k), el('span', 'v', String(v))); };
  put(t('hooks.unify.formLabel'), agentLabel(h.agent));
  put(t('hooks.fact.event'), `${eventLabel(h.event)} · ${h.event}`);
  put('matcher', h.matcher || '*');
  put('timeout', h.timeout ? t('hooks.fact.seconds', { n: h.timeout }) : t('hooks.fact.default'));
  put('async', String(h.async === true));
  put(t('hooks.unify.command'), h.command);
  if (h.importedFrom) put(t('hooks.unify.importedLabel'), `${agentLabel(h.importedFrom.agent)} · ${h.importedFrom.plugin ?? t(`hooks.scope.${h.importedFrom.scope}`)} · ${h.importedFrom.path}`);
  box.append(facts);
  const how = el('div', 'fm facts hk-how');
  how.append(el('span', 'k', t('hooks.unify.howTitle')), el('span', 'v', '…'));
  box.append(how);
  cmd('plyHookPreview', { value: { ...h, command: 'x' } }).then(r => {
    how.replaceChildren();
    for (const [a, label] of HOOK_AGENTS) { const d = r.targets[a]; if (!d) continue; how.append(el('span', 'k', label), el('span', 'v' + (d.status === 'ok' ? '' : ' cx-strong'), deliveryText(a, d))); }
  }).catch(() => how.replaceChildren());
  box.append(el('p', 'msg', t('hooks.unify.peekNote')));
  const acts = el('div', 'acts');
  // 削除はその場で一度確かめる（登録だけを消す。エージェントの設定ファイルは変えない）
  const del = button(t('hooks.delete'), 'btn', () => {
    const ask = el('div', 'acts hk-ask');
    ask.append(el('span', 'cx-sub', t('hooks.unify.deleteConfirm', { name: h.name })), button(t('mcp.cancel'), 'btn', () => ask.replaceWith(acts)),
      button(t('hooks.confirm.delete'), 'btn btn-primary', () => work(async () => onChanged(await cmd('removePlyHook', { id: h.id }), true))));
    acts.replaceWith(ask);
    ask.querySelector('.btn-primary')?.focus();
  });
  acts.append(button(t('hooks.edit'), 'btn', () => openPlyHookSheet({ cmd, hook: h, onSaved: v => onChanged(v, true) })), del);
  box.append(acts);
  return box;
}

// ---------------------------------------------------------------- 追加・編集のシート（Pleiad の登録）
/** hook があれば編集。保存の前に、エージェントごとの渡し方（plyHookPreview）を確かめる */
export async function openPlyHookSheet({ cmd, hook = null, onSaved }) {
  document.querySelector('dialog.hk-sheet')?.remove();
  const dialog = el('dialog', 'mcp-sheet hk-sheet hk-ply-sheet');
  const form = el('form');
  dialog.append(form);
  dialog.addEventListener('close', () => dialog.remove());
  document.body.append(dialog);
  const heading = el('h3', null, hook ? t('hooks.unify.sheetEdit') : t('hooks.unify.sheetAdd'));
  heading.tabIndex = -1;
  dialog.setAttribute('aria-label', heading.textContent);
  let full = hook;
  if (hook) { try { full = await cmd('readPlyHook', { id: hook.id }); } catch (e) { form.append(heading, el('p', 'mcp-error', e.message), button(t('mcp.cancel'), 'btn', () => dialog.close())); dialog.showModal(); return; } }
  const scan = await cmd('scanHooks', { scope: 'user' }).catch(() => null);
  const events = scan?.events ?? {};
  const field = (text, control, ...notes) => { const box = el('div', 'mcp-field'), label = el('label', 'hk-label'); label.append(text, control); box.append(label, ...notes); return box; };
  const input = (value, placeholder, mono = false) => { const i = el('input'); i.className = `hk-input${mono ? ' mono' : ''}`; i.value = value ?? ''; i.placeholder = placeholder; i.autocomplete = 'off'; i.spellcheck = false; return i; };
  const name = input(full?.name, 'audit');
  const agent = el('select'); agent.className = 'hk-input';
  for (const [id, label] of HOOK_AGENTS) { const o = el('option', null, label); o.value = id; agent.append(o); }
  agent.value = full?.agent ?? 'claude';
  const event = el('select'); event.className = 'hk-input';
  const paintEvents = () => { const cur = event.value || full?.event || 'PreToolUse'; event.replaceChildren(); for (const e of events[agent.value] ?? []) { const o = el('option', null, `${e} — ${eventLabel(e)}`); o.value = e; event.append(o); } event.value = (events[agent.value] ?? []).includes(cur) ? cur : (events[agent.value]?.[0] ?? ''); };
  paintEvents();
  const matcher = input(full?.matcher, 'Bash', true);
  const command = input(full?.command, 'node ~/hooks/audit.mjs', true);
  const timeout = input(full?.timeout ? String(full.timeout) : '', t('hooks.sheet.timeoutDefault')); timeout.type = 'number'; timeout.min = '1';
  const asyncSelect = el('select'); asyncSelect.className = 'hk-input';
  for (const [v, text] of [['false', t('hooks.sheet.sync')], ['true', t('hooks.sheet.async')]]) { const o = el('option', null, text); o.value = v; asyncSelect.append(o); }
  asyncSelect.value = full?.async ? 'true' : 'false';
  const targets = el('fieldset', 'mcp-field hk-fieldset');
  targets.append(el('legend', null, t('hooks.unify.targets')));
  const chips = el('div', 'cx-chips');
  const boxes = HOOK_AGENTS.map(([id, label]) => { const l = el('label', 'hk-check'), c = el('input'); c.type = 'checkbox'; c.value = id; c.checked = (full?.targets ?? [agent.value]).includes(id); l.append(c, document.createTextNode(label)); chips.append(l); return c; });
  targets.append(chips, el('p', 'mcp-note', t('hooks.unify.targetsNote')));
  const overrides = {};
  const error = el('p', 'mcp-error'); error.setAttribute('role', 'alert');
  const acts = el('div', 'mcp-acts');
  const go = button(t('hooks.unify.sheetReview'), 'btn btn-primary'); go.type = 'submit';
  acts.append(button(t('mcp.cancel'), 'btn', () => dialog.close()), go);
  agent.onchange = () => paintEvents();
  const parts = [heading, el('p', 'mcp-note', t('hooks.unify.sheetLead')), field(t('hooks.sheet.name'), name), field(t('hooks.unify.formLabel'), agent, el('p', 'mcp-note', t('hooks.unify.formNote'))),
    field(t('hooks.sheet.event'), event), field('matcher', matcher, el('p', 'mcp-note', t('hooks.unify.matcherNote'))), field(t('hooks.sheet.command'), command, el('p', 'mcp-note', t('hooks.sheet.commandNote'))),
    field(t('hooks.sheet.timeout'), timeout), field('async', asyncSelect), targets, error, acts];
  form.append(...parts);
  const value = () => ({ ...(hook ? { id: hook.id } : {}), name: name.value.trim(), agent: agent.value, event: event.value, matcher: matcher.value.trim(), command: command.value.trim(),
    timeout: timeout.value.trim() ? Number(timeout.value) : null, async: asyncSelect.value === 'true', targets: boxes.filter(b => b.checked).map(b => b.value),
    matchers: Object.fromEntries(Object.entries(overrides).filter(([a, v]) => v && a !== agent.value)), enabled: hook ? hook.enabled : true });
  form.onsubmit = async ev => {
    ev.preventDefault();
    error.textContent = '';
    const v = value();
    if (!v.name) return void (error.textContent = t('hooks.unify.errorName'));
    if (!v.command) return void (error.textContent = t('hooks.error.command'));
    if (!v.targets.length) return void (error.textContent = t('hooks.error.agents'));
    await review(v);
  };
  /** 保存の前の確認: エージェントごとの渡し方。渡せない先は理由を出し、matcher を自動で訳せない先はここで入れる */
  async function review(v) {
    const box = el('div', 'hk-confirm');
    form.replaceChildren(heading, box);
    form.onsubmit = e => e.preventDefault();
    box.append(el('p', 'cx-sub', t('hooks.unify.reviewLoading')));
    let r;
    try { r = await cmd('plyHookPreview', { value: v }); } catch (e) { box.replaceChildren(el('p', 'mcp-error', e.message)); return; }
    box.replaceChildren(el('p', 'hk-q', t('hooks.unify.reviewLead')), el('p', 'cx-strong hk-warn', t('hooks.unify.reviewWarn')));
    for (const [a, label] of HOOK_AGENTS) {
      const d = r.targets[a];
      if (!d) continue;
      const card = el('div', 'hk-target');
      const head = el('div', 'row-line');
      head.append(el('b', null, label), el('span', 'hk-state', d.status === 'ok' ? t('hooks.unify.passes') : t('hooks.unify.cannot')));
      card.append(head, el('p', d.status === 'ok' ? 'cx-sub' : 'cx-strong', deliveryText(a, d)));
      if (d.status === 'ok' && d.matcher !== undefined && d.matcher !== null && TOOL_EVENTS.has(d.event)) card.append(el('p', 'cx-sub', t('hooks.row.matcher', { matcher: d.matcher || '*' })));
      if (d.reasons?.some(x => /^matcher/.test(x.code) || x.code === 'partialTools')) {
        const i = input(overrides[a] ?? '', a === 'antigravity' ? 'run_command' : 'Bash', true);
        const again = button(t('hooks.copy.recheck'), 'btn', () => { overrides[a] = i.value.trim(); review(value()); });
        const line = el('div', 'hk-redo'); const l = el('label', 'hk-label'); l.append(t('hooks.copy.matcher', { agent: label }), i); line.append(l, again);
        card.append(line);
      }
      // i18n-dynamic: hooks.copy.warn.
      for (const w of d.warnings ?? []) card.append(el('p', 'mcp-note', t(`hooks.copy.warn.${w.code}`, w.params ?? {})));
      box.append(card);
    }
    const ackLabel = el('label', 'hk-check'), ack = el('input'); ack.type = 'checkbox';
    ackLabel.append(ack, document.createTextNode(t('hooks.confirm.ack')));
    const status = el('p', 'mcp-error'); status.setAttribute('role', 'alert');
    const save = button(t('hooks.unify.save'), 'btn btn-primary');
    save.disabled = true;
    ack.onchange = () => { save.disabled = !ack.checked; };
    save.onclick = async () => {
      save.disabled = true;
      try { const view = await cmd('savePlyHook', { value: v }); dialog.close(); onSaved?.(view); }
      catch (e) { status.textContent = e.message; save.disabled = false; }
    };
    const a = el('div', 'mcp-acts');
    a.append(button(t('hooks.confirm.back'), 'btn', () => { form.replaceChildren(...parts); form.onsubmit = formSubmit; heading.focus(); }), button(t('mcp.cancel'), 'btn', () => dialog.close()), save);
    box.append(ackLabel, status, a);
    heading.focus();
  }
  const formSubmit = form.onsubmit;
  dialog.showModal();
  heading.focus();
}

// ---------------------------------------------------------------- 会話の右パネル（担当が Pleiad の会話）
/**
 * unify: 会話の記録（contextSession.hooks）。渡した・止めた・動き続ける・渡せなかった・漏れ。推定で「実行済み」にしない（発火は別の面）
 */
export function unifySessionBox(unify, { kindBox, short = p => p }) {
  const k = kindBox('Hooks', t('hooks.unify.who'), true);
  if (unify.unsupportedAgent) { k.append(el('p', 'cx-sub', t('hooks.unify.session.unsupportedAgent'))); return k; }
  k.append(el('p', 'cx-sub', t('hooks.unify.session.lead', { time: new Date(unify.at).toLocaleString() })));
  if (unify.leaks?.length) {
    const n = el('div', 'scx-notice');
    n.append(el('p', 'cx-strong', t('hooks.unify.session.leakTitle', { n: unify.leaks.length })), el('p', 'cx-sub', unify.leaks.map(l => `${l.event} · ${l.name}${l.source ? ` (${l.source})` : ''}`).join(' / ')));
    k.append(n);
  }
  if (unify.untrusted) k.append(el('p', 'cx-strong', t('hooks.unify.session.untrusted', { n: unify.untrusted })));
  const group = (title, rows, make, empty) => {
    k.append(el('p', 'scx-grp', t('hooks.unify.section', { title, n: rows.length })));
    if (!rows.length) { k.append(el('p', 'cx-sub', empty)); return; }
    for (const r of rows) k.append(make(r));
  };
  const item = (name, sub, mark = '·', on = false) => {
    const row = el('div', 'scx-item');
    const m = el('span', 'mark' + (on ? ' on' : ''), mark); m.setAttribute('aria-hidden', 'true');
    const body = el('div', 't');
    body.append(el('div', 'nm', name));
    if (sub) body.append(el('div', 'p', sub));
    row.append(m, body);
    return row;
  };
  // i18n-dynamic: hooks.unify.session.via.
  group(t('hooks.unify.session.supplied'), unify.supplied ?? [], s => item(s.name, [`${eventLabel(s.event)} · ${s.event}`, s.matcher ? t('hooks.row.matcher', { matcher: s.matcher }) : null,
    t(`hooks.unify.session.via.${s.via}`), s.from !== unify.agent ? t('hooks.unify.form', { agent: agentLabel(s.from) }) : null, s.adapter ? t('hooks.unify.session.viaAdapter') : null].filter(Boolean).join(' · '), '●', true), t('hooks.unify.session.noneSupplied'));
  // 出どころ。Codex の行は hooks/list の source（user・project・plugin・その他は管理者）
  const origin = s => s.plugin ? t('hooks.unify.pluginName', { name: s.plugin }) : t(`hooks.scope.${s.scope ?? (['user', 'project', 'plugin'].includes(s.source) ? s.source : 'managed')}`);
  group(t('hooks.unify.session.stopped'), unify.stopped ?? [], s => item(rowTitle(s), [origin(s),
    s.event ? `${eventLabel(s.event)} · ${s.event}` : null, s.unverified ? t('hooks.unify.skillUnverified') : null].filter(Boolean).join(' · '), '−'), t('hooks.unify.session.noneStopped'));
  if (unify.kept?.length) group(t('hooks.unify.session.kept'), unify.kept, s => item(rowTitle(s), [origin(s), s.event].filter(Boolean).join(' · ')), '');
  group(t('hooks.unify.session.unsupported'), unify.unsupported ?? [], s => item(s.name, `${s.event} · ${s.reasons.map(reasonText).join(' ')}`, '×'), t('hooks.unify.session.noneUnsupported'));
  if (unify.skipped?.length) k.append(el('p', 'cx-sub', t('hooks.unify.session.skipped', { names: unify.skipped.map(s => s.name).join(', ') })));
  k.append(el('p', 'cx-sub', t('hooks.unify.session.foot')));
  return k;
}
