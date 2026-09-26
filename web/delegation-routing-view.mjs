// 委譲先の自動振り分けの記録（routing）の見せ方（docs/design-system.md「委譲カード」、docs/agent-delegation.md「委譲先の自動振り分け」）。
//
// - 委譲カードの 1 行の理由（routingLine）と、開いたときの内訳（routingDetail）
// - 内訳の「別の候補でやり直す」の面（retryPanel）。候補は設定 › 委譲と同じ delegationRouting の candidates から
//
// 文を組み立てる関数は DOM を触らない（tests/unit/delegation-routing-view.mjs から直接呼ぶ）。
// モデル・エージェントの名前とロゴは client.mjs から names / logo で受け取る（語彙はそちらが持っている）。
import { el } from './dom.mjs';
import { t, fmt } from './i18n.mjs';

// i18n-dynamic: routing.kind.
// i18n-dynamic: routing.difficulty.
// i18n-dynamic: routing.tier.
// i18n-dynamic: routing.tierShort.
// i18n-dynamic: routing.judge.
// i18n-dynamic: routing.signal.
// i18n-dynamic: routing.fallback.
// i18n-dynamic: routing.skip.
const known = (prefix, value) => {
  const key = `${prefix}.${value}`;
  const text = t(key);
  return text === key ? String(value ?? '') : text;
};
export const kindText = kind => known('routing.kind', kind);
export const difficultyText = d => known('routing.difficulty', d);
export const tierText = tier => known('routing.tier', tier);
export const tierShortText = tier => known('routing.tierShort', tier);
export const judgeText = judge => known('routing.judge', judge);
export const signalText = signal => known('routing.signal', signal);
// i18n-dynamic: routing.unavailable.
/** 飛ばした理由。「使えない」は中身（detail: disabled・not_installed・no_token）が分かれば添える */
export const skipText = (reason, detail) => (reason === 'unavailable' && detail && t(`routing.unavailable.${detail}`) !== `routing.unavailable.${detail}`
  ? t('routing.skipWithDetail', { reason: known('routing.skip', reason), detail: t(`routing.unavailable.${detail}`) })
  : known('routing.skip', reason));
/** 判定器を使えなかった理由（no_key・http_503 …） */
export function fallbackText(code) {
  const http = /^http_(\d+)$/.exec(String(code ?? ''));
  return http ? t('routing.fallback.http', { status: http[1] }) : known('routing.fallback', code);
}

/** 自動で選んだ記録か（固定・人が選び直したものは違う） */
export const isAutoRouting = routing => routing?.mode === 'auto';

/** 候補の id（backend:model）を分ける。model に : が入っても最初の : で分ける */
export function splitCandidate(id) {
  const s = String(id ?? '');
  const at = s.indexOf(':');
  return at > 0 ? { backend: s.slice(0, at), model: s.slice(at + 1) } : { backend: s, model: '' };
}

const percent = v => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : null);

// 有効でないエージェント（語彙を読めない）の名前。固有名なので訳さない
const BACKEND_NAMES = { claude: 'Claude Code', codex: 'Codex', antigravity: 'Antigravity' };
const CLAUDE_ALIASES = { opus: 'Opus', sonnet: 'Sonnet', haiku: 'Haiku', fable: 'Fable' };
/** 名前が語彙から引けなかったときの補い（エージェントの id・Claude の系統名） */
export function fallbackName(kind, backend, text) {
  if (kind === 'backend') return !text || text === backend ? BACKEND_NAMES[backend] ?? text ?? '' : text;
  return backend === 'claude' && CLAUDE_ALIASES[text] ? CLAUDE_ALIASES[text] : text;
}
const defaultNames = { backend: id => id ?? '', model: (_backend, model) => model ?? '' };
/** 「Codex gpt-6-sol」。names は { backend(id), model(backend, model) } */
export function targetText(target, names = defaultNames) {
  if (!target) return '';
  return [names.backend(target.backend), names.model(target.backend, target.model)].filter(Boolean).join(' ');
}

