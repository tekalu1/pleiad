# リリースでの main の CI の結果の使い方

タグの `Evaluation release`（`.github/workflows/evaluation-release.yml`）は、同じ commit の main の CI（`.github/workflows/test.yml` の push の run）が、必須のジョブを全部通していれば、その結果を使って release の中の `npm test` を省く。
CI が赤ければ公開しない。使える成功が無ければ、今までどおり release の中で `npm test` を全部回す（[ADR 0130](adr/0130-release-reuses-main-ci.md)）。

## 流れ

1. `ci-gate` ジョブ（ubuntu、権限は `actions: read` と `contents: read` だけ）が `scripts/release-ci-gate.mjs` を走らせる。
   タグを commit に解き（注釈つきのタグは指す commit まで剥がす）、GitHub の API を読むだけ（GET）で判定する。トークンは `github.token` で、値はログに出さない。
2. 判定が「赤」ならこのジョブが失敗し、署名・公開をする `release` ジョブは走らない。
3. `release` ジョブ（windows）は、checkout した commit が `ci-gate` の照合した commit と同じかを確かめる。
   判定が `reuse` なら短い検査（下記）だけ、それ以外（`fallback`・空・想定外の値）なら `npm test` を全部回してから署名・公開へ進む。

## 判定の規則

対象にする run は次をすべて満たすものだけ。API の絞り込みに加えて、スクリプトでも 1 件ずつ確かめる。

- workflow が `.github/workflows/test.yml`（名前で引いた workflow の id と path が一致し、`active`）
- `head_sha` がタグの指す commit、`event` が `push`、`head_branch` が `main`、リポジトリ（fork でない）が同じ
- jobs は run の**最新の attempt**の番号で読み、各ジョブの `run_id`・`run_attempt`・`head_sha` も一致する

| 状態 | 判定 |
|---|---|
| 最新の attempt で、必須の 6 ジョブがちょうど 1 つずつ `success`、ほかのジョブも `success`（push で飛ばす `safe-storage-macos` だけは `skipped` でよい）、run の結論も `success` | `reuse` |
| run かジョブ（必須でないものも）が `failure`・`timed_out`・`action_required`・`startup_failure` | **赤**。公開しない。走っている途中でも、終わったジョブが赤ければ待たずに止める。同じ commit の run が複数あり、どれかが赤ければ止める |
| run・ジョブが終わっていない | 待つ（下記） |
| run が無い（`site/**` だけの変更・まとめて push した途中の commit など） | `fallback` |
| `cancelled`（次の push に取り消された）・`skipped`・`neutral` など | `fallback` |
| 必須のジョブの欠け・重複・一部だけの成功、必須でないジョブの `cancelled`・`skipped`・`neutral`、run の総合の `success` だけ、jobs を読めない | `fallback` |
| 別の commit・別の workflow・PR・手動の起動・別の枝の成功しか無い | `fallback` |
| `reuse` と判定した直後に run を読み直すと、attempt・状態・結論が変わっていた（jobs を読んだ後に再実行が始まった） | 待つ。新しい attempt を同じ規則で見直す |
| API の失敗（HTTP の失敗・時間切れ）が 3 回続いた | `fallback`。テストを省く方には倒さない |

必須の 6 ジョブ（`REQUIRED_JOBS`）は、test.yml が main の push で回す `test (ubuntu-latest, 22.13)`・`test (ubuntu-latest, 24)`・`test (windows-latest, 22.13)` と `safe-storage (windows-dpapi)`・`safe-storage (linux-gnome-keyring)`・`safe-storage (linux-no-keyring)`。
週次・手動だけの `safe-storage-macos` は push では `skipped` になる。`skipped` を許すのはこれだけ（`SKIPPED_ON_PUSH`）。
test.yml の matrix やジョブを変えたら `REQUIRED_JOBS`・`SKIPPED_ON_PUSH` も合わせる。`tests/unit/release-ci-gate.mjs` が test.yml を読んで突き合わせるので、合わせ忘れるとその commit の CI が赤くなり、そのままではリリースできない。
合わせ忘れたまま足したジョブが `success` 以外で終わっても、`reuse` にはならない（上の表）。

