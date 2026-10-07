// 脇の Channels 側（web/channels/sidebar.mjs）の、DOM に触らない決まりごと。
// 並べ方・bot の状態・タブの点・検索の行の形。テストは tests/unit/channels-side-ui.mjs。
import { fold } from '../session-find.mjs';

/** 脇に出すチャンネル（DM は bot の行が受け持つので出さない）。アーカイブしたものは後ろに弱く。中は名前順 */
export function sideChannels(channels) {
  const byName = (a, b) => String(a.name ?? '').localeCompare(String(b.name ?? ''), undefined, { numeric: true, sensitivity: 'base' });
  return (channels ?? []).filter((c) => c && c.kind !== 'dm' && !c.home)   // 一時チャットは脇の先頭の節（web/side.mjs）
    .sort((a, b) => (Boolean(a.archivedAt) - Boolean(b.archivedAt)) || byName(a, b));
}

/**
 * bot の今の状態。一覧の会話（state.sessions の `bot.botId`）と、走っている・あなたを待っている会話の印から決める
 * （bots.list の state は読んだ時点の写しで、ターンの始まり・終わりでは botsChanged が来ないため）。
 * その bot の会話が一覧に 1 つも無ければ、bots.list の state を使う。
 * 作業中・あなた待ちでなく、使用量の上限で休んでいる（bots.list の restingUntil が先）なら 'resting'（ADR 0119）
 * @returns {'idle'|'working'|'waiting'|'resting'}
 */
export function botState(bot, { sessions = [], runningIds = new Set(), waitingIds = new Set(), now = Date.now() } = {}) {
  const mine = sessions.filter((s) => s?.bot?.botId === bot.id);
  const state = !mine.length ? (bot.state ?? 'idle')
    : mine.some((s) => waitingIds.has(s.id)) ? 'waiting'
    : mine.some((s) => runningIds.has(s.id)) ? 'working' : 'idle';
  return state === 'idle' && Number(bot.restingUntil) > now ? 'resting' : state;
}

/**
 * タブの札の点。見ていない側にだけ付ける。あなたを待っているもの（承認待ちの bot・あなた宛ての投稿）があれば 'mark'、
 * 未読だけなら 'unread'、どちらも無ければ null
 * @param {{ tab: 'chats'|'channels', channels: object[], botStates: string[], chats: { waiting: boolean, unread: boolean } }} o
 */
export function tabDots({ tab, channels = [], botStates = [], chats = {} }) {
  const live = channels.filter((c) => !c.archivedAt);
  const channelsDot = botStates.includes('waiting') || live.some((c) => (c.mentions ?? 0) > 0) ? 'mark'
    : live.some((c) => (c.unread ?? 0) > 0) ? 'unread' : null;
  const chatsDot = chats.waiting ? 'mark' : chats.unread ? 'unread' : null;
  return { chats: tab === 'chats' ? null : chatsDot, channels: tab === 'channels' ? null : channelsDot };
}

/** 検索語（web/session-find.mjs の parseTerms の形）がすべて名前に当たるか */
const nameHit = (name, terms) => {
  const original = String(name ?? '');
  const folded = fold(original);
  return terms.length > 0 && terms.every((t) => (t.exact ? original.includes(t.needle) : folded.includes(t.needle)));
};

/** 検索の結果の行（名前の一致）。web/side.mjs の connectChannels の行の形 */
export function channelNameRows(channels, terms) {
  return sideChannels(channels).filter((c) => nameHit(c.name, terms)).map((c) => ({
    id: `channel:${c.id}`, channelId: c.id, channelName: c.name, title: c.name, lastModified: c.lastPostAt ?? c.createdAt ?? 0,
  }));
}

/**
 * 検索の結果の行（投稿の本文。channels.search の hits）。誰の発言かは bot の名前・「あなた」など（who(author) が決める）
 * @param {{ channelId: string, channelName: string, postId: string, threadId: string|null, author: object, at: number, snippet: string }[]} hits
 */
export function postRows(hits, who = () => '') {
  return (hits ?? []).map((h) => ({
    id: `post:${h.channelId}:${h.postId}`, channelId: h.channelId, channelName: h.channelName, postId: h.postId,
    threadId: h.threadId ?? null, title: '', who: who(h.author) || '', snippet: String(h.snippet ?? ''), lastModified: h.at ?? 0,
  }));
}

/** 結果の行から開く先（channels:show の detail）。スレッドの中の投稿ならそのスレッドも開き、投稿の行なら着いたその投稿へ送って輪を付ける */
export function showDetail(row) {
  return { kind: 'channel', id: row.channelId, ...(row.threadId ? { threadId: row.threadId } : {}), ...(row.postId ? { postId: row.postId } : {}) };
}

/** 今開いている面（show の view）から、脇で選ばれて見える行。DM は bot の行が受け持つ */
export function selectedRow(view, bots = []) {
  if (!view?.id) return null;
  if (view.kind === 'bot') return view.id === 'new' ? null : { kind: 'bot', id: view.id };
  if (view.kind === 'channel') {
    const owner = bots.find((b) => b.dmChannelId === view.id);
    return owner ? { kind: 'bot', id: owner.id } : { kind: 'channel', id: view.id };
  }
  return { kind: view.kind, id: view.id };
}
