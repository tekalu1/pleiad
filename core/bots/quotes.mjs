// 人の投稿の `>` の引用の読み方（S4。ADR 0128 の追記）。dispatch.route が、聞こえた投稿が誰との話の続きかを決めるのに使う。SDK も DOM も import しない純粋な部品。
//   quoteBlocks(text)       … `>` で始まる行のまとまりごとに、印を外して比べやすくした文（コードの囲みの中は数えない。QUOTE_MIN_CHARS 字に満たないものは捨てる）
//   quotedPost(text, posts) … 引用のまとまりを本文に含む投稿（posts は古い順）。後ろのまとまりから見て、当たった中でいちばん新しいもの。無ければ null
//   比べるときは NFKC にし、強調・コードの印（* _ ` ~）と空白・改行を外す（表示された文を写した引用・折り返しの違う引用でも当たる）

/** これより短い引用は手がかりにしない（「はい」「OK」はどの投稿にも当たりうる） */
export const QUOTE_MIN_CHARS = 4;

const QUOTE = /^[ ]{0,3}(?:>[ \t]?)+/;
const FENCE = /^[ ]{0,3}(?:```|~~~)/;

/** 比べるための形（NFKC・強調とコードの印と空白を外す） */
export const comparable = (text) => String(text ?? '').normalize('NFKC').replace(/[*_`~\s]/g, '');

export function quoteBlocks(text) {
  const blocks = [];
  let cur = null, fence = false;
  for (const line of String(text ?? '').split(/\r?\n/)) {
    if (FENCE.test(line)) { fence = !fence; cur = null; continue; }
    const m = fence ? null : QUOTE.exec(line);
    if (!m) { cur = null; continue; }
    if (!cur) blocks.push(cur = []);
    cur.push(line.slice(m[0].length));
  }
  return blocks.map((b) => comparable(b.join('\n'))).filter((b) => b.length >= QUOTE_MIN_CHARS);
}

export function quotedPost(text, posts) {
  const list = (posts ?? []).filter((p) => p && !p.deletedAt && typeof p.text === 'string');
  for (const block of quoteBlocks(text).reverse()) {
    const hit = list.findLast((p) => comparable(p.text).includes(block));
    if (hit) return hit;
  }
  return null;
}
