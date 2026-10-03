import { effortOptions, validateEffort } from './effort.mjs';
import { listDirs } from './list-dirs.mjs';
import { createQuotaCache, createUsageStore, agentUsage } from './usage.mjs';
import { migrateClaudeUsage } from './usage-migrations.mjs';
// HTTP（web/ の配信）+ WebSocket（/ws）。token gate は constant-time 比較、既定は localhost bind。
//
// ここは**エージェント非依存**。エージェントの実行もセッション管理も core/backends/<id>.mjs が持ち、
// server は「どのエージェントに聞くか」を決めて、正規化イベントを web へ配るだけ。
// 承認の保留・猶予・中断（設計メモ §8.5）だけはここに残す。エージェントに散らすと
// 「host が居ないあいだ deny し続ける」壊れ方がエージェントの数だけ再発する。
import { createAgentTasks, finalReply, gitLine, workspaceLine } from './agent-tasks.mjs';
import { createCompletionNotices, hasPendingChild, canSteerNotice } from './completion-notices.mjs';
import { createSettingApprovals } from './setting-approvals.mjs';
import { createAgentBridge, AGENTS_MCP_PATH, DELEGATING_TOOLS, kindList } from './agent-bridge.mjs';
import { createComputerBridge, COMPUTER_MCP_PATH } from './computer-bridge.mjs';
import { createComputerLock } from './computer-use/lock.mjs';
import { createShots as createComputerShots } from './computer-use/shots.mjs';
import { parentPortComputer, fakeComputerDriver } from './computer-use/driver.mjs';
import { normalizeComputerUse } from './computer-use/policy.mjs';
import { appendFileSync } from 'node:fs';
import { KINDS, JUDGES, TIERS, SIGNALS, normalizeSettings, RETIRED_KEYS, RoutingSettingsError, pinnedRouting, manualRouting, route, candidateStates, settingsWarnings, checkCandidate, selectRetryAccount, parseCandidate, formatSkippedCandidates } from './delegation-routing.mjs';
import { judgeDifficulty, normalizeKey, SECRET_PREFIX as ROUTING_SECRET_PREFIX, JUDGE_SERVICE, JUDGE_TIMEOUT_MS } from './delegation-judges.mjs';
import { createUsageMonitor } from './delegation-usage.mjs';
import { canDelegate, resolveDelegatedMode, modePosition, scopeRank } from './modes.mjs';
import { createGitActivity } from './git-activity.mjs';
import * as gitInfo from './git-info.mjs';
import { createWorktreeHost, writesScope } from './worktree-host.mjs';
import { insideDir, sameDir } from './worktrees.mjs';
import { createCallTracker, timelineOf } from './git-timeline.mjs';
import { createUpdateGate } from './update-gate.mjs';
import { ensureDataSchema } from './data-schema.mjs';
import { localeInfo, setLocale, t, i18n, LOCALE_SETTINGS, agentT, agentLocaleOf, currentLocale } from './i18n.mjs';
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { writeAtomic } from './atomic-file.mjs';
import os from "node:os";
import { readLocalFile } from "./local-files.mjs";
import { isLocalRequest, defaultOpener, createRateLimit, OPENABLE } from './os-open.mjs';
import { readPreview, listTreeFolder, resolveReference, cwdAt, inspectFile, previewFailure } from './file-preview.mjs';
import { fileURLToPath, pathToFileURL } from "node:url";
import { WebSocketServer } from "ws";
import * as P from "./protocol.mjs";
import { registry as opsRegistry } from './ops/index.mjs';
import { OpError, targetText as settingTarget } from './ops/registry.mjs';
import { createControlBridge, CONTROL_MCP_PATH, controlInstructions } from './ops/surfaces/control.mjs';
import { createOpsHttp, OPS_PATH } from './ops/surfaces/http.mjs';
import { writeControlFile, removeControlFile } from './control-file.mjs';
import { addCliToPath, mcpSetup } from './cli-launcher.mjs';
import { parentIdOf } from './ops/sessions.mjs';
import * as store from "./store.mjs";
import * as history from "./history.mjs";
import { createMessageQueue } from "./message-queue.mjs";
import { createSchedule } from './schedule.mjs';
import { createResumeQueue, normalizeLimitResume } from './resume-queue.mjs';
import { createCompactionScheduler, idleCompactionGuards } from './compaction-scheduler.mjs';
import { normalizeCompactionSettings } from './compaction-settings.mjs';
import { mergeCompactionHistory, attachCompactSummaries } from './compaction-history.mjs';
import { createContextSettings } from './context-settings.mjs';
import { scanContext, skillList } from './context-scan.mjs';
import { acceptsPlyContext, followSettings, managed, nativeContextReport, pinChanges, pinnedChanges, resolveRuntime } from './context-runtime.mjs';
import { AGENTS as INSTRUCTION_AGENTS, changePlyInstructions, normalizePlyInstructions, screenState as plyInstructionsScreen, turnInstructions, withAdded } from './ply-instructions.mjs';
import { DEFAULT_OWNERS, pathKey, scanDirectory } from './context-settings.mjs';
import { createContextBridge, CONTEXT_MCP_PATH, connectServer } from './context-bridge.mjs';
import { createContextSession } from './context-session.mjs';
import { createSecretStore, defaultCipher } from './secret-store.mjs';
import { createCompatEndpoints, sweepClaudeFlagSettings, isModelId, redactSecret, CheckError, delegatedEndpoint } from './compat-endpoints.mjs';
import { createClaudeAccounts, redactToken, normalizeName as normalizeAccountName, fetchTokenOrg, ANTHROPIC_API } from './claude-accounts.mjs';
import { createPlyMcp } from './ply-mcp.mjs';
import { redactForPeer } from './redact.mjs';
import { createMcpOAuth } from './mcp-oauth.mjs';
import { importNativeMcp } from './mcp-import.mjs';
import { createMcpConfig } from './mcp-config.mjs';
import { createHooksConfig, HOOK_AGENTS, applyCodexHooks, trimHookRuns, findNodeOnPath } from './hooks-config.mjs';
import { createPlyHooks } from './ply-hooks.mjs';
import { prepareHooksTurn, unifyPreview, importCandidate } from './hooks-unify.mjs';
import { deliverable, classifyNativeRun } from './hooks-plan.mjs';
import { createRemoteHost } from './remote/connector.mjs';
import { createResidentPrefs, residentSignal } from './remote/resident.mjs';
import { createPushNotifier } from './notify/notifier.mjs';
import { createPresence } from './notify/presence.mjs';
import { createNotifySettings } from './notify/settings.mjs';
import { createFolderUploads } from './folder-uploads.mjs';
import { createVisualizationCollector, visualizeInstructions, snapshotResponse, writeSnapshotFile } from './visualize.mjs';
import { plyParts } from './instruction-amount.mjs';
import { computerPrompt } from './backends/computer-delivery.mjs';
import { MIN_BUDGET, MAX_BUDGET } from '../web/instruction-amount.mjs';
import { parentPortBrowser, browserEnvironment, browserInstruction } from './agent-browser.mjs';
import { parentPortScreencast, createScreencastHub, screencastCommand } from './browser-screencast.mjs';
import { createBrowserSiteApprovals } from './browser-confirm.mjs';
import { createBrowserProfiles, createBrowserBridge, findProfile, BROWSER_MCP_PATH } from './browser-profiles.mjs';
import { profileList, profileName, validProfilePref, hasProfile, defaultProfile as defaultBrowserProfile, profileIds as browserProfileIds } from '../web/browser-profiles.mjs';
import { validBrowserPref, externalOrigin } from '../web/browser-confirm-policy.mjs';
import { computerUsePrefs, validComputerUse } from '../web/computer-prefs.mjs';
import { computerUseCapability } from './computer-use-capability.mjs';
import { streamEvents } from "../web/session-stream.mjs";
import { serveFrom } from "../web/history-sync.mjs";
import { switchBackend, createConversation, deleteUnsentConversation, pendingHandoff, conversation } from "./conversations.mjs";
import { familyOf } from "./lineage.mjs";
import {
  getBackend, sessionBackend, listBackends, defaultBackend, describeBackends, resolveBackendForSession,
} from "./backends/index.mjs";

const updateGate = createUpdateGate();
const quotaCache = createQuotaCache();
const usageStore = createUsageStore(store.dataDir);
await ensureDataSchema(store.dataDir);
// Claude の記録に入っていた会話の累計を、ターンの分へ一度だけ直す（core/usage-migrations.mjs、ADR 0053）。
// transcript を読むので起動は待たせない。記録の書き込みとは usageStore の中で直列になる
migrateClaudeUsage({ store: usageStore, projects: path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects') })
  .then(result => { if (result) console.log(`  ${t('usage.migrated', result)}`); })
  .catch(err => console.error(`  ${t('usage.migrateFailed')}`, String(err?.message ?? err)));
const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_VERSION = JSON.parse(await fs.readFile(path.join(HERE, '..', 'package.json'), 'utf8')).version;
const agentBrowser = parentPortBrowser(process.parentPort);
// リモートの端末から PC の内蔵ブラウザーを見る（core/browser-screencast.mjs）。デスクトップ版だけ
const screencastBridge = parentPortScreencast(process.parentPort);
const screencastHub = screencastBridge ? createScreencastHub({ bridge: screencastBridge }) : null;
const screencastClients = new WeakMap();   // ws -> hub に渡す端末
// A nested server may inherit another conversation's shell environment; only this process's bridge can issue browser access.
delete process.env.AGENT_BROWSER_CONFIG;
delete process.env.AGENT_BROWSER_SESSION;
// 会話のシェルで pleiad CLI を使えるよう、起動口（bin/）を PATH の先頭に足す。エージェントのプロセスと `!` の行はこの env を継ぐ（ADR 0090）
addCliToPath(process.env);
// このサーバーが起動した時刻。ready で配る。画面は、これより前の更新による中断だけを「更新の後」とみなす（web/interrupt.mjs の updateInterrupted）
const SERVER_STARTED_AT = Date.now();
const WEB = path.join(HERE, "..", "web");
// 画面の言語（設定値と解決後）。起動時と設定を変えたときに決め直す。ready と prefs イベントで配る（docs/design.md「多言語対応」）
let locale = localeInfo(await store.getPrefs());
setLocale(locale.lang);
let compactionSettings;
let limitResumeSettings = normalizeLimitResume((await store.getPrefs()).limitResume);
try {
  compactionSettings = normalizeCompactionSettings((await store.getPrefs()).autoCompaction ?? {});
} catch (err) {
  console.error('  自動圧縮の保存済み設定が不正です。既定値に戻します:', String(err?.message ?? err));
  compactionSettings = normalizeCompactionSettings();
  await store.setPref('autoCompaction', compactionSettings).catch(saveError => {   // ops-allow-setpref: 起動時に壊れた保存値を既定へ戻す（設定の一覧が読む前）
    console.error('  自動圧縮の既定値を保存できませんでした:', String(saveError?.message ?? saveError));
  });
}

import { installation, cliCommand } from "./cli-installation.mjs";
import { createClaudeLogin } from './claude-login.mjs';
import { createShellRuns, shellMode } from './shell-runs.mjs';
import { createHostSessionSearch } from './session-search-host.mjs';
import { taskStop, backgroundStop, approvalStop, interruptionNote } from './interrupt-stops.mjs';
import { splitInterruptionNotes } from './system-messages.mjs';
import { textForTitleModel } from './prompt-title.mjs';

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
const fileAccess = { dataDir: store.dataDir, uploadDir: UPLOAD_DIR };
// 1 件の添付の上限（2026-09-23 に 8MB から上げた）。中身は断片（512 KiB の base64）で送る（attachStart / attachChunk / attachFinish）。
// 1 通の WS で丸ごと送ると 100MB は約 133MB の 1 通になり、ws の既定の maxPayload（100 MiB）・リモートの 64 MiB の上限を超え、
// 端末内プロキシ・中継・このサーバーのどこでも丸ごと抱えることになるため
const ATTACH_MAX_BYTES = 100 * 1024 * 1024;
// 中身を 1 通で送る古い口（attachFile）の上限。今の画面は使わない（古い画面・テストのため残す）
const ATTACH_INLINE_MAX = 8 * 1024 * 1024;
// 会話に画像そのもの（data URI）として載せる大きさの上限。base64 にして履歴の上限（core/history.mjs の 8 MiB）に収まる大きさ。
// 超える画像はパスだけを載せ、会話には「大きすぎるため省略」とパスのリンクを出す（右パネルで開ける）
const PRESENT_IMAGE_INLINE = 6 * 1024 * 1024;
// 会話に載せる文字のファイルの先頭（字数）。読むのはその分のバイトだけ（大きなファイルを丸ごと読まない）
const PRESENT_TEXT_CHARS = 20000;
// 断片で送る添付の置き場の途中のもの（<UPLOAD_DIR>/.partial）。手元のフォルダーを送る口と同じ仕組みを、1 ファイル・添付の置き場で使う
const attachUploads = createFolderUploads({ root: UPLOAD_DIR, limits: { files: 1, fileBytes: ATTACH_MAX_BYTES, totalBytes: ATTACH_MAX_BYTES } });
const attachPending = new Map();   // uploadId -> { file: 置き場の中の最終のパス, mime }
// 手元のフォルダーを送る口（upload* コマンド、docs/remote.md §8.1）。置き場の既定は ~/Pleiad/uploads（作業フォルダーになるので見える場所）。
// 7 日触られていない途中のものは起動時と 1 日ごとに捨てる
const folderUploads = createFolderUploads({ root: process.env.AGENT_HOST_FOLDER_UPLOADS || undefined });
folderUploads.sweep().catch(() => {});
attachUploads.sweep().catch(() => {});
setInterval(() => { folderUploads.sweep().catch(() => {}); attachUploads.sweep().catch(() => {}); }, 24 * 60 * 60_000).unref();

/** 添付を置く場所。名前は信用せず区切り文字を落とす。id の形はエージェントごとに違うので、形で弾かずパスに使えない字を潰す */
function attachTarget(sessionId, name) {
  const safe = String(name ?? "file").replace(/[^\p{L}\p{N}._-]/gu, "_").slice(-80).replace(/[. ]+$/, "_") || "file";
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const bucket = sessionId ? String(sessionId).replace(/[^A-Za-z0-9._-]/g, "_").replace(/[. ]+$/, "_").slice(0, 200) : "_new";
  return { bucket, dir: path.join(UPLOAD_DIR, bucket), rel: `${stamp}_${safe}` };
}
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
    // スマホの一覧（つながり・最後に送った時刻）も同じ変化で変わる
    notifyStatus().then(next => emitGlobal({ type: 'notifyStatus', status: next, sessionId: null })).catch(() => {});
  },
  log: line => console.log(`  ${line}`) });
// スマホ（離れた端末）への通知（ADR 0086）。判定は core/notify/policy.mjs、暗号は crypto.mjs、送り先は中継の通知の線。
// 各画面が送る presence（見ている会話）で「見ている間は送らない」を決める。PC の通知の設定は <data>/notify.json
const notifyPresence = createPresence();
const notifySettings = createNotifySettings({ dataDir: store.dataDir });
const connectionDevices = new WeakMap();   // ws -> 中継越しの端末（x-pleiad-device。ホストの PC の画面は無い）
const pushNotifier = createPushNotifier({
  devices: () => remote.notifyTargets(),
  presence: notifyPresence,
  send: (deviceId, blob, ttlMs) => remote.sendNotify(deviceId, blob, ttlMs),
  host: () => remote.hostInfo(),
  onSent: (deviceId, at) => remote.markNotified(deviceId, at),
  log: line => console.log(`  ${line}`),
  // 試験で待たずに済むよう、短いターンの下限だけ環境変数で変えられる（既定 30 秒）
  shortTurnMs: Number.isFinite(Number(process.env.AGENT_HOST_NOTIFY_MIN_TURN_MS)) && process.env.AGENT_HOST_NOTIFY_MIN_TURN_MS !== undefined
    ? Number(process.env.AGENT_HOST_NOTIFY_MIN_TURN_MS) : undefined,
});
// ホストとして常駐する設定（docs/remote.md §6.3。core/remote/resident.mjs）。使うのはデスクトップ版のホストだけ（available）。
// トレイとスリープの抑止は main（desktop/resident.cjs）が持つので、リモートの状態か実行中の作業が変わるたびに送る
const residentPrefs = createResidentPrefs({ dataDir: store.dataDir });
const withResident = status => ({ ...status, resident: { available: Boolean(process.parentPort), ...residentPrefs.get() } });
const remoteStatus = async () => withResident(await remote.status());
/** 設定 › 通知の材料: この PC の設定と、スマホ（デスクトップ版の端末以外）の一覧。鍵は含まない */
const notifyStatus = async () => ({
  pc: await notifySettings.pc(),
  devices: (await remote.devices()).filter(d => d.platform !== 'desktop'),
  relayConnected: (await remote.status()).connection.state === 'connected',
});
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
// Hooks（各エージェントの元の設定ファイル。core/hooks-config.mjs）。読むのと、利用者が明示した編集だけ
const hooksConfig = createHooksConfig();
// Pleiad 自身の Hooks の登録と、Hooks の担当（<data>/hooks.json。core/ply-hooks.mjs、ADR 0049）
const plyHooks = createPlyHooks(store.dataDir);
const HOOK_LEAKS_MAX = 20;
/**
 * 切り替えの確認の材料。cwd があればその場所（ユーザーと Git のルートから cwd まで）、無ければユーザーの範囲だけ。
 * Codex の行には hooks/list のプラグイン・管理者の定義を重ねる（止めない出どころとして並べる）
 */
async function hooksUnifyPreview({ cwd = null, direction = 'ply' } = {}) {
  const dir = cwd ? await scanDirectory(cwd) : null;
  const { report, raws } = await nativeRaws(dir);
  const all = await plyHooks.read();
  const view = await plyHooks.view(dir);
  const owner = dir ? view.place?.value : view.defaults.value;
  // agy はコンテキストの Skills も Pleiad 担当だと、カスタムエージェントが hooks まで止める（ADR 0049）。その場所ではそろえた agy の会話を始めない
  const context = await contextSettings.get(dir ?? os.homedir(), dir ? {} : { level: 'default' }).catch(() => null);
  return { ...unifyPreview({ report, raws, hooks: all.hooks, owner, direction }), cwd: dir, owner, scope: dir ? 'place' : 'user',
    // 確認票: 登録と担当の版。保存（setHooksOwner）の直前に照合する
    revision: view.revision, agySkillsConflict: context?.owners?.skill === 'ply' };
}
/**
 * 取り込みの材料。見つかった行（Codex の信頼状態を重ねたもの）と、その元の定義（伏せ字でない）。
 * 元の設定で動いていないか（Codex の信頼状態・agy の enabled）は行の側にあるので、元の定義の行へ写す
 */
async function nativeRaws(dir, ids = null) {
  const report = await hooksConfig.scan({ cwd: dir, scopes: dir ? ['user', 'directory'] : ['user'] });
  await withCodexTrust(report, dir ?? os.homedir(), { trust: true });
  const raws = await hooksConfig.raw({ cwd: dir, ids: ids ?? report.entries.map(e => e.id) });
  const byId = new Map(report.entries.map(e => [e.id, e]));
  for (const r of raws) { const e = byId.get(r.row.id); if (e?.trust) r.row = { ...r.row, trust: e.trust }; }
  return { report, raws };
}/**
 * Codex の hooks の信頼状態を app-server の hooks/list で重ねる（Codex の会話と同じ接続を使う）。
 * Codex の行も Codex のファイルも無ければ呼ばない。trust が偽なら呼ばずに「確かめています」の印（trustPending）だけ付けて返す
 * （一覧を先に返し、画面が trust: true でもう一度頼む。app-server の起動を一覧の表示で待たせない）。
 * Codex を使わない構成・取れないときは「取得できません」（trust: null）。8 秒で諦める
 */
async function withCodexTrust(report, cwd, { trust = true } = {}) {
  if (!report.entries.some(e => e.agent === 'codex') && !report.files.some(f => f.agent === 'codex' && f.exists)) return report;
  if (!trust) {
    report.trustPending = true;
    for (const e of report.entries) if (e.agent === 'codex') e.trustPending = true;
    return report;
  }
  const codex = getBackend('codex');
  if (!codex?.hooksList) return applyCodexHooks(report, null, 'unavailable');
  try {
    const data = await Promise.race([codex.hooksList([cwd]), new Promise((_, no) => setTimeout(() => no(new Error('timeout')), 8_000).unref?.())]);
    return applyCodexHooks(report, data);
  } catch (e) { return applyCodexHooks(report, null, String(e?.message ?? e).slice(0, 200)); }
}
let agentTasks;
// 設定の変更の承認の台帳と、結果を会話へ届ける待ち行列（core/setting-approvals.mjs、ADR 0088）
let settingApprovals;
const agentConnections = new Map();
const taskExecutions = new Map();
// 実行前に拒否されたコマンド（Codex。core/backends/codex-rejections.mjs）を依頼元へ返す形（docs/agent-delegation.md「実行前に拒否されたコマンド」）。
// 依頼元は別のエージェント・別の提供元のモデルのこともあるので、command・reason・raw は形で秘密を伏せて切る
const REJECTION_TEXT_MAX = 300;
const pick = (v, max = 100) => (typeof v === 'string' && v ? v.slice(0, max) : null);
const peerRejection = r => ({
  tool: pick(r.tool), via: pick(r.via), command: redactForPeer(r.command ?? null, REJECTION_TEXT_MAX), shell: pick(r.shell),
  kind: ['policy', 'spawn', 'other'].includes(r.kind) ? r.kind : 'other', reason: redactForPeer(r.reason ?? null, REJECTION_TEXT_MAX),
  raw: redactForPeer(r.raw ?? null, REJECTION_TEXT_MAX), approvalRequested: r.approvalRequested === true, callId: pick(r.callId, 200), turnId: pick(r.turnId, 200),
});
// 子の作業場所の git の要約（ADR 0085）。会話の間のファイル・コミットが無ければ載せない。完了通知と ply_task_status で依頼元が事実を確かめられる
async function taskGitNote(task) {
  const s = task.cwd ? await gitActivity.summary(task.cwd, task.sessionId).catch(() => null) : null;
  const w = s?.session;
  if (!w || (!w.files && !w.commits)) return null;
  return { branch: s.branch, detached: s.detached, head: s.head, linked: s.linked, files: w.files, add: w.add, del: w.del, commits: w.commits };
}
const gitNotice = (lng, git) => (git ? gitLine(lng, git) + '\n' : '');
// 子の分けた作業場所の 1 行（ADR 0089）。分けていない子には何も足さない
const workspaceNotice = (lng, task) => (task.worktree ? workspaceLine(lng, task.worktree, task.workspace) + '\n' : '');
// 完了通知に載せる拒否の件数（先頭から）。全件は ply_task_status の rejections で読む
const NOTICE_REJECTIONS = 3;
function rejectionNotice(lng, list) {
  if (!Array.isArray(list) || !list.length) return '';
  const items = list.slice(0, NOTICE_REJECTIONS).map(r => agentT(lng, 'delegation.noticeRejection', {
    command: r.command ?? r.raw ?? '', reason: r.reason ?? r.kind ?? '' })).join('\n');
  return agentT(lng, 'delegation.noticeRejections', { count: list.length, items }) + '\n';
}
// 委譲の子で main が返答を終え、裏の作業だけを待っている（phase: waiting）ときに待つ上限（docs/agent-delegation.md「子に残った裏の作業」）。
// 過ぎたらサブエージェント以外（終わらないことがあるコマンドなど）を止める。止めると完了通知で main が再開し、ターンが終わる。
// 既定は Claude Code の print モードが裏の作業を待つ上限（CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS の既定 600 秒）と同じ。テストは縮める
const DELEGATION_BACKGROUND_WAIT_MS = Number(process.env.AGENT_HOST_DELEGATION_BACKGROUND_WAIT_MS) > 0 ? Number(process.env.AGENT_HOST_DELEGATION_BACKGROUND_WAIT_MS) : 600_000;
// 止めた裏の作業を依頼元へ返す形。見出しはコマンドのことがあるので、拒否と同じく秘密を伏せて切る
const peerBackground = x => ({ kind: pick(x.kind, 20) ?? 'other', label: redactForPeer(String(x.label ?? ''), REJECTION_TEXT_MAX) ?? '' });
function stoppedBackgroundNotice(lng, list) {
  if (!Array.isArray(list) || !list.length) return '';
  const items = list.slice(0, NOTICE_REJECTIONS).map(x => agentT(lng, 'delegation.noticeStoppedItem', { label: x.label || x.kind })).join('\n');
  return agentT(lng, 'delegation.noticeStoppedBackground', { count: list.length, minutes: Math.max(1, Math.round(DELEGATION_BACKGROUND_WAIT_MS / 60000)), items }) + '\n';
}
// エラー・結果の文はツールの結果としてエージェントが読むので、会話の言語で引く（agent 名前空間。橋は会話ごとに開き、locale はその会話の言語）
async function callAgentOp(owner, name, args, { locale } = {}) {
  const turn = runtime.turns.get(owner);
  const lng = turn?.agentLocale ?? locale;
  if (!turn || turn.ac.signal.aborted) throw new Error(agentT(lng, 'delegation.notRunning'));
  // 使用枠は読むだけなので、読み取り・計画モードでも答える。providerUsage と同じキャッシュを通す
  if (name === 'ply_usage') return agentUsage({ backend: args.backend, list: listBackends, get: getBackend, read: providerQuota, locale: lng });
  const mutation = DELEGATING_TOOLS.includes(name);
  if (mutation && !canDelegate(turn.backend.modes()[turn.info.mode])) throw new Error(agentT(lng, 'delegation.readOnly'));
  // 委譲先の自動振り分け（docs/agent-delegation.md「委譲先の自動振り分け」）。backend を省けばここで選ぶ。
  // 選んだ後は、書いた backend と同じく下の承認の強さの判定・承認カードを通る
  if (name === 'ply_delegate') args = await routeDelegation(args, lng, path.resolve(turn.info.cwd ?? process.cwd(), typeof args.cwd === 'string' ? args.cwd : '.'));
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
  // 分けた作業場所（ADR 0089）。同じリポジトリに書き手が並ぶとき（または isolate: true）、Pleiad が子ごとに作る。isolate: false・git でない・読むだけなら今の場所
  if (name === 'ply_delegate') {
    if (args.isolate !== undefined && typeof args.isolate !== 'boolean') throw new Error(agentT(lng, 'tasks.isolateInvalid'));
    const childCwd = path.resolve(turn.info.cwd ?? process.cwd(), typeof args.cwd === 'string' ? args.cwd : '.');
    const verdict = await worktreeHost.decideIsolation({ owner, turn, cwd: childCwd, kind: args.kind, isolate: args.isolate,
      writes: child ? writesScope(child.modes()[decided?.mode]) : true });
    args = { ...args, isolate: verdict.isolate };
  }
  const result = await agentTasks.call(owner, name, decided?.mode ? { ...args, mode: decided.mode } : args, turn.ac.signal, lng);
  // 子が使い始めるので、振り分けに使う使用量を取り直しておく（待たない）
  if (name === 'ply_delegate' && routingSettingsCache.enabled && ROUTING_USAGE_AUTO) routingUsage.refresh().catch(() => {});
  return result;
}
const agentOpIds = {
  ply_delegate: 'delegation.delegate', ply_task_status: 'delegation.taskStatus', ply_task_wait: 'delegation.taskWait',
  ply_task_send: 'delegation.taskSend', ply_task_cancel: 'delegation.taskCancel', ply_task_list: 'delegation.taskList', ply_usage: 'delegation.usage',
};
const agentBridge = createAgentBridge({ call: async (owner, name, args, { locale } = {}) => {
  const result = await opsRegistry.invoke({ by: 'agent', via: 'mcp', sessionId: owner }, agentOpIds[name], args, opsDeps(locale));
  if (!result.ok) throw new Error(result.error);
  return result.result;
} });

// ---- 委譲先の自動振り分け ------------------------------------------------------
// 設定は prefs.json の delegationRouting（未設定の項目は既定値）。判定器のキーは互換の接続先と同じ秘密の置き場
// （compat-endpoint-secrets.json）に delegation-routing:<service> で置き、画面へは hasKey だけ返す
let routingSettingsCache = normalizeSettings((await store.getPrefs()).delegationRouting);
// Pleiad の指示（core/ply-instructions.mjs）。prefs.json の plyInstructions。まだ無ければ前の版の addedContext（委譲の指示のスイッチ）から作る
let plyInstructionsCache = await (async () => { const prefs = await store.getPrefs(); return normalizePlyInstructions(prefs.plyInstructions, prefs.addedContext); })();
/** 設定 › コンテキストの「Pleiad の指示」。文は画面の言語。委譲と連動の項目は今の委譲先の自動選択の有無を反映する */
const plyInstructionsState = () => plyInstructionsScreen(plyInstructionsCache, currentLocale(), { routing: routingSettingsCache.enabled });
const ROUTING_SERVICES = Object.values(JUDGE_SERVICE);
const routingKey = async service => (await compatSecrets.get(ROUTING_SECRET_PREFIX + service))?.key ?? null;
const lastWarm = new Map();
const routingUsage = createUsageMonitor({
  backends: listBackends,
  installed: id => installation(id).installed,
  read: providerQuota,
  candidates: () => [...new Set(TIERS.flatMap(tier => routingSettingsCache.tiers[tier] ?? []))],
  modelKnown: (b, model) => validModel(b, model, process.cwd()),
  // 一覧をまだ引いていないバックエンド（agy はログインの確認で一覧を覚える）だけ、確かめ直す。
  // 確かめられたら 30 分は繰り返さない。未ログイン・失敗なら次の取り直し（5 分後）でまた確かめる
  warm: async b => {
    if (!b.auth?.status || Date.now() - (lastWarm.get(b.id) ?? 0) < 30 * 60_000) return;
    const status = await b.auth.status().catch(() => null);
    if (status?.loggedIn) lastWarm.set(b.id, Date.now()); else lastWarm.delete(b.id);
  },
  claudeIdentities: () => claudeAccounts.identities(),
  onChange: () => emitGlobal({ type: 'delegationRoutingChanged', change: 'usage', sessionId: null }),
});
// 取り始めるのは待ち受けてから（announce）。onChange が画面へ配るので、runtime ができる前に呼ばない。
// AGENT_HOST_ROUTING_USAGE=off なら定期的には取らない（テストの既定。agy などの子プロセスを勝手に起こさない）
const ROUTING_USAGE_AUTO = process.env.AGENT_HOST_ROUTING_USAGE !== 'off';

/**
 * kind を確かめ、backend が無ければ委譲先を選ぶ。返すのは agentTasks.call に渡す引数（routing・account を足したもの）。
 * cwd は委譲先の作業場所（モデルの一覧は場所の設定で変わりうるので、選んだモデルをそこで確かめ直す）
 */
async function routeDelegation(args, lng, cwd) {
  if (!KINDS.includes(args.kind)) throw new Error(agentT(lng, 'routing.kindRequired', { kinds: kindList(lng) }));
  if (args.backend !== undefined) return { ...args, routing: pinnedRouting({ kind: args.kind, backend: args.backend, model: args.model }) };
  const settings = routingSettingsCache;
  if (!settings.enabled) throw new Error(agentT(lng, 'routing.backendRequired'));
  if (args.model !== undefined || args.effort !== undefined) throw new Error(agentT(lng, 'routing.pinOnly'));
  // 依頼文は判定器へ送る前に確かめる（agentTasks と同じ上限）
  if (typeof args.task !== 'string' || !args.task.trim() || args.task.length > 60000) throw new Error(agentT(lng, 'tasks.textLength', { name: 'task', max: 60000 }));
  const [judged] = await Promise.all([
    judgeDifficulty({ kind: args.kind, task: args.task, judge: settings.judgeByKind[args.kind], escalate: settings.escalateToCerebras, keyOf: routingKey }),
    // 起動直後でまだ一度も取れていない、または古ければ取り直し、判定と同じだけ待つ
    routingUsage.ensureFresh(JUDGE_TIMEOUT_MS),
  ]);
  // 選んだ候補のモデルを委譲先の場所で確かめ直す。取り置きの後に一覧から消えていたら、既定に落とさず次の候補へ
  const rejected = {};
  let ok, routing;
  for (;;) {
    ({ ok, routing } = route({ kind: args.kind, judged, settings, usage: routingUsage.snapshot(), now: Date.now(), rejected }));
    if (!ok) break;
    const picked = getBackend(routing.target.backend);
    if (picked && await validModel(picked, routing.target.model, cwd).catch(() => false)) break;
    rejected[`${routing.target.backend}:${routing.target.model}`] = picked ? 'model_unknown' : 'unavailable';
  }
  if (!ok) {
    // 候補の行は言語によらない形（画面の委譲カードがこの行を読んで理由ごとにまとめる。web/delegation-routing-view.mjs の parseRoutingFailure）
    const skipped = formatSkippedCandidates(routing.skipped);
    throw new Error(agentT(lng, 'routing.exhausted', { kind: args.kind, difficulty: routing.difficulty, avoidPercent: settings.avoidPercent, skipped }));
  }
  const { backend, model, account } = routing.target;
  return { ...args, backend, model, account: account ?? '', routing };
}

/** 設定 › 委譲（段 B の画面）が読む今の状態。キーは hasKey だけ */
async function delegationRoutingState() {
  const settings = routingSettingsCache;
  const usage = routingUsage.snapshot();
  const stored = new Set(await compatSecrets.keys(ROUTING_SECRET_PREFIX).catch(() => []));
  const storage = await compatSecrets.status().catch(() => null);
  return { settings, defaults: normalizeSettings({}), kinds: KINDS, judges: JUDGES, tiers: TIERS, signals: SIGNALS,
    keys: Object.fromEntries(ROUTING_SERVICES.map(s => [s, { hasKey: stored.has(ROUTING_SECRET_PREFIX + s) }])),
    storage: storage ? { encrypted: storage.encrypted, backend: storage.backend, ...(storage.reason ? { reason: storage.reason } : {}) } : null,
    warnings: settingsWarnings({ settings, usage }), candidates: candidateStates({ settings, usage, now: Date.now() }) };
}
// i18n-dynamic: server:routing.settings.
const routingSettingsError = e => e instanceof RoutingSettingsError ? new Error(t(`routing.settings.${e.code}`, e.detail)) : e;

