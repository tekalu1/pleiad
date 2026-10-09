// 委譲先の自動振り分け（core/delegation-routing.mjs・delegation-judges.mjs・delegation-usage.mjs）。
// 判定器は偽の fetch とだけ話す（本物の OpenRouter へは送らない）。LLM は呼ばない
import { KINDS, JUDGES, SIGNALS, DEFAULTS, EFFORT_LEVELS, normalizeSettings, migrateLegacySettings, pruneEfforts, fitEffort, decideEffort, effortTierFor, RoutingSettingsError, difficultyOf, judgeWindows, windowsFor, checkCandidate, selectRetryAccount, dedupeAccounts,
  route, pinnedRouting, manualRouting, candidateStates, settingsWarnings, parseCandidate, elapsedPercent, formatSkippedCandidates } from '../../core/delegation-routing.mjs';
import { askJev, askQwen, judgeDifficulty, normalizeKey, TASK_LIMIT, JEV_MODEL, QWEN_MODEL } from '../../core/delegation-judges.mjs';
import { createUsageMonitor, REFRESH_MS, STALE_MS } from '../../core/delegation-usage.mjs';
import { claudeQuota, codexQuota } from '../../core/usage.mjs';
import { antigravityQuota } from '../../core/backends/antigravity-usage.mjs';

export const name = 'delegation-routing';
export const title = '委譲先の自動振り分け: 規則・段・使用量の後回し・Claude のアカウント・判定器（偽の HTTP）・使用量の取り置き';

const NOW = Date.parse('2026-09-26T12:00:00Z');
const HOUR = 3600_000, DAY = 24 * HOUR;
const zero = Object.fromEntries(SIGNALS.map(k => [k, false]));
// 週次の枠。used% で、経過率 elapsed%（リセットまでの残りから逆算）
const week = (used, elapsed, extra = {}) => ({ label: 'week', usedPercent: used, minutes: 10080, resetsAt: new Date(NOW + (100 - elapsed) / 100 * 7 * DAY).toISOString(), ...extra });
const h5 = (used, extra = {}) => ({ label: '5h', usedPercent: used, minutes: 300, resetsAt: new Date(NOW + HOUR).toISOString(), ...extra });
const models = ids => Object.fromEntries(ids.map(id => [id, true]));
const ALL_MODELS = { claude: models(['haiku', 'sonnet', 'opus', 'fable']), codex: models(['gpt-6-luna', 'gpt-6-sol', 'gpt-6-astra']),
  antigravity: models(['gemini-3.8-flash-high', 'claude-opus-4-6-thinking']) };
/** 検証（policy.mjs）の場面を振り分けの snapshot にする。claude は main（ログイン中）と oz（登録）の 2 アカウント */
function scenario({ main, oz, codex, agGemini, agClaude }) {
  const acct = (id, u) => ({ account: id, label: id || 'login', runnable: true, identity: { org: `org-${id || 'main'}`, email: `${id || 'main'}@example.com` },
    windows: [h5(u.h5), week(u.week[0], u.week[1])] });
  return {
    claude: { available: true, checkedAt: NOW - 60_000, windows: [], accounts: [acct('', main), acct('acct-oz', oz)], models: ALL_MODELS.claude },
    codex: { available: true, checkedAt: NOW - 60_000, windows: codex.week ? [week(codex.week[0], codex.week[1], { limitId: 'codex' })] : [], models: ALL_MODELS.codex },
    antigravity: { available: true, checkedAt: NOW - 60_000, models: ALL_MODELS.antigravity, windows: [
      h5(agGemini.h5, { group: 'Gemini Models' }), week(agGemini.week, 50, { group: 'Gemini Models' }),
      h5(agClaude.h5, { group: 'Claude and GPT models' }), week(agClaude.week, 50, { group: 'Claude and GPT models' })] },
  };
}
const S1 = scenario({ main: { h5: 30, week: [50, 60] }, oz: { h5: 10, week: [20, 60] }, codex: { week: [11, 40] }, agGemini: { h5: 0, week: 0 }, agClaude: { h5: 1, week: 1 } });
const S2 = scenario({ main: { h5: 40, week: [85, 70] }, oz: { h5: 96, week: [42, 70] }, codex: { week: [20, 50] }, agGemini: { h5: 0, week: 0 }, agClaude: { h5: 5, week: 2 } });
const S3 = scenario({ main: { h5: 20, week: [40, 50] }, oz: { h5: 0, week: [10, 50] }, codex: { week: [92, 80] }, agGemini: { h5: 0, week: 0 }, agClaude: { h5: 1, week: 1 } });
const S4 = scenario({ main: { h5: 96, week: [60, 60] }, oz: { h5: 20, week: [30, 40] }, codex: { week: [30, 50] }, agGemini: { h5: 10, week: 3 }, agClaude: { h5: 1, week: 1 } });
const settings = normalizeSettings({});
const target = r => r.ok ? `${r.routing.target.backend}:${r.routing.target.model}${r.routing.target.account !== null ? '@' + (r.routing.target.account || 'main') : ''}` : 'none';
const byDifficulty = { low: zero, mid: { ...zero, diagnose: true }, high: { ...zero, security_gate: true } };
const routeAt = (kind, difficulty, usage, s = settings) => route({ kind, judged: { judge: 'jev', signals: byDifficulty[difficulty], probabilities: null, fallback: null }, settings: s, usage, now: NOW });

// 偽の fetch。呼ばれた要求を残し、reply(url, body) の値を応答にする
function fakeFetch(reply) {
  const calls = [];
  const fn = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, init, body });
    const out = await reply(url, body, init);
    if (out instanceof Error) throw out;
    const { status = 200, json } = out;
    const text = typeof json === 'string' ? json : JSON.stringify(json);
    return { ok: status >= 200 && status < 300, status, text: async () => text, body: { cancel: async () => {} } };
  };
  fn.calls = calls;
  return fn;
}
const jevAnswer = p => ({ answers: Object.fromEntries(SIGNALS.map(k => [k, { type: 'noul', noul: p[k] ?? 0 }])) });
const qwenAnswer = signals => ({ choices: [{ message: { content: null, tool_calls: [{ type: 'function', function: { name: 'routing_v3', arguments: JSON.stringify({ signals }) } }] } }] });

