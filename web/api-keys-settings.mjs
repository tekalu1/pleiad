// 設定 › API キー（承認済み 2026-10-07。docs/design-system.md「設定 › API キー」、ADR 0155）。
//
// 外部サービスのキーを 1 か所に登録する。接続先・通話・委譲の判定器は「どのキーを使うか」を選ぶだけ（各画面の「使うキー」）。
// 登録しただけでは、どこにも送らない。カードに名前・登録済みと確認の結果・使っている所（各設定へのリンク）・［差し替える］［確かめる］［削除］。
// 差し替えると、使っている所を順に確かめ直して ✓ / ⚠ で並べる（接続先の確認は短い応答を 1 回生成するので、わずかに料金がかかる）。
// 削除は使っている所と、削除後に起きることを並べて聞き直す。値の違う同じプロバイダーのキーが移行で見つかったときだけ、先頭に案内の節を一度だけ出す。
// キーの値は画面に持たない（入力欄に打ったものを送って捨てる。ホストも返さない）。
// 状態はホストが持つ（invoke の apiKeys.list と、変わるたびに届く apiKeysChanged）。面と部品は設定の管理の面（web/manage-panel.css の .mp-*・.nf-*）。
import { el } from './dom.mjs';
import { t } from './i18n.mjs';
import { providerName } from './api-keys-model.mjs';
import { apiKeyList, keyName, statusLine, spinner, keyInput, keepFocus } from './api-key-ui.mjs';

const AGENT_NAME = { claude: 'Claude Code', codex: 'Codex' };
const JUDGE_NAME = { jev: 'Jev / Qwen' };
/** 使っている所が多いカードは先頭 3 件と［ほか N か所］に畳む（4 件までは全部出す） */
const FOLD_AT = 4;
const FOLD_SHOWN = 3;
const SETTLE_MS = 240;
const PROVIDER_CHOICES = ['openrouter', 'custom'];

const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const wait = ms => new Promise(r => setTimeout(r, reduced() ? 0 : ms));
let counter = 0;
const uid = prefix => `${prefix}${++counter}`;

/**
 * @param {object} o
 * @param {(command: string, args?: object) => Promise<any>} o.cmd  WS コマンド
 * @param {(page: string) => void} o.page  設定のページを切り替える（onboarding.page）
 * @param {(agent: string) => void} [o.openEndpoints]  設定 › エージェント設定の接続先の面を開く
 */
