# デスクトップのバージョンと更新

Android 版の配布（`main` への push で署名済み APK を別のリリースとして出す）は [android-releases.md](android-releases.md)。
Microsoft Store から配る MSIX（Store が署名し、更新も Store が行う。試作の段階）は [microsoft-store.md](microsoft-store.md)。

## バージョンと原稿

Pleiad の画面・サーバー・Electron を一つの `package.json.version` で管理する。Windows/macOS も同じ番号。
番号は semver の `MAJOR.MINOR.PATCH`。機能追加は MINOR、修正だけは PATCH、データ形式・設定の互換性が切れる変更は MAJOR を上げる。
`0.1.0-beta.N` を通し番号として増やす運用は `0.1.0-beta.73` で終えた。次の版を `0.1.0`（beta 卒業）にし、以後は `0.MINOR.PATCH` で進める。
`1.0.0` は、正式な認証局の署名で一般向けに配ると決めたときに上げる（[ADR 0087](adr/0087-stable-versioning.md)）。
`-beta.N` の付いた版は、先に試してほしい版にだけ使う（例 `0.5.0-beta.1`）。GitHub では Pre-release として出し、正式な版（`0.5.0`）は Latest として出す。
先行版の次に出す正式な版は、先行版と同じ `MAJOR.MINOR.PATCH` から `-beta.N` を外した番号にする（`0.5.0-beta.2` の次が `0.5.0`）。semver では `0.5.0-beta.N` は `0.5.0` より古いので、先行版の利用者にもそのまま届く。
ソースのタグは `v` + バージョン（`v0.1.0`、`v0.5.0-beta.1`）。公開済みのタグ・配布物は差し替えず、新しい番号で修正する。

`releases/<version>.json` がリリースノートの正本。バージョン・公開日・見出し・利用者への影響を記載する。
`npm run release:prepare` はアプリ内の `web/release-info.json` と公開用 `temporary/release-notes.md` を生成する。
版上げは **`node scripts/release-bump.mjs <版>`（`npm run release:bump -- <版>`）の 1 本**で行う（[ADR 0162](adr/0162-ci-retry-failed-suites.md)）。版は人が決めて引数で渡す（スクリプトは決めない）。
番号は package.json の 1 か所と package-lock.json の 2 か所（先頭と `packages[""]`）。`npm test` も `web/release-info.json` を作り直すので、番号と原稿が食い違ったままでは落ちる。
`0.12.0-beta.10` を出すときは、この順で行う。
1. `releases/0.12.0-beta.10.json` の原稿を書く（直前の版の形に合わせる）。無ければ、スクリプトが雛形を置いて止まる（書いてから同じコマンドをもう一度）。別の場所で書いた原稿は `--notes <file>` で取り込む。
2. `node scripts/release-bump.mjs 0.12.0-beta.10` を打つ。スクリプトは、次を順に行う。
   - 前提の検査: ブランチが main・作業ツリーが clean（原稿だけ未追跡でよい）・origin/main より遅れていない・版が今までの最新より新しい・タグ `v0.12.0-beta.10` がローカルにも origin にも無い。1 つでも外れたら何も書かずに止まる。
   - package.json・package-lock.json の版を書き換える（CRLF のファイルは CRLF のまま）。
   - `npm run release:prepare` で `web/release-info.json` を作り直し、`node scripts/release-info.mjs --require-new-notes` で原稿を検査する（直前の版と同じ原稿なら止まる）。
   - 速い確認（`node tests/run.mjs release-ci-gate`）を流す。
   - 版・原稿・生成物の 4 ファイルだけを commit し（題は `<版>: <原稿の見出し>`。`--subject`・`--trailer` で変えられる）、タグ `v0.12.0-beta.10` を付ける。
   - 途中で失敗したら、版と生成物は元に戻る（commit もタグも作らない）。
3. 既定では push しない。表示された `git push --atomic origin main v0.12.0-beta.10` を打つ（main とタグが一緒に通るか一緒に落ちる）。`--push` を付けたときだけ、スクリプトが送る。送ると `Evaluation release` が起動し、同じ commit の CI の結果を待って公開する。
`--dry-run` は前提の検査だけ（何も書かない）。`--offline` は origin を見ない（一時の clone での練習用）。

