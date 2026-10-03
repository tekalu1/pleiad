// スレッドと空間モデル（W3）の、画面を持たない判定: 窓の状態（feed・split・solo）・スレッドの題とトークンの文言・道具の呼び出しを引く範囲・配線。
// 描画・動き・スクロールと下書きの保持・承認のカードは tests/browser/thread-deck.cjs（実ブラウザー）。
import { readFileSync } from 'node:fs';
import { deckState, SOLO_BELOW } from '../../web/channels/deck.mjs';
import { titleOf, tokensText } from '../../web/channels/thread.mjs';
import { turnWindows, callsInWindow, logInWindow, signatureOf } from '../../web/channels/thread-tools.mjs';

export const name = 'thread-deck';
export const title = 'スレッドと空間モデル: 窓の状態の判定（右パネル・幅）・題とトークンの文言・道具の呼び出しの範囲・配線';

const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');

export default function (t) {
  // ---- 窓の状態: スレッドが無ければ feed。右パネルが開いている・メインの幅が 900px 未満なら solo。そうでなければ split
  t.ok('スレッドを開いていなければ、幅や右パネルによらず feed（流れが全幅）', deckState({ hasThread: false, panelOpen: false, width: 1400 }) === 'feed'
    && deckState({ hasThread: false, panelOpen: true, width: 300 }) === 'feed');
  t.ok('右パネルが閉じていて幅が足りれば split（［流れ｜スレッド］）', deckState({ hasThread: true, panelOpen: false, width: 1000 }) === 'split'
    && deckState({ hasThread: true, panelOpen: false, width: SOLO_BELOW }) === 'split');
  t.ok('右パネルを開くと、幅が広くても solo（［スレッド｜道具］。流れは左へ抜ける）', deckState({ hasThread: true, panelOpen: true, width: 2000 }) === 'solo');
  t.ok('メインの幅が 900px 未満なら、右パネルが閉じていても solo（スレッドだけ全幅）', SOLO_BELOW === 900
    && deckState({ hasThread: true, panelOpen: false, width: 899 }) === 'solo' && deckState({ hasThread: true, panelOpen: false, width: 360 }) === 'solo');

  // ---- スレッドの題・トークンの数
  t.ok('題は根の投稿の最初の行。先頭の @ の呼びかけは外す', titleOf({ text: '@Owl v2.14.0 から p95 が上がってる\n詳しくは…' }) === 'v2.14.0 から p95 が上がってる'
    && titleOf({ text: '\n\n@Owl @Lynx 二人で見て' }) === '二人で見て');
  t.ok('@ だけの投稿は @ のまま（空にしない）・長い題は 120 字まで・投稿が無ければ空', titleOf({ text: '@Owl' }) === '@Owl'
    && titleOf({ text: 'あ'.repeat(300) }).length === 120 && titleOf(undefined) === '');
  t.ok('トークンは 1000 未満はそのまま、以上は k（小数 1 桁。100k からは整数）', tokensText(0) === '0' && tokensText(999) === '999' && tokensText(1200) === '1.2k'
    && tokensText(12345) === '12.3k' && tokensText(1000) === '1k' && tokensText(123456) === '123k' && tokensText(-5) === '0' && tokensText(undefined) === '0');

  // ---- 道具の呼び出しを引く範囲: 同じ会話の次のターンの投稿の at まで
  const turn = (id, sessionId, at, extra = {}) => ({ id, threadId: 'p_root', author: { kind: 'bot', botId: 'b_1' }, text: '…', at, turn: { botId: 'b_1', sessionId }, ...extra });
  const posts = [
    { id: 'p_root', threadId: null, author: { kind: 'human' }, text: '根', at: 1000 },
    turn('p_a1', 's1', 2000), turn('p_b1', 's2', 2500), turn('p_a2', 's1', 5000),
    turn('p_gone', 's1', 6000, { deletedAt: 6500 }),
    { id: 'p_h', threadId: 'p_root', author: { kind: 'human' }, text: '返信', at: 7000 },
  ];
  const w = turnWindows(posts);
  t.ok('ターンの投稿だけが窓を持つ（人の投稿・消した投稿は持たない）', [...w.keys()].sort().join() === 'p_a1,p_a2,p_b1');
  t.ok('同じ会話の次のターンの投稿の at まで。会話ごとに別々に数える（s2 の途中は s1 の窓を切らない）', w.get('p_a1').from === 2000 && w.get('p_a1').to === 5000
    && w.get('p_a2').to === Infinity && w.get('p_b1').to === Infinity && w.get('p_b1').sessionId === 's2');
  const call = (id, name, result) => ({ id, name, input: { x: id }, ...(result ? { result } : {}) });
  const msg = (at, calls, extra = {}) => ({ role: 'assistant', at, text: '', toolCalls: calls, ...extra });
  const history = [
    { role: 'user', at: new Date(1900).toISOString(), text: '前の発言' },
    msg(new Date(2100).toISOString(), [call('c1', 'Bash', { text: 'ok' })]),
    msg(new Date(2200).toISOString(), [call('c2', 'Read', { text: 'ok' })]),
    msg(new Date(4000).toISOString(), [], { text: '最初のターンの返事' }),
    msg(new Date(5100).toISOString(), [call('c3', 'Grep', { text: 'ok', isError: true }), call('c4', 'Edit')]),
  ];
  const first = callsInWindow(history, w.get('p_a1'));
  t.ok('最初のターンの窓: 窓の中の AI の発言の呼び出しだけ（次のターンのものを含めない）。ツールだけの発言は 1 つにまとまる', first.map((c) => c.id).join() === 'c1,c2');
  const second = callsInWindow(history, w.get('p_a2'));
  t.ok('次のターンの窓は、そのターンの呼び出しだけ（結果がまだ無い呼び出しも数える）', second.map((c) => c.id).join() === 'c3,c4');
  t.ok('時刻の無い仮の発言（走っているターン）は、いちばん後ろの窓にだけ入る', callsInWindow([{ role: 'assistant', text: '', toolCalls: [call('c9', 'Bash')] }], w.get('p_a2')).length === 1
    && callsInWindow([{ role: 'assistant', text: '', toolCalls: [call('c9', 'Bash')] }], w.get('p_a1')).length === 0);
  // ---- 作業ログ（ADR 0116）: 返事の本文以外の AI の文（独り言・終わりの報告）と道具の呼び出しを、発言の順に
  const logHistory = [
    msg(new Date(2100).toISOString(), [call('c1', 'list_ops')], { text: 'Server name is empty. Let me check the call_op schema.' }),
    msg(new Date(2200).toISOString(), [call('c2', 'call_op')]),
    msg(new Date(2300).toISOString(), [], { text: '#test のスレッドに返事を投稿しました。' }),
    msg(new Date(5100).toISOString(), [], { text: '次のターン' }),
  ];
  const log = logInWindow(logHistory, w.get('p_a1'), '返事の本文');
  t.ok('作業ログ: 窓の中の独り言・道具・終わりの報告を発言の順に。続く呼び出しは 1 つにまとめ、次のターンの発言は入れない', log.map((i) => (i.kind === 'text' ? `t:${i.text.split(' ')[0]}` : `c:${i.calls.map((c) => c.id).join('+')}`)).join('|') === 't:Server|c:c1+c2|t:#test'
    , JSON.stringify(log));
  const agyLog = logInWindow([msg(new Date(2100).toISOString(), [call('c1', 'call_op')], { text: '確かめます。いまは D:/dev で作業しています。' })], w.get('p_a1'), 'いまは D:/dev で作業しています。');
  t.ok('作業ログ: 発言の文が返事で終わる（Antigravity の形）なら、返事の前の部分だけを入れる。返事そのものの発言は入れない', agyLog[0].kind === 'text' && agyLog[0].text === '確かめます。' && agyLog[1].kind === 'calls'
    && logInWindow([msg(new Date(2100).toISOString(), [], { text: '返事の本文' })], w.get('p_a1'), '返事の本文').length === 0, JSON.stringify(agyLog));
  t.ok('呼び出しの印は、id と結果の有無・失敗で変わる（同じなら描き直さない）', signatureOf(second) === 'c3:e|c4:p' && signatureOf(first) === 'c1:r|c2:r'
    && signatureOf([call('c4', 'Edit', { text: 'ok' })]) !== signatureOf([call('c4', 'Edit')]));

  // ---- 配線
  const index = read('web/channels/index.mjs');
  t.ok('部品の一覧にスレッドが、流れの後ろに入っている（流れの板を窓へ移すため）', /createFeed\(host\)[\s\S]*createThread\(host\)/.test(index) && index.includes("from './thread.mjs'"));
  const client = read('web/client.mjs');
  t.ok('client.mjs の host は、質問のカードと内蔵ブラウザーの口を渡す（それ以外は足していない）', /browser: browserPanel/.test(client) && /ev\.kind === 'question' \? questionCard\(ev, into\)/.test(client));
  const thread = read('web/channels/thread.mjs');
  t.ok('承認のカードは host.permissionCard を通す（Chats と同じ部品。決着は resolvePermission）', thread.includes('host.permissionCard(ev, perms)') && !thread.includes("'resolvePermission'"));
  t.ok('止めるは channels.stopThread・返信は channels.post の threadId・読み込みは channels.read の threadId', thread.includes("'channels.stopThread'") && /channels\.post', \{ channelId: S\.channelId, threadId: S\.threadId/.test(thread)
    && thread.includes("'channels.read', { channelId, threadId"));
  const css = read('web/channels-thread.css');
  t.ok('動きは transform（deck.mjs）。CSS は 200ms の値だけを持ち、動きを減らす設定では 0', /--dur-deck:200ms/.test(css) && /prefers-reduced-motion:reduce\)\{\.deck\{--dur-deck:0ms\}/.test(css));
}
