// 互換の接続先の配線（server）。codex の身代わり（tests/lib/fake-codex.mjs）と偽の互換 API（tests/lib/fake-compat-api.mjs）だけと話す。LLM は呼ばない。
// 登録（確認してから保存）・会話ごとの選択（次のターンから）・スレッドへの注入・途中の切り替え（unsubscribe → resume）・
// 分岐と新しい会話への引き継ぎ・既定（「既定にする」を押したときだけ）・使えない接続先で止める・キーが画面へ出ないことを通しで見る。
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startServer, ROOT } from "../lib/server.mjs";
import { open } from "../lib/ws-client.mjs";
import { startFakeCompatApi } from "../lib/fake-compat-api.mjs";

export const name = "server-compat-endpoints";
export const title = "互換の接続先: 登録・会話ごとの選択・Codex のスレッドへの注入・引き継ぎ・使えない接続先で止める";

const KEY = "sk-compat-" + "s".repeat(24);

async function rejects(p) { try { await p; return null; } catch (e) { return e; } }

export default async function (t) {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "agent-host-compat-"));
  const log = path.join(scratch, "fake-codex.log");
  const control = path.join(scratch, "fake-codex.control");
  const api = await startFakeCompatApi({ keys: [KEY], auth: "bearer", models: ["vendor/fake-large", "fake-small"] });
  const server = await startServer({ dataDir: scratch, env: { AGENT_HOST_BACKENDS: "fake,codex",
    AGENT_HOST_CODEX_BIN: `node "${path.join(ROOT, "tests/lib/fake-codex.mjs")}"`, FAKE_CODEX_LOG: log, FAKE_CODEX_CONTROL: control } });
  const c = await open({ port: server.port, token: server.token, autoAllow: true });
  const replies = [];
  const cmd = async (command, args) => { const r = await c.cmd(command, args); replies.push(r); return r; };
  const entries = async () => (await fs.readFile(log, "utf8").catch(() => "")).split("\n").filter(Boolean).map(l => JSON.parse(l));
  const lastTurn = async (threadId) => (await entries()).filter(e => e.method === "turn/start" && (!threadId || e.threadId === threadId)).at(-1);
  try {
    // ---- 登録
    const input = { agent: "codex", name: "偽の Responses", preset: "custom", baseUrl: api.url + "/v1", authMode: "bearer", key: KEY, roles: { main: "vendor/fake-large" } };
    const unsaved = await rejects(cmd("compatEndpointSave", { input, receipt: "x" }));
    t.ok("確認していないと保存できない", unsaved?.message.includes("接続を確認"));
    const mark = c.mark();
    const checked = await cmd("compatEndpointCheck", { input });
    t.ok("確認が通る（本物の 1 リクエスト）", checked.ok && api.requests.some(r => r.method === "POST" && r.path === "/v1/responses"), JSON.stringify(checked));
    const { id } = await cmd("compatEndpointSave", { input, receipt: checked.receipt });
    await c.waitFor(e => e.type === "compatEndpointsChanged", { from: mark, ms: 5000 });
    t.ok("保存すると全タブに知らせる", true);
    api.set({ responses: false });
    const chatOnly = await cmd("compatEndpointCheck", { input });
    api.set({ responses: true });
    t.ok("Chat Completions だけの先は理由の行つきで返す（例外にしない）", chatOnly.ok === false && chatOnly.code === "chat-only" && chatOnly.lines.length > 0, JSON.stringify(chatOnly));
    const listed = await cmd("compatEndpoints", {});
    t.ok("一覧はキーを返さない", listed.endpoints.length === 1 && listed.endpoints[0].hasKey && !JSON.stringify(listed).includes(KEY));

    // ---- 新しい会話は公式（既定にしていない）
    const { sessionId } = await cmd("newSession", { backend: "codex", cwd: ROOT });
    let row = (await cmd("listSessions")).find(s => s.id === sessionId);
    t.ok("既定にしていなければ新しい会話は公式", row.compatEndpoint === "");
    const first = await c.runTurn({ sessionId, prompt: "hello official" });
    const official = await lastTurn();
    t.ok("公式の会話は公式の provider で走る", first.outcome === "ok" && official?.provider?.id === "openai", JSON.stringify(official));

    // ---- 会話ごとに選ぶ（次のターンから）
    const next = await cmd("setTurnSettings", { sessionId, endpoint: id });
    t.ok("選ぶと次のターンに予約し、モデルは接続先の既定に戻す", next?.endpoint === id && next.model === "");
    const slashModel = await cmd("setTurnSettings", { sessionId, model: "vendor/fake-large" });
    t.ok("`/` を含むモデル ID を受け付ける（一覧外でも自由入力）", slashModel?.model === "vendor/fake-large" && slashModel.endpoint === id);
    const free = await cmd("setTurnSettings", { sessionId, model: "qwen3:32b" });
    t.ok("`:` を含む一覧に無いモデル ID も受け付ける", free?.model === "qwen3:32b");
    await cmd("setTurnSettings", { sessionId, model: "" });
    const wrongEffort = await rejects(cmd("setTurnSettings", { sessionId, effort: "xhigh" }));
    t.ok("互換の接続先の段は low / medium / high だけ", wrongEffort !== null);
    const compatTurn = await c.runTurn({ sessionId, prompt: "hello compat" });
    const used = await lastTurn(official.threadId);
    t.ok("次のターンは互換の接続先で走る（URL・鍵・メインのモデル）", compatTurn.outcome === "ok" && used?.provider?.baseUrl === api.url + "/v1"
      && used.provider.bearer === KEY && used.model === "vendor/fake-large" && /^ply_ep_/.test(used.provider.id), JSON.stringify({ ...used, provider: { ...used?.provider, bearer: used?.provider?.bearer ? "(set)" : null } }));
    t.ok("ロード済みのスレッドはいったん外してから読み直す", (await entries()).some(e => e.method === "thread/unsubscribe" && e.threadId === official.threadId));
    t.ok("互換の会話では web_search を止める", used.provider.webSearch === "disabled");
    t.ok("段を選んでいなければ段を送らない", used.effort === null);
    row = (await cmd("listSessions")).find(s => s.id === sessionId);
    t.ok("適用後は会話の接続先になり、予約は消える", row.compatEndpoint === id && row.nextSettings === null);

    // ---- 公式へ戻す・もう一度互換へ
    await cmd("setTurnSettings", { sessionId, endpoint: "" });
    await c.runTurn({ sessionId, prompt: "back to official" });
    t.ok("公式へ戻すと公式の provider で読み直す", (await lastTurn(official.threadId))?.provider?.id === "openai");
    await cmd("setTurnSettings", { sessionId, endpoint: id, effort: "high" });
    await c.runTurn({ sessionId, prompt: "compat again" });
    const again = await lastTurn(official.threadId);
    t.ok("もう一度互換へ切り替えられ、選んだ段は送る", again?.provider?.baseUrl === api.url + "/v1" && again.effort === "high");

    // ---- 切り替えが効かなかったら止める（黙って前の接続先へ送らない）
    const turnsBefore = (await entries()).filter(e => e.method === "turn/start").length;
    await fs.writeFile(control, "sticky");
    await cmd("setTurnSettings", { sessionId, endpoint: "" });
    const failText = (r) => r?.message ?? r?.events?.find(e => e.type === "turnResult")?.error ?? "";
    const stuck = await c.runTurn({ sessionId, prompt: "should not go to the old endpoint" }).catch(e => e);
    t.ok("外したのに前の接続先のまま読み込まれたら、ターンを始めず理由を返す", String(failText(stuck)).includes("接続先を切り替えられませんでした"), failText(stuck));
    t.ok("そのとき前の接続先へは何も送らない", (await entries()).filter(e => e.method === "turn/start").length === turnsBefore);
    await fs.writeFile(control, "unsubscribe-fail");
    const busy = await c.runTurn({ sessionId, prompt: "unsubscribe fails" }).catch(e => e);
    t.ok("外せなかったときもターンを始めず理由を返す", String(failText(busy)).includes("外せませんでした"), failText(busy));
    t.ok("そのときも何も送らない", (await entries()).filter(e => e.method === "turn/start").length === turnsBefore);
    await fs.writeFile(control, "");
    const retried = await c.runTurn({ sessionId, prompt: "retry official" });
    t.ok("外せるようになれば公式で送れる", retried.outcome === "ok" && (await lastTurn(official.threadId))?.provider?.id === "openai");
    await cmd("setTurnSettings", { sessionId, endpoint: id });
    await c.runTurn({ sessionId, prompt: "compat once more" });
    t.ok("もう一度互換へ戻せる", (await lastTurn(official.threadId))?.provider?.baseUrl === api.url + "/v1");

    // ---- 引き継ぎ
    const child = await cmd("fork", { sessionId });
    const forked = (await cmd("listSessions")).find(s => s.id === child.sessionId);
    t.ok("分岐は接続先を継ぐ", forked?.compatEndpoint === id, JSON.stringify(forked?.compatEndpoint));
    const carried = await cmd("newSession", { sourceSessionId: sessionId, cwd: ROOT });
    t.ok("同じエージェントの新しい会話への引き継ぎは接続先を継ぐ", (await cmd("listSessions")).find(s => s.id === carried.sessionId)?.compatEndpoint === id);
    const other = await cmd("newSession", { sourceSessionId: sessionId, backend: "fake", cwd: ROOT });
    t.ok("別のエージェントの新しい会話へは継がない", (await cmd("listSessions")).find(s => s.id === other.sessionId)?.compatEndpoint === "");
    await cmd("switchBackend", { sessionId: carried.sessionId, backend: "fake" });
    t.ok("switchBackend でエージェントを変えても、前のエージェントの接続先を残さない", (await cmd("listSessions")).find(s => s.id === carried.sessionId)?.compatEndpoint === "");
    const switched = await cmd("setTurnSettings", { sessionId, backend: "fake" });
    t.ok("会話のエージェントを変えると接続先は外れる", switched?.backend === "fake" && switched.endpoint === "");
    await cmd("setTurnSettings", { sessionId, cancel: true });

    // ---- 既定（「既定にする」を押したときだけ）
    await cmd("compatEndpointDefault", { agent: "codex", id });
    const byDefault = await cmd("newSession", { backend: "codex", cwd: ROOT });
    t.ok("「既定にする」を押した接続先は新しい会話の既定になる", (await cmd("listSessions")).find(s => s.id === byDefault.sessionId)?.compatEndpoint === id);
    await cmd("compatEndpointDefault", { agent: "codex", id: "" });
    const plain = await cmd("newSession", { backend: "codex", cwd: ROOT });
    t.ok("公式を既定に戻すと新しい会話は公式", (await cmd("listSessions")).find(s => s.id === plain.sessionId)?.compatEndpoint === "");

    // ---- タイトル生成は接続先の既定のモデルで
    const titled = await cmd("suggestTitle", { sessionId }).catch(e => ({ error: e.message }));
    const titleTurn = (await entries()).filter(e => e.method === "turn/start" && e.ephemeral).at(-1);
    t.ok("タイトル生成は互換の会話ではその接続先で作る", titleTurn?.provider?.baseUrl === api.url + "/v1" && titleTurn.model === "vendor/fake-large", JSON.stringify({ titled, model: titleTurn?.model }));

    // ---- 使えない接続先で止める（黙って公式に戻さない）
    api.set({ keys: ["another"] });
    const recheck = await cmd("compatEndpointRecheck", { id });
    t.ok("一覧からの確認の失敗を返す", recheck.ok === false);
    const failed = await rejects(c.runTurn({ sessionId, prompt: "should stop" }));
    t.ok("確認に失敗している接続先の会話は送信を止め、理由を返す", String(failed?.message ?? "").includes("前回の確認に失敗"), failed?.message);
    api.set({ keys: [KEY] });
    await cmd("compatEndpointRecheck", { id });
    const wrongAgent = await rejects(cmd("setTurnSettings", { sessionId: other.sessionId, endpoint: id }));
    t.ok("接続先を選べないエージェントの会話では選べない", wrongAgent !== null || (await cmd("listSessions")).find(s => s.id === other.sessionId)?.nextSettings?.endpoint === undefined);
    await cmd("compatEndpointDelete", { id });
    const deleted = await rejects(c.runTurn({ sessionId, prompt: "deleted" }));
    t.ok("削除した接続先の会話は送信を止め、選び直しを求める", String(deleted?.message ?? "").includes("削除されています"), deleted?.message);
    await cmd("setTurnSettings", { sessionId, endpoint: "" });
    const recovered = await c.runTurn({ sessionId, prompt: "recovered" });
    t.ok("選び直せば送れる", recovered.outcome === "ok");

    // ---- キーが画面へ出ない
    const everything = JSON.stringify({ events: c.events, replies });
    t.ok("イベントと応答にキーが出ない", !everything.includes(KEY));
    const sidecar = await fs.readFile(path.join(scratch, "sessions.json"), "utf8");
    t.ok("会話の記録（sidecar）にキーを書かない", !sidecar.includes(KEY));
    t.ok("server のログにキーが出ない", !server.tail(200).includes(KEY));
  } finally {
    c.close();
    await server.stop();
    await api.close();
    await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}
