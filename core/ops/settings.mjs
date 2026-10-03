// settings.*: 設定の一覧（defineSetting）と、そこから作る 4 つの操作（list・get・schema・set）。
// 設定を 1 つ足しても MCP のツールと CLI のサブコマンドは増えない。ここに 1 件書けば settings.list / get / schema / set に出る（ADR 0081）。
// 値は ctx から読む（サーバーが渡す。prefs.json と、自分のモジュールの持つ値）。秘密は持たない（返す前の伏せ字は registry が最後の網で掛ける）。
//
// 書き方（ADR 0082）: settings.set は write の操作で、設定ごとの危険度は defineSetting の risk と riskOf（関所を緩める向きだけ guarded）で決まる。
//   write の設定は agent も通す。guarded は会話の承認モードで決まり（承認なしのモードは通す・それ以外は承認カード・束縛なしは NEEDS_UI）、
//   human-only（承認モード・アカウント）は agent の一覧にも set にも出ない。
// 検査と保存は、画面の WS コマンド setPref と同じこの定義を通る（どの口から変えても同じ検査・同じ配信）。サーバーの状態に触る保存は ctx.writes、
// 検査に要るサーバーの知識（エージェントの有無・モデルの語彙・アカウント）は ctx.host から借りる（core/server.mjs の opsDeps）。
import os from 'node:os';
import { z } from 'zod';
import { agentT, LOCALE_SETTINGS, t } from '../i18n.mjs';
import { DEFAULT_COMPACTION_SETTINGS, normalizeCompactionSettings } from '../compaction-settings.mjs';
import { DEFAULT_LIMIT_RESUME, normalizeLimitResume } from '../resume-queue.mjs';
import { DEFAULTS as ROUTING_DEFAULTS, normalizeSettings as normalizeRoutingSettings, RoutingSettingsError, RETIRED_KEYS as ROUTING_RETIRED_KEYS } from '../delegation-routing.mjs';
import { KINDS as CONTEXT_KINDS, normalizeKind as normalizeContextKind } from '../context-settings.mjs';
import { MIN_BUDGET, MAX_BUDGET } from '../../web/instruction-amount.mjs';
import { validProfilePref } from '../../web/browser-profiles.mjs';
import { validBrowserPref } from '../../web/browser-confirm-policy.mjs';
import { computerUsePrefs, validComputerUse } from '../../web/computer-prefs.mjs';
import { defineOp, defineSetting, OpError, stableStringify } from './registry.mjs';
import { maxRisk } from './policy.mjs';

const prefs = async (ctx) => (await ctx.prefs?.()) ?? {};
const fromPrefs = (key) => async (ctx) => (await prefs(ctx))[key];
const loose = z.any();
const same = (a, b) => stableStringify(a) === stableStringify(b);

// 画面（人間）には従来の文（server 辞書。画面の言語）、agent には code と detail（会話の言語）で返す
const invalid = (ctx, detail, human) => new OpError('INVALID', human && ctx.principal?.by === 'human' ? human : agentT(ctx.locale, 'ops.errors.INVALID', { detail }));

const site = z.object({ origin: z.string(), mode: z.string().optional(), profile: z.string().optional() }).passthrough();
const compaction = z.object({
  enabled: z.boolean(), minTokens: z.number().int(),
  claude: z.object({ enabled: z.boolean(), delayMinutes: z.number().int() }), codex: z.object({ enabled: z.boolean(), delayMinutes: z.number().int() }),
});
const compactionPatch = z.object({
  enabled: z.boolean(), minTokens: z.number().int(),
  claude: z.object({ enabled: z.boolean(), delayMinutes: z.number().int() }).partial(), codex: z.object({ enabled: z.boolean(), delayMinutes: z.number().int() }).partial(),
}).partial();

