# Channels・bot・記憶・ルーティン

bot（名前・人格・記憶・権限を持つ定義）と、人と bot が集まる Channels、定期の仕事のルーティンの、**今の動きと各モジュールの契約**。決めた理由は ADR 0093〜0101（[0093](adr/0093-bots-channels-routines.md) 全体、[0094](adr/0094-side-chats-channels-tabs.md) 脇のタブ、[0095](adr/0095-channel-posts-source-of-truth.md) 投稿の正本、[0096](adr/0096-bot-and-dispatch.md) bot と起こし方、[0097](adr/0097-bot-memory.md) 記憶、[0098](adr/0098-thread-spatial-model.md) スレッドの空間モデル、[0099](adr/0099-routines.md) ルーティン、[0100](adr/0100-webhook-receiver.md) webhook、[0101](adr/0101-send-on-your-behalf.md) 代わりに送る）。

**今の状態:** つなぎ目と空の入れ物まで（脇の Chats / Channels の 2 タブ・空の `#channelsView`・各モジュールの工場）。チャンネル・bot・記憶・ルーティンの中身は、段ごとに入る（下の「モジュールと持ち主」）。

## データ

型の正本は `core/channels/types.mjs`（JSDoc）。置き場は `<データ置き場>/` の下:

| もの | 場所 |
|---|---|
| チャンネル・DM の定義と既読 | `channels/index.json` |
| 投稿・編集・リアクション（追記だけの操作の記録） | `channels/<channelId>.jsonl` |
| スレッドの状態 | `channels/threads.json` |
| bot へ届ける前の出来事 | `channels/inbox.json`（状態 `pending → delivering → sent / unknown`） |
| bot の定義 | `bots.json` |
| 記憶（正本）・変更の記録・索引 | `memory/user.md`・`memory/bots/<botId>.md`・`memory/log.jsonl`・`memory/index.sqlite` |
| ルーティン | `routines.json` |
| webhook の秘密（P3）・学習の進み（P3） | `webhook-secrets.json`・`memory/learn-state.json` |

- 新しいファイルは `{ version: 1 }` を持つ。読めない版は読み込まずに画面へ出して止める。`DATA_SCHEMA` は上げない。
- id は `core/channels/types.mjs` の `newId(kind)`（`c_` `p_` `b_` `m_` `r_` `h_` `i_`）。
- 会話（sessions.json）の新しい欄: `bot`（`SessionBot`。botId・種類・チャンネル・スレッド・記憶の進み）と `proxySends`（P3。代わりの送信の見分け）。使用量の記録（usage.json）に `sessionId`（足す前の分は無い）。一覧の行（`sessionRow`）に `bot: { botId, kind, channelId, threadId } | null`。
- 会話の言語・題・モード・モデル・エフォートは普通のセッションと同じ（委譲の子の作り方 `prepare` と同じ手順）。

## モジュールと持ち主

| ファイル | 中身 | 持ち主 |
|---|---|---|
| `core/bots-host.mjs` | 下の各モジュールを束ね、`server.mjs` にだけつなぎ目を出す `createBotHost(deps)` | P0（区画ごとに持ち主） |
| `core/channels/types.mjs` | 型・id・発言者の検査・包みの組み立て（`channelEnvelope` ほか） | P0 |
| `core/channels/service.mjs`（`createChannelService`）・`store.mjs`・`mentions.mjs`・`threads.mjs` | チャンネル・投稿・リアクション・既読・スレッドの状態・@ の解析 | S1 |
| `core/bots/service.mjs`（`createBotService`）・`store.mjs`・`sessions.mjs` | bot の定義・bot の会話の作り方・人格の文 | S2 |
| `core/memory/service.mjs`（`createMemoryService`）・`store.mjs`・`index.mjs`・`tail.mjs` | 記憶・索引・ターンの末尾 | S3 |
| `core/bots/dispatch.mjs`（`createDispatcher`） | @ から起こす・途中送信・ターンの投稿・止める・トークンの集計 | S4 |
| `core/routines/service.mjs`（`createRoutineService`）・`cron.mjs`・`schedule.mjs`・`runner.mjs`・`events.mjs` | ルーティン | R1（P2） |
| `core/routines/webhook.mjs`（`createWebhookReceiver`） | `/hooks/<id>` | H1（P3） |
| `core/ops/{channels,bots,memory,routines}.mjs` | 操作（`defineOp`）。空の配列から始まる | それぞれ S1 / S2 / S3 / R1 |
| `web/channels/` | `setupChannels(host)`・`side-tabs.mjs`・各画面（`sidebar` `feed` `thread` `bot-page` `routine-sheet`） | P0 / W1〜W5 |

