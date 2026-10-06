# 0141 iOS 版の端末側は Swift に移し、ループバックのプロキシ（A 案）で画面を出す

- 状態: 提案

## 状況

モバイル版の iOS は未着手だった（`docs/remote.md` §8）。Android 版は、端末側の中核（Noise・フレーム・チャネル・ペアリング・中継への線・端末内プロキシ）を Kotlin に移した `mobile/android/remote-core/` で動いている。iOS も同じ中核が要る。

決めることは 3 つあった。

1. 端末側をどう持つか。Android と同じく、JS のモジュールをアプリの中で動かす案（nodejs-mobile・隠した WebView）と、ネイティブに移す案がある。
2. 画面（ホストが配る `web/`）を WKWebView にどう出すか。§8.3 の 2 案:
   - A: アプリの中で `127.0.0.1:<p>` に小さな HTTP/1.1 + WebSocket のサーバーを置き、WKWebView はそこを開く（デスクトップ・Android と同じ）。
   - B: `WKURLSchemeHandler`（`pleiad-host://<hostId>/`）で HTTP を横取りしてトンネルへ流し、`window.WebSocket` を差し替える JS でネイティブへ橋渡しする。
3. 試験と配布の置き場。手元は Windows と古い Intel の Mac で、iOS のビルド・試験・TestFlight は GitHub Actions の macOS ランナーで行う（リポジトリは公開なので無料）。

iOS はアプリを背面に回すとすぐに止め、そのアプリのソケットを止める。中継への WebSocket は切れ、待ち受けのソケットも OS に回収される（Apple の TN2277「Networking and Multitasking」）。通知のために背面で線を保つことは iOS ではできないので、通知は iOS の対象外にしてある（[ADR 0086](0086-notifications-through-relay.md)）。

## 決定

1. **端末側は Swift に移す。** `mobile/ios/remote-core/` に Swift Package `PleiadRemote` を置き、Android の `remote-core` を 1 対 1 で移す（X25519・Noise・Frames・Channel・Loop・RelaySocket・Pairing・DeviceLink・DeviceProxy + RFC 6455 の小さな実装・LinkPolicy・ResumePolicy・端末の保管）。通知（`Notify*`）は移さない。Capacitor の iOS の殻（第 2 段階。`mobile/ios/App/` に置く予定）はこれをローカルの package として使う。
2. **画面は A 案（ループバックで待ち受けるプロキシ）。** 背面で止まるのは B 案でも同じなので、A 案は「前面に戻ったら同じポートで待ち受け直し、すぐ張り直す」で足りる。
   - 殻はアプリが前面に戻ったとき（`sceneDidBecomeActive`）に `RemoteDevice.resumeForeground()` を呼ぶ。開いているプロキシは同じポートで待ち受け直し（POSIX では `SO_REUSEADDR` を付けて、TIME_WAIT が残っていても同じポートに戻れるようにする）、中継への線を確かめる。「つながっている」のままの線には PING を送り、3 秒で PONG が返らなければすぐ張り直す（OS に切られたソケットに気づくのを、PING 3 回分の 60 秒以上待たない）。切れていると分かっている線（offline・host-offline）はすぐ張り直す。画面は既存の再接続（1.5 秒ごと、`ready` のあと読み直し）で追いつく。ストリームは持ち越さない（§4.4）ので、作り直す状態は無い。
   - 同じポートに戻るので、オリジン（`http://127.0.0.1:<p>`）が変わらず、`web/` の localStorage（最後の会話）とプロキシの Cookie が残る。ほかのアプリがそのポートを取っていたときだけ別のポートへ移り、`resumeForeground()` がそのホストを返すので、殻は新しい URL で読み直す。
   - 背面で線を保つための延長（`beginBackgroundTask` など）はしない。
