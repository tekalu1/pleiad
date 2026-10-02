// settings.*: 設定の読み出しと、設定の一覧（defineSetting）。段階 1 は読むだけ（書くのは段階 2）。
// 設定を 1 つ足しても MCP のツールと CLI のサブコマンドは増えない。ここに 1 件書けば settings.list / get / schema に出る（ADR 0081）。
// 値は ctx から読む（サーバーが渡す。prefs.json と、自分のモジュールの持つ値）。秘密は持たない（返す前の伏せ字は registry が最後の網で掛ける）。
// 設定を持つモジュールが自分の定義を出す形に移していく（compaction-settings・context-settings など）。今は 1 か所に置く。
import { z } from 'zod';
import { agentT } from '../i18n.mjs';
import { DEFAULT_COMPACTION_SETTINGS } from '../compaction-settings.mjs';
import { DEFAULTS as ROUTING_DEFAULTS } from '../delegation-routing.mjs';
import { defineOp, defineSetting, OpError } from './registry.mjs';

const prefs = async (ctx) => (await ctx.prefs?.()) ?? {};
const fromPrefs = (key) => async (ctx) => (await prefs(ctx))[key];
const loose = z.any();

const site = z.object({ origin: z.string(), mode: z.string().optional(), profile: z.string().optional() }).passthrough();
const compaction = z.object({
  enabled: z.boolean(), minTokens: z.number().int(),
  claude: z.object({ enabled: z.boolean(), delayMinutes: z.number().int() }), codex: z.object({ enabled: z.boolean(), delayMinutes: z.number().int() }),
});

const S = (key) => `agent:settings.${key}`;
const WRITE_ABOUT = 'Only changes the display or a default choice; it does not touch the conversation gates (approval mode, permissions)';
const PICK_ABOUT = 'Only picks among options a human made; it does not touch the conversation gates';

