# 0106 件数・会話の長さとともに増える記録は SQLite の行に置く

- 状態: 提案

## 状況

データ置き場（`~/.agent-host`）の `sessions.json`・`agent-tasks.json`・`usage.json` は、変更のたびに全体を `JSON.stringify` して書き直していた。1 回の重さはファイルの大きさに比例する。2026-10-03 の実データでは次のとおり。

| ファイル | 大きさ | 件数 |
|---|---|---|
| `sessions.json` | 17.4MB（直近は 1 日あたり約 2.5MB ずつ増え、30 日後に 100MB 近く） | 1,110 会話 |
| `agent-tasks.json` | 4.9MB | 622 件 |
| `usage.json` | 1.4MB | 3,634 件 |
| `conversations.json`（索引） | 1.7MB | 約 1,000 会話 |

0.5.2 で書き込みのまとめ（750ms のデバウンス）と整形の廃止を入れたが、1 回の重さは変わらない。中身の内訳は、`contextSession`（9.7MB）のうち `report.entries` が 833 会話で 19,989 行（7.9MB）あるのに、種類として違う行は 788 行（0.34MB）だけ（96% が写し）。`hookRuns` が 4.35MB、送り終わった `outbox` が 0.99MB（1,806 件中 1,788 件が `sent`）、`compactions` が 0.97MB。何も刈り込まないので、`agent-tasks.json` と `usage.json` も増え続ける。

[ADR 0005](0005-source-of-truth-for-sessions.md) は `sessions.json` を「バックエンドを横断する索引」とした。その後 `setSessionData` の受け付ける項目が 25 種類に増え、大きなものが溜まった。会話ごとに分ける対応（`conversations/`）は本文だけで、索引側には「件数で増えるものを 1 冊に入れない」決まりもテストも無かった。これが再発の原因。

## 決定

- **件数・会話の長さ・時間とともに増える記録は、SQLite の行に置く。** データ置き場に DB ファイルを 1 つ（`pleiad.db`）。Node 組み込みの `node:sqlite`（`DatabaseSync`）を使い、WAL・`synchronous=NORMAL`。書くのは変わった行だけで、記録が増えても 1 回の書き込みは重くならない。
- **JSON ファイルは、設定や台帳のように上限が決まっているものだけ。** 上限と理由は `tests/unit/data-writes.mjs` の許可リストに書く。`core/` がデータ置き場へファイルを丸ごと書く箇所は、リストに無ければテストが落ちる（`AGENTS.md`）。
- **表**（`core/db.mjs`）:
  - `sessions`＋`session_fields`: 1 会話 1 行、項目（`backend`・`title`・`outbox`・`contextSession`・`hookRuns` …）ごとに 1 行。項目が変わったらその項目の行だけを書く。
  - `context_entries`＋`context_entry_refs`: `contextSession.report.entries` を、中身の SHA-256 で 1 つだけ持ち、会話側は並びの参照だけ持つ。読むときに元の形へ組み直すので、呼び出し側から見た値は変わらない。どの会話からも参照されなくなった行は起動時に消す。
  - `agent_tasks`: 1 タスク 1 行。`usage_records`（1 ターン 1 行）＋`usage_meta`（`since`・済んだ移行）。`conversations`: 会話の索引 1 会話 1 行。
- **`outbox` は、送り終わった（`sent`）・取り消した（`cancelled`）項目を会話あたり直近 20 件だけ残す。** 二重送信を防ぐ判定（同じ送信 ID の照合）は直近の再試行にしか効かず、並びの判定（`kick`）は両方を飛ばすので、捨てても送り漏れ・二重送信は起きない。
- **形式番号（`data-schema.json`）を 1 → 2 にする。** 起動時、書き込みを始める前に、対象の JSON を `<data>/backup-schema1-<日時>/` へ写し、DB へ移し、読み戻して元と突き合わせてから番号を 2 にする。失敗したら作りかけの DB と写しを消し、元の JSON に触れず、番号も上げず、起動を止める（[desktop-releases.md](../desktop-releases.md)「適用とデータ保護」）。形式 2 を見た古い版は起動を止める（既存の検査）。
- **Node の下限を 22.13.0 にする**（`engines`・CI）。`node:sqlite` が実行時の旗なしで使える最初の版。同梱の Electron 44 の Node は 24 系。`node:sqlite` が読み込み時に出す ExperimentalWarning は、その 1 回の読み込みの間だけ、SQLite についての警告に限って捨てる（ほかの警告は通す）。

