// Claude のアカウント（会話ごとに選ぶ。core/claude-accounts.mjs）の設定。
// 一覧の追加・名前の変更・削除と、認可（Pleiad が疑似端末で `claude setup-token` / `claude auth login` を回す。core/claude-login.mjs）。
//
// 追加の流れ: 表示名 →「ブラウザーで認可する」→ ブラウザーで承認 → 表示されたコードを貼る → トークンを登録
//             → 続けて「使用量の表示を認可」（setup-token のトークンでは使用量を読めないため、アカウントごとに別に認可する）。
// トークンは画面に出さない（サーバーも返さない。hasToken だけ）。手で貼る欄は、Pleiad から発行できないときの代わりに残す。
// トークンの持ち主が使用量の認可と別のアカウントなら（サーバーの tokenCheck）、その行と完了のカードに ⚠ と強い字で知らせ、
// 「トークンを発行し直す」を添える（警告色は使わない。docs/design-system.md）。
// 面と部品は設定の管理の面（web/manage-panel.css の .mp-*）を使う。
import { el } from './dom.mjs';
import { t, applyDom } from './i18n.mjs';

/** 認可の進み具合の見出し。「「名前」のトークンを発行」 */
const FLOW_TITLE = {
  'setup-token': name => t('accounts.flowTitle.setupToken', { name }),
  'usage-login': name => t('accounts.flowTitle.usageLogin', { name }),
};

/** text の中の code の部分を <code> にして node に入れる（訳文に HTML を混ぜないため） */
function withCode(node, text, code) {
  const i = text.indexOf(code);
  if (i < 0) { node.textContent = text; return; }
  node.replaceChildren(text.slice(0, i), el('code', null, code), text.slice(i + code.length));
}

