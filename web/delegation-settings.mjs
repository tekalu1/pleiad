// 設定 › 委譲（委譲先の自動振り分け。docs/design-system.md「設定 › 委譲」、docs/agent-delegation.md「委譲先の自動振り分け」）。
//
// - 先頭のスイッチ「委譲先を自動で選ぶ」
// - 「難しさの判定」: 種類ごとの判定器（Jev / Qwen / 判定しない）の表と「Jev が迷ったら Qwen に聞き直す」
// - 「判定器が使うキー」: OpenRouter（Jev・Qwen。どちらも OpenRouter で、キーは 1 つ）の「使うキー」を設定 › API キー（承認済み 2026-10-07）から選ぶ（WS の setApiKeyUse）。
//   選ぶまでは何も送らない。未登録ならその場で登録でき（登録先は API キー）、キーは返ってこない（hasKey と keyRef だけ）。送る内容の 1 行
// - 「詳しい設定」（details）: 段ごとの候補（並べ替え・追加・外す、各候補の今の使用量と使えるかどうか、段の既定と候補ごとの思考の強さ。
//   承認済み 2026-10-08・ADR 0164）・種類 × 難しさの表・使用量の方針
// - 末尾の「既定に戻す」（その場の確認。キーは残る）
//
// 状態はサーバーが持つ（delegationRouting コマンドと、変わるたびに届く delegationRoutingChanged イベント）。
// 変えたらすぐ setDelegationRouting で保存する（保存ボタンは置かない）。既定と同じ項目は送らない（既定値を凍らせない）。
// 面と部品は設定の管理の面（web/manage-panel.css の .mp-*）・コンテキストのスイッチ（.cx-sw）・区切りボタン（.seg）・
// 使用量の行（web/usage.css の .usage-rows）・表（.table-wrap）を使う。
import { el } from './dom.mjs';
import { t, fmt } from './i18n.mjs';
import { kindText, difficultyText, tierText, tierShortText, judgeText, skipText, usageSummary, splitCandidate } from './delegation-routing-view.mjs';
import { apiKeyList, keySelect, registerForm, statusLine, manageLink } from './api-key-ui.mjs';
import { EFFORT_LEVELS, candidateEffort, tierEffort, withEffort } from './delegation-effort.mjs';
import { effortSelect, effortFixed } from './effort-select.mjs';

const SERVICES = ['openrouter'];
/** キーのサービスごとの、そのキーを使う判定器と割り当て（API キーの uses。名前は前の版のまま judge:jev） */
const SERVICE_JUDGES = { openrouter: ['jev', 'qwen'] };
const SERVICE_USE = { openrouter: 'judge:jev' };
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

/** 送る値が「既定との差の全体」（サーバーが丸ごと置き換える）の項目。重ねる先は今の値ではなく既定（段の既定に戻した行が残らないように） */
const REPLACED = new Set(['efforts']);

