# Channels・bot・記憶・ルーティン

bot（名前・人格・記憶・権限を持つ定義）と、人と bot が集まる Channels、定期の仕事のルーティンの、**今の動きと各モジュールの契約**。決めた理由は ADR 0106〜0114（[0106](adr/0106-bots-channels-routines.md) 全体、[0107](adr/0107-side-chats-channels-tabs.md) 脇のタブ、[0108](adr/0108-channel-posts-source-of-truth.md) 投稿の正本、[0109](adr/0109-bot-and-dispatch.md) bot と起こし方、[0110](adr/0110-bot-memory.md) 記憶、[0111](adr/0111-thread-spatial-model.md) スレッドの空間モデル、[0112](adr/0112-routines.md) ルーティン、[0113](adr/0113-webhook-receiver.md) webhook、[0114](adr/0114-send-on-your-behalf.md) 代わりに送る、[0117](adr/0117-thread-replies-and-implicit-wake.md) スレッドの返事と `@` の無い投稿、[0119](adr/0119-channel-budget-and-resting.md) チャンネルの予算と休憩中）。

## データ

型の正本は `core/channels/types.mjs`（JSDoc）。置き場は `<データ置き場>/` の下:

| もの | 場所 |
|---|---|
| チャンネル・DM の定義と既読 | `channels/index.json` |
| 投稿・編集・リアクション（追記だけの操作の記録） | `channels/<channelId>.jsonl` |
| 投稿に付けたファイルの中身（この端末から送ったもの） | `uploads/<channelId>/`（Chats の添付と同じ置き場。会話の id の代わりにチャンネルの id） |
| スレッドの状態 | DB（`pleiad.db` の `channel_threads`。1 スレッド 1 行。[ADR 0115](adr/0115-records-in-sqlite.md)） |
| bot へ届ける前の出来事 | `channels/inbox.json`（状態 `pending → delivering → sent / unknown`） |
| bot の定義 | `bots.json` |
| 記憶（正本）・変更の記録・索引 | `memory/user.md`・`memory/bots/<botId>.md`・`memory/log.jsonl`・`memory/index.sqlite` |
| ルーティン | `routines.json` |
| webhook の秘密（P3）・学習の進み | `webhook-secrets.json`・DB（`pleiad.db` の `memory_state`。会話ごとの発言 index・チャンネルごとの投稿 id・追記ログの byte offset を 1 カーソル 1 行、前回の実行時刻を 1 行、最後の結果・飛ばした回数と理由・失敗の様子を 1 行） |

- 新しい JSON ファイル（`index.json`・`inbox.json`・`bots.json`・`routines.json`）は `{ version: 1 }` を持つ。読めない版は読み込まずに画面へ出して止める。`DATA_SCHEMA` は 2（形式 1 の JSON から SQLite への移行で上がる。[ADR 0115](adr/0115-records-in-sqlite.md)）。スレッドの状態と学習の進みは、スレッド・会話の数だけ増えて更新のたびに全体を書き直すことになるので、JSON ではなく DB の行にした（`version` は持たない。0.6.0 が書いた `threads.json`・`learn-state.json` は、形式 1 → 2 の移行が取り込む）。投稿の追記ログ（`<channelId>.jsonl`・`memory/log.jsonl`）は追記だけで、記憶の markdown は人が直せる正本（[ADR 0110](adr/0110-bot-memory.md)）のまま。どれも `tests/data-writes-allowlist.mjs` に上限と理由を書いてある。
- **添付つきの投稿**（[ADR 0116](adr/0116-channel-composer-attachments.md)）: 本文に Chats と同じ印の行 `[添付] パス`（画面の言語で `[Attachment]`）を持ち、任意の欄 `Post.attachments: { path, name, kind: 'image'\|'file', mime, size, origin: 'device'\|'host' }[]`（上限 50 件。中身は載せない）が描き方の材料になる。bot へは本文のまま包みの中に入って届く（Chats で添付を渡すのと同じ形）。`@` の解析は印の行を見ない。消した投稿は `attachments` を外す（置き場のファイルは残す）。足すだけの欄なので `DATA_SCHEMA` は上げない。
- `editedAt`（画面の「（編集済み）」）は畳み込み（`foldOp`）が付ける。本文が実際に変わった `edit` だけ。同じ本文での `edit`（`mentions`・`state`・`presents` だけの更新）と、bot のターンの投稿（`turn`）の本文が埋まる更新は付けない。記録は操作の列なので、過去のデータも読み直すだけで直る。
- id は `core/channels/types.mjs` の `newId(kind)`（`c_` `p_` `b_` `m_` `r_` `h_` `i_`）。
- 会話の記録（DB の `session_fields`）の新しい欄: `bot`（`SessionBot`。botId・種類・チャンネル・スレッド・記憶の進み）。代わりの送信の見分けは `sessions.send` の `relayed` を使う（[ADR 0114](adr/0114-send-on-your-behalf.md)）。使用量の記録（DB の `usage_records`）に `sessionId`（足す前の分は無い。`usage.records({ sessionIds, since })` が引く）。一覧の行（`sessionRow`）に `bot: { botId, kind, channelId, threadId } | null`。
- 会話の言語・題・モード・モデル・エフォートは普通のセッションと同じ（委譲の子の作り方 `prepare` と同じ手順）。

## モジュールと持ち主

| ファイル | 中身 | 持ち主 |
|---|---|---|
| `core/bots-host.mjs` | 下の各モジュールを束ね、`server.mjs` にだけつなぎ目を出す `createBotHost(deps)` | P0（区画ごとに持ち主） |
| `core/channels/types.mjs` | 型・id・発言者の検査・包みの組み立て（`channelEnvelope` ほか） | P0 |
| `core/channels/service.mjs`（`createChannelService`）・`store.mjs`・`mentions.mjs`・`threads.mjs` | チャンネル・投稿・リアクション・既読・スレッドの状態・@ の解析 | S1 |
| `core/bots/service.mjs`（`createBotService`）・`store.mjs`・`sessions.mjs` | bot の定義・bot の会話の作り方・人格の文 | S2 |
| `core/memory/service.mjs`（`createMemoryService`）・`store.mjs`・`index.mjs`・`tail.mjs` | 記憶・索引・ターンの末尾 | S3 |
| `core/memory/learn.mjs`（`createMemoryLearner`） | 新しい人の発言を夜に整理。利用者のルーティン一覧には出さない | L1 |
| `core/bots/dispatch.mjs`（`createDispatcher`） | @ から起こす・途中送信・ターンの投稿・止める・トークンの集計 | S4 |
| `core/routines/service.mjs`（`createRoutineService`）・`cron.mjs`・`schedule.mjs`・`runner.mjs`・`events.mjs` | ルーティン | R1（P2） |
| `core/routines/webhook.mjs`（`createWebhookReceiver`） | `/hooks/<id>` | H1（P3） |
| `core/ops/{channels,bots,memory,routines}.mjs` | 操作（`defineOp`）。空の配列から始まる | それぞれ S1 / S2 / S3 / R1 |
| `web/channels/` | `setupChannels(host)`・`side-tabs.mjs`・各画面（`sidebar` `feed` `thread` `bot-page` `routine-sheet`） | P0 / W1〜W5 |

各工場の引数と返りの形は、そのファイルの先頭のコメントが正本。`createBotHost` は工場を束ね、`ChannelService.hooks`（`posted`・任意の `edited(post, channel)`・`stopThread`）で逆向きの口を配線する。

## サーバーのつなぎ目（`core/server.mjs`）

`server.mjs` が呼ぶのは `botHost`（`createBotHost` の返り）だけで、どれも例外を外へ出さず、bot の会話でなければ何もしない。

| つなぎ目 | 呼ぶ場所 |
|---|---|
| `opsDeps()` | `opsDeps` に `channels`・`bots`・`memory`・`routines`・`botOfSession(sessionId)` を足す |
| `turnExtras(turn)` → `{ botInstructions, notes, folders }` | ターンの組み立て（`runArgs`）。`notes` は既存の中断の文の後ろ。`botInstructions` は新しい欄で、各バックエンドが指示の並びの最後に足す。`folders`（`{ all, additionalDirectories, writableRoots }`）は `runArgs.botFolders` になり、Claude の `additionalDirectories`・Codex の `sandboxPolicy.writableRoots`・agy の `--add-dir` へ渡す（S2） |
| `onTurnEvent(turn, event)` | `makeEmit`（`text.end`・`usage`・`activity`・`present`・`permission`・`turnResult`・`userMessage.delivered` / `dropped`） |
| `onTurnEnd(turn, { outcome, interrupted, requeued })` | `endTurn` の最後（ターンを手放した後。待たない）。最終の返答の文は `host.lastReply(sessionId)`、提示は `onTurnEvent` の `present` から集める |
| `onPermission(card, phase)` | `askPermission`（`'open'` / `'settled'`。card は `{ id, sessionId, kind, toolName, input, title }`） |
| `onSessionDone(sessionId, outcome)` | 完了通知が落ち着いたとき（委譲の子は除く。イベントのトリガ） |
| `onCompacted(sessionId)` | 圧縮の完了（`snapshotDue = true`・`delivered = []`） |
| `handleHttp(req, res)` | 認証の前（`/hooks/`。P3） |
| `start()` / `stop()` | 起動時（届ける前の出来事の戻し・ルーティンの取りこぼし）・終了時 |

各モジュールに渡る道具（`host`）: `store`・`dataDir`・`usageStore`・`sessionSearch`・`runtime`（走っているターンの表）・`outbox`（人の送信待ち）・`createConversation`・`runTurn(args, onStarted, hooks)`・`noticeTarget`・`noticeBlocked`・`abortSessions`・`emitGlobal`・`getBackend`・`listBackends`・`resolveModel`・`resolveEffort`・`agentLocaleFor`・`agentT`・`currentLocale`・`lastReply`・`sessionBusy`、と `emit(event)`（`sessionId: null` で全接続へ）・`emitSession(sessionId, event)`。

- 走っているターンへの途中送信は `runtime.turns.get(id)` と `canSteerNotice`（`core/completion-notices.mjs`）で判断し、`turn.control.steer` へ渡す。「渡った」合図は `onTurnEvent` の `userMessage.delivered` / `dropped`。
- bot の会話へ新しいターンを始めるのは `runTurn({ sessionId, prompt }, () => {}, { internal: true })`。prompt が包み（下）で始まるなら、画面へは `channelEvent`、そうでなければ `taskNotice` が出る。

## 操作（`core/ops/`）

id は `<領域>.<動詞>`（ドットは 1 つ）。human-only は承認モード・秘密の値・アカウント・接続先の既定・リモートのペアリングの 5 つだけ（[ADR 0082](adr/0082-control-surface-principals-and-risk.md)）。消す操作は guarded。**直のツール（`mcp: 'direct'`）は 1 つも足さない**（`ops-surface` の T4 の余りが小さい）。新しい WS のコマンドも足さず、画面は `cmd('invoke', { op, args })`。失敗の code は辞書 `agent:ops.errors.<CODE>` と `tests/unit/ops-surface.mjs` の `ERROR_CODES` の両方（T7）。read の操作は T6 のスタブ deps と `samples` に足す（必須の引数がある read は `tests/unit/ops-control.mjs` の T6 の `inputs` にも例が要る。無いと全件のときだけ「必須の引数の例がある」で落ちる）。

