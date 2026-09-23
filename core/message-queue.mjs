// Durable acceptance is separate from execution. A lost backend acknowledgement
// is never retried automatically: the original may already have been consumed.
export function createMessageQueue({ store, active, start, changed, delivered }) {
  const locks = new Map();
  const serial = (id, fn) => {
    const next = (locks.get(id) ?? Promise.resolve()).catch(() => {}).then(fn);
    locks.set(id, next);
    next.finally(() => { if (locks.get(id) === next) locks.delete(id); }).catch(() => {});
    return next;
  };
  const list = async id => structuredClone((await store.get(id)).outbox ?? []);
  const save = async (id, items) => {
    await store.setSessionData(id, 'outbox', items);
    changed(id, items);
  };
  async function update(id, messageId, patch) {
    const items = await list(id);
    const item = items.find(m => m.id === messageId);
    if (item) Object.assign(item, patch);
    await save(id, items);
    return item;
  }
  const kick = id => serial(id, async () => {
    for (;;) {
      const items = await list(id);
      const item = items.find(m => !['sent', 'cancelled'].includes(m.status));
      if (!item || item.status !== 'queued') return;
      const turn = active(id);
      if (turn?.blocked) return;
      if (turn && (!turn.steer || (await store.get(id)).nextSettings)) return;
      await update(id, item.id, { status: 'sending', error: null });
      if (turn) {
        try {
          const accepted = await turn.steer(item);
          if (!accepted) {
            await update(id, item.id, { status: 'queued' });
            return;
          }
          await update(id, item.id, { status: 'sent' });
          await delivered(id, item, turn);
        } catch (e) {
          await update(id, item.id, { status: 'unknown', error: String(e.message ?? e) });
          return;
        }
      } else {
        // Only wait for startup, not for the whole turn, while holding the lock.
        let ready;
        const started = new Promise(resolve => { ready = resolve; });
        let accepted = false;
        const task = start({ ...item.args, sessionId: id, messageId: item.id, at: item.at }, async () => {
          await update(id, item.id, { status: 'sent' });
          accepted = true;
          ready();
        });
        Promise.resolve(task).then(outcome => {
          if (!accepted) ready();
          // The agent was running a turn Pleiad did not start (procway's wake) and nothing was
          // delivered. Back to the queue; that turn's end kicks the queue again.
          if (outcome === 'requeue') return serial(id, () => update(id, item.id, { status: 'queued', error: null }));
          if (outcome && outcome !== 'ok') return pause(id);
        }, e => serial(id, () => update(id, item.id, {
          status: accepted ? 'unknown' : 'failed', error: String(e.message ?? e),
        }))).finally(() => { ready(); kick(id).catch(() => {}); }).catch(() => {});
        // A startup rejection must release this lock before recording the error.
        Promise.resolve(task).catch(() => ready());
        await started;
        return;
      }
    }
  });
  const pause = id => serial(id, async () => {
    const items = await list(id);
    if (!items.some(item => item.status === 'queued')) return;
    for (const item of items) if (item.status === 'queued') item.status = 'paused';
    await save(id, items);
  });
  return {
    get busy() { return locks.size > 0; },
    list: id => serial(id, () => list(id)), kick, pause,
    // 受理された途中送信が、読まれないまま捨てられた。勝手に送り直さず、保留にして利用者に選ばせる
    // （ターンが死んだ直後なので、続けて送ってよいかは分からない）
    returned: (id, messageId) => serial(id, async () => {
      const items = await list(id);
      const item = items.find(m => m.id === messageId);
      if (!item || item.status !== 'sent') return;
      item.status = 'paused';
      await save(id, items);
    }),
    async recover() {
      for (const [id, meta] of Object.entries(await store.getAll())) {
        if (!meta.outbox?.length) continue;
        const items = await list(id);
        for (const item of items) {
          if (item.status === 'sending') item.status = 'unknown';
          if (item.status === 'queued') item.status = 'paused';
        }
        await save(id, items);
      }
    },
    async accept(id, messageId, args) {
      const item = await serial(id, async () => {
        const items = await list(id);
        const existing = items.find(m => m.id === messageId);
        if (existing) {
          if (JSON.stringify(existing.args) !== JSON.stringify(args)) throw new Error('同じ送信IDで内容を変更できません');
          return existing;
        }
        if (items.filter(m => !['sent', 'cancelled'].includes(m.status)).length >= 100) throw new Error('送信待ちは100件までです');
        const item = { id: messageId, args, at: new Date().toISOString(), status: 'queued' };
        items.push(item);
        await save(id, items);
        return item;
      });
      kick(id).catch(() => {});
      return item;
    },
    async action(id, messageId, action) {
      await serial(id, async () => {
        const items = await list(id);
        const item = items.find(m => m.id === messageId);
        if (!item || ['sent', 'sending', 'cancelled'].includes(item.status)) throw new Error('このメッセージは変更できません');
        if (!['cancel', 'retry'].includes(action)) throw new Error('不正な操作です');
        item.status = action === 'cancel' ? 'cancelled' : 'queued';
        item.error = null;
        await save(id, items);
      });
      kick(id).catch(() => {});
    },
  };
}
