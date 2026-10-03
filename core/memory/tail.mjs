// bot の会話へ渡す記憶の文（ADR 0110）。キャッシュの並び: ツール → 人格 → 核の写し（始まり・圧縮の後に 1 回）→ 履歴 → 今のターンの末尾 → 発言。
//   核の写し … <pleiad-memory-core>。会話の始まりと圧縮の完了後の最初のターンの notes に 1 回だけ（session.snapshotDue）
//   末尾    … <pleiad-turn-context>。毎ターンの notes に: 時刻（分まで）・前のターンからの記憶の差分（20 件まで）・この話に関係する記憶（5 件まで）
// i18n-dynamic: agent:memory.turn.
// 文は辞書 agent:memory.*（会話の言語）。ここは文の組み立てだけで、ファイルも索引も触らない（service.mjs が材料を渡す）。
// 途中送信（control.steer）の道では末尾を付けない。差分は memRev を進めないので、次の新しいターンで渡る（dispatch の責務）。
import { agentT } from '../i18n.mjs';
import { memoryCoreEnvelope, turnContextEnvelope } from '../channels/types.mjs';
import { estimateTokens } from '../../web/token-estimate.mjs';
import { USER_LAYER } from './store.mjs';

/** 末尾の差分に出す件数の上限。超えたら件数と memory.search で引けることだけ */
export const DELTA_MAX = 20;
/** 関係する記憶の件数の上限 */
export const RELATED_MAX = 5;
/** 核の写しの 1 層あたりのトークンの目安（新しいものから入れ、残りは件数だけ） */
export const CORE_LAYER_TOKENS = 1200;

const pad = (n) => String(n).padStart(2, '0');

/** 時刻（分まで。PC の現地時刻と UTC からのずれ）。2026-10-03 10:41 +09:00 (土) */
export function formatNow(ms, locale) {
  const d = new Date(ms);
  const offset = -d.getTimezoneOffset();
  const sign = offset < 0 ? '-' : '+';
  const abs = Math.abs(offset);
  let weekday = '';
  try { weekday = new Intl.DateTimeFormat(locale === 'ja' ? 'ja-JP' : 'en-US', { weekday: 'short' }).format(d); } catch { /* 曜日が無くてもよい */ }
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())} ${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}${weekday ? ` (${weekday})` : ''}`;
}

const layerLabel = (locale, layer) => (layer === USER_LAYER ? agentT(locale, 'memory.layer.user') : agentT(locale, 'memory.layer.bot'));

/**
 * 差分の記録を、見る側に意味のある変更にたたむ（同じ id の複数の変更は最後の 1 つ。見せる前に消えたもの・見ていないものは出さない）。
 * records は rev の昇順。skipVia は、この会話が自分で書いた記憶（履歴に tool の結果がある）。返りは { items, skipped }
 *   items: { kind: 'add'|'edit'|'forget', layer, id, text }[]（時系列）。skipped: 自分が書いた記憶の id（見せないが渡した扱いにする）
 */
export function foldDelta(records, { layers, skipVia = null } = {}) {
  const byId = new Map();
  for (const r of records) {
    if (layers && !layers.includes(r.layer)) continue;
    if (!['add', 'edit', 'forget', 'unforget'].includes(r.op)) continue;
    const prev = byId.get(r.id);
    const kind = r.op === 'unforget' ? 'add' : r.op;
    const first = prev?.first ?? kind;
    byId.set(r.id, { first, kind, layer: r.layer, id: r.id, text: r.text ?? '', via: r.via ?? null, rev: r.rev, firstVia: prev ? prev.firstVia : (r.via ?? null) });
  }
  const items = [];
  const skipped = [];
  for (const v of [...byId.values()].sort((a, b) => a.rev - b.rev)) {
    // 範囲の中で作られて消えたものは、見せる前に無くなったので出さない
    if (v.first === 'add' && v.kind === 'forget') continue;
    const kind = v.first === 'add' && v.kind === 'edit' ? 'add' : v.kind;
    if (skipVia && v.via === skipVia && kind !== 'forget') { skipped.push(v.id); continue; }
    items.push({ kind, layer: v.layer, id: v.id, text: v.text });
  }
  return { items, skipped };
}

/**
 * 核の写しに入れる記憶を選ぶ。層ごとの目安まで、人が書いた・人が直した記憶（by.kind === 'human'）を先に、bot・AI が書いたものを後に
 * （それぞれ新しい更新から）。書き込みを重ねる bot が、新しさだけで人の古い記憶を押し出せないようにする。返りは { user, bot, omitted, ids }（本文は時系列）
 */
export function pickCore(userEntries, botEntries, { layerTokens = CORE_LAYER_TOKENS } = {}) {
  const humanFirst = (e) => (e.by?.kind === 'human' ? 0 : 1);
  const take = (list) => {
    const picked = [];
    let used = 0;
    for (const e of [...list].sort((a, b) => (humanFirst(a) - humanFirst(b)) || (b.updatedAt - a.updatedAt) || (b.at - a.at))) {
      const cost = estimateTokens(e.text) + 3;
      if (used + cost > layerTokens && picked.length) break;
      picked.push(e); used += cost;
    }
    const keep = new Set(picked.map((e) => e.id));
    return { picked: list.filter((e) => keep.has(e.id)), omitted: list.length - picked.length };
  };
  const u = take(userEntries), b = take(botEntries);
  return { user: u.picked, bot: b.picked, omitted: u.omitted + b.omitted, ids: [...u.picked, ...b.picked].map((e) => e.id) };
}

/** 核の写しの notes 1 件。記憶が 1 つも無いときは null（始まりに空の包みを足さない） */
export function coreSnapshot({ core, locale }) {
  if (!core.user.length && !core.bot.length) return null;
  const lines = [agentT(locale, 'memory.core.intro')];
  if (core.user.length) lines.push('', agentT(locale, 'memory.core.user'), ...core.user.map((e) => `- ${e.text}`));
  if (core.bot.length) lines.push('', agentT(locale, 'memory.core.bot'), ...core.bot.map((e) => `- ${e.text}`));
  if (core.omitted) lines.push('', agentT(locale, 'memory.more', { n: core.omitted }));
  return memoryCoreEnvelope(lines.join('\n'));
}

/**
 * 毎ターンの末尾の notes 1 件。
 *   now … ms。delta … foldDelta の items。related … 関係する記憶（MemoryEntry の配列）
 */
export function turnContext({ now, delta = [], related = [], locale }) {
  const lines = [agentT(locale, 'memory.turn.time', { time: formatNow(now, locale) })];
  if (delta.length) {
    const shown = delta.slice(-DELTA_MAX);
    lines.push('', agentT(locale, 'memory.turn.changes'));
    for (const d of shown) lines.push(`- ${agentT(locale, `memory.turn.${d.kind}`, { layer: layerLabel(locale, d.layer), text: d.text })}`);
    if (delta.length > shown.length) lines.push(`- ${agentT(locale, 'memory.more', { n: delta.length - shown.length })}`);
  }
  if (related.length) lines.push('', agentT(locale, 'memory.turn.related'), ...related.slice(0, RELATED_MAX).map((e) => `- ${e.text}`));
  return turnContextEnvelope(lines.join('\n'));
}
