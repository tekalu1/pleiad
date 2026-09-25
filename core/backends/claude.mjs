// Claude Agent SDK のバックエンド。
//
// **SDK を呼ぶのはこのファイルだけ**（と、ここが import する範囲）。
// v1 では session.mjs / tools.mjs / history.mjs / store.mjs / server.mjs の5か所に
// 散っていた。散っていること自体は動くが、「SDK が実行エンジンとセッション管理 DB を
// 兼ねている」ことが見えなくなり、別のバックエンドを足すときに一度に全部を直す羽目になる。
//
// SDK メッセージ -> 正規化イベントの変換は claude-normalize.mjs（SDK 非依存・テスト可能）。
import {
  query, createSdkMcpServer, tool, resolveSettings,
  listSessions as sdkListSessions, getSessionInfo, getSessionMessages,
  renameSession, tagSession, forkSession,
  listSubagents as sdkListSubagents, getSubagentMessages as sdkGetSubagentMessages,
} from "@anthropic-ai/claude-agent-sdk";
import { claudeAuth } from '../auth/claude-cli.mjs';
import { t, agentT } from '../i18n.mjs';
import { readClaudeAccountsUsage } from './claude-usage.mjs';
import { claudeEnv, redactToken } from '../claude-accounts.mjs';
import { claudeCompatEnv, writeClaudeFlagSettings, redactSecret } from '../compat-endpoints.mjs';
import { claudeExecutable } from '../cli-installation.mjs';
import { claudeContextOptions, unexpectedNativeMcp } from './context-options.mjs';
import { undelivered } from './undelivered.mjs';
import { z } from "zod";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import os from "node:os";
import * as store from "../store.mjs";
import { buildClaudeModels, FALLBACK_MODELS } from "./claude-models.mjs";
import { normalizeSdkMessage, transcriptToMessages, mergeQueuedCommands, subagentEntries } from "./claude-normalize.mjs";
import { createTurnTracker, createInputQueue, createInputCloser, createHostCalls, createStderrLog } from "./claude-background.mjs";

const NL = String.fromCharCode(10);

// runTurn が使う SDK の入口と中断の待ち時間。テスト（tests/unit/claude-steer-stop.mjs）だけが差し替える。
// 中断は CLI に interrupt を頼み、stopAckMs のうちに受領（interrupt の応答か result）が無ければ
// 入力を閉じて SDK の abort に落とす。受領の後も stopExitMs のうちに終わらなければ同じく落とす
const sdk = { query, executable: claudeExecutable, stopAckMs: 2500, stopExitMs: 3000 };
export function setClaudeSdkForTest(over = {}) {
  const prev = { ...sdk };
  Object.assign(sdk, over);
  return () => Object.assign(sdk, prev);
}

// Pleiadが提供するツール。名前はMCPサーバー名 host / ply から決まる。
const HOST_TOOL_NAMES = [
  "mcp__host__set_status",
  "mcp__host__set_title",
  "mcp__host__fork",
];

// 自動で許可するもの。読み取り専用のツールと、host が自分で出しているツール。
// ここに無いものは人間に問う（askPermission）。
// ワークスペースへの破壊的操作の承認は Claude Code の権限層と同じ層の話で、
// セッションのメタ情報（status / title）の扱いとは直交する（設計メモ 2.2 の括弧書き）。
const AUTO_ALLOW = new Set([
  ...HOST_TOOL_NAMES,
  "Read", "Glob", "Grep", "Skill", "TodoWrite", "WebFetch", "WebSearch",
]);

// 質問は「危ないから承認する」ツールではなく、こちらに聞いているツール。
// 正規化イベントでは permission.kind = "question" に落とし、web は専用のカードを出す。
const QUESTION_TOOL = "AskUserQuestion";

// 使える承認モード。scope / autonomy / enforced は core/modes.mjs の軸。
// Claude は sandbox を持たず、範囲は「約束」にすぎないので enforced は全部 false。
//
// bypassPermissions は以前ここに出していなかったが、出すことにした。理由は2つ:
// 他のエンジンには YOLO 相当があり、Claude だけ無いと委任のときに「親と同じ強さ」を継げない。
// そして危険の度合いは軸（full / never / 強制なし）で表せるようになったので、
// 隠すのではなく「選んだことが見える」形で扱うほうがよい。
// 表示名と説明は言語が実行中に変わるので、読むたびに引く（ゲッター）
const MODES = {
  default:     { get label() { return t("modes.ask"); },         get short() { return t("modesShort.ask"); },         get note() { return t("claude.modes.defaultNote"); },     scope: "workspace", autonomy: "ask",   enforced: false },
  auto:        { label: "auto",                                  get note() { return t("claude.modes.autoNote"); },        scope: "workspace", autonomy: "judge", enforced: false },
  acceptEdits: { get label() { return t("modes.acceptEdits"); }, get short() { return t("modesShort.acceptEdits"); }, get note() { return t("claude.modes.acceptEditsNote"); }, scope: "workspace", autonomy: "judge", enforced: false },
  plan:        { get label() { return t("modes.plan"); },        get short() { return t("modesShort.plan"); },        get note() { return t("claude.modes.planNote"); },        scope: "none",      autonomy: "ask",   enforced: false },
  bypass:      { label: "YOLO",                                  get note() { return t("claude.modes.bypassNote"); },      scope: "full", autonomy: "never", enforced: false },
};

// SDK の PermissionMode 名。食い違うのは bypass だけ。
// bypassPermissions は allowDangerouslySkipPermissions: true を同時に渡さないと使えない
// （sdk.d.ts の Options: "Must be set to `true` when using `permissionMode: 'bypassPermissions'`"。
// sdk.mjs は真のときだけ CLI へ --allow-dangerously-skip-permissions を足す）。
// このモードでは CLI が権限判定ごと飛ばすので **canUseTool は呼ばれない**＝承認カードは出ない。
const SDK_MODES = { bypass: "bypassPermissions" };
const sdkMode = (mode) => (MODES[mode] ? SDK_MODES[mode] ?? mode : "default");

// 選べるモデル。版付きの名前・対応するエフォート・「既定」が実際に何かは SDK から引く（claude-models.mjs）。
// 空文字は「指定しない」＝ Claude Code の設定に従う。引けないときは固定の一覧（エイリアス）に戻す。
const MODELS = FALLBACK_MODELS;

