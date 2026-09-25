# デスクトップのバージョンと更新

## バージョンと原稿

Pleiad の画面・サーバー・Electron を一つの `package.json.version` で管理する。Windows/macOS も同じ番号。
修正は PATCH、機能追加は MINOR、互換性に影響する大きな変更は MAJOR。先行版は `0.1.0-beta.1`。
ソースのタグは `v` + バージョン。公開済みのタグ・配布物は差し替えず、新しい番号で修正する。

`releases/<version>.json` がリリースノートの正本。バージョン・公開日・見出し・利用者への影響を記載する。
`npm run release:prepare` はアプリ内の `web/release-info.json` と公開用 `temporary/release-notes.md` を生成する。
package.json と package-lock.json の番号を揃え、原稿と生成済み JSON をコミットする。
公開前に原稿の日付と検証結果を確定する。コミットの羅列はリリースノートの本文にしない。
リリースノートは利用者が使える機能・操作の変更に絞り、リポジトリ移行などの運用経緯は載せない。

## 利用者の操作

設定の左メニュー「アプリ情報・更新」にバージョン、変更履歴、更新の状態、受け取る更新をまとめる。
ブラウザー版と未署名の評価用パッケージでは履歴を読めるが自動更新はしない。
署名を必須にする release 設定だけが `plyRelease: true` と配布先を埋め込む。

新規設定の既定は自動確認あり（起動15秒後、以降30分ごと。ウィンドウへ戻ったときも、前回の確認から10分以上あいていれば確認する）、自動ダウンロードあり、明示的な再起動のみ。
既存の `autoDownload: false` は維持する。自動ダウンロードは設定からいつでも選べる（転送・適用中を除く）。
自動確認をオフにすると手動確認だけになり、会社の管理端末でも更新時期を選べる。
自動ダウンロードを許可しても、終了時・作業完了時の自動適用は行わない。
外部の Codex/Claude Code/Procway Code の導入・更新・認証情報には変更を加えない。

更新設定は Electron userData の `updates.json` に保存する。初回インストールでは更新通知を出さず、
バージョン変更後に一度だけ通知する。リロードでの再通知を防ぐ記録は sessionStorage に持つ。
オンボーディングの履歴は別のまま。過去のリリースノートはアプリに同梱し、オフラインでも読める。
配布元から取得した更新概要は実行可能な HTML として挿入しない。

### 更新UX

| 状態 | 表示と操作 |
|---|---|
| 確認中 | 会話を遮らず裏で確認。設定で状態と最終確認時刻を表示 |
| ダウンロード中 | 左サイドバー下部と設定に進捗バー・取得できた進捗%を表示。「あとで」は出さない |
| 更新あり（手動ダウンロード） | 脇にバージョンと「更新を見る」「あとで」。設定からダウンロード |
| 準備完了 | 脇に「更新準備ができました」。設定に「再起動して更新」 |
| あとで | 同じ版・同じ状態の通知はウィンドウ内で再表示しない。設定の更新マークは残す |
| 再起動を選択 | 保存・再起動の確認を表示。「保存して再起動」で初めて適用する |
| 保存・適用準備中 | 同じ通知と設定に段階名・不定の進捗バーを表示。通知を後回しにしていても表示し、「あとで」は出さない |
| Pleiad終了後の適用中 | Windows はインストーラーの進捗バーだけを出して適用し、終わったら起動し直す。入れ先とインストールの種類（自分のみ／全ユーザー）は前回を引き継ぎ、選択と完了の画面は出さない（`build/installer.nsh`）。アプリ内で適用の進捗%を推測しない |
| 作業・承認待ち | 再起動を拒否し、止めている会話の名前か処理（委譲の完了通知の配達・途中送信・切り替え）を示す。更新ファイルは準備済みのままで、作業に戻れる |
| 通信・認証の失敗 | 設定内で理由と「再試行」。現在のアプリはそのまま使える |
| 署名・整合性の失敗 | 安全性を確認できず適用を中止したことを表示。生の認証エラーは表示しない |
| 更新後 | 更新した版と「変更内容を見る」を一度だけ表示 |

自動再起動、終了時の自動適用、作業完了直後の強制適用はしない。
更新直前には画面の作業確認・保存に加え、サーバーのロックで新しい処理との競合を防ぐ。

## 適用とデータ保護

1. 下書き・エージェント設定の保存が成功したことを画面側で確認する。
2. サーバーの更新用ロックを取得する。実行中ターン、承認待ち、ログインや保存を含む処理中コマンドがあれば拒否する。
3. ロック取得後は新しいコマンドとターンを開始できない。画面も更新中のモーダルを閉じない。
4. OS の更新機構が終了を要求した時点で内部サーバーを終了する。
5. 適用開始に失敗したらロックを解放し、通常の作業と更新の再試行に戻す。

