# 無停止の更新・段階 2-0（実測）: Claude の付け直しの残りの場面

管理 issue: #54。段階 0（[stage0-claude.md](stage0-claude.md)）で測っていない場面の最中に、保持役が持つ同じ CLI に SDK の `query` を作り直して付け直したときの振る舞いを、実際に動かして確かめた記録。場面ごとに design.md §4.4 の 3 つ（**付け直せる**／**引き継ぎの前に終わるのを待つ**／**その場面のターンは保持役に載せない**）のどれに倒すかを決める。

- 印: **【確認】** = この調べで動かして確かめた。**【推測】** = 動かしていない見込み。
- LLM は `haiku`・短い指示で呼んだ（本物のモデルは約 25 回・合計約 0.34 USD）。互換の接続先と数 MB の出力は、偽の接続先（`fake-api.mjs`。LLM の費用なし）で測った。

## 環境

| 項目 | 値 |
|---|---|
| Claude Code CLI | 2.1.284（`~/.local/bin/claude.exe`。ネイティブ）。npm の場面は `@anthropic-ai/claude-code@2.1.284`（`claude.cmd` → `bin/claude.exe`） |
| `@anthropic-ai/claude-agent-sdk` | 0.3.288（`claudeCodeVersion` は 2.1.288） |
| `@modelcontextprotocol/sdk` | 1.30.0 |
| Node（探りのスクリプト・保持役・stdio の MCP を動かしたもの） | 24.14.0 |
| OS | Windows 11（10.0.26200） |

## 方法

`scripts/zero-downtime/claude/` に足した。ユーザーの Pleiad・データ置き場は使っていない。作業ディレクトリと記録は `temporary/zdu-stage2/`（コミットしない）。試験の会話の記録（`~/.claude/projects` と `%TEMP%\claude` の試験用 cwd の分）は終わってから消した。

- `run2.mjs`: 段階 2-0 の場面（下の表の名前）。親を別プロセスで起こし、場面の最中に `taskkill /F` で捨て、**アプリが処理し終えた最後の行の次**から新しい親を付ける（段階 0 の `run.mjs` と同じ）。動かし方は先頭のコメント（例 `node scripts/zero-downtime/claude/run2.mjs steer cancel=1`）
- `harness.mjs`: `run2.mjs` の台（保持役と親の起動・見張り・取りこぼしと重複の数え方）
- `parent.mjs`: 段階 0 の親に設定を足した（Pleiad の実際のオプション・stdio の MCP・`onElicitation`・`onUserDialog`・`getOAuthToken`・途中送信・`/compact`・互換の接続先・素の起動）。段階 0 の設定はそのまま動く
- `holder.mjs`: `.cmd` を cmd.exe 経由で起こす分と、`info` にメモリを足した
- `probe-mcp.mjs`: CLI の子として起きる stdio の MCP（状態を持つ `counter`・待つ `slow`・elicitation を出す `ask`）
- `fake-api.mjs`: Messages API のふりをする接続先（本文の大きさ・ツールを 1 回呼ばせる）
- `s-r15-stdio-mcp.mjs`: R15。Pleiad のサーバーが起こす外部の stdio MCP の扱い（CLI は使わない）
- `brief2.mjs`: 記録を短く並べる

## 結果と推奨

