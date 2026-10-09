# iOS の殻と TestFlight

iPhone・iPad（iOS / iPadOS 16 以上）向けの Capacitor の殻は `mobile/ios/App/`。ホスト一覧は Android と同じ `mobile/www`、暗号とループバックの中継は `mobile/ios/remote-core/` を使う（[ADR 0174](adr/0174-ios-capacitor-shell.md)）。通知は対象外（ADR 0086）。

## 登録前にできること

Apple Developer Program の登録も署名も、シミュレーターのビルドには要らない。

```sh
npm ci
cd mobile
npm ci
npm run sync:ios
```

`cap sync ios` は `www`・設定のコピーと `CapApp-SPM` の生成を行う。remote-core は Xcode プロジェクトの別のローカル依存なので、sync しても消えない。CocoaPods は使わない。

Mac では Xcode 26.3 を選び、次を実行する（[Capacitor 8 は Xcode 26 以上](https://capacitorjs.com/docs/updating/8-0)）。

```sh
xcodebuild build -project ios/App/App.xcodeproj -scheme App -configuration Debug \
  -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO
xcodebuild test -project ios/App/App.xcodeproj -scheme App -configuration Debug \
  -sdk iphonesimulator -destination 'platform=iOS Simulator,name=<利用可能な iPad>' CODE_SIGNING_ALLOWED=NO
```

`.github/workflows/ios-app.yml` が macos-15 / Xcode 26.3 で同じビルドと、Keychain・殻の受け渡しの単体試験を行う。既存の `ios-remote-core.yml` は Xcode 16.4 のまま、CryptoKit と Node の中継との往復を検証する。Windows ではルートの `npm ci` 後に以下を実行できる。

```sh
swift test --package-path mobile/ios/remote-core
node tests/run.mjs ios-shell
node tests/run.mjs mobile-shell
node tests/run.mjs mobile-web
```

`PLEIAD_INTEROP=on` を付けると、Node が無い場合も往復試験を黙って省略しない。シミュレーターでは QR カメラを使えないので、ペアリング用リンクを貼り付けて接続する。Xcode では `npm run open:ios` から App スキームを開ける。

## 登録後の設定

1. Apple Developer で明示的な Bundle ID を登録する。既定は `dev.pleiad.app`。変える場合は `mobile/capacitor.config.json` の `appId` と App ターゲットの Debug / Release の `PRODUCT_BUNDLE_IDENTIFIER` を揃える。App Store Connect に同じ ID の iOS アプリを作る。
2. Apple Distribution 証明書を秘密鍵付きの、パスワードを設定した `.p12` に書き出す。同じ Team・Bundle ID の App Store Connect 用プロビジョニングプロファイルを作る。
3. App Store Connect の「ユーザとアクセス」→「統合」で、アップロード権限を持つ Team API キー（App Manager）を作る。Issuer ID、Key ID、一度だけダウンロードできる `.p8` を保管する。[API キーの管理](https://developer.apple.com/help/app-store-connect/get-started/app-store-connect-api/)
4. GitHub のリポジトリ secrets に下表を設定する。秘密ファイルはリポジトリに置かない。
5. App ターゲットの `MARKETING_VERSION` と App Store Connect の配布情報を確認し、Actions の **iOS app** を手動実行して `testflight` をオンにする。ビルド番号は実行番号と再実行回数。PR・push からは配布しない。秘密が 1 つでも無ければ配布 job はスキップする。

| Secret | 内容 |
| --- | --- |
| `IOS_TEAM_ID` | Developer の Team ID |
| `IOS_DISTRIBUTION_P12_BASE64` | 秘密鍵付き配布証明書 `.p12` の Base64 |
| `IOS_DISTRIBUTION_P12_PASSWORD` | `.p12` のパスワード（空にしない） |
| `IOS_PROVISION_PROFILE_BASE64` | App Store Connect 用 `.mobileprovision` の Base64 |
| `ASC_KEY_ID` | API キーの Key ID |
| `ASC_ISSUER_ID` | API キーの Issuer ID |
| `ASC_PRIVATE_KEY_BASE64` | API キー `.p8` の Base64 |

配布 job は登録後に初めて検証する雛形。証明書・プロファイルを一時 Keychain とランナーの一時領域に復元し、署名した archive を `xcodebuild -exportArchive` でアップロードする。正常終了・失敗のどちらでも秘密を消す。App Store Connect の暗号の輸出コンプライアンスの質問には、Noise・X25519・AES-GCM を使う実装に即して回答する。未確認の適用除外は Info.plist に宣言していない。

## アイコンとスプラッシュ（承認済み（2026-10-09））

アイコンとスプラッシュは Pleiad の印（青 `#3a499e` の地に白い印。Android と同じ形）。形と作り方は [android-releases.md](android-releases.md)「アイコンとスプラッシュ」、書き出しは `mobile/scripts/generate-icons.mjs`（`cd mobile && npm run icons`）。

- **AppIcon**: `Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png`（1024×1024・透過なし。OS が角を丸めるので、角は丸めない全面塗り）。印の幅は全体の約 60%。
- **Splash**: `Splash.imageset` の `splash-2732x2732{,-1,-2}.png`（明。白地に ink 色の印）と `splash-2732x2732-dark{,-1,-2}.png`（暗。`#1b1c23` の地に明るい印。`Contents.json` の `appearances` が `luminosity: dark`）。`LaunchScreen.storyboard` は `scaleAspectFill` で全面に出すので、印は 2732 の正方形の中央に全体の約 14% の幅で置いてある（iPhone で幅の約 3 割、iPad の横向きでも切れない）。1x/2x/3x は同じ画素（既定の `@capacitor/assets` と同じ作り）。

実機（iPhone・iPad の明・暗、ホーム画面・App Switcher・起動の一瞬）での見え方は、Xcode のない環境では確かめていない。TestFlight の確認の項目に入れる。

## iPad の TestFlight 確認

App Store Connect で処理完了・コンプライアンスの回答後、内部テスターのグループにビルドを追加する。招待先の iPad に TestFlight を入れ、招待を受けて Pleiad をインストールする。外部テスターへ配る場合はベータ版の審査も必要になる。[内部テスターを招待](https://developer.apple.com/help/app-store-connect/test-a-beta-version/add-internal-testers/)

- ホストの QR を読み、双方の 6 桁のコードを確認して承認する。カメラ拒否・キャンセル・貼り付け・外部の `pleiad://pair` リンクも試す。
- 会話の表示・送信、添付の選択と保存、可視化の別窓、外部リンク、縦横の回転・キーボード・Split View を試す。
- 背面・画面ロック・Wi-Fi の切替後に戻り、接続と最後の会話が復帰するか見る。再起動、一旦一覧へ戻った後の起動、端末の失効、ホスト削除も試す。
- WKWebView のループバックで `isSecureContext`・`crypto.randomUUID()`・Cookie・WebSocket が動くか確認する（[remote.md §11](remote.md#11-未決)）。端末移行後は Keychain の鍵が移らず、再ペアリングすることを確かめる。

Windows では UIKit・WebKit・AVFoundation・Security の型検査と署名を実行できない。Swift の核と JS の試験が通っても、アプリ全体のビルド・Keychain の試験は macOS CI、カメラ・中断復帰・配布は実機で初めて確かめられる。
