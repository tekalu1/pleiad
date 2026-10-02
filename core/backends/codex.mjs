// OpenAI Codex（公式 `codex` CLI の app-server）のバックエンド。
//
// プロトコルの正は `codex app-server generate-json-schema --out <dir>` が出す JSON Schema
// （`temporary/codex-schema/`、追跡外）。ここで使っている method 名とフィールド名は
// すべてそこから取った。**推測で足していない**。
//
// Claude との違いで効いてくるのは3つ:
//   1. **セッション id が開始前に確定する**（thread/start が thread.id を返す）。
//      だから `session` イベントを turn/start より前に出せる。
//   2. **承認が server -> client の JSON-RPC request** で来る。応答の形は承認の種類ごとに違う
//      （decision の enum が commandExecution と fileChange で違い、permissions には decision が無い）。
//   3. **ツールが「アイテム」として表現される**。item/started で始まり item/completed で終わる。
//      fileChange の承認要求には中身が入っていない（itemId だけ）ので、
//      item/started で見た item を覚えておいて承認カードに載せる。
import os from "node:os";
import { codexQuota, createCodexMeter } from '../usage.mjs';
import { rpc } from "./codex-rpc.mjs";
import { rpc as nativeRpc } from './codex-rpc.mjs';
import { commandActivity } from "./codex-background.mjs";
import { createTerminalTracker } from "./codex-background.mjs";
import { codexContextRpc } from './context-options.mjs';
import { promptTitle } from '../prompt-title.mjs';
import { CodexRpc } from './codex-rpc.mjs';
import { codexHooksState, codexListProblem } from '../hooks-plan.mjs';
import { maskText } from '../hooks-config.mjs';
import crypto from 'node:crypto';
import { undelivered } from './undelivered.mjs';
import { codexCompatThread, redactSecret } from '../compat-endpoints.mjs';
import { MAX_RESULT_CHARS } from "./shared.mjs";
import { codexComputerConfig, codexComputerName, computerFailed, computerPrompt, computerResult, computerToolInput, mcpText } from "./computer-delivery.mjs";
import { readTurnRejections, rolloutPathOf, rolloutSize } from "./codex-rejections.mjs";
import { BROWSER_SERVER } from "../browser-profiles.mjs";
import * as store from '../store.mjs';
import { t, agentT } from "../i18n.mjs";
import { stripInjectedContext } from "../system-messages.mjs";

const NL = String.fromCharCode(10);

/**
 * 承認モード。approvalPolicy × sandbox の組に id を付けたもの（docs/multi-backend.md §2.5）。
 *
 * spec の表は auto を `on-failure` に写していたが、**現行スキーマの AskForApproval に
 * on-failure は無い**（untrusted / on-request / never / granular の4つだけ）。
 * 「聞く回数」が spec の意図した順に並ぶよう untrusted -> on-request -> never に割り当てた。
 */
// label / note はゲッター（サーバーの言語は実行中に変わる。core/i18n.mjs）
const MODES = {
  ask:      { get label() { return t("modes.ask"); },      get short() { return t("modesShort.ask"); },      get note() { return t("codex.modes.ask"); },      approvalPolicy: "untrusted",  sandbox: "workspace-write", scope: "workspace", autonomy: "ask",   enforced: true },
  auto:     { label: "auto",                               get note() { return t("codex.modes.auto"); },     approvalPolicy: "on-request", sandbox: "workspace-write", scope: "workspace", autonomy: "judge", enforced: true },
  full:     { get label() { return t("modes.full"); },     get short() { return t("modesShort.full"); },     get note() { return t("codex.modes.full"); },     approvalPolicy: "never",     sandbox: "workspace-write", scope: "workspace", autonomy: "never", enforced: true },
  yolo:     { label: "YOLO",                               get note() { return t("codex.modes.yolo"); },     approvalPolicy: "never", sandbox: "danger-full-access", scope: "full", autonomy: "never", enforced: false },
  readonly: { get label() { return t("modes.readonly"); }, get short() { return t("modesShort.readonly"); }, get note() { return t("codex.modes.readonly"); }, approvalPolicy: "on-request", sandbox: "read-only", scope: "readonly", autonomy: "judge", enforced: true },
};

// 外へ見せるのは語彙と軸だけ。approvalPolicy / sandbox は codex の内部事情なので出さない。
const vocab = ({ label, short, note, scope, autonomy, enforced }) => ({ label, ...(short ? { short } : {}), note, scope, autonomy, enforced });

// thread/resume が以前の設定を返しても、選んだアクセス範囲を turn/start に適用する。
// 同じ種類なら設定済みの追加ルートなどを保持し、YOLO から戻る場合は制限を復元する。
function sandboxForTurn(mode, current) {
  const type = {
    "workspace-write": "workspaceWrite",
    "read-only": "readOnly",
    "danger-full-access": "dangerFullAccess",
  }[mode.sandbox];
  if (type === "dangerFullAccess") return { type };
  if (current?.type === type) return current;
  return { type, networkAccess: false };
}

/** ツール（アイテム）の表示ヒント。web/render.mjs の TOOL_LABEL を補う。 */
// label はゲッター（共有キー tools.*。言語は実行中に変わる）
// i18n-dynamic: tools.
const hint = (key, shape) => ({ get label() { return t(`tools.${key}`); }, shape });
const TOOL_HINTS = {
  commandExecution: hint("run", "shell"),
  fileChange:       hint("edit", "edit"),
  mcpToolCall:      { label: "MCP",     shape: "generic" },
  webSearch:        hint("webSearch", "web"),
  imageView:        hint("image", "read"),
  imageGeneration:  hint("imageGeneration", "generic"),
  dynamicToolCall:  hint("tool", "generic"),
  sleep:            hint("sleep", "generic"),
  // サブエージェント。gpt-6-astra（multi_agent v2）は subAgentActivity だけを出し、
  // 別の版・モデルは collabAgentToolCall を出す。どちらも web の drawTask（委譲カード）で描く
  subAgentActivity:    hint("delegate", "delegate"),
  collabAgentToolCall: hint("delegate", "delegate"),
};

/** 委譲ツールとして server に申告するアイテム（subagentTools）。tool.start の name と厳密一致する */
const SUBAGENT_ITEMS = ["subAgentActivity", "collabAgentToolCall"];

// tool.start / tool.result に落とすアイテム。これ以外（agentMessage / reasoning / plan …）は
// 本文や思考として別に扱う。知らない type は黙って落とす（増えても壊れない）。
const TOOL_ITEMS = new Set(Object.keys(TOOL_HINTS));
/** 入力欄の `!` で人が走らせたコマンド（thread/shellCommand。Codex の TUI・Desktop の `!` も同じ source） */
const isUserShell = (item) => item?.type === "commandExecution" && item.source === "userShell";
/** 走っている `!` の item id（出力の差分は item を運ばないので、id で見分ける） */
const userShellItems = new Set();
/** `!` の出力を履歴の形に（改行を揃え、末尾の空白を落とす。Claude の `!` の行と同じ扱い。core/system-messages.mjs） */
const shellText = (s) => String(s ?? "").replace(/\r\n/g, "\n").replace(/\s+$/, "");
/** 止めた `!`（turn/interrupt）。Codex は status: failed・exitCode -1・"command aborted by user" で閉じる（codex-cli 0.156.1 で確認） */
const userShellAborted = (item) => item?.exitCode === -1 && item.status !== "completed" && /^command aborted by user\s*$/.test(String(item.aggregatedOutput ?? ""));

/**
 * userShell の item の command は、Codex がシェルに包んで POSIX 式にクォートしてつないだ形
 * （Windows は `"C:\\…\\powershell.exe" -Command 'echo hi'`。codex-cli 0.156.1 で確認）。人が打った形に戻す。
 * 戻せなければ、commandActions が 1 つならその command、それも無ければそのまま
 */
export function userShellCommand(item) {
  const raw = String(item?.command ?? "");
  const m = /^("[^"]*"|\S+)(?:\s+-(?:NoProfile|NoLogo))*\s+(?:-Command|-lc|-c)\s+(\S[\s\S]*)$/.exec(raw);
  const shell = m && /(?:^|[\\/])(?:bash|sh|zsh|powershell|pwsh)(?:\.exe)?$/i.test(m[1].replace(/^"|"$/g, ""));
  const inner = shell ? unquoteWord(m[2]) : null;
  if (inner != null) return inner;
  const actions = Array.isArray(item?.commandActions) ? item.commandActions : [];
  return actions.length === 1 && typeof actions[0]?.command === "string" ? actions[0].command : raw;
}

/** POSIX 式にクォートした 1 語（'…'・"…"（\ のエスケープ）・\x のつなぎ）を戻す。1 語でなければ null */
function unquoteWord(s) {
  let out = "";
  for (let i = 0; i < s.length;) {
    const c = s[i];
    if (c === "'") {
      const j = s.indexOf("'", i + 1);
      if (j < 0) return null;
      out += s.slice(i + 1, j); i = j + 1;
    } else if (c === '"') {
      let j = i + 1;
      for (; j < s.length && s[j] !== '"'; j++) {
        if (s[j] === "\\" && j + 1 < s.length && '"\\$`'.includes(s[j + 1])) j++;
        out += s[j];
      }
      if (j >= s.length) return null;
      i = j + 1;
    } else if (c === "\\" && i + 1 < s.length) { out += s[i + 1]; i += 2; }
    else if (/\s/.test(c)) return null;
    else { out += c; i++; }
  }
  return out;
}

/**
 * model/list の結果 `{ list, at }`。毎回 codex を叩かない（UI は表示のたびに引く）。
 * 覚えるのは少しの間だけ。codex の更新や OpenAI 側の入れ替えで候補が変わる
 */
let modelCache = null;
/** 引いている途中の model/list。同時に来た呼び出しで分け合う */
let modelFetch = null;
/** forgetModels で進める。途中で忘れた引きの結果（前のアカウントの一覧）は覚えない */
let modelGen = 0;
/** model/list の isDefault（codex 自身の既定）。config.toml に model が無いときに使われる */
let listDefault = null;
/** 覚えておく長さ。呼ぶたびに読む（テストが短くできるように） */
const modelTtlMs = () => Number(process.env.AGENT_HOST_CODEX_MODELS_TTL_MS ?? 300_000);
/** cursor を追う上限。モデルがこれを超えることは実際には無い */
const MAX_MODEL_PAGES = 20;

/** 覚えた一覧を捨てる。ログイン・ログアウトで使えるモデルが変わる */
export function forgetModels() {
  modelCache = null;
  modelFetch = null;
  listDefault = null;
  modelGen += 1;
}

/** model/list を `nextCursor` を追って全部読む。途中の 1 ページでも落ちたら全体を失敗にする（半端な一覧を覚えない） */
async function listModelRows() {
  const rows = [];
  let cursor = null;
  for (let page = 0; page < MAX_MODEL_PAGES; page += 1) {
    const res = await rpc.request("model/list", cursor == null ? {} : { cursor }, 30_000);
    rows.push(...(res?.data ?? []));
    cursor = res?.nextCursor ?? null;
    if (cursor == null) return rows;
  }
  throw new Error(t("codex.errors.tooManyPages", { pages: MAX_MODEL_PAGES }));
}

function toModels(rows) {
  const out = { "": { label: t("models.default"), note: t("codex.models.defaultNote") } };
  for (const m of rows) {
    if (!m?.id || m.hidden) continue;
    out[m.id] = {
      label: m.displayName || m.id,
      efforts: m.supportedReasoningEfforts?.map(e => e.reasoningEffort),
      defaultEffort: m.defaultReasoningEffort,
      note: m.description || (m.model ?? m.id),
    };
  }
  const preferred = rows.find(m => m?.isDefault && !m.hidden && m.id);
  if (preferred) Object.assign(out[''], { efforts: out[preferred.id].efforts, defaultEffort: out[preferred.id].defaultEffort });
  return { list: out, isDefault: preferred?.id ?? null };
}

async function loadModels() {
  const gen = modelGen;
  try {
    const { list, isDefault } = toModels(await listModelRows());
    // 引けたときだけ覚える。失敗を覚えると回復しない
    if (gen === modelGen) { modelCache = { list, at: Date.now() }; listDefault = isDefault; }
    return list;
  } catch (err) {
    console.error("  codex model/list に失敗:", String(err?.message ?? err));
    // 引き直しに失敗しても、前に引けた一覧があればそれを出す（空にすると選んであったモデルが既定へ戻る）
    return modelCache?.list ?? toModels([]).list;
  } finally {
    if (gen === modelGen) modelFetch = null;
  }
}

function modelList() {
  if (modelCache && Date.now() - modelCache.at < modelTtlMs()) return Promise.resolve(modelCache.list);
  return (modelFetch ??= loadModels());
}

/**
 * タイトル生成に使う軽いモデル（先にあるほど優先）。id か表示名に語として含むものを探す。
 * luna は docs/design.md の選定。無い版・アカウントでは同じ系統の軽いものへ、それも無ければ codex の既定
 */
const TITLE_MODELS = ["gpt-5.6-luna", "luna", "mini", "nano", "spark"];

/**
 * models（modelList / models() の形）からタイトル生成の `{ model?, effort? }` を選ぶ。
 * model が無ければ codex の既定に任せる。effort は選んだモデルが low を持つ（段が分からない）ときだけ low
 */
