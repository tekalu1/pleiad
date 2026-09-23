import { createCombo } from './combo.mjs';
import { validateLimits } from './procway-limits.mjs';
import { procwayTypeLabel as label } from './composer-labels.mjs';

// procway-code の接続先・モデル・容量・接続設定。
// 会話の接続先とモデルは入力欄のモデルのチップの面で選ぶ（web/composer-controls.mjs。view() が面に渡す値と口）。
// 接続設定（manager）と容量（budget の dialog）はここで組む。仕様は docs/procway-connections.md
export function setupProcway({ cmd, reserve, current, cwd, openSettings, refreshAuth, invalidateVocab, onChange = () => {} }) {
  const $ = id => document.getElementById(id);
  const manager = document.createElement('section'); manager.className = 'pw-panel'; manager.hidden = true;
  manager.innerHTML = `<div class="pw-row"><h3>procway-code の接続先</h3><button type="button" class="btn" id="pwCloseManager">閉じる</button></div>
  <div id="pwList"></div><button type="button" class="btn" id="pwAdd">＋ 接続先を追加</button>
  <p class="pw-note" id="pwNativeNote" hidden>procway-code 側の設定ファイルから読み込んだ接続先は、Pleiad では編集・削除できません。変更は procway-code で行ってください。</p>
  <p class="pw-note">既定の接続先は新しい会話に使います。既存の会話は選択中の接続先を維持します。</p>
  <form id="pwForm" hidden><h3 id="pwFormTitle">接続先を追加</h3>
  <fieldset><legend>接続方式</legend><div class="pw-row"><label><input type="radio" name="pwMode" value="api" checked> API</label><label><input type="radio" name="pwMode" value="login"> アカウントログイン</label></div></fieldset>
  <div id="pwApi"><fieldset><legend>サービス</legend><div class="pw-row"><label><input type="radio" name="pwService" value="openai" checked> OpenAI</label><label><input type="radio" name="pwService" value="anthropic"> Anthropic</label><label><input type="radio" name="pwService" value="custom"> 互換 API</label></div></fieldset>
  <div id="pwCustom" hidden><fieldset><legend>API 形式</legend><label><input type="radio" name="pwFormat" value="openai-compatible" checked> OpenAI 互換</label> <label><input type="radio" name="pwFormat" value="anthropic-compatible"> Anthropic 互換</label></fieldset><label class="pw-field"><span>ベース URL</span><input id="pwUrl" type="url" placeholder="https://api.example.com/v1"></label><p class="pw-note">指定した接続先に API キーと会話内容を送信します。</p></div>
  <fieldset><legend>API キーの指定方法</legend><label><input type="radio" name="pwCredential" value="key" checked id="pwKeyChoice"> 入力して保護保存</label> <label><input type="radio" name="pwCredential" value="env"> 環境変数を使う</label></fieldset>
  <label class="pw-field" id="pwKeyField"><span>API キー</span><div class="pw-row"><input id="pwKey" type="password" autocomplete="new-password"><button type="button" class="btn" id="pwReveal">表示</button></div><small id="pwKeyHint">Windows のユーザー資格情報で暗号化します。保存したキーは表示しません。</small></label>
  <label class="pw-field" id="pwEnvField" hidden><span>ホスト上の環境変数名</span><input id="pwEnv" placeholder="OPENAI_API_KEY"><small>ホストの起動時に設定された変数を参照します。</small></label>
  <p class="pw-note">API の利用料金はサービス側で発生し、アカウント契約とは別に管理されます。</p></div>
  <p id="pwLoginNote" class="pw-note" hidden>上の procway-code の「ChatGPT ログイン」で認証してください。既存のログイン情報を利用して接続先を登録します。</p>
  <label class="pw-field"><span>接続先の名前</span><input id="pwName" required maxlength="80" placeholder="仕事用、個人用など"></label>
  <div class="pw-field"><span>既定のモデル</span><div id="pwModelField"></div><small>モデル ID を入力してください。接続確認ではモデル一覧との一致を調べます。</small></div>
  <p class="pw-state" id="pwCheckState" role="status"></p><div class="pw-actions"><button type="button" class="btn" id="pwCancel">キャンセル</button><button type="submit" class="btn btn-primary" id="pwCheck">接続を確認する</button><button type="button" class="btn btn-primary" id="pwSave" hidden>接続先を保存</button></div></form><p id="pwManagerState" role="status" class="pw-state"></p>`;
  $('agentControls').append(manager);
  // editingId が空ならフォームは新規追加。editingSecret は「保存済みのキーがあるので空欄のままでよい」の意味
  let config = null, configCwd = null, receipt = null, checked = null, checkedId = '', version = 0, selectedId = '', selectedModel = '', saving = false, editingId = '', editingSecret = false;
  // 面に出す読み込み中の印と、モデルの欄の下に出す一文（選び直しを促すもの）
  let loading = false, modelError = '';
  const getCwd = () => current()?.nextSettings?.cwd || current()?.cwd || cwd?.() || undefined;
  const modelInput = createCombo({ ariaLabel: '接続先の既定モデル', options: () => [], onCommit: () => dirty() });
  $('pwModelField').append(modelInput.root);
  const selected = () => config?.connections.find(c => c.id === selectedId) ?? null;
  /** 選んだ接続先・モデルを次の送信に予約する。失敗したら理由を返す（面のモデルの欄の下にも出す） */
  async function changeSelection() {
    try {
      if (!selectedModel && selected()?.type !== 'cli-agent') throw new Error('モデル ID を入力してください');
      modelError = '';
      await reserve({ model: selectedId + (selectedModel ? '/' + selectedModel : '') });
      return '';
    } catch (e) { showError(e); modelError = e.message; onChange(); return e.message; }
  }
  /**
   * 入力欄のモデルのチップの面に渡す値と口（web/composer-controls.mjs の procwaySection / procwayFooter）。
   * connections: 接続先（接続方式の説明と既定の印）、models: 選んでいる接続先のモデルの候補
   */
  function view() {
    const c = selected();
    return {
      loading, modelError,
      connections: config ? config.connections.map(x => ({ id: x.id, name: x.name, hint: [label(x.type), x.model].filter(Boolean).join(' · '), isDefault: x.id === config.defaultId })) : null,
      selectedId, selectedModel, connectionName: c?.name || selectedId, connectionModel: c?.model || '',
      cliAgent: c?.type === 'cli-agent',
      models: [...new Set([c?.model, ...(c?.models || [])])].filter(Boolean),
      canBudget: Boolean(current()) && c?.supported !== false && c?.type !== 'cli-agent',
      budgetNote: !current() ? '先に会話を作成してください' : c?.type === 'cli-agent' ? 'CLI 接続の容量設定には対応していません' : c?.supported === false ? 'この接続先の容量設定には対応していません' : '',
      pickConnection: async id => { selectedId = id; selectedModel = config.connections.find(c => c.id === id)?.model || ''; modelError = ''; onChange(); await changeSelection(); },
      commitModel: async model => { selectedModel = model; onChange(); return changeSelection(); },
      openBudget: () => openBudget().catch(showError),
      openManager: () => open(),
    };
  }
  function showError(e) { $('settingsError').textContent = e.message; }
  async function load(force = false) {
    const cwd = getCwd();
    if (!config || configCwd !== cwd || force) { config = await cmd('procwayConnections', { cwd }); configCwd = cwd; }
    return config;
  }
  async function sync(backend) {
    const tick = ++version;
    if (backend !== 'procway') return;
    loading = true;
    try {
      const c = await load(); if (tick !== version) return;
      const session = current(); const value = session?.nextSettings?.model ?? session?.model ?? '';
      const parts = value.split('/'); selectedId = parts[0] || c.defaultId;
      selectedModel = parts.slice(1).join('/') || c.connections.find(c => c.id === selectedId)?.model || '';
      modelError = '';
      // 選んでいた接続先が消えている（別の画面で削除された）。黙って別の接続先へ寄せず、選び直しを促す
      if (selectedId && !c.connections.some(x => x.id === selectedId)) showError(new Error('選択中の接続先が見つかりません。接続設定から選び直してください'));
    } catch (e) { showError(e); }
    finally { if (tick === version) { loading = false; onChange(); } }
  }
  function dirty() { if (saving) return; receipt = null; checked = null; $('pwSave').hidden = true; $('pwCheck').hidden = false; $('pwCheckState').textContent = ''; }
  function radio(name) { return manager.querySelector(`[name=${name}]:checked`)?.value; }
  function fields() {
    dirty(); const api = radio('pwMode') === 'api', custom = radio('pwService') === 'custom', key = radio('pwCredential') === 'key';
    $('pwApi').hidden = !api; $('pwLoginNote').hidden = api; $('pwCustom').hidden = !custom;
    $('pwKeyField').hidden = !key; $('pwEnvField').hidden = key;
    $('pwUrl').required = api && custom; $('pwUrl').disabled = !api || !custom;
    $('pwKey').required = api && key && !editingSecret; $('pwKey').disabled = !api || !key;
    $('pwEnv').required = api && !key; $('pwEnv').disabled = !api || key;
    $('pwKeyChoice').disabled = !(config?.canStoreKey ?? true) && !editingSecret;
    $('pwKeyHint').textContent = editingSecret
      ? '変更するときだけ入力してください。空のままなら保存済みのキーを使います。'
      : 'Windows のユーザー資格情報で暗号化します。保存したキーは表示しません。';
  }
  /** フォームを新規追加の状態に戻す。 */
  function resetForm() {
    editingId = ''; editingSecret = false;
    $('pwFormTitle').textContent = '接続先を追加'; $('pwSave').textContent = '接続先を保存';
    $('pwName').value = ''; $('pwUrl').value = ''; $('pwKey').value = ''; $('pwEnv').value = '';
    $('pwKey').type = 'password'; $('pwReveal').textContent = '表示';
    modelInput.set('');
    manager.querySelector('[name=pwMode][value=api]').checked = true;
    manager.querySelector('[name=pwService][value=openai]').checked = true;
    manager.querySelector('[name=pwFormat][value=openai-compatible]').checked = true;
    manager.querySelector(`[name=pwCredential][value=${config?.canStoreKey === false ? 'env' : 'key'}]`).checked = true;
    fields();
  }
  /** 既存の接続先の値をフォームへ流し込む。保存済みのキーは持ってこない（画面に出さない）。 */
  function fillForm(c) {
    editingId = c.id; editingSecret = !!c.hasSecret;
    $('pwFormTitle').textContent = '接続先を編集'; $('pwSave').textContent = '変更を保存';
    const login = c.type === 'openai-codex';
    manager.querySelector(`[name=pwMode][value=${login ? 'login' : 'api'}]`).checked = true;
    const service = login ? 'openai' : c.type === 'openai' || c.type === 'anthropic' ? c.type : 'custom';
    manager.querySelector(`[name=pwService][value=${service}]`).checked = true;
    if (service === 'custom') manager.querySelector(`[name=pwFormat][value=${c.type}]`).checked = true;
    $('pwUrl').value = service === 'custom' ? c.baseUrl || '' : '';
    manager.querySelector(`[name=pwCredential][value=${!editingSecret && c.apiKeyEnv ? 'env' : 'key'}]`).checked = true;
    $('pwEnv').value = c.apiKeyEnv || ''; $('pwKey').value = ''; $('pwKey').type = 'password'; $('pwReveal').textContent = '表示';
    $('pwName').value = c.name; modelInput.set(c.model || '');
    fields();
  }
  function input() { return { name: $('pwName').value, type: radio('pwMode') === 'login' ? 'openai-codex' : radio('pwService') === 'custom' ? radio('pwFormat') : radio('pwService'), model: modelInput.value, baseUrl: $('pwUrl').value, apiKey: radio('pwMode') === 'api' && radio('pwCredential') === 'key' ? $('pwKey').value : '', apiKeyEnv: radio('pwMode') === 'api' && radio('pwCredential') === 'env' ? $('pwEnv').value : '' }; }
  function button(text, cls, onclick) { const b = document.createElement('button'); b.type = 'button'; b.className = cls; b.textContent = text; b.onclick = onclick; return b; }
  function drawList() {
    $('pwList').replaceChildren(...config.connections.map(c => {
      const card = document.createElement('div'); card.className = 'pw-card';
      const top = document.createElement('div'); top.className = 'pw-row';
      const info = document.createElement('div'), name = document.createElement('strong'), note = document.createElement('small');
      info.className = 'pw-card-info';
      name.textContent = c.name + (c.id === config.defaultId ? ' · 新しい会話の既定' : '');
      note.textContent = [label(c.type), c.model, c.credential, c.source].filter(Boolean).join(' · ');
      info.append(name, note);
      const actions = document.createElement('div'); actions.className = 'pw-card-actions';
      top.append(info, actions); card.append(top);
      if (c.id !== config.defaultId) {
        // currentTarget は待っている間に null になる。押したボタンは変数で持つ
        const promote = button('既定にする', 'btn', async () => {
          promote.disabled = true;
          try { await cmd('procwayDefault', { id: c.id, cwd: getCwd() }); await load(true); drawList(); }
          catch (err) { $('pwManagerState').textContent = err.message; promote.disabled = false; }
        });
        actions.append(promote);
      }
      if (!c.managed) return card;  // 由来と変更できない理由は一覧の下に一度だけ出す
      const edit = button('編集', 'btn' + (editingId === c.id ? ' on' : ''), () => {
        $('pwManagerState').textContent = ''; $('pwForm').hidden = false; fillForm(c); drawList(); $('pwName').focus(); $('pwForm').scrollIntoView({ block: 'nearest' });
      });
      // 削除は取り消せないので、カードの中で一度たずねる
      const confirm = document.createElement('div'); confirm.className = 'pw-confirm'; confirm.hidden = true;
      const ask = document.createElement('p'); ask.textContent = 'この接続先を削除します。保存したキーと容量の設定も消えます。';
      const confirmActions = document.createElement('div'); confirmActions.className = 'pw-card-actions';
      const stop = button('やめる', 'btn', () => { confirm.hidden = true; actions.hidden = false; remove.focus(); });
      const commit = button('削除する', 'btn btn-quiet', async () => {
        stop.disabled = commit.disabled = true; $('pwManagerState').textContent = '接続先を削除しています…';
        try {
          await cmd('procwayDelete', { id: c.id, cwd: getCwd() });
          if (editingId === c.id) { $('pwForm').hidden = true; resetForm(); }
          await load(true); drawList(); invalidateVocab(); await refreshAuth();
          $('pwManagerState').textContent = '接続先を削除しました。';
          if (selectedId === c.id) await fallbackSelection();
        } catch (err) { $('pwManagerState').textContent = err.message; stop.disabled = commit.disabled = false; }
      });
      confirmActions.append(stop, commit); confirm.append(ask, confirmActions); card.append(confirm);
      const remove = button('削除', 'btn', () => { $('pwManagerState').textContent = ''; actions.hidden = true; confirm.hidden = false; commit.focus(); });
      actions.append(edit, remove);
      return card;
    }));
    $('pwNativeNote').hidden = config.connections.every(c => c.managed);
  }
  /** 選んでいた接続先が消えたとき、既定へ寄せて次の送信に予約し直す。 */
  async function fallbackSelection() {
    selectedId = config.defaultId || config.connections[0]?.id || '';
    selectedModel = config.connections.find(c => c.id === selectedId)?.model || '';
    onChange();
    $('pwManagerState').textContent = '接続先を削除しました。この会話は既定の接続先に切り替えました。';
    if (current() && selectedId) await changeSelection();
  }
  async function open() {
    openSettings(); manager.hidden = false; $('pwManagerState').textContent = '接続設定を読み込んでいます…';
    try { await load(true); $('pwForm').hidden = true; resetForm(); drawList(); $('pwManagerState').textContent = ''; manager.scrollIntoView({ block: 'nearest' }); }
    catch (e) { $('pwManagerState').textContent = e.message; }
  }
  $('pwCloseManager').onclick = () => { manager.hidden = true; $('pwForm').hidden = true; resetForm(); if (config) drawList(); };
  $('pwAdd').onclick = () => { $('pwManagerState').textContent = ''; $('pwForm').hidden = false; resetForm(); if (config) drawList(); $('pwName').focus(); };
  $('pwCancel').onclick = () => { $('pwForm').hidden = true; resetForm(); if (config) drawList(); };
  manager.querySelectorAll('input[type=radio]').forEach(i => i.onchange = fields);
  $('pwForm').addEventListener('input', dirty);
  $('pwReveal').onclick = () => { const show = $('pwKey').type === 'password'; $('pwKey').type = show ? 'text' : 'password'; $('pwReveal').textContent = show ? '非表示' : '表示'; };
  $('pwForm').onsubmit = async e => {
    e.preventDefault(); if (saving) return;
    const v = input(), id = editingId; dirty(); saving = true; $('pwCheck').disabled = true; $('pwCheckState').textContent = '接続を確認しています…';
    try {
      const result = await cmd('procwayCheck', { connection: v, cwd: getCwd(), id: id || undefined });
      if (JSON.stringify(input()) !== JSON.stringify(v) || editingId !== id) throw new Error('確認中に設定が変わりました。もう一度確認してください');
      receipt = result.receipt; checked = v; checkedId = id; $('pwCheckState').textContent = result.note; $('pwCheck').hidden = true; $('pwSave').hidden = false;
    } catch (e) { $('pwCheckState').textContent = e.message; }
    finally { saving = false; $('pwCheck').disabled = false; }
  };
  $('pwSave').onclick = async () => {
    if (!receipt || !checked || saving) return; saving = true; $('pwSave').disabled = true;
    const editing = !!checkedId;
    try { await cmd('procwaySave', { connection: checked, receipt, id: checkedId || undefined }); $('pwForm').hidden = true; resetForm(); config = null; await load(); drawList(); invalidateVocab(); await refreshAuth(); $('pwManagerState').textContent = editing ? '接続先を変更しました。' : '接続先を保存しました。会話で選択できます。'; }
    catch (e) { $('pwCheckState').textContent = e.message; }
    finally { saving = false; $('pwSave').disabled = false; receipt = null; checked = null; checkedId = ''; $('pwSave').hidden = true; $('pwCheck').hidden = false; }
  };

  const dialog = document.createElement('dialog'); dialog.className = 'pw-budget-dialog'; dialog.setAttribute('aria-labelledby', 'pwBudgetTitle');
  dialog.innerHTML = `<section class="pw-panel"><div class="pw-row"><h3 id="pwBudgetTitle">コンテキストと出力</h3><button type="button" class="btn" id="pwCloseBudget">閉じる</button></div><p id="pwBudgetTarget"></p>
  <p class="pw-note">モデルの対応上限は未確認です。接続先の対応範囲内で指定してください。入力予算は指示・ツール定義・結果を含む推定量で判定します。実際の上限はサービス側が判定します。</p>
  <form id="pwBudgetForm"><fieldset><legend>適用先</legend><label><input name="pwScope" type="radio" value="conversation" checked> この会話（次の送信から）</label> <label><input name="pwScope" type="radio" value="model"> この接続先・モデルの既定</label></fieldset>
  <div class="pw-grid"><label class="pw-field"><span>最大コンテキスト長（tokens）</span><input type="number" id="pwContext" min="1" step="1" placeholder="未指定"><small>空欄はホスト側の制限なし。</small></label><label class="pw-field"><span id="pwOutputLabel">最大出力（tokens）</span><input type="number" id="pwOutput" min="1" step="1" placeholder="接続先の既定"><small id="pwOutputNote">入力と出力を合わせた予算に使います。</small></label></div>
  <p id="pwBudgetSummary" class="pw-note"></p><fieldset><legend>自動要約</legend><label><input id="pwCompact" type="checkbox"> 入力が基準を超えたら要約する</label></fieldset>
  <div class="pw-grid" id="pwCompactFields"><label class="pw-field"><span>要約開始（入力 tokens）</span><input type="number" id="pwThreshold" min="1" step="1"><button type="button" class="btn" id="pwThresholdAuto">入力予算の 80% にする</button></label><label class="pw-field"><span>そのまま残す直近のメッセージ数</span><input type="number" id="pwKeep" min="1" step="1"></label></div>
  <p class="pw-note">要約にはモデル利用が発生する場合があります。上限を増やしても、すでに要約された内容は復元されません。</p>
  <details><summary>ツール結果の保持</summary><label class="pw-field"><input type="checkbox" id="pwCondense"> 古い大きなツール結果を短縮する</label><div class="pw-grid" id="pwToolFields"><label class="pw-field"><span>そのまま残す直近のツール結果数</span><input type="number" id="pwRecent" min="1" step="1"></label><label class="pw-field"><span>短縮対象の文字数</span><input type="number" id="pwChars" min="1" step="1"></label></div><p class="pw-note">オフでは入力消費が増えます。保存済みの履歴は変更しません。</p></details>
  <p id="pwBudgetState" class="pw-state" role="status"></p><div class="pw-actions"><button type="button" class="btn" id="pwCancelBudget">キャンセル</button><button type="submit" class="btn btn-primary" id="pwSaveBudget">次の送信に予約</button></div></form></section>`;
  document.body.append(dialog);
  let budgetModel = '', budgetSession = '', conversationLimits = null;
  const budgetInputs = { context: 'pwContext', output: 'pwOutput', threshold: 'pwThreshold', keep: 'pwKeep', recent: 'pwRecent', chars: 'pwChars' };
  function readBudget() { const values = Object.fromEntries(Object.entries(budgetInputs).map(([k,id]) => [k, $(id).value === '' ? null : Number($(id).value)])); return { ...values, compact: $('pwCompact').checked, condense: $('pwCondense').checked }; }
  function fillBudget(limits) { for (const [k,id] of Object.entries(budgetInputs)) $(id).value = limits?.[k] ?? ''; $('pwCompact').checked = limits?.compact === true; $('pwCondense').checked = limits?.condense === true; preview(); }
  function preview() { const b = readBudget(); $('pwCompactFields').hidden = !b.compact; $('pwToolFields').hidden = !b.condense; $('pwBudgetSummary').textContent = b.context && b.output ? '入力に使える予算：約 ' + Math.max(0, b.context - b.output).toLocaleString() + ' tokens' : 'コンテキスト長を指定する場合は出力予約も指定してください。'; }
  async function openBudget() {
    const session = current(); if (!session) throw new Error('先に会話を作成してください');
    const model = selectedId + (selectedModel ? '/' + selectedModel : '');
    const result = await cmd('procwaySettings', { sessionId: session.id, model, cwd: getCwd() });
    if (current()?.id !== session.id) return;
    budgetModel = result.model; budgetSession = session.id; conversationLimits = result.limits;
    $('pwBudgetTarget').textContent = (config?.connections.find(c => c.id === selectedId)?.name || selectedId) + ' / ' + selectedModel;
    const codex = result.type.includes('codex'); $('pwOutputLabel').textContent = codex ? '入力計算に予約する出力（tokens）' : '最大出力（tokens）';
    $('pwOutputNote').textContent = codex ? 'ChatGPT ログインでは出力上限の指定が未対応です。この値は入力予算の予約だけに使います。' : '1 回のモデル応答の出力上限です。';
    dialog.querySelector('[name=pwScope][value=conversation]').checked = true; $('pwSaveBudget').textContent = '次の送信に予約'; fillBudget(result.limits); $('pwBudgetState').textContent = ''; dialog.showModal();
  }
  $('pwBudgetForm').addEventListener('input', () => { preview(); $('pwBudgetState').textContent = ''; });
  $('pwThresholdAuto').onclick = () => { const b = readBudget(); if (!b.context || !b.output || b.output >= b.context) { $('pwBudgetState').textContent = '先にコンテキスト長と出力予約を指定してください'; return; } $('pwThreshold').value = Math.floor((b.context - b.output) * .8); };
  dialog.querySelectorAll('[name=pwScope]').forEach(r => r.onchange = async () => { const scope = r.value; $('pwSaveBudget').textContent = scope === 'model' ? 'モデルの既定を保存' : '次の送信に予約'; try { await load(true); fillBudget(scope === 'model' ? config.defaults[budgetModel] || conversationLimits : conversationLimits); } catch(e) { $('pwBudgetState').textContent = e.message; } });
  $('pwCloseBudget').onclick = $('pwCancelBudget').onclick = () => dialog.close();
  // 容量は入力欄のモデルのチップの面から開く。閉じたらチップへ戻る
  dialog.addEventListener('close', () => $('modelChip')?.focus());
  $('pwBudgetForm').onsubmit = async e => {
    e.preventDefault(); $('pwSaveBudget').disabled = true;
    try {
      const limits = validateLimits(readBudget()), modelScope = dialog.querySelector('[name=pwScope]:checked').value === 'model';
      if (modelScope) { await cmd('procwayModelLimits', { model: budgetModel, limits, cwd: getCwd() }); config = null; $('pwBudgetState').textContent = '既定を保存しました。現在の会話は変更していません。'; }
      else { if (current()?.id !== budgetSession) throw new Error('会話が変わりました。設定を開き直してください'); await reserve({ model: budgetModel, procwayLimits: limits }); dialog.close(); }
    } catch (e) { $('pwBudgetState').textContent = e.message; }
    finally { $('pwSaveBudget').disabled = false; }
  };
  fields();
  return { open, sync, view, invalidate: () => { config = null; } };
}