| op | 危険度 | 備考 |
|---|---|---|
| `channels.list` / `get` / `read` / `search` | read | `list` → `{ channels: (Channel & { unread, mentions, threadsWorking })[] }`（アーカイブしたものも含む。`unread` = 既読の後の人以外の投稿、`mentions` = そのうち `@あなた`）。`read` は `{ channelId, threadId?, before?, limit≤100 }` → `{ posts, threads, summaries, nextBefore }`（新しい方から `limit` 件を時間順で。`threadId` ありは根が先頭。`summaries` = 返信のある根ごとの `{ count, lastAt, authors }`）。消した投稿は `deletedAt` 付きの空の本文で残る。`search` → `{ hits }` |
| `channels.create` / `update` / `archive` | write（AI が `cwd` を決める・変える・予算を外す・上げるのは `riskOf` で guarded） | 消さない（archive）。`cwd` はフォルダーを持たない bot の作業場所になるので、AI が決める・変える（外す・同じ値は除く）のは承認（`bots.update` のフォルダーを足すのと同じ重さ）。`update` の `budget: { daily?, perThread? }`（渡した欄だけ。DM は持たない）は bot どうしの呼びかけの歯止めなので、AI が外す（`daily: null`）・上げるのは承認、下げるのは承認なし（[ADR 0119](adr/0119-channel-budget-and-resting.md)）。`list`・`get`・`channelsChanged` のチャンネルは `budget` に既定を埋め、`spentToday`（今日の分の合計）を付ける |
| `channels.wakePreview` | read | `{ channelId, threadId?, text }` → `{ required, botIds }`。人の `@here` / `@everyone` の宛先を、今のメンバーとスレッドの発言から数える。 |
| `channels.post` | write・`modeGate: false` | `confirmedWake: string[]` は集団宛ての確認済み id（`wakePreview` と同じ並び。未確認・変化があれば `INVALID`）。`attachments: { path, name?, mime? }[]`（上限 50）で添付を付ける。実物（置き場の中のファイル・読んでよいホストのファイル）を確かめて載せ、読めないものが 1 つでもあれば `INVALID`。本文には印の行を置く。発言者は主体から決める（human / 束縛された会話が bot なら bot / それ以外の AI は agent / 束縛なしの CLI は `NEEDS_UI`）。**bot の会話が自分のスレッド（DM）へ書いたら、それがそのターンの返事**（[ADR 0117](adr/0117-thread-replies-and-implicit-wake.md)）: ターンで最初の 1 件は作業中のターンの投稿に入り（`new` の有無によらない）、2 件目からは新しい投稿。そのターンの最終の返答は投稿に書かない（下の「ターンの投稿」）。ほかのスレッド・チャンネルへは新しい投稿。呼んだ会話が分からない書き込み（`bySession` なし）は、`new: true` で新しい投稿、無ければ作業中のターンの投稿の本文を置き換える。`threadId` は `string \| null`。**bot の会話（スレッド）で `threadId` を省くと、その会話のスレッド**（同じチャンネルのとき）。チャンネルの流れへの新しい投稿は `threadId: null` と `new: true` を一緒に渡したときだけ（`null` だけは `INVALID`）。投稿の主体が AI（bot を含む）で、`@` の宛先の bot の承認モードが主体の会話より強い（範囲・自律のどちらかが上）ときは、投稿は残して起こさず、`channels.wake` の承認カードを出す。返りに `wake: [{ botId, status: 'pending' \| 'woken' \| 'notWoken' \| 'denied', requestId?, code?, message? }]` が付く。人の個別の `@名前`・同じか弱い bot への `@` は確認なし（人の集団宛ては投稿前に人数を確認する）。ターンの投稿に入った返事も、新しい投稿と同じく書いたときに `@` を解き、同じ確認を通る（`hooks.posted` の `extra.filled`） |
| `channels.wake` | guarded | `{ channelId, postId, botId, reason? }`。投稿の `@`（DM なら DM の bot）を起こす。承認カード「<bot> は <モード> で動きます。起こしますか」（`loosens`・モードの行。許可のあとに bot のモードが変わっていれば聞き直す）。人が呼べば確認なし。止めたスレッド・`@` していない投稿は起こさない（`{ woken: false, reason }`）。読み取りの会話は `READ_ONLY_MODE` |
| `channels.edit` / `delete` | write | 自分の投稿だけ |
| `channels.react` | write・`modeGate: false` | 絵文字 1 つ（`web/emoji.mjs` の `EMOJI_RE`）。人も bot も同じ操作 |
| `channels.markRead` | write（AI・CLI にも出す） | `{ channelId, at? }`（省くと今）。進める向きにだけ動く。CLI は `pleiad channels mark-read <channelId>` |
| `channels.stopThread` | write・`modeGate: false` | `stopped.by` に止めた主体を残す。bot が自分のスレッドから流れへ `@` を書いて起こした先のスレッド（`ThreadState.origin` で結ばれたもの。孫も）も止める |
| `bots.list` / `get` | read | `usage: { weekTokens, cacheRatio }`・`state` を付ける |
| `bots.create` | write（AI は `riskOf` で guarded） | `{ name, icon?, persona?, backend?, model?, effort?, reason? }`。backend の既定のモード（作業場所に書けて毎回聞く、いちばん弱いもの。agy は yolo だけ）・フォルダーなし・DM のチャンネルを作る。AI が作るときの承認カードに、**作られる承認モードの行**を出し、弱くない（範囲・自律が `workspace`・`ask` より上の）モードなら `loosens` |
| `bots.update` | write（範囲を広げる向き・AI が人格を変えるのは `riskOf` で guarded） | 名前・アイコン・人格（AI が変えるのは bot 自身の人格も承認。外から来た文に押された bot が自分の人格を書き換える足場を作らない）・backend（次の新しい会話から。モデル・エフォートは既定に戻り、承認モードは同じ id があれば保つ）・モデル・エフォート・`folders`（置き換え）・`sendToOthers`・`sendTargets`（置き換え）。広げる向き = フォルダーを足す・`ro` を `rw` にする・送る先を足す・`sendToOthers` を ON にする・承認モードが強くなる backend へ変える |
| `bots.setMode` | human-only | 承認モード（`mode`）だけ |
| `bots.delete` | guarded | 会話は消さず bot の印だけ外し（Chats の一覧に戻る）、DM のチャンネルは archive |
| `memory.list` / `search` | read | `layer` は `user`・bot の id・`self`（bot の会話の自分の層）。bot に束縛された主体は `user` と自分の層だけ。`search` は `limit≤8`・各 150 トークンまで |
| `memory.write` | write・`modeGate: false`（CLI は無し） | 出どころの検査（`MEMORY_SOURCE`・`MEMORY_REJECTED`）。`sources` は `{ kind: 'post'\|'message', channelId?, postId?, threadId?, sessionId?, messageId?, quote }[]`（実物を引いて確かめ、時刻を実物から入れる）。**`quote` は空白を除いて 8 字以上**。出どころはその bot の今のスレッド・会話に限らない（記憶は全ての会話から作る）。人の発言に数えないもの: 委譲の子・bot・ルーティンの会話の**最初の user の行**（親の AI・仕組みが書いた依頼）、完了通知・代理の送信・包みの行・proxy。**bot が `user` 層へ書くのは 1 ターンに 5 件まで**（本文を変える `edit` も数える。超えたら `MEMORY_REJECTED`・理由 `userWriteLimit`。ターンの始まり（`turnContext`）で数え直す）。人が画面から書くときは出どころ・URL などの規則を掛けない。束縛されない AI は `NEEDS_UI`。任意の `kind`（`stop`・`promise`・`decision`・`share`・`pref`・`note`）・`weight`（1〜3）・`status`（`open`・`done`）は記憶の種類・重み・状態（下の「記憶の強さ」）。**AI の重み 3 は、種類が `stop`・`promise`・`decision` か、根拠の人の発言に強い合図（「覚えて」「絶対」「〜ないでほしい」など）があるときだけ**で、ほかは 2 に下げる |
| `memory.edit` | write（AI が人の書いた行の本文を書き換えるのは `riskOf` で guarded） | AI も使える。人がしたか AI がしたかは `log.jsonl` の `by`。AI が本文を変えるときは `sources`（任意の欄）に人の発言が要る。**書き手が替わる直しは、元の書き手を `origBy`（記憶のメタ `ob`・`log.jsonl` の `origBy`）に残す**（`by` は今の本文を書いた者）。人が書いた行（`by.kind === 'human'`）の本文を AI が書き換えるときは承認カード（今の本文と新しい本文の行）。自分や別の AI が書いた行・理由だけの直しは承認なし。`kind`・`weight`・`status` も直せる（人の行のこれらを AI が変えるのも承認カード）。**本文の変わらない直しでは `by` を替えない**（AI が人の行を自分の行にして、承認なしで書き換えられる道を断つ。直した者は `log.jsonl` の `by`） |
| `memory.forget` | guarded | 消す操作。墓石を残す。見えない記憶（ほかの bot の層）は `MEMORY_NOT_FOUND` |
| `memory.unforget` | write（画面・AI・CLI のすべてに出す） | 忘れた直後の「元に戻す」（W4）。出どころごと戻し、墓石を外す。誰が戻したかは `log.jsonl` の `by`。bot は見える層（`user` と自分の層）のものだけ（それ以外は `MEMORY_NOT_FOUND`）。束縛されない AI は `NEEDS_UI`。CLI は `pleiad memory unforget <id>`。全機能は AI も使える決定のため。人が忘れさせた記憶を AI が戻せることになるが、戻した主体が記録に残る |
| `memory.learnStatus` | read（画面・MCP・CLI `pleiad memory learn-status`） | 夜の整理の様子: `{ at, paused, running, lastRunAt, nextAt, lastResult, skip, failure }`。`lastResult` は `{ at, read, changed, deferred, more?, scoped? }`、`skip` は `{ reason, count, at }`、`failure` は `{ message, count, at, retryAt }`（無いときはどれも null）。`skip.reason` は `paused`（止めていた）か `failed`（失敗の後の待ち）。`count` は飛ばした予定の回の数 |
| `routines.list` / `get` | read | 定義に `nextAt`（次の実行の時刻。一時停止・出来事・webhook は `null`）・`last`（最後の実行）を付ける |
| `routines.create` | write（AI は guarded） | `{ name, botId, channelId, prompt, trigger, mode?, approvalTimeoutMin?, paused?, reason? }`。`mode` を省くと bot の今の承認モード。承認カードに名前・トリガ・モード・指示を出し、弱くないモードなら `loosens`。チャンネルは DM 不可 |
| `routines.update` | write（広げる向きと、AI が指示を変えるときだけ guarded） | 広げる向き = 頻度を上げる（1 週間の発火の回数が増える。時刻のトリガから出来事・webhook に変えるのも）・モードを強くする・出来事の対象（`scope`）を広げる。AI が `prompt` を変えるのも guarded（無人で動く指示は人格と同じ重さ。外から来た文に書き換えられる足場にしない）。トリガを変えたら予定を数え始める基準を今にする |
| `routines.pause` | write | 狭める向き |
| `routines.resume` / `run` / `delete` | guarded | `run` は `{ routineId, dryRun? }`（一時停止中でも手では走らせられる。`dryRun` でも承認。`dryRun` は走り終えるまで待って `state`・`summary?` を返す）。`delete` は消す操作で、実行の履歴のスレッドは残る |
| `routines.rotateSecret` | human-only | `{ routineId }` → `{ secret }`。保存済みの webhook の秘密を作り直し、新しい値を人の画面へ一度だけ返す。AI・CLI へは出さない |
| `sessions.send` | write（宛先が強いと guarded） | 定義は `core/ops/conversations.mjs`（[ADR 0104](adr/0104-send-to-another-conversation.md)）。主体が bot に束縛された会話のときだけ、強さの比べ方の後で `sendToOthers`・`sendTargets` を追加で確かめ、送り手の `sentBy` に bot の `name`・`icon` を足す（[ADR 0114](adr/0114-send-on-your-behalf.md)） |

