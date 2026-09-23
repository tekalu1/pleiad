// ロード済み thread/resume が以前の設定を返しても、次の turn には選択を適用する。
// 子プロセスも LLM も使わず、実バックエンドと状態を持つ RPC の境界を検証する。
import { backend } from "../../core/backends/codex.mjs";
import { rpc } from "../../core/backends/codex-rpc.mjs";

export const name = "codex-mode";
export const title = "既存 Codex 会話の承認モードをターンごとに更新する";

export default async function (t) {
  const originals = { request: rpc.request, attach: rpc.attach, claimOrphan: rpc.claimOrphan };
  const threads = new Map();
  let handlers;
  let sequence = 0;
  let lastTurn;
  let lastThread;
  let asked = 0;
  const sandbox = { type: "workspaceWrite", writableRoots: [process.cwd()], networkAccess: false, excludeSlashTmp: true };

  rpc.attach = (_id, h) => { handlers = h; return () => {}; };
  rpc.claimOrphan = (h) => { handlers = h; return () => {}; };
  rpc.request = async (method, params) => {
    if (method === "config/read") return { config: { model_reasoning_effort: "medium" } };
    if (method === "model/list") return { data: [] };
    if (method === "thread/start") {
      lastThread = params;
      const thread = { id: `thread-${++sequence}` };
      const initialSandbox = params.sandbox === "danger-full-access" ? { type: "dangerFullAccess" }
        : params.sandbox === "read-only" ? { type: "readOnly", networkAccess: false } : sandbox;
      const state = { thread, approvalPolicy: params.approvalPolicy, sandbox: initialSandbox };
      threads.set(thread.id, state);
      return state;
    }
    const state = threads.get(params.threadId);
    // 既存会話の設定を保持する。resume の引数を反射するだけの fake では回帰を見逃す。
    if (method === "thread/resume") { lastThread = params; return state; }
    if (method !== "turn/start") throw new Error(`unexpected RPC: ${method}`);
    if (params.approvalPolicy != null) state.approvalPolicy = params.approvalPolicy;
    if (params.sandboxPolicy != null) state.sandbox = params.sandboxPolicy;
    lastTurn = params;
    const turnId = `turn-${++sequence}`;
    const h = handlers;
    const escalated = params.input[0].text === "escalate";
    queueMicrotask(async () => {
      try {
        if (state.approvalPolicy === "untrusted" || (state.approvalPolicy === "on-request" && escalated)) {
          await h.onRequest("item/commandExecution/requestApproval", {
            threadId: params.threadId, itemId: "command", command: "echo test",
          });
        }
        h.onNotification("turn/completed", { turn: { id: turnId, status: "completed" } });
      } catch (err) {
        h.onGone(err);
      }
    });
    return { turn: { id: turnId } };
  };

  const run = async (mode, sessionId, prompt = "normal", effort) => {
    const before = asked;
    const events = [];
    const result = await backend.runTurn({
      mode, sessionId, effort, cwd: process.cwd(), prompt,
      emit: (e) => events.push(e),
      askPermission: async () => { asked++; return { allow: true }; },
    });
    t.ok(`${mode}: ターンが完了`, events.some((e) => e.type === "turnResult" && e.outcome === "ok"));
    return { id: result.sessionId, approvals: asked - before, policy: threads.get(result.sessionId).approvalPolicy,
      sandbox: threads.get(result.sessionId).sandbox };
  };

  try {
    t.ok("UI 用の選択肢に YOLO とアクセス範囲の説明がある",
      backend.modes().yolo?.label === "YOLO" && backend.modes().yolo.note.includes("全ファイル"));
    const initial = await run("ask");
    t.ok("ask: 確認あり", initial.approvals === 1 && initial.policy === "untrusted");
    await run("ask", initial.id, "normal", "high");
    t.ok("再開ターンに effort を渡す", lastTurn.effort === "high");
    await run("ask", initial.id, "normal", "");
    t.ok("既定に戻すと前の effort を上書きする", lastTurn.effort === "medium");
    const auto = await run("auto", initial.id);
    t.ok("ask → auto: 通常操作は確認なし", auto.approvals === 0 && auto.policy === "on-request");
    const escalated = await run("auto", initial.id, "escalate");
    t.ok("auto: 明示された承認要求は人間に届ける", escalated.approvals === 1);
    const full = await run("full", initial.id, "escalate");
    t.ok("auto → full: never に更新される", full.approvals === 0 && full.policy === "never");
    t.ok("同じ sandbox の追加ルート・一時ディレクトリ設定を保持する",
      JSON.stringify(full.sandbox) === JSON.stringify(sandbox));
    const back = await run("ask", initial.id);
    t.ok("full → ask: 確認ありに戻る", back.approvals === 1 && back.policy === "untrusted");
    const fresh = await run("full");
    t.ok("新規 full も確認なし", fresh.approvals === 0 && fresh.policy === "never");
    const invalid = await run("unknown", initial.id);
    t.ok("不明な mode は確認ありに戻る", invalid.approvals === 1 && invalid.policy === "untrusted");

    const yolo = await run("yolo", initial.id);
    t.ok("既存会話の YOLO は確認なし・制限解除", yolo.policy === "never" && yolo.approvals === 0
      && JSON.stringify(yolo.sandbox) === JSON.stringify({ type: "dangerFullAccess" }));
    t.ok("resume にも YOLO の設定を送る", lastThread.sandbox === "danger-full-access" && lastThread.approvalPolicy === "never");
    for (const [mode, policy, type] of [
      ["full", "never", "workspaceWrite"],
      ["auto", "on-request", "workspaceWrite"],
      ["ask", "untrusted", "workspaceWrite"],
      ["readonly", "on-request", "readOnly"],
      ["unknown", "untrusted", "workspaceWrite"],
    ]) {
      await run("yolo", initial.id);
      const restored = await run(mode, initial.id);
      t.ok(`YOLO → ${mode}: 承認設定と sandbox 制限を復元`, restored.policy === policy
        && restored.sandbox.type === type && restored.sandbox.networkAccess === false);
    }
    const freshYolo = await run("yolo");
    t.ok("新規 YOLO も両方の設定を送る", lastThread.sandbox === "danger-full-access"
      && lastThread.approvalPolicy === "never" && lastTurn.sandboxPolicy.type === "dangerFullAccess"
      && freshYolo.policy === "never");
  } finally {
    Object.assign(rpc, originals);
  }
}
