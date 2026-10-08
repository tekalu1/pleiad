# 0163 委譲の子の Claude は文脈 15 万トークンで自動圧縮する

- 状態: 承認。閾値を固定の値（`delegatedTokens`）にすることは置換（[0166](0166-delegated-child-compaction-headroom.md)。固定の部分 + 空き `delegatedHeadroom`）
- 関連: [0068](0068-idle-compaction-after-notice-turns.md)（放置圧縮は委譲の子を除く）、[0051](0051-auto-compaction-min-150k.md)

## 状況

委譲の子（`ply_delegate` が作る会話）の Claude は、Claude Code の自動圧縮の既定のままで走っている。閾値は `min(floor(有効窓 × pct/100), 有効窓 − 13000)`、有効窓 = 窓 − min(最大出力, 20000) なので、1M 文脈のモデル（`opus[1m]` など）では 96.7 万トークンになる。子は長い作業を 1 つのターンで続けるため、文脈が 50 万〜95 万まで伸び、1 リクエストの重さ（遅さ・使用量）が目立つ。

放置圧縮（Pleiad の予約。[ADR 0068](0068-idle-compaction-after-notice-turns.md)）は、子が結果を返した後ほとんど再開されないので子を対象にしておらず、走っている途中の子には効かない。

調べたこと（Claude Code 2.1.293）: 環境変数 `CLAUDE_CODE_AUTO_COMPACT_WINDOW`（10 万〜100 万）が窓として使われ、閾値は W − 33000 になる（`=183000` で `getContextUsage().autoCompactThreshold` が 150000）。CLI の窓は `min(モデルの窓, W)`。`CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` は、200k 窓のモデルで閾値が 2.7 万になり毎回圧縮される。

## 決定

**委譲の子の Claude のターンにだけ、`CLAUDE_CODE_AUTO_COMPACT_WINDOW = delegatedTokens + 33000`（上限 100 万）を付ける。** 子の閾値は文脈 `delegatedTokens` トークンになる。

- 設定は自動圧縮の設定（`prefs.autoCompaction`。`settings.set compaction.auto`）の `delegatedTokens`。既定 150000。0 は「付けない」（Claude Code の既定に戻す）。0 以外は 70000 以上（窓の下限 10 万 − 余白 3.3 万 = 6.7 万を切り上げた値）。放置圧縮の `enabled`・`claude.enabled`・`minTokens` とは独立に効く。
- 付けるのは、`store` に `delegation` がある会話の、`autoCompactWindow` に対応するバックエンド（Claude。fake は台本の確認用）のターン。互換の接続先の Claude も含む。親の会話・bot・Codex・Antigravity には付けない。env はターンごとに組み直す（設定の変更は次のターンから効く）。
- 利用者が `process.env` に同名を置いていれば、Pleiad は付けずそちらを優先する。
- モデルは 1M 文脈のまま。放置圧縮（子を除く）、委譲の数・深さの上限は変えない。
- 設定画面（設定 › 自動圧縮）に「委譲の子の圧縮の閾値」を 1 項目足す（k トークン。0 でオフ）。

## 理由

子の 1 リクエストを小さく保つには、CLI 自身の自動圧縮の閾値を下げるのが最も素直で、圧縮の仕組み（要約の作り方・区切りの記録）を Pleiad が持たずに済む。`PCT_OVERRIDE` は窓の小さいモデルで過剰に圧縮するので使えない。`AUTO_COMPACT_WINDOW` は `min(モデルの窓, W)` なので、窓の違うモデル（sonnet・haiku は 200k）でも 15 万付近で安定する。

親の会話は人が見て続ける前提で、圧縮のタイミングを人が選べる（放置圧縮・手動）ので変えない。

## 影響

- 子の `contextWindow` の表示の分母が 183k になる（`min(モデルの窓, W)` の結果）。
- 子が 15 万を超えるたびに、CLI が自動圧縮を走らせる（圧縮の区切りは親の会話と同じ形で記録される）。長い作業の途中で要約を挟むので、細部の記憶が薄れうる。気になる人は 0 か大きい値にする。
- `prefs.autoCompaction` に項目が増える。保存済みの値（項目なし）は読むときに既定で補う。
- 保持役（`claude-held.mjs`）に載せたターンにも、`options.env` で同じ値が渡る。付け直したターンは走っている CLI の続きなので env は変わらない。