function applyPatch(settings, patch, defaults) {
  const next = structuredClone(settings);
  for (const [key, value] of Object.entries(patch)) {
    next[key] = value === null ? structuredClone(defaults[key])
      : value && typeof value === 'object' && !Array.isArray(value)
        ? { ...(REPLACED.has(key) ? defaults[key] : next[key]), ...structuredClone(value) } : value;
  }
  return next;
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
 * @param openPage   設定のほかのページへ移る（API キー）
 */
export function setupDelegationSettings({ cmd, page, showMenu, labelOf, logo, modelsOf, modelName, openPage = () => {} }) {
  const $ = id => document.getElementById(id);
  const root = $('delegationPanel');
  let data = null, committed = null, message = '', registering = '', keyList = null, confirmingReset = false, refreshing = false;
  const pending = [];
  let saving = false, refreshSerial = 0;
  // 判定器の面で押した部品（`${kind}:${judge}` か 'escalate'）。描き直したときにフォーカスを戻す
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
    const serial = ++refreshSerial;
    try {
      const latest = await cmd('delegationRouting', args);
      if (serial !== refreshSerial) return;
      committed = latest;
      data = { ...latest, settings: pending.reduce((s, patch) => applyPatch(s, patch, latest.defaults), latest.settings) };
      message = '';
      // 選べるキー。取れなくても判定器の設定は見せる（選ぶ欄だけ使えない）
      keyList = await apiKeyList(cmd).catch(() => null);
    }
    catch (e) { message = t('routing.settings.loadFailed', { error: e.message }); }
    // 候補の名前は語彙から。まだ読んでいないエージェントの分を読んでから描く
    await Promise.all([...new Set((data?.candidates ?? []).map(c => c.backend).filter(Boolean))].map(b => modelsOf(b).catch(() => null)));
    paint();
  }
  async function save(patch) {
    if (!data) return;
    pending.push(patch);
    data = { ...data, settings: applyPatch(data.settings, patch, data.defaults) };
    message = '';
    paint();
    if (saving) return;
    saving = true;
    while (pending.length) {
      const next = pending[0];
      try {
        committed = await cmd('setDelegationRouting', { settings: next });
        message = '';
      } catch (e) {
        message = t('routing.settings.saveFailed', { error: e.message });
      }
      pending.shift();
      data = { ...committed, settings: pending.reduce((s, item) => applyPatch(s, item, committed.defaults), committed.settings) };
      paint();
    }
    saving = false;
  }
  /** 入れ子の設定（judgeByKind・tiers・table）を変えたとき。既定と同じ項目は送らず、全部既定なら null で既定に戻す */
  const saveNested = (key, value) => save({ [key]: diffFromDefaults(value, data.defaults[key]) });
  const saveEfforts = efforts => saveNested('efforts', efforts);

  // ---- 描く
  function paint() {
    const s = data?.settings;
    sw.setAttribute('aria-checked', String(Boolean(s?.enabled)));
    sw.disabled = !s;
    stateLine.textContent = message;
    stateLine.hidden = !message;
    paintEffective();
    if (!s) { for (const p of [judges, keys, advanced, reset]) p.hidden = true; return; }
    for (const p of [judges, keys, advanced, reset]) p.hidden = false;
    // 入力の途中（欄にフォーカス）で描き直すと打った値が消えるので、そのときは面ごとに飛ばす。
    // 判定器の面には打つ欄が無いので常に描き直す（押したボタンにフォーカスが残り、選び直しが画面に出なかった）
    paintJudges();
    if (!keys.contains(document.activeElement) || !registering) paintKeys();
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
        b.disabled = false;
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
    box.checked = s.escalateToQwen;
    box.disabled = false;
    box.onchange = () => { judgeFocus = 'escalate'; save({ escalateToQwen: box.checked }); };
    box.dataset.focusKey = 'escalate';
    controls.set('escalate', box);
    check.append(box, el('span', null, t('routing.settings.escalate')));
    out.push(check);
    judges.replaceChildren(...out);
    judgeFocus = '';
    controls.get(focusKey)?.focus();
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
        const used = SERVICE_JUDGES[service].filter(judge => Object.values(s.judgeByKind).includes(judge));
        if (data.keys[service]?.hasKey || !used.length) continue;
        lines.push(effLine(t('routing.settings.effective.noKey', { service: t(`routing.settings.service.${service}`), judge: used.map(judgeText).join(' / ') }),
          t('apiKeys.delegation.selectKey'), () => goKey(service)));
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
  /** 判定器が使うキーのカードへ移り、「使うキー」の選択を開いてフォーカス */
  function goKey(service) {
    const select = keys.querySelector(`[data-fk="sel:${service}"]`);
    keys.scrollIntoView({ block: 'start', behavior: 'smooth' });
    select?.focus({ preventScroll: true });
    select?.click();
  }
  /** 「詳しい設定」を開いて段ごとの候補へ */
  function goCandidates() {
    advanced.open = true;
    advanced.scrollIntoView({ block: 'start', behavior: 'smooth' });
    summary.focus({ preventScroll: true });
  }

  function paintKeys() {
    const out = [el('h3', null, t('apiKeys.delegation.title'))];
    const deferred = keyList?.migration?.state === 'deferred';
    for (const service of SERVICES) {
      const name = t(`routing.settings.service.${service}`);
      const choices = (keyList?.keys ?? []).filter(k => k.provider === service);
      const current = choices.find(k => k.id === data.keys[service]?.keyRef) ?? null;
      const card = el('div', 'mp-card rt-key');
      const row = el('div', 'mp-row');
      const info = el('div', 'mp-card-info');
      info.append(el('strong', null, name));
      if (deferred) info.append(el('small', null, data.keys[service]?.hasKey ? t('apiKeys.deferredInUse') : t('apiKeys.deferredShort')));
      else if (current) { const small = statusLine(current); small.append(' · ', manageLink(openPage)); info.append(small); }
      else info.append(el('small', null, t('apiKeys.delegation.unset')));
      row.append(info);
      // 移行を保留している間は選び直せない（古い置き場のまま使う。設定 › API キーに理由）
      if (keyList && !deferred) {
        const actions = el('div', 'mp-card-actions ak-sels');
        actions.append(el('span', 'ak-sel-l', t('apiKeys.useKey')), keySelect({ keys: choices, current: current?.id ?? null, label: t('apiKeys.delegation.selectLabel', { service: name }), focusKey: `sel:${service}`,
          provider: service, choose: id => chooseKey(service, id), register: () => { registering = service; paintKeys(); keys.querySelector('.rt-key-form input')?.focus(); } }).element);
        row.append(actions);
      }
      card.append(row);
      if (registering === service && keyList) card.append(registerForm({ provider: service, label: t('routing.settings.keyInput', { service: name }), storage: keyList.storage ?? data.storage, focusKey: `regin:${service}`,
        onSubmit: value => registerKey(service, value), onCancel: () => { registering = ''; paintKeys(); keys.querySelector(`[data-fk="sel:${service}"]`)?.focus(); } }));
      out.push(card);
    }
    // 外部送信の同意はキーを選ぶこと（知らないと事故になるので 1 行だけ）。暗号化の注意は設定 › API キーへ移った
    out.push(el('p', 'mp-note', t('apiKeys.delegation.note')));
    keys.replaceChildren(...out);
  }
  /** 判定器に使うキーを選ぶ（null は使わない）。選んだときから送り始める */
  async function chooseKey(service, id) {
    message = '';
    try { await cmd('setApiKeyUse', { use: SERVICE_USE[service], id }); await refresh(); }
    catch (e) { message = t('routing.settings.saveFailed', { error: e.message }); paint(); }
    keys.querySelector(`[data-fk="sel:${service}"]`)?.focus({ preventScroll: true });
  }
  /** その場で登録して、判定器に使う（登録先は API キー） */
  async function registerKey(service, value) {
    message = '';
    try {
      const { id } = await cmd('setApiKey', { provider: service, label: '', key: value });
      await cmd('setApiKeyUse', { use: SERVICE_USE[service], id });
      registering = '';
      await cmd('invoke', { op: 'apiKeys.check', args: { id } }).catch(() => null);
      await refresh();
    } catch (e) { message = t('routing.settings.saveFailed', { error: e.message }); paint(); }
    keys.querySelector(`[data-fk="sel:${service}"]`)?.focus({ preventScroll: true });
  }

  // ---- 詳しい設定
  function paintAdvanced() {
    const s = data.settings;
    // 強さの選択を押した後の描き直しで、押した部品へフォーカスを戻す
    const focused = advancedBody.contains(document.activeElement) ? document.activeElement.dataset?.fk ?? '' : '';
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
      numberField('paceLimit', t('routing.settings.pace'), t('routing.settings.paceUnit'), { min: 0.1, max: 10, step: 0.1 }));
    out.push(policy);
    advancedBody.replaceChildren(...out);
    if (focused) [...advancedBody.querySelectorAll('button')].find(b => b.dataset?.fk === focused)?.focus({ preventScroll: true });
  }
  function stateOf(candidate) { return data.candidates.find(c => c.candidate === candidate) ?? null; }
  function candidateUsage(candidate) {
    const st = stateOf(candidate);
    const { backend } = splitCandidate(candidate);
    const join = t('routing.line.join');
    if (st?.accounts?.length) return { st, lines: st.accounts.map(a => {
      const name = a.label || (a.account === '' ? t('routing.detail.loginAccount') : a.account);
      const state = a.usable ? a.deferred ? t('routing.settings.lowHeadroom', { reason: skipText(a.reason) }) : '' : skipText(a.reason, a.detail);
      return { text: [name, state, usageSummary({ windows: a.windows })].filter(Boolean).join(join), strong: a.reason === 'model_unknown' };
    }) };
    const sub = [labelOf(backend)];
    if (st?.usable) {
      if (st.deferred) sub.push(t('routing.settings.lowHeadroom', { reason: skipText(st.reason) }));
      const u = usageSummary(st); if (u) sub.push(u);
    }
    else if (st) sub.push(skipText(st.reason, st.detail));
    return { st, lines: [{ text: (st?.reason === 'model_unknown' ? '⚠ ' : '') + sub.join(join), strong: st?.reason === 'model_unknown' }] };
  }
  const usageLines = lines => lines.map(line => el('small', line.strong ? 'rt-strong' : null, line.text));
  function paintUsage() {
    paintEffective();
    const at = data.candidates.map(c => c.checkedAt).filter(Boolean).sort()[0];
    const stamp = advancedBody.querySelector('.rt-usage-at')?.querySelector('small');
    if (stamp) stamp.textContent = at ? t('routing.settings.usageAt', { time: fmt.time(at, { hour: '2-digit', minute: '2-digit', second: '2-digit' }) }) : t('routing.settings.usageNever');
    for (const row of advancedBody.querySelectorAll('.rt-cand-row')) {
      const { st, lines } = candidateUsage(row.dataset.candidate);
      row.classList.toggle('off', Boolean(st && !st.usable));
      const info = row.querySelector('.rt-cand-info');
      if (info) { for (const small of info.querySelectorAll('small')) small.remove(); info.append(...usageLines(lines)); }
    }
  }
  function tierBlock(tier) {
    const list = data.settings.tiers[tier] ?? [];
    const block = el('div', 'rt-tier');
    const tierHead = el('div', 'rt-tier-head');
    tierHead.append(el('span', 'rt-tier-name', tierText(tier)), tierEffortSelect(tier, list));
    block.append(tierHead);
    const rows = el('ol', 'rt-cand-list');
    list.forEach((candidate, i) => {
      const { backend, model } = splitCandidate(candidate);
      const st = stateOf(candidate);
      const name = names.model(backend, model);
      const row = el('li', 'rt-cand-row' + (st && !st.usable ? ' off' : ''));
      row.dataset.candidate = candidate;
      const info = el('div', 'rt-cand-info');
      const title = el('span', 'rt-cand-name');
      title.append(el('span', 'rt-n', `${i + 1}.`), logo(backend), el('span', null, name));
      title.title = candidate;
      const usage = candidateUsage(candidate);
      info.append(title, ...usageLines(usage.lines));
      const actions = el('div', 'rt-cand-actions');
      const move = (to, label, d) => {
        const b = button('', () => { const next = [...list]; [next[i], next[to]] = [next[to], next[i]]; saveNested('tiers', { ...data.settings.tiers, [tier]: next }); }, 'btn btn-icon rt-move');
        b.setAttribute('aria-label', label); b.title = label;
        b.innerHTML = `<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="${d}"/></svg>`;
        b.disabled = to < 0 || to >= list.length;
        return b;
      };
      const remove = button('', () => saveNested('tiers', { ...data.settings.tiers, [tier]: list.filter(c => c !== candidate) }), 'btn btn-icon rt-move');
      remove.setAttribute('aria-label', t('routing.settings.candidateRemove', { name }));
      remove.title = remove.getAttribute('aria-label');
      remove.innerHTML = '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';
      remove.disabled = false;
      actions.append(move(i - 1, t('routing.settings.candidateUp', { name }), 'M6 15l6-6 6 6'),
        move(i + 1, t('routing.settings.candidateDown', { name }), 'M6 9l6 6 6-6'), remove);
      const effort = el('div', 'rt-cand-effort');
      effort.append(candidateEffortSelect(tier, candidate, name));
      row.append(info, effort, actions);
      rows.append(row);
    });
    if (!list.length) block.append(el('p', 'mp-note', t('routing.settings.empty')));
    else block.append(rows);
    const add = button(t('routing.settings.addCandidate'), e => addMenu(tier, e.currentTarget), 'btn rt-add');
    add.disabled = false;
    block.append(add);
    return block;
  }
  // ---- 思考の強さ（ADR 0164。決め方は web/delegation-effort.mjs・サーバーの decideEffort と同じ）
  const conversationOf = backend => data.conversationEfforts?.[backend] ?? '';
  /** 段の見出しの右の「段の既定」。段の中の候補は、上書きが無ければこの値で走る */
  function tierEffortSelect(tier, list) {
    const { value, changed } = tierEffort({ settings: data.settings, defaults: data.defaults, tier });
    const shown = value === '' ? t('routing.effort.conversation') : value;
    const name = tierText(tier);
    // 会話の既定はエージェントごとに違うので、段の候補が同じ値のときだけ「今は X」と出す
    const nows = [...new Set(list.map(c => conversationOf(splitCandidate(c).backend) || t('routing.effort.unset')))];
    const recommended = data.defaults.efforts?.[tier]?.['*'] ?? '';
    const pick = v => () => { sel.button.focus(); saveEfforts(withEffort(data.settings.efforts, tier, '*', v)); };
    const sel = effortSelect({ focusKey: `${tier}|*`, changed, align: 'right',
      label: t('routing.effort.tierLabel', { tier: name, value: shown }), head: t('routing.effort.tierHead', { tier: name }),
      parts: [{ text: t('routing.effort.tierDefault') }, { text: shown, cls: 'ef-v' }],
      rows: [{ label: t('routing.effort.followConversation'), hint: nows.length === 1 ? t('routing.effort.now', { value: nows[0] }) : t('routing.effort.perAgent'), on: value === '', pick: pick('') },
        { sep: true },
        ...EFFORT_LEVELS.map(l => ({ label: l, hint: l === recommended ? t('routing.effort.recommended') : '', on: value === l, pick: pick(l) })),
        { foot: t('routing.effort.fitNote') }] });
    return sel.element;
  }
  /** 候補の行の右の強さ。選べない候補（強さを持たないモデル・強さがモデル名に入るもの）は選択を出さず、理由を 1 語 */
  function candidateEffortSelect(tier, candidate, name) {
    const { backend } = splitCandidate(candidate);
    const e = candidateEffort({ settings: data.settings, tier, candidate, capability: stateOf(candidate)?.effort, conversation: conversationOf(backend) });
    if (e.kind === 'fixed') return effortFixed({ value: e.value, reason: t('routing.effort.byModel'), title: t('routing.effort.byModelTitle') });
    if (e.kind === 'none') return effortFixed({ reason: t('routing.effort.none'), title: t('routing.effort.noneTitle') });
    const value = e.value ?? t('routing.effort.modelDefault');
    const note = [e.source === 'tier' ? t('routing.effort.sourceTier') : e.source === 'conversation' ? t('routing.effort.sourceConversation') : '',
      e.asked ? t('routing.effort.adjusted', { asked: e.asked, value: e.value ?? '—' }) : ''].filter(Boolean).join(' ');
    const pick = v => () => { sel.button.focus(); saveEfforts(withEffort(data.settings.efforts, tier, candidate, v)); };
    const sel = effortSelect({ focusKey: `${tier}|${candidate}`, changed: e.changed, align: 'right',
      label: t('routing.effort.candLabel', { name, value, source: note }).trim(),
      head: t('routing.effort.candHead', { name, tier: tierText(tier) }),
      parts: [{ text: t('routing.effort.label') }, { text: value, cls: 'ef-v' }, ...(note ? [{ text: note, cls: 'ef-s' }] : [])],
      rows: [{ label: t('routing.effort.followTier'), hint: e.tierDefault === '' ? t('routing.effort.convShort') : e.tierValue ?? '', on: e.own === undefined, pick: pick(undefined) },
        { label: t('routing.effort.followConversation'), hint: t('routing.effort.now', { value: e.conversationValue ?? t('routing.effort.unset') }), on: e.own === '', pick: pick('') },
        { sep: true },
        ...e.options.map(l => ({ label: l, on: e.own === l, pick: pick(l) }))] });
    return sel.element;
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
        b.disabled = false;
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
    input.disabled = false;
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
      b.disabled = same(data.settings, data.defaults);
      out.push(b);
    }
    reset.replaceChildren(...out);
  }

  $('delegationTab').onclick = () => { page('delegation'); refresh(); };
  paint();
  return {
    refresh,
    /** 使用量だけの通知では、開いたメニューと入力欄を作り直さない。種類のない旧サーバーの通知は全体を取り直す */
    async event(ev) {
      if (root.hidden) return;
      if (ev?.change !== 'usage') return refresh();
      const serial = ++refreshSerial;
      try {
        const latest = await cmd('delegationRouting');
        if (serial !== refreshSerial || !data) return;
        data.candidates = latest.candidates;
        data.warnings = latest.warnings;
        paintUsage();
      } catch (e) { message = t('routing.settings.loadFailed', { error: e.message }); stateLine.textContent = message; stateLine.hidden = false; }
    },
  };
}