export function setupClaudeAccounts({ cmd, openSettings, onChange = () => {} }) {
  const $ = id => document.getElementById(id);
  const panel = document.createElement('section');
  panel.className = 'mp-panel'; panel.id = 'claudeAccountsPanel'; panel.hidden = true;
  panel.setAttribute('aria-labelledby', 'caTitle');
  panel.innerHTML = `<div class="mp-row"><h3 id="caTitle" data-i18n="accounts.title"></h3><button type="button" class="btn" id="caClose" data-i18n="accounts.close"></button></div>
  <p class="mp-note" data-i18n="accounts.intro"></p>
  <div id="caList"></div><button type="button" class="btn" id="caAdd" data-i18n="accounts.add"></button>
  <section class="mp-card" id="caFlow" hidden aria-live="polite"><h3 id="caFlowTitle"></h3><div id="caFlowBody"></div></section>
  <form id="caForm" hidden><h3 id="caFormTitle" data-i18n="accounts.form.addTitle"></h3>
  <label class="mp-field"><span data-i18n="accounts.form.name"></span><input id="caName" required maxlength="60" data-i18n-placeholder="accounts.form.namePlaceholder" autocomplete="off"></label>
  <p class="mp-note" id="caAuthNote" data-i18n="accounts.form.authNote"></p>
  <div class="mp-actions" id="caAuthActions"><button type="button" class="btn" id="caCancel" data-i18n="accounts.form.cancel"></button><button type="button" class="btn btn-primary" id="caAuthorize" data-i18n="accounts.form.authorize"></button></div>
  <details id="caManual"><summary data-i18n="accounts.form.manual"></summary>
  <p class="mp-note" id="caManualNote"></p>
  <label class="mp-field"><span data-i18n="accounts.form.token"></span><div class="mp-row"><input id="caToken" type="password" autocomplete="new-password" spellcheck="false"><button type="button" class="btn" id="caReveal" data-i18n="accounts.form.show"></button></div><small id="caTokenHint"></small></label>
  <div class="mp-actions"><button type="submit" class="btn" id="caSave" data-i18n="accounts.form.save"></button></div></details>
  <p class="mp-state" id="caFormState" role="status"></p></form>
  <p class="mp-note" data-i18n="accounts.usageNote"></p>
  <p class="mp-note" id="caStorage"></p><p class="mp-state" id="caState" role="status"></p>`;
  applyDom(panel);
  withCode(panel.querySelector('#caManualNote'), t('accounts.form.manualNote', { command: 'claude setup-token' }), 'claude setup-token');
  $('agentControls').append(panel);

  let accounts = [], storage = null, loaded = null, editingId = '', saving = false, confirming = '';
  /** 進行中の認可。{ loginId, kind, accountId, name, phase, url, message, popup } */
  let flow = null;
  const NEW_HINT = t('accounts.form.newHint');
  const EDIT_HINT = t('accounts.form.editHint');
  // デスクトップ版はサーバーが既定のブラウザーで開く。ブラウザー版は押した時点で窓を開けておき、URL が届いたら移す（後から開くとポップアップとして止められる）
  const desktop = () => Boolean(window.plyDesktop);

  /** 一覧を取り直す。force でなければ前回の結果を使い回す（入力欄の出し分けで何度も呼ばれる） */
  async function load(force = false) {
    if (!loaded || force) loaded = cmd('claudeAccounts').then(r => { accounts = r.accounts ?? []; storage = r.storage ?? null; return accounts; })
      .catch(e => { loaded = null; throw e; });
    return loaded;
  }
  function button(text, onclick, className = 'btn') { const b = el('button', className, text); b.type = 'button'; b.onclick = onclick; return b; }
  function status(a) {
    const token = a.hasToken ? t('accounts.status.token') : t('accounts.status.noToken');
    const usage = a.usageLogin ? t('accounts.status.usage') : t('accounts.status.noUsage');
    return `${token} · ${usage}`;
  }
  /**
   * トークンの持ち主の食い違い（サーバーの tokenCheck。core/claude-accounts.mjs の tokenChecks）。無ければ ''。
   * setup-token はブラウザーでログイン中の claude.ai アカウントで黙って発行されるので、直し方はログインを切り替えて発行し直すこと
   */
  // 括弧書き（メールアドレス）は文の中へ差し込む。無ければ空
  function ownerWarning(a) {
    const c = a?.hasToken ? a.tokenCheck : null;
    if (c?.status === 'mismatch') {
      const reissue = t('accounts.owner.reissue');
      const expected = c.expectedEmail ? t('accounts.owner.expected', { email: c.expectedEmail }) : '';
      if (c.ownerName) return t('accounts.owner.named', { owner: c.ownerName, expected, reissue });
      if (c.ownerLoggedIn) return t('accounts.owner.loggedIn', { email: c.ownerEmail ? t('accounts.owner.email', { email: c.ownerEmail }) : '', expected, reissue });
      return t('accounts.owner.other', { email: c.expectedEmail ? t('accounts.owner.email', { email: c.expectedEmail }) : '', reissue });
    }
    if (c?.sameTokenAs?.length) {
      return t('accounts.owner.same', { names: c.sameTokenAs.join(t('accounts.owner.nameJoin')) });
    }
    return '';
  }
  /** 食い違いの一文と「トークンを発行し直す」。無ければ null */
  function warningBlock(a) {
    const text = ownerWarning(a);
    if (!text) return null;
    const box = el('div', 'mp-confirm');
    box.append(el('p', 'mp-warn', `⚠ ${text}`));
    const row = el('div', 'mp-card-actions');
    row.append(button(t('accounts.reissue'), () => startLogin({ kind: 'setup-token', accountId: a.id, name: a.name })));
    box.append(row);
    return box;
  }
  function draw() {
    $('caList').replaceChildren(...accounts.map(a => {
      const card = el('div', 'mp-card');
      const top = el('div', 'mp-row'), info = el('div', 'mp-card-info');
      info.append(el('strong', null, a.name), el('small', null, status(a)));
      const actions = el('div', 'mp-card-actions');
      actions.hidden = confirming === a.id;
      actions.append(
        button(a.hasToken ? t('accounts.reissue') : t('accounts.issue'), () => startLogin({ kind: 'setup-token', accountId: a.id, name: a.name })),
        button(a.usageLogin ? t('accounts.redoUsage') : t('accounts.authorizeUsage'), () => startLogin({ kind: 'usage-login', accountId: a.id, name: a.name })),
        button(t('accounts.edit'), () => edit(a)), button(t('accounts.delete'), () => { confirming = a.id; draw(); }));
      top.append(info, actions); card.append(top);
      const warning = confirming === a.id ? null : warningBlock(a);
      if (warning) card.append(warning);
      if (confirming === a.id) {
        const ask = el('div', 'mp-confirm');
        ask.append(el('p', null, t('accounts.confirmDelete', { name: a.name })));
        const row = el('div', 'mp-card-actions');
        row.append(button(t('accounts.cancel'), () => { confirming = ''; draw(); }), button(t('accounts.confirmDeleteButton'), () => remove(a)));
        ask.append(row); card.append(ask);
      }
      return card;
    }));
    if (!accounts.length) $('caList').replaceChildren(el('p', 'mp-note', t('accounts.empty')));
    $('caStorage').textContent = !storage ? '' : storage.encrypted
      ? t('accounts.storage.encrypted')
      : t('accounts.storage.plain');
  }

  // ---------------------------------------------------------------- 認可の進み具合
  function drawFlow() {
    const box = $('caFlow');
    if (!flow) { box.hidden = true; $('caFlowBody').replaceChildren(); return; }
    box.hidden = false;
    $('caFlowTitle').textContent = FLOW_TITLE[flow.kind]?.(flow.name) ?? flow.name;
    const body = [];
    const note = text => el('p', 'mp-note', text);
    const actions = (...buttons) => { const row = el('div', 'mp-actions'); row.append(...buttons); return row; };
    const cancel = button(t('accounts.cancel'), cancelFlow);
    const link = () => {
      if (!/^https:\/\//.test(flow.url ?? '')) return null;
      const a = el('a', null, t('accounts.flow.openLink'));
      a.href = flow.url; a.target = '_blank'; a.rel = 'noreferrer';
      return a;
    };
    switch (flow.phase) {
      case 'starting':
        body.push(el('p', null, t('accounts.flow.starting')), actions(cancel));
        break;
      case 'url':
      case 'code':
      case 'verifying': {
        body.push(el('p', null, flow.kind === 'usage-login'
          ? t('accounts.flow.step1Usage')
          : t('accounts.flow.step1Token')));
        const l = link(); if (l) { const p = el('p', 'mp-note'); p.append(l); body.push(p); }
        body.push(el('p', null, t('accounts.flow.step2')));
        const form = el('form');
        const field = el('label', 'mp-field');
        // 描き直しで打ちかけのコードを消さない
        const typed = $('caCode')?.value ?? '';
        const input = el('input'); input.id = 'caCode'; input.value = typed; input.autocomplete = 'off'; input.spellcheck = false; input.placeholder = t('accounts.flow.codePlaceholder');
        input.setAttribute('aria-label', t('accounts.flow.codeLabel'));
        field.append(input); form.append(field);
        const submit = el('button', 'btn btn-primary', flow.phase === 'verifying' ? t('accounts.flow.verifying') : t('accounts.flow.submit')); submit.type = 'submit';
        submit.disabled = flow.phase === 'verifying';
        input.disabled = flow.phase === 'verifying';
        form.append(actions(cancel, submit));
        form.onsubmit = e => { e.preventDefault(); submitCode(input.value); };
        if (flow.message) body.push(el('p', 'mp-state', flow.message));
        body.push(form);
        if (flow.phase !== 'verifying') queueMicrotask(() => { if (document.activeElement?.id !== 'caCode' && !panel.hidden) input.focus(); });
        break;
      }
      case 'done': {
        // 済んだらトークンの持ち主を照合した一覧が届く。食い違えば、ここでもすぐ知らせる
        const account = accounts.find(a => a.id === flow.accountId);
        const warning = ownerWarning(account);
        if (warning) {
          body.push(el('p', null, flow.kind === 'setup-token' ? t('accounts.flow.tokenDone') : t('accounts.flow.usageDoneShort')),
            el('p', 'mp-warn', `⚠ ${warning}`),
            actions(button(t('accounts.close'), () => { flow = null; drawFlow(); }),
              button(t('accounts.reissue'), () => startLogin({ kind: 'setup-token', accountId: account.id, name: account.name }))));
        } else if (flow.kind === 'setup-token') {
          body.push(el('p', null, t('accounts.flow.tokenDoneChoose')));
          if (account && !account.usageLogin) {
            body.push(note(t('accounts.flow.usageNext')));
            body.push(actions(button(t('accounts.flow.later'), () => { flow = null; drawFlow(); }),
              button(t('accounts.authorizeUsage'), () => startLogin({ kind: 'usage-login', accountId: account.id, name: account.name }), 'btn btn-primary')));
          } else body.push(actions(button(t('accounts.close'), () => { flow = null; drawFlow(); })));
        } else {
          body.push(el('p', null, t('accounts.flow.usageDone')),
            actions(button(t('accounts.close'), () => { flow = null; drawFlow(); })));
        }
        break;
      }
      case 'error':
        body.push(el('p', 'mp-state', flow.message || t('accounts.flow.failed')),
          actions(button(t('accounts.close'), () => { flow = null; drawFlow(); }),
            button(t('accounts.flow.retry'), () => startLogin({ kind: flow.kind, accountId: flow.accountId, name: flow.name }))));
        if (flow.kind === 'setup-token') body.push(note(t('accounts.flow.failedHint')));
        break;
    }
    $('caFlowBody').replaceChildren(...body);
  }

  async function startLogin({ kind, accountId, name }) {
    if (flow?.loginId && !['done', 'error'].includes(flow.phase)) await cmd('claudeLoginCancel', { loginId: flow.loginId }).catch(() => {});
    flow?.popup?.close?.();
    let popup = null;
    if (!desktop()) {
      // ブラウザー版: クリックの中で窓を開けておく。認可ページへ移ったあと、元の画面を操作できないよう opener を切る
      try { popup = window.open('', '_blank'); if (popup) popup.opener = null; } catch {}
    }
    flow = { loginId: null, kind, accountId: accountId ?? null, name, phase: 'starting', url: null, message: '', popup };
    $('caForm').hidden = true; confirming = ''; draw(); drawFlow();
    $('caFlow').scrollIntoView?.({ block: 'nearest' });
    try {
      const { loginId } = await cmd('claudeLoginStart', { kind, ...(accountId ? { accountId } : { name }), open: desktop() });
      if (flow && flow.kind === kind && flow.name === name) {
        flow.loginId = loginId;
        // イベントが応答より先に届いていたら、そちらを当てる
        const early = pending.get(loginId); pending.delete(loginId);
        if (early) for (const ev of early) apply(ev);
      }
    } catch (e) {
      popup?.close?.();
      if (flow) { flow.phase = 'error'; flow.message = e.message; flow.popup = null; drawFlow(); }
    }
  }
  async function submitCode(value) {
    if (!flow?.loginId) return;
    const code = String(value ?? '').trim();
    if (!code) { flow.message = t('accounts.flow.codeRequired'); drawFlow(); return; }
    flow.phase = 'verifying'; flow.message = ''; drawFlow();
    try { await cmd('claudeLoginCode', { loginId: flow.loginId, code }); }
    catch (e) { if (flow) { flow.phase = 'code'; flow.message = e.message; drawFlow(); } }
  }
  async function cancelFlow() {
    const id = flow?.loginId;
    flow?.popup?.close?.();
    flow = null; drawFlow();
    if (id) await cmd('claudeLoginCancel', { loginId: id }).catch(() => {});
  }
  // claudeLoginStart の応答より先に届いたイベント（loginId がまだ分からない）
  const pending = new Map();
  function apply(ev) {
    if (!flow || ev.loginId !== flow.loginId) return;
    if (ev.accountId) flow.accountId = ev.accountId;
    if (ev.phase === 'url') {
      flow.url = ev.url; if (flow.phase === 'starting') flow.phase = 'url';
      if (flow.popup && /^https:\/\//.test(ev.url ?? '')) { try { flow.popup.location.href = ev.url; } catch {} flow.popup = null; }
    } else if (ev.phase === 'code') { flow.phase = 'code'; flow.message = ev.message ?? ''; }
    else if (ev.phase === 'verifying') { flow.phase = 'verifying'; }
    else if (ev.phase === 'done') { flow.phase = 'done'; flow.message = ''; load(true).then(() => { draw(); drawFlow(); onChange(); }).catch(() => {}); }
    else if (ev.phase === 'error') { flow.phase = 'error'; flow.message = ev.message ?? ''; flow.popup?.close?.(); flow.popup = null; }
    else if (ev.phase === 'cancelled') { flow = null; }
    drawFlow();
  }
  /** サーバーからの claudeLogin イベント（web/client.mjs が渡す） */
  function loginEvent(ev) {
    if (flow && !flow.loginId && flow.phase === 'starting') {
      const list = pending.get(ev.loginId) ?? []; list.push(ev); pending.set(ev.loginId, list);
      if (pending.size > 20) pending.delete(pending.keys().next().value);
      return;
    }
    apply(ev);
  }

  // ---------------------------------------------------------------- 追加・編集のフォーム
  function resetForm() {
    editingId = ''; $('caFormTitle').textContent = t('accounts.form.addTitle');
    $('caName').value = ''; $('caToken').value = ''; $('caToken').type = 'password'; $('caReveal').textContent = t('accounts.form.show');
    $('caTokenHint').textContent = NEW_HINT; $('caFormState').textContent = '';
    $('caAuthNote').hidden = false; $('caAuthorize').hidden = false; $('caManual').open = false;
    $('caManual').querySelector('summary').textContent = t('accounts.form.manual');
    $('caSave').textContent = t('accounts.form.save');
  }
  function edit(a) {
    resetForm(); editingId = a.id; confirming = '';
    $('caFormTitle').textContent = t('accounts.form.editTitle', { name: a.name }); $('caName').value = a.name;
    // 編集は名前の変更とトークンの貼り直しだけ。ブラウザーでの認可は一覧の「トークンを発行し直す」から
    $('caAuthNote').hidden = true; $('caAuthorize').hidden = true;
    $('caManual').open = !a.hasToken;
    $('caManual').querySelector('summary').textContent = t('accounts.form.manualReplace');
    $('caTokenHint').textContent = a.hasToken ? EDIT_HINT : NEW_HINT;
    $('caForm').hidden = false; draw(); $('caName').focus();
  }
  async function remove(a) {
    $('caState').textContent = '';
    try {
      if (flow?.accountId === a.id) { flow?.popup?.close?.(); flow = null; drawFlow(); }
      await cmd('deleteClaudeAccount', { id: a.id }); confirming = '';
      if (editingId === a.id) { $('caForm').hidden = true; resetForm(); }
      await load(true); draw(); onChange();
    }
    catch (e) { $('caState').textContent = t('accounts.deleteFailed', { error: e.message }); }
  }
  async function open({ usageLogin } = {}) {
    openSettings(); panel.hidden = false; $('caState').textContent = t('accounts.loading');
    try {
      await load(true); $('caForm').hidden = true; resetForm(); confirming = ''; draw(); drawFlow(); $('caState').textContent = '';
      panel.scrollIntoView({ block: 'nearest' });
      const target = usageLogin && accounts.find(a => a.id === usageLogin);
      if (target) startLogin({ kind: 'usage-login', accountId: target.id, name: target.name });
    }
    catch (e) { $('caState').textContent = e.message; }
  }
  $('caClose').onclick = () => { panel.hidden = true; $('caForm').hidden = true; resetForm(); };
  $('caAdd').onclick = () => { resetForm(); confirming = ''; $('caForm').hidden = false; draw(); $('caName').focus(); };
  $('caCancel').onclick = () => { $('caForm').hidden = true; resetForm(); };
  $('caReveal').onclick = () => { const show = $('caToken').type === 'password'; $('caToken').type = show ? 'text' : 'password'; $('caReveal').textContent = show ? t('accounts.form.hide') : t('accounts.form.show'); };
  $('caAuthorize').onclick = () => {
    const name = $('caName').value.trim();
    if (!name) { $('caFormState').textContent = t('accounts.form.nameRequired'); $('caName').focus(); return; }
    startLogin({ kind: 'setup-token', name });
  };
  $('caForm').onsubmit = async e => {
    e.preventDefault(); if (saving) return;
    const token = $('caToken').value.trim();
    // 新規で貼っていないなら、Enter はブラウザーでの認可として扱う
    if (!editingId && !token) { $('caAuthorize').click(); return; }
    saving = true; $('caSave').disabled = true; $('caFormState').textContent = t('accounts.form.saving');
    try {
      await cmd('saveClaudeAccount', { ...(editingId ? { id: editingId } : {}), name: $('caName').value, ...(token ? { token } : {}) });
      $('caForm').hidden = true; resetForm(); await load(true); draw(); onChange();
    } catch (err) { $('caFormState').textContent = err.message; }
    finally { saving = false; $('caSave').disabled = false; }
  };
  return {
    open, load, list: () => accounts, loginEvent,
    invalidate: () => { loaded = null; if (!panel.hidden) load(true).then(() => { draw(); drawFlow(); }).catch(() => {}); },
  };
}
