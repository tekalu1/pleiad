// 委譲先の自動振り分け（docs/agent-delegation.md「委譲先の自動振り分け」。決定は docs/adr/0022-delegation-routing.md）。
//
// ここはプロセスも HTTP も起こさない純粋な関数だけを置く。難しさの判定器（HTTP）は core/delegation-judges.mjs、
// 使用量の取り置き（定期的な取得）は core/delegation-usage.mjs。
//
//   種類（kind）   … 親のエージェントが ply_delegate で申告する
//   難しさ          … 判定器の 6 つの手がかり（SIGNALS）から規則（difficultyOf）で数える
//   段（tier）      … 種類 × 難しさの表（table）
//   委譲先          … 段の候補を左から、使用量の枠で飛ばしながら選ぶ（route）。無ければ 1 つ上の段へ

export const KINDS = Object.freeze(['trivial', 'mechanical', 'investigate', 'implement', 'review', 'design', 'ux_change', 'ux_new', 'visual']);
export const DIFFICULTIES = Object.freeze(['low', 'mid', 'high']);
export const TIERS = Object.freeze(['t1', 't2', 't3', 't4', 'tv']);
/** 上がっていく段の順。tv（画像・新規 UX）はこの列に入らず、上がらない */
const LADDER = ['t1', 't2', 't3', 't4'];
export const JUDGES = Object.freeze(['jev', 'cerebras', 'none']);

// 難しさの手がかり（v3）。英語の文面がそのまま判定器への問いになる。閾値は Jev の「はい」の確率を真偽に分ける線
export const SIGNALS = Object.freeze(['diagnose', 'choose', 'long_procedure', 'many_parts', 'writes_shared', 'security_gate']);
export const QUESTIONS = Object.freeze({
  diagnose: 'The task is to find the cause of a bug, failure, or unexpected behavior, and the cause is not already stated in the request. Reading documents, listing facts, or reviewing against given criteria is not this.',
  choose: 'The child must choose between approaches, designs, or recommendations, and the request does not already fix that choice. Small implementation details (names, test style, minor values) do not count.',
  long_procedure: 'The work needs many dependent steps (roughly six or more, such as starting servers or setting up environments), and a failure midway must be recovered by the child itself.',
  many_parts: 'The work reads or changes many separate parts: roughly ten or more files, or three or more separate screens, subsystems, or services. Bulk edits that apply one fixed rule to many files do not count.',
  writes_shared: 'The task writes to something shared, production, public, or external (shared documents or databases, deployed services, pushes, messages to people), or deletes data that cannot be restored. Local files and local commits do not count.',
  security_gate: 'The result is the final check on security, privacy, or safety, such as a security review before release or a change to safety requirements.',
});
export const JEV_THRESHOLDS = Object.freeze({ diagnose: 0.5, choose: 0.31, long_procedure: 0.685, many_parts: 0.68, writes_shared: 0.5, security_gate: 0.19 });
/** 「Jev が迷った」とみなす幅（閾値 ± これ） */
export const JEV_UNSURE_BAND = 0.15;

export const DEFAULTS = Object.freeze({
  enabled: true,
  judgeByKind: Object.freeze({ trivial: 'jev', mechanical: 'jev', investigate: 'jev', implement: 'jev', review: 'jev',
    design: 'jev', ux_change: 'none', ux_new: 'none', visual: 'none' }),
  escalateToCerebras: false,
  avoidPercent: 80,
  paceLimit: 1.2,
  staleMinutes: 15,
  tiers: Object.freeze({
    t1: Object.freeze(['antigravity:gemini-3.8-flash-high', 'claude:haiku']),
    t2: Object.freeze(['antigravity:gemini-3.8-flash-high', 'codex:gpt-6-luna', 'antigravity:claude-opus-4-6-thinking', 'claude:sonnet']),
    t3: Object.freeze(['codex:gpt-6-sol', 'claude:sonnet']),
    t4: Object.freeze(['claude:opus', 'claude:fable']),
    tv: Object.freeze(['codex:gpt-6-astra']),
  }),
  table: Object.freeze({
    trivial: Object.freeze(['t1', 't1', 't2']), mechanical: Object.freeze(['t1', 't2', 't3']),
    investigate: Object.freeze(['t2', 't3', 't4']), implement: Object.freeze(['t2', 't3', 't4']), review: Object.freeze(['t2', 't3', 't4']),
    design: Object.freeze(['t3', 't4', 't4']), ux_change: Object.freeze(['t4', 't4', 't4']),
    ux_new: Object.freeze(['tv', 'tv', 'tv']), visual: Object.freeze(['tv', 'tv', 'tv']),
  }),
});
/** 週次の枠のペース（使用率 ÷ 経過率）を見始める経過率（%） */
export const PACE_MIN_ELAPSED = 20;
const WEEK_MINUTES = 10080;

