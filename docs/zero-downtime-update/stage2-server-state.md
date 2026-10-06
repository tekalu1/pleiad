# 段階 2 の 2b: サーバーのメモリの仕分けと、「始める」と「動かす」の切り目

- 状態: 案（2026-10-06）。コードは変えていない。行番号は main の `e9ad556a`（段階 1 を取り込んだ後）の時点
- 正本: [plan.md](plan.md) の 2b とリスク R2・R8・R15、[design.md](design.md) §4（保持役・付け直し・札・記録の再生）・§5（引き継ぎ。§5.4 起動時の後片付けとぶつかる所）
- 目的: 2b の最初の一歩（R8 の表）。付け直すターンで「何を札に入れ、何を再生で作り、何を捨てるか」を、コードの場所つきで決める。そのうえで `runTurnInternal` の切り目と、2b を小さく取り込む段の順番を決める

---

## 0. 結論

- 表は **144 行**（§2。定数は 1 行にまとめた）。区分ごとの件数:

  | 区分 | 件数 | 意味 |
  |---|---|---|
  | 保存済み | 17 | DB・ファイルにある。新しいサーバーは読むだけ（起動時の後片付けで消さないことが要るものはある） |
  | 札 | 45 | 新しいサーバーが作り直せない値。保持役の札（子ごと）か預かり物（全体）に入れて渡す |
  | 再生 | 20 | 保持役の記録を印から読み直し、今の正規化と `makeEmit` に流すと同じ値になる |
  | 捨てる | 62 | 新しいサーバーが空から作る・取り直す・要らない。断の間に消えても困らない（困る点があれば欄に書いた） |

- **危ない所**（札に入れにくい・再生で作れないもの）の上位は §3。とくに大きいのは 3 つ:
  1. **SDK の `Query` と、それに乗る `canUseTool`・hooks のコールバック・in-process の `host` MCP**（`core/backends/claude.mjs:726`・`:789`・`:778`・`:706`）。値として渡せない。2c で同じ CLI に `query` を作り直し、2 回目の `initialize` で作り直す（実測で通る）。札に要るのは、hooks の登録（コールバックの id と中身）を前と同じにするための材料
  2. **委譲の子のターンを待っている `agentTasks` の `execute` の鎖**（`core/server.mjs:4552-4611`・`core/agent-tasks.mjs:156` の `live`）。子のターンの結果を依頼元へ届ける処理が Promise の待ちの中にあり、再生では作れない。`execute` を「始める」と「結果を待って届ける」に分け、後半を付け直しからも呼ぶ（2b-7）
  3. **途中送信の「渡った」合図の控えが 4 か所に散っている**（Claude の `pendingSteers` `claude.mjs:824`、`liveNotices` `server.mjs:4259`、`liveInstructions` `server.mjs:4263`、`agentTasks` の `steers` `agent-tasks.mjs:153`。bot の会話は `bots/dispatch.mjs:142` の `liveSteers` も）。札には入るが、全部をそろえて渡さないと通知が欠けるか二重になる
- `runTurnInternal` は「準備（`prepareTurn`）」「起動（`launchTurn`）」「出来事を受けて締める（`driveTurn`）」に分け、付け直しは `adoptTurn(card, source)` が `restoreTurn` → `backend.adoptTurn` → `driveTurn` と呼ぶ（§4）
- 起動時の後片付けで付け直すターンを外す所は **15 か所**、旧サーバーで止める所は **6 か所**（§5）
- 2b は 7 段に分ける（§6）。**2b-1〜2b-3 は保持役（2a）が無くても単独で取り込め、挙動を変えない**。2b-4 は「終わっていたターン」の付け直しで、生きた子が要らない。2b-5 以降は 2a の保持役の上で、fake のバックエンドの「途中で引き継ぐ」台本で確かめる

---

## 1. 区分と、扱いの書き方

| 区分 | 何か | 付け直しでの扱い |
|---|---|---|
| 保存済み | 会話の記録（`store` の SQLite）・`agent_tasks`・`schedule.json`・`compaction-schedule.json`・エージェントの transcript など、データ置き場か外のファイルにある | 新しいサーバーが読む。**起動時の後片付けが「落ちたターン」として消さない**こと（§5） |
| 札 | 新しいサーバーが計算し直せない値（トークン・ターンの前の切り口・渡ったか分からない送信の控えなど） | ターンを始めるときと変わったときに保持役へ置き（`label`）、付け直しで読む。全体の値（画面のトークン・ポート）は預かり物（`stash`）。**秘密は札に入れても保持役のメモリだけ**（design.md §4.2） |
| 再生 | 保持役の記録（エージェントの出力）から決まる値 | 印から ack までを `replay` で読み、正規化と `makeEmit` の「メモリだけの副作用」に流す（§4.4）。ack より後ろは普通に画面へ流す |
| 捨てる | 新しいサーバーが空から作る・main や画面から取り直す・キャッシュ | 何もしない。欠けて困る点（通知が 1 回欠ける等）は欄に書く |

「付け直すターンでの扱い」の欄の 2b・2c・2d は plan.md の項目（2b サーバーの分解・2c Claude を保持役に・2d 引き継ぎ）。2b-n は §6 の段。

---

## 2. 表

### 2.1 `runtime`（`core/server.mjs:1750-1761`）

| # | 状態 | 作る所 | 読む・書く所 | 区分 | 付け直すターンでの扱い |
|---|---|---|---|---|---|
| A1 | `runtime.sockets`（画面の WS） | 1751 | `attach` 3976・`detach` 3996・`sendTo` 1825 | 捨てる | 画面は 1.5 秒ごとのつなぎ直しで新しいサーバーに入る（design.md §8） |
| A2 | `runtime.turns`（走っているターン） | 1752 | 登録 4923・2170、外す 5245・2166、`sessionBusy` 5310・`outbox` の `active` 4273・MCP の口の `owner` 1019・1083・1120・`loadSession` 6407・`runningWork` | 再生 | 1 件ずつ `restoreTurn`（札 + 再生）で作り直す（T 表）。**起動時の後片付け・待ち受け・予定の戻しより前に登録する**（2b-4。§5 の順序） |
| A3 | `runtime.waiting`（承認待ち） | 1753 | 置く 4154、決着 4137、聞き直し 3987、`settleAll` 4023、`captureStops` 5556、`loadSession` 6452、`blockingWaits` 4013 | 再生 | Claude は 2 回目の `initialize` の `pending_permission_requests` が `canUseTool` → `askPermission` を呼び直す（2c）。**カードの id が `crypto.randomUUID()`（4124）で替わる**ので、画面・スマホの通知・通知の一覧（ADR 0149）が二重になる → id を `toolUseID`（無ければ requestId）から決まる値にする（2b-6）。中継の複製（祖先の会話）は同じ呼び直しで作られる |
| A4 | `runtime.waiting` の detached（設定の変更の承認） | 3640（`askSettingChange`） | 3632 の `settingCards`・台帳 `settingApprovals` | 保存済み | 台帳（`setting-approvals`）にある。今の起動は「取り下げ」（`setting-approvals.mjs:35-41`）にするが、引き継ぎではカードを出し直す（§5 の S11） |
| A5 | `runtime.waiting` の remote（ホストへ任せた子の承認） | 4440（`remoteCards.open`） | `remoteCards` 4431-4460 | 捨てる | ホストの線は main のもの。新しいサーバーは `remoteDelegation` の追いつき（`catchUp`）で作り直す（1-6 の申し送り 4 と同じ） |
| A6 | `runtime.buffer`（画面が居ない間の出来事） | 1754 | 溜め 1923、流す 3981 | 捨てる | 走っているターンの流れは再生で作る。**画面が居ない間に終わった別のターンの `turnEnd` が消え、PC の通知が 1 回欠けうる**（完了は保存済みの `completedAt` から一覧には出る）。R8 の「通知の重複・欠け」に数える |
| A7 | `runtime.awaySince`・`graceTimer` | 1755-1756 | `graceExpired` 1770・`restartGrace` 1775・`giveUp` 1783・`attach`・`detach` | 捨てる | 新しいサーバーは画面が居ない状態から数える（既定の猶予は 0 で打ち切らない） |
| A8 | `runtime.runningPoll` | 1757 | `syncRunningPoll` 3968 | 捨てる | `adoptTurn` の後に `syncRunningPoll()`・`broadcastRunning()` を呼ぶ |
| A9 | `runtime.background`（ターンの外の裏の作業。Codex の端末） | 1760 | `setBackground` 5470、`awaitedBackground` 5416、`findBackgroundTask` 5501 | 再生 | 段階 3（Codex を保持役へ）。段階 2 では Codex の端末は引き継ぎで止まるもの（`stoppers`。1-6 の Z）のまま |

### 2.2 ターン（`runtime.turns` の 1 件。`core/server.mjs:4868-4916` と後から足す欄）

