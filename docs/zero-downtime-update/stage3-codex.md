# 無停止の更新 段階 3 の Codex: 測定（3-0）と実装のメモ

[plan.md](plan.md)「段階 3」の Codex の項目。段階 0 の測定（[stage0-codex-agy.md](stage0-codex-agy.md)）の未確認を先に測り、そのうえで共有の `codex app-server` を保持役の子に載せた。

- 印は stage0-*.md と同じ: **確認** = 動かして確かめた。**推測** = 動かしていない見込み
- 測った版: `codex-cli 0.160.0`、Node v24.14.0、Windows 11（x64）
- スクリプトは `scripts/zero-downtime/codex/`（`node <script>`。`npm install` 済みの worktree で流す）。偽のモデル提供元 `mock-model.mjs` に `SPAWN:<依頼文>`（サブエージェントを 1 本起こす。親は `SPAWN_PARENT_SLOW` 秒、既定 6 秒、本文を流し続ける）と `BGTERM`（裏の端末を 1 本起こす）を足した。保持役の身代わりは段階 0 と同じ `holder-sim.mjs`

## 3-0 の結論

| 項目 | 結論 |
|---|---|
| a. サブエージェントが走っている最中の付け直し | **続く**。B は `initialize` も `thread/resume` も送らずに、親・子の通知を欠けも重なりもなく受け取れた。子の承認も B が答えて親子とも終わる。親子は通知（`collabAgentToolCall(spawnAgent)` の `receiverThreadIds`）で分かり、子の `thread/started` は出ない（0.160.0）。引き直しは `thread/read`（`parentThreadId`・`agentNickname`）と `thread/list { parentThreadId }` で通る |
| b. 承認を数分待たせた付け直し | **続く**。承認の依頼を 240 秒（10 秒後と 120 秒後に A → B → C と入れ替え）答えずに待たせても、app-server は打ち切らず、`turn` は `inProgress`・スレッドは `active { activeFlags: ["waitingOnApproval"] }` のまま。240 秒後に C から元の id で答えると、コマンドが走り、ターンは `completed` |
| c. 裏の端末が走っている最中の付け直し | **端末は生き残り、一覧から引き直せる**。要素の形が分かった（下）。出力の通知（`item/commandExecution/outputDelta`）は、ターンが終わった後も付け直した B に流れ続ける。B から `thread/backgroundTerminals/terminate` すると `item/completed`（元のターンの `turnId`。`status: failed`）が遅れて届く |
| d. 本物のモデルでの付け直し | **続く**。`gpt-6.1-sol`（effort low）で、本文の流れの最中・承認の最中の入れ替えが通った。差分の合計は最終の本文と一致（欠けも重なりもない） |

設計への影響（plan.md「段階 3」の Codex に反映した）:

- **子の親子の引き直し**: 子の `thread/started` は出ないので、親子は再生（印から ack まで）の通知から学べる。印より前に生まれて走っている子（前のターンで生んだ長い子）は、付け直しで `thread/list { parentThreadId }` から引き直す
- **裏の端末は札に要らない**: `thread/backgroundTerminals/list` の要素は `{ itemId, processId, command, cwd, osPid, cpuPercent, rssKb }`。付け直した側が、読み込み済みのスレッド（`thread/loaded/list`）ごとに一覧を引いて、追跡器（`codex-background.mjs`）を作り直せば足りる（出力の末尾だけは付け直した後の分から）
- **承認の依頼の id は整数（0 から）**: 本物の codex が付ける。保持役の控えの鍵は `JSON.stringify(id)`（`0` も控える）。新しいサーバーの依頼の id は世代つきの文字列にして、数値の id とぶつからないようにする

## 3-0 a. サブエージェント（`80-subagent-swap.mjs`）

`node 80-subagent-swap.mjs <running|approval>`。親のターンが `SPAWN:` で子を 1 本起こす。

