// Human references are resolved against known conversations, never by an AI's interpretation.
// An ID/link is exact; a title must be quoted and unique. Ordinary prose is not a grant.
export function referencedSessions(text, rows) {
  const body = String(text ?? '');
  const titles = new Map();
  for (const row of rows) if (row.title) titles.set(row.title, (titles.get(row.title) ?? 0) + 1);
  const tokens = new Set(body.match(/[A-Za-z0-9_-]+/g) ?? []);
  const quoted = new Set([...body.matchAll(/「([^」]+)」|『([^』]+)』|"([^"\n]+)"|“([^”]+)”|`([^`\n]+)`/g)].map((m) => m.slice(1).find((s) => s !== undefined)));
  return rows.filter(({ id, title }) => tokens.has(id) || (title && titles.get(title) === 1 && quoted.has(title))).map(({ id }) => id);
}

/** Recipients of a human post: DM partner, channel members, or thread participants, plus explicit mentions. */
export async function shownTo(post, channel, channels) {
  if (post?.author?.kind !== 'human' || post.taint || post.deletedAt || post.proxy) return [];
  const thread = post.threadId ? await channels.threads.get(channel.id, post.threadId) : null;
  return [...new Set([
    ...(post.threadId ? Object.keys(thread?.sessions ?? {}) : channel.members ?? []),
    ...(post.mentions ?? []).filter((id) => id !== 'you'),
  ])];
}
