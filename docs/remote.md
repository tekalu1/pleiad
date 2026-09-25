# リモート対応

作成 2026-09-23（issue #10、親 #17）。別の PC で動くホストの Pleiad を、デスクトップ版とモバイル版から設定を含めてすべて使うための設計。方式の理由は [ADR 0013](adr/0013-remote-via-relay-with-noise.md)。

## 1. 目的と範囲

### やること

- デスクトップ版・モバイル版から、ホストの Pleiad を**ホストの画面と同じように**使う（会話・承認・設定・MCP・アカウントまで）
- 通信は自前の中継サーバー（Coolify にデプロイ）を通す。ホストも端末も外向きに接続するので、ポート開放も VPN も要らない
- **中継は中身を読めない。** 端末とホストの間で暗号化し、鍵は QR のペアリングで交換する
- ホストの既存サーバーは今のまま `127.0.0.1:7420` で待ち受ける。外に出る口は増やさない
- リモートの窓は、ローカルの窓と一目で見分けられる

### やらないこと

- **リモートのための機能は足さない。** 通信を中継するだけ。画面はホストが配る `web/` をそのまま使う
- 端末ごとの権限（閲覧だけ・設定変更不可など）。当面は**全権限**（トークン保持者 = ホストの利用者、という今の信頼モデルのまま）
- ブラウザー・PWA からのリモート接続。E2E の中継はアプリ内のプロキシが前提なので、端末はデスクトップ版かモバイル版
- 複数の利用者で 1 台の中継を共有すること。中継は 1 人の持ち物（§5.4）
- P2P（WebRTC）、Tailscale・Cloudflare Tunnel（決定済み。第三者のアカウントや TLS 終端を挟まない）
- プッシュ通知（§11 未決）、リモートからのホストのアプリ更新、リモートからのログイン操作（§7.3）、モバイルからのフォルダー送信

## 2. 全体構成

```
 端末（デスクトップ版 / モバイル版）                 中継（Coolify）                    ホスト PC
┌──────────────────────────────┐                ┌──────────────────┐          ┌──────────────────────────────────────┐
│ 窓 / WebView                  │                │ Traefik (HTTPS)  │          │ Pleiad（デスクトップ版 or npm start）   │
│  http://127.0.0.1:<p>/?token= │                │        │         │          │                                      │
│        │ HTTP + WS（平文・     │                │  relay/server.mjs│          │  ホストの接続口 core/remote/connector  │
│        ▼  ループバック）       │   wss://       │  ・照合だけ       │  wss://  │   │ 復号 → HTTP/WS を組み立て直す       │
│ 端末内プロキシ ───────────────┼──暗号文────────▶│  ・右から左へ流す │◀─暗号文──┼───┤ トークンを差し込む                  │
│  ・ストリームを多重化          │ (Noise IK の    │  ・中身は読めない │ (外向き) │   ▼                                  │
│  ・Noise で暗号化              │  transport)    └──────────────────┘          │  既存サーバー 127.0.0.1:7420（変更なし）│
│ 資格情報: 端末の静的鍵,        │                                              │   ・/ws  ・web/ ・/local-file ...     │
│  中継用トークン（安全な保管庫） │                                              │   ・/mcp/*（内部用。接続口が通さない）  │
└──────────────────────────────┘                                              └──────────────────────────────────────┘
```

- 端末の画面は**端末内プロキシ（`127.0.0.1`）から読む**。プロキシが HTTP と WebSocket を 1 本の暗号化チャネルに載せ、ホストの接続口がホストの `127.0.0.1` へ組み立て直す。
  画面はホストが配るので、UI とサーバーの版ずれが起きない。ループバックなので `ws://` 固定（`web/client.mjs:3140`）も secure context 限定の API（`crypto.randomUUID()`、`web/client.mjs:3123`）もそのまま動く（WKWebView は §8.3 で確認）
- 既存サーバーから見ると、リモートの端末は「ループバックから来たもう 1 つのタブ」。複数タブ・複数端末の同時接続は既に設計に入っている（全イベント配信・途中参加のスナップショット・承認の全端末同期・送信の冪等化）
- 中継は「どのホスト ID にどの端末がつないでよいか」をハッシュで照合し、通ったら 2 本の WebSocket をつなぐだけ

### 2.1 置き場所

| 部品 | 場所 | 言語 |
|---|---|---|
| 中継 | `relay/`（独立した `package.json`、依存は `ws` だけ。`Dockerfile`） | Node |
| 暗号・フレーム・チャネル（共有） | `core/remote/noise.mjs`、`core/remote/frames.mjs`、`core/remote/channel.mjs`（ストリームの多重化と流量の制御。運び手に依存しない） | Node（ESM。デスクトップの main からは `import()`） |
| ホストの接続口・ペアリング・端末一覧 | `core/remote/connector.mjs`、`core/remote/devices.mjs`。サーバーのプロセス内で動く（`npm start` のホストでも使える） | Node |
| 端末の資格情報・ペアリング・端末内プロキシ | `core/remote/device.mjs`（置き場・ペアリング・ホストごとのプロキシの管理）、`core/remote/device-link.mjs`（中継への線・張り直し・状態）、`core/remote/device-proxy.mjs`（127.0.0.1 の HTTP と /ws）。デスクトップの main から `import()`、試験からも使う | Node |
| リモートの窓・ほかのホストにつなぐ窓 | `desktop/remote-windows.cjs`（窓・IPC・印。main プロセス）、`desktop/remote-preload.cjs`（リモートの窓の preload）、`desktop/remote-hosts.html`・`remote-hosts-view.cjs`・`remote-hosts-preload.cjs`（同梱の窓）、`desktop/window-trust.cjs`（窓ごとのオリジンの表）、`desktop/i18n.cjs`（本体の文言）。画面の印は `web/remote-badge.mjs` | Node |
| 手元のフォルダーを送る（§8.1） | `core/folder-uploads.mjs`（`upload*` コマンドの中身・置き場・パスの検査）、`web/folder-upload.mjs`（送る流れとドロップの問い）、`web/attach-menu.mjs`（添付のボタンのメニュー） | Node / JS |
| モバイルの殻 | `mobile/`（Capacitor 8。独立した `package.json`）。Android: `mobile/android/remote-core/`（端末側の Kotlin 移植。純粋な JVM で Gradle の試験）、`mobile/android/app/`（殻・ホストの窓・Keystore）、`mobile/www/`（同梱のホスト一覧）、`mobile/scripts/fake-host.mjs`（試験用の中継 + fake のホスト）。iOS は未着手 | Kotlin / JS（iOS は Swift） |
| 試験ベクトル | `tests/remote/vectors.json`（Noise の公式ベクトル + フレームの例。3 実装が同じものを読む） | — |

## 3. 暗号とペアリング

### 3.1 鍵と識別子

| もの | 持ち主 | 保存 | 用途 |
|---|---|---|---|
| ホストの静的鍵（X25519） | ホスト | `<data>/remote/secrets.json` の `hostKey`（`core/secret-store.mjs`。デスクトップは safeStorage、`npm start` は 0600）。公開鍵は秘密鍵から導く | Noise の静的鍵。端末が QR で公開鍵を覚えて照合する |
| `hostId` | 公開 | — | `base32(SHA-256(ホストの公開鍵))` の先頭 26 字。中継での宛先 |
| 端末の静的鍵（X25519） | 端末 | Electron は safeStorage、iOS は Keychain（`AfterFirstUnlockThisDeviceOnly`）、Android は Keystore で包む | Noise の静的鍵。ホストの端末一覧に公開鍵を登録 |
| `deviceId` | ホストが発行 | ホストの `devices.json`・端末の保管庫 | 端末一覧と中継での識別 |
| 中継用トークン（256bit） | ホストが発行し端末へ | 端末の保管庫。ホストと中継は **SHA-256 だけ** | 中継が「この端末はこのホストにつないでよい」を照合する |
| 中継の登録用の秘密 `RELAY_ENROLL_SECRET` | 中継の持ち主 | Coolify の環境変数・ホストの設定（secret-store） | ホストが中継に登録できる者を限る（開いた中継にしない） |
| ペアリングの秘密（256bit） | ホストが生成 | QR の中だけ。5 分・1 回で失効 | Noise の psk と、中継で使う入場券を別々に導く |

### 3.2 ハンドシェイク

**Noise の既存パターンをそのまま実装する**（自作の組み立てはしない）。

- 通常の接続: `Noise_IK_25519_AESGCM_SHA256`。端末はホストの公開鍵を知っている（IK の前提）。ホストは届いた端末の静的公開鍵が端末一覧にあり、取り消されていないことを確かめる
- ペアリング: `Noise_IKpsk2_25519_AESGCM_SHA256`。psk = `HKDF(ペアリングの秘密, "pleiad pair psk")`。QR を読んだ端末だけが通る
- prologue: `"pleiad-remote/1" || hostId`。別のホスト・別の版への付け替えを防ぐ
- メッセージ 1 は再送（リプレイ）されうるが、中身は版と端末名だけで、データはメッセージ 2 以降のホストの一時鍵の上でしか流れないので、再送しても何も得られない。確立後の通信は一時鍵どうしで前方秘匿
- 鍵を回すのは接続ごと（再接続 = 新しいハンドシェイク）。1 本の接続で 2^32 通を超えたら切って張り直す（実質起きない）

