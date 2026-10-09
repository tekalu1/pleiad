// ply_delegate の model に AI が正式な ID（claude-sonnet-5-5 など）を書いても、一覧の行に当てる（core/backends/claude-models.mjs の matchClaudeModel）。
// 実際の CLI は呼ばず、setClaudeSdkForTest で一覧を差し替えて確かめる。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { backend as claude, setClaudeSdkForTest } from "../../core/backends/claude.mjs";

export const name = "claude-model-match";
export const title = "Claude のモデル名: 正式な ID・系統名を一覧の行に当て、当たらない名前は null";

const ROWS = [
  { value: "sonnet", resolvedModel: "claude-sonnet-5-5", description: "Sonnet 5.5 · test" },
  { value: "opus", resolvedModel: "claude-opus-5-5", description: "Opus 5.5 · test" },
  { value: "opus[1m]", resolvedModel: "claude-opus-5-5[1m]", description: "Opus 5.5 with 1M context · test" },
  { value: "haiku", resolvedModel: "claude-haiku-4-5-20251001", description: "Haiku 4.5 · test" },
];

export default async function (t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-model-match-"));
  const exe = path.join(dir, "claude-fake-cli");
  fs.writeFileSync(exe, "match-v1");   // 他のテストが覚えた一覧と目印が食い違うので、一覧は忘れた状態から始まる
  const cwd = path.join(dir, "work");
  fs.mkdirSync(cwd);
  const restore = setClaudeSdkForTest({
    executable: () => exe,
    cliSigThrottleMs: 0,
    probe: () => Promise.resolve({ rows: ROWS, efforts: {}, applied: true }),
  });
  try {
    await claude.models(cwd);
    t.ok("（前提）正式な ID は一覧の id ではないので、そのままでは無効", await claude.validModel("claude-sonnet-5-5", cwd) === false);
    t.ok("正式な ID は resolvedModel が一致する行に当たる", await claude.matchModel("claude-sonnet-5-5", cwd) === "sonnet");
    t.ok("1M の正式な ID は 1M の行に当たる", await claude.matchModel("claude-opus-5-5[1m]", cwd) === "opus[1m]");
    t.ok("大文字小文字は問わない", await claude.matchModel("Claude-Sonnet-5-5", cwd) === "sonnet");
    t.ok("版が一覧に無い正式な ID は、同じ系統の行に当たる", await claude.matchModel("claude-opus-4-1", cwd) === "opus");
    t.ok("版が一覧に無い 1M の ID は、同じ系統の 1M の行に当たる", await claude.matchModel("claude-opus-4-1[1m]", cwd) === "opus[1m]");
    t.ok("系統名だけでも当たる", await claude.matchModel("Haiku", cwd) === "haiku");
    t.ok("知らない名前は当たらない（null）", await claude.matchModel("no-such-model", cwd) === null && await claude.matchModel("gpt-5", cwd) === null);
    t.ok("空の名前は当たらない", await claude.matchModel("", cwd) === null);
  } finally {
    restore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
