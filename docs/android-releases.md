# Android 版の配布

Android 版（`mobile/`、Capacitor 8）の署名済み APK は、`main` への push で Android に効く変更があったときに GitHub Release へ自動で出る。デスクトップのリリース（[desktop-releases.md](desktop-releases.md)）とは別の流れで、別のタグを使う（[ADR 0066](adr/0066-android-release-on-main-push.md)）。ワークフローは `.github/workflows/android-release.yml`。

## いつ出るか

`main` への push のうち、次のいずれかに変更があるとき。

- `mobile/android/**`
- `mobile/www/**`
- `mobile/capacitor.config.json`
- `mobile/package.json`・`mobile/package-lock.json`
- `.github/workflows/android-release.yml` 自身

ただし `mobile/android/**/src/test/**` と `mobile/android/**/src/androidTest/**`（JVM・instrumented テスト）だけの変更では出ない。デスクトップやサーバー（`core/`・`web/` など）だけの変更でも出ない（画面はホストが配るため、殻の APK は変わらない）。

流れ: `npm ci` → `npx cap sync android` → `./gradlew :remote-core:test` → 版の決定 → 署名付き `assembleRelease` → 署名の検証 → リリース作成。どこかで落ちたらリリースは作られない。

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

## デスクトップの自動更新と干渉しない理由

- デスクトップの自動更新（`desktop/update-auth.cjs` の `newestRelease`）は、タグから `v` を外して semver として有効なものだけを見る。`android-v0.1.0-1234` は有効な semver ではないので無視される。
- stable の更新は `releases/latest` を見る。Android のリリースは `--latest=false` の prerelease なので、`latest` を奪わない。
- Android 版の APK はデスクトップのタグ（`v…`）とリリースノート（`releases/<version>.json`）に含まれない。
