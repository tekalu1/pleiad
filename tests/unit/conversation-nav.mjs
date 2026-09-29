// 会話の移動（web/conversation-nav.mjs）: 発言の抜粋（畳み方・コード・添付）と件数の札。
import assert from 'node:assert/strict';
import { userPieces, piecesText, summaryOf, badge } from '../../web/conversation-nav.mjs';
import { turnKinds } from '../../web/conversation-rail.mjs';

export const name = 'conversation-nav';
export const title = '会話の移動: 発言の抜粋（改行と空白の畳み・‹コード›・添付の行）・件数の札・地図の点の種類';

export default async function (t) {
  // ---- 抜粋: 改行と連続する空白は 1 つの空白にする
  assert.equal(summaryOf('a\n\n  b   c\r\nd'), 'a b c d');
  assert.equal(summaryOf('   前後の空白は落とす  '), '前後の空白は落とす');
  assert.equal(summaryOf(''), '');
  assert.equal(summaryOf(null), '');
  t.ok('改行と連続する空白を 1 つの空白に畳む', true);

  // ---- コードブロックは「‹コード›」
  const code = ['この書き方だと消える。', '', '```js', 'const a = 1;', '  a += 2;', '```', '', 'blur が来ないのかも。'].join('\n');
  assert.deepEqual(userPieces(code), [{ text: 'この書き方だと消える。' }, { token: '‹コード›' }, { text: 'blur が来ないのかも。' }]);
  assert.equal(summaryOf(code), 'この書き方だと消える。 ‹コード› blur が来ないのかも。');
  assert.equal(summaryOf('```\nonly code\n```'), '‹コード›', 'コードだけの発言');
  assert.equal(summaryOf('```a```と```b```'), '‹コード› と ‹コード›', '複数のコード');
  t.ok('コードブロックは ‹コード› に置き換える（中身は出さない）', true);

  // ---- 添付の行は本文の後ろに「添付 ファイル名」
  const attach = ['ログと画面を付けた。', '[添付] D:\\work\\logs\\auth-error.log', '[添付] D:/work/shots/login-expired.png', '確認して。'].join('\n');
  assert.deepEqual(userPieces(attach), [
    { text: 'ログと画面を付けた。 確認して。' },
    { token: '添付', text: 'auth-error.log' },
    { token: '添付', text: 'login-expired.png' },
  ]);
  assert.equal(summaryOf(attach), 'ログと画面を付けた。 確認して。 添付 auth-error.log 添付 login-expired.png');
  assert.equal(summaryOf('[Attachment] /tmp/a b.txt'), '添付 a b.txt', '英語の印もファイル名だけにする');
  assert.equal(summaryOf('本文に [添付] と書いただけ'), '本文に [添付] と書いただけ', '行の頭でない印は本文のまま');
  t.ok('添付の行は本文の後ろへ回し、ファイル名だけにする（区切りは / と \\）', true);

  // ---- 全文は畳んだままクリップしない（title・読み上げ名用）
  const long = 'あ'.repeat(500);
  assert.equal(summaryOf(long).length, 500);
  assert.equal(piecesText([{ token: '添付', text: 'x' }, { text: 'y' }]), '添付 x y');
  t.ok('抜粋の全文はクリップしない', true);

  // ---- 件数の札
  assert.deepEqual([0, 1, 18, 99, 100, 131, 5000].map(badge), ['0', '1', '18', '99', '99+', '99+', '99+']);
  t.ok('件数の札は 100 以上で 99+', true);

  // ---- 地図の点の種類: 筋の並びを 1 度走査し、発言の後ろに並ぶ出来事を直前の発言のターンに数える
  const node = (kind, children = []) => {
    const n = { kind, children, parentElement: null };
    for (const c of children) c.parentElement = n;
    return n;
  };
  const rows = ['user', 'answer', 'user', 'compact', 'user', 'branch', 'user', 'card', 'user', 'card-done', 'user', 'viz', 'user', 'both'].map((k) => node(k));
  const expand = node('expand', []);
  rows[11].children.push(expand); expand.parentElement = rows[11];
  const expand2 = node('expand', []);
  rows[13].children.push(expand2); expand2.parentElement = rows[13];
  const thread = node('thread', rows);
  for (const r of rows) r.parentElement = thread;
  const pick = (kind) => rows.filter((r) => r.kind === kind);
  thread.querySelectorAll = (sel) => ({
    '.visualize-expand': [expand, expand2],
    ':scope > .branch-row': pick('branch'),
    ':scope > .mw.compaction-boundary': pick('compact'),
    ':scope > .mw.card:not(.done)': pick('card'),
  })[sel] ?? [];
  const turns = rows.filter((r) => r.kind === 'user').map((row) => ({ row }));
  // 圧縮は 1 番目の発言（rows[2]）の後ろではなく、その直前の発言（turn 1）のあと。分岐・承認・可視化も同じ
  assert.deepEqual(turnKinds(thread, turns), ['', 'compact', 'branch', 'pending', '', 'visual', 'visual'],
    '出来事は直前の発言のターンに付ける。決着した承認（done）は数えない');
  // 優先は 承認待ち > 圧縮 > 分岐 > 可視化
  thread.querySelectorAll = (sel) => ({ ':scope > .mw.card:not(.done)': [rows[3]], ':scope > .mw.compaction-boundary': [rows[3]], ':scope > .branch-row': [rows[3]], '.visualize-expand': [] })[sel] ?? [];
  assert.equal(turnKinds(thread, turns)[1], 'pending', '同じターンに複数あれば承認待ちを出す');
  thread.querySelectorAll = () => [];
  assert.deepEqual(turnKinds(thread, turns), turns.map(() => ''), '何も無ければ空');
  t.ok('地図の点の種類: 直前の発言のターンに数え、優先は 承認待ち > 圧縮 > 分岐 > 可視化', true);

}
