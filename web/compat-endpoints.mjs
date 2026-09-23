// 互換の接続先の設定（設定 › エージェント設定 › Claude Code / Codex の「接続先」。モック docs/mockups/compat-endpoints.html の画面 2・3）。
//
// 一覧（公式の行＋登録した互換の接続先。既定にする・接続を確認・編集・削除）と、追加・編集の 5 段の流れ
//   ① 種類（プリセット）→ ② 接続情報 → ③ 接続を確認 → ④ モデル → ⑤ 保存
// 確認が通るまで保存は出さない（サーバーの受領証。URL・キー・認証を変えたら確認し直し。モデルの欄は変えても確認し直さない）。
// キーは伏せ字で受け、保存後は表示しない（サーバーも返さない。hasKey だけ）。
// 面と部品は Claude のアカウントの設定（web/claude-accounts.mjs）と同じ .mp-*（web/manage-panel.css）。
// 入力欄のモデルの面（web/composer-controls.mjs）は list() の値を読むだけ。
import { el } from './dom.mjs';
import { createCombo } from './combo.mjs';
import { PRESETS, KIND_LABEL, CLAUDE_ROLES, CONTEXT_CANDIDATES, AUTH_LABEL, presetOf, urlCandidates, urlHelp, lostText } from './compat-presets.mjs';

const AGENT_NAME = { claude: 'Claude Code', codex: 'Codex' };
const STEPS = ['種類', '接続情報', '接続を確認', 'モデル', '保存'];

