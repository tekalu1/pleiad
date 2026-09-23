// host <-> core のプロトコル。procway-code の Host Contract に倣う。
// 互換のある追加は番号を据え置き、既存メッセージの意味が変わるときに上げる。
//
// v2: `sdk`（生の SDK メッセージ素通し）を廃止し、正規化イベントに置き換えた。
//     バックエンドを跨いで同じ形で流れる（docs/multi-backend.md §2.2）。
// v3: 状態グループのアイコン（setStatusIcon / statusIcon、listStatuses に icon）、
//     runTurn の status（新規セッションに最初から状態を付ける）、lineage（系譜）、
//     text.end の uuid（走っている最中の発言から分岐できるように）。
export const PROTOCOL_VERSION = 3;

/**
 * イベントに sessionId を付ける。全イベントに sessionId が付く（無いものは null）のが契約。
 * バックエンドが書かなかったものだけターンの id で補う。**明示的な null は残す**
 * （statusIcon のようにセッションに紐づかないことを null で表すイベントがある。
 * `??` で埋めると、そのターンのセッションのものとして届いてしまう）。
 */
export function stampSessionId(event, fallback) {
  return { ...event, sessionId: event.sessionId !== undefined ? event.sessionId : fallback ?? null };
}

// server -> client
export const READY = "ready";
export const EVENT = "event";
export const RESPONSE = "response";
export const ERROR = "error";

// client -> server
export const COMMAND = "command";