**Node の標準 `crypto` だけで組める。新しい依存は足さない。**
X25519 は `generateKeyPairSync('x25519')` と `diffieHellman()`（生の 32 バイトは PKCS#8 / SPKI の DER の決まった前置きを付けて出し入れ）、AEAD は `createCipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 })`、HASH と HKDF は `createHash('sha256')`・`createHmac('sha256')`（Noise の HKDF は HMAC で書く定義どおり）。nonce は Noise の定めどおり 4 バイトの 0 + 64bit **大端**の通番（AESGCM の定義。ChaChaPoly の小端と取り違えない）。
AEAD は AES-256-GCM にする（2026-09-23 に ChaChaPoly から変更）。Electron の Node は BoringSSL で `chacha20-poly1305` が無く（electron 44 で `Unknown cipher`）、デスクトップ版の端末（main）もホスト（utilityProcess。`ELECTRON_RUN_AS_NODE` でも同じ BoringSSL）もつなげなかったため。`aes-256-gcm` は Node（OpenSSL）と Electron（BoringSSL）の両方にあり、iOS の CryptoKit（`AES.GCM`・`Curve25519.KeyAgreement`・`HKDF`）と Android の `javax.crypto`（`AES/GCM/NoPadding`）にも揃うので、3 実装が同じ組を使える。タグは 16 バイト、1 通の大きさの上限も変わらない。`tests/unit/remote-noise.mjs` が `crypto.getCiphers()` に入っていることを確かめる。実装は公式の試験ベクトル（cacophony の IK / IKpsk2 の AESGCM）で確かめる。

細部（実装 `core/remote/noise.mjs` で決めたこと。3 実装が揃える。例は `tests/remote/vectors.json` の `pleiad`）:

- psk と入場券の `HKDF(秘密, 札)` は RFC 5869 の HKDF-SHA256（salt は空、info は札の UTF-8、長さ 32）。Noise の内側の HKDF とは別物
- `hostId` の base32 は RFC 4648 の字母を小文字で、埋めなし
- 確認コード = `HMAC-SHA256(key = ハンドシェイクのハッシュ h, "pleiad pair code")` の先頭 4 バイト（BE）を 10^6 で割った余りを 0 埋め 6 桁。表示は 3 桁ずつ区切る
- 2^32 通の上限は送り・受けの nonce ごと。達したら暗号化・復号が例外になり、呼び側はチャネルを閉じて張り直す

### 3.3 ペアリングの流れ

1. ホスト: 設定 › リモート で有効化（中継の URL と登録用の秘密）。接続口が中継へつながる
2. ホスト: 「端末を追加」→ ペアリングの秘密を作り、中継に入場券のハッシュ `SHA-256(HKDF(秘密, "pleiad pair ticket"))` を 5 分・1 回の約束で登録 → QR を表示（残り時間の表示。期限が来たら作り直せる）
   QR の中身: `pleiad://pair?v=1&r=<中継の URL>&h=<hostId>&k=<ホストの公開鍵 base64url>&s=<ペアリングの秘密>&n=<ホスト名>`。
   QR の下に同じ文字列の「コードをコピー」（デスクトップ版どうしは貼り付けで足す）
3. 端末: QR を読む（モバイルはカメラ、デスクトップ版は貼り付け）。静的鍵が無ければ作る → 入場券で中継へつなぎ、IKpsk2 でハンドシェイク。最初のメッセージに端末名・種類（デスクトップ / iPhone / Android）・アプリの版
4. ホスト: **承認のダイアログ**「『Pixel 9』をこのホストに追加しますか？ 確認コード 482 193」。確認コードは両側でハンドシェイクのハッシュから導いた 6 桁で、端末の画面にも同じものを出す。QR が写真や画面共有で漏れても、承認する人が自分の端末の数字と見比べて止められる
5. 承認したら、ホストが `deviceId` と中継用トークンを発行し、端末一覧（`<data>/remote/devices.json`: `{ id, name, platform, publicKey, createdAt, lastSeenAt }`）に加え、中継にトークンのハッシュを登録し、チャネルの中で端末へ渡す。入場券は消す
6. 端末は `{ hostId, ホストの公開鍵, 中継の URL, deviceId, 中継用トークン, ホスト名 }` を保管庫に置き、ホスト一覧に出す

細部（実装 `core/remote/connector.mjs`・`pairing.mjs` で決めたこと）:

- IKpsk2 の psk はメッセージ 2 の最後で混ぜるので、ホストはメッセージ 1 だけでは QR を読んだ端末か分からない。端末はメッセージ 2 のあと transport で `{ type: 'pair' }` を 1 通送り、ホストはそれを復号できたときに初めて承認待ちを出す
- 結果はホストから transport の 1 通で返す: `{ type: 'approved', deviceId, token, hostName }` か `{ type: 'denied' | 'expired' }`。そのあとホストが 1000 で閉じる。transport の平文はどれも UTF-8 の JSON
- 通常の接続（IK）のメッセージ 1 の payload は JSON `{ proto: 1, name?, app? }`、メッセージ 2 は空。そのあと §4 のチャネル（最初は HELLO）
- ペアリングの入場券は、ペアリングの接続が来た時点でホストも捨てる（成否によらず 1 回きり）。承認待ちは 5 分で `expired`、端末が切れたら `cancelled`
- ホストが中継名乗りの `deviceId` の公開鍵とハンドシェイクで証明された鍵を比べ、違う・一覧に無い・ハンドシェイクの失敗はデータ用の接続を 4401 で閉じる（中継がそのまま端末へ渡す）。取り消しでは GOAWAY `revoked` のあと 4401
- `deviceId` は `d` + 12 バイトの base64url、中継用トークンは 32 バイトの base64url。`devices.json` には `tokenHash` も置く（`sync` に要る）
- 中継の URL は `https://`（`wss://`）だけ。`http://` はループバックの中継だけ（試験用。登録用の秘密を平文で流さない）
- 設定が空のときは環境変数 `AGENT_HOST_RELAY_URL`・`AGENT_HOST_RELAY_SECRET` を代わりに使う（有効にするのは設定だけ）

**取り消し**: ホストの端末一覧で「取り消す」→ 一覧から消し、中継からトークンのハッシュを消し、その端末のチャネルを即座に切る。中継が古い情報のままでも、ホストがハンドシェイクで静的鍵を弾く（二重）。
端末一覧は名前・種類・追加した日・最後に使った時刻・今つながっているかを出す。ホスト自身の窓は一覧に出さない（ローカルは今のままの一時トークン）。

### 3.4 中継が知ること・知らないこと

| 知る | 知らない |
|---|---|
| `hostId`・`deviceId`、中継用トークンと入場券の**ハッシュ** | 会話・ファイル・設定・コマンドなど中身すべて |
| 接続元の IP、時刻、接続の長さ、送った量と大きさの傾向 | ホストの UI トークン（接続口の外に出ない。§4.2） |
| どの端末がいつどのホストにつないだか | ペアリングの秘密・psk（QR の中だけ。入場券とは別の HKDF の札で導く） |

中継が乗っ取られても、中身を読むことも、ホストや端末になりすますこともできない（両側が静的鍵を照合する）。できるのは止めることと、上の付随情報を見ることだけ。

## 4. チャネルとフレーム

### 4.1 フレーム

1 つの暗号化チャネルに、HTTP の要求と WebSocket を**ストリーム**として重ねる。WebSocket の 1 メッセージ（バイナリ）= Noise の 1 通 = 1 フレーム。
Noise の 1 通は 65535 バイトまでなので、平文は 65519 バイトまで。データは 60 KiB ごとに分ける。

```
平文のフレーム:  type (u8) | stream (u32, BE) | payload
stream 0 はチャネル自体。端末が開くストリームは奇数、ホストが開くもの（今は無い）は偶数
```

| type | 名前 | 向き | payload |
|---|---|---|---|
| 0x01 | HELLO | 両方 | JSON `{ proto: 1, app, shell: 'desktop'\|'mobile' }` / `{ proto: 1, app, hostName }`。`proto` が合わなければ GOAWAY |
| 0x02 / 0x03 | PING / PONG | 両方 | 8 バイト。20 秒ごと。3 回返らなければ切る |
| 0x04 | GOAWAY | 両方 | JSON `{ code, reason }`（取り消された・版が合わない・ホストが終了） |
| 0x10 | HTTP_REQ | 端末→ | JSON `{ method, path, headers }` |
| 0x11 | HTTP_RES | →端末 | JSON `{ status, headers }` |
| 0x12 | DATA | 両方 | 本文の断片 |
| 0x13 | END | 両方 | その向きの終わり（半閉じ） |
| 0x14 | RESET | 両方 | u16 の理由。ストリームを捨てる |
| 0x20 | WS_OPEN | 端末→ | JSON `{ path, protocols }` |
| 0x21 / 0x22 | WS_ACCEPT / WS_REJECT | →端末 | 空 / u16 の HTTP 状態 |
| 0x23 | WS_MSG | 両方 | u8 の印（bit0 文字、bit1 最後の断片）+ 断片。大きいメッセージ（`loadSession` の数 MB など）は分けて送り、受け側が組み立ててから渡す |
| 0x24 | WS_CLOSE | 両方 | u16 の close code + 理由 |
| 0x30 | WINDOW | 両方 | u32 の増分。stream 0 はチャネル全体 |

細部（実装 `core/remote/frames.mjs`・`channel.mjs` で決めたこと）:

- 最初のフレームは HELLO でなければならない。形の誤り（知らない型・HELLO / PING / PONG / GOAWAY が stream 0 以外・それ以外が stream 0・開いていないストリーム・番号の逆行・窓超え・増分 0・ストリームの種類に合わないフレーム）は GOAWAY `protocol` で閉じる。復号の失敗は何も送らずに閉じる
- GOAWAY の `code` は文字列（`protocol`・`version`・`revoked`・`shutdown` など）。GOAWAY は送っても受けてもチャネルの終わりで、処理中のストリームは捨てる
- RESET の理由: 0 取り消し、1 決まり違反、2 受け付けない（同時ストリームの上限・受ける者が居ない）、3 防火壁が通さない（§4.2）、4 受け側の失敗、5 窓超え、6 チャネルが閉じた（ローカルだけ）、7 組み立てた WebSocket のメッセージが上限（64 MiB）を超えた
- WebSocket のストリームは両方が WS_CLOSE を送れば終わる（受けた側が自分の WS_CLOSE を返す）。WS_REJECT は両方向の終わり
- 捨てたストリームに行き違いで届いた DATA / WS_MSG は読み捨て、チャネルの窓だけ返す