export function titleModel(models) {
  const ids = Object.keys(models ?? {}).filter((id) => id && !models[id]?.hidden);
  const word = (w) => new RegExp(`(^|[^a-z0-9])${w.replaceAll(".", "\\.")}([^a-z0-9]|$)`, "i");
  const find = (w) => ids.find((id) => id === w)
    ?? ids.find((id) => word(w).test(id) || word(w).test(models[id].label ?? ""));
  const model = TITLE_MODELS.map(find).find(Boolean) ?? null;
  const efforts = models?.[model ?? ""]?.efforts;
  const low = !efforts?.length || efforts.includes("low");
  return { ...(model ? { model } : {}), ...(low ? { effort: "low" } : {}) };
}

/** config/read（作業場所ごとの config.toml）。表示のたびに引かないよう少しだけ覚える。読めなければ null */
const configCache = new Map();
async function readConfig(cwd) {
  const key = cwd || "";
  const hit = configCache.get(key);
  if (hit && Date.now() - hit.at < 30_000) return hit.config;
  let config = null;
  try { config = (await rpc.request("config/read", { ...(cwd ? { cwd } : {}), includeLayers: false }, 10_000))?.config ?? null; }
  catch { /* 既定の解決ができないだけ */ }
  configCache.set(key, { config, at: Date.now() });
  return config;
}

const cut = (s) => {
  const text = String(s ?? "");
  return text.length > MAX_RESULT_CHARS
    ? { text: text.slice(0, MAX_RESULT_CHARS) + t("codex.truncated"), truncated: true }
    : { text, truncated: false };
};

/**
 * codex の時刻を ms に均す。
 *
 * **スキーマは int64 としか言わないが、Thread / Turn の時刻は「秒」で来る**（実機で確認。
 * そのまま ms として読むと一覧が全部 1970 年になる）。一方 `startedAtMs` のように
 * 名前に Ms が付くものはミリ秒。名前で判別できないものがあるので桁で見分ける
 * （1e12 未満 = 2001-09-09 より前の ms 値は、この用途では事実上ありえない）。
 */
const toMs = (v) => (Number.isFinite(v) ? (v < 1e12 ? v * 1000 : v) : null);
const toIso = (v) => {
  const ms = toMs(v);
  return ms == null ? null : new Date(ms).toISOString();
};

// ---------------------------------------------------------------- アイテム

/**
 * ThreadItem -> tool.start の名前。ply_computer の mcpToolCall は 3 つのエージェントでそろえた mcp__ply_computer__<ツール>、
 * それ以外はアイテムの type（docs/computer-use.md「tool.start / tool.result」）
 */
const toolName = (item) => codexComputerName(item) ?? item?.type;

/** ThreadItem -> tool.start の input。何をしようとしているかが1行で分かる形にする。 */
function toolInput(item) {
  const computer = codexComputerName(item);
  if (computer) return computerToolInput(computer, item.arguments && typeof item.arguments === "object" ? item.arguments : {});
  switch (item?.type) {
    case "commandExecution":
      return { command: item.command ?? "", cwd: item.cwd ?? null };
    case "fileChange":
      return { files: (item.changes ?? []).map((c) => c.path).filter(Boolean) };
    case "mcpToolCall":
      return { server: item.server ?? "", tool: item.tool ?? "", arguments: item.arguments ?? null };
    case "webSearch":
      return { query: item.query ?? "" };
    case "imageView":
      return { path: item.path ?? "" };
    case "imageGeneration":
      return { revisedPrompt: item.revisedPrompt ?? "" };
    // 委譲カード（web/render.mjs の drawTask）は description を見出し、prompt を「渡した指示」に出す。
    // server はこの description（無ければ prompt）を実行中一覧の見出しに使う
    case "subAgentActivity": {
      const name = agentName(item.agentPath) || t("codex.subagent.name");
      const kind = item.kind ?? "started";
      return {
        description: kind === "started" ? name : t("codex.subagent.withKind", { name, kind: activityLabel(kind) }),
        kind, agentPath: item.agentPath ?? null, agentThreadId: item.agentThreadId ?? null,
      };
    }
    case "collabAgentToolCall": {
      const names = (item.receiverThreadIds ?? []).map(nameOfChild).filter(Boolean);
      const verb = collabVerb(item.tool);
      const description = item.tool === "spawnAgent"
        ? names.join(", ") || firstLine(item.prompt) || t("codex.subagent.name")
        : names.length && verb ? t("codex.subagent.collab", { verb, names: names.join(", ") })
        : verb || names.join(", ");
      return {
        description, prompt: item.prompt ?? null, model: item.model ?? null,
        tool: item.tool ?? null, receiverThreadIds: item.receiverThreadIds ?? [],
      };
    }
    default: {
      // 知らないアイテムでも、id と type 以外は出せるものを出す
      const { id, type, ...rest } = item ?? {};
      return rest;
    }
  }
}

/**
 * 同梱の computer use が切れたかを確かめる（ADR 0074）。上書きのキーは Codex の版で変わりうるので、残っていればログに 1 行出す。
 * ターンは待たせない（失敗も黙って捨てる）
 */
function checkBundledComputerUse(rpc, threadId) {
  rpc.request("mcpServerStatus/list", { threadId }, 15_000).then((out) => {
    const left = (out?.data ?? []).filter((s) => s?.name === "cua_repl" || /computer-use/i.test(String(s?.pluginId ?? ""))).map((s) => s.name);
    if (left.length) console.error(`  codex: 同梱の computer use が切れていない（${left.join(", ")}）。ADR 0074 の上書きのキーを確かめる`);
  }).catch(() => {});
}

/** ThreadItem（完了後） -> tool.result の中身。 */
function toolResult(item) {
  if (item?.type === "imageGeneration") {
    const images = [];
    if (item.status === "completed") {
      if (item.savedPath) images.push({ url: `/local-file?path=${encodeURIComponent(item.savedPath)}`, path: item.savedPath });
      else if (typeof item.result === "string" && /^[A-Za-z0-9+/=\r\n]+$/.test(item.result)) {
        images.push({ dataUri: `data:image/png;base64,${item.result}` });
      }
    }
    return { ...cut(JSON.stringify({ status: item.status, revisedPrompt: item.revisedPrompt,
      savedPath: item.savedPath, failure: item.failure })), images,
      isError: item.status === "failed" || Boolean(item.failure) };
  }
  if (item?.type === "commandExecution") {
    const code = item.exitCode;
    const body = String(item.aggregatedOutput ?? "");
    const head = Number.isFinite(code) ? `exit=${code}${body ? NL : ""}` : "";
    return { ...cut(head + body), isError: item.status === "failed" || (Number.isFinite(code) && code !== 0) };
  }
  if (item?.type === "fileChange") {
    // 変更されたファイルの一覧。diff は長いので出さない（web は1行に要約する）
    const lines = (item.changes ?? []).map((c) => `${c.kind?.type ?? "update"} ${c.path}`);
    return { ...cut(lines.join(NL)), isError: item.status === "failed" };
  }
  // ply_computer: text ブロックだけをつなぎ（image の base64 は捨てる）、印の行から images と computer を作る。2000 字の切り詰めは印を除いた本文に掛ける
  if (codexComputerName(item) && !item.error && item.result) {
    const r = computerResult(mcpText(item.result), cut);
    return { ...r, isError: Boolean(item.result.isError) || item.status === "failed" || computerFailed(r.computer) };
  }
  if (item?.type === "mcpToolCall") {
    const body = item.error
      ? String(item.error.message ?? JSON.stringify(item.error))
      : JSON.stringify(item.result ?? {});
    return { ...cut(body), isError: Boolean(item.error) || item.status === "failed" };
  }
  if (item?.type === "webSearch") {
    const results = Array.isArray(item.results) ? item.results : [];
    return { ...cut(results.map((r) => r?.url ?? r?.title ?? "").filter(Boolean).join(NL) || item.query || ""), isError: false };
  }
  if (item?.type === "subAgentActivity") {
    const kind = item.kind ?? "started";
    return { ...cut(`${activityLabel(kind)}: ${item.agentPath ?? item.agentThreadId ?? ""}`), isError: false };
  }
  if (item?.type === "collabAgentToolCall") {
    const lines = Object.entries(item.agentsStates ?? {}).map(([id, s]) =>
      `${nameOfChild(id) || id}: ${s?.status ?? "?"}${s?.message ? ` — ${s.message}` : ""}`);
    return { ...cut(lines.join(NL) || String(item.status ?? "")), isError: item.status === "failed" };
  }
  const { id, type, ...rest } = item ?? {};
  return { ...cut(JSON.stringify(rest)), isError: false };
}

// ---------------------------------------------------------------- 承認

/**
 * 正規形の答え -> 各承認の Response。
 *
 * decision の語彙は**承認の種類ごとに違う**（スキーマで確認済み）:
 *   commandExecution … accept / acceptForSession / decline / cancel（+ 2種の amendment オブジェクト）
 *   fileChange       … accept / acceptForSession / decline / cancel
 *   permissions      … decision を持たない。{ permissions, scope } を返す形
 * 「常に許可」は acceptForSession（= このスレッドの残りは聞かない）に写す。
 * 拒否は decline（turn は続く）。cancel はターンごと止めるので、中断は abort が持つ経路に任せる。
 */
function approvalResponse(method, params, answer) {
  const allow = Boolean(answer?.allow);
  const always = Boolean(answer?.always);

  if (method === "item/permissions/requestApproval") {
    // 許可なら要求された権限をそのまま返す。「常に」はセッション、そうでなければこのターンだけ。
    // 拒否は「何も与えない」= 空の profile（decline に相当するものがスキーマに無い）。
    return allow
      ? { permissions: params?.permissions ?? {}, scope: always ? "session" : "turn" }
      : { permissions: {} };
  }

  if (!allow) return { decision: "decline" };
  return { decision: always ? "acceptForSession" : "accept" };
}

/**
 * サブエージェント（子スレッド）の承認・質問に添える名前。承認カードの見出し（title）に出る。
 * agent_path（`/root/csv_fixture_research`）の末尾は spawn_agent の task_name そのものなので優先する。
 * 孫は `/root/a/b` になるので、`/root/` だけ外して `a/b` と出す。
 */
function subagentLabel(child) {
  const path = String(child?.path ?? "").replace(/^\/root\/?/, "");
  const name = path || child?.nickname || child?.role || "";
  return name ? t("codex.subagent.named", { name }) : t("codex.subagent.name");
}

// ------------------------------------------------ サブエージェント（一覧 UI）
//
// 実行中一覧（server の runningWork）に載せるための口。docs/multi-backend.md §2.6。
//   - 一覧: `thread/list { parentThreadId }`（永続化された子）と、実行時に覚えた子（rpc.parents と
//     親の subAgentActivity / collabAgentToolCall）の和。前者は app-server の永続化の間合いに、
//     後者は子の通知がこの接続に流れるかに依存するので、和を取ってどちらにも寄りかからない
//   - 本文: `thread/read { threadId: 子, includeTurns: true }` を threadToMessages へ
//   - 生んだ委譲の id と状態: 親の items（実行時は通知、無ければ親の thread/read）
// server は 4 秒ごとに全部を呼ぶ（listSubagents / getSubagentMessages / getSubagentOrigin / getSubagentState）。
// 重い呼び出しを毎回しないよう、ここで短く覚える。

/** 子として受け付ける thread id。agentId は WS 越しにクライアントから戻ってくるので形を確かめる */
const THREAD_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const validId = (v) => typeof v === "string" && THREAD_ID.test(v);

/** `/root/a/b` -> `a/b`（subagentLabel と同じ規則） */
const agentName = (p) => String(p ?? "").replace(/^\/root\/?/, "");
const firstLine = (s) => String(s ?? "").split(/\r?\n/).map((l) => l.trim()).find(Boolean)?.slice(0, 80) ?? "";

// 見出しに添える語。呼ぶたびに引く（言語は実行中に変わる）
const ACTIVITY_KINDS = new Set(["started", "interacted", "completed", "interrupted"]);
// i18n-dynamic: codex.activity.
const activityLabel = (kind) => (ACTIVITY_KINDS.has(kind) ? t(`codex.activity.${kind}`) : kind);
const COLLAB_VERBS = new Set([
  "spawnAgent", "sendInput", "sendMessage", "followupTask",
  "resumeAgent", "wait", "closeAgent", "interruptAgent", "listAgents",
]);
// i18n-dynamic: codex.collab.
const collabVerb = (tool) => (COLLAB_VERBS.has(tool) ? t(`codex.collab.${tool}`) : String(tool ?? ""));

/** 状態の語彙（server の getSubagentState の契約）への写し。notFound など写せないものは null（分からない） */
const ACTIVITY_STATE = { started: "running", interacted: "running", completed: "completed", interrupted: "stopped" };
const COLLAB_STATE = {
  pendingInit: "running", running: "running", completed: "completed",
  errored: "failed", shutdown: "stopped", interrupted: "stopped",
};
const TERMINAL = new Set(["completed", "failed", "stopped"]);

