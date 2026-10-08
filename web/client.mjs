import { isComposingKey } from "./keyboard.mjs";
import { createCompletionNotifications } from './notifications.mjs';
import { setupFilePreview } from './file-preview.mjs';
import { browserPanelAvailable, createBrowserPanel } from './browser-panel.mjs';
import { isManagedContext, paintContextEntry as paintContextEntryButton, setupBrowserEntry, setupChromeEntry } from './header-entries.mjs';
import { setupChromePanel, createWindowTable } from './chrome-panel.mjs';
import { setupBrowserSettings } from './browser-settings.mjs';
import { setupComputerSettings } from './computer-settings.mjs';
import { configurePreviewConfirmation, refreshPreviewConfirmation } from './preview-confirm.mjs';
import { configureLinkOpen } from './link-open.mjs';
import { setupLinkMenu } from './link-menu.mjs';
import { download, notify, copyPathText } from './file-actions.mjs';
import { paintUserBody, userTools, attachmentImageSrc } from './user-message.mjs';
import { watchHostOnlyLinks } from './host-only-links.mjs';
import { linkChoices, showLinkSheet, hideLinkSheet, linkSheetOpen } from './link-sheet.mjs';
import { createRemoteBrowser } from './remote-browser.mjs';
import { fileDownloadUrl } from './file-reference.mjs';
import { setupCodeCopy, copyText } from './code-copy.mjs';
import { setupMessagePeek } from './message-peek.mjs';
import { actionButtons, copyToClipboard, messageMenuPlan, hoverless, setupMessageMenu, openSourceDialog, announce, writeClipboard } from './message-actions.mjs';
import { tailInfo, buildBand, resendKeys, sendGlyph } from './resend-band.mjs';
import { mountFold, revealFold } from './fold.mjs';
import { isSearchShortcut } from './session-find.mjs';
import { captureViewState, restoreViewState } from './view-state.mjs';
setupCodeCopy();
import { setupUpdates } from './updates.mjs';
import { setupSwitchNotice } from './switch-notice.mjs';
import { setupCliSetup } from './cli-setup.mjs';
import { setupRemoteBadge, remoteInfo } from './remote-badge.mjs';
import { setupUsage, createUsageSource } from './usage.mjs';
import { setupHeaderUsage } from './header-usage.mjs';
import { setupOnboarding } from "./onboarding.mjs";
import { setupClaudeAccounts } from './claude-accounts.mjs';
import { setupCompatEndpoints } from './compat-endpoints.mjs';
import { setupRemote } from './remote.mjs';
import { setupNotifySettings } from './notify-settings.mjs';
import { setupMobileNotify } from './mobile-notify.mjs';
import { createPresenceReporter } from './presence.mjs';
import { compatModelText } from './compat-models.mjs';
import { KIND_LABEL, CLAUDE_ROLES, lostText } from './compat-presets.mjs';
// host の UI。core とは WebSocket + protocolVersion で話す。
// 人間の操作と AI のツールは、経路が違っても同じ store・同じイベントを通る（設計メモ 2.2）。
// 見た目の規則は docs/design-system.md。
import { renderAssistantMarkdown, renderMarkdown, renderPresent, renderToolCall, applyToolResult, applyToolHints, plainTextHtml } from "./render.mjs";
import { Bundle, bundleOf, fadeIn, markRunning, markWaiting, splitToolCalls, swapHeight } from "./tool-bundle.mjs";
import { createContextMenu } from "./context-menu.mjs";
import { setupLongPress } from "./long-press.mjs";
import { whenText, timeText } from './schedule-times.mjs';
import { setupSendMenu } from './send-menu.mjs';
import { setupComposerControls, resolvedModel, folderBrowser, destinationUsage, modelChipLabel } from "./composer-controls.mjs";
import { createFolderUpload, canSendFolders, entriesFromDirectory, summarize, askDroppedFolder } from "./folder-upload.mjs";
import { setupAttachMenu } from "./attach-menu.mjs";
import { promptMaxHeight, attachSources, attachFolderHints } from "./composer-layout.mjs";
import { sendAttachment, ATTACH_MAX_BYTES, IMAGE_READ_HINT_BYTES } from "./attach-upload.mjs";
import { formatBytes } from "./folder-upload.mjs";
import { modelRowIds, modelDisplayName } from "./composer-labels.mjs";
import { setupSlashSkills } from "./slash-skills.mjs";
import { createMarkdownEditor } from "./md-editor.mjs";
import { attachedImageSrc } from "./composer/attachments.mjs";
import { createComposer, composerEls, rememberComposerTemplate } from "./composer/composer.mjs";
import { createHomeDest } from "./composer/home-dest.mjs";
import { createViewAddress, readAddress, toShowDetail } from "./view-address.mjs";
import { openAttachmentList } from "./attachment-list.mjs";
import { runMark, satMark, stillMark } from "./arc.mjs";
import { approvalTarget } from "./approval-summary.mjs";
import { isComputerTool, approvalApps, approvalBody, approvalHeading, approvalSaid, lockWaitBox, relayLabel } from "./computer-use.mjs";
import { approvalChange, changeBody, changeHeading, changeWord } from "./setting-change.mjs";
import { backgroundTitle, taskTree, backgroundTotals, groupByOwner, visibleRows } from './background-model.mjs';
import { hostViewCursor, joinHostView, hostTreeRows, mergeHostTree, hostRowStale, hostRowRunning, HOST_ROW_STALE_MS } from './host-view.mjs';
import { createCardRoll } from './card-roll.mjs';
import { mergeTasks, tasksToFetch, staleTasks, treeSessions } from './task-cards.mjs';
import { createBackgroundChip } from './background-chip.mjs';
import { overlaySessions, rollbackSessions, currentRows } from './pending-sidebar.mjs';
import { behindOfTasks, liveTasksOf } from './work-status.mjs';
import { isAutoRouting, routingLine, routingDetail, pinnedDetail, retryPanel, retryCandidates, splitCandidate, fallbackName, parseRoutingFailure, routingFailureParts, kindText, difficultyText } from './delegation-routing-view.mjs';
import { setupDelegationSettings } from './delegation-settings.mjs';
import { createSide, backendLogo } from "./side.mjs";
import { setupChannels } from "./channels/index.mjs";
import { setupVoice } from "./voice/index.mjs";
import { createVoiceDelivery } from "./voice/delivery.mjs";
import { createChatVoiceSender } from "./voice/chat-send.mjs";
import { setupVoiceSettings } from "./voice/settings.mjs";
import { setupApiKeysSettings } from "./api-keys-settings.mjs";
import { familiesOf } from "./family.mjs";
import { createBranches, commonPrefix, nodeKeys } from "./branches.mjs";
import { retainPlan, syncRequest, joinReply } from "./history-sync.mjs";
import { createHeightSettler } from "./history-heights.mjs";
import { makeBranchRow, layoutBranchSpine, motionDuration, EASING } from "./branch-view.mjs";
import { el, svgEl, icon, relTime, randomId, chevron } from "./dom.mjs";
import { t, fmt, lang as uiLang, applyDom, languageName, rememberLang } from "./i18n.mjs";
import { savedEvent, savedTitle } from "./saved-text.mjs";
import { buildItems, attachmentMessageIndex, attachmentLine, ATTACHMENT_LINE, normalizeAttachmentPath, inlineAttachments, showsAsCard } from "./timeline.mjs";
import { commandParts, sysFold, teammateNode, shellFailed, elapsedText as shellElapsed } from "./system-messages.mjs";
import { parseTaskNotice, parseSettingNotices } from "./task-notice.mjs";
import { createShellComposer } from "./shell-composer.mjs";
import { createSessionLoads } from "./session-stream.mjs";
const sessionLoads = createSessionLoads();
import { createReadCompletions } from "./unread.mjs";
import { isInterrupted, interruptUnread, interruptReadPoint, interruptLineText, reasonOf, stopMark, pausedCount, resumeLabel,
  resumeNoteText, resumeVisible, updateInterrupted, limitResumeState, limitLineNote, resumeShortLabel, versionReload } from './interrupt.mjs';
import { setupContext } from './context.mjs';
import { setupSessionContext, chipText } from './session-context.mjs';
import { budgetOf } from './instruction-amount.mjs';
import { renderOutbox } from './outbox.mjs';
import { visibleTaskInstructions } from './task-instructions.mjs';
import { openChangeLog } from './change-log.mjs';
import { mergeToolTurns } from './tool-turns.mjs';
import { streamMessages } from './stream-messages.mjs';
import { createComposerWait } from './composer-wait.mjs';
import { createConnectionStatus } from './connection-status.mjs';
import { attentionCounts, paintOpenSidebar } from './open-sidebar-mark.mjs';
import { setupNotificationInbox } from './notification-inbox.mjs';
import { createConversationNav } from './conversation-nav-view.mjs';
import { createConversationRail } from './conversation-rail.mjs';
import { createConversationToc } from './conversation-toc.mjs';
import { setupGitPanel } from './git-panel.mjs';
import { renderDelegateGit, branchLabel } from './git-view.mjs';
import { busyPlan, paintWorktreeLine, setWorktreeLineMode, askText, shortPath } from './worktree-ui.mjs';
import { branchIcon } from './icons.mjs';
const outboxes = new Map();
const turnErrorRows = new Map();
const submittingMessages = new Set();
// Persist the request ID before transport so an acknowledgement lost on reload
// can be reconciled with server acceptance instead of sending a second copy.
const receipts = new Map();
// 編集で入力欄へ戻した送信予定の時刻（sessionId -> 時刻）。送ると同じ時刻で予定し直し、チップの × で外せばふつうの送信になる
const armedSends = new Map();
let scheduleAttempt = null;   // 予定を置く応答が届かず送り直しても、同じ予定を二重に作らない
try {
  for (const [id, request] of JSON.parse(localStorage.getItem('ply-message-receipts') ?? '[]')) receipts.set(id, request);
} catch {}
function saveReceipts() {
  localStorage.setItem('ply-message-receipts', JSON.stringify([...receipts]));
}
function paintOutbox() {
  const id = state.current;
  const shown = new Set([...thread.querySelectorAll('.mw[data-message-id]')].map(w => w.dataset.messageId));
  renderOutbox($('outbox'), outboxes.get(id) ?? [], async (messageId, action) => {
    await cmd('messageAction', { sessionId: id, messageId, action });
  }, shown, { schedules: sendSchedules(id), scheduleActions });
  // 保留の件数で「再開」の字が変わる（renderSessions より先に届くこともある）
  syncResume();
}
/** この会話の送信予定（時刻順）。schedule.json の kind: 'send'（サーバーが持つので、どの端末からも同じ） */
const sendSchedules = (id) => (state.schedules ?? []).filter(r => r.kind === 'send' && r.sessionId === id).sort((a, b) => a.at - b.at);
/** 脇の行の印の材料（会話 -> { next: 次の時刻, missed: 送らず確かめを待っているものがあるか }） */
function sideSchedules() {
  const out = new Map();
  for (const r of state.schedules ?? []) {
    if (r.kind !== 'send') continue;
    const now = out.get(r.sessionId) ?? { next: null, missed: false };
    if (r.held) now.missed = true; else now.next = Math.min(now.next ?? Infinity, r.at);
    out.set(r.sessionId, now);
  }
  return out;
}
const scheduleActions = {
  now: async (entry) => { await limitOp('sessions.sendScheduledNow', { id: entry.id }); },
  cancel: async (entry) => { await limitOp('sessions.cancelSchedule', { id: entry.id }); },
  // 本文を入力欄へ戻す。取り出した予定は時刻が来ても動かず、送ると同じ時刻で予定し直す（時刻のチップ）
  edit: async (entry) => {
    const taken = await limitOp('sessions.cancelSchedule', { id: entry.id });
    if (taken?.entry) restoreScheduled(taken.entry);
  },
};
async function refreshSchedules() {
  state.schedules = await limitOp('sessions.schedules');
  if (state.current) paintOutbox();
  renderSessions();
  try { channelsUi.schedulesChanged(); } catch { /* 起動の途中 */ }
}
function restoreScheduled(entry) {
  if (state.current !== entry.sessionId) return;
  const prompt = entry.args?.prompt ?? '';
  const current = $('prompt').value;
  $('prompt').value = current.trim() ? `${prompt}\n\n${current}` : prompt;
  for (const a of entry.args?.attachments ?? []) {
    if (!attachedByPath(a.path)) state.attached.push({ path: a.path, name: a.name ?? shortPath(a.path), kind: 'file', mime: a.mime ?? '', from: 'host' });
  }
  armedSends.set(entry.sessionId, entry.at);
  renderAttached(); fitPrompt(); paintArmed();
  saveDraft().catch(() => {});
  $('prompt').focus();
}
/** 時刻のチップ「◷ 10/4（日）9:00 ×」と、入力欄の下の「送ると、〜の送信予定にし直します」 */
function paintArmed() {
  const at = armedSends.get(state.current);
  const chip = $('armedChip'), note = $('armedNote');
  const was = !chip.hidden;
  chip.hidden = !at;
  if (was !== Boolean(at)) controls.fit();
  if (!at) { if (note.dataset.armed) { note.hidden = true; delete note.dataset.armed; } return; }
  $('armedText').textContent = whenText(at);
  note.dataset.armed = '1';
  note.hidden = false; note.classList.remove('quiet');
  note.textContent = t('schedule.armedNoteEdit', { when: whenText(at) });
}
async function refreshOutbox(id) {
  const messages = await cmd('listMessages', { sessionId: id });
  outboxes.set(id, messages);
  if (state.current === id) syncOutboxRows(messages);
  return messages;
}

let readStorage;
try { readStorage = localStorage; } catch {}
// 確認済みはホストのもの（markRead / read イベント / 一覧の readAt）。どの窓・端末から見ても同じ（web/unread.mjs）
const readCompletions = createReadCompletions({ storage: readStorage, send: reads => cmd("markRead", { reads }) });
const displayedCompletions = new Map();
// 更新の知らせ（web/updates.mjs）。実行中の件数が変わったら脇の知らせの一行を描き直す。setupUpdates が下で入れる
let updatesUi = null;
// 更新の後、新しい版への切り替えを待っている間の知らせ（web/switch-notice.mjs）。main が渡す状態を描く。下で入れる
let switchUi = null;

const token = new URL(location.href).searchParams.get("token") ?? "";
const $ = (id) => document.getElementById(id);
const log = $("log");
const thread = $("thread");
setupMessagePeek(thread);   // タッチ: 発言を押すと時刻を 4 秒出す
// 静的な HTML の文言（data-i18n*）を今の言語で埋める。以降の処理が書き換える文言より先に済ませる
applyDom(document);
// 入力欄の骨組みを写しておく（スレッドの入力欄はこの写しから作る。web/composer/composer.mjs）
rememberComposerTemplate($("composer"));
// 「サイドバーを開く」の名前は件数を入れて書く（web/open-sidebar-mark.mjs）ので、HTML の data-i18n には置かない。一覧が届くまでは件数なし
paintOpenSidebar($("openSidebar"), {}, t);
// CSS の content: に出す文言。style.css・file-preview.css が var(--i18n-…) で読む（CSS に言語ごとの文言を持たない）
for (const [name, text] of [["untitled", t("session.untitled")], ["default", t("chat.model.default")], ["showing", ` ${t("app.previewShowing")}`]]) {
  document.documentElement.style.setProperty(`--i18n-${name}`, JSON.stringify(text));
}

// 入力欄（web/md-editor.mjs、ADR 0060）。Markdown をその場で整える編集欄。textarea と同じ窓口（value・selectionStart・placeholder…）を持つので、
// 以降のコードは今までどおり $("prompt").value などで触る。添付は字の間の 1 行の印（[添付] パス）が原子になり、実体の情報は state.attached、
// 送っている途中のものは uploads（仮の ID）が持つ。シェルの形の間は整形も文中の添付もしない（composerPlain）
let composerPlain = false, composerShellMode = null;
// 入力欄の部品（web/composer/composer.mjs）。字の欄・添付・書けない待ち・高さ・キー・送信の口を持つ。チップ・送信の日時・/・! は下で use〜 で差し込む。
// 添付の実体は state.attached に置き、持ち主は今の会話（作っている間は null）。書けない待ちの間は積まない（開いた会話の下書きで消されるか、
// 予約した送信に紛れる）。札の出入りだけでは下書きを保存しない（字の入力で保存される）。
// 書けない待ちは disabled ではなく readonly + aria-busy。初めて接続して会話を開くまでは「接続しています…」（その間に書いた字は、開いた会話の下書きで上書きされるため）
const chatComposer = createComposer({
  els: composerEls(""), t,
  attach: {
    host: { cmd: (command, args) => cmd(command, args), whenOnline: (err) => whenOnline(err), openImage: (src, name, path) => openLightbox(src, name, path),
      filePreview: { open: (...a) => filePreview.open(...a) } },
    owner: () => state.current ?? null,
    store: { get: () => state.attached, set: (items) => { state.attached = items; } },
    accepts: () => composerWait.accepts(),
    say: (text) => composerError(text),
    notify: (text) => notify(text),
    onChange: () => { saveDraft().catch(() => {}); },
    changeOnAtoms: false,
    onRender: () => syncRunState(),
    adopt: (owner, item) => adoptAttachment(owner, item),
    thumbnails: true,
    locale: () => composerAgentLang(),
  },
  isPlain: () => composerPlain,
  wait: { runMark, onChange: () => syncRunState() },
  // 入力欄の `!` と「/」の候補が開いている間は、その操作を先に取る（Ctrl+Enter は送信のまま）
  keys: [(e) => shellComposer.keydown(e), (e) => slashSkills.keydown(e)],
  onSubmit: () => submit(),
  onSchedule: () => sendMenu.open(),
});
const chatAttach = chatComposer.attach, composerEditor = chatComposer.editor, composerWait = chatComposer.wait;
// まだ送っていない会話の宛先（bot なし / bot）。bot を選んだ最初の送信は、一時チャットでその bot に話しかける投稿になる（sendToHomeBot）
const homeDest = createHomeDest({ invoke: (op, args) => cmd("invoke", { op, args }),
  visible: () => unsentHere(), onChange: () => { syncTopbar().catch(() => {}); } });
// 接続の状態（web/connection-status.mjs）。切れた一行は 1.5 秒続いてから、トークンが古いと分かったら案内に替えて再接続をやめる
const connStatus = createConnectionStatus({ note: $("connNote"), sideLine: $("connLost"), live: $("connLive"), t, runMark,
  time: (ms) => fmt.time(ms), check: checkToken, reconnect: () => connect(), onChange: () => syncRunState() });
// 作ったばかりで、いま select している会話の id。開き直しと違い入力欄が正本（saveDraft・送信の予約・送信ボタンが見る）
let freshSessionId = null;
// 新しい会話を作っている間に押された送信の予約（submit）。「取り消す」で null
let queuedSend = null;

const NL = String.fromCharCode(10);
const PROTOCOL = 3;
// この画面を配ったサーバーの版（サーバーが index.html に埋める。web/interrupt.mjs の versionReload）
const SERVED_BUILD = document.querySelector('meta[name="pleiad-build"]')?.content ?? "";
// この PC の通知（設定 › 通知 › この PC）。切った種類と、いま見ている会話は出さない（ADR 0086）
let notifyPc = { done: true, reply: true, failed: true };
// スマホのアプリの殻が背面に回っている間は、画面が可視でも見ていない（殻が plyremote:stop / plyremote:start を投げる）
let shellStopped = false;
const watchingNow = () => !shellStopped && document.visibilityState === 'visible';
const completionNotifications = createCompletionNotifications({ openSession: id => select(id),
  settings: () => notifyPc, isViewing: id => watchingNow() && state.current === id });

let ws = null;
let seq = 0;
const pending = new Map();

const state = {
  threadIndex: { threads: [], totals: {} },   // bot のスレッドの索引（channels.threads。脇の 2 つの並べ方）
  current: null,      // 選択中の sessionId（null = 新規）
  loadingSession: null,
  homeDir: "",
  serverStartedAt: null,   // サーバーの起動時刻（ready の startedAt）
  osActions: false,   // サーバーのある PC の画面から見ているか（エクスプローラー・ブラウザーで開くを出す）。hostCapabilities で知る
  draft: { status: null, cwd: "" },   // 新規セッションの予約（引き継いだ状態と作業ディレクトリ）。current が null のときだけ意味を持つ
  sessions: [],
  statuses: [],
  backends: [],       // 使えるエージェント [{id,label,capabilities,toolHints}]
  backendId: null,    // 新しいセッションを始めるときに使うエージェント
  vocab: new Map(),   // backendId -> { modes, models }。語彙はエージェントごとに違う
  modes: {},
  mode: "default",     // 次のターンに使う承認モード
  models: {},
  model: "",           // 次のターンに使うモデル（空 = 既定に従う）
  // 入力欄のチップ（web/composer-controls.mjs）が出す値。予約があれば予約の値
  cwd: "",             // 次のターンの作業ディレクトリ
  shownBackend: null,  // 次のターンのエージェント
  efforts: {},         // 選べるエフォートの段（core/effort.mjs の形。'' の resolvesTo が既定の段）
  effort: "",          // 次のターンのエフォート（空 = 既定に従う）
  effortDisabled: false,
  account: "",         // 次のターンの Claude のアカウント（空 = ログイン中のアカウント）
  accountShown: false, // アカウントの選択を出すか（登録が無く、選んでもいない会話には出さない）
  endpoint: "",        // 次のターンの互換の接続先（空 = 公式）。Claude Code・Codex だけ
  endpointShown: false, // 接続先の節を出すか（接続先を選べるエージェントのとき）
  prefs: {},           // 新しいセッションを始めるときの既定
  awaitingSession: false,  // 新規セッションの id 待ち（自分が送った直後だけ真）
  toolCards: new Map(),// tool_use_id -> 描いたカード（結果を後から差し込む）
  attached: [],        // 次の送信で渡す添付（{name, path, kind}）
  drafts: new Map(),   // 書きかけ: sessionId（新規は ""）-> { text, attached }
  askedFor: new Set(), // 一覧に無いセッションのために取り直した記録（取り直しの繰り返しを防ぐ）
  work: { count: 0, turns: [], permissions: [], subagents: [], background: [] },
  runningIds: new Set(),   // いま走っているセッション（サーバの running が正）
  stopping: new Set(),     // 中断を頼んだが、まだ止まり終えていないセッション（押した瞬間と、サーバの running の stopping）
  bgWaiting: new Map(),    // 裏を待っているセッション -> 待っている本数（running のターン行の phase と background が正）
  waitingIds: new Set(),   // 承認・回答を待っているセッション
  // 未解決の承認: id -> permission イベントの中身。会話を開き直すたびに描き直す材料。
  // running が載せるのは id と道具名だけなので、カードを組み立てられるのはこちらだけ
  pendingPerms: new Map(),
  // 会話ごとのコンピューター操作の状態（computer.state。running / waiting のものだけ。idle は消す）。waiting の行の表示に使う
  computerStates: new Map(),
  submitting: false,       // 新規セッションを送った直後（id が決まるまで）
  messages: [],        // 今のセッションの履歴（loadSession の messages）
  contextInfo: null,   // 今のセッションの読み込み記録（sessionContext の戻り）。タイトル行の入口と筋の一行に使う
  contextInfoId: null, // 上の記録がどのセッションのものか
  // worktree（ADR 0136）。worktreeCheck の結果（今の場所・作成できるか・同じリポジトリに書き込み中の別の会話）。
  // 「このまま元の場所で始める」を選んだ会話×場所は stay（今回だけ。メモリだけで、送ったら外す）
  worktree: { key: null, data: null, ticket: 0 },
  git: { key: null, sessionId: null, data: null },   // 作業場所の git の状態（gitStatus。ADR 0085）。頭の行のアイコン・入力欄のブランチ・「…」のメニューに使う
  presents: [],
  turnEl: null,        // 追記中の AI の発言（.m.ai）
  bundle: null,        // 走っているツールのまとまり（本文・委譲・ターンの終わりで閉じる。web/tool-bundle.mjs）
  pendingUuid: null,   // 見せるものが無いまま確定した発言（thinking だけ）の id。次に発言の入れ物を作るときに使う
  endedWithText: false, // 直前に確定した発言（text.end）が本文を持っていたか。本文の無いツールだけの発言が続くときは、発言もまとまりも閉じない
  turnClosed: false,   // text.end が来た。続くツール呼び出しは同じ発言に入り、次の本文は新しい発言になる
  streamEl: null,      // 追記中の本文
  thinkEl: null,       // 追記中の thinking 要素（平文が来たときだけ作る）
  thinkTokens: 0,
  auth: new Map(),         // backendId -> authStatus の戻り（{ supported, loggedIn, account?, detail?, pending? }）
  authUrl: new Map(),      // backendId -> { url, message } ログインの途中で出た URL
  busy: false,             // 枝の動きの最中。重ねて動かさない
  compactions: [],
  schedules: [],
  hostTimeZone: null,
  contextWindow: null,
  compactionAt: null,
  compactionPhase: null,
};

const compactNumber = n => `${Math.round(n / 1000)}k`;
const compactTime = at => new Date(at).toLocaleTimeString(uiLang, { hour: '2-digit', minute: '2-digit' });
function canCompactHere() { return Boolean(state.current && capsOf(activeBackendId()).compact && !retiredHere()); }
function closeMeterPop(focus = false) {
  $('contextMeterPop').hidden = true;
  $('contextMeter').setAttribute('aria-expanded', 'false');
  if (focus) $('contextMeter').focus();
}
/** 入力欄の上の帯の左（文脈）が描いたか。右端のバックグラウンドの入口（syncWorkEntry）と合わせて、帯ごと出すか決める */
let contextShown = false;
const stripNarrow = matchMedia('(max-width:480px)');
// 480px 以下: 頭に残すのは通話・目次・「…」だけ（プラグインと git は「…」の先頭）。docs/design-system.md「会話の頭の行のアイコン」
const phoneView = stripNarrow;
function syncStripVisible() {
  const strip = $('contextStrip');
  strip.hidden = !contextShown && $('usageChip').hidden && $('workEntry').hidden;
  if (strip.hidden) closeMeterPop();
}
/** 狭い画面（480px 以下）は、メーターを「文脈 ▬ 30% · ◷ 17:57」に縮め、数値と予約のキャンセルはメニューの頭へ移す。圧縮中・失敗はメーターの位置に出す */
function paintContextStrip() {
  const usage = state.contextWindow;
  const show = Boolean(state.current && activeBackendId() !== 'antigravity' && (usage || state.compactionAt || state.compactionPhase));
  contextShown = show;
  const wrap = $('contextMeterWrap'), meter = $('contextMeter'), text = $('contextStripText'), status = $('contextStripStatus');
  if (!show) {
    wrap.hidden = true;
    text.textContent = '';
    for (const node of [...status.children]) if (node !== text) node.remove();
    $('contextStrip').removeAttribute('data-phase');
    syncStripVisible();
    return;
  }
  const narrow = stripNarrow.matches;
  const phase = state.compactionPhase?.phase === 'start' ? 'running' : state.compactionPhase?.phase === 'failed' ? 'failed' : state.compactionAt ? 'scheduled' : null;
  $('contextStrip').dataset.phase = phase ?? '';
  const time = state.compactionAt ? compactTime(state.compactionAt) : '';
  const amounts = usage ? { rate: Math.round(100 * usage.usedTokens / usage.windowTokens), used: compactNumber(usage.usedTokens), window: compactNumber(usage.windowTokens) } : null;
  // メーター: 文脈の使用量が分かるとき。狭い画面は予約だけでも出す（キャンセルの入口になる）。圧縮中・失敗は別の形に替わる
  const showMeter = Boolean((usage || (narrow && phase === 'scheduled')) && !(narrow && (phase === 'running' || phase === 'failed')));
  wrap.hidden = !showMeter;
  if (!showMeter) closeMeterPop();
  if (showMeter) {
    const spoken = [];
    const parts = [];
    let caret = null;
    if (usage) {
      const rate = Math.min(100, Math.max(0, amounts.rate));
      // 入力欄のチップと同じ ▾（composer-controls.mjs の CARET。12px の線画）
      caret = svgEl('svg', { class: 'i caret', viewBox: '0 0 24 24', 'aria-hidden': 'true' }); caret.append(svgEl('path', { d: 'M7 10l5 5 5-5' }));
      const bar = el('span', 'context-meter-bar'); const fill = el('span'); fill.style.width = `${rate}%`; bar.append(fill);
      parts.push(document.createTextNode(t('compaction.context')), bar,
        document.createTextNode(narrow ? t('compaction.meterShort', { rate: amounts.rate }) : t('compaction.meter', amounts)));
      spoken.push(t('compaction.meterLabel', amounts));
    }
    if (phase === 'scheduled') {
      if (narrow) {
        if (usage) parts.push(el('span', 'context-meter-sep', '·'));
        parts.push(el('span', 'context-meter-clock', t('compaction.scheduledShort', { time })));
      }
      spoken.push(t('compaction.scheduledSpoken', { time }));
    }
    spoken.push(t('compaction.openActions'));
    if (caret) parts.push(caret);   // 480px 以下は compaction.css が隠す
    meter.replaceChildren(...parts);
    meter.setAttribute('aria-label', spoken.join(t('compaction.spokenJoin')));
    paintMeterMenu(narrow, amounts, time, phase === 'scheduled');
  }
  // 状態の文（role=status は文だけ。ボタンの名前を状態として読ませない）
  for (const node of [...status.children]) if (node !== text) node.remove();
  const action = (label, run) => { const button = el('button', null, label); button.type = 'button'; button.onclick = run; status.append(button); };
  text.replaceChildren();
  const failed = state.compactionPhase?.phase === 'failed' ? state.compactionPhase : null;
  if (phase === 'running') {
    if (narrow) text.append(runMark(), t('compaction.runningShort'));
    else text.append(t('compaction.running'));
  } else if (phase === 'failed') {
    if (narrow) {
      const warn = svgEl('svg', { class: 'i', viewBox: '0 0 24 24', 'aria-hidden': 'true' }); warn.append(svgEl('path', { d: 'M12 4l9 16H3z' }), svgEl('path', { d: 'M12 10v4' }), svgEl('path', { d: 'M12 17h.01' }));
      text.append(warn, t('compaction.failedShort'));
    } else text.append(t('compaction.failed'));
    text.title = failed.reason ?? '';
    if (canCompactHere()) action(t('compaction.retry'), () => requestCompaction());
    if (failed.reason && !narrow) status.append(el('small', null, failed.reason));
  } else if (phase === 'scheduled' && !narrow) {
    text.append(t('compaction.scheduled', { time }));
    action(t('compaction.cancel'), cancelScheduledCompaction);
  }
  if (phase !== 'failed') text.removeAttribute('title');
  syncStripVisible();
}
function cancelScheduledCompaction() { closeMeterPop(); cmd('cancelCompaction', { sessionId: state.current }).catch(showCompactionError); }
/** メーターのメニューの頭（狭い画面だけ）: 数値と予約、予約のキャンセル。開いている間に描き直しても、中身が同じなら触らない */
function paintMeterMenu(narrow, amounts, time, scheduled) {
  const pop = $('contextMeterPop');
  let head = pop.querySelector(':scope > .head');
  let cancel = pop.querySelector(':scope > .meter-cancel');
  if (!narrow) { head?.remove(); cancel?.remove(); return; }
  const headText = [amounts ? t('compaction.menuTokens', amounts) : '', scheduled ? t('compaction.scheduled', { time }) : ''].filter(Boolean).join(' · ');
  if (!head) { head = el('div', 'head wrap'); head.setAttribute('role', 'presentation'); pop.prepend(head); }
  if (head.textContent !== headText) head.textContent = headText;
  head.hidden = !headText;
  const label = scheduled ? t('compaction.cancelAt', { time }) : '';
  if (scheduled) {
    if (!cancel) {
      cancel = el('button', 'li meter-cancel'); cancel.type = 'button'; cancel.setAttribute('role', 'menuitem');
      cancel.onclick = cancelScheduledCompaction;
      head.after(cancel);
    }
    if (cancel.textContent !== label) cancel.textContent = label;
  } else cancel?.remove();
}
stripNarrow.addEventListener('change', () => { paintContextStrip(); paintMoreEntry(); });
function showCompactionError(error) { state.compactionPhase = { phase: 'failed', reason: String(error?.message ?? error) }; paintContextStrip(); }
async function showRowCompactionError(session, error, setting = false) {
  // i18n-dynamic: compaction.settingFailed
  // i18n-dynamic: compaction.otherConversationFailed
  if (state.current !== session.id) {
    try { await select(session.id); } catch { /* Keep the error visible even if this conversation cannot be opened. */ }
  }
  if (state.current === session.id) {
    if (setting) sys(tHtml('compaction.settingFailed', { error: String(error?.message ?? error) }));
    else showCompactionError(error);
  } else {
    sys(tHtml('compaction.otherConversationFailed', { title: sessionLabel(session.id), error: String(error?.message ?? error) }));
  }
}
function requestCompaction() {
  if (!canCompactHere()) return;
  closeMeterPop();
  cmd('compactConversation', { sessionId: state.current }).catch(showCompactionError);
}
function compactionBoundary(entry) {
  const m = el('div', 'm compaction-boundary');
  const line = el('div', 'boundary-line');
  // i18n-dynamic: compaction.done compaction.doneAuto
  line.append(el('strong', null, t(entry.phase === 'failed' ? "compaction.failed" : entry.trigger === 'manual' ? "compaction.done" : "compaction.doneAuto")));
  if (entry.phase === 'complete' && Number.isFinite(entry.beforeTokens) && Number.isFinite(entry.afterTokens))
    line.append(el('span', 'boundary-tokens', t('compaction.tokenChange', { before: compactNumber(entry.beforeTokens), after: compactNumber(entry.afterTokens) })));
  if (entry.phase === 'failed' && canCompactHere()) {
    const retry = el('button', null, t('compaction.retry')); retry.type = 'button'; retry.onclick = requestCompaction; line.append(retry);
  }
  m.append(line);
  if (entry.phase === 'failed' && entry.reason) m.append(el('small', null, entry.reason));
  if (entry.phase === 'complete' && entry.summary) {
    const details = el('details'); details.append(el('summary', null, t('compaction.showSummary')), el('div', 'summary-body', entry.summary)); m.append(details);
  }
  return m;
}
function paintCompactions() {
  // 作り直しても、開いていた「要約を表示」は開いたままにする
  const open = new Set();
  for (const old of thread.querySelectorAll('.mw[data-compaction-id]')) {
    if (old.querySelector('details')?.open) open.add(old.dataset.compactionId);
    old.remove();
  }
  for (const entry of state.compactions) {
    if (!['complete', 'failed'].includes(entry.phase)) continue;
    const row = append(compactionBoundary(entry), `compaction:${entry.id}`);
    row.classList.add('compaction-boundary'); row.dataset.compactionId = entry.id;
    if (open.has(entry.id)) { const details = row.querySelector('details'); if (details) details.open = true; }
    const after = [...thread.querySelectorAll('.mw:not([data-compaction-id])')]
      .find(message => {
        const at = message.querySelector('.m[data-at]')?.dataset.at;
        return at && Date.parse(at) > entry.at;
      });
    after?.before(row);
    // 区切りの後ろの AI の発言は、前の発言の続き（見出しを省いた形）にしない。要約の行が間に無くなったので（ADR 0053）
    if (after?.classList.contains('cont')) {
      after.classList.replace('cont', 'node');
      after.querySelector(':scope .m.ai.cont')?.classList.remove('cont');
    }
  }
}
function acceptCompaction(event) {
  if (event.phase === 'start') state.compactionPhase = event;
  else if (event.phase === 'complete' || event.phase === 'failed') {
    state.compactionPhase = event.phase === 'failed' ? event : null;
    const index = state.compactions.findIndex(item => item.id === event.id);
    if (index >= 0) state.compactions[index] = event; else state.compactions.push(event);
    paintCompactions();
  }
  paintContextStrip();
}
function paintAutoCompactionSettings() {
  const settings = state.prefs.autoCompaction ?? { enabled: true, minTokens: 150_000, delegatedHeadroom: 100_000,
    claude: { enabled: true, delayMinutes: 50 }, codex: { enabled: false, delayMinutes: 25 } };
  $('autoCompactionEnabled').setAttribute('aria-checked', String(settings.enabled));
  $('autoCompactionMin').value = String(settings.minTokens / 1000);
  $('autoCompactionDelegated').value = String((settings.delegatedHeadroom ?? 100_000) / 1000);
  for (const id of ['claude', 'codex']) {
    const name = id[0].toUpperCase() + id.slice(1);
    $(`autoCompaction${name}`).setAttribute('aria-checked', String(settings[id].enabled));
    $(`autoCompaction${name}Delay`).value = String(settings[id].delayMinutes);
  }
}
async function saveAutoCompactionSettings() {
  const settings = { enabled: $('autoCompactionEnabled').getAttribute('aria-checked') === 'true',
    minTokens: Number($('autoCompactionMin').value) * 1000,
    delegatedHeadroom: Number($('autoCompactionDelegated').value) * 1000,
    claude: { enabled: $('autoCompactionClaude').getAttribute('aria-checked') === 'true', delayMinutes: Number($('autoCompactionClaudeDelay').value) },
    codex: { enabled: $('autoCompactionCodex').getAttribute('aria-checked') === 'true', delayMinutes: Number($('autoCompactionCodexDelay').value) } };
  try {
    const saved = await cmd('setAutoCompaction', { settings });
    state.prefs.autoCompaction = saved;
    $('autoCompactionError').textContent = '';
    paintAutoCompactionSettings();
  } catch (error) {
    $('autoCompactionError').textContent = t('compaction.saveFailed', { error: error.message });
    paintAutoCompactionSettings();
  }
}

// ---------------------------------------------------------------- 表示の下請け

const escText = (s) => {
  const n = document.createElement("span");
  n.textContent = String(s ?? "");
  return n.innerHTML;
};

const hhmm = (at) => {
  if (!at) return "";
  const d = new Date(at);
  return Number.isNaN(d.getTime()) ? "" : d.toTimeString().slice(0, 5);
};

/**
 * 発言の入れ物。左の溝（gutter）に筋の節、右に中身。枝の最小化・最大化はこの高さと位置を動かす。
 * 節は中身の箱の外にあるので、中身の overflow:hidden に切られない。
 */
function wrap(node, key) {
  const w = el("div", "mw");
  if (key) w.dataset.key = key;
  if (node.matches?.(".m:not(.sys):not(.cont):not(.activity)")) w.classList.add("node");
  if (node.matches?.(".m.cont")) w.classList.add("cont");
  if (node.matches?.(".m.card")) w.classList.add("card");
  if (node.matches?.(".m.activity")) w.classList.add("activity");
  const body = el("div", "mw-body");
  body.append(node);
  w.append(el("div", "mw-gutter"), body);
  return w;
}

const atBottom = () => log.scrollHeight - log.scrollTop - log.clientHeight < 40;

/**
 * 末尾へ送り、高さが落ち着くまで末尾に合わせ直す。画面の外の発言は仮の高さで並び（style.css の content-visibility）、
 * 末尾へ送ったあとに見えた分が本当の高さに伸びるので、1 回送るだけでは末尾から外れる。
 * 利用者がスクロールし始めたら（ホイール・タッチ・キー）そこでやめる
 */
let settling = null;
function scrollToEnd() {
  settling?.abort();
  const run = settling = new AbortController();
  log.scrollTop = log.scrollHeight;
  for (const type of ['wheel', 'touchstart', 'keydown', 'pointerdown']) log.addEventListener(type, () => run.abort(), { signal: run.signal, passive: true });
  let last = log.scrollHeight, calm = 0, frames = 0;
  const tick = () => {
    if (run.signal.aborted) return;
    if (++frames > 60) return run.abort();
    const height = log.scrollHeight;
    if (height !== last || !atBottom()) { log.scrollTop = height; last = height; calm = 0; }
    else if (++calm >= 3) return run.abort();
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

// 会話の移動（残る問い・最新へ。docs/design-system.md「会話の移動」）。末尾へ送るのは上の scrollToEnd（実寸の確定を待つ）
let navSession = null;   // 最新へのボタンの新着を数えている会話。替わったら数え直す（paintSession）
const navNarrow = matchMedia("(max-width:700px)");
const nav = createConversationNav({ frame: $("logFrame"), log, thread, scrollToEnd, isRunning: () => isRunningHere(), narrow: navNarrow });
createConversationRail({ frame: $("logFrame"), log, thread, nav, narrow: navNarrow });

/**
 * 筋の末尾に置く。稼働表示（走っている間だけある）は常に一番下に残す。
 * 稼働表示の行は activity.el が持っている。1 行ごとに筋の子孫を探すと、履歴を描く間が件数の 2 乗になる
 */
function place(w) {
  const act = activity.el?.isConnected ? activity.el.closest(".mw") : null;
  if (act && !w.classList.contains("activity")) act.before(w);
  else thread.append(w);
}

// 履歴をまとめて描く間は、1 件ごとに筋を貼り直さない。筋の位置と末尾の判定はレイアウトを読むので、
// 1 件ごとにやると件数の 2 乗でレイアウトが走り、大きな会話を開くのに数秒かかっていた。paintHistory が最後に 1 回貼る
let paintingHistory = false;

function append(node, key) {
  if (paintingHistory) { const w = wrap(node, key); place(w); return w; }
  const stick = !state.busy && atBottom();
  const w = wrap(node, key);
  place(w);
  relayoutBranches();
  if (stick) log.scrollTop = log.scrollHeight;
  return w;
}

/** 出来事の一行。筋の節は持たない。html はこちらで組み立てた文字列だけ（中身は escText 済み） */
function sys(html) {
  const m = el("div", "m sys");
  m.innerHTML = html;
  append(m);
  return m;
}

/**
 * 操作の失敗・知らせは会話の流れに入れない（ADR 0067）。会話の中の出来事の行（sys）は、その会話のターンの失敗・履歴を読めない・
 * 圧縮と接続の問題のように、会話そのものの出来事だけにする。
 * 脇の行・メニューからの操作は脇の帯（side.showUndo。失敗は再試行の無い形）へ、入力欄・メッセージ・タイトルからの操作は入力欄の上のエラー行（#settingsError）へ、
 * ログインは設定の面（#setupError）へ出す
 */
const sideNote = (text, { failed = true } = {}) => side.showUndo(text, null, { retry: failed });
const composerError = (text) => { $("settingsError").textContent = text; };

/**
 * 訳文を sys() に渡す HTML にする。訳文も差し込みの値もエスケープし、bold に挙げた差し込みだけ <b> で包む。
 * 訳文と HTML を混ぜないため、差し込みは印に置き換えて訳してから、エスケープした値に戻す
 */
function tHtml(key, params = {}, bold = []) {
  const slots = [];
  const opts = {};
  for (const [k, v] of Object.entries(params)) {
    if (k === "count") { opts.count = v; continue; }   // 複数形の選択に使う数。数字だけなのでそのまま
    opts[k] = `\u{E000}${slots.length}\u{E001}`;
    slots.push(bold.includes(k) ? `<b>${escText(v)}</b>` : escText(v));
  }
  return escText(t(key, opts)).replace(/\u{E000}(\d+)\u{E001}/gu, (_, i) => slots[Number(i)]);
}
/** sys(html.t('キー', 差し込み, 太字にする差し込み))。.t の形にしておくと tests/lint-i18n.mjs がキーを拾う */
const html = { t: tHtml };

/** markedHead() に渡す訳文の差し込み。{{mark}} の位置を示す */
const MARK = "\u{E000}";
/**
 * 見出しの一語だけを差し色にする（承認・質問のカード。docs/design-system.md の差し色）。
 * text は t(キー, { mark: MARK }) の結果。{{mark}} の位置に差し色の語 mark を置き、前後の文は差し色にしない
 */
function markedHead(text, mark) {
  const [before = "", after = ""] = text.split(MARK);
  return [
    ...(before ? [el("span", "card-kind-rest", before)] : []),
    el("span", "card-kind", mark),
    ...(after ? [el("span", "card-kind-rest", after)] : []),
  ];
}

/**
 * 見ている位置の基準の発言（実寸の確定・再接続の読み直しで位置を保つのに使う）。#log の上端より少し下に下端がある最初の行を選ぶ。
 * 点で当てると、列（.thread の max-width）より #log が広い窓で列の外に落ちるので、行の並びから探す。
 * 行は上から順に並んでいるので二分探索にし、レイアウトを読むのは log2(件数) 回で済ませる。rows は上から並んだ全部の発言の行（省くと今の #thread から集める）
 */
function historyAnchor(rows = thread.querySelectorAll(':scope > .mw')) {
  const box = log.getBoundingClientRect();
  const line = box.top + Math.min(80, box.height / 3);
  let lo = 0, hi = rows.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (rows[mid].getBoundingClientRect().bottom > line) hi = mid; else lo = mid + 1;
  }
  return rows[lo] ?? null;
}

/**
 * 履歴の発言の実寸を、見えている所の近くだけ確定する（web/history-heights.mjs）。
 * 開いた直後は末尾の近く、その後は見えている所に近づいた行から。遠くの行は仮の高さのまま
 */
let heightSettler = null;
function prepareHistoryHeights() {
  heightSettler ??= createHeightSettler({ log, thread, atBottom, anchorRow: historyAnchor, onBusy: (on) => nav.finalizing(on) });
  heightSettler.prepare();
}

/** 走っているターンの描きかけ（稼働表示・本文・思考・発言の入れ物）を捨てる。走っている分は履歴の再生で描き直す */
function resetLiveTurn() {
  activity.hide();
  cancelStream();
  state.streamEl = null;
  state.thinkEl = null;
  state.turnEl = null;
  state.bundle = null;
  state.turnClosed = false;
}

function clearThread() {
  heightSettler?.cancel();
  resetLiveTurn();
  thread.replaceChildren(spine());
  thread.classList.remove("branched");
  state.toolCards.clear();
}

/** 行の中の発言の役割（続きの見出しを省くかの判定に使う）。履歴の行は AI なら .m.ai、人なら .m.user */
function rowRole(row) {
  const m = row.querySelector(".m");
  return m?.classList.contains("ai") ? "assistant" : m?.classList.contains("user") ? "user" : null;
}

/**
 * 静かな読み直し（つなぎ直したとき）で、履歴から描いた行を plan.keepItems 項目まで残し、その後ろを外す（web/history-sync.mjs の retainPlan）。
 * 残す境目は、残す項目のうち一番後ろの「履歴から描いた行」（data-h）。ライブで描いて履歴の添字を付けただけの行は、
 * 1 行が複数の発言にまたがることがあるので境目にしない（その分は履歴から描き直す）。
 * 境目より前でも、圧縮の区切りと分岐点の行は描き直すので外す。境目が無ければ null（呼び出し側が全部描き直す）。
 * 戻り値は { row: 境目の行, from: 描き直す最初の項目の添字, prevRole: その直前の発言の役割, rows: 履歴から描いた行（キー → 行） }
 */
function retainThread({ keepItems, items }) {
  const rows = new Map();
  for (const row of thread.children) if (row.dataset.h && row.dataset.key) rows.set(row.dataset.key, row);
  const keyOf = it => it.kind === "present" ? `p:${it.pi}` : `m:${it.mi}`;
  let boundary = null, from = 0;
  for (let i = keepItems - 1; i >= 0 && !boundary; i--) {
    boundary = rows.get(keyOf(items[i])) ?? null;
    from = i + 1;
  }
  if (!boundary) return null;
  let prevRole = null;
  for (let i = from - 1; i >= 0 && prevRole === null; i--) {
    const row = items[i].kind === "msg" ? rows.get(keyOf(items[i])) : null;
    if (row) prevRole = rowRole(row);
  }
  resetLiveTurn();
  let after = false;
  for (const row of [...thread.children]) {
    if (row.classList.contains("spine")) continue;
    if (after || row.classList.contains("branch-row") || row.dataset.compactionId !== undefined) row.remove();
    if (row === boundary) after = true;
  }
  for (const [id, card] of state.toolCards) if (!card.isConnected) state.toolCards.delete(id);
  return { row: boundary, from, prevRole, rows };
}

/**
 * 読み返している位置を、画面の基準の行（historyAnchor）で覚える。返す関数は、描き替えた後に同じ行が同じ高さに来るよう #log を動かす。
 * 基準の行が外れていたら同じ添字の行、それも無ければ元の scrollTop
 */
function holdReading() {
  const anchor = historyAnchor();
  const top = anchor?.getBoundingClientRect().top;
  const key = anchor?.dataset.key;
  const scrollAt = log.scrollTop;
  return () => {
    const row = anchor?.isConnected ? anchor : key ? [...thread.children].find(x => x.dataset.key === key) : null;
    if (row) log.scrollTop += row.getBoundingClientRect().top - top;
    else log.scrollTop = scrollAt;
  };
}

function spine() {
  const svg = svgEl("svg", { class: "spine", "aria-hidden": "true" });
  svg.append(svgEl("path", { d: "M20,0 L20,0" }));
  return svg;
}


// ---------------------------------------------------------------- 発言

// 発言の操作（10）。発言者の行のコピーと ⋯、⋯ と右クリック（タッチは長押し）が開く同じメニュー、キーボード（Shift+F10・メニューキー）。
// コピーは自分の発言なら原文、エージェントの返答なら次の自分の発言までの本文の Markdown（ツールは含めない）。
// 「ここから分岐」は、返答では ⋯ からその返答の終わりから、続きの発言を右クリックしたときはその発言から。

/** 発言者の行の操作を付ける（コピー・⋯）。ボタンは whoLine が置いてある。読むだけの筋（委譲の詳細）では stripActions で外す */
function wireActions(m) {
  const who = m.querySelector(':scope > .who');
  const copy = who?.querySelector('.who-copy'), more = who?.querySelector('.who-more');
  if (copy) copy.onclick = (e) => { e.stopPropagation(); copyToClipboard(messageCopyText(m), copy); };
  if (more) more.onclick = (e) => { e.stopPropagation(); openMessageMenu({ m, part: false }, { via: more }); };
}

/** 読むだけの筋（委譲の詳細）の発言から、操作を外す */
function stripActions(m) {
  const who = m.querySelector(':scope > .who');
  who?.querySelectorAll('.who-btn').forEach(b => b.remove());
  who?.classList.remove('acts');
  return m;
}

/** 返答の頭（見出しの行のある発言）。続きの発言から前へ辿る */
function replyHead(m) {
  if (!m.classList.contains('cont')) return m;
  for (let w = m.closest('.mw')?.previousElementSibling; w; w = w.previousElementSibling) {
    const x = w.querySelector?.(':scope .m.ai');
    if (x && !x.classList.contains('cont')) return x;
    if (w.querySelector?.(':scope .m.user:not(.cmd)')) break;
  }
  return m;
}

/** 返答（頭から、次の自分の発言・次の返答の前まで）の発言 */
function replyMessages(head) {
  const out = [head];
  for (let w = head.closest('.mw')?.nextElementSibling; w; w = w.nextElementSibling) {
    const x = w.querySelector?.(':scope .m[data-role]');
    if (!x) continue;
    if (x.dataset.role === 'user' && !x.classList.contains('cmd')) break;
    if (x.classList.contains('ai')) { if (!x.classList.contains('cont')) break; out.push(x); }
  }
  return out;
}

/** コピーする字。自分の発言は原文、返答は本文の Markdown をつなげたもの（ツール・考え中は含めない） */
function messageCopyText(m) {
  if (m.dataset.role === 'user') return m.classList.contains('cmd') ? (m.commandText?.() ?? '') : userRaw(m);
  return replyMessages(replyHead(m))
    .flatMap(x => [...x.querySelectorAll(':scope > .body')].map(b => b.dataset.raw ?? b.textContent ?? ''))
    .filter(Boolean).join('\n\n');
}

/** ⋯ から返答の終わりへ分岐するときの発言。uuid のある最後の発言（走っている最中の末尾は uuid がまだ無い） */
function forkAtReplyEnd(head) {
  return replyMessages(head).reverse().find(x => x.dataset.uuid) ?? null;
}

/**
 * 発言の「編集して再送信」「再送信」。基本は同じ会話の中で送り直す（後ろの発言は消える。ADR 0102）。
 * 送り直すと消えるものが 1 つでもあるときは、発言（編集欄）の直下の帯で「送り直す」と「分岐して送る」を選ぶ。
 * 何も消えないときは帯を出さず、再送信ならすぐ送り直す（編集は編集欄の［送り直す］で送る）
 */
async function resendFrom(m, edit) {
  if (state.busy || m.querySelector('.message-editor') || m.querySelector('.resend-band') || m.dataset.resending || rewindingNow === state.current) return;
  const source = state.current;
  m.dataset.resending = '1';
  try {
    const data = await cmd('loadSession', { sessionId: source });
    if (state.current !== source || !m.isConnected || state.busy) return;
    const index = data.messages.findIndex(row => row.uuid === m.dataset.uuid);
    if (index < 0) throw new Error(t('chat.message.notSaved'));
    const attached = data.presents.filter(p => attachmentMessageIndex(data.messages, p) === index)
      // 名前は captionParams.name（新しい記録）。無い過去の記録は保存された見出し「添付: 名前」から取る
      .map(p => ({ path: p.path, name: p.captionParams?.name || p.caption?.replace(/^添付:\s*/, '') || p.path.split(/[\\/]/).at(-1),
        mime: p.mime ?? /^data:([^;,]+)/.exec(p.dataUri ?? '')?.[1] ?? '', kind: p.kind, dataUri: p.dataUri,
        // 出どころと大きさも引き継ぐ（入力欄の一覧が出す）
        ...(p.origin === 'host' || p.origin === 'device' ? { from: p.origin } : {}), ...(Number.isFinite(p.size) ? { size: p.size } : {}) }));
    // 印（[添付] / [Attachment]）は本文の位置のまま編集欄へ戻す。文中の位置を保つ（編集で印を消した添付は送らない。keptAttachments）
    const draft = { text: data.messages[index].text ?? '', attached, index };
    // 委譲された作業の会話は同じ会話では送り直せない（サーバーも断る）。分岐して送るだけにする
    const forkOnly = Boolean(state.sessions.find(x => x.id === source)?.delegation);
    openResend(m, { draft, tail: tailInfo(data.messages, index, { running: isRunningHere(), forkOnly }), edit });
  } catch (e) { composerError(t('chat.message.resendPrepareFailed', { error: e.message })); }
  finally { delete m.dataset.resending; }
}

/**
 * 発言のメニューを開く。hit.m は触れた発言、hit.part は続きの発言（見出しの行が無い）を右クリックしたとき。
 * at: { via } ⋯ のボタンの下に右を揃えて出す / { x, y } 押した位置 / { key: true } キーボード（⋯ の下）
 */
function openMessageMenu({ m, part = false }, at = {}) {
  const head = replyHead(m);
  const owner = part ? head : m;
  const more = (part ? head : m).querySelector(':scope > .who .who-more');
  const user = m.dataset.role === 'user';
  const kind = user ? (m.classList.contains('cmd') ? 'cmd' : 'user') : 'ai';
  const target = kind === 'ai' && !part ? forkAtReplyEnd(m) : (m.dataset.uuid ? m : null);
  const canFork = Boolean(target) && capsOf(activeBackendId()).fork !== false;
  const command = kind === 'cmd' ? m.shellCommand?.() : null;
  const plan = messageMenuPlan({ kind, part, canFork, shell: Boolean(command), source: kind === 'user', editable: Boolean(m.dataset.uuid) });
  const busy = state.busy;
  const run = {
    copy: () => copyToClipboard(messageCopyText(m), owner.querySelector(':scope > .who .who-copy')),
    toComposer: () => copyShellToComposer(command),
    fork: () => forkFrom(target, { pending: more }),
    edit: () => resendFrom(m, true),
    resend: () => resendFrom(m, false),
    source: () => openSourceDialog({ text: userRaw(m), at: m.querySelector(':scope > .who .when')?.textContent ?? '', opener: more }),
  };
  const items = plan.map(p => (p.sep ? { sep: true } : { label: p.label, disabled: busy && ['fork', 'edit', 'resend'].includes(p.key), onClick: run[p.key] }));
  // ホバーが無い端末は、時刻を出す手段が押すことしか無いので、メニューの先頭に置く
  const when = m.querySelector(':scope > .who .when')?.textContent ?? '';
  const title = hoverless() && when
    ? (user ? t('chat.message.sentAt', { time: when }) : `${when} · ${m.querySelector(':scope > .who > span:not(.row-be):not(.when)')?.textContent ?? ''}`)
    : undefined;
  let x = at.x, y = at.y, alignRight = false;
  if (at.via || at.key || (!x && !y)) {
    const r = (more ?? m).getBoundingClientRect();
    x = more ? r.right : r.left + 8; y = r.bottom + 4; alignRight = Boolean(more);
  }
  owner.classList.add('menu-open');
  more?.setAttribute('aria-expanded', 'true');
  showMenu(x, y, items, title, { alignRight, onClose: () => {
    owner.classList.remove('menu-open');
    more?.setAttribute('aria-expanded', 'false');
  } });
}

setupMessageMenu(thread, {
  resolve: (target) => {
    const m = target.closest('.m[data-role]');
    if (!m || m.classList.contains('editing')) return null;
    return { m, part: m.classList.contains('ai') && m.classList.contains('cont') };
  },
  open: (hit, at) => openMessageMenu(hit, at),
});
/** 編集で本文から消した印の添付は、再送しない（元の本文に印があって、編集後に無くなったものだけを外す） */
function keptAttachments(attached, before, after) {
  const marks = (text) => new Set(String(text ?? '').split(/\r?\n/).map(line => ATTACHMENT_LINE.exec(line.trim())?.[1]).filter(Boolean).map(normalizeAttachmentPath));
  const had = marks(before), has = marks(after);
  return attached.filter(a => { const k = normalizeAttachmentPath(a.path); return !had.has(k) || has.has(k); });
}

// 今開いている送り方（編集欄・帯）。1 つだけ。別の発言を送り直し始めたら前のは閉じる
let resendOpen = null;
// 同じ会話で送り直している間の会話（サーバーの rewind イベントで自分の画面を二重に読み直さない）
let rewindingNow = null;

/** 送り直す発言の後ろの行（送り直すと消える範囲） */
function rowsAfter(m) {
  const rows = [];
  for (let w = m.closest('.mw')?.nextElementSibling; w; w = w.nextElementSibling) if (!w.classList.contains('spine')) rows.push(w);
  return rows;
}

/** 送り直す本文と添付（入力欄の送信と同じ決め方: 文中に印の無い添付だけ末尾に印を足す） */
function resendPayload(text, attached, sessionId) {
  const agentLang = state.sessions.find(s => s.id === sessionId)?.agentLocale ?? uiLang;
  const marked = new Set(String(text).split(/\r?\n/).map(line => ATTACHMENT_LINE.exec(line.trim())?.[1]).filter(Boolean).map(normalizeAttachmentPath));
  const unmarked = attached.filter(a => !marked.has(normalizeAttachmentPath(a.path)));
  return {
    prompt: [text.trim(), unmarked.map(a => attachmentLine(agentLang, a.path)).join(NL)].filter(Boolean).join(NL + NL),
    attachments: attached.map(a => ({ path: a.path, name: a.name, mime: a.mime ?? '' })),
  };
}

/**
 * 同じ会話の中で送り直す（sendMessage の rewind）。消える範囲は先に畳み、サーバーが巻き戻して送り終えたら履歴を読み直して
 * 消えた発言を片付け、新しい発言の吹き出しを置く（会話は切り替えない）。送れなかったら畳んだ範囲を戻して理由を出す。成功したら true。
 * 押した時点の実行中の判定は、帯を開いたときのものではなく今のもの（開いたあとに走り出していたら、帯を作り直して、もう一度押してもらう）。
 * 巻き戻しは済んで受け付けだけが失敗したときは、rewind を外して同じ messageId で送り直す（起点の発言はもう無いので、巻き戻し直せない）
 */
async function rewindSend({ m, source, tail, text, attached, band = null }) {
  if (isRunningHere() && !tail.running) {
    tail.running = true; tail.any = true;
    band?.update(tail);
    return false;
  }
  const { prompt, attachments } = resendPayload(text, attached, source);
  const messageId = randomId();
  const doomed = rowsAfter(m);
  for (const w of doomed) w.classList.add('leaving');
  if (attached.length) provisionalByMessage.set(messageId, attached.map(provisionalPresent));
  rewindingNow = source;
  const request = { sessionId: source, messageId, prompt, cwd: state.cwd.trim() || undefined, mode: state.mode, ...(attachments.length ? { attachments } : {}) };
  const done = async () => {
    $('settingsError').textContent = '';
    announce(tail.users > 0 ? t('chat.resend.doneUsers', { count: tail.users }) : tail.saved > 0 ? t('chat.resend.doneReplies') : t('chat.resend.done'));
    // 履歴を読み直す。同じ先頭の行は残し、巻き戻した所から後ろだけ描き替える（消えた発言と新しい発言）
    if (state.current === source) await select(source, { reload: true });
    // 読み直せなかったときに、畳んだ行が隠れたまま残らないように（高さ 0・不透明度 0 のまま）
    for (const w of doomed) if (w.isConnected) w.remove();
    return true;
  };
  try {
    await settingsWrite.catch(() => {});
    await modeWrite;
    await cmd('sendMessage', { ...request, rewind: { beforeMessageId: m.dataset.uuid, ...(isRunningHere() ? { stopRunning: true } : {}) } });
    return await done();
  } catch (e) {
    for (const w of doomed) w.classList.remove('leaving');
    // サーバーの見立ては「実行中」だった（開いたあとに走り出した）。帯を作り直して、もう一度押してもらう
    if (e.code === 'SESSION_RUNNING' && !tail.running) { tail.running = true; tail.any = true; band?.update(tail); }
    composerError(t('chat.resend.failed', { error: e.message }));
    const data = await cmd('loadSession', { sessionId: source }).catch(() => null);
    const uuids = list => (list ?? []).map(x => x.uuid).join();
    if (data && state.current === source && uuids(data.messages) !== uuids(state.messages)) {
      // 巻き戻しは済んでいる（受け付けだけが失敗した）。同じ本文を、巻き戻さずに同じ messageId で送る
      try {
        await cmd('sendMessage', request);
        return await done();
      } catch (retry) {
        provisionalByMessage.delete(messageId);
        const copied = await writeClipboard(prompt);
        composerError(copied ? t('chat.resend.failedCopied', { error: retry.message }) : t('chat.resend.failed', { error: retry.message }));
        select(source, { reload: true }).catch(() => {});
        return false;
      }
    }
    provisionalByMessage.delete(messageId);
    return false;
  } finally { rewindingNow = null; }
}

/**
 * 送り直す発言の操作を開く。編集（edit）なら編集欄を、後ろに消えるものがあれば帯を、発言の直下に置く。
 * 帯があるとき、編集欄は自前の送信ボタンを持たず帯で送る。後ろに何も無い再送信は帯を出さずすぐ送る。
 * 同じ会話では送り直せない会話（forkOnly。委譲された作業の会話）は、帯の［分岐して送る］だけ
 */
function openResend(m, { draft, tail, edit }) {
  resendOpen?.close();
  const source = state.current;
  const { forkOnly } = tail;
  if (!edit && !tail.any && !forkOnly) { void rewindSend({ m, source, tail, text: draft.text, attached: draft.attached }); return; }
  const body = m.querySelector(':scope > .body');
  // 消える範囲を薄くする。帯を開いたあとに（走っている返答などで）増える行にも付ける
  const dims = tail.any && !forkOnly;
  const mw = m.closest('.mw');
  for (const w of dims ? rowsAfter(m) : []) w.classList.add('doomed');
  const observer = dims && typeof MutationObserver === 'function' ? new MutationObserver((records) => {
    for (const record of records) for (const node of record.addedNodes) {
      if (node.nodeType === 1 && node.classList.contains('mw') && mw && (mw.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING)) node.classList.add('doomed');
    }
  }) : null;
  observer?.observe(thread, { childList: true });
  let editor = null, input = null, band = null, ownSend = null, sending = false;
  const current = () => (input
    ? { text: input.value, attached: keptAttachments(draft.attached, draft.text, input.value) }
    : { text: draft.text, attached: draft.attached });
  const valid = () => { const c = current(); return Boolean(c.text.trim() || c.attached.length); };
  const close = ({ focus = false } = {}) => {
    observer?.disconnect();
    for (const w of thread.querySelectorAll('.mw.doomed')) w.classList.remove('doomed');
    band?.node.remove();
    if (editor) { editor.remove(); body.hidden = false; m.classList.remove('editing'); }
    if (resendOpen?.m === m) resendOpen = null;
    if (focus) m.querySelector(':scope > .who .who-more')?.focus();
    relayoutBranches();
  };
  const refresh = () => {
    const off = sending || !valid();
    if (ownSend) ownSend.disabled = off;
    if (band) { band.send.disabled = off; band.branch.disabled = off; }
    if (input) { input.style.height = 'auto'; input.style.height = `${input.scrollHeight}px`; }
    relayoutBranches();
  };
  const busy = (on) => {
    sending = on;
    band?.busy(on);
    if (input) input.disabled = on;
    refresh();
  };
  const branch = async () => {
    if (sending || !valid()) return;
    const c = current();
    busy(true);
    try { await forkFrom(m, { draft: { ...c, index: draft.index } }); }
    finally { busy(false); }
    // 分岐の先へ移ったなら、この会話の編集欄・帯は役目を終えている。移れなかったら（理由は forkFrom が出した）開いたまま
    if (state.current !== source || !m.isConnected) { close(); announce(t('chat.resend.doneBranch')); }
  };
  const send = async () => {
    if (forkOnly) return branch();
    if (sending || !valid()) return;
    busy(true);
    const ok = await rewindSend({ m, source, tail, ...current(), band });
    busy(false);
    if (ok) close();
  };
  const cancel = () => { if (!sending) close({ focus: true }); };
  // onkeydown が false を返すと既定の動作（ボタンの Enter・Space）まで止まるので、返り値は捨てる
  const keys = (event) => { resendKeys(event, { send, branch, cancel }); };

  if (edit) {
    editor = el('div', 'message-editor');
    input = el('textarea', 'message-edit-input');
    input.value = draft.text;
    input.setAttribute('aria-label', t('chat.message.editLabel'));
    editor.append(input);
    if (draft.attached.length) editor.append(el('div', 'message-edit-attachments', draft.attached.map(a => a.name).join(' · ')));
    if (!tail.any && !forkOnly) {
      // 後ろに何も無い: 帯は出さず、編集欄が［取り消し］と［送り直す］を持つ。近道（Ctrl/⌘+Enter・Ctrl/⌘+Shift+Enter・Esc）は同じに効く
      const controls = el('div', 'message-edit-controls');
      const cancelButton = el('button', 'btn', t('chat.resend.cancel'));
      ownSend = el('button', 'btn btn-primary');
      cancelButton.type = ownSend.type = 'button';
      ownSend.append(sendGlyph(), el('span', null, t('chat.resend.send')));
      ownSend.title = `${t('chat.resend.send')} (Ctrl+Enter) · ${t('chat.resend.branch')} (Ctrl+Shift+Enter)`;
      cancelButton.onclick = cancel;
      ownSend.onclick = send;
      controls.append(cancelButton, ownSend);
      editor.append(controls);
    }
    body.hidden = true; body.after(editor); m.classList.add('editing');
    input.oninput = refresh;
    input.onkeydown = keys;
  }
  if (tail.any || forkOnly) {
    band = buildBand({ tail, onSend: send, onBranch: branch, onCancel: cancel });
    band.node.onkeydown = keys;
    // 発言の中身（添付の行・送信の状態）の下、発言の一番下。編集中は送信の状態の行を隠す（style.css）
    m.append(band.node);
    input?.setAttribute('aria-describedby', `${band.node.id}t`);
  }
  resendOpen = { m, close };
  refresh();
  // 編集は編集欄、再送信で帯が出たときは主のボタン［送り直す］（同じ会話で送り直せないときは［分岐して送る］）へ。読み上げに帯の名前と文が届く
  if (input) input.focus(); else (forkOnly ? band?.branch : band?.send)?.focus({ preventScroll: true });
  band?.node.scrollIntoView?.({ block: 'nearest' });
}

function setUuid(m, uuid) {
  if (!uuid) return;
  m.dataset.uuid = uuid;   // ⋯ のメニューの「ここから分岐」は、uuid が分かった発言だけに出る（openMessageMenu）
}

/**
 * 発言者の行。「[ロゴ] 名前 …… 時刻」。ロゴ（エージェントの発言だけ。「あなた」には付けない）は名前の左に置き、読み上げには出さない。
 * 時刻は触れている・焦点がある間だけ見える（style.css。場所は取ったままなので並びは動かない）。右端の操作の列（24px）は ⋯、
 * 時刻の左にコピー（actions: false は操作を持たない行。wireActions が押したときの動きを付ける）
 */
function whoLine(who, at, { backend, actions = true } = {}) {
  const w = el("div", "who");
  if (backend) {
    const logo = backendLogo(backend, who);
    logo.removeAttribute("title");
    logo.setAttribute("aria-hidden", "true");
    w.append(logo);
  }
  w.append(el("span", null, who));
  if (actions) {
    const { copy, more } = actionButtons();
    w.classList.add("acts");
    w.append(copy, el("span", "when", hhmm(at)), more);
  } else w.append(el("span", "when", hhmm(at)));
  return w;
}

/**
 * 自分の発言。本文は Markdown で描き、この発言に結び付いた添付（presents。human の present）は本文の印の位置に置く
 * （web/user-message.mjs、ADR 0059）。markdown: false は今までの平文（委譲の子の会話を読む面）
 */
function userMsg(text, { uuid, at, presents = [], markdown = true, scheduledFor, sentBy = null } = {}) {
  const m = el("div", "m user");
  m.dataset.role = "user";
  if (at) m.dataset.at = at;
  m.append(whoLine(t("chat.message.you"), at));
  if (sentBy) markSentBy(m, sentBy);
  const body = el("div", "body");
  m.append(body);
  wireActions(m);
  paintUser(m, text, presents, { markdown });
  setUuid(m, uuid);
  if (scheduledFor) markSentLate(m, at, scheduledFor);
  return m;
}

/**
 * 別の会話の AI が送った発言（sessions.send。ADR 0104）。見出しの「あなた」に「<送り手> があなたの代わりに送信」を添え、送った会話を開けるようにする
 * （`!` の行の「{agent} に渡した」と同じ並び）。送り手は bot の名前（name）、無ければ送った会話の題
 */
function markSentBy(m, sentBy) {
  const who = m.querySelector(':scope > .who');
  if (!who || who.querySelector('.sent-by')) return;
  const sender = (sentBy.name ? [sentBy.icon, sentBy.name].filter(Boolean).join(' ') : '') || (sentBy.title ? t('chat.message.sentByConversation', { title: sentBy.title }) : t('chat.message.sentByAnother'));
  m.classList.add('relayed');
  who.firstChild.append(' · ', el('span', 'handed sent-by', t('chat.message.sentBy', { sender })));
  if (!sentBy.sessionId) return;
  const open = el('button', 'who-act', t('chat.message.openSender'));
  open.type = 'button';
  open.title = t('chat.message.openSenderTitle');
  open.onclick = (e) => { e.stopPropagation(); select(sentBy.sessionId); };
  who.firstChild.append(open);
}

/** 送信予定の時刻に遅れて送った発言の下の一言「9:00 の予定を 9:32 に送りました」。時刻どおり（2 分以内）なら出さない */
const LATE_NOTE_MS = 2 * 60_000;
function markSentLate(m, at, planned) {
  m.querySelector(':scope > .sent-late')?.remove();
  const sent = Date.parse(at ?? '');
  if (!Number.isFinite(sent) || !Number.isFinite(planned) || sent - planned < LATE_NOTE_MS) return;
  const note = el('div', 'sent-late', t('schedule.late', { planned: whenText(planned, sent), sent: timeText(sent) }));
  m.querySelector(':scope > .body')?.after(note);
}

/** 発言の原文。描画は原文から作り直せるよう、吹き出しが持つ（履歴との突き合わせ・添付の突き合わせもこれを読む） */
const userRaw = (m) => m.querySelector(":scope > .body")?.dataset.raw ?? m.querySelector(":scope > .body")?.textContent ?? "";

/** 発言の本文と、その下の行（添付 N 件・原文）を描く。m.attached は結び付いた添付 */
function paintUser(m, text, presents = [], { markdown = m.querySelector(":scope > .body")?.classList.contains("md-user") ?? true } = {}) {
  const body = m.querySelector(":scope > .body");
  m.attached = presents;
  paintUserBody(body, text, presents, { markdown });
  if (markdown) paintUserTools(m);
  else m.querySelector(":scope > .msg-tools")?.remove();
}

/** 発言の下の「📎 N ▾」。結び付いた添付（m.attached）から作り直す（本文は触らない） */
function paintUserTools(m) {
  m.querySelector(":scope > .msg-tools")?.remove();
  const tools = userTools({ presents: m.attached ?? [],
    openItem: (item, present) => {
      const src = present && attachmentImageSrc(present);
      if (src) openLightbox(src, item.name, item.path);
      else if (item.path) filePreview.open({ path: item.path, line: null }, null);
    },
    copyPath: (path) => copyPathText(path) });
  if (tools) m.querySelector(":scope > .body")?.after(tools);
}

/**
 * 送った直後の吹き出しに渡す仮の添付（入力欄の添付から。web/attachment-frame.mjs）。パスの字を出さず、画像は枠から始める。
 * 後から同じパスの present が届いたら、描き直さずに中身だけ差し替える（present のハンドラ）
 */
const provisionalPresent = (a) => ({ by: 'human', provisional: true, kind: a.kind === 'image' ? 'image' : 'file', path: a.path,
  captionParams: { name: a.name }, mime: a.mime ?? '',
  ...(a.from === 'host' || a.from === 'device' ? { origin: a.from } : {}), ...(Number.isFinite(a.size) ? { size: a.size } : {}),
  ...(a.width > 0 && a.height > 0 ? { width: a.width, height: a.height } : {}) });
/** 送ってから吹き出しができるまでの仮の添付（messageId で引く。行を作るときに 1 度だけ使う） */
const provisionalByMessage = new Map();

/**
 * Pleiad の完了通知の 1 行。「✓（失敗は ✕）・委譲先のロゴ・依頼の題 …… 届いた時刻」の並びで、字は出さない（委譲のカードと同じ並び。ADR 0067）。
 * 「委譲の結果（完了）」は読み上げ名と title、委譲先の名前はロゴの title が持つ。時刻は触れたときだけ。子の会話へは矢印のアイコン。
 * 開くと結果の本文だけで、エージェントに渡した全文は奥の折りたたみ。読めない形（まとめ通知・古い形）や本文が無いときは、従来の「再開しました」の 1 行
 */
function taskNoticeNode(text, at = '') {
  // 設定と操作の承認結果（ADR 0088）は、開ける 1 行にする
  const settings = parseSettingNotices(text);
  if (settings.length > 1) return sysFold(settings.every((n) => n.kind === 'setting')
    ? t('chat.sys.settingResults', { count: settings.length }) : t('chat.sys.opResults', { count: settings.length }), text, at);
  // i18n-dynamic: chat.sys.settingState.
  // i18n-dynamic: chat.sys.opState.
  if (settings.length) {
    const n = settings[0];
    const state = n.kind === 'setting' ? t(`chat.sys.settingState.${n.outcome}`)
      : n.outcome === 'allowed' ? t(`chat.sys.opState.${n.words}.allowed`, { defaultValue: t('chat.sys.opState.op.allowed') })
        : n.outcome === 'failed' ? t(`chat.opApproval.${n.words}.failed`, { defaultValue: t('chat.opApproval.op.failed') })
          : t(`chat.sys.opState.${n.outcome}`);
    return sysFold(n.kind === 'setting' ? t('chat.sys.settingResult', { state }) : t('chat.sys.opResult', { state }), text, at);
  }
  const notice = parseTaskNotice(text);
  if (!notice) return text ? sysFold(t('chat.sys.taskResumed'), text, at) : el('div', 'm sys', t('chat.sys.taskResumed'));
  const task = taskById(notice.taskId);
  const first = notice.task.split(/\r?\n/).find(Boolean) ?? '';
  const title = task ? backgroundTitle(task) : [...first].slice(0, 40).join('');
  const backend = task?.backend || notice.backend;
  const failed = notice.status === 'failed';
  const resultName = t('chat.sys.taskResultState', { state: TASK_STATUS[notice.status] ?? notice.status });
  const mark = stillMark(notice.status === 'completed' ? 'done' : failed ? 'fail' : 'stop', resultName);
  const m = el('div', 'm sys task-notice' + (failed ? ' failed' : ''));
  const d = el('details', 'sys-fold');
  const s = el('summary');
  s.setAttribute('aria-label', `${resultName}: ${title}`);
  const verb = el('span', 'tn-verb');
  verb.append(mark);
  const res = el('span', 'tn-res');
  res.append(el('span', 'tc-go-slot'));   // 行の外に重ねた矢印（.tc-go）の場所
  if (at) res.append(el('span', 't', at));
  const logo = backend ? routingLogo(backend) : null;
  logo?.setAttribute('aria-hidden', 'true');
  s.append(verb, ...(logo ? [logo] : []), el('span', 'tn-title', title), res, chevron());
  watchValueWidth(res);
  // 字は書いたとおり。URL だけリンクにする（sysFold と同じ。パスは字のまま）
  const linked = (source) => { const box = el('div', 'sys-body'); box.innerHTML = plainTextHtml(source, { paths: false }); return box; };
  const body = linked(notice.result || text);
  const full = el('details', 'tc-fold tc-json');
  full.append(el('summary', null, t('chat.sys.taskFull')), linked(text));
  d.append(s, body, full);
  m.append(d);
  if (task) m.append(goButton(t('timeline.delegate.openChild'), () => openWork(`t:${task.taskId}`)));
  return m;
}

/**
 * 履歴のシステム側のメッセージ（サーバーが kind を付けた発言。core/system-messages.mjs、ADR 0053）の行。
 * 落とすものは null、システム側のものでなければ undefined（呼び出し側が普通の発言として描く）
 */
function systemHistoryNode(m) {
  if (m.kind === 'compactSummary') return null;   // 区切りの「要約を表示」に入っている（サーバーが外す。念のため）
  if (m.kind === 'interrupt') return interruptHistoryLine(m);
  if (m.kind === 'teammate') return teammateNode(m, hhmm(m.at));
  if (m.kind === 'command' || m.kind === 'shell') return commandMsg(m);
  // 中断で止めたものを Pleiad がエージェントへ伝えた文。開くと中身が読める
  if (m.kind === 'interruptionNote') return sysFold(t('chat.sys.interruptionNote'), m.body ?? '');
  // bot の会話の先頭の包み（core/system-messages.mjs の splitLeadingNotes）。チャンネルの出来事は「#チャンネル · 発言者」、記憶は渡した印。開くと中身が読める
  if (m.kind === 'channelEvent') return sysFold(m.history ? t('channels:event.thread', { channel: m.channel }) : t('channels:event.post', { channel: m.channel, from: m.from }), m.body ?? '', hhmm(m.at));
  if (m.kind === 'contextNote') return sysFold(m.tag === 'memory-core' ? t('channels:event.memoryCore') : m.tag === 'bot-recent' ? t('channels:event.botRecent') : m.tag === 'inner' ? (m.innerKind === 'wake' ? t('channels:event.wake') : t('channels:event.inner')) : t('channels:event.turnContext'), m.body ?? '', hhmm(m.at));
  // Pleiad の完了通知。「タスクの結果で再開」の 1 行を開くと、エージェントに渡した本文が読める
  if (m.internalTaskNotice) return taskNoticeNode(m.text, hhmm(m.at));
  return undefined;
}

/**
 * スラッシュコマンド・`!` モードの 1 行。発言者は「あなた」、吹き出しは付けない（web/system-messages.mjs）。
 * 操作は「ここから分岐」だけ。`!` は「入力欄に写す」（走らせない）も。編集して再送信・再送信は付けない
 */
function commandMsg(m) {
  const node = el('div', 'm user cmd' + (shellFailed(m) ? ' failed' : ''));
  node.dataset.role = 'user';
  if (m.at) node.dataset.at = m.at;
  const who = whoLine(t('chat.message.you'), m.at);
  // 入力欄の `!`（ADR 0054）: 渡す前は「次の発言で {agent} に渡す」、渡した後は「{agent} に渡した」。
  // ホストで走らせる会話は、渡す前なら行ごとに「渡さない」を選べる。渡さなかった行は「{agent} に渡していない」で残る（ADR 0055）
  const agent = labelOf(m.backend ?? activeBackendId()) || 'AI';
  if (m.kind === 'shell') {
    const label = m.kept ? t('chat.shell.kept', { agent }) : m.pending ? (m.skip ? t('chat.shell.skipped', { agent }) : t('chat.shell.pending', { agent })) : t('chat.system.handedTo', { agent });
    who.firstChild.append(' · ', el('span', 'handed', label));
    if (m.pending && m.runId && capsOf(m.backend ?? activeBackendId()).shell === 'host') who.firstChild.append(shellSkipButton(m));
  }
  // 操作は ⋯ のメニュー（コピー・`!` は「入力欄に写す」・ここから分岐）。走らせ直した行の内容は、その時点の行から読む
  node.commandText = () => (m.runId ? shellRows.get(m.runId)?.m : null)?.command ?? m.command ?? '';
  node.shellCommand = () => { const x = (m.runId ? shellRows.get(m.runId)?.m : null) ?? m; return x.kind === 'shell' && x.command && !x.running ? x.command : null; };
  const parts = commandParts(m, { onStop: m.runId ? () => cmd('stopShell', { runId: m.runId }).catch(() => {}) : null });
  // 0 以外の終了コードが分かるときだけ、行の面を一段上げる（ツールの失敗と同じ語彙。design-system「システム側のメッセージ」）
  if (shellFailed(m)) { const box = el('div', 'cmd-box'); box.append(...parts); node.append(who, box); }
  else node.append(who, ...parts);
  if (m.runId) { node.dataset.runId = m.runId; shellRows.set(m.runId, { m, node }); if (m.running) syncShellTicker(); }
  wireActions(node);
  if (m.uuid) node.dataset.uuid = m.uuid;
  return node;
}

/**
 * `!` の行の「入力欄に写す」（走らせない）。空の欄で走らせられる会話なら、シェルの形でコマンドを入れる（web/shell-composer.mjs）。
 * 書きかけがある・使えない会話では、`! コマンド` の文として後ろに足す
 */
function copyShellToComposer(command) {
  if (!shellComposer.copy(command)) return copyToComposer(`! ${command}`);
  const prompt = $('prompt');
  prompt.dispatchEvent(new Event('input', { bubbles: true }));
  prompt.focus();
}

// ---------------------------------------------------------------- 入力欄の `!`（シェルの行。ADR 0054）
// 走らせた行は会話にすぐ積み、出力を流しながら出す。行は runId で引く（履歴の行も commandMsg が登録する）
const shellRows = new Map();   // runId -> { m, node }
const shellPaints = new Map(); // runId -> requestAnimationFrame の番号（出力が速いときは 1 フレームにまとめて描き直す）
let shellTicker = null;

/** 見出しの横の「渡さない」／「渡す」（ADR 0055）。全部の接続へ流れる shell.skip で描き直す */
function shellSkipButton(m) {
  const b = el('button', 'who-act', m.skip ? t('chat.shell.unskip') : t('chat.shell.skip'));
  b.type = 'button';
  b.onclick = async () => {
    const sessionId = state.current;
    b.disabled = true;
    try {
      const r = await cmd('skipShell', { sessionId, runId: m.runId, skip: !m.skip });
      if (sessionId === state.current) { m.skip = r.skip; repaintShellRow(m.runId); }
      $('settingsError').textContent = '';
    } catch (e) {
      b.disabled = false;
      $('settingsError').textContent = t('chat.shell.skipFailed', { error: e.message });
    }
  };
  return b;
}

/** 走っている行の経過を 1 秒ごとに書き換える。走っている行が無くなったら止める */
function syncShellTicker() {
  const running = () => [...shellRows.values()].filter(e => e.m.running && e.node.isConnected);
  if (shellTicker || !running().length) return;
  shellTicker = setInterval(() => {
    const live = running();
    if (!live.length) { clearInterval(shellTicker); shellTicker = null; return; }
    for (const { m, node } of live) {
      const span = node.querySelector('.cmd-res.running .elapsed');
      if (span) span.textContent = t("chat.shell.running", { elapsed: shellElapsed(Date.now() - Date.parse(m.at ?? 0)) });
    }
  }, 1000);
}

/** 行を描き直す。開閉と、出力の末尾に付いていたかは引き継ぐ */
function repaintShellRow(runId) {
  const entry = shellRows.get(runId);
  if (!entry?.node.isConnected) return;
  const open = {}, stuck = {};
  for (const d of entry.node.querySelectorAll('details[data-stream]')) {
    open[d.dataset.stream] = d.open;
    const pre = d.querySelector('pre');
    stuck[d.dataset.stream] = !pre || pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 4;
  }
  entry.m.openStreams = open;
  const stick = atBottom();
  const old = entry.node;
  const fresh = commandMsg(entry.m);
  old.replaceWith(fresh);
  for (const d of fresh.querySelectorAll('details[data-stream]')) {
    const pre = d.querySelector('pre');
    if (pre && stuck[d.dataset.stream] !== false) pre.scrollTop = pre.scrollHeight;
  }
  if (stick) log.scrollTop = log.scrollHeight;
}
function scheduleShellRow(runId) {
  if (shellPaints.has(runId)) return;
  shellPaints.set(runId, requestAnimationFrame(() => { shellPaints.delete(runId); repaintShellRow(runId); }));
}

/** shell.* の出来事（core/shell-runs.mjs）。開いている会話の分だけ描く */
function onShellEvent(ev) {
  // 開いている会話の分と、スレッドに出している行（宛先の bot の会話の `!`。web/channels/thread.mjs）の分を描く
  if (ev.sessionId !== state.current && !(ev.type !== 'shell.start' && shellRows.get(ev.runId)?.node.isConnected)) return;
  if (ev.type === 'shell.start') {
    if (shellRows.get(ev.runId)?.node.isConnected) return;
    const m = { role: 'user', kind: 'shell', text: `! ${ev.command}`, command: ev.command, stdout: '', stderr: '', at: ev.at, backend: ev.backend,
      runId: ev.runId, pending: true, running: true, live: true };
    append(commandMsg(m), `shell:${ev.runId}`);
    return;
  }
  if (ev.type === 'shell.handed') {
    for (const runId of ev.runIds ?? []) {
      const entry = shellRows.get(runId);
      if (entry) { entry.m.pending = false; repaintShellRow(runId); }
    }
    // 渡さなかった行（ADR 0055）
    for (const runId of ev.keptIds ?? []) {
      const entry = shellRows.get(runId);
      if (entry) { Object.assign(entry.m, { pending: false, skip: false, kept: true }); repaintShellRow(runId); }
    }
    return;
  }
  if (ev.type === 'shell.skip') {
    const entry = shellRows.get(ev.runId);
    if (entry && entry.m.pending) { entry.m.skip = Boolean(ev.skip); repaintShellRow(ev.runId); }
    return;
  }
  const entry = shellRows.get(ev.runId);
  if (!entry) return;
  const m = entry.m;
  if (ev.type === 'shell.output') {
    m[ev.stream] = (m[ev.stream] || '') + ev.text;
    return scheduleShellRow(ev.runId);
  }
  if (ev.type === 'shell.done') {
    Object.assign(m, { running: false, exitCode: ev.exitCode ?? null, stopped: ev.stopped, timedOut: ev.timedOut, truncated: ev.truncated,
      error: ev.error ?? null, ...(ev.timeoutMs ? { timeoutMs: ev.timeoutMs } : {}), ...(typeof ev.stdout === 'string' ? { stdout: ev.stdout } : {}) });
    cancelAnimationFrame(shellPaints.get(ev.runId));
    shellPaints.delete(ev.runId);
    repaintShellRow(ev.runId);
  }
}

/** 空の欄の先頭で `!` を打ったときに、いまの会話で走らせられるか */
function shellAvailability() {
  const row = state.sessions.find(s => s.id === state.current);
  // 次の送信でエージェントが替わる予約があれば、渡す先（替えた先）で決める。ホストで走らせる形どうしでなければ渡せない
  const current = activeBackendId();
  const backend = row?.nextSettings?.backend ?? current;
  const caps = capsOf(backend);
  if (!caps.shell || (backend !== current && !(caps.shell === 'host' && capsOf(current).shell === 'host'))) return { ok: false, text: t('chat.shell.unavailable', { agent: labelOf(backend) || 'AI' }) };
  // Codex はスレッドができてから（最初の発言の後）
  if (caps.shell === 'native' && (!row || row.unsent || state.current === freshSessionId)) return { ok: false, text: t('chat.shell.notStarted') };
  return { ok: true };
}

/** シェルの形の欄で Ctrl+Enter / ▶。欄はすぐ空に戻し、行は shell.start で会話に積む。送信待ちにも送り直しの控えにも積まない */
async function runShellFromComposer() {
  if (connStatus.blocksSend() || retiredHere()) return;
  const command = $('prompt').value;
  if (!command.trim()) return;
  if (!state.current || state.current === freshSessionId) {
    const created = await (creatingSession ?? startNew());
    if (!created || state.current !== created || state.current === freshSessionId) return;
  }
  const sessionId = state.current;
  const runId = randomId();
  $('prompt').value = '';
  shellComposer.exit();
  fitPrompt();
  saveDraft().catch(() => {});
  try {
    await cmd('runShell', { sessionId, runId, command, cwd: state.cwd.trim() || undefined });
    $('settingsError').textContent = '';
  } catch (e) {
    // 走らなかった。書いたコマンドを欄に戻す（送り直しはしない。もう一度押すかは人が決める）
    if (state.current === sessionId && !$('prompt').value) { shellComposer.enter(); $('prompt').value = command; fitPrompt(); }
    $('settingsError').textContent = t('chat.shell.runFailed', { error: e.message });
  }
}

/** 入力欄に字を入れる（送らない）。書きかけがあれば改行して後ろに足す */
function copyToComposer(text) {
  const prompt = $('prompt');
  composerEditor.append(prompt.value && !prompt.value.endsWith('\n') ? `\n${text}` : text);
  prompt.dispatchEvent(new Event('input', { bubbles: true }));
  prompt.focus();
}

/**
 * 履歴に残った中断（CLI の `[Request interrupted by user]`）。吹き出しにせず、保存された中断と同じ 1 行にする。
 * 末尾の中断は paintInterruptLine が同じ行を保存された理由・時刻で描き直すので、二重にならない
 */
function interruptHistoryLine(m) {
  const line = el('div', 'm sys interrupted');
  line.dataset.interrupted = 'user';
  line.append(stopMark(), el('span', null, interruptLineText({ reason: 'user' })));
  const at = hhmm(m.at);
  if (at) line.append(el('span', null, '·'), el('span', 't', at));
  return line;
}

function aiMsg({ uuid, at, cont, backend } = {}) {
  const m = el("div", "m ai" + (cont ? " cont" : ""));
  m.dataset.role = "assistant";
  if (at) m.dataset.at = at;
  const be = backend ?? activeBackendId();
  m.append(whoLine(labelOf(be) || "AI", at, { backend: be }));
  wireActions(m);
  setUuid(m, uuid);
  return m;
}

/** 直前の発言が AI なら、続きとして見出しと節を繰り返さない */
const lastIsAi = () => thread.querySelector(".mw:last-of-type .m")?.classList.contains("ai") ?? false;

/**
 * ライブで AI の発言の入れ物。無ければ作る。text.end で閉じた後でも、続くツール呼び出しは
 * 同じ発言のもの（履歴では 1 メッセージ = 本文 + ツール呼び出し）なのでここへ入る。
 */
function ensureTurnEl() {
  if (state.turnEl) return state.turnEl;
  const m = aiMsg({ at: new Date().toISOString(), cont: lastIsAi(), uuid: state.pendingUuid });
  state.pendingUuid = null;
  append(m, `live:${++liveSeq}`);
  state.turnEl = m;
  return m;
}
let liveSeq = 0;

/** 本文や thinking が始まる。閉じた発言の後なら新しい発言になる */
function openTurnEl() {
  if (state.turnClosed) closeTurnEl();
  return ensureTurnEl();
}

/** 走っているまとまりを閉じて見出し 1 行にする（本文が来た・委譲が始まった・ターンが終わった） */
function closeBundle() {
  const b = state.bundle;
  state.bundle = null;
  if (!b) return;
  b.close();
  // 走っている行を抱えたまま閉じた（本文・割り込みが先に来た）。その行は閉じた見出しの中に隠れるので、稼働表示で待っていることを残す
  if (b.cards.some((c) => c.classList.contains("tc-running"))) {
    queueMicrotask(() => { if (isRunningHere() && !state.bundle) activity.show(activity.text || ACTIVITY_LABEL.running); });
  }
}

/** 今のまとまり。無ければ今の発言の末尾に作る。コンピューターの操作の連続は別の種類の塊（kind: "computer"）で、種類が替わればそこで切れる */
function liveBundle(kind = "tools") {
  const turn = ensureTurnEl();
  if (state.bundle && state.bundle.el.parentNode === turn && state.bundle.kind === kind) return state.bundle;
  closeBundle();
  state.bundle = new Bundle({ live: true, kind, ...(kind === "computer" ? { onStop: stopComputer } : {}) });
  turn.append(state.bundle.el);
  return state.bundle;
}

/** まとまりの外に置くツール（委譲・サブエージェント）。子は親のターンの後も動くので、閉じても見える */
const isBoundaryTool = (name) => isDelegateTool(name) || SUBAGENT_TOOLS.has(name);

/** 会話の下端に付いていく（行が伸びて高さが変わる間も、読んでいた下端に居続ける） */
function followBottom(ms = 320) {
  const end = performance.now() + ms;
  const tick = () => { log.scrollTop = log.scrollHeight; if (performance.now() < end) requestAnimationFrame(tick); };
  tick();
}

function closeTurnEl() {
  closeThink();
  closeBundle();
  endStream();
  state.turnEl = null;
  state.turnClosed = false;
  state.endedWithText = false;
  state.pendingUuid = null;
}

/**
 * ターンが終わった。結果を持たないまま残った行（中断・エラーで tool.result が来なかった）から、走っている印と承認カードを外す。
 * 弧と経過が回り続けたり、閉じた見出しの中で押せない承認が残ったりしないように
 */
function settleStrays() {
  for (const row of thread.querySelectorAll(".tc.tc-running, .tc.tc-waiting")) {
    row.classList.remove("tc-running", "tc-waiting");
    const res = row.querySelector(".tc-res");
    if (res) { res.paint = null; res.replaceChildren(); }
    row.querySelector(".tc-appr")?.remove();
    row.querySelector(".tc-lockwait")?.remove();
    const shell = row.querySelector(".tc-details");
    if (shell) shell.hidden = false;
    bundleOf(row)?.paint();
  }
}

// ---------------------------------------------------------------- コンピューターの操作
// 止める・別の会話を待つ・承認カード（docs/computer-use.md、ADR 0071・0073）。行と塊は web/render.mjs・web/tool-bundle.mjs、中身は web/computer-use.mjs

/** 塊の「止める」。その会話の走っているターンに止めた印を付ける（Esc と同じ。ターンは続き、エージェントには止められたと返る）。リモートの端末からも押せる */
async function stopComputer(bundle) {
  if (!state.current) return;
  bundle.setStopping(true);
  // 応答が来ないまま押せなくならないよう、一定時間で戻す（サーバーが知らないコマンドは黙って捨てられる）
  const silent = new Promise((_, reject) => setTimeout(() => reject(new Error(t("timeline.computer.bundle.stopFailed"))), 8000));
  try {
    const r = await Promise.race([cmd("computerStop", { sessionId: state.current }), silent]);
    if (r?.stopped === false) bundle.setStopping(false);
  } catch (e) {
    bundle.setStopping(false);
    if (bundle.stopEl) bundle.stopEl.title = e.message;
  }
}

/** 別の会話が操作中で待っている行を外し、行を戻す */
function clearLockWait(box) {
  const row = box.closest?.(".tc");
  box.remove();
  const shell = row?.querySelector(".tc-details");
  if (shell && !row.querySelector(".tc-appr")) shell.hidden = false;
}

/** この会話の computer.state に合わせて、走っているコンピューターの行を「別の会話（{題}）が操作中です。終わったら続けます」にする / 戻す */
function paintComputerWait() {
  const ev = state.computerStates.get(state.current);
  // 開き直した会話でロックを持っている（操作中）なら、最後の塊に「止める」を出す。履歴から作った塊は走っている行を持たない
  const bundles = [...thread.querySelectorAll(".bundle.cu")].map((n) => n.bundle).filter(Boolean);
  for (const b of bundles) b.setOperating(Boolean(ev) && b === bundles.at(-1), stopComputer);
  const rows = [...thread.querySelectorAll(".tc.tc-computer.tc-running")];
  const row = ev?.state === "waiting" ? rows.at(-1) : null;
  for (const box of thread.querySelectorAll(".tc-lockwait")) if (box.closest?.(".tc") !== row) clearLockWait(box);
  if (!row || row.querySelector(".tc-lockwait, .tc-appr")) return;
  const details = row.querySelector(".tc-details"), host = row.closest(".in") ?? row;
  const box = lockWaitBox(ev.holder, ev.since, (id) => select(id));
  swapHeight(host, () => { if (details) details.hidden = true; row.append(box); });
  fadeIn(box);
  bundleOf(row)?.reveal(row);
}

function onComputerState(ev) {
  if (!ev.sessionId) return;
  if (ev.state === "running" || ev.state === "waiting") state.computerStates.set(ev.sessionId, ev);
  else state.computerStates.delete(ev.sessionId);
  if (ev.sessionId === state.current) paintComputerWait();
}

/** アプリの承認を出す行。ツールの行が分かればその行、無ければ今の塊の最新の行（待っているのは今の呼び出しなので）。見つからなければ null（単独のカード） */
function computerApprovalRow(ev) {
  const live = (row) => (row?.isConnected && row.classList.contains("tc-computer") && bundleOf(row)?.live ? row : null);
  // 中継された承認（委譲の子の分）は、こちらの塊の行ではない
  if (relayLabel(ev.title)) return null;
  if (ev.toolUseID) return live(state.toolCards.get(ev.toolUseID));
  return live(state.bundle?.kind === "computer" ? state.bundle.cards.at(-1) : null);
}

/**
 * アプリの承認（permission の computerApp）。見出しは「{エージェント} に「{アプリ}」の操作を許可しますか？」、答えは
 * 「常に許可」（文字だけ）・「拒否」（薄い面）・「この会話で許可」（塗り）。置き場はツールの承認と同じ（塊の最新の行の場所 / 単独のカード）
 */
function computerApproval(ev, approval, row) {
  const canAlways = ev.canAlways !== false;
  const scoped = (scope) => ({ allow: true, always: scope === "always", scope });
  const verb = (scope) => (scope === null ? t("chat.approval.deny") : scope === "always" ? t("chat.approval.always") : t("chat.computerApproval.allowSession"));
  const mk = () => {
    const always = el("button", "btn", t("chat.approval.always"));
    const deny = el("button", "btn btn-quiet", t("chat.approval.deny"));
    const session = el("button", "btn btn-primary", t("chat.computerApproval.allowSession"));
    for (const b of [always, deny, session]) b.type = "button";
    return { always, deny, session, all: [always, deny, session] };
  };
  const b = mk();
  const res = el("span", "res");
  const send = async (scope, { buttons, onSending, onFailed }) => {
    onSending();
    res.className = "res";
    res.removeAttribute("role");
    res.replaceChildren(el("span", null, t("chat.approval.sending", { action: verb(scope) })));
    const arc = setTimeout(() => res.prepend(runMark()), 150);
    try {
      await cmd("resolvePermission", { id: ev.id, ...(scope === null ? { allow: false, always: false, messageKey: "userDenied" } : scoped(scope)) });
    } catch (err) {
      clearTimeout(arc);
      onFailed();
      if (alreadyResolved(err)) { foldElsewhere(ev.id); return false; }
      for (const x of buttons) x.disabled = false;
      res.className = "res fail";
      res.setAttribute("role", "alert");
      res.replaceChildren(`✕ ${t("chat.approval.sendFailedInline", { action: verb(scope), error: err.message })}`);
      return false;
    }
    clearTimeout(arc);
    return true;
  };

  if (row) {
    const details = row.querySelector(".tc-details");
    const line = row.querySelector(".tc-line");
    const host = row.closest(".in") ?? row;
    const box = el("div", "tc-appr");
    box.setAttribute("role", "group");
    box.dataset.permId = ev.id;
    box.setAttribute("aria-label", `${t("chat.approval.headingMark")}: ${approvalHeading(approval)}`);
    box.append(el("div", "h", t("chat.approval.headingMark")), approvalBody(approval, relayLabel(ev.title)));
    const acts = el("div", "acts");
    acts.append(res, ...(canAlways ? [b.always] : []), b.deny, b.session);
    box.append(acts);
    const settle = async (scope) => {
      if (box.dataset.sending) return;
      const ok = scope !== null;
      const ran = await send(scope, {
        buttons: b.all,
        onSending: () => {
          box.dataset.sending = "1";
          box.classList.add("sending");
          // 拒否の印は送る前に付ける（確認より先に結果が届いても、失敗と数えない）。送れなかったら外す
          if (!ok) row.dataset.denied = "1";
          for (const x of b.all) x.disabled = true;
        },
        onFailed: () => { delete box.dataset.sending; box.classList.remove("sending"); if (!ok) delete row.dataset.denied; },
      });
      if (!ran) return;
      // カードを行に戻す。補足は「この会話で許可した」「常に許可した」、拒否は右端に弱い字で「拒否した」
      swapHeight(host, () => {
        box.remove();
        if (details) details.hidden = false;
        row.classList.remove("tc-waiting");
        if (ok) {
          const said = el("span", "tc-note tc-said", approvalSaid(scope, true, approval));
          line.querySelector(".tc-res")?.before(said);
        }
        if (details) fadeIn(details);
        const finished = row.classList.contains("tc-done") || row.classList.contains("tc-error");
        if (ok) { if (!finished) markRunning(row); }
        else if (!finished) line.querySelector(".tc-res").textContent = t("chat.approval.denied");
      });
      bundleOf(row)?.paint();
      state.pendingPerms.delete(ev.id);
      if (isRunningHere()) { if (ok) activity.suspend(); else activity.show(t("activity.continuing")); }
    };
    b.session.onclick = () => settle("session");
    b.always.onclick = () => settle("always");
    b.deny.onclick = () => settle(null);
    markWaiting(row);
    swapHeight(host, () => { if (details) details.hidden = true; row.append(box); });
    fadeIn(box);
    bundleOf(row)?.reveal(row);
    openCards.add(ev.id, { el: box, sending: () => Boolean(box.dataset.sending), fold: () => foldApprovalRow(ev.id, { box, row, details, host }) });
    return box;
  }

  // 単独のカード（塊の外。委譲の子から中継された承認・開き直した会話）
  const m = el("div", "m card");
  const card = el("div", "card");
  m.append(card);
  const head = el("div", "card-head");
  head.append(...markedHead(t("chat.approval.heading", { mark: MARK }), t("chat.approval.headingMark")));
  const body = approvalBody(approval, relayLabel(ev.title));
  const actions = el("div", "card-actions cu-actions");
  actions.append(res, ...(canAlways ? [b.always] : []), b.deny, b.session);
  card.append(head, body, actions);
  const settle = async (scope) => {
    if (card.dataset.sending) return;
    const ok = scope !== null;
    const ran = await send(scope, {
      buttons: b.all,
      onSending: () => { card.dataset.sending = "1"; for (const x of b.all) x.disabled = true; },
      onFailed: () => { delete card.dataset.sending; },
    });
    if (!ran) return;
    if (card.classList.contains("done")) { state.pendingPerms.delete(ev.id); return; }   // 答えを待つ間に、よそで片付いて畳まれていた
    m.classList.add("done");
    m.closest(".mw")?.classList.add("done");
    card.classList.add("done");
    for (const rest of head.querySelectorAll(".card-kind-rest")) rest.remove();
    head.querySelector(".card-kind").textContent = t("chat.approval.done");
    head.append(el("span", "desc", approvalHeading(approval)), el("span", "res", `${approvalSaid(scope, ok, approval)} · ${hhmm(new Date())}`));
    body.remove();
    actions.remove();
    if (isRunningHere()) activity.show(ok ? t("activity.runningTool", { tool: "ply_computer" }) : t("activity.continuing"));
    state.pendingPerms.delete(ev.id);
  };
  b.session.onclick = () => settle("session");
  b.always.onclick = () => settle("always");
  b.deny.onclick = () => settle(null);
  placeCard(m, ev, null);
  registerRelayCard(ev, { m, card, head, code: null, actions, res, buttons: b.all, removeOnFold: [body], desc: approvalHeading(approval) });
  return m;
}

// 出ている設定の変更の承認カード（requestId -> 決着を受けて 1 行に畳む関数の集合。中継の複製も同じ requestId）
const settingCardsOpen = new Map();

/** 承認カードの決着（settingApproval イベント）を、カードの 1 行の言葉にする。許可した・できなかったは操作の言葉（「送信を許可した」など） */
function settingOutcomeText(change, outcome) {
  if (outcome === "allowed") return changeWord(change, "allowed");
  if (outcome === "denied") return t("chat.approval.denied");
  if (outcome === "failed") return changeWord(change, "failed");
  return t("chat.settingApproval.withdrawn");
}

/** サーバーから届いた決着。開いているカードは 1 行に畳み、押して畳んだカードは結果の言葉に合わせる（別の端末で答えた・取り下げた） */
function settleSettingCards(ev) {
  for (const settle of settingCardsOpen.get(ev.requestId) ?? []) settle(ev.outcome);
  settingCardsOpen.delete(ev.requestId);
}

/**
 * 設定の変更などの guarded の操作の承認（permission の settingChange。ADR 0082・0088）。会話の単独のカード: 呼び出しは承認を待たずに返り、カードはターンが終わっても残るので、
 * ツールの行の下には置かない（閉じた塊の中に隠れる）。ボタンは「拒否」と塗りの許可（操作の言葉。設定なら「変更を許可」、送信なら「送信を許可」）だけ（「常に許可」は出さない）。
 * 答えには出したカードの受領証を添える（サーバーが照合する）。押したら「◯◯を送っています…」でボタンを止め、受け取られてから 1 行に畳む
 * （失敗したら押す前の形に戻って押し直せる）。別の端末で答えた・取り下げた決着は settingApproval イベントで畳む。稼働表示は変えない（エージェントは続けている）
 */
function settingChangeApproval(ev, change) {
  const res = el("span", "res");
  const deny = el("button", "btn btn-quiet", t("chat.approval.deny"));
  const allow = el("button", "btn btn-primary", changeWord(change, "allow"));
  for (const b of [deny, allow]) b.type = "button";
  const buttons = [deny, allow];
  const verb = (ok) => (ok ? changeWord(change, "allow") : t("chat.approval.deny"));
  const m = el("div", "m card");
  const card = el("div", "card");
  m.append(card);
  const head = el("div", "card-head");
  head.append(...markedHead(t("chat.approval.heading", { mark: MARK }), t("chat.approval.headingMark")));
  const body = changeBody(change, relayLabel(ev.title));
  const actions = el("div", "card-actions cu-actions");
  actions.append(res, deny, allow);
  card.append(head, body, actions);
  let said = null;
  // 1 行に畳む。畳んだ後に届いた決着は、右端の言葉だけ合わせる
  const collapse = (text) => {
    if (said) { said.textContent = `${text} · ${said.dataset.at}`; return; }
    m.classList.add("done");
    m.closest(".mw")?.classList.add("done");
    card.classList.add("done");
    for (const rest of head.querySelectorAll(".card-kind-rest")) rest.remove();
    head.querySelector(".card-kind").textContent = t("chat.approval.done");
    said = el("span", "res", "");
    said.dataset.at = hhmm(new Date());
    said.textContent = `${text} · ${said.dataset.at}`;
    head.append(el("span", "desc", changeHeading(change)), said);
    body.remove();
    actions.remove();
    state.pendingPerms.delete(ev.id);
  };
  if (change.requestId) {
    if (!settingCardsOpen.has(change.requestId)) settingCardsOpen.set(change.requestId, new Set());
    settingCardsOpen.get(change.requestId).add((outcome) => collapse(settingOutcomeText(change, outcome)));
  }
  const settle = async (ok) => {
    if (card.dataset.sending) return;
    card.dataset.sending = "1";
    for (const b of buttons) b.disabled = true;
    res.className = "res";
    res.removeAttribute("role");
    res.replaceChildren(el("span", null, t("chat.approval.sending", { action: verb(ok) })));
    const arc = setTimeout(() => res.prepend(runMark()), 150);
    try {
      await cmd("resolvePermission", { id: ev.id, receipt: change.receipt, allow: ok, always: false, ...(ok ? {} : { messageKey: "userDenied" }) });
    } catch (err) {
      clearTimeout(arc);
      delete card.dataset.sending;
      if (alreadyResolved(err)) return collapse(t("chat.approval.elsewhere"));
      for (const b of buttons) b.disabled = false;
      res.className = "res fail";
      res.setAttribute("role", "alert");
      res.replaceChildren(`✕ ${t("chat.approval.sendFailedInline", { action: verb(ok), error: err.message })}`);
      return;
    }
    clearTimeout(arc);
    collapse(settingOutcomeText(change, ok ? "allowed" : "denied"));
  };
  allow.onclick = () => settle(true);
  deny.onclick = () => settle(false);
  placeCard(m, ev, null);
  return m;
}

// ---------------------------------------------------------------- 質問カード
// 質問は「危ないから承認する」ツールではなく、**こちらに聞いている**ツール。
// 承認チャネルはそのまま使い（core は保留・猶予をこの経路で面倒を見ている）、
// UI だけ専用のものにする。core が permission.kind === "question" として正規化して送ってくる。

/** 承認・質問のカードを置く。into を渡すとその筋（バックグラウンドのダイアログの子の会話）へ、無ければ会話へ */
function placeCard(m, ev, into) {
  if (into) { into.append(wrap(m, `perm:${ev.id}`)); return; }
  append(m, `perm:${ev.id}`);
  m.scrollIntoView({ block: "nearest" });   // あなたを待っている。見えていないと止まったまま
}

function questionCard(ev, into = null) {
  const qs = Array.isArray(ev.questions) ? ev.questions : [];
  if (!qs.length) return null;

  const m = el("div", "m card");
  const card = el("div", "card");
  m.append(card);
  const head = el("div", "card-head");
  head.append(...markedHead(t("chat.ask.heading", { mark: MARK }), t("chat.ask.headingMark")));
  head.append(el("span", "desc", ev.title ?? ""));
  // ホストの子の質問の中継（端末の会話のカード。⇄ ホスト名。オフラインの間は答えを止める）
  if (ev.remote) head.append(el("span", "relay-host", t("chat.approval.relay.host", { host: ev.remote.hostName })));
  card.append(head);

  // question文字列をキーに答えを集める（SDK の answers がその形）
  const picked = new Map();   // question -> Set<label>
  const notes = new Map();    // question -> 自由記述

  for (const q of qs) {
    const box = el("div", "q");
    box.append(el("div", "q-text", q.question ?? ""));
    const multi = Boolean(q.multiSelect);
    box.append(el("div", "q-note", `${q.header ? q.header + " · " : ""}${multi ? t("chat.ask.pickMany") : t("chat.ask.pickOne")}`));

    const opts = el("div", "opts");
    for (const o of q.options ?? []) {
      const b = el("button", "opt");
      b.type = "button";
      b.append(el("span", "opt-label", o.label ?? ""));
      if (o.description) b.append(el("span", "opt-desc", o.description));
      b.onclick = () => {
        const set = picked.get(q.question) ?? new Set();
        if (multi) { set.has(o.label) ? set.delete(o.label) : set.add(o.label); }
        else { set.clear(); set.add(o.label); }
        picked.set(q.question, set);
        for (const other of opts.querySelectorAll(".opt")) {
          other.classList.toggle("on", set.has(other.querySelector(".opt-label")?.textContent));
        }
        sync();
      };
      opts.append(b);

      // 選択肢に preview があれば畳んで見せる（コード片やモックが入る）
      if (o.preview) {
        const d = document.createElement("details");
        d.className = "opt-preview";
        const sm = document.createElement("summary");
        sm.textContent = t("chat.ask.preview", { label: o.label });
        const pre = el("pre");
        pre.append(el("code", null, o.preview));
        d.append(sm, pre);
        opts.append(d);
      }
    }
    box.append(opts);

    // 「その他」は選択肢に含めない決まりなので、こちらで用意する
    const other = document.createElement("input");
    other.className = "other";
    other.placeholder = t("chat.ask.other");
    other.oninput = () => { notes.set(q.question, other.value.trim()); sync(); };
    box.append(other);
    card.append(box);
  }

  const actions = el("div", "card-actions");
  const skip = el("button", "btn", t("chat.ask.skip"));
  skip.type = "button";
  const send = el("button", "btn btn-primary", t("chat.ask.answer"));
  send.type = "button";
  send.disabled = true;
  actions.append(skip, send);
  card.append(actions);

  function answersNow() {
    const out = {};
    for (const q of qs) {
      const set = picked.get(q.question);
      const free = notes.get(q.question);
      // 複数選択はカンマ区切り。SDK の出力仕様に合わせる
      const parts = [...(set ?? [])];
      if (free) parts.push(free);
      if (parts.length) out[q.question] = parts.join(", ");
    }
    return out;
  }

  function sync() {
    // 全部の質問に答えが付いたら送れるようにする
    send.disabled = Object.keys(answersNow()).length < qs.length;
  }

  // 承認カードと同じく、サーバーが受け取るまで「◯◯を送っています…」、受け取ってから決着。失敗したら戻して理由をカードの中に
  const res = el("span", "res");
  actions.prepend(res);
  async function settle(answers) {
    if (card.dataset.sending) return;
    card.dataset.sending = "1";
    const inputs = [...card.querySelectorAll("button, input")];
    const was = inputs.map((b) => b.disabled);
    for (const b of inputs) b.disabled = true;
    res.className = "res";
    res.removeAttribute("role");
    res.replaceChildren(el("span", null, t("chat.ask.sending")));
    const arc = setTimeout(() => res.prepend(runMark()), 150);
    try {
      await cmd("resolvePermission", { id: ev.id, allow: true, answers: answers ?? {} });
    } catch (e) {
      clearTimeout(arc);
      delete card.dataset.sending;
      if (alreadyResolved(e)) return foldElsewhere(ev.id);
      inputs.forEach((b, i) => { b.disabled = was[i]; });
      res.className = "res fail";
      res.setAttribute("role", "alert");
      res.replaceChildren(`✕ ${t("chat.ask.sendFailedInline", { error: e.message })}`);
      return;
    }
    clearTimeout(arc);
    if (card.classList.contains("done")) { state.pendingPerms.delete(ev.id); return; }   // 中継のカードは、決着の便りが先に届いて畳まれていることがある
    m.classList.add("done");
    m.closest(".mw")?.classList.add("done");
    card.classList.add("done");
    for (const rest of head.querySelectorAll(".card-kind-rest")) rest.remove();
    head.querySelector(".card-kind").textContent = t("chat.ask.done");
    const summary = answers
      ? qs.map((q) => `${q.header || q.question}: ${answers[q.question]}`).join(" / ")
      : t("chat.ask.skipped");
    actions.replaceChildren(el("span", "res", summary));
    if (isRunningHere()) activity.show(t("activity.continuing"));
    state.pendingPerms.delete(ev.id);
  }

  send.onclick = () => settle(answersNow());
  skip.onclick = () => settle(null);
  placeCard(m, ev, into);
  registerRelayCard(ev, { m, card, head, code: null, actions, res, question: true,
    get buttons() { return [...card.querySelectorAll("button, input")]; } });
  return m;
}

// ---------------------------------------------------------------- 承認カード
// モーダルは使わない。ブラウザのダイアログは以降のイベントを止めるうえ、
// 会話の流れから目を離させる（＝離れさせない、という価値命題に反する）。

let foldSeq = 0;
/**
 * 決着した承認カードの見出しを押せる一行にし、入力（code）を中に畳む。ツール名の後ろに対象の要約（等幅の弱い字、全体は title）。
 * ▸ はツールの行の折りたたみと同じ。Enter・Space でも開閉する。開いている間は 55% に沈めない（style.css）
 */
function foldSettledCard(card, head, code, target) {
  const caret = el("span", "caret", "▸");
  caret.setAttribute("aria-hidden", "true");
  head.prepend(caret);
  if (target) {
    const sum = el("span", "sum", target);
    sum.title = target;
    (head.querySelector(".tool") ?? head.querySelector(".card-kind")).after(sum);
  }
  const body = el("div", "done-body");
  body.id = `permDone${++foldSeq}`;
  body.hidden = true;
  body.append(code);
  card.append(body);
  head.classList.add("done-toggle");
  head.setAttribute("role", "button");
  head.tabIndex = 0;
  head.setAttribute("aria-expanded", "false");
  head.setAttribute("aria-controls", body.id);
  const toggle = () => {
    const open = head.getAttribute("aria-expanded") !== "true";
    head.setAttribute("aria-expanded", String(open));
    body.hidden = !open;
    card.classList.toggle("open", open);
  };
  head.onclick = toggle;
  head.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); } };
}

/**
 * ツールの承認を、走っているまとまりの最新の行の場所に出す（許可・拒否をその場で押せる）。決着したらカードが縮んで普通の行に戻り、
 * まとまりに残る（外に ◇ の 1 行を残さない）。行は「動詞・主役・補足」の並びのまま、押したら 3 つのボタンを止めて受け取りを待つ
 */
function rowApprovalCard(ev, row) {
  const details = row.querySelector(".tc-details");
  const line = row.querySelector(".tc-line");
  const host = row.closest(".in") ?? row;
  const box = el("div", "tc-appr");
  box.setAttribute("role", "group");
  box.dataset.permId = ev.id;
  const ln = el("div", "ln");
  for (const n of line.querySelectorAll(".tc-label, .tc-server, .tc-main, .tc-note")) ln.append(n.cloneNode(true));
  // 書き込みは行数を補足に（行の右端の結果は、書き終えてから出る）
  const change = row.toolChange;
  if (change && !change.del && change.add && !ln.querySelector(".tc-note")) ln.append(el("span", "tc-note", t("timeline.result.lines", { count: change.add, n: change.add })));
  box.append(el("div", "h", t("chat.approval.headingMark")), ln);
  box.setAttribute("aria-label", `${t("chat.approval.headingMark")}: ${line.querySelector(".tc-label")?.textContent ?? ""} ${line.querySelector(".tc-main")?.textContent ?? ""}`.trim());

  const canAlways = ev.canAlways && capsOf(activeBackendId()).alwaysAllow !== false;
  const acts = el("div", "acts");
  const res = el("span", "res");
  const always = el("button", "btn", t("chat.approval.always"));
  const deny = el("button", "btn btn-quiet", t("chat.approval.deny"));
  const allow = el("button", "btn btn-primary", t("chat.approval.allow"));
  for (const b of [always, deny, allow]) b.type = "button";
  acts.append(res, ...(canAlways ? [always] : []), deny, allow);
  box.append(acts);
  const buttons = [always, deny, allow];
  const verb = (ok, forever) => (ok ? (forever ? t("chat.approval.always") : t("chat.approval.allow")) : t("chat.approval.deny"));

  const settle = async (ok, forever = false) => {
    if (box.dataset.sending) return;
    box.dataset.sending = "1";
    box.classList.add("sending");
    // 拒否の印は送る前に付ける（確認より先に結果が届いても、失敗と数えない）。送れなかったら外す
    const change = row.toolChange;
    if (!ok) { row.dataset.denied = "1"; row.toolChange = null; }
    for (const b of buttons) b.disabled = true;
    res.className = "res";
    res.removeAttribute("role");
    res.replaceChildren(el("span", null, t("chat.approval.sending", { action: verb(ok, forever) })));
    const arc = setTimeout(() => res.prepend(runMark()), 150);
    try {
      await cmd("resolvePermission", { id: ev.id, allow: ok, always: forever, ...(ok ? {} : { messageKey: "userDenied" }) });
    } catch (e) {
      clearTimeout(arc);
      delete box.dataset.sending;
      box.classList.remove("sending");
      if (!ok) { delete row.dataset.denied; row.toolChange = change; }
      if (alreadyResolved(e)) return foldElsewhere(ev.id);
      for (const b of buttons) b.disabled = false;
      res.className = "res fail";
      res.setAttribute("role", "alert");
      res.replaceChildren(`✕ ${t("chat.approval.sendFailedInline", { action: verb(ok, forever), error: e.message })}`);
      return;
    }
    clearTimeout(arc);
    // カードを行に戻す。補足は「許可した」「常に許可した」、拒否は右端に弱い字で「拒否した」（失敗ではない。変更にも数えない）
    swapHeight(host, () => {
      box.remove();
      details.hidden = false;
      row.classList.remove("tc-waiting");
      const said = el("span", "tc-note", ok ? (forever ? t("chat.approval.allowedAlways") : t("chat.approval.allowed")) : "");
      line.querySelector(".tc-note")?.remove();
      if (ok) line.querySelector(".tc-res").before(said);
      fadeIn(details);
      // 結果が確認より先に届いていたら（tc-done / tc-error）、終わった行に弧を付けない
      const finished = row.classList.contains("tc-done") || row.classList.contains("tc-error");
      if (ok) { if (!finished) markRunning(row); }
      else if (!finished) line.querySelector(".tc-res").textContent = t("chat.approval.denied");
    });
    bundleOf(row)?.paint();
    state.pendingPerms.delete(ev.id);
    if (isRunningHere()) { if (ok) activity.suspend(); else activity.show(t("activity.continuing")); }
  };
  allow.onclick = () => settle(true);
  deny.onclick = () => settle(false);
  always.onclick = () => settle(true, true);

  markWaiting(row);
  swapHeight(host, () => { details.hidden = true; row.append(box); });
  fadeIn(box);
  bundleOf(row)?.reveal(row);
  // よそで片付いた。行へ戻すだけ（どう答えたかは分からない。結果はツールの流れで届く）
  openCards.add(ev.id, { el: box, sending: () => Boolean(box.dataset.sending), fold: () => foldApprovalRow(ev.id, { box, row, details, host }) });
  return box;
}

/** ツールの行の中の承認を、答えを待たずに畳んで普通の行へ戻す（rowApprovalCard・computerApproval の行） */
function foldApprovalRow(id, { box, row, details, host }) {
  state.pendingPerms.delete(id);
  if (!box.isConnected) return;   // 答えて、もう行へ戻っている
  swapHeight(host, () => {
    box.remove();
    if (details) { details.hidden = false; fadeIn(details); }
    row.classList.remove("tc-waiting");
  });
  bundleOf(row)?.paint();
  if (isRunningHere()) activity.show(t("activity.continuing"));
}

function permissionCard(ev, into = null) {
  if (into?.matches?.(".tc")) return rowApprovalCard(ev, into);
  const m = el("div", "m card");
  const card = el("div", "card");
  m.append(card);
  const head = el("div", "card-head");
  head.append(...markedHead(t("chat.approval.heading", { mark: MARK }), t("chat.approval.headingMark")));
  if (ev.browserSite) card.classList.add('browser-site-approval');
  if (!ev.browserSite) head.append(el("span", "tool", ev.toolName ?? ""));
  head.append(el("span", "desc", ev.title ?? ""));
  // ホストの子の承認の中継（端末の会話のカード。見出しに ⇄ ホスト名）。ホストの側の子のカードには、依頼元でも答えられる 1 行
  if (ev.remote) head.append(el("span", "relay-host", t("chat.approval.relay.host", { host: ev.remote.hostName })));
  card.append(head);
  if (ev.remoteOrigin) card.append(el("p", "relay-note", t("chat.approval.relay.hostCanAnswer", { device: ev.remoteOrigin.deviceName })));

  const input = JSON.stringify(ev.input ?? {}, null, 2);
  const short = input.length > 1200 ? input.slice(0, 1200) + NL + "…" : input;
  const code = el("div", "code-block");
  const pre = el("pre");
  pre.append(el("code", null, short));
  code.append(pre);
  if (!ev.browserSite) card.append(code);

  // Browser grants are owned by Pleiad, independent of backend tool permissions.
  const canAlways = ev.canAlways && (ev.browserSite || capsOf(activeBackendId()).alwaysAllow !== false);
  const actions = el("div", "card-actions");
  actions.append(el("span", "res", ev.browserSite ? '' : t("chat.approval.blocking")));
  const always = el("button", "btn", ev.browserSite ? t('settings.browser.confirm.alwaysSite') : t("chat.approval.always"));
  always.type = "button";
  const deny = el("button", "btn btn-quiet", ev.browserSite ? t('settings.browser.confirm.deny') : t("chat.approval.deny"));
  deny.type = "button";
  const allow = el("button", "btn btn-primary", ev.browserSite ? t('settings.browser.confirm.once') : t("chat.approval.allow"));
  allow.type = "button";
  if (ev.browserSite) { actions.append(allow); if (canAlways) actions.append(always); actions.append(deny); }
  else { if (canAlways) actions.append(always); actions.append(deny, allow); }
  card.append(actions);

  // 押したらサーバーが受け取るまで「◯◯を送っています…」（ボタンは止め、カードは待っている形のまま）。
  // 受け取ってから決着の一行に畳む。失敗したら押す前の形に戻し、左端の一行を理由に替えて押し直せるようにする
  // （docs/design-system.md §4.5。自動で送り直さない。承認は判断なので、つながった後に利用者がもう一度押す）
  const res = actions.querySelector(".res");
  const buttons = [always, deny, allow];
  const verb = (ok, forever) => (ok ? (forever ? t("chat.approval.always") : t("chat.approval.allow")) : t("chat.approval.deny"));
  const settle = async (ok, forever = false) => {
    if (card.dataset.sending) return;
    card.dataset.sending = "1";
    for (const b of buttons) b.disabled = true;
    res.className = "res";
    res.replaceChildren(el("span", null, t("chat.approval.sending", { action: verb(ok, forever) })));
    const arc = setTimeout(() => res.prepend(runMark()), 150);
    try {
      // 拒否の理由はエージェントに返る。画面の言語ではなく会話の言語で返すよう、文ではなく印を送る（サーバーが会話の言語で訳す）
      await cmd("resolvePermission", { id: ev.id, allow: ok, always: forever, ...(ok ? {} : { messageKey: "userDenied" }) });
    } catch (e) {
      clearTimeout(arc);
      delete card.dataset.sending;
      // 先によそで片付いていた。失敗ではないので、押す前の形には戻さず畳む
      if (alreadyResolved(e)) return foldElsewhere(ev.id);
      for (const b of buttons) b.disabled = false;
      res.className = "res fail";
      res.setAttribute("role", "alert");
      res.replaceChildren(`✕ ${t("chat.approval.sendFailedInline", { action: verb(ok, forever), error: e.message })}`);
      return;
    }
    clearTimeout(arc);
    // 中継のカードは、サーバーの決着の便り（permissionRelayEnd）が答えの応答より先に届いて、もう畳まれていることがある
    if (card.classList.contains("done")) { state.pendingPerms.delete(ev.id); return; }
    m.classList.add("done");
    m.closest(".mw")?.classList.add("done");
    card.classList.add("done");
    for (const rest of head.querySelectorAll(".card-kind-rest")) rest.remove();
    head.querySelector(".card-kind").textContent = t("chat.approval.done");
    head.append(el("span", "res", `${ok ? (forever ? t("chat.approval.allowedAlways") : t("chat.approval.allowed")) : t("chat.approval.denied")} · ${hhmm(new Date())}`));
    actions.remove();
    // 決着後は一行に畳み、押せば承認したときの入力をその場で開ける（何を許可・拒否したかを後からたどれる）
    if (!ev.browserSite) foldSettledCard(card, head, code, approvalTarget(ev.input));
    if (isRunningHere()) activity.show(ok ? t("activity.runningTool", { tool: ev.toolName }) : t("activity.continuing"));
    state.pendingPerms.delete(ev.id);
  };
  allow.onclick = () => settle(true);
  deny.onclick = () => settle(false);
  always.onclick = () => settle(true, true);
  placeCard(m, ev, into);
  registerRelayCard(ev, { m, card, head, code, actions, res, buttons });
  return m;
}

/** ホストの画面でしか答えられない承認の知らせ（答えるボタンは無い。「詳細を見る」は作業の窓のそのタスクの詳細を開く） */
function hostOnlyCard(ev, into = null) {
  const m = el("div", "m card");
  const card = el("div", "card");
  m.append(card);
  const head = el("div", "card-head");
  head.append(...markedHead(t("chat.approval.heading", { mark: MARK }), t("chat.approval.headingMark")));
  head.append(el("span", "desc", ev.title ?? ""), el("span", "relay-host", t("chat.approval.relay.host", { host: ev.remote.hostName })));
  // 「ホストで開く」は作業の窓の詳細の頭にあり、デスクトップ版の手元の窓にしか無い。ほかの端末では入口を書かない
  const viaDesktop = window.plyDesktop?.openRemoteSession && !window.plyRemote;
  card.append(head, el("p", "relay-note strong", viaDesktop ? t("chat.approval.relay.hostOnlyDesktop") : t("chat.approval.relay.hostOnly")));
  const actions = el("div", "card-actions");
  const res = el("span", "res");
  actions.append(res);
  card.append(actions);
  placeCard(m, ev, into);
  registerRelayCard(ev, { m, card, head, code: null, actions, res, buttons: [], hostOnly: true });
  return m;
}

// 出ている承認・質問のカード（permission id → カードの集合。web/card-roll.mjs）。ほかで片付いたときに畳むための名簿。
// 同じ承認のカードが 2 か所に出ることがある（ホストの子の承認は、依頼元の会話と作業の窓の詳細の両方）ので、id ごとに集合で持つ。
// 端末の会話のカード（ev.remote）はホストのオフラインでボタンを止め、ホストで先に答えられたら 1 行に畳む。
// ホストの側の子のカード（ev.remoteOrigin）は、端末で答えられたら 1 行に畳む（docs/remote.md §4.5、ADR 0146）。
// どのカードも、別の窓・別の画面（スマホ）・子の会話の側で片付いたら（permissionSettled・running の突き合わせ・ALREADY_RESOLVED）「別の場所で処理されました」に畳む
const openCards = createCardRoll();
// 走っている一覧（running の permissions）にもう無いカードを、この間だけ待ってから畳む（承認の便りと一覧の前後を吸収する）
const SETTLE_RECONCILE_MS = 2500;
const reconcileTimers = new Map();

/** 片付いた承認への答え（サーバーの ALREADY_RESOLVED）。失敗ではなく、別の場所で処理された知らせ */
const alreadyResolved = (err) => err?.code === "ALREADY_RESOLVED";

/** そのカードを「別の場所で処理されました」に畳む。出ていなければ何もしない */
function foldElsewhere(id) {
  state.pendingPerms.delete(id);
  openCards.fold(id, { by: "elsewhere" });
}

/** permissionSettled。この窓で答えを送っている最中のカードは、答えの応答で畳むのでここでは触らない（「許可した」と出すため） */
function onPermissionSettled(ev) {
  state.pendingPerms.delete(ev.id);
  if (openCards.has(ev.id) && !openCards.sending(ev.id)) foldElsewhere(ev.id);
}

/**
 * 取りこぼしに備えて、出ているカードを走っている一覧（running の permissions）と突き合わせる。
 * 一覧に無いカードは、少し待ってもまだ無ければ畳む（決着の便りを受け取れなかった窓・つなぎ直した画面）。
 * 消えた・答え終えたカードは名簿から外す（同じ承認のほかのカードは残す。集合が空になったら行ごと外す）
 */
function reconcileOpenCards() {
  const live = new Set((state.work.permissions ?? []).map((p) => p.id));
  openCards.prune();
  for (const id of openCards.ids()) {
    if (live.has(id) || reconcileTimers.has(id)) continue;
    reconcileTimers.set(id, setTimeout(() => {
      reconcileTimers.delete(id);
      if ((state.work.permissions ?? []).some((p) => p.id === id)) return;
      if (openCards.has(id) && !openCards.sending(id)) foldElsewhere(id);
    }, SETTLE_RECONCILE_MS));
  }
}

function registerRelayCard(ev, parts) {
  // removeOnFold・desc は、見出しの要約と本文が code の外にあるカード（コンピューターの操作の承認）が、畳むときに本文を外して要約を見出しへ移すため
  const { m, card, head, code, actions, res, buttons, question = false, hostOnly = false, removeOnFold = [], desc = "" } = parts;
  const blocking = ev.remote ? null : t("chat.approval.blocking");
  if (ev.remote && !detailCardMode) {
    // 詳細を見る（作業の窓のそのタスクの詳細。経過・同じカードで答えられる。どの端末の画面でも開ける）。詳細の中のカードには出さない
    const view = el("button", "btn btn-quiet", t("chat.approval.relay.viewDetail"));
    view.type = "button";
    view.onclick = () => openWork(`t:${ev.remote.taskId}`);
    actions.prepend(view);
  }
  const setOnline = (online) => {
    if (hostOnly || card.classList.contains("done") || card.dataset.sending) return;
    for (const b of buttons) b.disabled = !online;
    card.classList.toggle("relay-offline", !online);
    res.className = online ? "res" : "res strong";
    res.replaceChildren(online ? (blocking ?? "") : t("chat.approval.relay.offline", { host: ev.remote.hostName }));
    if (!online) res.setAttribute("role", "status"); else res.removeAttribute("role");
  };
  const fold = ({ by, allow, peer }) => {
    if (card.classList.contains("done")) return;
    // 誰がどこで答えたか分からない決着（つなぎ直しで消えた・タスクが止まった）は、カードごと下げる
    if (!by) { m.remove(); state.pendingPerms.delete(ev.id); return; }
    const what = question ? t("chat.approval.relay.answered") : allow ? t("chat.approval.allowed") : t("chat.approval.denied");
    // この端末（の別の窓）で答えた決着は、ふつうの承認と同じ「許可した · 時刻」。ホストで先に答えられたら「ホスト名で…」、ホストの子のカードは「端末名で…」。
    // 別の場所（別の窓・子の会話の側・ターンの終わりや中断）で片付いたものは、どう答えたかを問わず「別の場所で処理されました · 時刻」
    const line = by === "elsewhere" ? `${t("chat.approval.elsewhere")} · ${hhmm(new Date())}`
      : ev.remote ? (by === "device" ? `${what} · ${hhmm(new Date())}` : t("chat.approval.relay.answeredByHost", { host: peer || ev.remote.hostName, what, time: hhmm(new Date()) }))
      : t("chat.approval.relay.answeredByDevice", { device: peer || ev.remoteOrigin?.deviceName || "", what, time: hhmm(new Date()) });
    m.classList.add("done");
    m.closest(".mw")?.classList.add("done");
    card.classList.add("done");
    for (const rest of head.querySelectorAll(".card-kind-rest")) rest.remove();
    head.querySelector(".card-kind").textContent = question ? t("chat.ask.done") : t("chat.approval.done");
    if (desc) head.append(el("span", "desc", desc));
    head.append(el("span", "res", line));
    card.querySelector(".relay-note")?.remove();
    for (const n of removeOnFold) n.remove();
    actions.remove();
    if (code && !ev.browserSite) foldSettledCard(card, head, code, approvalTarget(ev.input));
    state.pendingPerms.delete(ev.id);
  };
  // 同じ承認のカードが依頼元の会話と詳細の両方に出ることがある。先に答えた方で決まり、残りは同じ決着で畳む（名簿は id ごとの集合）
  openCards.add(ev.id, { el: m, sending: () => Boolean(card.dataset.sending), setOnline, fold, update: (patch) => parts.onUpdate?.(patch) });
  if (ev.remote && ev.remote.online === false) setOnline(false);
}

/** 中継のカードの決着（permissionRelayEnd）と、ホストの接続の状態（permissionRelayState）。開いていないカードは何もしない */
function onRelayCardEvent(ev) {
  if (!openCards.has(ev.id)) return;
  if (ev.type === "permissionRelayState") for (const entry of openCards.of(ev.id)) entry.setOnline?.(ev.online !== false);
  else openCards.fold(ev.id, { by: ev.by, allow: ev.allow === true, peer: ev.peer ?? ev.hostName });
}

/**
 * permissionUpdate（ADR 0168）。決着していない承認の中身の差し替え。つなぎ直したときに描き直せるよう pendingPerms の写しも書き替え、
 * 出ているカードには update(ev) を渡す（種類ごとの描き方は、そのカードの parts.onUpdate が持つ。無ければ何もしない）
 */
function onPermissionUpdate(ev) {
  const pending = state.pendingPerms.get(ev.id);
  if (pending) state.pendingPerms.set(ev.id, { ...pending, browserHandoff: ev.browserHandoff });
  openCards.update(ev.id, ev);
}

/**
 * 承認・質問のカードを筋へ出す。届いたときと、その会話を開き直したときの両方から通る。
 * 同じ承認を二度描かない（枝の切り替えでは筋の前半が残るため）。
 */
function renderPermission(ev) {
  if (thread.querySelector(`.mw[data-key="perm:${CSS.escape(ev.id)}"], [data-perm-id="${CSS.escape(ev.id)}"]`)) return;
  // ホストの画面でしか答えられない承認（設定の変更など。ホストの子の承認の中継）は、答えるボタンの無い知らせのカード
  if (ev.remote?.hostOnly) { closeTurnEl(); activity.show(t("activity.waitingApproval")); return hostOnlyCard(ev); }
  // 設定の変更の承認（ply_control の guarded。ADR 0082）。読めなければ（形が違う）ふつうの承認として出す
  const settingChange = ev.settingChange ? approvalChange(ev.settingChange) : null;
  if (settingChange) {
    closeTurnEl();
    return settingChangeApproval(ev, settingChange);
  }
  // アプリの承認（コンピューターの操作）。アプリが読めなければ（形が違う）ふつうの承認として出す
  const computerApp = ev.computerApp ? approvalApps(ev.computerApp) : null;
  if (computerApp) {
    const row = computerApprovalRow(ev);
    if (row) { activity.suspend(); return computerApproval(ev, computerApp, row); }
    closeTurnEl();
    activity.show(t("activity.waitingApproval"));
    return computerApproval(ev, computerApp, null);
  }
  // ツールの承認で、そのツールの行が走っているまとまりの中にあるなら、まとまりを閉じずにその行の中に出す
  const row = ev.kind !== "question" && !ev.browserSite && ev.toolUseID ? state.toolCards.get(ev.toolUseID) : null;
  if (row?.isConnected && bundleOf(row)?.live) {
    activity.suspend();   // 承認カードが「承認を待っている」を語る
    return permissionCard(ev, row);
  }
  closeTurnEl();
  // 質問は承認ではない。専用のカードで選択肢を出す
  if (ev.kind === "question") {
    activity.show(t("activity.waitingAnswer"));
    const card = questionCard(ev);
    if (card) return card;
  }
  activity.show(t("activity.waitingApproval"));
  return permissionCard(ev);
}

/** 開いている会話で、まだ答えていない承認を描き直す。clearThread() の後に呼ぶ。 */
function paintPendingPerms(id) {
  for (const ev of state.pendingPerms.values()) if (ev.sessionId === id) renderPermission(ev);
}

// ---------------------------------------------------------------- 稼働表示
// 「動いているのか分からない」を無くす。何をしているかと、経過時間を出し続ける。
// 置き場は会話の筋の末尾の節（走っている間だけ存在し、新しい発言が来るとその下へ移る）。
// 節の代わりに弧が筋の上に載る。固定の帯や流れる線は置かない。

// main が返答を終え、裏の subagent などだけを待っている間（running のターン行の phase が waiting）は、
// 弧の代わりに衛星（§6）を置き、見出しを「サブエージェントを待っている」にする。
// その間に来る show()（subagent 側のツール名など）は text に覚えるだけで、見出しは変えない。

/** ターン行 -> 裏を待っているなら { n, label }、そうでなければ null */
// 委譲した Pleiad タスク（ply_delegate の子の会話）も、この会話の裏で動いている子として数える
const behindOf = (t) => (t?.phase === "waiting"
  ? behindOfTasks([...(t.background ?? []), ...liveTasksOf(state.work.tasks, t.sessionId)], { waiting: true }) : null);
/**
 * この画面の会話が裏を待っているか。ターンが走っていればターン行（Claude の phase: waiting）、
 * 走っていなければ running の background（Codex: ターンは終わったがバックグラウンド端末が残っている）
 */
function behindHere() {
  const t = (state.work.turns ?? []).find(belongsHere);
  if (t) return behindOf(t);
  const b = (state.work.background ?? []).find(belongsHere);
  const all = [...(b?.tasks ?? []), ...liveTasksOf(state.work.tasks, state.current)];
  return all.length ? behindOfTasks(all) : null;
}

const activity = {
  t0: 0,
  timer: null,
  markTimer: null,
  el: null,          // .m.activity
  text: "",
  behind: null,      // behindOf() の結果。裏を待っている間だけ
  idleTimer: null,   // ツールが終わってから稼働表示を戻すまでの短い待ち（afterTool）
  suspended: false,  // ツールの行が今の状態を語っている間。汎用の activity 事象（passive）は出さない
  shape: "",         // 今の印（run / sat:N / none）。変わったときだけ差し替える
  /** ターンは終わり、待てない裏の作業（端末・裏のコマンド）だけが残っている。印も経過時間も出さない（§6.1） */
  idleOnly() {
    return !this.behind && !isRunningHere() && backgroundCounts().live > 0;
  },
  shapeNow() {
    return this.behind ? `sat:${this.behind.n}` : this.idleOnly() ? "none" : "run";
  },
  mark() {
    this.shape = this.shapeNow();
    if (this.behind) return satMark(this.behind.n, t("activity.behindCount", { count: this.behind.n }));
    return this.shape === "none" ? el("span", "activity-none") : runMark(t("activity.turnRunning"));
  },
  paint() {
    this.el.querySelector(".txt").textContent = this.behind ? this.behind.label : this.idleOnly() ? t("activity.backgroundOnly") : this.text;
    this.el.querySelector(".el").hidden = this.idleOnly();
  },
  /** 印を今の状態（弧 / 衛星 / なし）に差し替える */
  remark() {
    this.el?.closest(".mw")?.querySelector(".activity-tip")?.replaceChildren(this.mark());
  },
  /**
   * ツールの行（走っている最新の行・承認カード）が今の状態を語っているときは、末尾の稼働表示を出さない（同じ内容を 2 か所に書かない）。
   * 経過は覚えておく（次に出すときも続きから数える）。裏の衛星だけは残す: 衛星の置き場はここしか無いので、
   * ツールの文言は重ねずに衛星の行にする
   */
  suspend() {
    clearTimeout(this.idleTimer);
    this.idleTimer = null;
    this.suspended = true;
    if (!this.t0) this.t0 = Date.now();
    if (behindHere()) return this.show(this.text || ACTIVITY_LABEL.running, { keepSuspended: true });
    clearTimeout(this.markTimer);
    this.markTimer = null;
    this.behind = null;
    this.shape = "";
    this.el?.closest(".mw")?.remove();
    this.el = null;
    relayoutBranches();
  },
  /** ツールの結果が届いた。すぐ次のツールが始まらず、走っている行も無いなら、行に出ていない待ちとして稼働表示を戻す */
  afterTool() {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      // 走っている・承認を待っている行が今のまとまりに無いときだけ（前のターンの残骸や他の会話の行は見ない）
      const busy = (state.bundle?.cards ?? []).some((c) => c.classList.contains("tc-running") || c.classList.contains("tc-waiting"));
      if (isRunningHere() && !busy) this.show(ACTIVITY_LABEL.running);
    }, 600);
  },
  show(text, { delayMark = false, passive = false, keepSuspended = false } = {}) {
    // 汎用の事象（動いている・待っている）は、ツールの行が語っている間は出さない
    if (passive && this.suspended && !behindHere()) return;
    clearTimeout(this.idleTimer);
    this.idleTimer = null;
    if (!keepSuspended) this.suspended = false;
    // 中断を頼んだ後は、止まり終えるまで何が流れてきても「中断している」のまま出す
    if (stoppingHere()) text = ACTIVITY_LABEL.stopping;
    this.text = text;
    if (!this.t0) this.t0 = Date.now();
    this.behind = behindHere();
    // ターンが終わって裏だけが残った、またはその逆。出ている節の印を差し替える
    if (this.el?.isConnected && this.shape !== this.shapeNow()) this.remark();
    if (!this.el?.isConnected) {
      const m = el("div", "m activity");
      m.append(el("span", "txt"), el("span", "el"));
      const w = append(m, "activity");
      const tip = el("span", "activity-tip");
      if (!delayMark) tip.append(this.mark());
      w.querySelector(".mw-gutter").append(tip);
      this.el = m;
    }
    const tip = this.el.closest('.mw').querySelector('.activity-tip');
    if (delayMark) {
      if (!tip.children.length && !this.markTimer) this.markTimer = setTimeout(() => {
        this.markTimer = null;
        if (this.el?.isConnected && !tip.children.length) tip.append(this.mark());
      }, 150);
    } else {
      clearTimeout(this.markTimer);
      this.markTimer = null;
      if (!tip.children.length) tip.append(this.mark());
    }
    this.paint();
    relayoutBranches();
    syncWorkEntry();
    this.timer ??= setInterval(() => {
      const s = Math.round((Date.now() - this.t0) / 1000);
      const e = this.el?.querySelector(".el");
      if (e) e.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
    }, 1000);
  },
  /** running が変わった。裏を待っているかどうかで印と見出しを差し替える（表示中のときだけ） */
  sync() {
    if (!this.el?.isConnected) return;
    const was = this.behind;
    this.behind = behindHere();
    if (this.shape !== this.shapeNow()) this.remark();
    // 待っている間に覚えた text は subagent 側のもの。main が戻ったら一旦中立の語にする
    if (was && !this.behind) this.text = ACTIVITY_LABEL.running;
    this.paint();
    syncWorkEntry();
  },
  hide() {
    clearInterval(this.timer);
    clearTimeout(this.idleTimer);
    this.idleTimer = null;
    this.suspended = false;
    clearTimeout(this.markTimer);
    this.timer = null;
    this.markTimer = null;
    this.t0 = 0;
    this.text = "";
    this.behind = null;
    this.shape = "";
    this.el?.closest(".mw")?.remove();
    this.el = null;
  },
};

// ---------------------------------------------------------------- thinking
// 既定は閉じておく。読みたいときだけ開ける（畳んだままでも「考えた」ことは見える）。

function thinkBox() {
  if (state.thinkEl) return state.thinkEl;
  const d = document.createElement("details");
  d.className = "think live";
  const s = document.createElement("summary");
  s.textContent = ACTIVITY_LABEL.thinking;
  const body = el("div", "think-body");
  d.append(s, body);
  openTurnEl().append(d);
  state.thinkEl = d;
  return d;
}

function closeThink() {
  if (!state.thinkEl) return;
  const d = state.thinkEl;
  d.classList.remove("live");
  const n = d.querySelector(".think-body").textContent.length;
  d.querySelector("summary").textContent = t("chat.thought", { count: n, chars: fmt.number(n) });
  state.thinkEl = null;
}

/** 履歴から復元するときの thinking。最初から閉じた状態で作る。 */
function thinkFromText(text) {
  const d = document.createElement("details");
  d.className = "think";
  const s = document.createElement("summary");
  s.textContent = t("chat.thought", { count: text.length, chars: fmt.number(text.length) });
  const body = el("div", "think-body", text);
  d.append(s, body);
  return d;
}

// ---------------------------------------------------------------- ターンの流れ
// core が正規化して送ってくる（プロトコル v3）。エージェントごとの差は core で吸収済み。

// 本文の描き直しは 1 コマに 1 回。デルタは文字を貯めるだけにする（正本は本文の要素の dataset.raw）。
// デルタごとに返答の全体を Markdown から作り直し、会話全体のレイアウトを強制すると、スマホの CPU では
// デルタの間隔に追いつかず、数秒〜十数秒コマが出なかった（issue #37）。
// 流れが終わる所（text.end・ツール・thinking・発言を閉じる・中断・会話の切り替え）では、貯めた分を同期で描き切る（endStream・closeTurnEl）。
let streamFrame = 0, streamTarget = null;

/** 貯めた分を今描く。末尾を見ていたときだけ末尾へ追う（読み返している人を引き戻さない） */
function flushStream() {
  if (streamFrame) cancelAnimationFrame(streamFrame);
  streamFrame = 0;
  const target = streamTarget;
  streamTarget = null;
  if (!target) return;
  const stick = target.isConnected && atBottom();
  target.innerHTML = renderAssistantMarkdown(target.dataset.raw);
  if (!target.isConnected) return;
  relayoutBranches();
  if (stick) log.scrollTop = log.scrollHeight;
}

/** 筋ごと捨てるとき（会話の切り替え）。貯めた分は捨てる本文の要素の中にあり、別の会話には描かない */
function cancelStream() {
  if (streamFrame) cancelAnimationFrame(streamFrame);
  streamFrame = 0;
  streamTarget = null;
}

/** 追記中の本文を終える。貯めた分を描き切ってから、次の本文・ツール・発言に移る */
function endStream() {
  flushStream();
  state.streamEl = null;
}

function appendText(text) {
  closeThink();
  // 稼働表示は文言が変わったときだけ更新する（show は行の置き直し・筋の貼り直し・作業の入口の更新まで行う）
  const label = stoppingHere() ? ACTIVITY_LABEL.stopping : ACTIVITY_LABEL.writing;
  if (!activity.el?.isConnected || activity.text !== label) activity.show(ACTIVITY_LABEL.writing);
  if (!state.streamEl) {
    // 閉じた発言の後は streamEl がリセットされるため、本文を作る前に開く。
    const turn = openTurnEl();
    closeBundle();
    state.streamEl = el("div", "body");
    state.streamEl.dataset.raw = "";
    turn.append(state.streamEl);
  }
  state.streamEl.dataset.raw += text;
  streamTarget = state.streamEl;
  streamFrame ||= requestAnimationFrame(flushStream);
}

const ACTIVITY_LABEL = {
  thinking: t("activity.thinking"),
  writing: t("activity.writing"),
  compacting: t("activity.compacting"),
  waiting: t("activity.waiting"),
  running: t("activity.running"),
  stopping: t("activity.stopping"),   // 中断を受け付けた。バックエンドが止まり終えるまで（server の abort が出す）
};

// ---------------------------------------------------------------- イベント

/**
 * このイベントを今の画面に描いてよいか。
 * サーバは全部のタブに配るので、別セッションの流れが混ざりうる。
 * 自分が走らせているターンのものか、いま開いているセッションのものだけを描く。
 * ※ tests/unit/stream-routing.mjs に同じ規則を写してある。変えたら合わせること。
 */
function isMine(ev) {
  if (ev.type === "running") return true;      // 全体の状況。セッションに紐づかない
  const id = ev.sessionId;
  if (!id) return true;                       // セッションに紐づかないものは通す

  // 基準は「実行中かどうか」ではなく「いま何を表示しているか」。
  if (state.current) return id === state.current;

  // 新規セッションは最初の session イベントまで id が分からない。
  // 自分が送った直後だけ、しかも `first` の付いた session からのみ採用する
  // （本文の流れから拾うと、別タブが走らせたターンを取り違えうる。first の無い session は
  // 再開ターンのモデル通知でも流れるので、それを掴むと他所の id を自分のものにしてしまう）。
  if (state.awaitingSession && ev.type === "session" && ev.first) {
    state.current = id;
    filePreview.sessionAssigned(id);
    syncWorkEntry();
    state.awaitingSession = false;
    // 自分が走らせたターン。サーバの running が id を載せて来るまでの間も「走っている」扱いにする
    // （ここで止まっていると見なすと、追記中の発言が途中で閉じられる）
    state.runningIds.add(id);
    state.submitting = false;
    syncTopbar();
    return true;
  }
  return false;
}

// ---- 途中送信の配達（server の userMessage.pending / userMessage.delivered）
//
// 受理（吹き出しを出す）と「エージェントに渡った」は別の瞬間。渡るまでの間だけ、吹き出しの下に
// 回る弧と一言を出す（docs/design-system.md §6。印は待っている間しか DOM に置かない）。
// 渡ったら「AIへ送信済み」に戻し、渡らないままターンが終わったら、次のターンで答えることを言う。
const deliveredEarly = new Set();   // 吹き出しより先に届いた配達の合図
// 声で送った発言の配送の一行（3 つの言い方。web/voice/delivery.mjs）。入力欄から送った発言の言い方は変えない
const voiceDelivery = createVoiceDelivery({ cancel: (item) => cmd('messageAction', { sessionId: state.current, messageId: item.id, action: 'cancel' }) });
const deliveryTimers = new WeakMap();
const DELIVERY = {
  sending: t('chat.delivery.sending'),
  pending: t('chat.delivery.pending'),
  late: t('chat.delivery.late'),
  sent: t('chat.delivery.sent'),
};
const messageRow = (messageId) => (messageId
  ? [...thread.querySelectorAll('.mw[data-message-id]')].find(w => w.dataset.messageId === messageId)
  : null) ?? null;
function markDelivery(row, kind) {
  const status = row.querySelector('.outbox-status');
  if (!status) return;
  clearTimeout(deliveryTimers.get(row));
  if (kind === 'pending') row.dataset.deliveryPending = '1';
  else delete row.dataset.deliveryPending;
  if (kind === 'sending') row.dataset.deliverySending = '1';
  else delete row.dataset.deliverySending;
  const waiting = kind === 'pending' || kind === 'sending';
  if (voiceDelivery.isVoice(row) && voiceDelivery.mark(row, kind)) return;
  status.replaceChildren(DELIVERY[kind]);
  status.classList.remove('outbox-status-failed');
  status.classList.toggle('outbox-status-mark', waiting);
  if (waiting) deliveryTimers.set(row, setTimeout(() => {
    if (row.isConnected && status.textContent === DELIVERY[kind])
      status.prepend(runMark(kind === 'sending' ? DELIVERY.sending : t('chat.delivery.notYet')));
  }, 150));
}

function ensureMessageRow(messageId, text, at, sentBy = null) {
  let row = messageRow(messageId);
  if (!row) {
    const presents = provisionalByMessage.get(messageId) ?? [];
    provisionalByMessage.delete(messageId);
    row = append(userMsg(text, { at, presents, sentBy }), `live:${++liveSeq}`);
    row.dataset.messageId = messageId;
    if (voiceDelivery.owns(messageId)) voiceDelivery.adopt(row);
  } else if (sentBy) markSentBy(row.querySelector('.m.user') ?? row, sentBy);
  if (!row.querySelector('.outbox-status')) row.querySelector('.m').append(el('div', 'outbox-status'));
  return row;
}

function markFailedMessage(row, item) {
  const status = row.querySelector('.outbox-status');
  clearTimeout(deliveryTimers.get(row));
  delete row.dataset.deliveryPending;
  delete row.dataset.deliverySending;
  status.classList.remove('outbox-status-mark');
  status.classList.add('outbox-status-failed');
  const reason = item.error ? ` · ${item.error}` : '';
  status.replaceChildren(el('b', null, t('chat.delivery.failed')), document.createTextNode(reason));
  for (const [action, label] of [['retry', t('outbox.retry')], ['cancel', t('outbox.cancel')]]) {
    const button = el('button', 'btn', label);
    button.type = 'button';
    button.onclick = async () => {
      button.disabled = true;
      try { await cmd('messageAction', { sessionId: state.current, messageId: item.id, action }); }
      catch (e) { status.childNodes[1].textContent = ` · ${e.message}`; }
      finally { button.disabled = false; }
    };
    status.append(button);
  }
}

function syncOutboxRows(messages) {
  if (!state.current || state.loadingSession) { paintOutbox(); return; }
  let withdrawn = false;
  for (const item of messages ?? []) {
    const row = messageRow(item.id);
    // 声で送った発言は、送信待ちでも会話の行に残す（時計の一行と［取り消す］。入力欄の脇の一覧にも出さない）
    if (item.status === 'queued' && (item.waiting || row?.dataset.messageStarted) && voiceDelivery.isVoice(row)) { voiceDelivery.queued(row, item); continue; }
    if ((item.status === 'queued' && (item.waiting || row?.dataset.messageStarted))
      || ['paused', 'unknown', 'cancelled'].includes(item.status)) {
      if (row) { row.remove(); withdrawn = true; }
    } else if (item.status === 'failed') {
      markFailedMessage(ensureMessageRow(item.id, item.args.prompt, item.at, item.args.sentBy), item);
      const failure = turnErrorRows.get(state.current);
      if (failure?.messageId === item.id) {
        failure.node.closest('.mw')?.remove();
        turnErrorRows.delete(state.current);
        withdrawn = true;
      }
    } else if (item.status === 'sending' && row) {
      row.dataset.messageStarted = '1';
      if (!row.dataset.deliveryPending) markDelivery(row, 'sending');
    }
  }
  if (withdrawn) relayoutBranches();
  paintOutbox();
}

function onEvent(ev, replay = false) {
  // bot・Channels・ルーティンの画面（web/channels/）。この画面の出来事ならここで終わる。ほかの出来事（permission など）も部品へ渡る
  // スレッドが動いた・投稿が増えた・既読が進んだ: 脇のスレッドの行を読み直す（まとめて 1 回）
  if (THREAD_INDEX_EVENTS.has(ev.type)) loadThreadIndexSoon();
  if (ev.type === 'botsChanged') homeDest.botsChanged();
  if (channelsUi.onEvent(ev, replay)) return;
  if (ev.type === 'notificationsChanged') { notificationInbox.onEvent(ev); return; }
  if (ev.type?.startsWith('shell.')) return onShellEvent(ev);
  if (ev.type === 'completionReady') {
    completionNotifications.completed(ev, state.sessions.find(s => s.id === ev.sessionId), replay);
    // スマホのアプリでは、最初の作業が終わったときに「離れていても知らせますか？」を尋ねる
    // bot の会話（隠れた夜の整理・心拍を含む）の完了は、利用者が待っていた作業ではないので数えない
    if (ev.outcome !== 'error' && !ev.bot) void mobileNotify.completed(replay);
    return;
  }
  if (ev.type === 'notifyStatus') { notifySettings.event(ev); return; }
  if (ev.type === 'outbox') {
    outboxes.set(ev.sessionId, ev.messages);
    if (state.current === ev.sessionId) syncOutboxRows(ev.messages);
    return;
  }
  if (ev.type === "turnEnd" && ev.sessionId) {
    // ターンが終わったのに「送信中」のままの吹き出し（渡った合図が来なかった）は片付ける。失敗なら outbox が先に失敗へ替えている
    if (ev.sessionId === state.current && !ev.requeued) {
      for (const row of thread.querySelectorAll('.mw[data-delivery-sending]')) markDelivery(row, 'sent');
    }
    const s = state.sessions.find(s => s.id === ev.sessionId);
    // requeued は完了ではない（何も届かず送信待ちへ戻った）。完了時刻も既読も触らない
    if (s && !ev.requeued) s.completedAt = ev.completedAt;
    // 中断で終わったら {at, reason}、ほかは null（docs/design-system.md「中断と再開」）。載せない古いサーバーでは触らない
    if (s && !ev.requeued && 'interrupted' in ev) s.interrupted = ev.interrupted ?? null;
    if (ev.sessionId === state.current && !state.loadingSession && !ev.requeued) {
      displayedCompletions.set(ev.sessionId, ev.completedAt);
      if (document.visibilityState === "visible") readCompletions.mark(ev.sessionId, ev.completedAt);
    }
    // Process completion for every session, before filtering events to the open conversation.
    state.runningIds.delete(ev.sessionId);
    // ターンを回した分だけ使用量が動く。ヘッダーのチップをそのエージェントの分だけ取り直す（読み直しの再生では取らない）
    if (!replay && !ev.requeued) headerUsage.turnEnded(s?.backend);
    renderSessions();
    if (ev.sessionId !== state.current) scheduleRefresh();
  }
  // 承認は一度きりしか届かない。開いていない会話の分も覚えておき、開いたときに描く
  // （覚えずに捨てると、一覧は「承認待ち」なのにカードがどこにも出ない）
  if (ev.type === "permission" && ev.id) {
    state.pendingPerms.set(ev.id, ev);
    completionNotifications.waiting(ev, state.sessions.find(s => s.id === ev.sessionId), replay);
  }
  if (!replay && sessionLoads.capture(ev, state.current)) return;
  if (ev.type === "prefs") { state.prefs = ev.prefs ?? {}; applyLocale(ev.locale); paintAutoCompactionSettings(); browserSettings.paint(); computerSettings.paint(); refreshPreviewConfirmation(); filePreview.prefsChanged(); sessionContext.refresh(); return; }
  if (ev.type === 'autoCompactionSettings') { state.prefs.autoCompaction = ev.settings; paintAutoCompactionSettings(); return; }
  if (ev.type === 'schedules') {
    state.schedules = ev.entries ?? [];
    paintOutbox(); renderSessions();
    channelsUi.schedulesChanged();   // スレッドへの返信の予定（kind post）の行
    return;
  }
  // どの口（画面・AI・CLI）から設定を変えても届く。prefs などの既存の配信が無い設定（コンテキストの既定）は、開いている設定の画面がここで取り直す
  if (ev.type === 'settingsChanged') { window.dispatchEvent(new CustomEvent('ply:settings-changed', { detail: ev })); voiceSettings.event(ev); if (ev.keys?.includes?.('voice')) voiceUi.refresh({ changed: true }); return; }
  // 通話に使うキーの選び直し・差し替え・削除（設定 › 通話。core/voice/host.mjs）
  if (ev.type === 'voiceChanged') { voiceSettings.event(ev); voiceUi.refresh({ changed: true }); return; }
  // API キーの登録・差し替え・削除・割り当て・確認の結果（設定 › API キー。core/api-keys.mjs）。キーを選ぶ 3 つの画面も取り直す
  if (ev.type === 'apiKeysChanged') { apiKeysSettings.event(ev); voiceSettings.event(ev); delegationSettings.event(ev); compatEndpoints.keysChanged(); return; }
  // 設定の変更の承認が決着した（どの端末で答えても・取り下げても）。開いているカードを 1 行に畳む（ADR 0088）
  if (ev.type === 'settingApproval') { settleSettingCards(ev); return; }
  // 承認が片付いた（子の会話・別の窓・ターンの終わりや中断で）。開いていない会話の分の覚えと、子の会話のダイアログのカードも畳むので、会話の絞り込みの前に受ける
  if (ev.type === 'permissionSettled') { onPermissionSettled(ev); return; }
  if (ev.type === 'compactionSchedule') {
    const row = state.sessions.find(s => s.id === ev.sessionId);
    if (row) row.compactionAt = ev.at;
    if (ev.sessionId === state.current) { state.compactionAt = ev.at; paintContextStrip(); }
    renderSessions(); return;
  }
  if (ev.type === 'conversationAutoCompaction') {
    const row = state.sessions.find(s => s.id === ev.sessionId);
    if (row) row.autoCompactionOff = ev.off;
    return;
  }
  if (ev.type === 'compaction' && ev.sessionId) {
    const row = state.sessions.find(s => s.id === ev.sessionId);
    if (row && ev.phase === 'complete' && ev.trigger !== 'manual') row.compacted = true;
    renderSessions();
  }
  // 別の窓・別の端末（この窓も含む）で完了を確認した。一覧の青い丸だけが変わる
  if (ev.type === "read") { if (readCompletions.apply(ev.reads)) renderSessions(); return; }
  // Pleiad に登録した外部 MCP のログインの進み具合。会話には出さず、設定 › コンテキストと会話の右パネル（web/context.mjs・web/session-context.mjs）へ渡す
  if (ev.type === 'mcpAuth') { window.dispatchEvent(new CustomEvent('ply:mcp-auth', { detail: ev })); return; }
  // Claude のアカウントの認可（claude setup-token / 使用量の claude auth login）の進み具合。設定のアカウントの画面へ渡す
  if (ev.type === 'claudeLogin') { claudeAccounts.loginEvent(ev); return; }
  // リモート（ホスト側）の状態とペアリング。承認のダイアログはどの画面にいても出す（web/remote.mjs）
  if (ev.type === 'remoteStatus' || ev.type === 'remotePairing') { remoteSettings.event(ev); return; }
  // worktree が増えた・消えた。開いている右パネルの「残っている worktree」を取り直す
  // 委譲の子の worktree が片付くと、カードの「未取り込み」の印が変わる（worktree.live）
  if (ev.type === 'worktreesChanged') { gitPanel?.changed(); loadTaskCards(state.current).then(repaintTasks).catch(() => {}); return; }
  // 委譲の振り分けの設定・キー・使用量が変わった。設定 › 委譲を開いていれば取り直す
  if (ev.type === 'delegationRoutingChanged') { delegationSettings.event(ev); return; }
  // 依頼元が委譲の子の設定を替えた（ADR 0134）。持っている行なら読み直す（終わったタスクは running に載らないため）
  if (ev.type === 'agentTaskChanged') { if (taskCards.rows.has(ev.taskId)) fetchTaskCards([ev.taskId]).catch(() => {}); return; }
  // コンピューターの操作の状態（別の会話が操作中で待っている）。全部の会話の分が届くので、開いている会話の分だけ行に出す
  if (ev.type === 'computer.state') { onComputerState(ev); return; }
  // エージェントのブラウザー（PC の Chrome）への接続の状態。ホストの画面だけに届く（設定 › ブラウザー）
  if (ev.type === 'chromeBrowser') { browserSettings.chromeEvent(ev); return; }
  // 会話の Chrome の窓の有無と、エージェントが操作中か（リモートの端末にも届く）
  if (ev.type === 'chromeWindow') { if (chromePanel ? chromePanel.windowEvent(ev) : chromeWindows.apply(ev)) chromeEntry?.paint(); return; }
  if (!isMine(ev)) {
    // 一覧に効くものだけは取り込む（画面には出さない）。セッションに紐づかないもの（statusIcon 等）はここへ来ない
    if (["status", "group", "title", "fork", "mode", "model", "cwd", "backend", "nextSettings"].includes(ev.type)) {
      // 家族の枝の名前が変わったなら、筋と分岐点の印にも出す
      if (ev.type === "title" && branches.has(ev.sessionId)) return scheduleRefresh().then(paintBranchNames);
      // 開いている会話から枝が分かれた（fork イベントは子の id で来るのでここへ落ちる）
      if (ev.type === "fork") return scheduleRefresh().then(() => reloadBranches(ev));
      scheduleRefresh();
    }
    return;
  }
  switch (ev.type) {
    case 'contextWindow': state.contextWindow = ev; paintContextStrip(); return;
    case 'compaction': acceptCompaction(ev); return;
    case 'userMessage': {
      if (replay && ev.messageId === state.initialMessageId) {
        const row = ensureMessageRow(ev.messageId, ev.text, ev.at, ev.sentBy);
        const confirmed = row.dataset.delivered === '1' || deliveredEarly.delete(ev.messageId);
        if (confirmed) row.dataset.delivered = '1';
        markDelivery(row, ev.pending && !confirmed ? 'sending' : 'sent');
        syncOutboxRows(outboxes.get(state.current) ?? []);
        return;
      }
      closeTurnEl();
      const row = ev.messageId ? ensureMessageRow(ev.messageId, ev.text, ev.at, ev.sentBy)
        : append(userMsg(ev.text, { at: ev.at, sentBy: ev.sentBy }), `live:${++liveSeq}`);
      if (!row.querySelector('.outbox-status')) row.querySelector('.m').append(el('div', 'outbox-status'));
      row.dataset.messageStarted = '1';
      const userRow = row.querySelector('.m.user');
      // 本文が同じなら描き直さない（送った直後の画像の枠を、読み込みの途中でやり直さない）
      if (userRow?.querySelector(':scope > .body') && userRaw(userRow) !== String(ev.text ?? '')) paintUser(userRow, ev.text, userRow.attached ?? []);
      if (ev.at) { row.querySelector('.m').dataset.at = ev.at; row.querySelector('.who .when').textContent = hhmm(ev.at); }
      if (ev.scheduledFor) markSentLate(row.querySelector('.m'), ev.at, ev.scheduledFor);
      // 放置中の圧縮で末尾に付いた区切りは、この発言の前へ置き直す（at で並べ直す）。
      // 区切りがすべてこの発言より前にあるときは作り直さない。古い区切りを最新の発言の前へ動かしていた不具合の再発を防ぐ
      const rows = [...thread.children];
      if ([...thread.querySelectorAll('.mw[data-compaction-id]')].some(boundary => rows.indexOf(boundary) > rows.indexOf(row))) paintCompactions();
      // pending = 受理はしたが、まだエージェントに渡っていない（userMessage.delivered を待つ）。
      // 配達の合図が先に来ていた分（速いバックエンド）はここで消化する
      const confirmed = row.dataset.delivered === '1' || deliveredEarly.delete(ev.messageId);
      if (confirmed) row.dataset.delivered = '1';
      if (ev.pending && ev.messageId && !confirmed) markDelivery(row, ev.initial ? 'sending' : 'pending');
      else markDelivery(row, 'sent');
      syncOutboxRows(outboxes.get(state.current) ?? []);
      return;
    }
    case 'userMessage.delivered': {
      const row = messageRow(ev.messageId);
      // 吹き出しより先に届くことがある（受理の応答と配達の合図が競る）。覚えておいて吹き出しで消す
      if (!row) { if (ev.messageId) deliveredEarly.add(ev.messageId); return; }
      row.dataset.delivered = '1';
      markDelivery(row, 'sent');
      return;
    }
    case 'userMessage.dropped':
      // 読まれないままターンが死んだ。発言は送信待ち（保留）へ戻るので、会話からは下げる
      messageRow(ev.messageId)?.remove();
      paintOutbox();
      return;
    case "sessionsChanged":
      if (ev.deleted === state.current) {
        // 開いていた会話が消えた（未送信の削除・sessions.delete。ADR 0147）。前の会話の文脈のメーター・圧縮の予約も持ち越さない
        state.current = null; clearThread(); loadDraft();
        state.messages = []; state.contextWindow = null; state.compactionAt = null; state.compactionPhase = null; state.compactions = [];
        paintContextStrip();
        refreshContextEntry().catch(() => {});
      }
      return refresh();
    case 'claudeAccountsChanged':
      claudeAccounts.invalidate();
      syncTopbar().catch(() => {});
      break;
    case 'compatEndpointsChanged':
      compatEndpoints.invalidate();
      syncTopbar().catch(() => {});
      renderAuth();
      break;
    case "nextSettings":
      return refresh().then(() => { shellComposer.sync(); paintWorktreeLines(); });
    // エージェントの変更は会話に行を出さない（入力欄の「次のターンから」の行と引き継ぎの案内が持つ。ADR 0067）
    case "backend":
      return refresh().then(() => shellComposer.sync());
    case "text.delta":
      return appendText(String(ev.text ?? ""));

    case "text.end": {
      // 確定した発言。id が分かったので「ここから分岐」が押せるようになる。
      // 続くツール呼び出しは同じ発言に入る（履歴の 1 メッセージ = 本文 + ツール呼び出し）。
      // 本文の無い発言（ツールだけ）が、本文の無い発言に続くときは、発言もまとまりも閉じない。
      // 履歴は「本文も thinking も無く連続するツール呼び出し」を 1 つの発言に合成する（claude-normalize の transcriptToMessages）ので、ライブも同じにする。
      // Claude は本文の無い発言ごとに text.end を出す
      const bodyless = !state.streamEl && !state.thinkEl;
      if (bodyless && state.turnClosed && !state.endedWithText) return;
      // 見せるものが無い発言（thinking が署名だけ）のために、空の発言の入れ物は作らない。id は次の入れ物に持たせる
      if (bodyless && !state.turnEl) { state.pendingUuid = ev.uuid ?? null; state.turnClosed = true; state.endedWithText = false; return; }
      // 本文のある発言に続けて来たなら（本文の無いツールだけの発言）、新しい発言を作る
      const m = openTurnEl();
      if (ev.uuid) setUuid(m, ev.uuid);
      state.endedWithText = !bodyless;
      closeThink();
      endStream();
      state.turnClosed = true;
      return;
    }

    case "thinking.start":
      endStream();
      state.thinkTokens = 0;
      activity.show(ACTIVITY_LABEL.thinking);
      return;

    case "thinking.delta": {
      // 平文が来ないエージェント（Claude の thinking は署名だけ）もある。
      // 中身が来たときだけ箱を作り、来ないときは考えている量だけを稼働表示に出す。
      if (ev.text) {
        const box = thinkBox().querySelector(".think-body");
        box.textContent += ev.text;
        if (state.thinkEl.open) box.scrollTop = box.scrollHeight;
      }
      if (typeof ev.estimatedTokens === "number") state.thinkTokens = ev.estimatedTokens;
      activity.show(state.thinkTokens ? t("activity.thinkingTokens", { count: state.thinkTokens }) : ACTIVITY_LABEL.thinking);
      return;
    }

    case "tool.start": {
      if (ev.id && state.toolCards.has(ev.id)) return state.toolCards.get(ev.id);
      endStream();
      const stick = atBottom();
      const card = renderToolCall(ev.name, ev.input, { id: ev.id });
      linkDelegateCard(card, ev.input);
      const boundary = isBoundaryTool(ev.name);
      if (boundary) { closeBundle(); ensureTurnEl().append(card); }
      else { markRunning(card); liveBundle(isComputerTool(ev.name) ? "computer" : "tools").add(card); }
      // 2 件目で見出しが現れ、行が伸びる間も、読んでいた下端に付いていく
      if (stick) followBottom();
      if (ev.id) state.toolCards.set(ev.id, card);
      // 走っているツールは最新の行（弧と経過）が語る。末尾の稼働表示は重ねない。
      // 委譲・サブエージェントの行には弧が無い（状態は 4 秒ごとの更新で追いつく）ので、それまでは従来の稼働表示を残す
      if (boundary) activity.show(t("activity.runningTool", { tool: ev.name }));
      else activity.suspend();
      return card;
    }

    // ツールの戻り。対応するカードに結果を差し込む（別の吹き出しにはしない）
    case "tool.result": {
      const card = state.toolCards.get(ev.id);
      if (card) { applyToolResult(card, ev); noteEndpointFailure(card, ev); linkDelegateCard(card, null, ev); bundleOf(card)?.paint(); }
      activity.afterTool();
      return;
    }

    case "activity":
      if (ev.state === "idle") { settleStrays(); closeBundle(); return activity.hide(); }
      // 別のタブで押した中断・開き直した会話でも、止まり終えるまで中断ボタンを押せなくする
      if (ev.state === "stopping" && ev.sessionId && isRunningHere()) { state.stopping.add(ev.sessionId); syncRunState(); }
      // running / waiting は「動いている」「待っている」だけを言う汎用の事象。ツールの行が語っている間（suspend 中）は出さない
      return activity.show(ev.label || (ev.state === 'preparing'
        ? ev.current && ev.total ? t('activity.connectingMcp', { current: ev.current, total: ev.total }) : t('activity.preparing')
        : ACTIVITY_LABEL[ev.state] || ACTIVITY_LABEL.running), { delayMark: ev.state === 'preparing', passive: ev.state === 'running' || ev.state === 'waiting' });

    case 'taskNotice':
      closeTurnEl();
      // 本文があれば開ける 1 行（既定は閉じた状態。履歴の systemHistoryNode と同じ形）
      append(taskNoticeNode(ev.text, hhmm(ev.at ?? new Date())));
      return;
    case 'channelEvent':
      // bot の会話へチャンネルの出来事・記憶の包みを渡した。履歴と同じ行（systemHistoryNode）で出す（サーバーが履歴と同じ形の rows を付ける）
      closeTurnEl();
      for (const row of ev.rows ?? []) { const node = systemHistoryNode({ at: new Date().toISOString(), ...row }); if (node) append(node); }
      return;
    case 'interruptionNote': {
      // 中断で止めたものをエージェントへ伝えた。開くと伝えた中身が読める（履歴の systemHistoryNode と同じ形）。
      // 添えた発言の吹き出しの前に置く（履歴と同じ並び）
      const node = append(sysFold(t('chat.sys.interruptionNote'), ev.text ?? ''));
      const row = ev.messageId ? messageRow(ev.messageId) : null;
      if (row && row !== node) row.before(node);
      return;
    }
    case "turnResult": {
      if (ev.compact) return;
      settleStrays();
      closeBundle();                                // ターンが終わったら、最新の行を残さず見出しだけにする
      if (ev.outcome === "ok") return;             // 終わったことは稼働表示が消えれば分かる
      closeTurnEl();
      // 中断の一行は保存された状態と同じ形で描く（paintInterruptLine が二重に出さない）
      if (ev.outcome === "aborted" || ev.outcome === 'limited') paintInterruptLine({ at: ev.at ?? Date.now(),
        reason: ev.outcome === 'limited' ? 'limit' : ev.reason, resetsAt: ev.resetsAt, window: ev.window,
        account: ev.account, backend: ev.backend });
      else {
        // ターンの失敗は会話の出来事として残す。「✕ 失敗」は強い字（ツールの失敗と同じ語）
        const node = sys(html.t("chat.sys.failed", { head: t("timeline.result.failed"), error: ev.error ?? t("chat.sys.unknownReason") }, ["head"]));
        node.classList.add("turn-failed");
        if (ev.sessionId) turnErrorRows.set(ev.sessionId, { messageId: ev.messageId, node });
        const failed = outboxes.get(ev.sessionId)?.find(m => m.status === 'failed' && m.id === ev.messageId);
        if (failed) syncOutboxRows(outboxes.get(ev.sessionId));
      }
      return;
    }

    case "auth":
      return onAuthEvent(ev);

    case "present": {
      if (ev.by === "human") {
        const rows = [...thread.querySelectorAll('.m[data-role="user"]')];
        const index = attachmentMessageIndex(rows.map(row => ({role:"user", at:row.dataset.at, text:userRaw(row)})), ev);
        // 結び付いた発言が Markdown で描かれているなら、添付は本文の位置に取り込む（別のカードは出さない）
        const owner = index >= 0 && rows[index].querySelector(':scope > .body')?.classList.contains('md-user') ? rows[index] : null;
        if (owner) {
          const same = (a, b) => normalizeAttachmentPath(a) === normalizeAttachmentPath(b);
          const known = (owner.attached ?? []).findIndex(p => same(p.path, ev.path));
          if (known < 0) paintUser(owner, userRaw(owner), [...(owner.attached ?? []), ev]);
          else if (owner.attached[known].provisional) {
            // 送った直後に仮の添付で描いてある。描き直さず（画像を読み直さない）、持っている情報だけを本物に替える
            owner.attached[known] = ev;
            paintUserTools(owner);
          }
          relayoutBranches();
          return owner.closest('.mw');
        }
        const wrapper = append(renderPresent(ev), `live:${++liveSeq}`);
        wrapper.dataset.humanAttachment = "true";
        if (index >= 0) {
          let anchor = rows[index].closest('.mw');
          while (anchor.nextElementSibling?.dataset.humanAttachment === "true") anchor = anchor.nextElementSibling;
          anchor.after(wrapper);
          relayoutBranches();
        }
        return wrapper;
      }
      closeTurnEl();
      return append(renderPresent(ev), `live:${++liveSeq}`);
    }

    case "permission":
      return renderPermission(ev);

    case "permissionRelayEnd":
    case "permissionRelayState":
      return onRelayCardEvent(ev);

    case "permissionUpdate":
      return onPermissionUpdate(ev);

    case "session":
      if (ev.sessionId && state.current !== ev.sessionId) {
        state.current = ev.sessionId;
        filePreview.sessionAssigned(ev.sessionId);
        syncTopbar();
      }
      return;

    // 設定の変化（状態・タイトル・承認モード・モデル・作業ディレクトリ・AI の分岐・指示の読み直し）は会話に行を出さない。
    // 結果は別の場所（脇の行・見出し・入力欄のチップと「次のターンから」・分岐の節）に出ている。誰がいつ変えたかは脇の行の「変更の記録」（ADR 0067）
    case "status":
      return refresh();

    case 'statusProgress': {
      // i18n-dynamic: pending.movingProgress
      // i18n-dynamic: pending.deletingProgress
      const pending = pendingStatuses.get(ev.to || ev.from);
      if (pending && pending.from === ev.from && pending.to === ev.to) {
        pending.done = ev.done; pending.total = ev.total;
        pending.text = t(pending.to ? 'pending.movingProgress' : 'pending.deletingProgress', { done: ev.done, total: ev.total });
        if (pending.visible) renderSessions();
      }
      return;
    }

    case "statusIcon":
      return refresh();

    // グループ（fork のまとまり）から外れた / 戻った。会話には何も出さない（脇の見た目だけが変わる）
    case "group":
      return refresh();

    case "title":
      return refresh().then(paintBranchNames);

    case "fork":
      // 今の会話の家族が増えたなら系譜を読み直し、分岐点の印を置き直す
      return refresh().then(() => reloadBranches(ev));

    case "rewind":
      // 同じ会話の中で巻き戻した（別の画面からの送り直しも）。履歴を静かに読み直す。
      // 自分が送り直しているときは、送り終えてから自分で読み直す（rewindSend）
      if (rewindingNow !== ev.sessionId) select(ev.sessionId, { reload: true }).catch(() => {});
      return;

    case "mode":
    case "model":
    case "cwd":
      return refresh();

    // 開始時と指示・Skills が変わっていた、またはコンテキストの設定が変わったので、送信時に自動で読み込み直した（core/server.mjs の runTurn）
    case 'contextRefreshed': {
      // 会話には行を出さない（タイトル行のプラグインの「変更あり」の点が消える。ADR 0067）。
      // 新しい記録はこの直後の contextUsage で届く。ここでは「変更あり」の印だけ先に消す
      if (state.contextInfo && state.contextInfoId === ev.sessionId) {
        state.contextInfo = { ...state.contextInfo, changed: { differs: false, paths: [], files: [] } };
        paintContextEntry();
        sessionContext.refresh();
      }
      return;
    }

    // ターンの開始（と MCP の接続後）に届く、この会話が読み込んだものの記録
    case 'contextUsage': {
      // 開始時刻・外した MCP などは sessionContext の戻りにしか無いので、同じ会話なら前の値を引き継ぐ
      const id = state.current ?? state.contextInfoId;
      const prev = state.contextInfoId === id ? state.contextInfo : null;
      state.contextInfo = { ...prev, report: ev.report, owners: ev.report?.owners, pinned: isManagedContext(ev.report), changed: { differs: false, paths: [], files: [] },
        plyParts: ev.plyParts ?? prev?.plyParts ?? null };
      state.contextInfoId = id;
      paintContextEntry();
      sessionContext.refresh();
      return;
    }

    case "running":
      // 走っている本数はサーバが持っている。こちらはそれに合わせるだけ
      applyRunning(ev);
      return;

    case "turnEnd":
      // 読み返している間に返答が終わったら、最新へのボタンに新着の印（リプレイと、ほかの会話・送信待ちへ戻っただけの分は数えない）
      if (!replay && !ev.requeued && (!ev.sessionId || ev.sessionId === state.current)) { nav.replyArrived(); toc.refresh(); }
      closeTurnEl();
      // 渡った合図が来ないままターンが終わった分。Codex などは次のターンとして答える。
      // Claude は区切りで取り出された分にも同じターンの中で答え、渡った合図も出す（取りこぼしても、
      // 次の内部ターンが始まった時点で出す。core/backends/claude.mjs の takeLeftovers）ので、普通はここに残らない。
      // 待っているものは何も走っていないので、回る弧はここで外す
      for (const row of thread.querySelectorAll('.mw[data-delivery-pending]')) markDelivery(row, 'late');
      state.awaitingSession = false;
      state.submitting = false;
      if (ev.sessionId) { state.runningIds.delete(ev.sessionId); state.stopping.delete(ev.sessionId); resumeSettled(ev.sessionId); }
      syncRunState();
      paintInterruptLine();
      syncHistory();
      // git の状態（ブランチ・変更の数）はターンの終わりに取り直す。開いている git パネルも（ADR 0085）
      if (ev.sessionId && ev.sessionId === state.current) { refreshGit({ force: true }).catch(() => {}); gitPanel?.changed(); }
      // 右パネルの Hooks の「発火の記録」はターンの終わりに会話へ残る。開いていれば取り直す
      if (ev.sessionId && ev.sessionId === state.current && sessionContext.isOpen()) sessionContext.refresh();
      return refresh();
  }
}

/** running イベント / running コマンドの戻り。走っているもの・待っているものを一覧と稼働表示へ */
function applyRunning(work) {
  state.work = work ?? { count: 0, turns: [], permissions: [], subagents: [], background: [] };
  syncTaskCards();
  const running = new Set((state.work.turns ?? []).map((t) => t.sessionId).filter(Boolean));
  const waiting = new Set((state.work.permissions ?? []).map((p) => p.sessionId).filter(Boolean));
  // 誰が答えたか（別のタブ・中断）に関わらず、残っている承認はサーバが正。
  // 消えた分を覚えたままにすると、次にその会話を開いたとき解決済みのカードが出る
  const unresolved = new Set((state.work.permissions ?? []).map((p) => p.id));
  for (const id of state.pendingPerms.keys()) if (!unresolved.has(id)) state.pendingPerms.delete(id);
  reconcileOpenCards();
  const behind = new Map();
  for (const t of state.work.turns ?? []) {
    const b = behindOf(t);
    if (b && t.sessionId) behind.set(t.sessionId, b.n);
  }
  // ターンの外で裏に残っている作業（Codex の端末）。ターンが走っていればそちらが優先（弧）
  // 委譲したタスクが終わっていない依頼元の会話も衛星（ターンが走っていれば behindOf が数える）
  const idle = new Set([...(state.work.background ?? []).map((x) => x.sessionId), ...(state.work.tasks ?? []).map((x) => x.parentSessionId)]);
  for (const id of idle) {
    if (!id || running.has(id)) continue;
    const tasks = [...((state.work.background ?? []).find((x) => x.sessionId === id)?.tasks ?? []), ...liveTasksOf(state.work.tasks, id)];
    const b = behindOfTasks(tasks);
    if (b) behind.set(id, b.n);
  }
  // ターンが始まった会話は中断ではなくなる（サーバーも次の一覧で null を返す）
  let resumed = false;
  for (const s of state.sessions) if (s.interrupted && running.has(s.id)) { s.interrupted = null; resumed = true; }
  for (const id of running) if (resumeSettled(id)) resumed = true;
  // 4 秒ごとの放送で印が変わっていなければ一覧を描き直さない
  const changed = resumed || !sameSet(running, state.runningIds) || !sameSet(waiting, state.waitingIds)
    || behind.size !== state.bgWaiting.size || [...behind].some(([id, n]) => state.bgWaiting.get(id) !== n);
  state.runningIds = running;
  state.waitingIds = waiting;
  // 中断中の印はサーバの turn.info.stopping が正。走り終えた会話の分は外す
  for (const t of state.work.turns ?? []) if (t.stopping && t.sessionId) state.stopping.add(t.sessionId);
  for (const id of [...state.stopping]) if (!running.has(id)) state.stopping.delete(id);
  state.bgWaiting = behind;
  if (state.current && state.runningIds.has(state.current)) state.submitting = false;
  syncRunState();
  activity.sync();
  paintSettingsNotice();
  if (changed) { renderSessions(); refreshWorktree().catch(() => {}); }
  updatesUi?.workChanged();
  switchUi?.refresh();
  // バックグラウンドはこの会話の分だけ稼働表示に出す。他所の分は一覧の行に付く
  syncWorkEntry();
  restorePastSubagents(state.current);
  // 開いているダイアログは一覧を描き直し、選んでいる子が動いていれば続きを読み直す（読んでいる位置は保つ）
  if ($("workDialog").open) renderBackground();
  // 会話の中の委譲カード（振り分けの記録・やり直しの行）
  paintDelegateCards();
  // 走り出したばかりのセッションはまだ一覧に無い。そのときだけ取り直す
  for (const id of state.runningIds) {
    if (state.sessions.some((x) => x.id === id) || state.askedFor.has(id)) continue;
    state.askedFor.add(id);
    if (id === state.current) refresh(); else scheduleRefresh();
    break;
  }
}

const sameSet = (a, b) => a.size === b.size && [...a].every((x) => b.has(x));

// ---------------------------------------------------------------- コマンド

/** timeoutMs を渡すと、その間に返事が無ければ失敗にする（返事を待ち続けて後の処理まで止めないため。refresh） */
function cmd(command, args = {}, { timeoutMs = 0 } = {}) {
  const id = String(++seq);
  return new Promise((res, rej) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return rej(new Error(t("app.notConnected")));
    if (!timeoutMs) { pending.set(id, { res, rej }); }
    else {
      const timer = setTimeout(() => { pending.delete(id); rej(new Error(t("app.noReply"))); }, timeoutMs);
      const done = (fn) => (v) => { clearTimeout(timer); fn(v); };
      pending.set(id, { res: done(res), rej: done(rej) });
    }
    ws.send(JSON.stringify({ kind: "command", command, id, args }));
  });
}

// ---------------------------------------------------------------- エージェント
// 実行先と次ターンの予約を区別する。履歴の発言は生成したエージェントを表示する。
// できること（fork / タイトル提案 / 常に許可 / サブエージェント）はエージェントごとに違うので、
// capabilities を見て口を出し分ける。押せるのに何も起きない口は作らない。

/** 今の会話が対応を終えたエージェントのものなら、続けられない理由（core/backends/index.mjs の RETIRED） */
function retiredHere() {
  return state.sessions.find((x) => x.id === state.current)?.retired ?? null;
}

function activeBackendId() {
  const s = state.sessions.find((x) => x.id === state.current);
  return s?.backend ?? state.backendId ?? null;
}

function capsOf(id) {
  return state.backends.find((b) => b.id === id)?.capabilities ?? {};
}

function labelOf(id) {
  return state.backends.find((b) => b.id === id)?.label ?? id ?? "";
}

/** 一覧に2つ以上並ぶときだけ、どのエージェントのものか出す（1つなら情報にならない）。 */
function backendLabels() {
  if (state.backends.length <= 1) return null;
  return Object.fromEntries(state.backends.map((b) => [b.id, b.label]));
}

async function loadBackends() {
  if (state.backends.length) return state.backends;
  const list = await cmd("backends").catch(() => []);
  state.backends = Array.isArray(list) ? list : [];
  for (const b of state.backends) applyToolHints(b.toolHints);
  state.backendId = state.backends.some((b) => b.id === state.prefs.backend)
    ? state.prefs.backend : state.backendId ?? state.backends[0]?.id ?? null;
  state.shownBackend ??= state.backendId;
  controls.paint();
  // 認証の状態はエージェントを引いたときに 1 回だけ。以降はログイン / ログアウトの後に取り直す
  refreshAuth().catch(() => {});
  return state.backends;
}

/** そのエージェントの語彙（承認モード / モデル）。値の意味はこちらでは解釈しない。 */
async function loadVocab(id) {
  if (!id) return { modes: {}, models: {} };
  if (state.vocab.has(id)) return state.vocab.get(id);
  return fetchVocab(id);
}

async function fetchVocab(id) {
  const [modes, models] = await Promise.all([
    cmd("modes", { backend: id }).catch(() => ({})),
    cmd("models", { backend: id }).catch(() => ({})),
  ]);
  const v = { modes: modes ?? {}, models: models ?? {} };
  // 失敗（切断中の cmd は即 reject する）で空になったものはキャッシュしない。
  // 掴んだままだと承認モード・モデルの候補が空のまま固定され、選んであった値が黙って既定へ戻る
  if (Object.keys(v.modes).length && Object.keys(v.models).length) state.vocab.set(id, v);
  return v;
}

/**
 * 語彙を裏で取り直す（モデルの面を開いたとき）。codex のモデルは更新や入れ替えで変わる。
 * 届くまでは覚えている一覧を出したまま。空（失敗）なら fetchVocab が覚えている方を残す
 */
function revalidateVocab(id) {
  if (!id) return;
  const before = state.vocab.get(id);
  fetchVocab(id).then((v) => {
    if (state.vocab.get(id) !== v || JSON.stringify(before) === JSON.stringify(v)) return;
    syncTopbar().catch(() => {});
  }).catch(() => {});
}

/** ログイン・ログアウトの後。使えるモデルはアカウントで変わるので、覚えた語彙を捨てて描き直す */
function forgetVocab(id) {
  state.vocab.delete(id);
  syncTopbar().catch(() => {});
}

// ---------------------------------------------------------------- エージェントの認証
// ログインの持ち方はエージェントごとに違う（Claude は Claude Code のログインをそのまま、
// codex は app-server 越しに ChatGPT）。capabilities.login が真のものだけ。
// 置き場は設定メニューの中。常設しない。ログインが要るときだけ脇の下に一行で知らせる。
// 設定モーダル内にURLを出し、コールバックを取れないときは手貼りの欄を出す。

/** 認証の状態を取り直す。refresh() は毎イベント走るので、ここは起動時とログイン / ログアウトの後だけ */
async function refreshAuth() {
  const targets = state.backends.filter((b) => b.capabilities?.login);
  await Promise.all(targets.map(async (b) => {
    const st = await cmd("authStatus", { backend: b.id }).catch((e) => ({ supported: false, error: e.message }));
    state.auth.set(b.id, st);
  }));
  renderAuth();
  await onboarding.refresh();
}

function renderAuth() {
  const sec = $("authSec");
  const targets = state.backends.filter((b) => b.capabilities?.login);
  sec.hidden = targets.length === 0;
  sec.replaceChildren();
  if (!targets.length) { $("authNeed").hidden = true; return; }
  sec.append(el("div", "head", t("settings.agents.heading")));
  const need = [];
  for (const b of targets) {
    const st = state.auth.get(b.id) ?? {};
    const row = el("div", "auth-row");
    row.append(el("span", "name", b.label));
    const text = st.installed === false ? t("settings.agents.notInstalled") : !st.supported ? (st.error ? t("settings.agents.statusError", { error: st.error }) : t("settings.agents.loginUnsupported"))
      : st.pending ? t("settings.agents.loginPending")
      : st.loggedIn ? (st.account || t("settings.agents.loggedIn"))
      : t("settings.agents.loggedOut");
    const s2 = el("span", "st", text);
    if (st.detail && st.loggedIn) s2.title = st.detail;
    row.append(s2);
    if (st.installed === false && st.installUrl) {
      const link = el("a", "btn", t("settings.agents.install"));
      link.href = st.installUrl; link.target = "_blank"; link.rel = "noreferrer";
      row.append(link);
    } else if (st.supported && !st.pending && !st.loggedIn && window.plyRemote) {
      // リモートの窓: ログインの戻り先はホストの PC なので、ここからは始めない（docs/remote.md §7.3）。状態はそのまま見える
      row.append(el("span", "remote-login-note", t("remote.loginOnHost")));
    } else if (st.supported && !st.pending) {
      const loggedIn = st.loggedIn;
      const btn = el("button", "btn", loggedIn ? t("settings.agents.signOut") : t("settings.agents.signIn"));
      btn.type = "button";
      btn.onclick = (e) => { e.stopPropagation(); if (loggedIn) authLogout(b); else authLogin(b); };
      row.append(btn);
    }
    // 会話ごとに選べる Claude のアカウント（Pleiad が claude setup-token を回して発行したトークン）
    if (b.capabilities?.claudeAccounts && st.installed !== false) {
      const button = el('button', 'btn', t('settings.agents.accounts')); button.type = 'button'; button.onclick = () => claudeAccounts.open(); row.append(button);
    }
    // 互換の接続先（Claude Code の Anthropic 互換・Codex の Responses 互換）。同じページの下に管理の面を開く
    if (b.capabilities?.compatEndpoints && st.installed !== false) {
      const button = el('button', 'btn', t('settings.agents.endpoints')); button.type = 'button';
      button.setAttribute('aria-expanded', String(compatEndpoints.openAgent === b.id));
      button.onclick = () => compatEndpoints.open(b.id);
      row.append(button);
    }
    sec.append(row);
    if (st.installed !== false && st.supported && !st.loggedIn && !st.pending) need.push(b.label);

    const box = authUrlBox(b.id);
    if (box) sec.append(box);
  }
  const line = $("authNeed");
  line.hidden = need.length === 0;
  if (need.length) line.textContent = t("app.authNeed", { agents: need.join(t("app.listSeparator")) });
}

/**
 * ログインの URL と、コールバックを取れないときの手貼り。
 * 設定画面と初期設定ダイアログの両方に出す。**初期設定は modal なので、
 * ここを設定画面にしか出さないと、初回の利用者はログインを終われない。**
 */
function authUrlBox(id) {
  const b = state.backends.find((x) => x.id === id);
  const pend = b && state.authUrl.get(id);
  if (!pend) return null;
  const frag = document.createDocumentFragment();
  const box = el("div", "auth-url");
  if (/^https?:\/\//i.test(pend.url)) {
    const a = el("a", null, pend.url);
    a.href = pend.url; a.target = "_blank"; a.rel = "noreferrer";
    box.append(a);
  } else box.append(el("span", null, pend.url));
  if (pend.message) box.append(el("div", null, pend.message));
  frag.append(box);
  // 貼り戻しを受けられるバックエンドにだけ入力欄を出す。
  // 受け取る口が無いのに出すと、貼っても何も起きない欄になる（agy がそれ）
  if (pend.message && b.capabilities?.submitCode) {
    const paste = el("div", "auth-paste");
    const inp = document.createElement("input");
    inp.className = "field";
    inp.placeholder = t("settings.agents.pasteCode");
    const send = el("button", "btn", t("settings.agents.submitCode"));
    send.type = "button";
    const submit = async () => {
      const v = inp.value.trim();
      if (!v) return;
      send.disabled = true;
      try {
        await cmd("authSubmit", { backend: b.id, input: v });
      } catch (err) {
        $("setupError").textContent = t("settings.agents.loginFailed", { agent: b.label, error: err.message });
        send.disabled = false;
      }
    };
    send.onclick = (e) => { e.stopPropagation(); submit(); };
    inp.onkeydown = (e) => { if (isComposingKey(e)) return; if (e.key === "Enter") { e.preventDefault(); submit(); } };
    paste.append(inp, send);
    frag.append(paste);
  }
  return frag;
}

/** ログインは完了まで返ってこない（サーバがコールバックを待つ。10 分で時間切れ）。応答待ちで画面を止めない */
function authLogin(b) {
  if (window.plyRemote) { sys(html.t("remote.loginOnHost")); return; }   // リモートの窓からは始めない（renderAuth と同じ理由）
  state.auth.set(b.id, { ...(state.auth.get(b.id) ?? {}), supported: true, pending: true });
  renderAuth();
  onboarding.paint();
  let failure;
  cmd("authLogin", { backend: b.id })
    .catch((e) => { failure = e; })
    .finally(async () => {
      state.authUrl.delete(b.id);
      forgetVocab(b.id);
      await refreshAuth().catch(() => {});
      if (failure) $("setupError").textContent = t("settings.agents.loginFailedRetry", { agent: b.label, error: failure.message });
    });
}

async function authLogout(b) {
  try {
    await cmd("authLogout", { backend: b.id });
  } catch (e) {
    $("setupError").textContent = t("settings.agents.logoutFailed", { agent: b.label, error: e.message });
  }
  forgetVocab(b.id);
  await refreshAuth().catch(() => {});
}

function onAuthEvent(ev) {
  const b = state.backends.find((x) => x.id === ev.backend);
  const name = b?.label ?? ev.backend ?? "";
  if (ev.phase === "url") {
    // URL はサーバ経由とはいえ外から来うる。http(s) だと確かめたものだけリンクにする
    state.authUrl.set(ev.backend, { url: String(ev.url ?? ""), message: ev.message ? String(ev.message) : "" });
    renderAuth();
    onboarding.paint();             // 初期設定ダイアログの中でログインを始めたときは、そちらに出す
    openSettings();                 // 進め方が見える場所に居てもらう
    const row = el("div", "m sys", t("settings.agents.loginUrl", { agent: name }));
    const url = String(ev.url ?? "");
    const a = el("a", null, url);
    if (/^https?:\/\//i.test(url)) { a.href = url; a.target = "_blank"; a.rel = "noreferrer"; }
    row.append(a);
    if (ev.message) row.append(el("span", null, ` ${ev.message}`));
    return append(row);
  }
  state.authUrl.delete(ev.backend);
  if (ev.phase === "error") $("setupError").textContent = t("settings.agents.loginFailed", { agent: name, error: ev.message ?? "" });
  else sys(html.t("settings.agents.loginMessage", { agent: name, message: ev.message ?? t("settings.agents.loginDone") }));
  refreshAuth().catch(() => {});
}

// ---------------------------------------------------------------- 入力欄の combo
// 人間が入力する箇所は同時に候補も出す（docs/design-system.md §2.4）。

let settingsWrite = Promise.resolve();
let modeWrite = Promise.resolve();
let settingsFailure = null;
let failedSettingsPatch = null;
let failedSettingsError = "";
let cwdSaving = 0;   // 作業ディレクトリを保存している間、チップの字を弱くする（docs/design-system.md §4.6）
const stagedNext = new Map();   // 一覧に行が載る前に書けた予約（sessionId -> nextSettings）
function reserveSettings(patch, targetId = state.current) {
  const id = targetId;
  if (!id) return;
  const write = settingsWrite.catch(() => {}).then(async () => {
    const value = await cmd("setTurnSettings", { sessionId: id, ...patch });
    // 書いている間に一覧が読み直されることがあるので、行は書けた後に引く。まだ一覧に行が無いなら控えておき、
    // startNew が行が載ったところで合わせる（読み直しの写しが書く前のものでも、チップが戻らないように）
    const s = state.sessions.find(s => s.id === id);
    if (s) { s.nextSettings = value; stagedNext.delete(id); } else if (state.draft.created === id) stagedNext.set(id, value);
    settingsFailure = null;
    failedSettingsPatch = null;
    if (state.current === id) { syncSettingsHold(); await syncTopbar(); }
    return value;
  });
  settingsWrite = write;
  write.catch(e => {
    settingsFailure = id;
    failedSettingsPatch = patch;
    failedSettingsError = e.message;
    // チップは保存できた値に戻し（§4.6「失敗時は元の位置へ戻す」）、欄の上に理由と操作。解決するまで送らせない
    if (state.current === id) { syncSettingsHold(); syncTopbar().catch(() => {}); }
  });
  return write;
}
/**
 * 設定のチップの入口。会話があれば次のターンへ予約する。新しい会話の欄（まだ会話が無い・作っている間）なら state.draft.changes に
 * 選んだ順に集め、会話ができたら startNew が同じ順で流す（できた後に選んだ分は、その場で新しい会話へ流す）。
 * 作業場所は state.draft.cwd（applyCwd）。集めた変更はチップの表示（syncTopbar → draftView）にも使うので、一覧の読み直しでチップが戻らない
 */
function chooseSettings(patch) {
  if (!state.current) { noteDraftChange(patch); syncTopbar().catch(() => {}); return; }
  if (justCreated()) noteDraftChange(patch);
  return reserveSettings(patch);
}
/** いま開いているのは、作ったばかりの会話か（startNew の途中。一覧の行が載るまでは、集めた変更が表示の元になる） */
function justCreated() {
  return Boolean(state.draft.created) && state.current === state.draft.created;
}
function noteDraftChange(patch) {
  const changes = state.draft.changes ??= [];
  const last = changes.at(-1);
  // 同じ項目の続けての変更（モデルを何度か選び直した）は最後の 1 つにまとめる
  if (last && Object.keys(last).sort().join() === Object.keys(patch).sort().join()) changes[changes.length - 1] = patch;
  else changes.push(patch);
}
/** 集めた変更を、いまの値の見え方に畳む。エージェント・接続先を変えると、その先の既定へ戻る（core/server.mjs の reserveTurnSettings と同じ） */
function draftView(changes) {
  const view = {};
  for (const patch of changes ?? []) {
    if ("backend" in patch) { delete view.effort; delete view.mode; delete view.endpoint; }
    if ("endpoint" in patch) { delete view.effort; view.model = ""; }
    Object.assign(view, patch);
  }
  return view;
}
/**
 * できた会話へ、作っている間に選んだ設定を流す（作業場所 → 選んだ順の変更）。newSession の引数に載せた分（持ち越した設定）も、
 * 覚える印（rememberModel など）とエージェントの切り替えに伴う既定への戻りは予約を通すのが正本なので、もう一度流す（同じ値なら予約は変わらない）
 */
function sendDraftSettings(draft, sessionId, requestedCwd) {
  const chosenCwd = draft.cwd;
  if (chosenCwd && chosenCwd !== requestedCwd) {
    const ticket = ++cwdSaving;
    $("cwdChip")?.classList.add("saving");
    const write = reserveSettings({ cwd: chosenCwd }, sessionId);
    write?.catch(() => {}).finally(() => { if (ticket === cwdSaving) $("cwdChip")?.classList.remove("saving"); });
  }
  for (const patch of draft.changes ?? []) reserveSettings(patch, sessionId);
}
/**
 * 設定を保存できなかった会話では、入力欄の上に理由と「再試行」「選び直す」（作業ディレクトリのとき）「取り消す」を出し、
 * 送信を止める（web/composer-wait.mjs の hold。docs/design-system.md「入力欄の待ち」）。開いている会話に合わせて出し入れする
 */
function syncSettingsHold() {
  if (!state.current || settingsFailure !== state.current || !failedSettingsPatch) { composerWait.release(); return; }
  const patch = failedSettingsPatch, cwd = typeof patch.cwd === "string" ? patch.cwd : null;
  const drop = () => { settingsFailure = null; failedSettingsPatch = null; composerWait.release(); };
  // 押したボタンは一行ごと消える。結果が出たら、また失敗なら出し直した一行の「再試行」へ、通れば入力欄へフォーカスを移す
  // （その間にほかへ移っていたら動かさない）
  const retry = () => {
    drop();
    const work = cwd != null ? applyCwd(cwd) : reserveSettings(patch);
    const lost = () => !document.activeElement || document.activeElement === document.body;
    Promise.resolve(work).then(() => { if (lost()) $("prompt").focus(); }, () => { if (lost() && !composerWait.focusAction()) $("prompt").focus(); });
  };
  const actions = [{ label: t("chat.settingsHold.retry"), onClick: retry }];
  if (cwd != null) actions.push({ label: t("chat.settingsHold.rechoose"), onClick: () => { drop(); syncTopbar().catch(() => {}); controls.panels.folder.show(); controls.typeCwd(cwd); } });
  actions.push({ label: t("chat.settingsHold.cancel"), onClick: () => { drop(); syncTopbar().catch(() => {}); $("prompt").focus(); } });
  const reason = cwd != null ? t("chat.settingsHold.cwd", { error: failedSettingsError }) : t("chat.settingsHold.settings", { error: failedSettingsError });
  composerWait.hold(`✕ ${reason}`, actions);
}
function paintSettingsNotice() {
  const s = state.sessions.find(s => s.id === state.current);
  const next = s?.nextSettings;
  $("nextSettings").hidden = !next;
  if (!next) $("nextSettings").classList.remove("wt-compact");
  // main が返答を終えて裏だけを待っている間（ターンの phase が waiting）は、送信が予約より先に今のターンへ届く（途中送信）。
  // 予約は次のターンから効くので、そう書く（docs/multi-backend.md §2.2）
  const behind = Boolean(next) && (state.work.turns ?? []).find(belongsHere)?.phase === "waiting";
  $("nextSettingsBehind").hidden = !behind;
  if (behind) $("nextSettingsBehind").textContent = t("chat.next.behindNote");
  if (next) {
    const changes = [];
    // 既定のモデルは実際に当たる名前を添える（分からなければ「既定」だけ）
    const fallback = state.models[""]?.resolvesTo || state.models[""]?.resolvedLabel ? t("chat.model.defaultResolved", { model: resolvedModel(state.models, "").label }) : t("chat.model.default");
    const nextEndpoint = next.endpoint ?? (next.backend !== s.backend ? "" : s.compatEndpoint ?? "");
    // 互換の接続先のモデルは表示名（web/compat-models.mjs。札を置けないので 1M は（1M））
    const epMain = nextEndpoint ? compatEndpoints.get(nextEndpoint)?.roles?.main : "";
    const epFallback = nextEndpoint ? t("chat.model.defaultResolved", { model: epMain ? compatModelText(epMain) : t("chat.next.endpointMain") }) : fallback;
    if (next.backend !== s.backend || next.model !== (s.model ?? "")) changes.push(`${labelOf(next.backend)} / ${next.model ? (nextEndpoint ? compatModelText(next.model) : state.models[next.model]?.label ?? next.model) : epFallback}${next.backend !== s.backend && !next.model && fallback === t("chat.model.default") ? t("chat.next.targetDefault") : ""}`);
    if (next.effort !== undefined && next.effort !== (s.effort ?? "")) changes.push(t("chat.next.effort", { value: next.effort || t("chat.next.useDefault") }));
    if (next.cwd) changes.push(worktreeNextText(next.cwd) ?? t("chat.next.cwd", { value: next.cwd }));
    if (next.mode !== undefined) changes.push(t("chat.next.mode", { value: state.modes[next.mode]?.label ?? next.mode }));
    if (next.endpoint !== undefined) changes.push(t("chat.next.endpoint", { value: endpointLabel(next.endpoint) }));
    if (next.account !== undefined) changes.push(t("chat.next.account", { value: accountLabel(next.account) }));
    const joined = changes.join(" · ");
    // 変えるのが worktree だけのときは、軽い 1 行（「次のターンから適用」＋枝分かれの印の札。ADR 0089）
    const compact = !behind && changes.length === 1 && Boolean(next.cwd && worktreeNextText(next.cwd));
    $("nextSettings").classList.toggle("wt-compact", compact);
    if (compact) {
      const mark = el("span", "wt-ic");
      mark.innerHTML = branchIcon;
      mark.setAttribute("aria-hidden", "true");
      $("nextSettingsText").replaceChildren(mark, el("span", null, joined));
    } else $("nextSettingsText").textContent = behind ? t("chat.next.summaryBehind", { changes: joined }) : t("chat.next.summary", { changes: joined });
  }
  paintHandoffNote(s, next);
}
/**
 * エージェントを変える予約のときだけ、引き継がないものを 1 行で出し、残りは「詳しく」に畳む（既定は閉じる。デスクトップもスマホも）。
 * 境界は docs/backend-handoff.md（発言・ツールの記録は渡す。過去の承認・考えた内容・元のエージェントの内部の状態は渡さない）
 */
function paintHandoffNote(s, next) {
  const box = $("nextHandoff");
  const switching = Boolean(next?.backend) && next.backend !== s?.backend;
  box.hidden = !switching;
  if (!switching) { box.replaceChildren(); delete box.dataset.key; return; }
  const from = labelOf(s.backend), to = labelOf(next.backend);
  // 同じ切り替えなら作り直さない（開いた「詳しく」を閉じない）
  const key = `${s.backend}>${next.backend}`;
  if (box.dataset.key === key) return;
  box.dataset.key = key;
  box.open = false;
  const summary = el("summary");
  summary.append(el("span", null, t("chat.next.handoff.line")), el("span", "more", t("chat.next.handoff.more")));
  const rows = el("dl");
  const facts = [
    [t("chat.next.handoff.keep"), t("chat.next.handoff.keepValue")],
    [t("chat.next.handoff.drop"), t("chat.next.handoff.dropValue", { from, to })],
    [t("chat.next.handoff.change"), t("chat.next.handoff.changeValue", { to })],
  ];
  for (const [label, value] of facts) {
    const row = el("div");
    row.append(el("dt", null, label), el("dd", null, value));
    rows.append(row);
  }
  box.replaceChildren(summary, rows);
}
$("cancelSettings").onclick = () => reserveSettings({ cancel: true });

/** 最近使った作業ディレクトリ。いつ使ったかを添える */
function cwdOptions() {
  const seen = new Map();
  for (const s of state.sessions) {
    if (!s.place) continue;
    if (!seen.has(s.place) || (s.lastModified ?? 0) > seen.get(s.place)) seen.set(s.place, s.lastModified ?? 0);
  }
  return [...seen].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([d, t]) => ({ value: d, hint: relTime(t), time: t }));
}

// Claude のアカウントの設定（web/claude-accounts.mjs）。入力欄のチップが候補を引くので、controls より先に作る
const claudeAccounts = setupClaudeAccounts({ cmd,
  openSettings: () => { if ($('onboardingDialog').open) $('onboardingDialog').close(); onboarding.open(); },
  onChange: () => { syncTopbar().catch(() => {}); } });
/** Claude のアカウントの候補。選んでいたものが消えていれば、その旨の行を残す（黙って別のものに見せない） */
function accountOptions() {
  const s = state.sessions.find((x) => x.id === state.current);
  const value = s?.nextSettings?.account ?? s?.claudeAccount ?? "";
  const list = claudeAccounts.list();
  return [
    { value: "", label: t("chat.account.signedIn"), hint: t("chat.account.signedInAccount") },
    ...list.map((a) => ({ value: a.id, label: a.name, hint: a.hasToken ? "" : t("chat.account.noToken") })),
    ...(value && !list.some((a) => a.id === value) ? [{ value, label: t("chat.account.deleted"), hint: t("chat.account.chooseAgain") }] : []),
  ];
}
function accountLabel(id) {
  if (!id) return t("chat.account.signedInAccount");
  return claudeAccounts.list().find((a) => a.id === id)?.name ?? t("chat.account.deleted");
}
let accountWarning = "";
/** 入力欄のアカウントの出し分け。登録が無く、選んでもいない会話には、モデルの面にアカウントの節を出さない */
async function syncAccount(s, bid) {
  const supported = Boolean(capsOf(bid).claudeAccounts);
  const list = supported ? await claudeAccounts.load().catch(() => []) : [];
  const value = s?.nextSettings?.account ?? s?.claudeAccount ?? "";
  state.accountShown = Boolean(s) && supported && (list.length > 0 || Boolean(value));
  const chosen = list.find((a) => a.id === value);
  const warning = !state.accountShown || !value ? "" : !chosen ? t("chat.account.deletedWarning")
    : !chosen.hasToken ? t("chat.account.noTokenWarning", { name: chosen.name }) : "";
  if (accountWarning && $("settingsError").textContent === accountWarning) $("settingsError").textContent = "";
  accountWarning = warning;
  if (warning) $("settingsError").textContent = warning;
  state.account = value;
}

// 互換の接続先の設定（web/compat-endpoints.mjs）。入力欄の面が候補を引くので、controls より先に作る
const compatEndpoints = setupCompatEndpoints({ cmd,
  openSettings: () => { if ($('onboardingDialog').open) $('onboardingDialog').close(); onboarding.open(); },
  openPage: name => $(`${name}Tab`)?.click(),
  onChange: () => { syncTopbar().catch(() => {}); },
  officialLine: (agent) => { const st = state.auth.get(agent); return st?.loggedIn ? (st.account || t('settings.agents.loggedIn')) : ''; } });
compatEndpoints.onOpen(() => renderAuth());
function endpointLabel(id) {
  if (!id) return t("chat.endpoint.official");
  return compatEndpoints.get(id)?.name ?? t("chat.endpoint.deleted");
}
/** 会話の次のターンの接続先（予約があればそれ。エージェントを変える予約で接続先が書かれていなければ公式） */
function endpointOf(s) {
  if (!s) return "";
  const next = s.nextSettings;
  return next?.endpoint ?? (next && next.backend !== s.backend ? "" : s.compatEndpoint ?? "");
}
let endpointWarning = "";
/** 入力欄の接続先の出し分け。選べないエージェントでは節を出さない。消えた・確認に失敗した接続先は入力欄の上に一文 */
async function syncEndpoint(s, bid) {
  const supported = Boolean(capsOf(bid).compatEndpoints);
  const list = supported ? await compatEndpoints.load().catch(() => []) : [];
  const value = supported ? endpointOf(s) : "";
  state.endpointShown = Boolean(s) && supported;
  const chosen = list.find((e) => e.id === value);
  const warning = !value ? "" : !chosen ? t("chat.endpoint.deletedWarning")
    : chosen.ready === false ? t("chat.endpoint.failedWarning", { name: chosen.name }) : "";
  if (endpointWarning && $("settingsError").textContent === endpointWarning) $("settingsError").textContent = "";
  endpointWarning = warning;
  if (warning) $("settingsError").textContent = warning;
  state.endpoint = value;
}
/** 入力欄のモデルの面に渡す接続先の値と口（web/composer-controls.mjs の endpointSection / compatModelSection） */
function endpointView(bid) {
  if (!state.endpointShown) return null;
  const list = compatEndpoints.list(bid);
  const defaults = compatEndpoints.defaults();
  const row = list.find((e) => e.id === state.endpoint) ?? null;
  const official = bid === "claude" ? t("chat.endpoint.officialClaude") : t("chat.endpoint.officialCodex");
  return {
    selected: state.endpoint, row, lost: lostText(bid),
    roleNames: bid === "claude" ? CLAUDE_ROLES.map((r) => [r.key, r.short]) : [],
    options: [
      { value: "", label: t("chat.endpoint.official"), sub: official, isDefault: !defaults[bid] },
      ...list.map((e) => ({ value: e.id, label: e.name, isDefault: defaults[bid] === e.id, warn: e.ready === false,
        sub: `${KIND_LABEL[e.kind]} · ${e.baseUrl.replace(/^https?:\/\//, "")}${e.ready === false ? t("chat.endpoint.failedSuffix") : ""}`, title: `${e.name}（${e.baseUrl}）` })),
      ...(state.endpoint && !row ? [{ value: state.endpoint, label: t("chat.endpoint.deleted"), sub: t("chat.account.chooseAgain"), gone: true }] : []),
    ],
    manage: () => compatEndpoints.open(bid),
  };
}

/** 作業ディレクトリを変える（入力欄のチップ・フォルダーを送り終えたとき）。送信済みの会話は次のターンから */
function applyCwd(v) {
  state.cwd = v;
  controls.paint();
  // 会話がまだ無い間、または作ったばかりで一覧に行が載る前は、作業場所は草稿（syncTopbar が読む）に持つ
  if (!state.current || justCreated()) state.draft.cwd = v;
  if (!state.current) return;
  // 保存できるまでは弱い字。失敗したら reserveSettings がチップを元の値へ戻す
  const ticket = ++cwdSaving;
  $("cwdChip").classList.add("saving");
  const write = reserveSettings({ cwd: v });
  write?.catch(() => {}).finally(() => { if (ticket === cwdSaving) $("cwdChip").classList.remove("saving"); });
  return write;
}

// 手元のフォルダーをホストへ送る（リモートの窓だけ。入口は添付のボタンのメニュー。web/folder-upload.mjs・web/attach-menu.mjs、
// docs/remote.md §8.1）。送り終えたら、「作業フォルダーにする」が入なら送り先を送り始めたときの会話の作業フォルダーにする。
// 切ってあれば作業フォルダーは変えず、送り先を会話に一行で知らせる
const folderUpload = canSendFolders() ? createFolderUpload({
  cmd,
  connected: () => ws?.readyState === WebSocket.OPEN,
  session: () => state.current ?? null,
  onDone: async (dest, sessionId, { makeCwd = true } = {}) => {
    if (!makeCwd) return "other";   // 送り先は送る面の「applied.other」が知らせる
    if (sessionId === (state.current ?? null)) {
      const unsent = !sessionId || state.sessions.find((s) => s.id === sessionId)?.unsent;
      applyCwd(dest);
      return unsent ? "now" : "next";
    }
    if (!sessionId) return "other";
    await cmd("setTurnSettings", { sessionId, cwd: dest });
    return "next";
  },
  onChange: () => attachMenu?.refresh(),
}) : null;
let attachMenu = null;   // 添付のボタンのメニュー（wireDropZone で作る。出どころを選べる接続でだけ開く）

/** 添付のボタンの読み上げと title を、出どころを選ばせるかに合わせる（hostCapabilities が届いたときにも） */
function syncAttachButton() {
  const b = $("attach"), menu = Boolean(currentAttachSources());
  b.title = menu ? t("chat.attach.source.buttonTitle") : t("chat.composer.attach");
  b.setAttribute("aria-label", b.title);
  if (menu) { b.setAttribute("aria-haspopup", "dialog"); if (!b.hasAttribute("aria-expanded")) b.setAttribute("aria-expanded", "false"); }
  else { b.removeAttribute("aria-haspopup"); b.removeAttribute("aria-expanded"); }
}

// 入力欄の設定のチップ（web/composer-controls.mjs）。値は state に持ち、チップは get() で毎回読む
const composerQuota = new Map();
/** 未送信の会話で「bot なし」のときに動くエージェント（bot を選んでいる間も、bot なしの札にはこちらを出す） */
function homeBackend() {
  const s = state.sessions.find(x => x.id === state.current);
  const chosen = !s || justCreated() ? draftView(state.draft.changes) : null;
  return chosen?.backend ?? s?.nextSettings?.backend ?? activeBackendId();
}
/** Chats の未送信で選んだ bot の動かし方（表示だけ）。「Codex · Fake 1 · medium · 都度確認」 */
function homeBotSetup(bot) {
  // チップと同じ字（syncTopbar が bot の既定を state.model・effort・mode に入れている）
  const mode = state.modes?.[state.mode]?.label ?? state.mode ?? '';
  return [labelOf(bot.backend), modelChipLabel(state.models, state.model, state.efforts, state.effort), mode].filter(Boolean).join(' · ');
}
// i18n-dynamic: channels:side.botState.
const controls = chatComposer.useControls({
  cmd,
  get: () => {
    const bid = state.shownBackend ?? activeBackendId();
    const bot = homeDest.bot;
    const sent = !unsentHere();
    return {
      // bot を選んだ未送信の会話は、bot が実際に使う値を表示だけ（一時チャットには作業場所が無いので、bot の最初のフォルダーかホーム。core/bots/sessions.mjs の pickCwd）
      cwd: bot ? bot.folders?.[0]?.path || state.homeDir || state.cwd : state.cwd, recent: cwdOptions(), cwdDisabled: Boolean(bot),
      backends: state.backends, backend: bid,
      // エージェントが 1 つしか無ければ選ぶ口を出さない
      backendSwitchable: state.backends.length > 1,
      models: state.models, model: state.model,
      efforts: state.efforts, effort: state.effort, effortDisabled: state.effortDisabled,
      accounts: !bot && state.accountShown ? accountOptions() : null, account: state.account,
      endpoint: bot ? null : endpointView(bid),
      modes: state.modes, mode: state.mode,
      modeDisabled: Boolean(bot),
      // 押せない理由（作業ディレクトリ・承認モードのチップの title と読み上げに足す）
      lockedNote: bot ? t('composer.destination.locked', { name: bot.name }) : '',
      destination: {
        sent, bot, selected: homeDest.selected, readOnlyBot: bot, fixedAfterSend: true,
        botSetup: bot ? homeBotSetup(bot) : '',
        openBot: id => document.dispatchEvent(new CustomEvent('channels:show', { detail: { kind: 'bot', id } })),
        backendLabel: labelOf, onPick: id => homeDest.choose(id),
        usage: destinationUsage(composerQuota.get(bid), { account: bot ? '' : state.account,
          open: () => { onboarding.open('usage'); $('usageTab').click(); } }),
        groups: sent ? [] : [{ options: [
          { id: null, name: t('channels:homeDest.none'), backend: homeBackend() },
          ...homeDest.bots.map(b => ({ id: b.id, name: b.name, bot: b, backend: b.backend, backendLabel: labelOf(b.backend),
            state: b.state ? t(`channels:side.botState.${['working', 'waiting', 'resting'].includes(b.state) ? b.state : 'idle'}`) : '',
            waiting: b.state === 'waiting', working: b.state === 'working' })),
        ] }],
      },
      git: state.git.data,
      worktree: state.worktree.data,
      // 別の会話が同じリポジトリに書き込み中なら { who }。チップと面に知らせる
      worktreeBusy: worktreeBusyPlan(),
    };
  },
  on: {
    cwd: applyCwd,
    worktreeSplit: () => startWorktree(),
    worktreeBack: () => backFromWorktree(),
    backend: (v) => { state.shownBackend = v; controls.paint(); chooseSettings({ backend: v, model: "" }); },
    model: (v) => { state.model = v; controls.paint(); chooseSettings({ model: v, rememberModel: true }); },
    // 互換の接続先。'' は公式。モデルは接続先の既定（メイン）に戻る（server も同じ）
    endpoint: (v) => { state.endpoint = v; state.model = ""; state.effort = ""; controls.paint(); chooseSettings({ endpoint: v }); },
    // Claude のアカウント。'' はログイン中のアカウント（既定）
    account: (v) => { state.account = v; controls.paint(); chooseSettings({ account: v }); },
    effort: (effort) => { state.effort = effort; controls.paint(); chooseSettings({ effort, rememberEffort: true }); },
    mode: (v) => {
      state.mode = v;
      controls.paint();
      // 新しい会話の欄（まだ会話が無い・作っている間）: 覚える印つきで集め、会話ができたらそこへ流す。
      // 以前はここで setPref を送り、新しい会話に届かないまま既定のモードだけを書き換えていた
      if (!state.current) { chooseSettings({ mode: v, rememberMode: true }); return; }
      if (justCreated()) noteDraftChange({ mode: v, rememberMode: true });
      const sessionId = state.current, backend = activeBackendId();
      const s = state.sessions.find(s => s.id === sessionId);
      if (s?.nextSettings?.backend && s.nextSettings.backend !== backend) {
        reserveSettings({ mode: v, rememberMode: true });
        return;
      }
      // 会話のモードを覚えさせる（setMode は次に新しく始めるときの既定にもする）
      modeWrite = modeWrite.catch(() => {}).then(() => cmd("setMode", { sessionId, mode: v, reasonKey: "manual" }));
      modeWrite.catch(e => composerError(t("chat.sys.modeSaveFailed", { error: e.message })));
    },
    // モデルの面を開いた。候補を裏で取り直し、変わっていたら描き直す
    openModel: () => {
      const backend = state.shownBackend ?? activeBackendId();
      revalidateVocab(backend);
      usageSource.load(backend).catch(() => {});
    },
  },
});

// カーソル位置の「/」。候補はコンテキスト画面と同じ探索結果から来る（core の slashSkills）。
// 送信・下書きの後片付けからも触るので、入力欄と送信の配線より先に用意する
const slashSkills = chatComposer.useSlash({
  cwd: () => state.cwd.trim() || state.draft.cwd || "",
  canCompact: () => canCompactHere(),
  load: (cwd) => cmd("slashSkills", { cwd: cwd || undefined }),
  off: () => shellComposer.active || composerEditor.inCode(),
});

// ---------------------------------------------------------------- セッション一覧（web/side.mjs）

// 脇の並べ方（「チャンネル」|「状態」。docs/design-system.md「脇」）。端末ごとに覚える。前の版の札（Chats / Channels）を選んでいたら、その並びから始める
const SIDE_ORDER_KEY = 'agent-host-side-order';
let sideOrder = 'status';
try { sideOrder = localStorage.getItem(SIDE_ORDER_KEY) ?? (localStorage.getItem('agent-host-side-tab') === 'channels' ? 'channel' : 'status'); } catch {}
if (sideOrder !== 'channel') sideOrder = 'status';
// Bots・ルーティンの節（web/channels/sidebar.mjs が描く）。チャンネルの並べ方の間、一覧の末尾に入る
const channelExtraNodes = [...document.querySelectorAll('#channelsSide .cs-sec[data-sec="bots"], #channelsSide .cs-sec[data-sec="routines"]')];
// メインの面（会話 / Channels）。channelsUi はこの後で作るので、作る前（起動の途中）は会話の面とみなす
const surface = () => { try { return channelsUi.tab; } catch { return 'chats'; } };
/** 脇の行の id がスレッドの行（"thread:<チャンネル>:<根>"）なら { channelId, threadId } */
const threadOfRow = (id) => { const m = /^thread:([^:]+):(.+)$/.exec(String(id ?? '')); return m ? { channelId: m[1], threadId: m[2] } : null; };

const side = createSide({
  onOpen: (id, jump) => {
    const thread = threadOfRow(id);
    if (thread) return viewAddress.go(thread);
    channelsUi.setTab('chats');
    return id == null || id === pendingNewSession?.id ? startNew(state.draft) : openFromSearch(id, jump);
  },
  onOpenChannel: (channelId) => viewAddress.go({ channelId }),
  // チャンネルの見出しの ＋: 流れを開いて、流れの入力欄（新しいスレッドを書く所）へ
  onNewInChannel: (channelId) => {
    viewAddress.go({ channelId });
    requestAnimationFrame(() => document.querySelector('#chFeed .ch-input')?.focus({ preventScroll: true }));
  },
  channelExtras: () => channelExtraNodes,
  // 本文まで探す。画面は新しい WS コマンドを足さず、操作の一覧の sessions.search を汎用の invoke で呼ぶ（core/ops/sessions.mjs）
  onSearch: (input) => cmd("invoke", { op: "sessions.search", args: input }),
  onNew: startNew,
  onSetStatus: (id, status) => {
    if (id == null) {
      state.draft.status = status || null;
      side.keep(status);
      renderSessions();
      return;
    }
    side.keep(status);
    setStatusOf(id, status);
  },
  onSetIcon: (status, icon) => cmd("setStatusIcon", { status, icon })
    .catch((e) => sideNote(t("session.menu.iconFailed", { error: e.message }))),
  onContext: (s, x, y) => (s.thread ? threadMenu(s, x, y) : rowMenu(s, x, y)),
  onGroupContext: (st, x, y) => groupMenu(st, x, y),
  onFamilyContext: (root, members, x, y) => familyMenu(root, members, x, y),
  onSetGrouped: (s, ungrouped) => setGrouped(s, ungrouped),
  onJoinGroup: (s, root) => joinGroup(s, root),
  onMoveGroup: (root, status) => moveGroup(root, status),
  onListContext: (x, y) => showMenu(x, y, [newGroupItem()]),
  onSettings: () => openSettings(),
  cwdNow: () => state.cwd,
  visible: () => !document.body.classList.contains("settings") && (narrowView.matches ? drawerOpen() : !document.documentElement.classList.contains("side-closed")),
});

// ---- 脇のスレッドの行（channels.threads の索引。web/side.mjs の 2 つの並べ方）
const THREAD_INDEX_EVENTS = new Set(['channelThread', 'channelPost', 'channelsChanged', 'channelRead', 'botsChanged']);
let threadIndexTimer = 0;
async function loadThreadIndex() {
  clearTimeout(threadIndexTimer);
  try {
    state.threadIndex = await cmd('invoke', { op: 'channels.threads', args: { all: true } });
    renderSessions();
  } catch { /* 読めなければ前の索引のまま（接続し直したら読み直す） */ }
}
function loadThreadIndexSoon() {
  clearTimeout(threadIndexTimer);
  threadIndexTimer = setTimeout(loadThreadIndex, 150);
}

/** スレッドの bot の会話の作業場所（最初に見つかった会話の cwd）。無ければ空 */
function threadCwd(s) {
  const th = (state.threadIndex?.threads ?? []).find((x) => x.channelId === s.thread.channelId && x.threadId === s.thread.threadId);
  for (const sid of Object.values(th?.sessions ?? {})) { const cwd = state.sessions.find((z) => z.id === sid)?.cwd; if (cwd) return cwd; }
  return '';
}

/** スレッドの行のメニュー: 開く・流れを開く・作業フォルダーと ID のコピー・状態（会話と同じ状態のグループ） */
function threadMenu(s, x, y) {
  const { channelId, threadId } = s.thread;
  const known = [...new Set([...state.sessions.map((z) => z.status), ...(state.threadIndex?.threads ?? []).map((th) => th.status)].filter(Boolean))];
  const setStatus = (status) => cmd('invoke', { op: 'channels.setThreadStatus', args: { channelId, threadId, status } })
    .then(() => { side.keep(status); loadThreadIndex(); }).catch((e) => sideNote(t('session.statusFailed', { error: e.message })));
  showMenu(x, y, [
    { label: t('channels:side.openThread'), onClick: () => viewAddress.go({ channelId, threadId }) },
    { label: t('channels:side.openFeed'), onClick: () => viewAddress.go({ channelId }) },
    // 作業フォルダー（スレッドの bot の会話の作業場所）と ID のコピー（Chats の会話の行と同じ）
    ...(threadCwd(s) ? [{ label: t("session.menu.copyCwd"), hint: threadCwd(s), onClick: () => copy(threadCwd(s), t("session.menu.cwdCopied"), t("session.menu.cwdCopyFailed")) }] : []),
    { label: t("session.menu.copyId"), onClick: () => copy(threadId, t("session.menu.idCopied"), t("session.menu.idCopyFailed")) },
    { label: t('session.menu.changeStatus'), hint: s.status || t('session.status.none'), sub: () => [
      { input: { placeholder: t('session.menu.newStatus'), onCommit: (v) => setStatus(v) } },
      ...known.map((k) => ({ label: k, checked: k === s.status, onClick: () => setStatus(k) })),
      { sep: true },
      { label: t('session.menu.clearStatus'), onClick: () => setStatus('') },
    ] },
  ], s.title || t('session.untitled'));
}

// 並べ方の切り替え（#sideOrder）。押す・←→ で替える。メインの面は替えない
{
  const box = $('sideOrder');
  const buttons = [...box.querySelectorAll('[data-order]')];
  const paintOrder = () => {
    for (const b of buttons) { const on = b.dataset.order === sideOrder; b.setAttribute('aria-checked', String(on)); b.tabIndex = on ? 0 : -1; }
    document.documentElement.classList.toggle('side-order-channel', sideOrder === 'channel');
  };
  const setOrder = (next, focus = false) => {
    if (next !== 'channel' && next !== 'status') return;
    sideOrder = next;
    try { localStorage.setItem(SIDE_ORDER_KEY, next); } catch {}
    paintOrder();
    renderSessions();
    if (focus) buttons.find((b) => b.dataset.order === next)?.focus();
  };
  for (const b of buttons) b.addEventListener('click', () => setOrder(b.dataset.order));
  box.addEventListener('keydown', (e) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
    e.preventDefault();
    setOrder(e.key === 'Home' || e.key === 'ArrowLeft' ? 'channel' : 'status', true);
  });
  paintOrder();
}

function renderSessions() {
  // 委譲された子の会話（Pleiad タスク）は一覧に出さない。開くのは「Pleiad タスク」の一覧から。
  // 依頼元の会話を消した子（ADR 0147）は、開く口が無くなるので一覧に出す
  // bot の会話（Channels のスレッド・DM・ルーティン。ADR 0109）は会話としては出さない。スレッドは下の threadRows が 1 スレッド 1 行で出す。
  // DM・ルーティンの会話は、あなたを待っている間だけ出る
  // 端末の AI から任された会話（delegation.remote）は、依頼元の会話がこの PC に無いので一覧に出す（⇄ の印つき）
  const ids = new Set(state.sessions.map(s => s.id));
  const listed = state.sessions.filter(s => (!s.delegation || s.delegation.remote || !ids.has(s.delegation.parentSessionId)) && (!s.bot || (state.waitingIds.has(s.id) && s.bot.kind !== 'thread')));
  const unreadIds = new Set(listed.filter(s => readCompletions.hasUnread(s)).map(s => s.id));
  // bot のスレッド（channels.threads の索引）。会話に似た行にして、走っている・あなた待ち・未読の印は会話と同じ集合で渡す
  const runningIds = new Set(state.runningIds), waitingIds = new Set(state.waitingIds);
  const threadRows = (state.threadIndex?.threads ?? []).map((th) => {
    const id = `thread:${th.channelId}:${th.threadId}`;
    if (th.state === 'working' || Object.values(th.live ?? {}).includes('working')) runningIds.add(id);
    if (th.state === 'waiting' || Object.values(th.live ?? {}).includes('waiting')) waitingIds.add(id);
    if (th.unread) unreadIds.add(id);
    return { id, thread: { channelId: th.channelId, threadId: th.threadId, ...(th.branchOf ? { branch: true } : {}) }, bot: { botId: th.bots?.[0] ?? null, channelId: th.channelId, threadId: th.threadId, kind: 'thread' },
      title: th.title, status: th.status ?? '', lastModified: th.lastAt };
  });
  // 脇で選ばれて見える行: Channels の面ではそのスレッド、会話の面では開いている会話
  const where = (() => { try { return viewAddress.current; } catch { return null; } })();   // 起動の途中（アドレスを作る前）は無い
  const currentId = surface() === 'channels' && !document.body.classList.contains('home-split') ? (where?.threadId ? `thread:${where.channelId}:${where.threadId}` : null)
    : pendingNewSession && !state.current ? pendingNewSession.id : state.current;
  // 脇が見えていない間の印（web/open-sidebar-mark.mjs）。今の会話は数えない
  paintOpenSidebar($("openSidebar"), attentionCounts(listed, { currentId: state.current, waitingIds: state.waitingIds, unreadIds,
    busyIds: new Set([...state.runningIds, ...state.bgWaiting.keys()]) }), t);
  side.render(listed, {
    statuses: state.statuses,
    currentId,
    runningIds,
    waitingIds,
    threads: threadRows,
    order: sideOrder,
    bgWaiting: state.bgWaiting,
    unreadIds,
    // 中断した会話（注意の三角）。未読は --ink、既読は --ink-weak（web/interrupt.mjs）
    interrupted: new Map(listed.filter(isInterrupted).map(s => [s.id, { ...s.interrupted, unread: interruptUnread(s, readCompletions.readAt(s.id)) }])),
    draft: null,      // 新規のときだけ。予約は current が無いときに意味を持つ
    backendLabels: backendLabels(),
    pendingRows,
    pendingStatuses,
    pendingNew: pendingNewSession,
    schedules: sideSchedules(),
  });
  syncResumeStrip();
  syncResume();
  paintCrumb();
  try { channelsUi.homeChanged(); } catch { /* 起動の途中（Channels の面を作る前） */ }
}

// ---- 一時チャット（docs/design-system.md「一時チャットの流れ」）
/** 会話の頭のパンくず「# 一時チャット ›」。一時チャットの会話のときだけ（bot の会話・委譲の子・流れの右に並べているときは出さない） */
function paintCrumb() {
  const s = state.sessions.find((x) => x.id === state.current);
  const show = Boolean(s) && !s.bot && !s.delegation && !document.body.classList.contains('home-split');
  $('crumbHome').hidden = !show;
  $('crumbSep').hidden = !show;
}
$('crumbHome').onclick = () => viewAddress.go({ channelId: 'home' });

/** 流れの右に会話を並べる（幅が 900px 以上で右パネルが閉じているとき）。並べられないときは会話の面へ */
const homeSplitFits = () => (document.querySelector('body > main')?.clientWidth ?? 0) >= 900 && !document.body.classList.contains('file-preview-open');
function setHomeSplit(on) {
  if (document.body.classList.contains('home-split') === on) return;
  document.body.classList.toggle('home-split', on);
  try { channelsUi.tabs.paint(); } catch { /* 起動の途中 */ }
  paintCrumb();
}
async function openHomeThread(sessionId) {
  if (document.body.classList.contains('home-feed') && surface() === 'channels' && homeSplitFits()) {
    setHomeSplit(true);
    if (state.current !== sessionId) await select(sessionId);
    viewAddress.note({ sessionId });
    renderSessions();
    return;
  }
  setHomeSplit(false);
  await viewAddress.go({ sessionId });
}
// 幅が足りなくなった・右パネルを開いた: 並べるのをやめて会話の面へ
const dropSplitIfNarrow = () => { if (document.body.classList.contains('home-split') && !homeSplitFits()) { setHomeSplit(false); channelsUi.setTab('chats'); } };
addEventListener('resize', dropSplitIfNarrow);
new MutationObserver(dropSplitIfNarrow).observe(document.body, { attributes: true, attributeFilter: ['class'] });

/** 一時チャットの流れの入力欄に書いた: 新しい会話を作って送る（作業ディレクトリ・モデル・承認モードは新しい会話の既定） */
async function newHomeThread({ text, attachments = [] }) {
  const split = homeSplitFits();
  if (split) setHomeSplit(true); else channelsUi.setTab('chats');
  const id = await startNew();
  if (!id || state.current !== id) throw new Error(t('chat.send.failed', { error: 'new session' }));
  $('prompt').value = text;
  state.attached = attachments.map((a) => ({ path: a.path, name: a.name ?? shortPath(a.path), kind: 'file', mime: a.mime ?? '', from: 'host' }));
  renderAttached();
  await submit();
  viewAddress.note({ sessionId: id });
}

/** 一時チャットの流れの投稿の ⋯ の「状態を変更」（会話の状態と同じ器） */
function homeStatusItems(sessionId) {
  const s = state.sessions.find((x) => x.id === sessionId);
  const known = [...new Set(state.sessions.map((z) => z.status).filter(Boolean))];
  return [{ label: t('session.menu.changeStatus'), hint: s?.status || t('session.status.none'), sub: () => [
    { input: { placeholder: t('session.menu.newStatus'), onCommit: (v) => setStatusOf(sessionId, v) } },
    ...known.map((k) => ({ label: k, checked: k === s?.status, onClick: () => setStatusOf(sessionId, k) })),
    { sep: true },
    { label: t('session.menu.clearStatus'), onClick: () => setStatusOf(sessionId, '') },
  ] }];
}

// ---------------------------------------------------------------- 中断と再開（docs/design-system.md「中断と再開」）

const currentSession = () => state.sessions.find(s => s.id === state.current) ?? null;
// 再開を送った会話 -> 待ちの上限のタイマー。送ってからターンが始まる（applyRunning）か終わる（turnEnd）まで、
// 再開ボタンを押せないままにする（中断の印はサーバーが消すまで下ろさない。先に下ろすと、何も始まらなかったときに嘘になる）
const resuming = new Map();
const RESUME_HOLD_MS = 15000;
function resumeSettled(sessionId) {
  if (!resuming.has(sessionId)) return false;
  clearTimeout(resuming.get(sessionId));
  resuming.delete(sessionId);
  return true;
}

/**
 * 会話の末尾の「■ 中断しました · 14:32」。保存された中断（セッションの interrupted）から描くので読み直しても消えない。
 * ライブの中断（turnResult）も同じ関数で描く。最後の人間の発言より後に既に 1 行あれば、文だけ合わせて足さない
 */
function paintInterruptLine(live) {
  const s = currentSession();
  const interrupted = live ?? (isInterrupted(s) ? s.interrupted : null);
  if (!interrupted || (!live && isRunningHere())) return;
  const last = [...thread.querySelectorAll('.m.sys[data-interrupted]')].at(-1);
  const lastUser = [...thread.querySelectorAll('.m.user')].at(-1);
  const line = last && (!lastUser || lastUser.compareDocumentPosition(last) & Node.DOCUMENT_POSITION_FOLLOWING) ? last : null;
  // ライブの行は届いた理由・時刻で描いてある。保存された方が正なので、同じ行を描き直す
  const m = line ?? el('div', 'm sys interrupted');
  m.dataset.interrupted = reasonOf(interrupted);
  const at = Number(interrupted.at);
  if (reasonOf(interrupted) === 'limit') {
    // 1 行目は「■ 使用量の上限に達したため中断しました（private · 5 時間枠）· 01:43」。2 行目に解除の時刻
    const scope = [capsOf(interrupted.backend).claudeAccounts ? accountLabel(interrupted.account) : '',
      interrupted.window === 'five_hour' ? t('interrupt.limitWindowFiveHour') : interrupted.window ?? ''].filter(Boolean).join(' · ');
    // ■・本文・時刻は 1 つの流れの文にする（狭い幅でも ■ は本文の 1 文字目の前に付いたまま、時刻は本文の末尾に続く）
    const head = el('span', 'limit-interrupt-head');
    head.append(stopMark(), el('span', null, scope ? t('interrupt.limitHead', { line: interruptLineText(interrupted), scope }) : interruptLineText(interrupted)));
    if (Number.isFinite(at) && at > 0) head.append(el('span', 'sep', '·'), el('span', 't', hhmm(at)));
    const sub = el('span', 'limit-interrupt-sub');
    sub.append(el('span', null, limitLineNote(interrupted)));
    m.classList.add('limit');
    m.replaceChildren(head, sub);
  } else {
    m.classList.remove('limit');
    m.replaceChildren(stopMark(), el('span', null, interruptLineText(interrupted)));
    if (Number.isFinite(at) && at > 0) m.append(el('span', null, '·'), el('span', 't', hhmm(at)));
  }
  if (!line) append(m);
}

let limitClockTimer = null;
/**
 * 入力欄の「▶ 再開」。中断状態・走っていない・欄が空のときだけ「中断」の位置に出す。
 * 保留の未送信があれば「保留中の N 件を送って再開」。字を書いたら隠し、欄の下に「送ると、この指示で続けます」。
 * 中断中だけプレースホルダを「指示を変えて続ける…」にする
 */
function syncResume() {
  const s = currentSession();
  const interrupted = isInterrupted(s) && !retiredHere() && state.current !== freshSessionId;
  const running = isRunningHere() || submittingMessages.has(state.current);
  const text = $('prompt').value;
  const attached = state.attached.length > 0 || uploadsHere().length > 0;   // 送っている途中の添付も「書いてある」に数える
  const show = resumeVisible({ interrupted, running, waiting: isWaitingHere(), text, attached });
  const button = $('resume');
  const paused = interrupted ? pausedCount(outboxes.get(state.current)) : 0;
  const label = resumeLabel(paused, s?.interrupted);
  const limitState = interrupted ? limitResumeState(s.interrupted) : null;
  if ($('resumeLabel').textContent !== label) {
    $('resumeLabel').textContent = label;
    button.title = label;
    button.setAttribute('aria-label', label);
  }
  // 480px 以下の上限の時計は時刻だけ（全文は title と読み上げ名に残る）
  $('resumeShort').textContent = resumeShortLabel(s?.interrupted);
  // 上限の解除前の時計は押せない表示。解除の後（解除時刻が分からない上限も）は普通の「再開」
  const waitingClock = limitState === 'release';
  button.classList.toggle('is-limit', waitingClock);
  button.disabled = resuming.has(state.current) || waitingClock;
  clearTimeout(limitClockTimer);
  // 解除時刻に時計から「再開」へ描き直す
  if (waitingClock) {
    const switchAt = s.interrupted.resetsAt + 500;
    limitClockTimer = setTimeout(() => { syncResume(); renderSessions(); }, Math.min(2_147_000_000, Math.max(1000, switchAt - Date.now())));
  }
  const note = $('resumeNote');
  note.hidden = !interrupted || running;
  // 保留があれば、送った指示は保留の後ろに並ぶ（サーバーが保留を先に送り直す。sendMessage）
  const noteText = resumeNoteText(paused, s?.interrupted);
  if (note.textContent !== noteText) note.textContent = noteText;
  // 書いていない間も高さは取っておく（書き始めたときに入力欄が跳ねない）
  note.classList.toggle('quiet', !(text.trim() || attached));
  const placeholder = t('interrupt.placeholder');
  if (!$('prompt').disabled) {
    if (interrupted && !running) $('prompt').placeholder = placeholder;
    else if ($('prompt').placeholder === placeholder) $('prompt').placeholder = promptPlaceholder();
  }
  if (button.hidden === show) { button.hidden = !show; controls.fit(); }
  syncSendMore();
}

/**
 * 再開。サーバーが保留・送れなかった未送信を送るか、理由に合った「続けて」の文を普通の送信で送る（WS resume）。
 * 中断の印はここでは下ろさない。ターンが始まれば applyRunning と turnEnd が下ろす。それまでボタンは押せない
 */
async function resumeSession(sessionId) {
  if (!sessionId || resuming.has(sessionId)) return false;
  resuming.set(sessionId, null);
  syncResume();
  try {
    await cmd('resume', { sessionId });
  } catch (e) {
    resumeSettled(sessionId);
    renderSessions();
    throw e;
  }
  // 始まらないまま（同時実行の上限待ちなど）でも、ずっと押せないままにはしない
  if (resuming.has(sessionId)) resuming.set(sessionId, setTimeout(() => { if (resumeSettled(sessionId)) syncResume(); }, RESUME_HOLD_MS));
  renderSessions();
  return true;
}

$('resume').onclick = () => {
  const sessionId = state.current;
  completionNotifications.requestPermission();
  $('settingsError').textContent = '';
  resumeSession(sessionId).catch(e => { $('settingsError').textContent = t('interrupt.resumeFailed', { error: e.message }); });
};

const limitOp = (op, args = {}) => cmd('invoke', { op, args });

/** 脇の下の「更新で中断した会話が N 件あります［まとめて再開］［×］」。× は閉じたときの最大の at を覚える */
const RESUME_STRIP_KEY = 'ply-update-interrupts-dismissed';
function resumeStripDismissed() {
  try { return Number(localStorage.getItem(RESUME_STRIP_KEY)) || 0; } catch { return 0; }
}
let resumeStripError = '';
// 更新で Pleiad が再起動した後だけ出す: サーバーの起動（ready の startedAt）より前の中断だけを数え、
// この画面で更新を進めている間（作業の中断・保存・インストール）は出さない
const updateInterruptedNow = (dismissedAt) => updateInterrupted(state.sessions, dismissedAt, { startedAt: state.serverStartedAt ?? 0 });
function syncResumeStrip() {
  const { ids, maxAt, show } = updateInterruptedNow(resumeStripDismissed());
  const strip = $('resumeStrip');
  strip.hidden = updatesUi?.applying || (!show && !resumeStripError);
  if (strip.hidden) return;
  $('resumeStripText').textContent = resumeStripError || t('interrupt.strip', { count: ids.length });
  strip.classList.toggle('failed', Boolean(resumeStripError));
  $('resumeAll').hidden = !ids.length;
  strip.dataset.maxAt = String(maxAt);
}
$('resumeAll').onclick = async () => {
  const { ids } = updateInterruptedNow(0);
  $('resumeAll').disabled = true;
  resumeStripError = '';
  const failed = [];
  for (const id of ids) {
    // 押した後に別の所（入力欄の再開・別の端末）で続いた会話は飛ばす。失敗には数えない
    if (!isInterrupted(state.sessions.find(s => s.id === id)) || resuming.has(id)) continue;
    await resumeSession(id).catch(e => { if (e.code !== 'NOT_INTERRUPTED') failed.push(e); });
  }
  $('resumeAll').disabled = false;
  if (failed.length) resumeStripError = t('interrupt.resumeAllFailed', { count: failed.length, error: failed[0].message });
  syncResumeStrip();
};
$('closeResumeStrip').onclick = () => {
  const { maxAt } = updateInterruptedNow(0);
  try { localStorage.setItem(RESUME_STRIP_KEY, String(Math.max(maxAt, resumeStripDismissed()))); } catch {}
  resumeStripError = '';
  syncResumeStrip();
};

function acknowledgeDisplayed(id, completedAt) {
  displayedCompletions.set(id, Math.max(displayedCompletions.get(id) ?? 0, completedAt ?? 0));
  if (document.visibilityState === "visible") readCompletions.mark(id, displayedCompletions.get(id));
  renderSessions();
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && state.current && !state.loadingSession) {
    acknowledgeDisplayed(state.current, displayedCompletions.get(state.current));
  }
});

/** 新しいセッション。絞り込みの条件（一意に定まるもの）を引き継ぐ */
let creatingSession = null;
let pendingNewSession = null;
async function startNew({ status = null, cwd = "", backend, changes } = {}) {
  if (state.busy || creatingSession) return creatingSession;
  setDrawer(false);
  saveDraft().catch(() => {});
  const source = state.current;
  const requestedCwd = cwd || state.cwd || state.homeDir || '';
  // もう新しい会話の欄にいる（作成に失敗してやり直す・最初の送信）なら、そこで選んだ設定（chooseSettings）を持ち越す。
  // 別の会話から作るときは、その会話の設定をサーバーが引き継ぐ（newSession の sourceSessionId）
  const carried = changes ?? (source ? [] : state.draft.changes ?? []);
  const chosen = draftView(carried);
  pendingNewSession = { id: `pending-${randomId()}`, title: t('pending.newSession'), status: status ?? '', cwd: requestedCwd,
    backend: backend ?? chosen.backend ?? state.backendId, lastModified: new Date().toISOString(), unsent: true };
  state.current = null;
  // changes: 作っている間も集め続ける。created: できた会話の id（できた後の選び直しはその場で流す）
  const draft = { status, cwd: pendingNewSession.cwd, changes: [...carried], created: null };
  state.draft = draft;
  state.messages = [];
  state.contextInfo = null;
  state.contextInfoId = null;
  // 入力欄は作っている間もずっと書ける（読み込むものが無い）。空にするのは別の会話から移ってきたときだけ。
  // もう新しい会話の欄にいる（作成に失敗してやり直す・最初の接続）なら、書いてある字と添付はそのまま新しい会話の下書きになる
  composerWait.idle();
  if (source) {
    $('prompt').value = '';
    state.attached = [];
    renderAttached();
    fitPrompt();
  }
  clearThread();
  syncTopbar();
  pendingRows.set(pendingNewSession.id, { kind: 'new', text: t('pending.creating'), visible: false });
  renderSessions();
  $('prompt').focus();
  const cancel = pendingAfterDelay(pendingRows.get(pendingNewSession.id));
  creatingSession = (async () => {
    try {
      await settingsWrite.catch(() => {});
      await modeWrite;
      const result = await cmd("newSession", { sourceSessionId: source, backend: backend ?? chosen.backend ?? (source ? undefined : state.prefs.backend ?? state.backendId),
        cwd: requestedCwd, status,
        ...Object.fromEntries(["model", "effort", "mode", "endpoint"].filter(k => chosen[k] !== undefined).map(k => [k, chosen[k]])) });
      pendingRows.delete(pendingNewSession.id);
      pendingNewSession = null;
      side.keep(status);

      // 作っている間に選んだ設定（作業場所・モデルなど）をできた会話へ流す。会話はすぐ開く（下の select）ので、ここから後の選び直しは
      // ふつうの予約になる。一覧に行が載るまでの表示は集めた変更が持つので、draft.created の間は chooseSettings・applyCwd が草稿にも残す。
      // 一覧の読み直しは待たずに会話を開き、履歴の読み込みと並べる（描く前に select が待つ）。sessionsChanged の分が走っていれば共有して 1 回にする。
      // 読み直しの写しが予約を書く前のものでも、書けた結果で合わせる（下の stagedNext）
      draft.created = result.sessionId;
      sendDraftSettings(draft, result.sessionId, requestedCwd);
      const listing = refresh({ sharePending: true }).catch(() => {});
      if (state.current === null) {
        // 開き直しと違い、欄に触らない（無効にしない・下書きを読み直さない）。写しも取らない:
        // 作っている間に書いた字は、終わった時点で欄にあるものがそのまま、この会話の下書きになる
        await select(result.sessionId, { fresh: true, after: listing });
        if (state.current === result.sessionId) {
          if ($('prompt').value || state.attached.length) await saveDraft().catch(() => {});
          dropBlankDraft();
        }
      } else if (state.drafts.get("")) {
        // 作っている間に別の会話へ移った。新しい会話の欄に書いてあった分（"" の下書き）は、この会話の下書きへ移す
        const blank = state.drafts.get("");
        if (blank.text || blank.attached?.length) persistDraft(result.sessionId, { ...blank, dirty: true }).catch(() => {});
        dropBlankDraft();
      }
      adoptUploads(result.sessionId);   // 作っている間に始めた添付（会話を開けなかった・別の会話へ移った場合も、できた会話のもの）
      await listing;
      await settingsWrite.catch(() => {});
      const staged = stagedNext.get(result.sessionId);
      stagedNext.delete(result.sessionId);
      const row = state.sessions.find(s => s.id === result.sessionId);
      if (row && staged !== undefined) row.nextSettings = staged;
      // 集めた設定は会話に渡し終えた（会話が消えて欄が新規に戻ったとき、古い選択を出さない）。ここから先のチップは会話の予約が元
      const touched = draft.changes.length > 0 || draft.cwd !== requestedCwd;
      if (state.draft === draft) { draft.changes = []; draft.created = null; }
      if (touched && state.current === result.sessionId) await syncTopbar().catch(() => {});
      return result.sessionId;
    } catch (e) {
      if (pendingNewSession) pendingRows.delete(pendingNewSession.id);
      pendingNewSession = null;
      renderSessions();
      // やり直しは、失敗の後に欄で選び直した作業場所・設定も引き継ぐ
      side.showUndo(t('pending.failed', { reason: e.message }), () => startNew({ status, cwd: draft.cwd || cwd, backend, changes: draft.changes }), { retry: true });
    }
    finally { cancel(); creatingSession = null; }
  })();
  return creatingSession;
}

/**
 * 「見直しを頼む」（ADR 0056「③ 見直しを頼む」。右パネルの指示の量の面）。同じ作業場所に未送信の新しい会話を作り、
 * 入力欄に依頼文の下書きを入れて開く。送らない。設定（エージェント・モデルなど）は今の会話から新しい会話を作るときと同じ引き継ぎ
 * （newSession の sourceSessionId）。下書きはサーバーが作るのと同時に保存する（開き直しても残る）。作っている間の二度目は同じ約束を返す
 */
let reviewDrafting = null;
function draftReview({ cwd, text }) {
  if (reviewDrafting) return reviewDrafting;
  const source = state.current;
  reviewDrafting = (async () => {
    try {
      await saveDraft().catch(() => {});
      await settingsWrite.catch(() => {});
      await modeWrite;
      const { sessionId } = await cmd("newSession", { sourceSessionId: source, cwd: cwd || state.cwd || state.homeDir || "", draft: text });
      await refresh().catch(() => {});
      await select(sessionId);
      // 依頼文は頭から読むので、欄の先頭を見せる（末尾に置くと下書きの終わりだけが見える）
      if (state.current === sessionId) { const p = $('prompt'); p.focus({ preventScroll: true }); p.setSelectionRange(0, 0); p.scrollTop = 0; }
      return sessionId;
    } finally { reviewDrafting = null; }
  })();
  return reviewDrafting;
}

function branchIsFresh(id) {
  const r = branches.family?.rows.get(id);
  return Boolean(r) && r.messages.length === r.k + 1;
}

// ---------------------------------------------------------------- バックグラウンド
// サブエージェント・委譲した Pleiad タスク・裏で動くコマンドを 1 つのダイアログ（左に一覧、右に詳細）にまとめる。
// 利用者から見ればネイティブのサブエージェントと Pleiad タスクの違いは要らないので、どちらも「サブエージェント」として並べ、
// モデル名で見分けられるようにする。入口は会話末尾の「バックグラウンド N」と、会話の中の委譲のツールカード。
// 詳細はメインパネルと同じ部品（筋・節・発言者と時刻・考えた内容・ツールカード・画像）で描く（docs/design-system.md「バックグラウンド」）。

/**
 * いま開いている画面に属する項目か。
 * id の決まっていないターン（走り出したばかり）を「新規セッション」の分として数えてはいけない。
 * 自分が送った直後（submitting）だけ、id 無しを自分の分とみなす。
 * ※ tests/unit/work-attribution.mjs に同じ規則を写してある。変えたら合わせること。
 */
function belongsHere(x) {
  if (state.current) return x.sessionId === state.current;
  return state.submitting && !x.sessionId;
}

/** 稼働表示のボタンの数と一覧に出す分。同じ規則で数える（tests/unit/work-attribution.mjs） */
const subagentsHere = () => (state.work.subagents ?? []).filter(belongsHere);
/** 走っている子か。状態を返せないバックエンドの子（status: null）も走っている側に置く（server の count と同じ） */
const subagentLive = (a) => a.status === "running" || a.status == null;

/**
 * 行の左端に置く状態の印（docs/design-system.md §2.2）。running は回る弧（走っている間だけ DOM に置く）、
 * 終わった子は静止した印。status が null（分からない）なら印を置かない
 */
const STATE_MARK = {
  running: { label: t("dialog.work.state.running") },
  completed: { shape: "done", label: t("dialog.work.state.completed") },
  failed: { shape: "fail", label: t("dialog.work.state.failed") },
  stopped: { shape: "stop", label: t("dialog.work.state.stopped") },
};
function stateMark(status) {
  const m = STATE_MARK[status];
  if (!m) return null;
  if (m.shape) return stillMark(m.shape, m.label);
  const run = runMark(m.label);
  run.setAttribute("role", "img");
  run.setAttribute("aria-label", m.label);
  return run;
}

// Pleiad タスクの状態 -> 行の印（サブエージェントと同じ語彙）。まだ終わっていないものは弧、文字の状態はそのまま残す
const TASK_STATUS = { queued: t('dialog.tasks.status.queued'), running: t('dialog.tasks.status.running'), cancelling: t('dialog.tasks.status.cancelling'),
  waiting: t('dialog.tasks.status.waiting'), completed: t('dialog.tasks.status.completed'), failed: t('dialog.tasks.status.failed'),
  cancelled: t('dialog.tasks.status.cancelled'), interrupted: t('dialog.tasks.status.interrupted') };
const TASK_MARK = { queued: 'running', running: 'running', cancelling: 'running', waiting: 'running',
  completed: 'completed', failed: 'failed', cancelled: 'stopped', interrupted: 'stopped' };
const TASK_LIVE = new Set(['queued', 'running', 'cancelling']);
/**
 * 委譲のタスクの行（web/task-cards.mjs）。running は終わっていない・通知が届いていない短い行だけなので、
 * 開いている会話の分（子孫まで。依頼文・振り分けの記録付き）を読んで持ち、running の行を重ねて使う。
 * rows: taskId → 行、live: 前の running の行（taskId → 行）、asked: 会話の中のカードのために読みに行った id。
 * 重ねた結果は、rows を書き換える（ver を進める）か running が届くまで使い回す（カードごとに引くので）
 */
const taskCards = { sessionId: null, rows: new Map(), ver: 0, live: new Map(), asked: new Set(), merged: null };
/**
 * Channels のスレッドが見ている bot の会話（子孫まで）の委譲の行。Chats の会話の分（taskCards.rows）とは別に持つので、Chats の会話を切り替えても消えない。
 * sessions: 見ている会話、rows: taskId → 行、loaded: 読み終えた会話、listeners: 一覧・数が変わったときに呼ぶ（スレッドの入口）。
 * 委譲のカード・一覧は Chats と同じ部品で、taskById / allTasks がこの行も引く
 */
const watched = { sessions: new Set(), rows: new Map(), loaded: new Set(), listeners: new Set() };
/** Channels の画面の委譲カード（スレッドの作業ログ）の置き場 → そのスレッドの範囲。card → { scope, sessionId, backend }（linkDelegateCard が覚える） */
const channelRoots = new Map();
const cardCtx = new WeakMap();
/** 委譲カードを探して描く置き場: Chats の会話と、Channels のスレッド。[置き場, 範囲 | null] */
const delegateRoots = () => [[thread, null], ...channelRoots];
const notifyWatchers = () => { for (const fn of [...watched.listeners]) fn(); };
function mergedTasks() {
  const m = taskCards.merged;
  if (m && m.ver === taskCards.ver && m.live === state.work.tasks) return m;
  const list = mergeTasks(watched.rows.size ? new Map([...watched.rows, ...taskCards.rows]) : taskCards.rows, state.work.tasks);
  return (taskCards.merged = { ver: taskCards.ver, live: state.work.tasks, list, byId: new Map(list.map(r => [r.taskId, r])) });
}
const allTasks = () => mergedTasks().list;
const taskById = (id) => (id ? mergedTasks().byId.get(id) : undefined);
/** その会話の分（子孫まで）を読む。読めなければ null */
async function readTaskCards(sessionId) {
  if (!sessionId) return null;
  const rows = await cmd('agentTasks', { sessionId, tree: true }).catch(() => null);
  return Array.isArray(rows) ? rows : null;
}
/** 会話を開いた・つなぎ直した・作業場所が変わった。その会話の分を読み直す（読めなければ今の分のまま） */
async function loadTaskCards(sessionId) {
  const rows = await readTaskCards(sessionId);
  if (rows && state.current === sessionId) setTaskCards(sessionId, rows);
}
function setTaskCards(sessionId, rows) {
  taskCards.sessionId = sessionId;
  taskCards.rows = new Map(rows.map(r => [r.taskId, r]));
  taskCards.ver++;
  taskCards.asked.clear();
  const stale = staleTasks(rows, state.work.tasks);
  if (stale.length) fetchTaskCards(stale, { again: false }).catch(() => {});
}
/** 指定の行だけ読み直す。読んでいる間に終わったもの（running から外れた）は、もう一度だけ読む */
async function fetchTaskCards(ids, { again = true } = {}) {
  const sessionId = taskCards.sessionId;
  const rows = [];
  for (let i = 0; i < ids.length; i += 100) {
    const part = await cmd('agentTasks', { taskIds: ids.slice(i, i + 100) }).catch(() => null);
    if (!Array.isArray(part) || taskCards.sessionId !== sessionId) return;
    rows.push(...part);
  }
  for (const r of rows) taskCards.rows.set(r.taskId, r);
  const forWatched = keepWatched(rows);
  taskCards.ver++;
  if (state.current === sessionId || forWatched) repaintTasks();
  const stale = staleTasks(rows, state.work.tasks);
  if (again && stale.length) fetchTaskCards(stale, { again: false }).catch(() => {});
}
/** running が届いた。この会話の木の新しい委譲と、終わって running から外れたものを読む */
function syncTaskCards() {
  const live = state.work.tasks ?? [];
  const ids = taskCards.sessionId === state.current
    ? tasksToFetch({ cards: taskCards.rows, live, prevLive: taskCards.live, sessionId: state.current }) : [];
  // Channels のスレッドが見ている会話の分も、同じ規則で（持っている行は Chats の分と合わせて引く）
  if (watched.sessions.size) {
    const cards = new Map([...watched.rows, ...taskCards.rows]);
    for (const sessionId of watched.sessions) ids.push(...tasksToFetch({ cards, live, prevLive: taskCards.live, sessionId }));
  }
  taskCards.live = new Map(live.map(r => [r.taskId, r]));
  if (ids.length) fetchTaskCards([...new Set(ids)]).catch(() => {});
}
/** 読んだ行のうち、Channels のスレッドが見ている会話の木に入るものを、その分の入れ物にも置く。置いたものがあれば true */
function keepWatched(rows) {
  if (!watched.sessions.size) return false;
  const all = [...watched.rows.values(), ...taskCards.rows.values(), ...rows];
  const tree = new Set([...watched.sessions].flatMap(id => [...treeSessions(id, all)]));
  let kept = false;
  for (const r of rows) if (watched.rows.has(r.taskId) || tree.has(r.parentSessionId)) { watched.rows.set(r.taskId, r); kept = true; }
  return kept;
}
/**
 * Channels のスレッドが見る会話（bot の会話）を決める。まだ読んでいない会話の分（子孫まで）を読む。force は読み直す（一覧を開いたとき。
 * 配信の間に始まって終わった子孫の委譲も出すため）
 */
function watchSessions(ids, { force = false } = {}) {
  watched.sessions = new Set(ids);
  if (force) for (const id of watched.sessions) watched.loaded.delete(id);
  for (const id of watched.sessions) {
    if (watched.loaded.has(id)) continue;
    watched.loaded.add(id);
    readTaskCards(id).then((rows) => {
      if (!rows) { watched.loaded.delete(id); return; }
      for (const r of rows) watched.rows.set(r.taskId, r);
      taskCards.ver++;
      const stale = staleTasks(rows, state.work.tasks);
      if (stale.length) fetchTaskCards(stale, { again: false }).catch(() => {});
      repaintTasks();
    }).catch(() => { watched.loaded.delete(id); });
  }
  notifyWatchers();
}
function repaintTasks() {
  paintDelegateCards();
  syncWorkEntry();
  if ($('workDialog').open) renderBackground();
}
/** 子の会話を親として辿り、この会話からの委譲とその子孫を集める。 */
const plyTasksHere = () => state.current ? taskTree(allTasks(), state.current) : [];
/** 子の会話が人間の承認を待っているか。work.tasks の status は保存した値なので、承認の一覧から引く */
const taskWaiting = (task) => task.host ? task.hostWaiting === true || (state.work.permissions ?? []).some(p => p.remote?.taskId === task.taskId)
  : (state.work.permissions ?? []).some(p => p.sessionId === task.sessionId && !p.relay);

/** ホストに任せたタスクの「⇄ ホスト名」の印（リモートのバッジと同じ差しの青）。ホストがオフラインの間は中抜きの丸（色だけに頼らず title と読み上げ名にも）。docs/remote.md §4.5 */
function hostMark(host) {
  const online = state.work.remoteHosts?.[host?.hostId]?.online !== false;
  const name = state.work.remoteHosts?.[host?.hostId]?.name ?? host?.name ?? "";
  const mark = el("span", `host-mark${online ? "" : " off"}`, t("chat.approval.relay.host", { host: name }));
  mark.title = online ? name : `${name} (${t("chat.approval.relay.hostOffline")})`;
  if (!online) mark.setAttribute("aria-label", `${t("chat.approval.relay.host", { host: name })} (${t("chat.approval.relay.hostOffline")})`);
  return mark;
}

// ---- ホストに任せた子の経過（docs/remote.md §4.5「経過の読み出し」、docs/design-system.md「バックグラウンド」） ----
// 詳細を開いている間だけ、ホストの子の会話を delegation.hostView で読む（今の読み直し refreshDetail と同じ作り。購読は持たない）。
/** 根のタスク id → 読み出しで知ったホストの子孫の要約。一覧へ字下げの行で出す（端末の台帳には保存しない。詳細を一度でも開いた後に出る） */
const hostTree = new Map();
/** タスク id → 最後に読み出しの答えに入った時刻（読んだタスク自身と、答えの子孫の要約の行。オフラインの「HH:MM までの分」・孫の行が古いかの目安） */
const hostSeen = new Map();
/** 孫の行が古くなる時刻に一覧を描き直す（「動いている」の数から外す）。1 つだけ持つ */
let hostStaleTimer = null;
const hostChildKey = (sessionId) => `hs:${sessionId}`;
const hostInfo = (hostId) => state.work.remoteHosts?.[hostId] ?? null;
const hostOnlineNow = (hostId) => hostInfo(hostId)?.online !== false;
/** オフラインの間の「ここまでの分」の時刻（ms）。線が使えなくなった時刻、無ければ最後に読めた時刻・台帳の更新 */
const hostUntil = (hostId, taskId, updatedAt) => hostInfo(hostId)?.since ?? hostSeen.get(taskId) ?? (timeOf(updatedAt) || null);
const clockOf = (ms) => (ms ? hhmm(new Date(ms)) : "");
/** 詳細の中に置く中継のカード（registerRelayCard が「詳細を見る」を出さない・同じ id のカードを重ねて持つ） */
let detailCardMode = false;

const KIND_SUB = {
  terminal: t("dialog.work.kind.terminal"),
  agent: t("dialog.work.kind.agent"),
  shell: t("dialog.work.kind.shell"),
  other: t("dialog.work.kind.other"),
};

/**
 * この会話で裏に動いているコマンドを、行ごとに平らにする。
 *
 * 2 つある。ターンの外に残っているもの（Codex の端末）と、
 * 走っているターンが抱えているもの（Claude のバックグラウンドのコマンド）。
 * ターンの中のサブエージェントは会話を読む専用の行が別にあるので、ここでは重ねない。
 */
function backgroundHere() {
  const rows = (state.work.background ?? []).filter(belongsHere)
    .flatMap((entry) => (entry.tasks ?? []).map((task) => ({ task, entry })));
  for (const turn of (state.work.turns ?? []).filter(belongsHere)) {
    for (const task of turn.background ?? []) {
      if (task.kind === "agent") continue;
      rows.push({ task, entry: { sessionId: turn.sessionId, backend: turn.backend } });
    }
  }
  return rows;
}

const timeOf = (v) => (v ? new Date(v).getTime() || 0 : 0);

/** history は過去のツールカードから findSubagent で引き直した子。 */
const bg = { scope: null, selected: null, extra: new Map(), history: new Map(), finding: new Set(), notFound: new Set(), view: null, narrowDetail: false, shownEnded: 10 };

/** Past native subagents no longer appear in runningWork; resolve their tool IDs from the loaded history. */
function restorePastSubagents(sessionId) {
  if (!sessionId || state.current !== sessionId) return;
  if (isRunningHere()) return;
  const backend = activeBackendId();
  const liveOrigins = new Set(subagentsHere().map(a => a.origin));
  for (const message of state.messages ?? []) for (const call of message.toolCalls ?? []) {
    if (!SUBAGENT_TOOLS.has(call.name) || !call.id || liveOrigins.has(call.id)) continue;
    const lookup = `${sessionId}:${call.id}`;
    if ((bg.history.has(lookup) && !subagentLive(bg.history.get(lookup))) || bg.finding.has(lookup) || bg.notFound.has(lookup)) continue;
    bg.finding.add(lookup);
    cmd('findSubagent', { sessionId, toolId: call.id }).then(({ agentId, status, startedAt, endedAt }) => {
      if (!agentId) { if (call.result) bg.notFound.add(lookup); return; }
      const said = call.input?.description || call.input?.task || call.input?.prompt;
      bg.history.set(lookup, { id: agentId, sessionId, backend, origin: call.id,
        description: String(said ?? agentId).split(/\r?\n/).find(Boolean)?.slice(0, 120) ?? agentId,
        status: status ?? (call.result?.isError ? 'failed' : 'completed'), startedAt: startedAt ?? message.at ?? null,
        endedAt: endedAt ?? message.at ?? null });
      if (state.current === sessionId) { syncWorkEntry(); if ($('workDialog').open) renderBackground(); }
    }).catch(() => {}).finally(() => bg.finding.delete(lookup));
  }
}

/**
 * 一覧の項目。種類ごとの違いはここで吸収し、描く側は同じ形だけを見る。
 * group: agent（サブエージェント。ネイティブと Pleiad タスクを区別しない）| command（裏のコマンド・端末）
 */
function backgroundItems(scope = null) {
  const items = [];
  // scope: Channels のスレッドの一覧。そのスレッドの bot の会話から委譲した子だけ（裏のコマンド・過去のネイティブの子は含めない）
  const here = scope ? new Set(scope.sessions()) : null;
  const natives = here ? (state.work.subagents ?? []).filter(a => here.has(a.sessionId))
    : [...subagentsHere(), ...bg.history.values()].filter(a => a.sessionId === state.current);
  for (const a of natives) items.push({
    key: `a:${a.sessionId}:${a.id}`, group: 'agent', source: 'native', title: a.description || a.saying || a.id,
    backend: a.backend ?? activeBackendId(), model: a.model ?? null, effort: null, status: a.status ?? null,
    live: subagentLive(a), startedAt: a.startedAt ?? null, endedAt: a.endedAt ?? null, messages: a.messages,
    origin: a.origin ?? null, parentId: a.sessionId, agentId: a.id,
  });
  const trees = here ? [...here].flatMap(id => taskTree(allTasks(), id)) : plyTasksHere();
  for (const { task, depth, rootLive, childCount } of trees) {
    const live = TASK_LIVE.has(task.status);
    const waiting = live && taskWaiting(task);
    const hostOffline = Boolean(task.host) && live && !hostOnlineNow(task.host.hostId);
    const item = {
      key: `t:${task.taskId}`, group: 'agent', source: 'task', title: backgroundTitle(task), request: task.task,
      depth, rootLive, childCount, parentSessionId: task.parentSessionId, backend: task.backend,
      model: task.model || null, effort: task.effort || null, status: TASK_MARK[task.status] ?? null,
      taskStatus: waiting ? 'waiting' : task.status, live, waiting, startedAt: task.createdAt ?? null, endedAt: live ? null : task.updatedAt ?? null,
      childId: task.sessionId, taskId: task.taskId, error: task.error, notification: task.notification, routing: task.routing ?? null,
      pendingMessages: task.pendingMessages ?? 0, instructionRevision: task.instructionRevision ?? 0,
      worktree: task.worktree ?? null, updatedAt: task.updatedAt ?? null,
      // ホストに任せたタスク: 子の会話はホストにある（childId はホストでの会話の印。孫の行の親子に使う）。オフラインの間は経過を止める
      ...(task.host ? { host: task.host, remoteSessionId: task.remoteSessionId ?? null, childId: task.remoteSessionId ? hostChildKey(task.remoteSessionId) : null,
        hostOffline, hostUntil: hostOffline ? hostUntil(task.host.hostId, task.taskId, task.updatedAt) : null } : {}),
    };
    items.push(item);
    // ホストで孫に任せた分は、詳細を読んだ後、手元と同じ字下げの行で出す（端末の台帳には無い。読み出しの答えの子孫の要約）
    if (task.host && hostTree.has(task.taskId)) {
      const subs = hostTreeRows(task.taskId, task.remoteSessionId, hostTree.get(task.taskId), hostChildKey);
      item.childCount = subs.filter(x => x.depth === 1).length;
      for (const sub of subs) items.push(hostDescendantItem(item, sub));
    }
  }
  for (const { task, entry } of here ? [] : backgroundHere()) items.push({
    key: `c:${entry.sessionId}:${task.id}`, group: 'command', title: task.label || task.id, kindLabel: KIND_SUB[task.kind] ?? KIND_SUB.other,
    status: 'running', live: true, startedAt: task.startedAtMs ?? null, task, entry,
  });
  for (const x of bg.extra.values()) if ((!here || here.has(x.parentId)) && !items.some(i => i.key === x.key)) items.push(x);
  // 親を区分・時刻で並べ、子孫はその直後に置く。途中の子が終わっても親から離さない。
  const roots = [], children = new Map();
  for (const item of items) {
    if (item.depth > 0) {
      const siblings = children.get(item.parentSessionId) ?? [];
      siblings.push(item); children.set(item.parentSessionId, siblings);
    } else roots.push(item);
  }
  roots.sort((a, b) => Number(!a.live) - Number(!b.live) || timeOf(b.startedAt) - timeOf(a.startedAt));
  const ordered = [], seen = new Set();
  // owner: 親（根）の会話。Channels のスレッドの一覧が bot ごとに分けるのに使う（子孫は根と同じ）
  const add = (item, owner) => {
    if (seen.has(item.key)) return;
    seen.add(item.key); item.owner = owner; ordered.push(item);
    for (const child of children.get(item.childId) ?? []) add(child, owner);
  };
  roots.forEach(item => add(item, item.parentSessionId ?? item.parentId ?? null));
  return ordered;
}

function backgroundCounts() {
  return backgroundTotals(backgroundItems());
}

const workChip = createBackgroundChip($('workEntryButton'));
function syncWorkEntry() {
  const items = backgroundItems();
  const { live, ended } = backgroundTotals(items);
  $('workEntry').hidden = !live && !ended;
  workChip.update(items, state.current);
  syncStripVisible();
  notifyWatchers();
}
$('workEntryButton').onclick = () => openWork();

/** 委譲された子の会話では、ヘッダーに依頼元の会話へ戻る口を出す（子の会話は脇の一覧に出ないため） */
function syncParentEntry() {
  const delegation = state.sessions.find(s => s.id === state.current)?.delegation;
  const remote = delegation?.remote ?? null;
  // 依頼元の会話を消した（ADR 0147）なら出さない。端末の AI から任された会話の依頼元は端末にあるので、戻る口は出さない
  const parentId = remote ? null : delegation?.parentSessionId;
  const parent = parentId && state.sessions.some(s => s.id === parentId) ? parentId : null;
  const back = $('parentChatEntry');
  back.hidden = !parent;
  back.onclick = parent ? () => select(parent) : null;
  // 題の下の行（700px 以下）・題の右（広い幅）に「↖ 依頼元: 題」
  const parentTitle = parent ? state.sessions.find(s => s.id === parent)?.title || t('session.untitled') : '';
  back.textContent = parent ? t('session.parentLine', { title: parentTitle }) : '';
  if (parent) { back.setAttribute('aria-label', t('session.parentLineAria', { title: parentTitle })); back.title = parentTitle; }
  const origin = $('remoteOriginLine');
  origin.hidden = !remote;
  origin.textContent = remote ? [t('session.remoteOrigin.badge', { device: remote.deviceName || '' }),
    ...(remote.title ? [t('session.remoteOrigin.request', { title: remote.title })] : []),
    (() => { const label = state.modes?.[state.sessions.find(s => s.id === state.current)?.mode]?.label; return label ? t('session.remoteOrigin.modeIs', { mode: label }) : t('session.remoteOrigin.mode'); })()].join(' · ') : '';
}

const vocabAsked = new Set();
/** モデルの表示名。語彙がまだ無いエージェントは取りに行き、取れたら描き直す */
function modelText(item) {
  const vocab = state.vocab.get(item.backend);
  if (!vocab && item.backend && !vocabAsked.has(item.backend)) {
    vocabAsked.add(item.backend);
    loadVocab(item.backend).then(() => { if ($('workDialog').open) renderBackground(); }).catch(() => {});
  }
  const models = vocab?.models ?? {};
  const name = item.model ? modelDisplayName(models, item.model) : item.source === 'task' ? resolvedModel(models, '').label : '';
  return name && item.effort ? `${name} · ${item.effort}` : name;
}

/**
 * 状態の字。弧・印で足りる状態（実行中・待機中・完了・停止）は字にしない（読み上げ名・title は印が持つ）。
 * 字を残すのは、人を待っている「承認待ち」（差し色）と「✕ 失敗」だけ（ADR 0067）
 */
function statusText(item) {
  if (item.group === 'command') return item.kindLabel;
  if (item.waiting) return TASK_STATUS.waiting;
  const failed = item.source === 'task' ? item.taskStatus === 'failed' : item.status === 'failed';
  return failed ? t('timeline.result.failed') : '';
}

/** 経過の形は 1 つ。`m:ss`、1 時間を越えたら `h:mm:ss`（会話の中のカード・一覧・詳細で同じ） */
function clockText(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return s >= 3600 ? `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
    : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** 経過時間。走っている間は今まで（m:ss）、終わったら終わった時刻（今日は HH:MM） */
function elapsedText(item) {
  // 古い孫の行（しばらく読めていない）は、最後に読んだ時刻までの経過で止める（終わった時刻ではない）
  if (item.hostStale) { const start = timeOf(item.startedAt); return start && item.hostUntil ? clockText(item.hostUntil - start) : ''; }
  if (!item.live) {
    const end = timeOf(item.endedAt);
    if (!end) return '';
    const date = new Date(end), now = new Date();
    const day = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    if (end >= day) return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
    if (end >= day - 86400000) return t('dialog.work.yesterday');
    return `${date.getMonth() + 1}/${date.getDate()}`;
  }
  const start = timeOf(item.startedAt);
  // ホストがオフラインの間は、知らないことを進めない（最後に届いた時刻までで止める）
  if (item.hostOffline) return start && item.hostUntil ? clockText(item.hostUntil - start) : '';
  return start ? clockText(Date.now() - start) : '';
}

/** 行・詳細の頭の状態の印。字は出さないので、名前（読み上げ・title）は印が持つ。Pleiad タスクはタスクの状態の語（待機中・承認待ち…） */
function markOf(item) {
  // ホストがオフラインの間は、走っている弧の代わりに衛星（「裏で待っている」の既存の印）。時計も止める（elapsedText）
  if ((item.hostOffline && item.live && !item.waiting) || item.hostStale) {
    const label = item.hostStale ? t('dialog.work.hostStaleMark') : t('dialog.work.hostOfflineMark');
    const sat = satMark(1, label);
    sat.setAttribute('role', 'img');
    sat.setAttribute('aria-label', label);
    return sat;
  }
  const mark = item.waiting ? stateMark('running') : stateMark(item.status);
  if (!mark) return mark;
  if (item.waiting) mark.classList.add('waiting');
  const name = item.waiting ? TASK_STATUS.waiting : item.source === 'task' ? TASK_STATUS[item.taskStatus] : '';
  if (name) { mark.setAttribute('aria-label', name); mark.title = name; }
  return mark;
}

function listRow(item) {
  const row = el('button', 'bg-row');
  if (item.depth) {
    row.classList.add('sub');
    row.style.setProperty('--bg-depth', item.depth);
  }
  row.type = 'button';
  row.dataset.key = item.key;
  if (item.key === bg.selected) row.setAttribute('aria-current', 'true');
  row.append(markOf(item) ?? el('span', 'bg-nomark'));
  // 1 行目は「状態の印・ロゴ・題 …… 経過」（カード・完了通知と同じ並び。ADR 0067）。ロゴは題の前
  const title = el('span', `bg-row-title${item.group === 'command' ? ' mono' : ''}`);
  if (item.group === 'agent') title.append(backendLogo(item.backend, labelOf(item.backend)));
  if (item.host) title.append(hostMark(item.host));
  title.append(el('span', 'bg-row-name', item.title));
  row.append(title);
  row.append(el('span', 'bg-row-time', elapsedText(item)));
  const meta = el('span', 'bg-row-meta');
  if (item.group === 'agent') {
    // 2 行目はモデル名だけ。委譲先を自動で選んだかは詳細の「委譲先」に書く
    const model = modelText(item);
    if (model) meta.append(el('span', 'bg-model', model));
    const status = statusText(item);
    if (status) meta.append(el('span', item.waiting ? 'bg-waiting' : null, status));
    if (item.hostOffline) meta.append(el('span', null, item.hostUntil ? t('dialog.work.hostOfflineRow', { time: clockOf(item.hostUntil) }) : t('chat.approval.relay.hostOffline')));
    else if (item.hostStale) meta.append(el('span', null, item.hostUntil ? t('dialog.work.hostStaleRow', { time: clockOf(item.hostUntil) }) : t('dialog.work.hostStaleRowNoTime')));
    if (item.source === 'task' && item.pendingMessages > 0) meta.append(el('span', null, t('dialog.work.instructionsWaiting', { count: item.pendingMessages })));
    if (item.childCount) meta.append(el('span', null, t('dialog.work.delegated', { count: item.childCount })));
  } else {
    meta.append(el('span', null, item.kindLabel));
    if (item.task?.cwd) meta.append(el('span', 'mono', item.task.cwd));
  }
  row.append(meta);
  row.onclick = () => selectBackground(item.key);
  return row;
}

/** いま開いている一覧の項目（Channels のスレッドから開いたときは、そのスレッドの bot の分） */
const dialogItems = () => backgroundItems(bg.scope);

/** Channels のスレッドの一覧: bot ごとに区切り、中は動いているものが先（親の直後に子孫）。終わった親は bot ごとに 10 件ずつ */
function renderScopedList(list, items) {
  for (const [owner, rows] of groupByOwner(items)) {
    const who = bg.scope.group(owner);
    const head = el('div', 'bg-group bg-bot');
    const logo = who.icon?.();
    if (logo) head.append(logo);
    head.append(el('span', null, who.name));
    list.append(head);
    const { rows: visible, remaining } = visibleRows(rows, bg.shownEnded);
    list.append(...visible.map(listRow));
    if (remaining > 0) {
      const more = el('button', 'btn bg-more', t('dialog.work.showMore', { count: remaining }));
      more.type = 'button'; more.onclick = () => { bg.shownEnded += 10; renderBackground(); };
      list.append(more);
    }
  }
}

/** 一覧を描き直す。詳細は選んでいる項目が変わったときだけ描き直す（読んでいる位置を保つ） */
function renderBackground() {
  const items = dialogItems();
  if (!items.some(x => x.key === bg.selected)) bg.selected = items[0]?.key ?? null;
  const { live, ended } = backgroundTotals(items);
  $('workCount').textContent = t('dialog.work.count', { live, ended });
  const list = $('workList');
  list.replaceChildren();
  if (bg.scope) renderScopedList(list, items);
  const agents = bg.scope ? [] : items.filter(x => x.group === 'agent');
  const active = agents.filter(x => x.rootLive ?? x.live);
  const finished = agents.filter(x => !(x.rootLive ?? x.live));
  if (active.length) list.append(el('div', 'bg-group', t('dialog.work.groupRunning')), ...active.map(listRow));
  const finishedRoots = finished.filter(x => !x.depth);
  const shownRootKeys = new Set(finishedRoots.slice(0, bg.shownEnded).map(x => x.key));
  let currentRoot = null;
  const visibleFinished = finished.filter(x => {
    if (!x.depth) { currentRoot = x.key; return shownRootKeys.has(x.key); }
    return shownRootKeys.has(currentRoot);
  });
  if (finished.length) {
    list.append(el('div', 'bg-group', t('dialog.work.groupEnded')), ...visibleFinished.map(listRow));
    const remaining = finishedRoots.length - shownRootKeys.size;
    if (remaining > 0) {
      const more = el('button', 'btn bg-more', t('dialog.work.showMore', { count: remaining }));
      more.type = 'button'; more.onclick = () => { bg.shownEnded += 10; renderBackground(); };
      list.append(more);
    }
  }
  const commands = items.filter(x => x.group === 'command');
  if (commands.length) list.append(el('div', 'bg-group', t('dialog.work.groupCommands')), ...commands.map(listRow));
  if (!items.length) list.append(el('div', 'bg-empty', t('dialog.work.none')));
  $('workSplit').classList.toggle('showing', bg.narrowDetail && Boolean(bg.selected));
  const item = items.find(x => x.key === bg.selected) ?? null;
  if (bg.view?.key !== item?.key) return openDetail(item);
  // 同じ項目。見出し（状態・経過時間）だけ更新し、動いている子は続きを読み直す
  bg.view.item = item;
  paintDetailHead(item);
  const changed = item?.source === 'task' && bg.view.instructionRevision !== item.instructionRevision;
  const becameIdle = bg.view.wasLive && !item?.live;
  // ホストの線がオフライン・オンラインに変わったら、すぐ読み直す（筋の末尾の「ホストがオフライン」の行を替える・追いつく）
  const hostFlipped = Boolean(item?.host) && bg.view.hostOffline !== undefined && bg.view.hostOffline !== item.hostOffline;
  if (hostFlipped) bg.view.hostOffline = item.hostOffline;
  // ホストの根の詳細は、根が終わっていても孫が走っている間は読み直す（孫の行を新しく保つ）
  const treeLive = Boolean(item?.host) && !item.hostDescendant && (hostTree.get(item.taskId) ?? []).some(hostRowRunning);
  if (item?.live || treeLive || becameIdle || changed || hostFlipped) refreshDetail({ force: changed || becameIdle || hostFlipped });
}

function selectBackground(key) {
  bg.selected = key;
  bg.narrowDetail = true;
  renderBackground();
}

/** ダイアログを開く。key を渡すとその項目を選んだ状態で開く（会話の中のカードから） */
function openWork(key, scope = null) {
  bg.scope = scope;
  $('workTitle').textContent = scope ? t('dialog.work.titleSub') : t('dialog.work.title');
  bg.shownEnded = 10;
  if (typeof key === 'string') {
    const rows = dialogItems().filter(x => x.group === 'agent' && !(x.rootLive ?? x.live));
    let root = 0;
    for (const row of rows) {
      if (!row.depth) root++;
      if (row.key === key) { bg.shownEnded = Math.max(10, Math.ceil(root / 10) * 10); break; }
    }
  }
  bg.narrowDetail = typeof key === 'string';
  if (typeof key === 'string') bg.selected = key;
  else if (!bg.selected || !dialogItems().some(x => x.key === bg.selected && x.live)) bg.selected = dialogItems()[0]?.key ?? null;
  bg.view = null;
  // 先に開く。詳細の読み込みは開いているときだけ走る
  if (!$('workDialog').open) $('workDialog').showModal();
  renderBackground();
  // 配信の間に始まって終わった子孫の委譲も一覧に出すため、会話の分を読み直す
  if (scope) watchSessions([...scope.sessions()], { force: true });
  else loadTaskCards(state.current).then(repaintTasks).catch(() => {});
  if (typeof key !== 'string') $('workList').scrollTop = 0;
  else $('workList').querySelector(`[data-key="${CSS.escape(key)}"]`)?.scrollIntoView({ block: 'nearest' });
}

function paintDetailHead(item) {
  const head = $('workHead');
  head.replaceChildren();
  if (!item) return;
  const back = el('button', 'btn btn-icon bg-back');
  back.type = 'button';
  back.setAttribute('aria-label', t('dialog.work.backToList'));
  back.append(icon('M15 5l-7 7 7 7'));
  back.onclick = () => { bg.narrowDetail = false; $('workSplit').classList.remove('showing'); };
  const title = el('div', 'bg-dt');
  const h = el('h3', 'bg-dt-title');
  const mark = markOf(item);
  if (mark) h.append(mark);
  h.title = item.request ?? item.title;
  h.append(el('span', item.group === 'command' ? 'mono' : null, item.title));
  const meta = el('div', 'bg-dt-meta');
  if (item.group === 'agent') {
    const who = el('span', 'bg-model');
    who.append(backendLogo(item.backend, labelOf(item.backend)), el('span', null, modelText(item) || labelOf(item.backend)));
    meta.append(who);
    if (item.host) meta.append(hostMark(item.host));
  }
  const status = statusText(item);
  if (status) meta.append(el('span', item.waiting ? 'bg-waiting' : null, status));
  const elapsed = elapsedText(item);
  if (item.hostOffline) meta.append(el('span', 'bg-elapsed', item.hostUntil ? t('dialog.work.hostOfflineUntil', { time: clockOf(item.hostUntil) }) : t('dialog.work.hostOfflineThread')));
  else if (elapsed) meta.append(el('span', 'bg-elapsed', elapsed));
  title.append(h, meta);
  head.append(back, title);
  const actions = el('div', 'bg-dt-actions');
  if (item.source === 'task') {
    // 子の会話へ移るのは矢印のアイコン（名前は title・読み上げ）。「停止」は結果が重いので字のまま
    const open = el('button', 'btn btn-icon bg-open');
    open.type = 'button';
    open.title = t('dialog.work.openChat');
    open.setAttribute('aria-label', t('dialog.work.openChat'));
    open.append(icon(GO_PATH));
    open.onclick = () => { const scope = bg.scope; $('workDialog').close(); if (scope) scope.openSession(item.childId); else select(item.childId); };
    // ホストに任せたタスクの子の会話はホストにある。経過はこの詳細で読めるので、手元の窓なら、そのホストのリモートの窓で開く入口を残す（ホストで続きを見る・指示を送る）
    if (item.host) {
      if (window.plyDesktop?.openRemoteSession && !window.plyRemote && item.remoteSessionId) {
        open.title = t('dialog.work.openOnHost');
        open.setAttribute('aria-label', t('dialog.work.openOnHost'));
        open.onclick = () => openOnHost(item);
        actions.append(open);
      }
    } else actions.append(open);
    // 止めるのは根のタスク（止めれば孫も止まる。ホストの「すべて止める」と同じ）。読み出しで知った孫には出さない
    if (!item.hostDescendant && (['queued', 'running'].includes(item.taskStatus) || item.waiting)) {
      const stop = el('button', 'btn btn-quiet', t('dialog.work.stop'));
      stop.type = 'button';
      stop.setAttribute('aria-label', t('dialog.work.stopLabel', { name: item.title }));
      stop.onclick = async () => {
        stop.disabled = true;
        try { await cmd('cancelAgentTask', { taskId: item.taskId }); }
        catch (e) { detailNote(e.message); stop.disabled = false; }
      };
      actions.append(stop);
    }
  }
  if (item.group === 'command' && capsOf(item.entry.backend).stopBackground) {
    actions.append(backgroundStopButton(item.entry.sessionId, item.task));
  }
  head.append(actions);
}

/** 詳細の下に一行（失敗の理由など）。読み直しで消える */
function detailNote(text) {
  $('workBody').append(el('div', 'work-head', text));
}

/** 詳細を描く。項目の種類ごとに読み方が違うだけで、描く部品は会話と同じ */
function openDetail(item) {
  const body = $('workBody');
  bg.view = item ? { key: item.key, item, busy: false, wasLive: item.live, at: 0, hostOffline: item.host ? item.hostOffline : undefined } : null;
  body.replaceChildren();
  delete body.dataset.sessionId;
  paintDetailHead(item);
  if (!item) return;
  body.append(el('div', 'work-head', t('dialog.work.loading')));
  refreshDetail({ first: true });
}

/** 読み直しの間隔。走っている子は running の配信（4 秒ごと）に合わせて読み直す */
const DETAIL_MIN_MS = 2500;

async function refreshDetail({ first = false, force = false } = {}) {
  const view = bg.view;
  if (!view || !$('workDialog').open) return;
  if (view.busy) { if (force) view.pendingRefresh = true; return; }
  if (!first && !force && Date.now() - view.at < DETAIL_MIN_MS) return;
  view.busy = true;
  view.at = Date.now();
  const body = $('workBody');
  const stick = first || body.scrollHeight - body.scrollTop - body.clientHeight < 40;
  try {
    const item = view.item;
    if (item.group === 'command') await paintCommandDetail(view);
    else {
      const content = item.source === 'task' ? await taskThread(item) : await subagentThread(item);
      if (bg.view !== view) return;
      // 作り直すと開いていたツールの詳細・まとまり・畳みが閉じるので、読み込みの間に開いたものまで控えて戻す。位置も今のまま
      const keep = body.scrollTop;
      restoreViewState(content, captureViewState(body));
      body.replaceChildren(content);
      body.scrollTop = keep;
    }
    view.wasLive = view.item.live;
    view.instructionRevision = view.item.instructionRevision;
    if (stick) body.scrollTop = body.scrollHeight;
  } catch (e) {
    if (bg.view === view) body.replaceChildren(el('div', 'work-head', t('dialog.work.readFailed', { error: e.message })));
  } finally {
    view.busy = false;
    if (view.pendingRefresh && bg.view === view) {
      view.pendingRefresh = false;
      queueMicrotask(() => refreshDetail({ force: true }));
    }
  }
}

/** ネイティブのサブエージェントの会話。依頼文は記録に入らないエージェントがあるので、親の委譲ツールの入力から補う */
async function subagentThread(item) {
  const data = await cmd('loadSubagent', { sessionId: item.parentId, agentId: item.agentId });
  $('workBody').dataset.sessionId = item.parentId;
  const origin = data.origin ?? item.origin;
  const prompt = data.prompt ?? requestOf(origin);
  // モデルは記録から分かることがある（一覧の配信より先に読めたとき）
  const model = (data.messages ?? []).findLast(m => m.model)?.model;
  if (model && !item.model) { item.model = model; paintDetailHead(item); }
  return readonlyThread(data.messages ?? [], { backend: item.backend, prompt, live: item.live, item, sessionId: item.parentId });
}

/** 親の会話のツール呼び出し（id）の入力にある依頼文 */
function requestOf(toolId) {
  if (!toolId) return null;
  for (const m of state.messages ?? []) {
    const call = (m.toolCalls ?? []).find(c => c.id === toolId);
    if (call) return typeof call.input?.prompt === 'string' ? call.input.prompt : null;
  }
  return null;
}

/**
 * Pleiad タスクの子の会話。普通の会話なので、会話を開くときと同じ読み込み（live）の結果を描く。
 * 走っている間はターン前の履歴と、ここまでの出来事（stream.events）が返る。出来事は仮の発言に畳んで後ろに足す
 * （web/stream-messages.mjs。Antigravity はターンが終わるまで履歴に何も書かない）。
 * watch は付けない（付けると、この接続がメインパネルで見ている会話が子へ書き換わる）
 */
/** ホストの子の会話を、そのホストのリモートの窓で開く（手元の窓だけ。見るための補助） */
function openOnHost(item) {
  const view = window.plyDesktop?.openRemoteSession;
  if (!view || window.plyRemote || !item.remoteSessionId) return;
  view(item.host.hostId, item.remoteSessionId)
    .then((r) => { if (r && r.ok === false) detailNote(t('chat.approval.relay.viewChildFailed', { error: r.message ?? '' })); })
    .catch((e) => detailNote(t('chat.approval.relay.viewChildFailed', { error: e?.message ?? '' })));
}

/**
 * 読み出しで知ったホストの孫の行（一覧へ字下げで出す）。根と同じ「⇄ ホスト名」・オフラインの扱い。
 * 詳細を閉じると読み出しは止まるので、走っている印のまましばらく読めていない行は古い（hostStale）として「動いている」に数えず、
 * 弧の代わりに衛星と「HH:MM の時点」を出す（根か孫の詳細を開けば読み直す）
 */
function hostDescendantItem(root, { row, depth, parentKey, childCount }) {
  const raw = row.rawStatus ?? row.status;
  const seenAt = hostSeen.get(row.taskId) ?? null;
  const stale = hostRowStale(row, seenAt, Date.now());
  if (hostRowRunning(row) && !stale) hostStaleSoon(seenAt + HOST_ROW_STALE_MS);
  const live = TASK_LIVE.has(raw) && !stale;
  const waiting = live && row.status === 'waiting';
  const hostOffline = live && root.hostOffline === true;
  return {
    key: `t:${row.taskId}`, group: 'agent', source: 'task', title: row.title || row.taskId, request: undefined,
    depth: (root.depth ?? 0) + depth, rootLive: root.rootLive, childCount, parentSessionId: parentKey,
    backend: row.backend, model: row.model || null, effort: row.effort || null, status: TASK_MARK[raw] ?? null,
    taskStatus: waiting ? 'waiting' : raw, live, waiting, startedAt: row.createdAt ?? null, endedAt: live || stale ? null : row.updatedAt ?? null, updatedAt: row.updatedAt ?? null,
    childId: row.sessionId ? hostChildKey(row.sessionId) : null, taskId: row.taskId, error: row.error ?? null, notification: null, routing: null,
    pendingMessages: 0, instructionRevision: 0, worktree: null,
    host: root.host, remoteSessionId: row.sessionId ?? null, hostDescendant: true, rootTaskId: root.rootTaskId ?? root.taskId,
    hostOffline, hostUntil: hostOffline ? root.hostUntil : stale ? seenAt : null, hostStale: stale,
  };
}

/** 孫の行が古くなる時刻（at）に一覧と入口の数を描き直す。近い方の 1 つだけを持つ */
function hostStaleSoon(at) {
  if (hostStaleTimer && hostStaleTimer.at <= at) return;
  clearTimeout(hostStaleTimer?.id);
  hostStaleTimer = { at, id: setTimeout(() => { hostStaleTimer = null; repaintTasks(); }, Math.max(0, at - Date.now()) + 50) };
}

/**
 * ホストに任せたタスクの詳細（docs/remote.md §4.5「経過の読み出し」）。子の会話はホストにあるので、端末のサーバーが /agent 越しに読み、
 * 手元の委譲と同じ筋（readonlyThread）で描く。読み出しは詳細を開いている間だけ（refreshDetail の読み直しに乗る）。続きは cursor から、
 * 終わったタスクは 1 回読んで止まる。読めないホスト（古い版・許可が無い）や読めなかったときは、依頼と結果の 2 つの箱に戻して 1 行添える
 */
async function hostTaskThread(item) {
  const view = bg.view;
  const held = view.host ??= { base: 0, messages: [], sigs: [], total: 0, userCount: null, instructions: [], descendantsOmitted: 0, ok: false, lastOk: 0 };
  // 読み出しを知らない古いホストは、ready の view で先に分かる（読み出しの往復を待たずに、今の 2 つの箱）
  const info = hostInfo(item.host.hostId);
  if (!held.ok && info?.online && info.view !== true) return hostTaskBoxes(item, t('dialog.work.readFailed', { error: t('dialog.work.hostViewUnsupported') }));
  const args = { taskId: item.taskId, hostId: item.host.hostId };
  const cursor = held.ok ? hostViewCursor(held) : null;
  const r = await cmd('invoke', { op: 'delegation.hostView', args: cursor ? { ...args, cursor } : args }).catch(() => ({ state: 'failed' }));
  const rootId = item.hostDescendant ? item.rootTaskId : item.taskId;
  if (r.state === 'ok') {
    Object.assign(held, joinHostView(held, r), { ok: true, instructions: r.instructions ?? [], lastOk: Date.now(),
      userCount: Number.isInteger(r.userCount) ? r.userCount : null, ...(item.hostDescendant ? {} : { descendantsOmitted: r.descendantsOmitted ?? 0 }) });
    const now = Date.now();
    hostSeen.set(item.taskId, now);
    for (const d of r.descendants ?? []) if (typeof d?.taskId === 'string') hostSeen.set(d.taskId, now);
    if (hostSeen.size > 2000) hostSeen.delete(hostSeen.keys().next().value);
    const before = JSON.stringify(hostTree.get(rootId) ?? []);
    // 孫の詳細の答えは、孫自身の今の形（r.task）でその行も置き換える（終われば行の弧が止まり、読み直しも止まる）
    const rows = mergeHostTree(hostTree.get(rootId), [...(r.descendants ?? []), ...(item.hostDescendant && r.task ? [r.task] : [])], { replace: !item.hostDescendant });
    if (rows.length || hostTree.has(rootId)) hostTree.set(rootId, rows);
    // 行が変わった・走っている孫がいる（読んだ時刻が新しくなり、古い印が外れる）ときは一覧を描き直す
    const running = rows.some(hostRowRunning);
    if (running || JSON.stringify(rows) !== before) setTimeout(() => repaintTasks(), 0);
    // 根が終わっていても、孫が走っている間は根の詳細を読み直す（走っている根は running の配信で読み直す）
    clearTimeout(view.treeTimer);
    if (running && !item.live && !item.hostDescendant) view.treeTimer = setTimeout(() => { if (bg.view === view && $('workDialog').open) refreshDetail(); }, 4000);
  } else if (r.state === 'offline' && !held.ok) {
    // まだ一度も読めていないうちにオフライン（端末の再起動の後など）。端末の台帳にある依頼と結果の 2 つの箱に、オフラインの 1 行を添える
    const until = r.since ?? item.hostUntil;
    return hostTaskBoxes(item, until ? t('dialog.work.hostOfflineBoxesUntil', { time: clockOf(until) }) : t('dialog.work.hostOfflineBoxes'));
  } else if (r.state !== 'offline' && (!held.ok || r.state === 'unsupported' || r.state === 'denied')) {
    // 読めない（古いホスト・許可が無い・読めなかった）。今の 2 つの箱に戻し、読めなかった旨の 1 行
    held.ok = false;
    const why = r.state === 'unsupported' ? t('dialog.work.hostViewUnsupported') : r.state === 'denied' ? t('dialog.work.hostViewDenied') : hostViewError(r);
    return hostTaskBoxes(item, t('dialog.work.readFailed', { error: why }));
  }
  const offline = item.live && (item.hostOffline || r.state === 'offline');
  const until = (r.state === 'offline' ? r.since : null) ?? item.hostUntil ?? held.lastOk;
  const messages = held.messages;
  const th = readonlyThread(messages, { backend: item.backend, prompt: held.base === 0 ? item.request : null, live: item.live, item, base: held.base,
    instructions: visibleTaskInstructions(held.instructions, messages, held.userCount),
    hostOffline: offline ? { time: clockOf(until) } : null, omitted: held.base > 0 ? { count: held.base, item } : null });
  // 子孫の要約は、走っているもの・新しいものから 40 件まで。省いた分は件数だけ
  if (!item.hostDescendant && held.descendantsOmitted > 0) th.querySelector('.spine').after(el('div', 'work-head omitted', t('dialog.work.hostDescendantsOmitted', { count: held.descendantsOmitted })));
  // 承認・質問は、依頼元の会話の中継のカードと同じカード・同じ答えの道で、ここでも答えられる（常に許可は出さない）。
  // 根の詳細にはホストの木の分すべて、孫の詳細にはその子の分だけ。ホストの画面でしか答えられない承認は知らせの 1 行。
  // 読み直しのたびに作り直さず、前の筋のカードを新しい筋へ移す（送っている途中の形を保つ・外れたカードを名簿に溜めない）
  const cards = view.hostCards ??= new Map();
  const shown = new Set();
  detailCardMode = true;
  try {
    for (const pending of state.pendingPerms.values()) {
      if (pending.type !== 'permission' || pending.remote?.taskId !== rootId) continue;
      if (item.hostDescendant && pending.remote.childSessionId !== item.remoteSessionId) continue;
      if (th.querySelector(`.mw[data-key="perm:${CSS.escape(pending.id)}"]`)) continue;
      shown.add(pending.id);
      let node = cards.get(pending.id);
      if (!node) {
        const ev = { ...pending, remote: { ...pending.remote, online: hostOnlineNow(pending.remote.hostId) } };
        const card = ev.remote.hostOnly ? hostOnlyCard(ev, th) : ev.kind === 'question' ? questionCard(ev, th) : permissionCard(ev, th);
        node = card?.closest('.mw') ?? null;
        if (node) cards.set(pending.id, node);
      }
      if (!node) continue;
      const act = th.querySelector('.mw.activity');
      if (act) act.before(node); else th.append(node);
    }
  } finally { detailCardMode = false; }
  for (const id of [...cards.keys()]) if (!shown.has(id)) cards.delete(id);
  if (r.state === 'failed' && held.ok) th.append(wrap(el('div', 'm sys', t('dialog.work.readFailed', { error: hostViewError(r) }))));
  if (item.error) th.append(wrap(el('div', 'm sys', item.error)));
  return th;
}

/** 読み出しが失敗したときの理由の 1 行。ホストの英語の文やコードはそのまま出さず、よくあるものは訳した文にする */
const HOST_VIEW_ERRORS = {
  NOT_FOUND: () => t('dialog.work.hostViewNotFound'), TOO_LARGE: () => t('dialog.work.hostViewTooLarge'),
  TIMEOUT: () => t('dialog.work.hostViewTimeout'), RATE_LIMITED: () => t('dialog.work.hostViewBusy'),
};
const hostViewError = (r) => (HOST_VIEW_ERRORS[r?.code] ?? (() => t('dialog.work.hostViewFailed')))();

/** 経過を読めないホストの詳細: 依頼と結果（ホストの便りで写した分）の 2 つの箱。note は読めなかった理由・オフラインの 1 行 */
async function hostTaskBoxes(item, note) {
  const r = await cmd('invoke', { op: 'delegation.status', args: { taskId: item.taskId } }).catch(() => null);
  const th = el('div', 'thread bg-thread bg-host-task');
  if (note) th.append(el('div', 'work-head', note));
  const section = (label, text) => {
    const box = el('div', 'rt-request');
    const body = el('div', 'rt-request-text');
    body.innerHTML = plainTextHtml(String(text ?? '').trim() || '—', { paths: false });
    box.append(el('div', 'rt-request-label', label), body);
    return box;
  };
  th.append(section(t('dialog.work.request'), item.request), section(t('dialog.work.hostResult'), r?.result));
  if (item.error) th.append(wrap(el('div', 'm sys', item.error)));
  return th;
}

async function taskThread(item) {
  if (item.host) return hostTaskThread(item);
  const [data, instructionData] = await Promise.all([
    cmd('loadSession', { sessionId: item.childId, live: true }), cmd('agentTaskInstructions', { taskId: item.taskId }),
  ]);
  $('workBody').dataset.sessionId = item.childId;
  const live = streamMessages(data.stream?.events, { backend: item.backend, model: item.model, initialMessageId: data.initialMessageId });
  const messages = [...(data.messages ?? []), ...live.messages];
  const th = readonlyThread(messages, { presents: [...(data.presents ?? []), ...live.presents], backend: item.backend, prompt: item.request, live: item.live, item,
    sessionId: item.childId, instructions: visibleTaskInstructions(instructionData.instructions ?? [], messages) });
  // 子が承認を待っていれば、ここで答えられる（子の会話へ移らなくてよい）。同じ承認は依頼元の会話にも中継されている
  for (const ev of [...(data.permissions ?? []), ...state.pendingPerms.values()]) {
    if (ev.sessionId !== item.childId || th.querySelector(`.mw[data-key="perm:${CSS.escape(ev.id)}"]`)) continue;
    const card = ev.kind === 'question' ? questionCard(ev, th) : permissionCard(ev, th);
    if (card) th.querySelector('.mw.activity')?.before(card.closest('.mw'));
  }
  if (item.error) th.append(wrap(el('div', 'm sys', item.error)));
  if (item.notification === 'unknown') th.append(wrap(el('div', 'm sys', t('dialog.tasks.notificationUnknown'))));
  return th;
}

/**
 * 読むだけの筋。メインパネルの paintHistory と同じ部品（wrap・userMsg・aiMsg・考えた内容・ツールカード・画像）で、描く先だけを変える。
 * 分岐・編集・再送は出さない（この会話の発言ではない）。走っている子は末尾に稼働表示（弧だけ）を置く。
 * 依頼元（親）は「あなた」と同じ扱いで、最初の「依頼」も追加の指示も自分の発言と同じ部品（Markdown・吹き出し・畳み方・時刻）で描き、
 * 発言者の語だけ「依頼」「追加の指示」にする。まだ子に渡っていない追加の指示は、差し込み待ち（sending）ならメインパネルの作業中の送信と同じ状態の行、
 * 待機（queued。途中送信できない子）なら末尾に時計の印、届かず終わったもの（dropped）は弱い字（ADR 0067。docs/design-system.md「バックグラウンド」）
 */
function readonlyThread(messages, { presents = [], backend, prompt = null, live = false, item, instructions = [], sessionId = null, hostOffline = null, omitted = null, base = 0 } = {}) {
  messages = mergeToolTurns(messages);
  const th = el('div', 'thread bg-thread');
  const spine = svgEl('svg', { class: 'spine', 'aria-hidden': 'true' });
  spine.append(svgEl('line', { x1: 20, y1: 0, x2: 20, y2: '100%' }));
  th.append(spine);
  // ホストの子の長い会話は末尾だけ運ぶ。省いた分は先頭に 1 行（デスクトップ版は「ホストで開く」で全文へ）
  if (omitted) {
    const note = el('div', 'work-head omitted', t('dialog.work.hostOmitted', { count: omitted.count }));
    if (window.plyDesktop?.openRemoteSession && !window.plyRemote && omitted.item?.remoteSessionId) {
      const open = el('button', 'btn btn-quiet', t('dialog.work.openOnHost'));
      open.type = 'button';
      open.onclick = () => openOnHost(omitted.item);
      note.append(open);
    }
    th.append(note);
  }
  const put = (node, key) => { const w = wrap(node, key); th.append(w); return w; };
  const parentMsg = (text, at, word) => {
    const m = stripActions(userMsg(text, { at }));
    m.querySelector('.who > span').textContent = word;
    return m;
  };
  const requestNode = (text, at) => parentMsg(text, at, t('dialog.work.request'));
  const followUp = (text, at) => parentMsg(text, at, t('dialog.work.instruction'));
  const pendingNode = (instruction) => {
    const m = followUp(instruction.text, instruction.at);
    m.dataset.instructionId = instruction.id;
    if (instruction.state === 'sending') {
      const status = el('div', 'outbox-status outbox-status-mark');
      status.append(runMark(t('chat.delivery.notYet')), t('chat.delivery.pending'));
      m.append(status);
    } else if (instruction.state === 'dropped') {
      m.append(el('div', 'outbox-status', t('dialog.work.instructionDropped')));
    } else {
      // 待機中。字の代わりに、発言者の行の静止した時計の印（title・読み上げ名）
      m.classList.add('queued');
      const clock = el('span', 'who-queued');
      clock.setAttribute('role', 'img');
      clock.title = t('dialog.work.instructionQueued');
      clock.setAttribute('aria-label', t('dialog.work.instructionQueued'));
      clock.append(clockIcon());
      m.querySelector('.who > span').after(clock);
    }
    const w = wrap(m, `instruction:${instruction.id}`);
    if (instruction.state !== 'sending') w.classList.remove('node');
    return w;
  };
  let last = null, prevRole = null;
  if (prompt && messages[0]?.role !== 'user') { last = put(requestNode(prompt, messages[0]?.at), 'request'); prevRole = 'user'; }
  const refs = presents.map(p => p.reference);
  for (const it of buildItems(messages, presents)) {
    // git の要約の行は、押して開く先（今の会話の右パネル）が読んでいる子の会話ではないので、読むだけの筋には出さない
    if (it.kind === 'present' && (it.p.kind === 'git' || it.p.kind === 'worktree')) continue;
    if (it.kind === 'present') { last = put(renderPresent(savedEvent(it.p)), `p:${it.pi}`); continue; }
    const { node, role } = historyRow(it.m, { cont: prevRole === 'assistant', refs, prev: last, readonly: true, backend, sessionId,
      // 古い分を省いた筋（base > 0）の最初の発言は会話の途中。依頼ではなく追加の指示として描く
      user: (m) => (it.mi === 0 && !base ? requestNode : followUp)(m.text, m.at) });
    prevRole = role;
    if (node) last = put(node, `m:${it.mi}`);
  }
  // 途中送信で差し込み中の指示は、稼働表示の前（メインパネルの作業中の送信と同じ位置）。待機と届かなかったものは末尾
  for (const instruction of instructions.filter(x => x.state === 'sending')) th.append(pendingNode(instruction));
  if (live) {
    const act = el('div', 'm activity');
    if (hostOffline) act.append(el('span', 'txt', t('dialog.work.hostOfflineThread')), el('span', 'el', hostOffline.time ? t('dialog.work.hostOfflineCatchUp', { time: hostOffline.time }) : t('dialog.work.hostOfflineCatchUpNoTime')));
    else if (item?.waiting) act.append(el('span', 'txt', t('activity.waitingApproval')));
    const w = put(act, 'activity');
    const tip = el('span', 'activity-tip');
    const mark = hostOffline ? satMark(1, t('dialog.work.hostOfflineMark')) : runMark(t('activity.turnRunning'));
    mark.setAttribute('role', 'img');
    mark.setAttribute('aria-label', hostOffline ? t('dialog.work.hostOfflineMark') : t('activity.turnRunning'));
    tip.append(mark);
    w.querySelector('.mw-gutter').append(tip);
  }
  for (const instruction of instructions.filter(x => x.state !== 'sending')) th.append(pendingNode(instruction));
  if (th.childElementCount === 1) th.append(el('div', 'work-head', t('dialog.work.noMessages')));
  return th;
}

/** 裏のコマンドの詳細: コマンド・作業場所・起動時刻・取れた出力。表示中は running の配信のたびに取り直す */
async function paintCommandDetail(view) {
  const body = $('workBody');
  const { task, entry } = view.item;
  if (!view.nodes) {
    const status = el('div', 'work-head');
    status.setAttribute('role', 'status');
    const command = el('pre', 'work-command', task.label || task.id);
    const cwd = el('div', 'work-location');
    const output = el('pre', 'work-output', '');
    output.setAttribute('aria-label', t('dialog.work.outputLabel'));
    view.nodes = { status, command, cwd, output };
    body.replaceChildren(status, el('div', 'work-head', t('dialog.work.command')), command, cwd,
      el('div', 'work-head', t('dialog.work.output')), output);
  }
  const { status, command, cwd, output } = view.nodes;
  const canRead = capsOf(entry.backend).backgroundDetails;
  const live = backgroundHere().some(x => x.entry.sessionId === entry.sessionId && x.task.id === task.id);
  const data = canRead
    ? await cmd('loadBackground', { sessionId: entry.sessionId, taskId: task.id })
    : { task: live ? { ...task, output: null } : null };
  if (bg.view !== view) return;
  if (!data.task) {
    status.textContent = t('dialog.work.ended');
    for (const b of $('workHead').querySelectorAll('.work-stop')) b.disabled = true;
    return;
  }
  const got = data.task;
  status.textContent = [t('dialog.work.live'), ...(got.startedAtMs ? [t('dialog.work.startedAt', { time: fmt.dateTime(got.startedAtMs) })] : []),
    ...(got.outputTruncated ? [t('dialog.work.truncated')] : [])].join(' · ');
  command.textContent = got.command || got.label || task.label || task.id;
  cwd.textContent = got.cwd ? t('dialog.work.cwd', { cwd: got.cwd }) : '';
  const text = got.output === null ? t('dialog.work.outputUnsupported') : got.output || t('dialog.work.noOutput');
  if (output.textContent !== text) output.textContent = text;
}

function backgroundStopButton(sessionId, task) {
  const button = el('button', 'btn btn-quiet work-stop', t('dialog.work.stop'));
  button.type = 'button';
  button.setAttribute('aria-label', t('dialog.work.stopLabel', { name: task.label || task.id }));
  button.onclick = () => stopBackground(button, sessionId, task);
  return button;
}

/**
 * 裏の作業を 1 本止める。
 * 消えたかどうかはサーバが codex に数え直させて `running` で配るので、**先回りして消さない**
 * （止めたつもりで生きている端末の印を落とす方が、消え遅れるより悪い）。
 */
async function stopBackground(button, sessionId, task) {
  button.disabled = true;
  button.textContent = t("dialog.work.stopping");
  try {
    const result = await cmd("stopBackground", { sessionId, taskId: task.id });
    if (result.stopped === false) throw new Error(t('dialog.work.stopUnconfirmed'));
    button.textContent = t('dialog.work.stopRequested');
    if (bg.view) { bg.view.at = 0; await refreshDetail(); }
  } catch (e) {
    button.textContent = t("dialog.work.stopAgain");
    button.disabled = false;
    detailNote(t("dialog.work.stopFailed", { error: e.message }));
  }
}

// ---- 会話の中の委譲のカードから開く

/** ネイティブのサブエージェントを生む委譲ツール（Claude の Task / Agent、Codex の子スレッド） */
const SUBAGENT_TOOLS = new Set(['Task', 'Agent', 'collabAgentToolCall', 'subAgentActivity']);
const isDelegateTool = (name) => /(^|[_./])ply_delegate$/.test(String(name ?? ''));

const GO_PATH = 'M9 5h10v10M19 5L6 18';
function clockIcon() {
  const svg = svgEl('svg', { class: 'i', viewBox: '0 0 24 24', 'aria-hidden': 'true' });
  svg.append(svgEl('circle', { cx: 12, cy: 12, r: 8 }), svgEl('path', { d: 'M12 8v4.5l3 2' }));
  return svg;
}

/**
 * 子の会話へ移る矢印のボタン。押せる要素を入れ子にしないため、開閉の行（summary）の中には置かず、行の外に重ねる。
 * 位置は「値の列」のすぐ左。値の列の幅は watchValueWidth が --res-w に入れる（web/tools.css）
 */
function goButton(label, onclick) {
  const b = el('button', 'btn btn-icon tc-go');
  b.type = 'button';
  b.title = label;
  b.setAttribute('aria-label', label);
  b.append(icon(GO_PATH));
  b.onclick = (e) => { e.preventDefault(); e.stopPropagation(); onclick(b); };
  return b;
}
const valueWidths = typeof ResizeObserver === 'function' ? new ResizeObserver((entries) => {
  for (const { target } of entries) {
    const host = target.closest('.tc, .task-notice');
    if (!host?.isConnected) { valueWidths.unobserve(target); continue; }
    host.style.setProperty('--res-w', `${target.getBoundingClientRect().width}px`);
  }
}) : null;
/** 行の右端の値の列（.tc-res / .tn-res）の幅を、重ねた矢印の位置のために宿主へ伝える */
const watchValueWidth = (res) => valueWidths?.observe(res);

/**
 * 委譲のカードに、子の会話へ移る矢印を足す。押すとバックグラウンドのダイアログでその子を選んだ状態になる。
 * Pleiad タスクは結果（taskId）が届いてから押せるようにする。メインの会話のカードだけに付ける
 */
function linkDelegateCard(card, input = null, result = null, ctx = null) {
  if (card && ctx) cardCtx.set(card, ctx);   // Channels のスレッドのカード: どの範囲・会話・エージェントの子か（無ければ今開いている会話）
  const name = card?.dataset.tool;
  // 一覧の見出しに使う依頼の一行（結果が後から届くカードは、始まったときに覚えた分を使う）
  const said = input?.description || input?.task || (typeof input?.prompt === 'string' ? input.prompt.split(/\r?\n/).find(Boolean) : '');
  if (said && card) card.dataset.bgTitle = String(said).slice(0, 120);
  // ply_delegate の見出しの主役は依頼の題（無ければ依頼の 1 行目）。バックグラウンドの一覧と同じ語
  if (name && isDelegateTool(name) && input) retitleDelegate(card, input.title || said);
  if (!name || card.querySelector(':scope > .tc-go')) return;
  if (isDelegateTool(name)) {
    const id = /ply-task-[0-9a-f-]{36}/.exec(card.querySelector('.tc-output, .tc-result, .tc-details-body')?.textContent ?? '')?.[0];
    if (!id) { decorateFailedDelegate(card, result); return; }
    card.dataset.taskId = id;
    // 振り分けの記録。ply_delegate の結果（JSON）にある。タスクの一覧（running）にあればそちらを使う
    const routing = delegateResult(result)?.routing;
    if (routing) cardRouting.set(card, routing);
  } else if (!SUBAGENT_TOOLS.has(name) || !card.dataset.id || capsOf(ctx?.backend ?? activeBackendId()).subagents === false) return;
  card.classList.add('tc-delegate');
  card.append(goButton(t('timeline.delegate.openChild'), (b) => openFromCard(card, b)));
  const res = card.querySelector('.tc-res');
  if (res) watchValueWidth(res);
  if (card.dataset.taskId) decorateDelegateCard(card);
}

/** ply_delegate の 1 行目: サーバー名とツール名・入力の要約を、依頼の題に替える */
function retitleDelegate(card, title) {
  const head = card.querySelector('.tc-head');
  const main = head?.querySelector('.tc-main');
  const text = String(title ?? '').trim();
  if (!main || !text || card.dataset.retitled) return;
  head.querySelector('.tc-server')?.remove();
  head.querySelector('.tc-note')?.remove();
  main.className = 'tc-main tc-text';
  main.textContent = text;
  main.title = text;
  card.dataset.retitled = '1';
}

// ---- 委譲カードの振り分けの理由（docs/design-system.md「委譲カード」）
// 閉じたカードは 1 行（「委譲・ロゴ・題 …… 状態の印・経過」）。ロゴは委譲先。開くと「依頼」「委譲先」（自動・種類・難しさ → 行き先、飛ばした候補）と
// 内訳（web/delegation-routing-view.mjs）、入力・出力の JSON は折りたたみの奥。自動で選んだときだけ「自動」の印・判定・候補・やり直し（固定の委譲には持ち込まない）

/** カード -> 結果から読んだ routing（タスクの一覧から外れていても出せるように） */
const cardRouting = new WeakMap();
/** ply_delegate の結果の JSON。エラーの文なら null */
function delegateResult(result) {
  const text = typeof result === 'string' ? result : typeof result?.text === 'string' ? result.text : '';
  if (!text.trim().startsWith('{')) return null;
  try { return JSON.parse(text); } catch { return null; }
}
const routingNames = {
  backend: (id) => fallbackName('backend', id, labelOf(id)),
  model: (backend, model) => (model ? fallbackName('model', backend, modelDisplayName(state.vocab.get(backend)?.models ?? {}, model)) : ''),
};
function routingLogo(backend) { return backendLogo(backend, routingNames.backend(backend)); }
/** カードの入力・出力の JSON（ツールカードの .tc-input / .tc-output の文字）。読めなければ null */
function cardJson(card, selector) {
  const text = card.querySelector(`${selector} pre`)?.textContent ?? '';
  if (!text.trim().startsWith('{')) return null;
  try { return JSON.parse(text); } catch { return null; }
}
/** routing の無い古いタスクでも、依頼元が委譲先を書いていれば固定の委譲として見せる */
function inputRouting(card) {
  const input = cardJson(card, '.tc-input');
  if (typeof input?.backend !== 'string' || !input.backend) return null;
  return { mode: 'pinned', kind: input.kind ?? '', target: { backend: input.backend, model: input.model ?? null } };
}
/** 固定の委譲の内訳（承認モード・作業場所）。ply_delegate の返り値から、無ければタスクの一覧から */
function pinnedFacts(card, routing) {
  const result = cardJson(card, '.tc-output') ?? {};
  const task = taskById(card.dataset.taskId) ?? {};
  // 依頼元が子の設定を替えたら（ADR 0134）、ply_delegate の返り値は前の委譲先のもの。タスクの記録の今の mode を使う
  const mode = (routing.changed ? task.mode ?? result.mode : result.mode ?? task.mode) ?? '';
  // worktree の子は、パスの代わりに「作業場所」の行（ブランチ付き。paintDelegateWorkspace）が出る
  return { names: routingNames, mode: mode ? state.vocab.get(routing.target.backend)?.modes?.[mode]?.label ?? mode : '', cwd: task.worktree ? '' : result.cwd ?? task.cwd ?? '',
    compaction: task.compaction ?? null };
}
function delegateDetail(card, routing) {
  // 子の自動圧縮の閾値と内訳（タスクの記録の compaction。最後に走った子のターンの分。ADR 0166）
  return isAutoRouting(routing)
    ? routingDetail(routing, { names: routingNames, logo: routingLogo, onRetry: (root, button) => toggleRetry(card, root, button),
      compaction: taskById(card.dataset.taskId)?.compaction ?? null })
    : pinnedDetail(routing, pinnedFacts(card, routing));
}
const foldLabels = () => ({ open: t('dialog.work.showFull'), close: t('dialog.work.collapse') });
/** 開いた内訳の先頭の「依頼」。4 行で畳み、はみ出すときだけシェブロン（自分の長い発言・バックグラウンドの詳細と同じ部品。web/fold.mjs） */
function delegateRequest(card) {
  const task = cardJson(card, '.tc-input')?.task;
  if (typeof task !== 'string' || !task.trim()) return null;
  const box = el('div', 'rt-request');
  const text = el('div', 'rt-request-text');
  text.innerHTML = plainTextHtml(task.trim(), { paths: false });   // 字は書いたとおり。URL だけリンクにする
  box.append(el('div', 'rt-request-label', t('dialog.work.request')), text);
  // 閉じたカードでは高さが取れないので、開いて見えるようになってから測る（mountFold の measure）
  mountFold(box, text, { measure: true, labels: foldLabels() });
  return box;
}
/** 入力・出力の JSON は「入力・出力（JSON）」の折りたたみの奥へ（消さずに残す）。結果の読み直しもこの中に入る（render.mjs の applyToolResult） */
function foldDelegateJson(card) {
  const body = card.querySelector('.tc-details-body');
  if (!body || body.querySelector(':scope > .tc-json')) return;
  const fold = el('details', 'tc-fold tc-json');
  const summary = el('summary', null, t('routing.detail.json'));
  const inner = el('div', 'tc-json-body');
  inner.append(...[...body.children].filter(n => n.matches('.tc-section-label, .tc-input, .tc-out')));
  fold.append(summary, inner);
  body.append(fold);
}
function decorateDelegateCard(card) {
  const taskId = card.dataset.taskId;
  const routing = taskById(taskId)?.routing ?? cardRouting.get(card) ?? inputRouting(card);
  if (!routing?.target || card.dataset.routed) return;
  card.dataset.routed = '1';
  const auto = isAutoRouting(routing);
  // モデル・承認モードの表示名は語彙から。まだ無ければ取りに行き、届いたら理由の行を書き直す
  const missing = [routing.target, ...(routing.skipped ?? []).map(s => splitCandidate(s.candidate))].map(x => x?.backend).filter(b => b && !state.vocab.has(b));
  for (const b of new Set(missing)) loadVocab(b).then(() => paintRouteLine(card, routing)).catch(() => {});
  const head = card.querySelector('.tc-head');
  const label = head.querySelector('.tc-label');
  label.textContent = t('timeline.tool.label.delegate');
  // ロゴは題の前（カード・バックグラウンドの一覧の行・完了通知でそろえる）。名前は title と、行の読み上げ名（paintDelegateStates）が持つ
  const logo = routingLogo(routing.target.backend);
  logo.setAttribute('aria-hidden', 'true');
  logo.classList.add('rt-target-logo');
  label.after(logo);
  // ホストに任せたタスク: 題の前に ⇄ ホスト名（ホストがオフラインなら中抜き）。ホストの内訳の専用の行は作らない（固定の内訳のまま）
  const hostRow = taskById(taskId)?.host;
  if (hostRow) { logo.after(hostMark(hostRow)); card.dataset.hostId = hostRow.hostId; }
  card.dataset.routeSig = routeSig(routing);
  // 委譲先の行（自動の印・種類・難しさ → 行き先・飛ばした候補）は開いた中へ
  const route = el('span', 'rt-route');
  if (auto) {
    const mark = el('span', 'tc-auto', t('routing.auto'));
    mark.title = t('routing.autoTitle');
    route.append(mark);
  }
  const routeLogo = routingLogo(routing.target.backend);
  routeLogo.setAttribute('aria-hidden', 'true');
  routeLogo.classList.add('rt-target-logo');
  route.append(routeLogo, el('span', 'rt-route-text'));
  const where = el('div', 'rt-where');
  where.append(el('div', 'rt-request-label', t('routing.detail.target')), route);
  foldDelegateJson(card);
  const request = delegateRequest(card);
  card.querySelector('.tc-details-body')?.prepend(...(request ? [request] : []), where, delegateDetail(card, routing));
  paintRouteLine(card, routing);
  paintRetried(card);
  // 開いたとき、子の作業場所の git の要約を「変更」の行として出す（開かれるまでは引かない。ADR 0085）
  const shell = card.querySelector('.tc-details');
  if (shell && !shell.dataset.gitHook) {
    shell.dataset.gitHook = '1';
    shell.addEventListener('toggle', () => { if (shell.open) { paintDelegateGit(card); paintDelegateWorkspace(card); } });
    if (shell.open) { paintDelegateGit(card); paintDelegateWorkspace(card); }
  }
}
/** 委譲カードの「作業場所」の行（worktree のとき。ブランチと「worktree」。ADR 0089）。開いたときに出す */
function paintDelegateWorkspace(card) {
  const task = taskById(card.dataset.taskId);
  card.querySelector('.wt-delegate')?.remove();
  if (!task?.worktree) return;
  const row = el('div', 'wt-delegate');
  const value = el('div', 'wt-delegate-value');
  const ic = el('span', 'wt-ic');
  ic.innerHTML = branchIcon;
  value.append(ic, el('span', null, t('worktree.label')), el('code', null, task.worktree.branch));
  value.title = task.worktree.path;
  row.append(el('div', 'wt-delegate-label', t('routing.detail.cwd')), value);
  card.querySelector('.rt-where')?.after(row);
}
/** 委譲カードの「変更」の行。子の会話の作業場所で、会話の間に変わったファイルとコミットがあるときだけ */
async function paintDelegateGit(card) {
  const task = taskById(card.dataset.taskId);
  if (!task?.sessionId) return;
  const res = await cmd('gitStatus', { sessionId: task.sessionId, summary: true }).catch(() => null);
  if (!card.isConnected) return;
  card.querySelector('.git-delegate')?.remove();
  const row = renderDelegateGit(res?.git, { sessionId: task.sessionId });
  if (row) card.querySelector('.rt-where')?.after(row);
}
/**
 * 自動の振り分けで使える委譲先が無かったカード（タスクはできていない）。見出しを成功と同じ「委譲 · 自動 · 種類・難しさ →」にして
 * 行き先の代わりに「使える委譲先がありません」、開かなくても見える位置に理由ごとの行と直す場所への入口、候補ごとの一覧は折りたたむ。
 * エージェント向けのエラー文（内部の理由のコード）は、開いた中の「入力・出力（JSON）」の折りたたみの奥に残す（docs/design-system.md「委譲カード」）
 */
function decorateFailedDelegate(card, result) {
  if (!result || card.dataset.routed || !(result.isError ?? result.is_error)) return;
  const failure = parseRoutingFailure(typeof result === 'string' ? result : result.text);
  if (!failure) return;
  card.dataset.routed = '1';
  card.classList.add('tc-route-failed');
  const head = card.querySelector('.tc-head');
  const label = head.querySelector('.tc-label');
  label.textContent = t('timeline.tool.label.delegate');
  const auto = el('span', 'tc-auto', t('routing.auto'));
  auto.title = t('routing.autoTitle');
  const line = el('span', 'tc-route');
  const text = el('span', 'tc-route-text', t('routing.line.head', { kind: kindText(failure.kind), difficulty: difficultyText(failure.difficulty), target: t('routing.failure.none') }));
  line.title = text.textContent;
  line.append(auto, text);
  head.append(line);
  // 入力と返り値（エージェント向けのエラー文）は、成功・固定のカードと同じ「入力・出力（JSON）」の折りたたみの奥へ
  foldDelegateJson(card);
  const open = (reason) => {
    if (reason === 'unavailable') return { label: t('routing.failure.openAgents'), run: () => { if ($('onboardingDialog').open) $('onboardingDialog').close(); onboarding.open('setup'); } };
    if (reason === 'model_unknown') return { label: t('routing.failure.openDelegation'), run: () => { onboarding.open('delegation'); $('delegationTab').click(); } };
    if (['quota_full', 'quota_high', 'pace_high', 'pace_unknown'].includes(reason)) return { label: t('routing.failure.openUsage'), run: () => { onboarding.open('usage'); $('usageTab').click(); } };
    return null;
  };
  const paint = () => {
    for (const n of card.querySelectorAll(':scope > .tc-why, :scope > .tc-cands-fold')) n.remove();
    card.append(...routingFailureParts(failure, { names: routingNames, open }));
  };
  paint();
  // モデルの表示名は語彙から。まだ無ければ取りに行き、届いたら書き直す（折りたたみを開いていれば開いたまま）
  const missing = [...new Set(failure.skipped.map(s => splitCandidate(s.candidate).backend).filter(b => b && !state.vocab.has(b)))];
  for (const b of missing) loadVocab(b).then(() => {
    const wasOpen = card.querySelector(':scope > .tc-cands-fold')?.open;
    paint();
    if (wasOpen) card.querySelector(':scope > .tc-cands-fold').open = true;
  }).catch(() => {});
}
/** 委譲先の印（依頼元が子の設定を替えると変わる。ADR 0134） */
const routeSig = routing => [routing?.target?.backend, routing?.target?.model, routing?.changed?.at].join('|');
/** 依頼元が委譲先を替えた。題の前と行き先の行のロゴ、行き先の行を新しい委譲先で書き直す */
function repaintRouteTarget(card) {
  const routing = taskById(card.dataset.taskId)?.routing;
  if (!routing?.target || card.dataset.routeSig === routeSig(routing)) return;
  card.dataset.routeSig = routeSig(routing);
  for (const old of card.querySelectorAll('.rt-target-logo')) {
    const logo = routingLogo(routing.target.backend);
    logo.setAttribute('aria-hidden', 'true');
    logo.classList.add('rt-target-logo');
    old.replaceWith(logo);
  }
  paintRouteLine(card, routing);
}
function paintRouteLine(card, routing) {
  const line = card.querySelector('.rt-route');
  if (!line) return;
  line.lastChild.textContent = routingLine(routing, routingNames);
  line.title = line.lastChild.textContent;
  // 内訳の候補の名前も語彙が届いてから書き直す（開いていないので作り直してよい。やり直しの面を開いていたら触らない）
  const detail = card.querySelector('.rt-detail');
  if (detail && !detail.querySelector('.rt-retry')) {
    detail.replaceWith(delegateDetail(card, routing));
    paintRetried(card);
  }
}
/** 内訳の「やり直し」の行（このタスクを人が別の候補でやり直したもの）。タスクの一覧が変わるたびに書き直す */
function paintRetried(card) {
  const box = card.querySelector('.rt-retried');
  if (!box) return;
  const retries = allTasks().filter(x => (x.routing?.retry?.of ?? x.retryOf) === card.dataset.taskId);
  // 4 秒ごとの放送で変わっていなければ触らない（「開く」のフォーカスを奪わない）
  const sig = retries.map(x => `${x.taskId}:${x.status}:${x.model}`).join();
  if (box.dataset.sig === sig && box.childElementCount === retries.length) return;
  box.dataset.sig = sig;
  box.replaceChildren(...retries.map(task => {
    const row = el('div', 'rt-retried-row');
    row.append(el('span', 'rt-retried-label', t('routing.detail.retried')), routingLogo(task.backend),
      el('span', 'rt-retried-model', routingNames.model(task.backend, task.model) || task.model || labelOf(task.backend)),
      el('span', 'rt-retried-state', TASK_STATUS[task.status] ?? task.status ?? ''));
    const open = el('button', 'btn', t('dialog.work.open'));
    open.type = 'button';
    open.onclick = (e) => { e.preventDefault(); openWork(`t:${task.taskId}`, cardCtx.get(card)?.scope ?? null); };
    row.append(open);
    return row;
  }));
}
/** タスクの一覧が変わったら、会話の中の委譲カードを追いつかせる（記録が後から届いたカード・やり直しの行） */
function paintDelegateCards() {
  for (const [root, scope] of delegateRoots()) paintDelegateCardsIn(root, scope);
}
function paintDelegateCardsIn(root, scope) {
  const missing = [];
  for (const card of root.querySelectorAll('.tc[data-task-id]')) {
    if (card.dataset.routed) { repaintRouteTarget(card); paintRetried(card); }
    else decorateDelegateCard(card);
    // 始まって終わるまでが running の配信の間に収まった委譲は、会話の分を読んだ後に増えている。カードの分だけ 1 度読む
    const id = card.dataset.taskId;
    if ((scope || taskCards.sessionId === state.current) && !taskCards.asked.has(id) && !taskById(id)) { taskCards.asked.add(id); missing.push(id); }
  }
  paintDelegateStates(root, scope);
  if (missing.length) fetchTaskCards(missing).catch(() => {});
}

/**
 * 委譲カードの右端（値の列）。動いている間は弧と経過（m:ss）、承認待ちは差し色の字だけ、失敗は「✕ 失敗」、
 * 終わったものは静止した印（✓・横線）。終わった時刻は触れたときだけ。弧・印で足りる状態の字は出さない（ADR 0067）。
 * 印の名前は読み上げ・title が持つ
 */
function delegateStateOf(item) {
  if (item.waiting) return { key: 'waiting', text: TASK_STATUS.waiting };
  // ホストがオフライン: 時計を止め、衛星と「HH:MM まで」（知らないことを進めない）
  if (item.live && item.hostOffline) return { key: 'offline', mark: markOf(item), when: item.hostUntil ? t('dialog.work.hostUntil', { time: clockOf(item.hostUntil) }) : '' };
  if (item.live) return { key: 'running', mark: markOf(item), start: timeOf(item.startedAt) };
  const when = elapsedText(item);
  if (item.status === 'completed') return { key: 'done', mark: markOf(item), when };
  if (item.status === 'failed') return { key: 'failed', mark: null, text: t('timeline.result.failed'), when };
  return item.status ? { key: 'stopped', mark: markOf(item), when } : null;
}

/** 走っているカードの経過を 1 秒ごとに書き換える。走っているカードが無くなったら止める */
let delegateTicker = 0;
function tickDelegateElapsed() {
  const spans = delegateRoots().flatMap(([root]) => [...root.querySelectorAll('.tc-el[data-start]')]);
  if (!spans.length) { clearInterval(delegateTicker); delegateTicker = 0; return; }
  const now = Date.now();
  for (const span of spans) span.textContent = clockText(now - Number(span.dataset.start));
}

function paintDelegateStates(root = thread, scope = null) {
  const cards = [...root.querySelectorAll('.tc[data-tool]')].filter(c => c.querySelector(':scope > .tc-go'));
  if (!cards.length) return;
  const items = backgroundItems(scope).filter(i => i.group === 'agent');
  for (const card of cards) {
    const res = card.querySelector('.tc-res');
    if (!res || card.classList.contains('tc-error')) continue;
    const item = card.dataset.taskId ? items.find(i => i.taskId === card.dataset.taskId) : items.find(i => i.origin && i.origin === card.dataset.id);
    const next = item ? delegateStateOf(item) : null;
    // 走っている間の経過は署名に入れない（秒ごとの書き換えは tickDelegateElapsed）
    // worktree が終わった後も台帳に残っている（未取り込み）。閉じた行の右端に出す（ADR 0089）
    const unmerged = Boolean(item?.worktree?.live) && !item.live;
    const sig = next ? `${next.key}|${next.when ?? ''}|${next.mark?.getAttribute('aria-label') ?? ''}|${unmerged ? 'u' : ''}` : '';
    // 読み上げ名は、題・委譲先・状態。押すと開く（summary は開閉の状態を持つ）
    const head = card.querySelector('.tc-head');
    const stateName = next ? (next.key === 'waiting' ? TASK_STATUS.waiting : next.mark?.getAttribute('aria-label') ?? next.text ?? '') : '';
    const agent = item ? [labelOf(item.backend), modelText(item)].filter(Boolean).join(' ') : '';
    head.setAttribute('aria-label', t('timeline.delegate.label', { title: card.querySelector('.tc-main')?.textContent ?? '', agent, state: stateName }));
    if (res.dataset.sig === sig) continue;
    res.dataset.sig = sig;
    res.classList.toggle('tc-res-wait', next?.key === 'waiting');
    // 走っている・承認待ち・失敗のカードは沈めない（web/tools.css）
    if (next?.key === 'waiting') card.dataset.dstate = 'waiting';
    else if (item?.live) card.dataset.dstate = 'running';
    else if (item?.status === 'failed') card.dataset.dstate = 'failed';
    else delete card.dataset.dstate;
    // 先頭の空きは、行の外に重ねた矢印（.tc-go）の場所
    const parts = [el('span', 'tc-go-slot')];
    if (next) {
      if (unmerged) parts.push(el('span', 'wt-unm', t('worktree.delegate.unmerged')));
      if (next.mark) parts.push(next.mark);
      if (next.key === 'running' && next.start) { const span = el('span', 'tc-el', clockText(Date.now() - next.start)); span.dataset.start = String(next.start); parts.push(span); }
      else if (next.text) parts.push(el('span', next.key === 'failed' ? 'tc-res-err' : null, next.text));
      if (next.when) parts.push(el('span', 'tc-when', next.when));
    }
    res.replaceChildren(...parts);
  }
  if (!delegateTicker && root.querySelector('.tc-el[data-start]')) delegateTicker = setInterval(tickDelegateElapsed, 1000);
}
/** 「別の候補でやり直す」の面を開閉する。候補は設定 › 委譲と同じ一覧から、今使えるものだけ */
async function toggleRetry(card, root, button) {
  const opened = root.querySelector('.rt-retry');
  if (opened) { opened.remove(); button.setAttribute('aria-expanded', 'false'); return; }
  button.disabled = true;
  try {
    const data = await cmd('delegationRouting');
    const taskId = card.dataset.taskId;
    const task = taskById(taskId);
    const routing = task?.routing ?? cardRouting.get(card);
    for (const b of new Set((data.candidates ?? []).map(c => c.backend).filter(b => b && !state.vocab.has(b)))) await loadVocab(b).catch(() => {});
    const panel = retryPanel({ candidates: retryCandidates(data.candidates, routing, data.tiers), running: TASK_LIVE.has(task?.status),
      names: routingNames, logo: routingLogo,
      run: (args) => cmd('retryAgentTask', { taskId, ...args }),
      close: (result) => {
        panel.remove();
        button.setAttribute('aria-expanded', 'false');
        button.focus();
        if (result?.task && !taskById(result.task.taskId)) { taskCards.rows.set(result.task.taskId, result.task); taskCards.ver++; }
        paintRetried(card);
      } });
    root.querySelector('.rt-actions').after(panel);
    button.setAttribute('aria-expanded', 'true');
    panel.querySelector('input:checked, button')?.focus();
  } catch (e) { retryNote(root, t('routing.retry.failed', { error: e.message })); }
  finally { button.disabled = false; }
}

/** 「別の候補でやり直す」の候補を読めなかったとき。内訳の中の一行（会話の流れには入れない） */
function retryNote(root, text) {
  root.querySelector('.rt-retry-fail')?.remove();
  root.append(el('p', 'rt-retry-note rt-retry-fail', text));
}
/** 子の会話を開けなかったとき。カードのすぐ下の一行（会話の流れには入れない） */
function cardNote(card, text) {
  card.querySelector(':scope > .tc-go-note')?.remove();
  card.append(el('p', 'tc-endpoint-note tc-go-note', text));
}

async function openFromCard(card, button) {
  const ctx = cardCtx.get(card) ?? null, scope = ctx?.scope ?? null;
  if (card.dataset.taskId) return openWork(`t:${card.dataset.taskId}`, scope);
  const toolId = card.dataset.id;
  const live = backgroundItems(scope).find(x => x.origin === toolId);
  if (live) return openWork(live.key, scope);
  const sessionId = ctx?.sessionId ?? state.current;
  button.disabled = true;
  try {
    const { agentId, status, startedAt, endedAt } = await cmd('findSubagent', { sessionId, toolId });
    if (!agentId) throw new Error(t('dialog.work.notFound'));
    const key = `a:${sessionId}:${agentId}`;
    const title = card.dataset.bgTitle;
    bg.extra.set(key, { key, group: 'agent', source: 'native', title: title || agentId, backend: ctx?.backend ?? activeBackendId(), model: null, effort: null,
      status: status ?? (card.classList.contains('tc-fail') ? 'failed' : 'completed'), live: status === 'running', extra: true,
      startedAt: startedAt ?? null, endedAt: endedAt ?? null, origin: toolId, parentId: sessionId, agentId });
    openWork(key, scope);
  } catch (e) { cardNote(card, t('dialog.work.openFailed', { error: e.message })); }
  finally { button.disabled = false; }
}

$('workDialog').addEventListener('close', () => { bg.view = null; bg.extra.clear(); bg.scope = null; });

// ---------------------------------------------------------------- 配色
// 明示的に選んだらそれを守る。選んでいなければ OS の設定に従う。端末ごとの好みなのでブラウザ側に覚える。

const THEMES = ["auto", "light", "dark"];

function applyTheme(mode) {
  const m = THEMES.includes(mode) ? mode : "auto";
  if (m === "auto") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = m;
  try { localStorage.setItem("agent-host-theme", m); } catch { /* 保存できなくても動く */ }
  for (const b of $("themeSeg").querySelectorAll("button")) b.classList.toggle("on", b.dataset.theme === m);
  paintTitleBar();
  paintShellTheme();
}

/**
 * モバイル版の殻へ、今の配色が暗いかと、画面の上端・下端の地の色を知らせる。殻は状態バー・ナビゲーションバーの下に画面を描かず
 * （2026-09-24）、バーをこの色で塗り、記号の明暗を合わせる（mobile/android の HostActivity）。古い殻には口が無いので黙って何もしない
 */
let shellThemeSent = "";
function paintShellTheme() {
  const setTheme = window.plyRemote?.setTheme;
  if (typeof setTheme !== "function") return;
  const m = document.documentElement.dataset.theme;
  const dark = m === "dark" || (m !== "light" && matchMedia("(prefers-color-scheme: dark)").matches);
  const colors = { top: edgeColor(0), bottom: edgeColor(innerHeight - 1) };
  const key = JSON.stringify([dark, colors]);
  if (key === shellThemeSent) return;
  shellThemeSent = key;
  try { setTheme(dark, colors); } catch { /* 殻が受けなくても画面は動く */ }
}

/** 画面の横の中ほど、高さ y にある地の色（#rrggbb）。透ける面（幕など）は飛ばして下の面を見る */
function edgeColor(y) {
  for (let node = document.elementFromPoint(innerWidth / 2, y); node; node = node.parentElement) {
    const c = getComputedStyle(node).backgroundColor.match(/^rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)$/);
    if (c && (c[4] === undefined || Number(c[4]) >= 1)) return `#${c.slice(1, 4).map(n => Number(n).toString(16).padStart(2, "0")).join("")}`;
  }
  return "";
}

/** 地の色が変わりうるとき（脇・設定の開閉、幅の変化、動きの終わり）に、次の描画で送り直す。送るのは変わったときだけ */
function watchShellTheme() {
  if (typeof window.plyRemote?.setTheme !== "function") return;
  let frame = 0;
  const soon = () => { if (!frame) frame = requestAnimationFrame(() => { frame = 0; paintShellTheme(); }); };
  const watch = new MutationObserver(soon);
  watch.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "data-theme"] });
  watch.observe(document.body, { attributes: true, attributeFilter: ["class"] });
  addEventListener("resize", soon);
  document.addEventListener("transitionend", soon);
  soon();
}

function initTheme() {
  let saved = "auto";
  try { saved = localStorage.getItem("agent-host-theme") ?? "auto"; } catch { /* 読めなくても動く */ }
  applyTheme(saved);
  for (const b of $("themeSeg").querySelectorAll("button")) b.onclick = () => applyTheme(b.dataset.theme);
  // 自動のときは OS の明暗が変わると面の色も変わる。窓のボタンの地も追いかける
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => { paintTitleBar(); paintShellTheme(); });
}

// ---------------------------------------------------------------- 言語
// 設定値（auto|ja|en）はサーバーの prefs.json に置く。サーバーが OS の言語と合わせて解決した言語が画面の正本で、
// ready と prefs イベントで届く。今の画面と違う言語が届いたら、写し（localStorage）を直して読み直す。
// 途中で文言を差し替える経路は持たない（読み直せば全部が確実にその言語になる）。

state.locale = { setting: "auto", lang: uiLang };

function paintLocale() {
  const { setting, lang } = state.locale;
  for (const b of $("localeSeg").querySelectorAll("button")) {
    const v = b.dataset.locale;
    b.classList.toggle("on", v === setting);
    b.setAttribute("aria-pressed", String(v === setting));
    b.textContent = v === "auto"
      ? setting === "auto" ? t("settings.appearance.language.autoResolved", { lang: languageName(lang) }) : t("settings.appearance.language.auto")
      : languageName(v);
  }
  $("localeNow").textContent = t("settings.appearance.language.current", { lang: languageName(uiLang) });
}

/** サーバーから届いた言語を受ける。読み直すなら true */
/** 版の違うサーバーにつながったら、入力欄の下書きを保存してから読み直す。読み直すなら true（docs/zero-downtime-update/design.md §8） */
function reloadForVersion(ready) {
  let done = null;
  try { done = sessionStorage.getItem("ply-version-reload"); } catch {}
  const key = versionReload(SERVED_BUILD, ready, done);
  if (!key) return false;
  // 印を残せない（保存が禁止されている）と、読み直しを繰り返しうるので読み直さない
  try { sessionStorage.setItem("ply-version-reload", key); } catch { return false; }
  Promise.race([saveDraft().catch(() => {}), new Promise((resolve) => setTimeout(resolve, 3000))]).finally(() => location.reload());
  return true;
}

function applyLocale(info) {
  if (!info || !["ja", "en"].includes(info.lang)) return false;
  state.locale = { setting: info.setting ?? "auto", lang: info.lang };
  // 写しを書けないとき（保存が禁止されている）は読み直しても同じ言語で始まるので、読み直さない（繰り返さないため）
  if (rememberLang(info.lang) && info.lang !== uiLang) { location.reload(); return true; }
  paintLocale();
  return false;
}

function initLocale() {
  for (const b of $("localeSeg").querySelectorAll("button")) b.onclick = () => {
    if (b.dataset.locale === state.locale.setting) return;
    // 結果は prefs イベントで届く（ほかのタブにも）。ここでは失敗だけ拾う
    cmd("setPref", { key: "locale", value: b.dataset.locale })
      .catch((e) => { $("localeNow").textContent = t("settings.appearance.language.saveFailed", { error: e.message }); });
  };
  paintLocale();
}

// ---------------------------------------------------------------- 窓の上端（デスクトップ版）
// 閉じる・最小化のボタンは OS が描くので、地（帯の右端の面）と記号（本文の字）の色を今の配色から読んで送る。
// 地は脇の開閉・設定・プレビュー・窓の幅でも変わる（style.css の --bar-end）。どの条件で何色かは CSS だけが決め、
// ここは解決した結果を読むだけ。tokens.css の値も二重に持たない。同じ色は送り直さない
let titleBarSent = "";
function paintTitleBar() {
  if (!window.plyDesktop?.setTitleBar) return;
  const bar = document.querySelector(".titlebar");
  if (!bar) return;
  const css = getComputedStyle(bar);
  const colors = { color: css.getPropertyValue("--bar-end").trim(), symbolColor: css.getPropertyValue("--ink").trim() };
  const key = JSON.stringify(colors);
  if (key === titleBarSent) return;
  titleBarSent = key;
  window.plyDesktop.setTitleBar(colors);
}

// 帯の色を決める印（html の class・配色、body の class）が変わるたび、窓の幅が変わるたびに合わせ直す。
// 脇の開閉では setSidebar が side-moving を外した瞬間が、そのまま切り替えの瞬間になる
function watchTitleBar() {
  if (!window.plyDesktop?.setTitleBar) return;
  const watch = new MutationObserver(paintTitleBar);
  watch.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "data-theme"] });
  watch.observe(document.body, { attributes: true, attributeFilter: ["class"] });
  addEventListener("resize", paintTitleBar);
  paintTitleBar();
}

// 入力欄の既定の案内。指で使う画面には Ctrl+Enter が無いので、送信のボタンを案内する
const promptPlaceholder = () => (matchMedia("(pointer:coarse)").matches ? t("chat.composer.placeholderTouch") : t("chat.composer.placeholder"));

// ---------------------------------------------------------------- 脇の開閉
// 端末ごとの好みなのでブラウザ側に覚える。最初の描画での反映は index.html の先頭の script が済ませている。
// 設定の間は脇が設定メニューなので、開閉は受け付けない（CSS でも必ず開いて見える）

const SIDEBAR_STORE = "agent-host-sidebar";
let sidebarMoving;
// 狭い画面（style.css の「狭い画面・タッチ」と同じ 700px）では、脇は会話の上に重ねる引き出し（docs/remote.md §8.4）。
// 開閉は side-open で持ち、覚えない（広い画面の好み side-closed はそのまま残す）。会話を選ぶ・幕を押す・Esc で閉じる
const narrowView = matchMedia("(max-width:700px)");
const drawerOpen = () => document.documentElement.classList.contains("side-open");

function setDrawer(open, { refocus = true } = {}) {
  const root = document.documentElement;
  if (drawerOpen() === open) return;
  root.classList.toggle("side-open", open);
  if (open) side.redraw();
  $("openSidebar").setAttribute("aria-expanded", String(open));
  // 開いている間は背後を inert にする。Tab は脇の中だけを巡り、見えない会話を操作させない（設定で会話を覆うときと同じ手）
  for (const n of document.body.children) if (n.matches("main, .file-preview, .host-bar, #remoteBadge")) n.inert = open;
  const from = document.activeElement;
  // 検索欄には置かない（スマホでキーボードが出る）。閉じるボタンへ。閉じたら開いたボタンへ戻す。
  // 開くときは style.css が visibility をすぐ visible にするので、この場で置ける。置けなかったら（まだ隠れていた）次のフレームで置き直す
  if (open) {
    const close = $("closeSidebar");
    close.focus({ preventScroll: true });
    if (document.activeElement !== close) requestAnimationFrame(() => { if (drawerOpen() && !$("sidebar").contains(document.activeElement)) close.focus({ preventScroll: true }); });
  }
  else if (refocus && (!from || from === document.body || $("sidebar").contains(from))) $("openSidebar").focus({ preventScroll: true });
}

function setSidebar(open) {
  const root = document.documentElement;
  if (narrowView.matches && !document.body.classList.contains("settings")) return setDrawer(open);
  if (document.body.classList.contains("settings") || root.classList.contains("side-closed") !== open) return;
  document.body.classList.add("side-moving");
  root.classList.toggle("side-closed", !open);
  if (open) side.redraw();
  try { localStorage.setItem(SIDEBAR_STORE, open ? "open" : "closed"); } catch { /* 保存できなくても動く */ }
  // 押したボタンは消える。居場所を body に落とさず、反対側のボタンへ移す
  const from = document.activeElement;
  if (!open && $("sidebar").contains(from)) $("openSidebar").focus();
  else if (open && from === $("openSidebar")) $("closeSidebar").focus();
  // 動き終わったら動きを外し、会話の幅が変わった分だけプレビューの幅と枝のグラフを測り直す。--dur（240ms）より少し待つ
  clearTimeout(sidebarMoving);
  sidebarMoving = setTimeout(() => { document.body.classList.remove("side-moving"); filePreview.layout(); relayoutBranches(); }, motionDuration(240) + 40);
}

function initSidebar() {
  $("closeSidebar").onclick = () => setSidebar(false);
  $("openSidebar").onclick = () => setSidebar(true);
  $("sideVeil").onclick = () => setDrawer(false);
  // 引き出しの中で会話の行・設定を押したら閉じる。メニューから開く・新しく始めるときは select / startNew が閉じる
  $("sidebar").addEventListener("click", (e) => {
    if (!narrowView.matches || !drawerOpen()) return;
    if (e.target.closest(".row, #settings, #authNeed")) setDrawer(false);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || !drawerOpen() || e.defaultPrevented || isComposingKey(e)) return;
    if (document.querySelector("dialog[open], .pop.menu, .pop:not([hidden])")) return;
    setDrawer(false);
  });
  // 広い画面へ戻ったら引き出しの印を外す（幕が残らないように）
  narrowView.addEventListener("change", () => { setDrawer(false, { refocus: false }); side.redraw(); paintMoreEntry(); });
  // Ctrl+B（macOS は ⌘B）。入力欄でも太字などの既定の意味は無いので、どこからでも効かせる。
  // macOS の Ctrl+B は入力欄で「1 文字戻る」なので奪わない
  const mac = /Mac/.test(navigator.platform);
  document.addEventListener("keydown", (e) => {
    if (isComposingKey(e) || e.altKey || e.shiftKey || (mac ? !e.metaKey || e.ctrlKey : !e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== "b") return;
    if (document.querySelector("dialog[open]")) return;
    e.preventDefault();
    setSidebar(document.documentElement.classList.contains("side-closed"));
  });
}

// ---------------------------------------------------------------- 下書き
// 書きかけの文章と添付をセッションごとに持つ。共有にすると A で書いたものが B から送れてしまう。

const draftKey = () => state.current ?? "";
const DRAFT_STORE = "agent-host-drafts-v1";
try { state.drafts = new Map(JSON.parse(localStorage.getItem(DRAFT_STORE) ?? "[]")); } catch { /* server copy remains available */ }
const draftWrites = new Map();
// 打鍵ごとの保存は間引く（長い下書きを毎打鍵ぶん localStorage とサーバーへ書かない）。静かな間の最初の打鍵はすぐ保存し、
// 続く打鍵は DRAFT_THROTTLE_MS ごとに 1 回（最後の打鍵の分は必ず保存する）。会話の切り替え・送信・ページを離れる・欄を離れるときは直ちに保存する
const DRAFT_THROTTLE_MS = 400;
let draftTimer = null, draftSavedAt = 0;
function saveDraftSoon() {
  const wait = draftSavedAt + DRAFT_THROTTLE_MS - Date.now();
  if (wait <= 0) saveDraft().catch(() => {});
  else if (draftTimer === null) draftTimer = setTimeout(() => saveDraft().catch(() => {}), wait);
}
/** 間引いて待っている保存があれば、いま保存する */
function flushDraft() { if (draftTimer !== null) saveDraft().catch(() => {}); }
function saveDraft() {
  clearTimeout(draftTimer);
  draftTimer = null;
  draftSavedAt = Date.now();
  const id = draftKey();
  // 開いている途中の欄は前の下書きの写しなので保存しない。作ったばかりの会話（freshSessionId）は欄が正本なので保存する
  if (id && state.loadingSession === id && id !== freshSessionId) return Promise.resolve();
  // シェルの形の欄は `!` を頭に戻して残す（復元ではシェルの形に入らない。web/shell-composer.mjs）
  // text は文中の添付の印（[添付] パス）を含む Markdown（位置が残る）。version: 2 より前の下書きは印が無く、添付は「文末に付く」になる
  const value = { text: shellComposer.draftText(), attached: state.attached.slice(), version: 2, dirty: true };
  return persistDraft(id, value);
}
function persistDraft(id, value) {
  state.drafts.set(id, value);
  try { localStorage.setItem(DRAFT_STORE, JSON.stringify([...state.drafts])); } catch { /* report server result below */ }
  if (!id) return Promise.resolve();
  if (state.current === id) setDraftNote(t("chat.draft.saving"), "saving");
  const work = (draftWrites.get(id) ?? Promise.resolve()).catch(() => {}).then(() => cmd("saveDraft", { sessionId: id, ...value }));
  draftWrites.set(id, work);
  work.then(() => {
    if (state.drafts.get(id) === value) {
      value.dirty = false;
      try { localStorage.setItem(DRAFT_STORE, JSON.stringify([...state.drafts])); } catch {}
    }
    const s = state.sessions.find(s => s.id === id);
    if (s) s.hasDraft = Boolean(value.text || value.attached.length);
    if (state.current === id && draftWrites.get(id) === work) setDraftNote(t("chat.draft.saved"), "saved");
  }, () => {
    if (state.current === id) setDraftNote(t("chat.draft.saveFailed"), "failed");
  });
  return work;
}
/**
 * 新しい会話の欄の下書き（キー ""）を消す。本物の会話が引き取った後に残すと、
 * 後で current が null に戻ったとき（開いていた会話が消された等）に古い字が欄に戻ってくる
 */
function dropBlankDraft() {
  if (!state.drafts.delete("")) return;
  try { localStorage.setItem(DRAFT_STORE, JSON.stringify([...state.drafts])); } catch {}
}
/**
 * 入力欄の行の「保存済み」。state は saving | saved | failed | restored。
 * 700px 以下は行に出さず、失敗だけをチップの行の上の一行（#draftFail）に出す（行の隙間では文が途中で切れるため。style.css）
 */
function setDraftNote(text, st) {
  const b = $("draftSaved");
  b.textContent = text;
  b.dataset.state = st;
  const failed = st === "failed";
  $("draftFail").hidden = !failed;
  $("draftFailText").textContent = failed ? t("chat.draft.saveFailedNote") : "";
}
function loadDraft() {
  const d = state.drafts.get(draftKey());
  shellComposer.reset();
  // 添付の実体を先に置く（本文の印は、ここにあるものだけが札になる。無い印・古い下書きの添付は「文末に付く」）
  state.attached = Array.isArray(d?.attached) ? d.attached.slice() : [];
  chatAttach.dropFailed();
  $("prompt").value = typeof d?.text === "string" ? d.text : "";
  fitPrompt();
  renderAttached();
  // ホストのファイルの面で選んでいたもの・開いていた場所は会話ごと（次は新しい会話の作業ディレクトリから）
  attachMenu?.reset();
  setDraftNote(d?.text || d?.attached?.length ? t("chat.draft.restored") : "", "restored");
}
$("draftSaved").onclick = () => saveDraft().catch(() => {});
// 狭い幅の「再試行」。押すと一行は「保存中…」で消えるので、フォーカスは入力欄へ（失敗すれば一行が出直す）
$("draftFailRetry").onclick = () => { $("prompt").focus(); saveDraft().catch(() => {}); };
// 内蔵ブラウザー（web/browser-panel.mjs）。デスクトップ版のホストの画面だけ。右パネルの 1 つのモードになる
let browserEntry = null;   // 頭の行のボタン（下の setupBrowserEntry）。状態の知らせが先に届いても落ちないよう先に宣言する
// エージェントの Chrome の窓（右パネル「Chrome の窓」。web/chrome-panel.mjs）。会話ごとの窓の有無はサーバーの chromeWindow イベントで届く。知らせが先に届いても受けられるよう表を先に作る
const chromeWindows = createWindowTable();
let chromePanel = null, chromeEntry = null;
const browserPanel = browserPanelAvailable()
  ? createBrowserPanel({ showMenu: (x, y, items, title, opts) => showMenu(x, y, items, title, opts), getSessionId: () => state.current ?? null, getAgentName: () => labelOf(activeBackendId()),
    onChange: () => browserEntry?.paint() })
  : null;
// ホストの画面ではない端末から、ホストの内蔵ブラウザーを見る（web/remote-browser.mjs）。リンクを押したら開き先を選ぶ（web/link-sheet.mjs）
const remoteBrowser = createRemoteBrowser({ cmd: (command, args) => cmd(command, args), getSessionId: () => state.current ?? null,
  getAgentName: () => labelOf(activeBackendId()), getHostName: () => state.hostCaps?.hostName ?? '' });
/** シートを出したら true。ホストの画面・内蔵ブラウザーの無いホストでは出さない（呼び出し側が今までどおりに開く） */
function chooseRemote({ url = '', kind = 'url', label = url, openHere = () => {}, target = { url } }) {
  const choices = linkChoices({ url, kind, pageOrigin: location.origin, hostScreen: state.osActions === true, pcBrowser: state.hostCaps?.pcBrowser === true });
  if (!choices) return false;
  showLinkSheet({ label, choices, hostName: state.hostCaps?.hostName ?? '', onDevice: openHere, onPc: () => remoteBrowser.open(target) });
  return true;
}
const filePreview = setupFilePreview({
  browser: browserPanel,
  chooseSnapshot: (query, openHere) => chooseRemote({ kind: 'snapshot', label: t('filePreview.visual.title'), openHere,
    target: { visualization: { sessionId: query.sessionId, id: query.id, at: query.at } } }),
  // サブエージェントの会話（作業のダイアログ）は、親の会話の sessionId を data-session-id に持つ
  // Channels の中のリンクは、そのスレッドの bot の会話を基準にする（web/channels/）。それ以外は今の会話
  getContext: anchor => channelsUi.contextForPanel(anchor) ?? ({ sessionId:anchor?.closest('#workBody')?.dataset.sessionId || state.current, at:anchor?.closest('.m')?.dataset.at }),
  onLayout: () => requestAnimationFrame(relayoutBranches),
  // ファイルの操作メニューは会話一覧と同じ 1 つを使う。OS の操作はサーバーが「この PC の画面」と答えたときだけ
  showMenu: (x, y, items, title) => showMenu(x, y, items, title),
  cmd: (command, args) => cmd(command, args),
  osActions: () => state.osActions === true,
  getPrefs: () => state.prefs,
  useFile: file => { if (attachHostFiles([file])) $('prompt').focus(); },
  onBrowsing: () => browserEntry?.paint(),
});
// 頭の行の内蔵ブラウザーのボタンと近道（web/header-entries.mjs）。使えない画面では出さない
browserEntry = setupBrowserEntry({ button: $('browserEntry'), browser: browserPanel, preview: filePreview, bridge: window.plyDesktop?.browser,
  getSessionId: () => state.current ?? null, getAgentName: () => labelOf(activeBackendId()),
  blocked: () => document.body.classList.contains('settings') || !!document.querySelector('dialog[open]') });
// いま見ている場所のアドレス（web/view-address.mjs）。通知の一覧・検索・脇の行・スレッドの開閉はここを通り、見ている場所を 1 つで残す。
// 前の回に見ていた場所は、会話を開く（select が残す）前に読んでおく（起動時に Channels の面の位置を戻す）
const savedView = readAddress(localStorage);
let viewRestored = false;
const viewAddress = createViewAddress({ storage: localStorage,
  openSession: async ({ sessionId, uuid }) => {
    channelsUi.setTab('chats');
    await openFromSearch(sessionId, uuid ? { uuid, role: 'assistant', query: '', speaker: 'assistant' } : null);
  },
  openChannels: (detail) => document.dispatchEvent(new CustomEvent('channels:show', { detail })) });
// 通話モード（承認済み 2026-10-06。web/voice/、docs/voice-call.md）。部品を差し込む口は 1 か所ずつ: Chats の会話はこの下の voiceUi.mount、スレッドは web/channels/thread.mjs
const voiceUi = setupVoice({ token, invoke: async (op, args = {}) => cmd('invoke', { op, args }), openSettings: () => { onboarding.open('voice'); voiceSettings.load(); }, available: () => state.voice === true });
// bot・Channels・ルーティンの画面（web/channels/index.mjs。docs/channels.md「画面の口」）。client.mjs が持つのはこの 1 つの口だけ
const channelsUi = setupChannels({
  voice: voiceUi,
  cmd: (command, args) => cmd(command, args),
  invoke: async (op, args = {}) => cmd('invoke', { op, args }),
  state, filePreview, side, t,
  browser: browserPanel,   // 内蔵ブラウザー（スレッドの見出しの入口が右パネルをブラウザーにする。使えない画面では null）
  whenOnline,              // 切れている間、つながり直すのを待つ（入力欄の添付の断片の送り手。web/attach-upload.mjs）
  openImage: (src, caption, path, origin) => openLightbox(src, caption, path, origin),   // 添付の画像を大きく見る（会話と同じライトボックス）
  permissionCard: (ev, into) => (ev.kind === 'question' ? questionCard(ev, into) : permissionCard(ev, into)),   // 質問も同じ口（bot の質問）
  openSession: (id) => viewAddress.go({ sessionId: id }),
  // 見ている場所が替わった（Channels の面・スレッドの開閉）・Chats の側へ戻った
  noteView: (view) => {
    viewAddress.note(view);
    // 一時チャットの流れを見ているか（その右に会話を並べられる）。別の面へ移ったら 2 枚並びをやめる
    const homeFeed = view?.kind === 'channel' && view.id === 'home' && !view.threadId;
    document.body.classList.toggle('home-feed', homeFeed);
    if (!homeFeed) setHomeSplit(false);
    renderSessions();
  },
  // 一時チャットの流れ（web/channels/feed.mjs）: 会話を開く・新しい会話を書く・状態のメニュー・エージェントの名前
  openHomeThread: (sessionId) => openHomeThread(sessionId),
  newHomeThread: (draft) => newHomeThread(draft),
  homeStatusItems: (sessionId) => homeStatusItems(sessionId),
  agentName: (sessionId) => { const s = state.sessions.find((x) => x.id === sessionId); return s ? labelOf(s.backend) : null; },
  // スレッドの入力欄の設定のチップ（web/channels/thread-composer.mjs）: エージェントのモデル・承認モードの語彙と、エフォートの段
  vocab: (backend) => loadVocab(backend),
  quota: (backend) => usageSource.load(backend),
  openUsage: () => { onboarding.open('usage'); $('usageTab').click(); },
  // 送信の日時の面の一言（窓を閉じても動き続けるか・ホストの時刻帯）。会話の入力欄と同じ材料
  scheduleEnvironment: async () => {
    const status = await cmd('remoteStatus').catch(() => null);
    const resident = status?.resident;
    return { persistent: !resident?.available || Boolean(status?.enabled && resident.keepRunning), hostZone: state.hostTimeZone };
  },
  efforts: (args) => cmd('efforts', args),
  noteChats: () => { setHomeSplit(false); if (state.current) viewAddress.note({ sessionId: state.current }); renderSessions(); },
  // 委譲の子の様子（スレッドの入口・作業ログの委譲カード）。Chats と同じ部品を使う（docs/design-system.md「バックグラウンド」「委譲カード」）
  background: {
    watch: (ids) => watchSessions(ids),
    items: (scope) => backgroundItems(scope).filter(i => i.group === 'agent'),
    subscribe: (fn) => { watched.listeners.add(fn); return () => watched.listeners.delete(fn); },
    open: (scope) => openWork(undefined, scope),
    link: (card, input, result, ctx) => linkDelegateCard(card, input, result, ctx),
    mount: (root, scope) => { channelRoots.set(root, scope); },
    paint: () => paintDelegateCards(),
  },
  openSidebar: () => setSidebar(true),
  // スレッドの `!` の行（宛先の bot の会話のシェル）。Chats の行と同じ部品で、出力・終わりは onShellEvent が描き直す
  shellRow: (m) => commandMsg(m),
  showMenu: (x, y, items, title, opts) => showMenu(x, y, items, title, opts),
  renderAssistantMarkdown, renderPresent,
});
// 通知ボタンと通知の一覧（承認済み 2026-10-06。web/notification-inbox.mjs）。件数は notificationsChanged、一覧は notifications.list
const notificationInbox = setupNotificationInbox({
  bell: $('notifBell'), panel: $('notifPanel'), veil: $('notifVeil'),
  invoke: (op, args = {}) => cmd('invoke', { op, args }), t, relTime,
  titleOf: id => { const title = state.sessions.find(s => s.id === id)?.title; return title && title !== '(no title)' ? title : ''; },
  open: target => openFromNotification(target),
  narrow: narrowView, anchor: () => $('sidebar'),
});
// External resource confirmation is available on every screen.
const computerSettings = setupComputerSettings({ cmd: (command, args) => cmd(command, args), getPrefs: () => state.prefs, getHostCaps: () => state.hostCaps });
const browserSettings = setupBrowserSettings({ available: !!browserPanel, cmd: (command, args) => cmd(command, args), getPrefs: () => state.prefs, getAgentLabel: labelOf, getHostCaps: () => state.hostCaps });
// 通話モードの差し込み口（Chats の会話）。契約は web/voice/index.mjs の冒頭。入力欄・頭・メインの面へは、ここの 1 か所だけで繋ぐ
const voiceWraps = new WeakMap();
voiceUi.mount({
  id: 'chat',
  header: document.querySelector('body > main > header.top'), headerBefore: $('tocEntry'),
  composer: chatComposer.voiceSlot(),
  main: document.querySelector('body > main'), log: $('log'), overlay: $('logFrame'), replyScope: () => $('log'),
  tail: {
    // 本物の行と同じ入れ物（.mw > 筋 + .mw-body。wrap・place が作る）に入れて、同じ列・同じ幅の規則で出す。「止める」の行も同じ列へ（一度だけ包む）
    place: (node) => place(node.classList.contains('mw') ? node : (voiceWraps.get(node) ?? voiceWraps.set(node, wrap(node)).get(node))), rows: thread,
    isRow: (node) => node.classList.contains('mw') && Boolean(node.querySelector('.m.user')),   // 会話の列の行は .mw の中に .m.user が入る
    markHost: (row) => row.querySelector('.m.user > .who > span'),
    createRow: () => { const m = el('div', 'm user'); m.append(whoLine(t('chat.message.you'), new Date().toISOString(), { actions: false })); const body = el('div', 'body'); m.append(body); return { el: wrap(m), body }; },
  },
  target: () => ({ kind: 'chat', sessionId: state.current && state.current !== freshSessionId ? state.current : null }),
  send: (text) => submitVoiceText(text),
  sendTo: (target, text) => submitVoiceText(text, target),
  follow: () => { const log = $('log'); if (log.scrollHeight - log.scrollTop - log.clientHeight < 160) log.scrollTop = log.scrollHeight; },
});
// 会話とプレビューの外部リンクは設定の開き先へ（web/link-open.mjs）
configureLinkOpen({ getPrefs: () => state.prefs, chooseRemote: (url, openHere) => chooseRemote({ url, openHere }) });
// 文中の URL・名前付きのリンクの、行き先の一行と右クリックのメニュー（web/link-menu.mjs）
setupLinkMenu({ showMenu: (x, y, items, title) => showMenu(x, y, items, title), getPrefs: () => state.prefs,
  screen: () => ({ hostScreen: state.osActions === true, pcBrowser: state.hostCaps?.pcBrowser === true }),
  openOnPc: url => remoteBrowser.open({ url }) });
configurePreviewConfirmation({ getPrefs: () => state.prefs, openSettings: () => {
  onboarding.open('browser');
  const heading = $('browserAllowedSites'); heading?.focus({ preventScroll: true }); heading?.scrollIntoView({ block: 'start' });
} });

/** ホストのファイルをパスのまま添付に積む（送らない。ファイルプレビューの「会話で使う」とホストのファイルの面）。積めたら true */
function attachHostFiles(files, o) {
  return chatAttach.attachHost(files, o);
}
$("prompt").addEventListener("input", saveDraftSoon);
$("prompt").addEventListener("blur", flushDraft);
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") flushDraft(); });
addEventListener("pagehide", () => saveDraft().catch(() => {}));

// ---------------------------------------------------------------- 添付
// present の逆方向。AI が人間に見せるのと同じ流れに、人間からも置けるようにする（設計メモ §7）。
// 添付は字の欄の、置いた位置の 1 行の印（[添付] パス）として持つ（web/md-editor.mjs、ADR 0060）。state.attached が添付の実体
// （パス・名前・出どころ）、文中の位置は本文が持つ。文中に無い添付（古い下書き・平文の間に足したもの）は「文末に付く」で、
// 送るときに末尾へ印を足す。会話に載るのは送信のとき（runTurn の attachments → present）。
// 札・入口・一覧・送っている途中のものは入力欄の部品（web/composer/attachments.mjs の chatAttach）が持つ。

/** 添付で出どころを選ばせるか（null ならクリップはすぐファイルを選ぶ）。composer-layout.mjs の attachSources */
const currentAttachSources = () => attachSources({ remote: window.plyRemote, osActions: state.hostCaps?.osActions });

const attachedKey = (path) => `p:${normalizeAttachmentPath(path)}`;
const attachedByPath = (path) => chatAttach.byPath(path);
/** 添付の印の言語（会話の言語。まだ決まっていない会話は画面の言語） */
const composerAgentLang = () => state.sessions.find(s => s.id === state.current)?.agentLocale ?? uiLang;

/**
 * この会話の、まだ届いていない添付（送信中・失敗）。札を外した（やめた）ものは数えない。
 * 新しい会話を作っている間（state.current が null）に始めたものは持ち主が null で、会話ができたら adoptUploads がその id へ付け替える
 */
function uploadsHere() {
  return chatAttach.here();
}
/**
 * 新しい会話の欄（持ち主が null）で始めた添付の持ち主を、できた会話 id にする。会話を開く（select の fresh）のと同時に呼ぶので、
 * 作成中から作成後へ変わる間も「送っている途中の添付がある」判定（uploadsHere・uploadBlockReason）が途切れない
 */
function adoptUploads(id) {
  chatAttach.adoptOwner(null, id);
}
/** 送れない理由（送信中・失敗の添付があるとき）。無ければ null */
function uploadBlockReason() {
  return chatAttach.blockReason();
}
/** 添付を字の欄の位置の順に並べる。文中に無いものは後ろ（文末に付く） */
function orderedAttachments() {
  return chatAttach.ordered();
}
/** 添付の入口「添付 N 件 ▾」を描き直す（字の欄の上の 1 行。0 件なら出さない）。描いた後に送信ボタンの状態を合わせる */
function renderAttached() {
  chatAttach.render();
}
function flashAttachEntry() {
  chatAttach.flash();
}
/**
 * 送っている間に別の会話へ移った添付を、その会話の下書きに積む（位置は持たない: 文末に付く）。"" は持ち主の会話が無い欄の下書き。
 * 保存できなければ例外のまま返す（部品が札を消さず、本当の理由つきの失敗にする）
 */
async function adoptAttachment(owner, item) {
  const key = owner ?? "";
  const draft = state.drafts.get(key) ?? { text: "", attached: [] };
  await persistDraft(key, { ...draft, attached: [...(draft.attached ?? []), item], version: 2, dirty: true });
}

// 切れている間に待っている断片の送り手。ready で起こす（attach-upload.mjs の online）
const onlineWaiters = new Set();
function whenOnline(err) {
  if (ws?.readyState === WebSocket.OPEN) return Promise.reject(err);   // 切れたのではない失敗
  return new Promise((res, rej) => {
    const done = () => { clearTimeout(timer); onlineWaiters.delete(done); res(); };
    const timer = setTimeout(() => { onlineWaiters.delete(done); rej(err); }, 120_000);
    onlineWaiters.add(done);
  });
}

/**
 * 画像を大きく見る。会話の present・生成画像・本文の画像も入力欄の添付も同じ。
 * 下端に所在（フルパスとコピー）と操作（右パネルで開く・エクスプローラーで表示・保存）を並べる。
 * パスが分からない画像（data URI だけ）は保存だけ。origin は会話の中の元の画像（発言の時刻で相対パスを解く）
 */
let lightboxFile = null;
function openLightbox(src, caption, path, origin) {
  const d = $("lightbox");
  d.querySelector("img").src = src;
  d.querySelector(".lb-cap").textContent = caption ?? "";
  lightboxFile = path ? { path, element: origin ?? null } : null;
  const where = d.querySelector(".lb-path");
  where.hidden = !path;
  d.querySelector(".lb-path-text").textContent = path ?? "";
  d.querySelector(".lb-path-text").title = path ?? "";
  d.querySelector(".lb-panel").hidden = !path;
  d.querySelector(".lb-reveal").hidden = !path || state.osActions !== true;
  const save = d.querySelector(".lb-save");
  const name = (path ?? caption ?? "image").split(/[\\/]/).at(-1) || "image";
  // 絶対パスは認証付きの /local-file?download=1、パスの無い画像は data URI をそのまま保存する
  const absolute = path && /^(?:[a-z]:[\\/]|\/)/i.test(path);
  save.hidden = !absolute && !/^data:image\//.test(src);
  save.onclick = (e) => { e.preventDefault(); download(absolute ? fileDownloadUrl(path) : src, name); };
  d.showModal();
}

/** この端末のファイルを添付として送る（ドロップ・貼り付け・クリップの「ファイル…」）。web/composer/attachments.mjs の attachFiles */
function attachFiles(files, o) {
  return chatAttach.attachFiles(files, o);
}
/**
 * 入力欄の高さの上限を決める。1 行から始めて中身に合わせて伸び（CSS）、上限はマウス 10 行・タッチ 6 行（promptMaxLines）。
 * その先は欄の中でスクロールする（送信の行は常に見える）。画面が低いとき（キーボードが出ている）は画面の 40% でも止める
 */
function fitPrompt() {
  chatComposer.fit();
}

function wireDropZone() {
  // クリップ → 隠した file input。選んだものはドロップ・貼り付けと同じ列に入る。
  // 出どころを選べる接続（リモートの窓・ホストの画面ではないブラウザー）では「この端末から / ホストから」のメニュー（web/attach-menu.mjs）
  attachMenu = setupAttachMenu({
    button: $("attach"), sources: currentAttachSources, upload: folderUpload, pickFiles: () => $("fileIn").click(), recent: cwdOptions, cmd,
    hostName: () => remoteInfo(window.plyRemote)?.host ?? state.hostCaps?.hostName ?? "",
    startDir: () => state.cwd.trim(),
    attachHost: (files) => { if (attachHostFiles(files)) $("prompt").focus(); },
  });
  // クリップを押す前の字の欄の位置を覚える（メニューやファイルの選択でフォーカスが移っても、そこへ札を置く）
  $("attach").addEventListener("pointerdown", chatAttach.rememberAt, true);
  $("attach").addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") chatAttach.rememberAt(); }, true);
  $("attach").addEventListener("click", () => { if (!currentAttachSources()) $("fileIn").click(); });
  syncAttachButton();
  $("fileIn").onchange = () => { attachFiles([...$("fileIn").files]); $("fileIn").value = ""; };
  // 会話に載った画像も同じライトボックスで大きく見る
  const zoomImage = (e) => {
    const zoom = e.target.closest(".msg-att-zoom");
    const img = zoom ? zoom.querySelector("img") : e.target.closest(".present-body > img, .tc-preview > img, .md-img");
    if (img) openLightbox(img.src, img.alt, img.dataset.filePath, img);
  };
  log.addEventListener("click", zoomImage);
  // サブエージェントの会話（作業のダイアログ）の画像も。ライトボックスはダイアログの上に重なる
  $("workBody").addEventListener("click", zoomImage);
  const lb = $("lightbox");
  lb.addEventListener("click", (e) => {
    if (e.target === lb || e.target.closest("[data-close]")) lb.close();
  });
  lb.querySelector(".lb-copy").onclick = (e) => copyText(e.currentTarget, lightboxFile?.path ?? "", t("files.menu.copyPath"));
  lb.querySelector(".lb-panel").onclick = () => {
    const target = lightboxFile;
    if (!target) return;
    lb.close();
    // 作業のダイアログの画像なら、ダイアログも閉じないと右パネルがその裏に隠れる
    target.element?.closest("dialog[open]")?.close();
    filePreview.open({ path: target.path, line: null }, target.element?.isConnected ? target.element : null);
  };
  lb.querySelector(".lb-reveal").onclick = () => { if (lightboxFile) filePreview.reveal(lightboxFile); };
  const zone = document.querySelector("main");
  let depth = 0;
  const show = (on) => zone.classList.toggle("dropping", on);
  // Channels の画面（#channelsView）に落としたファイルは、そこの入力欄（web/channels/ch-attachments.mjs）が受ける。Chats の入力欄へは入れない
  // （受け口の無い所へ落としたときも、ブラウザーがファイルを開いて画面を離れないよう、既定の動作だけは止める）
  const inChannels = (e) => Boolean(e.target?.closest?.("#channelsView"));
  zone.addEventListener("dragenter", (e) => {
    if (![...e.dataTransfer.types].includes("Files")) return;
    e.preventDefault();
    if (!inChannels(e)) { depth++; show(true); }
  });
  zone.addEventListener("dragover", (e) => {
    if (![...e.dataTransfer.types].includes("Files")) return;
    e.preventDefault();
    if (!inChannels(e)) e.dataTransfer.dropEffect = "copy";
  });
  zone.addEventListener("dragleave", () => { if (--depth <= 0) { depth = 0; show(false); } });
  zone.addEventListener("drop", (e) => {
    if (!e.dataTransfer.files?.length) return;
    e.preventDefault();
    if (inChannels(e)) return;
    depth = 0; show(false);
    // リモートの窓にフォルダーを落としたら、添付するか作業フォルダーとして送るかを聞く。
    // webkitGetAsEntry はイベントの中でしか読めないので、先に取っておく
    if (folderUpload) {
      const entries = [...e.dataTransfer.items].map((i) => (i.kind === "file" ? i.webkitGetAsEntry?.() : null)).filter(Boolean);
      if (entries.some((x) => x.isDirectory)) { dropFolder(entries); return; }
    }
    // 字の欄の上に落としたら、その位置へ。それ以外はキャレットの位置
    attachFiles([...e.dataTransfer.files], { at: composerEditor.posFromPoint(e.clientX, e.clientY) });
  });
  // 貼り付けで渡すファイル（スクショを撮ってそのまま貼る動線）は、部品が字の欄で受ける（chatAttach.bind）
}

/** リモートの窓に落としたフォルダー（最初のフォルダーを送る。添付はフォルダーの中のファイルと、一緒に落としたファイル） */
async function dropFolder(entries) {
  const dir = entries.find((x) => x.isDirectory);
  let picked;
  try { picked = await entriesFromDirectory(dir); }
  catch (e) { composerError(t("upload.dropFailed", { error: e?.message ?? String(e) })); return; }
  const excludes = folderUpload.state.excludes;
  const sum = summarize(picked.entries, excludes);
  const choice = await askDroppedFolder({ name: picked.name, files: sum.files, bytes: sum.bytes, excludes });
  if (choice === "send") {
    if (folderUpload.busy) { composerError(t("upload.busy")); attachMenu?.openUpload(); return; }
    folderUpload.choose(picked, { makeCwd: true });
    attachMenu?.openUpload();
  } else if (choice === "attach") {
    const loose = await Promise.all(entries.filter((x) => x.isFile).map((x) => new Promise((res) => x.file(res, () => res(null)))));
    attachFiles([...sum.included.map((x) => x.file), ...loose.filter(Boolean)]);
  }
}

// ---------------------------------------------------------------- 右クリックのメニュー
// サブメニューはホバーで右へ展開。端では左へ返し、クリックとキーボードでも辿れる。

const contextMenu = createContextMenu();
const closeMenu = () => contextMenu.close();
function showMenu(x, y, items, title, opts) { side.closePops(); return contextMenu.open(x, y, items, title, opts); }

/** クリップボードへ写し、結果を脇の帯に出す（脇の行のメニューの操作）。done / failed は出す文 */
const copy = (text, done, failed) => {
  navigator.clipboard?.writeText(String(text ?? ""))
    .then(() => sideNote(done, { failed: false }))
    .catch(() => sideNote(failed));
};

function setStatusOf(sessionId, status) {
  const s = state.sessions.find((x) => x.id === sessionId);
  if (s) return changeStatus(s, status);
  cmd("setStatus", { sessionId, status, reasonKey: "menu" })
    .catch((e) => sideNote(t("session.statusFailed", { error: e.message })));
}

// ---------------------------------------------------------------- グループ（fork のまとまり、§4.1）
// グループは持ち物ではなく、親子・状態・「人が外した印」から決まる。だから操作は 2 つしかない:
// 状態を変える（setStatus）と、外した印を付け外しする（setGrouped）。
// 状態が黙って動く操作なので、どれも脇の下に「元に戻す」を出す。

const rowLabel = (s) => (s.title && s.title !== "(no title)" ? s.title : t("session.untitled"));
const statusWord = (st) => st || t("session.status.none");
const pendingRows = new Map();
const pendingPatches = new Map();
const pendingStatuses = new Map();
const pendingStatusRenames = new Map();
const pendingDeletedRows = new Map();

function pendingAfterDelay(entry, repaint = renderSessions) {
  const timer = setTimeout(() => { entry.visible = true; repaint(); }, 150);
  return () => clearTimeout(timer);
}

/** Keep local changes while an older listSessions response is in flight. */
function applyPendingPatches(sessions) {
  return overlaySessions(sessions, pendingPatches, pendingDeletedRows);
}
function applyPendingStatuses(statuses) {
  return statuses.map(s => pendingStatusRenames.has(s.status) ? { ...s, status: pendingStatusRenames.get(s.status) } : s);
}

async function sidebarChange({ rows, patches, kind = 'move', run, success, retry }) {
  rows = currentRows(rows, state.sessions);
  if (rows.some(row => pendingRows.has(row.id))) return;
  side.showUndo(null);
  const before = snapOf(rows);
  const label = kind === 'delete' ? t('pending.deleting') : t('pending.moving');
  for (const row of rows) {
    const patch = patches.get(row.id) ?? {};
    pendingPatches.set(row.id, patch);
    Object.assign(row, patch);
    pendingRows.set(row.id, { kind, text: label, visible: false });
  }
  renderSessions();
  const timers = rows.map(row => pendingAfterDelay(pendingRows.get(row.id)));
  try {
    await run();
    await refresh().catch(() => {});
    for (const row of rows) { pendingPatches.delete(row.id); pendingRows.delete(row.id); }
    renderSessions();
    if (success) side.showUndo(success, () => restore(before));
  } catch (e) {
    for (const row of rows) { pendingPatches.delete(row.id); pendingRows.delete(row.id); }
    state.sessions = rollbackSessions(state.sessions, before);
    renderSessions();
    for (const row of rows) document.querySelector(`[data-session="${CSS.escape(row.id)}"]`)?.classList.add('pending-bounce');
    await restoreServer(before).catch(() => {});
    await refresh().catch(() => {});
    side.showUndo(t('pending.failed', { reason: e.message }), retry, { retry: true });
  } finally { timers.forEach(cancel => cancel()); }
}

/** 取り消し用に、触る前の状態と所属を覚える */
const snapOf = (rows) => rows.map((s) => ({ sessionId: s.id, status: s.status ?? "", ungrouped: Boolean(s.ungrouped) }));

/** 覚えた通りに戻す。1 本ずつ戻すので、途中の伝播（根を動かすと中も動く）は起こさない。failed(エラー文) は失敗の一行（HTML） */
function restoreServer(before) {
  return Promise.all(before.map(async (b) => {
    await cmd("setStatus", { sessionId: b.sessionId, status: b.status, reasonKey: "undo", alone: true });
    await cmd("setGrouped", { sessionId: b.sessionId, ungrouped: b.ungrouped });
  }));
}
function restore(before) {
  restoreServer(before).then(refresh).catch((e) => side.showUndo(t('pending.failed', { reason: e.message }), () => restore(before), { retry: true }));
}

/** その行と同じグループに居る行（描画と同じ規則。web/family.mjs） */
function groupOf(root) {
  const fam = familiesOf(state.sessions, state.sessions).find((f) => f.root.id === root.id);
  return fam ? [fam.root, ...fam.kin] : [root];
}

/**
 * 行の状態を変える。グループの根なら、まとまりごと移る（サーバが根の移動として広げる）。
 * 中の行なら、その 1 本だけが出る。どちらも脇の下に「元に戻す」を出す
 */
function changeStatus(s, status) {
  const fam = familiesOf(state.sessions, state.sessions).find((f) => f.kin.length && f.root.id === s.id);
  if (fam) return moveGroup(s, status);
  const wasIn = familiesOf(state.sessions, state.sessions).some((f) => f.kin.some((k) => k.id === s.id));
  return sidebarChange({ rows: [s], patches: new Map([[s.id, { status }]]),
    run: () => cmd("setStatus", { sessionId: s.id, status, reasonKey: "manual" }),
    success: wasIn ? t("session.undo.statusLeft", { title: rowLabel(s), status: statusWord(status) }) : t("session.undo.status", { title: rowLabel(s), status: statusWord(status) }),
    retry: () => changeStatus(s, status) });
}

/** グループごと別の状態へ。中の会話も一緒に動く（サーバが根の移動として広げる） */
function moveGroup(root, status) {
  const rows = groupOf(root);
  return sidebarChange({ rows, patches: new Map(rows.map(s => [s.id, { status }])),
    run: () => cmd("setStatus", { sessionId: root.id, status, reasonKey: "groupMove" }),
    success: t("session.undo.groupMoved", { title: rowLabel(root), status: statusWord(status), count: rows.length }),
    retry: () => moveGroup(root, status) });
}

/** グループから外す / 戻す。外すだけなら状態は動かさない */
function setGrouped(s, ungrouped) {
  return sidebarChange({ rows: [s], patches: new Map([[s.id, { ungrouped }]]),
    run: () => cmd("setGrouped", { sessionId: s.id, ungrouped }),
    success: ungrouped ? t("session.undo.left", { title: rowLabel(s) }) : t("session.undo.rejoined", { title: rowLabel(s) }),
    retry: () => setGrouped(s, ungrouped) });
}

/** そのグループへ入れる。状態を根に合わせるところまでが 1 つの操作 */
function joinGroup(s, root) {
  s = state.sessions.find(row => row.id === s.id) ?? s;
  root = state.sessions.find(row => row.id === root.id) ?? root;
  const rows = groupOf(s);
  return sidebarChange({ rows, patches: new Map(rows.map(row => [row.id, { status: root.status ?? '', ungrouped: false }])),
    run: async () => { await cmd("setGrouped", { sessionId: s.id, ungrouped: false }); await cmd("setStatus", { sessionId: s.id, status: root.status ?? "", reasonKey: "joinGroup" }); },
    success: t("session.undo.joined", { title: rowLabel(s), group: rowLabel(root), status: statusWord(root.status) }),
    retry: () => joinGroup(s, root) });
}

/** グループを解除する。中の会話は独立した行になり、状態はそのまま */
function ungroupFamily(root, members) {
  return sidebarChange({ rows: members, patches: new Map(members.map(m => [m.id, { ungrouped: true }])),
    run: () => Promise.all(members.map(m => cmd("setGrouped", { sessionId: m.id, ungrouped: true }))),
    success: t("session.undo.ungrouped", { title: rowLabel(root), count: members.length }),
    retry: () => ungroupFamily(root, members) });
}

/** 散らばっている枝をまとめてグループにする。状態は根に揃える */
function gatherKin(root, loose) {
  root = state.sessions.find(row => row.id === root.id) ?? root;
  loose = loose.map(m => state.sessions.find(row => row.id === m.id) ?? m);
  const rows = [root, ...loose];
  const different = new Set(rows.filter(m => (m.status ?? null) !== (root.status ?? null)).map(m => m.id));
  return sidebarChange({ rows, patches: new Map(rows.map(m => [m.id, { ungrouped: false, status: root.status ?? '' }])),
    run: () => Promise.all(rows.map(async (m) => {
    await cmd("setGrouped", { sessionId: m.id, ungrouped: false });
    if (different.has(m.id)) {
      await cmd("setStatus", { sessionId: m.id, status: root.status ?? "", reasonKey: "mergeBranches", alone: true });
    }
  })), success: t("session.undo.gathered", { title: rowLabel(root), count: loose.length, status: statusWord(root.status) }),
    retry: () => gatherKin(root, loose) });
}

/** その行の系譜（fork でつながった会話。グループに入っているかどうかは見ない） */
function kinOf(s) {
  const byId = new Map(state.sessions.map((r) => [r.id, r]));
  const rootOf = (r) => {
    let cur = r;
    const seen = new Set([r.id]);
    for (let i = 0; i < 64; i++) {
      const p = cur.parent?.sessionId;
      if (!p || seen.has(p) || !byId.has(p)) break;
      seen.add(p);
      cur = byId.get(p);
    }
    return cur;
  };
  const root = rootOf(s);
  return { root, all: state.sessions.filter((r) => rootOf(r).id === root.id) };
}

/** 行の右クリックに出すグループの項目。当てはまらないときは何も出さない */
function groupItems(s) {
  const fams = familiesOf(state.sessions, state.sessions);
  const mine = fams.find((f) => f.kin.length && (f.root.id === s.id || f.kin.some((k) => k.id === s.id)));
  if (mine && mine.root.id === s.id) {
    const members = [mine.root, ...mine.kin];
    return [{ label: t("session.menu.ungroup"), hint: t("session.menu.count", { count: members.length }), onClick: () => ungroupFamily(mine.root, members) }];
  }
  if (mine) return [{ label: t("session.menu.leaveGroup"), hint: t("session.menu.keepStatus"), onClick: () => setGrouped(s, true) }];
  // 外に居る行。入れる先（同じ系譜にできているグループ）があれば入れる、無ければ枝をまとめる
  const { root, all } = kinOf(s);
  if (all.length < 2) return [];
  const host = fams.find((f) => f.kin.length && all.some((r) => r.id === f.root.id));
  if (host) return [{ label: t("session.menu.joinGroup", { title: rowLabel(host.root) }), hint: t("session.menu.joinStatus", { status: statusWord(host.root.status) }),
    onClick: () => joinGroup(s, host.root) }];
  const loose = all.filter((r) => r.id !== root.id);
  return [{ label: t("session.menu.gather"), hint: t("session.menu.count", { count: loose.length }), onClick: () => gatherKin(root, loose) }];
}

/** グループの見出しの右クリック。解除と、まとまりごとの状態変更 */
function familyMenu(root, members, x, y) {
  const known = [...new Set(state.sessions.map((z) => z.status).filter(Boolean))];
  showMenu(x, y, [
    { label: t("session.menu.ungroup"), hint: t("session.menu.count", { count: members.length }), onClick: () => ungroupFamily(root, members) },
    { sep: true },
    { label: t("session.menu.groupStatus"), hint: statusWord(root.status), sub: () => [
      { input: { placeholder: t("session.menu.newStatus"), onCommit: (v) => moveGroup(root, v) } },
      ...known.map((k) => ({ label: k, hint: t("session.menu.count", { count: members.length }), checked: k === root.status, onClick: () => moveGroup(root, k) })),
      { sep: true },
      { label: t("session.menu.clearStatus"), onClick: () => moveGroup(root, "") },
    ] },
    { sep: true },
    { label: t("session.menu.openRoot"), hint: rowLabel(root), onClick: () => select(root.id) },
  ], t("session.menu.groupTitle", { title: rowLabel(root) }));
}

/** 会話を消す。未送信は deleteUnsentSession、送った会話は deleteSession（sessions.delete。ADR 0147） */
async function deleteSessionRow(s, command = 'deleteUnsentSession') {
  const pending = { kind: 'delete', text: t('pending.deleting'), visible: false };
  pendingRows.set(s.id, pending);
  pendingDeletedRows.set(s.id, s);
  renderSessions();
  const cancel = pendingAfterDelay(pending);
  try {
    await cmd(command, { sessionId: s.id });
    state.drafts.delete(s.id);
    try { localStorage.setItem(DRAFT_STORE, JSON.stringify([...state.drafts])); } catch {}
    const row = document.querySelector(`[data-session="${CSS.escape(s.id)}"]`);
    if (row) { row.style.height = `${row.offsetHeight}px`; row.getBoundingClientRect(); row.classList.add('pending-gone'); await new Promise(resolve => setTimeout(resolve, 240)); }
    pendingRows.delete(s.id); pendingDeletedRows.delete(s.id);
    state.sessions = state.sessions.filter(row => row.id !== s.id);
    renderSessions();
    await refresh().catch(() => {});
  } catch (e) {
    pendingRows.delete(s.id); pendingDeletedRows.delete(s.id);
    await refresh().catch(() => {});
    renderSessions();
    document.querySelector(`[data-session="${CSS.escape(s.id)}"]`)?.classList.add('pending-bounce');
    side.showUndo(t('pending.failed', { reason: e.message }), () => deleteSessionRow(s, command), { retry: true });
  } finally { cancel(); }
}

/**
 * 会話の操作のメニュー（脇の行の右クリック・「…」・タイトル行の「…」）。lead はメニューの頭に足す項目
 * （タイトル行の「…」の 700px 以下: タイトルを生成・ホスト一覧に戻る）
 */
function rowMenu(s, x, y, lead = []) {
  let vocab = null, efforts = null, endpoints = null, accounts = null;
  let waitingVisible = false;
  const known = [...new Set(state.sessions.map((z) => z.status).filter(Boolean))];
  // 枝の行き来。親があるか子がある行だけ。家族は開いている間に取り寄せる（メニューは同期で組む）
  const hasKin = Boolean(s.parent?.sessionId) || state.sessions.some((z) => z.parent?.sessionId === s.id);
  let kin = null;
  if (hasKin) cmd("lineage", { sessionId: s.id }).then((r) => { kin = r; }).catch(() => {});
  const kinItems = () => !kin ? [{ label: t("session.menu.loading") }]
    : kin.sessions.map((r) => ({ label: r.title && r.title !== "(no title)" ? r.title : t("session.untitled"),
        hint: r.id === s.id ? t("session.menu.thisRow") : r.parent?.sessionId ? t("session.menu.branch") : t("session.menu.root"), checked: r.id === state.current, onClick: () => select(r.id) }));
  const paint = () => {
  const mode = vocab ? selectedMode(s, s.nextSettings?.backend ?? s.backend, vocab.modes) : '';
  const items = [
    ...lead, ...(lead.length ? [{ sep: true }] : []),
    // 頭の「…」（開いている会話。先頭に「開く」の見出しを足したとき）では、同じ語の「開く」（この会話を開く）を出さない
    ...(lead.length && s.id === state.current ? [] : [{ label: t("session.menu.open"), onClick: () => select(s.id) }]),
    ...(s.parent?.sessionId ? [{ label: t("session.menu.openParent"), hint: sessionLabel(s.parent.sessionId).slice(0, 20), onClick: () => select(s.parent.sessionId) }] : []),
    ...(hasKin ? [{ label: t("session.menu.branches"), sub: kinItems }] : []),
    { label: t("session.menu.rename"), sub: () => [
      { input: { placeholder: t("session.menu.newTitle"), value: s.title === "(no title)" ? "" : s.title, onCommit: (v) =>
        cmd("setTitle", { sessionId: s.id, title: v, reasonKey: "menu" })
          .catch((e) => sideNote(t("session.titleFailed", { error: e.message }))) } },
    ] },
    { label: t('compaction.compact'), disabled: !capsOf(s.backend).compact,
      note: !capsOf(s.backend).compact ? t('compaction.antigravityManaged') : '',
      onClick: () => cmd('compactConversation', { sessionId: s.id }).catch(error => showRowCompactionError(s, error)) },
    ...(s.backend === 'antigravity' ? [] : [{ label: t('compaction.disableConversation'), checked: Boolean(s.autoCompactionOff),
      onClick: () => cmd('setConversationAutoCompaction', { sessionId: s.id, off: !s.autoCompactionOff })
        .then(({ off }) => { s.autoCompactionOff = off; renderSessions(); }).catch(error => showRowCompactionError(s, error, true)) }]),
    { label: t("session.menu.changeStatus"), hint: s.status ?? t("session.status.none"), sub: () => [
      { input: { placeholder: t("session.menu.newStatus"), onCommit: (v) => setStatusOf(s.id, v) } },
      ...known.map((k) => ({ label: k, checked: k === s.status, onClick: () => setStatusOf(s.id, k) })),
      { sep: true },
      { label: t("session.menu.clearStatus"), onClick: () => setStatusOf(s.id, "") },
    ] },
    // 会話の設定を誰がいつ変えたか（AI が変えた状態・タイトルもここで辿れる。会話の中には行を出さない。ADR 0067）
    { label: t("changeLog.menu"), onClick: () => showChangeLog(s) },
    ...(capsOf(s.backend).fork === false ? [] : [{ label: t("session.menu.forkTail"), onClick: () => forkTail(s.id) }]),
    ...groupItems(s),
    { sep: true },
    { label: t("session.menu.mode"), pending: !vocab && waitingVisible, hint: vocab?.modes[mode]?.label ?? mode, sub: () =>
      Object.entries(vocab?.modes ?? {}).map(([id, m]) => ({
        label: m.label, hint: m.note, checked: id === mode,
        onClick: () => (s.nextSettings?.backend && s.nextSettings.backend !== s.backend
          ? cmd("setTurnSettings", { sessionId: s.id, backend: s.nextSettings.backend, mode: id, rememberMode: true })
          : cmd("setMode", { sessionId: s.id, mode: id, reasonKey: "menu" }))
          .then(refresh).catch((e) => sideNote(t("session.menu.modeFailed", { error: e.message }))),
      })) },
    // 名前は版付き（入力欄のチップと同じ）。「既定に従う」には実際に当たるモデルを添える。隠した別名は選んでいるときだけ。
    // 段違いを系統にまとめた一覧（antigravity）は系統ごとに 1 行（composer-labels.mjs の modelRowIds）
    { label: t("session.menu.model"), pending: !vocab && waitingVisible, hint: vocab ? (endpointOf(s) && (s.nextSettings?.model ?? s.model) ? compatModelText(s.nextSettings?.model ?? s.model) : resolvedModel(vocab.models, s.nextSettings?.model ?? s.model ?? "").label) : '', sub: () =>
      Object.entries(vocab?.models ?? {}).filter(([id]) => id === "" || modelRowIds(vocab.models, s.nextSettings?.model ?? s.model ?? "").includes(id)).map(([id, m]) => ({
        label: id === "" && m.resolvesTo ? `${m.label}（${vocab?.models[m.resolvesTo]?.label ?? m.resolvesTo}）` : m.label,
        hint: m.note, checked: id === (s.nextSettings?.model ?? s.model ?? ""),
        onClick: () => cmd("setTurnSettings", { sessionId: s.id, backend: s.nextSettings?.backend ?? s.backend, model: id, rememberModel: true })
          .then(refresh).catch((e) => sideNote(t("session.menu.modelFailed", { error: e.message }))),
      })) },
    ...(endpoints ?? (capsOf(s.nextSettings?.backend ?? s.backend).compatEndpoints ? [{ label: t('session.menu.endpoint'), pending: waitingVisible, sub: () => [] }] : [])),
    ...(accounts ?? (capsOf(s.nextSettings?.backend ?? s.backend).claudeAccounts ? [{ label: t('session.menu.account'), pending: waitingVisible, sub: () => [] }] : [])),
    { sep: true },
    { label: t("session.menu.effort"), pending: !efforts && waitingVisible, hint: efforts ? ((s.nextSettings?.effort ?? s.effort) || efforts[""]?.resolvesTo || t("chat.model.default")) : '', sub: () =>
      Object.entries(efforts ?? {}).map(([effort, m]) => ({
        label: effort === "" && m.resolvesTo ? `${m.label}（${m.resolvesTo}）` : m.label,
        hint: m.note, checked: effort === (s.nextSettings?.effort ?? s.effort ?? ""),
        onClick: () => cmd("setTurnSettings", { sessionId: s.id, effort, rememberEffort: true })
          .then(refresh).catch(e => sideNote(t("session.menu.effortFailed", { error: e.message }))),
      })) },
    // 480px 以下は「…」の先頭の「開く」行に出す（sessionMoreLead）
    ...(s.id === state.current && narrowView.matches && !phoneView.matches && state.git.data ? [{ label: t('git.entry'), hint: branchLabel(state.git.data), onClick: () => gitPanel?.open($('sessionMore')) }] : []),
    { label: t("session.menu.copyCwd"), hint: s.cwd ?? "", onClick: () => copy(s.cwd, t("session.menu.cwdCopied"), t("session.menu.cwdCopyFailed")) },
    { label: t("session.menu.copyId"), onClick: () => copy(s.id, t("session.menu.idCopied"), t("session.menu.idCopyFailed")) },
    ...(s.unsent ? [{ label: t("session.menu.deleteUnsent"), sub: () => [
      { label: t("session.menu.deleteWithDraft"), onClick: () => deleteSessionRow(s) },
    ] }] : [{ label: t("session.menu.delete"), onClick: () => confirmDeleteSession(s, x, y) }]),
  ];
  return items;
  };
  const title = s.title && s.title !== "(no title)" ? s.title : t("session.untitled");
  const update = showMenu(x, y, paint(), title);
  const repaint = () => update(paint(), title);
  setTimeout(() => { waitingVisible = true; repaint(); }, 150);
  const bid = s.nextSettings?.backend ?? s.backend;
  (async () => { try { vocab = await loadVocab(bid); } catch { vocab = { modes: {}, models: {} }; } repaint(); })();
  cmd("efforts", { backend: bid, model: s.nextSettings?.model ?? s.model ?? "", cwd: s.nextSettings?.cwd || s.cwd || undefined })
    .then(value => { efforts = value; repaint(); }).catch(() => { efforts = {}; repaint(); });
  rowEndpointItems(s).then(value => { endpoints = value; repaint(); });
  rowAccountItems(s).then(value => { accounts = value; repaint(); });
}

/** 脇の会話の行の「変更の記録」。会話の記録の history を、時刻・誰が・前 → 後・理由で並べる面を開く */
async function showChangeLog(s) {
  try {
    const { changes } = await cmd("sessionChanges", { sessionId: s.id });
    openChangeLog({ title: rowLabel(s), changes, anchor: document.querySelector(`[data-session="${CSS.escape(s.id)}"]`) });
  } catch (e) { sideNote(t("changeLog.failed", { error: e.message })); }
}

/** 「新しいグループを作る…」。その場に名前の欄が出て、Enter で作る。空のままでも一覧に残る（statuses.json） */
function newGroupItem() {
  return { label: t("session.menu.newStatusEllipsis"), sub: () => [
    { input: { placeholder: t("session.menu.statusName"), onCommit: (v) =>
      cmd("createStatus", { status: v }).then(refresh)
        .catch((e) => sideNote(t("session.menu.createStatusFailed", { error: e.message }))) } },
  ] };
}

async function changeStatusName(from, to) {
  const next = to.trim();
  if (!from || next === from || pendingStatuses.has(from) || pendingStatuses.has(next)) return;
  const rows = state.sessions.filter(s => s.status === from);
  const deleting = !next;
  const key = next || from;
  const pending = { from, to: next, done: 0, total: rows.length, visible: false,
    text: t(deleting ? 'pending.deletingProgress' : 'pending.movingProgress', { done: 0, total: rows.length }) };
  pendingStatuses.set(key, pending);
  if (!deleting) {
    pendingStatusRenames.set(from, next);
    state.statuses = applyPendingStatuses(state.statuses);
    for (const row of rows) { row.status = next; pendingPatches.set(row.id, { status: next }); }
  }
  renderSessions();
  const cancel = pendingAfterDelay(pending);
  try {
    await cmd('renameStatus', { from, to: next });
    if (deleting) {
      for (const row of rows) row.status = '';
      state.statuses = state.statuses.filter(s => s.status !== from);
    }
    await refresh().catch(() => {});
    pendingStatuses.delete(key); pendingStatusRenames.delete(from);
    for (const row of rows) pendingPatches.delete(row.id);
    renderSessions();
    if (deleting) side.showUndo(t('pending.deletedStatus', { status: from }));
  } catch (e) {
    pendingStatuses.delete(key); pendingStatusRenames.delete(from);
    for (const row of rows) pendingPatches.delete(row.id);
    await refresh().catch(() => {});
    renderSessions();
    side.showUndo(t('pending.failed', { reason: e.message }), () => changeStatusName(from, next), { retry: true });
  } finally { cancel(); }
}

/** 送った会話を消す前の確かめ。戻せないことと、エージェント側の会話の記録は残ることを書く（ADR 0147） */
function confirmDeleteSession(s, x, y) {
  const title = s.title && s.title !== "(no title)" ? s.title : t("session.untitled");
  showMenu(x, y, [
    { label: t('pending.cancel'), onClick: () => {} },
    { label: t('session.menu.deleteConfirm'), onClick: () => deleteSessionRow(s, 'deleteSession') },
  ], { text: t('pending.deleteSessionConfirm', { title }), wrap: true });
}

function confirmDeleteStatus(st, count, x, y) {
  showMenu(x, y, [
    { label: t('pending.cancel'), onClick: () => {} },
    { label: t('session.menu.deleteStatus'), onClick: () => changeStatusName(st, '') },
  ], { text: t('pending.deleteStatusConfirm', { status: st, count, destination: t('session.status.none') }), wrap: true });
}

function groupMenu(st, x, y) {
  if (st == null) return showMenu(x, y, [newGroupItem()], t("session.status.none"));
  const n = state.sessions.filter((s) => s.status === st).length;
  showMenu(x, y, [
    // 見出しの ＋ と同じ。キーボード（Shift+F10）からも届くように
    { label: t("sidebar.group.newSession"), onClick: () => side.newIn(st) },
    { label: t("session.menu.changeIcon"), hint: state.statuses.find((s) => s.status === st)?.icon ?? "", onClick: () => side.pickIcon(st) },
    { label: t("session.menu.renameStatus"), sub: () => [
      { input: { placeholder: t("session.menu.newName"), value: st, onCommit: (v) =>
        changeStatusName(st, v) } },
    ] },
    newGroupItem(),
    { sep: true },
    { label: t("session.menu.deleteStatus"), hint: n ? t("session.menu.deleteStatusHint", { count: n }) : t("session.menu.empty"),
      onClick: () => confirmDeleteStatus(st, n, x, y) },
  ], st);
}

// ---------------------------------------------------------------- 読み込んだコンテキスト
// タイトル行の入口と、共通読み込みの会話に残る一行（docs/design-system.md §9）。
// 出所はどちらも sessionContext の記録で、ターンの開始に届く contextUsage で更新する。

/** 設定のコンテキストのページ（全体の設定）を開く */
function openContextPage() {
  onboarding.open('context');
  context.openPage();
}
/** タイトル行の右の入口。押すと右パネル「この会話のコンテキスト」を開閉する。セッションを選んでいないときは出さない */
function paintContextEntry() {
  chromePanel?.reset(); chromeEntry?.paint();   // 会話が替わった: Chrome の窓の入口と、開いている別の会話の映像
  paintContextEntryButton($('contextEntry'), { visible: !!state.current, report: state.contextInfo?.report,
    summary: chipText(state.contextInfo), changed: !!state.contextInfo?.changed?.differs });
  paintMoreEntry();
}
/** 「…」の右上の変更ありの点。「…」へ逃がしたものだけを見る（480px 以下のプラグイン・700px 以下の git） */
function paintMoreEntry() {
  const button = $('sessionMore');
  const changed = (phoneView.matches && !!state.contextInfo?.changed?.differs) || (narrowView.matches && !!state.current && (state.git.data?.dirty ?? 0) > 0);
  const dot = button.querySelector('.entry-dot');
  if (changed && !dot) { const mark = el('span', 'entry-dot'); mark.setAttribute('aria-hidden', 'true'); button.append(mark); }
  else if (!changed) dot?.remove();
  button.setAttribute('aria-label', changed ? `${t('session.more')} · ${t('session.context.changed')}` : t('session.more'));
}
/** 今のセッションの読み込み記録を取り直す。固定された会話ではサーバが今のファイルと突き合わせる */
async function refreshContextEntry({ force = false } = {}) {
  const id = state.current;
  if (!id) {
    state.contextInfo = null;
    state.contextInfoId = null;
  } else if (force || state.contextInfoId !== id) {
    const info = await cmd('sessionContext', { sessionId: id }).catch(() => null);
    if (state.current !== id) return state.contextInfo;
    state.contextInfo = info;
    state.contextInfoId = id;
  } else return state.contextInfo;
  paintContextEntry();
  sessionContext.refresh();
  return state.contextInfo;
}

// ---------------------------------------------------------------- git の状態（ADR 0085）
// 頭の行のアイコン（コミットしていない変更があれば右上の点）・入力欄の作業場所のチップのブランチ・狭い画面の「…」の項目。
// 取り直しは、会話・作業場所が変わったとき、会話を開いたとき、ターンの終わり、パネルの再読み込み。git が無い・git 管理外は null（何も出さない）
let gitPanel = null;
let gitTicket = 0;
function paintGitEntry() {
  const button = $('gitEntry');
  const data = state.current ? state.git.data : null;
  paintMoreEntry();
  button.hidden = !data;
  if (!data) return;
  const dirty = data.dirty > 0;
  const label = dirty ? t('git.entryChanged') : t('git.entry');
  button.title = label;
  button.setAttribute('aria-label', label);
  const open = Boolean(gitPanel?.isOpen());
  button.classList.toggle('on', open);
  button.setAttribute('aria-expanded', String(open));
  const dot = button.querySelector('.entry-dot');
  if (dirty && !dot) { const mark = el('span', 'entry-dot'); mark.setAttribute('aria-hidden', 'true'); button.append(mark); }
  else if (!dirty && dot) dot.remove();
}
async function refreshGit({ force = false } = {}) {
  const sessionId = state.current ?? null;
  const s = state.sessions.find(x => x.id === sessionId);
  // 次のターンから別の作業場所へ変える予約があるときは、その場所（使ったことのある場所だけサーバーが通す）
  const reserved = Boolean(s && state.cwd && s.cwd && state.cwd !== s.cwd);
  const key = `${sessionId ?? ''}${String.fromCharCode(10)}${reserved || !sessionId ? state.cwd ?? '' : ''}`;
  if (!force && state.git.key === key) return;
  if (state.git.sessionId !== sessionId) { state.git.data = null; gitPanel?.reset(); paintGit(); }
  state.git.key = key; state.git.sessionId = sessionId;
  const mine = ++gitTicket;
  const res = await cmd('gitStatus', { ...(reserved || !sessionId ? { cwd: state.cwd } : { sessionId }), fresh: force }).catch(() => null);
  if (mine !== gitTicket) return;
  state.git.data = res?.git ?? null;
  paintGit();
}
function paintGit() { paintGitEntry(); controls.paint(); }

// ---------------------------------------------------------------- worktree（ADR 0089）
const normDir = (p) => String(p ?? '').replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase();
const insideDir = (dir, parent) => { const d = normDir(dir), p = normDir(parent); return Boolean(d && p) && (d === p || d.startsWith(`${p}/`)); };
/** 次のターンの予約の行の文。予約が worktree なら「worktree（短い名前）」、そうでなければ null（作業ディレクトリのパスのまま） */
function worktreeNextText(cwd) {
  const current = state.worktree.data?.current;
  return current && insideDir(cwd, current.path) ? t('worktree.next', { path: shortPath(current.path) }) : null;
}
/** チップと面の元になる worktreeCheck を取り直す（続けて呼ばれたら 1 回にまとめる） */
let worktreeTimer = 0;
function refreshWorktree() {
  clearTimeout(worktreeTimer);
  return new Promise((resolve) => { worktreeTimer = setTimeout(() => resolve(runWorktreeCheck()), 120); });
}
async function runWorktreeCheck() {
  const sessionId = state.current ?? null;
  if (!state.cwd) { state.worktree.data = null; paintWorktree(); return; }
  const mine = ++state.worktree.ticket;
  const res = await cmd('worktreeCheck', { ...(sessionId ? { sessionId } : {}), cwd: state.cwd, backend: state.shownBackend ?? activeBackendId(), mode: state.mode }).catch(() => null);
  if (mine !== state.worktree.ticket) return;
  state.worktree.data = res?.git ? res : null;
  paintWorktree();
}
function paintWorktree() { controls.paint(); paintSettingsNotice(); paintWorktreeLines(); }
/** ほかの会話が同じリポジトリに書き込み中なら、チップと面に知らせる。 */
function worktreeBusyPlan() {
  return busyPlan(state.worktree.data, { running: Boolean(state.current && state.runningIds.has(state.current)) });
}
/** worktree を作り、次のターンの作業場所に予約する（下書きなら作業場所をそれにする） */
async function startWorktree() {
  try {
    const res = await cmd('worktreeSplit', { ...(state.current ? { sessionId: state.current } : {}), cwd: state.cwd });
    await applyCwd(res.cwd);
    $('settingsError').textContent = '';
  } catch (e) { $('settingsError').textContent = t('worktree.splitFailed', { error: e.message }); }
  refreshWorktree().catch(() => {});
}
/** 元の場所へ戻す（次のターンから）。origin を言わなければ、今の worktree の元 */
async function backFromWorktree(origin = state.worktree.data?.current?.origin) {
  if (!origin) return;
  try { await applyCwd(origin); $('settingsError').textContent = ''; }
  catch (e) { $('settingsError').textContent = e.message; }
  refreshWorktree().catch(() => {});
}
/** 会話の中の「worktree で始めました」の行の今の状態。会話の cwd と次のターンの予約から決める */
function worktreeLineMode(note) {
  const s = state.sessions.find((x) => x.id === state.current);
  const actual = s?.cwd ?? state.cwd ?? '', reserved = s?.nextSettings?.cwd ?? '';
  if (!note?.path || !insideDir(actual, note.path)) return 'back';
  return reserved && !insideDir(reserved, note.path) ? 'backing' : 'here';
}
setWorktreeLineMode(worktreeLineMode);
function paintWorktreeLines() {
  for (const row of thread.querySelectorAll('.wt-line')) if (row.worktreeNote) paintWorktreeLine(row, worktreeLineMode(row.worktreeNote));
}
document.addEventListener('ply-worktree', (event) => {
  const { act, note } = event.detail ?? {};
  if (act === 'back') backFromWorktree(note?.origin);
  else if (act === 'again') startWorktree();
});
/** 右パネル「残っている worktree」の操作（web/worktree-ui.mjs の createLeftovers） */
const worktreeOps = {
  keep: (id, kept) => cmd('worktreeKeep', { id, kept }),
  // 取り込みを頼む: 取り込む役（委譲の子なら依頼元、人が分けた会話ならその会話）へ依頼文を送る
  ask: async (row) => {
    if (!row.mergeSessionId) return null;
    const title = state.sessions.find((s) => s.id === row.mergeSessionId)?.title ?? '';
    const messageId = randomId();
    await cmd('sendMessage', { sessionId: row.mergeSessionId, messageId, prompt: askText(row) });
    return { title: title === '(no title)' ? '' : title, messageId, sessionId: row.mergeSessionId };
  },
  unask: (sent) => cmd('messageAction', { sessionId: sent.sessionId, messageId: sent.messageId, action: 'cancel' }).then(() => true, () => false),
  archive: async (row) => { const res = await cmd('worktreeArchive', { id: row.id }); return res; },
  restore: (row, ref) => cmd('worktreeRestore', { ...(state.current ? { sessionId: state.current } : {}), ref }).then(() => true, () => false),
};
/** 会話の中のこの場所へ（ツールの行は畳まれたまとまりを開いて）。見つからなければ false。狭い画面は右パネルが全面なので閉じてから */
function jumpToConversation({ uuid, toolId }) {
  const card = toolId ? state.toolCards.get(toolId) : null;
  const message = uuid ? thread.querySelector(`.m[data-uuid="${CSS.escape(uuid)}"]`) : null;
  const target = card?.isConnected ? card : message;
  if (!target) return false;
  const bundle = card?.isConnected ? bundleOf(card) : null;
  let animated = false;
  if (bundle && !bundle.expanded && card !== bundle.cur) { bundle.reveal(card); animated = true; }
  for (let node = target.closest('details'); node; node = node.parentElement?.closest('details')) node.open = true;
  revealFold(target);
  if (narrowView.matches) filePreview.close(false);
  const row = target.closest('.mw') ?? target;
  if (animated) setTimeout(() => nav.scrollToRow(row, 90), 320); else nav.scrollToRow(row, 90);
  return true;
}
/** 「会話で使う」: 入力欄の末尾へ字を足す */
function useGitText(text) {
  const field = $('prompt');
  field.value = field.value ? `${field.value}${String.fromCharCode(10)}${text}` : text;
  field.dispatchEvent(new Event('input', { bubbles: true }));
  if (!narrowView.matches) field.focus();
}

// ---------------------------------------------------------------- 上部と入力欄の同期

let topbarVersion = 0;
/** 右クリックメニューのアカウント（入力欄と同じ選択肢。登録が無く、選んでもいなければ出さない） */
async function rowAccountItems(s) {
  if (!capsOf(s.nextSettings?.backend ?? s.backend).claudeAccounts) return [];
  const list = await claudeAccounts.load().catch(() => []);
  const value = s.nextSettings?.account ?? s.claudeAccount ?? "";
  if (!list.length && !value) return [];
  const choices = [{ value: "", label: t("chat.account.signedInAccount"), note: "" }, ...list.map((a) => ({ value: a.id, label: a.name, note: a.hasToken ? "" : t("chat.account.noToken") }))];
  return [{ label: t("session.menu.account"), hint: accountLabel(value), sub: () => choices.map((c) => ({
    label: c.label, hint: c.note, checked: c.value === value,
    onClick: () => cmd("setTurnSettings", { sessionId: s.id, account: c.value })
      .then(refresh).catch((e) => sideNote(t("session.menu.accountFailed", { error: e.message }))),
  })) }];
}

/**
 * 互換の接続先の会話で Web 検索が失敗したら、そのカードに理由を一文足す（画面 4）。
 * エージェントの失敗文だけでは接続先が原因だと分からないため。公式の会話では何もしない。
 * sessionId はカードのある会話（作業の詳細では子の会話。既定はメインパネルの会話）
 */
function noteEndpointFailure(card, result, sessionId = state.current) {
  if (!card || !(result?.isError ?? result?.is_error) || !/^(WebSearch|webSearch|web_search)$/.test(card.dataset?.tool ?? "")) return;
  const s = state.sessions.find((x) => x.id === sessionId);
  const e = s?.compatEndpoint ? compatEndpoints.get(s.compatEndpoint) : null;
  if (!e || card.querySelector(".tc-endpoint-note")) return;
  const note = el("p", "tc-endpoint-note", t("chat.endpoint.noWebSearch", { name: e.name }));
  const more = el("button", "clink", t("chat.endpoint.details")); more.type = "button";
  more.onclick = () => compatEndpoints.open(e.agent);
  note.append(" ", more);
  card.append(note);   // 畳んだ詳細（details）の外に置く。畳んでいても見える
}

/** 右クリックメニューの接続先（入力欄と同じ選択肢。接続先を選べるエージェントの会話だけ） */
async function rowEndpointItems(s) {
  const bid = s.nextSettings?.backend ?? s.backend;
  if (!capsOf(bid).compatEndpoints) return [];
  const list = (await compatEndpoints.load().catch(() => [])).filter((e) => e.agent === bid);
  const value = endpointOf(s);
  if (!list.length && !value) return [];
  const choices = [{ value: "", label: t("chat.endpoint.official"), note: "" }, ...list.map((e) => ({ value: e.id, label: e.name, note: e.ready === false ? t("chat.endpoint.failedNote") : "" }))];
  return [{ label: t("session.menu.endpoint"), hint: endpointLabel(value), sub: () => choices.map((c) => ({
    label: c.label, hint: c.note, checked: c.value === value,
    onClick: () => cmd("setTurnSettings", { sessionId: s.id, endpoint: c.value })
      .then(refresh).catch((e) => sideNote(t("session.menu.endpointFailed", { error: e.message }))),
  })) }];
}

// AI がタイトルを考えている会話。その間は欄に書き込ませず、途中で一覧が更新されても開け直さない
const titleGenerating = new Set();
function syncTitleControls() {
  const s = state.sessions.find((x) => x.id === state.current);
  const on = Boolean(state.current);
  const caps = capsOf(activeBackendId());
  const busy = on && titleGenerating.has(state.current);
  $("titleField").classList.toggle("generating", busy);
  $("titleEdit").disabled = !on || busy;
  $("titleEdit").setAttribute("aria-busy", String(busy));
  $("titleWand").classList.toggle("busy", busy);
  $("titleWand").hidden = caps.suggestTitle === false;
  $("titleWand").disabled = !on || busy || s?.unsent || caps.suggestTitle === false;
  // この会話の操作（脇の行の「…」と同じメニュー）。一覧に載っている会話だけ
  $("sessionMore").hidden = !s;
  paintContextEntry();
}
function selectedMode(s, bid, modes, chosen = null) {
  const prefs = (state.prefs.backends ? state.prefs.backends[bid] : state.prefs) ?? {};
  const mode = chosen?.mode ?? s?.nextSettings?.mode ?? (s?.backend === bid ? s.mode : prefs.mode);
  return mode in modes ? mode : "default" in modes ? "default" : Object.keys(modes)[0] ?? "";
}
async function syncTopbar() {
  syncParentEntry();
  homeDest.paint();
  const version = ++topbarVersion;
  const s = state.sessions.find((x) => x.id === state.current);
  const on = Boolean(state.current);
  const id = state.current;
  // 新しい会話の欄（まだ会話が無い）と、作ったばかりの会話（startNew が予約を流し終えるまで）は、そこで選んだ設定を見せる。
  // 流している途中に来た一覧の読み直しは書く前の予約を持つことがあり、そのまま見せるとチップが一瞬戻る（chooseSettings）
  const chosen = !s || justCreated() ? draftView(state.draft.changes) : null;
  const homeBot = unsentHere() ? homeDest.bot : null;
  const bid = homeBot?.backend ?? chosen?.backend ?? s?.nextSettings?.backend ?? activeBackendId();
  const caps = capsOf(activeBackendId());

  $("titleEdit").value = s?.title === "(no title)" ? "" : (s?.title ?? "");
  syncTitleControls();

  if (bid) state.shownBackend = bid;
  // 帯の使用量の札は、この会話（予約があれば次のターン）のエージェントとアカウントの枠を出す
  headerUsage.show({ backend: bid, account: homeBot ? '' : s?.nextSettings?.account ?? s?.claudeAccount ?? "", endpoint: homeBot ? '' : endpointOf(s) });

  // 予約があれば次のターンの作業場所を表示する。
  if (s) state.cwd = (justCreated() && state.draft.cwd) || (s.nextSettings?.cwd ?? s.cwd ?? state.homeDir ?? "");
  else if (state.draft.cwd) state.cwd = state.draft.cwd;
  else if (state.homeDir) state.cwd = state.homeDir;
  controls.paint();
  refreshGit().catch(() => {});

  // 語彙はエージェントごとに違う。切り替えたら取り直す
  const { modes, models } = await loadVocab(bid);
  if (state.current !== id || version !== topbarVersion) return;
  state.modes = modes;
  state.models = models;
  if (s) { state.mode = s.mode ?? "default"; state.model = chosen?.model ?? s.nextSettings?.model ?? s.model ?? ""; }
  else { const prefs = (state.prefs.backends ? state.prefs.backends[bid] : state.prefs) ?? {}; state.mode = prefs.mode ?? "default"; state.model = chosen.model ?? prefs.model ?? ""; }
  state.mode = homeBot?.mode ?? selectedMode(s, bid, modes, chosen);
  await syncEndpoint(s, bid);
  if (state.current !== id || version !== topbarVersion) return;
  // 互換の接続先のモデルは接続先の一覧＋自由入力なので、公式の一覧に無くても戻さない
  if (homeBot) state.model = homeBot.model ?? '';
  if (!state.endpoint && !(state.model in models)) state.model = "" in models ? "" : Object.keys(models)[0] ?? "";
  const efforts = await cmd('efforts', { backend: bid, model: state.model, cwd: s?.nextSettings?.cwd || s?.cwd || undefined, ...(state.endpoint ? { endpoint: state.endpoint } : {}) }).catch(() => ({ '': { label: t('chat.next.useDefault') } }));
  if (state.current !== id || version !== topbarVersion) return;
  state.efforts = efforts;
  state.effort = homeBot?.effort ?? chosen?.effort ?? s?.nextSettings?.effort ?? s?.effort ?? '';
  state.effortDisabled = Object.keys(efforts).length <= 1;
  controls.paint();
  await syncAccount(s, bid);
  if (state.current !== id || version !== topbarVersion) return;
  controls.paint();
  paintSettingsNotice();
  refreshWorktree().catch(() => {});
  renderSessions();
}

/**
 * 一覧・状態・設定を取り直す。他の会話の出来事（完了・状態・タイトル…）のたびに呼ばれ、続けて来ることが多い。
 * 1 回ごとに一覧（数百 KB）と入力欄の上の設定を往復するので、中継を通るスマホでは重なると操作全体が重くなっていた。
 * 走っている取り直しがあれば、それが終わった後に 1 回だけ取り直す（その間に来た呼び出しは全部その 1 回を待つ）。
 * 走っている分は呼ばれる前に始まったので、それだけを待つと、呼んだ側が直前にした変更（fork など）が載らない
 */
let refreshRun = null, refreshAgain = null, refreshSnapshotReady = false;
let scheduledRefresh = null;
function scheduleRefresh() {
  if (scheduledRefresh) return scheduledRefresh;
  scheduledRefresh = new Promise((resolve, reject) => {
    setTimeout(() => {
      scheduledRefresh = null;
      refresh().then(resolve, reject);
    }, 400);
  });
  return scheduledRefresh;
}
function refresh({ sharePending = false } = {}) {
  // 起動時の重複だけは未受信の写しを共有する。出来事や自分の操作後は新しい写しを取り直す。
  if (!refreshRun) return refreshRun = runRefresh().finally(() => { refreshRun = null; refreshSnapshotReady = false; });
  if (sharePending && !refreshSnapshotReady) return refreshRun;
  return refreshAgain ??= refreshRun.catch(() => {}).then(() => { refreshAgain = null; return refresh(); });
}

let refreshVersion = 0;
// 取り直しの返事を待つ上限。後の refresh() は走っている分の終わりを待つので、返事が来ないと一覧が二度と更新されず、
// それを待つ操作（脇の移動の「移動中」・新しい会話の最初の送信）も止まったままになる
const REFRESH_REPLY_TIMEOUT_MS = 60_000;
async function runRefresh() {
  const version = ++refreshVersion;
  const wait = { timeoutMs: REFRESH_REPLY_TIMEOUT_MS };
  const [sessions, statuses, prefs] = await Promise.all([
    cmd("listSessions", {}, wait),
    cmd("listStatuses", {}, wait).catch(() => []),
    cmd("prefs", {}, wait).catch(() => ({})),
  ]);
  refreshSnapshotReady = true;
  if (version !== refreshVersion) return;
  state.sessions = applyPendingPatches(sessions);
  readCompletions.fromSessions(sessions);
  state.statuses = applyPendingStatuses(statuses);
  state.prefs = prefs ?? {};
  paintAutoCompactionSettings();
  browserSettings.paint();
  computerSettings.paint();
  refreshPreviewConfirmation();
  filePreview.prefsChanged();
  await loadBackends();
  await syncTopbar();
  cmd("running").then(applyRunning).catch(() => {});
}

// ---------------------------------------------------------------- 履歴と枝（web/branches.mjs）

const branches = createBranches({
  cmd,
  // 枝の名前は一覧のタイトル。refresh() が保つものを読むだけで、筋の側に写しは持たない
  titleOf: (id) => state.sessions.find((x) => x.id === id)?.title ?? null,
});
// 発言の高さが変わったら（画像の読み込み・折り畳み・返答が伸びる）筋の位置を確かめる。
// 脇の開閉で会話の幅が動いている間は毎コマ変わるので貼らず、動き終わりに 1 回貼る（setSidebar）。
// 同じフレームの高さ変化はまとめ、位置が変わらなければ branch-view 側で SVG 更新を省く。
let branchResizeFrame = null;
if (typeof ResizeObserver === "function") new ResizeObserver(() => {
  if (document.body.classList.contains("side-moving") || branchResizeFrame !== null) return;
  branchResizeFrame = requestAnimationFrame(() => {
    branchResizeFrame = null;
    if (!document.body.classList.contains("side-moving")) relayoutBranches();
  });
}).observe(thread);

/** Layout runs on append as well as resize; the spine exists even before the first turn. */
function relayoutBranches() { layoutBranchSpine(thread); }

let pendingBranchReload = false, pendingHistorySync = false;
async function reloadBranches(ev) {
  const id = state.current;
  if (!id) return;
  const related = ev.parent?.sessionId === id || ev.sessionId === id || branches.has(ev.parent?.sessionId) || branches.has(ev.sessionId);
  if (!related) return;
  if (state.busy) { pendingBranchReload = true; return; }
  await branches.load(id, state.messages);
  if (state.current !== id) return;
  if (state.busy) { pendingBranchReload = true; return; }
  placeJunctions();
}
async function finishBranchChange() {
  state.busy = false;
  if (pendingHistorySync) { pendingHistorySync = false; await syncHistory(); }
  if (pendingBranchReload) {
    pendingBranchReload = false;
    await reloadBranches({ sessionId: state.current });
  }
  log.classList.remove('branch-transition');
}
function paintBranchNames() {
  if (state.busy) { pendingBranchReload = true; return; }
  if (!state.current || !branches.has(state.current)) return;
  placeJunctions();
}

/**
 * 履歴を描く。from 以降の添字（messages の mi）だけ。返すのは足した要素。
 * retained を渡すと（静かな読み直し。retainThread の戻り値）、描き並べる項目の retained.from 番目からだけ描く
 */
function paintHistory(fromMi = 0, retained = null) {
  paintingHistory = true;
  try { return paintHistoryRows(fromMi, retained); }
  finally { paintingHistory = false; relayoutBranches(); paintDelegateStates(); }
}

function paintHistoryRows(fromMi, retained = null) {
  const items = buildItems(state.messages, state.presents);
  const refs = state.presents.map(p => p.reference);
  const added = [];
  let prevRole = retained ? retained.prevRole : fromMi > 0 ? state.messages[fromMi - 1]?.role : null;
  const startAt = !retained && fromMi > 0 ? new Date(state.messages[fromMi - 1]?.at ?? 0) : null;
  // 発言に結び付いた human の present は、発言の本文の位置に取り込む（別のカードは出さない）。発言が描かれた添字だけ取り込み済みにする
  const attachedTo = inlineAttachments(items);
  const inlined = new Set();
  for (const [index, it] of items.entries()) {
    if (retained && index < retained.from) {
      // 残した行のうち、本文に添付を取り込んで描いた発言は取り込み済みにする（後ろの添付の行を二重にしない）
      if (it.kind === "msg" && it.m.role === "user" && retained.rows.get(`m:${it.mi}`)?.querySelector(".m.user:not(.cmd)")) inlined.add(it.mi);
      continue;
    }
    if (it.kind === "present") {
      if (it.anchorMi >= 0 && it.anchorMi < fromMi) continue;
      if (!showsAsCard(it, inlined)) continue;
      if (it.anchorMi < 0 && startAt && new Date(it.p.at ?? 0) < startAt) continue;
      const wrapper = append(renderPresent(savedEvent(it.p)), `p:${it.pi}`);
      wrapper.dataset.h = "1";
      if (it.p.by === "human") wrapper.dataset.humanAttachment = "true";
      added.push(wrapper);
      continue;
    }
    if (it.mi < fromMi) continue;
    const { node, role } = historyRow(it.m, { cont: prevRole === "assistant", refs, prev: added.at(-1) ?? retained?.row,
      presents: (attachedTo.get(it.mi) ?? []).map(savedEvent) });
    if (it.m.role === "user" && node?.matches('.m.user:not(.cmd)')) inlined.add(it.mi);
    if (node) {
      const row = append(node, `m:${it.mi}`);
      row.dataset.h = "1";
      added.push(row);
    }
    prevRole = role;
  }
  return added;
}

/**
 * 履歴の発言 1 件の行。メインパネル（paintHistoryRows）と読むだけの筋（作業の詳細、readonlyThread）で共通。
 * node が null なら描かない。role は次の発言の cont（AI が続けて話したか）を決める。system はシステム側の行（systemHistoryNode）だったか。
 * prev は直前に置いた行。続けて残った中断（ツールの中断と、その直後の中断）は 1 行にする。
 * readonly は読むだけの筋: 操作（コピー・⋯）を外し、発言者をモデル名で出し（どのモデルが答えたかを見分けるため。
 * 分からなければエージェント名のまま）、ツールカードを state.toolCards に登録せず、委譲のカードに「開く」を付けない
 * （openFromCard はメインパネルの会話を親として子を探すので、別の会話の筋では違う子を開く）。
 * backend は発言に backend が無いときの発言者。sessionId は Web 検索の失敗に接続先の一文を足すときに引く会話。
 * user を渡すと人の発言をそれで描く（詳細の最初の発言の「依頼」）
 */
function historyRow(m, { cont = false, refs = [], prev = null, readonly = false, backend, sessionId = state.current, user = null, presents = [] } = {}) {
  const system = systemHistoryNode(m);
  if (system !== undefined) {
    const repeated = system?.matches('.m.sys.interrupted') && prev?.querySelector(':scope .m.sys.interrupted');
    const role = system?.classList.contains('user') ? 'user' : null;
    if (!system || repeated) return { node: null, role, system: true };
    if (readonly) stripActions(system);
    return { node: system, role, system: true };
  }
  let node;
  if (m.role === "user") node = user ? user(m) : userMsg(m.text, { uuid: readonly ? undefined : m.uuid, at: m.at, presents, markdown: !readonly, scheduledFor: m.scheduledFor, sentBy: m.sentBy });
  else {
    node = aiMsg({ uuid: readonly ? undefined : m.uuid, at: m.at, backend: m.backend ?? backend, cont });
    if (readonly && m.model) node.querySelector('.who > span:not(.row-be)').textContent = modelDisplayName(state.vocab.get(backend)?.models ?? {}, m.model);
    if (m.thinking) node.append(thinkFromText(m.thinking));
    const cards = (m.toolCalls ?? []).map((c) => {
      const card = renderToolCall(c.name, c.input, { id: c.id });
      if (c.result) { applyToolResult(card, c.result); noteEndpointFailure(card, c.result, sessionId); }
      if (!readonly) linkDelegateCard(card, c.input, c.result);
      if (c.id && !readonly) state.toolCards.set(c.id, card);
      return card;
    });
    if (!m.toolCalls) for (const name of m.tools ?? []) cards.push(renderToolCall(name, null));
    node.append(...toolNodes(cards));
    if (m.text) { const b = el("div", "body"); b.dataset.raw = m.text; b.innerHTML = renderAssistantMarkdown(m.text, refs); node.append(b); }
  }
  if (readonly) stripActions(node);
  return { node, role: m.role };
}

/**
 * 履歴の 1 つの発言のツールの行を、まとまり（閉じた見出し）と委譲に分けて並べる。委譲はまとまりの外に 1 件ずつ出し、そこでまとまりが切れる。
 * 1 件だけのまとまりは見出しを付けず、行のまま置く
 */
function toolNodes(cards) {
  const out = [];
  for (const seg of splitToolCalls(cards, (card) => isBoundaryTool(card.dataset.tool), (card) => (isComputerTool(card.dataset.tool) ? "computer" : "tools"))) {
    if (seg.type === "delegate") { out.push(seg.call); continue; }
    // コンピューターの操作は 1 件でも塊（見出しが「コンピューターを操作しました」）
    if (seg.calls.length === 1 && seg.kind !== "computer") { out.push(seg.calls[0]); continue; }
    const bundle = new Bundle({ kind: seg.kind });
    bundle.addAll(seg.calls);
    out.push(bundle.el);
  }
  return out;
}

/** A live assistant row can represent several persisted tool/thinking entries. */
function branchAnchor(mi) {
  const rows = [...thread.querySelectorAll('.mw[data-key^="m:"]')];
  return rows.find(w => Number(w.dataset.key.slice(2)) === mi)
    ?? rows.filter(w => Number(w.dataset.key.slice(2)) <= mi).at(-1)
    ?? thread.querySelector('.mw[data-key^="live:"]')
    ?? thread.querySelector('.mw');
}
function branchSnapshots() {
  return new Map([...thread.querySelectorAll('.branch-row')].map(r => [r.dataset.key, r.snapshot()]));
}
function placeJunctions({ snapshots = branchSnapshots() } = {}) {
  const focused = document.activeElement?.closest('.branch-tip');
  const focusId = focused?.dataset.session;
  const focusKey = focused?.closest('.branch-row')?.dataset.key;
  for (const row of thread.querySelectorAll('.branch-row')) row.remove();
  thread.classList.toggle('branched', branches.has(state.current));
  if (!state.current) return [];
  const byNode = nodeKeys(branches.junctions(state.current), state.messages.length);
  if (!byNode.size) {
    const parent = state.sessions.find(x => x.id === state.current)?.parent?.sessionId;
    if (parent) byNode.set(0, [{ id: parent, name: t('session.parentChat'), n: 0, back: true }]);
  }
  // Empty forks still have a selectable group before their first message.
  if (!state.messages.length && branches.has(state.current)) {
    const entries = [...branches.family.rows.values()].filter(r => r.id !== state.current)
      .map(r => ({ id: r.id, name: branches.nameOf(r.id), n: r.messages.length }));
    if (entries.length) byNode.set(-1, entries);
  }
  const added = [];
  for (const [mi, entries] of [...byNode].sort((a,b) => a[0]-b[0])) {
    const key = `m:${mi}`;
    const all = branches.distinguish([{ id: state.current, name: branches.nameOf(state.current), n: Math.max(0, state.messages.length-mi-1) }, ...entries],
      { id: state.current, messages: state.messages });
    const row = makeBranchRow(key, all, state.current, switchTo, snapshots.get(key));
    const anchor = mi >= 0 ? branchAnchor(mi) : null;
    // Two boundaries may share one live DOM row; keep their order.
    let after = anchor;
    while (after?.nextElementSibling?.classList.contains('branch-row')) after = after.nextElementSibling;
    if (after) after.after(row); else thread.querySelector('.spine').after(row);
    added.push(row);
  }
  relayoutBranches();
  if (focusId) {
    const group = added.find(r => r.dataset.key === focusKey);
    [...(group?.querySelectorAll('.branch-tip') ?? [])].find(t => t.dataset.session === focusId)?.focus({ preventScroll: true });
  }
  return added;
}

/**
 * loadSession。prev（今持っている { messages, presents }）を渡すと、その先頭の続きだけを頼む（web/history-sync.mjs、ADR 0062）。
 * 差分が返れば先頭につないで全量の形にし、全量が返った（古いサーバー・先頭が合わない）ときはそのまま、
 * 差分の印と件数が食い違うときは全量を取り直す。どの場合も、呼び出し側が受け取る形は同じ
 */
async function loadHistory(args, prev = null) {
  const request = prev ? syncRequest(prev.messages, prev.presents) : null;
  const data = await cmd("loadSession", request ? { ...args, ...request } : args);
  if (!request) return data;
  const joined = joinReply(prev, data, request);
  if (joined === null) return data;
  if (joined === false) return cmd("loadSession", args);
  const { from, total, presentFrom, presentTotal, ...rest } = data;
  return { ...rest, ...joined };
}

/**
 * セッションを開く。keepUpTo を渡すと、その添字より前の発言は画面に残したまま続きだけ描く
 * （枝の切り替え。共通部分は動かさない）。
 * reload は同じ会話の読み直し（つなぎ直したとき）。今の表示・入力欄・引き出しはそのままにして裏で読み、
 * 読めたら 1 回で描き替える。入力欄を止めない（止めると書いている途中でスマホのキーボードが閉じる）
 * fresh は作ったばかりの会話（startNew）。空なので骨組みも「読み込み中」も出さず、入力欄に触らない（書いている字が正本）。
 * retry は読み込みに失敗した今の会話を読み直す（「もう一度読む」。開き直しと同じ見せ方）
 * jump は脇の検索の抜粋から開いたとき。読み込んだ後にその発言へ送って輪を付ける（openFromSearch・revealMessage）
 * after は fresh のとき、描く前に待つ約束（startNew の一覧の読み直し。会話の行が載ってから描く）
 */
async function select(id, { keepUpTo, reload = false, fresh = false, retry = false, jump = null, after = null } = {}) {
  if (state.busy || (id === state.current && keepUpTo === undefined && !reload && !retry)) return;
  const quiet = reload && !retry && id === state.current && keepUpTo === undefined && !state.loadingSession;
  if (keepUpTo === undefined && !quiet && !fresh) setDrawer(false);
  filePreview.sessionChanged(id);
  if (keepUpTo === undefined && !quiet) {
    // 開き直し: 先に空にして「読み込み中」。切り替え（keepUpTo）は剥がれた後に一緒に描くので、ここでは触らない
    // 作っている間の送信の予約は、別の会話へ移ったら取り消す（字は "" の下書きに残り、作った会話へ移る。startNew）
    if (!fresh && composerWait.queued) composerWait.cancel();
    if (!fresh) saveDraft().catch(() => {});
    // 新しい会話の欄で始めた添付: できた会話へ付け替える。作っていないのに別の会話へ移るなら、その欄の持ち物として "" に切り離す
    // （後で作る別の会話に紛れ込まない。届いたら "" の下書きに積む）
    if (state.current === null && !fresh && !creatingSession) chatAttach.adoptOwner(null, "");
    state.current = id;
    if (fresh) adoptUploads(id);
    state.contextWindow = null; state.compactionAt = null; state.compactionPhase = null; state.compactions = [];
    paintContextStrip();
    try { localStorage.setItem("agent-host-current", id); } catch {}
    if (channelsUi.tab !== 'channels') viewAddress.note({ sessionId: id });
    syncWorkEntry();
    state.loadingSession = id;
    if (fresh) freshSessionId = id;
    // 前の会話の下書きで上書きするまで、書いた字は保てない。disabled にはしない（打鍵が黙って捨てられ、キーボードが閉じる）。
    // readonly + aria-busy にして、150ms を越えたら欄の中に「履歴を読み込み中…」を出す（web/composer-wait.mjs）
    if (fresh) composerWait.idle(); else composerWait.busy("history");
    $("settingsError").textContent = "";
    syncSettingsHold();
    state.awaitingSession = false;
    state.submitting = false;
    syncRunState();
    syncTopbar();
    clearThread();
    if (!fresh) loadDraft();
  }
  try {
    await loadAndPaint(id, { keepUpTo, quiet, fresh, after });
  } finally { if (freshSessionId === id) freshSessionId = null; }
  if (jump && state.current === id && !state.loadingSession) revealMessage(jump);
}

/**
 * 脇の検索の結果を押した。抜粋（jump）があればその発言へ飛び、無ければ（題・状態・場所だけの一致）ただ開く。
 * 今開いている会話の抜粋なら、読み直さずにその発言へ送る
 */
async function openFromSearch(id, jump) {
  if (!jump) return select(id);
  if (id === state.current && !state.loadingSession) { if (narrowView.matches) setDrawer(false); revealMessage(jump); return; }
  return select(id, { jump });
}

/**
 * 通知の一覧の行を押した（web/notification-inbox.mjs）。行き先は見ている場所のアドレス（web/view-address.mjs）の go が開く:
 * 会話なら Chats の会話（発言 uuid があればその発言へ送って輪を付ける）、チャンネルなら channels:show（スレッド・投稿まで。着いた投稿は
 * web/channels/thread.mjs・feed.mjs が輪を付ける）
 */
async function openFromNotification(target) {
  if (narrowView.matches) setDrawer(false);
  await viewAddress.go(target);
}

/**
 * 検索で探した語を会話の中の検索へ引き継ぎ（開かない。Ctrl+F の 1 手で残りの一致へ進める）、その発言へ送って輪（note-flash）を付ける。
 * 発言は uuid で引く（会話の行の data-uuid と、検索の結果の uuid は同じ値）。見つからなければ語だけ引き継ぐ
 */
function revealMessage({ uuid, role, query, speaker }) {
  const m = [...thread.querySelectorAll('.m[data-uuid]')].find((x) => x.dataset.uuid === uuid) ?? null;
  toc.carry(query, { scope: role === 'tool' ? 'tool' : speaker === 'user' ? 'user' : 'answer', uuid });
  if (!m) return;
  const mark = m.querySelector('mark.searchhit.active');
  revealFold(mark ?? m);   // 長い発言の畳まれた部分に一致があれば、動かさずに開く（web/fold.mjs）
  // 発言の頭を上から 90px の位置へ。長い発言で一致が画面の下に外れるときだけ、一致そのものへ送る
  const row = m.closest('.mw') ?? m;
  const deep = mark && mark.getBoundingClientRect().top - row.getBoundingClientRect().top > log.clientHeight - 160;
  const target = deep ? mark : row;
  nav.scrollToRow(target, 90, () => flashMessage(m, mark));
}
let flashedMessage = null, flashMessageTimer = 0;
/** 着いた発言の吹き出しに輪を 1 度だけ（入力欄の上の一行・添付の入口と同じ note-flash）。一致のある塊があればその塊に */
function flashMessage(m, mark) {
  const body = mark?.closest('.body') ?? m.querySelector(':scope > .body') ?? m.querySelector('.body') ?? m;
  clearTimeout(flashMessageTimer);
  flashedMessage?.classList.remove('flash');
  void body.offsetWidth;
  body.classList.add('flash');
  flashedMessage = body;
  flashMessageTimer = setTimeout(() => { body.classList.remove('flash'); if (flashedMessage === body) flashedMessage = null; }, 1300);
}

async function loadAndPaint(id, { keepUpTo, quiet, fresh, after = null }) {
  sessionLoads.cancel(state.displayLoad);
  const load = sessionLoads.begin(id);
  state.displayLoad = load;
  const historyTimer = keepUpTo === undefined && !quiet && !fresh ? setTimeout(() => {
    if (state.current !== id || state.displayLoad !== load) return;
    for (const widths of [[42, 62], [35, 78, 54]]) {
      const lines = el('div', 'history-lines');
      for (const width of widths) { const line = el('span', 'history-line'); line.style.width = `${width}%`; lines.append(line); }
      const skeleton = el('div', 'm history-skeleton');
      skeleton.append(lines);
      append(skeleton);
    }
    activity.show(t('pending.historyLoading'));
  }, 150) : null;
  let data;
  try {
    // 静かな読み直し（つなぎ直したとき）は、今持っている履歴の続きだけを頼む
    // 委譲カード・バックグラウンドの一覧の行（会話の分）も一緒に読み、描く前に揃える
    const cards = loadTaskCards(id);
    data = await loadHistory({ sessionId: id, live: true, watch: true }, quiet && state.messages.length ? { messages: state.messages, presents: state.presents } : null);
    await cards;
    // 作ったばかりの会話（startNew）は、一覧の読み直しと並べて履歴を読む。描く前に一覧の行が載るのを待つ
    await after;
  } catch (e) {
    clearTimeout(historyTimer);
    sessionLoads.cancel(load);
    if (state.current !== id || state.displayLoad !== load) return;
    // 読み直しが切れただけなら、今の表示を残す（つながり直せばもう一度読む）
    if (quiet) return;
    state.loadingSession = null;
    clearThread();
    // 欄は書けるように戻す（以前は無効のまま戻らなかった）。送信は読み込めるまで押せない。欄の上に理由と「もう一度読む」
    if (keepUpTo === undefined) composerWait.failed(() => select(id, { retry: true }));
    syncRunState();
    return sys(html.t("chat.sys.historyFailed", { error: e.message }));
  }
  try {
    if (state.displayLoad !== load || keepUpTo === undefined && state.current !== id) return;
    // 静かな読み直しは、今の画面と同じ先頭の行を残して、変わった所から後ろだけ描く
    const plan = quiet && keepUpTo === undefined
      ? retainPlan({ messages: state.messages, presents: state.presents, compactions: state.compactions },
        { messages: data?.messages, presents: data?.presents, compactions: data?.compactions })
      : null;
    await paintSession(id, data, { keepUpTo, load, quiet, fresh, plan });
  } catch (e) {
    // 描く途中（枝の読み込みなど）で落ちても、欄を待ちのまま残さない
    if (state.current === id && state.loadingSession === id && keepUpTo === undefined && !quiet) {
      state.loadingSession = null;
      composerWait.failed(() => select(id, { retry: true }));
      sys(html.t("chat.sys.historyFailed", { error: e.message }));
    } else throw e;
  } finally { clearTimeout(historyTimer); sessionLoads.cancel(load); }
}

/**
 * 読んだ履歴を今の会話にする。keepUpTo を渡すと、その添字より前の発言（と剥がれていない印）は画面に残し、
 * 続きだけ描く。タイトル・一覧の選択・入力欄もここで一緒に切り替わる（= 描画の最終コマと同じタイミング）。
 * transition は選択前のノード座標。本文の高さを畳まず、ノードを横移動する。
 */
async function paintSession(id, data, { keepUpTo, transition, loaded = false, load, quiet = false, fresh = false, plan = null } = {}) {
  filePreview.sessionChanged(id);
  const snapshots = branchSnapshots();
  if (keepUpTo !== undefined) saveDraft().catch(() => {});
  state.current = id;
  syncWorkEntry();
  if (state.contextInfoId !== id) { state.contextInfo = null; state.contextInfoId = null; }   // 前の会話の記録を持ち越さない
  paintOutbox();
  refreshOutbox(id).catch(() => {});
  try { localStorage.setItem("agent-host-current", id); } catch {}
  if (channelsUi.tab !== 'channels') viewAddress.note({ sessionId: id });
  const localDraft = state.drafts.get(id);
  // 読み直しと作ったばかりの会話では、入力欄に今ある字が正本（読んでいる間に書き足した分がサーバーの下書きより新しい）
  const keepComposer = quiet || fresh;
  if (!localDraft?.dirty && !keepComposer) {
    const restored = data?.draft ?? { text: "", attached: [] };
    restored.attached = (restored.attached ?? []).map(a => ({ ...a, dataUri: localDraft?.attached?.find(old => old.path === a.path)?.dataUri }));
    state.drafts.set(id, restored);
  }
  state.awaitingSession = false;
  state.submitting = false;
  state.messages = data?.messages ?? [];
  state.contextWindow = data?.contextWindow ?? null;
  state.compactionAt = data?.compactionAt ?? null;
  state.compactionPhase = null;
  state.compactions = data?.compactions ?? [];
  paintContextStrip();
  restorePastSubagents(id);
  state.initialMessageId = data?.initialMessageId;
  state.presents = data?.presents ?? [];
  // 系譜（lineage）は待たずに本文を先に描き、分岐点の印は届いてから付ける（下の family）。
  // 系譜はサーバーが全エージェントの一覧から組むので、待つと開くたびに 1〜3 秒止まっていた。
  // 別の家族の会話へ移ったなら、前の家族で分岐点を描かないように先に忘れる
  let family = null;
  if (!loaded) {
    if (!branches.has(id)) branches.reset();
    family = branches.load(id, state.messages).catch(() => null);
  }
  if (state.current !== id || load && state.displayLoad !== load) return;
  state.loadingSession = null;
  // 対応を終えたエージェントの会話で閉じた欄（下の retired）は、別の会話を開いたら戻す
  $("prompt").disabled = false;
  composerWait.idle();
  syncRunState();
  syncTopbar();

  if (navSession !== id) { navSession = id; nav.reset(); toc.reset(); }
  const scrollAt = log.scrollTop;
  // 読み直しは、末尾を見ていたなら末尾へ、読み返していたならその位置のまま描き替える
  const atEnd = log.scrollHeight - log.clientHeight - log.scrollTop < 40;
  const restoreReading = plan && !atEnd ? holdReading() : null;
  const retained = plan ? retainThread(plan) : null;
  if (keepUpTo === undefined) { if (!retained) clearThread(); }
  else {
    const last = keepUpTo > 0 ? branchAnchor(keepUpTo - 1) : null;
    let after = !last;
    for (const x of [...thread.children]) {
      if (x.classList.contains('spine')) continue;
      if (after) x.remove();
      if (x === last) after = true;
    }
  }
  // Shared DOM survives a fork switch, but its UUID must belong to the selected session.
  // 静かな読み直しで残した行は同じ会話の同じ発言なので、uuid は変わらない
  if (!retained) for (const w of thread.querySelectorAll('.mw[data-key^="m:"]')) {
    const message = state.messages[Number(w.dataset.key.slice(2))];
    const m = w.querySelector('.m[data-role]');
    if (m && message) {
      delete m.dataset.uuid;
      setUuid(m, message.uuid);
    }
  }
  if (!keepComposer) loadDraft();
  closeTurnEl();
  const added = paintHistory(keepUpTo ?? 0, retained);
  paintCompactions();
  if (state.initialMessageId) {
    const lastUser = [...thread.querySelectorAll('.mw:has(.m.user:not(.cmd))')].at(-1);
    if (lastUser) lastUser.dataset.messageId = state.initialMessageId;
  }
  syncOutboxRows(outboxes.get(id) ?? []);
  // Replay synchronously after clearing/painting; only events after the server
  // snapshot are appended, so an in-flight delta is neither lost nor doubled.
  if (load) for (const event of sessionLoads.finish(load, data)) onEvent(event, true);
  // まだ答えていない承認は本文の後（＝稼働表示の手前）に出す。届いたときに取りこぼしていても、
  // loadSession が返す保留中の一覧から拾える
  for (const ev of data?.permissions ?? []) if (ev.id) state.pendingPerms.set(ev.id, ev);
  paintPendingPerms(id);
  paintComputerWait();
  // 中断した会話は末尾に「■ 中断しました」（保存された状態から。読み直しても消えない）。loadSession の値が一覧より新しい
  const opened = state.sessions.find(s => s.id === id);
  if (opened && data && 'interrupted' in data) opened.interrupted = data.interrupted ?? null;
  paintInterruptLine();
  acknowledgeDisplayed(id, Math.max(data?.completedAt ?? 0, isInterrupted(opened) ? interruptReadPoint(opened) : 0) || data?.completedAt);
  const groups = placeJunctions({ snapshots });
  const moving = transition ? groups.find(r => r.dataset.key === transition.key) : null;
  if (transition) {
    for (const node of added) node.animate([{ opacity: .15 }, { opacity: 1 }], { duration: motionDuration(420), easing: EASING });
  }
  // この会話が読み込んだ記録。取り直しは待たない（固定された会話では今のファイルとの突き合わせが入る）
  refreshContextEntry({ force: true }).catch(() => {});
  refreshGit({ force: true }).catch(() => {});
  thread.classList.toggle("branched", branches.has(id));   // 枝があるとき、筋は「今いる枝」として青く太い
  if (isRunningHere()) activity.show(activity.text || ACTIVITY_LABEL.running);   // 走っている会話を開いたら末尾に弧
  else if (behindHere() || backgroundCounts().live) activity.show(t("activity.waitingBackground"));     // ターンは終わったが裏の子が残っている会話は衛星（待てないものだけなら印なし）
  relayoutBranches();     // 稼働表示が出た後の高さで、今いる枝の終端ノードを置き直す
  $("prompt").placeholder = branchIsFresh(id) ? t("chat.composer.firstMessage", { name: branches.nameOf(id) }) : promptPlaceholder();
  // 対応を終えたエージェントの会話は読むだけ。入力欄を閉じ、理由を末尾に出す（送信はサーバーも断る）
  const retired = data?.retired ?? null;
  if (retired) { sys(escText(retired)); $("prompt").disabled = true; $("prompt").placeholder = retired; }
  syncResume();
  if (keepUpTo === undefined && (!quiet || atEnd)) scrollToEnd(); else if (restoreReading) restoreReading(); else log.scrollTop = scrollAt;
  prepareHistoryHeights();
  if (family) family.then(() => {
    if (state.current !== id || load && state.displayLoad !== load) return;
    if (state.busy) { pendingBranchReload = true; return; }
    const stick = atBottom();
    placeJunctions();
    if (!retired) $("prompt").placeholder = branchIsFresh(id) ? t("chat.composer.firstMessage", { name: branches.nameOf(id) }) : promptPlaceholder();
    syncResume();
    if (stick) scrollToEnd();
  });
  if (moving) await moving.promote(transition.snapshot);
}

/**
 * ターンが終わった後、履歴を静かに読み直す。ライブで描いた発言（data-key が live:）に
 * 履歴の添字と uuid を付け（同じ id で「ここから分岐」が押せるように）、枝の筋の件数を合わせる。
 * 照合するのはライブで描いた節だけ。履歴から描いた古い発言は本文が同じでも触らない。
 * 1 つの添字は 1 つの節にしか付けない（分岐点や切り替えはこの対応を信じる）。
 */
async function syncHistory() {
  if (state.busy) { pendingHistorySync = true; return; }
  const id = state.current;
  if (!id) return;
  const before = state.messages.length;
  const data = await loadHistory({ sessionId: id }, { messages: state.messages, presents: state.presents }).catch(() => null);
  if (!data || state.current !== id) return;
  if (state.busy) { pendingHistorySync = true; return; }
  state.messages = data.messages ?? [];
  restorePastSubagents(id);
  state.presents = data.presents ?? [];
  const claimed = new Set();
  // text.end で uuid が分かっていた発言は、履歴の添字を uuid で引く
  for (const m of thread.querySelectorAll('.mw[data-key^="live:"] .m[data-uuid]')) {
    const idx = state.messages.findIndex((x) => x.uuid === m.dataset.uuid);
    if (idx < 0 || claimed.has(idx)) continue;
    m.closest(".mw").dataset.key = `m:${idx}`;
    claimed.add(idx);
  }
  // 残り（人間の発言、uuid の来ないエージェントの発言）は、今回増えた分の中から役割と本文で
  let j = before;
  for (const m of thread.querySelectorAll('.mw[data-key^="live:"] .m[data-role]:not([data-uuid])')) {
    const raw = m.querySelector(":scope > .body")?.dataset.raw ?? m.querySelector(":scope > .body")?.textContent ?? "";
    const idx = state.messages.findIndex((x, i) => i >= j && !claimed.has(i) && x.role === m.dataset.role
      && (m.dataset.role === "user" ? (x.text ?? "") === raw : (!raw || (x.text ?? "") === raw)));
    if (idx < 0) continue;
    setUuid(m, state.messages[idx].uuid);
    m.closest(".mw").dataset.key = `m:${idx}`;
    claimed.add(idx);
    j = idx + 1;
  }
  // 履歴の添字で描いた行にも、uuid の無いものがある。走っているターンの途中で読み直した（巻き戻して送り直した直後など）ときの
  // 人の発言は、保存前の控えとして uuid 無しで来て m:<添字> の行になる。同じ添字の発言と役割・本文が合えば uuid を付ける
  for (const m of thread.querySelectorAll('.mw[data-key^="m:"] .m[data-role]:not([data-uuid])')) {
    const saved = state.messages[Number(m.closest('.mw').dataset.key.slice(2))];
    if (saved?.uuid && saved.role === m.dataset.role && (m.dataset.role !== 'user' || (saved.text ?? '') === userRaw(m))) setUuid(m, saved.uuid);
  }
  branches.update(id, state.messages);
  if (!branches.has(id)) await branches.load(id, state.messages);
  if (state.current !== id) return;
  if (state.busy) { pendingBranchReload = true; return; }
  placeJunctions();
}

// ---------------------------------------------------------------- 分岐

function forkPending(button) {
  if (!button) return () => {};
  const old = [...button.childNodes].map(node => node.cloneNode(true));
  button.disabled = true;
  // 発言の ⋯ は絵だけのボタンなので、弧だけを出す（名前は今のまま）。ほかは弧と字
  const icon = button.classList.contains('who-btn');
  const timer = setTimeout(() => button.replaceChildren(...(icon ? [runMark(t('pending.creatingBranch'))] : [runMark(t('pending.creatingBranch')), t('pending.creatingBranch')])), 150);
  return () => { clearTimeout(timer); if (button.isConnected) button.replaceChildren(...old); button.disabled = false; };
}

/** Create the actual child first, then grow its edge, reveal its node, and promote it. */
async function forkFrom(m, { draft, pending } = {}) {
  const uuid = m.dataset.uuid, mw = m.closest('.mw');
  if (!uuid || !state.current || state.busy) return;
  const key = mw?.dataset.key ?? '';
  const mi = draft ? draft.index - 1 : key.startsWith('m:') ? Number(key.slice(2)) : state.messages.findIndex(x => x.uuid === uuid);
  const source = state.current;
  const clearPending = forkPending(pending ?? m.querySelector(':scope > .who .who-more'));
  let sendTo;
  state.busy = true;
  log.classList.add('branch-transition');
  try {
    await settingsWrite;
    await modeWrite;
    const boundary = draft ? { beforeMessageId: uuid } : { upToMessageId: uuid };
    const result = await cmd('fork', { sessionId: source, ...boundary });
    if (!result?.sessionId) throw new Error(t('chat.fork.noId'));
    if (draft) await persistDraft(result.sessionId, { text: draft.text, attached: draft.attached, version: 2, dirty: true });
    await refresh();
    await branches.load(source, state.messages);
    const groups = placeJunctions();
    const row = groups.find(r => r.dataset.key === `m:${mi}`);
    if (row) await row.grow(result.sessionId);
    await changeBranch(result.sessionId, row);
    if (draft) sendTo = result.sessionId;
    $('prompt').focus({ preventScroll: true });
  } catch (e) {
    placeJunctions();
    composerError(t("chat.fork.failed", { error: e.message }));
  } finally { clearPending(); await finishBranchChange(); }
  if (sendTo && state.current === sendTo) await submit();
}

/** The session menu uses the same creation animation as the message action. */
async function forkTail(id) {
  if (state.busy) return;
  const clearPending = forkPending(document.querySelector(`[data-session="${CSS.escape(id)}"] .row-more`) ?? $('sessionMore'));
  try {
  await select(id);
  if (state.current !== id || state.busy) return;
  const last = [...thread.querySelectorAll('.m[data-uuid]')].at(-1);
  if (last) return forkFrom(last);
  state.busy = true;
  log.classList.add('branch-transition');
  try {
    await settingsWrite;
    await modeWrite;
    const r = await cmd('fork', { sessionId: id });
    await refresh();
    await branches.load(id, state.messages);
    const row = placeJunctions().at(-1);
    if (row) await row.grow(r.sessionId);
    await changeBranch(r.sessionId, row);
  } catch (e) { composerError(t("chat.fork.failed", { error: e.message })); }
  finally { await finishBranchChange(); }
  } finally { clearPending(); }
}

async function changeBranch(id, row) {
  const source = state.current;
  // Resolve data before touching the visible selection or conversation.
  sessionLoads.cancel(state.displayLoad);
  const load = sessionLoads.begin(id);
  state.displayLoad = load;
  let painted = false;
  try {
    const [data, cards] = await Promise.all([cmd('loadSession', { sessionId: id, live: true, watch: true }), readTaskCards(id)]);
    const target = data?.messages ?? [];
    let keep = commonPrefix(state.messages, target);
    const cut = branches.boundary(source, id);
    if (cut != null) keep = Math.min(keep, cut + 1);
    const anchor = keep ? branchAnchor(keep - 1) : null;
    const retainedIndex = anchor?.dataset.key?.startsWith('m:') ? Number(anchor.dataset.key.slice(2)) : -1;
    keep = Math.min(keep, retainedIndex + 1);
    const transition = row ? { key: row.dataset.key, snapshot: row.snapshot() } : null;
    await branches.load(id, target);
    if (state.current !== source) return;
    if (cards) setTaskCards(id, cards);
    await paintSession(id, data, { keepUpTo: keep, transition, loaded: true, load });
    painted = true;
  } finally {
    sessionLoads.cancel(load);
    // 読んだ時点でサーバーは移り先を開いたものとして流れを絞っている。移れなかったなら元の会話に戻す
    if (!painted && state.current === source) cmd('watchSession', { sessionId: source }).catch(() => {});
  }
}
async function switchTo(id, row) {
  if (state.busy || id === state.current) return;
  state.busy = true; row?.lock();
  log.classList.add('branch-transition');
  try { await changeBranch(id, row); }
  catch (e) { row?.unlock(); composerError(t("chat.fork.switchFailed", { error: e.message })); }
  finally { await finishBranchChange(); }
}

// ---------------------------------------------------------------- 送信

/** いま表示しているセッションが走っているか。並行実行するので画面ごとに違う。 */
function isRunningHere() {
  return state.current ? state.runningIds.has(state.current) : state.submitting;
}

// 設定の変更の承認（detached）はターンを止めていない。中断しても残るので、中断・再開の判断には数えない（ADR 0088）
const isWaitingHere = () => (state.work.permissions ?? []).some((p) => (p.blocking ?? !p.detached) && belongsHere(p));
/** いま表示している会話の中断を受け付けて、止まり終えるのを待っているか */
function stoppingHere() {
  return Boolean(state.current) && state.stopping.has(state.current);
}

/** 実行状態から見た目を合わせる。走っている本数ではなく「この画面が走っているか」で決める。 */
function syncRunState() {
  const here = isRunningHere();
  nav.syncRunning();
  // エージェント・作業ディレクトリは実行中も次のターンの分を予約できる（チップは無効にしない）
  // 作ったばかりの会話（freshSessionId）を開いている間は押せる（送信を予約する。submit）
  $("send").disabled = submittingMessages.has(state.current)
    || state.loadingSession === state.current && Boolean(state.current) && state.current !== freshSessionId
    || composerWait.blocksSend() || Boolean(retiredHere()) || connStatus.blocksSend() || Boolean(composerShellMode ? null : uploadBlockReason());
  // 送れない理由（送信中・失敗の添付）は送信ボタンの title に出す
  const sendBtn = $("send"), upReason = composerShellMode ? null : uploadBlockReason();
  if (upReason) { if (sendBtn.dataset.upBlock === undefined) sendBtn.dataset.upBlock = sendBtn.getAttribute("title") ?? ""; sendBtn.setAttribute("title", upReason); }
  else if (sendBtn.dataset.upBlock !== undefined) { sendBtn.setAttribute("title", sendBtn.dataset.upBlock); delete sendBtn.dataset.upBlock; }
  $("abort").hidden = !(here || isWaitingHere());
  // 受け付けた中断は取り消せない。止まり終えるまで押せないようにする（稼働表示は「中断している」）
  $("abort").disabled = here && stoppingHere();
  syncResume();     // 中断状態なら同じ位置に「再開」
  controls.fit();   // 中断が出入りすると行の幅の配分が変わる
  if (!here) {
    closeTurnEl();
    // ターンは終わったが裏の作業が残っている。末尾の節は消さずに衛星にする（中断は出さない）
    // 待てないもの（端末・裏のコマンド）だけが残っているときも、止める口（バックグラウンド N）のために行を残す
    if ((behindHere() || backgroundCounts().live) && !state.loadingSession) activity.show(activity.text || t("activity.waitingBackground"));
    else activity.hide();
  }
}

async function clearSentDraft(id, text, attachments) {
  const draft = state.current === id ? { text: $('prompt').value, attached: state.attached } : state.drafts.get(id);
  const paths = (list) => JSON.stringify(list.map(a => a.path).sort());
  if (draft?.text !== text || paths(draft.attached ?? []) !== paths(attachments)) return;
  if (state.current === id) { $('prompt').value = ''; state.attached = []; renderAttached(); $('slashHint').textContent = ''; slashSkills.close(); fitPrompt(); }
  await persistDraft(id, { text: '', attached: [], dirty: true });
}
/**
 * 通話で確定した発言を会話へ送る（web/voice/index.mjs の slot.send）。入力欄を通さず、sendMessage へ直に渡して会話の行に置く
 * （状態は声の 3 つの言い方。web/voice/chat-send.mjs・delivery.mjs）。入力欄の書きかけには触れない
 */
const submitVoiceText = createChatVoiceSender({
  state, cmd: (command, args) => cmd(command, args), randomId, freshId: () => freshSessionId, delivery: voiceDelivery,
  ensureSession: async () => { const created = await (creatingSession ?? startNew()); return created && state.current === created ? created : null; },
  settingsSettled: async () => { await settingsWrite.catch(() => {}); await modeWrite; },
  place: (sessionId, messageId, text) => {
    if (messageRow(messageId)) return;
    markDelivery(ensureMessageRow(messageId, text, new Date().toISOString()), 'sending');
    syncOutboxRows(outboxes.get(sessionId) ?? []);
  },
});
/** まだ送っていない会話を開いている（新しい会話の欄・作ったばかり・未送信の会話）。bot の会話は除く */
function unsentHere() {
  if (!state.current || state.current === freshSessionId) return true;
  const s = state.sessions.find((x) => x.id === state.current);
  return Boolean(s?.unsent) && !s.bot;
}

/**
 * 新しい会話の宛先に bot を選んだ最初の送信: 一時チャットの実体のチャンネルへ、その bot 宛ての投稿を置き（channels.post の to）、
 * そのスレッドを開く。空の会話（未送信）は残さず消す。送り直しても同じ投稿を二重に作らない（clientId）
 */
let homeAttempt = null;
async function sendToHomeBot(bot) {
  const text = $('prompt').value;
  const attachments = orderedAttachments().map(a => ({ path: a.path, name: a.name, mime: a.mime ?? '' }));
  if (!text.trim() && !attachments.length) return;
  const key = JSON.stringify([bot.id, text, attachments]);
  if (homeAttempt?.key !== key) homeAttempt = { key, clientId: `home-${randomId()}` };
  try {
    const post = await cmd('invoke', { op: 'channels.post', args: { channelId: 'home', text, ...(attachments.length ? { attachments } : {}), to: bot.id, clientId: homeAttempt.clientId } });
    homeAttempt = null;
    const empty = state.sessions.find(s => s.id === state.current && s.unsent && !s.bot) ?? null;
    $('prompt').value = '';
    state.attached = [];
    renderAttached();
    fitPrompt();
    homeDest.reset();
    $('settingsError').textContent = '';
    viewAddress.go({ channelId: post.channelId, threadId: post.id });
    if (empty) deleteSessionRow(empty).catch(() => {});
  } catch (e) {
    $('settingsError').textContent = t('chat.send.failed', { error: e.message });
  }
}

async function submit({ at = armedSends.get(state.current) } = {}) {
  // 入力欄の `!`: シェルの形なら走らせる。使えない会話の `!` は送らずに理由の一行を光らせる（文として送るのは「文として送る」だけ）
  if (shellComposer.active) return runShellFromComposer();
  if (shellComposer.blocked) return shellComposer.flash();
  if ($('prompt').value.trim() || state.attached.length) completionNotifications.requestPermission();
  // 設定を保存できず止めている間は送らない。理由の一行へフォーカスを移す（web/composer-wait.mjs の hold）
  if (composerWait.held) { composerWait.point(); return; }
  // 送っている途中・失敗の添付があるうちは送らない（欠けた添付を前提にエージェントが作業を始めないように）。札が理由と外す・再試行を持つ
  const upBlock = uploadBlockReason();
  if (upBlock) { notify(upBlock); flashAttachEntry(); return; }
  if (homeDest.bot) return sendToHomeBot(homeDest.bot);
  if (!state.current || state.current === freshSessionId) {
    // 新しい会話を作っている間の送信は予約する（docs/design-system.md「入力欄の待ち」）。欄は readonly にして字を保ち、
    // 150ms を越えたら送信ボタンに弧、欄の上に「会話ができしだい送ります · 取り消す」。できしだい下の続きで送る
    if (queuedSend) return;
    const hasContent = Boolean($('prompt').value.trim() || state.attached.length);
    const ticket = { cancelled: false };
    if (hasContent) {
      queuedSend = ticket;
      composerWait.queue(() => { ticket.cancelled = true; if (queuedSend === ticket) queuedSend = null; });
    }
    let created = null;
    try { created = await (creatingSession ?? startNew()); }
    finally { if (queuedSend === ticket) { queuedSend = null; composerWait.unqueue(); } }
    // 取り消した・作れなかった（脇の帯に理由とやり直し）・その間に別の会話へ移ったなら送らない。字は欄に残っている
    if (ticket.cancelled || !created || state.current !== created || state.current === freshSessionId) return;
    // 待っている間に添付を始めたもの（会話ができたら持ち主がその会話になる）も、届くまで送らない
    const stillBlocked = uploadBlockReason();
    if (stillBlocked) { notify(stillBlocked); flashAttachEntry(); return; }
  }
  const sessionId = state.current;
  if (submittingMessages.has(sessionId) || state.busy || state.loadingSession || composerWait.blocksSend() || retiredHere()) return;
  submittingMessages.add(sessionId);
  syncRunState();
  try {
    await settingsWrite.catch(() => {});
    await modeWrite;
    if (state.current !== sessionId) return;
    if (settingsFailure === sessionId) { composerWait.point(); return; }
    // 候補が開いたまま blur した場合の後片付けが先に走ると、送信の入力が書き換わる
    slashSkills.close();
    const text = $('prompt').value;
    const ordered = orderedAttachments();
    const attachments = ordered.map(a => ({ path: a.path, name: a.name, mime: a.mime ?? '' }));
    if (!text.trim() && !attachments.length) return;
    if (text.trim() === '/compact' && !attachments.length) {
      if (canCompactHere()) {
        await cmd('compactConversation', { sessionId });
        await clearSentDraft(sessionId, text, attachments);
      } else sys(t('compaction.antigravityManaged'));
      return;
    }
    if (!at) {
      const row = state.sessions.find(s => s.id === sessionId);
      if (row) { row.compacted = false; row.compactionAt = null; renderSessions(); }
      state.compactionAt = null; paintContextStrip();
    }
    // 添付の印はエージェントが読むので会話の言語で（まだ決まっていない会話は、サーバーが決めるのと同じ画面の言語）
    const agentLang = state.sessions.find(s => s.id === sessionId)?.agentLocale ?? uiLang;
    // 本文は文中の印（[添付] パス）ごとそのまま送る。文中に無い添付（文末に付く）だけ、今までどおり末尾に印を足す
    const inDoc = composerEditor.attachmentKeys();
    const tail = attachments.filter(a => !inDoc.has(attachedKey(a.path)));
    const full = [text.trim(), tail.map(a => attachmentLine(agentLang, a.path)).join(NL)].filter(Boolean).join(NL + NL);
    const args = { sessionId, prompt: full, cwd: state.cwd.trim() || undefined, mode: state.mode,
      ...(attachments.length ? { attachments } : {}) };
    // 日時を指定した送信は、送信待ちではなく予定として置く（時刻が来たら同じ送信待ちへ入る。core/send-schedule.mjs）
    if (at) {
      const key = `${sessionId}\n${full}\n${at}`;
      if (scheduleAttempt?.key !== key) scheduleAttempt = { key, messageId: randomId() };
      await limitOp('sessions.scheduleSend', { sessionId, prompt: full, at, messageId: scheduleAttempt.messageId,
        ...(args.cwd ? { cwd: args.cwd } : {}), ...(args.mode ? { mode: args.mode } : {}), ...(attachments.length ? { attachments } : {}) });
      scheduleAttempt = null;
      armedSends.delete(sessionId); paintArmed();
      await clearSentDraft(sessionId, text, attachments);
      $('settingsError').textContent = '';
      return;
    }
    const previous = receipts.get(sessionId);
    if (previous) {
      const known = (await refreshOutbox(sessionId)).find(m => m.id === previous.messageId);
      if (!known && previous.prompt !== full) throw new Error(t('chat.send.unknownPrevious'));
      if (known && previous.prompt === full) {
        await clearSentDraft(sessionId, text, attachments);
        receipts.delete(sessionId); saveReceipts();
        return;
      }
    }
    const request = previous && previous.prompt === full ? previous : { ...args, messageId: randomId() };
    receipts.set(sessionId, request); saveReceipts();
    // 吹き出しは、受理の応答が先でも userMessage が先でも、この仮の添付で描く
    if (ordered.length && !messageRow(request.messageId)) provisionalByMessage.set(request.messageId, ordered.map(provisionalPresent));
    await cmd('sendMessage', request);
    if (state.current === sessionId && !messageRow(request.messageId)) {
      markDelivery(ensureMessageRow(request.messageId, full, new Date().toISOString()), 'sending');
      syncOutboxRows(outboxes.get(sessionId) ?? []);
    }
    await clearSentDraft(sessionId, text, attachments);
    receipts.delete(sessionId); saveReceipts();
    $('settingsError').textContent = '';
  } catch (e) {
    $('settingsError').textContent = at ? t('schedule.scheduleFailed', { error: e.message }) : t('chat.send.failed', { error: e.message });
  } finally {
    submittingMessages.delete(sessionId);
    syncRunState();
  }
}

// ---------------------------------------------------------------- 接続

/**
 * このページのトークンが HTTP で通るか（web/connection-status.mjs が、続けて開けなかったときに 1 回だけ聞く）。
 * Cookie は送らない（別のタブが新しいトークンの Cookie を置いていても、このページの WebSocket は ?token= で開くため）
 */
async function checkToken() {
  try {
    const res = await fetch(`/auth-check?token=${encodeURIComponent(token)}`,
      { method: "HEAD", cache: "no-store", credentials: "omit", signal: AbortSignal.timeout(5000) });
    if (res.status === 401) return "denied";
    return res.status >= 500 ? "unreachable" : "ok";
  } catch { return "unreachable"; }
}

function connect() {
  ws = new WebSocket(`ws://${location.host}/ws?token=${encodeURIComponent(token)}`);
  ws.onopen = () => connStatus.opened();

  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);

    if (m.kind === "ready") {
      // 通話モード（/voice-ws）に対応した接続か（キーを持つこの PC の画面だけ。docs/voice-call.md）
      state.voice = m.voice === 1; voiceUi.refresh();
      // protocolVersion は必ず gate する。想定外なら黙って誤動作させない
      if (m.protocolVersion !== PROTOCOL) {
        sys(html.t("app.protocolUnsupported", { version: m.protocolVersion }));
        return ws.close();
      }
      // 画面を配ったのと違う版のサーバーにつながった（無停止の更新の切り替え）。下書きを保存して 1 回だけ読み直す
      if (reloadForVersion(m)) return;
      if (m.homeDir) state.homeDir = m.homeDir;
      // サーバーの起動時刻。これより前の更新による中断だけを「更新の後」の一行に数える（syncResumeStrip）
      state.serverStartedAt = Number.isFinite(m.startedAt) ? m.startedAt : null;
      // 画面と違う言語なら読み直すので、ここで止める
      if (applyLocale(m.locale)) return;
      connStatus.ready();
      state.hostTimeZone = m.hostTimeZone ?? null;
      refreshSchedules().catch(() => {});
      // 切れている間の確認と、旧版がこのブラウザーに持っていた確認済みを送る（受け取られたら旧版の分は消す）
      readCompletions.flush();
      // 切れて止まっていたフォルダーの送信・添付の送信を、受け取り済みの位置から続ける
      folderUpload?.online();
      for (const wake of [...onlineWaiters]) wake();
      // Chrome の窓の表はつなぎ直しで作り直す（サーバーは続けて今の分を送る）
      chromeWindows.clear(); chromeEntry?.paint();
      // 設定 › アプリ情報の「外の AI から Pleiad を使う」。ホストの画面でだけ取れて、取れたら出す（web/cli-setup.mjs）
      cliSetup.load();
      // OS の操作（エクスプローラー・ブラウザーで開く）を出してよいか。接続元を見てサーバーが答える（遠隔なら false）
      // 同じ答えで、添付の出どころを選ばせるか（ホストの画面でない接続）も決める（composer-layout.mjs の attachSources）
      cmd("hostCapabilities").then((c) => {
        state.hostCaps = c ?? null;
        computerSettings.paint();
        // エージェントのブラウザー（PC の Chrome）への接続の入口。使える環境なら今の状態を取る（設定 › ブラウザー）
        browserSettings.hostCapsChanged();
        state.osActions = c?.osActions === true && !window.plyRemote;
        filePreview.osChanged();
        syncAttachButton();
        renderAttached();
        remoteBrowser.reconnected();
        chromePanel?.reconnected();
        chromeEntry?.paint();
      }).catch(() => {});
      // 開く前から承認待ちがあれば、ここでダイアログに出す
      remoteSettings.refresh();
      // この PC の通知の設定。見ている会話を知らせ直す（つなぎ直した接続には、まだ印が無い）
      notifySettings.refresh();
      notificationInbox.reconnected();
      presenceReporter.reset();
      presenceReporter.report(true);
      loadThreadIndex();
      return refresh({ sharePending: true }).then(async () => {
        // スマホの通知を押して開いた会話（殻が ?open= で渡す）
        const wanted = mobileNotify.takeOpenRequest();
        if (wanted) return select(wanted);
        if (state.current) return select(state.current, { reload: true });
        let saved;
        try { saved = localStorage.getItem("agent-host-current"); } catch {}
        if (saved && state.sessions.some(s => s.id === saved)) await select(saved);
        else await startNew();
        // Channels の面を見ていたなら、その場所（チャンネル・スレッド・bot のページ）へ戻す（初めの 1 回だけ）
        const where = toShowDetail(savedView);
        if (!viewRestored && where && channelsUi.tab === 'channels') viewAddress.go(savedView);
        viewRestored = true;
      }).catch(e => {
        // 最初の接続の待ち（「接続しています…」）を残さない。開けなかった会話の待ちは select が解く
        if (composerWait.mode === "connect") composerWait.idle();
        sys(html.t("app.initFailed", { error: e.message }));
      });
    }

    // 保存される文言（変更の理由・添付の見出し）を今の言語に（web/saved-text.mjs）
    if (m.kind === "event") return onEvent(savedEvent(m.event));
    // PC の内蔵ブラウザーの画面（見ている接続にだけ届く）
    if (m.kind === "screencast") return m.source === 'chrome' ? chromePanel?.onMessage(m) : remoteBrowser.onMessage(m);

    if (m.kind === "response") {
      const p = pending.get(m.id);
      pending.delete(m.id);
      return m.ok ? p?.res(m.result) : p?.rej(Object.assign(new Error(String(m.error)), m.code ? { code: m.code } : {}));
    }

    if (m.kind === "error") sys(`error: ${escText(m.error)}`);
  };

  ws.onclose = () => {
    // 困っているときだけ出す。切れても向こうは走り続けている（既定では戻るまで待ち続ける）ので実行中の印は消さない。
    // 開き直すのは connStatus（1.5 秒ごと。トークンが古いと分かったら開き直さない）
    for (const [, p] of pending) p.rej(new Error(t("app.disconnected")));
    pending.clear();
    connStatus.closed();
  };

  ws.onerror = () => ws.close();
}

// ---------------------------------------------------------------- 操作

// 送信の日時の面（▾・送信の円の右クリックと長押し・Ctrl+Shift+Enter。web/send-menu.mjs）
const sendMenu = chatComposer.useSchedule({
  context: () => ({ available: canScheduleHere() }),
  // 窓を閉じても動き続けるか（常駐しているか）。動き続けないときだけ、面の一言「閉じている間は送れません」を出す
  environment: async () => {
    const status = await cmd('remoteStatus').catch(() => null);
    const resident = status?.resident;
    return { persistent: !resident?.available || Boolean(status?.enabled && resident.keepRunning), hostZone: state.hostTimeZone };
  },
  onSchedule: (at) => submit({ at }),
  onSendNow: () => submit({ at: null }) });
$('armedRemove').onclick = () => { armedSends.delete(state.current); paintArmed(); $('prompt').focus(); };
// 時刻が近づくと「あと 7 時間」が変わる。予定のある会話を開いている間だけ、30 秒ごとに描き直す
setInterval(() => { if (state.current && sendSchedules(state.current).some(r => !r.held)) paintOutbox(); }, 30_000);
/** いま日時を指定して送れるか（送る中身があり、シェルの形でなく、送れる会話か） */
function canScheduleHere() { return Boolean(($('prompt').value.trim() || state.attached.length) && !composerShellMode && !retiredHere()); }
function syncSendMore() { $('sendMore').disabled = !canScheduleHere() || $('send').disabled; }

const shellComposer = chatComposer.useShell({
  availability: shellAvailability,
  where: () => ({ cwd: state.cwd.trim() || state.sessions.find(s => s.id === state.current)?.cwd || '', host: remoteInfo(window.plyRemote)?.host ?? '' }),
  touch: () => matchMedia('(pointer:coarse)').matches,
  onAsText: () => submit(),
  onChange: () => { composerPlain = shellComposer.active; composerShellMode = shellComposer.mode; composerEditor.modeChanged(); fitPrompt(); controls.fit(); syncRunState(); } });
// 設定 › コンテキストは全体の設定だけ（フォルダーごとは会話の右パネルの「この場所だけ変える」）。
// 最近の会話の場所は「探す場所を足す」の候補、「設定 › 委譲で変える →」は委譲のページへ
const context = setupContext({ button: $('openContext'), cmd,
  show: () => onboarding.page('context'), recentPlaces: cwdOptions, backends: () => state.backends, getPrefs: () => state.prefs,
  openDelegation: () => { $('delegationTab').click(); $('delegationTab').focus(); } });
// 会話の右パネル「この会話のコンテキスト」。札とタイトル行の入口から開く
const sessionContext = setupSessionContext({ cmd, preview: filePreview,
  session: () => state.sessions.find(s => s.id === state.current) ?? null,
  info: () => (state.contextInfoId === state.current ? state.contextInfo : null),
  refreshInfo: (force) => refreshContextEntry({ force }),
  openSettings: () => openContextPage(), labelOf,
  isRunning: () => Boolean(state.current && state.runningIds.has(state.current)), budget: () => budgetOf(state.prefs), askReview: draftReview });
$('contextEntry').onclick = () => sessionContext.toggle($('contextEntry'));
// 会話の目次と検索（右パネル。狭い画面は下からのシート）。会話の画面にいるときの Ctrl+F（macOS は ⌘F）でも開く
const toc = createConversationToc({ thread, log, nav, preview: filePreview, narrow: navNarrow, button: $('tocEntry') });
// 会話の右パネル「git」（ADR 0085）。頭の行のアイコン・返答の下の要約行・委譲カードの「変更」・狭い画面の「…」から開く
gitPanel = setupGitPanel({ cmd, preview: filePreview, session: () => ({ id: state.current ?? null, cwd: state.cwd }),
  jump: jumpToConversation, use: useGitText, worktrees: worktreeOps, canOpen: () => Boolean(state.current && state.git.data),
  onState: (git, { foreign }) => { if (!foreign) { state.git.data = git; paintGit(); } } });
gitPanel.onOpenChange(paintGitEntry);
$('gitEntry').onclick = () => gitPanel.toggle($('gitEntry'));
// 会話の右パネル「Chrome の窓」（ADR 0148 第 5 段）。窓のある会話の頭の行の入口から開く。映像は見るだけ（ホストの画面もリモートの端末も）
chromePanel = setupChromePanel({ cmd, preview: filePreview, session: () => state.current ?? null, getAgentName: () => labelOf(activeBackendId()), windows: chromeWindows });
chromeEntry = setupChromeEntry({ button: $('chromeEntry'), panel: chromePanel, getSessionId: () => state.current ?? null, getAgentName: () => labelOf(activeBackendId()),
  available: () => state.hostCaps?.chromeWindow === true });
document.addEventListener('ply-git-open', (event) => {
  const sessionId = event.detail?.sessionId ?? null;
  if (!sessionId && !state.current) return;
  // 返答の下の 1 行（detail.turn）と委譲カードから開いたら「この会話の間」、頭のアイコン・近道からは「コミットしていない分」
  gitPanel.open(event.target.closest?.('button') ?? null, { sessionId, range: 'session' });
  paintGitEntry();
});
document.addEventListener('keydown', event => {
  const mac = /Mac/.test(navigator.platform);
  if (event.defaultPrevented || isComposingKey(event) || event.altKey || event.shiftKey || event.key.toLowerCase() !== 'f' || (mac ? !event.metaKey || event.ctrlKey : !event.ctrlKey || event.metaKey)) return;
  if (document.body.classList.contains('settings') || document.querySelector('dialog[open]') || !state.current) return;
  const field = event.target;
  // 入力欄（#prompt。Markdown の編集欄は contenteditable。web/md-editor.mjs）と目次の検索欄では奪う。ほかの入力要素の中では奪わない
  if ((field.matches?.('input,textarea') || field.isContentEditable) && !field.closest?.('#prompt, .toc')) return;
  event.preventDefault();
  toc.focusSearch();
});
// 脇の会話検索へ移る（Ctrl+Shift+F。macOS は ⌘⇧F）。Ctrl+F は会話の中の検索のまま。脇が閉じていれば開く（狭い画面は引き出し）
document.addEventListener('keydown', event => {
  if (!isSearchShortcut(event)) return;
  if (document.body.classList.contains('settings') || document.querySelector('dialog[open]')) return;
  event.preventDefault();
  if (narrowView.matches) setDrawer(true);
  else if (document.documentElement.classList.contains('side-closed')) setSidebar(true);
  side.focusSearch();
});
function openAutoCompactionSettings() { closeMeterPop(); onboarding.open('autoCompaction'); }
$('contextMeter').onclick = () => {
  const pop = $('contextMeterPop');
  if (!pop.hidden) return closeMeterPop(true);
  pop.hidden = false;
  $('contextMeter').setAttribute('aria-expanded', 'true');
  $('meterCompact').disabled = !canCompactHere() || state.compactionPhase?.phase === 'start';
  pop.querySelector('button:not(:disabled)')?.focus();
};
$('meterCompact').onclick = requestCompaction;
$('meterSettings').onclick = openAutoCompactionSettings;
document.addEventListener('pointerdown', event => { if (!$('contextMeterPop').hidden && !event.target.closest('.context-meter-wrap')) closeMeterPop(); });
document.addEventListener('focusin', event => { if (!$('contextMeterPop').hidden && !event.target.closest('.context-meter-wrap')) closeMeterPop(); });
document.addEventListener('keydown', event => {
  if ($('contextMeterPop').hidden) return;
  if (event.key === 'Escape') { event.preventDefault(); closeMeterPop(true); }
  else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
    const items = [...$('contextMeterPop').querySelectorAll('button:not(:disabled)')];
    const index = items.indexOf(document.activeElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
      : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
    event.preventDefault(); items[next]?.focus();
  }
});
for (const input of $('autoCompactionPanel').querySelectorAll('input')) input.addEventListener('change', saveAutoCompactionSettings);
for (const button of $('autoCompactionPanel').querySelectorAll('.cx-sw')) button.addEventListener('click', () => {
  button.setAttribute('aria-checked', String(button.getAttribute('aria-checked') !== 'true'));
  saveAutoCompactionSettings();
});
// 止めるのは今見ているセッションだけ。他のセッションは走らせたままにする
$("abort").onclick = () => {
  const sessionId = state.current;
  // 走っているターンの中断は、押した瞬間に受け付けた見た目にする（サーバの running が追って確かめる）。
  // 承認を待っているだけ（ターンの外）なら止まり終える待ちは無いので印を立てない
  const running = isRunningHere();
  if (sessionId && running) {
    state.stopping.add(sessionId);
    syncRunState();
    activity.show(ACTIVITY_LABEL.stopping);
  }
  cmd("abort", { sessionId }).catch(() => {
    if (sessionId) state.stopping.delete(sessionId);
    syncRunState();
  });
};

$("authNeed").onclick = (e) => { e.stopPropagation(); side.closePops(); openSettings(); };

$("prompt").addEventListener("input", () => syncResume());

$("workDialog").addEventListener("click", (e) => {
  if (e.target.dataset?.close !== undefined || e.target === $("workDialog")) $("workDialog").close();
});

// タイトルは人間もその場で変えられる。AI 用ツールと同じ store を通る（設計メモ 2.2）
let titleSent = null;   // 送ったばかりの値。Enter → blur で change と blur の両方から呼ばれても 1 回にする
async function commitTitle() {
  const s = state.sessions.find((x) => x.id === state.current);
  const v = $("titleEdit").value.trim();
  if (!state.current || !v || v === s?.title || v === titleSent) return;
  titleSent = v;
  await cmd("setTitle", { sessionId: state.current, title: v, reasonKey: "manual" })
    .catch((e) => composerError(t("session.titleFailed", { error: e.message })));
}
$("titleEdit").onchange = commitTitle;
$("titleEdit").onblur = commitTitle;
$("titleEdit").onkeydown = (e) => { if (isComposingKey(e)) return; if (e.key === "Enter") { e.preventDefault(); $("titleEdit").blur(); } };

// タイトルは AI にも考えてもらえる。人間が同じことをできる場所の隣に置く（設計メモ 2.2）
$("sessionMore").onclick = () => {
  const s = state.sessions.find((x) => x.id === state.current);
  if (!s) return;
  const r = $("sessionMore").getBoundingClientRect();
  rowMenu(s, r.right, r.bottom + 4, sessionMoreLead());
};
/**
 * タイトル行の「…」の頭に足す項目。700px 以下では ✦ をタイトル行に出さないので「タイトルを生成」をここに置く。
 * モバイル版の殻では、タイトルの下の添え字と同じ「ホスト一覧に戻る」も置く
 */
function sessionMoreLead() {
  if (!narrowView.matches) return [];
  const lead = [];
  if (phoneView.matches) {
    lead.push({ head: t('session.menu.open') });
    if (!$('contextEntry').hidden) lead.push({ label: $('contextEntry').getAttribute('aria-label'),
      onClick: () => sessionContext.open($('sessionMore')) });
    if (!$('gitEntry').hidden) lead.push({ label: $('gitEntry').getAttribute('aria-label'),
      hint: branchLabel(state.git.data), onClick: () => gitPanel?.open($('sessionMore')) });
    if (!$('chromeEntry').hidden) lead.push({ label: $('chromeEntry').getAttribute('aria-label'), onClick: () => chromePanel?.open($('sessionMore')) });
  }
  const wand = $("titleWand");
  if (!wand.hidden) lead.push({ label: t("session.titleWand"), disabled: wand.disabled, onClick: () => { if (!wand.disabled) wand.onclick(); } });
  const info = remoteInfo(window.plyRemote);
  if (info?.shell === "mobile") lead.push({ label: t("remote.backToHosts"), hint: info.host, onClick: () => backToHosts() });
  return lead;
}
/** モバイル版の殻のホスト一覧へ戻る（plyRemote.backToHosts、無ければ殻が入れる window.backToHosts） */
function backToHosts() {
  const fn = typeof window.plyRemote?.backToHosts === "function" ? () => window.plyRemote.backToHosts() : window.backToHosts;
  if (typeof fn === "function") Promise.resolve().then(fn).catch(() => {});
}

/**
 * モバイル版の殻の戻る（戻るボタン・画面端のスワイプ）。開いている面を手前から 1 つ閉じる:
 * ダイアログ → メニュー・浮く面 → ファイルのプレビュー・設定 → 引き出し。どれも Esc と同じ閉じ方にする。
 * 閉じるものが無ければ取り消さず、殻がアプリを背面へ回す（ホスト一覧へは戻らない。戻るのはタイトルの下のホスト名から）
 */
function watchShellBack() {
  const escape = target => target.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true, cancelable: true }));
  addEventListener("plyremote:back", (e) => {
    // リンクの開き先のシートと PC のブラウザーの画面（web/link-sheet.mjs・web/remote-browser.mjs）
    if (linkSheetOpen()) { e.preventDefault(); hideLinkSheet(); return; }
    if (remoteBrowser.isOpen) { e.preventDefault(); remoteBrowser.close(); return; }
    const dialog = [...document.querySelectorAll("dialog[open]")].at(-1);
    if (dialog) {
      e.preventDefault();
      if (typeof dialog.requestClose === "function") dialog.requestClose();
      else if (dialog.dispatchEvent(new Event("cancel", { cancelable: true }))) dialog.close();
      return;
    }
    const pop = document.querySelector(".pop.menu, .pop:not([hidden])");
    if (pop) {
      const focus = document.activeElement;
      escape(pop.contains(focus) ? focus : pop);
      // Esc で閉じない面が残っていても、戻るを飲み込み続けない
      if (!pop.isConnected || pop.hidden) return e.preventDefault();
    }
    if (!$("filePreview").hidden || onboarding.isOpen()) { e.preventDefault(); escape(document); return; }
    if (drawerOpen()) { e.preventDefault(); setDrawer(false); }
  });
}
$("titleWand").onclick = async () => {
  const id = state.current;
  if (!id || titleGenerating.has(id)) return;
  titleGenerating.add(id);
  syncTitleControls();
  let result = null;
  try {
    result = await cmd("suggestTitle", { sessionId: id });
  } catch (e) {
    composerError(t("session.titleSuggestFailed", { error: e.message }));
  } finally {
    titleGenerating.delete(id);
    syncTitleControls();
  }
  // 考えている間に別の会話へ移っていたら、その会話の欄には入れない
  if (!result || state.current !== id) return;
  // 勝手に確定させず、入力欄に入れて選択状態にする。気に入らなければそのまま書き換えられる
  $("titleEdit").value = result.title;
  $("titleEdit").focus();
  $("titleEdit").select();
};

const onboarding = setupOnboarding({ cmd, refreshAuth, getAuth: () => state.auth, authLogin, authUrlBox, folderBrowser, onClose: () => side.redraw(),
  begin: async (settings, prompt) => {
    if (state.busy || creatingSession) throw new Error(t("dialog.onboarding.busy"));
    const id = await startNew(settings);
    if (!id || state.current !== id) throw new Error(t("dialog.onboarding.openFailed"));
    $("prompt").value = prompt;
    $("prompt").dispatchEvent(new Event("input", { bubbles: true }));
  },
});
// 実行中でも更新できる（ADR 0036）。確認の段で止まる作業を並べ、「中断して更新」で全部を reason update で中断してから保存へ進む。
// 下の flush の count > 0 の断りは、中断が済んだ後の安全網（サーバーの更新ロックも残る）
const cliSetup = setupCliSetup({ cmd });
switchUi = setupSwitchNotice({
  sessionName: (id) => rowLabel(state.sessions.find(s => s.id === id) ?? {}),
  agentName: (id) => (id ? labelOf(id) : ''),
  // 設定のページの一覧から会話を開くときは、設定を閉じてから
  openSession: (id) => { onboarding.close(); select(id); },
  onChange: () => updatesUi?.refresh(),
});
updatesUi = setupUpdates({ page: onboarding.page, open: onboarding.open, lock: onboarding.lock, cmd,
  switchUi,
  // 無停止の更新の確認の段: 内蔵ブラウザーのタブを開いている・コンピューターの操作中なら、開き直しの注意を出す
  handoverNotes: () => ({ browser: (browserPanel?.state.tabs.length ?? 0) > 0 || state.computerStates.size > 0 }),
  work: () => state.work,
  sessionName: (id) => rowLabel(state.sessions.find(s => s.id === id) ?? {}),
  agentName: (id) => (id ? labelOf(id) : ''),
  // 無停止の更新（handover）では作業があっても断らない。切り替えは保持役に載らない作業が終わるのを main が待つ（desktop/switch.cjs）
  flush: async ({ handover = false } = {}) => {
  const work = await cmd('running');
  if (!handover && work.count > 0) {
    // どの会話が止めているかを名前で出す。数だけだと、どこを待てばよいか探し回ることになる
    const ids = [...new Set([...work.turns, ...work.permissions.filter(p => !p.relay), ...work.subagents].map(w => w.sessionId).filter(Boolean))];
    const titles = ids.slice(0, 3).map(id => rowLabel(state.sessions.find(s => s.id === id) ?? {}));
    const names = t('app.update.names', { names: titles.join(t('app.update.namesJoin')) });
    throw new Error(!titles.length ? t('app.update.blockedDelegated')
      : ids.length > 3 ? t('app.update.blockedBusyMore', { names, count: ids.length - 3 }) : t('app.update.blockedBusy', { names }));
  }
  if (creatingSession || state.loadingSession) throw new Error(t('app.update.loading'));
  if (!state.current && ($('prompt').value || state.attached.length)) throw new Error(t('app.update.draftNoSession'));
  await saveDraft();
  await Promise.all([settingsWrite, modeWrite, ...[...state.drafts].filter(([id, draft]) => id && draft.dirty).map(([id, draft]) => persistDraft(id, draft))]);
  await Promise.all([...draftWrites.values()]);
} });
// 狭い画面の引き出しから開いたなら閉じておく（docs/design-system.md「幕・会話の行・設定・Esc で閉じる」）。
// 設定の間は引き出しの見た目が効かないので、閉じないと「会話に戻る」で会話ではなく引き出しが出ていた
function openSettings() { setDrawer(false); onboarding.open(); }
/** リモートの窓: 中継・ホストにつながらない間は、切れた一行もバッジと同じ理由の語で書く（web/remote-badge.mjs の状態） */
function watchRemoteReason() {
  const remote = window.plyRemote;
  if (!remoteInfo(remote)) return;
  const apply = (s) => connStatus.setReason(s?.state === "offline" ? "relay" : s?.state === "host-offline" ? "host" : null);
  Promise.resolve(remote.status?.()).then(apply).catch(() => {});
  remote.onStatus?.(apply);
}
// 使用量の取得は設定の「使用量」とヘッダーのチップで共有する（同じエージェントの取得が走っていれば相乗り）
const usageSource = createUsageSource(cmd);
usageSource.onResult((backend, result) => { composerQuota.set(backend, result); if (controls.panels.model.open) controls.paint(); });
// 使用量の認可が済んでいないアカウントの「使用量の表示を認可」。アカウントの画面を開いて、そのまま認可を始める
const usageLogin = accountId => claudeAccounts.open({ usageLogin: accountId });
const headerUsage = setupHeaderUsage({ $, source: usageSource, getBackends: () => state.backends, onUsageLogin: usageLogin,
  openSettings: () => { onboarding.open('usage'); $('usageTab').click(); }, onVisibility: syncStripVisible });
setupUsage({ $, cmd, source: usageSource, getBackends: () => state.backends, endpoints: async (agent) => (await compatEndpoints.load(true)).filter((e) => e.agent === agent), page: onboarding.page, isOpen: onboarding.isOpen,
  onUsageLogin: usageLogin });
const remoteSettings = setupRemote({ cmd, page: onboarding.page, openSession: id => { onboarding.close(); select(id); } });
// 設定 › 通知。この PC の設定とスマホの一覧（スマホの種類・ロック画面の会話名はスマホのアプリで変える）
const notifySettings = setupNotifySettings({ cmd, page: onboarding.page, onPc: pc => { notifyPc = pc; } });
const voiceSettings = setupVoiceSettings({ cmd, page: onboarding.page, openPage: name => $(`${name}Tab`)?.click() });
// 設定 › API キー。使っている所のリンクは、接続先は設定 › エージェント設定の接続先の面、通話・委譲はそのページへ
const apiKeysSettings = setupApiKeysSettings({ cmd, page: onboarding.page, openEndpoints: agent => { if (compatEndpoints.openAgent !== agent) compatEndpoints.open(agent); else $('setupTab').click(); } });
// スマホのアプリの中だけ: 最初の作業が終わったときの帯と、通知から開く会話
const mobileNotify = setupMobileNotify({ band: $('notifyBand'), openSession: id => select(id) });
// 手元の窓の中継のカードの「子の会話を見る」で、このリモートの窓の会話を開く（desktop/remote-windows.cjs の openHost）
window.plyRemote?.onOpenSession?.(id => { if (id) select(id); });
// 見ている会話をホストへ知らせる。スマホへの通知を送らない・消すのに使う
const presenceReporter = createPresenceReporter({ send: (visible, sessionId) => cmd('presence', { visible, sessionId }),
  current: () => state.current, visible: watchingNow });
document.addEventListener('visibilitychange', () => presenceReporter.report());
addEventListener('plyremote:stop', () => { shellStopped = true; presenceReporter.report(); });
addEventListener('plyremote:start', () => { shellStopped = false; presenceReporter.report(true); });
presenceReporter.start();
// 設定 › 委譲（委譲先の自動振り分け）。モデルの名前は入力欄と同じ語彙から
const delegationSettings = setupDelegationSettings({ cmd, page: onboarding.page, showMenu, labelOf: routingNames.backend, logo: routingLogo,
  modelsOf: async (id) => (state.backends.some((b) => b.id === id) ? (await loadVocab(id)).models : null),
  modelName: (backend, model) => routingNames.model(backend, model), openPage: name => $(`${name}Tab`)?.click() });
clearThread();
initTheme();
initLocale();
initSidebar();
$("prompt").placeholder = promptPlaceholder();
// タッチの長押しで右クリックのメニュー（iOS は contextmenu を出さない）
setupLongPress();
// リモートの窓（端末のアプリが plyRemote を渡したとき）の帯のバッジ。帯の色を送るより先に置く
setupRemoteBadge();
watchRemoteReason();
watchTitleBar();
watchShellTheme();
watchShellBack();
// localhost のリンクは、サーバーのある PC の画面でなければ開かずに知らせる（docs/remote.md §8.5）
watchHostOnlyLinks({ onHostScreen: () => state.osActions === true, notify, choose: url => chooseRemote({ url }) });
wireDropZone();
fitPrompt();
// 初めて接続して会話を開く（または新しい会話を始める）までは書けない。書いても開いた会話の下書きで上書きされる
composerWait.busy("connect");
connect();
