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
import { createTerminalTracker } from "./codex-background.mjs";
import { codexContextRpc } from './context-options.mjs';
import { codexCompatThread, redactSecret } from '../compat-endpoints.mjs';
import { MAX_RESULT_CHARS } from "./shared.mjs";
import { t, agentT } from "../i18n.mjs";

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

/** ThreadItem -> tool.start の input。何をしようとしているかが1行で分かる形にする。 */
function toolInput(item) {
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
nativeRpc.onDown(() => loadedProvider.clear());
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
        const text = (item.content ?? [])
          .filter((c) => c?.type === "text" && typeof c.text === "string")
          .map((c) => c.text).join("");
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

      if (TOOL_ITEMS.has(item?.type)) {
        const r = toolResult(item);
        toolCalls.push({
          id: item.id ?? null,
          name: item.type,
          input: toolInput(item),
          // 進行中のまま残っているアイテムは結果を持たない
          result: item.status === "inProgress" ? null : { ...r, text: fullResults ? JSON.stringify(item) : r.text, truncated: fullResults ? false : r.truncated },
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
    title: t.name || (t.preview ? String(t.preview).slice(0, 80) : null) || null,
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
  host?.background?.(w.sessionId, w.tracker.list());
  syncReconcile();
};

/** 裏で終わった端末の結果を、終わったターンのツールカードへ差し込む。 */
const reportFinished = (w, item) =>
  host?.event?.(w.sessionId, { type: "tool.result", id: item.id, ...toolResult(item) });

function onWatchedNotification(method, params) {
  const threadId = params?.threadId;
  const w = threadId ? trackers.get(threadId) : null;
  if (!w) return;
  const { changed, finished } = w.tracker.observe(method, params);
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
    const { changed, understood } = w.tracker.reconcile(entries);
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

export const backend = {
  async usage() { return codexQuota(await rpc.request('account/rateLimits/read', {}, 15_000)); },
  id: "codex",
  label: "OpenAI Codex",
  get description() { return t("codex.description"); },

  capabilities: {
    title: true,        // thread/name/set。公式クライアントとタイトルを共有できる
    tag: false,         // 状態タグは持てない -> sidecar が正本
    fork: true,
    subagents: true,    // 子スレッド。thread/list { parentThreadId } と thread/read で読む
    liveModel: false,   // 走っている最中の切り替えは app-server に口が無い
    liveMode: false,
    hostTools: false,   // set_status / set_title / fork は未接続。可視化は共通の参照形式で提供
    alwaysAllow: true,  // acceptForSession
    login: true,
    // 互換の接続先（OpenAI Responses 互換）を会話ごとに選べる（core/compat-endpoints.mjs）
    compatEndpoints: true,
  },

  toolHints: TOOL_HINTS,
  subagentTools: SUBAGENT_ITEMS,

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
      for (const [, w] of [...trackers]) if (w.tracker.clear()) host?.background?.(w.sessionId, []);
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

  async runTurn({ prompt, sessionId, hostSessionId, cwd, mode, model, effort, emit, askPermission, signal, control, ephemeral = false, visualizeInstructions, contextRuntime, agentRuntime, endpoint = null }) {
    const rpc = contextRuntime ? await codexContextRpc(contextRuntime, cwd, nativeRpc) : nativeRpc;
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
    const finished = new Promise((resolve) => { settleTurn = resolve; });

    const openThinking = () => {
      if (thinkingOpen) return;
      thinkingOpen = true;
      emit({ type: "thinking.start" });
      emit({ type: "activity", state: "thinking" });
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
      switch (method) {
        case 'thread/tokenUsage/updated':
          if (!turnId || (params.turnId && params.turnId !== turnId)) return;
          return emit({ type: 'usage', ...meter(params.tokenUsage) });
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
          items.set(item.id, item);
          noteDelivered(item);
          if (!TOOL_ITEMS.has(item.type)) return;
          emit({ type: "activity", state: "running", label: t("activity.tool", { label: TOOL_HINTS[item.type]?.label ?? item.type }) });
          return emit({ type: "tool.start", id: item.id, name: item.type, input: toolInput(item) });
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
          const started = items.has(item.id);
          // 終わったターンのアイテムが遅れて届くことがある（バックグラウンド端末。turnId は昔のまま）。
          // このターンのカードにはしない。結果は見張り（codex-background.mjs）が会話へ出す
          if (!started && turnId && params?.turnId && params.turnId !== turnId) return;
          items.set(item.id, item);
          // item/started を取りこぼしたときの保険。届いていれば steered から消えていて何もしない
          noteDelivered(item);
          if (item.type === "reasoning" && thinkingOpen) thinkingOpen = false;
          if (!TOOL_ITEMS.has(item.type)) return;
          if (!started) emit({ type: "tool.start", id: item.id, name: item.type, input: toolInput(item) });
          const r = toolResult(item);
          return emit({ type: "tool.result", id: item.id, ...r });
        }

        case "turn/completed": {
          const status = params?.turn?.status ?? "completed";
          const err = params?.turn?.error;
          if (sawText) emit({ type: "text.end" });
          emit(
            status === "interrupted" ? { type: "turnResult", outcome: "aborted", turns: 1 }
            : status === "failed" ? {
                type: "turnResult", outcome: "error", turns: 1,
                error: hide(String(err?.message ?? err?.type ?? t("codex.errors.failed"))),
              }
            // costUsd は app-server が出さない（token 数だけ）。turns だけ載せる
            : { type: "turnResult", outcome: "ok", turns: 1 },
          );
          return settleTurn?.();
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

    try {
      const common = {
        cwd,
        config: {
          // Clear the retired built-in connection on already-loaded threads too.
          'mcp_servers.ply': { command: process.execPath, enabled: false, required: false },
          ...(agentRuntime ? { 'mcp_servers.ply_agents': { url: agentRuntime.url, http_headers: agentRuntime.headers, enabled: true, required: true, default_tools_approval_mode: 'approve', startup_timeout_sec: 20, tool_timeout_sec: 60 } } : {}),
            // The context bridge applies the selected mode to external tool calls.
            ...(contextRuntime ? { 'mcp_servers.ply_context': { url: contextRuntime.url, http_headers: contextRuntime.headers, enabled: true, required: true, default_tools_approval_mode: 'approve', startup_timeout_sec: 20 } } : {}),
          ...(compat ? compat.config : {}),
        },
        ...(compat ? { modelProvider: compat.modelProvider } : {}),
        ...((visualizeInstructions || contextRuntime?.prompt || agentRuntime?.instructions) ? { developerInstructions: [contextRuntime?.prompt, visualizeInstructions, agentRuntime?.instructions].filter(Boolean).join('\n\n') } : {}),
        approvalPolicy: m.approvalPolicy,
        sandbox: m.sandbox,
        ...(model ? { model } : {}),
      };

      let effectiveSandbox;
      const providerKey = compat ? compat.modelProvider : 'default';
      if (threadId) {
        // 接続先が変わった（互換 ↔ 公式、別の互換、キーや URL の変更）ロード済みのスレッドは、いったん外してから読み直す。
        // 外さずに resume すると前の接続先のまま走る（スパイクで確認）
        const known = rpc === nativeRpc ? loadedProvider.get(threadId) : undefined;
        if (known !== undefined && known !== providerKey) {
          // 外せなかったら、この後の resume は接続先の変更を黙って無視する。前の接続先へ送らないよう、ここで止める
          const out = await rpc.request('thread/unsubscribe', { threadId }).catch(e => ({ error: e }));
          if (out?.error || !['unsubscribed', 'notLoaded', 'notSubscribed'].includes(out?.status)) {
            throw new Error(t("codex.errors.unsubscribeFailed", { reason: out?.error?.message ?? out?.status ?? t("codex.errors.noResponse") }));
          }
          loadedProvider.delete(threadId);
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
        if (rpc === nativeRpc && !ephemeral) loadedProvider.set(threadId, providerKey);
      } else {
        const started = await rpc.request("thread/start", { ...common, ...(ephemeral ? { ephemeral: true } : {}) });
        effectiveSandbox = started?.sandbox;
        threadId = started?.thread?.id ?? null;
        if (!threadId) throw new Error(t("codex.errors.noThreadId", { method: "thread/start" }));
        if (rpc === nativeRpc && !ephemeral) loadedProvider.set(threadId, providerKey);
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
      const res = await rpc.request("turn/start", {
        threadId,
        cwd,
        // ロード済み thread の resume だけに設定更新を任せない。
        // 毎ターン指定し、auto/full への変更も ask への復帰も確実に適用する。
        approvalPolicy: m.approvalPolicy,
        sandboxPolicy: sandboxForTurn(m, effectiveSandbox),
        ...(effectiveEffort ? { effort: effectiveEffort } : {}),
        input: [{ type: "text", text: String(prompt ?? "") }],
      });
      turnId ??= res?.turn?.id ?? null;
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
      if (endpoint?.key && String(err?.message ?? '').includes(endpoint.key)) throw new Error(hide(err.message));
      throw err;
    } finally {
      detach();
      // turn/completed が来ない終わり方（error 通知・中断）でも、走ったままの端末を裏へ回す
      if (!contextRuntime && !ephemeral) endTurn(threadId);
      if (ephemeral && threadId) await rpc.request("thread/unsubscribe", { threadId }).catch(() => {});
      if (control) { control.handle = null; control.steer = null; control.steerConfirms = false; }
      if (contextRuntime) rpc.stop();
    }

    return { sessionId: threadId };
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