再起動後は保存済みの会話を再度開ける。実行中の LLM ターンの自動復元は約束しない。
今回はデータ構造を変換しない。既存データに形式番号1 (`data-schema.json`) を記録する。
未知の形式や壊れた形式番号では起動を止め、データを上書きしない。
形式番号を導入する以前の0.0.0はこの検査を持たないため、古い実行ファイルへの手動切り戻しは対象外。

今後のデータ形式変更では、全書き込みを停止してから対象ファイルをバックアップし、コピー上で移行と検証を行い、
成功後に形式番号を更新する移行処理とテストを同じPRに追加する。失敗時に元データを維持することを公開条件とする。
アプリの自動ダウングレードは無効。問題があれば修正版の番号を上げて配る。

## 公開前の準備（管理者が一度設定）

### 自己署名での評価

個人・少人数での検証では、無料の自己署名証明書を使える。一般のPCに最初から信頼される署名ではない。
`powershell -NoProfile -File scripts/evaluation-certificate.ps1 -Action Create` で評価用証明書を作る。
秘密鍵は Windows の `CurrentUser/My` に非エクスポート可能で保存し、GitHub や配布物へ入れない。
公開証明書と管理情報は `%LOCALAPPDATA%/Ply/signing/evaluation` に保存する。同じPCでは既存の鍵を再利用する。
この鍵はローカルビルド専用。PC変更や鍵紛失の場合は新しい証明書の信頼設定が必要になる。

検証PCでは公開 `.cer` の拇印を別途確認し、次のコマンドで現在のユーザーに限定して信頼する。
秘密鍵入りの `.pfx` は利用者へ渡さない。この操作はコード署名用途だけの証明書を受け付ける。

```powershell
powershell -NoProfile -File scripts/evaluation-certificate.ps1 -Action Trust -CertificateFile <公開証明書.cer> -ExpectedThumbprint <確認済みの拇印>
powershell -NoProfile -File scripts/build-evaluation.ps1
```

ビルドは署名を必須とし、完成したインストーラーと実行ファイルの署名が `Valid` かつ指定の証明書であることを検証する。
更新時の `verifyUpdateCodeSignature` も有効なまま。信頼設定がないPCでは署名検証に失敗する。
未署名の beta.1 から最初の自己署名版へは手動インストールし、以降は同じ証明書で署名した新しい版を使う。
公開証明書の信頼と SmartScreen の評価は別であり、警告が消えることは保証しない。
証明書の削除・切替は利用者が対象の拇印を確認して行う。正式署名への切替時も更新検証を行う。

### 正式な配布環境

コードと配布先は public リポジトリ `tekalu1/pleiad` にまとめ、Releases で配布する。
正式配布のCIは `github.repository` をアップロード先として使う。アプリに焼き込む更新フィードは別に決める（下記）。

ソースリポジトリの GitHub Environment `desktop-release` に必要な値を設定する。
Environment に必要なレビュアーとタグ制限を設定し、秘密情報は信頼するリリースタグだけに渡す。

| 種別 | 名前 | 内容 |
|---|---|---|
| Actions自動提供 | `GITHUB_TOKEN` | 下書き登録・公開・段階配信のジョブだけ `contents: write`。配布専用PATは不要 |
| Variable | `PLY_WINDOWS_SIGNING` | Windowsの署名方式。`pfx` または `azure`。ローカルでは `store` も対応 |
| Variable | `PLY_WIN_PUBLISHER` | Windows証明書のCommon Nameと完全一致する発行元。更新時にも検証 |
| Secret | `WIN_CSC_LINK` / `WIN_CSC_KEY_PASSWORD` | `pfx` 用の証明書とパスワード。ローカルでは `CSC_LINK` / `CSC_KEY_PASSWORD` |
| Variable | `PLY_AZURE_ENDPOINT` / `PLY_AZURE_ACCOUNT` / `PLY_AZURE_PROFILE` | `azure` 用のHTTPSエンドポイント・署名アカウント・証明書プロファイル |
| Secret | `AZURE_TENANT_ID` / `AZURE_CLIENT_ID` / `AZURE_CLIENT_SECRET` | `azure` 用の署名権限を持つサービスプリンシパル |
| Secret | `MAC_CSC_LINK` / `MAC_CSC_KEY_PASSWORD` | Developer ID Application証明書とパスワード |
| Secret | `APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID` | Apple公証の資格情報 |