記憶のサービス（`createMemoryService`）の `turnContext({ bot, session, sessionId?, incomingText, now?, locale? })` は `{ notes, memRev, delivered, snapshotDue }` を返す。dispatch は返りを sidecar の `bot.memRev`・`bot.delivered`・`bot.snapshotDue` に書き戻す（`snapshotDue` は核の写しを渡したら false）。`sessionId` を渡すと、その会話が自分で書いた記憶（履歴に tool の結果がある）を差分で繰り返さない。途中送信（steer）では呼ばない。失敗の code は `MEMORY_SOURCE`・`MEMORY_REJECTED`・`MEMORY_NOT_FOUND`、理由は辞書 `agent:memory.reason.*`。索引は `node:sqlite` を読み込めない・壊れているときはメモリ上の走査に切り替わる（`AGENT_HOST_MEMORY_NO_SQLITE=1` で読み込めない状態を作れる）。核の写し（`pickCore`）は、層ごとの目安（1200 トークン）の中で、**強さ（下の「記憶の強さ」）の強い順**に入れる（同じ強さなら人が書いた・人が直した記憶を先に、それから新しい更新から。人の行は重み 3 で薄れないので、書き込みを重ねる bot が新しさで人の古い記憶を押し出せない）。強さが 0.5 未満の記憶は薄れたとして入れず、件数だけを書く（消さない。`memory.search`・関係する記憶では出る）。写しの中は種類の順に並べ、行の頭に種類を書く（`- [約束] …`）。`log.jsonl` の追記は、最後の行が改行で終わっていなければ先に改行を足す（壊れた最後の行の後ろに次の記録をつなげて失わない。チャンネルの `.jsonl` と同じ）。同じ文の同時の書き込みは `store.add` の直列化の中でも重複を確かめる。出どころの検査が効くのは `memory.write` を通る書き込みだけで、データ置き場の `memory/*.md` をファイルとして直接書ける bot（全部自動のモード）には効かない（`sync` が「人の変更」として記録する。[ADR 0110](adr/0110-bot-memory.md)）。

## bot が別の会話へ送る

`sessions.send` は既存の自己送信・委譲の親子・連鎖・頻度の検査と宛先の承認の強さの比較を先に行い、主体の会話が bot に束縛されているときだけ `sendToOthers` と `sendTargets` を検査する。承認カードの前と送信直前の両方で検査し、OFF（削除済みの bot を含む）は `BOT_SEND_DISABLED`、一覧にない宛先は `BOT_SEND_TARGET` と辞書の文で断り、既存の `opRefused` の記録に残す。宛先が強いときの承認は省かない。

送れる会話の正本は `Bot.sendTargets`（最大 100 件）。自動追加も `bots.update { sendTargets }` による置き換えも同じ一覧を使う。

- 人の投稿・編集の本文にある会話 ID（リンク内も含む）か、一意な題を `「…」`・`『…』`・二重引用符・バッククォートで囲んだ名指しを解決する。ID は部分一致せず、同名の会話は題から選ばない。曖昧な自然文を AI に解釈させて許可を広げることはしない。
- チャンネルの流れと DM はその場のメンバー、スレッドは参加中の bot、および本文で @ した bot へ追加する。bot・ほかの AI・webhook 由来の投稿は根拠にしない。過去の投稿全体の遡及走査は行わない。
- bot に束縛された会話が `sessions.new`・`sessions.fork` で作った会話を追加する。委譲の親子への送信は引き続き既存の検査で断る。
- 任意の保存欄 `sendTargetSources` は会話 ID ごとの `shown`・`created`・`manual`。外した先の出どころも残し、再提示や再起動で自動復活させない。戻すには `bots.update` で明示して追加する。設定を AI が広げるときは既存の guarded。
- `BotService.addSendTargets({ botId, sessionIds, source })` と `noteShown(post, channel)` はホスト内部の口。操作の入力から出どころを指定することはできない。

`bots.list/get/create/update/setMode` の返りに任意の `sendTargetDetails: { sessionId, title, source }[]` を足す。bot ページは「他の会話に送る」の下に題・出どころ・［外す］を出し、題を押すと会話を開く。OFF でも一覧は保つ。［外す］は `bots.update` を通る。

送り手は既存の `sentBy` に `botId`・`name`・`icon` を足し、流れと履歴の両方で「🦉 Owl があなたの代わりに送信」と出す。保存は既存の `relayed` で、別の記録や送信経路は作らない。

## WS の出来事（`core/protocol.mjs` の `EVENTS`）

`PROTOCOL_VERSION` は据え置き。次の 8 つは `sessionId: null` で全接続へ（リモートの端末にも届く）。

| 出来事 | 中身 |
|---|---|
| `channelsChanged` | `{ channel?, removed? }` |
| `channelPost` | `{ channelId, op: add\|edit\|delete, post }`（ターンの投稿の進み具合は 1 秒に 1 回まで） |
| `channelReaction` | `{ channelId, postId, reactions }` |
| `channelThread` | `{ channelId, threadId, thread }` |
| `channelRead` | `{ channelId, readAt }` |
| `botsChanged` | `{ bot?, removed? }` |
| `memoryChanged` | `{ layer, rev }` |
| `routinesChanged` | `{ routine?, removed? }` |

会話の出来事 `channelEvent { rows }`（会話の `sessionId` 付き）は、bot の会話へ包みを渡したときに出す。`rows` は履歴の `splitLeadingNotes` と同じ形の行で、画面は履歴と同じ描き方をする。

## bot の会話へ渡す包み

行の先頭に付く。履歴の読み出し（`core/system-messages.mjs` の `splitLeadingNotes`）が、1 つずつシステム側の行に分ける（人の吹き出しにしない。[ADR 0053](adr/0053-system-messages-display.md)）。組み立ては `core/channels/types.mjs`。

| 包み | 渡し方 | 履歴の行 |
|---|---|---|
| `<pleiad-channel channel channel-id thread post from at>本文</pleiad-channel>` | `prompt`。起こした投稿・途中送信する投稿 1 件 | `kind: 'channelEvent'`（`history: false`） |
| `<pleiad-channel-thread channel channel-id thread>…</pleiad-channel-thread>` | `prompt`。初回のスレッドの履歴（中に `<pleiad-channel>`） | `kind: 'channelEvent'`（`history: true`） |
| `<pleiad-memory-core>` | `notes`。会話の始まり・圧縮の完了後の最初のターン | `kind: 'contextNote'`（`tag: 'memory-core'`） |
| `<pleiad-turn-context>` | `notes`。毎ターンの末尾 | `kind: 'contextNote'`（`tag: 'turn-context'`） |
| `<pleiad-interruption>` | `notes`。中断で止めたもの（既存） | `kind: 'interruptionNote'` |
| `<routine-payload source hook at>` | `<pleiad-channel>` の本文の中。外から来た文 | （剥がさない） |

本文に包みのタグが紛れても外へ出られない（`escapeBody`）。途中送信（`control.steer`）の道では末尾を付けず、`<pleiad-channel>` だけを渡す。
`channel` は表示名（`#dev`・DM は bot の名前）、`channel-id` は `channels.post` などの操作へ渡すチャンネルの id（bot が自分で返事を書くのに要る。履歴の行は `channel` だけを持つ）、`thread` は根の投稿の id（DM は無い）、`from` は表示名（人は「あなた」、bot は「🦉 Owl (bot)」）、`at` は現地時刻の分まで。

## bot の定義と、バックエンドへの渡し方（`core/bots/`）

- **定義**（`bots.json`。`createBotStore`）: `Bot`（型は `core/channels/types.mjs`）。名前はチャンネルを通して一意（NFKC・大小を区別しない）で、空白・`@`・句読点・`you` / `あなた` / `here` / `everyone` は使えない。人格は 6000 字まで。読めない版・壊れた JSON・読み取りの失敗（ENOENT 以外。EBUSY・EACCES などは数回再試行してから）は読み込まずに止め（`BotStoreError`。`BOTS_CORRUPT`・`BOTS_UNSUPPORTED_VERSION`・`BOTS_UNREADABLE`）、上書きしない（読み直すには再起動）。id か name が無い行は読み込まれないので、捨てた件数をログへ出す。書き込みは全体で 1 本の直列化キュー（同じ名前の同時の作成でも 1 つだけ通る）。
- **サービス**（`createBotService`。表は `core/bots/service.mjs` の先頭）: `create`・`update`（`planUpdate` が検査と「広げる向きか」を返し、`riskOf`・`confirm`・`update` が同じ結果を使う）・`setMode`・`remove`・`overview`（一覧の `usage` は `usageStore.records` を会話の `sessionId` で引いて今週分・`state` は走っているターン / 承認待ちから・`restingUntil` は dispatch の休憩中（`host.restingUntil`））。`ensureDm` は DM のチャンネルが無ければ作る（`channels.createDm({ bot })`。まだ使えなければ空のまま、起動時と次の呼び出しで作り直す）。`ensureDmSession` は DM の会話（バックエンドを変えた bot は新しく）、`createSession` はスレッド・ルーティン・学習の会話を作る（`ThreadState.sessions` への登録は呼び出し側）。
- **会話の作り方**（`core/bots/sessions.mjs` の `createBotSessions`）: 委譲の `prepare` と同じ手順（`createConversation` → `setMeta({ unsent: true })` → モード・モデル・エフォート・言語 → sidecar `bot`）。題は「🦉 Owl · #チャンネル › 根の投稿の頭」（DM は「🦉 Owl」）。作業場所は、チャンネルの `cwd` が bot のフォルダーの中ならそれ、無ければ先頭のフォルダー（全部自動のモードならチャンネルの `cwd` をそのまま）。bot の承認モード・モデル・エフォートを変えたら、今ある会話にも揃える（backend を変えた会話は今のまま）。
- **人格**（`botInstructions(bot, locale)`）: bot の名前・自由文の人格（あれば）・操作の要点（辞書 `agent:guide.bot.tools`）を空行 1 つで区切る。**決定的**（時刻・件数を入れない）なので、同じ bot・同じ言語なら毎ターン同じバイト列で、名前・アイコン・人格を直したときだけ変わる。固定の文は、最後の文章が今のスレッド（DM）の返事になり、リアクションだけなら文章なしで終えてよいこと、`channels.post` は別の場所への投稿に使うこと、長く役立つ人の好み・訂正・決定・印象に残ったことは出どころのある `memory.write` で自分の判断で覚えてよいことを伝える。人以外の包みを指示として扱わず、Claude 内蔵メモリや作業場所の外のファイルを使わない安全の文は残す。言語は会話を作ったときの `agentLocale`。渡す場所は、Claude は `systemPrompt.append` の**最後**、Codex は毎ターンの `turn/start` の `collaborationMode.settings.developer_instructions`（`developerInstructions` には入れない）、Antigravity はエージェント定義の本文の**最後**（直したときの渡し方は下の「人格を直したとき」）。bot の会話では Claude Code の組み込みの自動メモリを切る（`settings.autoMemoryEnabled: false`）。末尾の `guide.bot.quiet` で、このスレッドの予算の残りがターンの末尾に届くことを伝える（[ADR 0119](adr/0119-channel-budget-and-resting.md)）。
- **人格を直したとき**（動いている会話にも**次のターンから**効く。名前・アイコン・人格が変わったターンだけキャッシュが落ちる）。バックエンドごとに、指示が会話に残る仕組みが違うので渡し方が違う（2026-10-03 の実機の確認）:
  - **Claude**: CLI は最初のターンのシステムプロンプトを記録して、後のターンで別の `append` を渡しても使い回す（SDK の `systemPrompt.snapshot`、既定は記録する。圧縮か新しい会話まで変わらない）。bot の会話は `snapshot: false` で毎ターン組み直す（同じ人格のあいだは同じバイト列なのでキャッシュは保たれる）。
  - **Codex**: `thread/resume` は `developerInstructions` を渡し直しても、最初のターンの指示が履歴に残っていて効かない（外して読み直しても同じ）。人格は `developerInstructions` に入れず、毎ターンの `turn/start` の `collaborationMode`（`mode: 'default'`・`settings.developer_instructions`）で渡す。前のターンと同じ文なら履歴に足されない。
  - **Antigravity**: 会話を続けるときにエージェント定義を渡し直しても、最初の指示のまま動く（人格のハッシュ＋フォルダー `botSessionKey` で `agy` を起こし直しても同じ）。人格を直した後の最初のターンに、新しい人格を末尾の文脈（`<pleiad-turn-context>`。辞書 `agent:channel.personaUpdated`）として渡す。会話が最後に受け取った人格のハッシュ（`personaKey`）は sidecar の `bot` に持ち、「渡った」確定（`commit`）で進める（渡る前に失敗したターンの次も、また渡す）。フォルダーの変更は今までどおり起こし直し（`--add-dir`）。
