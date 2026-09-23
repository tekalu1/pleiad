// 入力欄の設定: Antigravity と procway-code（docs/design-system.md「入力欄の設定」）。
//
//   - `agy models`（id<TAB>表示名）の読み取り、段違いの系統へのまとめ、既定のモデル（ログの label）
//   - 段 → agy に渡す引数（--model と --effort を同時に渡さない）
//   - エフォートの段（既定が分からないときに「既定」の段を作らない）と、段の候補（effortOptions）
//   - procway-code のモデルのチップの字
// プロセスも LLM も呼ばない（`agy models` の行は agy 1.2.8 の実際の出力を写してある）。
import { parseAgyModels, defaultLabelFromLog, buildAgyModels, agyTarget } from "../../core/backends/antigravity-models.mjs";
import { effortOptions } from "../../core/effort.mjs";
import { resolvedModel, effortStops, modelChipLabel, modelRowIds, holdsDefault, procwayChipLabel, procwayTypeLabel, middleEllipsis } from "../../web/composer-labels.mjs";

export const name = "composer-agy-procway";
export const title = "入力欄の設定: Antigravity の段違いと既定・procway-code のチップ";

const TAB = String.fromCharCode(9), NL = String.fromCharCode(10), CR = String.fromCharCode(13);
// `agy models` の実際の出力（agy 1.2.8、2026-09-23）
const OUTPUT = [
  "Fetching available models...",
  ["gemini-3.8-flash-high", "Gemini 3.8 Flash (High)"],
  ["gemini-3.8-flash-medium", "Gemini 3.8 Flash (Medium)"],
  ["gemini-3.8-flash-low", "Gemini 3.8 Flash (Low)"],
  ["gemini-3.1-pro-high", "Gemini 3.1 Pro (High)"],
  ["gemini-3.1-pro-low", "Gemini 3.1 Pro (Low)"],
  ["claude-sonnet-4-6", "Claude Sonnet 4.6 (Thinking)"],
  ["claude-opus-4-6-thinking", "Claude Opus 4.6 (Thinking)"],
  ["gpt-oss-120b-medium", "GPT-OSS 120B (Medium)"],
].map((l) => (Array.isArray(l) ? l.join(TAB) : l)).join(CR + NL) + CR + NL;
const LOG = 'I0923 03:02:52.462073       1 model_config_manager.go:327] Propagating selected model override to backend: label="Gemini 3.8 Flash (High)"';