/**
 * 委譲カードの「別の候補でやり直す」（docs/agent-delegation.md「別の候補でやり直す」）。人が選んだ候補で、同じ依頼を
 * 新しいタスクとして作る。元のタスクと「人が委譲先を変えた」ことは新しいタスクの routing.retry に残す（mode: manual）。
 * - 候補は今使えるものだけ（使用量の取り置きで確かめる）。元と同じ委譲先は断る
 * - 元のタスクが動いていれば、止めるかどうか（stop）を画面で確かめてから来る。stop が無ければ断る
 * - 子の承認モードは ply_delegate と同じく依頼元の会話の強さまで。それを超えるなら { confirm } を返し、approved で来たら作る
 */
async function retryAgentTask({ taskId, candidate, account, stop, approved } = {}) {
  const original = agentTasks.get(taskId);
  if (!original) throw new Error(t('delegation.taskNotFound'));
  const parsed = parseCandidate(candidate);
  if (!parsed) throw new Error(t('routing.retry.badCandidate'));
  const from = original.routing?.target ?? { backend: original.backend, model: original.model, account: null };
  const candidateCheck = checkCandidate(candidate, { usage: routingUsage.snapshot(), settings: routingSettingsCache, now: Date.now() });
  const check = selectRetryAccount(candidateCheck, parsed.backend, account);
  if (parsed.backend === from.backend && parsed.model === from.model && (check.account ?? null) === (from.account ?? null))
    throw new Error(t('routing.retry.same'));
  const child = getBackend(parsed.backend);
  if (!check.ok || !child) throw new Error(t('routing.retry.unusable', { candidate, reason: check.ok ? 'unavailable' : check.reason }));
  const owner = original.parentSessionId;
  const parentBackend = await resolveBackendForSession(owner);
  const parentMode = await resolveMode(owner, undefined, parentBackend);
  if (!canDelegate(parentBackend.modes()[parentMode])) throw new Error(t('routing.retry.readOnly'));
  const decided = resolveDelegatedMode({ parentMode, parentModes: parentBackend.modes(), childModes: child.modes() });
  if (decided.escalation && approved !== true) return { confirm: { agent: child.label, mode: child.modes()[decided.mode]?.label ?? decided.mode } };
  if (['queued', 'running', 'cancelling'].includes(original.status)) {
    if (typeof stop !== 'boolean') throw new Error(t('routing.retry.stopChoice'));
    if (stop) await agentTasks.cancel(original.taskId);
  }
  const request = agentTasks.request(original.taskId);
  const routing = manualRouting({ kind: original.routing?.kind ?? null, candidate, check, of: original.taskId, from });
  const task = await agentTasks.call(owner, 'ply_delegate', { kind: routing.kind, task: request.task, ...(request.title ? { title: request.title } : {}), ...(request.context ? { context: request.context } : {}),
    cwd: original.worktree?.origin ?? original.cwd, isolate: Boolean(original.worktree), backend: parsed.backend, model: parsed.model, account: check.account ?? '', routing, mode: decided.mode }, undefined, await agentLocaleFor(owner));
  // 子が使い始めるので、振り分けに使う使用量を取り直しておく（待たない）
  if (routingSettingsCache.enabled && ROUTING_USAGE_AUTO) routingUsage.refresh().catch(() => {});
  return { task };
}
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
  const entry = { key: turn.key, locale: turn.agentLocale, sessionId: turn.info.sessionId ?? null };
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
  try { entry.computer?.close(); } catch {}
  try { entry.browser?.close(); } catch {}
  try { entry.control?.close(); } catch {}
  // 会話を消したら、その会話で撮ったスクリーンショットも消す（ADR 0075）
  computerShots.removeSession(key).catch(() => {});
}

/**
 * 会話ごとの ply_computer の口（docs/computer-use.md「MCP サーバー」）。会話の橋（conversationConnection）と同じ入れ物に持つので、
 * 会話の id が決まったときの付け替えも片付けも同じ。会話の途中でエージェントを替えたら、渡し方（delivery）が変わるので開き直す
 */
function computerConnection(turn) {
  const entry = conversationConnection(turn);
  if (entry.computer && entry.computerBackend === turn.backend.id) return entry.computer;
  try { entry.computer?.close(); } catch {}
  entry.computerBackend = turn.backend.id;
  entry.computer = computerBridge.open({ origin: localOrigin(), locale: entry.locale, delivery: turn.backend.capabilities?.computerUse || undefined,
    agent: () => { const live = runtime.turns.get(entry.key) ?? turn; return { id: live.backend.id, label: live.backend.label }; },
    owner: async () => {
      const live = runtime.turns.get(entry.key);
      if (!live) throw new Error(agentT(entry.locale, 'delegation.notRunning'));
      await live.setup;
      const sessionId = live.info.sessionId;
      if (!sessionId) throw new Error(agentT(entry.locale, 'delegation.idPending'));
      return { turnId: live.presentKey, sessionId, title: (await store.get(sessionId).catch(() => null))?.title ?? '',
        mode: modePosition(live.backend.modes()[live.info.mode]), signal: live.ac.signal, ancestors: await delegationAncestors(sessionId),
        agent: { id: live.backend.id, label: live.backend.label } };
    } });
  return entry.computer;
}

// ---- 内蔵ブラウザーのプロフィール（docs/inapp-browser.md「プロフィール」、ADR 0078） ----------------------------
// 会話の今のプロフィールの正本は会話のメタ。ターンは開始時に決めた値を turn.browserProfile に持ち、ply_browser の切り替えはそれを書き換える
const browserProfiles = createBrowserProfiles({ getPrefs: store.getPrefs, getSession: id => store.get(id), setSessionData: store.setSessionData, rememberLast: store.rememberBrowserProfile });
/** 中継のキー（新しい会話の最初のターンは仮のキー）か会話 ID から、走っているターン */
const browserTurn = id => id ? runtime.turns.get(id) ?? [...runtime.turns.values()].find(turn => turn.browserRelayId === id) ?? null : null;
// ply_browser: エージェントがプロフィールの一覧を読み、会話の今のプロフィールを切り替える。文はエージェントの言語（agent 名前空間）
async function callBrowserOp(owner, name, args, { locale: lng0 } = {}) {
  const turn = runtime.turns.get(owner);
  const lng = turn?.agentLocale ?? lng0;
  if (!turn || turn.ac.signal.aborted) throw new Error(agentT(lng, 'delegation.notRunning'));
  const prefs = await store.getPrefs();
  const mainName = agentT(lng, 'browserProfiles.main');
  const current = hasProfile(prefs, turn.browserProfile) ? turn.browserProfile : await browserProfiles.resolve(turn.info.sessionId);
  const row = (p, now = current) => ({ id: p.id, name: profileName(p, mainName), ...(p.id === defaultBrowserProfile(prefs) ? { default: true } : {}),
    ...(p.id === now ? { current: true } : {}), ...(p.memo ? { memo: p.memo } : {}) });
  if (name === 'list_browser_profiles') return { current, profiles: profileList(prefs).map(p => row(p)) };
  const target = findProfile(prefs, args.profile, mainName);
  if (!target) throw new Error(agentT(lng, 'browserProfiles.unknown', { profile: String(args.profile ?? '').slice(0, 80), names: profileList(prefs).map(p => profileName(p, mainName)).join(', ') }));
  if (target.id === current) return { profile: row(target), changed: false };
  turn.browserProfile = target.id;
  if (turn.info.sessionId) await browserProfiles.set(turn.info.sessionId, target.id, turn.info.cwd);
  // main はタブの一覧と中継のタブ集合を替え、画面に「<エージェント名> が『…』に切り替えました」を出す
  agentBrowser?.profile(turn.browserRelayId ?? turn.info.sessionId ?? turn.key, target.id, turn.backend.label);
  return { profile: row(target, target.id), changed: true, note: agentT(lng, 'browserProfiles.switched') };
}
const browserOpIds = { list_browser_profiles: 'browser.listProfiles', use_browser_profile: 'browser.useProfile' };
const browserBridge = createBrowserBridge({ call: async (owner, name, args, { locale } = {}) => {
  const sessionId = owner();
  const result = await opsRegistry.invoke({ by: 'agent', via: 'mcp', sessionId }, browserOpIds[name], args, opsDeps(locale));
  if (!result.ok) throw new Error(result.error);
  return result.result;
} });
/** このターンに渡す ply_browser（url・headers）。会話のあいだ同じ口を使う（agy は起動時にしか渡せない） */
function browserRuntimeFor(turn) {
  const entry = conversationConnection(turn);
  entry.browser ??= browserBridge.open({ origin: localOrigin(), locale: entry.locale, owner: () => entry.key });
  return { url: entry.browser.url, headers: entry.browser.headers };
}

// ply_control: 操作の一覧（core/ops/）を会話に渡す HTTP の MCP（ADR 0081）。会話に束縛し、その会話の承認モードで権限が決まる（ADR 0082）
const controlBridge = createControlBridge({ registry: opsRegistry, depsFor: opsDeps });
// CLI 用トークン（control.json に書く。画面のトークンとは別で、効くのは /api/ops だけ。ADR 0083）
const CLI_TOKEN = crypto.randomBytes(32).toString('hex');
const cliTokenOk = (given) => { const a = Buffer.from(String(given)), b = Buffer.from(CLI_TOKEN); return a.length === b.length && crypto.timingSafeEqual(a, b); };
const opsHttp = createOpsHttp({
  registry: opsRegistry, depsFor: opsDeps, serverLocale: currentLocale,
  // 会話に束縛した接続のトークン（会話のシェルの環境変数）は、同じ会話に束縛された CLI になる
  authenticate: (token) => { if (cliTokenOk(token)) return {}; const bound = controlBridge.lookup(token); return bound ? { owner: bound.owner, locale: bound.locale } : null; },
});
/** このターンに渡す ply_control（url・headers・instructions）と、会話のシェルへ渡す環境変数（CLI を同じ会話に束縛する）。全会話・3 つのエージェントに渡す */
function controlRuntimeFor(turn) {
  const entry = conversationConnection(turn);
  entry.control ??= controlBridge.open({ origin: localOrigin(), locale: entry.locale,
    // 会話の id が決まるまでは束縛を決められない。束縛なしの主体として通すと、読み取りの会話からの書き込みを断れなくなるので投げる
    owner: async () => {
      const live = runtime.turns.get(entry.key);
      if (live) { await live.setup; if (live.info.sessionId) return live.info.sessionId; }
      else if (entry.sessionId) return entry.sessionId;
      throw new Error(agentT(entry.locale, 'delegation.idPending'));
    } });
  return { url: entry.control.url, headers: entry.control.headers, instructions: controlInstructions(entry.locale),
    env: { PLEIAD_CONTROL_URL: localOrigin(), PLEIAD_CONTROL_TOKEN: entry.control.token } };
}

/** このターンに渡す ply_computer（url・headers・instructions）。使えない・オフ・対応しないエージェントなら null（docs/computer-use.md「エージェントへの渡し方」） */
async function computerRuntimeFor(turn) {
  if (!computerBridge || computerDriver.state()?.supported !== true) return null;
  if (!turn.backend.capabilities?.computerUse) return null;
  if (normalizeComputerUse((await store.getPrefs()).computerUse).enabled === false) return null;
  const { url, headers, instructions } = computerConnection(turn);
  return { url, headers, instructions };
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
 * プレビューのツリー表示の基準。読み取りの許可には使わない（ADR 0050）。
 * 作業ディレクトリ・添付の置き場・Codex の生成画像・全会話の cwd とその変更履歴
 */
function fileRoots(sessions) {
  return [...workspaceRoots, UPLOAD_DIR, ...worktreeHost.worktrees.paths(),
    path.join(process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex"), "generated_images"),
    ...Object.values(sessions).flatMap(s => [s.cwd, ...(s.history ?? []).filter(h => h.field === 'cwd').flatMap(h => [h.from, h.to])])];
}

/** 今の cwd が会話の予約・どれかの会話が使った場所・分けた作業場所のどれかか（画面が言ってきた場所で git を走らせてよいか） */
async function knownCwd(cwd, sessionId = null) {
  const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
  if (await worktreeHost.worktrees.byPath(cwd).catch(() => null)) return true;
  if (sessionId) { const reserved = (await store.get(sessionId).catch(() => null))?.nextSettings?.cwd; if (reserved && same(reserved, cwd)) return true; }
  const known = Object.values(await store.getAll().catch(() => ({}))).flatMap(s => [s.cwd, ...(s.history ?? []).filter(h => h.field === 'cwd').map(h => h.to)]).filter(Boolean);
  return known.some(k => same(k, cwd));
}
/** 分けた作業場所の問い合わせの cwd。明示があれば（知っている場所なら）それ、無ければ会話の cwd */
async function worktreeCwd(args) {
  const asked = typeof args?.cwd === 'string' && args.cwd ? args.cwd : null;
  const id = typeof args?.sessionId === 'string' && args.sessionId ? args.sessionId : null;
  if (asked && await knownCwd(asked, id)) return asked;
  return gitCwd(args);
}
/**
 * git の問い合わせの作業場所（ADR 0085）。会話があればその会話の cwd（sidecar か、無ければエージェントの記録）。
 * 会話の無い下書きは、cwd を言ってきても、どれかの会話が使ったことのある場所だけ通す（任意のフォルダーで git を走らせない）。
 */
async function gitCwd(args) {
  const id = typeof args?.sessionId === 'string' && args.sessionId ? args.sessionId : null;
  if (id) {
    const meta = await store.get(id).catch(() => null);
    if (meta?.cwd) return meta.cwd;
    const backend = await resolveBackendForSession(id).catch(() => null);
    return (await backend?.getSession?.(id).catch(() => null))?.cwd ?? null;
  }
  const cwd = typeof args?.cwd === 'string' && args.cwd ? args.cwd : null;
  if (!cwd) return null;
  return await knownCwd(cwd) ? cwd : null;
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
    const baseFile = await inspectFile(base, fileAccess);
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
  if (url.pathname === COMPUTER_MCP_PATH && computerBridge) return computerBridge.handle(req, res);
  if (url.pathname === BROWSER_MCP_PATH) return browserBridge.handle(req, res);
  if (url.pathname === CONTROL_MCP_PATH) return controlBridge.handle(req, res);
  // CLI の口。画面のトークンは受けず、CLI 用トークンか会話の接続のトークンだけを受ける（core/ops/surfaces/http.mjs）
  if (url.pathname === OPS_PATH || url.pathname.startsWith(`${OPS_PATH}/`)) return opsHttp(req, res, url);

  // 静的ファイルもトークンで守る。守られているのが WebSocket だけだと、
  // リモートに出したときに UI 一式が誰でも取れてしまう。
  // 最初に ?token= で来たらクッキーに入れ、以降の css/js はそれで通す。
  const viaQuery = url.searchParams.get("token");
  const ok = tokenOk(viaQuery) || tokenOk(tokenFromCookie(req.headers.cookie));
  if (!ok) {
    res.writeHead(401, { "content-type": "text/plain; charset=utf-8" });
    return res.end(t('auth.tokenRequired'));
  }
  // 画面が「このページのトークンがまだ通るか」を確かめる口（web/connection-status.mjs）。通れば 204、通らなければ上の 401。本文は返さない
  if (url.pathname === "/auth-check") {
    res.writeHead(204, { "cache-control": "no-store" });
    return res.end();
  }

  // コンピューターの操作のスクリーンショット（core/computer-use/shots.mjs）。id は 32 桁の hex だけ。トークンの認証は上で済んでいる（/local-file は使わない。ADR 0075）
  const computerShot = /^\/computer-shot\/([0-9a-f]{32})\.jpg$/.exec(url.pathname)?.[1];
  if (computerShot) {
    const body = await computerShots.read(computerShot);
    if (!body) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'private, no-store' }); return res.end('not found'); }
    res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'private, max-age=31536000, immutable', 'x-content-type-options': 'nosniff', 'content-length': body.length });
    return res.end(req.method === 'HEAD' ? undefined : body);
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
          // list=1 はプレビューの横のツリーの 1 フォルダー（開いたとき・「さらに表示」。web/file-preview.mjs）
          const preview = url.searchParams.get('list') === '1'
            ? await listTreeFolder(resolved.path, { access: fileAccess, offset:Number(url.searchParams.get('offset')) || 0 })
            : await readPreview(resolved.path, roots, { access: fileAccess, resource:url.searchParams.get('resource') === '1' });
          res.writeHead(200, { 'content-type':'application/json; charset=utf-8', 'cache-control':'private, no-store', 'x-content-type-options':'nosniff' });
          return res.end(JSON.stringify({ ...preview, line:resolved.line, cwd:resolved.cwd }));
        } catch (error) {
          const failure = previewFailure(error);
          res.writeHead(failure.code === 'not-found' ? 404 : 400, { 'content-type':'application/json; charset=utf-8', 'cache-control':'private, no-store' });
          return res.end(JSON.stringify({ error:failure, path:resolved?.path ?? url.searchParams.get('path') }));
        }
      }
      const { body, headers } = await readLocalFile(url.searchParams.get("path"), fileAccess, { download:url.searchParams.get('download') === '1' });
      res.writeHead(200, headers);
      return res.end(body);
    }
    // 会話に保存された可視化の写しを単体で返す（右パネルの「ブラウザーで開く」）。中身はサーバーの記録から引き、
    // 画面から HTML を受け取らない（リモートの接続口は GET だけを通す）。守りは応答ヘッダーの sandbox（core/visualize.mjs）
    if (url.pathname === '/visualization-snapshot') {
      const sessionId = url.searchParams.get('sessionId'), id = url.searchParams.get('id'), at = url.searchParams.get('at');
      const record = sessionId && (id || at)
        ? await history.findVisualization(sessionId, await resolveBackendForSession(sessionId).catch(() => null), { id, at }).catch(() => null)
        : null;
      if (!record) {
        res.writeHead(sessionId && (id || at) ? 404 : 400, { 'content-type':'text/plain; charset=utf-8', 'cache-control':'private, no-store', 'x-content-type-options':'nosniff' });
        return res.end(t('filePreview.visualize.snapshotNotFound'));
      }
      const { headers, body } = snapshotResponse(record, await store.getPrefs());
      res.writeHead(200, headers);
      return res.end(req.method === 'HEAD' ? undefined : body);
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

// ---- 中断と再開（docs/design.md「中断と再開」・ADR 0036） ----------------------------
// 中断の理由。user = 中断ボタン、update = 更新のため、quit = 終了のため、hostAway = ホスト不在の猶予切れ、
// restart = Pleiad が落ちた・強制終了で終わりが記録されていないターン（起動時に store.recoverInterruptedTurns が付ける）
const INTERRUPT_REASONS = new Set(["user", "update", "quit", "hostAway", "restart", "limit"]);
// abort で画面・デスクトップが渡せる理由。ほかの値（不正・省略）は user として扱う
const ABORT_REASONS = new Set(["user", "update", "quit"]);
const abortReason = (value) => (ABORT_REASONS.has(value) ? value : "user");
/** 保存された中断の印を、画面へ渡す形 { at, reason } に揃える。形が崩れていれば null */
function interruptedOf(value) {
  if (!value || typeof value !== "object" || !Number.isFinite(value.at)) return null;
  return { at: value.at, reason: INTERRUPT_REASONS.has(value.reason) ? value.reason : "user",
    ...(value.reason === 'limit' ? { resetsAt: Number.isFinite(value.resetsAt) ? value.resetsAt : null,
      window: value.window ?? null, account: value.account ?? null, backend: value.backend ?? null,
      autoResume: value.autoResume === true, notifyAtReset: value.notifyAtReset === true,
      sentAt: Number.isFinite(value.sentAt) ? value.sentAt : value.at } : {}) };
}

/** 状態を最後に変えたのが AI（host のツールの ai・操作の一覧の agent。ADR 0081）なら { reason, reasonKey?, reasonParams? }、そうでなければ null */
function statusChangedByAi(history) {
  const row = [...(history ?? [])].reverse().find(h => h?.field === "status");
  if (row?.by !== "ai" && row?.by !== "agent") return null;
  return { reason: row.reason ?? null, ...(row.reasonKey ? { reasonKey: row.reasonKey, ...(row.reasonParams ? { reasonParams: row.reasonParams } : {}) } : {}) };
}

/**
 * エージェントのネイティブな行（無ければ null）と sidecar の行を、一覧の 1 行に合わせる。
 *
 * タイトルと状態は「ネイティブに持てるならそれが正本」（§2.4）。持てないエージェントが
 * ネイティブ一覧に何か（先頭プロンプト等）を返しても、人が付けた sidecar のタイトルを隠さない。
 * 正本が空なら片方へ落ちる。parent は host が分けたもの（sidecar）と向こうで分けたもの
 * （codex の forkedFromId）の両方から読む。一覧と系譜（lineage）が同じ行を見るよう、合成はここだけ。
 */
/**
 * 分けた作業場所の中で動いている会話の行に、元の場所と枝分かれの印を足す（ADR 0089）。行の場所は元の場所の名前で出し、
 * 最近の場所の候補（place）にも分けた作業場所のパスを並べない。sessionRow は台帳を知らない純粋な組み立てのまま
 */
function withWorktree(row) {
  const entry = row?.cwd ? worktreeHost.worktrees.lookup(row.cwd) : null;
  if (!entry) return row;
  row.worktree = { id: entry.id, branch: entry.branch, origin: entry.origin };
  if (row.place) row.place = entry.origin;
  return row;
}
function sessionRow(b, s, extra = {}) {
  const nativeTitle = b.capabilities?.title;
  return {
    id: s?.sessionId ?? extra.id,
    backend: b.id,
    title: (nativeTitle ? s?.title ?? extra.title : extra.title ?? s?.title) ?? "(no title)",
    // 事前定義なし。使われた時点で存在する
    status: (b.capabilities?.tag && s ? s.tag : extra.status ?? s?.tag) ?? null,
    statusChangedAt: extra.statusChangedAt ?? null,
    // 状態を最後に変えたのが AI のときだけ、その理由（画面が小さな「AI」の印を出す）。人が変えていれば null
    statusByAi: statusChangedByAi(extra.history),
    completedAt: extra.completedAt ?? null,
    contextWindow: extra.contextWindow ?? null,
    compactionAt: compactionScheduler.get(s?.sessionId ?? extra.id),
    compacted: Boolean(extra.compacted),
    autoCompactionOff: Boolean(extra.autoCompactionOff),
    // 中断したまま次のターンが始まっていない印 { at, reason }。無ければ null（docs/design.md「中断と再開」）
    interrupted: interruptedOf(extra.interrupted),
    // 確認済みの完了時刻。ホストに 1 つで、どの端末から見ても同じ（store.markRead・docs/design.md「完了・未確認」）
    readAt: Number.isFinite(extra.readAt) ? extra.readAt : null,
    parent: extra.parent ?? s?.parent ?? null,
    // 人が外した／解除したグループ。まとまり自体は親子と状態から決まる（web/family.mjs）
    ungrouped: Boolean(extra.ungrouped),
    delegation: extra.delegation ?? null,
    // 委譲の子の会話がどう選ばれたか（自動の振り分け・固定。core/delegation-routing.mjs）
    routing: extra.routing ?? null,
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
    // 最近の場所の候補（ユーザーが Pleiad で使った場所。委譲の子会話やネイティブのみの会話は除外）
    place: (extra.delegation || typeof extra.cwd !== 'string' || !extra.cwd.trim()) ? null : extra.cwd.trim(),
    lastModified: toMs(s?.lastModified) ?? toMs(extra.lastModified),
    createdAt: s?.createdAt ?? extra.createdAt ?? null,
  };
}

/**
 * 最近の場所のフォルダー実在確認。
 * G:\ などの仮想ドライブ・ネットワーク共有で stat がハングしても一覧の応答を止めないよう、
 * 最長 PLACE_CHECK_TIMEOUT_MS で打ち切る（その回は「無い」扱い）。stat の結果は届いた時点で
 * PLACE_CHECK_TTL_MS だけ覚える（打ち切った回の「無い」は覚えない。遅いドライブが次の一覧で戻るように）。
 * 同じ場所の stat は 1 本にまとめる。
 */
const PLACE_CHECK_TTL_MS = 30_000;
const PLACE_CHECK_TIMEOUT_MS = 1_000;
const placeCheckCache = new Map();    // path -> { at: number, isDir: boolean }
const placeCheckInflight = new Map(); // path -> Promise<boolean>

async function isExistingDirectory(dirPath) {
  if (typeof dirPath !== 'string' || !dirPath.trim()) return false;
  const hit = placeCheckCache.get(dirPath);
  if (hit && Date.now() - hit.at < PLACE_CHECK_TTL_MS) return hit.isDir;

  let stat = placeCheckInflight.get(dirPath);
  if (!stat) {
    stat = fs.stat(dirPath).then(st => st.isDirectory(), () => false).then((isDir) => {
      placeCheckCache.set(dirPath, { at: Date.now(), isDir });
      placeCheckInflight.delete(dirPath);
      return isDir;
    });
    placeCheckInflight.set(dirPath, stat);
  }
  let timer;
  const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve(false), PLACE_CHECK_TIMEOUT_MS); timer.unref?.(); });
  try { return await Promise.race([stat, timeout]); } finally { clearTimeout(timer); }
}

/**
 * エージェントごとのネイティブ一覧を使い回す。読むのに時間がかかり（Codex の thread/list は 1 秒前後）、
 * 一覧・系譜（lineage）・他の会話の出来事のたびの取り直しで同じものを何度も読んでいた。
 * 一覧に効く出来事（emitGlobal のうち LIST_NEUTRAL_EVENTS 以外）で捨てる。Pleiad の外（CLI）で動いた分は
 * NATIVE_LIST_TTL_MS で読み直す。同時に来た読み出しは 1 回にまとまる。sidecar（store）はメモリにあるので毎回読む
 */
const NATIVE_LIST_TTL_MS = 10_000;
const nativeLists = new Map();   // `${backend.id}\0${limit}` -> { at, generation, rows: Promise<Array> }
let nativeListGeneration = 0;
function nativeSessions(b, limit) {
  const key = `${b.id}\0${limit}`;
  const hit = nativeLists.get(key);
  if (hit && hit.generation === nativeListGeneration && Date.now() - hit.at < NATIVE_LIST_TTL_MS) return hit.rows;
  const entry = { at: Date.now(), generation: nativeListGeneration, rows: null };
  // 読めなかった分は覚えない（次の呼び出しで読み直す）
  entry.rows = b.listSessions({ limit }).catch(() => { if (nativeLists.get(key) === entry) nativeLists.delete(key); return []; });
  nativeLists.set(key, entry);
  return entry.rows;
}
function invalidateSessionLists() { nativeListGeneration++; }

/**
 * 1 つの会話の題。一覧の行と同じ決め方（ネイティブの題と sidecar の題。sessionRow）で、スマホへの通知の見出しに使う。無ければ ''。
 * ネイティブ一覧は使い回しを使う（毎回は読み直さない）
 */
async function conversationTitleOf(sessionId) {
  try {
    const side = await store.get(sessionId);
    const b = await resolveBackendForSession(sessionId);
    if (!b) return side.title ?? '';
    const native = (await nativeSessions(b, 100)).find(s => s.sessionId === sessionId) ?? null;
    const title = sessionRow(b, native, { ...side, id: sessionId }).title;
    return title && title !== '(no title)' ? title : '';
  } catch { return ''; }
}

/**
 * 全エージェントのネイティブ一覧と sidecar を1つに合わせる（docs/multi-backend.md §2.1）。
 * ネイティブ一覧に出ないセッション（sidecar にしか無いもの）も落とさずに足す。
 */
async function sessionList({ limit = 100, track = true } = {}) {
  const backends = listBackends();
  const [side, ...lists] = await Promise.all([
    store.getAll().catch(() => ({})),
    ...backends.map((b) => nativeSessions(b, limit)),
  ]);

  const rows = new Map();

  backends.forEach((b, i) => {
    for (const s of lists[i]) rows.set(s.sessionId, withWorktree(sessionRow(b, s, side[s.sessionId])));
  });

  // sidecar にしか無い行。どのエージェントのものか分からないもの（v1 から引き継いだ行で
  // まだ一度も触っていないもの）は出さない。出しても開けないので一覧を濁すだけ。
  // 対応を終えたエージェントの会話は出す（読めるが続けられない。sessionBackend の retired）
  for (const [id, extra] of Object.entries(side)) {
    const b = rows.has(id) || !extra.backend ? null : sessionBackend(extra.backend);
    if (!b) continue;
    const managed = b.retired ? await b.getSession(id).catch(() => null) : null;
    rows.set(id, withWorktree(sessionRow(b, managed, { ...extra, id })));
  }

  const places = new Set();
  for (const row of rows.values()) {
    if (row.place) places.add(row.place);
  }
  if (places.size > 0) {
    const verified = new Map();
    await Promise.all([...places].map(async (p) => {
      verified.set(p, await isExistingDirectory(p).catch(() => false));
    }));
    for (const row of rows.values()) {
      if (row.place && !verified.get(row.place)) {
        row.place = null;
      }
    }
  }

  if (track) for (const row of rows.values()) if (row.cwd) workspaceRoots.add(row.cwd);
  return [...rows.values()].sort((a, b) => (b.lastModified ?? 0) - (a.lastModified ?? 0));
}

/**
 * セッション検索（会話の本文まで。docs/design.md「セッション検索」）。本文の写しを持ち、search(input) に答える。
 * ここから呼ぶ（画面・MCP・CLI への口は core/ops/ が持つ）。起動後に裏で写しを作り、ターンの終わり・loadSession で更新する。
 * 一覧は workspaceRoots に足さない（検索が読むだけで、ファイルの許可を広げない）。
 */
const sessionSearch = createHostSessionSearch({
  listSessions: () => sessionList({ limit: 500, track: false }),
  resolveBackend: resolveBackendForSession,
  onError: (id, err) => console.error(`  セッション検索の読み込みに失敗${id ? ` (${id})` : ''}:`, String(err?.message ?? err)),
});

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
//   taskHints: Map<tool_use id, { label, prompt, model }>, pastSubagents: Set<agentId>, subagentOrigins: Map<agentId, tool_use id> }

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
  // 承認待ちを却下する前に、止めるターンが抱えているもの（承認待ち・裏の作業）を控える（中断で終わったら会話の「止めたもの」に残す）
  for (const t of runtime.turns.values()) t.stops ??= captureStops(t);
  // エージェントへの理由は承認ごとに会話の言語で（askPermission が messageKey を訳す）。ログは日本語のまま
  for (const [, w] of [...runtime.waiting]) if (!w.detached) w.settle({ allow: false, messageKey: 'hostAway', messageParams: { seconds } });
  // 承認を返せないまま走らせ続けない。黙って deny し続けるより、止めて気づかせる。
  // 中断の理由は hostAway（会話に中断として残り、戻った人が「再開」で続けられる）
  for (const t of [...runtime.turns.values()]) { t.abortReason ??= "hostAway"; t.ac.abort(); }
  void agentTasks?.cancelOwner().then(list => recordTaskStops(list, 'hostAway')).catch(() => {});
  console.log(`  host が ${seconds} 秒戻らなかったので中断した`);
}

// 会話の一覧の行を変えない、数の多い出来事。これ以外の出来事ではネイティブ一覧の使い回しを捨てる（nativeSessions）
const LIST_NEUTRAL_EVENTS = new Set([
  "text.delta", "text.end", "thinking.start", "thinking.delta", "tool.start", "tool.result", "activity",
  "userMessage.delivered", "running", "permission", "outbox", "mcpAuth", "claudeLogin", "computer.state",
  "contextWindow", "compaction", "compactionSchedule", "autoCompactionSettings", "conversationAutoCompaction", "settingsChanged", "settingApproval",
  // 入力欄の `!`（core/shell-runs.mjs）。一覧の行は変わらない
  "shell.start", "shell.output", "shell.done", "shell.skip", "shell.handed",
]);

// 接続ごとに、いま開いている会話（loadSession の watch）。宣言した接続には、流れの出来事（streamEvents）を
// その会話の分だけ送る。画面は開いていない会話の流れを捨てていたが、全部の会話の文字の流れが全端末へ届き、
// 中継を通るスマホでは通信と処理の重さになっていた（ADR 0024）。
// 完了（turnEnd）は一覧・通知に使うので全部送る。宣言していない接続（古い画面・テスト）には今までどおり全部送る
const watching = new WeakMap();   // ws -> sessionId
const WATCH_EXEMPT = new Set(["turnEnd"]);
function wanted(ws, event) {
  if (!watching.has(ws) || !event?.sessionId || !streamEvents.has(event.type) || WATCH_EXEMPT.has(event.type)) return true;
  return watching.get(ws) === event.sessionId;
}