/** 覚えておく子の上限（1 本数百バイト）。古いものから忘れる */
const MAX_SUBAGENTS = 2000;
/** `thread/list { parentThreadId }` の 1 回の件数。既定は「サーバー任せ」なので明示する */
const SUBAGENT_LIST_LIMIT = 100;
/** 一覧を覚えている時間。同じ配信の中の重複（ターン開始時と runningWork）をまとめる程度 */
const LIST_TTL_MS = 2_000;
/** 走っている子の本文を読み直す間隔の下限 */
const MESSAGES_TTL_MS = 3_000;
/** 親の items を読み直す間隔の下限（生んだ委譲の id と状態を、通知を見ていない子について引く） */
const PARENT_TTL_MS = 10_000;

/**
 * 実行時に見た子。child threadId -> { parent, origin, originKind, status, startedAt, endedAt, path, prompt }。
 * 親の items の通知（item/started / item/completed）と子の thread/started から作る。
 */
const liveSubagents = new Map();
/** thread/list の行から覚えた子の時刻。child -> { createdAt, updatedAt } */
const childMeta = new Map();
const listCache = new Map();      // parent -> { at, promise }
const messageCache = new Map();   // child -> { parent, at, stamp, messages }
const parentCache = new Map();    // parent -> { at, promise }（promise は Map<child, entry>）
/** false になったら thread/list の parentThreadId を使わない（持たない版） */
let listByParent = true;

const bounded = (map, max = MAX_SUBAGENTS) => {
  while (map.size > max) map.delete(map.keys().next().value);
};

const nameOfChild = (id) =>
  agentName(nativeRpc.agents.get(id)?.path ?? liveSubagents.get(id)?.path) || nativeRpc.agents.get(id)?.nickname || "";

/**
 * 親の items の 1 件を map に畳む。parent はその item が載っているスレッド（collab は senderThreadId）。
 * at は { start, end }（ISO）。実行時は通知の startedAtMs / completedAtMs、履歴はターンの時刻。
 * 後から来たものが勝つ（interacted の後に completed、completed の後に interacted = 再開）。
 */
function applySubagentItem(map, parent, item, at) {
  const entry = (id, create) => {
    let e = map.get(id);
    if (!e && create) {
      e = { parent, origin: null, originKind: null, status: null, startedAt: null, endedAt: null, path: null, prompt: null };
      map.set(id, e);
    }
    return e ?? null;
  };
  const setStatus = (e, status) => {
    if (!status) return;
    if (status === "running") {
      if (!e.startedAt) e.startedAt = at.start;
      e.endedAt = null;
    } else if (e.status !== status || !e.endedAt) {
      e.endedAt = at.end ?? at.start;
    }
    e.status = status;
  };

  if (item?.type === "subAgentActivity") {
    if (!validId(item.agentThreadId) || item.agentThreadId === parent) return;
    const e = entry(item.agentThreadId, true);
    if (item.agentPath) e.path = item.agentPath;
    // 生んだ委譲の id。kind=started の item id は spawn の function call id（call_…）そのもの
    if ((item.kind ?? "started") === "started" && item.id && e.originKind !== "activity") {
      e.origin = item.id;
      e.originKind = "activity";
    }
    setStatus(e, ACTIVITY_STATE[item.kind ?? "started"]);
    return;
  }

  if (item?.type === "collabAgentToolCall") {
    const spawn = item.tool === "spawnAgent";
    const ids = new Set([...(item.receiverThreadIds ?? []), ...Object.keys(item.agentsStates ?? {})]);
    for (const id of ids) {
      if (!validId(id) || id === parent) continue;
      // 親子を決めるのは spawn だけ。send_message などで兄弟を子と取り違えない（codex-rpc の #learn と同じ）
      const e = entry(id, spawn && (item.receiverThreadIds ?? []).includes(id));
      if (!e) continue;
      if (spawn && item.id && !e.origin) { e.origin = item.id; e.originKind = "collab"; }
      if (spawn && item.prompt && !e.prompt) e.prompt = item.prompt;
      const state = COLLAB_STATE[item.agentsStates?.[id]?.status];
      if (state) setStatus(e, state);
      else if (spawn && item.status === "failed") setStatus(e, "failed");
      else if (spawn && item.status === "interrupted") setStatus(e, "stopped");
      else if (spawn && !e.status) setStatus(e, "running");
    }
  }
}

/** 全部の通知から、実行時の子を覚える（native の接続は onNotify、別プロセスの接続は runTurn から） */
function observeSubagents(method, params) {
  if (method === "thread/started") {
    const t = params?.thread;
    const spawn = t?.source?.subAgent?.thread_spawn;
    const parent = t?.parentThreadId ?? spawn?.parent_thread_id;
    if (!validId(t?.id) || !validId(parent) || t.id === parent) return;
    let e = liveSubagents.get(t.id);
    if (!e) {
      e = { parent, origin: null, originKind: null, status: null, startedAt: null, endedAt: null, path: null, prompt: null };
      liveSubagents.set(t.id, e);
    }
    if (spawn?.agent_path) e.path = spawn.agent_path;
    if (!e.status) { e.status = "running"; e.startedAt = toIso(t.createdAt) ?? new Date().toISOString(); }
    bounded(liveSubagents);
    return;
  }
  if (method !== "item/started" && method !== "item/completed") return;
  const item = params?.item;
  if (!SUBAGENT_ITEMS.includes(item?.type)) return;
  const parent = item.type === "collabAgentToolCall" ? (item.senderThreadId ?? params?.threadId) : params?.threadId;
  if (!validId(parent)) return;
  const now = new Date().toISOString();
  applySubagentItem(liveSubagents, parent, item, {
    start: toIso(params?.startedAtMs ?? params?.completedAtMs) ?? now,
    end: toIso(params?.completedAtMs ?? params?.startedAtMs) ?? now,
  });
  bounded(liveSubagents);
}

nativeRpc.onNotify(observeSubagents);

// ロード済みのスレッドがどの接続先（model_providers の id。公式は "default"）で読み込まれているか。
// app-server はロード済みのスレッドへの thread/resume で modelProvider・config を渡しても無視する（スパイク 2026-09-23、codex-cli 0.153.2）。
// 接続先が変わったスレッドは thread/unsubscribe してから resume すると新しい接続先が効くので、その判断に使う。
// app-server が落ちたら全部アンロードされるので捨てる
const loadedProvider = new Map();
// 同じく、ロード済みのスレッドに渡した developerInstructions。Pleiad の指示（core/ply-instructions.mjs）は
// 設定・承認モードでターンごとに変わるので、前と違えば接続先と同じく外してから読み直す（始まっている会話にも次のターンから効かせる）
const loadedInstructions = new Map();
// 同じく、ロード済みのスレッドに渡した hooks の config の指紋（'' は渡していない）。Hooks を Pleiad がそろえる会話（ADR 0049）は
// thread の config で hooks と hooks.state を渡すが、ロード済みのスレッドへの resume は config を無視する（実機で確認。2026-09-28）。
// 指紋が変わったら外してから読み直し、外せなければターンを始めない（二重実行か未実行になるため）
const loadedHooks = new Map();
nativeRpc.onDown(() => { loadedProvider.clear(); loadedInstructions.clear(); loadedHooks.clear(); });

/**
 * スレッドを hooks の config（指紋 hooksKey。'' は渡さない）で読み直せるように外す。共有の app-server だけ（専用の app-server は毎回新しい）。
 * 追跡している（loadedHooks にある）スレッドは指紋が違うときだけ外す。追跡していないスレッドは、圧縮・分岐など別の経路で
 * どの config でロードされたか分からないので、hooks を渡すなら必ず外す（ロードされていなければ notLoaded で通る）。
 * 外せなければ投げる（resume が config を黙って無視し、二重実行か未実行になるため）。外したかを返す
 */
async function unloadForHooks(rpc, threadId, hooksKey) {
  if (rpc !== nativeRpc || !threadId) return false;
  const needs = loadedHooks.has(threadId) ? loadedHooks.get(threadId) !== hooksKey : hooksKey !== '';
  if (!needs) return false;
  const out = await rpc.request('thread/unsubscribe', { threadId }).catch(e => ({ error: e }));
  if (out?.error || !['unsubscribed', 'notLoaded', 'notSubscribed'].includes(out?.status)) {
    throw new Error(t('codex.errors.hooksUnsubscribeFailed', { reason: out?.error?.message ?? out?.status ?? t('codex.errors.noResponse') }));
  }
  loadedProvider.delete(threadId); loadedInstructions.delete(threadId); loadedHooks.delete(threadId);
  return true;
}

// Pleiad の登録を信頼済みとして渡す hash（hooks.state の trusted_hash）。同じ表を起動の -c で渡した app-server の hooks/list の
// currentHash（source: sessionFlags）から取る（LLM は呼ばない）。表が同じなら同じ hash なので、表ごとに覚える（新しく使った 50 表まで）。
// 同じ表を同時に頼まれたら 1 本のプローブを分け合い、失敗は 30 秒のあいだ覚えて app-server を起こし直さない
const probeCache = new Map();
const PROBE_KEEP = 50, PROBE_FAIL_MS = 30_000;
export function probeHookHashes(table, cwd, { spawn = config => new CodexRpc(config), now = Date.now } = {}) {
  const key = JSON.stringify(table);
  const hit = probeCache.get(key);
  if (hit && !(hit.failedAt && now() - hit.failedAt > PROBE_FAIL_MS)) {
    probeCache.delete(key); probeCache.set(key, hit);   // 新しく使った順に並べ直す
    return hit.promise;
  }
  const entry = { failedAt: null, promise: null };
  entry.promise = (async () => {
    const probe = spawn({ hooks: table });
    try { return (await probe.request('hooks/list', { cwds: [cwd] }, 30_000))?.data ?? []; }
    finally { probe.stop(); }
  })();
  entry.promise.catch(() => { entry.failedAt = now(); });
  probeCache.delete(key); probeCache.set(key, entry);
  while (probeCache.size > PROBE_KEEP) probeCache.delete(probeCache.keys().next().value);
  return entry.promise;
}
/**
 * Hooks を Pleiad がそろえるターンの config の hooks。ターンごとに hooks/list（その会話の app-server・その cwd）を取り直し、
 * ユーザー・プロジェクトの定義の key を enabled:false にする。自分の定義には trusted_hash を付ける（ADR 0049。Pleiad の画面で確かめた登録だけ）
 */
export async function codexHooksConfig(runtime, rpc, cwd, { probe = probeHookHashes } = {}) {
  const list = (await rpc.request('hooks/list', { cwds: [cwd] }, 15_000))?.data;
  // 一覧が欠けている・形が違う・cwd ごとの errors があるときは、止める key が全部そろっていない。0 件として続けない（ネイティブが漏れて動く）
  const problem = codexListProblem(list, cwd);
  if (problem) throw new Error(t('codex.errors.hooksList', { detail: problem }));
  // 渡す登録すべての trusted_hash が取れなければ始めない。hash の無い登録を Codex は動かさず、ネイティブだけを止めることになる
  const probed = Object.keys(runtime.table).length ? await probe(runtime.table, cwd).catch(e => { throw new Error(t('codex.errors.hooksTrust', { detail: String(e?.message ?? e).slice(0, 200) })); }) : [];
  const { state, stopped, kept, untrusted } = codexHooksState({ table: runtime.table, probe: probed, list });
  if (untrusted) throw new Error(t('codex.errors.hooksTrust', { detail: `${untrusted}` }));
  const row = h => ({ key: h.key, source: h.source, event: h.eventName ? h.eventName[0].toUpperCase() + h.eventName.slice(1) : null, path: h.sourcePath ?? '',
    command: h.command ? maskText(h.command) : '', matcher: typeof h.matcher === 'string' ? h.matcher : null, ...(h.pluginId ? { plugin: h.pluginId } : {}) });
  Object.assign(runtime.record, { stopped: stopped.map(row), kept: kept.map(row), ...(untrusted ? { untrusted } : {}) });
  const config = { ...runtime.table, ...(Object.keys(state).length ? { state } : {}) };
  return { config, key: crypto.createHash('sha256').update(JSON.stringify(config)).digest('hex') };
}
const HOOK_OUTCOME = { completed: 'success', failed: 'error', blocked: 'blocked', stopped: 'cancelled' };
/** Codex の hook/started・hook/completed を Pleiad の hookRun にする。出力（entries の本文）は秘密を含みうるので持ち出さない */
export function codexHookRun(method, params, hooksRuntime = null) {
  const run = params?.run ?? {};
  const event = typeof run.eventName === 'string' && run.eventName ? run.eventName[0].toUpperCase() + run.eventName.slice(1) : '';
  const source = typeof run.source === 'string' ? run.source : 'unknown';
  const pleiad = source === 'sessionFlags';
  // Pleiad が渡した定義のうち、同じイベントが 1 件だけならその登録の名前で出す（通知には定義の位置が無い）
  const mine = pleiad ? (hooksRuntime?.supplied ?? []).filter(s => s.d.event === event) : [];
  const one = mine.length === 1 ? mine[0].hook : null;
  return { type: 'hookRun', phase: method === 'hook/started' ? 'started' : 'response', hookId: String(run.id ?? ''), name: one?.name ?? event, event, source,
    ...(pleiad ? { pleiad: true, ...(one ? { id: one.id } : {}) } : {}),
    ...(hooksRuntime && ['user', 'project'].includes(source) ? { leak: true } : {}),
    ...(method === 'hook/completed' ? { outcome: HOOK_OUTCOME[run.status] ?? 'error', ...(Number.isInteger(run.durationMs) ? { ms: run.durationMs } : {}) } : {}) };
}
/** 公式の provider の id（config.toml の model_provider、無ければ openai）。互換から公式へ戻すときに明示する */
async function defaultProvider(rpc, cwd) {
  const { config } = await rpc.request('config/read', { cwd, includeLayers: false }).catch(() => ({}));
  return typeof config?.model_provider === 'string' && config.model_provider ? config.model_provider : 'openai';
}
// app-server が落ちた。走っていた子は道連れなので、実行時の観測は捨てて履歴（thread/read）から引き直す
nativeRpc.onDown(() => {
  liveSubagents.clear();
  listCache.clear();
  messageCache.clear();
  parentCache.clear();
});

