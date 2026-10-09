# Android 版の配布

Android 版（`mobile/`、Capacitor 8）の署名済み APK は、`main` への push で Android に効く変更があったときに GitHub Release へ自動で出る。デスクトップのリリース（[desktop-releases.md](desktop-releases.md)）とは別の流れで、別のタグを使う（[ADR 0066](adr/0066-android-release-on-main-push.md)）。ワークフローは `.github/workflows/android-release.yml`。

Google Play へは、同じ鍵・同じ版の決め方の AAB を、手動のワークフロー `.github/workflows/android-play.yml` で上げる（下の「[Google Play](#google-play)」、[ADR 0142](adr/0142-android-play-distribution.md)）。

## いつ出るか

`main` への push のうち、次のいずれかに変更があるとき。

- `mobile/android/**`
- `mobile/www/**`
- `mobile/capacitor.config.json`
- `mobile/package.json`・`mobile/package-lock.json`
- `.github/workflows/android-release.yml` 自身

ただし `mobile/android/**/src/test/**` と `mobile/android/**/src/androidTest/**`（JVM・instrumented テスト）だけの変更では出ない。デスクトップやサーバー（`core/`・`web/` など）だけの変更でも出ない（画面はホストが配るため、殻の APK は変わらない）。

流れ: ルートと `mobile/` の `npm ci` → `npx cap sync android` → `./gradlew :remote-core:test` → 版の決定 → 署名付き `assembleRelease` → 署名の検証 → リリース作成。どこかで落ちたらリリースは作られない。

## 版とタグ

- `versionCode` = `git rev-list --count HEAD`（`main` で単調に増える）。
- `versionName` = `<mobile/package.json の version>-<versionCode>`（例 `0.1.0-1234`）。
- タグ = `android-v<versionName>`。そのタグ（またはリリース）が既にあるときは、リリースを作らずに正常終了する。

リリースは prerelease で、`--latest=false` で作る。成果物は `Pleiad-Android-<versionName>.apk` と `SHA256SUMS.txt`。本文は、Android 版であること・インストールの仕方・提供元不明のアプリの許可・上書き更新・対応 Android 13 以上（`minSdk` 33）だけの短い定型で、コミットの羅列は載せない。

`mobile/package.json` の `version` を上げると、次の版の頭が変わる。`versionCode` は頭の番号に関わらず増え続けるので、上げても下げても上書き更新はできる。

## 署名鍵

同じ鍵で署名した APK だけが、入っている版の上から更新できる。**鍵を失うと、既に入っている端末では上書き更新ができなくなる**（アンインストールして入れ直すことになり、端末内のデータは消える）。鍵ファイルの控えは、リポジトリとは別の安全な場所に保管する。**鍵の控えはリポジトリに置かない**（`temporary/` も含む）。

| 種類 | 名前 | 内容 |
|---|---|---|
| Secret | `PLY_ANDROID_KEYSTORE_BASE64` | PKCS12 の keystore を base64 にしたもの |
| Secret | `PLY_ANDROID_KEYSTORE_PASSWORD` | keystore のパスワード |
| Secret | `PLY_ANDROID_KEY_ALIAS` | 鍵の別名 |
| Secret | `PLY_ANDROID_KEY_PASSWORD` | 鍵のパスワード |
| 変数 | `PLY_ANDROID_CERT_SHA256` | 署名証明書の SHA-256（大文字 16 進・コロン無し。比較は大小文字と区切りを正規化する） |

どれかが空なら、ワークフローは署名の手順で明確なエラーを出して落ちる。keystore は実行の間だけ `$RUNNER_TEMP` に復元し、成否にかかわらず最後に消す。

署名の後、最新の build-tools の `apksigner verify --print-certs` で、署名証明書の SHA-256 が `PLY_ANDROID_CERT_SHA256` と一致することを確かめる。一致しない（別の鍵で署名された・変数が空）ときはリリースを作らない。

## 手元で署名付きビルドを作る

`mobile/android/app/build.gradle` は、`PLY_ANDROID_KEYSTORE`（keystore のパス）が環境変数にあるときだけ release に署名する（PKCS12）。無いときは署名なしの `app-release-unsigned.apk` になり、debug ビルドも影響を受けない。`PLY_ANDROID_KEYSTORE` があるのに、次の 3 つのどれかが空だとビルドが止まる。

```
PLY_ANDROID_KEYSTORE=<keystore のパス>
PLY_ANDROID_KEYSTORE_PASSWORD=…
PLY_ANDROID_KEY_ALIAS=…
PLY_ANDROID_KEY_PASSWORD=…
```

環境変数を付けて `mobile/` で `npm run build:release`（`cap sync android` → `gradlew assembleRelease`）。版を決めるときは `-PplyVersionCode=<整数> -PplyVersionName=<文字列>` を `gradlew assembleRelease` に付ける（省くと `1` / `0.1.0`）。出力は `mobile/android/app/build/outputs/apk/release/app-release.apk`。JDK 21 と Android SDK（`local.properties` の `sdk.dir`）が要る。

## やり直し

ワークフローは `workflow_dispatch` でも動かせる（`main` の上だけ。他のブランチでは何もしない）。Secrets や変数の設定漏れで落ちたときは、直してから Actions の画面で「Android release」を手動で実行する。同じコミット数のタグが既にあると何もしないので、二重には出ない。実行は 1 つずつ順に走る（`concurrency: android-release`）。

## 通知に要る権限（2026-10-03）

離れていても届く通知（[ADR 0086](adr/0086-notifications-through-relay.md)）のため、APK は `POST_NOTIFICATIONS`・`FOREGROUND_SERVICE`・`FOREGROUND_SERVICE_REMOTE_MESSAGING`・`RECEIVE_BOOT_COMPLETED` を宣言する。通知の許可はインストール時には尋ねず、利用者が通知をオンにしたときに尋ねる。前面サービス（`NotifyService`、`remoteMessaging`）は通知がオンの間だけ動き、端末の再起動・アプリの更新の後は `BootReceiver` が戻す。Google Play 開発者サービス（FCM）には依存しない。

`./gradlew :remote-core:test` には通知の試験（`NotifyCryptoTest`: 暗号と Node との突き合わせ、`NotifyPlannerTest`: 束ね方・上書き・取り消し、`NotifyInteropTest`: Node の中継と fake のホストを相手にした登録・受信・溜めて渡す）が入る。`NotifyInteropTest` は `node` が PATH に無いとき（または `-Dpleiad.interop=off`）は飛ばす。

## アイコンとスプラッシュ（承認済み（2026-10-09））

モバイル版（Android・iOS）のアイコンとスプラッシュは Pleiad の印（Fold）で、Capacitor の既定の青い X ではない。形は 2026-10-09 にモックで承認済み。

- **形**: 地は `desktop/icon.png`・`web/favicon.svg` と同じ青 `#3a499e`、印は白（折り目の面は `#dfe3f2`）。印の幅は見える面積の約 60%（デスクトップのアイコンと同じ比）。adaptive アイコンでは、どのランチャーの形（丸・スクワークル・角丸四角）でも欠けない 66dp の円の中に収まる。
- **Android のアイコン**: `res/mipmap-*/` の `ic_launcher`（旧式の角丸）・`ic_launcher_round`（旧式の丸）・`ic_launcher_foreground`（adaptive の前景。透過）・`ic_launcher_monochrome`（Android 13 のテーマアイコン）。adaptive の地は `values/ic_launcher_background.xml`（`#3A499E`）、`mipmap-anydpi-v26/ic_launcher(_round).xml` が前景・地・monochrome をまとめる。テーマアイコンは本体と尾を 1 色、折り目だけ 55% の濃さにして、1 色でも P の折り目が残る形。
- **スプラッシュ**: `res/drawable*/splash.png`（明。白地に ink 色の印）と `drawable-night/`・`drawable-{port,land}-night-*/`（暗。`#1b1c23` の地に明るい印）。印は短い辺の約 30%。Android 12 以降の起動画面は OS が adaptive アイコンを出すので、このアイコンが自動で効く。
- **通知の小アイコン**（`drawable/ic_stat_pleiad.xml`）は今の P の線画のまま替えない（24dp のステータスバーでは、印のシルエットだと折り目が潰れる）。
- **iOS**: 同じ印を [ios.md](ios.md)「アイコンとスプラッシュ」に書いた。Play ストアの 512 px のアイコンは `docs/play-store/icon-512.png`（アップロードは下の「Play Console でやること」の手作業で、ここでは上げない）。

### 作り方（再生成）

全サイズを 1 本のスクリプトが `web/favicon.svg`・`web/brand/pleiad-icon.svg`（印の 3 つのパス）から書き出す。依存は Node の組み込みだけ。

```
cd mobile
npm run icons          # 全部書き直す（node scripts/generate-icons.mjs）
npm run icons:check    # コミット済みの PNG が今の SVG と一致するかだけ見る（書かない）
```

ロゴを変えたら `npm run icons` で書き直して、PNG ごとコミットする。`npm test` の `mobile-icons` が `--check` を走らせるので、SVG だけ替えて PNG を忘れると落ちる。出すもの: Android のランチャー 5 密度 × 4 種・スプラッシュ 11 枚 × 明暗・iOS の AppIcon 1024・Splash（明・暗 × 1x/2x/3x）・Play の 512 px。

## Google Play

GitHub Release の APK の流れはそのまま残し、Google Play へは同じ鍵（Play App Signing のアプリ署名鍵に今の鍵を登録する）・同じ `versionCode` の決め方の AAB を、人が決めたときに上げる（[ADR 0142](adr/0142-android-play-distribution.md)）。同じ鍵なので、GitHub の APK を入れた端末は入れ直さずに Play の版へ移れる（逆も同じ）。端末は、入っているものより `versionCode` が大きい方から更新を受け取る。

申請に要る資料の下書きは [play-store/](play-store/) にある（掲載文・前面サービスの申告・審査員向けのアクセス方法・データセーフティ・コンテンツのレーティング）。プライバシーポリシーはサイトの `site/privacy/`（https://pleiad.dev/privacy/ ）で、アプリのホスト一覧の下からも開ける。

### ワークフロー（Android Play upload）

Actions の画面で「Android Play upload」を `main` で手動で実行する（`main` 以外では最初の手順で止まる）。push では動かない。

| 入力 | 既定 | 意味 |
|---|---|---|
| `track` | `internal` | 上げ先のトラック。`internal`（内部テスト）・`alpha`（既定のクローズドテスト）・自分で作ったクローズドテストのトラックの名前。`production`・`beta`（オープンテスト）・`wear:` などのフォームファクターのトラックは弾く |
| `status` | `draft` | `draft`（下書き。Play Console で確かめてから公開する）・`completed`（すぐ公開）・`inProgress`（段階公開） |
| `user_fraction` | 空 | 段階公開で配る割合（0 より大きく 1 より小さい）。`inProgress` のときだけ書く。Google の説明では段階公開は製品版のトラックのもので、テストのトラックでは Play がエラーを返すことがある |
| `changes_not_sent_for_review` | オフ | 変更を審査へ送らずに残す（Play が「自動では審査に送れない」と返したときに使い、Play Console から送る） |

流れ: 入力と Secrets の確かめ → ルートと `mobile/` の `npm ci` → `npx cap sync android` → `./gradlew :remote-core:test` → 版の決定（APK の流れと同じ行） → 署名付き `bundleRelease` → `jarsigner -verify` と `keytool -printcert -jarfile` で署名と証明書の SHA-256 を照合（AAB は jar の署名なので `apksigner` は使わない） → Google Play Developer API で上げる（`r0adkll/upload-google-play`、版は commit の SHA で固定） → 鍵を消す。リリース名は `versionName`。

| 種類 | 名前 | 内容 |
|---|---|---|
| Secret | `PLY_ANDROID_PLAY_SERVICE_ACCOUNT_JSON` | サービスアカウントの鍵の JSON の全文（下の「サービスアカウント」） |
| Secret・変数 | `PLY_ANDROID_KEYSTORE_*`・`PLY_ANDROID_KEY_*`・`PLY_ANDROID_CERT_SHA256` | APK と同じ署名鍵（上の「署名鍵」）。既定ではこれをアップロード鍵にも使う |
| Secret・変数（任意） | `PLY_ANDROID_UPLOAD_KEYSTORE_BASE64`・`PLY_ANDROID_UPLOAD_KEYSTORE_PASSWORD`・`PLY_ANDROID_UPLOAD_KEY_ALIAS`・`PLY_ANDROID_UPLOAD_KEY_PASSWORD`・`PLY_ANDROID_UPLOAD_CERT_SHA256` | 別のアップロード鍵を Play に登録したときだけ。5 つ全部あればこちらで署名し、APK の鍵の Secrets は使わない。一部だけなら止まる |

どれかが足りない・サービスアカウントの JSON の形でない・入力の組み合わせがおかしい（`inProgress` に割合が無い、`draft` に割合がある、など）ときは、ビルドの前に `::error::` で名前を出して止まる。Secrets の値はログに出さない（壊れた JSON の例外も出さない）。`tests/unit/android-play-workflow.mjs` が、この確かめを bash で流し、APK の流れと版の決め方・署名鍵の Secrets・アクションの版が同じことを突き合わせる。

注意:

- **まだ一度も公開していないアプリには、下書き（`draft`）しか作れない**（Play の API が拒む）。最初は `draft` で上げ、Play Console で内部テストへロールアウトする。
- **同じ `versionCode` は二度と上げられない。** 同じコミットでやり直すと Play が拒むので、新しいコミットを `main` に入れてから上げ直す。上げた AAB を別のトラックへ移すときは、Play Console でリリースを昇格させる。
- 実行は 1 つずつ順に走る（`concurrency: android-play`）。

手元で AAB を作るときは、`mobile/android` で `./gradlew bundleRelease -PplyVersionCode=<整数> -PplyVersionName=<文字列>`。出力は `mobile/android/app/build/outputs/bundle/release/app-release.aab`。署名は APK と同じく `PLY_ANDROID_KEYSTORE` ほかの環境変数があるときだけ付く（無ければ署名なし）。2026-10-06 に JDK 23・Android SDK（platform 36）で、署名なし・使い捨ての鍵での署名つきの両方が通ることを確かめた。

### Play Console でやること（順番）

アカウントの操作は人が行う。鍵の控え・PEPK の出力・サービスアカウントの JSON は、リポジトリ（`temporary/` も含む）に置かない。

1. **開発者アカウントを作る（個人）。** Google アカウントで Play Console に登録し、デベロッパー配布契約に同意して登録料 25 米ドルを払う（18 歳以上）。デベロッパー名・法的な氏名と住所・連絡先のメールと電話番号・デベロッパーのメールを入れる。Google Play に出るのは、法的な氏名・国（住所から）・デベロッパーのメールで、収益化すると住所全体も出る。連絡先の電話番号とメールは出ない。[^start][^info]
2. **本人確認を済ませる。** 政府発行の身分証で本人確認をし、連絡先の電話とメールを確かめる。新しい個人アカウントは、Play Console のモバイルアプリで実機の Android 端末を持っていることも確かめる（済まないとアプリを公開できない）。[^verify]
3. **サイトのプライバシーポリシーを公開する。** `main` に入れると Cloudflare がサイトを出し直す（[site/README.md](../site/README.md)）。https://pleiad.dev/privacy/ が開けることを確かめる。
4. **アプリを作る。** 既定の言語（日本語）・アプリ名「Pleiad」（30 字まで）・アプリ（ゲームではない）・無料・連絡先のメールを入れ、宣言（デベロッパー プログラム ポリシー・米国の輸出法・Play App Signing の利用規約）に同意する。パッケージ名は最初に上げる AAB の `com.procway.pleiad` になり、後から変えられない。[^create]
5. **アプリのコンテンツ（申告）を埋める。** 下書きは [play-store/](play-store/)。
   - プライバシーポリシー: https://pleiad.dev/privacy/
   - 広告: 無し
   - アプリへのアクセス: [play-store/app-access.md](play-store/app-access.md)（ホストとのペアリングが要るので、審査用のホストと審査の招待を用意する。[ADR 0172](adr/0172-play-review-access.md)。用意できるまではクローズドテストを申請しない）
   - コンテンツのレーティング: [play-store/content-rating.md](play-store/content-rating.md)
   - ターゲット層: 18 歳以上だけ（[play-store/content-rating.md](play-store/content-rating.md)）
   - データセーフティ: [play-store/data-safety.md](play-store/data-safety.md)
   - 前面サービス（AAB を上げた後に出る）: [play-store/foreground-service.md](play-store/foreground-service.md)。動画が要る
   - ニュース・政府・金融・健康などの申告: どれも当てはまらない
6. **ストアの掲載情報を入れる。** 文は [play-store/listing.md](play-store/listing.md)。アイコン（512×512 の PNG。`docs/play-store/icon-512.png`）・フィーチャー グラフィック（1024×500）・スクリーンショット（2 枚以上）が要る。[^listing]
7. **Play App Signing に今の鍵を登録する（最初のリリースを出す前に）。** 新しいアプリは、既定で Google が作る鍵になる。自分の鍵に変えられるのは、オープンテストか製品版にリリースを出す前まで。[^signing]
   1. 鍵が条件を満たすか確かめる: `keytool -list -v -storetype PKCS12 -keystore <keystore>`。自分の鍵は RSA 2048 ビット以上が要る（「2048 ビット RSA 鍵」以上と出ること）。証明書の SHA-256 が変数 `PLY_ANDROID_CERT_SHA256` と同じことも見る。
   2. Play Console の［Google Play による保護］→［Google Play ストアでの配信］→［Play アプリ署名に移動］で［アプリ署名鍵を変更］を押す。
   3. Java キーストアから鍵を書き出して上げる選択肢（英語の画面では「Export and upload a key from Java keystore」）を選び、画面の PEPK と暗号化の公開鍵を落とす。画面に出るコマンド（`java -jar pepk.jar --keystore=<keystore> --alias=<別名> --output=<出力.zip> --include-cert --rsa-aes-encryption --encryption-key-path=<公開鍵>` の形）を、そのまま手元で実行して鍵を暗号化し、出力の ZIP を上げる。
   4. アップロード鍵: 既定では同じ鍵を使う（ワークフローは APK の Secrets で署名する）。Google はアプリ署名鍵と別の鍵を勧めている。別にするなら `keytool -genkeypair -storetype PKCS12 -keyalg RSA -keysize 4096 …` で作り、証明書（`keytool -export -rfc …`）を Play に登録し、ワークフローの `PLY_ANDROID_UPLOAD_*` を入れる。アップロード鍵は失くしても Play にリセットを頼めるが、アプリ署名鍵は失くすと戻せない。
   5. 登録後、Play アプリ署名のページの「アプリ署名鍵の証明書」の SHA-256 が `PLY_ANDROID_CERT_SHA256` と同じことを確かめる。PEPK の出力の ZIP は消す。
8. **サービスアカウントを作り、Play に招待する。** Play Console の「API アクセス」でプロジェクトをつなぐ手順は要らなくなった。[^api]
   1. Google Cloud Console でプロジェクトを作り、「Google Play Android Developer API」を有効にする。
   2. サービスアカウントを作る（Cloud の役割は付けなくてよい）。鍵（JSON）を作って落とす。
   3. Play Console の「ユーザーと権限」→「新しいユーザーを招待」で、サービスアカウントのメールアドレスを入れ、Pleiad のアプリにテストのトラックへリリースする権限を与える。
   4. GitHub の Secret `PLY_ANDROID_PLAY_SERVICE_ACCOUNT_JSON` に JSON の全文を入れ、手元の JSON を消す。
9. **最初の AAB を上げる。** 「Android Play upload」を `track: internal`・`status: draft` で実行する。Play Console で内部テストのテスター（自分のアカウント）を決めてロールアウトする。内部テストは 100 人まで・アプリの設定が終わっていなくても作れる。[^testing] ここで前面サービスの申告が出るので、5 の申告を済ませる。
10. **鍵が同じことを実機で確かめる。** GitHub の APK が入った端末で、テスターの登録の後に Play から更新し、入れ直し無しで上書きされ、ペアリングしたホストが残ることを見る。
11. **クローズドテストを 14 日続ける。** 既定のクローズドテストのトラックにテスターのリスト（メールアドレスのリストか Google グループ）を付け、配布する国を選び、ワークフローを `track: alpha` で実行するか内部テストのリリースを昇格させて、審査に出す。テスターは参加用のリンクから参加する。**12 人以上が 14 日続けて参加**している必要があり、途中で抜けて入り直した人は数え直しになる。内部テストは数えない。[^test-req][^testing]
12. **製品版を申請する。** ダッシュボードの「製品版へのアクセスを申請」で、クローズドテスト（テスターの集め方・使われた機能・フィードバック）・アプリ（対象の利用者・価値・1 年目のインストール数の見込み）・準備（テストで直したこと）について答える。審査はふつう 7 日以内。[^test-req]
13. **（任意）APK の配布もデベロッパー検証に登録する。** Google は、2026 年 9 月 30 日からブラジル・インドネシア・シンガポール・タイで、2027 年からほかの国でも、認定された端末に入るアプリに登録済みのデベロッパーであることを求める。Play のアプリは Play が登録し、Play の外で配るものは Play Console で登録できる。GitHub の APK は同じパッケージ名・同じ鍵なので、Play Console で登録の状態を確かめる。[^devverify]

[^start]: Google Play Console を使ってみる — https://support.google.com/googleplay/android-developer/answer/6112435
[^info]: Google Play Console デベロッパー アカウントを作成する場合に必要な情報 — https://support.google.com/googleplay/android-developer/answer/13628312
[^verify]: デベロッパーの身元確認情報を認証する — https://support.google.com/googleplay/android-developer/answer/10841920
[^create]: アプリを作成して設定する — https://support.google.com/googleplay/android-developer/answer/9859152
[^listing]: プレビュー用アセットを追加してアプリをアピールする — https://support.google.com/googleplay/android-developer/answer/9866151
[^signing]: Play アプリ署名を使用する — https://support.google.com/googleplay/android-developer/answer/9842756
[^api]: Google Play Developer API のスタートガイド — https://developers.google.com/android-publisher/getting_started 、APK とトラック — https://developers.google.com/android-publisher/tracks
[^testing]: オープンテスト版、クローズド テスト版、内部テスト版をセットアップする — https://support.google.com/googleplay/android-developer/answer/9845334
[^test-req]: 新しい個人用デベロッパー アカウント向けのアプリテスト要件 — https://support.google.com/googleplay/android-developer/answer/14151465
[^devverify]: Android デベロッパーの確認 — https://developer.android.com/developer-verification

## デスクトップの自動更新と干渉しない理由

- デスクトップの自動更新（`desktop/update-auth.cjs` の `newestRelease`）は、タグから `v` を外して semver として有効なものだけを見る。`android-v0.1.0-1234` は有効な semver ではないので無視される。
- stable の更新は `releases/latest` を見る。Android のリリースは `--latest=false` の prerelease なので、`latest` を奪わない。
- Android 版の APK はデスクトップのタグ（`v…`）とリリースノート（`releases/<version>.json`）に含まれない。
