// hooks.*: Hooks。各エージェントの元の設定ファイルの定義（core/hooks-config.mjs）と、Pleiad 自身の登録と担当（<data>/hooks.json。core/ply-hooks.mjs、ADR 0049）。
// 画面の WS コマンド（scanHooks・savePlyHook など）はこの操作を呼ぶ薄い外側（ADR 0095）。本体はサーバーが ctx.hooks で渡す（core/server.mjs の opsDeps）。
// Hooks はエージェントの操作のたびに任意のコマンドを動かすので、書き込み（保存・写す・有効にする・担当・修復・削除）は guarded。
// 例外: 書く前の確認（dryRun）は書かないので write、無効にする向き（togglePlyHook の enabled: false）は関所を狭めるので write（riskOf が上げる）。
// 返りのコマンドはモジュールが形で伏せる（maskText）。agent にはさらに、会話の記録に載るコマンドも伏せる。
// 定義 1 つを読む hooks.read・hooks.readPly（readHook・readPlyHook。ADR 0094）は、画面の編集のシートには元のコマンドを、agent には形で伏せたコマンドを返す。
import { z } from 'zod';
import { t } from '../i18n.mjs';
import { HOOK_AGENTS, maskText } from '../hooks-config.mjs';
import { defineOp } from './registry.mjs';
import { diffRows } from './settings.mjs';
import { byAgent, cwdFor, hasMask, restoreMasked, run, sessionFor } from './redact.mjs';

const D = (id, key) => `agent:ops.hooks.${id}.${key}`;
const A = (key) => `agent:ops.hooks.arg.${key}`;

const AGENT = z.enum(['claude', 'codex', 'antigravity']);
const reason = z.string().max(500).optional().describe(A('reason'));
const cwd = z.string().max(4096).optional().describe(A('cwd'));
const loose = z.record(z.string(), z.unknown());

/** agent への返り: command という名前の文字列を、形で伏せる（画面の行はもう伏せてある。会話の記録の登録などに残った分の網） */
function maskCommands(value) {
  if (Array.isArray(value)) return value.map(maskCommands);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, k === 'command' && typeof v === 'string' ? maskText(v) : maskCommands(v)]));
  return value;
}
const shown = (ctx, value) => (byAgent(ctx) ? maskCommands(value) : value);
/** 定義 1 つの command（元の文字列）: 人にはそのまま、agent には形で伏せる */
const masked = (ctx, value) => (ctx.principal.by === 'human' || typeof value?.command !== 'string' ? value : { ...value, command: maskText(value.command) });

/** 書く前の確認（dryRun）は書かないので write のまま、書くときだけ guarded */
const unlessDryRun = (_ctx, args) => (args.dryRun === true ? 'write' : 'guarded');

/** Pleiad の登録 1 つを承認カードに出す形（コマンドは伏せる） */
const hookView = (h) => (h ? { name: h.name, agent: h.agent, event: h.event, matcher: h.matcher || undefined, command: maskText(String(h.command ?? '')), targets: h.targets, enabled: h.enabled !== false } : null);
const findHook = (view, id) => (view?.hooks ?? []).find((h) => h.id === id) ?? null;

/**
 * agent が読んだ（伏せた）コマンドをそのまま書き戻したら、元のコマンドを残す。元を伏せた形と同じでなければ断る。
 * original は伏せる前のコマンド（無ければ伏せ字は戻せない）
 */
const keepCommand = (ctx, command, original, where) => (typeof command === 'string' && hasMask(command)
  ? restoreMasked(ctx, command, typeof original === 'string' ? maskText(original) : undefined, original, where) : command);

const WRITE_PREVIEW = 'A dry run (dryRun: true) writes nothing and only returns the planned change; writing is raised to guarded by riskOf (hooks run arbitrary commands)';