| # | 欄 | 作る所 | 読む・書く所 | 区分 | 付け直すターンでの扱い |
|---|---|---|---|---|---|
| T1 | `stream.messages`・`presents`（ターンの前の履歴 `baseline`） | 4806・4870 | `loadSession` 6450-6459、添付の照合 5121 | 札 | 履歴は保存済みだが、付け直しの時点の履歴にはこのターンの途中の分が入っている。**札に「ターンの前の発言の数」と最後の uuid**を置き、`restoreTurn` が履歴を読んで切る（2b-2） |
| T2 | `stream.user`（このターンの人の発言） | 4871 | `loadSession` 6453 | 札 | 本文・時刻・バックエンド。内部のターン（完了通知・圧縮）は null |
| T3 | `stream.initialMessageId` | 4872 | `turnResult` の `messageId` 2116、`loadSession` 6460 | 札 | 送信待ちの項目の id |
| T4 | `stream.events`（実行中のスナップショット） | 4873 | 積む 1919、配る 6459 | 再生 | 印から ack までを画面へ出さずに積む。`streamSeq`（1917）は新しいサーバーの番号で振り直す（M15） |
| T5 | `key` | 4875・2169 | 全体（`runtime.turns` の鍵・`agentConnections` の鍵） | 札 | 会話の id。**id が決まる前（`new:<uuid>`）のターンは付け直さない**（準備中として 2d が待つ。Claude は init ですぐ決まる） |
| T6 | `ac`（AbortController） | 4876 | `abortSessions` 5594、`giveUp` 1795、`stopChild` 4565、`runArgs.signal` 5045 | 捨てる | 新しく作り、`backend.adoptTurn` の中断（Claude は新しい `query` の `interrupt`）につなぐ |
| T7 | `abortReason`・`info.stopping` | 4878・5598 | `endTurn` 5189、`turnResult` 2124 | 札 | 止め始めていたターンは、理由を渡して新しいサーバーで中断をもう一度送る（2b-6） |
| T8 | `startedAtMs` | 4879 | `turnStartedAt` 4976・2181、通知 5277 | 保存済み | 会話の `turnStartedAt` と同じ値。札にも写す（`recoverInterruptedTurns` の除外の照合に使う） |
| T9 | `userSentAt` | 4880 | （読む所が無い） | 捨てる | 使われていない |
| T10 | `backend` | 4881 | 全体 | 札 | バックエンドの id → `getBackend`。付け直す側の版にそのバックエンドが無ければ、そのターンだけ中断（design.md §6） |
| T11 | `agentLocale` | 4882 | 口の言語 1016・承認の言語 4096 | 保存済み | 会話の `agentLocale` |
| T12 | `control`（`handle`・`steer`・`steerConfirms`・`onReady`） | 4883 | バックエンドが埋める（`claude.mjs:795`・`:828-840`）、`outbox` の `active` 4278、`steerNotice` 4361、`setModelLive` | 捨てる | `backend.adoptTurn` が作り直す（2c: 新しい `query`）。`onReady` は同じ関数を作る |
| T13 | `outcome` | 4887・2117 | `endTurn` 5183-5188 | 再生 | `turnResult` の出来事 |
| T14 | `compactTrigger` | 4888 | 2049・2115・5276・5282 | 札 | 圧縮のターンか（`hooks.compact`） |
| T15 | `compactionRevision` | 4729・2164 | `endTurn` の予約 5289 | 捨てる | 予約の版は `compactionScheduler` のメモリの値。付け直しで今の `revision(id)` を取り直す |
| T16 | `userInitiated` | 4890 | 内蔵ブラウザーの鍵 5050（準備だけ） | 捨てる | 準備でしか使わない |
| T17 | `compaction` | 4891・2060 | `endTurn` 5282、圧縮の失敗 5104 | 再生 | `compaction` の出来事。記録への書き込み（2064）は再生で走らせない（§4.4） |
| T18 | `compactionWrite` | 4892・2064 | `endTurn` 5209 | 捨てる | 書き込みの鎖。旧サーバーは `flushNow` の前に待つ（2d） |
| T19 | `contextWindow` | 4893・2040 | `endTurn` 5210・5288、`loadSession` 6438 | 再生 | `contextWindow` の出来事 |
| T20 | `contextRecord`（コンテキストの記録） | 4836 | `saveContext` 4966、hooks の漏れ 2084、圧縮 2053 | 保存済み | 会話の `contextSession`（`changed` のたびに保存。5006）。hooks の漏れの行（2084）は再生でまた積まれるので、印より前の分と突き合わせて重ねない |
| T21 | `taskHints`（サブエージェントの依頼文） | 4895・2208 | `runningWork` 3589・3886 | 再生 | `tool.start` の出来事 |
| T22 | `pastSubagents`（前のターンまでのサブエージェント） | 4809 | `runningWork` 3878 | 札 | CLI を起こす前の一覧。後から取るとこのターンで生まれた分まで入る（4808 の注記）。id の配列 |
| T23 | `subagentOrigins` | 4897 | `subagentOrigin` 2324 | 捨てる | バックエンドに聞き直せる |
| T24 | `presentKey` | 4898 | 使用量の記録の id 5199、present の `turnKey` 2217・4938、computer use のロックの持ち主 5266・1088 | 札 | **使用量の記録は id で 1 回だけ**（`usage.mjs:166`）なので、同じ値を渡せば旧と新の二重記録が起きない |
| T25 | `presentWrites` | 4899・2218 | 添付の照合 5118 | 捨てる | 旧サーバーは書き終えてから手を離す（2d） |
| T26 | `info.sessionId`・`backend`・`startedAt`・`cwd`・`mode`・`model`・`effort`・`endpoint`・`account` | 4900-4909 | 一覧・`runningWork`・`limit` 2120・`setup` 2179 | 保存済み | 会話の記録（`setMeta`・`setMode`・`setModel`・`setSessionData`）。実行中の切り替え（`setModeLive`）も記録される |
| T27 | `info.status`・`info.attachments`（新規の会話の予約・添付） | 4910-4911 | id 決定時 2176-2195、添付の照合 5117 | 札 | 添付は終わりの照合（5117-5127）に要る。状態の予約は id が決まった後は要らない |
| T28 | `info.phase` | 4913・2151 | `outbox` の `active` 4281、裏の待ち 5435 | 再生 | `phase` の出来事 |
| T29 | `info.background` | 4914・2152 | `captureStops` 5555、`stopChildBackground` 5445、`findBackgroundTask` 5506 | 再生 | `background` の出来事 |
| T30 | `stops`（止めた瞬間に抱えていたもの） | 4919・1790 | `endTurn` 5232 | 捨てる | 止めた瞬間に取る値。付け直した後に止めれば新しいサーバーで取れる。止め始めた後の引き継ぎは T7 と同じに中断を送り直す |
| T31 | `worktreeId` | 4928 | 台帳の `sessionId` 4929・2198 | 保存済み | worktree の台帳（`worktreeHost`）。付け直しで `byPath(cwd)` から引き直す |
| T32 | `gitCalls` | 4930 | 追う 2033、終わりの要約 5161 | 再生 | `tool.start` などの出来事から |
| T33 | `gitSetup`・`git`・`gitLate`（始まりの撮影） | 5090-5098 | 終わりの撮影 5159-5164、id 決定 2172 | 札 | 撮影の結果（`gitActivity.begin` の戻り値。隠し ref の名前など小さな値）と「撮れなかった」の印。終わりの `gitActivity.finish` に要る |
| T34 | `visualizations`（表示の参照の集め） | 4932 | `accept` 2223、`close` 5112・5149 | 再生 | 作り直して、再生の出来事を `accept` に流す。書き込み（`publish` 4934）は ack より後ろの分だけ |
| T35 | `browserRelayId` | 5071・2163 | 承認の照合 4209 | 札 | 内蔵ブラウザーの中継の鍵（= 会話の id か仮キー） |
| T36 | `setup`（id 決定時の書き込み） | 2177 | 口の `owner` 1021・1085・1121、`endTurn` 5208 | 捨てる | 付け直したターンでは解決済みの Promise を置く |
| T37 | `usage` | 2036 | `endTurn` 5199 | 再生 | `usage` の出来事。Claude は result ごとに「累計 − `costBase`」なので、`costBase` が札（O3） |
| T38 | `limit` | 2119 | `endTurn` 5189 | 再生 | `turnResult` の `limited` |
| T39 | `errorShown`・`failureReason` | 2126-2131 | catch 5135・`endTurn` 5201 | 再生 | `turnResult` の出来事 |
| T40 | `hookRuns` | 2076・2087 | `endTurn` 5211-5214、hooks の発火の一覧 3301 | 再生 | `hookRun` の出来事（印から） |
| T41 | `lastUuid` | 2113 | 完了の知らせ 5277 | 再生 | `text.end` の出来事 |
| T42 | `steeredAttachments`（途中送信で渡した添付） | 4297 | 終わりの照合 5117-5122 | 札 | 途中送信の項目の id と本文 |

### 2.3 `runTurnInternal` の局所（閉包。`core/server.mjs:4721-5176`）