// SDK の supportedModels() は CLI を起こさないと取れない。1 回起こして（LLM に問いは送らない。会話も残さない）、
// 一覧と、モデルごとに CLI が実際に当てるエフォート（getSettings の applied.effort）を覚える。
// 段は利用者の設定のもとで引く。settings.json の effortLevel をそのまま既定と見なすと外れるため
// （2026-09-25: effortLevel が high でも claude-opus-5-5 には medium が当たり、画面は high と出ていた。
//  同じ値をフラグの設定で渡すと high になるので、CLI の規則を外から真似せず CLI に聞く）。
// 設定を読ませても hooks は止め（disableAllHooks）、MCP は起こさない（strictMcpConfig + 空）。
// ただし設定が別の接続先（ANTHROPIC_BASE_URL・Bedrock など）を指すときは設定を読ませない: setModel は
// モデルの確かめに接続先へ POST /v1/messages を送るので、利用者の接続先へ裏で投げてしまう。
// そのときの段は settings.json の effortLevel で補う（applied: false）。
const CATALOG_TTL = 30 * 60_000, CATALOG_RETRY = 60_000, CATALOG_WAIT = 8_000;
const PROVIDER_ENV = ["ANTHROPIC_BASE_URL", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_CODE_USE_MANTLE", "CLAUDE_CODE_USE_ANTHROPIC_AWS", "CLAUDE_CODE_USE_GATEWAY"];
// 引く条件（作業場所・段に効く設定）ごとに 1 件。{ value, at, failed, probe }
const catalogs = new Map();
let anyCatalog = null;   // どれか 1 件でも取れたか（validModel が保存済みの id を通すかどうか）
async function probeCatalog(cwd, withSettings) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 30_000);
  const idle = async function* () { await new Promise((resolve) => ac.signal.addEventListener("abort", resolve, { once: true })); };
  let q = null;
  try {
    q = query({ prompt: idle(), options: {
      pathToClaudeCodeExecutable: claudeExecutable(), env: claudeEnv(process.env), abortController: ac,
      ...(withSettings
        ? { settingSources: ["user", "project", "local"], settings: { disableAllHooks: true }, strictMcpConfig: true, mcpServers: {}, ...(cwd ? { cwd } : {}) }
        : { settingSources: [] }),
      persistSession: false, stderr: () => {},
    } });
    const init = await q.initializationResult();
    const rows = Array.isArray(init?.models) && init.models.length ? init.models : await q.supportedModels();
    const efforts = {};
    if (typeof q.getSettings === "function") {
      for (const r of rows) {
        if (!r?.value || r.value === "default" || !r.supportedEffortLevels?.length) continue;
        try { await q.setModel(r.value); const applied = (await q.getSettings())?.applied; if (applied?.effort) efforts[r.value] = applied.effort; }
        catch { /* 既定のエフォートが分からないだけ。一覧は使える */ }
      }
    }
    return { rows, efforts, applied: withSettings };
  } finally {
    clearTimeout(timer);
    try { q?.close?.(); } catch { /* 既に閉じている */ }
    ac.abort();
  }
}
function loadCatalog(cwd, pref) {
  // 別の接続先のときは設定を読まないので、作業場所で結果は変わらない
  const key = pref.custom ? "custom" : `${cwd || ""}|${pref.sig}`, now = Date.now();
  let e = catalogs.get(key);
  if (e?.value && now - e.at < CATALOG_TTL) return Promise.resolve(e.value);
  if (e && !e.value && now - e.failed < CATALOG_RETRY) return Promise.resolve(null);
  if (!e) {
    if (catalogs.size >= 32) catalogs.delete(catalogs.keys().next().value);
    e = { value: null, at: 0, failed: 0, probe: null }; catalogs.set(key, e);
  }
  e.probe ??= probeCatalog(cwd, !pref.custom)
    .then((c) => { e.value = anyCatalog = c; e.at = Date.now(); return c; })
    .catch((err) => { e.failed = Date.now(); console.error("  Claude のモデル一覧を取れなかった:", String(err?.message ?? err)); return e.value; })
    .finally(() => { e.probe = null; });
  // 初めの 1 回だけ待つ。長く掛かる（未ログイン・未導入）ときは、別の条件で取れた一覧か固定の一覧で先に答える
  const stand = () => e.value ?? (anyCatalog && { ...anyCatalog, applied: false });
  return Promise.race([e.probe.then((v) => v ?? stand()), new Promise((resolve) => setTimeout(() => resolve(stand()), CATALOG_WAIT).unref?.())]);
}
// 利用者の設定のモデルとエフォート。env が settings.json より強い（CLI と同じ順）。作業場所ごとに違いうるので cwd で引く。
// effort は段を利用者の設定のもとで引けなかったとき（applied: false）だけ既定の段に重ねる。
// sig は段に効く設定の写し（変わったら一覧を引き直す）。custom は設定か env が別の接続先を指すか
const preferredCache = new Map();
async function preferredSettings(cwd) {
  const key = cwd || "";
  const hit = preferredCache.get(key);
  if (hit && Date.now() - hit.at < 30_000) return hit.value;
  let effective = null;
  try { ({ effective } = await resolveSettings({ ...(cwd ? { cwd } : {}), settingSources: ["user", "project", "local"] })); }
  catch { /* 読めなければ SDK の既定の行と段に任せる */ }
  const on = (v) => Boolean(v) && v !== "0" && String(v).toLowerCase() !== "false";
  const value = {
    model: process.env.ANTHROPIC_MODEL || effective?.env?.ANTHROPIC_MODEL || effective?.model || null,
    effort: process.env.CLAUDE_CODE_EFFORT_LEVEL || effective?.env?.CLAUDE_CODE_EFFORT_LEVEL || effective?.effortLevel || null,
    custom: PROVIDER_ENV.some((k) => on(process.env[k]) || on(effective?.env?.[k])),
  };
  value.sig = JSON.stringify([value.model, value.effort, effective?.modelSettings ?? null]);
  preferredCache.set(key, { value, at: Date.now() });
  return value;
}
async function claudeModels(cwd) {
  const pref = await preferredSettings(cwd);
  const c = await loadCatalog(cwd, pref);
  if (!c) return MODELS;
  return buildClaudeModels({ rows: c.rows, efforts: c.efforts, preferred: pref.model, preferredEffort: c.applied ? null : pref.effort });
}

// web/render.mjs の TOOL_LABEL / TOOL_DRAW を補うヒント。
// render.mjs は Claude の名前を既に知っているので、ここは「同じものを別経路でも渡せる」
// ことの担保でもある（codex はこれしか手がかりが無い）。
// label は言語が実行中に変わるので、読むたびに辞書（server の tools.*）から引く
// i18n-dynamic: tools.
const hint = (key, shape) => ({ get label() { return t(`tools.${key}`); }, shape });
const TOOL_HINTS = {
  Bash:         hint("run", "shell"),
  PowerShell:   hint("run", "shell"),
  Read:         hint("read", "read"),
  Write:        hint("write", "write"),
  Edit:         hint("edit", "edit"),
  MultiEdit:    hint("edit", "edit"),
  NotebookEdit: hint("edit", "edit"),
  Glob:         hint("find", "search"),
  Grep:         hint("search", "search"),
  Task:         hint("delegate", "delegate"),
  Agent:        hint("delegate", "delegate"),
  WebFetch:     hint("fetch", "web"),
  WebSearch:    hint("webSearch", "web"),
  TodoWrite:    { label: "TODO", shape: "generic" },
  mcp__host__present:    hint("present", "generic"),
  mcp__ply__present:     hint("present", "generic"),
  mcp__host__set_status: hint("status", "generic"),
  mcp__host__set_title:  hint("title", "generic"),
  mcp__host__fork:       hint("fork", "generic"),
};

// ---------------------------------------------------------------- host ツール
// すべて「AI が人間と同じことをする」ための口（設計メモ 2.2）。
// 人間の操作（server.mjs のコマンド）と同じ store・同じイベントを通る。

/**
 * ctx = { sessionId, emit(event), locale }
 * sessionId は新規セッションだと init メッセージまで確定しないので、
 * ctx を書き換えられるオブジェクトとして渡す（runTurn が差し替える）。
 * 説明・引数の説明・返り値はエージェントが読むので、会話の言語（ctx.locale）で引く（agent 名前空間）
 */