/** つながっている host 全部に送る（開いている会話を宣言した接続には、その会話の流れだけ）。1つでも届けば true。 */
function sendTo(frame) {
  const text = JSON.stringify(frame);
  const event = frame.kind === P.EVENT ? frame.event : null;
  let sent = false;
  for (const ws of runtime.sockets) {
    if (ws.readyState !== ws.OPEN) continue;
    // 見ていない会話の分は送らないが、届け先が居たことにする（誰も居ないときだけ溜める）
    sent = true;
    if (!event || wanted(ws, event)) ws.send(text);
  }
  return sent;
}
// 入力欄の `!`（シェルの行。ADR 0054）。走っている子のプロセスはサーバーの終わりに止める
const shellRuns = createShellRuns({ store, emit: event => emitGlobal(event) });
// git の動き（ADR 0085）。状態・ターンの始まりと終わりの隠し ref・変更の一覧と差分。git が無い・git 管理外は null
const gitActivity = createGitActivity();
// 分けた作業場所（ADR 0089）。台帳・作成・片付けと、ぶつかり・委譲の判定。使っているもの（走っているターン・シェル・委譲の子）を見てから消す
const worktreeHost = createWorktreeHost({
  dataDir: store.dataDir, store,
  turns: () => runtime.turns, shellCwds: () => shellRuns.cwds(), tasks: () => agentTasks?.list() ?? [], background: () => runtime.background,
  emit: event => emitGlobal(event), reason: (key, params) => savedReason(key, params),
  // 依頼元が今のターンでファイルを変えているか（ターンの始まりの撮影と今の作業ツリーの差）。撮影が無ければ分からないので false
  parentWrote: async (turn, root) => {
    if (!turn.git?.startTree || !sameDir(turn.git.root, root)) return false;
    const tree = await gitInfo.snapshotTree(root);
    const diff = tree ? await gitInfo.diffFiles(root, turn.git.startTree, tree) : null;
    return (diff?.total.files ?? 0) > 0;
  },
  log: line => { if (process.env.AGENT_HOST_WORKTREE_LOG) console.log(`  worktree: ${line}`); },
  // AGENT_HOST_WORKTREES=off で分けた作業場所を作らない。テストのサーバーが開発中のリポジトリ（<リポジトリ>.pleiad）に残さないため（tests/lib/server.mjs）
  worktreeOptions: {
    ...(process.env.AGENT_HOST_WORKTREE_GRACE_MS !== undefined ? { graceMs: Number(process.env.AGENT_HOST_WORKTREE_GRACE_MS) || 0 } : {}),
    ...(process.env.AGENT_HOST_WORKTREES === 'off' ? { disabled: true } : {}),
  },
});
/** 片付けをまとめて 1 回（ターンの終わり・委譲の完了・パネルを開いたとき。重ならない） */
let worktreeSweeping = false, worktreeSweepAgain = false;
function worktreeSweepSoon() {
  if (worktreeSweeping) { worktreeSweepAgain = true; return; }
  worktreeSweeping = true;
  worktreeHost.sweep().catch(e => console.error('  分けた作業場所の片付けに失敗:', String(e?.message ?? e)))
    .finally(() => { worktreeSweeping = false; if (worktreeSweepAgain) { worktreeSweepAgain = false; worktreeSweepSoon(); } });
}
/** 人が決めた次のターンの予約から外れた分けた作業場所を、使っていなければ片付ける */
async function settleWorktreeAt(cwd) {
  const entry = cwd ? await worktreeHost.worktrees.byPath(cwd).catch(() => null) : null;
  if (entry && entry.state === 'ready') await worktreeHost.worktrees.settle(entry.id).catch(() => {});
}
const publicWorktree = entry => ({ id: entry.id, branch: entry.branch, path: entry.path, origin: entry.origin, baseBranch: entry.baseBranch ?? null });
// ターンの始まりの撮影を待つ上限と、終わりの撮影・要約を待つ上限（超えたらその回の撮影・要約は諦める）
const GIT_BEGIN_WAIT_MS = 6_000;
// AGENT_HOST_GIT_SNAPSHOTS=off でターンの撮影（隠し ref）を止める。テストが開発中のリポジトリの .git に ref を残さないため（tests/lib/server.mjs）
const GIT_SNAPSHOTS = process.env.AGENT_HOST_GIT_SNAPSHOTS !== 'off';
const GIT_END_WAIT_MS = 6_000;
process.on('exit', () => shellRuns.stopAll());
process.on('exit', () => removeControlFile({ dataDir: store.dataDir }));
// 端末の Ctrl-C・kill でも 'exit' を通し、control.json を消す
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => process.exit(0));
const completionNotices = createCompletionNotices({
  // 裏の作業は委譲の完了と同じく awaitedBackground で見る。開きっぱなしの端末（開発サーバーなど）で通知が出なくならないように
  busy: sessionId => sessionBusy(sessionId) || awaitedBackground(sessionId) || hasPendingChild(agentTasks?.list(sessionId) ?? []),
  send: event => sendTo({ kind: P.EVENT, event }),
  // 落ち着いた時点で、画面が居なくてもスマホへ 1 回（委譲の子の完了は endTurn が渡さない。依頼元の完了に含む）
  ready: ({ sessionId, outcome, completedAt, startedAt }) => {
    store.get(sessionId).then(async meta => {
      if (meta?.delegation) return;
      pushNotifier.finished({ sessionId, outcome, completedAt, startedAt, title: await conversationTitleOf(sessionId) });
    }).catch(() => {});
  },
});