/** 飛ばした候補の一言（「Sonnet は週次 73% で飛ばした」） */
export function skippedPhrase(skipped, names = defaultNames) {
  const { backend, model } = splitCandidate(skipped.candidate);
  const name = names.model(backend, model) || model;
  const w = skipped.window;
  if (skipped.reason === 'pace_high' && w?.pace != null) return t('routing.line.skippedPace', { name, window: w.label ?? '', pace: w.pace });
  if (['quota_high', 'pace_unknown'].includes(skipped.reason) && percent(w?.usedPercent) != null)
    return t('routing.line.skippedWindow', { name, window: w.label ?? '', percent: percent(w.usedPercent) });
  return t('routing.line.skippedReason', { name, reason: skipText(skipped.reason) });
}

/**
 * 委譲カードの 1 行の理由（「実装・中 → Codex gpt-6-sol · Sonnet は週次 73% で飛ばした」）。飛ばした候補は最初の 1 つだけ。
 * 自動でない委譲（依頼元が委譲先を書いた）は難しさを判定していないので「種類 → 委譲先」だけ（「実装 → Codex」）
 */
export function routingLine(routing, names = defaultNames) {
  if (!routing?.target) return '';
  if (!isAutoRouting(routing)) return t('routing.line.pinned', { kind: kindText(routing.kind), target: targetText(routing.target, names) });
  const head = t('routing.line.head', { kind: kindText(routing.kind), difficulty: difficultyText(routing.difficulty), target: targetText(routing.target, names) });
  const first = routing.skipped?.[0];
  return first ? head + t('routing.line.join') + skippedPhrase(first, names) : head;
}

/** 判定の一行（どの判定器の答えを使ったか・使えなかった理由） */
export function judgeLine(routing) {
  if (!routing) return '';
  if (!routing.judge || routing.judge === 'none') {
    return !routing.fallback || routing.fallback === 'judge_none' ? t('routing.detail.judgeNone')
      : t('routing.detail.judgeUnavailable', { reason: fallbackText(routing.fallback) });
  }
  if (routing.escalated) return t('routing.detail.judgeEscalated', { judge: judgeText(routing.judge) });
  // もう一方の判定器に落ちた（fallback は最初に選んだ判定器の失敗の理由）
  if (routing.fallback) return t('routing.detail.judgeFailed', { judge: judgeText(routing.judge),
    first: judgeText(routing.judge === 'jev' ? 'cerebras' : 'jev'), reason: fallbackText(routing.fallback) });
  return judgeText(routing.judge);
}

/** はいだった手がかりの名前 */
export function yesSignals(routing) {
  return Object.entries(routing?.signals ?? {}).filter(([, v]) => v === true).map(([k]) => signalText(k));
}

/** 段の一言。表の段から上げたときはそれも */
export function tierLine(routing) {
  if (!routing?.tier) return '';
  return routing.baseTier && routing.baseTier !== routing.tier
    ? t('routing.detail.tierRaised', { tier: tierText(routing.tier), base: tierText(routing.baseTier) }) : tierText(routing.tier);
}

/**
 * やり直しに出す候補。今使えるもので、元の委譲先を除く。元の段から上へ、次に下の段の順（段の中は設定の順）。
 * candidates は delegationRouting の candidates、tiers は段の並び
 */
export function retryCandidates(candidates, routing, tiers = ['t1', 't2', 't3', 't4', 'tv']) {
  const used = routing?.target ? `${routing.target.backend}:${routing.target.model}` : '';
  const at = Math.max(0, tiers.indexOf(routing?.tier ?? routing?.baseTier));
  const order = [...tiers.slice(at), ...tiers.slice(0, at).reverse()];
  const rank = c => Math.min(...(c.tiers ?? []).map(tier => order.indexOf(tier)).filter(i => i >= 0), order.length);
  return (candidates ?? []).filter(c => c.usable && c.candidate !== used)
    .map((c, i) => ({ c, i, r: rank(c) })).sort((a, b) => a.r - b.r || a.i - b.i).map(x => x.c);
}

/** 使用量の一行（「週次 11% · 5時間 45%」）。Claude のアカウントごとの枠は、使うアカウント（account）の分 */
export function usageSummary(state) {
  const windows = state?.accounts ? (state.accounts.find(a => a.account === (state.account ?? ''))?.windows ?? state.accounts[0]?.windows ?? []) : state?.windows ?? [];
  return windows.filter(w => percent(w.usedPercent) != null).map(w => `${w.label ?? ''} ${percent(w.usedPercent)}%`).join(t('routing.line.join'));
}