export const COMMANDS = new Set([
  'agentTasks', 'cancelAgentTask',
  'providerUsage', // { backend } -> subscription quota + locally recorded usage（Claude はアカウントを登録していれば quota.accounts にアカウントごと）
  // Claude のアカウント（会話ごとに選ぶ。core/claude-accounts.mjs）。トークンは返さない
  'claudeAccounts',      // {} -> { accounts: [{ id, name, hasToken, usageLogin }], storage: { encrypted, backend, reason? } }
  'saveClaudeAccount',   // { id?, name, token? } -> 追加（id 無し。token 必須）/ 名前の変更・トークンの差し替え（id 有り。token を省けば残す）
  'deleteClaudeAccount', // { id } -> 一覧とトークンから消す（使用量の設定フォルダも）。選んでいた会話は次の送信でエラーになる
  // アカウントの認可を Pleiad から行う（core/claude-login.mjs）。進み具合は claudeLogin イベント。一度に 1 つだけ（始めると前のものは取り消す）
  'claudeLoginStart',    // { kind: setup-token|usage-login, accountId?, name?, open? } -> { loginId }。setup-token は accountId 無しなら name で新規追加
  'claudeLoginCode',     // { loginId, code } -> {}。ブラウザーに表示されたコードを CLI へ渡す
  'claudeLoginCancel',   // { loginId } -> {}
  'procwayConnections', 'procwayCheck', 'procwaySave', 'procwayDelete', 'procwayDefault', 'procwayModelLimits', 'procwaySettings',
  'contextSettings', // { cwd? } -> { defaults, places: [{ id, path, kinds: { <kind>: { value, override, from } }, roots, overrides, current }] } 種類ごとの設定と継承（core/context-settings.mjs）
  'slashSkills',     // { cwd } -> 入力欄「/」の候補。コンテキスト画面と同じ探索結果からのスキル一覧（説明文付き）
  'sessionContext', // { sessionId } -> { report, owners, pinned, changed, startedAt, refreshedAt, removedMcp } この会話が読み込んだ記録。固定された会話では今のファイルと突き合わせる
  'refreshContext', // { sessionId } -> 開始後に変わった指示・Skills を、やり取りを引き継いだまま読み込み直す（固定を取り直す）。返答中は不可
  'contextDiff',    // { sessionId } -> { files: [{ path, name, kind, modifiedAt, before, after, beforeMissing, removed }] } 開始時と今の中身
  'setSessionMcp',  // { sessionId, name, removed } -> この会話だけ外部 MCP を外す（ply_context に出さない）/ 戻す。次のターンから効く
  'agentMcp',       // { cwd } -> { agents: { claude|codex|procway: [{ name, transport, endpoint, command, path, scope, disabled }] } } 各エージェントの登録（読むだけ）
  'listMcpConfig', // { cwd, format, scope } -> native path, revision and names (no secrets)
  'readMcpServer', // { cwd, format, scope, name } -> explicitly opened server definition
  'saveMcpServer', // { cwd, format, scope, name, value, revision, mode } -> native registration
  // Pleiad 自身の MCP 登録（担当が Pleiad のときに Pleiad が接続するもの）。秘密の値は返さず、伏せ字（••••）で返す
  'listPlyMcp',    // {} -> { file, revision, servers: [{ name, transport, url, auth, authStatus, ... }], storage: { encrypted, backend, reason? } }
  'readPlyMcp',    // { name } -> { name, value（秘密は伏せ字）, revision }
  'savePlyMcp',    // { name, value, mode: add|edit, revision? } -> { name, oauthReset, registration, storage }。伏せ字のままの秘密は前の値を残す
  'deletePlyMcp',  // { name } -> 登録と秘密を消す。OAuth なら先に失効させる
  'mcpAuthStart',  // { name } -> { url, redirectUri }。ブラウザを開き、完了は mcpAuth イベント（phase: done|error）
  'mcpAuthStatus', // { name? } -> { servers: [{ name, state: signed-in|signed-out|expired|pending|locked|not-oauth, expiresAt?, scope?, client?: dynamic|manual|metadata-document, needsScope?, requiredScope?, message? }], storage }
  'mcpAuthLogout', // { name } -> { revoked, reason? }。revocation_endpoint があれば失効させ、トークンを捨てる
  'mcpReconnect',  // { name, cwd? } -> { status: connected|needs-auth|failed, tools, reason }。今の資格情報で接続を試す
  'renamePlyMcp',  // { name, to } -> { name, from, registration }。秘密・OAuth の状態・ロック名を引き継ぐ
  'importPlyMcp',  // { items: [{ format: claude|codex, scope: user|directory|local, cwd?, name, as?, auth? }], includeSecrets? } -> { results: [{ ok, name, auth, pending, needsLogin?, notes, error? }] }。トークンは流用しない
  'setPlyMcpSettings', // { clientMetadataUrl: https URL | null } -> 設定。Client ID Metadata Document の URL（既定は無し）
  'setContextSettings', // { place: null|path, kind, value|null } / { place, roots|null } / { place, add|remove } -> 即時保存し contextSettings と同じ形を返す
  'scanContext', // { cwd, place?: 'default' } -> bounded inventory (entries, the home / Git roots and the MCP config file bodies); never launches tools or changes agents
  "onboardingStatus",
  "onboardingSeen",
  "completeSetup",
  "runTurn",
  "sendMessage", "messageAction", "listMessages",
  "switchBackend",   // idle conversation -> a new native execution segment
  "abort",
  "listSessions",
  "loadSession",     // 履歴（本文 + present）を読み直す。outline: true は系譜の照合用に骨だけ返す
  "newSession",      // 空のセッションを開始する（最初の runTurn まで id は無い）
  "saveDraft",
  "deleteUnsentSession",
  "setTurnSettings", // durable agent/model/cwd/account choice, applied at the next runTurn（account: '' = ログイン中の Claude アカウント）
  "setStatus",
  "setGrouped",   // { sessionId, ungrouped }。fork のグループから外す / 戻す（§4.1）
  "setTitle",
  "fork",
  "resolvePermission", // 承認ダイアログの応答
  "listStatuses",    // 既出の状態一覧（補完候補。強制ではない）
  "setMode",         // 承認モードの切り替え（人間のみ）
  "efforts",         // { backend, model, cwd? } -> { '': { resolvesTo? }, [段]: { isDefault? } }
  "modes",           // 使える承認モードの一覧 { backend }
  "setModel",        // モデルの切り替え（人間のみ）
  "models",          // 使えるモデルの一覧 { backend, cwd? }。'' には resolvesTo（既定が実際に当たる id）と efforts / defaultEffort
  "listDirs",        // { path? } -> { path, parent, dirs: [名前], truncated, roots }。フォルダーだけ。path が空ならホーム
  "backends",        // 使えるバックエンドの一覧（capabilities / toolHints 付き）
  "authStatus",      // { backend } -> { supported, loggedIn?, account?, detail? }
  "authLogin",       // { backend }。URL は auth イベントで出る
  "authLogout",      // { backend }
  "authSubmit",      // { backend, input }。コールバックを取れないときの手貼り
  "running",         // いま動いているものの一覧
  "loadSubagent",    // サブエージェントの会話を読む
  "loadBackground",  // { sessionId, taskId } 裏の作業のコマンド・出力を読む
  "stopBackground",  // { sessionId, taskId } ターンの外で動いている裏の作業を 1 本止める
  "renameStatus",    // 状態の一括改名（to が空なら状態を外す＝グループ削除）
  "prefs",           // 次に新しく始めるときの既定
  "setPref",         // その既定を変える
  "attachFile",      // 人間が会話へ渡すファイル
  "suggestTitle",    // AI にタイトルを考えてもらう
  "setStatusIcon",   // { status, icon }。空なら「なし」（既定）に戻す
  "createStatus",    // { status }。空のグループを作る（statuses.json にある限り存在する）
  "lineage",         // { sessionId } -> 同じ根を持つセッション群（分岐の筋を描く材料）
]);