/** 期限切れの覚えを捨てる（親が何百あっても膨らまない） */
function pruneCache(map, ttl) {
  const now = Date.now();
  for (const [k, v] of map) if (now - v.at > ttl) map.delete(k);
}

/**
 * `thread/list { parentThreadId }` の子 id。
 *
 * **返ってきた行を parentThreadId で絞り直す**。parentThreadId を知らない版は、知らないフィールドを
 * 黙って無視して普通の一覧（トップレベルの会話）を返しうる。そのまま載せると会話がサブエージェントとして並ぶ。
 * 行がそもそも parentThreadId を持たない（= 知らない版）か、パラメータを撥ねられたら以後は使わない。
 *
 * useStateDbOnly は付けない。走っている子が state DB に反映される間合いが未確認で、
 * 実機（0.153.2、rollout 875 本）では付けなくても 1〜2ms で返った（docs/multi-backend.md §2.6）。
 */
function listChildren(parent) {
  const hit = listCache.get(parent);
  if (hit && Date.now() - hit.at < LIST_TTL_MS) return hit.promise;
  pruneCache(listCache, LIST_TTL_MS);
  const promise = (async () => {
    if (!listByParent) return [];
    let res;
    try {
      res = await nativeRpc.request("thread/list", { parentThreadId: parent, limit: SUBAGENT_LIST_LIMIT }, 15_000);
    } catch (err) {
      if (noSuchMethod(err) || unknownField(err)) {
        listByParent = false;
        console.error("  codex: thread/list の parentThreadId を使えない版。実行時に見た子だけを一覧に出す");
      }
      return [];
    }
    const rows = Array.isArray(res?.data) ? res.data : [];
    if (rows.length && rows.every((t) => !t || !("parentThreadId" in t) && !t.source?.subAgent)) {
      listByParent = false;
      console.error("  codex: thread/list が parentThreadId を返さない版。実行時に見た子だけを一覧に出す");
      return [];
    }
    const out = [];
    for (const t of rows) {
      const p = t?.parentThreadId ?? t?.source?.subAgent?.thread_spawn?.parent_thread_id ?? null;
      if (!validId(t?.id) || p !== parent) continue;
      out.push(t.id);
      childMeta.set(t.id, { createdAt: toIso(t.createdAt), updatedAt: toIso(t.updatedAt) });
    }
    bounded(childMeta);
    return out;
  })();
  listCache.set(parent, { at: Date.now(), promise });
  return promise;
}

/** パラメータを知らない版の撥ね方。-32602 か、-32600 + unknown field */
const unknownField = (err) =>
  err?.code === -32602 || (err?.code === -32600 && /unknown field/i.test(String(err?.message ?? "")));

/** 親の items を読んで、子ごとの { origin, status, 時刻 } を作る。PARENT_TTL_MS のあいだ覚える */
function scanParent(parent) {
  const hit = parentCache.get(parent);
  if (hit && Date.now() - hit.at < PARENT_TTL_MS) return hit.promise;
  pruneCache(parentCache, PARENT_TTL_MS);
  const promise = (async () => {
    const res = await nativeRpc.request("thread/read", { threadId: parent, includeTurns: true }, 30_000);
    const map = new Map();
    for (const turn of res?.thread?.turns ?? []) {
      const at = { start: toIso(turn.startedAt), end: toIso(turn.completedAt) ?? toIso(turn.startedAt) };
      for (const item of turn.items ?? []) {
        if (SUBAGENT_ITEMS.includes(item?.type)) {
          const from = item.type === "collabAgentToolCall" ? (item.senderThreadId ?? parent) : parent;
          applySubagentItem(map, from, item, at);
        }
      }
    }
    for (const [id, e] of map) if (e.parent !== parent) map.delete(id);   // 孫は直接の子ではない
    return map;
  })();
  promise.catch(() => parentCache.delete(parent));   // 失敗は覚えない
  parentCache.set(parent, { at: Date.now(), promise });
  return promise;
}

const isKnownChild = (parent, child) =>
  nativeRpc.parents.get(child) === parent || liveSubagents.get(child)?.parent === parent;

/** limit を超えたら先頭（依頼に当たる最初の発言）と末尾を残す。Claude の subagentEntries と同じ規則 */
function trimMessages(messages, limit) {
  const kept = limit > 0 && messages.length > limit
    ? [messages[0], ...(limit > 1 ? messages.slice(messages.length - (limit - 1)) : [])]
    : messages;
  return kept.map((m) => ({ ...m }));
}

function subagentState(e, child, fromHistory) {
  const meta = childMeta.get(child);
  const terminal = TERMINAL.has(e.status);
  // 履歴から導いた時刻はターンの時刻（粗い）。子の Thread の時刻があればそちらが正確
  const startedAt = fromHistory ? (meta?.createdAt ?? e.startedAt) : (e.startedAt ?? meta?.createdAt);
  const endedAt = !terminal ? null : fromHistory ? (meta?.updatedAt ?? e.endedAt) : (e.endedAt ?? meta?.updatedAt);
  return { status: e.status, startedAt: startedAt ?? null, endedAt: endedAt ?? null };
}

/** ToolRequestUserInputQuestion[] -> 正規形の questions（web の質問カードが読む形）。 */
function toQuestions(list) {
  return (list ?? []).map((q) => ({
    question: String(q.question ?? ""),
    header: q.header ?? null,
    // スキーマに複数選択の指定は無い。単一選択として出す
    multiSelect: false,
    options: (q.options ?? []).map((o) => ({ label: String(o.label ?? ""), description: o.description ?? null })),
  }));
}

/**
 * 正規形の answers（`{ 質問文: "A, B" }`） -> ToolRequestUserInputResponse。
 * codex は**質問 id をキーにした配列**を求めるので、質問文から id へ引き直す。
 */
function toUserInputResponse(questions, answers) {
  const out = {};
  for (const q of questions ?? []) {
    const raw = answers?.[q.question];
    const picked = typeof raw === "string" && raw.trim()
      ? raw.split(",").map((s) => s.trim()).filter(Boolean)
      : [];
    out[q.id] = { answers: picked };
  }
  return { answers: out };
}

// ---------------------------------------------------------------- 履歴

/**
 * thread/read {includeTurns:true} の turns/items -> NormalizedMessage[]。
 *
 * codex のアイテムは「1ターンの中に時系列で並ぶ」形なので、
 * reasoning とツールを assistant の発言に畳んでから積む
 * （Claude の transcriptToMessages と同じ形にして、web/render.mjs をそのまま使う）。
 */
export function threadToMessages(thread, { fullResults = false } = {}) {
  const messages = [];

  for (const turn of thread?.turns ?? []) {
    const at = toIso(turn.startedAt ?? turn.completedAt);
    let thinking = "";
    let toolCalls = [];

    const flushTools = () => {
      if (!toolCalls.length) return;
      messages.push({
        role: "assistant", text: "", uuid: toolCalls[0].id, at,
        ...(thinking ? { thinking } : {}),
        tools: toolCalls.map((c) => c.name),
        toolCalls,
      });
      thinking = "";
      toolCalls = [];
    };

    // A replayed notification with the same id is still the same invocation.
    const unique = new Map();
    for (const item of turn.items ?? []) unique.set(item.id ?? Symbol(), item);
    for (const item of unique.values()) {
      if (item?.type === "userMessage") {
        flushTools();
        // Codex Desktop が人の本文の先頭に付ける画面の状態（<in-app-browser-context>）は外す（ADR 0053）
        const text = stripInjectedContext((item.content ?? [])
          .filter((c) => c?.type === "text" && typeof c.text === "string")
          .map((c) => c.text).join(""));
        const attachments = (item.content ?? []).filter(c => c?.type !== "text");
        if (text.trim() || attachments.length) messages.push({ role: "user", text, uuid: item.id, at,
          ...(attachments.length ? { attachments: structuredClone(attachments) } : {}) });
        continue;
      }

      if (item?.type === "reasoning") {
        // summary（要約された思考）が正。content が来るのは設定次第
        const parts = [...(item.summary ?? []), ...(item.content ?? [])].filter((s) => typeof s === "string");
        if (parts.length) thinking += (thinking ? NL : "") + parts.join(NL);
        continue;
      }

      if (item?.type === "agentMessage") {
        const msg = { role: "assistant", text: String(item.text ?? ""), uuid: item.id, at };
        if (thinking) { msg.thinking = thinking; thinking = ""; }
        if (toolCalls.length) {
          msg.tools = toolCalls.map((c) => c.name);
          msg.toolCalls = toolCalls;
          toolCalls = [];
        }
        if (msg.text || msg.thinking || msg.toolCalls) messages.push(msg);
        continue;
      }

      // 入力欄の `!`（Codex の TUI・Desktop の `!` も同じ）。エージェントのツールではなく、人が走らせた行（ADR 0054）
      if (isUserShell(item)) {
        flushTools();
        const command = userShellCommand(item);
        const aborted = userShellAborted(item);
        messages.push({ role: "user", kind: "shell", text: `! ${command}`, command,
          stdout: item.aggregatedOutput && !aborted ? shellText(item.aggregatedOutput) || null : null, stderr: null,
          exitCode: Number.isInteger(item.exitCode) && !aborted ? item.exitCode : null, uuid: item.id, at,
          ...(aborted ? { stopped: true } : {}), ...(item.status === "inProgress" ? { running: true } : {}) });
        continue;
      }

      if (TOOL_ITEMS.has(item?.type)) {
        const r = toolResult(item);
        // ply_computer の全文は印を除いた text（item には画像の base64 が入っているので JSON にしない）
        const full = !fullResults ? null : codexComputerName(item) && item.result ? computerResult(mcpText(item.result), (text) => ({ text, truncated: false })).text : JSON.stringify(item);
        toolCalls.push({
          id: item.id ?? null,
          name: toolName(item),
          input: toolInput(item),
          // 進行中のまま残っているアイテムは結果を持たない
          result: item.status === "inProgress" ? null : { ...r, text: fullResults ? full : r.text, truncated: fullResults ? false : r.truncated },
        });
      }
    }

    flushTools();
    if (thinking) messages.push({ role: "assistant", text: "", uuid: `${turn.id}-thinking`, at, thinking });
  }

  return messages;
}

/** Thread -> バックエンド共通のセッション行。時刻は秒ではなく**ミリ秒**（スキーマの int64）。 */
function toRow(t) {
  if (!t?.id) return null;
  return {
    sessionId: t.id,
    // name が正本（thread/name/set で公式クライアントと共有される）。無ければ preview を出す
    title: t.name || (t.preview ? promptTitle(t.preview) : null) || null,
    cwd: t.cwd ?? null,
    createdAt: toIso(t.createdAt),
    lastModified: toMs(t.updatedAt),
    tag: null,   // codex に状態タグは無い。sidecar が正本（capabilities.tag: false）
    ...(t.forkedFromId ? { parent: { sessionId: t.forkedFromId, atMessage: null } } : {}),
  };
}

// ------------------------------------------------ バックグラウンド端末の見張り

/**
 * ターンの外でも動いている端末（`unified_exec`）を、会話ごとに見張る（issue #6、docs/multi-backend.md §2.7）。
 *
 * **runTurn の attach / detach とは独立**。`rpc.onNotify` は全部の通知を受けるので、
 * ターンが終わって detach した後に届く `item/completed`（turnId は終わったターンのまま）も拾える。
 * 見張るのは Pleiad が 1 度でもターンを回したスレッドだけ。子スレッド（サブエージェント）の
 * 通知は同じ接続に流れてくるが、会話を持たないので数えない
 * （親のターンをまたぐ子はこれまでの記録で 0 件。出てきたら同じ仕組みに kind: "agent" で足す）。
 *
 * contextRuntime のターンは別プロセスの app-server を立て、ターンの終わりに落とす。
 * 端末も道連れになるので見張らない（native の rpc だけを見る）。
 *
 * 印を出す先は**Pleiad の会話 id**（`hostSessionId`）。バックエンドを乗り換えた会話では
 * codex の threadId と会話 id が別物なので、通知を引く鍵（threadId）と報告先を分けて持つ。
 */
const trackers = new Map();   // threadId -> { tracker, sessionId }（sessionId = 報告先の会話 id）
let host = null;              // server が渡す口（background / event）
let watching = false;

/** 報告先の会話 id から見張りを引く（stopBackground は会話 id で来る）。 */
const watchOf = (sessionId) =>
  [...trackers].find(([, w]) => w.sessionId === sessionId)?.[1] ?? null;

