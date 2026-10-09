// 審査モード（ADR 0172）。Google Play の審査員に、本物の Pleiad のホスト（fake バックエンドだけ）を見せるための、ホストの狭い動き方。
//
// 審査モードかどうかの判定はこのファイルの isReviewMode() 1 つ。ほかのコード（審査の招待・配置・画面）も、この関数で聞く。
// 入るのも抜けるのも起動の環境変数 AGENT_HOST_REVIEW=1 だけ。設定・操作の一覧（/api/ops・ply_control）・端末の命令からは変えられない
// （環境変数は起動のときに写し取る。あとで process.env を書き換えても動きは変わらない）。
//
// 絞り方は「許可の一覧」。ここに載せたものだけ通し、載せ忘れは断る側に倒れる（禁止の一覧にはしない）。
//   COMMAND_PASS / COMMAND_REFUSE  WS の全命令を「通す / 断る」に振った表。tests/unit/review-mode.mjs が protocol の全命令と突き合わせる
//   OP_ALLOW                       操作の一覧（core/ops/）で呼べる操作。ほかは一覧にも出さず、呼んでも断る
//   SETTING_SET_ALLOW              settings.set で変えてよい設定のキー
//   FAKE_SCRIPT_ALLOW              fake の台本。ほかは言葉をそのまま返す（core/backends/fake.mjs）
// 起動の条件は prepareReviewHost()。作業フォルダー（reviewWorkDir()）は置き場の中の空のフォルダー 1 つで、会話の cwd はここに固定する。
import fs from 'node:fs';
import path from 'node:path';
import { t, agentT } from './i18n.mjs';

export const REVIEW_MARK = 'review-data.json';
export const REVIEW_WORK = 'review-work';
export const REVIEW_CODE = 'REVIEW_MODE';

const REVIEW_AT_BOOT = process.env.AGENT_HOST_REVIEW === '1';

/** 審査モードか。引数なしは起動のときの環境（変えられない）。引数の env は試験用 */
export function isReviewMode(env) {
  return env ? env.AGENT_HOST_REVIEW === '1' : REVIEW_AT_BOOT;
}

export class ReviewModeError extends Error {
  constructor(message) {
    super(message);
    this.code = 'REVIEW_REFUSED';
  }
}

let workDir = null;

/** 作業フォルダーの実体のパス（realpath）。審査モードでない、または prepareReviewHost の前は null */
export function reviewWorkDir() {
  return workDir;
}

/**
 * 審査モードで起動してよいか確かめ、置き場に印と作業フォルダーを用意する（データ置き場のロックより前に呼ぶ）。
 * 満たさなければ ReviewModeError を投げる（起動を止める）:
 *   有効なバックエンドが fake だけ / 置き場に印がある、または置き場が空（存在しないのを含む。空なら印を作る）
 */
export function prepareReviewHost({ dataDir, backendIds }) {
  if (backendIds.length !== 1 || backendIds[0] !== 'fake') throw new ReviewModeError(t('review.needFake', { backends: backendIds.join(', ') || '-' }));
  const mark = path.join(dataDir, REVIEW_MARK);
  if (!fs.existsSync(mark)) {
    const used = fs.existsSync(dataDir) && fs.readdirSync(dataDir).length > 0;
    if (used) throw new ReviewModeError(t('review.dataNotReview', { dir: dataDir }));
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(mark, JSON.stringify({ review: true, createdAt: new Date().toISOString() }));
  }
  const work = path.join(dataDir, REVIEW_WORK);
  fs.mkdirSync(work, { recursive: true });
  // native: Windows の 8.3 の短い名前（RUNNER~1）も長い名前に開く（js の realpathSync は開かない）
  workDir = fs.realpathSync.native(work);
  return { workDir };
}

// ---- WS の命令 ----------------------------------------------------------------------------------------------------

