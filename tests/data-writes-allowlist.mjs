// core/ がデータ置き場（や、その外のファイル）を丸ごと書く・置き換える箇所の許可リスト（tests/unit/data-writes.mjs が突き合わせる）。
//
// 決まり（AGENTS.md「データ置き場の保存」、ADR 0106）: 記録の件数や会話の長さとともに大きくなる単一ファイルを、データ置き場に作らない。
// 件数で増える記録は DB（pleiad.db）の行にする。JSON ファイルは上限の決まったものだけで、上限と理由をここに書く。
// 新しく書く箇所を足したら、ここへ 1 件足す（file・sites・targets）。足せないなら、行にする。
//
//   file     core/ の相対パス
//   sites    そのファイルにある書き込み呼び出しの数（tests/lib/data-writes-scan.mjs の WRITE_CALL。増減したら見直す）
//   targets  書く先ごとに:
//     name       データ置き場からの相対パス（外なら「(置き場の外)」と書く）
//     limit      大きさを決めるもの（定数名と値、または「ユーザーが数個作る」など）。空にしない
//     reason     丸ごと書いてよい理由
//     unbounded  true: 上限が決まっていない（件数・会話の長さで増える）。既知の例外で、DB の行へ移す宿題（ADR 0106「影響」）。
//                増やさない。減らすときは行へ移したとき

export const DB_ONLY = ['sessions.json', 'agent-tasks.json', 'usage.json', 'conversations.json'];

