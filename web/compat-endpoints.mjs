// 互換の接続先の設定（設定 › エージェント設定 › Claude Code / Codex の「接続先」。モック docs/mockups/compat-endpoints.html の画面 2・3）。
//
// 一覧（公式の行＋登録した互換の接続先。既定にする・接続を確認・編集・削除）と、追加・編集の 5 段の流れ
//   ① 種類（プリセット）→ ② 接続情報 → ③ 接続を確認 → ④ モデル → ⑤ 保存
// 確認が通るまで保存は出さない（サーバーの受領証。URL・キー・認証を変えたら確認し直し。モデルの欄は変えても確認し直さない）。
// キーは伏せ字で受け、保存後は表示しない（サーバーも返さない。hasKey だけ）。
// 説明文は最小限（docs/design-system.md「説明文」）。見出し・ラベル・状態で伝わることは書かず、事故になることと失敗の理由だけを短く。
// 面と部品は Claude のアカウントの設定（web/claude-accounts.mjs）と同じ .mp-*（web/manage-panel.css）。
// 入力欄のモデルの面（web/composer-controls.mjs）は list() の値を読むだけ。
import { el } from './dom.mjs';
import { t, fmt } from './i18n.mjs';
import { createCombo } from './combo.mjs';
import { compatModelLabel, modelCandidates, comboModelOptions, ONE_M_TITLE, SHOW_LIMIT } from './compat-models.mjs';
import { PRESETS, CLAUDE_ROLES, CONTEXT_CANDIDATES, AUTH_LABEL, presetOf, urlCandidates, urlHelp } from './compat-presets.mjs';

const AGENT_NAME = { claude: 'Claude Code', codex: 'Codex' };
const STEPS = [t('compat.step.kind'), t('compat.step.connection'), t('compat.step.check'), t('compat.step.model'), t('compat.step.save')];

