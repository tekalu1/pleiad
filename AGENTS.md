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
| `AGENT_HOST_WORKTREES` | `off` で分けた作業場所（git worktree。ADR 0089）を作らない。テストが使う（`tests/lib/server.mjs`。このリポジトリが cwd のテストが `<リポジトリ>.pleiad` に残すのを防ぐ）。確かめるテストは一時のリポジトリで `on` を渡す |
| `AGENT_HOST_WORKTREE_GRACE_MS` | 分けた作業場所を作ってから、使われていないものとして自動で片付けるまでの猶予（既定 60 秒。ADR 0089）。テストが 0 にする |

デスクトップ版は `npm run desktop`、インストーラーの生成は `npm run desktop:dist`（対象 OS で実行）。リリースの運用は `docs/desktop-releases.md`。

## 実装と検証

- 作業用 worktree 内で実装・検証・コミットを行い、依頼に必要な変更だけを含める。
- 開発環境は Node.js 20 以上。依存関係の導入には `npm ci` を使う。
- 作成直後の worktree には `node_modules` が無い。依存が `main` と同じなら、PowerShell から `cmd /c mklink /J <worktreeの絶対パス>\node_modules <メインの作業ディレクトリの絶対パス>\node_modules` でジャンクションを張れば足りる（Bash tool の `cmd //c mklink` は失敗する）。外すときは `cmd /c rmdir <worktreeの絶対パス>\node_modules`（`rm -rf` はリンク先の実体を消す恐れがある）。
- テストは必ず作業用 worktree の中で実行する。`main` の作業ディレクトリで `npm test` を走らせても worktree の変更は検証できない。
- 設計は `docs/design.md`、画面の変更は `docs/design-system.md` を参照する。
- 画面・AI・CLI へ外に出す機能は、WS の case を足すだけにせず `core/ops/` に操作として定義する（ADR 0081）。足し忘れは `npm test` の ops-coverage が落とす（`tests/ops-baseline.json` の `todo` は増やせない）。設定（prefs.json）を足す・変えるときは `core/ops/settings.mjs` の `defineSetting`（危険度・`normalize`・`write`）に書き、`store.setPref` を直に呼ばない（画面の `setPref` も AI の `settings.set` も同じ定義を通る。`ops-coverage` が落とす）。操作の危険度・出す口を変えたら `OPS_UPDATE_SNAPSHOT=1 npm test -- ops-surface` で snapshot を更新し、差分を確認する。
- 画面・エラー・エージェント向けの文言は辞書（`web/locales/<言語>/<名前空間>.json`）に置き、`t()` で引く（`docs/design.md`「多言語対応」、訳語は `docs/i18n-glossary.md` に従う）。直書きの日本語は `npm test` の lint-i18n が落とす。基準（`tests/i18n-baseline.json`）の更新は減らすときだけ（`node tests/lint-i18n.mjs --update-baseline`）。
  - `web/locales/*/ui.json` は `JSON.stringify(…, null, 2)` の整形と一致しないので、読んで書き直さず、キーは文字の置き換えで足す。`sed '/"connected"/d'` のような行単位の削除は別の節の同じキーまで消すので使わない。
- コード変更後は `npm test` を実行する。通常テストは実際の LLM を呼び出さない。1 本だけなら `node tests/run.mjs <ケース名>`。
  - 全件（244 本・約 8700 判定。2026-10-03）は 1 回で 12〜15 分かかり、Bash tool の 1 回の上限（600 秒）を超える。`timeout 590 npm test` は途中で打ち切られ、その結果は通ったとみなさない。
  - 分けて流す: `node tests/run.mjs __none__ 2>&1 | grep "あるのは"` で名前の一覧を取り、ファイルに書いて分け、`node tests/run.mjs <名前…>` で 1 回ずつ流す。全部の「全て通過」の行を確かめる。名前は部分一致で選ぶので、短い名前は別のテストも拾い、本数は少し増える。2 つに分けた前半（125 本）が 568 秒だったので、3 つに分けると余裕がある。