/** 保存した既定を全画面に通知する。セッション閲覧では既定を書き換えない。 */
async function savePref(key, value, backendId) {
  const prefs = await store.setPref(key, value, backendId);   // ops-allow-setpref: prefs.json への書き込みの出口（設定の一覧 core/ops/settings.mjs と、既定の記憶だけがここを通る）
  if (key === 'limitResume') { limitResumeSettings = normalizeLimitResume(prefs.limitResume); resumeQueue.update(); }
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
  if (!LIST_NEUTRAL_EVENTS.has(event.type)) invalidateSessionLists();
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
async function applyStatus(backend, sessionId, status, why, actor) {
  const reason = reasonOf(why);
  const who = changeBy(actor);
  // ネイティブに持てるなら**そこが正本**。持てなくても sidecar には必ず残る
  if (backend.capabilities?.tag && backend.setTag) await backend.setTag(sessionId, status);
  await store.recordChange(sessionId, { ...who, field: "status", to: status, ...reason, backend });
  emitGlobal({ type: "status", sessionId, status, by: who.by, ...reason });
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
    if (event?.type) agentTasks?.observe(turn.info.sessionId, event);
    // git でしたこと（PR の作成など）をターンの終わりの要約に使う
    turn.gitCalls?.track(event);
    // Internal activity and command observations do not add conversation UI events.
    if (event?.type === 'task.activity' || event?.type === 'task.command') return;
    if (event?.type === 'usage') turn.usage = { ...turn.usage, ...event };
    if (event?.type === 'contextWindow' && Number.isFinite(event.usedTokens) && Number.isFinite(event.windowTokens)) {
      turn.contextWindow = { usedTokens: event.usedTokens, windowTokens: event.windowTokens };
    }
    if (event?.type === 'compaction') {
      const phase = event.phase;
      const current = turn.compaction;
      const wasComplete = current?.phase === 'complete';
      if (phase === 'start' && current?.phase === 'start') return;
      if (phase === 'summary' && !current) return;
      const entry = phase === 'start' || !current
        ? { id: crypto.randomUUID(), at: Date.now(), trigger: turn.compactTrigger ?? event.trigger ?? 'auto' }
        : current;
      if (phase !== 'summary') entry.phase = phase;
      if (phase === 'complete' && !wasComplete) {
        const kept = turn.contextRecord?.delivered?.entries;
        if (kept) for (const key of Object.keys(kept)) delete kept[key];
      }
      for (const key of ['nativeId', 'turnId', 'beforeTokens', 'afterTokens', 'summary', 'reason'])
        if (event[key] !== undefined && event[key] !== null) entry[key] = event[key];
      turn.compaction = entry;
      event = { type: 'compaction', ...entry };
      if (phase !== 'start' && turn.info.sessionId) {
        const sessionId = turn.info.sessionId;
        turn.compactionWrite = turn.compactionWrite.then(async () => {
          const previous = (await store.get(sessionId)).compactions ?? [];
          const index = previous.findIndex(x => x.id === entry.id);
          const next = [...previous];
          if (index >= 0) next[index] = { ...entry }; else next.push({ ...entry });
          await store.setSessionData(sessionId, 'compactions', next);
          if (entry.phase === 'complete' && entry.trigger !== 'manual') await store.setSessionData(sessionId, 'compacted', true);
        }).catch(err => console.error('  圧縮の記録に失敗:', String(err?.message ?? err)));
      }
    }
    // hooks の発火（Claude の hook_started / hook_response）。画面へは流さず、ターンに集めて終わりに会話へ残す（右パネルの「発火の記録」）
    if (event?.type === 'hookRun') {
      turn.hookRuns ??= [];
      const { phase, hookId, name, event: hookEvent, outcome, exitCode, pleiad, id, source, ms } = event;
      // Hooks を Pleiad がそろえる会話で、止めたはずのネイティブの定義が走った（Claude の hook_started は設定ファイル・プラグインの hooks の分だけ届く。
      // Codex は source が user・project）。止められなかったことを会話の記録に残す（推定で止まったことにしない）
      const hooksRecord = turn.contextRecord?.hooks;
      // Claude の通知には出どころが無い（hook_name は「イベント:matcher」）。止めたはずの定義と同じイベント・matcher のものだけ漏れとし、
      // ほかは出どころの分からないネイティブの発火（管理者の hooks は止めない契約なので、それを漏れと言わない）
      const { leak, unknownNative } = classifyNativeRun({ record: hooksRecord, backend: turn.backend.id, pleiad, name, event: hookEvent, leak: event.leak });
      if (leak && phase === 'started' && hooksRecord.leaks.length < HOOK_LEAKS_MAX) hooksRecord.leaks.push({ name, event: hookEvent, ...(source ? { source } : {}), at: new Date().toISOString() });
      if (unknownNative && phase === 'started' && (hooksRecord.unknownNative ??= []).length < HOOK_LEAKS_MAX) hooksRecord.unknownNative.push({ name, event: hookEvent, at: new Date().toISOString() });
      // 多いときは新しいほうを残す（ターンの最後の Stop などが記録から落ちないように）
      turn.hookRuns.push({ phase, hookId, name, event: hookEvent, ...(outcome ? { outcome } : {}), ...(Number.isInteger(exitCode) ? { exitCode } : {}),
        ...(pleiad ? { pleiad: true, ...(id ? { id } : {}) } : {}), ...(source ? { source } : {}), ...(leak ? { leak: true } : {}), ...(unknownNative ? { unknownNative: true } : {}),
        ...(Number.isInteger(ms) ? { ms } : {}), at: Date.now() });
      trimHookRuns(turn.hookRuns);
      return;
    }
    // 走っているターンへ渡した完了通知（liveNotices）は人間の発言ではない。渡ったら通知の一行にし、捨てられたら送り直す
    if ((event?.type === "userMessage.delivered" || event?.type === "userMessage.dropped") && liveNotices.has(event.messageId)) {
      const notice = liveNotices.get(event.messageId);
      liveNotices.delete(event.messageId);
      if (event.type === "userMessage.delivered") emit({ type: "taskNotice", text: notice.prompt });
      else if (notice.redeliver) notice.redeliver();
      else agentTasks?.renotify(notice.items).catch(() => {});
      return;
    }
    // 子のターンへ途中送信で渡した追加指示（ply_task_send。liveInstructions）の合図。指示の状態を決めてから、画面にも流す
    if ((event?.type === "userMessage.delivered" || event?.type === "userMessage.dropped") && liveInstructions.has(event.messageId)) {
      const sent = liveInstructions.get(event.messageId);
      liveInstructions.delete(event.messageId);
      agentTasks?.steered(sent.taskId, sent.instructionId, event.type === "userMessage.delivered" ? "delivered" : "dropped").catch(() => {});
    }
    // 受理済みの途中送信が読まれずに捨てられた（userMessage.dropped）。送信待ちへ戻す
    if (event?.type === "userMessage.dropped" && turn.info.sessionId && event.messageId) {
      outbox.returned(turn.info.sessionId, event.messageId).catch(() => {});
    }
    if (event?.type === "turnResult") {
      if (turn.compactTrigger) event = { ...event, compact: true };
      if (turn.stream.initialMessageId) event = { ...event, messageId: turn.stream.initialMessageId };
      turn.outcome = event.outcome;
      if (event.outcome === 'limited') {
        turn.limit = { resetsAt: Number.isFinite(event.resetsAt) ? event.resetsAt : null,
          window: event.window ?? null, account: turn.info.account ?? null, backend: turn.backend.id };
        event = { ...event, ...turn.limit };
      }
      // 中断で終わったら理由を添える（画面は会話の末尾の「中断しました」の文言を理由で選ぶ）
      if (event.outcome === "aborted") event = { ...event, reason: turn.abortReason ?? "user" };
      // バックエンドが失敗を知らせたら、server の catch では重ねて出さない（同じ失敗が 2 回並んでいた）
      if (event.outcome === "error" || event.outcome === 'limited') turn.errorShown = true;
      const execution = taskExecutions.get(turn.info.sessionId);
      if (execution) { execution.outcome = event.outcome; execution.error = event.error ?? null; }
    }
    // 委譲の子で、バックエンドが実行前に拒否されたコマンドを知らせた（Codex。tool.result の rejection）。依頼元へ返す結果に集める
    if (event?.type === "tool.result" && event.rejection && typeof event.rejection === "object") {
      taskExecutions.get(turn.info.sessionId)?.rejections.push(event.rejection);
    }
    // main の状態と裏で動いているもの（docs/multi-backend.md §2.2）。一覧と稼働表示は running の
    // ターン行から読むので、変わったらすぐ配る（4 秒ごとの定期便を待たない）
    if (event?.type === "phase" || event?.type === "background") {
      if (event.type === "phase") turn.info.phase = event.state === "waiting" ? "waiting" : "active";
      else turn.info.background = Array.isArray(event.tasks) ? event.tasks : [];
      if (event.type === "phase") watchChildBackground(turn);
      broadcastRunning();
      // 裏だけを待つ間は、次のターンの設定の予約があっても途中送信できる。待っている送信をすぐ流す
      if (event.type === "phase" && turn.info.phase === "waiting" && turn.info.sessionId) outbox.kick(turn.info.sessionId).catch(() => {});
    }
    // 新規セッションは走り出してから id が決まる。仮キーを本物へ差し替える。
    // sessionId が null の session は「まだ決まっていない」ので差し替えない
    // （差し替えると sidecar に "null" キーの行が生える）。
    if (event?.type === "session" && event.sessionId && !turn.info.sessionId) {
      turn.info.sessionId = event.sessionId;
      if (turn.browserRelayId && turn.browserRelayId !== event.sessionId) { agentBrowser?.rebind(turn.browserRelayId, event.sessionId); turn.browserRelayId = event.sessionId; }
      turn.compactionRevision = compactionScheduler.revision(event.sessionId);
      for (const read of liveReads) if (read.sessionId === event.sessionId) read.turn = turn;
      runtime.turns.delete(turn.key);
      const connection = agentConnections.get(turn.key);
      if (connection) { agentConnections.delete(turn.key); connection.key = event.sessionId; connection.sessionId = event.sessionId; agentConnections.set(event.sessionId, connection); }
      turn.key = event.sessionId;
      runtime.turns.set(turn.key, turn);
      // 新しい会話は id が決まったここで、始まりの撮影の ref を書く（ADR 0085）
      turn.gitSetup?.then(() => turn.git && gitActivity.attach(turn.git, event.sessionId)).catch(() => {});
      // 実際に使った承認モードとモデル、どのエージェントのものかをセッションに残す。
      // 既定から引き継いだ場合、書かないと一覧の表示と実際の挙動がずれる。
      // backend を書いておかないと、次に開いたときに誰に聞けばよいか分からない。
      const { sessionId, mode, model, cwd, status, attachments } = turn.info;
      turn.setup = Promise.all([
        // turnStartedAt: 走っている印。終わり（endTurn）で片付ける。起動時に残っていれば落ちたターン（store.recoverInterruptedTurns）
        store.setMeta(sessionId, {
          backend: turn.backend.id, cwd, createdAt: turn.info.startedAt, lastModified: Date.now(),
          turnStartedAt: turn.startedAtMs, interrupted: null,
        }),
        // ターンで使っていた内蔵ブラウザーのプロフィールを会話に残す（ADR 0078）
        turn.browserProfile ? browserProfiles.set(sessionId, turn.browserProfile, cwd).catch(() => {}) : null,
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
      if (turn.worktreeId) worktreeHost.worktrees.update(turn.worktreeId, { sessionId: event.sessionId }).catch(() => {});
      turn.setup.then(() => emitWorktreeNotice(turn, emit, event.sessionId)).catch(() => {});
    }

    // サブエージェントの transcript には依頼のユーザー発言が入らない（assistant 発言のみ）。
    // 見出しに使えるよう、親側の委譲ツールの説明をここで拾っておく。
    // ツール名はエージェントが宣言する（v1 は Task / Agent を直書きしていた）。
    // どのサブエージェントの分かは tool_use id で引く（runningWork）
    if (event?.type === "tool.start" && event.id && turn.backend.listSubagents
        && (turn.backend.subagentTools ?? []).includes(event.name)) {
      // 依頼文の全体とモデルも覚える。依頼文は会話を読む画面の最初の発言に、モデルは記録にモデルが無い子の一覧の表示に使う
      turn.taskHints.set(event.id, {
        label: String(event.input?.description ?? event.input?.prompt ?? "").slice(0, 120),
        prompt: typeof event.input?.prompt === "string" ? event.input.prompt.slice(0, 20_000) : null,
        model: typeof event.input?.model === "string" && event.input.model ? event.input.model : null,
      });
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
 * 送信と一緒に渡された添付を会話に載せる。
 * 人間の添付も AI の提示と同じ present で並ぶ（設計メモ §7）。記録は emit（makeEmit）が present を見て行う。
 * - 置き場（uploads/）のファイル（attachFile が置いた、この端末から送ったもの）: 中身も載せる。origin は device
 * - それ以外（ホストのファイルをパスのまま渡したもの。origin は host）: 読み取りの検査は /local-file と同じ（ADR 0050。UNC・データ置き場は
 *   拒否）。クライアントの言うことを鵜呑みにしてファイルを読まないため、中身は載せず、パス・出どころ・大きさだけを載せる。
 *   送信後の発言が、本文の印（[添付] パス）の位置にそのパスを札として出せる。エージェントは自分の道具でパスから読む
 */
async function presentAttachments(sessionId, attachments, emit) {
  for (const a of attachments) {
    const given = String(a?.path ?? "");
    const file = path.resolve(given);
    const mime = String(a.mime ?? "");
    // Windows はドライブ・フォルダーの大小を区別しない（区別すると、置き場の中のファイルがホストのファイルの枝に入る）
    const inUploads = process.platform === "win32" ? file.toLowerCase().startsWith((UPLOAD_DIR + path.sep).toLowerCase()) : file.startsWith(UPLOAD_DIR + path.sep);
    if (!inUploads) {
      let stat;
      try { ({ stat } = await inspectFile(file, fileAccess)); } catch { continue; }
      if (!stat.isFile()) continue;
      const name = path.basename(file);
      const isImage = IMAGE_MIME.test(mime) || /\.(?:png|jpe?g|gif|webp|avif)$/i.test(name);
      // path は本文の印と突き合わせる（web/timeline.mjs）ので、クライアントが渡した文字列のまま（絶対パスに直さない・実パスに直さない）。
      // 読めるかの検査（inspectFile）だけが、解決した後のパスで行う
      emit({ type: "present", sessionId, kind: isImage ? "image" : "file", caption: t('ui:saved.caption.attachment', { name, lng: 'ja' }), captionKey: 'attachment',
        captionParams: { name }, path: given, by: "human", origin: "host", size: stat.size, truncated: true });
      continue;
    }
    const isImage = IMAGE_MIME.test(mime);
    // 丸ごと読むのは会話に画像として載せる大きさまで。文字のファイルは先頭だけ読む（添付は 1 件 100MB まである）
    let size, buf;
    try { size = (await fs.stat(file)).size; } catch { continue; }
    const whole = isImage && size <= PRESENT_IMAGE_INLINE;
    try { buf = whole ? await fs.readFile(file) : isImage ? null : await readHead(file, PRESENT_TEXT_CHARS * 4); } catch { continue; }
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
      origin: "device",
      size,
      ...(isImage ? (buf ? { dataUri: `data:${mime};base64,${buf.toString("base64")}` } : { truncated: true })
        : { content: buf.toString("utf8").slice(0, PRESENT_TEXT_CHARS) }),
    });
  }
}

/** ファイルの先頭 bytes バイトだけを読む */
async function readHead(file, bytes) {
  const h = await fs.open(file, "r");
  try {
    const buf = Buffer.alloc(bytes);
    const { bytesRead } = await h.read(buf, 0, bytes, 0);
    return buf.subarray(0, bytesRead);
  } finally { await h.close(); }
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
// ---- 設定を書く・会話を分ける・状態のグループを作る。画面の WS コマンドと操作の一覧（core/ops/）が同じ関数を通る（ADR 0007・0081）

/**
 * 設定が変わったことを全画面へ。どの口から変えても開いている画面が更新される。prefs・autoCompactionSettings・delegationRoutingChanged など
 * 既存の配信に加えて、配信の無かった設定（context の既定）のために全設定で出す。by・via・bySession は変えた主体（ADR 0082）。
 */
function settingsChanged(keys, actor = { by: 'human' }) {
  const who = changeBy(actor);
  emitGlobal({ type: 'settingsChanged', sessionId: null, keys, by: who.by, ...(who.via ? { via: who.via } : {}), ...(who.bySession ? { bySession: who.bySession } : {}) });
}

/** 自動圧縮の設定を保存して配る。予約が走っていれば新しい設定に合わせて取り消す。保存に失敗したら元に戻す */
async function applyAutoCompaction(settings) {
  const previousSettings = compactionSettings;
  // A reservation already firing may be preparing its backend. Settings take effect before
  // the disk write, and ineligible in-flight reservations are invalidated before invocation.
  compactionScheduler.cancelFiring(entry => {
    const row = settings[entry.backendId === 'fake' ? 'claude' : entry.backendId];
    return !settings.enabled || !row?.enabled || entry.usedTokens < settings.minTokens;
  });
  compactionSettings = settings;
  try { await store.setPref('autoCompaction', settings); }   // ops-allow-setpref: 配信が prefs ではなく autoCompactionSettings の設定
  catch (err) { compactionSettings = previousSettings; throw err; }
  for (const entry of compactionScheduler.entries()) {
    const backend = await resolveBackendForSession(entry.sessionId);
    const row = settings[backend?.id === 'fake' ? 'claude' : backend?.id];
    if (!settings.enabled || !row?.enabled
        || (await store.get(entry.sessionId)).contextWindow?.usedTokens < settings.minTokens)
      compactionScheduler.cancel(entry.sessionId);
  }
  emitGlobal({ type: 'autoCompactionSettings', sessionId: null, settings });
  return settings;
}

/** 委譲先の自動振り分けの設定。patch は prefs.json の delegationRouting に重ねる項目（null の項目は既定に戻す）。全体を検証してから保存する */
async function applyRoutingSettings(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error(t('routing.settings.notObject', { key: 'settings' }));
  const raw = { ...((await store.getPrefs()).delegationRouting ?? {}) };
  for (const [key, value] of Object.entries(patch)) { if (value === null) delete raw[key]; else raw[key] = structuredClone(value); }
  for (const key of RETIRED_KEYS) delete raw[key];
  let settings;
  try { settings = normalizeSettings(raw, { strict: true }); } catch (e) { throw routingSettingsError(e); }
  const previous = routingSettingsCache;
  const known = routingUsage.snapshot();
  const oldCandidates = new Set(TIERS.flatMap(tier => previous.tiers[tier] ?? []));
  const missingCandidate = TIERS.flatMap(tier => settings.tiers[tier] ?? []).some(candidate => {
    if (oldCandidates.has(candidate)) return false;
    const at = candidate.indexOf(':');
    return !Object.hasOwn(known[candidate.slice(0, at)]?.models ?? {}, candidate.slice(at + 1));
  });
  await savePref('delegationRouting', Object.keys(raw).length ? raw : null);
  routingSettingsCache = settings;
  if (!settings.enabled) routingUsage.stop();
  else if (ROUTING_USAGE_AUTO) {
    routingUsage.start();
    if (previous.enabled && missingCandidate) routingUsage.refresh().catch(() => {});
  }
  emitGlobal({ type: 'delegationRoutingChanged', change: 'settings', sessionId: null });
  return settings;
}

/** Pleiad の指示の項目を保存する。前の版の委譲の指示のスイッチ（addedContext）は plyInstructions に写したので消す（残すと古い版に戻したときだけ効く） */
async function applyPlyInstructions(next) {
  await savePref('plyInstructions', { items: next });
  await savePref('addedContext', null);
  plyInstructionsCache = next;
  return next;
}

/** 内蔵ブラウザーのプロフィール（ADR 0078）。一覧・既定・新しい会話の規則。消えたプロフィールの既定と「このサイトは常に」は片付ける。値の検査は呼び出し側 */
async function applyBrowserProfilePref(key, value) {
  let prefs = await savePref(key, value);
  if (key === 'browserProfiles') {
    const ids = browserProfileIds(prefs);
    if (prefs.browserDefaultProfile && !ids.includes(prefs.browserDefaultProfile)) prefs = await savePref('browserDefaultProfile', null);
    const sites = prefs.agentSitePermissions ?? [];
    const kept = sites.filter(row => !row.profile || ids.includes(row.profile));
    if (kept.length !== sites.length) prefs = await savePref('agentSitePermissions', kept);
  }
  agentBrowser?.prefs(prefs);
  return prefs;
}

/** 内蔵ブラウザーの確認と「このサイトは常に」。保存して、走っているブラウザーの方針にも伝える。値の検査は呼び出し側 */
async function applyBrowserPref(key, value) {
  const prefs = await savePref(key, value);
  agentBrowser?.prefs(prefs);
  agentBrowser?.loadPolicy(prefs);
  return prefs;
}

/** 会話を分ける。fork コマンドと sessions.fork が同じ経路を通る。actor は変更の記録の主体（無ければ人間） */
async function forkConversation({ sessionId, upToMessageId, beforeMessageId, title, reason, backend: given }, actor) {
  const running = runtime.turns.get(sessionId);
  if (!sessionId || forking.has(sessionId) || switching.has(sessionId) && !running) throw new Error(t('session.preparingFork'));
  forking.add(sessionId);
  try {
    await settingsWrites.get(sessionId);
    const backend = refuseRetired(await pickBackend(sessionId, given));
    if (!backend.fork) throw new Error(t('session.cannotFork'));
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
    }
    await store.recordChange(child, { ...changeBy(actor), field: "parent", to: parent, reason: reason ?? "fork", backend });
    // 枝は親と同じ状態で始まる。そうでないと生まれた瞬間に親のグループから外れる（§4.1）
    const inherited = (await sessionList().catch(() => [])).find((r) => r.id === sessionId)?.status ?? null;
    if (inherited) await applyStatus(backend, child, inherited, "fork").catch(() => {});
    emitGlobal({ type: "fork", sessionId: child, parent,
      ...(actor?.by === 'agent' ? { by: 'ai', reason: reason ?? null } : {}) });
    return { sessionId: child, parent };
  } finally {
    forking.delete(sessionId);
    completionNotices.changed(sessionId);
    outbox.kick(sessionId).catch(() => {});
  }
}

/**
 * 同じ会話の中で、ある発言（beforeMessageId。自分の発言）の手前まで巻き戻す（sendMessage の rewind。ADR 0091）。
 * 会話の id は変わらない。分岐（forkConversation）と同じ排他（forking）で、実行中のターン・分岐・別の送り直しと重ならない。
 * 実行中のターンがあるときは stopRunning: true のときだけ止める（止まり終えてから巻き戻す）。
 * 巻き戻しは、バックエンドの履歴の切り方（conversations.mjs の rewind）のほかに、切り口より後のものを整える:
 *   送信待ち（送れていないものは全部、切り口より後に送られたもの）・切り口より後に生まれた委譲の子・裏の作業・
 *   渡し済みの控え（contextSession.delivered。巻き戻した先のモデルは、捨てたターンで渡された本文を持っていない）・
 *   中断の印と止めたもの（中断した位置が消える）・圧縮の記録のうち切り口より後
 * 提示（添付・可視化）は conversations.mjs の rewind が切る。下書きには触らない
 */
async function rewindConversation({ sessionId, beforeMessageId, stopRunning = false }) {
  if (!sessionId) throw new Error(t('session.required'));
  const running = runtime.turns.get(sessionId);
  if (forking.has(sessionId) || switching.has(sessionId) && !running) throw new Error(t('session.preparingRewind'));
  forking.add(sessionId);
  try {
    compactionScheduler.cancel(sessionId);
    await settingsWrites.get(sessionId);
    const backend = refuseRetired(await pickBackend(sessionId));
    if (!backend.rewind) throw new Error(t('session.cannotRewind'));
    // 委譲された会話（子）は、同じ会話では送り直せない。走らせた委譲タスクの結果・状態が、巻き戻した履歴と食い違う（画面は分岐して送るだけを出す）
    if ((await store.get(sessionId)).delegation) throw new Error(t('rewind.delegated'));
    // 検証は、走っているターンを止める・委譲の子を取り消すより前に済ませる（止めてから断られると戻せない）。時刻は委譲の子を取り消す境目に使う
    const { since } = await backend.rewindPlan(sessionId, { beforeMessageId });
    if (running) {
      if (!stopRunning) throw Object.assign(new Error(t('rewind.running')), { code: 'SESSION_RUNNING' });
      await stopTurnForRewind(sessionId, running);
    }
    const result = await backend.rewind(sessionId, { beforeMessageId });
    // 巻き戻せたあとで、切り口より後に生まれた委譲の子を取り消す（完了通知も届けない）。子の会話そのものは一覧に独立の会話として残る
    if (Number.isFinite(since)) await agentTasks.cancelOwner(sessionId, { since });
    // ターンの外に残っている裏の作業（Codex の端末など）も止める
    const outside = runtime.background.get(sessionId);
    for (const x of outside?.tasks ?? []) await getBackend(outside.backend)?.stopBackground?.(sessionId, x.id).catch(() => {});
    // 送信待ちは、どれも切り口より後に送ったもの（送り終えたものは履歴にいる）。巻き戻した先では意味を失うので取り消す
    for (const m of await outbox.list(sessionId)) {
      if (!['sent', 'cancelled'].includes(m.status)) await outbox.action(sessionId, m.id, 'cancel').catch(() => {});
    }
    const entry = await store.get(sessionId);
    if (entry.contextSession?.delivered) await store.setSessionData(sessionId, 'contextSession', { ...entry.contextSession, delivered: null });
    // 中断した位置・止めたものは、捨てた範囲の出来事
    await store.setMeta(sessionId, { interrupted: null });
    await store.clearStops(sessionId);
    // 切り口より後の記録（圧縮・渡さなかった `!` の行・hooks の発火）は捨てる。渡していない `!` の結果（shellPending）は次の発言と一緒に渡るので残す
    if (Number.isFinite(since)) {
      const time = at => (typeof at === 'number' ? at : Date.parse(at ?? ''));
      for (const [field, list, at] of [['compactions', entry.compactions, c => Number(c.at)], ['shellKept', entry.shellKept, e => time(e.at)], ['hookRuns', entry.hookRuns, h => Number(h.at)]]) {
        if (list?.some(x => at(x) >= since)) await store.setSessionData(sessionId, field, list.filter(x => !(at(x) >= since)));
      }
    }
    // 文脈量の表示は、巻き戻す前の履歴の量。次のターンの値で上書きされるまで古いままにしない
    await store.setSessionData(sessionId, 'contextWindow', null);
    // 捨てたターンの「未読の完了」の点は残さない
    if (Number.isFinite(entry.completedAt)) await store.markRead([[sessionId, entry.completedAt]]).catch(() => []);
    emitGlobal({ type: 'rewind', sessionId, renumbered: Boolean(result.renumbered), removed: result.removed });
    return result;
  } finally {
    forking.delete(sessionId);
    completionNotices.changed(sessionId);
    outbox.kick(sessionId).catch(() => {});
  }
}

/** 走っているターンを止めて、止まり終える（runtime.turns から消える）のを待つ。巻き戻しのために止めたので、中断の記録は残さない（上の rewindConversation が消す） */
async function stopTurnForRewind(sessionId, turn) {
  turn.abortReason ??= 'user';
  turn.ac.abort();
  settleAll('aborted', sessionId);
  if (!turn.info.stopping) {
    turn.info.stopping = true;
    makeEmit(turn)({ type: 'activity', state: 'stopping' });
    broadcastRunning();
  }
  // Claude の停止は最悪 stopAckMs + stopExitMs（claude.mjs）かかる
  const deadline = Date.now() + 20_000;
  while (runtime.turns.get(sessionId) === turn) {
    if (Date.now() > deadline) throw new Error(t('rewind.stopTimeout'));
    await waitFree(sessionId, 250);
  }
}

/** 状態グループのアイコン。人間が選んでも AI が渡しても同じ store に入る（設計メモ 2.2） */
async function setStatusIconOf(status, icon) {
  if (typeof status !== "string" || !status.trim()) throw new Error(t('statuses.statusRequired'));
  const saved = await store.setStatusIcon(status, icon);
  emitGlobal({ type: "statusIcon", sessionId: null, status, icon: saved });
  return { status, icon: saved };
}

/** 空のグループを作る。人が先に作った器は statuses.json にある限り存在する（セッション 0 件でも一覧に出る） */
async function createStatusGroup(status, actor) {
  const name = String(status ?? "").trim();
  if (!name) throw new Error(t('statuses.groupNameRequired'));
  await store.createStatus(name);
  emitGlobal({ type: "status", sessionId: null, status: name, by: changeBy(actor).by, bulk: 0, ...savedReason('createdGroup') });
  return { status: name };
}

// 操作の一覧（core/ops/）の handler へ渡す、サーバーの状態への口
const opsApp = {
  searchSessions: (input) => sessionSearch.search(input),
  status: async () => ({ version: APP_VERSION, protocolVersion: P.PROTOCOL_VERSION, startedAt: SERVER_STARTED_AT, locale: { ...locale }, running: (await runningWork()).count }),
  // 外の AI の MCP の設定に貼る pleiad mcp（app.cliSetup。core/cli-launcher.mjs）
  cliSetup: () => mcpSetup({ dataDir: store.dataDir }),
  // いま走っている作業の要約（app.running）。会話のターン・委譲の子・承認待ちの数
  running: async () => {
    const work = await runningWork();
    return {
      count: work.count,
      turns: await Promise.all(work.turns.map(async (turn) => ({ sessionId: turn.sessionId ?? null, backend: turn.backend ?? null,
        title: turn.sessionId ? (await store.get(turn.sessionId).catch(() => null))?.title ?? null : null }))),
      tasks: work.tasks.filter((task) => ['queued', 'running', 'cancelling'].includes(task.status))
        .map((task) => ({ taskId: task.taskId, status: task.status, parentSessionId: task.parentSessionId ?? null })),
      waiting: work.permissions.filter((p) => !p.relay).length,
    };
  },
};

/** 変更の主体 → 記録の by・via・bySession（ADR 0082）。人間は by: 'human'（これまでの記録と同じ）、操作の一覧の agent は by: 'agent' と、どの口から・どの会話の AI か */
const changeBy = (actor) => actor?.by === 'agent'
  ? { by: 'agent', ...(actor.via ? { via: actor.via } : {}), ...(actor.sessionId ? { bySession: actor.sessionId } : {}) }
  : { by: 'human' };

/** 題の変更。setTitle コマンドと sessions.setTitle が同じ経路を通る（人間も AI も同じ store・同じイベント。ADR 0007）。reason は reasonOf / clientReason の形 */
async function changeTitle(backend, sessionId, title, { actor, reason } = {}) {
  const who = changeBy(actor);
  if (backend.capabilities?.title && backend.setTitle) await backend.setTitle(sessionId, title);
  await store.recordChange(sessionId, { ...who, field: "title", to: title, ...reason, backend });
  emitGlobal({ type: "title", sessionId, title, by: who.by, ...reason });
}

/** 状態の変更。グループの根を動かすと、まとまりごと移る（中の会話も同じ状態に保つ、§4.1）。中の会話を動かしたときは、その 1 本だけが出る。移した会話の id を返す */
async function changeStatus(backend, sessionId, status, { actor, reason, alone } = {}) {
  const rows = alone ? [] : await sessionList().catch(() => []);
  const kin = rows.length && isGroupRoot(rows, sessionId) ? groupKin(rows, sessionId) : [];
  await applyStatus(backend, sessionId, status, reason, actor);
  for (const r of kin) {
    const b = getBackend(r.backend) ?? backend;
    await applyStatus(b, r.id, status, reason.reason === null ? savedReason('groupMove') : reason, actor).catch(() => {});
  }
  return kin.map((r) => r.id);
}

// 会話に関する操作（sessions.*）の本体。画面の口と同じ一覧・同じ読み方を使う
const opsSessions = {
  clientReason,
  list: () => sessionList({ limit: 500, track: false }),
  get: async (id) => {
    const rows = await sessionList({ limit: 500, track: false });
    let row = rows.find((r) => r.id === id);
    const side = await store.get(id).catch(() => ({}));
    if (!row) {
      // 一覧の上限より古い会話。バックエンドに直に聞く
      const backend = await resolveBackendForSession(id);
      if (!backend) return null;
      row = withWorktree(sessionRow(backend, await backend.getSession(id).catch(() => null), { ...side, id }));
    }
    return { row, children: rows.filter((r) => parentIdOf(r) === id).map((r) => r.id), history: side.history ?? [] };
  },
  read: async (id) => {
    const backend = await resolveBackendForSession(id);
    return backend ? (await history.loadTranscript(id, backend)).messages : null;
  },
  setTitle: async (id, title, { actor, reason, backend } = {}) => changeTitle(await pickBackend(id, backend), id, title, { actor, reason: reasonOf(reason) }),
  setStatus: async (id, status, { actor, reason, alone, backend } = {}) => changeStatus(await pickBackend(id, backend), id, status, { actor, reason: reasonOf(reason), alone }),
  fork: (input, { actor } = {}) => forkConversation(input, actor),
  setModel: (id, model, { actor, reason, backend } = {}) => changeModel(id, model, { actor, reason: reasonOf(reason), backend }),
};

/**
 * 会話のモデルの変更。setModel コマンドと sessions.setModel が同じ経路を通る（ADR 0007・0094）。走っているターンにも即時に伝える（できるエージェントだけ）。
 * 新しい会話の既定のモデル（prefs）として覚えるのは人間の変更だけ（AI が自分の会話で替えたモデルを、黙って全体の既定にしない）
 */
async function changeModel(sessionId, model, { actor, reason, backend: given } = {}) {
  const who = changeBy(actor);
  const backend = refuseRetired(await pickBackend(sessionId, given));
  // 互換の接続先の会話はモデル ID を形だけ見る（接続先の一覧＋自由入力）。公式の既定（prefs）には覚えない
  const endpointId = endpointCapable(backend) ? (await store.get(sessionId)).compatEndpoint ?? '' : '';
  if (!(await validModel(backend, model, undefined, endpointId))) throw new OpError('INVALID', t('settings.unknownModel', { value: model }));
  const from = (await store.get(sessionId)).model ?? "";
  await store.setModel(sessionId, model);
  if (!endpointId && who.by === 'human') await savePref("model", model, backend.id);
  await store.recordChange(sessionId, { ...who, field: "model", from, to: model, ...reason, backend });
  let live = false;
  const liveTurn = runtime.turns.get(sessionId);
  if (model && liveTurn?.control.handle && backend.setModelLive) {
    live = await backend.setModelLive(liveTurn.control.handle, model)
      .catch((err) => { console.error("  モデルの即時切り替えに失敗:", String(err?.message ?? err)); return false; });
  }
  emitGlobal({ type: "model", sessionId, model, by: who.by, live });
  return { live };
}

// 状態のグループ（statuses.*）の本体
const opsStatuses = { setIcon: setStatusIconOf, create: createStatusGroup };

/** 分けた作業場所を作れなかった理由 → 画面の言語の文（server:worktree.fail.<reason>）の OpError */
// i18n-dynamic: server:worktree.fail.
const worktreeFailure = (reason, error) => new OpError(reason === 'not-git' ? 'NOT_GIT' : 'WORKTREE_FAILED', t(`worktree.fail.${reason}`, { error: error ?? '' }));
const worktreeEntry = async (id) => {
  const entry = await worktreeHost.worktrees.get(String(id ?? ''));
  if (!entry) throw new OpError('WORKTREE_NOT_FOUND', t('worktree.notFound'));
  return entry;
};
// 分けた作業場所（worktrees.*。ADR 0089）の本体。画面の WS コマンドも AI もここを通る
const opsWorktrees = {
  split: async (args) => {
    const sessionId = typeof args?.sessionId === 'string' && args.sessionId ? args.sessionId : null;
    const cwd = await worktreeCwd(args);
    if (!cwd) throw worktreeFailure('not-git');
    const made = await worktreeHost.split({ cwd, sessionId });
    if (!made.ok) throw worktreeFailure(made.reason, made.error);
    return { worktree: made.entry, cwd: made.cwd };
  },
  // 変更なし・取り込み済みのときだけ消す（未取り込み・使っているものは残す）
  discard: async (id) => {
    const entry = await worktreeHost.worktrees.get(String(id ?? ''));
    if (!entry) return { action: 'skip' };
    return worktreeHost.worktrees.settle(entry.id);
  },
  keep: async (id, kept) => {
    const entry = await worktreeEntry(id);
    await worktreeHost.worktrees.keep(entry.id, kept);
    return { id: entry.id, kept };
  },
  archive: async (id) => {
    const entry = await worktreeEntry(id);
    const result = await worktreeHost.archive(entry.id);
    emitGlobal({ type: 'worktreesChanged', sessionId: null });
    return result;
  },
  restore: async (args) => {
    const cwd = await gitCwd(args);
    if (!cwd) throw worktreeFailure('not-git');
    const made = await worktreeHost.restore({ cwd, ref: String(args?.ref ?? '') });
    if (!made.ok) throw worktreeFailure(made.reason, made.error);
    emitGlobal({ type: 'worktreesChanged', sessionId: null });
    return { worktree: made.entry, cwd: made.cwd };
  },
  setSettings: async ({ always }) => {
    const next = await worktreeHost.worktrees.setSettings({ always });
    emitGlobal({ type: 'worktreeSettings', sessionId: null, ...next });
    return next;
  },
};

// 通知の設定（notify.*。ADR 0086）の本体。変えたら設定 › 通知の材料を全画面へ配る
const notifyChanged = async () => emitGlobal({ type: 'notifyStatus', status: await notifyStatus(), sessionId: null });
const opsNotify = {
  setPc: async (patch) => { const pc = await notifySettings.set(patch); await notifyChanged(); return pc; },
  setDevice: async (id, muted) => {
    if (!remote.deviceInfo(id)) throw new OpError('DEVICE_NOT_FOUND', t('notify.error.unknownDevice'));
    await remote.setNotifyMuted(id, muted === true);
    await notifyChanged();
    return { id, muted: muted === true };
  },
};

// Hooks の定義を読む（hooks.*）。失敗の文はファイルの読み方（hooks-config・ply-hooks）が持つ
const hookFailure = (e) => new OpError('HOOK_NOT_FOUND', String(e?.message ?? e));
const opsHooks = {
  read: (args) => hooksConfig.read(args).catch((e) => { throw hookFailure(e); }),
  readPly: (id) => plyHooks.readHook(id).catch((e) => { throw hookFailure(e); }),
};

// 互換の接続先のうち秘密を入力しない操作（compatEndpoints.*）。キーは返さない
const opsCompat = {
  get: (id) => compatEndpoints.get(String(id ?? '')),
  deleteNote: (e) => t('compat.deleteConfirm', { name: e?.name ?? e?.id ?? '' }),
  recheck: async (id) => {
    let result;
    try { result = await compatEndpoints.recheck(String(id ?? '')); }
    catch (e) { if (e instanceof CheckError) throw new OpError('ENDPOINT_NOT_FOUND', e.message); throw e; }
    emitGlobal({ type: 'compatEndpointsChanged', sessionId: null });
    return result;
  },
  remove: async (id) => {
    if (!(await compatEndpoints.has(String(id ?? '')))) throw new OpError('ENDPOINT_NOT_FOUND', t('compat.store.notRegistered'));
    await compatEndpoints.remove(String(id));
    emitGlobal({ type: 'compatEndpointsChanged', sessionId: null });
    return { id: String(id), deleted: true };
  },
};

// コンピューターの操作を止める（computer.stop。docs/computer-use.md「computerStop」）。止める側なので、リモートの端末からも AI からも受ける
const opsComputer = {
  stop: (sessionId) => {
    const result = computerLock.stopSession(sessionId, 'stop');
    if (result.stopped && result.owner) computerDriver?.stop(result.owner);
    return { stopped: result.stopped };
  },
};

/** 変更の記録に残す値（長いものは切る。秘密は設定に持たないので入らない） */
const clipValue = (value) => { const text = JSON.stringify(value) ?? 'null'; return text.length > 300 ? `${text.slice(0, 299)}…` : text; };

// 出している設定の変更の承認カード（requestId -> 取り下げ用の AbortController）。カードはメモリだけで、台帳は settingApprovals
const settingCards = new Map();

/**
 * 会話の承認カードで設定の変更を聞く（registry.invoke の approve。ADR 0088）。カードを出し、答えを待たずに { pending: true, requestId } を返す。
 * カードは期限なしで残り（ターンの終わり・中断・host の不在では取り下げない。detached）、人の答えで決着する。
 * 許可なら proceed()（受領証の照合と実行。値が変わっていれば同じ requestId で聞き直す）を呼び、結果（変えた・拒否・変えられなかった）を
 * その会話へ届ける（settingApprovals。委譲の完了通知と同じ届け方）。同じ会話・同じ設定で待っている古いカードは取り下げ、置き換えたことを届ける。
 */
async function askSettingChange({ op, change, receipt, reason, actor, requestId, proceed }) {
  const sessionId = actor?.sessionId;
  if (!sessionId) return { allow: false, code: 'NEEDS_UI' };
  const turn = runtime.turns.get(sessionId);
  const backend = turn?.backend ?? await resolveBackendForSession(sessionId).catch(() => null);
  const agent = { id: backend?.id ?? '', label: backend?.label ?? '' };
  const key = change.key ?? null;
  const id = requestId ?? `setting-${crypto.randomUUID()}`;
  for (const old of settingApprovals.pendingFor(sessionId, key, op)) if (old.requestId !== id) await withdrawSettingCard(old.requestId, 'superseded');
  await settingApprovals.add({ requestId: id, sessionId, key, op });
  const ac = new AbortController();
  settingCards.set(id, ac);
  askPermission({
    toolName: 'ply_control', input: {}, sessionId, kind: 'tool', canAlways: false, signal: ac.signal, detached: true,
    title: t('permission.settingChange', { agent: agent.label, key: key ?? op }),
    settingChange: { op, key: key ?? op, requestId: id, rows: change.rows ?? [], ...(change.note ? { note: change.note } : {}), loosens: Boolean(change.loosens), ...(reason ? { reason } : {}), receipt, agent },
  }).then(async (answer) => {
    if (settingCards.get(id) === ac) settingCards.delete(id);
    // 取り下げた（置き換え）なら、取り下げた側が結果を積む
    if (ac.signal.aborted) return;
    if (!answer?.allow) return finishSettingApproval(id, 'denied');
    let r;
    try { r = await proceed(); } catch (e) { r = { ok: false, error: String(e?.message ?? e) }; }
    // 許可のあとに値が変わっていたので、同じ requestId で聞き直した（新しいカードが出ている）
    if (r?.pending) return;
    await finishSettingApproval(id, r?.ok ? 'allowed' : 'failed', r?.ok ? {} : { error: r?.error ?? r?.code ?? '' });
  }).catch((e) => console.error('  設定の変更の承認に失敗:', String(e?.message ?? e)));
  return { pending: true, requestId: id };
}

/** 設定の変更の承認カードを取り下げ、その結果（outcome）を会話へ届ける */
async function withdrawSettingCard(requestId, outcome) {
  const ac = settingCards.get(requestId);
  settingCards.delete(requestId);
  ac?.abort();
  await finishSettingApproval(requestId, outcome);
}

/** 設定の変更の承認の決着。台帳から外して結果を会話へ届ける列に積み、画面へ決着を知らせる（どの端末のカードも 1 行に畳む） */
async function finishSettingApproval(requestId, outcome, extra = {}) {
  const entry = await settingApprovals.settle(requestId, outcome, extra);
  if (entry) emitGlobal({ type: 'settingApproval', sessionId: entry.sessionId, requestId, outcome });
}

/** 設定の変更の結果を、エージェントへ渡す文にする（会話の言語。1 件ずつの節を並べる）。via は、求めた子ではなく依頼元へ届けるときの子（routeSettingNotice） */
function settingNotice(lng, notices) {
  // i18n-dynamic: agent:ops.settingNotice.
  return notices.map((n) => agentT(lng, 'ops.settingNotice.head', { requestId: n.requestId, status: agentT(lng, `ops.settingNotice.status.${n.outcome}`) })
    + (n.via ? '\n' + agentT(lng, 'ops.settingNotice.fromChild', { taskId: n.via.taskId, title: n.via.title ?? '', state: n.via.status }) : '')
    + '\n' + agentT(lng, `ops.settingNotice.${n.outcome}`, { target: settingTarget(lng, n.op, n.key), error: n.error ?? '' })).join('\n\n');
}

/**
 * 承認の結果（設定の変更・ほかの guarded な操作。settingApprovals に積むものすべて）の届け先（ADR 0088「届け先」）。
 * 承認を求めた会話が委譲の子で、そのタスクが動いていない（完了・失敗・取り消しなど）なら、子の新しいターンは誰にも見られないので、
 * 依頼元の会話へ届ける（via に子のタスクを添える。依頼元は ply_task_send で子に続きを頼める）。
 * タスクが動いている（待機・実行中・子のターンが走っている）・依頼元の会話がもう無い・委譲の子でない会話は、求めた会話のまま（null）。
 */
async function routeSettingNotice(notice) {
  const sessionId = notice.sessionId;
  const delegation = (await store.get(sessionId)).delegation;
  if (!delegation?.taskId || !delegation.parentSessionId || delegation.parentSessionId === sessionId) return null;
  const task = agentTasks?.get(delegation.taskId);
  if (!task || task.sessionId !== sessionId || task.parentSessionId !== delegation.parentSessionId) return null;
  if (['queued', 'running', 'cancelling'].includes(task.status) || taskExecutions.has(sessionId)) return null;
  if (!await resolveBackendForSession(delegation.parentSessionId).catch(() => null)) return null;
  return { sessionId: delegation.parentSessionId, via: { taskId: task.taskId, title: task.title ?? null, status: task.status } };
}

/**
 * 操作の一覧（registry.invoke）へ渡す依存。locale は呼び出し元の言語（会話の言語・PC の言語）。
 * modeOf は束縛された会話の承認モード（引けなければ undefined。policy は弱い側に倒す）。audit は書く操作の記録（by: 'agent'・via・sessionId）
 */
function opsDeps(lng = currentLocale()) {
  return {
    locale: lng,
    app: opsApp,
    sessions: opsSessions,
    limitResume: {
      resume: resumeSession,
      messages: id => outbox.list(id),
      schedules: id => schedule.list().filter(row => !id || row.sessionId === id),
      cancel: async id => {
        const row = schedule.list().find(entry => entry.id === id);
        const cancelled = await schedule.cancel(id);
        if (cancelled && row?.kind === 'resume') {
          const meta = await store.get(row.sessionId);
          if (meta.interrupted?.reason === 'limit' && meta.interrupted.at === row.createdAt) {
            const interrupted = { ...meta.interrupted, autoResume: false, notifyAtReset: false };
            await store.setMeta(row.sessionId, { interrupted });
            limitStates.set(row.sessionId, interruptedOf(interrupted));
            emitGlobal({ type: 'limitResumeChanged', sessionId: row.sessionId, interrupted });
          }
        }
        return { cancelled };
      },
      queue: () => ({ ...resumeQueue.view(), schedules: schedule.list().filter(row => row.kind === 'resume'), settings: limitResumeSettings }),
      setQueue: async ({ action, sessionId, enabled }) => {
        if (action === 'stop') resumeQueue.stop();
        else if (action === 'continue') resumeQueue.continue();
        else if (action === 'release') {
          for (const [id, meta] of Object.entries(await store.getAll())) {
            const stopped = meta.interrupted;
            if (stopped?.reason !== 'limit' || !stopped.notifyAtReset || !Number.isFinite(stopped.resetsAt)
              || stopped.resetsAt > Date.now()) continue;
            await store.setMeta(id, { interrupted: { ...stopped, notifyAtReset: false } });
            resumeQueue.enqueue({ sessionId: id, interruptedAt: stopped.at, backend: meta.backend,
              account: stopped.account, window: stopped.window, sentAt: await limitSentAt(id, stopped.sentAt ?? stopped.at),
              priority: meta.delegation ? 1 : 0 });
          }
        }
        else if (action === 'first') {
          if (!resumeQueue.first(sessionId)) {
            const row = schedule.list().find(r => r.id === `resume:${sessionId}`);
            if (row) await schedule.put({ ...row, priority: Date.now() });
          }
        } else if (action === 'auto') {
          const meta = await store.get(sessionId);
          if (meta.interrupted?.reason !== 'limit') throw new Error(t('resume.notInterrupted'));
          const changed = { ...meta.interrupted, autoResume: Boolean(enabled), notifyAtReset: false };
          await store.setMeta(sessionId, { interrupted: changed });
          emitGlobal({ type: 'limitResumeChanged', sessionId, interrupted: changed });
          if (!enabled) { await schedule.cancel(`resume:${sessionId}`); resumeQueue.remove(sessionId); }
          else if (Number.isFinite(changed.resetsAt)) await schedule.put({ id: `resume:${sessionId}`, kind: 'resume',
            sessionId, at: Math.max(changed.resetsAt, Date.now()), createdAt: changed.at, by: 'limit', account: changed.account });
        }
        return { ...resumeQueue.view(), schedules: schedule.list().filter(row => row.kind === 'resume'), settings: limitResumeSettings };
      },
    },
    delegation: { list: (owner) => agentTasks?.list(owner) ?? [], get: (taskId, offset) => agentTasks?.get(taskId, offset) ?? null,
      call: (owner, name, args, locale) => callAgentOp(owner, name, args, { locale }) },
    browser: { call: (owner, name, args, locale) => callBrowserOp(owner, name, args, { locale }),
      setProfile: async (sessionId, profile) => {
        const meta = await store.get(sessionId);
        if (!await browserProfiles.set(sessionId, profile, meta.cwd)) throw new OpError('INVALID', t('settings.unknownPrefValue', { key: 'browserProfile', value: String(profile) }));
        const live = browserTurn(sessionId);
        if (live) live.browserProfile = profile;
        return { profile };
      } },
    prefs: () => store.getPrefs(),
    compactionSettings: () => compactionSettings,
    statuses: opsStatuses,
    worktrees: opsWorktrees,
    notify: opsNotify,
    hooks: opsHooks,
    compat: opsCompat,
    computer: opsComputer,
    // 設定を検査するために、サーバーの知っていること（エージェントの有無・モデルと承認モードの語彙・アカウント・Pleiad の指示）を借りる
    host: {
      hasBackend: (id) => Boolean(getBackend(id)),
      knows: async (key, value, backendId) => {
        const list = (backendId ? [getBackend(backendId)] : listBackends()).filter(Boolean);
        // 語彙はエージェントごとに違う。どれか 1 つでも知っていれば通す
        return (await Promise.all(list.map(async (b) => (key === 'mode' ? Boolean(b.modes()[value]) : value in (await b.models()))))).some(Boolean);
      },
      accountIds: async () => (await claudeAccounts.list()).accounts.map((a) => a.id),
      changePlyInstructions: (action) => changePlyInstructions(plyInstructionsCache, action, currentLocale()),
    },
    // 設定の保存。画面の setPref と同じ経路・同じ配信（prefs・autoCompactionSettings・delegationRoutingChanged）
    writes: {
      pref: (key, value, backendId) => savePref(key, value, backendId),
      browserPref: applyBrowserPref,
      browserProfiles: (value, key = 'browserProfiles') => applyBrowserProfilePref(key, value),
      compaction: applyAutoCompaction,
      routing: applyRoutingSettings,
      plyInstructions: applyPlyInstructions,
      context: (args) => contextSettings.set(args),
    },
    // 設定を変えたことを全画面へ配り、会話に束縛された呼び出しならその会話の変更の記録に残す（by: 'agent'・via・bySession）
    recordSetting: async ({ key, before, after, reason, actor }) => {
      settingsChanged([key], actor);
      console.log(`  設定を変更: ${key} by=${actor?.by ?? 'human'}${actor?.via ? ` via=${actor.via}` : ''}${actor?.sessionId ? ` session=${actor.sessionId}` : ''}`);
      if (actor?.sessionId) await store.recordChange(actor.sessionId, { ...changeBy(actor), field: 'setting', from: { key, value: clipValue(before) }, to: { key, value: clipValue(after) }, reason: reason ?? null }).catch(() => {});
    },
    approve: askSettingChange,
    routingSettings: () => routingSettingsCache,
    plyInstructions: () => plyInstructionsCache,
    contextDefaults: () => contextSettings.get(os.homedir(), { level: 'default' }),
    modeOf: async (sessionId) => {
      try {
        const live = runtime.turns.get(sessionId);
        if (live) return live.backend.modes()[live.info.mode];
        const backend = await resolveBackendForSession(sessionId);
        return backend ? backend.modes()[await resolveMode(sessionId, undefined, backend)] : undefined;
      } catch { return undefined; }
    },
    // 会話に束縛された呼び出しは、その会話の変更の記録に「どの口から何を呼んだか」を残す（束縛されない CLI は残す先が無い）。
    // 記録できなければ投げる（registry は記録に失敗したら操作を実行しない）
    audit: async ({ op, reason, actor }) => {
      if (!actor?.sessionId) return;
      await store.recordChange(actor.sessionId, { ...changeBy(actor), field: 'op', to: op, reason: reason ?? null });
    },
  };
}

async function runningWork() {
  const turns = [...runtime.turns.values()].map((t) => ({ kind: "turn", ...t.info }));

  const permissions = [...runtime.waiting].map(([id, w]) => ({
    id,
    kind: "permission",
    toolName: w.payload.toolName,
    sessionId: w.payload.sessionId ?? null,
    askedAt: w.askedAt ?? null,
    relay: Boolean(w.relay),   // 祖先の会話へ中継した複製。元のカードと同じ1件を指す
    ...(w.detached ? { detached: true } : {}),   // ターンを止めていない承認（設定の変更。ADR 0088）
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
      const origin = await subagentOrigin(t, sessionId, agentId);
      const hint = t.taskHints.get(origin);
      const state = await subagentState(t, sessionId, agentId);
      return {
        id: agentId,
        kind: "subagent",
        sessionId,
        backend: t.backend.id,
        // 生んだ委譲ツールの tool_use id。画面はこれで会話の中のツールカードと結ぶ
        origin: origin ?? null,
        // 答えたモデル。記録（Claude は assistant 行の message.model）を先に見て、無ければ依頼のときの指定。どちらも無ければ null（親と同じ）
        model: msgs.findLast((m) => m.model)?.model ?? hint?.model ?? null,
        messages: msgs.length,
        description: (hint?.label || said || "").slice(0, 120) || null,
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
    tasks: (live => agentTasks?.list().map(({ result, ...r }) => (r.worktree ? { ...r, worktree: { ...r.worktree, live: live.has(r.worktree.id) } } : r)) ?? [])(new Set(worktreeHost.worktrees.ids().map(x => x.id))),
    background,
    // 中継の複製は数えない。1つの承認が会話の数だけ増えて見える
    // サブエージェントは走っている子だけを数える。終わった子はターンが終わるまで一覧に残るので、
    // そのまま数えると更新のゲート（web の count > 0）が閉じたままになる。status が null の子
    // （状態を返せないバックエンド・まだ分からない子）は数える。数えないとゲートを緩めてしまう
    // 設定の変更の承認（detached）は期限なしで残るので数えない（数えると、答えるまで終了も更新もできない）
    count: turns.length + permissions.filter((p) => !p.relay && !p.detached).length
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
  completionNotices.changed();
  // 今ロックを持っている・待っている会話の状態を送り直す（接続し直した画面が「止める」と待ちの表示を出せるように）
  for (const state of computerLock.snapshot()) sendTo({ kind: P.EVENT, event: { type: 'computer.state', ...state } });

  // 待たせていた承認を聞き直す。取りこぼすとツールが無期限に止まる
  for (const [id, w] of runtime.waiting) {
    const firstNotice = !w.relay && !w.notified;
    if (sendTo({ kind: P.EVENT, event: { ...w.payload, id, ...(firstNotice ? { notifyReply: true } : {}) } }) && firstNotice) w.notified = true;
  }
  if (runtime.waiting.size) console.log(`  承認 ${runtime.waiting.size} 件を聞き直した`);
  if (hadGrace) console.log(HOST_GRACE_MS > 0 ? "  猶予を解除した（host が戻った）" : "  host が戻った");
}

function detach(ws) {
  if (!runtime.sockets.delete(ws)) return;
  if (runtime.sockets.size > 0) return;          // まだ別のタブが居る
  if (runtime.turns.size === 0 && blockingWaits().length === 0) return;

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

/** ターンを止めている承認待ち（設定の変更の承認 detached を除く。ADR 0088） */
const blockingWaits = () => [...runtime.waiting.values()].filter(w => !w.detached);

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
    // 設定の変更の承認（detached）はターンを止めていない。ターンが終わっても、中断しても残す（ADR 0088）
    if (w.detached) continue;
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
const askPermission = async ({ toolName, input, sessionId, toolUseID, title, signal, canAlways, kind, questions, locale, browserSite, computerApp, settingChange, detached = false }) => {
  const ancestors = sessionId ? await delegationAncestors(sessionId) : [];
  // 中継先の見出しは「どの会話の承認か」。委譲したときの info.title を使う
  const childTitle = ancestors.length ? (await store.get(sessionId)).title || t('permission.childConversation') : "";
  const conversationTitle = sessionId ? (await store.get(sessionId).catch(() => null))?.title ?? '' : '';
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
      conversationTitle,
      canAlways: Boolean(canAlways),
      ...(browserSite ? { browserSite } : {}),
      ...(computerApp ? { computerApp } : {}),
      ...(settingChange ? { settingChange } : {}),
      ...(questions ? { questions } : {}),
    };
    // 祖先ごとに別の id の複製を作り、どれも同じ settle を指す。
    // web は「id ごとに1つの会話」の前提のまま動き、消せば勝手に片付く
    const cards = [{ id: crypto.randomUUID(), payload, relay: false }, ...ancestors.map((ancestor) => ({
      id: crypto.randomUUID(),
      relay: true,
      // Tool-wide grants stay in the child. Browser and computer grants show the specific agent
      // and origin / app, so the same choices are available to ancestors.
      payload: { ...payload, sessionId: ancestor, canAlways: !!browserSite || !!computerApp, title: title ? t('permission.relayTitleWith', { child: childTitle, title }) : t('permission.relayTitle', { child: childTitle }) },
    }))];
    const onAbort = () => settle({ allow: false, messageKey: 'aborted' });
    const settle = (answer) => {
      // どれか1つで決着し、残りの複製も消す。1つも残っていなければ二重解決
      let found = false;
      for (const card of cards) if (runtime.waiting.delete(card.id)) found = true;
      if (!found) return;
      // スマホに出ている承認・質問の通知を消す（どの端末で答えても、ターンが終わっても）
      pushNotifier.approvalResolved({ id: cards[0].id, sessionId: payload.sessionId });
      signal?.removeEventListener?.("abort", onAbort);
      const { messageKey, messageParams, ...rest } = localize(answer);
      resolve(rest);
      permissionsChanged();
    };

    for (const card of cards) runtime.waiting.set(card.id, { settle, payload: card.payload, askedAt: new Date().toISOString(), relay: card.relay, notified: false, detached });
    signal?.addEventListener?.("abort", onAbort, { once: true });
    // 離れたスマホへ（画面が居るかによらない。委譲の子の承認・質問は子の会話の分だけ。中継の複製は送らない）
    // （会話名を読むあいだに決着していたら送らない。送ると取り消しが先に行ってしまい、通知が残る）
    if (payload.sessionId) {
      conversationTitleOf(payload.sessionId).then(title => {
        if (runtime.waiting.has(cards[0].id)) pushNotifier.approval({ id: cards[0].id, sessionId: payload.sessionId, kind: payload.kind, title });
      }).catch(() => {});
    }

    // 送れなければ黙って待つ。戻ってきたら attach() が聞き直す。
    // 既定では戻るまで待ち続け、AGENT_HOST_GRACE_MS を指定したときだけ猶予切れがターンごと中断する。
    let sent = false;
    for (const card of cards) {
      const firstNotice = !card.relay;
      if (sendTo({ kind: P.EVENT, event: { ...card.payload, id: card.id, ...(firstNotice ? { notifyReply: true } : {}) } })) {
        sent = true;
        if (firstNotice) runtime.waiting.get(card.id).notified = true;
      }
    }
    if (!sent) {
      if (graceExpired()) return giveUp();
      console.log(`  host が居ないので承認を保留: ${toolName}`);
    }
    permissionsChanged();
  });
};

agentBrowser?.configureAuthorization(createBrowserSiteApprovals({
  getPrefs: store.getPrefs,
  getAgent: async id => {
    const turn = runtime.turns.get(id) ?? [...runtime.turns.values()].find(turn => turn.browserRelayId === id);
    return turn ? { id: turn.backend.id, label: turn.backend.label, sessionId: turn.info.sessionId || turn.key, signal: turn.ac.signal, locale: turn.agentLocale } : null;
  },
  askPermission, translate: t,
  // 確認の文に添えるプロフィールの名前（画面の言語）
  profileLabel: id => browserProfiles.label(id, t('browserProfiles.main')),
  remember: async site => { const prefs = await store.rememberBrowserSite(site); emitGlobal({ type: 'prefs', sessionId: null, prefs, locale }); },
}));
// main が覚えていない会話の今のプロフィール。走っているターン（仮のキーを含む）はターンの値、ほかは会話のメタ
agentBrowser?.configureProfiles(async id => browserTurn(id)?.browserProfile ?? browserProfiles.resolve(id));
agentBrowser?.prefs(await store.getPrefs());
agentBrowser?.loadPolicy(await store.getPrefs());

// ---- コンピューターの操作（docs/computer-use.md、ADR 0070〜0075） ----------------------------
// driver は main（Electron）への口。Electron でない起動では null で、ply_computer は渡さない。
// AGENT_HOST_COMPUTER_DRIVER=fake は偽の driver（実画面には何もしない。テスト用）。AGENT_HOST_COMPUTER_LOG にその呼び出しを 1 行ずつ残す
const computerDriver = process.env.AGENT_HOST_COMPUTER_DRIVER === 'fake'
  ? fakeComputerDriver({ log: process.env.AGENT_HOST_COMPUTER_LOG ? entry => appendFileSync(process.env.AGENT_HOST_COMPUTER_LOG, JSON.stringify(entry) + '\n') : undefined })
  : parentPortComputer(process.parentPort);
const computerShots = createComputerShots({ dataDir: store.dataDir });
const computerLock = createComputerLock({
  waitMs: Number(process.env.AGENT_HOST_COMPUTER_LOCK_WAIT_MS) > 0 ? Number(process.env.AGENT_HOST_COMPUTER_LOCK_WAIT_MS) : undefined,
  onState: state => emitGlobal({ type: 'computer.state', ...state }),
  onArm: owner => computerDriver?.arm(owner),
  onStop: owner => computerDriver?.stop(owner),
});
const computerBridge = computerDriver ? createComputerBridge({
  driver: computerDriver, lock: computerLock, shots: computerShots, askPermission, translate: t,
  access: {
    getPrefs: store.getPrefs,
    sessionApps: async sessionId => (await store.get(sessionId)).computerApps ?? [],
    rememberSession: async (sessionId, ids) => store.setSessionData(sessionId, 'computerApps', [...new Set([...((await store.get(sessionId)).computerApps ?? []), ...ids])]),
    rememberAlways: async app => { const prefs = await store.rememberComputerApp(app); emitGlobal({ type: 'prefs', sessionId: null, prefs, locale }); },
    markIntroduced: async () => {
      const current = normalizeComputerUse((await store.getPrefs()).computerUse);
      if (!current.introduced) await savePref('computerUse', { ...current, introduced: true });
    },
  },
}) : null;
// 物理の Esc（main が離す・隠すまで済ませて知らせる）。ロックの持ち主と、貸し借りでつながるターン全部に止めた印を付ける
computerDriver?.onEscape(owner => computerLock.escape(owner));
// main か core が作り直された。持ち主を外し、待っている先頭に譲る
computerDriver?.onReady(() => computerLock.reset());

// 送信待ちの一覧が変わるたびに呼ぶもの（sessionId -> Set<fn(messages)>）。再開の受け付けを、送った項目が出ていくまで保つのに使う
const outboxWatchers = new Map();
// 会話の中断で取り消す委譲タスクの子の会話 -> 中断の理由。子のターンを実際に止める所（agentTasks の execute の stopChild）が
// 読んで付ける。止まらなかった子には付けない（abortSessions が取り消しの後に片付ける）
const taskStopReasons = new Map();
// 走っている依頼元のターンへ途中送信（control.steer）で渡した完了通知のうち、「渡った」合図（steerConfirms）を待っているもの。
// 通知の item id -> { owner, prompt, items: [{ taskId, revision }] }。渡れば画面へ通知の一行を出し、
// 読まれないままターンが死んだら（userMessage.dropped・ターンの終わり）空いたときの経路で送り直す（ADR 0057）
const liveNotices = new Map();
// 走っている子のターンへ途中送信（control.steer）で渡した追加指示（ply_task_send）のうち、「渡った」合図（steerConfirms）を待っているもの。
// 指示の item id（task-send-<指示 ID>） -> { sessionId: 子の会話, taskId, instructionId }。合図で指示の状態を決め、
// 合図が来ないままターンが終わったら待機へ戻して次のターンで送る（ADR 0065）
const liveInstructions = new Map();
const limitStates = new Map();
const outbox = createMessageQueue({
  store,
  active: id => {
    const limit = limitStates.get(id);
    if (limit)
      return { blocked: true, wait: { reason: 'limit', resetsAt: limit.resetsAt } };
    const turn = runtime.turns.get(id);
    if (!turn) {
      if (switching.has(id) || forking.has(id)) return { blocked: true, wait: { reason: 'turn' } };
      return null;
    }
    const steer = turn.control.steer;
    // 送るのは outbox の item そのもの（本文だけではない）。バックエンドは item.id を
    // 相手に預け、「渡った」合図（userMessage.delivered）でこの id を返してくる
    return { turn, blocked: turn.ac.signal.aborted || Boolean(turn.outcome), phase: turn.info.phase,
      steer: steer ? item => steer(item) : null };
  },
  start: runTurn,
  changed: (sessionId, messages) => {
    emitGlobal({ type: 'outbox', sessionId, messages });
    for (const watch of [...(outboxWatchers.get(sessionId) ?? [])]) watch(messages);
  },
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
// 前の起動で走っていたのに終わりが記録されていないターン（落ちた・強制終了）を、会話の中断（reason: restart）として残す
{
  const recovered = await store.recoverInterruptedTurns(Date.now()).catch(err => { console.error("  中断の記録に失敗:", String(err?.message ?? err)); return []; });
  if (recovered.length) console.log(`  前の起動で終わらなかったターン ${recovered.length} 件を中断として残した`);
}
// 親が走っている・裏の作業が残っている・送信待ちがあるときは完了通知を送らない（docs/agent-delegation.md「完了通知」）
const noticeBlocked = async owner => sessionBusy(owner) || awaitedBackground(owner) || (await outbox.list(owner)).some(m => !['sent', 'cancelled'].includes(m.status));

/**
 * 完了通知を今すぐ渡せる、依頼元の走っているターン（無ければ null）。docs/agent-delegation.md「完了通知」。
 * 人間の送信待ちを優先する決まりは変えない（outbox に未送があれば渡さない）。
 * 渡してよい条件は completion-notices.mjs の canSteerNotice
 */
async function noticeTarget(owner) {
  const turn = runtime.turns.get(owner);
  if (!turn) return null;
  const unsent = (await outbox.list(owner)).some(m => !['sent', 'cancelled'].includes(m.status));
  return canSteerNotice(turn, { unsent, nextSettings: (await store.get(owner)).nextSettings }) ? turn : null;
}

/** 完了通知の本文のハッシュを会話に残す。履歴が人間の発言と見分ける印（taskNotices）。すでにあれば書かない */
async function recordTaskNotice(sessionId, prompt) {
  const hashes = (await store.get(sessionId)).taskNotices ?? [];
  const digest = crypto.createHash('sha256').update(prompt).digest('hex');
  if (!hashes.includes(digest)) await store.setSessionData(sessionId, 'taskNotices', [...hashes, digest]);
}

/**
 * 完了通知の本文。1 件は今までの文。2 件以上は 1 つにまとめ、taskId ごとの節を完了の早い順に並べる。
 * 結果は 1 件 16000 字まで（まとめたときは全体で 16000 字ほどに分ける。切った分は ply_task_status の offset で読める）
 */
function completionNotice(lng, tasks) {
  const limit = tasks.length > 1 ? Math.max(2000, Math.floor(16000 / tasks.length)) : 16000;
  const parts = [...tasks].sort((a, b) => (a.updatedAt ?? 0) - (b.updatedAt ?? 0)).map(task => ({
    taskId: task.taskId, backend: task.backend, status: task.status, task: task.task,
    result: task.result.slice(0, limit),
    more: task.result.length > limit ? agentT(lng, 'delegation.noticeMore', { offset: limit }) : '',
    error: task.error ?? '',
    // 人が委譲先を変えてやり直したタスクは、依頼元のエージェントが作ったものではないので一行添える
    retry: task.routing?.retry?.of ? agentT(lng, 'delegation.noticeRetry', { of: task.routing.retry.of }) : '',
    rejections: rejectionNotice(lng, task.rejections) + stoppedBackgroundNotice(lng, task.stoppedBackground),
    git: workspaceNotice(lng, task) + gitNotice(lng, task.git),
  }));
  if (parts.length === 1) return agentT(lng, 'delegation.notice', parts[0]);
  return agentT(lng, 'delegation.noticeBatch', { count: parts.length, sections: parts.map(part => agentT(lng, 'delegation.noticeSection', part)).join('') });
}

/**
 * 完了通知を、走っているターンへ途中送信（control.steer）で渡す。人間の発言ではないので、outbox は通さず
 * 本文のハッシュを記録して（履歴が通知として描く）、画面へは通知の一行を出す。
 * true=受理 → ok / false=受理できない → requeue（空いてから新しいターンで）/ throw=結果不明 → error（自動で再送しない）。
 * 「渡った」合図を後から出すバックエンド（steerConfirms）では、通知の一行を渡った時点で出し、捨てられたら送り直す（liveNotices）
 */
async function steerNotice(turn, owner, prompt, tasks, redeliver = null) {
  await recordTaskNotice(owner, prompt);
  const item = { id: `task-notice-${crypto.randomUUID()}`, args: { prompt } };
  const confirms = Boolean(turn.control.steerConfirms);
  // 合図は受理の応答より先に来ることがある。先に登録しておく
  if (confirms) liveNotices.set(item.id, { owner, prompt, items: tasks.map(x => ({ taskId: x.taskId, revision: x.revision ?? 0 })), ...(redeliver ? { redeliver } : {}) });
  let accepted;
  try { accepted = await turn.control.steer?.(item); }
  catch { liveNotices.delete(item.id); return 'error'; }
  if (!accepted) { liveNotices.delete(item.id); return 'requeue'; }
  if (!confirms) emitGlobal({ type: 'taskNotice', sessionId: owner, text: prompt });
  return 'ok';
}

/**
 * 追加指示（ply_task_send）を今すぐ渡せる、子の走っているターン（無ければ null）。委譲の子として実行中のターンだけを対象にし、
 * 渡してよい条件は完了通知と同じ（canSteerNotice。子の会話に人の送信待ちがあれば渡さない）
 */
async function childTarget(sessionId) {
  const turn = taskExecutions.has(sessionId) ? runtime.turns.get(sessionId) : null;
  if (!turn) return null;
  const unsent = (await outbox.list(sessionId)).some(m => !['sent', 'cancelled'].includes(m.status));
  return canSteerNotice(turn, { unsent, nextSettings: (await store.get(sessionId)).nextSettings }) ? turn : null;
}

/**
 * 追加指示を、走っている子のターンへ途中送信（control.steer）で渡す。人間の発言ではないので outbox は通さず、
 * 子の会話には通常の user 発言として出す（履歴にはバックエンドの記録が入る）。
 * 'delivered'=受理（合図の無いバックエンドは渡ったものとして扱う）/ 'pending'=受理して「渡った」合図を待つ（liveInstructions）/
 * 'requeue'=受理できない → 待機のまま次のターンで / 'error'=結果不明 → 自動で送り直さない
 */
async function steerInstruction(task, instruction) {
  const turn = await childTarget(task.sessionId);
  if (!turn) return 'requeue';
  const item = { id: `task-send-${instruction.id}`, args: { prompt: instruction.text } };
  const confirms = Boolean(turn.control.steerConfirms);
  // 合図は受理の応答より先に来ることがある。先に登録しておく
  if (confirms) liveInstructions.set(item.id, { sessionId: task.sessionId, taskId: task.taskId, instructionId: instruction.id });
  let accepted;
  try { accepted = await turn.control.steer?.(item); }
  catch { liveInstructions.delete(item.id); return 'error'; }
  if (!accepted) { liveInstructions.delete(item.id); return 'requeue'; }
  emitGlobal({ type: 'userMessage', sessionId: task.sessionId, messageId: item.id, text: instruction.text, at: Date.now(), ...(confirms ? { pending: true } : {}) });
  return confirms ? 'pending' : 'delivered';
}
/** 追加の指示（ply_task_send）で再開した子の作業場所が、前の完了で片付いていたら作り直す（元の場所に書かせない）。作り直したら公開の形を返す */
async function renewTaskWorktree(task) {
  if (!task.worktree || await worktreeHost.worktrees.get(task.worktree.id)) return null;
  if (!await fs.stat(task.worktree.origin).then(s => s.isDirectory(), () => false)) return null;
  const made = await worktreeHost.createForTask({ cwd: task.worktree.origin, owner: task.parentSessionId, taskId: task.taskId, sessionId: task.sessionId });
  if (!made.ok) return null;
  const current = (await store.get(task.sessionId)).cwd ?? null;
  await store.recordChange(task.sessionId, { by: 'ply', field: 'cwd', from: current, to: made.cwd, ...savedReason('worktreeSplit') });
  emitGlobal({ type: 'cwd', sessionId: task.sessionId, cwd: made.cwd, by: 'ply', ...savedReason('worktreeSplit') });
  return publicWorktree(made.entry);
}

/**
 * 人が始めるターンで、「いつも分ける」を選んでいて、同じリポジトリの別の会話が書き込み中なら、確かめずに分ける（ADR 0089）。
 * 分けなかった・分けられなかったときは null（今の場所のまま始める）
 */
async function autoSplitTurn({ sessionId, cwd }) {
  if (!(await worktreeHost.worktrees.getSettings()).always) return null;
  const check = await worktreeHost.check({ sessionId, cwd, writes: true });
  if (!check.canSplit || !check.conflicts.length) return null;
  const made = await worktreeHost.split({ cwd, sessionId });
  if (!made.ok) return null;
  return { entry: made.entry, cwd: made.cwd,
    note: { id: made.entry.id, branch: made.entry.branch, path: made.entry.path, origin: cwd, conflicts: check.conflicts.map(c => c.title).filter(Boolean).slice(0, 3), count: check.conflicts.length } };
}
/** 分けて始めた印の 1 行を会話に残す（会話の id が決まってから 1 度だけ） */
function emitWorktreeNotice(turn, emit, sessionId) {
  const note = turn.worktreeNote;
  if (!note || !sessionId) return;
  turn.worktreeNote = null;
  emit({ type: 'present', kind: 'worktree', sessionId, worktree: note, by: 'ai', at: new Date().toISOString() });
}
/** 画面が聞く「この会話の承認モードは書き込みの範囲か」。読むだけの会話には分ける注記を出さない */
async function sessionWrites(sessionId, backendId, modeId) {
  const backend = sessionId ? await resolveBackendForSession(sessionId).catch(() => null) : getBackend(backendId);
  const useBackend = (backendId && getBackend(backendId)) || backend;
  if (!useBackend) return false;
  const mode = await resolveMode(sessionId, modeId, useBackend).catch(() => null);
  return Boolean(mode) && writesScope(useBackend.modes()?.[mode]);
}
/** 会話を消した（下書きの削除）。その会話のために作った分けた作業場所を、使っていなければ片付ける */
async function settleWorktreesOf(sessionId) {
  for (const e of await worktreeHost.worktrees.list()) {
    if (e.purpose === 'conversation' && e.sessionId === sessionId && e.state === 'ready') await worktreeHost.worktrees.settle(e.id).catch(() => {});
  }
}
agentTasks = await createAgentTasks({
  dataDir: store.dataDir,
  changed: () => { broadcastRunning(); completionNotices.changed(); },
  // 人間の承認を待っているか。承認は core/server.mjs 側にしかないので判定を渡す。
  // 中継の複製も数える（孫が止まっていれば、その子も止まっている）
  waiting: sessionId => blockingWaits().some(w => w.payload.sessionId === sessionId),
  // コンピューターの操作のロックを待っている子は、黙っているとは数えない（承認待ちではないので ply_task_wait の waiting にはしない）
  lockWaiting: sessionId => computerLock.snapshot().some(s => s.sessionId === sessionId && s.state === 'waiting'),
  rollback: async ({ sessionId, worktree }) => {
    await deleteUnsentConversation(sessionId); await store.removeSession(sessionId); releaseAgentConnection(sessionId);
    if (worktree) await worktreeHost.abandon(worktree.id).catch(() => {});
  },
  // 子の分けた作業場所の今の状態（ply_task_status・ply_task_wait の workspaceSummary）
  workspaceState: task => worktreeHost.taskState(task.worktree),
  prepare: async (owner, args, taskId, signal) => {
    const parent = runtime.turns.get(owner);
    // エラーは ply_delegate の結果として依頼元のエージェントが読む。子の会話は依頼元の会話の言語を継ぐ
    const lng = parent?.agentLocale ?? await agentLocaleFor(owner);
    // 人が委譲カードの「別の候補でやり直す」で作るタスク（retryAgentTask）は、依頼元のターンの外で作る。
    // 作業場所は元のタスクの絶対パスを渡すので、依頼元のターンが無くても決まる
    const manual = args.routing?.mode === 'manual';
    if ((!parent && !manual) || signal?.aborted) throw new Error(agentT(lng, 'delegation.parentEnded'));
    const backend = getBackend(args.backend);
    if (!backend) throw new Error(agentT(lng, 'delegation.backendDisabled'));
    let cwd = path.resolve(parent?.info.cwd ?? (await store.get(owner)).cwd ?? process.cwd(), args.cwd ?? '.');
    if (!(await fs.stat(cwd)).isDirectory()) throw new Error(agentT(lng, 'delegation.cwdNotDirectory'));
    // 自動の振り分けで選んだ委譲先（agentBridge の call の routeDelegation）と、人が使用量を見て選び直した委譲先。
    // 候補は公式の使用枠で選んでいるので、接続先は継がず公式で走らせ、アカウントも選んだものを使う
    // （docs/agent-delegation.md「委譲先の自動振り分け」）
    const auto = args.routing?.mode === 'auto' || manual;
    // 接続先（決定 3）: 同じエージェントへの委譲なら親の会話の接続先を継ぐ。違うエージェントへは公式に戻す（形式が合わない）
    const parentEndpoint = (await store.get(owner)).compatEndpoint ?? '';
    const inherited = endpointCapable(backend) && !auto ? delegatedEndpoint(parent?.backend?.id, backend.id, parentEndpoint) : '';
    // 継ぐべき接続先が消えていたら委譲を断る（黙って公式で走らせない）
    if (inherited && !(await compatEndpoints.has(inherited, backend.id))) throw new Error(agentT(lng, 'delegation.endpointDeleted'));
    const endpoint = inherited;
    const model = await resolveModel(null, args.model, backend, cwd, endpoint);
    // 選んだモデルを使えなくなっていたら、黙って既定に落とさず断る
    if (auto && model !== args.model) throw new Error(agentT(lng, 'routing.modelUnavailable', { model: args.model, backend: backend.id }));
    const effort = await resolveEffort(null, args.effort, backend, model, cwd, await endpointRow(endpoint));
    // 承認モードは委譲を受け付けた側（agentBridge の call）が親の強さから決めてある。
    // ここで決め直すと「聞いた内容」と「実際に動く強さ」がずれるので、来た値をそのまま使う。
    const modes = backend.modes();
    const mode = modes[args.mode] ? args.mode : firstMode(modes);
    // 子は親の会話のアカウントで走る（親が別のエージェントでも、その会話で選んであるものを継ぐ）。
    // 自動で Claude を選んだときは、使用量で選んだアカウント（'' はログイン中のアカウント）
    const account = auto && backend.id === 'claude' ? args.account ?? '' : (await store.get(owner)).claudeAccount ?? '';
    // 振り分けの記録（タスクと子の会話に残す）。委譲先は実際に使う値で書く（固定のときのモデルの既定への戻り・継いだアカウントも）
    const routing = args.routing ? { ...args.routing, target: { backend: backend.id, model, account: backend.id === 'claude' ? account : null } } : null;
    // 分けた作業場所（ADR 0089）。子の作業場所をここで作る。作れなければ（git でない・コミットが無い・失敗）今の場所のまま走らせる
    let worktree = null;
    if (args.isolate === true) {
      const made = await worktreeHost.createForTask({ cwd, owner, taskId });
      if (made.ok) { worktree = publicWorktree(made.entry); cwd = made.cwd; }
      else console.error('  分けた作業場所を作れなかったので、元の場所で走らせる:', made.reason, made.error ?? '');
    }
    const info = { title: args.title, cwd, createdAt: Date.now(), lastModified: Date.now() };
    let sessionId;
    try { sessionId = await createConversation(backend, info); }
    catch (e) { if (worktree) await worktreeHost.abandon(worktree.id).catch(() => {}); throw e; }
    if (worktree) await worktreeHost.worktrees.update(worktree.id, { sessionId }).catch(() => {});
    try {
      await store.setMeta(sessionId, { ...info, backend: backend.id, unsent: true });
      await store.setMode(sessionId, mode); await store.setModel(sessionId, model);
      await store.setSessionData(sessionId, 'effort', effort);
      await store.setSessionData(sessionId, 'delegation', { taskId, parentSessionId: owner, manager: 'ply' });
      await store.setSessionData(sessionId, 'agentLocale', lng);
      if (account) await store.setSessionData(sessionId, 'claudeAccount', account);
      if (endpoint) await store.setSessionData(sessionId, 'compatEndpoint', endpoint);
      if (routing) await store.setSessionData(sessionId, 'routing', routing);
      if (signal?.aborted) throw new Error(agentT(lng, 'delegation.aborted'));
    } catch (e) {
      await deleteUnsentConversation(sessionId); await store.removeSession(sessionId); releaseAgentConnection(sessionId);
      if (worktree) await worktreeHost.abandon(worktree.id).catch(() => {});
      throw e;
    }
    return { backend: backend.id, model, effort, cwd, mode, sessionId, ...(worktree ? { worktree } : {}), ...(routing ? { routing } : {}) };
  },
  execute: async (task, prompt, signal) => {
    if (signal.aborted) { await worktreeHost.taskDone(task).catch(() => {}); return { outcome: 'aborted' }; }
    if (sessionBusy(task.sessionId)) return { requeue: true };
    const execution = { outcome: null, error: null, rejections: [], stopped: [], reply: null, timer: null };
    taskExecutions.set(task.sessionId, execution);
    const stopChild = () => {
      const child = runtime.turns.get(task.sessionId);
      // 依頼元の会話を止めた理由（abortSessions が置く）。この取り消しが実際に止めるターンにだけ付ける
      const why = taskStopReasons.get(task.sessionId);
      taskStopReasons.delete(task.sessionId);
      if (child && why) child.abortReason ??= why;
      child?.ac.abort();
      getBackend(task.backend)?.stopSession?.(task.sessionId);
    };
    signal.addEventListener('abort', stopChild, { once: true });
    try {
      // 追加の指示（ply_task_send）で再開した子の作業場所が、前の完了で片付いていたら作り直す（元の場所に書かせない）
      const renewed = await renewTaskWorktree(task).catch(() => null);
      const outcome = await runTurn({ sessionId: task.sessionId, backend: task.backend, prompt }, () => {}, { signal });
      if (outcome === 'requeue') return { requeue: true };
      // A child can itself delegate. Its result is final only after those results
      // have been delivered and it has finished responding to them.
      const childrenBusy = () => agentTasks.list(task.sessionId).some(r => ['queued', 'running', 'cancelling'].includes(r.status) || ['pending', 'delivering'].includes(r.notification));
      // ターンの外に残る端末（Codex）は待たない。終わっても main は再開せず、結果は変わらない（awaitedBackground）
      while (!signal.aborted && (sessionBusy(task.sessionId) || awaitedBackground(task.sessionId) || childrenBusy())) await waitFree(task.sessionId, 250);
      const last = await lastReply(task.sessionId);
      // 裏の作業を止める前の返答（報告）を残す。止めた後に main が再開して足した一言だけが結果にならないように
      const text = execution.reply && execution.reply !== last ? [execution.reply, last].filter(Boolean).join('\n\n') : last;
      // error は完了通知に載って依頼元のエージェントが読む（依頼元の会話の言語）
      const rejections = execution.rejections.map(peerRejection);
      const stoppedBackground = execution.stopped.map(peerBackground);
      const nowCwd = (await store.get(task.sessionId).catch(() => null))?.cwd ?? task.cwd;
      const git = await taskGitNote({ ...task, cwd: nowCwd });
      // 子が終わった。変わっていなければ・取り込み済みなら片付け、そうでなければ残す。通知に載せる状態は片付ける前のもの
      const workspace = await worktreeHost.taskDone({ ...task, worktree: renewed ?? task.worktree }).catch(() => null);
      const extra = { ...(workspace ? { workspace } : {}), ...(renewed ? { worktree: renewed } : {}) };
      worktreeSweepSoon();
      if (agentTasks.list(task.sessionId).some(r => r.notification === 'unknown')) return { outcome: 'error', text, error: agentT(await agentLocaleFor(task.parentSessionId), 'delegation.noticeUnknown'), rejections, stoppedBackground, git, ...extra };
      return { outcome: signal.aborted ? 'aborted' : execution.outcome ?? outcome, text, error: execution.error, rejections, stoppedBackground, git, ...extra };
    } finally { signal.removeEventListener('abort', stopChild); clearTimeout(execution.timer); taskExecutions.delete(task.sessionId); }
  },
  // 依頼元が完了通知を受け取れるか。受け取れない間、委譲の管理は通知の状態を書き換えない（保存を減らす）
  ready: async task => !(await noticeBlocked(task.parentSessionId)),
  // 走っている依頼元のターンへ、今すぐ途中送信で渡せるか（無音・コマンドの通知は使わない。ADR 0057）
  steerable: async task => Boolean(await noticeTarget(task.parentSessionId)),
  // 走っている子のターンへ、追加指示を今すぐ途中送信で渡せるか（ADR 0065）
  childSteerable: async task => Boolean(await childTarget(task.sessionId)),
  steer: steerInstruction,
  // 同じ依頼元への完了通知をまとめて 1 つ届ける。走っているターンへ渡せれば途中送信で（noticeTarget）、
  // 渡せなければ（requeue）空いてから新しいターンで
  deliver: async tasks => {
    const owner = tasks[0].parentSessionId;
    const live = await noticeTarget(owner);
    if (!live && await noticeBlocked(owner)) return 'requeue';
    // 完了通知は依頼元の会話の言語で。人間の発言と見分ける印は文言ではなく、送った本文のハッシュ（taskNotices。recordTaskNotice）
    const prompt = completionNotice(await ensureAgentLocale(owner), tasks);
    return live ? steerNotice(live, owner, prompt, tasks) : runTurn({ sessionId: owner, prompt }, () => {}, { internal: true });
  },
  cancelBackground: async task => {
    for (const command of task.activeCommands) {
      const found = findBackgroundTask(task.sessionId, command.nativeTaskId ?? command.toolCallId);
      if (found) await found.backend.stopBackground(task.sessionId, found.task.id);
    }
  },
  deliverCommand: async (task, command) => {
    const owner = task.parentSessionId;
    if (await noticeBlocked(owner)) return 'requeue';
    const lng = await ensureAgentLocale(owner);
    const prompt = agentT(lng, 'delegation.commandNotice', { taskId: task.taskId, noticeId: command.noticeId,
      title: task.title, command: redactForPeer(command.command, 200), minutes: command.elapsedMinutes });
    return runTurn({ sessionId: owner, prompt }, () => {}, { internal: true });
  },
  deliverSilence: async (task, minutes) => {
    const owner = task.parentSessionId;
    if (await noticeBlocked(owner)) return 'requeue';
    const lng = await ensureAgentLocale(owner);
    const prompt = agentT(lng, 'delegation.silenceNotice', { taskId: task.taskId, title: task.title, minutes });
    return runTurn({ sessionId: owner, prompt }, () => {}, { internal: true });
  },
});
// 前の起動で走っていて、再起動で止まった委譲タスクを、依頼元の会話の「止めたもの」に残す（次のターンで伝える）。
// 裏の作業と承認待ちは保存していないので分からない（docs/design.md「中断と再開」）
await recordTaskStops(agentTasks.restored, 'restart', { restart: true });
// 設定の変更の承認の結果を会話へ届ける（ADR 0088）。届け方は委譲の完了通知と同じ（ADR 0057）: 走っているターンへ途中送信で渡せればそこへ、
// 渡せなければ会話が空いてから新しいターンで。前の起動で待っていた要求は、再起動で取り下げた結果として届ける
settingApprovals = await createSettingApprovals({
  dataDir: store.dataDir,
  route: routeSettingNotice,
  onError: e => console.error('  設定の変更の承認の台帳:', String(e?.message ?? e)),
  deliver: async (sessionId, notices) => {
    const live = await noticeTarget(sessionId);
    if (!live && await noticeBlocked(sessionId)) return 'requeue';
    const prompt = settingNotice(await ensureAgentLocale(sessionId), notices);
    if (live) {
      const r = await steerNotice(live, sessionId, prompt, [], () => settingApprovals.requeue(notices));
      return r === 'requeue' ? 'requeue' : r === 'ok' ? 'ok' : 'error';
    }
    return (await runTurn({ sessionId, prompt }, () => {}, { internal: true })) === 'requeue' ? 'requeue' : 'ok';
  },
});
if (settingApprovals.restored) console.log(`  前の起動で承認を待っていた設定の変更 ${settingApprovals.restored} 件を取り下げた（結果を会話へ届ける）`);
// 分けた作業場所: 台帳と git worktree list を突き合わせ（作成の途中で落ちたものは巻き戻す）、使っていない片付けられるものを消す（ADR 0089）
await worktreeHost.worktrees.reconcile()
  .then(r => { const n = Object.values(r).reduce((a, l) => a + l.length, 0); if (n) console.log(`  分けた作業場所を ${n} 件整理した`); })
  .catch(e => console.error('  分けた作業場所の整理に失敗:', String(e?.message ?? e)));
worktreeSweepSoon();

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

// バックエンドがプロンプトを受け取った後にしか出せないイベント。初回の発言の「渡った」合図の代わりに使う
const ANSWER_EVENTS = new Set(['text.delta', 'text.end', 'thinking.delta', 'tool.start']);

async function runTurnInternal(args, onStarted, hooks) {
  const { prompt, sessionId = null } = args ?? {};
  if (hooks.canStart && !hooks.canStart()) return 'cancelled';
  if ((hooks.internal || hooks.signal) && (sessionBusy(sessionId))) return 'requeue';
  if (switching.has(sessionId) || forking.has(sessionId)) throw new Error(t('agents.switching'));
  // 同じセッションの二重実行は防ぐ。別のセッションなら並行して回してよい
  if (sessionId && runtime.turns.has(sessionId)) throw new Error(t('session.running'));
  if (sessionId && hooks.compact !== 'idle') compactionScheduler.cancel(sessionId);
  const compactionRevision = sessionId ? compactionScheduler.revision(sessionId) : null;
  if (sessionId) switching.add(sessionId);
  try {

    // 行き先が決まらないターンは始めない。断るのは登録する前。
    await settingsWrites.get(sessionId);
    let backend = refuseRetired(await pickBackend(sessionId, args?.backend));
    const reserved = sessionId ? (await store.get(sessionId)).nextSettings : null;
    let { cwd, changedFrom } = await resolveCwd(sessionId, reserved?.cwd ?? args?.cwd, backend);
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
      if (target.id !== backend.id) {
        await switchBackend(sessionId, backend, target);
        await shellRuns.switched(sessionId, backend, target);
      }
      backend = target;
    }
    // Reject before marking the conversation sent or consuming its pending handoff.
    if (hooks.compact && backend.compact) {
      const record = await conversation(sessionId);
      if (record && !record.nativeId) throw new Error(t('compaction.notStarted'));
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
    // 分けた作業場所（ADR 0089）。使う場所が分けた作業場所の中なら控える（片付けの印・取り込みを頼む相手）。片付けている最中の場所では始めない。
    // 「いつも分ける」を選んでいて、人が始めるターンで同じリポジトリの別の会話が書き込み中なら、確かめずに分けて始める
    let worktreeEntry = await worktreeHost.worktrees.byPath(cwd);
    if (worktreeEntry && worktreeEntry.state !== 'ready') throw new Error(t('worktree.cleaning'));
    let worktreeNote = null;
    if (!worktreeEntry && !hooks.internal && !hooks.compact && !hooks.signal && writesScope(backend.modes()?.[permissionMode])) {
      const split = await autoSplitTurn({ sessionId, cwd }).catch(() => null);
      if (split) {
        if (sessionId) {
          await store.recordChange(sessionId, { by: 'ply', field: 'cwd', from: cwd, to: split.cwd, ...savedReason('worktreeSplit'), backend });
          emitGlobal({ type: 'cwd', sessionId, cwd: split.cwd, by: 'ply', ...savedReason('worktreeSplit') });
        }
        cwd = split.cwd; worktreeEntry = split.entry; worktreeNote = split.note;
      }
    }
    if (sessionId) {
      if (!hooks.compact) await store.setSessionData(sessionId, 'compacted', false);
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

    if (changedFrom) settleWorktreeAt(changedFrom).catch(() => {});
    // 新規のときだけ効く状態。再開したセッションの状態は setStatus で変える
    const status = !sessionId && typeof args?.status === "string" && args.status.trim()
      ? args.status.trim() : null;
    // 入力欄に溜めていた添付（attachFile が置いたもの）。送信と一緒に会話へ載せる
    const attachments = Array.isArray(args?.attachments) ? args.attachments : [];
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
      delivered: { backend: backend.id, entries: delivered },
      // Pleiad が足した文の量（ADR 0056）。渡す文が出そろった所（下の runArgs の後）で数え直す。それまでは前のターンの値を見せる
      ...(previousContext?.plyParts ? { plyParts: previousContext.plyParts } : {}) };
    // Pleiad の指示（core/ply-instructions.mjs）。担当によらず、ターンごとに今の設定・モード・子かどうか・エージェントで決める。
    // 渡すのは ply_agents の instructions の後ろ（下の agentRuntime）。項目ごとに入れたか（入れなかった理由）を会話の記録に残し、右パネルに出す
    const added = turnInstructions({ list: plyInstructionsCache, locale: agentLocale, routing: routingSettingsCache.enabled,
      child: Boolean(sessionId && (await store.get(sessionId)).delegation), supported: Boolean(backend.capabilities?.plyAgents),
      canDelegate: canDelegate(backend.modes()[permissionMode]), agent: INSTRUCTION_AGENTS.includes(backend.id) ? backend.id : null });
    if (added) contextRecord.added = added;
    // Hooks の担当が Pleiad の場所（ADR 0049）。このエージェントへ渡す登録・止めるネイティブ・渡せないものを組み立て、会話の記録に残す。
    // 組み立てられなければ送らない（ネイティブと登録が二重に動くか、どちらも動かないため）
    let hooksTurn = null;
    try { hooksTurn = await prepareHooksTurn({ agent: backend.id, cwd, ctx: { plyHooks, hooksConfig, dataDir: store.dataDir, findNode: findNodeOnPath,
      context: { owners: policy.owners, delivered: plyContext } } }); }
    catch (e) { throw new Error(t('hooksUnify.prepareFailed', { error: String(e?.message ?? e) })); }
    if (hooksTurn) contextRecord.hooks = hooksTurn.record;
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
        user: hooks.internal || hooks.compact ? null : { role: "user", text: String(prompt ?? ""), at: new Date().toISOString(), backend: backend.id },
        initialMessageId: args.messageId ?? null,
        events: [],
      },
      key: sessionId ?? `new:${crypto.randomUUID()}`,
      ac: new AbortController(),
      // 中断の理由（abortSessions / giveUp が止める前に付ける。無いまま中断で終わったら user）
      abortReason: null,
      startedAtMs: Date.now(),
      userSentAt: toMs(args.at) ?? Date.now(),
      backend,
      agentLocale,
      control: { handle: null, onReady: () => outbox.kick(sessionId).catch(() => {}) },
      outcome: null,
      compactTrigger: hooks.compact ?? null,
      compactionRevision,
      userInitiated: !hooks.internal && !hooks.compact,
      compaction: null,
      compactionWrite: Promise.resolve(),
      contextWindow: null,
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
        account: accountId,
        status,
        attachments,
        // active = main が動いている / waiting = main は返答済みで、裏の subagent などを待っている
        phase: "active",
        background: [],
      },
    };
    // 止めた瞬間に、このターンが抱えていたもの（裏の作業・承認待ち）を控える。中断で終わったら会話の「止めたもの」に残す（endTurn）。
    // 承認待ちの却下（settleAll）より先に走るよう、ほかの abort の受け手より前に付ける
    turn.ac.signal.addEventListener('abort', () => { turn.stops ??= captureStops(turn); }, { once: true });
    if (hooks.signal?.aborted) turn.ac.abort();
    const abortFromTask = () => turn.ac.abort();
    hooks.signal?.addEventListener('abort', abortFromTask, { once: true });
    runtime.turns.set(turn.key, turn);
    for (const read of liveReads) if (read.sessionId === sessionId) read.turn = turn;
    // 分けた作業場所を使うターン。会話の id を台帳に控える（新しい会話は id が決まったとき）。分けて始めた印の行は id が決まってから出す
    turn.worktreeId = worktreeEntry?.id ?? null;
    turn.worktreeNote = worktreeNote;
    if (turn.worktreeId && sessionId) worktreeHost.worktrees.update(turn.worktreeId, { sessionId }).catch(() => {});
    turn.gitCalls = createCallTracker();
    const emit = makeEmit(turn);
    turn.visualizations = createVisualizationCollector({
      access: fileAccess,
      publish: async payload => {
        await turn.setup;
        const id = turn.info.sessionId;
        if (!id) throw new Error(t('agentRuntime.visualizeNotStarted'));
        const record = await history.recordPresent(id, { ...payload, turnKey: turn.presentKey });
        emit({ type: 'present', sessionId: id, ...record }, { recorded: true });
      },
    });

    let didStart = false, backendInvoked = false, runtimeContext;
    let initialDelivered = false;
    // 中断で止めたもの（stops）を伝える文。このターンの発言の前に 1 回だけ添え、渡ったら会話から消す（docs/design.md「中断と再開」）
    let interruption = null, interruptionTaken = false;
    // 入力欄の `!` の結果（ADR 0054）。人の発言のターンでだけ、発言と一緒に渡す（完了通知で再開するターン・圧縮では渡さない）。
    // 'host' の会話は未送の追記を shouldQuery: false の行で先に渡す。'native'（Codex）はエージェントの会話に既に入っている。
    // 「渡さない」の行は渡さず、渡った後に会話に残す行へ移す（ADR 0055）
    const shellHandoff = sessionId && !hooks.internal && !hooks.compact && shellMode(backend)
      ? (shellMode(backend) === 'host' ? await shellRuns.appendsFor(sessionId) : { ids: [], skipped: [], lines: [] }) : null;
    let shellHanded = false;
    const onPromptDelivered = () => {
      if (interruption && !interruptionTaken) {
        interruptionTaken = true;
        store.takeStops(sessionId, interruption.keys, { dropped: interruption.dropped }).catch(e => console.error('  中断で止めたものを伝えた記録に失敗:', String(e?.message ?? e)));
      }
      if (shellHandoff && !shellHanded) {
        shellHanded = true;
        shellRuns.delivered(sessionId, shellHandoff.ids, shellHandoff.skipped).catch(e => console.error('  shell: 渡した記録に失敗:', String(e?.message ?? e)));
      }
      if (initialDelivered || !args.messageId) return;
      initialDelivered = true;
      emit({ type: 'userMessage.delivered', messageId: args.messageId });
    };
    const saveContext = async () => {
      await turn.setup;
      if (turn.info.sessionId) await store.setSessionData(turn.info.sessionId, 'contextSession', contextRecord);
      emit({ type: 'contextUsage', report: structuredClone(contextRecord.report), plyParts: contextRecord.plyParts ?? null });
    };
    try {
      await onStarted();
      didStart = true;
      // 次のターンが始まったので中断の印を消し、走っている印を付ける（新しい会話は id が決まったとき。makeEmit の session）
      if (sessionId) await store.setMeta(sessionId, { turnStartedAt: turn.startedAtMs, interrupted: null }).catch(err => {
        console.error("  ターンの開始の記録に失敗:", String(err?.message ?? err));
      });
      // 中断で止めたものがあれば、エージェントの言語で文にして発言の前に添える（圧縮のターンでは添えない）。
      // 画面には、何を伝えたかを開ける 1 行で出す（履歴は system-messages.mjs の splitInterruptionNotes が同じ行にする）。
      // 発言の吹き出しの後に送り、画面は messageId の吹き出しの前へ置く（履歴と同じ並び）
      if (sessionId && !hooks.compact) {
        const stops = (await store.get(sessionId).catch(() => null))?.stops;
        interruption = interruptionNote(agentLocale, stops, stops?.reason);
      }
      if (args.messageId) emit({ type: "userMessage", messageId: args.messageId, text: String(prompt ?? ""), at: args.at, initial: true, pending: true });
      if (interruption) emit({ type: 'interruptionNote', text: interruption.body, ...(args.messageId ? { messageId: args.messageId } : {}) });
      broadcastRunning();
      syncRunningPoll();
      emitWorktreeNotice(turn, emit, sessionId);
      if (resolvedContext?.servers.length) emit({ type: 'activity', state: 'preparing' });
      if (hooks.internal) {
        await recordTaskNotice(sessionId, prompt);
        // 本文も載せる。画面の「タスクの結果で再開」の 1 行を開くと読める（ADR 0053）
        emit({ type: 'taskNotice', text: String(prompt ?? '') });
      }
      await saveContext();
      // agy のように会話のあいだ 1 本のプロセスを生かすバックエンドには、会話ごとの同じトークンで開く（起動時にしか渡せない）
      if (resolvedContext) runtimeContext = await contextBridge.open({ runtime: resolvedContext, prompt,
        ...(backend.capabilities?.plyContext === 'conversation' ? { token: conversationConnection(turn).contextToken } : {}),
        origin: localOrigin(), signal: turn.ac.signal,
        isActive: () => runtime.turns.get(turn.key) === turn && !turn.ac.signal.aborted, changed: saveContext,
        progress: ({ current, total }) => emit({ type: 'activity', state: 'preparing', current, total }),
        authorize: backend.id === 'codex' && !['full','yolo'].includes(permissionMode)
          ? async (serverName, toolName, input) => Boolean((await askPermission({ toolName: `${serverName} / ${toolName}`, input, sessionId: turn.info.sessionId, signal: turn.ac.signal, kind: 'tool', canAlways: false, locale: agentLocale }))?.allow)
          : undefined });
      if (resolvedContext?.servers.length) emit({ type: 'activity', state: 'thinking' });
      // 再開なら id が分かっているので先に載せる。新規は session イベントで id が決まった瞬間に（makeEmit）
      if (sessionId && attachments.length) await presentAttachments(sessionId, attachments, emit);
      if (hooks.signal?.aborted) throw new Error(t('turn.aborted'));
      // Codex は走っている `!` のターンに発言を入れ、返答しないまま閉じる。終わるまで待ってから始める（ADR 0054）
      if (sessionId && shellMode(backend) === 'native' && shellRuns.runningIn(sessionId)) {
        await shellRuns.settled(sessionId, turn.ac.signal);
        if (turn.ac.signal.aborted) throw new Error(t('turn.aborted'));
      }
      // 内蔵ブラウザーのプロフィール（ADR 0078）。会話の今のもの。中継の準備で main に渡す。ply_browser の切り替えはここを書き換える
      if (agentBrowser) turn.browserProfile = await (sessionId ? browserProfiles.resolve(sessionId) : browserProfiles.forNew(cwd)).catch(() => null);
      const runArgs = {
        prompt,
        ...(shellHandoff?.lines.length ? { shellAppends: shellHandoff.lines } : {}),
        ...(interruption ? { notes: [interruption.text] } : {}),
        ...(hooks.compact ? { compact: hooks.compact } : {}),
        sessionId,
        cwd,
        mode: permissionMode,
        model: model || undefined,
        effort,
        // 渡った合図（onPromptDelivered）を呼ばないバックエンド（antigravity）もある。返答の中身が届いたら渡ったとみなす
        emit: (event, opts) => { if (ANSWER_EVENTS.has(event?.type)) onPromptDelivered(); return emit(event, opts); },
        onPromptDelivered,
        // 拒否・中断の理由をこの会話の言語で返すため、会話の言語を添えて聞く
        askPermission: request => askPermission({ ...request, locale: agentLocale }),
        hostInvoke: async (op, args) => {
          const result = await opsRegistry.invoke({ by: 'agent', via: 'mcp', sessionId: args.sessionId }, op, args, opsDeps(agentLocale));
          if (!result.ok) throw new Error(result.error);
          return result.result;
        },
        signal: turn.ac,
        control: turn.control,
        // エージェントに渡す文（指示・ツールの説明・タイトル生成など）の言語。会話ごとに決めて保存したもの
        locale: agentLocale,
        visualizeInstructions: visualizeInstructions(agentLocale),
        browserEnv: await browserEnvironment({ bridge: agentBrowser, dataDir: store.dataDir, sessionId: sessionId || turn.key, unlock: turn.userInitiated, profile: turn.browserProfile }).catch(error => { console.error('agent browser unavailable:', error.message); return null; }),
        browserInstructions: null,
        // ply_browser（プロフィールの一覧と切り替え）。内蔵ブラウザーを渡すターンだけ（下で入れる）
        browserRuntime: null,
        // ply_computer（url・headers・instructions）。使えない・オフ・対応しないエージェントなら null（computerRuntimeFor）
        computerRuntime: await computerRuntimeFor(turn),
        // ply_control（操作の一覧）。全会話に渡す。env は会話のシェルへ渡す CLI の接続情報
        controlRuntime: controlRuntimeFor(turn),
        addedInstructions: !backend.capabilities?.plyAgents ? withAdded(null, contextRecord.added) : null,
        contextRuntime: runtimeContext,
        // Hooks を Pleiad がそろえるターンだけ（担当がエージェントなら渡さない。エージェントの設定の hooks がそのまま動く）
        ...(hooksTurn?.runtime ? { hooksRuntime: hooksTurn.runtime } : {}),
        // 橋は会話ごとに使い回すので、Pleiad の指示はターンごとにここで足す（設定の変更が始まっている会話にも次のターンから効く）
        agentRuntime: (runtime => ({ ...runtime, instructions: withAdded(runtime.instructions, contextRecord.added) }))(agentConnection(turn)),
        // 会話で選んだアカウントのトークン。この会話の query() の env にだけ入る（core/claude-accounts.mjs）
        ...(account ? { oauthToken: account.token } : {}),
        // 互換の接続先（キーを含む。backend の中でだけ使い、ログ・イベントには出さない。core/compat-endpoints.mjs）
        ...(endpoint ? { endpoint } : {}),
      };
      if (runArgs.browserEnv) {
        // 中継へ渡したキー。新規会話の id 決定での付け替え（rebind）と、承認の問い合わせ（getAgent）がこれで照合する
        turn.browserRelayId = sessionId || turn.key;
        // i18n-dynamic: agent:browser.instructions
        runArgs.browserInstructions = browserInstruction(runArgs.browserEnv, agentLocale, agentT);
        runArgs.browserRuntime = browserRuntimeFor(turn);
      }
      // Pleiad が足した文の量（右パネルの「指示の量」。ADR 0056）。このターンで渡す文が出そろったここで数え、変わったときだけ記録し直す
      const parts = plyParts({ plyAgents: Boolean(backend.capabilities?.plyAgents), context: runtimeContext?.sections ?? null,
        visualize: runArgs.visualizeInstructions, browser: runArgs.browserInstructions, agents: agentConnection(turn).instructions, added: contextRecord.added,
        computer: computerPrompt(runArgs.computerRuntime, { locale: agentLocale, agent: backend.id }), control: runArgs.controlRuntime.instructions });
      if (JSON.stringify(parts) !== JSON.stringify(contextRecord.plyParts ?? null)) { contextRecord.plyParts = parts; await saveContext(); }
      // Preparation can await context and settings. A send or cancellation may have invalidated
      // an idle reservation since the first check; do not invoke the backend in that case.
      if (hooks.canInvoke && !hooks.canInvoke()) {
        turn.outcome = 'requeue';
        return 'requeue';
      }
      // git の作業場所なら、ターンの始まりの状態を隠し ref に撮る（書き込みの範囲のターンだけ。圧縮では撮らない。ADR 0085）。
      // 撮影が遅いときは待たずに始める（その回は撮影なし）
      if (GIT_SNAPSHOTS && !hooks.compact && scopeRank(modePosition(backend.modes()?.[permissionMode]).scope) > scopeRank('readonly')) {
        turn.gitSetup = gitActivity.begin({ cwd }).then(g => {
          if (turn.gitLate) return null;
          turn.git = g;
          return g && turn.info.sessionId ? gitActivity.attach(g, turn.info.sessionId) : null;
        }).catch(() => {});
        let began = false;
        await Promise.race([turn.gitSetup.then(() => { began = true; }), new Promise(resolve => setTimeout(resolve, GIT_BEGIN_WAIT_MS).unref?.())]);
        // 間に合わなかった。エージェントが動き出した後の撮影は基準にならないので、このターンは撮らない
        if (!began) turn.gitLate = true;
      }
      backendInvoked = true;
      const result = hooks.compact && backend.compact
        ? await backend.compact({ ...runArgs, trigger: hooks.compact })
        : await backend.runTurn(runArgs);
      if (hooks.compact && !turn.compaction?.phase?.match(/^complete$/)) {
        emit({ type: 'compaction', phase: 'failed', trigger: hooks.compact,
          reason: result?.compactionFailureReason || turn.compaction?.reason || t('compaction.noCompletion') });
      }
      if (hooks.compact && turn.outcome == null) emit({ type: 'turnResult', outcome: 'ok' });
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
          // 中断の後に添えた文は発言から切り分けてから照らす（history.loadTranscript と同じ）
          const messages = splitInterruptionNotes(await backend.getMessages(turn.info.sessionId));
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
      if (hooks.compact && turn.compaction?.phase !== 'complete') emit({ type: 'compaction', phase: 'failed', trigger: hooks.compact,
        reason: String(err?.message ?? err) });
      if (resolvedContext) { contextRecord.report.status = 'failed'; await saveContext().catch(() => {}); }
      if (!turn.errorShown) emit({ type: "turnResult", outcome: "error", error: String(err?.message ?? err) });
      // プロンプトを渡す前に失敗した（backends/undelivered.mjs）。送信済みにしたままだと、本文がどこにも残らず消える。
      // 送信待ちの「失敗」に戻し、利用者に再送か取り消しを選ばせる
      if ((err?.undelivered || !backendInvoked) && sessionId && args.messageId) {
        await outbox.undelivered(sessionId, args.messageId, String(err?.message ?? err)).catch(() => {});
      }
      if (!didStart) throw err;
    } finally {
      // 渡らずに終わった `!` の行は、また「渡さない」を切り替えられる
      if (shellHandoff && !shellHanded) shellRuns.release(sessionId, shellHandoff);
      if (didStart && turn.outcome !== 'ok' && turn.outcome !== 'requeue') await outbox.pause(sessionId).catch(() => {});
      await turn.visualizations.close().catch(err => emit({ type: 'turnResult', outcome: 'error', error: t('turn.visualizationSaveFailed', { error: err.message }) }));
      await Promise.allSettled([runtimeContext?.close()]);
      await saveContext().catch(() => { emit({ type: 'turnResult', outcome: 'error', error: t('turn.contextSaveFailed') }); });
      // git の動き（ADR 0085）: ターンの終わりの撮影と、返答の下の 1 行の元。ファイル・コミット・ブランチ・PR のどれかが動いたときだけ会話に残す
      if (turn.gitSetup && didStart && turn.outcome !== 'requeue') {
        const summary = await Promise.race([
          turn.gitSetup.then(() => (turn.git ? gitActivity.finish(turn.git, turn.info.sessionId, turn.gitCalls.events()) : null)),
          new Promise(resolve => setTimeout(resolve, GIT_END_WAIT_MS, null).unref?.()),
        ]).catch(() => null);
        if (summary && turn.info.sessionId) emit({ type: 'present', kind: 'git', git: summary, by: 'ai', at: new Date().toISOString(), sessionId: turn.info.sessionId });
      }
      await endTurn(turn, emit, { record: didStart });
      hooks.signal?.removeEventListener("abort", abortFromTask);
    }
    return turn.outcome;
  } finally {
    switching.delete(sessionId);
    completionNotices.changed(sessionId);
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
  // 中断で終わった（バックエンドが aborted を返した。止めた後に失敗として終わったものも含む）なら、会話に中断として残す。
  // 時刻は completedAt と同じ値にする（確認済みの印 readAt は completedAt で丸めるので、ずらすと未読から戻れない）
  const limited = !requeued && turn.outcome === 'limited';
  const stopped = !requeued && (limited || turn.outcome === "aborted" || (turn.ac.signal.aborted && turn.outcome !== "ok"));
  const interrupted = limited ? { at: completedAt, reason: 'limit', sentAt: turn.userSentAt, ...turn.limit } : stopped ? { at: completedAt, reason: turn.abortReason ?? "user" } : null;
  const autoResume = limited && limitResumeSettings.mode === 'auto' && Number.isFinite(interrupted.resetsAt)
    && interrupted.resetsAt - completedAt <= 12 * 60 * 60_000;
  const notifyAtReset = limited && limitResumeSettings.mode === 'ask' && Number.isFinite(interrupted.resetsAt)
    && interrupted.resetsAt - completedAt <= 12 * 60 * 60_000;
  if (limited) interrupted.autoResume = autoResume;
  if (limited) interrupted.notifyAtReset = notifyAtReset;
  if (record && !requeued) await usageStore.record({ ...turn.usage, id: turn.presentKey, backend: turn.backend.id })
    .catch(() => { console.error('  使用量を記録できませんでした'); });
  if (turn.info.sessionId) {
    await turn.setup?.catch(() => {});
    await turn.compactionWrite;
    if (turn.contextWindow) await store.setSessionData(turn.info.sessionId, 'contextWindow', turn.contextWindow).catch(() => {});
    if (turn.hookRuns?.length) {
      const previous = (await store.get(turn.info.sessionId).catch(() => ({}))).hookRuns ?? [];
      await store.setSessionData(turn.info.sessionId, 'hookRuns', trimHookRuns([...previous, ...turn.hookRuns])).catch(() => {});
      turn.hookRuns = [];
    }
    // 走っている印（turnStartedAt）はどの終わり方でも片付ける。requeue は何も届いていないので完了も中断も書かない
    // 始まらなかったターン（record が false）は前の中断の印を消さない（開始で消していないので）
    const patch = requeued ? { turnStartedAt: null }
      : { completedAt, turnStartedAt: null, ...(record || stopped ? { interrupted } : {}) };
    await store.setMeta(turn.info.sessionId, patch).catch(err => {
      console.error("  完了の記録に失敗:", String(err?.message ?? err));
    });
    if (limited) {
      const id = turn.info.sessionId;
      limitStates.set(id, interrupted);
      if (autoResume || notifyAtReset) await schedule.put({ id: `resume:${id}`, kind: 'resume', sessionId: id,
        at: interrupted.resetsAt, createdAt: completedAt, by: 'limit', account: interrupted.account });
    }
    // このターンで進んだ分を検索の写しへ（裏で読み直す。待たない）
    if (!requeued) sessionSearch.refresh(turn.info.sessionId);
    // 中断で終わったターンが抱えていた裏の作業・承認待ちを、会話の「止めたもの」に残す（次のターンで伝える）
    if (stopped && turn.stops) await store.addStops(turn.info.sessionId, { ...turn.stops, reason: interrupted.reason }).catch(err => {
      console.error("  中断で止めたものの記録に失敗:", String(err?.message ?? err));
    });
  }
  // 委譲された子の会話（delegation）の完了は、画面が通知しない。結果は依頼元の会話へ届く
  const delegated = turn.info.sessionId ? Boolean((await store.get(turn.info.sessionId).catch(() => null))?.delegation) : false;
  // Retain turnEnd in snapshots already being read, then release the turn.
  emit({ type: "turnEnd", completedAt, outcome: turn.outcome, interrupted, ...(requeued ? { requeued: true } : {}), ...(delegated ? { delegated: true } : {}) });
  runtime.turns.delete(turn.key);
  if (turn.info.sessionId) resumeQueue.settled(turn.info.sessionId);
  // 渡った合図が来ないまま終わった完了通知は、読まれたか分からない。通知は送り直してよいので、空いたときの経路へ戻す
  for (const [id, notice] of [...liveNotices]) {
    if (notice.owner !== turn.info.sessionId) continue;
    liveNotices.delete(id);
    if (notice.redeliver) notice.redeliver();
    else agentTasks?.renotify(notice.items).catch(() => {});
  }
  // 子のターンに渡した追加指示のうち、渡った合図が来ないまま終わったものは読まれたか分からない（読まれていれば合図が先に来ている）。
  // 待機へ戻して次のターンで送る。子の結果を確定する execute がこの後に返るので、結果の記録より先に戻る。
  // 画面には、渡っていない発言を下げる
  if (turn.info.sessionId) {
    for (const [id, sent] of [...liveInstructions]) {
      if (sent.sessionId !== turn.info.sessionId) continue;
      liveInstructions.delete(id);
      emitGlobal({ type: 'userMessage.dropped', sessionId: sent.sessionId, messageId: id });
    }
    await agentTasks?.settleSteers(turn.info.sessionId).catch(() => {});
  }
  agentBrowser?.endTurn(turn.info.sessionId || turn.key);
  // ロックの解放、止めた印・このターンの拒否の消去、main への後始末（押したままの入力を離し、オーバーレイを消す）
  if (computerLock.endTurn(turn.presentKey)) computerDriver?.turnEnded(turn.presentKey);
  notifyFree(turn.key);
  syncRunningPoll();
  // 片付けるのはこのセッションの承認待ちだけ。他のターンの分は残す
  settleAll('turnEnded', turn.info.sessionId);
  broadcastRunning();
  // 分けた作業場所: このターンで取り込まれたもの・使われなくなったものを片付ける（ADR 0089）
  worktreeSweepSoon();
  // 空いている間の自動圧縮（idle）は利用者の作業ではないので、完了として知らせない
  if (!delegated && turn.compactTrigger !== 'idle') completionNotices.finished(turn.info.sessionId,
    limited && !interrupted.autoResume ? 'error' : turn.outcome, completedAt, { startedAt: turn.startedAtMs });
  settingApprovals?.changed();
  // 利用者の送信でも、委譲の完了通知などで始まったターンでも予約する（ADR 0068）。圧縮のターンの後は予約し直さない
  if (record && turn.outcome === 'ok' && !turn.compactTrigger && !turn.compaction
      && !delegated && turn.info.sessionId) {
    const id = turn.info.sessionId;
    const meta = await store.get(id);
    const queued = await outbox.list(id);
    const row = compactionSettings[turn.backend.id === 'fake' ? 'claude' : turn.backend.id];
    const usage = turn.contextWindow ?? meta.contextWindow;
    if (compactionScheduler.revision(id) === turn.compactionRevision && !runtime.turns.has(id)
        && !queued.some(m => !['sent', 'cancelled'].includes(m.status))
        && compactionSettings.enabled && row?.enabled && turn.backend.capabilities?.compact
        && usage?.usedTokens >= compactionSettings.minTokens && !meta.autoCompactionOff
        && !blockingWaits().some(w => w.payload.sessionId === id))
      compactionScheduler.schedule(id, turn.backend.id, row.delayMinutes * 60_000,
        turn.compactionRevision, usage.usedTokens);
  }
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
const COMPACTION_SCHEDULE_FILE = path.join(store.dataDir, 'compaction-schedule.json');
// 見えている予約をファイルに写す。同じティック内の連続変更は 1 回にまとめ、書き込みは順に行う（ADR 0069）
let compactionSaveTimer = null;
let compactionSaveChain = Promise.resolve();
function saveCompactionSchedule() {
  if (compactionSaveTimer) return;
  compactionSaveTimer = setTimeout(() => {
    compactionSaveTimer = null;
    compactionSaveChain = compactionSaveChain.then(async () => {
      const entries = {};
      for (const { sessionId, at, backendId, usedTokens } of compactionScheduler.entries())
        entries[sessionId] = { at, backend: backendId, usedTokens };
      await writeAtomic(COMPACTION_SCHEDULE_FILE, JSON.stringify({ version: 1, entries }, null, 2));
    }).catch(err => console.error('  自動圧縮の予約を保存できませんでした:', String(err?.message ?? err)));
  }, 0);
}
async function readCompactionSchedule() {
  try {
    const saved = JSON.parse(await fs.readFile(COMPACTION_SCHEDULE_FILE, 'utf8'));
    return saved?.version === 1 && saved.entries && typeof saved.entries === 'object' ? Object.entries(saved.entries) : [];
  } catch { return []; }
}
// 前の起動で置いた予約を戻す。猶予（8 分）を過ぎたもの、会話が無いもの、バックエンドが変わったものは捨てる。
// 発火時の canRun は今までどおり全条件を確かめる
async function restoreCompactionSchedule() {
  const revived = [];
  for (const [id, saved] of await readCompactionSchedule()) {
    if (!Number.isFinite(saved?.at) || typeof saved.backend !== 'string' || !(compactionScheduler.now() <= saved.at + compactionScheduler.graceMs)) continue;
    const backend = await resolveBackendForSession(id).catch(() => null);
    if (backend?.id === saved.backend) revived.push([id, saved]);
  }
  for (const [id, saved] of revived)
    compactionScheduler.schedule(id, saved.backend, Math.max(0, saved.at - compactionScheduler.now()),
      undefined, Number.isFinite(saved.usedTokens) ? saved.usedTokens : null);
  saveCompactionSchedule();
}
const compactionScheduler = createCompactionScheduler({
  changed: (sessionId, at) => { emitGlobal({ type: 'compactionSchedule', sessionId, at }); saveCompactionSchedule(); },
  canRun: async (id, expectedBackend) => {
    const [meta, backend, queued] = await Promise.all([store.get(id), resolveBackendForSession(id), outbox.list(id)]);
    const row = compactionSettings[backend?.id === 'fake' ? 'claude' : backend?.id];
    return backend?.id === expectedBackend && !sessionBusy(id) && !meta.autoCompactionOff && !meta.delegation
      && !queued.some(m => !['sent', 'cancelled'].includes(m.status))
      && compactionSettings.enabled && row?.enabled && backend?.capabilities?.compact
      && meta.contextWindow?.usedTokens >= compactionSettings.minTokens
      && !blockingWaits().some(w => w.payload.sessionId === id);
  },
  compact: async (id, _sessionId, current) => {
    if (current()) await runTurn({ sessionId: id, prompt: '/compact' }, () => {},
      { compact: 'idle', ...idleCompactionGuards(current, () => sessionBusy(id)) });
  },
});
const queuedCompactions = new Set();
async function compactionStartFailed(sessionId, trigger, err) {
  const entry = { id: crypto.randomUUID(), at: Date.now(), trigger, phase: 'failed', reason: String(err?.message ?? err) };
  try {
    const previous = (await store.get(sessionId)).compactions ?? [];
    await store.setSessionData(sessionId, 'compactions', [...previous, entry]);
  } catch (saveError) { console.error('  圧縮失敗の記録に失敗:', String(saveError?.message ?? saveError)); }
  emitGlobal({ type: 'compaction', sessionId, ...entry });
}
async function compactConversation(sessionId, trigger = 'manual') {
  const backend = await resolveBackendForSession(sessionId);
  if (!backend?.capabilities?.compact) throw new Error(t('compaction.unsupported'));
  if (sessionBusy(sessionId)) {
    if (queuedCompactions.has(sessionId)) return 'queued';
    queuedCompactions.add(sessionId);
    void (async () => {
      try {
        while (sessionBusy(sessionId)) await waitFree(sessionId, 30_000);
        if (queuedCompactions.has(sessionId)) await runTurn({ sessionId, prompt: '/compact' }, () => {}, { compact: trigger });
      } catch (err) {
        await compactionStartFailed(sessionId, trigger, err);
      } finally { queuedCompactions.delete(sessionId); }
    })();
    return 'queued';
  }
  return runTurn({ sessionId, prompt: '/compact' }, () => {}, { compact: trigger });
}
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
 * ターンの外に残っている裏の作業のうち、終わりを待つもの（web/work-status.mjs の behindOfTasks と同じ基準）。
 * Codex の端末（kind: terminal）は数えない。dev サーバーのように終わらないことがあり、終わっても main は再開しない。
 * 以前は端末があるだけで委譲の子の結果を待ち続け（running のまま）、端末のある親には完了通知を送らなかった（2026-09-27）
 */
function awaitedBackground(sessionId) {
  return (runtime.background.get(sessionId)?.tasks ?? []).some((x) => x.waitable === true || (x.kind !== "shell" && x.kind !== "terminal"));
}

/** 委譲の結果にする子の返答（agent-tasks.mjs の finalReply。Stop フックの続きの一言は飛ばす）。無ければ空文字 */
async function lastReply(sessionId) {
  const backend = await resolveBackendForSession(sessionId);
  return finalReply(await backend.getMessages(sessionId, { fullResults: true }));
}

/**
 * 委譲の子のターンで、main が返答を終えて裏の作業だけを待つ（phase: waiting）時間を測る。
 * DELEGATION_BACKGROUND_WAIT_MS を過ぎたら、サブエージェント以外の裏の作業を止める（作業ダイアログの停止ボタンと同じ stopBackground）。
 * Claude はそれまでターンを保持するので、裏へ回ったまま終わらないコマンドが 1 本あると、子の報告が済んでいてもタスクが running のまま残り、
 * 依頼元へ完了通知が届かなかった（2026-09-27。docs/agent-delegation.md「子に残った裏の作業」）。人が見ている会話では止めない（委譲の子だけ）
 */
function watchChildBackground(turn) {
  const execution = taskExecutions.get(turn.info.sessionId);
  if (!execution) return;
  if (turn.info.phase !== "waiting") { clearTimeout(execution.timer); execution.timer = null; return; }
  if (execution.timer) return;
  execution.timer = setTimeout(() => { execution.timer = null; void stopChildBackground(turn, execution); }, DELEGATION_BACKGROUND_WAIT_MS);
  execution.timer.unref?.();
}

async function stopChildBackground(turn, execution) {
  const sessionId = turn.info.sessionId;
  if (runtime.turns.get(sessionId) !== turn || taskExecutions.get(sessionId) !== execution || turn.info.phase !== "waiting") return;
  // サブエージェントは自分で終わるので止めない（止めると仕事を失う）
  const targets = (turn.info.background ?? []).filter((x) => x.kind !== "agent");
  if (!targets.length || typeof turn.backend.stopBackground !== "function") return;
  // 止めると main が再開して一言足すことがある。止める前の返答（報告）を控えておく
  execution.reply ??= await lastReply(sessionId).catch(() => null);
  for (const x of targets) {
    if (runtime.turns.get(sessionId) !== turn || taskExecutions.get(sessionId) !== execution || turn.info.phase !== "waiting") return;
    if (!turn.info.background?.some(task => task.id === x.id)) continue;
    try {
      const result = await turn.backend.stopBackground(sessionId, x.id);
      if (result?.stopped === false) continue;
      agentTasks?.observe(sessionId, { type: 'task.command', id: x.id, nativeTaskId: x.id, state: 'stopped' });
      execution.stopped.push(x);
      // i18n-ignore: サーバーのログ
      console.error(`  [delegation] 子 ${sessionId} の裏の作業（${x.kind}）を ${Math.round(DELEGATION_BACKGROUND_WAIT_MS / 1000)} 秒待って止めた`);
    } catch (err) {
      // i18n-ignore: サーバーのログ
      console.error(`  [delegation] 子 ${sessionId} の裏の作業（${x.kind}）を止められなかった: ${String(err?.message ?? err).slice(0, 200)}`);
    }
  }
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
  completionNotices.changed(sessionId);
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
 * Codex の端末の稼働・終了を委譲の台帳に伝える。端末がターンの後に終わったときは、
 * 走ったままに見えているツールカードへ結果を差し込む。
 * ターンを作らないので `running` にも使用量にも出ない。何でも流せる口にはしない
 * （本文や turnResult をターンの外から出すと、web の吹き出し・稼働表示の前提が崩れる）。
 */
const OUTSIDE_TURN_EVENTS = new Set(["tool.result", "task.command", "task.activity"]);
function emitOutsideTurn(sessionId, event) {
  if (!sessionId || !OUTSIDE_TURN_EVENTS.has(event?.type)) return;
  agentTasks?.observe(sessionId, event);
  if (event.type.startsWith("task.")) return;
  emitGlobal({ ...event, sessionId });
}

// Pleiad タスクがまだ終わっていない（取り消せば子のターンが止まる）状態。agentTasks.list は承認待ちを waiting と見せる
const LIVE_TASK = new Set(['queued', 'running', 'cancelling', 'waiting']);
/**
 * 会話を止めると取り消しで止まる、委譲の子孫の会話（孫以下も）。agentTasks.cancelOwner と同じく終わったタスクの先も辿るが、
 * 返すのはタスクがまだ終わっていない子だけ（終わったタスクの子の会話を人が直接動かしているターンは止まらない）
 */
function stoppedDescendants(sessionId) {
  const out = new Set(), seen = new Set([sessionId]);
  const queue = [sessionId];
  for (let i = 0; i < queue.length && seen.size < 1000; i++) {
    for (const r of agentTasks.list(queue[i])) {
      if (!r.sessionId || seen.has(r.sessionId)) continue;
      seen.add(r.sessionId);
      if (LIVE_TASK.has(r.status)) out.add(r.sessionId);
      queue.push(r.sessionId);
    }
  }
  return out;
}

/**
 * 止めた瞬間にターンが抱えていたもの（stops の background / approvals）。
 * 裏の作業は Claude の run_in_background の Bash・サブエージェント（turn.info.background。CLI の終了で止まる）。
 * Codex の端末はターンの外（runtime.background）にあり、中断では止まらないので数えない。
 * 承認待ちはこの会話のもの（中継の複製は、元の会話の分として数える）
 */
function captureStops(turn) {
  const id = turn.info.sessionId;
  return {
    background: (turn.info.background ?? []).map(backgroundStop),
    approvals: id ? [...runtime.waiting].filter(([, w]) => !w.relay && !w.detached && w.payload.sessionId === id).map(([key, w]) => approvalStop(key, w.payload)) : [],
  };
}

/** 取り消した委譲タスク（agentTasks.cancelOwner / cancel / restored の項目）を、依頼元の会話ごとに「止めたもの」へ足す */
async function recordTaskStops(list, reason, { restart = false } = {}) {
  const owners = new Map();
  for (const x of list ?? []) {
    if (!x?.parentSessionId) continue;
    if (!owners.has(x.parentSessionId)) owners.set(x.parentSessionId, []);
    owners.get(x.parentSessionId).push(taskStop(x, { restart }));
  }
  for (const [owner, tasks] of owners) await store.addStops(owner, { tasks, reason }).catch(err => {
    console.error("  中断で止めたものの記録に失敗:", String(err?.message ?? err));
  });
}

/**
 * 会話を止める（WS の abort と、デスクトップの「中断して終了」）。sessionId を省略したら全部。
 * 止めたターンは会話に中断（interrupted { at, reason }）として残る（endTurn）。
 * 委譲の子の会話も独立した会話なので、同じ理由で中断として残り、個別に再開できる。委譲タスクそのものは取り消す。
 */
async function abortSessions({ sessionId = null, reason } = {}) {
  const why = abortReason(reason);
  const paused = sessionId ? [sessionId] : [...runtime.turns.keys()];
  // 実際の中断を**最初に同期的に**行う。以前は Pleiad タスクの停止と送信待ちの保留（どちらもディスクへの
  // 書き込み）を待ってから中断していたので、タスクを多く作った会話ほど止まるのが遅れ、その間は途中送信も
  // 通ってしまっていた（steer は turn.ac.signal.aborted で断る）
  const targets = sessionId
    ? [runtime.turns.get(sessionId)].filter(Boolean)
    : [...runtime.turns.values()];
  // 1 つの会話を止めると、その会話の委譲タスク（終わっていないもの）も取り消しで止まる。子のターンにも同じ理由を付けるが、
  // 付けるのは取り消しが実際にそのターンを止めるとき（stopChild）。先に止め始めていた（理由が付いている）ターンは最初の理由のまま
  const children = sessionId ? [...stoppedDescendants(sessionId)] : [];
  for (const id of children) if (!taskStopReasons.has(id)) taskStopReasons.set(id, why);
  for (const t of targets) {
    t.abortReason ??= why;
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
  let cancelled = [];
  try {
    cancelled = await agentTasks.cancelOwner(sessionId || undefined);
  } finally {
    // 取り消しで止まった子は stopChild が読み終えている。残りは止まらなかった子（付けない）
    for (const id of children) if (taskStopReasons.get(id) === why) taskStopReasons.delete(id);
  }
  const ownTask = sessionId ? agentTasks.list().find(r => r.sessionId === sessionId) : null;
  // 子の会話を直接止めたときは、その委譲タスクも取り消す（終わっていれば止めるものは無く、届いていない結果は依頼元へ届く）
  const own = ownTask ? await agentTasks.cancel(ownTask.taskId) : null;
  // 取り消した委譲タスクと、終わっていたのに完了通知が届いていなかったタスクを、依頼元の会話ごとに残す（次のターンで伝える）
  await recordTaskStops([...cancelled, ...(own ? [own] : [])], why);
  for (const id of paused) await outbox.pause(id);
  return { aborted: targets.length, reason: why };
}

/** 送信待ちの ids がどれも queued / sending でなくなるまで待つ（始まった・失敗した・取り消した）。ms で諦める */
function outboxSettled(sessionId, ids, ms = 120000) {
  const wanted = new Set(ids);
  return new Promise(resolve => {
    let set = outboxWatchers.get(sessionId);
    if (!set) outboxWatchers.set(sessionId, set = new Set());
    const done = () => {
      clearTimeout(timer);
      set.delete(check);
      if (!set.size && outboxWatchers.get(sessionId) === set) outboxWatchers.delete(sessionId);
      resolve();
    };
    const check = messages => {
      if (!messages.some(m => wanted.has(m.id) && (m.status === 'queued' || m.status === 'sending'))) done();
    };
    const timer = setTimeout(done, ms);
    timer.unref?.();
    set.add(check);
    outbox.list(sessionId).then(check, done);
  });
}

// 再開を受け付けている最中の会話（二度押し・別の端末からの再開で二重に送らない）。
// 送った項目が送信待ち・送信中を出る（ターンが始まる・失敗する）まで保つ。始まれば sessionBusy が引き継ぐ
const resuming = new Set();
const resumeRunning = () => Object.assign(new Error(t('resume.running')), { code: 'SESSION_RUNNING' });
/**
 * 中断した会話を続ける。人が「再開」を押したときだけ呼ばれる（勝手には再開しない）。
 * 保留（paused）の未送信があれば、それを並びのまま送り直す（1 件ずつの「再送する」と同じ経路。「続けて」は送らない）。
 * 先頭が送れなかった（failed。エージェントに渡っていない）ものなら、それも一緒に送り直す。
 * 先頭が結果不明（unknown）なら断る（届いているかもしれないので、人が一覧で再送か取り消しを選ぶ）。
 * 保留の後ろで止まっていた送信待ち（中断中に送った指示）は、保留を戻せば続いて送られる。
 * 送り直すものが無ければ理由ごとの文を、普通の送信（sendMessage と同じ送信待ち）で送る。文は会話の言語で、見える発言になる。
 * 実行中（準備中・切り替え・分岐を含む。先頭が送信待ち・送信中も）の会話と、中断していない会話は断る
 */
async function resumeSession(sessionId) {
  if (!sessionId || typeof sessionId !== 'string' || !refuseRetired(await resolveBackendForSession(sessionId))) throw new Error(t('session.notFound'));
  if (resuming.has(sessionId) || sessionBusy(sessionId)) throw resumeRunning();
  const oldLimit = limitStates.get(sessionId);
  if (oldLimit) {
    const selected = await store.get(sessionId);
    const currentAccount = selected.nextSettings?.account ?? selected.claudeAccount ?? '';
    const currentBackend = selected.nextSettings?.backend ?? selected.backend;
    if (currentBackend !== oldLimit.backend || (oldLimit.backend === 'claude' && currentAccount !== (oldLimit.account ?? ''))) {
      limitStates.delete(sessionId);
      await schedule.cancel(`resume:${sessionId}`);
      resumeQueue.remove(sessionId);
    } else if (!oldLimit.resetsAt || oldLimit.resetsAt > Date.now()) {
      throw Object.assign(new Error(t('resume.limitWaiting')), { code: 'LIMIT_WAITING' });
    } else limitStates.delete(sessionId);
  }
  resuming.add(sessionId);
  let sent = null;
  try {
    const items = await outbox.list(sessionId);
    // 一覧は送信待ちの処理（kick）の後ろに並ぶので、読み終えた時点でもう始まっているかもしれない。読んだ後に確かめ直す
    if (sessionBusy(sessionId)) throw resumeRunning();
    const entry = await store.get(sessionId);
    const interrupted = interruptedOf(entry.interrupted);
    if (!interrupted) throw Object.assign(new Error(t('resume.notInterrupted')), { code: 'NOT_INTERRUPTED' });
    const open = items.filter(m => !['sent', 'cancelled'].includes(m.status));
    // 送信中、または先頭が送信待ち（すぐ送られる）なら、もう続きを送っている（再開の二度押し・別の端末から）。
    // 中断の後に送った（受け付けた）ものが既に渡っていても同じ（ターンの開始で中断の印が消えるまでの間）
    if (open.some(m => m.status === 'sending') || (open[0]?.status === 'queued' && !oldLimit)
      || items.some(m => m.status === 'sent' && Date.parse(m.at) > interrupted.at)) throw resumeRunning();
    if (open.some(m => m.status === 'unknown')) throw Object.assign(new Error(t('resume.outboxUnknown')), { code: 'OUTBOX_UNKNOWN' });
    if (open[0]?.status === 'queued' && oldLimit) {
      sent = open.filter(m => m.status === 'queued').map(m => m.id);
      outbox.kick(sessionId).catch(() => {});
      return { sent: 'outbox', count: sent.length };
    }
    const released = await outbox.retryPaused(sessionId, { failed: true });
    if (released.length) {
      sent = released;
      return { sent: 'outbox', count: released.length };
    }
    const lng = agentLocaleOf(entry.agentLocale) ?? currentLocale();
    // i18n-dynamic: resume.prompt.
    const prompt = t(`resume.prompt.${interrupted.reason}`, { lng });
    const item = await outbox.accept(sessionId, crypto.randomUUID(), { prompt });
    sent = [item.id];
    return { sent: 'text', count: 1 };
  } finally {
    if (sent) outboxSettled(sessionId, sent).finally(() => resuming.delete(sessionId));
    else resuming.delete(sessionId);
  }
}

async function limitSentAt(sessionId, fallback) {
  const items = await outbox.list(sessionId).catch(() => []);
  return Math.max(fallback, ...items.filter(item => item.status !== 'cancelled')
    .map(item => toMs(item.at)).filter(Number.isFinite));
}

const resumeQueue = createResumeQueue({
  settings: () => limitResumeSettings,
  changed: state => emitGlobal({ type: 'resumeQueue', sessionId: null, state }),
  guarded: row => { void conversationTitleOf(row.sessionId).then(title =>
    pushNotifier.limitGuarded({ sessionId: row.sessionId, title })).catch(() => {}); },
  guard: async row => {
    const backend = getBackend(row.backend);
    if (!backend?.usage) return null;
    const quota = await backend.usage({ cwd: process.cwd(), ...(backend.capabilities?.claudeAccounts ? await usageAccounts() : {}) }).catch(() => null);
    const windows = quota?.accounts ? (quota.accounts.find(a => a.accountId === row.account)?.windows ?? quota.accounts[0]?.windows ?? []) : quota?.windows ?? [];
    const relevant = row.window === 'five_hour' ? windows.filter(w => w.minutes === 300) : windows;
    const used = relevant.map(w => w.usedPercent).filter(Number.isFinite);
    return used.length ? Math.max(...used) : null;
  },
  start: async row => {
    const meta = await store.get(row.sessionId);
    if (meta.interrupted?.reason !== 'limit' || meta.interrupted.at !== row.interruptedAt
      || (meta.claudeAccount ?? '') !== (row.account ?? '')) return resumeQueue.settled(row.sessionId);
    await resumeSession(row.sessionId);
  },
});
const schedule = createSchedule({ file: path.join(store.dataDir, 'schedule.json'),
  changed: entries => emitGlobal({ type: 'schedules', sessionId: null, entries }),
  fire: async row => {
    if (row.kind !== 'resume') throw new Error(`Unsupported schedule kind: ${row.kind}`);
    const meta = await store.get(row.sessionId);
    if (meta.interrupted?.reason !== 'limit' || meta.interrupted.at !== row.createdAt) return;
    if ((meta.claudeAccount ?? '') !== (row.account ?? '')) return;
    if (limitResumeSettings.mode === 'off' && !meta.interrupted.autoResume) return;
    if (meta.interrupted.notifyAtReset) {
      emitGlobal({ type: 'limitResumeReady', sessionId: row.sessionId });
      pushNotifier.limitReady({ sessionId: row.sessionId, title: await conversationTitleOf(row.sessionId) });
      return;
    }
    resumeQueue.enqueue({ sessionId: row.sessionId, interruptedAt: row.createdAt,
      backend: meta.backend, account: row.account, window: meta.interrupted.window,
      sentAt: await limitSentAt(row.sessionId, meta.interrupted.sentAt ?? row.createdAt),
      priority: row.priority ?? (meta.delegation ? 1 : 0) });
  },
});

wss.on("connection", (ws, req) => {
  // OS の操作（revealPath / openPath）を許すのは、サーバーのある PC の画面からの接続だけ（core/os-open.mjs）
  const local = isLocalRequest(req);
  // 中継越しの端末の画面（接続口が付ける x-pleiad-device）。見ている印と通知鍵の登録はこの端末のものとして扱う
  const via = local ? null : remote.deviceInfo(req.headers['x-pleiad-device']);
  if (via) connectionDevices.set(ws, via);
  // 古い接続を閉じてはいけない。クライアントは切れると自動再接続するので、
  // 「新しい方に付け替える」と互いに閉じ合って永久に落ち着かなくなる。
  // タブが複数あってもよい設計にして、イベントは全部に配る（流れの出来事だけは開いている会話の分。sendTo）。
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
    startedAt: SERVER_STARTED_AT,
    // 離れた端末への通知（ADR 0086）を受けられる。古いホストにはこの欄が無く、端末は鍵の登録を送らない
    notify: 1,
    // 画面の言語。setting は設定値（auto|ja|en）、lang は実際に使う言語（ja|en）
    locale,
  }));
  ws.on("close", () => {
    detach(ws);
    notifyPresence.clear(ws);
    // 見ていた PC のブラウザーは、見る端末がいなくなれば止める
    const viewer = screencastClients.get(ws);
    if (viewer) screencastHub?.forget(viewer);
  });

  ws.on("message", async (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg?.kind !== P.COMMAND || !P.COMMANDS.has(msg.command)) return;

    // Command IDs are scoped to a socket. Broadcast events, never private replies
    // (connection-check receipts and concurrent clients can share the same ID).
    // code: 失敗の種類。画面は文言（言語で変わる）ではなくこれで見分ける
    // extra: 失敗に添える機械が読む欄（invoke の issues）
    const reply = (ok, payload, code, extra) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ kind: P.RESPONSE, id: msg.id ?? null, ok, ...(ok ? { result: payload } : { error: payload, ...(code ? { code } : {}), ...extra }) }));
    };
    // 操作の一覧（core/ops/）へ移したコマンド: 画面（human）として op を呼ぶ。then は成功の返り値を画面の形に直す（無ければそのまま）
    const viaOp = async (id, then = (result) => result) => {
      const r = await opsRegistry.invoke({ by: 'human', via: 'ui', local }, id, msg.args, opsDeps(locale.lang));
      return r.ok ? reply(true, await then(r.result)) : reply(false, r.error, r.code);
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
            startedAt: saved.policy?.at ?? null, refreshedAt: saved.policy?.refreshedAt ?? null, removedMcp: saved.policy?.removedMcp ?? [], added: saved.added ?? [],
            plyParts: saved.plyParts ?? null });
        }
        case 'plyInstructions':
          return reply(true, plyInstructionsState());
        case 'setPlyInstructions': {
          await applyPlyInstructions(changePlyInstructions(plyInstructionsCache, msg.args, currentLocale()));
          settingsChanged(['plyInstructions']);
          return reply(true, plyInstructionsState());
        }
        case 'refreshContext':
          await contextSession.refresh(msg.args?.sessionId);
          return reply(true, { ok: true });
        case 'contextDiff':
          return reply(true, await contextSession.diff(msg.args?.sessionId));
        // ---- git の動き（読み取りだけ。ADR 0085）。作業場所は会話の cwd。git が無い・git 管理外は git: null
        case 'gitStatus': {
          const cwd = await gitCwd(msg.args);
          if (!cwd) return reply(true, { git: null });
          return reply(true, { git: msg.args?.summary ? await gitActivity.summary(cwd, msg.args?.sessionId) : await gitActivity.status(cwd, { fresh: msg.args?.fresh === true }) });
        }
        case 'gitPanel': {
          const sessionId = msg.args?.sessionId;
          const cwd = await gitCwd(msg.args);
          const state = cwd ? await gitActivity.status(cwd, { fresh: true }) : null;
          if (!state) return reply(true, { git: null });
          // 分けた作業場所（ADR 0089）: 今いる場所と、残っているもの（未取り込み）。開いたときに片付けられるものを片付ける
          worktreeSweepSoon();
          const worktrees = { current: await worktreeHost.worktrees.byPath(cwd).then(e => (e ? publicWorktree(e) : null)).catch(() => null), leftovers: await worktreeHost.leftovers({ cwd }).catch(() => []) };
          const backend = sessionId ? await resolveBackendForSession(sessionId) : null;
          const timeline = sessionId ? timelineOf((await history.loadTranscript(sessionId, backend).catch(() => ({ messages: [] }))).messages) : [];
          const changes = await gitActivity.changes(cwd, sessionId, msg.args?.range === 'session' ? 'session' : 'uncommitted');
          return reply(true, { git: state, timeline, changes, worktrees, at: Date.now() });
        }
        case 'gitDiff': {
          const cwd = await gitCwd(msg.args);
          return reply(true, { diff: cwd ? await gitActivity.diff(cwd, msg.args?.sessionId, msg.args?.range === 'session' ? 'session' : 'uncommitted', String(msg.args?.path ?? '')) : null });
        }
        // ---- 分けた作業場所（ADR 0089）。ぶつかりの確認・分ける・片付けの操作・「いつも分ける」の設定
        case 'worktreeCheck': {
          const sessionId = typeof msg.args?.sessionId === 'string' && msg.args.sessionId ? msg.args.sessionId : null;
          const cwd = await worktreeCwd(msg.args);
          const always = (await worktreeHost.worktrees.getSettings()).always;
          if (!cwd) return reply(true, { git: false, current: null, conflicts: [], canSplit: false, always });
          return reply(true, await worktreeHost.check({ sessionId, cwd, writes: await sessionWrites(sessionId, msg.args?.backend, msg.args?.mode) }));
        }
        // 分ける・片付ける・残す・退避・元に戻す・いつも分けるは worktrees.*（core/ops/worktrees.mjs。AI も同じ操作を呼ぶ。ADR 0094）
        case 'worktreeSplit':
          return viaOp('worktrees.split');
        case 'worktreeDiscard':
          return viaOp('worktrees.discard');
        case 'worktreeKeep':
          return viaOp('worktrees.keep');
        case 'worktreeArchive':
          return viaOp('worktrees.archive');
        case 'worktreeRestore':
          return viaOp('worktrees.restore');
        case 'worktreeSettings':
          return reply(true, await worktreeHost.worktrees.getSettings());
        case 'setWorktreeSettings':
          if (typeof msg.args?.always !== 'boolean') throw new Error(t('worktree.settingsInvalid'));
          return viaOp('worktrees.setSettings');
        case 'setSessionMcp':
          await contextSession.setMcp(msg.args?.sessionId, msg.args?.name, msg.args?.removed !== false);
          return reply(true, { ok: true });
        case 'agentMcp':
          return reply(true, await contextSession.agentMcp((await contextSettings.get(msg.args?.cwd ?? process.cwd())).cwd));
        case 'nativeInstructions':
          return reply(true, await contextSession.nativeInstructions((await contextSettings.get(msg.args?.cwd ?? process.cwd())).cwd, msg.args?.backend));
        case 'contextFindings':
          return reply(true, await contextSession.findings(msg.args?.sessionId, (await contextSettings.get(msg.args?.cwd ?? process.cwd())).cwd, msg.args?.backend));
        case 'setContextSettings': {
          const view = await contextSettings.set(msg.args ?? {});
          settingsChanged(['context.default']);
          return reply(true, view);
        }
        // ---- Hooks（各エージェントの元の設定ファイル。core/hooks-config.mjs）。コマンドは実行しない
        case 'scanHooks': {
          const cwd = msg.args?.cwd ? await scanDirectory(msg.args.cwd) : null;
          const report = await hooksConfig.scan({ cwd, scopes: cwd && msg.args?.scope !== 'user' ? ['user', 'directory'] : ['user'] });
          return reply(true, await withCodexTrust(report, cwd ?? os.homedir(), { trust: msg.args?.trust === true }));
        }
        case 'readHook':
          return viaOp('hooks.read');
        case 'hookTargets':
          return reply(true, await hooksConfig.targets(msg.args ?? {}));
        case 'saveHooks':
          return reply(true, await hooksConfig.save(msg.args ?? {}));
        case 'copyHooks':
          return reply(true, await hooksConfig.copy(msg.args ?? {}));
        case 'sessionHooks': {
          // 会話の右パネル: その会話の場所で見つかった定義（読み込まれたかは分からない）と、受け取った発火の記録。
          // Hooks を Pleiad がそろえた会話は、そのターンの記録（渡した登録・止めたネイティブ・渡せなかったもの・漏れ）も返す（unify）
          const id = msg.args?.sessionId ?? null;
          const agent = HOOK_AGENTS.includes(msg.args?.backend) ? msg.args.backend : null;
          const cwd = msg.args?.cwd ? await scanDirectory(msg.args.cwd).catch(() => null) : null;
          const report = agent && cwd ? await hooksConfig.scan({ cwd, agents: [agent] }) : null;
          if (report && agent === 'codex') await withCodexTrust(report, cwd, { trust: msg.args?.trust === true });
          const saved = id ? await store.get(id).catch(() => ({})) : {};
          const live = id ? runtime.turns.get(id) : null;
          const unify = live?.contextRecord?.hooks ?? saved.contextSession?.hooks ?? null;
          const owner = cwd ? (await plyHooks.resolve(cwd).catch(() => null))?.owner ?? 'native' : 'native';
          // 発火を受け取れる接続: Claude（通知・コールバック）、Codex（hook/started・hook/completed）、Antigravity は Pleiad が渡した分だけ（アダプターの記録）
          const observable = agent === 'claude' || agent === 'codex' ? 'all' : agent === 'antigravity' && unify?.owner === 'ply' ? 'pleiad' : null;
          return reply(true, { agent, cwd, report, observable: Boolean(observable), observed: observable, owner, unify, runs: trimHookRuns([...(saved.hookRuns ?? []), ...(live?.hookRuns ?? [])]) });
        }
        // ---- Pleiad の Hooks の登録と担当（<data>/hooks.json。core/ply-hooks.mjs、ADR 0049）。エージェントの設定ファイルは書かない
        case 'plyHooks':
          return reply(true, await plyHooks.view(msg.args?.cwd ?? null));
        case 'readPlyHook':
          return viaOp('hooks.readPly');
        case 'savePlyHook':
          return reply(true, await plyHooks.save(msg.args?.value ?? {}, { cwd: msg.args?.cwd ?? null }));
        case 'removePlyHook':
          return reply(true, await plyHooks.remove(msg.args?.id, { cwd: msg.args?.cwd ?? null }));
        case 'togglePlyHook':
          return reply(true, await plyHooks.toggle(msg.args?.id, msg.args?.enabled !== false, { cwd: msg.args?.cwd ?? null }));
        case 'plyHookPreview': {
          // 追加・編集のシートの確認: エージェントごとの渡し方（イベント・matcher・アダプター・渡せない理由）。保存はしない
          const value = msg.args?.value ?? {};
          const hook = { ...value, targets: Array.isArray(value.targets) ? value.targets : [], matcher: value.matcher ?? '' };
          return reply(true, { targets: Object.fromEntries(HOOK_AGENTS.map(a => { const d = hook.targets.includes(a) ? deliverable(hook, a) : null;
            return [a, d ? { status: d.status, reasons: d.reasons, warnings: d.warnings ?? [], event: d.event, matcher: d.matcher, adapter: d.adapter } : null]; })) });
        }
        case 'hooksUnifyPreview':
          return reply(true, await hooksUnifyPreview({ cwd: msg.args?.cwd ?? null, direction: msg.args?.direction === 'native' ? 'native' : 'ply' }));
        case 'setHooksOwner': {
          // 担当と取り込みを 1 回で保存する。取り込む定義はサーバーがファイルから読み直す（画面から来たコマンドは使わない）
          // 確認票: 確認の面で見た版（revision）と、取り込む行ごとの元の定義の hash（digest）。どちらかが変わっていれば保存しない（確認し直す）
          const place = msg.args?.place ?? null;
          if (typeof msg.args?.revision !== 'string') throw new Error(t('hooksUnify.reviewRequired'));
          const wanted = Array.isArray(msg.args?.imports) ? msg.args.imports : [];
          if (wanted.length > 100 || wanted.some(x => typeof x?.id !== 'string' || typeof x?.digest !== 'string')) throw new Error(t('hooksUnify.importFailed'));
          const imports = [...new Map(wanted.map(x => [x.id, x])).values()];
          const dir = place ? await scanDirectory(place) : null;
          const { raws } = imports.length ? await nativeRaws(dir, imports.map(x => x.id)) : { raws: [] };
          const add = [];
          for (const want of imports) {
            const raw = raws.find(r => r.row.id === want.id);
            const c = raw ? importCandidate(raw) : null;
            if (!c?.importable) throw new Error(t('hooksUnify.importFailed'));
            if (c.digest !== want.digest) throw new Error(t('hooksUnify.importChanged'));
            add.push(c.value);
          }
          return reply(true, await plyHooks.setOwner({ place, value: msg.args?.value ?? null, add, cwd: msg.args?.cwd ?? place, expect: msg.args.revision }));
        }
        case 'repairPlyHooks': {
          // 壊れた hooks.json を退避して、読めた部分だけで書き直す（画面で影響を知らせてから押させる）
          return reply(true, await plyHooks.repair({ cwd: msg.args?.cwd ?? null }));
        }
        case 'scanContext': {
          // One scan at a time per connection; no changes to running turns.
          // place: 'default' なら場所ごとの上書きを使わず既定だけで探す（設定の「すべての場所」）
          if (ws.contextScanning) throw Object.assign(new Error(t('scan.busy')), { code: 'SCAN_BUSY' });
          ws.contextScanning = true;
          // scope: 'user' ならユーザーの範囲（home と足した場所）だけ（設定の画面のユーザーの段。作業場所のファイルを混ぜない）
          try { return reply(true, await scanContext(await contextSettings.get(msg.args?.cwd ?? process.cwd(), { level: msg.args?.place === 'default' ? 'default' : null }),
            { plyServers: await plyMcp.scanInput(), ...(msg.args?.scope === 'user' ? { scopes: ['user'] } : {}) })); }
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

        // 通知（ADR 0086）。この PC の設定とスマホの一覧は設定 › 通知。スマホの通知鍵と設定の登録は、端末の画面（中継越し）からだけ
        case 'notifyStatus':
          return reply(true, await notifyStatus());
        // この PC の通知・スマホごとの切り替えは notify.*（AI も同じ操作を呼ぶ。ADR 0094）。画面には設定 › 通知の材料を返す
        case 'setNotifyPc':
          return viaOp('notify.setPc', () => notifyStatus());
        case 'setNotifyDevice':
          return viaOp('notify.setDevice', () => notifyStatus());
        case 'notifyRegister': {
          const via = connectionDevices.get(ws);
          if (!via?.mobile) throw new Error(t('notify.error.notDevice'));
          const registered = await remote.registerNotify(via.id, msg.args ?? {});
          emitGlobal({ type: 'notifyStatus', status: await notifyStatus(), sessionId: null });
          return reply(true, registered);
        }
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
        // 保存済みの接続先の確認し直しと削除は compatEndpoints.*（キーを入力しない。AI も同じ操作を呼ぶ。ADR 0094）
        case 'compatEndpointRecheck':
          return viaOp('compatEndpoints.recheck');
        case 'compatEndpointDelete':
          return viaOp('compatEndpoints.delete', () => compatEndpoints.list());
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
            if (current.interrupted?.reason === 'limit'
              && ((account !== undefined && accountChanged) || (!cancel && next?.backend && next.backend !== source.id))) {
              await schedule.cancel(`resume:${sessionId}`);
              resumeQueue.remove(sessionId);
              const interrupted = { ...current.interrupted, autoResume: false, notifyAtReset: false };
              await store.setMeta(sessionId, { interrupted });
              limitStates.set(sessionId, interruptedOf(interrupted));
              emitGlobal({ type: 'limitResumeChanged', sessionId, interrupted });
            }
            // 取り消した・別の場所に替えた予約が分けた作業場所なら、使っていなければ片付ける（ADR 0089）
            if (current.nextSettings?.cwd && current.nextSettings.cwd !== next?.cwd) settleWorktreeAt(current.nextSettings.cwd).catch(() => {});
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
          const { sessionId, text = "", attached = [], version } = msg.args ?? {};
          if (!sessionId || !(await resolveBackendForSession(sessionId))) throw new Error(t('session.notFound'));
          if (typeof text !== "string" || text.length > 2_000_000 || !Array.isArray(attached)) throw new Error(t('session.draftTooLarge'));
          // 件数の上限は無い（添付の上限は 1 件 100MB だけ。docs/design-system.md「入力欄」）。from は札の出どころの印（ホスト / この端末）
          const files = attached.map(a => ({ name: String(a.name ?? ""), path: String(a.path ?? ""), kind: String(a.kind ?? "file"), mime: String(a.mime ?? ""),
            ...(a?.from === "host" || a?.from === "device" ? { from: a.from } : {}),
            // size: 一覧の面に出す大きさ（分かるときだけ）
            ...(Number.isFinite(a?.size) && a.size >= 0 ? { size: a.size } : {}) }));
          if (files.some(a => a.path.length > 8192 || a.name.length > 4096)) throw new Error(t('session.attachmentInfoTooLarge'));
          // version: 2 = text が文中の添付の印（[添付] パス）を含む Markdown（位置が残る。ADR 0060）。無い下書きは印が無く、添付は文末に付く
          await store.setSessionData(sessionId, "draft", { text, attached: files, ...(Number.isInteger(version) ? { version } : {}) });
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
            compactionScheduler.cancel(sessionId);
            queuedCompactions.delete(sessionId);
            shellRuns.stopSession(sessionId);
            await deleteUnsentConversation(sessionId);
            await store.removeSession(sessionId);
            releaseAgentConnection(sessionId);
            settleWorktreesOf(sessionId).catch(() => {});
            emitGlobal({ type: "sessionsChanged", sessionId: null, deleted: sessionId });
            return reply(true, "deleted");
          } finally { switching.delete(sessionId); completionNotices.changed(sessionId); }
        }

        case "switchBackend": {
          const { sessionId, backend: targetId } = msg.args ?? {};
          if (!sessionId) return reply(false, t('session.required'));
          if (runtime.turns.has(sessionId) || switching.has(sessionId) || forking.has(sessionId)) return reply(false, t('session.finishBeforeSwitch'));
          compactionScheduler.cancel(sessionId);
          switching.add(sessionId);
          try {
            const source = refuseRetired(await resolveBackendForSession(sessionId));
            const target = getBackend(targetId);
            if (!source || !target) throw new Error(t('agents.notFound'));
            await switchBackend(sessionId, source, target);
            if (source.id !== target.id) {
              const stopped = (await store.get(sessionId)).interrupted;
              if (stopped?.reason === 'limit') {
                await schedule.cancel(`resume:${sessionId}`);
                resumeQueue.remove(sessionId);
                const interrupted = { ...stopped, autoResume: false, notifyAtReset: false };
                await store.setMeta(sessionId, { interrupted });
                limitStates.set(sessionId, interruptedOf(interrupted));
                emitGlobal({ type: 'limitResumeChanged', sessionId, interrupted });
              }
            }
            // 入力欄の `!`: 走っている分は止め、渡していない分は捨てる（前のエージェントの形でしか渡せない。ADR 0054）
            if (source.id !== target.id) await shellRuns.switched(sessionId, source, target);
            // 接続先はエージェントごとの形式なので、エージェントが変わったら変えた先の既定（「既定にする」を押したもの。無ければ公式）に置き直す
            if (source.id !== target.id) await store.setSessionData(sessionId, 'compatEndpoint', endpointCapable(target) ? await compatEndpoints.defaultFor(target.id) : '');
            await savePref("backend", target.id);
            emitGlobal({ type: "backend", sessionId, backend: target.id });
            return reply(true, { sessionId, backend: target.id });
          } finally { switching.delete(sessionId); completionNotices.changed(sessionId); }
        }

        case "runTurn":
          await runTurn(msg.args ?? {}, () => reply(true, "started"));
          return;
        case 'sendMessage': {
          const { sessionId, messageId, prompt, attachments, cwd, mode, rewind } = msg.args ?? {};
          if (!sessionId || !refuseRetired(await resolveBackendForSession(sessionId))) throw new Error(t('session.notFound'));
          if (typeof messageId !== 'string' || !/^[a-zA-Z0-9-]{8,80}$/.test(messageId)) throw new Error(t('send.messageIdRequired'));
          if (typeof prompt !== 'string' || !prompt.trim()) throw new Error(t('send.messageRequired'));
          if (attachments !== undefined && !Array.isArray(attachments)) throw new Error(t('send.invalidAttachments'));
          // 同じ会話の中で、発言の手前まで巻き戻して送り直す（ADR 0091）。{ beforeMessageId, stopRunning? }
          if (rewind !== undefined && (typeof rewind?.beforeMessageId !== 'string' || !rewind.beforeMessageId)) throw new Error(t('rewind.invalid'));
          compactionScheduler.cancel(sessionId);
          const args = { prompt, ...(attachments ? { attachments } : {}), ...(cwd ? { cwd } : {}), ...(mode ? { mode } : {}) };
          if (rewind) {
            // 受け付け済みの再送（応答が届かず送り直した同じ messageId）は、巻き戻し直さない（もう巻き戻してある）
            if ((await outbox.list(sessionId)).some(m => m.id === messageId)) return reply(true, await outbox.accept(sessionId, messageId, args));
            const rewound = await rewindConversation({ sessionId, beforeMessageId: rewind.beforeMessageId, stopRunning: rewind.stopRunning === true });
            return reply(true, { ...(await outbox.accept(sessionId, messageId, args)), rewind: rewound });
          }
          // 中断した会話に新しい指示を送ったら、中断で保留になった未送信を先に並びのまま送り直す（再開と同じ）。
          // 戻さないと新しい指示は保留の後ろで順番を待ち続ける。画面は「保留中の N 件の後にこの指示で続けます」と出している
          if (!sessionBusy(sessionId) && interruptedOf((await store.get(sessionId)).interrupted)?.reason !== 'limit'
            && (await outbox.list(sessionId)).some(m => m.status === 'paused')) await outbox.retryPaused(sessionId);
          return reply(true, await outbox.accept(sessionId, messageId, args));
        }
        // 入力欄の `!`（シェルの行。ADR 0054）。人の操作なので承認モードは掛けない。送信待ちにも送り直しの控えにも積まない
        case 'runShell': {
          const { sessionId, runId, command } = msg.args ?? {};
          const backend = sessionId ? refuseRetired(await resolveBackendForSession(sessionId)) : null;
          if (!backend) throw new Error(t('session.notFound'));
          if (!shellMode(backend)) throw Object.assign(new Error(t('shell.unavailable')), { code: 'SHELL_UNAVAILABLE' });
          const sidecar = await store.get(sessionId);
          // 次の送信でエージェントが替わる予約がある。渡す先がホストで走らせる形でなければ走らせない（渡せないまま残るため）
          const reservedId = sidecar.nextSettings?.backend;
          if (reservedId && reservedId !== backend.id && !(shellMode(backend) === 'host' && shellMode(getBackend(reservedId)) === 'host')) throw Object.assign(new Error(t('shell.unavailable')), { code: 'SHELL_UNAVAILABLE' });
          // Codex はスレッドができてから（最初の発言の後）
          if (shellMode(backend) === 'native' && !(await backend.shellReady?.(sessionId) ?? true)) throw Object.assign(new Error(t('shell.notStarted')), { code: 'SHELL_NOT_STARTED' });
          // Codex はターンの間（始める準備の間も）に走らせない。`!` がそのターンに入り、発言にモデルが返答しないまま閉じる（codex-cli 0.156.1 で確認）
          if (shellMode(backend) === 'native' && sessionBusy(sessionId)) throw Object.assign(new Error(t('shell.busy')), { code: 'SHELL_BUSY' });
          // 送信済みの会話は会話の作業ディレクトリ。まだ送っていない会話は入力欄で選んでいる場所
          const cwd = !sidecar.unsent && sidecar.cwd ? sidecar.cwd : typeof msg.args?.cwd === 'string' && msg.args.cwd.trim() ? msg.args.cwd.trim() : sidecar.cwd;
          if (!cwd || !(await fs.stat(cwd).then(st => st.isDirectory(), () => false))) throw Object.assign(new Error(t('shell.noCwd')), { code: 'SHELL_NO_CWD' });
          return reply(true, await shellRuns.start({ sessionId, runId, command, cwd, backend }));
        }
        case 'stopShell':
          return reply(true, { stopped: shellRuns.stop(msg.args?.runId) });
        // 行ごとの「渡さない」（ADR 0055）。ホストで走らせる会話だけ。Codex は結果がエージェントの会話に入っていて外せない
        case 'skipShell': {
          const { sessionId, runId, skip } = msg.args ?? {};
          const backend = sessionId ? await resolveBackendForSession(sessionId) : null;
          if (!backend) throw new Error(t('session.notFound'));
          try {
            return reply(true, await shellRuns.setSkip({ sessionId, runId, skip: Boolean(skip), backend }));
          } catch (e) {
            if (e?.code === 'SHELL_UNAVAILABLE') throw Object.assign(new Error(t('shell.skipUnavailable')), { code: e.code });
            if (e?.code === 'SHELL_HANDING') throw Object.assign(new Error(t('shell.handing')), { code: e.code });
            if (e?.code === 'SHELL_HANDED') throw Object.assign(new Error(t('shell.alreadyHanded')), { code: e.code });
            throw e;
          }
        }
        case 'compactConversation': {
          const sessionId = msg.args?.sessionId;
          compactionScheduler.cancel(sessionId);
          const backend = sessionId ? await resolveBackendForSession(sessionId) : null;
          if (!backend) throw new Error(t('session.notFound'));
          if (!backend.capabilities?.compact) throw new Error(t('compaction.unsupported'));
          const queued = sessionBusy(sessionId);
          void compactConversation(sessionId).catch(err => compactionStartFailed(sessionId, 'manual', err));
          return reply(true, { status: queued ? 'queued' : 'started' });
        }
        case 'cancelCompaction': {
          const sessionId = msg.args?.sessionId;
          compactionScheduler.cancel(sessionId);
          queuedCompactions.delete(sessionId);
          return reply(true, { cancelled: true });
        }
        case 'setConversationAutoCompaction': {
          const sessionId = msg.args?.sessionId;
          const off = msg.args?.off;
          if (typeof off !== 'boolean') throw new Error(t('compaction.invalidSetting'));
          if (!sessionId) throw new Error(t('session.notFound'));
          if (off) compactionScheduler.cancel(sessionId);
          if (!(await resolveBackendForSession(sessionId))) throw new Error(t('session.notFound'));
          await store.setSessionData(sessionId, 'autoCompactionOff', off);
          emitGlobal({ type: 'conversationAutoCompaction', sessionId, off });
          return reply(true, { off });
        }
        case 'messageAction': {
          const { sessionId, messageId, action } = msg.args ?? {};
          await outbox.action(sessionId, messageId, action);
          return reply(true, await outbox.list(sessionId));
        }
        case 'listMessages':
          return reply(true, await outbox.list(msg.args?.sessionId));

        case "abort": {
          // { sessionId?, reason? }。sessionId を省略したら全部止める。reason は user|update|quit（ほかは user）
          const { sessionId, reason } = msg.args ?? {};
          return reply(true, await abortSessions({ sessionId, reason }));
        }

        // 中断した会話を続ける（docs/design.md「中断と再開」）。{ sessionId } -> { sent: "outbox"|"text", count }
        case "resume":
          return reply(true, await resumeSession(msg.args?.sessionId));

        case 'agentTasks': return reply(true, agentTasks.list(msg.args?.sessionId));
        case 'agentTaskInstructions': {
          const result = agentTasks.instructions(msg.args?.taskId);
          if (!result) throw new Error(t('delegation.taskNotFound'));
          return reply(true, result);
        }
        case 'cancelAgentTask': {
          const task = agentTasks.get(msg.args?.taskId);
          if (!task) throw new Error(t('delegation.taskNotFound'));
          await agentTasks.cancel(task.taskId); return reply(true, agentTasks.get(task.taskId));
        }
        // 委譲カードの「別の候補でやり直す」。{ taskId, candidate, stop?, approved? } -> { task } か、承認モードが強くなるときは { confirm }
        case 'retryAgentTask': return reply(true, await retryAgentTask(msg.args ?? {}));

        // 委譲先の自動振り分けの設定（設定 › 委譲）。タスクごとの振り分けの記録は agentTasks の各行の routing。
        // キーは返さない（hasKey だけ）。refresh: true なら使用量を取り直してから返す
        case 'delegationRouting':
          if (msg.args?.refresh && routingSettingsCache.enabled) await routingUsage.refresh();
          return reply(true, await delegationRoutingState());
        // settings は prefs.json の delegationRouting に重ねる項目（null の項目は既定に戻す）。全体を検証してから保存する
        case 'setDelegationRouting': {
          await applyRoutingSettings(msg.args?.settings);
          settingsChanged(['delegationRouting']);
          return reply(true, await delegationRoutingState());
        }
        // 判定器のキー（service: openrouter = Jev / cerebras）。登録が外部送信の同意になる（キーが無ければ何も送らない）
        case 'setDelegationRoutingKey':
        case 'deleteDelegationRoutingKey': {
          const service = String(msg.args?.service ?? '');
          if (!ROUTING_SERVICES.includes(service)) throw new Error(t('routing.key.unknownService', { service }));
          if (msg.command === 'deleteDelegationRoutingKey') await compatSecrets.delete(ROUTING_SECRET_PREFIX + service);
          else {
            const key = normalizeKey(msg.args?.key);
            if (!key) throw new Error(t('routing.key.invalid'));
            await compatSecrets.set(ROUTING_SECRET_PREFIX + service, { key });
          }
          emitGlobal({ type: 'delegationRoutingChanged', change: 'settings', sessionId: null });
          return reply(true, await delegationRoutingState());
        }
        case "resolvePermission": {
          const { id, allow, always, scope, message, messageKey, answers, annotations, response, receipt } = msg.args ?? {};
          const w = runtime.waiting.get(id);
          if (!w) return reply(false, t('approval.alreadyResolved'));
          // 設定の変更の承認は受領証つき。画面は出したカードの受領証を添えて答える。合わなければ別の変更への答えなので受け取らない（取り違え・再送を防ぐ）
          if (w.payload.settingChange && w.payload.settingChange.receipt !== receipt) return reply(false, t('approval.receiptMismatch'), 'RECEIPT_MISMATCH');
          // 回答を伴うツール（質問カード）は、承認ではなく入力の差し替えとして返る。
          // ここでは解釈しない。エージェントが自分の形へ戻す（§2.2）。
          // 拒否の理由は画面の言語ではなく会話の言語でエージェントへ返すので、画面は文ではなく印（messageKey: 'userDenied'）で送る。
          // 文（message）で来たら従来どおりそのまま渡す
          // scope（once / session / always）は ply_computer の承認が使う。無ければ always の真偽から読む（今の画面との互換）
          const answeredScope = ['once', 'session', 'always'].includes(scope) ? scope : always ? 'always' : 'once';
          w.settle({
            allow: !!allow,
            always: !!always || answeredScope === 'always',
            scope: answeredScope,
            message: message ?? null,
            ...(!allow && !message && messageKey === 'userDenied' ? { messageKey } : {}),
            answers: answers ?? null,
            annotations: annotations ?? null,
            response: response ?? null,
          });
          return reply(true, "ok");
        }

        // 開いている会話を登録し直す（読み直しは要らないとき。loadSession の watch と同じ）
        case "watchSession": {
          const { sessionId } = msg.args ?? {};
          if (sessionId) watching.set(ws, sessionId); else watching.delete(ws);
          return reply(true, "ok");
        }

        // 各画面が「いま見ている会話」を知らせる（可視でその会話を開いているときだけ）。スマホへの通知を送らない・消すために使う（ADR 0086）。
        // 画面は変わるたびと 1 分ごとに送り直す（一定時間更新が無い印は捨てる）
        case 'presence': {
          const a = msg.args ?? {};
          const via = connectionDevices.get(ws);
          notifyPresence.set(ws, { deviceId: via?.id ?? null, platform: via?.platform ?? null, visible: a.visible === true, sessionId: a.sessionId });
          if (a.visible === true && typeof a.sessionId === 'string' && a.sessionId) pushNotifier.viewed(a.sessionId);
          return reply(true, 'ok');
        }

        // 履歴を読み直す。sessionId が無いときは空（新規セッション相当）。
        case "loadSession": {
          const { sessionId } = msg.args ?? {};
          // watch: この接続がいま開いている会話（sendTo の watching）。読み出しを待つ前に決める。
          // 以後の流れはこの会話の分だけが届き、読み出しの間に来た分は streamCursor で重複を除く
          if (msg.args?.watch) {
            if (sessionId) watching.set(ws, sessionId); else watching.delete(ws);
          }
          if (!sessionId) return reply(true, { messages: [], presents: [] });
          // Hold the reference even if the turn ends during the asynchronous reads.
          const read = { sessionId, turn: runtime.turns.get(sessionId) };
          if (msg.args?.live) liveReads.add(read);
          try {
            const backend = await resolveBackendForSession(sessionId);
            const retired = backend?.retired ? { retired: backend.retired } : {};
            // A later completion cannot be acknowledged by an older history snapshot.
            const sidecar = await store.get(sessionId);
            const completedAt = sidecar.completedAt ?? null;
            // 中断の印（一覧の行と同じ形）。会話の末尾の「中断しました」を保存された状態から描くため
            const interrupted = runtime.turns.has(sessionId) ? null : interruptedOf((await store.get(sessionId)).interrupted);
            const readStarted = Date.now();
            const { compactSummaries, ...data } = await history.loadTranscript(sessionId, backend);
            // 読んだ履歴をそのまま検索の写しにも入れる（追加の読み込みは要らない）。outline は本文が縮めてあるので入れない
            if (!msg.args?.outline) sessionSearch.ingest(sessionId, data.messages, { sig: readStarted });
            // 入力欄の `!`: Pleiad が走らせた分の終了コードを付け、まだ渡していない分・走っている分を末尾に足す（ADR 0054）。
            // 渡さなかった分は、次の人の発言の前に差す（ADR 0055）
            data.messages = msg.args?.outline ? shellRuns.decorate(data.messages, sidecar, backend)
              : [...shellRuns.placeKept(shellRuns.decorate(data.messages, sidecar, backend), sidecar), ...shellRuns.rows(sessionId, sidecar)];
            // 系譜の照合（web/branches.mjs）は uuid・役割・本文・ツール名しか見ない。
            // ツール結果や提示まで載せると、家族を開くたびに数十MBが流れて画面が止まる
            if (msg.args?.outline) return reply(true, { messages: data.messages.map(m => ({
              uuid: m.uuid, role: m.role, text: m.text, tools: m.tools,
              ...(m.toolCalls ? { toolCalls: m.toolCalls.map(call => ({ name: call.name })) } : {}),
            })) });
            const draft = (await store.get(sessionId)).draft ?? null;
            const nativeCompactions = backend.getCompactions ? await backend.getCompactions(sessionId).catch(() => []) : [];
            const savedCompactions = sidecar.compactions ?? [];
            // 圧縮の要約は発言として出さず、区切りの「要約を表示」に入れる（ADR 0053）
            const compactions = attachCompactSummaries(compactSummaries, mergeCompactionHistory(nativeCompactions, savedCompactions));
            const compactionData = { compactions, contextWindow: read.turn?.contextWindow ?? sidecar.contextWindow ?? null,
              compactionAt: compactionScheduler.get(sessionId), autoCompactionOff: Boolean(sidecar.autoCompactionOff) };
            // from・check（web/history-sync.mjs）を付けて頼まれたら、持っている先頭が合うときだけ続きを返す（ADR 0062）。合わなければ全量
            if (!msg.args?.live) return reply(true, serveFrom({ ...data, completedAt, interrupted, draft, ...compactionData, ...retired }, msg.args));
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
              return reply(true, serveFrom({
                messages: [...shellRuns.placeKept([...live.messages, ...(user ? [user] : [])], sidecar), ...shellRuns.rows(sessionId, sidecar)], presents: live.presents, completedAt, interrupted: null, draft, ...compactionData,
                stream: { events: live.events }, streamCursor: streamSequence, permissions,
                initialMessageId: live.initialMessageId,
              }, msg.args));
            }
            return reply(true, serveFrom({ ...data, completedAt, interrupted, draft, ...compactionData, streamCursor: streamSequence, permissions, ...retired }, msg.args));
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
          // draft: 入力欄に入れておく文（「見直しを頼む」。ADR 0056）。作るのと同時に下書きとして保存し、送らない
          const draft = msg.args?.draft;
          if (draft !== undefined && (typeof draft !== "string" || draft.length > 2_000_000)) throw new Error(t('session.draftTooLarge'));
          const now = Date.now();
          // 既定のタイトルは保存しない（空）。画面が今の言語で既定名を出す（web/style.css の .row-t:empty など）。過去の記録には「新しいセッション」が残っている
          const info = { title: "", cwd, tag: status, createdAt: now, lastModified: now };
          const sessionId = await createConversation(backend, info);
          try {
            await store.setMeta(sessionId, { backend: backend.id, ...info, status, unsent: true });
            // 内蔵ブラウザーのプロフィール: 引き継ぎ元があればそのもの、無ければ作業フォルダーで最後に使ったもの / 既定（ADR 0078）
            await store.setSessionData(sessionId, 'browserProfile', await browserProfiles.forNew(cwd, source));
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
            if (draft) await store.setSessionData(sessionId, "draft", { text: draft, attached: [] });
          } catch (e) { await deleteUnsentConversation(sessionId); await store.removeSession(sessionId); releaseAgentConnection(sessionId); throw e; }
          emitGlobal({ type: "sessionsChanged", sessionId: null });
          return reply(true, { sessionId });
        }

        // 既出の状態一覧。事前定義ではなく補完候補（設計メモ §6）。
        case "listStatuses":
          return reply(true, await history.listStatuses(listBackends(), { list: nativeSessions }));

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
          return reply(true, await listDirs(msg.args?.path, { files: msg.args?.files === true }));

        // リモートの端末から PC の内蔵ブラウザーを見る・操作する（docs/inapp-browser.md「リモートから見る」）
        case 'browserScreencast': case 'browserScreencastStop': case 'browserScreencastAck':
        case 'browserScreencastInput': case 'browserScreencastNav': case 'browserScreencastAgent': {
          if (!screencastClients.has(ws)) screencastClients.set(ws, { send: message => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message)); } });
          const answer = await screencastCommand({ command: msg.command, args: msg.args ?? {}, local, hub: screencastHub, bridge: screencastBridge,
            client: screencastClients.get(ws),
            snapshotFile: async ({ sessionId, id, at }) => {
              const record = await history.findVisualization(sessionId, await resolveBackendForSession(sessionId).catch(() => null), { id, at });
              if (!record) return null;
              const file = await writeSnapshotFile(record, path.join(store.dataDir, 'visualization-snapshots'), { prefs: await store.getPrefs() });
              return pathToFileURL(file).href;
            } });
          // i18n-dynamic: server:remoteBrowser.
          return answer.ok ? reply(true, answer.result) : reply(false, t(`remoteBrowser.${answer.code}`), answer.code);
        }

        // ファイルの操作（web/file-actions.mjs）。範囲は /file-preview と同じで、実体を解決した後のパスで確かめる。
        // ホストで開く・検査済みのパスを画面へ返す操作は遠隔から断る。開けるのは HTML だけ
        case "hostCapabilities":
          // hostName は添付の「ホストから <ホスト名>」の見出し（リモートの印の無いブラウザーで使う）
          // pcBrowser: この接続から PC の内蔵ブラウザーを見られるか（デスクトップ版で、リモートの接続のとき）
          return reply(true, { osActions: local, hostName: os.hostname(), pcBrowser: !local && !!screencastBridge?.ready,
            computerUse: computerUseCapability({ hasParentPort: Boolean(computerDriver), platform: computerDriver?.kind === 'fake' ? 'win32' : undefined, ready: computerDriver?.state() ?? null }) });
        // コンピューターの操作を止める（docs/computer-use.md「computerStop」）。ホストの OS を操作する命令ではなく、止める側なので、リモートの端末からも受ける（computer.stop）
        case "computerStop":
          return viaOp('computer.stop');
        case "resolvePath": case "revealPath": case "openPath": {
          const hostAction = msg.command !== 'resolvePath';
          if (hostAction && !local) return reply(false, t('files.remoteOnly'));
          try {
            const sessions = await store.getAll();
            const roots = fileRoots(sessions);
            const args = msg.args ?? {};
            const resolved = await resolveSessionFile({ path: args.path, sessionId: args.sessionId, at: args.at, base: args.base }, sessions, roots);
            // lenient: 在り処だけを知りたい（可視化の元のパス。元のファイルは消えていることがある）。ファイルには触れない
            if (!hostAction && args.lenient === true) return reply(true, { path: resolved.path, cwd: resolved.cwd ?? null });
            const { file, stat } = await inspectFile(resolved.path, fileAccess);
            const directory = stat.isDirectory();
            if (!hostAction) return reply(true, { path: file, cwd: resolved.cwd ?? null, kind: directory ? 'directory' : 'file' });
            if (msg.command === 'openPath' && (directory || !OPENABLE.test(file))) return reply(false, t('files.htmlOnly'));
            if (!osActionAllowed()) return reply(false, t('files.tooMany'));
            if (msg.command !== 'openPath' || args.returnPath !== true) {
              await openOnHost(msg.command === 'openPath' ? 'open' : 'reveal', file, { directory });
            }
            return reply(true, { path: file, cwd: resolved.cwd ?? null });
          } catch (error) {
            const failure = previewFailure(error);
            return reply(false, failure.code === 'read-failed' && error?.message ? error.message : failure.message);
          }
        }

        // 可視化の写しをデータ置き場へ書く。returnPath:true なら内蔵ブラウザーへ渡すパスを返し、
        // そうでなければ既定のブラウザーで開く。写しの CSP は文書の meta に含める。
        case "openVisualization": {
          if (!local) return reply(false, t('files.remoteOnly'));
          const args = msg.args ?? {};
          try {
            const record = await history.findVisualization(args.sessionId, await resolveBackendForSession(args.sessionId).catch(() => null), { id: args.id, at: args.at });
            if (!record) return reply(false, t('filePreview.visualize.snapshotNotFound'));
            if (!osActionAllowed()) return reply(false, t('files.tooMany'));
            // allow: 内蔵ブラウザーの「読み込む」で、そのタブだけに加える https の出どころ（docs/inapp-browser.md）
            const once = Array.isArray(args.allow) ? [...new Set(args.allow.slice(0, 50).map(externalOrigin).filter(Boolean))] : [];
            const file = await writeSnapshotFile(record, path.join(store.dataDir, 'visualization-snapshots'), { prefs: await store.getPrefs(), once, report: args.returnPath === true });
            if (args.returnPath !== true) await openOnHost('open', file, { directory: false });
            return reply(true, { path: file });
          } catch (error) {
            return reply(false, String(error?.message ?? error));
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

        // 操作の一覧（core/ops/）の汎用の口。画面は新しい機能をここから呼ぶ（protocol.mjs を触らずに増やせる。ADR 0080）
        case 'invoke': {
          const r = await opsRegistry.invoke({ by: 'human', via: 'ui', local }, msg.args?.op, msg.args?.args, opsDeps(locale.lang));
          return r.ok ? reply(true, r.result) : reply(false, r.error, r.code, r.issues ? { issues: r.issues } : undefined);
        }

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
          await savePref("backend", backend.id);
          return reply(true, saved);
        }
        case "prefs": {
          // 既定のエージェントが無くなっていたら（対応を終えた・無効にした）載せない。web は有効なものへ落とす
          const prefs = await store.getPrefs();
          if (prefs.backend && !getBackend(prefs.backend)) delete prefs.backend;
          prefs.autoCompaction = compactionSettings;
          return reply(true, prefs);
        }
        case 'setAutoCompaction':
          return reply(true, await applyAutoCompaction(normalizeCompactionSettings(msg.args?.settings)).then((r) => { settingsChanged(['compaction.auto']); return r; }));

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
            .map((m) => m.role === "user" ? agentT(lng, 'title.request', { text: textForTitleModel(m.text).slice(0, 600) }) : agentT(lng, 'title.response', { text: m.text.slice(0, 600) }))
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
          // 中身を 1 通で受ける古い口。上限は 8MB のまま（大きなものは attachStart からの断片で送る）
          const buf = Buffer.from(data, "base64");
          if (buf.length > ATTACH_INLINE_MAX) {
            return reply(false, t('attach.tooLarge', { size: Math.round(buf.length / 1024 / 1024), limit: ATTACH_INLINE_MAX / 1024 / 1024 }));
          }
          const { dir, rel } = attachTarget(sessionId, name);
          await fs.mkdir(dir, { recursive: true });
          const file = path.join(dir, rel);
          await fs.writeFile(file, buf);

          // ここでは置くだけ。会話に載るのは送信のとき（runTurn の attachments）。
          // 送る前の添付は入力欄のものであって、会話の出来事ではない
          return reply(true, { path: file, bytes: buf.length, kind: IMAGE_MIME.test(String(mime ?? "")) ? "image" : "file" });
        }

        // 添付を断片で送る（1 件 100MB まで。手元のフォルダーを送る口と同じ仕組み・同じ 512 KiB の断片）。
        //   attachStart { sessionId, name, mime, size } -> { uploadId, path, received, chunkBytes }
        //   attachChunk { uploadId, offset, data } -> { received }（data が空なら今の位置を返すだけ。つなぎ直した後に使う）
        //   attachFinish { uploadId } -> { path, bytes, kind }   attachCancel { uploadId }
        // 置くだけで、会話に載るのは送信のとき（attachFile と同じ）
        case "attachStart": {
          const { sessionId, name, mime, size } = msg.args ?? {};
          if (!Number.isSafeInteger(size) || size < 0) return reply(false, t('attach.noContent'));
          if (size > ATTACH_MAX_BYTES) return reply(false, t('attach.tooLarge', { size: Math.round(size / 1024 / 1024), limit: ATTACH_MAX_BYTES / 1024 / 1024 }));
          const { bucket, dir, rel } = attachTarget(sessionId, name);
          const r = await attachUploads.start({ name: bucket, dest: dir, files: [{ path: rel, size, mtime: 0 }], overwrite: true });
          // 返すパスは置き場（UPLOAD_DIR）からたどった形にする。r.dest は realpath 済みで、データ置き場の途中にジャンクション・
          // 8.3 の短い名前（CI の Windows の TEMP など）があると UPLOAD_DIR と字面が違い、送信時の presentAttachments が置き場の外として落とすため
          const file = path.join(dir, rel);
          attachPending.set(r.uploadId, { file, mime: String(mime ?? "") });
          return reply(true, { uploadId: r.uploadId, path: file, received: r.received[0], chunkBytes: r.chunkBytes });
        }
        case "attachChunk": {
          const args = msg.args ?? {};
          if (!attachPending.has(args.uploadId)) return reply(false, t('upload.unknownUpload'));
          return reply(true, await attachUploads.chunk({ uploadId: args.uploadId, file: 0, offset: args.offset, data: args.data }));
        }
        case "attachFinish": {
          const id = msg.args?.uploadId;
          const pending = attachPending.get(id);
          if (!pending) return reply(false, t('upload.unknownUpload'));
          const r = await attachUploads.finish({ uploadId: id });
          if (r.needsConfirm) return reply(false, t('upload.unknownUpload'));
          attachPending.delete(id);
          return reply(true, { path: pending.file, bytes: r.bytes, kind: IMAGE_MIME.test(pending.mime) ? "image" : "file" });
        }
        case "attachCancel": {
          const id = msg.args?.uploadId;
          if (!attachPending.has(id)) return reply(true, { cancelled: false });
          attachPending.delete(id);
          return reply(true, await attachUploads.cancel({ uploadId: id }));
        }

        // セッションを選んでいなくても既定は変えられる。検査も保存も配信も設定の一覧（core/ops/settings.mjs）の定義を通る（AI の settings.set と同じ）
        case "setPref": {
          const { key, value, backend } = msg.args ?? {};
          const r = await opsRegistry.invoke({ by: 'human', via: 'ui', local }, 'settings.set', { key, value, ...(backend ? { backend } : {}) }, opsDeps(locale.lang));
          return r.ok ? reply(true, await store.getPrefs()) : reply(false, r.error, r.code, r.issues ? { issues: r.issues } : undefined);
        }

        // 状態の一括改名。to が空なら状態を外す（＝グループの削除）。
        // 状態は事前定義しないので「グループ」は実体を持たず、付いているセッションの集合でしかない。
        // だから改名も削除も、対象セッションの状態を書き換えるだけで足りる。
        case "renameStatus": {
          const { from, to } = msg.args ?? {};
          if (typeof from !== "string" || !from) return reply(false, t('statuses.renameFromRequired'));
          const next = typeof to === "string" ? to.trim() : "";
          const hit = (await sessionList({ limit: 500 })).filter((x) => (x.status ?? "") === from);
          let done = 0;
          for (const x of hit) {
            const backend = getBackend(x.backend);
            if (backend?.capabilities?.tag && backend.setTag) {
              await backend.setTag(x.id, next || null).catch(() => {});
            }
            await store.recordChange(x.id, {
              by: "human", field: "status", from, to: next || null, backend,
              ...(next ? savedReason('renameStatus', { to: next }) : savedReason('deleteGroup')),
            });
            emitGlobal({ type: 'statusProgress', from, to: next, done: ++done, total: hit.length });
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
            if (!m.text && !m.thinking && tools.length === 0) continue;   // ツールの戻りだけの行は出さない
            // 入力と結果も渡す。名前だけだと、画面のカードが空の入力 {} になって何をしたのか読めない
            messages.push({ role: m.role, text: m.text, tools: tools.length ? tools : null,
              ...(m.toolCalls?.length ? { toolCalls: m.toolCalls } : {}), ...(m.thinking ? { thinking: m.thinking } : {}),
              ...(m.model ? { model: m.model } : {}), at: m.at ?? null });
          }
          // 依頼文。記録に依頼の発言が入らないエージェントがあるので、走っているターンが覚えた委譲ツールの入力から渡す。
          // ターンが終わった後は web が親の会話のツール呼び出し（origin の id）から拾う
          const turn = runtime.turns.get(sessionId);
          const origin = turn?.subagentOrigins.get(agentId) ?? null;
          return reply(true, { agentId, sessionId, origin, prompt: origin ? turn.taskHints.get(origin)?.prompt ?? null : null, messages });
        }

        // 会話の中の委譲ツールのカードから、それが生んだサブエージェントを引く（終わってターンの一覧から外れた子を開くため）
        case "findSubagent": {
          const { sessionId, toolId } = msg.args ?? {};
          if (!sessionId || !toolId) return reply(false, t('background.agentIdsRequired'));
          const backend = await resolveBackendForSession(sessionId);
          if (!backend?.listSubagents || !backend.getSubagentOrigin) return reply(true, { agentId: null });
          for (const id of await backend.listSubagents(sessionId).catch(() => [])) {
            if (await backend.getSubagentOrigin(sessionId, id).catch(() => null) === toolId) {
              const raw = typeof backend.getSubagentState === 'function' ? await backend.getSubagentState(sessionId, id).catch(() => null) : null;
              const state = raw && SUBAGENT_STATUS.has(raw.status) ? raw : null;
              return reply(true, { agentId: id, status: state?.status ?? null, startedAt: state?.startedAt ?? null, endedAt: state?.endedAt ?? null });
            }
          }
          return reply(true, { agentId: null });
        }

        // モデルの切り替え（sessions.setModel）。AI も同じ操作を呼ぶ（ADR 0094）。承認モードは人間だけ（下の setMode）
        case "setModel":
          return viaOp('sessions.setModel', (r) => ({ live: r.live }));

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
          const r = await opsRegistry.invoke({ by: 'human', via: 'ui', local }, 'sessions.setStatus', msg.args, opsDeps(locale.lang));
          return r.ok ? reply(true, { moved: r.result.moved }) : reply(false, r.error, r.code);
        }

        // 完了を確認した。ホストに 1 つで、別の窓・別の端末にも read で知らせる（store.markRead が巻き戻さない）。
        // 旧版がブラウザーに持っていた確認済みも、最初につないだときにここへまとめて届く（web/unread.mjs）
        case "markRead": {
          const a = msg.args ?? {};
          const reads = Array.isArray(a.reads) ? a.reads.slice(0, 5000) : [[a.sessionId, a.at]];
          const changed = await store.markRead(reads);
          if (changed.length) emitGlobal({ type: "read", sessionId: null, reads: changed });
          // どこかで見た完了・失敗は、スマホに出ている通知を消す
          for (const [id] of changed) pushNotifier.viewed(id);
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
        case "setStatusIcon":
          return reply(true, await setStatusIconOf(msg.args?.status, msg.args?.icon, { by: 'human' }));

        // 空のグループを作る。状態は使われた時点で存在する（設計メモ §6）が、
        // 人が先に作った器は statuses.json にある限り存在する（セッション 0 件でも一覧に出る）
        case "createStatus":
          return reply(true, await createStatusGroup(msg.args?.status, { by: 'human' }));

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

        // 会話の変更の記録（時刻・誰が・前 → 後・理由）。脇の会話の行の「変更の記録」が読む
        case "sessionChanges": {
          const { sessionId } = msg.args ?? {};
          if (!sessionId) return reply(false, t('session.required'));
          const entry = await store.get(sessionId);
          return reply(true, { changes: (entry.history ?? []).map(({ at, by, field, from, to, reason, reasonKey, reasonParams }) =>
            ({ at, by, field, from: from ?? null, to: to ?? null, reason: reason ?? null, ...(reasonKey ? { reasonKey, ...(reasonParams ? { reasonParams } : {}) } : {}) })) });
        }

        // 会話の今の内蔵ブラウザーのプロフィールを人が替えた（右パネルのメニュー。main のタブの一覧は画面が先に替えている。ADR 0078）。
        // 会話に残し、作業フォルダーの「最後に使ったもの」と、走っているターン（ply_browser の今のもの）にも伝える
        case "setBrowserProfile": {
          const r = await opsRegistry.invoke({ by: 'human', via: 'ui', local }, 'browser.setProfile', msg.args, opsDeps(locale.lang));
          return r.ok ? reply(true, r.result) : reply(false, r.error, r.code);
        }
        case "setTitle": {
          const r = await opsRegistry.invoke({ by: 'human', via: 'ui', local }, 'sessions.setTitle', msg.args, opsDeps(locale.lang));
          return r.ok ? reply(true, "ok") : reply(false, r.error, r.code);
        }

        case "fork": {
          const r = await opsRegistry.invoke({ by: 'human', via: 'ui', local }, 'sessions.fork', msg.args, opsDeps(locale.lang));
          return r.ok ? reply(true, { sessionId: r.result.sessionId }) : reply(false, r.error, r.code);
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
  if (data?.type === 'wake') await schedule.check();
  if (data?.type === 'update-lock') {
    // 断るときは何が止めているかを返す。画面に出さないと、見た目に何も動いていないのに更新できない理由が分からない
    const reason = runtime.turns.size ? t('updateLock.turns', { count: runtime.turns.size })
      : blockingWaits().length ? t('updateLock.approvals', { count: blockingWaits().length })
      : agentTasks.busy ? t('updateLock.delegation')
      : outbox.busy ? t('updateLock.steer')
      : switching.size || forking.size ? t('updateLock.switching')
      : null;
    const ok = updateGate.acquire(Boolean(reason));
    process.parentPort.postMessage({ type: 'update-lock', id: data.id, ok, reason: ok ? null : reason || t('updateLock.other') });
  }
  if (data?.type === 'update-unlock') updateGate.release();
  if (data?.type === "running") process.parentPort.postMessage({ type: "running", work: await runningWork() });
  // デスクトップの「中断して終了」（desktop/main.cjs の closeSafely）。全部を reason 付きで止める。
  // main は running の count が 0 になるのを待ってから終了する
  if (data?.type === 'abort') {
    const result = await abortSessions({ reason: data.reason }).catch(err => ({ error: String(err?.message ?? err) }));
    process.parentPort.postMessage({ type: 'abort', id: data.id, ...result });
  }
  if (data?.type === "shutdown" && runtime.turns.size === 0 && !agentTasks.busy) process.exit(0);
});

