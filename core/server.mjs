import { effortOptions, validateEffort } from './effort.mjs';
import { listDirs } from './list-dirs.mjs';
import { createQuotaCache, createUsageStore } from './usage.mjs';
// HTTP（web/ の配信）+ WebSocket（/ws）。token gate は constant-time 比較、既定は localhost bind。
//
// ここは**エージェント非依存**。エージェントの実行もセッション管理も core/backends/<id>.mjs が持ち、
// server は「どのエージェントに聞くか」を決めて、正規化イベントを web へ配るだけ。
// 承認の保留・猶予・中断（設計メモ §8.5）だけはここに残す。エージェントに散らすと
// 「host が居ないあいだ deny し続ける」壊れ方がエージェントの数だけ再発する。
import { createAgentTasks } from './agent-tasks.mjs';
import { createAgentBridge, AGENTS_MCP_PATH } from './agent-bridge.mjs';
import { canDelegate, resolveDelegatedMode } from './modes.mjs';
import { createUpdateGate } from './update-gate.mjs';
import { ensureDataSchema } from './data-schema.mjs';
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { readLocalFile } from "./local-files.mjs";
import { readPreview, resolveReference, cwdAt, inspectFile, previewFailure } from './file-preview.mjs';
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import * as P from "./protocol.mjs";
import * as store from "./store.mjs";
import * as history from "./history.mjs";
import { createMessageQueue } from "./message-queue.mjs";
import { createContextSettings } from './context-settings.mjs';
import { scanContext, skillList } from './context-scan.mjs';
import { acceptsPlyContext, contextPolicy, managed, nativeContextReport, pinChanges, pinnedChanges, resolveRuntime } from './context-runtime.mjs';
import { DEFAULT_OWNERS, pathKey } from './context-settings.mjs';
import { createContextBridge, CONTEXT_MCP_PATH, connectServer } from './context-bridge.mjs';
import { createContextSession } from './context-session.mjs';
import { createSecretStore, defaultCipher } from './secret-store.mjs';
import { createCompatEndpoints, sweepClaudeFlagSettings, isModelId, redactSecret, CheckError, delegatedEndpoint } from './compat-endpoints.mjs';
import { createClaudeAccounts, redactToken, normalizeName as normalizeAccountName, fetchTokenOrg, ANTHROPIC_API } from './claude-accounts.mjs';
import { createPlyMcp } from './ply-mcp.mjs';
import { createMcpOAuth } from './mcp-oauth.mjs';
import { importNativeMcp } from './mcp-import.mjs';
import { createMcpConfig } from './mcp-config.mjs';
import { createVisualizationCollector, VISUALIZE_INSTRUCTIONS } from './visualize.mjs';
import { streamEvents } from "../web/session-stream.mjs";
import { switchBackend, createConversation, deleteUnsentConversation, pendingHandoff } from "./conversations.mjs";
import { familyOf } from "./lineage.mjs";
import {
  getBackend, sessionBackend, listBackends, defaultBackend, describeBackends, resolveBackendForSession,
} from "./backends/index.mjs";

const updateGate = createUpdateGate();
const quotaCache = createQuotaCache();
const usageStore = createUsageStore(store.dataDir);
await ensureDataSchema(store.dataDir);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_VERSION = JSON.parse(await fs.readFile(path.join(HERE, '..', 'package.json'), 'utf8')).version;
const WEB = path.join(HERE, "..", "web");

import { installation, cliCommand } from "./cli-installation.mjs";
import { createClaudeLogin } from './claude-login.mjs';

const PORT = Number(process.env.AGENT_HOST_PORT ?? 7420);
const HOST = process.env.AGENT_HOST_BIND ?? "127.0.0.1";
const TOKEN = process.env.AGENT_HOST_TOKEN ?? crypto.randomBytes(16).toString("hex");

const NL = String.fromCharCode(10);
const switching = new Set();
const forking = new Set(); // Separate ownership: a running turn retains its own lock.
const settingsWrites = new Map();
const COOKIE_NAME = "agent_host_token";
// 人間が渡したファイルの置き場。作業ディレクトリを汚さないよう外に出す
const UPLOAD_DIR = path.join(store.dataDir, "uploads");
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
const IMAGE_MIME = /^image\//;
// Native sessions opened outside this host may not have sidecar metadata yet.
const workspaceRoots = new Set([process.cwd()]);
const contextSettings = createContextSettings(store.dataDir);
// 担当が Pleiad の外部 MCP。登録は Pleiad 自身の設定（エージェントの設定ファイルは書き換えない）、秘密は safeStorage で暗号化して置く
// 暗号器は 1 つを使い回す（parentPort の応答は id で引くので、2 つ作ると同じ id を取り合う）
const secretCipher = defaultCipher();
const mcpSecrets = createSecretStore({ file: path.join(store.dataDir, 'mcp-secrets.json'), cipher: secretCipher });
const plyMcp = createPlyMcp({ dataDir: store.dataDir, secrets: mcpSecrets });
// 暗号化できる起動（Pleiad デスクトップ）になったら、平文で残っている秘密を暗号化し直す（ロックの中で。npm start では何もしない）
mcpSecrets.migrate().catch(() => {});
// Claude のアカウント（会話ごとに選ぶ。claude setup-token のトークン）。秘密の置き方は MCP と同じ（core/claude-accounts.mjs）
const claudeAccountSecrets = createSecretStore({ file: path.join(store.dataDir, 'claude-account-secrets.json'), cipher: secretCipher });
claudeAccountSecrets.migrate().catch(() => {});
// トークンの持ち主（発行された組織）を GET /v1/models の応答ヘッダーで確かめ、使用量の認可と食い違えば一覧で知らせる。
// AGENT_HOST_ANTHROPIC_API は確認の送り先（テストの偽物用）。off なら確かめない（テストは既定で off。本物へは送らない）
const tokenCheckApi = process.env.AGENT_HOST_ANTHROPIC_API || ANTHROPIC_API;
const claudeAccounts = createClaudeAccounts({ dataDir: store.dataDir, secrets: claudeAccountSecrets,
  checkOrg: tokenCheckApi === 'off' ? null : token => fetchTokenOrg(token, { baseUrl: tokenCheckApi }),
  onChecked: () => emitGlobal({ type: 'claudeAccountsChanged', sessionId: null }) });
// アカウントの認可を Pleiad から行う（疑似端末で claude setup-token / claude auth login を回す。core/claude-login.mjs）。
// トークンは画面へ返さず、そのままアカウントの秘密へしまう
const claudeLogin = createClaudeLogin({
  command: () => cliCommand('claude'),
  emit: event => emitGlobal({ ...event, sessionId: null }),
  saveToken: async ({ accountId, name, token }) => {
    const current = accountId ? (await claudeAccounts.list()).accounts.find(a => a.id === accountId) : null;
    if (accountId && !current) throw new Error('そのアカウントは削除されています');
    const saved = await claudeAccounts.save({ ...(accountId ? { id: accountId } : {}), name: current?.name ?? name, token });
    quotaCache.clear();
    emitGlobal({ type: 'claudeAccountsChanged', sessionId: null });
    return saved;
  },
  usageDir: id => claudeAccounts.usageDir(id),
  markUsageLogin: async id => {
    await claudeAccounts.markUsageLogin(id);
    quotaCache.clear();
    emitGlobal({ type: 'claudeAccountsChanged', sessionId: null });
  },
  scratchDir: path.join(store.dataDir, 'claude-login-tmp'),
  // デスクトップ版は main に頼んで既定のブラウザーで開く（npm start では画面のリンクから開く）
  openExternal: url => process.parentPort?.postMessage({ type: 'open-external', url }),
});
process.on('exit', () => claudeLogin.cancelAll());
// 互換の接続先（Claude Code の Anthropic 互換 / Codex の Responses 互換。会話ごとに選ぶ。core/compat-endpoints.mjs）。
// キーは Claude のアカウント・MCP と同じ暗号化の置き場。前の起動で消し損ねたフラグ設定のファイル（キーを含む）は起動時に片付ける
const compatSecrets = createSecretStore({ file: path.join(store.dataDir, 'compat-endpoint-secrets.json'), cipher: secretCipher });
compatSecrets.migrate().catch(() => {});
const compatEndpoints = createCompatEndpoints({ dataDir: store.dataDir, secrets: compatSecrets });
sweepClaudeFlagSettings(store.dataDir).catch(() => {});
const mcpOAuth = createMcpOAuth({ secrets: mcpSecrets, lockDir: path.join(store.dataDir, 'mcp-locks'),
  // Client ID Metadata Document の URL（設定値。既定は無し。公開する文書のひな形は docs/mcp-oauth-client-metadata.json）
  clientMetadataUrl: async () => (await plyMcp.settings().catch(() => ({}))).clientMetadataUrl ?? undefined,
  // utilityProcess からはブラウザを開けないので main に頼む（desktop/main.cjs）。npm start では画面に出る URL から開く
  openExternal: url => process.parentPort?.postMessage({ type: 'open-external', url }),
  emit: event => emitGlobal({ ...event, sessionId: null }) });
const contextBridge = createContextBridge({ plyMcp, oauth: mcpOAuth });
// 固定した指示・Skills の開始時の本文（「差分を見る」用。内容のハッシュを名前にして 1 つずつ）
const CONTEXT_SNAPSHOTS = path.join(store.dataDir, 'context-snapshots');
const contextSession = createContextSession({ store, snapshots: CONTEXT_SNAPSHOTS, plyServers: () => plyMcp.scanInput(),
  liveRecord: id => runtime.turns.get(id)?.contextRecord ?? null, isRunning: id => runtime.turns.has(id) });
const mcpConfig = createMcpConfig();
let agentTasks;
const agentConnections = new Map();
const taskExecutions = new Map();
const agentBridge = createAgentBridge({ call: async (owner, name, args) => {
  const turn = runtime.turns.get(owner);
  if (!turn || turn.ac.signal.aborted) throw new Error('この会話は実行中ではありません');
  const mutation = ['ply_delegate', 'ply_task_send'].includes(name);
  if (mutation && !canDelegate(turn.backend.modes()[turn.info.mode])) throw new Error('読み取り・計画モードでは Pleiad の子タスクを開始できません');
  // 子の承認モードは「親の強さまで継ぐ、それを超えない」（core/modes.mjs）。
  // 決めるのはここだけ。prepare は決まった結果をそのまま使う（同じ判定を二度しない）。
  const child = name === 'ply_delegate' ? getBackend(args.backend) : null;
  const decided = child ? resolveDelegatedMode({ parentMode: turn.info.mode, parentModes: turn.backend.modes(), childModes: child.modes() }) : null;
  // codex は MCP のツール呼び出しを自前の承認に通さない。full / yolo 以外の codex 親では、
  // これが無いと委譲が起きたこと自体に人間が気づけないので、強さが収まっていても聞く。
  const codexBlind = turn.backend.id === 'codex' && !['full', 'yolo'].includes(turn.info.mode);
  if (mutation && (decided?.escalation || codexBlind)) {
    // 何をどの強さで動かすことになるのかをカードに出す。委譲のたびではなく、この1回だけ聞く
    const title = decided ? `この委譲は ${child.label} を「${child.modes()[decided.mode]?.label ?? decided.mode}（${decided.mode}）」で動かします` : undefined;
    const answer = await askPermission({ toolName: name, input: args, title, sessionId: owner, signal: turn.ac.signal, kind: 'tool', canAlways: false });
    if (!answer.allow) throw new Error('委譲は許可されませんでした');
  }
  return agentTasks.call(owner, name, decided?.mode ? { ...args, mode: decided.mode } : args, turn.ac.signal);
} });
function agentConnection(turn) {
  return conversationConnection(turn).runtime;
}

/**
 * 会話ごとの橋（ply_agents）。
 * contextToken は、会話のあいだ同じ値で ply_context を開くバックエンド（antigravity）に使う
 */
function conversationConnection(turn) {
  const existing = agentConnections.get(turn.key);
  if (existing) return existing;
  // 橋は会話ごとに使い回すので、ターンそのものを閉じ込めない（終わったターンが丸ごと残ってしまう）。
  // 持つのは鍵だけにして、呼ばれた時に今走っているターンを引く。
  const entry = { key: turn.key };
  const binding = agentBridge.open({ origin: localOrigin(),
    owner: async () => {
      const live = runtime.turns.get(entry.key);
      if (!live) throw new Error('この会話は実行中ではありません');
      await live.setup;
      if (!live.info.sessionId) throw new Error('会話IDはまだ確定していません');
      return live.info.sessionId;
    } });
  const { close, ...agentRuntime } = binding;
  entry.runtime = agentRuntime;
  entry.contextToken = crypto.randomBytes(32).toString('hex');
  entry.close = close;
  agentConnections.set(entry.key, entry);
  return entry;
}

/** Pleiad 自身の HTTP の口（子プロセスや中継から呼ばせる先） */
function localOrigin() {
  return `http://${HOST === '0.0.0.0' ? '127.0.0.1' : HOST === '::' ? '[::1]' : HOST.includes(':') ? `[${HOST}]` : HOST}:${server.address().port}`;
}

/** 会話が消えたら橋も閉じる。開けっ放しにするとトークンと束縛が貯まる。 */
function releaseAgentConnection(key) {
  const entry = agentConnections.get(key);
  if (!entry) return;
  agentConnections.delete(key);
  try { entry.close(); } catch {}
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
};

function tokenOk(given) {
  if (typeof given !== "string") return false;
  const a = Buffer.from(given);
  const b = Buffer.from(TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Cookie からトークンを取り出す。名前は1つだけなので素朴に読む。 */
function tokenFromCookie(header) {
  for (const part of String(header ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === COOKIE_NAME) return decodeURIComponent(v.join("="));
  }
  return null;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname === AGENTS_MCP_PATH) return agentBridge.handle(req, res);
  if (url.pathname === CONTEXT_MCP_PATH) return contextBridge.handle(req, res);

  // 静的ファイルもトークンで守る。守られているのが WebSocket だけだと、
  // リモートに出したときに UI 一式が誰でも取れてしまう。
  // 最初に ?token= で来たらクッキーに入れ、以降の css/js はそれで通す。
  const viaQuery = url.searchParams.get("token");
  const ok = tokenOk(viaQuery) || tokenOk(tokenFromCookie(req.headers.cookie));
  if (!ok) {
    res.writeHead(401, { "content-type": "text/plain; charset=utf-8" });
    return res.end("トークンが要る（起動時に出た URL を使う）");
  }

  const name = url.pathname === "/" ? "/index.html" : url.pathname;
  try {
    if (url.pathname === "/local-file" || url.pathname === '/file-preview') {
      const sessions = await store.getAll();
      const roots = [...workspaceRoots, UPLOAD_DIR,
        path.join(process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex"), "generated_images"),
        ...Object.values(sessions).flatMap(s => [s.cwd, ...(s.history ?? []).filter(h => h.field === 'cwd').flatMap(h => [h.from, h.to])])];
      if (url.pathname === '/file-preview') {
        let resolved;
        try {
          const sessionId = url.searchParams.get('sessionId');
          const meta = sessions[sessionId] ?? {};
          const backend = sessionId ? await resolveBackendForSession(sessionId) : null;
          const info = !meta.cwd && backend ? await backend.getSession(sessionId).catch(() => null) : null;
          const currentCwd = meta.cwd || info?.cwd;
          if (currentCwd) roots.push(currentCwd);
          let base = currentCwd;
          const requested = url.searchParams.get('path');
          // Only relative references need a historical cwd. An explicit path
          // stays useful even when a native transcript has no timestamps.
          if (url.searchParams.has('base')) {
            const baseFile = await inspectFile(url.searchParams.get('base'), roots);
            base = path.dirname(baseFile.file);
          } else if (!/^(?:[a-z]:[\\/]|\/|file:)/i.test(requested ?? '')) base = cwdAt({ ...meta, cwd:currentCwd }, url.searchParams.get('at'));
          resolved = resolveReference(requested, base);
          const preview = await readPreview(resolved.path, roots, { resource:url.searchParams.get('resource') === '1' });
          res.writeHead(200, { 'content-type':'application/json; charset=utf-8', 'cache-control':'private, no-store', 'x-content-type-options':'nosniff' });
          return res.end(JSON.stringify({ ...preview, line:resolved.line, cwd:base }));
        } catch (error) {
          const failure = previewFailure(error);
          res.writeHead(failure.code === 'not-found' ? 404 : 400, { 'content-type':'application/json; charset=utf-8', 'cache-control':'private, no-store' });
          return res.end(JSON.stringify({ error:failure, path:resolved?.path ?? url.searchParams.get('path') }));
        }
      }
      const { body, headers } = await readLocalFile(url.searchParams.get("path"), roots, { download:url.searchParams.get('download') === '1' });
      res.writeHead(200, headers);
      return res.end(body);
    }
    // PDF.js is loaded only when a PDF is opened. Expose its browser assets,
    // not arbitrary files from node_modules. Cookies protect these too.
    const pdfAsset = /^\/vendor\/pdfjs\/(build\/(?:pdf|pdf.worker)\.mjs|(?:cmaps|standard_fonts|wasm)\/[a-zA-Z0-9_.-]+)$/.exec(url.pathname);
    if (pdfAsset) {
      const packageRoot = path.dirname(fileURLToPath(import.meta.resolve('pdfjs-dist/package.json')));
      const body = await fs.readFile(path.join(packageRoot, pdfAsset[1]));
      res.writeHead(200, { 'content-type':pdfAsset[1].endsWith('.mjs') ? 'text/javascript; charset=utf-8' : pdfAsset[1].endsWith('.wasm') ? 'application/wasm' : 'application/octet-stream', 'x-content-type-options':'nosniff' });
      return res.end(body);
    }
    const rel = path.normalize(name).split(path.sep).filter(Boolean).join(path.sep);
    const file = path.join(WEB, rel);
    if (!file.startsWith(WEB)) throw new Error("outside web/");
    const body = await fs.readFile(file);
    const headers = { "content-type": MIME[path.extname(file)] ?? "application/octet-stream" };
    if (tokenOk(viaQuery)) {
      // HttpOnly なので JS からは読めない。SameSite=Strict で他サイトからは送られない
      headers["set-cookie"] =
        `${COOKIE_NAME}=${encodeURIComponent(viaQuery)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800`;
    }
    res.writeHead(200, headers);
    res.end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
});

const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname !== "/ws") return socket.destroy();
  if (!tokenOk(url.searchParams.get("token"))) {
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    return socket.destroy();
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});

