// 画面の会話の一覧（WS の listSessions）を細く・差分で返す（ADR 0903）。
// - 行の振り分けの記録（routing）は載せず、委譲の記録（delegation）は画面が一覧で使う欄だけにする。詳しい中身は、要る画面が
//   タスクの口（agentTasks・delegation.tasks・delegation.status）で取る。操作（core/ops の sessions.list）の形は変えない
// - 接続ごとに、送った一覧の写し（行の順と、行ごとの中身の指紋）を新しい順にいくつか持ち、画面が「since（前に受けた写しの番号）」を
//   添えて頼んだら、変わった行・消えた行・並びの直しだけを返す。写しが無い（つなぎ直した・古すぎる・ホストが起動し直した）なら全部を返す
import crypto from 'node:crypto';

/** 一覧の 1 行から、画面が使わない委譲・振り分けの詳しい中身を外す。元の行は変えない。 */
export function slimRow(row) {
  if (!row || !('routing' in row || row.delegation)) return row;
  const out = { ...row };
  // 振り分けの記録は委譲カード・バックグラウンドの一覧がタスクの行（routing）で見る。一覧の行からは読まない
  delete out.routing;
  if (row.delegation) {
    const d = row.delegation;
    // 画面が見るのは、依頼元（一覧で子を親の下に畳む）と、端末の AI から任された印（⇄・端末の名前）だけ
    out.delegation = { parentSessionId: d.parentSessionId ?? null, ...(d.remote ? { remote: d.remote } : {}) };
  }
  return out;
}

const fingerprint = (row) => crypto.createHash('sha1').update(JSON.stringify(row)).digest('base64');

/**
 * 並びの直し。画面は「front を先頭に、残りは前の並び（消えた行と front を除く）のまま」で組み立てる。
 * 変わった行が先頭へ上がっただけなら front はその行だけ。組み立てて合わないか、直しが大きければ並び全部（order）を送る。
 */
function orderPatch(prev, next, moved) {
  const alive = new Set(next);
  const rest = prev.filter((id) => alive.has(id));
  const rebuilds = (front) => {
    const f = new Set(front);
    let i = 0;
    for (const id of front) if (next[i++] !== id) return false;
    for (const id of rest) if (!f.has(id) && next[i++] !== id) return false;
    return i === next.length;
  };
  // 1) 先頭から続く「変わった・新しい行」を上げる
  let j = 0;
  while (j < next.length && moved.has(next[j])) j++;
  // 2) 末尾から前の並びと合う分を残し、その前を全部上げる
  let m = 0;
  while (m < next.length && m < rest.length && next[next.length - 1 - m] === rest[rest.length - 1 - m]) m++;
  for (const front of [next.slice(0, j), next.slice(0, next.length - m)]) {
    if (front.length <= next.length / 2 && rebuilds(front)) return front.length ? { front } : {};
  }
  return { order: next };
}

/** 接続ごとの一覧の写し。conn は WebSocket（接続が無くなれば写しも消える）。 */
export function createListDeltas({ keep = 4 } = {}) {
  const byConn = new WeakMap();
  return {
    /**
     * rows（細くした行の並び）を、この接続へ返す形にする。
     * since が前に返した写しの番号なら { seq, full: false, base: since, rows: 変わった・新しい行, removed: 消えた行の id, front | order? }、
     * そうでなければ { seq, full: true, rows }。
     */
    reply(conn, rows, { since } = {}) {
      let st = byConn.get(conn);
      if (!st) byConn.set(conn, st = { epoch: crypto.randomBytes(6).toString('base64url'), n: 0, snaps: new Map() });
      const ids = [], prints = new Map();
      for (const row of rows) { ids.push(row.id); prints.set(row.id, fingerprint(row)); }
      const seq = `${st.epoch}.${++st.n}`;
      const base = typeof since === 'string' ? st.snaps.get(since) : undefined;
      st.snaps.set(seq, { ids, prints });
      while (st.snaps.size > keep) st.snaps.delete(st.snaps.keys().next().value);
      if (!base) return { seq, full: true, rows };
      const changed = rows.filter((row) => base.prints.get(row.id) !== prints.get(row.id));
      const removed = base.ids.filter((id) => !prints.has(id));
      return { seq, full: false, base: since, rows: changed, removed, ...orderPatch(base.ids, ids, new Set(changed.map((row) => row.id))) };
    },
  };
}
