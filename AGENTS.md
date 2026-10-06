# 開発規則

このリポジトリの変更作業では、以下を標準手順とする。ユーザーから個別の指示がある場合は、その指示を優先する。

## 作業開始

- 修正前に `git status --short --branch` と `git worktree list` を確認する。
- 最新のローカル `main` から、作業ごとに専用ブランチと worktree を作成する。`main` の作業ディレクトリで直接修正しない。
- worktree は原則としてメインの作業ディレクトリ配下の `temporary/worktrees/<作業名>` に置く。操作時は確認済みの絶対パスを使う。
- 例: `git worktree add -b fix/<作業名> <worktreeの絶対パス> main`
- 既存の未コミット変更、未追跡ファイル、他の作業用ブランチ・worktree は保持する。無断で stash、破棄、上書きしない。

## 構成と環境変数

```
core/     Node の HTTP + WebSocket サーバー。バックエンドに依存しない
  backends/  エージェント 1 種類 = 1 ファイル（claude・codex・antigravity と、テスト用の fake）
  ops/       操作の一覧（レジストリ）。画面・MCP・CLI へ外に出す機能の正本（`docs/design.md`「操作の一覧」）
bin/      CLI（`pleiad`。走っている Pleiad の操作の一覧を使う薄いクライアントと `pleiad mcp`。Node の組み込みだけ。`docs/design.md`「操作の一覧」）
web/      画面。素の ESM でビルドは無い。サーバーがリクエストごとにディスクから読む
desktop/  Electron の main / preload と自動更新
mobile/   モバイル版（Capacitor）
relay/    リモート接続の中継サーバー（docs/remote.md）
tests/    run.mjs（npm test）と e2e.mjs（npm run test:e2e）
scripts/  リリースと署名
docs/     設計（design.md）・見た目（design-system.md）・ADR（adr/）
```

core が web へ流すのは正規化イベントだけで、バックエンドごとのプロトコルは漏らさない（`docs/multi-backend.md` §2.2）。

| 環境変数 | 意味 |
|---|---|
| `AGENT_HOST_TOKEN` | 固定のトークン（既定は起動ごとにランダム） |
| `AGENT_HOST_PORT` | 既定 7420。予約済み・使用中なら空きポートへ移る |
| `AGENT_HOST_BIND` | 既定 `127.0.0.1` |
| `AGENT_HOST_DATA` | データ置き場（既定 `~/.agent-host`） |
| `AGENT_HOST_BACKENDS` | 使うバックエンド（カンマ区切り。既定 `claude,codex,antigravity`） |
| `AGENT_HOST_CODEX_BIN` | codex の実行ファイル（既定 `codex`） |
| `AGENT_HOST_AGY_BIN` | Antigravity CLI の実行ファイル（既定 `agy`） |
| `PLEIAD_CONTROL_URL` / `PLEIAD_CONTROL_TOKEN` | `pleiad` CLI のつなぎ先。Pleiad が会話のシェルへ渡し、その会話に束縛される（無ければ `AGENT_HOST_DATA` の `control.json`） |
| `AGENT_HOST_GIT_SNAPSHOTS` | `off` でターンの始まりと終わりの git の撮影（`refs/pleiad/`。ADR 0085）を止める。テストが使う（`tests/lib/server.mjs`） |
| `AGENT_HOST_WORKTREES` | `off` で worktree（ADR 0136）を作らない。テストが使う（`tests/lib/server.mjs`。このリポジトリが cwd のテストが `<リポジトリ>.pleiad` に残すのを防ぐ）。確かめるテストは一時のリポジトリで `on` を渡す |
| `AGENT_HOST_HANDOVER` | `on` で、サーバーが `utilityProcess` の代わりに main との名前付きパイプを作る（`core/main-link.mjs`。無停止の更新 段階 1。ADR 0137）。既定は `off`（今の `utilityProcess`）。段階 1 の途中は main が自分では使わず、確かめるハーネス（`docs/dev-verification.md`）だけが使う |
| `AGENT_HOST_WORKTREE_GRACE_MS` | worktree を作ってから、使われていないものとして自動で片付けるまでの猶予（既定 60 秒。ADR 0089）。テストが 0 にする |