// ---- セッション一覧 ---------------------------------------------------------

const toMs = (v) => (Number.isFinite(v) ? v : (v ? Date.parse(v) || null : null));

/**
 * エージェントのネイティブな行（無ければ null）と sidecar の行を、一覧の 1 行に合わせる。
 *
 * タイトルと状態は「ネイティブに持てるならそれが正本」（§2.4）。持てないエージェントが
 * ネイティブ一覧に何か（先頭プロンプト等）を返しても、人が付けた sidecar のタイトルを隠さない。
 * 正本が空なら片方へ落ちる。parent は host が分けたもの（sidecar）と向こうで分けたもの
 * （codex の forkedFromId）の両方から読む。一覧と系譜（lineage）が同じ行を見るよう、合成はここだけ。
 */
function sessionRow(b, s, extra = {}) {
  const nativeTitle = b.capabilities?.title;
  return {
    id: s?.sessionId ?? extra.id,
    backend: b.id,
    title: (nativeTitle ? s?.title ?? extra.title : extra.title ?? s?.title) ?? "(no title)",
    // 事前定義なし。使われた時点で存在する
    status: (b.capabilities?.tag && s ? s.tag : extra.status ?? s?.tag) ?? null,
    statusChangedAt: extra.statusChangedAt ?? null,
    completedAt: extra.completedAt ?? null,
    parent: extra.parent ?? s?.parent ?? null,
    // 人が外した／解除したグループ。まとまり自体は親子と状態から決まる（web/family.mjs）
    ungrouped: Boolean(extra.ungrouped),
    delegation: extra.delegation ?? null,
    mode: extra.mode ?? "default",
    model: extra.model ?? "",
    effort: extra.effort ?? "",
    nextSettings: extra.nextSettings ?? null,
    // Claude のアカウント（'' = ログイン中のアカウント）。id だけでトークンは載せない
    claudeAccount: extra.claudeAccount ?? "",
    // 互換の接続先（'' = 公式）。id だけでキーは載せない
    compatEndpoint: extra.compatEndpoint ?? "",
    // 対応を終えたエージェントの会話（core/backends/index.mjs の RETIRED）。読めるが続けられない理由
    ...(b.retired ? { retired: b.retired } : {}),
    unsent: extra.unsent ?? false,
    hasDraft: Boolean(extra.draft?.text || extra.draft?.attached?.length),
    historyCount: (extra.history ?? []).length,
    // 人が host で作業ディレクトリを変えたなら sidecar が正本（ネイティブは古い cwd を返しうる）。
    // 変えていなければネイティブ優先（公式 CLI で移した分も拾える）
    cwd: ((extra.history ?? []).some((h) => h?.field === "cwd") ? extra.cwd ?? s?.cwd : s?.cwd ?? extra.cwd) ?? null,
    lastModified: toMs(s?.lastModified) ?? toMs(extra.lastModified),
    createdAt: s?.createdAt ?? extra.createdAt ?? null,
  };
}

/**
 * 全エージェントのネイティブ一覧と sidecar を1つに合わせる（docs/multi-backend.md §2.1）。
 * ネイティブ一覧に出ないセッション（sidecar にしか無いもの）も落とさずに足す。
 */
async function sessionList({ limit = 100 } = {}) {
  const backends = listBackends();
  const [side, ...lists] = await Promise.all([
    store.getAll().catch(() => ({})),
    ...backends.map((b) => b.listSessions({ limit }).catch(() => [])),
  ]);

  const rows = new Map();

  backends.forEach((b, i) => {
    for (const s of lists[i]) rows.set(s.sessionId, sessionRow(b, s, side[s.sessionId]));
  });

  // sidecar にしか無い行。どのエージェントのものか分からないもの（v1 から引き継いだ行で
  // まだ一度も触っていないもの）は出さない。出しても開けないので一覧を濁すだけ。
  // 対応を終えたエージェントの会話は出す（読めるが続けられない。sessionBackend の retired）
  for (const [id, extra] of Object.entries(side)) {
    const b = rows.has(id) || !extra.backend ? null : sessionBackend(extra.backend);
    if (!b) continue;
    const managed = b.retired ? await b.getSession(id).catch(() => null) : null;
    rows.set(id, sessionRow(b, managed, { ...extra, id }));
  }

  for (const row of rows.values()) if (row.cwd) workspaceRoots.add(row.cwd);
  return [...rows.values()].sort((a, b) => (b.lastModified ?? 0) - (a.lastModified ?? 0));
}

/**
 * 使用量の表示に使うアカウント。会話用のトークンではなく、アカウントごとの設定フォルダ（`claude auth login` 済み）で読む
 * （setup-token のトークンは scope が user:inference だけで使用量を読めない）。認可が済んでいないものは理由を出す。
 * 1 件も登録していなければ空＝今までどおりログイン中のアカウントだけ
 */
async function usageAccounts() {
  const accounts = await claudeAccounts.usageTargets().catch(() => []);
  return accounts.length ? { accounts } : {};
}

/**
 * どのエージェントで回すか決める。
 *   再開 … そのセッションのもの（sidecar の backend、無ければ各エージェントに聞く）
 *   新規 … クライアントの指定。1つしか有効になっていなければそれに落とす
 */
async function pickBackend(sessionId, given) {
  if (sessionId) {
    // 対応を終えたエージェントの会話もここで引ける（retired を持つ）。続ける操作は refuseRetired で断る
    const current = await resolveBackendForSession(sessionId);
    if (current && given && current.id !== given) throw new Error("エージェントは切り替え操作で変更してください");
    if (current) return current;
    if (!given) throw new Error(`セッション ${sessionId} のエージェントが分からない`);
  }
  if (typeof given === "string" && given) {
    const b = getBackend(given);
    if (!b) throw new Error(`知らないエージェント: ${given}`);
    return b;
  }
  const remembered = (await store.getPrefs()).backend;
  const preferred = getBackend(remembered);
  if (preferred) return preferred;
  // 既定に覚えていたエージェントが無くなった（対応を終えた・無効にした）なら、有効なものの先頭へ落とす
  const only = listBackends();
  if (only.length === 1 || (remembered && only.length)) return only[0];
  throw new Error("エージェントの指定が要る");
}

/** 対応を終えたエージェントの会話は続けられない。ターン・設定の変更・切り替えの前に断る */
function refuseRetired(backend) {
  if (backend?.retired) throw new Error(backend.retired);
  return backend;
}

/**
 * 明示した値は検証し、保存済みの値と新規会話の既定は非対応なら未指定に戻す。
 * 段はモデルごとに違う（Claude の Haiku は段を持たない）。以前は全モデル共通の段だったので、
 * 保存済みの値で送信を止めると、それまで動いていた会話が送れなくなる。
 */
async function resolveEffort(sessionId, asked, backend, model, cwd, endpoint = null) {
  const current = sessionId ? await store.get(sessionId) : {};
  const prefs = await store.getPrefs();
  // 互換の接続先では公式の既定（prefs）を持ち込まない（段の意味が接続先ごとに違う）
  const value = asked ?? current.effort ?? (endpoint ? '' : prefs.backends?.[backend.id]?.effort) ?? '';
  if (asked !== undefined) return validateEffort(backend, value, model, cwd, endpoint);
  return Object.hasOwn(await effortOptions(backend, model, cwd, endpoint), value) ? value : '';
}

/**
 * モデルの検証。互換の接続先を選んでいる会話（endpointId）は、接続先の一覧＋自由入力なので形だけを見る
 * （`/` や `:` を含む ID も通す。黙って既定に戻さない）。'' は接続先のメインのモデル
 */
async function validModel(backend, model, cwd, endpointId = '') {
  if (endpointId) return model === '' || isModelId(model);
  return backend.validModel ? backend.validModel(model, cwd) : Object.hasOwn(await backend.models(cwd), model);
}
async function resolveModel(sessionId, given, backend, cwd, endpointId = '') {
  const asked = typeof given === "string" ? given : null;
  const saved = sessionId ? (await store.get(sessionId)).model : null;
  const prefs = await store.getPrefs();
  // 公式の既定のモデル（prefs）は互換の接続先へは持ち込まない
  const fallback = endpointId ? '' : (prefs.backends ? prefs.backends[backend.id] : prefs)?.model;
  const model = asked ?? saved ?? fallback ?? "";
  return await validModel(backend, model, cwd, endpointId) ? model : "";
}

/** 接続先を選べるエージェントか（Claude Code・Codex） */
const endpointCapable = backend => Boolean(backend?.capabilities?.compatEndpoints);
/** 一覧の行（キー無し）。effortOptions に渡す。'' なら null */
const endpointRow = async id => id ? await compatEndpoints.get(id) : null;

/** セッションに覚えさせた承認モードを読む。不明なものは既定に落とす。 */
function firstMode(modes) {
  return "default" in modes ? "default" : Object.keys(modes)[0] ?? "default";
}

async function resolveMode(sessionId, given, backend) {
  const modes = backend.modes();
  const asked = typeof given === "string" ? given : null;
  const saved = sessionId ? (await store.get(sessionId)).mode : null;
  // 新しいセッションは「前に選んだもの」から始める。毎回選び直させない
  const prefs = await store.getPrefs();
  const fallback = (prefs.backends ? prefs.backends[backend.id] : prefs)?.mode;
  const mode = asked ?? saved ?? fallback ?? firstMode(modes);
  return modes[mode] ? mode : firstMode(modes);
}

/**
 * ターンを回す作業ディレクトリを決める。
 *
 * **暗黙の既定を持たない。** `process.cwd()` へ落とすと、AI が書いたファイルの行き先が
 * 「サーバをどこから起動したか」で変わる。指定を忘れたことに気づけないまま
 * 見当違いの場所に書かれるので、始める前に断る。
 *
 *   再開 … host が明示して送ってきたらそれ（人が変えた）。無ければセッション自身の cwd
 *          （人が host で変えたことがあれば sidecar、そうでなければエージェント優先）
 *   新規 … クライアントの指定が必須
 *
 * 戻りは { cwd, changedFrom }。changedFrom はそれまでの cwd と違うときだけ（履歴とイベントに使う）
 */
async function resolveCwd(resume, given, backend) {
  const asked = typeof given === "string" && given.trim() ? given : null;

  let cwd = asked;
  let changedFrom = null;
  if (resume) {
    const [info, extra] = await Promise.all([backend.getSession(resume).catch(() => null), store.get(resume)]);
    const human = (extra.history ?? []).some((h) => h?.field === "cwd");
    const own = (human ? extra.cwd ?? info?.cwd : info?.cwd ?? extra.cwd) ?? null;
    cwd = asked ?? own;
    if (!cwd) cwd = os.homedir();
    if (own && path.resolve(cwd) !== path.resolve(own)) changedFrom = own;
  } else if (!cwd) {
    cwd = os.homedir();
  }

  const stat = await fs.stat(cwd).catch(() => null);
  if (!stat) throw new Error(`作業ディレクトリが無い: ${cwd}`);
  if (!stat.isDirectory()) throw new Error(`作業ディレクトリではない: ${cwd}`);
  return { cwd, changedFrom };
}

// ---- 接続をまたいで生きるランタイム ----------------------------------------
//
// host（ブラウザ）が一瞬居なくなっただけでターンを殺さない。
// かといって、居ないあいだ「承認できないから deny」を返し続けるのは最悪で、
// エージェントは走り続けたまま書き込みだけが全部失敗し、
// 読み取り系（自動許可）だけが通るので「動いているのに成果ゼロ」になる。
// 居ないあいだは待たせ、戻ってきたら聞き直し、戻らなければターンごと止める。
const HOST_GRACE_MS = Number(process.env.AGENT_HOST_GRACE_MS ?? 60_000);
const EVENT_BUFFER_MAX = 500;
// 同時に回せるターン数に上限は置かない（2026-09-23 に廃止。委譲した子で埋まり、利用者の送信が待たされていた）

const runtime = {
  sockets: new Set(),    // つながっている host。タブが複数あってもよい
  turns: new Map(),      // 走っているターン: key -> Turn（key は sessionId か仮キー）
  waiting: new Map(),    // 承認待ち: id -> { settle, payload, askedAt }
  buffer: [],            // host が居ないあいだのイベント
  awaySince: 0,          // host が居なくなった時刻（0 = 居る）
  graceTimer: null,
  runningPoll: null,     // 実行中一覧を配る間隔タイマー
  // ターンの外で裏に残っている作業: sessionId -> { sessionId, backend, tasks, since }（setBackground）。
  // Codex のバックグラウンド端末はターンが終わっても残るので、ターン行（turn.info.background）とは別に持つ
  background: new Map(),
};


// Turn = 走っている1本。
// 新規セッションは走り出すまで id が無いので、仮キーで登録して後から差し替える。
// { key, ac, backend, control:{handle}, info:{sessionId,backend,startedAt,cwd,mode,model},
//   taskHints: Map<tool_use id, 見出し>, pastSubagents: Set<agentId>, subagentOrigins: Map<agentId, tool_use id> }

/** host が居ない時間が猶予を超えたか。タイマーに頼らず、その場で判定する。 */
function graceExpired() {
  return runtime.awaySince !== 0 && Date.now() - runtime.awaySince > HOST_GRACE_MS;
}

/** 猶予切れの後始末。何度呼ばれても安全。走っているターンは全部止める。 */
function giveUp() {
  if (runtime.awaySince === 0) return;
  const reason = `host が ${Math.round((Date.now() - runtime.awaySince) / 1000)} 秒戻らなかったので中断した`;
  runtime.awaySince = 0;
  clearTimeout(runtime.graceTimer);
  runtime.graceTimer = null;
  for (const [, w] of [...runtime.waiting]) w.settle({ allow: false, message: reason });
  // 承認を返せないまま走らせ続けない。黙って deny し続けるより、止めて気づかせる。
  for (const t of [...runtime.turns.values()]) t.ac.abort();
  void agentTasks?.cancelOwner().catch(() => {});
  console.log(`  ${reason}`);
}

/** つながっている host 全部に送る。1つでも届けば true。 */
function sendTo(frame) {
  const text = JSON.stringify(frame);
  let sent = false;
  for (const ws of runtime.sockets) {
    if (ws.readyState === ws.OPEN) { ws.send(text); sent = true; }
  }
  return sent;
}

/** 保存した既定を全画面に通知する。セッション閲覧では既定を書き換えない。 */
async function savePref(key, value, backendId) {
  const prefs = await store.setPref(key, value, backendId);
  emitGlobal({ type: "prefs", sessionId: null, prefs });
  return prefs;
}

/** セッションに紐づかない全体イベント。 */
const liveReads = new Set();
let streamSequence = 0;
function emitGlobal(event) {
  if (streamEvents.has(event.type)) event = { ...event, streamSeq: ++streamSequence };
  const live = runtime.turns.get(event.sessionId);
  if (live && streamEvents.has(event.type)) live.stream.events.push(event);
  const frame = { kind: P.EVENT, event };
  if (!sendTo(frame)) {
    if (graceExpired()) giveUp();
    runtime.buffer.push(frame);
    if (runtime.buffer.length > EVENT_BUFFER_MAX) {
      runtime.buffer.splice(0, runtime.buffer.length - EVENT_BUFFER_MAX);
    }
  }
}

/**
 * グループ（fork でつながった会話のまとまり、docs/design-system.md §4.1）を一覧の行から数える。
 * まとまりは持ち物ではなく、**親子でつながり・状態が同じ・人が外していない**ことで決まる。
 * 脇の描画は web/family.mjs が同じ規則で組む。ここはサーバ側で「根を動かすと中も動く」を守るためだけに使う。
 */
const canGroup = (child, parent) =>
  Boolean(parent) && !child.ungrouped && !parent.ungrouped && (child.status ?? null) === (parent.status ?? null);

/** その行が根か（自分より上に、同じまとまりに居られる祖先が居ない） */
function isGroupRoot(rows, id) {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const me = byId.get(id);
  if (!me || me.ungrouped) return false;
  const seen = new Set([id]);
  let p = me.parent?.sessionId;
  for (let i = 0; p && i < 64; i++) {
    if (seen.has(p)) break;
    seen.add(p);
    const up = byId.get(p);
    if (up && canGroup(me, up)) return false;
    p = up?.parent?.sessionId;
  }
  return true;
}

