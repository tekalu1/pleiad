# 0074 Pleiad から起動した Codex の会話では、同梱の computer use を切る

- 状態: 提案

## 状況

Codex には同梱の computer use のプラグイン（`computer-use@openai-bundled` / `unified-computer-use@openai-bundled`。MCP は `cua_repl` / `node_repl`）がある。Pleiad が `ply_computer` を渡す会話で両方が有効だと、1 つの PC に操作の仕組みが 2 つあることになる。

- ロックが共有されず、入力が混ざる。オーバーレイも Esc も 2 つになる。
- モデルがどちらを使うか迷う。
- 同梱のものの承認は elicitation で来るが、Pleiad は断っている。Pleiad の会話では、同梱のものはもともと動かない。
- 同梱のものは ChatGPT のデスクトップアプリのヘルパーと `~/.codex` の状態に依存し、Pleiad から後始末を制御できない。

## 決定

- `ply_computer` を渡す会話では、`thread/start` の `config` の上書きで同梱の computer use を切る。利用者の `~/.codex/config.toml` は書き換えない。利用者の `notify` などの設定にも触れない。
- 書き方は実測で決め、決まったら `docs/computer-use.md`「実測しだいの箇所」を書き直す。仮の値は次の 3 つで、効かなければプラグインの MCP の名前（`mcp_servers.cua_repl.enabled: false` など）で切る。
  - `features.computer_use: false`
  - `plugins.computer-use@openai-bundled.enabled: false`
  - `plugins.unified-computer-use@openai-bundled.enabled: false`
- 効いたかは `mcpServerStatus/list` に `cua_repl` / `node_repl` が無く `ply_computer` があることで確かめる。
- `ply_computer` を渡さない会話（設定でオフ、デスクトップ版でない）では何も足さず、利用者の設定に任せる。
- `ply_computer` は elicitation を使わない。今の「elicitation は断る」は変えない。

## 理由

3 つのエージェントで、承認・止める・履歴のスクショ・設定を 1 つにそろえる（[ADR 0070](0070-computer-use-via-ply-computer-mcp.md)）。同梱のものは Pleiad の会話では動かないので、切っても失うものは無い。会話ごとの上書きに留めれば、Pleiad の外で使う Codex には影響しない。

## 影響

- Pleiad から起動した Codex の会話では、Codex 自身の computer use は使えない。
- 上書きのキーは Codex の版で変わりうる。変わったら実測し直し、`codex.mjs` の `config` に足すキーだけを差し替える。