function when(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = n => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:${p(d.getMinutes())}`;
}

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
  const labelled = (label, text) => { const s = el('span', 'mp-ln'); s.append(el('b', null, label), text); return s; };

  function roleText(e) {
    if (e.agent === 'codex') return (e.roles.main || '（未設定）') + (e.options?.contextTokens ? ` · コンテキスト ${e.options.contextTokens.toLocaleString()} tokens` : '');
    return CLAUDE_ROLES.map(r => `${r.short} ${e.roles[r.key] || '（未設定）'}`).join(' · ');
  }
  function checkLine(e) {
    if (checking === e.id) return line('確認しています…');
    const c = e.lastCheck;
    if (!c) return line('まだ確認していません');
    if (c.ok) return line(`✓ 確認済み（${when(c.at)}${c.modelCount ? ` · モデル ${c.modelCount} 件` : ''}）`);
    return line(`⚠ 前回の確認に失敗しました（${when(c.at)} · ${c.error}）。「編集」でキーや URL を直してください。この接続先を選んでいる会話は、直すまで送信できません。`, 'mp-ln mp-warn');
  }

  // ---------------------------------------------------------------- 一覧（画面 2）
  function drawList() {
    const claude = agent === 'claude';
    const out = [];
    const head = el('div', 'mp-row');
    head.append(el('h3', null, `${AGENT_NAME[agent]} の接続先`), button('閉じる', close));
    head.firstChild.id = 'epTitle';
    out.push(head);
    out.push(el('p', 'mp-note', claude
      ? 'Anthropic 互換（/v1/messages）の接続先を登録すると、入力欄のモデルの面で会話ごとに選べます。選ばない会話は公式で動きます。'
      : 'OpenAI の Responses API（/responses）に対応した接続先を登録すると、会話ごとに選べます。Chat Completions だけの接続先は使えません。'));
    // 公式
    const official = el('div', 'mp-card'); const orow = el('div', 'mp-row'); const oinfo = el('div', 'mp-card-info');
    oinfo.append(el('strong', null, '公式（ログイン中のアカウント）' + (!defaults[agent] ? ' · 新しい会話の既定' : '')),
      line(claude ? `Anthropic${officialLine('claude') ? ' · ' + officialLine('claude') : ''} · アカウントの切り替えは「アカウント」から` : `OpenAI${officialLine('codex') ? ' · ' + officialLine('codex') : ''}`));
    const oact = el('div', 'mp-card-actions');
    if (defaults[agent]) oact.append(button('既定にする', () => setDefault('')));
    orow.append(oinfo, oact); official.append(orow); out.push(official);
    // 互換
    for (const e of endpoints.filter(x => x.agent === agent)) {
      const card = el('div', 'mp-card'); const r = el('div', 'mp-row'); const info = el('div', 'mp-card-info');
      info.append(el('strong', null, e.name + (e.isDefault ? ' · 新しい会話の既定' : '')));
      const auth = e.hasKey ? `認証: ${AUTH_LABEL[e.auth] ?? e.auth} · キー: OS の資格情報に保存済み` : '認証: キー不要';
      info.append(line(`${KIND_LABEL[e.kind]} · ${e.baseUrl} · ${auth}`), checkLine(e), labelled('モデル: ', roleText(e)),
        labelled('この接続先で使えないもの: ', lostText(agent)));
      if (e.agent === 'claude') info.append(line(e.options?.sendThinking ? '思考とエフォート: 送る' : '思考とエフォート: 送らない（「編集」の詳しい設定で変えられます）'));
      const act = el('div', 'mp-card-actions');
      act.hidden = confirming === e.id;
      if (!e.isDefault) act.append(button('既定にする', () => setDefault(e.id)));
      const check = button('接続を確認', () => recheck(e)); check.disabled = checking === e.id;
      act.append(check, button('編集', () => startForm(e)), button('削除', () => { confirming = e.id; draw(); }));
      r.append(info, act); card.append(r);
      if (confirming === e.id) {
        const ask = el('div', 'mp-confirm');
        ask.append(el('p', null, `「${e.name}」を削除しますか。キーも OS の資格情報から消します。この接続先を選んでいる会話は、次のターンの前に選び直しが必要です。`));
        const row = el('div', 'mp-card-actions');
        row.append(button('やめる', () => { confirming = ''; draw(); }), button('削除する', () => remove(e)));
        ask.append(row); card.append(ask);
      }
      out.push(card);
    }
    out.push(button('＋ 接続先を追加', () => startForm(null), 'btn mp-link'));
    out.push(el('p', 'mp-note', 'キーは OS の資格情報（Claude のアカウントや外部 MCP の秘密と同じ保存先）に置き、保存後は表示しません。~/.claude/settings.json や ~/.codex/config.toml は書き換えず、会話を始めるときにだけ渡します。'));
    if (storage && !storage.encrypted) out.push(el('p', 'mp-note', 'この起動では暗号化できないため、キーは本人だけが読めるファイルに保存します（Pleiad デスクトップで開くと暗号化し直します）。'));
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
      message = r.ok ? `「${e.name}」につながりました。` : `「${e.name}」の確認に失敗しました: ${r.error}${r.lines?.length ? ' ' + r.lines.join(' ') : ''}`;
      await load(true); onChange();
    } catch (err) { message = err.message; }
    checking = ''; draw();
  }
  async function remove(e) {
    message = '';
    try { await cmd('compatEndpointDelete', { id: e.id }); confirming = ''; await load(true); onChange(); }
    catch (err) { message = `削除できませんでした: ${err.message}`; }
    draw();
  }

  // ---------------------------------------------------------------- 追加・編集（画面 3）
  function blankForm(presetId) {
    const p = presetOf(agent, presetId);
    return { id: '', preset: p.id, name: p.id === 'custom' ? '' : p.name, baseUrl: p.urls[0]?.value ?? '',
      authMode: agent === 'claude' ? (['bearer', 'x-api-key'].includes(p.auth) ? p.auth : 'auto') : (p.auth === 'api-key' ? 'api-key' : 'bearer'),
      key: '', show: false, hasKey: false, phase: 'edit', result: null, models: [], roles: { ...p.roles }, context: p.context ?? '',
      sendThinking: Boolean(p.thinking), saved: false, stale: false, error: '' };
  }
  function startForm(e) {
    confirming = ''; message = ''; view = 'form';
    if (!e) form = blankForm('custom' === agent ? 'custom' : PRESETS[agent][0].id);
    else form = { id: e.id, preset: e.preset, name: e.name, baseUrl: e.baseUrl, authMode: e.authMode, key: '', show: false, hasKey: e.hasKey,
      phase: 'edit', result: null, models: e.models ?? [], roles: { ...e.roles }, context: e.options?.contextTokens ? String(e.options.contextTokens) : '',
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
  function modelCombo(value, onCommit, label, placeholder = 'モデル ID') {
    const c = createCombo({ ariaLabel: label, placeholder, cls: 'mono', value, options: () => form.models.map(m => ({ value: m })), onCommit });
    c.root.querySelector('input').spellcheck = false;
    return c.root;
  }
  function drawForm() {
    const claude = agent === 'claude'; const P = presetOf(agent, form.preset); const editing = Boolean(form.id);
    const out = [];
    const head = el('div', 'mp-row');
    head.append(el('h3', null, editing ? `「${form.name || '接続先'}」を編集` : `${AGENT_NAME[agent]} の接続先を追加`), button('閉じる', backToList));
    head.firstChild.id = 'epTitle';
    out.push(head);
    const cur = form.saved ? 6 : form.phase === 'ok' ? 4 : form.phase === 'checking' || form.phase === 'fail' ? 3 : 2;
    const steps = el('div', 'mp-steps');
    STEPS.forEach((t, i) => steps.append(el('span', i + 1 < cur ? 'done' : i + 1 === cur ? 'cur' : '', (i + 1 < cur ? '✓ ' : `${i + 1}. `) + t)));
    out.push(steps);
    if (form.saved) {
      const r = el('div', 'mp-result');
      r.append(el('strong', null, `✓ 「${form.name}」を保存しました`), line('入力欄のモデルの面の「接続先」から選べます。既存の会話は、選ぶまで今の接続先のままです。'));
      out.push(r);
      const a = el('div', 'mp-actions');
      a.append(button('もう 1 件追加する', () => startForm(null)), button('一覧に戻る', backToList, 'btn btn-primary'));
      out.push(a);
      panel.replaceChildren(...out);
      return;
    }
    // ① 種類
    out.push(step(1, '接続先の種類'));
    const grid = el('div', 'mp-presets'); grid.setAttribute('role', 'group'); grid.setAttribute('aria-label', '接続先の種類');
    for (const p of PRESETS[agent]) {
      const b = el('button', 'mp-preset'); b.type = 'button'; b.setAttribute('aria-pressed', String(p.id === form.preset));
      b.append(el('span', null, p.name), el('small', null, p.hint));
      b.disabled = editing && p.id !== form.preset;
      b.onclick = () => { if (editing || p.id === form.preset) return; form = blankForm(p.id); draw(); };
      grid.append(b);
    }
    out.push(grid);
    out.push(el('p', 'mp-note', claude
      ? 'Anthropic 互換（/v1/messages）の接続先です。Claude 以外のモデルは Anthropic の保証外で、動きが不安定なことがあります。'
      : 'Responses API（/responses）に対応した接続先だけを並べています。DeepSeek・Kimi・Together AI など Chat Completions だけの接続先は Codex では使えません。LiteLLM で Responses に変換すると使えます。'));
    // ② 接続情報
    out.push(step(2, '接続情報'));
    const g = el('div', 'mp-grid');
    const name = el('input'); name.value = form.name; name.placeholder = '例: 仕事用の LiteLLM'; name.maxLength = 60; name.autocomplete = 'off';
    name.oninput = () => { form.name = name.value; };
    g.append(field('名前', name, el('small', null, '入力欄ではこの名前で出ます。')));
    const help = el('small', null, urlHelp(agent, form.baseUrl));
    const url = createCombo({ ariaLabel: 'URL', placeholder: claude ? 'https://example.com（/v1 は付けない）' : 'https://example.com/v1', cls: 'mono', value: form.baseUrl,
      options: () => urlCandidates(agent, form.preset),
      onCommit: v => { if (form.baseUrl !== v) { form.baseUrl = v; help.textContent = urlHelp(agent, v); if (form.phase === 'edit') draw(); else invalidate(); } } });
    url.root.querySelector('input').spellcheck = false;
    url.root.querySelector('input').addEventListener('input', e => { help.textContent = urlHelp(agent, e.target.value); });
    g.append(field('URL', url.root, help));
    out.push(g);
    const authField = el('div', 'mp-field');
    authField.append(el('span', null, '認証の送り方'));
    const seg = el('div', 'seg mp-seg'); seg.setAttribute('role', 'group'); seg.setAttribute('aria-label', '認証の送り方');
    for (const v of claude ? ['auto', 'bearer', 'x-api-key'] : ['bearer', 'api-key']) {
      const b = el('button', v === form.authMode ? 'on' : '', AUTH_LABEL[v]); b.type = 'button'; b.setAttribute('aria-pressed', String(v === form.authMode));
      b.onclick = () => { if (form.authMode === v) return; form.authMode = v; invalidate(); draw(); };
      seg.append(b);
    }
    authField.append(seg, el('small', null, claude
      ? '自動にすると、確認のときに Authorization: Bearer と x-api-key の両方で試して、通ったほうを使います。'
      : 'ほとんどの接続先は Bearer です。Azure OpenAI は api-key ヘッダーを使います。'));
    out.push(authField);
    const key = el('input'); key.type = form.show ? 'text' : 'password'; key.value = form.key; key.autocomplete = 'new-password'; key.spellcheck = false;
    key.placeholder = editing && form.hasKey ? '変更するときだけ入力（空なら保存済みのキー）' : P.nokey ? 'キーは不要です（空のままで構いません）' : 'API キー';
    key.oninput = () => { form.key = key.value; invalidate(); };
    const kr = el('div', 'mp-keyrow'); kr.append(key, button(form.show ? '隠す' : '表示', () => { form.show = !form.show; draw(); }));
    out.push(field('API キー', kr, el('small', null, 'この接続先に API キーと会話の内容を送ります。キーは OS の資格情報に保存し、保存後は表示しません。')));
    if (P.note) out.push(el('p', 'mp-note', P.note));
    // ③ 確認
    out.push(step(3, '接続を確認'));
    out.push(el('p', 'mp-note', claude
      ? `POST ${form.baseUrl || '<URL>'}/v1/messages を 1 回だけ送ります（出力 1 トークン。わずかに料金がかかることがあります）。あわせて GET /v1/models でモデルの一覧を取ります。`
      : `POST ${form.baseUrl || '<URL>'}/responses を 1 回だけ送ります（出力はごくわずか。わずかに料金がかかることがあります）。あわせて GET /models でモデルの一覧を取ります。`));
    if (form.stale && form.phase === 'edit') out.push(el('p', 'mp-note mp-warn', '接続情報を変えたので、もう一度確認してください。'));
    if (form.phase === 'checking') out.push(Object.assign(el('div', 'mp-result'), { textContent: '確認しています…' }));
    if (form.result) {
      const r = el('div', 'mp-result'); r.setAttribute('role', 'status');
      r.append(el('strong', form.result.ok ? '' : 'mp-warn', form.result.ok ? '✓ つながりました' : `✕ ${form.result.error}`));
      for (const l of form.result.lines ?? []) r.append(line(l));
      out.push(r);
    }
    // ④ モデル（確認が通ったあと。編集では保存済みの割り当てを最初から見せる）
    if (form.phase === 'ok' || editing) {
      out.push(step(4, claude ? 'モデルの割り当て' : 'モデル'));
      const n = form.models.length;
      if (claude) {
        out.push(el('p', 'mp-note', `Claude Code はモデルを役割で呼び分けます。${n ? `取れた ${n} 件から選ぶか、` : ''}ID を入力してください。空の役割があると、Claude のモデル名がそのまま送られて失敗します。`));
        const rg = el('div', 'mp-grid');
        for (const r of CLAUDE_ROLES) rg.append(field(r.label, modelCombo(form.roles[r.key] ?? '', v => { form.roles[r.key] = v; }, r.label), el('small', null, r.help)));
        out.push(rg);
        const d = el('details'); d.open = Boolean(form.context || form.sendThinking !== Boolean(P.thinking));
        d.append(el('summary', null, '詳しい設定'));
        const ctx = createCombo({ ariaLabel: 'コンテキスト長', placeholder: '空なら 200,000 として扱います', cls: 'mono', value: form.context,
          options: () => CONTEXT_CANDIDATES.map(([value, hint]) => ({ value, hint })), onCommit: v => { form.context = v; } });
        d.append(field('コンテキスト長（tokens）', ctx.root, el('small', null, '接続先のモデルの上限を入れると、長い会話の自動要約が正しい時点で始まります。')));
        const think = el('label', 'mp-check'); const cb = el('input'); cb.type = 'checkbox'; cb.checked = form.sendThinking;
        cb.onchange = () => { form.sendThinking = cb.checked; };
        think.append(cb, el('span', null, '思考を送る（thinking とエフォート）'));
        d.append(think, el('small', 'mp-note', '既定では送りません。Claude 以外のモデルでは受け付けられず失敗することがあるためです。思考が必須のモデル（Kimi の kimi-k2.7-code など）や、この接続先経由で Claude を使うときはオンにしてください。'));
        out.push(d);
      } else {
        const rg = el('div', 'mp-grid');
        const azure = form.preset === 'azure';
        rg.append(field(azure ? '既定のモデル（デプロイ名）' : '既定のモデル', modelCombo(form.roles.main ?? '', v => { form.roles.main = v; }, '既定のモデル', azure ? 'デプロイ名' : 'モデル ID'),
          el('small', null, `${n ? `取れた ${n} 件から選ぶか、` : ''}ID を入力してください。会話ごとに変えられます。`)));
        const ctx = createCombo({ ariaLabel: 'コンテキスト長', placeholder: '空なら Codex の既定（小さめ）', cls: 'mono', value: form.context,
          options: () => CONTEXT_CANDIDATES.map(([value, hint]) => ({ value, hint })), onCommit: v => { form.context = v; } });
        rg.append(field('コンテキスト長（tokens）', ctx.root, el('small', null, 'ローカルのモデルは起動時の設定（num_ctx など）に合わせてください。')));
        out.push(rg);
      }
    }
    const err = el('p', 'mp-state mp-warn', form.error); err.setAttribute('role', 'alert'); out.push(err);
    const a = el('div', 'mp-actions');
    a.append(button('やめる', backToList));
    if (form.phase === 'ok') a.append(button('もう一度確認', check), button('保存', save, 'btn btn-primary'));
    else { const c = button(form.phase === 'checking' ? '確認しています…' : '接続を確認', check, 'btn btn-primary'); c.disabled = form.phase === 'checking'; a.append(c); }
    out.push(a);
    panel.replaceChildren(...out);
  }
  async function check() {
    // フォーカス中の combo の値を確定させてから読む（blur で確定する）
    document.activeElement?.blur?.();
    form.error = '';
    if (!form.baseUrl.trim()) { form.error = 'URL を入力してください'; draw(); return; }
    form.phase = 'checking'; form.result = null; form.stale = false; draw();
    const mine = form;
    try {
      const r = await cmd('compatEndpointCheck', { input: input(), ...(form.id ? { id: form.id } : {}) });
      if (form !== mine) return;
      form.phase = r.ok ? 'ok' : 'fail';
      form.result = r;
      if (r.ok) { form.receipt = r.receipt; if (r.models?.length) form.models = r.models; }
    } catch (e) { if (form !== mine) return; form.phase = 'fail'; form.result = { ok: false, error: e.message, lines: [] }; }
    draw();
  }
  async function save() {
    document.activeElement?.blur?.();
    form.error = '';
    if (!form.name.trim()) { form.error = '名前を入力してください'; draw(); return; }
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
      openSettings(); agent = which; view = 'list'; form = null; confirming = ''; message = '読み込んでいます…';
      panel.hidden = false; onOpen(agent); drawList();
      try { await load(true); message = ''; if (add) startForm(null); else draw(); panel.scrollIntoView({ block: 'nearest' }); }
      catch (e) { message = e.message; draw(); }
    },
    /** どのエージェントの面が開いているか（設定の行のボタンの aria-expanded に使う） */
    onOpen(fn) { onOpen = fn; },
    get openAgent() { return panel.hidden ? '' : agent; },
  };
}