export const hookOps = [
  // ---- 各エージェントの設定ファイル
  defineOp({
    id: 'hooks.scan', summary: 'agent:ops.hooks.scan.summary', risk: 'read',
    input: z.object({
      cwd,
      scope: z.enum(['user', 'directory']).optional().describe(D('scan', 'scope')),
      trust: z.boolean().optional().describe(D('scan', 'trust')),
    }),
    output: z.object({ files: z.array(loose), entries: z.array(loose) }).passthrough(),
    surfaces: { ui: true, mcp: 'catalog', cli: { path: ['hooks', 'scan'] } },
    legacyCommand: 'scanHooks',
    handler: async (ctx, args) => run(ctx, async () => shown(ctx, await ctx.hooks.scan({ ...args, cwd: await cwdFor(ctx, args.cwd) }))),
  }),
  defineOp({
    id: 'hooks.read',
    summary: 'agent:ops.hooks.read.summary',
    risk: 'read',
    input: z.object({
      agent: z.enum(HOOK_AGENTS).describe(D('read', 'agent')),
      scope: z.string().min(1).max(40).describe(D('read', 'scope')),
      base: z.string().max(4000).nullable().optional().describe(D('read', 'base')),
      file: z.string().max(4000).nullable().optional().describe(D('read', 'file')),
      loc: z.object({
        event: z.string().min(1).max(100),
        group: z.number().int().min(-1),
        handler: z.number().int().min(0),
        name: z.string().max(200).nullable().optional(),
      }).describe(D('read', 'loc')),
    }),
    output: z.object({
      agent: z.string(), scope: z.string(), path: z.string(), revision: z.string(), event: z.string(), name: z.string().nullable(), matcher: z.string().nullable(),
      command: z.string().nullable(), timeout: z.unknown(), async: z.boolean(), keys: z.array(z.string()), editable: z.boolean(), enabled: z.boolean().optional(),
    }),
    surfaces: { ui: true, mcp: 'catalog', cli: { path: ['hooks', 'read'] } },
    legacyCommand: 'readHook',
    handler: async (ctx, args) => masked(ctx, await ctx.hooks.read({ ...args, base: args.base ?? undefined, file: args.file ?? undefined })),
  }),
  defineOp({
    id: 'hooks.saveNative', summary: 'agent:ops.hooks.saveNative.summary', risk: 'write', riskReason: WRITE_PREVIEW,
    riskOf: unlessDryRun,
    input: z.object({
      items: z.array(loose).min(1).max(12).describe(D('saveNative', 'items')),
      dryRun: z.boolean().optional().describe(A('dryRun')),
      allowReformat: z.boolean().optional().describe(A('allowReformat')),
      reason,
    }),
    approvalWords: 'hooks',
    confirm: async (ctx, { items }) => {
      const dry = await ctx.hooks.save({ items, dryRun: true }).catch(() => null);
      const rows = (dry?.results ?? []).slice(0, 8).map((r) => ({ path: `hooks.${r.agent ?? ''}.${r.op ?? ''}`, before: null, after: JSON.stringify(r.path ?? r.error ?? '') }));
      return { key: null, before: (dry?.results ?? []).map((r) => r.revision ?? null), rows, note: t('opsApproval.hooksSaveNative', { count: items.length }), loosens: true };
    },
    surfaces: { ui: true, mcp: 'catalog', cli: { path: ['hooks', 'save-native'] } },
    legacyCommand: 'saveHooks',
    handler: (ctx, { reason: _r, ...args }) => run(ctx, async () => {
      let items = args.items;
      // agent が読んだ（伏せた）コマンドを編集で書き戻したら、元のコマンドを残す
      if (byAgent(ctx)) items = await Promise.all(items.map(async (item, i) => {
        if (item.op !== 'edit' || !hasMask(item.command)) return item;
        const original = await ctx.hooks.read({ agent: item.agent, scope: item.scope, base: item.base, file: item.file, loc: item.loc }).catch(() => null);
        return { ...item, command: keepCommand(ctx, item.command, original?.command, `items[${i}].command`) };
      }));
      return ctx.hooks.save({ ...args, items });
    }),
  }),
  defineOp({
    id: 'hooks.copy', summary: 'agent:ops.hooks.copy.summary', risk: 'write', riskReason: WRITE_PREVIEW,
    riskOf: unlessDryRun,
    input: z.object({
      source: loose.describe(D('copy', 'source')),
      targets: z.array(loose).min(1).max(6).describe(D('copy', 'targets')),
      dryRun: z.boolean().optional().describe(A('dryRun')),
      allowReformat: z.boolean().optional().describe(A('allowReformat')),
      reason,
    }),
    approvalWords: 'hooks',
    confirm: async (ctx, { source, targets }) => {
      const dry = await ctx.hooks.copy({ source, targets, dryRun: true }).catch(() => null);
      const rows = (dry?.results ?? []).slice(0, 6).map((r) => ({ path: `hooks.${r.agent ?? ''}`, before: null, after: JSON.stringify(r.command ?? r.error ?? '') }));
      return { key: null, before: [dry?.source?.revision ?? null, ...(dry?.results ?? []).map((r) => r.revision ?? null)], rows, note: t('opsApproval.hooksCopy', { count: targets.length }), loosens: true };
    },
    surfaces: { ui: true, mcp: 'catalog', cli: { path: ['hooks', 'copy'] } },
    legacyCommand: 'copyHooks',
    handler: (ctx, { reason: _r, ...args }) => run(ctx, async () => shown(ctx, await ctx.hooks.copy(args))),
  }),
  defineOp({
    id: 'hooks.session', summary: 'agent:ops.hooks.session.summary', risk: 'read', scope: 'session',
    input: z.object({
      sessionId: z.string().max(200).optional().describe(A('sessionId')),
      backend: z.string().max(40).optional().describe(D('session', 'backend')),
      cwd,
      trust: z.boolean().optional().describe(D('scan', 'trust')),
    }),
    output: z.object({ agent: z.string().nullable(), runs: z.array(loose) }).passthrough(),
    surfaces: { ui: true, mcp: 'catalog', cli: { path: ['hooks', 'session'] } },
    legacyCommand: 'sessionHooks',
    handler: async (ctx, args) => run(ctx, async () => {
      const sessionId = sessionFor(ctx, args.sessionId);
      return shown(ctx, await ctx.hooks.session({ ...args, sessionId, cwd: await cwdFor(ctx, args.cwd), backend: args.backend ?? (byAgent(ctx) && sessionId ? await ctx.sessionBackend?.(sessionId) : undefined) }));
    }),
  }),

  // ---- Pleiad の登録と担当
  defineOp({
    id: 'hooks.list', summary: 'agent:ops.hooks.list.summary', risk: 'read',
    input: z.object({ cwd }),
    output: z.object({ hooks: z.array(loose) }).passthrough(),
    surfaces: { ui: true, mcp: 'catalog', cli: { path: ['hooks', 'list'] } },
    legacyCommand: 'plyHooks',
    handler: async (ctx, { cwd: dir }) => run(ctx, async () => shown(ctx, await ctx.hooks.view((await cwdFor(ctx, dir)) ?? null))),
  }),
  defineOp({
    id: 'hooks.readPly',
    summary: 'agent:ops.hooks.readPly.summary',
    risk: 'read',
    input: z.object({ id: z.string().min(1).max(200).describe(D('readPly', 'id')) }),
    output: z.object({ id: z.string(), name: z.string(), agent: z.string(), event: z.string(), matcher: z.string(), command: z.string(), targets: z.array(z.string()), enabled: z.boolean() }).passthrough(),
    surfaces: { ui: true, mcp: 'catalog', cli: { path: ['hooks', 'read-ply'], positional: ['id'] } },
    legacyCommand: 'readPlyHook',
    handler: async (ctx, { id }) => masked(ctx, await ctx.hooks.readPly(id)),
  }),
  defineOp({
    id: 'hooks.save', summary: 'agent:ops.hooks.save.summary', risk: 'guarded',
    input: z.object({ value: loose.describe(D('save', 'value')), cwd, reason }),
    approvalWords: 'hooks',
    confirm: async (ctx, { value }) => {
      const view = await ctx.hooks.view(null).catch(() => null);
      const before = value.id ? hookView(findHook(view, value.id)) : null;
      return { key: null, before: view?.revision ?? null, rows: diffRows(`hooks.${value.name ?? value.id ?? ''}`, before, hookView({ ...value, enabled: true })),
        note: value.id ? t('opsApproval.hooksEdit', { name: String(value.name ?? '') }) : t('opsApproval.hooksAdd', { name: String(value.name ?? '') }), loosens: true };
    },
    surfaces: { ui: true, mcp: 'catalog', cli: { path: ['hooks', 'save'] } },
    legacyCommand: 'savePlyHook',
    handler: (ctx, { value, cwd: dir }) => run(ctx, async () => {
      let next = value;
      if (byAgent(ctx) && typeof value.id === 'string' && hasMask(value.command)) {
        const original = await ctx.hooks.readPly(value.id).catch(() => null);
        next = { ...value, command: keepCommand(ctx, value.command, original?.command, 'value.command') };
      }
      return shown(ctx, await ctx.hooks.saveHook(next, (await cwdFor(ctx, dir)) ?? null));
    }),
  }),
  defineOp({
    id: 'hooks.remove', summary: 'agent:ops.hooks.remove.summary', risk: 'guarded',
    input: z.object({ id: z.string().min(1).max(100).describe(A('id')), cwd, reason }),
    approvalWords: 'hookDelete',
    confirm: async (ctx, { id }) => {
      const view = await ctx.hooks.view(null).catch(() => null);
      const h = findHook(view, id);
      return { key: null, before: view?.revision ?? null, rows: diffRows(`hooks.${h?.name ?? id}`, hookView(h), null), note: t('opsApproval.hooksRemove', { name: h?.name ?? id }), loosens: false };
    },
    surfaces: { ui: true, mcp: 'catalog', cli: { path: ['hooks', 'remove'], positional: ['id'] } },
    legacyCommand: 'removePlyHook',
    handler: (ctx, { id, cwd: dir }) => run(ctx, async () => shown(ctx, await ctx.hooks.remove(id, (await cwdFor(ctx, dir)) ?? null))),
  }),
  defineOp({
    id: 'hooks.toggle', summary: 'agent:ops.hooks.toggle.summary', risk: 'write',
    riskReason: 'Turning a registered hook off only narrows what runs; turning it on is raised to guarded by riskOf (it starts running a command)',
    riskOf: (_ctx, { enabled }) => (enabled === false ? 'write' : 'guarded'),
    input: z.object({ id: z.string().min(1).max(100).describe(A('id')), enabled: z.boolean().optional().describe(D('toggle', 'enabled')), cwd, reason }),
    approvalWords: 'hooks',
    confirm: async (ctx, { id, enabled }) => {
      const view = await ctx.hooks.view(null).catch(() => null);
      const h = findHook(view, id);
      return { key: null, before: view?.revision ?? null, rows: [{ path: `hooks.${h?.name ?? id}.enabled`, before: JSON.stringify(h ? h.enabled !== false : null), after: JSON.stringify(enabled !== false) }],
        note: t('opsApproval.hooksEnable', { name: h?.name ?? id, command: h ? maskText(String(h.command ?? '')) : '' }), loosens: enabled !== false };
    },
    surfaces: { ui: true, mcp: 'catalog', cli: { path: ['hooks', 'toggle'], positional: ['id'] } },
    legacyCommand: 'togglePlyHook',
    handler: (ctx, { id, enabled, cwd: dir }) => run(ctx, async () => shown(ctx, await ctx.hooks.toggle(id, enabled !== false, (await cwdFor(ctx, dir)) ?? null))),
  }),
  // 担当を変える前の見込み（取り込む定義・止める定義と、hooks.setOwner に渡す imports の digest と revision。ADR 0105）。何も書かない
  defineOp({
    id: 'hooks.unifyPreview', summary: 'agent:ops.hooks.unifyPreview.summary', risk: 'read',
    input: z.object({ cwd: z.string().max(4096).nullable().optional().describe(A('cwd')), direction: z.enum(['ply', 'native']).optional().describe(D('unifyPreview', 'direction')) }),
    output: z.object({ revision: z.unknown() }).passthrough(),
    surfaces: { ui: true, mcp: 'catalog', cli: { path: ['hooks', 'unify-preview'] } },
    legacyCommand: 'hooksUnifyPreview',
    handler: (ctx, { cwd: dir, direction }) => run(ctx, async () => shown(ctx, await ctx.hooks.unifyPreview({ cwd: dir === null ? null : (await cwdFor(ctx, dir)) ?? null, direction: direction ?? 'ply' }))),
  }),
  defineOp({
    id: 'hooks.setOwner', summary: 'agent:ops.hooks.setOwner.summary', risk: 'guarded',
    input: z.object({
      place: z.string().max(4096).nullable().optional().describe(D('setOwner', 'place')),
      value: z.object({ owner: z.enum(['native', 'ply']), disabled: z.array(z.string().max(100)).max(200).optional() }).passthrough().nullable().optional().describe(D('setOwner', 'value')),
      imports: z.array(z.object({ id: z.string().max(100), digest: z.string().max(200) }).passthrough()).max(100).optional().describe(D('setOwner', 'imports')),
      revision: z.string().max(100).optional().describe(D('setOwner', 'revision')),
      cwd, reason,
    }),
    approvalWords: 'hooks',
    confirm: async (ctx, { place, value, imports }) => {
      const view = await ctx.hooks.view(place ?? null).catch(() => null);
      const before = place ? view?.place?.value ?? null : view?.defaults?.value ?? null;
      return { key: null, before: view?.revision ?? null, rows: diffRows(place ? 'hooks.place' : 'hooks.default', before, value ?? null),
        note: t('opsApproval.hooksOwner', { place: place ?? t('opsApproval.everywhere'), count: imports?.length ?? 0 }), loosens: true };
    },
    surfaces: { ui: true, mcp: 'catalog', cli: { path: ['hooks', 'owner'] } },
    legacyCommand: 'setHooksOwner',
    handler: (ctx, { reason: _r, ...args }) => run(ctx, async () => shown(ctx, await ctx.hooks.setOwner(args))),
  }),
  defineOp({
    id: 'hooks.repair', summary: 'agent:ops.hooks.repair.summary', risk: 'guarded',
    input: z.object({ cwd, reason }),
    approvalWords: 'hooks',
    confirm: async (ctx) => {
      const view = await ctx.hooks.view(null).catch(() => null);
      return { key: null, before: view?.revision ?? view?.error ?? null, rows: [], note: t('opsApproval.hooksRepair'), loosens: true };
    },
    surfaces: { ui: true, mcp: 'catalog', cli: { path: ['hooks', 'repair'] } },
    legacyCommand: 'repairPlyHooks',
    handler: (ctx, { cwd: dir }) => run(ctx, async () => shown(ctx, await ctx.hooks.repair((await cwdFor(ctx, dir)) ?? null))),
  }),
];
