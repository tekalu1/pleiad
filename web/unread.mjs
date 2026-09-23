// 完了はサーバーのもの（completedAt）、確認もサーバーのもの（readAt）。ホストに 1 つで、どの窓・どの端末から見ても同じ
// （docs/design.md「完了・未確認」）。ここはその写しと、まだ届いていない確認の送り待ちを持つ。
//
// 旧版は確認済みをブラウザーの localStorage（READ_STORE）に持っていた。残っていれば送り待ちに入れ、
// 最初につながったときにサーバーへ 1 度だけ送る（大きい方で合わさる）。受け取られたら消す。
export const READ_STORE = "agent-host-read-completions";

const valid = (id, at) => typeof id === "string" && id !== "" && Number.isFinite(at) && at > 0;

/**
 * @param {object} o
 * @param {Storage} [o.storage] 旧版の確認済みを読む（移したら消す）
 * @param {(reads: [string, number][]) => Promise<unknown>} [o.send] サーバーへ送る（markRead）。つながっていなければ reject
 */
export function createReadCompletions({ storage, send } = {}) {
  const read = new Map();       // 確認済み（サーバーの readAt と、送った／送る分）
  const pending = new Map();    // まだサーバーが受け取っていない分
  let legacy = false;           // 旧版の分が送り待ちにある
  let flushing = null;

  const put = (map, id, at) => { if (valid(id, at) && at > (map.get(id) ?? 0)) { map.set(id, at); return true; } return false; };

  try {
    for (const [id, at] of JSON.parse(storage?.getItem(READ_STORE) ?? "[]")) {
      put(read, id, at);
      if (put(pending, id, at)) legacy = true;
    }
  } catch { /* Unavailable or corrupt storage must not prevent opening a conversation. */ }

  /** 送り待ちをまとめて送る。失敗したら残して、次につながったときに送り直す */
  const flush = () => {
    if (flushing || !pending.size || !send) return flushing ?? Promise.resolve();
    const batch = [...pending];
    const withLegacy = legacy;
    let ok = false;
    flushing = Promise.resolve().then(() => send(batch)).then(() => {
      ok = true;
      for (const [id, at] of batch) if ((pending.get(id) ?? 0) <= at) pending.delete(id);
      if (withLegacy) { legacy = false; try { storage?.removeItem(READ_STORE); } catch {} }
    }, () => {}).finally(() => {
      flushing = null;
      // 送っている間に増えた分。失敗したときは送り直さない（次につながったときに flush する）
      if (ok && pending.size) flush();
    });
    return flushing;
  };

  return {
    flush,
    /** サーバーの一覧（readAt）とread イベントの分を取り込む。巻き戻さない。変わったら true */
    apply(reads) {
      let changed = false;
      for (const pair of reads ?? []) if (Array.isArray(pair) && put(read, pair[0], pair[1])) changed = true;
      return changed;
    },
    fromSessions(sessions) {
      return this.apply((sessions ?? []).map(s => [s?.id, s?.readAt]));
    },
    mark(id, at) {
      // 既に確認済み（ホストから届いた分・送った分）なら送らない。送れなかった分は pending に残っている
      if (!put(read, id, at)) return;
      put(pending, id, at);
      flush();
    },
    hasUnread(session) {
      return Number.isFinite(session.completedAt) && session.completedAt > (read.get(session.id) ?? 0);
    },
  };
}