// 通す。invoke は中の操作を OP_ALLOW で、setPref は設定のキーを SETTING_SET_ALLOW で絞る。listDirs・resolvePath は作業フォルダーに閉じる
export const COMMAND_PASS = [
  'invoke', 'presence', 'notifyStatus', 'setNotifyDevice', 'notifyRegister', 'remoteStatus', 'remoteDevices',
  'onboardingStatus', 'onboardingSeen', 'completeSetup',
  'runTurn', 'sendMessage', 'messageAction', 'listMessages', 'compactConversation', 'cancelCompaction',
  'abort', 'resume', 'listSessions', 'loadSession', 'watchSession', 'newSession', 'saveDraft', 'deleteUnsentSession', 'deleteSession',
  'setTurnSettings', 'setStatus', 'markRead', 'setGrouped', 'setTitle', 'fork', 'resolvePermission', 'listStatuses',
  'efforts', 'modes', 'setModel', 'models', 'listDirs', 'hostCapabilities', 'resolvePath', 'backends', 'authStatus', 'running',
  'loadSubagent', 'findSubagent', 'loadBackground', 'stopBackground', 'renameStatus', 'prefs', 'setPref',
  'suggestTitle', 'sessionChanges', 'setStatusIcon', 'createStatus', 'lineage',
];

// 断る（審査員に要らない・外へ出る・ホストを変える）。載せ忘れも断る側に倒れるが、試験が全命令の振り分けを求めるので、ここに書く
export const COMMAND_REFUSE = [
  'agentTasks', 'agentTaskInstructions', 'cancelAgentTask', 'retryAgentTask', 'delegationRouting', 'setDelegationRouting',
  'setApiKey', 'deleteApiKey', 'setApiKeyUse', 'resolveApiKeyGuide', 'setDelegationRoutingKey', 'deleteDelegationRoutingKey',
  'setVoiceKey', 'deleteVoiceKey', 'providerUsage',
  'claudeAccounts', 'saveClaudeAccount', 'deleteClaudeAccount', 'claudeLoginStart', 'claudeLoginCode', 'claudeLoginCancel',
  'compatEndpoints', 'compatEndpointCheck', 'compatEndpointSave', 'compatEndpointRecheck', 'compatEndpointDelete', 'compatEndpointDefault',
  'setNotifyPc', 'setRemoteSettings', 'remotePairingStart', 'remotePairingCancel', 'remotePairingApprove', 'remotePairingDeny',
  'remoteRevoke', 'setRemoteDeviceAgent', 'setRemoteResident',
  'contextSettings', 'slashSkills', 'sessionContext', 'plyInstructions', 'setPlyInstructions', 'refreshContext', 'contextDiff',
  'gitStatus', 'gitPanel', 'gitDiff', 'gitHistory', 'gitCommit', 'gitWorktrees', 'gitWorktree',
  'worktreeCheck', 'worktreeSplit', 'worktreeDiscard', 'worktreeKeep', 'worktreeArchive', 'worktreeRestore',
  'setSessionMcp', 'agentMcp', 'nativeInstructions', 'contextFindings', 'listMcpConfig', 'readMcpServer', 'saveMcpServer',
  'listPlyMcp', 'readPlyMcp', 'savePlyMcp', 'deletePlyMcp', 'mcpAuthStart', 'mcpAuthStatus', 'mcpAuthLogout', 'mcpReconnect',
  'renamePlyMcp', 'importPlyMcp', 'setPlyMcpSettings', 'setContextSettings', 'scanContext',
  'scanHooks', 'readHook', 'hookTargets', 'saveHooks', 'copyHooks', 'sessionHooks', 'plyHooks', 'readPlyHook', 'savePlyHook',
  'removePlyHook', 'togglePlyHook', 'plyHookPreview', 'hooksUnifyPreview', 'setHooksOwner', 'repairPlyHooks',
  'setAutoCompaction', 'setConversationAutoCompaction', 'runShell', 'stopShell', 'skipShell', 'switchBackend', 'setMode',
  'revealPath', 'openPath', 'openVisualization', 'authLogin', 'authLogout', 'authSubmit',
  'attachFile', 'attachStart', 'attachChunk', 'attachFinish', 'attachCancel', 'attachImport', 'attachImportCancel',
  'uploadCheck', 'uploadStart', 'uploadChunk', 'uploadFinish', 'uploadCancel',
  'browserScreencast', 'browserScreencastStop', 'browserScreencastAck', 'browserScreencastInput', 'browserScreencastNav', 'computerStop',
  'chromeStatus', 'chromeConnect', 'chromeDisconnect', 'chromeRaiseDialog', 'chromeTakeOver', 'chromeResume', 'chromeStop',
  'chromeOpen', 'chromeCloseWindow', 'chromePinWindow',
];

