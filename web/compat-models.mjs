// 互換の接続先のモデル ID の表示と検索（画面の各所と tests が読む。DOM に触らない）。
//
// 送る ID は一覧どおりのまま変えない。変えるのは表示だけ（docs/design.md「互換の接続先」）:
//   - 先頭の `anthropic/` は、その残りにさらに `/` を含むときだけ隠す。OpenRouter が Claude Code 向けの一覧で
//     他社のモデルに付ける名前空間（`anthropic/deepseek/deepseek-v4.1-flash`）で、サーバー側で外される。
//     OpenRouter の Claude 自体は `anthropic/claude-opus-5.5`（二重にならない）なので、そのまま出す
//   - 末尾の `[1m]` は Claude Code の「1M コンテキスト」の印（CLI が送る前に外す）。字からは外し、小さな「1M」の札で示す
// 検索は大文字小文字を区別しない部分一致。空白で区切った語はすべて当たるもの（AND）。表示名・送る ID・display_name のどれでもよい。

import { filterLimited, SHOW_LIMIT } from './search-terms.mjs';
import { t } from './i18n.mjs';

export { searchTerms, matchesTerms, filterLimited, moreText, SHOW_LIMIT } from './search-terms.mjs';

const ONE_M = /\[1m\]$/i;
const NAMESPACE = 'anthropic/';

/**
 * モデル ID の表示の形。
 * @returns {{ id: string, text: string, oneM: boolean }} text は字（札を除く）、oneM は「1M」の札を付けるか
 */
export function compatModelLabel(id) {
  const raw = String(id ?? '');
  const oneM = ONE_M.test(raw);
  let text = oneM ? raw.replace(ONE_M, '') : raw;
  if (text.toLowerCase().startsWith(NAMESPACE) && text.slice(NAMESPACE.length).includes('/')) text = text.slice(NAMESPACE.length);
  return { id: raw, text, oneM };
}

/** 札を置けない字だけの場所（「次のターンから適用」の文言など）の形。1M は（1M）と書く */
export function compatModelText(id) {
  const { text, oneM } = compatModelLabel(id);
  return oneM ? t('compat.model.withOneM', { text }) : text;
}

/** コンテキスト長の短い字（1000000 → 1M、262144 → 256K、200000 → 200K）。無ければ '' */
export function contextLabel(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return '';
  if (v >= 1_000_000) { const m = v / 1_000_000; return `${Number.isInteger(m) ? m : m.toFixed(1).replace(/\.0$/, '')}M`; }
  // 1000 の倍数（256000）はそのまま、2 の冪の倍数（262144）は 1024 で割る（どちらも 256K）
  if (v >= 1000) return `${v % 1000 === 0 ? v / 1000 : v % 1024 === 0 ? v / 1024 : Math.round(v / 1000)}K`;
  return String(v);
}

/**
 * 候補の一覧を作る。models は送る ID の配列、info は { [id]: { name?, context? } }（一覧取得のときに取れた分だけ）。
 * extra は一覧に無くても先に出す ID（役割に割り当てた ID など）。重複と空は除く
 * @returns {Array<{ id, text, oneM, name, context, sub }>} sub は 2 行目（display_name とコンテキスト長。無ければ ''）
 */
export function modelCandidates(models = [], info = {}, extra = []) {
  const ids = [...new Set([...extra, ...models].filter(v => typeof v === 'string' && v))];
  return ids.map(id => {
    const { text, oneM } = compatModelLabel(id);
    const i = info?.[id] ?? {};
    const name = typeof i.name === 'string' && i.name && i.name !== id && i.name !== text ? i.name : '';
    const context = contextLabel(i.context);
    return { id, text, oneM, name, context, sub: [name, context && t('compat.model.context', { context })].filter(Boolean).join(' · ') };
  });
}

/** モデルの候補を検索する（表示名・送る ID・display_name に当てる） */
export const searchModels = (cands, query, limit = SHOW_LIMIT) => filterLimited(cands, query, c => [c.text, c.id, c.name], limit);

/**
 * 打った字を送る ID に落とす（自由入力）。送る ID か表示名に一致すればその ID（大文字小文字は区別しない。
 * 表示名が同じ候補が複数あるときは、札の無いほうを先に）。どれにも当たらなければ打った字そのまま
 */
export function resolveTyped(cands, typed) {
  const v = String(typed ?? '').trim();
  if (!v) return '';
  const low = v.toLowerCase();
  const byId = cands.find(c => c.id === v) ?? cands.find(c => c.id.toLowerCase() === low);
  if (byId) return byId.id;
  const byText = cands.filter(c => c.text.toLowerCase() === low);
  return (byText.find(c => !c.oneM) ?? byText[0])?.id ?? v;
}

/** 札の「1M」の説明（title） */
export const ONE_M_TITLE = t('compat.model.oneMTitle');

/** combo（web/combo.mjs）の候補の形に。字は表示名、確定する値は送る ID、札は 1M、2 行目は display_name とコンテキスト長 */
export const comboModelOptions = (cands) => cands.map(c => ({
  value: c.id, label: c.text, sub: c.sub, badge: c.oneM ? '1M' : '', badgeTitle: c.oneM ? ONE_M_TITLE : '', search: [c.name], title: c.id,
}));