| # | 値 | 作る所 | 読む所 | 区分 | 付け直すターンでの扱い |
|---|---|---|---|---|---|
| L1 | `args.prompt`・`messageId`・`at`・`scheduledFor`・`sentBy` | 引数 | 添付の照合 5122、`undelivered` 5141・発言 4986 | 札 | 本文は照合に要る。`messageId` は T3 |
| L2 | `hooks.internal`・`hooks.compact` | 引数 | 4993・5101・5104 | 札 | T14 と同じ札の欄 |
| L3 | `hooks.signal`（委譲の `execute` の中断）と `abortFromTask` | 4573・4921 | 5167 | 札 | 札にはタスクの id だけ（O15 と同じ欄）。中断の口そのものは `agentTasks` の `execute` が持つので、付け直しで `execute` の後半を付け直す（2b-7。§3 の 2） |
| L4 | `didStart`・`backendInvoked` | 4943・5100 | catch 5141・5144、finally 5148・5159・5166 | 捨てる | **付け直すのは `backendInvoked` のターンだけ**なので、どちらも真で作る。それより前のターンは 2d が待つ（準備中） |
| L5 | `runtimeContext`（ply_context の口と外部 MCP） | 5003 | 終わりで閉じる 5153 | 札 | トークンと束縛は札（O12）。**外部の stdio MCP の子は旧サーバーと一緒に止まる**（R15。§3 の 4） |
| L6 | `initialDelivered`・`interruptionTaken`・`shellHanded`（渡った合図の印） | 4944・4946・4952 | `onPromptDelivered` 4953-4965 | 札 | 3 つの真偽値。渡る前（Claude で `initialize` の直後）に引き継ぐと、新しいサーバーが合図を受けて `takeStops`・`shellRuns.delivered`・`userMessage.delivered` を行う |
| L7 | `interruption`（中断で止めたものを伝える文の `keys`・`dropped`） | 4984 | 4956 | 札 | L6 と組。文そのものは要らない |
| L8 | `shellHandoff`（渡す `!` の行の `ids`・`skipped`） | 4950 | 4960・finally 5147 | 札 | `shellRuns` の `claims`（O24）と組 |
| L9 | `saveContext` | 4966 | 5001・5080・5134・5154 | 捨てる | 同じ関数を作る |
| L10 | `hooksTurn`（Pleiad がそろえる hooks の登録） | 4850 | `runArgs.hooksRuntime` 5061 | 札 | 記録は `contextRecord.hooks`（保存済み）。**Claude は 2 回目の `initialize` で hooks の id を送り直すので、前と同じ登録（コールバックの id と中身）を作れる材料が要る**（2c。§3 の 1） |
| L11 | `account`（OAuth のトークン） | 4751 | `runArgs.oauthToken` 5065 | 捨てる | CLI は起動時の env で持っている。付け直しで要るのは伏せ字（`claude.mjs:721`）だけで、`claudeAccounts.resolve` で取り直せる（秘密は main に頼み直す。1-6 の合わせ 1） |
| L12 | `endpoint`（互換の接続先とキー） | 4747 | `runArgs.endpoint` 5067 | 捨てる | L11 と同じく `compatEndpoints.resolve` で取り直す。フラグ設定のファイルは O4 |
| L13 | `attachments`（送信と一緒の添付） | 4805 | 5013・5117 | 札 | T27 と同じ札の欄 |
| L14 | `policy`・`resolvedContext`・`plyContext`・`botExtras`・`runArgs` の組み立て | 4815-5068 | 準備だけ | 捨てる | 起動の後は使わない（`runArgs` の口は §4.3 で作り直す） |
| L15 | `switching` への登録と `runTurn` の `updateGate.enter()` | 4730・4712 | 5171・4715 | 捨てる | 準備中の印。付け直しは準備を終えたターンだけ。`updateGate` の意味は 2d で見直す |

### 2.4 `core/server.mjs` のモジュールの外の変数

ターン・付け直しに関わるものを先に、関わらないものを後に並べた。

| # | 変数 | 作る所 | 読む・書く所 | 区分 | 付け直すターンでの扱い |
|---|---|---|---|---|---|
| M1 | `switching`・`forking`・`settingsWrites` | 207-209 | `sessionBusy` 5310・`runTurnInternal` 4725-4734・切り替え 2432-2486・分岐 | 捨てる | 準備中・切り替え・分岐の最中の印。2d は空になるのを待つ |
| M2 | `agentConnections`（会話ごとの MCP の口: ply_agents・ply_computer・ply_browser・ply_control と `contextToken`） | 476 | `conversationConnection` 1010-1031・1075-1127、付け替え 2167、片付け 1059 | 札 | **トークンを札へ**。新しいサーバーは同じトークンで口を開き直す（2b-3）。CLI が持つ URL（同じポート + 道）とヘッダーがそのまま通る（design.md §4.6）。ターンの外の会話の口（agy の会話の間ずっと使う `contextToken`）は段階 3 |
| M3 | `taskExecutions`（委譲の子の実行: `outcome`・`rejections`・`stopped`・`reply`・`streamed`） | 477 | 置く 4558、`makeEmit` 2132-2146、`childTarget` 4377、裏の待ち 5433-5450、外す 4610 | 札 | `rejections`・`stopped`・`reply` は札（再生では作れない）。`streamed` は再生。`execute` の後半を付け直しから呼ぶ（2b-7） |
| M4 | `liveNotices`（走っている依頼元へ途中送信で渡した完了通知の控え） | 4259 | 置く 4363、合図 2094-2100、終わり 5247-5252 | 札 | 欠けると、渡ったか分からないまま送り直されない（通知が欠ける）か二重。`agentTasks` の `notification` の値と組で渡す（2b-7） |
| M5 | `liveInstructions`（委譲の子へ途中送信で渡した追加指示の控え） | 4263 | 置く 4395、合図 2103-2106、終わり 5258-5262 | 札 | M4 と同じ。`agentTasks` の `steers`（O17）と組 |
| M6 | `limitStates` | 4266 | `outbox` の `active` 4270、`endTurn` 5225、起動 6942-6945 | 保存済み | 会話の `interrupted.reason === 'limit'` から起動で作る |
| M7 | `taskStopReasons` | 4255 | `abortSessions` 5591・5609、`stopChild` 4562 | 捨てる | 中断の最中だけの値。2d は中断の途中を待つ |
| M8 | `outboxWatchers` | 4252 | `outboxSettled` 5621-5639 | 捨てる | 再開の受け付けの待ち（WS の要求ごと） |
| M9 | `freeWaiters` | 5390 | `notifyFree` 5391・`waitFree` 5394 | 捨てる | 待つ側（`execute` 4579・圧縮の予約 5380）が付け直しで待ち直す |
| M10 | `resuming`・`autoResuming` | 5644・5801 | `resumeSession` 5657、`resumeFromLimit` 5816 | 捨てる | 受け付けの最中の印 |
| M11 | `queuedCompactions`（走っている会話に頼まれた手動の圧縮） | 5363 | 5376-5384、会話の削除 2786 | 捨てる | **人が頼んだ圧縮が 1 回欠ける**（終わりを待っている鎖ごと消える）。札にするほどではない。2d で欠けたことを会話に出すかを決める |
| M12 | `relayHops`（会話ごとの送信の連鎖の数。ADR 0104） | 3008 | `noteRelayHops` 3009、読む 3066・消す 2846 | 札 | 今は「保存しない（再起動で 0 に戻る）」。引き継ぎのたびに 0 に戻ると歯止めが緩むので、預かり物に置く（小さい） |
| M13 | `settingCards` | 3632 | 3651-3674 | 捨てる | カードは台帳（A4）から出し直す |
| M14 | `liveReads` | 1909 | `loadSession` 6408・6464、付け替え 2165・4926 | 捨てる | WS の読み出しの最中だけ |
| M15 | `streamSequence` | 1910 | 1917、`loadSession` 6459・6463 | 捨てる | サーバーごとの番号。画面は読み直しのたびに `streamCursor` を受け取る（`web/session-stream.mjs:31`） |
| M16 | `runningSeq`・`runningSent` | 3956 | `broadcastRunning` 3957-3964 | 捨てる | |
| M17 | `limitPoll`（時刻の分からない上限の確かめの間隔） | 5729 | `endTurn` 5194-5198、5862-5866 | 捨てる | 間隔の伸びが元に戻るだけ |
| M18 | `limitReleaseTimers` | 5779 | 5772-5790 | 捨てる | 起動の `recoverLimitResumes` が作り直す |
| M19 | `compactionSaveTimer`・`compactionSaveChain` | 5313-5314 | `saveCompactionSchedule` 5315 | 捨てる | 旧サーバーは書き切ってから離す（2d） |
| M20 | `TOKEN`（画面のトークン） | 204 | `ready` 6908・リモート 347・認証 1151 | 札 | 預かり物（design.md §8。段階 1 は main が env で渡す） |
| M21 | 待ち受けのポート（`PORT` と実際の `server.address().port`） | 202・6948 | `localOrigin` 1035 | 札 | 預かり物。**MCP の口の URL がこれに依る**ので、取れなければ付け直したターンの MCP が全部切れる（design.md §8 の「空きポートに移る」は付け直すターンがあるときは使えない。2d） |
| M22 | `CLI_TOKEN` | 1107 | `cliTokenOk` 1108、`control.json` 6903 | 札 | 預かり物（design.md §1・§8）。会話のシェルには会話ごとの `PLEIAD_CONTROL_TOKEN`（M2）が入るので、走っているシェルはそちらで通る |
| M23 | `readyMessage` | 6881 | 6891・6908 | 捨てる | 作り直す |
| M24 | `locale`・`compactionSettings`・`routingSettingsCache`・`plyInstructionsCache` | 179・181・885・887 | 多数 | 保存済み | 設定（prefs）から作る |
| M25 | `residentLast`・`residentStatus`・`residentWork`・`residentSeq` | 400 | `postResident` 401-413 | 捨てる | つながるたびに送り直す（1-2） |
| M26 | `remotePushed`・`remotePushTimer`・`remoteStatsSignature` | 761-762 | `remoteTasksChanged` 764-784 | 捨てる | 端末へ送り直すだけ |
| M27 | `attachPending`（取り込み中の添付） | 227 | 6688-6713 | 捨てる | 2d は取り込みを待つ |
| M28 | `placeCheckCache`・`placeCheckInflight`・`nativeLists`・`nativeListGeneration`・`lastWarm` | 1475-1476・1504-1505・892 | 一覧・作業場所の確かめ | 捨てる | キャッシュ |
| M29 | `watching`・`screencastClients`・`connectionDevices`（WS ごと） | 1817・169・369 | 送り先の選り分け | 捨てる | 画面がつなぎ直すと作り直す |
| M30 | `worktreeSweeping`・`worktreeSweepAgain` | 1854 | 1855-1860 | 捨てる | |
| M31 | `workspaceRoots`・`SERVER_STARTED_AT`・`imageImportTestOrigin` | 256・176・246 | | 捨てる | `SERVER_STARTED_AT` は新しい値でよい（画面は「この起動より前の更新の中断」だけを見る） |
| M32 | 定数（`HOST`・`NL`・`COOKIE_NAME`・`UPLOAD_DIR`・`ATTACH_*`・`PRESENT_*`・`IMAGE_MIME`・`MIME`・`EVENT_BUFFER_MAX`・`HOST_GRACE_MS`・`INTERRUPT_REASONS`・`ABORT_REASONS`・`LIST_NEUTRAL_EVENTS`・`WATCH_EXEMPT`・`OUTSIDE_TURN_EVENTS`・`LIVE_TASK`・`SUBAGENT_STATUS`・`ANSWER_EVENTS`・`GIT_*`・`DELEGATION_BACKGROUND_WAIT_MS`・`ROUTING_*`・`REMOTE_*`・`RELAYED_KEEP`・`HOOK_LEAKS_MAX`・`TASK_SETTINGS`・`NOTICE_REJECTIONS`・`REJECTION_TEXT_MAX`・`POLL_TRIAL_MISSES`・`BUSY_RETRY_MS`・`PLACE_CHECK_*`・`NATIVE_LIST_TTL_MS`・`COMPACTION_SCHEDULE_FILE`・`CONTEXT_SNAPSHOTS`・`APP_VERSION`・`BUILD`・`HERE`・`WEB`）と、関数を入れた定数（`pick`・`peerRejection`・`changeBy`・`ops*` の束・`blockingWaits` など） | 各所 | | 捨てる | 同じ版なら同じ値。違う版では新しい版の値になる（それでよい） |
| M33 | `updateGate` | 135 | `runTurn` 4712、`update-lock` 6837 | 捨てる | 2d で「準備中だけを数える」形に見直す |
| M34 | `mainLink`・`mainPort`・`mainAway`・`orphanGuard` | 154・160・163・6871 | main との口（段階 1） | 捨てる | 新しいサーバーが口を立て、main が付け直す（段階 1 の 1-4・1-6 と同じ） |
| M35 | `agentBrowser`（内蔵ブラウザーの中継の写し・鍵） | 165 | `endTurn` 5264、付け替え 2163、承認 4206-4216 | 捨てる | main が `ready` で `browser-state-report` を送り直す（1-6 の合わせ 1）。`configIds`（`agent-browser.mjs:65`。新しい会話の設定ファイルの名前）は札（O20） |
| M36 | `screencastBridge`・`screencastHub` | 167-168 | | 捨てる | 見ている端末へ `ended` |
| M37 | `computerDriver`・`computerLock`・`computerBridge` | 4221・4225・4231 | `endTurn` 5266、`computerRuntimeFor` 1130 | 捨てる | ロックは引き継がない。**旧サーバーが手を離す前に `stopAll('update')`（Esc と同じ）** を行い、付け直したターンの次の呼び出しは承認からやり直す（1-5 の居ない間と同じ扱い。2d） |
| M38 | `agentTasks`（`createAgentTasks`） | 4466 | 多数 | 保存済み | 行は SQLite。メモリの部分は O15-O18 |
| M39 | `outbox`（`createMessageQueue`） | 4267 | 多数 | 保存済み | 項目は会話の `outbox`。メモリの部分は O13 |
| M40 | `completionNotices` | 1878 | `endTurn` 5276、`attach` 3982 | 捨てる | 完了の知らせのまとめ（O19）。欠けると 1 回の知らせが欠ける |
| M41 | `shellRuns` | 1838 | `!` の行 | 捨てる | 段階 3。走っている `!` の行は引き継ぎで止まる（stoppers） |
| M42 | `contextBridge` | 322 | `contextBridge.open` 5003 | 札 | O12 |
| M43 | `agentBridge`・`browserBridge`・`controlBridge` | 874・1096・1105 | M2 の口 | 札 | O9-O11 |
| M44 | `inbox`・`inboxSources`（通知の一覧） | 383-384 | 承認 4146・4178、起動 4309 | 保存済み | 起動の `settleAllWaiting`（4309）が付け直す承認まで決着させないこと（§5 の S6） |
| M45 | `pushNotifier`・`notifyPresence` | 370・367 | 承認 4184、完了 1892 | 捨てる | 承認の id を決まった値にすれば（A3）、スマホの通知も重ならない |
| M46 | `settingApprovals` | 4664 | A4 | 保存済み | 台帳のファイル |
| M47 | `schedule`・`compactionScheduler` | 5848・5347 | | 保存済み | `schedule.json`・`compaction-schedule.json`。`revision` だけはメモリ（T15） |
| M48 | `botHost`（bot の会話。中は O21） | 4687 | `makeEmit` 2038、`endTurn` 5280、承認 4147 | 札 | O21 |
| M49 | `worktreeHost`・`gitActivity` | 1842・1840 | | 保存済み | 台帳と隠し ref。片付けの判定が `runtime.turns` を見る（§5 の S12） |
| M50 | `remote`・`remoteAgentPort`・`remoteDelegation` | 347・326・4462 | | 捨てる | 中継の鍵は保存済み。線は新しいサーバーが張り直す・追いつく |
| M51 | `secretCipher`・`mcpSecrets`・`claudeAccountSecrets`・`compatSecrets` | 260-300 | | 捨てる | 復号した値の組は main に頼み直す（1-6 の合わせ 1） |
| M52 | `voiceHost`・`claudeLogin`・`mcpOAuth`・`imageImporter`・`folderUploads`・`attachUploads` | 305・276・316・247・230・226 | | 捨てる | 通話は切れる。ログインの疑似端末・OAuth の流れ・取り込みは 2d で待つか取り消す（design.md §4.4「載せないもの」） |
| M53 | そのほかの部品（`usageStore`・`quotaCache`・`contextSettings`・`plyMcp`・`claudeAccounts`・`compatEndpoints`・`notifySettings`・`residentPrefs`・`contextSession`・`mcpConfig`・`hooksConfig`・`plyHooks`・`routingUsage`・`opsHttp`・`sessionSearch`・`computerShots`・`agentScanLock`・`server`・`wss`） | 各所 | | 保存済み | 中身はデータ置き場から読む・キャッシュ。付け直しに関わる値は持たない |

