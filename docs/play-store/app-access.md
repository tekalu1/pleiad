# 審査員向けのアプリへのアクセス（下書き）

Play の審査員は、アプリの制限された部分に入る方法を「アプリのコンテンツ › アプリへのアクセス」で受け取る。ログインや会員などで制限された部分があるなら、入るための詳細を出し、ワンタイム パスワードや多段階の認証のような特別な仕組みは「その他の手順」に書く（指示は 5 組まで。[審査のためにアプリを準備する](https://support.google.com/googleplay/android-developer/answer/9859455)）。

Pleiad のアプリは、ホスト（PC の Pleiad）とペアリングするまで、ホストの一覧・ペアリング・通知の設定の画面しか無い。中身（会話・承認・通知）はすべてホストの先にある。ペアリングには次の制約がある（[remote.md](../remote.md) §3.3）。

- ペアリングのコード（QR と同じ文字列）は、ホストの画面で「端末を追加」を押すたびに作られ、**5 分で切れ、1 回しか使えない**。
- 端末がつなぐと、ホストの画面に承認のダイアログが出て、**ホストの持ち主が確認コードを見比べて承認する**まで登録されない。
- ホストは中継につながっている必要がある（PC が眠ると使えない）。

つまり、今の作りのままでは「審査員がいつ来ても入れる、使い回せる入り方」を渡せない。

## 案の比べ

| 案 | やること | 審査で入れるか | 費用・手間 | 危険 |
|---|---|---|---|---|
| A. 説明と動画だけ | ホストが要ることと使い方を書き、操作の動画を付ける。入り方は渡さない | 低い。「アプリにアクセスできない」として差し戻されやすい | 小さい | 無し |
| B. 人がその場で応じる | 審査用のホストを動かしておき、連絡があれば人がコードを出して承認する | 低い。審査の時刻は分からず、コードは 5 分で切れる | 毎回の待機 | 無し |
| C. 審査用のホストと、審査用の招待（推奨） | 専用の PC か小さなサーバーで、fake のバックエンド（LLM を呼ばない）の Pleiad と中継を常に動かす。その Pleiad にだけ「期限が長く、何度でも使え、承認を自動にする」招待を作る口を足し、そのコードを審査員に渡す | 高い | コードの変更（招待の口）と、常に動かす機械（月数百円〜の VPS など）。審査のたびに招待を作り直す | 自動で承認するホストは、コードを知る誰でも入れる。fake のバックエンドだけ・本物と別の機械とデータ置き場・審査の後に招待と端末を取り消す、で中に価値の無い場所にする |
| D. アプリの中の見本 | ホスト無しで、同梱の見本のデータで画面を動かす | 中くらい。本物の通知の流れ（前面サービス）は見せられない | 大きい（ホストが配る `web/` を同梱して偽のサーバーを持つ） | 無し。ただし本物と違う動きを保つ手間が続く |

**推奨は C。** 前面サービスの申告で通知の流れを動画で見せ（[foreground-service.md](foreground-service.md)）、アプリへのアクセスでは C の招待を渡す。C の招待の口は、自動の承認という安全に関わる決定なので、作る前に ADR を書いて承認を取る（「fake のバックエンドのときだけ」「環境変数で明示したときだけ」「期限と回数の上限」「審査の後の取り消し」を決める）。C ができるまでの間は A で出し、差し戻されたら C を急ぐ。クローズドテストの審査でもアクセスの申告を見られるので、C は早めに用意する。

C の審査用のホストの起動の形（招待の口を足した後）:

```
AGENT_HOST_BACKENDS=fake AGENT_HOST_LOCALE=en AGENT_HOST_DATA=<審査専用の置き場> node core/server.mjs
```

fake のバックエンドは、会話の最初の言葉で台本を選ぶ（`core/backends/fake.mjs`）: `ask` で承認を求め、`question` で質問し、`fail` で失敗し、それ以外は言葉をそのまま返す。会話はメモリにだけあり、ホストを止めると消える。

通知は、その会話をスマートフォンか PC で見ている間は抑えられる（[ADR 0086](../adr/0086-notifications-through-relay.md)）。`ask` はすぐ承認を求めるので、送った画面で見ている間に通知が抑えられる。通知を試すには、少し待ってから承認を求める台本を審査用のホストに置き、`steps:@<そのファイル>` で呼ぶ。

`/srv/pleiad-review/ask-later.json`（置き場は審査用のホストに合わせる）:

```json
{"steps":[
  {"tool":"Wait","input":{"seconds":20},"ms":20000,"result":"waited 20 s"},
  {"tool":"Bash","input":{"command":"echo review"},"ask":true,"result":"review"},
  {"text":"Approved. This reply is scripted (no real AI)."}
]}
```

## 「アプリへのアクセス」に入れる文（C ができた後）

「制限がある」を選び、指示の名前を「Review host (pairing code)」にする。ユーザー名とパスワードの欄は使わない（ペアリングのコードを「その他の手順」に書く）。〈 〉は出す前に埋める。

### 英語

```text
Pleiad is a remote client for Pleiad running on a PC. We run a dedicated review host (no real AI is used; replies are scripted) that approves pairing automatically.

1. Open the app and tap "Add host".
2. Paste this pairing code into "Or paste the pairing code" and tap "Add", then "Add" again on the confirmation:
   〈pleiad://pair?... (valid until 〈date, UTC〉, can be used many times)〉
3. The host "Pleiad Review" is added. Tap it to open the host's screens (conversations, settings).
4. To see an approval: start a new conversation and send "ask". The agent asks for approval; tap Allow.
5. To test notifications (foreground service, remoteMessaging): go back to the host list, tap the bell icon, turn on "Notify this device" and allow notifications. Open the host, start a new conversation, send the text below and close the app right away (notifications are not shown for a conversation you are looking at). About 20 seconds later an "◆ Waiting for approval" notification arrives; tap it to open the conversation. Turning the switch off stops the service.
   steps:@/srv/pleiad-review/ask-later.json

If the code has expired or the host does not respond, please contact us at 〈email〉 and we will issue a new code right away.
```

### 日本語

```text
Pleiad は、PC で動く Pleiad につなぐためのアプリです。審査用に、ペアリングを自動で承認する専用のホストを動かしています（本物の AI は使わず、返事は決まった台本です）。

1. アプリを開き、「ホストを追加」を押します。
2. 「またはペアリングのコードを貼り付け」に次のコードを貼り、「追加」を押し、確認でもう一度「追加」を押します:
   〈pleiad://pair?...（〈日時〉まで有効。何度でも使えます）〉
3. ホスト「Pleiad Review」が追加されます。押すとホストの画面（会話・設定）が開きます。
4. 承認を見るには、新しい会話で「ask」と送ります。エージェントが承認を求めるので「許可」を押します。
5. 通知（前面サービス、remoteMessaging）を試すには、ホストの一覧に戻ってベルのアイコンを押し、「この端末に知らせる」をオンにして通知を許可します。ホストを開いて新しい会話で次の文を送り、すぐにアプリを閉じます（見ている会話の通知は出ません）。20 秒ほどで「◆ 承認を待っています」の通知が届き、押すと会話が開きます。オフにするとサービスは止まります。
   steps:@/srv/pleiad-review/ask-later.json

コードの期限が切れている、ホストが応えないときは、〈メールアドレス〉へご連絡ください。すぐに新しいコードを出します。
```

## A で出すときの文（C ができるまで）

```text
Pleiad is a companion app for Pleiad on a PC (https://pleiad.dev/). All content (conversations, approvals, notifications) lives on the user's own PC and is reached through a relay server that the user runs; there are no accounts. Pairing requires a one-time code shown on the PC and approval on the PC, so we cannot provide reusable credentials. A video of the full flow is here: 〈video URL〉. If you need live access, contact us at 〈email〉 and we will pair a device with a review host for you.
```
