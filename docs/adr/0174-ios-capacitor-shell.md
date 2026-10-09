# ADR 0174: iOS の Capacitor の殻とループバック接続

- 状態: 採用
- 日付: 2026-10-09
- 関連: [ADR 0144](0144-ios-remote-core-in-swift.md)、[remote.md §8](../remote.md)、[iOS の手順](../ios.md)

## 背景

Swift Package の端末側に、Android と同じホスト一覧・QR ペアリング・ホストの窓をつなぐ。Apple Developer Program の登録前にも、署名なしのシミュレーター向けビルドと試験を進められる構成が要る。

## 決定

1. `mobile/ios/App` は Capacitor 8.5.2（`mobile/package.json` と同じ版）の SPM 構成。CLI が生成する `CapApp-SPM` と別に、Xcode プロジェクトから `../remote-core` の `PleiadRemote` を参照する。sync で独自の依存が消えない。最低 iOS 16、iPhone・iPad、単一シーンとする。
2. 一覧だけに Capacitor を渡し、`PleiadRemote` は Android と同じメソッド・応答・エラーコード・イベントを公開する。ホストは別の WKWebView から方式 A の `http://127.0.0.1:<port>` を開く。ホストのオリジンかつ main frame のみに `plyRemote` を渡し、同じ条件でメッセージを受ける。Capacitor や QR の権限は渡さない。
3. 端末の静的鍵と中継用トークンは `kSecClassGenericPassword` の 1 項目に保存する。service は `dev.pleiad.app.remote`、account は `secrets`、属性は `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly` と `kSecAttrSynchronizable=false`。再起動後の最初のロック解除までは読めず、iCloud 同期や別端末への移行はしない。読み書きの失敗は `storage` として返し、平文へ退避しない。秘密を含まない `hosts.json` もバックアップから除外する。
4. QR は AVFoundation の `AVCaptureMetadataOutput`（`.qr`）で読む。SPM を持たない Android 用 ML Kit プラグインを iOS へ入れず、`QRScannerPlugin` が `BarcodeScanner` の JS 名と戻り値を再現する。カメラの許可は読み取り操作時だけ求める。キャンセルは空の `barcodes`。手入力・貼り付けも共通画面で使える。
5. `SceneDelegate` の前面復帰で `resumeForeground()` を呼ぶ。ポートが変わったホストだけ再読込し、背面・復帰のイベントをページへ送る。最後に開いたホスト ID を UserDefaults で覚え、通常起動で `ResumePolicy` に従い開く。一覧への戻り・ホスト削除で忘れ、ペアリングリンクでの起動時は復元しない。
6. ATS は `NSAllowsLocalNetworking` のみ有効にし、任意の平文通信を許可する設定は使わない。中継の URL の制限は remote-core が行う。WebView の別窓は `LinkPolicy` に従い、保存した可視化はアプリ内、外部 Web は既定ブラウザー、localhost は案内にする。
7. 通知は ADR 0086 のとおり対象外。`notify*` を公開せず、iOS の一覧に注入する小さなスクリプトで通知の入口を隠す。`mobile/www` は変更しない。
8. macos-15 の殻の CI は Xcode 26.3（Capacitor 8 の要件）で署名なしのビルドとシミュレーターの単体試験。remote-core の macOS 試験は Xcode 16.4 を維持する。TestFlight は手動指定と secrets の充足の両方を条件にし、署名・アップロードの雛形を置く。

## 影響

暗号・HTTP・WebSocket の経路を共通の Swift Package の試験で確かめ、JS の形と境界は Node、Keychain の属性はシミュレーターの試験で確かめる。App Store Connect の登録・署名情報は [ios.md](../ios.md) にまとめる。WKWebView の secure context、カメラ、中断復帰、iPad の表示、TestFlight の配布は実機確認を残す。
