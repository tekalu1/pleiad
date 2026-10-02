// 送り方の帯（web/resend-band.mjs。ADR 0091）: 送り直すと消えるものの見立てとキーの受け方。見た目と動きは tests/browser/message-actions.cjs
import { tailInfo, resendKeys } from "../../web/resend-band.mjs";
import { removedSummary, applyRewindMark, markIsLive, nativeUuid, keptPresentIndexes } from "../../core/rewind.mjs";

export const name = "resend-band";
export const title = "送り直しの帯: 消えるものの件数・走っている返答・ファイルの変更 / キー / 巻き戻しの印と提示の切り取り";

const user = (uuid, extra = {}) => ({ role: "user", uuid, text: uuid, at: "2026-10-03T10:00:00Z", ...extra });
const ai = (uuid, extra = {}) => ({ role: "assistant", uuid, text: uuid, at: "2026-10-03T10:00:00Z", ...extra });

export default async function(t) {
  // ---- 消えるものの見立て
  const history = [user("u1"), ai("a1"), user("u2"), ai("a2"), user("u3"), ai("a3")];
  t.ok("後ろに自分の発言が 2 件・返答がある", JSON.stringify(tailInfo(history, 2)) === JSON.stringify({ saved: 3, users: 1, files: false, running: false, any: true }));
  t.ok("後ろに自分の発言が 1 件（2 件目の発言の後ろ）", tailInfo(history, 0).users === 2 && tailInfo(history, 0).saved === 5);
  t.ok("後ろが返答だけでも「消えるものがある」", tailInfo(history, 4).any === true && tailInfo(history, 4).users === 0 && tailInfo(history, 4).saved === 1);
  t.ok("後ろに何も無ければ帯は要らない", tailInfo(history.slice(0, 5), 4).any === false);
  t.ok("走っている返答があれば、保存済みの後ろが無くても帯は要る", tailInfo(history.slice(0, 5), 4, { running: true }).any === true && tailInfo(history.slice(0, 5), 4, { running: true }).running === true);
  t.ok("スラッシュコマンド・! の行・システム側の行は発言に数えない",
    tailInfo([user("u1"), user("c1", { kind: "shell" }), user("c2", { kind: "command" }), ai("a1")], 0).users === 0);
  t.ok("ファイルを変えた返答が消える範囲にあるときだけ files",
    tailInfo([user("u1"), ai("a1", { toolCalls: [{ id: "x", name: "Edit", input: { file_path: "README.md", old_string: "a", new_string: "b" } }] })], 0).files === true
    && tailInfo([user("u1"), ai("a1", { toolCalls: [{ id: "x", name: "Read", input: { file_path: "README.md" } }] })], 0).files === false);
  t.ok("消える範囲より前のファイルの変更は数えない",
    tailInfo([user("u0"), ai("a0", { toolCalls: [{ id: "x", name: "Write", input: { file_path: "a.md", content: "x" } }] }), user("u1"), ai("a1")], 2).files === false);

  // ---- キー
  const fired = [];
  const handlers = { send: () => fired.push("send"), branch: () => fired.push("branch"), cancel: () => fired.push("cancel") };
  const key = (init) => {
    const event = { key: "", ctrlKey: false, metaKey: false, shiftKey: false, isComposing: false, keyCode: 0, stopped: false, prevented: false, ...init,
      preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; } };
    return { event, handled: resendKeys(event, handlers) };
  };
  fired.length = 0;
  t.ok("Ctrl+Enter = 送り直す", key({ key: "Enter", ctrlKey: true }).handled && fired.at(-1) === "send");
  t.ok("⌘+Enter = 送り直す", key({ key: "Enter", metaKey: true }).handled && fired.at(-1) === "send");
  t.ok("Ctrl+Shift+Enter = 分岐して送る", key({ key: "Enter", ctrlKey: true, shiftKey: true }).handled && fired.at(-1) === "branch");
  t.ok("⌘+Shift+Enter = 分岐して送る", key({ key: "Enter", metaKey: true, shiftKey: true }).handled && fired.at(-1) === "branch");
  const esc = key({ key: "Escape" });
  t.ok("Esc = 取り消し（親へ伝えない）", esc.handled && fired.at(-1) === "cancel" && esc.event.stopped && esc.event.prevented);
  const before = fired.length;
  const plain = key({ key: "Enter" });
  t.ok("ふつうの Enter は受けない（ボタンの既定の動作・改行に任せる）", !plain.handled && fired.length === before && !plain.event.prevented);
  t.ok("日本語入力の変換中は受けない", !key({ key: "Enter", ctrlKey: true, isComposing: true }).handled && !key({ key: "Escape", keyCode: 229 }).handled && fired.length === before);

  // ---- 巻き戻しの印・提示の切り取り・uuid（core/rewind.mjs）
  const chain = [user("u1"), ai("a1"), user("u2"), ai("a2")];
  t.ok("保留の印があれば、捨てる発言の手前まで見かけ上切る", JSON.stringify(applyRewindMark(chain, { drops: "u2" }).map(m => m.uuid)) === '["u1","a1"]');
  t.ok("捨てる発言が鎖から消えていれば（次のターンが葉を移した）切らない", applyRewindMark(chain.slice(0, 2), { drops: "u2" }).length === 2 && !markIsLive(chain.slice(0, 2), { drops: "u2" }) && markIsLive(chain, { drops: "u2" }));
  t.ok("印が無ければそのまま", applyRewindMark(chain, null) === chain);
  t.ok("記録の発言の uuid は接頭辞を外してネイティブへ渡す", nativeUuid("claude:abc:uu-1", "claude", "abc") === "uu-1"
    && nativeUuid("claude:old:uu-1", "claude", "abc") === null && nativeUuid("uu-1", "claude", "abc") === null && nativeUuid("claude:abc:uu-1", "claude", null) === null);
  t.ok("消える範囲の要約", JSON.stringify(removedSummary(chain, 2)) === JSON.stringify({ messages: 2, userMessages: 0, replies: 1 }) && removedSummary(chain, 0).userMessages === 1);
  const at = (n) => `2026-10-03T10:00:0${n}Z`;
  const msgs = [user("u1", { at: at(1) }), ai("a1", { at: at(2) }), user("u2", { at: at(4) }), ai("a2", { at: at(5) })];
  const presents = [{ kind: "git", by: "ai", at: at(0) }, { kind: "git", by: "ai", at: at(3) }, { kind: "git", by: "ai", at: at(6) }];
  t.ok("切り口（a1）より後に並ぶ提示は捨てる（「ここから分岐」と同じ選び方）", [...keptPresentIndexes(msgs, presents, 1)].join() === "0");
  t.ok("何も残さないなら提示も全部捨てる", keptPresentIndexes(msgs, presents, -1).size === 0);
  t.ok("末尾を残すなら全部残す", keptPresentIndexes(msgs, presents, 3).size === 3);
  let refused = false;
  try { keptPresentIndexes(msgs, [{ kind: "text", by: "ai" }], 1); } catch { refused = true; }
  t.ok("AI の提示に時刻が無く境界を決められないときは、欠落させずに断る", refused);
}