- **running**（子は 10 秒、親は 8 秒、本文を流す）。子が生まれて 1 秒後に A を外し、3 秒おいて B を付ける。
  - B の `thread/loaded/list` は親と子の 2 本。`thread/read(子)` が `parentThreadId` と `agentNickname` を返す。`thread/list { parentThreadId: 親 }` が子を返す
  - 本文の差分の数（A + B）: 親 3 + 13 = 16・子 3 + 17 = 20（どちらも期待どおり。重なりも欠けも無い）。B は子・親の `turn/completed` を受け、親へ次のターンを始められた
- **approval**（子が `SHELL` で承認を求めている最中に入れ替える）。承認の依頼の `threadId` は子（id は整数 `0`）。この身代わりの保持役は控えを持たないので、A が見た依頼を B へ渡し直して `accept` を返すと、子の `turn/completed`・親の `turn/completed` が続き、親の次のターンも通った
- 0.160.0 は子の `thread/started` を出さない（親の通知は出る）。`item/started(collabAgentToolCall)` の `receiverThreadIds` が子の id を運ぶ

## 3-0 b. 承認を数分待たせる（`81-approval-long-wait.mjs`）

`node 81-approval-long-wait.mjs 240`。承認の依頼が来てから、誰も答えないまま A を外し、+10 秒で B・+120 秒で C を付けて待ち、+240 秒に C が元の id（`0`）で答える。

- 待っている間、保持役の記録に新しい行は 1 行も増えない（keep-alive の行が無い）。B・C が `thread/read` すると、ターンは `inProgress`、スレッドの状態は `{ type: "active", activeFlags: ["waitingOnApproval"] }`
- 答えた 0.3 秒後に `turn/completed`（`completed`）。コマンドは `v24.14.0` を返して `completed`
- app-server の側の承認の打ち切りは、240 秒までは無い。それ以上は未確認（入れ替えが原因で新しく起きる理由は無い）

## 3-0 c. 裏の端末（`82-bg-terminal-swap.mjs`）

`BGTERM` で、`exec_command`（`node -e "setInterval(…)"`）が 300 ms で session id を返し、プロセスは走ったままターンが終わる。

- 端末の item は `commandExecution`（`source: unifiedExecStartup`・`processId` あり）。`thread/backgroundTerminals/list` の要素: `{ itemId, processId, command, cwd, osPid, cpuPercent, rssKb }`。A を外して 3 秒後の B も同じ要素を返す
- B が付け直した後も `item/commandExecution/outputDelta` が届く（ターンは終わっているが、`threadId` は同じ）
- B の `thread/backgroundTerminals/terminate { threadId, processId }` が `{ terminated: true }`。遅れて `item/completed`（`turnId` は端末を起こしたターンのまま・`status: failed`）が届き、一覧は空になる

## 3-0 d. 本物のモデル（`83-real-model-swap.mjs`）

利用者の `CODEX_HOME`（認証つき）の `codex app-server` を、このスクリプトが別プロセスとして立てた（利用者の Codex には触れない。`-c notify=[]` で config の `notify` の外部コマンドは動かさない）。短い依頼を 2 ターンだけ（モデルは `gpt-6.1-sol`、effort low、`approvalPolicy: untrusted`、読み取り専用のサンドボックス）。

- ターン 1（1 から 40 まで 1 行ずつ出させる）: 21 個目の差分の直後に A を外し、2 秒後に B を付ける。B が `turn/completed`。A + B の差分をつなぐと最終の本文と一致（110 文字）
- ターン 2（`node --version` を 1 回走らせる）: B が承認の依頼を受けた直後に A 相当を外し、10 秒おいて C から答える。コマンドは `v24.14.0` で `completed`、ターンは `completed`、`thread/tokenUsage/updated` も届く
- 後始末: 作ったスレッド 1 本（`01a11432-a7a8-7e41-8d19-2ea8d93421c1`）を `thread/delete` で消し、`~/.codex/sessions/2026/10/07/` の rollout が無いことを確かめた（`archived_sessions` にも残っていない）。ほかのスレッドには触れていない