/** 候補の id（`backend:model`）。model に `:` が入っても最初の `:` で分ける */
export function parseCandidate(id) {
  const s = typeof id === 'string' ? id : '';
  const at = s.indexOf(':');
  if (at <= 0 || at === s.length - 1 || s.length > 240 || /[\x00-\x1f\x7f\s]/.test(s)) return null;
  return { backend: s.slice(0, at), model: s.slice(at + 1) };
}

/** 設定の検証で断る理由。code は辞書のキー（server の routing.settings.<code>）、detail は差し込む値 */
export class RoutingSettingsError extends Error {
  constructor(code, detail = {}) { super(code); this.code = code; this.detail = detail; }
}

/**
 * prefs.json の delegationRouting を、既定値で補った完全な形にする。
 * strict なら不正な値を RoutingSettingsError で断る（画面からの保存）。そうでなければ不正な項目だけ既定に戻す（読むとき）
 */
export function normalizeSettings(raw, { strict = false } = {}) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const fail = (code, detail) => { if (strict) throw new RoutingSettingsError(code, detail); };
  const out = { enabled: DEFAULTS.enabled, judgeByKind: { ...DEFAULTS.judgeByKind }, escalateToCerebras: DEFAULTS.escalateToCerebras,
    avoidPercent: DEFAULTS.avoidPercent, paceLimit: DEFAULTS.paceLimit, staleMinutes: DEFAULTS.staleMinutes,
    tiers: Object.fromEntries(Object.entries(DEFAULTS.tiers).map(([k, v]) => [k, [...v]])),
    table: Object.fromEntries(Object.entries(DEFAULTS.table).map(([k, v]) => [k, [...v]])) };
  for (const key of Object.keys(src)) if (!Object.hasOwn(out, key)) fail('unknownKey', { key });
  for (const key of ['enabled', 'escalateToCerebras']) {
    if (src[key] === undefined) continue;
    if (typeof src[key] === 'boolean') out[key] = src[key]; else fail('notBoolean', { key });
  }
  const numbers = { avoidPercent: [1, 100], paceLimit: [0.1, 10], staleMinutes: [1, 1440] };
  for (const [key, [min, max]] of Object.entries(numbers)) {
    if (src[key] === undefined) continue;
    const v = src[key];
    if (typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max) out[key] = v; else fail('outOfRange', { key, min, max });
  }
  if (src.judgeByKind !== undefined) {
    if (!src.judgeByKind || typeof src.judgeByKind !== 'object' || Array.isArray(src.judgeByKind)) fail('notObject', { key: 'judgeByKind' });
    else for (const [kind, judge] of Object.entries(src.judgeByKind)) {
      if (!KINDS.includes(kind)) fail('unknownKind', { key: 'judgeByKind', kind });
      else if (!JUDGES.includes(judge)) fail('unknownJudge', { kind, judge: String(judge) });
      else out.judgeByKind[kind] = judge;
    }
  }
  if (src.tiers !== undefined) {
    if (!src.tiers || typeof src.tiers !== 'object' || Array.isArray(src.tiers)) fail('notObject', { key: 'tiers' });
    else for (const [tier, list] of Object.entries(src.tiers)) {
      if (!TIERS.includes(tier)) { fail('unknownTier', { tier }); continue; }
      if (!Array.isArray(list) || list.length > 20 || list.some(c => !parseCandidate(c)) || new Set(list).size !== list.length) { fail('badCandidates', { tier }); continue; }
      out.tiers[tier] = [...list];
    }
  }
  if (src.table !== undefined) {
    if (!src.table || typeof src.table !== 'object' || Array.isArray(src.table)) fail('notObject', { key: 'table' });
    else for (const [kind, row] of Object.entries(src.table)) {
      if (!KINDS.includes(kind)) { fail('unknownKind', { key: 'table', kind }); continue; }
      if (!Array.isArray(row) || row.length !== 3 || row.some(tier => !TIERS.includes(tier))) { fail('badRow', { kind }); continue; }
      out.table[kind] = [...row];
    }
  }
  return out;
}