| 場面 | 結果 | 推奨 |
|---|---|---|
| サブエージェント（前面。中で `Bash` が走っている） | 新しい親に、サブエージェントのツールの結果・`Agent` の結果・最後の返答が届いた。取りこぼし 0・重複 0【確認】 | **付け直せる** |
| サブエージェント（裏。親のターンが `result` を返した後） | 裏のサブエージェントが新しい親の下で終わり、通知から親が再開して返答まで届いた【確認】 | **付け直せる** |
| サブエージェントの中の承認待ち | 新しい親の `canUseTool` が、新しい親が起きてから 74 ms で**同じ `requestId`** で呼ばれ、許可するとターンが完了した（`pending_permission_requests`）【確認】 | **付け直せる** |
| 裏のコマンド（`Bash` の `run_in_background`） | 付け直しの直後（約 70 ms）に、CLI が**今の裏の作業の全量**を `background_tasks_changed` で出し直した。終わりの `task_notification` と、親の再開・返答も届いた【確認】 | **付け直せる** |
| 途中送信（`pendingSteers`。uuid 付き・`priority: "next"`） | 旧い親が流し込み、折り込まれる前に捨てた分が、次の区切りで折り込まれ、**同じ uuid の replay**（`isReplay`）が新しい親に届いた（答えに反映された）。新しい親の `interrupt({ cancelQueued: true })` は、旧い親が流し込んだ分を `cancelled` に返して取り消した【確認】 | **付け直せる**（`pendingSteers` を札に入れる） |
| 圧縮（`/compact` の要約中） | 新しい親に `compact_boundary` と `PostCompact` が届き、圧縮は 1 回で完了した（費用も 1 回分）【確認】 | **付け直せる** |
| 圧縮（`PreCompact` のコールバックの最中） | 付け直しの `initialize` の後、CLI が自分でそのコールバックを取り消し（`control_cancel_request`）、圧縮は止まらずに 1 回で完了した【確認】 | **付け直せる**（待たなくてよい。下の「注意」） |
| `elicitation`（stdio の MCP が出したもの。親が答える前） | `initialize` の応答の控えに**入らない**。CLI は再送せず、控えを渡し直さないと 60 秒たっても進まない。保持役が控えを渡し直すと、新しい親の `onElicitation` が、新しい親が起きてから 66 ms で呼ばれて完了した【確認】 | **付け直せる**（控えの渡し直しに `elicitation` を足す） |
| `request_user_dialog` | CLI は `supportedDialogKinds` で宣言された種類しか出さない。Pleiad は宣言しない。2.1.284 の中にある種類（`permission_*`・`mcp_elicitation`・`refusal_fallback_prompt` など 13）を宣言しても、承認と `AskUserQuestion` は `can_use_tool`、MCP の問いは `elicitation` のまま来て、起こせなかった【確認】 | **対象外**（宣言しない限り出ない）。宣言するようになったら測り直す。型の説明では `initialize` の応答の `pending_user_dialog_requests` で回し直せる【推測】 |
| `oauth_token_refresh` | SDK がこの依頼を受けられると CLI に知らせるのは、公開されていない `getOAuthToken` を渡したとき（起動の env の `CLAUDE_CODE_SDK_HAS_OAUTH_REFRESH=1`）だけ。Pleiad は渡さない。渡して偽の `CLAUDE_CODE_OAUTH_TOKEN` で 401 にしても、CLI は依頼を出さずにターンを失敗で終えた【確認】 | **対象外**（渡さない限り出ない）。使うなら `mcp_message` と同じく控えの渡し直しが要る見込み【推測】 |
| Pleiad の実際のオプション（`systemPrompt` のプリセット + append・`settingSources` user/project/local・`skills: "all"`・`replay-user-messages`・`thinking`・フラグ設定の `disableAllHooks`。利用者のプラグインが読まれる） | 付け直しは通った。**2 回目の `initialize` で送り直した append と `skills` は CLI が使わない**（append を変えても最初の値のまま、`skills: []` にしても skill の数は同じ。`snapshot: false` でも同じ）。hooks は付け直される（`hooks_applied: true`）【確認】 | **付け直せる**（新しい版の指示は次のターン＝次の CLI から効く） |
| 互換の接続先（`claudeCompatEnv` + フラグ設定のファイル） | 付け直しは通り、後の要求も同じ接続先へ行った。**フラグ設定のファイルを付け直しの間に消しても、同じ CLI の次のターンまで接続先は変わらない**（プロジェクトの設定を書き直しても同じ）。対照: フラグ設定を渡さないとプロジェクトの `settings.local.json` の接続先が勝つ【確認】 | **付け直せる**（ファイルは CLI の起動のときだけ読まれる） |
| npm で入れた `claude` | 今の npm の包み（2.1.110 は `cli.js`、2.1.120 からはネイティブ。間の版は見ていない）は**ネイティブの `bin/claude.exe`** で、`claude.cmd` はそれを起こすだけ。Pleiad は `claude.cmd` を渡し、SDK はそれをそのまま `spawnClaudeCodeProcess` の `command` に渡す。保持役が cmd.exe 経由で起こすと、承認待ちの付け直しは通った（新しい親が起きてから 12 ms で同じ `requestId`）【確認】 | **付け直せる**（保持役は `.cmd` を包みの `bin/claude.exe` に解いて直に起こす）。`pleiad-node.exe` で `cli.js` を走らせる形は 2.1.120 より前だけで、付け直しの下限（2.1.268）より古いので**載せない** |
| 数 MB の出力（保持役を介す） | 下の表。5 MB で +0.1〜0.3 秒、20 MB で約 2 倍。保持役のメモリが記録の分だけ膨らむ（20 MB で 190〜460 MB）。途中で付け直しても取りこぼし 0・重複 0【確認】 | **付け直せる**（記録の上限と、行を包み直さない形にする） |
| CLI の子の stdio MCP（`mcpServers` の stdio・利用者の設定の MCP） | 付け直しの後も同じプロセス・同じ状態（`counter` が 1 → 2、pid 同じ）。呼び出しの最中（`slow` 15 秒）に付け直しても、結果が新しい親に届いた【確認】 | **付け直せる** |
| Pleiad のサーバーが起こす外部の stdio MCP（`context-bridge.mjs`。R15） | 下の「R15」。起こし直すと状態は消える（起動 + `initialize` + `tools/list` は素の Node の MCP で約 0.18〜0.2 秒）。保持役の子にすると、TS の MCP SDK のサーバーは 2 回目以降の `initialize` を受け、状態も残った。ただし**旧いクライアントの JSON-RPC の id への応答が、新しいクライアントの同じ id にぶつかった**【確認】 | 段階 2 は**引き継ぎの前に処理中の呼び出しを待つ + 起こし直す**。状態を持つ MCP を保つのは段階 3（保持役の子・世代つきの id） |