### 2.5 ほかのモジュールのメモリ（ターンの間に持つもの）

| # | 状態 | 作る所 | 読む・書く所 | 区分 | 付け直すターンでの扱い |
|---|---|---|---|---|---|
| O1 | Claude の `q`（SDK の `Query`）と `liveQueries`・`control.handle` | `claude.mjs:726`・`:586` | `:795`・`:799`・`:942`（`interrupt`）・`:1058`（`close`）・`stopBackground` `:1074` | 捨てる | 値として渡せない。2c で同じ CLI に新しい `query` を作る（`spawnClaudeCodeProcess` が保持役の子につないだ偽物を返す）。**旧サーバーは保持役に `detach` してから `close()`**（design.md §4.4） |
| O2 | Claude の `canUseTool`・hooks のコールバック・in-process の `host` MCP（`plyServers.host`） | `claude.mjs:789`・`:778-788`・`:706` | SDK の中 | 捨てる | 2 回目の `initialize` で作り直す（実測で通る）。hooks の登録は L10 の札から同じものを作る。呼び出しの最中の分は 2d が待つ（design.md §4.4） |
| O3 | Claude の `costBase`（ターンの始まりの費用の累計） | `claude.mjs:723`（`readCostBase` `:562-580`） | 正規化 `claude-normalize.mjs:212-215` | 札 | transcript から読めるが、CLI が query の終わりに新しい値を書くと読み直しでずれる。始まりの値を札に置く（2c） |
| O4 | Claude のフラグ設定のファイル（`flag`。互換の接続先のキーを含む） | `claude.mjs:720` | 終わりで消す `:1054` | 札 | ファイルのパスを札に。旧サーバーの `finally` で消さないこと（§5 の旧サーバー側 X3）。新しいサーバーがターンの終わりに消す。起動の掃除（`server.mjs:315`）は 24 時間より古いものだけ |
| O5 | Claude の `pendingSteers`（流し込んだが、まだ折り込まれていない途中送信） | `claude.mjs:824` | `:835`・`:843-898`・`:927-935` | 札 | 送信待ちの項目の id と CLI の uuid の組。CLI の `isReplay` の行から作り直せる場合もあるが、確かめていない（2-0 の測定）。札に置く（2c） |
| O6 | Claude の `tracker`（main と裏の作業の状態。`claude-background.mjs:92-104` の `mainActive`・`seenResult`・`bg`・`known`・`states`・`toolTasks`）と `turnTrackers` | `claude.mjs:663`・`:592` | `:800`・`:836`・`:1026`・`getSubagentState` `:1146` | 再生 | `task_*`・`background_tasks_changed`・ツールの結果の行から作る。`pending`（`claude-background.mjs:97`）は O5 と組 |
| O7 | Claude の `toldModel`・`heldResult`・`limit`・`sawMessage`・`computerIds`・`compactDiagnostic` | `claude.mjs:958-962`・`:653`・`:719` | `:983-1031` | 再生 | 印から流す |
| O8 | Claude の `input`（stdin の列）・`hostCalls`・`closer`・`sdkAbort`・`stop` | `claude.mjs:664`・`:686`・`:688`・`:702`・`:911` | | 捨てる | 新しい `query` が作る。走っている `host` の呼び出しは 2d が待つ |
| O9 | ply_agents の `bindings`（トークン → 持ち主・言語） | `agent-bridge.mjs:37` | `open` `:40-43` | 札 | トークンを札に。`open({ token })` で同じトークンを受ける形にする（2b-3。実装済み） |
| O10 | ply_computer の `bindings`（トークン → 持ち主・配り方・`shot`・`known`・`turns`） | `computer-bridge.mjs:47` | `open` `:116-127` | 札 | トークンは札。`shot`・`known`（写した画面・知っているアプリ）は捨てる（承認からやり直す。M37） |
| O11 | ply_browser・ply_control の `bindings` | `browser-bridge.mjs:16`・`mcp-bridge.mjs:17` | `open`・`lookup` `mcp-bridge.mjs:61-68` | 札 | O9 と同じ。ply_control のトークンは会話のシェルの `PLEIAD_CONTROL_TOKEN`（`server.mjs:1126`）にも入っている |
| O12 | ply_context の `bindings`（トークン・`clients`・`tools`・`pending`・`report`） | `context-bridge.mjs:77`・`:85-86` | `open` `:85-134`、`close` `:87-94` | 札 | トークンと束縛は札。道具の名前は `m_<hash>` で決まる（`:113`）ので開き直せば同じ。**`clients`（外部の stdio MCP の子・SSE/HTTP の接続）と処理中の `pending` は失われる**（R15） |
| O13 | `outbox` の `locks`・`waits` | `message-queue.mjs:5`・`:16` | `kick` `:37-93`、`busy` `:119` | 捨てる | 送信の直列化と待ちの理由。`kick` が作り直す |
| O14 | `agentTasks` の `records`・`bySession` | `agent-tasks.mjs:118-121` | | 保存済み | `agent_tasks` の表 |
| O15 | `agentTasks` の `live`（走っている `run()` の AbortController）と `execute` の待ち | `agent-tasks.mjs:156`（置く `:591`） | `cancelOwner` `:915-945`、`server.mjs:4552-4611` | 札 | **Promise の鎖そのものは渡せない**。札にはタスクの id だけ置き、付け直しで「子のターンの終わりを待って結果を届ける」後半を始め直す（2b-7。§3 の 2） |
| O16 | `agentTasks` の `steers`・`instructionSends`・`deferredInstructions` | `agent-tasks.mjs:153-155` | `unclaim` `:296`、`resolveClaim` `:318`、`settleSteers` `:680-686` | 札 | M5 と組。起動の復元は `sending` を `delivered` にする（`:221`）ので、付け直すタスクは外す |
| O17 | `agentTasks` の `notices`・`waited`・`listeners`・`silence*`・`activeCommands` | `agent-tasks.mjs:156`・`:107`、`observe` `:641-650` | | 捨てる | `ply_task_wait` の HTTP の待ちは接続ごと切れる（引き継ぎの間の MCP の失敗。R11）。`activeCommands` は `task.command` の出来事で作り直す |
| O18 | `shellRuns` の `claims`（このターンに渡しかけた `!` の行） | `shell-runs.mjs:39` | `appendsFor` `:179`・`delivered` `:200`・`release` `:190` | 札 | L8 と組。走っている `runs`（`:34`）は段階 3 |
| O19 | `completionNotices` の `pending` | `completion-notices.mjs:15` | `finished`・`changed` | 捨てる | 欠けると完了の知らせが 1 回欠ける |
| O20 | `agentBrowser` の `configIds`・`relays`・`relayPort`・`tabState` | `agent-browser.mjs:65-69` | `endTurn` `:189`、`adoptRelay` `:147` | 札 | `configIds`（新しい会話の設定ファイルの名前を最初の id に固定する）は札。`relays`・`tabState` は main の `browser-state-report` で取り直す（1-6） |
| O21 | bot の会話の `active`（ターンの投稿の記録）・`liveSteers`・`starting` | `bots/dispatch.mjs:140-142` | `onTurnEvent` `:959`、`onTurnEnd`、`:675`・`:692-700`・`:837-854` | 札 | 中の形（投稿の積み上げ・渡った合図）が dispatch の内部にある。**最初は bot の会話のターンを付け直しの対象から外す**（先送りか中断。2b-4 の除外の一覧に入れる）。載せるのは後の段 |
| O22 | computer use の `turns`・`holder`・`lenders`・`queue`・`armed` と driver の `pending` | `computer-use/lock.mjs:25-29`・`driver.mjs:26` | `endTurn` `server.mjs:5266` | 捨てる | M37 |
| O23 | fake のバックエンドの `sessions`・`shells`・`terminals` | `backends/fake.mjs:58`・`:62-63` | 全部 | 捨てる | 会話をプロセスのメモリに持つ（`:7-8`）ので、サーバーをまたげない。付け直しの台本は別のプロセスの偽の CLI で走らせる（§6 の 2b-5） |
| O24 | Codex の `CodexRpc`（`pending`・`threads`・`claims`・`held`・`parents`・`agents`）と `codex.mjs` の `trackers`・`liveSubagents` | `codex-rpc.mjs:55-71`・`codex.mjs:503-508`・`:967` | | 再生 | 段階 3（design.md §4.4。親子は `thread/read` の `parentThreadId` から引き直す） |
| O25 | agy の `live`（会話ごとのプロセス）と `pids.json` | `antigravity.mjs:105`・`antigravity-pids.mjs:26` | `reap` `:80-100` | 保存済み | 段階 3。`pids.json` の `owner` を新しいサーバーに書き換えないと、後の `reap` が付け直した agy を止める |

