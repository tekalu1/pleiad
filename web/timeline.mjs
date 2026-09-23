import { visualizeReferences } from './visualize-reference.mjs';
const time = value => Date.parse(value ?? "") || 0;
const normalize = value => {
  const p = String(value ?? "").trim().replace(/\\/g, "/");
  return /^[a-z]:\//i.test(p) ? p.toLowerCase() : p;
};

/** Match the attachment marker, not incidental mentions of a filename. */
export function attachmentMessageIndex(messages, present) {
  if (present.by !== "human" || !present.path) return -1;
  if (present.messageId) {
    const at = messages.findIndex(m => m.uuid === present.messageId);
    if (at >= 0) return at;
  }
  const target = normalize(present.path);
  const candidates = messages.flatMap((m, i) => m.role === "user" &&
    String(m.text ?? "").split(/\r?\n/).some(line => {
      const match = /^\[添付\]\s+(.+)$/.exec(line.trim());
      return match && normalize(match[1]) === target;
    }) ? [i] : []);
  if (!candidates.length) return -1;
  const at = time(present.at);
  return at ? candidates.reduce((best, i) => Math.abs(time(messages[i].at) - at) <
    Math.abs(time(messages[best].at) - at) ? i : best) : candidates.at(-1);
}

/** Preserve message order; human attachments belong immediately after their message. */
export function buildItems(messages, presents) {
  let lastAt = 0;
  const items = messages.map((m, mi) => {
    lastAt = Math.max(lastAt, time(m.at));
    return { at:m.at, sortAt:lastAt, kind:"msg", m, mi };
  });
  const attached = new Map();
  const untimed = [];
  const visualAnchors = new Map();
  messages.forEach((m, mi) => {
    if (m.role !== 'assistant') return;
    for (const ref of visualizeReferences(m.text)) {
      if (!visualAnchors.has(ref.raw)) visualAnchors.set(ref.raw, []);
      visualAnchors.get(ref.raw).push(mi);
    }
  });
  presents.forEach((p, pi) => {
    const anchorMi = p.kind === 'visualization' && p.reference
      ? (visualAnchors.get(p.reference)?.shift() ?? -1) : attachmentMessageIndex(messages, p);
    const item = { kind:"present", p, pi, anchorMi, at:p.at, sortAt:time(p.at) };
    if (anchorMi >= 0) {
      if (!attached.has(anchorMi)) attached.set(anchorMi, []);
      attached.get(anchorMi).push(item);
    } else if (p.at) items.push(item);
    else untimed.push(item);
  });
  return items.sort((a,b) => a.sortAt-b.sortAt)
    .flatMap(item => item.kind === "msg" ? [item, ...(attached.get(item.mi) ?? [])] : [item])
    .concat(untimed);
}
