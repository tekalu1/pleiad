# 無停止の更新 段階 0 の実測: Codex と Antigravity（agy）の付け直し

[issue #54](https://github.com/tekalu1/pleiad/issues/54) の段階 0 のうち、Codex（`codex app-server`）と Antigravity（`agy`）について、保持役が stdio を持ってサーバー（JSON-RPC の相手・stdin の書き手）が入れ替わる形で、走っているターンが続くかを動かして測った。

- 印: **確認** = 動かして確かめた（スクリプトと結果を下に書く）。**推測** = コード・`--help`・一般の知識からの見込みで、動かしていない。**未確認** = 測っていない
- 測った版: `codex-cli 0.160.0`、`agy 1.2.17`、Node v24.14.0、Windows 11（x64）

## 結論

| 項目 | 結論 |
|---|---|
| 1. Codex: stdio を保ったままクライアントを入れ替える | **続く**。新しいクライアントは `initialize` も `thread/resume` も要らず、続きの通知をそのまま受け取る。承認の依頼は、入れ替えの間に来たものも含め、保持役が控えて渡せば足り、答えは別のクライアントから通る |
| 2. `--listen` / `daemon` / `proxy` | `--listen ws://` と `unix://`（+ `app-server proxy`）は、接続を切ってもターンも承認待ちも**止まらない**。付け直しは `initialize` + `thread/resume`。ただし**切れていた間の通知は届かない**。stdio を保持役が持つ案のほうが、欠けがなく、Claude・agy と同じ保持役の規約に載る。`daemon` は採らない |
| 3. agy | 付け直しに握手は要らない（stdin は 1 行 1 JSON を書くだけ）。相手が数秒いなくても、入れ替わっても、ターンは続く。1 行目のターンの最中に 2 行目を書くと、直列に回る |
| 4. HTTP MCP が 1〜3 秒つながらない | **MCP ごと外されはしない**（Codex・agy とも）。ただし**呼び出し 1 回は失敗する**ことがあり、Codex は約 2 秒までの不通なら透過に再試行する。**不通のあいだに始まった Codex のスレッドは、MCP を持たないまま一生続く** |
| 5. 版 | 末尾 |

## 方法（LLM を呼ばない仕組み）

スクリプトは `scripts/zero-downtime/codex/`。`npm install` 済みの worktree（`core/` の `i18n` が `i18next` を読む）で `node <script>` と実行する。

- **Codex は偽のモデル提供元を使う**。`mock-model.mjs` は Responses API 風の SSE を返すローカルの HTTP サーバーで、`CODEX_HOME/config.toml` の `model_providers` に向ける。台本は直近のユーザーの発言の語で決まる（`SLOW:<n>` = n 秒かけて本文を流す、`SHELL` = 承認が要るシェルを 1 回呼ぶ、`MCPCALL:<server>:<tool>` = MCP のツールを 1 回呼ぶ）。**app-server・承認・MCP の呼び出しは本物**で、LLM の呼び出しは 0 回
- `CODEX_HOME` は毎回、`temporary/zdu/`（追跡外）の下に作って消した（インストール版の会話の記録・設定は触っていない）。codex は `%TEMP%` の下の `CODEX_HOME` を断る（helper binaries を作れない）ので、リポジトリの `temporary/` に置いた
- インストール版の Pleiad と、それが立てている app-server には触れていない。`daemon` の実験で立った管理プロセスは、この `CODEX_HOME` の分だけを止めた
- 保持役の身代わり `holder-sim.mjs`: 子の stdio を持ち、stdout の行に通番を振って溜め、いまの接続へ流し、付け直しでは通番の続きから再生する（設計 §4 の「通番の記録」と「再生」だけ）
- **agy は実際の LLM を呼ぶ**（`gemini-3.8-flash-low`、短い応答。合計 9 ターン）。agy の会話は `~/.gemini/antigravity-cli` に残り、環境変数では逃がせなかった（認証が同じ場所のため）。作った 4 会話は末尾に記録した

## 1. Codex: 保持役が stdio を持ち、クライアントを入れ替える

`10-stdio-swap.mjs <noreinit|reinit|resume|approval>`、`11-string-id.mjs`。クライアント A が `initialize` → `thread/start` → `turn/start` し、途中で A を外し（保持役は出力を溜め続ける）、3 秒後に新しいクライアント B を付ける（B の JSON-RPC の id は別の番号帯から始める）。

**確認**

- **何も送らずに続きが届く**: B は `initialize` を送らない。A が受け取った通番の続きから再生すると、`turn/completed` まで届き、A と B の本文の差分（`item/agentMessage/delta`）の合計は 16 個で、重複も欠けもない。B は続けて 2 つ目の `turn/start` も通せた
- **2 回目の `initialize` は error を返すだけ**: `{"code":-32600,"message":"Already initialized"}`。そのあと接続は無事で、`thread/loaded/list`・`thread/read`・ターンの続きが通る。`initialized` の通知を重ねて送っても害はない。→ 付け直した `CodexRpc` は `initialize` を送らないか、送って `Already initialized` を成功とみなせばよい
- **`thread/resume` を走っているターンに送っても壊れない**: 結果は ok、ターンは続き、通知の重複もない（購読は stdio の 1 接続に 1 つなので、付け直しに要らない）
- **状態の読み直しの代わりの道**: `thread/loaded/list`（読み込み済みのスレッド）、`thread/read includeTurns`（ターンの `status: inProgress`）で、再生なしでも走っているターンの有無は分かる。ただし確認できた範囲では、承認待ちの最中の `thread/read` には `userMessage` しか入っておらず（ツールの行はまだ無い）、進行中の本文も読めるか分からないので、再生のほうが正確
- **承認の依頼**（`item/commandExecution/requestApproval`。id は codex が付ける整数）
  - (a) A に届いたあと、答えずに A を外して B を付けた: 再生された依頼に B が答えると、コマンドが走り、ターンは `completed`
  - (b) 依頼が来たとき誰も付いていなかった（入れ替えの間）: B が付けたあとの再生に依頼が含まれ、答えが通った
  - (c) B が答えたあとに A が同じ id に答えても無害（app-server が `could not find callback` と警告を出すだけ）。二重の答えで落ちない
- **id の空間は 2 つに分かれる**: 子から親への依頼の id（codex が付ける）と、親から子への依頼の id（クライアントが付ける）は別。A の途中の依頼の応答が入れ替えの間に届くと、B には知らない id の応答として届く（無害）。codex は**文字列の id を受けてそのまま返す**（`"g2-17"` で確認）ので、新しいサーバーが世代つきの id を使えば、**保持役が JSON-RPC の id を付け替えなくても**取り違えない

**推測**

- 2 つのクライアントが同じ数値の id を使うと、入れ替えの間に届いた古い応答を新しいクライアントが取り違える（動かしていない。上の「世代つきの文字列の id」で避けられる）
- 承認を何分も待たせたときに app-server 側の打ち切りがあるか（3 秒ほど待たせたのみ）。stdio の 1 接続のままなので、入れ替えが原因で新しく起きる理由は見当たらない

**設計（design.md）への影響**

- §4.4 の Codex の「付け直し」は、`initialize` を送らないか、送って `Already initialized` を成功とみなす、でよい。**保持役が `initialize` の答えを作る必要はない**
- §4.1 の「JSON-RPC は親の id を子側の id に付け替える」は**要らない**。新しいサーバーの id を世代つきの文字列にし、古い世代の応答は新しいサーバーが捨てればよい。保持役の「親の世代ごとの id 記録」を `policy: 'jsonrpc'` から外せる（薄くなる）
- 「答えていない依頼の控え」は、ログに依頼の行が残っていれば再生で足りる（控えは、ログの上限で依頼の行が落ちるのを防ぐための補強）
- 付け直した `CodexRpc` が持つ内部の対応表（`parents`・`agents` = サブエージェントの親子、`claims`・`held`）は、再生が印より前を含まないと欠ける。親子は `thread/read` / `thread/list` の `parentThreadId` から引き直せる（codex.mjs がすでに使っている）ので、再生の始点は「ターンの始まりの印」で足りる

## 2. Codex: `--listen` / `daemon` / `proxy`

`01-listen-probe.mjs`、`20-ws-reconnect.mjs <turn|approval|approval-resume|dual>`、`21-ws-auth.mjs`、`30-unix-proxy.mjs <direct|proxy>`、`40-daemon.mjs`。

**確認**

- `codex app-server --listen ws://127.0.0.1:<port>`（ポート 0 で空きを選ぶ。標準エラーに待受のアドレスを出す）と `--listen unix://`（制御ソケットは `$CODEX_HOME/app-server-control/app-server-control.sock`。パスを指定して作業フォルダーに置くと `socket directory is not private to the current user` で断られる）が動く
- **接続を切っても、ターンも承認待ちも止まらない**。スレッドは読み込まれたまま、承認の依頼は断られず待ち続ける
- **付け直し**（新しい接続）: 接続ごとに `initialize` が要る。通知は `thread/resume` するまで来ない（`thread/loaded/list`・`thread/read` は resume なしで読める）。**`thread/resume` すると、承認待ちの依頼が同じ id で新しい接続へ再送される**（`status.activeFlags: ["waitingOnApproval"]`）。resume 前でも、**古い依頼の id に別の接続から答えれば通った**
- **切れていた間の通知は届かない**。resume 後に届くのは、それ以降の通知だけ（本文の差分が欠ける。ターンが終われば `item/completed` に全文が入る）。`item/started` を切れ目の間に取り逃がす可能性がある（ツールの行の開始。**推測**。承認の依頼は再送される）
- **新旧の接続を同時に張れる**: 古い接続が付いたままの B が `thread/resume` すると、通知は両方へ届き、承認の依頼も両方へ届く（どちらが答えても通る）。古い側を切っても新しい側は続く。重なりのあいだは取り逃しがない、という使い方はできる
- **`app-server proxy --sock <path>` は WebSocket を話す**: stdio の上で JSON-RPC の行ではなく WebSocket のフレームを要求する（行を書いても返事が来ない）。`ws-min.mjs` の最小の WebSocket クライアントで話したところ、proxy のプロセスを殺して別の proxy から付け直す動きは ws と同じ（承認待ちが続き、再送され、答えが通る）。Node から制御ソケットへ直に `net.connect` すると `EACCES` だった（codex 自身の proxy 経由なら通る）
- **ws の認証**: 既定は**認証なし**で、同じ PC のどのプロセスも接続でき、`initialize` が通る。`--ws-auth capability-token --ws-token-file <絶対パス>` を付けると、トークンなし・間違いは handshake で断られ、`Authorization: Bearer <token>` は通る
- **`daemon`**（`codex app-server daemon start|stop|version`）: `start` が `CODEX_HOME/packages/app-server-daemon/` へ**自前の codex.exe（約 300 MB）を写して**から立てる（初回 約 19 秒）。`app-server --listen unix:// --managed-daemon` と、`daemon pid-update-loop` の 2 つのプロセスが立つ。**`stop` のあとも `pid-update-loop` が残った**。利用者の Codex の別のクライアント（TUI など）と共有される設計で、`-c` による会話ごとの設定は管理側の起動引数に載らない（**推測**。`daemon` のサブコマンドの `--help` に `-c` はあるが、動かしていない）

**推測・判断**

- **`daemon` は採らない**: インストール先とは別の codex.exe の写しを管理し、`update` が走っているターンを止めうる（`--help`: "may interrupt running work"）。Pleiad が `-c` で渡す設定とぶつかる
- **`--listen` を保持役の代わりに使うのは、段階 4 以降の選択肢に留める**。理由: ① 切れ目の通知が欠ける（Pleiad は本文の差分・ツールの行の開始を正規化に使う）② スレッドごとに `thread/resume` が要る（Pleiad は読み込み済みのスレッドの一覧を `thread/loaded/list` で引き直せるが、Pleiad の側のターンの状態は再生なしでは作れない）③ ws は認証つきにしないと PC 上の誰でも操作できる ④ Codex だけ別の付け直しの道になり、Claude・agy・`!` のシェルと保持役の規約が揃わない。一方、**保持役を持たずに済み**（Codex の app-server を独立のプロセスとして立てるだけ）、承認の再送が app-server の機能になる利点はある。重なりの接続（新旧の同時接続）は、取り逃しを避けたいときの手段になる

## 3. Antigravity（agy 1.2.17）

`60-agy-basic.mjs`、`61-agy-swap.mjs`（コード: `core/backends/antigravity-cli.mjs`）。

**確認**

- **握手がない**: 起動しただけでは 3 秒たっても何も出ない。1 行目（`{"event":"user","message":{"content":…}}`）を書いてから `init` が出る（`init` は**最初のターンの前に 1 回**）。イベントは `init` → `step_update`（`user_input` / `agent_response` ほか）→ `result`。`conversation_id` は `init`・`step_update`・`result` のどれにも入る。→ 付け直しに要るのは、**stdin を開けたまま、stdout の続きを読むこと**だけ。新しいサーバーが会話の ID・モデルを知るには、保持役のログ（最初のターンの印より後ろ）を再生すれば足りる（ID は `step_update`・`result` からも拾える）
- **相手が数秒いなくなっても、入れ替わっても、ターンは続く**: A を外し、stdout を 4 秒間誰も読まない状態（`pause`）にしてから読み直し、さらに B を付けて通番の続きから再生すると、`agent_response` の `step_update` が溜まり、`result`（`SUCCESS`、120 行の本文が欠けなし）が届いた。同じプロセスのまま、続くターンも通った。ただし出力が小さく（パイプの容量 64 KB に届かない）、**詰まりそうな量では測っていない**（保持役は常に読むので起きない想定）
- **ターンの最中に次の 1 行を書くと、直列に回る**: 「two」「three」を 150 ms 空けて書くと、`result(two)` のあとに 2 つ目の `user_input` が始まった（並行に動かない）。同じ会話 ID のまま
- **stdin を開けて何も書かない 6 秒**で落ちなかった。stdin を閉じるとターンを終えて `exit 0`（コードの注記どおり）
- ターンの数え方: 1 行ごとに `result` が 1 つ。→ 新しいサーバーは、保持役に「書いた行ごとの印」を置き、印より後ろの `result` の数で、終わったターンと走っているターンを数えられる

**推測**

- agy は stdin の行が欠けた状態（行の途中で切れた書き込み）の扱いを測っていない。設計どおり、保持役が行の途中で切れた書き込みを捨てればよい

**設計への影響**

- `policy: 'none'`（行だけ）でよい。保持役に agy のプロトコルの知識は要らない。ただし**`init` の再生用に、ターンの印を最初の行（ターンの始まり）に付ける**こと
- 起動時の孤児の掃除（`antigravity-pids.mjs`）は、保持役が持つ agy を対象から外す（設計どおり）

## 4. HTTP MCP が 1〜3 秒つながらないとき

`50-mcp-outage.mjs`、`51-mcp-startup.mjs`（Codex）、`62-agy-mcp.mjs`（agy）。MCP の口は `core/mcp-bridge.mjs` 実物（会話ごとの Bearer）で、ポートを閉じて（接続も強制切断）同じポートで開き直した。

### Codex（rmcp クライアント）

| 状況 | 結果 |
|---|---|
| 口が閉じた状態でツールを呼び、**1.0 秒・1.8 秒後に開き直す** | **呼び出しは成功**（待ち時間 1.0 秒・2.05 秒）。約 2 秒までは透過に再試行する |
| 口が閉じたまま 3 秒（再試行の上限を超える） | 呼び出しは **約 2.0 秒で失敗**: `tool call error: … Transport send error …` がモデルへの結果に入り、ターンは `completed`。MCP は外れない |
| 呼び出しの**最中に**切る（ハンドラーが 2.5 秒、1 秒で閉じて 3 秒で開く） | その呼び出しは**失敗**（約 1 秒後）。MCP は外れない |
| 失敗のあと開き直して呼ぶ | **成功**（再 `initialize` なしで `tools/call` だけが届いた。MCP のセッション ID を使わない口なので、新しいサーバーがトークンを持っていれば答えられる） |
| 10 秒間閉じていて（その間は呼ばない）、開き直して呼ぶ | 成功 |
| **スレッドを始めるとき（`thread/start`）に口が閉じている** | `required: false`: スレッドは始まる（状態取得が約 9 秒かかる）が、**ツールが空のまま。口を開けても、そのあとの 2 ターンと `thread/resume`（読み込み済みのスレッド）でもモデルにツールが渡らない**。`mcpServerStatus/list` は開いたあとはツールを返すが、ターンには反映されない。`required: true`: **`thread/start` が約 7.5 秒後にエラー**（`required MCP servers failed to initialize`） |

→ Pleiad の `ply_agents`・`ply_context` は `required: true`（codex.mjs の `thread/start` の config）。**サーバーの入れ替えの間に新しいスレッドを始めると、失敗するか、MCP を持たない会話になる**。

### agy（stdio の中継 `core/agy-context-relay.mjs` 経由。agy 自身は HTTP を話さない）

実物の `agentDefinition`（`core/backends/antigravity-context.mjs`）が書く agent.md と中継を使った。

| 状況 | 結果 |
|---|---|
| 口が開いている | `call_mcp_tool` が通る |
| **口を閉じたままツールを呼ぶ** | ツールのエラーになる: `TOOL_ERROR … Cannot reach Pleiad context: fetch failed`（中継に再試行はない）。モデルには失敗として見え、ターンは `SUCCESS` |
| 開き直して同じ agy で呼ぶ | **成功**。MCP は外されていない |
| **口が閉じたまま agy を起こして最初のターン** | そのターンはツールが一覧に出ず（モデルは "tool does not exist"）。**開き直したあとの次のターンでは使えた**（agy はターンごとにツールを引き直す） |

**推測**

- 中継に数秒の再試行を足せば、短い不通は agy には見えなくなる（設計 §4.4 のとおり。動かしていない）。agy の呼び出しの待ちは 3 分（`CALL_TIMEOUT_MS` のコメント）なので、数秒の再試行で時間切れにならない

**設計への影響（Codex・agy 共通）**

- **引き継ぎで MCP の口を閉じるときは、処理中の呼び出しが終わるのを待つ**。呼び出しの最中に口を切ると、その呼び出しは失敗する（Codex 約 1 秒後、agy は即時）。承認を待つ長い呼び出し（`ply_context` は最長 300 秒。`ply_control` は承認を待たずに返る）は、切り替えの前に済ませるか、「やり直しになる」と許す
- **新しいサーバーは、HTTP の口（同じポート・同じトークン）を待ち受けてから、スレッドを始める・ターンを始める**。不通の最中の `thread/start` は上のとおり致命的になりうる（設計の「新しい作業を送信待ちに回す」を、入れ替え完了まで保つ）
- 不通は **約 2 秒以内に抑える**（Codex が透過に再試行する上限。`1 秒前後` の見込みなら収まる）。超えたら呼び出しが 1 回失敗する（モデルが読んでやり直す）。段階 0-5 の「ツールの失敗で済むか、外されるか」は、**失敗で済む（Codex・agy。Claude Code は別の調べ）**

## 5. 結果に影響する版

| もの | 版 |
|---|---|
| Codex CLI（`codex.exe`、app-server） | `codex-cli 0.160.0`（`CODEX_HOME` を分けて、自分で立てた app-server だけを使った） |
| agy | `agy 1.2.17`（`gemini-3.8-flash-low`） |
| 測定の Node | v24.14.0 |
| OS | Windows 11（x64、ビルド 26200） |

`approval_policy = "untrusted"` を `config.toml` に書くと 0.160.0 は起動を断る（"no longer supported"）。Pleiad は `thread/start` / `turn/start` の引数で渡すので影響しない。

## 6. 残った未確認

- **本物のモデルでの Codex**: 偽のモデル提供元で測った。app-server のターン駆動・承認・MCP は本物だが、本物のモデルが長い SSE を保持している最中のクライアント入れ替えは測っていない（モデルとの通信は app-server の中で、クライアントの入れ替えとは独立のはず）
- 承認の依頼を数分待たせたときの app-server 側の打ち切り。入れ替えの間隔（今回は 2.5〜3 秒）より長い 10 秒以上
- 保持役が**読まない**状態が続いて、パイプが詰まる量（64 KB 以上）の出力を子が出したときの子の振る舞い（保持役が常に読めば起きない。agy の出力は小さい）
- 子が `stdin` の行の途中で切れた書き込みを受けたとき（保持役が捨てる前提）
- agy の呼び出しの最中に口を切った場合（中継の `fetch` が即失敗する）。agy に Pleiad の中継が複数（`--context --computer --browser --control` の束ね）の場合の不通
- Codex `--listen` / `daemon` を、実際の認証（ChatGPT ログイン）・実際のモデルで動かしたときの振る舞い。`daemon` の `-c` の扱い
- Windows の AF_UNIX の制御ソケットへ Node から直に接続できない理由（`EACCES`。ACL か codex の「private」の判定か）。codex 自身の `proxy` 経由なら通る
- Codex のサブエージェント（子スレッド）が走っているときの付け直し（`parents`・`agents` の組み立て直し）
- macOS・Linux（今回は Windows のみ。保持役は名前付きパイプ前提で、まず Windows）

## 後始末

- Codex: 一時の `CODEX_HOME` は毎回消した。会話の記録は作っていない（インストール版の `~/.codex` には触れていない）
- agy: 次の 4 会話が `~/.gemini/antigravity-cli` に残っている（どれも短い試験用の発話だけの会話）。要らなければ `agy` の側で消す: `ccb4488a-8ad5-4a4e-9b9d-e00e791c9b34`、`5f59ddfb-3ab3-4193-b989-556035598165`、`64c1c04c-8159-4e56-9528-10c28d93ff19`、`77911cc2-c15e-4435-91da-b83c7c5b28fa`