### 4.2 ホストの接続口が通すもの（ここが防火壁）

接続口は復号したストリームを `127.0.0.1:<PORT>` への HTTP / WebSocket に組み立て直す。そのとき:

- **`/mcp/` で始まるパスは通さない**（`/mcp/agents` `core/agent-bridge.mjs:3`、`/mcp/context` `core/context-bridge.mjs:8`。エージェント CLI 用の内部口）。RESET で返す
- HTTP は **GET と HEAD だけ**（今のサーバーの HTTP は読み取りだけで、状態の変更はすべて `/ws` のコマンド）。WebSocket は `/ws` だけ
- 端末から来た `Cookie`・`Authorization`・`?token=`・`Host`・`Origin`・hop-by-hop のヘッダーを捨て、**ホストの UI トークンを接続口が付ける**（HTTP は Cookie、`/ws` は `?token=`）。接続口はサーバーと同じプロセスにいるので `TOKEN` と実際のポートを知っている
- 応答の `Set-Cookie`（`agent_host_token`。`core/server.mjs` の静的配信）を捨てる。**ホストの UI トークンは端末に届かない**
- 既存サーバーのコード（トークン照合・静的配信・`/ws`）は変えない。変えるのは起動時に接続口を立てる数行だけ

実装（`core/remote/forward.mjs`）では、端末のヘッダーは決まったものだけを通す（`accept`・`accept-language`・`accept-encoding`・`cache-control`・`pragma`・`if-none-match`・`if-modified-since`・`if-range`・`range`・`user-agent`）。パスは WHATWG の URL で読み直し、`/mcp` の判定は小文字にしたものと復号したものの両方で行い、判定した形のまま送る。通さないもの（`/mcp`・GET/HEAD 以外・`/ws` 以外の WebSocket）はどれも RESET 3。

将来、端末ごとの記録や権限を持たせるときは、接続口が `X-Pleiad-Device` を付ける余地がある（今は付けない）。

### 4.3 流量の制御と背圧

- HTTP/2 と同じ考えのクレジット方式。ストリームの初期窓 256 KiB、チャネル全体 1 MiB。DATA と WS_MSG の payload の分だけ減らし、窓が 0 のストリームは待つ。制御フレームは数えない
- 受け側は**下流に渡し終えてから** WINDOW を返す。HTTP はローカルのソケットへの `write()` が true を返したとき（または `drain`）、WebSocket は `ws.bufferedAmount` が 64 KiB を下回ったとき
- 送り側は中継への WebSocket の `bufferedAmount` が 4 MiB を超えたら全ストリームを止める
- これで中継に溜まるのは向きごとに最大 1 MiB 程度に抑えられる。中継はさらに相手側の `bufferedAmount` が上限（8 MiB）を超えた接続を切る
- 同時ストリームは 64 まで（ブラウザーは 1 オリジンに HTTP/1.1 を 6 本までしか張らないので、実際はそれより少ない）
- 窓の初期値は取り決めの定数で、交渉しない（HELLO にも載せない）。WS_MSG は印の 1 バイトも数える
- WS_MSG の途中の断片は、組み立ての入れ物に入れた時点で窓を返す（メッセージが窓より大きいと詰まるため）。下流を待って返すのは最後の断片の分
- `bufferedAmount` で止めるのはストリームのフレーム（HTTP_RES・END なども順序を保つため一緒に止まる）。チャネルの制御フレーム（PING・WINDOW・GOAWAY）は止めない

今のサーバーは `ws.bufferedAmount` を見ずに送る（`sendTo()` `core/server.mjs:586`）が、相手はループバックの接続口なので速く読み出され、背圧は接続口のところで効く。

### 4.4 再接続

- **ストリームは持ち越さない。** チャネルが切れたら、端末内プロキシは処理中の HTTP に 502 を返し、ローカルの WebSocket を 1006 で閉じる
- 画面は既に 1.5 秒ごとに再接続し（`web/client.mjs` の `connect`）、`ready` のあと一覧と開いている会話を読み直し、送信は `messageId` と受領控えで二重にならない。**再開の仕組みはアプリの層に既にあるので、トンネルに作らない**
- 端末内プロキシはホストの窓を開いた時点（`open()`）でチャネルを張り、開いている間は切れても張り直す。失敗したら 0.5 秒から 30 秒まで倍々（±25% の揺らぎ。10 秒つながり続けたら初めから）。取り消し（4401・GOAWAY `revoked`）では張り直さない
- 張り直しを待っている間の要求は待たせずに断る（画面の読み込みは §7.4 の案内、ほかの HTTP と `/ws` は 502）。つないでいる最中に来た要求は結果を最大 10 秒待つ
- ホストの接続口は中継への制御用の接続を常に張り、切れたら 1 秒から 60 秒まで倍々で張り直し、つながるたびに端末一覧（ハッシュ）を送り直す（§5.2）
- 中継は両側に 30 秒ごとに WebSocket の ping を送り、返らない接続を捨てる（NAT の半開きの検出。Traefik の無通信切断も防ぐ）

## 5. 中継サーバー（#12）

### 5.1 口

| 口 | 認証 | 内容 |
|---|---|---|
| `GET /healthz` | なし | `200 ok`。Coolify の health check |
| `WS /v1/host` | `Authorization: Bearer <RELAY_ENROLL_SECRET>`、`X-Pleiad-Host: <hostId>` | ホストの制御用の接続。JSON の制御メッセージだけ（中身は通らない） |
| `WS /v1/host/accept?conn=<id>` | 同上 | 端末 1 本ごとにホストが張るデータ用の接続。中継が端末の接続とつなぐ |
| `WS /v1/device` | `Authorization: Bearer <中継用トークン>`、`X-Pleiad-Host`、`X-Pleiad-Device`。ペアリングは `X-Pleiad-Pairing: <入場券>` | 端末の接続。照合が通れば、ホストが accept を張るまで最大 10 秒待つ |

端末もホストもアプリ内のネイティブの WebSocket（Node の `ws`・URLSession・OkHttp）なので、ヘッダーで認証できる（URL に秘密を載せない）。

制御メッセージ: ホスト→中継 `sync { devices: [{ id, tokenHash }] }`・`allow`・`revoke { id }`・`pairing { ticketHash, ttlMs }`、中継→ホスト `incoming { conn, deviceId | pairing: true }`・`closed { conn }`。

細部（実装 `relay/server.mjs` で決めたこと）:

- 制御メッセージは文字の WebSocket メッセージ 1 通に JSON 1 つ、種類は `type`（例 `{ "type": "sync", "devices": [...] }`）。形が違えば 4400 で閉じ、知らない `type` は無視する
- `allow { id, tokenHash }` は 1 台を足す（同じ `id` ならトークンの差し替え。古いトークンの接続は切る）。`pairing` の入場券はホストごとに 1 枚で、新しいものが置き換える。`pairing { ticketHash: null }` で取り下げ。`ttlMs` が無ければ `RELAY_PAIRING_TTL_MS`
- 中継用トークンと入場券は、ヘッダーでは 32 バイトの base64url（パディングなし 43 字）。`tokenHash`・`ticketHash` は生の 32 バイトの SHA-256 の 16 進（小文字 64 字）。`hostId` は大文字小文字を区別しない
- `sync`・`revoke` で表から消えた端末、トークンが変わった端末の、つながり中の接続は 4401 で切る。ペアリングの接続は切らない（その中でトークンを渡すため）
- 制御用の接続が切れたら照合の表を捨て、accept 待ちの接続は 4404 で閉じる。つながり中のデータ用の接続はそのまま流す（張り直しの `sync` に無い端末はそこで切れる）。制御用の接続をつないでから最初の `sync` までは、端末に 4404 を返す（空の表で正しい端末を 4401 にしない）
- accept の前に端末が送った分は溜めて、accept が来たら順に渡す（溜める量も `RELAY_MAX_BUFFER_BYTES` まで）
- 片側が閉じたら、もう片側も同じ close code で閉じる（1000 と 3000–4999 以外は 1001）。ホストには `closed { conn }` を送る

| close code | 意味 |
|---|---|
| 4400 | ヘッダー・制御メッセージの形が違う |
| 4401 | 登録用の秘密・トークン・入場券が合わない、取り消された |
| 4404 | ホストが居ない（`sync` 前を含む）、accept の `conn` が無い・別のホストのもの |
| 4408 | accept が 10 秒来ない |
| 4409 | 同じ `hostId` の新しい制御用の接続に置き換わった |
| 4413 | 相手側に溜まる量が上限を超えた |
| 4429 | 数の上限、ペアリングの試行の上限 |
| 1009 | `RELAY_MAX_FRAME_BYTES` を超えるメッセージ |

### 5.2 状態を持たない

中継はディスクに何も書かない。照合の表（`hostId → { devices: tokenHash[], pairing }`）はメモリだけで、ホストが接続のたびに `sync` で送り直す。
中継を再起動しても、ホストが張り直した時点で元に戻る。ボリュームもデータベースも要らない。同じ `hostId` で 2 本目の制御接続が来たら古い方を閉じる（登録用の秘密を持つ者だけができる）。

### 5.3 踏み台にされないための制限