/** 根と同じまとまりに居る子孫（根は含まない） */
function groupKin(rows, rootId) {
  const root = rows.find((r) => r.id === rootId);
  if (!root || root.ungrouped) return [];
  const kids = new Map();
  for (const r of rows) {
    const p = r.parent?.sessionId;
    if (!p || p === r.id) continue;
    if (!kids.has(p)) kids.set(p, []);
    kids.get(p).push(r);
  }
  // 子孫を全部辿り、根と同じまとまりに居られるものだけ数える。
  // 間に別の状態の枝があっても、その先の子孫は根に付く（web/family.mjs の「近い祖先へ」と同じ）
  const seen = new Set([root.id]);
  const queue = [root.id];
  const out = [];
  for (let i = 0; i < queue.length && out.length < 200; i++) {
    for (const c of kids.get(queue[i]) ?? []) {
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      queue.push(c.id);
      if (canGroup(c, root)) out.push(c);
    }
  }
  return out;
}

/** 人間からの状態の変更。setStatus コマンドと新規セッションの引き継ぎが同じ経路を通る。 */
async function applyStatus(backend, sessionId, status, reason) {
  // ネイティブに持てるなら**そこが正本**。持てなくても sidecar には必ず残る
  if (backend.capabilities?.tag && backend.setTag) await backend.setTag(sessionId, status);
  await store.recordChange(sessionId, { by: "human", field: "status", to: status, reason, backend });
  emitGlobal({ type: "status", sessionId, status, by: "human", reason: reason ?? null });
}

/**
 * ターンに属するイベントを流す。ついでにそのターンの文脈を拾う。
 * 並行して複数のターンが走るので、文脈はグローバルではなくターンごとに持つ。
 */
function makeEmit(turn) {
  const emit = (event, { recorded = false } = {}) => {
    if (event?.type === 'usage') turn.usage = { ...turn.usage, ...event };
    // 文脈の圧縮（Claude の activity compacting）。控えを捨て、
    // 次に頼まれたら instructions_for_path / load_skill が本文を渡し直す（要約に置き換わると手元から消えるため）
    if (event?.type === 'activity' && event.state === 'compacting') {
      const kept = turn.contextRecord?.delivered?.entries;
      if (kept) for (const key of Object.keys(kept)) delete kept[key];
    }
    // 受理済みの途中送信が読まれずに捨てられた（userMessage.dropped）。送信待ちへ戻す
    if (event?.type === "userMessage.dropped" && turn.info.sessionId && event.messageId) {
      outbox.returned(turn.info.sessionId, event.messageId).catch(() => {});
    }
    if (event?.type === "turnResult") {
      turn.outcome = event.outcome;
      const execution = taskExecutions.get(turn.info.sessionId);
      if (execution) { execution.outcome = event.outcome; execution.error = event.error ?? null; }
    }
    // main の状態と裏で動いているもの（docs/multi-backend.md §2.2）。一覧と稼働表示は running の
    // ターン行から読むので、変わったらすぐ配る（4 秒ごとの定期便を待たない）
    if (event?.type === "phase" || event?.type === "background") {
      if (event.type === "phase") turn.info.phase = event.state === "waiting" ? "waiting" : "active";
      else turn.info.background = Array.isArray(event.tasks) ? event.tasks : [];
      broadcastRunning();
    }
    // 新規セッションは走り出してから id が決まる。仮キーを本物へ差し替える。
    // sessionId が null の session は「まだ決まっていない」ので差し替えない
    // （差し替えると sidecar に "null" キーの行が生える）。
    if (event?.type === "session" && event.sessionId && !turn.info.sessionId) {
      turn.info.sessionId = event.sessionId;
      for (const read of liveReads) if (read.sessionId === event.sessionId) read.turn = turn;
      runtime.turns.delete(turn.key);
      const connection = agentConnections.get(turn.key);
      if (connection) { agentConnections.delete(turn.key); connection.key = event.sessionId; agentConnections.set(event.sessionId, connection); }
      turn.key = event.sessionId;
      runtime.turns.set(turn.key, turn);
      // 実際に使った承認モードとモデル、どのエージェントのものかをセッションに残す。
      // 既定から引き継いだ場合、書かないと一覧の表示と実際の挙動がずれる。
      // backend を書いておかないと、次に開いたときに誰に聞けばよいか分からない。
      const { sessionId, mode, model, cwd, status, attachments } = turn.info;
      turn.setup = Promise.all([
        store.setMeta(sessionId, {
          backend: turn.backend.id, cwd, createdAt: turn.info.startedAt, lastModified: Date.now(),
        }),
        store.setMode(sessionId, mode),
          store.setModel(sessionId, model ?? ""),
          store.setSessionData(sessionId, "effort", turn.info.effort ?? ""),
          ...(turn.info.endpoint ? [store.setSessionData(sessionId, 'compatEndpoint', turn.info.endpoint)] : []),
          ...(turn.contextRecord ? [store.setSessionData(sessionId, 'contextSession', turn.contextRecord)] : []),
        // 新規セッションに最初から付ける状態。id が無いうちは host が予約として持っていて、
        // 生まれた瞬間にここで書く。経路は setStatus と同じ（ネイティブ + sidecar + イベント）
        // first（このターンで id が確定した）の 1 本にだけ付ける
        status && event.first ? applyStatus(turn.backend, sessionId, status, "新しいセッションに引き継いだ") : null,
        // 送信と一緒に渡した添付も、id が決まった今、会話に載せる
        event.first && attachments?.length ? presentAttachments(sessionId, attachments, emit) : null,
      ]);
      turn.setup.catch((err) => console.error("  設定の記録に失敗:", String(err?.message ?? err)));
    }

    // サブエージェントの transcript には依頼のユーザー発言が入らない（assistant 発言のみ）。
    // 見出しに使えるよう、親側の委譲ツールの説明をここで拾っておく。
    // ツール名はエージェントが宣言する（v1 は Task / Agent を直書きしていた）。
    // どのサブエージェントの分かは tool_use id で引く（runningWork）
    if (event?.type === "tool.start" && event.id && turn.backend.listSubagents
        && (turn.backend.subagentTools ?? []).includes(event.name)) {
      turn.taskHints.set(event.id, String(event.input?.description ?? event.input?.prompt ?? "").slice(0, 120));
    }

    if (event?.type === "present" && event.sessionId && !recorded) {
      const { type, sessionId, ...payload } = event;
      const pending = history.recordPresent(sessionId, { ...payload, turnKey: turn.presentKey });
      turn.presentWrites.push(pending);
      pending
        .catch((err) => console.error("  present の記録に失敗:", String(err?.message ?? err)));
    }

    turn.visualizations?.accept(event);

    // どのターンのものか分かるように必ず付ける。クライアントはこれで画面を選り分ける
    emitGlobal(P.stampSessionId(event, turn.info.sessionId));
  };
  return emit;
}

/**
 * 送信と一緒に渡された添付（attachFile が置いたもの）を会話に載せる。
 * 人間の添付も AI の提示と同じ present で並ぶ（設計メモ §7）。記録は emit（makeEmit）が present を見て行う。
 * 置き場（uploads/）の外のパスは載せない。クライアントの言うことを鵜呑みにしてファイルを読まないため
 */
async function presentAttachments(sessionId, attachments, emit) {
  for (const a of attachments) {
    const file = path.resolve(String(a?.path ?? ""));
    if (!file.startsWith(UPLOAD_DIR + path.sep)) continue;
    let buf;
    try { buf = await fs.readFile(file); } catch { continue; }
    const mime = String(a.mime ?? "");
    const isImage = IMAGE_MIME.test(mime);
    const name = path.basename(file).replace(/^\d{4}-\d{2}-\d{2}T[\d-]+Z_/, "");
    emit({
      type: "present",
      sessionId,
      kind: isImage ? "image" : "file",
      caption: `添付: ${name}`,
      path: file,
      by: "human",
      ...(isImage ? { dataUri: `data:${mime};base64,${buf.toString("base64")}` } : { content: buf.toString("utf8").slice(0, 20000) }),
    });
  }
}

/** サブエージェントを生んだ委譲ツールの tool_use id。変わらないので、分かったらターンに覚えておく */
async function subagentOrigin(t, sessionId, agentId) {
  if (!t.subagentOrigins.has(agentId)) {
    const id = t.backend.getSubagentOrigin
      ? await t.backend.getSubagentOrigin(sessionId, agentId).catch(() => null) : null;
    if (!id) return null;   // 生まれた直後で、まだ書かれていないことがある。次の配信で聞き直す
    t.subagentOrigins.set(agentId, id);
  }
  return t.subagentOrigins.get(agentId);
}

const SUBAGENT_STATUS = new Set(["running", "completed", "failed", "stopped"]);

/**
 * サブエージェントの状態。バックエンドの任意メソッド getSubagentState の返りを検める。
 * 返せない・分からない・知らない語彙はすべて null（「分からない」）。終わった後も変わりうる
 * （再開された子は running に戻る）ので、origin と違ってターンに覚えない
 */
async function subagentState(t, sessionId, agentId) {
  if (typeof t.backend.getSubagentState !== "function") return null;
  const s = await t.backend.getSubagentState(sessionId, agentId).catch(() => null);
  if (!s || !SUBAGENT_STATUS.has(s.status)) return null;
  return { status: s.status, startedAt: s.startedAt ?? null, endedAt: s.endedAt ?? null };
}

/**
 * いま動いているものを集める。
 * 会話が終わってもサブエージェントが残ることがあるので、数だけでも常に見えるようにする。
 */
async function runningWork() {
  const turns = [...runtime.turns.values()].map((t) => ({ kind: "turn", ...t.info }));

  const permissions = [...runtime.waiting].map(([id, w]) => ({
    id,
    kind: "permission",
    toolName: w.payload.toolName,
    sessionId: w.payload.sessionId ?? null,
    askedAt: w.askedAt ?? null,
    relay: Boolean(w.relay),   // 祖先の会話へ中継した複製。元のカードと同じ1件を指す
  }));

  const nested = await Promise.all([...runtime.turns.values()].map(async (t) => {
    const sessionId = t.info.sessionId;
    // サブエージェントを持たないエージェントでは空。web は `?? []` で受ける
    if (!sessionId || !t.backend.listSubagents) return [];
    // listSubagents は前のターンまでの分も返す。このターンで生まれた分だけを載せる
    const ids = (await t.backend.listSubagents(sessionId).catch(() => [])).filter((id) => !t.pastSubagents.has(id));
    return Promise.all(ids.map(async (agentId) => {
      const msgs = await t.backend.getSubagentMessages(sessionId, agentId, { limit: 200 }).catch(() => []);
      const last = msgs[msgs.length - 1];
      // 依頼文（親の委譲ツールの説明）を優先し、無ければ本人の最初の発言を見出しにする。
      // 依頼文は生んだ委譲ツールの id で引く。listSubagents の並びは起動順ではないので、順番では当てない
      const said = msgs.map((m) => m.text).find(Boolean);
      const hint = t.taskHints.get(await subagentOrigin(t, sessionId, agentId));
      const state = await subagentState(t, sessionId, agentId);
      return {
        id: agentId,
        kind: "subagent",
        sessionId,
        messages: msgs.length,
        description: (hint || said || "").slice(0, 120) || null,
        saying: said ? said.slice(0, 120) : null,
        lastAt: last?.at ?? null,
        // 状態を返せないバックエンド・分からない子は null（web は印を出さず、count は走っている側に数える）
        status: state?.status ?? null,
        startedAt: state?.startedAt ?? null,
        endedAt: state?.endedAt ?? null,
      };
    }));
  }));
  const subagents = nested.flat();

  // ターンの外で裏に残っている作業（Codex のバックグラウンド端末など）。
  // count には入れない: デスクトップは count > 0 の間は終了させないが、これは Pleiad から止める口が無い
  const background = [...runtime.background.values()].map((b) => ({
    kind: "background", ...b, tasks: b.tasks.map((x) => ({ ...x })),
  }));

  return {
    turns,
    permissions,
    subagents,
    tasks: agentTasks?.list().map(({ result, ...r }) => r) ?? [],
    background,
    // 中継の複製は数えない。1つの承認が会話の数だけ増えて見える
    // サブエージェントは走っている子だけを数える。終わった子はターンが終わるまで一覧に残るので、
    // そのまま数えると更新のゲート（web の count > 0）が閉じたままになる。status が null の子
    // （状態を返せないバックエンド・まだ分からない子）は数える。数えないとゲートを緩めてしまう
    count: turns.length + permissions.filter((p) => !p.relay).length
      + subagents.filter((a) => a.status === "running" || a.status == null).length + (agentTasks?.list().filter(r => ["queued", "running", "cancelling"].includes(r.status) && !runtime.turns.has(r.sessionId)).length ?? 0),
  };
}

/**
 * 実行中の状況を配る。増減が見えないと「動いているのか分からない」に戻る。
 * 集めるのは非同期（サブエージェントの一覧を読む）なので、続けて呼ぶと古い方が後から届きうる。
 * phase と background は同じ瞬間に続けて変わるので、最後に始めた 1 回だけを配る
 */
let runningSeq = 0;
async function broadcastRunning() {
  const seq = ++runningSeq;
  const work = await runningWork().catch(() => null);
  if (work && seq === runningSeq) emitGlobal({ type: "running", ...work });
}

/** サブエージェントは走っている最中に増える。1本でも走っていれば（裏に残っていれば）定期的に配る。 */
function syncRunningPoll() {
  const want = runtime.turns.size > 0 || runtime.background.size > 0;
  if (want && !runtime.runningPoll) runtime.runningPoll = setInterval(broadcastRunning, 4000);
  if (!want && runtime.runningPoll) { clearInterval(runtime.runningPoll); runtime.runningPoll = null; }
}

function attach(ws) {
  const hadGrace = runtime.awaySince !== 0;
  runtime.sockets.add(ws);
  runtime.awaySince = 0;
  clearTimeout(runtime.graceTimer);
  runtime.graceTimer = null;

  for (const frame of runtime.buffer.splice(0)) sendTo(frame);

  // 待たせていた承認を聞き直す。取りこぼすとツールが無期限に止まる
  for (const [id, w] of runtime.waiting) sendTo({ kind: P.EVENT, event: { ...w.payload, id } });
  if (runtime.waiting.size) console.log(`  承認 ${runtime.waiting.size} 件を聞き直した`);
  if (hadGrace) console.log("  猶予を解除した（host が戻った）");
}

function detach(ws) {
  if (!runtime.sockets.delete(ws)) return;
  if (runtime.sockets.size > 0) return;          // まだ別のタブが居る
  if (runtime.turns.size === 0 && runtime.waiting.size === 0) return;

  runtime.awaySince = Date.now();
  console.log(`  host が離れた。${HOST_GRACE_MS / 1000} 秒待つ (turns=${runtime.turns.size}, waiting=${runtime.waiting.size})`);
  // 保険のタイマー。ただしこれ単体には頼らない（発火しなくても graceExpired() が拾う）
  clearTimeout(runtime.graceTimer);
  runtime.graceTimer = setTimeout(giveUp, HOST_GRACE_MS + 500);
}

/** 承認待ちを片付ける。どのセッションの分かは呼び出し側が必ず指定する。 */
function settleAll(message, sessionId) {
  // id が決まらないまま終わったターンで全部を deny すると、
  // 走っている他のセッションの承認待ちまで巻き添えにする。何もしない方が安全。
  if (!sessionId) return;
  for (const [, w] of [...runtime.waiting]) {
    if (sessionId && w.payload.sessionId !== sessionId) continue;
    // 中継の複製は「別の会話の承認」をここに出しているだけ。
    // この会話のターンが終わっても取り下げない（元の会話が決着すれば一緒に消える）。
    // 取り下げると、依頼元が ply_task_wait を終えただけで子の承認が拒否される
    if (w.relay) continue;
    w.settle({ allow: false, message });
  }
}

/** 承認待ちの増減を知らせる。画面の実行中一覧と、依頼元の ply_task_wait の両方を起こす */
function permissionsChanged() {
  broadcastRunning();
  agentTasks?.wake();
}

/**
 * 委譲でつながった祖先の会話を、近い順に並べる。
 * 会話メタデータの delegation（prepare が書く）を親へ辿る。
 * 壊れた記録で回り続けないよう、同じ会話は二度通らず、辿る回数にも上限を置く（委譲は4階層まで）。
 */
async function delegationAncestors(sessionId) {
  const chain = [];
  const seen = new Set([sessionId]);
  let id = sessionId;
  for (let i = 0; i < 8; i++) {
    const parent = (await store.get(id)).delegation?.parentSessionId;
    if (!parent || seen.has(parent)) break;
    seen.add(parent);
    chain.push(parent);
    id = parent;
  }
  return chain;
}

/**
 * エージェントから呼ばれる。permission イベントを出して、
 * クライアントの resolvePermission コマンドが来るまで待つ。
 * host が居なければ**送らずに待つ**。deny を即返してはいけない。
 *
 * kind / questions / canAlways はエージェントが正規形にして渡してくる。
 * 「常に許可」の候補の中身のような、エージェント固有の構造はここには来ない。
 *
 * 委譲の子の承認は、祖先の会話すべてにも同じ承認を複製して出す（中継）。
 * 人間は最上位の会話に居るので、1段だけ上げても誰も見ない場所に出るだけになる。
 * どれか1つで答えれば全部が決着し、残りは消える。
 */
