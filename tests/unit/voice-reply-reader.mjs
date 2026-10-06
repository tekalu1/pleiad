// 読み上げる文の切り出し（core/voice/reply-reader.mjs）: エージェントの返事（text.delta の差分）から、読む文だけを、閉じた順に出す。
import { cleanSentence, createReplyReader, sentencesOf, TURN_MAX_CHARS } from '../../core/voice/reply-reader.mjs';

export const name = 'voice-reply-reader';
export const title = '通話の読み上げ: 文の切れ目・1 文目は読点で早く・コード/表/ログは読まず言い添える・記法を外す・1 ターンの上限・差分の入れ方によらない';

const PHRASES = { code: 'コードは画面に出しました', table: '表は画面に出しました', log: 'ログは画面に出しました' };
const texts = (list) => list.map((s) => s.text);

/** 差分を n 字ずつ入れて、出た文を返す */
function streamed(text, step, { turnMaxChars } = {}) {
  const out = [];
  const reader = createReplyReader({ say: (s, info) => out.push({ text: s, ...info }), phrases: PHRASES, ...(turnMaxChars ? { turnMaxChars } : {}) });
  for (let i = 0; i < text.length; i += step) reader.push(text.slice(i, i + step));
  reader.end();
  return out;
}

export default async function (t) {
  const reply = '署名の鍵は、リポジトリの Secrets にある SIGNING_KEY です。新しい鍵に差し替えて、release ジョブをもう一度実行してください。';
  const plain = sentencesOf(reply, PHRASES);
  t.ok('文の切れ目: 。で閉じる。1 文目の読点が 8 字に届かないうちは切らない（短い断片を頼まない）', JSON.stringify(texts(plain)) === JSON.stringify([
    '署名の鍵は、リポジトリの Secrets にある SIGNING_KEY です。', '新しい鍵に差し替えて、release ジョブをもう一度実行してください。']) && plain[0].first === true && plain[1].first === false, JSON.stringify(texts(plain)));
  t.ok('1 文目だけは、読点が 8 字を超えていれば読点で早く出す（2 文目からは文ごと）', JSON.stringify(texts(sentencesOf('リポジトリの設定画面で、鍵を確認します。次に、実行します。', PHRASES))) === JSON.stringify(['リポジトリの設定画面で、', '鍵を確認します。', '次に、実行します。']));
  t.ok('1 文目を読点で切るのは、8 字に届いてから（短い断片を頼まない）', texts(sentencesOf('はい、わかりました。', PHRASES)).join('|') === 'はい、わかりました。');
  t.ok('差分の入れ方によらない（1 字ずつ・3 字ずつ・まとめて同じ文が出る）', [1, 3, 7].every((n) => JSON.stringify(texts(streamed(reply, n))) === JSON.stringify(texts(plain))));

  // 1 文目が閉じた時点で出る（返事の全体を待たない）
  {
    const seen = [];
    const reader = createReplyReader({ say: (s) => seen.push(s), phrases: PHRASES });
    reader.push('リポジトリの設定画面で、鍵を確認');
    t.ok('1 文目が閉じた時点（読点）ですぐ出る。続きの文字を待たない', seen.length === 1 && seen[0] === 'リポジトリの設定画面で、');
    reader.push('します。次');
    t.ok('2 文目は。が来た時点で出る（次の文の書き出しは持ち越す）', seen.length === 2 && seen[1] === '鍵を確認します。');
    reader.push('の文');
    reader.end();
    t.ok('text.end で残りを読む', seen.length === 3 && seen[2] === '次の文');
  }

  t.ok('英語: . ! ? のあとに空白か改行が来たら文の終わり。小数点・拡張子では切らない', JSON.stringify(texts(sentencesOf('Version 3.14 is out. Read notes.md first! Done?', PHRASES))) === JSON.stringify(['Version 3.14 is out.', 'Read notes.md first!', 'Done?']));
  t.ok('改行は文の切れ目（段落・箇条書きの 1 項目ずつ）。箇条書きの印・見出しの # ・引用の > は外す', JSON.stringify(texts(sentencesOf('# 手順\n- 鍵を作る\n- 登録する\n1. 実行する\n> 注意してください', PHRASES))) === JSON.stringify(['手順', '鍵を作る', '登録する', '実行する', '注意してください']));
  t.ok('長い文は 80 字に届いたら直近の読点か空白で切る（無ければその場で）', (() => {
    const long = `${'あ'.repeat(40)}、${'い'.repeat(60)}`;
    const out = texts(sentencesOf(long, PHRASES));
    return out.length === 2 && out[0].length <= 80 && out.join('').replace(/、/g, '') === long.replace(/、/g, '');
  })());

  // コード・表・ログは読まず、ブロックの終わりに 1 回だけ言い添える
  {
    const body = '次のコマンドで登録します。\n\n```bash\ngh secret set SIGNING_KEY < key.pem\ngh secret list\n```\n\n終わったら実行し直してください。';
    const out = sentencesOf(body, PHRASES);
    t.ok('コードのブロックは読まず、本文だけを読み、最後に「コードは画面に出しました」と短く言い添える', JSON.stringify(texts(out)) === JSON.stringify(['次のコマンドで登録します。', '終わったら実行し直してください。', PHRASES.code])
      && out.at(-1).skip === 'code', JSON.stringify(texts(out)));
    t.ok('コードのブロックの中の文字は 1 字も出ない（差分 1 字ずつでも）', streamed(body, 1).every((s) => !/gh secret|key\.pem/.test(s.text)));
    t.ok('~~~ のフェンスも同じ・閉じる前に text.end が来ても読まない', texts(sentencesOf('先に説明です。\n~~~\nrm -rf x', PHRASES)).join('|') === `先に説明です。|${PHRASES.code}`);
    const table = sentencesOf('結果です。\n| 名前 | 値 |\n|---|---|\n| a | 1 |\n以上です。', PHRASES);
    t.ok('表（| で始まる行）は読まず、「表は画面に出しました」と言い添える', JSON.stringify(texts(table)) === JSON.stringify(['結果です。', '以上です。', PHRASES.table]));
    const logText = sentencesOf('実行しました。\n2026-10-06 12:00:01 INFO start\n2026-10-06 12:00:02 INFO done\n$ npm test\nat Object.run (file.js:1:1)\n完了です。', PHRASES);
    t.ok('作業ログ（日時・$ ・at ・diff の行頭）は読まず、「ログは画面に出しました」と言い添える', JSON.stringify(texts(logText)) === JSON.stringify(['実行しました。', '完了です。', PHRASES.log]), JSON.stringify(texts(logText)));
    t.ok('字下げ 4 字のコードは読まない。字下げした箇条書きの入れ子は読む', JSON.stringify(texts(sentencesOf('例です。\n    const a = 1;\n    return a;\n- 親\n    - 子', PHRASES))) === JSON.stringify(['例です。', '親', '子', PHRASES.code]));
    // 言い添えは種類ごとに 1 ターンに 1 回。ブロックをまたいでも繰り返さない。reset（新しい発言）で数え直す
    const out2 = [];
    const reader = createReplyReader({ say: (s, info) => out2.push({ text: s, ...info }), phrases: PHRASES });
    reader.push('一つ目。\n```\nx\n```\n'); reader.end();
    reader.push('二つ目。\n```\ny\n```\n'); reader.end();
    t.ok('言い添えは同じ種類を 1 ターンに 1 回だけ（ブロックをまたいでも繰り返さない）', out2.filter((s) => s.skip === 'code').length === 1, JSON.stringify(texts(out2)));
    reader.reset();
    reader.push('三つ目。\n```\nz\n```\n'); reader.end();
    t.ok('新しい発言（reset）のあとは、また言い添える', out2.filter((s) => s.skip === 'code').length === 2);
  }

  // 記法を外す
  t.ok('記法: **強調**・`短いコード`・[文字](URL)・URL・画像・HTML・絵文字を外して読む', cleanSentence('**重要**です。[手順書](https://example.com/a)を見て `npm test` を ![図](x.png) <b>実行</b> https://x.example/y 🙂') === '重要です。手順書を見て npm test を 実行');
  t.ok('記法: 30 字を超えるインラインコードは読まない', cleanSentence('これは `' + 'a'.repeat(31) + '` です') === 'これは です');
  t.ok('記法: 読む字が無い文（記号・絵文字だけ）は出ない', cleanSentence('---') === '' && cleanSentence('🙂🙂') === '' && texts(sentencesOf('---\n🙂', PHRASES)).length === 0);

  // 1 ターンの上限
  {
    const many = `${'これは長い返事の一文です。'.repeat(200)}`;
    const out = texts(streamed(many, 40, { turnMaxChars: TURN_MAX_CHARS }));
    t.ok(`1 ターンに読む量には上限（${TURN_MAX_CHARS} 字）がある。超えた文は読まない`, out.join('').length <= TURN_MAX_CHARS && out.length > 3, String(out.join('').length));
    const small = texts(streamed(many, 40, { turnMaxChars: 100 }));
    t.ok('上限は設定できる（小さくすると早く止まる）', small.join('').length <= 100 && small.length >= 1);
  }
  t.ok('reset: 読みかけの文は捨てる', (() => {
    const seen = [];
    const reader = createReplyReader({ say: (s) => seen.push(s), phrases: PHRASES });
    reader.push('途中まで');
    reader.reset();
    reader.push('新しい返事です。');
    reader.end();
    return seen.join('|') === '新しい返事です。';
  })());
}
