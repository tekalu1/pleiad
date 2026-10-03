// mcp.*: 外部 MCP の登録。各エージェントの設定ファイル（~/.claude.json・.mcp.json・config.toml）と、Pleiad 自身の登録（担当が Pleiad のときに使う）。
// 画面の WS コマンド（listMcpConfig・savePlyMcp など）はこの操作を呼ぶ薄い外側（ADR 0095）。本体はサーバーが ctx.mcp で渡す（core/server.mjs の opsDeps）。
// 登録を保存すると、その会話の始まりに登録したコマンドが動く。だから書き込み（保存・取り込み・名前の変更・削除・全体の設定）は guarded。
// 返りの秘密（env・ヘッダーの値・bearer・clientSecret・URL のクエリ）はモジュールが伏せ、ここでも重ねて伏せる。agent にはコマンドの引数も伏せる（core/ops/redact.mjs）。
// OAuth のログインとログアウトは human-only（mcpAuthStart・mcpAuthLogout。秘密の値を扱う）で、ここには無い。
import { z } from 'zod';
import { t } from '../i18n.mjs';
import { defineOp, maskOutput } from './registry.mjs';
import { diffRows } from './settings.mjs';
import { byAgent, cwdFor, maskMcp, maskUrl, restoreMasked, run } from './redact.mjs';

const D = (id, key) => `agent:ops.mcp.${id}.${key}`;
const A = (key) => `agent:ops.mcp.arg.${key}`;

const NAME = z.string().min(1).max(128);
const where = {
  format: z.enum(['claude', 'codex']).describe(A('format')),
  scope: z.enum(['user', 'directory']).describe(A('scope')),
  cwd: z.string().max(4096).optional().describe(A('cwd')),
};
const nativeWhere = async (ctx, args) => ({ format: args.format, scope: args.scope, cwd: await cwdFor(ctx, args.cwd) });

/** 各エージェントの登録 1 つ（値は伏せる。agent には引数も） */
const nativeShown = (ctx, found) => ({ ...found, value: maskMcp(found.value, byAgent(ctx)) });
/** Pleiad の登録の一覧の行・編集欄の値 */
const plyRow = (ctx, row) => maskMcp(row, byAgent(ctx));
const plyList = (ctx, data) => ({ ...data, servers: (data.servers ?? []).map((s) => ({ ...plyRow(ctx, s), ...(s.authStatus ? { authStatus: authRow(ctx, s.authStatus) } : {}) })) });
/** 認証の状態。ログインの途中なら承認の URL（state と PKCE の値を含む）を返すが、agent には伏せる（ログインは人の操作） */
const authRow = (ctx, row) => (row && typeof row.url === 'string' && byAgent(ctx) ? { ...row, url: maskUrl(row.url) } : row);

/** 承認カードの変更（前後の値は agent に見せる形で伏せる）。before は受領証の元: 承認のあとで登録が変わっていれば聞き直す */
const change = (key, before, after, note, extra = {}) => ({ key: null, before: extra.receipt ?? before ?? null, rows: diffRows(key, before ?? null, after ?? null), note, loosens: true });

const RISK_REASON_RECONNECT = 'Only connects once with a registration a human (or an approved guarded call) already saved, the same as the start of every turn; it changes no registration, secret or permission';