---

## 3. 危ない所（札に入れにくい・再生で作れない）

上から重い順。

1. **Claude の SDK の `Query` と、それに乗るコールバック**（O1・O2・L10）。`canUseTool`・hooks・in-process の `host` は値として渡せない。2c の「同じ CLI に `query` を作り直す」で作り直す。難しいのは hooks: CLI は最初の `initialize` で受け取ったコールバックの id で呼んでくる。2 回目の `initialize` で SDK が id を送り直すが、**中身（どの hooks の定義を、どの順で）を前と同じに組める材料**を札に置く必要がある（`prepareHooksTurn` を今の設定で組み直すと、設定の変更で中身がずれる）。札には `hooksTurn.runtime` の組み立ての入力（記録 `contextRecord.hooks` と、それを作った設定の写し）を置く
2. **委譲の子のターンの終わりを待つ `execute`**（O15・M3・L3）。`agentTasks.run()` → `execute` → `runTurn` の await の鎖が、子の結果を依頼元へ届ける処理（4577-4609: 孫の完了・裏の作業・`lastReply`・worktree の片付け・結果の確定）を持つ。再生では作れず、札に入れられるのは `rejections`・`stopped`・`reply` だけ。`execute` を「子のターンを始める」と「子のターン（Promise）が終わるのを待って結果を作る」に分け、付け直しは後半を `agentTasks.adopt(taskId, turnPromise)` で始め直す（2b-7）。起動の復元（`agent-tasks.mjs:215-227`）がそのタスクを `interrupted` にしないことも要る
3. **途中送信の「渡った」合図の控え**（O5・M4・M5・O16・O21）。Claude の `pendingSteers`、完了通知の `liveNotices`、追加指示の `liveInstructions`、`agentTasks` の `steers`、bot の `liveSteers` の 5 つが同じ出来事（`userMessage.delivered` / `dropped`）を待っている。どれも札に入るが、**1 つでも欠けると、通知が送り直されない（欠ける）か、渡ったのに送り直される（二重）**。札の「途中送信」の欄を 1 つにまとめ、項目の id ごとに「誰が待っているか」を持つ形にする（2b-2 で形を決め、2b-7 で埋める）
4. **外部の stdio MCP の子と、処理中の呼び出し**（O12・L5。R15）。`contextBridge.open` が起こした子はサーバーの直の子で、旧サーバーと一緒に止まり、`node_repl` などの状態は戻らない。札にできるのはトークンと束縛だけ。新しいサーバーは同じトークンで ply_context を開き直し、**外部の MCP は次の呼び出しで起こし直す（状態の消失はツールのエラーで返す）**のが 2b での既定。保持役の子にするかは 2-0 の測定で決める
5. **承認のカードの id**（A3・M45）。再生（Claude の 2 回目の `initialize`）で `askPermission` が呼び直されると、`crypto.randomUUID()` の新しい id でカード・中継の複製・スマホの通知・通知の一覧の行が作られ、旧の分は起動の `settleAllWaiting`（4309）で「取り消し」になる。画面には同じ承認が消えて出直し、スマホには 2 通届く。**id を `toolUseID`（無ければ CLI の requestId）とセッションから決まる値にする**（2b-6）。中継の複製の id も同じ規則で決める
6. **ターンの前の履歴の切り口**（T1）。`turn.stream` はターンの前の履歴（`baseline`）と出来事でできていて、画面のつなぎ直しはこれを配る。付け直しの時点で履歴を読むと、このターンの途中の発言まで入る。札に「ターンの前の発言の数と最後の uuid」を置く
7. **`makeEmit` の外への書き込みを再生で二度走らせない**（§4.4 の表）。`present` の記録（2217）・id 決定時の書き込み（2177）・圧縮の記録（2064）・bot の投稿（2038）・途中送信の合図の処理（2094-2111）・委譲の台帳（2031）は、印から ack までの再生では走らせない。どれを走らせるかの判定を `makeEmit` に持たせる
8. **bot の会話のターン**（O21）。投稿の積み上げが dispatch の内部の形で、札の形を決めるには dispatch の分解が要る。最初は付け直さない
9. **待ち受けのポートが取れないとき**（M21）。MCP の口の URL はポートを含む。新しいサーバーが同じポートを取れないと、付け直したターンの MCP が全部切れる（Claude は即失敗、Codex は約 2 秒）。付け直すターンがあるときは「空きポートに移る」を使わず、取れるまで待つ（上限つき）か、そのターンを中断にする（2d）
10. **computer use のロック**（M37・O22）。引き継げない。旧サーバーが `stopAll('update')` で止め、エージェントに「止めました」を返してから手を離す