## 待ち方

- 30 秒ごとに読み直し、40 分で打ち切る（`--wait-minutes 40`。test.yml のジョブの上限は 30 分）。打ち切ったら `fallback`。
- 始めの 5 分は、run が無いのも待つ（`--missing-grace-minutes 5`）。タグと main を同時に push すると、release が test.yml の run より先に始まることがあるため。
- API の 1 回の呼び出しは、応答の本文を読み終えるまでを 20 秒で打ち切る（`--request-timeout-seconds 20`）。接続や本文が止まっても、待ちの期限の判定へ戻る。
- API から来た文字（ジョブの名前など）は 1 行にしてから書く。ログは `ci-gate: ` で始め、`GITHUB_OUTPUT` は `decision` を最後の行に書く（ログの行頭が workflow command の `::` にならず、出力の行も増やせない）。
- 待つのは `ci-gate`（ubuntu）で、Windows の runner は使わない。ジョブの上限は 50 分。
- 引数は、知らない名前・同じ名前の 2 回目・10 進の 0 以上の数でない時間（NaN・Infinity・負など）・0 の間隔と時間切れを拒み、`ci-gate` を落とす（公開しない）。綴りを間違えた設定が既定値で走らないようにするため。

## CI との環境の差

`reuse` は「OS・Node・lockfile・commit が CI の Windows の脚と同じ」ことを前提にする。残る差と扱いは次のとおり。

| 差 | 扱い |
|---|---|
| Node の版 | release の `setup-node` を test.yml の Windows の脚と同じ `"22.13"` にした（前は `22` で、22 系の最新が入っていた）。テストが突き合わせる。配布物の中で core を動かすのは Electron の同梱 Node（24 系）で、ビルドの Node ではない |
| 依存 | 同じ lockfile から `npm ci`。release だけ、その後に koffi の arm64 の本体を `--force` で足す。`reuse` のときは足した後の `node_modules` で、`koffi`・`node-pty` を読めるかと、`computer-native`（本物の koffi の構造体の配置）・`desktop-updates`（配布の手順のスクリプト）の 2 本を回す |
| `TEMP`・`TMP` | release はテストの一時ファイルを `RUNNER_TEMP` の下に分けている。テストの置き場の違いで、配布物には入らない。`fallback` の全部のテストと `reuse` の短い検査の両方に効く |
| runner の image | どちらも `windows-latest`。image の版までは揃えない |

署名・ビルド・配布物の検査（`build-evaluation.ps1` の署名の確認、`release-artifacts.mjs`、アップロードしたものの SHA-256 の照合）は今までどおり release で行う。

## 保証の範囲

- 公開を止められるのは、照合が**読めた**結果が赤のときだけ。
- 次のときは `fallback` で release の中のテストを全部回し、通れば公開まで進む。
  - API の結果が分からない（失敗・時間切れが続いた）
  - 期限までに終わらなかった
  - run が無い
  - `cancelled`

  このとき main の CI が赤かどうかは分からないままで、照合はそれを保証しない。保証は「release の中の全部のテストが通った」ことだけになる。
- `reuse` の直前の読み直しの後に始まった再実行は見ない。その attempt が後で赤くなっても、公開は止まらない（同じ commit で、揃った成功を一度確かめている）。

## 止まったとき

- **赤で止まった**: main を直すか、test.yml の失敗したジョブを再実行して最新の attempt を揃った成功にしてから、Evaluation release を再実行する（失敗した run の再実行、または `workflow_dispatch` に同じタグ）。
- **`fallback` で全部のテストを回した**: 理由は `ci-gate` の step summary とログの `reason=` に出る。`fallback` は今までと同じ流れなので、そのまま公開まで進む。

## 範囲

- 手動の `desktop-release.yml` は変えていない。macOS も配る（test.yml は push で macOS を回さない）ので、同じ commit の CI だけでは代わりにならない。
- main の ruleset に required check は無い。この照合が見るのはリリースだけで、main への merge は止めない。