デスクトップ版は `npm run desktop`、インストーラーの生成は `npm run desktop:dist`（対象 OS で実行）。リリースの運用は `docs/desktop-releases.md`。

## 実装と検証

- 作業用 worktree 内で実装・検証・コミットを行い、依頼に必要な変更だけを含める。
- 開発環境は Node.js 22.13 以上（`node:sqlite` を使う。ADR 0115）。依存関係の導入には `npm ci` を使う。
- 作成直後の worktree には `node_modules` が無い。依存が `main` と同じなら、PowerShell から `cmd /c mklink /J <worktreeの絶対パス>\node_modules <メインの作業ディレクトリの絶対パス>\node_modules` でジャンクションを張れば足りる（Bash tool の `cmd //c mklink` は失敗する）。外すときは `cmd /c rmdir <worktreeの絶対パス>\node_modules`（`rm -rf` はリンク先の実体を消す恐れがある）。
- テストは必ず作業用 worktree の中で実行する。`main` の作業ディレクトリで `npm test` を走らせても worktree の変更は検証できない。
- 設計は `docs/design.md`、画面の変更は `docs/design-system.md` を参照する。
- 画面・AI・CLI へ外に出す機能は、WS の case を足すだけにせず `core/ops/` に操作として定義する（ADR 0081）。足し忘れは `npm test` の ops-coverage が落とす（`tests/ops-baseline.json` の `todo` は増やせない）。設定（prefs.json）を足す・変えるときは `core/ops/settings.mjs` の `defineSetting`（危険度・`normalize`・`write`）に書き、`store.setPref` を直に呼ばない（画面の `setPref` も AI の `settings.set` も同じ定義を通る。`ops-coverage` が落とす）。操作の危険度・出す口を変えたら `OPS_UPDATE_SNAPSHOT=1 npm test -- ops-surface` で snapshot を更新し、差分を確認する。
- 画面・エラー・エージェント向けの文言は辞書（`web/locales/<言語>/<名前空間>.json`）に置き、`t()` で引く（`docs/design.md`「多言語対応」、訳語は `docs/i18n-glossary.md` に従う）。直書きの日本語は `npm test` の lint-i18n が落とす。基準（`tests/i18n-baseline.json`）の更新は減らすときだけ（`node tests/lint-i18n.mjs --update-baseline`）。
  - `web/locales/*/ui.json` は `JSON.stringify(…, null, 2)` の整形と一致しないので、読んで書き直さず、キーは文字の置き換えで足す。`sed '/"connected"/d'` のような行単位の削除は別の節の同じキーまで消すので使わない。
- コード変更後は `npm test` を実行する。通常テストは実際の LLM を呼び出さない。1 本だけなら `node tests/run.mjs <ケース名>`。
  - 全件の順次実行は 10 分を超えることがある。長い実行はログへ保存して最後まで待つ。途中で打ち切った結果を通過とみなさない。
  - `npm test -- --jobs 2` で別プロセスの worker 2 本を使う。既定の `--jobs 1` は同じプロセスで登録順に実行する。スイートごとの時間・判定数・skip は `--timings <JSONの保存先>` で記録できる。
  - 分けて流す場合は `node tests/run.mjs --shard 1/3`、`--shard 2/3`、`--shard 3/3` の全分割を同じ版・時間重みで実行し、すべての通過を確認する。`--list --json` は実行対象の一覧。名前で絞る場合は従来どおり部分一致なので、短い名前は別のスイートも選ぶ。
