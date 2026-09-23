// v1 の受け入れテスト。承認フローが往復し、成果が残り、セッションが指定 cwd に根付くこと。
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { getSessionInfo } from "@anthropic-ai/claude-agent-sdk";

export const name = "acceptance";
export const title = "承認フロー・履歴・提示・状態・cwd";

// Windows はドライブ文字の大小や区切りがぶれるので、比較の前に均す
const samePath = (a, b) => {
  if (!a || !b) return false;
  const norm = (p) => path.resolve(p).replace(/[\\/]+$/, "");
  return process.platform === "win32"
    ? norm(a).toLowerCase() === norm(b).toLowerCase()
    : norm(a) === norm(b);
};

export default async function (t, ctx) {
  const c = await ctx.open({ autoAllow: true });
  try {
    t.ok("ready ハンドシェイク", c.ready.protocolVersion === 3, `protocolVersion=${c.ready.protocolVersion}`);

    const sessions = await c.cmd("listSessions");
    t.ok("listSessions", Array.isArray(sessions) && sessions.length > 0, `${sessions.length} 件`);
    if (!sessions.length) return t.skip("~/.claude にセッションが1件も無い");

    const statuses = await c.cmd("listStatuses");
    t.ok("listStatuses（既出の状態が候補として返る）", Array.isArray(statuses),
         statuses.map((s) => `${s.status}:${s.count}`).join(", ") || "(空)");

    // 既に状態が付いているセッションの履歴を読む
    const tagged = sessions.find((s) => s.status) ?? sessions[0];
    const hist = await c.cmd("loadSession", { sessionId: tagged.id });
    t.ok("loadSession（履歴が返る）",
         Array.isArray(hist?.messages) && hist.messages.length > 0,
         `${hist?.messages?.length ?? 0} メッセージ / ${hist?.presents?.length ?? 0} 提示`);
    t.ok("loadSession（過去の present が復元される）", Array.isArray(hist?.presents),
         hist?.presents?.length ? `${hist.presents.length} 件` : "このセッションには無し");

    // cwd を指定しない新規セッションはホームディレクトリが自動設定される
    const defSession = await c.cmd("newSession", {});
    t.ok("cwd 未指定の新規セッションはホームディレクトリになる", samePath(defSession.cwd, os.homedir()), defSession.cwd);

    // 承認が要るツール（Write）を踏ませ、present も出させる。
    // 絶対パスで指示する。相対パスにするとモデルが勝手に絶対化して行き先がぶれ、
    // 「システムが cwd を守っているか」ではなく「モデルのパス推測」を測ることになる。
    const outFile = path.join(ctx.work, "smoke-out.md");
    const turn = await c.runTurn({
      prompt:
        `次を順にやって。説明は最短でよい。\n` +
        `1. Write ツールで ${outFile} に "# smoke v1" と1行だけ書く\n` +
        `2. present ツールで kind:"text" として "承認フロー往復OK" を表示する\n` +
        `3. set_status ツールで状態を「v1検証」にする`,
      sessionId: null,
      cwd: ctx.work,
      mode: "default",   // 承認フローを見るテストなので、全体の既定に左右されないよう明示する
    });

    t.ok("permission イベントが飛ぶ", turn.permissions.length > 0,
         turn.permissions.map((p) => p.toolName).join(", ") || "来なかった");
    const present = turn.events.find((e) => e.type === "present");
    t.ok("present イベントが飛ぶ", Boolean(present), present ? `kind=${present.kind}` : "来なかった");
    const status = turn.events.find((e) => e.type === "status");
    t.ok("status イベントが飛ぶ", Boolean(status), status?.status ?? "来なかった");

    const newId = turn.sessionId;
    t.ok("新規セッションの id が確定する", Boolean(newId), newId ?? "");

    if (newId) {
      const back = await c.cmd("loadSession", { sessionId: newId });
      t.ok("新規セッションの present が永続化されている",
           (back?.presents?.length ?? 0) > 0, `${back?.presents?.length ?? 0} 件`);

      const after = await c.cmd("listSessions");
      const me = after.find((s) => s.id === newId);
      t.ok("状態が一覧に反映される", me?.status === "v1検証", me?.status ?? "(なし)");
      t.ok("statusChangedAt が記録される", Boolean(me?.statusChangedAt), me?.statusChangedAt ?? "");

      // 指定した cwd にセッションが根付いているか（ここがシステムの責任範囲）
      const info = await getSessionInfo(newId).catch(() => null);
      t.ok("セッションが指定 cwd に根付く", samePath(info?.cwd, ctx.work), info?.cwd ?? "(不明)");
    }

    t.ok("承認したツールが指定 cwd 配下で実行された",
         await fs.access(outFile).then(() => true, () => false), outFile);
  } finally {
    c.close();
  }
}
