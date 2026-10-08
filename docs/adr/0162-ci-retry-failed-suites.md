# 0162 CI は落ちた suite だけを 1 回流し直し、版上げは 1 本のスクリプトにして、手元の npm test 全部をやめる

- 状態: 承認（2026-10-08）
- 補足する: [0131](0131-test-workers.md)（「ちょうど 1 回ずつ走る」整合は保つ。流し直しは別の記録）、[0130](0130-release-reuses-main-ci.md)（読み方は変えない）

## 状況

beta.7〜9 のリリースは、どれも同じ形で止まった。同じ commit の main の CI で Windows の脚の 1 回目が赤になり（約 14〜15 分の時点）、`ci-gate` がその場で失敗した。人が test を再実行して緑を待ち、release を起こし直すまでに、1 回のリリースが約 36 分と手作業 2 回かかった。

落ちていたのは毎回違う suite の 1 本だけ（webhook・adopt-agy・holder-core・server-git・desktop-job の EBUSY・remote-agent・routines-schedule）。10-06〜07 の main の push 24 回のうち 8 回（33%）で Windows の 1 回目が赤で、うち 7 回は再実行で 1 本が通った。特定の試験を隔離しても効かない。原因は別の作業で直している。

あわせて、手元では版上げの後に `npm test` 全部（約 12 分）を流してからタグを打っていた。同じ commit の CI が同じことをもう一度やるうえ、赤い commit は `ci-gate` が公開を止める。版上げの手順（版 3 か所・原稿・prepare・検査・commit・タグ）は文書だけで、スクリプトが無かった。main とタグを別々に push して、main だけが通らずタグだけが main に無い commit を指した事故もある（beta.6）。さらに `test.yml` は main の push でも古い run を止めるので、タグを打った commit の CI が次の push に取り消され、release が全部のテストを回し直す（約 28 分）ことがあった。

## 決定

- **CI では、落ちた suite だけを 1 回流し直す**: `tests/run.mjs --retry-failed 1`。全体を走らせた後、判定が落ちた・例外で中断した suite だけを、新しい worker（新しいプロセスと一時のデータ置き場）で 1 回だけ走らせる。通れば緑として扱い、2 回目も落ちれば赤（今までと同じ）。
  - 全 OS・3 つの脚の `test.yml` と、release の fallback の全部のテストに付ける。**手元の `npm test` の既定は変えない**（既定は `--retry-failed 0`）。
  - **流し直さない**: ランナーの整合の失敗（worker の異常終了・起動できず走らなかった・登録した名前と `export const name` の不一致・worktree の漏れ・子孫の回収を確かめられない）は、ADR 0131 のとおり失敗のまま。流し直しで通っても、1 回目の整合の問題は消さない。
  - **流し直したことは必ず見える形に残す**: 端末の一覧、`--timings` の JSON（`suites[].retried`・`totals.retriedSuites`・`totals.retriedPassed`・`workers[].retry`）、GitHub Actions の警告の注釈（`::warning`）とジョブのまとめ（`$GITHUB_STEP_SUMMARY`）。どの suite が 1 回目のどの判定で落ち、流し直しで通ったかを書く。2 回とも落ちたものもまとめに書く。
  - ジョブは success で終わるので、`ci-gate`（`scripts/release-ci-gate.mjs`）は変えない。ジョブの結論だけを読み、注釈は結論を変えない。
- **タグの前の手元の `npm test` 全部をやめる**: 手元で流すのはリリースノートの検査（`release:prepare`・`--require-new-notes`）と速い確認（`release-ci-gate`）だけ。コードの確かめは、その前の commit の CI と、タグの commit の CI を読む `ci-gate` が受け持つ。
- **版上げを `scripts/release-bump.mjs`（`npm run release:bump`）にまとめる**: 版は人が引数で渡す。前提（main の上・clean・origin/main より遅れていない・版が最新より新しい・タグが無い）を先に全部検査し、外れていれば何も書かない。package.json 1 か所・package-lock.json 2 か所を（改行を保ったまま）書き換え、原稿（`releases/<版>.json`。無ければ雛形を置いて止まる。`--notes` で取り込む）、`npm run release:prepare`、`--require-new-notes`、速い確認、4 ファイルだけの commit、タグ `v<版>`。途中で失敗したら版と生成物は元に戻す。**push は `--push` のときだけ**で、`git push --atomic origin main v<版>` で main とタグを一緒に送る（片方だけ通る事故を防ぐ）。既定は次に打つ命令を表示する。
- **main の push の CI を後の push で取り消さない**: `test.yml` の `cancel-in-progress` を PR のときだけ有効にする。main への push・手動の `concurrency.group` は commit ごとに分ける。`cancel-in-progress` を切るだけでは、同じ group で待っている run が次の push に取り消されるため。PR は今のとおり、同じ PR の古い run を止める。
- **「CI は無断でバージョンを決めたりコミット・タグを作ったりしない」は残す**: 版上げのスクリプトは人が打つコマンドで、push は `--push` を付けたときだけ。CI にタグを打たせる案、`ci-gate` を `workflow_run` で起こす案は、今回はやらない。

## 理由

- 赤の大半は 1 本の suite の揺れで、その suite だけを数十秒で流し直せば足りる。ジョブ全体を再実行すると 15 分かかり、ほかの 389 本もやり直すことになる。`GITHUB_TOKEN` で起こした再実行が `workflow_run` を起こすかという不確かさも避けられる。
- 本物の失敗は 2 回目も落ちるので、今どおり止まる。今は人が理由を見ずに再実行して出しているので、安全さは今より下がらない。流し直しを注釈とまとめに必ず残すので、同じ suite が何度も流し直されていれば気付ける。
- 流し直しを新しい worker にするのは、1 回目の残りもの（一時フォルダー・子プロセス・共有状態）を拾って通るのを避けるため。
- 手元の全部のテストをやめても、配られるものの安全さは変わらない（赤い commit は `ci-gate` が止める）。失うのは、赤い commit を main に置く十数分と、公開前のタグの付け替えだけ。
- `--atomic` と、タグの前に origin の状態を見る検査で、beta.6 の押し違いを防ぐ。

## 影響

- 準備から公開まで、単一の suite の揺れでは人の手が要らなくなる。見込みは約 32 分・手作業 2 回から、約 22 分・手作業 0 回。
- 揺れる試験は隠れやすくなる。注釈・まとめ・timings の `retried` を見て、同じ suite が繰り返し流し直されるなら試験か製品を直す。
- 流し直しは 1 回目に落ちた suite の再実行なので、`tests/lib/runner.mjs` の整合の検査（ちょうど 1 回ずつ走る）は 1 回目の記録で数える。
- `test.yml` の run が main で増える（続けて push したとき）。標準の runner は無料で、同時実行の枠にも収まる。
- 版上げの手順は `docs/desktop-releases.md`「バージョンと原稿」、`ci-gate` の規則は `docs/release-ci-reuse.md`。