- **行き先は固定。** 中継がつなぐのは「端末 ⇄ その端末を登録したホスト」だけで、任意の宛先へは出られない。開いたプロキシにはなりようがない
- ホストの登録は `RELAY_ENROLL_SECRET` を持つ者だけ。端末はホストが登録したトークンのハッシュに一致するものだけ
- 大きさ: `maxPayload` 66,000 バイト（Noise の 1 通 + 余白）。これを超える WebSocket メッセージは即切断
- 数: ホスト数・ホストあたりの端末数・ホストあたり / 端末あたりの同時接続数に上限（§5.5）
- 時間: 認証済みでも accept が 10 秒来なければ切る。ping に 2 回応えなければ切る
- 認証の失敗は IP ごとに数え（Coolify の前段の後ろなので `X-Forwarded-For` の先頭を使う）、1 分に 10 回で 10 分止める（止めている間はどの口も Upgrade せずに HTTP 429。`/healthz` は止めない）。入場券は 1 回使えば消え、ペアリングの試行はホストごとに 1 分 5 回まで（入場券が合っていても 6 回目は 4429）
- ホストあたりの端末数を超えた `sync`・`allow` の分は登録しない（ログに残す。その端末は 4401）
- ログは接続の付随情報（`hostId` の先頭 8 字・`deviceId`・量・長さ・閉じた理由）だけ。中身は記録しようがない

### 5.4 Coolify への配置

`relay/Dockerfile`:

```dockerfile
FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server.mjs ./
USER node
ENV PORT=8080
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
CMD ["node", "server.mjs"]
```

Coolify の設定: 新しいリソース → GitHub のリポジトリ → Build Pack「Dockerfile」、Base Directory `/relay`、Ports Exposes `8080`、Domains `https://relay.<自分のドメイン>`（Traefik が証明書を取り HTTPS を終端し、WebSocket の Upgrade もそのまま通す）、Health Check のパス `/healthz`。
永続ストレージは付けない。レプリカは 1（状態がメモリにあるため。落ちてもホストが張り直す）。

| 環境変数 | 既定 | 意味 |
|---|---|---|
| `PORT` | `8080` | 待ち受け。Coolify の前段からだけ届く |
| `RELAY_ENROLL_SECRET` | （必須。無いか 32 字未満なら起動しない） | ホストの登録用の秘密。32 バイト以上の乱数 |
| `RELAY_TRUST_PROXY` | `1` | `X-Forwarded-For` を信じる（前段の後ろで動かすため） |
| `RELAY_MAX_HOSTS` | `8` | 同時に登録できるホスト数 |
| `RELAY_MAX_DEVICES` | `16` | ホストあたりの端末数 |
| `RELAY_MAX_CONNS_PER_HOST` / `_PER_DEVICE` | `32` / `4` | 同時接続数 |
| `RELAY_MAX_FRAME_BYTES` | `66000` | WebSocket の 1 メッセージの上限 |
| `RELAY_MAX_BUFFER_BYTES` | `8388608` | 相手側に溜まってよい量。超えたら切る |
| `RELAY_PAIRING_TTL_MS` | `300000` | 入場券の寿命の上限（ホストの指定はこれで頭打ち） |
| `RELAY_LOG` | `info` | `debug` でも中身は出ない |

中継は 1 人（ホストの持ち主）の持ち物として動かす。登録用の秘密を他人と共有すると、その人のホストも同じ中継に載る（中身は読めないが、帯域と上限を分け合う）。

### 5.5 試験

`tests/unit/relay.mjs`（`npm test` から回す。LLM は使わない）: 登録用の秘密なし・違うトークン・取り消し済みでつながらない、入場券の 1 回きり・失効、ホストが居ないときの閉じ方（4404）、上限を超えるメッセージで切れる、背圧の上限で切れる、ホストの張り直しと `sync` で照合が戻る、2 本目の制御接続で古い方が閉じる。暗号は中継の外なので、試験はバイト列が変わらずに届くことだけを見る。

## 6. ホスト側（#13）

### 6.1 設定 › リモート

- 「このホストをリモートから使えるようにする」のスイッチ、中継の URL、登録用の秘密（伏せ字。保存後は表示しない）。状態の一行（「中継につながっています」「中継につながりません · 理由」）
- 「端末を追加」→ QR と残り時間とコードのコピー（§3.3）。承認のダイアログはどの画面にいても出る（承認待ちと同じく差し色の「あなたを待っている」）
- 端末一覧と「取り消す」（その場の確認）
- ホストとして常駐する設定（§6.3）
- 画面は既存の管理の面（`.mp-panel` など）を使う。設定の状態はサーバー側（WS コマンド）に置くので、リモートの窓からも見える・触れる（全権限のため）

QR の画像は `web/vendor/qrcode-generator.mjs`（kazuhikoarase/qrcode-generator 2.0.4、MIT。取得元と版はファイルの頭）を同梱して SVG に描く（誤り訂正 M、余白 4 マス、明暗テーマによらず白地 `--surface-qr` に濃い点 `--ink-qr`）。

画面（`web/remote.mjs`、2026-09-23）: 設定のメニューに「リモート」。上からスイッチと状態の一行（困っているときだけ強い字）、「中継」の面（URL・登録用の秘密は伏せ字で保存後は「保存済み（変えるときだけ入力）」・ホスト名・「保存」。環境変数を使っているときと暗号化できない起動のときだけ 1 行）、「端末」の面（一覧・「＋ 端末を追加」・ペアリングの面）、ログインはホストの PC での一文、「常駐」の面（デスクトップ版のホストだけ）。スイッチを入れるときは、入力したまま保存していない中継の欄も一緒に送る。
承認のダイアログは `<dialog>` のモーダルで、`remotePairing` の request（と開いたときの `remoteStatus` の承認待ち）で出す。既定の居場所は「拒否」、Esc では閉じない。承認待ちが消えたら（切れた・期限・ほかの画面で決めた）閉じて、端末の面の下に一言を残す。

WS コマンド（`core/protocol.mjs`）: `remoteStatus`・`setRemoteSettings { enabled?, relayUrl?, enrollSecret?, hostName? }`・`remotePairingStart`（QR の文字列を返す）・`remotePairingCancel`・`remotePairingApprove { id }`・`remotePairingDeny { id }`・`remoteDevices`・`remoteRevoke { id }`。イベントは `remoteStatus { status }`（状態の丸ごと）と `remotePairing { phase, request?, device? }`。登録用の秘密・トークン・鍵は返さない。設定は `<data>/remote/settings.json`（秘密は `secrets.json`）。既定は無効で、有効にするまで鍵も作らない。

### 6.2 画面が離れたとき（#11 を参照）

全端末が切れて 60 秒たつとターンを止める打ち切り（`HOST_GRACE_MS` `core/server.mjs:543`）は、#11 で**既定を無効**（待ち続ける。`AGENT_HOST_GRACE_MS` を指定したときだけ効く）にする。
新しい接続への `ready` が全端末に配られる不具合（`wss.on("connection")` の `sendTo({ kind: P.READY … })`）も #11 で直す。スマホの再接続のたびにホストの画面が読み直されるのを防ぐため、リモートの前提になる。

### 6.3 ホストとして常駐する（推奨）

今のデスクトップ版は窓を閉じると（作業が 0 件なら）アプリごと終了する（`desktop/main.cjs` の `closeSafely`）。リモートの端末はホストが動いていないとつながらない。

- **推奨: リモートを有効にしたら「窓を閉じてもホストを続ける」を既定でオン**にし、トレイ（macOS はメニューバー）に残す。トレイのメニュー: 状態（中継 · 接続中の端末 N · 実行中 N）、「Pleiad を開く」、「終了」（実行中なら今と同じ確認）
- スリープ: 「作業中だけ防ぐ（既定）/ リモートが有効な間は防ぐ / 防がない」。作業中 = ターンが走っているか承認待ちがあるとき、`powerSaveBlocker.start('prevent-app-suspension')`。画面は消えてよい。常に防ぐのは電気代と熱の問題があるので選択にする
- ログイン時の自動起動は任意（`app.setLoginItemSettings`）。既定はオフ（まだ作っていない）

実装（2026-09-23）: 設定は `<data>/remote/resident.json` の `{ keepRunning, sleep }`（`core/remote/resident.mjs`。既定 `true` / `'working'`）。WS コマンド `setRemoteResident { keepRunning?, sleep? }`、`RemoteStatus.resident = { available, keepRunning, sleep }`（`available` はデスクトップ版のホストのとき）。
サーバーはリモートの状態か実行中の作業（`broadcastRunning`）が変わるたびに、parentPort で `{ type: 'resident', state: { remote, keepRunning, sleep, working, running, waiting, devices, relay, locale } }` を送る（同じ内容は送らない）。作業中 = `runningWork().count > 0`。
main は `desktop/resident.cjs`: トレイ（Windows・Linux は押すと窓を出す）、窓の close は `keepOnClose()` なら隠すだけ、リモートを無効にしてトレイが消えるとき窓が隠れていれば出し直す、「終了」は窓を出してから `closeSafely`。トレイの文言は `web/locales/<言語>/desktop.json`。
- `npm start` のホストは窓が無いので、そのまま常駐と同じ。スリープ対策は OS の設定に任せる
- 理由: 常駐しないと、リモートの価値（外出先から続きを見る）がほぼ成り立たない。一方で勝手にスリープを止めるのは不意打ちなので、既定は「作業中だけ」

## 7. デスクトップ版の端末（#14）

### 7.1 窓と保存領域

