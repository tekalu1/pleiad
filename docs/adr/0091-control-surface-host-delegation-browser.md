# 0091 host・委譲・ブラウザーの操作を一覧に通す

- 状態: 承認（2026-10-03）

## 状況

[ADR 0081](0081-control-surface-registry.md) の段階 3 では、Claude の `host` と `ply_agents`・`ply_browser` が、操作の一覧とは別の処理を持っていた。Codex と Antigravity は Claude の `host` ツールを持たないが、3 種とも `ply_control` を使える。

## 決定

- `host` の `set_status`・`set_title`・`fork` は、順に `sessions.setStatus`・`sessions.setTitle`・`sessions.fork` を呼ぶ。Claude の `mcp__host__*` の名前、入力、説明、成功時の文は保つ。Codex と Antigravity は `ply_control` の `list_ops`・`call_op` から同じ操作を呼ぶ。直接の MCP ツールは増やさない。
- `ply_agents` と `ply_browser` のツール名、入力の JSON Schema、説明、返り値は保つ。会話に束縛した主体で `registry.invoke` を通し、その先で既存の委譲先選択・子の承認モードの継承・昇格時の承認・所有権・ブラウザーのプロフィール切り替えを行う。
- 旧 WS コマンド `setTitle`・`setStatus`・`fork`・`setBrowserProfile` は対応する op を呼ぶ。画面が使う返り値と定型理由の記録を保つ。

| 操作 | 危険度 | 理由・追加の判定 |
|---|---|---|
| `sessions.setTitle`・`sessions.setStatus`・`sessions.fork` | write | 題・状態・分岐は変更記録に残る。分岐先は親の承認モードを継ぐ。 |
| `delegation.tasks`・`delegation.status`・`delegation.taskStatus`・`delegation.taskWait`・`delegation.taskList`・`delegation.usage` | read | 子の状態と使用枠を読む。子の詳細と待機は依頼元の所有権を確認する。 |
| `delegation.delegate`・`delegation.taskSend` | write | 子の作成と追加指示は、会話の書き込み権限を要する。子の承認モードは親の強さを超えず、既存の昇格確認も残す。 |
| `delegation.taskCancel` | write | 自分の子を止める。停止できなくならないよう、読み取りモードの書き込み制限は適用しない。所有権の確認は残す。 |
| `browser.listProfiles` | read | この会話で使えるプロフィールを読む。 |
| `browser.useProfile` | write | この会話で使う保存領域を切り替える。既存のツールと同様、読み取りモードでも切り替えを許す。 |
| `browser.setProfile` | write | 画面の `setBrowserProfile` と同じ保存と配信を行う。 |

`delegation.taskCancel` と `browser.useProfile` は `modeGate: false` とする。危険度と監査記録は write のまま、既存の停止とプロフィール選択の可用性を保つ。委譲先の権限を広げる処理は op の write 判定だけに頼らず、既存の `resolveDelegatedMode` と承認カードを通す。

承認モード・アカウント・秘密の値などの human-only 操作と設定は、agent の一覧にも `list_ops` にも出さず、呼ばれても `NOT_FOUND` とする（[ADR 0082](0082-control-surface-principals-and-risk.md)）。

## 理由

どの入口も同じ zod の入力検査・権限判定・監査記録を通すことで、Claude 専用の host 処理と他のエージェントの操作の差をなくせる。既存 MCP の外側を残すことで、エージェントが覚えたツール名と委譲の返り値を変えずに移せる。

## 影響

- `ply_control` の instructions と tools/list は 1800 トークン以下のままとする。新しい操作はカタログから呼ぶ。
- 操作の一覧の snapshot と todo のラチェットを更新する。human-only の非表示は MCP の `list_ops` と `call_op` でも検査する。
- 会話に束縛されない CLI と stdio MCP は、委譲・会話中のプロフィール操作の対象を持たないため `NEEDS_UI` を返す。会話の題・状態などの既存の write 操作は [ADR 0083](0083-control-surface-cli.md) の規則どおり使える。