/**
 * 難しさの規則（v3・規則 A）。security_gate → high。それ以外は diagnose / choose / long_procedure / many_parts の
 * はいの数で 0 → low、1〜2 → mid、3〜4 → high。writes_shared がはいで low なら mid
 */
export function difficultyOf(signals) {
  if (!validSignals(signals)) throw new Error('invalid signals');
  if (signals.security_gate) return 'high';
  const count = ['diagnose', 'choose', 'long_procedure', 'many_parts'].filter(k => signals[k]).length;
  if (count >= 3) return 'high';
  return count >= 1 || signals.writes_shared ? 'mid' : 'low';
}
export function validSignals(signals) {
  return Boolean(signals) && typeof signals === 'object' && !Array.isArray(signals)
    && Object.keys(signals).length === SIGNALS.length && SIGNALS.every(k => typeof signals[k] === 'boolean');
}

// ---- 使用量 ------------------------------------------------------------------

/** 枠の今の使用率。リセット時刻を過ぎた枠は使い直しが始まっているので 0 とみなす。分からなければ null */
function usedNow(w, now) {
  if (w.resetsAt != null && Number.isFinite(new Date(w.resetsAt).getTime()) && new Date(w.resetsAt).getTime() <= now) return 0;
  return typeof w.usedPercent === 'number' && Number.isFinite(w.usedPercent) ? w.usedPercent : null;
}
/** 枠の経過率（%）。期間とリセット時刻から出す。出せない・範囲外なら null */
export function elapsedPercent(w, now) {
  const reset = w.resetsAt == null ? NaN : new Date(w.resetsAt).getTime();
  if (!Number.isFinite(reset) || !(w.minutes > 0)) return null;
  const span = w.minutes * 60_000;
  const elapsed = (now - (reset - span)) / span * 100;
  return elapsed >= 0 && elapsed <= 100 ? elapsed : null;
}