各工場の引数と返りの形は、そのファイルの先頭のコメントが正本。`createBotHost` は工場を束ね、`ChannelService.hooks`（`posted`・`stopThread`）で逆向きの口を配線する。

## サーバーのつなぎ目（`core/server.mjs`）

`server.mjs` が呼ぶのは `botHost`（`createBotHost` の返り）だけで、どれも例外を外へ出さず、bot の会話でなければ何もしない。

| つなぎ目 | 呼ぶ場所 |
|---|---|
| `opsDeps()` | `opsDeps` に `channels`・`bots`・`memory`・`routines`・`botOfSession(sessionId)` を足す |
| `turnExtras(turn)` → `{ botInstructions, notes }` | ターンの組み立て（`runArgs`）。`notes` は既存の中断の文の後ろ。`botInstructions` は新しい欄で、各バックエンドが人格の並びの最後に足す（S2） |
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

id は `<領域>.<動詞>`（ドットは 1 つ）。human-only は承認モード・秘密の値・アカウント・接続先の既定・リモートのペアリングの 5 つだけ（[ADR 0082](adr/0082-control-surface-principals-and-risk.md)）。消す操作は guarded。**直のツール（`mcp: 'direct'`）は 1 つも足さない**（`ops-surface` の T4 の余りが小さい）。新しい WS のコマンドも足さず、画面は `cmd('invoke', { op, args })`。失敗の code は辞書 `agent:ops.errors.<CODE>` と `tests/unit/ops-surface.mjs` の `ERROR_CODES` の両方（T7）。read の操作は T6 のスタブ deps と `samples` に足す。

| op | 危険度 | 備考 |
|---|---|---|
| `channels.list` / `get` / `read` / `search` | read | `read` は `{ channelId, threadId?, before?, limit≤100 }` → `{ posts, threads, nextBefore }` |
| `channels.create` / `update` / `archive` | write | 消さない（archive） |
| `channels.post` | write・`modeGate: false` | 発言者は主体から決める（human / 束縛された会話が bot なら bot / それ以外の AI は agent / 束縛なしの CLI は `NEEDS_UI`）。`new: true` で新しい投稿、無ければそのターンの投稿の本文を置き換える |
| `channels.edit` / `delete` | write | 自分の投稿だけ |
| `channels.react` | write・`modeGate: false` | 絵文字 1 つ（`web/emoji.mjs` の `EMOJI_RE`）。人も bot も同じ操作 |
| `channels.markRead` | write（AI・CLI にも出す） | |
| `channels.stopThread` | write・`modeGate: false` | `stopped.by` に止めた主体を残す |
| `bots.list` / `get` | read | `usage: { weekTokens, cacheRatio }`・`state` を付ける |
| `bots.create` | write（AI は `riskOf` で guarded） | 既定の弱いモード |
| `bots.update` | write（範囲を広げる向きは `riskOf` で guarded） | 名前・アイコン・人格・backend（次の新しい会話から）・`folders`・`sendToOthers`・`sendTargets`。広げる向き = フォルダーを足す・送る先を足す・`sendToOthers` を ON にする |
| `bots.setMode` | human-only | 承認モード（`mode`）だけ |
| `bots.delete` | guarded | |
| `memory.list` / `search` | read | `search` は `limit≤8`・各 150 トークンまで |
| `memory.write` | write・`modeGate: false`（CLI は無し） | 出どころの検査（`MEMORY_SOURCE`・`MEMORY_REJECTED`） |
| `memory.edit` | write | AI も使える。人がしたか AI がしたかは `log.jsonl` の `by` |
| `memory.forget` | guarded | 消す操作。墓石を残す |
| `routines.list` / `get` | read | `nextAt` を付ける（P2） |
| `routines.create` | write（AI は guarded） | |
| `routines.update` | write（頻度を上げる・モードを強くする・対象を広げる向きだけ guarded） | `riskExamples` を書く |
| `routines.pause` / `resume` / `run` / `delete` | write / guarded / guarded / guarded | `run` は `dryRun?`。消す操作は guarded |
| `routines.rotateSecret` | human-only | P3 |
| `sessions.send` | write | P3。AI 全般が使える（bot だけの操作にしない）。`{ sessionId, text, reason? }`。bot に束縛された主体のときだけ `sendToOthers`・`sendTargets` を追加で確かめる。別の作業が先に定義したらそれを正とする |

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
| `<pleiad-channel channel thread post from at>本文</pleiad-channel>` | `prompt`。起こした投稿・途中送信する投稿 1 件 | `kind: 'channelEvent'`（`history: false`） |
| `<pleiad-channel-thread channel thread>…</pleiad-channel-thread>` | `prompt`。初回のスレッドの履歴（中に `<pleiad-channel>`） | `kind: 'channelEvent'`（`history: true`） |
| `<pleiad-memory-core>` | `notes`。会話の始まり・圧縮の完了後の最初のターン | `kind: 'contextNote'`（`tag: 'memory-core'`） |
| `<pleiad-turn-context>` | `notes`。毎ターンの末尾 | `kind: 'contextNote'`（`tag: 'turn-context'`） |
| `<pleiad-interruption>` | `notes`。中断で止めたもの（既存） | `kind: 'interruptionNote'` |
| `<routine-payload source hook at>` | `<pleiad-channel>` の本文の中。外から来た文 | （剥がさない） |