const askPermission = async ({ toolName, input, sessionId, toolUseID, title, signal, canAlways, kind, questions }) => {
  const ancestors = sessionId ? await delegationAncestors(sessionId) : [];
  // 中継先の見出しは「どの会話の承認か」。委譲したときの info.title を使う
  const childTitle = ancestors.length ? (await store.get(sessionId)).title || "委譲した子の会話" : "";
  // 祖先を読むあいだに中断されたなら、待たせずに返す（abort はもう来ない）
  if (signal?.aborted) return { allow: false, message: "中断された" };
  return new Promise((resolve) => {
    const payload = {
      type: "permission",
      kind: kind === "question" ? "question" : "tool",
      toolName,
      input,
      sessionId: sessionId ?? null,
      toolUseID,
      title,
      canAlways: Boolean(canAlways),
      ...(questions ? { questions } : {}),
    };
    // 祖先ごとに別の id の複製を作り、どれも同じ settle を指す。
    // web は「id ごとに1つの会話」の前提のまま動き、消せば勝手に片付く
    const cards = [{ id: crypto.randomUUID(), payload, relay: false }, ...ancestors.map((ancestor) => ({
      id: crypto.randomUUID(),
      relay: true,
      // 中継したカードに「常に許可」は出さない。「常に許可」は子の会話で今後も通す約束で、
      // 依頼元の画面からは子が今後何をするのか見えないまま恒久的な許可を与えることになる。
      // 子の会話を開けば従来どおり押せる。
      payload: { ...payload, sessionId: ancestor, canAlways: false, title: `委譲先「${childTitle}」${title ? ` / ${title}` : ""}` },
    }))];
    const onAbort = () => settle({ allow: false, message: "中断された" });
    const settle = (answer) => {
      // どれか1つで決着し、残りの複製も消す。1つも残っていなければ二重解決
      let found = false;
      for (const card of cards) if (runtime.waiting.delete(card.id)) found = true;
      if (!found) return;
      signal?.removeEventListener?.("abort", onAbort);
      resolve(answer);
      permissionsChanged();
    };

    for (const card of cards) runtime.waiting.set(card.id, { settle, payload: card.payload, askedAt: new Date().toISOString(), relay: card.relay });
    signal?.addEventListener?.("abort", onAbort, { once: true });

    // 送れなければ黙って待つ。戻ってきたら attach() が聞き直し、
    // 戻らなければ猶予切れがターンごと中断する。
    let sent = false;
    for (const card of cards) if (sendTo({ kind: P.EVENT, event: { ...card.payload, id: card.id } })) sent = true;
    if (!sent) {
      if (graceExpired()) return giveUp();
      console.log(`  host が居ないので承認を保留: ${toolName}`);
    }
    permissionsChanged();
  });
};

const outbox = createMessageQueue({
  store,
  active: id => {
    const turn = runtime.turns.get(id);
    if (!turn) {
      if (switching.has(id) || forking.has(id)) return { blocked: true, wait: { reason: 'turn' } };
      return null;
    }
    const steer = turn.control.steer;
    // 送るのは outbox の item そのもの（本文だけではない）。バックエンドは item.id を
    // 相手に預け、「渡った」合図（userMessage.delivered）でこの id を返してくる
    return { turn, blocked: turn.ac.signal.aborted || Boolean(turn.outcome),
      steer: steer ? item => steer(item) : null };
  },
  start: runTurn,
  changed: (sessionId, messages) => emitGlobal({ type: 'outbox', sessionId, messages }),
  delivered: async (sessionId, item, { turn }) => {
    // 受理と「エージェントに渡った」は別。後から合図を出せるバックエンド（steerConfirms）の分だけ
    // pending を立て、画面は渡るまで待っていることを出す。出せないバックエンドは今までどおり即時扱い
    emitGlobal({ type: 'userMessage', sessionId, messageId: item.id, text: item.args.prompt, at: item.at,
      ...(turn.control.steerConfirms ? { pending: true } : {}) });
    if (item.args.attachments?.length) {
      (turn.steeredAttachments ??= []).push({ key: item.id, prompt: item.args.prompt });
      await presentAttachments(sessionId, item.args.attachments, makeEmit({ ...turn, presentKey: item.id }));
    }
  },
});
await outbox.recover();
agentTasks = await createAgentTasks({
  dataDir: store.dataDir,
  changed: () => { broadcastRunning(); },
  // 人間の承認を待っているか。承認は core/server.mjs 側にしかないので判定を渡す。
  // 中継の複製も数える（孫が止まっていれば、その子も止まっている）
  waiting: sessionId => [...runtime.waiting.values()].some(w => w.payload.sessionId === sessionId),
  rollback: async ({ sessionId }) => { await deleteUnsentConversation(sessionId); await store.removeSession(sessionId); releaseAgentConnection(sessionId); },
  prepare: async (owner, args, taskId, signal) => {
    const parent = runtime.turns.get(owner);
    if (!parent || signal?.aborted) throw new Error('依頼元の会話は終了しています');
    const backend = getBackend(args.backend);
    if (!backend) throw new Error('指定したバックエンドは有効ではありません');
    const cwd = path.resolve(parent.info.cwd, args.cwd ?? '.');
    if (!(await fs.stat(cwd)).isDirectory()) throw new Error('cwd はディレクトリを指定してください');
    // 接続先（決定 3）: 同じエージェントへの委譲なら親の会話の接続先を継ぐ。違うエージェントへは公式に戻す（形式が合わない）
    const parentEndpoint = (await store.get(owner)).compatEndpoint ?? '';
    const inherited = endpointCapable(backend) ? delegatedEndpoint(parent.backend?.id, backend.id, parentEndpoint) : '';
    const endpoint = inherited && await compatEndpoints.has(inherited, backend.id) ? inherited : '';
    const model = await resolveModel(null, args.model, backend, cwd, endpoint);
    const effort = await resolveEffort(null, args.effort, backend, model, cwd, await endpointRow(endpoint));
    // 承認モードは委譲を受け付けた側（agentBridge の call）が親の強さから決めてある。
    // ここで決め直すと「聞いた内容」と「実際に動く強さ」がずれるので、来た値をそのまま使う。
    const modes = backend.modes();
    const mode = modes[args.mode] ? args.mode : firstMode(modes);
    const info = { title: args.task.slice(0, 80), cwd, createdAt: Date.now(), lastModified: Date.now() };
    const sessionId = await createConversation(backend, info);
    try {
      await store.setMeta(sessionId, { ...info, backend: backend.id, unsent: true });
      await store.setMode(sessionId, mode); await store.setModel(sessionId, model);
      await store.setSessionData(sessionId, 'effort', effort);
      await store.setSessionData(sessionId, 'delegation', { taskId, parentSessionId: owner, manager: 'ply' });
      // 子は親の会話のアカウントで走る（親が別のエージェントでも、その会話で選んであるものを継ぐ）
      const parentAccount = (await store.get(owner)).claudeAccount ?? '';
      if (parentAccount) await store.setSessionData(sessionId, 'claudeAccount', parentAccount);
      if (endpoint) await store.setSessionData(sessionId, 'compatEndpoint', endpoint);
      if (signal?.aborted) throw new Error('中断しました');
    } catch (e) { await deleteUnsentConversation(sessionId); await store.removeSession(sessionId); releaseAgentConnection(sessionId); throw e; }
    return { backend: backend.id, model, effort, cwd, mode, sessionId };
  },
  execute: async (task, prompt, signal) => {
    if (signal.aborted) return { outcome: 'aborted' };
    if (sessionBusy(task.sessionId)) return { requeue: true };
    const execution = { outcome: null, error: null };
    taskExecutions.set(task.sessionId, execution);
    const stopChild = () => {
      runtime.turns.get(task.sessionId)?.ac.abort();
      getBackend(task.backend)?.stopSession?.(task.sessionId);
    };
    signal.addEventListener('abort', stopChild, { once: true });
    try {
      const outcome = await runTurn({ sessionId: task.sessionId, backend: task.backend, prompt }, () => {}, { signal });
      if (outcome === 'requeue') return { requeue: true };
      // A child can itself delegate. Its result is final only after those results
      // have been delivered and it has finished responding to them.
      const childrenBusy = () => agentTasks.list(task.sessionId).some(r => ['queued', 'running', 'cancelling'].includes(r.status) || ['pending', 'delivering'].includes(r.notification));
      while (!signal.aborted && (sessionBusy(task.sessionId) || runtime.background.has(task.sessionId) || childrenBusy())) await waitFree(task.sessionId, 250);
      const backend = await resolveBackendForSession(task.sessionId);
      const messages = await backend.getMessages(task.sessionId, { fullResults: true });
      const last = messages.findLast(m => m.role === 'assistant' && m.text);
      if (agentTasks.list(task.sessionId).some(r => r.notification === 'unknown')) return { outcome: 'error', text: last?.text ?? '', error: '子タスクの完了通知を確認できませんでした。子の会話を確認してください' };
      return { outcome: signal.aborted ? 'aborted' : execution.outcome ?? outcome, text: last?.text ?? '', error: execution.error };
    } finally { signal.removeEventListener('abort', stopChild); taskExecutions.delete(task.sessionId); }
  },
  deliver: async task => {
    const owner = task.parentSessionId;
    if (sessionBusy(owner) || runtime.background.has(owner) || (await outbox.list(owner)).some(m => !['sent', 'cancelled'].includes(m.status))) return 'requeue';
    const prompt = `[Pleiad タスク完了通知 / ${task.taskId}]\n実行先: ${task.backend}\n状態: ${task.status}\n依頼: ${task.task}\n結果（子エージェントの報告）:\n${task.result.slice(0, 16000)}${task.result.length > 16000 ? '\n続きは ply_task_status の offset: 16000 で取得できます。' : ''}\n${task.error ?? ''}\n元の依頼に必要な作業を続けてください。`;
    return runTurn({ sessionId: owner, prompt }, () => {}, { internal: true });
  },
});

// ターンの外で起きたことをバックエンドから受け取る口（docs/multi-backend.md §2.7）。
// codex（バックグラウンド端末）が使う
for (const b of listBackends()) {
  b.attachHost?.({
    background: (sessionId, tasks) => setBackground(b, sessionId, tasks),
    event: (sessionId, event) => emitOutsideTurn(sessionId, event),
  });
}

async function runTurn(args, onStarted = () => {}, hooks = {}) {
  const releaseUpdateGate = updateGate.enter();
  try {
    return await runTurnInternal(args, onStarted, hooks);
  } finally { releaseUpdateGate(); }
}