function buildToolServer(ctx) {
  // 応答は CLI の stdin を通る。走っている間は入力を閉じさせない（claude-background.mjs）
  const hosted = (name, handler) => (args) => ctx.hostCalls ? ctx.hostCalls.run(name, () => handler(args)) : handler(args);
  return createSdkMcpServer({
    name: "host",
    version: "0.0.0",
    tools: [
      tool(
        "set_status",
        agentT(ctx.locale, 'host.setStatus.description'),
        {
          status: z.string().describe(agentT(ctx.locale, 'host.setStatus.status')),
          reason: z.string().optional().describe(agentT(ctx.locale, 'host.setStatus.reason')),
          icon: z.string().optional().describe(agentT(ctx.locale, 'host.setStatus.icon')),
        },
        hosted("mcp__host__set_status", async (args) => {
          const sessionId = ctx.hostSessionId ?? ctx.sessionId;
          if (!sessionId) return { content: [{ type: "text", text: agentT(ctx.locale, 'host.sessionPending') }] };
          await (ctx.hostBackend ?? backend).setTag(sessionId, args.status);
          await store.recordChange(sessionId, {
            by: "ai", field: "status", to: args.status, reason: args.reason, backend,
          });
          ctx.emit({ type: "status", sessionId, status: args.status, by: "ai", reason: args.reason ?? null });
          // アイコンは人間が選ぶのと同じ表に入る（設計メモ 2.2）
          if (args.icon) {
            const icon = await store.setStatusIcon(args.status, args.icon);
            ctx.emit({ type: "statusIcon", sessionId: null, status: args.status, icon });
          }
          return { content: [{ type: "text", text: agentT(ctx.locale, 'host.setStatus.done', { status: args.status }) }] };
        }),
      ),

      tool(
        "set_title",
        agentT(ctx.locale, 'host.setTitle.description'),
        {
          title: z.string(),
          reason: z.string().optional().describe(agentT(ctx.locale, 'host.setTitle.reason')),
        },
        hosted("mcp__host__set_title", async (args) => {
          const sessionId = ctx.hostSessionId ?? ctx.sessionId;
          if (!sessionId) return { content: [{ type: "text", text: agentT(ctx.locale, 'host.sessionPending') }] };
          await (ctx.hostBackend ?? backend).setTitle(sessionId, args.title);
          await store.recordChange(sessionId, {
            by: "ai", field: "title", to: args.title, reason: args.reason, backend,
          });
          ctx.emit({ type: "title", sessionId, title: args.title, by: "ai", reason: args.reason ?? null });
          return { content: [{ type: "text", text: agentT(ctx.locale, 'host.setTitle.done', { title: args.title }) }] };
        }),
      ),

      tool(
        "fork",
        agentT(ctx.locale, 'host.fork.description'),
        {
          title: z.string().optional().describe(agentT(ctx.locale, 'host.fork.title')),
          reason: z.string().optional().describe(agentT(ctx.locale, 'host.fork.reason')),
        },
        hosted("mcp__host__fork", async (args) => {
          const sessionId = ctx.hostSessionId ?? ctx.sessionId;
          if (!sessionId) return { content: [{ type: "text", text: agentT(ctx.locale, 'host.sessionPending') }] };
          const { sessionId: child } = ctx.hostBackend
            ? await ctx.hostBackend.fork(sessionId, { title: args.title })
            : await forkSession(sessionId, { title: args.title });
          const parent = { sessionId, atMessage: null };
          // 包んだバックエンドの fork は設定（モデル・アカウントなど）を引き継ぐ。直に分けたときも同じにする
          if (!ctx.hostBackend) await store.inheritSettings(sessionId, child);
          await store.setParent(child, parent);
          await store.setMeta(child, { backend: backend.id });
          await store.recordChange(child, {
            by: "ai", field: "parent", to: parent, reason: args.reason ?? "fork", backend,
          });
          ctx.emit({ type: "fork", sessionId: child, parent, by: "ai", reason: args.reason ?? null });
          return { content: [{ type: "text", text: agentT(ctx.locale, 'host.fork.done', { sessionId: child }) }] };
        }),
      ),
    ],
  });
}

// ---------------------------------------------------------------- 承認

/**
 * SDK の canUseTool を、バックエンド非依存の askPermission に橋渡しする。
 *
 * askPermission({ toolName, input, sessionId, toolUseID, title, signal, canAlways, kind, questions })
 *   -> Promise<{ allow, always?, message?, answers?, annotations?, response? }>
 *
 * 「常に許可」の候補（options.suggestions）は SDK 固有の構造なので**外に出さない**。
 * host に渡すのは canAlways（選べるかどうか）だけで、中身はここに閉じる。
 * 回答（answers）を SDK の updatedInput へ戻すのもここの責務。
 *
 * 返事は CLI の stdin を通る。人の返答を待つ間は入力を閉じさせない（claude-background.mjs）。
 */
function makeCanUseTool(ctx, askPermission) {
  return async (toolName, input, options) =>
    // i18n-ignore: サーバーのログにだけ出る名前（claude-background.mjs の createHostCalls）
    ctx.hostCalls ? ctx.hostCalls.run(`${toolName} の承認`, () => decidePermission(ctx, askPermission, toolName, input, options))
      : decidePermission(ctx, askPermission, toolName, input, options);
}

// deny の理由はツールの結果としてエージェントに返る（画面のツールの結果にも出る）。会話の言語（ctx.locale）で
async function decidePermission(ctx, askPermission, toolName, input, options) {
  if (AUTO_ALLOW.has(toolName)) return { behavior: "allow", updatedInput: input };

  if (typeof askPermission !== "function") {
    return { behavior: "deny", message: agentT(ctx.locale, 'approval.noHandler', { tool: toolName }) };
  }

  const isQuestion = toolName === QUESTION_TOOL && Array.isArray(input?.questions);
  const canAlways = Array.isArray(options?.suggestions) && options.suggestions.length > 0;

  let answer;
  try {
    answer = await askPermission({
      toolName,
      input,
      sessionId: ctx.sessionId,
      // 以下は承認 UI を読みやすくするための添え物。無くても判断はできる。
      toolUseID: options?.toolUseID ?? null,
      title: options?.title ?? null,
      signal: options?.signal,
      canAlways,
      kind: isQuestion ? "question" : "tool",
      // 質問の形は docs/multi-backend.md §2.2。AskUserQuestion の入力がそのまま正規形。
      questions: isQuestion ? input.questions : null,
    });
  } catch (err) {
    return { behavior: "deny", message: agentT(ctx.locale, 'approval.failed', { error: String(err?.message ?? err) }) };
  }

  if (!answer?.allow) {
    return { behavior: "deny", message: answer?.message || agentT(ctx.locale, 'approval.notAllowed') };
  }

  // AskUserQuestion のように、承認そのものではなく**回答**を運ぶツールがある。
  // host は正規形（answers など）で返してくるので、ここで SDK の updatedInput へ戻す。
  const extra = {
    ...(answer.answers ? { answers: answer.answers } : {}),
    ...(answer.annotations ? { annotations: answer.annotations } : {}),
    ...(answer.response ? { response: answer.response } : {}),
  };
  const nextInput = Object.keys(extra).length ? { ...(input ?? {}), ...extra } : input;

  // 「常に許可」を選んだときだけ、SDK が出した候補をそのまま返す。
  // 候補は SDK が組み立てたものをそのまま使う（こちらで作らない）。
  return answer.always && canAlways
    ? { behavior: "allow", updatedInput: nextInput, updatedPermissions: options.suggestions }
    : { behavior: "allow", updatedInput: nextInput };
}