---

## 4. `runTurnInternal` の切り目

### 4.1 今の形（`core/server.mjs:4711-5176`）

| 行 | 中身 | 分けた後 |
|---|---|---|
| 4711-4716 | `runTurn`: `updateGate.enter()` で包む | `runTurn`（変えない） |
| 4722-4730 | 断る検査（`canStart`・busy・`switching`・二重実行）、`switching.add` | `runTurnInternal` に残す |
| 4733-4867 | 行き先・アカウント・接続先・設定の予約・作業場所・モデル・コンテキスト・hooks の準備と記録 | `prepareTurn` |
| 4868-4970 | ターンの組み立て・登録（`runtime.turns.set` 4923）・`emit`・`onPromptDelivered`・`saveContext` | `prepareTurn`（`registerTurn` に分けてもよい。§4.3 で付け直しが共有する） |
| 4971-4973 | `onStarted()`・`didStart` | `runTurnInternal` |
| 4974-5082 | 始まりの印・発言の出来事・中断の文・ply_context を開く・添付・`runArgs` の組み立て・指示の量 | `beginTurn` |
| 5083-5103 | `canInvoke`・git の撮影・`backend.runTurn` / `compact` | `launchTurn` |
| 5104-5130 | 結果の後処理（圧縮の失敗・requeue・表示の書き込み・送信待ちの読み切り・添付の照合） | `driveTurn` の `afterResult` |
| 5131-5144 | catch（失敗の出来事・送信待ちの失敗へ戻す） | `driveTurn` |
| 5145-5168 | finally（`!` の行の解放・送信待ちの保留・表示・ply_context を閉じる・`saveContext`・git の終わり・`endTurn`） | `driveTurn` |
| 5170-5175 | 外の finally（`switching.delete`・完了の知らせ・`notifyFree`・`kickQueued`） | `releaseTurn` |

### 4.2 分けた形

```
runTurn(args, onStarted, hooks)                     … 今のまま（updateGate）
└ runTurnInternal(args, onStarted, hooks)
    ├ 断る検査・switching.add                        … 4722-4730
    ├ ctx = await prepareTurn(args, hooks)           … 4733-4970。ctx を返す（登録まで）
    ├ return await driveTurn(ctx, async () => {      … 「動かす」。try / catch / finally と endTurn を持つ
    │     await onStarted(); ctx.didStart = true
    │     await beginTurn(ctx)                        … 4974-5082
    │     if (hooks.canInvoke && !hooks.canInvoke()) return { requeue: true, beforeInvoke: true }
    │     return launchTurn(ctx)                      … 5087-5103。backend.runTurn の Promise
    │   })
    └ finally releaseTurn(sessionId)                  … 5170-5175

adoptTurn(card, source)                              … 付け直しの入口（2b-4）
├ ctx = restoreTurn(card)                           … 札から組み立て・登録・emit（再生の間は画面へ出さない）・口を同じトークンで開き直す
├ return await driveTurn(ctx, () =>
│     ctx.backend.adoptTurn({ ...ctx.runArgs, card: card.backend, source }))
└ finally releaseTurn(card.sessionId, { adopted: true })
```

- `driveTurn(ctx, start)` が「出来事を受けて `endTurn` で締める」部分。`start()` が返す Promise は `backend.runTurn` と同じ形（`{ sessionId, requeue?, compactionFailureReason? }`）で、出来事は `ctx.emit` を通る。**付け直しも同じ `driveTurn` を通るので、締め（`endTurn`）の道は 1 本**（R2）
- `endTurn` は 1 回だけ走る印（`turn.ended`）を持つ。旧サーバーで手を離したターン（`turn.handedOff`。2d で立てる）は `driveTurn` の締めを丸ごと飛ばす（§5 の X1）
- `releaseTurn` は付け直しでも `completionNotices.changed`・`notifyFree`・`kickQueued` を呼ぶ（`switching.delete` は付け直しでは何もしない）
- `updateGate` は、付け直したターンも `enter()` する（今の `update-lock` の判定は `runtime.turns.size` を見るので変わらない）。準備中だけを数える形への見直しは 2d

### 4.3 `ctx`（ターンの文脈）に入れるもの

`driveTurn`・`afterResult`・catch・finally が閉包から読んでいた値を `ctx` に移す。付け直しでは `restoreTurn` が札から埋める。

| `ctx` の欄 | 今の閉包の値 | 付け直しでの出どころ |
|---|---|---|
| `turn`・`emit` | 4868・4931 | `restoreTurn`（T 表） |
| `sessionId`・`backend` | 4722・4735 | 札（T5・T10） |
| `args`（`prompt`・`messageId`） | 引数 | 札（L1） |
| `hooks`（`internal`・`compact`・`signal`） | 引数 | 札（L2）。`signal` は 2b-7 の `agentTasks.adopt` が渡す |
| `attachments`・`baselineLength` | 4805・4806 | 札（T27・T1） |
| `contextRecord`・`hasContext`（`resolvedContext` の有無） | 4836・4821 | 保存済み（T20）・札 |
| `runtimeContext` | 5003 | 同じトークンで開き直した ply_context（O12） |
| `shellHandoff`・`interruption`・印（`didStart`・`backendInvoked`・`initialDelivered`・`interruptionTaken`・`shellHanded`） | 4943-4952・4984・5100 | 札（L6-L8）。`didStart`・`backendInvoked` は真 |
| `saveContext`・`onPromptDelivered` | 4953・4966 | 同じ関数を作る |
| `runArgs`（`emit`・`onPromptDelivered`・`askPermission`・`hostInvoke`・`signal`・`control`・`locale`・`visualizeInstructions`・各 MCP の口・`hooksRuntime`・`agentRuntime`・`controlRuntime`） | 5023-5068 | 口は同じトークンで開き直し（2b-3）、`hooksRuntime` は札から（L10）。`oauthToken`・`endpoint` は取り直す（L11・L12）。`prompt`・`notes`・`shellAppends`・`botInstructions` は付け直しでは要らない（CLI はもう受け取っている） |

`backend.adoptTurn({ card, source, ...runArgs })` の決まり:

- `card` はバックエンドが札に置いた分（Claude なら `costBase`・`pendingSteers`・フラグ設定のパス・hooks の登録の id。fake なら台本の位置）
- `source` は保持役の子への口（`replay(from, to)`・`attach()`・`ack(seq)`）。バックエンドは `replay` の行を今の正規化に流して `emit(event, { replay: true })` で出し、終わったら `attach()` で続きを受ける。ack は「`emit` が返った（アプリのループで処理し終えた）行」で送る（design.md §4.5 の 3）
- 戻り値と出来事は `runTurn` と同じ。子が引き継ぎの間に終わっていれば（記録に `exit`）、再生の後にそのまま返る（design.md §4.5 の 4）
- 付け直せない（札の版が読めない・記録が読めない）ときは投げる。`adoptTurn` はそのターンだけ `interrupted: { reason: 'update' }` で締める（design.md §6 の表「1 つのターンだけ付け直せない」）

### 4.4 `makeEmit` の副作用を再生で走らせるか

再生（印から ack まで）の出来事は `emit(event, { replay: true })` で流す。`makeEmit`（2029-2228）の中を次のように分ける。

| 行 | 副作用 | 再生で |
|---|---|---|
| 2031 | `agentTasks.observe`（委譲の台帳の稼働の印） | 走らせる（同じ値に収まる。保存しない） |
| 2033 | `gitCalls.track` | 走らせる |
| 2036・2039-2041・2113・2117-2131・2151-2152・2208 | `usage`・`contextWindow`・`lastUuid`・`outcome`/`limit`/`errorShown`/`failureReason`・`phase`/`background`・`taskHints`（メモリだけ） | 走らせる |
| 2038 | `botHost.onTurnEvent`（bot の投稿の積み上げ） | 走らせない（bot の会話は付け直さない。O21） |
| 2042-2073 | 圧縮の状態（メモリ）と記録（2064 の書き込み） | 状態だけ。書き込みは走らせない |
| 2075-2091 | `hookRuns` の積み上げ・漏れの記録（`contextRecord.hooks.leaks`） | 積み上げは走らせる。漏れの行は印より前の記録と重ねない |
| 2094-2111 | 途中送信の合図（`liveNotices`・`liveInstructions`・`outbox.returned`） | 走らせない（札で状態を渡す。§3 の 3） |
| 2132-2147 | 委譲の実行（`taskExecutions` の `streamed`・`rejections`） | `streamed` は走らせる。`rejections` は札 |
| 2153-2156 | `watchChildBackground`・`broadcastRunning`・`outbox.kick` | 再生の終わりに 1 回ずつ |
| 2161-2199 | 新しい会話の id 決定（付け替え・`setup` の書き込み） | 走らせない（付け直すのは id が決まったターンだけ。T5） |
| 2215-2221 | `present` の記録 | 走らせない（記録済み） |
| 2223 | `visualizations.accept` | 走らせる（集めるだけ。書き込みは ack の後ろの分） |
| 2226 | `emitGlobal`（画面へ・`stream.events` へ） | `stream.events` に積むだけで、画面へは送らない（`streamSeq` は振る） |

