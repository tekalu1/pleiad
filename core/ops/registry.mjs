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

/** 設定を定義する。settings.list / get / set / schema の 4 操作はこの一覧から作る（段階 1・2）。 */
export function defineSetting(def) {
  const key = def?.key;
  if (typeof key !== 'string' || !KEY_RX.test(key)) fail(String(key), 'key must be dot-separated, starting with a lowercase letter');
  if (def.summary !== `agent:settings.${key}`) fail(key, `summary must be agent:settings.${key}`);
  if (!RISKS.includes(def.risk)) fail(key, `risk must be one of ${RISKS.join(' / ')}`);
  if (typeof def.schema?.parse !== 'function') fail(key, 'schema must be a zod schema');
  if (!('default' in def)) fail(key, 'default is required');
  if (typeof def.read !== 'function' || typeof def.write !== 'function') fail(key, 'read and write are required');
  if (def.risk === 'write' && !(typeof def.riskReason === 'string' && def.riskReason.trim())) fail(key, 'a write setting needs riskReason');
  if (def.riskOf !== undefined && typeof def.riskOf !== 'function') fail(key, 'riskOf must be a function (before, after) => risk');
  // prefs.json に書くキー（既定は key 自身）。tests/lint-ops.mjs が「prefs に書くキーは設定の一覧にある」の照合に使う
  const prefKeys = def.prefKeys ?? [key];
  if (!Array.isArray(prefKeys) || !prefKeys.every((k) => typeof k === 'string' && k)) fail(key, 'prefKeys must be an array of strings');
  return Object.freeze({ ...def, kind: 'setting', prefKeys });
}

/** 口 → surfaces の欄。human は画面、agent は via で決まる（cli は CLI、mcp と mcp-stdio は MCP）。 */
export function surfaceOf(principal) {
  if (principal?.by === 'human') return 'ui';
  return principal?.via === 'cli' ? 'cli' : 'mcp';
}

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

const issuesOf = (error) => error.issues.map((i) => ({ path: i.path.join('.'), code: i.code, message: i.message }));

export function createRegistry({ ops = [], settings = [] } = {}) {
  const byId = new Map();
  const byLegacy = new Map();
  for (const op of ops) {
    if (op?.kind !== 'op') throw new Error('ops: createRegistry ops must come from defineOp');
    if (byId.has(op.id)) throw new Error(`ops: duplicate id: ${op.id}`);
    byId.set(op.id, op);
    if (op.legacyCommand) {
      if (byLegacy.has(op.legacyCommand)) throw new Error(`ops: duplicate legacyCommand: ${op.legacyCommand}`);
      byLegacy.set(op.legacyCommand, op);
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
   * 返り値: { ok: true, result, decision } | { ok: false, code, error, issues?, decision? }
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
    const ctx = { ...deps, actor, principal, op };

    // 値に依って危険度が上がる操作は、定義の risk より下げない
    let risk = op.risk;
    if (op.riskOf) {
      const raised = await op.riskOf(ctx, parsed.data);
      if (!RISKS.includes(raised)) throw new Error(`ops: riskOf of ${op.id} returned an invalid risk: ${raised}`);
      risk = maxRisk(risk, raised);
    }

    const verdict = decide(subject, risk, { modeGate: op.modeGate });
    if (verdict.decision === 'hidden') return notFound();
    if (verdict.decision === 'deny') return failure(verdict.code, { id: op.id }, { decision: 'deny' });
    // 段階 2 で、ここに会話の承認カード（askPermission の settingChange）と受領証の照合が入る
    if (verdict.decision === 'ask') return failure('NEEDS_APPROVAL', { id: op.id }, { decision: 'ask' });

    if (risk !== 'read') await deps.audit?.({ op: op.id, risk, reason: verdict.reason, actor, sessionScope: op.scope });

    try {
      const result = await op.handler(ctx, parsed.data);
      return { ok: true, result: maskOutput(result ?? null), decision: verdict.decision };
    } catch (err) {
      if (err instanceof OpError) return { ok: false, code: err.code, error: err.message, decision: verdict.decision };
      throw err;
    }
  }

  return {
    ops: [...byId.values()],
    settings: [...settingsByKey.values()],
    get: (id) => byId.get(id),
    getSetting: (key) => settingsByKey.get(key),
    legacyCommands: () => new Set(byLegacy.keys()),
    list,
    invoke,
  };
}