const S = (key) => `agent:settings.${key}`;
const WRITE_ABOUT = 'Only changes the display or a default choice; it does not touch the conversation gates (approval mode, permissions)';
const PICK_ABOUT = 'Only picks among options a human made; it does not touch the conversation gates';
const NARROW_ABOUT = 'Narrowing the gate (the confirmation on, a site or app permission removed) is write; loosening it is raised to guarded by riskOf';

// ---- 検査（normalize）。{ after, arg?, view? } を返す。after は書いたあとの値、arg は write に渡すもの、view は承認カードの前後（読んだ値と形が違うとき）

/** ふつうの prefs のキー: 検査して保存する。nullable の設定は null で既定に戻す（prefs から消える） */
const plainPref = (key, check, { nullable = false } = {}) => ({
  normalize: async (ctx, value, extra) => {
    if (value === null && !nullable) throw invalid(ctx, `${key}: null`);
    return { after: value === null ? null : await check(ctx, value, extra) };
  },
  write: (ctx, value, { backend }) => ctx.writes.pref(key, value, backend),
});

const knownValue = (key) => async (ctx, value, { backend }) => {
  if (backend !== undefined && !ctx.host.hasBackend(backend)) throw invalid(ctx, `backend: ${backend}`, t('agents.unknown'));
  if (!(await ctx.host.knows(key, value, backend))) throw invalid(ctx, `${key}: ${String(value).slice(0, 80)}`);
  return value;
};

const sitesKey = (row) => `${row?.agent ?? ''}|${row?.profile ?? 'main'}|${row?.origin ?? ''}`;
const alwaysSites = (rows) => new Set((Array.isArray(rows) ? rows : []).filter((row) => row?.mode === 'always').map(sitesKey));
/** 「常に許可」の行が増えた（または ask から always に変わった）ときだけ関所を緩める */
const sitesRiskOf = (before, after) => { const had = alwaysSites(before); return [...alwaysSites(after)].some((k) => !had.has(k)) ? 'guarded' : 'write'; };
const siteExample = { origin: 'https://a.example', mode: 'always', agent: 'claude' };

const confirmRiskOf = (before, after) => (before === true && after !== true ? 'guarded' : 'write');
const confirmExamples = [{ before: true, after: false, risk: 'guarded' }, { before: false, after: true, risk: 'write' }];

