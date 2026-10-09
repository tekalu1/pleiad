// 会話の一覧を差分で受けて組み立てる（core/session-list-delta.mjs の受け手。ADR 0903）。DOM を触らない。
// 受けた行は手元の写し（base）に持ち、画面には行ごとの浅い写しを渡す（画面は行を直に書き換える。sidebarChange）。
export function createSessionListSync() {
  let since = null;
  let base = new Map();
  let order = [];
  const view = () => order.map((id) => {
    const row = base.get(id);
    if (!row) throw new Error(`session list: missing row ${id}`);
    return { ...row };
  });
  const reset = () => { since = null; base = new Map(); order = []; };
  return {
    /** listSessions に添える引数 */
    args: () => (since ? { delta: true, since } : { delta: true }),
    /** 返事を手元の写しに当てて、画面に渡す行の並びを返す。組み立てられなければ写しを捨てて投げる（次は全部を頼む） */
    apply(reply) {
      try {
        if (Array.isArray(reply)) {
          reset();
          base = new Map(reply.map((row) => [row.id, row]));
          order = reply.map((row) => row.id);
          return view();
        }
        if (!reply || typeof reply !== 'object' || !Array.isArray(reply.rows)) throw new Error('session list: bad reply');
        if (reply.full) {
          base = new Map(reply.rows.map((row) => [row.id, row]));
          order = reply.rows.map((row) => row.id);
        } else {
          // 差分は手元の写し（since）に当てるものだけ受ける（行き違いで古い写しへの差分が来たら、全部を頼み直す）
          if (reply.base !== undefined && reply.base !== since) throw new Error('session list: delta for another snapshot');
          const removed = new Set(reply.removed ?? []);
          for (const id of removed) base.delete(id);
          for (const row of reply.rows) base.set(row.id, row);
          if (Array.isArray(reply.order)) order = reply.order;
          else {
            const front = reply.front ?? [];
            const f = new Set(front);
            order = [...front, ...order.filter((id) => !removed.has(id) && !f.has(id))];
          }
          const listed = new Set(order);
          for (const id of [...base.keys()]) if (!listed.has(id)) base.delete(id);
        }
        const rows = view();
        since = reply.seq ?? null;
        return rows;
      } catch (e) {
        reset();
        throw Object.assign(e, { listSync: true });
      }
    },
    reset,
  };
}