Windowsのハードウェア証明書は、署名用端末で `PLY_WINDOWS_SIGNING=store` と証明書のthumbprint `PLY_WIN_CERTIFICATE_SHA1` を指定する。
Windows証明書ストアに秘密鍵へのアクセスを持つ証明書・プロバイダーが必要。GitHubの標準runnerへUSBトークンを持ち込むフローは含まない。
新規契約の前に所在地と個人・法人区分を確認する。Microsoft Artifact SigningのPublic Trustは日本の法人が対象だが、個人は米国・カナダのみ（2026-09-18確認）。
対象外の場合は、その所在地・区分に対応する認証局のハードウェア署名を選ぶ。PFXは利用できる既存契約向けで、秘密鍵の書き出しを前提に新規契約しない。
AzureにはCertificate Profile Signerの権限とPublic Trustプロファイルを用意し、発行元名を証明書に合わせる。
本人確認・証明書発行・契約は未実施。設定を追加しただけでOSに信頼される署名になるわけではない。
現実の資格情報をコード・CLI引数・成果物・アプリに埋め込まない。CI用の書き込みトークンを利用者へ配らない。
証明書が未設定の場合に、未署名で公開へ進むフォールバックはない。

アプリに焼き込む更新フィード（`app-update.yml` の owner/repo）は `PLY_RELEASE_REPOSITORY`、未指定なら `tekalu1/pleiad`。`GITHUB_REPOSITORY` からは導かない。
アップロード先（`GH_REPO`）は Actions の `github.repository`。フィードとアップロード先を分けることで、別リポジトリの Actions で作った版も `tekalu1/pleiad` を見に行く。
Actionsは `PLY_RELEASE_REPOSITORY` Variableや `PLY_RELEASE_TOKEN` Secretを参照しない。

## 製品名と識別子

表示名と配布物の名前は Pleiad。改名前の版からの更新とデータを保つため、`appId: jp.ply.desktop`・package.json の `name: agent-host`・実行ファイル名 `Ply.exe`・署名証明書の発行元名（`CN=Ply Evaluation …`）・`PLY_*` と `AGENT_HOST_*`・データ置き場（`~/.agent-host`）・MCP のサーバー名とツール名は変えない。
アプリは更新の署名を発行元名で照合するので、鍵を替えるときも同じ発行元名にし、利用者には新しい公開証明書の信頼を求める。旧リポジトリ（非公開）からは橋渡し版を一度だけ配り、以後は `tekalu1/pleiad` から更新する（[ADR 0019](adr/0019-rename-ply-to-pleiad-keep-identifiers.md)）。

## 配布と利用者認証

Releases は public で、ブラウザーからはログインなしで取得できる。評価版は自己署名のため、インストール前に公開証明書の扱いを確認する（下記「自己署名の先行版」）。
自動更新は現在も認証付きの GitHub API で最新の先行版を選ぶ（更新設定は `private: true` のまま。認証なしの取得への切替は別作業）。
正式配布版の自動更新では、GitHub CLI を導入し `gh auth login --hostname github.com` を実行しておく。
Electron main が更新確認のたびに `gh auth token --hostname github.com` で資格情報を取得する。
Windows の標準インストール先も探す。未導入・未ログインならログイン方法を案内し、再試行できる。
すでに起動環境へ設定した `GH_TOKEN` / `GITHUB_TOKEN` があれば優先する。専用の fine-grained PAT なら配布先の Contents read 権限を与える。
ブラウザーの GitHub ログイン状態を自動更新が共有することはない。

取得したトークンは Electron main のメモリーに留め、画面・設定ファイル・内部サーバーへ渡さない。
更新ライブラリーの生ログと認証CLIの生エラーは出さない。Pleiadは GitHub CLI の認証情報を書き換えない。
先行版・安定版とも、認証付きGitHubプロバイダー（PrivateGitHubProvider）が要求する `latest.yml` / `latest-mac.yml` を配る。
GitHub Release の prerelease 属性とアプリの先行版設定で選別し、安定版へ先行版を流さない。

未署名の評価版は自動更新を無効のまま配布し、次の評価版は Releases から手動でインストールする。
評価版のリリースノートにはこの制限と対象OSを明記する。署名済みの正式フローとは別で、更新用メタデータは添付しない。
最初の署名済み版への移行も手動インストール。その後の自動更新は旧版→新版を実機で検証する。

## リリース手順

### 自己署名の先行版（現在の運用）

