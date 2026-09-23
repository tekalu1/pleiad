// 入力欄の設定のチップが使うもの（docs/design-system.md「入力欄の設定」）。
//
//   - 作業ディレクトリの簡易ブラウザー（listDirs）: フォルダーだけを返す・読めないときは理由で断る
//   - 「既定」が実際に何かの解決: Claude は SDK の supportedModels() の行から、fake は一覧の resolvesTo から
//   - エフォートの段と既定の段（effortOptions の resolvesTo / isDefault）
// LLM も Claude の CLI も呼ばない（SDK の行は実機で取った形を写してある）。
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { listDirs } from "../../core/list-dirs.mjs";
import { buildClaudeModels, labelOf, labelFromId, FALLBACK_MODELS } from "../../core/backends/claude-models.mjs";
import { effortOptions } from "../../core/effort.mjs";
import { startServer } from "../lib/server.mjs";
import { open } from "../lib/ws-client.mjs";

export const name = "composer-settings";
export const title = "入力欄の設定: フォルダーの一覧・既定の解決・エフォートの既定";

// supportedModels() の実際の返り（2026-09、CLI 同梱の SDK 0.3.258。settingSources: []）
const ROWS = [
  { value: "default", resolvedModel: "claude-opus-5-5[1m]", displayName: "Default (recommended)", description: "Opus 5.5 with 1M context · Best for everyday, complex tasks", supportsEffort: true, supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"] },
  { value: "opus[1m]", resolvedModel: "claude-opus-5-5[1m]", displayName: "Opus (1M context)", description: "Opus 5.5 with 1M context · Best for everyday, complex tasks", supportsEffort: true, supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"] },
  { value: "claude-fable-5-1[1m]", resolvedModel: "claude-fable-5-1", displayName: "Fable", description: "Fable 5.1 · Most capable for your hardest and longest-running tasks", supportsEffort: true, supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"] },
  { value: "sonnet", resolvedModel: "claude-sonnet-5", displayName: "Sonnet", description: "Sonnet 5 · Efficient for routine tasks", supportsEffort: true, supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"] },
  { value: "haiku", resolvedModel: "claude-haiku-4-5-20251001", displayName: "Haiku", description: "Haiku 4.5 · Fastest for quick answers" },
];
const EFFORTS = { "opus[1m]": "medium", "claude-fable-5-1[1m]": "high", sonnet: "high" };

export default async function (t) {
  // ---- フォルダーの一覧
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "ply-listdirs-"));
  try {
    await fs.mkdir(path.join(scratch, "beta"));
    await fs.mkdir(path.join(scratch, "Alpha"));
    await fs.mkdir(path.join(scratch, "item10"));
    await fs.mkdir(path.join(scratch, "item9"));
    await fs.writeFile(path.join(scratch, "note.txt"), "x");
    const r = await listDirs(scratch);
    t.ok("フォルダーだけを名前順（大文字小文字を区別しない・数字は数として）で返す",
      JSON.stringify(r.dirs) === JSON.stringify(["Alpha", "beta", "item9", "item10"]), JSON.stringify(r.dirs));
    t.ok("開いたフォルダーの絶対パスと親を返す", r.path === path.resolve(scratch) && r.parent === path.dirname(path.resolve(scratch)), `${r.path} / ${r.parent}`);
    const home = await listDirs("");
    t.ok("空ならホームを開く", home.path === path.resolve(os.homedir()), home.path);
    const top = await listDirs(path.parse(scratch).root);
    t.ok("一番上の階層は親が無く、ドライブの一覧を添える（Windows）", top.parent === null && (process.platform !== "win32" || top.roots.length > 0), JSON.stringify(top.roots));
    const missing = await listDirs(path.join(scratch, "nope")).then(() => null, (e) => e.message);
    t.ok("無いフォルダーは理由の一文で断る", /見つかりません/.test(missing ?? ""), missing);
    const file = await listDirs(path.join(scratch, "note.txt")).then(() => null, (e) => e.message);
    t.ok("ファイルは開かない", /フォルダーではありません/.test(file ?? ""), file);
    const bad = await listDirs({}).then(() => null, (e) => e.message);
    t.ok("文字列以外のパスは断る", /不正/.test(bad ?? ""), bad);

    // サーバーのコマンドとして（fake バックエンドで起こす）
    const server = await startServer({ dataDir: path.join(scratch, "data"), env: { AGENT_HOST_BACKENDS: "fake" } });
    const c = await open({ port: server.port, token: server.token });
    try {
      const viaWs = await c.cmd("listDirs", { path: scratch });
      t.ok("listDirs コマンドがフォルダーの名前を返す", viaWs.dirs.includes("Alpha") && !viaWs.dirs.includes("note.txt"), JSON.stringify(viaWs.dirs));
      const err = await c.cmd("listDirs", { path: path.join(scratch, "nope") }).then(() => null, (e) => e.message);
      t.ok("読めないフォルダーはエラーの応答になる（接続は切れない）", /見つかりません/.test(err ?? ""), err);
      const models = await c.cmd("models", { backend: "fake" });
      t.ok("fake の既定は実際のモデルに解決される", models[""].resolvesTo === "smart" && models[models[""].resolvesTo]?.label === "Smart 3.5", JSON.stringify(models[""]));
      const efforts = await c.cmd("efforts", { backend: "fake", model: "" });
      t.ok("efforts の既定（''）が実際の段を持ち、その段に既定の印が付く", efforts[""].resolvesTo === "medium" && efforts.medium?.isDefault === true && !efforts.low?.isDefault, JSON.stringify(efforts));
      const tiny = await c.cmd("efforts", { backend: "fake", model: "tiny" });
      t.ok("段を持たないモデルは「既定に従う」だけ", JSON.stringify(Object.keys(tiny)) === '[""]', JSON.stringify(tiny));
      const fast = await c.cmd("efforts", { backend: "fake", model: "fast" });
      t.ok("モデルごとの既定の段", fast[""].resolvesTo === "low" && fast.low?.isDefault === true, JSON.stringify(fast));
      // 以前は全段を受けた。段の無いモデルに保存済みの段が残っていても、送信は止めない（既定に戻す）
      const { sessionId } = await c.cmd("newSession", { backend: "fake", cwd: scratch });
      await c.cmd("setTurnSettings", { sessionId, effort: "high", rememberEffort: true });
      await c.runTurn({ sessionId, prompt: "echo:段あり" });
      await c.cmd("setTurnSettings", { sessionId, model: "tiny" });
      const row = (await c.cmd("listSessions")).find((s) => s.id === sessionId);
      t.ok("段の無いモデルへ切り替えると段の予約は既定に戻る", row.nextSettings?.effort === "", JSON.stringify(row.nextSettings));
      const turn = await c.runTurn({ sessionId, prompt: "echo:段なし" });
      t.ok("段の無いモデルでも送信できる", turn.outcome === "ok", turn.outcome);
    } finally { c.close(); await server.stop(); }
  } finally { await fs.rm(scratch, { recursive: true, force: true }); }

  // ---- Claude の一覧（SDK の行から）
  t.ok("版付きの名前: description の先頭を使い、1M の印を短くする",
    labelOf(ROWS[1]) === "Opus 5.5 (1M)" && labelOf(ROWS[2]) === "Fable 5.1" && labelOf(ROWS[3]) === "Sonnet 5" && labelOf(ROWS[4]) === "Haiku 4.5",
    ROWS.map(labelOf).join(" / "));
  t.ok("description が読めなければ resolvedModel から作る",
    labelOf({ value: "x", resolvedModel: "claude-haiku-4-5-20251001", description: "" }) === "Haiku 4.5" && labelFromId("claude-opus-5-5[1m]") === "Opus 5.5 (1M)");
  const m = buildClaudeModels({ rows: ROWS, efforts: EFFORTS });
  t.ok("一覧は SDK の行（default の行は ''）", ["opus[1m]", "claude-fable-5-1[1m]", "sonnet", "haiku"].every((k) => m[k] && !m[k].hidden) && !("default" in m), Object.keys(m).join(","));
  t.ok("以前の別名（opus / fable）は隠して有効のまま残す", m.opus?.hidden === true && m.fable?.hidden === true && m.opus.label === "Opus 5.5", JSON.stringify(m.opus));
  t.ok("設定が無ければ既定は SDK の既定の行（アカウントの既定）に当たる", m[""].resolvesTo === "opus[1m]" && m[""].defaultEffort === "medium", JSON.stringify(m[""]));
  t.ok("モデルごとの段と既定の段", m.sonnet.defaultEffort === "high" && m.haiku.efforts.length === 0 && m.haiku.defaultEffort === null);
  t.ok("設定のモデル（エイリアス）に当てる", buildClaudeModels({ rows: ROWS, efforts: EFFORTS, preferred: "sonnet" })[""].resolvesTo === "sonnet");
  t.ok("設定のモデル（完全な id）は同じ実体の行か、同じ系統の別名に当てる",
    buildClaudeModels({ rows: ROWS, preferred: "claude-sonnet-5" })[""].resolvesTo === "sonnet"
    && buildClaudeModels({ rows: ROWS, preferred: "claude-opus-5-5" })[""].resolvesTo === "opus");
  const pe = buildClaudeModels({ rows: ROWS, efforts: EFFORTS, preferredEffort: "xhigh" });
  t.ok("設定の effortLevel は対応する段なら既定の段になる（段の無いモデルには付けない）",
    pe[""].defaultEffort === "xhigh" && pe.sonnet.defaultEffort === "xhigh" && pe.haiku.defaultEffort === null, JSON.stringify(pe[""]));
  t.ok("行が取れなければ固定の一覧に戻す", buildClaudeModels({ rows: [] }) === FALLBACK_MODELS && buildClaudeModels({}) === FALLBACK_MODELS);
  const claudeStub = { id: "claude", models: async () => m };
  const haikuEfforts = await effortOptions(claudeStub, "haiku");
  const defEfforts = await effortOptions(claudeStub, "");
  t.ok("Claude のエフォートはモデルの段に従う（Haiku は段なし、既定は opus の medium）",
    JSON.stringify(Object.keys(haikuEfforts)) === '[""]' && defEfforts[""].resolvesTo === "medium" && defEfforts.max && defEfforts.medium.isDefault,
    JSON.stringify(defEfforts[""]));
}
