// host <-> core のプロトコル。
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
export const READY = "ready";   // { protocolVersion, version, homeDir, resumedTurn, startedAt（サーバーの起動時刻 ms）, locale, notify（スマホへの通知に対応していれば 1） }
export const EVENT = "event";
export const RESPONSE = "response";
export const ERROR = "error";
// PC の内蔵ブラウザーの画面（browserScreencast で見ている接続だけへ）。{ type: frame|state|ended, sessionId, seq?, data?（JPEG の base64）, metadata?, state?, reason? }
export const SCREENCAST = "screencast";

// client -> server
export const COMMAND = "command";

// server.mjs に case を足したらここにも足す。無いコマンドはサーバーが黙って捨て、テストの cmd は応答待ちのまま止まる
export const COMMANDS = new Set([
  // 操作の一覧（core/ops/）の汎用の口。新しい機能はこの 1 つで足し、ここには足さない（ADR 0080）
  'invoke',   // { op, args } -> その操作の返り値。失敗は code（NOT_FOUND・INVALID・READ_ONLY_MODE・NEEDS_UI・NEEDS_APPROVAL など）と、INVALID のとき issues: [{ path, code, message }]
  'agentTasks', 'agentTaskInstructions', 'cancelAgentTask',
  'retryAgentTask',             // { taskId, candidate: 'backend:model', account?, stop?, approved? } -> { task } | { confirm: { agent, mode } }。Claude の account は選んだ認証（'' はログイン中）。委譲カードの「別の候補でやり直す」
  // 委譲先の自動振り分け（core/delegation-routing.mjs。docs/agent-delegation.md「委譲先の自動振り分け」）。判定器のキーは返さない（hasKey だけ）
  'delegationRouting',          // { refresh? } -> { settings, defaults, kinds, judges, tiers, signals, keys: { openrouter|cerebras: { hasKey } }, storage, warnings, candidates }
  'setDelegationRouting',       // { settings } -> 同上。prefs.json の delegationRouting に重ねて保存（null の項目は既定に戻す）。不正なら全体を断る
  'setDelegationRoutingKey',    // { service: openrouter|cerebras, key } -> 同上。登録が判定器への外部送信の同意になる
  'deleteDelegationRoutingKey', // { service } -> 同上
  'providerUsage', // { backend } -> subscription quota + locally recorded usage（Claude はアカウントを登録していれば quota.accounts にアカウントごと）
  // Claude のアカウント（会話ごとに選ぶ。core/claude-accounts.mjs）。トークンは返さない
  'claudeAccounts',      // {} -> { accounts: [{ id, name, hasToken, usageLogin }], storage: { encrypted, backend, reason? } }
  'saveClaudeAccount',   // { id?, name, token? } -> 追加（id 無し。token 必須）/ 名前の変更・トークンの差し替え（id 有り。token を省けば残す）
  'deleteClaudeAccount', // { id } -> 一覧とトークンから消す（使用量の設定フォルダも）。選んでいた会話は次の送信でエラーになる
  // アカウントの認可を Pleiad から行う（core/claude-login.mjs）。進み具合は claudeLogin イベント。一度に 1 つだけ（始めると前のものは取り消す）
  'claudeLoginStart',    // { kind: setup-token|usage-login, accountId?, name?, open? } -> { loginId }。setup-token は accountId 無しなら name で新規追加
  'claudeLoginCode',     // { loginId, code } -> {}。ブラウザーに表示されたコードを CLI へ渡す
  'claudeLoginCancel',   // { loginId } -> {}
  // 互換の接続先（エージェントごと。会話ごとに選ぶ。core/compat-endpoints.mjs）。キーは返さない
  'compatEndpoints',        // { agent? } -> { endpoints: [{ id, agent, kind, name, baseUrl, auth, hasKey, roles, models, modelInfo, options, lastCheck, isDefault, ready }], defaults, storage }
  'compatEndpointCheck',    // { input, id? } -> { ok: true, receipt, auth, latencyMs, models, modelInfo, lines } | { ok: false, error, lines, code }。本物の 1 リクエストで確かめる
  'compatEndpointSave',     // { input, receipt, id? } -> { id }。確認の受領証が今の接続情報と合うときだけ保存する
  'compatEndpointRecheck',  // { id } -> { ok, lines?, error? }。保存済みを確かめ直して結果を記録する
  'compatEndpointDelete',   // { id } -> 一覧。キーも消す。選んでいる会話は次の送信の前に選び直しを求める
  'compatEndpointDefault',  // { agent, id } -> 一覧。新しい会話の既定（'' = 公式）
  // リモート（ホスト側。core/remote/connector.mjs、docs/remote.md §6.1）。どの画面からも触れる（全権限）。秘密・トークンは返さない
  // スマホ・この PC への通知（core/notify、ADR 0086）。presence は各画面の「いま見ている会話」、notifyRegister は中継越しのスマホの通知鍵と設定の登録
  'presence',             // { visible, sessionId } -> 'ok'。見ている会話を知らせる（変わるたびと 1 分ごと）
  'notifyStatus',         // {} -> { pc: { done, reply, failed }, devices: [{ id, name, platform, connected, notify: { registered, enabled, muted, lastSentAt } }], relayConnected }
  'setNotifyPc',          // { done?, reply?, failed? } -> notifyStatus。notifyStatus イベントで全接続へ
  'setNotifyDevice',      // { id, muted } -> notifyStatus。ホスト側でスマホ 1 台への通知を止める
  'notifyRegister',       // { key（base64url の 32 バイト）, settings } -> { registered, enabled, muted, lastSentAt }。端末の画面（中継越し）からだけ
  'remoteStatus',          // {} -> RemoteStatus（{ enabled, configured, relayUrl, hasEnrollSecret, hostName, hostId, connection, pairing: { offer, requests }, devices, storage }）
  'setRemoteSettings',     // { enabled?, relayUrl?, enrollSecret?, hostName? } -> RemoteStatus。enrollSecret は省けば残し、'' で消す
  'remotePairingStart',    // {} -> { payload, expiresAt, hostId, hostName }。payload は QR とコピーに使う pleiad://pair?... の文字列（5 分・1 回）
  'remotePairingCancel',   // {} -> RemoteStatus。入場券を取り下げる
  'remotePairingApprove',  // { id } -> 追加した端末 { id, name, platform, app, createdAt, lastSeenAt, connected, connections }
  'remotePairingDeny',     // { id } -> RemoteStatus
  'remoteDevices',         // {} -> 端末の一覧（RemoteStatus の devices と同じ）
  'remoteRevoke',          // { id } -> RemoteStatus。一覧と中継から消し、つながり中のチャネルを切る
  'setRemoteDeviceAgent',  // { id, enabled?, stopAll? } -> 端末の行（agent を含む）。この端末の AI からの委譲を受けるか（既定オフ。デスクトップ版の端末だけ）・任された作業をすべて止める。docs/remote.md §4.5
  'setRemoteResident',     // { keepRunning?, sleep?: 'working'|'always'|'off' } -> RemoteStatus。常駐の設定（§6.3。RemoteStatus.resident に { available, keepRunning, sleep }）
  'contextSettings', // { cwd? } -> { defaults, places: [{ id, path, kinds: { <kind>: { value, override, from } }, roots, overrides, current }] } 種類ごとの設定と継承（core/context-settings.mjs）
  'slashSkills',     // { cwd } -> 入力欄「/」の候補。コンテキスト画面と同じ探索結果からのスキル一覧（説明文付き）
  'sessionContext', // { sessionId } -> { report, owners, pinned, changed, startedAt, refreshedAt, removedMcp, added, plyParts } この会話が読み込んだ記録。固定された会話では今のファイルと突き合わせる。added は Pleiad が入れた指示、plyParts は Pleiad が足した文の量 [{ id, tokens }]（どちらも直前のターン。ADR 0056）
  // Pleiad の指示（core/ply-instructions.mjs）。担当によらず ply_agents を持つ会話へ毎ターン入る。すべての場所に共通
  'plyInstructions',    // {} -> { items: [{ id, tag: 'default'|'linked'|null, modified, name, body, target, agents, on, tokens }], total, routing }（文は画面の言語）
  'setPlyInstructions', // { action: 'save'|'toggle'|'delete'|'reset'|'order', … } -> 同上。prefs.json の plyInstructions に保存。始まっている会話にも次のターンから効く
  'refreshContext', // { sessionId } -> 開始後に変わった指示・Skills を、やり取りを引き継いだまま読み込み直す（固定を取り直す）。返答中は不可
  'contextDiff',    // { sessionId } -> { files: [{ path, name, kind, modifiedAt, before, after, beforeMissing, removed }] } 開始時と今の中身
  // git の動き（読み取りだけ。ADR 0085）。作業場所は会話の cwd（会話の無い下書きは、使ったことのある場所だけ）。git が無い・git 管理外は git: null
  'gitStatus',      // { sessionId?, cwd?, fresh?, summary? } -> { git: { root, linked, branch, detached, head, upstream, ahead, behind, changed, untracked, conflicts, dirty, at, session?: { files, add, del, commits } | null } | null }。summary: true は会話の間の合計も返す（委譲カード）
  'gitPanel',       // { sessionId, range?: 'uncommitted'|'session', only?: 'changes'|'light' } -> { git, timeline: [{ kind: branch|commit|pr, at, uuid, toolId, branch?, hash?, subject?, number?, url? }], changes: { range, hasSession, files: [{ path, orig?, state: A|M|D|R, add, del, binary, staged?, unstaged? }], total: { files, add, del }, groups?: { staged: [files], work: [files] }, failed? } | null, at } | { git: null }
  'gitDiff',        // { sessionId, range, path } -> { diff: { range, path, hunks: [{ header, lines: [{ t: '+'|'-'|' ', s }] }], binary, truncated } | null }
  'gitHistory',     // { sessionId, limit?, cursor? } -> { history: { root, head, commits: [{ hash, short, parents, author, at, refs: [{ kind: head|branch|remote|tag, name, pleiad?, detached? }], subject }], next, session: { n, at, head } | null } | null }。git log --branches --tags --remotes HEAD --topo-order（refs/pleiad/ は混ぜない）
  'gitCommit',      // { sessionId, hash } -> { commit: { commit: { hash, short, parents, author, at, subject, body }, merge, files: [{ path, orig?, state: A|M|D|R, add, del, binary }], total } | null }
  'gitWorktrees',   // { sessionId } -> { worktrees: { base: { path, branch, head }|null, total, rows: [{ path, branch, head, detached, locked, prunable, main, here, exists, dirty, ahead, behind, at, kind: here|plain|left|busy|clean, who?, leftover? }] } | null }
  'gitWorktree',    // { sessionId, worktree } -> { worktree: { path, head, base, committed: { files, total }, uncommitted: { files, total }, failed } | null }
  // worktree（ADR 0089）。作る・消すのはサーバーが決めた置き場・ブランチだけ（画面から任意のパスを受けない）
  'worktreeCheck',  // { sessionId?, backend?, mode? } -> { git, current: { id, branch, path, origin, … } | null, conflicts: [{ sessionId, title, child }], canSplit }。同じリポジトリで書き込み中の別の会話（読むだけの会話・git 管理外では出さない）
  'worktreeSplit',  // { sessionId? } -> { worktree: { id, branch, path, origin, … }, cwd }。今の作業場所の隣に worktree を作る。cwd の予約は画面が setTurnSettings で行う
  'worktreeDiscard', // { id } -> { action }。予約を取り消したときなど。使っていなければ片付ける（変更があれば残る）
  'worktreeKeep',   // { id, kept } -> { id, kept }。右パネルの「残す」
  'worktreeArchive', // { id } -> { action, ref?, why? }。退避の隠し ref に作業ツリー全体を撮ってから消す
  'worktreeRestore', // { ref } -> { worktree, cwd }。退避した作業場所を作り直す（右パネルの「元に戻す」）
  'setSessionMcp',  // { sessionId, name, removed } -> この会話だけ外部 MCP を外す（ply_context に出さない）/ 戻す。次のターンから効く
  'agentMcp',       // { cwd } -> { agents: { claude|codex: [{ name, transport, endpoint, command, path, scope, disabled }] } } 各エージェントの登録（読むだけ）
  'nativeInstructions', // { cwd, backend } -> { cwd, agent, entries: [{ id, name, path, scope, tokens }] | null } エージェント任せの指示を、そのエージェントの規則で探した量（読むだけ。ADR 0056）
  'contextFindings', // { sessionId, cwd, backend } -> { duplicates: [{ score, sides: [{ path, scope, root, line, segments: [{ text, common }] }] }], missing: [{ path, scope, line, target, from }], more: { duplicates, missing } } | null 指示の量の面の気になる所（重複・無いパス。読むだけ・保存しない。ADR 0056）
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
  'setContextSettings', // { place: null|path, kind, value|null } / { place, kind?, roots|null } / { place, add|remove } -> 即時保存し contextSettings と同じ形を返す
  'scanContext', // { cwd, place?: 'default', scope?: 'user' } -> bounded inventory (entries, the home / Git roots and the MCP config file bodies); never launches tools or changes agents
  // Hooks（各エージェントの元の設定ファイル。core/hooks-config.mjs）。コマンドは実行しない。一覧の値は伏せ字
  'scanHooks',    // { cwd?, scope?: 'user', trust? } -> { files: [{ agent, scope, path, status: missing|none|ok|error, count, revision, error? }], entries: [行], events, order, trustPending? }。trust: true で Codex の信頼状態（hooks/list）を重ねる
  'readHook',     // { agent, scope, base?, file, loc: { event, group, handler, name? } } -> 編集のシートを開くときだけ、その handler の command・timeout・async とキーの名前
  'hookTargets',  // { scope, base?, agents? } -> { <agent>: { path, format } | { error } } 追加の書き先
  'saveHooks',    // { items: [{ op: add|edit|delete|enable, agent, scope, base?, file?, revision?, loc?, event, matcher, name?, command, timeout, async, enabled? }], dryRun?, allowReformat? } -> { results: [{ ok, path, before, after, reformatsFile, error? }] }
  'copyHooks',    // { source: { agent, scope, base?, file, loc, revision? }, targets: [{ agent, scope, base?, name?, matcher?, revision? }], dryRun?, allowReformat? } -> { source, results: [{ agent, status: ready|review|blocked, reasons, warnings, event, matcher, name?, path, adapter?, before, after, revision, ok, written?, error? }] }。元の定義はファイルから読み直す
  'sessionHooks', // { sessionId, cwd, backend, trust? } -> { agent, cwd, report, observable, observed: all|pleiad|null, owner, unify（Pleiad がそろえた会話の記録）, runs: [{ phase, hookId, name, event, outcome?, exitCode?, pleiad?, id?, source?, leak?, ms?, at }] }
  // Pleiad の Hooks の登録と担当（<data>/hooks.json。core/ply-hooks.mjs、ADR 0049）。エージェントの設定ファイルは書かない
  'plyHooks',          // { cwd? } -> { defaults: { value: { owner, disabled } }, place: { value, override, from } | null, hooks: [登録（コマンドは伏せ字）], revision }
  'readPlyHook',       // { id } -> 登録 1 件（元のコマンド）。編集のシートを開くときだけ
  'savePlyHook',       // { value: { id?, name, agent, event, matcher, command, timeout?, async?, targets, matchers?, enabled }, cwd? } -> plyHooks と同じ形と id
  'removePlyHook',     // { id, cwd? } -> plyHooks と同じ形
  'togglePlyHook',     // { id, enabled, cwd? } -> plyHooks と同じ形
  'plyHookPreview',    // { value } -> { targets: { <agent>: { status: ok|blocked, reasons, warnings, event, matcher, adapter } | null } }。保存しない
  'hooksUnifyPreview', // { cwd?, direction: ply|native } -> { stops（止まる／再開する。importable・reasons）, keeps（動き続ける）, registry（登録ごとのエージェント別の渡し方）, owner, scope }
  'setHooksOwner',     // { place: null|path, value: { owner, disabled } | null, revision（確認票）, imports?: [{ id, digest }] } -> plyHooks と同じ形と added。取り込む定義はファイルから読み直し、digest と照合する
  'repairPlyHooks',    // { cwd? } -> plyHooks と同じ形。壊れた hooks.json を退避し、読めた部分だけで書き直す
  "onboardingStatus",
  "onboardingSeen",
  "completeSetup",
  "runTurn",
  "sendMessage", "messageAction", "listMessages", "compactConversation", "cancelCompaction", "setAutoCompaction", "setConversationAutoCompaction",
  // 入力欄の `!`（シェルの行。core/shell-runs.mjs、ADR 0054）。送信待ちにも送り直しの控えにも積まない。同じ runId は 2 度走らせない
  'runShell',   // { sessionId, runId, command, cwd? } -> { runId, duplicate? }。走り出したら返す。進み具合は shell.start / shell.output / shell.done、渡したら shell.handed
  'stopShell',  // { runId } -> { stopped }
  'skipShell',  // { sessionId, runId, skip } -> { runId, skip }。次の発言で渡すか（'host' の会話だけ。ADR 0055）。全部の接続へ shell.skip。渡しかけ・渡した後は断る
  "switchBackend",   // idle conversation -> a new native execution segment
  "abort",           // { sessionId?, reason?: user|update|quit } -> { aborted, reason }。sessionId 省略は全部。reason 省略・不正は user。止めた会話は interrupted { at, reason } で残る
  "resume",          // { sessionId } -> { sent: "outbox"|"text", count }。中断した会話を続ける（保留・送れなかった未送信を送り直す。無ければ理由ごとの文を送る）。実行中（SESSION_RUNNING）・中断していない（NOT_INTERRUPTED）・結果不明の未送信がある（OUTBOX_UNKNOWN）会話は断る
  "listSessions",
  "loadSession",     // 履歴（本文 + present）を読み直す。outline: true は系譜の照合用に骨だけ返す。watch: true はこの接続が開いた会話として登録する（下の watchSession）。from・check・presentFrom・presentCheck を付けると、持っている先頭が合うときだけ続きを返す（ADR 0062）
  "watchSession",    // { sessionId } 開いている会話を登録し直す。登録した接続には、流れの出来事をその会話の分だけ送る（turnEnd は全部。ADR 0024）
  "newSession",      // 空のセッションを開始する（最初の runTurn まで id は無い）。draft を渡すと入力欄の下書きとして保存する（送らない。「見直しを頼む」）
  "saveDraft",
  "deleteUnsentSession",
  "deleteSession",   // { sessionId } -> "deleted"。送った会話も Pleiad の記録から消す（sessions.delete。ネイティブの会話は残す。ADR 0147）
  "setTurnSettings", // durable agent/model/cwd/account choice, applied at the next runTurn（account: '' = ログイン中の Claude アカウント）
  "setStatus",
  "markRead",     // { reads: [[sessionId, completedAt], ...] } -> { reads: 変わった分 }。完了を確認した（ホストに 1 つ・大きい方だけ）。read イベントで全接続へ
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
  "listDirs",        // { path?, files? } -> { path, parent, dirs: [名前], files?: [{ name, size, mtime }], truncated, roots }。files が true のときだけファイルも。path が空ならホーム
  // ファイルの操作（web/file-actions.mjs）。path は会話の中の参照（相対は sessionId・at か base で解く）。許可範囲は /file-preview と同じ
  "hostCapabilities", // {} -> { osActions, hostName }。この接続がサーバーのある PC の画面からか（OS の操作を出してよいか・添付の出どころを選ばせるか）
  "resolvePath",      // { path, sessionId?, at?, base?, lenient? } -> { path（実体）, cwd, kind: file|directory }。lenient は読まずに在り処と cwd だけ（無くてもよい）
  "revealPath",       // { path, sessionId?, at?, base? } -> { path }。エクスプローラーでファイルを選んだ状態で開く（フォルダーはその中）。遠隔の接続は断る
  "openPath",         // 同上。HTML だけ。returnPath:true なら検査済みの実体パスを返し、OS では開かない。遠隔の接続は断る
  "openVisualization", // { sessionId, id? | at?, returnPath? } -> { path }。写しを書き、returnPath:true なら開かずに返す。遠隔の接続は断る
  "backends",        // 使えるバックエンドの一覧（capabilities / toolHints 付き）
  "authStatus",      // { backend } -> { supported, loggedIn?, account?, detail? }
  "authLogin",       // { backend }。URL は auth イベントで出る
  "authLogout",      // { backend }
  "authSubmit",      // { backend, input }。コールバックを取れないときの手貼り
  "running",         // いま動いているものの一覧
  "loadSubagent",    // サブエージェントの会話を読む
  "findSubagent",    // { sessionId, toolId } -> { agentId }。委譲ツールの tool_use id から、それが生んだサブエージェントを引く
  "loadBackground",  // { sessionId, taskId } 裏の作業のコマンド・出力を読む
  "stopBackground",  // { sessionId, taskId } ターンの外で動いている裏の作業を 1 本止める
  "renameStatus",    // 状態の一括改名（to が空なら状態を外す＝グループ削除）
  "prefs",           // 次に新しく始めるときの既定
  "setPref",         // その既定を変える
  "attachFile",      // 人間が会話へ渡すファイル。中身を 1 通で送る古い口（8MB まで）
  // 添付を断片で送る（1 件 100MB まで。core/folder-uploads.mjs と同じ仕組み・512 KiB の断片）。今の画面はこちらだけを使う
  "attachStart",     // { sessionId, name, mime, size } -> { uploadId, path, received, chunkBytes }
  "attachChunk",     // { uploadId, offset, data（base64）} -> { received }。data が空なら今の位置だけ
  "attachFinish",    // { uploadId } -> { path, bytes, kind }
  "attachCancel",    // { uploadId } -> { cancelled }
  // 貼り付けた HTML の画像（https）をホストが取りに行く（core/image-import.mjs、docs/adr/0141）
  "attachImport",    // { url, sessionId?, name?, importId? } -> { path, bytes, kind, mime, name }。取れなければ失敗（理由は画面に出さない）
  "attachImportCancel", // { importId } -> { cancelled }
  // 手元のフォルダーをホストへ送る（core/folder-uploads.mjs、docs/remote.md §8.1）。リモート専用ではない一般の口
  "uploadCheck",     // { name, dest?, paths } -> { dest, root, exists, inRoot, empty, conflicts, sample, needsConfirm }。送る前の下見
  "uploadStart",     // { name, dest?, files: [{ path, size, mtime }], overwrite } -> { uploadId, dest, received: [バイト], resumed, chunkBytes } | { needsConfirm, ... }
  "uploadChunk",     // { uploadId, file（files の位置）, offset, data（base64・512 KiB）} -> { received }。抜けがあれば書かずに今の位置
  "uploadFinish",    // { uploadId } -> { dest, files, bytes }。送り先へ移し、途中の置き場を消す
  "uploadCancel",    // { uploadId } -> { cancelled }
  "suggestTitle",    // AI にタイトルを考えてもらう
  "sessionChanges",  // { sessionId } -> { changes: [{ at, by, field, from, to, reason, reasonKey?, reasonParams? }] }。会話の変更の記録（会話の記録の history。古い順）
  "setStatusIcon",   // { status, icon }。空なら「なし」（既定）に戻す
  "createStatus",    // { status }。空のグループを作る（statuses.json にある限り存在する）
  "lineage",         // { sessionId } -> 同じ根を持つセッション群（分岐の筋を描く材料）
  // リモートの画面から PC の内蔵ブラウザーを見る・操作する（docs/inapp-browser.md「リモートから見る」）。リモートの接続からだけ使える（core/browser-screencast.mjs）
  'browserScreencast',       // { sessionId, url? | visualization?: { id?, at? }, width, height, scale, quality: auto|low } -> { tabId, state }。見始める（url があれば新しいタブ）
  'browserScreencastStop',   // { sessionId } -> {}。見るのをやめる（見る端末がいなくなれば止める）
  'browserScreencastAck',    // { sessionId, seq } -> {}。そのフレームを描き終えた（次のフレームを許す）
  'browserScreencastInput',  // { sessionId, input: { type: tap|scroll|text|key, x?, y?, dx?, dy?, text?, key? } } -> {}。エージェントが操作中は断る（code: agent-active）
  'browserScreencastNav',    // { sessionId, action: back|forward|reload|stop|open, url? } -> {}
  'browserScreencastAgent',  // { sessionId, action: stop|takeOver } -> {}。エージェントの接続を止める・引き継ぐ
  // コンピューターの操作（docs/computer-use.md）。ホストの OS を操作する命令ではなく止める側なので、リモートの端末からも受ける
  'computerStop',            // { sessionId } -> { stopped }。その会話の走っているターン（貸している先の子のターンも）に止めた印を付け、main へ computer-stop を送る
]);