export default async function (t) {
  // ---- agy models の読み取り
  const rows = parseAgyModels(OUTPUT);
  t.ok("見出しを捨て、id と表示名を読む（CRLF でも）",
    rows.length === 8 && rows[0].id === "gemini-3.8-flash-high" && rows[0].label === "Gemini 3.8 Flash (High)" && rows[7].label === "GPT-OSS 120B (Medium)",
    JSON.stringify(rows.slice(0, 2)));
  t.ok("表示名の無い行（古い形）は id を名前にする",
    JSON.stringify(parseAgyModels("Fetching available models..." + NL + "fake-1" + NL + "fake-2  説明" + NL)) === JSON.stringify([{ id: "fake-1", label: "fake-1" }, { id: "fake-2", label: "説明" }]));
  t.ok("ログから既定のモデルの表示名を読む（無ければ null）", defaultLabelFromLog("x" + NL + LOG + NL) === "Gemini 3.8 Flash (High)" && defaultLabelFromLog("nothing") === null);

  // ---- 系統にまとめる
  const m = buildAgyModels(rows, defaultLabelFromLog(LOG));
  t.ok("段違いはすべて id のまま残し、系統の名前（段の印を除いた表示名）を付ける",
    ["gemini-3.8-flash-high", "gemini-3.8-flash-medium", "gemini-3.8-flash-low"].every((id) => m[id]?.label === "Gemini 3.8 Flash" && m[id].family === "gemini-3.8-flash"),
    JSON.stringify(m["gemini-3.8-flash-low"]));
  t.ok("系統の段は弱い順・その id の段が defaultEffort",
    JSON.stringify(m["gemini-3.8-flash-low"].efforts) === '["low","medium","high"]' && m["gemini-3.8-flash-low"].defaultEffort === "low"
      && JSON.stringify(m["gemini-3.1-pro-high"].efforts) === '["low","high"]',
    JSON.stringify(m["gemini-3.1-pro-high"]));
  t.ok("表に出すのは系統ごとに 1 つ（既定を含む系統は既定、無ければ medium、無ければ先頭）",
    !m["gemini-3.8-flash-high"].hidden && m["gemini-3.8-flash-medium"].hidden && m["gemini-3.8-flash-low"].hidden
      && !m["gemini-3.1-pro-high"].hidden && m["gemini-3.1-pro-low"].hidden);
  t.ok("段違いの無いモデルは表示名のまま・段なし（(Thinking) や 1 つだけの (Medium) はまとめない）",
    m["claude-sonnet-4-6"].label === "Claude Sonnet 4.6 (Thinking)" && m["claude-sonnet-4-6"].efforts.length === 0 && !m["claude-sonnet-4-6"].family
      && m["gpt-oss-120b-medium"].label === "GPT-OSS 120B (Medium)" && m["gpt-oss-120b-medium"].efforts.length === 0,
    JSON.stringify(m["gpt-oss-120b-medium"]));
  t.ok("既定はログの表示名で引いた id", m[""].resolvesTo === "gemini-3.8-flash-high" && m[""].defaultEffort === "high", JSON.stringify(m[""]));
  const unknown = buildAgyModels(rows, null);
  t.ok("既定が分からなければ「既定（agy の設定）」で段は選べない（理由を添える）",
    unknown[""].label === "既定（agy の設定）" && !unknown[""].resolvesTo && unknown[""].efforts.length === 0 && Boolean(unknown[""].effortReason)
      && !unknown["gemini-3.8-flash-medium"].hidden,
    JSON.stringify(unknown[""]));
  t.ok("一覧が引けていないときも同じ", buildAgyModels([], null)[""].label === "既定（agy の設定）");

  // ---- agy に渡す引数
  t.ok("段が無ければ model だけ（'' なら何も渡さない）",
    JSON.stringify(agyTarget("", "", m)) === "{}" && agyTarget("gemini-3.1-pro-low", "", m).model === "gemini-3.1-pro-low");
  t.ok("段があれば同じ系統の段違いの id に解決し、--effort は渡さない",
    JSON.stringify(agyTarget("gemini-3.8-flash-low", "high", m)) === '{"model":"gemini-3.8-flash-high"}'
      && JSON.stringify(agyTarget("", "low", m)) === '{"model":"gemini-3.8-flash-low"}');
  t.ok("系統に無い段・段の無いモデルでは段を捨てる",
    JSON.stringify(agyTarget("gemini-3.1-pro-high", "medium", m)) === '{"model":"gemini-3.1-pro-high"}'
      && JSON.stringify(agyTarget("claude-sonnet-4-6", "high", m)) === '{"model":"claude-sonnet-4-6"}');
  t.ok("一覧も既定も分からないときは素の --effort だけ（agy が選ばれているモデルに当てる）",
    JSON.stringify(agyTarget("", "low", unknown)) === '{"effort":"low"}' && JSON.stringify(agyTarget("x-1", "low", {})) === '{"model":"x-1"}');

  // ---- エフォートの候補（core/effort.mjs）
  const agy = { id: "antigravity", models: async () => m };
  const def = await effortOptions(agy, "");
  t.ok("antigravity の段は既定のモデルの系統から出し、既定の段に印",
    JSON.stringify(Object.keys(def)) === '["","low","medium","high"]' && def[""].resolvesTo === "high" && def.high.isDefault && def.low.note === "gemini-3.8-flash-low",
    JSON.stringify(def));
  const legacy = await effortOptions(agy, "gemini-3.8-flash-low");
  t.ok("以前の会話が持つ段違いの id でも段が出る（今の段は low）", legacy[""].resolvesTo === "low" && legacy.low.isDefault, JSON.stringify(legacy[""]));
  const none = await effortOptions({ id: "antigravity", models: async () => unknown }, "");
  t.ok("既定が分からないときは段なしで理由を返す", JSON.stringify(Object.keys(none)) === '[""]' && Boolean(none[""].reason), JSON.stringify(none));

  // ---- 画面の字（web/composer-labels.mjs）
  const efforts = { "": { resolvesTo: "high" }, low: {}, medium: {}, high: {} };
  t.ok("チップ: 段違いの id を選んでいても系統の名前 · 段",
    modelChipLabel(m, "gemini-3.8-flash-low", { "": { resolvesTo: "low" }, low: {}, medium: {}, high: {} }, "") === "Gemini 3.8 Flash · low"
      && modelChipLabel(m, "", efforts, "") === "Gemini 3.8 Flash · high"
      && modelChipLabel(m, "gemini-3.8-flash-low", { "": { resolvesTo: "low" }, low: {}, medium: {}, high: {} }, "high") === "Gemini 3.8 Flash · high");
  t.ok("チップ: 既定が分からなければ「既定（agy の設定）」だけ", modelChipLabel(unknown, "", { "": {} }, "") === "既定（agy の設定）" && resolvedModel(unknown, "").label === "既定（agy の設定）");
  const stopsUnknown = effortStops({ "": {}, minimal: {}, low: {}, medium: {}, high: {} }, "");
  t.ok("既定の段が分からないときは「既定」の段を作らず、つまみを出さない（unset）",
    JSON.stringify(stopsUnknown.stops) === '["minimal","low","medium","high"]' && stopsUnknown.def === null && stopsUnknown.current === "" && stopsUnknown.unset === true,
    JSON.stringify(stopsUnknown));
  const stopsKnown = effortStops(efforts, "");
  t.ok("既定の段が分かれば、それが今の段", stopsKnown.current === "high" && stopsKnown.def === "high" && !stopsKnown.unset, JSON.stringify(stopsKnown));
  t.ok("既定の段が分からず既定に従うときは、チップに段を書かない", modelChipLabel({ "": { label: "既定に従う" } }, "", { "": {}, low: {} }, "") === "既定に従う");
  const ids = modelRowIds(m, "gemini-3.8-flash-low");
  t.ok("一覧は系統ごとに 1 行で、選んでいる段違いの id がその系統を代表する",
    JSON.stringify(ids) === JSON.stringify(["gemini-3.8-flash-low", "gemini-3.1-pro-high", "claude-sonnet-4-6", "claude-opus-4-6-thinking", "gpt-oss-120b-medium"]),
    JSON.stringify(ids));
  t.ok("選んでいなければ既定の id が代表し、系統の行に既定の札",
    modelRowIds(m, "")[0] === "gemini-3.8-flash-high" && holdsDefault(m, "gemini-3.8-flash-low") && !holdsDefault(m, "gemini-3.1-pro-high"));

  // ---- procway-code のチップ
  t.ok("procway: 接続先 · モデル（段が決まっていれば · 段）",
    procwayChipLabel({ connection: "local", model: "lfm2.5-2.6b" }).text === "local · lfm2.5-2.6b"
      && procwayChipLabel({ connection: "仕事用", model: "gpt-5.6", effort: "high" }).text === "仕事用 · gpt-5.6 · high");
  const long = procwayChipLabel({ connection: "とても長い接続先の名前をつけた場合の例", model: "accounts/fireworks/models/qwen3-coder-480b-a35b-instruct", effort: "medium" });
  t.ok("procway: 長い名前とモデル ID は真ん中を詰め、段は削らない。全体は full に",
    long.text.endsWith(" · medium") && long.text.length < 60 && long.text.includes("…")
      && long.full === "とても長い接続先の名前をつけた場合の例 · accounts/fireworks/models/qwen3-coder-480b-a35b-instruct · medium",
    long.text);
  t.ok("procway: 接続先が無ければ選ぶよう促す", procwayChipLabel({}).text === "接続先を選ぶ");
  t.ok("procway: 接続方式の説明", procwayTypeLabel("openai") === "API · OpenAI" && procwayTypeLabel("cli-agent") === "CLI エージェント" && procwayTypeLabel("x") === "x");
  t.ok("真ん中を詰める", middleEllipsis("abcdefghij", 5) === "ab…ij" && middleEllipsis("abc", 5) === "abc");
}