### 数 MB の出力（`bigout`。偽の接続先・`includePartialMessages` あり）

本文の大きさごとに、CLI の起動から `result` が親に届くまで（ms）。各 3 回（1 MB は 1 回）。stdout はほぼ本文の 3 倍（delta の `stream_event`・`assistant`・`result` がそれぞれ全文を運ぶ）。

| 本文 | 素の起動（SDK が起こす） | 保持役を介す | 保持役の RSS |
|---|---|---|---|
| 1 MB | 1,022 | 971 | 76 MB |
| 5 MB | 1,150〜1,344 | 1,356〜1,428 | 97〜140 MB |
| 20 MB | 1,836〜2,165 | 3,833〜4,137 | 190〜458 MB |

- 保持役は空のとき 62 MB。記録（全部の行）を持ち、行を JSON で包み直してパイプへ送るため、大きいほど遅く・重くなる【確認】
- 5 MB のターンの途中（`stream_event` 300 個目・1,500 個目）で親を捨てて付け直すと、CLI はその間に終わっていて、保持役に溜まった 499〜1,696 行が約 0.25〜0.27 秒で新しい親に流れ、取りこぼし 0・重複 0 だった【確認】

### R15: Pleiad のサーバーが起こす外部の stdio MCP

`context-bridge.mjs` は、MCP を Pleiad がそろえる会話で、利用者の設定の MCP をターンの初めに**サーバーの直の子**として起こし（`StdioClientTransport`）、`ply_context` の HTTP の口から CLI に見せる。ツールの名前は `m_<hash(item.id, tool.name)>` で、起こし直しても同じ名前になる。

- **起こし直す**: 素の Node の MCP（`probe-mcp.mjs`）で、起動 + `initialize` + `tools/list` が 180〜195 ms（温まった後）。`npx` で起こすものは数秒かかる【推測】。状態（`node_repl` の変数など）は消える
- **保持役の子にする**: 保持役に起こさせ、MCP の Client を保持役のパイプ越しにつないだ。最初のクライアントを捨てて新しい Client を付けると、TS の MCP SDK のサーバーは 2 回目・3 回目・4 回目の `initialize` に答え、`counter` は 3・4・5 と続いた（状態が残る）。`initialize` を送らずに `tools/call` だけ送っても答えた【確認】
- ただし **`slow` の最中に付け直すと、旧いクライアントの id 1 への応答（`SLOW_DONE`）が、新しいクライアントの id 1（`counter`）と同じ id で届いた**。順序が逆なら新しいクライアントが別の呼び出しの結果を受け取る。保持役の子にするなら、サーバーの側で id を世代つきの文字列にし、古い世代の応答を捨てる（Codex の段階 3 と同じ）【確認：衝突まで】
- Python など TS 以外の MCP の 2 回目の `initialize` は試していない【未確認】

## 注意（付け直しの台で分かったこと）

