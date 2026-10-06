// core/・desktop/・bin/ がデータ置き場（や、その外のファイル）を書く・置き換える箇所の許可リスト（tests/unit/data-writes.mjs が突き合わせる）。
//
// 決まり（AGENTS.md「データ置き場の保存」、ADR 0115）: 記録の件数や会話の長さとともに大きくなる単一ファイルを、データ置き場に作らない。
// 件数で増える記録は DB（pleiad.db）の行にする。JSON ファイルは上限の決まったものだけで、上限と理由をここに書く。
// 新しく書く箇所を足したら、ここへ 1 件足す（file・sites・targets）。足せないなら、行にする。
//
//   file     core/・desktop/・bin/ の相対パス
//   sites    そのファイルにある書き込み呼び出しの数（tests/lib/data-writes-scan.mjs が数える。増減したら見直す）
//   targets  書く先ごとに:
//     name       データ置き場からの相対パス（外なら「(置き場の外)」と書く）
//     limit      大きさを決めるもの（定数名と値、または「ユーザーが数個作る」など）。空にしない
//     reason     丸ごと書いてよい理由
//     unbounded  true: 上限が決まっていない（件数・会話の長さで増える）うえに、変更のたびに丸ごと書く。既知の例外で、DB の行へ移す宿題（ADR 0115「影響」）。
//                増やさない。減らすときは行へ移したとき
//     appendOnly true: 追記だけで、丸ごとは書かない（1 回の更新が 1 行の追記。大きさは件数で増えるが、更新の重さは大きさに比例しない）。
//                ログ・操作の記録の置き場。件数の上限は決めない

export const DB_ONLY = ['sessions.json', 'agent-tasks.json', 'usage.json', 'conversations.json'];

