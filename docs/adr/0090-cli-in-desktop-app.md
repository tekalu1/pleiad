# 0090 pleiad CLI はデスクトップ版に同梱し、Ply の内蔵 Node で走らせる。PATH は会話のシェルにだけ足す

- 状態: 承認（2026-10-03）

## 状況

[ADR 0083](0083-control-surface-cli.md) の CLI（`bin/pleiad.mjs`）は package.json の `bin` で、リポジトリで `npm link` する人しか使えなかった。デスクトップ版の利用者に `pleiad` を渡す方法は「利用を見て別に決める」としていた。

- デスクトップ版の PC には Node が無いことがある。
- Pleiad の中の AI は、会話のシェルから `pleiad` を呼べると便利（会話に束縛した接続情報 `PLEIAD_CONTROL_*` は既に渡している）。
- Pleiad の外の AI（Claude Code など）は `pleiad mcp` を MCP として登録したいが、登録に書く起動の仕方が分からない。

## 決定

- **インストーラーで OS の PATH は書き換えない。**
- **CLI をデスクトップ版に同梱する。** electron-builder.yml の `files` に `bin/**` を足す（`asar: false` なので `resources/app/bin/` に展開されたまま置かれる）。CLI が読む `core/ops/surfaces/mcp.mjs`（依存なし）と辞書（`web/locales/`）は元から同梱されている。
- **起動口は `bin/pleiad.cmd`（Windows）と `bin/pleiad`（シェルスクリプト）。** どちらも自分の 3 つ上（`resources/app/bin` から見たインストール先・`Pleiad.app/Contents`）に Ply の実行ファイル（`Ply.exe`・`MacOS/Pleiad`）があれば `ELECTRON_RUN_AS_NODE=1` で `bin/pleiad.mjs` を渡し、無ければ（リポジトリ）`node` で走らせる。リポジトリでも同じファイルを使い、`node_modules/.bin` は使わない。
- **サーバーは起動時に `bin/` を自分の PATH の先頭に足す**（`core/cli-launcher.mjs` の `addCliToPath`。同じものがあれば先頭へ寄せ、Windows は既存の `Path` のキーに書く）。エージェントのプロセス（Claude・Codex の app-server・Antigravity）と `!` の行のシェルはこの env を継ぐので、会話のシェルで `pleiad` が使える。
- **設定 › アプリ情報・更新に「外の AI から Pleiad を使う」を置き、「MCP の設定をコピー」（`mcpServers` の JSON）と「claude mcp add をコピー」の 2 つのボタンを出す。** 中身は操作 `app.cliSetup`（read・画面だけ・ホストの画面だけ）が返す。`command` は起動口ではなくサーバーの実行ファイル（デスクトップ版は Ply.exe、`npm start` は node）、`args` は `[<bin/pleiad.mjs の絶対パス>, "mcp"]`、`env` は Electron なら `ELECTRON_RUN_AS_NODE: "1"`、データ置き場が既定（`~/.agent-host`）でなければ `AGENT_HOST_DATA`。

## 理由

- インストーラーで PATH を書き換えると、アンインストール・更新・複数版の同居で壊れたときに直す手段が利用者に無い。Pleiad の中の AI に要るのは会話のシェルの PATH だけで、それはサーバーが持てる。
- Ply.exe は Electron で、`ELECTRON_RUN_AS_NODE=1` で Node として動く（サーバーの子プロセスが既に使っている。fuse の RunAsNode は止めていない）。Node を別に配らずに済む。
- PATH を会話ごとの env（`PLEIAD_CONTROL_*` と同じ所）ではなくサーバーのプロセスに足すのは、どのエージェントにも同じ値で、Codex の app-server（1 プロセスで全会話）にも `!` の行にも漏れなく届くため。会話ごとに変える値ではない。
- 外の AI の設定の `command` に `.cmd` を書かない: Node（Claude Code など）は Windows で `.cmd` をシェル無しで起動できない（`spawn EINVAL`）。実行ファイルを直に指せば、どの OS・どのクライアントでも同じ形で動く。
- 設定の場所は「アプリ情報」: このインストールの場所に依る情報で、外部 MCP（設定 › プラグイン）は Pleiad が**使う** MCP の節なので向きが逆になる。

## 影響

- `bin/pleiad` は LF、`bin/pleiad.cmd` は CRLF に固定する（`.gitattributes`）。シェルスクリプトの実行権限は git の mode（100755）で持ち、electron-builder はそのまま写す。
- インストール先を変えて入れ直すと、外の AI に貼った設定のパスは古くなる（貼り直す）。更新では同じ場所に入るので変わらない。
- 利用者が自分のターミナルで `pleiad` を使いたいときは、起動口のフォルダーを自分で PATH に足す（docs/design.md「操作の一覧」）。
- Linux のデスクトップ版は今は作っていない。作るときは起動口の探す先に実行ファイル名を足す。