// event.type の一覧（server -> client の EVENT ペイロード）。
// 全イベントに sessionId が付く（emitGlobal が補う）。
export const EVENTS = new Set([
  'taskNotice',
  'usage', // cumulative per-execution token/cost measurements; unknown fields omitted
  "outbox", "userMessage",
  // { messageId } 途中送信がエージェントに渡った（会話に入った）。渡るまでの表示を消す合図
  "userMessage.delivered",
  // { messageId } 受理した途中送信を、エージェントが読まないままターンが死んだ。吹き出しを下げ、送信待ち（保留）へ戻す
  "userMessage.dropped",
  // ---- ターンの流れ（バックエンドが正規化して出す）
  "text.delta",      // { text }
  "text.end",        // { uuid? } 本文の追記が終わった。uuid は確定した発言の id（分岐の起点に使う）
  "thinking.start",  // 考え始めた
  "thinking.delta",  // { text?, estimatedTokens? }
  "tool.start",      // { id, name, input }
  "tool.result",     // { id, text, isError, truncated }
  "activity",        // { state: thinking|writing|compacting|waiting|running|idle, label? }
  "turnResult",      // { outcome: ok|error|aborted, turns?, costUsd?, error? }

  // ---- セッションとメタ情報
  "session",      // sessionId が確定した { sessionId, model? }（model は実際に解決されたもの）
  "backend",      // { backend } 会話の実行先が変わった
  "nextSettings",
  "claudeAccountsChanged", // Claude のアカウント一覧が変わった（sessionId は null）。中身は claudeAccounts コマンドで取り直す
  "claudeLogin",  // { loginId, kind, accountId, phase: url|code|verifying|done|error|cancelled, url?, message? } アカウントの認可の進み具合（sessionId は null）。トークンは載せない
  "sessionsChanged",
  "present",      // 成果物の提示
  "status",       // 状態が変わった
  "group",        // { ungrouped } fork のグループから外れた / 戻った
  "statusIcon",   // { status, icon } 状態グループのアイコンが変わった（sessionId は null）
  "title",        // タイトルが変わった
  "fork",         // 分岐した
  "permission",   // 承認が要る { id, kind: tool|question, toolName, input, canAlways, questions? }
  "auth",         // { backend, phase: url|done|error, url?, message? }
  "mcpAuth",      // { name, phase: url|done|error, url?, message? } Pleiad に登録した外部 MCP のログイン（sessionId は null）
  "mode",         // 承認モードが変わった
  "model",        // モデルが変わった
  "cwd",          // { cwd, by, reason } 再開のセッションの作業ディレクトリが変わった（次のターンから）
  // { names, count } 開始時と指示・Skills が変わっていたので、送信時に自動で読み込み直した（core/server.mjs の runTurn）
  "contextRefreshed",
  "running",      // 動いているものが増減した
  "turnEnd",
]);
