# 0008 公開の present MCP をやめ、共通の Visualize にする

- 状態: 承認（2026-09-26）

## 状況

2026-09-12 の調べ: HTML・画像を会話に出す経路は Claude の host MCP の `present` だけで、Codex には無かった。Codex の会話で Visualize のスキルが出したファイル参照は、Pleiad のカードにならなかった。`present` の HTML は空の sandbox と厳しい CSP で、スクリプト・CDN・相対パスの画像を前提にした HTML は動かなかった。
一度は Claude・Codex 共通の内蔵 MCP `ply` の `present` と、その有効化の設定を作った（2026-09-12）。

## 決定（2026-09-14）

- 公開の MCP ツール `present` と `/mcp/ply`、その有効化の設定（`plyPresentEnabled`）を廃止した。
- 可視化は Claude・Codex 共通の **Visualize の参照**（回答の独立した行の `visualize{"path":…}`）で出す。案内は共通のスキル（`skills/visualize/`）で、ターンの開始時に会話の言語のものを渡す。
- 参照された HTML はアシスタントの発言の確定時に読み、会話の記録（`presents/<sessionId>.jsonl`）に写しを残す。後でファイルを変えても過去の表示は変わらない。
- 新しい可視化はスクリプトを動かす（隔離は 0009）。旧 `kind: html` の履歴は今までどおりスクリプトを動かさない。

## 理由

- ツールの呼び出しはバックエンドごとの MCP の注入と認証を要し、Codex の host ツールは今も未接続（multi-backend.md §2.6）。回答の中の参照ならバックエンドに依らず同じ経路で受けられる。
- モデルが元から知っている Visualize の書き方に合わせると、指示が短くて済む。
- 採らなかった案: Codex の app-server の dynamic tool で `present` を処理する（実験的な API で、再開のたびの登録が要る）。

## 影響

- 仕様は visualize.md。画像は Markdown の画像リンク、ファイルは通常のリンク、テキストは通常の回答で出す。
- 1 ファイル 1 MiB・1 ターン 32 参照まで、作業ディレクトリの中の UTF-8 の HTML だけ。