// event.type の一覧（server -> client の EVENT ペイロード）。
// 全イベントに sessionId が付く（emitGlobal が補う）。
export const EVENTS = new Set([
  'taskNotice',
  // { text, messageId? } 中断で止めたものを、このターンの発言の前に添えてエージェントへ伝えた（text は伝えた中身。docs/design.md「中断と再開」）
  'interruptionNote',
  'usage', // { inputTokens?, outputTokens?, cachedTokens?, costUsd? } このターンの分（ターンの中では増えていき、最後の値が記録になる）。Claude は nativeSessionId と開始・終了時点の会話の累計 cumulativeStart / cumulativeEnd も付ける。分からない値は null か省略
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
  "tool.start",      // { id, name, input, turnId?, startedAt?, processId? }
  "tool.result",     // { id, text, isError, truncated }
  "activity",        // { state: thinking|writing|compacting|waiting|running|idle, label? }
  "compaction", "contextWindow", "compactionSchedule", "autoCompactionSettings", "conversationAutoCompaction",
  "turnResult",      // { outcome: ok|error|aborted, turns?, costUsd?, error?, reason? }。costUsd はこのターンの推計費用（Claude はターン開始時の累計からの差分）。reason は aborted のときの中断の理由（user|update|quit|hostAway）

  // ---- セッションとメタ情報
  "session",      // sessionId が確定した { sessionId, model? }（model は実際に解決されたもの）
  "backend",      // { backend } 会話の実行先が変わった
  "nextSettings",
  "worktreesChanged", // worktree が増えた・消えた（sessionId は null）。右パネルの「残っている worktree」を取り直す
  "agentTaskChanged", // { taskId } 依頼元が委譲の子の設定を替えた（sessionId は null。ADR 0134）。画面はその行を読み直す
  // ---- チャンネル・bot・記憶・ルーティン（docs/channels.md「WS の出来事」。どれも sessionId は null で全接続へ。リモートの端末にも届く）
  "channelsChanged", // { channel?: Channel, removed?: string } チャンネル・DM の定義と一覧の変化
  "channelPost",     // { channelId, op: add|edit|delete, post } 投稿の追加・編集・削除（bot のターンの投稿の進み具合は 1 秒に 1 回まで）
  "channelReaction", // { channelId, postId, reactions } リアクションの付け外し
  "channelThread",   // { channelId, threadId, thread: ThreadState } スレッドの状態（作業中・トークン・止めた印）
  "channelRead",     // { channelId, readAt } 別の端末・窓の既読
  "botsChanged",     // { bot?: Bot, removed?: string }
  "memoryChanged",   // { layer, rev } 記憶が増えた・直した・忘れた（中身は memory.list で取り直す）
  "brainChanged",    // { botId } bot の思考の流れ・気がかり・心拍の状態が変わった（中身は brain.view で取り直す。ADR 0126）
  "routinesChanged", // { routine?: Routine, removed?: string }
  // { rows: [{ role: system, kind: channelEvent | contextNote, … }] } bot の会話へチャンネルの出来事・記憶の包みを渡した（会話の sessionId 付き。
  // 履歴の splitLeadingNotes と同じ行の形で、画面は履歴と同じ描き方をする）
  "channelEvent",
  "notificationsChanged", // { unread, waiting } 通知の一覧（ベルのボタン。ADR 0149）の件数が変わった（sessionId は null。リモートの端末にも届く）。中身は notifications.list で取り直す
  "claudeAccountsChanged", // Claude のアカウント一覧が変わった（sessionId は null）。中身は claudeAccounts コマンドで取り直す
  "compatEndpointsChanged", // 互換の接続先の一覧・既定が変わった（sessionId は null）。中身は compatEndpoints コマンドで取り直す
  "delegationRoutingChanged", // change: settings|usage（旧送信元では省略）。sessionId は null。中身は delegationRouting コマンドで取り直す
  "claudeLogin",  // { loginId, kind, accountId, phase: url|code|verifying|done|error|cancelled, url?, message? } アカウントの認可の進み具合（sessionId は null）。トークンは載せない
  "remoteStatus",  // { status: RemoteStatus } リモートの設定・中継との接続・承認待ち・端末一覧が変わった（sessionId は null）
  "remotePairing", // { phase: connecting|request|approved|denied|cancelled|expired, request?, device? } ペアリングの進み具合。request のときに承認のダイアログを出す（sessionId は null）
  "sessionsChanged",
  "present",      // 成果物の提示
  "status",       // 状態が変わった
  "read",         // { reads: [[sessionId, readAt], ...] } 完了を確認した。どの端末・窓からの確認も全接続へ（sessionId は null）
  "group",        // { ungrouped } fork のグループから外れた / 戻った
  "statusIcon",   // { status, icon } 状態グループのアイコンが変わった（sessionId は null）
  "title",        // タイトルが変わった
  "fork",         // 分岐した
  "rewind",       // { renumbered, removed: { messages, userMessages } } 同じ会話の中で発言の手前まで巻き戻した（sendMessage の rewind）。画面は履歴を読み直す。renumbered は残る発言の uuid が変わった（Codex が別スレッドに差し替えた）
  // { requestId, outcome: allowed|denied|failed|superseded|restart } 設定の変更の承認（permission の settingChange）が決着した。カードを 1 行に畳む合図（ADR 0088）
  "settingApproval",
  "permission",   // 承認が要る { id, kind: tool|question, toolName, input, canAlways, questions?, browserSite?, computerApp? }。computerApp は ply_computer のアプリの承認 { agent: { id, label }, apps: [{ id, name, risk: normal|high }], reason?, first }（docs/computer-use.md）
  // { state: idle|running|waiting, holder?: { sessionId, title }, since? } コンピューターの操作のロック。running はこの会話のターンが持っている（借りている）、waiting は別の会話が操作中で待っている。承認と同じく全部の接続へ流す
  "computer.state",
  "auth",         // { backend, phase: url|done|error, url?, message? }
  "mcpAuth",      // { name, phase: url|done|error, url?, message? } Pleiad に登録した外部 MCP のログイン（sessionId は null）
  "mode",         // 承認モードが変わった
  "model",        // モデルが変わった
  "cwd",          // { cwd, by, reason } 再開のセッションの作業ディレクトリが変わった（次のターンから）
  // { names, count } 開始時と指示・Skills が変わっていたので、送信時に自動で読み込み直した（core/server.mjs の runTurn）
  "contextRefreshed",
  "running",      // 動いているものが増減した
  "turnEnd",       // { completedAt, outcome, interrupted: { at, reason } | null, requeued?, delegated? }
]);