async function announce() {
  const { port } = server.address();
  // CLI がつなぎ先を見つける control.json（ADR 0083）。権限 0600。終了時に pid が自分のときだけ消す。
  // 起動の案内（下の URL の行）を見て CLI や検査が動き出すので、その前に書き終える
  await writeControlFile({ dataDir: store.dataDir, origin: localOrigin(), cliToken: CLI_TOKEN, startedAt: SERVER_STARTED_AT, appVersion: APP_VERSION, kind: process.parentPort ? 'desktop' : 'server' })
    .catch((err) => console.error('  control.json を書けませんでした:', String(err?.message ?? err)));
  process.parentPort?.postMessage({ type: "ready", port, token: TOKEN, locale: locale.lang });
  remote.start().catch(() => {});
  if (routingSettingsCache.enabled && ROUTING_USAGE_AUTO) routingUsage.start();
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
// 設定とバックエンドが揃った後に、前の起動の放置圧縮の予約を戻す
// 検索の写しは、起動の混み合いが落ち着いてから裏で作る（探されたときは待たずに読めた分で答える）
setTimeout(() => sessionSearch.start().catch(() => {}), 3000).unref();
await restoreCompactionSchedule().catch(err => console.error('  自動圧縮の予約を戻せませんでした:', String(err?.message ?? err)));
for (const [id, meta] of Object.entries(await store.getAll())) {
  if (meta.interrupted?.reason === 'limit') limitStates.set(id, interruptedOf(meta.interrupted));
}
await schedule.restore().catch(err => console.error('  再開の予定を戻せませんでした:', String(err?.message ?? err)));
server.listen(PORT, HOST, announce);
