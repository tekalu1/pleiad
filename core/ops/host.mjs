// 操作の handler が、サーバー（core/server.mjs）の関数を呼ぶときの共通部品。
// WS のコマンドの中身を操作へ移したあとも、サーバーの関数は普通の Error（文は画面の言語・code は任意）を投げる。
// 画面は文と code をそのまま出し、AI・CLI は OpError の code で見分ける（FAILED は「code の無い失敗」）。
import { agentT } from '../i18n.mjs';
import { OpError } from './registry.mjs';

export const FAILED = 'FAILED';

/** サーバーの関数が投げた普通の Error を OpError にする（code を持てばそれ。無ければ FAILED）。OpError はそのまま */
export async function fromHost(fn) {
  try { return await fn(); }
  catch (e) {
    if (e instanceof OpError) throw e;
    throw new OpError(typeof e?.code === 'string' && e.code ? e.code : FAILED, String(e?.message ?? e));
  }
}

export const PAGE_DEFAULT = 30;
export const PAGE_MAX = 100;

const encode = (offset) => Buffer.from(`o${offset}`).toString('base64url');
const decode = (cursor) => {
  const m = /^o(\d{1,9})$/.exec(Buffer.from(String(cursor), 'base64url').toString('utf8'));
  return m ? Number(m[1]) : null;
};

/**
 * 並びが決まった配列のページ送り。cursor は読み終えた位置（不透明な文字列）。壊れた cursor は badCursor で INVALID。
 * 返り値: { total, items, next }。next が null なら終わり
 */
export function pageOf(ctx, items, { limit = PAGE_DEFAULT, cursor } = {}) {
  const start = cursor === undefined ? 0 : decode(cursor);
  if (start === null) throw new OpError('INVALID', agentT(ctx.locale, 'ops.errors.badCursor'));
  const page = items.slice(start, start + limit);
  return { total: items.length, items: page, next: start + limit < items.length ? encode(start + limit) : null };
}

/** 長い文字列を切る（AI が 1 回で読む量を抑える。切ったら truncated で知らせる側が使う） */
export const clip = (text, max) => { const s = String(text ?? ''); return s.length > max ? s.slice(0, max) : s; };

/** 承認モード・アカウント・接続先など、人だけが決める項目を AI・CLI が渡したら断る（権限を広げる向きなので、画面での操作へ誘導する） */
export function humanOnlyFields(ctx, args, fields) {
  if (ctx.principal.by === 'human') return;
  const given = fields.filter((f) => args[f] !== undefined);
  if (given.length) throw new OpError('NEEDS_UI', agentT(ctx.locale, 'ops.errors.NEEDS_UI', { id: `${ctx.op.id} (${given.join(', ')})` }));
}
