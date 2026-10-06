// 片の文字から、前の片と重なった分を除く（通話モード。docs/voice-call.md「区切りと片」）。
// 出どころ: vtc-web gateway/src/stt/piece-text.ts を .mjs へ移した（型と実測の表を外し、規則の理由だけ残した）。
//
// 片は頭に直前の音声（既定 2 秒）を付けて送るので、返る文字には前の片で出した言葉が頭に入っている。
// 前に出した文字の末尾と返った文字の頭を突き合わせ、重なりを捨てる。重なり整列で、一致 +2・不一致 −1・欠落 −1。得点が 5 未満なら重なりが見つからなかったとみなす。
// 比べるのは句読点・空白を除いた文字（片の終わりの「。」の付け方が前の片と食い違うことがある）。
// 前の文字が 2 字以下なら、得点の下限をその全部が一致したときの得点に下げる。
// 見つからなかったら、その片の文字は使わない（ok: false）。足すと重なった言葉が二重になる。二重に読むより、その発話の途中経過をあきらめて確定を待つ。

const MIN_OVERLAP_SCORE = 5;
const MATCH = 2;
const MISMATCH = -1;
const GAP = -1;

const minOverlapScore = (previousChars) => Math.min(MIN_OVERLAP_SCORE, MATCH * previousChars);

// 突き合わせる前の文字の長さ: 付けた音声 1 秒あたり 9 字 + 6 字（日本語の話す速さ 7〜9 字/秒に余裕を足した長さ）。空白で語を区切る言語は 2 倍
const TAIL_CHARS_PER_SECOND = 9;
const TAIL_EXTRA_CHARS = 6;

const IGNORED = /[\s、。，．,.!?！？「」『』（）()・…~〜ー\-‐‑–—―"'“”‘’:：;；]/u;
const UNSPACED_LANGS = new Set(['ja', 'zh', 'th']);

/** 語を空白で区切らない言語か（日本語・中国語・タイ語） */
export const isUnspacedLang = (lang) => UNSPACED_LANGS.has(String(lang ?? '').toLowerCase().split('-')[0]);

/** 比べるための文字列と、その 1 字ずつが元の文字列のどこで終わるか */
function normalize(text) {
  const chars = [], ends = [];
  let index = 0;
  for (const char of text) {
    for (const n of char.normalize('NFKC').toLowerCase()) {
      if (!IGNORED.test(n)) { chars.push(n); ends.push(index + char.length); }
    }
    index += char.length;
  }
  return { chars, ends };
}

/** 前の文字 tail の末尾と returned の頭が重なる長さ（returned の何字目まで）。見つからなければ 0。前の文字の開始は自由・返った文字は頭から・終わりは前の文字の末尾に固定 */
function overlapLength(tail, returned, minScore) {
  if (tail.length === 0 || returned.length === 0) return 0;
  let previous = returned.map((_, j) => (j + 1) * GAP);
  previous.unshift(0);
  for (let i = 1; i <= tail.length; i++) {
    const current = new Array(returned.length + 1).fill(0);
    for (let j = 1; j <= returned.length; j++) {
      current[j] = Math.max(
        previous[j - 1] + (tail[i - 1] === returned[j - 1] ? MATCH : MISMATCH),
        previous[j] + GAP,
        current[j - 1] + GAP,
      );
    }
    previous = current;
  }
  let best = 0;
  // 同点なら短い方（長い方を採ると、新しく増えた言葉の頭の字を重なりとして捨てることがある）
  for (let j = 1; j < previous.length; j++) if (previous[j] > previous[best]) best = j;
  return previous[best] >= minScore ? best : 0;
}

/**
 * 片の認識結果 returned から、既に出した文字 previous と重なる頭を除く。
 * @param {number} contextMs 片の頭に付けた音声の長さ。0（最初の片）なら除かない
 * @returns {{ ok: true, text: string, overlapChars: number } | { ok: false }}
 */
export function removeOverlap(previous, returned, contextMs, lang) {
  const prev = normalize(previous).chars;
  if (contextMs <= 0 || prev.length === 0) return { ok: true, text: returned, overlapChars: 0 };
  const next = normalize(returned);
  if (next.chars.length === 0) return { ok: true, text: '', overlapChars: 0 };
  const factor = isUnspacedLang(lang) ? 1 : 2;
  const tailChars = (Math.round((contextMs / 1000) * TAIL_CHARS_PER_SECOND) + TAIL_EXTRA_CHARS) * factor;
  const tail = prev.slice(-tailChars);
  const overlap = overlapLength(tail, next.chars, minOverlapScore(tail.length));
  if (overlap === 0) return { ok: false };
  // 重なりの最後の文字の直後から。重なりのすぐ後の句読点は残す。空白は捨てる（語を空白で区切る言語の間の空白は joinPiece が足す）
  const cut = next.ends[overlap - 1] ?? 0;
  return { ok: true, text: returned.slice(cut).trimStart(), overlapChars: overlap };
}

/** 既に出した文字 previous の後ろに片の文字 addition を足すときの形を整える（空白で語を区切る言語の空白・句読点の重なり） */
export function joinPiece(previous, addition, lang) {
  let text = addition;
  if (previous.length > 0 && /[、。，．,.!?！？]$/u.test(previous)) text = text.replace(/^[\s、。，．,.!?！？]+/u, '');
  if (!isUnspacedLang(lang) && previous.length > 0 && text.length > 0 && !/\s$/u.test(previous) && !/^\s/u.test(text)) return ` ${text}`;
  return text;
}

/** 片の認識結果の掃除。前後の空白と終わりのハイフン類（MAI は語の途中で切れた片の終わりに「話-」のような印を付けることがある）を落とす */
export const cleanPieceText = (text) => String(text ?? '').trim().replace(/[-‐‑–—―]+$/u, '').trimEnd();