const words = s => String(s ?? '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
const squash = s => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
const claudeFamily = s => /(fable|opus|sonnet|haiku)/i.exec(String(s ?? ''))?.[1].toLowerCase() ?? null;

/**
 * その候補に効く枠。
 *   claude      … 全体の枠（5 時間・週次）と、そのモデルの系統の週次（seven_day_opus / model_scoped）
 *   codex       … 主の枠（limitId が codex か無し）と、名前がそのモデルに当たる追加の枠
 *   antigravity … モデル名の語をいちばん多く含むグループの枠（gemini-* → Gemini …、claude-* / gpt-* → Claude and GPT …）
 */
export function windowsFor(backend, model, windows = []) {
  const list = Array.isArray(windows) ? windows : [];
  if (backend === 'claude') {
    const family = claudeFamily(model);
    return list.filter(w => !w.model || (family && claudeFamily(w.model) === family));
  }
  if (backend === 'codex') {
    const matches = name => Boolean(name) && (squash(model).includes(name) || name.includes(squash(model)));
    return list.filter(w => !w.limitId || w.limitId === 'codex' || matches(squash(w.limitName || w.limitId)));
  }
  if (backend === 'antigravity') {
    const modelWords = new Set(words(model));
    const family = ['gemini', 'claude', 'gpt'].find(f => modelWords.has(f));
    if (!family) return [];
    const scored = [...new Set(list.map(w => w.group).filter(Boolean))]
      .filter(g => words(g).includes(family))
      .map(g => [g, words(g).filter(x => modelWords.has(x)).length]);
    if (!scored.length) return [];
    const best = Math.max(...scored.map(([, s]) => s));
    const groups = new Set(scored.filter(([, s]) => s === best).map(([g]) => g));
    return list.filter(w => groups.has(w.group));
  }
  return list;
}

/**
 * 枠の集まりで使えるか。{ ok, reason?, window? }。
 *   どれかの枠が「避ける線」以上 → quota_high
 *   週次の枠のペースが上限を超える（経過率 20% 未満は見ない）→ pace_high
 *   経過率が出せない週次の枠は、使用率が 20% × 上限以下ならペースで落ちることが無いので通し、超えれば pace_unknown
 *   使用率が分からない枠がある・枠が 1 つも無い → usage_unknown
 */
export function judgeWindows(windows, { now, avoidPercent, paceLimit }) {
  if (!windows.length) return { ok: false, reason: 'usage_unknown' };
  const rows = windows.map(w => ({ w, used: usedNow(w, now) }));
  const unknown = rows.find(r => r.used == null);
  if (unknown) return { ok: false, reason: 'usage_unknown', window: brief(unknown.w, null) };
  const high = rows.filter(r => r.used >= avoidPercent).sort((a, b) => b.used - a.used)[0];
  if (high) return { ok: false, reason: 'quota_high', window: brief(high.w, high.used) };
  for (const { w, used } of rows) {
    if (w.minutes !== WEEK_MINUTES) continue;
    const elapsed = elapsedPercent(w, now);
    if (elapsed == null) {
      if (used > PACE_MIN_ELAPSED * paceLimit) return { ok: false, reason: 'pace_unknown', window: brief(w, used) };
      continue;
    }
    if (elapsed < PACE_MIN_ELAPSED) continue;
    const pace = used / elapsed;
    if (pace > paceLimit) return { ok: false, reason: 'pace_high', window: { ...brief(w, used), pace: round(pace, 2), elapsedPercent: round(elapsed, 1) } };
  }
  return { ok: true };
}
const round = (v, d) => Math.round(v * 10 ** d) / 10 ** d;
const brief = (w, used) => ({ label: w.label ?? null, minutes: w.minutes ?? null, usedPercent: used == null ? null : round(used, 1) });

/** 週次のペース（アカウントの選び分け用）。分からなければ Infinity（後ろに回す） */
function weeklyPace(windows, now) {
  const weekly = windows.filter(w => w.minutes === WEEK_MINUTES && !w.model && !w.limitName);
  const paces = weekly.map(w => { const used = usedNow(w, now), elapsed = elapsedPercent(w, now); return used == null ? Infinity : elapsed ? used / elapsed : used / 100; });
  return paces.length ? Math.max(...paces) : Infinity;
}
function fiveHour(windows, now) {
  const used = windows.filter(w => w.minutes === 300).map(w => usedNow(w, now)).filter(v => v != null);
  return used.length ? Math.max(...used) : Infinity;
}

/**
 * Claude のアカウントの重複を落とす。今の使用量では「ログイン中のアカウント」と、登録したアカウントのうち同じ人のものが
 * 同じ値で並ぶ。組織（organizationUuid）とメールの両方が分かって一致するものだけを同一とし、1 つだけ残す。
 * 残すのは prefer を満たすもの（振り分けでは使えるもの。片方だけ使用量の取得に失敗していることがある）のうち先頭、
 * 無ければログイン中の方。どちらかが分からなければまとめない（docs/agent-delegation.md）
 */
export function dedupeAccounts(accounts = [], prefer = () => false) {
  const same = (a, b) => a?.org && b?.org && a?.email && b?.email && a.org === b.org && a.email.toLowerCase() === b.email.toLowerCase();
  const login = accounts.find(a => a.account === '');
  const inGroup = a => a === login || (Boolean(login) && same(a.identity, login.identity));
  const keep = accounts.filter(inGroup).find(prefer) ?? login;
  return accounts.filter(a => !inGroup(a) || a === keep);
}

/**
 * 1 つの候補を見る。{ ok, reason?, detail?, account?, window?, checkedAt }
 * detail は unavailable の中身（画面が「使えない（入っていない）」と添える）: disabled（エージェントが有効でない）・
 * not_installed（CLI が入っていない）・no_token（登録したアカウントにトークンが無い）
 * usage は core/delegation-usage.mjs の snapshot()：
 *   { [backend]: { available, checkedAt, windows, accounts?: [{ account, label, windows, identity, runnable }], models: { [model]: bool } } }
 */
export function checkCandidate(candidate, { usage, settings, now }) {
  const parsed = parseCandidate(candidate);
  const entry = parsed ? usage?.[parsed.backend] : null;
  // 使用量をまだ一度も取っていない（取り置きが空）ときは、有効かどうかも分からないので中身を付けない
  if (!parsed || !entry?.available) return { ok: false, reason: 'unavailable', ...(!parsed ? {} : entry ? { detail: 'not_installed' } : Object.keys(usage ?? {}).length ? { detail: 'disabled' } : {}) };
  if (entry.models?.[parsed.model] !== true) return { ok: false, reason: 'model_unknown' };
  const checkedAt = entry.checkedAt ?? null;
  if (checkedAt == null) return { ok: false, reason: 'usage_unknown' };
  if (now - checkedAt > settings.staleMinutes * 60_000) return { ok: false, reason: 'usage_stale', checkedAt };
  const policy = { now, avoidPercent: settings.avoidPercent, paceLimit: settings.paceLimit };
  if (parsed.backend === 'claude' && Array.isArray(entry.accounts)) {
    const results = dedupeAccounts(entry.accounts.map(a => {
      if (!a.runnable) return { account: a.account, label: a.label ?? null, identity: a.identity, ok: false, reason: 'unavailable' };
      const windows = windowsFor('claude', parsed.model, a.windows);
      return { account: a.account, label: a.label ?? null, identity: a.identity, windows, ...judgeWindows(windows, policy) };
    }), r => r.ok);
    const usable = results.filter(r => r.ok);
    if (!usable.length) {
      const first = results.find(r => r.reason !== 'unavailable') ?? results[0];
      return { ok: false, reason: first?.reason ?? 'usage_unknown', ...(first?.reason === 'unavailable' ? { detail: 'no_token' } : {}), ...(first?.window ? { window: first.window } : {}), checkedAt,
        accounts: results.map(({ account, label, reason, window }) => ({ account, label, reason, ...(window ? { window } : {}) })) };
    }
    usable.sort((a, b) => weeklyPace(a.windows, now) - weeklyPace(b.windows, now) || fiveHour(a.windows, now) - fiveHour(b.windows, now));
    return { ok: true, account: usable[0].account, checkedAt, windows: usable[0].windows.map(w => brief(w, usedNow(w, now))) };
  }
  const windows = windowsFor(parsed.backend, parsed.model, entry.windows);
  const verdict = judgeWindows(windows, policy);
  return { ...verdict, account: parsed.backend === 'claude' ? '' : null, checkedAt, ...(verdict.ok ? { windows: windows.map(w => brief(w, usedNow(w, now))) } : {}) };
}

/** 振り分けの記録（ply_delegate の返り値の routing。タスクと子会話のメタデータにも同じ形で残す） */
export function pinnedRouting({ kind, backend, model = null }) {
  return { mode: 'pinned', kind, judge: null, signals: null, probabilities: null, difficulty: null, tier: null,
    target: { backend, model: model ?? null, account: null }, skipped: [], usageAt: null, fallback: null };
}

/**
 * 人が委譲カードの「別の候補でやり直す」で選んだ委譲先の記録。元のタスク（retry.of）と、元の委譲先（retry.from）に結び付ける。
 * 判定はしていないので judge などは null。check は checkCandidate の結果（使える候補だけを渡す）
 */
export function manualRouting({ kind, candidate, check, of, from }) {
  const { backend, model } = parseCandidate(candidate);
  return { mode: 'manual', kind, judge: null, signals: null, probabilities: null, difficulty: null, tier: null,
    target: { backend, model, account: check.account ?? null }, skipped: [],
    usageAt: check.checkedAt == null ? null : new Date(check.checkedAt).toISOString(), fallback: null,
    ...(check.windows ? { targetWindows: check.windows } : {}),
    retry: { of, from: from ? { backend: from.backend ?? null, model: from.model ?? null, account: from.account ?? null } : null, by: 'user' } };
}

/**
 * 段・候補を選ぶ。judged は判定の結果 { judge, signals, probabilities, fallback }（signals が null なら難しさは mid）。
 * rejected は、選んだ後の確かめで落ちた候補と理由（{ 'codex:gpt-6-sol': 'model_unknown' }。server が委譲先の cwd で
 * モデルを確かめ直し、だめなら足して選び直す）。
 * 選べれば { ok: true, routing }、全部だめなら { ok: false, routing }（target は null）。
 * usageAt は選んだ候補の使用量の取得時刻（選べなければ見た中で最も古いもの）
 */
export function route({ kind, judged = {}, settings, usage, now = Date.now(), rejected = {} }) {
  const difficulty = judged.signals ? difficultyOf(judged.signals) : 'mid';
  const base = settings.table[kind][DIFFICULTIES.indexOf(difficulty)];
  const sequence = base === 'tv' ? ['tv'] : LADDER.slice(LADDER.indexOf(base));
  const skipped = [];
  const seen = [];
  const iso = v => v == null ? null : new Date(v).toISOString();
  const routing = target => {
    const times = seen.filter(v => v != null);
    return { mode: 'auto', kind, judge: judged.judge ?? 'none', signals: judged.signals ?? null, probabilities: judged.probabilities ?? null,
      difficulty, baseTier: base, tier: target?.tier ?? null, target: target ? { backend: target.backend, model: target.model, account: target.account } : null,
      // 選んだ候補に効いた枠の今の使用率（委譲カードの内訳に出す。飛ばした候補は skipped[].window）
      ...(target?.windows ? { targetWindows: target.windows } : {}),
      skipped, usageAt: target ? iso(target.checkedAt) : times.length ? iso(Math.min(...times)) : null, fallback: judged.fallback ?? null,
      ...(judged.escalated ? { escalated: true } : {}) };
  };
  for (const tier of sequence) {
    for (const candidate of settings.tiers[tier] ?? []) {
      const check = Object.hasOwn(rejected, candidate) ? { ok: false, reason: rejected[candidate] } : checkCandidate(candidate, { usage, settings, now });
      if (check.checkedAt != null) seen.push(check.checkedAt);
      if (check.ok) {
        const { backend, model } = parseCandidate(candidate);
        return { ok: true, routing: routing({ tier, backend, model, account: check.account, checkedAt: check.checkedAt, windows: check.windows }) };
      }
      skipped.push({ candidate, tier, reason: check.reason, ...(check.detail ? { detail: check.detail } : {}), ...(check.window ? { window: check.window } : {}), ...(check.accounts ? { accounts: check.accounts } : {}),
        ...(check.checkedAt != null ? { checkedAt: iso(check.checkedAt) } : {}) });
    }
  }
  return { ok: false, routing: routing(null) };
}

/**
 * 候補ごとの今の状態（設定画面の段ごとの候補と、各候補の使用量）。settings の全段の候補を重複なく
 */
export function candidateStates({ settings, usage, now = Date.now() }) {
  const ids = [...new Set(TIERS.flatMap(tier => settings.tiers[tier] ?? []))];
  return ids.map(candidate => {
    const parsed = parseCandidate(candidate);
    const check = checkCandidate(candidate, { usage, settings, now });
    const entry = parsed ? usage?.[parsed.backend] : null;
    const accountRows = parsed?.backend === 'claude' && Array.isArray(entry?.accounts) ? dedupeAccounts(entry.accounts) : null;
    return { candidate, backend: parsed?.backend ?? null, model: parsed?.model ?? null,
      tiers: TIERS.filter(tier => (settings.tiers[tier] ?? []).includes(candidate)),
      usable: check.ok, reason: check.ok ? null : check.reason, ...(check.detail ? { detail: check.detail } : {}), account: check.ok ? check.account ?? null : null,
      ...(check.window ? { window: check.window } : {}),
      checkedAt: entry?.checkedAt ? new Date(entry.checkedAt).toISOString() : null,
      windows: parsed && !accountRows ? windowsFor(parsed.backend, parsed.model, entry?.windows).map(w => brief(w, usedNow(w, now))) : [],
      ...(accountRows ? { accounts: accountRows.map(a => ({ account: a.account, label: a.label ?? null, runnable: Boolean(a.runnable),
        windows: windowsFor('claude', parsed.model, a.windows).map(w => brief(w, usedNow(w, now))) })) } : {}) };
  });
}

/** 設定の検証で知らせること（今のモデル一覧に無い候補・使えないバックエンド）。黙って消さない */
export function settingsWarnings({ settings, usage }) {
  const out = [];
  for (const candidate of [...new Set(TIERS.flatMap(tier => settings.tiers[tier] ?? []))]) {
    const parsed = parseCandidate(candidate);
    const entry = usage?.[parsed.backend];
    if (!entry?.available) out.push({ candidate, reason: 'unavailable' });
    else if (entry.models?.[parsed.model] !== true) out.push({ candidate, reason: 'model_unknown' });
  }
  return out;
}
