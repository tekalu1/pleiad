// LLM もサーバも要らないテスト。CI で常時回す。
//
//   npm test                          全部（同じプロセスで 1 本ずつ）
//   npm test -- markdown              名前で絞る（部分一致）
//   npm test -- --jobs 2              子プロセスの worker 2 本で並列に（重い suite から配る）
//   npm test -- --shard 2/3           3 分割の 2 番目だけ（時間の重み tests/suite-weights.json で決定的に分ける。CI のジョブ分けに）
//   npm test -- --timings out.json    suite ごとの時間・判定数・skip・worker を JSON で書く
//   npm test -- --list [--json]       走らせずに、選ばれた suite と重みを出す
//
// 落ちたテストは末尾にまとめて出る。終了コードで成否を返す（0 通過 / 1 失敗 / 2 引数か登録が不正）。
// 実行の仕組み（引数の解釈・登録の検査・分割・worker）は tests/lib/runner*.mjs。suite を足すときは下の一覧に 1 行足す（足し忘れ・重複は走る前に落ちる）。
//
// 画面とサーバーの言語は日本語に固定する（テストは日本語の文言に依存している。CI の OS の言語で変わらないように）。
// 英語のケースは i18n のテストが明示的に切り替えて見る。起動するサーバーにも環境変数で引き継がれる。
process.env.AGENT_HOST_LOCALE ||= "ja";
// データ置き場を一時ディレクトリへ向け、本物（~/.agent-host）を開こうとしたら例外にする。実行元の制御用の環境変数も外す。**どの import よりも前**（最初の import）。理由は tests/lib/test-env.mjs
import * as testEnv from "./lib/test-env.mjs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { main } from "./lib/runner.mjs";

const TESTS = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(TESTS, "..");

