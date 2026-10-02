// 実際の操作の一覧（core/ops/index.mjs）の検査。docs/design.md「操作の一覧」の T3〜T8。
//   T3 口ごとの一覧の snapshot（tests/ops-surface.snap.json。更新は OPS_UPDATE_SNAPSHOT=1 npm test -- ops-surface）
//   T4 MCP に出す文の量の上限
//   T5 主体ごとの見え方（human-only はどの口にも出ない）
//   T6 伏せ字（全 read 操作の返りに秘密の目印が出ない）
//   T7 辞書キー（説明・引数・失敗の文が全言語にある）
//   T8 入力が JSON Schema になる（additionalProperties: false）
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { registry } from '../../core/ops/index.mjs';
import { inputJsonSchema } from '../../core/ops/registry.mjs';
import { decide, RISKS } from '../../core/ops/policy.mjs';
import { LOCALES, readResources, agentT } from '../../core/i18n.mjs';
import { estimateTokens } from '../../web/token-estimate.mjs';
import { mcpTools } from '../../core/ops/surfaces/mcp.mjs';
import { controlInstructions, controlTexts } from '../../core/ops/surfaces/control.mjs';

export const name = 'ops-surface';
export const title = '操作の一覧の中身: snapshot・文の量・主体ごとの見え方・伏せ字・辞書・JSON Schema';

const SNAPSHOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'ops-surface.snap.json');

// T4: ply_control が毎ターン文脈に載せる文（指示 + tools/list。直に出すツール・list_ops・call_op の定義）の上限。ja・en それぞれ。上限を変えるのは ADR の範囲（docs/design.md「操作の一覧」）
const CONTROL_TOKEN_LIMIT = 1800;
const ERROR_CODES = ['NOT_FOUND', 'HOST_SCREEN_ONLY', 'INVALID', 'READ_ONLY_MODE', 'NEEDS_UI', 'NEEDS_APPROVAL', 'INVALID_RISK', 'INVALID_PRINCIPAL', 'SESSION_NOT_FOUND', 'MESSAGE_NOT_FOUND', 'SETTING_NOT_FOUND', 'TASK_NOT_FOUND', 'sessionRequired', 'badCursor'];
const CONTROL_KEYS = ['instructions', 'listOps', 'listOpsId', 'callOp', 'callOpOp', 'callOpArgs'];

const hash = (value) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 12);

export function snapshotOf() {
  const principals = {
    human: { by: 'human' },
    'agent-unbound': { by: 'agent' },
    'agent-bound-ask': { by: 'agent', sessionId: 's', mode: { scope: 'workspace', autonomy: 'ask' } },
    'agent-bound-never-full': { by: 'agent', sessionId: 's', mode: { scope: 'full', autonomy: 'never' } },
    'agent-bound-readonly': { by: 'agent', sessionId: 's', mode: { scope: 'readonly', autonomy: 'ask' } },
  };
  return {
    ops: [...registry.ops].sort((a, b) => a.id.localeCompare(b.id)).map((op) => ({
      id: op.id, risk: op.risk, riskOf: Boolean(op.riskOf), scope: op.scope, modeGate: op.modeGate, hostScreenOnly: op.hostScreenOnly,
      surfaces: op.surfaces, legacyCommand: op.legacyCommand ?? null, input: hash(inputJsonSchema(op)),
    })),
    settings: [...registry.settings].sort((a, b) => a.key.localeCompare(b.key)).map((s) => ({ key: s.key, risk: s.risk, riskOf: Boolean(s.riskOf), prefKeys: s.prefKeys })),
    // MCP の tools/list（ply_control・pleiad mcp 共通の生成器。名前と入力のハッシュ。説明の文は辞書なので載せない）と、CLI のコマンドの形
    mcp: mcpTools({ catalog: registry.describe({ by: 'agent', via: 'mcp' }, 'en'), texts: controlTexts('en') }).map((tool) => ({ name: tool.name, input: hash(tool.inputSchema) })),
    cli: registry.describe({ by: 'agent', via: 'cli' }, 'en').filter((e) => e.cli).map((e) => ({ id: e.id, path: e.cli.path.join(' '), positional: [].concat(e.cli.positional ?? []) })).sort((a, b) => a.path.localeCompare(b.path)),
    policy: Object.fromEntries(Object.entries(principals).map(([who, p]) => [who, Object.fromEntries(RISKS.map((risk) => {
      const v = decide(p, risk);
      return [risk, v.code ? `${v.decision}:${v.code}` : v.decision];
    }))])),
  };
}