**タグの前に手元で `npm test` 全部は流さない。** コードの確かめは main の CI が行い、赤い commit は `ci-gate` が公開を止める（[release-ci-reuse.md](release-ci-reuse.md)）。CI は落ちた suite だけを 1 回流し直し、通れば緑にする（流し直したことは警告の注釈とジョブのまとめに必ず残る）。手元の `npm test` は流し直さない。
公開前に原稿の日付と検証結果を確定する。コミットの羅列はリリースノートの本文にしない。
リリースノートは利用者が使える機能・操作の変更に絞り、リポジトリ移行などの運用経緯は載せない。

## 利用者の操作

設定の左メニュー「アプリ情報・更新」にバージョン、変更履歴、更新の状態、受け取る更新をまとめる。
ブラウザー版と未署名の評価用パッケージでは履歴を読めるが自動更新はしない。Microsoft Store 版は Store が更新するので、electron-updater を使わず、Store で更新する案内を出す（[microsoft-store.md](microsoft-store.md)「自動更新」）。
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
| 再起動を選択 | 保存・再起動の確認を表示。「保存して再起動」で初めて適用する。無停止の更新（既定）では、確認の段に「実行中の作業 N 件は止まりません。新しい版へは、作業が終わってから切り替わります」を出し、止まる作業の一覧と「中断して更新」は出さない（[design-system.md](design-system.md)「切り替えを待つ表示」） |
| 保存・適用準備中 | 同じ通知と設定に段階名・不定の進捗バーを表示。通知を後回しにしていても表示し、「あとで」は出さない |
| Pleiad終了後の適用中 | Windows はインストーラーの進捗バーだけを出して適用し、終わったら起動し直す。入れ先とインストールの種類（自分のみ／全ユーザー）は前回を引き継ぎ、選択と完了の画面は出さない（`build/installer.nsh`）。アプリ内で適用の進捗%を推測しない |
| 作業・承認待ち | 無停止の更新（既定）は、断らず、作業も止めない（次の行と下の「適用とデータ保護」）。`AGENT_HOST_HANDOVER=off` と、形式番号・口の版が合わない版への更新は、断らずに、止まる作業（会話名・実行中か承認待ちか・バックエンド）を並べ、「あとで」と「中断して更新」を選ばせる。中断して更新は、全部を理由 `update` で中断し、実行中が 0 になるまで「作業を中断しています… N / M」を出して待つ（上限 30 秒。超えたら理由を出して止め、更新ファイルは準備済みのまま）。止まった会話は再起動後に中断として残り、「再開」で続けられる。承認待ちは却下扱いになる（[ADR 0036](adr/0036-interrupt-and-update-while-running.md)） |
| ロックの失敗 | 中断の後でもロックが取れなければ（委譲の完了通知の配達・途中送信・切り替えの最中）、止めている処理を示す。更新ファイルは準備済みのままで、作業に戻れる。無停止の更新では、ロックは切り替えのとき（作業が 0 件になったとき）に取り、取れなければ（短い処理の最中）待ちに戻る |
| 切り替えの待ち（無停止の更新） | 更新の後、窓は新しい版の main のまま、古い版のサーバーの画面を出し、脇の下の知らせに「Pleiad <新しい版> への切り替えを待っています」と待っている作業の件数を出す。作業が 0 件になると新しいサーバーに切り替わり、同じ origin で画面が読み直される。「今すぐ中断して切り替える」と、止まるもの（`!` の行・Codex の裏の端末）だけが残ったときの「あとで／止めて切り替え」がある（[ADR 0152](adr/0152-switch-wait-display.md)） |
| 切り替えの失敗 | 新しい版のサーバーが立たなければ、前の版で起こし直して動き続け、その旨と「もう一度試す」を出す。起こし直しにも失敗したときだけ致命的なダイアログを出す |
| 通信・認証の失敗 | 設定内で理由と「再試行」。現在のアプリはそのまま使える |
| 署名・整合性の失敗 | 安全性を確認できず適用を中止したことを表示。生の認証エラーは表示しない |
| 更新後 | 更新した版と「変更内容を見る」を一度だけ表示 |

自動再起動、終了時の自動適用、作業完了直後の強制適用はしない。「終わったら更新する」予約もしない（[ADR 0036](adr/0036-interrupt-and-update-while-running.md)）。
更新直前には画面の作業確認・保存に加え、サーバーのロックで新しい処理との競合を防ぐ（無停止の更新では、このロックは切り替えのときに取る）。