`Evaluation release` は GitHub-hosted `windows-latest` で動く。このPCの常駐プロセス、ログイン状態、self-hosted runnerには依存しない。
`main` に含まれる `vX.Y.Z-beta.N` タグをpushすると、通常テスト・x64/ARM64ビルド・署名・署名検証を行い、そのリポジトリの Releases に先行版を配布する。
下書きへアップロードした全ファイルを再取得してSHA-256を照合した後、100%配信で公開する。失敗時は公開へ進まない。既存リリースのバイナリは上書きしない。

初回設定は `powershell -File scripts/setup-evaluation-secrets.ps1`。GitHub CLIで認証済みの管理者が実行する。
GitHub用の自己署名証明書を作成し、暗号化PFXのBase64を `WIN_CSC_LINK`、ランダムなパスワードを `WIN_CSC_KEY_PASSWORD` Repository Secretsへ標準入力で登録する。
発行元と公開指紋は `PLY_WIN_PUBLISHER` / `PLY_WIN_CERTIFICATE_SHA1` Repository Variablesに登録する。
秘密鍵・パスワードはソース、ログ、Releaseアセットに含めない。署名ステップだけがSecretsを参照し、runnerの一時PFXと証明書ストアは処理後に掃除する。
この証明書は自己署名であり、公的な認証局による署名ではない。

既存のbeta.2の非エクスポート可能な鍵は維持する。GitHub用の新しい鍵は別の `LocalAppData/Ply/signing/github-evaluation` の公開マニフェストで管理し、同じ発行元名を使用する。
更新を受けるWindowsユーザーには、新しい公開証明書の信頼が一度必要。初回設定を実行したユーザーには自動で追加する。
他の評価端末ではReleaseの `Pleiad-Evaluation.cer` と `evaluation-certificate.ps1` を取得し、別途確認した指紋を指定して `-Action Trust -CertificateFile ... -ExpectedThumbprint ...` を実行する。
`SIGNING-INFO.json` は公開証明書の指紋と有効期限、`BUILD-INFO.json` はソースコミットとActions実行URLを記録する。

リリースジョブは所有者のタグpushまたはmainからの手動実行に限定し、タグがmainに含まれることも検証する。PRから署名ジョブは実行しない。

### 認証局の署名・段階配布

1. 原稿・番号を更新し、通常テストを通してリリース用ソースタグを作成する（pushは別途明示操作）。
2. `Desktop signed release` をそのタグ・対象OS・初期配信率で実行する。
   既定の `platforms=windows` はWindows x64/ARM64のみ。`all` はmacOS Intel/Apple Siliconも含める。
   Windowsはインストーラーと両CPUの実行ファイル（Ply.exe）の署名・発行元を、macOSは署名・公証を検証する。
   選んだ全OSの成功後、配布物のSHA-512とメタデータを照合し、変更概要と段階配信率を入れる。
   対象OSを `RELEASE-PLATFORMS.json` に記録し、段階配信でも同じOS構成を使う。OSが欠けた失敗をWindows限定配布と推定しない。
   SHA256SUMSと配布物を一つの下書きリリースにアップロードする。
3. ダウンロードした署名済みインストーラーで、下表の旧版からの更新確認を行う。
4. `Desktop publish or rollout` の `publish` で下書きを公開する。betaはpre-release、安定版はlatest。
5. 少人数で確認後、同ワークフローの `rollout` で10→50→100%へ拡大する。
   配信率は自動で上げない。障害・問い合わせの確認に基づき判断する。

CIは無断でバージョンを決めたりコミット・タグを作ったりしない。ソースと配布先へのpush/公開は明示的な操作。
既存の `Desktop packages` は未署名の評価用生成として残す。

## 配信停止と先行版

配信率0は新しい更新確認を対象外にする。既にダウンロード済みの更新を撤回する機能ではない。
公開済みバイナリは変更せず、障害版より高いバージョンの修正版を用意する。
運用中の配信率変更ではメタデータとチェックサム一覧だけを差し替える。
GitHubの複数アセット更新は完全な同時切り替えではないため、OSごとの反映に短い差が出る。

安定版の利用者へbetaは配らない。先行版は明示的に選んだ利用者とbetaインストーラー利用者が対象。
betaから安定版へ戻しても古い版へ戻さず、現在より新しい安定版を待つ。
各OS/CPUに適合した配布物をupdaterが選ぶ。公開前に実機で選択結果を確認する。

## リリース判定

