// MCP・Hooks・リモートの操作の返りから秘密を伏せ、伏せ字のまま戻ってきた値を元へ戻す（ADR 0095）。
// 各モジュールが画面へ返す形はもう伏せてある（env・ヘッダーの値・bearer・OAuth のクライアントシークレット・URL のクエリ）。ここはその上に、
//   - どの主体にも: 同じ伏せ字をもう一度掛ける（伏せ字は冪等。モジュールが伏せ忘れても最後の網になる）
//   - agent にだけ: コマンドの引数（--token 値・--api-key=…・sk-… など、形で分かる秘密）と、承認の URL・ペアリングの番号を伏せる
// 画面（人）にはコマンドの引数をそのまま返す（編集欄に出すため。画面の振る舞いは変えない）。
import { agentT } from '../i18n.mjs';
import { maskDefinition as maskShape } from '../hooks-config.mjs';
import { maskUrl } from '../mcp-config.mjs';
import { MASK, OpError } from './registry.mjs';

export { MASK, maskUrl };

/** 人以外（ply_control・CLI・pleiad mcp）の呼び出しか */
export const byAgent = (ctx) => ctx.principal?.by !== 'human';

// 伏せ字の印。モジュールの伏せ字（••••）と、形で伏せる core/redact.mjs の伏せ字（***）
const MARKS = [MASK, '***'];
export const hasMask = (s) => typeof s === 'string' && MARKS.some((m) => s.includes(m));

const record = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const SECRET_MAPS = ['env', 'headers', 'http_headers'];

/** コマンドの引数の並び。秘密のフラグの次の要素（--token 値）と、形で分かる秘密（--api-key=…・sk-…・URL のクエリ）を伏せる */
export const maskArgs = (args) => (Array.isArray(args) ? maskShape(args) : args);

/**
 * MCP の定義 1 つ（各エージェントの設定の値・Pleiad の登録の編集欄の値・一覧の行）。
 * env・ヘッダーの値（null は「まだ入れていない」なので残す）・bearer・clientSecret・URL を伏せ、agent には引数も伏せる
 */
export function maskMcp(value, agent) {
  if (!record(value)) return value;
  const out = { ...value };
  for (const k of SECRET_MAPS) if (record(out[k])) out[k] = Object.fromEntries(Object.entries(out[k]).map(([n, v]) => [n, typeof v === 'string' ? MASK : v]));
  if (typeof out.bearerToken === 'string') out.bearerToken = MASK;
  if (record(out.oauth) && typeof out.oauth.clientSecret === 'string') out.oauth = { ...out.oauth, clientSecret: MASK };
  if (typeof out.url === 'string') out.url = maskUrl(out.url);
  if (agent && Array.isArray(out.args)) out.args = maskArgs(out.args);
  return out;
}

/**
 * agent が読んだ値（伏せ字入り）を書き戻したとき、伏せ字の所だけを今の値へ戻す。
 * next と shown（agent に見せた形）が同じ場所で同じなら raw（伏せる前の値）を使い、伏せ字を含むのに合わなければ断る
 * （伏せ字そのものを値として保存しない）。並びは位置で突き合わせる（引数を足した・消した所に伏せ字を書き戻すと断る）
 */
export function restoreMasked(ctx, next, shown, raw, where = '') {
  if (typeof next === 'string') {
    if (!hasMask(next)) return next;
    if (next === shown && typeof raw === 'string') return raw;
    throw new OpError('MASKED', agentT(ctx.locale, 'ops.errors.MASKED', { path: where || '(root)' }));
  }
  if (Array.isArray(next)) return next.map((v, i) => restoreMasked(ctx, v, Array.isArray(shown) ? shown[i] : undefined, Array.isArray(raw) ? raw[i] : undefined, `${where}[${i}]`));
  if (record(next)) return Object.fromEntries(Object.entries(next).map(([k, v]) => [k, restoreMasked(ctx, v, record(shown) ? shown[k] : undefined, record(raw) ? raw[k] : undefined, where ? `${where}.${k}` : k)]));
  return next;
}

/**
 * モジュールの失敗（ふつうの Error）を、agent には code 付きの失敗（OpError）にして返す。人には元の例外のまま投げる
 * （WS の外側が今までどおりの文と code で返す。画面の振る舞いは変えない）
 */
export async function run(ctx, fn) {
  try { return await fn(); } catch (e) {
    if (e instanceof OpError || !byAgent(ctx)) throw e;
    throw new OpError(typeof e?.code === 'string' && /^[A-Z_]+$/.test(e.code) ? e.code : 'FAILED', String(e?.message ?? e));
  }
}

/** 会話に束縛された agent が cwd を省いたら、その会話の作業場所。人は省いたまま（画面の既定の動きを変えない） */
export async function cwdFor(ctx, cwd) {
  if (cwd !== undefined || !byAgent(ctx) || !ctx.actor?.sessionId) return cwd;
  return (await ctx.sessionCwd?.(ctx.actor.sessionId).catch(() => null)) ?? undefined;
}

/** 会話を指す操作の sessionId。agent は省けばその会話。人は省けない（今までどおり、モジュールが断る） */
export const sessionFor = (ctx, sessionId) => sessionId ?? (byAgent(ctx) ? ctx.actor?.sessionId : undefined);

const URL_KEYS = new Set(['url', 'endpoint', 'baseUrl', 'relayUrl']);
const maskUrls = (value, key = '') => {
  if (Array.isArray(value)) return value.map((v) => maskUrls(v));
  if (record(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, maskUrls(v, k)]));
  return typeof value === 'string' && URL_KEYS.has(key) ? maskUrl(value) : value;
};

/**
 * agent に返す、探索の結果・会話の文脈・git の差分などの木（ADR 0105）。どこに秘密が混じるか形で決まらないので、
 * Hooks の定義と同じ伏せ方（env・headers の表、秘密らしい名前のキー、コマンドの引数の秘密、形で分かる秘密）を全体に掛け、URL のクエリも伏せる
 */
export const maskTree = (value) => maskUrls(maskShape(value));