/**
 * `thread/backgroundTerminals/list` で照合できるか。
 *
 * この method は `generate-json-schema` の出力に**現れない**（experimental）。
 * 実機で叩いて確かめた（codex-cli 0.154.0-alpha.6.2、2026-09-16）:
 *   thread/backgroundTerminals/list      -> `{ data: [...], nextCursor: string|null }`（cursor は数字の文字列）
 *   thread/backgroundTerminals/terminate -> `{ terminated: boolean }`（processId は数字の文字列）
 *   thread/backgroundTerminals/clean     -> `{}`
 * 一覧はスレッドが**ロード済み**でないと `thread not found` になる（Pleiad は毎ターン resume するので通る）。
 * 古い版（0.147.0 で確認）はこの method を持たない。
 */
let reconcilable = true;
let reconcileTimer = null;
let warnedShape = false;
/** 照合の間隔。タイマーを張る時点で読む（テストが短くできるように） */
const reconcileMs = () => Number(process.env.AGENT_HOST_CODEX_RECONCILE_MS ?? 60_000);
/** cursor を追う上限。1 会話の端末がこれを超えることは実際には無い */
const MAX_TERMINAL_PAGES = 20;

/**
 * この版の「そんな method は無い」。
 * codex 0.154 は JSON-RPC の -32601 ではなく **-32600 + `unknown variant`** で返す
 * （実機で確認。`thread/definitelyNotAMethod` がこの形になる）。両方を見る。
 */
const noSuchMethod = (err) =>
  err?.code === -32601 || (err?.code === -32600 && /unknown variant/i.test(String(err?.message ?? "")));

const report = (w) => {
  for (const x of w.tracker.list()) host?.event?.(w.sessionId, { type: "task.command", id: x.id, state: "background" });
  host?.background?.(w.sessionId, w.tracker.list());
  syncReconcile();
};

/** 裏で終わった端末の結果を、終わったターンのツールカードへ差し込む。 */
const reportFinished = (w, item) =>
  host?.event?.(w.sessionId, { type: "tool.result", id: item.id, commandCompleted: true, ...toolResult(item) });

function onWatchedNotification(method, params) {
  const threadId = params?.threadId;
  const w = threadId ? trackers.get(threadId) : null;
  if (!w) return;
  const { changed, finished } = w.tracker.observe(method, params);
  for (const event of commandActivity(method, params)) host?.event?.(w.sessionId, event);
  if (finished) reportFinished(w, finished);
  if (changed) report(w);
}

/**
 * この会話を見張る。ターンの id が決まった時点で呼ぶ。
 * sessionId は印を出す先（乗り換えた会話なら Pleiad の会話 id、そうでなければ threadId と同じ）。
 */
function watchThread(threadId, sessionId) {
  if (!threadId) return null;
  const known = trackers.get(threadId);
  if (known) {
    known.sessionId = sessionId || known.sessionId;
    return known;
  }
  const w = { tracker: createTerminalTracker(), sessionId: sessionId || threadId };
  trackers.set(threadId, w);
  return w;
}

/**
 * ターンが終わった。`turn/completed` が来ない終わり方（error 通知・中断）でも裏へ回す。
 * 端末が 1 本も残らなければ見張りを畳む（次のターンでまた張る）。
 */
function endTurn(threadId) {
  const w = threadId ? trackers.get(threadId) : null;
  if (!w) return;
  if (w.tracker.endTurn()) report(w);
  if (!w.tracker.size) trackers.delete(threadId);
  syncReconcile();
}

function syncReconcile() {
  const want = reconcilable && [...trackers.values()].some((w) => w.tracker.size > 0);
  if (want && !reconcileTimer) {
    reconcileTimer = setInterval(() => { reconcileAll().catch(() => {}); }, reconcileMs());
    reconcileTimer.unref?.();
  }
  if (!want && reconcileTimer) { clearInterval(reconcileTimer); reconcileTimer = null; }
}

function giveUpReconcile(why) {
  if (!reconcilable) return;
  reconcilable = false;
  syncReconcile();
  console.error(`  codex: バックグラウンド端末の照合をやめた（${why}）。遅れて届く item/completed だけで数える`);
}

/**
 * 1 スレッド分の端末一覧を `nextCursor` を追って全部読む。読み切れなければ null。
 *
 * **途中までの一覧で引いてはいけない**。まだ生きている端末が次のページに居るだけかもしれず、
 * 消すと「動いているのに印が無い」に戻る。読めなかったときは何もしないのが正しい。
 */
async function listTerminals(threadId) {
  const all = [];
  let cursor = null;
  for (let page = 0; page < MAX_TERMINAL_PAGES; page += 1) {
    const res = await nativeRpc.request(
      "thread/backgroundTerminals/list",
      { threadId, ...(cursor == null ? {} : { cursor }) }, 15_000,
    );
    const entries = Array.isArray(res?.data) ? res.data
      : Array.isArray(res?.terminals) ? res.terminals
      : Array.isArray(res) ? res
      : null;
    if (!entries) return null;
    all.push(...entries);
    cursor = res?.nextCursor ?? null;
    if (cursor == null) return all;
  }
  return null;
}

/**
 * 数えている端末を app-server に問い合わせて突き合わせる。取りこぼした終了を引くため。
 * 読めない応答で印を消さない。
 */
async function reconcileAll() {
  if (!reconcilable) return;
  for (const [threadId, w] of [...trackers]) {
    if (!w.tracker.size) continue;
    let entries;
    try {
      entries = await listTerminals(threadId);
    } catch (err) {
      // method ごと無い版なら、以後は照合しない。
      // そうでなければこのスレッドだけ飛ばす（unload されていると thread not found が返る。
      // これは -32601 ではなく -32600 で、諦める理由にはならない）
      if (noSuchMethod(err)) return giveUpReconcile("この codex には thread/backgroundTerminals/list が無い"); // i18n-ignore: ログにだけ出る（giveUpReconcile は console.error）
      continue;
    }
    if (entries === null) continue;   // 読み切れなかった。消さずに見送る
    const before = w.tracker.list();
    const { changed, understood } = w.tracker.reconcile(entries);
    if (understood) for (const x of before) if (!w.tracker.has(x.id)) host?.event?.(w.sessionId, { type: "task.command", id: x.id, state: "completed" });
    if (!understood) {
      // 応答はあるが、端末を見分ける id を拾えなかった。実機の要素の形が分かったら reconcile を直す
      if (!warnedShape) {
        warnedShape = true;
        console.error(`  codex: バックグラウンド端末の一覧の形が読めない: ${JSON.stringify(entries).slice(0, 300)}`);
      }
      continue;
    }
    if (changed) report(w);
  }
}

// ---------------------------------------------------------------- backend

export function codexContextWindow(tokenUsage) {
  const usedTokens = tokenUsage?.last?.totalTokens;
  const windowTokens = tokenUsage?.modelContextWindow;
  return Number.isFinite(usedTokens) && Number.isFinite(windowTokens) && windowTokens > 0
    ? { type: 'contextWindow', usedTokens, windowTokens } : null;
}

export function codexCompactionEvent(method, params) {
  if (method === 'thread/compacted' ||
      (method === 'item/completed' && params?.item?.type === 'contextCompaction'))
    return { type: 'compaction', phase: 'complete', trigger: 'auto', nativeId: params?.item?.id ?? null,
      turnId: params?.turnId ?? null };
  if (method === 'item/started' && params?.item?.type === 'contextCompaction')
    return { type: 'compaction', phase: 'start', trigger: 'auto', turnId: params?.turnId ?? null };
  return null;
}