export const settings = [
  defineSetting({ key: 'locale', summary: S('locale'), risk: 'write', riskReason: `Display language. ${WRITE_ABOUT}`, prefKeys: ['locale'],
    schema: z.enum(['auto', 'ja', 'en']), default: 'auto', read: fromPrefs('locale'),
    ...plainPref('locale', (ctx, v) => { if (!LOCALE_SETTINGS.includes(v)) throw invalid(ctx, `locale: ${v}`, t('errors.unknownLocale', { value: v })); return v; }) }),
  defineSetting({ key: 'linkOpen', summary: S('linkOpen'), risk: 'write', riskReason: `Where links open. ${WRITE_ABOUT}`,
    schema: z.enum(['inapp', 'external']), default: 'inapp', read: fromPrefs('linkOpen'),
    ...plainPref('linkOpen', (ctx, v) => { if (v !== 'inapp' && v !== 'external') throw invalid(ctx, `linkOpen: ${v}`); return v; }) }),
  defineSetting({ key: 'instructionBudget', summary: S('instructionBudget'), risk: 'write', riskReason: `The guideline shown for the instruction amount. ${WRITE_ABOUT}`,
    schema: z.number().int().nullable(), default: null, read: fromPrefs('instructionBudget'),
    ...plainPref('instructionBudget', (ctx, v) => { if (!(Number.isInteger(v) && v >= MIN_BUDGET && v <= MAX_BUDGET)) throw invalid(ctx, `instructionBudget: ${MIN_BUDGET}..${MAX_BUDGET}`); return v; }, { nullable: true }) }),
  defineSetting({ key: 'backend', summary: S('backend'), risk: 'write', riskReason: `The default agent for new conversations. ${PICK_ABOUT}`,
    schema: z.string(), default: '', read: fromPrefs('backend'),
    ...plainPref('backend', (ctx, v) => { if (typeof v !== 'string' || !ctx.host.hasBackend(v)) throw invalid(ctx, `backend: ${String(v).slice(0, 40)}`, t('agents.unknown')); return v; }) }),
  defineSetting({ key: 'memoryLearnBackend', summary: S('memoryLearnBackend'), risk: 'write', riskReason: PICK_ABOUT,
    schema: z.string(), default: '', read: fromPrefs('memoryLearnBackend'),
    ...plainPref('memoryLearnBackend', (ctx, v) => { if (v !== '' && !ctx.host.hasBackend(v)) throw invalid(ctx, `memoryLearnBackend: ${String(v).slice(0, 40)}`); return v; }) }),
  defineSetting({ key: 'memoryLearnAt', summary: S('memoryLearnAt'), risk: 'write', riskReason: WRITE_ABOUT,
    schema: z.string(), default: '02:00', read: fromPrefs('memoryLearnAt'),
    ...plainPref('memoryLearnAt', (ctx, v) => { if (typeof v !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(v)) throw invalid(ctx, 'memoryLearnAt: HH:MM'); return v; }) }),
  defineSetting({ key: 'memoryLearnPaused', summary: S('memoryLearnPaused'), risk: 'write', riskReason: WRITE_ABOUT,
    schema: z.boolean(), default: false, read: fromPrefs('memoryLearnPaused'),
    ...plainPref('memoryLearnPaused', (ctx, v) => { if (typeof v !== 'boolean') throw invalid(ctx, 'memoryLearnPaused: boolean'); return v; }) }),
  defineSetting({ key: 'model', summary: S('model'), risk: 'write', riskReason: `The default model for new conversations. ${PICK_ABOUT}`,
    schema: z.string(), default: '', read: fromPrefs('model'), ...plainPref('model', knownValue('model')) }),
  defineSetting({ key: 'effort', summary: S('effort'), risk: 'write', riskReason: `The default thinking depth for new conversations. ${PICK_ABOUT}`,
    schema: z.string(), default: '', read: fromPrefs('effort'),
    ...plainPref('effort', (ctx, v) => { if (typeof v !== 'string' || !/^[a-z]{0,20}$/.test(v)) throw invalid(ctx, `effort: ${String(v).slice(0, 40)}`); return v; }) }),
  // 承認モードは人間だけが変える（design.md §8.5）。agent には出さない
  defineSetting({ key: 'mode', summary: S('mode'), risk: 'human-only', schema: z.string(), default: '', read: fromPrefs('mode'), ...plainPref('mode', knownValue('mode')) }),
  // 既定のアカウントを替えると、新しい会話が別の契約・課金で動く。アカウントは human-only（ADR 0082）
  defineSetting({ key: 'claudeAccount', summary: S('claudeAccount'), risk: 'human-only', schema: z.string().nullable(), default: null, read: fromPrefs('claudeAccount'),
    ...plainPref('claudeAccount', async (ctx, v) => { if (!(await ctx.host.accountIds()).includes(v)) throw invalid(ctx, `claudeAccount: ${String(v).slice(0, 40)}`); return v; }, { nullable: true }) }),
  defineSetting({ key: 'limitResume', summary: S('limitResume'), risk: 'write',
    riskReason: 'Only chooses how conversations that already stopped at the usage limit continue (auto, ask or off), how many resume at once and the usage guard. '
      + 'It never switches the Claude account (human-only) and does not touch approval modes or permissions; the default is already auto (ADR 0094)',
    prefKeys: ['limitResume'], schema: z.object({ mode: z.enum(['auto', 'ask', 'off']),
      concurrency: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]),
      guardPercent: z.union([z.literal(30), z.literal(50), z.null()]) }),
    default: DEFAULT_LIMIT_RESUME, read: async ctx => normalizeLimitResume((await prefs(ctx)).limitResume),
    normalize: (ctx, input) => {
      if (!input || typeof input !== 'object' || !['auto', 'ask', 'off'].includes(input.mode)
        || ![0, 1, 2, 3].includes(input.concurrency) || ![30, 50, null].includes(input.guardPercent)) throw invalid(ctx, 'limitResume');
      return { after: normalizeLimitResume(input) };
    },
    write: (ctx, value) => ctx.writes.pref('limitResume', value) }),
  defineSetting({ key: 'compaction.auto', summary: S('compaction.auto'), risk: 'write', riskReason: `Auto compaction threshold and delay. ${WRITE_ABOUT}`, prefKeys: ['autoCompaction'],
    schema: compaction, writeSchema: compactionPatch, default: DEFAULT_COMPACTION_SETTINGS, read: (ctx) => ctx.compactionSettings?.(),
    normalize: (ctx, input, { before }) => {
      try {
        return { after: normalizeCompactionSettings({ ...before, ...input, claude: { ...before.claude, ...input.claude }, codex: { ...before.codex, ...input.codex } }) };
      } catch (e) { throw invalid(ctx, 'compaction.auto', String(e?.message ?? e)); }
    },
    write: (ctx, value) => ctx.writes.compaction(value) }),
  // 確認を切る向き（オン → オフ）は関所を緩めるので guarded（広げる向きだけ確認する。ADR 0031・0082）
  defineSetting({ key: 'confirmAgentSites', summary: S('confirmAgentSites'), risk: 'write', riskReason: `Turning the confirmation on only narrows the gate; turning it off is raised to guarded by riskOf`,
    riskOf: confirmRiskOf, riskExamples: confirmExamples, schema: z.boolean(), default: false, read: fromPrefs('confirmAgentSites'),
    normalize: (ctx, v) => { if (!validBrowserPref('confirmAgentSites', v)) throw invalid(ctx, 'confirmAgentSites: boolean'); return { after: v }; },
    write: (ctx, v) => ctx.writes.browserPref('confirmAgentSites', v) }),
  defineSetting({ key: 'confirmExternalLoads', summary: S('confirmExternalLoads'), risk: 'write', riskReason: `Turning the confirmation on only narrows the gate; turning it off is raised to guarded by riskOf`,
    riskOf: confirmRiskOf, riskExamples: confirmExamples, schema: z.boolean(), default: false, read: fromPrefs('confirmExternalLoads'),
    normalize: (ctx, v) => { if (!validBrowserPref('confirmExternalLoads', v)) throw invalid(ctx, 'confirmExternalLoads: boolean'); return { after: v }; },
    write: (ctx, v) => ctx.writes.browserPref('confirmExternalLoads', v) }),
  ...['agentSitePermissions', 'externalSitePermissions'].map((key) => defineSetting({ key, summary: S(key), risk: 'write', riskReason: NARROW_ABOUT,
    riskOf: sitesRiskOf,
    riskExamples: [{ before: [], after: [siteExample], risk: 'guarded' }, { before: [siteExample], after: [], risk: 'write' }, { before: [siteExample], after: [{ ...siteExample, mode: 'ask' }], risk: 'write' }],
    schema: z.array(site), default: [], read: fromPrefs(key),
    normalize: (ctx, v) => { if (!validBrowserPref(key, v)) throw invalid(ctx, `${key}: ${JSON.stringify(v)?.slice(0, 80)}`); return { after: v }; },
    write: (ctx, v) => ctx.writes.browserPref(key, v) })),
  defineSetting({ key: 'browserProfiles', summary: S('browserProfiles'), risk: 'guarded', schema: z.array(loose), default: [], read: fromPrefs('browserProfiles'),
    normalize: async (ctx, v) => { if (!validProfilePref('browserProfiles', v, await prefs(ctx))) throw invalid(ctx, 'browserProfiles'); return { after: v }; },
    write: (ctx, v) => ctx.writes.browserProfiles(v) }),
  defineSetting({ key: 'browserDefaultProfile', summary: S('browserDefaultProfile'), risk: 'write', riskReason: `The built-in browser's default profile. ${PICK_ABOUT}`,
    schema: z.string().nullable(), default: null, read: fromPrefs('browserDefaultProfile'),
    normalize: async (ctx, v) => { if (!validProfilePref('browserDefaultProfile', v, await prefs(ctx))) throw invalid(ctx, `browserDefaultProfile: ${String(v).slice(0, 40)}`); return { after: v }; },
    write: (ctx, v) => ctx.writes.browserProfiles(v, 'browserDefaultProfile') }),
  defineSetting({ key: 'browserNewProfile', summary: S('browserNewProfile'), risk: 'write', riskReason: `How a new conversation picks its profile. ${PICK_ABOUT}`,
    schema: z.string(), default: '', read: fromPrefs('browserNewProfile'),
    normalize: async (ctx, v) => { if (!validProfilePref('browserNewProfile', v, await prefs(ctx))) throw invalid(ctx, `browserNewProfile: ${String(v).slice(0, 40)}`); return { after: v }; },
    write: (ctx, v) => ctx.writes.browserProfiles(v, 'browserNewProfile') }),
  // 有効にする・全アプリの許可・常に許可を足す向きは関所を緩めるので guarded
  defineSetting({ key: 'computerUse', summary: S('computerUse'), risk: 'write', riskReason: NARROW_ABOUT,
    riskOf: (before, after) => ((after?.enabled === true && before?.enabled !== true) || (after?.allowAllApps === true && before?.allowAllApps !== true)
      || (after?.alwaysAllowed?.length ?? 0) > (before?.alwaysAllowed?.length ?? 0) ? 'guarded' : 'write'),
    riskExamples: [
      { before: { enabled: false, allowAllApps: false, alwaysAllowed: [] }, after: { enabled: true, allowAllApps: false, alwaysAllowed: [] }, risk: 'guarded' },
      { before: { enabled: true, allowAllApps: false, alwaysAllowed: [] }, after: { enabled: true, allowAllApps: true, alwaysAllowed: [] }, risk: 'guarded' },
      { before: { enabled: true, allowAllApps: false, alwaysAllowed: [] }, after: { enabled: true, allowAllApps: false, alwaysAllowed: [{ id: 'exe:c:/a.exe' }] }, risk: 'guarded' },
      { before: { enabled: true, allowAllApps: true, alwaysAllowed: [{ id: 'exe:c:/a.exe' }] }, after: { enabled: false, allowAllApps: false, alwaysAllowed: [] }, risk: 'write' },
    ],
    schema: z.object({ enabled: z.boolean().optional(), allowAllApps: z.boolean().optional(), alwaysAllowed: z.array(loose).optional() }).passthrough(),
    default: {}, read: async (ctx) => computerUsePrefs(await prefs(ctx)),
    normalize: async (ctx, v) => {
      if (v === null) return { after: computerUsePrefs({}), arg: null };   // 既定に戻す
      const next = validComputerUse(v, computerUsePrefs(await prefs(ctx)));
      if (!next) throw invalid(ctx, `computerUse: ${JSON.stringify(v)?.slice(0, 80)}`);
      return { after: next };
    },
    // 変わらないなら保存しない（全画面へ prefs を流さない）
    write: async (ctx, v) => {
      const current = await prefs(ctx);
      if (v !== null && current.computerUse && same(computerUsePrefs(current), v)) return;
      await ctx.writes.pref('computerUse', v);
    } }),
  // 渡した項目だけを重ねる。null の項目は既定に戻す。判定器のキーは human-only の別の口で、ここには出ない
  defineSetting({ key: 'delegationRouting', summary: S('delegationRouting'), risk: 'guarded', prefKeys: ['delegationRouting'],
    schema: loose, writeSchema: z.record(z.string(), z.unknown()), default: ROUTING_DEFAULTS, read: (ctx) => ctx.routingSettings?.(),
    normalize: async (ctx, patch) => {
      const raw = { ...((await prefs(ctx)).delegationRouting ?? {}) };
      for (const [key, value] of Object.entries(patch)) { if (value === null) delete raw[key]; else raw[key] = structuredClone(value); }
      for (const key of ROUTING_RETIRED_KEYS) delete raw[key];
      try { return { after: normalizeRoutingSettings(raw, { strict: true }), arg: { patch } }; }
      catch (e) { const why = e instanceof RoutingSettingsError ? t(`routing.settings.${e.code}`, e.detail) : String(e?.message ?? e); throw invalid(ctx, why, why); }
    },
    write: (ctx, arg) => ctx.writes.routing(arg.patch) }),
  // action は save / toggle / delete / reset / order（core/ply-instructions.mjs の changePlyInstructions）。読むのは項目の一覧
  defineSetting({ key: 'plyInstructions', summary: S('plyInstructions'), risk: 'guarded', schema: loose, writeSchema: z.object({ action: z.enum(['save', 'toggle', 'delete', 'reset', 'order']) }).passthrough(),
    default: [], read: (ctx) => ctx.plyInstructions?.(),
    normalize: (ctx, action) => {
      try { return { after: ctx.host.changePlyInstructions(action) }; }
      catch (e) { throw invalid(ctx, String(e?.message ?? e)); }
    },
    write: (ctx, next) => ctx.writes.plyInstructions(next) }),
  // 前の版の委譲の指示のスイッチ。plyInstructions に置き換わっていて、読むだけ（plyInstructions を変えると片付く）
  defineSetting({ key: 'addedContext', summary: S('addedContext'), risk: 'guarded', schema: loose, default: null, read: fromPrefs('addedContext') }),
  // context の既定値（設定 › コンテキストの「既定」）。prefs.json ではなく context-settings.json に持つ。読むのは全体の形、書くのは 1 か所の差分:
  //   { kind, value }  その種類の担当と探索元（null で既定に戻す）  /  { kind?, roots }  追加で探すフォルダー（null で空）
  defineSetting({ key: 'context.default', summary: S('context.default'), risk: 'guarded', prefKeys: [], schema: loose,
    writeSchema: z.object({ kind: z.enum(CONTEXT_KINDS).optional(), value: z.unknown().optional(), roots: z.array(z.string().max(4096)).max(50).nullable().optional() }).strict(),
    default: null, read: (ctx) => ctx.contextDefaults?.(),
    normalize: async (ctx, patch, { before }) => {
      const setsValue = Object.hasOwn(patch, 'value'), setsRoots = Object.hasOwn(patch, 'roots');
      if (setsValue === setsRoots || (setsValue && !patch.kind)) throw invalid(ctx, 'context.default: { kind, value } or { kind?, roots }');
      const current = (kind) => before?.kinds?.[kind]?.value ?? null;
      if (setsValue) {
        let value = null;
        if (patch.value !== null) { try { value = normalizeContextKind(patch.kind, patch.value, os.homedir(), os.homedir()); } catch (e) { throw invalid(ctx, String(e?.message ?? e)); } }
        return { after: patch, arg: { place: null, kind: patch.kind, value: patch.value }, view: { before: { kind: patch.kind, value: current(patch.kind) }, after: { kind: patch.kind, value } } };
      }
      const roots = (kind) => (kind ? before?.roots?.value?.[kind] : before?.roots?.value) ?? null;
      return { after: patch, arg: { place: null, ...(patch.kind ? { kind: patch.kind } : {}), roots: patch.roots }, view: { before: { kind: patch.kind ?? 'all', roots: roots(patch.kind) }, after: { kind: patch.kind ?? 'all', roots: patch.roots } } };
    },
    write: (ctx, arg) => ctx.writes.context(arg) }),
];

