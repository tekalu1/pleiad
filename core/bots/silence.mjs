// bot が「話すことが無い」と終えたターンの見分け方（S4。ADR 0119 の追記）。dispatch の finalizePost・progressBody が使う。純粋な部品。
//
// Claude Code は文章の無い終わりを許さず、bot は「（なし）」のような短い一言を書いてしまう。そこで:
//   - 固定の印 SILENT_MARK（指示文 agent:guide.bot.silent で伝える）を本文から外す。印だけの返事は文章なしと同じ
//   - 本文の全体が、沈黙を表すだけの短い文なら文章なしと同じ: 括弧で囲んだだけの短い一言（「（なし）」「(no reply)」「（特になし）」）・
//     省略の記号だけ（「…」「。」）。本当の返事を消さないよう、改行・URL・@・コードを含むもの、括弧の外に字があるものは数えない

/** 黙って終えるときに書く印（言語を持たない） */
export const SILENT_MARK = '[[no-reply]]';
const MARK_RE = /\[\[\s*no[-_ ]?reply\s*\]\]/gi;
/** 括弧の中の上限（文字数）。これより長いものは本当の返事として残す */
export const SILENT_MAX_CHARS = 20;
// かぎ括弧（「はい」）は返事の引用になりうるので数えない
const OPEN = '（(［[【〔<＜';
const CLOSE = '）)］]】〕>＞';
const PAIRS = new Map([...OPEN].map((o, i) => [o, CLOSE[i]]));
// 省略・区切りの記号と空白だけ（「…」「。」「---」）。「？」「！」は返事になりうるので含めない
const ONLY_MARKS = /^[\s…‥・.。、,，ー\-—–~〜_]*$/u;

/** 本文から黙る印を外す（前後の空白も整える） */
export const stripSilentMark = (text) => String(text ?? '').replace(MARK_RE, '').replace(/[ \t]+\n/g, '\n').trim();

/** 本文が、黙ったことを表すだけか（空・印だけ・括弧だけの短い一言・記号だけ）。保守的に判定する */
export function isSilentReply(text) {
  const body = stripSilentMark(text);
  if (!body) return true;
  if (ONLY_MARKS.test(body)) return true;
  if (/[\r\n]/.test(body) || /https?:\/\/|@|`/.test(body)) return false;
  const chars = [...body];
  const close = PAIRS.get(chars[0]);
  if (!close || chars.at(-1) !== close) return false;
  const inner = chars.slice(1, -1).join('').trim();
  // 括弧の中にさらに閉じ括弧がある（「(a) と (b)」のように括弧の外に字がある）なら数えない
  if (!inner || [...inner].some((c) => CLOSE.includes(c) || OPEN.includes(c))) return false;
  return [...inner].length <= SILENT_MAX_CHARS;
}

/** ターンで書いた文章の並び（parts）から、印を外し、印だけの部分を落とす */
export const speakingParts = (parts) => parts.map(stripSilentMark).filter((part) => part);
