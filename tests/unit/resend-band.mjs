// 送り直しの見立て（web/resend-band.mjs。ADR 0102）と、入力欄の「編集中」の純粋な部分（web/composer/edit-mode.mjs。ADR 0178）。見た目と動き・キーは tests/browser/message-actions.cjs
import { tailInfo, tailLines, sendLabels } from "../../web/resend-band.mjs";
import { quoteOf, changedFrom, mergeContent } from "../../web/composer/edit-mode.mjs";
import { removedSummary, applyRewindMark, markIsLive, nativeUuid, keptPresentIndexes } from "../../core/rewind.mjs";

export const name = "resend-band";
export const title = "送り直し: 消えるものの件数・走っている返答・ファイルの変更 / 帯の文とボタンの名前 / 編集中の引用・変更の判定・書きかけの合流 / 巻き戻しの印と提示の切り取り";

const user = (uuid, extra = {}) => ({ role: "user", uuid, text: uuid, at: "2026-10-03T10:00:00Z", ...extra });
const ai = (uuid, extra = {}) => ({ role: "assistant", uuid, text: uuid, at: "2026-10-03T10:00:00Z", ...extra });

export default async function(t) {
  // ---- 消えるものの見立て
  const history = [user("u1"), ai("a1"), user("u2"), ai("a2"), user("u3"), ai("a3")];
  t.ok("後ろに自分の発言が 2 件・返答がある", JSON.stringify(tailInfo(history, 2)) === JSON.stringify({ saved: 3, users: 1, files: false, running: false, forkOnly: false, any: true }));
  t.ok("後ろに自分の発言が 1 件（2 件目の発言の後ろ）", tailInfo(history, 0).users === 2 && tailInfo(history, 0).saved === 5);
  t.ok("後ろが返答だけでも「消えるものがある」", tailInfo(history, 4).any === true && tailInfo(history, 4).users === 0 && tailInfo(history, 4).saved === 1);
  t.ok("後ろに何も無ければ帯は要らない", tailInfo(history.slice(0, 5), 4).any === false);
  t.ok("走っている返答があれば、保存済みの後ろが無くても帯は要る", tailInfo(history.slice(0, 5), 4, { running: true }).any === true && tailInfo(history.slice(0, 5), 4, { running: true }).running === true);
  t.ok("スラッシュコマンド・! の行・システム側の行は発言に数えない",
    tailInfo([user("u1"), user("c1", { kind: "shell" }), user("c2", { kind: "command" }), ai("a1")], 0).users === 0);
  t.ok("委譲の完了通知として送った発言（internalTaskNotice）も人の発言に数えない（後ろが通知だけなら「返答」の文）",
    tailInfo([user("u1"), ai("a1"), user("n1", { internalTaskNotice: true })], 0).users === 0);
  t.ok("委譲された作業の会話は forkOnly（同じ会話では送り直せない）", tailInfo(history, 2, { forkOnly: true }).forkOnly === true && tailInfo(history, 2).forkOnly === false);
  t.ok("ファイルを変えた返答が消える範囲にあるときだけ files",
    tailInfo([user("u1"), ai("a1", { toolCalls: [{ id: "x", name: "Edit", input: { file_path: "README.md", old_string: "a", new_string: "b" } }] })], 0).files === true
    && tailInfo([user("u1"), ai("a1", { toolCalls: [{ id: "x", name: "Read", input: { file_path: "README.md" } }] })], 0).files === false);
  t.ok("消える範囲より前のファイルの変更は数えない",
    tailInfo([user("u0"), ai("a0", { toolCalls: [{ id: "x", name: "Write", input: { file_path: "a.md", content: "x" } }] }), user("u1"), ai("a1")], 2).files === false);

  // ---- 帯の文とボタンの名前
  const info = (extra) => ({ saved: 0, users: 0, files: false, running: false, forkOnly: false, any: false, ...extra });
  t.ok("後ろに自分の発言があれば件数を言う", tailLines(info({ saved: 3, users: 2, any: true })).length === 1);
  t.ok("走っている返答・ファイルの変更はそれぞれ 1 行足す", tailLines(info({ saved: 3, users: 1, running: true, files: true, any: true })).length === 3);
  t.ok("走っている返答の文は差し替えられる（スレッドは「このスレッド」）", tailLines(info({ running: true, any: true }), { running: "RUN" })[0] === "RUN");
  t.ok("委譲された作業の会話は 1 行だけ", tailLines(info({ forkOnly: true, saved: 4, users: 2, any: true })).length === 1);
  t.ok("走っていれば［止めて送り直す］、そうでなければ［送り直す］", sendLabels(info({ running: true, any: true })).label !== sendLabels(info({ saved: 1, any: true })).label);
  t.ok("読み上げには消えるものが付く", sendLabels(info({ saved: 2, users: 1, any: true })).aria !== sendLabels(info({ saved: 2, users: 1, any: true })).label);
  t.ok("消えるものが無ければ読み上げはボタンの名前のまま", sendLabels(info()).aria === sendLabels(info()).label);

  // ---- 編集中の引用・変更の判定・書きかけの合流
  t.ok("引用は添付の印の行と空行を飛ばした先頭の 1 行", quoteOf("\n[添付] /a/b.png\n  本題です  \n続き") === "本題です");
  t.ok("引用は 120 字まで", quoteOf("あ".repeat(300)).length === 120 && quoteOf("") === "" && quoteOf("[Attachment] /x") === "");
  const base = { text: "元の文", paths: ["/a.png", "/b.png"] };
  t.ok("何も直していなければ変更なし（添付の並びが違っても同じ）", !changedFrom(base, { text: "元の文", attached: [{ path: "/b.png" }, { path: "/a.png" }] }));
  t.ok("本文を直せば変更あり", changedFrom(base, { text: "元の文!", attached: [{ path: "/a.png" }, { path: "/b.png" }] }));
  t.ok("添付を外す・足すと変更あり", changedFrom(base, { text: "元の文", attached: [{ path: "/a.png" }] }) && changedFrom(base, { text: "元の文", attached: [{ path: "/a.png" }, { path: "/b.png" }, { path: "/c.png" }] }));
  const merged = mergeContent({ text: "編集していた文", attached: [{ path: "/a.png" }] }, { text: "書きかけ", attached: [{ path: "/a.png" }, { path: "/z.png" }] });
  t.ok("編集の相手が消えたら、書きかけを編集していた文の後ろに足す（添付は重ねない）", merged.text === "編集していた文\n\n書きかけ" && merged.attached.map((a) => a.path).join() === "/a.png,/z.png");
  t.ok("書きかけが無ければ編集していた文のまま", mergeContent({ text: "x", attached: [] }, null).text === "x");

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