- **ack は uuid の無い制御の行も数える**。この台は「アプリが処理した uuid を持つ最後の行の次」から流し直したので、旧い親が**答え済み**の `hook_callback`（uuid が無い）まで新しい親に流れ、SDK が `PreCompact` のコールバックをもう一度走らせた（害は無かったが、Pleiad の `PreCompact` は `compaction` の始まりを出すので 2 回出る）。保持役の再生は、親が `control_response` を返した `control_request` を流し直さない（または新しいサーバーが `request_id` で捨てる）【確認】
- **`PreCompact` の最中に付け直すと、そのコールバックの結果は使われない**（CLI が取り消す）。Pleiad の `compaction` の始まりの通知が旧サーバーで出ていなければ欠けるので、再生の `system/status`（圧縮中）から組み立てる【推測】
- **付け直した直後の `background_tasks_changed` は全量**なので、`claude-background.mjs` の「生きている裏の作業」は付け直しで置き換えられる。`toolTasks`（委譲ツールの tool_use id → task_id。`task_started` から）は、ターンの印からの再生が要る【確認：全量が出ること／推測：組み立て】
- `haiku` は、指示しないと `Agent` を裏で起こした（`run_in_background` の既定かモデルの選択）。測る場面の指示では前面・裏を明示した

## 段階 2 の計画（2a〜2e）に響くこと

1. **2a（保持役）**: 控えの渡し直しは **`mcp_message` と `elicitation`**（`can_use_tool` は `pending_permission_requests`、`hook_callback` は CLI が自分で取り消すので要らない）。再生では答え済みの `control_request` を流し直さない。記録の上限（`truncated`）は必須で、ack と印より前は捨てる（20 MB のターンで 460 MB）。行は JSON で包み直さずに送る形（長さを前に付けた生の行など）にすると速い。`.cmd` は包みの `bin/claude.exe` に解いて直に起こす（cmd.exe を木に挟まない）
2. **2b（始めると動かすを分ける）**: 裏の作業の一覧は付け直し直後の `background_tasks_changed` で置き換える。圧縮中の表示は再生の `system/status` から作る
3. **2c（Claude を載せる）**: 札に入れるもの = `pendingSteers`（uuid・outbox の id・本文・`sawResult`。新しいサーバーが `cancelQueued` で取り消せる）・`claude-background.mjs` の追跡・費用の基準・フラグ設定のファイルのパス。**systemPrompt・skills は札に要らない**（CLI が 2 回目の `initialize` の値を使わない）。hooks・in-process の MCP は今までどおり同じ形で渡す。フラグ設定のファイルは CLI が起動のときだけ読むので、引き継ぎの間に消えても走っている CLI は困らないが、旧サーバーは `detach` の後に消さず、新しいサーバーの起動時の掃除（`sweepClaudeFlagSettings`）は札が指すファイルを外す（同じ会話の CLI を起こし直すときに要る）。付け直しに使える CLI の版の一覧に、2.1.284（ネイティブ・npm）でこの表の場面を確かめたことを足す
4. **2d（引き継ぎ）**: 待つのは、段階 0 の hooks のコールバック（`PreToolUse` など。`PreCompact` は待たなくてよい）と `mcp_message` のハンドラー、HTTP の MCP の処理中の呼び出しに加えて、**外部の stdio MCP の処理中の呼び出し**（上限つき）。サブエージェント・裏の作業・途中送信・圧縮・承認待ちは待たずに引き継げる
5. **2e（落ちたときの付け直し）**: 変わらない
6. **R15**: 段階 2 は「起こし直す」。新しいサーバーは札の束縛から `ply_context` の口を戻し、外部の stdio MCP をそのターンのために起こし直す（ツールの名前は変わらない）。起こし直した後の最初の呼び出しの結果に、更新で起こし直して前の状態が残っていないことを添える。状態を保つ「保持役の子」は、保持役の `jsonrpc` の方針と世代つきの id が揃う段階 3 で足す（測って実現できると分かった）

## 未確認

- Python など TS 以外の MCP のサーバーが、2 回目の `initialize` に答えるか
- `request_user_dialog`・`oauth_token_refresh` の最中の付け直し（Pleiad の形では起きず、起こし方も見つからなかった）
- `PreCompact` 以外の hooks（`PostCompact`・`SubagentStop` など）の最中の付け直し。`PreToolUse`（段階 0）と `PreCompact`（今回）は CLI が自分で取り消した
- 委譲の子（Pleiad の `ply_delegate` で作る別の会話）が走っている間の付け直し（親の CLI から見ると HTTP の MCP の呼び出しで、子は別のターン）
- macOS（対象外）