## 追記（2026-10-03）: 会話・選べるもの・委譲の続きを一覧に通す

### 状況

画面の WS コマンドのうち、会話・選べるもの・委譲のものは、まだ操作の一覧に載っていなかった（`tests/ops-baseline.json` の `todo` は 63 件）。ユーザーの決定（2026-10-03）は、Pleiad の全機能を AI も使えるようにすること。例外は承認モード・秘密の値・アカウント・接続先の既定・リモートのペアリングだけ。

### 決定

- 次の WS コマンドを操作として定義し、WS の case は同じ操作を人（画面）として呼ぶだけの外側にする。画面の返り値・エラーの文は変えない（`viaOp`。送らない欄を省き、`code` が `FAILED` のときは画面へ `code` を付けない）。中身はサーバーの関数のまま（`ctx.conversations`・`ctx.agents`・`ctx.statuses`・`ctx.delegation`）。
- **画面の全量と AI の上限**: 画面（人）が今まで読んでいた形（全部の欄・上限なし）と、AI・CLI が 1 回で読める大きさは別。操作に `uiHandler`（省略できる）を足し、`principal.by === 'human'` のときだけ `handler` の代わりに呼ぶ。口は偽れない（AI は `human` にならない）。入力の名前と意味は同じで、`handler` は一覧に `limit`（既定 30・最大 100）と `cursor`、本文に字数の上限（`sessions.listMessages` 500 字・`delegation.instructions` 1000 字・語彙の注 200 字）を持つ。
- **別名**: `legacyCommand` は 1 つの操作に 1 つ。引数の形が違う別の入口を、同じ操作へ結ぶときは `legacyAliases` を使う。`setAutoCompaction`（設定 › 自動圧縮）は `settings.set` の `compaction.auto`、`setDelegationRouting`（設定 › 委譲）は `delegationRouting` に結ぶ。`delegationRouting` は設定の定義が guarded（どの判定器に依頼の文を送るかを決める。ADR 0082）なので、別の write の口を作らない。
- **`list_ops` の `prefix`**: id の先頭で絞れる（例: `sessions.`）。操作が 70 を超えるので、全部の一覧は大きくなる。直接のツールは増やさない（T4 は ja 1757・en 1656 トークン）。

| 操作 | 危険度 | 理由・追加の判定 |
|---|---|---|
| `sessions.new` | write | 下書き（unsent）の会話ができるだけ。発言を送るのは人。承認モード・接続先は AI が渡すと `NEEDS_UI`（引き継ぎ元か既定）。アカウントは引き継ぎ元か前回の選択のままで、選べない。 |
| `sessions.deleteUnsent` | guarded | 消す。会話に承認カード。無い会話は承認の前に `SESSION_NOT_FOUND`。送った会話は消せない（サーバーが断る）。 |
| `sessions.abort` | write | 他の会話を止められる。止められるのはこのホストの会話だけ。AI は `reason` が必須で、止めた会話の変更の記録（`field: 'abort'`・`by: 'agent'`・`via`・`bySession`）に残す。中断した会話は人が再開できる。全部を止める（`sessionId` なし）のは画面だけ。 |
| `sessions.resume`・`sessions.compact`・`sessions.cancelCompaction`・`sessions.setAutoCompaction` | write | 会話の発言は消えず、承認モードも変わらない（再開は、その会話の承認モードで動く）。 |
| `sessions.setTurnSettings` | write。`cwd`・`backend` を替えるときは guarded（`riskOf`） | 作業フォルダーは承認モードが当たる場所、エージェントを替えると既定のモードが変わるので、AI 自身の権限を広げうる。承認モード・アカウント・接続先・`remember*` は AI が渡すと `NEEDS_UI`。 |
| `sessions.suggestTitle`・`sessions.listMessages`・`sessions.changes`・`sessions.lineage`・`statuses.list` | read | `suggestTitle` は会話のアカウントで小さな 1 回を回すが、会話は変えない。 |
| `statuses.rename` | write | 付いている全会話に変更の記録が残り、名前を戻せば元に戻る。空の名前でも会話は消えない。 |
| `agents.list`・`models`・`modes`・`efforts`・`authStatus` | read | 選べるものを読むだけ。`authStatus` は AI にはログインしているかだけ（メールアドレス・詳細・実行ファイルの場所を返さない）。 |
| `delegation.instructions`・`delegation.routing` | read | `routing` は判定器のキーを持たない（登録の有無だけ）。語彙は画面だけ。 |
| `delegation.retry` | write | 新しい子のタスクを作る。AI は自分が委譲した子だけ（他は `TASK_NOT_FOUND`）。依頼元より強い承認モードの子になる確認（`approved`）とアカウントの選択は人だけ（AI は `NEEDS_UI`）。 |

