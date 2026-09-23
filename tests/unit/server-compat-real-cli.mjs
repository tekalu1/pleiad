// 互換の接続先を、本物の Claude Code・Codex の CLI で通す。LLM は呼ばない（送り先は偽の互換 API だけ）。
// 設定フォルダ（CLAUDE_CONFIG_DIR・CODEX_HOME）は使い捨てにし、利用者の設定を読まない・書かない。
//   - Claude: 利用者の settings.json の env（別の BASE_URL・鍵）と親の環境の ANTHROPIC_* / OAuth トークンに負けず、
//     接続先の URL・鍵・メインのモデルで POST /v1/messages が届く。思考とエフォートは送らない（既定）。フラグ設定のファイルは残らない
//   - Codex: スレッドの modelProvider で POST /responses が届く（鍵は Bearer）
// CLI が入っていない環境（CI など）ではとばす。
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startServer } from "../lib/server.mjs";
import { open } from "../lib/ws-client.mjs";
import { startFakeCompatApi } from "../lib/fake-compat-api.mjs";
import { cliCommand } from "../../core/cli-installation.mjs";

export const name = "server-compat-real-cli";
export const title = "互換の接続先: 本物の Claude Code・Codex の CLI が偽の互換 API に届く（利用者の設定・親の環境に負けない）";

const KEY = "sk-compat-" + "r".repeat(24);

