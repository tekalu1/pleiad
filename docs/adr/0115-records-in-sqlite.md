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

- **件数・会話の長さ・時間とともに増える記録は、SQLite の行に置く。** データ置き場に DB ファイルを 1 つ（`pleiad.db`）。Node 組み込みの `node:sqlite`（`DatabaseSync`）を使い、WAL・`synchronous=FULL`（確定した書き込みは電源断でも戻らない。書く頻度は 1 ターンに数回なので、遅さは問題にならない）。書くのは変わった行だけで、記録が増えても 1 回の書き込みは重くならない。
- **JSON ファイルは、設定や台帳のように上限が決まっているものだけ。** 上限と理由は `tests/data-writes-allowlist.mjs` の許可リストに書く。`core/`・`desktop/`・`bin/` がファイルを書く箇所（別名・FileHandle・ストリーム・コピー・リネームを含む）は、リストに無ければテストが落ちる（`AGENTS.md`）。
- **表**（`core/db.mjs`）:
  - `sessions`＋`session_fields`: 1 会話 1 行、項目（`backend`・`title`・`outbox`・`contextSession`・`hookRuns` …）ごとに 1 行。項目が変わったらその項目の行だけを書く。
  - `context_entries`＋`context_entry_refs`: `contextSession.report.entries` を、中身の SHA-256 で 1 つだけ持ち、会話側は並びの参照だけ持つ。読むときに元の形へ組み直すので、呼び出し側から見た値は変わらない。どの会話からも参照されなくなった行は起動時に消す。
  - `agent_tasks`: 1 タスク 1 行。`usage_records`（1 ターン 1 行）＋`usage_meta`（`since`・済んだ移行・そのほかの最上位の項目）。`conversations`: 会話の索引 1 会話 1 行。