---

## 5. 起動時の後片付けで、付け直すターンを外す所

### 5.1 新しいサーバーの起動（行は `core/server.mjs`）

**順序**: 付け直すターンを `runtime.turns` に登録する（`adoptTurn` の `restoreTurn` まで）のは、S5 より前・待ち受け（6948）より前。S13 の「ターンを始めうるもの」は登録の後でないと、付け直す会話を空いていると見て新しいターンを始める。`adoptTurn` の後半（`backend.adoptTurn` → `driveTurn`）は待ち受けの後（MCP の口と承認の画面が要る。design.md §4.6「新しいサーバーは HTTP の口を待ち受けてから」）。

| # | 場所 | 今していること | 付け直すターンでの扱い |
|---|---|---|---|
| S1 | 315 `sweepClaudeFlagSettings` | 24 時間より古い `run/claude-compat-*.json` を消す | 札にあるパス（O4）は消さない |
| S2 | `store.mjs:100` `sweepEntries`（最初の読み込み） | 記録の掃除 | 影響なし（確かめた範囲。2b-4 で `turnStartedAt` を消さないことをテストに入れる） |
| S3 | `antigravity.mjs:109` `pids.reap()`・`:111` `sweep()`（読み込み時） | `owner` が死んでいる agy を止め、作業フォルダーを消す | 段階 3。`owner` を書き換えてから |
| S4 | 4247 `computerLock.reset()`（`computer-ready`） | ロックを空にする | そのまま（ロックは引き継がない。M37） |
| S5 | 4302 `outbox.recover()`（`message-queue.mjs:140-150`） | 全会話の `sending` → `unknown`、`queued` → `paused` | 付け直す会話を外す。`sending` は札の途中送信（O5）が決める。`queued` は保留にしない（走っているターンの後ろに並んだまま） |
| S6 | 4305 `store.recoverInterruptedTurns`（`store.mjs:502-521`） | `turnStartedAt` が残る会話を `restart` の中断にし、`completedAt` を書く | 付け直す会話を外す（`except: [sessionId]` を足す）。札の `startedAtMs`（T8）と `turnStartedAt` が合うものだけ外す |
| S7 | 4309 `inbox.settleAllWaiting('cancelled')` | 通知の一覧のあなた待ちを全部決着 | 付け直すターンの承認（決まった id。A3）は外す |
| S8 | 4466 `createAgentTasks` の復元（`agent-tasks.mjs:215-227`） | 動いていたタスクを `interrupted`、`sending` の指示を `delivered`、`delivering` の通知を `unknown` | 子の会話を付け直すタスク・札に `liveNotices` があるタスクを外す（引数で渡す） |
| S9 | 4659 `recordTaskStops(agentTasks.restored, 'restart')` | 依頼元の会話の「止めたもの」に書く | S8 で外したものは `restored` に入らないので書かれない |
| S10 | 4661 `remoteDelegation.start()` | ホストの便りを聞く | そのまま |
| S11 | 4664 `createSettingApprovals`（`setting-approvals.mjs:35-41`） | 待っていた設定の変更の承認を「再起動で取り下げ」にし、送っている途中の結果を捨てる | 引き継ぎの起動ではカードを出し直す（A4）。ターンには縛られないが同じ引き継ぎで欠ける |
| S12 | 4681 `worktrees.reconcile()`・4684 `worktreeSweepSoon()` | 作成の途中の worktree を巻き戻し、使っていないものを消す（`runtime.turns`・シェル・タスクで判定） | 付け直すターンを登録した後に走らせる |
| S13 | 6941 `restoreCompactionSchedule`・6942-6945 `limitStates`・6950 `schedule.restore()`・6952 `recoverLimitResumes()`・6956 `botHost.start()`（`bots/dispatch.mjs` の `start`: `delivering` → `unknown`・作業中の印の片付け） | 予定・上限の解除後の再開・bot の出来事の配り直しでターンを始めうる | 付け直す会話が `sessionBusy` で真になってから。bot の会話は付け直さない（O21）ので、dispatch の片付けはそのまま |
| S14 | 6903 `writeControlFile` | 新しい `CLI_TOKEN` を書く | 預かり物の `CLI_TOKEN`（M22）で書く |
| S15 | 6871-6880 `orphanGuard`・`announce` の `ready` | 孤児の見張り・main への `ready` | そのまま（段階 1） |

### 5.2 旧サーバー（手を離す側。2d で配線、2b で口を作る）

| # | 場所 | 今していること | 手を離したターンでの扱い |
|---|---|---|---|
| X1 | `driveTurn` の締め（5104-5168）と `endTurn`（5182-5297） | ターンの終わりを記録する | **旧サーバーでは走らせない**（`turn.handedOff`）。SDK の `query` を閉じるとバックエンドは `aborted` で返るので、そのまま締めると `interrupted` と `completedAt` が書かれる |
| X2 | 5153 `runtimeContext.close()` | ply_context の口と外部 MCP を閉じる | 口の束縛（トークン）は閉じない。外部 MCP の子はプロセスと一緒に止まる（R15） |
| X3 | `claude.mjs:1054` `flag.dispose()` | フラグ設定のファイルを消す | 消さない（O4） |
| X4 | 1872-1875 の `exit`（`shellRuns.stopAll`・`botHost.stop`・`removeControlFile`・`mainLink.dispose`） | 終わりに止める・消す | `control.json` は自分の pid のものだけ消す作り（そのまま）。`!` の行は段階 3 まで止まる |
| X5 | `antigravity.mjs:786` の `exit` | agy を全部止める | 段階 3 |
| X6 | `computerLock`（M37） | ターンの終わりにロックを解く | 手を離す前に `stopAll('update')` |

---

## 6. 2b の段

順番と依存（矢印は依存、`‖` は並行できる）: **2b-1 → (2b-2 ‖ 2b-3) → 2b-4 → [2a] → 2b-5 → 2b-6 → 2b-7**。2b-1〜2b-4 は保持役（2a）が無くても取り込め、走っているターンの挙動を変えない。

| 段 | 中身 | 単独で取り込めるか | 規模 |
|---|---|---|---|
| 2b-1 | `runTurnInternal` を `prepareTurn`・`beginTurn`・`launchTurn`・`driveTurn`・`releaseTurn` に分ける（§4.2）。`ctx` に閉包の値を移す（§4.3）。`endTurn` に 1 回だけの印 | 取り込める（挙動を変えない） | M |
| 2b-2 | 札の形 `core/turn-card.mjs`（純関数）: `cardOf(ctx)`・`restoreFields(card)`・版 `v: 1`・大きさの上限・秘密の欄を分ける。途中送信の控えを 1 つの欄にまとめる形（§3 の 3）。ターンの前の切り口（T1） | 取り込める（使う所が無い） | S |
| 2b-3 | 会話の MCP の口を同じトークンで開き直す: `agent-bridge`・`computer-bridge`・`browser-bridge`・`mcp-bridge`（ply_control）・`context-bridge` の `open({ token })` と、`server.mjs` の `restoreConnection(entry)`。**実装済み 2026-10-06**（下の「2b-3 の実装のメモ」） | 取り込める（既定の `open()` は今のまま） | S |
| 2b-4 | 付け直しの入口 `adoptTurn(card, source)` と `makeEmit` の再生の道（§4.4）、起動の順序（§5.1 の順序）と後片付けの除外（S5-S9・S12・S13）、`backend.adoptTurn` の口。**付け直す元は既定で空**。テスト用に「終わっていたターン」の元（札と記録のファイル。`AGENT_HOST_ADOPT_FROM`、テストだけが付ける）を読める | 取り込める（元が空なら何も変わらない） | M |
| 2b-5 | fake の `adoptTurn`: fake の台本を別プロセスの偽の CLI（`core/backends/fake-agent.mjs`。1 行 1 JSON の出来事を出し、stdin で承認の答え・途中送信を受ける）で走らせる台本 `held:<台本>` と、保持役（2a）の子に載せる道。札は台本の位置 | 2a の後 | M |
| 2b-6 | 実行中のスナップショットと承認を再生で作る: ack の位置、uuid で冪等、承認のカードの id を決まった値に（A3）、止め始めていたターンの中断の送り直し（T7）、待ち受けのポートが取れないときの扱い（§3 の 9） | 2b-5 の後 | M |
| 2b-7 | 途中送信と委譲の付け直し: 札の途中送信の欄を埋める（`liveNotices`・`liveInstructions`・`agentTasks` の `steers`）、`execute` を分けて `agentTasks.adopt(taskId, turnPromise)`、S8 の除外 | 2b-6 の後 | M |

bot の会話（O21）・圧縮のターン（`hooks.compact`）・Codex/agy（段階 3）は 2b では付け直さず、先送り（段階 1 の切り替え）か中断のまま。2b-4 の除外の一覧に入れ、`running` の `stoppers` と同じく待ちの表示に出す。

**2b-3 の実装のメモ（2026-10-06。実装済み。2b-4 が使うときの注意を含む）**

