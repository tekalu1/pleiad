// LLM もサーバも要らないテスト。CI で常時回す。数秒で終わること。
//
//   npm test                 全部
//   npm test -- markdown     名前で絞る（部分一致）
//
// 落ちたテストは末尾にまとめて出る。終了コードで成否を返す。
//
// 画面とサーバーの言語は日本語に固定する（テストは日本語の文言に依存している。CI の OS の言語で変わらないように）。
// 英語のケースは i18n のテストが明示的に切り替えて見る。起動するサーバーにも環境変数で引き継がれる。
process.env.AGENT_HOST_LOCALE ||= "ja";
import { installDomStub } from "./lib/dom-stub.mjs";
import { runCase, summarize, pick } from "./lib/harness.mjs";

// web/render.mjs はブラウザ前提なので、読み込む**前**に DOM を差し替える。
installDomStub();

const cases = [
  await import('./unit/compaction.mjs'),
  await import('./unit/server-compaction.mjs'),
  await import('./unit/file-preview.mjs'),
  // プレビューの横のツリー: 経路の段は必ず返す・遅延読み込み・件数の枠と枠の外の経路・除外名も全部出す・roots の外は読めない
  await import('./unit/file-preview-tree.mjs'),
  await import('./unit/file-access.mjs'),
  await import('./unit/preview-links.mjs'),
  // 文中の URL のリンク: 範囲の判定（ASCII の字まで）・リンクにする場所としない場所・行き先の一行と右クリックのメニューの項目
  await import('./unit/url-links.mjs'),
  // パスの自動リンク・画像の所在・ファイルの操作メニュー・OS で開く口（OS の窓は開かない）
  await import('./unit/file-actions.mjs'),
  // 右パネルの枠（web/side-panel.mjs）: モードごとの部品・渡さない部品は隠す・可視化の ⋯
  await import('./unit/side-panel.mjs'),
  // 内蔵ブラウザー: 右パネルの表・アドレス欄・リンクの開き先・使える画面・main のタブと位置（偽の electron）
  await import('./unit/inapp-browser.mjs'),

  // computer use のオーバーレイと Esc: 窓・フェード・Esc の登録と解除・止める流れ・倍率の違うモニターの座標（偽の electron。OS の入力は送らない）
  await import('./unit/computer-overlay.mjs'),
  // computer use の main 側（desktop/computer/*）: キーの解釈・SendInput の中身・releaseAll・撮影の縮小・アプリの特定・service の列と止め方（偽の Win32。本物の入力は送らない）
  await import('./unit/computer-native.mjs'),
  await import('./unit/header-entries.mjs'),
  await import('./unit/agent-browser-relay.mjs'),
  // 新規会話の最初のターンの中継のキーを、会話 ID が決まったとき本物へ付け替える（parentPort の身代わり）
  await import('./unit/server-browser-rebind.mjs'),
  // 内蔵ブラウザーのプロフィール（ADR 0078）: 保存領域・会話ごとの今のプロフィール・中継の絞り込み・AI の切り替え（ply_browser）・確認の鍵
  await import('./unit/browser-profiles.mjs'),
  await import('./unit/browser-confirm.mjs'),
  // 設定 › コンピューターの操作: prefs の検査と既定・store の remember/forget・hostCapabilities.computerUse の判定・節の動き・setPref（docs/computer-use.md）
  await import('./unit/computer-settings.mjs'),
  // コンピューターの操作（ply_computer。docs/computer-use.md）: アプリの判定の順・禁止の一覧・印の行・座標・スクショの保存
  await import('./unit/computer-policy.mjs'),
  // ロック: 1 つだけ・FIFO・待ちの上限・待ちを分ける・中断で抜ける・委譲の子へ貸す・止めた印
  await import('./unit/computer-lock.mjs'),
  // main への口（parentPort）: computer-* のメッセージの形・id での応答・エラーの code・ハートビート・偽の driver
  await import('./unit/computer-driver.mjs'),
  // 橋: MCP の面・座標の基準・ゲートの順・アプリの承認・止める・ロック画面・画像の渡し方（偽の driver）
  await import('./unit/computer-bridge.mjs'),
  // サーバー越し: 承認カードの payload・スクショの保存と配信・computer.state・computerStop・委譲の子の承認（fake + 偽の driver）
  await import('./unit/server-computer.mjs'),
  await import('./unit/modes.mjs'),
  // 操作の一覧（core/ops/、ADR 0080・0081）: 権限の表（主体 × 危険度 × 会話の承認モード）・関所の順序と定義の検査・載せ忘れの lint（WS のコマンドと prefs のキーのラチェット）・
  // 一覧の中身（snapshot・文の量・主体ごとの見え方・伏せ字・辞書・JSON Schema）・WS の invoke をサーバー越しに
  await import('./unit/ops-policy.mjs'),
  await import('./unit/ops-registry.mjs'),
  await import('./unit/ops-coverage.mjs'),
  await import('./unit/ops-surface.mjs'),
  await import('./unit/server-ops.mjs'),
  await import('./unit/agent-tasks.mjs'),
  await import('./unit/agent-tasks-silence.mjs'),
  await import('./unit/task-command-notice.mjs'),
  // 委譲の保存障害: rename のやり直し・閉じない・障害中の読み取り・requeue を書かない・再起動後の pending の送り直し（失敗は注入）
  await import('./unit/agent-tasks-storage.mjs'),
  // 完了通知: 受け取り済み（read）は送らない・同じ親の分は 1 つにまとめる・走っているターンへ渡す（steerable）と送り直し・途中送信の条件
  await import('./unit/agent-tasks-notice.mjs'),
  // 追加指示（ply_task_send）を走っている子のターンへ途中送信で渡す: 受理・合図・捨てられた・合図なし・順序・止めた後（ADR 0065）
  await import('./unit/agent-tasks-steer.mjs'),
  // 中断で委譲タスクを止める: 届いていない結果を捨てずに返す・取り消したものを返す・cancel は終わったタスクの通知を止めない・再起動で止まったもの
  await import('./unit/agent-tasks-interrupt.mjs'),
  await import('./unit/server-delegation-notice.mjs'),
  // 追加指示を走っている子のターンへ途中送信で渡す（fake の bg 台本。合図あり・なし、受理されない、結果不明、捨てられた、合図なし）
  await import('./unit/server-delegation-steer.mjs'),
  await import('./unit/background-model.mjs'),
  await import('./unit/task-instructions.mjs'),
  // 委譲した子の詳細: ツールだけの発言を本文が来るまで 1 つにまとめる・変更の記録の行（新しい順・項目・誰がの訳）
  await import('./unit/tool-turns.mjs'),
  await import('./unit/change-log.mjs'),
  // 作業の詳細: 走っている子の出来事（loadSession の live）を仮の発言に畳む・詳細とメインパネルが発言の描き方を共有する
  await import('./unit/stream-messages.mjs'),
  await import('./unit/server-agent-tasks.mjs'),
  // 委譲の子に裏の作業が残るとき: 終わらないコマンドも自動停止しない・サブエージェントは止めない・端末は待たない（子にも親にも）
  await import('./unit/server-delegation-background.mjs'),
  // 委譲の結果に選ぶ返答: Stop フックの続き（調べものだけ）は飛ばす・中身の仕事をした続きは選ぶ（Claude の transcript の印）
  await import('./unit/delegation-result.mjs'),
  // 委譲先の自動振り分け: 規則・段・使用量で飛ばす・Claude のアカウント・判定器（偽の fetch）・使用量の取り置き
  await import('./unit/delegation-routing.mjs'),
  // 同じくサーバー全体: kind の検査・自動で選んで子を作る・記録・設定とキーの口（偽の判定器と偽の agy）
  await import('./unit/server-delegation-routing.mjs'),
  await import('./unit/server-delegation-routing-settings.mjs'),
  // 同じく画面: 委譲カードの理由・内訳の文、やり直しの候補の並び、設定の差分（web/delegation-routing-view.mjs）
  await import('./unit/delegation-routing-view.mjs'),
  // Pleiad の指示: 担当によらず届く・依頼元と子で違う・足した指示・既定の編集・前の版のスイッチ・Codex のロード済みスレッド
  await import('./unit/server-added-context.mjs'),
  await import('./unit/usage.mjs'),
  // Claude の使用量: 開始時点の累計（cost-state）からの差分・resume 前の読み取り・既存の記録の移行（写し・冪等）
  await import('./unit/claude-usage-delta.mjs'),
  await import('./unit/antigravity-usage.mjs'),
  // 会話のヘッダーの使用量のチップ（web/header-usage.mjs）: 枠の選び方・アカウント・上限・グループのまとめ
  await import('./unit/header-usage.mjs'),
  await import('./unit/effort.mjs'),
  await import('./unit/composer-agy.mjs'),
  // 互換の接続先（保存・確認・キーを出さない・env と Codex の上書き）。偽の互換 API とだけ話す
  await import('./unit/compat-endpoints.mjs'),
  // リモート接続の暗号・フレーム・チャネル（core/remote/）。Noise の公式ベクトルと、メモリの管でつないだ往復
  await import('./unit/remote-noise.mjs'),
  await import('./unit/remote-frames.mjs'),
  await import('./unit/remote-channel.mjs'),
  // 互換の接続先のモデルの表示名（anthropic/ と [1m]）・検索（AND・件数の上限・自由入力）・display_name の保存と旧形式
  await import('./unit/compat-models.mjs'),
  // 入力欄の設定のチップ: フォルダーの一覧（listDirs）・「既定」の解決・エフォートの既定の段
  await import('./unit/composer-settings.mjs'),
  await import('./unit/context-transports.mjs'),
  await import('./unit/context-runtime.mjs'),
  // 外部 MCP の認証（担当が Pleiad のとき）。秘密の置き場、OAuth はローカルのモックの認可サーバー・MCP だけと話す
  await import('./unit/mcp-secret-store.mjs'),
  await import('./unit/mcp-oauth.mjs'),
  await import('./unit/mcp-oauth-more.mjs'),
  await import('./unit/mcp-registry-more.mjs'),
  // データ置き場を共有する 2 つのプロセス。本物の子プロセスを 2 本起動する
  await import('./unit/mcp-oauth-processes.mjs'),
  await import('./unit/desktop-updates.mjs'),
  await import('./unit/desktop-exit-dialog.mjs'),
  await import('./unit/message-queue.mjs'),
  await import('./unit/message-steer.mjs'),
  await import('./unit/visualize.mjs'),
  await import('./unit/server-visualize.mjs'),
  await import('./unit/mcp-config.mjs'),
  // Hooks: 3 エージェントの元の設定の探索（壊れたファイル・伏せ字）と書き込み（JSON / TOML・競合・enabled・部分成功）
  await import('./unit/hooks-config.mjs'),
  await import('./unit/hooks-copy.mjs'),
  await import('./unit/server-hooks.mjs'),
  // Hooks を Pleiad がそろえる: 正本と担当の保存・渡し方の組み立て・コールバックとアダプター・切り替えの確認
  await import('./unit/hooks-unify.mjs'),
  await import('./unit/server-hooks-unify.mjs'),
  // 同じくレビューの指摘ごと（漏れ・ガードの消失・確認の迂回）
  await import('./unit/hooks-unify-review.mjs'),
  await import('./unit/server-hooks-unify-review.mjs'),
  await import('./unit/context-scan.mjs'),
  // コンテキストの設定の形式 2 と、形式 1 からの移行（意味が変わらないこと）
  await import('./unit/context-settings.mjs'),
  // 探す場所を足す（追加ルート）: 種類ごと・探す形式に従う・形式 2 からの移行
  await import('./unit/context-roots.mjs'),
  await import('./unit/server-context.mjs'),
  await import('./unit/context-ui.mjs'),
  // 指示の量（ADR 0056）: 自分で書いた分と Pleiad が足した分・目安・エージェント任せの見積もり
  await import('./unit/instruction-amount.mjs'),
  // 気になる所: 違うファイルのほぼ同じ段落・もう無いパス（言語に依存しない判定）・サーバー越しの対象
  await import('./unit/context-findings.mjs'),
  // 見直しを頼む: 依頼文の下書き・下書き入りの未送信の新しい会話（送らない）
  await import('./unit/context-review.mjs'),
  await import('./unit/slash-skills.mjs'),
  await import('./unit/notifications.mjs'),
  // スマホへの通知（core/notify、ADR 0086）: 種類・抑制（見ている会話・古さ・短さ）・取り消し・暗号の往復と固定長・Android と共有する例・完了と失敗の保留
  await import('./unit/push-notify.mjs'),
  // ホスト（fake）→ 中継の通知の線 → 端末の代わりのクライアントで復号: 承認・質問・完了・失敗・取り消し・見ている会話・止めた端末・溜めて渡す
  await import('./unit/server-push-notify.mjs'),
  // 通知の画面側: この PC の設定・見ている間は出さない・失敗・presence の知らせ・設定 › 通知・スマホのアプリの帯と通知から開く会話
  await import('./unit/notify-web.mjs'),
  await import("./unit/onboarding.mjs"),
  await import("./unit/tree.mjs"),
  await import("./unit/family.mjs"),
  await import("./unit/pending-sidebar.mjs"),
  // 入力欄の待ち（web/composer-wait.mjs）: 会話を開く・初めての接続・読み込みの失敗・作成中の送信の予約
  await import("./unit/composer-wait.mjs"),
  // 承認カード: 受け取られるまで送信中・失敗はカードの中・決着後の一行に対象と開閉
  await import("./unit/approval-card.mjs"),
  // コンピューターの操作の表示: 行（題・動詞・サムネイル・止めた理由）・終わった塊の 3 行と「ほか N 件」・承認の中身・通知の見出し
  await import("./unit/computer-use-ui.mjs"),
  // 接続の状態（web/connection-status.mjs）: 切れた一行・読み上げ・古いトークンの案内と再確認、開くボタンの印、/auth-check
  await import("./unit/connection-status.mjs"),
  // 新しい会話を作っている間に書いた字が消えない・作成中の送信の予約・読み込み失敗で欄が戻る（client.mjs を vm で流す）
  await import("./unit/composer-new-session.mjs"),
  // 圧縮の区切りは発言を送っても動かない・放置中の圧縮の区切りは次の発言の前に置く（client.mjs の userMessage・paintCompactions）
  await import("./unit/compaction-boundary-position.mjs"),
  await import("./unit/server-groups.mjs"),
  await import("./unit/audit-self.mjs"),
  await import("./unit/markdown-xss.mjs"),
  await import("./unit/tools-render.mjs"),
  await import("./unit/tool-bundle.mjs"),
  // 作業の詳細の読み直し: 開いたツールの詳細・まとまり・長文の畳みを、作り直しの後も同じ所で開いたままにする
  await import("./unit/view-state.mjs"),
  await import("./unit/timeline-images.mjs"),
  await import("./unit/attachment-order.mjs"),
  // 自分の発言: 添付の印を本文の位置に置く（コードブロック内・一致しないパスは残す・古い形式は末尾）・畳み込み・別カードを二重に出さない
  await import("./unit/user-message.mjs"),
  // ホバーの無い端末で発言を押すと時刻を 4 秒出す（リンク・ボタン・コード・字の選択の上では出さない）
  await import("./unit/message-peek.mjs"),
  // 発言のメニュー（⋯・右クリック・キーボード）・長い発言の畳みを開く・送った直後の画像の枠（ADR 0067）
  await import("./unit/message-actions.mjs"),
  await import("./unit/md-doc.mjs"),
  await import("./unit/prompt-title.mjs"),
  // 添付の件数に上限が無い（下書き・送信）。出どころの印。1 件 8MB の上限は残る
  await import("./unit/attach-no-limit.mjs"),
  // 添付を断片で送る（1 件 100MB まで）: 境目・抜け・やめる・切れても続きから・大きな画像は会話にパスだけ
  await import("./unit/attach-chunked.mjs"),
  // 入力欄と上端の見直し: 字の欄の上限・チップの字・添付の出どころ・パンくず・規則
  await import("./unit/composer-layout.mjs"),
  await import("./unit/unread.mjs"),
  // 中断と再開の画面（web/interrupt.mjs）: 三角の未読・理由の文言・再開ボタン・更新で止めた会話・更新の確認の作業一覧と進み
  await import("./unit/web-interrupt.mjs"),
  // 確認済み（既読）の置き場と、2 本の接続で共有されること（fake バックエンド）
  await import("./unit/read-store.mjs"),
  await import("./unit/server-read.mjs"),
  // 開いている会話の宣言（流れの出来事を絞る）と、会話の一覧の使い回し（ADR 0024）
  await import("./unit/server-watch.mjs"),
  await import("./unit/desktop-port.mjs"),
  // デスクトップ版の端末（リモートの窓）: 窓ごとの信頼・preload の出し分け・バッジ。Electron は起こさない
  await import("./unit/desktop-remote.mjs"),
  // スマホの画面（docs/remote.md §8.3・§8.4）: UUID の代わり・長押し・「…」・狭い画面の規則
  await import("./unit/mobile-web.mjs"),
  await import("./unit/stream-routing.mjs"),
  await import("./unit/stream-prefix.mjs"),
  await import("./unit/session-stream.mjs"),
  // 長い履歴の実寸の確定: 見えている所の近くだけ（数は会話の長さによらない・issue #37）。確定してもスクロールの位置は動かない（末尾なら末尾に、読み返し中ならその位置に。列より広い窓でも）
  await import("./unit/history-heights.mjs"),
  // 会話の移動（web/conversation-nav.mjs）: 発言の抜粋（畳み・コード・添付）と件数の札
  await import("./unit/conversation-nav.mjs"),
  // 履歴を描く間、1 行ごとに筋を探し回らない（稼働表示の行は activity.el。issue #37）
  await import("./unit/place-scan.mjs"),
  // つなぎ直したときの静かな読み直しは、同じ発言の行を残して変わった所から後ろだけ描く（読み返している位置も保つ。issue #37）
  await import("./unit/history-retain.mjs"),
  // loadSession の差分（ADR 0062）: 合うときだけ続きを返す・つないだ結果は全量と同じ・合わなければ全量・画面の頼み方
  await import("./unit/history-sync.mjs"),
  await import("./unit/server-history-diff.mjs"),
  // 返答の本文は 1 コマに 1 回だけ描く・流れの終わりでは描き切る・会話を切り替えたら別の会話へ描かない
  await import("./unit/stream-frames.mjs"),
  await import("./unit/work-attribution.mjs"),
  await import('./unit/work-status.mjs'),
  await import('./unit/background-labels.mjs'),
  await import("./unit/ask-answers.mjs"),
  await import("./unit/title-clean.mjs"),
  await import("./unit/claude-normalize.mjs"),
  // 履歴のシステム側のメッセージ: 形（transcript の印）と文面での見分け・区切りへの要約・中断・teammate・文脈のタグ・保存分（ADR 0053）
  await import("./unit/system-messages.mjs"),
  // 入力欄の `!`（ADR 0054）: ホストで走らせる・止める・上限・同じ runId・Claude に渡す形・Codex の userShell の履歴
  await import("./unit/shell-runs.mjs"),
  // 同じく入力欄の形: `!` を打つ・貼り付けでは入らない・Backspace で戻る・使えない会話・文として送る・入力欄に写す
  await import("./unit/shell-composer.mjs"),
  // 同じくサーバー越し（fake）: 走らせる・送信待ちに入らない・次の発言で渡す・開き直した履歴・使えない会話・Codex の thread/shellCommand
  await import("./unit/server-shell.mjs"),
  await import("./unit/claude-background.mjs"),
  // Claude の途中送信の渡った合図（uuid・まとめ取り出し・次の内部ターン）と中断の interrupt。SDK の query を身代わりにする
  await import("./unit/claude-steer-stop.mjs"),
  // Claude のターンの終わり: Stop フックの続き・裏へ回ったまま終わらないコマンド（stopTask で終わる）
  await import("./unit/claude-turn-end.mjs"),
  // Claude のモデル一覧: CLI の実体（版）が変わったら 30 分の TTL の中でも引き直す
  await import("./unit/claude-catalog-cli-version.mjs"),
  await import("./unit/codex-background.mjs"),
  await import("./unit/codex-terminals.mjs"),
  await import("./unit/event-session-id.mjs"),
  await import("./unit/lineage.mjs"),
  await import("./unit/branches.mjs"),
  // 見た目の規則。web/ の CSS と index.html を lint する（docs/design-system.md §5）
  await import("./unit/design-lint.mjs"),
  // 多言語対応。翻訳漏れの lint（直書きの日本語のラチェット・辞書の揃い）と、言語の解決・書式・setPref locale
  await import("./unit/i18n-lint.mjs"),
  await import("./unit/i18n.mjs"),
  // core・desktop の文言の言語切り替えと、保存される文言（変更の理由・添付の見出し・既定のタイトル）
  await import("./unit/i18n-server.mjs"),
  // エージェントに渡す文（指示・ツールの説明・完了通知・タイトル生成・承認の拒否の理由）が会話の言語になる
  await import("./unit/i18n-agent.mjs"),
  await import("./unit/codex-mode.mjs"),
  // model/list のページ送り・覚える長さ・ログイン / ログアウトで捨てる・タイトル生成のモデル選び
  await import("./unit/codex-models.mjs"),
  await import("./unit/codex-child-routing.mjs"),
  // Codex の実行前の拒否: rollout の解析（code mode・直接・wait・プロセス作成の失敗・引用の除外）・読む範囲・伏せ方・Codex の子への指示
  await import("./unit/codex-rejections.mjs"),
  await import("./unit/backend-shape-diagnostics.mjs"),
  // 同じくサーバー全体: 会話にツールのエラーとして出す・委譲の rejections・完了通知・ply_task_send の次の回（Codex は身代わり）
  await import("./unit/server-codex-rejections.mjs"),
  // fake バックエンドでサーバを立てる。LLM は呼ばないので、ここに入れてよい
  await import("./unit/server-fake.mjs"),
  // 中断の順序（実際の中断が先、Pleiad タスクの後始末は後）と「中断している」の知らせ。fake バックエンドだけ
  await import("./unit/server-abort.mjs"),
  // テストの補助 runTurn（tests/lib/ws-client.mjs）が、裏で別の会話のターンが終わっても自分の会話の終わりまで待つ。fake バックエンドだけ
  await import("./unit/ws-client-run-turn.mjs"),
  // 中断を会話の状態として残す・再開（保留の送り直しか理由の文）・委譲の子の中断・再起動で落ちたターン
  await import("./unit/server-interrupt-resume.mjs"),
  // 中断で止めたもの（委譲タスク・届いていない結果・裏のコマンド・承認待ち・再起動）を残し、中断の後の最初のターンで 1 回だけ伝える
  await import("./unit/server-interrupt-stops.mjs"),
  // Claude のアカウント切り替え（会話ごとのトークン）。env の組み立てと、server の配線を fake で通す
  await import('./unit/claude-accounts.mjs'),
  await import('./unit/server-claude-accounts.mjs'),
  // アカウントの認可を Pleiad から回す（疑似端末の偽物と、偽の CLI を本物の疑似端末で）
  await import('./unit/claude-login.mjs'),
  await import('./unit/server-claude-login.mjs'),
  await import("./unit/server-background.mjs"),
  await import("./unit/server-handoff.mjs"),
  // 対応を終えた procway-code の会話・設定が残っていても安全に動く
  await import("./unit/server-retired.mjs"),
  await import("./unit/server-fork.mjs"),
  await import("./unit/server-ux.mjs"),
  // 変更の記録: sessionChanges の返す形と、statusByAi（AI が状態を変えたときだけ印。人が変えたら null）
  await import("./unit/server-session-changes.mjs"),
  // 最近の場所の候補: Pleiadで使った実在フォルダーのみ・委譲やネイティブ一覧や消えた場所を除外
  await import("./unit/cwd-recent-places.mjs"),
  await import("./unit/conversations.mjs"),
  await import("./unit/conversations-storage.mjs"),
  // セッション検索（core/session-search.mjs）: 照合（AND・NFKC・"…"・場所はフォルダー名）・発言者・委譲・期間・関連度の順・抜粋の ranges・写しの更新と partial
  await import("./unit/session-search.mjs"),
  // 読み込み元（core/session-search-host.mjs）: 保存分は直接・それ以外は getMessages・完了通知とコマンドの行とツールの出力は写さない
  await import("./unit/session-search-host.mjs"),
  // codex バックエンド。app-server の身代わり（tests/lib/fake-codex.mjs）と話すだけで、
  // 本物の codex もネットワークも要らない
  await import("./unit/server-codex.mjs"),
  // 互換の接続先の配線。codex の身代わりと偽の互換 API だけと話す
  await import("./unit/server-compat-endpoints.mjs"),
  // 同じことを本物の Claude Code・Codex の CLI で（送り先は偽の互換 API。入っていなければとばす）
  await import("./unit/server-compat-real-cli.mjs"),
  // antigravity バックエンド。agy の身代わり（tests/lib/fake-agy.mjs）と話すだけで、
  // 本物の agy も Google のログインも要らない
  await import("./unit/server-antigravity.mjs"),
  // 控えはターンの途中から書く: 途中の書き込み・失敗／中断で残る・uuid が変わらない・forget した控えを作り直さない・書き込みは 1 本ずつ
  await import("./unit/antigravity-partial-transcript.mjs"),
  // Pleiad の MCP 登録と認証の API、1 件つながらなくても会話が進むこと、antigravity では Pleiad 担当を開かないこと
  await import("./unit/server-mcp-auth.mjs"),
  await import("./unit/server-agy-context.mjs"),
  // コンピューターの操作（ply_computer）: 3 つのエージェントへの注入（MCP・上限時間・指示文・承認・同梱を切るキー）と、印の行からの正規化
  await import("./unit/computer-delivery.mjs"),
  // 同じことをサーバーの橋（偽の driver）から Codex・Antigravity の身代わりへ: 注入・正規化・履歴・委譲の子・設定でオフ
  await import("./unit/server-computer-delivery.mjs"),
  // インストールからログインまでの導線（未インストール -> 再起動なしで発見 -> 認可コード）
  await import("./unit/antigravity-onboarding.mjs"),
  // 孤児の agy の掃除。**名前を確かめてからでないと落とさない**
  await import("./unit/antigravity-pids.mjs"),
  // 同じ身代わりで、ターン途中の送信をその区切りへ差し込む（serve の steer）
  // リモートの中継（relay/server.mjs）。空きポートで立て、素の WebSocket で照合・行き先・上限を叩く
  await import("./unit/relay.mjs"),
  // リモートのホスト側（core/remote/connector.mjs）。中継をこのプロセスで、fake のサーバーを別プロセスで立て、試験用の端末で往復する
  await import("./unit/remote-host.mjs"),
  // 設定 › リモートの部品と常駐（トレイ・スリープ。Electron は差し替える）、setRemoteResident
  await import("./unit/remote-settings.mjs"),
  // リモートの端末側（core/remote/device*.mjs）。中継とホストを立て、端末内プロキシの URL を素の HTTP と ws で叩く
  await import("./unit/remote-device.mjs"),
  // 手元のフォルダーを送る口（core/folder-uploads.mjs）: パスの検査・送り先・続きから・中断・上書きの確認・掃除、WS での往復
  await import("./unit/folder-uploads.mjs"),
  // 同じ口を端末内プロキシ → 中継 → ホストで。50 MiB・2000 件が流量の制御の下で届くこと、中継が落ちても続きから送れること
  await import("./unit/remote-upload.mjs"),
  // モバイルの殻（mobile/）の取り決め: plyRemote の形・平文はループバックだけ・依存の版の固定・殻の辞書
  await import("./unit/mobile-shell.mjs"),
  // リモートでリンクを押したときの行き先（localhost の知らせ・写しはアプリの中・Web は端末のブラウザー）
  await import("./unit/remote-links.mjs"),
  // リモートから PC の内蔵ブラウザーを見る: フレームの間引き・止める条件・ローカルとエージェント操作中の断り・入力の変換・シートの出し分け
  await import("./unit/remote-browser-view.mjs"),
];

const selected = pick(cases, process.argv.slice(2));
if (!selected.length) process.exit(1);

const t0 = Date.now();
const suites = [];
for (const mod of selected) suites.push(await runCase(mod));

const code = summarize(suites);
console.log(`  ${((Date.now() - t0) / 1000).toFixed(1)} 秒`);
process.exit(code);
