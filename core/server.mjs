// 先頭に置く: AGENT_HOST_SERVER_LOG があれば、他のモジュールの読み込みの失敗も含めて出力をファイルへ向ける（stdio の無い起動）
import './server-log-boot.mjs';
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
import { readWithRetry, transientStorageError } from './history-retry.mjs';
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
import { judgeDifficulty, normalizeKey, SERVICES as ROUTING_JUDGE, JUDGE_SERVICE, JUDGE_TIMEOUT_MS } from './delegation-judges.mjs';
import { createUsageMonitor } from './delegation-usage.mjs';
import { canDelegate, resolveDelegatedMode, modePosition, scopeRank, autonomyRank, SCOPES, AUTONOMIES } from './modes.mjs';
import { createGitActivity } from './git-activity.mjs';
import * as gitInfo from './git-info.mjs';
import * as gitHistory from './git-history.mjs';
import { worktreeList } from './git-worktree.mjs';
import { createWorktreeHost, writesScope } from './worktree-host.mjs';
import { insideDir, sameDir } from './worktrees.mjs';
import { createCallTracker, timelineOf } from './git-timeline.mjs';
import { createUpdateGate } from './update-gate.mjs';
import { ensureDataSchema } from './data-schema.mjs';
import { acquireDataLock, acquireDataLockWait } from './data-lock.mjs';
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
import { OpError, approvalWords, targetText as settingTarget } from './ops/registry.mjs';
import { FAILED } from './ops/host.mjs';
import { createControlBridge, CONTROL_MCP_PATH, controlInstructions } from './ops/surfaces/control.mjs';
import { createOpsHttp, OPS_PATH } from './ops/surfaces/http.mjs';
import { writeControlFile, removeControlFile } from './control-file.mjs';
import { addCliToPath, mcpSetup } from './cli-launcher.mjs';
import { parentIdOf, ROOTS_DEFAULT, ROOTS_MAX, ROOT_TEXT_MAX } from './ops/sessions.mjs';
import * as store from "./store.mjs";
import * as history from "./history.mjs";
import { createMessageQueue } from "./message-queue.mjs";
import { createSchedule } from './schedule.mjs';
import { pollInterval, resumePlan, limitHolds, limitOpen } from './limit-resume.mjs';
import { buildSendRow, buildPostRow, decideFire, sendArgs, decorateScheduled, addRecord, MAX_PER_SESSION, MAX_TOTAL } from './send-schedule.mjs';
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
import { createApiKeys, ApiKeyError, USES as API_KEY_USES } from './api-keys.mjs';
import { createCompatEndpoints, sweepClaudeFlagSettings, isModelId, redactSecret, CheckError, delegatedEndpoint } from './compat-endpoints.mjs';
import { createClaudeAccounts, redactToken, normalizeName as normalizeAccountName, fetchTokenOrg, ANTHROPIC_API } from './claude-accounts.mjs';
import { createPlyMcp } from './ply-mcp.mjs';
import { redactForPeer } from './redact.mjs';
import { createMcpOAuth } from './mcp-oauth.mjs';
import { importNativeMcp } from './mcp-import.mjs';
import { createMcpConfig } from './mcp-config.mjs';
import { createHooksConfig, HOOK_AGENTS, applyCodexHooks, trimHookRuns, findNodeOnPath } from './hooks-config.mjs';
import { finishShutdown } from './shutdown.mjs';
import { createVoiceHost, VOICE_PATH } from './voice/host.mjs';
import { createPlyHooks } from './ply-hooks.mjs';
import { prepareHooksTurn, unifyPreview, importCandidate } from './hooks-unify.mjs';
import { deliverable, classifyNativeRun } from './hooks-plan.mjs';
import { createRemoteHost } from './remote/connector.mjs';
import { createAgentPort } from './remote/agent-port.mjs';
import { viewAnswer, viewInstructions, pickDescendants } from './remote/agent-view.mjs';
import { streamMessages } from '../web/stream-messages.mjs';
import { parentPortRemoteAgent, createRemoteDelegation } from './remote-delegation.mjs';
import { AgentError, remoteOwnerId, isRemoteOwner, parseRemoteOwner, RESULT_PAGE } from './remote/agent-protocol.mjs';
import { createResidentPrefs, residentSignal, enabledRoutineCount } from './remote/resident.mjs';
import { createPushNotifier } from './notify/notifier.mjs';
import { createPresence } from './notify/presence.mjs';
import { createNotifications } from './notifications.mjs';
import { createDrafts } from './drafts.mjs';
import { createNotificationSources } from './notification-sources.mjs';
import { createNotifySettings } from './notify/settings.mjs';
import { createFolderUploads } from './folder-uploads.mjs';
import { createImageImporter, testImportOrigin } from './image-import.mjs';
import { createUrlGuard } from './mcp-url-guard.mjs';
import { pinnedFetch } from './pinned-fetch.mjs';
import { createVisualizationCollector, visualizeInstructions, snapshotResponse, writeSnapshotFile } from './visualize.mjs';
import { plyParts } from './instruction-amount.mjs';
import { computerPrompt } from './backends/computer-delivery.mjs';
import { MIN_BUDGET, MAX_BUDGET } from '../web/instruction-amount.mjs';
import { parentPortBrowser, browserEnvironment, browserInstruction, forgetBrowserEnvironment, agentBrowserMode, chromeRelayBrowser } from './agent-browser.mjs';
import { getMainPort, setMainPortSource } from './main-port.mjs';
import { createMainLink, handoverEnabled } from './main-link.mjs';
import { createOrphanGuard } from './orphan-guard.mjs';
import { createMainAway, createExternalOpener } from './main-away.mjs';
import { readBuildInfo } from './handover-check.mjs';
import { markRuntimeInUse } from './runtime-use.mjs';
import { cardOf, restoreFields, promptHash, CARD_MAX_BYTES } from './turn-card.mjs';
import { readAdoptSources, readHolderSources, ADOPT_TURN_MARK } from './adopt.mjs';
import { holderLink } from './holder/link.mjs';
import { HOLDER_PROTOCOL } from './holder/protocol.mjs';
import { handoverStart, createHandover, stashOf, readStash, retryTransient, HANDOVER_VERSION, LOCK_WAIT_MS } from './handover.mjs';
import { closeAll as closeDataDb } from './db.mjs';
import { createApprovalIds } from './approval-id.mjs';
import { parentPortScreencast, createScreencastHub, screencastCommand } from './browser-screencast.mjs';
import { createChromeConnection } from './chrome/connection.mjs';
import { chromeHomes } from './chrome/locate.mjs';
import { parentPortChromeOs } from './chrome/os.mjs';
import { createChromeRelay } from './chrome/relay.mjs';
import { createBrowserSiteApprovals } from './browser-confirm.mjs';
import { createBrowserBridge, BROWSER_MCP_PATH } from './browser-bridge.mjs';
import { validBrowserPref, externalOrigin } from '../web/browser-confirm-policy.mjs';
import { computerUsePrefs, validComputerUse } from '../web/computer-prefs.mjs';
import { computerUseCapability } from './computer-use-capability.mjs';
import { streamEvents } from "../web/session-stream.mjs";
import { serveFrom } from "../web/history-sync.mjs";
import { switchBackend, createConversation, deleteUnsentConversation, deleteHiddenConversation, deleteConversation, pendingHandoff, conversation } from "./conversations.mjs";
import { familyOf } from "./lineage.mjs";
import {
  getBackend, sessionBackend, listBackends, defaultBackend, describeBackends, resolveBackendForSession,
} from "./backends/index.mjs";
import { takeBootEnv } from './boot-env.mjs';

// main が起動の時にだけ渡す変数（AGENT_HOST_HANDOVER・PORT・RUNTIME_KEY・SERVER_LOG など。core/boot-env.mjs）を写して process.env から外す。
// 子（エージェントの CLI・`!` の行・MCP）は process.env を継ぐので、どれを起こすより前に外す。以後の読み出しはこの写しから。
// 読み込みの間に読むもの（core/server-log-boot.mjs の出力の向け先・core/i18n.mjs の最初の言語）は、ここより前なので今のまま
const BOOT_ENV = takeBootEnv(process.env);

// 保存（DB への書き込み）の失敗は例外として返る（ADR 0115）。待たずに呼んで受けていない箇所が残っていると、Node の既定
// （処理されない Promise の拒否でプロセスが落ちる）では、1 件の保存の失敗でサーバーごと落ち、走っている他の会話のターンまで止まる。
// 呼び出し側で受けるのが先で（洗い出しは ADR 0115）、これは念のための受け止め: ログに出して、サーバーは落とさない。
// 拒否した処理の結果は誰も待っていないので、続けても状態は食い違わない
process.on('unhandledRejection', (reason) => {
  console.error('  [unhandledRejection]', String(reason?.stack ?? reason));
});
const updateGate = createUpdateGate();
const quotaCache = createQuotaCache();
// 書き込みを始める前に、データ置き場をこのプロセスだけが持つようにする（別のプロセスが持っていれば、理由を出して起動を止める。
// 終了まで持つ。core/data-lock.mjs）。そのうえで形式を確かめ、古ければここで移行する（core/schema-migration.mjs。失敗すれば起動を止める）。
// 無停止の更新の新サーバー（--handover。core/handover.mjs）は、モジュールの読み込みを済ませたうえで、旧サーバーがデータ置き場を放すのを待って取る（数十 ms 刻み）
const HANDOVER_START = handoverStart();
// 版ごとの実行場所で走っているなら、その版を使っている印を付ける（desktop/runtime.cjs の掃除がこの版を消さない。core/runtime-use.mjs）。
// 印は閉じない: プロセスの終了で OS が外す。データ置き場のロックより前に付ける: 引き継ぎの新サーバー（--handover）は、印ができたら
// モジュールの読み込みが済んでロックを待っているとみなされ、main が旧サーバーに handover を頼む（desktop/switch.cjs）
if (BOOT_ENV.AGENT_HOST_RUNTIME_ROOT && BOOT_ENV.AGENT_HOST_RUNTIME_KEY) markRuntimeInUse({ root: BOOT_ENV.AGENT_HOST_RUNTIME_ROOT, key: BOOT_ENV.AGENT_HOST_RUNTIME_KEY });
const handoverLockFrom = Date.now();
const releaseDataLock = HANDOVER_START ? await acquireDataLockWait(store.dataDir, { timeoutMs: LOCK_WAIT_MS }) : acquireDataLock(store.dataDir);
const handoverLockWaitedMs = Date.now() - handoverLockFrom;
if (HANDOVER_START) console.log(`  [handover] got the data lock after ${handoverLockWaitedMs} ms at=${Date.now()}`);
// 旧サーバーが保持役に置いた預かり物（画面のトークン・CLI のトークン・ポート）。居る保持役にだけつなぐ（起こさない）。無ければ起動の変数のまま
const handoverStash = HANDOVER_START && BOOT_ENV.AGENT_HOST_RUNTIME_ROOT
  ? await holderLink({ dataDir: store.dataDir, root: BOOT_ENV.AGENT_HOST_RUNTIME_ROOT, appVersion: '', launch: false }).then(client => readStash(client.welcome?.stash), () => null)
  : null;
const migrated = HANDOVER_START ? await retryTransient(() => ensureDataSchema(store.dataDir)) : await ensureDataSchema(store.dataDir);
if (migrated) console.log(`  ${t('data.migrated', { backup: migrated.backup })}`);
const usageStore = createUsageStore(store.dataDir);
// Claude の記録に入っていた会話の累計を、ターンの分へ一度だけ直す（core/usage-migrations.mjs、ADR 0053）。
// transcript を読むので起動は待たせない。記録の書き込みとは usageStore の中で直列になる
migrateClaudeUsage({ store: usageStore, projects: path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects') })
  .then(result => { if (result) console.log(`  ${t('usage.migrated', result)}`); })
  .catch(err => console.error(`  ${t('usage.migrateFailed')}`, String(err?.message ?? err)));
const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_VERSION = JSON.parse(await fs.readFile(path.join(HERE, '..', 'package.json'), 'utf8')).version;
// 版を見分けるビルドの短いハッシュ（実行場所の木・配布物なら有る。開発のリポジトリは null）。ready に載せ、版が変わった画面を読み直させる（docs/zero-downtime-update/design.md §8）
const BUILD = readBuildInfo(path.join(HERE, '..')).build;
// main への口（core/main-port.mjs）。main の下でない起動（npm start）では、口を受け取る機能は null で無効になる。
// AGENT_HOST_HANDOVER=on で utilityProcess の下でない起動は、名前付きパイプの口（core/main-link.mjs）を main への口にする
const mainLink = handoverEnabled(BOOT_ENV) && !process.parentPort ? createMainLink({ dataDir: store.dataDir, appVersion: APP_VERSION,
  log: line => console.log(`  [main-link] ${line}`) }) : null;
if (mainLink) setMainPortSource(mainLink.port);
const mainPort = getMainPort();
const hostedPort = mainPort.hosted ? mainPort : null;
// main が居ない間（更新）の出来事と、OAuth の同意画面などを開く口（core/main-away.mjs）。機能ごとの扱いは頼む側のモジュールが持つ
const mainAway = createMainAway({ mainPort });
const openExternal = createExternalOpener({ mainPort, log: line => console.log(`  [main-away] ${line}`) });
const agentBrowser = parentPortBrowser(hostedPort, { dataDir: store.dataDir });
// リモートの端末から PC の内蔵ブラウザーを見る（core/browser-screencast.mjs）。デスクトップ版だけ
const screencastBridge = parentPortScreencast(hostedPort);
const screencastHub = screencastBridge ? createScreencastHub({ bridge: screencastBridge }) : null;
const screencastClients = new WeakMap();   // ws -> hub に渡す端末
// エージェントのブラウザー（PC の Chrome）への接続 1 本（core/chrome/connection.mjs、ADR 0148・0153）。デスクトップ版だけ。OS ごとの層は main（desktop/chrome-os）
const chromeLocate = chromeHomes()[0] ?? null;
const chromeOs = process.parentPort ? parentPortChromeOs(process.parentPort) : null;
const chromeConnection = chromeOs
  ? createChromeConnection({ locate: chromeLocate, os: chromeOs, log: line => console.log(`  ${line}`) })
  : null;
// エージェントのブラウザーを PC の Chrome の絞り込みの中継へ向ける（core/chrome/relay.mjs）。環境変数 AGENT_HOST_AGENT_BROWSER=chrome のときだけ
// （開発と実機の確かめ用。docs/inapp-browser.md「Chrome の中継（開発中）」）。無ければ内蔵ブラウザーの道のまま。確認は下の browserSiteApprovals
const chromeRelay = chromeConnection && agentBrowserMode() === 'chrome'
  ? createChromeRelay({ connection: chromeConnection, os: chromeOs, locate: chromeLocate, authorize: (request, signal) => browserSiteApprovals(request, signal), deniedMessage: () => t('permission.browserSiteDenied'), log: line => console.log(`  ${line}`) })
  : null;
// 会話の端点を出す口（ターンの開始・新しい会話の id の付け替え・ターンの終わり・会話の削除）。Chrome の道でなければ内蔵ブラウザーの橋そのもの
const agentBrowserEndpoints = chromeRelay ? chromeRelayBrowser(chromeRelay) : agentBrowser;
// A nested server may inherit another conversation's shell environment; only this process's bridge can issue browser access.
delete process.env.AGENT_BROWSER_CONFIG;
delete process.env.AGENT_BROWSER_SESSION;
// 会話のシェルで pleiad CLI を使えるよう、起動口（bin/）を PATH の先頭に足す。エージェントのプロセスと `!` の行はこの env を継ぐ（ADR 0090）
addCliToPath(process.env);
// このサーバーが起動した時刻。ready で配る。画面は、これより前の更新による中断だけを「更新の後」とみなす（web/interrupt.mjs の updateInterrupted）
const SERVER_STARTED_AT = Date.now();
const WEB = path.join(HERE, "..", "web");
// 画面の言語（設定値と解決後）。起動時と設定を変えたときに決め直す。ready と prefs イベントで配る（docs/design.md「多言語対応」）。
// main が渡した OS の言語（AGENT_HOST_SYSTEM_LOCALE）は process.env から外したので、写しを重ねて見る
const localeEnv = () => ({ ...process.env, ...BOOT_ENV });
let locale = localeInfo(await store.getPrefs(), localeEnv());
setLocale(locale.lang);
let compactionSettings;
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
import { createShellHolder } from './shell-held.mjs';
import { createHostSessionSearch } from './session-search-host.mjs';
import { taskStop, backgroundStop, approvalStop, interruptionNote } from './interrupt-stops.mjs';
import { splitLeadingNotes } from './system-messages.mjs';
import { createBotHost } from './bots-host.mjs';
import { channelEventRows, HIDDEN_BOT_KINDS } from './channels/types.mjs';
import { textForTitleModel } from './prompt-title.mjs';

const PORT = handoverStash?.port ?? Number(BOOT_ENV.AGENT_HOST_PORT ?? 7420);
const HOST = BOOT_ENV.AGENT_HOST_BIND ?? "127.0.0.1";
const TOKEN = handoverStash?.token ?? BOOT_ENV.AGENT_HOST_TOKEN ?? crypto.randomBytes(16).toString("hex");

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
// 貼り付けた HTML の画像を取りに行く口（core/image-import.mjs、docs/adr/0141）。置き場と名前の決め方は添付と同じ。
// 本番では公開アドレスの https だけ。テスト専用の緩め: バックエンドが fake だけのときに限り、AGENT_HOST_IMAGE_IMPORT_TEST_ORIGIN=<http://127.0.0.1:ポート>
// （ホストがループバックのものだけ有効）を渡すと、検査をやめ、どの https の URL も、パスと問い合わせだけを残してそのテスト用サーバーへ向ける
// （本物の外へは出ない。ブラウザーでの確認用。testImportOrigin）
const imageImportTestOrigin = testImportOrigin();
const imageImporter = createImageImporter({
  target: (sessionId, name) => attachTarget(sessionId, name),
  ...(imageImportTestOrigin ? {
    guard: createUrlGuard({ serverUrl: "http://127.0.0.1" }),
    fetchFn: (url, init) => { const u = new URL(url); return pinnedFetch(new URL(`${u.pathname}${u.search}`, imageImportTestOrigin), init); },
  } : {}),
});
const IMAGE_MIME = /^image\//;
// Native sessions opened outside this host may not have sidecar metadata yet.
const workspaceRoots = new Set([process.cwd()]);
const contextSettings = createContextSettings(store.dataDir);
// 担当が Pleiad の外部 MCP。登録は Pleiad 自身の設定（エージェントの設定ファイルは書き換えない）、秘密は safeStorage で暗号化して置く
// 暗号器は 1 つを使い回す（main の口の応答は id で引くので、2 つ作ると同じ id を取り合う）
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
  // デスクトップ版は main に頼んで既定のブラウザーで開く（main が居ない間は OS に直に頼む。npm start では画面のリンクから開く）
  openExternal,
});
process.on('exit', () => claudeLogin.cancelAll());
// 互換の接続先（Claude Code の Anthropic 互換 / Codex の Responses 互換。会話ごとに選ぶ。core/compat-endpoints.mjs）。
// キーは Claude のアカウント・MCP と同じ暗号化の置き場。前の起動で消し損ねたフラグ設定のファイル（キーを含む）は起動時に片付ける
const compatSecrets = createSecretStore({ file: path.join(store.dataDir, 'compat-endpoint-secrets.json'), cipher: secretCipher });
compatSecrets.migrate().catch(() => {});
// API キーの置き場（設定 › API キー。core/api-keys.mjs、ADR 0155）。接続先・通話・委譲の判定器のキーはここに 1 回だけ登録し、使う側は選ぶだけにする。
// 古い置き場（compat-endpoint-secrets.json・voice-secrets.json）は移行で消さず、キーを変えるたびに同じ状態を書く（古い版が読む）
const voiceSecrets = createSecretStore({ file: path.join(store.dataDir, 'voice-secrets.json'), cipher: secretCipher });
voiceSecrets.migrate().catch(() => {});
const apiKeySecrets = createSecretStore({ file: path.join(store.dataDir, 'api-key-secrets.json'), cipher: secretCipher });
apiKeySecrets.migrate().catch(() => {});
const apiKeys = createApiKeys({
  dataDir: store.dataDir, secrets: apiKeySecrets, legacy: { compat: compatSecrets, voice: voiceSecrets }, endpoints: () => compatEndpoints,
  log: (line, fields) => console.log(`  ${line}${fields ? ` ${JSON.stringify(fields)}` : ''}`),
  onChange: change => apiKeysChanged(change),
});
const compatEndpoints = createCompatEndpoints({ dataDir: store.dataDir, secrets: compatSecrets, apiKeys });
// 古い置き場から API キーへの移行（冪等。暗号化された古いキーを読めない起動では保留して、古い置き場を読み続ける）。
// 起動は待たない（暗号器は main がつながるまで答えないことがある。使う側は apiKeys の中で移行の終わりを待つ）
apiKeys.init().catch(() => {});
// 通話モード（core/voice/、docs/voice-call.md）。使う OpenRouter のキーは設定 › API キーで選んだもの（ホストだけが持つ。画面へは返さない）。
// 音声は /voice-ws（バイナリ）で受け渡し、読み上げは emitGlobal の text.delta から作る
const voiceHost = createVoiceHost({
  dataDir: store.dataDir, apiKey: () => apiKeys.useKey('voice'), keyStorage: () => apiKeySecrets.status(),
  getPrefs: () => store.getPrefs(), uiLang: () => currentLocale(), t, isLocal: isLocalRequest,
  // bot の会話が属するスレッド（スレッドの通話が読み上げる会話を決める）
  resolveThread: async (sessionId) => {
    const bot = (await store.get(sessionId).catch(() => null))?.bot;
    return bot?.kind === 'thread' && bot.channelId && bot.threadId ? { channelId: bot.channelId, threadId: bot.threadId } : null;
  },
  log: (line, fields) => console.log(`  ${line}${fields ? ` ${JSON.stringify(fields)}` : ''}`),
});
const mcpOAuth = createMcpOAuth({ secrets: mcpSecrets, lockDir: path.join(store.dataDir, 'mcp-locks'),
  // Client ID Metadata Document の URL（設定値。既定は無し。公開する文書のひな形は docs/mcp-oauth-client-metadata.json）
  clientMetadataUrl: async () => (await plyMcp.settings().catch(() => ({}))).clientMetadataUrl ?? undefined,
  // utilityProcess からはブラウザを開けないので main に頼む（desktop/main.cjs。main が居ない間は OS に直に頼む）。npm start では画面に出る URL から開く
  openExternal,
  emit: event => emitGlobal({ ...event, sessionId: null }) });
const contextBridge = createContextBridge({ plyMcp, oauth: mcpOAuth });
// リモートの接続口（docs/remote.md §4.2・§6.1）。既定は無効で、有効にするまで中継へはつながない。
// 端末からのストリームはこのサーバー自身（localOrigin）へ組み立て直し、UI トークンは接続口が差し込む
// 端末の AI 用の口 /agent（docs/remote.md §4.5、ADR 0146）。委譲の本体は remoteAgentInvoke（下の「端末の AI からの委譲」）
const remoteAgentPort = createAgentPort({
  allowed: deviceId => remote.agentAllowed(deviceId),
  hostName: () => remote.hostInfo()?.hostName ?? os.hostname(),
  invoke: call => remoteAgentInvoke(call),
  view: call => remoteAgentView(call),
  activeTasks: deviceId => remoteAgentStats(deviceId).active,
  // send が、終わったタスクを起こし直す（動いている数を増やす）か
  wakes: (device, requester, args) => {
    const row = agentTasks?.get(String(args?.taskId ?? ''));
    return Boolean(row) && row.parentSessionId === remoteOwnerId(device.id, requester.sessionId) && !REMOTE_ACTIVE.has(row.status);
  },
  tasksFor: (deviceId, ids) => { const want = new Set(ids); return remoteRowsOf(deviceId).filter(r => want.has(r.taskId)).map(remoteTaskEvent); },
  // 端末の AI の操作の記録（by: agent・via: remote・端末）。send・cancel は子の会話の変更の記録へ。断った依頼・捨てた答えはログへ（中身は書かない）
  audit: entry => {
    if (entry.dropped) return console.log(`  端末 ${entry.deviceId} の承認の答えを捨てた: ${entry.dropped}`);
    if (entry.refused) return console.log(`  端末 ${entry.deviceId} の依頼を断った: ${entry.op} ${entry.refused}`);
    // 経過の読み出し（人の操作。4 秒ごとに来る）は、端末ごと・タスクごとに最初の 1 回だけ変更の記録へ「読んだ」を残す（中身も件数も残さない）
    if (entry.op === 'view') return remoteViewRecorded(entry);
    const to = entry.op === 'send' ? 'delegation.taskSend' : entry.op === 'cancel' ? 'delegation.taskCancel' : null;
    const sessionId = to ? agentTasks?.get(String(entry.args?.taskId ?? ''))?.sessionId : null;
    if (sessionId) store.recordChange(sessionId, { by: 'agent', via: 'remote', byDevice: entry.deviceId, field: 'op', to, reason: null }).catch(() => {});
  },
  log: line => console.log(`  ${line}`),
});
const remote = createRemoteHost({ dataDir: store.dataDir, cipher: secretCipher, token: TOKEN, appVersion: APP_VERSION,
  agent: {
    attach: (stream, device) => remoteAgentPort.attach(stream, device),
    closeDevice: (deviceId, reason) => remoteAgentPort.closeDevice(deviceId, reason),
    refresh: deviceId => remoteAgentPort.refresh(deviceId),
    stats: deviceId => remoteAgentStats(deviceId),
    stopTasks: deviceId => remoteAgentStopAll(deviceId),
  },
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
const hostScreens = new WeakSet();   // ホストの PC の画面からの接続（isLocalRequest）。Chrome への接続の状態はここだけに流す
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
// 通知の一覧（ベルのボタン。ADR 0149）。DB の notifications 表。書く側は core/notification-sources.mjs（ターンの完了・承認・チャンネルの出来事から行を作る）。
// 件数が変わったら notificationsChanged を全画面へ（リモートの端末にも届く）
const inbox = createNotifications({ dataDir: store.dataDir, emit: event => emitGlobal({ ...event, sessionId: null }) });
// スレッドの入力欄の書きかけのサーバーの写し（drafts.*。ADR 0157 の F35）
const threadDrafts = createDrafts({ dataDir: store.dataDir });
const inboxSources = createNotificationSources({
  inbox, store, viewing: sessionId => notifyPresence.viewing(sessionId), titleOf: sessionId => conversationTitleOf(sessionId),
  channels: () => botHost?.opsDeps().channels ?? null, bots: () => botHost?.opsDeps().bots ?? null,
  hiddenKinds: HIDDEN_BOT_KINDS, log: line => console.error(`  ${line}`),
});
// ホストとして常駐する設定（docs/remote.md §6.3。core/remote/resident.mjs）。使うのはデスクトップ版のホストだけ（available）。
// トレイとスリープの抑止は main（desktop/resident.cjs）が持つ。リモート・実行中の作業・ルーティンの変更時に送る
const residentPrefs = createResidentPrefs({ dataDir: store.dataDir });
const withResident = status => ({ ...status, resident: { available: mainPort.hosted, ...residentPrefs.get() } });
const remoteStatus = async () => withResident(await remote.status());
/** 設定 › 通知の材料: この PC の設定と、スマホ（デスクトップ版の端末以外）の一覧。鍵は含まない */
const notifyStatus = async () => ({
  pc: await notifySettings.pc(),
  devices: (await remote.devices()).filter(d => d.platform !== 'desktop'),
  relayConnected: (await remote.status()).connection.state === 'connected',
});
let residentLast = '', residentStatus = null, residentWork = null, residentSeq = 0;
async function postResident({ status, work } = {}) {
  if (!mainPort.hosted) return;
  if (status) residentStatus = status;
  if (work) residentWork = work;
  const seq = ++residentSeq;
  const routines = await enabledRoutineCount(botHost);
  if (seq !== residentSeq) return;
  const signal = residentSignal({ status: residentStatus, prefs: residentPrefs.get(), work: residentWork, locale: locale.lang, routines });
  const key = JSON.stringify(signal);
  if (key === residentLast) return;
  residentLast = key;
  mainPort.postMessage({ type: 'resident', state: signal });
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
// bot・Channels・ルーティン（core/bots-host.mjs）。つなぎ目は botHost?.xxx() で呼ぶ（生成前・失敗時は何もしない）
let botHost;
// 設定の変更の承認の台帳と、結果を会話へ届ける待ち行列（core/setting-approvals.mjs、ADR 0088）
let settingApprovals;
const agentConnections = new Map();
const taskExecutions = new Map();
// ターンから ctx を引く（旧サーバーが付け直しに渡すときに札を作る。handOffTurn。無停止の更新 2b-4）
const turnContexts = new WeakMap();
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
// 子の worktree の 1 行（ADR 0089）。分けていない子には何も足さない
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
  // リモートのホストへ任せる（ply_delegate の host と、写しの行があるタスクへの ply_task_*。docs/agent-delegation.md「リモートのホストへ任せる」）
  if (name === 'ply_delegate' && args.host !== undefined) return callRemoteDelegate(owner, turn, args, lng);
  if (name.startsWith('ply_task_') && name !== 'ply_task_list' && agentTasks.get(String(args.taskId ?? ''))?.host) {
    return remoteDelegation.taskCall({ owner, turn, name, args, signal: turn.ac.signal, lng });
  }
  // 一覧のホストのタスクの行は、ply_task_status と同じ形（host は名前）にする
  if (name === 'ply_task_list') return remoteDelegation.presentList(await agentTasks.call(owner, name, args, turn.ac.signal, lng));
  // 委譲先の自動振り分け（docs/agent-delegation.md「委譲先の自動振り分け」）。backend を省けばここで選ぶ。
  // 選んだ後は、書いた backend と同じく下の承認の強さの判定・承認カードを通る
  if (name === 'ply_delegate') args = await routeDelegation(args, lng, path.resolve(turn.info.cwd ?? process.cwd(), typeof args.cwd === 'string' ? args.cwd : '.'));
  // ply_task_send の backend・model・effort（ADR 0134）。何も変えないうちに確かめ、エージェントを替えるなら下の承認の強さの判定を通す
  let settings = name === 'ply_task_send' && TASK_SETTINGS.some(k => args[k] !== undefined) ? await taskSettingsPlan(owner, args, lng, turn) : null;
  // 子の承認モードは「親の強さまで継ぐ、それを超えない」（core/modes.mjs）。
  // 決めるのはここだけ。prepare は決まった結果をそのまま使う（同じ判定を二度しない）。
  const child = name === 'ply_delegate' ? getBackend(args.backend) : settings?.switching ? settings.target : null;
  // 子の設定を替えるときは、子の今の強さも上限にした判定（taskSettingsPlan の decided）
  const decided = settings ? settings.decided : child ? resolveDelegatedMode({ parentMode: turn.info.mode, parentModes: turn.backend.modes(), childModes: child.modes() }) : null;
  // codex は MCP のツール呼び出しを自前の承認に通さない。full / yolo 以外の codex 親では、
  // これが無いと委譲が起きたこと自体に人間が気づけないので、強さが収まっていても聞く。
  const codexBlind = turn.backend.id === 'codex' && !['full', 'yolo'].includes(turn.info.mode);
  if (mutation && (decided?.escalation || codexBlind)) {
    // 何をどの強さで動かすことになるのかをカードに出す。委譲のたびではなく、この1回だけ聞く
    const title = decided ? t('permission.delegateEscalation', { agent: child.label, mode: child.modes()[decided.mode]?.label ?? decided.mode, modeId: decided.mode }) : undefined;
    const answer = await askPermission({ toolName: name, input: args, title, sessionId: owner, signal: turn.ac.signal, kind: 'tool', canAlways: false, locale: lng });
    if (!answer.allow) throw new Error(agentT(lng, 'delegation.denied'));
    // 承認を待つ間に、タスクが止められた・子の設定が人や別の呼び出しで変わったなら、古い計画で書かずに断る
    if (settings) {
      const again = await taskSettingsPlan(owner, args, lng, turn);
      if (again.key !== settings.key) throw new Error(agentT(lng, 'tasks.settingsMoved'));
      settings = again;
    }
  }
  // ユーザーが worktree を指示した isolate: true の場合だけ、子の worktree を作る。
  if (name === 'ply_delegate') {
    if (args.isolate !== undefined && typeof args.isolate !== 'boolean') throw new Error(agentT(lng, 'tasks.isolateInvalid'));
    const childCwd = path.resolve(turn.info.cwd ?? process.cwd(), typeof args.cwd === 'string' ? args.cwd : '.');
    const verdict = await worktreeHost.decideIsolation({ cwd: childCwd, isolate: args.isolate });
    args = { ...args, isolate: verdict.isolate };
  }
  if (settings) return applyTaskSettings(owner, settings, lng, { message: args.message, signal: turn.ac.signal });
  const result = await agentTasks.call(owner, name, decided?.mode ? { ...args, mode: decided.mode } : args, turn.ac.signal, lng);
  // 子が使い始めるので、振り分けに使う使用量を取り直しておく（待たない）
  if (name === 'ply_delegate' && routingSettingsCache.enabled && ROUTING_USAGE_AUTO) routingUsage.refresh().catch(() => {});
  return result;
}

/**
 * ply_delegate { host }（端末のデスクトップ版の AI からホストの Pleiad へ。core/remote-delegation.mjs）。手元の委譲と同じ関門を通る:
 * 読み取り・計画モードの会話は断る（上）・Codex の親は full / yolo 以外では呼び出し自体を確かめる・承認モードの引き上げが要るときは、ホストが計画を返し、
 * 依頼元の会話で 1 回だけ確かめる。ホストに任された会話からは、さらにホストへ任せられない
 */
async function callRemoteDelegate(owner, turn, args, lng) {
  if (!remoteDelegation.enabled) throw new Error(agentT(lng, 'delegation.remote.unavailable'));
  if ((await delegationRoot(owner)).remote) throw new Error(agentT(lng, 'delegation.remote.nested'));
  if (turn.backend.id === 'codex' && !['full', 'yolo'].includes(turn.info.mode)) {
    const answer = await askPermission({ toolName: 'ply_delegate', input: args, sessionId: owner, signal: turn.ac.signal, kind: 'tool', canAlways: false, locale: lng });
    if (!answer.allow) throw new Error(agentT(lng, 'delegation.denied'));
  }
  return remoteDelegation.delegate({
    owner, turn, args, lng, signal: turn.ac.signal,
    askPermission: ({ plan, host }) => askPermission({ toolName: 'ply_delegate', input: args, sessionId: owner, signal: turn.ac.signal, kind: 'tool', canAlways: false, locale: lng,
      title: t('permission.delegateEscalationHost', { host, agent: plan.agent, mode: plan.mode, modeId: plan.modeId }) }),
  });
}

// ---- 委譲した子の設定を親が替える（ply_task_send の backend・model・effort。docs/agent-delegation.md「ツール」、ADR 0134）
const TASK_SETTINGS = ['backend', 'model', 'effort'];
/** 子のターンが始まるところ（引き継ぎの最中を含む）・分岐の最中。この間は子の設定を書かない（reserveTurnSettings も断る） */
const childStarting = sessionId => forking.has(sessionId) || (switching.has(sessionId) && !runtime.turns.has(sessionId));
/**
 * 替える内容を確かめて決める（まだ何も変えない）。断る理由はすべてここで見る: 自分が委譲した子か・止めている途中か・
 * 子のターンが始まるところか・message の形・モデルが子の作業場所の一覧にあるか・使用枠が満杯か・思考の強さを選べるか。
 * エージェントを替えるときの子の承認モードもここで決める（親の強さと、子の今の強さの弱い方まで。decided）。
 * 接続先は ply_delegate と同じ規則（自動・人が選んだ委譲先なら公式、固定なら親の会話から継ぐ）。アカウントは替えない（子の会話のまま。ADR 0094）。
 * key は計画の元にした状態（承認カードを待つ間に変わったかを見る）
 */
async function taskSettingsPlan(owner, args, lng, turn) {
  const task = agentTasks.get(String(args.taskId ?? ''));
  if (!task || task.parentSessionId !== owner) throw new Error(agentT(lng, 'tasks.notOwned'));
  if (task.status === 'cancelling') throw new Error(agentT(lng, 'tasks.stopping'));
  for (const k of TASK_SETTINGS) {
    if (args[k] !== undefined && (typeof args[k] !== 'string' || (k === 'backend' && !args[k]) || args[k].length > 200)) throw new Error(agentT(lng, 'tasks.textLength', { name: k, max: 200 }));
  }
  // 一緒に積む指示は、設定を書く前に agentTasks と同じ規則で確かめる（空白だけ・60,000 字を超える）
  if (args.message !== undefined && (typeof args.message !== 'string' || !args.message.trim() || args.message.length > 60000))
    throw new Error(agentT(lng, 'tasks.textLength', { name: 'message', max: 60000 }));
  const sessionId = task.sessionId;
  if (childStarting(sessionId)) throw new Error(agentT(lng, 'tasks.childStarting'));
  const meta = await store.get(sessionId);
  const source = refuseRetired(await resolveBackendForSession(sessionId));
  if (!source) throw new Error(agentT(lng, 'tasks.notOwned'));
  // 次のターンが走る先（予約があればそれ。予約はいつも backend を持つ）。替えるのはそこからの差分
  const reserved = meta.nextSettings?.backend ? getBackend(meta.nextSettings.backend) : null;
  const current = reserved ?? source;
  const target = args.backend !== undefined ? getBackend(args.backend) : current;
  if (!target) throw new Error(agentT(lng, 'delegation.backendDisabled'));
  const cwd = meta.nextSettings?.cwd ?? meta.cwd ?? task.cwd;
  const before = { backend: current.id, model: (reserved ? meta.nextSettings.model : meta.model) ?? '',
    effort: (reserved ? meta.nextSettings.effort : meta.effort) ?? '', mode: (reserved ? meta.nextSettings.mode : undefined) ?? meta.mode ?? '' };
  // 予約したエージェントを今の会話のエージェントへ戻すときは、子の会話の接続先・モデルに戻す
  let endpoint;
  if (target.id === current.id) endpoint = meta.nextSettings?.endpoint ?? meta.compatEndpoint ?? '';
  else if (target.id === source.id) endpoint = meta.compatEndpoint ?? '';
  else {
    const auto = ['auto', 'manual'].includes(task.routing?.mode);
    const parentBackend = await resolveBackendForSession(owner);
    endpoint = endpointCapable(target) && !auto ? delegatedEndpoint(parentBackend?.id, target.id, (await store.get(owner)).compatEndpoint ?? '') : '';
    if (endpoint && !(await compatEndpoints.has(endpoint, target.id))) throw new Error(agentT(lng, 'delegation.endpointDeleted'));
  }
  if (!endpointCapable(target)) endpoint = '';
  const model = args.model ?? (target.id === current.id ? before.model : target.id === source.id ? meta.model ?? ''
    : await resolveModel(null, undefined, target, cwd, endpoint));
  if (args.model !== undefined && !(await validModel(target, model, cwd, endpoint).catch(() => false))) {
    const known = endpoint ? [] : Object.keys(await target.models(cwd).catch(() => ({}))).filter(Boolean).slice(0, 30);
    throw new Error(agentT(lng, 'tasks.modelUnknown', { model, backend: target.id, models: known.join(', ') || '-' }));
  }
  // 使用枠が満杯と分かっているときだけ断る（取り置きが無い・古いだけでは断らない。固定の ply_delegate も使用量では断らない）
  const account = meta.nextSettings?.account ?? meta.claudeAccount ?? '';
  if (!endpoint && model) {
    const check = selectRetryAccount(checkCandidate(`${target.id}:${model}`, { usage: routingUsage.snapshot(), settings: routingSettingsCache, now: Date.now() }), target.id, target.id === 'claude' ? account : undefined);
    if (check.reason === 'quota_full') throw new Error(agentT(lng, 'tasks.quotaFull', { model, backend: target.id }));
  }
  if (args.effort !== undefined) {
    const choices = Object.keys(await effortOptions(target, model, cwd, await endpointRow(endpoint)));
    if (args.effort !== '' && !choices.includes(args.effort)) throw new Error(agentT(lng, 'tasks.effortUnknown', { effort: args.effort, backend: target.id, model: model || '-', choices: choices.filter(Boolean).join(', ') || '-' }));
  }
  const switching = target.id !== source.id;
  // 子の承認モード（エージェントを替えるとき）。上限は親の強さと、子の今の強さ（人が下げていればそれ）の弱い方
  let decided = null;
  if (switching) {
    const parent = modePosition(turn.backend.modes()[turn.info.mode]);
    const own = modePosition(source.modes()[meta.mode]);
    const cap = { scope: SCOPES[Math.min(scopeRank(parent.scope), scopeRank(own.scope))], autonomy: AUTONOMIES[Math.min(autonomyRank(parent.autonomy), autonomyRank(own.autonomy))],
      enforced: parent.enforced && own.enforced };
    decided = resolveDelegatedMode({ parentMode: 'cap', parentModes: { cap }, childModes: target.modes() });
  }
  const key = JSON.stringify([task.status === 'cancelling', meta.nextSettings ?? null, meta.model ?? '', meta.effort ?? '', meta.mode ?? '', source.id, target.id, model, args.effort ?? null, endpoint, account, decided?.mode ?? null, decided?.escalation ?? null]);
  return { task, sessionId, source, target, before, model, effort: args.effort, endpoint, account, cwd, switching, decided, key, modelGiven: args.model !== undefined };
}

/**
 * 決めた内容を子の会話とタスクの記録に入れ、message があれば積む。書くのはここだけで、順に
 * 子の会話の予約（nextSettings）→ タスクの記録（retarget）→ 指示（ply_task_send）。途中で失敗したら、書いた分を前に戻して断る。
 * 予約は子の次のターンから効き、走っているターンは止めない（エージェントの切り替えは引き継ぎ〈docs/backend-handoff.md〉で履歴を渡す）。
 * 予約がある間は子の走っているターンへ指示を途中送信しない（canSteerNotice）ので、一緒に積んだ指示は替えた後のターンで読まれる。
 * 全部書けたら、変更の記録を残し、同じエージェントのモデルは走っているターンにも即時に伝える（sessions.setModel と同じ。できるエージェントだけ）
 */
async function applyTaskSettings(owner, plan, lng, { message, signal } = {}) {
  const { sessionId, target, before } = plan;
  const mode = plan.decided?.mode;
  if (childStarting(sessionId)) throw new Error(agentT(lng, 'tasks.childStarting'));
  const prior = await store.get(sessionId);
  const priorNext = prior.nextSettings ?? null;
  const undoReserve = async () => {
    await store.setSessionData(sessionId, 'nextSettings', priorNext, { durable: true }).catch(() => {});
    emitGlobal({ type: 'nextSettings', sessionId, nextSettings: priorNext });
  };
  let next;
  try {
    next = await reserveTurnSettings({ sessionId, backend: target.id, model: plan.model,
      ...(plan.effort !== undefined ? { effort: plan.effort } : {}), ...(plan.switching && mode ? { mode } : {}),
      ...(target.id !== before.backend ? { endpoint: plan.endpoint } : {}), keepPrefs: true });
  } catch (e) {
    await undoReserve();
    throw new Error(agentT(lng, 'tasks.settingsFailed', { error: String(e?.message ?? e) }));
  }
  const now = await store.get(sessionId);
  // 子が次に走る値。承認モードは予約が無ければ子の会話の今のもの（元のエージェントへ戻したときも、タスクの mode をこれに合わせる）
  const after = next ? { backend: next.backend, model: next.model ?? '', effort: next.effort ?? '', mode: next.mode ?? now.mode ?? '' }
    : { backend: plan.source.id, model: now.model ?? '', effort: now.effort ?? '', mode: now.mode ?? '' };
  let retargeted = null, result;
  try {
    retargeted = await agentTasks.retarget(owner, plan.task.taskId, { ...after, account: after.backend === 'claude' ? plan.account : null }, lng);
    result = message === undefined ? retargeted.task : await agentTasks.call(owner, 'ply_task_send', { taskId: plan.task.taskId, message }, signal, lng);
  } catch (e) {
    if (retargeted?.changed) await agentTasks.untarget(plan.task.taskId, retargeted.previous).catch(() => {});
    await undoReserve();
    throw e;
  }
  // ここから先は断らない（起きたことの記録と、即時のモデル）
  const actor = { by: 'agent', via: 'mcp', sessionId: owner };
  const reason = savedReason('parentChanged');
  const who = changeBy(actor);
  for (const field of TASK_SETTINGS) {
    if (before[field] === after[field]) continue;
    await store.recordChange(sessionId, { ...who, field, from: before[field], to: after[field], ...reason, backend: plan.source }).catch(() => {});
  }
  let live = false;
  const liveTurn = runtime.turns.get(sessionId);
  if (!plan.switching && plan.modelGiven && after.model && after.model !== (prior.model ?? '') && liveTurn?.control.handle && target.setModelLive) {
    live = await target.setModelLive(liveTurn.control.handle, after.model).catch(() => false);
    if (live) { await store.setModel(sessionId, after.model).catch(() => {}); emitGlobal({ type: 'model', sessionId, model: after.model, by: who.by, live }); }
  }
  if (retargeted.changed) {
    if (retargeted.task.routing) await store.setSessionData(sessionId, 'routing', retargeted.task.routing).catch(() => {});
    emitGlobal({ type: 'agentTaskChanged', sessionId: null, taskId: plan.task.taskId });
  }
  // 即時に伝わったのはモデルだけ。ほかは子の次のターンから（走っていなければ、次に走るとき）
  return { ...result, settings: { ...after, appliesTo: 'nextTurn', ...(live ? { modelLive: true } : {}) } };
}

// ---- 端末の AI からの委譲（ホストの側。docs/remote.md §4.5、docs/agent-delegation.md「リモートのホストへ任せる」、ADR 0146）------------
// 端末（リモートでつないだデスクトップ版）の会話の AI が、ply_delegate の host と ply_task_* でこのホストの Pleiad に仕事を任せる。
// 口は接続口の /agent（core/remote/agent-port.mjs。端末ごとの許可・上限はそこ）。ここは口から呼ばれる委譲の本体で、手元の callAgentOp と同じ規則を使う:
// 子の承認モードは依頼元（端末の会話）の位置までを継ぎ（resolveDelegatedMode）、引き上げが要るときは子を作らずに計画を返して端末で確かめさせる。
// 依頼元の会話はホストに無いので、タスクの親は仮の ID（remote:<deviceId>:<端末の会話>。agent-protocol.mjs）。
const REMOTE_DELEGATE_KEYS = ['kind', 'task', 'title', 'backend', 'context', 'cwd', 'model', 'effort', 'isolate'];
const REMOTE_TASK_TOOLS = { status: 'ply_task_status', wait: 'ply_task_wait', send: 'ply_task_send', cancel: 'ply_task_cancel', list: 'ply_task_list' };
const REMOTE_ACTIVE = new Set(['queued', 'running', 'cancelling']);
const remoteRowsOf = deviceId => agentTasks?.rowsWhere(r => parseRemoteOwner(r.parentSessionId)?.deviceId === deviceId) ?? [];
/** 端末から任された子と、その子がホストの中で作った孫・ひ孫（止める・数えるのはこの全部。ADR 0146） */
const remoteTreeOf = deviceId => {
  const roots = remoteRowsOf(deviceId);
  return [...roots, ...(agentTasks?.descendants(roots.map(r => r.sessionId)) ?? [])];
};
const remoteWaiting = row => REMOTE_ACTIVE.has(row.status) && Boolean(row.sessionId) && blockingWaits().some(w => w.payload.sessionId === row.sessionId);

/** 端末へ便りで知らせるタスクの形（task の便り。agent_tasks の行から、依頼文・振り分けの内訳を除いたもの） */
function remoteTaskEvent(row) {
  const parsed = parseRemoteOwner(row.parentSessionId);
  const waiting = remoteWaiting(row);
  return {
    taskId: row.taskId, requesterSessionId: parsed?.sessionId ?? null, title: row.title ?? null,
    status: waiting ? 'waiting' : row.status, rawStatus: row.status, notification: row.notification ?? null,
    backend: row.backend ?? null, model: row.model ?? null, effort: row.effort ?? null, mode: row.mode ?? null, cwd: row.cwd ?? null,
    sessionId: row.sessionId ?? null, createdAt: row.createdAt ?? null, updatedAt: row.updatedAt ?? null,
    error: row.error ? String(row.error).slice(0, 500) : null, instructionRevision: row.instructionRevision ?? 0,
    // 完了通知（deliver）には記録の行そのもの（結果の全文・instructions）が来て、一覧（agentTasks.list）には view（結果の最初のページ・pendingMessages）が来る。どちらも同じ形にする
    pendingMessages: row.pendingMessages ?? (row.instructions ?? []).filter(x => x.state === 'queued').length,
    // 結果は終わったときだけ最初のページを載せる。続きは端末が status の offset で読む
    result: REMOTE_ACTIVE.has(row.status) ? '' : String(row.result ?? '').slice(0, RESULT_PAGE), resultLength: row.resultLength ?? String(row.result ?? '').length,
    worktree: row.worktree ? { id: row.worktree.id, branch: row.worktree.branch, path: row.worktree.path, origin: row.worktree.origin } : null,
    routing: row.routing ? { kind: row.routing.kind ?? null, mode: row.routing.mode ?? null, backend: row.routing.target?.backend ?? null, model: row.routing.target?.model ?? null } : null,
  };
}

const remotePushed = new Map();   // taskId → 最後に端末へ知らせたときの署名（変わったときだけ知らせる）
let remotePushTimer = null, remoteStatsSignature = '[]';
/** 任された作業の状態が変わった。つながっている端末へ、変わった行だけ知らせる（まとめて 1 回） */
function remoteTasksChanged() {
  if (remotePushTimer || !agentTasks) return;
  remotePushTimer = setTimeout(() => {
    remotePushTimer = null;
    try {
      const counts = new Map();
      for (const row of agentTasks.rowsWhere(r => isRemoteOwner(r.parentSessionId))) {
        const parsed = parseRemoteOwner(row.parentSessionId);
        if (!parsed) continue;
        const event = remoteTaskEvent(row);
        if (REMOTE_ACTIVE.has(row.status)) { const n = counts.get(parsed.deviceId) ?? [0, 0]; n[0]++; if (event.status === 'waiting') n[1]++; counts.set(parsed.deviceId, n); }
        const signature = JSON.stringify([event.status, event.updatedAt, event.instructionRevision, event.resultLength, event.error, event.pendingMessages]);
        if (remotePushed.get(row.taskId) !== signature && remoteAgentPort.pushTask(parsed.deviceId, event)) remotePushed.set(row.taskId, signature);
      }
      // 設定 › リモートの端末の行の「任された作業 N・承認待ち M」。数が変わったときだけ配り直す
      const sig = JSON.stringify([...counts].sort());
      if (sig !== remoteStatsSignature) { remoteStatsSignature = sig; remote.touchStatus(); }
    } catch (e) { console.error('  任された作業の状態を端末へ知らせられなかった:', String(e?.message ?? e)); }
  }, 30);
  remotePushTimer.unref?.();
}

/** 完了通知の代わり。依頼元（端末）へ最後の状態を便りで届ける。端末がつながっていなければ requeue（つながり直したとき届ける） */
async function remoteDeliver(tasks) {
  const deviceId = parseRemoteOwner(tasks[0].parentSessionId)?.deviceId;
  if (!deviceId || !remoteAgentPort.online(deviceId)) return 'requeue';
  for (const task of tasks) remoteAgentPort.pushTask(deviceId, remoteTaskEvent(task));
  return 'ok';
}

/** 口の委譲の本体。device は { id, name, platform }、requester は端末の会話（normalizeRequester の形）。AgentError か Error を投げる */
async function remoteAgentInvoke({ device, requester, op, args, signal, valid = () => true }) {
  const lng = agentLocaleOf(requester.locale) ?? currentLocale();
  const owner = remoteOwnerId(device.id, requester.sessionId);
  if (op === 'delegate') return remoteDelegate({ device, requester, args, signal, lng, owner, valid });
  if (op === 'send') {
    if (!canDelegate(requester.mode)) throw new AgentError('READ_ONLY_MODE', agentT(lng, 'delegation.readOnly'));
    // 子の設定を替える（backend・model・effort。ADR 0134）は、初版ではホストのタスクに使えない
    if (TASK_SETTINGS.some(k => args[k] !== undefined)) throw new AgentError('UNSUPPORTED', agentT(lng, 'delegation.remote.settingsUnsupported'));
  }
  const clean = {};
  for (const k of ['taskId', 'offset', 'seconds', 'message']) if (args[k] !== undefined) clean[k] = args[k];
  const out = await agentTasks.call(owner, REMOTE_TASK_TOOLS[op], clean, signal, lng);
  // 許可を切る・取り消す・すべて止めるが、確かめた後に入っていたら、起こした子を止める
  if (op === 'send' && !valid()) { await agentTasks.cancel(String(clean.taskId)).catch(() => {}); throw new AgentError('NOT_ALLOWED', agentT(lng, 'delegation.remote.cutOff')); }
  // 端末が写している行を更新できるよう、タスクの今の状態を添える（ply_task_list は行の配列なので添えない）
  if (op !== 'list' && out?.taskId) { const row = agentTasks.get(out.taskId); if (row) return { ...out, task: remoteTaskEvent(row) }; }
  return out;
}

async function remoteDelegate({ device, requester, args, signal, lng, owner, valid = () => true }) {
  if (!canDelegate(requester.mode)) throw new AgentError('READ_ONLY_MODE', agentT(lng, 'delegation.readOnly'));
  if (!valid()) throw new AgentError('NOT_ALLOWED', agentT(lng, 'delegation.remote.cutOff'));
  // 端末が余計な項目（remote など）を足しても通さない
  const clean = {};
  for (const k of REMOTE_DELEGATE_KEYS) if (args[k] !== undefined) clean[k] = args[k];
  if (clean.isolate !== undefined && typeof clean.isolate !== 'boolean') throw new Error(agentT(lng, 'tasks.isolateInvalid'));
  // 作業場所はホストのパスとホストの規則で解釈する（省けばホストのホーム）。端末の cwd は使わない
  const cwd = path.resolve(os.homedir(), typeof clean.cwd === 'string' && clean.cwd.trim() ? clean.cwd : '.');
  const routed = await routeDelegation(clean, lng, cwd);
  const child = getBackend(routed.backend);
  if (!child) throw new Error(agentT(lng, 'delegation.backendDisabled'));
  // 子の承認モードは依頼元（端末の会話）の位置まで継ぐ。手元の委譲と同じ resolveDelegatedMode（上限はホスト側に持たない）
  const decided = resolveDelegatedMode({ parentMode: 'cap', parentModes: { cap: requester.mode }, childModes: child.modes() });
  if (decided.escalation) {
    // 引き上げが要る（収まる委譲先が無い・範囲を強制できないエンジンに確認なしを渡す）。子は作らず、端末の依頼元の会話で 1 回だけ確かめさせる
    const key = crypto.createHash('sha256').update(JSON.stringify([child.id, decided.mode, requester.mode.scope, requester.mode.autonomy, requester.mode.enforced])).digest('hex').slice(0, 24);
    if (args.confirm !== key) return { plan: { key, backend: child.id, agent: child.label, mode: child.modes()[decided.mode]?.label ?? decided.mode, modeId: decided.mode } };
  }
  const verdict = await worktreeHost.decideIsolation({ cwd, isolate: clean.isolate });
  const row = await agentTasks.call(owner, 'ply_delegate', {
    ...routed, cwd, isolate: verdict.isolate, ...(decided.mode ? { mode: decided.mode } : {}),
    remote: { deviceId: device.id, deviceName: device.name, sessionId: requester.sessionId, title: requester.title, locale: lng, mode: requester.mode },
  }, signal, lng);
  // 子を作っている間に、許可を切る・取り消す・すべて止めるが入っていたら、できた子を止めて断る（端末は子の ID を知らないまま、誰も追わない子を走らせない）
  if (!valid()) { await agentTasks.cancel(row.taskId).catch(() => {}); throw new AgentError('NOT_ALLOWED', agentT(lng, 'delegation.remote.cutOff')); }
  if (row.sessionId) store.recordChange(row.sessionId, { by: 'agent', via: 'remote', byDevice: device.id, field: 'op', to: 'delegation.delegate', reason: null }).catch(() => {});
  if (routingSettingsCache.enabled && ROUTING_USAGE_AUTO) routingUsage.refresh().catch(() => {});
  const stored = agentTasks.get(row.taskId);
  return { task: remoteTaskEvent(stored ?? row) };
}

// 経過の読み出し（口の view。人の操作）。この端末が任せた子とその子孫だけを読む。残すのは最初の 1 回の「読んだ」だけ（会話の中身は残さない）
const remoteViewSeen = new Set();   // `${deviceId}:${taskId}`。最初の 1 回だけ子の会話の変更の記録へ残す
function remoteViewRecorded(entry) {
  const key = `${entry.deviceId}:${entry.taskId}`;
  if (remoteViewSeen.has(key)) return;
  remoteViewSeen.add(key);
  if (remoteViewSeen.size > 2000) remoteViewSeen.delete(remoteViewSeen.values().next().value);
  const sessionId = agentTasks?.get(String(entry.taskId))?.sessionId;
  if (sessionId) store.recordChange(sessionId, { by: 'human', via: 'remote-device', byDevice: entry.deviceId, field: 'op', to: 'delegation.view', reason: null }).catch(() => {});
}
/**
 * 子孫の要約（端末の一覧へ字下げの行で出す分）と、読み出しの答えの task。題・状態・親だけで、結果・作業場所は載せない。
 * 依頼文も載せないが、題の無い子は依頼文の最初の行（80 字）を題にする（一覧の行の名前。docs/remote.md §4.5）
 */
function remoteDescendantEvent(row, parentTaskId) {
  const ev = remoteTaskEvent(row);
  const first = String(row.task ?? '').split('\n').find(line => line.trim())?.trim().replace(/\s+/g, ' ') ?? '';
  return { taskId: ev.taskId, parentTaskId, sessionId: ev.sessionId, title: ev.title ? String(ev.title).slice(0, 200) : (first.slice(0, 80) || null), status: ev.status, rawStatus: ev.rawStatus,
    backend: ev.backend, model: ev.model, effort: ev.effort, createdAt: ev.createdAt, updatedAt: ev.updatedAt, error: ev.error };
}
/**
 * 端末の画面の経過の読み出し（口の view。docs/remote.md §4.5「経過の読み出し」、ADR 0146）。見せる範囲は、この端末が任せた子（remoteRowsOf）とその子孫だけ。
 * 読むだけ。末尾 40 発言・ツールの出力 1 つ 2 KB・考えた内容 4 KB・画像と添付は枠だけ・発言 1 件 48 KB・答え全体を口の上限の内側に絞って返す
 * （core/remote/agent-view.mjs）。task は子孫の要約と同じ形（結果・作業場所は運ばない。端末は一覧の行の状態を替えるだけに使う）。
 * 走っているターンは、手元の委譲の詳細と同じく履歴＋出来事の畳み込み（streamMessages）を 1 つの発言の並びにして返す。cursor は続きの位置（発言の位置と先頭の署名）
 */
async function remoteAgentView({ device, taskId, cursor }) {
  const tree = remoteTreeOf(device.id);
  const row = tree.find(r => r.taskId === taskId);
  if (!row) throw new AgentError('NOT_FOUND', 'no such task');
  let all = [];
  const sessionId = row.sessionId;
  if (sessionId) {
    const turn = runtime.turns.get(sessionId);
    if (turn) {
      const live = turn.stream;
      all = [...live.messages, ...(live.user ? [live.user] : []), ...streamMessages(live.events, { backend: row.backend, model: row.model, initialMessageId: live.initialMessageId }).messages];
    } else {
      all = (await history.loadTranscript(sessionId, await resolveBackendForSession(sessionId))).messages;
    }
  }
  const subs = sessionId ? (agentTasks.descendants([sessionId]) ?? []) : [];
  const taskBySession = new Map([...tree.filter(r => r.sessionId).map(r => [r.sessionId, r.taskId]), ...subs.map(r => [r.sessionId, r.taskId])]);
  // 子孫の要約は、走っているもの・新しいものを優先して 40 件まで。省いた件数も返す
  const picked = pickDescendants(subs, { isLive: r => REMOTE_ACTIVE.has(r.status) });
  return viewAnswer(all, cursor, {
    // 根の親は仮の親（remote:<deviceId>:…）なので null になる
    task: remoteDescendantEvent(row, taskBySession.get(row.parentSessionId) ?? null),
    sessionId: sessionId ?? null,
    instructions: viewInstructions(agentTasks.instructions(row.taskId)?.instructions),
    descendants: picked.rows.map(r => remoteDescendantEvent(r, taskBySession.get(r.parentSessionId) ?? null)),
    descendantsOmitted: picked.omitted,
    waiting: remoteWaiting(row),
  });
}

/** 端末ごとの、任された作業の数（設定 › リモートの端末の行）。active は動いているもの（任された子の子孫も数える）、waiting はそのうち承認待ち */
function remoteAgentStats(deviceId) {
  const rows = remoteTreeOf(deviceId).filter(r => REMOTE_ACTIVE.has(r.status));
  return { active: rows.length, waiting: rows.filter(remoteWaiting).length };
}
/**
 * この端末から任された作業をすべて止める（「すべて止める」・端末の取り消し）。任された子とその子孫のすべて（終わった子の下で動いている孫も）を止め、
 * 子の会話は「止めた」印を付ける（あとから届く孫の完了通知で新しいターンを始めない）。作りかけの依頼は打ち切る（子を作らせない）
 */
async function remoteAgentStopAll(deviceId) {
  remoteAgentPort.cutOff(deviceId);
  const roots = remoteRowsOf(deviceId).filter(r => r.sessionId);
  const now = new Date().toISOString();
  for (const row of roots) {
    const delegation = (await store.get(row.sessionId).catch(() => ({}))).delegation;
    if (delegation?.remote && !delegation.remote.stoppedAt) await store.setSessionData(row.sessionId, 'delegation', { ...delegation, remote: { ...delegation.remote, stoppedAt: now } }, { durable: true }).catch(() => {});
  }
  // 状態によらず、任された子ごとに cancel を呼ぶ（cancel は子孫へ連鎖する。終わった子の孫も止まる）。子の会話の今のターンも止める
  for (const row of remoteRowsOf(deviceId)) {
    if (row.sessionId) runtime.turns.get(row.sessionId)?.ac.abort();
    await agentTasks.cancel(row.taskId).catch(() => {});
  }
}

const agentOpIds = {
  ply_delegate: 'delegation.delegate', ply_task_status: 'delegation.taskStatus', ply_task_wait: 'delegation.taskWait',
  ply_task_send: 'delegation.taskSend', ply_task_cancel: 'delegation.taskCancel', ply_task_list: 'delegation.taskList', ply_usage: 'delegation.usage',
};
const agentBridge = createAgentBridge({ call: async (owner, name, args, { locale } = {}) => {
  const result = await opsRegistry.invoke({ by: 'agent', via: 'mcp', sessionId: owner }, agentOpIds[name], args, opsDeps(locale));
  if (!result.ok) throw new Error(result.error);
  return result.result;
},
// ply_delegate の host に書けるホスト（端末側・ホスト側の両方がオンのもの。オフラインの印つき）。無ければ host の引数自体を出さない
hosts: () => remoteDelegation?.describe() ?? [] });

// ---- 委譲先の自動振り分け ------------------------------------------------------
// 設定は prefs.json の delegationRouting（未設定の項目は既定値）。判定器が使うキーは設定 › API キー（core/api-keys.mjs）で選んだもの
// （uses の judge:jev・judge:cerebras）で、画面へは hasKey と選んだキーの id（keyRef）だけ返す。選ぶまでは何も送らない
let routingSettingsCache = normalizeSettings((await store.getPrefs()).delegationRouting);
// Pleiad の指示（core/ply-instructions.mjs）。prefs.json の plyInstructions。まだ無ければ前の版の addedContext（委譲の指示のスイッチ）から作る
let plyInstructionsCache = await (async () => { const prefs = await store.getPrefs(); return normalizePlyInstructions(prefs.plyInstructions, prefs.addedContext); })();
/** 設定 › コンテキストの「Pleiad の指示」。文は画面の言語。委譲と連動の項目は今の委譲先の自動選択の有無を反映する */
const plyInstructionsState = () => plyInstructionsScreen(plyInstructionsCache, currentLocale(), { routing: routingSettingsCache.enabled });
const ROUTING_SERVICES = Object.values(JUDGE_SERVICE);
const routingKey = service => apiKeys.useKey(`judge:${ROUTING_JUDGE[service]}`);
/** API キー・割り当てが変わったとき（core/api-keys.mjs の onChange）。使う側の画面と通話のキーを更新する */
function apiKeysChanged(change = {}) {
  emitGlobal({ type: 'apiKeysChanged', sessionId: null });
  const uses = change.uses ?? [];
  if (uses.includes('voice')) { voiceHost.keysChanged().catch(() => {}); emitGlobal({ type: 'voiceChanged', sessionId: null }); }
  if (uses.some(u => u.startsWith('judge:'))) emitGlobal({ type: 'delegationRoutingChanged', change: 'settings', sessionId: null });
  if (change.endpoints) emitGlobal({ type: 'compatEndpointsChanged', sessionId: null });
}
/**
 * 古い口（setVoiceKey・setDelegationRoutingKey）の中身。移行済みなら API キーに登録して使うキーに選ぶ（同じ値があれば再利用）、
 * 移行を保留している間は古い置き場へ直に書く。key が null なら使わない
 */
async function legacyUseKey(use, service, key) {
  if (!(await apiKeys.migrated())) {
    const store = use === 'voice' ? voiceSecrets : compatSecrets;
    const name = use === 'voice' ? 'openrouter' : `delegation-routing:${service}`;
    if (key) await store.set(name, { key }); else await store.delete(name);
    return;
  }
  if (!key) { await apiKeys.setUse(use, null); return; }
  const provider = use === 'judge:cerebras' ? 'cerebras' : 'openrouter';
  const id = await apiKeys.findByValue(provider, key) ?? (await apiKeys.add({ provider, label: '', key })).id;
  await apiKeys.setUse(use, id);
}
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
  const has = await Promise.all(ROUTING_SERVICES.map(s => apiKeys.hasUse(`judge:${ROUTING_JUDGE[s]}`).catch(() => false)));
  const refs = apiKeys.usesState();
  const storage = await apiKeySecrets.status().catch(() => null);
  return { settings, defaults: normalizeSettings({}), kinds: KINDS, judges: JUDGES, tiers: TIERS, signals: SIGNALS,
    keys: Object.fromEntries(ROUTING_SERVICES.map((s, i) => [s, { hasKey: has[i], keyRef: has[i] ? refs[`judge:${ROUTING_JUDGE[s]}`] ?? null : null }])),
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
  // ホストに任せたタスクは、手元でやり直さない（作業場所はホストのパスで、子はホストにある）
  if (original.host) throw new Error(t('delegation.retryRemote'));
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
  attachAgentsPort(entry);
  entry.contextToken = crypto.randomBytes(32).toString('hex');
  agentConnections.set(entry.key, entry);
  return entry;
}

/** 会話の橋（ply_agents）を開いて entry に付ける。token があれば、その値で開き直す（restoreConnection） */
function attachAgentsPort(entry, token) {
  const binding = agentBridge.open({ origin: localOrigin(), locale: entry.locale, token,
    owner: async () => {
      const live = runtime.turns.get(entry.key);
      if (!live) throw new Error(agentT(entry.locale, 'delegation.notRunning'));
      await live.setup;
      if (!live.info.sessionId) throw new Error(agentT(entry.locale, 'delegation.idPending'));
      return live.info.sessionId;
    } });
  const { close, ...agentRuntime } = binding;
  entry.runtime = agentRuntime;
  entry.close = close;
}

/** 札へ入れる、会話の口のトークン（開いていない口は null）。restoreConnection に渡す形 */
function connectionTokens(entry) {
  const bearer = (port) => /^Bearer ([a-f0-9]{64})$/.exec(port?.headers?.Authorization ?? '')?.[1] ?? null;
  return { agents: bearer(entry.runtime), computer: bearer(entry.computer), browser: bearer(entry.browser), control: entry.control?.token ?? null, context: entry.contextToken ?? null };
}

/**
 * 札の項目から会話の口を戻す（無停止の更新。新しいサーバーが、CLI の持つ URL・ヘッダーをそのまま通す）。
 * entry は { key, sessionId, locale, tokens: connectionTokens の形, computerBackend }。開いていなかった口は開かない。
 * 今ある口は上書きしない（登録済みの key は投げる）。トークンの形が違う・他の会話が使っている値なら、開いた分を閉じて投げる
 */
function restoreConnection(entry) {
  const { key, sessionId = null, locale, tokens = {}, computerBackend } = entry ?? {};
  if (typeof key !== 'string' || !key) throw new Error('Invalid connection key');
  if (agentConnections.has(key)) throw new Error('Connection already restored');
  // ply_context の口は会話のあいだ同じ値で開くので、口の側には衝突の検査が無い。ここで形と他の会話との重なりを見る
  if (typeof tokens.context !== 'string' || !/^[a-f0-9]{64}$/.test(tokens.context)) throw new Error('Invalid token');
  for (const other of agentConnections.values()) if (other.contextToken === tokens.context) throw new Error('Token already in use');
  const restored = { key, locale, sessionId };
  try {
    attachAgentsPort(restored, tokens.agents);
    restored.contextToken = tokens.context;
    if (tokens.browser) restored.browser = browserBridge.open({ origin: localOrigin(), locale, owner: () => restored.key, token: tokens.browser });
    if (tokens.control) restored.control = openControlPort(restored, tokens.control);
    if (tokens.computer) {
      const backend = getBackend(computerBackend);
      if (!computerBridge || !backend) throw new Error('Computer use is not available');
      restored.computerBackend = backend.id;
      restored.computer = openComputerPort(restored, backend, tokens.computer);
    }
  } catch (e) {
    try { restored.close?.(); } catch {}
    try { restored.browser?.close(); } catch {}
    try { restored.control?.close(); } catch {}
    try { restored.computer?.close(); } catch {}
    throw e;
  }
  agentConnections.set(key, restored);
  return restored;
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
  entry.computer = openComputerPort(entry, turn.backend);
  return entry.computer;
}
/** ply_computer の口を開く。token があれば、その値で開き直す（restoreConnection） */
function openComputerPort(entry, backend, token) {
  return computerBridge.open({ origin: localOrigin(), locale: entry.locale, delivery: backend.capabilities?.computerUse || undefined, token,
    agent: () => { const live = runtime.turns.get(entry.key); const b = live?.backend ?? backend; return { id: b.id, label: b.label }; },
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
}

// ---- ply_browser（エージェントのブラウザー操作の口。core/browser-bridge.mjs、ADR 0148）。ツールはまだ載せていない ----------------------------
const browserBridge = createBrowserBridge();
/** このターンに渡す ply_browser（url・headers）。会話のあいだ同じ口を使う（agy は起動時にしか渡せない） */
function browserRuntimeFor(turn) {
  const entry = conversationConnection(turn);
  entry.browser ??= browserBridge.open({ origin: localOrigin(), locale: entry.locale, owner: () => entry.key });
  return { url: entry.browser.url, headers: entry.browser.headers };
}

// ply_control: 操作の一覧（core/ops/）を会話に渡す HTTP の MCP（ADR 0081）。会話に束縛し、その会話の承認モードで権限が決まる（ADR 0082）
const controlBridge = createControlBridge({ registry: opsRegistry, depsFor: opsDeps });
// CLI 用トークン（control.json に書く。画面のトークンとは別で、効くのは /api/ops だけ。ADR 0083）
const CLI_TOKEN = handoverStash?.cliToken ?? crypto.randomBytes(32).toString('hex');
const cliTokenOk = (given) => { const a = Buffer.from(String(given)), b = Buffer.from(CLI_TOKEN); return a.length === b.length && crypto.timingSafeEqual(a, b); };
const opsHttp = createOpsHttp({
  registry: opsRegistry, depsFor: opsDeps, serverLocale: currentLocale,
  // 会話に束縛した接続のトークン（会話のシェルの環境変数）は、同じ会話に束縛された CLI になる
  authenticate: (token) => { if (cliTokenOk(token)) return {}; const bound = controlBridge.lookup(token); return bound ? { owner: bound.owner, locale: bound.locale } : null; },
});
/** ply_control の口を開く。token があれば、その値で開き直す（restoreConnection） */
function openControlPort(entry, token) {
  return controlBridge.open({ origin: localOrigin(), locale: entry.locale, token,
    // 会話の id が決まるまでは束縛を決められない。束縛なしの主体として通すと、読み取りの会話からの書き込みを断れなくなるので投げる
    owner: async () => {
      const live = runtime.turns.get(entry.key);
      if (live) { await live.setup; if (live.info.sessionId) return live.info.sessionId; }
      else if (entry.sessionId) return entry.sessionId;
      throw new Error(agentT(entry.locale, 'delegation.idPending'));
    } });
}
/** このターンに渡す ply_control（url・headers・instructions）と、会話のシェルへ渡す環境変数（CLI を同じ会話に束縛する）。全会話・3 つのエージェントに渡す */
function controlRuntimeFor(turn) {
  const entry = conversationConnection(turn);
  entry.control ??= openControlPort(entry);
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

/** 今の cwd が会話の予約・どれかの会話が使った場所・worktree のどれかか（画面が言ってきた場所で git を走らせてよいか） */
async function knownCwd(cwd, sessionId = null) {
  const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
  if (await worktreeHost.worktrees.byPath(cwd).catch(() => null)) return true;
  if (sessionId) { const reserved = (await store.get(sessionId).catch(() => null))?.nextSettings?.cwd; if (reserved && same(reserved, cwd)) return true; }
  const known = Object.values(await store.getAll().catch(() => ({}))).flatMap(s => [s.cwd, ...(s.history ?? []).filter(h => h.field === 'cwd').map(h => h.to)]).filter(Boolean);
  return known.some(k => same(k, cwd));
}
/** worktree の問い合わせの cwd。明示があれば（知っている場所なら）それ、無ければ会話の cwd */
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

/** git の問い合わせの作業場所。worktree が言われたら、この会話のリポジトリの git worktree の一覧にあるものだけ（任意の場所は通さない） */
async function gitWorktreeCwd(args) {
  const cwd = await gitCwd(args);
  const asked = typeof args?.worktree === 'string' && args.worktree ? args.worktree : null;
  if (!cwd || !asked) return cwd;
  const info = await gitInfo.repoInfo(cwd);
  const list = info ? await worktreeList(info.root) : null;
  return list?.find(w => sameDir(w.path, asked))?.path ?? null;
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

// 引き継ぎ（無停止の更新 2d。core/handover.mjs）。hold: 新しい作業の開始を送信待ちに回している間（送信待ちは始まらず、完了通知・追加指示は渡さない）。
// critical: 引き継ぎの前に終わるのを待つ短い処理（途中送信の受理待ち）。inflight: 処理中の HTTP の MCP・in-process の host MCP・hooks のコールバック
// （待つのは上限つきで、待ち切れなくても進む。その呼び出しは 1 回失敗し、モデルが読んでやり直す）
const handover = { hold: false, critical: new Set(), inflight: new Set(), droppedCalls: 0 };
const trackIn = (set, promise) => {
  const tracked = Promise.resolve(promise);
  set.add(tracked);
  const done = () => set.delete(tracked);
  tracked.then(done, done);
  return promise;
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname === AGENTS_MCP_PATH) return trackIn(handover.inflight, agentBridge.handle(req, res));
  if (url.pathname === CONTEXT_MCP_PATH) return trackIn(handover.inflight, contextBridge.handle(req, res));
  if (url.pathname === COMPUTER_MCP_PATH && computerBridge) return trackIn(handover.inflight, computerBridge.handle(req, res));
  if (url.pathname === BROWSER_MCP_PATH) return trackIn(handover.inflight, browserBridge.handle(req, res));
  if (url.pathname === CONTROL_MCP_PATH) return trackIn(handover.inflight, controlBridge.handle(req, res));
  // CLI の口。画面のトークンは受けず、CLI 用トークンか会話の接続のトークンだけを受ける（core/ops/surfaces/http.mjs）
  if (url.pathname === OPS_PATH || url.pathname.startsWith(`${OPS_PATH}/`)) return opsHttp(req, res, url);
  // webhook の受け口（P3。/hooks/<id>。画面のトークンの前。ADR 0113）。自分の要求でなければ false
  if (await botHost?.handleHttp(req, res)) return;

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
    let body = await fs.readFile(file);
    // 画面を配った版。web/client.mjs が ready の版と比べ、違えば 1 回だけ読み直す（docs/zero-downtime-update/design.md §8）
    if (rel === 'index.html') body = Buffer.from(String(body).replace('<meta name="pleiad-build" content="">', `<meta name="pleiad-build" content="${APP_VERSION}+${BUILD ?? ''}">`));
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
  if (url.pathname !== "/ws" && url.pathname !== VOICE_PATH) return socket.destroy();
  if (!tokenOk(url.searchParams.get("token"))) {
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    return socket.destroy();
  }
  if (url.pathname === VOICE_PATH) return voiceHost.upgrade(req, socket, head);   // 通話の音声（バイナリ）。/ws とは別の口
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});

// ---- セッション一覧 ---------------------------------------------------------

const toMs = (v) => (Number.isFinite(v) ? v : (v ? Date.parse(v) || null : null));

// ---- 中断と再開（docs/design.md「中断と再開」・ADR 0036） ----------------------------
// 中断の理由。user = 中断ボタン、update = 更新のため、quit = 終了のため、hostAway = ホスト不在の猶予切れ、
// restart = Pleiad が落ちた・強制終了で終わりが記録されていないターン（起動時に store.recoverInterruptedTurns が付ける）、
// timeout = ルーティンの承認待ちが期限（approvalTimeoutMin）を過ぎて止めた（ADR 0112）
const INTERRUPT_REASONS = new Set(["user", "update", "quit", "hostAway", "restart", "limit", "timeout"]);
// abort で画面・デスクトップ・ルーティンが渡せる理由。ほかの値（不正・省略）は user として扱う
const ABORT_REASONS = new Set(["user", "update", "quit", "timeout"]);
const abortReason = (value) => (ABORT_REASONS.has(value) ? value : "user");
/** 保存された中断の印を、画面へ渡す形 { at, reason } に揃える。形が崩れていれば null */
function interruptedOf(value) {
  if (!value || typeof value !== "object" || !Number.isFinite(value.at)) return null;
  return { at: value.at, reason: INTERRUPT_REASONS.has(value.reason) ? value.reason : "user",
    ...(value.reason === 'limit' ? { resetsAt: Number.isFinite(value.resetsAt) ? value.resetsAt : null,
      window: value.window ?? null, account: value.account ?? null, backend: value.backend ?? null,
      model: value.model ?? null, autoResume: value.autoResume === true } : {}) };
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
 * worktree の中で動いている会話の行に、元の場所と枝分かれの印を足す（ADR 0089）。行の場所は元の場所の名前で出し、
 * 最近の場所の候補（place）にも worktree のパスを並べない。sessionRow は台帳を知らない純粋な組み立てのまま
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
    // bot の会話（Chats の一覧には出さない。あなた待ちの間だけ出る。ADR 0109）。bot でなければ null
    bot: extra.bot ? { botId: extra.bot.botId, kind: extra.bot.kind, channelId: extra.bot.channelId ?? null, threadId: extra.bot.threadId ?? null } : null,
    hasDraft: Boolean(extra.draft?.text || extra.draft?.attached?.length),
    historyCount: (extra.history ?? []).length,
    // 人が host で作業ディレクトリを変えたなら sidecar が正本（ネイティブは古い cwd を返しうる）。
    // 変えていなければネイティブ優先（公式 CLI で移した分も拾える）
    cwd: ((extra.history ?? []).some((h) => h?.field === "cwd") ? extra.cwd ?? s?.cwd : s?.cwd ?? extra.cwd) ?? null,
    // 最近の場所の候補（ユーザーが Pleiad で使った場所。委譲の子会話やネイティブのみの会話は除外）
    // 隠れた bot の会話（夜の整理・心拍。cwd はホーム）は利用者が選んだ場所ではないので、候補に入れない（ADR 0127）
    place: (extra.delegation || HIDDEN_BOT_KINDS.has(extra.bot?.kind) || typeof extra.cwd !== 'string' || !extra.cwd.trim()) ? null : extra.cwd.trim(),
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
  return HOST_GRACE_MS > 0 && runtime.awaySince !== 0 && !mainAway.holdsGrace() && Date.now() - runtime.awaySince > HOST_GRACE_MS;
}

/** main が更新で居ない間（main-leaving の後）は画面が居ないので猶予を数えない。戻った main の窓が付くまでの猶予は、戻った時から数え直す（core/main-away.mjs） */
function restartGrace() {
  if (runtime.awaySince === 0) return;
  runtime.awaySince = Date.now();
  clearTimeout(runtime.graceTimer);
  runtime.graceTimer = HOST_GRACE_MS > 0 ? setTimeout(giveUp, HOST_GRACE_MS + 500) : null;
}

/** 猶予切れの後始末。何度呼ばれても安全。走っているターンは全部止める。猶予が無効なら何もしない。 */
function giveUp() {
  if (HOST_GRACE_MS <= 0 || runtime.awaySince === 0 || mainAway.holdsGrace()) return;
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
  "userMessage.delivered", "running", "permission", "permissionSettled", "outbox", "mcpAuth", "claudeLogin", "computer.state",
  "contextWindow", "compaction", "compactionSchedule", "autoCompactionSettings", "conversationAutoCompaction", "settingsChanged", "settingApproval",
  // 入力欄の `!`（core/shell-runs.mjs）。一覧の行は変わらない
  "shell.start", "shell.output", "shell.done", "shell.skip", "shell.handed",
  // チャンネル・bot・記憶・ルーティンの出来事。会話の一覧の行は変わらない（bot の会話の行の変化は sessionsChanged が伝える）
  "channelsChanged", "channelPost", "channelReaction", "channelThread", "channelRead", "botsChanged", "memoryChanged", "routinesChanged", "channelEvent", "voiceChanged", "apiKeysChanged",
  // 通知の一覧の件数（ベルのボタン。ADR 0149）。会話の一覧の行は変わらない
  "notificationsChanged",
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
// 入力欄の `!`（シェルの行。ADR 0054）。走っている子のプロセスはサーバーの終わりに止める。保持役があれば保持役の子に載せ、引き継ぎで渡す（無停止の更新 段階 3）
const shellHolder = createShellHolder({ dataDir: store.dataDir, root: BOOT_ENV.AGENT_HOST_RUNTIME_ROOT, key: BOOT_ENV.AGENT_HOST_RUNTIME_KEY ?? '', appVersion: APP_VERSION });
const shellRuns = createShellRuns({ store, emit: event => emitGlobal(event), holder: shellHolder });
// git の動き（ADR 0085）。状態・ターンの始まりと終わりの隠し ref・変更の一覧と差分。git が無い・git 管理外は null
const gitActivity = createGitActivity();
// worktree（ADR 0089）。台帳・作成・片付けと、ぶつかり・委譲の判定。使っているもの（走っているターン・シェル・委譲の子）を見てから消す
const worktreeHost = createWorktreeHost({
  dataDir: store.dataDir, store,
  turns: () => runtime.turns, shellCwds: () => shellRuns.cwds(), tasks: () => agentTasks?.list() ?? [], background: () => runtime.background,
  emit: event => emitGlobal(event), reason: (key, params) => savedReason(key, params),
  log: line => { if (process.env.AGENT_HOST_WORKTREE_LOG) console.log(`  worktree: ${line}`); },
  // AGENT_HOST_WORKTREES=off で worktree を作らない。テストのサーバーが開発中のリポジトリ（<リポジトリ>.pleiad）に残さないため（tests/lib/server.mjs）
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
  worktreeHost.sweep().catch(e => console.error('  worktree の片付けに失敗:', String(e?.message ?? e)))
    .finally(() => { worktreeSweeping = false; if (worktreeSweepAgain) { worktreeSweepAgain = false; worktreeSweepSoon(); } });
}
/** 人が決めた次のターンの予約から外れた worktree を、使っていなければ片付ける */
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
process.on('exit', () => botHost?.stop());
process.on('exit', () => removeControlFile({ dataDir: store.dataDir }));
process.on('exit', () => mainLink?.dispose());
// 端末の Ctrl-C・kill でも 'exit' を通し、control.json を消す
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => process.exit(0));
const completionNotices = createCompletionNotices({
  // 裏の作業は委譲の完了と同じく awaitedBackground で見る。開きっぱなしの端末（開発サーバーなど）で通知が出なくならないように
  busy: sessionId => sessionBusy(sessionId) || awaitedBackground(sessionId) || hasPendingChild(agentTasks?.list(sessionId) ?? []),
  send: event => sendTo({ kind: P.EVENT, event }),
  // 落ち着いた時点で、画面が居なくてもスマホへ 1 回（委譲の子の完了は endTurn が渡さない。依頼元の完了に含む）
  ready: ({ sessionId, outcome, completedAt, startedAt, uuid }) => {
    void inboxSources.completion({ sessionId, outcome, completedAt, uuid });
    store.get(sessionId).then(async meta => {
      if (meta?.delegation) return;
      botHost?.onSessionDone(sessionId, outcome);
      // bot の会話の完了はスレッドで見える。スマホへは送らない（承認・質問・失敗は送る。ADR 0109）。
      // 隠れた会話（夜の整理・心拍）は失敗も送らない（endTurn が finished を呼ばないのでここへは来ないが、念のため。ADR 0127）
      if (HIDDEN_BOT_KINDS.has(meta?.bot?.kind)) return;
      if (meta?.bot && outcome !== 'error') return;
      pushNotifier.finished({ sessionId, outcome, completedAt, startedAt, title: await conversationTitleOf(sessionId) });
    }).catch(() => {});
  },
});

/** 保存した既定を全画面に通知する。セッション閲覧では既定を書き換えない。 */
async function savePref(key, value, backendId) {
  const prefs = await store.setPref(key, value, backendId);   // ops-allow-setpref: prefs.json への書き込みの出口（設定の一覧 core/ops/settings.mjs と、既定の記憶だけがここを通る）
  locale = localeInfo(prefs, localeEnv());
  setLocale(locale.lang);
  // デスクトップ版の main（ダイアログ・通知・更新のエラー文）にも知らせる（desktop/main.cjs）
  mainPort.postMessage({ type: "locale", locale: locale.lang });
  emitGlobal({ type: "prefs", sessionId: null, prefs, locale });
  return prefs;
}

/** セッションに紐づかない全体イベント。 */
const liveReads = new Set();
let streamSequence = 0;
function emitGlobal(event) {
  voiceHost.onEvent(event);   // 通話が見ている会話の読み上げ（core/voice/host.mjs）
  if (event.type === 'routinesChanged') void postResident();
  // 通知の一覧: 人以外の投稿の @あなた・チャンネルの既読・アーカイブ（ADR 0149）
  if (event.type === 'channelPost' || event.type === 'channelRead' || event.type === 'channelsChanged') void inboxSources.observe(event);
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

/** Chrome への接続の状態の便り。ホストの PC の画面だけに流し（中継越しの端末には送らない）、取りこぼしても次の状態で足りるので溜めない */
const chromeBrowserFrame = state => ({ kind: P.EVENT, event: { type: 'chromeBrowser', sessionId: null, ...state } });
chromeConnection?.onChange(state => {
  const text = JSON.stringify(chromeBrowserFrame(state));
  for (const ws of runtime.sockets) if (ws.readyState === ws.OPEN && hostScreens.has(ws)) ws.send(text);
});

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
// 変更履歴（会話の記録の history）とイベントの reason は、従来どおり日本語の文を持つ（過去の記録・古い画面と互換）。
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

/** hooks の漏れの行（contextRecord.hooks.leaks・unknownNative）の同一判定の鍵 */
const hookLeakKey = ({ name, event, source }) => `${name}\0${event}\0${source ?? ''}`;
/** 会話に保存済みの漏れの行のうち、このターンの開始以後のものの数（付け直しの再生が重ねないため。鍵ごと） */
function savedHookLeaks(hooksRecord, startedAtMs) {
  const count = list => {
    const map = new Map();
    for (const row of list ?? []) {
      if (!(Date.parse(row?.at) >= startedAtMs)) continue;
      const key = hookLeakKey(row);
      map.set(key, (map.get(key) ?? 0) + 1);
    }
    return map;
  };
  return { leaks: count(hooksRecord?.leaks), unknownNative: count(hooksRecord?.unknownNative) };
}

/**
 * ターンに属するイベントを流す。ついでにそのターンの文脈を拾う。
 * 並行して複数のターンが走るので、文脈はグローバルではなくターンごとに持つ。
 */
function makeEmit(turn) {
  // replay: 付け直しの再生（印から ack まで。core/adopt.mjs）。メモリの状態とスナップショットだけを作り、記録への書き込み・
  // 途中送信の合図・画面への送信は走らせない（docs/zero-downtime-update/stage2-server-state.md §4.4）
  const emit = (event, { recorded = false, replay = false } = {}) => {
    // 付け直しに渡したターン（handOffTurn）の出来事は、このサーバーでは流さない（閉じたバックエンドの aborted など）
    if (turn.handedOff) return;
    if (event?.type) agentTasks?.observe(turn.info.sessionId, event);
    // git でしたこと（PR の作成など）をターンの終わりの要約に使う
    turn.gitCalls?.track(event);
    // Internal activity and command observations do not add conversation UI events.
    if (event?.type === 'task.activity' || event?.type === 'task.command') return;
    if (event?.type === 'usage') turn.usage = { ...turn.usage, ...event };
    // bot の会話のターンの出来事（text.end・usage・activity・present・permission・turnResult・userMessage.delivered / dropped）。bot の会話でなければ何もしない
    if (!replay) botHost?.onTurnEvent(turn, event);
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
        // bot の会話なら核の記憶の写しを次のターンで取り直す（snapshotDue）
        if (turn.info.sessionId) botHost?.onCompacted(turn.info.sessionId);
      }
      for (const key of ['nativeId', 'turnId', 'beforeTokens', 'afterTokens', 'summary', 'reason'])
        if (event[key] !== undefined && event[key] !== null) entry[key] = event[key];
      turn.compaction = entry;
      event = { type: 'compaction', ...entry };
      if (phase !== 'start' && turn.info.sessionId && !replay) {
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
      // 付け直しの再生（印から ack まで）は、ターンの途中で保存されていた漏れの行と重なる。同じ行を 1 つずつ使い切ってから積む（restoreTurn の savedHookLeaks）
      const saved = (map, key) => replay && map?.get(key) > 0 && map.set(key, map.get(key) - 1);
      if (leak && phase === 'started' && !saved(turn.savedHookLeaks?.leaks, hookLeakKey({ name, event: hookEvent, source })) && hooksRecord.leaks.length < HOOK_LEAKS_MAX) hooksRecord.leaks.push({ name, event: hookEvent, ...(source ? { source } : {}), at: new Date().toISOString() });
      if (unknownNative && phase === 'started' && !saved(turn.savedHookLeaks?.unknownNative, hookLeakKey({ name, event: hookEvent })) && (hooksRecord.unknownNative ??= []).length < HOOK_LEAKS_MAX) hooksRecord.unknownNative.push({ name, event: hookEvent, at: new Date().toISOString() });
      // 多いときは新しいほうを残す（ターンの最後の Stop などが記録から落ちないように）
      turn.hookRuns.push({ phase, hookId, name, event: hookEvent, ...(outcome ? { outcome } : {}), ...(Number.isInteger(exitCode) ? { exitCode } : {}),
        ...(pleiad ? { pleiad: true, ...(id ? { id } : {}) } : {}), ...(source ? { source } : {}), ...(leak ? { leak: true } : {}), ...(unknownNative ? { unknownNative: true } : {}),
        ...(Number.isInteger(ms) ? { ms } : {}), at: Date.now() });
      trimHookRuns(turn.hookRuns);
      return;
    }
    // 途中送信の合図（userMessage.delivered / dropped）を待っている控えは 3 つ（札の steers。stage2-server-state.md §3 の 3）。
    // 付け直しの再生（印から ack まで）でも、札が控えていたものだけは処理する（手を離した後に旧サーバーが読み捨てた合図は、再生の側に来る）。
    // 控えが無い合図（旧サーバーが処理済み）は再生では何もしない
    const signal = event?.type === "userMessage.delivered" || event?.type === "userMessage.dropped";
    // 走っているターンへ渡した完了通知（liveNotices）は人間の発言ではない。渡ったら通知の一行にし、捨てられたら送り直す
    if (signal && liveNotices.has(event.messageId)) {
      const notice = liveNotices.get(event.messageId);
      liveNotices.delete(event.messageId);
      touchCard(turn);
      if (event.type === "userMessage.delivered") emit({ type: "taskNotice", text: notice.prompt }, { replay });
      else if (notice.redeliver) notice.redeliver();
      else agentTasks?.renotify(notice.items).catch(() => {});
      return;
    }
    // 子のターンへ途中送信で渡した追加指示（ply_task_send。liveInstructions）の合図。指示の状態を決めてから、画面にも流す
    if (signal && liveInstructions.has(event.messageId)) {
      const sent = liveInstructions.get(event.messageId);
      liveInstructions.delete(event.messageId);
      touchCard(turn);
      agentTasks?.steered(sent.taskId, sent.instructionIds, event.type === "userMessage.delivered" ? "delivered" : "dropped").catch(() => {});
    }
    // 受理済みの途中送信（送信待ちの項目）への合図。捨てられたら送信待ちへ戻す
    const awaited = signal && event.messageId && turn.pendingSteers?.delete(event.messageId);
    if (awaited) touchCard(turn);
    if (event?.type === "userMessage.dropped" && turn.info.sessionId && event.messageId && (!replay || awaited)) {
      outbox.returned(turn.info.sessionId, event.messageId).catch(() => {});
    }
    // 最後の発言の id（通知の一覧の飛び先。ターンの終わりに completionNotices へ渡す）
    if (event?.type === "text.end" && typeof event.uuid === "string" && event.uuid) turn.lastUuid = event.uuid;
    if (event?.type === "turnResult") {
      if (turn.compactTrigger) event = { ...event, compact: true };
      if (turn.stream.initialMessageId) event = { ...event, messageId: turn.stream.initialMessageId };
      turn.outcome = event.outcome;
      if (event.outcome === 'limited') {
        turn.limit = { resetsAt: Number.isFinite(event.resetsAt) ? event.resetsAt : null,
          window: event.window ?? null, account: turn.info.account ?? null, backend: turn.backend.id, model: turn.info.model ?? null };
        event = { ...event, ...turn.limit };
      }
      // 中断で終わったら理由を添える（画面は会話の末尾の「中断しました」の文言を理由で選ぶ）
      if (event.outcome === "aborted") event = { ...event, reason: turn.abortReason ?? "user" };
      // バックエンドが失敗を知らせたら、server の catch では重ねて出さない（同じ失敗が 2 回並んでいた）
      if (event.outcome === "error" || event.outcome === 'limited') turn.errorShown = true;
      if (turn.backend.id === 'antigravity' && (event.outcome === 'error' || event.outcome === 'limited') && !turn.failureReason)
        turn.failureReason = { source: 'backend.turnResult', error: String(event.error ?? '').slice(0, 1000) };
      if (turn.backend.id === 'antigravity' && event.backendFailure)
        turn.failureReason = { source: 'backend.afterReply', status: String(event.backendFailure.status ?? '').slice(0, 100),
          error: String(event.backendFailure.error ?? '').slice(0, 1000) };
      const execution = taskExecutions.get(turn.info.sessionId);
      if (execution) { execution.outcome = event.outcome; execution.error = event.error ?? null; }
    }
    // 委譲の子で、バックエンドが実行前に拒否されたコマンドを知らせた（Codex。tool.result の rejection）。依頼元へ返す結果に集める
    if (event?.type === "tool.result" && event.rejection && typeof event.rejection === "object") {
      taskExecutions.get(turn.info.sessionId)?.rejections.push(event.rejection);
    }
    // 委譲の子の、流れてきた最後の返答。ターンの後に履歴を読めなかったときの結果にする（execute）
    if (event?.type === "text.delta" || event?.type === "text.end") {
      const execution = taskExecutions.get(turn.info.sessionId);
      if (execution && event.type === "text.end") execution.streamEnded = true;
      else if (execution) {
        if (execution.streamEnded) { execution.streamed = ""; execution.streamEnded = false; }
        execution.streamed += String(event.text ?? "");
      }
    }
    // main の状態と裏で動いているもの（docs/multi-backend.md §2.2）。一覧と稼働表示は running の
    // ターン行から読むので、変わったらすぐ配る（4 秒ごとの定期便を待たない）
    if (event?.type === "phase" || event?.type === "background") {
      if (event.type === "phase") turn.info.phase = event.state === "waiting" ? "waiting" : "active";
      else turn.info.background = Array.isArray(event.tasks) ? event.tasks : [];
      // 再生では状態だけ。見張り・配り・送信待ちの流しは、再生の終わりに 1 回（adoptTurn）
      if (event.type === "phase" && !replay) watchChildBackground(turn);
      if (!replay) broadcastRunning();
      // 裏だけを待つ間は、次のターンの設定の予約があっても途中送信できる。待っている送信をすぐ流す
      if (!replay && event.type === "phase" && turn.info.phase === "waiting" && turn.info.sessionId) outbox.kick(turn.info.sessionId).catch(() => {});
    }
    // 新規セッションは走り出してから id が決まる。仮キーを本物へ差し替える。
    // sessionId が null の session は「まだ決まっていない」ので差し替えない
    // （差し替えると sidecar に "null" キーの行が生える）。
    if (event?.type === "session" && event.sessionId && !turn.info.sessionId) {
      turn.info.sessionId = event.sessionId;
      if (turn.browserRelayId && turn.browserRelayId !== event.sessionId) { agentBrowserEndpoints?.rebind(turn.browserRelayId, event.sessionId); turn.browserRelayId = event.sessionId; }
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

    if (event?.type === "present" && event.sessionId && !recorded && !replay) {
      const { type, sessionId, ...payload } = event;
      const pending = history.recordPresent(sessionId, { ...payload, turnKey: turn.presentKey });
      turn.presentWrites.push(pending);
      pending
        .catch((err) => console.error("  present の記録に失敗:", String(err?.message ?? err)));
    }

    if (replay && event?.type === 'text.end') turn.visualizations?.discard();
    else turn.visualizations?.accept(event);

    // 再生は実行中のスナップショット（画面がつなぎ直したときに配るもの）に積むだけで、画面へは送らない
    if (replay) {
      if (streamEvents.has(event?.type)) turn.stream.events.push({ ...P.stampSessionId(event, turn.info.sessionId), streamSeq: ++streamSequence });
      return;
    }
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
    const inUploads = inUploadDir(file);
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

/** パスが添付の置き場（UPLOAD_DIR）の中か。Windows はドライブ・フォルダーの大小を区別しない */
function inUploadDir(file) {
  return process.platform === "win32" ? file.toLowerCase().startsWith((UPLOAD_DIR + path.sep).toLowerCase()) : file.startsWith(UPLOAD_DIR + path.sep);
}

/**
 * チャンネルの投稿に付ける添付の実物を確かめる（channels.post の attachments。ADR 0116）。会話の添付（presentAttachments）と同じ規則で、
 * 置き場（attachFile が置いた、この端末から送ったもの）の中のファイルと、読んでよいホストのファイル（ADR 0050。UNC・データ置き場は断る）だけ。
 * 中身は載せない（記録はパス・名前・種類・大きさだけ。画像は /local-file で見せる）。返りの rejected は読めなかったものの名前
 */
async function describeAttachments(list) {
  const files = [], rejected = [];
  for (const a of list) {
    const given = String(a?.path ?? "");
    const file = path.resolve(given);
    const mime = String(a?.mime ?? "");
    const device = inUploadDir(file);
    let size;
    try {
      const stat = device ? await fs.stat(file) : (await inspectFile(file, fileAccess)).stat;
      if (!stat.isFile()) throw new Error("not a file");
      size = stat.size;
    } catch { rejected.push(path.basename(given) || given); continue; }
    const name = path.basename(file).replace(/^\d{4}-\d{2}-\d{2}T[\d-]+Z_/, "");
    const isImage = IMAGE_MIME.test(mime) || /\.(?:png|jpe?g|gif|webp|avif)$/i.test(name);
    files.push({ path: device ? file : given, name, kind: isImage ? "image" : "file", mime, size, origin: device ? "device" : "host" });
  }
  return { files, rejected };
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

/** 内蔵ブラウザーの確認と「このサイトは常に」。保存して、走っているブラウザーの方針にも伝える。値の検査は呼び出し側 */
async function applyBrowserPref(key, value) {
  const prefs = await savePref(key, value);
  agentBrowser?.prefs(prefs);
  agentBrowser?.loadPolicy(prefs);
  chromeRelay?.setConfirm(prefs.confirmAgentSites === true);
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
 * 同じ会話の中で、ある発言（beforeMessageId。自分の発言）の手前まで巻き戻す（sendMessage の rewind。ADR 0102）。
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
    limitStates.delete(sessionId);
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
  // 一時チャットの流れ（sessions.roots）: bot の会話・委譲の子・未送信を除いた会話を新しい順に。頭は検索の写しから（会話の本文を読み直さない）
  sessionRoots: async ({ before, limit = ROOTS_DEFAULT } = {}) => {
    const rows = (await sessionList({ limit: 500, track: false })).filter((r) => !r.bot && !r.delegation && !r.unsent && Number.isFinite(r.lastModified))
      .filter((r) => !before || r.lastModified < before).sort((a, b) => b.lastModified - a.lastModified);
    const page = rows.slice(0, Math.min(limit, ROOTS_MAX));
    return {
      roots: page.map((r) => {
        const o = sessionSearch.outline(r.id);
        return { sessionId: r.id, title: r.title && r.title !== '(no title)' ? r.title : '', lastModified: r.lastModified, createdAt: r.createdAt ?? null,
          first: o?.first ? { uuid: o.first.uuid, at: o.first.at ?? null, text: o.first.text.slice(0, ROOT_TEXT_MAX) } : null, count: o?.count ?? null };
      }),
      nextBefore: rows.length > page.length ? page.at(-1).lastModified : null,
    };
  },
  status: async () => ({ version: APP_VERSION, protocolVersion: P.PROTOCOL_VERSION, startedAt: SERVER_STARTED_AT, locale: { ...locale }, running: (await runningWork()).count }),
  // 外の AI の MCP の設定に貼る pleiad mcp（app.cliSetup。core/cli-launcher.mjs）
  cliSetup: () => mcpSetup({ dataDir: store.dataDir }),
  // 画面が読む走っている作業の全量（turns・permissions・tasks・subagents・background・count）
  runningWork: () => runningWork(),
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
  // 画面のサイドバーが読む全部の行（作業場所を許可する場所に覚える。track）
  rows: () => sessionList(),
  // 変更の記録（会話が無ければ null）
  history: async (id) => ((await resolveBackendForSession(id)) ? (await store.get(id)).history ?? [] : null),
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

/** 新しい会話を作る（sessions.new。WS の newSession の中身）。まだ送っていない（unsent）下書きの会話ができる */
async function createSession(args) {
  const sourceId = args?.sourceSessionId;
  if (sourceId) await settingsWrites.get(sourceId);
  const sourceBackend = sourceId ? await resolveBackendForSession(sourceId) : null;
  if (sourceId && !sourceBackend) throw new Error(t('session.sourceNotFound'));
  const source = sourceId ? await store.get(sourceId) : null;
  const selected = source?.nextSettings?.backend ?? sourceBackend?.id;
  // 引き継ぎ元が対応を終えたエージェントなら、エージェントは継がない（既定へ落とす）
  const selectedBackend = getBackend(selected) ? selected : undefined;
  const backend = await pickBackend(null, args?.backend ?? selectedBackend);
  const inherit = source && backend.id === selectedBackend;
  const model = args?.model ?? (inherit ? source.nextSettings?.model ?? source.model ?? "" : undefined);
  const mode = args?.mode ?? (inherit ? source.nextSettings?.mode ?? (backend.id === sourceBackend.id ? source.mode : undefined) : undefined);
  const cwd = typeof args?.cwd === "string" && args.cwd.trim() ? args.cwd.trim() : os.homedir();
  const status = typeof args?.status === "string" ? args.status.trim() || null : null;
  // draft: 入力欄に入れておく文（「見直しを頼む」。ADR 0056）。作るのと同時に下書きとして保存し、送らない
  const draft = args?.draft;
  if (draft !== undefined && (typeof draft !== "string" || draft.length > 2_000_000)) throw new Error(t('session.draftTooLarge'));
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
      if (typeof args?.endpoint === 'string') {
        endpoint = args.endpoint;
        if (endpoint && !(await compatEndpoints.has(endpoint, backend.id))) throw new Error(t('settings.endpointNotRegistered'));
      } else {
        endpoint = inherit ? source.nextSettings?.endpoint ?? source.compatEndpoint ?? '' : await compatEndpoints.defaultFor(backend.id);
        if (endpoint && !(await compatEndpoints.has(endpoint, backend.id))) endpoint = '';
      }
    }
    if (endpoint) await store.setSessionData(sessionId, 'compatEndpoint', endpoint);
    const selected = await resolveModel(null, inherit || args?.model !== undefined ? model : undefined, backend, cwd || undefined, endpoint);
    await store.setModel(sessionId, selected);
    const effort = args?.effort ?? (inherit ? source.nextSettings?.effort ?? source.effort : undefined);
    await store.setSessionData(sessionId, 'effort', await resolveEffort(null, effort, backend, selected, cwd || undefined, await endpointRow(endpoint)));
    await store.setMode(sessionId, await resolveMode(null, mode, backend));
    // 引き継ぎ元の会話で選んでいた Claude のアカウントも継ぐ（予約中ならそれを）
    // 引き継ぎ元が無ければ前回選んだアカウント（削除済みなら、ログイン中のアカウントのまま）
    const account = source ? source.nextSettings?.account ?? source.claudeAccount ?? '' : (await store.getPrefs()).claudeAccount ?? '';
    if (account && await claudeAccounts.has(account)) await store.setSessionData(sessionId, 'claudeAccount', account);
    if (draft) await store.setSessionData(sessionId, "draft", { text: draft, attached: [] }, { durable: true });
  } catch (e) { await deleteUnsentConversation(sessionId); await store.removeSession(sessionId); releaseAgentConnection(sessionId); throw e; }
  emitGlobal({ type: "sessionsChanged", sessionId: null });
  return { sessionId };
}

/** 次のターンの設定を予約する（sessions.setTurnSettings。WS の setTurnSettings の中身）。予約は nextSettings。返り値は予約（取り消しは null） */
async function reserveTurnSettings(args) {
  const { sessionId, backend: targetId, model, mode, cwd: requestedCwd, cancel, account, endpoint } = args ?? {};
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
    const selectedEffort = cancel ? '' : args.effort !== undefined
      ? await validateEffort(target, args.effort, selectedModel, settingsCwd, selectedEndpointRow)
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
    await store.setSessionData(sessionId, "nextSettings", next, { durable: true });
    if (current.interrupted?.reason === 'limit'
      && ((account !== undefined && accountChanged) || (!cancel && next?.backend && next.backend !== source.id))) {
      await leaveLimit(sessionId);
    }
    // 取り消した・別の場所に替えた予約が worktree なら、使っていなければ片付ける（ADR 0089）
    if (current.nextSettings?.cwd && current.nextSettings.cwd !== next?.cwd) settleWorktreeAt(current.nextSettings.cwd).catch(() => {});
    // keepPrefs: 依頼元の AI が子の設定を替えるとき（applyTaskSettings）。人の既定には覚えない
    if (!cancel && !args.keepPrefs) {
      if (targetId !== undefined) await savePref("backend", target.id);
      // 互換の接続先のモデル・段は公式の既定（prefs）に覚えない。接続先の既定は設定の「既定にする」だけで決まる（決定 2）
      if (args.rememberEffort && !selectedEndpoint) await savePref("effort", selectedEffort, target.id);
      if (args.rememberModel && !selectedEndpoint) await savePref("model", selectedModel, target.id);
      if (args.rememberMode && selectedMode !== undefined) await savePref("mode", selectedMode, target.id);
      // 人が選んだ Claude のアカウントは、次に開く新しい会話の既定にする（newSession）
      if (account !== undefined) await savePref("claudeAccount", account || null);
    }
    emitGlobal({ type: "nextSettings", sessionId, nextSettings: next });
    return next;
  });
  settingsWrites.set(sessionId, work);
  try { return await work; }
  finally { if (settingsWrites.get(sessionId) === work) settingsWrites.delete(sessionId); }
}

/** 送っていない会話を消す（sessions.deleteUnsent。WS の deleteUnsentSession の中身） */
async function deleteUnsentSessionOf(args) {
  const { sessionId } = args ?? {};
  if (!sessionId || switching.has(sessionId) || forking.has(sessionId) || runtime.turns.has(sessionId)
      || (await outbox.list(sessionId)).some(m => !['sent', 'cancelled'].includes(m.status))
      || schedule.list().some(row => row.sessionId === sessionId && row.kind === 'send')) throw new Error(t('session.cannotDeleteBusy'));
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
    return "deleted";
  } finally { switching.delete(sessionId); completionNotices.changed(sessionId); }
}

/**
 * 会話を消せないなら、理由（code: CANNOT_DELETE）を投げる（sessions.delete の承認カードの前と、消す直前。ADR 0147）。
 * 断るのは、走っている・準備中（切り替え・分岐）・承認や質問を待っている・裏の作業（Codex のバックグラウンド端末・シェルの行）がある・
 * 委譲の子として終わっていない・委譲した子が終わっていない（完了の通知がまだ届いていないものを含む）・送信待ちや送信予定がある会話と、bot の会話
 */
const deleteRefusal = (message) => Object.assign(new Error(message), { code: 'CANNOT_DELETE' });
async function refuseDelete(sessionId) {
  if (!sessionId) throw new Error(t('session.required'));
  const meta = await store.get(sessionId);
  // bot の会話は Channels のスレッド・DM・ルーティンが持つ（一覧にも出ない）。隠れた会話は host.deleteHidden が片付ける（ADR 0127）
  if (meta.bot) throw deleteRefusal(t('session.deleteBot'));
  if (sessionBusy(sessionId) || [...runtime.waiting.values()].some(w => w.payload?.sessionId === sessionId)
      || runtime.background.get(sessionId)?.tasks?.length || shellRuns.runningIn(sessionId)
      || (agentTasks?.running() ?? []).some(r => r.sessionId === sessionId)) throw deleteRefusal(t('session.deleteBusy'));
  if ((agentTasks?.running() ?? []).some(r => r.parentSessionId === sessionId)) throw deleteRefusal(t('session.deleteChildren'));
  if ((await outbox.list(sessionId)).some(m => !['sent', 'cancelled'].includes(m.status))
      || schedule.list().some(row => row.sessionId === sessionId && row.kind === 'send')) throw deleteRefusal(t('session.deleteQueued'));
}

/**
 * 会話を消す（sessions.delete。WS の deleteSession の中身。送った会話も。ADR 0147）。消すのは Pleiad の記録だけで、
 * ネイティブの会話（Claude の transcript・Codex の rollout・Antigravity の控え）は消さない（バックエンドの deleteSession は呼ばない）。
 * 一緒に消す: sidecar（DB の sessions・session_fields・context_entry_refs）・会話の記録（索引・本文・引き継ぎの写し）・提示の記録（presents）・
 * 撮影（computer use）・git の撮影の ref（refs/pleiad/turn/）・内蔵ブラウザーの設定・自動圧縮と上限の再開の予約・設定の変更の承認の結果・まだ知らせていない完了。
 * 残す: 会話に結び付いた worktree（ユーザーの変更が入っている。worktree の画面から扱う）・使用量の記録・委譲のタスクの記録（履歴）・
 * 添付のファイル（uploads。ネイティブの会話と分岐した会話がパスで指している）
 */
async function deleteSessionOf(sessionId) {
  await refuseDelete(sessionId);
  const backend = await resolveBackendForSession(sessionId);
  if (!backend) throw new Error(t('session.notFound'));
  // 上の確かめの間（await）に始まったターン・準備は、ここで同期に見直してから押さえる（switching の間は送信も準備も始まらない）
  if (sessionBusy(sessionId)) throw deleteRefusal(t('session.deleteBusy'));
  switching.add(sessionId);
  let deleted = false;
  try {
    // git の撮影の ref は会話が使った作業場所ごとのリポジトリにある。sidecar を消す前に集める
    const meta = await store.get(sessionId);
    const cwds = new Set([meta.cwd, meta.nextSettings?.cwd, ...(meta.history ?? []).filter(h => h?.field === 'cwd').flatMap(h => [h.from, h.to])]
      .filter(c => typeof c === 'string' && c));
    compactionScheduler.cancel(sessionId);
    queuedCompactions.delete(sessionId);
    shellRuns.stopSession(sessionId);
    await deleteConversation(sessionId, backend.id);
    await store.removeSession(sessionId);
    deleted = true;
    await schedule.cancel(`resume:${sessionId}`).catch(() => {});
    clearTimeout(limitReleaseTimers.get(sessionId));
    limitReleaseTimers.delete(sessionId); limitStates.delete(sessionId); limitPoll.delete(sessionId);
    relayHops.delete(sessionId);
    completionNotices.forget(sessionId);
    pushNotifier.viewed(sessionId);
    void inboxSources.sessionRemoved(sessionId);
    releaseAgentConnection(sessionId);
    const cleanups = [
      history.forgetPresents(sessionId),
      computerShots.removeSession(sessionId),
      forgetBrowserEnvironment({ bridge: agentBrowserEndpoints, dataDir: store.dataDir, sessionId }),
      Promise.resolve().then(() => chromeRelay?.forget(sessionId)),
      settingApprovals?.forget(sessionId),
      ...[...cwds].map(cwd => gitActivity.forget(cwd, sessionId)),
    ];
    for (const r of await Promise.allSettled(cleanups)) {
      if (r.status === 'rejected') console.error('  消した会話の記録の片付けに失敗:', String(r.reason?.message ?? r.reason));
    }
    emitGlobal({ type: "sessionsChanged", sessionId: null, deleted: sessionId });
    return "deleted";
  } finally {
    switching.delete(sessionId);
    if (!deleted) completionNotices.changed(sessionId);
  }
}

/** 会話の圧縮を頼む（sessions.compact。WS の compactConversation の中身） */
async function requestCompaction(args) {
  const sessionId = args?.sessionId;
  compactionScheduler.cancel(sessionId);
  const backend = sessionId ? await resolveBackendForSession(sessionId) : null;
  if (!backend) throw new Error(t('session.notFound'));
  if (!backend.capabilities?.compact) throw new Error(t('compaction.unsupported'));
  const queued = sessionBusy(sessionId);
  void compactConversation(sessionId).catch(err => compactionStartFailed(sessionId, 'manual', err));
  return { status: queued ? 'queued' : 'started' };
}

/** 予約・待ちの圧縮を取り消す（sessions.cancelCompaction） */
async function cancelRequestedCompaction(args) {
  const sessionId = args?.sessionId;
  compactionScheduler.cancel(sessionId);
  queuedCompactions.delete(sessionId);
  return { cancelled: true };
}

/** 会話ごとの自動圧縮の切り替え（sessions.setAutoCompaction） */
async function setConversationAutoCompactionOf(args) {
  const sessionId = args?.sessionId;
  const off = args?.off;
  if (typeof off !== 'boolean') throw new Error(t('compaction.invalidSetting'));
  if (!sessionId) throw new Error(t('session.notFound'));
  if (off) compactionScheduler.cancel(sessionId);
  if (!(await resolveBackendForSession(sessionId))) throw new Error(t('session.notFound'));
  await store.setSessionData(sessionId, 'autoCompactionOff', off);
  emitGlobal({ type: 'conversationAutoCompaction', sessionId, off });
  return { off };
}

/** 会話の題を考えてもらう（sessions.suggestTitle。WS の suggestTitle の中身）。会話は変えない */
async function suggestTitleOf(args) {
  const { sessionId } = args ?? {};
  if (!sessionId) throw new Error(t('session.required'));
  const backend = await resolveBackendForSession(sessionId);
  if (!backend) throw new Error(t('agents.notFound'));
  if (!backend.suggestTitle) throw new Error(t('title.unsupported'));
  const { messages } = await history.loadTranscript(sessionId, backend);
  // タイトルは会話の言語で作る（渡す見出しもその言語）
  const lng = await ensureAgentLocale(sessionId);
  const gist = messages
    .filter((m) => m.text)
    .slice(0, 6)
    .map((m) => m.role === "user" ? agentT(lng, 'title.request', { text: textForTitleModel(m.text).slice(0, 600) }) : agentT(lng, 'title.response', { text: m.text.slice(0, 600) }))
    .join(NL + NL);
  if (!gist) throw new Error(t('title.noContent'));

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
    throw new Error(t('title.failed', { error: redactSecret(redactToken(err?.message ?? err, context.oauthToken), context.endpoint?.key) }));
  }

  // 前後の記号を落とす。モデルが鉤括弧やクオートで包むことがある
  title = title.trim().split(NL)[0].replace(/^["'「『]|["'」』。]$/g, "").trim().slice(0, 60);
  if (!title) throw new Error(t('title.empty'));
  return { title };
}

/** 状態のグループの名前を替える（statuses.rename。WS の renameStatus の中身）。付いている会話ごとに変更の記録を残す */
async function renameStatusGroup(args, actor) {
  const { from, to } = args ?? {};
  if (typeof from !== "string" || !from) throw new Error(t('statuses.renameFromRequired'));
  const next = typeof to === "string" ? to.trim() : "";
  const hit = (await sessionList({ limit: 500 })).filter((x) => (x.status ?? "") === from);
  let done = 0;
  for (const x of hit) {
    const backend = getBackend(x.backend);
    if (backend?.capabilities?.tag && backend.setTag) {
      await backend.setTag(x.id, next || null).catch(() => {});
    }
    await store.recordChange(x.id, {
      ...changeBy(actor), field: "status", from, to: next || null, backend,
      ...(next ? savedReason('renameStatus', { to: next }) : savedReason('deleteGroup')),
    });
    emitGlobal({ type: 'statusProgress', from, to: next, done: ++done, total: hit.length });
  }
  // statuses.json の器（アイコン・作った時刻）も一緒に移す。削除なら捨てる（空のグループはこれで消える）
  await store.moveStatus(from, next || null);
  emitGlobal({ type: "status", sessionId: null, status: next, by: changeBy(actor).by, bulk: hit.length,
         ...(next ? savedReason('renamedGroup', { from, to: next }) : savedReason('deletedGroup', { from })) });
  return { moved: hit.length };
}

/** 設定の「使用量」の 1 エージェント分（delegation.usage。WS の providerUsage の中身） */
async function providerUsageOf(args) {
  const backend = getBackend(args?.backend);
  if (!backend) throw new Error(t('agents.notFound'));
  const quota = await providerQuota(backend);
  let local;
  try { local = await usageStore.summary(backend.id); }
  catch { local = { error: t('quota.localFailed') }; }
  return { backend: backend.id, label: backend.label, quota, local };
}

/**
 * 会話へ発言を送る（送信待ちに積む）。画面の送信（WS の sendMessage）と、別の会話からの送信（sessions.send。ADR 0104）が同じ経路を通る。
 * 走っている会話では送信待ちのまま順番を待つ（途中送信できるエージェントは渡す）。rewind は画面だけ（同じ会話の中で発言の手前まで巻き戻す。ADR 0102）
 */
async function acceptMessage(sessionId, messageId, args, { rewind } = {}) {
  compactionScheduler.cancel(sessionId);
  if (rewind) {
    // 受け付け済みの再送（応答が届かず送り直した同じ messageId）は、巻き戻し直さない（もう巻き戻してある）
    if ((await outbox.list(sessionId)).some(m => m.id === messageId)) return outbox.accept(sessionId, messageId, args);
    const rewound = await rewindConversation({ sessionId, beforeMessageId: rewind.beforeMessageId, stopRunning: rewind.stopRunning === true });
    return { ...(await outbox.accept(sessionId, messageId, args)), rewind: rewound };
  }
  return acceptSend(sessionId, messageId, args);
}

// 別の会話の AI が送った発言の印（sessions.send。ADR 0104）。本文のハッシュと送り手を会話に残し、履歴が「<送り手> があなたの代わりに送信」で描く
// （完了通知の taskNotices と同じ見分け方）。古いものから捨てる
const RELAYED_KEEP = 500;
async function recordRelayed(sessionId, prompt, sentBy) {
  const hash = crypto.createHash('sha256').update(prompt).digest('hex');
  const kept = ((await store.get(sessionId)).relayed ?? []).filter(r => r.hash !== hash);
  await store.setSessionData(sessionId, 'relayed', [...kept, { hash, sentBy: publicSender(sentBy) }].slice(-RELAYED_KEEP));
}
/** 画面と履歴に出す送り手（連鎖の数は内部の歯止めなので出さない）。bot の会話は name・icon を足す */
const publicSender = (sentBy) => {
  if (!sentBy) return null;
  const { hops, ...shown } = sentBy;
  return shown;
};
// 会話ごとの、送信の連鎖の数（sessions.send の歯止め。ADR 0104）。送信待ちから始まったターンで決め直す（人の発言は 0、
// 別の会話からの発言はその送信の数）。途中送信で渡った分は大きい方を残す。保存しない（再起動で 0 に戻る）
const relayHops = new Map();
const noteRelayHops = (sessionId, args, { steered = false } = {}) => {
  if (!sessionId) return;
  const hops = Number.isInteger(args?.sentBy?.hops) ? args.sentBy.hops : 0;
  relayHops.set(sessionId, steered ? Math.max(relayHops.get(sessionId) ?? 0, hops) : hops);
};

/** 完了を確認した印（readAt）を付け、変わった分を全画面へ知らせる（WS の markRead・sessions.markRead） */
async function markReads(reads) {
  const changed = await store.markRead(reads);
  if (changed.length) emitGlobal({ type: "read", sessionId: null, reads: changed });
  // 通知の一覧: 会話の既読が進んだ分の完了・失敗の通知も既読にする（ADR 0149）
  try { for (const [id, readAt] of changed) inbox.markSession(id, readAt); } catch (e) { console.error('  通知の一覧: 既読にできなかった:', String(e?.message ?? e)); }
  // どこかで見た完了・失敗は、スマホに出ている通知を消す
  for (const [id] of changed) pushNotifier.viewed(id);
  return changed;
}

// 会話の操作（sessions.new・abort・compact など。core/ops/conversations.mjs）の本体。画面の WS コマンドの中身を移したもの
const opsConversations = {
  create: (args) => createSession(args),
  deleteUnsent: (sessionId) => deleteUnsentSessionOf({ sessionId }),
  canDelete: (sessionId) => refuseDelete(sessionId),
  delete: (sessionId) => deleteSessionOf(sessionId),
  // 止めた会話の変更の記録に、誰が・どこから・なぜを残す（AI の呼び出しだけ。画面の「止める」は今までどおり記録しない）
  abort: async ({ sessionId, kind, note, actor }) => {
    const result = await abortSessions({ sessionId, reason: kind });
    if (note && sessionId) await store.recordChange(sessionId, { ...changeBy(actor), field: 'abort', to: result.reason, reason: note });
    return result;
  },
  compact: (sessionId) => requestCompaction({ sessionId }),
  cancelCompaction: (sessionId) => cancelRequestedCompaction({ sessionId }),
  setAutoCompaction: (sessionId, off) => setConversationAutoCompactionOf({ sessionId, off }),
  setTurnSettings: (args) => reserveTurnSettings(args),
  suggestTitle: (sessionId) => suggestTitleOf({ sessionId }),
  outbox: (sessionId) => outbox.list(sessionId),
  messageAction: async (sessionId, messageId, action) => { await outbox.action(sessionId, messageId, action); },
  // 別の会話からの送信（sessions.send）。画面の送信と同じ送信待ちに積む。承認モードは渡さない（宛先の会話のモードで走る）。
  // 宛先の変更の記録に、誰が・どこから・なぜを残す
  send: async ({ sessionId, text, sentBy, reason, actor }) => {
    if (!refuseRetired(await resolveBackendForSession(sessionId))) throw new Error(t('session.notFound'));
    const messageId = `send-${crypto.randomUUID()}`;
    await recordRelayed(sessionId, text, sentBy);
    const item = await acceptMessage(sessionId, messageId, { prompt: text, sentBy });
    await store.recordChange(sessionId, { ...changeBy(actor), field: 'message', to: messageId, reason: reason ?? null });
    console.log(`  別の会話から送信: ${sentBy?.sessionId ?? '(束縛なし)'} → ${sessionId}（連鎖 ${sentBy?.hops ?? 1}）`);
    return item;
  },
  // 宛先で次に走るときの承認モード（走っているターンのモードと、次のターンのモード。予約があれば予約の分）。sessions.send が送り手と比べる
  modesOf: async (sessionId) => {
    const out = [];
    const live = runtime.turns.get(sessionId);
    if (live) out.push(live.backend.modes()[live.info.mode]);
    const reserved = (await store.get(sessionId)).nextSettings;
    const backend = (reserved?.backend && getBackend(reserved.backend)) || await resolveBackendForSession(sessionId).catch(() => null);
    if (backend) out.push(backend.modes()[await resolveMode(sessionId, reserved ? reserved.mode : undefined, backend)]);
    return out.filter(Boolean);
  },
  relayHops: (sessionId) => relayHops.get(sessionId) ?? 0,
  // sessions.send の歯止めで断った（自分自身・委譲の親子・連鎖・回数）。送り手の会話の変更の記録に残す
  refused: async ({ actor, op, sessionId, code }) => {
    console.log(`  ${op} を断った: ${code}（${actor?.sessionId ?? '(束縛なし)'} → ${sessionId}）`);
    if (actor?.sessionId) await store.recordChange(actor.sessionId, { ...changeBy(actor), field: 'opRefused', to: op, reason: code });
  },
  // 既読。at を省くと今の完了まで
  markRead: async (sessionId, at) => {
    const target = at ?? (await store.get(sessionId)).completedAt;
    const changed = Number.isFinite(target) ? await markReads([[sessionId, target]]) : [];
    const readAt = (await store.get(sessionId)).readAt;
    return { sessionId, readAt: Number.isFinite(readAt) ? readAt : null, changed: changed.length > 0 };
  },
};

// 選べるもの（agents.*。core/ops/agents.mjs）の本体
const opsAgents = {
  list: () => describeBackends(),
  models: async (id, cwd) => { const backend = await pickBackend(null, id); return { backend: backend.id, models: await backend.models(cwd) }; },
  modes: async (id) => { const backend = await pickBackend(null, id); return { backend: backend.id, modes: backend.modes() }; },
  efforts: async ({ backend: id, model, cwd, endpoint }) => {
    const backend = await pickBackend(null, id);
    // endpoint を渡すと互換の接続先の段（既定の段を作らない。Claude は「思考を送る」がオフなら段なし）
    const row = endpointCapable(backend) && typeof endpoint === 'string' ? await endpointRow(endpoint) : null;
    return { backend: backend.id, efforts: await effortOptions(backend, model ?? '', cwd, row) };
  },
  // 認証はエージェントごとに持ち方が違う。持たないものは supported:false を返す（web はボタンごと隠す）
  authStatus: async (id) => {
    const backend = await pickBackend(null, id);
    const installed = installation(backend.id);
    if (!installed.installed) return { backend: backend.id, status: { supported: true, ...installed } };
    if (!backend.auth?.status) return { backend: backend.id, status: { supported: false } };
    return { backend: backend.id, status: { supported: true, ...installed, ...(await backend.auth.status()) } };
  },
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
  // bot の会話（スレッドだけの設定）で選んだものは、Chats の新しい会話の既定にしない
  if (!endpointId && who.by === 'human' && !(await store.get(sessionId)).bot) await savePref("model", model, backend.id);
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
const opsStatuses = {
  setIcon: setStatusIconOf,
  create: createStatusGroup,
  // 既出の状態一覧。事前定義ではなく補完候補（設計メモ §6）
  // スレッドの状態（channels.setThreadStatus）も同じ器に数える
  list: async () => history.listStatuses(listBackends(), { list: nativeSessions,
    extra: ((await botHost?.opsDeps().channels?.threads.list().catch(() => [])) ?? []).filter((th) => th.status).map((th) => ({ status: th.status, at: th.updatedAt })) }),
  rename: (from, to, actor) => renameStatusGroup({ from, to }, actor),
};

/** worktree を作れなかった理由 → 画面の言語の文（server:worktree.fail.<reason>）の OpError */
// i18n-dynamic: server:worktree.fail.
const worktreeFailure = (reason, error) => new OpError(reason === 'not-git' ? 'NOT_GIT' : 'WORKTREE_FAILED', t(`worktree.fail.${reason}`, { error: error ?? '' }));
const worktreeEntry = async (id) => {
  const entry = await worktreeHost.worktrees.get(String(id ?? ''));
  if (!entry) throw new OpError('WORKTREE_NOT_FOUND', t('worktree.notFound'));
  return entry;
};
// worktree（worktrees.*。ADR 0089）の本体。画面の WS コマンドも AI もここを通る
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
  // ぶつかりの確認（チップと面の元。worktrees.check。ADR 0136）
  check: async (args) => {
    const sessionId = typeof args?.sessionId === 'string' && args.sessionId ? args.sessionId : null;
    const cwd = await worktreeCwd(args);
    if (!cwd) return { git: false, current: null, conflicts: [], canSplit: false };
    return worktreeHost.check({ sessionId, cwd, writes: await sessionWrites(sessionId, args?.backend, args?.mode) });
  },
};

// 通知の設定（notify.*。ADR 0086）の本体。変えたら設定 › 通知の材料を全画面へ配る
const notifyChanged = async () => emitGlobal({ type: 'notifyStatus', status: await notifyStatus(), sessionId: null });
const opsNotify = {
  // 設定 › 通知の材料（notify.status。ADR 0105）。スマホの一覧を含むので、AI への返りは操作が数だけにする
  status: () => notifyStatus(),
  setPc: async (patch) => { const pc = await notifySettings.set(patch); await notifyChanged(); return pc; },
  setDevice: async (id, muted) => {
    if (!remote.deviceInfo(id)) throw new OpError('DEVICE_NOT_FOUND', t('notify.error.unknownDevice'));
    await remote.setNotifyMuted(id, muted === true);
    await notifyChanged();
    return { id, muted: muted === true };
  },
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

// エージェントのブラウザー（PC の Chrome）への接続（browser.chrome*。core/ops/browser.mjs）。状態は chromeBrowser イベントでホストの画面へ流す
const opsChrome = chromeConnection ? {
  status: () => chromeConnection.state(),
  connect: async () => { await chromeConnection.connect(); return chromeConnection.state(); },
  disconnect: () => { chromeConnection.disconnect(); return chromeConnection.state(); },
  raiseDialog: async () => { const result = await chromeConnection.raiseDialog(); return { raised: result.ok === true, method: String(result.method ?? 'none') }; },
} : null;

// コンピューターの操作を止める（computer.stop。docs/computer-use.md「computerStop」）。止める側なので、リモートの端末からも AI からも受ける
const opsComputer = {
  stop: (sessionId) => {
    const result = computerLock.stopSession(sessionId, 'stop');
    if (result.stopped && result.owner) computerDriver?.stop(result.owner);
    return { stopped: result.stopped };
  },
};

// MCP の登録（core/ops/mcp.mjs）の本体。WS の listPlyMcp などがしていた処理をそのまま持つ
const opsMcp = {
  native: { list: (args) => mcpConfig.list(args), get: (args) => mcpConfig.get(args), getWithSecrets: (args) => mcpConfig.getWithSecrets(args), save: (args) => mcpConfig.save(args) },
  list: async () => {
    const data = await plyMcp.list();
    const servers = await Promise.all(data.servers.map(async s => ({ ...s, authStatus: s.auth === 'oauth' ? await mcpOAuth.status(s.name, await plyMcp.registration(s.name)) : null })));
    return { ...data, servers, storage: await mcpSecrets.status(), settings: await plyMcp.settings() };
  },
  read: (name) => plyMcp.read(name),
  registration: (name) => plyMcp.registration(name),
  save: async (args) => {
    const saved = await plyMcp.save(args);
    if (saved.oauthReset) mcpOAuth.cancel(saved.name);
    return { ...saved, storage: await mcpSecrets.status() };
  },
  remove: async (name) => {
    const definition = await plyMcp.registration(name);
    // 消す前に失効させる（トークンを残したまま登録だけ消さない）
    const logout = definition.auth === 'oauth' ? await mcpOAuth.logout(name, definition, await plyMcp.connection(name, process.cwd()).catch(() => null)).catch(e => ({ revoked: false, reason: e.message })) : null;
    return { ...(await plyMcp.remove(name)), logout };
  },
  rename: async (name, to) => {
    // 秘密・OAuth の状態・リフレッシュのロック名を引き継いで名前だけ変える
    const renamed = await plyMcp.rename(name, to, { guard: (definition, fn) => mcpOAuth.rename(name, to, definition, fn) });
    // 設定 › コンテキストで名前で指したもの（外す・同じ名前の定義の選択）も新しい名前へ
    const followed = await contextSettings.renameMcp(name, to, { plyFile: (await plyMcp.scanInput()).file }).catch(() => 0);
    return { ...renamed, settingsUpdated: followed };
  },
  // Claude / Codex の登録を取り込む。トークンは流用しない（core/mcp-import.mjs の先頭のコメント）
  import: (items, includeSecrets) => importNativeMcp({ items, includeSecrets, mcpConfig, plyMcp, detect: definition => mcpOAuth.detect(definition) }),
  settings: () => plyMcp.settings(),
  setSettings: (value) => plyMcp.setSettings(value),
  authStatus: async (name) => {
    const names = name ? [name] : (await plyMcp.list()).servers.map(s => s.name);
    const rows = await Promise.all(names.map(async n => mcpOAuth.status(n, await plyMcp.registration(n))));
    return { servers: rows, storage: await mcpSecrets.status() };
  },
  reconnect: async (name, cwd) => {
    // 接続はターンごとに作り直すので、ここでは今の資格情報でつながるかを確かめる（期限切れならリフレッシュもする）
    const definition = await plyMcp.registration(name);
    const result = await connectServer({ id: 'manual', name, origins: [{ source: 'ply' }], definition }, { cwd: cwd ?? process.cwd(), plyMcp, oauth: mcpOAuth });
    await result.client?.close().catch(() => {});
    return { name, status: result.status, tools: result.tools?.length ?? 0, reason: result.reason ?? null };
  },
};

// Hooks の定義の読み出しの失敗の文はファイルの読み方（hooks-config・ply-hooks）が持つ
const hookFailure = (e) => new OpError('HOOK_NOT_FOUND', String(e?.message ?? e));
// Hooks（core/ops/hooks.mjs）の本体。各エージェントの設定ファイル（core/hooks-config.mjs。コマンドは実行しない）と、Pleiad の登録と担当（core/ply-hooks.mjs、ADR 0049）
const opsHooks = {
  scan: async ({ cwd: dir, scope, trust } = {}) => {
    const cwd = dir ? await scanDirectory(dir) : null;
    const report = await hooksConfig.scan({ cwd, scopes: cwd && scope !== 'user' ? ['user', 'directory'] : ['user'] });
    return withCodexTrust(report, cwd ?? os.homedir(), { trust: trust === true });
  },
  read: (args) => hooksConfig.read(args).catch((e) => { throw hookFailure(e); }),
  save: (args) => hooksConfig.save(args),
  copy: (args) => hooksConfig.copy(args),
  session: async (args = {}) => {
    // 会話の右パネル: その会話の場所で見つかった定義（読み込まれたかは分からない）と、受け取った発火の記録。
    // Hooks を Pleiad がそろえた会話は、そのターンの記録（渡した登録・止めたネイティブ・渡せなかったもの・漏れ）も返す（unify）
    const id = args.sessionId ?? null;
    const agent = HOOK_AGENTS.includes(args.backend) ? args.backend : null;
    const cwd = args.cwd ? await scanDirectory(args.cwd).catch(() => null) : null;
    const report = agent && cwd ? await hooksConfig.scan({ cwd, agents: [agent] }) : null;
    if (report && agent === 'codex') await withCodexTrust(report, cwd, { trust: args.trust === true });
    const saved = id ? await store.get(id).catch(() => ({})) : {};
    const live = id ? runtime.turns.get(id) : null;
    const unify = live?.contextRecord?.hooks ?? saved.contextSession?.hooks ?? null;
    const owner = cwd ? (await plyHooks.resolve(cwd).catch(() => null))?.owner ?? 'native' : 'native';
    // 発火を受け取れる接続: Claude（通知・コールバック）、Codex（hook/started・hook/completed）、Antigravity は Pleiad が渡した分だけ（アダプターの記録）
    const observable = agent === 'claude' || agent === 'codex' ? 'all' : agent === 'antigravity' && unify?.owner === 'ply' ? 'pleiad' : null;
    return { agent, cwd, report, observable: Boolean(observable), observed: observable, owner, unify, runs: trimHookRuns([...(saved.hookRuns ?? []), ...(live?.hookRuns ?? [])]) };
  },
  view: (cwd) => plyHooks.view(cwd),
  readPly: (id) => plyHooks.readHook(id).catch((e) => { throw hookFailure(e); }),
  saveHook: (value, cwd) => plyHooks.save(value ?? {}, { cwd }),
  remove: (id, cwd) => plyHooks.remove(id, { cwd }),
  toggle: (id, enabled, cwd) => plyHooks.toggle(id, enabled, { cwd }),
  setOwner: async (args = {}) => {
    // 担当と取り込みを 1 回で保存する。取り込む定義はサーバーがファイルから読み直す（画面から来たコマンドは使わない）
    // 確認票: 確認の面で見た版（revision）と、取り込む行ごとの元の定義の hash（digest）。どちらかが変わっていれば保存しない（確認し直す）
    const place = args.place ?? null;
    if (typeof args.revision !== 'string') throw new Error(t('hooksUnify.reviewRequired'));
    const wanted = Array.isArray(args.imports) ? args.imports : [];
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
    return plyHooks.setOwner({ place, value: args.value ?? null, add, cwd: args.cwd ?? place, expect: args.revision });
  },
  // 壊れた hooks.json を退避して、読めた部分だけで書き直す（画面で影響を知らせてから押させる）
  repair: (cwd) => plyHooks.repair({ cwd }),
  // 担当を変える前の見込み（hooks.unifyPreview。ADR 0105）
  unifyPreview: (args) => hooksUnifyPreview(args),
};

// コンテキスト（core/ops/context.mjs）の本体。設定を変えたら全画面へ settingsChanged（変えた主体つき）
const opsContext = {
  view: (cwd) => contextSettings.view(cwd),
  set: async (args, actor) => {
    const view = await contextSettings.set(args ?? {});
    settingsChanged(['context.default'], actor);
    return view;
  },
  plyInstructions: () => plyInstructionsState(),
  plyInstructionItems: () => plyInstructionsCache,
  previewPlyInstructions: (action) => changePlyInstructions(plyInstructionsCache, action, currentLocale()),
  setPlyInstructions: async (action, actor) => {
    await applyPlyInstructions(changePlyInstructions(plyInstructionsCache, action, currentLocale()));
    settingsChanged(['plyInstructions'], actor);
    return plyInstructionsState();
  },
  refresh: (sessionId) => contextSession.refresh(sessionId),
  setSessionMcp: (sessionId, name, removed) => contextSession.setMcp(sessionId, name, removed),
  removedMcp: async (sessionId) => {
    const live = runtime.turns.get(sessionId)?.contextRecord;
    return (live ?? (await store.get(sessionId)).contextSession)?.policy?.removedMcp ?? [];
  },
  // ---- 中身を読む（context.session・diff・scan・skills・agentMcp・nativeInstructions・findings。ADR 0105）。WS の同じ名前のコマンドがしていた処理
  // 会話の文脈。固定された会話だけ、今のファイルと突き合わせる（ネイティブの会話では探索しない）。ほかの探索が走っている間は突き合わせを飛ばす
  session: async (sessionId, { compare = true, lock = null } = {}) => {
    const saved = sessionId ? (await store.get(sessionId)).contextSession : null;
    if (!saved?.report) return null;
    let changed = null;
    if (saved.pin && compare && !lock?.busy()) {
      try { changed = lock ? await lock.run(() => pinChanges(saved)) : await pinChanges(saved); }
      catch { changed = null; }
    }
    return { report: saved.report, owners: saved.policy?.owners ?? saved.report.owners, pinned: Boolean(saved.pin), changed,
      startedAt: saved.policy?.at ?? null, refreshedAt: saved.policy?.refreshedAt ?? null, removedMcp: saved.policy?.removedMcp ?? [], added: saved.added ?? [],
      plyParts: saved.plyParts ?? null };
  },
  diff: (sessionId) => contextSession.diff(sessionId),
  agentMcp: async (cwd) => contextSession.agentMcp((await contextSettings.get(cwd ?? process.cwd())).cwd),
  nativeInstructions: async (cwd, backend) => contextSession.nativeInstructions((await contextSettings.get(cwd ?? process.cwd())).cwd, backend),
  findings: async (sessionId, cwd, backend) => contextSession.findings(sessionId, (await contextSettings.get(cwd ?? process.cwd())).cwd, backend),
  // place: 'default' なら場所ごとの上書きを使わず既定だけで探す（設定の「すべての場所」）。scope: 'user' ならユーザーの範囲（home と足した場所）だけ、'directory' なら作業場所の範囲だけ
  scan: async ({ cwd, place, scope } = {}) => scanContext(await contextSettings.get(cwd ?? process.cwd(), { level: place === 'default' ? 'default' : null }),
    { plyServers: await plyMcp.scanInput(), ...(scope === 'user' || scope === 'directory' ? { scopes: [scope] } : {}) }),
  // 入力欄の「/」の候補。コンテキストの画面と同じ探索をそのまま使い、スキルだけを返す
  skills: async (cwd) => skillList(await scanContext(await contextSettings.get(cwd ?? process.cwd()))),
};

/**
 * コンテキストの探索の錠（探索は 1 つずつ。走っている間の 2 つ目は SCAN_BUSY）。画面は接続ごと（ws.contextScanning）、
 * AI・CLI はまとめて 1 つ（agentScanLock）。context.* の操作が ctx.scanLock で受け取る
 */
function scanLockOf(holder) {
  return {
    busy: () => holder.contextScanning === true,
    run: async (fn) => {
      if (holder.contextScanning) throw Object.assign(new Error(t('scan.busy')), { code: 'SCAN_BUSY' });
      holder.contextScanning = true;
      try { return await fn(); } finally { holder.contextScanning = false; }
    },
  };
}
const agentScanLock = scanLockOf({});

// git の動き（git.*。core/ops/git.mjs、ADR 0085・0105）の本体。作業場所は会話の cwd。git が無い・git 管理外は git: null
const opsGit = {
  status: async (args) => {
    const cwd = await gitCwd(args);
    if (!cwd) return { git: null };
    return { git: args?.summary ? await gitActivity.summary(cwd, args?.sessionId) : await gitActivity.status(cwd, { fresh: args?.fresh === true }) };
  },
  // 右パネルの git の面。sweep: 開いたときに片付けられる worktree を片付ける（画面だけ）
  panel: async (args, { sweep = false } = {}) => {
    const sessionId = args?.sessionId;
    const cwd = await gitCwd(args);
    const only = args?.only === 'changes' || args?.only === 'light' ? args.only : null;
    const state = cwd ? await gitActivity.status(cwd, { fresh: only !== 'changes' }) : null;
    if (!state) return { git: null };
    const range = args?.range === 'session' ? 'session' : 'uncommitted';
    // 範囲の切り替えは変更の一覧だけで足りる（会話の記録も、worktree の一覧も読まない）
    if (only === 'changes') return { git: state, changes: await gitActivity.changes(cwd, sessionId, range), at: Date.now() };
    if (sweep) worktreeSweepSoon();
    const worktrees = only === 'light' ? { current: null, leftovers: [] } : { current: await worktreeHost.worktrees.byPath(cwd).then(e => (e ? publicWorktree(e) : null)).catch(() => null), leftovers: await worktreeHost.leftovers({ cwd }).catch(() => []) };
    const backend = sessionId ? await resolveBackendForSession(sessionId) : null;
    const timeline = sessionId ? timelineOf((await history.loadTranscript(sessionId, backend).catch(() => ({ messages: [] }))).messages) : [];
    const changes = await gitActivity.changes(cwd, sessionId, range);
    return { git: state, timeline, changes, worktrees, at: Date.now() };
  },
  diff: async (args) => {
    const cwd = await gitWorktreeCwd(args);
    const opts = { stage: args?.stage, commit: args?.commit, from: args?.from, to: args?.to, orig: args?.orig, context: args?.context, after: args?.after === true };
    return { diff: cwd ? await gitActivity.diff(cwd, args?.sessionId, args?.range === 'session' ? 'session' : 'uncommitted', String(args?.path ?? ''), opts) : null };
  },
  // コミットの履歴（グラフ）の 1 ページ。skip は読み飛ばす件数
  history: async (args) => {
    const cwd = await gitCwd(args);
    return { history: cwd ? await gitActivity.commits(cwd, args?.sessionId, { limit: args?.limit, skip: args?.skip }) : null };
  },
  // コミット 1 つの題・本文と変わったファイル
  commit: async (args) => {
    const cwd = await gitCwd(args);
    return { commit: cwd ? await gitActivity.commit(cwd, args?.hash) : null };
  },
  // このリポジトリの作業場所（git worktree）の一覧。Pleiad の台帳と突き合わせ、ふつうの git worktree add で作ったものも出す
  worktrees: async (args) => {
    const cwd = await gitCwd(args);
    const info = cwd ? await gitInfo.repoInfo(cwd) : null;
    const view = info ? await gitHistory.readWorktrees(info.root) : null;
    if (!view) return { worktrees: null };
    const [ledger, left, all] = await Promise.all([worktreeHost.worktrees.list().catch(() => []), worktreeHost.leftovers({ cwd }).catch(() => []), store.getAll().catch(() => ({}))]);
    const rows = await Promise.all(view.rows.map(async (row) => {
      const entry = ledger.find(e => e.state === 'ready' && sameDir(e.path, row.path));
      if (row.here) return { ...row, kind: 'here' };
      if (!entry) return { ...row, kind: 'plain' };
      const leftover = left.find(l => l.id === entry.id);
      if (leftover) return { ...row, kind: 'left', leftover };
      const users = await worktreeHost.users(entry, all).catch(() => ({ busy: [], attached: [] }));
      if (users.busy.length || users.attached.length) {
        const who = users.attached.map(a => all?.[a.sessionId]?.title).find(Boolean) ?? '';
        return { ...row, kind: 'busy', who };
      }
      return { ...row, kind: 'clean' };
    }));
    return { worktrees: { base: view.base, total: view.total, rows } };
  },
  // 作業場所 1 つの中身（主の作業場所の HEAD との分岐点からのコミット済みの変更と、コミットしていない変更）
  worktree: async (args) => {
    const cwd = await gitWorktreeCwd(args);
    const info = cwd ? await gitInfo.repoInfo(cwd) : null;
    if (!info || !args?.worktree) return { worktree: null };
    const list = await worktreeList(info.root);
    const baseHead = list?.[0]?.head ?? null;
    return { worktree: { path: cwd, ...(await gitHistory.readWorktreeDetail(info.root, cwd, baseHead)) } };
  },
};

// 会話のシェル（shell.*。core/ops/shell.mjs、ADR 0054・0105）の本体。WS の runShell・stopShell・skipShell がしていた処理
const opsShell = {
  // 承認カードの 1 文の材料（どの会話で・どこで動くか）
  describe: async (sessionId) => {
    const meta = await store.get(sessionId).catch(() => ({}));
    const backend = await resolveBackendForSession(sessionId).catch(() => null);
    return { backend: backend?.id ?? null, cwd: meta?.cwd ?? null, title: await conversationTitleOf(sessionId).catch(() => '') };
  },
  // 人の `!` と同じ。承認モードは掛けない（AI の呼び出しは操作の一覧の guarded で聞く）。送信待ちにも送り直しの控えにも積まない
  run: async ({ sessionId, runId, command, cwd: asked }) => {
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
    const cwd = !sidecar.unsent && sidecar.cwd ? sidecar.cwd : typeof asked === 'string' && asked.trim() ? asked.trim() : sidecar.cwd;
    if (!cwd || !(await fs.stat(cwd).then(st => st.isDirectory(), () => false))) throw Object.assign(new Error(t('shell.noCwd')), { code: 'SHELL_NO_CWD' });
    return shellRuns.start({ sessionId, runId, command, cwd, backend });
  },
  wait: (runId, ms) => shellRuns.wait(runId, ms),
  stop: (runId) => ({ stopped: shellRuns.stop(runId) }),
  // 行ごとの「渡さない」（ADR 0055）。ホストで走らせる会話だけ。Codex は結果がエージェントの会話に入っていて外せない
  skip: async ({ sessionId, runId, skip }) => {
    const backend = sessionId ? await resolveBackendForSession(sessionId) : null;
    if (!backend) throw new Error(t('session.notFound'));
    try {
      return await shellRuns.setSkip({ sessionId, runId, skip: Boolean(skip), backend });
    } catch (e) {
      if (e?.code === 'SHELL_UNAVAILABLE') throw Object.assign(new Error(t('shell.skipUnavailable')), { code: e.code });
      if (e?.code === 'SHELL_HANDING') throw Object.assign(new Error(t('shell.handing')), { code: e.code });
      if (e?.code === 'SHELL_HANDED') throw Object.assign(new Error(t('shell.alreadyHanded')), { code: e.code });
      throw e;
    }
  },
};

// バックグラウンドの処理・サブエージェント・エージェントの切り替え・グループ（core/ops/session-work.mjs、ADR 0105）の本体。WS の同じ名前のコマンドがしていた処理
const opsSessionWork = {
  // 切り替えの見込み: 今のエージェントと承認モード、切り替え先と、切り替えたときの承認モード（切り替え先の最初のモード。core/conversations.mjs の switchBackend）
  switchPlan: async (sessionId, targetId) => {
    const source = await resolveBackendForSession(sessionId).catch(() => null);
    if (!source) return null;
    const mode = await resolveMode(sessionId, undefined, source).catch(() => Object.keys(source.modes())[0] ?? 'default');
    const target = getBackend(targetId);
    const toMode = target ? Object.keys(target.modes())[0] ?? 'default' : null;
    return { title: await conversationTitleOf(sessionId).catch(() => ''), from: { backend: source.id, mode, position: source.modes()[mode] ?? null },
      to: target ? { backend: target.id, label: target.label ?? target.id, mode: toMode, position: target.modes()[toMode] ?? null } : null };
  },
  switchBackend: async (sessionId, targetId) => {
    if (runtime.turns.has(sessionId) || switching.has(sessionId) || forking.has(sessionId)) throw new Error(t('session.finishBeforeSwitch'));
    compactionScheduler.cancel(sessionId);
    switching.add(sessionId);
    try {
      const source = refuseRetired(await resolveBackendForSession(sessionId));
      const target = getBackend(targetId);
      if (!source || !target) throw new Error(t('agents.notFound'));
      await switchBackend(sessionId, source, target);
      if (source.id !== target.id) {
        if ((await store.get(sessionId)).interrupted?.reason === 'limit') await leaveLimit(sessionId);
      }
      // 入力欄の `!`: 走っている分は止め、渡していない分は捨てる（前のエージェントの形でしか渡せない。ADR 0054）
      if (source.id !== target.id) await shellRuns.switched(sessionId, source, target);
      // 接続先はエージェントごとの形式なので、エージェントが変わったら変えた先の既定（「既定にする」を押したもの。無ければ公式）に置き直す
      if (source.id !== target.id) await store.setSessionData(sessionId, 'compatEndpoint', endpointCapable(target) ? await compatEndpoints.defaultFor(target.id) : '');
      await savePref("backend", target.id);
      emitGlobal({ type: "backend", sessionId, backend: target.id });
      return { sessionId, backend: target.id };
    } finally { switching.delete(sessionId); completionNotices.changed(sessionId); }
  },
  // グループから外す / 戻す。まとまりは親子と状態から決まるので、覚えるのは「外した」ことだけ
  setGrouped: async (sessionId, ungrouped) => {
    await store.setSessionData(sessionId, "ungrouped", ungrouped ? true : null);
    emitGlobal({ type: "group", sessionId, ungrouped: Boolean(ungrouped) });
    return { sessionId, ungrouped: Boolean(ungrouped) };
  },
  // 会話の裏の処理の一覧（ターンの外で動いているものと、走っているターンのもの）
  backgroundTasks: (sessionId) => {
    const rows = [...(runtime.background.get(sessionId)?.tasks ?? []), ...(runtime.turns.get(sessionId)?.info.background ?? [])];
    return rows.filter((x, i) => x?.id && rows.findIndex((y) => y?.id === x.id) === i);
  },
  // 詳細の読み出しは停止から独立した操作
  background: async (sessionId, taskId) => {
    const found = findBackgroundTask(sessionId, taskId);
    if (!found) return { task: null };
    const detail = await found.backend?.getBackgroundTask?.(sessionId, taskId);
    return { task: detail ?? { ...found.task, status: 'running', output: null } };
  },
  // ターンの中断（abort）とは別に、裏の作業を1本止める
  stopBackground: async (sessionId, taskId) => {
    const found = findBackgroundTask(sessionId, taskId);
    if (!found) throw new Error(t('background.notRunning'));
    if (!found.backend?.stopBackground) throw new Error(t('background.cannotStop', { backend: found.backendId }));
    const res = await found.backend.stopBackground(sessionId, taskId);
    return { stopped: res?.stopped !== false };
  },
  // サブエージェントの会話を読む。表示に要る最小形へ落とす
  readSubagent: async (sessionId, agentId) => {
    const backend = await resolveBackendForSession(sessionId);
    if (!backend?.getSubagentMessages) return { agentId, sessionId, messages: [] };
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
    return { agentId, sessionId, origin, prompt: origin ? turn.taskHints.get(origin)?.prompt ?? null : null, messages };
  },
  // 会話の中の委譲ツールのカードから、それが生んだサブエージェントを引く（終わってターンの一覧から外れた子を開くため）
  findSubagent: async (sessionId, toolId) => {
    const backend = await resolveBackendForSession(sessionId);
    if (!backend?.listSubagents || !backend.getSubagentOrigin) return { agentId: null };
    for (const id of await backend.listSubagents(sessionId).catch(() => [])) {
      if (await backend.getSubagentOrigin(sessionId, id).catch(() => null) === toolId) return { agentId: id, ...(await subagentStateOf(backend, sessionId, id)) };
    }
    return { agentId: null };
  },
  // 会話のサブエージェントの一覧（生んだ委譲ツールの id と、分かれば状態）
  subagents: async (sessionId) => {
    const backend = await resolveBackendForSession(sessionId);
    if (!backend?.listSubagents) return [];
    const ids = await backend.listSubagents(sessionId).catch(() => []);
    return Promise.all(ids.map(async (id) => ({ agentId: id, origin: backend.getSubagentOrigin ? await backend.getSubagentOrigin(sessionId, id).catch(() => null) : null,
      ...(await subagentStateOf(backend, sessionId, id)) })));
  },
};
/** サブエージェントの状態（取れないエージェントは null） */
async function subagentStateOf(backend, sessionId, id) {
  const raw = typeof backend.getSubagentState === 'function' ? await backend.getSubagentState(sessionId, id).catch(() => null) : null;
  const state = raw && SUBAGENT_STATUS.has(raw.status) ? raw : null;
  return { status: state?.status ?? null, startedAt: state?.startedAt ?? null, endedAt: state?.endedAt ?? null };
}

// リモート（core/ops/remote.mjs）の本体。秘密・トークンは返さない（core/remote/connector.mjs）
const opsRemote = {
  status: () => remoteStatus(),
  setResident: async (patch) => {
    await residentPrefs.set({ keepRunning: patch.keepRunning, sleep: patch.sleep });
    const status = await remoteStatus();
    emitGlobal({ type: 'remoteStatus', status, sessionId: null });
    postResident({ status });
    return status;
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
    title: key ? t('permission.settingChange', { agent: agent.label, key }) : t('permission.opApproval', { agent: agent.label, op }),
    // words: 承認カードの言葉の組（defineOp の approvalWords。無ければ画面が共通の言葉にする）
    settingChange: { op, key: key ?? op, requestId: id, ...(change.words ? { words: change.words } : {}), rows: change.rows ?? [], ...(change.note ? { note: change.note } : {}), loosens: Boolean(change.loosens), ...(reason ? { reason } : {}), receipt, agent },
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

/** 設定と操作の承認結果を、エージェントへ渡す文にする。via は、求めた子ではなく依頼元へ届けるときの子（routeSettingNotice） */
function settingNotice(lng, notices) {
  // i18n-dynamic: agent:ops.settingNotice.
  return notices.map((n) => {
    const setting = n.op === 'settings.set';
    const words = setting ? null : opsRegistry.get(n.op)?.approvalWords ?? 'op';
    const params = setting ? { target: settingTarget(lng, n.op, n.key) } : approvalWords(lng, words);
    const kind = setting ? '' : 'op';
    const outcome = kind + n.outcome[0].toUpperCase() + n.outcome.slice(1);
    return agentT(lng, `ops.settingNotice.${setting ? 'head' : 'opHead'}`, { requestId: n.requestId, status: agentT(lng, `ops.settingNotice.status.${n.outcome}`), words })
      + (n.via ? '\n' + agentT(lng, `ops.settingNotice.${setting ? 'fromChild' : 'opFromChild'}`, { taskId: n.via.taskId, title: n.via.title ?? '', state: n.via.status }) : '')
      + '\n' + agentT(lng, `ops.settingNotice.${setting ? n.outcome : outcome}`, { ...params, error: n.error ?? '' });
  }).join('\n\n');
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
      scheduleSend: (input, by) => scheduleSendMessage(input, by),
      // 「今すぐ送る」。取り出した予定を同じ入口で送る。送れなければ予定に戻す（失っても二重にもしない）
      sendScheduledNow: async id => {
        const kind = schedule.get(id)?.kind;
        if (kind !== 'send' && kind !== 'post') throw new Error(t('schedule.notFound'));
        const taken = await schedule.take(id);
        if (!taken) throw new Error(t('schedule.notFound'));
        try { if (kind === 'post') await postScheduled(taken); else await sendScheduledNow(taken); }
        catch (e) { await schedule.put(taken).catch(() => {}); throw e; }
        return kind === 'post' ? { sent: true, sessionId: '', messageId: taken.clientId } : { sent: true, sessionId: taken.sessionId, messageId: taken.messageId };
      },
      cancel: async id => {
        const row = schedule.list().find(entry => entry.id === id);
        // 送信予定・投稿の予定は取り出して返す（画面の「編集」は本文を入力欄へ戻す。取り出したものは時刻が来ても動かない）
        if (row?.kind === 'send' || row?.kind === 'post') {
          const taken = await schedule.take(id);
          return { cancelled: Boolean(taken), ...(taken ? { entry: taken } : {}) };
        }
        // 予定の取り消しは「自動で再開しない」と同じ（予定・会話の印・送信待ちの目安を合わせる）
        const cancelled = await schedule.cancel(id);
        if (cancelled && row?.kind === 'resume') {
          const meta = await store.get(row.sessionId);
          if (meta.interrupted?.reason === 'limit' && meta.interrupted.at === row.createdAt) await setAutoResume(row.sessionId, false, { user: true });
        }
        return { cancelled };
      },
      setAuto: (sessionId, enabled) => setAutoResume(sessionId, enabled, { strict: true, user: true }),
    },
    delegation: { list: (owner) => withWorktreeLive(agentTasks?.list(owner) ?? []), get: (taskId, offset) => agentTasks?.get(taskId, offset) ?? null,
      call: (owner, name, args, locale) => callAgentOp(owner, name, args, { locale }),
      instructions: (taskId) => agentTasks.instructions(taskId),
      // ホストに任せた子の会話の経過（delegation.hostView。画面の人だけ。core/remote-delegation.mjs の view）
      hostView: (args) => remoteDelegation.view(args),
      // 画面の「止める」。どの会話の委譲でも止められる（AI は ply_task_cancel で自分の子だけ）
      cancel: async (taskId) => {
        const task = agentTasks.get(taskId);
        if (!task) throw new Error(t('delegation.taskNotFound'));
        await agentTasks.cancel(task.taskId);
        return agentTasks.get(task.taskId);
      },
      retry: (args) => retryAgentTask(args),
      // 委譲先の自動振り分けの設定（設定 › 委譲）。キーは返さない（hasKey だけ）。refresh: true なら使用量を取り直してから返す
      routing: async ({ refresh } = {}) => {
        if (refresh && routingSettingsCache.enabled) await routingUsage.refresh();
        return delegationRoutingState();
      },
      providerUsage: (id) => providerUsageOf({ backend: id }) },
    conversations: opsConversations,
    agents: opsAgents,
    prefs: () => store.getPrefs(),
    voice: { status: async () => ({ ...(await voiceHost.status()), keyRef: (await apiKeys.hasUse('voice')) ? apiKeys.usesState().voice : null }) },
    // 設定 › API キー（core/ops/api-keys.mjs）。キーの値は持たない。入れる・消す・割り当てるのは human-only の WS コマンド（ADR 0155）
    apiKeys: { list: () => apiKeys.list(), check: id => apiKeys.check(id) },
    compactionSettings: () => compactionSettings,
    statuses: opsStatuses,
    worktrees: opsWorktrees,
    notify: opsNotify,
    notifications: inbox,
    // 入力欄の書きかけのサーバーの写し（drafts.*。ADR 0157 の F35）
    drafts: threadDrafts,
    compat: opsCompat,
    computer: opsComputer,
    chrome: opsChrome,
    // MCP・Hooks・コンテキスト・リモート・接続先の操作（core/ops/mcp.mjs・hooks.mjs・context.mjs・remote.mjs。ADR 0095）。WS の同じ名前のコマンドがしていた処理
    mcp: opsMcp,
    hooks: opsHooks,
    context: opsContext,
    remote: opsRemote,
    endpoints: { list: (agent) => compatEndpoints.list(agent) },
    // git・会話のシェル・会話の裏の処理とサブエージェント・フォルダーの一覧（core/ops/git.mjs・shell.mjs・session-work.mjs・files.mjs。ADR 0105）
    git: opsGit,
    shell: opsShell,
    sessionWork: opsSessionWork,
    files: { listDirs: (p, opts) => listDirs(p, opts) },
    // 貼り付けた HTML の画像を取りに行く（attachments.*。ADR 0141）
    attachments: { importImage: (input) => imageImporter.importImage(input), cancelImport: (id) => imageImporter.cancel(id) },
    // コンテキストの探索の錠。AI・CLI はまとめて 1 つ（画面の WS は接続ごとの錠で上書きする）
    scanLock: agentScanLock,
    sessionCwd: async (id) => (await store.get(id)).cwd ?? null,
    sessionBackend: async (id) => (await resolveBackendForSession(id).catch(() => null))?.id,
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
    // channels・bots・memory・routines・botOfSession（ops の handler が ctx.channels などで呼ぶ）
    ...botHost?.opsDeps(),
    // スレッドへの返信の予定（channels.schedulePost。kind 'post'）
    schedulePost: (args) => schedulePost(args),
    // 会話の発言を、包みを分ける前の生の本文で読む（channels.deliveries。エージェントに渡した原文）
    // Pleiad が持つ会話（bot の会話）は、読み込んで最新の行を記録へ足してから、記録の生の行を返す（getMessages の返りは包みを分けた後の形）
    rawMessages: async (sessionId) => {
      const backend = await resolveBackendForSession(sessionId);
      if (!backend?.getMessages) return [];
      const shown = await backend.getMessages(sessionId);
      const record = await conversation(sessionId).catch(() => null);
      return Array.isArray(record?.messages) ? record.messages : shown;
    },
    describeAttachments,
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

/** ホストに任せたタスクの印に使う、つないでいるホストの名前とオンラインか（running に載せる。docs/remote.md §4.5） */
function remoteHostsNow() {
  const out = {};
  for (const h of remoteAgentBridge?.hosts ?? []) if (h.agentUse) {
    const online = h.state === 'ready' && h.allowed === true;
    // since: 線が使えなくなった時刻（画面の「オフライン · HH:MM までの分」）。分からなければ付けない
    out[h.hostId] = { name: h.name, online, view: h.view === true, ...(!online && remoteDelegation?.offlineSince(h.hostId) ? { since: remoteDelegation.offlineSince(h.hostId) } : {}) };
  }
  return out;
}

async function runningWork() {
  // 保持役に載っていて新しいサーバーへ渡せるターン（holdable）。切り替えはそれを待たずに引き継ぐ（desktop/switch.cjs）
  const held = new Set([...runtime.turns.values()].filter(holdable).map(t => t.info.sessionId));
  const turns = [...runtime.turns.values()].map((t) => ({ kind: "turn", ...t.info, ...(held.has(t.info.sessionId) ? { held: true } : {}) }));

  const permissions = [...runtime.waiting].map(([id, w]) => ({
    id,
    kind: "permission",
    ...(held.has(w.payload.sessionId ?? null) ? { held: true } : {}),
    toolName: w.payload.toolName,
    sessionId: w.payload.sessionId ?? null,
    askedAt: w.askedAt ?? null,
    relay: Boolean(w.relay),   // 祖先の会話へ中継した複製。元のカードと同じ1件を指す
    ...(w.remote ? { remote: { hostId: w.remote.hostId, hostName: w.remote.hostName, online: w.remote.online !== false } } : {}),   // ホストの子の承認の中継（docs/remote.md §4.5）
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
        ...(held.has(sessionId) ? { held: true } : {}),
      };
    }));
  }));
  const subagents = nested.flat();

  // ターンの外で裏に残っている作業（Codex のバックグラウンド端末など）。
  // count には入れない: デスクトップは count > 0 の間は終了させないが、これは Pleiad から止める口が無い
  const background = [...runtime.background.values()].map((b) => ({
    kind: "background", ...b, tasks: b.tasks.map((x) => ({ ...x })),
  }));

  const dueRows = schedule.list();
  // 委譲のタスクは、終わっていないものと完了通知が届いていないものだけ（agentTasks.running）。過去の分は会話ごとに delegation.tasks で読む
  const tasks = withWorktreeLive(agentTasks?.running() ?? []);
  const count = turns.length + permissions.filter((p) => !p.relay && !p.detached).length
    + subagents.filter((a) => a.status === "running" || a.status == null).length + tasks.filter(r => !r.host && ["queued", "running", "cancelling"].includes(r.status) && !runtime.turns.has(r.sessionId)).length;
  // 渡せる作業の数（count のうち、保持役に載ったターンとその承認待ち・サブエージェント）。blocking は引き継ぎを待たせる作業（無ければ作業の最中でも切り替わる）
  const heldCount = turns.filter(x => x.held).length + permissions.filter(p => p.held && !p.relay && !p.detached).length
    + subagents.filter(a => a.held && (a.status === "running" || a.status == null)).length;
  return {
    turns,
    permissions,
    subagents,
    // 終了している間は動かない予定（送信予定・上限の解除後の再開）。終了の確認に件数と次の時刻を出す
    scheduled: { send: dueRows.filter(r => r.kind === 'send' && !r.held).length, held: dueRows.filter(r => r.kind === 'send' && r.held).length,
      resume: dueRows.filter(r => r.kind === 'resume').length,
      nextSendAt: Math.min(Infinity, ...dueRows.filter(r => r.kind === 'send' && !r.held).map(r => r.at)) },
    tasks,
    background,
    // `!` の行。count には入れない（終了・中断して更新では止まる。デスクトップの無停止の切り替えは終わるのを待つ。保持役に載った行（held）は待たずに渡す。desktop/switch.cjs）
    shells: shellRuns.list(),
    // ホストに任せたタスクの印（⇄ ホスト名とオンラインか）。docs/remote.md §4.5
    remoteHosts: remoteHostsNow(),
    // 中継の複製は数えない。1つの承認が会話の数だけ増えて見える
    // サブエージェントは走っている子だけを数える。終わった子はターンが終わるまで一覧に残るので、
    // そのまま数えると更新のゲート（web の count > 0）が閉じたままになる。status が null の子
    // （状態を返せないバックエンド・まだ分からない子）は数える。数えないとゲートを緩めてしまう
    // 設定の変更の承認（detached）は期限なしで残るので数えない（数えると、答えるまで終了も更新もできない）
    count,
    // 引き継ぎ（core/handover.mjs）に対応しているサーバーだけが載せる。main の切り替えは blocking が 0 なら待たずに引き継ぐ
    handover: { v: HANDOVER_VERSION, holder: HOLDER_PROTOCOL, held: heldCount, blocking: count - heldCount },
  };
}

/** 委譲の行に、worktree が台帳に残っているか（live。画面の「未取り込み」の印）を付ける */
function withWorktreeLive(rows) {
  if (!rows.some(r => r.worktree)) return rows;
  const live = new Set(worktreeHost.worktrees.ids().map(x => x.id));
  return rows.map(r => (r.worktree ? { ...r, worktree: { ...r.worktree, live: live.has(r.worktree.id) } } : r));
}

/**
 * 実行中の状況を配る。増減が見えないと「動いているのか分からない」に戻る。
 * 集めるのは非同期（サブエージェントの一覧を読む）なので、続けて呼ぶと古い方が後から届きうる。
 * phase と background は同じ瞬間に続けて変わるので、最後に始めた 1 回だけを配る。
 * 4 秒ごとの定期便（poll）は、前に配ったものと中身が同じなら送らない（中継の細い帯域を埋めない）
 */
let runningSeq = 0, runningSent = '';
async function broadcastRunning({ poll = false } = {}) {
  const seq = ++runningSeq;
  const work = await runningWork().catch(() => null);
  if (!work || seq !== runningSeq) return;
  const body = JSON.stringify(work);
  if (poll && body === runningSent) return;
  runningSent = body;
  emitGlobal({ type: "running", ...work }); postResident({ work });
}

/** サブエージェントは走っている最中に増える。1本でも走っていれば（裏に残っていれば）定期的に配る。 */
function syncRunningPoll() {
  const want = runtime.turns.size > 0 || runtime.background.size > 0;
  if (want && !runtime.runningPoll) runtime.runningPoll = setInterval(() => broadcastRunning({ poll: true }), 4000);
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
  remoteTasksChanged();
}

/**
 * 委譲でつながった祖先の会話を、近い順に並べる。
 * 会話メタデータの delegation（prepare が書く）を親へ辿る。
 * 壊れた記録で回り続けないよう、同じ会話は二度通らず、辿る回数にも上限を置く（委譲は4階層まで）。
 */
async function delegationAncestors(sessionId) {
  return (await delegationRoot(sessionId)).chain;
}

/**
 * delegationAncestors に、鎖のいちばん上が端末の AI（仮の親 remote:<deviceId>:<会話>）かどうかを足したもの。
 * chain はホストの会話の祖先だけ（仮の親は含めない。画面に出す先が無い）。remote は端末の AI に任された子の鎖なら
 * { deviceId, sessionId（端末の会話）, taskId（端末が任せたタスク）, owner（仮の親の ID）, deviceName?, title? }（docs/remote.md §4.5）
 */
async function delegationRoot(sessionId) {
  const chain = [];
  const seen = new Set([sessionId]);
  let id = sessionId;
  let remote = null;
  for (let i = 0; i < 8; i++) {
    const delegation = (await store.get(id)).delegation;
    const parent = delegation?.parentSessionId;
    if (!parent || seen.has(parent)) break;
    if (isRemoteOwner(parent)) {
      const p = parseRemoteOwner(parent);
      if (p) remote = { ...p, owner: parent, taskId: delegation.taskId ?? null, deviceName: delegation.remote?.deviceName ?? '', title: delegation.remote?.title ?? '', stoppedAt: delegation.remote?.stoppedAt ?? null };
      break;
    }
    seen.add(parent);
    chain.push(parent);
    id = parent;
  }
  return { chain, remote };
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
const approvalIds = createApprovalIds();
const askPermission = async ({ toolName, input, sessionId, toolUseID, title, signal, canAlways, kind, questions, locale, browserSite, computerApp, settingChange, detached = false }) => {
  const { chain: ancestors, remote: remoteRoot } = sessionId ? await delegationRoot(sessionId) : { chain: [], remote: null };
  // 中継先の見出しは「どの会話の承認か」。委譲したときの info.title を使う
  const childTitle = ancestors.length || remoteRoot ? (await store.get(sessionId)).title || t('permission.childConversation') : "";
  const askingMeta = sessionId ? await store.get(sessionId).catch(() => null) : null;
  const conversationTitle = askingMeta?.title ?? '';
  // 拒否・中断の理由はエージェントに返るので、承認を求めた会話の言語で訳す（settle には messageKey で来る）
  const lng = agentLocaleOf(locale) ?? await agentLocaleFor(sessionId);
  // i18n-dynamic: agent:approval.
  const localize = answer => answer?.messageKey ? { ...answer, message: agentT(lng, `approval.${answer.messageKey}`, answer.messageParams) } : answer;
  // 隠れた会話（心拍の安いモデル・夜の記憶の整理。ADR 0126）は人に見えない。承認を求めても誰も答えず、その心拍・整理が止まったまま
  // （心拍は 1 本ずつ流すので、ほかの bot の心拍も）になる。カードもスマホの通知も出さず、すぐ断る（道具は使わせない）
  if (HIDDEN_BOT_KINDS.has(askingMeta?.bot?.kind)) return localize({ allow: false, messageKey: 'hiddenConversation' });
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
      // 端末の AI に任された子の承認。画面は「依頼元の会話（⇄ 端末）でも答えられます」を添える（docs/remote.md §4.5）
      ...(remoteRoot ? { remoteOrigin: { deviceName: remoteRoot.deviceName || '' } } : {}),
    };
    // 祖先ごとに別の id の複製を作り、どれも同じ settle を指す。
    // web は「id ごとに1つの会話」の前提のまま動き、消せば勝手に片付く
    // 承認の id は、ツールの id があれば会話の id との組から決まる値（付け直しで旧サーバーと同じ id になる。core/approval-id.mjs）
    const cards = [{ id: approvalIds.next(sessionId, toolUseID), payload, relay: false }, ...ancestors.map((ancestor) => ({
      id: approvalIds.next(ancestor, toolUseID),
      relay: true,
      // Tool-wide grants stay in the child. Browser and computer grants show the specific agent
      // and origin / app, so the same choices are available to ancestors.
      payload: { ...payload, sessionId: ancestor, canAlways: !!browserSite || !!computerApp, title: title ? t('permission.relayTitleWith', { child: childTitle, title }) : t('permission.relayTitle', { child: childTitle }) },
    }))];
    // 端末の AI に任された子の承認は、端末（依頼元の会話）へも中継する（docs/remote.md §4.5）。決着したら端末のカードも畳む
    let remoteRelay = null;
    const onAbort = () => settle({ allow: false, messageKey: 'aborted' });
    const settle = (answer) => {
      // どれか1つで決着し、残りの複製も消す。1つも残っていなければ二重解決
      let found = false;
      for (const card of cards) if (runtime.waiting.delete(card.id)) found = true;
      if (!found) return;
      touchCard(runtime.turns.get(sessionId));
      // 片付いたことを画面へ知らせる。本来のカードも、祖先の会話の中継の複製も、ほかの窓・リモートの画面に残った写しも、これで畳める
      // （running の permissions から消えるだけでは、開いたままのカードは変わらない）。複製は id ごと・会話ごとに 1 つずつ
      for (const card of cards) emitGlobal({ type: 'permissionSettled', id: card.id, sessionId: card.payload.sessionId ?? null, allow: answer?.allow === true, reason: answer?.messageKey ?? null });
      remoteRelay?.end(answer?.messageKey === 'aborted' ? 'abort' : 'host', answer?.allow === true);
      // スマホに出ている承認・質問の通知を消す（どの端末で答えても、ターンが終わっても）
      pushNotifier.approvalResolved({ id: cards[0].id, sessionId: payload.sessionId });
      // 通知の一覧のあなた待ちを決着させる（承認済み・回答済み・却下・取り消し。ADR 0149）
      void inboxSources.permissionSettled({ id: cards[0].id, answer, kind: payload.kind });
      botHost?.onPermission({ id: cards[0].id, ...payload }, 'settled');
      signal?.removeEventListener?.("abort", onAbort);
      const { messageKey, messageParams, ...rest } = localize(answer);
      resolve(rest);
      permissionsChanged();
    };

    for (const card of cards) runtime.waiting.set(card.id, { settle, payload: card.payload, askedAt: new Date().toISOString(), relay: card.relay, notified: false, detached });
    touchCard(runtime.turns.get(sessionId));   // 札の waits（出している承認の id）が変わった
    // 承認・質問は端末へ中継して、そこで答えられる。設定の変更の承認（受領証つきで、決着が別の台帳へ届く）など、ターンを止めない承認（detached）は、
    // 端末の画面と AI に「ホストの画面で答えてください」と知らせるだけ（答えるボタンは無く、口からの答えも受けない。docs/remote.md §4.5）
    if (remoteRoot && remoteRoot.taskId) {
      const hostOnly = Boolean(settingChange) || detached;
      const asked = payload.kind === 'question' ? 'question' : 'tool';
      remoteRelay = remoteAgentPort.relayOpen({
        deviceId: remoteRoot.deviceId, taskId: remoteRoot.taskId, requesterSessionId: remoteRoot.sessionId,
        // childSessionId: 承認を求めている子（根か子孫）のホストでの会話。端末が、その子の詳細にだけカードを出すために使う
        payload: hostOnly ? { kind: 'hostOnly', toolName, title: title ?? null, childTitle, childSessionId: sessionId ?? null, canAlways: false }
          : { kind: asked, toolName, input, ...(asked === 'question' ? { questions } : {}), title: title ?? null, childTitle, childSessionId: sessionId ?? null, canAlways: false },
        // 端末の人の答え（remote.md §4.5）。ホストが中継した今待っている承認の ID・受領証・1 回だけを照合した後にだけ来る。常に許可は受けない
        answer: hostOnly ? null : ({ allow, message, answers, annotations, response }) => {
          if (!runtime.waiting.has(cards[0].id)) return false;
          store.recordChange(sessionId, { by: 'human', via: 'remote-device', byDevice: remoteRoot.deviceId, field: 'op', to: 'permission.answer', reason: null }).catch(() => {});
          // ホストの画面の子のカードを、端末で答えられた 1 行に畳む（permissionRelayEnd。remoteOrigin のカードだけが畳む）
          emitGlobal({ type: 'permissionRelayEnd', id: cards[0].id, sessionId, by: 'device', allow, peer: remoteRoot.deviceName || '', at: new Date().toISOString() });
          settle({ allow, always: false, scope: 'once', message: message ?? null, ...(!allow && !message && asked === 'tool' ? { messageKey: 'userDenied' } : {}),
            answers: answers ?? null, annotations: annotations ?? null, response: response ?? null });
          return true;
        },
      });
    }
    botHost?.onPermission({ id: cards[0].id, ...payload }, 'open');
    // 通知の一覧のあなた待ち。委譲の子の承認は、カードが出ている依頼元の会話へ飛ぶ（ADR 0149）
    if (payload.sessionId) void inboxSources.permissionOpened({ id: cards[0].id, sessionId: payload.sessionId, kind: payload.kind, via: ancestors[0] ?? null });
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

// サイトの利用の確認（ADR 0042）。内蔵ブラウザーの橋と Chrome の中継が同じものを使う
const browserSiteApprovals = createBrowserSiteApprovals({
  getPrefs: store.getPrefs,
  getAgent: async id => {
    const turn = runtime.turns.get(id) ?? [...runtime.turns.values()].find(turn => turn.browserRelayId === id);
    return turn ? { id: turn.backend.id, label: turn.backend.label, sessionId: turn.info.sessionId || turn.key, signal: turn.ac.signal, locale: turn.agentLocale } : null;
  },
  askPermission, translate: t,
  remember: async site => { const prefs = await store.rememberBrowserSite(site); emitGlobal({ type: 'prefs', sessionId: null, prefs, locale }); },
});
agentBrowser?.configureAuthorization(browserSiteApprovals);
chromeRelay?.setConfirm((await store.getPrefs()).confirmAgentSites === true);
agentBrowser?.prefs(await store.getPrefs());
agentBrowser?.loadPolicy(await store.getPrefs());

// ---- コンピューターの操作（docs/computer-use.md、ADR 0070〜0075） ----------------------------
// driver は main（Electron）への口。Electron でない起動では null で、ply_computer は渡さない。
// AGENT_HOST_COMPUTER_DRIVER=fake は偽の driver（実画面には何もしない。テスト用）。AGENT_HOST_COMPUTER_LOG にその呼び出しを 1 行ずつ残す
const computerDriver = process.env.AGENT_HOST_COMPUTER_DRIVER === 'fake'
  ? fakeComputerDriver({ log: process.env.AGENT_HOST_COMPUTER_LOG ? entry => appendFileSync(process.env.AGENT_HOST_COMPUTER_LOG, JSON.stringify(entry) + '\n') : undefined })
  : parentPortComputer(hostedPort);
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
// main が居なくなった（更新）。オーバーレイも Esc も無いまま画面を動かさないので、Esc と同じに使用を止める。ターンは止めず、ツールには更新のための停止と返す
computerDriver?.onAway?.(() => computerLock.stopAll('update'));

// 送信待ちの一覧が変わるたびに呼ぶもの（sessionId -> Set<fn(messages)>）。再開の受け付けを、送った項目が出ていくまで保つのに使う
const outboxWatchers = new Map();
// 会話の中断で取り消す委譲タスクの子の会話 -> 中断の理由。子のターンを実際に止める所（agentTasks の execute の stopChild）が
// 読んで付ける。止まらなかった子には付けない（abortSessions が取り消しの後に片付ける）
const taskStopReasons = new Map();
// 走っている依頼元のターンへ途中送信（control.steer）で渡した完了通知のうち、「渡った」合図（steerConfirms）を待っているもの。
// 通知の item id -> { owner, prompt, items: [{ taskId, revision }] }。渡れば画面へ通知の一行を出し、
// 読まれないままターンが死んだら（userMessage.dropped・ターンの終わり）空いたときの経路で送り直す（ADR 0057）。
// 付け直すターンへは札の steers で渡る（steersOf・restoreSteers。redeliver は関数なので settingNotices から作り直す）
const liveNotices = new Map();
// 走っている子のターンへ途中送信（control.steer）で渡した追加指示（ply_task_send）のうち、「渡った」合図（steerConfirms）を待っているもの。
// 指示の item id（task-send-<指示 ID>） -> { sessionId: 子の会話, taskId, instructionId }。合図で指示の状態を決め、
// 合図が来ないままターンが終わったら待機へ戻して次のターンで送る（ADR 0065）
const liveInstructions = new Map();
// 使用量の上限で止まっている会話 -> interruptedOf の形。解除時刻を過ぎる（時刻が分からないときは自動再開を外す）まで、
// 新しい指示は API に渡さず送信待ちに置く。印は再開（resumeSession）かターンの開始で下ろす
const limitStates = new Map();
const outbox = createMessageQueue({
  store,
  active: id => {
    const limit = limitStates.get(id);
    if (limit && limitHolds(limit))
      return { blocked: true, wait: { reason: 'limit', resetsAt: limit.resetsAt } };
    // 引き継ぎの間（core/handover.mjs）: 新しい作業の開始も途中送信も送信待ちのまま。新しいサーバー（取りやめなら今のサーバー）が続きを送る
    if (handover.hold) return { blocked: true, wait: { reason: 'turn', detail: 'handover' } };
    const turn = runtime.turns.get(id);
    if (!turn) {
      if (switching.has(id) || forking.has(id)) return { blocked: true, wait: { reason: 'turn' } };
      return null;
    }
    const steer = turn.control.steer;
    // 送るのは outbox の item そのもの（本文だけではない）。バックエンドは item.id を
    // 相手に預け、「渡った」合図（userMessage.delivered）でこの id を返してくる
    return { turn, blocked: turn.ac.signal.aborted || Boolean(turn.outcome), phase: turn.info.phase,
      steer: steer ? async item => {
        // 渡った合図を後から出すバックエンドは、受理の応答より先に合図を出すことがある。受理を待つ前から控える（札の steers。付け直した先が合図を処理する）
        const confirms = Boolean(turn.control.steerConfirms);
        if (confirms) { turn.pendingSteers.add(item.id); touchCard(turn); }
        try {
          const accepted = await steer(item);
          if (!accepted && turn.pendingSteers.delete(item.id)) touchCard(turn);
          return accepted;
        } catch (err) {
          if (turn.pendingSteers.delete(item.id)) touchCard(turn);
          throw err;
        }
      } : null };
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
      ...(item.args.scheduledFor ? { scheduledFor: item.args.scheduledFor } : {}),
      ...(turn.control.steerConfirms ? { pending: true } : {}), ...(item.args.sentBy ? { sentBy: publicSender(item.args.sentBy) } : {}) });
    noteRelayHops(sessionId, item.args, { steered: true });
    if (item.args.attachments?.length) {
      (turn.steeredAttachments ??= []).push({ key: item.id, prompt: item.args.prompt });
      touchCard(turn);
      await presentAttachments(sessionId, item.args.attachments, makeEmit({ ...turn, presentKey: item.id }));
    }
  },
});
// 付け直すターン（無停止の更新 2b-4。stage2-server-state.md §5.1）。後片付け（送信待ちの戻し・中断の記録・worktree の整理）と、
// ターンを始めうるもの（予定・上限の再開・bot）より前に runtime.turns に載せる。口を開き直して記録を流すのは待ち受けの後
const adopting = await restoreAdoptedTurns();
// 前のサーバーが保持役に残した `!` の行（無停止の更新 段階 3。core/shell-held.mjs）も引き取る。元を読む条件はターンと同じ
if ((process.env.AGENT_HOST_ADOPT_HOLDER === '1' || HANDOVER_START || handoverEnabled(BOOT_ENV)) && BOOT_ENV.AGENT_HOST_RUNTIME_ROOT) {
  const adoptedShells = shellRuns.adopt(await shellHolder.adoptable().catch(err => { console.error('  `!` の行を引き取れませんでした:', String(err?.message ?? err)); return []; }));
  if (adoptedShells) console.log(`  \`!\` の行 ${adoptedShells} 件を引き取った`);
}
// 前の起動で消し損ねた Claude のフラグ設定のファイル（core/compat-endpoints.mjs）。同じデータ置き場を別の Pleiad（開発版と配布版）が使っていることがあるので、
// 走っている会話のファイルは消さない（1 日より古いものだけ）。付け直すターンの札が指すファイル（無停止の更新 2c）も消さない（そのターンの終わりに消える）
sweepClaudeFlagSettings(store.dataDir, { olderThanMs: 24 * 60 * 60_000, except: adopting.map(a => a.ctx.card.backendCard?.flag).filter(Boolean) }).catch(() => {});
await outbox.recover({ adopted: new Map(adopting.map(a => [a.ctx.sessionId, new Set(Object.keys(a.ctx.card.steers))])), keepQueued: HANDOVER_START });
// 前の起動で走っていたのに終わりが記録されていないターン（落ちた・強制終了）を、会話の中断（reason: restart）として残す
{
  const recovered = await store.recoverInterruptedTurns(Date.now(), { except: new Set(adopting.map(a => a.ctx.sessionId)) })
    .catch(err => { console.error("  中断の記録に失敗:", String(err?.message ?? err)); return []; });
  if (recovered.length) console.log(`  前の起動で終わらなかったターン ${recovered.length} 件を中断として残した`);
}
// 前の起動で待っていた承認・質問はメモリにしか無く、再起動で消えた。通知の一覧のあなた待ちも決着させる（ADR 0149）
// 付け直すターンの出している承認（札の waits。止め始めていたターンは承認を出し直さないので外さない）の行は残す。承認の id が決まった値（core/approval-id.mjs）なので、
// 付け直しで出し直す承認が同じ行になる（決着の行が dedupeKey で居座って新しい行が載らない、を防ぐ）
try { inbox.settleAllWaiting('cancelled', { except: adopting.flatMap(a => a.ctx.card.stopping ? [] : a.ctx.card.waits) }); } catch (e) { console.error('  通知の一覧: あなた待ちを決着させられなかった:', String(e?.message ?? e)); }
// 親が走っている・裏の作業が残っている・送信待ちがあるときは完了通知を送らない（docs/agent-delegation.md「完了通知」）
const noticeBlocked = async owner => sessionBusy(owner) || awaitedBackground(owner) || (await outbox.list(owner)).some(m => !['sent', 'cancelled'].includes(m.status));

/**
 * 完了通知を今すぐ渡せる、依頼元の走っているターン（無ければ null）。docs/agent-delegation.md「完了通知」。
 * 人間の送信待ちを優先する決まりは変えない（outbox に未送があれば渡さない）。
 * 渡してよい条件は completion-notices.mjs の canSteerNotice
 */
async function noticeTarget(owner) {
  const turn = handover.hold ? null : runtime.turns.get(owner);
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
 * 「渡った」合図を後から出すバックエンド（steerConfirms）では、通知の一行を渡った時点で出し、捨てられたら送り直す（liveNotices）。
 * 送り直し先は、タスクの完了通知なら agentTasks.renotify（items）、設定の変更の承認の結果なら台帳へ戻す（settingNotices。付け直す先でも作り直せる形）
 */
async function steerNotice(turn, owner, prompt, tasks, settingNotices = null) {
  await recordTaskNotice(owner, prompt);
  const item = { id: `task-notice-${crypto.randomUUID()}`, args: { prompt } };
  const confirms = Boolean(turn.control.steerConfirms);
  // 合図は受理の応答より先に来ることがある。先に登録しておく
  if (confirms) {
    liveNotices.set(item.id, noticeEntry(owner, prompt, tasks.map(x => ({ taskId: x.taskId, revision: x.revision ?? 0 })), settingNotices));
    touchCard(turn);
  }
  let accepted;
  try { accepted = await trackIn(handover.critical, turn.control.steer?.(item)); }
  catch { if (liveNotices.delete(item.id)) touchCard(turn); return 'error'; }
  if (!accepted) { if (liveNotices.delete(item.id)) touchCard(turn); return 'requeue'; }
  if (!confirms) emitGlobal({ type: 'taskNotice', sessionId: owner, text: prompt });
  return 'ok';
}

/** 渡った合図を待つ完了通知の控え（liveNotices の値）。設定の変更の承認の結果は、台帳へ戻す口を settingNotices から作る */
function noticeEntry(owner, prompt, items, settingNotices = null) {
  return { owner, prompt, items, ...(settingNotices ? { settingNotices, redeliver: () => settingApprovals.requeue(settingNotices) } : {}) };
}

/**
 * 追加指示（ply_task_send）を今すぐ渡せる、子の走っているターン（無ければ null）。委譲の子として実行中のターンだけを対象にし、
 * 渡してよい条件は完了通知と同じ（canSteerNotice。子の会話に人の送信待ちがあれば渡さない）
 */
async function childTarget(sessionId) {
  const turn = taskExecutions.has(sessionId) && !handover.hold ? runtime.turns.get(sessionId) : null;
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
  if (confirms) {
    liveInstructions.set(item.id, { sessionId: task.sessionId, taskId: task.taskId, instructionIds: instruction.ids ?? [instruction.id] });
    touchCard(turn);
  }
  let accepted;
  try { accepted = await trackIn(handover.critical, turn.control.steer?.(item)); }
  catch { if (liveInstructions.delete(item.id)) touchCard(turn); return 'error'; }
  if (!accepted) { if (liveInstructions.delete(item.id)) touchCard(turn); return 'requeue'; }
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

/** 委譲の子のターンの実行の控え（taskExecutions の値）。makeEmit が出来事を集め、finishChild が結果にする。付け直すターンでは札の delegation から reply・stopped を戻す */
function newExecution(card = null) {
  return { outcome: null, error: null, rejections: [], stopped: card?.stopped ?? [], reply: card?.reply ?? null, timer: null, streamed: '', streamEnded: false };
}

/**
 * 委譲の子のターンの実行の前半（agentTasks の execute と、付け直し）: 実行の控えを置き、タスクの取り消しで子のターンを止める口をつなぐ。
 * 戻り値は外す関数（結果を確定したら呼ぶ）
 */
function trackChild(task, signal, execution) {
  taskExecutions.set(task.sessionId, execution);
  const stopChild = () => {
    const child = runtime.turns.get(task.sessionId);
    // 依頼元の会話を止めた理由（abortSessions が置く）。この取り消しが実際に止めるターンにだけ付ける
    const why = taskStopReasons.get(task.sessionId);
    taskStopReasons.delete(task.sessionId);
    if (child && why) child.abortReason ??= why;
    child?.ac.abort();
    // タスクの記録の backend は、依頼元が替えた次のターンの値のことがある（ADR 0134）。止めるのは今の会話のエージェント
    resolveBackendForSession(task.sessionId).then(b => b?.stopSession?.(task.sessionId)).catch(() => {});
  };
  signal.addEventListener('abort', stopChild, { once: true });
  return () => { signal.removeEventListener('abort', stopChild); clearTimeout(execution.timer); if (taskExecutions.get(task.sessionId) === execution) taskExecutions.delete(task.sessionId); };
}

/**
 * 委譲の子の実行の後半（execute と、付け直したターンの adoptChild）: 子のターンが終わった（outcome）のを受けて、孫の完了・裏の作業を待ち、
 * 子の最後の返答と作業場所の状態から、依頼元へ届ける結果（agentTasks の run が書く形）を作る。renewed は、前半で作り直した作業場所
 */
async function finishChild(task, signal, execution, outcome, renewed = null) {
  // A child can itself delegate. Its result is final only after those results
  // have been delivered and it has finished responding to them.
  const childrenBusy = () => agentTasks.list(task.sessionId).some(r => ['queued', 'running', 'cancelling'].includes(r.status) || ['pending', 'delivering'].includes(r.notification));
  // ターンの外に残る端末（Codex）は待たない。終わっても main は再開せず、結果は変わらない（awaitedBackground）
  while (!signal.aborted && (sessionBusy(task.sessionId) || awaitedBackground(task.sessionId) || childrenBusy())) await waitFree(task.sessionId, 250);
  // 履歴の読み出しが一時的な SQLite のエラーで失敗したら、間を空けて読み直す（core/history-retry.mjs）。
  // 読み直しても読めなければ、子の作業は終わっているので失敗にせず、流れてきた最後の返答を注意書き付きで結果にする。
  // それ以外のエラーは今までどおり投げて失敗にする（docs/agent-delegation.md「子の結果」）
  let last, historyNote = null;
  try {
    last = await readWithRetry(() => lastReply(task.sessionId), {
      // i18n-ignore: サーバーのログ
      onRetry: (e, n, ms) => console.error(`  [delegation] 子 ${task.sessionId} の履歴を読めなかったので ${ms}ms 後に読み直す（${n} 回目）:`, String(e?.message ?? e).slice(0, 300)),
    });
  } catch (e) {
    if (!transientStorageError(e)) throw e;
    // i18n-ignore: サーバーのログ
    console.error(`  [delegation] 子 ${task.sessionId} の履歴を読み直しても読めなかった。流れてきた返答を結果にする:`, String(e?.message ?? e).slice(0, 300));
    last = execution.streamed;
    historyNote = agentT(await agentLocaleFor(task.parentSessionId), 'delegation.historyUnreadable', { error: String(e?.message ?? e).slice(0, 300) });
  }
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
  const withNote = error => [error, historyNote].filter(Boolean).join('\n') || null;
  if (agentTasks.list(task.sessionId).some(r => r.notification === 'unknown')) return { outcome: 'error', text, error: withNote(agentT(await agentLocaleFor(task.parentSessionId), 'delegation.noticeUnknown')), rejections, stoppedBackground, git, ...extra };
  return { outcome: signal.aborted ? 'aborted' : execution.outcome ?? outcome, text, error: withNote(execution.error), rejections, stoppedBackground, git, ...extra };
}

/**
 * 付け直したターンが委譲の子のとき、結果の確定を agentTasks に引き継ぐ（adopt。stage2-server-state.md §3 の 2・S8）。turnPromise は adoptTurn の戻り値
 * （通常のターンの runTurn と同じ。子のターンが終わると解決する）。引き継げなかった（タスクが終わっている・取り消し済みなど）ときは、
 * 子の実行の控えだけ外す（結果は書かず、そのターンだけを締める）。引き継げたら true
 */
function adoptChild(ctx, turnPromise, { abandon = false } = {}) {
  const { taskId, execution, sessionId } = ctx;
  const claims = Object.values(ctx.card.steers).flatMap(entry => entry.waiters.includes('agentTasks') && entry.taskId === taskId && Array.isArray(entry.instructionIds) ? entry.instructionIds : []);
  // 付け直しをあきらめた（待ち受けのポートが取れない）ときは、今までの起動の復元と同じに interrupted にする（finish を渡さない）
  const adopted = agentTasks.adoptRun(taskId, abandon ? null : async (task, signal) => {
    const release = trackChild(task, signal, execution);
    try {
      const outcome = await turnPromise;
      if (outcome === 'requeue') return { requeue: true };
      // 作業場所を作り直した（追加指示で再開した子）。旧サーバーが結果を書く前に落ちたときも、子の会話の今の作業場所から台帳を引き直す
      const renewed = await adoptedWorktree(task);
      return await finishChild(task, signal, execution, outcome, renewed);
    } finally { release(); }
  }, { claims });
  if (!adopted) void turnPromise.finally(() => { if (taskExecutions.get(sessionId) === execution) taskExecutions.delete(sessionId); });
  return adopted;
}

/** 付け直した子の作業場所が、前半（renewTaskWorktree）で作り直したものなら公開の形を返す（作り直していなければ null）。台帳の taskId で見分ける */
async function adoptedWorktree(task) {
  const cwd = (await store.get(task.sessionId).catch(() => null))?.cwd;
  const entry = cwd ? await worktreeHost.worktrees.byPath(cwd).catch(() => null) : null;
  return entry && task.worktree && entry.id !== task.worktree.id && entry.taskId === task.taskId ? publicWorktree(entry) : null;
}

/** 画面が聞く「この会話の承認モードは書き込みの範囲か」。読むだけの会話には分ける注記を出さない */
async function sessionWrites(sessionId, backendId, modeId) {
  const backend = sessionId ? await resolveBackendForSession(sessionId).catch(() => null) : getBackend(backendId);
  const useBackend = (backendId && getBackend(backendId)) || backend;
  if (!useBackend) return false;
  const mode = await resolveMode(sessionId, modeId, useBackend).catch(() => null);
  return Boolean(mode) && writesScope(useBackend.modes()?.[mode]);
}
/** 会話を消した（下書きの削除）。その会話のために作った worktree を、使っていなければ片付ける */
async function settleWorktreesOf(sessionId) {
  for (const e of await worktreeHost.worktrees.list()) {
    if (e.purpose === 'conversation' && e.sessionId === sessionId && e.state === 'ready') await worktreeHost.worktrees.settle(e.id).catch(() => {});
  }
}
// この PC の AI からリモートのホストへ任せる（docs/agent-delegation.md「リモートのホストへ任せる」）。main との口は parentPort（デスクトップ版だけ）。
// ホストの子の承認は、依頼元の会話の中継のカードとして出す（手元の委譲の中継と同じ runtime.waiting。ただし答えはホストへ運ぶ）
const remoteCards = {
  open(c) {
    const id = crypto.randomUUID();
    const child = c.childTitle || t('permission.childConversation');
    const remote = { hostId: c.hostId, hostName: c.hostName, relayId: c.relayId, taskId: c.taskId, online: c.online !== false, ...(c.hostOnly ? { hostOnly: true } : {}),
      ...(c.childSessionId ? { childSessionId: c.childSessionId } : {}) };
    const payload = { type: 'permission', kind: c.kind === 'question' ? 'question' : 'tool', toolName: c.toolName, input: c.input, sessionId: c.sessionId, toolUseID: undefined,
      title: c.title ? t('permission.relayTitleWith', { child, title: c.title }) : t('permission.relayTitle', { child }), conversationTitle: '',
      canAlways: false, remote, ...(c.kind === 'question' ? { questions: c.questions } : {}) };
    // settle は使わない（決着はホストの便りか、画面の人の答え。remoteDelegation が closeRelay で消す）
    runtime.waiting.set(id, { settle: () => {}, payload, askedAt: c.askedAt ?? new Date().toISOString(), relay: true, notified: false, detached: false, remote });
    sendTo({ kind: P.EVENT, event: { ...payload, id } });
    permissionsChanged();
    return id;
  },
  close(id, resolution) {
    const w = runtime.waiting.get(id);
    if (!w) return;
    runtime.waiting.delete(id);
    emitGlobal({ type: 'permissionRelayEnd', id, sessionId: w.payload.sessionId, by: resolution?.by ?? null, allow: resolution?.allow ?? null, peer: resolution?.hostName ?? w.remote.hostName, hostName: resolution?.hostName ?? w.remote.hostName, at: new Date().toISOString() });
    permissionsChanged();
  },
  online(hostId, flag) {
    for (const [id, w] of runtime.waiting) {
      if (w.remote?.hostId !== hostId || (w.remote.online !== false) === flag) continue;
      w.remote.online = flag;
      emitGlobal({ type: 'permissionRelayState', id, sessionId: w.payload.sessionId, online: flag, hostName: w.remote.hostName, peer: w.remote.hostName });
    }
    if (runtime.waiting.size) broadcastRunning();
  },
};
const remoteAgentBridge = parentPortRemoteAgent(hostedPort);
const remoteDelegation = createRemoteDelegation({
  bridge: remoteAgentBridge, tasks: () => agentTasks, agentT, titleOf: async id => (await store.get(id)).title ?? '', cards: remoteCards,
  locale: () => currentLocale(), changed: () => permissionsChanged(), log: line => console.log(`  ${line}`),
});
agentTasks = await createAgentTasks({
  dataDir: store.dataDir,
  // 付け直す委譲の子のタスクは、起動の復元で interrupted にしない（結果の確定は adoptChild が引き継ぐ。stage2-server-state.md S8）
  adopting: adopting.flatMap(a => a.ctx.taskId ? [a.ctx.taskId] : []),
  changed: () => { broadcastRunning(); completionNotices.changed(); remoteTasksChanged(); },
  // 人間の承認を待っているか。承認は core/server.mjs 側にしかないので判定を渡す。
  // 中継の複製も数える（孫が止まっていれば、その子も止まっている）
  waiting: sessionId => Boolean(sessionId) && blockingWaits().some(w => w.payload.sessionId === sessionId),
  // ホストに任せたタスクの写し: 依頼元の会話に中継された承認を待っているか・会話の中断でホストのタスクも止める（core/remote-delegation.mjs）
  remoteWaiting: row => remoteDelegation.waitingFor(row.taskId),
  cancelHost: row => remoteDelegation.cancelHost(row),
  // コンピューターの操作のロックを待っている子は、黙っているとは数えない（承認待ちではないので ply_task_wait の waiting にはしない）
  lockWaiting: sessionId => computerLock.snapshot().some(s => s.sessionId === sessionId && s.state === 'waiting'),
  rollback: async ({ sessionId, worktree }) => {
    await deleteUnsentConversation(sessionId); await store.removeSession(sessionId); releaseAgentConnection(sessionId);
    if (worktree) await worktreeHost.abandon(worktree.id).catch(() => {});
  },
  // 子の worktree の今の状態（ply_task_status・ply_task_wait の workspaceSummary）
  workspaceState: task => worktreeHost.taskState(task.worktree),
  prepare: async (owner, args, taskId, signal) => {
    const parent = runtime.turns.get(owner);
    // 端末の AI から任された委譲（remoteAgentInvoke が付ける。docs/remote.md §4.5）。依頼元の会話はホストに無く、言語と承認モードは端末が送ってきたもの
    const remoteReq = args.remote ?? null;
    // エラーは ply_delegate の結果として依頼元のエージェントが読む。子の会話は依頼元の会話の言語を継ぐ
    const lng = parent?.agentLocale ?? remoteReq?.locale ?? await agentLocaleFor(owner);
    // 人が委譲カードの「別の候補でやり直す」で作るタスク（retryAgentTask）は、依頼元のターンの外で作る。
    // 作業場所は元のタスクの絶対パスを渡すので、依頼元のターンが無くても決まる
    const manual = args.routing?.mode === 'manual';
    if ((!parent && !manual && !remoteReq) || signal?.aborted) throw new Error(agentT(lng, 'delegation.parentEnded'));
    const backend = getBackend(args.backend);
    if (!backend) throw new Error(agentT(lng, 'delegation.backendDisabled'));
    let cwd = path.resolve(parent?.info.cwd ?? (remoteReq ? os.homedir() : (await store.get(owner)).cwd) ?? process.cwd(), args.cwd ?? '.');
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
    // worktree（ADR 0089）。子の作業場所をここで作る。作れなければ（git でない・コミットが無い・失敗）今の場所のまま走らせる
    let worktree = null;
    if (args.isolate === true) {
      const made = await worktreeHost.createForTask({ cwd, owner, taskId });
      if (made.ok) { worktree = publicWorktree(made.entry); cwd = made.cwd; }
      else console.error('  worktree を作れなかったので、元の場所で走らせる:', made.reason, made.error ?? '');
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
      // 端末の AI から任された子は、出どころ（どの端末の・どの会話の AI か。画面の「⇄ <端末> の AI から」）と、依頼元の承認モードを残す
      await store.setSessionData(sessionId, 'delegation', { taskId, parentSessionId: owner, manager: 'ply',
        ...(remoteReq ? { remote: { deviceId: remoteReq.deviceId, deviceName: remoteReq.deviceName, sessionId: remoteReq.sessionId, title: remoteReq.title, mode: remoteReq.mode } } : {}) }, { durable: true });
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
    return { backend: backend.id, model, effort, cwd, mode, sessionId, ...(worktree ? { worktree } : {}), ...(routing ? { routing } : {}),
      ...(remoteReq ? { requester: { deviceId: remoteReq.deviceId, deviceName: remoteReq.deviceName, sessionId: remoteReq.sessionId, title: remoteReq.title } } : {}) };
  },
  execute: async (task, prompt, signal) => {
    if (signal.aborted) { await worktreeHost.taskDone(task).catch(() => {}); return { outcome: 'aborted' }; }
    if (sessionBusy(task.sessionId)) return { requeue: true };
    // 子の会話を人が消した（sessions.delete。ADR 0147）。追加の指示・やり直しは、消した会話を作り直さずに失敗で返す
    if (!(await resolveBackendForSession(task.sessionId))) throw new Error(agentT(await agentLocaleFor(task.parentSessionId), 'delegation.childDeleted'));
    const execution = newExecution();
    const release = trackChild(task, signal, execution);
    try {
      // 追加の指示（ply_task_send）で再開した子の作業場所が、前の完了で片付いていたら作り直す（元の場所に書かせない）
      const renewed = await renewTaskWorktree(task).catch(() => null);
      const outcome = await runTurn({ sessionId: task.sessionId, prompt }, () => {}, { signal, taskId: task.taskId });
      // 子のターンを新しいサーバーへ渡した（handOffTurn）。結果は付け直した先の finishChild が確定する（このサーバーでは何も書かない）
      if (outcome === 'handedOff') return { handedOff: true };
      if (outcome === 'requeue') return { requeue: true };
      return await finishChild(task, signal, execution, outcome, renewed);
    } finally { release(); }
  },
  // 依頼元が完了通知を受け取れるか。受け取れない間、委譲の管理は通知の状態を書き換えない（保存を減らす）
  ready: async task => isRemoteOwner(task.parentSessionId) ? remoteAgentPort.online(parseRemoteOwner(task.parentSessionId)?.deviceId) : !(await noticeBlocked(task.parentSessionId)),
  // 走っている依頼元のターンへ、今すぐ途中送信で渡せるか（無音・コマンドの通知は使わない。ADR 0057）
  steerable: async task => !isRemoteOwner(task.parentSessionId) && Boolean(await noticeTarget(task.parentSessionId)),
  // 走っている子のターンへ、追加指示を今すぐ途中送信で渡せるか（ADR 0065）
  childSteerable: async task => Boolean(await childTarget(task.sessionId)),
  steer: steerInstruction,
  // 同じ依頼元への完了通知をまとめて 1 つ届ける。走っているターンへ渡せれば途中送信で（noticeTarget）、
  // 渡せなければ（requeue）空いてから新しいターンで
  deliver: async tasks => {
    const owner = tasks[0].parentSessionId;
    // 端末の AI に任された作業の完了は、依頼元（端末）へ便りで届ける。ホストの会話に新しいターンは始めない
    if (isRemoteOwner(owner)) return remoteDeliver(tasks);
    // 取り消し・すべて止めるで止めた子の会話へは、孫の完了通知も新しいターンを始めずに捨てる（止めた依頼の続きをホストで動かさない）
    if ((await delegationRoot(owner)).remote?.stoppedAt) return 'ok';
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
    if (isRemoteOwner(owner)) return 'ok';   // 初版は、ホストの子の長いコマンド・無音を端末へ知らせない（docs/remote.md §4.5）
    if (await noticeBlocked(owner)) return 'requeue';
    const lng = await ensureAgentLocale(owner);
    const prompt = agentT(lng, 'delegation.commandNotice', { taskId: task.taskId, noticeId: command.noticeId,
      title: task.title, command: redactForPeer(command.command, 200), minutes: command.elapsedMinutes });
    return runTurn({ sessionId: owner, prompt }, () => {}, { internal: true });
  },
  deliverSilence: async (task, minutes) => {
    const owner = task.parentSessionId;
    if (isRemoteOwner(owner)) return 'ok';
    if (await noticeBlocked(owner)) return 'requeue';
    const lng = await ensureAgentLocale(owner);
    const prompt = agentT(lng, 'delegation.silenceNotice', { taskId: task.taskId, title: task.title, minutes });
    return runTurn({ sessionId: owner, prompt }, () => {}, { internal: true });
  },
});
// 前の起動で走っていて、再起動で止まった委譲タスクを、依頼元の会話の「止めたもの」に残す（次のターンで伝える）。
// 裏の作業と承認待ちは保存していないので分からない（docs/design.md「中断と再開」）
await recordTaskStops(agentTasks.restored, 'restart', { restart: true });
// ホストに任せたタスクの写し: 動いていたものはホストで続いている。ホストの便りを聞き、つながり次第追いつく（remote-delegation.mjs）
remoteDelegation.start();
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
      const r = await steerNotice(live, sessionId, prompt, [], notices.map(({ requestId, sessionId, key, op, outcome, error, at }) => ({ requestId, sessionId, key, op, outcome, error, at })));
      return r === 'requeue' ? 'requeue' : r === 'ok' ? 'ok' : 'error';
    }
    return (await runTurn({ sessionId, prompt }, () => {}, { internal: true })) === 'requeue' ? 'requeue' : 'ok';
  },
});
if (settingApprovals.restored) console.log(`  前の起動で承認を待っていた設定の変更 ${settingApprovals.restored} 件を取り下げた（結果を会話へ届ける）`);
// worktree: 台帳と git worktree list を突き合わせ（作成の途中で落ちたものは巻き戻す）、使っていない片付けられるものを消す（ADR 0089）
await worktreeHost.worktrees.reconcile()
  .then(r => { const n = Object.values(r).reduce((a, l) => a + l.length, 0); if (n) console.log(`  worktree を ${n} 件整理した`); })
  .catch(e => console.error('  worktree の整理に失敗:', String(e?.message ?? e)));
worktreeSweepSoon();

// bot・Channels・ルーティン。会話を作る・走らせる・止める・途中送信するための道具を渡す（中身は core/bots-host.mjs のモジュールが持つ）
botHost = createBotHost({
  store, dataDir: store.dataDir, usageStore, sessionSearch, runtime, outbox,
  createConversation, runTurn, noticeTarget, noticeBlocked, abortSessions, emitGlobal,
  getBackend, listBackends, resolveModel, resolveEffort, agentLocaleFor, agentT, currentLocale, lastReply,
  sessionBusy: id => sessionBusy(id),
  // スレッドの bot の会話の設定を、このスレッドだけ変える（channels.threadSettings。ADR 0157）。走っていれば次のターンから（nextSettings）
  reserveTurnSettings: (args) => reserveTurnSettings(args),
  // スレッドを分ける（channels.branchThread）: bot の会話の発言（分けた行）を読み、切り口で会話を分ける
  readMessages: async (id) => { const backend = await resolveBackendForSession(id); return backend?.getMessages ? backend.getMessages(id) : []; },
  forkSession: ({ sessionId, beforeMessageId }) => forkConversation({ sessionId, ...(beforeMessageId ? { beforeMessageId } : {}), reason: 'branch' }, { by: 'human' }),
  // スレッドの送り直し（channels.resend）: 巻き戻せるかを先に全部確かめ、確かめた後で巻き戻す（ADR 0102 の順）
  rewindPlan: async ({ sessionId, beforeMessageId }) => (await pickBackend(sessionId)).rewindPlan(sessionId, { beforeMessageId }),
  rewindSession: (args) => rewindConversation(args),
  // 隠れた会話（夜の整理・心拍）をネイティブの会話ごと消す。消せないバックエンド・走っている会話は残して false（ADR 0127）
  deleteHidden: async id => {
    if (sessionBusy(id) || !HIDDEN_BOT_KINDS.has((await store.get(id)).bot?.kind)) return false;
    if (!await deleteHiddenConversation(id, getBackend)) return false;
    await store.removeSession(id);
    return true;
  },
  // チャンネルの予算（ADR 0119）が読む使用枠。設定の「使用量」・ply_usage と同じ quotaCache を通す
  readQuota: id => { const b = getBackend(id); return b ? providerQuota(b) : null; },
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

// バックエンドがプロンプトを受け取った後にしか出せないイベント。初回の発言の「渡った」合図の代わりに使う
const ANSWER_EVENTS = new Set(['text.delta', 'text.end', 'thinking.delta', 'tool.start']);

async function runTurnInternal(args, onStarted, hooks) {
  const { sessionId = null } = args ?? {};
  if (hooks.canStart && !hooks.canStart()) return 'cancelled';
  if ((hooks.internal || hooks.signal) && (sessionBusy(sessionId))) return 'requeue';
  if (switching.has(sessionId) || forking.has(sessionId)) throw new Error(t('agents.switching'));
  // 同じセッションの二重実行は防ぐ。別のセッションなら並行して回してよい
  if (sessionId && runtime.turns.has(sessionId)) throw new Error(t('session.running'));
  if (sessionId && hooks.compact !== 'idle') compactionScheduler.cancel(sessionId);
  const compactionRevision = sessionId ? compactionScheduler.revision(sessionId) : null;
  if (sessionId) switching.add(sessionId);
  try {
    const ctx = await prepareTurn(args, hooks, compactionRevision);
    return await driveTurn(ctx, async () => {
      await onStarted();
      ctx.didStart = true;
      await beginTurn(ctx);
      // Preparation can await context and settings. A send or cancellation may have invalidated
      // an idle reservation since the first check; do not invoke the backend in that case.
      if (hooks.canInvoke && !hooks.canInvoke()) return { requeue: true, beforeInvoke: true };
      return await launchTurn(ctx);
    });
  } finally {
    await releaseTurn(sessionId);
  }
}

async function prepareTurn(args, hooks, compactionRevision) {
  const { prompt, sessionId = null } = args ?? {};

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
  await backend.prepareTurn?.(sessionId);
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
  // worktree（ADR 0089）。使う場所が worktree の中なら控える（片付けの印・取り込みを頼む相手）。片付けている最中の場所では始めない。
  const worktreeEntry = await worktreeHost.worktrees.byPath(cwd);
  if (worktreeEntry && worktreeEntry.state !== 'ready') throw new Error(t('worktree.cleaning'));
  if (sessionId) {
    if (!hooks.compact) await store.setSessionData(sessionId, 'compacted', false);
    await store.setModel(sessionId, model);
    await store.setSessionData(sessionId, "effort", effort);
    if (reserved?.account !== undefined) await store.setSessionData(sessionId, 'claudeAccount', reserved.account);
    if (reserved?.endpoint !== undefined) await store.setSessionData(sessionId, 'compatEndpoint', reserved.endpoint);
    await store.setMode(sessionId, permissionMode);
    await store.setMeta(sessionId, { cwd, unsent: false, lastModified: Date.now() });
    if (reserved) {
      await store.setSessionData(sessionId, "nextSettings", null, { durable: true });
      emitGlobal({ type: "backend", sessionId, backend: backend.id, applied: true });
      emitGlobal({ type: "nextSettings", sessionId, nextSettings: null });
    }
    // 委譲の子なら、タスクの記録を実際に走る値に合わせる（依頼元が替えた予約を人が取り消した・替えたとき。ADR 0134）
    const synced = await agentTasks?.sync(sessionId, { backend: backend.id, model, effort, mode: permissionMode }).catch(() => null);
    if (synced) emitGlobal({ type: 'agentTaskChanged', sessionId: null, taskId: synced });
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
    control: { handle: null, touch: () => touchCard(turn), track: promise => trackIn(handover.inflight, promise), onReady: () => {
      outbox.kick(sessionId).catch(() => {});
      agentTasks?.sendQueued(sessionId).catch(() => {});
    } },
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
    // 受理した途中送信（送信待ちの項目）のうち、渡った合図（userMessage.delivered / dropped）をまだ待っているものの id（steerConfirms のバックエンドだけ）。札の steers
    pendingSteers: new Set(),
    ended: false,
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
  turn.ac.signal.addEventListener('abort', () => { turn.stops ??= captureStops(turn); touchCard(turn); }, { once: true });
  if (hooks.signal?.aborted) turn.ac.abort();
  const abortFromTask = () => turn.ac.abort();
  hooks.signal?.addEventListener('abort', abortFromTask, { once: true });
  runtime.turns.set(turn.key, turn);
  // 送信待ちから始まったターン（人の発言・別の会話からの発言）で、送信の連鎖の数を決め直す（sessions.send の歯止め）
  if (args.messageId) noteRelayHops(sessionId, args);
  for (const read of liveReads) if (read.sessionId === sessionId) read.turn = turn;
  // worktree を使うターン。会話の id が決まったら台帳に控える
  turn.worktreeId = worktreeEntry?.id ?? null;
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

  // 入力欄の `!` の結果（ADR 0054）。人の発言のターンでだけ、発言と一緒に渡す（完了通知で再開するターン・圧縮では渡さない）。
  // 'host' の会話は未送の追記を shouldQuery: false の行で先に渡す。'native'（Codex）はエージェントの会話に既に入っている。
  // 「渡さない」の行は渡さず、渡った後に会話に残す行へ移す（ADR 0055）
  const shellHandoff = sessionId && !hooks.internal && !hooks.compact && shellMode(backend)
    ? (shellMode(backend) === 'host' ? await shellRuns.appendsFor(sessionId) : { ids: [], skipped: [], lines: [] }) : null;

  const ctx = {
    args,
    hooks,
    sessionId,
    prompt,
    backend,
    cwd,
    account,
    accountId,
    endpoint,
    endpointId,
    agentLocale,
    permissionMode,
    model,
    effort,
    attachments,
    baselineLength: baseline.messages.length,
    policy,
    plyContext,
    resolvedContext,
    hasContext: Boolean(resolvedContext),
    contextRecord,
    hooksTurn,
    turn,
    emit,
    abortFromTask,
    didStart: false,
    backendInvoked: false,
    runtimeContext: null,
    initialDelivered: false,
    // 中断で止めたもの（stops）を伝える文。このターンの発言の前に 1 回だけ添え、渡ったら会話から消す（docs/design.md「中断と再開」）
    interruption: null,
    interruptionTaken: false,
    shellHandoff,
    shellHanded: false,
    runArgs: null,
  };
  bindTurnContext(ctx);
  turnContexts.set(turn, ctx);
  return ctx;
}

/** 渡った合図（onPromptDelivered）と文脈の保存（saveContext）を ctx に付ける。準備（prepareTurn）と付け直し（restoreTurn）が使う */
function bindTurnContext(ctx) {
  const { args, turn, emit } = ctx;
  ctx.onPromptDelivered = () => {
    touchCard(turn);   // 札の渡った合図の印（delivery）が変わりうる
    if (ctx.interruption && !ctx.interruptionTaken) {
      ctx.interruptionTaken = true;
      store.takeStops(ctx.sessionId, ctx.interruption.keys, { dropped: ctx.interruption.dropped }).catch(e => console.error('  中断で止めたものを伝えた記録に失敗:', String(e?.message ?? e)));
    }
    if (ctx.shellHandoff && !ctx.shellHanded) {
      ctx.shellHanded = true;
      shellRuns.delivered(ctx.sessionId, ctx.shellHandoff.ids, ctx.shellHandoff.skipped).catch(e => console.error('  shell: 渡した記録に失敗:', String(e?.message ?? e)));
    }
    if (ctx.initialDelivered || !args.messageId) return;
    ctx.initialDelivered = true;
    emit({ type: 'userMessage.delivered', messageId: args.messageId });
  };

  ctx.saveContext = async () => {
    // 付け直したターンは、会話に保存済みのコンテキストの記録が無いことがある（記録の無い会話）。そのときは書かない
    if (!ctx.contextRecord) return;
    await turn.setup;
    if (turn.info.sessionId) await store.setSessionData(turn.info.sessionId, 'contextSession', ctx.contextRecord);
    emit({ type: 'contextUsage', report: structuredClone(ctx.contextRecord.report), plyParts: ctx.contextRecord.plyParts ?? null });
  };
}

async function beginTurn(ctx) {
  const { args, hooks, sessionId, prompt, backend, cwd, account, endpoint, agentLocale,
    permissionMode, model, effort, attachments, contextRecord, hooksTurn, turn, emit,
    resolvedContext, shellHandoff } = ctx;

  // 次のターンが始まったので中断の印を消し、走っている印を付ける（新しい会話は id が決まったとき。makeEmit の session）
  if (sessionId) limitStates.delete(sessionId);
  if (sessionId) await store.setMeta(sessionId, { turnStartedAt: turn.startedAtMs, interrupted: null }).catch(err => {
    console.error("  ターンの開始の記録に失敗:", String(err?.message ?? err));
  });
  // 中断で止めたものがあれば、エージェントの言語で文にして発言の前に添える（圧縮のターンでは添えない）。
  // 画面には、何を伝えたかを開ける 1 行で出す（履歴は system-messages.mjs の splitInterruptionNotes が同じ行にする）。
  // 発言の吹き出しの後に送り、画面は messageId の吹き出しの前へ置く（履歴と同じ並び）
  if (sessionId && !hooks.compact) {
    const stops = (await store.get(sessionId).catch(() => null))?.stops;
    ctx.interruption = interruptionNote(agentLocale, stops, stops?.reason);
  }
  if (args.messageId) emit({ type: "userMessage", messageId: args.messageId, text: String(prompt ?? ""), at: args.at, initial: true, pending: true,
    ...(args.scheduledFor ? { scheduledFor: args.scheduledFor } : {}),
    ...(args.sentBy ? { sentBy: publicSender(args.sentBy) } : {}) });
  if (ctx.interruption) emit({ type: 'interruptionNote', text: ctx.interruption.body, ...(args.messageId ? { messageId: args.messageId } : {}) });
  broadcastRunning();
  syncRunningPoll();
  if (resolvedContext?.servers.length) emit({ type: 'activity', state: 'preparing' });
  if (hooks.internal) {
    await recordTaskNotice(sessionId, prompt);
    // bot の会話へ渡すチャンネルの出来事・記憶の包みは、履歴と同じ行の形で出す（splitLeadingNotes）。それ以外は、本文も載せる。
    // 画面の「タスクの結果で再開」の 1 行を開くと読める（ADR 0053）
    const rows = channelEventRows(prompt);
    if (rows.length) emit({ type: 'channelEvent', rows });
    else emit({ type: 'taskNotice', text: String(prompt ?? '') });
  }
  await ctx.saveContext();
  // agy のように会話のあいだ 1 本のプロセスを生かすバックエンドには、会話ごとの同じトークンで開く（起動時にしか渡せない）
  if (resolvedContext) ctx.runtimeContext = await contextBridge.open({ runtime: resolvedContext, prompt,
    ...(backend.capabilities?.plyContext === 'conversation' ? { token: conversationConnection(turn).contextToken } : {}),
    origin: localOrigin(), signal: turn.ac.signal,
    isActive: () => runtime.turns.get(turn.key) === turn && !turn.ac.signal.aborted, changed: ctx.saveContext,
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
  // bot の会話なら、人格（botInstructions）と、ターンの末尾（記憶の核の写し・差分。notes）を足す。bot でなければ空
  const botExtras = await botHost?.turnExtras(turn) ?? { botInstructions: null, notes: [] };
  const notes = [...(ctx.interruption ? [ctx.interruption.text] : []), ...botExtras.notes];
  const runArgs = {
    prompt,
    ...(shellHandoff?.lines.length ? { shellAppends: shellHandoff.lines } : {}),
    ...(notes.length ? { notes } : {}),
    ...(botExtras.botInstructions ? { botInstructions: botExtras.botInstructions } : {}),
    ...(botExtras.folders ? { botFolders: botExtras.folders } : {}),
    ...(hooks.compact ? { compact: hooks.compact } : {}),
    sessionId,
    cwd,
    mode: permissionMode,
    model: model || undefined,
    effort,
    // 渡った合図（onPromptDelivered）を呼ばないバックエンド（antigravity）もある。返答の中身が届いたら渡ったとみなす
    emit: (event, opts) => { if (ANSWER_EVENTS.has(event?.type)) ctx.onPromptDelivered(); return emit(event, opts); },
    onPromptDelivered: ctx.onPromptDelivered,
    // 拒否・中断の理由をこの会話の言語で返すため、会話の言語を添えて聞く
    askPermission: request => askPermission({ ...request, locale: agentLocale }),
    hostInvoke: hostInvokeFor(agentLocale),
    signal: turn.ac,
    control: turn.control,
    // エージェントに渡す文（指示・ツールの説明・タイトル生成など）の言語。会話ごとに決めて保存したもの
    locale: agentLocale,
    visualizeInstructions: visualizeInstructions(agentLocale),
    browserEnv: await browserEnvironment({ bridge: agentBrowserEndpoints, dataDir: store.dataDir, sessionId: sessionId || turn.key, unlock: turn.userInitiated }).catch(error => { console.error('agent browser unavailable:', error.message); return null; }),
    browserInstructions: null,
    // ply_browser。内蔵ブラウザーを渡すターンだけ（下で入れる）
    browserRuntime: null,
    // ply_computer（url・headers・instructions）。使えない・オフ・対応しないエージェントなら null（computerRuntimeFor）
    computerRuntime: await computerRuntimeFor(turn),
    // ply_control（操作の一覧）。全会話に渡す。env は会話のシェルへ渡す CLI の接続情報
    controlRuntime: controlRuntimeFor(turn),
    addedInstructions: !backend.capabilities?.plyAgents ? withAdded(null, contextRecord.added) : null,
    contextRuntime: ctx.runtimeContext,
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
  const parts = plyParts({ plyAgents: Boolean(backend.capabilities?.plyAgents), context: ctx.runtimeContext?.sections ?? null,
    visualize: runArgs.visualizeInstructions, browser: runArgs.browserInstructions, agents: agentConnection(turn).instructions, added: contextRecord.added,
    computer: computerPrompt(runArgs.computerRuntime, { locale: agentLocale, agent: backend.id }), control: runArgs.controlRuntime.instructions });
  if (JSON.stringify(parts) !== JSON.stringify(contextRecord.plyParts ?? null)) { contextRecord.plyParts = parts; await ctx.saveContext(); }
  ctx.runArgs = runArgs;
}

/** バックエンドの host の口（in-process の MCP）から操作の一覧を呼ぶ。ターンを始めるとき（beginTurn）と付け直すとき（adoptTurn） */
function hostInvokeFor(agentLocale) {
  return (op, args) => trackIn(handover.inflight, (async () => {
    const result = await opsRegistry.invoke({ by: 'agent', via: 'mcp', sessionId: args.sessionId }, op, args, opsDeps(agentLocale));
    if (!result.ok) throw new Error(result.error);
    return result.result;
  })());
}

async function launchTurn(ctx) {
  const { turn, backend, hooks, cwd, permissionMode, runArgs } = ctx;
  // git の作業場所なら、ターンの始まりの状態を隠し ref に撮る（書き込みの範囲のターンだけ。圧縮では撮らない。ADR 0085）。
  // 撮影が遅いときは待たずに始める（その回は撮影なし）
  if (GIT_SNAPSHOTS && !hooks.compact && scopeRank(modePosition(backend.modes()?.[permissionMode]).scope) > scopeRank('readonly')) {
    turn.gitSetup = gitActivity.begin({ cwd }).then(g => {
      if (turn.gitLate) return null;
      turn.git = g;
      touchCard(turn);
      return g && turn.info.sessionId ? gitActivity.attach(g, turn.info.sessionId) : null;
    }).catch(() => {});
    let began = false;
    await Promise.race([turn.gitSetup.then(() => { began = true; }), new Promise(resolve => setTimeout(resolve, GIT_BEGIN_WAIT_MS).unref?.())]);
    // 間に合わなかった。エージェントが動き出した後の撮影は基準にならないので、このターンは撮らない
    if (!began) { turn.gitLate = true; touchCard(turn); }
  }
  ctx.backendInvoked = true;
  return hooks.compact && backend.compact
    ? await backend.compact({ ...runArgs, trigger: hooks.compact })
    : await backend.runTurn(runArgs);
}

async function afterResult(ctx, result) {
  const { turn, emit, hooks, sessionId, attachments, prompt } = ctx;
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
      const messages = splitLeadingNotes(await ctx.backend.getMessages(turn.info.sessionId));
      let cursor = ctx.baselineLength;
      // 付け直したターン（restoreTurn）の札は本文の代わりにハッシュを持つ（core/turn-card.mjs）
      const same = (m, a) => (a.promptHash ? promptHash(m.text) === a.promptHash : m.text === a.prompt);
      for (const attachment of [{ key: turn.presentKey, ...(ctx.card ? { promptHash: ctx.card.promptHash } : { prompt }) }, ...(turn.steeredAttachments ?? [])]) {
        const index = messages.findIndex((m, i) => i >= cursor && m.role === 'user' && same(m, attachment));
        if (index < 0) continue;
        cursor = index + 1;
        await history.anchorAttachments(turn.info.sessionId, attachment.key, messages[index].uuid);
      }
    }
    await store.setMeta(turn.info.sessionId, { lastModified: Date.now() }).catch(() => {});
  }
}

async function driveTurn(ctx, start) {
  const { turn, emit, hooks, sessionId, args } = ctx;
  // バックエンドを呼ぶ前に戻した（canInvoke）。後始末の失敗で turn.outcome が変わっても 'requeue' を返す
  let beforeInvoke = false;
  try {
    const result = await start();
    if (turn.handedOff) return 'handedOff';
    if (result?.beforeInvoke) {
      beforeInvoke = true;
      turn.outcome = 'requeue';
    } else {
      await afterResult(ctx, result);
    }
  } catch (err) {
    if (turn.handedOff) return 'handedOff';
    if (hooks.compact && turn.compaction?.phase !== 'complete') emit({ type: 'compaction', phase: 'failed', trigger: hooks.compact,
      reason: String(err?.message ?? err) });
    if (ctx.resolvedContext) { ctx.contextRecord.report.status = 'failed'; await ctx.saveContext().catch(() => {}); }
    if (!turn.errorShown) {
      if (turn.backend.id === 'antigravity') turn.failureReason = { source: 'server.catch', error: String(err?.message ?? err).slice(0, 1000) };
      emit({ type: "turnResult", outcome: "error", error: String(err?.message ?? err) });
    }
    // プロンプトを渡す前に失敗した（backends/undelivered.mjs）。送信済みにしたままだと、本文がどこにも残らず消える。
    // 送信待ちの「失敗」に戻し、利用者に再送か取り消しを選ばせる
    if ((err?.undelivered || !ctx.backendInvoked) && sessionId && args.messageId) {
      await outbox.undelivered(sessionId, args.messageId, String(err?.message ?? err)).catch(() => {});
    }
    if (!ctx.didStart) throw err;
  } finally {
    // 付け直しに渡したターン（handOffTurn）は、このサーバーでは締めない（新しいサーバーの adoptTurn が締める。X1・X2）
    if (!turn.handedOff) await closeTurn(ctx);
    hooks.signal?.removeEventListener("abort", ctx.abortFromTask);
  }
  return beforeInvoke ? 'requeue' : turn.outcome;
}

/** ターンの締め（driveTurn の後始末）。送信待ち・表示・コンテキスト・git の終わりを書き、endTurn で終える */
async function closeTurn(ctx) {
  const { turn, emit, sessionId } = ctx;
  // 渡らずに終わった `!` の行は、また「渡さない」を切り替えられる
  if (ctx.shellHandoff && !ctx.shellHanded) shellRuns.release(sessionId, ctx.shellHandoff);
  if (ctx.didStart && turn.outcome !== 'ok' && turn.outcome !== 'requeue') await outbox.pause(sessionId).catch(() => {});
  await turn.visualizations.close().catch(err => {
    if (turn.backend.id === 'antigravity') turn.failureReason = { source: 'visualizations.close', error: String(err?.message ?? err).slice(0, 1000) };
    emit({ type: 'turnResult', outcome: 'error', error: t('turn.visualizationSaveFailed', { error: err.message }) });
  });
  await Promise.allSettled([ctx.runtimeContext?.close()]);
  await ctx.saveContext().catch(() => {
    if (turn.backend.id === 'antigravity') turn.failureReason = { source: 'saveContext', error: t('turn.contextSaveFailed') };
    emit({ type: 'turnResult', outcome: 'error', error: t('turn.contextSaveFailed') });
  });
  // git の動き（ADR 0085）: ターンの終わりの撮影と、返答の下の 1 行の元。ファイル・コミット・ブランチ・PR のどれかが動いたときだけ会話に残す
  if (turn.gitSetup && ctx.didStart && turn.outcome !== 'requeue') {
    const summary = await Promise.race([
      turn.gitSetup.then(() => (turn.git ? gitActivity.finish(turn.git, turn.info.sessionId, turn.gitCalls.events()) : null)),
      new Promise(resolve => setTimeout(resolve, GIT_END_WAIT_MS, null).unref?.()),
    ]).catch(() => null);
    if (summary && turn.info.sessionId) emit({ type: 'present', kind: 'git', git: summary, by: 'ai', at: new Date().toISOString(), sessionId: turn.info.sessionId });
  }
  await endTurn(turn, emit, { record: ctx.didStart });
}

async function releaseTurn(sessionId, { adopted = false } = {}) {
  if (!adopted && sessionId) switching.delete(sessionId);
  completionNotices.changed(sessionId);
  notifyFree(sessionId);
  await kickQueued();
}

// ---- 付け直し（無停止の更新 2b-4。docs/zero-downtime-update/stage2-server-state.md §4.2・§5）----------------------

/** 出している承認のカード（中継の複製・設定の変更の承認・ホストへ任せた子の承認を除く）の id。札の waits */
const openWaitIds = sessionId => !sessionId ? [] : [...runtime.waiting]
  .filter(([, w]) => !w.relay && !w.detached && !w.remote && w.payload.sessionId === sessionId).map(([id]) => id);

/** 完了通知の本文を札に置く文字数の上限。長い結果が載る通知で札が上限を超えないよう、本文は切る（付け直した先の画面の通知の一行が短くなるだけ。ハッシュと元の文字数は残す） */
const NOTICE_CARD_CHARS = 4000;

/**
 * 札の途中送信の欄（steers。stage2-server-state.md §3 の 3）: 渡った合図（userMessage.delivered / dropped）を待っている控えを、項目の id ごとに
 * 「誰が待っているか」（waiters）と一緒にまとめる。送信待ちの項目の受理（pendingSteers）・走っている依頼元へ渡した完了通知（liveNotices）・
 * 子のターンへ渡した追加指示（liveInstructions と、agentTasks の steers の claim）。bot の liveSteers は bot の会話を付け直さないので入れない。
 * Claude の pendingSteers（CLI の uuid との組）は 2c が backendCard に足す。付け直す側は restoreSteers で同じ控えを作り直す
 */
function steersOf(turn) {
  const sessionId = turn.info.sessionId;
  const steers = {};
  const add = (id, waiter, detail = {}) => { const entry = steers[id] ??= { waiters: [] }; entry.waiters.push(waiter); Object.assign(entry, detail); };
  for (const id of turn.pendingSteers ?? []) add(id, 'pendingSteers');
  for (const [id, notice] of liveNotices) {
    if (notice.owner !== sessionId) continue;
    add(id, 'liveNotices', { notice: { prompt: notice.prompt.slice(0, NOTICE_CARD_CHARS), promptHash: promptHash(notice.prompt), promptChars: notice.prompt.length,
      items: notice.items, ...(notice.settingNotices ? { settingNotices: notice.settingNotices } : {}) } });
  }
  for (const [id, sent] of liveInstructions) {
    if (sent.sessionId !== sessionId) continue;
    add(id, 'liveInstructions', { taskId: sent.taskId, instructionIds: sent.instructionIds });
    add(id, 'agentTasks');
  }
  return steers;
}

/**
 * 札の steers から、付け直すターンの途中送信の控えを作り直す（steersOf の逆。restoreTurn が呼ぶ）。戻り値は pendingSteers の id の集合。
 * texts は、このターンの transcript の人の発言（ハッシュ -> 本文）。札で切った完了通知の本文は、折り込まれていればここから戻す（2c）
 */
function restoreSteers(sessionId, steers, texts = new Map()) {
  const pending = new Set();
  for (const [id, entry] of Object.entries(steers)) {
    if (entry.waiters.includes('pendingSteers')) pending.add(id);
    const notice = entry.waiters.includes('liveNotices') ? entry.notice : null;
    if (notice && typeof notice.prompt === 'string' && Array.isArray(notice.items)) {
      const prompt = notice.promptChars > notice.prompt.length ? texts.get(notice.promptHash) ?? notice.prompt : notice.prompt;
      liveNotices.set(id, noticeEntry(sessionId, prompt, notice.items.map(x => ({ taskId: String(x?.taskId ?? ''), revision: x?.revision ?? 0 })),
        Array.isArray(notice.settingNotices) ? notice.settingNotices : null));
    }
    if (entry.waiters.includes('liveInstructions') && typeof entry.taskId === 'string' && Array.isArray(entry.instructionIds)) {
      liveInstructions.set(id, { sessionId, taskId: entry.taskId, instructionIds: entry.instructionIds.filter(x => typeof x === 'string') });
    }
  }
  return pending;
}

/** ターンの札（cardOf の { card, secrets }）。会話の口のトークン・出している承認の id・途中送信の控え・委譲の子の実行の控えを足す。作れなければ投げる */
function takeCard(ctx) {
  const { turn } = ctx;
  const entry = agentConnections.get(turn.key);
  // ply_context の口は、会話のあいだ同じ値で開くバックエンド（agy）でなければ、ターンごとの値で開く（launchTurn）。CLI が持つのはその値なので、札にはその値を置く
  // （付け直す側の adoptTurn が同じ値で開き直す。2c）
  const live = /^Bearer ([a-f0-9]{64})$/.exec(ctx.runtimeContext?.headers?.Authorization ?? '')?.[1] ?? null;
  const tokens = entry ? { ...connectionTokens(entry), ...(live ? { context: live } : {}) } : null;
  // バックエンドの欄（backendCard）は、保持役に子を載せるバックエンドが control.backendCard で渡す（Claude の途中送信の控え・費用の基準など。2c）
  return cardOf({ ...ctx, backendCard: turn.control?.backendCard?.() ?? null, connectionTokens: tokens, waits: openWaitIds(turn.info.sessionId),
    stopping: Boolean(turn.info.stopping || turn.ac.signal.aborted), steers: steersOf(turn), execution: taskExecutions.get(turn.info.sessionId) ?? null });
}

/**
 * 札の置き直し（無停止の更新 2b-6）。保持役に子を載せるバックエンドは、ターンの control に holder: { label(card) } を渡す（置き直す口）。
 * 札の中身が変わるたび（ターンの始まり・渡った合図・承認の出入り・中断の始まり・途中送信の添付・git の撮影）にここへ来て、保持役の子の札（label）を
 * 置き直す。サーバーが強制終了された（2e）とき、新しいサーバーが付け直すのは、この札を読んで（旧サーバーが手を離す handOffTurn を経ない）。
 * 同じ tick の呼び出しは 1 回にまとめる（変わった後の値を置く）。バックエンドを呼ぶ前・会話の id が決まる前・手を離した後・終わった後は置かない
 */
function touchCard(turn) {
  if (!turn?.control?.holder || turn.cardPending || turn.handedOff || turn.ended) return;
  turn.cardPending = true;
  setImmediate(() => {
    turn.cardPending = false;
    const ctx = turnContexts.get(turn);
    if (!ctx || turn.handedOff || turn.ended || !turn.info.sessionId || !ctx.backendInvoked) return;
    try { turn.control.holder.label(takeCard(ctx).card); }
    catch (e) { console.error(`  札を保持役に置き直せない（${turn.info.sessionId}）:`, String(e?.message ?? e)); }
  });
}

/**
 * 旧サーバーの口（2d が引き継ぎで呼ぶ）: 走っているターンを付け直しに渡し、保持役に置く札（cardOf の { card, secrets }）を返す。
 * 渡したターンは、このサーバーでは締めず（driveTurn。X1）出来事も流さない（makeEmit）。detach の後に query を閉じるとバックエンドは
 * aborted で返るので、そのまま締めると中断の印と completedAt が書かれる。会話の id が決まる前・バックエンドを呼ぶ前のターンと、
 * 札が作れない（上限を超える）ターンは渡さない（null。今の中断のまま）
 */
function handOffTurn(key) {
  const turn = runtime.turns.get(key);
  const ctx = turn && turnContexts.get(turn);
  if (!ctx || turn.ended || turn.handedOff || !turn.info.sessionId || !ctx.backendInvoked) return null;
  let taken;
  try { taken = takeCard(ctx); }
  catch (e) { console.error(`  ターンを付け直しに渡せない（${turn.info.sessionId}）:`, String(e?.message ?? e)); return null; }
  turn.handedOff = true;
  return taken;
}

/**
 * このターンは、保持役に載っていて新しいサーバーへ渡せるか（引き継ぎ。core/handover.mjs）。札を置く口 control.holder（handOff を持つもの）を渡す
 * バックエンドの、バックエンドを呼んだ後のターン。bot の会話と圧縮のターンは渡さない（restoreTurn が付け直さない）
 */
function holdable(turn) {
  const ctx = turn && turnContexts.get(turn);
  if (!ctx || !ctx.backendInvoked || ctx.hooks?.compact || turn.ended || turn.handedOff || !turn.info.sessionId || !turn.control.holder?.handOff) return false;
  return !store.peek(turn.info.sessionId)?.bot;
}

/** 旧サーバーの引き継ぎ（core/handover.mjs）。main の handover の依頼で走る。成功すると release の中で main へ答えてロックを放し、このプロセスは終わる */
let handoverReply = null;
const handoverRun = createHandover({
  log: line => console.log(`  [handover] ${line}`),
  hold: () => { handover.hold = true; },
  unhold: () => {
    handover.hold = false;
    // 送信待ちに回していた分を送る
    void store.getAll().then(all => { for (const [id, meta] of Object.entries(all)) if (meta.outbox?.length) outbox.kick(id).catch(() => {}); }).catch(() => {});
  },
  settled: () => {
    const busy = [];
    // switching はターンの間ずっと会話を持つ（releaseTurn が外す）。走っているターンの分は短い処理ではない
    if ([...switching].some(id => !runtime.turns.has(id))) busy.push('switching');
    if ([...forking].some(id => !runtime.turns.has(id))) busy.push('forking');
    if (outbox.busy) busy.push('outbox');
    if (agentTasks.settling) busy.push('notices');
    if (handover.critical.size) busy.push('steer');
    if (schedule.firing) busy.push('schedule');
    return { ok: busy.length === 0, detail: busy.join(', ') };
  },
  blockers: () => {
    const out = [];
    const heldIds = new Set();
    for (const turn of runtime.turns.values()) {
      if (holdable(turn)) heldIds.add(turn.info.sessionId);
      else out.push({ kind: 'turn', sessionId: turn.info.sessionId ?? null });
    }
    for (const [, w] of runtime.waiting) if (!w.relay && !w.detached && !heldIds.has(w.payload.sessionId ?? null)) out.push({ kind: 'permission', sessionId: w.payload.sessionId ?? null });
    for (const r of agentTasks.running()) if (!r.host && ['queued', 'running', 'cancelling'].includes(r.status) && !runtime.turns.has(r.sessionId)) out.push({ kind: 'task', sessionId: r.sessionId ?? null });
    return out;
  },
  inflight: () => handover.inflight.size,
  turns: () => [...runtime.turns.values()].filter(holdable).map(turn => ({ key: turn.key, sessionId: turn.info.sessionId, turn })),
  stopTimers: () => { schedule.pause(); compactionScheduler.stop(); },
  resumeTimers: () => { schedule.resume(); compactionScheduler.resume(); },
  take: item => handOffTurn(item.key),
  untake: item => { item.turn.handedOff = false; },
  detach: (item, taken) => item.turn.control.holder.handOff(taken.card),
  abortOne: item => {
    // 渡せなかったターンだけ中断する（理由は update。「再開」で続けられる）。このサーバーが締める
    item.turn.handedOff = false;
    void abortSessions({ sessionId: item.sessionId, reason: 'update' }).catch(() => {});
  },
  ended: item => item.turn.ended || runtime.turns.get(item.key) !== item.turn,
  // 預かり物（トークン・ポート）を保持役へ置く。居る保持役にだけ（保持役が無ければ、新しいサーバーは main の渡した変数で起動する）
  stash: async () => {
    // 保持役に載った `!` の行も手を離す（無停止の更新 段階 3。終わりで止めない。新しいサーバーが引き取る）
    await shellRuns.handOff();
    const root = BOOT_ENV.AGENT_HOST_RUNTIME_ROOT;
    const client = root ? await holderLink({ dataDir: store.dataDir, root, launch: false }).catch(() => null) : null;
    if (!client) return;
    client.stash(stashOf({ token: TOKEN, cliToken: CLI_TOKEN, port: server.address().port, appVersion: APP_VERSION }));
    // 預かり物の書き込みに答えは無い。同じ接続の順序は保たれるので、手を離す依頼（もう離れている）の答えを待てば、預かり物は保持役に届いている
    await client.detach().catch(() => {});
  },
  // DB を書き切り、main へ答えてから、データ置き場のロックを放して終わる（以後このプロセスは何も書かない）
  release: async result => {
    await Promise.race([voiceHost.close(), new Promise(resolve => setTimeout(resolve, 2000))]).catch(() => {});
    chromeRelay?.close();
    store.flushNow();
    handoverReply?.({ ...result, at: Date.now(), pid: process.pid });
    // 答えがパイプへ出るのを待ってから終わる（すぐ終わると、書きかけの答えが main に届かないことがある）
    await new Promise(resolve => setTimeout(resolve, 60));
    // 待ち受けのポートも新しいサーバーのために空ける（同じポートで待ち受ける。画面は 1.5 秒ごとのつなぎ直しで戻る）
    server.close();
    server.closeAllConnections?.();
    // bot の DB（別のファイル）を閉じ、データ置き場の DB の接続を持ち主が残っていても全部閉じてから、ロックを放す（新サーバーが取ってすぐ開く）
    await Promise.race([Promise.resolve(botHost?.close?.()), new Promise(resolve => setTimeout(resolve, 1500))]).catch(() => {});
    store.closeStore();
    closeDataDb(store.dataDir);
    releaseDataLock();
    console.log(`  [handover] released the data lock at=${Date.now()}`);
    process.exit(0);
  },
});

/** main の handover の依頼（desktop/switch.cjs）。引き継げれば release の中で答えて終わる。引き継げなければ答え（ok: false。サーバーは元のまま）を返す */
async function handoverToNext(data) {
  const reply = body => mainPort.postMessage({ type: 'handover', id: data.id, ...body });
  if (!mainLink) return reply({ ok: false, reason: 'unsupported' });
  handoverReply = reply;
  const result = await handoverRun.run({ ...(Number(data.drainMs) > 0 ? { drainMs: Number(data.drainMs) } : {}), ...(Number(data.inflightMs) >= 0 ? { inflightMs: Number(data.inflightMs) } : {}) })
    .catch(error => ({ ok: false, reason: 'error', detail: String(error?.message ?? error) }));
  if (!result.ok) reply(result);
}

/**
 * 札と付け直す元（core/adopt.mjs の source）から、走っているターン（runtime.turns の 1 件と ctx）を組み立てて登録する。
 * 起動時の後片付け（送信待ちの戻し・中断の記録）より前に呼ぶ。口を開き直すのと記録を流すのは、待ち受けの後の adoptTurn。
 * 付け直せない（札が大きすぎる・版が違う・会話の走っている印と合わない・記録に印が無い・切れている・続きを受けられない、
 * bot の会話・圧縮のターン・タスクの id が分からない委譲の子。委譲の子は 2b-7 から付け直す）ときは投げる。呼び出し側は何もせず、今の起動時の restart の回復（中断）に任せる
 */
async function restoreTurn(card, source) {
  if (Buffer.byteLength(JSON.stringify(card ?? null), 'utf8') > CARD_MAX_BYTES) throw new Error('card too large');
  const fields = restoreFields(card);
  if (!fields) throw new Error('unknown card version');
  const { sessionId, startedAtMs } = fields;
  if (!sessionId || fields.key !== sessionId) throw new Error('no session id');
  if (runtime.turns.has(sessionId)) throw new Error('already running');
  if (!fields.presentKey || !fields.connectionTokens?.context) throw new Error('card is incomplete');
  const backend = getBackend(fields.backendId);
  if (!backend?.adoptTurn) throw new Error(`backend cannot adopt: ${fields.backendId}`);
  const meta = await store.get(sessionId);
  // 札が、この会話の走っている印（turnStartedAt）のターンのものか。合わない札は前の版のターンのもの
  if (!meta.turnStartedAt || meta.turnStartedAt !== startedAtMs) throw new Error('turn mismatch');
  // bot の会話（O21）・圧縮のターンは付け直さない。委譲の子は、タスクの id が分かるときだけ（結果の確定は adoptChild が agentTasks へ引き継ぐ。2b-7）
  if (meta.bot || fields.compactTrigger) throw new Error('not adoptable');
  const taskId = meta.delegation ? (meta.delegation.taskId ?? null) : null;
  if (meta.delegation && (!taskId || (fields.taskId && fields.taskId !== taskId))) throw new Error('not adoptable');
  if (!Number.isInteger(source?.state?.marks?.[ADOPT_TURN_MARK])) throw new Error('no turn mark');
  if (source.state.truncated) throw new Error('record truncated');
  if (!source.attachable) throw new Error('child cannot be attached');

  // ターンの前の履歴（T1）。付け直しの時点の履歴にはこのターンの途中の発言が入っているので、札の切り口で切る。
  // このターンの present（turnKey）は記録の再生が積むので外す
  const transcript = await history.loadTranscript(sessionId, backend).catch(() => ({ messages: [], presents: [] }));
  const lastAt = fields.baseline.lastUuid ? transcript.messages.findIndex(m => m.uuid === fields.baseline.lastUuid) : -1;
  const count = lastAt >= 0 ? lastAt + 1 : Math.min(fields.baseline.count, transcript.messages.length);
  const turnKeys = new Set([fields.presentKey, ...fields.steeredAttachments.map(a => a.key)]);
  const baseline = { ...transcript, messages: transcript.messages.slice(0, count),
    presents: (transcript.presents ?? []).filter(p => !turnKeys.has(p.turnKey)) };
  // 発言の本文は札に入れていない（core/turn-card.mjs）。履歴の切り口の後ろか、送信待ちの項目から引き、ハッシュで突き合わせる
  const queued = fields.messageId ? (await outbox.list(sessionId).catch(() => [])).find(m => m.id === fields.messageId) : null;
  const prompt = [...transcript.messages.slice(count).filter(m => m.role === 'user').map(m => m.text), queued?.args?.prompt]
    .find(text => typeof text === 'string' && promptHash(text) === fields.promptHash) ?? '';

  const cwd = meta.cwd ?? fields.cwd;
  const agentLocale = fields.agentLocale;
  // 会話の記録の写し（store.get は記録そのものを返す。そのまま持つと、ターンの途中の変更が saveContext の「変わっていない」の判定で書かれない）
  const contextRecord = structuredClone(meta.contextSession ?? null);
  const turn = {
    stream: {
      ...structuredClone(baseline),
      user: fields.internal ? null : { role: 'user', text: prompt, at: fields.user?.at ?? new Date(startedAtMs).toISOString(), backend: backend.id },
      initialMessageId: fields.messageId,
      events: [],
    },
    key: sessionId,
    ac: new AbortController(),
    abortReason: fields.abortReason,
    startedAtMs,
    userSentAt: fields.userSentAt ?? startedAtMs,
    backend,
    agentLocale,
    control: { handle: null, touch: () => touchCard(turn), track: promise => trackIn(handover.inflight, promise), onReady: () => {
      outbox.kick(sessionId).catch(() => {});
      agentTasks?.sendQueued(sessionId).catch(() => {});
    } },
    outcome: null,
    compactTrigger: null,
    // 予約の版は compactionScheduler のメモリの値。待ち受けの後（adoptTurn）で取り直す（T15）
    compactionRevision: null,
    userInitiated: !fields.internal,
    compaction: null,
    compactionWrite: Promise.resolve(),
    contextWindow: null,
    contextRecord,
    taskHints: new Map(),
    pastSubagents: fields.pastSubagents,
    subagentOrigins: new Map(),
    presentKey: fields.presentKey,
    presentWrites: [],
    // 渡った合図を待つ途中送信の控え。付け直しでは札の steers から作り直す（restoreSteers。作るのは下の登録の前）
    pendingSteers: new Set(),
    ended: false,
    // id は決まっている（付け直すのは id が決まったターンだけ。T5）。id 決定時の書き込みは済んでいる（T36）
    setup: Promise.resolve(),
    ...(fields.steeredAttachments.length ? { steeredAttachments: fields.steeredAttachments } : {}),
    ...(fields.browserRelayId ? { browserRelayId: fields.browserRelayId } : {}),
    info: {
      sessionId,
      backend: backend.id,
      startedAt: new Date(startedAtMs).toISOString(),
      cwd,
      mode: meta.mode ?? fields.permissionMode,
      model: meta.model ?? fields.model ?? '',
      effort: meta.effort ?? fields.effort,
      endpoint: fields.endpointId,
      account: fields.accountId,
      status: null,
      attachments: fields.attachments,
      phase: 'active',
      background: [],
    },
  };
  // 止め始めていたターン（T7）。中断をもう一度送るのは adoptTurn
  if (fields.stopping) turn.info.stopping = true;
  turn.savedHookLeaks = savedHookLeaks(contextRecord?.hooks, startedAtMs);
  // 始まりの撮影（T33）。撮れていれば終わりの撮影（closeTurn）に渡す
  if (fields.git?.activity) { turn.git = fields.git.activity; turn.gitSetup = Promise.resolve(fields.git.activity); }
  if (fields.git?.late) turn.gitLate = true;
  turn.ac.signal.addEventListener('abort', () => { turn.stops ??= captureStops(turn); touchCard(turn); }, { once: true });
  turn.worktreeId = (await worktreeHost.worktrees.byPath(cwd).catch(() => null))?.id ?? null;
  turn.gitCalls = createCallTracker();
  const emit = makeEmit(turn);
  turn.visualizations = createVisualizationCollector({
    access: fileAccess,
    publish: async payload => {
      const record = await history.recordPresent(sessionId, { ...payload, turnKey: turn.presentKey });
      emit({ type: 'present', sessionId, ...record }, { recorded: true });
    },
  });
  const ctx = {
    args: { sessionId, prompt, messageId: fields.messageId, at: fields.userSentAt, scheduledFor: fields.scheduledFor, sentBy: fields.sentBy },
    hooks: { internal: fields.internal, ...(taskId ? { taskId } : {}) },
    sessionId,
    prompt,
    backend,
    cwd,
    account: null,
    accountId: fields.accountId,
    endpoint: null,
    endpointId: fields.endpointId,
    agentLocale,
    permissionMode: turn.info.mode,
    model: turn.info.model,
    effort: turn.info.effort,
    attachments: fields.attachments,
    baselineLength: count,
    policy: contextRecord?.policy ?? null,
    plyContext: false,
    resolvedContext: null,
    hasContext: false,
    contextRecord,
    hooksTurn: null,
    turn,
    emit,
    abortFromTask: () => {},
    // 付け直すのはバックエンドを呼んだ後のターンだけ（L4）
    didStart: true,
    backendInvoked: true,
    // ply_context の口（contextBridge.open）は、待ち受けの後の adoptTurn が札のトークンで開き直す（外部 MCP は起こし直す。呼び出しの最中の分は戻らない。R15）
    runtimeContext: null,
    initialDelivered: fields.delivery.initialDelivered,
    interruption: fields.interruption,
    interruptionTaken: fields.delivery.interruptionTaken,
    shellHandoff: fields.shellHandoff,
    shellHanded: fields.delivery.shellHanded,
    runArgs: null,
    card: fields,
    // 委譲の子のターン: タスクの id と実行の控え（結果の確定は adoptChild。rejections・streamed は再生の出来事から作り直る。reply・stopped は札）
    taskId,
    execution: taskId ? newExecution(fields.delegation) : null,
  };
  bindTurnContext(ctx);
  turnContexts.set(turn, ctx);
  runtime.turns.set(turn.key, turn);
  // 途中送信の控え（札の steers）。登録の後に作り直す（ここから先は投げない）
  // 札で切った完了通知の本文は、折り込まれていれば transcript の人の発言にある（Claude）。ハッシュで引いて戻す
  const texts = new Map(transcript.messages.slice(count).filter(m => m.role === 'user' && typeof m.text === 'string').map(m => [promptHash(m.text), m.text]));
  turn.pendingSteers = restoreSteers(sessionId, fields.steers, texts);
  if (ctx.execution) taskExecutions.set(sessionId, ctx.execution);
  return ctx;
}

/**
 * 付け直しの入口（無停止の更新 2b-4）: 札と付け直す元から走っているターンの制御を作り、driveTurn で締める（締めの道は通常のターンと 1 本。R2）。
 * ctx は restoreTurn の戻り値（起動では、後片付けより前に登録しておき、待ち受けの後にこれを呼ぶ）。無ければここで組み立てる。
 * 会話の口は札のトークンで開き直す（restoreConnection。待ち受けの後でないと開けない）。記録は backend.adoptTurn が流す
 * （印から ack までは再生。makeEmit の replay）。付け直せなかったら、そのターンを restart の中断で締める（起動時の後片付けと同じ印）
 */
async function adoptTurn(card, source, ctx = null, { abandon = null } = {}) {
  ctx ??= await restoreTurn(card, source);
  const { turn, sessionId, backend, agentLocale, emit } = ctx;
  const releaseUpdateGate = updateGate.enter();
  try {
    turn.compactionRevision = compactionScheduler.revision(sessionId);
    return await driveTurn(ctx, async () => {
      // 再生の終わりに 1 回ずつ（makeEmit が再生では走らせない分。§4.4）
      let replayed = false, settled = false;
      const settle = () => {
        if (settled) return;
        settled = true;
        watchChildBackground(turn);
        broadcastRunning();
        if (turn.info.phase === 'waiting') outbox.kick(sessionId).catch(() => {});
      };
      try {
        // 待ち受けのポートが取れず付け直しをあきらめた（起動の待ち受け。MCP の口の URL が変わるので付け直せない。§3 の 9）
        if (abandon) throw new Error(abandon);
        restoreConnection({ key: turn.key, sessionId, locale: agentLocale, tokens: ctx.card.connectionTokens, computerBackend: backend.id });
        broadcastRunning();
        syncRunningPoll();
        // Pleiad の Hooks の登録（札の hooks があるターン）。Claude は 2 回目の initialize でコールバックを渡し直す（2c）ので、今の設定で組み直す。
        // 記録（contextRecord.hooks）は札の会話の記録のまま。組めなければ渡さない（そのターンの残りで Pleiad の Hooks が動かない）
        const hooksTurn = ctx.card.hooks ? await prepareHooksTurn({ agent: backend.id, cwd: ctx.cwd, ctx: { plyHooks, hooksConfig, dataDir: store.dataDir, findNode: findNodeOnPath,
          context: { owners: ctx.policy?.owners ?? {}, delivered: false } } }).catch(e => { console.error(`  Hooks を組み直せない（${sessionId}）:`, String(e?.message ?? e)); return null; }) : null;
        // ply_context の口（Pleiad がコンテキストを担当する会話。2c）。札のトークンで開き直し、外部の MCP はこのターンのために起こし直す（R15。ツールの名前は
        // 項目の id とツールの名前から決まるので同じ。状態は消えるので、起こし直した後の最初の結果にその旨を添える）。開けなければ口の無いまま続ける
        // （CLI の ply_context の呼び出しが失敗する）。CLI は口の URL・ヘッダーを持っているので、バックエンドには渡さない
        if (managed(ctx.policy) && acceptsPlyContext(backend, ctx.policy)) {
          try {
            const resolved = await resolveRuntime(ctx.policy, { plyServers: await plyMcp.scanInput(), snapshots: CONTEXT_SNAPSHOTS, locale: agentLocale });
            ctx.runtimeContext = await contextBridge.open({ runtime: resolved, prompt: ctx.prompt, token: ctx.card.connectionTokens.context, restarted: true,
              origin: localOrigin(), signal: turn.ac.signal, isActive: () => runtime.turns.get(turn.key) === turn && !turn.ac.signal.aborted });
            console.log(`  ply_context の口を開き直した（${sessionId}）: 外部の MCP ${resolved.servers.length} 件を起こし直した`);
          } catch (e) { console.error(`  ply_context の口を開き直せない（${sessionId}）:`, String(e?.message ?? e)); }
        }
        ctx.runArgs = {
          sessionId, cwd: ctx.cwd, mode: ctx.permissionMode, model: ctx.model || undefined, effort: ctx.effort,
          card: ctx.card.backendCard, source,
          ...(hooksTurn?.runtime ? { hooksRuntime: hooksTurn.runtime } : {}),
          emit: (event, opts) => {
            if (opts?.replay) replayed = true;
            else { if (replayed) settle(); if (ANSWER_EVENTS.has(event?.type)) ctx.onPromptDelivered(); }
            return emit(event, opts);
          },
          onPromptDelivered: ctx.onPromptDelivered,
          askPermission: request => askPermission({ ...request, locale: agentLocale }),
          hostInvoke: hostInvokeFor(agentLocale),
          signal: turn.ac,
          control: turn.control,
          locale: agentLocale,
        };
        // 止め始めていたターン（T7）は、中断をもう一度送る（旧サーバーの中断が子に届いたか分からない。届いていても重ねて送って害は無い）。理由は札のまま。
        // 記録の再生は止めない（実行中のスナップショットは印から全部作る）。子への書き込みは付け直した後に出る（core/adopt.mjs の holderSource）
        if (ctx.card.stopping) {
          turn.ac.abort();
          emit({ type: 'activity', state: 'stopping' });
        }
        const result = await backend.adoptTurn(ctx.runArgs);
        if (replayed) settle();
        console.log(`  ターンを付け直した（${sessionId}）: 記録 ${source.state.id}・ack ${source.acked ?? source.state.acked}`);
        return result;
      } catch (err) {
        console.error(`  ターンを付け直せなかったので中断として残す（${sessionId}）:`, String(err?.message ?? err));
        turn.abortReason = 'restart';
        emit({ type: 'turnResult', outcome: 'aborted' });
        return { sessionId };
      }
    });
  } finally {
    releaseUpdateGate();
    // 札の承認のうち、出し直されず決着の行も付かなかったもの（答えが旧サーバーの手を離す前後で記録に入った・付け直しをあきらめた）の通知の一覧の行を畳む。
    // 決着済みの行には何もしない（出し直して答えた承認は、その答えで決着している）
    for (const id of ctx.card.waits) void inboxSources.permissionSettled({ id, answer: { messageKey: 'turnEnded' } });
    await releaseTurn(sessionId, { adopted: true });
  }
}

/**
 * 起動で付け直すターンを読み、登録する（restoreTurn）。元は既定で空。テストだけが付ける: AGENT_HOST_ADOPT_FROM は
 * 「終わっていたターン」の札と記録（ファイルの元）、AGENT_HOST_ADOPT_HOLDER=1 は保持役の子（2b-5。実行場所の置き場は AGENT_HOST_RUNTIME_ROOT。
 * 旧サーバーが手を離すときに札を置いた子だけ。保持役に子を載せるバックエンドは fake の台本 held: と、AGENT_HOST_CLAUDE_HOLDER=on の Claude。2c）。core/adopt.mjs。
 * 付け直せない元は何もせず、起動時の restart の回復に任せる
 */
async function restoreAdoptedTurns() {
  const failed = err => { console.error('  付け直す元を読めませんでした:', String(err?.message ?? err)); return []; };
  const dir = process.env.AGENT_HOST_ADOPT_FROM;
  const root = BOOT_ENV.AGENT_HOST_RUNTIME_ROOT;
  const sources = [
    ...(dir ? await readAdoptSources(dir).catch(failed) : []),
    ...((process.env.AGENT_HOST_ADOPT_HOLDER === '1' || HANDOVER_START || handoverEnabled(BOOT_ENV)) && root ? await readHolderSources({ dataDir: store.dataDir, root, appVersion: APP_VERSION }).catch(failed) : []),
  ];
  const adopted = [];
  for (const source of sources) {
    const card = source.state.label;
    try { adopted.push({ card, source, ctx: await restoreTurn(card, source) }); }
    catch (err) { source.dispose?.(); console.error(`  ターンを付け直せないので中断として残す（記録 ${source.id}）:`, String(err?.message ?? err)); }
  }
  return adopted;
}

/**
 * ターンの後始末。使用量と完了時刻を残し、turnEnd を出して一覧から外す。
 * requeue（相手が別のターンを走らせていて何も届かなかった）は完了ではないので、使用量も完了時刻も残さない。
 */
async function endTurn(turn, emit, { record = true } = {}) {
  if (turn.ended) return;
  turn.ended = true;
  const requeued = turn.outcome === "requeue";
  const completedAt = requeued ? null : Date.now();
  // 中断で終わった（バックエンドが aborted を返した。止めた後に失敗として終わったものも含む）なら、会話に中断として残す。
  // 時刻は completedAt と同じ値にする（確認済みの印 readAt は completedAt で丸めるので、ずらすと未読から戻れない）
  const limited = !requeued && turn.outcome === 'limited';
  const stopped = !requeued && (limited || turn.outcome === "aborted" || (turn.ac.signal.aborted && turn.outcome !== "ok"));
  const interrupted = limited ? { at: completedAt, reason: 'limit', ...turn.limit } : stopped ? { at: completedAt, reason: turn.abortReason ?? "user" } : null;
  // 上限で止まった会話は解除時刻（遠い先でも）に自動で戻る。時刻が分からないときは 30 分ごとに使用量を確かめる（resumePlan）
  // 人が［再開しない］にした会話は、再び上限になっても外したままにする。時刻不明の上限を確かめ直して再開した直後にまた上限になったら、間隔を伸ばす
  const sessionKey = turn.info.sessionId;
  const keepOff = limited && sessionKey ? (await store.get(sessionKey).catch(() => ({}))).autoResumeOff === true : false;
  const pollState = limited && sessionKey ? limitPoll.get(sessionKey) : null;
  const plan = limited ? resumePlan(interrupted.resetsAt, completedAt, pollState?.resumed ? pollState.strikes + 1 : 0) : null;
  if (limited) { interrupted.resetsAt = plan.resetsAt; interrupted.autoResume = !keepOff; }
  if (sessionKey && (!limited || !plan.poll)) limitPoll.delete(sessionKey);
  else if (limited && sessionKey) limitPoll.set(sessionKey, { strikes: pollState?.resumed ? pollState.strikes + 1 : 0, resumed: false });
  if (record && !requeued) await usageStore.record({ ...turn.usage, id: turn.presentKey, backend: turn.backend.id, sessionId: turn.info.sessionId })
    .catch(() => { console.error('  使用量を記録できませんでした'); });
  if (turn.backend.id === 'antigravity' && turn.info.sessionId && (turn.outcome === 'error' || turn.outcome === 'limited' || turn.failureReason?.source === 'backend.afterReply')) {
    const previous = (await store.get(turn.info.sessionId).catch(() => ({}))).antigravityFailures ?? [];
    await store.setSessionData(turn.info.sessionId, 'antigravityFailures', [...previous, {
      at: completedAt, outcome: turn.outcome, ...(turn.failureReason ?? { source: 'unknown', error: '' }),
    }].slice(-16)).catch(err => console.error('  agy の失敗理由を記録できませんでした:', String(err?.message ?? err)));
  }
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
      if (keepOff) releaseLimitWait(id);
      else await schedule.put(resumeRow(id, interrupted, plan));
    }
    // このターンで進んだ分を検索の写しへ（裏で読み直す。待たない）
    if (!requeued) sessionSearch.refresh(turn.info.sessionId);
    // 中断で終わったターンが抱えていた裏の作業・承認待ちを、会話の「止めたもの」に残す（次のターンで伝える）
    if (stopped && turn.stops) await store.addStops(turn.info.sessionId, { ...turn.stops, reason: interrupted.reason }).catch(err => {
      console.error("  中断で止めたものの記録に失敗:", String(err?.message ?? err));
    });
  }
  // 委譲された子の会話（delegation）の完了は、画面が通知しない。結果は依頼元の会話へ届く
  const endMeta = turn.info.sessionId ? await store.get(turn.info.sessionId).catch(() => null) : null;
  const delegated = Boolean(endMeta?.delegation);
  // 人が［再開しない］にした印は、その会話が上限を抜けて普通に完了したら忘れる（次の上限はまた自動で戻る）
  if (endMeta?.autoResumeOff && turn.outcome === 'ok' && turn.info.sessionId) store.setSessionData(turn.info.sessionId, 'autoResumeOff', false).catch(() => {});
  // bot の会話の種類（thread・dm・routine・learner・pulse）。完了の知らせの出し分けに使う（ADR 0127）
  const botKind = endMeta?.bot?.kind ?? null;
  // Retain turnEnd in snapshots already being read, then release the turn.
  emit({ type: "turnEnd", completedAt, outcome: turn.outcome, interrupted, ...(requeued ? { requeued: true } : {}), ...(delegated ? { delegated: true } : {}) });
  runtime.turns.delete(turn.key);
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
    await agentTasks?.settleSteers(turn.info.sessionId).catch(() => {});
    for (const [id, sent] of [...liveInstructions]) {
      if (sent.sessionId !== turn.info.sessionId) continue;
      liveInstructions.delete(id);
      emitGlobal({ type: 'userMessage.dropped', sessionId: sent.sessionId, messageId: id });
    }
  }
  agentBrowserEndpoints?.endTurn(turn.info.sessionId || turn.key);
  // ロックの解放、止めた印・このターンの拒否の消去、main への後始末（押したままの入力を離し、オーバーレイを消す）
  if (computerLock.endTurn(turn.presentKey)) computerDriver?.turnEnded(turn.presentKey);
  notifyFree(turn.key);
  syncRunningPoll();
  // 片付けるのはこのセッションの承認待ちだけ。他のターンの分は残す
  settleAll('turnEnded', turn.info.sessionId);
  broadcastRunning();
  // worktree: このターンで取り込まれたもの・使われなくなったものを片付ける（ADR 0089）
  worktreeSweepSoon();
  // 空いている間の自動圧縮（idle）は利用者の作業ではないので、完了として知らせない
  // 夜の整理・心拍の隠れた会話（learner・pulse）は、完了も失敗も知らせない（失敗は memory.learnStatus・bot のページで見える。ADR 0127）
  if (!delegated && !HIDDEN_BOT_KINDS.has(botKind) && turn.compactTrigger !== 'idle') completionNotices.finished(turn.info.sessionId,
    turn.outcome, completedAt, { startedAt: turn.startedAtMs, bot: botKind, uuid: turn.lastUuid });
  settingApprovals?.changed();
  // bot の会話なら、ターンの投稿を確定し、たまった出来事を渡す（ターンを手放した後。待たない）
  if (!requeued) void botHost?.onTurnEnd(turn, { outcome: turn.outcome, interrupted, requeued });
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
    // 端末の AI に任された作業の依頼元（端末の会話）はホストに無い。端末が同期で知る
    if (!x?.parentSessionId || isRemoteOwner(x.parentSessionId)) continue;
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
async function resumeSession(sessionId, { onSettled } = {}) {
  if (!sessionId || typeof sessionId !== 'string' || !refuseRetired(await resolveBackendForSession(sessionId))) throw new Error(t('session.notFound'));
  if (resuming.has(sessionId) || sessionBusy(sessionId)) throw resumeRunning();
  const oldLimit = limitStates.get(sessionId);
  // 待ちの印と予定の行は、断る検査を通ってから下ろす（断った再開が、待たせる側だけを消さない）
  const releaseLimit = async () => {
    if (!oldLimit) return;
    limitStates.delete(sessionId);
    await schedule.cancel(`resume:${sessionId}`);
  };
  if (oldLimit) {
    const selected = await store.get(sessionId);
    if (limitSwitched(selected, oldLimit)) await releaseLimit();
    else if (Number.isFinite(oldLimit.resetsAt) && oldLimit.resetsAt > Date.now()) {
      // 解除時刻の前は、人が押しても自動の予定が動くのを待たせる（画面はこの間、再開を押せない表示にする）。時刻が分からない上限は断らない
      throw Object.assign(new Error(t('resume.limitWaiting')), { code: 'LIMIT_WAITING' });
    }
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
    await releaseLimit();
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
    if (sent) outboxSettled(sessionId, sent).finally(() => resuming.delete(sessionId))
      .then(() => onSettled?.(sent)).catch(() => {});
    else resuming.delete(sessionId);
  }
}

/**
 * 送信を受け付ける（画面の送信・送信予定の時刻・「今すぐ送る」が同じ入口）。
 * 中断した会話に新しい指示を送ったら、中断で保留になった未送信を先に並びのまま送り直す（再開と同じ）。
 * 戻さないと新しい指示は保留の後ろで順番を待ち続ける。画面は「保留中の N 件の後にこの指示で続けます」と出している
 */
async function acceptSend(sessionId, messageId, args) {
  if (!sessionBusy(sessionId) && interruptedOf((await store.get(sessionId)).interrupted)?.reason !== 'limit'
    && (await outbox.list(sessionId)).some(m => m.status === 'paused')) await outbox.retryPaused(sessionId);
  return outbox.accept(sessionId, messageId, args);
}

/** 上限の自動再開の予定の行。解除時刻が分からないとき（poll）は、その時刻ごとに使用量を確かめる */
const resumeRow = (sessionId, interrupted, plan) => ({ id: `resume:${sessionId}`, kind: 'resume', sessionId, at: plan.at,
  createdAt: interrupted.at, by: 'limit', account: interrupted.account, ...(plan.poll ? { poll: true } : {}) });

// 解除時刻が分からない上限の確かめ直し。会話 -> { strikes: 試しに再開してすぐ再び上限（時刻不明）になった回数, resumed: 今の再開が確かめ直しによるか }。
// メモリだけ（再起動したら 30 分から数え直す）。strikes に応じて間隔を伸ばす（pollInterval）
const limitPoll = new Map();
const POLL_TRIAL_MISSES = 3;
const BUSY_RETRY_MS = 120_000;

/** 会話の選択中のアカウント・エージェントが、上限で止まったときと違うか（替えたなら、止まった枠の待ちは関係なくなる） */
function limitSwitched(meta, limit) {
  const account = meta.nextSettings?.account ?? meta.claudeAccount ?? '';
  const backend = meta.nextSettings?.backend ?? meta.backend;
  return backend !== limit.backend || (limit.backend === 'claude' && account !== (limit.account ?? ''));
}

/**
 * その会話の自動再開を入れる・外す（会話末尾の［再開しない］・アカウントやエージェントを替えたとき・予定の取り消し）。
 * 予定・会話の印・送信待ちの目安（limitStates）を合わせる。外した会話は、解除時刻を過ぎれば人の「再開」で続けられる。
 * user は人が選んだとき: 会話に覚え、再び上限になっても外したままにする（外した会話が普通に完了すれば忘れる）
 */
async function setAutoResume(sessionId, enabled, { strict = false, user = false } = {}) {
  const stopped = (await store.get(sessionId)).interrupted;
  if (stopped?.reason !== 'limit') {
    if (strict) throw new Error(t('resume.notInterrupted'));
    return { sessionId, enabled: false };
  }
  const interrupted = { ...stopped, autoResume: Boolean(enabled) };
  await store.setMeta(sessionId, { interrupted });
  if (user) await store.setSessionData(sessionId, 'autoResumeOff', !enabled);
  limitStates.set(sessionId, interruptedOf(interrupted));
  emitGlobal({ type: 'limitResumeChanged', sessionId, interrupted: interruptedOf(interrupted) });
  if (!enabled) await schedule.cancel(`resume:${sessionId}`);
  else {
    // もう解除されているなら今すぐ（時刻を過ぎた予定は、置いてすぐ発火する）
    const plan = Number.isFinite(interrupted.resetsAt) ? { at: Math.max(interrupted.resetsAt, Date.now()) } : resumePlan(null);
    await schedule.put(resumeRow(sessionId, interrupted, plan));
  }
  releaseLimitWait(sessionId);
  return { sessionId, enabled: interrupted.autoResume };
}

/**
 * アカウントやエージェントを替えた。止まった枠の待ちは、替えた先には関係ない。自動再開を外し、待ちの印を下ろして、
 * 送信待ち（替えて送った指示）をすぐ流す。interrupted の印は残る（末尾は「自動では再開しません」。会話は人の「再開」で続けられる）
 */
async function leaveLimit(sessionId) {
  await setAutoResume(sessionId, false);
  clearTimeout(limitReleaseTimers.get(sessionId));
  limitReleaseTimers.delete(sessionId);
  limitStates.delete(sessionId);
  outbox.kick(sessionId).catch(() => {});
}

// 自動で戻さない会話（［再開しない］にした会話）の、解除時刻に送信待ちを流すタイマー
const limitReleaseTimers = new Map();
/** 止まった会話の待ちが解けていたら、送信待ちを流す。まだなら（自動で戻さない会話は）解除時刻に流す */
function releaseLimitWait(sessionId) {
  clearTimeout(limitReleaseTimers.get(sessionId));
  limitReleaseTimers.delete(sessionId);
  const limit = limitStates.get(sessionId);
  if (!limit) return;
  if (!limitHolds(limit)) { outbox.kick(sessionId).catch(() => {}); return; }
  if (limit.autoResume || !Number.isFinite(limit.resetsAt)) return;
  const timer = setTimeout(() => releaseLimitWait(sessionId), Math.min(2_147_000_000, Math.max(0, limit.resetsAt - Date.now())));
  timer.unref?.();
  limitReleaseTimers.set(sessionId, timer);
}

/** 止まった枠が空いたか（使用量の表示と同じ口。providerQuota）。true / false / 読めない null。止まった枠だけで判断する */
async function limitOpenNow(stopped, meta) {
  const backend = getBackend(stopped.backend ?? meta.backend);
  if (!backend?.usage) return null;
  const quota = await providerQuota(backend).catch(() => null);
  return limitOpen(quota, { account: stopped.account ?? '', window: stopped.window, backend: backend.id, model: stopped.model ?? meta.model ?? '' });
}

const autoResuming = new Set();
// 自動の再開が断られても失敗ではない理由（人が先に再開した・続きを送り終えた）
const AUTO_RESUME_SKIPPED = new Set(['SESSION_RUNNING', 'NOT_INTERRUPTED', 'LIMIT_WAITING']);
/** 自動再開の失敗: 自動再開を外し（会話は人の「再開」に戻り、その押したときに理由が出る）、失敗として 1 回知らせる */
async function autoResumeFailed(sessionId, reason) {
  console.error(`  上限の後の自動再開に失敗: ${sessionId}`, reason);
  await setAutoResume(sessionId, false).catch(() => {});
  completionNotices.finished(sessionId, 'error', Date.now());
}
/**
 * 解除時刻（時刻不明なら空いたことの確認）に会話を再開する。全部の会話が同時に動く。
 * 戻れなかったとき（結果不明の未送信がある・続きを送れない・受け付けた後に送信が失敗した）だけ、自動再開を外して失敗として 1 回知らせる。
 * 戻り値 'busy' は、別の作業が会話を使っていて受け付けられなかった（呼び出し元が後でもう一度試す）
 */
async function resumeFromLimit(sessionId) {
  if (autoResuming.has(sessionId)) return 'busy';
  autoResuming.add(sessionId);
  try {
    await resumeSession(sessionId, { onSettled: async ids => {
      const failed = (await outbox.list(sessionId).catch(() => [])).filter(m => ids.includes(m.id) && ['failed', 'unknown'].includes(m.status));
      if (failed.length) await autoResumeFailed(sessionId, failed[0].error ?? failed[0].status);
    } });
    return 'resumed';
  } catch (err) {
    if (err?.code === 'SESSION_RUNNING') return 'busy';
    if (AUTO_RESUME_SKIPPED.has(err?.code)) return 'skipped';
    await autoResumeFailed(sessionId, String(err?.message ?? err));
    return 'failed';
  } finally { autoResuming.delete(sessionId); }
}

/**
 * 起動時とスリープ解除時に、予定の行が無くても取りこぼさないよう、止まっている会話を見直す。
 * 解除時刻を過ぎた会話は再開し、予定の行が無い会話には置き直す。自動で戻さない会話は、送信待ちの待ちを解く
 */
async function recoverLimitResumes() {
  for (const [id, limit] of [...limitStates]) {
    const meta = await store.get(id).catch(() => null);
    if (meta?.interrupted?.reason !== 'limit') { limitStates.delete(id); continue; }
    if (limitSwitched(meta, limit) || (meta.claudeAccount ?? '') !== (limit.account ?? '')) { await leaveLimit(id).catch(() => {}); continue; }
    if (limit.autoResume !== true) { releaseLimitWait(id); continue; }
    if (Number.isFinite(limit.resetsAt) && limit.resetsAt <= Date.now()) await resumeFromLimit(id);
    else if (!schedule.get(`resume:${id}`)) await schedule.put(resumeRow(id, limit, Number.isFinite(limit.resetsAt)
      ? { at: limit.resetsAt } : { at: Date.now(), poll: true }));
  }
}

const schedule = createSchedule({ file: path.join(store.dataDir, 'schedule.json'),
  changed: entries => emitGlobal({ type: 'schedules', sessionId: null, entries }),
  fire: async row => {
    if (row.kind === 'send') return fireScheduledSend(row);
    if (row.kind === 'post') return fireScheduledPost(row);
    if (row.kind !== 'resume') throw new Error(`Unsupported schedule kind: ${row.kind}`);
    const meta = await store.get(row.sessionId);
    const stopped = meta.interrupted;
    // 今の上限の予定でない行（もう再開した・別の上限になった）は消えるだけ
    if (stopped?.reason !== 'limit' || stopped.at !== row.createdAt || stopped.autoResume !== true) return undefined;
    // 止まったときと違うアカウントを選んでいる会話は、勝手には動かさない（自動を外して人の「再開」に戻す）
    if (limitSwitched(meta, stopped) || (meta.claudeAccount ?? '') !== (row.account ?? '')) { await leaveLimit(row.sessionId); return undefined; }
    if (row.poll) {
      // 解除時刻が分からない上限は、使用量を確かめ、止まった枠が空いたら戻る。読めない・まだ上限なら次の確認まで待つ。
      // 読めないのが 3 回続いたら一度だけ試しに再開する（再び上限なら間隔が伸びる。endTurn の resumePlan）
      const strikes = limitPoll.get(row.sessionId)?.strikes ?? 0;
      const open = await limitOpenNow(stopped, meta);
      const misses = open === null ? (row.misses ?? 0) + 1 : 0;
      if (open === false || (open === null && misses < POLL_TRIAL_MISSES)) return { reschedule: Date.now() + pollInterval(strikes), patch: { misses } };
      limitPoll.set(row.sessionId, { strikes, resumed: true });
    }
    if (await resumeFromLimit(row.sessionId) === 'busy') return { reschedule: Date.now() + BUSY_RETRY_MS };
    return undefined;
  },
});

/**
 * 送信予定の時刻が来た。ふつうの送信と同じ入口（acceptSend）から送信待ちの末尾へ入れるので、会話が走っていれば
 * 「作業が終わると自動で送信」で待ち、上限で止まっていれば解除まで待つ。予定は送信待ちの順番を塞がない。
 * 遅れが 1 時間以内なら送り、それより遅れていたら送らずに行を残して確かめさせる（ADR 0103）
 */
async function fireScheduledSend(row) {
  if (!(await resolveBackendForSession(row.sessionId).catch(() => null))) {
    console.error(`  送信予定を捨てた（会話が無い）: ${row.sessionId}`);
    return undefined;
  }
  if (decideFire(row).action === 'hold') {
    notifyScheduleMissed(row);
    return { hold: 'missed' };
  }
  await sendScheduledNow(row);
  return undefined;
}

/** 送らずに確かめを待っている予定をスマホに知らせる（一度だけ。起動の直後はリモートがまだつながっていないので遅らせて呼ぶ） */
function notifyScheduleMissed(row) {
  if (row.notified) return;
  void conversationTitleOf(row.sessionId).then(title => pushNotifier.scheduleMissed({ sessionId: row.sessionId, title }))
    .then(sent => (sent?.length ? schedule.patch(row.id, { notified: true }) : null)).catch(() => {});
}

/** 予定の発言を送信待ちへ渡す。遅れて送ったことを、履歴の発言に添えるため会話に覚える（decorateScheduled） */
async function sendScheduledNow(row) {
  compactionScheduler.cancel(row.sessionId);
  await acceptSend(row.sessionId, row.messageId, sendArgs(row));
  const meta = await store.get(row.sessionId);
  await store.setSessionData(row.sessionId, 'scheduledSends', addRecord(meta.scheduledSends, row));
}

/** 予定を置く。会話ごと・全体の数を絞り、同じ messageId の置き直しは 1 件のまま（二重の予定を作らない） */
/** スレッドへの返信の予定（channels.schedulePost。kind 'post'）。人の投稿として、同じ clientId で 1 回だけ投稿する */
async function schedulePost(input) {
  const channels = botHost?.opsDeps().channels;
  if (!channels) throw new Error(t('schedule.notFound'));
  const root = await channels.getPost({ channelId: input.channelId, postId: input.threadId });
  if (!root || root.threadId !== null) throw new Error(t('schedule.notFound'));
  const row = buildPostRow({ ...input, by: 'human' });
  const rows = schedule.list().filter((r) => r.kind === 'post' || r.kind === 'send');
  const existing = rows.find((r) => r.id === row.id);
  if (existing) return { id: existing.id, at: existing.at };
  if (rows.filter((r) => r.kind === 'post' && r.threadId === input.threadId).length >= MAX_PER_SESSION || rows.length >= MAX_TOTAL)
    throw new Error(t('schedule.full', { max: MAX_PER_SESSION }));
  await schedule.put(row);
  return { id: row.id, at: row.at };
}
/** 予定の時刻が来た投稿。遅れすぎていれば送らずに確かめさせる（送信予定と同じ決まり） */
async function fireScheduledPost(row) {
  const decision = decideFire(row);
  if (decision.action === 'hold') return { hold: 'late' };
  await postScheduled(row);
  return undefined;
}
const postScheduled = (row) => botHost.opsDeps().channels.post({ channelId: row.channelId, threadId: row.threadId, text: row.args.prompt,
  ...(row.args.attachments?.length ? { attachments: row.args.attachments } : {}), ...(row.args.to ? { to: row.args.to } : {}), clientId: row.clientId }, { kind: 'human' });

async function scheduleSendMessage(input, by = 'human') {
  const { sessionId } = input ?? {};
  if (!sessionId || !refuseRetired(await resolveBackendForSession(sessionId))) throw new Error(t('session.notFound'));
  const row = buildSendRow({ ...input, sessionId, by });
  const rows = schedule.list().filter(r => r.kind === 'send');
  const existing = rows.find(r => r.id === row.id);
  if (existing) {
    if (JSON.stringify(existing.args) !== JSON.stringify(row.args) || existing.sessionId !== row.sessionId || existing.at !== row.at)
      throw new Error(t('queue.idConflict'));
    return { id: existing.id, at: existing.at, messageId: existing.messageId };
  }
  if (rows.filter(r => r.sessionId === sessionId).length >= MAX_PER_SESSION || rows.length >= MAX_TOTAL)
    throw new Error(t('schedule.full', { max: MAX_PER_SESSION }));
  await schedule.put(row);
  return { id: row.id, at: row.at, messageId: row.messageId };
}

wss.on("connection", (ws, req) => {
  // OS の操作（revealPath / openPath）を許すのは、サーバーのある PC の画面からの接続だけ（core/os-open.mjs）
  const local = isLocalRequest(req);
  // 中継越しの端末の画面（接続口が付ける x-pleiad-device）。見ている印と通知鍵の登録はこの端末のものとして扱う
  const via = local ? null : remote.deviceInfo(req.headers['x-pleiad-device']);
  if (via) connectionDevices.set(ws, via);
  // コンテキストの探索の錠（この接続で 1 つずつ。context.scan・context.skills・context.session の突き合わせ。ADR 0105）
  const wsScanLock = scanLockOf(ws);
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
    build: BUILD,
    homeDir: os.homedir(),
    resumedTurn: resumed,
    startedAt: SERVER_STARTED_AT,
    // 離れた端末への通知（ADR 0086）を受けられる。古いホストにはこの欄が無く、端末は鍵の登録を送らない
    notify: 1,
    // 通話モード（/voice-ws）に対応している。キーを持つこの PC の画面だけ（中継越しの端末の画面には出さない。docs/voice-call.md）
    voice: local ? 1 : 0,
    // 画面の言語。setting は設定値（auto|ja|en）、lang は実際に使う言語（ja|en）
    locale,
    // 送信予定の時刻をこの PC の時刻でも添えるため（見ている端末と時刻帯が違うとき。ADR 0103）
    hostTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  }));
  // エージェントのブラウザー（PC の Chrome）への接続の今の状態。ホストの PC の画面だけ（リモートの端末へは送らない）
  if (local) hostScreens.add(ws);
  if (chromeConnection && local) ws.send(JSON.stringify(chromeBrowserFrame(chromeConnection.state())));
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

    // 画面のコマンドは、操作の一覧（core/ops/）の同じ操作を人（画面）として呼ぶだけの外側。返り値は人に返す形（uiHandler）のまま。
    // viaOp(id)                  msg.args をそのまま渡す。then（成功の返り値を画面の形に直す）は第 2 引数に関数で渡せる
    // viaOp(id, input, { shape })  input を渡す（送らない欄 null・undefined は省く）。shape は従来の返り値の形へ寄せるとき
    // code が FAILED（code の無い失敗）なら画面へは code を付けない
    // msg.args をそのまま渡すときは、操作の入力に無い欄を無視する（昔の呼び出しは、前の返りをそのまま重ねて渡すことがある。ADR 0095）
    const args = msg.args;
    const known = (id, raw) => {
      const shape = opsRegistry.get(id)?.input?.shape;
      if (!shape || !raw || typeof raw !== 'object' || Array.isArray(raw)) return raw ?? {};
      return Object.fromEntries(Object.entries(raw).filter(([k]) => Object.hasOwn(shape, k)));
    };
    const viaOp = async (id, second, { shape = (r) => r } = {}) => {
      const then = typeof second === 'function' ? second : shape;
      const input = typeof second === 'function' || second === undefined ? known(id, msg.args)
        : Object.fromEntries(Object.entries(second ?? {}).filter(([, v]) => v !== null && v !== undefined));
      const r = await opsRegistry.invoke({ by: 'human', via: 'ui', local }, id, input, { ...opsDeps(locale.lang), scanLock: wsScanLock });
      return r.ok ? reply(true, await then(r.result)) : reply(false, r.error, r.code === FAILED ? undefined : r.code, r.issues ? { issues: r.issues } : undefined);
    };

    let releaseUpdateGate;
    try {
      releaseUpdateGate = updateGate.enter();
      switch (msg.command) {
        case 'listMcpConfig':
          return await viaOp('mcp.nativeList');
        case 'readMcpServer':
          return await viaOp('mcp.nativeRead');
        case 'saveMcpServer':
          return await viaOp('mcp.nativeSave');
        // ---- Pleiad 自身の MCP 登録と、その認証（担当が Pleiad のときに使う）。秘密の値は返さない
        case 'listPlyMcp':
          return await viaOp('mcp.list');
        case 'setPlyMcpSettings':
          return await viaOp('mcp.setSettings');
        case 'renamePlyMcp':
          return await viaOp('mcp.rename');
        case 'importPlyMcp':
          return await viaOp('mcp.import');
        case 'readPlyMcp':
          return await viaOp('mcp.read');
        case 'savePlyMcp':
          return await viaOp('mcp.save');
        case 'deletePlyMcp':
          return await viaOp('mcp.delete');
        case 'mcpAuthStart': {
          const name = msg.args?.name, definition = await plyMcp.registration(name);
          return reply(true, await mcpOAuth.start(name, definition, await plyMcp.connection(name, process.cwd())));
        }
        case 'mcpAuthStatus':
          return await viaOp('mcp.authStatus');
        case 'mcpAuthLogout': {
          const name = msg.args?.name, definition = await plyMcp.registration(name);
          return reply(true, await mcpOAuth.logout(name, definition, await plyMcp.connection(name, process.cwd()).catch(() => null)));
        }
        case 'mcpReconnect':
          return await viaOp('mcp.reconnect');
        case 'contextSettings':
          return await viaOp('context.settings');
        // 会話の文脈（context.session。ADR 0105）。突き合わせはこの接続の探索の錠の中（別のスキャンが走っていれば飛ばす）
        case 'sessionContext':
          return await viaOp('context.session');
        case 'plyInstructions':
          return await viaOp('context.plyInstructions');
        case 'setPlyInstructions':
          return await viaOp('context.setPlyInstructions');
        case 'refreshContext':
          return await viaOp('context.refresh');
        case 'contextDiff':
          return await viaOp('context.diff');
        // ---- git の動き（読み取りだけ。ADR 0085）。作業場所は会話の cwd。git が無い・git 管理外は git: null
        case 'gitStatus':
          return await viaOp('git.status');
        case 'gitPanel':
          return await viaOp('git.changes');
        case 'gitDiff':
          return await viaOp('git.diff');
        case 'gitHistory':
          return await viaOp('git.history');
        case 'gitCommit':
          return await viaOp('git.commit');
        case 'gitWorktrees':
          return await viaOp('git.worktrees');
        case 'gitWorktree':
          return await viaOp('git.worktree');
        // ---- worktree（ADR 0136）。ぶつかりの確認・明示的な作成・片付けの操作
        case 'worktreeCheck':
          return await viaOp('worktrees.check');
        // 作成・片付け・残す・退避・元に戻すは worktrees.*（core/ops/worktrees.mjs。AI も同じ操作を呼ぶ）
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
        case 'setSessionMcp':
          return await viaOp('context.setSessionMcp');
        case 'agentMcp':
          return await viaOp('context.agentMcp');
        case 'nativeInstructions':
          return await viaOp('context.nativeInstructions');
        case 'contextFindings':
          return await viaOp('context.findings');
        case 'setContextSettings':
          return await viaOp('context.setSettings');
        // ---- Hooks（各エージェントの元の設定ファイル。core/hooks-config.mjs）。コマンドは実行しない
        case 'scanHooks':
          return await viaOp('hooks.scan');
        case 'readHook':
          return viaOp('hooks.read');
        case 'hookTargets':
          return reply(true, await hooksConfig.targets(msg.args ?? {}));
        case 'saveHooks':
          return await viaOp('hooks.saveNative');
        case 'copyHooks':
          return await viaOp('hooks.copy');
        case 'sessionHooks':
          return await viaOp('hooks.session');
        // ---- Pleiad の Hooks の登録と担当（<data>/hooks.json。core/ply-hooks.mjs、ADR 0049）。エージェントの設定ファイルは書かない
        case 'plyHooks':
          return await viaOp('hooks.list');
        case 'readPlyHook':
          return viaOp('hooks.readPly');
        case 'savePlyHook':
          return await viaOp('hooks.save');
        case 'removePlyHook':
          return await viaOp('hooks.remove');
        case 'togglePlyHook':
          return await viaOp('hooks.toggle');
        case 'plyHookPreview': {
          // 追加・編集のシートの確認: エージェントごとの渡し方（イベント・matcher・アダプター・渡せない理由）。保存はしない
          const value = msg.args?.value ?? {};
          const hook = { ...value, targets: Array.isArray(value.targets) ? value.targets : [], matcher: value.matcher ?? '' };
          return reply(true, { targets: Object.fromEntries(HOOK_AGENTS.map(a => { const d = hook.targets.includes(a) ? deliverable(hook, a) : null;
            return [a, d ? { status: d.status, reasons: d.reasons, warnings: d.warnings ?? [], event: d.event, matcher: d.matcher, adapter: d.adapter } : null]; })) });
        }
        case 'hooksUnifyPreview':
          return await viaOp('hooks.unifyPreview');
        case 'setHooksOwner':
          return await viaOp('hooks.setOwner');
        case 'repairPlyHooks':
          return await viaOp('hooks.repair');
        // 探索は接続ごとに 1 つずつ（context.scan・context.skills。ADR 0105）。走っている間の 2 つ目は SCAN_BUSY
        case 'scanContext':
          return await viaOp('context.scan');
        case 'slashSkills':
          return await viaOp('context.skills');
        case "listSessions":
          return viaOp('sessions.list', args);

        // リモート（ホスト側）。秘密・トークンは返さない（core/remote/connector.mjs）
        case 'remoteStatus':
          return await viaOp('remote.status');
        case 'setRemoteSettings':
          return reply(true, withResident(await remote.setSettings(msg.args ?? {})));
        case 'setRemoteResident':
          return await viaOp('remote.setResident');
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
          return await viaOp('notify.status');
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
        // この端末の AI からの委譲を受けるか・任された作業をすべて止める（人だけ。docs/remote.md §4.5、ADR 0146）
        case 'setRemoteDeviceAgent': {
          const a = msg.args ?? {};
          // 入れるのはホストの PC の画面だけ（中継越しの端末の画面からは入れられない。両側の許可を片側の判断で崩さない。ADR 0146）。切る・すべて止めるは端末の画面からもできる
          if (a.enabled === true && connectionDevices.get(ws)) return reply(false, t('remote.agent.hostScreenOnly'));
          return reply(true, await remote.setDeviceAgent(a.id, { ...(a.enabled !== undefined ? { enabled: a.enabled === true } : {}), ...(a.stopAll === true ? { stopAll: true } : {}) }));
        }

        // Claude のアカウント（会話ごとに選ぶ）。トークンは返さない（登録済みかどうかだけ）
        // 互換の接続先（core/compat-endpoints.mjs）。キーは返さない。確認の失敗は例外ではなく { ok: false, error, lines } で返す（理由の行を画面に出すため）
        case 'compatEndpoints':
          return await viaOp('endpoints.list');
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
        case 'providerUsage':
          return viaOp('delegation.usage', args);
        case "backends":
          return viaOp('agents.list', args);

        case "setTurnSettings":
          return viaOp('sessions.setTurnSettings', args);

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
          await store.setSessionData(sessionId, "draft", { text, attached: files, ...(Number.isInteger(version) ? { version } : {}) }, { durable: true });
          if ((await store.get(sessionId)).unsent && typeof msg.args?.cwd === "string") {
            await store.setMeta(sessionId, { cwd: msg.args.cwd });
          }
          return reply(true, "saved");
        }

        case "deleteUnsentSession":
          return viaOp('sessions.deleteUnsent', args, { shape: () => "deleted" });
        case "deleteSession":
          return viaOp('sessions.delete', args, { shape: () => "deleted" });

        // エージェントの切り替え（sessions.switchBackend。ADR 0105）
        case "switchBackend":
          return await viaOp('sessions.switchBackend');

        case "runTurn":
          await runTurn(msg.args ?? {}, () => reply(true, "started"));
          return;
        case 'sendMessage': {
          const { sessionId, messageId, prompt, attachments, cwd, mode, rewind } = msg.args ?? {};
          if (!sessionId || !refuseRetired(await resolveBackendForSession(sessionId))) throw new Error(t('session.notFound'));
          if (typeof messageId !== 'string' || !/^[a-zA-Z0-9-]{8,80}$/.test(messageId)) throw new Error(t('send.messageIdRequired'));
          if (typeof prompt !== 'string' || !prompt.trim()) throw new Error(t('send.messageRequired'));
          if (attachments !== undefined && !Array.isArray(attachments)) throw new Error(t('send.invalidAttachments'));
          // 同じ会話の中で、発言の手前まで巻き戻して送り直す（ADR 0102）。{ beforeMessageId, stopRunning? }
          if (rewind !== undefined && (typeof rewind?.beforeMessageId !== 'string' || !rewind.beforeMessageId)) throw new Error(t('rewind.invalid'));
          const args = { prompt, ...(attachments ? { attachments } : {}), ...(cwd ? { cwd } : {}), ...(mode ? { mode } : {}) };
          return reply(true, await acceptMessage(sessionId, messageId, args, { rewind }));
        }
        // 入力欄の `!`（シェルの行。ADR 0054）。人の操作なので承認モードは掛けない。送信待ちにも送り直しの控えにも積まない
        case 'runShell':
          return await viaOp('shell.run');
        case 'stopShell':
          return await viaOp('shell.stop');
        // 行ごとの「渡さない」（ADR 0055）
        case 'skipShell':
          return await viaOp('shell.skip');
        case 'compactConversation':
          return viaOp('sessions.compact', args);
        case 'cancelCompaction':
          return viaOp('sessions.cancelCompaction', args);
        case 'setConversationAutoCompaction':
          return viaOp('sessions.setAutoCompaction', args);
        case 'messageAction':
          return viaOp('sessions.messageAction', args);
        case 'listMessages':
          return viaOp('sessions.listMessages', args);

        // { sessionId?, reason? }。sessionId を省略したら全部止める。reason は user|update|quit（ほかは user）。操作では reason は理由の文で、この種類は kind
        case "abort":
          return viaOp('sessions.abort', { sessionId: args?.sessionId, kind: ['user', 'update', 'quit'].includes(args?.reason) ? args.reason : undefined });

        // 中断した会話を続ける（docs/design.md「中断と再開」）。{ sessionId } -> { sent: "outbox"|"text", count }
        case "resume":
          return viaOp('sessions.resume', args);

        case 'agentTasks':
          return viaOp('delegation.tasks', { parentSessionId: args?.sessionId, tree: args?.tree, taskIds: args?.taskIds });
        case 'agentTaskInstructions':
          return viaOp('delegation.instructions', args);
        case 'cancelAgentTask':
          return viaOp('delegation.taskCancel', args);
        // 委譲カードの「別の候補でやり直す」。{ taskId, candidate, stop?, approved? } -> { task } か、承認モードが強くなるときは { confirm }
        case 'retryAgentTask':
          return viaOp('delegation.retry', args);

        // 委譲先の自動振り分けの設定（設定 › 委譲）。タスクごとの振り分けの記録は agentTasks の各行の routing。
        // キーは返さない（hasKey だけ）。refresh: true なら使用量を取り直してから返す
        case 'delegationRouting':
          return viaOp('delegation.routing', args);
        // settings は prefs.json の delegationRouting に重ねる項目（null の項目は既定に戻す）。全体を検証してから保存する（settings.set の delegationRouting と同じ定義）
        case 'setDelegationRouting':
          return viaOp('settings.set', { key: 'delegationRouting', value: args?.settings }, { shape: () => delegationRoutingState() });
        // API キー（設定 › API キー。ADR 0155）。値は返さない。入れる・消す・割り当てるのは人だけ（HUMAN_ONLY の秘密の値）。
        // 登録しただけでは送らない。送り始めるのは、通話・判定器に使うキーを選んだとき（setApiKeyUse）と、接続先で選んだとき（compatEndpointSave の keyRef）
        case 'setApiKey': {
          const a = msg.args ?? {};
          return reply(true, a.id ? await apiKeys.replace(String(a.id), a.key) : await apiKeys.add({ provider: a.provider, label: a.label, key: a.key }));
        }
        case 'deleteApiKey':
          return reply(true, await apiKeys.remove(String(msg.args?.id ?? '')));
        // { use: voice | judge:jev | judge:cerebras, id: キーの id | null（使わない）}
        case 'setApiKeyUse':
          return reply(true, await apiKeys.setUse(String(msg.args?.use ?? ''), msg.args?.id ?? null));
        // 移行の案内。{ keep: キーの id }（ほかの同じプロバイダーのキーをまとめる）か { keep: null }（このままにする）。どちらでも案内は二度と出ない
        case 'resolveApiKeyGuide':
          return reply(true, await apiKeys.resolveGuide(msg.args?.keep ?? null));
        // 古い版の口（判定器・通話のキー）。設定 › API キーへ移した後の互換で、同じ値のキーがあればそれを、無ければ登録して、使うキーに選ぶ。後片付けで外す（ADR 0155）
        case 'setDelegationRoutingKey':
        case 'deleteDelegationRoutingKey': {
          const service = String(msg.args?.service ?? '');
          if (!ROUTING_SERVICES.includes(service)) throw new Error(t('routing.key.unknownService', { service }));
          const key = msg.command === 'setDelegationRoutingKey' ? normalizeKey(msg.args?.key) : null;
          if (msg.command === 'setDelegationRoutingKey' && !key) throw new Error(t('routing.key.invalid'));
          await legacyUseKey(`judge:${ROUTING_JUDGE[service]}`, service, key);
          return reply(true, await delegationRoutingState());
        }
        case 'setVoiceKey':
        case 'deleteVoiceKey': {
          const key = msg.command === 'setVoiceKey' ? normalizeKey(msg.args?.key) : null;
          if (msg.command === 'setVoiceKey' && !key) throw new Error(t('voice.key.invalid'));
          await legacyUseKey('voice', 'openrouter', key);
          await voiceHost.keysChanged();
          emitGlobal({ type: 'voiceChanged', sessionId: null });
          return reply(true, { ...(await voiceHost.status()), ...(key ? { check: await voiceHost.checkKey() } : {}) });
        }
        case "resolvePermission": {
          const { id, allow, always, scope, message, messageKey, answers, annotations, response, receipt } = msg.args ?? {};
          const w = runtime.waiting.get(id);
          // 片付いた承認への答え。画面は失敗にせず、そのカードを「別の場所で処理されました」に畳む（code で見分ける）
          if (!w) return reply(false, t('approval.alreadyResolved'), 'ALREADY_RESOLVED');
          // ホストの子の承認の中継（この PC の会話のカード）。人の答えをホストへ運ぶ（受領証・1 回だけはホストが照合する。docs/remote.md §4.5）。
          // この道は画面（human）の WS のこの処理だけ。AI の道具（MCP・CLI・ply_task_*）からは作れない
          if (w.remote) {
            const r = await remoteDelegation.answerCard(id, { allow: allow === true, message: typeof message === 'string' ? message : null, answers, annotations, response });
            if (r.ok) return reply(true, 'ok');
            return reply(false, r.code === 'OFFLINE' ? t('approval.remoteOffline', { host: w.remote.hostName }) : t('approval.alreadyResolved'), r.code);
          }
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
          if (a.visible === true && typeof a.sessionId === 'string' && a.sessionId) {
            pushNotifier.viewed(a.sessionId);
            // 開いて見た会話の通知（あなた待ち・完了・失敗）は既読にする（ADR 0149）
            try { inbox.viewSession(a.sessionId); } catch (e) { console.error('  通知の一覧: 既読にできなかった:', String(e?.message ?? e)); }
          }
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
            // 送信予定で送った発言には、予定の時刻を付ける（画面は遅れて送ったものにだけ「9:00 の予定を 9:32 に送りました」を出す）
            if (!msg.args?.outline) data.messages = decorateScheduled(data.messages, sidecar.scheduledSends);
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
        case "newSession":
          return viaOp('sessions.new', args);

        // 既出の状態一覧。事前定義ではなく補完候補（設計メモ §6）。
        case "listStatuses":
          return viaOp('statuses.list', args);

        case "modes":
          return viaOp('agents.modes', args);
        case "efforts":
          return viaOp('agents.efforts', args);
        case "models":
          return viaOp('agents.models', args);
        // 作業ディレクトリを選ぶ簡易ブラウザー（ブラウザー版の入力欄）。フォルダーの名前だけを返す
        // files は true のときだけ（ほかの値はファイルを付けない。今までどおり）
        case "listDirs":
          return await viaOp('files.listDirs', { path: msg.args?.path, files: msg.args?.files === true });


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
            // エージェントのブラウザー（PC の Chrome）への接続の入口。ホストの PC の画面だけ。Electron の無いホストは false、OS の層が使えなければ 'unsupported'
            chromeBrowser: local && chromeConnection ? (chromeConnection.state().state === 'unsupported' ? 'unsupported' : 'available') : false,
            computerUse: computerUseCapability({ hasParentPort: Boolean(computerDriver), platform: computerDriver?.kind === 'fake' ? 'win32' : undefined, ready: computerDriver?.state() ?? null }) });
        // コンピューターの操作を止める（docs/computer-use.md「computerStop」）。ホストの OS を操作する命令ではなく、止める側なので、リモートの端末からも受ける（computer.stop）
        case "computerStop":
          return viaOp('computer.stop');
        // エージェントのブラウザー（PC の Chrome）への接続。つなぐ・切る・前に出すはホストの PC の画面だけ（browser.chrome*。ops が断る）
        case 'chromeStatus': return viaOp('browser.chromeStatus');
        case 'chromeConnect': return viaOp('browser.chromeConnect');
        case 'chromeDisconnect': return viaOp('browser.chromeDisconnect');
        case 'chromeRaiseDialog': return viaOp('browser.chromeRaiseDialog');
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
        case "authStatus":
          return viaOp('agents.authStatus', args);

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
          return viaOp('app.running', args);

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
        // 設定 › 自動圧縮。settings.set の compaction.auto と同じ定義を通る
        case 'setAutoCompaction':
          return viaOp('settings.set', { key: 'compaction.auto', value: args?.settings }, { shape: (r) => r.value });

        /**
         * AI にタイトルを考えてもらう。
         * 会話の中身を見て決めるので、走っているターンとは別に小さく1本立てる。
         * 生成はエージェントの仕事、整形（前後の記号を落とす）はここ。
         */
        case "suggestTitle":
          return viaOp('sessions.suggestTitle', args);

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
        // 貼り付けた HTML の画像（https）をホストが取りに行く（ADR 0141）。取れなければ失敗（画面は理由を出さず、札を静かに外す）
        case "attachImport":
          return await viaOp('attachments.importImage');
        case "attachImportCancel":
          return await viaOp('attachments.cancelImport');
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
        case "renameStatus":
          return viaOp('statuses.rename', args);

        // 詳細の読み出しは停止から独立した操作。
        case "loadBackground":
          return await viaOp('sessions.background');

        // ターンの中断（abort）とは別に、裏の作業を1本止める。
        case "stopBackground":
          return await viaOp('sessions.stopBackground');

        // サブエージェントの会話を読む。表示に要る最小形へ落とす。
        case "loadSubagent":
          return await viaOp('sessions.readSubagent');

        // 会話の中の委譲ツールのカードから、それが生んだサブエージェントを引く（終わってターンの一覧から外れた子を開くため）
        case "findSubagent":
          return await viaOp('sessions.subagents');

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
          // 人間が選んだものを、次に新しく始めるときの既定にする（bot の会話のモードは、その会話だけのもの。既定にしない）
          if (!(await store.get(sessionId)).bot) await savePref("mode", mode, backend.id);
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
        // 1 件（{ sessionId, at }）は sessions.markRead。画面がまとめて送る形（{ reads: [[sessionId, at], …] }）は同じ markReads を直に通す
        case "markRead": {
          const a = msg.args ?? {};
          if (!Array.isArray(a.reads)) return viaOp('sessions.markRead', { sessionId: a.sessionId, at: a.at });
          return reply(true, { reads: await markReads(a.reads.slice(0, 5000)) });
        }

        // グループから外す / 戻す。まとまりは親子と状態から決まるので、覚えるのは「外した」ことだけ
        case "setGrouped":
          return await viaOp('sessions.setGrouped');

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
        case "lineage":
          return viaOp('sessions.lineage', args);

        // 会話の変更の記録（時刻・誰が・前 → 後・理由）。脇の会話の行の「変更の記録」が読む
        case "sessionChanges":
          return viaOp('sessions.changes', args);

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

mainPort.on("message", async ({ data }) => {
  if (data?.type === 'wake') { await schedule.check(); await recoverLimitResumes().catch(() => {}); }
  if (data?.type === 'update-lock') {
    // 断るときは何が止めているかを返す。画面に出さないと、見た目に何も動いていないのに更新できない理由が分からない
    const reason = runtime.turns.size ? t('updateLock.turns', { count: runtime.turns.size })
      : blockingWaits().length ? t('updateLock.approvals', { count: blockingWaits().length })
      : agentTasks.busy ? t('updateLock.delegation')
      : outbox.busy ? t('updateLock.steer')
      : switching.size || forking.size ? t('updateLock.switching')
      : null;
    const ok = updateGate.acquire(Boolean(reason));
    mainPort.postMessage({ type: 'update-lock', id: data.id, ok, reason: ok ? null : reason || t('updateLock.other') });
  }
  if (data?.type === 'update-unlock') updateGate.release();
  // 引き継ぎ（無停止の更新 2d。core/handover.mjs）: 保持役に載ったターンを新しいサーバーへ渡して終わる
  if (data?.type === 'handover') void handoverToNext(data);
  // main がこれから離れる（更新のためなど）。切れた後に作業が無いまま居続ける上限が決まる（core/orphan-guard.mjs）
  if (data?.type === 'main-leaving') orphanGuard?.leaving(data.reason);
  // 更新を取りやめた（インストーラーが起きなかった・失敗した）。main は居続けるので、猶予を数える状態と切断の上限を元に戻す
  if (data?.type === 'main-leaving-cancel') orphanGuard?.leavingCancelled();
  if (data?.type === "running") mainPort.postMessage({ type: "running", work: await runningWork() });
  // デスクトップの「中断して終了」（desktop/main.cjs の closeSafely）。全部を reason 付きで止める。
  // main は running の count が 0 になるのを待ってから終了する
  if (data?.type === 'abort') {
    const result = await abortSessions({ reason: data.reason }).catch(err => ({ error: String(err?.message ?? err) }));
    mainPort.postMessage({ type: 'abort', id: data.id, ...result });
  }
  if (data?.type === "shutdown") {
    void voiceHost.close();   // 通話の使用量の台帳を書き切る
    // Chrome に許可の確認を残して終わらない（確認が出ていれば閉じる）。main の返事を待つので、長くても 2 秒まで
    chromeRelay?.close();
    if (chromeConnection) await Promise.race([chromeConnection.close(), new Promise(resolve => setTimeout(resolve, 2000))]).catch(() => {});
    try { finishShutdown(store.flushNow, () => runtime.turns.size > 0 || agentTasks.busy); }
    catch (e) {
      console.error('session store shutdown save failed:', e?.code ?? e?.message ?? e);
      process.exitCode = 1;
    }
  }
});

// 名前付きパイプの main が居ないまま長く居続けない（utilityProcess は main と一緒に終わるので要らない）。作業が 0 件のまま上限を過ぎたら、shutdown と同じに終わる
const orphanGuard = mainLink ? createOrphanGuard({
  isBusy: async () => (await runningWork()).count > 0,
  onExpire: () => {
    try { finishShutdown(store.flushNow, () => false); }
    catch (e) { console.error('session store shutdown save failed:', e?.code ?? e?.message ?? e); process.exit(1); }
  },
  log: line => console.log(`  [main-link] ${line}`),
}) : null;
mainPort.on('disconnect', () => orphanGuard?.disconnected());
orphanGuard?.disconnected();   // 起こした main が最初につながる前に落ちても、居続けない（最初のつながりで connected になる）
let readyMessage = null;
mainAway.onStay(() => restartGrace());
mainAway.onBack(({ first }) => {
  // 付け直した main へ、言語を送り直す。居ない間に過ぎた予定（送信・上限の解除後の再開）は、wake と同じに確かめる（powerMonitor の resume は届かなかった）
  mainPort.postMessage({ type: 'locale', locale: locale.lang });
  if (!first) { void Promise.resolve(schedule.check()).catch(() => {}); void recoverLimitResumes().catch(() => {}); }
  restartGrace();
});
mainPort.on('connect', () => {
  orphanGuard?.connected();
  if (readyMessage) mainPort.postMessage(readyMessage);
  // 付いた main は常駐の状態を持っていない。同じ内容でも送り直す
  residentLast = '';
  void postResident();
});

async function announce() {
  const { port } = server.address();
  // CLI がつなぎ先を見つける control.json（ADR 0083）。権限 0600。終了時に pid が自分のときだけ消す。
  // 起動の案内（下の URL の行）を見て CLI や検査が動き出すので、その前に書き終える
  // main とのパイプは、control.json に名前を書く前に立てる（main-link.json の秘密も一緒に書く）
  const link = await mainLink?.listen().catch(err => { console.error('  main とのパイプを立てられませんでした:', String(err?.message ?? err)); return null; });
  await writeControlFile({ dataDir: store.dataDir, origin: localOrigin(), cliToken: CLI_TOKEN, startedAt: SERVER_STARTED_AT, appVersion: APP_VERSION, kind: mainPort.hosted ? 'desktop' : 'server',
    ...(link ? { mainLink: link } : {}) })
    .catch((err) => console.error('  control.json を書けませんでした:', String(err?.message ?? err)));
  // パイプの口は、main がつながるのが ready より後になりうる。つながるたびに最新の ready を送る
  // appVersion・build・runtimeKey は、付け直した新しい main が版を比べて切り替える・前の版へ戻すのに使う（desktop/switch.cjs）
  readyMessage = { type: "ready", port, token: TOKEN, locale: locale.lang, pid: process.pid, appVersion: APP_VERSION, build: BUILD, runtimeKey: BOOT_ENV.AGENT_HOST_RUNTIME_KEY || null,
    ...(HANDOVER_START ? { handover: { lockWaitedMs: handoverLockWaitedMs, adopted: adopting.length, at: Date.now() } } : {}) };
  if (HANDOVER_START) console.log(`  [handover] listening at=${Date.now()} (the data lock came ${handoverLockWaitedMs} ms after the start; adopting ${adopting.length} turn(s))`);
  mainPort.postMessage(readyMessage);
  remote.start().catch(() => {});
  if (routingSettingsCache.enabled && ROUTING_USAGE_AUTO) routingUsage.start();
  // モデルの一覧を裏で引いておく。新しい会話・モデル選択が、CLI を起こす 10 秒ほどを待たない。
  // 作業場所は新しい会話の既定（ホーム）。取れなければ一覧の要求のときにまた引く（テストは ROUTING_USAGE_AUTO=off で起こさない）
  if (ROUTING_USAGE_AUTO) for (const b of listBackends()) if (b.warmModels && installation(b.id).installed) b.warmModels(os.homedir()).catch(() => {});
  // 起動直後の常駐の状態（リモートが無効でも送る。main はそれを見てトレイを出さない）
  if (mainPort.hosted) Promise.all([residentPrefs.loaded, remote.status(), runningWork()])
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
// 付け直すターンがあるときは、固定のポートが塞がっていても空きポートへ移らず取れるまで待つ（上限 ADOPT_PORT_WAIT_MS。旧サーバーがポートを手放すのを待つ）:
// 付け直したターンの MCP の口の URL はポートを含み、CLI が持っている URL は変えられない（stage2-server-state.md §3 の 9）。上限を過ぎたら付け直しをあきらめ
// （そのターンは restart の中断。adoptTurn の abandon）、これまでどおり空きポートへ移る
const ADOPT_PORT_WAIT_MS = Number(process.env.AGENT_HOST_ADOPT_PORT_WAIT_MS) >= 0 ? Number(process.env.AGENT_HOST_ADOPT_PORT_WAIT_MS) : 10_000;
const ADOPT_PORT_RETRY_MS = HANDOVER_START ? 40 : 200;   // 引き継ぎの起動は、旧サーバーがポートを放すのをすぐ拾う
let portDeadline = 0, portWaiting = false, adoptAbandoned = null;
// 引き継ぎの起動（--handover）も、旧サーバーが同じポートを放すのを待つ
const waitsForPort = () => adopting.length > 0 || (HANDOVER_START && PORT > 0);
const onListenError = (err) => {
  if (err.code !== "EACCES" && err.code !== "EADDRINUSE") throw err;
  if (waitsForPort() && Date.now() < portDeadline) {
    if (!portWaiting) console.log(`  port ${PORT} は使えない (${err.code})。${adopting.length ? '付け直すターンがある' : '引き継ぎの起動'}ので空くまで待つ（${ADOPT_PORT_WAIT_MS / 1000} 秒まで）。`);
    portWaiting = true;
    setTimeout(() => { server.once("error", onListenError); server.listen(PORT, HOST); }, ADOPT_PORT_RETRY_MS);
    return;
  }
  if (adopting.length) adoptAbandoned = `port ${PORT} is not available (${err.code})`;
  console.log(`  port ${PORT} は使えない (${err.code})。空きポートに切り替える。${adopting.length ? '付け直すターンは中断として残す。' : ''}`);
  // listen(port, host, cb) の cb は once("listening") として登録される。
  // 失敗しても外れないので、外してから張り直さないと起動メッセージが二重に出る。
  server.removeListener("listening", announce);
  server.listen(0, HOST, announce);
};
server.once("error", onListenError);
// 設定とバックエンドが揃った後に、前の起動の放置圧縮の予約を戻す
// 検索の写しは、起動の混み合いが落ち着いてから裏で作る（探されたときは待たずに読めた分で答える）
setTimeout(() => sessionSearch.start().catch(() => {}), 3000).unref();
await restoreCompactionSchedule().catch(err => console.error('  自動圧縮の予約を戻せませんでした:', String(err?.message ?? err)));
for (const [id, meta] of Object.entries(await store.getAll())) {
  // 止まったときと違うアカウント・エージェントを選んでいる会話は、止まった枠の待ちに入れない（recoverLimitResumes が自動再開を外す）
  if (meta.interrupted?.reason === 'limit' && !limitSwitched(meta, interruptedOf(meta.interrupted))) limitStates.set(id, interruptedOf(meta.interrupted));
}
// Restored sends can start a turn and use localOrigin(), which needs a bound port.
const listening = new Promise(resolve => server.once('listening', resolve));
portDeadline = Date.now() + ADOPT_PORT_WAIT_MS;
server.listen(PORT, HOST, announce);
await listening;
// 登録しておいた付け直すターンの口を開き直し、記録を流して締める（待たない。ターンが終わるまで続く）
for (const { card, source, ctx } of adopting) {
  const turnPromise = adoptTurn(card, source, ctx, { abandon: adoptAbandoned });
  void turnPromise.catch(err => console.error('  ターンの付け直しに失敗:', String(err?.message ?? err)));
  // 委譲の子は、結果の確定（execute の後半）を agentTasks へ引き継ぐ。付け直せなければ今までの起動と同じに interrupted にする
  if (ctx.taskId) adoptChild(ctx, turnPromise, { abandon: Boolean(adoptAbandoned) });
}
// 引き継ぎの起動: 旧サーバーが送信待ちに回した分（核心は core/handover.mjs の hold）を送る
if (HANDOVER_START) for (const [id, meta] of Object.entries(await store.getAll())) if (meta.outbox?.some(m => m.status === 'queued')) outbox.kick(id).catch(() => {});
await schedule.restore().catch(err => console.error('  再開の予定を戻せませんでした:', String(err?.message ?? err)));
// 解除時刻を過ぎた上限の会話は、予定の行が無くても再開する（Pleiad を閉じている間に過ぎた分）
await recoverLimitResumes().catch(err => console.error('  上限の会話を見直せませんでした:', String(err?.message ?? err)));
// 起動のときに過ぎていた送信予定の知らせは、リモートがつながってからでないと届かない。落ち着いたころにもう一度だけ確かめる
setTimeout(() => { for (const row of schedule.list()) if (row.kind === 'send' && row.held && !row.notified) notifyScheduleMissed(row); }, 15_000).unref();
// 届ける前の出来事の戻し・ルーティンの取りこぼし（ターンを始めるので、ポートが決まった後）
await botHost.start();

export { runTurn, prepareTurn, beginTurn, launchTurn, driveTurn, releaseTurn, endTurn, handOffTurn, restoreTurn, adoptTurn, handover as handoverState, trackIn };
