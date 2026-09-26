// 設定 › 委譲（委譲先の自動振り分け。docs/design-system.md「設定 › 委譲」、docs/agent-delegation.md「委譲先の自動振り分け」）。
//
// - 先頭のスイッチ「委譲先を自動で選ぶ」
// - 「難しさの判定」: 種類ごとの判定器（Jev / Cerebras / 判定しない）の表と「Jev が迷ったら Cerebras に聞き直す」
// - 「判定器のキー」: OpenRouter（Jev）と Cerebras。登録・変更・削除。キーは返ってこない（hasKey だけ）。送る内容の 1 行
// - 「詳しい設定」（details）: 段ごとの候補（並べ替え・追加・外す、各候補の今の使用量と使えるかどうか）・種類 × 難しさの表・使用量の方針
// - 末尾の「既定に戻す」（その場の確認。キーは残る）
//
// 状態はサーバーが持つ（delegationRouting コマンドと、変わるたびに届く delegationRoutingChanged イベント）。
// 変えたらすぐ setDelegationRouting で保存する（保存ボタンは置かない）。既定と同じ項目は送らない（既定値を凍らせない）。
// 面と部品は設定の管理の面（web/manage-panel.css の .mp-*）・コンテキストのスイッチ（.cx-sw）・区切りボタン（.seg）・
// 使用量の行（web/usage.css の .usage-rows）・表（.table-wrap）を使う。
import { el } from './dom.mjs';
import { t, fmt } from './i18n.mjs';
import { kindText, difficultyText, tierText, tierShortText, judgeText, skipText, usageSummary, splitCandidate } from './delegation-routing-view.mjs';

const SERVICES = ['openrouter', 'cerebras'];
const SERVICE_JUDGE = { openrouter: 'jev', cerebras: 'cerebras' };
const DIFFICULTIES = ['low', 'mid', 'high'];
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** 既定と違う項目だけの形（judgeByKind・tiers・table は中の項目ごと）。全部既定なら null */
export function diffFromDefaults(value, defaults) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const out = Object.fromEntries(Object.entries(value).filter(([k, v]) => !same(v, defaults?.[k])));
    return Object.keys(out).length ? out : null;
  }
  return same(value, defaults) ? null : value;
}

function button(text, onclick, className = 'btn') {
  const b = el('button', className, text);
  b.type = 'button';
  b.onclick = onclick;
  return b;
}

/**
 * @param cmd        WS コマンド
 * @param page       設定のページを切り替える（onboarding.page）
 * @param showMenu   右クリックのメニュー（x, y, items, title）
 * @param labelOf    エージェントの名前
 * @param logo       エージェントのロゴ（backend -> 要素）
 * @param modelsOf   そのエージェントのモデルの一覧（backend -> Promise<{ [id]: { label } }>）
 * @param modelName  モデルの表示名（backend, model -> 文字）
 */
