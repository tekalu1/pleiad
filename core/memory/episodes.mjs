// 静かになったスレッドの bot ごとの要約と、新しい bot 会話への一度きりの申し送り。
// 正本は ThreadState.digest（SQLite の channel_threads）。タイマーは再起動時に組み直す。
import crypto from 'node:crypto';
import { escapeBody } from '../channels/types.mjs';
import { agentT } from '../i18n.mjs';

export const EPISODE_QUIET_MS = 3 * 60_000;
const RETRY_MS = 15 * 60_000;
const RECENT_MS = 14 * 86_400_000;
const MAX_POST_CHARS = 12_000;
const MAX_HANDOFF_CHARS = 1_300;

const keyOf = (channelId, threadId) => `${channelId}/${threadId}`;
const clip = (value, max) => [...String(value ?? '').replace(/\s+/g, ' ').trim()].slice(0, max).join('');
const fingerprint = (posts) => crypto.createHash('sha256').update(JSON.stringify(posts.map((p) => [p.id, p.text, p.state, p.deletedAt, p.taint]))).digest('hex').slice(0, 24);
function episodePosts(posts, threadId, botId) {
  const safe = posts.filter((p) => !p.deletedAt && !p.taint && p.state !== 'working' && p.text?.trim()
    && (p.author?.kind === 'human' || (p.author?.kind === 'bot' && p.author.botId === botId)));
  const recent = [];
  let chars = 0;
  for (const post of [...safe].reverse()) {
    if (chars + post.text.length > MAX_POST_CHARS) { if (!recent.length) recent.push(post); break; }
    chars += post.text.length;
    recent.push(post);
  }
  recent.reverse();
  // 長い bot の応答で窓が埋まっても、人の発言を根拠から失わない。
  const lastHuman = [...safe].reverse().find((p) => p.author?.kind === 'human');
  if (lastHuman && !recent.some((p) => p.id === lastHuman.id)) recent.unshift(lastHuman);
  const root = safe.find((p) => p.id === threadId && p.author?.kind === 'human');
  if (root && !recent.some((p) => p.id === root.id)) recent.unshift(root);
  return recent;
}