## 適用とデータ保護

パッケージ版の既定は無停止の更新（`AGENT_HOST_HANDOVER` が無ければ on。[ADR 0151](adr/0151-zero-downtime-update.md)・[設計](zero-downtime-update/design.md) §5.1・§6.1）。NSIS が入れ替えるのは main（Electron）だけで、サーバーは `$INSTDIR` の外の実行場所で走り続け、サーバーの切り替えは作業が終わった後にする。

1. 下書き・エージェント設定の保存が成功したことを画面側で確認する。
2. main がサーバーへ `main-leaving { reason: 'update' }` を送り、`quitAndInstall` する。作業は中断せず、更新用ロックも取らない。実行場所のサーバー（`pleiad-node.exe`）は main の子でなく、名前も場所も NSIS が止める対象（`$INSTDIR` の中・前方一致）に当たらないので、入れ替えをまたいで生き残り、走っているターン・承認待ちはそのまま進む。electron-updater がインストーラーを起こした後に、main はサーバーとのつながりだけを切る。
3. 新しい版の main が起動して、走っているサーバーに付け直す（本物のインストーラーで main が居ない時間は約 45〜50 秒）。サーバーの版・ビルドが自分と違えば、切り替え（`desktop/switch.cjs`）を始める。新しい版の実行場所を組み、事前の確かめ（`core/handover-check.mjs`。データの形式番号・口の版の範囲）を行い、走っている作業（`running` の `count`）が 0 になるまで待つ。
4. 作業が 0 件になったら更新用ロックを取る（ロックは安全網として残し、実行中ターン、承認待ち、ログインや保存を含む処理中コマンドがあれば断る。断られたら待ちに戻る）。旧サーバーを終わらせ、新しいサーバーを同じトークン・ポートで起こして、窓を読み直す。新しいサーバーが立たなければ前の版で起こし直し、その旨を出す。
5. `!` の行・Codex の裏の端末のように切り替えで止まるものが残っていれば、待たずに「あとで／止めて切り替え」を聞く。データの形式番号が違う版・口の版の範囲の外の版は、自動では切り替えず、下の「中断して更新」の形（「あとで／中断して更新」）を聞く。
6. 更新の適用開始に失敗したら `main-leaving-cancel` を送って先送りを取りやめ、つながりは切らない。

main が落ちた・強制終了したときもサーバーは残り、次に起動した main が付け直す。main が居ないまま作業が 0 件で 3 分たつ（更新のために main が離れたときは 30 分）とサーバーは自分で終わる（`core/orphan-guard.mjs`）。アンインストールしても実行場所のサーバーは止められない（`$INSTDIR` の外）。

**中断して更新**（`AGENT_HOST_HANDOVER=off`、実行場所を組めない・main の Job が抜け道を許さない環境、形式番号などが合わない版、切り替えの待ちの「今すぐ中断して切り替える」。ADR 0036）:

1. 下書き・エージェント設定の保存が成功したことを画面側で確認する。
2. 実行中の作業があれば、利用者が「中断して更新」を選んだときだけ全部を理由 `update` で中断し（WS `abort { reason: "update" }`）、`running` の数が 0 になるまで待つ。待つ間に始まったターンも止めるため、残っている間は見るたびに `abort` を送り直す（終了の「中断して終了」も同じ）。
3. サーバーの更新用ロックを取得する。実行中ターン、承認待ち、ログインや保存を含む処理中コマンドがあれば拒否する。
4. ロック取得後は新しいコマンドとターンを開始できない。画面も更新中のモーダルを閉じない。
5. OS の更新機構が終了を要求した時点で内部サーバーを終了する。
6. 適用開始に失敗したらロックを解放し、通常の作業と更新の再試行に戻す。

中断して更新の後は、保存済みの会話を再度開ける。実行中の LLM ターンの自動復元はしない。中断した会話は中断の印（理由付き）で残り、人が「再開」を押したときだけ続きを送る（`docs/design.md`「中断と再開」）。無停止の更新ではターンが中断されないので、この印は付かない。

