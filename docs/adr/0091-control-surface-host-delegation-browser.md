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
