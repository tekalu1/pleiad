import { effortOptions, validateEffort } from './effort.mjs';
import { listDirs } from './list-dirs.mjs';
import { createQuotaCache, createUsageStore, agentUsage } from './usage.mjs';
// HTTP（web/ の配信）+ WebSocket（/ws）。token gate は constant-time 比較、既定は localhost bind。
//
// ここは**エージェント非依存**。エージェントの実行もセッション管理も core/backends/<id>.mjs が持ち、
// server は「どのエージェントに聞くか」を決めて、正規化イベントを web へ配るだけ。
// 承認の保留・猶予・中断（設計メモ §8.5）だけはここに残す。エージェントに散らすと
// 「host が居ないあいだ deny し続ける」壊れ方がエージェントの数だけ再発する。
import { createAgentTasks } from './agent-tasks.mjs';
import { createAgentBridge, AGENTS_MCP_PATH, DELEGATING_TOOLS } from './agent-bridge.mjs';
import { canDelegate, resolveDelegatedMode } from './modes.mjs';
import { createUpdateGate } from './update-gate.mjs';
import { ensureDataSchema } from './data-schema.mjs';
import { localeInfo, setLocale, t, i18n, LOCALE_SETTINGS, agentT, agentLocaleOf, currentLocale } from './i18n.mjs';
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { readLocalFile } from "./local-files.mjs";
import { isLocalRequest, defaultOpener, createRateLimit, OPENABLE } from './os-open.mjs';
import { readPreview, resolveReference, cwdAt, inspectFile, previewFailure } from './file-preview.mjs';
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import * as P from "./protocol.mjs";
import * as store from "./store.mjs";
import * as history from "./history.mjs";
import { createMessageQueue } from "./message-queue.mjs";
import { createContextSettings } from './context-settings.mjs';
import { scanContext, skillList } from './context-scan.mjs';
import { acceptsPlyContext, followSettings, managed, nativeContextReport, pinChanges, pinnedChanges, resolveRuntime } from './context-runtime.mjs';
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
import { createRemoteHost } from './remote/connector.mjs';
import { createResidentPrefs, residentSignal } from './remote/resident.mjs';
import { createFolderUploads } from './folder-uploads.mjs';
import { createVisualizationCollector, visualizeInstructions } from './visualize.mjs';
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
// 画面の言語（設定値と解決後）。起動時と設定を変えたときに決め直す。ready と prefs イベントで配る（docs/design.md「多言語対応」）
let locale = localeInfo(await store.getPrefs());
setLocale(locale.lang);

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
// 手元のフォルダーを送る口（upload* コマンド、docs/remote.md §8.1）。置き場の既定は ~/Pleiad/uploads（作業フォルダーになるので見える場所）。
// 7 日触られていない途中のものは起動時と 1 日ごとに捨てる
const folderUploads = createFolderUploads({ root: process.env.AGENT_HOST_FOLDER_UPLOADS || undefined });
folderUploads.sweep().catch(() => {});
setInterval(() => folderUploads.sweep().catch(() => {}), 24 * 60 * 60_000).unref();
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
    if (accountId && !current) throw new Error(t('accounts.deleted'));
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
// 同じデータ置き場を別の Pleiad（開発版と配布版）が使っていることがあるので、走っている会話のファイルは消さない（1 日より古いものだけ）
sweepClaudeFlagSettings(store.dataDir, { olderThanMs: 24 * 60 * 60_000 }).catch(() => {});
const mcpOAuth = createMcpOAuth({ secrets: mcpSecrets, lockDir: path.join(store.dataDir, 'mcp-locks'),
  // Client ID Metadata Document の URL（設定値。既定は無し。公開する文書のひな形は docs/mcp-oauth-client-metadata.json）
  clientMetadataUrl: async () => (await plyMcp.settings().catch(() => ({}))).clientMetadataUrl ?? undefined,
  // utilityProcess からはブラウザを開けないので main に頼む（desktop/main.cjs）。npm start では画面に出る URL から開く
  openExternal: url => process.parentPort?.postMessage({ type: 'open-external', url }),
  emit: event => emitGlobal({ ...event, sessionId: null }) });
const contextBridge = createContextBridge({ plyMcp, oauth: mcpOAuth });
// リモートの接続口（docs/remote.md §4.2・§6.1）。既定は無効で、有効にするまで中継へはつながない。
// 端末からのストリームはこのサーバー自身（localOrigin）へ組み立て直し、UI トークンは接続口が差し込む
const remote = createRemoteHost({ dataDir: store.dataDir, cipher: secretCipher, token: TOKEN, appVersion: APP_VERSION,
  target: () => { const u = new URL(localOrigin()); return { host: u.hostname.replace(/^\[|\]$/g, ''), port: Number(u.port) }; },
  emit: event => {
    if (event.type !== 'remoteStatus') return emitGlobal({ ...event, sessionId: null });
    const status = withResident(event.status);
    emitGlobal({ ...event, status, sessionId: null });
    postResident({ status });
  },
  log: line => console.log(`  ${line}`) });
// ホストとして常駐する設定（docs/remote.md §6.3。core/remote/resident.mjs）。使うのはデスクトップ版のホストだけ（available）。
// トレイとスリープの抑止は main（desktop/resident.cjs）が持つので、リモートの状態か実行中の作業が変わるたびに送る
const residentPrefs = createResidentPrefs({ dataDir: store.dataDir });
const withResident = status => ({ ...status, resident: { available: Boolean(process.parentPort), ...residentPrefs.get() } });
const remoteStatus = async () => withResident(await remote.status());
let residentLast = '', residentStatus = null, residentWork = null;
function postResident({ status, work } = {}) {
  if (!process.parentPort) return;
  if (status) residentStatus = status;
  if (work) residentWork = work;
  const signal = residentSignal({ status: residentStatus, prefs: residentPrefs.get(), work: residentWork, locale: locale.lang });
  const key = JSON.stringify(signal);
  if (key === residentLast) return;
  residentLast = key;
  process.parentPort.postMessage({ type: 'resident', state: signal });
}
// 固定した指示・Skills の開始時の本文（「差分を見る」用。内容のハッシュを名前にして 1 つずつ）
const CONTEXT_SNAPSHOTS = path.join(store.dataDir, 'context-snapshots');
const contextSession = createContextSession({ store, snapshots: CONTEXT_SNAPSHOTS, plyServers: () => plyMcp.scanInput(),
  liveRecord: id => runtime.turns.get(id)?.contextRecord ?? null, isRunning: id => runtime.turns.has(id) });