/** 全命令 → 通すか。載っていない命令は undefined（断る） */
export const COMMAND_ACCESS = Object.freeze({
  ...Object.fromEntries(COMMAND_REFUSE.map((c) => [c, false])),
  ...Object.fromEntries(COMMAND_PASS.map((c) => [c, true])),
});

/** その WS の命令を通すか（審査モードの中で聞く） */
export const commandAllowed = (command) => COMMAND_ACCESS[command] === true;

// ---- 操作の一覧（core/ops/） --------------------------------------------------------------------------------------

export const OP_ALLOW = new Set([
  'app.status', 'app.running',
  'sessions.search', 'sessions.roots', 'sessions.list', 'sessions.get', 'sessions.read', 'sessions.setTitle', 'sessions.setStatus',
  'sessions.fork', 'sessions.setModel', 'sessions.resume', 'sessions.new', 'sessions.deleteUnsent', 'sessions.delete', 'sessions.abort',
  'sessions.compact', 'sessions.cancelCompaction', 'sessions.setTurnSettings', 'sessions.suggestTitle', 'sessions.listMessages',
  'sessions.messageAction', 'sessions.markRead', 'sessions.changes', 'sessions.lineage', 'sessions.setGrouped',
  'sessions.background', 'sessions.stopBackground', 'sessions.subagents', 'sessions.readSubagent',
  'agents.list', 'agents.models', 'agents.modes', 'agents.efforts', 'agents.authStatus',
  'statuses.setIcon', 'statuses.create', 'statuses.list', 'statuses.rename',
  'settings.list', 'settings.get', 'settings.schema', 'settings.set',
  'notify.status', 'notify.setDevice', 'remote.status',
  'notifications.list', 'notifications.count', 'notifications.markRead',
  'drafts.save', 'drafts.load', 'files.listDirs',
]);

// settings.set で変えてよい設定のキー（言語・リンクの開き方・既定のモデルと段）。バックエンド・モード・各種の鍵や許可は変えられない
export const SETTING_SET_ALLOW = new Set(['locale', 'linkOpen', 'model', 'effort']);

/**
 * 操作の一覧の関所を、許可の一覧で絞った版にする（core/ops/index.mjs が審査モードのときだけ使う）。
 * 一覧（list・describe・ops・get）には許可したものだけ出し、invoke は許可の外を REVIEW_MODE で断る
 */
export function reviewRegistry(inner) {
  const refuse = (locale) => ({ ok: false, code: REVIEW_CODE, error: agentT(locale, `ops.errors.${REVIEW_CODE}`) });
  const permitted = (id, args) => OP_ALLOW.has(id) && (id !== 'settings.set' || SETTING_SET_ALLOW.has(args?.key));
  return {
    ...inner,
    ops: inner.ops.filter((op) => OP_ALLOW.has(op.id)),
    get: (id) => (OP_ALLOW.has(id) ? inner.get(id) : undefined),
    list: (principal) => inner.list(principal).filter((op) => OP_ALLOW.has(op.id)),
    describe: (principal, locale) => inner.describe(principal, locale).filter((entry) => OP_ALLOW.has(entry.id)),
    invoke: (principal, id, args, deps = {}) => (permitted(id, args) ? inner.invoke(principal, id, args, deps) : Promise.resolve(refuse(deps.locale))),
  };
}

// ---- fake の台本 --------------------------------------------------------------------------------------------------

// 通す台本: echo:・ask・ask-later・question・fail。steps:・control:・computer:・browser:・context:・held:・bg-shell・term などは通さない
const FAKE_SCRIPT_ALLOW = /^(?:echo:|ask(?:-later)?(?:\s|$)|question(?:\s|$)|fail(?:\s|$))/;

/** 審査モードで、その台本（発言の先頭）を通すか。通さないものは、fake が言葉をそのまま返す */
export const fakeScriptAllowed = (script) => FAKE_SCRIPT_ALLOW.test(String(script ?? ''));
