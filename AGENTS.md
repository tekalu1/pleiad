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

デスクトップ版は `npm run desktop`、インストーラーの生成は `npm run desktop:dist`（対象 OS で実行）。リリースの運用は `docs/desktop-releases.md`。

## 実装と検証

- 作業用 worktree 内で実装・検証・コミットを行い、依頼に必要な変更だけを含める。
- 開発環境は Node.js 20 以上。依存関係の導入には `npm ci` を使う。
- 作成直後の worktree には `node_modules` が無く、そのままでは `npm test` が走らない。依存が `main` と同じなら、`npm ci` の代わりに `cmd /c mklink /J <worktreeの絶対パス>\node_modules <メインの作業ディレクトリの絶対パス>\node_modules` でジャンクションを張れば足りる。消すときは `cmd /c rmdir <worktreeの絶対パス>\node_modules` を使う（`rm -rf` はリンク先の実体を消す恐れがある）。このジャンクション操作は PowerShell から実行する。Bash tool 経由の `cmd //c mklink /J …` は「パラメーターの形式が違っています」で失敗する。
- テストは必ず作業用 worktree の中で実行する。`main` の作業ディレクトリで `npm test` を走らせても worktree の変更は検証できない（worktree を編集しながら `main` でテストを走らせ、通ったことにしてしまった例がある）。
- 設計は `docs/design.md`、画面の変更は `docs/design-system.md` を参照する。
- 画面・エラー・エージェント向けの文言は辞書（`web/locales/<言語>/<名前空間>.json`）に置き、`t()` で引く（`docs/design.md`「多言語対応」、訳語は `docs/i18n-glossary.md` に従う）。直書きの日本語は `npm test` の lint-i18n が落とす。基準（`tests/i18n-baseline.json`）の更新は減らすときだけ（`node tests/lint-i18n.mjs --update-baseline`）。
  - `web/locales/*/ui.json` は `JSON.stringify(…, null, 2)` の整形と一致しない（1 行に畳んだ入れ子がある）ので、読んで書き直すと関係の無い行が大量に変わる。キーは文字の置き換えで足す。`sed '/"connected"/d'` のような行単位の削除は別の節の同じキーまで消すので使わない（2026-09-28、別の節の 3 行と `externalTooMany` を消した）。