export const DATA_WRITES = [
  { file: 'core/store.mjs', sites: 4, targets: [
    { name: 'prefs.json', limit: '設定。computerUse.alwaysAllowed は COMPUTER_APP_LIMIT=500、browserLastProfiles は 100。agentSitePermissions だけ上限が無い（エージェント×origin×プロフィール）', reason: '設定。読むのは起動時と変更時だけで、通常は数 KB', unbounded: true },
    { name: 'statuses.json', limit: '会話の状態グループ。ユーザーが数個作る', reason: '台帳。数十行以下' },
  ] },
  { file: 'core/atomic-file.mjs', sites: 2, targets: [
    { name: '(呼び出し側の書き込み先)', limit: '呼び出し側の許可に従う（writeAtomic は共通の土台）', reason: '一時ファイルに書いてから置き換える共通の部品。自分では書き先を決めない' },
  ] },
  { file: 'core/schema-migration.mjs', sites: 3, targets: [
    { name: 'data-schema.json', limit: '固定（{ schema: N }）', reason: '形式番号。移行の最後に 1 回だけ書く' },
    { name: 'backup-schema1-<日時>/（移行前の JSON と形式番号の写し）', limit: '移行 1 回につき JSON 5 つまで。移行前の大きさのまま増えない', reason: '移行前のデータの写し（docs/desktop-releases.md「適用とデータ保護」）。書き換えない。自動では消さない' },
  ] },
  { file: 'core/data-lock.mjs', sites: 1, targets: [
    { name: 'pleiad.lock', limit: '固定の小ささ（PID・トークン・時刻）', reason: 'データ置き場をプロセス単位で排他するロックファイル。終了で消す' },
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
  { file: 'core/voice/usage.mjs', sites: 1, targets: [
    { name: 'voice-usage.json', limit: 'KEEP_DAYS=31 日分（1 日 3 つの数）。書くたびに古い日を捨てる', reason: '通話の使用量の台帳（費用の安全弁。docs/voice-call.md）。数秒にまとめて書く。固定の小ささ' },
  ] },
  { file: 'core/schedule.mjs', sites: 1, targets: [
    { name: 'schedule.json', limit: '予約中の再開・送信の件数。実行すると行が消える', reason: '台帳。通常は数件。件数に上限は無い', unbounded: true },
  ] },
  { file: 'core/setting-approvals.mjs', sites: 1, targets: [
    { name: 'setting-approvals.json', limit: '承認待ちと通知の件数。決着・配達で消える', reason: '一時の台帳。通常は数件。件数に上限は無い', unbounded: true },
  ] },
  { file: 'core/worktrees.mjs', sites: 1, targets: [
    { name: 'worktrees.json', limit: 'worktree の数。削除で行が消える', reason: '台帳。通常は数個から数十。件数に上限は無い', unbounded: true },
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
  { file: 'core/secret-store.mjs', sites: 8, targets: [
    { name: 'mcp-secrets.json・claude-account-secrets.json・compat-endpoint-secrets.json・webhook-secrets.json・remote/secrets.json', limit: 'MCP サーバー・アカウント・接続先・端末の数。ユーザーが数個', reason: '暗号化した秘密。1 件ごとに小さい' },
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
  { file: 'core/folder-uploads.mjs', sites: 7, targets: [
    { name: 'uploads/…（manifest.json と、利用者が選んだ作業フォルダーへの写し）', limit: '手元のフォルダーの送信 1 回につき 1 組。7 日触られなければ掃除する', reason: '成果物と送信の途中の台帳。作業フォルダーへの書き込みは置き場の外' },
  ] },
  { file: 'core/git-info.mjs', sites: 2, targets: [
    { name: '(置き場の外) os.tmpdir() の pleiad-index-*', limit: 'git の索引 1 つの写し。呼び出しごとに作って消す', reason: '作業場所の git の索引を汚さずに差分を取るための一時ファイル（作業ツリーの撮影 snapshotTree と、ステージ済みの tree を読む indexTree の 2 か所）' },
  ] },
  { file: 'desktop/agent-browser-bin.cjs', sites: 1, targets: [
    { name: 'agent-browser-bin/agent-browser(.exe)', limit: '同梱の実行ファイル 1 つ。大きさが違うときだけ写し直す', reason: '開発時（未パッケージ）に実行ファイルを置き場へ写す。書き換えない成果物' },
  ] },
  { file: 'desktop/browser-panel.cjs', sites: 2, targets: [
    { name: '(置き場の外) Electron の userData の、消し残したブラウザープロフィールの名前の一覧', limit: 'プロフィールの数。消せたら行が消える', reason: '削除待ちの台帳。通常は 0〜数件' },
  ] },
  { file: 'desktop/server-port.cjs', sites: 1, targets: [
    { name: '(置き場の外) Electron の userData の、前回のポート', limit: '固定（{ port }）', reason: '画面の origin を保つための印' },
  ] },
  { file: 'desktop/updates.cjs', sites: 2, targets: [
    { name: '(置き場の外) Electron の userData の、更新の設定', limit: '固定（チャンネル・自動確認・自動ダウンロード・最後の版）', reason: '更新の設定。一時ファイルに書いて置き換える' },
  ] },
  { file: 'desktop/update-log.cjs', sites: 2, targets: [
    { name: '(置き場の外) Electron の userData の logs/updater.log と、1 世代前の updater.log.old', limit: 'MAX_BYTES=1MB を超えたら .old へ回す（2 つで約 2MB まで）', reason: '更新ライブラリーの記録。1 行ずつ追記し、回すときは名前を替えるだけ', appendOnly: true },
  ] },
  { file: 'core/bots/store.mjs', sites: 1, targets: [
    { name: 'bots.json', limit: 'bot の定義。人が 1 件ずつ作る（1 件の大きさは NAME_MAX=32 字・PERSONA_MAX_CHARS=6000 字・FOLDERS_MAX=20・SEND_TARGETS_MAX=100。件数の上限はコードに無いが、通常は数個から数十）', reason: '設定の台帳。増え方は利用量ではなく利用者の操作に比例する' },
  ] },
  { file: 'core/bots/service.mjs', sites: 1, targets: [
    { name: 'uploads/bot-icons/<botId>-<random>.(png|jpg|webp)', limit: 'マジックバイトを確かめた PNG・JPEG・WebP を ICON_INPUT_MAX=1MiB まで写す。画面からの画像は送信前に 256×256 WebP に縮小する。bot ごとに現行の 1 枚だけ保持する', reason: 'bot の画像アイコンの写し。保存成功後に古い写しを消す' },
  ] },
  { file: 'core/routines/store.mjs', sites: 1, targets: [
    { name: 'routines.json', limit: 'ルーティンの定義と最後に動いた時刻（last）。人が 1 件ずつ作る（1 件は NAME_MAX=80 字・PROMPT_MAX=12000 字。件数の上限はコードに無いが、通常は数個から数十）', reason: '設定の台帳。発火のたびに last を書き直すが、行は定義の数しか無い' },
  ] },
  { file: 'core/bots/inbox.mjs', sites: 1, targets: [
    { name: 'channels/inbox.json', limit: '送り終えた（sent）・結果不明（unknown）は新しい KEEP_DONE=100 件だけ。pending・delivering は配り終えると sent になる一時のもの', reason: 'bot へ届ける前の出来事の保存（保存できなければ受け付けない）。件数は一時の数と 100 に収まる' },
  ] },
  { file: 'core/channels/store.mjs', sites: 2, targets: [
    { name: 'channels/index.json', limit: 'チャンネル・DM の定義と既読の印（channels と reads）。チャンネルを作るのは人と AI で、件数の上限はコードに無いが、通常は数個から数十', reason: '設定の台帳。投稿は入れない（投稿は下の追記ログ）' },
    { name: 'channels/<channelId>.jsonl', limit: '投稿・編集・削除・リアクションの操作の数（1 行 1 操作）', reason: 'チャンネルの正本（ADR 0108）。追記だけで、1 投稿の保存が 1 行の追記。読むときに畳む', appendOnly: true },
  ] },
  { file: 'core/memory/store.mjs', sites: 2, targets: [
    { name: 'memory/user.md・memory/bots/<botId>.md', limit: '層ごとの記憶の件数（1 件は MEMORY_TEXT_MAX=300 字。層の件数の上限はコードに無い）', reason: '記憶の正本は人が読んで直せる markdown（ADR 0110）。変更のたびに 1 層を丸ごと書く。DB の行へ移すと、人が直せる形をやめることになるので、別の決定（ADR 0110 の置き換え）が要る', unbounded: true },
    { name: 'memory/log.jsonl', limit: '記憶の変更（add・edit・forget・unforget）の数', reason: '変更の記録（rev・墓石）。追記だけで、1 変更が 1 行', appendOnly: true },
  ] },
  { file: 'core/hooks-config.mjs', sites: 2, targets: [
    { name: '(置き場の外) 利用者の ~/.claude・~/.codex・プロジェクトの hooks 設定', limit: '利用者の設定ファイル', reason: 'データ置き場ではない' },
  ] },
  { file: 'core/mcp-config.mjs', sites: 2, targets: [
    { name: '(置き場の外) .mcp.json・~/.claude.json・~/.codex/config.toml', limit: '利用者の設定ファイル', reason: 'データ置き場ではない' },
  ] },
  { file: 'core/image-import.mjs', sites: 1, targets: [
    { name: 'uploads/<会話>/<時刻>_<名前>.(png|jpg|gif|webp|avif)', limit: '1 枚 IMPORT_MAX_BYTES=10MiB・同時 IMPORT_MAX_ACTIVE=6 件・1 回の貼り付けで 20 枚（貼る側）。先頭のバイトを確かめた画像だけ', reason: '貼り付けた HTML の画像の写し（ADR 0141）。添付と同じ置き場で、書き換えない（同名は枝番）' },
  ] },
  { file: 'core/server.mjs', sites: 5, targets: [
    { name: 'compaction-schedule.json', limit: '予約中の会話の数。猶予 8 分で捨てる一時のもの', reason: '自動圧縮の予約の台帳' },
    { name: 'onboarding.json', limit: '固定', reason: '初回表示済みの印とセットアップ結果' },
    { name: 'uploads/<会話>/<時刻>_<名前>', limit: '添付 1 つ 1 ファイル（ATTACH_MAX_BYTES=100MiB）', reason: '成果物（書き換えない）' },
    { name: '(置き場の外) AGENT_HOST_COMPUTER_LOG', limit: 'テスト用の環境変数が指すファイルへの追記', reason: 'テストの確認用。既定では書かない' },
  ] },
];
