// Durable acceptance is separate from execution. A lost backend acknowledgement
// is never retried automatically: the original may already have been consumed.
import { t } from './i18n.mjs';

// 送り終わった（sent）・取り消した（cancelled）項目は、会話ごとに直近この件数だけ残す。
// 二重送信を防ぐ判定（accept の同じ id の照合）は、直近の送信の再試行にしか効かない。古い項目の id が再び来ることはなく、
// 並びの判定（kick）も sent・cancelled を飛ばすので、捨てても送り漏れ・二重送信は起きない。残さないと outbox が会話の長さで増え続ける
export const OUTBOX_KEEP_FINISHED = 20;
const finished = m => m.status === 'sent' || m.status === 'cancelled';
/** 終わった項目のうち古いものを落とす（並びは保つ）。落とすものが無ければ同じ配列を返す */
export function pruneOutbox(items, keep = OUTBOX_KEEP_FINISHED) {
  const done = items.filter(finished).length;
  if (done <= keep) return items;
  let drop = done - keep;
  return items.filter(m => !(finished(m) && drop > 0 && drop--));
}

export function createMessageQueue({ store, active, start, changed, delivered }) {
  const locks = new Map();
  const serial = (id, fn) => {
    const next = (locks.get(id) ?? Promise.resolve()).catch(() => {}).then(fn);
    locks.set(id, next);
    next.finally(() => { if (locks.get(id) === next) locks.delete(id); }).catch(() => {});
    return next;
  };
  const list = async id => structuredClone((await store.get(id)).outbox ?? []);
  // 送信待ちが何を待っているか（sessionId -> { reason, limit? }）。保存しない。kick のたびに決め直し、
  // 画面へ渡すときだけ queued の項目に waiting として添える（同じ「送信待ち」でも、この会話の作業待ちと
  // 同時実行の上限待ちでは利用者が取れる手が違う）
  const waits = new Map();
  const view = (id, items) => {
    const wait = waits.get(id);
    return wait ? items.map(m => (m.status === 'queued' ? { ...m, waiting: wait } : m)) : items;
  };
  const save = async (id, items) => {
    items = pruneOutbox(items);
    await store.setSessionData(id, 'outbox', items, { durable: true });
    changed(id, view(id, items));
  };
  const setWait = async (id, wait) => {
    if (JSON.stringify(waits.get(id) ?? null) === JSON.stringify(wait)) return;
    if (wait) waits.set(id, wait); else waits.delete(id);
    changed(id, view(id, await list(id)));
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
      if (!item || item.status !== 'queued') {
        // 先頭が保留・失敗・結果不明なら、後ろの送信待ちは順序を守ってそれを待つ
        return setWait(id, items.some(m => m.status === 'queued') ? { reason: 'order' } : null);
      }
      const turn = active(id);
      if (turn?.blocked) return setWait(id, turn.wait ?? { reason: 'turn' });
      if (turn && !turn.steer) return setWait(id, { reason: 'turn' });
      // 次のターンの設定の予約（nextSettings）がある間、途中送信は予約より先に今のターンで処理される。
      // main が動いている間は、すぐ終わるのでターンの終わりを待ち、新しいターンで予約を効かせる。
      // main が返答を終えて裏だけを待っている間（phase: waiting）は終わらないことがあるので待たない。
      // 予約は消さず、次のターンから効く（docs/multi-backend.md §2.2）
      if (turn && turn.phase !== 'waiting' && (await store.get(id)).nextSettings) return setWait(id, { reason: 'turn', detail: 'reserved' });
      waits.delete(id);
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
          // Nothing was delivered (the agent was busy with a turn Pleiad did not start).
          // Back to the queue; that turn's end kicks the queue again.
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
  // 保留（paused）を全部、並びのまま送信待ちへ戻す。1 件ずつの「再送する」（action の retry）と同じ書き換えを、
  // 中断した会話の「再開」と、中断した会話への新しい送信でまとめて行う（core/server.mjs の resumeSession・sendMessage）。
  // failed: true なら送れなかった（failed）ものも戻す。failed はエージェントに渡っていない（undelivered）ので送り直してよい。
  // 結果不明（unknown）は戻さない（届いているかもしれない。人が確かめて選ぶ）。戻した項目の id を並びのまま返す
  const retryPaused = async (id, { failed = false } = {}) => {
    const released = await serial(id, async () => {
      const items = await list(id);
      const ids = [];
      for (const item of items) {
        if (item.status !== 'paused' && !(failed && item.status === 'failed')) continue;
        item.status = 'queued'; item.error = null; ids.push(item.id);
      }
      if (ids.length) await save(id, items);
      return ids;
    });
    if (released.length) kick(id).catch(() => {});
    return released;
  };
  return {
    get busy() { return locks.size > 0; },
    retryPaused,
    list: id => serial(id, async () => view(id, await list(id))), kick, pause,
    // ターンは始めたが、バックエンドがプロンプトを渡す前に失敗した。送っていないので失敗として残し、再送か取り消しを選ばせる
    undelivered: (id, messageId, error) => serial(id, async () => {
      const items = await list(id);
      const item = items.find(m => m.id === messageId);
      if (!item || item.status !== 'sent') return;
      item.status = 'failed';
      item.error = error;
      await save(id, items);
    }),
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
          if (JSON.stringify(existing.args) !== JSON.stringify(args)) throw new Error(t('queue.idConflict'));
          return existing;
        }
        if (items.filter(m => !['sent', 'cancelled'].includes(m.status)).length >= 100) throw new Error(t('queue.full', { max: 100 }));
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
        if (!item || ['sent', 'sending', 'cancelled'].includes(item.status)) throw new Error(t('queue.notEditable'));
        if (!['cancel', 'retry'].includes(action)) throw new Error(t('queue.invalidAction'));
        item.status = action === 'cancel' ? 'cancelled' : 'queued';
        item.error = null;
        await save(id, items);
      });
      kick(id).catch(() => {});
    },
  };
}
