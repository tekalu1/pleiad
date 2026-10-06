# ストアの掲載情報（下書き）

Google Play の「メインのストアの掲載情報」に入れる文の下書き。既定の言語は日本語にし、英語（en-US）を翻訳として足す。上限はアプリ名 30 字・短い説明 80 字・詳しい説明 4,000 字（[アプリを作成して設定する](https://support.google.com/googleplay/android-developer/answer/9859152)、[プレビュー用アセットを追加してアプリをアピールする](https://support.google.com/googleplay/android-developer/answer/9866151)）。

書き方の決まり（Play のメタデータの方針）:

- 「最高」「No.1」「人気」などの比較・順位、利用者の声、「今すぐダウンロード」などの呼びかけ、絵文字・記号の連続・強調のための大文字を使わない。
- 他社の名前（Claude Code・Codex・Antigravity）は、対応しているという事実として詳しい説明にだけ書き、アプリ名と短い説明には入れない。提携していないことを書く。
- アプリだけでは使えないこと（PC の Pleiad と中継が要ること）を最初の段落に書く。入れてから使えないと分かると低い評価と返金の依頼につながり、審査でも「機能が足りない」と見られやすい。

## アプリ名

| 言語 | 文 |
|---|---|
| 日本語 | Pleiad |
| 英語 | Pleiad |

## 短い説明

| 言語 | 文 | 字数 |
|---|---|---|
| 日本語 | PC で動く Pleiad にスマホからつなぎ、会話・承認・通知を手元で。 | 37 |
| 英語 | Use Pleiad on your PC from your phone: conversations, approvals and alerts. | 75 |

## 詳しい説明（日本語）

日本語 876 字・英語 1,774 字（2026-10-06 の下書き）。

```text
Pleiad は、PC で動くコーディングエージェントの作業場「Pleiad」に、スマートフォンからつなぐためのアプリです。PC で任せた作業の続きを、席を離れても確かめ、承認し、指示できます。

ご利用には、PC 版の Pleiad（https://pleiad.dev/ ）と、Pleiad の中継サーバーが必要です。中継はご自身で用意します（手順は Pleiad のドキュメントにあります）。このアプリだけでは使えません。

できること
・PC の Pleiad と同じ画面で、会話の一覧・会話の続き・設定を使えます。
・エージェントが承認を待っているときは、その場で許可・拒否できます。
・承認や質問を待っているとき、作業が失敗したとき、終わったときに通知を受け取れます（任意）。
・複数の PC（ホスト）を登録し、切り替えて使えます。
・ファイルを送ったり、PC のファイルを端末に保存したりできます。

つなぎ方
PC の Pleiad で「設定 › リモート › 端末を追加」を開き、表示された QR コードをこのアプリで読みます。両方の画面に出る確認コードを見比べて、PC で承認すると登録されます。

安全とプライバシー
・端末と PC の間の通信は、ペアリングで交換した鍵で暗号化されます。中継は中身を読めません。
・通知の中身も PC が端末ごとの鍵で暗号化して送ります。通知に会話の本文は載せません。
・開発者はアプリの利用者の情報を受け取りません。広告・利用状況の解析はありません。

通知について
通知をオンにしている間は、中継とのつながりを保つため、常駐の通知が 1 つ表示されます。通知はアプリの「通知」の画面でいつでもオフにできます。

対応するエージェント
PC の Pleiad は、Claude Code・Codex・Antigravity などのエージェントを、ご自身のアカウントで使います。Pleiad は、これらのサービスの提供元とは関係のない個人のプロジェクトです。

対応: Android 13 以上
```

## 詳しい説明（英語）

```text
Pleiad connects your phone to Pleiad, the workspace for coding agents running on your PC. Keep up with work you handed to agents when you are away from your desk: check progress, approve actions and send instructions.

You need Pleiad for PC (https://pleiad.dev/) and a Pleiad relay server, which you set up yourself (see the Pleiad documentation). This app does not work on its own.

What you can do
- Use the same screens as Pleiad on your PC: the conversation list, conversations and settings.
- Approve or deny right away when an agent is waiting for approval.
- Get notified when an approval or answer is needed, when work fails and when it finishes (optional).
- Add several PCs (hosts) and switch between them.
- Send files to your PC and save files from your PC to your phone.

How to connect
On your PC, open Settings > Remote > Add device in Pleiad and scan the QR code with this app. Compare the confirmation code shown on both screens and approve on the PC.

Security and privacy
- Traffic between your phone and your PC is encrypted with keys exchanged at pairing. The relay cannot read it.
- Your PC encrypts each notification with a key for your device. Notifications never contain message text.
- The developer does not receive any information about you. There are no ads and no usage analytics.

About notifications
While notifications are on, one ongoing notification stays visible so the app can keep its connection to the relay. You can turn notifications off at any time on the app's Notifications screen.

Supported agents
Pleiad on your PC uses agents such as Claude Code, Codex and Antigravity with your own accounts. Pleiad is an independent personal project and is not affiliated with the providers of these services.

Requires Android 13 or later.
```

## そのほかの欄

| 欄 | 入れるもの |
|---|---|
| アプリのカテゴリ | 仕事効率化（Productivity） |
| タグ | 開発ツールに近いものを選ぶ（Play Console の候補から） |
| メールアドレス | 問い合わせを受けるアドレス（Play に公開される） |
| ウェブサイト | https://pleiad.dev/ |
| プライバシーポリシー | https://pleiad.dev/privacy/ （英語のページは https://pleiad.dev/en/privacy/ 。欄は 1 つなので日本語のページを入れ、ページの上から英語へ移れる） |

## 画像

| 種類 | 条件 | 作り方 |
|---|---|---|
| アプリのアイコン | 512×512、32 ビットの PNG（透過あり）、1,024 KB まで | `mobile/android/app/src/main/res` のランチャーのアイコンと同じ形を 512 px で書き出す |
| フィーチャー グラフィック | 1024×500、JPEG か 24 ビットの PNG（透過なし） | サイトの見出しと星図（`site/assets/og.png` の構図）を元にする |
| スマートフォンのスクリーンショット | 2 枚以上。短い辺 320 px 以上、長い辺 3,840 px 以下、長い辺は短い辺の 2 倍まで | 下の場面を、審査用のホスト（fake のバックエンド）で撮る。本物の会話・ホスト名・パスを写さない |

撮る場面: ホストの一覧 / ペアリングの確認コード / 会話の一覧 / 承認を待っている会話 / 通知（ロック画面の汎用の文と、開いた後の会話名） / 通知の設定の画面。

## リリースノート（「このリリースの新機能」）の型

```text
<ja-JP>
・〈変わったこと 1 行〉
</ja-JP>
<en-US>
- 〈one line per change〉
</en-US>
```