// ---------------------------------------------------------------- 自動の振り分けの失敗

/**
 * 使える委譲先が無かった ply_delegate のエラー文（エージェント向け。core/server.mjs の routeDelegation）を読む。
 * 文は会話の言語だが、種類・難しさの値と候補の行（`- backend:model (t2): reason (detail) 週次 84% pace 1.4`）は言語によらない。
 * 当たらなければ null。{ kind, difficulty, skipped: [{ candidate, tier, reason, detail?, window?: { label, usedPercent, pace? } }] }
 */
export function parseRoutingFailure(text) {
  const s = String(text ?? '');
  const head = /(?:kind|種類) ([a-z_]+)[,、]\s*(?:difficulty|難しさ) (low|mid|high)/.exec(s);
  if (!head) return null;
  const skipped = [];
  for (const line of s.split(/\r?\n/)) {
    const m = /^- ([a-z]+:\S+) \((t\d|tv)\): ([a-z_]+)(?: \(([a-z_]+)\))?(?: (.*?) (\d+(?:\.\d+)?)%)?(?: pace (\d+(?:\.\d+)?))?\s*$/.exec(line);
    if (!m) continue;
    const [, candidate, tier, reason, detail, label, used, pace] = m;
    const window = used != null || pace != null ? { label: label ?? '', ...(used != null ? { usedPercent: Number(used) } : {}), ...(pace != null ? { pace: Number(pace) } : {}) } : null;
    skipped.push({ candidate, tier, reason, ...(detail ? { detail } : {}), ...(window ? { window } : {}) });
  }
  return { kind: head[1], difficulty: head[2], skipped };
}

// 直せば通るもの（設定）を先に、待てば戻るもの（使用量）を後に
const FAILURE_ORDER = ['unavailable', 'model_unknown', 'quota_high', 'pace_high', 'pace_unknown', 'usage_stale', 'usage_unknown'];
/** 飛ばした候補を理由ごとにまとめる。[{ reason, items }]（理由の順は FAILURE_ORDER、知らない理由は後ろ） */
export function groupSkipped(skipped) {
  const groups = new Map();
  for (const s of skipped ?? []) groups.set(s.reason, [...(groups.get(s.reason) ?? []), s]);
  const rank = r => { const i = FAILURE_ORDER.indexOf(r); return i < 0 ? FAILURE_ORDER.length : i; };
  return [...groups].sort((a, b) => rank(a[0]) - rank(b[0])).map(([reason, items]) => ({ reason, items }));
}

/** まとめた行の中身。使えない・使用量が分からない等はエージェントごとの件数、使用量・ペースは候補ごとの値 */
export function groupText({ reason, items }, names = defaultNames) {
  const join = t('routing.line.join');
  if (['quota_high', 'pace_high', 'pace_unknown'].includes(reason)) {
    return items.map(s => {
      const { backend, model } = splitCandidate(s.candidate);
      const name = names.model(backend, model) || model;
      const w = s.window;
      if (reason === 'pace_high' && w?.pace != null) return t('routing.failure.pace', { name, window: w.label ?? '', pace: w.pace });
      if (percent(w?.usedPercent) != null) return t('routing.failure.percent', { name, window: w.label ?? '', percent: percent(w.usedPercent) });
      return name;
    }).join(join);
  }
  const byBackend = new Map();
  for (const s of items) {
    const { backend } = splitCandidate(s.candidate);
    // 同じ候補が複数の段に並んでいても 1 つと数える
    const row = byBackend.get(backend) ?? { ids: new Set(), details: new Set() };
    row.ids.add(s.candidate);
    if (s.detail) row.details.add(s.detail);
    byBackend.set(backend, row);
  }
  return [...byBackend].map(([backend, { ids, details }]) => {
    const name = t('routing.failure.count', { name: names.backend(backend), n: ids.size });
    // 使えない理由がエージェントの中で 1 つに決まれば添える（「Codex 2（入っていない）」）
    const [only] = details;
    return details.size === 1 && reason === 'unavailable' ? t('routing.failure.withDetail', { text: name, detail: t(`routing.unavailable.${only}`) }) : name;
  }).join(join);
}

