// いま見ている場所のアドレス（web/view-address.mjs）。通知の一覧・検索・脇の行が渡す行き先の形を 1 つにし、見ている場所を 1 つで残す。
import { toAddress, toShowDetail, storedAddress, sameAddress, readAddress, createViewAddress, HOME, VIEW_KEY } from '../../web/view-address.mjs';

export const name = 'view-address';
export const title = '見ている場所のアドレス: 通知・検索・channels:show の形をまとめる・残す・前の版の印を読む';

const memoryStorage = (init = {}) => {
  const m = new Map(Object.entries(init));
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), map: m };
};

export default async function (t) {
  // ---- 形をまとめる
  const j = (v) => JSON.stringify(v);
  t.ok('会話（通知の target）は一時チャットのスレッド。発言へ送るなら uuid', j(toAddress({ sessionId: 's1', uuid: 'u1' })) === j({ channelId: HOME, sessionId: 's1', uuid: 'u1' }));
  t.ok('通知の target のチャンネル・スレッド・投稿', j(toAddress({ channelId: 'c_1', threadId: 'p_0', postId: 'p_2' })) === j({ channelId: 'c_1', threadId: 'p_0', postId: 'p_2' }));
  t.ok('channels:show の detail（チャンネル・スレッド・投稿）', j(toAddress({ kind: 'channel', id: 'c_1', threadId: 'p_0', postId: 'p_2' })) === j({ channelId: 'c_1', threadId: 'p_0', postId: 'p_2' }));
  t.ok('channels:show の detail（bot のページ・ルーティン）', j(toAddress({ kind: 'bot', id: 'b_1' })) === j({ botId: 'b_1' }) && j(toAddress({ kind: 'routine', id: 'r_1' })) === j({ routineId: 'r_1' }));
  t.ok('わからない形・空は null', toAddress(null) === null && toAddress({}) === null && toAddress({ kind: 'channel' }) === null && toAddress('x') === null);
  t.ok('空の threadId・postId は持たない', j(toAddress({ channelId: 'c_1', threadId: null, postId: '' })) === j({ channelId: 'c_1' }));

  // ---- channels:show へ戻す
  t.ok('会話は channels:show にしない', toShowDetail(toAddress({ sessionId: 's1' })) === null);
  t.ok('スレッドの投稿は channels:show の detail に戻る', j(toShowDetail(toAddress({ channelId: 'c_1', threadId: 'p_0', postId: 'p_2' }))) === j({ kind: 'channel', id: 'c_1', threadId: 'p_0', postId: 'p_2' }));
  t.ok('bot・ルーティン', j(toShowDetail({ botId: 'b_1' })) === j({ kind: 'bot', id: 'b_1' }) && j(toShowDetail({ routineId: 'r_1' })) === j({ kind: 'routine', id: 'r_1' }));

  // ---- 残す形・同じ場所
  t.ok('残す形は送る先（uuid・postId）を持たない', j(storedAddress({ channelId: HOME, sessionId: 's1', uuid: 'u' })) === j({ channelId: HOME, sessionId: 's1' }));
  t.ok('同じ場所かは送る先を見ない', sameAddress({ channelId: 'c', threadId: 't', postId: 'p' }, { channelId: 'c', threadId: 't' }) && !sameAddress({ channelId: 'c' }, { channelId: 'c', threadId: 't' }));

  // ---- 読む
  t.ok('残したアドレスを読む', j(readAddress(memoryStorage({ [VIEW_KEY]: j({ channelId: 'c_1', threadId: 'p_0' }) }))) === j({ channelId: 'c_1', threadId: 'p_0' }));
  t.ok('無ければ前の版の「開いていた会話」から', j(readAddress(memoryStorage({ 'agent-host-current': 's9' }))) === j({ channelId: HOME, sessionId: 's9' }));
  t.ok('壊れていたら前の版の印へ・どちらも無ければ null', j(readAddress(memoryStorage({ [VIEW_KEY]: '{', 'agent-host-current': 's9' }))) === j({ channelId: HOME, sessionId: 's9' })
    && readAddress(memoryStorage()) === null);

  // ---- go と note
  const opened = [];
  const storage = memoryStorage();
  const view = createViewAddress({ storage, openSession: (a) => opened.push(['session', a]), openChannels: (d) => opened.push(['channels', d]) });
  view.go({ sessionId: 's1', uuid: 'u1' });
  view.go({ channelId: 'c_1', threadId: 'p_0', postId: 'p_2' });
  view.go({ kind: 'bot', id: 'b_1' });
  view.go({ nothing: true });
  t.ok('go: 会話は openSession（uuid つき）、それ以外は channels:show の detail で開く。わからない形は開かない',
    j(opened) === j([['session', { channelId: HOME, sessionId: 's1', uuid: 'u1' }], ['channels', { kind: 'channel', id: 'c_1', threadId: 'p_0', postId: 'p_2' }], ['channels', { kind: 'bot', id: 'b_1' }]]), j(opened));
  t.ok('go だけでは残さない（開いた側が note で知らせる）', storage.getItem(VIEW_KEY) === null);
  view.note({ kind: 'channel', id: 'c_1', threadId: 'p_0', postId: 'p_2' });
  t.ok('note: 見ている場所を残す（送る先は残さない）', storage.getItem(VIEW_KEY) === j({ channelId: 'c_1', threadId: 'p_0' }) && j(view.current) === j({ channelId: 'c_1', threadId: 'p_0' }));
  view.note({ sessionId: 's2' });
  t.ok('note: 会話へ移った', j(readAddress(storage)) === j({ channelId: HOME, sessionId: 's2' }));
}