export const mcpOps = [
  // ---- 各エージェントの設定ファイルの登録
  defineOp({
    id: 'mcp.nativeList', summary: 'agent:ops.mcp.nativeList.summary', risk: 'read',
    input: z.object(where),
    output: z.object({ path: z.string(), format: z.string(), scope: z.string(), revision: z.string(), servers: z.array(z.string()) }).passthrough(),
    surfaces: { ui: true, mcp: 'catalog', cli: { path: ['mcp-servers', 'native'] } },
    legacyCommand: 'listMcpConfig',
    handler: async (ctx, args) => run(ctx, async () => ctx.mcp.native.list(await nativeWhere(ctx, args))),
  }),
  defineOp({
    id: 'mcp.nativeRead', summary: 'agent:ops.mcp.nativeRead.summary', risk: 'read',
    input: z.object({ ...where, name: NAME.describe(A('nativeName')) }),
    output: z.object({ name: z.string(), revision: z.string(), value: z.record(z.string(), z.unknown()) }).passthrough(),
    surfaces: { ui: true, mcp: 'catalog', cli: { path: ['mcp-servers', 'native-read'], positional: ['name'] } },
    legacyCommand: 'readMcpServer',
    handler: async (ctx, args) => run(ctx, async () => nativeShown(ctx, await ctx.mcp.native.get({ ...(await nativeWhere(ctx, args)), name: args.name }))),
  }),
  defineOp({
    id: 'mcp.nativeSave', summary: 'agent:ops.mcp.nativeSave.summary', risk: 'guarded',
    input: z.object({
      ...where,
      name: NAME.describe(A('nativeName')),
      mode: z.enum(['add', 'edit']).describe(A('mode')),
      value: z.record(z.string(), z.unknown()).describe(D('nativeSave', 'value')),
      revision: z.string().max(100).describe(A('revision')),
      allowReformat: z.boolean().optional().describe(D('nativeSave', 'allowReformat')),
      reason: z.string().max(500).optional().describe(A('reason')),
    }),
    confirm: async (ctx, args) => {
      const at = await nativeWhere(ctx, args);
      const current = args.mode === 'edit' ? await ctx.mcp.native.get({ ...at, name: args.name }).catch(() => null) : null;
      const list = await ctx.mcp.native.list(at).catch(() => null);
      return change(`mcp.${args.name}`, current ? maskMcp(current.value, true) : null, maskMcp(args.value, true),
        t('opsApproval.mcpNativeSave', { name: args.name, file: list?.path ?? '' }), { receipt: list?.revision ?? null });
    },
    surfaces: { ui: true, mcp: 'catalog', cli: { path: ['mcp-servers', 'native-save'], positional: ['name'] } },
    legacyCommand: 'saveMcpServer',
    handler: async (ctx, { reason, ...args }) => run(ctx, async () => {
      const at = await nativeWhere(ctx, args);
      let value = args.value;
      // agent が読んだ値（伏せ字入り）をそのまま書き戻したら、伏せ字の所は今の値を残す
      if (byAgent(ctx) && args.mode === 'edit') {
        const raw = (await ctx.mcp.native.getWithSecrets({ ...at, name: args.name })).value;
        value = restoreMasked(ctx, value, maskOutput(maskMcp(raw, true)), raw, 'value');
      }
      return ctx.mcp.native.save({ ...at, name: args.name, mode: args.mode, value, revision: args.revision, ...(args.allowReformat !== undefined ? { allowReformat: args.allowReformat } : {}) });
    }),
  }),

  // ---- Pleiad の登録
  defineOp({
    id: 'mcp.list', summary: 'agent:ops.mcp.list.summary', risk: 'read',
    input: z.object({}),
    output: z.object({ file: z.string(), revision: z.string(), servers: z.array(z.record(z.string(), z.unknown())) }).passthrough(),
    surfaces: { ui: true, mcp: 'catalog', cli: { path: ['mcp-servers', 'list'] } },
    legacyCommand: 'listPlyMcp',
    handler: (ctx) => run(ctx, async () => plyList(ctx, await ctx.mcp.list())),
  }),
  defineOp({
    id: 'mcp.read', summary: 'agent:ops.mcp.read.summary', risk: 'read',
    input: z.object({ name: NAME.describe(A('name')) }),
    output: z.object({ name: z.string(), revision: z.string(), value: z.record(z.string(), z.unknown()) }).passthrough(),
    surfaces: { ui: true, mcp: 'catalog', cli: { path: ['mcp-servers', 'read'], positional: ['name'] } },
    legacyCommand: 'readPlyMcp',
    handler: (ctx, { name }) => run(ctx, async () => { const r = await ctx.mcp.read(name); return { ...r, value: plyRow(ctx, r.value) }; }),
  }),
  defineOp({
    id: 'mcp.save', summary: 'agent:ops.mcp.save.summary', risk: 'guarded',
    input: z.object({
      name: NAME.describe(A('name')),
      mode: z.enum(['add', 'edit']).describe(A('mode')),
      value: z.record(z.string(), z.unknown()).describe(D('save', 'value')),
      revision: z.string().max(100).optional().describe(A('revision')),
      reason: z.string().max(500).optional().describe(A('reason')),
    }),
    confirm: async (ctx, args) => {
      const current = args.mode === 'edit' ? await ctx.mcp.read(args.name).catch(() => null) : null;
      const list = await ctx.mcp.list().catch(() => null);
      return change(`mcp.${args.name}`, current ? maskMcp(current.value, true) : null, maskMcp(args.value, true), t('opsApproval.mcpSave', { name: args.name }), { receipt: list?.revision ?? null });
    },
    surfaces: { ui: true, mcp: 'catalog', cli: { path: ['mcp-servers', 'save'], positional: ['name'] } },
    legacyCommand: 'savePlyMcp',
    handler: (ctx, { reason, ...args }) => run(ctx, async () => {
      let value = args.value;
      // 秘密（env・bearer・ヘッダー・clientSecret）の伏せ字は登録のモジュールが前の値を残す。引数の伏せ字だけここで戻す
      if (byAgent(ctx) && args.mode === 'edit' && Array.isArray(value.args)) {
        const raw = (await ctx.mcp.registration(args.name)).args;
        value = { ...value, args: restoreMasked(ctx, value.args, maskOutput(maskMcp({ args: raw }, true)).args, raw, 'value.args') };
      }
      return ctx.mcp.save({ ...args, value });
    }),
  }),
  defineOp({
    id: 'mcp.delete', summary: 'agent:ops.mcp.delete.summary', risk: 'guarded',
    input: z.object({ name: NAME.describe(A('name')), reason: z.string().max(500).optional().describe(A('reason')) }),
    confirm: async (ctx, { name }) => {
      const current = await ctx.mcp.read(name).catch(() => null);
      return { ...change(`mcp.${name}`, current ? maskMcp(current.value, true) : null, null, t('opsApproval.mcpDelete', { name }), { receipt: current?.revision ?? null }), loosens: false };
    },
    surfaces: { ui: true, mcp: 'catalog', cli: { path: ['mcp-servers', 'delete'], positional: ['name'] } },
    legacyCommand: 'deletePlyMcp',
    handler: (ctx, { name }) => run(ctx, () => ctx.mcp.remove(name)),
  }),
  defineOp({
    id: 'mcp.rename', summary: 'agent:ops.mcp.rename.summary', risk: 'guarded',
    input: z.object({ name: NAME.describe(A('name')), to: NAME.describe(D('rename', 'to')), reason: z.string().max(500).optional().describe(A('reason')) }),
    confirm: async (ctx, { name, to }) => {
      const list = await ctx.mcp.list().catch(() => null);
      return { key: null, before: list?.revision ?? null, rows: [{ path: 'mcp.name', before: JSON.stringify(name), after: JSON.stringify(to) }], note: t('opsApproval.mcpRename', { name, to }), loosens: false };
    },
    surfaces: { ui: true, mcp: 'catalog', cli: { path: ['mcp-servers', 'rename'], positional: ['name', 'to'] } },
    legacyCommand: 'renamePlyMcp',
    handler: (ctx, { name, to }) => run(ctx, () => ctx.mcp.rename(name, to)),
  }),
  defineOp({
    id: 'mcp.import', summary: 'agent:ops.mcp.import.summary', risk: 'guarded',
    input: z.object({
      items: z.array(z.object({
        format: z.string().max(20), scope: z.string().max(20), name: NAME, cwd: z.string().max(4096).optional(), as: NAME.optional(), auth: z.string().max(20).optional(),
      }).strict()).min(1).max(64).describe(D('import', 'items')),
      includeSecrets: z.boolean().optional().describe(D('import', 'includeSecrets')),
      reason: z.string().max(500).optional().describe(A('reason')),
    }),
    confirm: async (ctx, { items, includeSecrets }) => {
      const list = await ctx.mcp.list().catch(() => null);
      return { key: null, before: list?.revision ?? null,
        rows: items.slice(0, 8).map((i) => ({ path: `mcp.${i.as || i.name}`, before: null, after: JSON.stringify({ from: `${i.format}/${i.scope}`, name: i.name }) })),
        note: includeSecrets ? t('opsApproval.mcpImportSecrets', { count: items.length }) : t('opsApproval.mcpImport', { count: items.length }), loosens: true };
    },
    surfaces: { ui: true, mcp: 'catalog', cli: { path: ['mcp-servers', 'import'] } },
    legacyCommand: 'importPlyMcp',
    handler: async (ctx, { items, includeSecrets }) => run(ctx, async () => ctx.mcp.import(await Promise.all(items.map(async (i) => ({ ...i, cwd: await cwdFor(ctx, i.cwd) }))), includeSecrets === true)),
  }),
  defineOp({
    id: 'mcp.setSettings', summary: 'agent:ops.mcp.setSettings.summary', risk: 'guarded',
    input: z.object({ clientMetadataUrl: z.string().max(4096).nullable().optional().describe(D('setSettings', 'clientMetadataUrl')), reason: z.string().max(500).optional().describe(A('reason')) }),
    confirm: async (ctx, { clientMetadataUrl }) => {
      const before = await ctx.mcp.settings().catch(() => null);
      return { key: null, before, rows: diffRows('mcp.settings', before, { ...before, ...(clientMetadataUrl !== undefined ? { clientMetadataUrl: clientMetadataUrl || null } : {}) }), note: t('opsApproval.mcpSettings'), loosens: true };
    },
    surfaces: { ui: true, mcp: 'catalog', cli: { path: ['mcp-servers', 'settings'] } },
    legacyCommand: 'setPlyMcpSettings',
    handler: (ctx, { reason, ...value }) => run(ctx, () => ctx.mcp.setSettings(value)),
  }),
  defineOp({
    id: 'mcp.authStatus', summary: 'agent:ops.mcp.authStatus.summary', risk: 'read',
    input: z.object({ name: NAME.optional().describe(D('authStatus', 'name')) }),
    output: z.object({ servers: z.array(z.record(z.string(), z.unknown())) }).passthrough(),
    surfaces: { ui: true, mcp: 'catalog', cli: { path: ['mcp-servers', 'auth'], positional: ['name'] } },
    legacyCommand: 'mcpAuthStatus',
    handler: (ctx, { name }) => run(ctx, async () => { const r = await ctx.mcp.authStatus(name); return { ...r, servers: r.servers.map((s) => authRow(ctx, s)) }; }),
  }),
  defineOp({
    id: 'mcp.reconnect', summary: 'agent:ops.mcp.reconnect.summary', risk: 'write', riskReason: RISK_REASON_RECONNECT,
    input: z.object({ name: NAME.describe(A('name')), cwd: z.string().max(4096).optional().describe(A('cwd')) }),
    output: z.object({ name: z.string(), status: z.string(), tools: z.number(), reason: z.string().nullable() }),
    surfaces: { ui: true, mcp: 'catalog', cli: { path: ['mcp-servers', 'reconnect'], positional: ['name'] } },
    legacyCommand: 'mcpReconnect',
    handler: async (ctx, { name, cwd }) => run(ctx, async () => ctx.mcp.reconnect(name, await cwdFor(ctx, cwd))),
  }),
];
