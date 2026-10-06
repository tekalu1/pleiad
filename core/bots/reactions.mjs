// bot の投稿に付いたリアクションの読み方（S4。ADR 0136）。dispatch.onReacted が使う。SDK も DOM も import しない純粋な部品。
//
//   answerOf(emoji)   … 問いへの答えに当たるリアクションか: 'yes'（👍 ✅ 👌 など）・'no'（👎 ❌ 🙅 など）・null（それ以外。🎉 😂 👀 など）。
//                        肌の色・異体字の印・性別の ZWJ は外してから比べる（👍🏻 も 👍）
//   asksQuestion(text) … bot の投稿が問いかけか。コード・引用・URL を除いた本文に「?」「？」があるか、行が「〜ですか」「〜てよいか」などで終わる
//   excerpt(text, max) … 包みに入れる投稿の書き出し（1 行に畳んで max 文字まで）

const YES = new Set(['👍', '👌', '🆗', '✅', '✔', '☑', '⭕', '🙆', '💯']);
const NO = new Set(['👎', '❌', '❎', '✖', '🙅', '🚫', '⛔']);
// 肌の色（U+1F3FB〜1F3FF）・異体字の印（U+FE0F）・性別の ZWJ（‍♀ ‍♂）
const DECOR = /[\u{1F3FB}-\u{1F3FF}️]|‍[♀♂]/gu;

/** 問いへの答えに当たるリアクションなら 'yes' / 'no'。それ以外は null */
export function answerOf(emoji) {
  const base = String(emoji ?? '').replace(DECOR, '');
  return YES.has(base) ? 'yes' : NO.has(base) ? 'no' : null;
}

// 問いかけの印にしない部分: コードのかたまり・インラインのコード・引用の行・URL
const strip = (text) => String(text ?? '')
  .replace(/```[\s\S]*?(?:```|$)/g, ' ')
  .replace(/`[^`\n]*`/g, ' ')
  .replace(/^\s*>.*$/gm, ' ')
  .replace(/\bhttps?:\/\/\S+/g, ' ');
// 「?」のない日本語の問い（行末）
const ASK_END = /(?:ですか|ますか|でしょうか|ませんか|ましょうか|てよいか|ていいか|てもよいか|てもいいか|どうか|よろしいか)[。．.!！]*\s*$/m;

/** bot の投稿が問いかけか（保守的: 疑問符か、問いの言い回しで終わる行があるときだけ） */
export function asksQuestion(text) {
  const body = strip(text);
  return /[?？]/.test(body) || ASK_END.test(body);
}

/** 投稿の書き出し（改行を空白に畳む）。長ければ max 文字で切って … */
export function excerpt(text, max = 200) {
  const chars = [...String(text ?? '').replace(/\s+/g, ' ').trim()];
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : chars.join('');
}