- `npm run test:e2e` は実際の LLM を呼び出すため、実サービスとの接続確認が必要な変更で実行する。
- 現在は独立したビルドコマンドはない。文書のみの変更では、内容と `git diff --check` の確認を行えばよい。
- UI の変更では必要に応じてブラウザーで表示・操作を確認する。`agent-browser` を使い（会話に内蔵ブラウザーがあればそれ）、無ければ `playwright-cli`。ユーザーによるツール・ブラウザー指定があればそれに従う。
  - LLM を呼ばずに画面を見るなら、fake バックエンドを別ポート・別のデータ置き場で立てる（実データを汚さないため）: `AGENT_HOST_BACKENDS=fake AGENT_HOST_DATA=<一時ディレクトリ> AGENT_HOST_PORT=7499 node core/server.mjs`。トークン付き URL は起動ログに出る。tests/browser/*.cjs は日本語の文言で要素を引くので、OS が日本語でなければ `AGENT_HOST_LOCALE=ja` も付ける。
  - 指定ポートが埋まっていると空きポートへ移る。止めるときは起動したプロセスの PID か、起動ログの実際のポートで引いた PID を使う。**指定したポート番号で PID を引いて止めない**（そのポートを持っていた別の作業のサーバーを殺す）。
  - 実データで測るときは `node scripts/copy-data-dir.mjs <temporary/ の下の写し先>` で `~/.agent-host` を写し（手でコピーしない。**`remote/` と `*-secrets.json` は写さない**。DB は動いている間にファイルをコピーせず、読み取り専用の接続で `VACUUM INTO` する。写しの `agent_tasks` は既定で空になる）、`AGENT_HOST_DATA=<写し>` で立てる。理由: リモートを有効にした置き場の写しは同じホストの鍵で中継へつなぎ、本物のホストの接続を追い出す。委譲の続きも走らせないため。写しには会話の中身も入るので、測り終えたら消す。委譲のタスクが載る送信量（`running` など）を測るときだけは `--keep-tasks` で残す（`docs/dev-verification.md`「重さと動きを測る」）。
  - fake の台本・種の置き方・測り方・デスクトップ版のハーネス、`playwright-cli` の落とし穴は `docs/dev-verification.md`。テストやブラウザーの確認でつまずいたら先に見る。
- コミット前に差分を確認し、対象ファイルを明示してステージする。検証が失敗した場合は原因を調べ、未解決のまま完了扱いにしない。

## データ置き場の保存（ADR 0115）

- **データ置き場に、記録の件数や会話の長さとともに大きくなる単一ファイルを作らない。** 件数・長さ・時間で増える記録は、DB（`pleiad.db`。`core/db.mjs`）の行にし、書くのは変わった行だけにする。会話の記録・委譲のタスク・使用量・会話の索引は、すでに行になっている。
- JSON ファイル（`writeAtomic`・`fs.writeFile`・`jsonFile` など）で丸ごと書くのは、**上限の決まったもの**（設定・台帳・固定の小ささの印）だけ。書く箇所を足すときは `tests/data-writes-allowlist.mjs` に、ファイル名・上限（定数名と値）・理由を書く。`npm test` の `data-writes` が、`core/`・`desktop/`・`bin/` の書き込み（別名・FileHandle・ストリーム・コピー・リネームを含む）でリストに無いものを落とす。上限を書けないものは、行にする。
- 「上限が決まっていない」書き先は、許可リストの `unbounded: true` の既知の例外だけ（会話の本文・記憶の markdown など）。**増やさない**（`data-writes` が件数を数える）。行へ移したときに減らす。追記だけのログ（`appendOnly: true`。1 回の更新が 1 行の追記で、更新の重さが大きさに比例しない）は例外に数えないが、理由を書く。スレッドの状態や進みの印のように、数が使うほど増えて更新のたびに全体を書き直すものは、JSON にせず DB の行にする。
- 件数・会話の長さで増える項目を会話の記録（`store.setSessionData` の受け付ける項目）へ足すときは、大きくなりうるかを先に考える。件数に上限が無いなら、上限（会話あたりの件数・古いものを捨てる）を決めるか、別の行・表にする。`tests/unit/store-write-scale.mjs`（会話・タスク・使用量を 2,000 件入れて、1 件の更新が全体を直列化しないことを見る）を通す。
- **データ置き場は 1 つのプロセスだけが持つ**（`core/data-lock.mjs`。`pleiad.lock.db` の SQLite の排他ロック。OS がプロセスの終了で外すので、PID の生死では判断しない。`pleiad.lock` の PID は持ち主の表示だけ）。サーバー（と、それを経由する `store`・`usage`・`agent-tasks`・`conversations`）以外でデータ置き場の DB を開く道具は、読み取り専用の接続（`core/db.mjs` の `openReadOnly`）だけにする。書く道具を足さない（サーバーが動いている間に別のプロセスが書くと、消した会話が欠けた形で戻るなど記録が壊れる）。テストが DB へ直に書くときは、サーバー・store を止めている間に `tests/lib/data-store.mjs` を使う。
- 公開関数（`core/store.mjs`）は、DB への書き込みが失敗したら例外を返し、メモリの記録を書く前のままにする。DB を先に書き、書けたらメモリへ反映する。書けなかった分を黙ってメモリに残さない。**例外が返るので、保存を呼ぶときは必ず await・return・`.catch` のどれかで受ける**（待たずに呼ぶと、処理されない拒否になる。`core/server.mjs` には念のための `unhandledRejection` の受け止めがあるが、頼らない）。`tests/unit/server-store-failures.mjs` が、書き込みを全部失敗させたサーバーで `[unhandledRejection]` が出ないことを見る。
- **テストは、利用者の本物のデータ置き場（`~/.agent-host`）を開かない。** `tests/run.mjs` は最初の import（`tests/lib/test-env.mjs`）で、`AGENT_HOST_DATA` が無ければ一時ディレクトリにし、本物の置き場を `PLEIAD_TEST_GUARD_HOME` に入れる。値がある間、`core/test-guard.mjs` が、その中を DB・ロック・形式の移行・設定の JSON で開こうとすると例外にする（`AGENT_HOST_DATA` を本物へ向けても、子プロセス・サーバーでも）。理由: 開いただけで形式の移行が走る作りなので、置き場を指定しないテスト（core を同じプロセスに読み込む）が、利用者のデータを書き換えた（2026-10-03）。テストを足すときは、core を読み込んで置き場を開くなら、自分の一時ディレクトリを `AGENT_HOST_DATA`・`dataDir` で渡す。`tests/unit/test-guard.mjs` が守りを確かめる。
- DB の形（表・形式番号）を変える変更は、形式番号を上げ、`core/schema-migration.mjs` の形（写し → 取り込み → 読み戻して突き合わせ → 番号の更新。失敗したら元に触れない）で移行を足す（`docs/desktop-releases.md`「適用とデータ保護」）。

## 使い捨てのもの（temporary/）

- モック・調査や提案のメモ・スクリーンショット・一回きりのスクリプトは、メインの作業ディレクトリの `temporary/` に置き、コミットしない（`.gitignore` 済み）。worktree の中の `temporary/` は worktree と一緒に消えるので、worktree で作業していても絶対パスでメイン側に書く。
- 置き場は `temporary/mockups/<題>.html`・`temporary/reports/<題>.md`・`temporary/screenshots/<題>-<場面>.png`・`temporary/scripts/`。題は英小文字とハイフン（例 `background-panel`）。改訂は上書きし、並べて比べる版だけ `-v2` などを付ける。
- コミットするのはコード・テストと、今の動きを書いた文書（`docs/`）と ADR（`docs/adr/`）だけ。モックで承認された形は、モックへのリンクではなく決まった形と日付を `docs/design-system.md` などの本文に書く（「承認済み（2026-09-25）」）。理由を残す価値があれば ADR にする。コード・テストのコメントもモックではなく文書の節を指す。
- 調査の結論のうち残すものは、要点だけを該当する文書に書く。経過と材料は `temporary/reports/` に残す。

## 決定の記録（ADR）

- 元に戻すのが高くつく決定（データの正本・プロトコル・保存形式・外部との接続）、安全と権限に関わる決定、`docs/design.md` の「思想」「やらない」を変える決定、ユーザーが承認した UI の案、開発・運用の決まりは `docs/adr/NNNN-<題>.md` に書く（`docs/adr/0001-record-decisions-in-adr.md`）。実装の修正や既存の規則の範囲内の手直しには書かない。
- 書式は「状態・状況・決定・理由・影響」。状態は `提案` → `承認（日付）` → `置換（NNNN）`／`却下`。`承認` にするのはユーザーの承認を受けたときだけ。`提案` のまま main に入れてよい。承認後は本文を書き換えず、変えるときは新しい ADR で置き換える。
- 長く並行するブランチの ADR は仮の番号で書き、main に入れる直前にその時点の main の最大の次から振り直す（main 側の番号と重なるため）。番号だけの参照（`ADR 0094`）は、その行が main の版にあれば main の ADR、ブランチの版だけにあれば振り直す側として見分ける。ファイル名つきの参照は名前で決まる。振り直しは main を取り込む**前**にブランチの上でコミットしておくと、ブランチの中の番号はすべてブランチ側の ADR なので機械的に置き換えられる（取り込んだ後は main の同じ番号と混ざる）。前の回の仮番号の参照が残りやすいので、置き換えの後に `docs/adr/` に無いファイルへのリンクと、その範囲の番号を grep で確かめる（2026-10-03、0.6.0 で `ADR 0098` が 4 か所残っていた）。
- living doc（design.md・design-system.md など）は今の形だけを書き、理由は `（[ADR NNNN](adr/…)）` で ADR を指す。

## main への反映

- 検証が通った変更をコミットし、メインの作業ディレクトリで `main` にマージする。ここまでを通常作業として、都度の確認なしで進める。
- マージ直前に `main` と作業ツリーの状態を再確認する。作業中に `main` が進んだ場合は、作業用 worktree に取り込み、統合後の内容を再確認してからマージする。
- 競合は作業用 worktree 内で解決し、影響する検証を再実行する。意図を判断できない競合はユーザーに確認する。
- 他の変更を巻き込む操作や、履歴の強制的な書き換えは行わない。
- リモートへの push は、ユーザーから明示的に依頼された場合だけ行う。

## サーバー起動・確認

- マージ後は `main` の作業ディレクトリから `npm start` でサーバーを起動し、応答を確認する。依存関係が変わった場合は起動前に `npm ci` を実行する。
- 既定のアドレスは `127.0.0.1:7420`。`AGENT_HOST_BIND` と `AGENT_HOST_PORT` で変更でき、指定ポートが使えない場合は空きポートに切り替わるため、実際の URL は起動ログで確認する。
- 認証付き URL で画面が取得できることを確認する。認証なしのアクセスは正常でも HTTP 401 になるため、401 だけで画面の動作確認済みとはしない。トークンをコミットや共有ログに含めない。
- 既存サーバーがある場合は、対象リポジトリのプロセスとポートを確認する。文書のみの変更など、再起動が不要なら既存サーバーの応答確認でよい。
- インストール版の Pleiad から起動されたエージェントのシェルには、Pleiad 自身の `AGENT_HOST_PORT`・`AGENT_HOST_BIND`・`ELECTRON_RUN_AS_NODE=1` が引き継がれている。そのまま `npm start` すると、既定の `~/.agent-host` を使う 2 台目になるので、データ置き場のロック（`core/data-lock.mjs`）で起動を止める（持ち主の PID を出す。止まらなかった頃は空きポートへ移って 2 台目が立っていた）。ポートの持ち主が `Ply.exe` ならリポジトリのサーバーではないので止めない。main から確かめるなら別ポート・別のデータ置き場で起動する。`electron.exe` は `env -u ELECTRON_RUN_AS_NODE` を付けて起動する（付けないと Node として動く）。`web/` はリクエストごとにディスクから読むため、リポジトリのサーバーなら画面だけの変更に再起動は要らない。
- **再起動すると実行中のターンが終了する。** 停止前に UI の実行中表示または WebSocket の `running` コマンドで実行中の作業が 0 件であることを確認する。実行中なら完了を待つ。確認できない場合や中断が必要な場合は、理由を伝えてユーザーに確認する。
- 再起動時は確認済みの対象サーバーだけを停止する。他の Node.js プロセスを一括停止しない。Windows でバックグラウンド起動する場合は `Start-Process -WindowStyle Hidden` を使う。

## 完了と後片付け

- main への反映とサーバーの動作確認後、今回作成した worktree に未コミット変更がなく、ブランチが main にマージ済みであることを確認する。
- 今回の worktree を `git worktree remove <確認済みの絶対パス>` で削除し、作業ブランチを `git branch -d <ブランチ名>` で削除する。強制削除は使わない。
- 完了報告には変更内容、検証結果、コミット、main への反映状況、サーバーの状態を簡潔に記載する。未完了の手順がある場合は理由を明示する。