// ---- 操作

const D = (id, key) => `agent:ops.settings.${id}.${key}`;
const missing = (ctx, key) => new OpError('SETTING_NOT_FOUND', ctx.principal?.by === 'human' ? t('settings.unknownPref', { key }) : agentT(ctx.locale, 'ops.errors.SETTING_NOT_FOUND', { key }));

/** この主体に見える設定。human-only は agent に出さない（呼ばれたら無いのと同じに見せる） */
const visible = (ctx) => ctx.registry.settings.filter((s) => ctx.principal.by === 'human' || s.risk !== 'human-only');
const find = (ctx, key) => visible(ctx).find((s) => s.key === key);
const about = (ctx, s) => ({ key: s.key, summary: agentT(ctx.locale, s.summary.slice('agent:'.length)), risk: s.risk, readOnly: s.readOnly });
const valueOf = async (ctx, s) => (await s.read(ctx)) ?? s.default;
const schemaOf = (s) => { try { return z.toJSONSchema(s.writeSchema ?? s.schema, { unrepresentable: 'any', io: 'output' }); } catch { return {}; } };

const settingAbout = z.object({ key: z.string(), summary: z.string(), risk: z.string(), readOnly: z.boolean() });

const ROWS_MAX = 8;
const CLIP = 160;
const show = (value) => {
  if (value === undefined) return null;
  const text = JSON.stringify(value) ?? 'null';
  return text.length > CLIP ? `${text.slice(0, CLIP - 1)}…` : text;
};
const plain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** 承認カードに出す前後。オブジェクトは変わった項目だけ（項目名は key.項目）、それ以外は値そのもの。値は JSON の文字列（等幅で出す） */
export function diffRows(key, before, after) {
  if (plain(before) && plain(after)) {
    const rows = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((k) => !same(before[k], after[k]))
      .map((k) => ({ path: `${key}.${k}`, before: show(before[k]), after: show(after[k]) }));
    if (rows.length) return rows.slice(0, ROWS_MAX);
  }
  return [{ path: key, before: show(before), after: show(after) }];
}