- **触れてよいフォルダー**（`folderPlan(bot, modeEntry, cwd)` → `{ all, additionalDirectories, writableRoots, readOnlyRoots }`）: 先頭が既定の作業場所（cwd）。Claude は cwd 以外の全部を `additionalDirectories` に渡し、`ro` のフォルダー（`readOnlyRoots`。cwd 自身を含む）は Claude Code の deny ルール（`disallowedTools: ['Edit(//c/a/b/**)']`。Edit は Write・NotebookEdit などファイルを書き換える道具に掛かる）で書き換えを断る。**シェルの `rm`・`mv`・`sed` などは `acceptEdits` が cwd と追加フォルダーの中なら聞かずに通すので、`ro` でも書けてしまう**（Claude の `ro` は「編集の道具を断る」まで。`default` 系のモードならシェルは毎回聞く）。Codex は `rw` のうち cwd 以外を `turn/start` の `sandboxPolicy.writableRoots`（`ro` は書き込みに入れないだけ。cwd そのものは sandbox が常に書けるので、cwd が `ro` のフォルダーでも Codex では書けてしまう。bot の会話は前のターンの書き込み先を引き継がず置き換える）、Antigravity は cwd 以外を `--add-dir`（ワークスペースに見せるだけ。書き込みの範囲は限れない）。**「すべてのフォルダー」（`all: true`）は、書き込みの範囲を限れないモード（`scope` が `full`: Claude の YOLO・Codex の YOLO・Antigravity の yolo）だけ**。Codex の `full` は sandbox が作業場所に限るので、選択は有効のまま（決定 7.2-2）。
- **承認モード**: bot の `mode` は `bots.setMode`（human-only）でだけ変わる。Antigravity は `yolo` 以外を断る。

## bot を起こす・配る（`core/bots/dispatch.mjs`・`inbox.mjs`。S4）

**起こす規則**（[ADR 0109](adr/0109-bot-and-dispatch.md)）。`channels.post` の後（`ChannelService.hooks.posted`）に `dispatch.onPosted` が宛先を決める。ターンの投稿（`post.turn`）では起こさない。
- 起こすのは本文の**明示の `@名前`** と、スレッドの人の `@` の無い投稿（下）だけ（人・bot・Chats の AI の投稿。システム・ルーティンの投稿は起こさない）。自分自身への `@` は、書いた会話のスレッド（DM）の中では数えない（呼び合いの輪にならない）。bot が `channels.post` で別のスレッド・チャンネルの流れへ書いた自分への `@` は、そのスレッドの自分の会話を起こす（同じ bot でもスレッドごとに別の会話なので。書いた会話は ops が `bySession` で渡し、`hooks.posted` の `extra.bySession` で dispatch に届く）。bot がチャンネルのメンバーかは見ない。**何を `@` と数えるかは発言者で違う**（`core/channels/mentions.mjs` の `parseMentions`。[ADR 0117](adr/0117-thread-replies-and-implicit-wake.md)）: 人（と Chats の AI）は文中も数え、`@` は NFKC で畳むので**全角の `＠名前` も `@名前` と同じ**（日本語の入力で `＠` になるため）。**bot の投稿で bot を呼ぶのは、行頭の半角の `@名前` だけ**（`strict`。行頭に `@A @B` と並べたものは数える。文中・全角の `＠` は数えない。bot が報告の文の中で名前を出しただけで起こし合わないため。`@あなた` は文中でも数える）。どちらも、コードの区間・引用行・同じ行で閉じる括弧と引用符（`（）()「」『』【】“”"…"`）の中は数えない。bot の人格の固定の文には行頭の半角 `@名前` の要点を載せる。
- チャンネルの流れ（スレッドの外）の投稿で `@` されたら、その投稿を根にスレッドを作る。スレッドの中の投稿は、そのスレッドの bot の会話（`ThreadState.sessions[botId]`。無ければ `bots.createSession` で作って登録）へ。
- DM は人の投稿がすべてその bot 宛て（`@` 不要。会話は `bots.ensureDmSession` の 1 本）。DM の中の他の bot への `@` は起こさない（DM は 1 対 1）。
- **スレッドで `@` の無い人の投稿は、そのスレッドで話している bot 1 体へ渡す**（[ADR 0117](adr/0117-thread-replies-and-implicit-wake.md)。`dispatch.conversingBot`）。今作業中（始めかけを含む）の bot が 1 体だけならそれ（その会話へ書き足す。途中送信）。そうでなければ最後に話した bot = その投稿より前の、いちばん新しい bot の投稿（消したものは除く）の bot で、新しいターンで返事をする（作業中ならその会話へ書き足す）。bot の投稿がまだ無ければ、スレッドの会話（`ThreadState.sessions`）を持つ bot が 1 体だけならそれ。決まらなければ誰も起こさない。複数の bot がいるスレッドでも起きるのは 1 体だけ。ほかの bot に聞きたいときは `@` を付ける。`@あなた` だけの投稿も `@` の無い投稿として扱う。
- **bot・Chats の AI の `@` の無い投稿は、誰も起こさない**（暗黙の宛先は人の投稿だけ）。bot 同士は明示の `@` か、呼ばれて答えた返事（下）でだけ起き合う。
- **人の `@here` / `@everyone`**（[ADR 0121](adr/0121-channel-group-mentions.md)）: `@here` はそのスレッドで話したことのある、今もチャンネルのメンバーである bot 全員。流れでは 0 体。`@everyone` はチャンネルのメンバーの bot 全員。併記した個別の `@` と重複しない。投稿前に `channels.wakePreview` が宛先を数え、入力欄の「N体を起こします」で人が［起こす］を押したら `channels.post.confirmedWake` に宛先の id を渡す。投稿時に数え直し、変わっていれば送らず再確認する。投稿の `mentions` には集団の印と解いた bot の id を残す。0 体の `@here` でも暗黙の宛先は選ばない。bot の文にこの 2 語があっても誰も起こさない。`here`・`everyone` は bot の予約名。
- `ThreadState.stopped` があれば、人が次に書くまで起こさない（人の投稿で `stopped` を外すのは `ChannelService.post`）。止めた後に人が `@` 無しで書いた投稿も、上の規則で最後に話した bot へ渡る（人が書いたら会話を続ける合図）。
- bot の返事（ターンの投稿の最終の返答）の `@` も同じ規則で起こす（`onTurnEnd`。止めた・失敗した・止められたターンの返事では起こさない）。bot が `channels.post` で書いた投稿（ターンの投稿に入った返事を含む）の `@` は、書いたときに `hooks.posted` から（ターンの終わりには重ねない）。`ThreadState.calls` は起こすたびに数える（表示だけ）。
- **bot が bot を起こすのは、チャンネルの予算が残っている間だけ**（[ADR 0119](adr/0119-channel-budget-and-resting.md)。回数の上限は置かない。[ADR 0117](adr/0117-thread-replies-and-implicit-wake.md) の「6 回まで」を置き換えた）。止めるのは bot の投稿の `@`（返事・`channels.post`。別のスレッドの自分を起こすのも）と、呼んだ bot へ返す返事。人の投稿・人が承認した `channels.wake` は止めない。使い切っても Pleiad はお知らせを出さない（残りは毎ターン bot に渡っているので、続けるか・黙るかは bot が決める）。
  - **数え方**（`core/bots/budget.mjs`）: bot のターンが終わるたびに（人が呼んだターンも）、そのターンのトークン（入力・出力・キャッシュの合計）を、その bot のバックエンドの**週の使用枠に対する % の目安**にして、`origin` をたどった根のスレッドの `ThreadState.spend = { day, percent }`（現地の日付。日付が変わると 0 から）に足す。週の枠 1% あたりのトークン = この PC の Pleiad がその枠の期間（解除の時刻の 7 日前から。`usageStore.tokensSince`）に同じバックエンドで使ったトークン ÷ 枠の使用率。枠は `ply_usage` と同じ取得（server の `providerQuota`・`quotaCache`。`host.readQuota`）の、その bot のモデルに効く週の枠（委譲の振り分けと同じ `windowsFor`）のうち、いちばん使われているもの。使用率が 1% 未満・枠が読めない・記録が無いときは最後に分かった値を使い、それも無ければ数えない（止めもしない）。DM は数えない。
  - **残り** = min(1 スレッドの配分 − 根のスレッドの今日の分, チャンネルの 1 日の予算 − チャンネルの全スレッドの今日の分)。設定はチャンネルの定義の任意の欄 `budget = { daily, perThread }`（`core/channels/budget.mjs`。無ければ既定の 1 日 5%・1 スレッド 50%。`daily: null` は予算なし）。1 スレッドの配分 = `daily × perThread / 100`。
  - **bot への見せ方**: 毎ターンの末尾（`turnExtras` の `notes` の最後の `<pleiad-turn-context>`）に「このスレッドの予算の残り: n%（チャンネルの今日の残り: m%）」と、使い切ると bot どうしの呼びかけでは相手が起きないこと（人が呼べば答えられる）を足す。枠が読めないバックエンドは「不明」。予算なしのチャンネル・DM には足さない。「何 % でまとめる」のような型は付けない。
- **使用量の上限で休憩中**（[ADR 0119](adr/0119-channel-budget-and-resting.md)。`core/bots/resting.mjs`）: bot のターンが `limited`（Claude・Codex・Antigravity。Antigravity は上限の文を `core/backends/antigravity-limit.mjs` で `limited` と解除の時刻にそろえる）で終わったら、その bot と同じバックエンド・モデルの bot を解除の時刻まで休憩中にし（メモリだけ。再起動で忘れる）、そのスレッド（DM）に Pleiad のお知らせ「<bot> は使用量の上限に達したので、<時刻> ごろまで休みます。それまでの @ には答えられません」を出す（時刻が分からなければ時刻なしで知らせ、休憩中にはしない）。上限で止まったターンそのものは、Chats の会話と同じく「上限で止まった会話の再開」（`limitResume`）の設定どおりに続きが走る。休憩中の bot への `@`（人・bot・呼んだ bot へ返す返事・ルーティン）は配らず（依頼は預からない。解除の後にもう一度呼んでもらう）、その場所（スレッド・DM）で休憩 1 回につき 1 回だけ Pleiad のお知らせ「<bot> は使用量の上限で <時刻> ごろまで休んでいるので、この依頼は届けていません」を出す。`bots.overview` の `restingUntil` が解除の時刻（ms）。休み始め・休み終えに `botsChanged` を出す。
- **呼ばれて答えたら、返事を呼んだ bot へ返す**（暗黙のメンションではなく「呼んだ相手が答えた」こと）。bot A の `@B`（返事の `@`・`channels.post`・承認された `channels.wake`）で B が起きたとき、出来事に `caller`（A）を残す。B のターンが `ok` で終わったら、B の返事（確定したターンの投稿）を、B のスレッド（無ければ `origin` のスレッド）の A の会話へ、`reply: <B の id>` の出来事として届けて A を起こす。包みは `<pleiad-channel … from="🐺 Lynx (bot)" reply="true">`（固定文: 呼んだ bot の返事は `reply="true"` の包みで返ってくる）。**返さない**のは、人（Chats の AI・ルーティン・外から来た文を含む）が直接起こしたとき・`ok` でない終わり・A のスレッドが止まっている（`ThreadState.stopped`）とき・［止める］を押したあと・B の返事が A への `@` を含むとき（その `@` で起きるので重ねない）・チャンネルの予算を使い切ったとき（上）・A が休憩中のとき（下。休憩中のお知らせを出す）・B が文章を書かずに終えたとき（返事の投稿が無い）。
- **動く承認モードが投稿の主体より強い bot（範囲・自律のどちらかが上。`strongerMode`）は、確認なしには起こさない**。`channels.post`（AI・bot）は ops が宛先を見て、強い bot を `hold` に入れて保存し（`hooks.posted` の `extra.hold`・`checked`）、`channels.wake` の承認カードを出す（許可されたら `dispatch.wakePost` が起こす）。bot の返事の `@`（ops を通らない）は `route` が同じ強さの比較をして、起こさずにスレッドへ知らせの投稿「<bot> は <モード> で動くので、<主体> の返事からは起こしていません。人が @ すると起きます」を残す。人の個別の `@名前`・同じか弱い bot への `@` は確認なし（人の集団宛ては投稿前に人数を確認する）。
- bot が自分のスレッドからチャンネルの流れへ `@` を書いて（`threadId: null`・`new: true`）新しくできたスレッドは、`ThreadState.origin = { channelId, threadId }`（起こした元）を持つ（`extra.origin`）。