export const settings = [
  defineSetting({ key: 'locale', summary: S('locale'), risk: 'write', riskReason: `Display language. ${WRITE_ABOUT}`, prefKeys: ['locale'],
    schema: z.enum(['auto', 'ja', 'en']), default: 'auto', read: fromPrefs('locale') }),
  defineSetting({ key: 'linkOpen', summary: S('linkOpen'), risk: 'write', riskReason: `Where links open. ${WRITE_ABOUT}`,
    schema: z.enum(['inapp', 'external']), default: 'inapp', read: fromPrefs('linkOpen') }),
  defineSetting({ key: 'instructionBudget', summary: S('instructionBudget'), risk: 'write', riskReason: `The guideline shown for the instruction amount. ${WRITE_ABOUT}`,
    schema: z.number().int().nullable(), default: null, read: fromPrefs('instructionBudget') }),
  defineSetting({ key: 'backend', summary: S('backend'), risk: 'write', riskReason: `The default agent for new conversations. ${PICK_ABOUT}`,
    schema: z.string(), default: '', read: fromPrefs('backend') }),
  defineSetting({ key: 'model', summary: S('model'), risk: 'write', riskReason: `The default model for new conversations. ${PICK_ABOUT}`,
    schema: z.string(), default: '', read: fromPrefs('model') }),
  defineSetting({ key: 'effort', summary: S('effort'), risk: 'write', riskReason: `The default thinking depth for new conversations. ${PICK_ABOUT}`,
    schema: z.string(), default: '', read: fromPrefs('effort') }),
  // 承認モードは人間だけが変える（design.md §8.5）。agent には出さない
  defineSetting({ key: 'mode', summary: S('mode'), risk: 'human-only', schema: z.string(), default: '', read: fromPrefs('mode') }),
  defineSetting({ key: 'claudeAccount', summary: S('claudeAccount'), risk: 'write', riskReason: `The default Claude account (an id only, never the token). ${PICK_ABOUT}`,
    schema: z.string().nullable(), default: null, read: fromPrefs('claudeAccount') }),
  defineSetting({ key: 'compaction.auto', summary: S('compaction.auto'), risk: 'write', riskReason: `Auto compaction threshold and delay. ${WRITE_ABOUT}`, prefKeys: ['autoCompaction'],
    schema: compaction, default: DEFAULT_COMPACTION_SETTINGS, read: (ctx) => ctx.compactionSettings?.() }),
  // 確認を切る向き（オン → オフ）は関所を緩めるので guarded（広げる向きだけ確認する。ADR 0031・0082）
  defineSetting({ key: 'confirmAgentSites', summary: S('confirmAgentSites'), risk: 'write', riskReason: 'Turning the confirmation on only narrows the gate; turning it off is raised to guarded by riskOf',
    riskOf: (before, after) => (before === true && after !== true ? 'guarded' : 'write'), schema: z.boolean(), default: false, read: fromPrefs('confirmAgentSites') }),
  defineSetting({ key: 'confirmExternalLoads', summary: S('confirmExternalLoads'), risk: 'write', riskReason: 'Turning the confirmation on only narrows the gate; turning it off is raised to guarded by riskOf',
    riskOf: (before, after) => (before === true && after !== true ? 'guarded' : 'write'), schema: z.boolean(), default: false, read: fromPrefs('confirmExternalLoads') }),
  defineSetting({ key: 'agentSitePermissions', summary: S('agentSitePermissions'), risk: 'guarded', schema: z.array(site), default: [], read: fromPrefs('agentSitePermissions') }),
  defineSetting({ key: 'externalSitePermissions', summary: S('externalSitePermissions'), risk: 'guarded', schema: z.array(site), default: [], read: fromPrefs('externalSitePermissions') }),
  defineSetting({ key: 'browserProfiles', summary: S('browserProfiles'), risk: 'guarded', schema: z.array(loose), default: [], read: fromPrefs('browserProfiles') }),
  defineSetting({ key: 'browserDefaultProfile', summary: S('browserDefaultProfile'), risk: 'write', riskReason: `The built-in browser's default profile. ${PICK_ABOUT}`,
    schema: z.string().nullable(), default: null, read: fromPrefs('browserDefaultProfile') }),
  defineSetting({ key: 'browserNewProfile', summary: S('browserNewProfile'), risk: 'write', riskReason: `How a new conversation picks its profile. ${PICK_ABOUT}`,
    schema: z.string(), default: '', read: fromPrefs('browserNewProfile') }),
  // 有効にする・全アプリの許可・常に許可を足す向きは関所を緩めるので guarded
  defineSetting({ key: 'computerUse', summary: S('computerUse'), risk: 'write', riskReason: 'Disabling or removing permissions only narrows the gate; loosening it is raised to guarded by riskOf',
    riskOf: (before, after) => ((after?.enabled === true && before?.enabled !== true) || (after?.allowAllApps === true && before?.allowAllApps !== true)
      || (after?.alwaysAllowed?.length ?? 0) > (before?.alwaysAllowed?.length ?? 0) ? 'guarded' : 'write'),
    schema: z.object({ enabled: z.boolean().optional(), allowAllApps: z.boolean().optional(), alwaysAllowed: z.array(loose).optional() }).passthrough(),
    default: {}, read: (ctx) => ctx.computerUse?.() }),
  defineSetting({ key: 'delegationRouting', summary: S('delegationRouting'), risk: 'guarded', prefKeys: ['delegationRouting'],
    schema: loose, default: ROUTING_DEFAULTS, read: (ctx) => ctx.routingSettings?.() }),
  defineSetting({ key: 'plyInstructions', summary: S('plyInstructions'), risk: 'guarded', schema: loose, default: [], read: (ctx) => ctx.plyInstructions?.() }),
  defineSetting({ key: 'addedContext', summary: S('addedContext'), risk: 'guarded', schema: loose, default: null, read: fromPrefs('addedContext') }),
  // context の既定値（設定 › コンテキストの「既定」）。prefs.json ではなく context-settings.json に持つ
  defineSetting({ key: 'context.default', summary: S('context.default'), risk: 'guarded', prefKeys: [], schema: loose, default: null, read: (ctx) => ctx.contextDefaults?.() }),
];

// ---- 操作

const D = (id, key) => `agent:ops.settings.${id}.${key}`;
const missing = (ctx, key) => new OpError('SETTING_NOT_FOUND', agentT(ctx.locale, 'ops.errors.SETTING_NOT_FOUND', { key }));

/** この主体に見える設定。human-only は agent に出さない（呼ばれたら無いのと同じに見せる） */
const visible = (ctx) => ctx.registry.settings.filter((s) => ctx.principal.by === 'human' || s.risk !== 'human-only');
const find = (ctx, key) => visible(ctx).find((s) => s.key === key);
const about = (ctx, s) => ({ key: s.key, summary: agentT(ctx.locale, s.summary.slice('agent:'.length)), risk: s.risk, readOnly: s.readOnly });
const valueOf = async (ctx, s) => (await s.read(ctx)) ?? s.default;
const schemaOf = (s) => { try { return z.toJSONSchema(s.schema, { unrepresentable: 'any', io: 'output' }); } catch { return {}; } };

const settingAbout = z.object({ key: z.string(), summary: z.string(), risk: z.string(), readOnly: z.boolean() });

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
];