/**
 * 失敗した自動の委譲のカードに足す部品（docs/design-system.md「委譲カード」）。開かなくても見える、理由ごとにまとめた行と、
 * 候補ごとの一覧の折りたたみ。open(reason) は直す場所を開く口を返す（{ label, run } か null）
 */
export function routingFailureParts(failure, { names = defaultNames, open = () => null } = {}) {
  const why = el('ul', 'tc-why');
  for (const group of groupSkipped(failure.skipped)) {
    const li = el('li');
    li.append(el('b', null, skipText(group.reason)), el('span', 'n', groupText(group, names)));
    const go = open(group.reason);
    if (go) {
      const b = el('button', 'btn link', go.label);
      b.type = 'button';
      b.onclick = e => { e.preventDefault(); e.stopPropagation(); go.run(); };
      li.append(b);
    }
    why.append(li);
  }
  if (!failure.skipped.length) why.append(el('li', 'n', t('routing.failure.noCandidates')));
  const fold = document.createElement('details');
  fold.className = 'tc-fold tc-cands-fold';
  fold.append(el('summary', null, t('routing.failure.tried', { count: failure.skipped.length })));
  const list = el('ul', 'tc-cands');
  for (const s of failure.skipped) {
    const { backend, model } = splitCandidate(s.candidate);
    const li = el('li');
    li.title = s.candidate;
    const w = s.window;
    const reason = skipText(s.reason, s.detail) + (w?.pace != null && s.reason === 'pace_high' ? `${t('routing.line.join')}${w.label ?? ''} ${t('routing.detail.pace', { pace: w.pace })}`
      : percent(w?.usedPercent) != null ? `${t('routing.line.join')}${w.label ?? ''} ${percent(w.usedPercent)}%` : '');
    li.append(el('span', 'tier', tierText(s.tier)), el('span', 'nm', `${names.model(backend, model) || model}${t('routing.line.join')}${names.backend(backend)}`), el('span', 'rs', reason));
    list.append(li);
  }
  fold.append(list);
  return failure.skipped.length ? [why, fold] : [why];
}

// ---------------------------------------------------------------- DOM

/** 使用量の行（枠の名前・棒・率）。ヘッダーの使用量の面と同じ部品（web/usage.css の .usage-rows） */
export function usageRows(windows, { avoidPercent = 80 } = {}) {
  const rows = el('div', 'usage-rows rt-usage');
  for (const w of windows ?? []) {
    const p = percent(w.usedPercent);
    const high = p != null && p >= avoidPercent ? ' hi' : '';
    const label = el('span', 'wl', w.label ?? '');
    label.title = w.label ?? '';
    rows.append(label);
    const bar = el('span', 'usage-bar' + high);
    const fill = el('i');
    fill.style.width = `${Math.max(0, Math.min(100, p ?? 0))}%`;
    bar.append(fill);
    rows.append(bar, el('span', 'v' + high, p == null ? '—' : `${p}%`));
  }
  return rows;
}

function fact(label, value) {
  const row = el('div');
  row.append(el('dt', null, label), el('dd', null, value));
  return row;
}

/** 候補 1 つ（使った・飛ばした）。n は試した順 */
function candidateCard({ n, backend, model, used, skipped, windows, usageAt }, { names, logo }) {
  const card = el('div', 'rt-cand' + (used ? ' used' : ''));
  const head = el('div', 'rt-cand-head');
  head.append(el('span', 'rt-n', String(n)), logo(backend));
  head.append(el('b', null, names.model(backend, model) || model));
  const state = used ? t('routing.detail.used') : t('routing.detail.skipped', { reason: skipText(skipped.reason, skipped.detail) });
  head.append(el('span', 'rt-state' + (used ? ' used' : ''), state));
  card.append(head);
  if (windows?.length) card.append(usageRows(windows));
  const notes = [];
  if (skipped?.window?.pace != null) notes.push(t('routing.detail.pace', { pace: skipped.window.pace }));
  for (const a of skipped?.accounts ?? []) {
    const name = a.account === '' ? t('routing.detail.loginAccount') : a.label || a.account;
    const w = a.window && percent(a.window.usedPercent) != null ? ` ${a.window.label ?? ''} ${percent(a.window.usedPercent)}%` : '';
    notes.push(`${t('routing.detail.account', { name })} · ${skipText(a.reason)}${w}`);
  }
  // 取得時刻は上の「使用量の取得」と違うときだけ（古くて飛ばした候補など）
  if (skipped?.checkedAt && skipped.checkedAt !== usageAt) notes.push(`${t('routing.detail.usageAt')} ${fmt.dateTime(skipped.checkedAt)}`);
  for (const line of notes) card.append(el('small', 'rt-note', line));
  return card;
}