// 登録した suite（tests/ からの相対）。ファイルの `export const name` が名前。web/render.mjs はブラウザ前提なので、
// 読み込む**前**に DOM を差し替える（runner が読み込みの直前に installDomStub する）。
const SUITES = [
  './unit/compaction.mjs',
  './unit/server-compaction.mjs',
  './unit/limit-resume.mjs',
  './unit/server-limit-resume.mjs',
  './unit/send-schedule.mjs',
  './unit/server-scheduled-send.mjs',
  './unit/file-preview.mjs',
  // プレビューの横のツリー: 経路の段は必ず返す・遅延読み込み・件数の枠と枠の外の経路・除外名も全部出す・roots の外は読めない
  './unit/file-preview-tree.mjs',
  './unit/file-access.mjs',
  './unit/preview-links.mjs',
  // 文中の URL のリンク: 範囲の判定（ASCII の字まで）・リンクにする場所としない場所・行き先の一行と右クリックのメニューの項目
  './unit/url-links.mjs',
  // パスの自動リンク・画像の所在・ファイルの操作メニュー・OS で開く口（OS の窓は開かない）
  './unit/file-actions.mjs',
  // 右パネルの枠（web/side-panel.mjs）: モードごとの部品・渡さない部品は隠す・可視化の ⋯
  './unit/side-panel.mjs',
  './unit/refresh-batch.mjs',
  // 内蔵ブラウザー: 右パネルの表・アドレス欄・リンクの開き先・使える画面・main のタブと位置（偽の electron）
  './unit/inapp-browser.mjs',

  // computer use のオーバーレイと Esc: 窓・フェード・Esc の登録と解除・止める流れ・倍率の違うモニターの座標（偽の electron。OS の入力は送らない）
  './unit/computer-overlay.mjs',
  // computer use の main 側（desktop/computer/*）: キーの解釈・SendInput の中身・releaseAll・撮影の縮小・アプリの特定・service の列と止め方（偽の Win32。本物の入力は送らない）
  './unit/computer-native.mjs',
  './unit/header-entries.mjs',
  './unit/arc.mjs',
  './unit/agent-browser-relay.mjs',
  // 新規会話の最初のターンの中継のキーを、会話 ID が決まったとき本物へ付け替える（parentPort の身代わり）
  './unit/server-browser-rebind.mjs',
  // 内蔵ブラウザーのプロフィール（ADR 0078）: 保存領域・会話ごとの今のプロフィール・中継の絞り込み・AI の切り替え（ply_browser）・確認の鍵
  './unit/browser-profiles.mjs',
  './unit/browser-confirm.mjs',
  // 設定 › コンピューターの操作: prefs の検査と既定・store の remember/forget・hostCapabilities.computerUse の判定・節の動き・setPref（docs/computer-use.md）
  './unit/computer-settings.mjs',
  // コンピューターの操作（ply_computer。docs/computer-use.md）: アプリの判定の順・禁止の一覧・印の行・座標・スクショの保存
  './unit/computer-policy.mjs',
  // ロック: 1 つだけ・FIFO・待ちの上限・待ちを分ける・中断で抜ける・委譲の子へ貸す・止めた印
  './unit/computer-lock.mjs',
  // main への口（parentPort）: computer-* のメッセージの形・id での応答・エラーの code・ハートビート・偽の driver
  './unit/computer-driver.mjs',
  // 橋: MCP の面・座標の基準・ゲートの順・アプリの承認・止める・ロック画面・画像の渡し方（偽の driver）
  './unit/computer-bridge.mjs',
  // サーバー越し: 承認カードの payload・スクショの保存と配信・computer.state・computerStop・委譲の子の承認（fake + 偽の driver）
  './unit/server-computer.mjs',
  './unit/modes.mjs',
  // git の動き（ADR 0085）: 状態・差分の解析、コマンド結果からのタイムライン（ブランチ・コミット・PR）、ターンの始まりと終わりの隠し ref の撮影・要約・掃除（一時リポジトリ）
  './unit/git-info.mjs',
  './unit/git-history.mjs',
  './unit/git-graph.mjs',
  './unit/git-diff.mjs',
  './unit/git-panel-html.mjs',
  './unit/server-git.mjs',
  // git の動きの画面（ADR 0085）: 要約行・委譲カードの変更の行・したことの行・差分の面（色なし）・右パネルの表（gitSlots）
  './unit/git-view.mjs',
  // worktree の画面（ADR 0136）: 競合を知らせるチップと面・会話の中の静かな 1 行・残っている worktree の操作と結果の行・取り込みの依頼文
  './unit/worktree-view.mjs',
  // worktree（ADR 0089）: 作成と失敗の巻き戻し・片付けの判定・使用中は消さない・ジャンクションを外してから消す（リンク先が残る）・退避の隠し ref・台帳と git の突き合わせ（一時リポジトリ）
  './unit/worktrees.mjs',
  // worktree（サーバー越し）: ぶつかりの判定・明示的な作成（予約・取り消し・戻す）・委譲の isolate・完了通知と ply_task_status の作業場所の行・取り込み後の片付け・退避と作り直し
  './unit/server-worktree.mjs',
  // worktree を会話・委譲・画面につなぐ層: ぶつかりの判定・委譲で isolate が指定されたか・子の完了と片付け・準備中は消さない・残りの絞り込み・cwd を戻す・退避と作り直し
  './unit/worktree-host.mjs',
  // テストが本体の git に worktree を残さない守り（run.mjs の各テストの後の検査・AGENT_HOST_WORKTREES=off）: 増えた作業場所を見つける・他の worktree は数えない・off では作らない
  './unit/worktree-leak-guard.mjs',
  // 委譲の子の worktree: 子への指示・完了通知と status の「作業場所」の行・isolate の検査・ツールの定義
  './unit/agent-tasks-workspace.mjs',
  // 操作の一覧（core/ops/、ADR 0080・0081）: 権限の表（主体 × 危険度 × 会話の承認モード）・関所の順序と定義の検査・載せ忘れの lint（WS のコマンドと prefs のキーのラチェット）・
  // 一覧の中身（snapshot・文の量・主体ごとの見え方・伏せ字・辞書・JSON Schema）・WS の invoke をサーバー越しに
  './unit/ops-policy.mjs',
  './unit/ops-registry.mjs',
  './unit/ops-coverage.mjs',
  './unit/ops-surface.mjs',
  // 操作の一覧の中身（会話・設定・委譲）・MCP の生成器と橋・ply_control の 3 つのエージェントへの渡し方・サーバー越しの HTTP と権限の配線・CLI と pleiad mcp
  './unit/ops-sessions.mjs',
  // 会話・選べるもの・委譲の続き（sessions.new・abort・setTurnSettings・agents.*・delegation.retry ほか）: 危険度・人だけの項目・画面と AI の形・理由の記録・自分の子だけ
  './unit/ops-conversations.mjs',
  // 別の会話への送信（sessions.send）・送信待ちの取り消しと送り直し・既読（ADR 0104）: 強さの比べ方・歯止め・送り手の印
  './unit/ops-send.mjs',
  './unit/sessions-send-bot.mjs',
  './unit/server-ops-send.mjs',
  // pleiad CLI の起動口（ADR 0090）: 会話のシェルの PATH・外の AI の MCP の設定（app.cliSetup）・起動口の改行・デスクトップ版の同梱
  './unit/cli-launcher.mjs',
  // 設定を書く(settings.set): 全設定 × 全主体の判定・値の検査・承認カードと受領証・bypass で承認なし・束縛なしの NEEDS_UI（身代わりのサーバー）
  './unit/ops-settings.mjs',
  './unit/setting-change-ui.mjs',
  // MCP・Hooks・コンテキスト・リモートの操作（ADR 0095）: agent への伏せ字・伏せ字の書き戻し・guarded と riskOf
  './unit/ops-mcp-hooks.mjs',
  './unit/ops-session-work.mjs',
  './unit/ops-mcp.mjs',
  './unit/control-delivery.mjs',
  './unit/ops-control.mjs',
  './unit/ops-cli.mjs',
  // 設定の変更の承認: 待たずに返る・期限なしのカード・結果を会話へ届ける（ターンの終わり・中断・途中送信・置き換え・聞き直し・再起動。ADR 0088）
  './unit/server-setting-approval.mjs',
  // 委譲の子が出した承認の結果の届け先: 子のタスクが終わっていれば依頼元の会話へ、動いていれば子へ、再起動の取り下げも同じ（ADR 0088）
  './unit/server-setting-approval-delegated.mjs',
  './unit/server-ops.mjs',
  './unit/sessions-search-op.mjs',
  './unit/agent-tasks.mjs',
  './unit/agent-tasks-silence.mjs',
  './unit/task-command-notice.mjs',
  // 委譲の保存障害: rename のやり直し・閉じない・障害中の読み取り・requeue を書かない・再起動後の pending の送り直し（失敗は注入）
  './unit/agent-tasks-storage.mjs',
  './unit/agent-tasks-command-storage.mjs',
  // 完了通知: 受け取り済み（read）は送らない・同じ親の分は 1 つにまとめる・走っているターンへ渡す（steerable）と送り直し・途中送信の条件
  './unit/agent-tasks-notice.mjs',
  // 追加指示（ply_task_send）を走っている子のターンへ途中送信で渡す: 受理・合図・捨てられた・合図なし・順序・止めた後（ADR 0065）
  './unit/agent-tasks-steer.mjs',
  // 中断で委譲タスクを止める: 届いていない結果を捨てずに返す・取り消したものを返す・cancel は終わったタスクの通知を止めない・再起動で止まったもの
  './unit/agent-tasks-interrupt.mjs',
  './unit/server-delegation-notice.mjs',
  // 追加指示を走っている子のターンへ途中送信で渡す（fake の bg 台本。合図あり・なし、受理されない、結果不明、捨てられた、合図なし）
  './unit/server-delegation-steer.mjs',
  './unit/background-model.mjs',
  // 委譲の行: running は終わっていない・通知が届いていない短い行だけ。会話の分は agentTasks の tree・taskIds で読み、running を重ねる
  './unit/task-cards.mjs',
  './unit/server-running-slim.mjs',
  './unit/task-instructions.mjs',
  // 委譲した子の詳細: ツールだけの発言を本文が来るまで 1 つにまとめる・変更の記録の行（新しい順・項目・誰がの訳）
  './unit/tool-turns.mjs',
  './unit/change-log.mjs',
  // 作業の詳細: 走っている子の出来事（loadSession の live）を仮の発言に畳む・詳細とメインパネルが発言の描き方を共有する
  './unit/stream-messages.mjs',
  './unit/server-agent-tasks.mjs',
  // 委譲の子に裏の作業が残るとき: 終わらないコマンドも自動停止しない・サブエージェントは止めない・端末は待たない（子にも親にも）
  './unit/server-delegation-background.mjs',
  // 依頼元が子のエージェント・モデル・思考の強さを ply_task_send で替える（走っている子・走っていない子・断る場合・記録）
  './unit/server-delegation-settings.mjs',
  // 委譲の結果に選ぶ返答: Stop フックの続き（調べものだけ）は飛ばす・中身の仕事をした続きは選ぶ（Claude の transcript の印）
  './unit/delegation-result.mjs',
  // 委譲の子の履歴が一時的に読めない（Codex の 1546 disk I/O error）: 0.5・1・2 秒で読み直す・読めなければ流れた返答で注意書き付きの完了・ターン用の app-server の終わりを待つ
  './unit/history-retry.mjs',
  './unit/server-delegation-history-retry.mjs',
  // 委譲先の自動振り分け: 規則・段・使用量で飛ばす・Claude のアカウント・判定器（偽の fetch）・使用量の取り置き
  './unit/delegation-routing.mjs',
  // 同じくサーバー全体: kind の検査・自動で選んで子を作る・記録・設定とキーの口（偽の判定器と偽の agy）
  './unit/server-delegation-routing.mjs',
  './unit/server-delegation-routing-settings.mjs',
  // 同じく画面: 委譲カードの理由・内訳の文、やり直しの候補の並び、設定の差分（web/delegation-routing-view.mjs）
  './unit/delegation-routing-view.mjs',
  // Pleiad の指示: 担当によらず届く・依頼元と子で違う・足した指示・既定の編集・前の版のスイッチ・Codex のロード済みスレッド
  './unit/server-added-context.mjs',
  './unit/usage.mjs',
  // Claude の使用量: 開始時点の累計（cost-state）からの差分・resume 前の読み取り・既存の記録の移行（写し・冪等）
  './unit/claude-usage-delta.mjs',
  './unit/antigravity-usage.mjs',
  // 会話のヘッダーの使用量のチップ（web/header-usage.mjs）: 枠の選び方・アカウント・上限・グループのまとめ
  './unit/header-usage.mjs',
  './unit/effort.mjs',
  './unit/composer-agy.mjs',
  // 互換の接続先（保存・確認・キーを出さない・env と Codex の上書き）。偽の互換 API とだけ話す
  './unit/compat-endpoints.mjs',
  // リモート接続の暗号・フレーム・チャネル（core/remote/）。Noise の公式ベクトルと、メモリの管でつないだ往復
  './unit/remote-noise.mjs',
  './unit/remote-frames.mjs',
  './unit/remote-channel.mjs',
  // 互換の接続先のモデルの表示名（anthropic/ と [1m]）・検索（AND・件数の上限・自由入力）・display_name の保存と旧形式
  './unit/compat-models.mjs',
  // 入力欄の設定のチップ: フォルダーの一覧（listDirs）・「既定」の解決・エフォートの既定の段
  './unit/composer-settings.mjs',
  './unit/context-transports.mjs',
  './unit/context-runtime.mjs',
  // 外部 MCP の認証（担当が Pleiad のとき）。秘密の置き場、OAuth はローカルのモックの認可サーバー・MCP だけと話す
  './unit/mcp-secret-store.mjs',
  './unit/mcp-oauth.mjs',
  './unit/mcp-oauth-more.mjs',
  './unit/mcp-registry-more.mjs',
  // データ置き場を共有する 2 つのプロセス。本物の子プロセスを 2 本起動する
  './unit/mcp-oauth-processes.mjs',
  './unit/desktop-updates.mjs',
  './unit/desktop-exit-dialog.mjs',
  './unit/message-queue.mjs',
  // 送り終わった outbox は刈らない: 古い項目でも returned・undelivered・同じ ID の再試行が見つかる（ADR 0115）
  './unit/outbox-keep.mjs',
  './unit/message-steer.mjs',
  './unit/visualize.mjs',
  './unit/server-visualize.mjs',
  './unit/mcp-config.mjs',
  // Hooks: 3 エージェントの元の設定の探索（壊れたファイル・伏せ字）と書き込み（JSON / TOML・競合・enabled・部分成功）
  './unit/hooks-config.mjs',
  './unit/hooks-copy.mjs',
  './unit/server-hooks.mjs',
  // Hooks を Pleiad がそろえる: 正本と担当の保存・渡し方の組み立て・コールバックとアダプター・切り替えの確認
  './unit/hooks-unify.mjs',
  './unit/server-hooks-unify.mjs',
  // 同じくレビューの指摘ごと（漏れ・ガードの消失・確認の迂回）
  './unit/hooks-unify-review.mjs',
  './unit/server-hooks-unify-review.mjs',
  './unit/context-scan.mjs',
  // コンテキストの設定の形式 2 と、形式 1 からの移行（意味が変わらないこと）
  './unit/context-settings.mjs',
  // 探す場所を足す（追加ルート）: 種類ごと・探す形式に従う・形式 2 からの移行
  './unit/context-roots.mjs',
  './unit/server-context.mjs',
  './unit/context-ui.mjs',
  // 指示の量（ADR 0056）: 自分で書いた分と Pleiad が足した分・目安・エージェント任せの見積もり
  './unit/instruction-amount.mjs',
  // 気になる所: 違うファイルのほぼ同じ段落・もう無いパス（言語に依存しない判定）・サーバー越しの対象
  './unit/context-findings.mjs',
  // 見直しを頼む: 依頼文の下書き・下書き入りの未送信の新しい会話（送らない）
  './unit/context-review.mjs',
  './unit/slash-skills.mjs',
  './unit/notifications.mjs',
  // スマホへの通知（core/notify、ADR 0086）: 種類・抑制（見ている会話・古さ・短さ）・取り消し・暗号の往復と固定長・Android と共有する例・完了と失敗の保留
  './unit/push-notify.mjs',
  // ホスト（fake）→ 中継の通知の線 → 端末の代わりのクライアントで復号: 承認・質問・完了・失敗・取り消し・見ている会話・止めた端末・溜めて渡す
  './unit/server-push-notify.mjs',
  // 通知の画面側: この PC の設定・見ている間は出さない・失敗・presence の知らせ・設定 › 通知・スマホのアプリの帯と通知から開く会話
  './unit/notify-web.mjs',
  './unit/onboarding.mjs',
  './unit/tree.mjs',
  './unit/family.mjs',
  './unit/pending-sidebar.mjs',
  // 入力欄の待ち（web/composer-wait.mjs）: 会話を開く・初めての接続・読み込みの失敗・作成中の送信の予約
  './unit/composer-wait.mjs',
  // 承認カード: 受け取られるまで送信中・失敗はカードの中・決着後の一行に対象と開閉
  './unit/approval-card.mjs',
  // コンピューターの操作の表示: 行（題・動詞・サムネイル・止めた理由）・終わった塊の 3 行と「ほか N 件」・承認の中身・通知の見出し
  './unit/computer-use-ui.mjs',
  // 接続の状態（web/connection-status.mjs）: 切れた一行・読み上げ・古いトークンの案内と再確認、開くボタンの印、/auth-check
  './unit/connection-status.mjs',
  // 新しい会話を作っている間に書いた字が消えない・作成中の送信の予約・読み込み失敗で欄が戻る（client.mjs を vm で流す）
  './unit/composer-new-session.mjs',
  // 圧縮の区切りは発言を送っても動かない・放置中の圧縮の区切りは次の発言の前に置く（client.mjs の userMessage・paintCompactions）
  './unit/compaction-boundary-position.mjs',
  './unit/server-groups.mjs',
  './unit/audit-self.mjs',
  './unit/markdown-xss.mjs',
  './unit/tools-render.mjs',
  './unit/tool-bundle.mjs',
  // 作業の詳細の読み直し: 開いたツールの詳細・まとまり・長文の畳みを、作り直しの後も同じ所で開いたままにする
  './unit/view-state.mjs',
  './unit/timeline-images.mjs',
  './unit/attachment-order.mjs',
  // 自分の発言: 添付の印を本文の位置に置く（コードブロック内・一致しないパスは残す・古い形式は末尾）・畳み込み・別カードを二重に出さない
  './unit/user-message.mjs',
  // ホバーの無い端末で発言を押すと時刻を 4 秒出す（リンク・ボタン・コード・字の選択の上では出さない）
  './unit/message-peek.mjs',
  // 発言のメニュー（⋯・右クリック・キーボード）・長い発言の畳みを開く・送った直後の画像の枠（ADR 0067）
  './unit/message-actions.mjs',
  // 送り直しの帯（ADR 0102）: 消えるものの見立て・キー（Ctrl/⌘+Enter・Shift・Esc）・巻き戻しの印と提示の切り取り
  './unit/resend-band.mjs',
  // Claude の巻き戻し（resumeSessionAt・resumeDropsTurn を resume に添える。拒否は呼び出し側へ）: SDK の query を身代わりに
  './unit/claude-rewind.mjs',
  './unit/md-doc.mjs',
  // 貼り付けの HTML → 入力欄の形（ADR 0141）: 書式・リスト・引用・コード・リンク・表・画像の振り分け・構造の無い HTML は対象外・往復
  './unit/html-paste.mjs',
  './unit/prompt-title.mjs',
  // 添付の件数に上限が無い（下書き・送信）。出どころの印。1 件 8MB の上限は残る
  './unit/attach-no-limit.mjs',
  // 添付を断片で送る（1 件 100MB まで）: 境目・抜け・やめる・切れても続きから・大きな画像は会話にパスだけ
  './unit/attach-chunked.mjs',
  // 貼り付けた HTML の画像をホストが取りに行く口（ADR 0141）: https・公開アドレスのみ・リダイレクトの検査・大きさ・SVG と画像でない中身・やめる・置き場
  './unit/image-import.mjs',
  // 貼った画像の取り込みの画面側の段取り: 同時 3 枚・順番待ちのやめる・やめたあとの結果は捨てる・取れなければ静かに外す・読み上げ
  './unit/paste-images.mjs',
  // 入力欄と上端の見直し: 字の欄の上限・チップの字・添付の出どころ・パンくず・規則
  './unit/composer-layout.mjs',
  './unit/unread.mjs',
  // 中断と再開の画面（web/interrupt.mjs）: 三角の未読・理由の文言・再開ボタン・更新で止めた会話・更新の確認の作業一覧と進み
  './unit/web-interrupt.mjs',
  // 確認済み（既読）の置き場と、2 本の接続で共有されること（fake バックエンド）
  './unit/read-store.mjs',
  './unit/store-flush.mjs',
  // 再発防止（ADR 0115）: データ置き場への丸ごと書きは許可リスト（上限と理由）に載ったものだけ・件数が増えても 1 件の更新は全体を直列化しない
  // 形式 1（記録ごとの JSON）→ 2（SQLite）の移行: 成功・失敗しても元が残る・2 回目は移行しない・整形済み/compact
  './unit/schema-migration.mjs',
  // データ置き場のプロセス単位の排他: 生きている別プロセスがあれば止める・古いロックは取り直す・消した会話を更新で戻さない
  './unit/data-lock.mjs',
  // どの公開関数も、DB に書けなければ例外を返し、メモリは書く前のまま
  './unit/store-failures.mjs',
  // 保存が全部失敗しても、サーバーは落ちず、拒否を受け損ねない（[unhandledRejection] が出ない）
  './unit/server-store-failures.mjs',
  './unit/db-tables.mjs',
  // 実データの写しを作る道具: remote/ と秘密を写さない・DB は VACUUM INTO・委譲のタスクは既定で空
  './unit/copy-data-dir.mjs',
  './unit/data-writes.mjs',
  // 再発防止: テストが本物の ~/.agent-host を開いて移行で書き換えない（置き場は一時ディレクトリ・本物を開こうとしたら例外）
  './unit/test-guard.mjs',
  './unit/store-write-scale.mjs',
  './unit/server-read.mjs',
  // 開いている会話の宣言（流れの出来事を絞る）と、会話の一覧の使い回し（ADR 0024）
  './unit/server-watch.mjs',
  './unit/desktop-port.mjs',
  // デスクトップ版の端末（リモートの窓）: 窓ごとの信頼・preload の出し分け・バッジ。Electron は起こさない
  './unit/desktop-remote.mjs',
  // スマホの画面（docs/remote.md §8.3・§8.4）: UUID の代わり・長押し・「…」・狭い画面の規則
  './unit/mobile-web.mjs',
  './unit/stream-routing.mjs',
  './unit/stream-prefix.mjs',
  './unit/session-stream.mjs',
  // 長い履歴の実寸の確定: 見えている所の近くだけ（数は会話の長さによらない・issue #37）。確定してもスクロールの位置は動かない（末尾なら末尾に、読み返し中ならその位置に。列より広い窓でも）
  './unit/history-heights.mjs',
  // 会話の移動（web/conversation-nav.mjs）: 発言の抜粋（畳み・コード・添付）と件数の札
  './unit/conversation-nav.mjs',
  // 履歴を描く間、1 行ごとに筋を探し回らない（稼働表示の行は activity.el。issue #37）
  './unit/place-scan.mjs',
  // つなぎ直したときの静かな読み直しは、同じ発言の行を残して変わった所から後ろだけ描く（読み返している位置も保つ。issue #37）
  './unit/history-retain.mjs',
  // loadSession の差分（ADR 0062）: 合うときだけ続きを返す・つないだ結果は全量と同じ・合わなければ全量・画面の頼み方
  './unit/history-sync.mjs',
  './unit/server-history-diff.mjs',
  // 返答の本文は 1 コマに 1 回だけ描く・流れの終わりでは描き切る・会話を切り替えたら別の会話へ描かない
  './unit/stream-frames.mjs',
  './unit/work-attribution.mjs',
  './unit/work-status.mjs',
  './unit/background-labels.mjs',
  './unit/ask-answers.mjs',
  './unit/title-clean.mjs',
  './unit/claude-normalize.mjs',
  // 履歴のシステム側のメッセージ: 形（transcript の印）と文面での見分け・区切りへの要約・中断・teammate・文脈のタグ・保存分（ADR 0053）
  './unit/system-messages.mjs',
  // bot の会話の先頭の包み（記憶・チャンネルの出来事）の組み立てと剥がし・本文の閉じタグが外へ出ない・id と発言者
  './unit/system-messages-leading.mjs',
  // 入力欄の `!`（ADR 0054）: ホストで走らせる・止める・上限・同じ runId・Claude に渡す形・Codex の userShell の履歴
  './unit/shell-runs.mjs',
  // 同じく入力欄の形: `!` を打つ・貼り付けでは入らない・Backspace で戻る・使えない会話・文として送る・入力欄に写す
  './unit/shell-composer.mjs',
  // 同じくサーバー越し（fake）: 走らせる・送信待ちに入らない・次の発言で渡す・開き直した履歴・使えない会話・Codex の thread/shellCommand
  './unit/server-shell.mjs',
  './unit/claude-background.mjs',
  // Claude の途中送信の渡った合図（uuid・まとめ取り出し・次の内部ターン）と中断の interrupt。SDK の query を身代わりにする
  './unit/claude-steer-stop.mjs',
  // Claude のターンの終わり: Stop フックの続き・裏へ回ったまま終わらないコマンド（stopTask で終わる）
  './unit/claude-turn-end.mjs',
  // Claude のモデル一覧: CLI の実体（版）が変わったら 30 分の TTL の中でも引き直す
  './unit/claude-catalog-cli-version.mjs',
  // Claude のモデル一覧: 手元に古い一覧・別の作業場所の一覧があれば、引き直しを待たずに返す
  './unit/claude-catalog-stale.mjs',
  './unit/codex-background.mjs',
  './unit/codex-terminals.mjs',
  './unit/event-session-id.mjs',
  './unit/lineage.mjs',
  './unit/branches.mjs',
  // 見た目の規則。web/ の CSS と index.html を lint する（docs/design-system.md §5）
  './unit/design-lint.mjs',
  // 多言語対応。翻訳漏れの lint（直書きの日本語のラチェット・辞書の揃い）と、言語の解決・書式・setPref locale
  './unit/i18n-lint.mjs',
  './unit/i18n.mjs',
  // core・desktop の文言の言語切り替えと、保存される文言（変更の理由・添付の見出し・既定のタイトル）
  './unit/i18n-server.mjs',
  // エージェントに渡す文（指示・ツールの説明・完了通知・タイトル生成・承認の拒否の理由）が会話の言語になる
  './unit/i18n-agent.mjs',
  './unit/codex-mode.mjs',
  // model/list のページ送り・覚える長さ・ログイン / ログアウトで捨てる・タイトル生成のモデル選び
  './unit/codex-models.mjs',
  './unit/codex-child-routing.mjs',
  // Codex の実行前の拒否: rollout の解析（code mode・直接・wait・プロセス作成の失敗・引用の除外）・読む範囲・伏せ方・Codex の子への指示
  './unit/codex-rejections.mjs',
  './unit/backend-shape-diagnostics.mjs',
  // 同じくサーバー全体: 会話にツールのエラーとして出す・委譲の rejections・完了通知・ply_task_send の次の回（Codex は身代わり）
  './unit/server-codex-rejections.mjs',
  // fake バックエンドでサーバを立てる。LLM は呼ばないので、ここに入れてよい
  './unit/server-fake.mjs',
  // 中断の順序（実際の中断が先、Pleiad タスクの後始末は後）と「中断している」の知らせ。fake バックエンドだけ
  './unit/server-abort.mjs',
  // テストの補助 runTurn（tests/lib/ws-client.mjs）が、裏で別の会話のターンが終わっても自分の会話の終わりまで待つ。fake バックエンドだけ
  './unit/ws-client-run-turn.mjs',
  // 中断を会話の状態として残す・再開（保留の送り直しか理由の文）・委譲の子の中断・再起動で落ちたターン
  './unit/server-interrupt-resume.mjs',
  // 中断で止めたもの（委譲タスク・届いていない結果・裏のコマンド・承認待ち・再起動）を残し、中断の後の最初のターンで 1 回だけ伝える
  './unit/server-interrupt-stops.mjs',
  // Claude のアカウント切り替え（会話ごとのトークン）。env の組み立てと、server の配線を fake で通す
  './unit/claude-accounts.mjs',
  './unit/server-claude-accounts.mjs',
  // アカウントの認可を Pleiad から回す（疑似端末の偽物と、偽の CLI を本物の疑似端末で）
  './unit/claude-login.mjs',
  './unit/server-claude-login.mjs',
  './unit/server-background.mjs',
  './unit/server-handoff.mjs',
  // 対応を終えた procway-code の会話・設定が残っていても安全に動く
  './unit/server-retired.mjs',
  './unit/server-fork.mjs',
  // 同じ会話で巻き戻して送り直す（sendMessage の rewind。ADR 0102）: バックエンドの形ごと（Claude・拒否・Codex・巻き戻せない）× 実行中・送信待ち・検査。契約は身代わりのネイティブで
  './unit/server-rewind.mjs',
  './unit/server-ux.mjs',
  // 変更の記録: sessionChanges の返す形と、statusByAi（AI が状態を変えたときだけ印。人が変えたら null）
  './unit/server-session-changes.mjs',
  // 最近の場所の候補: Pleiadで使った実在フォルダーのみ・委譲やネイティブ一覧や消えた場所を除外
  './unit/cwd-recent-places.mjs',
  './unit/conversations.mjs',
  './unit/conversations-storage.mjs',
  // セッション検索（core/session-search.mjs）: 照合（AND・NFKC・"…"・場所はフォルダー名）・発言者・委譲・期間・関連度の順・抜粋の ranges・写しの更新と partial
  './unit/session-search.mjs',
  // 読み込み元（core/session-search-host.mjs）: 保存分は直接・それ以外は getMessages・完了通知とコマンドの行とツールの出力は写さない
  './unit/session-search-host.mjs',
  // 脇の検索の手元の照合（web/session-find.mjs）: core と同じ規則・並び・期間・最近の検索・近道
  './unit/session-find.mjs',
  // codex バックエンド。app-server の身代わり（tests/lib/fake-codex.mjs）と話すだけで、
  // 本物の codex もネットワークも要らない
  './unit/server-codex.mjs',
  // 互換の接続先の配線。codex の身代わりと偽の互換 API だけと話す
  './unit/server-compat-endpoints.mjs',
  // 同じことを本物の Claude Code・Codex の CLI で（送り先は偽の互換 API。入っていなければとばす）
  './unit/server-compat-real-cli.mjs',
  // antigravity バックエンド。agy の身代わり（tests/lib/fake-agy.mjs）と話すだけで、
  // 本物の agy も Google のログインも要らない
  './unit/server-antigravity.mjs',
  // 控えはターンの途中から書く: 途中の書き込み・失敗／中断で残る・uuid が変わらない・forget した控えを作り直さない・書き込みは 1 本ずつ
  './unit/antigravity-partial-transcript.mjs',
  // Pleiad の MCP 登録と認証の API、1 件つながらなくても会話が進むこと、antigravity では Pleiad 担当を開かないこと
  './unit/server-mcp-auth.mjs',
  './unit/server-agy-context.mjs',
  // コンピューターの操作（ply_computer）: 3 つのエージェントへの注入（MCP・上限時間・指示文・承認・同梱を切るキー）と、印の行からの正規化
  './unit/computer-delivery.mjs',
  // 同じことをサーバーの橋（偽の driver）から Codex・Antigravity の身代わりへ: 注入・正規化・履歴・委譲の子・設定でオフ
  './unit/server-computer-delivery.mjs',
  // インストールからログインまでの導線（未インストール -> 再起動なしで発見 -> 認可コード）
  './unit/antigravity-onboarding.mjs',
  // 孤児の agy の掃除。**名前を確かめてからでないと落とさない**
  './unit/antigravity-pids.mjs',
  // 同じ身代わりで、ターン途中の送信をその区切りへ差し込む（serve の steer）
  // リモートの中継（relay/server.mjs）。空きポートで立て、素の WebSocket で照合・行き先・上限を叩く
  './unit/relay.mjs',
  // リモートのホスト側（core/remote/connector.mjs）。中継をこのプロセスで、fake のサーバーを別プロセスで立て、試験用の端末で往復する
  './unit/remote-host.mjs',
  // 設定 › リモートの部品と常駐（トレイ・スリープ。Electron は差し替える）、setRemoteResident
  './unit/remote-settings.mjs',
  // リモートの端末側（core/remote/device*.mjs）。中継とホストを立て、端末内プロキシの URL を素の HTTP と ws で叩く
  './unit/remote-device.mjs',
  // 手元のフォルダーを送る口（core/folder-uploads.mjs）: パスの検査・送り先・続きから・中断・上書きの確認・掃除、WS での往復
  './unit/folder-uploads.mjs',
  // 同じ口を端末内プロキシ → 中継 → ホストで。50 MiB・2000 件が流量の制御の下で届くこと、中継が落ちても続きから送れること
  './unit/remote-upload.mjs',
  // モバイルの殻（mobile/）の取り決め: plyRemote の形・平文はループバックだけ・依存の版の固定・殻の辞書
  './unit/mobile-shell.mjs',
  // リモートでリンクを押したときの行き先（localhost の知らせ・写しはアプリの中・Web は端末のブラウザー）
  './unit/remote-links.mjs',
  // リモートから PC の内蔵ブラウザーを見る: フレームの間引き・止める条件・ローカルとエージェント操作中の断り・入力の変換・シートの出し分け
  './unit/remote-browser-view.mjs',

  // ==== bot・Channels・ルーティン（docs/channels.md、ADR 0106〜0114）。パッケージごとの区画。各パッケージは自分の区画の下にだけ足す（並列の衝突を避ける）====
  // つなぎ目（core/bots-host.mjs）と土台: 空のままでは何も変えない・例外を出さない・使用量の sessionId・fake の台本の包み外し
  './unit/bots-host.mjs',
  // --- channels (S1) ---
  // チャンネルの保存（index.json・.jsonl の追記と畳み込み・壊れた行・threads.json・投稿とリアクションと出来事）・@ の解析・操作（主体から発言者を決める・危険度・口）
  './unit/channels-store.mjs',
  './unit/channels-mentions.mjs',
  './unit/ops-channels.mjs',
  // --- bots (S2) ---
  // bot の定義の保存: 名前の一意・予約名・読めない bots.json は上書きしない・同時の作成の直列化
  './unit/bots-store.mjs',
  // bots.* の操作: 作成と DM・AI が見える操作と見えない操作・フォルダーを広げる向きは承認・承認モードは人だけ・Antigravity は yolo だけ・削除
  './unit/ops-bots.mjs',
  // bot の人格の文（毎ターン同じバイト列）・フォルダーの渡し方・3 つのバックエンドへの渡し方・agy の起こし直しの判定
  './unit/bot-instructions.mjs',
  // --- memory (S3) ---
  // 正本（markdown・log.jsonl・手で壊した行・墓石・rev）と、索引（FTS5 と、node:sqlite を読み込めないときの走査・壊れた索引の作り直し）
  './unit/memory-store.mjs',
  './unit/memory-index.mjs',
  // 出どころの検査（人の発言・taint・AI だけの根拠・墓石・長さ・注入らしい文）と、memory.* の操作（主体・層・危険度）
  './unit/memory-sources.mjs',
  // 末尾の文: 差分・関係する記憶・渡し済みを繰り返さない・核の写しは始まりと圧縮の後だけ・時刻は末尾だけ
  './unit/memory-tail.mjs',
  // 記憶の強さ（重み × 新しさ・種類）・markdown の後方互換（知らないキーを捨てない）・核の写しは強さの順で薄れたものを外す（ADR 0118）
  './unit/memory-strength.mjs',
  // --- dispatch (S4) ---
  // bot を起こす・配る: @ で起こす・返事の @ で連鎖・［止める］・途中送信とたまった出来事・DM・暗黙では起こさない・末尾（記憶の核の写し）・再起動の戻し・inbox.json
  './unit/bot-dispatch.mjs',
  // bot の投稿へのリアクション（問いへの答えは人・bot・AI のどれでも起こす・bot と AI は予算の内・ほかは次に渡す）と、黙って終えたターン（印・括弧だけの一言は投稿しない。ADR 0109・0119 の追記）
  './unit/bot-reactions-silence.mjs',
  // @ の無い投稿の宛先と、聞こえた投稿の手がかり（引用した bot が宛先・無ければ最後に話した bot。宛先の名前を包みの to に付ける。ADR 0128 の追記）
  './unit/bot-heard-addressee.mjs',
  './unit/bot-budget.mjs',
  './unit/thread-budget-ui.mjs',
  // bot の頭の中（ADR 0126）: 欲求・ふるい・返事の読み取り・思考の流れの束・独り言の写り・思考の流れと気がかりの保存
  './unit/brain-core.mjs',
  // 心拍（ふるい → 安いモデル → 引き継ぎ・予算・失敗・止める・下限）と、予算の心拍の分
  './unit/brain-pulse.mjs',
  // サーバー越し: 心拍を入れた bot（呼ばれたターンの末尾・引き継ぎ・結果の行・予算・漏れ・隠れた会話の書き込みの拒否）
  './unit/brain-server.mjs',
  // bot の予約（ADR 0140）: 時刻に 1 回起こす・止まっていた間に重なった予約は 1 回・再起動で残る・予算なし／休憩中は待つ・止めたスレッドは起こさない・取り消し
  './unit/brain-wakes.mjs',
  './unit/brain-wakes-server.mjs',
  // bot の会話は Chats の一覧に出さず、あなた待ちのときだけ出す（一覧の行の bot・承認待ち・検索の除外・スマホ通知）
  './unit/bot-sessions-list.mjs',
  // --- channels-ui: 脇・流れ・スレッド・bot のページ (W1・W2・W3・W4) ---
  // 脇 (W1): Channels の並べ方・bot の状態・タブの点・検索の横断の行と開く先・Chats の木の bot の会話の行の配線（描画は目視と session-list-keys.cjs）
  './unit/channels-side-ui.mjs',
  // 流れ (W2): @ の補完の判定・候補の絞り込み・リアクションの札と先取り・時刻の文言・スレッドを開く口の配線（描画とキーは tests/browser/channels.cjs）
  './unit/channels-feed-ui.mjs',
  // 入力欄を Chats に揃えた分 (ADR 0116): 送る本文と添付の印・書きかけの保存と上限・添付つきの投稿の描き方・配線。画面の打鍵は tests/browser/channels-composer.cjs
  './unit/channels-composer-ui.mjs',
  // bot のページの決まりごと（フォルダーを限れないモードは範囲 full だけ・承認モードの選び直し・使用量・記憶の出どころの行き先）。画面の打鍵は tests/browser/bot-page.cjs
  './unit/bot-page-model.mjs',
  // スレッドと空間モデル (W3): 窓の状態（feed・split・solo）の判定・題とトークンの文言・道具の呼び出しを引く範囲・配線。描画・動き・承認のカードは tests/browser/thread-deck.cjs
  './unit/thread-deck.mjs',
  // --- routines (R1・R2・W5、P2) ---
  // ルーティンの式 (R1): 5 欄の cron の解析と次の時刻・毎日/毎週/間隔（時間帯つき）の次の発火・トリガの検査・頻度の目安・イベントの選び方
  './unit/routines-cron.mjs',
  // ルーティンのサービス (R1): 予約と発火・取りこぼしは最新の 1 回・一時停止と再開・実行の状態・走っている間はスキップ・承認の期限・イベントのトリガ・試しの実行・広げる向き・保存
  './unit/routines-schedule.mjs',
  // routines.* の操作: 口の出し分け・危険度・AI が作ると承認・広げる向きの update は承認・resume / run / delete は承認・試しの実行・失敗の code
  './unit/ops-routines.mjs',
  // ルーティンをサーバー越しに: 毎分の実行のスレッド（テストの時計）・取りこぼしは起動時に 1 回・一時停止と再開・イベントのトリガ・承認の期限・試しの実行
  './unit/routines-server.mjs',
  // ルーティンの編集 (W5): 検査・保存する欄・cron の見積もり・脇の並べ方・一覧の写し・入口の配線。画面の打鍵は tests/browser/routine-sheet.cjs
  './unit/routine-sheet-model.mjs',
  // --- memory-learn・sessions-send・webhook (L1・X1・H1、P3) ---
  './unit/webhook.mjs',
  './unit/memory-learn.mjs',
  './unit/memory-episodes.mjs',
  // 夜の整理の走り方: ほかのターンで止まらない・走っている会話は次へ・飛ばした回数と理由・失敗の間隔・対象を絞った実行（ADR 0118）
  './unit/memory-learn-schedule.mjs',
  // テストランナー自身（tests/lib/runner*.mjs）: 引数・登録の検査・--shard の分け方・--jobs の worker・異常系・環境の隔離。試験用の小さな suite を子プロセスで走らせる（実際の suite は走らせない）
  './unit/runner-contract.mjs',
  // リリースで使う同一 commit の main CI の照合と公開前の検証条件
  './unit/release-ci-gate.mjs',
];

const code = await main({
  suites: SUITES,
  baseDir: TESTS,
  unitDir: path.join(TESTS, "unit"),
  argv: process.argv.slice(2),
  root: ROOT,
  weightsFile: path.join(TESTS, "suite-weights.json"),
  testEnv,
});
await testEnv.cleanupTestData();
process.exit(code);
