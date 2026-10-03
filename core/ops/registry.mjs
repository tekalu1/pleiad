// 操作の一覧（レジストリ）。画面・MCP・CLI が外へ出す操作の正本（ADR 0080）。
//
// 操作は defineOp、設定は defineSetting で定義し、createRegistry で集める。口はすべて registry.invoke を通り、
// 入力の検査・権限（policy.mjs）・記録・伏せ字をここで 1 回だけ行う。handler は人間の操作と同じ store・同じイベントを使う。
//
// 説明は辞書キー（agent: 名前空間）で持つ。操作は `agent:ops.<id>.summary`、設定は `agent:settings.<key>`、
// 引数の説明は zod の .describe('agent:ops.<id>.<引数>')。口が言語で引く（会話の言語・CLI は PC の言語）。
//
// i18n-dynamic: agent:ops.
// i18n-dynamic: agent:settings.
import crypto from 'node:crypto';
import { z } from 'zod';
import { agentT } from '../i18n.mjs';
import { RISKS, decide, maxRisk } from './policy.mjs';

const ID_RX = /^[a-z][a-zA-Z0-9]*\.[a-z][a-zA-Z0-9]*$/;
const KEY_RX = /^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)*$/;

export const MCP_SURFACES = ['direct', 'catalog'];
export const MASK = '••••';

/** code を持つ失敗。handler が投げると、invoke が { ok: false, code } にして返す（それ以外の例外はそのまま投げる）。 */
export class OpError extends Error {
  constructor(code, message, extra = {}) {
    super(message ?? code);
    this.name = 'OpError';
    this.code = code;
    Object.assign(this, extra);
  }
}

const isZodObject = (schema) => schema?._zod?.def?.type === 'object' && typeof schema.strict === 'function';
const fail = (what, why) => { throw new Error(`ops: ${what}: ${why}`); };

/**
 * 操作を定義する。欄の意味は docs/design.md「操作の一覧」。
 * 必須: id・summary・risk・input・surfaces・handler。read は output も。write は riskReason（なぜ guarded でないか）も。
 */
export function defineOp(def) {
  const id = def?.id;
  if (typeof id !== 'string' || !ID_RX.test(id)) fail(String(id), 'id must be <area>.<verb> (lowercase letters and digits)');
  if (def.summary !== `agent:ops.${id}.summary`) fail(id, `summary must be agent:ops.${id}.summary`);
  if (!RISKS.includes(def.risk)) fail(id, `risk must be one of ${RISKS.join(' / ')}`);
  if (!isZodObject(def.input)) fail(id, 'input must be z.object(…) (z.object({}) for no arguments)');
  if (def.risk === 'read' && !def.output) fail(id, 'a read op needs an output schema');
  if (def.output && typeof def.output.parse !== 'function') fail(id, 'output must be a zod schema');
  if (def.risk === 'write' && !(typeof def.riskReason === 'string' && def.riskReason.trim()))
    fail(id, 'a write op needs riskReason (why it is not guarded); the default for writes is guarded');
  if (def.riskOf !== undefined && typeof def.riskOf !== 'function') fail(id, 'riskOf must be a function (ctx, args) => risk');
  if ((def.risk === 'guarded' || def.riskOf) && typeof def.confirm !== 'function')
    fail(id, 'an op that can be guarded needs confirm(ctx, args) (the approval card line and the receipt)');
  if (def.scope !== undefined && !['session', 'global'].includes(def.scope)) fail(id, 'scope must be session | global');
  if (typeof def.handler !== 'function') fail(id, 'handler is required');
  if (def.legacyAliases !== undefined && !(Array.isArray(def.legacyAliases) && def.legacyAliases.every((n) => typeof n === 'string' && n)))
    fail(id, 'legacyAliases must be an array of WS command names');
  if (def.uiHandler !== undefined && typeof def.uiHandler !== 'function') fail(id, 'uiHandler must be a function (ctx, args) => result');
  if (def.uiHandler && def.surfaces?.ui !== true) fail(id, 'uiHandler needs surfaces.ui: true');

  const s = def.surfaces;
  if (!s || typeof s.ui !== 'boolean') fail(id, 'surfaces.ui (true | false) is required');
  if (s.mcp !== false && !MCP_SURFACES.includes(s.mcp)) fail(id, `surfaces.mcp must be false | ${MCP_SURFACES.join(' | ')}`);
  if (!(s.cli === false || s.cli === true || (s.cli && Array.isArray(s.cli.path)))) fail(id, 'surfaces.cli must be true | false | { path, positional? }');
  if (def.risk === 'human-only' && (s.mcp !== false || s.cli !== false)) fail(id, 'a human-only op must not be on MCP or CLI (surfaces.mcp and surfaces.cli are false)');

  return Object.freeze({
    ...def,
    kind: 'op',
    scope: def.scope ?? 'global',
    modeGate: def.modeGate !== false,
    hostScreenOnly: def.hostScreenOnly === true,
    input: def.input.strict(),
  });
}