- **データ置き場は、起動から終了まで 1 つのプロセスだけが持つ（`core/data-lock.mjs`）。** **OS がプロセスの終了で必ず外すロック**にする: 置き場の小さな別ファイル `pleiad.lock.db` を `node:sqlite` で開き、`locking_mode=EXCLUSIVE` で排他ロックを取ったまま、プロセスが生きている間持ち続ける。別のプロセスが同じことをすると `SQLITE_BUSY`（`busy_timeout` は 0）になり、それを「使用中」と判断して、理由（持ち主の PID）を出して起動を止める。プロセスが落ちれば（強制終了・電源断のあとの再起動を含む）OS がロックを外すので、PID の生死は判断に使わない（Windows は PID をすぐ使い回すので、落ちて残ったファイルの PID が別のプロセスに使われると、PID の判断では起動できないまま戻らない）。持ち主の表示のために PID を `pleiad.lock` に書くが、判断には使わない。形式の移行より前に取る。同じ置き場を 2 つのプロセスが開くと、片方がメモリに持った会話の記録が、もう片方の削除・更新と食い違い、消した会話が欠けた形で戻る（A が読み、B が消し、A が題を更新すると、題だけの行が残る）。排他を `pleiad.db` 本体に掛けない理由: 別の接続でこの置き場を読む道具（`scripts/copy-data-dir.mjs`・テスト・調査）が、サーバーが動いている間も DB を読めるようにするため（それらは書かない）。あわせて、更新は変わった項目の行だけを書き、DB に無い会話を更新で作り直さない（消された会話は、更新では戻らない）。
- **どの公開関数も、DB への書き込みが失敗したら例外を返し、メモリの記録を書く前のままにする。** DB を先に書き、書けたらメモリへ反映する（`core/store.mjs` の `save`）。書けなかった分をメモリに残して後で書き直す、という作りはやめた（再起動に要る項目 `completedAt`・`unsent`・`interrupted`・`turnStartedAt` などの保存の失敗が、呼び出し側に返らなかった）。`busy_timeout` は 300ms（プロセス排他があれば、待つ相手は調査・テストの短い接続だけで、イベントループを長く塞がない）。
- **保存の失敗が例外として返るので、受けていない呼び出しを洗い出して直した（2026-10-03）。** `core/` の store・usage・agentTasks・outbox・conversations の保存を呼ぶ箇所を、名前で呼び出しの関係を辿る走査と、サーバーの DB への書き込みを 25%・60% の確率で失敗させたサーバーのテスト 91 本の実行（`unhandledRejection` を記録）で調べた。直接の呼び出し 173 件はすべて await・return・`.catch`・try/catch・`Promise.all` の後の `.catch` のどれかで受けていた（受けていないものは見つからなかった）。念のため、`core/server.mjs` に `process.on('unhandledRejection')` を置き、ログ（`[unhandledRejection]`）に出してサーバーは落とさない（Node の既定は、1 件の保存の失敗でサーバーごと落とし、走っている他の会話のターンまで止める）。`tests/unit/server-store-failures.mjs` が、書き込みを全部失敗させたサーバーで、落ちない・`[unhandledRejection]` が出ない・エラーとして返る・書けるようになれば通る、を確かめる。
- **形式番号（`data-schema.json`）を 1 → 2 にする。** 起動時、書き込みを始める前に、対象の JSON を `<data>/backup-schema1-<日時>/` へ写し、DB へ移し、読み戻して元と突き合わせてから番号を 2 にする。突き合わせは元の JSON の全体と読み戻した値を比べる（`usage.json` の version・since・migrations・records 以外の最上位の項目も DB に持ち、落ちるなら移行を止める）。失敗したら作りかけの DB と写しを消し、元の JSON に触れず、番号も上げず、起動を止める（[desktop-releases.md](../desktop-releases.md)「適用とデータ保護」）。形式 2 を見た古い版は起動を止める（既存の検査）。番号を 2 にしたあとの元の JSON の削除が失敗しても（Windows の削除拒否など）起動は止めない: 形式 2 の次の起動で、DB が使えることを確かめたうえで、写しに同じ中身がある元の JSON だけを外し直す。形式 2 では元の JSON を読む経路が無い。
- **形式 2 では、DB の存在・形式番号（`user_version`）・必要な表を確かめ、合わなければ空の DB を作らずに起動を止める。** 新しい置き場（JSON も DB も無い）だけが DB を新しく作ってよく、DB を作ってから形式番号を 2 にする。
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
- `outbox` は刈らない。sent の後にバックエンドから来る `returned`（受理した途中送信が読まれずに捨てられた）・`undelivered` は sent の項目を探して状態を変え、同じ ID の `accept` はその項目を見つけて二重送信を防ぐ。古い項目を捨てるとどちらも見失う。行ごとに書くので、刈らなくても 1 回の書き込みは項目 1 つぶんで済む（性能のためには要らない）。`core/message-queue.mjs` の挙動は変えていない。
- 同じ置き場を使うプロセスは 1 つだけになる。デスクトップ版が動いている間に、同じ `~/.agent-host` で `npm start` した 2 台目は起動を止める（別の置き場・別のポートで立てるのは今までどおり）。
- 古い版のアプリは形式 2 を見て起動を止める。移行前の写し（`backup-schema1-*`）は自動では消さない（利用者が確かめてから消す。大きさは移行前の JSON と同じ）。
- 既知の例外（上限が決まっておらず、まだ丸ごと書くもの）は許可リストに「既知」と書き、別の作業で行へ移す: 会話の本文 `conversations/<id>.json`（変更のたびに 1 会話分を丸ごと書く。会話の長さに比例する）、`presents/*.jsonl`、`handoff-*.json`、`antigravity/<id>.json`、`schedule.json`・`setting-approvals.json`・`worktrees.json`（件数は通常小さい）。
- bot・Channels・記憶・ルーティン（[ADR 0106](0106-bots-channels-routines.md)〜0114。main の 0.6.0 の分）を取り込んだときに、新しい保存先を同じ決まりで分けた（2026-10-03）。
  - **行にした**: スレッドの状態（`channels/threads.json` → `channel_threads`、1 スレッド 1 行。bot のターンのたびにトークンの足し算で全体を書き直していた）と、夜の整理の進み（`memory/learn-state.json` → `memory_state`、会話・チャンネルごとのカーソルを 1 件 1 行）。この 2 つのファイルは 0.6.0（形式 1 のまま）が書いているので、形式 1 → 2 の移行が取り込む（ほかの JSON と同じ手順: 写しは同じ相対パス・読み戻して突き合わせ・成功したら元を外す・形式 2 の次の起動で外し直す）。0.6.0 の読み方に合わせ、壊れている・知らない版・保存先の無い項目があるときは、読み込まずに移行を止める（上書きして消さない）。会話の記録の `bot` の項目は `session_fields` の 1 行、使用量の `sessionId` は `usage_records` の JSON の中に持ち、`usage.records({ sessionIds, since })` は `json_extract` の式の索引で引く。
  - **JSON のまま、上限と理由を許可リストに書いた**: `bots.json`・`routines.json`・`channels/index.json`（人が作る定義と既読の印）、`channels/inbox.json`（送り終えたものは 100 件まで）。
  - **追記だけのログ**（`appendOnly`。1 回の更新が 1 行の追記で、更新の重さが大きさに比例しない）: `channels/<channelId>.jsonl`（ADR 0108）・`memory/log.jsonl`。
  - **既知の例外に足した**: 記憶の markdown（`memory/user.md`・`memory/bots/<botId>.md`。変更のたびに 1 層を丸ごと書く。件数の上限はコードに無い）。記憶の正本は人が読んで直せる markdown だと [ADR 0110](0110-bot-memory.md) が決めているので、行にするなら、その決定の置き換えが要る。
- データ置き場を直接読む手順は DB に合わせた。実データの写しは `scripts/copy-data-dir.mjs`（`remote/`・`*-secrets.json` を写さず、DB は読み取り専用の接続で `VACUUM INTO`）、テストは `tests/lib/data-store.mjs`。
- 2026-10-03 の実データでの測定（開発機。写しで測った）: JSON 4 つ計 35.4MB（`sessions.json` 27.3MB・`agent-tasks.json` 5.0MB・`usage.json` 1.4MB・`conversations.json` 1.7MB）が `pleiad.db` 25.5MB になった。移行は 0.9 秒。会話 1,112 件の読み込み 0.13 秒（以前と同じメモリへの読み込み）。1 回の更新は、`sessions.json` の全体を書き直す 70〜80 ミリ秒（`JSON.stringify` と書き込み。毎回）に対して、`synchronous=FULL` で会話の項目 0.6〜0.8 ミリ秒（`contextSession` は 1.3 ミリ秒）、タスクの状態変化 2.5 ミリ秒（1 回の操作で数回書く）、使用量の記録 0.6 ミリ秒（`NORMAL` なら 0.02〜0.08 ミリ秒だった。fsync の分）。`contextSession` は 9.4MB が 1.8MB（`report.entries` は 788 行・0.34MB に寄る）。