**配る**。起こすと、まず `channels/inbox.json` に `pending` の出来事（会話・bot・チャンネル・スレッド・投稿の id。本文は配るときの投稿から組む）を保存してから、会話ごとに直列で配る。
- 走っているターンがあり、`noticeTarget`（`canSteerNotice`）が真なら `control.steer({ id: 'channel-<出来事の id>', args: { prompt } })`。`prompt` は `<pleiad-channel>` の包み（まだ渡していない他の投稿が前にあれば `<pleiad-channel-thread>` で）だけで、末尾（記憶の差分・時刻）は付けない。受理したら `sent`、会話の画面へ `channelEvent` を出す。「渡った」合図を後から出すバックエンド（`steerConfirms`）では `delivering` のまま `userMessage.delivered` を待ち、`dropped` なら `pending` に戻す。受理されない・合図が来ないまま終わった・途中送信できない（Antigravity・圧縮のターン・人の送信待ち）ものは `pending` のまま、**ターンの終わりにまとめて 1 通**の新しいターンで渡す。
- 走っていなければ（`noticeBlocked` が偽）`runTurn({ sessionId, prompt }, () => {}, { internal: true })`。忙しければ 3 秒後にまた。初回（`postCursor` が無い）は、スレッドのそれまでの投稿（30 件・2 万字まで）を `<pleiad-channel-thread>` で、以後は `postCursor` より後の投稿（他の bot の投稿も）を文脈として前に付ける。いちばん後ろの起こした投稿より後ろの投稿は次に渡す。書き途中の他の bot の投稿は文脈に入れず、`postCursor` もその手前まで。自分の会話のターンの投稿は文脈に入れない（会話に入っている）。
- 文脈には、自分のターンの投稿に加え、自分が `channels.post` で書いた投稿も入れない。消された投稿は本文に入れず、`postCursor` が消された投稿を指していてもその位置から続きを選ぶ。
- 結果不明（`steer` が投げた・始める前の失敗）は `unknown` にして**自動では送り直さない**（[ADR 0057](adr/0057-deliver-completion-notice-live.md) と同じ）。始められなかったターンはスレッドに失敗の投稿を足し、スレッドは `failed`。**始めている間に来て途中送信できず `pending` のままの出来事は取り残さず、3 秒後に配り直す**（失敗が続くときは 3 回で止め、次の `@` でまとめて渡る）。ターンの記録ができた（`turnExtras`）後に始まらず戻された（`requeue`）ときは、記録（作業中の投稿を `stopped`）を片付けて出来事を `pending` に戻し、配り直す。終わりが届かなかった記録（次のターンの `turnExtras` が片付ける）の、合図待ちの途中送信は `pending` に、渡している最中の出来事は `unknown` にする（`delivering` のまま固まらない）。アーカイブされたチャンネルの出来事はターンを始めずに捨てる。起動時（`start`）は `delivering` を `unknown` に、`pending` を順に配り直す。`sent` と `unknown` は新しい 100 件だけ残す。会話の `bot` の欄（sidecar）は、書き込み中なら終わってから読む（`commit` の直後の次のターンが古い `postCursor`・`memRev` を読んで、同じ文脈・核の写しを渡し直さない）。
- 「渡った」の確定（`commit`）は、そのターンの最初の応答（`text.delta`・`text.end`・`thinking.delta`・`tool.start`）か、正常終了のとき。ここで `memRev`・`delivered`・`snapshotDue`（`memory.turnContext` の返り）と `postCursor` を会話の `bot` の欄へ書き、出来事を `sent` にする。始める前に失敗したら進めない。

**ターンの投稿**（スレッドの画面は生の流れではなく、これで描く）。ターンが始まる（`turnExtras`）と、そのスレッド（DM なら流れ）に bot の投稿を 1 つ作る（`state: 'working'`、本文は `…`、`turn: { botId, sessionId }`）。本文は、今書いている発言で **1 秒に 1 回まで**書き換える。出すのは**文の切れ目（`。！？`・`. ! ?`・改行）まで**で、**40 字（`PROGRESS_MIN_CHARS`）以上**のものだけ（`a`・`12`・短い独り言のような断片は `…` のまま。1 秒の更新が文の途中に当たって一瞬見えていた）。**道具を呼ぶ前の文章は独り言として引っ込め**（出していたら `…` に戻す）、最終の返答は終わりに `host.lastReply` で置き換わる。**最終の返答は、最後の道具の呼び出しより後の文だけ**（`finalReplyText`。道具の後に文が無ければ、道具の前で終わった最後の文）: `lastReply` がその文で終わるなら前を落とす。Antigravity は 1 ターンの文を 1 つの発言に続けて書くので、`lastReply` に道具の前の独り言（「Let me check the call_op schema.」）まで入っていた。Claude・Codex は道具の前後で発言が分かれるので、`lastReply` のまま。
**bot が `channels.post` で自分のスレッド（DM）へ書いたら、それがこのターンの返事**（[ADR 0117](adr/0117-thread-replies-and-implicit-wake.md)）。`ChannelService.post` が書く前に `hooks.botPost`（`dispatch.claimPost`。ops が呼んだ会話の id を `bySession` で渡す）に聞き、ターンで最初の 1 件はターンの投稿の本文に入れ（`new` の有無によらない。返事は人の投稿の直後の位置に出る）、2 件目からは新しい投稿にする（同じ id を返して前の返事を消さない）。返事を書いたターン（`spoke`）は、**終わりに最終の返答を投稿に書かない**（「#test のスレッドに返事を投稿しました」のような作業の報告で返事を上書きしない。報告は返事の下の作業ログと会話の中に残る）。返事の `@` は、ターンの投稿に入った分も新しい投稿の分も、書いたときに解く（ops の強さの確認と承認カードも同じ）。呼んだ bot へ返す返事（下）は、分けて書いた最後の投稿。bot が書いた本文は途中経過で上書きしない。承認待ちの間は `waiting`。終わりに最終の返答（`host.lastReply`。返事を書いたターンは入れない）・提示（`present`。人の添付と git・作業場所の行は除く）を入れ、`state` を `done` / `failed`（理由つき）/ `stopped` にする。文章を書かずに正常に終わった（リアクションだけ・黙ってやめる）ターンの投稿は消す（[ADR 0119](adr/0119-channel-budget-and-resting.md) の黙る自由。最終の返答が空・bot が本文を書いていない・提示が無い）。使用量の上限（`limited`）で終わったターンは「止めました」も上限の文も bot の発言にせず、何も書けていなければ投稿を消し、書いた分は `stopped` で残す（知らせは上の Pleiad のお知らせ）。Claude・Codex の `usage`（1 ターンの累計）は、書き足した分との差だけ `ThreadState.tokens` へ足す（足すのは **5 秒に 1 回**まで。足すたびに `threads.json` 全体の書き直しと全接続への配信が起きるため。ターンの終わりには残りを必ず足す）。bot が `channels.post` で自分のスレッドへ書いた返事は、最終の返答より勝つ（上。進捗のチェックリストを書き換えたい bot は、自分の投稿を `channels.edit` で直す）。`ThreadState.state` は走っているターン・承認待ち・最後の失敗から決める。前の起動で終わらなかった作業中の印は、起動時に `stopped` / `idle` にする。

Claude・Codex の走っているターンへ途中送信が**届いた時点**で、それまでの返事と提示を今の投稿に確定し、次の返事用に別の作業中の投稿を作る。受領後に表示された返事も、次の道具を呼ぶときは確定して残す。`channels.post` で書いた返事も同じ区切りで残す。届かなかった途中送信では区切らない。Antigravity のように途中送信できない場合は、たまった投稿を次のターンへ渡すので、先のターンの返事は別の投稿として残る。

**止める**（`channels.stopThread` → `dispatch.stopThread`）。保留中（`pending`）の出来事を取り消し、そのスレッドの bot の会話（`ThreadState.sessions`）を、**走っているターンの有無にかかわらず** `abortSessions({ sessionId, reason: 'user' })` で止め（会話を止めると、その会話が `ply_delegate` で作った子のタスクも取り消される。ターンが終わって子だけが走っているときも止まる）、システムの投稿「<誰> が止めました」を足す。誰が止めたかは `ThreadState.stopped.by`。**`ThreadState.origin` で結ばれた派生のスレッド（bot が起こして新しくできたもの。孫も）にも同じことをし、`stopped` の印を残す**（bot が `threadId` を落としても流れへ書き続けても、止めるのはもとのスレッドの 1 回でよい）。

**末尾**（`turnExtras`）。毎ターンの `notes` は `memory.turnContext`（時刻・記憶の差分・関係する記憶。会話の始まりと圧縮の後だけ核の写しが先に付く）と、スレッドならチャンネルの予算の残り（同じ `<pleiad-turn-context>` の最後に足す。上）。圧縮の完了（`onCompacted`）で `snapshotDue = true`・`delivered = []`。人格（`botInstructions`）は S2 が `runArgs` へ載せる。圧縮のターン（`compactTrigger`）には何も足さない。人格・固定の文は変えず、変わるのは末尾だけ（キャッシュの並び）。

**ほか**: Chats の一覧は bot の会話を出さず、あなた待ち（承認・質問）の間だけ出す（一覧の行の `bot` と `running` の承認待ち。画面の絞り込みは `client.mjs` の `renderSessions`）。スマホへは、bot の会話の完了を送らず、失敗・承認・質問は送る。セッション検索は bot の会話を既定で除く（委譲の子と同じ。`includeDelegated` で含める）。

## ルーティン（`core/routines/`・`core/ops/routines.mjs`。R1。[ADR 0112](adr/0112-routines.md)）

定義は `routines.json`（`createRoutineStore`。`version: 1`。読めない版・壊れた JSON は読み込まず上書きしない: `ROUTINES_CORRUPT`・`ROUTINES_UNSUPPORTED_VERSION`・`ROUTINES_UNREADABLE`。サービスは立ち上がるがルーティンは止まる）。`Routine`（型は `core/channels/types.mjs`）に任意の欄を 2 つ足した: `armedAt`（予定を数え始める基準の時刻。作った・再開した・トリガを変えた・発火した時刻）と `last.postId`（その実行の根の投稿）。

