// 通知の一覧の画面（web/notification-inbox.mjs）の、DOM を持たない部分: 通知 1 件の文（種類・名前・題・場所・決着）とベルの印・名前。
// 描画・キー・飛ぶ・強調は tests/browser/notification-inbox.cjs。辞書は日本語と英語の両方で、組み立てたキーがどれも訳されていることを見る。
import { t, setLanguage } from '../../web/i18n.mjs';
import { describeNotification, badgeState } from '../../web/notification-inbox.mjs';

export const name = 'notification-inbox-ui';
export const title = '通知の一覧の画面: 通知の文（あなた待ち・失敗・完了・@あなた）・場所・決着・ベルの印と名前（日本語・英語）';

export default async function (tt) {
  const before = (await import('../../web/i18n.mjs')).lang;
  try {
    await setLanguage('ja');
    const wait = { id: 'n1', kind: 'wait', ask: 'approval', actor: { kind: 'bot', name: 'Owl' }, at: 1, unread: true, target: { sessionId: 's1' }, title: '依存の更新' };
    let d = describeNotification(wait, t);
    tt.ok('あなた待ち（bot）: 「Owl が承認を待っています」・◆・場所は 一時チャット › 会話の題', d.line === 'Owl が承認を待っています' && d.icon === 'wait' && d.place === '一時チャット › 依存の更新' && d.open === true && d.outcome === '');
    d = describeNotification({ ...wait, actor: undefined }, t);
    tt.ok('あなた待ち（bot でない）は「エージェントが承認を待っています」', d.line === 'エージェントが承認を待っています');
    d = describeNotification({ ...wait, ask: 'question' }, t);
    tt.ok('質問は「…が質問への答えを待っています」', d.line === 'Owl が質問への答えを待っています');
    d = describeNotification({ ...wait, resolvedAt: 5, outcome: 'allowed', unread: false }, t);
    tt.ok('決着したあなた待ちは過去形・◇・「承認済み」（弱く出す）', d.line === 'Owl が承認を待っていました' && d.icon === 'closed' && d.outcome === '承認済み' && d.open === false);
    tt.ok('決着の言葉: 回答済み・却下・取り消し', ['answered', 'denied', 'cancelled'].map((o) => describeNotification({ ...wait, resolvedAt: 5, outcome: o }, t).outcome).join() === '回答済み,却下,取り消し');
    d = describeNotification({ id: 'n2', kind: 'failed', actor: { kind: 'bot', name: 'Kit' }, at: 1, unread: true, target: { channelId: 'c1', threadId: 't1' }, channelName: 'design', threadTitle: 'ヘッダーの余白を揃える' }, t);
    tt.ok('bot の失敗は「Kit のターンが失敗しました」・✕・場所は #チャンネル › スレッドの題', d.line === 'Kit のターンが失敗しました' && d.icon === 'failed' && d.place === '#design › ヘッダーの余白を揃える');
    d = describeNotification({ id: 'n3', kind: 'done', at: 1, unread: false, target: { sessionId: 's2' }, title: '控えの題' }, t, (id) => (id === 's2' ? 'いまの題' : ''));
    tt.ok('完了は「<会話の題> が完了しました」。題は今の会話の題を先に使い（改名に追従）、無ければ控えの題', d.line === 'いまの題 が完了しました' && d.icon === 'done' && d.place === '一時チャット › いまの題'
      && describeNotification({ id: 'n3', kind: 'done', at: 1, unread: false, target: { sessionId: 's2' }, title: '控えの題' }, t).line === '控えの題 が完了しました');
    d = describeNotification({ id: 'n4', kind: 'done', at: 1, unread: false, target: { sessionId: 's2' } }, t);
    tt.ok('題が無い会話は「会話が完了しました」・場所は無題の名前', d.line === '会話が完了しました' && d.place === '一時チャット › 新しいセッション');
    d = describeNotification({ id: 'n5', kind: 'mention', actor: { kind: 'bot', name: 'Lynx' }, at: 1, unread: true, target: { channelId: 'c1', threadId: 't1', postId: 'p1' }, channelName: 'release-ci' }, t);
    tt.ok('@あなた は「Lynx が @あなた と書きました」・@・スレッドの題が無ければ #チャンネルだけ', d.line === 'Lynx が @あなた と書きました' && d.icon === 'mention' && d.place === '#release-ci');
    tt.ok('書いた人の名前が無い @あなた は「@あなた 宛ての投稿があります」', describeNotification({ id: 'n6', kind: 'mention', at: 1, unread: true, target: { channelId: 'c1' } }, t).line === '@あなた 宛ての投稿があります');

    let b = badgeState({ unread: 0, waiting: 0 }, t);
    tt.ok('未読が無ければ印なし・名前は「通知」', b.show === false && b.label === '通知' && b.text === '');
    b = badgeState({ unread: 3, waiting: 0 }, t);
    tt.ok('未読があれば件数・名前に件数', b.show && b.text === '3' && b.wait === false && b.label === '通知（未読 3 件）');
    b = badgeState({ unread: 4, waiting: 2 }, t);
    tt.ok('未読のあなた待ちがあれば ◆ を優先し、名前にも「あなた待ちあり」', b.wait === true && b.text === '4' && b.label === '通知（未読 4 件・あなた待ちあり）');
    tt.ok('件数は 99+ で頭打ち', badgeState({ unread: 250, waiting: 0 }, t).text === '99+');

    await setLanguage('en');
    d = describeNotification(wait, t);
    tt.ok('英語: あなた待ち・決着・ベルの名前', d.line === 'Owl is waiting for your approval' && describeNotification({ ...wait, resolvedAt: 5, outcome: 'allowed' }, t).outcome === 'Approved'
      && badgeState({ unread: 2, waiting: 1 }, t).label === 'Notifications (2 unread, waiting for you)');
    tt.ok('英語: 失敗・完了・@you', describeNotification({ id: 'x', kind: 'failed', actor: { name: 'Kit' }, at: 1, unread: true, target: {} }, t).line === "Kit's turn failed"
      && describeNotification({ id: 'x', kind: 'done', at: 1, unread: true, target: { sessionId: 's' }, title: 'Fix login' }, t).line === 'Fix login finished'
      && describeNotification({ id: 'x', kind: 'mention', actor: { name: 'Lynx' }, at: 1, unread: true, target: { channelId: 'c' } }, t).line === 'Lynx wrote @you');
  } finally { await setLanguage(before); }
}