- **ホストごとに別の窓。** ローカルの窓とは混ぜない。同じホストを 2 度開いたら既存の窓を前に出す
- ホストごとに `session.fromPartition('persist:remote-<hostId>')`。Cookie はポートで分かれない（`127.0.0.1` 単位）ので、分けないとローカルの窓の `agent_host_token` と混ざる。localStorage（テーマ・開いていた会話など）もホストごとに分かれる。既読（完了の確認）はホスト側に持つので、どの窓・端末でも同じ（docs/design.md「完了・未確認」）
- 端末内プロキシは main プロセスで、ホストごとに `127.0.0.1` の空きポートで待ち受ける。ポートはホストごとに覚えて再利用する（localStorage はオリジン = ポート単位のため。ローカルの `desktop/server-port.cjs` と同じ理由）
- プロキシは起動ごとの乱数トークンを持ち、窓は `http://127.0.0.1:<p>/?token=<それ>` を開く。**プロキシの認証は今のサーバーと同じ形**（`?token=` か HttpOnly・SameSite=Strict の Cookie、`/ws` は `?token=`）なので、`web/` は変えずに済む。加えて `Host` が `127.0.0.1:<p>` 以外なら 403（DNS rebinding 対策）
- 同じ PC の別プロセスもループバックには届くが、トークンが無ければ 401。同じ利用者の悪意あるプロセスは対象外（その時点で保管庫も読める）

細部（実装 `core/remote/device*.mjs` で決めたこと）:

- プロキシの Cookie の名前は `pleiad_remote_token`（ローカルの `agent_host_token` と別。`?token=` が合った応答に付ける）。`?token=` と Cookie はホストへ送らない。HTTP は GET と HEAD だけで、ほかは 405（ホストの接続口に届く前に断る）。防火壁の RESET 3 は 403
- 端末の置き場（デスクトップは userData の下）: `secrets.json`（`core/secret-store.mjs`。端末の静的鍵 `deviceKey` と、ホストごとの中継用トークン `host:<hostId>`）、`hosts.json`（`{ hostId, hostName, label, relayUrl, hostPublicKey, deviceId, port, pairedAt, lastConnectedAt, revokedAt }`。秘密は入れない）。端末の静的鍵は 1 つで、すべてのホストに使う
- Electron の main は safeStorage を直接使える（`desktop/secret-bridge.cjs` の `safeStorageCipher`）。暗号化できない環境ではホストと同じく 0600 の平文

### 7.2 リモートの印（3 箇所。消せない）

1. **窓の上端のバッジ**: 帯の左（脇の列の上）に `⇄ リモート: desktop-home`（差しの青 `--ink-blue` の字、面は付けない）。常に出し、閉じるボタンは無い。押すとホストの接続情報（中継・つないだ時刻・「この窓を閉じる」）の小さな面。
   701px 以上の窓では会話のタイトル行（タイトル・✦・コンテキスト）を帯の右（会話の列の上）に上げ、帯とタイトル行を 1 本にする（2026-09-23、承認済みの「H1・塗りなし」）
2. **帯の色**: ~~リモートの窓は帯を `--fill-primary`~~（2026-09-23 にやめた。利用者の決定）。帯はローカルと同じ `--surface-0`（点のグリッド）で、脇を閉じても・プレビューを並べても変えない。
   窓のボタンの地と記号は、既存の `paintTitleBar`（`web/client.mjs`）が `.titlebar` の `--bar-end` と `--ink` を読んで `setTitleBar` で送る。画面が送るまでの一瞬は `desktop/remote-windows.cjs` の `REMOTE_BAR`（ローカルと同じ脇の面の色）。
   見分けは、差しの青のバッジ（1）と、OS の窓タイトル・タスクバーの重ねアイコン（3）で行う。塗りの例外（design-system §2.3）は無くなった
3. **OS の窓タイトルとタスクバー**: `Pleiad — リモート: desktop-home`（`page-title-updated` を止めて main が付ける）。Windows はタスクバーのボタンに `setOverlayIcon`（⇄ の小さな印、説明「リモート」）。macOS はタイトルと Dock メニューの窓の名前で見分ける

画面は preload から「リモートの窓であること」とホスト名を受け取って描く:

```js
// desktop/preload.cjs（リモートの窓）
window.plyRemote = { hostId, hostName, shell: 'desktop' }       // 画面は有無で html に .remote を付ける
window.plyDesktop = { platform, setTitleBar, notifyCompletion, onNotificationClick }  // chooseFolder・update は出さない
```

### 7.3 同じ PC を前提にした箇所の扱い

| 箇所 | 今 | リモートの窓では |
|---|---|---|
| フォルダー選択 `plyDesktop.chooseFolder`（`web/composer-controls.mjs:207`、`web/context.mjs:245,457`） | OS のダイアログで**手元の**パスを返す | preload で出さない。画面は既にブリッジの有無で分けているので、ブラウザー版と同じ `listDirs` の簡易ブラウザー（ホストのフォルダー）になる。コンテキストの「フォルダーを選ぶ…」は出ず、パスの入力と候補だけ |
| Claude のアカウントの認可（`web/claude-accounts.mjs:42` の `desktop()`） | デスクトップ版ならサーバーがホストの画面でブラウザーを開く | `desktop()` を「`plyDesktop` があり `plyRemote` が無い」に変える。端末側でリンクを開き、コードを貼り戻す（今のブラウザー版と同じ。戻り先がループバックではないのでリモートでも完了できる） |
| Claude CLI の `auth login`（`core/auth/claude-cli.mjs`）、Codex の ChatGPT ログイン（`core/backends/codex.mjs:1511`）、外部 MCP の OAuth（戻り先がホストの `127.0.0.1`。`core/mcp-oauth.mjs:12,64,185`）、Antigravity のログイン（`core/backends/index.mjs:120`） | 戻り先がホストのループバック・端末でしか受け取れない | **ホストの PC で済ませる。** リモートの窓（とモバイル）ではログインの操作の代わりに「このログインはホストの PC で行ってください。」の一文を出す（`plyRemote` の有無で分ける）。状態の表示（ログイン済み・未ログイン）はそのまま見える |
| アプリの更新 `plyDesktop.update`（`web/updates.mjs:3`） | 手元のアプリの更新 | 出さない（手元のアプリの更新はローカルの窓で）。「アプリ情報・更新」はホストの版（`ready.version`）を出し、「ホストの Pleiad の更新はホストで行います」 |
| 完了通知 `plyDesktop.notifyCompletion`（`web/notifications.mjs:20`） | 手元の OS 通知 | そのまま使う。本文の頭にホスト名。押すとそのリモートの窓の会話を開く |
| 窓の枠 `web/index.html:20`（`desktop` の class） | `plyDesktop` の有無 | そのまま（リモートの窓も同じ枠）。`plyRemote` があれば `remote` の class も |
| `desktop/main.cjs:17` の `trusted()`・遷移（`:115`）・権限（`:121`）・帯の色（`:190`） | 窓 1 枚・オリジン 1 つの変数 | 窓ごとのオリジンの表に変える。IPC は送り元の窓のオリジンと照合する。リモートの窓からの `ply:choose-folder`・`ply:update` は拒否 |
| 窓を閉じるときの確認（`desktop/main.cjs` の `closeSafely`） | ローカルのサーバーに実行中を聞き、アプリを終える | リモートの窓を閉じても何も止めない（ホストは #11 で待ち続ける）。確認も出さない。アプリの終了はローカルの窓の規則のまま |
| エクスプローラーで表示・ブラウザーで開く（`hostCapabilities` の `osActions`、`core/os-open.mjs` の `isLocalRequest`） | ループバックからの接続なら許す | ホストの接続口がホストのサーバーへ張る `/ws` に `X-Forwarded-For` を付け（`core/remote/forward.mjs`）、ホストから見て「サーバーのある PC の画面」ではなくする。画面も `plyRemote` があれば出さない |
| `ws://` 固定（`web/client.mjs:3140`）・`crypto.randomUUID()`（`:3123`） | 平文の非ループバックで壊れる | ループバックなので壊れない（直さなくてよい。モバイルの保険は §8.3） |
| 1 ファイルの添付（上限 100MB） | 中身を 512 KiB の断片で送る（`attachStart` / `attachChunk` / `attachFinish`。フォルダーを送る口と同じ `core/folder-uploads.mjs`）。1 通で丸ごと送る `attachFile`（8MB まで）は古い画面のために残す | そのまま（1 通が 64 MiB の上限・端末内プロキシの溜めを超えない） |
| ファイルのダウンロード（`/local-file?download=1`） | ブラウザーの保存 | そのまま（Electron の保存ダイアログ）。取り出しはこれで足りる |

### 7.4 ホストへのつなぎ方

- **「ほかのホストにつなぐ」はアプリに同梱の小さな窓**（`desktop/remote-hosts.html`。file: で開き、どのホストからも配らない。2026-09-23 に設定 › リモートの下半分から変更）: ペアリングしたホストの一覧（名前・オンラインかどうか・最後につないだ時刻、「開く」「名前を変える」「削除」）と「ホストを追加」（ペアリングのコードを貼る → 「ホストの画面で承認してください · 確認コード 482 193」と「やめる」）。資格情報を暗号化できない起動では末尾に一文
  - 理由: 手元のアプリの機能で、ペアリングと窓を開く口は HTTP のオリジンを持つ画面（ローカルのサーバーが配る `web/` も含む）に渡さない方が狭く守れる。ホストの版と画面の版がずれても関係ない。ホスト側の 設定 › リモート（#13）と同じ画面を取り合わない
  - 入口: ローカルの窓の preload にだけ `plyDesktop.openRemoteHosts()`（設定 › リモートの「ほかのホストにつなぐ…」から呼ぶ。リモートの窓には出さない）、Windows のジャンプリスト（`--remote-hosts` で起動 → 2 つ目の起動として受ける）、macOS の Dock のメニュー
  - 窓の操作は `plyHosts`（`init / list / pair / cancelPair / open / rename / remove / onCode / onChange`）。送り元はその窓の本体フレームで、同梱のファイルであることを `desktop/window-trust.cjs` で確かめる
