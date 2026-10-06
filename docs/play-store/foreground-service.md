# 前面サービスの申告（remoteMessaging、下書き）

Android 14 以降を対象にするアプリは、前面サービスの種類ごとに Play Console の「アプリのコンテンツ」で申告する。申告では、種類ごとに (1) その種類を使う機能の説明、(2) システムに先延ばし・中断されたときの利用者への影響、(3) 利用者が機能を動かす操作を映した動画のリンクを出し、用途を選ぶ（[フォアグラウンド サービスと全画面インテントの要件について](https://support.google.com/googleplay/android-developer/answer/13392821)）。`remoteMessaging` の許される用途は「別の端末へテキストの通信を中継する」もので、利用者が端末を切り替えても、メッセージのやり取りを続けられるようにするためのもの（[フォアグラウンド サービスのタイプ](https://developer.android.com/develop/background-work/services/fgs/service-types)）。

Pleiad の使い方（[ADR 0086](../adr/0086-notifications-through-relay.md)）: PC（ホスト）の Pleiad で動くエージェントが、承認・質問への返事を待っている、失敗した、終わった、という短い知らせを、PC から利用者のスマートフォンへ中継を通して送る。利用者は、PC で始めた作業のやり取りを、席を離れてスマートフォンで続ける。

## 実装の事実（申告の前に確かめる）

| 項目 | 内容 | 場所 |
|---|---|---|
| 種類と権限 | `foregroundServiceType="remoteMessaging"`、`FOREGROUND_SERVICE`・`FOREGROUND_SERVICE_REMOTE_MESSAGING` | `mobile/android/app/src/main/AndroidManifest.xml` |
| 動く間 | 利用者がアプリの「通知」で「この端末に知らせる」をオンにしている間だけ。オフにすると止まる | `NotifyService.sync`・`NotifyControl` |
| 始まり | 利用者がオンにしたとき（アプリが前面）・アプリを開いたとき・端末の再起動とアプリの更新の後（`BOOT_COMPLETED`・`MY_PACKAGE_REPLACED`） | `MainActivity`・`BootReceiver` |
| すること | ペアリングしたホストごとに、中継へ WebSocket を 1 本保ち、暗号化された知らせを受けて復号し、端末の通知にする。画面（WebView）は起こさない | `NotifyHub`・`NotifyLine`・`NotifyPresenter` |
| 軽さ | 知らせが来るまで何も流れない。WebSocket の ping は 4 分ごと。切れたら 5 秒から 5 分まで間を延ばして張り直す。ネットワークが戻ったらすぐ張り直す | `NotifyLine`（`pingMs = 240_000`、`Backoff(5_000, 300_000, …)`） |
| 常駐の通知 | 重要度が最小のチャンネル「接続」に 1 行（「Pleiad · 通知を受け取っています」）。音・振動なし | `NotifyService.onStartCommand` |
| 止められたとき | 中継は端末が切れている間、暗号化した知らせを端末あたり 16 件・最大 15 分までメモリに溜め、つながったら渡す | `relay/server.mjs`（`notifyQueueMax`・`notifyMaxTtlMs`） |

`dataSync` にしないのは、Android がそれを 24 時間に 6 時間までしか動かさないため。FCM を使わない理由は ADR 0086（利用者が自分で立てた中継から送るには、配布元の送信用の資格情報を配るか、配布元が送り口のサーバーを置く必要がある）。差し戻されたときの案は [ADR 0142](../adr/0142-play-foreground-service-fallback.md)。

## 申告の文

用途は、`remoteMessaging` の選択肢のうち、別の端末からのテキストのメッセージを中継・受信するもの（英語の画面では「Relay text communication to another device」に当たるもの）を選ぶ。合うものが無ければ「その他」を選び、下の説明を書く。審査員は英語で読むことが多いので、英語を入れる。

### 機能の説明（英語）

```text
Pleiad is the mobile companion of Pleiad for PC, where the user runs coding agents. The PC sends short text messages to the user's phone through a relay server that the user runs: "an agent is waiting for your approval", "an agent asked a question", "a task failed" and "a task finished", each with the conversation name. They are end-to-end encrypted by the PC; the app decrypts them and shows them as notifications, so the user can continue the conversation that started on the PC from the phone.

The foreground service of type remoteMessaging keeps one lightweight WebSocket per paired PC open to the relay to receive these messages. It runs only while the user has turned on "Notify this device" in the app, and stops as soon as it is turned off. Nothing is sent until there is a message; the socket only sends a WebSocket ping every 4 minutes. The ongoing notification is a single silent line on a minimum-importance channel. The app does not use Firebase Cloud Messaging because the relay is self-hosted by each user and has no sender credentials for a Google push service.
```

### 機能の説明（日本語）

```text
Pleiad は、利用者がコーディングエージェントを動かしている PC 版の Pleiad の、スマートフォン向けのアプリです。PC は、利用者が自分で運営する中継サーバーを通して、「承認を待っています」「質問が届きました」「作業が失敗しました」「作業が終わりました」という短いテキストのメッセージを、会話名とともに利用者のスマートフォンへ送ります。メッセージは PC がエンドツーエンドで暗号化し、アプリが復号して通知として表示します。利用者は、PC で始めた会話のやり取りをスマートフォンで続けられます。

remoteMessaging の前面サービスは、これらのメッセージを受け取るため、ペアリングした PC ごとに中継との軽い WebSocket を 1 本保ちます。利用者がアプリで「この端末に知らせる」をオンにしている間だけ動き、オフにするとすぐ止まります。メッセージが無い間は何も送らず、4 分ごとに WebSocket の ping を送るだけです。常駐の通知は、重要度が最小のチャンネルの音の出ない 1 行です。中継は利用者ごとに自分で運営するもので、Google のプッシュ通知の送信用の資格情報を持たないため、Firebase Cloud Messaging は使いません。
```

### 先延ばし・中断されたときの影響（英語）

```text
If the task is deferred (does not start immediately): messages that the PC sends in the meantime are held by the relay, encrypted, for up to 15 minutes (at most 16 per device) and delivered when the service connects. The user learns late that an agent is blocked waiting for their approval or answer, so the work on the PC stays stopped until then.

If the task is interrupted (paused or restarted): the connection to the relay closes. Messages sent while it is closed are held by the relay for up to 15 minutes and delivered after the service reconnects (it retries from 5 seconds up to 5 minutes, and immediately when the network returns). Messages older than that are not shown, so the user may miss an approval request or a failure. No data is lost on the PC or the phone; the conversation itself is always available when the user opens the app.
```

### 先延ばし・中断されたときの影響（日本語）

```text
先延ばしされた（すぐに始まらない）とき: その間に PC が送ったメッセージは、中継が暗号化したまま最大 15 分（端末あたり 16 件まで）溜め、サービスがつながったときに届けます。利用者は、エージェントが承認や返事を待って止まっていることを遅れて知り、それまで PC の作業は止まったままになります。

中断された（一時停止・再起動された）とき: 中継との接続が切れます。切れている間に送られたメッセージは中継が最大 15 分溜め、サービスがつなぎ直した後に届けます（5 秒から 5 分まで間を延ばして張り直し、ネットワークが戻ったときはすぐ張り直します）。それより古いメッセージは表示されないため、承認の依頼や失敗を見落とすことがあります。PC とスマートフォンのデータは失われず、会話そのものはアプリを開けばいつでも見られます。
```

## 動画の台本

申告には、利用者が機能を動かす操作を映した動画のリンクが要る。YouTube の限定公開などに上げる。1〜2 分。PC の画面とスマートフォンの画面を左右に並べて撮る（スマートフォンは画面の録画、PC は画面の録画を並べて編集してよい）。

準備:

- PC: Pleiad を、審査用のホストと同じく fake のバックエンド・英語の画面・本物と別のデータ置き場で起動する（[app-access.md](app-access.md)。`AGENT_HOST_BACKENDS=fake AGENT_HOST_LOCALE=en AGENT_HOST_DATA=<一時の置き場>`）。中継に接続済みにしておく。本物の会話・ホスト名・パス・トークンを映さない。
- スマートフォン: Play のテストのトラックから入れた版。端末の言語は英語にする。ペアリングはまだしない。
- 見ている会話の通知は出ない（スマートフォンでは常に、PC では既定の「PC で見ている会話は知らせない」で）。少し待ってから承認を求める台本 `ask-later.json`（[app-access.md](app-access.md)）を PC の置き場に置き、送った後は PC で別の会話へ移る。

| 秒 | 映すもの | 操作 |
|---|---|---|
| 0–10 | タイトルの一枚 | 「Pleiad: notifications from your PC through your own relay (remoteMessaging)」 |
| 10–30 | PC とスマートフォン | PC の「Settings › Remote › Add device」で QR を出し、スマートフォンの「Add host」で読む。両方の確認コードが同じことを映し、PC で承認する |
| 30–45 | スマートフォン | ホスト一覧の右上の通知（ベル）→「Notify this device」をオン → 通知の許可のダイアログで「許可」→ 電池の最適化の案内（「Later」でよい） |
| 45–55 | スマートフォン | 通知のシェードを下ろし、常駐の通知「Pleiad · Receiving notifications」が出ていることを映す |
| 55–65 | スマートフォン | アプリを閉じて（最近使ったアプリから消す）、画面を消す |
| 65–90 | PC → スマートフォン | PC で新しい会話に `steps:@<ask-later.json のパス>` と送り、別の会話へ移る（20 秒後に fake のバックエンドが承認を求める）。スマートフォンの画面を点け、「◆ Waiting for approval」の通知が届いていることを映す |
| 90–100 | スマートフォン | 通知を押すと会話が開き、承認の操作ができることを映す（承認する） |
| 100–115 | スマートフォン | ベルの画面で「Notify this device」をオフにし、常駐の通知が消えることを映す |

撮った後の確かめ: 常駐の通知・届いた通知・オフで消えることの 3 つが、どれも途切れずに映っていること。