## ADR 0005 との関係

置き換えない。**sidecar がバックエンドを横断する索引で、その正本が Pleiad にある**という考え方（ネイティブに持てるものはネイティブが正本、持てないものと履歴・親・モード・モデルなどは sidecar が正本）は同じ。変わるのは索引の置き場所だけで、`sessions.json` が `pleiad.db` の `sessions`・`session_fields` になる。ADR 0005 の「`sessions.json`」は「会話の記録（形式 2 では `pleiad.db`）」と読む。

## 理由

- 全体を書き直す作りは、件数が増えるほど 1 回の書き込みが重くなり、増え方に歯止めが無い。行にすれば、書く量は変わった行の大きさで決まる。
- JSON のまま分割すると、ファイルが数千・数万に増え、まとめて見る操作（一覧・集計）と、途中で落ちたときの整合の確保が難しくなる。SQLite は 1 ファイルで、トランザクションが途中の書き込みを残さない。
- 依存を足さずに済む（`node:sqlite` は Node の組み込み。ネイティブのアドオンを同梱しない）。
- 重複（`report.entries` の写し）は、行にしたうえでハッシュで 1 つに寄せないと、行にした意味が薄い（実データで 96%）。

## 影響

- `core/store.mjs` の公開関数の形と振る舞いは変えない（呼び出し側は触らない）。メモリのキャッシュは今までどおりで、書き込みだけが変わった行になる。書き込みはその場で行い、デバウンスは無くなった。`durable` 指定は、書けなかったときに呼び出し側へ投げるかどうかの違いだけ。
- 古い版のアプリは形式 2 を見て起動を止める。移行前の写し（`backup-schema1-*`）は自動では消さない（利用者が確かめてから消す。大きさは移行前の JSON と同じ）。
- 既知の例外（上限が決まっておらず、まだ丸ごと書くもの）は許可リストに「既知」と書き、別の作業で行へ移す: 会話の本文 `conversations/<id>.json`（変更のたびに 1 会話分を丸ごと書く。会話の長さに比例する）、`presents/*.jsonl`、`handoff-*.json`、`antigravity/<id>.json`、`schedule.json`・`setting-approvals.json`・`worktrees.json`（件数は通常小さい）。
- データ置き場を直接読む手順は DB に合わせた。実データの写しは `scripts/copy-data-dir.mjs`（`remote/`・`*-secrets.json` を写さず、DB は読み取り専用の接続で `VACUUM INTO`）、テストは `tests/lib/data-store.mjs`。
- 2026-10-03 の実データでの測定（開発機。写しで測った）: JSON 4 つ計 35.4MB（`sessions.json` 27.3MB・`agent-tasks.json` 5.0MB・`usage.json` 1.4MB・`conversations.json` 1.7MB）が `pleiad.db` 25.5MB になった。移行は 0.9 秒。会話 1,112 件の読み込み 0.13 秒（以前と同じメモリへの読み込み）。1 回の更新は、`sessions.json` の全体を書き直す 70〜80 ミリ秒（`JSON.stringify` と書き込み。毎回）に対して、会話の項目 0.02〜0.6 ミリ秒、タスクの状態変化 0.4 ミリ秒、使用量の記録 0.03 ミリ秒。`contextSession` は 9.4MB が 1.8MB（`report.entries` は 788 行・0.34MB に寄る）。
