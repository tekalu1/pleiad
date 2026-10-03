import { EVERYONE, HERE } from './mentions.mjs';

/** 投稿の時点のメンバーとスレッドの発言者から、集団宛てを bot ID に解く。 */
export async function groupTargets(channels, channel, threadId, mentions) {
  const groups = mentions.includes(HERE) || mentions.includes(EVERYONE);
  if (!groups || channel?.kind === 'dm') return { groups: false, botIds: [] };
  const members = channel.members ?? [];
  if (mentions.includes(EVERYONE)) return { groups: true, botIds: [...members] };
  if (!threadId) return { groups: true, botIds: [] };

  const spoke = new Set();
  let before;
  do {
    const page = await channels.read({ channelId: channel.id, threadId, before, limit: 100 });
    for (const post of page.posts ?? []) if (!post.deletedAt && post.author?.kind === 'bot') spoke.add(post.author.botId);
    before = page.nextBefore;
  } while (before);
  return { groups: true, botIds: members.filter((id) => spoke.has(id)) };
}

export const expandGroups = (mentions, botIds) => [...new Set([...mentions, ...botIds])];
