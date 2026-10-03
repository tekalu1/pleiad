// 投稿の本文の明示的な @ の解析（ADR 0109。S1）。投稿の時点で botId に解き、Post.mentions に保存する（あとで名前が変わっても壊れない）。
// 暗黙の宛先（DM・スレッドで作業中の bot）は ここでは扱わない（S4 の dispatch が決める）。
//
//   parseMentions(text, bots, { strict }?) → { mentions: string[], botIds: string[], you: boolean }
//     bots … [{ id, name }]。名前は NFKC・大小を区別しない（チャンネルを通して一意。重複は bots.create / update が断る）
//     mentions … 出てきた順の botId と 'you' / 'here' / 'everyone'（重複なし）。botIds … そのうち botId だけ。you … `@あなた` / `@you`
//     strict … bot の投稿（ADR 0117）。bot を呼ぶのは行頭の半角の `@名前` だけ（行頭の `@A @B` のように続けて並べたものは数える）。
//              文中・全角の `＠` の bot の名前は数えない（bot が報告の文の中で名前を出しただけで起こし合わないため）。`@here` / `@everyone` は常に数えない。`@あなた` は今までどおり
//
// 規則:
//   - `@` の直前が英数字・`_` のときは数えない（`a@owl.com` のようなメールの形）。日本語の直後（`お願い@Owl`）は数える
//   - 名前の直後は行末・空白・記号のいずれか（`@Owlやって` は数えない）。`_` と `-` は名前の続きとして扱う（`@Owl_2`）
//   - 名前が前方で重なるとき（Owl と Owl-2）は長い方を先に見る
//   - コードの区間（フェンス・インラインの `…`）と引用行（`> `）と括弧（（）()「」『』【】“”"…"。同じ行の中で閉じるもの）の中は数えない
//   - 人の全角の `＠名前` は `@名前` と同じ（NFKC で畳む。日本語の入力で `＠` になるため）
//   - `@あなた` / `@you` は人への呼びかけで、bot の名前より先に見る（bot にこの名前は付けられない）
import { ATTACHMENT_LINE } from '../../web/timeline.mjs';

const YOU_NAMES = ['あなた', 'you']; // i18n-ignore: 本文の @あなた は記号としての綴り（表示する文ではない）
export const YOU = 'you';
export const HERE = 'here';
export const EVERYONE = 'everyone';

const fold = (s) => String(s ?? '').normalize('NFKC').toLowerCase();
// 名前の直後に来てよい文字: 行末・空白・記号（`_` と `-` は名前の続きなので除く）
const isBoundaryAfter = (ch) => ch === undefined || (!/[_-]/.test(ch) && /[\s\p{P}\p{S}]/u.test(ch));

/** コード・引用の中を同じ長さの空白にする（位置は変えない） */
export function maskNonMentionable(text) {
  const blank = (m) => m.replace(/[^\n]/g, ' ');
  // フェンス（``` と ~~~。同じ印で閉じる。閉じていなければ末尾まで）と引用行を、行ごとに見る
  let fence = null;
  const lines = String(text ?? '').split('\n').map((line) => {
    const mark = /^[ \t]*(```+|~~~+)/.exec(line)?.[1];
    if (fence) { if (mark && mark[0] === fence[0] && mark.length >= fence.length) fence = null; return blank(line); }
    if (mark) { fence = mark; return blank(line); }
    // 引用行と、添付の印の行（`[添付] パス`。パスに `@` があっても呼びかけではない）
    return /^[ \t]*>/.test(line) || ATTACHMENT_LINE.test(line.trim()) ? blank(line) : line;
  });
  // インラインのコード（同じ数のバッククォートで挟んだもの）と、同じ行の中で閉じる括弧・引用符（ADR 0117。「（@Owl に聞いた）」は呼びかけではない）
  return lines.join('\n').replace(/(`+)(?:(?!\1)[\s\S])+?\1/g, blank).replace(BRACKETS, blank);
}
// 括弧の対（入れ子は外側だけ見る。開いたまま閉じない括弧は消さない）
const BRACKETS = /（[^（）\n]*）|\([^()\n]*\)|「[^「」\n]*」|『[^『』\n]*』|【[^【】\n]*】|“[^“”\n]*”|"[^"\n]*"/g;

export function parseMentions(text, bots = [], { strict = false } = {}) {
  const masked = maskNonMentionable(text);
  // NFKC で長さが変わる文字（全角の @ など）があるので、位置を揃えるために 1 文字ずつ畳む
  const chars = Array.from(masked);
  const folded = chars.map((c) => fold(c)); // 1 文字が複数文字になることもある（NFKC）
  const candidates = [
    ...YOU_NAMES.map((n) => ({ key: YOU, name: fold(n) })),
    { key: HERE, name: HERE }, { key: EVERYONE, name: EVERYONE },
    ...bots.filter((b) => b?.id && b?.name).map((b) => ({ key: b.id, name: fold(b.name).trim() })).filter((c) => c.name),
  ].sort((a, b) => b.name.length - a.name.length);

  const found = [];
  // 行頭か（行の始めから空白と呼びかけだけが続いている）。strict の bot の呼びかけはここだけ
  let head = true;
  for (let i = 0; i < chars.length; i++) {
    if (chars[i] === '\n') { head = true; continue; }
    if (folded[i] !== '@') { if (!/\s/.test(chars[i])) head = false; continue; }
    const atHead = head;
    head = false;
    const before = i > 0 ? folded[i - 1].slice(-1) : undefined;
    if (before !== undefined && /[a-z0-9_]/.test(before)) continue;
    // i の後ろを畳んだ文字列にして、候補の名前を前方一致で当てる
    let rest = '';
    const ends = []; // rest の各位置が chars のどこまでに当たるか
    for (let j = i + 1; j < chars.length && rest.length < 200; j++) { rest += folded[j]; ends.push(...Array(folded[j].length).fill(j)); }
    for (const c of candidates) {
      if (!rest.startsWith(c.name)) continue;
      const lastIdx = ends[c.name.length - 1];
      const after = lastIdx + 1 < chars.length ? folded[lastIdx + 1][0] : undefined;
      if (!isBoundaryAfter(after)) continue;
      // bot の投稿の bot への呼びかけは、行頭の半角の @ だけ（全角の ＠・文中は数えないが、名前の分は読み飛ばす）
      const counts = !strict || c.key === YOU || (![HERE, EVERYONE].includes(c.key) && atHead && chars[i] === '@');
      if (counts) found.push(c.key);
      head = atHead && counts;
      i = lastIdx;
      break;
    }
  }
  const mentions = [...new Set(found)];
  return { mentions, botIds: mentions.filter((m) => ![YOU, HERE, EVERYONE].includes(m)), you: mentions.includes(YOU) };
}
