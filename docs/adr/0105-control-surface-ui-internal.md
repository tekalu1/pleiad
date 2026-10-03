# 0105 「画面の中だけ」に分けた WS コマンドを見直し、人が使う機能を操作の一覧に移す

- 状態: 承認（2026-10-03）

## 状況

[ADR 0091](0091-control-surface-host-delegation-browser.md)・[0094](0094-human-only-five.md)・[0095](0095-control-surface-mcp-hooks-context.md) で、WS のコマンドの `todo` は 0 件になった。`tests/ops-baseline.json` で `ui-internal`（画面の内部。外へ出す意味が無い）に分けたコマンドが 42 件残っていた。その中には、画面の部品の都合ではなく、人が画面で何かを成し遂げるために使う機能も混じっていた（バックエンドの切り替え・バックグラウンドの処理を止める・サブエージェントの中身を読む・コンテキストの中身を見る・git の差分を読む・会話のシェルでコマンドを動かす など）。

ユーザーの決定（2026-10-03）: Pleiad の全機能を AI も使えるようにする。人だけの例外は、承認モード・秘密の値・アカウント・接続先の既定・リモートのペアリングの 5 つ（ADR 0094）。

送信と既読（`runTurn`・`sendMessage`・`messageAction`・`markRead`・`saveDraft`・`watchSession`）は別の作業（[ADR 0104](0104-send-to-another-conversation.md)）で扱う。`loadSession` は ADR 0091 の追記で `ui-internal` と決めた。この ADR はそれ以外の 35 件を扱う。

## 決定

- **人が画面で使う機能は操作にする。迷ったら操作にする。** 画面の部品の都合だけで、画面の外では意味が無いものだけを `ui-internal` に残す。既にある操作と重なるものは、新しい領域を作らずその領域（`context.*`・`worktrees.*`・`notify.*`・`hooks.*`・`sessions.*`）に足す。
- **WS のコマンドは、その操作を人として呼ぶ薄い外側にする**（`core/server.mjs` の `viaOp`）。画面の振る舞いは変えない。画面（人）には今までと同じ形を返し（`uiHandler`）、AI・CLI には一覧を `limit` / `cursor` で区切り、本文と出力を切った形を返す（`sessions.read`・`sessions.listMessages` と同じ流儀）。

### 操作にしたもの（24）