/**
 * 委譲カードを開いたときの内訳。種類・難しさ・段・判定・はいだった手がかり・使用量の取得時刻と、試した候補を順に。
 * opts: { names, logo(backend), onRetry?(root) } onRetry が無ければ「別の候補でやり直す」を出さない
 */
export function routingDetail(routing, { names = defaultNames, logo = () => el('span'), onRetry = null } = {}) {
  const root = el('div', 'rt-detail');
  root.setAttribute('role', 'group');
  root.setAttribute('aria-label', t('routing.detail.label'));
  const facts = el('dl', 'rt-facts');
  const yes = yesSignals(routing);
  facts.append(fact(t('routing.detail.kind'), kindText(routing.kind)), fact(t('routing.detail.difficulty'), difficultyText(routing.difficulty)),
    fact(t('routing.detail.tier'), tierLine(routing)), fact(t('routing.detail.judge'), judgeLine(routing)),
    fact(t('routing.detail.signals'), yes.length ? fmt.list(yes) : t('routing.detail.noSignals')));
  if (routing.usageAt) facts.append(fact(t('routing.detail.usageAt'), fmt.dateTime(routing.usageAt)));
  root.append(facts);
  const list = el('div', 'rt-cands');
  let n = 0;
  for (const s of routing.skipped ?? []) {
    const { backend, model } = splitCandidate(s.candidate);
    list.append(candidateCard({ n: ++n, backend, model, used: false, skipped: s, usageAt: routing.usageAt, windows: s.window && percent(s.window.usedPercent) != null ? [s.window] : [] }, { names, logo }));
  }
  if (routing.target) list.append(candidateCard({ n: ++n, backend: routing.target.backend, model: routing.target.model, used: true, windows: routing.targetWindows ?? [] }, { names, logo }));
  root.append(list);
  // やり直したタスク（client.mjs の paintRetried が中身を入れる）
  root.append(el('div', 'rt-retried'));
  if (onRetry) {
    const actions = el('div', 'rt-actions');
    const open = el('button', 'btn rt-retry-open', t('routing.retry.open'));
    open.type = 'button';
    open.setAttribute('aria-expanded', 'false');
    open.onclick = e => { e.preventDefault(); onRetry(root, open); };
    actions.append(open);
    root.append(actions);
  }
  return root;
}

/**
 * 自動でない委譲を開いたときの内訳。種類・委譲先（依頼元が指定）・承認モード・作業場所の格子だけ。
 * 判定・候補・やり直しは自動のときだけの部品なので出さない。mode は表示名、cwd は子の作業場所（分からなければ出さない）
 */
export function pinnedDetail(routing, { names = defaultNames, mode = '', cwd = '' } = {}) {
  const root = el('div', 'rt-detail');
  root.setAttribute('role', 'group');
  root.setAttribute('aria-label', t('routing.detail.label'));
  const facts = el('dl', 'rt-facts');
  const target = targetText(routing?.target, names);
  facts.append(fact(t('routing.detail.kind'), kindText(routing?.kind)),
    fact(t('routing.detail.target'), routing?.mode === 'pinned' ? t('routing.detail.targetPinned', { target }) : target));
  if (mode) facts.append(fact(t('routing.detail.mode'), mode));
  if (cwd) facts.append(fact(t('routing.detail.cwd'), cwd));
  root.append(facts);
  return root;
}