const mcpConfig = createMcpConfig();
let agentTasks;
const agentConnections = new Map();
const taskExecutions = new Map();
// エラー・結果の文はツールの結果としてエージェントが読むので、会話の言語で引く（agent 名前空間。橋は会話ごとに開き、locale はその会話の言語）
const agentBridge = createAgentBridge({ call: async (owner, name, args, { locale } = {}) => {
  const turn = runtime.turns.get(owner);
  const lng = turn?.agentLocale ?? locale;
  if (!turn || turn.ac.signal.aborted) throw new Error(agentT(lng, 'delegation.notRunning'));
  // 使用枠は読むだけなので、読み取り・計画モードでも答える。providerUsage と同じキャッシュを通す
  if (name === 'ply_usage') return agentUsage({ backend: args.backend, list: listBackends, get: getBackend, read: providerQuota, locale: lng });
  const mutation = DELEGATING_TOOLS.includes(name);
  if (mutation && !canDelegate(turn.backend.modes()[turn.info.mode])) throw new Error(agentT(lng, 'delegation.readOnly'));
  // 子の承認モードは「親の強さまで継ぐ、それを超えない」（core/modes.mjs）。
  // 決めるのはここだけ。prepare は決まった結果をそのまま使う（同じ判定を二度しない）。
  const child = name === 'ply_delegate' ? getBackend(args.backend) : null;
  const decided = child ? resolveDelegatedMode({ parentMode: turn.info.mode, parentModes: turn.backend.modes(), childModes: child.modes() }) : null;
  // codex は MCP のツール呼び出しを自前の承認に通さない。full / yolo 以外の codex 親では、
  // これが無いと委譲が起きたこと自体に人間が気づけないので、強さが収まっていても聞く。
  const codexBlind = turn.backend.id === 'codex' && !['full', 'yolo'].includes(turn.info.mode);
  if (mutation && (decided?.escalation || codexBlind)) {
    // 何をどの強さで動かすことになるのかをカードに出す。委譲のたびではなく、この1回だけ聞く
    const title = decided ? t('permission.delegateEscalation', { agent: child.label, mode: child.modes()[decided.mode]?.label ?? decided.mode, modeId: decided.mode }) : undefined;
    const answer = await askPermission({ toolName: name, input: args, title, sessionId: owner, signal: turn.ac.signal, kind: 'tool', canAlways: false, locale: lng });
    if (!answer.allow) throw new Error(agentT(lng, 'delegation.denied'));
  }
  return agentTasks.call(owner, name, decided?.mode ? { ...args, mode: decided.mode } : args, turn.ac.signal, lng);
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
  // 会話の言語は会話を始めたときに決まり、以後は変わらない（runTurn）。橋の instructions・ツールの説明もその言語で開く
  const entry = { key: turn.key, locale: turn.agentLocale };
  const binding = agentBridge.open({ origin: localOrigin(), locale: entry.locale,
    owner: async () => {
      const live = runtime.turns.get(entry.key);
      if (!live) throw new Error(agentT(entry.locale, 'delegation.notRunning'));
      await live.setup;
      if (!live.info.sessionId) throw new Error(agentT(entry.locale, 'delegation.idPending'));
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

/**
 * 会話の言語（エージェントに渡す文の言語。docs/design.md「多言語対応」）。記録（agentLocale）にあればそれを使い、
 * 無ければ今の画面の言語で決めて保存する。途中で画面の言語を変えても、決めた会話の言語は変えない
 * （応答の一貫性とプロンプトのキャッシュのため）。この値を持たない既存の会話は、次にエージェントを動かすときに決まる
 */
async function ensureAgentLocale(sessionId) {
  const saved = agentLocaleOf((await store.get(sessionId)).agentLocale);
  if (saved) return saved;
  const lang = currentLocale();
  await store.setSessionData(sessionId, 'agentLocale', lang);
  return lang;
}

/** 会話の言語を読むだけ（保存しない）。走っているターンがあればその言語、決まっていなければ今の画面の言語 */
async function agentLocaleFor(sessionId) {
  const live = sessionId ? runtime.turns.get(sessionId)?.agentLocale : null;
  if (live) return live;
  return (sessionId ? agentLocaleOf((await store.get(sessionId)).agentLocale) : null) ?? currentLocale();
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
  // 辞書（web/locales）。fetch().json() で読む
  ".json": "application/json; charset=utf-8",
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

/**
 * 会話のファイルを読める範囲（/local-file・/file-preview・ファイルの操作で共通）。
 * 作業ディレクトリ・添付の置き場・Codex の生成画像・全会話の cwd とその変更履歴
 */
function fileRoots(sessions) {
  return [...workspaceRoots, UPLOAD_DIR,
    path.join(process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex"), "generated_images"),
    ...Object.values(sessions).flatMap(s => [s.cwd, ...(s.history ?? []).filter(h => h.field === 'cwd').flatMap(h => [h.from, h.to])])];
}

/**
 * 会話の中のファイル参照を絶対パスにする（/file-preview とファイルの操作で共通）。roots には会話の今の cwd を足す。
 * 相対パスは発言の時刻（at）の cwd か、プレビュー中の文書（base）のフォルダーで解く。
 * @returns {{ path, line, cwd }} cwd は解決の基準（相対パスの表示に使う）
 */
async function resolveSessionFile({ path: requested, sessionId, at, base }, sessions, roots) {
  const meta = sessions[sessionId] ?? {};
  const backend = sessionId ? await resolveBackendForSession(sessionId) : null;
  const info = !meta.cwd && backend ? await backend.getSession(sessionId).catch(() => null) : null;
  const currentCwd = meta.cwd || info?.cwd;
  if (currentCwd) roots.push(currentCwd);
  let cwd = currentCwd;
  // Only relative references need a historical cwd. An explicit path
  // stays useful even when a native transcript has no timestamps.
  if (base != null) {
    const baseFile = await inspectFile(base, roots);
    cwd = path.dirname(baseFile.file);
  } else if (!/^(?:[a-z]:[\\/]|\/|file:)/i.test(requested ?? '')) cwd = cwdAt({ ...meta, cwd:currentCwd }, at);
  return { ...resolveReference(requested, cwd), cwd };
}

// サーバーのある PC で開く（エクスプローラー・既定のブラウザー）。デスクトップ版は本体に頼む。連打は断る
const openOnHost = defaultOpener();
const osActionAllowed = createRateLimit({ limit: 5, windowMs: 10_000 });

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
    return res.end(t('auth.tokenRequired'));
  }

  const name = url.pathname === "/" ? "/index.html" : url.pathname;
  try {
    if (url.pathname === "/local-file" || url.pathname === '/file-preview') {
      const sessions = await store.getAll();
      const roots = fileRoots(sessions);
      if (url.pathname === '/file-preview') {
        let resolved;
        try {
          resolved = await resolveSessionFile({ path:url.searchParams.get('path'), sessionId:url.searchParams.get('sessionId'),
            at:url.searchParams.get('at'), base:url.searchParams.get('base') }, sessions, roots);
          const preview = await readPreview(resolved.path, roots, { resource:url.searchParams.get('resource') === '1' });
          res.writeHead(200, { 'content-type':'application/json; charset=utf-8', 'cache-control':'private, no-store', 'x-content-type-options':'nosniff' });
          return res.end(JSON.stringify({ ...preview, line:resolved.line, cwd:resolved.cwd }));
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
    // i18next は依存の無い 1 ファイルの ESM。画面は import map の "i18next" でここを読む（web/index.html）
    if (url.pathname === '/vendor/i18next.mjs') {
      const body = await fs.readFile(fileURLToPath(import.meta.resolve('i18next')));
      res.writeHead(200, { 'content-type':'text/javascript; charset=utf-8', 'x-content-type-options':'nosniff' });
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
    // 確認済みの完了時刻。ホストに 1 つで、どの端末から見ても同じ（store.markRead・docs/design.md「完了・未確認」）
    readAt: Number.isFinite(extra.readAt) ? extra.readAt : null,
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
    // 会話の言語（エージェントに渡す文の言語。null = まだ決めていない）。画面は添付の印をこの言語で付ける
    agentLocale: agentLocaleOf(extra.agentLocale),
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
 * プロバイダーの使用枠。設定の画面（providerUsage）とエージェント（ply_usage）が同じ quotaCache を通すので、
 * どちらから何度呼んでも各サービスへの問い合わせは 1 分に 1 回まで
 */
async function providerQuota(backend) {
  if (!backend.usage) return { windows: [], checkedAt: null, message: t('quota.unsupported') };
  return quotaCache(backend.id, async () => backend.usage({ cwd: process.cwd(), ...(backend.capabilities?.claudeAccounts ? await usageAccounts() : {}) }));
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
    if (current && given && current.id !== given) throw new Error(t('agents.switchViaCommand'));
    if (current) return current;
    if (!given) throw new Error(t('agents.unknownForSession', { sessionId }));
  }
  if (typeof given === "string" && given) {
    const b = getBackend(given);
    if (!b) throw new Error(t('agents.unknownId', { id: given }));
    return b;
  }
  const remembered = (await store.getPrefs()).backend;
  const preferred = getBackend(remembered);
  if (preferred) return preferred;
  // 既定に覚えていたエージェントが無くなった（対応を終えた・無効にした）なら、有効なものの先頭へ落とす
  const only = listBackends();
  if (only.length === 1 || (remembered && only.length)) return only[0];
  throw new Error(t('agents.required'));
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
  if (!stat) throw new Error(t('cwd.missing', { cwd }));
  if (!stat.isDirectory()) throw new Error(t('cwd.notDirectory', { cwd }));
  return { cwd, changedFrom };
}

// ---- 接続をまたいで生きるランタイム ----------------------------------------
//
// host（ブラウザ）が一瞬居なくなっただけでターンを殺さない。
// かといって、居ないあいだ「承認できないから deny」を返し続けるのは最悪で、
// エージェントは走り続けたまま書き込みだけが全部失敗し、
// 読み取り系（自動許可）だけが通るので「動いているのに成果ゼロ」になる。
// 居ないあいだは待たせ、戻ってきたら聞き直す。既定では打ち切らない（待ち続ける。issue #11）。
// リモートの端末はスリープで簡単に切れるので、切れただけで作業を止めない。
// AGENT_HOST_GRACE_MS に正の数を指定したときだけ、その時間戻らなければターンごと止める。
const HOST_GRACE_MS = parseGraceMs(process.env.AGENT_HOST_GRACE_MS);

/** 未指定・空・0 以下・数でないものは「打ち切らない」(0)。 */
function parseGraceMs(raw) {
  const n = Number(raw);
  return raw != null && String(raw).trim() !== "" && Number.isFinite(n) && n > 0 ? n : 0;
}
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

/** host が居ない時間が猶予を超えたか。タイマーに頼らず、その場で判定する。猶予が無効（既定）なら常に false。 */
function graceExpired() {
  return HOST_GRACE_MS > 0 && runtime.awaySince !== 0 && Date.now() - runtime.awaySince > HOST_GRACE_MS;
}

/** 猶予切れの後始末。何度呼ばれても安全。走っているターンは全部止める。猶予が無効なら何もしない。 */
function giveUp() {
  if (HOST_GRACE_MS <= 0 || runtime.awaySince === 0) return;
  const seconds = Math.round((Date.now() - runtime.awaySince) / 1000);
  runtime.awaySince = 0;
  clearTimeout(runtime.graceTimer);
  runtime.graceTimer = null;
  // エージェントへの理由は承認ごとに会話の言語で（askPermission が messageKey を訳す）。ログは日本語のまま
  for (const [, w] of [...runtime.waiting]) w.settle({ allow: false, messageKey: 'hostAway', messageParams: { seconds } });
  // 承認を返せないまま走らせ続けない。黙って deny し続けるより、止めて気づかせる。
  for (const t of [...runtime.turns.values()]) t.ac.abort();
  void agentTasks?.cancelOwner().catch(() => {});
  console.log(`  host が ${seconds} 秒戻らなかったので中断した`);
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
  locale = localeInfo(prefs);
  setLocale(locale.lang);
  // デスクトップ版の main（ダイアログ・通知・更新のエラー文）にも知らせる（desktop/main.cjs）
  process.parentPort?.postMessage({ type: "locale", locale: locale.lang });
  emitGlobal({ type: "prefs", sessionId: null, prefs, locale });
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
async function applyStatus(backend, sessionId, status, why) {
  const reason = reasonOf(why);
  // ネイティブに持てるなら**そこが正本**。持てなくても sidecar には必ず残る
  if (backend.capabilities?.tag && backend.setTag) await backend.setTag(sessionId, status);
  await store.recordChange(sessionId, { by: "human", field: "status", to: status, ...reason, backend });
  emitGlobal({ type: "status", sessionId, status, by: "human", ...reason });
}

// ---- 保存される変更理由（docs/design.md「多言語対応」） ------------------------
// 変更履歴（sessions.json の history）とイベントの reason は、従来どおり日本語の文を持つ（過去の記録・古い画面と互換）。
// 新しい記録には reasonKey（ui:saved.reason.<key>）と reasonParams を足し、画面が今の言語で出す（web/saved-text.mjs）。
// 過去の記録は reason の文のまま出る。reasonParams の配列（names）は、ja は「・」、画面は言語の区切りでつなぐ。
// i18n-dynamic: ui:saved.reason.
const SAVED_SEPARATOR_JA = '・';
function savedReason(key, params) {
  const ja = Object.fromEntries(Object.entries(params ?? {}).map(([k, v]) => [k, Array.isArray(v) ? v.join(SAVED_SEPARATOR_JA) : v]));
  return { reason: t(`ui:saved.reason.${key}`, { ...ja, lng: 'ja' }), reasonKey: key, ...(params ? { reasonParams: params } : {}) };
}
/** 呼び出しの引数の理由。文字列（従来）か savedReason の形。無ければ reason: null */
function reasonOf(why) {
  if (why && typeof why === 'object') return why;
  return { reason: typeof why === 'string' ? why : null };
}
/**
 * 画面から来た理由。reasonKey が辞書（ui:saved.reason）にあればキーで保存し、無ければ reason の文字列をそのまま。
 * reasonParams は文字列・数（とその配列）だけを受ける
 */
function clientReason(args) {
  const key = args?.reasonKey;
  if (typeof key === 'string' && /^[\w.-]{1,80}$/.test(key) && i18n.exists(`ui:saved.reason.${key}`, { lng: 'ja' })) {
    const plain = (v) => typeof v === 'string' ? v.slice(0, 500) : Number.isFinite(v) ? v : null;
    const params = args.reasonParams && typeof args.reasonParams === 'object' && !Array.isArray(args.reasonParams)
      ? Object.fromEntries(Object.entries(args.reasonParams).slice(0, 10)
        .map(([k, v]) => [k, Array.isArray(v) ? v.slice(0, 10).map(plain).filter(x => x !== null) : plain(v)])
        .filter(([k, v]) => /^\w{1,40}$/.test(k) && v !== null))
      : undefined;
    return savedReason(key, params && Object.keys(params).length ? params : undefined);
  }
  return reasonOf(args?.reason);
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
      // バックエンドが失敗を知らせたら、server の catch では重ねて出さない（同じ失敗が 2 回並んでいた）
      if (event.outcome === "error") turn.errorShown = true;
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
          // 会話の言語。新しい会話は始めたときの画面の言語で、id が決まったここで保存する（再開・委譲の子は runTurn で保存済み）
          store.setSessionData(sessionId, 'agentLocale', turn.agentLocale),
          ...(turn.contextRecord ? [store.setSessionData(sessionId, 'contextSession', turn.contextRecord)] : []),
        // 新規セッションに最初から付ける状態。id が無いうちは host が予約として持っていて、
        // 生まれた瞬間にここで書く。経路は setStatus と同じ（ネイティブ + sidecar + イベント）
        // first（このターンで id が確定した）の 1 本にだけ付ける
        status && event.first ? applyStatus(turn.backend, sessionId, status, savedReason('inheritedStatus')) : null,
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
      // caption は従来どおり日本語の文（web/client.mjs が「添付:」を外して名前を取る）。画面は captionKey で今の言語に訳す（web/saved-text.mjs）
      caption: t('ui:saved.caption.attachment', { name, lng: 'ja' }),
      captionKey: 'attachment',
      captionParams: { name },
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
  if (work && seq === runningSeq) { emitGlobal({ type: "running", ...work }); postResident({ work }); }
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
  if (hadGrace) console.log(HOST_GRACE_MS > 0 ? "  猶予を解除した（host が戻った）" : "  host が戻った");
}

function detach(ws) {
  if (!runtime.sockets.delete(ws)) return;
  if (runtime.sockets.size > 0) return;          // まだ別のタブが居る
  if (runtime.turns.size === 0 && runtime.waiting.size === 0) return;

  runtime.awaySince = Date.now();
  clearTimeout(runtime.graceTimer);
  runtime.graceTimer = null;
  if (HOST_GRACE_MS <= 0) {
    console.log(`  host が離れた。戻るまで待つ (turns=${runtime.turns.size}, waiting=${runtime.waiting.size})`);
    return;
  }
  console.log(`  host が離れた。${HOST_GRACE_MS / 1000} 秒待つ (turns=${runtime.turns.size}, waiting=${runtime.waiting.size})`);
  // 保険のタイマー。ただしこれ単体には頼らない（発火しなくても graceExpired() が拾う）
  runtime.graceTimer = setTimeout(giveUp, HOST_GRACE_MS + 500);
}

/**
 * 承認待ちを片付ける。どのセッションの分かは呼び出し側が必ず指定する。
 * messageKey はエージェントへ返す理由（agent の approval.*。askPermission が会話の言語で訳す）
 */
function settleAll(messageKey, sessionId) {
  // id が決まらないまま終わったターンで全部を deny すると、
  // 走っている他のセッションの承認待ちまで巻き添えにする。何もしない方が安全。
  if (!sessionId) return;
  for (const [, w] of [...runtime.waiting]) {
    if (sessionId && w.payload.sessionId !== sessionId) continue;
    // 中継の複製は「別の会話の承認」をここに出しているだけ。
    // この会話のターンが終わっても取り下げない（元の会話が決着すれば一緒に消える）。
    // 取り下げると、依頼元が ply_task_wait を終えただけで子の承認が拒否される
    if (w.relay) continue;
    w.settle({ allow: false, messageKey });
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
const askPermission = async ({ toolName, input, sessionId, toolUseID, title, signal, canAlways, kind, questions, locale }) => {
  const ancestors = sessionId ? await delegationAncestors(sessionId) : [];
  // 中継先の見出しは「どの会話の承認か」。委譲したときの info.title を使う
  const childTitle = ancestors.length ? (await store.get(sessionId)).title || t('permission.childConversation') : "";
  // 拒否・中断の理由はエージェントに返るので、承認を求めた会話の言語で訳す（settle には messageKey で来る）
  const lng = agentLocaleOf(locale) ?? await agentLocaleFor(sessionId);
  // i18n-dynamic: agent:approval.
  const localize = answer => answer?.messageKey ? { ...answer, message: agentT(lng, `approval.${answer.messageKey}`, answer.messageParams) } : answer;
  // 祖先を読むあいだに中断されたなら、待たせずに返す（abort はもう来ない）
  if (signal?.aborted) return localize({ allow: false, messageKey: 'aborted' });
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
      payload: { ...payload, sessionId: ancestor, canAlways: false, title: title ? t('permission.relayTitleWith', { child: childTitle, title }) : t('permission.relayTitle', { child: childTitle }) },
    }))];
    const onAbort = () => settle({ allow: false, messageKey: 'aborted' });
    const settle = (answer) => {
      // どれか1つで決着し、残りの複製も消す。1つも残っていなければ二重解決
      let found = false;
      for (const card of cards) if (runtime.waiting.delete(card.id)) found = true;
      if (!found) return;
      signal?.removeEventListener?.("abort", onAbort);
      const { messageKey, messageParams, ...rest } = localize(answer);
      resolve(rest);
      permissionsChanged();
    };

    for (const card of cards) runtime.waiting.set(card.id, { settle, payload: card.payload, askedAt: new Date().toISOString(), relay: card.relay });
    signal?.addEventListener?.("abort", onAbort, { once: true });

    // 送れなければ黙って待つ。戻ってきたら attach() が聞き直す。
    // 既定では戻るまで待ち続け、AGENT_HOST_GRACE_MS を指定したときだけ猶予切れがターンごと中断する。
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
    // エラーは ply_delegate の結果として依頼元のエージェントが読む。子の会話は依頼元の会話の言語を継ぐ
    const lng = parent?.agentLocale ?? await agentLocaleFor(owner);
    if (!parent || signal?.aborted) throw new Error(agentT(lng, 'delegation.parentEnded'));
    const backend = getBackend(args.backend);
    if (!backend) throw new Error(agentT(lng, 'delegation.backendDisabled'));
    const cwd = path.resolve(parent.info.cwd, args.cwd ?? '.');
    if (!(await fs.stat(cwd)).isDirectory()) throw new Error(agentT(lng, 'delegation.cwdNotDirectory'));
    // 接続先（決定 3）: 同じエージェントへの委譲なら親の会話の接続先を継ぐ。違うエージェントへは公式に戻す（形式が合わない）
    const parentEndpoint = (await store.get(owner)).compatEndpoint ?? '';
    const inherited = endpointCapable(backend) ? delegatedEndpoint(parent.backend?.id, backend.id, parentEndpoint) : '';
    // 継ぐべき接続先が消えていたら委譲を断る（黙って公式で走らせない）
    if (inherited && !(await compatEndpoints.has(inherited, backend.id))) throw new Error(agentT(lng, 'delegation.endpointDeleted'));
    const endpoint = inherited;
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
      await store.setSessionData(sessionId, 'agentLocale', lng);
      // 子は親の会話のアカウントで走る（親が別のエージェントでも、その会話で選んであるものを継ぐ）
      const parentAccount = (await store.get(owner)).claudeAccount ?? '';
      if (parentAccount) await store.setSessionData(sessionId, 'claudeAccount', parentAccount);
      if (endpoint) await store.setSessionData(sessionId, 'compatEndpoint', endpoint);
      if (signal?.aborted) throw new Error(agentT(lng, 'delegation.aborted'));
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
      // error は完了通知に載って依頼元のエージェントが読む（依頼元の会話の言語）
      if (agentTasks.list(task.sessionId).some(r => r.notification === 'unknown')) return { outcome: 'error', text: last?.text ?? '', error: agentT(await agentLocaleFor(task.parentSessionId), 'delegation.noticeUnknown') };
      return { outcome: signal.aborted ? 'aborted' : execution.outcome ?? outcome, text: last?.text ?? '', error: execution.error };
    } finally { signal.removeEventListener('abort', stopChild); taskExecutions.delete(task.sessionId); }
  },
  deliver: async task => {
    const owner = task.parentSessionId;
    if (sessionBusy(owner) || runtime.background.has(owner) || (await outbox.list(owner)).some(m => !['sent', 'cancelled'].includes(m.status))) return 'requeue';
    // 完了通知は依頼元の会話の言語で。人間の発言と見分ける印は文言ではなく、送った本文のハッシュ（taskNotices。runTurn の internal）
    const lng = await ensureAgentLocale(owner);
    const more = task.result.length > 16000 ? agentT(lng, 'delegation.noticeMore', { offset: 16000 }) : '';
    const prompt = agentT(lng, 'delegation.notice', { taskId: task.taskId, backend: task.backend, status: task.status, task: task.task,
      result: task.result.slice(0, 16000), more, error: task.error ?? '' });
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
  if (switching.has(sessionId) || forking.has(sessionId)) throw new Error(t('agents.switching'));
  // 同じセッションの二重実行は防ぐ。別のセッションなら並行して回してよい
  if (sessionId && runtime.turns.has(sessionId)) throw new Error(t('session.running'));
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
      if (!target || !await validModel(target, reserved.model, cwd, endpointId) || (reserved.mode !== undefined && !target.modes()[reserved.mode])) throw new Error(t('turn.reservedInvalid'));
      await validateEffort(target, reserved.effort ?? '', reserved.model, cwd, endpointInfo);
      if (target.id !== backend.id) await switchBackend(sessionId, backend, target);
      backend = target;
    }
    // 再開のセッションの作業ディレクトリを人が変えた。status / title と同じく履歴に残し、一覧と会話に知らせる。
    // エージェントが新しい cwd でセッションを見つけられるかはエージェント次第（claude は init の id で確かめる）
    if (changedFrom) {
      await store.recordChange(sessionId, { by: "human", field: "cwd", from: changedFrom, to: cwd, ...savedReason('resumeCwd'), backend });
      emitGlobal({ type: "cwd", sessionId, cwd, by: "human", ...savedReason('cwdFrom', { from: changedFrom }) });
    }
    // 会話の言語（エージェントに渡す文の言語）。記録にあればそれ、無ければ今の画面の言語で決めて保存する（新規は id が決まったとき）
    const agentLocale = sessionId ? await ensureAgentLocale(sessionId) : currentLocale();
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
    // 方針（担当・探索の計画）はターンごとに今の設定と作業場所で解き直す。設定の変更は始まっている会話にも次のターンから効く。
    // 「この会話では外す」MCP と開始時刻は会話の方針として引き継ぐ（followSettings）。コンテキストの記録が無いまま送信済みの会話
    // （この機能より前の会話）はエージェント任せのまま。作業場所を変えたときの探し直しは下の読み込み直し（refreshedContext）で知らせる
    const { policy: followed, changed: settingsChanged } = followSettings(previousContext?.policy ?? null, await contextSettings.get(cwd),
      { keepNative: !previousContext && baseline.messages.length > 0 });
    let policy = followed;
    // Pleiad 担当のコンテキストを受け取れないバックエンド（antigravity）では、担当が Pleiad でもエージェント任せとして扱う。
    // 開いても届かない上に、外部 MCP へ無駄に接続（stdio なら起動）してしまう
    const plyContext = managed(policy) && acceptsPlyContext(backend, policy);
    const resolvedContext = plyContext ? await resolveRuntime(policy, { plyServers: await plyMcp.scanInput(), snapshots: CONTEXT_SNAPSHOTS, locale: agentLocale }) : null;
    // 開始時の固定と違う＝指示・Skills が変わった。止めずに今の内容で続ける（resolvedContext が今のファイルで解き直した結果なので、
    // 記録も pin も自動で新しくなる）。指示本文は毎ターン指示欄へ渡し直し、Skills はカタログしか渡していないので技術的な制約は無い。
    // 右パネルの「渡したもの」との食い違いだけが問題なので、読み込み直したことを履歴と会話に残す
    const refreshedContext = Boolean(plyContext && previousContext?.pin && resolvedContext?.pin !== previousContext.pin);
    // コンテキストの設定の変更（担当・探す範囲・外部 MCP の登録や有効／無効）を、このターンから反映した
    const appliedSettings = Boolean(previousContext && settingsChanged.length);
    // instructions_for_path / load_skill で渡し済みの本文の控え（行の id → 本文のハッシュ）。会話の記録に残して
    // 次のターンへ持ち越し、同じものを頼まれたら短い一行だけを返す（core/context-runtime.mjs の contextTools）。
    // 履歴を引き継ぎの文で渡し直すターン（バックエンドの切り替え・ホスト側で写した分岐）と、記録した相手と違うバックエンドでは捨てる。
    // 渡した本文が相手の手元に残っているとは限らないため
    const handoff = await pendingHandoff(sessionId).catch(() => true);
    const delivered = !handoff && previousContext?.delivered?.backend === backend.id ? { ...previousContext.delivered.entries } : {};
    if (resolvedContext) resolvedContext.delivered = delivered;
    // エージェント任せにしたターンでも固定（pin）は捨てない。Pleiad 担当を受け取れるエージェントへ戻したときに突き合わせる
    const contextRecord = { policy: refreshedContext || appliedSettings ? { ...policy, refreshedAt: new Date().toISOString() } : policy,
      pin: resolvedContext?.pin ?? (plyContext ? null : previousContext?.pin ?? null), report: resolvedContext?.report ?? nativeContextReport(policy, cwd, backend),
      delivered: { backend: backend.id, entries: delivered } };
    if (appliedSettings) {
      await store.recordChange(sessionId, { by: 'ply', field: 'context', from: previousContext.pin ?? null, to: contextRecord.pin,
        ...savedReason('contextSettingsApplied'), backend });
      emitGlobal({ type: 'contextRefreshed', sessionId, settings: true, kinds: settingsChanged, names: [], count: 0 });
    } else if (refreshedContext) {
      // 何が変わったかは前の記録と今の記録の突き合わせで出す（pinChanges を呼ぶと同じターンで探索がもう一度走る）
      const changed = pinnedChanges(previousContext.report?.entries ?? [], resolvedContext.report.entries);
      const names = changed.map(c => c.name || path.basename(c.path ?? '')).filter(Boolean).slice(0, 3);
      const reason = !names.length ? savedReason('contextReloaded')
        : changed.length > names.length ? savedReason('contextChangedMore', { names, count: changed.length - names.length })
        : savedReason('contextChanged', { names });
      await store.recordChange(sessionId, { by: 'ply', field: 'context', from: previousContext.pin, to: resolvedContext.pin, ...reason, backend });
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
      agentLocale,
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
        if (!id) throw new Error(t('agentRuntime.visualizeNotStarted'));
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
          ? async (serverName, toolName, input) => Boolean((await askPermission({ toolName: `${serverName} / ${toolName}`, input, sessionId: turn.info.sessionId, signal: turn.ac.signal, kind: 'tool', canAlways: false, locale: agentLocale }))?.allow)
          : undefined });
      if (args.messageId) emit({ type: "userMessage", messageId: args.messageId, text: String(prompt ?? ""), at: args.at, initial: true });
      broadcastRunning();
      syncRunningPoll();
      // 再開なら id が分かっているので先に載せる。新規は session イベントで id が決まった瞬間に（makeEmit）
      if (sessionId && attachments.length) await presentAttachments(sessionId, attachments, emit);
      if (hooks.signal?.aborted) throw new Error(t('turn.aborted'));
      const result = await backend.runTurn({
        prompt,
        sessionId,
        cwd,
        mode: permissionMode,
        model: model || undefined,
        effort,
        emit,
        // 拒否・中断の理由をこの会話の言語で返すため、会話の言語を添えて聞く
        askPermission: request => askPermission({ ...request, locale: agentLocale }),
        signal: turn.ac,
        control: turn.control,
        // エージェントに渡す文（指示・ツールの説明・タイトル生成など）の言語。会話ごとに決めて保存したもの
        locale: agentLocale,
        visualizeInstructions: visualizeInstructions(agentLocale),
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
      if (!turn.errorShown) emit({ type: "turnResult", outcome: "error", error: String(err?.message ?? err) });
      // プロンプトを渡す前に失敗した（backends/undelivered.mjs）。送信済みにしたままだと、本文がどこにも残らず消える。
      // 送信待ちの「失敗」に戻し、利用者に再送か取り消しを選ばせる
      if (err?.undelivered && sessionId && args.messageId) {
        await outbox.undelivered(sessionId, args.messageId, String(err?.message ?? err)).catch(() => {});
      }
      if (!didStart) throw err;
    } finally {
      if (didStart && turn.outcome !== 'ok' && turn.outcome !== 'requeue') await outbox.pause(sessionId).catch(() => {});
      await turn.visualizations.close().catch(err => emit({ type: 'turnResult', outcome: 'error', error: t('turn.visualizationSaveFailed', { error: err.message }) }));
      await Promise.allSettled([runtimeContext?.close()]);
      await saveContext().catch(() => { emit({ type: 'turnResult', outcome: 'error', error: t('turn.contextSaveFailed') }); });
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
  settleAll('turnEnded', turn.info.sessionId);
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

wss.on("connection", (ws, req) => {
  // OS の操作（revealPath / openPath）を許すのは、サーバーのある PC の画面からの接続だけ（core/os-open.mjs）
  const local = isLocalRequest(req);
  // 古い接続を閉じてはいけない。クライアントは切れると自動再接続するので、
  // 「新しい方に付け替える」と互いに閉じ合って永久に落ち着かなくなる。
  // タブが複数あってもよい設計にして、イベントは全部に配る。
  const resumed = runtime.turns.size > 0;
  attach(ws);
  // ready はこの接続にだけ返す。全部に配ると、受けた側のクライアントは初期化し直す
  // （一覧と開いている会話を読み込み直す）ので、別の端末がつながるたびに他の画面が揺れる（issue #11）。
  ws.send(JSON.stringify({
    kind: P.READY,
    protocolVersion: P.PROTOCOL_VERSION,
    version: APP_VERSION,
    homeDir: os.homedir(),
    resumedTurn: resumed,
    // 画面の言語。setting は設定値（auto|ja|en）、lang は実際に使う言語（ja|en）
    locale,
  }));
  ws.on("close", () => detach(ws));

  ws.on("message", async (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg?.kind !== P.COMMAND || !P.COMMANDS.has(msg.command)) return;

    // Command IDs are scoped to a socket. Broadcast events, never private replies
    // (connection-check receipts and concurrent clients can share the same ID).
    // code: 失敗の種類。画面は文言（言語で変わる）ではなくこれで見分ける
    const reply = (ok, payload, code) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ kind: P.RESPONSE, id: msg.id ?? null, ok, ...(ok ? { result: payload } : { error: payload, ...(code ? { code } : {}) }) }));
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
          if (ws.contextScanning) throw Object.assign(new Error(t('scan.busy')), { code: 'SCAN_BUSY' });
          ws.contextScanning = true;
          try { return reply(true, await scanContext(await contextSettings.get(msg.args?.cwd ?? process.cwd(), { level: msg.args?.place === 'default' ? 'default' : null }), { plyServers: await plyMcp.scanInput() })); }
          finally { ws.contextScanning = false; }
        }
        case 'slashSkills': {
          // 入力欄の「/」の候補。コンキスト画面と同じ探索をそのまま使い、スキルだけを返す
          if (ws.contextScanning) throw Object.assign(new Error(t('scan.busy')), { code: 'SCAN_BUSY' });
          ws.contextScanning = true;
          try { return reply(true, skillList(await scanContext(await contextSettings.get(msg.args?.cwd ?? process.cwd())))); }
          finally { ws.contextScanning = false; }
        }
        case "listSessions":
          return reply(true, await sessionList());

        // リモート（ホスト側）。秘密・トークンは返さない（core/remote/connector.mjs）
        case 'remoteStatus':
          return reply(true, await remoteStatus());
        case 'setRemoteSettings':
          return reply(true, withResident(await remote.setSettings(msg.args ?? {})));
        case 'setRemoteResident': {
          await residentPrefs.set({ keepRunning: msg.args?.keepRunning, sleep: msg.args?.sleep });
          const status = await remoteStatus();
          emitGlobal({ type: 'remoteStatus', status, sessionId: null });
          postResident({ status });
          return reply(true, status);
        }
        case 'remotePairingStart':
          return reply(true, await remote.startPairing());
        case 'remotePairingCancel':
          return reply(true, withResident(await remote.cancelPairing()));
        case 'remotePairingApprove':
          return reply(true, await remote.approve(msg.args?.id));
        case 'remotePairingDeny':
          return reply(true, withResident(await remote.deny(msg.args?.id)));
        case 'remoteDevices':
          return reply(true, await remote.devices());
        case 'remoteRevoke':
          return reply(true, withResident(await remote.revoke(msg.args?.id)));

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
          if (accountId && !(await claudeAccounts.has(String(accountId)))) throw new Error(t('accounts.notRegistered'));
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
          if (!backend) throw new Error(t('agents.notFound'));
          const quota = await providerQuota(backend);
          let local;
          try { local = await usageStore.summary(backend.id); }
          catch { local = { error: t('quota.localFailed') }; }
          return reply(true, { backend: backend.id, label: backend.label, quota, local });
        }
        case "backends":
          return reply(true, describeBackends());

        case "setTurnSettings": {
          const { sessionId, backend: targetId, model, mode, cwd: requestedCwd, cancel, account, endpoint } = msg.args ?? {};
          if (!sessionId) throw new Error(t('session.required'));
          if (forking.has(sessionId) || switching.has(sessionId) && !runtime.turns.has(sessionId)) throw new Error(t('session.preparingSettings'));
          const work = (settingsWrites.get(sessionId) ?? Promise.resolve()).catch(() => {}).then(async () => {
            const source = refuseRetired(await resolveBackendForSession(sessionId));
            if (!source) throw new Error(t('session.notFound'));
            const current = { ...(await store.get(sessionId)) };
            // 予約の行き先が今は無いエージェント（対応を終えた procway など）なら、予約は無かったものとして扱う（取り消し・選び直しができるように）
            if (current.nextSettings?.backend && !getBackend(current.nextSettings.backend)) current.nextSettings = null;
            const target = getBackend(targetId ?? current.nextSettings?.backend ?? source.id);
            if (!target) throw new Error(t('agents.notFound'));
            const selectedMode = mode ?? (target.id === (current.nextSettings?.backend ?? source.id)
              ? current.nextSettings?.mode : target.id !== source.id ? await resolveMode(null, undefined, target) : undefined);
            if (!cancel && selectedMode !== undefined && !target.modes()[selectedMode]) throw new Error(t('settings.modeUnavailable'));
            const settingsCwd = requestedCwd || current.nextSettings?.cwd || current.cwd;
            // 互換の接続先（'' = 公式）。エージェントを変えたら、変えた先の既定（設定で「既定にする」を押したもの。無ければ公式）。
            // 元のエージェントへ戻したら、この会話の今の接続先に戻る
            if (endpoint !== undefined && typeof endpoint !== 'string') throw new Error(t('settings.endpointInvalid'));
            const previousSelection = current.nextSettings?.backend ?? source.id;
            const currentEndpoint = current.compatEndpoint ?? '';
            const previousEndpoint = current.nextSettings?.endpoint ?? currentEndpoint;
            let selectedEndpoint = !endpointCapable(target) ? ''
              : endpoint ?? (target.id === previousSelection ? previousEndpoint : target.id === source.id ? currentEndpoint : await compatEndpoints.defaultFor(target.id));
            if (!cancel && endpoint && !(await compatEndpoints.has(endpoint, target.id))) throw new Error(t('settings.endpointNotRegistered'));
            const endpointChanged = selectedEndpoint !== currentEndpoint;
            // 接続先を変えたらモデルは接続先の既定（メインのモデル）に戻す（公式のモデル名を互換の先へ送らない）
            const selectedModel = model ?? (target.id === previousSelection && selectedEndpoint === previousEndpoint ? current.nextSettings?.model ?? current.model ?? "" : "");
            if (!cancel && !await validModel(target, selectedModel, settingsCwd, selectedEndpoint)) throw new Error(t('settings.modelUnavailable'));
            const selectedEndpointRow = await endpointRow(selectedEndpoint);
            const previousBackend = current.nextSettings?.backend ?? source.id;
            const previousEffort = target.id === previousBackend ? current.nextSettings?.effort ?? current.effort ?? ''
              : target.id === source.id ? current.effort ?? '' : (await store.getPrefs()).backends?.[target.id]?.effort ?? '';
            const choices = cancel ? { '': {} } : await effortOptions(target, selectedModel, settingsCwd, selectedEndpointRow);
            const selectedEffort = cancel ? '' : msg.args.effort !== undefined
              ? await validateEffort(target, msg.args.effort, selectedModel, settingsCwd, selectedEndpointRow)
              : Object.hasOwn(choices, previousEffort) ? previousEffort : '';
            // Claude のアカウント（'' = ログイン中のアカウント）。モデルと同じく次のターンから効く
            if (account !== undefined && typeof account !== 'string') throw new Error(t('settings.accountInvalid'));
            const selectedAccount = account ?? current.nextSettings?.account ?? current.claudeAccount ?? '';
            if (!cancel && account && !(await claudeAccounts.has(account))) throw new Error(t('settings.accountNotRegistered'));
            const accountChanged = selectedAccount !== (current.claudeAccount ?? '');
            let selectedCwd = current.nextSettings?.cwd;
            if (!cancel && requestedCwd !== undefined) {
              if (typeof requestedCwd !== "string" || !requestedCwd.trim() || requestedCwd.length > 8192) throw new Error(t('cwd.required'));
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
          if (!sessionId || !(await resolveBackendForSession(sessionId))) throw new Error(t('session.notFound'));
          if (typeof text !== "string" || text.length > 2_000_000 || !Array.isArray(attached) || attached.length > 20) throw new Error(t('session.draftTooLarge'));
          const files = attached.map(a => ({ name: String(a.name ?? ""), path: String(a.path ?? ""), kind: String(a.kind ?? "file"), mime: String(a.mime ?? "") }));
          if (files.some(a => a.path.length > 8192 || a.name.length > 4096)) throw new Error(t('session.attachmentInfoTooLarge'));
          await store.setSessionData(sessionId, "draft", { text, attached: files });
          if ((await store.get(sessionId)).unsent && typeof msg.args?.cwd === "string") {
            await store.setMeta(sessionId, { cwd: msg.args.cwd });
          }
          return reply(true, "saved");
        }

        case "deleteUnsentSession": {
          const { sessionId } = msg.args ?? {};
          if (!sessionId || switching.has(sessionId) || forking.has(sessionId) || runtime.turns.has(sessionId)
              || (await outbox.list(sessionId)).some(m => !['sent', 'cancelled'].includes(m.status))) throw new Error(t('session.cannotDeleteBusy'));
          switching.add(sessionId);
          try {
            if (!(await store.get(sessionId)).unsent) throw new Error(t('session.onlyUnsentDeletable'));
            await deleteUnsentConversation(sessionId);
            await store.removeSession(sessionId);
            releaseAgentConnection(sessionId);
            emitGlobal({ type: "sessionsChanged", sessionId: null, deleted: sessionId });
            return reply(true, "deleted");
          } finally { switching.delete(sessionId); }
        }

        case "switchBackend": {
          const { sessionId, backend: targetId } = msg.args ?? {};
          if (!sessionId) return reply(false, t('session.required'));
          if (runtime.turns.has(sessionId) || switching.has(sessionId) || forking.has(sessionId)) return reply(false, t('session.finishBeforeSwitch'));
          switching.add(sessionId);
          try {
            const source = refuseRetired(await resolveBackendForSession(sessionId));
            const target = getBackend(targetId);
            if (!source || !target) throw new Error(t('agents.notFound'));
            await switchBackend(sessionId, source, target);
            // 接続先はエージェントごとの形式なので、エージェントが変わったら変えた先の既定（「既定にする」を押したもの。無ければ公式）に置き直す
            if (source.id !== target.id) await store.setSessionData(sessionId, 'compatEndpoint', endpointCapable(target) ? await compatEndpoints.defaultFor(target.id) : '');
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
          if (!sessionId || !refuseRetired(await resolveBackendForSession(sessionId))) throw new Error(t('session.notFound'));
          if (typeof messageId !== 'string' || !/^[a-zA-Z0-9-]{8,80}$/.test(messageId)) throw new Error(t('send.messageIdRequired'));
          if (typeof prompt !== 'string' || !prompt.trim()) throw new Error(t('send.messageRequired'));
          if (attachments !== undefined && (!Array.isArray(attachments) || attachments.length > 20)) throw new Error(t('send.tooManyAttachments', { max: 20 }));
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
          const paused = sessionId ? [sessionId] : [...runtime.turns.keys()];
          // 実際の中断を**最初に同期的に**行う。以前は Pleiad タスクの停止と送信待ちの保留（どちらもディスクへの
          // 書き込み）を待ってから中断していたので、タスクを多く作った会話ほど止まるのが遅れ、その間は途中送信も
          // 通ってしまっていた（steer は turn.ac.signal.aborted で断る）
          const targets = sessionId
            ? [runtime.turns.get(sessionId)].filter(Boolean)
            : [...runtime.turns.values()];
          for (const t of targets) {
            t.ac.abort();
            settleAll('aborted', t.info.sessionId);
            // 受け付けたことをすぐ画面に出す。バックエンドが止まり終えるまで（Claude は CLI の終了まで）
            // turnResult / turnEnd は来ないので、それまでの間「中断している」を出す
            if (!t.info.stopping) {
              t.info.stopping = true;
              makeEmit(t)({ type: 'activity', state: 'stopping' });
            }
          }
          if (targets.length) broadcastRunning();
          await agentTasks.cancelOwner(sessionId);
          const ownTask = agentTasks.list().find(r => r.sessionId === sessionId);
          if (ownTask) await agentTasks.cancel(ownTask.taskId);
          for (const id of paused) await outbox.pause(id);
          return reply(true, { aborted: targets.length });
        }

        case 'agentTasks': return reply(true, agentTasks.list(msg.args?.sessionId));
        case 'cancelAgentTask': {
          const task = agentTasks.get(msg.args?.taskId);
          if (!task) throw new Error(t('delegation.taskNotFound'));
          await agentTasks.cancel(task.taskId); return reply(true, agentTasks.get(task.taskId));
        }
        case "resolvePermission": {
          const { id, allow, always, message, messageKey, answers, annotations, response } = msg.args ?? {};
          const w = runtime.waiting.get(id);
          if (!w) return reply(false, t('approval.alreadyResolved'));
          // 回答を伴うツール（質問カード）は、承認ではなく入力の差し替えとして返る。
          // ここでは解釈しない。エージェントが自分の形へ戻す（§2.2）。
          // 拒否の理由は画面の言語ではなく会話の言語でエージェントへ返すので、画面は文ではなく印（messageKey: 'userDenied'）で送る。
          // 文（message）で来たら従来どおりそのまま渡す
          w.settle({
            allow: !!allow,
            always: !!always,
            message: message ?? null,
            ...(!allow && !message && messageKey === 'userDenied' ? { messageKey } : {}),
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
          if (sourceId && !sourceBackend) throw new Error(t('session.sourceNotFound'));
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
          // 既定のタイトルは保存しない（空）。画面が今の言語で既定名を出す（web/style.css の .row-t:empty など）。過去の記録には「新しいセッション」が残っている
          const info = { title: "", cwd, tag: status, createdAt: now, lastModified: now };
          const sessionId = await createConversation(backend, info);
          try {
            await store.setMeta(sessionId, { backend: backend.id, ...info, status, unsent: true });
            // 互換の接続先（決定 2・3）: 同じエージェントの引き継ぎなら元の会話の接続先（予約中ならそれ）を継ぐ。
            // それ以外は設定で「既定にする」を押した接続先（無ければ公式）。削除済みは継がない
            let endpoint = '';
            if (endpointCapable(backend)) {
              if (typeof msg.args?.endpoint === 'string') {
                endpoint = msg.args.endpoint;
                if (endpoint && !(await compatEndpoints.has(endpoint, backend.id))) throw new Error(t('settings.endpointNotRegistered'));
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

        // ファイルの操作（web/file-actions.mjs）。範囲は /file-preview と同じで、実体を解決した後のパスで確かめる。
        // OS の操作は遠隔の接続から断る（画面で隠すだけにしない）。開けるのは HTML だけ
        case "hostCapabilities":
          return reply(true, { osActions: local });
        case "resolvePath": case "revealPath": case "openPath": {
          const hostAction = msg.command !== 'resolvePath';
          if (hostAction && !local) return reply(false, t('files.remoteOnly'));
          try {
            const sessions = await store.getAll();
            const roots = fileRoots(sessions);
            const args = msg.args ?? {};
            const resolved = await resolveSessionFile({ path: args.path, sessionId: args.sessionId, at: args.at, base: args.base }, sessions, roots);
            const { file, stat } = await inspectFile(resolved.path, roots);
            const directory = stat.isDirectory();
            if (!hostAction) return reply(true, { path: file, cwd: resolved.cwd ?? null, kind: directory ? 'directory' : 'file' });
            if (msg.command === 'openPath' && (directory || !OPENABLE.test(file))) return reply(false, t('files.htmlOnly'));
            if (!osActionAllowed()) return reply(false, t('files.tooMany'));
            await openOnHost(msg.command === 'openPath' ? 'open' : 'reveal', file, { directory });
            return reply(true, { path: file });
          } catch (error) {
            const failure = previewFailure(error);
            return reply(false, failure.code === 'read-failed' && error?.message ? error.message : failure.message);
          }
        }

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
          if (!installation(backend.id).installed) throw new Error(t('agents.installRequired'));
          if (backend.auth?.status && !(await backend.auth.status()).loggedIn) throw new Error(t('agents.checkLogin'));
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
          if (!sessionId) return reply(false, t('session.required'));
          const backend = await resolveBackendForSession(sessionId);
          if (!backend) return reply(false, t('agents.notFound'));
          if (!backend.suggestTitle) return reply(false, t('title.unsupported'));
          const { messages } = await history.loadTranscript(sessionId, backend);
          // タイトルは会話の言語で作る（渡す見出しもその言語）
          const lng = await ensureAgentLocale(sessionId);
          const gist = messages
            .filter((m) => m.text)
            .slice(0, 6)
            .map((m) => m.role === "user" ? agentT(lng, 'title.request', { text: m.text.slice(0, 600) }) : agentT(lng, 'title.response', { text: m.text.slice(0, 600) }))
            .join(NL + NL);
          if (!gist) return reply(false, t('title.noContent'));

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
            title = String(await backend.suggestTitle({ transcript: gist, locale: lng, ...context }) ?? "");
          } catch (err) {
            return reply(false, t('title.failed', { error: redactSecret(redactToken(err?.message ?? err, context.oauthToken), context.endpoint?.key) }));
          }

          // 前後の記号を落とす。モデルが鉤括弧やクオートで包むことがある
          title = title.trim().split(NL)[0].replace(/^["'「『]|["'」』。]$/g, "").trim().slice(0, 60);
          if (!title) return reply(false, t('title.empty'));
          return reply(true, { title });
        }

        /**
         * 人間が会話へファイルを渡す。present の逆方向（設計メモ §7）。
         * 中身は作業ディレクトリではなく uploads/ に置く。
         * 相手のリポジトリに勝手に物を増やさないため。
         */
        // 手元のフォルダーを送る（core/folder-uploads.mjs）。作業フォルダーにするのは画面（setTurnSettings の cwd / 未送信の会話の下書き）
        case "uploadCheck":
          return reply(true, await folderUploads.check(msg.args ?? {}));
        case "uploadStart":
          return reply(true, await folderUploads.start(msg.args ?? {}));
        case "uploadChunk":
          return reply(true, await folderUploads.chunk(msg.args ?? {}));
        case "uploadFinish":
          return reply(true, await folderUploads.finish(msg.args ?? {}));
        case "uploadCancel":
          return reply(true, await folderUploads.cancel(msg.args ?? {}));

        case "attachFile": {
          const { sessionId, name, mime, data } = msg.args ?? {};
          if (typeof data !== "string" || !data) return reply(false, t('attach.noContent'));
          const buf = Buffer.from(data, "base64");
          if (buf.length > MAX_UPLOAD_BYTES) {
            return reply(false, t('attach.tooLarge', { size: Math.round(buf.length / 1024 / 1024), limit: 8 }));
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
            if (!getBackend(value)) return reply(false, t('agents.unknown'));
            return reply(true, await savePref(key, value));
          }
          // 画面の言語。auto は OS に合わせる
          if (key === "locale") {
            if (!LOCALE_SETTINGS.includes(value)) return reply(false, t("errors.unknownLocale", { value }));
            return reply(true, await savePref(key, value));
          }
          if (backendId && !getBackend(backendId)) return reply(false, t('agents.unknown'));
          if (key !== "mode" && key !== "model") return reply(false, t('settings.unknownPref', { key }));
          // 語彙はエージェントごとに違う。どれか1つでも知っていれば通す
          const known = await Promise.all((backendId ? [getBackend(backendId)] : listBackends()).map(async (b) =>
            key === "mode" ? Boolean(b.modes()[value]) : value in (await b.models())));
          if (!known.some(Boolean)) return reply(false, t(key === "mode" ? 'settings.unknownMode' : 'settings.unknownModel', { value }));
          return reply(true, await savePref(key, value, backendId));
        }

        // 状態の一括改名。to が空なら状態を外す（＝グループの削除）。
        // 状態は事前定義しないので「グループ」は実体を持たず、付いているセッションの集合でしかない。
        // だから改名も削除も、対象セッションの状態を書き換えるだけで足りる。
        case "renameStatus": {
          const { from, to } = msg.args ?? {};
          if (typeof from !== "string" || !from) return reply(false, t('statuses.renameFromRequired'));
          const next = typeof to === "string" ? to.trim() : "";
          const hit = (await sessionList({ limit: 500 })).filter((x) => (x.status ?? "") === from);
          for (const x of hit) {
            const backend = getBackend(x.backend);
            if (backend?.capabilities?.tag && backend.setTag) {
              await backend.setTag(x.id, next || null).catch(() => {});
            }
            await store.recordChange(x.id, {
              by: "human", field: "status", from, to: next || null, backend,
              ...(next ? savedReason('renameStatus', { to: next }) : savedReason('deleteGroup')),
            });
          }
          // statuses.json の器（アイコン・作った時刻）も一緒に移す。削除なら捨てる（空のグループはこれで消える）
          await store.moveStatus(from, next || null);
          emitGlobal({ type: "status", sessionId: null, status: next, by: "human", bulk: hit.length,
                 ...(next ? savedReason('renamedGroup', { from, to: next }) : savedReason('deletedGroup', { from })) });
          return reply(true, { moved: hit.length });
        }

        // 詳細の読み出しは停止から独立した操作。
        case "loadBackground": {
          const { sessionId, taskId } = msg.args ?? {};
          if (!sessionId || !taskId) return reply(false, t('background.idsRequired'));
          const found = findBackgroundTask(sessionId, taskId);
          if (!found) return reply(true, { task: null });
          const detail = await found.backend?.getBackgroundTask?.(sessionId, taskId);
          return reply(true, { task: detail ?? { ...found.task, status: 'running', output: null } });
        }

        // ターンの中断（abort）とは別に、裏の作業を1本止める。
        case "stopBackground": {
          const { sessionId, taskId } = msg.args ?? {};
          if (!sessionId || !taskId) return reply(false, t('background.idsRequired'));
          const found = findBackgroundTask(sessionId, taskId);
          if (!found) return reply(false, t('background.notRunning'));
          if (!found.backend?.stopBackground) return reply(false, t('background.cannotStop', { backend: found.backendId }));
          const res = await found.backend.stopBackground(sessionId, taskId);
          return reply(true, { stopped: res?.stopped !== false });
        }

        // サブエージェントの会話を読む。表示に要る最小形へ落とす。
        case "loadSubagent": {
          const { sessionId, agentId } = msg.args ?? {};
          if (!sessionId || !agentId) return reply(false, t('background.agentIdsRequired'));
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
          if (!(await validModel(backend, model, undefined, endpointId))) return reply(false, t('settings.unknownModel', { value: model }));
          const from = (await store.get(sessionId)).model ?? "";
          await store.setModel(sessionId, model);
          if (!endpointId) await savePref("model", model, backend.id);
          await store.recordChange(sessionId, {
            by: "human", field: "model", from, to: model, ...clientReason(msg.args), backend,
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
          if (!backend.modes()[mode]) return reply(false, t('settings.unknownMode', { value: mode }));
          const from = (await store.get(sessionId)).mode ?? "default";
          await store.setMode(sessionId, mode);
          // 人間が選んだものを、次に新しく始めるときの既定にする
          await savePref("mode", mode, backend.id);
          await store.recordChange(sessionId, {
            by: "human", field: "mode", from, to: mode, ...clientReason(msg.args), backend,
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
          const { sessionId, status } = msg.args;
          const reason = clientReason(msg.args);
          if (!sessionId) return reply(false, t('session.requiredForStatus'));
          const backend = await pickBackend(sessionId, msg.args?.backend);
          // グループの根を動かすと、まとまりごと移る（中の会話も同じ状態に保つ、§4.1）。
          // 中の会話を動かしたときは、その 1 本だけが出る
          const rows = msg.args?.alone ? [] : await sessionList().catch(() => []);
          const kin = rows.length && isGroupRoot(rows, sessionId) ? groupKin(rows, sessionId) : [];
          await applyStatus(backend, sessionId, status, reason);
          for (const r of kin) {
            const b = getBackend(r.backend) ?? backend;
            await applyStatus(b, r.id, status, reason.reason === null ? savedReason('groupMove') : reason).catch(() => {});
          }
          return reply(true, { moved: kin.map((r) => r.id) });
        }

        // 完了を確認した。ホストに 1 つで、別の窓・別の端末にも read で知らせる（store.markRead が巻き戻さない）。
        // 旧版がブラウザーに持っていた確認済みも、最初につないだときにここへまとめて届く（web/unread.mjs）
        case "markRead": {
          const a = msg.args ?? {};
          const reads = Array.isArray(a.reads) ? a.reads.slice(0, 5000) : [[a.sessionId, a.at]];
          const changed = await store.markRead(reads);
          if (changed.length) emitGlobal({ type: "read", sessionId: null, reads: changed });
          return reply(true, { reads: changed });
        }

        // グループから外す / 戻す。まとまりは親子と状態から決まるので、覚えるのは「外した」ことだけ
        case "setGrouped": {
          const { sessionId, ungrouped } = msg.args ?? {};
          if (!sessionId) return reply(false, t('session.required'));
          await store.setSessionData(sessionId, "ungrouped", ungrouped ? true : null);
          emitGlobal({ type: "group", sessionId, ungrouped: Boolean(ungrouped) });
          return reply(true, { sessionId, ungrouped: Boolean(ungrouped) });
        }

        // 状態グループのアイコン。人間の操作。AI が set_status で渡す経路も同じ store に入る（設計メモ 2.2）
        case "setStatusIcon": {
          const { status, icon } = msg.args ?? {};
          if (typeof status !== "string" || !status.trim()) return reply(false, t('statuses.statusRequired'));
          const saved = await store.setStatusIcon(status, icon);
          emitGlobal({ type: "statusIcon", sessionId: null, status, icon: saved });
          return reply(true, { status, icon: saved });
        }

        // 空のグループを作る。状態は使われた時点で存在する（設計メモ §6）が、
        // 人が先に作った器は statuses.json にある限り存在する（セッション 0 件でも一覧に出る）
        case "createStatus": {
          const status = String(msg.args?.status ?? "").trim();
          if (!status) return reply(false, t('statuses.groupNameRequired'));
          await store.createStatus(status);
          emitGlobal({ type: "status", sessionId: null, status, by: "human", bulk: 0, ...savedReason('createdGroup') });
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
          if (!sessionId) return reply(false, t('session.required'));
          const rows = await sessionList({ limit: 500 });
          const byId = new Map(rows.map((r) => [r.id, r]));
          const { rootId, ids } = familyOf(rows, sessionId);
          return reply(true, { rootId, sessions: ids.map((id) => byId.get(id) ?? { id, parent: null }) });
        }

        case "setTitle": {
          const { sessionId, title } = msg.args;
          const reason = clientReason(msg.args);
          const backend = await pickBackend(sessionId, msg.args?.backend);
          if (backend.capabilities?.title && backend.setTitle) await backend.setTitle(sessionId, title);
          await store.recordChange(sessionId, { by: "human", field: "title", to: title, ...reason, backend });
          emitGlobal({ type: "title", sessionId, title, by: "human", ...reason });
          return reply(true, "ok");
        }

        case "fork": {
          const { sessionId, upToMessageId, beforeMessageId, title } = msg.args;
          const running = runtime.turns.get(sessionId);
          if (!sessionId || forking.has(sessionId) || switching.has(sessionId) && !running) return reply(false, t('session.preparingFork'));
          forking.add(sessionId);
          try {
            await settingsWrites.get(sessionId);
            const backend = refuseRetired(await pickBackend(sessionId, msg.args?.backend));
            if (!backend.fork) return reply(false, t('session.cannotFork'));
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
      reply(false, String(err?.message ?? err), typeof err?.code === 'string' ? err.code : undefined);
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
    const reason = runtime.turns.size ? t('updateLock.turns', { count: runtime.turns.size })
      : runtime.waiting.size ? t('updateLock.approvals', { count: runtime.waiting.size })
      : agentTasks.busy ? t('updateLock.delegation')
      : outbox.busy ? t('updateLock.steer')
      : switching.size || forking.size ? t('updateLock.switching')
      : null;
    const ok = updateGate.acquire(Boolean(reason));
    process.parentPort.postMessage({ type: 'update-lock', id: data.id, ok, reason: ok ? null : reason || t('updateLock.other') });
  }
  if (data?.type === 'update-unlock') updateGate.release();
  if (data?.type === "running") process.parentPort.postMessage({ type: "running", work: await runningWork() });
  if (data?.type === "shutdown" && runtime.turns.size === 0 && !agentTasks.busy) process.exit(0);
});

function announce() {
  const { port } = server.address();
  process.parentPort?.postMessage({ type: "ready", port, token: TOKEN, locale: locale.lang });
  remote.start().catch(() => {});
  // 起動直後の常駐の状態（リモートが無効でも送る。main はそれを見てトレイを出さない）
  if (process.parentPort) Promise.all([residentPrefs.loaded, remote.status(), runningWork()])
    .then(([, status, work]) => postResident({ status: withResident(status), work })).catch(() => {});
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