export function createEpisodes({ channels, bots, summarize, localeOf = () => 'ja', now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  const timers = new Map();
  let closed = true;
  let queue = Promise.resolve();

  function schedule(channelId, threadId, delay = EPISODE_QUIET_MS) {
    if (closed || !threadId) return;
    const key = keyOf(channelId, threadId);
    if (timers.has(key)) clearTimer(timers.get(key));
    const timer = setTimer(() => {
      timers.delete(key);
      queue = queue.then(() => digestThread(channelId, threadId)).catch((e) => {
        console.error('  memory episode:', String(e?.message ?? e));
        schedule(channelId, threadId, RETRY_MS);
      });
    }, Math.max(0, delay));
    timer?.unref?.();
    timers.set(key, timer);
  }

  async function digestThread(channelId, threadId) {
    if (closed) return;
    const thread = await channels.threads.get(channelId, threadId);
    if (!thread || !Object.keys(thread.sessions ?? {}).length) return;
    const channel = await channels.get({ channelId }).catch(() => null);
    if (!channel || channel.archivedAt) return;
    if (thread.state === 'working' || thread.state === 'waiting') { schedule(channelId, threadId, EPISODE_QUIET_MS); return; }
    const page = await channels.read({ channelId, threadId, limit: 100 });
    if (!page.posts.some((p) => p.author?.kind === 'human' && !p.deletedAt && !p.taint && p.text?.trim())) {
      if (Object.keys(thread.digest ?? {}).length) await channels.threads.update(channelId, threadId,
        { digest: Object.fromEntries(Object.keys(thread.digest).map((id) => [id, null])) });
      return;
    }
    for (const botId of Object.keys(thread.sessions)) {
      if (closed) return;
      const bot = await bots.get({ botId }).catch(() => null);
      if (!bot || bot.plain) continue;   // 組み込みの bot（bot なし）はエピソードを持たない（ADR 0157）
      const recent = episodePosts(page.posts, threadId, botId);
      if (!recent.some((p) => p.author?.kind === 'human')) continue;
      const currentFingerprint = fingerprint(recent);
      if (thread.digest?.[botId]?.fingerprint === currentFingerprint) continue;
      const episode = await summarize({ botId, channelId, threadId, posts: recent, previous: thread.digest?.[botId]?.text ?? '' });
      if (!episode?.text || closed) continue;
      // 要約を作っている間に新しい投稿が来たら、古い要約を保存せず静かになるのを待つ。
      const fresh = await channels.read({ channelId, threadId, limit: 100 });
      if (fresh.posts.some((p) => p.state === 'working') || fingerprint(episodePosts(fresh.posts, threadId, botId)) !== currentFingerprint) {
        schedule(channelId, threadId);
        return;
      }
      await episode.commit();
      await channels.threads.update(channelId, threadId, (old) => ({ digest: {
        ...(old.digest ?? {}), [botId]: { text: clip(episode.text, 500), at: now(), lastAt: Math.max(...recent.map((p) => p.editedAt ?? p.at ?? 0)), fingerprint: currentFingerprint },
      } }));
    }
  }

  async function recent(botId, currentChannelId, currentThreadId, locale = localeOf()) {
    const threads = (await channels.threads.list()).filter((t) => t.sessions?.[botId] && t.digest?.[botId]?.text
      && !(t.channelId === currentChannelId && t.threadId === currentThreadId))
      .sort((a, b) => (b.digest[botId].lastAt ?? b.digest[botId].at) - (a.digest[botId].lastAt ?? a.digest[botId].at));
    if (!threads.length) return null;
    const lines = [agentT(locale, 'memory.recent.handoff')];
    for (const thread of threads) {
      if (lines.length >= 6) break;
      const channel = await channels.get({ channelId: thread.channelId }).catch(() => null);
      if (!channel || channel.archivedAt) continue;
      const root = await channels.getPost({ channelId: thread.channelId, postId: thread.threadId }).catch(() => null);
      const title = root?.author?.kind === 'human' && !root.taint && !root.deletedAt ? clip(root.text, 70) : '';
      const head = `[channelId=${thread.channelId} threadId=${thread.threadId}] #${clip(channel.name, 60)}${title ? ` · ${title}` : ''}: `;
      const room = MAX_HANDOFF_CHARS - lines.join('\n').length - head.length - 1;
      if (room < 60) break;
      lines.push(head + clip(thread.digest[botId].text, Math.min(170, room)));
    }
    return lines.length > 1 ? `<pleiad-bot-recent>\n${escapeBody(lines.join('\n'))}\n</pleiad-bot-recent>` : null;
  }

  return {
    recent,
    onPosted(post) { const threadId = post?.threadId ?? (post?.deletedAt ? post.id : null); if (threadId) schedule(post.channelId, threadId); },
    onTurnEnd(channelId, threadId) { schedule(channelId, threadId); },
    async start() {
      closed = false;
      const counts = new Map();
      const recent = (await channels.threads.list()).filter((thread) => thread.updatedAt >= now() - RECENT_MS)
        .sort((a, b) => b.updatedAt - a.updatedAt);
      for (const thread of recent) {
        const ids = Object.keys(thread.sessions ?? {});
        if (!ids.some((id) => (counts.get(id) ?? 0) < 5)) continue;
        for (const id of ids) counts.set(id, (counts.get(id) ?? 0) + 1);
        schedule(thread.channelId, thread.threadId, Math.max(0, EPISODE_QUIET_MS - (now() - thread.updatedAt)));
      }
    },
    stop() { closed = true; for (const timer of timers.values()) clearTimer(timer); timers.clear(); },
  };
}