async function runTurnInternal(args, onStarted, hooks) {
  const { prompt, sessionId = null } = args ?? {};
  if ((hooks.internal || hooks.signal) && (sessionBusy(sessionId))) return 'requeue';
  if (switching.has(sessionId) || forking.has(sessionId)) throw new Error("エージェントを切り替え中です");
  // 同じセッションの二重実行は防ぐ。別のセッションなら並行して回してよい
  if (sessionId && runtime.turns.has(sessionId)) throw new Error("このセッションは実行中");
  if (sessionId) switching.add(sessionId);
  try {

    // 行き先が決まらないターンは始めない。断るのは登録する前。
    await settingsWrites.get(sessionId);
    let backend = refuseRetired(await pickBackend(sessionId, args?.backend));
    const reserved = sessionId ? (await store.get(sessionId)).nextSettings : null;
    const { cwd, changedFrom } = await resolveCwd(sessionId, reserved?.cwd ?? args?.cwd, backend);
    // Claude のアカウント。削除済み・トークンが読めないものを選んでいる会話は、ここで止める
    // （黙ってログイン中のアカウントで走らせない）。予約の切り替えより前に確かめる
    const accountBackend = (reserved && getBackend(reserved.backend)) || backend;
    // 互換の接続先（'' = 公式）。削除済み・確認に失敗している・キーを読めないものを選んでいる会話は、ここで止める
    // （黙って公式で走らせない。アカウントと同じ扱い）。新しい会話は、設定で「既定にする」を押した接続先（無ければ公式）
    const endpointId = !endpointCapable(accountBackend) ? ''
      : reserved?.endpoint !== undefined ? reserved.endpoint
      : sessionId ? (await store.get(sessionId)).compatEndpoint ?? ''
      : typeof args?.endpoint === 'string' ? args.endpoint : await compatEndpoints.defaultFor(accountBackend.id);
    const endpoint = endpointId ? await compatEndpoints.resolve(endpointId, accountBackend.id) : null;
    const endpointInfo = endpointId ? await endpointRow(endpointId) : null;
    // Claude のアカウント。互換の接続先では使わない（接続先のキーで送る）ので引かない
    const accountId = reserved?.account !== undefined ? reserved.account : sessionId ? (await store.get(sessionId)).claudeAccount ?? "" : "";
    const account = !endpoint && accountBackend.capabilities?.claudeAccounts ? await claudeAccounts.resolve(accountId) : null;
    if (reserved) {
      const target = getBackend(reserved.backend);
      if (!target || !await validModel(target, reserved.model, cwd, endpointId) || (reserved.mode !== undefined && !target.modes()[reserved.mode])) throw new Error("予約した設定は使用できません。選び直してください");
      await validateEffort(target, reserved.effort ?? '', reserved.model, cwd, endpointInfo);
      if (target.id !== backend.id) await switchBackend(sessionId, backend, target);
      backend = target;
    }
    // 再開のセッションの作業ディレクトリを人が変えた。status / title と同じく履歴に残し、一覧と会話に知らせる。
    // エージェントが新しい cwd でセッションを見つけられるかはエージェント次第（claude は init の id で確かめる）
    if (changedFrom) {
      await store.recordChange(sessionId, { by: "human", field: "cwd", from: changedFrom, to: cwd, reason: "再開時に変更", backend });
      emitGlobal({ type: "cwd", sessionId, cwd, by: "human", reason: `${changedFrom} から` });
    }
    const permissionMode = await resolveMode(sessionId, reserved ? reserved.mode : args?.mode, backend);
    const model = await resolveModel(sessionId, reserved ? reserved.model : args?.model, backend, cwd, endpointId);
    const effort = await resolveEffort(sessionId, reserved ? reserved.effort ?? "" : args?.effort, backend, model, cwd, endpointInfo);
    if (sessionId) {
      await store.setModel(sessionId, model);
      await store.setSessionData(sessionId, "effort", effort);
      if (reserved?.account !== undefined) await store.setSessionData(sessionId, 'claudeAccount', reserved.account);
      if (reserved?.endpoint !== undefined) await store.setSessionData(sessionId, 'compatEndpoint', reserved.endpoint);
      await store.setMode(sessionId, permissionMode);
      await store.setMeta(sessionId, { cwd, unsent: false, lastModified: Date.now() });
      if (reserved) {
        await store.setSessionData(sessionId, "nextSettings", null);
        emitGlobal({ type: "backend", sessionId, backend: backend.id, applied: true });
        emitGlobal({ type: "nextSettings", sessionId, nextSettings: null });
      }
    }

    // 新規のときだけ効く状態。再開したセッションの状態は setStatus で変える
    const status = !sessionId && typeof args?.status === "string" && args.status.trim()
      ? args.status.trim() : null;
    // 入力欄に溜めていた添付（attachFile が置いたもの）。送信と一緒に会話へ載せる
    const attachments = Array.isArray(args?.attachments) ? args.attachments.slice(0, 20) : [];
    const baseline = await history.loadTranscript(sessionId, backend);
    // 前のターンまでのサブエージェント。listSubagents は全期間の分を返すので、実行中一覧から外すために覚える。
    // CLI を起こす前に取る（後で取ると、このターンで生まれた分まで前の分に数えてしまう）
    const pastSubagents = new Set(sessionId && backend.listSubagents
      ? await backend.listSubagents(sessionId).catch(() => []) : []);
    const previousContext = sessionId ? (await store.get(sessionId)).contextSession : null;
    let policy = previousContext?.policy ?? contextPolicy(await contextSettings.get(cwd));
    if (!previousContext && baseline.messages.length) policy.owners = { ...DEFAULT_OWNERS };
    // 再開で作業場所が変わった。担当（owners）と「この会話では外す」MCP は会話の方針として保ち、探索の計画だけを
    // 新しい場所の設定で解き直す（作業場所側の探索元・除外・追加フォルダーは場所ごとの設定のため）。
    // 探し直した結果は下の読み込み直し（refreshedContext）と同じ扱いで記録・通知される。
    // policy.cwd は実体パス（contextSettings.get が realpath する）。cwd は渡された表記のままなので、実体どうしで比べる
    if (previousContext && managed(policy) && pathKey(policy.cwd) !== pathKey(await fs.realpath(cwd).catch(() => cwd))) {
      const here = await contextSettings.get(cwd);
      const { user, directory, ...rest } = policy;
      policy = { ...rest, version: 2, cwd: here.cwd, plan: here.plan };
    }
    // Pleiad 担当のコンテキストを受け取れないバックエンド（antigravity）では、担当が Pleiad でもエージェント任せとして扱う。
    // 開いても届かない上に、外部 MCP へ無駄に接続（stdio なら起動）してしまう
    const plyContext = managed(policy) && acceptsPlyContext(backend, policy);
    const resolvedContext = plyContext ? await resolveRuntime(policy, { plyServers: await plyMcp.scanInput(), snapshots: CONTEXT_SNAPSHOTS }) : null;
    // 開始時の固定と違う＝指示・Skills が変わった。止めずに今の内容で続ける（resolvedContext が今のファイルで解き直した結果なので、
    // 記録も pin も自動で新しくなる）。指示本文は毎ターン指示欄へ渡し直し、Skills はカタログしか渡していないので技術的な制約は無い。
    // 右パネルの「渡したもの」との食い違いだけが問題なので、読み込み直したことを履歴と会話に残す
    const refreshedContext = Boolean(plyContext && previousContext?.pin && resolvedContext?.pin !== previousContext.pin);
    // instructions_for_path / load_skill で渡し済みの本文の控え（行の id → 本文のハッシュ）。会話の記録に残して
    // 次のターンへ持ち越し、同じものを頼まれたら短い一行だけを返す（core/context-runtime.mjs の contextTools）。
    // 履歴を引き継ぎの文で渡し直すターン（バックエンドの切り替え・ホスト側で写した分岐）と、記録した相手と違うバックエンドでは捨てる。
    // 渡した本文が相手の手元に残っているとは限らないため
    const handoff = await pendingHandoff(sessionId).catch(() => true);
    const delivered = !handoff && previousContext?.delivered?.backend === backend.id ? { ...previousContext.delivered.entries } : {};
    if (resolvedContext) resolvedContext.delivered = delivered;
    // エージェント任せにしたターンでも固定（pin）は捨てない。Pleiad 担当を受け取れるエージェントへ戻したときに突き合わせる
    const contextRecord = { policy: refreshedContext ? { ...policy, refreshedAt: new Date().toISOString() } : policy,
      pin: resolvedContext?.pin ?? (plyContext ? null : previousContext?.pin ?? null), report: resolvedContext?.report ?? nativeContextReport(policy, cwd, backend),
      delivered: { backend: backend.id, entries: delivered } };
    if (refreshedContext) {
      // 何が変わったかは前の記録と今の記録の突き合わせで出す（pinChanges を呼ぶと同じターンで探索がもう一度走る）
      const changed = pinnedChanges(previousContext.report?.entries ?? [], resolvedContext.report.entries);
      const names = changed.map(c => c.name || path.basename(c.path ?? '')).filter(Boolean).slice(0, 3);
      const reason = names.length ? `${names.join('・')}${changed.length > names.length ? ` ほか ${changed.length - names.length} 件` : ''}` : '指示・Skills を読み込み直した';
      await store.recordChange(sessionId, { by: 'ply', field: 'context', from: previousContext.pin, to: resolvedContext.pin, reason, backend });
      emitGlobal({ type: 'contextRefreshed', sessionId, names, count: changed.length });
    }
    const turn = {
      stream: {
        ...structuredClone(baseline),
        user: hooks.internal ? null : { role: "user", text: String(prompt ?? ""), at: new Date().toISOString(), backend: backend.id },
        events: [],
      },
      key: sessionId ?? `new:${crypto.randomUUID()}`,
      ac: new AbortController(),
      backend,
      control: { handle: null, onReady: () => outbox.kick(sessionId).catch(() => {}) },
      outcome: null,
      contextRecord,
      taskHints: new Map(),
      pastSubagents,
      subagentOrigins: new Map(),
      presentKey: crypto.randomUUID(),
      presentWrites: [],
      info: {
        sessionId,
        backend: backend.id,
        startedAt: new Date().toISOString(),
        cwd,
        mode: permissionMode,
        model: model || "",
        effort,
        endpoint: endpointId,
        status,
        attachments,
        // active = main が動いている / waiting = main は返答済みで、裏の subagent などを待っている
        phase: "active",
        background: [],
      },
    };
    if (hooks.signal?.aborted) turn.ac.abort();
    const abortFromTask = () => turn.ac.abort();
    hooks.signal?.addEventListener('abort', abortFromTask, { once: true });
    runtime.turns.set(turn.key, turn);
    for (const read of liveReads) if (read.sessionId === sessionId) read.turn = turn;
    const emit = makeEmit(turn);
    turn.visualizations = createVisualizationCollector({
      roots: [cwd],
      publish: async payload => {
        await turn.setup;
        const id = turn.info.sessionId;
        if (!id) throw new Error('会話がまだ開始されていません');
        const record = await history.recordPresent(id, { ...payload, turnKey: turn.presentKey });
        emit({ type: 'present', sessionId: id, ...record }, { recorded: true });
      },
    });

    let didStart = false, runtimeContext;
    const saveContext = async () => {
      await turn.setup;
      if (turn.info.sessionId) await store.setSessionData(turn.info.sessionId, 'contextSession', contextRecord);
      emit({ type: 'contextUsage', report: structuredClone(contextRecord.report) });
    };
    try {
      await onStarted();
      didStart = true;
      if (hooks.internal) {
        const hashes = (await store.get(sessionId)).taskNotices ?? [];
        const digest = crypto.createHash('sha256').update(prompt).digest('hex');
        await store.setSessionData(sessionId, 'taskNotices', [...new Set([...hashes, digest])]);
        emit({ type: 'taskNotice' });
      }
      await saveContext();
      // agy のように会話のあいだ 1 本のプロセスを生かすバックエンドには、会話ごとの同じトークンで開く（起動時にしか渡せない）
      if (resolvedContext) runtimeContext = await contextBridge.open({ runtime: resolvedContext, prompt,
        ...(backend.capabilities?.plyContext === 'conversation' ? { token: conversationConnection(turn).contextToken } : {}),
        origin: localOrigin(), signal: turn.ac.signal,
        isActive: () => runtime.turns.get(turn.key) === turn && !turn.ac.signal.aborted, changed: saveContext,
        authorize: backend.id === 'codex' && !['full','yolo'].includes(permissionMode)
          ? async (serverName, toolName, input) => Boolean((await askPermission({ toolName: `${serverName} / ${toolName}`, input, sessionId: turn.info.sessionId, signal: turn.ac.signal, kind: 'tool', canAlways: false }))?.allow)
          : undefined });
      if (args.messageId) emit({ type: "userMessage", messageId: args.messageId, text: String(prompt ?? ""), at: args.at, initial: true });
      broadcastRunning();
      syncRunningPoll();
      // 再開なら id が分かっているので先に載せる。新規は session イベントで id が決まった瞬間に（makeEmit）
      if (sessionId && attachments.length) await presentAttachments(sessionId, attachments, emit);
      if (hooks.signal?.aborted) throw new Error('中断しました');
      const result = await backend.runTurn({
        prompt,
        sessionId,
        cwd,
        mode: permissionMode,
        model: model || undefined,
        effort,
        emit,
        askPermission,
        signal: turn.ac,
        control: turn.control,
        visualizeInstructions: VISUALIZE_INSTRUCTIONS,
        contextRuntime: runtimeContext,
        agentRuntime: agentConnection(turn),
        // 会話で選んだアカウントのトークン。この会話の query() の env にだけ入る（core/claude-accounts.mjs）
        ...(account ? { oauthToken: account.token } : {}),
        // 互換の接続先（キーを含む。backend の中でだけ使い、ログ・イベントには出さない。core/compat-endpoints.mjs）
        ...(endpoint ? { endpoint } : {}),
      });
      // 相手が別のターンを走らせていて、何も届かなかった。
      // 完了ではない。送信待ちへ戻し（message-queue）、そのターンが終わってから送り直す
      if (result?.requeue) turn.outcome = "requeue";
      await turn.visualizations.close();
      // Complete any accepted steering write before releasing the live snapshot.
      if (sessionId) await outbox.list(sessionId);
      if (turn.info.sessionId) {
        await turn.setup;
        if (attachments.length || turn.steeredAttachments?.length) {
          await Promise.all(turn.presentWrites);
          const messages = await backend.getMessages(turn.info.sessionId);
          let cursor = baseline.messages.length;
          for (const attachment of [{ key: turn.presentKey, prompt }, ...(turn.steeredAttachments ?? [])]) {
            const index = messages.findIndex((m, i) => i >= cursor && m.role === 'user' && m.text === attachment.prompt);
            if (index < 0) continue;
            cursor = index + 1;
            await history.anchorAttachments(turn.info.sessionId, attachment.key, messages[index].uuid);
          }
        }
        await store.setMeta(turn.info.sessionId, { lastModified: Date.now() }).catch(() => {});
      }
    } catch (err) {
      if (resolvedContext) { contextRecord.report.status = 'failed'; await saveContext().catch(() => {}); }
      emit({ type: "turnResult", outcome: "error", error: String(err?.message ?? err) });
      if (!didStart) throw err;
    } finally {
      if (didStart && turn.outcome !== 'ok' && turn.outcome !== 'requeue') await outbox.pause(sessionId).catch(() => {});
      await turn.visualizations.close().catch(err => emit({ type: 'turnResult', outcome: 'error', error: `可視化を保存できませんでした: ${err.message}` }));
      await Promise.allSettled([runtimeContext?.close()]);
      await saveContext().catch(() => { emit({ type: 'turnResult', outcome: 'error', error: 'コンテキストの利用記録を保存できませんでした' }); });
      await endTurn(turn, emit, { record: didStart });
      hooks.signal?.removeEventListener("abort", abortFromTask);
    }
    return turn.outcome;
  } finally {
    switching.delete(sessionId);
    notifyFree(sessionId);
    await kickQueued();
  }
}

/**
 * ターンの後始末。使用量と完了時刻を残し、turnEnd を出して一覧から外す。
 * requeue（相手が別のターンを走らせていて何も届かなかった）は完了ではないので、使用量も完了時刻も残さない。
 */
async function endTurn(turn, emit, { record = true } = {}) {
  const requeued = turn.outcome === "requeue";
  const completedAt = requeued ? null : Date.now();
  if (record && !requeued) await usageStore.record({ ...turn.usage, id: turn.presentKey, backend: turn.backend.id })
    .catch(() => { console.error('  使用量を記録できませんでした'); });
  if (turn.info.sessionId) {
    await turn.setup?.catch(() => {});
    if (!requeued) await store.setMeta(turn.info.sessionId, { completedAt }).catch(err => {
      console.error("  完了の記録に失敗:", String(err?.message ?? err));
    });
  }
  // Retain turnEnd in snapshots already being read, then release the turn.
  emit({ type: "turnEnd", completedAt, outcome: turn.outcome, ...(requeued ? { requeued: true } : {}) });
  runtime.turns.delete(turn.key);
  notifyFree(turn.key);
  syncRunningPoll();
  // 片付けるのはこのセッションの承認待ちだけ。他のターンの分は残す
  settleAll("ターンが終わった", turn.info.sessionId);
  broadcastRunning();
}

/** 送信待ちが残っている会話を全部 kick する。ターンが終わるたびに呼ぶ。 */
async function kickQueued() {
  for (const [id, meta] of Object.entries(await store.getAll())) {
    if (meta.outbox?.some(m => m.status === 'queued')) outbox.kick(id).catch(() => {});
  }
}

// ---- ターンの外（docs/multi-backend.md §2.7）----------------------------------
//

// 同じ会話のターン（準備中を含む）が終わるのを待つ
const sessionBusy = (id) => runtime.turns.has(id) || switching.has(id) || forking.has(id);
const freeWaiters = new Map();   // sessionId -> Set<() => void>
function notifyFree(id) {
  for (const done of [...(freeWaiters.get(id) ?? [])]) done();
}
function waitFree(id, ms) {
  return new Promise((resolve) => {
    let set = freeWaiters.get(id);
    if (!set) freeWaiters.set(id, (set = new Set()));
    const done = () => {
      clearTimeout(timer);
      set.delete(done);
      if (!set.size && freeWaiters.get(id) === set) freeWaiters.delete(id);
      resolve();
    };
    // 解放を知らせない経路（切り替え・分岐の終わり）の保険
    const timer = setTimeout(done, ms);
    timer.unref?.();
    set.add(done);
  });
}

/**
 * 会話に紐づく、ターンの外で裏に残っている作業。バックエンドが全量で渡し、空で消える。
 * running の background に載り、web は一覧の行と稼働表示を衛星にする（design-system.md §6.1）。
 */
function setBackground(backend, sessionId, tasks) {
  if (!sessionId) return;
  const list = (Array.isArray(tasks) ? tasks : [])
    .filter((x) => x && typeof x.id === "string" && x.id)
    .map((x) => ({
      id: x.id,
      kind: ["agent", "shell", "terminal", "other"].includes(x.kind) ? x.kind : "other",
      label: String(x.label ?? "").slice(0, 200),
      // 終わりの通知が必ず来るか（§2.2）。落とすと web が待っていることを出せなくなる
      ...(x.waitable === true ? { waitable: true } : {}),
    }));
  const had = runtime.background.get(sessionId);
  if (!list.length) {
    if (!had) return;
    runtime.background.delete(sessionId);
  } else {
    if (had && JSON.stringify(had.tasks) === JSON.stringify(list)) return;
    runtime.background.set(sessionId, { sessionId, backend: backend.id, tasks: list, since: had?.since ?? new Date().toISOString() });
  }
  syncRunningPoll();
  broadcastRunning();
}

/**
 * 裏で動いているタスクを 1 本引く。読む（loadBackground）と止める（stopBackground）が使う。
 *
 * 置き場は 2 つある。ターンの外に残っているもの（Codex の `runtime.background`）と、
 * 走っているターンが抱えているもの（Claude の `turn.info.background`。§2.2 の phase: waiting）。
 * 画面はどちらも同じ行として並べるので、ここで両方を見る。
 */
function findBackgroundTask(sessionId, taskId) {
  const known = runtime.background.get(sessionId);
  const outside = known?.tasks.find((x) => x.id === taskId);
  if (outside) return { task: outside, backend: getBackend(known.backend), backendId: known.backend };
  const turn = runtime.turns.get(sessionId);
  const inTurn = turn?.info.background?.find((x) => x.id === taskId);
  if (inTurn) return { task: inTurn, backend: turn.backend, backendId: turn.backend.id };
  return null;
}

/**
 * ターンの外で起きた、会話に属する正規化イベント（docs/multi-backend.md §2.7）。
 * 今の用途は 1 つだけ: Codex のバックグラウンド端末が、ターンが終わったずっと後に終わったとき、
 * 走ったままに見えているツールカードへ結果を差し込む。
 * ターンを作らないので `running` にも使用量にも出ない。何でも流せる口にはしない
 * （本文や turnResult をターンの外から出すと、web の吹き出し・稼働表示の前提が崩れる）。
 */
const OUTSIDE_TURN_EVENTS = new Set(["tool.result"]);
function emitOutsideTurn(sessionId, event) {
  if (!sessionId || !OUTSIDE_TURN_EVENTS.has(event?.type)) return;
  emitGlobal({ ...event, sessionId });
}