/**
 * settings.set の下ごしらえ: 設定を引き、値を検査して、前後・危険度・承認カードに出す変更を作る。riskOf・confirm・handler が同じ結果を使う
 * （承認のあとに作り直して受領証を照合するので、読むたびに今の値から作る）。
 */
async function prepare(ctx, { key, value, backend }) {
  const s = find(ctx, key);
  if (!s) throw missing(ctx, key);
  if (s.readOnly) throw new OpError('SETTING_READ_ONLY', agentT(ctx.locale, 'ops.errors.SETTING_READ_ONLY', { key }));
  if (value === undefined) throw invalid(ctx, 'value: required');
  if (s.writeSchema) {
    const parsed = s.writeSchema.safeParse(value);
    if (!parsed.success) throw invalid(ctx, parsed.error.issues.map((i) => `${['value', ...i.path].join('.')}: ${i.message}`).join('; '));
    value = parsed.data;
  } else if (!s.normalize) {
    const parsed = s.schema.safeParse(value);
    if (!parsed.success) throw invalid(ctx, parsed.error.issues.map((i) => `${['value', ...i.path].join('.')}: ${i.message}`).join('; '));
  }
  const before = await valueOf(ctx, s);
  const done = s.normalize ? await s.normalize(ctx, value, { before, backend }) : { after: value };
  const view = done.view ?? { before, after: done.after };
  const changed = !same(view.before, view.after);
  const raised = changed && s.riskOf ? s.riskOf(before, done.after) : s.risk;
  const risk = changed ? maxRisk(s.risk, raised) : 'write';
  const loosens = changed && Boolean(s.riskOf) && raised === 'guarded';
  return { setting: s, before, after: done.after, arg: done.arg ?? done.after, backend, changed, risk,
    change: { key, before, rows: diffRows(key, view.before, view.after), loosens } };
}

