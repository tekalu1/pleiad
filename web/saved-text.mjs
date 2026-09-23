// 保存される文言を今の画面の言語で出す（docs/design.md「多言語対応」）。
//
// 変更履歴の理由（reason）・添付の見出し（caption）は sessions.json・presents/*.jsonl に残る。
// 新しい記録は日本語の文（reason / caption。過去の記録・古い画面と互換）に加えて、
// キーと差し込み値（reasonKey + reasonParams / captionKey + captionParams）を持つ（core/server.mjs の savedReason・presentAttachments）。
// キーがあれば辞書（ui の saved）で今の言語に訳し、無い過去の記録（と辞書に無いキー）は保存された文のまま出す。
// 既定のタイトルは保存しない（空）。空なら今の言語の既定名を出す。
import { t } from './i18n.mjs';

// i18n-dynamic: saved.reason.
// i18n-dynamic: saved.caption.

/** 差し込み値の配列（ファイル名の並びなど）を今の言語の区切りでつなぐ */
function params(p) {
  if (!p || typeof p !== 'object') return {};
  return Object.fromEntries(Object.entries(p).map(([k, v]) => [k, Array.isArray(v) ? v.join(t('saved.separator')) : v]));
}

/** 変更の理由。{ reason, reasonKey?, reasonParams? }（イベントでも履歴の行でも）。無ければ '' */
export function savedReason(row) {
  if (row?.reasonKey) {
    const key = `saved.reason.${row.reasonKey}`;
    const text = t(key, params(row.reasonParams));
    if (text && text !== key) return text;
  }
  return row?.reason ?? '';
}

/** present（添付・提示）の見出し。キーが無ければ保存された caption のまま */
export function savedCaption(p) {
  if (p?.captionKey) {
    const key = `saved.caption.${p.captionKey}`;
    const text = t(key, params(p.captionParams));
    if (text && text !== key) return text;
  }
  return p?.caption ?? '';
}

/** 画面に出す直前のイベント・present。reason と caption を今の言語の文に置き換えた複製（元は変えない） */
export function savedEvent(ev) {
  if (!ev || (!ev.reasonKey && !ev.captionKey)) return ev;
  return { ...ev, ...(ev.reasonKey ? { reason: savedReason(ev) } : {}), ...(ev.captionKey ? { caption: savedCaption(ev) } : {}) };
}

/** セッションのタイトル。空（新しい記録）・"(no title)" なら今の言語の既定名 */
export function savedTitle(title) {
  return title && title !== '(no title)' ? title : t('saved.defaultTitle');
}
