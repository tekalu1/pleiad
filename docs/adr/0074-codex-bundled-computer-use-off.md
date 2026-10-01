# 0074 Pleiad から起動した Codex の会話では、同梱の computer use を切る

- 状態: 提案

## 状況

Codex には同梱の computer use のプラグイン（`computer-use@openai-bundled` / `unified-computer-use@openai-bundled`）がある。`unified-computer-use` は MCP の `cua_repl`（ツール `js`・`js_reset`・`turn_ended`）を、`computer-use` はスキル `computer-use:computer-use` を出す。Pleiad が `ply_computer` を渡す会話で両方が有効だと、1 つの PC に操作の仕組みが 2 つあることになる。

- ロックが共有されず、入力が混ざる。オーバーレイも Esc も 2 つになる。
- モデルがどちらを使うか迷う。
- 同梱のものの承認は elicitation で来るが、Pleiad は断っている。Pleiad の会話では、同梱のものはもともと動かない。
- 同梱のものは ChatGPT のデスクトップアプリのヘルパーと `~/.codex` の状態に依存し、Pleiad から後始末を制御できない。

## 決定

- `ply_computer` を渡す会話では、`thread/start` の `config` の上書きで同梱の computer use を切る。利用者の `~/.codex/config.toml` は書き換えない。利用者の `notify` などの設定にも触れない。
- 上書きは次の 2 つ（2026-10-01 に `codex-cli 0.156.1` の app-server で実測。gpt-5.5・gpt-6 系のどちらでも、モデルへ送るツールの一覧から `cua_repl` が、プロンプトからスキルが消えた）。片方だけでは、もう片方が残る。
  - `plugins.unified-computer-use@openai-bundled.enabled: false`（`cua_repl` を消す）
  - `plugins.computer-use@openai-bundled.enabled: false`（スキルを消す）
- 使わないもの:
  - `features.computer_use: false` は効かない（`cua_repl` もスキルも残る）。
  - `mcp_servers.cua_repl.enabled: false` は app-server が `invalid transport in mcp_servers.cua_repl` で `thread/start` ごと拒否する。
  - `node_repl` は同梱ではなく、利用者の `~/.codex/config.toml` の `[mcp_servers.node_repl]`（Codex のアプリが書き、ブラウザーのプラグインも使う）。computer use の仕組みではないので切らない。
- 効いたかは `mcpServerStatus/list`（`threadId` を渡すと上書き後の一覧）に `cua_repl` が無く `ply_computer` があることで確かめる。`skills/list` は無効にしてもスキルを返し続けるので根拠にしない。Pleiad は `ply_computer` を渡すターンの開始時にこれを見て、`cua_repl` か `pluginId` に `computer-use` を含むサーバーが残っていればログに 1 行出す。
- `ply_computer` を渡さない会話（設定でオフ、デスクトップ版でない）では何も足さず、利用者の設定に任せる。
- `ply_computer` は elicitation を使わない。今の「elicitation は断る」は変えない。

## 理由

3 つのエージェントで、承認・止める・履歴のスクショ・設定を 1 つにそろえる（[ADR 0070](0070-computer-use-via-ply-computer-mcp.md)）。同梱のものは Pleiad の会話では動かないので、切っても失うものは無い。会話ごとの上書きに留めれば、Pleiad の外で使う Codex には影響しない。

## 影響

- Pleiad から起動した Codex の会話では、Codex 自身の computer use は使えない。
- 上書きのキーは Codex の版で変わりうる（プラグインが増える・名前が変わる）。変わったら実測し直し、`core/backends/computer-delivery.mjs` の `codexComputerConfig` に足すキーだけを差し替える。開始時のログがその合図になる。
