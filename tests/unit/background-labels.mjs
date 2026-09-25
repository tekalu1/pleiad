// バックグラウンドのダイアログ（docs/design-system.md「バックグラウンド」）のモデル名。
//   - 記録にある生の id を、一覧の名前か Claude の id の形から読む
//   - Claude の記録の assistant 行からモデルを拾う（合成の行は拾わない）
import { modelDisplayName } from "../../web/composer-labels.mjs";
import { transcriptToMessages } from "../../core/backends/claude-normalize.mjs";

export const name = "background-labels";
export const title = "バックグラウンドの一覧に出すモデル名";

export default function (t) {
  const models = { "": { label: "既定" }, "gpt-6-luna": { label: "GPT-6 Luna" }, sonnet: { label: "Sonnet 5", resolvedModel: "claude-sonnet-5", hidden: true } };
  t.ok("一覧にある id はその名前", modelDisplayName(models, "gpt-6-luna") === "GPT-6 Luna");
  t.ok("解決先の id が一致すれば、その行の名前", modelDisplayName(models, "claude-sonnet-5") === "Sonnet 5");
  t.ok("一覧に無い Claude の id は系統と版を読む",
    modelDisplayName({}, "claude-opus-5-5") === "Opus 5.5" && modelDisplayName({}, "claude-haiku-4-5-20251001") === "Haiku 4.5",
    `${modelDisplayName({}, "claude-opus-5-5")} / ${modelDisplayName({}, "claude-haiku-4-5-20251001")}`);
  t.ok("読めない id はそのまま", modelDisplayName({}, "gemini-3.8-flash") === "gemini-3.8-flash");
  t.ok("id が無ければ空", modelDisplayName(models, null) === "");

  const msgs = transcriptToMessages([
    { type: "assistant", uuid: "a1", parent_tool_use_id: "t1", message: { model: "claude-sonnet-5", content: [{ type: "text", text: "調べた" }] } },
    { type: "assistant", uuid: "a2", parent_tool_use_id: "t1", message: { model: "<synthetic>", content: [{ type: "text", text: "合成" }] } },
  ], { includeNested: true });
  t.ok("assistant 行のモデルを拾う", msgs[0]?.model === "claude-sonnet-5", JSON.stringify(msgs[0]));
  t.ok("合成の行（<synthetic>）はモデルにしない", msgs[1] && !("model" in msgs[1]), JSON.stringify(msgs[1]));
}