`sessions.resume`（`resume`）と `sessions.listMessages`（`listMessages`）は、使用量の上限解除後の再開（[ADR 0093](0093-resume-after-usage-limit.md)）が先に操作にしていたので、新しい操作は作らずそれに寄せた。`resume` は AI の口にも開き（`scope: session`・write。中身は同じ `resumeSession`）、`listMessages` は AI・CLI に件数（`limit`・`cursor`）と本文 500 字の形を返し、画面には従来の全量を返す。上限の解除で再開を待つ会話の `setTurnSettings`（アカウントかエージェントを替える）は、これまでどおり自動再開と解除の通知を取り消す。

`delegation.taskCancel`（`cancelAgentTask`）と `delegation.usage`（`providerUsage`）は、AI の従来の動き（自分の子を止める・委譲先を選ぶ使用枠）を保ち、画面だけ `uiHandler` で全量を返す。`app.running`・`sessions.list`・`delegation.tasks` も同じ。

### 移さなかったもの

`loadSession` は `ui-internal`。画面が開いている会話に合わせる口（流れの続き・承認カード・下書き・圧縮の区切り・`watch`・`from`/`check` の差分）で、AI の同じ機能は `sessions.read` が持つ。`todo` は 63 件から 31 件になった（この追記で 28 件、ほかの作業で 4 件）。残りは別の作業（MCP・フック・コンテキストの移行）が扱う。

### 理由

画面のコマンドを操作にすると、入力の検査・権限・記録・伏せ字が口によらず同じになり、AI が同じ機能を使える。画面の全量と AI の上限を同じ操作の中で分けると、AI の口に大きな返りを出さずに、画面の振る舞いを変えずに済む。人だけの項目（承認モード・アカウント・接続先）を AI が渡したときに黙って無視せず `NEEDS_UI` にするのは、AI に自分の権限を決めさせないため。

### 影響

- `todo` は 63 件から 31 件。`ops-baseline.json`・`ops-surface.snap.json`（`legacyAliases` も載る）・辞書（`agent.json` の `ops.sessions`・`statuses`・`agents`・`delegation`・`control.listOpsPrefix`）を更新した。
- `delegation.taskCancel`・`delegation.usage` は画面にも出る（`ui: true`）。AI の動きは変わらない。
- `ply_control` の文は ja 1733 → 1757・en 1632 → 1656 トークン（`prefix` の説明の分）。

## 追記（2026-10-06）: 送った会話を消す

| 操作 | 危険度 | 理由・追加の判定 |
|---|---|---|
| `sessions.delete` | guarded | 送った会話も消す（Pleiad の記録だけ。ネイティブの会話は残して一覧から隠す）。無い会話は承認の前に `SESSION_NOT_FOUND`、消せない会話（走っている・承認や裏の作業を待っている・委譲の子が終わっていない・送信待ちがある・bot の会話）は承認の前に `CANNOT_DELETE`、AI の自分の会話は `DELETE_SELF`。 |

`sessions.deleteUnsent` は変えない（送った会話は今も断る）。決定と理由は [ADR 0143](0143-delete-sent-conversations.md)。
