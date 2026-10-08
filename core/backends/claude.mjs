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
  renameSession, tagSession, forkSession, deleteSession as sdkDeleteSession,
  listSubagents as sdkListSubagents, getSubagentMessages as sdkGetSubagentMessages,
} from "@anthropic-ai/claude-agent-sdk";
import { claudeAuth } from '../auth/claude-cli.mjs';
import { t, agentT } from '../i18n.mjs';
import { readClaudeAccountsUsage } from './claude-usage.mjs';
import { claudeEnv, redactToken } from '../claude-accounts.mjs';
import { claudeCompatEnv, writeClaudeFlagSettings, adoptClaudeFlagSettings, redactSecret } from '../compat-endpoints.mjs';
import { claudeExecutable } from '../cli-installation.mjs';
import { AUTO_COMPACT_WINDOW_ENV } from '../compaction-settings.mjs';
import { claudeContextOptions, claudeQueryExtraArgs, unexpectedNativeMcp } from './context-options.mjs';
import { claudeHookCallbacks, mergeCallbacks } from '../hooks-unify.mjs';
import { undelivered } from './undelivered.mjs';
import { z } from "zod";
import fs from "node:fs/promises";
import { statSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import os from "node:os";
import * as store from "../store.mjs";
import { recordBackendShapeMismatch } from '../backend-shape-diagnostics.mjs';
import { buildClaudeModels, FALLBACK_MODELS } from "./claude-models.mjs";
import { ZERO_COST, readCostState, decideCostBase } from "./claude-cost-state.mjs";
import { normalizeSdkMessage, createClaudeCompactDiagnostic, claudeCompactionsFromHistory, transcriptToMessages, mergeQueuedCommands, stopHookFollowUps, subagentEntries, invalidSubagentTranscript, invalidQueuedCommandTranscript, transcriptSystemMarks } from "./claude-normalize.mjs";
import { classifySystemMessages } from "../system-messages.mjs";
import { promptTitle } from "../prompt-title.mjs";
import { createTurnTracker, createInputQueue, createInputCloser, createHostCalls, createStderrLog, RESUME_GRACE_MS } from "./claude-background.mjs";
import { COMPUTER_CALL_TIMEOUT_SEC, COMPUTER_SERVER, computerPrompt, isComputerTool } from "./computer-delivery.mjs";
import { BROWSER_SERVER } from "../browser-bridge.mjs";
import { promptHash } from "../turn-card.mjs";
import { ADOPT_TURN_MARK } from "../adopt.mjs";
import { createHeldCli, heldPlan } from "./claude-held.mjs";
import { CONTROL_SERVER } from "../ops/surfaces/mcp.mjs";

const NL = String.fromCharCode(10);

// runTurn が使う SDK の入口と中断の待ち時間。テスト（tests/unit/claude-steer-stop.mjs）だけが差し替える。
// 中断は CLI に interrupt を頼み、stopAckMs のうちに受領（interrupt の応答か result）が無ければ
// 入力を閉じて SDK の abort に落とす。受領の後も stopExitMs のうちに終わらなければ同じく落とす。
// resumeGraceMs は裏の作業を見たターンで入力を閉じる前に置く猶予（claude-background.mjs の RESUME_GRACE_MS）
// probe / cliSigThrottleMs はモデル一覧の引き直し（下の CATALOG_TTL のあたり）だけがテストで差し替える
const sdk = { query, executable: claudeExecutable, probe: null, cliSigThrottleMs: 5_000, stopAckMs: 2500, stopExitMs: 3000, resumeGraceMs: RESUME_GRACE_MS };
export function setClaudeSdkForTest(over = {}) {
  const prev = { ...sdk };
  Object.assign(sdk, over);
  resetCliSignatureCache();
  return () => { Object.assign(sdk, prev); resetCliSignatureCache(); };
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
// このモードでも、Claude Code は安全の検査（中身が空かもしれない変数を使った危ない rm など）に当たる呼び出しだけは
// 飛ばさず canUseTool で聞いてくる。承認カードが全く出ないとは限らない（bypass の子の `rm -f $OUT/*` で出た）。
// 受ける側（askPermission）は、モードによらず来た問いを人に回す。
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
// CATALOG_WAIT は手元に一覧が何も無いとき（起動直後の初回）だけ待つ上限。引き直しは 9〜11 秒掛かるので、8 秒待っても
// 間に合わず固定の一覧で答えていた。起動のときに warmModels で引いておくので、ここで待つのは起動から数秒の間だけにする
const CATALOG_TTL = 30 * 60_000, CATALOG_RETRY = 60_000, CATALOG_WAIT = 3_000;
const PROVIDER_ENV = ["ANTHROPIC_BASE_URL", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_CODE_USE_MANTLE", "CLAUDE_CODE_USE_ANTHROPIC_AWS", "CLAUDE_CODE_USE_GATEWAY"];
// 引く条件（作業場所・段に効く設定）ごとに 1 件。{ value, at, failed, probe, cliSig }
const catalogs = new Map();
let anyCatalog = null, anyCatalogSig = null;   // どれか 1 件でも取れたか（validModel が保存済みの id を通すかどうか）

// CLI の実体（パス・更新時刻・サイズ）の目印。claude update でモデルが増えても（2026-09-29、
// 2.1.284 で Sonnet 5.5）CATALOG_TTL の 30 分は古い一覧のままだったので、版が変わったら TTL 内でも引き直す。
// claudeExecutable() はプロセスを起こさず PATH を辿るだけだが、呼ばれる頻度（models() は request のたびに来る）
// に合わせて数秒だけ間引く。stat に失敗したら（未導入など）null を返し、今までどおり目印無しで動く
let cliSigAt = 0, cliSigValue = null;
function cliSignature() {
  const now = Date.now();
  if (now - cliSigAt < sdk.cliSigThrottleMs) return cliSigValue;
  cliSigAt = now;
  try {
    const exe = sdk.executable();
    const stat = statSync(exe);
    cliSigValue = `${exe}|${stat.mtimeMs}|${stat.size}`;
  } catch { cliSigValue = null; }
  return cliSigValue;
}
function resetCliSignatureCache() { cliSigAt = 0; cliSigValue = null; }

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
sdk.probe ??= probeCatalog;

/** anyCatalog を、今の CLI の目印と食い違わない間だけ返す。食い違ったら（版が変わった）忘れる */
function freshAnyCatalog(cliSig) {
  if (anyCatalog && cliSig && anyCatalogSig && cliSig !== anyCatalogSig) { anyCatalog = null; anyCatalogSig = null; coldSince = 0; }
  return anyCatalog;
}
// 手元に一覧が何も無いまま待ち始めた時刻。待つのは CATALOG_WAIT までを全員で共有する（呼ぶたびに数え直さない。
// 起動直後は newSession・models・efforts が続けて来るので、数え直すと 3 秒ずつ重なる）
let coldSince = 0;
function loadCatalog(cwd, pref) {
  // 別の接続先のときは設定を読まないので、作業場所で結果は変わらない
  const key = pref.custom ? "custom" : `${cwd || ""}|${pref.sig}`, now = Date.now();
  const cliSig = cliSignature();
  let e = catalogs.get(key);
  if (!e) {
    if (catalogs.size >= 32) catalogs.delete(catalogs.keys().next().value);
    e = { value: null, at: 0, failed: 0, probe: null, cliSig: null }; catalogs.set(key, e);
  }
  // CLI の版が変わっていたら（claude update）、30 分の TTL 内・失敗の再試行待ちの中でも忘れて引き直す
  if (e.cliSig && cliSig && e.cliSig !== cliSig) { e.value = null; e.at = 0; e.failed = 0; }
  if (e.value && now - e.at < CATALOG_TTL) return Promise.resolve(e.value);
  // 手元の答え: この条件の古い一覧 → 別の条件で取れた一覧（段は利用者の設定で補う）。無ければ null（固定の一覧で答える）
  const stand = () => e.value ?? (freshAnyCatalog(cliSig) && { ...anyCatalog, applied: false }) ?? null;
  if (now - e.failed < CATALOG_RETRY) return Promise.resolve(stand());
  e.probe ??= sdk.probe(cwd, !pref.custom)
    .then((c) => { e.value = c; e.cliSig = cliSig; e.failed = 0; anyCatalog = c; anyCatalogSig = cliSig; coldSince = 0; e.at = Date.now(); return c; })
    .catch((err) => { e.failed = Date.now(); e.cliSig = cliSig; console.error("  Claude のモデル一覧を取れなかった:", String(err?.message ?? err)); return e.value; })
    .finally(() => { e.probe = null; });
  // 引き直しは裏で走らせ、手元の答えがあれば待たずに返す（引き直しは CLI を起こして 10 秒ほど掛かる。会話を作る・一覧を開くたびに待たせない）
  const handy = stand();
  if (handy) return Promise.resolve(handy);
  // 手元に何も無い（起動直後の初回）ときだけ待つ。長く掛かる（未ログイン・未導入）ときは固定の一覧で先に答える
  coldSince ||= now;
  const left = CATALOG_WAIT - (now - coldSince);
  if (left <= 0) return Promise.resolve(null);
  return Promise.race([e.probe.then((v) => v ?? stand()), new Promise((resolve) => setTimeout(() => resolve(stand()), left).unref?.())]);
}

/** 起動のときに一覧を裏で引いておく（最初の会話・一覧の要求が待たない）。作業場所は新しい会話の既定（ホーム）。失敗は黙る（引くときに出す） */
async function warmCatalog(cwd) {
  const pref = await preferredSettings(cwd);
  await loadCatalog(cwd, pref);
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
  // 応答は CLI の stdin を通る。走っている間は入力を閉じさせない（claude-background.mjs）。
  // 引き継ぎ（無停止の更新 2d。core/handover.mjs）は、走っている mcp_message のハンドラーが終わるのを上限つきで待つ（ctx.track）
  const hosted = (name, handler) => (args) => {
    const work = ctx.hostCalls ? ctx.hostCalls.run(name, () => handler(args)) : handler(args);
    return ctx.track ? ctx.track(work) : work;
  };
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
          await ctx.hostInvoke('sessions.setStatus', { sessionId, ...args });
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
          await ctx.hostInvoke('sessions.setTitle', { sessionId, ...args });
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
          const { sessionId: child } = await ctx.hostInvoke('sessions.fork', { sessionId, ...args });
          return { content: [{ type: "text", text: agentT(ctx.locale, 'host.fork.done', { sessionId: child }) }] };
        }),
      ),
    ],
  });
}

