# 0149 通知ボタンと通知の一覧（受信箱）を足し、あなた向けの出来事をサーバーの DB に残す

- 状態: 承認（2026-10-06）

## 状況

通知は、出来事をその場で OS 通知・スマホの通知・脇の印（◆・青い丸・件数の札）にして捨てる仕組みで、通知そのものを保存した行は 1 つも無かった（[ADR 0086](0086-notifications-through-relay.md)）。見逃すと、何が起きたかを後から辿る手がかりが無く、通知から「その発言・その投稿」へ飛ぶ口も無かった（通知の飛び先は会話の末尾まで）。既読は会話（`readAt`）とチャンネル（`readAt`・`mentionAt`）の 2 系統だけで、承認待ち・失敗・メンションに通知ごとの既読は無かった。

ユーザーの承認（2026-10-06。統合モックの 04）:

- 脇の頭に通知のボタン（ベル）を置き、押すと浮く面に一覧（絞り込み・［すべて既読］・種類のアイコン・場所と時刻・未読の青い丸）を出す。行を押すと通知先を開き、着いた発言・投稿を一瞬強調する。
- 載せる種類はあなた待ち・失敗・完了・@あなた。チャンネルの新着・ルーティンの結果・委譲の完了は載せない。
- 一覧はサーバーの DB に保存し、再起動しても残す。bot の会話は今の通知の規則（完了は出さない・隠れた会話は出さない）に揃える。いま見ている会話で起きたものは既読として載せる。件数・保存期間の上限を決める。既読は通知ごとに持ち、会話を開く・チャンネルを既読にすると対応する通知も既読にする。

## 決定

- **保存する（状態から導かない）。** 過去の完了・失敗・決着した承認を残したいので、出来事を DB の行にする（件数で増えるものは行にする規則。[ADR 0115](0115-records-in-sqlite.md)）。表は `notifications`（`seq`・`id`・`dedupe_key`・`kind`・`at`・`session_id`・`channel_id`・`read_at`・`resolved_at`・`data`）。
- **後から足す表（`LATE_TABLES_SQL`）にし、形式番号は上げない。** 理由: (1) 通知は欠けても失う記録が無い（飛び先の会話・投稿・既読の側が正本で、通知は「何かが起きた」という手がかり）。無くなっても一覧が空になるだけで、会話・チャンネルは変わらない。(2) 形式番号を上げて移行（`core/schema-migration.mjs`）を足すと、古い版でデータ置き場を開けなくなる。同じ性質の `brain_wakes`（[ADR 0140](0140-bot-wake-reservations.md)）・`deleted_natives`（[ADR 0147](0147-delete-sent-conversations.md)）と同じ扱い。
- **書き込み点**（`core/notification-sources.mjs`。どれも投げない）: `completionNotices.ready`（ターンの終わり。会話が落ち着いた時点の 1 回。完了・失敗）・承認の成立と決着（`askPermission` の `runtime.waiting` への登録と `settle`）・`channelPost` の追加・編集（人以外の投稿の `@あなた`）。`dedupeKey` が同じ出来事は載せない（再接続・編集の重複）。
- **今の通知の規則に揃える。** 完了は通常の会話だけ（bot の会話は失敗だけ。隠れた会話・委譲の子・空き時間の自動圧縮は載せない）。あなた待ちの承認は隠れた会話の分を載せず、委譲の子の承認はカードが出ている依頼元の会話へ飛ぶ。
- **既読は通知ごと。** `read_at` を持ち、行を押す・［すべて既読］で既読。整合: 会話の `markRead`（`readAt` まで。完了・失敗の通知の `at` を `completedAt` にしてあるので、同じ時刻で突き合わせられる）・その会話を見た（`presence`。承認・完了・失敗を既読に）・`channels.markRead`（`readAt` まで。bot の会話の通知もチャンネルの既読で）で、対応する通知も既読にする。いま見ている会話で起きたものは最初から既読で載せる。あなた待ちが決着したら既読にして `resolvedAt`・`outcome` を付ける。
- **上限は 200 件・30 日**（`NOTIFICATION_MAX`・`NOTIFICATION_KEEP_MS`）。載せるたびに古い方から捨てる（既読を先に）。会話を消す（`sessions.delete`）・チャンネルをアーカイブすると、その行を消す。承認はメモリにしか無く再起動で消えるので、起動時に決着していないあなた待ちを `cancelled` で決着させる。
- **飛び先の情報**: 会話は `sessionId` と、ターンの最後の発言の `uuid`（`text.end`。無ければ会話の末尾）。チャンネルは `channelId`・`threadId`・`postId`。bot の会話の通知は会話ではなくスレッドへ飛ぶ。名前（会話の題・bot・チャンネル・スレッドの題）は載せた時点の控え。
- **投稿へ飛ぶ入口を足す。** `channels:show` の `detail` に `postId` を足す（スレッドを開くときは `host.openThread(channelId, threadId, { postId })`）。着いた投稿は 1.2 秒の輪（動きを減らす設定では明滅なし）。会話の発言は、検索から開いたときと同じ `revealMessage` の輪。
- **操作**（[ADR 0081](0081-control-surface-registry.md)）: `notifications.list`（read）・`notifications.count`（read）・`notifications.markRead`（write）。画面・MCP・CLI が同じ本体を通る。件数が変わると出来事 `notificationsChanged { unread, waiting }` を全画面へ配る（リモートの端末にも届く既存の配り方）。
- **スマホの `pleiad://open` は広げない**（会話の末尾まで）。チャンネル・スレッド・投稿を指す口は殻と通知のペイロード（固定長）の変更が要るので、別に決める。