- **トリガ**（`schedule.mjs` の `validateTrigger`・`nextFireAt`）: 毎日（`at` と平日だけ）・毎週（`days` は 0=日〜6=土）・間隔（`minutes` と時間帯 `window`）・cron（5 欄。`cron.mjs` に自前。`*`・`a`・`a-b`・`a,b`・`*/n`・`a-b/n`・`a/n`、月と曜日は英語 3 字も。日と曜日の両方を絞ると「どちらかに当たれば」。秒は持たない）・イベント（`on`: done / failed / waiting、`scope`: `'all'` か `{ sessionIds }`）・webhook（`hookId` はサーバーが生成。同じ種類の更新では保持し、別の種類から webhook に変えると新しく生成）。時刻は PC の現地時刻で、毎日・毎週は cron の式に落として同じ関数で次を決める。間隔は「前に動いた時刻から `minutes` 後」で、時間帯の外なら次の帯の頭（`from`）に寄せる（`from` > `to` は夜をまたぐ）。基準は `baselineOf` = `armedAt`（無ければ `createdAt`）と `last.at` のうち後ろのほう。
- **予約**: ルーティンごとにタイマー 1 本（`unref`）。時計は `core/routines/clock.mjs`（`now`・`setTimer`・`clearTimer`。テストは `tests/lib/routines-clock-loader.mjs` で `core/bots-host.mjs` が読むこのモジュールをファイルで進む時計に差し替える）。発火では `armedAt` を今にして次を予約してから走らせる（走るのが遅くても次の予約が遅れない）。一時停止中・出来事・webhook は予約しない。再開（`resume`）は再開した時刻から数え直す（止めていた間の分は走らせない）。
- **取りこぼし**: 起動時（`start`）に、基準の後で今より前の予定が 1 つ以上あれば**最新の 1 回だけ**走らせ（根の投稿に `routine.missed: true`。画面は「Pleiad が止まっていた間の分」）、予約を今から数え直す。一時停止中は走らせない。Pleiad が止まって終わりを記録できなかった実行（`last.state` が `working`）は、根の投稿を `stopped` にする。
- **実行**（`runner.mjs`）: 発火のたびにチャンネルへ根の投稿（`author: { kind: 'routine', routineId }`・`state: 'working'`・本文は「名前」の行と指示・出来事なら続けてきっかけの一行・`routine: { routineId, runId, missed? }`）を立て、bot の**そのスレッドの会話**（`bots.createSession` の `kind: 'routine'`・`routineId`。承認モードは `routine.mode`、そのバックエンドに無ければ bot の今のモード）を作って `ThreadState.sessions` に登録し、`dispatch.wake` で起こす（`dispatch` の `sessionFor` は登録済みの会話をそのまま使う）。実行の会話の承認モードは `routine.mode` で、人が `bots.setMode` で bot のモードを変えても揃えない（`createBotSessions.sync` が `kind: 'routine'` の会話を飛ばす）。実行の履歴 = スレッドの並び。同じルーティンの前の実行が走っている間の発火は「スキップ（`previousRunning`）」の根の投稿を、走っている間に 1 回だけ残す（毎分のルーティンが遅い実行を待つたびに並べない）。bot が居ない（`botMissing`）・チャンネルが無い・アーカイブ済みのときも `skipped`（根の投稿を立てられなければ `last` だけ）。会話を作れない・ターンが 60 秒たっても走り始めない（`START_GRACE_MS`）は `failed`。
- **状態**（根の投稿の `state`。緑の「成功」とは出さない）: `done`（終了）・`checking`（bot が `channels.post` に `state: 'checking'` を付けた＝要確認。`new: true` の別の投稿でも、ターンの投稿でもよい。ターンの投稿に付けたものは終わりで `done` に戻さない）・`failed`（ターンの失敗・使用量の上限・承認の期限で取り消した）・`stopped`（人が止めた・更新・終了）・`skipped`（理由は `routine.reason`）。`routines.list` の `last.state` も同じ。
- **承認待ちの期限**: 実行の会話の承認（`onPermission('open')`）に `approvalTimeoutMin`（既定 30）のタイマーを付け、決着（`'settled'`）で外す。過ぎたらスレッドにシステムの投稿「承認が無かったので取り消しました」を足し、`abortSessions({ reason: 'timeout' })` でターンを止める（`INTERRUPT_REASONS`・`ABORT_REASONS` に `timeout` を足した。中断の理由として会話に残る）。止めた実行は `failed`（バックエンドが拒否を受けて `ok` で終えても「終了」と見せない）。
- **イベントのトリガ**（`events.mjs`）: `onSessionDone`（`ok` → `done`、`error` → `failed`）と `onPermission('open')`（`waiting`）で、`on` と `scope` が当たる有効なルーティンを走らせる。**bot・ルーティン・学習の会話（sidecar `bot` を持つ会話）から来たものは対象にしない**（自分の実行の失敗で自分が動く輪を作らない）。委譲の子は server が渡さない。
- **試しの実行**（`run` の `dryRun`）: 使い捨ての会話（`kind: 'routine'`・スレッドなし）を、そのバックエンドの計画（読み取りのモード。`plan`、無ければ範囲が `readonly` / `none` の最初のもの）で走らせ、チャンネルへは投稿しない（試しの一文を前に付けた指示を内部のターンで渡す。`last` も変えない）。**走り終えるまで待って**（画面の［試しに動かす］は結果を足に出す）返りは `{ postId: null, runId, sessionId, mode, state, summary?, dryRun: true }`: `state` は `done`・`failed`・`stopped`（`working` は 10 分待っても終わらなかったとき。会話はそのまま走り続ける）、`summary` は返事の最初の 1 行（失敗なら理由）。承認待ちには期限（`approvalTimeoutMin`。ただし最大 5 分。画面の前で待っている人のための実行なので）を付け、過ぎたらターンを止めて `failed`（理由は「承認が無かったので取り消しました」）。結果の全文は `sessionId` の会話で読む。計画のモードを持たないバックエンド（Antigravity）は `INVALID`。
- **外から起こす入口**（webhook）: `fire(routineId, { source, note })`。一時停止中は `skipped`（`paused`）。
- **つなぎ目**（`core/bots-host.mjs` の routines の区画）: `onPermission`・`onSessionDone`・`start`・`stop` に加え、`onTurnEnd` は dispatch がターンの投稿を確定した**後**に `routines.onTurnEnd` を呼ぶ（根の投稿の状態を決める）。

## 画面（`web/channels/`）

- `client.mjs` が持つのは `setupChannels(host)` の 1 つの口だけ。返りは `{ onEvent(ev, replay), show(view), hide(), sideTabChanged(tab), contextForPanel(anchor), tab, setTab(tab) }`。`host` と部品（part）の形は `web/channels/index.mjs` の先頭のコメントが正本。部品の一覧への足し方も同じ所（1 行 1 パッケージ）。
- DOM の id・クラス: `#sideTabs`・`#tabChats`・`#tabChannels`・`.tab-dot.mark|.unread`・`html.side-channels`・`#channelsSide`・`.cs-sec[data-sec=channels|bots|routines]`・`.cs-row[data-kind][data-id]`・`body.channels`・`#channelsView`・`#channelsBody`。スレッドの空間モデル（`.deck[data-deck=feed|split|solo]`・`.deck-track`・`#chFeed`・`#chThread`）・投稿（`.post[data-post-id]`・`.post-av`・`.post-head`・`.post-body`・`.reactions`・`.react-pill[data-emoji]`・`.thread-summary`）・入力欄（`.ch-composer`・`#chFeedComposer`・`#chThreadComposer`・`.mention-list`）・`#botView.bot-page`・`#routineSheet` は各パッケージが `#channelsBody` の中に作る。
- CSS はパッケージごとのファイル（`channels-side.css`・`channels-feed.css`・`channels-thread.css`・`bot-page.css`・`routines.css`）。`tests/unit/design-lint.mjs` の `FILES` に入っている。
- **脇**（W1。`web/channels/sidebar.mjs`・`side-model.mjs`・`web/channels-side.css`、Chats 側は `web/side.mjs`）: 部品は `createSidebar(host, () => tabs)`（タブは部品の一覧の後で作られるので関数で受け、最初の描画は `queueMicrotask` で待つ）。`#channelsSide` の 3 つの節の見出しを Chats の状態の見出しと同じ形（`.grp-head`・`.grp-icon`・`h2.grp-name`・`.grp-add`）で作り、行は `.row.one.cs-row[data-kind][data-id]`（`role=button`）。チャンネルは DM を除いて名前順・アーカイブは後ろに弱く（`.quiet`）、未読は太字（`.unread`）、あなた宛ては件数の札 `.mc`。＋はその場に名前の欄（`.cs-new`）を出して `channels.create`、重複などの失敗は欄の下に出す。Bots はアイコン・名前・エージェントのロゴ・状態（待機 / `runMark` の弧 / `.wait` のあなた待ち / 休憩中）。休憩中は、作業中・あなた待ちでなく `bots.list` の `restingUntil` が先のとき（`botState`）。bot のページの見出しも同じ（解除の時刻は title）。状態は `host.state` の会話の `bot.botId` と `runningIds`・`waitingIds` から決める（ターンの始まり・終わりでは `botsChanged` が来ないため。会話が一覧に無い bot だけ `bots.list` の `state`）。bot の行を押すと DM（`channels:show { kind: 'channel', id: dmChannelId }`）、右クリック・Shift+F10 で「DM を開く」「bot のページを開く」、Bots の＋は `channels:show { kind: 'bot', id: 'new' }`。DM を開いている間は bot の行が選ばれて見える。ルーティンの節は W5（下の「ルーティンの編集」）。読むのは `channels.list`・`bots.list`（出来事 `channelsChanged`・`channelPost`・`channelRead`・`channelThread`・`botsChanged` で 150ms まとめて読み直す。接続の前に読めなければ次の出来事で読み直す）。一覧は Tab 1 回で入り、↑↓・Home・End で移り、Enter・Space で開く（`click()` を通すので、狭い画面では引き出しも閉じる）。検索欄の ↓ で入り、先頭の ↑ で検索欄へ戻る。タブの札の点は `side-model.mjs` の `tabDots`: Channels は承認待ちの bot・あなた宛ての投稿があれば ◆、未読だけなら青、Chats は `side.attention()`（あなた待ちの会話・未読の会話）。
  - `web/side.mjs` の口: `setDirectory({ channels, bots })`（bot の会話の行の印と検索のチャンネル名）・`connectChannels({ matchNames, searchPosts, open, active, enterList })`（検索の横断）・`attention()`・`onRender(fn)`（一覧を描き直したら呼ぶ）。client が渡すあなた待ちの bot の会話（`s.bot`）は利用者の状態のグループに入れず、一覧の先頭（全グループの上）に「◆ あなたを待っている」の見出し（`section.grp.bot-waits`。見出しは木の項目にしない）を付けて行（`.row.botwait`、level 1）を置く（計画 §7.2-4: いちばん上で目に入る位置）。題は会話の題の「 › 」の後ろ（根の投稿の頭）、印 `.row-ch` は bot のアイコンと `#チャンネル名`（DM は「DM」。チャンネルの一覧をまだ読めていなければ会話の題「🦉 Owl · #名前 › 頭」から取り、id は出さない）、つかんで状態へは落とせない。検索は同じ欄（`#q`）で両方を探す: チャンネル名の一致を先頭に、投稿の当たり（`channels.search`。会話の本文と同じ問い合わせで）を会話の後ろ（新しい順なら時刻で混ぜる）に置き、行に出どころ `.row-src`（「Chats」「#チャンネル」）を添える。Chats の絞り込みをかけている間はチャンネルを探さない。Channels のタブでも語がある間は結果（`#groups`）を出す（`html.side-searching`）。Channels のタブでは絞り込みのボタンを隠す（Chats だけの絞り込みのため）。
