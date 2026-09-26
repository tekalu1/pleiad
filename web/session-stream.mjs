// Only display events are replayed: settings, permissions and other commands
// keep their ordinary delivery path. Shared with the server's live snapshot.
export const streamEvents = new Set([
  // 配達の合図も replay する（開き直したときに、渡り終えた発言が「渡していない」まま固まらないように）
  "userMessage", "userMessage.delivered", "userMessage.dropped", "text.delta", "text.end", "thinking.start", "thinking.delta",
  "tool.start", "tool.result", "activity", "present", "turnResult", "turnEnd", "taskNotice",
]);

/** Keep events until the history has been painted (branch junctions are placed afterwards). */
export function createSessionLoads() {
  const pending = new Set();
  return {
    begin(id) {
      const load = { id, events: [] };
      pending.add(load);
      return load;
    },
    capture(event, current) {
      if (!streamEvents.has(event.type)) return false;
      let defer = false;
      for (const load of pending) {
        if (load.id !== event.sessionId) continue;
        load.events.push(event);
        if (current === load.id) defer = true;
      }
      return defer;
    },
    finish(load, data) {
      pending.delete(load);
      return [...(data.stream?.events ?? []),
        ...load.events.filter(e => e.streamSeq > data.streamCursor)];
    },
    cancel(load) { pending.delete(load); },
  };
}