デスクトップの終了も同じ形にする。実行中の作業があれば「作業に戻る」と「中断して終了」を選ばせ、中断して終了は worker に全部の中断（理由 `quit`）を頼み、実行中が 0 になるのを待ってから（上限 30 秒。超えたら残っている件数を出して終了しない）終了する（`desktop/main.cjs` の closeSafely）。
データ置き場の形式番号（`data-schema.json`）は 2。形式 1 は記録ごとの JSON（`sessions.json`・`agent-tasks.json`・`usage.json`・`conversations.json`と、0.6.0 が書く `channels/threads.json`・`memory/learn-state.json`）、形式 2 は SQLite（`pleiad.db`）で、件数とともに増える記録は行に置く（[ADR 0115](adr/0115-records-in-sqlite.md)）。
形式 1（または形式番号が無い置き場）の起動では、書き込みを始める前に 1 回だけ移行する（`core/schema-migration.mjs`）:

0. データ置き場のロック（`pleiad.lock.db` の SQLite の排他ロック。OS がプロセスの終了で外す）を取る。別のプロセスが持っていれば、移行を始めずに起動を止める
1. 対象の JSON と `data-schema.json` を `<データ置き場>/backup-schema1-<日時>/` へ写す
2. 作りかけの `pleiad.db` があれば消し、新しい DB へ取り込む（1 つのトランザクション）
3. DB から読み戻し、元の JSON と 1 つ残らず突き合わせる
4. 成功したら `data-schema.json` を 2 にし、移行した元の JSON をデータ置き場から外す（写しにバイトまで同じ中身があるものだけ。写しは残る。自動では消さないので、確かめてから利用者が消す）。外せなくても起動は止めず、形式 2 の次の起動が、DB を確かめたうえでもう一度外す。形式 2 では元の JSON を読まない

3 の突き合わせは元の JSON の全体と読み戻した値を比べ、保存できない項目があれば失敗にする。失敗したら作りかけの DB と写しを消し、元の JSON にも形式番号にも触れず、理由を出して起動を止める（直せば次の起動でやり直す）。
形式 2 の起動では、`pleiad.db` の存在・`user_version`・必要な表を確かめ、合わなければ空の DB を作らずに起動を止める。新しい置き場（JSON も DB も無い）だけが DB を新しく作る。形式番号 2 の置き場を見た古い版は、未知の形式として起動を止める（既存の検査。次の行）。
未知の形式や壊れた形式番号では起動を止め、データを上書きしない。
形式番号を導入する以前の0.0.0はこの検査を持たないため、古い実行ファイルへの手動切り戻しは対象外。

今後のデータ形式変更では、全書き込みを停止してから対象ファイルをバックアップし、コピー上で移行と検証を行い、
成功後に形式番号を更新する移行処理とテストを同じPRに追加する。失敗時に元データを維持することを公開条件とする。
形を変えずに値だけを直す移行は、形式番号を上げない。写しを残し、済んだことを対象のファイルに記録する（例: `usage.json` の Claude の記録。[ADR 0052](adr/0052-claude-usage-delta.md)）。
0.6.0 は Channels・bot・記憶・ルーティンのデータ（`channels/`・`bots.json`・`memory/`・`routines.json`・`webhook-secrets.json` と会話の記録の `bot` の欄）を足した（形式番号は 1 のまま）。0.7.0 でデータ置き場の形式番号を 2 に上げる（SQLite への移行。上の手順。[ADR 0115](adr/0115-records-in-sqlite.md)）。形式 2 を見た古い版は起動を止めるので、足したデータを古い版が読み違えて bot の会話が Chats の一覧に普通の会話として並ぶ、ということは起きない（0.6.0 の `channels/threads.json`・`memory/learn-state.json` も、移行で DB の行に取り込む。壊れている・知らない版なら、0.6.0 と同じく読み込まずに止める。古い版へ手で戻すなら、移行前の写し `backup-schema1-*` の JSON が元のデータで、移行後の記録は戻らない。[docs/channels.md](channels.md)「データ」）。
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

## 同梱する CLI

`pleiad` CLI（`bin/pleiad.mjs`）と起動口（`bin/pleiad.cmd`・`bin/pleiad`）を `resources/app/bin/` に同梱する（electron-builder.yml の `files`）。起動口は Ply の内蔵 Node（`ELECTRON_RUN_AS_NODE=1`）で走らせるので、利用者の PC に Node は要らない。インストーラーは OS の PATH を書き換えない（[ADR 0090](adr/0090-cli-in-desktop-app.md)）。
確かめ方: `npm run desktop:pack` の `dist-desktop/win-unpacked/resources/app/bin/pleiad.cmd status` が、Pleiad が起動していなければ「起動していません」と終了コード 3 で終わる。