3. **待ち受けは Network.framework の `NWListener` ではなく BSD ソケットにする**（§8.3 の表の「Swift は NWListener」を改める）。`127.0.0.1` だけで待ち受ける小さなサーバーには、Network.framework の利点（経路の監視・TLS・Bonjour）が要らない。BSD ソケット（Windows は Winsock）なら同じコードが Windows・Linux・macOS の `swift test` で動き、iOS で動く経路をそのまま手元で試せる。
4. **中継への線は、Apple の上では `URLSessionWebSocketTask`**（TLS・OS のプロキシとネットワークの設定に従う。転送は断る）。Apple 以外では、`ws://` の IPv4 のループバックだけに張れる小さな RFC 6455 のクライアントを使う。これは Windows・Linux で `swift test` が手元の Node の中継と話すためだけのもので、アプリには入らない。
5. **暗号は CryptoKit（Apple）と swift-crypto（それ以外。同じ API）。** X25519 は `Curve25519.KeyAgreement`、AEAD は `AES.GCM`、HASH・HMAC は `SHA256`・`HMAC<SHA256>`（Noise の HKDF は他の実装と同じく HMAC で書く）。swift-crypto は Apple 以外のときだけリンクする（`Package.swift` の条件付きの依存。版は固定）。JSON は Foundation の `JSONSerialization` の癖（Darwin の NSNumber と Bool の取り違え・`\/` の書き出し）を避けるため、小さな自前の読み書きを持つ。
6. **秘密の置き場は差し替えられる形にしておく。** 端末の静的鍵と中継用トークンは 1 つの JSON にまとめ、`SecretVault` に預ける。殻は Keychain（`kSecClassGenericPassword`、`kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`）で実装する（第 2 段階）。`hosts.json` は秘密を持たず、デスクトップ・Android と同じ形。
7. **ペアリングで名乗る種類は `ios`。** iPad も `ios`。
8. **試験は 2 か所で回す。** 手元（Windows）は Swift の Windows 版の toolchain と swift-crypto で `swift test`。CI は `.github/workflows/ios-remote-core.yml` の macOS ランナーで、CryptoKit と `URLSessionWebSocketTask` の経路の `swift test` と、iOS シミュレーター向けのビルドを回す。どちらも Android と同じ共有のベクトル（`tests/remote/vectors.json`）と、`mobile/scripts/fake-host.mjs` の本物の中継と fake のホストとの往復（`InteropTests`。Android の `InteropTest` と同じ筋書きに、前面に戻ったときの待ち受け直しを足したもの）を通す。

## 理由

- **Swift に移す理由は Android と同じ**（`docs/remote.md` §8.3「実装」）。nodejs-mobile は Node 一式を抱え、iOS では JIT が使えず、プロセスに 1 つで作り直せない。隠した WebView は `node:crypto`・`node:http`・`ws` の代わりが要り、待ち受けと中継への線はどのみちネイティブになる。取り決めのずれは共有のベクトルと、Node の中継・ホストとの往復の試験で押さえる。Kotlin と 1 対 1 に移すので、片方で見つけた不具合をもう片方で探しやすい。
- **背面で止まることは A と B の差にならない。** 背面で切れるのは中継への線で、これは B 案でも同じく切れる。B 案は待ち受けのソケットを持たない分だけ「戻ったときに待ち受け直す」が要らないが、どちらの案も戻ったら中継に張り直し、画面は再接続で追いつく。A 案で増える手間は、待ち受けを同じポートで作り直す数行だけ。
- **B 案の重さは変わらない。** `window.WebSocket` の差し替え（接続・メッセージ・close・`bufferedAmount` の再現）を `web/` に注入し、それが壊れたときの切り分けを iOS だけで抱える。独自スキームが secure context と見なされるか（`crypto.randomUUID()` など）、`HttpOnly` の Cookie が独自スキームでどう扱われるかも WebKit 次第になる。A 案はデスクトップ・Android と同じ経路で、`web/` に手を入れず、試験も同じ筋書きで済む。
- **A 案の危険（同じ端末の他のアプリがループバックに届く）は、Android・デスクトップと同じ守りで塞がる。** プロキシの乱数トークン・`Host` の照合・`SameSite=Strict` と `HttpOnly` の Cookie・`/ws` はクエリのトークン必須。ループバックは iOS の「ローカルネットワーク」の許可の対象外。
- **BSD ソケット**: 手元に iOS の実機も新しい Mac も無いので、iOS で動くコードを Windows で試せることを優先した。`NWListener` を使うと、プロキシの待ち受けは macOS の CI でしか試せない。
- **`URLSessionWebSocketTask`**: 本番の中継は `https://`（`wss://`）なので TLS が要る。BSD ソケットで TLS を持つのは筋が悪い。Apple の上では OS の WebSocket を使い、macOS の CI の往復の試験でこの経路を確かめる。
- **背面で線を延ばさない**: 延ばせるのは数十秒で、承認待ちはホストが待ち続ける（§6.2）。戻ったときにすぐ張り直せば足りる。通知は ADR 0086 のとおり iOS では出さない。

## 影響

- `mobile/ios/remote-core/`（`Package.swift`・`Sources/PleiadRemote/`・`Tests/PleiadRemoteTests/`）が増える。iOS 16・macOS 13 以上。swift-crypto 4.5.2 は Swift 6.1 以上（Xcode 16.3 以上）を要る。
- 第 2 段階（Capacitor の iOS の殻）で、`sceneDidBecomeActive` から `resumeForeground()` を呼ぶこと、Keychain の `SecretVault`、ATS の `NSAllowsLocalNetworking`、WKWebView の `127.0.0.1` が secure context と見なされるかの実機での確認（§11-4）が要る。
- ホストの端末一覧では `ios` は「iPhone」と出る（`web/remote.mjs`）。iPad でも同じ表示になる。
- Android（`remote-core`）・Node の実装と取り決めがずれたら、共有のベクトルか往復の試験のどちらかが落ちる。今の版で見つけたずれ（`cleanLabel` の空白の扱い）は直さず、`docs/remote.md` §8.3 に書いた。
- 仕様の今の形は `docs/remote.md` §2.1・§8.2・§8.3。