/**
 * 設定を定義する。settings.list / get / schema / set の 4 操作はこの一覧から作る。
 *   必須: key・summary・risk・schema（読んだ値の形）・default・read(ctx)。write が無ければ読むだけ（readOnly）
 *   書く設定（write あり）:
 *     normalize(ctx, input, { before, backend })  渡された値の検査と、書いたあとの値。{ after, arg? } を返す（INVALID は OpError で投げる）。無ければ schema で検査して after = 入力
 *     write(ctx, arg, { before, backend })         arg（無ければ after）を保存し、人間の操作と同じ配信を出す
 *     writeSchema                                   settings.set の value の形（読んだ値と違うときだけ。既定は schema）
 *   riskOf(before, after) は、関所を緩める向きだけ 'guarded' を返す（定義の risk を下げられない）。riskOf を持つ設定は riskExamples
 *   （[{ before, after, risk }]。tests/unit/ops-settings.mjs が riskOf と突き合わせる）を書く。
 */
export function defineSetting(def) {
  const key = def?.key;
  if (typeof key !== 'string' || !KEY_RX.test(key)) fail(String(key), 'key must be dot-separated, starting with a lowercase letter');
  if (def.summary !== `agent:settings.${key}`) fail(key, `summary must be agent:settings.${key}`);
  if (!RISKS.includes(def.risk)) fail(key, `risk must be one of ${RISKS.join(' / ')}`);
  if (typeof def.schema?.parse !== 'function') fail(key, 'schema must be a zod schema');
  if (!('default' in def)) fail(key, 'default is required');
  if (typeof def.read !== 'function') fail(key, 'read is required');
  if (def.write !== undefined && typeof def.write !== 'function') fail(key, 'write must be a function (ctx, arg, { before, backend }) => void');
  if (def.normalize !== undefined && typeof def.normalize !== 'function') fail(key, 'normalize must be a function (ctx, input, { before, backend }) => { after, arg? }');
  if (def.writeSchema !== undefined && typeof def.writeSchema?.parse !== 'function') fail(key, 'writeSchema must be a zod schema');
  if (def.risk === 'write' && !(typeof def.riskReason === 'string' && def.riskReason.trim())) fail(key, 'a write setting needs riskReason');
  if (def.riskOf !== undefined && typeof def.riskOf !== 'function') fail(key, 'riskOf must be a function (before, after) => risk');
  if (def.riskOf && !(Array.isArray(def.riskExamples) && def.riskExamples.length && def.riskExamples.every((e) => RISKS.includes(e?.risk) && 'before' in e && 'after' in e)))
    fail(key, 'a setting with riskOf needs riskExamples: [{ before, after, risk }]');
  // prefs.json に書くキー（既定は key 自身）。tests/lint-ops.mjs が「prefs に書くキーは設定の一覧にある」の照合に使う
  const prefKeys = def.prefKeys ?? [key];
  if (!Array.isArray(prefKeys) || !prefKeys.every((k) => typeof k === 'string' && k)) fail(key, 'prefKeys must be an array of strings');
  return Object.freeze({ ...def, kind: 'setting', prefKeys, readOnly: def.write === undefined });
}

