# 0004 複数のエージェントのバックエンドを並べる

- 状態: 提案

## 状況

当初はコアを Claude Agent SDK に決め、design.md §3 で「マルチプロバイダ」をやらないことにしていた。
2026-09-11、OpenAI Codex（公式 `codex` CLI の app-server）も同じ画面で使いたくなった。調べると SDK は「実行エンジン」と「セッション管理のデータベース（`~/.claude` の JSONL）」の 2 役を兼ねており、さらに `web/client.mjs` が Anthropic のストリームの型を直接読んでいた。

## 決定

- design.md §3「やらない: マルチプロバイダ」を改訂し、バックエンドを `AgentBackend` のインターフェースで切る（multi-backend.md §2.3）。
- Claude（Agent SDK）と Codex（app-server）を並べ、2026-09 に Antigravity CLI（`agy`）を足した。
- バックエンドごとにできることの差は `capabilities` で表し、画面はそれで出し分ける（分岐・タイトル提案・サブエージェント・常に許可など）。
- LLM を呼ばずに server 全体を試すため、`fake` バックエンドを持つ。
- 会話ごとにバックエンドを選び、途中でも切り替えられる（backend-handoff.md）。

## 理由

- 画面・状態・分岐・承認など Pleiad の資産はバックエンドに依らない。境界の穴（生のストリームを画面へ流していたこと）を塞げば、web はほぼそのまま残せた（0006）。
- 使用枠が別々のサブスクを 1 つの画面で使い分けられる。

## 採らなかった・やめたもの

- Gemini CLI（ACP）: 一度入れたが、2026-06 に Google が個人向けの Gemini CLI を終え Antigravity へ移したため廃止した（multi-backend.md §2.8）。
- procway-code: 並べていたが 2026-09-23 に対応を終え、互換の接続先に置き換えた（0011）。

## 影響

- セッションの正本の所在を見直した（0005）。
- core → web は正規化したイベントだけを流す（0006）。
- 各バックエンドの対応表は multi-backend.md §2.5。host ツール（set_status など）の非対称は既知の穴として残る（§2.6）。