- コード変更後は `npm test` を実行する。通常テストは実際の LLM を呼び出さない。
- WebSocket のコマンドを足すときは、`core/server.mjs` の `case` に加えて `core/protocol.mjs` の `COMMANDS` にも登録する。登録が無いとサーバーはエラーも返さず黙って捨て、テストの `cmd` は応答待ちのまま止まる（2026-09-28）。
- `core/server.mjs` の `case "loadSession"` の本文は、`tests/unit/session-stream.mjs` が文字列で切り出して vm の中で走らせる。そこで新しい関数を呼ぶなら、テストの `vm.createContext({ … })` にも渡す。渡さないと `ReferenceError: <名前> is not defined` で落ちる（2026-09-28、`attachCompactSummaries`）。`web/client.mjs` の `saveDraft`・`loadDraft`・`submit` なども `tests/unit/composer-new-session.mjs` が同じように vm で走らせるので、そこから新しいモジュールの定数を引くなら身代わりを足す（2026-09-28、`shellComposer`）。
- サーバー越しのテストで fake-codex のターンを走らせるときは `open({ ...host, autoAllow: true })` でつなぐ。fake-codex の既定の台本はコマンドの承認を求めるので、無いと `runTurn` が承認待ちで止まる（`open(host, { autoAllow: true })` のように第 2 引数で渡しても効かない）。
- `setTimeout(ms).unref?.()` を `Promise.race` に使う「最長 ms だけ待つ」処理（`core/delegation-usage.mjs` の `ensureFresh` など）を単体テストで確かめるとき、待たせる側（遅い処理）を手動で解決する Promise（`new Promise(r => { resolve = r })`）だけにすると、イベントループを保つものが無くなり、unref のタイマーごと発火せずに固まる（2026-09-28、`tests/unit/delegation-routing.mjs`）。待たせる側は必ず実タイマー（`setTimeout(fn, ms)`。unref しない）にする。
- `npm run test:e2e` は実際の LLM を呼び出すため、実サービスとの接続確認が必要な変更で実行する。
- 本物の Codex の app-server の JSON-RPC（通知の順・item の中身）を見るときは、stdio を 1 行ずつファイルに書きながら本物の `codex.exe` へ中継する node スクリプトを `AGENT_HOST_CODEX_BIN='node "<スクリプト>"'` に渡し、別ポート・別のデータ置き場でサーバーを立てる。理由: Pleiad の出来事からは turn/started や item の形が見えず、fake-codex は本物の形を仮に出しているだけ。2026-09-28 は、`thread/shellCommand` の直後の `turn/start` が同じターンに入って返答が消えることを、これで突き止めた（`temporary/scripts/shell-real/codex-tap.mjs`）。記録には会話の本文が載るので、測り終えたら消す。
- 現在は独立したビルドコマンドはない。文書のみの変更では、内容と `git diff --check` の確認を行えばよい。
- UI の変更では必要に応じてブラウザーで表示・操作を確認する。ブラウザー自動化は、まずシェルで `playwright-cli` と `agent-browser` の利用可否を調べ、前者があれば優先し、なければ後者を使う。ユーザーによるツール・ブラウザー指定があればそれに従う。
  - `playwright-cli` は `file:` を開けない（"Access to file: protocol is blocked"）。`temporary/mockups/` のモックを見るときは `python -m http.server 8799` をそのディレクトリで起動して `goto http://127.0.0.1:8799/<name>.html` で開く。`eval` は式の文字列ではなく `"() => { … }"` の関数を渡す（式だと `UtilityScript` のエラーで落ちる）。確認したら `playwright-cli close` とサーバー停止まで行う。
  - Visualize 向けに `<html>` の無い断片で書いたモックは、先頭に `<meta charset="utf-8">` を置く。無いと http.server で開いたとき日本語が文字化けし、`text=…` のセレクターも当たらない（2026-09-27）。
  - `playwright-cli` の `type` は対象を取らない（`type <text>` だけ）。欄を指定して入れるなら `fill <ref> <text>`。
  - 打鍵を並べる確認は `playwright-cli --raw run-code --filename=<.js>`（`async page => {…}`）に書くと `page.keyboard`・`setInputFiles`・`DataTransfer` の drop / paste・CDP の IME（`page.context().newCDPSession`）が使える。`type "- x"` のように `-` で始まる文字列はオプションと読まれて何も打たれない（`press Minus` を使う）。run-code に `Buffer`・`process` は無く、ファイルは `new File([...])` を `DataTransfer` に入れて `main` へ drop する。`tests/browser/composer-editor.cjs` が例（2026-09-29）。
  - fake で下書きをサーバー側に仕込んで読み直す確認は、読み直しの `pagehide` が空の欄で上書きし、中身の無い未送信の会話は消される。仕込むより、その会話の欄で実際に打って読み直す。旧形式の下書きに相当する状態は、添付を入れてから `$('prompt').value = …`（添付の実体を残したまま本文だけ替わる）で作れる。
  - 右クリックメニューの子メニュー（`状態を変更 ▸` など）は、親の項目を `.click()` しても開かないことがある。`eval` の中で `[...document.querySelectorAll('.pop.menu .li')].find(n => n.textContent.includes('…'))` を取り、`web/context-menu.mjs` が生やす `row.openSub(false)` を呼ぶ。`新しい状態を作る` は `.li` ではなく入力欄なので、`input[placeholder]` を探して値を入れ `keydown` の Enter を送る。
  - 数秒で消える表示（脇の下の「元に戻す」は 12 秒）は、出す `eval` と `screenshot` を 1 回のコマンドでつなげて撮る。別々に打つと撮る前に消える。
  - LLM を呼ばずに画面を見るなら、fake バックエンドを別ポート・別のデータ置き場で立てる（実データを汚さないため）: `AGENT_HOST_BACKENDS=fake AGENT_HOST_DATA=<一時ディレクトリ> AGENT_HOST_PORT=7499 node core/server.mjs`。トークン付き URL は起動ログに出る。tests/browser/*.cjs は日本語の文言で要素を引くので、OS が日本語でなければ `AGENT_HOST_LOCALE=ja` も付ける。
    - 任意の履歴（CLI が残す生の行など）を画面に出すなら、切り替え済みの会話の保存分として種を置く: データ置き場に `conversations.json`（`{ <id>: { backend: "fake", nativeId: null, segments, info, base } }`）・`conversations/<id>.json`（`{ messages: [NormalizedMessage…] }`）・`sessions.json`（`backend: "fake"`・`title`・`cwd` と、要るなら `compactions`・`taskNotices`・`interrupted`）を書いてから起動する。fake の会話は起動ごとに消えるが、保存分は残る。2026-09-28 に使った種は `temporary/scripts/sysmsg-ui/seed.mjs`。ページを読み直すと最初の案内がまた開くので、そのたびに「あとで」を押す。
      - 種の会話に `slow`・`ask` などの台本を送っても、最初のターンは履歴の引き継ぎ文が頭に付くので台本の語で始まらず、ただの返答で終わる。先に 1 ターン（`ok` など）流してから送る（2026-09-29）。
      - Visualize の表示を種で出すなら、返答の本文に単独の行で `visualize{"path":…,"title":…}` を書き、`presents/<id>.jsonl` に `{ kind: "visualization", reference: <その行>, content: <HTML>, caption, path, id, at, by: "ai" }` の 1 行を置く（`core/history.mjs` の recordPresent と同じ形）。画面は `reference` が本文の行と一致する発言の後ろに描く。2026-09-29 の README の撮影で使った種は `temporary/scripts/readme-screenshot/`。
    - コンテキストの画面（指示・Skills・MCP の一覧）は、データ置き場を分けても**本物のホーム**（`~/.claude`・`~/.codex`・`~/.claude.json`）を探す。偽のホームで見るなら `USERPROFILE`・`HOME`・`CODEX_HOME`・`CLAUDE_CONFIG_DIR` も偽の置き場に向ける。`AGENT_HOST_TOKEN=<任意の文字列>` を付けると、起動ログを拾わなくても URL が決まる。2026-09-27 に使った種・起動・撮影のスクリプトは `temporary/scripts/context-ui/`。
    - 設定のページは中の欄がスクロールするので、`screenshot --full-page` では下が切れる。`resize 1280 1900` のように窓を縦に伸ばしてから撮る。
  - 委譲のカード・バックグラウンドの行（自動の振り分け）を fake で出すには、偽の agy を委譲先にする: `AGENT_HOST_BACKENDS=fake,antigravity AGENT_HOST_AGY_BIN="node <repo>/tests/lib/fake-agy.mjs" FAKE_AGY_EXTRA_MODELS=gemini-3.8-flash-high,claude-opus-4-6-thinking AGENT_HOST_ROUTING_USAGE=on`（agy の Claude and GPT の枠は 100% なので `claude-opus-4-6-thinking` は「使用量が多い」で飛ぶ。claude / codex の候補は「使えない」で飛ぶ）。fake の会話に `ply:{"name":"ply_delegate","arguments":{"kind":"implement","task":"…"}}` と送ると ply_delegate を呼ぶ。判定器の送り先は `AGENT_HOST_OPENROUTER_API` で手元の偽物に向ける（偽の Jev の書き方は tests/unit/server-delegation-routing.mjs）。子は agy の yolo なので、依頼元の承認カードが 1 回出る。2026-09-26 に使った起動・種・撮影のスクリプトは `temporary/scripts/routing-ui/`。
    - 走ったままの子（詳細に実行中のツール・本文を出す）が要るなら、`backend` を指定して fake の子に `bg-shell <本文>`（本文とツールを出して待つ。報告後の待機上限 `AGENT_HOST_DELEGATION_BACKGROUND_WAIT_MS`、既定 10 分で止まる）か `active-shell`（ツールだけで待ち、自動では止まらない）を委譲する。fake-agy はツールを出したままターンを保てない（`slow` は本文だけを出して止まる）。2026-09-29 に使った駆動スクリプトは `temporary/scripts/task-detail-live/drive.mjs`。
    - 作業ダイアログの一覧の行（`#workDialog .bg-row`）や脇の会話の行（`.row[data-session]`）は、`playwright-cli` の `click <ref>` や `click "text=…"` では選ばれないことがある（2026-09-29）。`eval` の中で `[...document.querySelectorAll('#workDialog .bg-row')].find(b => b.textContent.includes('…')).click()` のように取って押す。
  - ホストの画面ではない端末（リモート）の画面を実機で見るなら、fake のデスクトップ版を一時の userData・データ置き場・`AGENT_HOST_TOKEN` で起動し、`X-Forwarded-For` を足す小さなプロキシ越しに携帯の大きさの Chromium（Playwright）で開く。サーバーはこれをリモートの接続とみなす（`hostCapabilities` の `osActions: false`）。2026-09-28 に「PC のブラウザーで見る」で使った起動・プロキシ・操作のスクリプトは `temporary/scripts/remote-browser/`（`harness.cjs`・`phone.mjs`。`out/quit` を置くと終わる）。
    - 指定ポートが埋まっていると空きポートへ移る（起動ログに `port 7499 は使えない (EADDRINUSE)`）。止めるときは起動したプロセスの PID か、起動ログの実際のポートで引いた PID を使う。**指定したポート番号で PID を引いて止めない**（そのポートを持っていた別の作業のサーバーを殺す。実際に起きた）。
  - ツールの続き方（まとまり・入れ替わり・失敗・承認待ち）を画面で見るなら、fake の会話に `steps:@<JSON ファイルの絶対パス>`（か `steps:<JSON>`）を送る。`{"steps":[{"tool":"Grep","input":{…},"result":"…","error":false,"ms":600,"ask":false},{"text":"…"}]}` の順に tool.start / tool.result（ask は承認待ち）と本文を流す（core/backends/fake.mjs）。JSON を直接送ると、会話の吹き出しが長くなって撮りにくい。新しいセッションで送る（種の会話は fake の履歴ではないので、送ると引き継ぎの文が返る）。実ブラウザーの確認は tests/browser/tool-bundle.cjs（2026-09-29）。
  - エージェントに実際に渡った `ply_agents` の instructions（Pleiad が入れる委譲の指示を含む）は、fake の会話に `instructions` と送ると返答にそのまま出る。子の会話の分は `ply:{"name":"ply_delegate","arguments":{"kind":"mechanical","backend":"fake","task":"instructions"}}` で委譲すると完了通知に出る。Codex の developerInstructions は身代わり（`tests/lib/fake-codex.mjs`）の `FAKE_CODEX_LOG` の `turn/start` 行で見る。理由: 本物の LLM を呼ばずに、会話ごとに違う指示が届いたかを文面で確かめられる（2026-09-26）。
  - fake は初回「未ログイン」で最初の案内が開き、作業ディレクトリも空のため、そのまま送った会話は「未送信」に残り、送信済みが前提の操作（タイトル生成など）が押せない。案内の「ログイン」→「あとで」→ 入力欄で作業ディレクトリを指定してから送る。
  - fake の応答は即座に返り、処理中の表示が一瞬で消える。見るときはページ上で `WebSocket.prototype.send` を包み、対象コマンド（例: `suggestTitle`）の送信を数秒遅らせる。
  - 分岐のような rAF で動かすアニメーションを数十 ms 刻みで撮って比べるときは、ページを遅くする。Playwright のスクリーンショットは 1 枚に約 80ms かかり、等速では 780ms の動きが 10 枚ほどしか撮れない。`addInitScript` で `performance.now`・`requestAnimationFrame`（コールバックに遅くした時刻を渡す）・`setTimeout` を K 倍遅くし、CSS の遷移と WAAPI は CDP の `Animation.setPlaybackRate`（1/K）で遅くする。毎フレームの数値（ノードの `left`・`--reveal`・`stroke-dashoffset` など）も記録し、各段の始まり（`data-phase` が変わった時刻）からの時間で並べると、2 つの実装の差が px で出る。2026-09-29 に K=8 で、LP の分岐の模型とアプリを比べた（`temporary/scripts/lp-branch/` の `slow.js`・`probe.js`・`app-capture.mjs`・`compare.mjs`）。
  - 画面の重さ（会話を開く時間など）を実データで測るときは、`~/.agent-host` を `temporary/` の下へ写す。写しから `remote/` と `agent-tasks.json` を消し、`AGENT_HOST_DATA=<写し> AGENT_HOST_PORT=7499 node core/server.mjs` で立てる。理由: リモートを有効にしたデータ置き場の写しで立てると、同じホストの鍵で中継へつなぎ、本物のホストの接続を追い出す（起動ログに「同じホストの別の接続に置き換わりました」。2026-09-29 に確認。fake の種の置き場でも、一度 `setRemoteSettings` した後に写すと同じ）。委譲の続きも走らせないため。写しには秘密の写しも入るので、測り終えたら消す。時間は Playwright の CDP で測る。`Emulation.setCPUThrottlingRate`（4 倍でスマホの目安）をかけ、`Profiler.start` / `stop` で取ったサンプルを関数ごとに self・inclusive で集計すると、原因の関数まで出る。2026-09-26 はこれで、描画のたびに `layoutBranchSpine` が強制レイアウトを起こしているのを突き止めた。スクリプトは `temporary/scripts/session-open-*.mjs`。
    - スクロールの重さは、開いて落ち着かせた長い会話の `#log` へ 900px のホイールを 40ms 間隔で送り、CDP の `Performance.getMetrics` の `LayoutCount`・`LayoutDuration` とフレーム間隔の p95 で比べる（`temporary/scripts/scroll-jank-measure.mjs`）。開く時間を縮める変更はスクロールを重くすることがあるので、両方を測る。2026-09-27 は、開く時間のために入れた `content-visibility:auto` の仮の高さ（160px）と実寸の差で、スクロール中にレイアウトが繰り返されていた。
    - 補正の効いたスクロールで「見ている行が飛んだか」を測るとき、行の位置の変化とスクロールの量を足して 0 になるかで見ると、確定の補正（`scrollTop` への書き込み）が飛びに見える。`Element.prototype.scrollTop` の setter を包んで書き込みの合計を控え、`(top の変化) + (scrollTop の変化 − 書き込みの合計)` が 0 かで見る（2026-09-29、`temporary/ms3/verify-scroll.mjs`）。
    - `content-visibility:auto` の行が自分で実寸に描き直される範囲を測るなら、行の中身を仮の高さと同じ高さにして `contentvisibilityautostatechange`（`e.skipped`）を数え、そのときの位置で距離を出す。Chromium（headless shell 1234）で見える範囲の上下、窓の高さの 1.3〜1.5 倍だった。`checkVisibility({contentVisibilityAuto:true})` は遠い行でも true を返し当てにならない。また `content-visibility:auto` の行が多いと、強制レイアウト（`.height-ready` の付け外し）1 回ごとに未確定の行の数に比例した style 再計算が走る（2000 行・CPU 4 倍で 1 行の確定でも約 77ms）ので、確定は 1 回のレイアウトにまとめる（`web/history-heights.mjs`）。
    - 会話の位置の測定は、狭い窓（1280 幅など）に加えて `#log` が約 1,736px を超える広い窓（2560 幅）でも行う。会話の列は `max-width:860px` で左に寄るので、`#log` の中央の点で当てる処理は広い窓でだけ列の外に落ちる。2026-09-28 は、これで広い窓の利用者だけが、長い会話を開くと末尾から上へずれていた（1280 幅では再現しなかった）。
    - スマホの重さは、PC の CPU 等倍ではほとんど見えない（2000 発言でも開くのに 3.6 秒）。390×844・`isMobile` の Chromium で CPU を 4〜6 倍に絞り、中継の経路（遅延と帯域を入れたプロキシ越しの `relay/server.mjs` と端末プロキシ）も通して測る。2026-09-29 に使った種・段階ごとの測定・中継の組み立ては `temporary/scripts/mobile-perf/`（`seed.mjs`・`measure.mjs`・`chain.mjs`）、結果は `temporary/reports/mobile-long-session-perf.md`。遅延を入れるプロキシは、塊ごとに `setTimeout` すると Windows のタイマーの丸めで順序が入れ替わり、Noise の復号に失敗して線が切れる。届いた順の列にして先頭から書く。
  - 動いている Pleiad の `~/.agent-host` のファイルを、PowerShell の `Get-Content` で開かない。Node の `fs.readFileSync` で読むか、写してから読む。理由: `Get-Content` が開いている間は Pleiad の保存（一時ファイルからの rename）が EPERM で失敗する。2026-09-27 には、調査中の子が `agent-tasks.json` を読んだのをきっかけに、委譲の管理が閉じて全部の会話で委譲が止まった。Node は削除を共有する形で開くので、保存とぶつからない。
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
- インストール版の Pleiad から起動されたエージェントのシェルには、Pleiad 自身の `AGENT_HOST_PORT`（例: 56454）と `AGENT_HOST_BIND` が引き継がれている（2026-09-22 確認）。そのまま `npm start` すると EADDRINUSE で空きポートへ移り、データ置き場も既定の `~/.agent-host` になって、実データを使う 2 台目が立つ。ポートの持ち主が `Ply.exe` ならリポジトリのサーバーではないので止めない。main から動かして確かめるなら、別ポート・別のデータ置き場で起動する（fake バックエンドの手順と同じ）。`web/` はリクエストごとにディスクから読むため、リポジトリのサーバーなら画面だけの変更に再起動は要らない。インストール版には更新まで反映されない。
- 同じく `ELECTRON_RUN_AS_NODE=1` も引き継がれている（2026-09-27 確認）。そのまま `electron.exe` を起動すると Node として動き、`require('electron').app` が undefined で落ちる。デスクトップ版を起こすときは `env -u ELECTRON_RUN_AS_NODE <repo>/node_modules/electron/dist/electron.exe <入口>` で外す。実機で確かめる入口は、`app.setPath('userData', <一時ディレクトリ>)`・`AGENT_HOST_DATA`・`AGENT_HOST_BACKENDS=fake` を決め、`shell.openExternal` を記録だけに差し替えてから `desktop/main.cjs` を require する小さな `.cjs` にすると、本物のデータとインストール版に触れず、窓は `executeJavaScript` で操作できる（2026-09-27 に内蔵ブラウザーで使ったものは `temporary/scripts/inapp-browser/harness.cjs`）。
  - キーの近道は OS のキー入力ではなく `webContents.sendInputEvent({ type: 'keyDown', keyCode: 'B', modifiers: ['control', 'shift'] })` で確かめる。内蔵ブラウザーのページの webContents に送っても main の `before-input-event` が発火するので、ページにフォーカスがあるときの近道も試せる（2026-09-30）。エージェントが操作中の表示は画面へ `ply:browser-state`（`agent` 付き）を送れば出るが、右パネルが閉じていると自動で開き、そのときの `context` の返り値（本物の状態。agent なし）で上書きされる。先にパネルを開いてから送る。使ったハーネスは `temporary/scripts/header-impl/harness.cjs`。
- 確認用スクリプトの終わりは `app.quit()` を使い、起動したプロセスは必ず上限時間付きで待つ（`Start-Process -Wait` を上限なしで使わない）。`app.exit()` はサーバー終了時の同期通知で止まったことがあり、無期限の待機は調査自体を止めるため。
- **再起動すると実行中のターンが終了する。** 停止前に UI の実行中表示または WebSocket の `running` コマンドで実行中の作業が 0 件であることを確認する。実行中なら完了を待つ。確認できない場合や中断が必要な場合は、理由を伝えてユーザーに確認する。
- 再起動時は確認済みの対象サーバーだけを停止する。他の Node.js プロセスを一括停止しない。Windows でバックグラウンド起動する場合は `Start-Process -WindowStyle Hidden` を使う。

## 完了と後片付け

- main への反映とサーバーの動作確認後、今回作成した worktree に未コミット変更がなく、ブランチが main にマージ済みであることを確認する。
- 今回の worktree を `git worktree remove <確認済みの絶対パス>` で削除し、作業ブランチを `git branch -d <ブランチ名>` で削除する。強制削除は使わない。
- 完了報告には変更内容、検証結果、コミット、main への反映状況、サーバーの状態を簡潔に記載する。未完了の手順がある場合は理由を明示する。
