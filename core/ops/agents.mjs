// agents.*: 選べるもの（エージェント・モデル・承認モードの一覧・思考の強さ・ログインの状態）を読む操作。
// 画面の WS コマンド（backends・models・modes・efforts・authStatus）の中身。どれも読むだけで、変える側は sessions.setTurnSettings・settings.set。
// 返り値は AI が読める形（配列。一覧は limit / cursor。ログインはメールアドレスなどを返さない）。画面（人）には uiHandler で、画面が読む従来の形を返す。
// 本体はサーバーが ctx.agents で渡す（core/server.mjs の opsAgents）。
import { z } from 'zod';
import { defineOp } from './registry.mjs';
import { clip, fromHost, pageOf, PAGE_MAX } from './host.mjs';

const D = (id, key) => `agent:ops.agents.${id}.${key}`;
const backend = (id) => z.string().max(40).optional().describe(D(id, 'backend'));
const cwd = (id) => z.string().max(8192).optional().describe(D(id, 'cwd'));

/** 語彙の 1 行（id と、人が読む名前・注）。モデル・承認モード・思考の強さに共通 */
const choice = z.object({ id: z.string(), label: z.string(), note: z.string().optional(), resolvesTo: z.string().optional() });
const choiceOf = ([id, v]) => ({ id, label: String(v?.label ?? id), ...(v?.note ? { note: clip(v.note, 200) } : {}), ...(v?.resolvesTo ? { resolvesTo: String(v.resolvesTo) } : {}) });

export const agentOps = [
  defineOp({
    id: 'agents.list',
    summary: 'agent:ops.agents.list.summary',
    risk: 'read',
    input: z.object({}),
    output: z.object({ agents: z.array(z.object({ id: z.string(), label: z.string(), description: z.string(), features: z.array(z.string()) })) }),
    surfaces: { ui: true, mcp: 'catalog', cli: { path: ['agents', 'list'] } },
    legacyCommand: 'backends',
    handler: async (ctx) => ({ agents: (await fromHost(() => ctx.agents.list())).map((a) => ({ id: a.id, label: a.label, description: clip(a.description, 200),
      features: Object.entries(a.capabilities ?? {}).filter(([, on]) => on === true).map(([name]) => name) })) }),
    uiHandler: (ctx) => fromHost(() => ctx.agents.list()),
  }),

  defineOp({
    id: 'agents.models',
    summary: 'agent:ops.agents.models.summary',
    risk: 'read',
    input: z.object({
      backend: backend('models'), cwd: cwd('models'),
      limit: z.number().int().min(1).max(PAGE_MAX).optional().describe(D('models', 'limit')),
      cursor: z.string().max(400).optional().describe(D('models', 'cursor')),
    }),
    output: z.object({ backend: z.string(), total: z.number().int(), models: z.array(choice), next: z.string().nullable() }),
    surfaces: { ui: true, mcp: 'catalog', cli: { path: ['agents', 'models'] } },
    legacyCommand: 'models',
    handler: async (ctx, { backend: id, cwd: dir, ...page }) => {
      const got = await fromHost(() => ctx.agents.models(id, dir));
      const { total, items, next } = pageOf(ctx, Object.entries(got.models).map(choiceOf), page);
      return { backend: got.backend, total, models: items, next };
    },
    uiHandler: async (ctx, { backend: id, cwd: dir }) => (await fromHost(() => ctx.agents.models(id, dir))).models,
  }),

  defineOp({
    id: 'agents.modes',
    summary: 'agent:ops.agents.modes.summary',
    risk: 'read',
    input: z.object({ backend: backend('modes') }),
    output: z.object({ backend: z.string(), modes: z.array(choice) }),
    surfaces: { ui: true, mcp: 'catalog', cli: { path: ['agents', 'modes'] } },
    legacyCommand: 'modes',
    handler: async (ctx, { backend: id }) => {
      const got = await fromHost(() => ctx.agents.modes(id));
      return { backend: got.backend, modes: Object.entries(got.modes).map(choiceOf) };
    },
    uiHandler: async (ctx, { backend: id }) => (await fromHost(() => ctx.agents.modes(id))).modes,
  }),

  defineOp({
    id: 'agents.efforts',
    summary: 'agent:ops.agents.efforts.summary',
    risk: 'read',
    input: z.object({ backend: backend('efforts'), model: z.string().max(200).optional().describe(D('efforts', 'model')), cwd: cwd('efforts'),
      endpoint: z.string().max(200).optional().describe(D('efforts', 'endpoint')) }),
    output: z.object({ backend: z.string(), efforts: z.array(choice) }),
    surfaces: { ui: true, mcp: 'catalog', cli: { path: ['agents', 'efforts'] } },
    legacyCommand: 'efforts',
    handler: async (ctx, args) => {
      const got = await fromHost(() => ctx.agents.efforts(args));
      return { backend: got.backend, efforts: Object.entries(got.efforts).map(choiceOf) };
    },
    uiHandler: async (ctx, args) => (await fromHost(() => ctx.agents.efforts(args))).efforts,
  }),

  // ログインしているかだけ。メールアドレス・トークン・資格情報は返さない（ログイン・ログアウトは画面だけ）
  defineOp({
    id: 'agents.authStatus',
    summary: 'agent:ops.agents.authStatus.summary',
    risk: 'read',
    input: z.object({ backend: backend('authStatus') }),
    output: z.object({ backend: z.string(), supported: z.boolean(), installed: z.boolean().optional(), loggedIn: z.boolean().optional(), pending: z.boolean().optional() }),
    surfaces: { ui: true, mcp: 'catalog', cli: { path: ['agents', 'auth'] } },
    legacyCommand: 'authStatus',
    handler: async (ctx, { backend: id }) => {
      const got = await fromHost(() => ctx.agents.authStatus(id));
      const s = got.status;
      return { backend: got.backend, supported: s.supported === true, ...(typeof s.installed === 'boolean' ? { installed: s.installed } : {}),
        ...(typeof s.loggedIn === 'boolean' ? { loggedIn: s.loggedIn } : {}), ...(s.pending === true ? { pending: true } : {}) };
    },
    uiHandler: async (ctx, { backend: id }) => (await fromHost(() => ctx.agents.authStatus(id))).status,
  }),
];