export default async function (t) {
  const have = { claude: Boolean(cliCommand("claude")), codex: Boolean(cliCommand("codex")) };
  if (!have.claude && !have.codex) { t.skip("Claude Code も Codex も入っていない"); return; }
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "agent-host-compat-cli-"));
  const api = await startFakeCompatApi({ keys: [KEY], auth: "any", models: ["vendor/main", "vendor/small"] });
  const wrong = await startFakeCompatApi({});
  const claudeDir = path.join(scratch, "claude"), codexHome = path.join(scratch, "codex"), work = path.join(scratch, "work"), data = path.join(scratch, "data");
  await Promise.all([claudeDir, codexHome, work, data].map(d => fs.mkdir(d, { recursive: true })));
  // 利用者の settings.json に別の接続先が書いてある（勝たせてはいけない）
  // 社内ゲートウェイの認証ヘッダー（ANTHROPIC_CUSTOM_HEADERS）も、利用者とプロジェクトの settings に書いてある（互換の接続先へは送らない）
  await fs.writeFile(path.join(claudeDir, "settings.json"), JSON.stringify({ env: { ANTHROPIC_BASE_URL: wrong.url, ANTHROPIC_AUTH_TOKEN: "sk-user-settings-token", ANTHROPIC_MODEL: "user-settings-model",
    ANTHROPIC_CUSTOM_HEADERS: "x-gateway-key: sk-user-gateway-secret" } }));
  await fs.mkdir(path.join(work, ".claude"), { recursive: true });
  await fs.writeFile(path.join(work, ".claude", "settings.json"), JSON.stringify({ env: { ANTHROPIC_CUSTOM_HEADERS: "x-project-key: sk-project-gateway-secret" } }));
  const backends = Object.keys(have).filter(k => have[k]).join(",");
  const server = await startServer({ dataDir: data, timeoutMs: 120_000, env: { AGENT_HOST_BACKENDS: backends, CLAUDE_CONFIG_DIR: claudeDir, CODEX_HOME: codexHome,
    // 親の環境の資格情報（互換の会話へは渡さない）
    ANTHROPIC_API_KEY: "sk-parent-env-key", CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-parent-oauth" } });
  const c = await open({ port: server.port, token: server.token, autoAllow: true });
  const register = async (agent, baseUrl, roles) => {
    const input = { agent, name: `偽の ${agent}`, preset: "custom", baseUrl, authMode: agent === "claude" ? "auto" : "bearer", key: KEY, roles };
    const checked = await c.cmd("compatEndpointCheck", { input });
    if (!checked.ok) throw new Error(checked.error);
    return (await c.cmd("compatEndpointSave", { input, receipt: checked.receipt })).id;
  };
  try {
    if (have.claude) {
      const id = await register("claude", api.url, { main: "vendor/main", opus: "vendor/main", sonnet: "vendor/main", haiku: "vendor/small" });
      const { sessionId } = await c.cmd("newSession", { backend: "claude", cwd: work });
      await c.cmd("setTurnSettings", { sessionId, endpoint: id });
      const from = api.requests.length;
      const turn = await c.runTurn({ sessionId, prompt: "say hello" }, { ms: 120_000 });
      const sent = api.requests.slice(from).filter(r => r.method === "POST" && r.path.startsWith("/v1/messages"));
      const main = sent.find(r => r.body?.model === "vendor/main");
      t.ok("Claude: ターンが終わる", turn.outcome === "ok", JSON.stringify(turn.events.filter(e => e.type === "turnResult")));
      t.ok("Claude: 接続先の URL・鍵・メインのモデルで POST /v1/messages が届く", main && main.headers.authorization === `Bearer ${KEY}`, JSON.stringify(sent.map(r => ({ path: r.path, model: r.body?.model, auth: Boolean(r.headers.authorization) }))));
      t.ok("Claude: 利用者の settings.json の接続先へは送らない", !wrong.requests.some(r => r.method === "POST"));
      const all = JSON.stringify(api.requests.map(r => r.headers));
      t.ok("Claude: 親の環境の API キー・OAuth トークンを送らない", !all.includes("sk-parent-env-key") && !all.includes("sk-ant-oat01-parent-oauth") && !all.includes("sk-user-settings-token"));
      t.ok("Claude: settings.json の ANTHROPIC_CUSTOM_HEADERS（利用者・プロジェクト）を互換の接続先へ送らない",
        api.requests.length > 0 && !all.includes("sk-user-gateway-secret") && !all.includes("sk-project-gateway-secret") && !api.requests.some(r => r.headers["x-gateway-key"] || r.headers["x-project-key"]));
      t.ok("Claude: 思考とエフォートを送らない（「思考を送る」がオフ）", main && main.body.thinking === undefined && main.body.output_config?.effort === undefined, JSON.stringify({ thinking: main?.body?.thinking, output: main?.body?.output_config }));
      const left = await fs.readdir(path.join(data, "run")).catch(() => []);
      t.ok("Claude: キーを含むフラグ設定のファイルはターンの後に残らない", left.length === 0, left.join(","));
      const titled = await c.cmd("suggestTitle", { sessionId }).catch(e => ({ error: e.message }));
      t.ok("Claude: タイトル生成は Haiku 相当のモデルで接続先へ送る", api.requests.some(r => r.path.startsWith("/v1/messages") && r.body?.model === "vendor/small"), JSON.stringify(titled));
    } else t.note("Claude Code が入っていないので Claude の節はとばした");
    if (have.codex) {
      const id = await register("codex", api.url + "/v1", { main: "vendor/main" });
      const { sessionId } = await c.cmd("newSession", { backend: "codex", cwd: work });
      await c.cmd("setTurnSettings", { sessionId, endpoint: id, mode: "readonly" }).catch(() => c.cmd("setTurnSettings", { sessionId, endpoint: id }));
      const from = api.requests.length;
      const turn = await c.runTurn({ sessionId, prompt: "say hello" }, { ms: 120_000 });
      const sent = api.requests.slice(from).filter(r => r.method === "POST" && r.path === "/v1/responses");
      t.ok("Codex: ターンが終わる", turn.outcome === "ok", JSON.stringify(turn.events.filter(e => e.type === "turnResult")));
      t.ok("Codex: 接続先の URL・鍵・モデルで POST /responses が届く", sent.some(r => r.headers.authorization === `Bearer ${KEY}` && r.body?.model === "vendor/main"), JSON.stringify(sent.map(r => r.body?.model)));
    } else t.note("Codex が入っていないので Codex の節はとばした");
    t.ok("server のログにキーが出ない", !server.tail(200).includes(KEY));
  } finally {
    c.close();
    await server.stop();
    await api.close(); await wrong.close();
    await fs.rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
  }
}