- リモートの窓の状態: 画面のバッジが `plyRemote.status()` と `onStatus` で状態を受け、つながっていない間は「リモート: desktop-home · ホストがオフライン」と添え、面に「再試行」（`plyRemote.retry()` = 待ちを飛ばして張り直す）。取り消されたら本体が窓を読み直し、下のプロキシの案内（取り消されました）を出す。読み込みそのものが失敗しているとき（最初の表示・読み直し）はプロキシの案内のページが 5 秒ごとに読み直してつなぎ次第画面に移る
- ホストがオフライン・取り消し済みなどで最初の読み込みができないときは、プロキシが小さな案内のページを返す（「ホストにつながりません。ホストの Pleiad が起動しているか確かめてください。」「この端末はホストで取り消されました。もう一度ペアリングしてください。」）。中継の close code で分ける: 4401 取り消し・認証失敗、4404 ホストが居ない、それ以外は通信の失敗。
  状態は `connecting`・`connected`・`offline`（中継につながらない）・`host-offline`（4404・4408・ホストの GOAWAY `shutdown`）・`revoked`（4401・GOAWAY `revoked`・ホストの鍵が合わない）。案内のページは 503 で、取り消し以外は 5 秒ごとに読み直してつながり次第画面に移る

## 8. 手元のフォルダーを送る（#15）とモバイル版（#16）

### 8.1 手元から送る

- 手元のファイルを渡すのは添付と同じ種類の操作なので、**入口は添付（クリップ）のボタン**（2026-09-23 に作業フォルダーの面のタブから移した）。作業フォルダーの面（入力欄のチップ）はホストのフォルダーだけを扱う
- **添付の出どころ**（2026-09-23）: 出どころを選べる接続では、クリップで見出しを分けたメニューを開く。「**この端末から**」: ファイル…（デスクトップ版のリモートの窓だけ、フォルダーを送る… も）。「**ホストから** <ホスト名>」: ファイルを選ぶ… → 同じ面がホストのファイルの一覧（場所のパンくず・このフォルダーでの絞り込み・フォルダーとファイル・✓ で複数選択・「添付する（n）」）に替わり、ホストのパスのまま添付に積む（送らない。ファイルプレビューの「会話で使う」と同じ）。一覧はサーバーの `listDirs` の `{ files: true }`（名前・大きさ・更新時刻。パスの検めはフォルダーだけのときと同じ）。添付の札には出どころのアイコン（⇄ ホスト / 端末）
  - 選べる接続: デスクトップ版のリモートの窓・モバイル版の殻（`plyRemote`）と、ホストの画面ではないブラウザー（`hostCapabilities` の `osActions === false`。LAN などで別の PC から直接開いたもの）。ホストの PC の窓・ホストで開いたブラウザーではホスト＝この端末なので選ばせず、クリップはすぐファイルを選ぶ（`web/composer-layout.mjs` の `attachSources`）
  - 添付の件数の上限は無い（2026-09-23 に 20 件の上限を外した）。1 件は 100MB まで（断片で送る。§7.3 の表）
- 「フォルダーを送る…」: 手元の OS のフォルダーのダイアログ（`<input type="file" webkitdirectory>`。ブラウザーの機能で読むので同じ PC のブリッジは要らない）を出し、同じ面が下の送る流れに替わる。送っている途中にクリップを押すとメニューではなく進み具合を出す
- 選んだら送る前に: フォルダー名、**ファイル数と合計の大きさ**、除外（札。既定 `.git`・`node_modules`。× で外す、打って足す。変えると数と大きさを数え直す）、送り先（combo。既定はホストの `~/Pleiad/uploads/<フォルダー名>`、あれば `-2` を付けた新しいフォルダー。ホストの最近の作業フォルダーも候補）
- 送り先が既にあるフォルダーなら、送る前にその場の確認「`D:\work\site` には既にファイルがあります。同じ名前の 12 件を上書きします。」（上書きしない名前の一覧は折りたたみ）
- 「送る」（塗り）→ 進み具合: バー、`1,204 / 3,410 件 · 48.2 / 131 MB`、今のファイル名、「中断」。切れたら「接続が切れました。つながり次第、続きから送ります。」で止まり、再接続で自動で続ける。窓を閉じても、もう一度同じフォルダーを選べば続きから
- 送る前の面にチェックボックス「**送ったフォルダーを作業フォルダーにする**」（既定で入）
- 終わったら「送りました · 3,410 件」。入なら送り先が**その会話の作業フォルダー**になる（未送信の会話はその場で、送信済みの会話は「次のターンから適用」に入る。既存の `nextSettings.cwd`）。切ってあれば作業フォルダーは変えず、会話に「フォルダーをホストの <パス> に送りました。」と一行で知らせる
- 大きすぎるとき（2 万件超 または 2 GB 超）は送る前に一文で知らせ、除外を見直してもらう（送ることは止めない）
- **リモートの窓にフォルダーをドロップ**したら、その場に「添付する / 作業フォルダーとして送る」を聞く小さな面。「作業フォルダーとして送る」はクリップの面を送る流れで開く（チェックボックスは入）。ファイルだけのドロップは今までどおり添付（1 件 100MB まで）

サーバー側（新しい WS コマンド。ローカルの画面から使ってもよい、リモート専用ではない一般の口）:

| コマンド | 内容 |
|---|---|
| `uploadStart { name, dest?, files: [{ path, size, mtime }], overwrite }` | 送り先を決め（既定の置き場 `~/Pleiad/uploads/`）、`uploadId` と受け取り済みの位置（続きから送るため）を返す。同じ `name`・`files` の未完了があればそれを返す |
| `uploadChunk { uploadId, file, offset, data }` | base64 の 512 KiB。置き場の中の `.partial/<uploadId>/` に書き、`manifest.json` に受け取った位置を残す。画面は同時に 4 つまで投げる（応答が背圧になる） |
| `uploadFinish { uploadId }` | 大きさを確かめ、送り先へ移す（新しいフォルダーは rename 一回）。送り先のパスを返す |
| `uploadCancel { uploadId }` | 途中のものを捨てる。7 日たった `.partial` は起動時に掃除 |

パスは信用しない: 相対パスだけ、`..`・絶対パス・ドライブ名・Windows の予約名を拒否、区切り文字を揃え、送り先の外に出ないことを確かめる。シンボリックリンクは送らない（`webkitdirectory` は実体のファイルだけを返す）。

実装（`core/folder-uploads.mjs`・`web/folder-upload.mjs`、2026-09-23）で決めたこと:

- **下見の口 `uploadCheck { name, dest?, paths }`** を足した（送る前に「新しいフォルダーを作ります」/ 上書きの確認を出すため）。`{ dest, root, exists, inRoot, empty, conflicts, sample（先頭 20 件）, needsConfirm }`
- 置き場の既定は `~/Pleiad/uploads`（`AGENT_HOST_FOLDER_UPLOADS` で変えられる。試験はこれで使い捨ての場所へ）。途中のものは `<置き場>/.partial/<uploadId>/{manifest.json, tree/<相対パス>}`。`uploadId` は `name` と `files`（パス・大きさ・更新時刻）のハッシュなので、同じフォルダーを選び直せば同じ途中のものに当たる
- **受け取った位置は `tree` に置いたファイルの大きさそのもの**（断片は先頭から順に、位置を指定して書く。抜けのある断片は書かずに今の位置を返す）。`manifest.json` の位置は写しで、30 秒ごとに間引いて書く。サーバーを起動し直しても `uploadStart` を呼べば続きから
- 送り先の規則: 置き場の中なら新しいフォルダーを作ってよい。置き場の外は**既にあるフォルダーだけ**で、空でも確認（`needsConfirm`）を経る。空でない既存のフォルダーは置き場の中でも確認。置き場そのもの・`.partial`・ドライブの根・ファイルは送り先にできない。`~` はホストのホーム。送り先と置き場はどちらも実体（realpath）で比べるので、置き場の中のリンクが外を指せば外として扱う
- 既存のフォルダーへ移すときは、ファイルごとに親フォルダーの実体が送り先の中にあることを確かめる（中のジャンクション・シンボリックリンクを辿って外へ書かない）。同じ名前のフォルダーがあれば断る。新しいフォルダーは `tree` を rename 一回（別のドライブなどで失敗したらファイルごとに移す）
- 上限: 10 万件・合計 32 GiB・1 ファイル 16 GiB・相対パス 1024 字。空き容量（`fs.statfs`）が残りの分 + 64 MiB に足りなければ断る。大文字小文字だけが違う名前、ファイルとフォルダーが同じ名前になる組は断る（Windows・macOS で重なる）。途中のものは 20 個まで（超えたら古いものから捨てる）
- 断片は 512 KiB を約束し、受け側は倍まで受ける。同じ途中のものへの操作は順に行う（4 つ投げても同じファイルの断片が行き違わない）
- 画面: 手元のフォルダーは `<input type="file" webkitdirectory>` とドロップの `webkitGetAsEntry()`。どちらもブラウザー（Electron の描画側）の機能なので、ホストが配るページに同じ PC の口を足さない（`showDirectoryPicker` も動くが、権限の扱いが増えるわりに File が読めれば足りるので使わない）。除外は名前（`*`・`?` 可）でどの階層にも当たり、`/` を含めば先頭からのパス。切れたら「接続が切れました」で止め、`ready` で `uploadStart` から続ける。送り終えた先は、「作業フォルダーにする」が入なら送り始めたときの会話の作業フォルダーにする（開いている会話が変わっていれば、その会話へ `setTurnSettings` の `cwd`）
- 流量: 端末内プロキシ → 中継 → ホストで 50 MiB・2000 件を 4 つ投げて約 3 秒（16 MiB/s 前後。同じ PC の中継、base64 と JSON を含む）。中継は接続を切らず、窓の `/ws` もそのまま（`tests/unit/remote-upload.mjs`）。§11 の 6（バイナリにするか）は、この速さなら当面は要らない