export const backend = {
  async usage() { return codexQuota(await rpc.request('account/rateLimits/read', {}, 15_000)); },
  /**
   * Codex が今読む hooks と、その信頼状態（trustStatus: trusted / untrusted / modified / managed）と hash（hooks/list）。
   * 読むだけ。信頼・停止の RPC は無い（docs/context-management.md「Hooks」）
   */
  async hooksList(cwds) { return (await rpc.request('hooks/list', { cwds }, 15_000))?.data ?? []; },
  id: "codex",
  label: "OpenAI Codex",
  get description() { return t("codex.description"); },

  capabilities: {
    compact: true,
    title: true,        // thread/name/set。公式クライアントとタイトルを共有できる
    tag: false,         // 状態タグは持てない -> sidecar が正本
    fork: true,
    subagents: true,    // 子スレッド。thread/list { parentThreadId } と thread/read で読む
    liveModel: false,   // 走っている最中の切り替えは app-server に口が無い
    liveMode: false,
    hostTools: false,   // set_status / set_title / fork は未接続。可視化は共通の参照形式で提供
    plyAgents: true,    // ply_agents を mcp_servers に、その instructions を developerInstructions に渡す
    // ply_computer（runArgs.computerRuntime）を mcp_servers に、指示を developerInstructions に渡す。同梱の computer use は切る（ADR 0074）。
    // MCP の image は gpt-5.x では自動で、gpt-6 系のコードモードでは image() で渡したときモデルに見える（指示文で頼む）
    computerUse: { images: 'inline', waitSliceMs: null },
    alwaysAllow: true,  // acceptForSession
    login: true,
    // 互換の接続先（OpenAI Responses 互換）を会話ごとに選べる（core/compat-endpoints.mjs）
    compatEndpoints: true,
    // 入力欄の `!`: app-server の thread/shellCommand で走らせる（下の shell。ADR 0054）
    shell: 'native',
  },

  toolHints: TOOL_HINTS,
  subagentTools: SUBAGENT_ITEMS,

  async compact({ sessionId, emit, cwd, hooksRuntime = null }) {
    if (!validId(sessionId)) throw new Error(t('codex.errors.noThreadId', { method: 'thread/compact/start' }));
    // 圧縮でも PreCompact / PostCompact の hooks が動く。通常のターンと同じく、Hooks を Pleiad がそろえる会話は登録と止める key を渡し、
    // 違う config でロードされている（か分からない）スレッドは外してから読み直す（ADR 0049）
    const hooks = hooksRuntime ? await codexHooksConfig(hooksRuntime, nativeRpc, cwd) : null;
    const hooksKey = hooks?.key ?? '';
    await unloadForHooks(nativeRpc, sessionId, hooksKey);
    await nativeRpc.request('thread/resume', { threadId: sessionId, ...(hooks ? { config: { hooks: hooks.config } } : {}) });
    loadedHooks.set(sessionId, hooksKey);
    let off, timer;
    const completed = new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Compaction timed out')), 300_000);
      timer.unref?.();
      off = nativeRpc.onNotify((method, params) => {
        if (params?.threadId !== sessionId) return;
        if (method === 'thread/tokenUsage/updated') {
          const window = codexContextWindow(params.tokenUsage);
          if (window) emit(window);
          return;
        }
        if (method === 'hook/started' || method === 'hook/completed') { emit(codexHookRun(method, params, hooksRuntime)); return; }
        const event = codexCompactionEvent(method, params);
        if (event?.phase !== 'complete') return;
        clearTimeout(timer);
        emit({ ...event, trigger: 'manual' });
        resolve();
      });
    });
    completed.catch(() => {});
    try {
      emit({ type: 'compaction', phase: 'start', trigger: 'manual' });
      await nativeRpc.request('thread/compact/start', { threadId: sessionId });
      await completed;
    } finally { clearTimeout(timer); off?.(); }
  },

  // ---- サブエージェント（第 1 引数はネイティブの threadId。conversations.mjs が翻訳済み）--------

  /** 直接の子の threadId。thread/list { parentThreadId } と、実行時に覚えた子の和 */
  async listSubagents(threadId) {
    if (!validId(threadId)) return [];
    const ids = new Set(await listChildren(threadId));
    for (const [child, parent] of nativeRpc.parents) if (parent === threadId && validId(child)) ids.add(child);
    for (const [child, e] of liveSubagents) if (e.parent === threadId) ids.add(child);
    ids.delete(threadId);
    return [...ids];
  },

  /**
   * 子の会話。thread/read { threadId: 子, includeTurns: true } -> threadToMessages。
   * 子であることを確かめてから返す（agentId はクライアントから戻ってくる値）。
   * 終わった子は updatedAt が変わらない限り読み直さない。走っている子は MESSAGES_TTL_MS ごと。
   */
  async getSubagentMessages(threadId, agentId, { limit = 200 } = {}) {
    if (!validId(threadId) || !validId(agentId) || threadId === agentId) return [];
    const cached = messageCache.get(agentId);
    if (cached?.parent === threadId) {
      const fresh = Date.now() - cached.at < MESSAGES_TTL_MS;
      const settled = liveSubagents.get(agentId)?.status !== "running"
        && cached.stamp && childMeta.get(agentId)?.updatedAt === cached.stamp;
      if (fresh || settled) return trimMessages(cached.messages, limit);
    }
    const res = await nativeRpc.request("thread/read", { threadId: agentId, includeTurns: true }, 30_000);
    const t = res?.thread;
    if (!t) return [];
    const parent = t.parentThreadId ?? t.source?.subAgent?.thread_spawn?.parent_thread_id ?? null;
    if (parent ? parent !== threadId : !isKnownChild(threadId, agentId)) return [];
    const messages = threadToMessages(t);
    messageCache.set(agentId, { parent: threadId, at: Date.now(), stamp: toIso(t.updatedAt), messages });
    bounded(messageCache, 200);
    return trimMessages(messages, limit);
  },

  /**
   * 子を生んだ委譲の item id（= tool.start の event.id と同じ空間）。
   * subAgentActivity(kind=started) の id、無ければ spawnAgent の collabAgentToolCall の id。分からなければ null
   */
  async getSubagentOrigin(threadId, agentId) {
    if (!validId(threadId) || !validId(agentId)) return null;
    const live = liveSubagents.get(agentId);
    if (live?.parent === threadId && live.originKind === "activity") return live.origin;
    const past = (await scanParent(threadId).catch(() => null))?.get(agentId);
    return past?.origin ?? (live?.parent === threadId ? live.origin : null) ?? null;
  },

  /**
   * 子の状態 { status, startedAt, endedAt }。分からなければ null。
   * 親が native の接続で走っている間は通知が正（呼び出しなし）。そうでなければ親の items から
   * （PARENT_TTL_MS のあいだ覚える）。
   */
  async getSubagentState(threadId, agentId) {
    if (!validId(threadId) || !validId(agentId)) return null;
    const live = liveSubagents.get(agentId);
    const mine = live?.parent === threadId && live.status ? live : null;
    if (mine && (TERMINAL.has(mine.status) || nativeRpc.threads.has(threadId))) return subagentState(mine, agentId, false);
    const past = (await scanParent(threadId).catch(() => null))?.get(agentId);
    if (past?.status) return subagentState(past, agentId, true);
    return mine ? subagentState(mine, agentId, false) : null;
  },

  /**
   * server がターンの外の口を渡してくる（docs/multi-backend.md §2.7）。起動時に 1 回。
   * ここで全通知の見張りを張る。runTurn の attach / detach とは独立に生き続ける。
   */
  attachHost(h) {
    host = h;
    if (watching) return;
    watching = true;
    nativeRpc.onNotify(onWatchedNotification);
    // app-server が落ちた・入れ替わった。走っていた端末は道連れなので、数えたままにしない
    nativeRpc.onDown(() => {
      for (const [, w] of [...trackers]) {
        for (const id of w.tracker.commandIds()) host?.event?.(w.sessionId, { type: "task.command", id, state: "unknown" });
        if (w.tracker.clear()) host?.background?.(w.sessionId, []);
      }
      trackers.clear();
      syncReconcile();
    });
  },

  /**
   * 裏で動いている端末を 1 本止める（`running.background` の行から呼ぶ）。
   *
   * taskId は `background` の tasks の id、つまり `commandExecution` の itemId。
   * codex が求めるのは **processId**（数字の文字列）なので、見張りが覚えているものへ引き直す。
   * 止めた後は codex に聞き直して数え直す（`item/completed` を待たずに印を消すと、
   * 実際には生きている端末の印を落としうる）。
   */
  getBackgroundTask(sessionId, taskId) {
    return watchOf(sessionId)?.tracker.detail(taskId) ?? null;
  },

  async stopBackground(sessionId, taskId) {
    const w = watchOf(sessionId);
    const processId = w?.tracker.processIdOf(taskId) ?? null;
    if (!w) throw new Error(t("codex.errors.notWatching"));
    if (!processId) throw new Error(t("codex.errors.noProcessId"));

    const threadId = [...trackers].find(([, x]) => x === w)?.[0];
    let res;
    try {
      res = await nativeRpc.request(
        "thread/backgroundTerminals/terminate", { threadId, processId: String(processId) }, 30_000);
    } catch (err) {
      if (!noSuchMethod(err)) throw err;
      // 古い codex（0.147.0 で確認）はこの method を持たない。生のプロトコルエラーは見せず、直し方を言う
      throw new Error(t("codex.errors.cannotStopBackground"));
    }
    await reconcileAll().catch(() => {});
    return { stopped: res?.terminated !== false };
  },

  modes: () => Object.fromEntries(Object.entries(MODES).map(([id, m]) => [id, vocab(m)])),

  /**
   * model/list の id。`""`（既定に従う）を先頭に置く。
   * `""` には実際に使われるモデル（resolvesTo）とその efforts / defaultEffort を写す。
   * 実際に使われるのは config.toml の model（config/read）、無ければ model/list の isDefault（runTurn と同じ順）。
   */
  async models(cwd) {
    const list = await modelList();
    const config = await readConfig(cwd);
    const out = { ...list, "": { ...list[""] } };
    const configured = config?.model;
    const target = configured && out[configured] && configured !== "" ? configured : configured ? null : listDefault;
    const effort = config?.model_reasoning_effort;
    // 設定のエフォートはどのモデルにも効く（runTurn は config の値を先に見る）
    if (effort) for (const [id, m] of Object.entries(out)) if (id && m.efforts?.includes(effort)) out[id] = { ...m, defaultEffort: effort };
    if (target && out[target]) Object.assign(out[""], { resolvesTo: target, efforts: out[target].efforts, defaultEffort: out[target].defaultEffort });
    // 一覧に無いモデルを設定している。名前だけ出す（段は codex に任せる）
    else if (configured) Object.assign(out[""], { resolvedLabel: configured, note: t("codex.models.configured", { model: configured }) });
    return out;
  },

  // ---- 実行 ---------------------------------------------------------------

  async runTurn({ prompt, sessionId, hostSessionId, cwd, mode, model, effort, emit, onPromptDelivered, askPermission, signal, control, ephemeral = false, visualizeInstructions, browserEnv, browserInstructions, browserRuntime = null, contextRuntime, agentRuntime, computerRuntime = null, hooksRuntime = null, endpoint = null, locale, notes = [] }) {
    const rpc = contextRuntime ? await codexContextRpc(contextRuntime, cwd, nativeRpc).catch(e => { throw undelivered(e); }) : nativeRpc;
    // Hooks を Pleiad がそろえる会話。止める key はこのターンの直前に作り直す（起動の後に足された定義も、次のターンからは止まる）。
    // 作れなければターンを始めない（ネイティブと Pleiad の登録が二重に動くか、どちらも動かないため）
    let hooks = null;
    if (hooksRuntime) {
      try { hooks = await codexHooksConfig(hooksRuntime, rpc, cwd); }
      catch (e) { if (rpc !== nativeRpc) rpc.stop(); throw undelivered(e); }
    }
    const hooksKey = hooks?.key ?? '';
    // 互換の接続先（core/compat-endpoints.mjs）。スレッドごとに modelProvider と model_providers.<id> を渡す（app-server は共有のまま）。
    // 鍵は experimental_bearer_token / http_headers で JSON-RPC に載る（argv・環境に出ない）。エラー文からは伏せる
    const compat = endpoint ? codexCompatThread(endpoint) : null;
    if (compat && !model) model = endpoint.roles?.main || undefined;
    const hide = text => redactSecret(text, endpoint?.key);
    const m = MODES[mode] ?? MODES.ask;

    // 承認カードに中身を載せるために、見たアイテムを覚えておく。
    // fileChange の承認要求は itemId しか運ばない（スキーマで確認済み）。
    const items = new Map();       // itemId -> ThreadItem
    let thinkingOpen = false;
    let sawText = false;
    let turnId = null;
    let settleTurn = null;
    // 実行前の拒否を拾う rollout（thread.path）と、turn/start の直前の長さ（ここから後がこのターンの分）。ephemeral では持たない
    let rolloutPath = null;
    let rolloutFrom = null;
    // このターンで承認を求められたアイテム（call id）。拒否の approvalRequested に使う
    const asked = new Set();
    const finished = new Promise((resolve) => { settleTurn = resolve; });

    const openThinking = () => {
      if (thinkingOpen) return;
      thinkingOpen = true;
      emit({ type: "thinking.start" });
      emit({ type: "activity", state: "thinking" });
    };

    // 実行前の拒否（アイテムにならず、通知にも thread/read にも出ない。core/backends/codex-rejections.mjs）。
    // 会話の画面にはツールのエラーとして出し、tool.result の rejection に構造を載せる（server が委譲の結果に集める）。
    // 会話を開き直すと thread/read から作る履歴には残らない（docs/multi-backend.md「Codex の実行前の拒否」）
    const reportRejections = async () => {
      const found = await readTurnRejections({ file: rolloutPath, from: rolloutFrom, turnId, dataDir: store.dataDir });
      const ids = new Set();
      for (const [i, r] of found.entries()) {
        const rejection = { ...r, approvalRequested: Boolean(r.callId && asked.has(r.callId)) };
        let id = r.callId ?? `rejected-${turnId}-${i}`;
        if (ids.has(id) || items.has(id)) id = `${id}-rejected-${i}`;
        ids.add(id);
        emit({ type: "tool.start", id, name: "commandExecution", input: { command: r.command ?? "", cwd: null, rejected: true } });
        // i18n-dynamic: codex.rejected.
        const head = t(`codex.rejected.${r.kind}`, { reason: r.reason ?? "" });
        emit({ type: "tool.result", id, ...cut(`${head}${NL}${r.raw}`), isError: true, rejection });
      }
    };

    // 途中送信した outbox item の id。turn/steer に clientUserMessageId として預けると、
    // 会話に入った userMessage アイテムの clientId として返ってくる（最初のプロンプトの分は null）。
    // 受理（turn/steer の応答）と「走っているターンに入った」は別の瞬間なので、後者をここで拾う
    const steered = new Set();
    const noteDelivered = (item) => {
      if (item?.type !== "userMessage" || !item.clientId) return;
      if (!steered.delete(item.clientId)) return;   // 一度だけ（started と completed の両方が来る）
      emit({ type: "userMessage.delivered", messageId: item.clientId });
    };

    const meter = createCodexMeter();
    // 別プロセスの接続（contextRuntime）の通知は native の onNotify に来ない。サブエージェントの観測はここで足す
    const observe = rpc === nativeRpc ? () => {} : observeSubagents;
    const onNotification = (method, params) => {
      observe(method, params);
      if (isUserShell(params?.item) || (method === 'item/commandExecution/outputDelta' && userShellItems.has(params?.itemId))) return;
      for (const event of commandActivity(method, params)) emit(event);
      switch (method) {
        case 'thread/tokenUsage/updated':
          if (!turnId || (params.turnId && params.turnId !== turnId)) return;
          if (codexContextWindow(params.tokenUsage)) emit(codexContextWindow(params.tokenUsage));
          return emit({ type: 'usage', ...meter(params.tokenUsage) });
        case 'thread/compacted':
          return emit(codexCompactionEvent(method, params));
        // hooks の発火（会話の右パネルの「発火の記録」）。Pleiad が渡した定義は source: sessionFlags。
        // Hooks を Pleiad がそろえる会話で、止めたはずのユーザー・プロジェクトの定義が走ったら漏れとして記録する
        case 'hook/started':
        case 'hook/completed':
          return emit(codexHookRun(method, params, hooksRuntime));
        case "turn/started":
          turnId ??= params?.turn?.id ?? null;
          return;

        case "item/agentMessage/delta":
          if (!sawText) { sawText = true; emit({ type: "activity", state: "writing" }); }
          return emit({ type: "text.delta", text: String(params?.delta ?? "") });

        case "item/reasoning/summaryTextDelta":
        case "item/reasoning/textDelta":
          openThinking();
          return emit({ type: "thinking.delta", text: String(params?.delta ?? "") });

        case "item/started": {
          const item = params?.item;
          if (!item?.id) return;
          // 入力欄の `!` の結果はエージェントのツールではない。backend.shell が拾って shell.* で出す
          if (isUserShell(item)) return;
          if (item.type === 'contextCompaction') emit(codexCompactionEvent(method, params));
          items.set(item.id, item);
          noteDelivered(item);
          if (!TOOL_ITEMS.has(item.type)) return;
          emit({ type: "activity", state: "running", label: t("activity.tool", { label: TOOL_HINTS[item.type]?.label ?? item.type }) });
          return emit({ type: "tool.start", id: item.id, name: toolName(item), input: toolInput(item),
            turnId: params.turnId, startedAt: params.startedAtMs, processId: item.processId });
        }

        // 差分が後から確定することがある。承認カードに載せるので覚え直す
        case "item/fileChange/patchUpdated": {
          const known = params?.itemId ? items.get(params.itemId) : null;
          if (known) items.set(params.itemId, { ...known, changes: params.changes ?? known.changes });
          return;
        }

        case "item/completed": {
          const item = params?.item;
          if (!item?.id) return;
          if (isUserShell(item)) return;
          if (item.type === 'contextCompaction') emit(codexCompactionEvent(method, params));
          const started = items.has(item.id);
          // 終わったターンのアイテムが遅れて届くことがある（バックグラウンド端末。turnId は昔のまま）。
          // このターンのカードにはしない。結果は見張り（codex-background.mjs）が会話へ出す
          if (!started && turnId && params?.turnId && params.turnId !== turnId) return;
          items.set(item.id, item);
          // item/started を取りこぼしたときの保険。届いていれば steered から消えていて何もしない
          noteDelivered(item);
          if (item.type === "reasoning" && thinkingOpen) thinkingOpen = false;
          if (!TOOL_ITEMS.has(item.type)) return;
          if (!started) emit({ type: "tool.start", id: item.id, name: toolName(item), input: toolInput(item),
            turnId: params.turnId, startedAt: params.startedAtMs, processId: item.processId });
          const r = toolResult(item);
          return emit({ type: "tool.result", id: item.id, commandCompleted: item.type === "commandExecution", ...r });
        }

        case "turn/completed": {
          const status = params?.turn?.status ?? "completed";
          const err = params?.turn?.error;
          if (sawText) emit({ type: "text.end" });
          const result =
            status === "interrupted" ? { type: "turnResult", outcome: "aborted", turns: 1 }
            : status === "failed" ? {
                type: "turnResult", outcome: "error", turns: 1,
                error: hide(String(err?.message ?? err?.type ?? t("codex.errors.failed"))),
              }
            // costUsd は app-server が出さない（token 数だけ）。turns だけ載せる
            : { type: "turnResult", outcome: "ok", turns: 1 };
          // 実行前に拒否されたコマンドを rollout から拾ってから、ターンを閉じる（拾えなくても結果は変えない）
          return void reportRejections().finally(() => { emit(result); settleTurn?.(); });
        }

        case "error": {
          // codex が再試行するなら畳まない（turn/completed がこの後に来る）。
          // 再試行しないときは turn/completed が来ないので、ここでターンを終える。
          if (params?.willRetry) return;
          emit({
            type: "turnResult", outcome: "error",
            error: hide(String(params?.error?.message ?? t("codex.errors.errorReturned"))),
          });
          return settleTurn?.();
        }

        default:
          return;
      }
    };

    // サブエージェント（子スレッド）の通知。codex-rpc が親の会話へ回してくる。
    // **本文やツールとしては出さない**（出すと親の発言・ツールに混ざる。子の中身は子のスレッドにある）。
    // 子の承認カードに中身を載せるために、進行中のアイテムだけ覚えて、終わったら忘れる
    const childItems = new Map();   // `${threadId} ${itemId}` -> ThreadItem
    const childKey = (child, itemId) => `${child?.threadId} ${itemId}`;
    const onChildNotification = (method, params, child) => {
      observe(method, params);
      const item = params?.item;
      if (method === "item/started" && item?.id) childItems.set(childKey(child, item.id), item);
      else if (method === "item/completed" && item?.id) childItems.delete(childKey(child, item.id));
      else if (method === "item/fileChange/patchUpdated" && params?.itemId) {
        const known = childItems.get(childKey(child, params.itemId));
        if (known) childItems.set(childKey(child, params.itemId), { ...known, changes: params.changes ?? known.changes });
      }
    };

    // child は子スレッドから来た要求のときだけ入る（{ threadId, nickname?, path?, role? }）。
    // 承認は親の会話（sessionId = 親の threadId）に出し、どの子の要求かを title に添える
    const onRequest = async (method, params, child = null) => {
      if (typeof askPermission !== "function") throw new Error(t("codex.errors.noApprover"));
      const title = child ? subagentLabel(child) : null;

      if (method === "item/tool/requestUserInput") {
        emit({ type: "activity", state: "waiting", label: t("activity.waitingAnswer") });
        const questions = params?.questions ?? [];
        const answer = await askPermission({
          toolName: "requestUserInput",
          input: {},
          sessionId: threadId,
          toolUseID: params?.itemId ?? null,
          title,
          signal: signal?.signal,
          canAlways: false,
          kind: "question",
          questions: toQuestions(questions),
        });
        return toUserInputResponse(questions, answer?.answers);
      }

      if (method === "mcpServer/elicitation/request") {
        // MCP サーバからの問い合わせ。v3 では扱わない（承認カードに出しても答えの形が違う）
        return { action: "decline" };
      }

      emit({ type: "activity", state: "waiting", label: t("activity.waitingApproval") });
      if (!child && params?.itemId) asked.add(String(params.itemId));
      const item = !params?.itemId ? null
        : child ? childItems.get(childKey(child, params.itemId)) : items.get(params.itemId);
      const toolName =
        method === "item/commandExecution/requestApproval" ? "commandExecution"
        : method === "item/fileChange/requestApproval" ? "fileChange"
        : "permissions";

      // 承認要求そのものが運ぶ情報は薄い（fileChange は itemId だけ）。
      // item/started で見たものを足して、何を許すのかが読める形にする。
      const input = {
        ...(item ? toolInput(item) : {}),
        ...(params?.command ? { command: params.command } : {}),
        ...(params?.cwd ? { cwd: params.cwd } : {}),
        ...(params?.reason ? { reason: params.reason } : {}),
        ...(params?.permissions ? { permissions: params.permissions } : {}),
      };

      const answer = await askPermission({
        toolName,
        input,
        sessionId: threadId,
        toolUseID: params?.itemId ?? null,
        title,
        signal: signal?.signal,
        canAlways: true,
        kind: "tool",
        questions: null,
      });
      return approvalResponse(method, params, answer);
    };

    const onGone = (err) => {
      emit({ type: "turnResult", outcome: "error", error: String(err?.message ?? err) });
      settleTurn?.();
    };

    const handlers = { onNotification, onRequest, onChildNotification, onGone };

    // thread/start の応答が返る前に通知が来ても落とさないよう、先に受け皿を張る。
    // 受け皿は見知らぬ threadId の frame を預かるだけで、渡すのは adopt で id が一致したものだけ
    let threadId = sessionId ?? null;
    let detach = threadId ? rpc.attach(threadId, handlers) : rpc.claimOrphan(handlers);
    let promptSent = false;

    try {
      if (browserEnv && m.sandbox === 'read-only') {
        browserInstructions = agentT(locale, 'browser.readonlyInstructions');
      }
      const computerInstructions = computerPrompt(computerRuntime, { locale, agent: 'codex' });
      const common = {
        cwd,
        config: {
          // Clear the retired built-in connection on already-loaded threads too.
          'mcp_servers.ply': { command: process.execPath, enabled: false, required: false },
          ...(agentRuntime ? { 'mcp_servers.ply_agents': { url: agentRuntime.url, http_headers: agentRuntime.headers, enabled: true, required: true, default_tools_approval_mode: 'approve', startup_timeout_sec: 20, tool_timeout_sec: 60 } } : {}),
          // 内蔵ブラウザーのプロフィールの一覧と切り替え（core/browser-profiles.mjs。ADR 0078）
          ...(browserRuntime ? { [`mcp_servers.${BROWSER_SERVER}`]: { url: browserRuntime.url, http_headers: browserRuntime.headers, enabled: true, required: false, default_tools_approval_mode: 'approve', startup_timeout_sec: 20, tool_timeout_sec: 60 } } : {}),
            // The context bridge applies the selected mode to external tool calls.
            ...(contextRuntime ? { 'mcp_servers.ply_context': { url: contextRuntime.url, http_headers: contextRuntime.headers, enabled: true, required: true, default_tools_approval_mode: 'approve', startup_timeout_sec: 20 } } : {}),
          // コンピューターの操作（ply_computer）と、同梱の computer use を切る上書き。渡さない会話には何も足さない（利用者の ~/.codex に任せる）
          ...codexComputerConfig(computerRuntime),
          ...(compat ? compat.config : {}),
          ...(browserEnv ? { 'shell_environment_policy.set': {
            AGENT_BROWSER_CONFIG: browserEnv.AGENT_BROWSER_CONFIG,
            AGENT_BROWSER_SESSION: browserEnv.AGENT_BROWSER_SESSION,
            AGENT_BROWSER_SOCKET_DIR: browserEnv.AGENT_BROWSER_SOCKET_DIR,
            AGENT_BROWSER_NAMESPACE: browserEnv.AGENT_BROWSER_NAMESPACE,
          } } : {}),
          ...(hooks ? { hooks: hooks.config } : {}),
        },
        ...(compat ? { modelProvider: compat.modelProvider } : {}),
        ...((visualizeInstructions || browserInstructions || contextRuntime?.prompt || agentRuntime?.instructions || computerInstructions) ? { developerInstructions: [contextRuntime?.prompt, visualizeInstructions, browserInstructions, agentRuntime?.instructions, computerInstructions].filter(Boolean).join('\n\n') } : {}),
        approvalPolicy: m.approvalPolicy,
        sandbox: m.sandbox,
        ...(model ? { model } : {}),
      };

      let effectiveSandbox;
      const providerKey = compat ? compat.modelProvider : 'default';
      // 指示と ply_computer の接続先。どちらかが変わったロード済みのスレッドは外して読み直す（resume は config の変更を黙って無視する）
      const instructionsKey = (common.developerInstructions ?? '') + (computerRuntime ? `\0${computerRuntime.url} ${computerRuntime.headers?.Authorization ?? ''}` : '')
        + (browserRuntime ? `\0${browserRuntime.url} ${browserRuntime.headers?.Authorization ?? ''}` : '');
      if (threadId) {
        // 接続先が変わった（互換 ↔ 公式、別の互換、キーや URL の変更）ロード済みのスレッドは、いったん外してから読み直す。
        // 外さずに resume すると前の接続先のまま走る（スパイクで確認）
        const known = rpc === nativeRpc ? loadedProvider.get(threadId) : undefined;
        const instructionsChanged = rpc === nativeRpc && loadedInstructions.has(threadId) && loadedInstructions.get(threadId) !== instructionsKey;
        // hooks は追跡していないロード済みのスレッド（圧縮・分岐でロードされたもの）も外す（unloadForHooks と同じ判断）
        const hooksChanged = rpc === nativeRpc && (loadedHooks.has(threadId) ? loadedHooks.get(threadId) !== hooksKey : hooksKey !== '');
        if ((known !== undefined && (known !== providerKey || instructionsChanged)) || hooksChanged) {
          const out = await rpc.request('thread/unsubscribe', { threadId }).catch(e => ({ error: e }));
          const unloaded = !out?.error && ['unsubscribed', 'notLoaded', 'notSubscribed'].includes(out?.status);
          // 接続先が変わったのに外せなかったら、この後の resume は接続先の変更を黙って無視する。前の接続先へ送らないよう、ここで止める。
          // 指示だけが変わったときは止めない（前の指示のまま続け、次のターンでもう一度外す）
          if (!unloaded && known !== undefined && known !== providerKey) {
            throw new Error(t("codex.errors.unsubscribeFailed", { reason: out?.error?.message ?? out?.status ?? t("codex.errors.noResponse") }));
          }
          // hooks の渡し方が変わったのに外せなかったら、この後の resume は hooks の config を黙って無視する。ターンを始めない
          if (!unloaded && hooksChanged) {
            throw new Error(t("codex.errors.hooksUnsubscribeFailed", { reason: out?.error?.message ?? out?.status ?? t("codex.errors.noResponse") }));
          }
          if (unloaded) { loadedProvider.delete(threadId); loadedInstructions.delete(threadId); loadedHooks.delete(threadId); }
        }
        // 互換から公式へ戻すときは公式の provider を明示する（スレッドに記録された互換の provider を使わせない）
        const back = !compat && known !== undefined && known !== 'default' ? { modelProvider: await defaultProvider(rpc, cwd) } : {};
        const resumed = await rpc.request("thread/resume", { threadId, ...common, ...back });
        // 実際に効いた接続先を確かめる。違えばターンを始めない（互換の会話が公式へ、公式へ戻した会話が互換の先へ送られるのを防ぐ）
        const expected = compat ? compat.modelProvider : back.modelProvider;
        if (expected && typeof resumed?.modelProvider === 'string' && resumed.modelProvider !== expected) {
          // 実際にロードされている接続先を覚えておく（次の送信でもう一度外してから読み直す）
          if (rpc === nativeRpc) loadedProvider.set(threadId, resumed.modelProvider.startsWith('ply_') ? resumed.modelProvider : 'default');
          throw new Error(t("codex.errors.stillOldEndpoint"));
        }
        effectiveSandbox = resumed?.sandbox;
        if (!ephemeral) rolloutPath = rolloutPathOf(resumed);
        if (rpc === nativeRpc && !ephemeral) { loadedProvider.set(threadId, providerKey); loadedInstructions.set(threadId, instructionsKey); loadedHooks.set(threadId, hooksKey); }
      } else {
        const started = await rpc.request("thread/start", { ...common, ...(ephemeral ? { ephemeral: true } : {}) });
        effectiveSandbox = started?.sandbox;
        if (!ephemeral) rolloutPath = rolloutPathOf(started);
        threadId = started?.thread?.id ?? null;
        if (!threadId) throw new Error(t("codex.errors.noThreadId", { method: "thread/start" }));
        if (rpc === nativeRpc && !ephemeral) { loadedProvider.set(threadId, providerKey); loadedInstructions.set(threadId, instructionsKey); loadedHooks.set(threadId, hooksKey); }
        // 受け皿を取り下げる前に attach する。逆にすると、預かっていた自分の通知が捨てられる
        detach = rpc.adopt(threadId, handlers);
        // **これを出さないと web が id を受け取れない**（P1 §5.1）。turn/start より前に出す。
        // `first: true` は「id が確定した最初の1本」の印で、web の isMine はこれだけを見て
        // 新規 id を採用する。再開ターンでは session を出さない（出すと別タブを奪う）。
        // sessionId が null の session は絶対に出さない（sidecar に "null" 行が生える）。
        emit({
          type: "session", sessionId: threadId, first: true,
          ...(started.model ? { model: started.model } : {}),
        });
      }

      // ターンの外でも生き続ける端末を見張る（issue #6）。
      // contextRuntime のターンはターンの終わりに app-server ごと落とす（端末も道連れ）。
      // ephemeral（タイトル生成）はそもそも会話ではないので数えない
      if (!contextRuntime && !ephemeral) watchThread(threadId, hostSessionId ?? threadId);
      if (computerRuntime) checkBundledComputerUse(rpc, threadId);

      if (control) control.handle = { threadId, get turnId() { return turnId; } };

      // 中断は turn/interrupt。turnId が決まる前に来たら、決まってから投げる
      const interrupt = () => {
        if (!turnId) return;
        rpc.request("turn/interrupt", { threadId, turnId }).catch(() => {});
      };
      if (signal?.signal?.aborted) interrupt();
      else signal?.signal?.addEventListener?.("abort", interrupt, { once: true });

      // Loaded threads retain overrides. Resolve the native default explicitly on reset.
      let effectiveEffort = effort;
      // 互換の接続先の既定の段は分からない（公式の model/list・config の段を持ち込まない）。'' なら段を送らない
      if (effort === '' && !compat) {
        const { config } = await rpc.request('config/read', { cwd, includeLayers: false });
        const models = await backend.models();
        const selected = models[model || config?.model] ?? models[''];
        effectiveEffort = config?.model_reasoning_effort ?? selected?.defaultEffort;
      }
      emit({ type: "activity", state: "thinking" });
      rolloutFrom = await rolloutSize(rolloutPath);
      // ここから先の失敗は、プロンプトが渡ったかどうか分からない（応答だけ失われた場合がある）
      promptSent = true;
      const res = await rpc.request("turn/start", {
        threadId,
        cwd,
        // ロード済み thread の resume だけに設定更新を任せない。
        // 毎ターン指定し、auto/full への変更も ask への復帰も確実に適用する。
        approvalPolicy: m.approvalPolicy,
        sandboxPolicy: sandboxForTurn(m, effectiveSandbox),
        ...(effectiveEffort ? { effort: effectiveEffort } : {}),
        // 中断の後に Pleiad が添える文（core/interrupt-stops.mjs）は、人の発言とは別の入力にして前に置く（本文は書き換えない）
        input: [...notes, String(prompt ?? "")].map(text => ({ type: "text", text })),
      });
      turnId ??= res?.turn?.id ?? null;
      onPromptDelivered?.();
      // 「渡った」合図（userMessage.delivered）を後から出せる。server は渡るまでを pending として画面に出す
      if (control) control.steerConfirms = true;
      if (control) control.steer = async (item) => {
        if (!turnId || signal?.signal?.aborted) return false;
        const messageId = item?.id ?? null;
        if (messageId) steered.add(messageId);
        try {
          await rpc.request("turn/steer", {
            threadId, expectedTurnId: turnId,
            // 預けた id は userMessage アイテムの clientId として返ってくる。どれが入ったかの照合に使う
            ...(messageId ? { clientUserMessageId: String(messageId) } : {}),
            input: [{ type: "text", text: String(item?.args?.prompt ?? "") }],
          }, 15000);
        } catch (e) {
          if (messageId) steered.delete(messageId);
          // Explicit protocol rejection means no input was accepted. Transport
          // failures are ambiguous and must not be automatically re-delivered.
          if ([-32600, -32601, -32602].includes(e.code)) return false;
          throw e;
        }
        return true;
      };
      control?.onReady?.();
      // turn/start の応答が返る前に abort されていた分をここで拾う
      if (signal?.signal?.aborted) interrupt();

      await finished;
    } catch (err) {
      // 中断は「失敗」ではない。throw すると server が reply を二重に送る（P1 §5.1）
      if (signal?.signal?.aborted) {
        emit({ type: "turnResult", outcome: "aborted" });
        return { sessionId: threadId };
      }
      emit({ type: "turnResult", outcome: "error", error: hide(String(err?.message ?? err)) });
      const thrown = endpoint?.key && String(err?.message ?? '').includes(endpoint.key) ? new Error(hide(err.message)) : err;
      throw promptSent ? thrown : undelivered(thrown);
    } finally {
      detach();
      // turn/completed が来ない終わり方（error 通知・中断）でも、走ったままの端末を裏へ回す
      if (!contextRuntime && !ephemeral) endTurn(threadId);
      if (ephemeral && threadId) await rpc.request("thread/unsubscribe", { threadId }).catch(() => {});
      if (control) { control.handle = null; control.steer = null; control.steerConfirms = false; }
      if (rpc !== nativeRpc) rpc.stop();
    }

    return { sessionId: threadId };
  },

  /**
   * 入力欄の `!`（ADR 0054）。app-server の thread/shellCommand { threadId, command, timeoutMs }（応答は {}。
   * codex-cli 0.156.1 の generate-json-schema で確認。サンドボックスの外・全権限で走る）。
   * 結果は commandExecution（source: userShell）の item/started → item/commandExecution/outputDelta → item/completed で流れる。
   * スレッドがこの app-server に読み込まれていなければ読み込み、終わったら外す（次のターンが自分の設定で読み込めるように）。
   * 止めるのは turn/interrupt（item の turnId）。止まった合図が 5 秒来なければ待つのをやめる
   */
  async shell({ sessionId: threadId, command, timeoutMs, signal, onOutput = () => {} }) {
    if (!validId(threadId)) throw new Error(t("codex.errors.shellNotStarted"));
    const loadedHere = !loadedProvider.has(threadId) && !nativeRpc.threads.has(threadId);
    let itemId = null, turnId = null, finished = null, output = "", stopped = false, settle;
    const done = new Promise((resolve) => { settle = resolve; });
    const off = nativeRpc.onNotify((method, params) => {
      if (params?.threadId !== threadId) return;
      const item = params?.item;
      if (method === "item/started" && isUserShell(item) && !itemId) {
        itemId = item.id; turnId = params.turnId ?? null; userShellItems.add(itemId);
        if (signal?.aborted) stop();
      } else if (method === "item/commandExecution/outputDelta" && itemId && params.itemId === itemId) {
        const delta = String(params.delta ?? "");
        output += delta;
        onOutput("stdout", delta);
      } else if (method === "item/completed" && isUserShell(item) && (!itemId || item.id === itemId)) {
        // 包んだターンが閉じてから終える。閉じる前に次の turn/start が来ると、Codex はその発言を `!` のターンに入れて返答しない
        finished = item;
        if (!turnId) settle({ item }); else setTimeout(() => settle({ item }), 2000).unref?.();
      } else if (method === "turn/completed" && turnId && params?.turn?.id === turnId) {
        if (finished) settle({ item: finished }); else setTimeout(() => settle({}), 500);
      }
    });
    const stop = () => {
      stopped = true;
      if (turnId) nativeRpc.request("turn/interrupt", { threadId, turnId }).catch(() => {});
      setTimeout(() => settle({}), 5000).unref?.();
    };
    signal?.addEventListener?.("abort", stop, { once: true });
    // 上限は codex にも渡す。合図が来ないときの保険に、少し長く待ってからやめる
    const guard = setTimeout(() => settle({ timedOut: true }), timeoutMs + 30_000);
    const started = Date.now();
    try {
      if (loadedHere) await nativeRpc.request("thread/resume", { threadId });
      await nativeRpc.request("thread/shellCommand", { threadId, command, timeoutMs });
      const { item, timedOut } = await done;
      // 止めた分は exitCode -1 と "command aborted by user" で閉じる。終了コードにせず「止めました」とそれまでの出力にする
      const aborted = userShellAborted(item) || (stopped && item?.exitCode === -1);
      const text = item?.aggregatedOutput != null && !aborted ? String(item.aggregatedOutput) : output;
      return { exitCode: Number.isInteger(item?.exitCode) && !aborted ? item.exitCode : null, output: text,
        durationMs: Number.isFinite(item?.durationMs) && !aborted ? item.durationMs : Date.now() - started,
        stopped: aborted || (stopped && !Number.isInteger(item?.exitCode)), timedOut: Boolean(timedOut) };
    } finally {
      clearTimeout(guard);
      off();
      if (itemId) userShellItems.delete(itemId);
      signal?.removeEventListener?.("abort", stop);
      if (loadedHere && !nativeRpc.threads.has(threadId)) await nativeRpc.request("thread/unsubscribe", { threadId }).catch(() => {});
    }
  },

  // locale は会話の言語。タイトルもその言語で作らせる
  async suggestTitle({ transcript, endpoint = null, locale }) {
    // 会話やネイティブの設定が大きいモデル・段でも、軽いものを選ぶ（一覧に無いモデルを名指しすると落ちる）。
    // 互換の接続先の会話は、その接続先の既定のモデルで段を送らずに作る（公式の model/list は互換の先のモデルを知らない）
    const pick = endpoint ? { model: endpoint.roles?.main || undefined, effort: '' } : titleModel(await backend.models(os.tmpdir()));
    const signal = new AbortController();
    const timer = setTimeout(() => signal.abort(), 90_000);
    let text = "", error = null;
    try {
      await backend.runTurn({
        prompt: agentT(locale, 'title.codex') + NL + NL + transcript,
        cwd: os.tmpdir(), mode: "readonly", model: pick.model, effort: pick.effort, ephemeral: true, signal, endpoint,
        askPermission: async () => ({ allow: false }),
        emit: (ev) => {
          if (ev.type === "text.delta") text += ev.text;
          if (ev.type === "turnResult" && ev.outcome !== "ok") error = ev.error || t("codex.errors.titleAborted");
        },
      });
      if (error) throw new Error(error);
      return text;
    } finally { clearTimeout(timer); }
  },

  // ---- セッション管理 -----------------------------------------------------

  async listSessions({ limit = 100 } = {}) {
    const res = await rpc.request("thread/list", { limit, sortDirection: "desc" });
    return (res?.data ?? []).map(toRow).filter(Boolean);
  },

  async getSession(sessionId) {
    if (!sessionId) return null;
    try {
      const res = await rpc.request("thread/read", { threadId: sessionId });
      return toRow(res?.thread);
    } catch {
      return null;
    }
  },

  async getMessages(sessionId, options) {
    if (!sessionId) return [];
    const res = await rpc.request("thread/read", { threadId: sessionId, includeTurns: true });
    if (!res?.thread) throw new Error(t("codex.errors.historyUnreadable"));
    return threadToMessages(res?.thread, options);
  },

  async getCompactions(sessionId) {
    const res = await nativeRpc.request('thread/read', { threadId: sessionId, includeTurns: true }, 30_000);
    return (res?.thread?.turns ?? []).flatMap(turn => (turn.items ?? [])
      .filter(item => item.type === 'contextCompaction')
      .map(item => ({ id: `native:${item.id}`, nativeId: item.id, turnId: turn.id ?? null, phase: 'complete', trigger: 'auto',
        at: Number(turn.completedAt ?? turn.startedAt ?? res.thread.updatedAt) * 1000 })));
  },

  async setTitle(sessionId, title) {
    await rpc.request("thread/name/set", { threadId: sessionId, name: String(title ?? "") });
  },

  async fork(sessionId, { upToMessageId } = {}) {
    // upToMessageId は使えない。codex の分岐点は turn 単位（lastTurnId）で、
    // web が渡すのはメッセージ id なので、そのまま渡すと別のところで切れる。
    // 黙って末尾から分けると「途中から分けた」つもりの枝に後ろの発言が残るので断る
    if (upToMessageId) throw new Error(t("codex.errors.forkMidway"));
    const res = await rpc.request("thread/fork", { threadId: sessionId });
    const child = res?.thread?.id;
    if (!child) throw new Error(t("codex.errors.noThreadId", { method: "thread/fork" }));
    return { sessionId: child };
  },

  // ---- 認証 ---------------------------------------------------------------

  auth: {
    async status() {
      const res = await rpc.request("account/read", {}, 30_000).catch((err) => {
        throw new Error(t("codex.errors.authReadFailed", { message: String(err?.message ?? err) }));
      });
      const a = res?.account ?? null;
      if (!a) return { loggedIn: false, account: null, detail: t("codex.auth.notLoggedIn") };
      const account = a.type === "chatgpt" ? (a.email || "ChatGPT") : a.type;
      const detail = a.type === "chatgpt" ? `ChatGPT / ${a.planType ?? "?"}` : a.type;
      return { loggedIn: true, account, detail };
    },

    /**
     * ChatGPT のログイン。authUrl を出したうえで、完了通知が来るまで待つ。
     * `account/login/completed` は **threadId を持たない**ので、
     * スレッドへの振り分けではなく rpc.onNotify（全通知の聞き手）で拾う。
     */
    async login({ emit }) {
      const res = await rpc.request("account/login/start", { type: "chatgpt" }, 60_000);
      const url = res?.authUrl ?? res?.verificationUrl ?? null;
      const loginId = res?.loginId ?? null;

      if (!url) {
        // apiKey など、URL を出さずに終わる型。すでに終わっている
        forgetModels();
        emit?.({ type: "auth", phase: "done", message: t("codex.auth.loggedIn") });
        return;
      }
      emit?.({ type: "auth", phase: "url", url, message: t("codex.auth.openBrowser") });

      await new Promise((resolve) => {
        const off = rpc.onNotify((method, params) => {
          if (method !== "account/login/completed") return;
          if (loginId && params?.loginId && params.loginId !== loginId) return;
          off();
          // 使えるモデルはアカウントで変わる。「ログインした」を受けた画面が引き直す前に捨てる
          if (params?.success) { forgetModels(); emit?.({ type: "auth", phase: "done", message: t("codex.auth.loggedIn") }); }
          else emit?.({ type: "auth", phase: "error", message: String(params?.error ?? t("codex.auth.loginFailed")) });
          resolve();
        });
      });
    },

    async logout() {
      try { await rpc.request("account/logout", {}); }
      finally { forgetModels(); }
    },
  },
};

export { MODES, TOOL_HINTS };