/** 口 → surfaces の欄。human は画面、agent は via で決まる（cli は CLI、mcp と mcp-stdio は MCP）。 */
export function surfaceOf(principal) {
  if (principal?.by === 'human') return 'ui';
  return principal?.via === 'cli' ? 'cli' : 'mcp';
}

/** MCP に直に出すツールの名前。決めてある操作は動詞が先（search_sessions）。無ければ id の . を _ にする（sessions.foo → sessions_foo） */
export const DIRECT_TOOL_NAMES = {
  'sessions.search': 'search_sessions',
  'sessions.get': 'get_session',
  'sessions.read': 'read_session',
  'settings.get': 'get_setting',
  'settings.set': 'set_setting',
};
const directToolName = (op) => DIRECT_TOOL_NAMES[op.id] ?? op.id.replace('.', '_');

const onSurface = (op, surface) => (surface === 'ui' ? op.surfaces.ui : surface === 'cli' ? Boolean(op.surfaces.cli) : op.surfaces.mcp !== false);

/** JSON Schema の description（辞書キー）を言語で引く。引けなければキーのまま残す（T7 が落とす）。 */
function localize(node, locale) {
  if (Array.isArray(node)) return node.map((n) => localize(n, locale));
  if (!node || typeof node !== 'object') return node;
  const out = {};
  for (const [k, v] of Object.entries(node)) {
    out[k] = k === 'description' && typeof v === 'string' && v.startsWith('agent:') ? agentT(locale, v.slice('agent:'.length)) : localize(v, locale);
  }
  return out;
}

/** zod → JSON Schema。変換できない入力（Date・関数など）は投げる（T8）。 */
export function inputJsonSchema(op, locale) {
  const schema = z.toJSONSchema(op.input, { unrepresentable: 'throw', io: 'input' });
  return locale === undefined ? schema : localize(schema, locale);
}

const SECRET_KEY = /(secret|token|password|passwd|api[_-]?key|authorization|credential|cookie)s?$/i;

/** 返す前の伏せ字。秘密らしい名前の欄の文字列を伏せる（hasToken のような真偽・個数は残る）。出力の型で秘密を持たせないのが本筋で、これは最後の網。 */
export function maskOutput(value, key = '') {
  if (Array.isArray(value)) return value.map((v) => maskOutput(v));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, maskOutput(v, k)]));
  if (typeof value === 'string' && value !== '' && SECRET_KEY.test(key)) return MASK;
  return value;
}

/** キーを並べ替えた JSON（受領証の元。同じ内容なら同じ文字列になる） */
export function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}

/** 承認の受領証。承認した変更（操作・引数・承認時の前の値）の印。書く直前に今の値で作り直して合わなければ、別の変更として聞き直す（ADR 0049 の確認票と同じ考え） */
export const receiptOf = (opId, args, before) => crypto.createHash('sha256').update(stableStringify([opId, args, before ?? null])).digest('hex').slice(0, 32);

// 許可のあとに値が変わって聞き直す上限（これを超えて変わり続けたら STALE）
const RECEIPT_RETRIES = 2;

/**
 * 承認が要る呼び出し（policy の ask）。承認を待たずに返す（ADR 0088）。
 * confirm(ctx, args) が承認カードに出す変更（{ key, rows, loosens } か説明の文字列）を返し、
 * deps.approve({ op, change, receipt, reason, actor, requestId?, proceed }) が会話にカードを出して { pending: true, requestId } か
 * { allow: false, code } をすぐ返す。人が許可したら、サーバーが proceed() を呼ぶ: 前の値を読み直して受領証を作り直し、
 * 合えば run()（記録と実行）の返り、合わなければ同じ requestId で聞き直して承認待ちの返り（変わり続けたら STALE）。
 */
