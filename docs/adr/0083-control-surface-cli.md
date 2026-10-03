# 0083 CLI は走っている Pleiad へ control.json でつなぎ、MCP サーバーはその 1 モードにする

- 状態: 承認（2026-10-03）

## 状況

[ADR 0081](0081-control-surface-registry.md) の操作を、MCP 以外の口（まず CLI）からも使いたい。例: `pleiad sessions search "…"`、`pleiad settings get/set`。
Pleiad の外で動く Claude Code などからも、セッション検索を使いたい。

今の状態:

- 画面のトークンは起動ごとの乱数で、ディスクに書かない。
- デスクトップ版が覚えるのはポートだけ（Electron の userData の `server-port.json`）。
- データ置き場に接続の情報は無い。Pleiad の CLI も無い。

## 決定

- **サーバー（core/server.mjs。デスクトップ版も `npm start` も同じ）は、起動時に `<データ置き場>/control.json` を権限 0600 で書く。**
  - 中身は `{ version, pid, origin, cliToken, startedAt, appVersion, kind }`。
  - 終了時、pid が自分のときだけ消す。
- **CLI 用トークンは画面のトークンと別の乱数にする。** 効くのは `GET /api/ops` と `POST /api/ops/:id` だけ。
  - 画面・WS・ファイルの口には効かない。画面のトークンはこれまでどおりディスクに書かない。
  - 中継（リモート）は `/api` を通さない。
- **このトークンの主体は、会話に束縛されない `agent`（`via: cli` または `mcp-stdio`）。** read と write は通すが、guarded は実行せず `NEEDS_UI` で画面へ誘導する。human-only は出さない（[ADR 0082](0082-control-surface-principals-and-risk.md)）。
- CLI（`bin/pleiad.mjs`、package.json の `bin`）は Node の組み込みだけで書く、薄いクライアントにする。
  - 操作の一覧と入力のスキーマを実行時に `GET /api/ops` から取り、サブコマンドと引数を作る（id の `.` を区切りにする）。
  - サーバーに操作が増えれば、CLI を作り直さなくても出る。
  - 入力の検査はサーバーに任せる。
- つなぎ先は次の順で探す。
  1. 環境変数 `PLEIAD_CONTROL_URL` / `PLEIAD_CONTROL_TOKEN`（Pleiad が会話のプロセスに渡す。**その会話に束縛された `agent`** として動き、その会話の承認モードに従う）
  2. `AGENT_HOST_DATA`（無ければ `~/.agent-host`）の `control.json`（会話に束縛されない）
- **サーバーが居なければ、終了コード 3 と起動の仕方を出して終える。** ファイルを直に読む読み取りのモードは作らない。
- **`pleiad mcp` は、同じ一覧を stdio の MCP として出す CLI の 1 モードにする。**
  - ツールの作り方は `ply_control` と同じ生成器を使う。主体は `via: mcp-stdio`（会話に束縛されない）。
  - Pleiad の中の会話には使わせず、会話に束縛した HTTP の `ply_control` を渡す。

## 理由

- 走っているサーバーを唯一の入口にすれば、次のものを CLI でもそのまま使える。
  - 検査・権限・配信・記録
  - 検索の索引
  - エージェント側と合成したセッションの一覧（[ADR 0005](0005-source-of-truth-for-sessions.md)）
- ファイルを直に読むと、サーバーと同じ結果を保証できない。
- データ置き場に接続の情報を置けば、デスクトップ版でも `npm start` でも、検証用の別の置き場でも、同じ規則で見つかる。
- CLI 用トークンを別にし、届く範囲を `/api/ops` に絞る理由: このファイルは同じ利用者のプロセス（エージェントを含む）が読める。読まれても、画面の全権限は渡らない。
- 会話に束縛されない主体に guarded を通さない理由: エージェントは自分のシェルから CLI を呼べ、`control.json` も読める。束縛されないトークンで guarded が通ると、承認が要る会話のエージェントが関所を迂回できる。会話に束縛した接続情報で呼べば、その会話の規則に従う。
- MCP サーバーを CLI の 1 モードにすれば、Pleiad の外の AI にも同じ定義を出せる。ツールの定義を二重に持たずに済む。
  - 先例: `core/agy-context-relay.mjs`（stdio から HTTP への中継）。

## 影響

- `control.json` は秘密を含むデータ置き場のファイルとして扱う（ADR 0050 の読ませない対象に入る）。
- 同じデータ置き場で 2 台立てた場合は、後から立てた方へつながる。
- 終了コードを決める: 0 成功・2 入力の誤り・3 未起動・4 拒否または画面での操作が必要・5 その他。
- 会話ごとの環境変数を渡せないエージェント（1 プロセスで複数の会話を持つもの）は、束縛されない CLI として動く。
- デスクトップ版の利用者に `pleiad` を PATH で渡す方法と、CLI から Pleiad を起動する `--start` は、利用を見て別に決める。
- `docs/` に CLI の節を足す（つなぎ先・終了コード・`pleiad mcp` の登録の例）。
- 段階 0 では CLI も `control.json` も作らない（決定だけ）。段階 1 で作る。
- 段階 3 で追加する委譲と会話中のブラウザー操作は、会話に束縛されない CLI からは `NEEDS_UI` とする（[ADR 0091](0091-control-surface-host-delegation-browser.md)）。