wss.on("connection", (ws) => {
  // 古い接続を閉じてはいけない。クライアントは切れると自動再接続するので、
  // 「新しい方に付け替える」と互いに閉じ合って永久に落ち着かなくなる。
  // タブが複数あってもよい設計にして、イベントは全部に配る。
  const resumed = runtime.turns.size > 0;
  attach(ws);
  sendTo({
    kind: P.READY,
    protocolVersion: P.PROTOCOL_VERSION,
    version: APP_VERSION,
    homeDir: os.homedir(),
    resumedTurn: resumed,
  });
  ws.on("close", () => detach(ws));

  ws.on("message", async (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg?.kind !== P.COMMAND || !P.COMMANDS.has(msg.command)) return;

    // Command IDs are scoped to a socket. Broadcast events, never private replies
    // (connection-check receipts and concurrent clients can share the same ID).
    const reply = (ok, payload) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ kind: P.RESPONSE, id: msg.id ?? null, ok, ...(ok ? { result: payload } : { error: payload }) }));
    };

    let releaseUpdateGate;
    try {
      releaseUpdateGate = updateGate.enter();
      switch (msg.command) {
        case 'listMcpConfig':
          return reply(true, await mcpConfig.list(msg.args));
        case 'readMcpServer':
          return reply(true, await mcpConfig.get(msg.args));
        case 'saveMcpServer':
          return reply(true, await mcpConfig.save(msg.args));
        // ---- Pleiad 自身の MCP 登録と、その認証（担当が Pleiad のときに使う）。秘密の値は返さない
        case 'listPlyMcp': {
          const data = await plyMcp.list();
          const servers = await Promise.all(data.servers.map(async s => ({ ...s, authStatus: s.auth === 'oauth' ? await mcpOAuth.status(s.name, await plyMcp.registration(s.name)) : null })));
          return reply(true, { ...data, servers, storage: await mcpSecrets.status(), settings: await plyMcp.settings() });
        }
        case 'setPlyMcpSettings':
          return reply(true, await plyMcp.setSettings(msg.args ?? {}));
        case 'renamePlyMcp': {
          // 秘密・OAuth の状態・リフレッシュのロック名を引き継いで名前だけ変える
          const name = msg.args?.name, to = msg.args?.to;
          const renamed = await plyMcp.rename(name, to, { guard: (definition, fn) => mcpOAuth.rename(name, to, definition, fn) });
          // 設定 › コンテキストで名前で指したもの（外す・同じ名前の定義の選択）も新しい名前へ
          const followed = await contextSettings.renameMcp(name, to, { plyFile: (await plyMcp.scanInput()).file }).catch(() => 0);
          return reply(true, { ...renamed, settingsUpdated: followed });
        }
        case 'importPlyMcp':
          // Claude / Codex の登録を取り込む。トークンは流用しない（core/mcp-import.mjs の先頭のコメント）
          return reply(true, await importNativeMcp({ items: msg.args?.items, includeSecrets: msg.args?.includeSecrets === true, mcpConfig, plyMcp,
            detect: definition => mcpOAuth.detect(definition) }));
        case 'readPlyMcp':
          return reply(true, await plyMcp.read(msg.args?.name));
        case 'savePlyMcp': {
          const saved = await plyMcp.save(msg.args ?? {});
          if (saved.oauthReset) mcpOAuth.cancel(saved.name);
          return reply(true, { ...saved, storage: await mcpSecrets.status() });
        }
        case 'deletePlyMcp': {
          const name = msg.args?.name, definition = await plyMcp.registration(name);
          // 消す前に失効させる（トークンを残したまま登録だけ消さない）
          const logout = definition.auth === 'oauth' ? await mcpOAuth.logout(name, definition, await plyMcp.connection(name, process.cwd()).catch(() => null)).catch(e => ({ revoked: false, reason: e.message })) : null;
          return reply(true, { ...(await plyMcp.remove(name)), logout });
        }
        case 'mcpAuthStart': {
          const name = msg.args?.name, definition = await plyMcp.registration(name);
          return reply(true, await mcpOAuth.start(name, definition, await plyMcp.connection(name, process.cwd())));
        }
        case 'mcpAuthStatus': {
          const names = msg.args?.name ? [msg.args.name] : (await plyMcp.list()).servers.map(s => s.name);
          const rows = await Promise.all(names.map(async n => mcpOAuth.status(n, await plyMcp.registration(n))));
          return reply(true, { servers: rows, storage: await mcpSecrets.status() });
        }
        case 'mcpAuthLogout': {
          const name = msg.args?.name, definition = await plyMcp.registration(name);
          return reply(true, await mcpOAuth.logout(name, definition, await plyMcp.connection(name, process.cwd()).catch(() => null)));
        }
        case 'mcpReconnect': {
          // 接続はターンごとに作り直すので、ここでは今の資格情報でつながるかを確かめる（期限切れならリフレッシュもする）
          const name = msg.args?.name, definition = await plyMcp.registration(name);
          const result = await connectServer({ id: 'manual', name, origins: [{ source: 'ply' }], definition }, { cwd: msg.args?.cwd ?? process.cwd(), plyMcp, oauth: mcpOAuth });
          await result.client?.close().catch(() => {});
          return reply(true, { name, status: result.status, tools: result.tools?.length ?? 0, reason: result.reason ?? null });
        }
        case 'contextSettings':
          return reply(true, await contextSettings.view(msg.args?.cwd ?? null));
        case 'sessionContext': {
          const saved = msg.args?.sessionId ? (await store.get(msg.args.sessionId)).contextSession : null;
          if (!saved?.report) return reply(true, null);
          // 固定された会話だけ、今のファイルと突き合わせる（ネイティブの会話では探索しない）。
          // 別のスキャンが走っている間は突き合わせを飛ばす（同じ接続で二重に探索しない）
          let changed = null;
          if (saved.pin && !ws.contextScanning) {
            ws.contextScanning = true;
            try { changed = await pinChanges(saved); }
            catch { changed = null; }
            finally { ws.contextScanning = false; }
          }
          return reply(true, { report: saved.report, owners: saved.policy?.owners ?? saved.report.owners, pinned: Boolean(saved.pin), changed,
            startedAt: saved.policy?.at ?? null, refreshedAt: saved.policy?.refreshedAt ?? null, removedMcp: saved.policy?.removedMcp ?? [] });
        }
        case 'refreshContext':
          await contextSession.refresh(msg.args?.sessionId);
          return reply(true, { ok: true });
        case 'contextDiff':
          return reply(true, await contextSession.diff(msg.args?.sessionId));
        case 'setSessionMcp':
          await contextSession.setMcp(msg.args?.sessionId, msg.args?.name, msg.args?.removed !== false);
          return reply(true, { ok: true });
        case 'agentMcp':
          return reply(true, await contextSession.agentMcp((await contextSettings.get(msg.args?.cwd ?? process.cwd())).cwd));
        case 'setContextSettings':
          return reply(true, await contextSettings.set(msg.args ?? {}));
        case 'scanContext': {
          // One scan at a time per connection; no changes to running turns.
          // place: 'default' なら場所ごとの上書きを使わず既定だけで探す（設定の「すべての場所」）
          if (ws.contextScanning) throw new Error('スキャン中です');
          ws.contextScanning = true;
          try { return reply(true, await scanContext(await contextSettings.get(msg.args?.cwd ?? process.cwd(), { level: msg.args?.place === 'default' ? 'default' : null }), { plyServers: await plyMcp.scanInput() })); }
          finally { ws.contextScanning = false; }
        }
        case 'slashSkills': {
          // 入力欄の「/」の候補。コンキスト画面と同じ探索をそのまま使い、スキルだけを返す
          if (ws.contextScanning) throw new Error('スキャン中です');
          ws.contextScanning = true;
          try { return reply(true, skillList(await scanContext(await contextSettings.get(msg.args?.cwd ?? process.cwd())))); }
          finally { ws.contextScanning = false; }
        }
        case "listSessions":
          return reply(true, await sessionList());

        // Claude のアカウント（会話ごとに選ぶ）。トークンは返さない（登録済みかどうかだけ）
        // 互換の接続先（core/compat-endpoints.mjs）。キーは返さない。確認の失敗は例外ではなく { ok: false, error, lines } で返す（理由の行を画面に出すため）
        case 'compatEndpoints':
          return reply(true, await compatEndpoints.list(msg.args?.agent));
        case 'compatEndpointCheck': {
          try { return reply(true, await compatEndpoints.check(msg.args?.input, { id: msg.args?.id ?? null })); }
          catch (e) { if (e instanceof CheckError) return reply(true, { ok: false, error: e.message, lines: e.lines ?? [], code: e.code }); throw e; }
        }
        case 'compatEndpointSave': {
          const saved = await compatEndpoints.save(msg.args?.input, msg.args?.receipt, { id: msg.args?.id ?? null });
          emitGlobal({ type: 'compatEndpointsChanged', sessionId: null });
          return reply(true, saved);
        }
        case 'compatEndpointRecheck': {
          const result = await compatEndpoints.recheck(String(msg.args?.id ?? ''));
          emitGlobal({ type: 'compatEndpointsChanged', sessionId: null });
          return reply(true, result);
        }
        case 'compatEndpointDelete': {
          await compatEndpoints.remove(String(msg.args?.id ?? ''));
          emitGlobal({ type: 'compatEndpointsChanged', sessionId: null });
          return reply(true, await compatEndpoints.list());
        }
        case 'compatEndpointDefault': {
          await compatEndpoints.setDefault(String(msg.args?.agent ?? ''), String(msg.args?.id ?? ''));
          emitGlobal({ type: 'compatEndpointsChanged', sessionId: null });
          return reply(true, await compatEndpoints.list());
        }
        case 'claudeAccounts':
          return reply(true, await claudeAccounts.list());
        case 'saveClaudeAccount': {
          const { id, name, token } = msg.args ?? {};
          const saved = await claudeAccounts.save({ id, name, token });
          quotaCache.clear();
          emitGlobal({ type: 'claudeAccountsChanged', sessionId: null });
          return reply(true, { ...saved, ...(await claudeAccounts.list()) });
        }
        case 'deleteClaudeAccount': {
          claudeLogin.cancelAccount(String(msg.args?.id ?? ''));
          await claudeAccounts.remove(String(msg.args?.id ?? ''));
          quotaCache.clear();
          emitGlobal({ type: 'claudeAccountsChanged', sessionId: null });
          return reply(true, await claudeAccounts.list());
        }
        // アカウントの認可（claude setup-token / 使用量の claude auth login）を Pleiad から回す。進み具合は claudeLogin イベント
        case 'claudeLoginStart': {
          const { kind, accountId, name, open } = msg.args ?? {};
          if (accountId && !(await claudeAccounts.has(String(accountId)))) throw new Error('そのアカウントは登録されていません');
          if (kind === 'setup-token' && !accountId) normalizeAccountName(name);
          return reply(true, claudeLogin.start({ kind, accountId: accountId ? String(accountId) : undefined, name: name ? String(name).trim() : undefined, open: Boolean(open) }));
        }
        case 'claudeLoginCode':
          return reply(true, claudeLogin.submitCode(String(msg.args?.loginId ?? ''), msg.args?.code));
        case 'claudeLoginCancel':
          return reply(true, claudeLogin.cancel(String(msg.args?.loginId ?? '')));

        // 使えるエージェントと、その語彙・出し分けの材料
        case 'providerUsage': {
          const backend = getBackend(msg.args?.backend);
          if (!backend) throw new Error('エージェントが見つかりません');
          const quota = backend.usage
            ? await quotaCache(backend.id, async () => backend.usage({ cwd: process.cwd(), ...(backend.capabilities?.claudeAccounts ? await usageAccounts() : {}) }))
            : { windows: [], checkedAt: null, message: 'このエージェントは使用枠の取得に対応していません。' };
          let local;
          try { local = await usageStore.summary(backend.id); }
          catch { local = { error: '使用実績を読み込めませんでした。' }; }
          return reply(true, { backend: backend.id, label: backend.label, quota, local });
        }
        case "backends":
          return reply(true, describeBackends());

        case "setTurnSettings": {
          const { sessionId, backend: targetId, model, mode, cwd: requestedCwd, cancel, account, endpoint } = msg.args ?? {};
          if (!sessionId) throw new Error("セッションが要る");
          if (forking.has(sessionId) || switching.has(sessionId) && !runtime.turns.has(sessionId)) throw new Error("送信の準備中です。設定変更を再試行してください");
          const work = (settingsWrites.get(sessionId) ?? Promise.resolve()).catch(() => {}).then(async () => {
            const source = refuseRetired(await resolveBackendForSession(sessionId));
            if (!source) throw new Error("セッションが見つかりません");
            const current = await store.get(sessionId);
            const target = getBackend(targetId ?? current.nextSettings?.backend ?? source.id);
            if (!target) throw new Error("エージェントが見つかりません");
            const selectedMode = mode ?? (target.id === (current.nextSettings?.backend ?? source.id)
              ? current.nextSettings?.mode : target.id !== source.id ? await resolveMode(null, undefined, target) : undefined);
            if (!cancel && selectedMode !== undefined && !target.modes()[selectedMode]) throw new Error("選択した承認モードは使用できません");
            const settingsCwd = requestedCwd || current.nextSettings?.cwd || current.cwd;
            // 互換の接続先（'' = 公式）。エージェントを変えたら、変えた先の既定（設定で「既定にする」を押したもの。無ければ公式）。
            // 元のエージェントへ戻したら、この会話の今の接続先に戻る
            if (endpoint !== undefined && typeof endpoint !== 'string') throw new Error('接続先の指定が不正です');
            const previousSelection = current.nextSettings?.backend ?? source.id;
            const currentEndpoint = current.compatEndpoint ?? '';
            const previousEndpoint = current.nextSettings?.endpoint ?? currentEndpoint;
            let selectedEndpoint = !endpointCapable(target) ? ''
              : endpoint ?? (target.id === previousSelection ? previousEndpoint : target.id === source.id ? currentEndpoint : await compatEndpoints.defaultFor(target.id));
            if (!cancel && endpoint && !(await compatEndpoints.has(endpoint, target.id))) throw new Error('選択した接続先は登録されていません');
            const endpointChanged = selectedEndpoint !== currentEndpoint;
            // 接続先を変えたらモデルは接続先の既定（メインのモデル）に戻す（公式のモデル名を互換の先へ送らない）
            const selectedModel = model ?? (target.id === previousSelection && selectedEndpoint === previousEndpoint ? current.nextSettings?.model ?? current.model ?? "" : "");
            if (!cancel && !await validModel(target, selectedModel, settingsCwd, selectedEndpoint)) throw new Error("選択したモデルは使用できません");
            const selectedEndpointRow = await endpointRow(selectedEndpoint);
            const previousBackend = current.nextSettings?.backend ?? source.id;
            const previousEffort = target.id === previousBackend ? current.nextSettings?.effort ?? current.effort ?? ''
              : target.id === source.id ? current.effort ?? '' : (await store.getPrefs()).backends?.[target.id]?.effort ?? '';
            const choices = cancel ? { '': {} } : await effortOptions(target, selectedModel, settingsCwd, selectedEndpointRow);
            const selectedEffort = cancel ? '' : msg.args.effort !== undefined
              ? await validateEffort(target, msg.args.effort, selectedModel, settingsCwd, selectedEndpointRow)
              : Object.hasOwn(choices, previousEffort) ? previousEffort : '';
            // Claude のアカウント（'' = ログイン中のアカウント）。モデルと同じく次のターンから効く
            if (account !== undefined && typeof account !== 'string') throw new Error('アカウントの指定が不正です');
            const selectedAccount = account ?? current.nextSettings?.account ?? current.claudeAccount ?? '';
            if (!cancel && account && !(await claudeAccounts.has(account))) throw new Error('選択したアカウントは登録されていません');
            const accountChanged = selectedAccount !== (current.claudeAccount ?? '');
            let selectedCwd = current.nextSettings?.cwd;
            if (!cancel && requestedCwd !== undefined) {
              if (typeof requestedCwd !== "string" || !requestedCwd.trim() || requestedCwd.length > 8192) throw new Error("作業ディレクトリを入力してください");
              selectedCwd = (await resolveCwd(null, path.resolve(requestedCwd.trim()), source)).cwd;
              const info = await source.getSession(sessionId);
              const own = (current.history ?? []).some(h => h?.field === "cwd") ? current.cwd ?? info?.cwd : info?.cwd ?? current.cwd;
              if (own && path.resolve(own) === selectedCwd) selectedCwd = undefined;
            }
            const next = cancel || (source.id === target.id && (current.model ?? "") === selectedModel && (selectedMode === undefined || selectedMode === current.mode) && (current.effort ?? "") === selectedEffort && !selectedCwd && !accountChanged && !endpointChanged)
              ? null : { backend: target.id, model: selectedModel, effort: selectedEffort, ...(selectedMode !== undefined ? { mode: selectedMode } : {}), ...(selectedCwd ? { cwd: selectedCwd } : {}), ...(accountChanged ? { account: selectedAccount } : {}), ...(endpointChanged ? { endpoint: selectedEndpoint } : {}) };
            await store.setSessionData(sessionId, "nextSettings", next);
            if (!cancel) {
              if (targetId !== undefined) await savePref("backend", target.id);
              // 互換の接続先のモデル・段は公式の既定（prefs）に覚えない。接続先の既定は設定の「既定にする」だけで決まる（決定 2）
              if (msg.args.rememberEffort && !selectedEndpoint) await savePref("effort", selectedEffort, target.id);
              if (msg.args.rememberModel && !selectedEndpoint) await savePref("model", selectedModel, target.id);
              if (msg.args.rememberMode && selectedMode !== undefined) await savePref("mode", selectedMode, target.id);
              // 人が選んだ Claude のアカウントは、次に開く新しい会話の既定にする（newSession）
              if (account !== undefined) await savePref("claudeAccount", account || null);
            }
            emitGlobal({ type: "nextSettings", sessionId, nextSettings: next });
            return next;
          });
          settingsWrites.set(sessionId, work);
          try { return reply(true, await work); }
          finally { if (settingsWrites.get(sessionId) === work) settingsWrites.delete(sessionId); }
        }

        case "saveDraft": {
          const { sessionId, text = "", attached = [] } = msg.args ?? {};
          if (!sessionId || !(await resolveBackendForSession(sessionId))) throw new Error("セッションが見つかりません");
          if (typeof text !== "string" || text.length > 2_000_000 || !Array.isArray(attached) || attached.length > 20) throw new Error("下書きが大きすぎます");
          const files = attached.map(a => ({ name: String(a.name ?? ""), path: String(a.path ?? ""), kind: String(a.kind ?? "file"), mime: String(a.mime ?? "") }));
          if (files.some(a => a.path.length > 8192 || a.name.length > 4096)) throw new Error("添付の情報が大きすぎます");
          await store.setSessionData(sessionId, "draft", { text, attached: files });
          if ((await store.get(sessionId)).unsent && typeof msg.args?.cwd === "string") {
            await store.setMeta(sessionId, { cwd: msg.args.cwd });
          }
          return reply(true, "saved");
        }

        case "deleteUnsentSession": {
          const { sessionId } = msg.args ?? {};
          if (!sessionId || switching.has(sessionId) || forking.has(sessionId) || runtime.turns.has(sessionId)
              || (await outbox.list(sessionId)).some(m => !['sent', 'cancelled'].includes(m.status))) throw new Error("実行中または送信待ちのセッションは削除できません");
          switching.add(sessionId);
          try {
            if (!(await store.get(sessionId)).unsent) throw new Error("未送信のセッションだけ削除できます");
            await deleteUnsentConversation(sessionId);
            await store.removeSession(sessionId);
            releaseAgentConnection(sessionId);
            emitGlobal({ type: "sessionsChanged", sessionId: null, deleted: sessionId });
            return reply(true, "deleted");
          } finally { switching.delete(sessionId); }
        }

        case "switchBackend": {
          const { sessionId, backend: targetId } = msg.args ?? {};
          if (!sessionId) return reply(false, "セッションが要る");
          if (runtime.turns.has(sessionId) || switching.has(sessionId) || forking.has(sessionId)) return reply(false, "実行が終わってから切り替えてください");
          switching.add(sessionId);
          try {
            const source = refuseRetired(await resolveBackendForSession(sessionId));
            const target = getBackend(targetId);
            if (!source || !target) throw new Error("エージェントが見つかりません");
            await switchBackend(sessionId, source, target);
            await savePref("backend", target.id);
            emitGlobal({ type: "backend", sessionId, backend: target.id });
            return reply(true, { sessionId, backend: target.id });
          } finally { switching.delete(sessionId); }
        }

        case "runTurn":
          await runTurn(msg.args ?? {}, () => reply(true, "started"));
          return;
        case 'sendMessage': {
          const { sessionId, messageId, prompt, attachments, cwd, mode } = msg.args ?? {};
          if (!sessionId || !refuseRetired(await resolveBackendForSession(sessionId))) throw new Error('セッションが見つかりません');
          if (typeof messageId !== 'string' || !/^[a-zA-Z0-9-]{8,80}$/.test(messageId)) throw new Error('送信IDが必要です');
          if (typeof prompt !== 'string' || !prompt.trim()) throw new Error('メッセージを入力してください');
          if (attachments !== undefined && (!Array.isArray(attachments) || attachments.length > 20)) throw new Error('添付は20件までです');
          return reply(true, await outbox.accept(sessionId, messageId, {
            prompt, ...(attachments ? { attachments } : {}), ...(cwd ? { cwd } : {}), ...(mode ? { mode } : {}),
          }));
        }
        case 'messageAction': {
          const { sessionId, messageId, action } = msg.args ?? {};
          await outbox.action(sessionId, messageId, action);
          return reply(true, await outbox.list(sessionId));
        }
        case 'listMessages':
          return reply(true, await outbox.list(msg.args?.sessionId));

        case "abort": {
          // どのセッションを止めるか。省略されたら全部止める
          const { sessionId } = msg.args ?? {};
          await agentTasks.cancelOwner(sessionId);
          const ownTask = agentTasks.list().find(r => r.sessionId === sessionId);
          if (ownTask) await agentTasks.cancel(ownTask.taskId);
          for (const id of sessionId ? [sessionId] : [...runtime.turns.keys()]) await outbox.pause(id);
          const targets = sessionId
            ? [runtime.turns.get(sessionId)].filter(Boolean)
            : [...runtime.turns.values()];
          for (const t of targets) {
            t.ac.abort();
            settleAll("中断された", t.info.sessionId);
          }
          return reply(true, { aborted: targets.length });
        }

        case 'agentTasks': return reply(true, agentTasks.list(msg.args?.sessionId));
        case 'cancelAgentTask': {
          const task = agentTasks.get(msg.args?.taskId);
          if (!task) throw new Error('Pleiad タスクが見つかりません');
          await agentTasks.cancel(task.taskId); return reply(true, agentTasks.get(task.taskId));
        }
        case "resolvePermission": {
          const { id, allow, always, message, answers, annotations, response } = msg.args ?? {};
          const w = runtime.waiting.get(id);
          if (!w) return reply(false, "その承認は既に解決済み");
          // 回答を伴うツール（質問カード）は、承認ではなく入力の差し替えとして返る。
          // ここでは解釈しない。エージェントが自分の形へ戻す（§2.2）。
          w.settle({
            allow: !!allow,
            always: !!always,
            message: message ?? null,
            answers: answers ?? null,
            annotations: annotations ?? null,
            response: response ?? null,
          });
          return reply(true, "ok");
        }

        // 履歴を読み直す。sessionId が無いときは空（新規セッション相当）。
        case "loadSession": {
          const { sessionId } = msg.args ?? {};
          if (!sessionId) return reply(true, { messages: [], presents: [] });
          // Hold the reference even if the turn ends during the asynchronous reads.
          const read = { sessionId, turn: runtime.turns.get(sessionId) };
          if (msg.args?.live) liveReads.add(read);
          try {
            const backend = await resolveBackendForSession(sessionId);
            const retired = backend?.retired ? { retired: backend.retired } : {};
            // A later completion cannot be acknowledged by an older history snapshot.
            const completedAt = (await store.get(sessionId)).completedAt ?? null;
            const data = await history.loadTranscript(sessionId, backend);
            // 系譜の照合（web/branches.mjs）は uuid・役割・本文・ツール名しか見ない。
            // ツール結果や提示まで載せると、家族を開くたびに数十MBが流れて画面が止まる
            if (msg.args?.outline) return reply(true, { messages: data.messages.map(m => ({
              uuid: m.uuid, role: m.role, text: m.text, tools: m.tools,
              ...(m.toolCalls ? { toolCalls: m.toolCalls.map(call => ({ name: call.name })) } : {}),
            })) });
            const draft = (await store.get(sessionId)).draft ?? null;
            if (!msg.args?.live) return reply(true, { ...data, completedAt, draft, ...retired });
            // 承認は一度きりの配信で、streamEvents にも載らない（web/session-stream.mjs）。
            // 開き直しのたびに保留中のものを返さないと、承認が起きた後にその会話を開いても
            // カードが出ず、一覧だけが「承認待ち」のまま止まる。
            const permissions = [...runtime.waiting]
              .filter(([, w]) => w.payload.sessionId === sessionId)
              .map(([id, w]) => ({ ...w.payload, id }));
            const turn = read.turn;
            if (turn) {
              const live = turn.stream;
              // 利用者の発言が無いターン（user が無い）もある
              const user = live.user
                ? data.messages.slice(live.messages.length).find(m => m.role === "user" && m.text === live.user.text) ?? live.user
                : null;
              // Use a fixed pre-turn history, never an independently sampled partial
              // transcript: it may overlap the events or lag behind them.
              return reply(true, {
                messages: [...live.messages, ...(user ? [user] : [])], presents: live.presents, completedAt, draft,
                stream: { events: live.events }, streamCursor: streamSequence, permissions,
                initialMessageId: live.events.find(e => e.type === 'userMessage' && e.initial)?.messageId,
              });
            }
            return reply(true, { ...data, completedAt, draft, streamCursor: streamSequence, permissions, ...retired });
          } finally { liveReads.delete(read); }
        }

        // Allocate the host identity before the native engine has a first turn.
        case "newSession": {
          const sourceId = msg.args?.sourceSessionId;
          if (sourceId) await settingsWrites.get(sourceId);
          const sourceBackend = sourceId ? await resolveBackendForSession(sourceId) : null;
          if (sourceId && !sourceBackend) throw new Error("引き継ぎ元のセッションが見つかりません");
          const source = sourceId ? await store.get(sourceId) : null;
          const selected = source?.nextSettings?.backend ?? sourceBackend?.id;
          // 引き継ぎ元が対応を終えたエージェントなら、エージェントは継がない（既定へ落とす）
          const selectedBackend = getBackend(selected) ? selected : undefined;
          const backend = await pickBackend(null, msg.args?.backend ?? selectedBackend);
          const inherit = source && backend.id === selectedBackend;
          const model = msg.args?.model ?? (inherit ? source.nextSettings?.model ?? source.model ?? "" : undefined);
          const mode = msg.args?.mode ?? (inherit ? source.nextSettings?.mode ?? (backend.id === sourceBackend.id ? source.mode : undefined) : undefined);
          const cwd = typeof msg.args?.cwd === "string" && msg.args.cwd.trim() ? msg.args.cwd.trim() : os.homedir();
          const status = typeof msg.args?.status === "string" ? msg.args.status.trim() || null : null;
          const now = Date.now();
          const info = { title: "新しいセッション", cwd, tag: status, createdAt: now, lastModified: now };
          const sessionId = await createConversation(backend, info);
          try {
            await store.setMeta(sessionId, { backend: backend.id, ...info, status, unsent: true });
            // 互換の接続先（決定 2・3）: 同じエージェントの引き継ぎなら元の会話の接続先（予約中ならそれ）を継ぐ。
            // それ以外は設定で「既定にする」を押した接続先（無ければ公式）。削除済みは継がない
            let endpoint = '';
            if (endpointCapable(backend)) {
              if (typeof msg.args?.endpoint === 'string') {
                endpoint = msg.args.endpoint;
                if (endpoint && !(await compatEndpoints.has(endpoint, backend.id))) throw new Error('選択した接続先は登録されていません');
              } else {
                endpoint = inherit ? source.nextSettings?.endpoint ?? source.compatEndpoint ?? '' : await compatEndpoints.defaultFor(backend.id);
                if (endpoint && !(await compatEndpoints.has(endpoint, backend.id))) endpoint = '';
              }
            }
            if (endpoint) await store.setSessionData(sessionId, 'compatEndpoint', endpoint);
            const selected = await resolveModel(null, inherit || msg.args?.model !== undefined ? model : undefined, backend, cwd || undefined, endpoint);
            await store.setModel(sessionId, selected);
            const effort = msg.args?.effort ?? (inherit ? source.nextSettings?.effort ?? source.effort : undefined);
            await store.setSessionData(sessionId, 'effort', await resolveEffort(null, effort, backend, selected, cwd || undefined, await endpointRow(endpoint)));
            await store.setMode(sessionId, await resolveMode(null, mode, backend));
            // 引き継ぎ元の会話で選んでいた Claude のアカウントも継ぐ（予約中ならそれを）
            // 引き継ぎ元が無ければ前回選んだアカウント（削除済みなら、ログイン中のアカウントのまま）
            const account = source ? source.nextSettings?.account ?? source.claudeAccount ?? '' : (await store.getPrefs()).claudeAccount ?? '';
            if (account && await claudeAccounts.has(account)) await store.setSessionData(sessionId, 'claudeAccount', account);
          } catch (e) { await deleteUnsentConversation(sessionId); await store.removeSession(sessionId); releaseAgentConnection(sessionId); throw e; }
          emitGlobal({ type: "sessionsChanged", sessionId: null });
          return reply(true, { sessionId });
        }

        // 既出の状態一覧。事前定義ではなく補完候補（設計メモ §6）。
        case "listStatuses":
          return reply(true, await history.listStatuses(listBackends()));

        case "modes": {
          const backend = await pickBackend(null, msg.args?.backend);
          return reply(true, backend.modes());
        }

        case "efforts": {
          const backend = await pickBackend(null, msg.args?.backend);
          // endpoint を渡すと互換の接続先の段（既定の段を作らない。Claude は「思考を送る」がオフなら段なし）
          const endpoint = endpointCapable(backend) && typeof msg.args?.endpoint === 'string' ? await endpointRow(msg.args.endpoint) : null;
          return reply(true, await effortOptions(backend, msg.args?.model ?? '', msg.args?.cwd, endpoint));
        }
        case "models": {
          const backend = await pickBackend(null, msg.args?.backend);
          return reply(true, await backend.models(msg.args?.cwd));
        }
        // 作業ディレクトリを選ぶ簡易ブラウザー（ブラウザー版の入力欄）。フォルダーの名前だけを返す
        case "listDirs":
          return reply(true, await listDirs(msg.args?.path));

        // 認証はエージェントごとに持ち方が違う。持たないものは supported:false を返す
        // （web はボタンごと隠す。「押せるのに何も起きない」を作らない）。
        case "authStatus": {
          const backend = await pickBackend(null, msg.args?.backend);
          const installed = installation(backend.id);
          if (!installed.installed) return reply(true, { supported: true, ...installed });
          if (!backend.auth?.status) return reply(true, { supported: false });
          return reply(true, { supported: true, ...installed, ...(await backend.auth.status()) });
        }

        case "authLogin": {
          const backend = await pickBackend(null, msg.args?.backend);
          if (!backend.auth?.login) return reply(true, { supported: false });
          // URL は auth イベントで出る。完了まで待つので応答は最後に返る
          await backend.auth.login({
            emit: (ev) => emitGlobal({ ...ev, backend: backend.id, sessionId: null }),
          });
          quotaCache.clear();
          return reply(true, { supported: true, ...(await backend.auth.status?.() ?? {}) });
        }

        // ログインの折り返しをローカルに受けられないとき（1455 番が塞がっている等）、
        // 人間がブラウザから貼り戻したリダイレクト URL / code をエージェントへ渡す。
        // 待っているのは authLogin の側なので、ここは投げ込むだけで応答は即返る。
        case "authSubmit": {
          const backend = await pickBackend(null, msg.args?.backend);
          if (!backend.auth?.submitCode) return reply(true, { supported: false });
          await backend.auth.submitCode(msg.args?.input);
          return reply(true, { supported: true });
        }

        case "authLogout": {
          const backend = await pickBackend(null, msg.args?.backend);
          if (!backend.auth?.logout) return reply(true, { supported: false });
          await backend.auth.logout();
          quotaCache.clear();
          return reply(true, { supported: true, ...(await backend.auth.status?.() ?? {}) });
        }

        case "running":
          return reply(true, await runningWork());

        // 次に新しく始めるときの既定
        case "onboardingStatus":
          return reply(true, { homeDir: os.homedir(), agents: listBackends().map(b => ({ id: b.id, label: b.label, description: b.description ?? "", ...installation(b.id) })), ...(await readOnboarding()) });
        case "onboardingSeen": {
          const saved = { ...(await readOnboarding()), seen: true };
          await fs.mkdir(store.dataDir, { recursive: true });
          await fs.writeFile(path.join(store.dataDir, "onboarding.json"), JSON.stringify(saved), { mode: 0o600 });
          return reply(true, saved);
        }
        case "completeSetup": {
          const backend = await pickBackend(null, msg.args?.backend);
          if (!installation(backend.id).installed) throw new Error("エージェントをインストールしてください");
          if (backend.auth?.status && !(await backend.auth.status()).loggedIn) throw new Error("ログイン状態を再確認してください");
          const { cwd } = await resolveCwd(null, msg.args?.cwd, backend);
          const saved = { seen: true, setupComplete: true, backend: backend.id, cwd: path.resolve(cwd) };
          await fs.mkdir(store.dataDir, { recursive: true });
          await fs.writeFile(path.join(store.dataDir, "onboarding.json"), JSON.stringify(saved), { mode: 0o600 });
          await store.setPref("backend", backend.id);
          return reply(true, saved);
        }
        case "prefs": {
          // 既定のエージェントが無くなっていたら（対応を終えた・無効にした）載せない。web は有効なものへ落とす
          const prefs = await store.getPrefs();
          if (prefs.backend && !getBackend(prefs.backend)) delete prefs.backend;
          return reply(true, prefs);
        }

        /**
         * AI にタイトルを考えてもらう。
         * 会話の中身を見て決めるので、走っているターンとは別に小さく1本立てる。
         * 生成はエージェントの仕事、整形（前後の記号を落とす）はここ。
         */
        case "suggestTitle": {
          const { sessionId } = msg.args ?? {};
          if (!sessionId) return reply(false, "セッションが要る");
          const backend = await resolveBackendForSession(sessionId);
          if (!backend) return reply(false, "エージェントが見つかりません");
          if (!backend.suggestTitle) return reply(false, "このエージェントはタイトル生成に対応していません");
          const { messages } = await history.loadTranscript(sessionId, backend);
          const gist = messages
            .filter((m) => m.text)
            .slice(0, 6)
            .map((m) => `${m.role === "user" ? "依頼" : "応答"}: ${m.text.slice(0, 600)}`)
            .join(NL + NL);
          if (!gist) return reply(false, "まだ中身が無いので付けられない");

          let title = "";
          const context = {};
          try {
            // タイトル生成もその会話で選んだアカウントで回す。使えないアカウントなら生成しない（別のアカウントへ落とさない）
            // 互換の接続先の会話は、その接続先の Haiku 相当（Codex は既定）のモデルで作る。使えない接続先なら作らない
            const saved = await store.get(sessionId);
            if (endpointCapable(backend) && saved.compatEndpoint) context.endpoint = await compatEndpoints.resolve(saved.compatEndpoint, backend.id);
            if (!context.endpoint && backend.capabilities?.claudeAccounts) {
              const account = await claudeAccounts.resolve(saved.claudeAccount ?? '');
              if (account) context.oauthToken = account.token;
            }
            title = String(await backend.suggestTitle({ transcript: gist, ...context }) ?? "");
          } catch (err) {
            return reply(false, `考えられなかった: ${redactSecret(redactToken(err?.message ?? err, context.oauthToken), context.endpoint?.key)}`);
          }

          // 前後の記号を落とす。モデルが鉤括弧やクオートで包むことがある
          title = title.trim().split(NL)[0].replace(/^["'「『]|["'」』。]$/g, "").trim().slice(0, 60);
          if (!title) return reply(false, "空のタイトルが返ってきた");
          return reply(true, { title });
        }

        /**
         * 人間が会話へファイルを渡す。present の逆方向（設計メモ §7）。
         * 中身は作業ディレクトリではなく uploads/ に置く。
         * 相手のリポジトリに勝手に物を増やさないため。
         */
        case "attachFile": {
          const { sessionId, name, mime, data } = msg.args ?? {};
          if (typeof data !== "string" || !data) return reply(false, "中身が無い");
          const buf = Buffer.from(data, "base64");
          if (buf.length > MAX_UPLOAD_BYTES) {
            return reply(false, `大きすぎる（${Math.round(buf.length / 1024 / 1024)}MB / 上限 8MB）`);
          }
          // 名前は信用しない。区切り文字を落としてから使う
          const safe = String(name ?? "file")
            .replace(/[^\p{L}\p{N}._-]/gu, "_")
            .slice(-80) || "file";
          const stamp = new Date().toISOString().replace(/[:.]/g, "-");
          // id の形はエージェントごとに違う（UUID / UUIDv7 / YYYYMMDD-xxxxxx）。
          // 形で弾かず、パスに使えない字を潰して使う。
          const bucket = sessionId ? String(sessionId).replace(/[^A-Za-z0-9._-]/g, "_") : "_new";
          const dir = path.join(UPLOAD_DIR, bucket);
          await fs.mkdir(dir, { recursive: true });
          const file = path.join(dir, `${stamp}_${safe}`);
          await fs.writeFile(file, buf);

          // ここでは置くだけ。会話に載るのは送信のとき（runTurn の attachments）。
          // 送る前の添付は入力欄のものであって、会話の出来事ではない
          return reply(true, { path: file, bytes: buf.length, kind: IMAGE_MIME.test(String(mime ?? "")) ? "image" : "file" });
        }

        // セッションを選んでいなくても既定は変えられる
        case "setPref": {
          const { key, value, backend: backendId } = msg.args ?? {};
          if (key === "backend") {
            if (!getBackend(value)) return reply(false, "知らないエージェント");
            return reply(true, await savePref(key, value));
          }
          if (backendId && !getBackend(backendId)) return reply(false, "知らないエージェント");
          if (key !== "mode" && key !== "model") return reply(false, `知らない設定: ${key}`);
          // 語彙はエージェントごとに違う。どれか1つでも知っていれば通す
          const known = await Promise.all((backendId ? [getBackend(backendId)] : listBackends()).map(async (b) =>
            key === "mode" ? Boolean(b.modes()[value]) : value in (await b.models())));
          if (!known.some(Boolean)) return reply(false, `知らない${key === "mode" ? "承認モード" : "モデル"}: ${value}`);
          return reply(true, await savePref(key, value, backendId));
        }

        // 状態の一括改名。to が空なら状態を外す（＝グループの削除）。
        // 状態は事前定義しないので「グループ」は実体を持たず、付いているセッションの集合でしかない。
        // だから改名も削除も、対象セッションの状態を書き換えるだけで足りる。
        case "renameStatus": {
          const { from, to } = msg.args ?? {};
          if (typeof from !== "string" || !from) return reply(false, "改名元の状態が要る");
          const next = typeof to === "string" ? to.trim() : "";
          const hit = (await sessionList({ limit: 500 })).filter((x) => (x.status ?? "") === from);
          for (const x of hit) {
            const backend = getBackend(x.backend);
            if (backend?.capabilities?.tag && backend.setTag) {
              await backend.setTag(x.id, next || null).catch(() => {});
            }
            await store.recordChange(x.id, {
              by: "human", field: "status", from, to: next || null, backend,
              reason: next ? `状態を「${next}」に改名` : "グループを削除",
            });
          }
          // statuses.json の器（アイコン・作った時刻）も一緒に移す。削除なら捨てる（空のグループはこれで消える）
          await store.moveStatus(from, next || null);
          emitGlobal({ type: "status", sessionId: null, status: next, by: "human", bulk: hit.length,
                 reason: next ? `「${from}」を「${next}」に改名` : `「${from}」を削除` });
          return reply(true, { moved: hit.length });
        }

        // 詳細の読み出しは停止から独立した操作。
        case "loadBackground": {
          const { sessionId, taskId } = msg.args ?? {};
          if (!sessionId || !taskId) return reply(false, "sessionId と taskId が要る");
          const found = findBackgroundTask(sessionId, taskId);
          if (!found) return reply(true, { task: null });
          const detail = await found.backend?.getBackgroundTask?.(sessionId, taskId);
          return reply(true, { task: detail ?? { ...found.task, status: 'running', output: null } });
        }

        // ターンの中断（abort）とは別に、裏の作業を1本止める。
        case "stopBackground": {
          const { sessionId, taskId } = msg.args ?? {};
          if (!sessionId || !taskId) return reply(false, "sessionId と taskId が要る");
          const found = findBackgroundTask(sessionId, taskId);
          if (!found) return reply(false, "その裏の作業はもう動いていません");
          if (!found.backend?.stopBackground) return reply(false, `${found.backendId} は裏の作業を止められません`);
          const res = await found.backend.stopBackground(sessionId, taskId);
          return reply(true, { stopped: res?.stopped !== false });
        }

        // サブエージェントの会話を読む。表示に要る最小形へ落とす。
        case "loadSubagent": {
          const { sessionId, agentId } = msg.args ?? {};
          if (!sessionId || !agentId) return reply(false, "sessionId と agentId が要る");
          const backend = await resolveBackendForSession(sessionId);
          if (!backend?.getSubagentMessages) return reply(true, { agentId, sessionId, messages: [] });
          const raw = await backend.getSubagentMessages(sessionId, agentId, { limit: 500 }).catch(() => []);
          const messages = [];
          for (const m of raw) {
            const tools = (m.toolCalls ?? []).map((c) => c.name);
            if (!m.text && tools.length === 0) continue;   // ツールの戻りだけの行は出さない
            // 入力と結果も渡す。名前だけだと、画面のカードが空の入力 {} になって何をしたのか読めない
            messages.push({ role: m.role, text: m.text, tools: tools.length ? tools : null,
              ...(m.toolCalls?.length ? { toolCalls: m.toolCalls } : {}), at: m.at ?? null });
          }
          return reply(true, { agentId, sessionId, messages });
        }

        // モデルの切り替えも人間の操作から。AI 用のツールは生やさない。
        case "setModel": {
          const { sessionId, model } = msg.args ?? {};
          const backend = refuseRetired(await pickBackend(sessionId, msg.args?.backend));
          // 互換の接続先の会話はモデル ID を形だけ見る（接続先の一覧＋自由入力）。公式の既定（prefs）には覚えない
          const endpointId = endpointCapable(backend) ? (await store.get(sessionId)).compatEndpoint ?? '' : '';
          if (!(await validModel(backend, model, undefined, endpointId))) return reply(false, `知らないモデル: ${model}`);
          const from = (await store.get(sessionId)).model ?? "";
          await store.setModel(sessionId, model);
          if (!endpointId) await savePref("model", model, backend.id);
          await store.recordChange(sessionId, {
            by: "human", field: "model", from, to: model, reason: msg.args.reason, backend,
          });
          let live = false;
          const liveTurn = runtime.turns.get(sessionId);
          if (model && liveTurn?.control.handle && backend.setModelLive) {
            live = await backend.setModelLive(liveTurn.control.handle, model)
              .catch((err) => { console.error("  モデルの即時切り替えに失敗:", String(err?.message ?? err)); return false; });
          }
          emitGlobal({ type: "model", sessionId, model, by: "human", live });
          return reply(true, { live });
        }

        // 承認モードの切り替えは人間の操作からしか来ない。AI にツールは生やさない。
        case "setMode": {
          const { sessionId, mode } = msg.args;
          const backend = refuseRetired(await pickBackend(sessionId, msg.args?.backend));
          if (!backend.modes()[mode]) return reply(false, `知らない承認モード: ${mode}`);
          const from = (await store.get(sessionId)).mode ?? "default";
          await store.setMode(sessionId, mode);
          // 人間が選んだものを、次に新しく始めるときの既定にする
          await savePref("mode", mode, backend.id);
          await store.recordChange(sessionId, {
            by: "human", field: "mode", from, to: mode, reason: msg.args.reason, backend,
          });
          // 走っている最中でも切り替える。次のターンまで待たせない
          let live = false;
          const liveTurn = runtime.turns.get(sessionId);
          if (liveTurn?.control.handle && backend.setModeLive) {
            live = await backend.setModeLive(liveTurn.control.handle, mode)
              .catch((err) => { console.error("  承認モードの即時切り替えに失敗:", String(err?.message ?? err)); return false; });
          }
          emitGlobal({ type: "mode", sessionId, mode, by: "human", live });
          return reply(true, { live });
        }

        // 人間からの変更。AI 用ツールと同じ store・同じイベントを通る（設計メモ 2.2）
        case "setStatus": {
          const { sessionId, status, reason } = msg.args;
          if (!sessionId) return reply(false, "セッションが要る（新規なら runTurn の status に載せる）");
          const backend = await pickBackend(sessionId, msg.args?.backend);
          // グループの根を動かすと、まとまりごと移る（中の会話も同じ状態に保つ、§4.1）。
          // 中の会話を動かしたときは、その 1 本だけが出る
          const rows = msg.args?.alone ? [] : await sessionList().catch(() => []);
          const kin = rows.length && isGroupRoot(rows, sessionId) ? groupKin(rows, sessionId) : [];
          await applyStatus(backend, sessionId, status, reason);
          for (const r of kin) {
            const b = getBackend(r.backend) ?? backend;
            await applyStatus(b, r.id, status, reason ?? "グループごと移動").catch(() => {});
          }
          return reply(true, { moved: kin.map((r) => r.id) });
        }

        // グループから外す / 戻す。まとまりは親子と状態から決まるので、覚えるのは「外した」ことだけ
        case "setGrouped": {
          const { sessionId, ungrouped } = msg.args ?? {};
          if (!sessionId) return reply(false, "セッションが要る");
          await store.setSessionData(sessionId, "ungrouped", ungrouped ? true : null);
          emitGlobal({ type: "group", sessionId, ungrouped: Boolean(ungrouped) });
          return reply(true, { sessionId, ungrouped: Boolean(ungrouped) });
        }

        // 状態グループのアイコン。人間の操作。AI が set_status で渡す経路も同じ store に入る（設計メモ 2.2）
        case "setStatusIcon": {
          const { status, icon } = msg.args ?? {};
          if (typeof status !== "string" || !status.trim()) return reply(false, "状態が要る");
          const saved = await store.setStatusIcon(status, icon);
          emitGlobal({ type: "statusIcon", sessionId: null, status, icon: saved });
          return reply(true, { status, icon: saved });
        }

        // 空のグループを作る。状態は使われた時点で存在する（設計メモ §6）が、
        // 人が先に作った器は statuses.json にある限り存在する（セッション 0 件でも一覧に出る）
        case "createStatus": {
          const status = String(msg.args?.status ?? "").trim();
          if (!status) return reply(false, "グループの名前が要る");
          await store.createStatus(status);
          emitGlobal({ type: "status", sessionId: null, status, by: "human", bulk: 0, reason: "グループを作った" });
          return reply(true, { status });
        }

        /**
         * 同じ根を持つセッション群。分岐の筋を描く材料。
         * 一覧と同じ行（sessionRow の合成。parent は sidecar とネイティブの両方）から
         * 根へ遡り、子孫を集める（core/lineage.mjs）。行はここに揃っているので、
         * 家族の分だけエージェントへ聞き直すことはしない。
         */
        case "lineage": {
          const { sessionId } = msg.args ?? {};
          if (!sessionId) return reply(false, "セッションが要る");
          const rows = await sessionList({ limit: 500 });
          const byId = new Map(rows.map((r) => [r.id, r]));
          const { rootId, ids } = familyOf(rows, sessionId);
          return reply(true, { rootId, sessions: ids.map((id) => byId.get(id) ?? { id, parent: null }) });
        }

        case "setTitle": {
          const { sessionId, title, reason } = msg.args;
          const backend = await pickBackend(sessionId, msg.args?.backend);
          if (backend.capabilities?.title && backend.setTitle) await backend.setTitle(sessionId, title);
          await store.recordChange(sessionId, { by: "human", field: "title", to: title, reason, backend });
          emitGlobal({ type: "title", sessionId, title, by: "human", reason: reason ?? null });
          return reply(true, "ok");
        }

        case "fork": {
          const { sessionId, upToMessageId, beforeMessageId, title } = msg.args;
          const running = runtime.turns.get(sessionId);
          if (!sessionId || forking.has(sessionId) || switching.has(sessionId) && !running) return reply(false, "会話の準備中です。分岐を再試行してください");
          forking.add(sessionId);
          try {
            await settingsWrites.get(sessionId);
            const backend = refuseRetired(await pickBackend(sessionId, msg.args?.backend));
            if (!backend.fork) return reply(false, "このエージェントは分岐できない");
            const snapshot = running ? {
              messageIds: running.stream.messages.map(m => m.uuid),
              presents: structuredClone(running.stream.presents),
            } : null;
            const { sessionId: child, persisted, parent: forkParent } = await backend.fork(sessionId, { upToMessageId, beforeMessageId, title, snapshot });
            // 「編集して再送信」は対象の発言の手前で切るので、その先で渡した本文は分岐先に残らない。渡し済みの控えを捨てる。
            // 写した履歴があれば最初のターンの引き継ぎ（pendingHandoff）でも捨てるが、最初の発言を編集した分岐は履歴が空で引き継ぎが起きない。
            // 「ここから分岐」は控えを引き継ぐ（Claude の SDK の分岐は履歴をそのまま写す）
            if (beforeMessageId) {
              const copied = (await store.get(child)).contextSession;
              if (copied?.delivered) await store.setSessionData(child, 'contextSession', { ...copied, delivered: null });
            }
            const parent = forkParent ?? { sessionId, atMessage: upToMessageId ?? null };
            if (!persisted) {
              await store.setParent(child, parent);
              await store.setMeta(child, { backend: backend.id, lastModified: Date.now() });
              await store.recordChange(child, { by: "human", field: "parent", to: parent, reason: "fork", backend });
            }
            // 枝は親と同じ状態で始まる。そうでないと生まれた瞬間に親のグループから外れる（§4.1）
            const inherited = (await sessionList().catch(() => [])).find((r) => r.id === sessionId)?.status ?? null;
            if (inherited) await applyStatus(backend, child, inherited, "fork").catch(() => {});
            emitGlobal({ type: "fork", sessionId: child, parent });
            return reply(true, { sessionId: child });
          } finally {
            forking.delete(sessionId);
            outbox.kick(sessionId).catch(() => {});
          }
        }
      }
    } catch (err) {
      reply(false, String(err?.message ?? err));
    } finally { releaseUpdateGate?.(); }
  });
});