| WS | 操作 | 危険度 | 理由・AI への形 |
|---|---|---|---|
| `notifyStatus` | `notify.status` | read | 設定 › 通知の状態。AI には端末を数（`count`・`muted`）だけ返す。端末の一覧は「リモートのペアリング」で人だけ（ADR 0094）。 |
| `sessionContext` | `context.session` | read | 会話に固定した指示・Skills・外部 MCP と担当。`entries` を区切り、本文を切る。 |
| `contextDiff` | `context.diff` | read | 固定した文脈と今のファイルの違い。前後の本文を切る。 |
| `scanContext` | `context.scan` | read | 作業場所の探索の結果。種類と範囲（`user`・`directory`。`directory` は AI のために足した）で絞れ、`entries` を区切り、本文を切る。 |
| `slashSkills` | `context.skills` | read | 使える Skills（入力欄の「/」の候補）。区切る。 |
| `agentMcp` | `context.agentMcp` | read | 各エージェントの設定の外部 MCP。 |
| `nativeInstructions` | `context.nativeInstructions` | read | エージェントが自分で読む指示ファイルと量。区切る。 |
| `contextFindings` | `context.findings` | read | 指示ファイルの気になる所。 |
| `gitStatus` | `git.status` | read | 会話の作業場所の git の状態。 |
| `gitPanel` | `git.changes` | read | 変更の一覧・分けた作業場所・会話の git の出来事。ファイルを区切り、出来事は新しい 20 件。開いたときの分けた作業場所の片付け（sweep）は画面だけ。 |
| `gitDiff` | `git.diff` | read | 1 ファイルの差分。AI には統一差分の文字列を切って返す。 |
| `worktreeCheck` | `worktrees.check` | read | 分けた作業場所の状態（ぶつかり・分けられるか）。 |
| `worktreeSettings` | `worktrees.settings` | read | 「いつも分ける」の値（書くのは既存の `worktrees.setSettings`）。 |
| `hooksUnifyPreview` | `hooks.unifyPreview` | read | 担当を変えたときの見込み。`hooks.setOwner` に渡す `imports`（digest）と `revision` はこれでしか得られないので、AI にも要る。何も書かない。 |
| `loadBackground` | `sessions.background` | read | 会話の裏の処理。`taskId` を省くと一覧（AI だけ）、渡すと詳細。出力は末尾を残して切る。 |
| `findSubagent` | `sessions.subagents` | read | サブエージェントの一覧と状態（AI だけ）、`toolId` でその子だけ（画面の形）。区切る。 |
| `loadSubagent` | `sessions.readSubagent` | read | サブエージェントの会話。発言を区切り、本文を切り、考えとツールの入力は AI に返さない。 |
| `listDirs` | `files.listDirs` | read | このホストのフォルダーの中身（名前・大きさ・更新時刻だけ。中身は読まない）。区切る。 |
| `runShell` | `shell.run` | guarded | 任意のコマンドを会話の作業場所で動かす。承認が要る会話では承認カード、承認なし（bypass・YOLO）の会話は確認なしで通して記録に残す。AI には終わるまで待った結果（`waitMs`。既定 30 秒）を、出力の末尾を切って返す。 |
| `stopShell` | `shell.stop` | write | 走っている行を止めるだけ。 |
| `skipShell` | `shell.skip` | write | 次の発言で渡すかの印だけ。コマンドは動かさない。 |
| `switchBackend` | `sessions.switchBackend` | guarded | 下の「切り替えの危険度」。 |
| `stopBackground` | `sessions.stopBackground` | write | 裏の処理を 1 本止めるだけ。会話もターンも消えない。 |
| `setGrouped` | `sessions.setGrouped` | write | 一覧の見え方だけ。 |

- **切り替えの危険度。** `sessions.switchBackend` は guarded。同じ切り替えを次のターンから行う `sessions.setTurnSettings` の `backend` が guarded（承認モードの掛かる範囲と既定のモードが変わる）なので、こちらだけ緩めると抜け道になる。切り替えると承認モードは切り替え先の最初のモードになる（`core/conversations.mjs` の `switchBackend`。Antigravity は全自動）。今のモードよりどちらかの軸で緩くなる切り替えは、AI からは承認カードを出さずに `NEEDS_UI` で断る（承認モードは人だけが決める。bypass の会話からでも断る）。人の画面からは今までどおり選べる。
- **止める操作は読み取りの会話から断る。** `shell.stop`・`sessions.stopBackground` は `modeGate` を外さない。どちらも別の会話のものを止められ、`computer.stop`（安全のための停止）とは違い、`sessions.abort` と同じ扱いにする。
- **探索は 1 つずつ。** `context.scan`・`context.skills`・`context.session` の突き合わせは重い探索なので、画面は接続ごと、AI・CLI はまとめて 1 つの錠（`ctx.scanLock`）を通し、走っている間の 2 つ目は `SCAN_BUSY`。
- **秘密は伏せる。** 探索の結果・会話の文脈・git の差分・裏の処理のラベルなど、どこに秘密が混じるか形で決まらない返りは、AI には `core/ops/redact.mjs` の `maskTree`（Hooks の定義と同じ伏せ方: env・headers の表、秘密らしい名前のキー、コマンドの引数の秘密、形で分かる秘密、URL のクエリ）を全体に掛ける。外部 MCP の行の本文と `configs` の本文は設定ファイルの生の中身で、複数行に分かれた引数の秘密を形で伏せきれないので AI には返さない（コマンド・引数・env・URL は行の欄で伏せて返る）。
- **会話から呼ぶときの既定。** 会話に束縛された AI が `sessionId`・`cwd`・`backend` を省けば、その会話のもの（ADR 0095 と同じ）。
- **出す口。** 全部 `ui: true`・`mcp: 'catalog'`（直のツールは増やさない）・CLI（`git`・`shell`・`files` の語を足す）。

