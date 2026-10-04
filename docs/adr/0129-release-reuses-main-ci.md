# 0129 タグのリリースは、同じ commit の main の CI の揃った成功を確かめて npm test を省き、赤なら公開しない

- 状態: 承認（2026-10-04）

## 状況

タグ `v*` の `Evaluation release`（`.github/workflows/evaluation-release.yml`）は、Windows で `npm test` を全部回してから署名・公開していた。同じ commit を main へ push した `test.yml` も、同じ時刻に Windows の `npm test` を回している。release の job の 7 割（11〜13 分）は、この同じテストのやり直しだった。

一方で、release は main の CI の結果を見ていなかった。v0.7.3 では、同じ commit の `test.yml` の Windows の脚がまだ走っている間に公開が始まった。その脚は attempt 1 で失敗し、再実行で成功した。CI が赤くても配布できる状態だった。

release と CI の環境は少し違う。release は Node 22 の最新を使い、koffi の arm64 の本体を `--force` で足し、テストの `TEMP` を分けている。CI の Windows の脚は Node 22.13 で動く。

## 決定

- **使える成功**: 次のすべてを満たす run の結果だけを使い、release の `npm test` を省く。
  - タグが指す commit（注釈つきのタグは剥がした先）と同じ `head_sha` を持つ
  - workflow が `.github/workflows/test.yml`（id・path が一致し、`active`）
  - `push` で起動し、`main` の枝、同じリポジトリ
  - 最新の attempt で、必須の 6 ジョブがちょうど 1 つずつ `success`（3 つの Node / OS の `test` と `safe-storage` 3 つ）
  - run の結論も `success`
  - run の総合の `success` だけ、一部のジョブだけ、`skipped` を含むものは使わない。
- **赤なら公開しない**: run かジョブ（必須でないものも）に `failure`・`timed_out`・`action_required`・`startup_failure` があれば、照合のジョブが失敗し、署名・公開のジョブは走らない。走っている途中でも、終わったジョブが赤なら止める。同じ commit の run が複数あれば、1 つでも赤なら止める。
- **終わっていなければ待つ**: 上限は 40 分。run がまだ無いのも、始めの 5 分は待つ。
- **それ以外は今までどおり release で全部回す（fallback）**: 次の場合は release の中で `npm test` を全部回してから公開する。
  - run が無い
  - `cancelled`・`skipped`・`neutral`
  - ジョブの欠け・重複
  - 別の commit・別の workflow・PR・手動の起動の成功しか無い
  - 待つ上限を超えた
  - API の失敗が続いた

  判定の値が空・想定外のときも全部回す側にする。
- **環境の差**:
  - release の Node は、`test.yml` の Windows の脚と同じ `22.13` にそろえる。
  - 使える成功があるときも、release だけの差（足した koffi の本体）は、`koffi`・`node-pty` の読み込みと `computer-native`・`desktop-updates` の 2 本で確かめる。
  - 署名・配布物の検査は今までどおり release で行う。
- **権限**: 照合は、書く権限を持たない別のジョブ（`actions: read`・`contents: read`）が、GitHub の API の GET だけで行う。
- **CI の仕様との結び付け**: 必須のジョブの名前（`scripts/release-ci-gate.mjs` の `REQUIRED_JOBS`）は、`test.yml` の check の名前と Node / OS の構成に合わせる。`tests/unit/release-ci-gate.mjs` が `test.yml` を読んで突き合わせる。

## 理由

- 同じ commit・同じ OS・同じ Node・同じ lockfile で通った CI の結果は、release の `npm test` と同じことを確かめている。別の commit・別の workflow・古い attempt の成功は、配る中身を確かめていないので使わない。
- 赤を止めるのは、v0.7.3 のように、CI が赤い commit が配られるのを防ぐため。フレークかどうかは release からは分からない。再実行で最新の attempt が揃った成功になれば、release を再実行して公開できる。
- 欠損・`cancelled` を止めずに全部回すのは、どれも「赤い」とは言えないため。
  - `site/**` だけの変更は paths-ignore で run が無い。
  - まとめて push した途中の commit にも run は無い。
  - 次の push で取り消された run は `cancelled` になる。

  これらで止めるとリリースできない場面が増え、使って省くと確かめていない commit が配られる。今までの流れ（release の中で全部回す）に戻すのが、どちらも避けられる。
- 待つのは、タグと main を同時に push するのがふつうの手順で、CI は release より後に終わるため。Windows の脚は今 15〜16.5 分で、`test.yml` のジョブの上限は 30 分。
- 採らなかった案:
  - release の `npm test` をただ消す（CI の結果を見ないまま配る）。
  - CI の結果を待たずに使う（v0.7.3 と同じ）。
  - 未完了・欠損でも止める（paths-ignore・取り消しのたびにリリースが止まる）。
  - release の Node を 22 の最新のまま、CI の結果を使う（CI が見ていない版になる）。

## 影響

- release は、使える成功があれば署名・公開と短い検査だけになる。待つ間は ubuntu の runner を最大 50 分使う。
- `test.yml` のジョブ・check の名前・matrix を変えるときは `REQUIRED_JOBS` も合わせる。合わせ忘れると、その commit の CI が赤くなり、リリースは止まる。
- release のビルドの Node が 22 の最新から 22.13 になる。配布物の core は Electron の同梱 Node で動くので、配る側の実行環境は変わらない。
- 手動の `desktop-release.yml` は変えない。macOS も配り、`test.yml` は push で macOS を回さないので、この結果では代わりにならない。
- 規則と止まったときの対処は `docs/release-ci-reuse.md`。