export function setupDelegationSettings({ cmd, page, showMenu, labelOf, logo, modelsOf, modelName }) {
  const $ = id => document.getElementById(id);
  const root = $('delegationPanel');
  let data = null, busy = false, message = '', editingKey = '', confirmingKey = '', confirmingReset = false, refreshing = false;
  // 判定器の面で押した部品（`${kind}:${judge}` か 'escalate'）。保存中は押せないので、保存が終わって描き直したときにフォーカスを戻す
  let judgeFocus = '';
  const names = { backend: id => labelOf(id), model: (backend, model) => modelName(backend, model) || model };

  // ---- 骨組み
  const sw = button('', () => save({ enabled: !data?.settings.enabled }), 'cx-sw');
  sw.id = 'routingEnable';
  sw.setAttribute('role', 'switch');
  sw.setAttribute('aria-label', t('routing.settings.enable'));
  const swLabel = el('label', 'rm-switch-label', t('routing.settings.enable'));
  swLabel.htmlFor = 'routingEnable';
  const head = el('div', 'rm-switch');
  head.append(swLabel, sw);
  const stateLine = el('p', 'rm-state rm-strong');
  stateLine.setAttribute('role', 'status');
  stateLine.setAttribute('aria-live', 'polite');
  // 自動で選ぶのに効いていない理由（判定器のキーが無い・使える候補が無い）。スイッチの直下に、問題があるときだけ ⚠ と直す入口
  const effective = el('div', 'rt-eff');
  effective.setAttribute('role', 'status');

  const judges = el('section', 'mp-panel rt-judges');
  const keys = el('section', 'mp-panel rt-keys');
  const advanced = el('details', 'mp-panel rt-advanced');
  const summary = el('summary', null, t('routing.settings.advanced'));
  const advancedBody = el('div');
  advanced.append(summary, advancedBody);
  const reset = el('div', 'rt-reset');
  root.append(head, stateLine, effective, judges, keys, advanced, reset);

  async function refresh(args = {}) {
    try { data = await cmd('delegationRouting', args); message = ''; }
    catch (e) { message = t('routing.settings.loadFailed', { error: e.message }); }
    // 候補の名前は語彙から。まだ読んでいないエージェントの分を読んでから描く
    await Promise.all([...new Set((data?.candidates ?? []).map(c => c.backend).filter(Boolean))].map(b => modelsOf(b).catch(() => null)));
    paint();
  }
  async function save(patch) {
    if (busy || !data) return;
    busy = true; message = '';
    paint();
    try { data = await cmd('setDelegationRouting', { settings: patch }); }
    catch (e) { message = t('routing.settings.saveFailed', { error: e.message }); }
    finally { busy = false; paint(); }
  }
  /** 入れ子の設定（judgeByKind・tiers・table）を変えたとき。既定と同じ項目は送らず、全部既定なら null で既定に戻す */
  const saveNested = (key, value) => save({ [key]: diffFromDefaults(value, data.defaults[key]) });

  // ---- 描く
  function paint() {
    const s = data?.settings;
    sw.setAttribute('aria-checked', String(Boolean(s?.enabled)));
    sw.disabled = busy || !s;
    stateLine.textContent = message;
    stateLine.hidden = !message;
    paintEffective();
    if (!s) { for (const p of [judges, keys, advanced, reset]) p.hidden = true; return; }
    for (const p of [judges, keys, advanced, reset]) p.hidden = false;
    // 入力の途中（欄にフォーカス）で描き直すと打った値が消えるので、そのときは面ごとに飛ばす。
    // 判定器の面には打つ欄が無いので常に描き直す（押したボタンにフォーカスが残り、選び直しが画面に出なかった）
    paintJudges();
    if (!keys.contains(document.activeElement) || !editingKey) paintKeys();
    if (!advancedBody.contains(document.activeElement) || !document.activeElement.matches('input')) paintAdvanced();
    paintReset();
  }

  function paintJudges() {
    const s = data.settings;
    // 部品を作り直すので、フォーカスがあった部品（保存中なら押した部品）へ戻す
    const active = document.activeElement;
    const focusKey = judgeFocus || (active && judges.contains(active) ? active.dataset?.focusKey ?? '' : '');
    const controls = new Map();
    const out = [el('h3', null, t('routing.settings.judgeTitle'))];
    const list = el('div', 'rt-judge-list');
    for (const kind of data.kinds) {
      const row = el('div', 'rt-judge-row');
      row.append(el('span', 'rt-judge-kind', kindText(kind)));
      const seg = el('div', 'seg sec rt-seg');
      seg.setAttribute('role', 'group');
      seg.setAttribute('aria-label', t('routing.settings.judgeLabel', { kind: kindText(kind) }));
      for (const judge of data.judges) {
        const key = `${kind}:${judge}`;
        const b = button(judgeText(judge), () => {
          if (s.judgeByKind[kind] === judge) return;
          judgeFocus = key;
          saveNested('judgeByKind', { ...s.judgeByKind, [kind]: judge });
        }, '');
        b.classList.toggle('on', s.judgeByKind[kind] === judge);
        b.setAttribute('aria-pressed', String(s.judgeByKind[kind] === judge));
        b.disabled = busy;
        b.dataset.focusKey = key;
        controls.set(key, b);
        seg.append(b);
      }
      row.append(seg);
      list.append(row);
    }
    out.push(list);
    const check = el('label', 'mp-check');
    const box = el('input');
    box.type = 'checkbox';
    box.checked = s.escalateToCerebras;
    box.disabled = busy;
    box.onchange = () => { judgeFocus = 'escalate'; save({ escalateToCerebras: box.checked }); };
    box.dataset.focusKey = 'escalate';
    controls.set('escalate', box);
    check.append(box, el('span', null, t('routing.settings.escalate')));
    out.push(check);
    judges.replaceChildren(...out);
    // 保存中は押せない（disabled にはフォーカスが乗らない）ので、押せるようになった次の描き直しまで持ち越す
    const target = controls.get(focusKey);
    if (target?.disabled) judgeFocus = focusKey;
    else { judgeFocus = ''; target?.focus(); }
  }
  // i18n-dynamic: routing.settings.service.

  /**
   * スイッチの直下の「効いていない理由」。オンのときだけ、選んでいる判定器のキーが無い・使える候補が無い、を 1 行ずつ。
   * 右に直す入口（キーの登録の欄を開く・詳しい設定の候補へ）。平常時・オフのときは何も出さない（docs/design-system.md「設定 › 委譲」）
   */
  function paintEffective() {
    const s = data?.settings;
    const lines = [];
    if (s?.enabled) {
      for (const service of SERVICES) {
        const judge = SERVICE_JUDGE[service];
        if (data.keys[service]?.hasKey || !Object.values(s.judgeByKind).includes(judge)) continue;
        lines.push(effLine(t('routing.settings.effective.noKey', { service: t(`routing.settings.service.${service}`), judge: judgeText(judge) }),
          t('routing.settings.effective.addKey'), () => goKey(service)));
      }
      if (!data.candidates.some(c => c.usable))
        lines.push(effLine(t('routing.settings.effective.noCandidates'), t('routing.settings.effective.viewCandidates'), goCandidates));
    }
    effective.replaceChildren(...lines);
    effective.hidden = !lines.length;
  }
  function effLine(text, action, onClick) {
    const p = el('p', null, `⚠ ${text}`);
    p.append(button(action, onClick, 'btn link'));
    return p;
  }
  /** 判定器のキーのカードへ移り、登録の欄を開いてフォーカス */
  function goKey(service) {
    editingKey = service; confirmingKey = '';
    paintKeys();
    keys.scrollIntoView({ block: 'start', behavior: 'smooth' });
    keys.querySelector('.rt-key-form input')?.focus({ preventScroll: true });
  }
  /** 「詳しい設定」を開いて段ごとの候補へ */
  function goCandidates() {
    advanced.open = true;
    advanced.scrollIntoView({ block: 'start', behavior: 'smooth' });
    summary.focus({ preventScroll: true });
  }

  function paintKeys() {
    const out = [el('h3', null, t('routing.settings.keysTitle'))];
    for (const service of SERVICES) {
      const has = data.keys[service]?.hasKey;
      const name = t(`routing.settings.service.${service}`);
      const card = el('div', 'mp-card rt-key');
      const row = el('div', 'mp-row');
      const info = el('div', 'mp-card-info');
      info.append(el('strong', null, name), el('small', null, has ? t('routing.settings.keySaved') : t('routing.settings.keyNone')));
      const actions = el('div', 'mp-card-actions');
      actions.append(button(has ? t('routing.settings.keyChange') : t('routing.settings.keyAdd'), () => { editingKey = service; confirmingKey = ''; paintKeys(); keys.querySelector('.rt-key-form input')?.focus(); }));
      if (has) actions.append(button(t('routing.settings.keyDelete'), () => { confirmingKey = service; editingKey = ''; paintKeys(); }));
      actions.hidden = editingKey === service || confirmingKey === service;
      row.append(info, actions);
      card.append(row);
      if (editingKey === service) card.append(keyForm(service, name));
      if (confirmingKey === service) {
        const ask = el('div', 'mp-confirm');
        ask.append(el('p', null, t('routing.settings.keyDeleteConfirm', { service: name })));
        const buttons = el('div', 'mp-card-actions');
        buttons.append(button(t('routing.settings.keyCancel'), () => { confirmingKey = ''; paintKeys(); }),
          button(t('routing.settings.keyDelete'), () => keyCommand('deleteDelegationRoutingKey', { service })));
        ask.append(buttons);
        card.append(ask);
      }
      out.push(card);
    }
    // 外部送信の同意はキーの登録（知らないと事故になるので 1 行だけ）。暗号化できない起動のときだけ ⚠
    out.push(el('p', 'mp-note', t('routing.settings.keySend')));
    if (data.storage?.encrypted === false) out.push(el('p', 'mp-warn', `⚠ ${t('routing.settings.notEncrypted')}`));
    keys.replaceChildren(...out);
  }
  function keyForm(service, name) {
    const form = el('form', 'rt-key-form');
    const row = el('div', 'mp-keyrow');
    const input = el('input');
    input.type = 'password'; input.autocomplete = 'off'; input.spellcheck = false;
    input.setAttribute('aria-label', t('routing.settings.keyInput', { service: name }));
    const show = button(t('routing.settings.keyShow'), () => {
      input.type = input.type === 'password' ? 'text' : 'password';
      show.textContent = input.type === 'password' ? t('routing.settings.keyShow') : t('routing.settings.keyHide');
    });
    row.append(input, show);
    const actions = el('div', 'mp-card-actions');
    const submit = el('button', 'btn btn-primary', t('routing.settings.keySave'));
    submit.type = 'submit';
    actions.append(button(t('routing.settings.keyCancel'), () => { editingKey = ''; paintKeys(); }), submit);
    form.append(row, actions);
    form.onsubmit = e => { e.preventDefault(); if (input.value.trim()) keyCommand('setDelegationRoutingKey', { service, key: input.value.trim() }); };
    return form;
  }
  async function keyCommand(command, args) {
    busy = true; message = '';
    try { data = await cmd(command, args); editingKey = ''; confirmingKey = ''; }
    catch (e) { message = t('routing.settings.saveFailed', { error: e.message }); }
    finally { busy = false; paint(); }
  }

  // ---- 詳しい設定
  function paintAdvanced() {
    const s = data.settings;
    const out = [];
    // 段ごとの候補
    const tiersHead = el('div', 'rt-sub-head');
    tiersHead.append(el('h3', null, t('routing.settings.tiersTitle')), el('small', null, t('routing.settings.tiersOrder')));
    out.push(tiersHead);
    const at = data.candidates.map(c => c.checkedAt).filter(Boolean).sort()[0];
    const usageLine = el('div', 'rt-usage-at');
    usageLine.append(el('small', null, at ? t('routing.settings.usageAt', { time: fmt.time(at, { hour: '2-digit', minute: '2-digit', second: '2-digit' }) }) : t('routing.settings.usageNever')));
    const again = button(refreshing ? t('routing.settings.refreshing') : t('routing.settings.refresh'), async () => {
      refreshing = true; paintAdvanced();
      await refresh({ refresh: true });
      refreshing = false; paintAdvanced();
    }, 'btn rt-refresh');
    again.disabled = refreshing || !s.enabled;
    usageLine.append(again);
    out.push(usageLine);
    for (const tier of data.tiers) out.push(tierBlock(tier));
    // 種類 × 難しさ
    out.push(el('h3', 'rt-sub-title', t('routing.settings.tableTitle')));
    out.push(tableBlock());
    // 使用量の方針
    out.push(el('h3', 'rt-sub-title', t('routing.settings.policyTitle')));
    const policy = el('div', 'rt-policy');
    policy.append(numberField('avoidPercent', t('routing.settings.avoid'), t('routing.settings.avoidUnit'), { min: 1, max: 100, step: 1 }),
      numberField('paceLimit', t('routing.settings.pace'), t('routing.settings.paceUnit'), { min: 0.1, max: 10, step: 0.1 }),
      numberField('staleMinutes', t('routing.settings.stale'), t('routing.settings.staleUnit'), { min: 1, max: 1440, step: 1 }));
    out.push(policy);
    advancedBody.replaceChildren(...out);
  }
  function stateOf(candidate) { return data.candidates.find(c => c.candidate === candidate) ?? null; }
  function tierBlock(tier) {
    const list = data.settings.tiers[tier] ?? [];
    const block = el('div', 'rt-tier');
    block.append(el('div', 'rt-tier-name', tierText(tier)));
    const rows = el('ol', 'rt-cand-list');
    list.forEach((candidate, i) => {
      const { backend, model } = splitCandidate(candidate);
      const st = stateOf(candidate);
      const name = names.model(backend, model);
      const row = el('li', 'rt-cand-row' + (st && !st.usable ? ' off' : ''));
      const info = el('div', 'rt-cand-info');
      const title = el('span', 'rt-cand-name');
      title.append(el('span', 'rt-n', `${i + 1}.`), logo(backend), el('span', null, name));
      title.title = candidate;
      const sub = [labelOf(backend)];
      if (st?.usable) { const u = usageSummary(st); if (u) sub.push(u); }
      else if (st) sub.push(skipText(st.reason, st.detail));
      const small = el('small', st && ['model_unknown'].includes(st.reason) ? 'rt-strong' : null, (st?.reason === 'model_unknown' ? '⚠ ' : '') + sub.join(t('routing.line.join')));
      info.append(title, small);
      const actions = el('div', 'rt-cand-actions');
      const move = (to, label, d) => {
        const b = button('', () => { const next = [...list]; [next[i], next[to]] = [next[to], next[i]]; saveNested('tiers', { ...data.settings.tiers, [tier]: next }); }, 'btn btn-icon rt-move');
        b.setAttribute('aria-label', label); b.title = label;
        b.innerHTML = `<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="${d}"/></svg>`;
        b.disabled = busy || to < 0 || to >= list.length;
        return b;
      };
      const remove = button('', () => saveNested('tiers', { ...data.settings.tiers, [tier]: list.filter(c => c !== candidate) }), 'btn btn-icon rt-move');
      remove.setAttribute('aria-label', t('routing.settings.candidateRemove', { name }));
      remove.title = remove.getAttribute('aria-label');
      remove.innerHTML = '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';
      remove.disabled = busy;
      actions.append(move(i - 1, t('routing.settings.candidateUp', { name }), 'M6 15l6-6 6 6'),
        move(i + 1, t('routing.settings.candidateDown', { name }), 'M6 9l6 6 6-6'), remove);
      row.append(info, actions);
      rows.append(row);
    });
    if (!list.length) block.append(el('p', 'mp-note', t('routing.settings.empty')));
    else block.append(rows);
    const add = button(t('routing.settings.addCandidate'), e => addMenu(tier, e.currentTarget), 'btn rt-add');
    add.disabled = busy;
    block.append(add);
    return block;
  }
  /** 候補を足すメニュー。エージェントごとにモデルの一覧（段にまだ無いもの）と、backend:model を打ち込む欄 */
  async function addMenu(tier, anchor) {
    const list = data.settings.tiers[tier] ?? [];
    const r = anchor.getBoundingClientRect();
    const backends = [...new Set(['claude', 'codex', 'antigravity', ...data.candidates.map(c => c.backend)].filter(Boolean))];
    const items = await Promise.all(backends.map(async backend => {
      const models = await modelsOf(backend).catch(() => null);
      const ids = Object.keys(models ?? {}).filter(id => id && !list.includes(`${backend}:${id}`));
      return { label: labelOf(backend), sub: () => ids.length
        ? ids.map(id => ({ label: models[id]?.label ?? id, hint: (models[id]?.label ?? id) === id ? '' : id, onClick: () => saveNested('tiers', { ...data.settings.tiers, [tier]: [...list, `${backend}:${id}`] }) }))
        : [{ label: t('routing.settings.noModels'), disabled: true }] };
    }));
    showMenu(r.left, r.bottom + 4, [...items, { sep: true },
      { input: { placeholder: t('routing.settings.addInput'), onCommit: v => saveNested('tiers', { ...data.settings.tiers, [tier]: [...list, v] }) } }],
      t('routing.settings.addTitle', { tier: tierText(tier) }));
  }
  function tableBlock() {
    const wrap = el('div', 'table-wrap rt-table');
    const table = el('table');
    const headRow = el('tr');
    headRow.append(el('th', null, t('routing.settings.tableKind')), ...DIFFICULTIES.map(d => el('th', null, difficultyText(d))));
    const thead = el('thead');
    thead.append(headRow);
    const body = el('tbody');
    for (const kind of data.kinds) {
      const tr = el('tr');
      const th = el('th', null, kindText(kind));
      th.scope = 'row';
      tr.append(th);
      DIFFICULTIES.forEach((d, i) => {
        const tier = data.settings.table[kind][i];
        const td = el('td');
        const b = button(tierShortText(tier), e => {
          const rect = e.currentTarget.getBoundingClientRect();
          showMenu(rect.left, rect.bottom + 4, data.tiers.map(x => ({ label: tierText(x), checked: x === tier,
            onClick: () => { if (x !== tier) { const row = [...data.settings.table[kind]]; row[i] = x; saveNested('table', { ...data.settings.table, [kind]: row }); } } })),
          `${kindText(kind)} · ${difficultyText(d)}`);
        }, 'btn rt-cell');
        b.setAttribute('aria-label', t('routing.settings.tableCell', { kind: kindText(kind), difficulty: difficultyText(d), tier: tierText(tier) }));
        b.disabled = busy;
        td.append(b);
        tr.append(td);
      });
      body.append(tr);
    }
    table.append(thead, body);
    wrap.append(table);
    return wrap;
  }
  function numberField(key, label, unit, { min, max, step }) {
    const field = el('label', 'mp-field rt-number');
    const input = el('input');
    input.type = 'number'; input.min = String(min); input.max = String(max); input.step = String(step);
    input.value = String(data.settings[key]);
    input.disabled = busy;
    const commit = () => {
      const v = Number(input.value);
      if (!Number.isFinite(v) || v === data.settings[key]) { input.value = String(data.settings[key]); return; }
      save({ [key]: v === data.defaults[key] ? null : v });
    };
    input.onchange = commit;
    input.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); input.blur(); } };
    const row = el('span', 'rt-number-row');
    row.append(input, el('span', 'rt-unit', unit));
    field.append(el('span', null, label), row);
    return field;
  }

  function paintReset() {
    const out = [];
    if (confirmingReset) {
      const ask = el('div', 'mp-confirm');
      ask.append(el('p', null, t('routing.settings.resetConfirm')));
      const buttons = el('div', 'mp-card-actions');
      buttons.append(button(t('routing.settings.keyCancel'), () => { confirmingReset = false; paintReset(); }),
        button(t('routing.settings.reset'), async () => {
          confirmingReset = false;
          await save(Object.fromEntries(Object.keys(data.defaults).map(k => [k, null])));
        }));
      ask.append(buttons);
      out.push(ask);
    } else {
      const b = button(t('routing.settings.reset'), () => { confirmingReset = true; paintReset(); });
      b.disabled = busy || same(data.settings, data.defaults);
      out.push(b);
    }
    reset.replaceChildren(...out);
  }

  $('delegationTab').onclick = () => { page('delegation'); refresh(); };
  paint();
  return {
    refresh,
    /** delegationRoutingChanged。開いているときだけ取り直す（使用量の取り直しは 5 分ごとに来る） */
    event() { if (!root.hidden) refresh(); },
  };
}
