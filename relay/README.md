# Pleiad の中継

端末（デスクトップ版・モバイル版）とホストの Pleiad をつなぐ中継サーバー。設計は [docs/remote.md](../docs/remote.md) §5。

- 中身は端末とホストの間で暗号化されていて、中継は読めない。照合してバイト列を流すだけ
- ディスクに何も書かない。ホストがつなぐたびに端末一覧（トークンのハッシュ）を送り直す
- 依存は `ws` だけ。`server.mjs` 1 ファイル

## 動かす

```sh
npm ci --omit=dev
RELAY_ENROLL_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))") node server.mjs
curl http://127.0.0.1:8080/healthz   # ok
```

環境変数は docs/remote.md §5.4 の表のとおり。`RELAY_ENROLL_SECRET`（32 字以上）が無ければ起動しない。

## Docker で置く

中継は HTTP で待ち受ける。端末とホストは `https://` でしか中継を受け付けないので、前に HTTPS を終える逆プロキシ（Caddy・Traefik・nginx など）を置く。WebSocket を通す設定にする。

```sh
docker build -t pleiad-relay relay/
docker run -d --restart unless-stopped -p 127.0.0.1:8080:8080   -e RELAY_ENROLL_SECRET=<32 字以上のランダムな値> -e RELAY_TRUST_PROXY=1 pleiad-relay
```

- `RELAY_TRUST_PROXY=1` は逆プロキシの後ろに置くときだけ付ける（認証に失敗した接続元の IP を `X-Forwarded-For` から読む）
- 永続ストレージは要らない。台数は 1 台（状態をメモリに持つ）

## Coolify に置く

新しいリソース → このリポジトリ → Build Pack「Dockerfile」、Base Directory `/relay`、Ports Exposes `8080`、Domains `https://relay.<自分のドメイン>`、Health Check のパス `/healthz`。
環境変数に `RELAY_ENROLL_SECRET` と `RELAY_TRUST_PROXY=1` を入れる。永続ストレージは付けない。サーバー 1 台の構成ならレプリカの設定は無く、常に 1 つで動く。

## Pleiad につなぐ

ホストの Pleiad の 設定 › リモート で、中継の URL（`https://relay.<自分のドメイン>`）と `RELAY_ENROLL_SECRET` の値を入れて有効にする。
端末は「端末を追加」の QR（モバイル版）かコード（デスクトップ版の「ほかのホストにつなぐ」）でペアリングする。端末に秘密の値は要らない。
秘密の値を知っている人は誰でもこの中継にホストを登録できる。信頼できる人にだけ渡す。

## 試験

リポジトリの根で `npm test -- relay`（`tests/unit/relay.mjs`）。