## 同梱する Node と版ごとの実行場所（無停止の更新 段階 1 の 1-3）

[ADR 0151](adr/0151-zero-downtime-update.md)・[設計](zero-downtime-update/design.md) §3。パッケージ版は既定で（`AGENT_HOST_HANDOVER` が無ければ on。`off` で今の `utilityProcess`）、main が実行場所を組み、そこの `pleiad-node.exe` でサーバーを main の子でない形（detached・stdio なし）に起こす・走っているサーバーに名前付きパイプで付け直す（`desktop/server-boot.cjs`）。on でも、main の Job が抜け道を許さない（`KILL_ON_JOB_CLOSE` だけ）・実行場所を組めないときは `utilityProcess` に落ちる（理由は `updater.log` の `[server]` の行）。更新の流れ（作業を止めずに `quitAndInstall`・切り替えの先送り）は上の「適用とデータ保護」。

- **同梱**: Windows の配布物に公式の Node を `resources\runtime\node.exe` として入れる（x64 93.6 MB・arm64 81.9 MB。x64 のインストーラーは 137.8 MiB → 160.3 MiB と約 22.5 MiB 増え、`win-unpacked` は 4,094 ファイル・491.6 MiB → 4,097 ファイル・581.4 MiB になる。2026-10-06 の実測）。版・URL・SHA-256・大きさは `scripts/node-runtime.json` に固定し、ビルド（`electron-builder.yml` の `afterPack` = `scripts/after-pack.cjs` → `scripts/pack-runtime.cjs`）が取得したファイルを照合する（合わなければビルドが失敗し、キャッシュにも置かない）。取得は `PLEIAD_NODE_CACHE`（既定 `~/.cache/pleiad/node-runtime`）にキャッシュする。リリースの CI は、このフォルダーを `actions/cache` に載せると毎回の取得を省ける。Node の版は Electron の Node と同じメジャー版（24）にそろえ、上げるときは `node-runtime.json` の版と SHA-256（nodejs.org の `SHASUMS256.txt`）を一緒に直す
- 同じビルドで、`resources\runtime\runtime.json`（Node と agent-browser の SHA-256・大きさ）と `resources\app\manifest.json`（ファイルごとの SHA-256・大きさ。`desktop/runtime-manifest.cjs`）を作る。manifest は `resources\app` が出来上がった後に作るので、署名などでそのフォルダーのファイルを書き換える処理を足すときは、`afterPack` より前にする。**manifest は、インストールした後の木と一致していなければならない**: NSIS のインストーラーは、別 CPU の `.exe`・`.dll`（x64 の配布物の中の `node-pty\prebuilds\win32-arm64` の conpty・winpty）を、新しい 7-Zip の ARM64 フィルターで固めるため古い展開器が読めず、黙って落とす（2026-10-06 の実機の確認。落ちると manifest と合わず、実行場所を組めずに `utilityProcess` に落ちる）。動かさない OS・CPU の node-pty の prebuild は `afterPack` が manifest の前に外す（`pruneOtherPrebuilds`）。**ARM64 のインストーラーは、electron 本体の arm64 の `.exe`・`.dll` も同じフィルターで固まり、同じように落ちる恐れがある**【推測。ARM64 の PC で未確認。[stage1-7.md](zero-downtime-update/stage1-7.md) の U8】。リリースのビルドに `ELECTRON_BUILDER_7Z_FILTER=BCJ2`（electron-builder がアーカイブ全体の 7-Zip のフィルターを指定する環境変数）を付ければ避けられる見込み。リリースの確認に「インストール後の `resources\app` が manifest と一致する」を入れる（下の「リリース判定」）
- **実行場所**（`desktop/runtime.cjs`）: `%LOCALAPPDATA%\agent-host-runtime`（`$INSTDIR` と同じ文字列で始まるときは `%LOCALAPPDATA%\jp.ply.desktop\runtime`。NSIS は更新で、パスが `$INSTDIR` で始まるプロセスを止めるので、その外に置く）へ、中身の SHA-256 の `store\<sha256>` とハードリンクで `app\<版>-<ビルドの短いハッシュ>` を組む。読むのは 1 回（ハッシュと写しを同じ読みで、16 並列）で、manifest と合わなければ木を作らず失敗する。同じ版を 2 回頼んでも組み直さず、壊れた写し（欠け・大きさの違い）は組み直す。Node は `node\<版>-<sha256 の先頭>\pleiad-node.exe`（名前を `Ply.exe` にしない）、agent-browser は `agent-browser\<版>\`
- **掃除**: 今の版・直前の版・さらにもう 1 版を残し（使っているシェルの PATH にある `bin\pleiad.mjs` が `core\` を読むので、木ごと残す。ハードリンクなので増えるのは変わった分だけ）、使っているプロセスがある版は消さない。使用中の印は `run\<版>-<pid>.lock.db` の排他ロック（`core/runtime-use.mjs`。OS がプロセスの終了で外す）。main の起動の 1 分後に裏で行う
- 起動口（`bin/pleiad.cmd`・`bin/pleiad`）は、実行場所の `app\<版>\runtime-node.txt` が指す `pleiad-node.exe` を先に探し、無ければ今のとおり `Ply.exe`、最後に `node`。外の AI に貼る設定（`mcpSetup`）は、実行場所のサーバーが main から受ける `PLEIAD_CLI_EXEC`・`PLEIAD_CLI_SCRIPT`（`$INSTDIR` の `Ply.exe` と `resources\app\bin\pleiad.mjs`）を指す
- **サーバーの記録**: 実行場所で起こしたサーバーは stdio を持たないので、標準出力・標準エラー・捕まらなかった例外を `<実行場所>\logs\server.log`（`AGENT_HOST_SERVER_LOG`。`token=…` は伏せ、1MB を超えたら `server.log.old` に 1 世代）に書く。`off`（`utilityProcess`）の経路も同じ仕組みで `userData\logs\server.log`（開発版は `server-dev.log`）に書く。起動に失敗したときは main がその末尾をエラーに出す。main が居ないまま居続けるサーバーは、作業が 0 件のまま 3 分で終わる（更新のために main が離れた後は 30 分。`core/orphan-guard.mjs`）
- 確かめ方: `npm run desktop:pack` の `dist-desktop/win-unpacked/resources/runtime/node.exe` の SHA-256 が `scripts/node-runtime.json` と一致し、`resources/app/manifest.json` の全ファイルが実際のファイルと一致する（`desktop/runtime-manifest.cjs` の `buildManifest` で作り直して `buildHash` を比べる）。組み立ては、`AGENT_HOST_RUNTIME_DIR` を一時のフォルダーにして `desktop/runtime.cjs` の `install` を `resources` に対して呼ぶ（インストール版の Pleiad・`~/.agent-host` には触れない）

## Claude Code の実行ファイルは同梱しない

`@anthropic-ai/claude-agent-sdk` の optionalDependencies（`@anthropic-ai/claude-agent-sdk-<os>-<arch>`、win32-x64 で約 238MB）は、electron-builder.yml の `files` で除外する。Pleiad は Claude の起動で必ず `pathToClaudeCodeExecutable` に利用者が入れた claude（`claudeExecutable()`）を渡すので、SDK 同梱の実行ファイルは読まれない（見つからなければ「未インストール」のエラー）。
確かめ方: `npm run desktop:pack` の `dist-desktop/win-unpacked/resources/app/node_modules/@anthropic-ai/` に `claude-agent-sdk` だけが残る。

## 配布と利用者認証

Releases は public で、ブラウザーからはログインなしで取得できる。評価版は自己署名のため、インストール前に公開証明書の扱いを確認する（下記「自己署名の配布」）。
自動更新に GitHub のログインは要らない。`gh auth login` も不要で、GitHub CLI が無い PC・未ログインの PC でも更新できる。
更新設定は `private: true` のまま（外すと最新の先行版を semver で選ぶ `NewestReleaseProvider` が効かなくなり、先行版のメタデータ `beta.yml` も探されるため。導入済みのアプリにもこの設定が焼き込まれている）。
資格情報が無いときは、`PrivateGitHubProvider` 系の同じプロバイダーが `authorization` ヘッダーを付けずに GitHub API を呼ぶ。
インストーラーと blockmap は、API の資産の URL（`/releases/assets/<番号>`）ではなく公開の配布の URL（`/releases/download/v<版>/<名前>`）から、トークンを付けずに取る。
- 資産の URL は名前を含まない。そのため electron-updater は CPU に合う `Pleiad-<版>-win-<arch>.exe` を選べず、`latest.yml` の先頭にある両方入り（2 倍の大きさ）を取っていた。blockmap の URL も作れず、差分の取得が毎回失敗して全体を取っていた（0.8.1 で直した）。
- 差分の範囲は 1 つずつ要求する。GitHub の配信は、複数の範囲をまとめた要求に 501 を返す。
- 差分の元は、前回の更新で手元に残したインストーラー（`%LOCALAPPDATA%\agent-host-updater\installer.exe`）。0.8.0 までに残した両方入りは、前の版の両方入りの blockmap と組む。
- 0.7.2 → 0.8.0 の x64 なら、取るのは 228MB のうち 6.8MB になる。
資格情報があれば使う（GitHub API のレート制限を避けるため）。Electron main が更新確認のたびに、起動環境の `GH_TOKEN` / `GITHUB_TOKEN`、なければ `gh auth token --hostname github.com`（Windows は標準インストール先も探す）の順で探す。
専用の fine-grained PAT なら配布先の Contents read 権限を与える。ブラウザーの GitHub ログイン状態を自動更新が共有することはない。
認証なしの GitHub API は 1 IP あたり 1 時間 60 回まで。確認 1 回は 1〜2 回の呼び出しだが、同じ回線を共有する PC が多いと上限に達し、403/429 になる。その場合は設定に「しばらく待つか、GitHub CLI で `gh auth login` すると上限が上がる」と出す。トークンを付けたのに 401/403 のときだけ、資格情報の確認を案内する。

取得したトークンは Electron main のメモリーに留め、画面・設定ファイル・内部サーバーへ渡さない。
更新ライブラリーの記録は `userData/logs/updater.log` に残す（1MB を超えたら `.old` に 1 世代だけ残す）。差分の取得が効いたか（`Full: … To download: …`）や失敗の理由は、ここで確かめる。
書く前に、トークン・`authorization`・URL の問い合わせ部分（配信の署名付きの一時 URL の鍵）を伏せる（`desktop/update-log.cjs`）。認証CLIの生エラーは出さない。Pleiadは GitHub CLI の認証情報を書き換えない。
先行版・安定版とも、`PrivateGitHubProvider` が要求する `latest.yml` / `latest-mac.yml` を配る。
GitHub Release の prerelease 属性とアプリの先行版設定で選別し、安定版へ先行版を流さない。

未署名の評価版は自動更新を無効のまま配布し、次の評価版は Releases から手動でインストールする。
評価版のリリースノートにはこの制限と対象OSを明記する。署名済みの正式フローとは別で、更新用メタデータは添付しない。
最初の署名済み版への移行も手動インストール。その後の自動更新は旧版→新版を実機で検証する。

## リリース手順

リリースごとに [外部エージェントの版の表](multi-backend.md#外部エージェントの版) を見直し、検証した版と非公開形式の依存を更新する。検証した版は `core/backend-shape-diagnostics.mjs` の `VERIFIED` にもあるので、両方をそろえる。
Claude の CLI は既定で保持役に載るので（無停止の更新。[ADR 0151](adr/0151-zero-downtime-update.md)）、新しい CLI の版が出ていたら、`scripts/zero-downtime/claude/held-server.mjs` の実機の確かめ（承認待ちを A → B で付け直す）をその版でやり直す。
載せる版の条件は `core/backends/claude-held.mjs` の `HELD_CLI_MIN_VERSION`（確かめた最も古い版。以上で同じ major を載せる）。付け直しに要る口（`pending_permission_requests` など）が無い版・合わなくなった版が出たときだけ、下限を上げるか上限を足す。

### 自己署名の配布（現在の運用）

`Evaluation release` は GitHub-hosted `windows-latest` で動く。このPCの常駐プロセス、ログイン状態、self-hosted runnerには依存しない。
`main` に含まれる `vX.Y.Z`（正式）または `vX.Y.Z-beta.N`（先行版）のタグをpushすると、[同一 commit の main CI の検証結果](release-ci-reuse.md)を確認し、x64/ARM64ビルド・署名・署名検証を行い、そのリポジトリの Releases に配布する（Android のタグ `android-v…` では動かない）。成功を再利用できる場合はリリース環境の短い検査を行い、結果が揃わなければ通常テストを全部回す。main CI の失敗が確認された場合は公開しない。
正式な版は Latest、先行版は Pre-release として公開する。手動実行（`workflow_dispatch`）でも同じ形のタグを受け付ける。
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

1. 原稿・番号の更新とリリース用ソースタグの作成は `scripts/release-bump.mjs`（「バージョンと原稿」）。通常テストは main の CI が通っていること（`Evaluation release` の `ci-gate` が確かめる）を使い、手元で全部は流さない（pushは別途明示操作）。
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

CIは無断でバージョンを決めたりコミット・タグを作ったりしない。ソースと配布先へのpush/公開は明示的な操作（`release-bump.mjs` は人が打つコマンドで、`--push` を付けたときだけ push する）。
既存の `Desktop packages` は未署名の評価用生成として残す。

## 配信停止と先行版

配信率0は新しい更新確認を対象外にする。既にダウンロード済みの更新を撤回する機能ではない。
公開済みバイナリは変更せず、障害版より高いバージョンの修正版を用意する。
運用中の配信率変更ではメタデータとチェックサム一覧だけを差し替える。
GitHubの複数アセット更新は完全な同時切り替えではないため、OSごとの反映に短い差が出る。

安定版の利用者へbetaは配らない。先行版は、設定の「先行版も受け取る」を選んだ利用者と、先行版（版に `-` が付いている）をインストールして選択を変えていない利用者が対象。
受信先（`updates.json` の `channel`）の既定は版で決まり（`-` が無ければ stable、あれば beta）、起動時に保存される。保存後は版が変わっても保存した値を使う。
そのため先行版を入れたことのある利用者は、正式な版に上がっても先行版を受け取り続ける。stable だけにするには「先行版も受け取る」を外す（[ADR 0087](adr/0087-stable-versioning.md)）。
betaから安定版へ戻しても古い版へ戻さず、現在より新しい安定版を待つ。
各OS/CPUに適合した配布物をupdaterが選ぶ。公開前に実機で選択結果を確認する。

## リリース判定

| ケース | 必須確認 |
|---|---|
| 新規インストール | 両OS/CPUの起動、公式CLIの検出、オンボーディング |
| 旧版→新版 | 会話・下書き・設定・CLI認証が残り、更新後の会話を開ける |
| ターン/承認/ログイン/保存中 | 無停止の更新（既定）: ターンが中断されずに更新をまたいで終わり（サーバーの切り替えは終わった後）、承認待ちは新しい版の main で答えられる。保存中・ログイン中は切り替えのロックが断り、待ちに戻る。`off`・合わない版: 適用を拒否し、処理を失わない |
| 更新で実行場所のプロセスが止まらない | 旧版→新版の更新の間、実行場所の `pleiad-node.exe`（サーバー）が止まらず、新しい main が付け直す（`$INSTDIR` の前方一致・中に実行場所が無いこと）。署名した旧版→新版で確かめる（試験用のインストーラーでの確認は下） |
| インストールした木が manifest と一致 | インストール後の `resources\app` が `manifest.json` の全ファイルと一致する（NSIS が黙って落としたファイルが無い。無いと実行場所を組めず `utilityProcess` に落ちる） |
| 新しいサーバーが立たない版 | 前の版のサーバーで動き続け、その旨が出る |
| 形式番号が違う版 | 自動では切り替えず「あとで／中断して更新」を聞く。「あとで」では切り替わらない |
| ダウンロード失敗・回線断 | 現行版で作業を続けられ、再試行できる |
| 改ざん・署名不正 | 更新を適用しない |
| 安定版/先行版 | betaが安定版に流れず、古い版に戻らない。正式な版が Latest、先行版が Pre-release で出る |
| 段階配信 | 0%で対象外、100%で対象、設定変更後も同一端末の割当が安定 |
| 更新通知 | 初回導入は通知なし、更新後1回、リロードで再表示なし |

通常テストでは状態機械・保存・配布物照合・ロックを検証する。ブラウザーではIPCを模した画面状態を検証する。
未署名Windowsパッケージ生成は署名済みのOS更新テストの代わりにはならない。無停止の更新の本物のインストーラー（NSIS・electron-updater）での確認は、署名なしで appId・製品名・インストール先・データ置き場・実行場所・ポートを別にした試験用のインストーラーで行える（`scripts/zero-downtime/stage1-7/`。手順と結果は [stage1-7.md](zero-downtime-update/stage1-7.md)）。署名・スマホ・利用者の操作が要るものは同じ文書の「利用者に頼む確認」。
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