async function approval(ctx, op, args, failure, run) {
  if (typeof ctx.approve !== 'function') return failure('NEEDS_APPROVAL', { id: op.id }, { decision: 'ask' });
  const describe = async () => {
    const c = await op.confirm(ctx, args);
    return typeof c === 'string' ? { note: c, before: null } : c;
  };
  const reason = typeof args?.reason === 'string' ? args.reason : null;
  const ask = async (attempt, requestId) => {
    const change = await describe();
    const receipt = receiptOf(op.id, args, change.before);
    let id = requestId;
    const proceed = async () => {
      if (receiptOf(op.id, args, (await describe()).before) === receipt) return run();
      return attempt < RECEIPT_RETRIES ? ask(attempt + 1, id) : failure('STALE', { id: op.id }, { decision: 'ask' });
    };
    const answer = await ctx.approve({ op: op.id, change: { ...change, op: op.id }, receipt, reason, actor: ctx.actor, ...(requestId ? { requestId } : {}), proceed });
    if (!answer?.pending) return failure(answer?.code ?? 'DENIED', { id: op.id }, { decision: 'ask' });
    id = answer.requestId;
    return pendingResult(ctx.locale, op.id, change.key, id);
  };
  return ask(0, null);
}

/** 承認待ちの返り値。エージェントへの文（会話の言語）と requestId。結果は後で会話に届く（ADR 0088） */
function pendingResult(locale, opId, key, requestId) {
  const message = agentT(locale, 'ops.pending', { target: targetText(locale, opId, key), requestId });
  return { ok: true, pending: true, decision: 'ask', result: { status: 'pending', code: 'PENDING_APPROVAL', requestId, message } };
}

/** エージェントへの文に入れる、変更の対象（設定ならその名前、ほかは操作の id） */
export const targetText = (locale, opId, key) => (key ? agentT(locale, 'ops.settingTarget', { key }) : agentT(locale, 'ops.opTarget', { id: opId }));

const issuesOf = (error) => error.issues.map((i) => ({ path: i.path.join('.'), code: i.code, message: i.message }));