| ケース | 必須確認 |
|---|---|
| 新規インストール | 両OS/CPUの起動、公式CLIの検出、オンボーディング |
| 旧版→新版 | 会話・下書き・設定・CLI認証が残り、更新後の会話を開ける |
| ターン/承認/ログイン/保存中 | 適用を拒否し、処理を失わない |
| ダウンロード失敗・回線断 | 現行版で作業を続けられ、再試行できる |
| 改ざん・署名不正 | 更新を適用しない |
| 安定版/先行版 | betaが安定版に流れず、古い版に戻らない |
| 段階配信 | 0%で対象外、100%で対象、設定変更後も同一端末の割当が安定 |
| 更新通知 | 初回導入は通知なし、更新後1回、リロードで再表示なし |

通常テストでは状態機械・保存・配布物照合・ロックを検証する。ブラウザーではIPCを模した画面状態を検証する。
未署名Windowsパッケージ生成は署名済みのOS更新テストの代わりにはならない。
選んだOSで署名済み旧版から新版へのインストール試験が終わるまで一般公開しない。macOSを追加するときは実機・公証も確認する。
自己署名版の更新（2026-09-18、beta.2）で未確認: GitHub Releases からの実際の配信での更新、Windows ARM64。

### インストーラー画面の手元確認（Windows）

`build/installer.nsh` を変えたときの画面・起動の確認用。署名済みの更新試験の代わりにはならない。
インストーラーの引数は**更新前の版**の `quitAndInstall` が決める。`installer.nsh` と一緒に引数を変えても、その版から先の更新にしか効かない。

appId・製品名を変え、中身を「起動を記録して終わるだけ」の stub に差し替えて作る。
同じ appId だと導入済みの Pleiad を終了・上書きし、本物のアプリだと再起動時に `~/.agent-host` の実データで2台目が立つため。

```
npx electron-builder --win nsis --x64 --publish never -c.appId=jp.ply.updtest -c.productName=PlyUpdTest -c.extraMetadata.main=desktop/<stub>.cjs -c.directories.output=<出力先>
```

- stub は `desktop/` 配下に置く（`files` の対象）。`process.argv` を `%TEMP%` のログへ追記して `app.quit()` する。コミットしない。
- 導入は `<installer> /S /currentuser`、更新の再現は electron-updater と同じ `--updated --force-run`（サイレントなら `/S` を足す）。消すのは `"%LOCALAPPDATA%\Programs\PlyUpdTest\Uninstall PlyUpdTest.exe" /S /currentuser`。
- 画面の記録は `PrintWindow(h, hdc, 2)` で窓だけを撮る。`CopyFromScreen` は手前にある別のウィンドウを撮る。MUI の完了ページは PrintWindow では黒く写るので、ページの有無は起動ログ（`--updated` の有無）で判断する。
- Pleiad 自身が起動したインストーラーの窓が前面に出るかは、この方法では確かめられない（シェルから起動すると後ろに回る）。

### 完了通知が出ないときの切り分け（Windows）

コードを疑う前に、Pleiad がトーストを出したか・Windows が表示を止めたかを分ける（2026-09-23 に調べたときは、完了はすべて Windows に届いていた）。

- **Pleiad が出したか**: `%LOCALAPPDATA%\Microsoft\Windows\Notifications\wpndatabase.db`（`-wal` / `-shm` も一緒に）を作業用の場所へコピーし、python の sqlite3 で読む。`NotificationHandler.PrimaryId = 'jp.ply.desktop'` の `RecordId` で `Notification` を引くと、`ArrivalTime`（FILETIME、UTC）と `Payload`（トーストの XML。2 つ目の `<text>` が会話名）が出る。これを `~/.agent-host/sessions.json` の `completedAt` と突き合わせる。コピーには通知の本文が入っているので、見終わったら消す。
- **Windows が止めていないか**: `CreateToastNotifier('jp.ply.desktop').Setting` が `Enabled` であることを確かめる。そのうえで同じ notifier からテストのトーストを出し、バナーが出るかを利用者に見てもらう。
- **応答不可がオンか**: WNF の `0x0D83063EA3BF1C75`（QUIETHOURS_ACTIVE_PROFILE）を `NtQueryWnfStateData` で読むと分かる。0 はオフ（制限なし）。1 は重要な通知のみ、2 はアラームのみ（未確認の解釈）。全画面の使用中とゲーム中は自動の規則で切り替わるので、調べた時点の値だけでは過去の状態は分からない。

参照: [electron-builder v26 Auto Update](https://www.electron.build/v26/docs/features/auto-update/)、
[Windows署名](https://www.electron.build/v26/docs/features/code-signing/code-signing-win/)。
署名の対象条件: [Microsoft Artifact Signing](https://learn.microsoft.com/en-us/azure/artifact-signing/quickstart)。