/**
 * 委譲の子（Claude）に使わせない組み込みの道具。定義だけで約 12,300 トークンあり、子の最初のリクエストを膨らませる（ADR 0169）。
 * Workflow は子が更に多段のエージェントを組む道具、ScheduleWakeup は /loop 用、ReportFindings は code-review 用、ListAgents は SendMessage の宛先の一覧で、
 * いずれも子の仕事（依頼元へ結果を返す）には要らない。AskUserQuestion・Agent・Bash・PowerShell は残す。
 */
export const DELEGATED_CHILD_DISALLOWED_TOOLS = ['Workflow', 'ScheduleWakeup', 'ReportFindings', 'ListAgents'];

/**
 * 読み取り専用のフォルダーの deny ルール。Claude Code の `Edit(...)` は Edit・Write・NotebookEdit などファイルを書き換える道具に掛かる。
 * パスは `//` で始めるとファイルシステムの根からの絶対パス。Windows は 'C:\a\b' を '//c/a/b' にそろえる（Claude Code の照合の形）
 */
export function readOnlyDenyRules(roots) {
  return roots.map((root) => {
    const p = String(root).replace(/[\\]/g, '/').replace(/\/+$/, '');
    const drive = /^([A-Za-z]):(\/.*)?$/.exec(p);
    return `Edit(/${drive ? `/${drive[1].toLowerCase()}${drive[2] ?? ''}` : p}/**)`;
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
  // コンピューターの操作はツールごとに聞かない。アプリ単位の承認は橋（core/computer-bridge.mjs）の中で行う（ADR 0071）
  if (isComputerTool(toolName)) return { behavior: "allow", updatedInput: input };
  // ply_browser も聞かない。サイトの利用の確認は中継が行う（ADR 0042）
  if (typeof toolName === "string" && toolName.startsWith(`mcp__${BROWSER_SERVER}__`)) return { behavior: "allow", updatedInput: input };
  // 操作の一覧（ply_control）も聞かない。権限と承認は registry.invoke が会話の承認モードで決める（ADR 0082）
  if (typeof toolName === "string" && toolName.startsWith(`mcp__${CONTROL_SERVER}__`)) return { behavior: "allow", updatedInput: input };

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
      // 保持役に載せたターンは、手を離した後の SDK の止めを承認へ伝えない（runTurn の askSignal）
      signal: ctx.askSignal ? ctx.askSignal(options?.signal) : options?.signal,
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
    // customTitle は人が付けた題なのでそのまま。summary・firstPrompt は最初の発言の本文そのものであることがあるので、題の形にする（core/prompt-title.mjs）
    title: s.customTitle ?? (promptTitle(s.summary ?? s.firstPrompt) || null),
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
 * 置き場は readTranscriptExtras と同じく、組み立てずに projects の下を探す。
 */
function transcriptVersion(text) {
  for (const line of String(text).split('\n').slice(0, 20)) {
    try { const row = JSON.parse(line); if (typeof row?.version === 'string') return row.version; } catch {}
  }
  return null;
}

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
    const version = transcriptVersion(text);
    if (invalidSubagentTranscript(text)) await recordBackendShapeMismatch({ dataDir: store.dataDir, backend: 'claude', kind: 'subagent-shape', detectedVersion: version });
    const metaText = await fs.readFile(file.replace(/\.jsonl$/, ".meta.json"), "utf8").catch(() => null);
    let meta = null;
    if (metaText !== null) {
      try { meta = JSON.parse(metaText); } catch {}
    }
    if (typeof meta?.toolUseId !== 'string') await recordBackendShapeMismatch({ dataDir: store.dataDir, backend: 'claude', kind: 'subagent-meta', detectedVersion: version });
    const withOrigin = subagentEntries(text, { toolUseId: typeof meta?.toolUseId === "string" ? meta.toolUseId : null, limit });
    subagentReads.delete(slot);
    subagentReads.set(slot, { stamp, entries: withOrigin });
    if (subagentReads.size > 24) subagentReads.delete(subagentReads.keys().next().value);   // 古いものから捨てる
    return withOrigin;
  } catch {
    if (subagentFiles.has(key)) await recordBackendShapeMismatch({ dataDir: store.dataDir, backend: 'claude', kind: 'subagent-unreadable', detectedVersion: null });
    subagentFiles.delete(key);
    return null;
  }
}

/**
 * transcript（`<CLAUDE_CONFIG_DIR ?? ~/.claude>/projects/<何か>/<sessionId>.jsonl`）から、
 * SDK の getSessionMessages が返さないものを拾う。
 * - rows: attachment 行。途中送信は queued_command の attachment として残る（claude-normalize.mjs の mergeQueuedCommands）
 * - followUps: Stop フックに止められて書いた、中身の仕事をしていない続きの assistant 行の uuid（claude-normalize.mjs の stopHookFollowUps）
 * - marks: 圧縮の要約・コマンドの出力の行の印（claude-normalize.mjs の transcriptSystemMarks）。読めなければ null（文面で見分ける）
 *
 * - 置き場のディレクトリ名は cwd から作られるが、**組み立てない**（再開で cwd が変わると外れる）。
 *   projects の下を順に見て、その id の .jsonl があるところを使う。
 * - 折り込みが 1 件も無いセッションでは何も parse しない（文字列を 1 回走査するだけ）。
 * - 読めなければ空。履歴は素の getSessionMessages のまま出す（今までどおりの見た目に落ちる）。
 */
/** transcript の本文。置き場は readTranscriptExtras の説明のとおり。無ければ・読めなければ null */
async function readTranscriptText(sessionId) {
  if (!sessionId) return null;
  try {
    const projects = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"), "projects");
    for (const dir of await fs.readdir(projects)) {
      try { return await fs.readFile(path.join(projects, dir, `${sessionId}.jsonl`), "utf8"); }
      catch (error) {
        if (error?.code !== 'ENOENT') await recordBackendShapeMismatch({ dataDir: store.dataDir, backend: 'claude', kind: 'transcript-unreadable', detectedVersion: null });
      }
    }
  } catch { /* projects が無い */ }
  return null;
}

async function readTranscriptExtras(sessionId) {
  const none = { rows: [], followUps: new Set(), marks: null };
  if (!sessionId) return none;
  try {
    const text = await readTranscriptText(sessionId);
    if (!text) return none;
    const followUps = stopHookFollowUps(text);
    const marks = transcriptSystemMarks(text);
    if (!text.split('\n').some(line => line.includes('"attachment"') && line.includes('queued_command'))) return { rows: [], followUps, marks };
    const version = transcriptVersion(text);
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
    if (invalidQueuedCommandTranscript(text)) await recordBackendShapeMismatch({ dataDir: store.dataDir, backend: 'claude', kind: 'transcript-shape', detectedVersion: version });
    return { rows, followUps, marks };
  } catch {
    return none;
  }
}

/**
 * ターン開始時点の使用量の累計（transcript の最後の cost-state）。result の累計から引いてターンの分にする（claude-cost-state.mjs）。
 * 新しい会話は 0。置き場は readTranscriptExtras と同じく projects の下を順に探す。
 * null は「分からない」（見つからない・読めない・形が違う）で、そのターンの記録は数値を null にする（数えすぎを防ぐ）
 */
async function readCostBase(sessionId) {
  if (!sessionId) return ZERO_COST;
  if (!SAFE_ID.test(String(sessionId))) return null;
  let read = null;
  try {
    const projects = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"), "projects");
    for (const dir of await fs.readdir(projects)) {
      try { read = await readCostState(path.join(projects, dir, `${sessionId}.jsonl`)); break; }
      catch (error) { if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') throw error; }
    }
  } catch {
    await recordBackendShapeMismatch({ dataDir: store.dataDir, backend: 'claude', kind: 'transcript-unreadable', detectedVersion: null });
    return null;
  }
  if (!read) return null;
  const { cost, mismatch } = decideCostBase(read);
  if (mismatch) await recordBackendShapeMismatch({ dataDir: store.dataDir, backend: 'claude', kind: mismatch, detectedVersion: read.version });
  return cost;
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

// 保持役に載せたターン（claude-held.mjs）。**Claude のネイティブ id** -> { held, q }。旧サーバーの手を離す口（handOffClaude）が引く
const heldTurns = new Map();

// SDK が自分で処理して、ループへ流さない行（control_* と keep_alive・transcript_mirror。sdk.mjs の readMessages）。付け直しの記録の読み直しでも飛ばす
const SDK_CONSUMED = new Set(["control_request", "control_response", "control_cancel_request", "keep_alive", "transcript_mirror"]);
const parseLine = (line) => { try { const m = JSON.parse(line); return m && typeof m === "object" ? m : null; } catch { return null; } };

/** hooks のコールバックの表の、どのコールバックの実行も track（server の control.track。引き継ぎが待つ）に数える。track が無ければそのまま */
function trackedHooks(table, track) {
  if (typeof track !== "function") return table;
  return Object.fromEntries(Object.entries(table).map(([event, list]) => [event,
    list.map((entry) => ({ ...entry, hooks: entry.hooks.map((fn) => (...args) => track(fn(...args))) }))]));
}

/** 札の途中送信の控え（backendCard.steers）を作り直す。本文は持たない（ハッシュで当てる） */
function restoredSteers(steers) {
  return (Array.isArray(steers) ? steers : []).filter((p) => typeof p?.uuid === "string" && p.uuid)
    .map((p) => ({ id: typeof p.id === "string" ? p.id : null, uuid: p.uuid, text: null, hash: typeof p.hash === "string" ? p.hash : null, sawResult: Boolean(p.sawResult) }));
}

/**
 * 旧サーバーの手を離す口（無停止の更新 2c。2d が引き継ぎで呼ぶ形のバックエンド側。今はテストの入口 tests/lib/adopt-server.mjs が呼ぶ）:
 * 札（server の handOffTurn の card）を保持役の子に置いて detach し、その後に query を閉じる（design.md §4.4 の順序）。
 * 閉じたターンは handedOff で終わる（server は締めない）。sessionId はネイティブの id
 */
export async function handOffClaude(sessionId, card) {
  const entry = heldTurns.get(sessionId);
  if (!entry) throw new Error(`claude: no held turn to hand off (${sessionId})`);
  await entry.held.handOff(card);
  try { entry.q?.close(); } catch { /* 既に閉じている */ }
  return { childId: entry.held.id };
}

/** テスト用: 保持役の子への書き込み（承認の答え・hooks と MCP の応答・途中送信・中断）を止める／戻す。答えが CLI に届かないまま手を離す形を作る */
export function muteClaudeHeld(sessionId, muted) {
  const entry = heldTurns.get(sessionId);
  if (!entry) throw new Error(`claude: no held turn (${sessionId})`);
  entry.held.mute(muted);
  return true;
}

export const backend = {
  // 登録したアカウントがあれば、アカウントごとに見出しを付けて返す（server が accounts を解いて渡す）
  usage: ({ accounts, loginLabel } = {}) => readClaudeAccountsUsage({ accounts, loginLabel }),
  id: "claude",
  label: "Claude Code",
  get description() { return t("claude.description"); },

  capabilities: {
    compact: true,
    // 委譲の子だけ自動圧縮の閾値を下げる窓（runArgs.autoCompactWindow → CLAUDE_CODE_AUTO_COMPACT_WINDOW）を受ける
    autoCompactWindow: true,
    title: true,       // renameSession / customTitle。公式 CLI・VS Code と共有される
    tag: true,         // tagSession / tag。同上
    fork: true,
    forkMessage: true,
    // 同じ会話で巻き戻せる（resume + resumeSessionAt + resumeDropsTurn。conversations.mjs の rewind）
    rewind: 'resumeAt',
    subagents: true,
    liveModel: true,
    liveMode: true,
    hostTools: true,
    plyAgents: true,   // ply_agents を mcpServers に、その instructions を append に渡す
    // ply_computer（runArgs.computerRuntime）を mcpServers に、指示を append に渡す。MCP の image はそのままモデルに見える（docs/computer-use.md）
    computerUse: { images: 'inline', waitSliceMs: null },
    alwaysAllow: true,
    login: true,
    // 会話ごとのアカウント（claude setup-token のトークン）を選べる。server は oauthToken を渡す（core/claude-accounts.mjs）
    claudeAccounts: true,
    // 互換の接続先（Anthropic 互換）を会話ごとに選べる。server は endpoint を渡す（core/compat-endpoints.mjs）
    compatEndpoints: true,
    // 入力欄の `!`: Pleiad がホストで走らせ、結果を次のターンの始めに shouldQuery: false の行で渡す（runTurn の shellAppends。ADR 0054）
    shell: 'host',
  },

  // 親側の Task の説明を拾ってサブエージェントの見出しにする（server.mjs）。
  // ツール名はバックエンドごとに違うので、ここで宣言する。
  subagentTools: ["Task", "Agent"],

  auth: claudeAuth,
  toolHints: TOOL_HINTS,

  modes: () => MODES,
  models: (cwd) => claudeModels(cwd),
  warmModels: (cwd) => warmCatalog(cwd),
  // 一覧が引けないうち（未ログイン・一覧の取得中）は、保存済みの id を無効にしない（CLI が確かめる）
  async validModel(model, cwd) {
    if (typeof model !== "string" || model.length > 200 || /[\r\n\x00]/.test(model)) return false;
    if (!model) return true;
    return Object.hasOwn(await claudeModels(cwd), model) || (!freshAnyCatalog(cliSignature()) && /^[\w.\-\[\]]+$/.test(model));
  },

  // ---- 実行 ---------------------------------------------------------------

  /**
   * 1ターン回す。正規化イベントだけを emit する（生の SDK メッセージは外に出さない）。
   * 新規セッションは走り出すまで id が無いので、確定した時点で `session` イベントを出す。
   */
  // adopt は付け直し（{ source, card }。adoptTurn だけが渡す）。無ければ普通のターン（保持役に載せるかは claude-held.mjs の heldPlan が決める）
  async runTurn({ prompt, sessionId, cwd, mode, model, effort, emit, onPromptDelivered, askPermission, signal, control, hostSessionId, hostBackend, hostInvoke, visualizeInstructions, browserEnv, browserInstructions, browserRuntime = null, delegatedChild = false, contextRuntime, agentRuntime, computerRuntime = null, controlRuntime = null, hooksRuntime = null, oauthToken, endpoint = null, autoCompactWindow = null, locale, compact, shellAppends = [], notes = [], botInstructions = null, botFolders = null, rewind = null }, adopt = null) {
    // locale は会話の言語（host ツールの説明と承認の deny の理由。core/server.mjs が会話ごとに決めて渡す）
    const ctx = { sessionId: sessionId ?? null, emit, hostSessionId, hostBackend, hostInvoke, locale, track: control?.track ?? null };
    // このターンで呼んだ ply_computer の tool_use の id。tool_result に名前は載らないので、印の行を読むのはこの id の結果だけにする
    const computerIds = new Set();
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
    let promptSent = Boolean(adopt);
    async function* promptStream() {
      // 付け直し（2c）は発言を送らない（旧サーバーが渡し済み）。空の入力の流れで、途中送信だけを流す
      if (adopt) { yield* input; return; }
      if (contextRuntime) await readyContext;
      if (input.closed || signal?.signal?.aborted) return;       // 走り出す前に中断された
      promptSent = true;
      onPromptDelivered?.();
      // 入力欄の `!` の結果（CLI の `!` と同じ <bash-input> / <bash-stdout><bash-stderr> の 2 行）。
      // shouldQuery: false は返答を起こさずに transcript へ積み、次に query する user 行（このプロンプト）と合わせて渡す（sdk.d.ts の SDKUserMessage）
      for (const text of shellAppends) yield { ...userMessage(text), shouldQuery: false };
      // 中断の後に Pleiad が添える文（core/interrupt-stops.mjs）。人の発言とは別の text ブロックにし、本文は書き換えない
      if (notes.length) {
        const message = userMessage(prompt);
        message.message.content = [...notes, String(prompt ?? '')].map(text => ({ type: 'text', text }));
        yield message;
      } else yield userMessage(prompt);
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
      graceMs: sdk.resumeGraceMs,
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
    // ply_computer はロックを最長 10 分待つ。HTTP の MCP は既定で 60 秒（と無通信 300 秒）で切れるので、timeout で両方を上げる（実測 2026-10-01）
    const plyServers = { host: buildToolServer(ctx), ...(agentRuntime ? { ply_agents: { type: "http", url: agentRuntime.url, headers: agentRuntime.headers } } : {}), ...(contextRuntime ? { ply_context: { type: 'http', url: contextRuntime.url, headers: contextRuntime.headers } } : {}),
      ...(computerRuntime ? { [COMPUTER_SERVER]: { type: 'http', url: computerRuntime.url, headers: computerRuntime.headers, timeout: COMPUTER_CALL_TIMEOUT_SEC * 1000 } } : {}),
      // エージェントのブラウザー操作（core/browser-bridge.mjs。ADR 0148）
      ...(browserRuntime ? { [BROWSER_SERVER]: { type: 'http', url: browserRuntime.url, headers: browserRuntime.headers } } : {}),
      // Pleiad の操作の一覧（core/ops/surfaces/control.mjs。ADR 0081）。全会話に渡す
      // 承認が要る呼び出しも待たずに返る（ADR 0088）ので、待ちの上限はほかの Pleiad の MCP と同じ既定
      ...(controlRuntime ? { [CONTROL_SERVER]: { type: 'http', url: controlRuntime.url, headers: controlRuntime.headers } } : {}) };
    const computerInstructions = computerPrompt(computerRuntime, { locale, agent: 'claude' });
    // 互換の接続先（core/compat-endpoints.mjs）。env を組み替え（親の ANTHROPIC_* と OAuth トークンを外して接続先の値を入れる）、
    // 同じ値をフラグ設定のファイルにも書く（ユーザーの settings.json の env が options.env に勝つため。オブジェクトで渡すと argv にキーが載る）。
    // Pleiad の担当の設定（claudeContextOptions の settings）も同じファイルに入れる
    // Hooks を Pleiad がそろえる会話（hooksRuntime。ADR 0049）は、ネイティブの hooks をフラグ設定の disableAllHooks で止め、登録をコールバックで渡す
    const contextOptions = claudeContextOptions(contextRuntime, { compact: Boolean(compact), hooks: Boolean(hooksRuntime), bot: Boolean(botInstructions) });
    const compactDiagnostic = compact ? createClaudeCompactDiagnostic() : null;
    // 付け直しは、旧サーバーが書いたファイルを札から引き継ぐ（CLI は起動のときだけ読む。ターンの終わりにこちらが消す）
    const flag = adopt ? adoptClaudeFlagSettings(store.dataDir, adopt.card.flag) : endpoint ? await writeClaudeFlagSettings(store.dataDir, endpoint, contextOptions.settings) : null;
    const hide = text => redactSecret(redactToken(text, oauthToken), endpoint?.key);
    // resume する前に読む（CLI はこの値を読み戻し、result はそこからの累計になる）。1 つの query の result は全部これから引く。
    // 付け直しは札の値（旧サーバーがターンの始まりに読んだもの。CLI が query の終わりに書く値を読み直すとずれる）
    const costBase = adopt ? (adopt.card.costBase ?? null) : await readCostBase(sessionId);

    // 保持役に載せるか（claude-held.mjs）。付け直しは、印から ack までを読み直した（下の再生）うえで、保持役の子の続きを SDK へ流す。
    // 子が終わっていれば（旧サーバーが読み終えないうちに CLI が終わった）query を作らず、記録だけで締める
    const mark = adopt ? adopt.source.state.marks?.[ADOPT_TURN_MARK] : null;
    const acked = adopt ? Math.max(mark - 1, adopt.source.state.acked ?? 0) : 0;
    const finished = Boolean(adopt) && adopt.source.state.alive === false;
    let executable = null;
    try { executable = sdk.executable(); } catch { /* 入っていない。下の query が伝える */ }
    const held = adopt ? (finished ? null : createHeldCli({ mode: 'adopt', source: adopt.source, from: acked + 1 }))
      : await heldPlan({ dataDir: store.dataDir, executable, compact: Boolean(compact), bot: Boolean(botInstructions) })
        .then(plan => plan && createHeldCli({ mode: 'spawn', client: plan.client, onSpawn: () => bindHolder() }));
    // 手を離した後（detach）に旧サーバーの query を閉じると、SDK は答えを待っている承認の signal を止める。止めると server が承認を
    // 取り下げて通知の一覧の行まで決着させるので、手を離した後の止めは承認へ伝えない（新しいサーバーが同じ承認を出し直す）
    if (held) ctx.askSignal = s => {
      if (!s) return s;
      const ac = new AbortController();
      const pass = () => { if (!held.detached) ac.abort(s.reason); };
      if (s.aborted) pass(); else s.addEventListener('abort', pass, { once: true });
      return ac.signal;
    };

    let q = null;
    // 裏のコマンドの停止ボタンはターンの外（WS の stopBackground）から来る。**Pleiad の会話 id**で引けるようにする
    // （バックエンドを乗り換えた会話では、Claude の id と会話 id が別物になる）。保持役に載せたターンは、旧サーバーの手を離す口（handOffClaude）がネイティブ id で引く
    const holdQuery = (id) => {
      const key = hostSessionId ?? id; if (key && q) liveQueries.set(key, q);
      if (id) turnTrackers.set(id, tracker);   // getSubagentState はネイティブ id で来る（conversations.mjs が訳す）
      if (id && held) heldTurns.set(id, { held, get q() { return q; } });
    };

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
    // 付け直しは札の控え（本文の代わりにハッシュ。uuid で突き合わせ、uuid の無い echo はハッシュで当てる）から作り直す
    const pendingSteers = adopt ? restoredSteers(adopt.card.steers) : [];   // { id, uuid, text, hash, sawResult } 流し込んだが、まだ折り込まれていないもの
    /**
     * 札のバックエンドの欄（保持役に載せたターンだけ。core/server.mjs の takeCard が control.backendCard から読み、付け直す側の adoptTurn の card になる）。
     * 途中送信は本文を入れずハッシュにする（札の上限。core/turn-card.mjs と同じ）。裏の作業と main の状態（claude-background.mjs の tracker）は、
     * 印からの再生で作り直る（付け直し直後の background_tasks_changed が全量で置き換える）ので、再生に出ない流し込みの数（pushed）だけを置く
     */
    const backendCard = () => ({ held: true, costBase, flag: flag ? path.basename(flag.file) : null,
      steers: pendingSteers.map(p => ({ id: p.id, uuid: p.uuid, hash: p.hash, sawResult: p.sawResult })), pushed: tracker.pending });
    // 札を保持役の子に置く口（server の touchCard が、札の中身が変わるたびに呼ぶ）。最初の 1 回は子を起こした直後・付け直した直後に置く
    const bindHolder = () => {
      if (!control || !held?.source) return;
      control.holder = {
        label: card => held.source.client.label(held.id, card),
        // 旧サーバーの手を離す口（引き継ぎ。core/handover.mjs）: 札を子に置いて detach し、読みを止めてから query を閉じる（design.md §4.4 の順序）
        handOff: async card => { await held.handOff(card); try { q?.close(); } catch { /* 既に閉じている */ } },
      };
      control.backendCard = backendCard;
      control.touch?.();
    };
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
        pendingSteers.push({ id: item?.id ?? null, uuid, text, hash: promptHash(text), sawResult: false });
        tracker.pushed();
        settleInput();   // 流し込んだ分がまだ手付かずなので、閉じる予約が出ていたら取り消す
        return true;
      };
      control.onReady?.();
    };

    const takeAt = (i) => pendingSteers.splice(i, 1)[0].id;
    // 札から作り直した控えは本文を持たない（ハッシュで当てる）
    const sameText = (p, text) => p.text != null ? p.text === text : Boolean(p.hash) && p.hash === promptHash(text);
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
        if (text && hit.text && text !== hit.text && text.endsWith("\n" + hit.text)) {
          ids.unshift(...takeMerged(text.slice(0, text.length - hit.text.length - 1)));
        }
        return ids;
      }
      if (text === null) return [];
      const same = pendingSteers.findIndex((p) => sameText(p, text));
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
    // （保持役に載せたターンは、SDK の kill を保持役が木ごと止める形で写す。claude-held.mjs）
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
    let limit = null;
    // CLI から最初のメッセージが届いたか。巻き戻しを伴うターンが、これより前に失敗したら（catch の rewindRejected）
    let sawMessage = false;
    // 新しい会話の最初のリクエストの文脈の大きさ（固定の部分）を出したか。委譲の子の自動圧縮の閾値に使う（server の makeEmit。ADR 0166）
    let toldBase = Boolean(sessionId || adopt);
    // replay は付け直しの再生（印から ack まで。画面へは出さず、実行中のスナップショットとメモリの状態だけを作る。server の makeEmit）
    const send = (ev, replay) => replay ? emit(ev, { replay: true }) : emit(ev);
    /** SDK のメッセージ 1 件を取り込む。ライブのループと、付け直しの記録の読み直しが同じ道を通る */
    const handle = async (message, replay = false) => {
      sawMessage = true;
      compactDiagnostic?.observe(message);
      // 最初の返答の usage の入力の合計（キャッシュの作成・読み出しを含む）。サブエージェントの返答（parent_tool_use_id）は除く
      if (!toldBase && !replay && message.type === 'assistant' && !message.parent_tool_use_id) {
        const usage = message.message?.usage;
        const tokens = ['input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens'].reduce((sum, key) => sum + (Number.isFinite(usage?.[key]) ? usage[key] : 0), 0);
        if (tokens > 0) { toldBase = true; emit({ type: 'contextBase', tokens }); }
      }
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
        send({ type: "session", sessionId: message.session_id, first: true, ...(model ? { model } : {}) }, replay);
        if (held) control?.touch?.();   // 会話の id が決まった（札を置けるようになった）
      } else if (model && !toldModel) {
        toldModel = true;
        send({ type: "session", sessionId: ctx.sessionId ?? message.session_id ?? null, model }, replay);
      }

      // 流し込んだ途中送信が会話に折り込まれた。どれが渡ったかを、返答より先に知らせる
      for (const id of [...takeDelivered(message), ...takeLeftovers(message)]) {
        if (id) send({ type: "userMessage.delivered", messageId: id }, replay);
      }
      // 中断を頼んだ後の result は、interrupt が効いた合図（応答より先に来ることがある）
      if (!replay && stop && message.type === "result") stopAcked();

      for (const ev of normalizeSdkMessage(message, { costBase, computerIds })) {
        // result は 1 回の query で何度も出る（裏の subagent が終わるたびに main が再開する・途中送信に答える）。
        // turnResult は「このターンが終わった」の合図で、server はそれを見て途中送信を止める。
        // 成功の分は最後の 1 つだけを query の終わりに出す。使用量（usage）は開始時点からの累計なので、その都度出してよい（server は上書きする）。
        // 中断を頼んだ後の result（打ち切られた内部ターン）は出さない。結果は最後に aborted で出す
        if (ev.type === 'limit') { limit = ev; continue; }
        if (ev.type === "turnResult" && stop) continue;
        if (ev.type === 'turnResult' && limit) { heldResult = { ...ev, outcome: 'limited', resetsAt: limit.resetsAt, window: limit.window }; continue; }
        if (ev.type === "turnResult" && ev.outcome === "ok") { heldResult = ev; continue; }
        send(ev, replay);
      }
      if (!replay && q && (message.type === 'result' || message.subtype === 'compact_boundary')) {
        const usage = typeof q.getContextUsage === 'function' ? await q.getContextUsage().catch(() => null) : null;
        if (Number.isFinite(usage?.totalTokens) && Number.isFinite(usage?.rawMaxTokens))
          emit({ type: 'contextWindow', usedTokens: usage.totalTokens, windowTokens: usage.rawMaxTokens });
      }
      // 裏の作業と main の状態（background / phase）。変わったときだけ出る
      for (const ev of tracker.observe(message)) send(ev, replay);
      if (!replay) settleInput();
    };

    // 付け直し: 印から ack まで（旧サーバーが処理し終えた分）を読み直し、実行中のスナップショット・途中送信の控え・裏の作業・使用量を作る。
    // 読み直しの失敗は投げる（server の adoptTurn が restart の中断にする）
    if (adopt) {
      if (acked >= mark) for (const [, line] of await adopt.source.replay(mark, acked)) {
        const m = parseLine(line);
        if (m && !SDK_CONSUMED.has(m.type)) await handle(m, true);
      }
      for (let i = 0; i < (Number.isInteger(adopt.card.pushed) ? adopt.card.pushed : 0); i++) tracker.pushed();
    }

    // 外す道具: bot の読み取り専用フォルダーの deny ルール + 委譲の子が使わない組み込みの道具（DELEGATED_CHILD_DISALLOWED_TOOLS）
    const disallowedTools = [...(botFolders?.readOnlyRoots?.length ? readOnlyDenyRules(botFolders.readOnlyRoots) : []), ...(delegatedChild ? DELEGATED_CHILD_DISALLOWED_TOOLS : [])];
    const claudeExtraEnv = { CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: "0", ...(autoCompactWindow ? { [AUTO_COMPACT_WINDOW_ENV]: String(autoCompactWindow) } : {}) };
    // query の組み立てで例外になっても、鍵を含むフラグ設定のファイルを残さない（ターンの終わりの finally まで届かないため）
    if (!finished) try { q = sdk.query({
      prompt: promptStream(),
      options: {
        pathToClaudeCodeExecutable: sdk.executable(),
        // 保持役に載せたターンは、CLI の起動と stdin・stdout を保持役へ回す（claude-held.mjs。付け直しは走っている CLI の続き）
        ...(held ? { spawnClaudeCodeProcess: held.spawnClaudeCodeProcess } : {}),
        // env は置き換え（足し算ではない）なので process.env を必ず広げる。
        // 待ちの上限は 0 = 無し。入力を開けている限り CLI は上限を見ないが、閉じた後の保険として外す。
        // 会話で選んだアカウントのトークンは、この会話の env にだけ入れる（process.env は触らない。core/claude-accounts.mjs）
        // 委譲の子だけ、自動圧縮の閾値を下げる窓（autoCompactWindow。固定の部分 + 設定 compaction.auto の delegatedHeadroom。ADR 0166）を足す
        env: { ...(endpoint ? claudeCompatEnv(process.env, endpoint, claudeExtraEnv)
          : claudeEnv(process.env, { token: oauthToken, extra: claudeExtraEnv })), ...browserEnv, ...controlRuntime?.env },
        // CLI の stderr は今まで捨てていた（上限で subagent を殺したことも分からなかった）。トークン・接続先のキーが紛れても伏せる
        stderr: createStderrLog({ secrets: [oauthToken, endpoint?.key].filter(Boolean) }),
        resume: sessionId ?? undefined,
        // 同じ会話の中で巻き戻して送り直す（core/conversations.mjs の rewind。ADR 0102）。at は残す最後の発言、drops は捨てる発言（ユーザーの発言）の uuid。
        // 同じ session id・同じ JSONL のまま、at から枝を伸ばす。捨てる範囲が drops のターンだけでなければ CLI が拒否する（下の catch）
        ...(rewind && sessionId ? { resumeSessionAt: rewind.at, resumeDropsTurn: rewind.drops } : {}),
        cwd,
        abortController: sdkAbort,
        // 流し込んだ user メッセージが**折り込まれた瞬間**に echo（isReplay）を返させる。
        // 既定ではストリームに合図が無く、途中送信が会話に入ったことを外から確かめられない。
        // 返ってくるのは最初のプロンプトと自分が push した分だけで、CLI 内部の通知は replay されない
        // （実測 2026-09、CLI 2.1.273）。content が文字列の user から normalize は何も作らないので表示は変わらない
        mcpServers: plyServers,
        // ~/.claude と .claude を読ませる。R1（skill / command / hooks / memory）はここで効く。
        settingSources: ["user", "project", "local"],
        skills: "all",
        ...contextOptions,
        extraArgs: claudeQueryExtraArgs(contextOptions),
        ...(flag ? { settings: flag.file } : {}),
        // bot の人格（core/bots/sessions.mjs の botInstructions）は並びの最後。同じ bot なら毎ターン同じバイト列（キャッシュを壊さない）。
        // snapshot: false は bot の会話だけ。CLI は最初のターンのシステムプロンプトを記録して、後のターンで別の append を渡しても使い回す（既定）。
        // それだと人格を直しても動いている会話に届かない（2026-10-03 の実機の確認）。毎ターン組み直せば、同じ人格のあいだは同じバイト列でキャッシュは保たれ、直したターンだけ落ちる
        ...((visualizeInstructions || browserInstructions || contextRuntime?.prompt || agentRuntime?.instructions || computerInstructions || controlRuntime?.instructions || botInstructions) ? { systemPrompt: { type: 'preset', preset: 'claude_code', append: [contextRuntime?.prompt, visualizeInstructions, browserInstructions, agentRuntime?.instructions, computerInstructions, controlRuntime?.instructions, botInstructions].filter(Boolean).join('\n\n'), ...(botInstructions ? { snapshot: false } : {}) } } : {}),
        // bot の触れてよいフォルダー（cwd の外の分）。読み取り専用（ro）のフォルダーは、acceptEdits が聞かずに通す編集を deny ルールで断る（シェルの書き込みは断れない。docs/channels.md）
        ...(botFolders?.additionalDirectories?.length ? { additionalDirectories: botFolders.additionalDirectories } : {}),
        ...(disallowedTools.length ? { disallowedTools } : {}),
        // adaptive = モデルが必要な分だけ考える。
        // 注意: このモデルの thinking ブロックは署名だけで平文が入らない（2026-08 時点、
        // display の有無を問わず `thinking` は空文字）。したがって思考の中身は表示できない。
        // 使えるのは「考えている」ことと thinking.delta の estimatedTokens だけ。
        // 互換の接続先は「思考を送る」をオンにした先にだけ送る（決定 4。オフの先は env で thinking・effort を止めてある）
        ...(!endpoint || endpoint.options?.sendThinking ? { thinking: { type: "adaptive" } } : {}),
        // 承認モード。既定は都度確認。切り替えは人間だけができる（server 側で担保）。
        // SDK 側が先に判断し、なお迷うものだけが canUseTool に来る（bypass では、ふつうの呼び出しは来ない。
        // 危ない rm のような安全の検査に当たったものは来る）。
        permissionMode: sdkMode(mode),
        ...(sdkMode(mode) === "bypassPermissions" ? { allowDangerouslySkipPermissions: true } : {}),
        // 未指定なら SDK の既定に任せる（設定を上書きしない）
        ...(model || endpoint?.roles?.main ? { model: model || endpoint.roles.main } : {}),
        ...(effort && (!endpoint || endpoint.options?.sendThinking) ? { effort } : {}),
        includePartialMessages: true,
        // hooks の発火（hook_started / hook_response）を受け取る。会話の右パネルの「発火の記録」に使う（claude-normalize.mjs）
        includeHookEvents: true,
        // 引き継ぎ（2d）は、走っている hooks のコールバックが終わるのを上限つきで待つ（control.track。trackedHooks）
        hooks: trackedHooks(mergeCallbacks({
          PreCompact: [{ hooks: [async input => {
            emit({ type: 'compaction', phase: 'start', trigger: input.trigger === 'manual' ? 'manual' : 'auto' });
            return {};
          }] }],
          PostCompact: [{ hooks: [async input => {
            if (input.compact_summary) emit({ type: 'compaction', phase: 'summary', trigger: input.trigger === 'manual' ? 'manual' : 'auto', summary: input.compact_summary });
            return {};
          }] }],
        // Pleiad の Hooks の登録。コールバックは Pleiad の中で走るので、発火の記録は自分で出す（hook_started は届かない）
        }, claudeHookCallbacks(hooksRuntime, { onRun: run => emit({ type: 'hookRun', ...run }) })), control?.track),
        canUseTool: makeCanUseTool(ctx, askPermission),
      },
    }); } catch (e) { if (!adopt) await flag?.dispose(); void held?.finish(); throw undelivered(e); }

    // 実行中に承認モードやモデルを変えられるようにする。
    // ターン開始時の options だけだと、走り出した後の切り替えが効かない。
    if (control) control.handle = q;
    holdQuery(ctx.sessionId);
    if (adopt) bindHolder();
    if (signal?.signal?.aborted) stopTurn();
    else signal?.signal?.addEventListener?.("abort", stopTurn, { once: true });

    let sawExit = false;
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
      if (finished) {
        // 子が終わっていた: 記録の続きを処理して締める（控えの渡し直しは答える相手がいないので読まない）
        for await (const item of adopt.source.attach(acked + 1)) {
          if (item.exit) { sawExit = item.exit; break; }
          if (item.redelivered) continue;
          const m = parseLine(item.line);
          if (m && !SDK_CONSUMED.has(m.type)) await handle(m, false);
          adopt.source.ack(item.seq);
        }
        // result の無いまま終わった（CLI が落ちた）。ライブなら SDK が終了コードで投げる
        if (!heldResult && !limit && !stop) throw new Error(`Claude Code process exited with code ${sawExit?.code ?? 'unknown'}`);
      } else {
        openSteer();
        // 付け直した直後に、もう閉じてよい（旧サーバーが閉じる前の猶予の間に手を離した）なら閉じる予約を置く
        if (adopt) settleInput();
        for await (const message of q) {
          await handle(message, false);
          held?.ack(message.uuid);
        }
      }
      // 旧サーバーが手を離した（handOffClaude）。このターンはここで終わる（出来事は server が捨てる。締めるのは付け直したサーバー）
      if (held?.handedOff) { emit({ type: "turnResult", outcome: "aborted" }); return { sessionId: ctx.sessionId, handedOff: true }; }
      if (stop) emit({ type: "turnResult", outcome: "aborted" });
      else if (limit) emit({ type: 'turnResult', outcome: 'limited', resetsAt: limit.resetsAt, window: limit.window });
      else if (heldResult) emit(heldResult);
    } catch (err) {
      if (held?.handedOff) { emit({ type: "turnResult", outcome: "aborted" }); return { sessionId: ctx.sessionId, handedOff: true }; }
      // 巻き戻しを伴うターンが、CLI から何も届かないうちに失敗した（resume の拒否。`Resume rejected by --resume-drops-turn:` の文面は SDK の例外に載るとは限らないので、
      // 文面には頼らない）か、拒否の文そのものが来たときは、失敗として見せず呼び出し側（conversations.mjs）がホスト管理に落として 1 度だけ送り直す。繰り返し再試行しない
      if (rewind && sessionId && !stop && !signal?.signal?.aborted && (!sawMessage || /Resume rejected by --resume-drops-turn/.test(String(err?.message ?? '')))) {
        throw Object.assign(new Error(String(err?.message ?? err)), { rewindRejected: true, undelivered: true });
      }
      // 中断は「失敗」ではない。呼び出し側（server）は finally で片付けるだけなので、
      // 何が起きたかは turnResult で web に伝える。
      if (stop || signal?.signal?.aborted) {
        emit({ type: "turnResult", outcome: "aborted" });
        return { sessionId: ctx.sessionId };
      }
      if (limit) {
        emit({ type: 'turnResult', outcome: 'limited', resetsAt: limit.resetsAt, window: limit.window });
        return { sessionId: ctx.sessionId };
      }
      const message = hide(err?.message ?? err);
      emit({ type: "turnResult", outcome: "error", error: message });
      const thrown = (oauthToken || endpoint) && err?.message && message !== err.message ? new Error(message) : err;
      throw promptSent ? thrown : undelivered(thrown);
    } finally {
      clearStopTimer();
      // 手を離したターンのフラグ設定のファイルは消さない（札が指す。付け直したサーバーがターンの終わりに消す）
      if (!held?.handedOff) await flag?.dispose();
      signal?.signal?.removeEventListener?.("abort", stopTurn);
      for (const [id, x] of liveQueries) if (x === q) liveQueries.delete(id);
      for (const [id, x] of heldTurns) if (x.held === held) heldTurns.delete(id);
      closeInput();
      if (contextRuntime) { q.close(); releaseContext(); }
      if (control) { control.handle = null; control.steer = null; control.steerConfirms = false; control.holder = null; control.backendCard = null; }
      // 保持役の子の片付け（終わった子の記録を捨てる。手を離した子には触れない）
      if (held) void held.finish();
      else if (finished) { if (sawExit) adopt.source.release(); adopt.source.dispose(); }
    }

    const compactionFailureReason = compactDiagnostic?.reason();
    return { sessionId: ctx.sessionId, ...(compactionFailureReason ? { compactionFailureReason } : {}) };
  },

  /**
   * 付け直し（無停止の更新 段階 2 の 2c。claude-held.mjs）: 保持役が持つ走っている CLI に query を作り直し、続きを受ける。
   * card は runTurn が札に置いた分（control.backendCard の { held, costBase, flag, steers, pushed }）、source は保持役の子（core/adopt.mjs の holderSource）。
   * 印から ack までは記録を読み直して状態を作り（emit の replay）、続きを SDK へ流す。発言は送らない（空の入力の流れで 2 回目の initialize を送り、
   * CLI が承認待ちを pending_permission_requests で canUseTool へ回し直す）。systemPrompt・skills は 2 回目の initialize では効かないので札に要らない（stage2-claude.md）。
   * sessionId はネイティブの id（会話の層 core/conversations.mjs が訳す）
   */
  async adoptTurn(args) {
    if (!args.card?.held || typeof args.source?.write !== 'function') throw new Error('claude: the turn was not on the holder');
    return backend.runTurn(args, { source: args.source, card: args.card });
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
    // 走っているターンに折り込まれた途中送信と、Stop フックの続きの印は getSessionMessages に出ない。transcript から拾う
    // 圧縮の要約・コマンドの行・中断などのシステム側の行は、transcript の印（無ければ文面）で見分けて置き換える（core/system-messages.mjs）
    const { rows, followUps, marks } = await readTranscriptExtras(sessionId);
    return classifySystemMessages(transcriptToMessages(mergeQueuedCommands(entries, rows), { ...options, followUps }), marks);
  },

  // 区切りは transcript の compact_boundary の行から読む（getSessionMessages の system 行は message: null で中身が無い。SDK 0.3.258）。
  // transcript を読めないときだけ SDK の行から読む
  async getCompactions(sessionId) {
    const text = await readTranscriptText(sessionId);
    if (text) return transcriptSystemMarks(text).compactions;
    const rows = await getSessionMessages(sessionId, { includeSystemMessages: true }).catch(() => []);
    return claudeCompactionsFromHistory(rows);
  },

  setTitle: (sessionId, title) => renameSession(sessionId, title),
  // 隠れた会話（夜の整理・心拍）を片付けるときだけ使う（core/conversations.mjs の deleteHiddenConversation。ADR 0127）
  deleteSession: (sessionId) => sdkDeleteSession(sessionId),
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
          // 1 回きりの問い合わせ。会話として残すと「次は作業ログの冒頭です…」で始まる会話が Claude の一覧に出る
          persistSession: false,
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
