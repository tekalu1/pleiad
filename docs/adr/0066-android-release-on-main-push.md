# 0066 Android の署名済み APK を、main への push で別のリリースとして出す

- 状態: 提案

## 状況

Android 版（`mobile/`、Capacitor 8）には配布の仕組みが無く、APK は手元でビルドして渡していた。デスクトップのリリースは、版・リリースノートの原稿・署名・段階配布を人が決めて出す運用で、周期は Android の変更の頻度と合わない（[desktop-releases.md](../desktop-releases.md)）。

Android の殻（`mobile/android/`・`mobile/www/`）は、画面をホストが配るため変更が少なく、変わったときだけ端末へ届ければよい。一方で、同じ鍵で署名した APK でないと入っている版の上から更新できない。

## 決定

1. **`main` への push で、Android に効く変更があったときに、別のリリースとして署名済み APK を出す。** 検出は GitHub Actions の `paths`（`mobile/android/**`・`mobile/www/**`・`mobile/capacitor.config.json`・`mobile/package.json`・`mobile/package-lock.json`・ワークフロー自身。JVM・instrumented テストだけの変更は除く）。リリースは `android-v<versionName>` のタグで、prerelease、`--latest=false`。デスクトップのリリースには同梱しない。
2. **署名鍵は GitHub Secrets（PKCS12 の base64・パスワード・別名）に置く。** 署名の後に `apksigner` で証明書の SHA-256 を読み、リポジトリ変数 `PLY_ANDROID_CERT_SHA256` と一致しなければリリースしない。鍵の控えはリポジトリに置かず、別の場所に保管する。
3. **`versionCode` は `git rev-list --count HEAD`、`versionName` は `<mobile/package.json の version>-<versionCode>`。** `main` で単調に増え、同じ番号のタグが既にあれば何もしない（再実行しても二重に出ない）。Gradle には `-PplyVersionCode` / `-PplyVersionName` で渡し、署名は環境変数（`PLY_ANDROID_KEYSTORE` ほか）から組む。

## 理由

- 変更の有無は、パスの絞り込みだけで足りる。リリースを作る側に「前回から何が変わったか」の判定を持たなくてよい。
- デスクトップの自動更新は、タグから `v` を外して semver として有効なものだけを見て、stable は `releases/latest` を見る。`android-v…` は semver として無効で、`--latest=false` の prerelease は `latest` にならないので、デスクトップの更新には影響しない。
- コミット数は、追加の管理無しで単調に増え、`versionCode` の条件（上書き更新は常に大きい番号）を満たす。
- 署名は、鍵が CI の外に出ず、鍵の取り違え（別の鍵で署名すると、既存の端末で上書き更新できなくなる）を証明書の指紋の照合で止められる。

### 検討した他の案

**デスクトップのリリースに同梱し、前回のリリースからの差分で Android の変更を判定する。** 退けた。Android の変更の頻度とデスクトップのリリースの周期が合わず、同梱すると変更の無い APK を毎回出すか、変更の有無の判定をリリースの側に持つ必要がある。さらに、デスクトップのリリースの版・原稿・段階配布・更新の検出に Android の成果物が入り込み、自動更新の対象が混ざる。

## 影響

- `.github/workflows/android-release.yml` を足す。`main` に Android の殻の変更が入るたびに 1 回のリリースが出る。運用は [android-releases.md](../android-releases.md)。
- 署名鍵を失うと、既に入っている端末で上書き更新ができなくなる。Secrets 以外に控えを保管する必要がある。
- 初回の実行前に、Secrets 4 つと変数 1 つの設定が要る（無いとワークフローは署名の手順で落ちる）。
- `mobile/package.json` の `version` を変えると `versionName` の頭が変わる。`versionCode` はコミット数なので、上書き更新には影響しない。
- `mobile/android/app/build.gradle` の `versionCode` / `versionName` は、Gradle プロパティが無いときだけ `1` / `0.1.0` になる。署名の環境変数が無いときは署名なしの release になり、debug ビルドは変わらない。
