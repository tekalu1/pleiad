// 各画面が「いま見ている会話」をホストへ知らせる仕組み（presence）。通知を送る・消すかどうかの判定に使う（ADR 0086）。
//
// 画面が可視（visible）で、その会話を開いているときだけ見ていることにする。画面は変わるたびと 1 分ごとに送り直し、
// 一定時間（PRESENCE_TTL_MS）たっても更新が無い印は無かったことにする（落ちた画面が見ている印を残し続けない）。
// 接続（ws）ごとに 1 件。接続を閉じたら消える。
import { PRESENCE_TTL_MS } from './policy.mjs';

export function createPresence({ now = Date.now } = {}) {
  const byConn = new Map();   // conn -> { deviceId, platform, visible, sessionId, at }
  return {
    /** deviceId: 中継越しの端末ならその id、ホストの PC の画面なら null */
    set(conn, { deviceId = null, platform = null, visible, sessionId }) {
      const entry = { deviceId, platform, visible: visible === true, sessionId: typeof sessionId === 'string' && sessionId ? sessionId : null, at: now() };
      byConn.set(conn, entry);
      return entry;
    },
    clear(conn) { return byConn.delete(conn); },
    /** 期限内の印。 */
    entries() {
      const t = now();
      const out = [];
      for (const [conn, e] of byConn) {
        if (t - e.at > PRESENCE_TTL_MS) { byConn.delete(conn); continue; }
        out.push(e);
      }
      return out;
    },
    /** その会話を見ている印（見え始めたときの取り消しの判定用）。 */
    viewing(sessionId) { return this.entries().some(e => e.visible && e.sessionId === sessionId); },
  };
}
