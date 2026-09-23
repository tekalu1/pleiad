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

## Coolify に置く

新しいリソース → このリポジトリ → Build Pack「Dockerfile」、Base Directory `/relay`、Ports Exposes `8080`、Domains `https://relay.<自分のドメイン>`、Health Check のパス `/healthz`。
環境変数に `RELAY_ENROLL_SECRET` を入れる。永続ストレージは付けない。レプリカは 1。

## 試験

リポジトリの根で `npm test -- relay`（`tests/unit/relay.mjs`）。