async function readOnboarding() {
  try { return JSON.parse(await fs.readFile(path.join(store.dataDir, "onboarding.json"), "utf8")); }
  catch { return { setupComplete: false }; }
}

process.parentPort?.on("message", async ({ data }) => {
  if (data?.type === 'update-lock') {
    // 断るときは何が止めているかを返す。画面に出さないと、見た目に何も動いていないのに更新できない理由が分からない
    const reason = runtime.turns.size ? `実行中の会話が ${runtime.turns.size} 件あります`
      : runtime.waiting.size ? `承認待ちが ${runtime.waiting.size} 件あります`
      : agentTasks.busy ? '委譲した作業か、その完了の知らせを親の会話へ届ける処理が終わっていません'
      : outbox.busy ? '途中送信したメッセージを処理しています'
      : switching.size || forking.size ? '会話の切り替えか分岐を処理しています'
      : null;
    const ok = updateGate.acquire(Boolean(reason));
    process.parentPort.postMessage({ type: 'update-lock', id: data.id, ok, reason: ok ? null : reason || 'ほかの操作を処理しています' });
  }
  if (data?.type === 'update-unlock') updateGate.release();
  if (data?.type === "running") process.parentPort.postMessage({ type: "running", work: await runningWork() });
  if (data?.type === "shutdown" && runtime.turns.size === 0 && !agentTasks.busy) process.exit(0);
});