export const settingOps = [
  defineOp({
    id: 'settings.list',
    summary: 'agent:ops.settings.list.summary',
    risk: 'read',
    input: z.object({ prefix: z.string().max(100).optional().describe(D('list', 'prefix')) }),
    output: z.object({ settings: z.array(settingAbout) }),
    surfaces: { ui: true, mcp: 'catalog', cli: { path: ['settings', 'list'] } },
    handler: (ctx, { prefix }) => ({ settings: visible(ctx).filter((s) => !prefix || s.key.startsWith(prefix)).map((s) => about(ctx, s)) }),
  }),

  defineOp({
    id: 'settings.get',
    summary: 'agent:ops.settings.get.summary',
    risk: 'read',
    input: z.object({ key: z.string().min(1).max(100).describe(D('get', 'key')) }),
    output: settingAbout.extend({ value: z.unknown(), default: z.unknown() }),
    surfaces: { ui: true, mcp: 'direct', cli: { path: ['settings', 'get'], positional: ['key'] } },
    handler: async (ctx, { key }) => {
      const s = find(ctx, key);
      if (!s) throw missing(ctx, key);
      return { ...about(ctx, s), value: await valueOf(ctx, s), default: s.default };
    },
  }),

  defineOp({
    id: 'settings.schema',
    summary: 'agent:ops.settings.schema.summary',
    risk: 'read',
    input: z.object({ key: z.string().min(1).max(100).optional().describe(D('schema', 'key')) }),
    output: z.object({ settings: z.array(settingAbout.extend({ schema: z.unknown(), default: z.unknown() })) }),
    surfaces: { ui: true, mcp: 'catalog', cli: { path: ['settings', 'schema'], positional: ['key'] } },
    handler: (ctx, { key }) => {
      const picked = key === undefined ? visible(ctx) : [find(ctx, key)].filter(Boolean);
      if (key !== undefined && !picked.length) throw missing(ctx, key);
      return { settings: picked.map((s) => ({ ...about(ctx, s), schema: schemaOf(s), default: s.default })) };
    },
  }),

  // 設定ごとの危険度（defineSetting の risk と riskOf）が、この操作の危険度になる。write の設定は agent も通し、関所を緩める向きは承認カード
  // （会話の承認モードで決まる。ADR 0082）、human-only は agent には無いのと同じ。値の検査・保存・配信は画面の setPref と同じ定義を通る
  defineOp({
    id: 'settings.set',
    summary: 'agent:ops.settings.set.summary',
    risk: 'write',
    riskReason: 'Each setting carries its own risk: the write settings only change a display or a default; the ones that loosen a gate are raised to guarded by riskOf (an approval card for the user), and human-only settings are invisible to an agent',
    legacyCommand: 'setPref',
    // 画面の別の入口。setAutoCompaction（設定 › 自動圧縮）は key が compaction.auto、setDelegationRouting（設定 › 委譲）は key が delegationRouting
    // の settings.set と同じ定義を通る（検査・保存・配信・AI から見た危険度が同じ。ADR 0091 追記）
    legacyAliases: ['setAutoCompaction', 'setDelegationRouting'],
    input: z.object({
      key: z.string().min(1).max(100).describe(D('set', 'key')),
      value: z.unknown().describe(D('set', 'value')),
      reason: z.string().max(500).optional().describe(D('set', 'reason')),
      backend: z.string().max(40).optional().describe(D('set', 'backend')),
    }),
    riskOf: async (ctx, args) => (await prepare(ctx, args)).risk,
    confirm: async (ctx, args) => (await prepare(ctx, args)).change,
    surfaces: { ui: true, mcp: 'direct', cli: { path: ['settings', 'set'], positional: ['key', 'value'] } },
    handler: async (ctx, args) => {
      const p = await prepare(ctx, args);
      // 変わらない値でも保存は通す（エージェントごとに覚える値・画面の言語の反映など、書く側に副作用があるため。同じ値なので承認は要らない）。記録と配信は変わったときだけ
      await p.setting.write(ctx, p.arg, { before: p.before, backend: p.backend });
      if (p.changed) await ctx.recordSetting?.({ key: args.key, before: p.before, after: p.after, reason: args.reason ?? null, actor: ctx.actor, risk: p.risk });
      return { key: args.key, changed: p.changed, value: await valueOf(ctx, p.setting) };
    },
  }),
];
