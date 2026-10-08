# 0167 委譲の子の最初のリクエストを軽くする（使わない道具・指示を外し、指示の二重渡しをやめる）

- 状態: 承認（2026-10-08）
- 関連: [0166](0166-delegated-child-compaction-headroom.md)（固定の部分 + 空き。固定の部分が小さいほど子の作業に使える空きが増える）、[0081](0081-control-surface-registry.md)（ply_control）

## 状況

委譲の子（Claude）の最初のリクエストは、作業を始める前から約 7.1 万トークンある（実測 2026-10-08。Opus 5.5 の count_tokens で部品ごとに数えた）。内訳の大きいものは次の三つ。

- Claude Code の組み込みの道具 14 個の定義が約 2.27 万。うち Workflow 8528・ScheduleWakeup 1981・ReportFindings 1107・ListAgents 691 は、子の仕事（依頼元へ結果を返す）に使わない。
- 可視化の説明（約 1.6k）と ply_control の指示（約 0.2k）と ply_control の道具の名前の一覧。子の出力は依頼元が受け取るので可視化は要らず、子が Pleiad の設定を触る必要もない。
- ply_agents（約 0.7k ×2）と ply_computer（約 0.4k ×2）の指示が、`systemPrompt.append` と MCP の `initialize` の `instructions` の両方に入っていて、同じ文が 2 回ある。

## 決定

1. **委譲の子の Claude は、Workflow・ScheduleWakeup・ReportFindings・ListAgents を `disallowedTools` で外す。** 名前は `core/backends/claude.mjs` の `DELEGATED_CHILD_DISALLOWED_TOOLS` 1 か所にまとめ、bot の読み取り専用の deny ルールと合わせて渡す。AskUserQuestion・Agent・Bash・PowerShell は残す。子かどうかは server の `beginTurn` が会話メタデータの `delegation` で決め、`runArgs.delegatedChild` で渡す。
2. **委譲の子には、可視化の説明と ply_control の指示を渡さない。** server が `visualizeInstructions` を null に、`controlRuntime.instructions` を null にするので、Codex・Antigravity の子にも同じく効く（どちらも null を受け付ける）。内蔵ブラウザー・ply_computer・ply_agents・ply_context は今までどおり渡す。
   - **ply_control の MCP サーバー自体と会話のシェルの環境変数は子にも残す。** 子の設定変更の承認を依頼元へ中継する口（[ADR 0088](0088-setting-change-approval.md)）が ply_control を通り、その試験（`server-setting-approval-delegated`・`remote-agent-*`）が子の呼び出しを前提にしている。MCP を外して得られるのは道具の名前の一覧（数十トークン）だけで、機能を失う割に釣り合わない。指示が無いので、子は頼まれない限り使わない。
3. **ply_agents と ply_computer の指示は `systemPrompt.append`（Codex は `developerInstructions`、Antigravity は会話の指示）だけで渡し、MCP の `initialize` の `instructions` は返さない（全会話）。**

## 理由（二重渡しを append に寄せた根拠）

- 履歴・ADR・docs を調べたが、MCP の `instructions` が届かない場面に備えて両方に入れた、という記録は無い。ply_computer の橋の導入（c28ebfa7）が、ply_agents と同じ形を写して両方に入れたのが始まりに見える。一方 ply_control（`core/ops/surfaces/control.mjs`）と `core/mcp-bridge.mjs` は「指示を別の経路で渡す会話の二重を避ける」ために `initialize` に入れない形で、すでに append だけに寄せている。
- append は 3 つのバックエンドすべてに届く。MCP の `instructions` を受け取る保証があるのは Claude Code だけで、Codex・Antigravity はどちらも append に相当する経路で渡している（二重に入っていたのは Claude の会話）。
- append には ply_agents の追加の指示（`withAdded`。設定で足した文）が入る。MCP の `instructions` は固定の文だけで、足した文を含まない。同じ内容の二重ではなく、追加分が欠けた版が MCP の側にあった。
- 再開・tool search が切れた互換の接続先でも、append は毎ターンの `systemPrompt` として渡されるので、MCP の `initialize` に依存する側より確実。

## 影響

- 委譲の子の最初のリクエストは、組み込みの道具の定義で約 1.23 万、可視化と ply_control で約 0.2k+、二重の指示で約 1.1k（親を含む全会話）減る。実測は実装の報告に書く。
- 子は ply_control の使い方の指示を受け取らなくなる（MCP は使える。依頼元が頼めば呼べる）。
- 子は Workflow などを呼べなくなる。依頼元が頼んだ仕事にこれらが要る場合は、親の会話で行う。
- ply_agents・ply_computer の MCP を Pleiad の外の AI が直接つなぐ口は無い（会話ごとの Bearer で束縛）ので、`initialize` の `instructions` が無くなっても困る利用者はいない。