- `npm run test:e2e` は実際の LLM を呼び出すため、実サービスとの接続確認が必要な変更で実行する。
- 現在は独立したビルドコマンドはない。文書のみの変更では、内容と `git diff --check` の確認を行えばよい。
- UI の変更では必要に応じてブラウザーで表示・操作を確認する。`agent-browser` を使い（会話に内蔵ブラウザーがあればそれ）、無ければ `playwright-cli`。ユーザーによるツール・ブラウザー指定があればそれに従う。
  - LLM を呼ばずに画面を見るなら、fake バックエンドを別ポート・別のデータ置き場で立てる（実データを汚さないため）: `AGENT_HOST_BACKENDS=fake AGENT_HOST_DATA=<一時ディレクトリ> AGENT_HOST_PORT=7499 node core/server.mjs`。トークン付き URL は起動ログに出る。tests/browser/*.cjs は日本語の文言で要素を引くので、OS が日本語でなければ `AGENT_HOST_LOCALE=ja` も付ける。
  - 指定ポートが埋まっていると空きポートへ移る。止めるときは起動したプロセスの PID か、起動ログの実際のポートで引いた PID を使う。**指定したポート番号で PID を引いて止めない**（そのポートを持っていた別の作業のサーバーを殺す）。
  - 実データで測るときは `~/.agent-host` を `temporary/` の下へ写し、`<写し>/remote/` と `<写し>/agent-tasks.json` を消してから `AGENT_HOST_DATA=<写し>` で立てる。理由: リモートを有効にした置き場の写しは同じホストの鍵で中継へつなぎ、本物のホストの接続を追い出す。委譲の続きも走らせないため。写しには秘密も入るので、測り終えたら消す。委譲のタスクが載る送信量（`running` など）を測るときだけは `agent-tasks.json` を残す（`docs/dev-verification.md`「重さと動きを測る」）。
  - fake の台本・種の置き方・測り方・デスクトップ版のハーネス、`playwright-cli` の落とし穴は `docs/dev-verification.md`。テストやブラウザーの確認でつまずいたら先に見る。
- コミット前に差分を確認し、対象ファイルを明示してステージする。検証が失敗した場合は原因を調べ、未解決のまま完了扱いにしない。

## 使い捨てのもの（temporary/）

- モック・調査や提案のメモ・スクリーンショット・一回きりのスクリプトは、メインの作業ディレクトリの `temporary/` に置き、コミットしない（`.gitignore` 済み）。worktree の中の `temporary/` は worktree と一緒に消えるので、worktree で作業していても絶対パスでメイン側に書く。
- 置き場は `temporary/mockups/<題>.html`・`temporary/reports/<題>.md`・`temporary/screenshots/<題>-<場面>.png`・`temporary/scripts/`。題は英小文字とハイフン（例 `background-panel`）。改訂は上書きし、並べて比べる版だけ `-v2` などを付ける。
- コミットするのはコード・テストと、今の動きを書いた文書（`docs/`）と ADR（`docs/adr/`）だけ。モックで承認された形は、モックへのリンクではなく決まった形と日付を `docs/design-system.md` などの本文に書く（「承認済み（2026-09-25）」）。理由を残す価値があれば ADR にする。コード・テストのコメントもモックではなく文書の節を指す。
- 調査の結論のうち残すものは、要点だけを該当する文書に書く。経過と材料は `temporary/reports/` に残す。

## 決定の記録（ADR）

- 元に戻すのが高くつく決定（データの正本・プロトコル・保存形式・外部との接続）、安全と権限に関わる決定、`docs/design.md` の「思想」「やらない」を変える決定、ユーザーが承認した UI の案、開発・運用の決まりは `docs/adr/NNNN-<題>.md` に書く（`docs/adr/0001-record-decisions-in-adr.md`）。実装の修正や既存の規則の範囲内の手直しには書かない。
- 書式は「状態・状況・決定・理由・影響」。状態は `提案` → `承認（日付）` → `置換（NNNN）`／`却下`。`承認` にするのはユーザーの承認を受けたときだけ。`提案` のまま main に入れてよい。承認後は本文を書き換えず、変えるときは新しい ADR で置き換える。
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
- インストール版の Pleiad から起動されたエージェントのシェルには、Pleiad 自身の `AGENT_HOST_PORT`・`AGENT_HOST_BIND`・`ELECTRON_RUN_AS_NODE=1` が引き継がれている。そのまま `npm start` すると空きポートへ移り、既定の `~/.agent-host` を使う 2 台目が立つ。ポートの持ち主が `Ply.exe` ならリポジトリのサーバーではないので止めない。main から確かめるなら別ポート・別のデータ置き場で起動する。`electron.exe` は `env -u ELECTRON_RUN_AS_NODE` を付けて起動する（付けないと Node として動く）。`web/` はリクエストごとにディスクから読むため、リポジトリのサーバーなら画面だけの変更に再起動は要らない。
- **再起動すると実行中のターンが終了する。** 停止前に UI の実行中表示または WebSocket の `running` コマンドで実行中の作業が 0 件であることを確認する。実行中なら完了を待つ。確認できない場合や中断が必要な場合は、理由を伝えてユーザーに確認する。
- 再起動時は確認済みの対象サーバーだけを停止する。他の Node.js プロセスを一括停止しない。Windows でバックグラウンド起動する場合は `Start-Process -WindowStyle Hidden` を使う。

## 完了と後片付け

- main への反映とサーバーの動作確認後、今回作成した worktree に未コミット変更がなく、ブランチが main にマージ済みであることを確認する。
- 今回の worktree を `git worktree remove <確認済みの絶対パス>` で削除し、作業ブランチを `git branch -d <ブランチ名>` で削除する。強制削除は使わない。
- 完了報告には変更内容、検証結果、コミット、main への反映状況、サーバーの状態を簡潔に記載する。未完了の手順がある場合は理由を明示する。