export function createRegistry({ ops = [], settings = [] } = {}) {
  const byId = new Map();
  const byLegacy = new Map();
  for (const op of ops) {
    if (op?.kind !== 'op') throw new Error('ops: createRegistry ops must come from defineOp');
    if (byId.has(op.id)) throw new Error(`ops: duplicate id: ${op.id}`);
    byId.set(op.id, op);
    // legacyAliases: 同じ操作を別の引数の形で呼ぶ WS のコマンド（画面が持つ形のまま。例: setAutoCompaction は settings.set の compaction.auto）
    for (const name of [op.legacyCommand, ...(op.legacyAliases ?? [])].filter(Boolean)) {
      if (byLegacy.has(name)) throw new Error(`ops: duplicate legacyCommand: ${name}`);
      byLegacy.set(name, op);
    }
  }
  const settingsByKey = new Map();
  for (const s of settings) {
    if (s?.kind !== 'setting') throw new Error('ops: createRegistry settings must come from defineSetting');
    if (settingsByKey.has(s.key)) throw new Error(`ops: duplicate setting key: ${s.key}`);
    settingsByKey.set(s.key, s);
  }

  /** その主体から見える操作（その口に出していて、policy が hidden にしないもの）。 */
  function list(principal) {
    const surface = surfaceOf(principal);
    return [...byId.values()].filter((op) => onSurface(op, surface) && decide(principal, op.risk).decision !== 'hidden');
  }

  /**
   * 関所。すべての口はここを通る。
   *   principal  { by: 'human', via?: 'ui', local?: boolean } | { by: 'agent', via: 'mcp'|'cli'|'mcp-stdio', sessionId?: string }
   *   deps       handler へ渡す依存。ほかに locale（失敗の文の言語）・modeOf(sessionId)（束縛された会話の承認モード）・audit(entry)
   * 返り値: { ok: true, result, decision } | { ok: false, code, error, issues?, decision? } |
   *         承認待ち { ok: true, pending: true, result: { status: 'pending', code: 'PENDING_APPROVAL', requestId, message }, decision: 'ask' }
   */
  async function invoke(principal, id, args, deps = {}) {
    const locale = deps.locale;
    const failure = (code, params, extra) => ({ ok: false, code, error: agentT(locale, `ops.errors.${code}`, params), ...extra });
    const notFound = () => failure('NOT_FOUND', { id: String(id) });

    const op = typeof id === 'string' ? byId.get(id) : undefined;
    if (!op || !onSurface(op, surfaceOf(principal))) return notFound();
    // 人間以外には、human-only が在ることを明かさない（見つからないのと同じに見せる）
    if (decide(principal, op.risk).decision === 'hidden') return notFound();

    if (op.hostScreenOnly && !(principal.by === 'human' && principal.local === true)) return failure('HOST_SCREEN_ONLY');

    const parsed = op.input.safeParse(args ?? {});
    if (!parsed.success) {
      const issues = issuesOf(parsed.error);
      return failure('INVALID', { detail: issues.map((i) => `${i.path || '(root)'}: ${i.message}`).join('; ') }, { issues });
    }

    // 束縛された会話の承認モード（agent だけ）。引けなければ policy が弱い側に倒す
    const sessionId = principal.by === 'agent' && principal.sessionId ? principal.sessionId : null;
    const mode = sessionId ? await deps.modeOf?.(sessionId) : undefined;
    const subject = { by: principal.by, sessionId, mode };
    const actor = { by: principal.by, ...(principal.via ? { via: principal.via } : {}), ...(sessionId ? { sessionId } : {}) };
    const ctx = { ...deps, actor, principal, op, registry: api };

    // 値に依って危険度が上がる操作は、定義の risk より下げない
    let risk = op.risk;
    if (op.riskOf) {
      let raised;
      try { raised = await op.riskOf(ctx, parsed.data); }
      catch (err) { if (err instanceof OpError) return { ok: false, code: err.code, error: err.message }; throw err; }
      if (!RISKS.includes(raised)) throw new Error(`ops: riskOf of ${op.id} returned an invalid risk: ${raised}`);
      risk = maxRisk(risk, raised);
    }

    const verdict = decide(subject, risk, { modeGate: op.modeGate });
    if (verdict.decision === 'hidden') return notFound();
    if (verdict.decision === 'deny') return failure(verdict.code, { id: op.id }, { decision: 'deny' });
    const run = async () => {
      if (risk !== 'read') await deps.audit?.({ op: op.id, risk, reason: verdict.reason, actor, sessionScope: op.scope });
      try {
        // 画面（人）には、画面が読む全量の形を返せる（uiHandler）。AI・CLI は handler の、件数と字数に上限のある形（ADR 0091 追記）
        const result = await (op.uiHandler && principal.by === 'human' ? op.uiHandler(ctx, parsed.data) : op.handler(ctx, parsed.data));
        return { ok: true, result: maskOutput(result ?? null), decision: verdict.decision };
      } catch (err) {
        if (err instanceof OpError) return { ok: false, code: err.code, error: err.message, decision: verdict.decision };
        throw err;
      }
    };
    // 会話の承認カード（askPermission の settingChange）。待たずに承認待ち（PENDING_APPROVAL）を返し、人が許可したら run する。
    // 許可のあとに値が変わっていれば（受領証が合わない）聞き直す。承認の口が無い呼び出し（単体の検査）は NEEDS_APPROVAL
    if (verdict.decision === 'ask') return approval(ctx, op, parsed.data, failure, run);
    return run();
  }

  /**
   * 主体から見える操作の説明（GET /api/ops と ply_control の tools/list の元。JSON にできる）。
   * 説明と入力のスキーマの description は locale の言語。口が違っても同じ操作は同じ形で出る
   */
  function describe(principal, locale) {
    return list(principal).map((op) => ({
      id: op.id,
      summary: agentT(locale, op.summary.slice('agent:'.length)),
      risk: op.risk,
      scope: op.scope,
      input: inputJsonSchema(op, locale),
      mcp: op.surfaces.mcp,
      tool: op.surfaces.mcp === 'direct' ? directToolName(op) : null,
      cli: op.surfaces.cli === true ? { path: op.id.split('.') } : op.surfaces.cli || null,
    }));
  }

  const api = {
    ops: [...byId.values()],
    settings: [...settingsByKey.values()],
    get: (id) => byId.get(id),
    getSetting: (key) => settingsByKey.get(key),
    legacyCommands: () => new Set(byLegacy.keys()),
    list,
    describe,
    invoke,
  };
  return api;
}