export default async function (t) {
  const dicts = readResources();

  // ---- T3 snapshot
  const snap = JSON.stringify(snapshotOf(), null, 2) + '\n';
  if (process.env.OPS_UPDATE_SNAPSHOT) {
    fs.writeFileSync(SNAPSHOT, snap);
    t.note('tests/ops-surface.snap.json を更新した');
  }
  const saved = fs.existsSync(SNAPSHOT) ? fs.readFileSync(SNAPSHOT, 'utf8').replace(/\r\n/g, '\n') : null;
  t.ok('T3 口ごとの一覧が snapshot と一致する（危険度・出す口・入力・権限の表の変更は差分に出る）', saved === snap,
    saved === null ? 'snapshot が無い（OPS_UPDATE_SNAPSHOT=1 で作る）' : 'tests/ops-surface.snap.json と違う。意図した変更なら OPS_UPDATE_SNAPSHOT=1 npm test -- ops-surface で更新して差分をレビューする');

  // ---- T8 JSON Schema
  for (const op of registry.ops) {
    let schema = null, err = '';
    try { schema = inputJsonSchema(op); } catch (e) { err = e.message; }
    t.ok(`T8 ${op.id}: input が JSON Schema になり additionalProperties: false`, schema?.type === 'object' && schema.additionalProperties === false, err);
  }

  // ---- T7 辞書キー
  for (const lng of LOCALES) {
    const agent = dicts[lng].agent;
    const has = (key) => key.split('.').reduce((node, part) => node?.[part], agent) !== undefined;
    for (const op of registry.ops) {
      const keys = [op.summary, ...Object.values(inputJsonSchema(op).properties ?? {}).map((p) => p.description)];
      const missing = keys.filter((k) => typeof k !== 'string' || !k.startsWith('agent:') || !has(k.slice('agent:'.length)));
      t.ok(`T7 ${op.id}: 説明と引数の説明が ${lng} の agent 辞書にある`, missing.length === 0, missing.join(', '));
      const undescribed = Object.entries(inputJsonSchema(op).properties ?? {}).filter(([, p]) => !p.description).map(([k]) => k);
      t.ok(`T7 ${op.id}: 全ての引数に説明がある（${lng}）`, undescribed.length === 0, undescribed.join(', '));
    }
    for (const s of registry.settings) t.ok(`T7 設定 ${s.key}: 説明が ${lng} にある`, has(s.summary.slice('agent:'.length)));
    t.ok(`T7 ply_control の文（ops.control.*）が ${lng} にある`, CONTROL_KEYS.every((k) => has(`ops.control.${k}`)), CONTROL_KEYS.filter((k) => !has(`ops.control.${k}`)).join(', '));
    t.ok(`T7 失敗の文（ops.errors.*）が ${lng} にある`, ERROR_CODES.every((c) => has(`ops.errors.${c}`)), ERROR_CODES.filter((c) => !has(`ops.errors.${c}`)).join(', '));
  }

  // ---- T5 主体ごとの見え方
  const agents = [{ by: 'agent', via: 'mcp', sessionId: 's', mode: { scope: 'full', autonomy: 'never' } }, { by: 'agent', via: 'mcp-stdio' }, { by: 'agent', via: 'cli' }];
  for (const op of registry.ops) {
    for (const p of agents) {
      const shown = registry.list(p).some((o) => o.id === op.id);
      const wantSurface = p.via === 'cli' ? Boolean(op.surfaces.cli) : op.surfaces.mcp !== false;
      const want = wantSurface && op.risk !== 'human-only';
      t.ok(`T5 ${op.id}（${op.risk}）は agent（${p.via}）の一覧に${want ? '出る' : '出ない'}`, shown === want);
    }
    if (op.risk === 'human-only') t.ok(`T5 ${op.id}: human-only は MCP・CLI に出す設定が無い`, op.surfaces.mcp === false && op.surfaces.cli === false);
  }

  // ---- T4 文の量: 実際に会話へ渡す指示と tools/list（pleiad mcp と同じ生成器）を数える
  for (const lng of LOCALES) {
    const tools = mcpTools({ catalog: registry.describe({ by: 'agent', via: 'mcp' }, lng), texts: controlTexts(lng) });
    const tokens = estimateTokens(JSON.stringify(tools) + controlInstructions(lng));
    t.ok(`T4 ply_control の指示と tools/list が ${CONTROL_TOKEN_LIMIT} トークン以内（${lng}）`, tokens <= CONTROL_TOKEN_LIMIT, `${tokens} トークン・${tools.length} 本`);
    t.note(`T4 ply_control の文の量（${lng}）: ${tokens} / ${CONTROL_TOKEN_LIMIT} トークン・${tools.length} 本`);
  }

  // ---- T6 伏せ字: 秘密の目印を入れた依存で、全 read 操作を既定の引数で呼ぶ。返りに目印が出ない
  // 段階 1 以降は、秘密の場所（mcp-secrets・アカウントのトークン・判定器の鍵・ヘッダー値）に目印を入れた一時のデータ置き場へ広げる
  const MARKER = 'SECRET-MARKER-7f3a';
  // どの read 操作も、秘密らしい名前の欄に目印が入った生の値を受け取っても、返りに出さない（最後の網。実際のデータ置き場でのものは ops-control.mjs）
  const secret = { token: MARKER, apiKey: MARKER, authorization: MARKER };
  const deps = {
    locale: 'ja',
    app: { status: async () => ({ version: '0', protocolVersion: 0, startedAt: 0, locale: { setting: 'auto', lang: 'ja' }, running: 0, ...secret }),
      running: async () => ({ count: 0, turns: [], tasks: [], waiting: 0, ...secret }) },
    sessions: {
      list: async () => [{ id: 's1', title: 't', backend: 'x', status: null, claudeAccount: MARKER, compatEndpoint: MARKER, ...secret }],
      get: async () => ({ row: { id: 's1', title: 't', backend: 'x', claudeAccount: MARKER, ...secret }, children: [], history: [{ at: 'a', by: 'agent', field: 'title', from: 'x', to: 'y', ...secret }] }),
      read: async () => [{ uuid: 'm', role: 'user', text: 'こんにちは', at: 'a', ...secret }],
    },
    prefs: async () => ({ agentSitePermissions: [{ origin: 'o', ...secret }], locale: 'ja' }),
    compactionSettings: () => ({ enabled: true, ...secret }),
    delegation: { list: () => [{ taskId: 't', status: 'completed', ...secret }], get: () => ({ taskId: 't', status: 'completed', result: 'done', ...secret }) },
  };
  // 必須の引数がある read 操作に渡す引数（設定は全部の key）
  const samples = {
    'settings.get': registry.settings.map((x) => ({ key: x.key })), 'settings.schema': registry.settings.map((x) => ({ key: x.key })),
    'sessions.get': [{ sessionId: 's1' }], 'sessions.read': [{ sessionId: 's1' }], 'delegation.status': [{ taskId: 't' }],
  };
  for (const op of registry.ops.filter((o) => o.risk === 'read' && o.surfaces.ui)) {
    const needs = Object.keys(op.input.shape).length && Object.values(op.input.shape).some((f) => !f.safeParse(undefined).success);
    if (needs && !samples[op.id]) { t.ok(`T6 ${op.id}: 必須の引数の例がある`, false); continue; }
    for (const args of samples[op.id] ?? [{}]) {
      const r = await registry.invoke({ by: 'human', via: 'ui', local: true }, op.id, args, deps);
      t.ok(`T6 ${op.id}${args.key ? `（${args.key}）` : ''}: 返りに秘密の目印が出ない`, r.ok && !JSON.stringify(r.result).includes(MARKER), r.ok ? '' : r.error);
    }
  }
}