// ---------------------------------------------------------------- backend

/** SDKSessionInfo -> バックエンド共通のセッション行 */
function toRow(s) {
  if (!s?.sessionId) return null;
  return {
    sessionId: s.sessionId,
    // 3段のフォールバックは Claude Code の概念（自動生成 summary / 最初のプロンプト）。
    // 見つからなければ null を返し、sidecar の title に譲る。
    title: s.customTitle ?? s.summary ?? s.firstPrompt ?? null,
    cwd: s.cwd ?? null,
    createdAt: s.createdAt ?? null,
    lastModified: s.lastModified ?? null,
    tag: s.tag ?? null,
  };
}

const SAFE_ID = /^[A-Za-z0-9_-]+$/;
const subagentFiles = new Map();   // "sessionId/agentId" -> transcript のパス。置き場は変わらない
const subagentReads = new Map();   // "sessionId/agentId:limit" -> { stamp, entries }。running の配信が 4 秒ごとに読みに来る

/**
 * サブエージェントの transcript を自分で読む。SDK の getSubagentMessages は最後の 1 件しか返さない
 * （claude-normalize.mjs の subagentEntries）。見つからなければ null（呼び出し側が SDK へ落とす）。
 * 置き場は readQueuedCommandRows と同じく、組み立てずに projects の下を探す。
 */
async function readSubagentEntries(sessionId, agentId, { limit = 0 } = {}) {
  if (!SAFE_ID.test(String(sessionId ?? "")) || !SAFE_ID.test(String(agentId ?? ""))) return null;
  const key = `${sessionId}/${agentId}`;
  try {
    if (!subagentFiles.has(key)) {
      const projects = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"), "projects");
      for (const dir of await fs.readdir(projects)) {
        const base = path.join(projects, dir, sessionId, "subagents");
        // 孫のエージェントは subagents/<親>/ の下に入る
        const found = (await fs.readdir(base, { recursive: true }).catch(() => []))
          .find((f) => path.basename(f) === `agent-${agentId}.jsonl`);
        if (found) { subagentFiles.set(key, path.join(base, found)); break; }
      }
    }
    const file = subagentFiles.get(key);
    if (!file) return null;
    const stat = await fs.stat(file);
    const stamp = `${stat.mtimeMs}:${stat.size}`;
    const slot = `${key}:${limit}`;
    if (subagentReads.get(slot)?.stamp === stamp) return subagentReads.get(slot).entries;
    const text = await fs.readFile(file, "utf8");
    const meta = await fs.readFile(file.replace(/\.jsonl$/, ".meta.json"), "utf8").then(JSON.parse).catch(() => null);
    const entries = subagentEntries(text, { toolUseId: typeof meta?.toolUseId === "string" ? meta.toolUseId : null, limit });
    subagentReads.delete(slot);
    subagentReads.set(slot, { stamp, entries });
    if (subagentReads.size > 24) subagentReads.delete(subagentReads.keys().next().value);   // 古いものから捨てる
    return entries;
  } catch {
    subagentFiles.delete(key);
    return null;
  }
}

/**
 * transcript（`<CLAUDE_CONFIG_DIR ?? ~/.claude>/projects/<何か>/<sessionId>.jsonl`）から
 * attachment 行だけを拾う。途中送信は queued_command の attachment として残り、
 * SDK の getSessionMessages はそれを返さない（claude-normalize.mjs の mergeQueuedCommands）。
 *
 * - 置き場のディレクトリ名は cwd から作られるが、**組み立てない**（再開で cwd が変わると外れる）。
 *   projects の下を順に見て、その id の .jsonl があるところを使う。
 * - 折り込みが 1 件も無いセッションでは何も parse しない（文字列を 1 回走査するだけ）。
 * - 読めなければ空。履歴は素の getSessionMessages のまま出す（今までどおりの見た目に落ちる）。
 */
async function readQueuedCommandRows(sessionId) {
  if (!sessionId) return [];
  try {
    const projects = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"), "projects");
    let text = null;
    for (const dir of await fs.readdir(projects)) {
      text = await fs.readFile(path.join(projects, dir, `${sessionId}.jsonl`), "utf8").catch(() => null);
      if (text !== null) break;
    }
    if (!text || !text.includes("queued_command")) return [];
    const rows = [];
    // 親子の鎖を遡るのに要るのは attachment 行だけ（間に挟まるのは CLI が足す attachment）。
    // 本文やツール結果の行は大きいので parse しない
    for (const line of text.split("\n")) {
      if (!line.includes('"attachment"')) continue;
      try {
        const row = JSON.parse(line);
        if (row?.type === "attachment" && row.uuid) rows.push(row);
      } catch { /* 壊れた行は飛ばす */ }
    }
    return rows;
  } catch {
    return [];
  }
}

// 走っているターンの query。停止ボタン（stopBackground -> Query.stopTask）はターンの外から来るので、
// 会話 id から引けるようにしておく。ターンが終わったら必ず外す（finally）。
// SDK の options には `perTaskStopAffordance` があるが**宣言しない**。宣言すると中断（interrupt）が
// バックグラウンドのタスクを見逃すようになる（sdk.d.ts）。停止は 1 本ずつ、中断はターンごと、で分けたまま置く。
const liveQueries = new Map();   // sessionId -> Query

// サブエージェントの状態（getSubagentState）。**Claude のネイティブ id** -> そのターンの tracker。
// 状態はターンの中で流れる SDK メッセージ（task_* と委譲ツールの結果）からしか取らない。
// 4 秒ごとの runningWork から親 transcript を読むと、走っている間は mtime が毎回変わって最悪 9MB を読み直すことになる。
// ターンが終わっても外さない（終わり際の配信が状態を引ける）。次のターンが同じ会話の分を置き換える
const turnTrackers = new Map();