### `ui-internal` に残したもの（11）

| WS | 理由 |
|---|---|
| `presence` | 各画面が「いま見ている会話」を知らせる印。スマホへの通知を送らない・消すための、接続ごとの表示の状態。 |
| `notifyRegister` | スマホの画面（中継越しの接続）が自分の通知の鍵を登録する口。その端末の接続からしか意味が無い。 |
| `plyHookPreview` | Hook の追加・編集のシートが保存前に出す、エージェントごとの渡し方の見込み。保存は `hooks.save`、登録の一覧は `hooks.list`。 |
| `hookTargets` | Hook の編集のシートの「書き先」の表示。書き先は `hooks.saveNative` の `dryRun: true` が返す。 |
| `onboardingStatus` | 初回案内の画面の材料。エージェントの一覧は `agents.list`、導入・ログインの状態は `agents.authStatus` にある。 |
| `onboardingSeen` | 初回案内を見た印。 |
| `completeSetup` | 初回案内の完了の印。既定のエージェントは `settings.set` の `backend` が担う。 |
| `hostCapabilities` | この接続（画面）が PC の画面か・PC の内蔵ブラウザーを見られるか、という接続ごとの判定。ボタンの出し分けに使う。 |
| `resolvePath` | 会話の中のファイルのリンクを押したときの、パスの解決（リンクの部品）。開く操作（`revealPath`・`openPath`）は `host-screen-only`。 |
| `prefs` | 画面の起動時に設定をまとめて読む形。同じ値は `settings.list`・`settings.get` が返す。 |
| `uploadCheck` | 手元のフォルダーを送る前の事前確認。送る本体（`uploadStart` など）は `stream`。 |

## 理由

- 人が画面で使える機能を AI が使えないと、AI は同じことをシェルや推測で回り道するか、人に頼むしかない。操作の一覧に載せれば、画面と同じ本体・同じ検査・同じ記録を通る（ADR 0081）。
- 画面の部品の都合だけの口（表示の状態・シートのプレビュー・初回案内・接続ごとの判定）は、画面の外から呼んでも成し遂げることが無く、一覧を長くするだけなので残す。
- 一覧と本文に上限を付けるのは、AI が 1 回の呼び出しで読む量を抑えるため（ADR 0091 追記）。画面は今までの全量を読むので `uiHandler` で分ける。

## 影響

- `tests/ops-baseline.json` の `ui-internal` は 42 → 16（この ADR で 24 を移し、[ADR 0104](0104-send-to-another-conversation.md) が `messageAction`・`markRead` を移した。残りはこの ADR で残した 11 と、送信の `runTurn`・`sendMessage`・`saveDraft`・`watchSession`、`loadSession`）。
- 操作の一覧の snapshot（`tests/ops-surface.snap.json`）に 24 の操作が載る。`ply_control` の指示と tools/list の量は増えない（ja 1757・en 1656 トークン。上限 1800）。新しい操作は `list_ops`・`call_op` から呼ぶ。
- 画面からのコマンドは引数を操作の入力の型で検める。今まで黙って受けていた型の違う引数（例: `runShell` の形の違う `runId`）は `INVALID` になる。画面が送る引数は変わらない。
- `shell.run` の AI の呼び出しのために、`core/shell-runs.mjs` に `wait`（終わった結果を新しい 50 件だけ覚えて返す）を足した。
- 検査: `ops-session-work`（依存を差し替えて、分け方・危険度・AI に返す形・画面の形）、`control-ui-internal`（e2e。実際の Codex の会話から `context.scan`・`sessions.switchBackend`・`shell.run` を `call_op` で呼び、guarded の承認待ち → 許可で反映）、`ops-control`（秘密の目印の入った home で新しい read 操作を呼ぶ・bypass の会話から `call_op` の `shell.run`・list_ops に残した `ui-internal` が出ない）、`ops-surface`（T6 の依存）。
