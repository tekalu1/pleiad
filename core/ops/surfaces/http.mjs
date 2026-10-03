// 操作の一覧の HTTP の口（ADR 0083）。CLI（bin/pleiad.mjs）と pleiad mcp が使う。
//   GET  /api/ops[?surface=cli|mcp]   その主体から見える操作の説明（id・説明・危険度・入力の JSON Schema・CLI の形）と、レジストリの版
//   POST /api/ops/<id>                本文が引数の JSON。{ ok: true, result } か { ok: false, code, error, issues? }。承認待ちは 202 と { ok: true, pending: true, result }
// 認証は Authorization: Bearer だけ。画面のトークン・クッキーは受けない。受けるトークンは 2 種類:
//   CLI 用トークン（control.json）      会話に束縛されない agent（via: cli。x-pleiad-via: mcp-stdio なら pleiad mcp）
//   会話の接続のトークン（環境変数）    その会話に束縛された agent（via: cli）。その会話の承認モードに従う
import crypto from 'node:crypto';
import { controlTexts } from './control.mjs';

export const OPS_PATH = '/api/ops';
const MAX_BODY = 256_000;
const STATUS = { NOT_FOUND: 404, SESSION_NOT_FOUND: 404, MESSAGE_NOT_FOUND: 404, SETTING_NOT_FOUND: 404, TASK_NOT_FOUND: 404, CHANNEL_NOT_FOUND: 404, POST_NOT_FOUND: 404, NOT_YOUR_POST: 403, CHANNEL_NAME_TAKEN: 409, CHANNEL_ARCHIVED: 409, INVALID: 400, SETTING_READ_ONLY: 403, NEEDS_UI: 403, NEEDS_APPROVAL: 403, DENIED: 403, STALE: 409, READ_ONLY_MODE: 403, HOST_SCREEN_ONLY: 403 };

/**
 * @param registry     操作の一覧
 * @param authenticate (token) => { owner?, locale? } | null   owner があれば会話に束縛（owner() が会話の id を返す）、無ければ CLI 用トークン。null は 401
 * @param depsFor      (locale) => invoke の依存
 * @param serverLocale () => 今の画面の言語（束縛されない呼び出しの既定）
 */
export function createOpsHttp({ registry, authenticate, depsFor, serverLocale }) {
  async function route(req, res, url, reply) {
    const token = /^Bearer ([A-Za-z0-9_-]{16,128})$/.exec(req.headers.authorization ?? '')?.[1];
    const auth = token ? authenticate(token) : null;
    if (!auth) return reply(401, { ok: false, code: 'UNAUTHORIZED', error: 'Unauthorized' });
    if (req.headers.origin) {
      try { if (new URL(req.headers.origin).host !== req.headers.host) return reply(403, { ok: false, code: 'FORBIDDEN', error: 'Forbidden' }); } catch { return reply(403, { ok: false, code: 'FORBIDDEN', error: 'Forbidden' }); }
    }
    const asked = String(req.headers['x-pleiad-locale'] ?? '').toLowerCase();
    const locale = auth.locale ?? (asked === 'ja' || asked === 'en' ? asked : serverLocale());
    // pleiad mcp だけが MCP の面を名乗れる。会話に束縛された接続は CLI のまま（会話の中には束縛した HTTP の ply_control を渡す）
    const stdio = !auth.owner && (url.pathname === OPS_PATH ? url.searchParams.get('surface') === 'mcp' : req.headers['x-pleiad-via'] === 'mcp-stdio');
    const via = stdio ? 'mcp-stdio' : 'cli';

    if (url.pathname === OPS_PATH) {
      if (req.method !== 'GET') return reply(405, { ok: false, code: 'METHOD', error: 'Method Not Allowed' });
      const ops = registry.describe({ by: 'agent', via }, locale);
      const revision = crypto.createHash('sha256').update(JSON.stringify(ops)).digest('hex').slice(0, 16);
      return reply(200, { ok: true, result: { revision, locale, surface: stdio ? 'mcp' : 'cli', ops, texts: controlTexts(locale) } });
    }

    let id;
    try { id = decodeURIComponent(url.pathname.slice(OPS_PATH.length + 1)); } catch { return reply(404, { ok: false, code: 'NOT_FOUND', error: 'Not Found' }); }
    if (req.method !== 'POST') return reply(405, { ok: false, code: 'METHOD', error: 'Method Not Allowed' });
    let args;
    try {
      const chunks = []; let size = 0;
      for await (const chunk of req) { size += chunk.length; if (size > MAX_BODY) return reply(413, { ok: false, code: 'INVALID', error: 'Payload Too Large' }); chunks.push(chunk); }
      args = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
    } catch { return reply(400, { ok: false, code: 'INVALID', error: 'Invalid JSON' }); }
    if (!args || typeof args !== 'object' || Array.isArray(args)) return reply(400, { ok: false, code: 'INVALID', error: 'The body must be a JSON object' });

    let principal;
    try { principal = { by: 'agent', via, ...(auth.owner ? { sessionId: await auth.owner() } : {}) }; }
    catch (e) { return reply(409, { ok: false, code: 'NOT_READY', error: String(e?.message ?? e) }); }
    const r = await registry.invoke(principal, id, args, depsFor(locale));
    // 承認待ち（会話の承認カードを出して、待たずに返した。ADR 0088）は 202 と pending: true
    if (r.ok) return reply(r.pending ? 202 : 200, { ok: true, ...(r.pending ? { pending: true } : {}), result: r.result });
    return reply(STATUS[r.code] ?? 500, { ok: false, code: r.code, error: r.error, ...(r.issues ? { issues: r.issues } : {}) });
  }

  return async function handle(req, res, url) {
    const reply = (status, body) => { if (res.headersSent) return; res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(body === undefined ? undefined : JSON.stringify(body)); };
    // 想定外の例外でサーバーごと落とさない（未処理の reject はプロセスを終わらせる）
    try { await route(req, res, url, reply); }
    catch (e) { reply(500, { ok: false, code: 'OTHER', error: String(e?.message ?? e) }); }
  };
}