function announce() {
  const { port } = server.address();
  process.parentPort?.postMessage({ type: "ready", port, token: TOKEN });
  console.log("");
  // 待ち受けがループバックか全アドレスなら、覚えやすい localhost で案内する（開く先は同じ）
  const shown = /^(127\.0\.0\.1|0\.0\.0\.0|::1?)$/.test(HOST) ? "localhost" : HOST.includes(":") ? `[${HOST}]` : HOST;
  console.log(`  agent-host  http://${shown}:${port}/?token=${TOKEN}`);
  console.log(`  data        ${store.dataDir}`);
  console.log(`  backends    ${listBackends().map((b) => b.id).join(", ") || "(なし)"}`);
  console.log("");
}

// Windows は Hyper-V / WSL が TCP ポート範囲を予約するため、固定ポートが EACCES で落ちることがある。
// `netsh interface ipv4 show excludedportrange protocol=tcp` で確認できる。範囲は再起動で動く。
// 落ちるくらいなら空きポートへ逃がし、実際の URL を出す。
server.once("error", (err) => {
  if (err.code !== "EACCES" && err.code !== "EADDRINUSE") throw err;
  console.log(`  port ${PORT} は使えない (${err.code})。空きポートに切り替える。`);
  // listen(port, host, cb) の cb は once("listening") として登録される。
  // 失敗しても外れないので、外してから張り直さないと起動メッセージが二重に出る。
  server.removeListener("listening", announce);
  server.listen(0, HOST, announce);
});
server.listen(PORT, HOST, announce);
