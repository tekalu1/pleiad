// イベントへの sessionId の付け方（core/protocol.mjs の stampSessionId）。
//
// 全イベントに sessionId が付くのが契約。バックエンドが書かなかったものはターンの id で補うが、
// 明示的な null（statusIcon のようにセッションに紐づかないもの）はそのまま残す。
// `??` で埋めていた頃は、AI が set_status で付けたアイコンの変更がそのターンのセッションの
// イベントとして届き、人間が付けたとき（null）と形が違っていた。
import { stampSessionId } from "../../core/protocol.mjs";

export const name = "event-session-id";
export const title = "イベントの sessionId は、無ければ補い、明示的な null は残す";

export default async function (t) {
  const turn = "sess-A";
  t.ok("書いていなければターンの id", stampSessionId({ type: "text.delta", text: "x" }, turn).sessionId === turn);
  t.ok("書いてあればそれ", stampSessionId({ type: "session", sessionId: "sess-B" }, turn).sessionId === "sess-B");
  t.ok("明示的な null は残る（statusIcon）", stampSessionId({ type: "statusIcon", sessionId: null, status: "s", icon: "◐" }, turn).sessionId === null);
  t.ok("ターンの id もまだ無ければ null", stampSessionId({ type: "activity", state: "thinking" }, null).sessionId === null);
  const ev = { type: "text.end", uuid: "u1" };
  const out = stampSessionId(ev, turn);
  t.ok("元のイベントは書き換えない", ev.sessionId === undefined && out.uuid === "u1");
}
