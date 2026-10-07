# 無停止の更新 段階 3（agy）: 実測と実装のメモ

[plan.md](plan.md) の「段階 3」のうち agy（Antigravity）の部分。段階 0 の実測（[stage0-codex-agy.md](stage0-codex-agy.md) §3）は保持役の身代わり（`holder-sim`）で測ったので、ここでは**本物の保持役（`core/holder/`）に本物の agy を載せて**測り直し、そのうえで実装した。Codex と `!` の行は別の作業（この文書の範囲外）。

- 印: **実測** = 動かして確かめた。**テスト** = `tests/unit/` の試験が通る。**未確認** = 動かしていない
- 測った版: `agy 1.3.0`（段階 0 は 1.2.17）、`gemini-3.8-flash-low`、Node v24.14.0、Windows 11（x64）、保持役は `core/holder/`（規約 v1）

## 1. 実測: 本物の agy を本物の保持役で付け直す

スクリプト: `scripts/zero-downtime/agy/held-swap.mjs`（置き場は `temporary/zdu-agy-held/`。LLM は短い 2 ターン。シェルは `echo` 1 回）。親 A（`HolderClient`）が `spawn`（policy `none`）→ 印（`turn`）→ 1 行目の順で agy を起こし、ターンの途中（ツールの行 `tool/ACTIVE` が出た時点）で `ack`・`label`・`detach` して接続ごと閉じる。2.5 秒おいて親 B が別の接続で付け直す。

**実測（2 回流して同じ結果）**

| 場面 | 結果 |
|---|---|
| A が手を離した時点 | `init` → `user_input/DONE` → `agent_response/DONE` → `tool/ACTIVE(run_command)` の 4 行（seq 1〜4）を処理し、ack 4 |
| 親が居ない 2.5 秒 | 子は進む（保持役の seq が 4 → 8。`tool/DONE`・`agent_response`・`result` が溜まった） |
| B の付け直し | `welcome.children` に子が居る（`alive`・`seq`・`first: 1`・`acked: 4`・`marks.turn: 1`・`label`）。印〜ack の再生で A と同じ 4 行（**`init` を含む**ので、会話 id・モデルは再生から分かる）、続き（`attach(ack + 1)`）で `tool/DONE` → `agent_response/ACTIVE`・`DONE` → `result SUCCESS`（本文 `finished`）。**ツールの結果（`echo` の出力）も欠けず 1 回** |
| 会話 id | `init`・`result` とも同じ（`conversation_id` が付け直しの前後で変わらない） |
| 同じプロセスの 2 ターン目 | B が印を打ち直して（`mark`、位置は次の行）次の行を書くと、`result SUCCESS`（本文 `second`）。**`init` は 2 ターン目には出ない**（最初のターンの前に 1 回だけ）。保持役の記録は ack と印の小さい方より前を捨てる（`first` 1 → 9、`marks.turn` 1 → 9）。印が 2 ターン目の始まりに移ったので、1 ターン目の行は記録に残らない |
| 木ごと止める | `kill { tree: true }` で agy の pid が居なくなる（`tasklist` で agy.exe が 0 件）。保持役の `shutdown` で保持役も消える。**親が接続していない（attach していない）子への `kill` は保持役が無視する**ので、止める側は先に `attach` する |

**分かったこと**

- 付け直しに握手は要らず、記録の再生だけで足りる（段階 0 の結論が本物の保持役でも成り立つ）
- **ターンの印は、ターンごとに打ち直す**（agy の子は会話のあいだ生きる。`init` は最初のターンの再生にだけ入る。2 ターン目以降の会話 id は札の `sessionId` が持つ）
- 付け直したターンが終わったあとの子は、そのまま会話の次のターンに使える（記録の再生は要らず、新しいサーバーが同じ子に次の行を書く）

**残した（動かしていない）**: 複数の親の取り合い・`result` を出さずに終わった子（agy が落ちた）の付け直し（テストで偽の agy が扱う）・stderr の再生（保持役は stderr を記録しない。付け直しの前に出た `print timeout` の印は新しいサーバーには届かない）。

## 後始末

agy の会話は `~/.gemini/antigravity-cli` に残る。試験用の会話 id: `dc154e98-26ac-4161-b4f7-72eb0957b024`・`73a48898-8b95-4d7e-bc50-49abd37c3af8`（どちらも短い試験の発話だけ）。要らなければ agy の側で消す。