- **bot のページ**（W4。`bot-page.mjs`・`memory-list.mjs`・`bot-model.mjs`・`web/bot-page.css`）: `show({ kind: 'bot', id })` で出る（`id` が `'new'` なら作る画面）。開く口は `document.dispatchEvent(new CustomEvent('channels:show', { detail: { kind: 'bot', id } }))`（脇の Bots の行・＋は `id: 'new'`、DM の見出しの bot の名前・記憶の出どころからの移動も同じ入口）。`#channelsBody` いっぱいに `section#botView.bot-page`（作る画面は `.is-new`）。メインの頭（`#channelsView > .top`）は `.bot-top` を付けて畳み、汎用の見出し「Channels」は読み上げにだけ残す（見出しはページ自身の頭。付け外しは `show` / `hide`。流れの `hide()` が見出しを戻した後に外す）。名前・アイコン（`openEmojiPicker`）・人格は離れたとき `bots.update`、エージェント・モデル・エフォートは入力欄と同じ面（`renderModel`）で `bots.update`、承認モードは入力欄と同じ面（`renderMode`）で `bots.setMode`、フォルダー（`bots.update` の `folders`）・他の会話に送る（`sendToOthers`）。フォルダーを「すべてのフォルダー」で非活性にするのは**範囲 `full` のモード**だけ（Claude の YOLO・Codex の YOLO・Antigravity の yolo。Codex の全部自動は sandbox が作業場所に書き込みを限るので活性のまま。`foldersUnlimited`）。Antigravity は承認モードが 1 つだけなので、その事実を 1 行添える。右に記憶の一覧（`memory.list`・`memory.edit`・`memory.forget`・`memory.unforget`。更新は `memoryChanged`。頭に夜の整理の様子の 1 行（`memory.learnStatus`）、各行に種類の札と薄れた記憶の印。[ADR 0118](adr/0118-memory-strength-and-learner-runs.md)）と今週の使用量（`bots.get` の `usage`）。作る画面は名前・アイコン・人格・チップだけで、作ると（承認モードが既定と違えば `bots.setMode` も呼んで）その bot のページに替わる。DOM: `#botName`・`#botPersona`・`#botModelChip`・`#botModeChip`・`#botModelPop`・`#botModePop`・`#botAddFolder`・`#botFolderPop`・`#botSendSwitch`・`.bp-create`・`.bp-dm`・`.bp-fold`・`.memcore[data-layer=user|own]`・`.mem`。画面の打鍵は `tests/browser/bot-page.cjs`。絵文字ピッカー（`openEmojiPicker`）を開く押下では `e.stopPropagation()` する（`web/side.mjs` の document の click が `closePops` でピッカーを閉じ、開いた直後に消えるため。リアクション（W2）も同じ）。
- **ルーティンの編集**（W5。`routine-sheet.mjs`・`routine-entry.mjs`・`routine-store.mjs`・`routine-model.mjs`・`web/routines.css`。承認済みのモック 06、[ADR 0112](adr/0112-routines.md)）: 操作はすべて `host.invoke('routines.*')`（新しい WS コマンドは足さない）。
  - **入口**（`document` の `channels:routine`、detail は `{ routineId }` で編集・`{ channelId?, botId? }` で新規）: チャンネルの見出しの［ルーティン n］（`feed.mjs` の見出しが `headingButton(host, channel)` を置く。ルーティンが無ければシートを開き、あれば「そのルーティン… / ルーティンを作る」のメニュー）・脇のルーティンの節の＋と行・bot のページの「ルーティン」の節（`createRoutineSheet` の `show({ kind: 'bot' })` が `#botView` の左の列の末尾へ差し込む。`bot-page.mjs` は触らない）。
  - **シート**（`dialog#routineSheet`。広い画面は浮く面、700px 以下は全画面）: 名前 / いつ（毎日・毎週・間隔・cron・イベント・webhook）/ 誰が（bot）・どこで（チャンネル）/ 何を / 承認モード（入力欄と同じ `renderMode`。既定は bot のモード、ただし「確認なし・制限なし」は写さず語彙の既定）/ 承認待ちの期限 / ［試しに動かす］［取り消す］［作る］。保存済みは「状態（有効 / 一時停止）」「前回の結果」「［削除］（2 度押し）」が加わる。時刻は PC の現地時刻、曜日は 0=日 … 6=土（`weekly.days`）。毎日・毎週・cron は「次は 10/6（月）9:00」を画面側で見積もる（`routine-model.mjs` の `nextRun`。保存済みの `nextAt` が正で、これは編集中の目安）。
  - **試しに動かす**: `routines.run { routineId, dryRun: true }` は保存済みのルーティンを取る。新しい下書きは `routines.create { …, paused: true }`（返りが一時停止でなければ `routines.pause`）で作ってから走らせ、［作る］で `routines.resume`、取り消す・閉じるで `routines.delete` する。保存済みのルーティンは、直した内容を先に `routines.update` してから走らせる。返りの `state`（既定は `done`）と `summary`（任意の 1 行）を足に出す。
  - **一覧の写し**（`routine-store.mjs`。host ごとに 1 つ）: `routines.list` の返り（`{ routines }` か配列。各行は `Routine` + `nextAt`）を読み、出来事 `routinesChanged`（`routine` は上書き、`removed` は外す。`nextAt` が無ければ古い値を保つ）で更新して 250ms まとめて読み直す。操作が無い・つながっていない間は空のまま。脇は次に動く時刻の近い順に 3 件（時刻の無いイベントのもの → 一時停止の順で後ろ。多ければ［ほか n 件を見る］）、一時停止は薄く（`.paused`）、直近の失敗（`last.state === 'failed'`）は「✕ 失敗」。
- 辞書は `web/locales/{ja,en}/channels.json`（節 `side`・`feed`・`thread`・`bot`・`memory`・`routines`・`event`。節ごとに持ち主が決まり、読んで書き直さず文字の置き換えで足す）と `agent.json`（`ops.channels|bots|memory|routines`・`guide.bot`・`channel.envelope`・`routine`）。コードでは `t('channels:feed.empty')`。
- スレッドを開く口: `host.openThread(channelId, threadId)`（`setupChannels` が足す）は、部品の `openThread(channelId, threadId)` へ配り、`document` へ `channels:openthread`（`detail: { channelId, threadId }`）も投げる。呼ぶのは流れ（W2。要約の行・「スレッドで返信」）、受けるのはスレッド（W3）。開く入口は `document` へ `new CustomEvent('channels:show', { detail: { kind: 'channel', id, threadId? } })`（脇の行・テストから。`show(view)` と同じ）。
- 流れ（`web/channels/feed.mjs`）: 見出し（`# 名前`・目的・メンバーのアイコン・⋯のメモと設定（`feed-settings.mjs`。名前・目的・作業フォルダー・メンバー・予算（1 日 n%・1 スレッドまで n%、ヒントに今日の使用。1 日を空にすると予算なし）・ここでの決まり））はメインの頭（`#channelsView > .top`）に出し、`#channelsBody` に `section#chFeed.ch-feed`（`.ch-log` と `#chFeedComposer`）を作る。投稿は `post.mjs`、札は `reactions.mjs`、`@` の補完は `mention-complete.mjs`、入力欄は `ch-composer.mjs`（`createChComposer`。スレッドの入力欄 `#chThreadComposer` も同じ部品）。**入力欄の操作は Chats に揃えてある**（[ADR 0116](adr/0116-channel-composer-attachments.md)）: 字の欄は `md-editor.mjs`・送信は Ctrl/⌘+Enter・行の上限は `composer-layout.mjs` の `promptMaxHeight`・添付（クリップ・貼り付け・ドロップ・札・「添付 N 件 ▾」・送っている途中の進み具合と再試行・送れない理由）は `ch-attachments.mjs`（断片の送り手 `attach-upload.mjs`・一覧の面 `attachment-list.mjs` は Chats と共有。置き場の分け先はチャンネルの id）・書きかけは入力欄ごと（`feedDraftKey` / `threadDraftKey`）に localStorage（`agent-host-channel-drafts`。60 件まで）・DOM を触らない決まりは `ch-attach-model.mjs`。モデル・エフォートのチップは持たない。投稿の本文は添付があれば `post.mjs` の `attachedBodyHtml`（印の位置に画像の縮小・ファイルの札）で描き、画像を押すと `host.openImage`（Chats のライトボックス）。Channels の画面に落としたファイルは Chats の入力欄へ入れない（`client.mjs` の受け口が `#channelsView` を除く）。読み書きは `channels.read / post / react / markRead / get / update / archive` と `bots.list`（定義が引けなくても投稿は出る）。
- **スレッドと空間モデル**（W3。`deck.mjs`・`thread.mjs`・`thread-head.mjs`・`thread-tools.mjs`・`thread-toc.mjs`・`web/channels-thread.css`。[ADR 0111](adr/0111-thread-spatial-model.md)）:
  - **窓**: `#channelsBody > #chDeck.deck[data-deck=feed|split|solo] > #chFeed + #chThread`。`createThread` が流れの板（`#chFeed`）を窓へ移し、流れの見出し（`#channelsView > .top`）も流れが出ている間は `#chFeed` の頭に置く（スレッドの見出しと横に並ぶ。流れが無い面＝bot のページでは元の位置）。右パネルは body の 3 列目なので、窓が持つのは 2 枚だけ。状態は `deckState({ hasThread, panelOpen, width })`: スレッドが無ければ `feed`（流れが全幅）、右パネル（`body.file-preview-open`）が開いているか窓（= main）の幅が 900px 未満なら `solo`（スレッドだけ全幅。流れは左へ抜ける）、そうでなければ `split`（流れ 4｜スレッド 6）。760px 以下の右パネルは今までどおり全画面（Chats と同じ）。
  - **動き**: 状態が替わるとき、2 枚を「前にあった位置」から「今の位置」へ transform で滑らせるだけ（FLIP。`--dur-deck` = 200ms。流れは幅も動く。動きを減らす設定では 0 で切り替えだけ）。中身は作り直さないのでスクロール位置・下書き・入力欄の位置が保たれる。窓の外の板は `visibility:hidden` と `inert` で隠すだけ（DOM も下書きも残す）。動いている間は `.deck.moving`（隠れる側も見せる・流れの入力欄は畳んだまま）。ほかのスレッドを押したときは `data-deck` が変わらないので板は動かず、中身だけ入れ替わる。
  - **入力欄**: 流れ側（`#chFeedComposer`）はスレッドが開いている間、押す（フォーカス）まで 1 行に畳む。スレッド側（`#chThreadComposer`）は作業中でも書ける（途中送信）。スレッドを開くとフォーカスはスレッド側へ。下書きはスレッドごとに覚える。チャンネル側で bot を `@` した投稿は、その場で新しいスレッドを開く。
  - **見出し**（`.th-top`）: 左にチャンネルが見えている間（`split`）は「› スレッドの題」だけ、スレッドだけのとき（`solo`）は「# チャンネル名 › スレッドの題」で、チャンネル名を押すと流れに戻る（スレッドを閉じる）。題は根の投稿の最初の行（先頭の `@` は外す）。右は入口（目次・git・内蔵ブラウザー）と ✕。入口は右パネルの道具で、bot の会話（そのスレッドで最後に動いた bot）を基準にする: 目次 = スレッドの投稿の一覧と検索（`thread-toc.mjs`）、git = 既存の `ply-git-open` に会話を渡す（作業場所が git のときだけ出す）、内蔵ブラウザー = `host.browser`（デスクトップ版のホストの画面だけ）。開いている右パネルのファイル・可視化の基準は `contextForPanel` が返すその会話。
  - **中身**: 根の投稿 → 「N 件の返信」→ 返信（`post.mjs` の `renderPost`。返信の道具は出さない）。bot のターンの投稿には、**返事の下に畳んだ「作業ログ」**（`details.th-worklog`。見出しは「作業ログ · ツール n 件」、最初は閉じている。中身は、返事の本文以外の AI の文（道具の前の独り言・終わりの報告）と道具の行（Chats と同じ `Bundle`）を発言の順に。発言の文が返事で終わる（Antigravity の形）なら、その前の部分だけ。材料は bot の会話の履歴 `loadSession`＋走っている分の出来事。ターンの投稿の `at` から同じ会話の次のターンの投稿の `at` までの AI の発言。`thread-tools.mjs` の `logInWindow`。[ADR 0117](adr/0117-thread-replies-and-implicit-wake.md)）・進捗のチェックリスト（本文の `- [x]` / `- [ ]`。`post.mjs` の `paintChecklist`。流れでも同じ）・提示（可視化はインライン、`host.renderPresent`。広げる・ファイルのリンク・HTML は右パネル）が付く（スレッドがそのまま bot の作業の会話の画面なので、「会話を開く →」は置かない。会話そのものを開く入口は投稿の ⋯ の「会話を開く」）。システムの投稿は静かな一行。作業中の「作業中」「あなた待ち」の状態の行はスレッドでは出さない（帯・進捗の弧・承認のカードが語る）。
  - **帯**（`.th-band`）: 作業中は「🦉 Owl が作業中（複数なら ⇄ でつなぐ）· 呼び合い n 回 · このスレッドで 12.3k トークン」と［止める］（`channels.stopThread`）、あなた待ちは「◆ … があなたを待っています」、止めたあとは「止めました」。作業していないときはトークンだけを静かに出す（0 なら出さない）。そのスレッドが今日予算に数えた分があれば「予算 0.8% / 2.5%」（使った分 / 1 スレッドの配分。`ThreadState.spend` とチャンネルの `budget`）を足す。
  - **承認**: そのスレッドの会話の `permission` を `host.permissionCard(ev, perms)`（質問は同じ口で質問のカード）でスレッドの中（`.th-perms`）に出す。どちらで押しても `resolvePermission`。別の画面で答えたものは `running` の後に外す。
  - **既読**: スレッドを見て末尾にいる間は、最後の返信まで `channels.markRead` を進める（流れの既読は流れの投稿だけを見るため）。
  - DOM: `#chDeck`・`#chThread`・`.th-top`（`.th-crumb`・`.th-chan`・`.th-title`・`.th-toc`・`.th-git`・`.th-browser`・`.th-close`・`#chThreadOpenSidebar`）・`.th-log`・`.th-rdiv`・`.th-tools`・`ul.ck`・`.post-presents`・`.th-perms`・`.th-band`・`#chThreadComposer`。流れ側で開いているスレッドの根の投稿は `data-open`。
  - `host` に足した口（`web/client.mjs` の `setupChannels` の引数）: `browser`（内蔵ブラウザーの部品。使えない画面では null）。`permissionCard` は質問のカードも出す。