### 8.2 モバイル版の殻

殻が持つのは**ホスト一覧・QR のペアリング・資格情報の保管・端末内プロキシだけ**。画面はホストが配る `web/` をそのまま全部（設定を含む）出す。

- 殻の画面（アプリに同梱。Capacitor の既定のオリジン）: ホスト一覧（名前・オンライン / オフライン / 確認中・最後に使った時刻）、「＋ ホストを追加」（カメラで QR → 「ホストの画面で承認してください · 確認コード 482 193」）、行の「…」（名前を変える・削除）
- ホストを選ぶと、殻がそのホストのプロキシを立てて WebView を `http://127.0.0.1:<p>/?token=…` へ移す。殻のプラグインのブリッジはホストの画面に入れない。代わりに小さなスクリプトで `window.plyRemote = { hostId, hostName, shell: 'mobile', backToHosts() }` だけを入れる（`backToHosts` はメッセージハンドラー経由。送り元がそのプロキシのオリジンの本体フレームのときだけ受ける）
- 今のホスト名（`⇄ desktop-home`）を出す。押すと `backToHosts()` でホスト一覧へ戻る。2026-09-23 から塗りは使わない（H1 配置・塗りなし）: 700px 以下はタイトルの下の差しの青の添え字、701px 以上（タブレット）は上端の帯（脇と同じ面）の左の「‹ ⇄ ホスト名」で、タイトル行は帯の右に上げる。「…」の中にも「ホスト一覧に戻る」
- 背面に回るとプロキシとチャネルは OS に止められる。前面に戻ったら張り直し、画面は既存の再接続で追いつく。承認待ちは #11 でホストが待ち続ける
- 暗号は iOS が CryptoKit、Android が標準の暗号（X25519 は `XDH`、AES-GCM は `javax.crypto` の `AES/GCM/NoPadding`）。どちらも §2.1 の試験ベクトルで Node の実装と突き合わせる。**Android の `XDH` は API 33 から**（developer.android.com の KeyAgreement / KeyFactory の表。当初 31 と書いたのは誤り）なので、最低の版を API 33（Android 13）にした（§11 の 3）
- 添付はクリップの「この端末から › ファイル…」（`#fileIn`。カメラも可）と「ホストから › ファイルを選ぶ…」（§8.1）。フォルダーの送信は出さない

### 8.3 アプリ内でローカルのプロキシを動かす制約（iOS / Android）

| | A 案: ループバックで待ち受ける（推奨） | B 案: スキームハンドラー + WebSocket の差し替え |
|---|---|---|
| 仕組み | Swift は `Network.framework` の `NWListener`、Kotlin はソケットで `127.0.0.1:<p>` に小さな HTTP/1.1 + WebSocket のサーバーを置き、WebView はそこを開く（デスクトップと同じ） | iOS は `WKURLSchemeHandler`（`pleiad-host://<hostId>/`）、Android は `shouldInterceptRequest` で HTTP を横取りしてトンネルへ流す。WebSocket はスキームを通らないので、`window.WebSocket` を差し替える JS を入れ、ネイティブのトンネルへ橋渡しする |
| iOS | 前面にいる間は動く。背面で止まり、戻ったら同じポートで立て直す。ATS に `NSAllowsLocalNetworking`。ループバックは「ローカルネットワーク」の許可ダイアログの対象外 | 待ち受けるソケットが無い |
| Android | 9 以上は平文が既定で禁止なので、`network_security_config` で `127.0.0.1` だけ平文を許す | `shouldInterceptRequest` は要求の本文を渡さない（今の HTTP は GET だけなので当面は困らない） |
| secure context | `http://127.0.0.1` は仕様上「信頼できるオリジン」。Android の WebView（Chromium）は確実。WKWebView は実機で確かめる | 独自スキームが secure context と見なされるかは WebView 次第で、`crypto.randomUUID()` などが通らない恐れ |
| `web/` の変更 | 不要（デスクトップと同じ経路） | WebSocket の差し替え（接続・メッセージ・close・`bufferedAmount` の再現）と、それが壊れたときの切り分けが増える |
| 危険 | 同じ端末の他のアプリがループバックに届く → プロキシのトークンと `Host` の照合（§7.1）で守る | 他のアプリからは届かない |

**A 案を推奨する。** デスクトップと同じ仕組み・同じ試験で済み、`web/` に手を入れない。B 案は「他のアプリから届かない」利点はあるが、トークンで塞げる危険と引き換えに、WebSocket の再実装と secure context の不確かさを抱える。
A 案で WKWebView が `127.0.0.1` を secure context と見なさなかった場合に備え、`crypto.randomUUID()`（`web/client.mjs:3123`）には `crypto.getRandomValues` で作る代わりを置いておく（数行。ブラウザー版の LAN 利用でも効く）。それでも詰まる箇所が出たら B 案に切り替える（プロキシの内側 = トンネルとフレームはどちらの案でも同じ）。

実装（Android、2026-09-23、issue #16。iOS は Mac と iPhone が無いので後回し）:

- **端末側は Kotlin に移した**（`mobile/android/remote-core/`）。JS のモジュールをアプリの中で動かす案（nodejs-mobile・隠した WebView）は採らない。nodejs-mobile は Node 一式（ABI ごとに数十 MB）を抱え、プロセスに 1 つで作り直せず、Android 15 以降の 16 KB ページの要件を外の prebuild に頼ることになる。隠した WebView は `node:crypto`・`node:http`・`ws` の代わりが要り、待ち受けと中継への線はどのみちネイティブで、フレームごとに JS と行き来する糊の方が本体より大きくなる。iOS も Swift で書き直すので、重なるのは同じ量。取り決めのずれは共有のベクトルと、Node の中継・ホストとの往復の試験で押さえる
- 移したもの: `X25519.kt`（JCA の `XDH` だけ。生の鍵は noise.mjs と同じ PKCS#8 / SPKI の前置きで出し入れ。RFC 7748 のベクトルで確かめる）、`Noise.kt`、`Frames.kt`、`Channel.kt`（1 本のスレッドの `Loop` に閉じ込める。Node のイベントループの代わり）、`RelaySocket.kt`（OkHttp 4.12.0。届いた順に溜め、聞き手を付けてから流す）、`Pairing.kt`、`DeviceLink.kt`、`DeviceProxy.kt` + `WebSocketFrames.kt`（127.0.0.1 の HTTP/1.1 と RFC 6455 の小さなサーバー。認証・`Host` の照合・GET/HEAD だけ・案内のページはデスクトップと同じ。HTTP の応答はどれも `Connection: close`）、`RemoteDevice.kt`（`hosts.json` はデスクトップと同じ形、秘密は `secrets.bin` に封じる）
- 試験（`cd mobile/android && ./gradlew :remote-core:test`、JDK 17 以上）: ベクトル（cacophony の IK / IKpsk2、Pleiad の導出、フレーム 17 例）、メモリの管でつないだチャネル（窓より大きい本文・大きい WebSocket のメッセージ）、**Node の本物の中継と fake のホストとの往復**（`InteropTest`。`mobile/scripts/fake-host.mjs` を子プロセスで立て、ペアリング・プロキシの認証と防火壁・`/ws` の `ready` とコマンド・900 KB のメッセージ・取り消しまで。`node` が無ければ飛ばす）。`npm test` の `mobile-shell` は plyRemote の形・平文の許可・版の固定・殻の辞書を見る
- 資格情報: `noBackupFilesDir/remote/`。秘密は Android Keystore の AES-256-GCM の鍵で封じる（`KeystoreCipher`）。Keystore の鍵はバックアップされないので `allowBackup=false` と data extraction rules でバックアップ・端末の移行から外す
- 平文: `network_security_config` で `127.0.0.1` だけ（ループバックのプロキシと、試験で `adb reverse` した中継）。利用者の入れた CA は信じない
- 殻の画面（`mobile/www/`）: ホスト一覧（状態・最後に使った時刻・「…」で名前を変える / 削除）、「ホストを追加」（ML Kit の `scan()` で QR、カメラの許可を求め、Google のスキャナーのモジュールが無ければ入れ始める。貼り付けも可）、ペアリング中は確認コード 6 桁と「やめる」。`pleiad://pair?...` のリンク（端末のカメラで QR を開いたとき）でも開き、そのときとペアリング済みのホストのときは先に確かめる。文言は殻の辞書 `mobile/www/i18n.js`（ja / en）、ネイティブは失敗を決まったコードで返して殻が訳す
- ホストの窓（`HostActivity`）: Capacitor の入らない素の WebView で `http://127.0.0.1:<p>/?token=…` を開く。入れるのは `window.plyRemote` だけで、`WebViewCompat.addDocumentStartJavaScript` と `addWebMessageListener` をどちらもプロキシのオリジンに限り、受け口は本体フレームからのメッセージだけを受ける。形は `{ hostId, hostName, relay, device, shell: 'mobile', status(), onStatus(fn), retry(), backToHosts(), closeWindow(), setTheme(dark, { top, bottom }) }`（`closeWindow` = `backToHosts`。凍結し再定義できない。`setTheme` は画面の配色と上端・下端の地の色 `#rrggbb` を殻へ知らせる口）。帯のバッジはこれでデスクトップと同じ部品が動く
- 戻るボタン・画面端のスワイプ: まず画面に取り消せる `plyremote:back` のイベント（`window`）を投げる。web/ は開いている面を手前から 1 つ閉じる（ダイアログ → メニュー・浮く面 → ファイルのプレビュー・設定 → 引き出し。client.mjs の `watchShellBack`）。`preventDefault()` されなければアプリを背面へ回す（`moveTaskToBack`）。**ホスト一覧へは戻らない**（2026-09-24。戻るのはタイトルの下のホスト名と「…」の「ホスト一覧に戻る」だけ。スワイプのたびに一覧へ落ちて会話を開き直すのを避ける）。窓を離れたらそのホストのプロキシを閉じる。前面に戻ったとき `offline` / `host-offline` なら待たずに張り直す
- 画面の端: 状態バー・ナビゲーションバー・切り欠きの下には画面を描かない（2026-09-24。それまでは edge-to-edge で web/ の `env(safe-area-inset-*)` に任せていたが、全面に重なる面（ファイルのプレビューなど）や WebView の版によって状態バーの時刻とタイトル・本文が重なった）。殻が WebView をバーとキーボードの分だけ内側に寄せ、insets を消費するので web/ の `env(safe-area-inset-*)` は 0 になる。バーには色だけを塗る: 状態バーは画面の上端の地の色、ナビゲーションバーと左右は下端の地の色（画面が `plyRemote.setTheme(dark, { top, bottom })` で知らせる。client.mjs の `paintShellTheme` が上端・下端の中ほどの要素の地の色を読み、脇・設定の開閉と幅の変化で送り直す）。記号の明暗も画面の配色に合わせる（初めは OS の明暗と紙の色。`HostActivity.applyBars`）。**殻の作り直しが要る**。`window.backToHosts` も `plyRemote.backToHosts` と同じものを入れる（web/remote-badge.mjs が両方を見る）
- 添付は WebView のファイル選択（`#fileIn`）、ダウンロードは DownloadManager にプロキシの Cookie を付けて渡す。外へのリンクはブラウザーで開く
- 版: Capacitor 8.5.2、@capacitor/app 8.1.1、@capacitor-mlkit/barcode-scanning 8.2.1、AGP 8.13.0、Gradle 8.14.3、Kotlin 2.2.21、OkHttp 4.12.0、compile / target 36、**minSdk 33**。アプリ ID `com.procway.pleiad`（デスクトップは `jp.ply.desktop`。ストアに出す前に揃えるか決める）