export const DATA_WRITES = [
  { file: 'core/store.mjs', sites: 5, targets: [
    { name: 'prefs.json', limit: '設定。computerUse.alwaysAllowed は COMPUTER_APP_LIMIT=500、browserLastProfiles は 100。agentSitePermissions だけ上限が無い（エージェント×origin×プロフィール）', reason: '設定。読むのは起動時と変更時だけで、通常は数 KB', unbounded: true },
    { name: 'statuses.json', limit: '会話の状態グループ。ユーザーが数個作る', reason: '台帳。数十行以下' },
  ] },
  { file: 'core/atomic-file.mjs', sites: 3, targets: [
    { name: '(呼び出し側の書き込み先)', limit: '呼び出し側の許可に従う（writeAtomic は共通の土台）', reason: '一時ファイルに書いてから置き換える共通の部品。自分では書き先を決めない' },
  ] },
  { file: 'core/schema-migration.mjs', sites: 2, targets: [
    { name: 'data-schema.json', limit: '固定（{ schema: N }）', reason: '形式番号。移行の最後に 1 回だけ書く' },
  ] },
  { file: 'core/agent-tasks.mjs', sites: 2, targets: [
    { name: 'agent-tasks-errors.log', limit: 'LOG_MAX=64KiB。超えたら新しい半分だけ残す', reason: '保存障害の記録。DB に書けないときの記録なので DB には置けない' },
  ] },
  { file: 'core/usage-migrations.mjs', sites: 1, targets: [
    { name: 'usage.v1-backup.json', limit: '移行の前に 1 回だけ（flag wx。既にあれば書かない）', reason: '直す前の記録の写し（ADR 0052）。増えない' },
  ] },
  { file: 'core/conversations.mjs', sites: 3, targets: [
    { name: 'conversations/<id>.json', limit: '会話の長さ（発言の数）', reason: '会話の本文。変更のたびに 1 会話分を丸ごと書く。索引（conversations）は行にした。本文を行へ移すのは別の作業', unbounded: true },
    { name: 'handoff-<sha256>.json', limit: '会話の長さ（ターンの始まりごとに全文の写しを書き直す）', reason: '引き継ぎで読ませる全文の写し。会話ごとに 1 ファイル', unbounded: true },
  ] },
  { file: 'core/history.mjs', sites: 3, targets: [
    { name: 'presents/<sessionId>.jsonl', limit: '提示物の件数（1 件は MAX_INLINE_BYTES=8MiB まで）', reason: '追記が主で、全体の書き換えは巻き戻し・添付の固定のときだけ。1 会話 1 ファイル', unbounded: true },
  ] },
  { file: 'core/backends/antigravity-store.mjs', sites: 2, targets: [
    { name: 'antigravity/<conversationId>.json', limit: '会話の長さ', reason: 'Antigravity の会話の控え。ターン中に何度も書き直す', unbounded: true },
  ] },
  { file: 'core/backends/antigravity-pids.mjs', sites: 1, targets: [
    { name: 'antigravity/pids.json', limit: '同時に動く agy の数', reason: '生きているプロセスの控え' },
  ] },
  { file: 'core/backends/antigravity-context.mjs', sites: 3, targets: [
    { name: 'antigravity/context/<pid>-<乱数>/…', limit: '1 ターン分の一時の home。数ファイル', reason: '終了時に消す一時ファイル' },
  ] },
  { file: 'core/schedule.mjs', sites: 1, targets: [
    { name: 'schedule.json', limit: '予約中の再開・送信の件数。実行すると行が消える', reason: '台帳。通常は数件。件数に上限は無い', unbounded: true },
  ] },
  { file: 'core/setting-approvals.mjs', sites: 1, targets: [
    { name: 'setting-approvals.json', limit: '承認待ちと通知の件数。決着・配達で消える', reason: '一時の台帳。通常は数件。件数に上限は無い', unbounded: true },
  ] },
  { file: 'core/worktrees.mjs', sites: 1, targets: [
    { name: 'worktrees.json', limit: '分けた作業場所の数。削除で行が消える', reason: '台帳。通常は数個から数十。件数に上限は無い', unbounded: true },
  ] },
  { file: 'core/context-settings.mjs', sites: 5, targets: [
    { name: 'context-scans.json', limit: 'ユーザーが設定した場所（places）の数。通常は数個から数十', reason: '探索の設定。件数に上限は無い', unbounded: true },
    { name: 'context-scans.v<N>-backup.json', limit: '形式の移行の前に 1 回だけ（flag wx）', reason: '形式移行前の写し。増えない' },
  ] },
  { file: 'core/claude-accounts.mjs', sites: 3, targets: [
    { name: 'claude-accounts.json', limit: 'Claude のアカウント。ユーザーが数個作る', reason: '設定の台帳' },
    { name: 'claude-usage/<id>/<印>', limit: 'アカウントごとに 1 つ。固定の小ささ', reason: '使用量ログイン済みの印' },
  ] },
  { file: 'core/compat-endpoints.mjs', sites: 3, targets: [
    { name: 'compat-endpoints.json', limit: '互換の接続先。ユーザーが数個作る', reason: '設定の台帳' },
    { name: 'run/claude-compat-<uuid>.json', limit: 'ターンごとに 1 つ。dispose で消す', reason: 'ターン中だけの一時ファイル' },
  ] },
  { file: 'core/ply-mcp.mjs', sites: 2, targets: [
    { name: 'mcp-servers.json', limit: 'Pleiad に登録した MCP サーバー。ユーザーが数個作る', reason: '設定の台帳' },
  ] },
  { file: 'core/ply-hooks.mjs', sites: 2, targets: [
    { name: 'hooks.json', limit: 'hooks の登録・担当・場所ごとの設定。ユーザーが数個作る', reason: '設定の台帳' },
    { name: 'hooks.broken-<日時>.json', limit: '修復ボタンを押すたびに 1 個', reason: '壊れた設定の退避' },
  ] },
  { file: 'core/notify/settings.mjs', sites: 1, targets: [
    { name: 'notify.json', limit: '固定', reason: 'この PC の通知設定' },
  ] },
  { file: 'core/secret-store.mjs', sites: 3, targets: [
    { name: 'mcp-secrets.json・claude-account-secrets.json・compat-endpoint-secrets.json・remote/secrets.json', limit: 'MCP サーバー・アカウント・接続先・端末の数。ユーザーが数個', reason: '暗号化した秘密。1 件ごとに小さい' },
    { name: '<上の秘密ファイル>.lock', limit: '固定の小ささ（pid だけ）', reason: 'ロックファイル' },
  ] },
  { file: 'core/remote/devices.mjs', sites: 2, targets: [
    { name: 'remote/settings.json・remote/devices.json・remote/resident.json', limit: 'リモートの設定と、ペアリングした端末の一覧。ユーザーが数個', reason: '設定の台帳' },
  ] },
  { file: 'core/control-file.mjs', sites: 1, targets: [
    { name: 'control.json', limit: '固定', reason: '起動中ホストの接続情報' },
  ] },
  { file: 'core/backend-shape-diagnostics.mjs', sites: 1, targets: [
    { name: 'backend-shape-errors.log', limit: 'MAX_BYTES=64KiB。超えたら新しい半分だけ残す。同じ組は重複させない', reason: '非公開形式の変化の記録' },
  ] },
  { file: 'core/computer-use/shots.mjs', sites: 2, targets: [
    { name: 'computer-use/shots.json', limit: '1 会話あたり MAX_SHOTS_PER_SESSION=300、合計 MAX_SHOTS_BYTES=1GiB で古い順に消す', reason: 'スクリーンショットの索引。画像の合計の上限で行数も間接的に抑えられる' },
    { name: 'computer-use/shots/<id>.jpg', limit: '1 枚 1 ファイル', reason: '成果物（書き換えない）' },
  ] },
  { file: 'core/context-runtime.mjs', sites: 1, targets: [
    { name: 'context-snapshots/<hash>.txt', limit: '内容アドレス。同じ中身は 1 つ（flag wx）', reason: '会話に固定した指示の本文。書き換えない' },
  ] },
  { file: 'core/visualize.mjs', sites: 1, targets: [
    { name: 'visualization-snapshots/<key>.html', limit: '1 つ 1 ファイル。24 時間で掃除する', reason: '可視化の写し。書き換えない' },
  ] },
  { file: 'core/agent-browser.mjs', sites: 1, targets: [
    { name: 'agent-browser/<hash>/agent-browser.json', limit: '固定（{ cdp }）', reason: '内蔵ブラウザーの接続先。ターンごとに上書き' },
  ] },
  { file: 'core/hooks-unify.mjs', sites: 2, targets: [
    { name: 'hooks-runtime/hook-adapter-<hash>.mjs', limit: 'アダプターごとに 1 つ。コードの複製', reason: '生成したコード' },
    { name: 'hooks-runtime の runs.jsonl（.1 へ入れ替える）', limit: '入れ替えで 2 世代まで', reason: '別プロセスのアダプターが追記する記録の世代交代' },
  ] },
  { file: 'core/hook-adapter.mjs', sites: 2, targets: [
    { name: '(置き場の外) os.tmpdir() の pleiad-hook-stop-*.json、アダプターの runs.jsonl への追記', limit: '固定の小ささ／追記', reason: 'データ置き場ではない。別プロセスで動くアダプター' },
  ] },
  { file: 'core/folder-uploads.mjs', sites: 5, targets: [
    { name: 'uploads/…（manifest.json と、利用者が選んだ作業フォルダーへの写し）', limit: '手元のフォルダーの送信 1 回につき 1 組。7 日触られなければ掃除する', reason: '成果物と送信の途中の台帳。作業フォルダーへの書き込みは置き場の外' },
  ] },
  { file: 'core/hooks-config.mjs', sites: 2, targets: [
    { name: '(置き場の外) 利用者の ~/.claude・~/.codex・プロジェクトの hooks 設定', limit: '利用者の設定ファイル', reason: 'データ置き場ではない' },
  ] },
  { file: 'core/mcp-config.mjs', sites: 2, targets: [
    { name: '(置き場の外) .mcp.json・~/.claude.json・~/.codex/config.toml', limit: '利用者の設定ファイル', reason: 'データ置き場ではない' },
  ] },
  { file: 'core/server.mjs', sites: 5, targets: [
    { name: 'compaction-schedule.json', limit: '予約中の会話の数。猶予 8 分で捨てる一時のもの', reason: '自動圧縮の予約の台帳' },
    { name: 'onboarding.json', limit: '固定', reason: '初回表示済みの印とセットアップ結果' },
    { name: 'uploads/<会話>/<時刻>_<名前>', limit: '添付 1 つ 1 ファイル（ATTACH_MAX_BYTES=100MiB）', reason: '成果物（書き換えない）' },
    { name: '(置き場の外) AGENT_HOST_COMPUTER_LOG', limit: 'テスト用の環境変数が指すファイルへの追記', reason: 'テストの確認用。既定では書かない' },
  ] },
];