/**
 * 「別の候補でやり直す」の面。candidates は retryCandidates の結果（今使えるもの）。
 * run({ candidate, stop, approved }) はサーバーへ頼む関数で、{ confirm } が返れば承認の一行を出して待つ。
 * running は元のタスクが動いているか（止めるかどうかを選ばせる）
 */
export function retryPanel({ candidates, running, names = defaultNames, logo = () => el('span'), run, close }) {
  const panel = el('div', 'rt-retry');
  panel.append(el('div', 'rt-retry-title', t('routing.retry.title')));
  const note = el('p', 'rt-retry-note');
  note.setAttribute('role', 'status');
  if (!candidates.length) {
    panel.append(el('p', 'rt-retry-empty', t('routing.retry.none')));
    const actions = el('div', 'rt-retry-actions');
    const cancel = el('button', 'btn', t('routing.retry.cancel'));
    cancel.type = 'button';
    cancel.onclick = () => close();
    actions.append(cancel);
    panel.append(actions);
    return panel;
  }
  const group = el('div', 'rt-retry-list');
  group.setAttribute('role', 'radiogroup');
  group.setAttribute('aria-label', t('routing.retry.title'));
  const name = `rt-${Math.random().toString(36).slice(2)}`;
  // approved: 承認モードが強くなることを見せた後。stopChoice: そのときに選んだ「止める・止めない」（承認で同じ選び方のまま頼む）
  let chosen = candidates[0].candidate, approved = false, stopChoice = true;
  for (const c of candidates) {
    const label = el('label', 'rt-option');
    const input = el('input');
    input.type = 'radio'; input.name = name; input.value = c.candidate; input.checked = c.candidate === chosen;
    input.onchange = () => { chosen = c.candidate; approved = false; paint(); };
    const text = el('span', 'rt-option-text');
    const title = el('span', 'rt-option-name');
    title.append(logo(c.backend), el('span', null, names.model(c.backend, c.model) || c.model));
    const sub = [...(c.tiers ?? []).map(tierText), usageSummary(c)].filter(Boolean).join(t('routing.line.join'));
    text.append(title, el('small', null, sub));
    label.append(input, text);
    group.append(label);
  }
  panel.append(group);
  if (running) panel.append(el('p', 'rt-retry-running', t('routing.retry.running')));
  const warn = el('p', 'rt-retry-warn');
  warn.hidden = true;
  const actions = el('div', 'rt-retry-actions');
  panel.append(warn, actions, note);
  const nameOf = () => { const c = candidates.find(x => x.candidate === chosen); return names.model(c.backend, c.model) || c.model; };
  const go = async (stop, button) => {
    stopChoice = stop;
    for (const b of actions.querySelectorAll('button')) b.disabled = true;
    note.textContent = '';
    try {
      const result = await run({ candidate: chosen, ...(running ? { stop } : {}), ...(approved ? { approved: true } : {}) });
      if (result?.confirm) {
        approved = true;
        warn.textContent = `⚠ ${t('routing.retry.escalation', result.confirm)}`;
        warn.hidden = false;
        paint();
        return;
      }
      close(result);
    } catch (e) {
      note.textContent = t('routing.retry.failed', { error: e.message });
      for (const b of actions.querySelectorAll('button')) b.disabled = false;
      button?.focus();
    }
  };
  function paint() {
    if (!approved) warn.hidden = true;
    const buttons = [];
    const primary = (text, stop) => { const b = el('button', 'btn btn-primary', text); b.type = 'button'; b.onclick = () => go(stop, b); return b; };
    if (approved) buttons.push(primary(t('routing.retry.approve'), stopChoice));
    else if (running) {
      buttons.push(primary(t('routing.retry.stopAndRun', { name: nameOf() }), true));
      const keep = el('button', 'btn', t('routing.retry.keepAndRun'));
      keep.type = 'button';
      keep.onclick = () => go(false, keep);
      buttons.push(keep);
    } else buttons.push(primary(t('routing.retry.run', { name: nameOf() }), false));
    const cancel = el('button', 'btn', t('routing.retry.cancel'));
    cancel.type = 'button';
    cancel.onclick = () => close();
    buttons.push(cancel);
    actions.replaceChildren(...buttons);
  }
  paint();
  return panel;
}