## 理由

- 出来事を捨てる今の仕組みのままでは、見逃した通知を辿れない。状態から導く案（承認待ち・未確認の完了などの「今の注意」だけを並べる）は保存が要らないが、完了済み・失敗の履歴と、決着した承認が出せず、飛び先の発言・投稿も持てない。
- 既存の既読（会話・チャンネル）と通知ごとの既読を二重に持つ形は、片方だけ既読になる不整合を生む。通知の `at` を既存の既読の時刻と同じ物差し（会話は `completedAt`、チャンネルは投稿の `at`）にして、既存の既読が進んだら通知を追従させる向きの一方通行にした。通知の既読は既存の既読を進めない（通知を押しても会話の `readAt` は、会話を開いたときの `markRead` で動く）。
- 件数と一覧を分けた（件数は `notificationsChanged` で配り、一覧は開いたときに読む）。ベルの数のために毎回全件を読まない。

## 影響

- `core/db.mjs`（表と `notificationTable`）・`core/notifications.mjs`・`core/notification-sources.mjs`・`core/ops/notifications.mjs`・`core/server.mjs`（書き込み点・既読の整合・起動時の決着・ctx）・`core/completion-notices.mjs`（ready へ最後の発言の uuid）・`core/protocol.mjs`（`notificationsChanged`）。
- 画面: `web/notification-inbox.mjs`・`web/notification-inbox.css`・`web/index.html`（ベルと面）・`web/client.mjs`（配線と飛ぶ処理）・`web/channels/`（`postId`）。辞書は ja・en（`ui:inbox.*`、`agent:ops.notifications.*`）。
- 試験: `tests/unit/notification-inbox.mjs`（表・規則）・`notification-inbox-server.mjs`（サーバー越し）・`notification-inbox-ui.mjs`（文の組み立て）・`tests/browser/notification-inbox.cjs`（打鍵）。`tests/ops-surface.snap.json` を更新。
- 古い版でデータ置き場を開いても、`notifications` 表が無視されるだけで壊れない。
- 通知の一覧に載せない種類（チャンネルの新着・ルーティンの結果・委譲の完了）は、後から足すなら `kind` と書き込み点を足す。