export function setupApiKeysSettings({ cmd, page, openEndpoints = () => {} }) {
  const $ = id => document.getElementById(id);
  const root = $('apiKeysPanel');
  const tab = $('apiKeysTab');
  if (!root || !tab) return { event() {}, load() {} };
  const invoke = (op, args = {}) => cmd('invoke', { op, args });

  let data = null, loadError = '';
  const ui = { adding: null, replacing: '', deleting: '', result: null, merge: null, expanded: new Set(), checking: new Set(), message: '', shown: new Set(), focus: null };
  let pending = [];

  const find = id => data?.keys.find(k => k.id === id) ?? null;
  const say = text => { ui.message = text; };
  const fail = e => { say(t('apiKeys.failed', { error: e?.message ?? String(e) })); };

  async function load() {
    try { data = await apiKeyList(cmd); loadError = ''; }
    catch (e) { loadError = e?.message ?? String(e); }
    paint();
  }

  // ---- 開閉（高さと不透明度。240ms · ease-out。prefers-reduced-motion では 0）
  function region(key, child, seen) {
    seen.add(key);
    const instant = ui.shown.has(key);
    ui.shown.add(key);
    const inner = el('div', 'ak-fold-in'); inner.append(child);
    const box = el('div', 'ak-fold' + (instant ? ' open' : '')); box.dataset.region = key; box.append(inner);
    if (!instant) pending.push(box);
    return box;
  }
  async function collapse(key) {
    const box = root.querySelector(`[data-region="${CSS.escape(key)}"]`);
    if (box) { box.classList.remove('open'); await wait(SETTLE_MS); }
    ui.shown.delete(key);
  }

  const button = (label, onclick, cls = 'btn', attrs = {}) => {
    const b = el('button', cls, label); b.type = 'button'; b.onclick = onclick;
    for (const [k, v] of Object.entries(attrs)) if (v != null) b.setAttribute(k, v);
    return b;
  };
  const link = (label, onclick, attrs = {}) => button(label, onclick, 'ak-link', attrs);

  // ---- 使っている所
  function useLabel(u) {
    if (u.kind === 'endpoint') return t('apiKeys.uses.endpoint', { agent: AGENT_NAME[u.agent] ?? u.agent, name: u.name });
    if (u.kind === 'voice') return t('apiKeys.uses.voice');
    if (u.kind === 'computer') return t('apiKeys.uses.computer');
    return t('apiKeys.uses.judge', { judge: JUDGE_NAME[u.judge] ?? u.judge });
  }
  // i18n-dynamic: apiKeys.effect.
  const useEffect = u => t(`apiKeys.effect.${['endpoint', 'voice', 'computer'].includes(u.kind) ? u.kind : 'judge'}`);
  const navOf = u => (u.kind === 'voice' ? 'voice' : u.kind === 'judge' ? 'delegation' : u.kind === 'computer' ? 'computer' : 'agents');
  function openUse(u) {
    if (u.kind === 'endpoint') { openEndpoints(u.agent); return; }
    $(u.kind === 'voice' ? 'voiceTab' : u.kind === 'computer' ? 'computerTab' : 'delegationTab')?.click();
  }

  function usesBlock(k) {
    const uses = k.uses;
    if (!uses.length) return el('div', 'ak-uses ak-none', t('apiKeys.uses.none'));
    const fold = uses.length >= FOLD_AT + 1;
    const open = ui.expanded.has(k.id);
    const list = fold && !open ? uses.slice(0, FOLD_SHOWN) : uses;
    const ul = el('ul'); ul.setAttribute('aria-label', t('apiKeys.uses.aria', { name: keyName(k) }));
    list.forEach((u, i) => {
      const li = el('li');
      // i18n-dynamic: settings.nav.
      li.append(link(useLabel(u), () => openUse(u), { 'data-fk': `use:${k.id}:${i}`, title: t('apiKeys.uses.open', { page: t(`settings.nav.${navOf(u)}`) }) }));
      ul.append(li);
    });
    if (fold) {
      const li = el('li');
      li.append(link(open ? t('apiKeys.uses.less') : t('apiKeys.uses.more', { count: uses.length - FOLD_SHOWN }), () => {
        if (open) ui.expanded.delete(k.id); else ui.expanded.add(k.id);
        ui.focus = open ? `more:${k.id}` : `use:${k.id}:${FOLD_SHOWN}`; paint();
      }, { 'data-fk': `more:${k.id}`, 'aria-expanded': String(open) }));
      ul.append(li);
    }
    const wrap = el('div', 'ak-uses'); wrap.append(el('span', 'ak-uses-l', t('apiKeys.uses.label')), ul);
    return wrap;
  }

  // ---- 確かめ直した結果（差し替え・まとめた後。使っている所を順に）
  const summaryOf = rows => {
    const ng = rows.filter(r => r.state === 'ng').length;
    if (!rows.length) return t('apiKeys.result.noUses');
    return ng ? t('apiKeys.result.partial', { total: rows.length, ok: rows.length - ng, ng }) : t('apiKeys.result.all', { total: rows.length });
  };
  async function runChecks(keyId, title) {
    const k = find(keyId);
    ui.result = { keyId, title, done: false, rows: [], summary: '' };
    ui.message = '';
    paint();
    let keyCheck = null;
    for (const u of k?.uses ?? []) {
      const row = { u, state: 'run', text: t('apiKeys.result.checking'), shown: false };
      ui.result.rows.push(row); paint();
      try {
        if (u.kind === 'endpoint') {
          const r = await invoke('compatEndpoints.recheck', { id: u.id });
          Object.assign(row, r.ok ? { state: 'ok', text: t('apiKeys.result.endpointOk', { count: r.models?.length ?? 0 }) } : { state: 'ng', text: t('apiKeys.result.endpointFailed', { error: r.error ?? '' }) });
        } else {
          keyCheck ??= await invoke('apiKeys.check', { id: keyId });
          Object.assign(row, keyCheck.ok === false ? { state: 'ng', text: t('apiKeys.result.keyFailed') } : { state: 'ok', text: t('apiKeys.result.keyOk') });
        }
      } catch (e) { Object.assign(row, { state: 'ng', text: t('apiKeys.result.error', { error: e?.message ?? String(e) }) }); }
      paint();
    }
    ui.result.done = true;
    ui.result.summary = summaryOf(ui.result.rows);
    // 終わったときに 1 回だけ読み上げる（途中の行は読み上げない）
    say(`${title}。${ui.result.summary}`);
    await load();
  }
  function rowEl(row) {
    const mark = el('span', 'ak-mark');
    if (row.state === 'run') mark.append(spinner()); else { mark.textContent = row.state === 'ok' ? '✓' : '⚠'; mark.setAttribute('aria-hidden', 'true'); }
    const text = el('span', 't' + (row.state === 'run' ? ' weak' : '')); text.append(el('b', null, useLabel(row.u)), ` — ${row.text}`);
    const li = el('li', row.shown ? '' : 'enter'); li.append(mark, text);
    if (row.state === 'ng') li.append(link(row.u.kind === 'endpoint' ? t('apiKeys.result.openEndpoint') : t('apiKeys.result.openSettings'), () => openUse(row.u)));
    row.shown = true;
    return li;
  }
  function resultBlock(k) {
    const r = ui.result;
    const box = el('div', 'mp-result ak-result'); box.setAttribute('role', 'group'); box.setAttribute('aria-label', t('apiKeys.result.aria'));
    box.append(el('strong', null, `✓ ${r.title}`), el('span', 'mp-ln', r.done ? r.summary : t('apiKeys.result.running')));
    if (r.rows.length) { const ul = el('ul', 'ak-rows'); ul.append(...r.rows.map(rowEl)); box.append(ul); }
    if (r.done) {
      const actions = el('div', 'mp-card-actions'); actions.style.marginTop = '8px';
      actions.append(button(t('apiKeys.result.close'), async () => { await collapse('res:' + k.id); ui.result = null; ui.focus = 'rep:' + k.id; paint(); }, 'btn', { 'data-fk': 'resx:' + k.id }));
      box.append(actions);
    }
    return box;
  }

  // ---- 差し替え・確かめる・削除
  function replaceForm(k) {
    const { row, input } = keyInput({ ariaLabel: t('apiKeys.replace.input', { name: keyName(k) }), placeholder: k.provider === 'openrouter' ? 'sk-or-…' : '', focusKey: 'repin:' + k.id });
    const form = el('form', 'rt-key-form ak-form'); form.setAttribute('aria-label', t('apiKeys.replace.aria', { name: keyName(k) }));
    form.append(row);
    if (k.uses.some(u => u.kind === 'endpoint')) form.append(el('small', 'ak-cost', t('apiKeys.replace.cost')));
    const actions = el('div', 'mp-card-actions');
    const submit = el('button', 'btn btn-primary', t('apiKeys.replace.submit')); submit.type = 'submit';
    actions.append(button(t('apiKeys.cancel'), () => closeReplace(k)), submit);
    form.append(actions);
    form.onsubmit = async e => {
      e.preventDefault();
      const value = input.value.trim(); input.value = '';
      if (!value) return;
      try {
        await cmd('setApiKey', { id: k.id, key: value });
        await collapse('rep:' + k.id);
        ui.replacing = ''; ui.focus = 'rep:' + k.id;
        await load();
        await runChecks(k.id, t('apiKeys.replace.done', { name: keyName(k) }));
      } catch (err) { fail(err); paint(); }
    };
    form.onkeydown = e => { if (e.key === 'Escape') { e.stopPropagation(); closeReplace(k); } };
    return form;
  }
  async function closeReplace(k) { await collapse('rep:' + k.id); ui.replacing = ''; ui.focus = 'rep:' + k.id; paint(); }

  async function check(k) {
    if (ui.checking.has(k.id)) return;
    ui.checking.add(k.id); ui.focus = 'chk:' + k.id; say(''); paint();
    try {
      const r = await invoke('apiKeys.check', { id: k.id });
      await load();
      const now = find(k.id) ?? k;
      say(r.ok === false ? t('apiKeys.check.failed', { name: keyName(now) }) : t('apiKeys.check.ok', { name: keyName(now) }));
    } catch (e) { fail(e); }
    ui.checking.delete(k.id); ui.focus = 'chk:' + k.id;
    paint();
  }

  function confirmBlock(k) {
    const body = el('div', 'ak-confirm-body');
    if (k.uses.length) {
      const ul = el('ul', 'ak-effects');
      for (const u of k.uses) { const li = el('li'); li.append(el('b', null, useLabel(u)), ` — ${useEffect(u)}`); ul.append(li); }
      body.append(el('p', null, t('apiKeys.delete.withUses', { name: keyName(k) })), ul);
    } else body.append(el('p', null, t('apiKeys.delete.noUses', { name: keyName(k) })));
    const box = el('div', 'mp-confirm ak-confirm'); box.setAttribute('role', 'group'); box.setAttribute('aria-label', t('apiKeys.delete.aria', { name: keyName(k) }));
    const actions = el('div', 'mp-card-actions');
    actions.append(button(t('apiKeys.cancel'), () => closeDelete(k), 'btn', { 'data-fk': 'delno:' + k.id }), button(t('apiKeys.delete.yes'), () => doDelete(k), 'btn', { 'data-fk': 'delyes:' + k.id }));
    box.append(body, actions);
    box.onkeydown = e => { if (e.key === 'Escape') { e.stopPropagation(); closeDelete(k); } };
    return box;
  }
  async function closeDelete(k) { await collapse('del:' + k.id); ui.deleting = ''; ui.focus = 'del:' + k.id; paint(); }
  async function doDelete(k) {
    const uses = [...k.uses];
    const card = root.querySelector(`[data-id="${k.id}"]`);
    try {
      await cmd('deleteApiKey', { id: k.id });
      if (card && !reduced()) {
        // カードは高さ・不透明度・余白を 240ms · ease-out で畳んで消す
        card.style.height = card.offsetHeight + 'px'; card.style.overflow = 'hidden';
        card.style.transition = `height ${SETTLE_MS}ms var(--ease-out),opacity ${SETTLE_MS}ms var(--ease-out),margin ${SETTLE_MS}ms var(--ease-out),padding ${SETTLE_MS}ms var(--ease-out)`;
        void card.offsetHeight;
        Object.assign(card.style, { height: '0px', opacity: '0', marginTop: '0px', marginBottom: '0px', paddingTop: '0px', paddingBottom: '0px' });
        await wait(SETTLE_MS + 20);
      }
      ui.deleting = ''; if (ui.result?.keyId === k.id) ui.result = null;
      const uses2 = uses.map(useLabel).join(t('apiKeys.listSeparator'));
      say(uses.length ? t('apiKeys.delete.doneWithUses', { name: keyName(k), uses: uses2 }) : t('apiKeys.delete.done', { name: keyName(k) }));
      ui.focus = 'add';
      await load();
    } catch (e) { fail(e); paint(); }
  }

  // ---- 追加
  const providerTaken = p => p !== 'custom' && data.keys.some(k => k.provider === p);
  const firstFree = () => PROVIDER_CHOICES.find(p => !providerTaken(p)) ?? 'custom';
  function addBlock(forced) {
    const a = ui.adding;
    const form = el('form', 'mp-card ak-add'); form.setAttribute('aria-label', t('apiKeys.add.title'));
    form.append(el('strong', null, t('apiKeys.add.title')));
    const grid = el('div', 'mp-presets'); grid.setAttribute('role', 'group'); grid.setAttribute('aria-label', t('apiKeys.add.provider'));
    for (const p of PROVIDER_CHOICES) {
      const taken = providerTaken(p);
      const b = el('button', 'mp-preset'); b.type = 'button'; b.setAttribute('aria-pressed', String(a.provider === p)); b.disabled = taken;
      // i18n-dynamic: apiKeys.add.providers.
      b.append(el('span', null, t(`apiKeys.add.providers.${p}.name`)), el('small', null, taken ? t('apiKeys.add.taken') : t(`apiKeys.add.providers.${p}.hint`)));
      b.onclick = () => { a.provider = p; ui.focus = 'addin'; paint(); };
      grid.append(b);
    }
    form.append(grid);
    if (a.provider === 'custom') {
      const label = el('label', 'mp-field'); label.append(el('span', null, t('apiKeys.add.name')));
      const name = el('input'); name.type = 'text'; name.autocomplete = 'off'; name.placeholder = t('apiKeys.add.namePlaceholder'); name.maxLength = 60; name.value = a.name;
      name.setAttribute('aria-label', t('apiKeys.add.nameAria')); name.oninput = () => { a.name = name.value; };
      label.append(name); form.append(label);
    }
    const { row, input } = keyInput({ ariaLabel: a.provider === 'custom' ? t('apiKeys.add.keyAriaCustom') : t('apiKeys.add.keyAria', { provider: providerName(a.provider) }),
      placeholder: a.provider === 'openrouter' ? 'sk-or-…' : '', focusKey: 'addin' });
    const field = el('div', 'mp-field'); field.append(el('span', null, t('apiKeys.add.key')), row); form.append(field);
    const actions = el('div', 'mp-actions'); actions.style.marginTop = '12px';
    if (!forced) actions.append(button(t('apiKeys.cancel'), closeAdd));
    const submit = el('button', 'btn btn-primary', t('apiKeys.register.submit')); submit.type = 'submit'; actions.append(submit);
    form.append(actions);
    form.onsubmit = async e => { e.preventDefault(); const value = input.value.trim(); input.value = ''; if (value) await register(a, value); };
    form.onkeydown = e => { if (e.key === 'Escape' && !forced) { e.stopPropagation(); closeAdd(); } };
    return form;
  }
  async function closeAdd() { await collapse('add'); ui.adding = null; ui.focus = 'add'; paint(); }
  async function register(a, value) {
    let id = null;
    try {
      ({ id } = await cmd('setApiKey', { provider: a.provider, label: a.provider === 'custom' ? a.name.trim() : '', key: value }));
      if (data.keys.length) await collapse('add');
      ui.adding = null;
      ui.checking.add(id); ui.focus = 'chk:' + id;
      await load();
      const k = find(id);
      say(t('apiKeys.add.registered', { name: k ? keyName(k) : '' }));
      paint();
      root.querySelector(`[data-id="${id}"]`)?.scrollIntoView({ block: 'nearest', behavior: reduced() ? 'auto' : 'smooth' });
      // 確かめ方のあるプロバイダーは、登録の直後に確かめる（接続先の確認と違い、料金はかからない）
      if (k?.checkable) {
        try { await invoke('apiKeys.check', { id }); } catch { /* 確かめられなくても登録はできている */ }
        ui.checking.delete(id);
        await load();
        const done = find(id);
        if (done) say(done.lastCheck?.ok === false ? t('apiKeys.add.registeredFailed', { name: keyName(done) }) : t('apiKeys.add.registeredChecked', { name: keyName(done) }));
      }
    } catch (e) { fail(e); }
    if (id) ui.checking.delete(id);
    paint();
  }

  // ---- 移行の案内（節。値の違う同じプロバイダーのキーが見つかったときだけ、一度だけ）
  function guideBlock(g) {
    const name = providerName(g.provider) || g.provider;
    const keys = g.keyIds.map(find).filter(Boolean);
    const id = uid('akg');
    const sec = el('section', 'nf-section ak-guide'); sec.setAttribute('aria-labelledby', id);
    const h = el('h4', null, t('apiKeys.guide.title', { name, count: keys.length })); h.id = id;
    sec.append(h);
    const card = el('div', 'nf-card');
    card.append(el('p', null, t('apiKeys.guide.body', { name })));
    if (!ui.merge) {
      const actions = el('div', 'mp-card-actions');
      actions.append(
        button(t('apiKeys.guide.merge'), () => { ui.merge = { pick: null }; ui.focus = 'pick:' + keys[0].id; paint(); }, 'btn btn-primary', { 'data-fk': 'gmerge' }),
        button(t('apiKeys.guide.keep'), async () => {
          try { await cmd('resolveApiKeyGuide', { keep: null }); await collapse('guide'); say(t('apiKeys.guide.kept')); ui.focus = 'add'; await load(); } catch (e) { fail(e); paint(); }
        }, 'btn', { 'data-fk': 'gkeep' }));
      card.append(actions);
    } else {
      const fs = el('fieldset', 'mp-field'); fs.append(el('legend', null, t('apiKeys.guide.pick')));
      for (const k of keys) {
        const rid = uid('pk');
        const radio = el('div', 'ak-radio');
        const input = el('input'); input.type = 'radio'; input.id = rid; input.name = 'ak-keep'; input.checked = ui.merge.pick === k.id; input.dataset.fk = 'pick:' + k.id;
        input.onchange = () => { ui.merge.pick = k.id; ui.focus = 'pick:' + k.id; paint(); };
        const text = el('span', 't'); const label = el('label'); label.htmlFor = rid; label.append(el('b', null, keyName(k)));
        text.append(label, el('small', null, k.uses.length ? t('apiKeys.guide.usedBy', { uses: k.uses.map(useLabel).join(' · ') }) : t('apiKeys.uses.none')));
        radio.append(input, text); fs.append(radio);
      }
      const go = el('button', 'btn btn-primary', t('apiKeys.guide.mergeGo')); go.type = 'button'; go.disabled = !ui.merge.pick; go.onclick = () => doMerge();
      const actions = el('div', 'mp-card-actions'); actions.style.marginTop = '10px';
      actions.append(button(t('apiKeys.cancel'), () => { ui.merge = null; ui.focus = 'gmerge'; paint(); }), go);
      card.append(fs, el('p', 'mp-note', t('apiKeys.guide.note')), actions);
    }
    sec.append(card);
    return sec;
  }
  async function doMerge() {
    const keep = ui.merge?.pick;
    if (!keep) return;
    try {
      await cmd('resolveApiKeyGuide', { keep });
      await collapse('guide');
      ui.merge = null; ui.focus = 'rep:' + keep;
      await load();
      const k = find(keep);
      await runChecks(keep, t('apiKeys.guide.merged', { name: k ? keyName(k) : '' }));
    } catch (e) { fail(e); paint(); }
  }

  // ---- カード
  function card(k, seen) {
    const nid = uid('akn');
    const busy = ui.replacing === k.id || ui.deleting === k.id;
    const li = el('li', 'mp-card ak-card'); li.setAttribute('role', 'group'); li.setAttribute('aria-labelledby', nid); li.dataset.id = k.id;
    const info = el('div', 'mp-card-info'); const name = el('strong', null, keyName(k)); name.id = nid;
    info.append(name);
    if (ui.checking.has(k.id)) { const s = el('small', 'ak-status'); s.append(spinner(), ` ${t('apiKeys.checking')}`); info.append(s); }
    else info.append(statusLine(k, 'ak-status'));
    const actions = el('div', 'mp-card-actions'); actions.hidden = busy;
    actions.append(
      button(t('apiKeys.actions.replace'), () => { ui.replacing = k.id; ui.deleting = ''; ui.result = null; ui.focus = 'repin:' + k.id; paint(); }, 'btn',
        { 'data-fk': 'rep:' + k.id, 'aria-label': t('apiKeys.actions.replaceAria', { name: keyName(k) }), 'aria-expanded': String(ui.replacing === k.id) }));
    if (k.checkable) actions.append(button(t('apiKeys.actions.check'), () => check(k), 'btn',
      { 'data-fk': 'chk:' + k.id, 'aria-label': t('apiKeys.actions.checkAria', { name: keyName(k) }), 'aria-disabled': ui.checking.has(k.id) ? 'true' : null }));
    actions.append(button(t('apiKeys.actions.delete'), () => { ui.deleting = k.id; ui.replacing = ''; ui.result = null; ui.focus = 'delno:' + k.id; paint(); }, 'btn',
      { 'data-fk': 'del:' + k.id, 'aria-label': t('apiKeys.actions.deleteAria', { name: keyName(k) }), 'aria-expanded': String(ui.deleting === k.id) }));
    const head = el('div', 'mp-row'); head.append(info, actions);
    li.append(head, usesBlock(k));
    if (ui.replacing === k.id) li.append(region('rep:' + k.id, replaceForm(k), seen));
    if (ui.deleting === k.id) li.append(region('del:' + k.id, confirmBlock(k), seen));
    if (ui.result?.keyId === k.id) li.append(region('res:' + k.id, resultBlock(k), seen));
    return li;
  }

  const lead = () => el('p', 'ak-lead', t('apiKeys.lead'));

  function paint() {
    const restore = keepFocus(root, ui.focus);
    ui.focus = null;
    pending = [];
    const seen = new Set();
    const out = [];
    if (!data) {
      out.push(lead());
      if (loadError) out.push(el('p', 'mp-state mp-warn', t('apiKeys.loadFailed', { error: loadError })));
      root.replaceChildren(...out);
      return;
    }
    out.push(lead());
    if (data.migration?.state === 'deferred') {
      // 古い置き場の暗号化されたキーを、この起動では読めない。移行を保留して、古い置き場のまま使う（編集は出さない）
      const panel = el('div', 'mp-panel ak-panel');
      // i18n-dynamic: apiKeys.deferred.
      panel.append(el('h3', null, t('apiKeys.deferred.title')), el('p', 'mp-warn', t(`apiKeys.deferred.${data.migration.reason === 'locked' ? 'locked' : 'other'}`)));
      out.push(panel);
      root.replaceChildren(...out);
      restore();
      return;
    }
    const panel = el('div', 'mp-panel ak-panel');
    const keys = data.keys;
    const forced = !keys.length;
    if (forced && !ui.adding) ui.adding = { provider: firstFree(), name: '' };
    const g = data.guide;
    if (g && g.keyIds.map(find).filter(Boolean).length > 1) panel.append(region('guide', guideBlock(g), seen));
    const head = el('div', 'mp-row ak-head');
    const title = el('h3'); title.append(forced ? t('apiKeys.empty') : t('apiKeys.heading'));
    if (!forced) title.append(el('span', 'ak-count', String(keys.length)));
    head.append(title);
    if (!forced) head.append(button(ui.adding ? t('apiKeys.cancel') : t('apiKeys.add.open'), () => (ui.adding ? closeAdd() : (ui.adding = { provider: firstFree(), name: '' }, ui.focus = 'addin', paint())), 'btn mp-link', { 'data-fk': 'add', 'aria-expanded': String(Boolean(ui.adding)) }));
    panel.append(head);
    if (ui.adding) panel.append(region('add', addBlock(forced), seen));
    const used = keys.filter(k => k.uses.length), unused = keys.filter(k => !k.uses.length);
    const listOf = (arr, label) => { const ul = el('ul', 'ak-list'); ul.setAttribute('aria-label', label); ul.append(...arr.map(k => card(k, seen))); return ul; };
    if (used.length && unused.length) panel.append(listOf(used, t('apiKeys.list.used')), el('div', 'ak-sub', t('apiKeys.list.unusedHeading')), listOf(unused, t('apiKeys.list.unused')));
    else if (keys.length) panel.append(listOf(keys, t('apiKeys.list.all')));
    const state = el('p', 'mp-state' + (ui.result?.done ? ' visually-hidden' : '')); state.setAttribute('role', 'status'); state.textContent = ui.message;
    panel.append(state);
    panel.append(data.storage?.encrypted === false ? el('p', 'mp-note mp-warn', `⚠ ${t('apiKeys.notEncrypted')}`) : el('p', 'mp-note', t('apiKeys.encryptedNote')));
    out.push(panel);
    root.replaceChildren(...out);
    pending.forEach(box => { void box.offsetHeight; box.classList.add('open'); });
    for (const key of [...ui.shown]) if (!seen.has(key)) ui.shown.delete(key);
    restore();
  }

  tab.onclick = () => { page('apiKeys'); load(); };
  return {
    /** apiKeysChanged が届いたとき。開いているときだけ取り直す */
    event(ev) { if (!root.hidden && ev?.type === 'apiKeysChanged') load(); },
    load,
  };
}
