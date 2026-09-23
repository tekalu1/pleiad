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

const KIND_TITLE = { 'setup-token': 'トークンを発行', 'usage-login': '使用量の表示を認可' };

export function setupClaudeAccounts({ cmd, openSettings, onChange = () => {} }) {
  const $ = id => document.getElementById(id);
  const panel = document.createElement('section');
  panel.className = 'mp-panel'; panel.id = 'claudeAccountsPanel'; panel.hidden = true;
  panel.setAttribute('aria-labelledby', 'caTitle');
  panel.innerHTML = `<div class="mp-row"><h3 id="caTitle">Claude のアカウント</h3><button type="button" class="btn" id="caClose">閉じる</button></div>
  <p class="mp-note">登録したアカウントは、会話の入力欄のモデルの隣で選べます。選ばない会話はログイン中のアカウントで動きます。</p>
  <div id="caList"></div><button type="button" class="btn" id="caAdd">＋ アカウントを追加</button>
  <section class="mp-card" id="caFlow" hidden aria-live="polite"><h3 id="caFlowTitle"></h3><div id="caFlowBody"></div></section>
  <form id="caForm" hidden><h3 id="caFormTitle">アカウントを追加</h3>
  <label class="mp-field"><span>表示名</span><input id="caName" required maxlength="60" placeholder="仕事用、個人用など" autocomplete="off"></label>
  <p class="mp-note" id="caAuthNote">「ブラウザーで認可する」を押すと、Claude のログイン画面が開きます。使いたいアカウントでログインして承認し、表示されたコードをここに貼ると登録できます。</p>
  <div class="mp-actions" id="caAuthActions"><button type="button" class="btn" id="caCancel">キャンセル</button><button type="button" class="btn btn-primary" id="caAuthorize">ブラウザーで認可する</button></div>
  <details id="caManual"><summary>トークンを手動で貼り付ける</summary>
  <p class="mp-note">Pleiad から認可できないときは、使いたいアカウントでターミナルから <code>claude setup-token</code> を実行し、表示されたトークンを貼り付けてください。</p>
  <label class="mp-field"><span>トークン</span><div class="mp-row"><input id="caToken" type="password" autocomplete="new-password" spellcheck="false"><button type="button" class="btn" id="caReveal">表示</button></div><small id="caTokenHint"></small></label>
  <div class="mp-actions"><button type="submit" class="btn" id="caSave">保存</button></div></details>
  <p class="mp-state" id="caFormState" role="status"></p></form>
  <p class="mp-note">使用量の画面にアカウントごとの残りを出すには、アカウントごとに「使用量の表示を認可」が要ります。環境変数 ANTHROPIC_API_KEY があるときは、そちらが優先されます。</p>
  <p class="mp-note" id="caStorage"></p><p class="mp-state" id="caState" role="status"></p>`;
  $('agentControls').append(panel);

  let accounts = [], storage = null, loaded = null, editingId = '', saving = false, confirming = '';
  /** 進行中の認可。{ loginId, kind, accountId, name, phase, url, message, popup } */
  let flow = null;
  const NEW_HINT = '発行されたトークン（sk-ant-oat01-…）をそのまま貼り付けてください。保存したトークンは表示しません。';
  const EDIT_HINT = '変更するときだけ貼り付けてください。空のままなら保存済みのトークンを使います。';
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
    const token = a.hasToken ? 'トークン登録済み' : 'トークン未登録';
    const usage = a.usageLogin ? '使用量の表示: 認可済み' : '使用量の表示: 未認可';
    return `${token} · ${usage}`;
  }
  /**
   * トークンの持ち主の食い違い（サーバーの tokenCheck。core/claude-accounts.mjs の tokenChecks）。無ければ ''。
   * setup-token はブラウザーでログイン中の claude.ai アカウントで黙って発行されるので、直し方はログインを切り替えて発行し直すこと
   */
  const REISSUE = 'ブラウザーで claude.ai のログインを切り替えてから、トークンを発行し直してください。';
  function ownerWarning(a) {
    const c = a?.hasToken ? a.tokenCheck : null;
    if (c?.status === 'mismatch') {
      const expected = c.expectedEmail ? `（使用量の認可は ${c.expectedEmail}）` : '';
      if (c.ownerName) return `このトークンは「${c.ownerName}」のアカウントで発行されています${expected}。${REISSUE}`;
      if (c.ownerLoggedIn) return `このトークンは、ログイン中のアカウント${c.ownerEmail ? `（${c.ownerEmail}）` : ''}で発行されています${expected}。${REISSUE}`;
      return `このトークンは、使用量の認可${c.expectedEmail ? `（${c.expectedEmail}）` : ''}とは別のアカウントで発行されています。${REISSUE}`;
    }
    if (c?.sameTokenAs?.length) {
      return `このトークンは「${c.sameTokenAs.join('」「')}」と同じアカウントで発行されています。別のアカウントとして使うなら、${REISSUE}`;
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
    row.append(button('トークンを発行し直す', () => startLogin({ kind: 'setup-token', accountId: a.id, name: a.name })));
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
        button(a.hasToken ? 'トークンを発行し直す' : 'トークンを発行', () => startLogin({ kind: 'setup-token', accountId: a.id, name: a.name })),
        button(a.usageLogin ? '使用量の認可をやり直す' : '使用量の表示を認可', () => startLogin({ kind: 'usage-login', accountId: a.id, name: a.name })),
        button('編集', () => edit(a)), button('削除', () => { confirming = a.id; draw(); }));
      top.append(info, actions); card.append(top);
      const warning = confirming === a.id ? null : warningBlock(a);
      if (warning) card.append(warning);
      if (confirming === a.id) {
        const ask = el('div', 'mp-confirm');
        ask.append(el('p', null, `「${a.name}」を削除しますか？ このアカウントを選んでいる会話は、選び直すまで送信できません。使用量の表示の認可も消えます。`));
        const row = el('div', 'mp-card-actions');
        row.append(button('やめる', () => { confirming = ''; draw(); }), button('削除する', () => remove(a)));
        ask.append(row); card.append(ask);
      }
      return card;
    }));
    if (!accounts.length) $('caList').replaceChildren(el('p', 'mp-note', 'まだ登録していません。'));
    $('caStorage').textContent = !storage ? '' : storage.encrypted
      ? 'トークンは OS の資格情報で暗号化して保存します。'
      : 'この起動では暗号化できないため、トークンは本人だけが読めるファイルに保存します（Pleiad デスクトップで開くと暗号化し直します）。';
  }

  // ---------------------------------------------------------------- 認可の進み具合
  function drawFlow() {
    const box = $('caFlow');
    if (!flow) { box.hidden = true; $('caFlowBody').replaceChildren(); return; }
    box.hidden = false;
    $('caFlowTitle').textContent = `「${flow.name}」の${KIND_TITLE[flow.kind]}`;
    const body = [];
    const note = text => el('p', 'mp-note', text);
    const actions = (...buttons) => { const row = el('div', 'mp-actions'); row.append(...buttons); return row; };
    const cancel = button('やめる', cancelFlow);
    const link = () => {
      if (!/^https:\/\//.test(flow.url ?? '')) return null;
      const a = el('a', null, 'ブラウザーが開かないときはこちら');
      a.href = flow.url; a.target = '_blank'; a.rel = 'noreferrer';
      return a;
    };
    switch (flow.phase) {
      case 'starting':
        body.push(el('p', null, 'Claude Code を起動しています…'), actions(cancel));
        break;
      case 'url':
      case 'code':
      case 'verifying': {
        body.push(el('p', null, flow.kind === 'usage-login'
          ? '1. ブラウザーで、このアカウントの Claude にログインして「承認」を押してください。'
          : '1. ブラウザーで、使いたいアカウントの Claude にログインして「承認」を押してください。'));
        const l = link(); if (l) { const p = el('p', 'mp-note'); p.append(l); body.push(p); }
        body.push(el('p', null, '2. ブラウザーに表示されたコードを貼ってください。'));
        const form = el('form');
        const field = el('label', 'mp-field');
        // 描き直しで打ちかけのコードを消さない
        const typed = $('caCode')?.value ?? '';
        const input = el('input'); input.id = 'caCode'; input.value = typed; input.autocomplete = 'off'; input.spellcheck = false; input.placeholder = 'コードを貼り付け';
        input.setAttribute('aria-label', 'ブラウザーに表示されたコード');
        field.append(input); form.append(field);
        const submit = el('button', 'btn btn-primary', flow.phase === 'verifying' ? '確認しています…' : '送信'); submit.type = 'submit';
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
          body.push(el('p', null, flow.kind === 'setup-token' ? 'トークンを登録しました。' : '使用量の表示を認可しました。'),
            el('p', 'mp-warn', `⚠ ${warning}`),
            actions(button('閉じる', () => { flow = null; drawFlow(); }),
              button('トークンを発行し直す', () => startLogin({ kind: 'setup-token', accountId: account.id, name: account.name }))));
        } else if (flow.kind === 'setup-token') {
          body.push(el('p', null, 'トークンを登録しました。会話の入力欄でこのアカウントを選べます。'));
          if (account && !account.usageLogin) {
            body.push(note('続けて、使用量を表示するための認可をします。使用量の画面にこのアカウントの残りを出すために、もう一度ブラウザーで承認してコードを貼ります（会話に使うトークンとは別の認可です）。'));
            body.push(actions(button('あとで', () => { flow = null; drawFlow(); }),
              button('使用量の表示を認可', () => startLogin({ kind: 'usage-login', accountId: account.id, name: account.name }), 'btn btn-primary')));
          } else body.push(actions(button('閉じる', () => { flow = null; drawFlow(); })));
        } else {
          body.push(el('p', null, '使用量の表示を認可しました。設定の「使用量」にこのアカウントの残りが出ます。'),
            actions(button('閉じる', () => { flow = null; drawFlow(); })));
        }
        break;
      }
      case 'error':
        body.push(el('p', 'mp-state', flow.message || '認可できませんでした。'),
          actions(button('閉じる', () => { flow = null; drawFlow(); }),
            button('やり直す', () => startLogin({ kind: flow.kind, accountId: flow.accountId, name: flow.name }))));
        if (flow.kind === 'setup-token') body.push(note('うまくいかないときは、「アカウントを追加」の「トークンを手動で貼り付ける」から登録できます。'));
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
    if (!code) { flow.message = 'ブラウザーに表示されたコードを貼り付けてください'; drawFlow(); return; }
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
    editingId = ''; $('caFormTitle').textContent = 'アカウントを追加';
    $('caName').value = ''; $('caToken').value = ''; $('caToken').type = 'password'; $('caReveal').textContent = '表示';
    $('caTokenHint').textContent = NEW_HINT; $('caFormState').textContent = '';
    $('caAuthNote').hidden = false; $('caAuthorize').hidden = false; $('caManual').open = false;
    $('caManual').querySelector('summary').textContent = 'トークンを手動で貼り付ける';
    $('caSave').textContent = '保存';
  }
  function edit(a) {
    resetForm(); editingId = a.id; confirming = '';
    $('caFormTitle').textContent = `「${a.name}」を編集`; $('caName').value = a.name;
    // 編集は名前の変更とトークンの貼り直しだけ。ブラウザーでの認可は一覧の「トークンを発行し直す」から
    $('caAuthNote').hidden = true; $('caAuthorize').hidden = true;
    $('caManual').open = !a.hasToken;
    $('caManual').querySelector('summary').textContent = 'トークンを手動で貼り直す';
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
    catch (e) { $('caState').textContent = `削除できませんでした: ${e.message}`; }
  }
  async function open({ usageLogin } = {}) {
    openSettings(); panel.hidden = false; $('caState').textContent = '読み込んでいます…';
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
  $('caReveal').onclick = () => { const show = $('caToken').type === 'password'; $('caToken').type = show ? 'text' : 'password'; $('caReveal').textContent = show ? '非表示' : '表示'; };
  $('caAuthorize').onclick = () => {
    const name = $('caName').value.trim();
    if (!name) { $('caFormState').textContent = 'アカウントの表示名を入力してください'; $('caName').focus(); return; }
    startLogin({ kind: 'setup-token', name });
  };
  $('caForm').onsubmit = async e => {
    e.preventDefault(); if (saving) return;
    const token = $('caToken').value.trim();
    // 新規で貼っていないなら、Enter はブラウザーでの認可として扱う
    if (!editingId && !token) { $('caAuthorize').click(); return; }
    saving = true; $('caSave').disabled = true; $('caFormState').textContent = '保存しています…';
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