- Chats の一覧は bot の会話を出さない（あなた待ちの間だけ。`client.mjs` の `renderSessions`）。右パネルの作業場所の基準は `contextForPanel`。

## スレッドのエピソードと申し送り

スレッドが 3 分静かになると、そのスレッドで話した bot ごとに、何を話し、何を決め、誰が何を引き受けたかの要約を作る（[ADR 0125](adr/0125-bot-episodes.md)）。要約は `ThreadState.digest[botId]` に保存する。材料は taint のない人の投稿と、その bot の確定済み投稿だけ。モデルが選んだ長く残す決定・約束・好みは、夜の整理と同じ `memory.write` / `memory.edit` の出どころ検査を通して、その bot の記憶に書く。

新しいスレッドの最初の bot ターンには、最近 5 スレッドまでの id・題・要約の冒頭（合計 1,300 字まで）を `<pleiad-bot-recent>` で、核の写しの後に 1 回だけ添える。詳しい投稿は `channels.read` で引ける。ほかの bot の投稿・taint のある投稿の本文は申し送りに入れない。圧縮時に核の写しを作り直しても、申し送りを繰り返さない。

## 記憶の強さ

記憶の行は任意の種類 `k`・重み `w`・状態 `st` を markdown の行末のメタに持つ（`<!-- {"id":…,"k":"promise","w":3,"st":"open"} -->`。[ADR 0118](adr/0118-memory-strength-and-learner-runs.md)）。強さ ＝ 重み × 0.5^(経過日数 ÷ 半減期) を、読むたびに今の時刻から計算する（`core/memory/strength.mjs`。保存しない）。経過は最後に書いた・直した時刻から。

| 種類 | 重みの既定 | 半減期 |
|---|---|---|
| 人が書いた・直した行（`by.kind === 'human'`） | 3 | 薄れない |
| `stop`（やめたこと） | 3 | 薄れない |
| `promise`（約束） | 3 | 薄れない（`st: 'done'` は 7 日） |
| `decision`（決めたこと） | 3 | 180 日 |
| `share`（分担）・`pref`（好み・直し） | 2 | 60 日 |
| `note`（その他） | 1 | 30 日 |
| 種類なし（前の版が書いた行など） | 2 | 60 日 |

行の `w` は既定より優先する。`parseLayer` は知らないキーを捨てずに持ち、書き直しで戻す（版の印 `v1` は変えない。前の版の行はそのまま読める）。画面の記憶の一覧は、各行に種類の札と、薄れた記憶の「薄れた」の印を出す（`memory.list` の行の `strength`・`faded`）。

## 夜の記憶の整理

`createBotHost` は `core/memory/learn.mjs` を内部の毎日の予約として起動する。既定は現地時刻 02:00。PC が止まっていた予定は起動時に 1 回だけ実行する。利用者の `routines.list` には出ず、チャンネルにも投稿しない。`settings.set` の `memoryLearnBackend`（空なら会話の既定）、`memoryLearnAt`（HH:MM）、`memoryLearnPaused` で変更できる。いずれも AI から変更できる write の設定。

予定の時刻を過ぎてその日の分がまだなら走る。**ほかの会話のターンが走っていても待たない**（learner は自分の隠れた会話で走る。以前は全部のターンが 0 になるまで待ち、委譲の子や bot がいつも動いていて一度も走れなかった。[ADR 0118](adr/0118-memory-strength-and-learner-runs.md)）。待つのは learner 自身が走っている間・止めている間・失敗の後の間隔（15 分から倍に、6 時間まで）だけ。走っているターンの会話（`sessionBusy`）は読まずに次の回へ回す。予定の回の `lastRunAt` は始めた時刻。最後の結果・飛ばした回数と理由・失敗は `memory_state` の `meta` / `status` に残し、`memory.learnStatus` と bot のページの記憶の欄の頭の 1 行で見せる。読む量: 最後まで読んだ会話は、その時の更新時刻（`cursor.seen` の行）から変わるまで読み直さない。読むのは 14 日以内の発言・投稿（一度も走っていない置き場の最初の回は 3 日）。1 回に 40 束（200 件）までで、残りは次の回（`lastResult.more`）。`runNow({ scope: { sessionIds, channelIds } })` はその会話・チャンネルだけを読み、予定の回には数えない（スレッドが静かになった後の整理の口）。学習用会話には種類と重みも付けさせ（`kind`・`weight`・`status`）、`memory.write` / `memory.edit` の重みの上限を通す。

夜の整理の進みは DB の `memory_state`（`kind` が `cursor.sessions`・`cursor.posts`・`cursor.postOffsets`・`cursor.seen`（最後まで読んだときの会話の更新時刻）の行と、`meta` の `lastRunAt` の行。以前の `memory/learn-state.json` の `{ cursor: { sessions: { [id]: messageIndex }, posts: { [channelId]: postId }, postOffsets: { [channelId]: byteOffset } }, lastRunAt }` と同じ中身を、1 カーソル 1 行にした）。会話は更新時刻が変わったものの未読 index 以降、チャンネルは追記ログの未読 byte offset 以降だけを読む。人の通常の user 行と taint のない人の投稿を最大 5 件ずつ時刻順で学習用会話（sidecar `bot.kind: 'learner'`）へ渡す。共通層への 1 ターン 5 件の書き込み上限に合わせ、残りは次の束で読む。新しい材料がないときはエージェントを呼ばない。失敗時はカーソルを進めず、次回やり直す。

学習用会話は既定の bot と同じバックエンド・モデル設定に従い、読み取りモードで候補の JSON を返す。人が直前の AI の答えを明示的に採用した発言では、その答えも文脈に含める。候補の出どころは番号から実物の人の発言（採用した場合は AI の答えも）を引き、既存の `memory.write` / `memory.edit` の出どころ検査を通して 2 層へ書く。重複は書かない。古い記憶と矛盾すれば、AI が書いた行は直し、人が書いた行は新しい行を足して古い行の理由に「新しい記憶で置き換わった」の印を残す。その日に新しく増えた行は bot のページに小さな印が出る。

## テスト

`tests/run.mjs` にパッケージごとの区画のコメントがある（自分の区画の下にだけ足す）。fake バックエンドは、包みで始まる prompt の台本を、包みを外してから選び（`<pleiad-channel>` の中身は `@名前` を除いて台本）、`notes:` / `instructions:` の台本で Pleiad が足した `notes`・`botInstructions` を返し、`AGENT_HOST_FAKE_USAGE=1` で固定の `usage` を、`AGENT_HOST_FAKE_SLOW_STEER=1` で `slow` に途中送信を持たせる。`tests/unit/ops-surface.mjs` の T6 の deps に `channels`・`bots`・`memory`・`routines` の空の物がある。`tests/ops-surface.snap.json` は、パッケージの最後に取り直す（同時に直さない）。
- bot の返事の `@` だけで次の bot を起こすテストは、人の投稿に `@` を書かない形にする（人の `@` でも起きて、返事の連鎖を確かめられない）。fake の `steps:` 台本の本文に `\\u0040Lynx slow` と書くと、台本が `@Lynx slow` に戻して返事にする。テストごとに `channels.dir` を分ける（`inbox.json` が前のケースの出来事を拾う）。

## webhook

`POST /hooks/<hookId>` は画面のトークンの確認より前に受ける。本文は生のバイト列で最大 256 KiB、口ごとに毎分 30 回。不正な署名・時刻・大きさ・回数・存在しない口・内部の失敗も、空の `202` を返す。`202` は実行の成功を意味しない。結果は実行のスレッドで確かめる。

- `X-Pleiad-Timestamp` は Unix 時刻の秒（整数）。`X-Pleiad-Signature: sha256=<64桁のhex>` は `HMAC-SHA256(secret, "<timestamp>.<raw body>")`。時刻は受信時の ±5 分まで。JSON を整形し直さず、送るバイト列をそのまま署名する。
- GitHub の `X-Hub-Signature-256` は本文だけの HMAC。Pleiad の署名が同時にある場合はそちらを検査し、不正なら拒否する。定数時間で比較し、同じ口の同じ署名を 10 分間捨てる（大文字・小文字の hex は同一）。再送の記憶と回数枠はプロセス内に持ち、再起動で消える。GitHub 形式は時刻を持たないため、10 分後の再送は新しい実行になる。
- 秘密は `createSecretStore` の `webhook-secrets.json` に保存する。デスクトップでは利用可能な OS の暗号化を使い、通常の Node 起動では権限 0600 の平文になる。定義の取得・一覧・出来事には秘密を含めない。再発行すると古い秘密は使えなくなる。操作の `humanSecretOutput` は human-only かつ UI 専用の定義だけに許し、人の UI 応答だけ共通の伏せ字を外す。
- 本文は `routine.payload` に説明の一行と `<routine-payload source="webhook" hook="h_…" at="…">…</routine-payload>` の形で保持し、実行時の `notes` に渡す。本文内の包みのタグはエスケープする。投稿本文の 2 万字上限は変えない。`Post.routine.payload?: string` と `SessionBot.taint?: 'webhook'` は追加の任意欄。
- 根の投稿・そのスレッドの投稿・実行の会話、およびその会話から別の場所へ書いた bot の投稿に `taint: 'webhook'` を付ける。`memory/guard.mjs` は発言者にかかわらず taint のある投稿・会話の発言を記憶の根拠から除く。
- シートで webhook を選んで保存すると、受け口の URL・［URL を写す］・［秘密を作り直す］が出る。新規保存ではシートを開いたままにする。新しい秘密はその場だけ表示・コピーでき、閉じる・種類を切り替えると消える。外部へ届かせるには利用者のトンネルが必要。URL は開いている画面の origin を使うため、ホストの画面で取得する。relay 接続の画面では URL の代わりにその案内を表示する（端末内プロキシは受け口にならない）。
- relay は `/hooks` 以下を通さない。一時停止中の受信は `fire` が `skipped` にし、新しいスレッドを立てない。

署名・時刻・再送・大きさ・回数・応答・秘密の出し分け・taint・relay の拒否は `tests/unit/webhook.mjs` で確かめる。