- ビルドと手元の確認: `cd mobile && npm ci && npx cap sync android && cd android && gradlew assembleDebug`（**JDK 21 以上**。Capacitor の `capacitor-android` が Java 21 でコンパイルするため、JDK 19 では「21は無効なソース・リリースです」で落ちる（2026-09-24）。`JAVA_HOME` を 21 以上に向けてから打つ。`local.properties` に `sdk.dir`）。`cap sync` を省くと `capacitor-cordova-android-plugins/cordova.variables.gradle` が無いと言って落ちる。Windows では `cap sync` が追跡中の `app/capacitor.build.gradle` と `capacitor.settings.gradle` を改行だけ書き換えるので、`git checkout --` で戻してからコミットする。本番の中継を使わずに確かめるなら `node mobile/scripts/fake-host.mjs --relay-port 8787` と `adb reverse tcp:8787 tcp:8787` で、端末の `http://127.0.0.1:8787` が手元の中継になる（出てくる `pleiad://pair?...` を `adb shell am start -a android.intent.action.VIEW -d '<それ>'` で渡すか貼り付ける）

App Store の審査: 殻がホスト一覧・QR ペアリング・Keychain の保管・接続の案内を持つ「自分のホストのクライアント」として出す（中身の無い殻の扱いを避ける）。審査用に fake バックエンドで動くデモのホストと、ペアリング済みの状態を用意する。

### 8.4 スマホで全機能を使うための画面の手直し

`web/` の変更（`plyRemote` の有無ではなく画面の幅・入力の種類で効かせる。ブラウザー版の狭い窓にも効く）:

- **脇の折りたたみ**: 700px 以下（`web/style.css:733`）で脇を会話の上に重ねる引き出しにし、会話を選ぶと閉じる。開閉は今の `#openSidebar` / `#closeSidebar`
- **「…」ボタン**: 右クリック（`web/side.mjs:224,363,445,705`）とドラッグ（状態・グループへの移動）でしか届かない操作に、行・状態の見出し・グループの見出しの「…」を足し、同じメニューを開く。iOS は長押しで `contextmenu` が出ないため。`hover:none` では常に見せる。子メニューはタップで開く（`web/context-menu.mjs:76` はタッチでホバーを無視するので、`openSub` をタップで呼ぶ）。ホバーでしか見えないグループの ＋（`web/style.css:190`）も `hover:none` で常に見せる
- **入力欄の文字 16px 以上**: `pointer:coarse` のときだけ入力欄・検索・combo を 16px（`--fs` は 14px、`web/tokens.css:78`）。iOS の自動拡大を防ぐ
- **画面下端**: `viewport-fit=cover` と `env(safe-area-inset-*)` を入力欄の下・上端の帯・引き出しに、高さは `100dvh`
- 会話の左の 72px の溝（`web/style.css:385-390`）を狭い画面で縮めるのは任意（筋と節の位置に効くので、見た目の確認をしてから）

実装（2026-09-23、#16 の web 側）: 上の通り。加えて、タイトル行の右端に「この会話の操作」の「…」（700px 以下とタッチ）、タッチの長押しで右クリックと同じメニュー（`web/long-press.mjs`。Android の OS の長押しと二重にならない）、指で開いた子メニューは入力欄にフォーカスしない、`crypto.randomUUID` の代わり（`web/dom.mjs` の `randomId`、§8.3）、モバイル版の殻の上端のホスト名の帯（`web/remote-badge.mjs` の `setupHostBar`。`plyRemote.backToHosts` か `window.backToHosts` を呼ぶ）。見た目の決まりは docs/design-system.md「狭い画面・タッチ」

## 9. 安全についての考え

| 相手 | できること | 対策 |
|---|---|---|
| 中継（持ち主の不注意・乗っ取り） | 付随情報を見る・止める・偽のホストを名乗る | 中身は Noise で E2E。端末は QR で覚えたホストの公開鍵、ホストは端末一覧の公開鍵を照合するので、なりすましは失敗する。付随情報が見えることは受け入れる |
| 通り道の盗聴・改ざん | — | 中継までは TLS（Coolify の前段）、その内側も E2E。改ざんは AEAD で検出して切る |
| 他人が中継を使う | 帯域の横取り | 登録用の秘密・トークンのハッシュの照合・上限（§5.3） |
| QR の漏えい（写真・画面共有） | 5 分以内に先にペアリングする | 1 回きり・5 分で失効・**ホストでの承認**と確認コードの突き合わせ |
| 端末の紛失・盗難 | その端末からホストを全権限で操作 | ホストの端末一覧から取り消す（中継とホストの両方で弾く）。保管庫は端末のロック解除が前提。アプリ自体のロック（生体認証）は §11 |
| 端末の中の他のプロセス・ブラウザーの悪意あるページ | ループバックのプロキシを叩く | プロキシの乱数トークン、`Host` の照合、Cookie は SameSite=Strict・HttpOnly、`/ws` はクエリのトークン必須（今のサーバーと同じ守り） |
| リモートからエージェント用の内部口を叩く | 委譲・コンテキスト MCP を使う | 接続口が `/mcp/` を通さない。HTTP は GET/HEAD だけ |
| ホストの UI トークンの漏えい | — | トークンは接続口の外に出ない（差し込みと `Set-Cookie` の除去） |
| ホストの画面の XSS | リモートからも同じ被害（エージェント経由の任意コマンド） | 今と同じ前提。主画面に CSP を付けるのは別の改善として勧める |

**全権限であることの意味**: ペアリングした端末は、承認モードの変更（YOLO を含む）、MCP の登録、秘密の差し替えまでホストの利用者と同じにできる。つまり端末を失くすことは、ホストの PC で任意のコマンドを実行されうることと同じ。端末一覧と取り消しを見つけやすい場所に置き、ペアリングの画面にもこの一文を出す。

## 10. 検証

`npm test` で確かめる（LLM は呼ばない）。中継とトンネルは fake バックエンドのホストで、端末 → 中継 → ホストの往復（会話の送信・承認・ファイルの取得・再接続）を自動で確かめる。

## 11. 未決

1. ~~**リモートの帯の色**~~ 決定（2026-09-23）: 塗らない。帯はローカルと同じ面で、差しの青のバッジ・OS の窓タイトル・タスクバーの重ねアイコンで見分ける（§7.2）
2. ~~**QR を作る部品**~~ 決定（2026-09-23）: `web/vendor/qrcode-generator.mjs`（MIT）を同梱（§6.1）。読み取りはモバイルのネイティブ（Capacitor のバーコードのプラグイン）
3. ~~**Android の最低版**~~ 決定（2026-09-23）: **API 33（Android 13）以上**。X25519 を標準の `XDH` だけで済ませるため（`XDH` は API 33 から。31–32 のために自前の X25519 を持つ案は採らない。Tink も足さない）
4. **WKWebView と `127.0.0.1` の secure context**: 実機で確かめる。だめなら §8.3 の代わりの UUID、それでもだめなら B 案
5. **通知**: 背面のモバイルには完了・承認待ちが届かない。APNs / FCM の鍵を持つ中継が要るので、この中継に載せるかは別に決める（中身は端末の鍵で暗号化して載せる）
6. **送信の効率**: フォルダーの送信は base64 の WS コマンド（約 33% 増える）。バイナリのフレームにするかは、実際の速さを見てから
7. **モバイルのアプリのロック**（生体認証で殻を開く）を最初から入れるか
8. **端末ごとの記録・権限**: 当面は全権限。入れるときは接続口が `X-Pleiad-Device` を付け、`store.recordChange` の `by` に端末を残す
9. **ホストの静的鍵を作り直す**操作（漏えいを疑うとき）。全端末のペアリングし直しになるので、画面の置き場を決める
10. **帯域**: 全イベントを全端末に配る・`loadSession` の全量・画像の `dataUri` はモバイル回線で重い。会話単位の購読や履歴の分割はリモートのための機能ではないので、実測してから別の issue にする