本文に包みのタグが紛れても外へ出られない（`escapeBody`）。途中送信（`control.steer`）の道では末尾を付けず、`<pleiad-channel>` だけを渡す。

## 画面（`web/channels/`）

- `client.mjs` が持つのは `setupChannels(host)` の 1 つの口だけ。返りは `{ onEvent(ev, replay), show(view), hide(), sideTabChanged(tab), contextForPanel(anchor), tab, setTab(tab) }`。`host` と部品（part）の形は `web/channels/index.mjs` の先頭のコメントが正本。部品の一覧への足し方も同じ所（1 行 1 パッケージ）。
- DOM の id・クラス: `#sideTabs`・`#tabChats`・`#tabChannels`・`.tab-dot.mark|.unread`・`html.side-channels`・`#channelsSide`・`.cs-sec[data-sec=channels|bots|routines]`・`.cs-row[data-kind][data-id]`・`body.channels`・`#channelsView`・`#channelsBody`。スレッドの空間モデル（`.deck[data-deck=feed|split|solo]`・`.deck-track`・`#chFeed`・`#chThread`）・投稿（`.post[data-post-id]`・`.post-av`・`.post-head`・`.post-body`・`.reactions`・`.react-pill[data-emoji]`・`.thread-summary`）・入力欄（`.ch-composer`・`#chFeedComposer`・`#chThreadComposer`・`.mention-list`）・`#botView.bot-page`・`#routineSheet` は各パッケージが `#channelsBody` の中に作る。
- CSS はパッケージごとのファイル（`channels-side.css`・`channels-feed.css`・`channels-thread.css`・`bot-page.css`・`routines.css`）。`tests/unit/design-lint.mjs` の `FILES` に入っている。
- 辞書は `web/locales/{ja,en}/channels.json`（節 `side`・`feed`・`thread`・`bot`・`memory`・`routines`・`event`。節ごとに持ち主が決まり、読んで書き直さず文字の置き換えで足す）と `agent.json`（`ops.channels|bots|memory|routines`・`guide.bot`・`channel.envelope`・`routine`）。コードでは `t('channels:feed.empty')`。
- Chats の一覧は bot の会話を出さない（あなた待ちの間だけ。`client.mjs` の `renderSessions`）。右パネルの作業場所の基準は `contextForPanel`。

## テスト

`tests/run.mjs` にパッケージごとの区画のコメントがある（自分の区画の下にだけ足す）。fake バックエンドは、包みで始まる prompt の台本を、包みを外してから選び（`<pleiad-channel>` の中身は `@名前` を除いて台本）、`notes:` / `instructions:` の台本で Pleiad が足した `notes`・`botInstructions` を返し、`AGENT_HOST_FAKE_USAGE=1` で固定の `usage` を、`AGENT_HOST_FAKE_SLOW_STEER=1` で `slow` に途中送信を持たせる。`tests/unit/ops-surface.mjs` の T6 の deps に `channels`・`bots`・`memory`・`routines` の空の物がある。`tests/ops-surface.snap.json` は、パッケージの最後に取り直す（同時に直さない）。
