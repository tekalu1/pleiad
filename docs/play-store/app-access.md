# 審査員向けのアプリへのアクセス

Play の審査員は、アプリの制限された部分に入る方法を「アプリのコンテンツ › アプリへのアクセス」で受け取る。ログインなどで制限された部分があるなら、入るための詳細を出し、ワンタイム パスワードのような特別な仕組みは「その他の手順」に書く（指示は 5 組まで。[審査のためにアプリを準備する](https://support.google.com/googleplay/android-developer/answer/9859455)）。出す情報は「いつでも使え、使い回せ、利用者の場所によらず有効」で、英語でなければならず、切れたパスワードは差し戻しの理由になる（[審査用のログイン情報の提供に関する要件](https://support.google.com/googleplay/android-developer/answer/15748846)、[Play Console 要件](https://support.google.com/googleplay/android-developer/answer/10788890) 3.3）。

Pleiad のアプリは、ホスト（PC の Pleiad）とペアリングするまで、ホストの一覧・ペアリング・通知の設定の画面しか無い。ペアリングのコードは 5 分・1 回で切れ、ホストの持ち主の承認が要る（[remote.md](../remote.md) §3.3）ので、今の作りのままでは使い回せる入り方を渡せない。

## 決めたこと

入り方は [ADR 0172](../adr/0172-play-review-access.md) で決めた（承認済み）。審査用の機械を Coolify に置く手順は [review-host.md](review-host.md)。

- 審査専用の機械で、**審査モード**（`AGENT_HOST_REVIEW=1`）の Pleiad と審査用の中継を常に動かす。バックエンドは fake だけ（LLM を呼ばない）。利用者の PC は使わない。
- そのホストだけが出せる**審査の招待**（期限 90 日・何度でも使える・人の承認なしでペアリングを通す）のコードを、審査員に渡す。生きている端末は 8 台・自動で通すのは 1 時間に 4 台まで。取り消すと、入った端末もすべて切れる。
- 審査モードのホストは、できる操作を許可の一覧で絞る（会話・承認・質問・通知の設定など）。シェルの行・フォルダーの送信・Hooks や MCP などの設定の変更・computer use・ファイルを読む台本は断る。

案の比べ（動画と説明だけ・人がその場で応じる・自動で承認する招待・アプリの中のデモ）と安全の条件は ADR 0172 にある。

### 出す順

1. ADR 0172 の実装（審査モード → 審査の招待 → 審査用の機械）が済み、[review-host.md](review-host.md) の手順で審査用の機械を置くまでは、**内部テストにだけ上げる**（内部テストは通常の審査を受けないことがある。[テストをセットアップする](https://support.google.com/googleplay/android-developer/answer/9845334)）。
2. クローズドテストの申請の前に、審査用の機械を立て、招待を作り（`create`）、下の「審査の招待で出す文」の `〈 〉` を埋めて入れる。
3. 申請・更新のたびに、`show` で招待の残りが 30 日を切っていないか確かめる。切っていれば `create` で作り直し、申告の文のコードと日付を書き換える。審査の前にホストを起動し直して会話を消す。

前面サービスの申告では、通知の流れを動画で見せる（[foreground-service.md](foreground-service.md)）。

## 審査用のホスト

審査用のホストは `deploy/review-host/Dockerfile` の image を Coolify のコンテナで動かす（審査モード・fake のバックエンド・英語・非 root は image が決めてある。手順は [review-host.md](review-host.md)）。招待は、そのコンテナの Terminal で作る:

```
node core/review-invite.mjs create --days 90   # 作る（既定 90 日、最長 180 日。今ある招待は置き換わる）
node core/review-invite.mjs show               # 期限（Expires、UTC）・端末の数・コード
node core/review-invite.mjs show --code-only   # 下の文の 〈pleiad://pair?...〉 に入れるコード
node core/review-invite.mjs revoke             # 取り消す（入った端末もすべて切れる）
```

下の文の `〈 〉` に入れるもの:

| 穴 | 入れるもの |
|---|---|
| `〈pleiad://pair?...〉` | `show --code-only` の出力（1 行。中継の URL・ホストの鍵・招待の秘密が入っている。招待を作り直すと変わる） |
| `〈date, UTC〉` / `〈日時〉` | `show` の `Expires` の日時（UTC）。例 `2027-01-08 00:00 UTC` / 日本語の文では日本時間に直して書いてよい |
| `〈email〉` / `〈メールアドレス〉` | 審査員の連絡を受ける、Play Console の連絡先と同じ宛先 |
| `〈video URL〉` | 急ぎの文で、通知の流れを見せる動画（[foreground-service.md](foreground-service.md)）の URL |

fake のバックエンドは、会話の最初の言葉で台本を選ぶ（`core/backends/fake.mjs`）。審査モードで通す台本は次だけで、それ以外は言葉をそのまま返す。

| 送る言葉 | 起きること |
|---|---|
| `ask` | すぐに承認を求める（「許可」で続く） |
| `question` | 質問を出す |
| `fail` | 失敗で終わる |
| `ask-later` | 20 秒待ってから承認を求める（通知を試す用） |

ホストを再起動すると、会話などのデータは消える（起動のたびに掃除する。残るのは招待と端末だけ）。

通知は、その会話をスマートフォンか PC で見ている間は抑えられる（[ADR 0086](../adr/0086-notifications-through-relay.md)）。`ask` はすぐ承認を求めるので、送った画面で見ている間に通知が抑えられる。通知を試すには `ask-later` を送ってすぐアプリを閉じる。

## 「アプリへのアクセス」に入れる文（審査の招待で出す）

「制限がある」を選び、指示の名前を「Review host (pairing code)」にする。ユーザー名とパスワードの欄は使わない（ペアリングのコードを「その他の手順」に書く）。コードは文字なので、そのまま貼れる。〈 〉は出す前に埋める。

### 英語

```text
Pleiad is a remote client for Pleiad running on a PC. For review we run a dedicated review host that accepts this pairing code automatically. No real AI is used on it; replies are scripted, and some settings are disabled on the review host.

1. Open the app and tap "Add host".
2. Paste this pairing code into "Or paste the pairing code" and tap "Add", then "Add" again on the confirmation:
   〈pleiad://pair?...〉
   The code can be used many times, on several devices, until 〈date, UTC〉.
3. The host "Pleiad Review" is added. Tap it to open the host's screens (conversations, settings).
4. To see an approval: start a new conversation and send "ask". The agent asks for approval; tap Allow.
5. To test notifications (foreground service, remoteMessaging): go back to the host list, open "Notification settings", turn on "Notify this device" and allow notifications. Open the host, start a new conversation, send "ask-later" and close the app right away (notifications are not shown for a conversation you are looking at). About 20 seconds later an "◆ Waiting for approval" notification arrives; tap it to open the conversation. Turning the switch off stops the service.

If the host does not respond, please contact us at 〈email〉 and we will fix it right away.
```

### 日本語

```text
Pleiad は、PC で動く Pleiad につなぐためのアプリです。審査用に、このペアリングのコードを自動で受け付ける専用のホストを動かしています。本物の AI は使わず、返事は決まった台本です。審査用のホストでは一部の設定を使えません。

1. アプリを開き、「ホストを追加」を押します。
2. 「またはペアリングのコードを貼り付け」に次のコードを貼り、「追加」を押し、確認でもう一度「追加」を押します:
   〈pleiad://pair?...〉
   このコードは〈日時〉まで、何度でも、複数の端末で使えます。
3. ホスト「Pleiad Review」が追加されます。押すとホストの画面（会話・設定）が開きます。
4. 承認を見るには、新しい会話で「ask」と送ります。エージェントが承認を求めるので「許可」を押します。
5. 通知（前面サービス、remoteMessaging）を試すには、ホストの一覧に戻って通知の設定を開き、「この端末に知らせる」をオンにして通知を許可します。ホストを開いて新しい会話で「ask-later」と送り、すぐにアプリを閉じます（見ている会話の通知は出ません）。20 秒ほどで「◆ 承認を待っています」の通知が届き、押すと会話が開きます。オフにするとサービスは止まります。

ホストが応えないときは、〈メールアドレス〉へご連絡ください。すぐに直します。
```

## 急ぎのときの文（審査用のホストが使えないとき）

審査用の機械が止まって直るまでに審査が来そうなときだけ使う。Play の要件（審査に要るものを出す）を満たさないので、差し戻されうる。

```text
Pleiad is a companion app for Pleiad on a PC (https://pleiad.dev/). All content (conversations, approvals, notifications) lives on the user's own PC and is reached through a relay server that the user runs; there are no accounts. Our review host is temporarily unavailable. A video of the full flow is here: 〈video URL〉. Please contact us at 〈email〉 and we will send a working pairing code right away.
```
