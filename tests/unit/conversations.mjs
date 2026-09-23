import { mergeMessages } from "../../core/conversations.mjs";
export const name = "conversations";
export const title = "統合履歴は圧縮と繰り返し発言で欠落しない";
export default function(t) {
  const r = { base: 1, messages: [{ uuid: "old", text: "previous engine" },
    { uuid: "a", role: "user", text: "first request" }], injected: "injected context", original: "original request" };
  mergeMessages(r, [{ uuid: "b", role: "user", text: "later request" }], "codex");
  t.ok("ネイティブで圧縮された発言を残す", r.messages.map(m => m.uuid).join() === "old,a,b");
  t.ok("圧縮後の先頭発言を書き換えない", r.messages[2].text === "later request");
  mergeMessages(r, [{ uuid: "b", role: "user", text: "later request" }], "codex");
  t.ok("同じ履歴の読み直しで重複しない", r.messages.length === 3);
  t.ok("発言の生成元を保存", r.messages[2].backend === "codex");
  const noIds = { base: 0, messages: [] };
  const repeated = [{ role: "user", text: "again" }, { role: "user", text: "again" }];
  mergeMessages(noIds, repeated, "codex");
  mergeMessages(noIds, repeated, "codex");
  t.ok("IDがない同文の発言もそれぞれ残す", noIds.messages.length === 2);
  const reused = { base: 1, nativeId: "child", messages: [{ role: "user", uuid: "u1", text: "prefix" }] };
  mergeMessages(reused, [{ role: "user", uuid: "u1", text: "continuation" }], "codex");
  mergeMessages(reused, [{ role: "user", uuid: "u1", text: "continuation" }], "codex");
  t.ok("別実行の同じネイティブIDを分岐点として区別", reused.messages.length === 2 && reused.messages[1].uuid !== "u1");
  const largeImgMsg = [{ role: "assistant", toolCalls: [{ name: "imageGeneration", result: {
    text: JSON.stringify({ type: "imageGeneration", savedPath: "C:/images/test.png", result: "A".repeat(20000) })
  } }] }];
  mergeMessages(r, largeImgMsg, "codex");
  const parsedRes = JSON.parse(r.messages.at(-1).toolCalls[0].result.text);
  t.ok("画像生成の巨大Base64はサニタイズされる", parsedRes.result === "[image saved to C:/images/test.png]");
}