// 月/日 時:分（ja は「9/23 14:05」）
const when = (iso) => fmt.dateTime(iso, { month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' });

export function setupCompatEndpoints({ cmd, openSettings, onChange = () => {}, officialLine = () => '' }) {
  const $ = id => document.getElementById(id);
  const panel = document.createElement('section');
  panel.className = 'mp-panel'; panel.id = 'compatEndpointsPanel'; panel.hidden = true;
  panel.setAttribute('aria-labelledby', 'epTitle');
  $('agentControls').append(panel);

  let endpoints = [], defaults = { claude: '', codex: '' }, storage = null, loaded = null;
  let agent = 'claude', view = 'list', confirming = '', checking = '', message = '';
  /** 追加・編集の途中の値。{ id, preset, name, baseUrl, authMode, key, show, phase, result, roles, context, sendThinking, saved, stale } */
  let form = null;

  async function load(force = false) {
    if (!loaded || force) loaded = cmd('compatEndpoints').then(r => { endpoints = r.endpoints ?? []; defaults = r.defaults ?? defaults; storage = r.storage ?? null; return endpoints; })
      .catch(e => { loaded = null; throw e; });
    return loaded;
  }
  const button = (text, onclick, className = 'btn') => { const b = el('button', className, text); b.type = 'button'; b.onclick = onclick; return b; };
  const line = (text, cls = 'mp-ln') => el('span', cls, text);
  const labelled = (label, ...text) => { const s = el('span', 'mp-ln'); s.append(el('b', null, label), ...text.flat()); return s; };

  /** モデル ID の表示（web/compat-models.mjs の表示名＋「1M」の札。送る ID は title） */
  function modelNode(id) {
    if (!id) return document.createTextNode(t('compat.notSet'));
    const { text, oneM } = compatModelLabel(id);
    const s = el('span', 'mp-model', text); s.title = id;
    if (oneM) { const b = el('span', 'cbadge', '1M'); b.title = ONE_M_TITLE; s.append(b); }
    return s;
  }
  function checkLine(e) {
    if (checking === e.id) return line(t('compat.checking'));
    const c = e.lastCheck;
    if (!c) return line(t('compat.check.never'));
    if (c.ok) return line(t('compat.check.ok', { when: when(c.at) }));
    return line(t('compat.check.failed', { error: c.error, when: when(c.at) }), 'mp-ln mp-warn');
  }

  // ---------------------------------------------------------------- 一覧（画面 2）
  function drawList() {
    const claude = agent === 'claude';
    const out = [];
    const head = el('div', 'mp-row');
    head.append(el('h3', null, t('compat.list.title', { agent: AGENT_NAME[agent] })), button(t('compat.action.close'), close));
    head.firstChild.id = 'epTitle';
    out.push(head);
    // 公式
    const official = el('div', 'mp-card'); const orow = el('div', 'mp-row'); const oinfo = el('div', 'mp-card-info');
    oinfo.append(el('strong', null, t('compat.list.official') + (!defaults[agent] ? ' · ' + t('compat.list.isDefault') : '')),
      line(`${claude ? 'Anthropic' : 'OpenAI'}${officialLine(agent) ? ' · ' + officialLine(agent) : ''}`));
    const oact = el('div', 'mp-card-actions');
    if (defaults[agent]) oact.append(button(t('compat.action.makeDefault'), () => setDefault('')));
    orow.append(oinfo, oact); official.append(orow); out.push(official);
    // 互換
    for (const e of endpoints.filter(x => x.agent === agent)) {
      const card = el('div', 'mp-card'); const r = el('div', 'mp-row'); const info = el('div', 'mp-card-info');
      info.append(el('strong', null, e.name + (e.isDefault ? ' · ' + t('compat.list.isDefault') : '')));
      info.append(line(e.baseUrl), checkLine(e), labelled(claude ? t('compat.list.mainLabel') : t('compat.list.modelLabel'), modelNode(e.roles.main)));
      const act = el('div', 'mp-card-actions');
      act.hidden = confirming === e.id;
      if (!e.isDefault) act.append(button(t('compat.action.makeDefault'), () => setDefault(e.id)));
      const check = button(t('compat.step.check'), () => recheck(e)); check.disabled = checking === e.id;
      act.append(check, button(t('compat.action.edit'), () => startForm(e)), button(t('compat.action.delete'), () => { confirming = e.id; draw(); }));
      r.append(info, act); card.append(r);
      if (confirming === e.id) {
        const ask = el('div', 'mp-confirm');
        ask.append(el('p', null, t('compat.list.confirmDelete', { name: e.name })));
        const row = el('div', 'mp-card-actions');
        row.append(button(t('compat.action.cancel'), () => { confirming = ''; draw(); }), button(t('compat.action.confirmDelete'), () => remove(e)));
        ask.append(row); card.append(ask);
      }
      out.push(card);
    }
    out.push(button(t('compat.list.add'), () => startForm(null), 'btn mp-link'));
    if (storage && !storage.encrypted) out.push(el('p', 'mp-note mp-warn', t('compat.list.notEncrypted')));
    const state = el('p', 'mp-state', message); state.setAttribute('role', 'status'); out.push(state);
    panel.replaceChildren(...out);
  }

  async function setDefault(id) {
    message = '';
    try { await cmd('compatEndpointDefault', { agent, id }); await load(true); onChange(); }
    catch (e) { message = e.message; }
    draw();
  }
  async function recheck(e) {
    checking = e.id; message = ''; draw();
    try {
      const r = await cmd('compatEndpointRecheck', { id: e.id });
      message = r.ok ? t('compat.list.recheckOk', { name: e.name }) : t('compat.list.recheckFailed', { name: e.name, error: r.error });
      await load(true); onChange();
    } catch (err) { message = err.message; }
    checking = ''; draw();
  }
  async function remove(e) {
    message = '';
    try { await cmd('compatEndpointDelete', { id: e.id }); confirming = ''; await load(true); onChange(); }
    catch (err) { message = t('compat.list.deleteFailed', { error: err.message }); }
    draw();
  }

  // ---------------------------------------------------------------- 追加・編集（画面 3）
  function blankForm(presetId) {
    const p = presetOf(agent, presetId);
    return { id: '', preset: p.id, name: p.id === 'custom' ? '' : p.name, baseUrl: p.urls[0]?.value ?? '',
      authMode: agent === 'claude' ? (['bearer', 'x-api-key'].includes(p.auth) ? p.auth : 'auto') : (p.auth === 'api-key' ? 'api-key' : 'bearer'),
      key: '', show: false, hasKey: false, phase: 'edit', result: null, models: [], modelInfo: {}, roles: { ...p.roles }, context: p.context ?? '',
      sendThinking: Boolean(p.thinking), saved: false, stale: false, error: '' };
  }
  function startForm(e) {
    confirming = ''; message = ''; view = 'form';
    if (!e) form = blankForm('custom' === agent ? 'custom' : PRESETS[agent][0].id);
    else form = { id: e.id, preset: e.preset, name: e.name, baseUrl: e.baseUrl, authMode: e.authMode, key: '', show: false, hasKey: e.hasKey,
      phase: 'edit', result: null, models: e.models ?? [], modelInfo: e.modelInfo ?? {}, roles: { ...e.roles }, context: e.options?.contextTokens ? String(e.options.contextTokens) : '',
      sendThinking: Boolean(e.options?.sendThinking), saved: false, stale: false, error: '' };
    draw();
    panel.scrollIntoView({ block: 'nearest' });
  }
  /** 接続情報（URL・キー・認証）が変わった。確認済みなら確認前に戻す */
  function invalidate() {
    if (form.phase === 'ok' || form.phase === 'fail') { form.stale = form.phase === 'ok'; form.phase = 'edit'; form.result = null; draw(); }
  }
  const field = (label, control, help) => { const f = el('label', 'mp-field'); f.append(el('span', null, label), control); if (help) f.append(help); return f; };
  const step = (n, text) => { const s = el('div', 'mp-step'); s.append(`${n}. `, el('b', null, text)); return s; };
  function input() {
    return { agent, name: form.name, preset: form.preset, baseUrl: form.baseUrl, authMode: form.authMode, key: form.key,
      roles: form.roles, options: { contextTokens: form.context, sendThinking: form.sendThinking }, probeModel: form.roles.main || '' };
  }
  function modelCombo(value, onCommit, label, placeholder = t('compat.form.modelId')) {
    // 候補は取れた一覧（数百件でもよい）。割り当て済みで一覧に無い ID も後ろに足し、表示名で出す。描くのは先頭の SHOW_LIMIT 件
    const c = createCombo({ ariaLabel: label, placeholder, cls: 'mono', value, limit: SHOW_LIMIT, emptyText: t('compat.form.modelNotListed'),
      options: () => comboModelOptions(modelCandidates([...form.models, ...Object.values(form.roles).filter(Boolean)], form.modelInfo)), onCommit });
    c.root.querySelector('input').spellcheck = false;
    return c.root;
  }
  function drawForm() {
    const claude = agent === 'claude'; const P = presetOf(agent, form.preset); const editing = Boolean(form.id);
    const out = [];
    const head = el('div', 'mp-row');
    head.append(el('h3', null, editing ? t('compat.form.editTitle', { name: form.name || t('compat.form.endpoint') }) : t('compat.form.addTitle', { agent: AGENT_NAME[agent] })), button(t('compat.action.close'), backToList));
    head.firstChild.id = 'epTitle';
    out.push(head);
    const cur = form.saved ? 6 : form.phase === 'ok' ? 4 : form.phase === 'checking' || form.phase === 'fail' ? 3 : 2;
    const steps = el('div', 'mp-steps');
    STEPS.forEach((label, i) => steps.append(el('span', i + 1 < cur ? 'done' : i + 1 === cur ? 'cur' : '', (i + 1 < cur ? '✓ ' : `${i + 1}. `) + label)));
    out.push(steps);
    if (form.saved) {
      const r = el('div', 'mp-result');
      r.append(el('strong', null, t('compat.form.saved', { name: form.name })), line(t('compat.form.savedHint')));
      out.push(r);
      const a = el('div', 'mp-actions');
      a.append(button(t('compat.form.addAnother'), () => startForm(null)), button(t('compat.form.backToList'), backToList, 'btn btn-primary'));
      out.push(a);
      panel.replaceChildren(...out);
      return;
    }
    // ① 種類
    out.push(step(1, t('compat.form.kind')));
    const grid = el('div', 'mp-presets'); grid.setAttribute('role', 'group'); grid.setAttribute('aria-label', t('compat.form.kind'));
    for (const p of PRESETS[agent]) {
      const b = el('button', 'mp-preset'); b.type = 'button'; b.setAttribute('aria-pressed', String(p.id === form.preset));
      b.append(el('span', null, p.name), el('small', null, p.hint));
      b.disabled = editing && p.id !== form.preset;
      b.onclick = () => { if (editing || p.id === form.preset) return; form = blankForm(p.id); draw(); };
      grid.append(b);
    }
    out.push(grid);
    // ② 接続情報
    out.push(step(2, t('compat.step.connection')));
    const g = el('div', 'mp-grid');
    const name = el('input'); name.value = form.name; name.placeholder = t('compat.form.namePlaceholder'); name.maxLength = 60; name.autocomplete = 'off';
    name.oninput = () => { form.name = name.value; };
    g.append(field(t('compat.form.name'), name));
    // URL の一文は間違い（/v1 の付けすぎ・<リソース名> の置き忘れ）のときだけ出す
    const help = el('small', 'mp-warn', urlHelp(agent, form.baseUrl));
    const url = createCombo({ ariaLabel: 'URL', placeholder: claude ? t('compat.form.urlPlaceholder') : 'https://example.com/v1', cls: 'mono', value: form.baseUrl,
      options: () => urlCandidates(agent, form.preset),
      onCommit: v => { if (form.baseUrl !== v) { form.baseUrl = v; help.textContent = urlHelp(agent, v); if (form.phase === 'edit') draw(); else invalidate(); } } });
    url.root.querySelector('input').spellcheck = false;
    url.root.querySelector('input').addEventListener('input', e => { help.textContent = urlHelp(agent, e.target.value); });
    g.append(field('URL', url.root, help));
    out.push(g);
    const authField = el('div', 'mp-field');
    authField.append(el('span', null, t('compat.form.auth')));
    const seg = el('div', 'seg mp-seg'); seg.setAttribute('role', 'group'); seg.setAttribute('aria-label', t('compat.form.auth'));
    for (const v of claude ? ['auto', 'bearer', 'x-api-key'] : ['bearer', 'api-key']) {
      const b = el('button', v === form.authMode ? 'on' : '', AUTH_LABEL[v]); b.type = 'button'; b.setAttribute('aria-pressed', String(v === form.authMode));
      b.onclick = () => { if (form.authMode === v) return; form.authMode = v; invalidate(); draw(); };
      seg.append(b);
    }
    authField.append(seg);
    const key = el('input'); key.type = form.show ? 'text' : 'password'; key.value = form.key; key.autocomplete = 'new-password'; key.spellcheck = false;
    key.placeholder = editing && form.hasKey ? t('compat.form.keyKeep') : P.nokey ? t('compat.auth.none') : t('compat.form.apiKey');
    key.oninput = () => { form.key = key.value; invalidate(); };
    const kr = el('div', 'mp-keyrow'); kr.append(key, button(form.show ? t('compat.form.hide') : t('compat.form.show'), () => { form.show = !form.show; draw(); }));
    out.push(field(t('compat.form.apiKey'), kr, P.nokey ? null : el('small', null, t('compat.form.keyStored'))));
    // 認証の送り方は既定（プリセットの値。Claude のカスタムは自動）のまま使うことが多いので、畳んでおく
    const authDefault = blankForm(form.preset).authMode;
    const ad = el('details'); ad.open = form.authMode !== authDefault;
    ad.append(el('summary', null, t('compat.form.advanced')), authField);
    out.push(ad);
    // ③ 確認
    out.push(step(3, t('compat.step.check')));
    if (form.stale && form.phase === 'edit') out.push(el('p', 'mp-note mp-warn', t('compat.form.stale')));
    if (form.phase === 'checking') out.push(Object.assign(el('div', 'mp-result'), { textContent: t('compat.checking') }));
    if (form.result) {
      const r = el('div', 'mp-result'); r.setAttribute('role', 'status');
      const n = form.result.models?.length ?? 0;
      r.append(el('strong', form.result.ok ? '' : 'mp-warn', form.result.ok ? (n ? t('compat.form.connectedModels', { count: n }) : t('compat.form.connected')) : `✕ ${form.result.error}`));
      for (const l of form.result.lines ?? []) r.append(line(l));
      out.push(r);
    }
    // ④ モデル（確認が通ったあと。編集では保存済みの割り当てを最初から見せる）
    if (form.phase === 'ok' || editing) {
      out.push(step(4, claude ? t('compat.form.roles') : t('compat.step.model')));
      if (claude) {
        const rg = el('div', 'mp-grid');
        for (const r of CLAUDE_ROLES) rg.append(field(r.label, modelCombo(form.roles[r.key] ?? '', v => { form.roles[r.key] = v; }, r.label)));
        out.push(rg);
        const d = el('details'); d.open = Boolean(form.context || form.sendThinking !== Boolean(P.thinking));
        d.append(el('summary', null, t('compat.form.advanced')));
        const ctx = createCombo({ ariaLabel: t('compat.form.context'), placeholder: t('compat.form.contextEmptyClaude'), cls: 'mono', value: form.context,
          options: () => CONTEXT_CANDIDATES.map(([value, hint]) => ({ value, hint })), onCommit: v => { form.context = v; } });
        d.append(field(t('compat.form.contextTokens'), ctx.root));
        const think = el('label', 'mp-check'); const cb = el('input'); cb.type = 'checkbox'; cb.checked = form.sendThinking;
        cb.onchange = () => { form.sendThinking = cb.checked; };
        think.append(cb, el('span', null, t('compat.form.sendThinking')));
        d.append(think, el('small', 'mp-note', t('compat.form.sendThinkingNote')));
        out.push(d);
      } else {
        const rg = el('div', 'mp-grid');
        const azure = form.preset === 'azure';
        rg.append(field(azure ? t('compat.form.defaultModelAzure') : t('compat.form.defaultModel'), modelCombo(form.roles.main ?? '', v => { form.roles.main = v; }, t('compat.form.defaultModel'), azure ? t('compat.form.deployment') : t('compat.form.modelId'))));
        const ctx = createCombo({ ariaLabel: t('compat.form.context'), placeholder: t('compat.form.contextEmptyCodex'), cls: 'mono', value: form.context,
          options: () => CONTEXT_CANDIDATES.map(([value, hint]) => ({ value, hint })), onCommit: v => { form.context = v; } });
        rg.append(field(t('compat.form.contextTokens'), ctx.root));
        out.push(rg);
      }
    }
    const err = el('p', 'mp-state mp-warn', form.error); err.setAttribute('role', 'alert'); out.push(err);
    const a = el('div', 'mp-actions');
    // 確認は本物の生成を 1 回送る。料金のことはここに 1 回だけ
    if (form.phase !== 'ok') a.append(el('small', null, t('compat.form.checkCost')));
    a.append(button(t('compat.action.cancel'), backToList));
    if (form.phase === 'ok') a.append(button(t('compat.form.checkAgain'), check), button(t('compat.step.save'), save, 'btn btn-primary'));
    else {
      const c = button(form.phase === 'checking' ? t('compat.checking') : t('compat.step.check'), check, 'btn btn-primary'); c.disabled = form.phase === 'checking'; a.append(c);
    }
    out.push(a);
    panel.replaceChildren(...out);
  }
  async function check() {
    // フォーカス中の combo の値を確定させてから読む（blur で確定する）
    document.activeElement?.blur?.();
    form.error = '';
    if (!form.baseUrl.trim()) { form.error = t('compat.form.urlRequired'); draw(); return; }
    form.phase = 'checking'; form.result = null; form.stale = false; draw();
    const mine = form;
    try {
      const r = await cmd('compatEndpointCheck', { input: input(), ...(form.id ? { id: form.id } : {}) });
      if (form !== mine) return;
      form.phase = r.ok ? 'ok' : 'fail';
      form.result = r;
      if (r.ok) { form.receipt = r.receipt; if (r.models?.length) { form.models = r.models; form.modelInfo = r.modelInfo ?? {}; } }
    } catch (e) { if (form !== mine) return; form.phase = 'fail'; form.result = { ok: false, error: e.message, lines: [] }; }
    draw();
  }
  async function save() {
    document.activeElement?.blur?.();
    form.error = '';
    if (!form.name.trim()) { form.error = t('compat.form.nameRequired'); draw(); return; }
    try {
      await cmd('compatEndpointSave', { input: input(), receipt: form.receipt, ...(form.id ? { id: form.id } : {}) });
      form.saved = true; form.key = '';
      await load(true); onChange();
    } catch (e) { form.error = e.message; }
    draw();
  }
  function backToList() { view = 'list'; form = null; message = ''; draw(); }

  function draw() { if (view === 'form' && form) drawForm(); else drawList(); }
  function close() { panel.hidden = true; view = 'list'; form = null; onOpen(''); }
  let onOpen = () => {};

  return {
    load,
    /** 読み込み済みの一覧（入力欄の面が読む）。まだなら空 */
    list: (a) => endpoints.filter(e => !a || e.agent === a),
    defaults: () => ({ ...defaults }),
    get: (id) => endpoints.find(e => e.id === id) ?? null,
    invalidate() { loaded = null; if (!panel.hidden && view === 'list') load(true).then(draw).catch(() => {}); },
    /** 設定の「接続先」ボタン。同じエージェントでもう一度押すと閉じる */
    async open(which, { add = false } = {}) {
      if (!panel.hidden && agent === which && !add) { close(); return; }
      openSettings(); agent = which; view = 'list'; form = null; confirming = ''; message = t('compat.loading');
      panel.hidden = false; onOpen(agent); drawList();
      try { await load(true); message = ''; if (add) startForm(null); else draw(); panel.scrollIntoView({ block: 'nearest' }); }
      catch (e) { message = e.message; draw(); }
    },
    /** どのエージェントの面が開いているか（設定の行のボタンの aria-expanded に使う） */
    onOpen(fn) { onOpen = fn; },
    get openAgent() { return panel.hidden ? '' : agent; },
  };
}