- 口の形: `agentBridge.open`・`browserBridge.open`・`computerBridge.open`・`controlBridge.open`（`createMcpBridge`）は、引数に `token`（任意）を受ける。省略なら今までどおり呼ぶたびに新しい値で、返り値の形も変えていない。トークンの検査は `core/mcp-token.mjs` の `claimToken(bindings, fixed)` に 1 つにまとめた: 64 桁の小文字の 16 進でなければ `Invalid token`、その口で使用中なら `Token already in use` を投げる（断った開き直しは元の束縛に触れない）。閉じた口のトークンはまた受ける
- ply_context（`createContextBridge().open`）は、もとから `token` を受け形も見る（agy が会話のあいだ同じ値を使うため）。**使用中の値の検査は足していない**: 次のターンが同じ値で束ね直す使い方があり、`close` も「後から束ね直した方は消さない」作りのため。代わりに `restoreConnection` が、札の `contextToken` の形と他の会話との重なりを見る
- `server.mjs`: `restoreConnection(entry)`（まだどこからも呼ばない）。`entry` は `{ key, sessionId, locale, tokens: { agents, context, control, browser, computer }, computerBackend }`。`tokens` は札へ入れる側の `connectionTokens(entry)` と同じ形で、**開いていなかった口は `null` のまま開かない**。`key` が `agentConnections` に既にあれば投げる（上書きしない）。途中で投げたときは、開いた口を閉じてから投げる（`agentConnections` には載せない）。ply_computer は `computerBackend` で `getBackend` を引いて開き直す（渡し方 `delivery` はそのバックエンドの `capabilities.computerUse` から作り直す。コンピューターの操作が今は使えない・バックエンドが無いときは投げる）
- 既存の開き方は `attachAgentsPort`・`openComputerPort`・`openControlPort` に取り出し、`conversationConnection`・`computerConnection`・`controlRuntimeFor` と `restoreConnection` が同じ `owner`（走っているターンを `runtime.turns` から引く）を使う。挙動は変えていない
- 2b-4 への注意: (1) `restoreConnection` は**口を開くだけ**で、`runtime.turns` には何も載せない。口の `owner` は呼ばれた時に `runtime.turns.get(key)` を引くので、付け直すターンの登録（`restoreTurn`）より前に呼んでよいが、**登録の前に CLI が口を呼ぶと `notRunning` で断られる**（ply_control だけは `entry.sessionId` で通る）。待ち受けの開始・起動時の後片付けより前に呼ぶ順序は §5.1 のとおり (2) `restoreConnection` が使う `localOrigin()` は `server.address().port` を読むので、**待ち受けが始まった後**でないと呼べない。URL は同じポートのときだけ前の値と一致する（ポートが取れなかったときは 2b-6 の扱い） (3) 札に入れるのは `connectionTokens(entry)` の値。`entry.runtime` の `headers` から取り出すので、口を開き直した後でも同じ値になる (4) `releaseAgentConnection`・`sessionId` の付け替え（`agentConnections` のキーを `event.sessionId` に替える所）は戻した `entry` でも同じに動く
- テスト: `tests/unit/mcp-bridge-token.mjs`（口ごとに、同じトークンで開き直すと前の URL・ヘッダーで `initialize`・`tools/call` が通る・既定の `open` は新しい値・形の違う値と使用中の値は断る・閉じた後の同じトークンは受ける）。`restoreConnection` 自体は `server.mjs` がモジュールとして読めないので、単体では確かめていない（2b-4 の `adopt-finished.mjs` で通る）

### 6.1 テストの書き方

**2b-1**（挙動を変えない）: 既存の `npm test` が変えずに通ること。加えて `tests/unit/turn-phases.mjs`（新規）で、fake の台本ごとに `turnEnd` が 1 回・`completedAt` が 1 回・使用量の行が 1 件（`AGENT_HOST_FAKE_USAGE=1`）であることを数える。台本は `echo:`・`fail`・`slow`（中断）・`limit <t>`・`undelivered`・`compact`・`ask`（承認して終わる・却下）・途中送信の `requeue`（`DECLINE_STEER`）・`hook-follow`。`endTurn` を 2 回呼んでも 2 回目が何もしないことは、分けた関数を直に呼ぶ単体で見る

**2b-2・2b-3**（純関数・口）: `tests/unit/turn-card.mjs`（札の往復・知らない版は null・大きさの上限・秘密の欄が `JSON.stringify` の札の本体に出ない）。`tests/unit/mcp-bridge-token.mjs`（各口で `open({ token })` → 同じトークンで `lookup`・`tools/call` が通る・同じトークンの二重の `open` を断る・閉じた後の同じトークンを受けない）

**2b-4**（終わっていたターンの付け直し。生きた子は要らない）: `tests/unit/adopt-finished.mjs`。札と記録（fake の出来事の行と `exit`）をデータ置き場の外の一時フォルダーに置き、`turnStartedAt` を立てた会話のデータ置き場で `startServer({ env: { AGENT_HOST_ADOPT_FROM: dir } })` を起こす。確かめること: その会話が `restart` の中断にならない・`turnEnd` が 1 回・`completedAt`・使用量（`presentKey` の id で 1 件）・送信待ちの `sending` が `unknown` にならない・別の会話（札の無い `turnStartedAt`）は今どおり `restart` になる・付け直す会話に予定の送信が重ならない（S13）

**2b-5 以降**（途中で引き継ぐ。2a の保持役の上）: `tests/lib/handover.mjs`（新規）に台本の道具を置く。

```
const run = await handoverRun({ dataDir });          // 保持役を立て、サーバー A を起こす
await run.a.send(sessionId, 'held:steps:@<台本>');    // fake の偽の CLI が保持役の子として走る
await run.a.waitSignal('held-ask');                   // 偽の CLI が承認待ちに入った（server の標準出力の合図）
await run.switchServer({ how: 'crash' });             // A を強制終了（2e と同じ形。2d の後は how: 'handover'）→ 同じデータ置き場で B
await run.b.answerPermission(...);                    // B の画面に承認が 1 つだけ出る（id が A と同じ）
await run.b.waitTurnEnd(sessionId);
run.assertOnce(sessionId);                            // turnEnd・completedAt・使用量・完了の知らせが 1 回、interrupted が null
```

台本（R2 の「全部の段階」）と、それぞれで確かめること:

| 台本 | 引き継ぐ時点 | 確かめること | 段 |
|---|---|---|---|
| 準備中 | `backendInvoked` の前（`context:` の外部 MCP の接続を遅らせる） | 付け直さず `restart`（2d の後は「待ってから引き継ぐ」） | 2b-5 |
| 承認待ち | `ask` の最中 | B に承認が 1 つ（同じ id）、答えると続く。スマホの通知が 2 通にならない | 2b-6 |
| ツールの実行中 | `steps:` の `ms` の途中 | ツールの結果と本文が欠けず重ならない（uuid）。`loadSession` のスナップショットが A と同じ | 2b-6 |
| 渡った合図の前 | `HOLD_CONFIRM:<名前>` の途中送信を受けた後、合図の前 | 合図が B に届き、送信待ちが `sent`。`liveNotices` の完了通知が二重にも欠けにもならない | 2b-7 |
| 裏の作業の待ち | `bg <n> gate:<名前>`（phase: waiting） | B で `phase`・`background` が戻り、ゲートを開くと終わる | 2b-6 |
| 委譲の子 | 子が `slow` の最中に A を落とす | 子のタスクが `interrupted` にならず、子が終わると依頼元へ完了通知が 1 回 | 2b-7 |
| 中断の最中 | `slow` に中断を送った直後 | B で中断が送り直され、`interrupted.reason` が元の理由 | 2b-6 |
| 終わった直後 | 偽の CLI が `exit` した後、A が締める前 | B が再生だけで締める（2b-4 の形）。記録が 1 回 | 2b-5 |

fake の偽の CLI の出来事の行は fake の正規化（今の `emit` の出来事の形）をそのまま運ぶので、保持役の記録と再生の確かめは正規化を含まない。Claude の正規化を含む確かめは 2c の fake の CLI（stream-json を話す偽物）で行う。

---

## 7. plan・design との関係（変えたこと・決めたこと）

- plan.md 2b の 5 項目のうち、「仕分けた表」（この文書）・「切り目」（§4）・「後片付けとぶつかる所」（§5）の案を決めた。`adoptTurn` は fake を先にする（2b-5）のは plan のとおり
- design.md §5.4 の 4 項目（`recoverInterruptedTurns`・`agentTasks.restored`・agy の孤児の掃除・送信待ちの戻し）に、**S1・S7・S11・S12・S13 と旧サーバー側の X1-X6 を足した**（§5）。とくに X1（旧サーバーで締めを走らせない）は、`detach` → `query.close()` の順（design.md §4.4）を守っても、バックエンドが `aborted` で返ってくる以上サーバー側で止める必要がある
- design.md §4.5 の「札」の中身（会話の id・バックエンド・ターンの引数・MCP の束縛・印）に、T1（ターンの前の切り口）・T24（`presentKey`）・T22（`pastSubagents`）・L6-L8（渡った合図の印）・M3-M5（委譲と途中送信の控え）・O3-O5（Claude の費用の基準・フラグ設定・途中送信）を足した
- 新しく分かったこと: 使用量の記録は id（`presentKey`）で 1 回だけになる作り（`usage.mjs:166`）なので、`presentKey` を札で渡せば旧と新の二重記録が起きない。承認のカードの id は乱数なので、再生で作り直すと画面・スマホ・通知の一覧が二重になる（§3 の 5）
