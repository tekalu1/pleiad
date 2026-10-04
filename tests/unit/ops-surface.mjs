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
const ERROR_CODES = ['NOT_FOUND', 'HOST_SCREEN_ONLY', 'INVALID', 'READ_ONLY_MODE', 'NEEDS_UI', 'NEEDS_APPROVAL', 'INVALID_RISK', 'INVALID_PRINCIPAL', 'SESSION_NOT_FOUND', 'MESSAGE_NOT_FOUND', 'CHANNEL_NOT_FOUND', 'POST_NOT_FOUND', 'NOT_YOUR_POST', 'CHANNEL_NAME_TAKEN', 'CHANNEL_ARCHIVED', 'SETTING_NOT_FOUND', 'TASK_NOT_FOUND', 'SETTING_READ_ONLY', 'MASKED', 'DENIED', 'STALE', 'sessionRequired', 'badCursor', 'BOT_NOT_FOUND', 'BOT_NAME_TAKEN', 'BOT_SEND_DISABLED', 'BOT_SEND_TARGET', 'MEMORY_SOURCE', 'MEMORY_REJECTED', 'MEMORY_NOT_FOUND'];
const CONTROL_KEYS = ['instructions', 'listOps', 'listOpsId', 'listOpsPrefix', 'callOp', 'callOpOp', 'callOpArgs'];

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
      surfaces: op.surfaces, legacyCommand: op.legacyCommand ?? null, ...(op.legacyAliases ? { legacyAliases: op.legacyAliases } : {}), input: hash(inputJsonSchema(op)),
    })),
    settings: [...registry.settings].sort((a, b) => a.key.localeCompare(b.key)).map((s) => ({ key: s.key, risk: s.risk, riskOf: Boolean(s.riskOf), writable: !s.readOnly, prefKeys: s.prefKeys })),
    // 全設定 × 全主体の判定（settings.set。向きで危険度が変わる設定は guarded になる向きも）。読むだけの設定は書けない
    settingPolicy: Object.fromEntries([...registry.settings].filter((s) => !s.readOnly).sort((a, b) => a.key.localeCompare(b.key)).map((s) => [s.key,
      Object.fromEntries(Object.entries(principals).map(([who, p]) => [who, (s.riskOf ? [s.risk, 'guarded'] : [s.risk]).map((risk) => {
        const v = decide(p, risk);
        return `${risk}=${v.code ? `${v.decision}:${v.code}` : v.decision}`;
      }).join(' ')]))])),
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
  const readonly = { by: 'agent', via: 'mcp', sessionId: 'own' };
  const compatDeps = { locale: 'ja', modeOf: async () => ({ scope: 'readonly', autonomy: 'ask' }),
    delegation: { call: async () => ({ stopped: true }) }, browser: { call: async () => ({ changed: true }) } };
  t.ok('読み取りモードでも自分の子を止められる', (await registry.invoke(readonly, 'delegation.taskCancel', { taskId: 'ply-task-1' }, compatDeps)).result?.stopped === true);
  t.ok('読み取りモードでも自分のブラウザープロフィールを選べる', (await registry.invoke(readonly, 'browser.useProfile', { profile: 'main' }, compatDeps)).result?.changed === true);
  t.ok('読み取りモードから子に追加指示は送れない', (await registry.invoke(readonly, 'delegation.taskSend', { taskId: 'ply-task-1', message: 'work' }, compatDeps)).code === 'READ_ONLY_MODE');

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
  const EMAIL = 'someone@example.invalid';
  // どの read 操作も、秘密らしい名前の欄に目印が入った生の値を受け取っても、返りに出さない（最後の網。実際のデータ置き場でのものは ops-control.mjs）
  const secret = { token: MARKER, apiKey: MARKER, authorization: MARKER };
  const deps = {
    locale: 'ja',
    app: { status: async () => ({ version: '0', protocolVersion: 0, startedAt: 0, locale: { setting: 'auto', lang: 'ja' }, running: 0, ...secret }),
      running: async () => ({ count: 0, turns: [], tasks: [], waiting: 0, ...secret }),
      runningWork: async () => ({ count: 0, turns: [], permissions: [], tasks: [], subagents: [], background: [], ...secret }),
      cliSetup: () => ({ command: 'node', args: ['pleiad.mjs', 'mcp'], env: {}, json: '{}', claude: 'claude mcp add', ...secret }),
      searchSessions: async () => ({ total: 1, partial: false, sessions: [{ sessionId: 's1', title: 't', hits: [], ...secret }] }) },
    sessions: {
      list: async () => [{ id: 's1', title: 't', backend: 'x', status: null, claudeAccount: MARKER, compatEndpoint: MARKER, ...secret }],
      get: async () => ({ row: { id: 's1', title: 't', backend: 'x', claudeAccount: MARKER, ...secret }, children: [], history: [{ at: 'a', by: 'agent', field: 'title', from: 'x', to: 'y', ...secret }] }),
      read: async () => [{ uuid: 'm', role: 'user', text: 'こんにちは', at: 'a', ...secret }],
      rows: async () => [{ id: 's1', title: 't', backend: 'x', claudeAccount: MARKER, compatEndpoint: MARKER, draft: { text: MARKER }, ...secret }],
      history: async () => [{ at: 'a', by: 'agent', field: 'title', from: 'x', to: 'y', reason: null, ...secret }],
    },
    conversations: { outbox: async () => [{ id: 'm1', status: 'queued', at: 'a', args: { prompt: 'こんにちは', attached: [] }, ...secret }], suggestTitle: async () => ({ title: 't', ...secret }) },
    agents: {
      list: async () => [{ id: 'x', label: 'X', description: 'd', capabilities: { fork: true, login: false }, ...secret }],
      models: async () => ({ backend: 'x', models: { '': { label: 'L', note: 'n', ...secret } } }),
      modes: async () => ({ backend: 'x', modes: { default: { label: 'D', note: 'n', ...secret } } }),
      efforts: async () => ({ backend: 'x', efforts: { '': { label: 'E', ...secret } } }),
      authStatus: async () => ({ backend: 'x', status: { supported: true, installed: true, loggedIn: true, account: EMAIL, detail: 'ChatGPT / plus', path: MARKER, ...secret } }),
    },
    statuses: { list: async () => [{ status: 'a', count: 1, firstUsedAt: 'a', lastUsedAt: 'b', icon: null, kept: false, ...secret }] },
    prefs: async () => ({ agentSitePermissions: [{ origin: 'o', ...secret }], locale: 'ja' }),
    compactionSettings: () => ({ enabled: true, ...secret }),
    delegation: { list: () => [{ taskId: 't', status: 'completed', ...secret }], get: () => ({ taskId: 't', status: 'completed', result: 'done', ...secret }),
      instructions: () => ({ taskId: 't', revision: 1, instructions: [{ id: 'i', text: 'x', at: 1, state: 'queued', ...secret }] }),
      routing: async () => ({ settings: { enabled: true }, warnings: [], keys: { openrouter: { hasKey: true } }, candidates: [{ candidate: 'x:y' }], ...secret }),
      providerUsage: async () => ({ backend: 'x', label: 'X', quota: { ...secret }, local: {}, ...secret }) },
    // MCP・Hooks・コンテキスト・リモート・接続先（ADR 0095）。秘密の値の置き場（env・ヘッダー・bearer・clientSecret・URL のクエリ）に目印を入れる
    mcp: {
      native: { list: async () => ({ path: 'p', format: 'claude', scope: 'user', revision: 'r', servers: ['a'], ...secret }),
        get: async () => ({ name: 'a', revision: 'r', value: { command: 'node', env: { PLAIN_NAME: MARKER }, headers: { X: MARKER }, http_headers: { Y: MARKER }, url: `https://u:${MARKER}@x.example/m?k=${MARKER}`, oauth: { clientSecret: MARKER } } }) },
      list: async () => ({ file: 'f', revision: 'r', servers: [{ name: 'a', transport: 'http', url: `https://x.example/m?k=${MARKER}`, envKeys: ['A'], ...secret }], storage: { encrypted: true } }),
      read: async () => ({ name: 'a', revision: 'r', value: { transport: 'stdio', command: 'node', env: { PLAIN_NAME: MARKER }, bearerToken: MARKER, headers: { X: MARKER }, oauth: { clientSecret: MARKER } } }),
      authStatus: async () => ({ servers: [{ name: 'a', state: 'signed-in', ...secret }], storage: null }),
    },
    hooks: {
      scan: async () => ({ files: [], entries: [{ command: 'x', ...secret }] }),
      session: async () => ({ agent: null, runs: [], unify: { ...secret } }),
      view: async () => ({ hooks: [{ id: 'h', command: 'x', ...secret }] }),
      read: async () => ({ agent: 'claude', scope: 'user', path: 'p', command: 'echo', ...secret }),
      readPly: async () => ({ id: 'h-1', name: 'n', command: 'echo', ...secret }),
      unifyPreview: async () => ({ imports: [{ id: 'i', digest: 'd', command: 'x', ...secret }], revision: 'r' }),
    },
    context: { view: async () => ({ defaults: { ...secret }, places: [] }), plyInstructions: () => ({ items: [{ id: 'x', ...secret }] }),
      // 中身を読む操作（ADR 0105）
      session: async () => ({ report: { entries: [{ kind: 'mcp', name: 'm', command: 'x', ...secret }] }, owners: {}, pinned: false, changed: null, ...secret }),
      diff: async () => ({ files: [{ path: 'p', before: 'a', after: 'b', ...secret }] }),
      scan: async () => ({ cwd: 'c', entries: [{ kind: 'instruction', content: 'x', ...secret }] }),
      skills: async () => [{ name: 's', description: 'd', ...secret }],
      agentMcp: async () => ({ cwd: 'c', agents: { claude: [{ name: 'm', command: 'node', ...secret }], codex: [] } }),
      nativeInstructions: async () => ({ cwd: 'c', agent: 'claude', entries: [{ id: 'i', ...secret }] }),
      findings: async () => ({ duplicates: [], missing: [], ...secret }) },
    notify: { status: async () => ({ pc: { done: true, reply: true, failed: true }, relayConnected: true, devices: [{ id: 'd', platform: 'ios', notify: { muted: true } }], ...secret }) },
    worktrees: { check: async () => ({ git: true, current: null, conflicts: [], canSplit: true, always: false, ...secret }), getSettings: async () => ({ always: false }) },
    git: { status: async () => ({ git: { branch: 'main', ...secret } }),
      panel: async () => ({ git: { branch: 'main' }, timeline: [], changes: { range: 'uncommitted', hasSession: false, files: [{ path: 'a', add: 1, del: 0, ...secret }], total: { files: 1, add: 1, del: 0 } }, worktrees: { current: null, leftovers: [] }, at: 0 }),
      diff: async () => ({ diff: { range: 'uncommitted', path: 'a', hunks: [{ header: '@@', lines: [{ t: '+', s: 'x' }] }], binary: false, truncated: false, ...secret } }) },
    sessionWork: { backgroundTasks: async () => [{ id: 't', kind: 'shell', label: 'l', ...secret }], background: async () => ({ task: { id: 't', status: 'running', output: 'o', ...secret } }),
      subagents: async () => [{ agentId: 'a', origin: 'o', status: null, ...secret }], findSubagent: async () => ({ agentId: null }),
      readSubagent: async () => ({ agentId: 'a', sessionId: 's1', origin: null, prompt: 'p', messages: [{ role: 'user', text: 'x', at: null, ...secret }] }) },
    files: { listDirs: async () => ({ path: 'C:/', parent: null, dirs: ['a'], files: [], truncated: false, roots: [], ...secret }) },
    remote: { status: async () => ({ enabled: false, connection: { ...secret }, devices: [], ...secret }) },
    endpoints: { list: async () => ({ endpoints: [{ id: 'e', baseUrl: 'https://e.example', ...secret }], defaults: {} }) },
    limitResume: { messages: () => [], schedules: () => [], queue: () => ({ pending: [], running: [] }) },
    // bot・Channels・ルーティン（docs/channels.md）。read の操作を足すパッケージが、自分の領域の返り（秘密の目印を入れたもの）をここに足し、
    // 必須の引数がある操作は下の samples にも足す。足したパッケージの区画以外は触らない
    channels: {     // S1
      list: async () => [{ id: 'c_000000000aaaaaa', kind: 'channel', name: 'general', unread: 0, mentions: 0, threadsWorking: 0, ...secret }],
      get: async () => ({ id: 'c_000000000aaaaaa', kind: 'channel', name: 'general', ...secret }),
      mentionsOf: async () => ['everyone'],
      read: async () => ({ posts: [{ id: 'p_000000000aaaaaa', text: 'こんにちは', ...secret }], threads: [{ threadId: 'p_000000000aaaaaa', ...secret }], summaries: {}, nextBefore: null }),
      search: async () => ({ hits: [{ postId: 'p_000000000aaaaaa', snippet: 'こんにちは', ...secret }] }),
    },
    bots: { get: async ({ botId }) => ({ id: botId, name: 'Owl', icon: '🦉', pulse: { on: false, everyMin: 10, backend: '', model: '', channelId: '' } }), overview: async ({ botId } = {}) => [{ id: botId ?? 'b_1', name: 'Owl', icon: '🦉', persona: '', backend: 'fake', model: '', effort: '', mode: 'default',
      folders: [], sendToOthers: true, sendTargets: [], pulse: { on: false, everyMin: 10, backend: '', model: '', channelId: '' }, dmChannelId: 'c_1', dmSessionId: null, createdAt: 0, updatedAt: 0,
      usage: { weekTokens: 0, cacheRatio: null }, state: 'idle', ...secret }] },   // S2
    memory: {       // S3
      list: async () => [{ id: 'm_x', layer: 'user', text: 'PR は小さく', sources: [], at: 1, updatedAt: 1, by: { kind: 'human' }, ...secret }],
      search: async () => [{ id: 'm_x', layer: 'user', text: 'PR は小さく', sources: [], at: 1, updatedAt: 1, by: { kind: 'human' }, ...secret }],
      get: async () => null,
    },
    brain: { list: () => [{ seq: 1, botId: 'b_1', at: 1, kind: 'think', text: '考える', ...secret }], loops: () => [{ id: 'l1', status: 'open', text: 'やりかけ', updatedAt: 1, ...secret }], count: () => 1 },   // 頭の中（ADR 0126）
    pulse: { status: async () => ({ on: false, paused: false, running: false, nextAt: null, lastBeatAt: null, drives: null, home: null, budget: null, ...secret }) },
    memoryLearner: { status: async () => ({ at: '02:00', paused: false, running: false, lastRunAt: null, nextAt: 2, lastResult: null, skip: null, failure: null, ...secret }) },   // S3
    routines: {     // R1（P2）
      list: async () => [{ id: 'r_000000000aaaaaa', name: '朝のまとめ', botId: 'b_1', channelId: 'c_000000000aaaaaa', prompt: 'まとめて', trigger: { kind: 'daily', at: '09:00', weekdaysOnly: false },
        mode: 'default', approvalTimeoutMin: 30, paused: false, createdBy: { kind: 'human' }, createdAt: 1, nextAt: 2, ...secret }],
      get: async () => ({ id: 'r_000000000aaaaaa', name: '朝のまとめ', botId: 'b_1', channelId: 'c_000000000aaaaaa', prompt: 'まとめて', trigger: { kind: 'daily', at: '09:00', weekdaysOnly: false },
        mode: 'default', approvalTimeoutMin: 30, paused: false, createdBy: { kind: 'human' }, createdAt: 1, nextAt: 2, ...secret }),
    },
    botOfSession: async () => null,
  };
  // 人の画面には返すが agent には伏せるもの（引数の秘密・承認の URL・ペアリングの番号・URL のクエリ）は tests/unit/ops-mcp-hooks.mjs
  // 必須の引数がある read 操作に渡す引数（設定は全部の key）
  const samples = {
    'settings.get': registry.settings.map((x) => ({ key: x.key })), 'settings.schema': registry.settings.map((x) => ({ key: x.key })),
    'sessions.search': [{ query: 'こんにちは' }], 'sessions.get': [{ sessionId: 's1' }], 'sessions.read': [{ sessionId: 's1' }], 'delegation.status': [{ taskId: 't' }],
    'sessions.listMessages': [{ sessionId: 's1' }], 'sessions.changes': [{ sessionId: 's1' }], 'sessions.lineage': [{ sessionId: 's1' }], 'sessions.suggestTitle': [{ sessionId: 's1' }],
    'delegation.instructions': [{ taskId: 't' }],
    'mcp.nativeList': [{ format: 'claude', scope: 'user', cwd: 'x' }], 'mcp.nativeRead': [{ format: 'codex', scope: 'directory', cwd: 'x', name: 'a' }], 'mcp.read': [{ name: 'a' }],
    'hooks.read': [{ agent: 'claude', scope: 'user', loc: { event: 'PreToolUse', group: 0, handler: 0 } }], 'hooks.readPly': [{ id: 'h-1' }],
    'git.diff': [{ path: 'a' }], 'sessions.readSubagent': [{ sessionId: 's1', agentId: 'a' }], 'sessions.background': [{ sessionId: 's1', taskId: 't' }],
    'sessions.subagents': [{ sessionId: 's1', toolId: 'x' }],
    'channels.get': [{ channelId: 'c_000000000aaaaaa' }], 'channels.read': [{ channelId: 'c_000000000aaaaaa' }], 'channels.search': [{ query: 'こんにちは' }],
    'channels.wakePreview': [{ channelId: 'c_000000000aaaaaa', text: '@everyone' }],
    'memory.list': [{ layer: 'user' }], 'memory.search': [{ query: 'PR' }],
    'bots.get': [{ botId: 'b_1' }], 'brain.view': [{ botId: 'b_1' }],
    'routines.get': [{ routineId: 'r_000000000aaaaaa' }],
  };
  for (const op of registry.ops.filter((o) => o.risk === 'read' && o.surfaces.ui)) {
    const needs = Object.keys(op.input.shape).length && Object.values(op.input.shape).some((f) => !f.safeParse(undefined).success);
    if (needs && !samples[op.id]) { t.ok(`T6 ${op.id}: 必須の引数の例がある`, false); continue; }
    for (const args of samples[op.id] ?? [{}]) {
      const r = await registry.invoke({ by: 'human', via: 'ui', local: true }, op.id, args, deps);
      // 画面向きの形（uiHandler）は、画面が今まで読んでいた行（アカウント・接続先の id・下書きの有無・実行ファイルの場所）をそのまま持つ。
      // 秘密の名前の欄は伏せ字になる。AI・CLI の形に出ないことは下の検査が見る
      const raw = ['sessions.list', 'sessions.lineage', 'agents.authStatus'].includes(op.id);
      t.ok(`T6 ${op.id}${args.key ? `（${args.key}）` : ''}: 返りに秘密の目印が出ない${raw ? '（画面向きの形は id・場所を含む。秘密の名前の欄だけ伏せる）' : ''}`,
        r.ok && (raw ? !JSON.stringify(r.result).replace(new RegExp(`"(claudeAccount|compatEndpoint|path)":"${MARKER}"`, 'g'), '').replace(`"text":"${MARKER}"`, '').includes(MARKER) : !JSON.stringify(r.result).includes(MARKER)), r.ok ? '' : r.error);
    }
  }
  // 画面（人）に全量の形を返す操作（uiHandler）は、AI・CLI の形（上限のある形）でも秘密の目印・メールアドレスを返さない
  const agent = { by: 'agent', via: 'mcp', sessionId: 's1' };
  for (const op of registry.ops.filter((o) => o.risk === 'read' && o.uiHandler && o.surfaces.mcp !== false && o.id !== 'delegation.usage')) {
    for (const args of samples[op.id] ?? [{}]) {
      const r = await registry.invoke(agent, op.id, args, deps);
      const text = JSON.stringify(r.result);
      t.ok(`T6 ${op.id}: AI・CLI の形にも秘密の目印・メールアドレスが出ない`, r.ok && !text.includes(MARKER) && !text.includes(EMAIL), r.ok ? '' : r.error);
    }
  }
  const auth = await registry.invoke(agent, 'agents.authStatus', {}, deps);
  t.ok('agents.authStatus: AI にはログインの状態だけ（メールアドレス・詳細・パスは返さない）', JSON.stringify(auth.result) === JSON.stringify({ backend: 'x', supported: true, installed: true, loggedIn: true }), JSON.stringify(auth.result));
  const humanAuth = await registry.invoke({ by: 'human', via: 'ui', local: true }, 'agents.authStatus', {}, deps);
  t.ok('agents.authStatus: 画面には従来の形（アカウント名・詳細を含む）', humanAuth.result?.account === EMAIL && humanAuth.result?.loggedIn === true);
}
