// 大きい返事を WS の外（HTTP の GET /bulk/<id>）で渡す（ADR 0903）。
// 中継越しの線では、WS は 1 本のストリームなので、大きい返事を送っている間は後の小さい返事・出来事がその後ろで待つ。
// 画面が bulk を添えたコマンドの返事が大きければ、ここに置いて WS には置き場の URL だけを返す。画面はそれを HTTP で取り、
// その HTTP は別のストリームになるので、チャネルが WS とフレームごとに交互に流す。受け手が gzip を受けるなら縮めて返す。
// 置いた返事は 1 回取ったら消す。取りに来なければ ttlMs で消す。置いておく合計は maxBytes まで（超えたら古いものから消す）。
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { promisify } from 'node:util';

const gzip = promisify(zlib.gzip);
export const BULK_PATH = '/bulk/';
export const BULK_MIN_BYTES = 64 * 1024;

export function createBulkReplies({ minBytes = BULK_MIN_BYTES, ttlMs = 60_000, maxBytes = 64 * 1024 * 1024, now = Date.now } = {}) {
  const held = new Map();   // id → { body: Buffer, at }
  let total = 0;
  const drop = (id) => {
    const item = held.get(id);
    if (!item) return null;
    held.delete(id);
    total -= item.body.length;
    return item;
  };
  const sweep = () => {
    const limit = now() - ttlMs;
    for (const [id, item] of held) if (item.at < limit || total > maxBytes) drop(id); else break;
  };
  return {
    /** text（返事の JSON）が小さければ null。大きければ置いて、取りに来る URL（/bulk/<id>）を返す */
    offer(text) {
      if (typeof text !== 'string' || Buffer.byteLength(text) < minBytes) return null;
      const body = Buffer.from(text, 'utf8');
      const id = crypto.randomBytes(16).toString('hex');
      held.set(id, { body, at: now() });
      total += body.length;
      sweep();
      return held.has(id) ? `${BULK_PATH}${id}` : null;
    },
    /** GET /bulk/<id> を返す。自分の口でなければ false。画面のトークンの確かめは呼ぶ側が済ませておく */
    async handle(req, res, url) {
      if (!url.pathname.startsWith(BULK_PATH)) return false;
      sweep();
      const id = /^[0-9a-f]{32}$/.test(url.pathname.slice(BULK_PATH.length)) ? url.pathname.slice(BULK_PATH.length) : null;
      const item = req.method === 'GET' && id ? drop(id) : null;
      const headers = { 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' };
      if (!item) { res.writeHead(404, { ...headers, 'content-type': 'text/plain; charset=utf-8' }); res.end('not found'); return true; }
      let body = item.body;
      if (/\bgzip\b/i.test(String(req.headers['accept-encoding'] ?? ''))) {
        body = await gzip(body, { level: 6 });
        headers['content-encoding'] = 'gzip';
      }
      res.writeHead(200, { ...headers, 'content-type': 'application/json; charset=utf-8', vary: 'accept-encoding', 'content-length': body.length });
      res.end(body);
      return true;
    },
    get size() { return held.size; },
  };
}
