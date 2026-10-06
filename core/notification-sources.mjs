// 通知の一覧（core/notifications.mjs。ADR 9102）へ、出来事から行を書く側。サーバーが出来事の起きる場所（ターンの完了・承認の成立と決着・チャンネルの出来事）で呼ぶ。
// 行に載せる「どこで・誰が」は、その時点の会話・チャンネル・スレッドの名前を控える（あとで名前が変わっても行は変わらない）。
// どの呼び出しも投げない（通知の一覧の失敗で、ターン・承認・投稿を止めない）。
//
//   createNotificationSources({ inbox, store, viewing, titleOf, channels, bots, hiddenKinds, log }) → Sources
//     viewing(sessionId): いま見ている会話か（core/notify/presence.mjs）
//     titleOf(sessionId): 会話の名前（空なら '')
//     channels・bots: それぞれを返す関数（() => { get({ channelId }), getPost({ channelId, postId }) } | null・() => { get({ botId }) } | null。作る前に出来ていない物を、使うときに引く）
//   Sources:
//     completion({ sessionId, outcome, completedAt, uuid? })   … ターンの完了・失敗（completionKind の規則で、載せないものは載せない）
//     permissionOpened({ id, sessionId, kind, via? })          … あなた待ちの成立。via は承認のカードが出ている会話（委譲の子の承認は依頼元）
//     permissionSettled({ id, answer, kind })                  … 決着
//     observe(event)                                           … channelPost（人以外の @あなた）・channelRead・channelsChanged（アーカイブ）
//     sessionRemoved(sessionId)
import { completionKind, permissionOutcome } from './notifications.mjs';

const firstLine = (s) => String(s ?? '').split('\n').map((l) => l.trim()).find(Boolean) ?? '';

export function createNotificationSources({ inbox, store, viewing = () => false, titleOf = async () => '', channels: getChannels = () => null, bots: getBots = () => null, hiddenKinds = new Set(), log = () => {} }) {
  const guard = (what, fn) => async (...args) => {
    try { return await fn(...args); } catch (e) { log(`通知の一覧: ${what} に失敗: ${String(e?.message ?? e)}`); return null; }
  };

  const botActor = async (botId) => {
    const bot = botId ? await getBots()?.get({ botId }).catch(() => null) : null;
    return bot ? { kind: 'bot', name: bot.name ?? '', ...(bot.icon ? { icon: bot.icon } : {}) } : null;
  };
  /** チャンネル・スレッドの名前（スレッドの題は根の投稿の最初の行） */
  const placeOf = async (channelId, threadId) => {
    if (!channelId) return {};
    const channels = getChannels();
    const channel = await channels?.get({ channelId }).catch(() => null);
    const root = threadId ? await channels?.getPost({ channelId, postId: threadId }).catch(() => null) : null;
    return { ...(channel?.kind === 'channel' && channel.name ? { channelName: channel.name } : {}), ...(root ? { threadTitle: firstLine(root.text) } : {}) };
  };

  /** 会話の通知の「どこで・誰が」。bot の会話はチャンネル・スレッドへ飛ぶ（会話そのものはサイドバーに出ない） */
  async function sessionPlace(sessionId) {
    const meta = await store.get(sessionId).catch(() => null);
    const sb = meta?.bot ?? null;
    const actor = sb?.botId ? await botActor(sb.botId) : null;
    const channelId = sb?.channelId ?? null;
    const threadId = sb?.threadId ?? null;
    return { sb, meta, actor, channelId, threadId, title: await titleOf(sessionId), ...(await placeOf(channelId, threadId)) };
  }

  return {
    completion: guard('完了', async ({ sessionId, outcome, completedAt, uuid = null }) => {
      const meta = await store.get(sessionId).catch(() => null);
      const kind = completionKind({ outcome, bot: meta?.bot ?? null, delegation: meta?.delegation ?? null, hiddenKinds });
      if (!kind || !Number.isFinite(completedAt)) return null;
      const place = await sessionPlace(sessionId);
      // 会話の通知は at = completedAt（会話の既読 readAt と同じ時刻で突き合わせる）
      return inbox.add({
        kind, dedupeKey: `${kind === 'failed' ? 'failed' : 'done'}:${sessionId}:${completedAt}`, at: completedAt, sessionId, channelId: place.channelId, viewing: viewing(sessionId),
        data: { uuid: place.channelId ? null : uuid, threadId: place.threadId, actor: place.actor, title: place.title, channelName: place.channelName, threadTitle: place.threadTitle },
      });
    }),

    permissionOpened: guard('あなた待ち', async ({ id, sessionId, kind = 'tool', via = null }) => {
      const target = via || sessionId;
      if (!target || !id) return null;
      const place = await sessionPlace(target);
      if (place.sb && hiddenKinds.has(place.sb.kind)) return null;
      return inbox.add({
        kind: 'wait', dedupeKey: `wait:${id}`, sessionId: target, channelId: place.channelId, viewing: viewing(target),
        data: { ask: kind === 'question' ? 'question' : 'approval', threadId: place.threadId, actor: place.actor, title: place.title, channelName: place.channelName, threadTitle: place.threadTitle },
      });
    }),
    permissionSettled: guard('あなた待ちの決着', async ({ id, answer, kind = 'tool' }) => inbox.settle(`wait:${id}`, permissionOutcome(answer, { kind }))),

    observe: guard('出来事', async (event) => {
      if (event?.type === 'channelPost' && (event.op === 'add' || event.op === 'edit')) {
        const post = event.post;
        if (!post || post.deletedAt || !post.mentions?.includes('you') || post.author?.kind === 'human') return null;
        const threadId = post.threadId ?? post.id;
        const [actor, place] = [post.author?.kind === 'bot' ? await botActor(post.author.botId) : null, await placeOf(post.channelId, threadId)];
        return inbox.add({ kind: 'mention', dedupeKey: `mention:${post.id}`, at: post.at, channelId: post.channelId, data: { threadId, postId: post.id, actor, ...place } });
      }
      if (event?.type === 'channelRead') return inbox.markChannel(event.channelId, event.readAt);
      if (event?.type === 'channelsChanged' && event.channel?.archivedAt && event.channel.id) return inbox.removeChannel(event.channel.id);
      return null;
    }),

    sessionRemoved: guard('会話の削除', async (sessionId) => inbox.removeSession(sessionId)),
  };
}
