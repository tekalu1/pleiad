// 投稿の本文の @ の解析（core/channels/mentions.mjs）: 名前の突き合わせ（NFKC・大小）・境界（空白・記号・日本語）・コードと引用の中・@あなた・長い名前を先に
import { parseMentions, maskNonMentionable } from '../../core/channels/mentions.mjs';

export const name = 'channels-mentions';
export const title = '@ の解析: 名前の突き合わせ・境界・コードと引用の中は数えない・@あなた・重なる名前';

const BOTS = [
  { id: 'b_owl', name: 'Owl' },
  { id: 'b_lynx', name: 'Lynx' },
  { id: 'b_owl2', name: 'Owl-2' },
  { id: 'b_ja', name: 'ふくろう' },
  { id: 'b_two', name: 'Code Review' },
];
const ids = (text, bots = BOTS) => parseMentions(text, bots).mentions.join(',');

export default async function (t) {
  t.ok('基本: 行頭・文中の @名前 を botId に解く', ids('@Owl やって') === 'b_owl' && ids('お願い @Lynx') === 'b_lynx');
  t.ok('出てきた順・重複なし', ids('@Lynx と @Owl、もう一度 @Lynx') === 'b_lynx,b_owl');
  t.ok('大文字小文字を区別しない', ids('@owl') === 'b_owl' && ids('@LYNX') === 'b_lynx');
  t.ok('全角（NFKC）: ＠Ｏｗｌ も同じ名前', ids('＠Ｏｗｌ お願い') === 'b_owl');
  t.ok('日本語の名前', ids('@ふくろう 見て') === 'b_ja' && ids('こんにちは@ふくろう') === 'b_ja');
  t.ok('空白を含む名前', ids('@Code Review お願い') === 'b_two');

  // 境界
  t.ok('名前の後ろは行末・空白・句読点（日本語の句読点も）', ids('@Owl') === 'b_owl' && ids('@Owl、見て') === 'b_owl' && ids('@Owl。') === 'b_owl' && ids('@Owl: やって') === 'b_owl' && ids('@Owl\nやって') === 'b_owl');
  t.ok('名前の直後に文字が続くときは数えない（@Owlやって・@Owlet）', ids('@Owlやって') === '' && ids('@Owlet') === '');
  t.ok('_ と - は名前の続き（@Owl_2 は Owl ではない）。長い名前を先に見る（Owl-2 と Owl）', ids('@Owl_2') === '' && ids('@Owl-2 お願い') === 'b_owl2' && ids('@Owl お願い') === 'b_owl');
  t.ok('メールの形（直前が英数字）は数えない', ids('a@Owl.example') === '' && ids('x_@Lynx') === '');
  t.ok('空の @・知らない名前は数えない', ids('@ やって') === '' && ids('@Nobody') === '' && ids('') === '' && ids(null) === '');
  t.ok('bot が無くても落ちない', ids('@Owl', []) === '' && parseMentions('@Owl', undefined).mentions.length === 0);

  // コード・引用
  t.ok('インラインのコードの中は数えない', ids('`@Owl` ではなく @Lynx') === 'b_lynx' && ids('``@Owl`` と @Lynx') === 'b_lynx');
  t.ok('フェンスの中は数えない（閉じていなければ末尾まで）', ids('前\n```js\n@Owl\n```\n後 @Lynx') === 'b_lynx' && ids('前 @Lynx\n```\n@Owl\n続き') === 'b_lynx');
  t.ok('~~~ のフェンスも、別の印では閉じない', ids('~~~\n@Owl\n```\n@Owl\n~~~\n@Lynx') === 'b_lynx');
  t.ok('引用行（> ）の中は数えない。引用の外は数える', ids('> @Owl が言った\n@Lynx お願い') === 'b_lynx');
  t.ok('同じ長さを保って伏せる（位置が変わらない）', (() => { const s = '前 `@Owl` 後\n> 引用 @Lynx\nx'; return maskNonMentionable(s).length === s.length && !/@/.test(maskNonMentionable(s)); })());

  // 括弧の中（ADR 0117）
  t.ok('括弧・引用符（（）()「」『』【】“”"…"）の中は数えない。括弧の外は数える', ['(@Owl)', '（@Owl に聞いた）', '「@Owl」', '『@Owl』', '【@Owl】', '“@Owl”', '"@Owl"'].every((x) => ids(x) === '')
    && ids('(@Owl) と @Lynx') === 'b_lynx');
  t.ok('閉じない括弧は伏せない（行をまたがない）', ids('(@Owl に聞いて') === 'b_owl' && ids('(前の行\n@Owl)') === 'b_owl');
  t.ok('人の全角の ＠ は今までどおり数える', ids('＠Owl お願い') === 'b_owl' && ids('お願い ＠Lynx') === 'b_lynx');

  // bot の投稿（strict。ADR 0117）: bot を呼ぶのは行頭の半角の @名前 だけ
  const sids = (text) => parseMentions(text, BOTS, { strict: true }).mentions.join(',');
  t.ok('strict: 行頭の半角 @名前 は数える（行頭に並べたものも・2 行目の行頭も・前の空白も）', sids('@Owl やって') === 'b_owl' && sids('@Owl @Lynx 見て') === 'b_owl,b_lynx'
    && sids('結果です。\n@Lynx 続きを') === 'b_lynx' && sids('  @Owl') === 'b_owl');
  t.ok('strict: 文中・全角の ＠・括弧・コード・引用の中は数えない', sids('#test に返事しました。＠マイケル も見て') === '' && sids('お願い @Lynx') === '' && sids('＠Owl やって') === ''
    && sids('(@Owl)') === '' && sids('`@Owl`') === '' && sids('> @Owl') === '' && sids('@Owl と @Lynx') === 'b_owl');
  t.ok('strict: @あなた は文中でも人への呼びかけ', parseMentions('終わりました @あなた', BOTS, { strict: true }).you === true);

  // @あなた
  const you = parseMentions('@あなた 確認を お願いします。@Owl も', BOTS);
  t.ok('@あなた・@you は人への呼びかけ（\'you\'）', you.you === true && you.mentions.join(',') === 'you,b_owl' && you.botIds.join(',') === 'b_owl');
  t.ok('@you は大文字小文字を区別しない・bot の名前より先', parseMentions('@YOU', BOTS).you === true && parseMentions('@you', [{ id: 'b_you', name: 'you' }]).botIds.length === 0);
  t.ok('@あなた でない文には you が付かない', parseMentions('@Owl のみ', BOTS).you === false);
}