export const backend = {
  // 登録したアカウントがあれば、アカウントごとに見出しを付けて返す（server が accounts を解いて渡す）
  usage: ({ accounts, loginLabel } = {}) => readClaudeAccountsUsage({ accounts, loginLabel }),
  id: "claude",
  label: "Claude Code",
  get description() { return t("claude.description"); },

  capabilities: {
    title: true,       // renameSession / customTitle。公式 CLI・VS Code と共有される
    tag: true,         // tagSession / tag。同上
    fork: true,
    forkMessage: true,
    subagents: true,
    liveModel: true,
    liveMode: true,
    hostTools: true,
    plyAgents: true,   // ply_agents を mcpServers に、その instructions を append に渡す
    alwaysAllow: true,
    login: true,
    // 会話ごとのアカウント（claude setup-token のトークン）を選べる。server は oauthToken を渡す（core/claude-accounts.mjs）
    claudeAccounts: true,
    // 互換の接続先（Anthropic 互換）を会話ごとに選べる。server は endpoint を渡す（core/compat-endpoints.mjs）
    compatEndpoints: true,
  },

  // 親側の Task の説明を拾ってサブエージェントの見出しにする（server.mjs）。
  // ツール名はバックエンドごとに違うので、ここで宣言する。
  subagentTools: ["Task", "Agent"],

  auth: claudeAuth,
  toolHints: TOOL_HINTS,

  modes: () => MODES,
  models: (cwd) => claudeModels(cwd),
  // 一覧が引けないうち（未ログイン・一覧の取得中）は、保存済みの id を無効にしない（CLI が確かめる）
  async validModel(model, cwd) {
    if (typeof model !== "string" || model.length > 200 || /[\r\n\x00]/.test(model)) return false;
    if (!model) return true;
    return Object.hasOwn(await claudeModels(cwd), model) || (!anyCatalog && /^[\w.\-\[\]]+$/.test(model));
  },

  // ---- 実行 ---------------------------------------------------------------

  /**
   * 1ターン回す。正規化イベントだけを emit する（生の SDK メッセージは外に出さない）。
   * 新規セッションは走り出すまで id が無いので、確定した時点で `session` イベントを出す。
   */
  async runTurn({ prompt, sessionId, cwd, mode, model, effort, emit, onPromptDelivered, askPermission, signal, control, hostSessionId, hostBackend, visualizeInstructions, contextRuntime, agentRuntime, oauthToken, endpoint = null, locale }) {
    // locale は会話の言語（host ツールの説明と承認の deny の理由。core/server.mjs が会話ごとに決めて渡す）
    const ctx = { sessionId: sessionId ?? null, emit, hostSessionId, hostBackend, locale };
    let releaseContext;
    const readyContext = new Promise(resolve => { releaseContext = resolve; });
    const userMessage = (text) => ({ type: 'user', session_id: ctx.sessionId ?? '', parent_tool_use_id: null, message: { role: 'user', content: String(text ?? '') } });

    // 入力（CLI の stdin）は開けたままにする。文字列のプロンプトや 1 件で終わる generator だと、
    // SDK は最初の result の直後に stdin を閉じる。閉じた CLI はバックグラウンドの subagent を
    // 待つが、待つのは CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS（既定 600 秒）までで、超えると殺して終わる。
    // 開けておけば、裏で走っている間も途中送信（control.steer）を main に届けられる。
    // 閉じるのは tracker.canCloseInput() が揃ったとき（claude-background.mjs）と中断のときだけ。
    const tracker = createTurnTracker();
    const input = createInputQueue();
    // プロンプトを CLI へ渡したか。渡す前の失敗（ネイティブの指示・MCP を止められないなど）は undelivered を付けて投げる
    let promptSent = false;
    async function* promptStream() {
      if (contextRuntime) await readyContext;
      if (input.closed || signal?.signal?.aborted) return;       // 走り出す前に中断された
      promptSent = true;
      onPromptDelivered?.();
      yield userMessage(prompt);
      yield* input;
    }
    // host ツールの結果も承認の返事も、この入力（CLI の stdin）を通って CLI へ戻る。
    // 走っている間は閉じない。閉じた後に終わったものは届かないので、そのときは log に出す
    // （claude-background.mjs の注意書き）。
    const hostCalls = createHostCalls();
    ctx.hostCalls = hostCalls;
    const closer = createInputCloser({
      tracker,
      inflight: () => hostCalls.inflight,
      close: () => { hostCalls.markClosed(); input.close(); },
    });
    hostCalls.watch(() => closer.settle());   // 最後の応答が終わった時点でも閉じてよいか見直す
    const settleInput = () => closer.settle();
    const closeInput = () => closer.now();
    // SDK には server の AbortController（signal）を渡さない。渡すと中断の瞬間に SDK が CLI の stdin を閉じ、
    // interrupt の control_request を書けなくなる（閉じた後の書き込みは黙って捨てられる）。
    // stdin を閉じるだけでは CLI は止まらず、今の仕事と待ち行列を片付けてから終わる。Windows では
    // SDK が 2 秒 + 5 秒待ってから claude.exe を kill するので、それまで動き続けていた（2026-09-23 調査）。
    // そこで中断はまず interrupt（Esc と同じ）で頼み、応答が無いときだけ sdkAbort を引く（stopTurn）
    const sdkAbort = new AbortController();

    // Pleiad 自身が渡す MCP。MCP を Pleiad が担当するときの「ネイティブ MCP を止められたか」の確認でも、これらは除く
    const plyServers = { host: buildToolServer(ctx), ...(agentRuntime ? { ply_agents: { type: "http", url: agentRuntime.url, headers: agentRuntime.headers } } : {}), ...(contextRuntime ? { ply_context: { type: 'http', url: contextRuntime.url, headers: contextRuntime.headers } } : {}) };
    // 互換の接続先（core/compat-endpoints.mjs）。env を組み替え（親の ANTHROPIC_* と OAuth トークンを外して接続先の値を入れる）、
    // 同じ値をフラグ設定のファイルにも書く（ユーザーの settings.json の env が options.env に勝つため。オブジェクトで渡すと argv にキーが載る）。
    // Pleiad の担当の設定（claudeContextOptions の settings）も同じファイルに入れる
    const contextOptions = claudeContextOptions(contextRuntime);
    const flag = endpoint ? await writeClaudeFlagSettings(store.dataDir, endpoint, contextOptions.settings) : null;
    const hide = text => redactSecret(redactToken(text, oauthToken), endpoint?.key);
    // query の組み立てで例外になっても、鍵を含むフラグ設定のファイルを残さない（ターンの終わりの finally まで届かないため）
    let q;
    try { q = sdk.query({
      prompt: promptStream(),
      options: {
        pathToClaudeCodeExecutable: sdk.executable(),
        // env は置き換え（足し算ではない）なので process.env を必ず広げる。
        // 待ちの上限は 0 = 無し。入力を開けている限り CLI は上限を見ないが、閉じた後の保険として外す。
        // 会話で選んだアカウントのトークンは、この会話の env にだけ入れる（process.env は触らない。core/claude-accounts.mjs）
        env: endpoint ? claudeCompatEnv(process.env, endpoint, { CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: "0" })
          : claudeEnv(process.env, { token: oauthToken, extra: { CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: "0" } }),
        // CLI の stderr は今まで捨てていた（上限で subagent を殺したことも分からなかった）。トークン・接続先のキーが紛れても伏せる
        stderr: createStderrLog({ secrets: [oauthToken, endpoint?.key].filter(Boolean) }),
        resume: sessionId ?? undefined,
        cwd,
        abortController: sdkAbort,
        // 流し込んだ user メッセージが**折り込まれた瞬間**に echo（isReplay）を返させる。
        // 既定ではストリームに合図が無く、途中送信が会話に入ったことを外から確かめられない。
        // 返ってくるのは最初のプロンプトと自分が push した分だけで、CLI 内部の通知は replay されない
        // （実測 2026-09、CLI 2.1.273）。content が文字列の user から normalize は何も作らないので表示は変わらない
        extraArgs: { 'replay-user-messages': null },
        mcpServers: plyServers,
        // ~/.claude と .claude を読ませる。R1（skill / command / hooks / memory）はここで効く。
        settingSources: ["user", "project", "local"],
        skills: "all",
        ...contextOptions,
        ...(flag ? { settings: flag.file } : {}),
        ...((visualizeInstructions || contextRuntime?.prompt || agentRuntime?.instructions) ? { systemPrompt: { type: 'preset', preset: 'claude_code', append: [contextRuntime?.prompt, visualizeInstructions, agentRuntime?.instructions].filter(Boolean).join('\n\n') } } : {}),
        // adaptive = モデルが必要な分だけ考える。
        // 注意: このモデルの thinking ブロックは署名だけで平文が入らない（2026-08 時点、
        // display の有無を問わず `thinking` は空文字）。したがって思考の中身は表示できない。
        // 使えるのは「考えている」ことと thinking.delta の estimatedTokens だけ。
        // 互換の接続先は「思考を送る」をオンにした先にだけ送る（決定 4。オフの先は env で thinking・effort を止めてある）
        ...(!endpoint || endpoint.options?.sendThinking ? { thinking: { type: "adaptive" } } : {}),
        // 承認モード。既定は都度確認。切り替えは人間だけができる（server 側で担保）。
        // SDK 側が先に判断し、なお迷うものだけが canUseTool に来る（bypass では来ない）。
        permissionMode: sdkMode(mode),
        ...(sdkMode(mode) === "bypassPermissions" ? { allowDangerouslySkipPermissions: true } : {}),
        // 未指定なら SDK の既定に任せる（設定を上書きしない）
        ...(model || endpoint?.roles?.main ? { model: model || endpoint.roles.main } : {}),
        ...(effort && (!endpoint || endpoint.options?.sendThinking) ? { effort } : {}),
        includePartialMessages: true,
        canUseTool: makeCanUseTool(ctx, askPermission),
      },
    }); } catch (e) { await flag?.dispose(); throw undelivered(e); }

    // 実行中に承認モードやモデルを変えられるようにする。
    // ターン開始時の options だけだと、走り出した後の切り替えが効かない。
    if (control) control.handle = q;
    // 裏のコマンドの停止ボタンはターンの外（WS の stopBackground）から来る。**Pleiad の会話 id**で引けるようにする
    // （バックエンドを乗り換えた会話では、Claude の id と会話 id が別物になる）。
    const holdQuery = (id) => {
      const key = hostSessionId ?? id; if (key) liveQueries.set(key, q);
      if (id) turnTrackers.set(id, tracker);   // getSubagentState はネイティブ id で来る（conversations.mjs が訳す）
    };
    holdQuery(ctx.sessionId);
    // 途中送信。受け付けたら true。入力を閉じた後・中断後は false を返し、server はそのメッセージを
    // 今のターンが終わってから次のターンで送る（codex.mjs の control.steer と同じ約束）。
    //
    // priority "next" で流すと、**次のツール結果の区切り**で今のターンに折り込まれ、
    // そのターンの中で答える。実測（2026-09、CLI 2.1.273。temporary/steer-inline/）:
    //   - ツールを走らせている最中: その結果の直後に折り込まれ、同じターンで答える
    //   - 承認を待っている最中: 承認が返るまで待ち、返った区切りで同じターンに折り込まれる
    //   - 裏の作業を待って main が止まっている最中: 止まっていること自体が区切りになり、
    //     約 1.6 秒で折り込まれてすぐ答える（"later" と同じ速さ）
    // どの場面でも遅れないので、tracker の状態で priority を出し分けることはしない。
    // 区切りが来ないまま CLI の内部ターンが終わったとき（最後の本文を書いている最中に送ったとき）は、
    // CLI が待ち行列に溜まった分を**全部まとめて**次の内部ターンとして取り出す。Claude の Pleiad ターンは
    // query 全体なので（途中の result は heldResult で保留する）、その答えも**同じ Pleiad ターンの中**で流れる。
    //
    // 折り込まれた瞬間はストリームに合図が無い。`replay-user-messages`（options の extraArgs）を
    // 付けると、折り込みと同時に isReplay の user が流れるので、それと突き合わせて渡ったものを
    // userMessage.delivered として外へ出す（takeDelivered）。突き合わせは**毎回新しく振る uuid** が本命。
    // 本文だけで照合していたころは、まとめて取り出された分（本文が \n でつながった replay が 1 本だけ）を
    // 取りこぼし、答えが返っているのに「次の区切りで AI に渡します」が残った（実測 2026-09-23、CLI 2.1.280。
    // uuid を付けたフレームだけ、メンバーごとの replay が出る）。uuid は CLI の重複除けにも効くので使い回さない。
    // uuid は interrupt({ cancelQueued }) で取り消された分を知るのにも使う（stopTurn）
    const pendingSteers = [];        // { id, uuid, text, sawResult } 流し込んだが、まだ折り込まれていないもの
    const openSteer = () => {
      if (!control) return;
      // 「渡った」合図を後から出せる。server はこれを見て、渡るまでを pending として画面に出す
      control.steerConfirms = true;
      control.steer = async (item) => {
        const text = String(item?.args?.prompt ?? "");
        if (input.closed || signal?.signal?.aborted) return false;
        // item.id（outbox の id）は UUID とは限らないので、CLI に渡す uuid は別に振る
        const uuid = randomUUID();
        if (!input.push({ ...userMessage(text), uuid, priority: "next" })) return false;   // CLI の既定と同じだが、既定が変わっても折り込みを保つ
        pendingSteers.push({ id: item?.id ?? null, uuid, text, sawResult: false });
        tracker.pushed();
        settleInput();   // 流し込んだ分がまだ手付かずなので、閉じる予約が出ていたら取り消す
        return true;
      };
      control.onReady?.();
    };

    const takeAt = (i) => pendingSteers.splice(i, 1)[0].id;
    /**
     * まとめて取り出された分の本文（メンバーの本文を \n でつないだもの）から、含まれる途中送信を取り出す。
     * 先頭から順に、覚えている順で当てはめる。最後まで当てはまったときだけ取り出す（途中で外れたら何もしない）
     */
    const takeMerged = (text) => {
      const hits = [];
      let pos = 0;
      for (let i = 0; i < pendingSteers.length && pos < text.length; i++) {
        const t = pendingSteers[i].text;
        if (!t || !text.startsWith(t, pos)) continue;
        const end = pos + t.length;
        if (end !== text.length && text[end] !== "\n") continue;
        hits.push(i);
        pos = end === text.length ? end : end + 1;
      }
      if (pos !== text.length || !hits.length) return [];
      return hits.reverse().map(takeAt).reverse();
    };
    /**
     * 折り込みの echo（isReplay の user）と、流し込んだ途中送信を突き合わせ、渡った分の id を返す。
     * 1. uuid で引く。まとめて取り出された分の replay は最後のメンバーの uuid を持ち、本文はつないだもの。
     *    前のメンバーは普通それぞれの uuid で先に来るが、来なかったときに備えて本文の残りからも拾う
     * 2. 本文の完全一致（uuid を返さない CLI への備え）
     * 3. 本文がつないだものなら、含まれる分をまとめて
     * 最初のプロンプトも replay されるが、覚えていないので素通りする。
     */
    const takeDelivered = (m) => {
      if (m?.type !== "user" || !m.isReplay || !pendingSteers.length) return [];
      const text = typeof m.message?.content === "string" ? m.message.content : null;
      const byUuid = m.uuid ? pendingSteers.findIndex((p) => p.uuid === m.uuid) : -1;
      if (byUuid >= 0) {
        const hit = pendingSteers[byUuid];
        const ids = [takeAt(byUuid)];
        if (text && text !== hit.text && text.endsWith("\n" + hit.text)) {
          ids.unshift(...takeMerged(text.slice(0, text.length - hit.text.length - 1)));
        }
        return ids;
      }
      if (text === null) return [];
      const same = pendingSteers.findIndex((p) => p.text === text);
      if (same >= 0) return [takeAt(same)];
      return takeMerged(text);
    };
    /**
     * 保険。CLI の内部ターンが終わった（result）後に次の内部ターンが始まった（system/init）なら、
     * その result より前に流し込んで残っている分は、もう取り出されている（CLI は区切りで溜まった分を全部取り出す）。
     * replay を取りこぼしても、答えが流れている間ずっと「渡します」のまま残らないようにする
     */
    const takeLeftovers = (m) => {
      if (m?.type === "result") { for (const p of pendingSteers) p.sawResult = true; return []; }
      if (m?.type !== "system" || m.subtype !== "init") return [];
      const ids = [];
      for (let i = pendingSteers.length - 1; i >= 0; i--) if (pendingSteers[i].sawResult) ids.unshift(takeAt(i));
      return ids;
    };

    // 中断（server の turn.ac）。まず CLI に interrupt を頼む（Esc と同じで、今のターンをすぐ打ち切る）。
    // cancelQueued で、流し込んだがまだ折り込まれていない途中送信も CLI 側で取り消させる
    // （d.ts の型には引数が無いが、SDK 0.3.258 の実装は受けて cancel_queued を付ける。古い CLI は無視する）。
    // 取り消された分は userMessage.dropped を出し、server が送信待ちの保留へ戻す。
    // perTaskStopAffordance を宣言していないので、interrupt は裏のタスクも止める。
    // 受領（interrupt の応答か result）が stopAckMs のうちに来なければ、入力を閉じて SDK の abort に落とす。
    // 受領した後は入力を閉じ、CLI が自分で終わるのを stopExitMs まで待つ（過ぎたら同じく SDK の abort）。
    // どちらで終わっても、このターンの結果は aborted にする（interrupt の後は例外ではなく result で終わるため、
    // signal.aborted の catch だけでは拾えない）。
    // Windows でのプロセスツリーごとの強制終了は入れていない。SDK が pid を渡すのは spawnClaudeCodeProcess で
    // 自前に起動したときだけで、そうすると SDK の stderr の扱い（終了時のエラーに添える末尾）を失うため
    let stop = null;   // { acked, forced, timer }
    const clearStopTimer = () => { if (stop?.timer) { clearTimeout(stop.timer); stop.timer = null; } };
    const forceStop = () => {
      if (!stop || stop.forced) return;
      stop.forced = true;
      clearStopTimer();
      closeInput();
      sdkAbort.abort();
    };
    const stopAcked = () => {
      if (!stop || stop.acked || stop.forced) return;
      stop.acked = true;
      clearStopTimer();
      closeInput();
      stop.timer = setTimeout(forceStop, sdk.stopExitMs);
    };
    const dropCancelled = (uuids) => {
      if (!Array.isArray(uuids)) return;
      for (const uuid of uuids) {
        const i = pendingSteers.findIndex((p) => p.uuid === uuid);
        if (i < 0) continue;   // こちらが送っていない uuid（CLI 内部の分）は無視する
        const id = takeAt(i);
        if (id) emit({ type: "userMessage.dropped", messageId: id });
      }
    };
    const stopTurn = () => {
      if (stop) return;
      stop = { acked: false, forced: false, timer: null };
      if (typeof q?.interrupt !== "function") return forceStop();
      stop.timer = setTimeout(forceStop, sdk.stopAckMs);
      Promise.resolve()
        .then(() => q.interrupt({ cancelQueued: true }))
        .then((receipt) => { dropCancelled(receipt?.cancelled); stopAcked(); },
          () => forceStop());   // 送れなかった（CLI が既に落ちている・受け付けない）
    };
    if (signal?.signal?.aborted) stopTurn();
    else signal?.signal?.addEventListener?.("abort", stopTurn, { once: true });

    // init メッセージには**実際に解決されたモデル**が乗る。エイリアス（opus / haiku）が
    // 何になったかはこれでしか分からないので、session イベントに添えて外へ出す。
    // init が最初に来るとは限らない（stream_event が先に session_id を運ぶことがある）ので、
    // 「id が決まった」と「モデルが分かった」を別々に見る。
    //
    // `first: true` は「この session で id が確定した」の印。web の isMine は
    // 新規セッションの id をこの印が付いた 1 本からしか採用しない。
    // モデルが分かっただけの 2 本目や、再開ターンが出す session には付けない
    // （付けると、別タブが新規の id を待っている最中に再開ターンの id を掴んでしまう）。
    let toldModel = false;
    let heldResult = null;
    try {
      if (contextRuntime) {
        await q.initializationResult();
        if (contextRuntime.owners.instruction === 'ply') {
          // 指示ファイルは最初のプロンプトを処理するときに読まれることが多く、ここではまだ空のことがある。
          // 止める本体は claudeMdExcludes（context-options.mjs）で、この確認は取りこぼしを拾う保険
          const usage = await q.getContextUsage({ detail: 'summary' });
          if (usage.memoryFiles?.length) throw new Error(t('claude.errors.nativeInstructions'));
        }
        if (contextRuntime.owners.mcp === 'ply') {
          const native = await q.mcpServerStatus();
          const left = unexpectedNativeMcp(native, Object.keys(plyServers));
          if (left.length) throw new Error(t('claude.errors.nativeMcp', { names: left.join(t('claude.listSeparator')) }));
        }
        releaseContext();
      }
      openSteer();
      for await (const message of q) {
        const model = message.type === "system" && message.subtype === "init" && message.model
          ? String(message.model) : null;

        // 再開を頼んだのに別の id が来た = Claude Code が transcript を見つけられず新しく始めた
        // （作業ディレクトリを変えて再開したときに起きうる。CLI は cwd のプロジェクトを探す）。
        // 黙って別のセッションに書き続けるより、止めて知らせる
        if (sessionId && message.session_id && message.session_id !== sessionId) {
          throw new Error(t('claude.errors.resumeMismatch', { expected: sessionId, actual: message.session_id }));
        }
        if (message.session_id && ctx.sessionId !== message.session_id) {
          ctx.sessionId = message.session_id;
          holdQuery(message.session_id);
          toldModel ||= Boolean(model);
          emit({ type: "session", sessionId: message.session_id, first: true, ...(model ? { model } : {}) });
        } else if (model && !toldModel) {
          toldModel = true;
          emit({ type: "session", sessionId: ctx.sessionId ?? message.session_id ?? null, model });
        }

        // 流し込んだ途中送信が会話に折り込まれた。どれが渡ったかを、返答より先に知らせる
        for (const id of [...takeDelivered(message), ...takeLeftovers(message)]) {
          if (id) emit({ type: "userMessage.delivered", messageId: id });
        }
        // 中断を頼んだ後の result は、interrupt が効いた合図（応答より先に来ることがある）
        if (stop && message.type === "result") stopAcked();

        for (const ev of normalizeSdkMessage(message)) {
          // result は 1 回の query で何度も出る（裏の subagent が終わるたびに main が再開する・途中送信に答える）。
          // turnResult は「このターンが終わった」の合図で、server はそれを見て途中送信を止める。
          // 成功の分は最後の 1 つだけを query の終わりに出す。使用量（usage）は累計なのでその都度出してよい。
          // 中断を頼んだ後の result（打ち切られた内部ターン）は出さない。結果は最後に aborted で出す
          if (ev.type === "turnResult" && stop) continue;
          if (ev.type === "turnResult" && ev.outcome === "ok") { heldResult = ev; continue; }
          emit(ev);
        }
        // 裏の作業と main の状態（background / phase）。変わったときだけ出る
        for (const ev of tracker.observe(message)) emit(ev);
        settleInput();
      }
      if (stop) emit({ type: "turnResult", outcome: "aborted" });
      else if (heldResult) emit(heldResult);
    } catch (err) {
      // 中断は「失敗」ではない。呼び出し側（server）は finally で片付けるだけなので、
      // 何が起きたかは turnResult で web に伝える。
      if (stop || signal?.signal?.aborted) {
        emit({ type: "turnResult", outcome: "aborted" });
        return { sessionId: ctx.sessionId };
      }
      const message = hide(err?.message ?? err);
      emit({ type: "turnResult", outcome: "error", error: message });
      const thrown = (oauthToken || endpoint) && err?.message && message !== err.message ? new Error(message) : err;
      throw promptSent ? thrown : undelivered(thrown);
    } finally {
      clearStopTimer();
      await flag?.dispose();
      signal?.signal?.removeEventListener?.("abort", stopTurn);
      for (const [id, x] of liveQueries) if (x === q) liveQueries.delete(id);
      closeInput();
      if (contextRuntime) { q.close(); releaseContext(); }
      if (control) { control.handle = null; control.steer = null; control.steerConfirms = false; }
    }

    return { sessionId: ctx.sessionId };
  },

  /**
   * 裏で走っているタスクを 1 本止める（作業ダイアログの停止ボタンから）。
   *
   * ターンを保持したまま待つのが Claude なので、止める相手は**走っているターンの query**。
   * `Query.stopTask` を叩くと CLI は status: "stopped" の task_notification を出し、
   * tracker がそれで一覧から消す。**先回りして印を消さない**（止めたつもりで生きている方が悪い）。
   * 終わらないコマンド（`npm run dev` など）で入力が閉じられなくなったときの唯一の逃げ道でもある。
   */
  async stopBackground(sessionId, taskId) {
    const q = liveQueries.get(sessionId);
    if (!q) throw new Error(t("claude.errors.turnNotRunning"));
    if (typeof q.stopTask !== "function") throw new Error(t("claude.errors.stopUnsupported"));
    await q.stopTask(taskId);
    return { stopped: true };
  },

  /** 走っている最中のモデル切り替え。効かなければ false（web は「次のターンから」になる）。 */
  async setModelLive(handle, model) {
    if (!handle?.setModel || !model) return false;
    try { await handle.setModel(model); return true; } catch { return false; }
  },

  async setModeLive(handle, mode) {
    if (!handle?.setPermissionMode) return false;
    try { await handle.setPermissionMode(sdkMode(mode)); return true; } catch { return false; }
  },

  // ---- セッション管理 -----------------------------------------------------

  async listSessions({ limit = 100 } = {}) {
    const rows = await sdkListSessions({ limit });
    return rows.map(toRow).filter(Boolean);
  },

  async getSession(sessionId) {
    if (!sessionId) return null;
    try {
      return toRow(await getSessionInfo(sessionId));
    } catch {
      return null;
    }
  },

  async getMessages(sessionId, options) {
    const entries = await getSessionMessages(sessionId).catch(() => []);
    // 走っているターンに折り込まれた途中送信は getSessionMessages に出ない。transcript から拾って戻す
    const rows = await readQueuedCommandRows(sessionId);
    return transcriptToMessages(mergeQueuedCommands(entries, rows), options);
  },

  setTitle: (sessionId, title) => renameSession(sessionId, title),
  setTag: (sessionId, tag) => tagSession(sessionId, tag || null),
  fork: (sessionId, { upToMessageId, title } = {}) => forkSession(sessionId, { upToMessageId, title }),

  listSubagents: (sessionId) => sdkListSubagents(sessionId),

  // どの委譲ツール（tool_use id）から生まれたか。SDK は meta.json の toolUseId を各エントリの parent_tool_use_id に載せる
  async getSubagentOrigin(sessionId, agentId) {
    const raw = await readSubagentEntries(sessionId, agentId, { limit: 1 })
      ?? await sdkGetSubagentMessages(sessionId, agentId, { limit: 1 }).catch(() => []);
    return raw.find((e) => e?.parent_tool_use_id)?.parent_tool_use_id ?? null;
  },

  /**
   * サブエージェントの状態。そのターンで見た SDK メッセージから答える（追加の I/O はしない）。
   * 見ていない子（Pleiad の外で動かした分・サーバー再起動の前の分）は null＝分からない
   */
  async getSubagentState(sessionId, agentId) {
    return turnTrackers.get(sessionId)?.subagentState(agentId) ?? null;
  },

  async getSubagentMessages(sessionId, agentId, { limit = 200 } = {}) {
    const raw = await readSubagentEntries(sessionId, agentId, { limit })
      ?? await sdkGetSubagentMessages(sessionId, agentId, { limit }).catch(() => []);
    // サブエージェント側のメッセージは parent_tool_use_id を持つので、落とさずに読む
    return transcriptToMessages(raw, { includeNested: true });
  },

  /**
   * 小さいモデルで1発。会話の中身を見て決めるので、走っているターンとは別に立てる。
   * 道具も設定も要らないので settingSources / allowedTools を切って軽く回す。
   * 返すのは生成された生のテキスト。前後の記号を落とす整形は server 側（バックエンド非依存）。
   */
  // locale は会話の言語。タイトルもその言語で作らせる
  async suggestTitle({ transcript, oauthToken, endpoint = null, locale }) {
    let title = "";
    try {
      for await (const m of query({
        prompt: agentT(locale, 'title.claude') + NL + NL + transcript,
        options: {
          pathToClaudeCodeExecutable: claudeExecutable(), model: "haiku", settingSources: [], allowedTools: [], permissionMode: "default",
          // その会話で選んだアカウントで回す。選んでいなければ env を渡さない（今までどおり SDK が process.env を使う）。
          // 互換の接続先の会話は、その接続先の Haiku 相当のモデル（"haiku" が ANTHROPIC_DEFAULT_HAIKU_MODEL に置き換わる）。
          // settingSources が空なのでユーザーの settings.json は読まれず、env だけで足りる
          ...(endpoint ? { env: claudeCompatEnv(process.env, endpoint) } : oauthToken ? { env: claudeEnv(process.env, { token: oauthToken }) } : {}) },
      })) {
        if (m.type !== "assistant") continue;
        for (const b of m.message?.content ?? []) if (b.type === "text") title += b.text;
      }
    } catch (err) {
      if (oauthToken || endpoint) throw new Error(redactSecret(redactToken(err?.message ?? err, oauthToken), endpoint?.key));
      throw err;
    }
    return title;
  },
};

export { AUTO_ALLOW, HOST_TOOL_NAMES, MODES, MODELS };