export default async function (t) {
  // ---- 設定
  t.ok('未設定なら既定値（既定で有効、ux_* と visual は判定しない）', settings.enabled === true && settings.judgeByKind.ux_new === 'none' && settings.judgeByKind.review === 'jev'
    && JSON.stringify(settings.tiers) === JSON.stringify(DEFAULTS.tiers) && settings.avoidPercent === 80 && settings.paceLimit === 1.2 && !Object.hasOwn(settings, 'staleMinutes'));
  const partial = normalizeSettings({ judgeByKind: { design: 'qwen' }, tiers: { t4: ['claude:fable'] }, avoidPercent: 70 });
  t.ok('一部だけの設定は既定で補う', partial.judgeByKind.design === 'qwen' && partial.judgeByKind.review === 'jev' && partial.tiers.t4.join() === 'claude:fable' && partial.tiers.t1.length === 2 && partial.avoidPercent === 70);
  const rejects = [{ nope: 1 }, { enabled: 'yes' }, { avoidPercent: 0 }, { paceLimit: 'x' }, { judgeByKind: { design: 'gpt' } }, { judgeByKind: { cooking: 'jev' } },
    { tiers: { t9: [] } }, { tiers: { t1: ['no-colon'] } }, { tiers: { t1: ['claude:haiku', 'claude:haiku'] } }, { table: { design: ['t1', 't2'] } }, { table: { design: ['t1', 't2', 't7'] } }];
  t.ok('画面からの保存（strict）は不正な値を断る', rejects.every(raw => { try { normalizeSettings(raw, { strict: true }); return false; } catch (e) { return e instanceof RoutingSettingsError && typeof e.code === 'string'; } }));
  t.ok('読むとき（strict でない）は不正な項目だけ既定に戻す', normalizeSettings({ avoidPercent: 500, paceLimit: 2 }).avoidPercent === 80 && normalizeSettings({ avoidPercent: 500, paceLimit: 2 }).paceLimit === 2);
  t.ok('保存済みの prefs に古い staleMinutes が残っていても、読むときはエラーにせず読み捨てる', !Object.hasOwn(normalizeSettings({ staleMinutes: 30 }), 'staleMinutes'));
  t.ok('外した項目（staleMinutes）が prefs に残っていても、画面からの保存（strict）は断らない', !Object.hasOwn(normalizeSettings({ staleMinutes: 30, avoidPercent: 70 }, { strict: true }), 'staleMinutes'));
  // Cerebras の直の判定器（2026-10-09 に廃止、ADR 0177）の保存済みの設定は Qwen の名前で読み、画面からの保存（strict）も断らない
  const legacy = { judgeByKind: { design: 'cerebras', review: 'jev' }, escalateToCerebras: true };
  const migrated = migrateLegacySettings(legacy);
  t.ok('前の版の judgeByKind の cerebras と escalateToCerebras を qwen・escalateToQwen へ直す（元の値は変えない）', migrated.changed && migrated.raw.judgeByKind.design === 'qwen' && migrated.raw.judgeByKind.review === 'jev'
    && migrated.raw.escalateToQwen === true && !Object.hasOwn(migrated.raw, 'escalateToCerebras') && legacy.judgeByKind.design === 'cerebras' && legacy.escalateToCerebras === true);
  t.ok('今の名前があればそちらを残し、直すものが無ければ changed は false', migrateLegacySettings({ escalateToCerebras: true, escalateToQwen: false }).raw.escalateToQwen === false
    && migrateLegacySettings({ escalateToQwen: true, judgeByKind: { design: 'jev' } }).changed === false && migrateLegacySettings(null).changed === false);
  const legacyRead = normalizeSettings(legacy, { strict: true });
  t.ok('前の版の設定は読むときも strict の保存でも Qwen として扱う（unknownKey にしない）', legacyRead.judgeByKind.design === 'qwen' && legacyRead.escalateToQwen === true && !Object.hasOwn(legacyRead, 'escalateToCerebras')
    && normalizeSettings({}).escalateToQwen === false && JUDGES.join() === 'jev,qwen,none');
  t.ok('候補の id は backend:model（model の中の : はそのまま）', parseCandidate('codex:gpt-6-sol').model === 'gpt-6-sol' && parseCandidate('x:a:b').model === 'a:b' && !parseCandidate('claude') && !parseCandidate(':m') && !parseCandidate('claude: x'));

  // ---- 難しさの規則（v3・規則 A）
  t.ok('手がかり 0 → low、1〜2 → mid、3〜4 → high', difficultyOf(zero) === 'low' && ['diagnose', 'choose', 'long_procedure', 'many_parts'].every(k => difficultyOf({ ...zero, [k]: true }) === 'mid')
    && difficultyOf({ ...zero, diagnose: true, choose: true }) === 'mid' && difficultyOf({ ...zero, diagnose: true, choose: true, many_parts: true }) === 'high');
  t.ok('writes_shared は low を mid に上げる。security_gate はそれだけで high', difficultyOf({ ...zero, writes_shared: true }) === 'mid' && difficultyOf({ ...zero, writes_shared: true, diagnose: true }) === 'mid' && difficultyOf({ ...zero, security_gate: true }) === 'high');
  t.ok('手がかりが 6 つの真偽でなければ断る', [null, { ...zero, extra: false }, { ...zero, diagnose: 1 }, { diagnose: true }].every(v => { try { difficultyOf(v); return false; } catch { return true; } }));

  // ---- 使用量の判定
  const policy = { now: NOW, avoidPercent: 80, paceLimit: 1.2 };
  t.ok('5 時間は線を超えても後回しにせず、100% なら使えない', judgeWindows([h5(87), week(64, 70)], policy).ok
    && judgeWindows([h5(100), week(10, 50)], policy).reason === 'quota_full');
  t.ok('週次・モデル系統の週次・追加枠は線以上で後回し', judgeWindows([h5(10), week(80, 80)], policy).reason === 'quota_high'
    && judgeWindows([h5(10), week(80, 80, { model: 'opus' })], policy).reason === 'quota_high'
    && judgeWindows([h5(10), week(80, 80, { limitId: 'codex-extra' })], policy).reason === 'quota_high');
  t.ok('週次のペースが 1.2 を超えれば pace_high（経過率 20% 未満は見ない）', judgeWindows([week(25, 20)], policy).reason === 'pace_high' && judgeWindows([week(23, 20)], policy).ok
    && judgeWindows([week(50, 10)], policy).ok && judgeWindows([week(79, 70)], policy).ok);
  t.ok('pace_high には使用率・ペース・経過率を残す', (w => w.usedPercent === 25 && w.pace === 1.25 && w.elapsedPercent === 20)(judgeWindows([week(25, 20)], policy).window));
  const noReset = { label: 'week', usedPercent: 24, minutes: 10080, resetsAt: null };
  t.ok('経過率が出せない週次の枠は、使用率が 20% × 上限以下なら通し、超えれば pace_unknown', judgeWindows([noReset], policy).ok && judgeWindows([{ ...noReset, usedPercent: 25 }], policy).reason === 'pace_unknown');
  t.ok('リセット時刻を過ぎた枠は使い直しが始まっているので 0 とみなす', judgeWindows([{ ...h5(95), resetsAt: new Date(NOW - 1000).toISOString() }], policy).ok);
  t.ok('5 時間だけ不明でも後回しにしない。ほかの枠が不明・枠なしなら usage_unknown', judgeWindows([h5(null), week(10, 50)], policy).ok
    && judgeWindows([week(null, 50)], policy).reason === 'usage_unknown' && judgeWindows([], policy).reason === 'usage_unknown');
  t.ok('経過率はリセット時刻と期間から出す（範囲外は不明）', Math.round(elapsedPercent(week(0, 40), NOW)) === 40 && elapsedPercent({ minutes: 10080, resetsAt: '2030-01-01T00:00:00Z' }, NOW) === null);

  // ---- 候補に効く枠
  const cq = claudeQuota({ rate_limits: { five_hour: { utilization: 10 }, seven_day: { utilization: 20 }, seven_day_opus: { utilization: 90 }, model_scoped: [{ display_name: 'Fable', utilization: 85 }] } });
  t.ok('Claude: 全体の枠と、そのモデルの系統の週次だけが効く', windowsFor('claude', 'opus', cq.windows).length === 3 && windowsFor('claude', 'sonnet', cq.windows).length === 2 && windowsFor('claude', 'fable', cq.windows).length === 3);
  const xq = codexQuota({ rateLimitsByLimitId: { codex: { limitId: 'codex', primary: { usedPercent: 10, windowDurationMins: 10080 } }, astra: { limitId: 'x1', limitName: 'GPT-6-Astra', primary: { usedPercent: 95, windowDurationMins: 10080 } } } });
  t.ok('Codex: 主の枠はどのモデルにも効き、追加の枠は名前が当たるモデルだけ', windowsFor('codex', 'gpt-6-sol', xq.windows).length === 1 && windowsFor('codex', 'gpt-6-astra', xq.windows).length === 2);
  const aq = antigravityQuota({ status: 'SUCCESS', num_turns: 0, command: { name: 'usage', data: { groups: [
    { name: 'Gemini Flash', buckets: [{ window: '5h', remaining_fraction: .9 }] }, { name: 'Gemini Pro', buckets: [{ window: '5h', remaining_fraction: .1 }] },
    { name: 'Claude and GPT models', buckets: [{ window: '5h', remaining_fraction: .5 }] }] } } });
  t.ok('Antigravity: モデル名の語をいちばん多く含むグループの枠', windowsFor('antigravity', 'gemini-3.8-flash-high', aq.windows).map(w => w.group).join() === 'Gemini Flash'
    && windowsFor('antigravity', 'claude-opus-4-6-thinking', aq.windows).map(w => w.group).join() === 'Claude and GPT models' && windowsFor('antigravity', 'gpt-oss-120b', aq.windows).length === 1
    && windowsFor('antigravity', 'fake-model', aq.windows).length === 0);

  // ---- 振り分け（検証の場面 S1〜S4 と同じ答え。temporary の policy.mjs の自己テスト）
  t.ok('S1: 種類 trivial・低 → Antigravity Gemini Flash', target(routeAt('trivial', 'low', S1)) === 'antigravity:gemini-3.8-flash-high');
  t.ok('S1: design・高 → Opus を週次ペースの低いアカウント（oz）で', target(routeAt('design', 'high', S1)) === 'claude:opus@acct-oz');
  const readyAccounts = routeAt('design', 'high', S1).routing;
  t.ok('同じモデルの別の余裕あり認証は、選ばれなかった理由つきで 1 行残す', readyAccounts.skipped.length === 1
    && readyAccounts.skipped[0].account === '' && readyAccounts.skipped[0].reason === 'lower_priority'
    && readyAccounts.target.accountLabel === 'acct-oz');
  const s2 = routeAt('design', 'high', S2);
  t.ok('S2: 5 時間 96% でも週次に余裕のある OZ を選ぶ', target(s2) === 'claude:opus@acct-oz'
    && !s2.routing.selectedWithLowHeadroom, JSON.stringify(s2.routing));
  t.ok('S3: investigate・中 → Codex が週次 92% なので Sonnet（oz）', target(routeAt('investigate', 'mid', S3)) === 'claude:sonnet@acct-oz');
  t.ok('S3: visual は tv だけを見て、線を超えていても選ぶ', target(routeAt('visual', 'mid', S3)) === 'codex:gpt-6-astra'
    && routeAt('visual', 'mid', S3).routing.selectedWithLowHeadroom.reason === 'quota_high');
  const newUx = routeAt('ux_new', 'mid', S1);
  t.ok('ux_new は既定で t4（Opus が先頭）へ行き、tv には行かない', DEFAULTS.table.ux_new.join() === 't4,t4,t4' && newUx.routing.tier === 't4'
    && target(newUx).startsWith('claude:opus') && DEFAULTS.table.visual.join() === 'tv,tv,tv', JSON.stringify(newUx.routing));
  t.ok('S4: investigate・中 → Codex gpt-6-sol', target(routeAt('investigate', 'mid', S4)) === 'codex:gpt-6-sol');
  t.ok('S4: design・高 → 週次の使用率が低い oz', target(routeAt('design', 'high', S4)) === 'claude:opus@acct-oz');
  const s3m = routeAt('mechanical', 'mid', S3);
  t.ok('記録: 種類・難しさ・段・判定器・取得時刻', s3m.routing.mode === 'auto' && s3m.routing.kind === 'mechanical' && s3m.routing.difficulty === 'mid' && s3m.routing.tier === 't2'
    && s3m.routing.baseTier === 't2' && s3m.routing.judge === 'jev' && s3m.routing.usageAt === new Date(NOW - 60_000).toISOString() && s3m.routing.fallback === null);
  const stale = { ...S1, antigravity: { ...S1.antigravity, checkedAt: NOW - STALE_MS - 60_000 } };
  const st = routeAt('trivial', 'low', stale);
  t.ok('取得間隔の 3 倍（STALE_MS）を超えた使用量は usage_stale で飛ばし、次の候補（Haiku）へ', target(st) === 'claude:haiku@acct-oz' && st.routing.skipped[0].reason === 'usage_stale');
  t.ok('usageAt は選んだ候補の取得時刻（飛ばした古い候補の時刻ではない）。飛ばした候補には各自の取得時刻', st.routing.usageAt === new Date(NOW - 60_000).toISOString()
    && st.routing.skipped[0].checkedAt === new Date(NOW - STALE_MS - 60_000).toISOString());
  const again = route({ kind: 'trivial', judged: { judge: 'jev', signals: zero }, settings, usage: S1, now: NOW, rejected: { 'antigravity:gemini-3.8-flash-high': 'model_unknown' } });
  t.ok('選んだ後の確かめで落ちた候補（rejected）は理由を付けて飛ばし、次の候補へ', target(again) === 'claude:haiku@acct-oz' && again.routing.skipped[0].reason === 'model_unknown');
  const rejectedClaude = route({ kind: 'design', judged: { judge: 'jev', signals: byDifficulty.high }, settings, usage: S1, now: NOW,
    rejected: { 'claude:opus': 'model_unknown' } });
  t.ok('Claude のモデル再確認で落ちた場合も認証ごとの行に残す', rejectedClaude.routing.skipped.filter(s => s.candidate === 'claude:opus').length === 2
    && rejectedClaude.routing.skipped.filter(s => s.candidate === 'claude:opus').every(s => s.reason === 'model_unknown'));
  const unknownModel = { ...S1, antigravity: { ...S1.antigravity, models: { 'gemini-3.8-flash-high': false } } };
  t.ok('一覧に無いモデルは model_unknown で飛ばす（黙って既定に落とさない）', routeAt('trivial', 'low', unknownModel).routing.skipped[0].reason === 'model_unknown');
  const gone = { ...S1, antigravity: { available: false, checkedAt: null, windows: [], models: {} } };
  t.ok('未接続のバックエンドは unavailable で飛ばす', routeAt('trivial', 'low', gone).routing.skipped[0].reason === 'unavailable');
  const climb = { ...S1, antigravity: { ...S1.antigravity, windows: [week(90, 80, { group: 'Gemini Models' }), week(90, 80, { group: 'Claude and GPT models' })] },
    claude: { ...S1.claude, accounts: S1.claude.accounts.map(a => ({ ...a, windows: [h5(95), week(90, 80)] })) } };
  const up = routeAt('trivial', 'low', climb);
  t.ok('段の候補が全部だめなら 1 つ上の段へ（t1 → t2 の Codex luna）', target(up) === 'codex:gpt-6-luna' && up.routing.tier === 't2' && up.routing.baseTier === 't1' && up.routing.skipped.length === 4, JSON.stringify(up.routing.skipped.map(s => s.candidate + ':' + s.reason)));
  const softSettings = normalizeSettings({ avoidPercent: 70, tiers: { t4: ['claude:opus', 'claude:fable'], t3: ['codex:gpt-6-sol'] } });
  const softUsage = { ...S1, claude: { ...S1.claude, accounts: [
    { account: '', label: 'main', runnable: true, windows: [h5(20), week(83, 70)] },
    { account: 'second', label: 'second', runnable: true, windows: [h5(30), week(83, 70)] },
    { account: 'oz', label: 'oz', runnable: true, windows: [h5(87), week(64, 70)] },
  ] } };
  const softPicked = routeAt('design', 'mid', softUsage, softSettings);
  t.ok('実例: 週次 83% の 2 アカウントより、週次 64%・5 時間 87% の OZ を余裕ありとして選ぶ', softPicked.ok
    && softPicked.routing.target.account === 'oz' && !softPicked.routing.selectedWithLowHeadroom && softPicked.routing.skipped.length === 2
    && softPicked.routing.skipped.every(s => s.candidate === 'claude:opus' && s.reason === 'quota_high'),
    JSON.stringify(softPicked.routing));
  const ozFull = routeAt('design', 'mid', { ...softUsage, claude: { ...softUsage.claude, accounts: softUsage.claude.accounts.map(a =>
    a.account === 'oz' ? { ...a, windows: [h5(100), week(64, 70)] } : a) } }, softSettings);
  t.ok('OZ だけ 5 時間枠が満杯なら、その認証の理由を独立した行に残す', ozFull.routing.target.account === ''
    && ozFull.routing.skipped.some(s => s.account === 'oz' && s.reason === 'quota_full' && s.window.minutes === 300));
  const knownFirst = routeAt('design', 'mid', { ...softUsage, claude: { ...softUsage.claude, accounts: [
    { account: 'unknown', label: 'unknown', runnable: true, windows: [] },
    { account: 'known', label: 'known', runnable: true, windows: [h5(92), week(83, 70)] },
  ] } }, softSettings);
  t.ok('使用量が分かる余裕の少ないアカウントを、不明なアカウントより先に選ぶ', knownFirst.routing.target.account === 'known');
  const sameMaximum = checkCandidate('claude:opus', { usage: { claude: { ...S1.claude, accounts: [
    { account: 'fast', label: 'fast', runnable: true, windows: [h5(83), week(60, 40)] },
    { account: 'slow', label: 'slow', runnable: true, windows: [h5(83), week(60, 80)] },
  ] } }, settings: softSettings, now: NOW });
  t.ok('5 時間を除く最大使用率が同じなら週次ペースが低いアカウントを選ぶ', sameMaximum.account === 'slow');
  const samePace = checkCandidate('claude:opus', { usage: { claude: { ...S1.claude, accounts: [
    { account: 'five-high', label: 'five-high', runnable: true, windows: [h5(95), week(83, 80)] },
    { account: 'five-low', label: 'five-low', runnable: true, windows: [h5(10), week(83, 80)] },
  ] } }, settings: softSettings, now: NOW });
  t.ok('週次の使用率とペースも同じときだけ 5 時間の低いアカウントを選ぶ', samePace.account === 'five-low');
  const readyPressure = checkCandidate('claude:opus', { usage: { claude: { ...S1.claude, accounts: [
    { account: 'slower-pace', label: 'slower-pace', runnable: true, windows: [h5(10), week(40, 80)] },
    { account: 'lower-week', label: 'lower-week', runnable: true, windows: [h5(90), week(30, 40)] },
  ] } }, settings: softSettings, now: NOW });
  t.ok('余裕ありのアカウントも 5 時間以外の最大使用率をペースより先に比べる', readyPressure.account === 'lower-week');
  const candidatePressure = routeAt('investigate', 'mid', { ...S1,
    codex: { ...S1.codex, windows: [week(83, 80, { limitId: 'codex' }), h5(10, { limitId: 'codex' })] },
    claude: { ...S1.claude, accounts: [{ account: 'low-week', label: 'low-week', runnable: true, windows: [h5(95), week(75, 80)] }] },
  }, normalizeSettings({ avoidPercent: 70, tiers: { t3: ['codex:gpt-6-sol', 'claude:sonnet'], t4: [] } }));
  t.ok('余裕が少ない候補同士でも 5 時間を除く最大使用率を優先する', target(candidatePressure) === 'claude:sonnet@low-week');
  const fullUsage = { ...S1, claude: { ...S1.claude, accounts: S1.claude.accounts.map(a => ({ ...a, windows: [h5(100), week(83, 70)] })) } };
  const lower = routeAt('design', 'mid', fullUsage, softSettings);
  t.ok('基準から上が全員 100% なら下の段の余裕ありを選ぶ', target(lower) === 'codex:gpt-6-sol'
    && lower.routing.baseTier === 't4' && lower.routing.tier === 't3' && lower.routing.skipped.every(s => s.reason === 'quota_full'));
  const lowerSoft = routeAt('design', 'mid', { ...fullUsage, codex: { ...S1.codex, windows: [week(92, 80, { limitId: 'codex' })] } }, softSettings);
  t.ok('下の段ではその段の余裕が少ない候補を、さらに下の余裕ありより先に選ぶ', target(lowerSoft) === 'codex:gpt-6-sol'
    && lowerSoft.routing.tier === 't3' && lowerSoft.routing.selectedWithLowHeadroom.reason === 'quota_high');
  const exhausted = routeAt('design', 'mid', { ...fullUsage, codex: { ...S1.codex, windows: [week(100, 50, { limitId: 'codex' })] },
    antigravity: { ...S1.antigravity, windows: [h5(100, { group: 'Gemini Models' }), h5(100, { group: 'Claude and GPT models' })] } }, softSettings);
  t.ok('見た全部の段が使えないときだけ失敗し、Claude の理由をアカウントごとに残す', !exhausted.ok
    && exhausted.routing.skipped.filter(s => s.candidate === 'claude:opus').length === 2
    && exhausted.routing.skipped.some(s => s.tier === 't1'));
  const mixedReasons = checkCandidate('claude:opus', { usage: { claude: { ...S1.claude, accounts: [
    { account: 'week', label: 'week', runnable: true, windows: [h5(20), week(100, 70)] },
    { account: 'five', label: 'five', runnable: true, windows: [h5(100), week(20, 70)] },
  ] } }, settings: softSettings, now: NOW });
  t.ok('アカウントごとに異なる枠の 100% を記録する', !mixedReasons.ok
    && mixedReasons.accounts.find(a => a.account === 'week')?.window.label === 'week'
    && mixedReasons.accounts.find(a => a.account === 'five')?.window.label === '5h');
  const reasonLines = formatSkippedCandidates(mixedReasons.accounts.map(a => ({ candidate: 'claude:opus', tier: 't4', account: a.account, accountLabel: a.label,
    reason: a.reason, window: a.window })));
  t.ok('エラー用の候補行はアカウントごとに異なる理由と枠を全部出す', reasonLines.includes('- claude:opus [week] (t4): quota_full week 100%')
    && reasonLines.includes('- claude:opus [five] (t4): quota_full 5h 100%'), reasonLines);
  const perAccountStates = candidateStates({ settings: softSettings, usage: fullUsage, now: NOW }).find(s => s.candidate === 'claude:opus');
  t.ok('設定の状態は Claude の認証ごとに使えるか・理由と枠を持つ', perAccountStates.accounts.length === 2
    && perAccountStates.accounts.every(a => !a.usable && a.reason === 'quota_full' && a.window.usedPercent === 100));
  const retryBase = checkCandidate('claude:opus', { usage: S1, settings: softSettings, now: NOW });
  const retryMain = selectRetryAccount(retryBase, 'claude', '');
  t.ok('同じモデルでも選んだ認証の判定でやり直せる', retryBase.account === 'acct-oz' && retryMain.ok && retryMain.account === ''
    && manualRouting({ kind: 'design', candidate: 'claude:opus', check: retryMain, of: 'old', from: null }).target.account === '');
  t.ok('使えない認証や存在しない認証をやり直しで選べない', !selectRetryAccount(checkCandidate('claude:opus', { usage: fullUsage, settings: softSettings, now: NOW }), 'claude', '').ok
    && !selectRetryAccount(retryBase, 'claude', 'missing').ok);
  const loginOnly = checkCandidate('claude:opus', { usage: { claude: { ...S1.claude, accounts: undefined, windows: [h5(10), week(10, 70)] } }, settings: softSettings, now: NOW });
  t.ok('認証一覧の無い Claude もログイン中の認証でやり直せる', selectRetryAccount(loginOnly, 'claude', '').ok);
  t.ok('判定が無い（signals が null）なら難しさは mid', route({ kind: 'implement', judged: { judge: 'none', signals: null, fallback: 'no_key' }, settings, usage: S1, now: NOW }).routing.difficulty === 'mid');
  t.ok('ux_change は判定に関係なく t4', routeAt('ux_change', 'low', S1).routing.tier === 't4');

  // ---- Claude のアカウント
  const acc = (account, windows, identity = null, runnable = true) => ({ account, label: account || 'login', windows, identity, runnable });
  const claudeOnly = accounts => ({ claude: { available: true, checkedAt: NOW, windows: [], accounts, models: ALL_MODELS.claude } });
  const pick = accounts => checkCandidate('claude:opus', { usage: claudeOnly(accounts), settings, now: NOW });
  t.ok('週次ペースの低いアカウントを選ぶ', pick([acc('', [h5(10), week(40, 50)]), acc('a', [h5(50), week(20, 50)])]).account === 'a');
  t.ok('週次ペースが同じなら 5 時間の低い方', pick([acc('', [h5(30), week(20, 50)]), acc('a', [h5(10), week(20, 50)])]).account === 'a' && pick([acc('', [h5(5), week(20, 50)]), acc('a', [h5(10), week(20, 50)])]).account === '');
  t.ok('トークンの無いアカウントは除き、5 時間 95% のログイン中を余裕ありとして選べる',
    pick([acc('', [h5(95)]), acc('a', [h5(0), week(0, 50)], null, false)]).ok === true
    && !pick([acc('', [h5(95)]), acc('a', [h5(0), week(0, 50)], null, false)]).deferred);
  // 「使えない」の中身（画面が「使えない（未インストール）」と添える）
  t.ok('使えない理由の中身: 有効でない・入っていない・トークンが無い',
    checkCandidate('codex:gpt-6-sol', { usage: { claude: { available: true, checkedAt: NOW, windows: [], models: {} } }, settings, now: NOW }).detail === 'disabled'
    && checkCandidate('codex:gpt-6-sol', { usage: {}, settings, now: NOW }).detail === undefined
    && checkCandidate('codex:gpt-6-sol', { usage: { codex: { available: false, checkedAt: null, windows: [], models: {} } }, settings, now: NOW }).detail === 'not_installed'
    && pick([acc('a', [h5(0), week(0, 50)], null, false)]).detail === 'no_token'
    && checkCandidate('claude:opus', { usage: claudeOnly([acc('', [h5(95)])]), settings, now: NOW }).detail === undefined);
  const same = { org: 'org-1', email: 'Me@example.com' };
  t.ok('ログイン中と同じ人（組織とメールが一致）の登録アカウントは 1 つにまとめる', dedupeAccounts([acc('', [], same), acc('a', [], { org: 'org-1', email: 'me@example.com' }), acc('b', [], { org: 'org-2', email: 'x@example.com' })]).map(a => a.account).join() === ',b');
  // ログイン中の方だけ使用量の取得に失敗した。同じ人の登録アカウントが使えるなら、そちらを残して使う
  t.ok('同じ人の 2 つのうち、使える方・週次に余裕のある方を残す', pick([acc('', [], same), acc('a', [h5(10), week(10, 50)], { org: 'org-1', email: 'me@example.com' })]).account === 'a'
    && pick([acc('', [h5(5), week(5, 50)], same), acc('a', [h5(1), week(1, 50)], { org: 'org-1', email: 'me@example.com' })]).account === 'a');
  t.ok('同じ人の 2 つが同じ使用率ならログイン中を残す',
    pick([acc('', [h5(5), week(5, 50)], same), acc('a', [h5(5), week(5, 50)], { org: 'org-1', email: 'me@example.com' })]).account === '');
  t.ok('重複した人のアカウントも 5 時間より週次の余裕を優先する',
    pick([acc('', [h5(10), week(60, 70)], same), acc('a', [h5(90), week(40, 70)], { org: 'org-1', email: 'me@example.com' })]).account === 'a');
  t.ok('重複した人のログイン中が 100% なら、余裕の少ない登録アカウントを残す',
    pick([acc('', [h5(100)], same), acc('a', [h5(90), week(90, 80)], { org: 'org-1', email: 'me@example.com' })]).account === 'a');
  t.ok('メールか組織が分からなければまとめない', dedupeAccounts([acc('', [], { org: 'org-1', email: null }), acc('a', [], { org: 'org-1', email: 'me@example.com' })]).length === 2
    && dedupeAccounts([acc('', [], null), acc('a', [], same)]).length === 2);
  t.ok('登録が無い（accounts が無い）ときはログイン中のアカウント（\'\'）', checkCandidate('claude:haiku', { usage: { claude: { available: true, checkedAt: NOW, windows: [h5(1), week(1, 50)], models: ALL_MODELS.claude } }, settings, now: NOW }).account === '');

  // ---- 固定・画面用の一覧
  const pinned = pinnedRouting({ kind: 'review', backend: 'codex', model: 'gpt-6-sol' });
  t.ok('固定のときも kind を記録する', pinned.mode === 'pinned' && pinned.kind === 'review' && pinned.target.backend === 'codex' && pinned.target.model === 'gpt-6-sol' && pinned.difficulty === null);
  const retryCheck = checkCandidate('codex:gpt-6-sol', { usage: S3, settings, now: NOW });
  const retried = manualRouting({ kind: 'review', candidate: 'codex:gpt-6-sol', check: retryCheck, of: 'ply-task-old', from: null });
  t.ok('人がやり直すときも線を超えた候補を選べ、理由と線を残す', retryCheck.ok && retryCheck.deferred
    && retried.selectedWithLowHeadroom.reason === 'quota_high' && retried.selectedWithLowHeadroom.avoidPercent === 80);
  const states = candidateStates({ settings, usage: S3, now: NOW });
  t.ok('候補ごとの今の使用量と選べるかどうか（段・理由・アカウントごと）', states.length === 9 && states.find(s => s.candidate === 'codex:gpt-6-sol').reason === 'quota_high'
    && states.find(s => s.candidate === 'codex:gpt-6-sol').usable && states.find(s => s.candidate === 'codex:gpt-6-sol').deferred
    && states.find(s => s.candidate === 'claude:sonnet').accounts.length === 2 && states.find(s => s.candidate === 'claude:sonnet').tiers.join() === 't2,t3');
  const warn = settingsWarnings({ settings: normalizeSettings({ tiers: { t1: ['antigravity:gemini-9', 'fake:x'] } }), usage: S1 });
  t.ok('今の一覧に無い候補・使えないバックエンドを知らせる（消さない）', warn.some(w => w.candidate === 'antigravity:gemini-9' && w.reason === 'model_unknown') && warn.some(w => w.candidate === 'fake:x' && w.reason === 'unavailable'));

  // ---- 判定器（偽の HTTP）
  const KEY = 'sk-or-test-SECRET-123';
  const jev = fakeFetch(() => ({ json: jevAnswer({ diagnose: 0.49, choose: 0.31, long_procedure: 0.9, many_parts: 0.1, writes_shared: 0.02, security_gate: 0.18 }) }));
  const long = 'x'.repeat(TASK_LIMIT + 500);
  const a = await askJev({ kind: 'implement', task: long, key: KEY, fetch: jev });
  const sent = jev.calls[0];
  t.ok('Jev: decisions へ Noul 6 つ（v3 の文面と false 側）を送る', sent.url.endsWith('/alpha/decisions') && sent.body.model === JEV_MODEL
    && Object.keys(sent.body.questions).join() === SIGNALS.join() && sent.body.questions.diagnose.type === 'noul' && sent.body.questions.choose.criteria.false === 'The statement for choose is false for this task.', sent.url);
  t.ok('Jev: 送るのは kind と長さで切った依頼文だけ', sent.body.state.kind === 'implement' && sent.body.state.task.length === TASK_LIMIT && Object.keys(sent.body.state).sort().join() === 'instructions,kind,task'
    && sent.init.headers.Authorization === `Bearer ${KEY}` && sent.init.redirect === 'manual');
  t.ok('Jev: はいの確率を手がかりごとの閾値で真偽にする', a.signals.diagnose === false && a.signals.choose === true && a.signals.long_procedure === true && a.signals.security_gate === false && a.probabilities.diagnose === 0.49);
  t.ok('Jev: 閾値 ± 0.15 以内の確率があれば迷ったとみなす', a.unsure === true && (await askJev({ kind: 'implement', task: 'x', key: KEY, fetch: fakeFetch(() => ({ json: jevAnswer({ diagnose: 1, choose: 1, long_procedure: 1, many_parts: 1, writes_shared: 1, security_gate: 1 }) })) })).unsure === false);
  const qw = fakeFetch(() => ({ json: qwenAnswer({ ...zero, many_parts: true }) }));
  const c = await askQwen({ kind: 'review', task: long, key: KEY, fetch: qw });
  const qs = qw.calls[0];
  t.ok('Qwen: OpenRouter の chat/completions へ qwen3.8-27b・推論なし・Cerebras を先に（受けなければほかの provider）', qs.url.endsWith('/v1/chat/completions') && qs.url.startsWith(sent.url.slice(0, sent.url.indexOf('/alpha/')))
    && qs.body.model === QWEN_MODEL && qs.body.reasoning.effort === 'none' && qs.body.temperature === 0 && qs.body.provider.order.join() === 'cerebras' && qs.body.provider.allow_fallbacks === true
    && qs.body.provider.require_parameters === true && qs.init.headers.Authorization === `Bearer ${KEY}` && qs.init.redirect === 'manual', qs.url);
  t.ok('Qwen: strict な関数 1 つを必ず呼ばせ、その引数で 6 つの真偽を受け取る（依頼文は長さで切る）', qs.body.tools.length === 1 && qs.body.tools[0].function.strict === true
    && qs.body.tool_choice.function.name === qs.body.tools[0].function.name && qs.body.tools[0].function.parameters.properties.signals.required.join() === SIGNALS.join()
    && !('response_format' in qs.body) && qs.body.messages[0].content.endsWith('x'.repeat(TASK_LIMIT)) && !qs.body.messages[0].content.includes('x'.repeat(TASK_LIMIT + 1))
    && c.signals.many_parts === true && c.signals.diagnose === false && !('probabilities' in c));
  const inContent = await askQwen({ kind: 'review', task: 'x', key: KEY, fetch: fakeFetch(() => ({ json: { choices: [{ message: { content: JSON.stringify({ signals: { ...zero, choose: true } }) } }] } })) });
  t.ok('Qwen: 関数の呼び出しでなく本文で返した答えも、同じ形なら受け取る', inContent.signals.choose === true);
  const code = async (fn, reply) => { try { await fn({ kind: 'review', task: 'x', key: KEY, fetch: fakeFetch(reply) }); return 'ok'; } catch (e) { return e.message; } };
  t.ok('応答の形が違えば bad_response', await code(askJev, () => ({ json: { answers: {} } })) === 'bad_response' && await code(askQwen, () => ({ json: qwenAnswer({ diagnose: true }) })) === 'bad_response'
    && await code(askQwen, () => ({ json: { choices: [{ message: { tool_calls: [{ function: { name: 'routing_v3', arguments: '{not json' } }] } }] } })) === 'bad_response'
    && await code(askJev, () => ({ json: 'not json' })) === 'bad_response');
  t.ok('HTTP の失敗は http_<status>、時間切れは timeout、つながらなければ network', await code(askJev, () => ({ status: 429, json: { error: KEY } })) === 'http_429'
    && await code(askJev, () => Object.assign(new Error('t'), { name: 'TimeoutError' })) === 'timeout' && await code(askQwen, () => new Error('ECONNREFUSED')) === 'network');
  const keys = values => async service => values[service];
  const jevOk = fakeFetch(url => url.includes('decisions') ? { json: jevAnswer({ diagnose: 1 }) } : { json: qwenAnswer({ ...zero, choose: true }) });
  const none = await judgeDifficulty({ kind: 'visual', task: 'x', judge: 'none', keyOf: keys({ openrouter: KEY }), fetch: jevOk });
  t.ok('判定しない種類は送らず judge_none', none.judge === 'none' && none.signals === null && none.fallback === 'judge_none' && jevOk.calls.length === 0);
  const noKeys = await judgeDifficulty({ kind: 'review', task: 'x', judge: 'jev', keyOf: keys({}), fetch: jevOk });
  t.ok('キーが無ければ外へは何も送らず no_key（難しさは mid）', noKeys.judge === 'none' && noKeys.fallback === 'no_key' && jevOk.calls.length === 0);
  const qwenDown = fakeFetch(url => url.includes('decisions') ? { json: jevAnswer({ diagnose: 1 }) } : { status: 502, json: {} });
  const other = await judgeDifficulty({ kind: 'review', task: 'x', judge: 'qwen', keyOf: keys({ openrouter: KEY }), fetch: qwenDown });
  t.ok('Qwen を選んだ種類で Qwen が使えなければ、同じキーで Jev を試す', other.judge === 'jev' && other.fallback === 'http_502' && other.signals.diagnose === true && qwenDown.calls.length === 2);
  const failing = fakeFetch(url => url.includes('decisions') ? { status: 503, json: {} } : { json: qwenAnswer(zero) });
  const fb = await judgeDifficulty({ kind: 'review', task: 'x', judge: 'jev', keyOf: keys({ openrouter: KEY }), fetch: failing });
  t.ok('Jev が HTTP で失敗 → Qwen の答えを使い、失敗の理由を残す', fb.judge === 'qwen' && fb.fallback === 'http_503' && fb.signals.diagnose === false);
  const allDown = fakeFetch(() => ({ status: 503, json: {} }));
  const both = await judgeDifficulty({ kind: 'review', task: 'x', judge: 'jev', keyOf: keys({ openrouter: KEY }), fetch: allDown });
  t.ok('どちらも使えなければ判定なし（mid）で最初の理由', both.judge === 'none' && both.signals === null && both.fallback === 'http_503');
  const unsure = fakeFetch(url => url.includes('decisions') ? { json: jevAnswer({ diagnose: 0.55 }) } : { json: qwenAnswer({ ...zero, many_parts: true }) });
  const esc = await judgeDifficulty({ kind: 'review', task: 'x', judge: 'jev', escalate: true, keyOf: keys({ openrouter: KEY }), fetch: unsure });
  t.ok('「Jev が迷ったら Qwen」: 迷ったときは Qwen の答えを使い、Jev の確率も残す', esc.judge === 'qwen' && esc.escalated === true && esc.signals.many_parts === true && esc.probabilities.diagnose === 0.55);
  const noEsc = await judgeDifficulty({ kind: 'review', task: 'x', judge: 'jev', escalate: false, keyOf: keys({ openrouter: KEY }), fetch: unsure });
  t.ok('既定（OFF）では Jev の答えのまま', noEsc.judge === 'jev' && noEsc.signals.diagnose === true && unsure.calls.filter(x => x.url.includes('chat')).length === 1);
  const locked = await judgeDifficulty({ kind: 'review', task: 'x', judge: 'jev', keyOf: async () => { throw new Error(KEY); }, fetch: jevOk });
  t.ok('キーを読めなければ key_unreadable（キーの中身をどこにも出さない）', locked.fallback === 'key_unreadable' && !JSON.stringify([none, noKeys, other, fb, both, esc, locked]).includes(KEY));
  t.ok('キーの形の検査', normalizeKey('  abc  ') === 'abc' && normalizeKey('') === null && normalizeKey('a b') === null && normalizeKey('x'.repeat(501)) === null);

  // ---- 使用量の取り置き
  let reads = 0, warmed = 0;
  const claudeB = { id: 'claude', usage: true }, agyB = { id: 'antigravity', usage: true }, codexB = { id: 'codex', usage: true }, fakeB = { id: 'fake' };
  let agyKnows = false;
  const monitor = createUsageMonitor({
    backends: () => [claudeB, agyB, codexB, fakeB], installed: id => id !== 'codex',
    read: async b => { reads++; if (b.id === 'claude') return { windows: [], checkedAt: NOW, accounts: [
      { label: 'ログイン中のアカウント', accountId: null, windows: [h5(10)] }, { label: 'work alice@example.com', accountId: 'acct-1', windows: [h5(20)] }, { label: 'b', accountId: 'acct-2', windows: [], message: 'x' }] };
      return { windows: [h5(5, { group: 'Gemini Models' })], checkedAt: null, message: 'failed' }; },
    candidates: () => ['claude:opus', 'antigravity:gemini-3.8-flash-high', 'codex:gpt-6-sol'],
    modelKnown: async (b, m) => b.id === 'antigravity' ? agyKnows : m === 'opus',
    warm: async b => { warmed++; if (b.id === 'antigravity') agyKnows = true; },
    claudeIdentities: async () => ({ login: { org: 'o', email: 'e@example.com' }, accounts: [{ id: 'acct-1', hasToken: true, identity: { org: 'o', email: 'E@example.com' } }, { id: 'acct-2', hasToken: false, identity: null }] }),
  });
  t.ok('取る前は空（振り分けは待たずに「不明」で飛ばす）', Object.keys(monitor.snapshot()).length === 0);
  await monitor.refresh();
  const snap = monitor.snapshot();
  t.ok('Claude: アカウントごとの枠・識別子・会話を回せるか（トークンの有無）', snap.claude.checkedAt === NOW && snap.claude.accounts.length === 3 && snap.claude.accounts[0].account === ''
    && snap.claude.accounts[1].identity.org === 'o' && snap.claude.accounts[1].runnable === true && snap.claude.accounts[2].runnable === false);
  t.ok('見出しのメールアドレスは伏せる（振り分けの記録はエージェントにも返る）', snap.claude.accounts[1].label === 'work a***@example.com');
  t.ok('取得に失敗した値は「不明」（checkedAt が null）', snap.antigravity.checkedAt === null && snap.antigravity.windows.length === 0);
  t.ok('一覧に無いモデルは、一覧を確かめ直して（warm）から見直す', snap.antigravity.models['gemini-3.8-flash-high'] === true && warmed === 1 && snap.claude.models.opus === true);
  t.ok('CLI が入っていないバックエンドは使えない（使用量も取らない）', snap.codex.available === false && reads === 2);
  t.ok('同じ人のアカウントは振り分けのときに 1 つにまとまる', checkCandidate('claude:opus', { usage: snap, settings, now: NOW }).accounts.length === 2
    && dedupeAccounts(snap.claude.accounts).map(a => a.account).join() === ',acct-2');

  // ---- 使用量の取り置き: 古ければ判定と並行して取り直す（ensureFresh）。
  // 待ちの上限は unref のタイマーなので、遅らせる側は必ず実タイマー（setTimeout）にする。
  // 手動で解決する Promise だけを止めると、イベントループを保つものが無くなり上限のタイマーごと発火せずに固まる
  t.ok('古さの閾値は取得間隔の 3 倍', STALE_MS === REFRESH_MS * 3);
  let efReads = 0, efDelayMs = 0;
  const efBackend = { id: 'codex', usage: true };
  const efMonitor = createUsageMonitor({
    backends: () => [efBackend], installed: () => true,
    read: async () => { efReads++; if (efDelayMs) await new Promise(r => setTimeout(r, efDelayMs)); return { windows: [], checkedAt: Date.now() }; },
    candidates: () => ['codex:gpt-6-sol'], modelKnown: async () => true,
  });
  await efMonitor.ensureFresh(1000);
  t.ok('一度も取れていなければ取り直して待つ', efReads === 1 && Object.keys(efMonitor.snapshot()).length === 1);
  await efMonitor.ensureFresh(1000);
  t.ok('新しい値が揃っていれば取り直さずすぐ戻る', efReads === 1);
  efMonitor.snapshot().codex.checkedAt = Date.now() - STALE_MS - 1000;
  await efMonitor.ensureFresh(1000);
  t.ok('STALE_MS（取得間隔の 3 倍）を超えて古ければ取り直して待つ', efReads === 2);
  efMonitor.snapshot().codex.checkedAt = Date.now() - STALE_MS - 1000;
  efDelayMs = 100;
  const p1 = efMonitor.ensureFresh(1000);
  await new Promise(r => setTimeout(r, 10));
  const p2 = efMonitor.ensureFresh(1000);
  await Promise.all([p1, p2]);
  t.ok('取得中に呼ばれたら相乗りし、2 重に取り直さない', efReads === 3);
  efMonitor.snapshot().codex.checkedAt = Date.now() - STALE_MS - 1000;
  efDelayMs = 200;
  const start = Date.now();
  await efMonitor.ensureFresh(30);
  t.ok('取り直しが終わらなくても最長 ms で戻る（取り直しは裏で続く）', efReads === 4 && Date.now() - start < 150);
  await new Promise(r => setTimeout(r, 250));
  efDelayMs = 0;

  // ---- 子の思考の強さ（ADR 0164）
  const strictFails = (raw, code) => { try { normalizeSettings(raw, { strict: true }); return false; } catch (e) { return e instanceof RoutingSettingsError && e.code === code; } };
  t.ok('強さの既定: 段 1 low・段 2 medium・段 3 medium・段 4 high・創作は会話の既定（空）', JSON.stringify(settings.efforts)
    === '{"t1":{"*":"low"},"t2":{"*":"medium"},"t3":{"*":"medium"},"t4":{"*":"high"},"tv":{"*":""}}' && JSON.stringify(DEFAULTS.efforts) === JSON.stringify(settings.efforts));
  t.ok('強さの語彙は弱い順に low・medium・high・xhigh・max', EFFORT_LEVELS.join() === 'low,medium,high,xhigh,max');
  const withTiers = normalizeSettings({ tiers: { t3: ['claude:sonnet', 'codex:gpt-6-sol'] }, efforts: { t3: { '*': 'high', 'claude:sonnet': 'low', 'codex:gpt-6-sol': '' } } }, { strict: true });
  t.ok('段の既定と候補の id ごとの上書きを読む（空は会話の既定に従う）。書かなかった段は既定のまま', withTiers.efforts.t3['*'] === 'high' && withTiers.efforts.t3['claude:sonnet'] === 'low'
    && withTiers.efforts.t3['codex:gpt-6-sol'] === '' && withTiers.efforts.t4['*'] === 'high' && withTiers.efforts.tv['*'] === '');
  t.ok('段に無い候補の上書きは持ち越さない（外した候補・段にまだ無い候補）', normalizeSettings({ efforts: { t3: { 'claude:opus': 'high' } } }, { strict: true }).efforts.t3['claude:opus'] === undefined);
  t.ok('段の既定を書かない行は組み込みの段の既定で補う', normalizeSettings({ tiers: { t3: ['claude:sonnet'] }, efforts: { t3: { 'claude:sonnet': 'max' } } }, { strict: true }).efforts.t3['*'] === 'medium');
  t.ok('保存（strict）は形だけを見て断る: 語彙の外の強さ・候補でない対象・知らない段・形の違う値・多すぎる対象',
    strictFails({ efforts: { t3: { '*': 'extreme' } } }, 'badEffort') && strictFails({ efforts: { t3: { '*': 1 } } }, 'badEffort') && strictFails({ efforts: { t3: { nope: 'low' } } }, 'badEffortKey')
    && strictFails({ efforts: { t9: { '*': 'low' } } }, 'unknownTier') && strictFails({ efforts: [] }, 'notObject') && strictFails({ efforts: { t3: 'low' } }, 'badEfforts')
    && strictFails({ efforts: { t3: Object.fromEntries(Array.from({ length: 41 }, (_, i) => [`claude:m${i}`, 'low'])) } }, 'badEfforts'));
  t.ok('モデルが持つかどうかは保存では見ない（xhigh を持たないモデルの候補にも書ける）', normalizeSettings({ tiers: { t2: ['claude:haiku'] }, efforts: { t2: { 'claude:haiku': 'xhigh' } } }, { strict: true }).efforts.t2['claude:haiku'] === 'xhigh');
  const lenient = normalizeSettings({ efforts: { t3: { '*': 'extreme' }, t9: { '*': 'low' }, t4: { '*': 'low' } } });
  t.ok('読むとき（strict でない）は不正な項目だけ既定に戻し、動く', lenient.efforts.t3['*'] === 'medium' && lenient.efforts.t4['*'] === 'low' && !('t9' in lenient.efforts)
    && normalizeSettings({ efforts: 'x' }).efforts.t1['*'] === 'low');
  t.ok('efforts を持たない前の版の設定も読める（unknownKey にしない）', normalizeSettings({ avoidPercent: 70 }, { strict: true }).efforts.t4['*'] === 'high');

  const tiersFor = normalizeSettings({ tiers: { t3: ['claude:sonnet', 'codex:gpt-6-sol'] } });
  t.ok('保存する efforts から、段に無い候補の上書きと既定と同じ行を落とす（空なら undefined）', JSON.stringify(pruneEfforts({ t3: { '*': 'medium', 'claude:haiku': 'low' }, t4: { '*': 'max' } }, tiersFor)) === '{"t4":{"*":"max"}}'
    && pruneEfforts({ t3: { '*': 'medium' } }, tiersFor) === undefined && pruneEfforts(undefined, tiersFor) === undefined
    && JSON.stringify(pruneEfforts({ t3: { 'claude:sonnet': 'low' } }, tiersFor)) === '{"t3":{"claude:sonnet":"low"}}');

  t.ok('合わせ: 持たない強さは近い下の強さへ（xhigh → high、max → high）。下が無ければ持つ中でいちばん弱いもの。持たないモデルは null',
    fitEffort(['low', 'medium', 'high'], 'xhigh') === 'high' && fitEffort(['low', 'medium', 'high'], 'max') === 'high' && fitEffort(['low', 'high'], 'medium') === 'low'
    && fitEffort(['medium', 'high'], 'low') === 'medium' && fitEffort(['low', 'medium'], 'medium') === 'medium' && fitEffort([], 'high') === null && fitEffort(['minimal'], 'low') === null);
  const lv = { levels: ['low', 'medium', 'high', 'xhigh'], fixed: null };
  const decide = (over, candidate, tier, capability = lv) => decideEffort({ settings: normalizeSettings({ tiers: { t3: ['claude:sonnet', 'codex:gpt-6-sol'] }, efforts: over }), tier, candidate, capability });
  const d1 = decide(undefined, 'codex:gpt-6-sol', 't3');
  t.ok('決まり方 1: 上書きが無ければ段の既定（medium・source tier）', d1.send === 'medium' && d1.effort === 'medium' && d1.source === 'tier' && d1.tier === 't3' && !('asked' in d1));
  const d2 = decide({ t3: { 'codex:gpt-6-sol': 'low' } }, 'codex:gpt-6-sol', 't3');
  t.ok('決まり方 2: 候補の上書きは段の既定に優先する（source override）', d2.send === 'low' && d2.source === 'override');
  const d3 = decide({ t3: { 'codex:gpt-6-sol': '' } }, 'codex:gpt-6-sol', 't3');
  t.ok('決まり方 3: 上書きの空は会話の既定（send は undefined = 会話の既定のまま。記録の強さは走らせてから決める）', d3.send === undefined && d3.effort === null && d3.source === 'conversation');
  const d4 = decide({ t3: { '*': '' } }, 'claude:sonnet', 't3');
  t.ok('決まり方 4: 段の既定が空でも会話の既定', d4.send === undefined && d4.source === 'conversation');
  const d5 = decide({ t3: { '*': 'max' } }, 'codex:gpt-6-sol', 't3');
  t.ok('決まり方 5: 持たない強さは合わせて断らず、元の強さを asked に残す', d5.send === 'xhigh' && d5.effort === 'xhigh' && d5.asked === 'max' && d5.source === 'tier');
  const d6 = decide({ t3: { 'claude:sonnet': 'xhigh' } }, 'claude:sonnet', 't3', { levels: ['low', 'medium', 'high'], fixed: null });
  t.ok('決まり方 6: 上書きでも合わせる（xhigh → high。source は override のまま）', d6.send === 'high' && d6.asked === 'xhigh' && d6.source === 'override');
  const d7 = decide(undefined, 'claude:haiku', 't1', { levels: [], fixed: null });
  t.ok('決まり方 7: 強さを持たないモデルには送らない（send は空・source none）', d7.send === '' && d7.effort === null && d7.source === 'none' && !('asked' in d7));
  const d8 = decide(undefined, 'antigravity:gemini-3.8-flash-high', 't1', { levels: [], fixed: 'high' });
  t.ok('決まり方 8: 強さがモデル名に入るモデルは送らず、名前の強さを記録する（source model）', d8.send === '' && d8.effort === 'high' && d8.source === 'model');
  const d9 = decide({ t3: { '*': 'low' } }, 'codex:gpt-6-sol', null);
  t.ok('決まり方 9: 段が決まらなければ会話の既定', d9.send === undefined && d9.source === 'conversation');
  t.ok('決まり方 10: 語彙の外の強さしか持たないモデルは送らない', decide(undefined, 'x:y', 't3', { levels: ['minimal'], fixed: null }).source === 'none');

  t.ok('やり直しの段: 元の段にその候補があればそれ、無ければ入っている最初の段、どこにも無ければ null',
    effortTierFor({ settings: tiersFor, candidate: 'claude:sonnet', preferred: 't3' }) === 't3' && effortTierFor({ settings: settings, candidate: 'claude:sonnet', preferred: 't3' }) === 't3' && effortTierFor({ settings: settings, candidate: 'claude:sonnet', preferred: 't4' }) === 't2'
    && effortTierFor({ settings: settings, candidate: 'claude:sonnet', preferred: null }) === 't2' && effortTierFor({ settings: settings, candidate: 'claude:sonnet', preferred: 't2' }) === 't2'
    && effortTierFor({ settings: settings, candidate: 'claude:nope' }) === null);
  const manual = manualRouting({ kind: 'implement', candidate: 'claude:sonnet', check: { ok: true, account: '', checkedAt: NOW }, of: 'ply-task-x', from: null, effortTier: 't3' });
  t.ok('人が選び直した記録は強さを引く段を持つ（段が無ければ付けない）', manual.effortTier === 't3'
    && !('effortTier' in manualRouting({ kind: 'implement', candidate: 'claude:sonnet', check: { ok: true, account: '', checkedAt: NOW }, of: 'ply-task-x', from: null })));

  t.ok('9 種類の kind', KINDS.length === 9);
}
