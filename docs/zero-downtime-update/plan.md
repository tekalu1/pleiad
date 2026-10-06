# 無停止の更新 — 段階に分けた実装計画

- 状態: 確定（2026-10-06）。段階 0 は完了し、その実測で段階 1 以降を直した。**段階 1 は実装・検証済み**（2026-10-06。パッケージ版の既定は on。署名した版・スマホ・利用者の操作が要る確認だけが残り、手順は [stage1-7.md](stage1-7.md) の「利用者に頼む確認」）
- 設計: [design.md](design.md)。決定: [ADR 0151](../adr/0151-zero-downtime-update.md)。実測の記録: [stage0-claude.md](stage0-claude.md)・[stage0-codex-agy.md](stage0-codex-agy.md)・[stage0-runtime.md](stage0-runtime.md)・[stage1-0.md](stage1-0.md)（段階 1 の 1-0）・[stage1-7.md](stage1-7.md)（段階 1 の 1-7。実機の確認）。管理: [issue #54](https://github.com/tekalu1/pleiad/issues/54)
- 規模の目安: S = 2 日まで、M = 3〜5 日、L = 1〜2 週、XL = 3 週以上（1 人。テストと文書を含む）。段階 0 の前の見積もりを、実測で分かったことに合わせて見直した（下の表）

## 全体

| 段階 | 中身 | 利用者に見える価値 | 規模（段階 0 の前 → 後） |
|---|---|---|---|
| 0 | 実測 | なし | M → **完了** |
| 1 | 実行場所を `$INSTDIR` の外へ。サーバーを main から切り離す。新しい main が古いサーバーに付け直す。サーバーの切り替えは作業が終わるまで先送り | **更新を押しても作業が止まらない**（core の切り替えは作業が終わってから。design.md §6.1） | L（2〜3 週）→ **L〜XL（4〜5 週）** → **実装・検証済み**（署名・スマホの確認を除く） |
| 2 | 保持役 + Claude。引き継ぎ。付け直し（再生） | **Claude の作業は core の切り替えでも止まらない**。サーバーが落ちても Claude の作業が続く | XL（4〜6 週）→ XL（4〜6 週。増減が相殺） |
| 3 | Codex・agy・`!` の行を保持役へ | 全部のバックエンドで止まらない。先送りが要らなくなる | L（2〜3 週）→ **M〜L（2 週前後）** |
| 4 | （測って要れば）待ち受けを保持役が持つ | 引き継ぎの 1 秒前後の間の MCP の呼び出しも落ちない | M（段階 2 の実機の数え方しだい） |
| 5 | （任意）Electron を再起動しない core だけの更新 | 内蔵ブラウザー・computer use も切れない。更新が数秒で終わる | L + 署名の設計 |

見直しの理由:

- **段階 1 が増えた**: 実行場所の組み立てを「ハードリンク + 同じ読みで 16 並列のハッシュと写し」にする（Defender の遅い最初の読みを避ける）、起動時に main の Job を調べて分岐する、サーバーが起こす `detached` でない子（引き継ぎで止まる）の洗い出し、起動の失敗の理由を出すサーバーのログ、main との口がバイナリー（computer use の画面の写真）を運ぶ符号化、main が居ない間の機能ごとの扱いと内蔵ブラウザーの中継の一覧、切り替えの待ちの表示（モックの承認が要る）。いずれも下書きの段階 1 に無かった
- **段階 2 は増減が相殺する**: 減った — `host` MCP を HTTP に移さない、保持役が JSON-RPC の id を付け替えない・`initialize` の答えを作らない。増えた — `detach` が済んでから SDK の `query` を閉じる順序、走っている hooks・`mcp_message` のハンドラーを待つ引き継ぎ、再生の uuid の冪等、未測定の Claude の場面（サブエージェント・裏のコマンド・途中送信・圧縮）の測定
- **段階 3 が減った**: Codex は付け直しに握手が要らず（`initialize` を送らない）、id の付け替えも要らない。agy も握手が要らない

**最初に価値が出るのは段階 1**。段階 1 だけで「更新を押しても作業が止まらない」は成り立つ（core の切り替えが作業の終わりまで先送りになるだけ。ADR 0151 で、ADR 0036 の「終わったら更新する」予約とは別のものとして承認済み）。ただし、委譲・bot・ルーティンで作業が絶えない使い方では新しい core がなかなか当たらないので、段階 1 は目的ではなく踏み台で、段階 2・3 までで目的に届く。段階 1 の先送りは、段階 3 の後も戻し道として残る。

---

## 段階 0: 実測（完了）

結果の全部と手順は stage0-*.md。通る条件は全部満たし、駄目だった項目は無い。覆った推測と直した設計は design.md §11。

| # | 確かめたこと | 結果 | 記録 |
|---|---|---|---|
| 0-1 | Claude: 承認待ちの最中に付け直すと承認が新しい `canUseTool` に回り、ターンが続くか | **通る**（元と同じ `requestId`。親が居ない 300 秒でも） | stage0-claude §1 |
| 0-2 | Claude: hooks と in-process MCP が付け直しで効くか | **効く**。ただし呼び出しの最中に付け直すと、hooks はそのツール呼び出しが 1 回失敗（モデルがやり直す）、`mcp_message` は渡し直しが必須で二重に走りうる | stage0-claude §3 |
| 0-3 | Claude: 親が居ない間・stdout が読まれない間 | CLI は生きる。**読まないと 60〜240 KB で止まる**ので、保持役は常に読む | stage0-claude §5 |
| 0-4 | `$INSTDIR` の外の detached のプロセスが NSIS の入れ替えをまたいで生き残るか | **生き残る**（`detached` + `stdio: 'ignore'`。`utilityProcess` の中から起こしても）。`$INSTDIR` の中・前方一致の兄弟は止められる。`detached` でない子は親と一緒に死ぬ | stage0-runtime §1 |
| 0-5 | HTTP の MCP が数秒つながらないときの 3 つの CLI | **外されない**。Claude と agy は即失敗、Codex は約 2 秒まで透過に再試行。不通中に始めた Codex のスレッドは MCP を持たない | stage0-claude §4・stage0-codex-agy §4 |
| 0-6 | 実データでのサーバーの起動 | `ready` まで **1.2〜1.3 秒**・一覧まで約 1.6 秒（3 秒以内を満たす）。新しく写した直後は 3.5〜6.1 秒 | stage0-runtime §2 |
| 0-7 | koffi・node-pty と `npm test` が公式の Node で通るか | koffi は 24.14.0 で読めた。**node-pty・`npm test` も公式の Node 24.21.0 で通った**（段階 1 の 1-0 a。302 本・11,588 判定が全て通過） | stage0-runtime §3・stage1-0 §1 |
| 0-8 | Codex の `initialize` 2 回・`--listen` | **握手が要らない**。`--listen` は切れ目の通知が欠けるので採らない | stage0-codex-agy §1・§2 |
| 0-9 | `agent-browser` の常駐側が CDP 中継の切断から戻るか | **戻る**（段階 1 の 1-0 c。同じポート・鍵で立て直すと、同じ常駐のまま次の呼び出しが通る。別のポート・鍵でも設定ファイルを書き直せば通る） | stage1-0 §3 |

追加で測れたこと: agy は握手が要らず、相手が数秒いなくても続く（stage0-codex-agy §3）。実行場所への写しは約 107 MB・4,017 ファイル、ハードリンクで 2 版目は +0.7〜3.5 MB（stage0-runtime §3）。データ置き場のロックの引き継ぎは最大 18.6 ms（stage0-runtime §2.5）。

---

## 段階 1: 実行場所と、main から切り離したサーバー（L〜XL）

目的: 更新（NSIS による main の入れ替え）で、走っているターンを止めない。サーバーの切り替えは、新しい版が揃った後、作業が 0 件になったときに行う。保持役は持たない（段階 2）。

### 進め方

- **途中の merge は機能を有効にしない**。環境変数 `AGENT_HOST_HANDOVER` で切り替える（`on` = 実行場所 + 名前付きパイプ + 先送り、`off` = 今の `utilityProcess`）。段階 1 の途中は既定を `off` にし、1-7 の最後の項目で、パッケージ版の既定を `on` にした（**済み 2026-10-06**。env が無ければ on。開発の `electron .` は off のまま）。`off` の経路（今の形）は、開発（`npm run desktop`）と、合わない更新の戻し道（design.md §6）として残り、テストを流し続ける（R7）
- 順序（矢印は依存。`‖` は並行できる）: **1-0 → 1-1 → (1-2 ‖ 1-3) → 1-4 → (1-5 ‖ 1-6) → 1-7**
- 1-1 は挙動を変えないので、単独で main に入れてよい。1-2 以降は `AGENT_HOST_HANDOVER=on` のときだけ動く

| 項目 | 中身 | 規模 |
|---|---|---|
| 1-0 | 頭の確認（下） | S |
| 1-1 | `process.parentPort` を「main への口」に寄せる（挙動を変えない） | S |
| 1-2 | 名前付きパイプの口（core 側・main 側・符号化・握手） | M |
| 1-3 | 実行場所（組み立て・同梱の Node・manifest・掃除・起動口） | M |
| 1-4 | main がサーバーを起こす・見つける・付け直す | M |
| 1-5 | main が居ない間の機能ごとの扱い | M〜L |
| 1-6 | 更新の流れ・切り替えの先送り・画面の読み直し | M |
| 1-7 | テスト・文書・実機・既定を `on` に | M |

### 1-0 頭の確認（S。**完了 2026-10-06**。記録は [stage1-0.md](stage1-0.md)）

実装の前に、設計が前提にしていて測っていないことを確かめる。どれかが駄目なら、その項目の「駄目なとき」で設計を差し替えてから 1-1 に入る。**全部通り、「駄目なとき」の差し替えは要らなかった**（下の結果。段階 1 の項目に反映済み）。

| # | 確かめること | 方法 | 駄目なとき |
|---|---|---|---|
| a | node-pty が、同梱する公式の Node（Electron の Node と同じメジャー版 24）で読める。`npm test` がその Node で通る | その Node で `node tests/run.mjs`。`claude-login` の疑似端末の試験を含める（win32-x64 と win32-arm64 の prebuild） | node-pty を使う機能（Claude のログイン）だけ main の側に寄せる、または Electron の一式を写す（ディスクは重くなる） |
| b | インストール版と同じ形の `Ply.exe` の Job の制限 | `npm run desktop:pack` の `win-unpacked\Ply.exe` を explorer 経由で起こして、`scripts/zero-downtime/runtime/job-info.cjs` で調べる（インストール版の Pleiad には触れない） | 抜け道が無い環境では今の「中断して更新」に落とす（design.md §3.2 の分岐。コードは 1-4） |
| c | `agent-browser` の常駐側が、CDP 中継の切断から、同じポートと鍵で張り直したときに戻るか | 内蔵ブラウザーの中継（`desktop/browser-relay.cjs`）を止めて同じポート・鍵で立て直し、本物の `agent-browser` で次の呼び出しが通るかを見る（`docs/dev-verification.md`「デスクトップ版（Electron）」の手順） | 中継の待ち受けをサーバーに移し、main とはパイプで CDP を中継する（1-5 が大きくなる） |
| d | 本物のインストーラー（署名なしの評価版）で、`quitAndInstall` から新しい版の窓が出るまでの時間と内訳 | `docs/desktop-releases.md`「自己署名での評価」の評価版。展開・旧版の削除・Defender・起動を分けて記録する | 分からなくても進める。main が居ない間の長さの根拠になる（design.md §7.2） |
| e | `customCheckAppRunning` を定義した場合の NSIS の振る舞い | `scripts/zero-downtime/runtime/build-stub.mjs` の試験用アプリに足して、`nsis-survival.mjs` で止まるものを見る | 定義しない（既定のままで `$INSTDIR` の外・名前違いは止められないことは実測済み）。その代わり、リリースの確認に「更新で実行場所のプロセスが止まらない」を足す |
| f | サーバーが起こす子の洗い出しと分類 | `core/` の `spawn`・`execFile`・`pty.spawn`・SDK の CLI の起動を一覧し、「サーバーと一緒に止めてよい（短い・`!` の行・hooks の子・ログインの疑似端末）／引き継ぎをまたいで残す（会話のシェルから起きた `agent-browser` の常駐など）」に分ける（`detached` でない子はサーバーが終わると止まる。design.md §3.2） | 残したいものは `detached: true` で起こすか、新しいサーバーが起こし直す |

結果（[stage1-0.md](stage1-0.md)。印は stage0-*.md と同じ）:

- **a 通る**【実測】。公式の Node 24.21.0（x64）で、配布物と同じ prebuilds だけの node-pty が読め、疑似端末（claude-login の経路）も動く。`npm test` は 302 本・11,588 判定が全て通過（431.6 秒、`--jobs 2`）。arm64 は形（N-API・arm64）の確認だけで、動かしていない【未確認】
- **b** 本物の `Ply.exe`（`desktop:pack`）を explorer 経由で起こすと、`BREAKAWAY_OK` だけの Job（`KILL_ON_JOB_CLOSE` なし）に入る【実測】。更新後に NSIS が起こす形も同じ【実測】。インストール版の `Ply.exe` は Job に入っているが、制限の中身は読めていない（同じ起動経路なので同じとみなす【推測】）。1-4 は「Node の detached 起動」が実環境の当たり
- **c 戻る**【実測】。同じポート・同じ鍵で中継を立て直すと、同じ常駐のまま次の呼び出しが通る（約 30 ms）。別のポート・鍵でも、設定ファイルの `cdp` を書き直せば通る。居ない間は約 2 秒で失敗し、戻れば続く。タブが無いと空のタブを見る（開き直しが先）
- **d** 本物の配布物の形（4,094 ファイル・491.6 MB・圧縮は既定）で、`quitAndInstall` → 新しい main が動くまで **49〜53 秒**（3 回）。内訳: 確かめ（PowerShell）約 8・旧版の削除 約 8〜11・空き 約 10〜12（推測）・展開 18〜21・起動 1.5〜3。書いた直後の読みは約 7 秒（Defender）
- **e** `customCheckAppRunning` を定義すると更新は通り、約 7〜11 秒短くなる【実測】が、何もしない版は普通のアンインストールが壊れ、配布済みの版の旧アンインストーラーは既定のまま（最初の更新で効かない）。**定義しない**
- **f** サーバーの子を一覧にした（stage1-0 §6）。**`detached: true` に直すものは無い**。新しく分かったこと: 外部の stdio MCP はサーバーの直の子（段階 2 の課題 → R15）・agy の relay は今 `$INSTDIR` の `Ply.exe` で走っている・切り替えの「0 件」に `!` の行と Codex の裏の端末は数えられない（1-6）・`agent-browser` の常駐は生き残る

### 1-1 「main への口」に寄せる（S。単独で merge できる。実装済み）

`process.parentPort` を直に触っている所を、`mainPort`（`on('message', ({ data }) => …)` と `postMessage` を持つ、parentPort と同じ形の口）1 つに寄せる。`utilityProcess` の経路では `process.parentPort` をそのまま入れるので、挙動は変わらない。

- 新規 `core/main-port.mjs`: `createMainPort({ parentPort })`。つながっているか（`connected`）・切れた・戻ったを知らせる口（1-2・1-5 で使う）。今は常に「つながっている」。実装は、起動の形（main の下か）を表す `hosted`（切れても変わらない。`process.parentPort` の有無の置き換え）と、今届くかの `connected` を分け、`postMessage` は送れたかを返す（居ない・切れているときは何もせず `false`）。`getMainPort()` が `process.parentPort` を包んだ口を返す。1-2 は、パイプの口（`connected` と `connect`・`disconnect` を足した同じ形）を `createMainPort({ parentPort })` に渡す
- 触るファイル: `core/server.mjs`（`parentPortBrowser`・`parentPortScreencast` の引数、`openExternal`、`withResident`・`postResident`、`locale` の送信、computer の driver、`parentPort.on('message')` の受け口、`announce` の `ready`、`kind: process.parentPort ? 'desktop' : 'server'`）・`core/secret-store.mjs`（`defaultCipher`）・`core/os-open.mjs`（`defaultOpener`）。`core/agent-browser.mjs`・`core/browser-screencast.mjs`・`core/computer-use/driver.mjs` は `port` を受け取る作りなので変えない
- 画面・WS・CLI の挙動は変えない。`desktop/` は変えない
- テスト: 既存の `tests/lib/parent-port-server.mjs`（`process.parentPort` の身代わりを置いて `core/server.mjs` を起こす入口）を使う試験・`tests/unit/desktop-*.mjs` が変えずに通ること。`mainPort` の単体（つながっていない口に送っても落ちない）を `tests/unit/main-port.mjs` に足す

### 1-2 名前付きパイプの口（M。`AGENT_HOST_HANDOVER=on` のときだけ動く。実装済み）

運ぶメッセージの型は今の parentPort のもの（design.md §7.1）。

実装したもの:

- `core/link-codec.mjs`（符号化と行の分け方。両側が使う）・`core/main-link.mjs`（サーバー側）・`desktop/server-link.cjs`（main 側。`core/link-codec.mjs` は動的 import）。`core/main-port.mjs` に `setMainPortSource`（パイプの口を `process.parentPort` の代わりに差し込む）。サーバーは `AGENT_HOST_HANDOVER=on` で、`utilityProcess` の下でない（`process.parentPort` が無い）ときだけパイプの口を作る。既定の起動は何も変わらない
- 秘密と名前は `main-link.json`（権限 0600。`{ version, pid, pipe, ipc, appVersion, secret }`。終了で自分の pid のものだけ消す）。`control.json` には `mainLink: { pipe, ipc }` だけを足す（`on` のときだけ）
- 握手の形（`hello` / `welcome` / `reject` / `msg` / `bye`）は `core/main-link.mjs` の頭の注記に固定した。秘密が合わなければ何も返さず切り、合ったうえで `ipc` の範囲が合わなければ `reject`（サーバーの範囲・版・pid つき）を返して切る。握手の前の行は 64 KB まで・5 秒で切る
- 口は常に 1 つ。後から握手に通った main が勝ち、古い方へ `bye('replaced')` を送って切る
- main 側の包みは、最初に `connect()` する前の `postMessage` だけ溜めて（1000 件）、つながった直後に順に送る（`utilityProcess.fork` の直後に main が送る使い方と同じにするため）。切れた後は溜めずに `false`
- つなぎ直しは同じ包みで `connect()` をもう一度呼ぶ（`message` の登録は残る。`once('exit')` は消えるので付け直す）。`kill()` は `shutdown` を送って閉じる
- 1-4 のために先に入れたもの（パイプでは main が後からつながるため、起動直後の送信が捨てられて動かなくなる）: サーバーは `connect` のたびに最新の `ready`・常駐の状態を送り直す。computer use の driver は `connect` のたびに `computer-ready-request` を送り直す。secret の暗号器（`parentPortCipher`）は、口がまだつながっていないとき、`connect` まで依頼を送らずに待つ（上限 5 分。応答の待ちは送ってから数える）

- core 側 `core/main-link.mjs`: パイプ（`\\.\pipe\pleiad-main-<データ置き場のハッシュ>`）を作って待ち受け、`hello { ipc: [min, max], appVersion, secret }` が合った接続だけを `mainPort` につなぐ。`secret` は起動時に作り、データ置き場の権限 0600 のファイル（`control.json` と同じ置き方。`core/atomic-file.mjs`）に書く。パイプの名前と `ipc` の範囲は `control.json` に足す（`CONTROL_VERSION` は上げず、足すだけ。読む側は無いキーを許す）
- **符号化**: 1 行 1 JSON。`Uint8Array` / `Buffer`（`computer-result` の画面の写真）は `{ "$bin": "<base64>" }` に包み、受ける側で戻す。1 行の大きさの上限（既定 16 MB）を決め、超えたら落とす。写真が増やす量（約 4/3 倍）で computer use の往復が許容の時間に収まることを確かめる
- main 側 `desktop/server-link.cjs`: パイプにつなぎ、`worker`（`on('message')`・`off`・`once('exit')`・`postMessage`・`kill`）と同じ形の包みを返す。**切断を `exit` として知らせる**（`computer/service.cjs` の `releaseAll`・`computer-overlay.cjs` の `hideAll` が `once('exit')` で後始末するため）。`desktop/*-bridge.cjs`・`computer/service.cjs`・`resident.cjs` は変えない（`worker.on('message')` と `worker.postMessage` だけを使う）
- 接続が切れたあいだ、サーバーから main へ送るものは、機能ごとの扱い（1-5）に任せる。口の層は溜めずに捨てる（送れなかったことを呼び出し側に返す）
- 握手の最小の部分（版を聞く・引き継ぎを頼む・終わらせる）は、版をまたいで形を変えない。ここで形を決めて固定する（`ipc` の版 1）
- テスト: `tests/unit/main-link.mjs`（符号化の往復・バイナリー・1 行の上限・行の途中で切れた入力・`secret` の不一致で何も返さず切る・`ipc` の範囲の外・切断と再接続）。本物のパイプで 2 つのプロセスを立てる

### 1-3 実行場所（M。**実装済み 2026-10-06**。下の「実装のメモ」）

design.md §3 のとおり。参考にする動くコード: `scripts/zero-downtime/runtime/runtime-copy.mjs`・`hardlink-start.mjs`（ハッシュ・store・リンク）。

- ビルド:
  - `scripts/pack-runtime.cjs`（`electron-builder.yml` の `afterPack` に `scripts/pack-agent-browser.cjs` と並べる）: 公式の Node を各アーキテクチャーごとに `resources\runtime\node.exe` として入れる。取得元と SHA-256 は `scripts/node-runtime.json`（版・アーキテクチャーごと）に固定し、ビルドで照合する。Node の版は Electron の Node と同じメジャー版（24。1-0 a は 24.21.0 で確かめた。SHA-256 は x64 `ba4e6d110e8c1592a1ecd390f6b05f3da124b13871a5be62b341a07a853c6c32`・arm64 `dff59da18b6ffe1bf1ca99e1d2af4906080c481740619f5b5098c0fca28bd9b7`。x64 の `node.exe` は 93.6 MB、圧縮でインストーラーは約 22 MB 増える）
  - `resources\app\manifest.json`（ファイルごとの SHA-256・大きさ）をビルド時に作る（同じ `afterPack`）
  - リリースの CI に、Node の取得と照合（キャッシュ）を足す（`docs/release-ci-reuse.md` を見る）
- main 側 `desktop/runtime.cjs`（新規。Node の組み込みだけ。非同期）:
  - `resolveRuntimeRoot()`: `%LOCALAPPDATA%\agent-host-runtime`。`$INSTDIR` の前方一致（大小文字を無視）に当たるか、`$INSTDIR` の下なら `%LOCALAPPDATA%\jp.ply.desktop\runtime` に移す。環境変数 `AGENT_HOST_RUNTIME_DIR` で差し替えられる（テスト・ハーネス用）
  - `install(version)`: `store\<sha256>` へ**ハッシュと写しを同じ読みで、16 並列**で置き、`app\<版>-<ビルドの短いハッシュ>` をハードリンクで組む。逐次にしない（design.md §3.3）。終わったら manifest と突き合わせ、合わなければ組んだ木を消して失敗を返す。Node は `node\<版>-<sha256 の先頭>\pleiad-node.exe` に 1 つ置く
  - 使用中の印（`run\<版>-<pid>.lock.db`。EXCLUSIVE で開いたまま）と、使っていない版の掃除（直前の版は残す。`bin` はさらに 1 版）。掃除は main の起動から少し後、裏で行う
  - 起動の順は「組む→突き合わせる→（事前の確かめ→）起こす」。新しく写した直後に起こさない（3.5〜6 秒かかる）
- 起動口: `bin/pleiad.cmd`・`bin/pleiad`（sh）が、実行場所の `pleiad-node.exe`（`..\..\..\node\*\pleiad-node.exe` など、実行場所の相対）を探し、無ければ今の `Ply.exe`、最後に PATH の `node`。`core/cli-launcher.mjs`（`mcpSetup`）・`core/backends/antigravity-context.mjs`（`agentDefinition`）・`core/backends/codex.mjs`・`core/backends/context-options.mjs` は `process.execPath` を使っているので、サーバーが `pleiad-node.exe` で走れば直る。`process.versions.electron` による `ELECTRON_RUN_AS_NODE` の付与は付かなくなる（確かめる）。サーバーの env から `ELECTRON_RUN_AS_NODE` を外す（`desktop/server.cjs` の分は `off` の経路だけに残す）
- 会話のシェルの PATH: `addCliToPath`・`agent-browser` の置き場を実行場所の `app\<版>\bin`・`agent-browser\<版>` にする（`desktop/agent-browser-bin.cjs`）
- `build/installer.nsh`: **`customCheckAppRunning` は定義しない**（1-0 の e。定義すると更新が約 7〜11 秒短くなるが、何もしない版は普通のアンインストールを壊し、配布済みの版の旧アンインストーラーは既定のままなので最初の更新では効かない）。`build/installer.nsh` は変えない。リリースの確認に「更新で実行場所のプロセスが止まらない」を足す
- **agy の relay**（`core/agy-context-relay.mjs`）は今 `$INSTDIR` の `Ply.exe` で走っている（1-0 f の観測）ので、更新（NSIS が `$INSTDIR` 配下を止める）で relay だけが死ぬ。サーバーが `pleiad-node.exe` で走れば、`process.execPath` を使う `agentDefinition` の relay も実行場所に移る
- **外の AI に貼る設定**（`cliSetup` → `mcpSetup` の `execPath`・`CLI_SCRIPT`）は、サーバーが実行場所で走ると版ごとのパス（`node\<版>-<sha>\pleiad-node.exe`・`app\<版>\bin\pleiad.mjs`）になり、古い版の掃除で壊れる。貼る設定が指すのは、版に依らない起動口にする（`$INSTDIR` の `Ply.exe` + `resources\app\bin\pleiad.mjs`、または実行場所の版に依らない起動口。1-0 f）
- ADR 0090（CLI は Ply の内蔵 Node で走らせる）の「内蔵 Node」が、実行場所の `pleiad-node.exe` に変わる。文書は 1-7 で直す
- テスト: `tests/unit/desktop-runtime.mjs`（一時のフォルダーで、組み立て・ハードリンク（`nlink`）・manifest の不一致・前方一致の判定と移動・使用中の版を消さない掃除・同じ版を 2 回組んでも壊れない・途中で止まった組み立ての後始末）。起動口の試験は `tests/unit/cli-launcher.mjs` に足す

**実装のメモ（2026-10-06。実装済み。1-4 以降が使うときの注意を含む）**

- **新しいファイルにまとめた**（1-2 の `core/main-link.mjs`・`desktop/server-link.cjs` と重ならない）: `desktop/runtime.cjs`（置き場の決め方・組み立て・掃除）・`desktop/runtime-manifest.cjs`（manifest。ビルドと main が共有）・`desktop/runtime-boot.cjs`（main の呼び出し口）・`core/runtime-use.mjs`（使用中の印）・`scripts/pack-runtime.cjs`・`scripts/after-pack.cjs`・`scripts/node-runtime.json`。既存のファイルは、`desktop/main.cjs`（`AGENT_HOST_HANDOVER=on` のときだけ呼ぶ 2 行）・`core/cli-launcher.mjs`（`stableCli`）・`bin/pleiad.cmd`・`bin/pleiad`・`electron-builder.yml`（`afterPack`）・`desktop/agent-browser-bin.cjs`（`runtimeDir`）の数行だけ
- **単独で merge しても挙動は変わらない**: 実行場所を組むのは `AGENT_HOST_HANDOVER=on` の main だけ（既定 off）。サーバーは今のまま `utilityProcess`。配布物には Node（約 93.6 MB）・`runtime.json`・`manifest.json` が増える
- **残す版は 3 つ**（今の版・直前の版・さらにもう 1 版）。plan の「`bin` だけをさらに 1 版」は変えた: `bin\pleiad.mjs` は `core\` と `node_modules` を読むので `bin` だけでは動かない。ハードリンクなので木ごと残しても増えるのは変わった分だけ（design.md §3.5 も直した）
- **組み立て**: 中身ごとに 1 回だけ読む（`store` に同じ SHA-256 の実体が在って大きさが合えば、元を読まない）。読んだときは manifest の SHA-256 と大きさを確かめてから store へ置く。木は `app\.<版>.staging` に作り、組み終えて manifest と突き合わせ（在る・大きさが合う）、印（`.runtime.json`）と `runtime-node.txt` を書いてから `app\<版>` へ rename する。2 回目以降は印と大きさの確かめだけで読み直さない（`verifyTree({ deep: true })` が SHA-256 まで読み直す）。ハードリンクは運命を共にする（変わっていないファイルは全部の版と store が同じ実体）ので、中身が書き換えられると全部の版が壊れる。使うときの確かめ（大きさ）で見つかった版は、store の実体も疑って元から読み直す
- **使用中の印**: 実行場所で走るプロセスが `core/runtime-use.mjs` の `markRuntimeInUse({ root, key })` を、起動時に呼ぶ。**サーバーの起動での呼び出しは 1-4 で足した**（main が env の `AGENT_HOST_RUNTIME_ROOT`・`AGENT_HOST_RUNTIME_KEY` で渡し、`core/server.mjs` が呼ぶ）。保持役は段階 2。印を持たないプロセス（`utilityProcess` のサーバー）が使う版は、今の版の他は 3 版を超えた分だけ消す。agy の relay・短い `pleiad` CLI は印を持たない（relay は親のサーバーと同じ版・同じ寿命。サーバーの印が覆う）
- **外の AI に貼る設定**: `mcpSetup` は env の `PLEIAD_CLI_EXEC`・`PLEIAD_CLI_SCRIPT`・`PLEIAD_CLI_ELECTRON` があればそれを指す（`stableCli`）。**1-4 で main がサーバーの env に `stableCliEnv()` を足した**（`$INSTDIR` の `Ply.exe` と `resources\app\bin\pleiad.mjs`。`desktop/server-boot.cjs` の `serverEnv`）
- **agy の relay**: サーバーが `pleiad-node.exe` で走れば `process.execPath` が実行場所の Node になり、`electron` が偽なので `ELECTRON_RUN_AS_NODE` は付かない（`tests/unit/cli-launcher.mjs`）。**1-4 でサーバーの env から `ELECTRON_RUN_AS_NODE` を外した**（`desktop/server.cjs` の分は `off` の経路だけ）
- **1-4 が使うもの**: `resolveRuntimeRoot` → `install`（戻り値 `nodeExe`・`appDir`・`agentBrowserDir`・`key`）→ `nodeExe appDir\core\server.mjs` を `detached` で起こす。PATH には `agentBrowserDir`（`prepareAgentBrowserBin({ runtimeDir })`）と `appDir\bin` を足す。組んだ直後に起こさない順序は `install` が済んでから起こせば守られる（`install` は読み終えてから戻る）
- **1-7 の結果**: NSIS のインストーラーをまたいだ実行場所の生き残りは実機で確かめた（[stage1-7.md](stage1-7.md)）。**この確かめで、配布物の manifest がインストール後の木と合わない不具合が見つかり、直した**: NSIS は x64 の配布物の中の別 CPU の `.exe`・`.dll`（node-pty の `win32-arm64` の conpty・winpty）を黙って落とすので、実行場所を組めず `utilityProcess` に落ちていた（`desktop:pack` の `win-unpacked` では見えない）。afterPack が動かさない OS・CPU の prebuild を manifest の前に外す（`pruneOtherPrebuilds`）。**残り**: リリースの CI への Node のキャッシュ（`PLEIAD_NODE_CACHE` を `actions/cache` に載せる。取得と照合はビルドが毎回行う）・arm64 の実機（利用者に頼む確認 U10・U8）

### 1-4 main がサーバーを起こす・見つける・付け直す（M。**実装済み 2026-10-06**。下の「実装のメモ」）

- `desktop/main.cjs` の `boot()`: `AGENT_HOST_HANDOVER=on`（かつパッケージ版）のとき
  1. main の Job の制限を調べる（`desktop/job.cjs` 新規。koffi の `IsProcessInJob`・`QueryInformationJobObject`。動く例: `scripts/zero-downtime/runtime/job-info.cjs`）。`KILL_ON_JOB_CLOSE` があり抜け道が無ければ `off` の経路に落とす（その旨を `updater.log` に残す）。explorer 経由の起動・NSIS が更新後に起こす起動は `BREAKAWAY_OK` だけの Job で、`KILL_ON_JOB_CLOSE` が無いので、Node の detached 起動で通る（1-0 b。koffi の Job 調べはパッケージ版の main で動く）
  2. 走っているサーバーを探す: データ置き場の `control.json`（pid・origin・cliToken・appVersion・パイプの名前）→ パイプにつないで `hello`。つながって `ipc` の範囲が合えば付け直す。つながらなければ「古い制御ファイル」として扱い、新しく起こす
  3. 無ければ、実行場所へ組んで（1-3）、`pleiad-node.exe` で `core/server.mjs` を **`detached: true` + `stdio: 'ignore'` + `windowsHide: true`** で起こす。Job が `BREAKAWAY_OK` だけなら、koffi の `CreateProcessW` に `CREATE_BREAKAWAY_FROM_JOB` を付けて起こす（`scripts/zero-downtime/runtime/job-breakaway.mjs`）。`AGENT_HOST_TOKEN`・`AGENT_HOST_PORT`（保存したポート）・`AGENT_HOST_SYSTEM_LOCALE`・`PATH`（agent-browser）を env で渡す。cwd はホーム
  4. `ready` を待つ（60 秒）。待ちの途中でサーバーが終わったら、`logs\server.log` の末尾（トークンは伏せる）を読んで今のエラーに出す
- `worker` を、1-2 の包み（パイプ）か `utilityProcess` のどちらかにする。`main.cjs` の `worker.stdout`・`worker.stderr` を読んでいる所は、パイプの経路ではログのファイルに替える。`worker.kill()` は「終わらせる」の握手になる
- サーバー側（`core/server.mjs`・新規 `core/server-log.mjs`）: `AGENT_HOST_HANDOVER=on` の経路では、標準出力・標準エラーを `logs\server.log` に書く（トークンの URL の行は伏せる。1 MB で `.old` を 1 世代）。接続のたびに最新の `ready` を送る（`announce` の `ready` を、新しい接続にも送る）。`kind` は `'desktop'` のまま
- **孤児にしない**: main の切断を `main-leaving` を伴わず見たとき（main が落ちた）、作業が 0 件で 3 分たったら終わる。`main-leaving { reason: 'update' }` から来ないときは 30 分（作業が 0 件のとき）。作業が続いている間は終わらない。次に Pleiad を起動した main が付け直す
- 終了: `closeSafely` の「中断して終了」は今のまま（全部を `quit` で中断し、`shutdown` を送ってサーバーを終わらせる）。`window.on('session-end')`・`before-quit` も同じ
- `desktop/server.cjs`: `off` の経路だけで使う（`ELECTRON_RUN_AS_NODE=1` を付ける）。`on` の経路は `core/server.mjs` を直に起こす
- テスト: `tests/unit/desktop-boot.mjs`（vm で `main.cjs` を評価する既存の作り。`desktop-exit-dialog.mjs` と同じ）に、サーバーの選び方（無い・生きている・古い制御ファイル・`ipc` の範囲の外）と Job の分岐の純関数のテストを足す。選び方と Job の判定は `desktop/` の純関数に切り出す。実際は `tests/unit/desktop-job.mjs`（Job の分岐・本物の `CreateProcessW`）・`tests/unit/desktop-server-boot.mjs`（見つける・起こす・env・ログ・見張り・別プロセスの本物のサーバー）・`tests/unit/desktop-boot.mjs`（`main.cjs` の選び方）に分けた

**実装のメモ（2026-10-06。実装済み。1-5・1-6 が使うときの注意を含む）**

- **新しいファイル**: `desktop/job.cjs`（Job の制限の調べ方・分岐・`CREATE_BREAKAWAY_FROM_JOB` 付きの起動。koffi は呼び出し側から受ける）・`desktop/server-boot.cjs`（見つける・起こす・付け直す・env・起動の失敗の文）・`core/server-log.mjs`／`core/server-log-boot.mjs`（ログのファイル。`server.mjs` の最初の import）・`core/orphan-guard.mjs`（孤児の見張り）。既存は `desktop/main.cjs`（`chooseLinkedServer`・`onServerExit`）・`core/server.mjs`（見張りと使用中の印の配線）・`web/locales/{ja,en}/desktop.json`（`server.launchFailed`・`unresponsive`・`linkRejected`）。`desktop/server-link.cjs`・`core/main-link.mjs` は変えていない
- **順序は「見つける → 起こせるか → 起こす」**（plan の 1・2・3 と同じだが、居るサーバーには Job も実行場所も見ずに付ける）。`probeRunning`（`main-link.json` のパイプにつなげるかだけ。握手しないので居るサーバーの口を奪わない）で居れば、`ServerLink` をそのまま worker にして `connect()` で付け直し、この版の実行場所は裏で組む（待たない）。居なければ Job（`inspectJob`・`decideLaunch`）と実行場所（`prepareRuntime`。1-3 で、組み終えてから戻る）を調べ、どちらかが駄目なら **`chooseServer` が null を返し、`main.cjs` が今の `utilityProcess` に落ちる**（理由は `[server]` の行と updater.log に残す）。起こした後に出来上がった側（起動の途中で終わった・時間切れ・パイプの版が合わない）は落とさず、起動の失敗のダイアログにする
- **Job の分岐**: `KILL_ON_JOB_CLOSE` が無い・`SILENT_BREAKAWAY_OK` がある → Node の detached 起動、`KILL_ON_JOB_CLOSE` + `BREAKAWAY_OK` だけ → koffi の `CreateProcessW`（環境ブロックを UTF-16 で組み、`process.env` は書き換えない）、`KILL_ON_JOB_CLOSE` だけ・調べられない → unsupported。この PC で Pleiad が起こしたシェルの Job は `BREAKAWAY_OK | SILENT_BREAKAWAY_OK | KILL_ON_JOB_CLOSE`（0x3C00）で、detached に分かれた【実測】。breakaway の実起動は `tests/unit/desktop-job.mjs` が（この環境の Job が許すとき）本物の `CreateProcessW` で確かめる
- **起こす**: 実行場所の `pleiad-node.exe` で `app\<版>\core\server.mjs`、cwd はホーム、`detached: true`・`stdio: 'ignore'`・`windowsHide: true`。env は `serverEnv`（`ELECTRON_RUN_AS_NODE` を外す・`PATH` の先頭に agent-browser の置き場（Windows の `Path` のキーを崩さない）・`stableCliEnv`・`AGENT_HOST_BIND`・`AGENT_HOST_PORT`（保存したポート）・`AGENT_HOST_SYSTEM_LOCALE`・`AGENT_HOST_SERVER_LOG`・`AGENT_HOST_RUNTIME_ROOT`/`KEY`）。`AGENT_HOST_TOKEN` は渡さない（サーバーが決め、`ready` で届く）。**`chooseServer({ port, token })` に前のサーバーの値を渡せば引き継ぐ**（1-6 の切り替え用）。待つのは「起こしたプロセスの pid が書いた `main-link.json`」で、前のサーバーが残した古いファイルを掴まない。起こしたプロセスが終わったら、先に居たサーバーへの付け直しをもう 5 秒だけ試し（起動の途中のサーバーがデータ置き場を持っていたとき）、駄目ならログの末尾（トークンは伏せる）を付けて失敗にする。上限は 60 秒
- **居るサーバーに付けないとき**: `main-link.json` が無い・パイプが無い（`ENOENT`）・秘密が違う（サーバーは何も返さず切る）は「古い」として起こす側へ。口の版の範囲が合わない（`reject`）・握手に答えないときは**起こさず**、起動の失敗にする（データ置き場の持ち主は居るので、起こしても落ちる）。居ると見えたサーバーが、つなぐ前に居なくなったときは `gone`（起こす準備をしていないので失敗）
- **ログ**: サーバーは `AGENT_HOST_SERVER_LOG` があれば、`stdout`・`stderr`・捕まらなかった例外を同期でファイルへ書く（`token=…` は伏せる。1 MB で `.old`）。置き場は実行場所の `logs\server.log`（design.md §3.3）。`server.mjs` の最初の import なので、import の失敗も残る。単独の起動（`npm start`・テスト）は今のまま標準出力
- **孤児にしない**（`core/orphan-guard.mjs`）: パイプの経路のサーバーは、**起動の時点から「main が居ない」状態で数え始め**（起こした main が最初につながる前に落ちても居続けない）、最初のつながりで解く。切れた後は、作業（`runningWork().count`）が 0 件のまま 3 分で `finishShutdown` と同じに終わる。`main-leaving { reason: 'update' }` が先に来ていれば 30 分。作業があれば数え直す。次の main が付け直せば解く
- **終了**: `closeSafely`・`session-end` は今のまま `shutdown` を送る（アプリを終了すればサーバーも終わる）。**main が落ちた・`app.exit`・強制終了ではサーバーが残り**、次の main が付け直す（上の見張りが最後の保険）。起動の失敗では `shutdown` せず `link.leave()` で切るだけ
- **サーバーが居なくなったとき**（`main.cjs` の `onServerExit`。今の `worker.once('exit')` の致命エラー）: `off` の経路は変わらない。パイプの経路は、別の main が付け直した（`bye 'replaced'`）なら静かに終わる・`bye 'closing'`（サーバーが終わる）なら今のダイアログ・つながりだけ切れたなら `reattachServer`（3 回・0.5 秒おき）で付け直して見張りを付け直す・居なければ今のダイアログ
- **確認用の口**（パッケージ版でなくても `electron .` のハーネスで試す）: `AGENT_HOST_RUNTIME_RESOURCES`（実行場所を組む元の `resources\`。`npm run desktop:pack` の `dist-desktop\win-unpacked\resources`）があれば `isPackaged` に依らず `AGENT_HOST_HANDOVER=on` が効く。plan 1-7 に書いた `AGENT_HOST_RUNTIME_NODE` は要らなかった（pack の `runtime\node.exe` を使う）
- **デスクトップで確かめた**（`dev-verification.md`「デスクトップ版（Electron）」）: 初回の起動は window 表示まで約 4 秒（実行場所を組む分を含む）、サーバーは実行場所の `pleiad-node.exe`・親は main でなく（main を `app.exit` した後も生存）、2 回目の main は 0.5 秒で付け直し、同じ pid・origin・トークン、`secret`（保存・伏せ字つきの読み）・内蔵ブラウザーの `agent-browser-endpoint`（fake の `browser:` の台本）が 1 回目と同じに往復し、`app.quit` でサーバーが終わり `control.json`・`main-link.json` が消える
- **1-5 が使うときの注意**: (1) 付け直した main には、サーバーが `connect` のたびに最新の `ready` と `resident` を送る（`computer-ready-request` は main が `computer-ready` を返す）。それ以外の「居ない間に溜まったもの」は無い。(2) **main の `message` の登録は `connect()` の前**（`chooseServer` が返す包みに `main.cjs` が付けてから `connect()`）。窓ができる前に届いた `agent-browser-*` などは取りこぼす（今の `utilityProcess` と同じ）。(3) `secret` の `status`（暗号化できるか）はサーバーのメモリに残るので、2 回目の main への付け直しでは `secret` の往復が少ない（3 → 1）。(4) 内蔵ブラウザーの中継（`desktop/browser-relay.cjs`）は main のもので、付け直した main には中継が無い（ポート・鍵が変わる）。サーバーが一覧を持って同じポート・鍵で立て直す作業は 1-5。今は、次の `agent-browser-endpoint` の依頼で新しい中継ができる
- **1-6 が使うときの注意**: (1) **`main-leaving` を送る所は未配線**（サーバー側の受け取りと見張りの 30 分だけある）。`installUpdate` は今も `update-lock` → `shutdown` で、パイプの経路でもサーバーを終わらせる。1-6 は、`main-leaving` を送ってから `ServerLink.leave()`・`quitAndInstall` の順にする。(2) 切り替えで旧サーバーを `shutdown` で終わらせると、`onServerExit` が「サーバーが終了しました」を出すので、切り替えの間は止める（`quitting` と同じ印）。(3) 新しいサーバーは `launchServer`（`mode` は `decideLaunch` の結果）・`serverEnv`（`token`・`port` に旧サーバーの `ready` の値）・`startAndConnect`（`main-link.json` の pid を待つので、旧サーバーが消した後の古いファイルを掴まない）で起こし、**同じ `ServerLink` に `connect()`**（`message` の登録が残る。`once('exit')` は付け直す）。(4) 前の版へ戻すときの Job の分岐は `chooseServer` と同じ。(5) 切り替えの待ちの `count` は孤児の見張りと同じ `runningWork`

### 1-5 main が居ない間の機能ごとの扱い（M〜L。**実装済み 2026-10-06**。下の「実装のメモ」）

design.md §7.2 の表のとおり。サーバー側が「main に頼むもの」を、main が居ない間は機能ごとに扱う。口の層（1-2）は捨てるだけなので、ここで決める。

- **secret**（`core/secret-store.mjs`）: 復号の依頼は main が戻るまで待たせる（上限 5 分。超えたら失敗）。復号した値はメモリに持ち続け、同じ秘密は 2 回目から main に頼まない。暗号化の依頼も同じ待ち
- **computer use**（`core/computer-use/driver.mjs`・`core/computer-use/*`）: main の切断を Esc と同じに扱い、使用を止める（持ち主のロックを解き、進行中の呼び出しは `ComputerError('failed', …)` で返す）。ツールには「Pleiad の更新中のため止めました」（辞書の文言）と返す。ターンは止めない。戻った main には、止めたことを送り直さず、次の呼び出しで承認からやり直す
- **内蔵ブラウザー**（`core/agent-browser.mjs`・`core/browser-screencast.mjs` と `desktop/browser-relay.cjs`・`browser-panel.cjs`・`agent-browser-bridge.cjs`）: サーバーが中継の一覧（会話・ポート・鍵・開いていた URL）を持ち、新しい main が付け直したとき、**同じポートと鍵で**中継を立て直し、タブを URL で開き直す。ポート・鍵が今は main の側で都度決まる（`browser-relay.cjs` の `server.listen(0, …)`・`random()`）ので、サーバーが決めて渡す形に直す。**1-0 の c で、同じポート・同じ鍵なら常駐は次の呼び出しで戻る**（同じ PID のまま）。ポートが取れなかったときは、別のポートと鍵にして、会話ごとの設定ファイル（`agent-browser.json` の `cdp`）を書き直せば、ターンの途中でも通る（二段の落とし方）。**中継の待ち受けは、タブを URL で開き直してから**（中継は、タブが無いと空のタブを 1 枚作る。先に待ち受けると、常駐の最初の `getTargets` が `about:blank` を見る）。居ない間（約 50 秒）の `agent-browser` は約 2 秒でエラーになる（モデルの再試行に任せる）
- **resident**（`desktop/resident.cjs`）: 戻った main に `resident` を送り直す。居ない間は何もしない（スリープ抑止は無くなる。入れ替えの間に入る見込みは小さい）。長い入れ替えでスリープに入るなら、サーバーが `SetThreadExecutionState`（koffi）で同じ間だけ抑える（1-0 の d: main が居ない時間は約 50 秒で、Windows の既定のスリープには届かない見込みなので、要らない【推測】）
- **wake**: main が付け直したら必ず 1 回 `wake` を送る
- **openExternal**: 非 Electron の開き方（`core/os-open.mjs` の `defaultOpener`）で開く
- **PC の通知**: 居ない間に溜まった完了の通知のうち、まだ見られていないものを、戻った main が出す
- **locale**: 付け直しで送り直す
- **`main-leaving`**: サーバーは受けたら、`hostAway` の猶予（`HOST_GRACE_MS`）を数えない（画面が居ない間の既存の仕組みと別に、main が居ないことを持つ）
- テスト: `tests/unit/main-away.mjs`（口を切って、secret の待ちと上限・復号した値の保持・computer use の停止と戻った後の承認からのやり直し・resident の送り直し・wake・通知の溜まり）。内蔵ブラウザーは `tests/browser/` の既存の作りか、ハーネスで

**実装のメモ（2026-10-06。実装済み。1-6・1-7 が使うときの注意を含む）**

- **新しいファイル**: `core/main-away.mjs`（main が居る・居ない・main-leaving の出来事と、OAuth の同意画面などを開く口 `createExternalOpener`）。機能ごとの扱いは頼む側のモジュールが持つ: secret = `core/secret-store.mjs`、computer use = `core/computer-use/driver.mjs`（`onAway`）・`lock.mjs`（`stopAll`）、内蔵ブラウザー = `core/agent-browser.mjs` と `desktop/agent-browser-bridge.cjs`・`browser-relay.cjs`・`browser-panel.cjs`、screencast = `core/browser-screencast.mjs`、os-open = `core/os-open.mjs`。`core/server.mjs` の差分は配線だけ、`desktop/main.cjs` は 1 行（橋に `handover`）。口に `resumable`（パイプの口だけ true）を足し、main が居ない間の扱いは `resumable` の口だけが持つ（utilityProcess の口の挙動は変わらない）
- **扱いの一覧**（design.md §7.2 の表にも書いた）: secret は待たせる（上限 5 分）・送って切れた依頼は戻す・復号と暗号化の組を持つ・答えを得られなければ平文に落とさず失敗。computer use は Esc と同じ（reason `update`。辞書・画面の表示を足した）。内蔵ブラウザーはサーバーが URL とタブの写しを持ち、居ない間の endpoint は写しか選んだ空きポートで答え、戻った main が `browser-restore-request` で引いてタブを先に開き直してから同じポート・鍵で待ち受ける（取れなければ別のポート + 設定ファイルの `cdp` を書き直す）。screencast は `ended('away')`。os-open・openExternal は居ない間 OS に直に。locale・wake・resident は付け直しで送り直す（wake はサーバー側で行い、main は送らない）。PC の通知は新しいコード無し（既存の溜め）。`main-leaving` の後は画面の猶予を数えない
- **テスト**: `tests/unit/main-away.mjs`・`main-away-desktop.mjs`・`main-away-server.mjs`（本物のサーバーに偽の main をつなぎ、猶予の有無を対照）。全件の `npm test`（`--jobs 2`）は 312 本・11,992 判定が通り、`desktop-job` だけ一時フォルダーの `rmSync` の EPERM で落ちた（負荷中の掃除の失敗。単体で流し直すと 24 / 24 通過。この変更とは無関係）
- **デスクトップのハーネス**（dev-verification.md の 1-5 の項。`desktop:pack` の resources・一時のデータ置き場と実行場所・fake）18 / 18 通過: main を `app.exit(0)` → サーバー生存 → 居ない間の `savePlyMcp`（env の秘密）は待たされ、`browser:` のターンは同じ `cdp` のまま終わり、`computer:` のターンは `stopped / update` → 付け直した main で秘密が約 3 秒後に通り（`safeStorage` で暗号化）、タブ 2 枚が戻り、1 回目の URL でつながり、本物の `agent-browser` が同じ常駐の pid のまま通る → `app.quit()` でサーバーが終わり control.json・main-link.json が消える。**os-open・openExternal の「居ない間」は実機では起こしていない**（explorer・ブラウザーが実際に開くため。起動する内容と注入した spawn で単体が確かめる）
- **1-6 へ**: (1) `main-leaving` を送った後に更新を取りやめたとき、サーバーの「猶予を数えない」状態（`leaving`）は main の再接続でしか解けない。取りやめの知らせを足すかを決める。(2) `agentBrowserBridge.close()` は終わる前に最後のタブの写しを送る（`will-quit` で呼ばれる）ので、`installUpdate` から `quitAndInstall` へ進むときの順序は変えなくてよい。(3) 切り替えで新しいサーバーを起こすときは、旧サーバーが持つ内蔵ブラウザーの写し・中継の URL・復号した値は引き継がれない（新しいサーバーは空から始まり、新しい main の復元の依頼は空の答えになる）。タブは main のものなので残るが、写しの報告は次の変化まで届かない。切り替えの直後に main が `browser-state-report` を 1 回送り直す道（または新しいサーバーへの付け直しで `browser-restore-request` を使わず報告だけする）が要る
- **1-7 へ**: os-open・openExternal の居ない間の実機（署名した旧版 → 新版の更新の最中）。更新の約 50 秒の間に、スリープ抑止の要否（1-0 の d）

### 1-6 更新の流れ・切り替えの先送り・画面の読み直し（M。**実装済み 2026-10-06**。待ちの表示は承認済み（2026-10-06）で実装済み。下の「実装のメモ」・「待ちの表示」）

design.md §5.1・§6.1・§8。

- `desktop/main.cjs` の `installUpdate`（`AGENT_HOST_HANDOVER=on`）: 作業を止めず・サーバーをロックせず、`main-leaving { reason: 'update' }` を送って `quitAndInstall` する（今の `workerRequest('update-lock')` と `abortAll` を通らない）。`off` では今のまま。画面の「中断して更新」のダイアログ（`web/interrupt.mjs`・`web/client.mjs`）は `off` と、合わない更新のときだけ
- 新しい main が起動して走っているサーバーに付け直したとき（`--updated` の有無によらず、サーバーの `appVersion` と自分の版・ビルドのハッシュが違えば）、**切り替えの制御**（`desktop/switch.cjs` 新規。純粋な状態機械 + 副作用を注入）を始める:
  1. 事前の確かめ: 新しい版の実行場所へ組み（1-3）、`pleiad-node.exe app\<新>\core\handover-check.mjs` を走らせる（新規 `core/handover-check.mjs`。データの形式番号・`ipc` の範囲を JSON で出す）。データの形式番号が変わる・`ipc` の範囲の外・manifest の不一致 → 自動の切り替えをせず、「あとで／中断して更新」のダイアログ（今の ADR 0036 の形）。「あとで」は S1 のまま動かし続け、勝手には切り替えない
  2. 待ち: 走っている作業（`running` の `count`）が 0 になるのを、数秒おきに見る（サーバーの `running` の通知がある間はそれも使う）。**`count` は `!` の行（`shellRuns.running()`）・Codex の裏の端末（`runtime.background`）・外部の stdio MCP・予定された送信を数えず、S1 の終了で止まる**（今の更新・終了と同じ。1-0 f）。**止まるものは待たず、黙って止めもしない**: 作業が 0 件になったとき残っていれば、自動では切り替えず「あとで／止めて切り替え」を聞く（下の「待ちの表示」）。窓の表示は「新しい版への切り替えを待っています」と「今すぐ中断して切り替える」
  3. 作業が 0 件になったら `update-lock`（`updateGate.acquire`）を取る。取れなければ（短い処理の最中）待ちに戻る。取れたら、サーバーに `shutdown`（`flushNow`・ロックを放して終わる）を頼み、終わるのを待つ（上限 30 秒）
  4. 新しいサーバーを同じ `AGENT_HOST_TOKEN`・`AGENT_HOST_PORT` で起こし、`ready` を待つ。窓を読み直す（同じ origin ならそのまま `loadURL`。ポートが変われば `window-trust` の origin も登録し直す）
  5. 新しいサーバーが立たなければ、前の版（`app\<旧>`）で起こし直し、窓に「新しい版のサーバーを起動できなかったので、前の版で動いています」。ログを残す
  - 「今すぐ中断して切り替える」: 全部を `update` で中断（今の `abortAll('update')`）→ 3 以降
  - 切り替えの制御は、`running` の `count`・ロックの取得・サーバーの終了・起動を引数で受ける純粋な状態機械にして、実時間・実プロセスなしでテストする
- `core/server.mjs`: `ready` に `appVersion`（とビルドのハッシュ。`package.json` の `version` と `manifest.json` の先頭のハッシュ）を足す（`core/protocol.mjs` の `READY` の注記も）。`protocolVersion` は変えない
- `web/client.mjs`: `ready` の `appVersion` が、自分を配った版（HTML に埋めた版）と違えば、入力欄の下書きを保存して 1 回だけ読み直す（sessionStorage に「この版で読み直した」を残し、繰り返さない）。`protocolVersion` の不一致の扱いは今のまま
- **切り替えの待ちの表示**（新しい UI。モックは承認済み（2026-10-06）。形は `docs/design-system.md`「切り替えを待つ表示」、決定は [ADR 0152](../adr/0152-switch-wait-display.md)）: 脇の下の更新の知らせの中で一覧を開く。待ちの件数と作業の一覧（今の更新ダイアログの「止まる作業」と同じ行）、止まるもの、「今すぐ中断して切り替える」、切り替えに失敗したときの「もう一度試す」。文言は辞書（`web/locales/{ja,en}/ui.json` の `switch.*`・`updates.handover*`、main のダイアログは `desktop.json` の `switch.*`。訳語は `docs/i18n-glossary.md`）。実装メモは下の「待ちの表示」
- main が出す文言（ダイアログ）も `web/locales/{ja,en}/desktop.json`（`desktop/i18n.cjs` が読む）
- 新しい main の preload は、古い画面（先送りの間に出す S1 の画面）が使う名前を 1 版ぶん残す（`desktop/preload.cjs`）
- テスト: `tests/unit/desktop-switch.mjs`（状態機械: 待ち・ロックが取れない・サーバーの終了の待ち・起動の失敗から前の版へ戻る・形式番号が違う版は自動で切り替えない・「あとで」・「今すぐ中断」・待っている間に新しい作業が始まる）。`tests/unit/web-interrupt.mjs` に読み直しの判定。`handover-check` の出力は `tests/unit/handover-check.mjs`

**実装のメモ（2026-10-06。実装済み。待ちの表示は下の「待ちの表示」。流れの全体は design.md §6.1「段階 1 の実装」）**

- **新しいファイル**: `desktop/switch.cjs`（状態機械 `createSwitch`・副作用の組み立て `createSwitchEffects`・`startSwitch`・合わない版のダイアログ `incompatibleDialog`）・`core/handover-check.mjs`（事前の確かめ。`readBuildInfo` はサーバーの `ready` も使う）。既存は小さく: `desktop/main.cjs`（`installUpdate` の on・`startServerSwitch`・`onServerExit` の印）・`core/server.mjs`（`ready` の `build`・main への `ready` の `appVersion`・`build`・`pid`・`runtimeKey`・`running` の `shells`・`index.html` の `pleiad-build`）・`core/shell-runs.mjs`（`list`）・`desktop/runtime.cjs`（前の版の場所 `locate`）・`desktop/server-boot.cjs`（`chooseServer` の `prepared`）・`desktop/updates.cjs`（`handover`）・`web/client.mjs`・`web/interrupt.mjs`（`versionReload`）・`web/updates.mjs`・`web/locales/{ja,en}/desktop.json`（`switch.*`）
- **`main-leaving` → `leave()` の位置**: `main-leaving` は `quitAndInstall` の前に送り、`leave()` は electron-updater がインストーラーを起こした直後（`before-quit-for-update`）にする。`quitAndInstall` が失敗したときに、つながりを切らずに済む（更新を取り消しても `main-leaving` の印はサーバーに残る。1-5 と合わせて扱う）
- **数えない作業の扱い（決めたこと）**: 外部の stdio MCP は数えない（作業ではなく、走っているターンが 0 件なら呼び出しの途中は無い。S2 が次の呼び出しで起こし直す。状態（`node_repl` など）は今の再起動と同じく消える。数えると切り替わらない）。送信予定・上限の解除後の再開は数えない（行は `schedule.json` に残り S2 が戻す。断の数秒は送信予定の遅れの猶予 1 時間（ADR 0103）に収まる。発火して送信待ちに入った分は `update-lock` が断る）。**`!` の行と Codex の裏の端末は「切り替えで止まるもの」（stoppers）で、待たない**（利用者の決定「Z」。2026-10-06。終わらないもの（`npm run dev`・裏の端末）があるので、待つと切り替わらず、原因が見えない。待たずに止めると黙って dev サーバーを止める）。`switchBlockers` の `count` は `running` の `count` だけで、stoppers は別に持つ。作業が 0 件になったとき stoppers が残っていれば `asking` で「あとで／止めて切り替え」を聞く。テストは `tests/unit/desktop-switch.mjs`
- **表示の口**: `onState(snapshot)`・`answer('now' | 'later')`・`interruptNow()`・`retry()`（design.md §6.1）。表示は下の「待ちの表示」
- **preload**: 名前は変えず、`switch`（版 1）を足した。前の版の画面が使う名前の一覧を `tests/unit/desktop-switch.mjs` に持ち、消えたら落とす
- **確かめた**: `npm test`（全件）・デスクトップのハーネス（`docs/dev-verification.md`「デスクトップ版（Electron）」。版の違う 3 つの resources で、旧版の main の fake のターン → 更新相当 → 新版の main が付け直して待ち、ターンが中断されずに終わってから同じトークン・ポートで S2 に替わり、窓が読み直される。main が読み直さない別の窓は自分で 1 回だけ読み直す。壊した版では前の版で起こし直し、その旨が出る）
- **1-7・1-5 への申し送り**: (1) S1 の終わりで `computer/service.cjs`・`computer-overlay.cjs` の `once('exit')` の後始末が使い切られ、S2 には付け直されない。(2) 更新を取り消したとき（`quitAndInstall` の失敗）の `main-leaving` の印。(3) 新しい版が立たないとき、起こしたサーバーの終わりを見てから前の版を起こすまで約 6 秒（`startAndConnect` の付け直しの猶予 5 秒）。(4) 窓は、main の読み直しの前に古い画面が S2 につながると自分でも読み直しを始めうる（どちらかが勝ち、読み込みは 1 回に収まった）
- **1-5 と 1-6 の合わせ（2026-10-06。上の 1-5 の「1-6 へ」と 1-6 の「申し送り」の分。表は design.md §7.2）**:
  1. **S2 の内蔵ブラウザーの写し・中継の URL**: main の橋が、サーバーの `ready`（つながるたびに届く）で `browser-state-report` を 1 回送り直す（中身が変わらなくても。中継の `{ port, entries }` つき。`relay.snapshot()`。サーバーは `adoptRelay` で取り込む）。`browser-restore-request` で開き直す道にしなかったのは、タブと中継は main のもので残っており（S2 の答えは空）、S2 に要るのは写しを持たせることだけなので。復元が済む前の `ready` では送らない（復元の流れが報告を始める）。**秘密の復号の組**: 頼み直せば足りる（safeStorage は main のもので、暗号文はデータ置き場にあり、サーバーの組は写しにすぎない。S2 は空の組から `status`・`decrypt` を頼む）。`tests/unit/main-away.mjs` の「切り替えで替わったサーバー」で、S1 が暗号化した値を S2 の新しい口が頼み直して復号できることを見る
  2. **computer use の後始末の見張り**: `desktop/computer/service.cjs` の `releaseAll`・`desktop/computer-overlay.cjs` の `hideAll` を `once('exit')` から `on('exit')` にした（つながりが切れるたびに `exit` が出て、同じ包みにつなぎ直すため。切れた後の付け直し（`reattachServer`）でも同じ穴があった）。`main.cjs` の `onServerExit` は今のとおり `rearm` で付け直す（サーバーが居ないときの処理を含むので）
  3. **更新の取りやめ**: `installUpdate` が失敗したとき（`quitAndInstall` が投げた・electron-updater の `error`）、`main-leaving-cancel` を送る（`update-unlock` の代わり。`off` は今のまま）。サーバーは `core/main-away.mjs`（`onStay`）で `leaving` を解いて `restartGrace()`（猶予を数え直す）、`core/orphan-guard.mjs`（`leavingCancelled`）で次の切断の上限を 3 分に戻す。つながりは切らない。型は既存の `main-leaving` に並べた（`{ type: 'main-leaving-cancel' }`。`ipc` は 1 のまま。古いサーバーは知らない型を読み捨てる）
  4. **ホストへ任せる口（`remote-agent`。main の 2026-10-06 の取り込みで増えた）**: サーバーが `process.parentPort` を直に見ていたので、パイプの経路ではこの口が無効だった。main への口（`mainPort`）に寄せた。**居ない間は待たせず `OFFLINE` で失敗にする**（線が main のもので居ない間は無い・待たせるとモデルのターンが約 50 秒止まる・作った直後に切れた依頼は二重に作りうる・オフラインの扱いが揃っている）。ホストは全部オフライン扱いにして（一覧・許可の印・台帳の写しは残す）、戻ったら main の橋が `ready` で一覧と、つながっている線の `ready` を送り直し（`resync`）、サーバーの追いつき（`catchUp`）が動いているタスクと中継する承認を同期し直す。付け直しも切り替え（S2。線は main のもので張ったまま）も同じ。テスト: `tests/unit/main-away.mjs`（口の振る舞い）・`main-away-desktop.mjs`（橋の送り直し）。**ホストの実機（本物のホストへ線を張った main で、更新・切り替えをまたぐ）は確かめていない**（ホストと中継が要る。1-7）
  - **デスクトップのハーネス**（1 の「切り替えの後に S2 がタブの写しと中継の URL を持つ」。`desktop:pack` の resources を A、A を写して `app\` に 1 ファイル足し manifest を作り直したものを B にして electron を 3 回）7 / 7 通過: A の main で fake の `browser:` のターンとタブ 2 枚 → `main-leaving` と `leave` で離れる → B の main が S1 から写し（タブ 2 枚・中継）を受け取って開き直し、切り替えで S2（別の pid）に替わり、S2 の `ready` の直後にタブ 2 枚と中継の URL つきの `browser-state-report` を送る → 3 つ目の B の main が S2 に付け直すと、S2 の復元の答えにタブ 2 枚と同じポート・会話の鍵が入っている。使い方は dev-verification.md の 1-6 の項
  - **残り**: ホストへ任せる口の実機・本物のインストーラーをまたぐ更新での確認は 1-7。取りやめた後に古いサーバー（`main-leaving-cancel` を知らない版）へ付け直した main は、`leaving` の印を戻せない（次の付け直しで消える。段階 1 の範囲では受け入れる）

**待ちの表示（実装済み 2026-10-06。モックは承認済み。形は design-system.md「切り替えを待つ表示」、決定は ADR 0152）**

- **誰が描くか**: 待っている間の窓は古い版のサーバー（S1）が配る古い版の `web/` の画面。表示のコードは「N 版の `web/`」（`web/switch-notice.mjs`）に入り、N → N+1 の更新のときに N+1 の main（`desktop/switch-screen.cjs`）が状態を渡して描かせる。**main が描くのではない**（上の古いメモの「main の側で描く」は直した）
- **main → 画面の受け渡しは版つき**: preload の `plyDesktop.switch`（`version: 1`・`hello()`・`state()`・`onState(listener)`・`act('now' | 'later' | 'retry')`）。状態（payload）は `{ v: 1, phase, target, current, since, items, stoppers, … }`（phase は `waiting`・`asking`・`manual`・`held`・`stopping`・`switching`・`done`・`failed`。形は `desktop/switch-screen.cjs` の `displayState`）。画面は読める版（`SWITCH_BRIDGE_VERSIONS`）だけを読み、知らない版・知らない phase・欠けた項目は何も出さない／空として扱う。口の形を変えるときは `switch2` と `payloadFor` の版を足し、**`switch`（版 1）は新しい main が 1 版ぶん残す**（画面は古い版でも読める）。名前の一覧は `tests/unit/desktop-switch.mjs` が守る
- **画面が表示を持つかを main が知る**: 画面は読み込むとき `hello()` を送る。main は **hello が来た画面にだけ表示を任せる**（窓を読み込み直すたびに忘れる）。**表示を持たない画面（この機能を持つ最初の版への更新。古い版のサーバーが配る画面）には、最小限の main 側の知らせを出す**: 止まるものが残ったとき・合わない版を聞くときのダイアログ（「あとで／止めて切り替え」「あとで／中断して更新」。`incompatibleDialog`）と、前の版に戻したときのダイアログ。**待っている間は何も出さない**（updater.log にだけ残る。待ちは利用者が選んだ「止まらない更新」の続きで、作業が終われば自動で切り替わる）。窓の読み込み中に聞く場面が来たら hello を 8 秒まで待つ
- **状態機械の変更**（`desktop/switch.cjs`）: `asking`（止まるものだけが残った）・`held` の reason `stoppers`（あとで。止まるものが無くなる・作業が増えるまで聞き直さない）・`answer()`・`retry()`（前の版で動いているとき、準備からやり直す）・`since`（待ち始めの時刻）・`interrupt`（中断の進み。`abortAll(onProgress)`）・`interruptFailed`・`stopped`（切り替えで止めたもの）
- **画面**: 脇の下の `#switchNotice`、設定のページの `#switchBox`、⚙ の点、確認の段の 1 行（`state.handover` のとき）、「更新しました」を切り替えまで出さない・止めたものの 1 行（`web/updates.mjs`）。リモートの窓・ブラウザーは `plyDesktop.switch` が無いので何も出ない
- **確かめた**: `tests/unit/desktop-switch.mjs`（Z・もう一度試す・中断の進み・待ち始め）・`desktop-switch-screen.mjs`（橋・hello・版）・`web-switch-notice.mjs`・`tests/browser/switch-notice.cjs`（実際の画面。橋は偽物。ライト・ダーク・640px・360px）

### 1-7 テスト・文書・実機・既定を `on` に（M。**実装・確認済み 2026-10-06**。記録は [stage1-7.md](stage1-7.md)）

- 通常テスト（`tests/unit/`）は各項目に書いたとおり。実時間に頼らない（時計・プロセスは注入）。`AGENT_HOST_HANDOVER=off` の経路の既存の試験は変えずに通す。1-7 で足したもの: `tests/unit/desktop-boot.mjs`（パッケージ版の既定 on・空の値・`off`・on でも空でもない値）・`tests/unit/pack-runtime.mjs`（動かさない prebuild を外す）・`tests/unit/zdtest-isolation.mjs`（実機の確認の試験用の構成が、利用者のインストール版と重ならない）
- デスクトップのハーネス（1〜4）: **通った**。1-4〜1-6 の子が `temporary/` に置いた確認用のスクリプトは残っていなかったので、`desktop:pack` の `electron .` の形ではなく、**試験用のインストーラー（署名なし。appId・名前・場所・ポートを別にした）で本物のインストール版の形**に作り直して流した（`scripts/zero-downtime/stage1-7/`。`AGENT_HOST_HANDOVER` は渡さず既定の on。`AGENT_HOST_RUNTIME_NODE`・`isPackaged` の上書きは要らなかった）。1（main だけ止めて付け直し）・4（居ない間の computer use・secret）= s4、2（切り替えの待ち → 新しいサーバー → 窓の読み直し）= s1・s2、3（立たない版）= s3 --to C
- 実機（「実機で確かめる項目」の段階 1）: 署名なしの試験用のインストーラーで、本物の NSIS・electron-updater の旧版 → 新版を通し、次を確かめた（結果の数値と手順は stage1-7.md）: 1（fake・Claude `claude.exe`・Codex・agy のターンを走らせたまま更新。中断の印なし。作業が終わった後に切り替わる）・2（承認待ちのまま更新: fake・Claude・Codex は新しい main の窓で承認が 1 つ出て答えられる。agy は承認のモードが無い）・4（待ちの表示・切り替え・窓の読み直し・下書き。「今すぐ中断して切り替える」は押してから 4.3 秒でターンが止まり約 1 秒後に切り替わる）・5 の main が居ない間の停止・6（内蔵ブラウザーのタブと中継）・7 の古い版の掃除（4 版 → 3 版。前方一致の移動は未確認）・8・9・10。**main が居ない時間は 44〜53 秒**。**残り（利用者に頼む確認。手順は stage1-7.md の U1〜U11）**: 署名した版での 1〜2・npm の `claude.cmd`・3（スマホ）・5 の本物の画面操作・7 の前方一致の移動・15（全ユーザー向け）・16（ARM64）・os-open・openExternal の居ない間・ホストへ任せる口・スリープ・リリースの CI の Node のキャッシュ
- **見つけて直したこと**: 上の 1-3 の「1-7 の結果」（インストーラーが別 CPU の `.exe`・`.dll` を落とし、実行場所を組めなかった）。実行場所を組めない環境で `utilityProcess` に落ちる経路も、そのまま実機で確かめられた（理由が `updater.log` に残る）
- 文書（実装と同じ変更で書き換えた。ADR 0151「影響」の段階 1 の分）: `docs/desktop-releases.md`（更新UX・適用とデータ保護・同梱する Node と実行場所・リリース判定）・`docs/design.md`（デスクトップの更新・中断と再開・4. アーキテクチャの「デスクトップ版の層」）・`docs/multi-backend.md`（`running` の `count` と切り替え）・`docs/computer-use.md`・`docs/inapp-browser.md`・`docs/remote.md`（1-5・1-6 で書いた）・`docs/design-system.md`（1-6 で書いた）・`docs/dev-verification.md`（本物のインストーラーの確認の作り）・ADR 0090（追記）・`AGENTS.md`（環境変数の表・サーバー起動・確認）
- **パッケージ版の `AGENT_HOST_HANDOVER` の既定を `on` にした**（`desktop/main.cjs` の `chooseLinkedServer`。env が無ければ on・`off` で今の `utilityProcess`・on でも空でもない値は off と同じ。開発の `electron .` は `AGENT_HOST_RUNTIME_RESOURCES` つきで `on` を明示したときだけ on）。テストも合わせた。全件の `npm test`（`--jobs 2`）は 335 本・12,950 判定が全て通過した（518 秒。失敗なし）

**段階 1 の完了の条件**: 署名した旧版 → 新版の更新を、fake ではない Claude・Codex・agy のターンを走らせたまま行い、**ターンが中断されずに終わる**（core の切り替えは作業が終わった後）。承認待ちのまま更新しても、新しい main に承認が出て答えられる。npm で入れた `claude` でも同じ。更新の間にスマホから承認・送信ができる。

**達成度（2026-10-06）**: 署名なしの試験用のインストーラー（本物の NSIS・electron-updater）で、fake・Claude・Codex・agy のターンが中断されずに終わり、承認待ちのままの更新も fake・Claude・Codex で通った。**署名した版・npm の `claude.cmd`・スマホ・全ユーザー向け・ARM64 は未確認**（利用者に頼む確認 U1〜U11。stage1-7.md）。それ以外の段階 1 の項目（1-0〜1-7）は完了。

---

## 段階 2: 保持役 + Claude（XL）

段階 1 の「サーバーの切り替えを先送りする」を、保持役の付け直しに替えていく。着手の最初に、未測定の Claude の場面を測る。

### 2-0 頭の測定（S〜M。**完了 2026-10-06**。記録は [stage2-claude.md](stage2-claude.md)）

`scripts/zero-downtime/claude/` の作りで、次の最中に付け直したときの振る舞いを測る（stage0-claude の未確認）: サブエージェント・裏のコマンド（`background_tasks_changed`）・途中送信（`pendingSteers`）・圧縮（`PreCompact`）・`elicitation`・`request_user_dialog`・`oauth_token_refresh`・Pleiad の実際のオプション（`systemPrompt` のプリセット・`settingSources`・`skills`・プラグイン・互換の接続先）・npm で入れた `claude`（`pleiad-node.exe` で走らせる形）・数 MB の出力を流したときの保持役の遅さ・**外部の stdio MCP（`core/context-bridge.mjs` がサーバーの直の子として起こす）の扱い**（引き継ぎで旧サーバーと一緒に止まり、状態は戻らない。起こし直すか保持役の子にするか。R15）。**駄目な場面は「引き継ぎの前に終わるのを待つ」か「その場面のターンは保持役に載せない」に倒す**（design.md §4.4）。結果は `docs/zero-downtime-update/stage2-claude.md`

**結果（CLI 2.1.284・SDK 0.3.288。要点）**: **「保持役に載せない」に倒す場面は無かった**（`cli.js` の npm の包みは付け直しの下限の版より古いので、版の一覧で外れる）。

- **付け直せる**: サブエージェント（前面・裏・その中の承認待ち）・裏のコマンド（付け直し直後に CLI が裏の作業の全量を `background_tasks_changed` で出し直す）・途中送信（旧い親が流し込んだ分も同じ uuid の replay が新しい親に届き、`cancelQueued` で取り消せる）・圧縮（要約中も `PreCompact` の最中も。`PreCompact` は CLI が自分で取り消す）・`elicitation`（**控えの渡し直しが要る**。渡し直さないと止まる）・Pleiad の実際のオプション（**2 回目の `initialize` の systemPrompt・skills は CLI が使わない**）・互換の接続先（フラグ設定のファイルは起動時にだけ読まれる）・npm の `claude.cmd`（中身はネイティブの `bin/claude.exe`）・CLI の子の stdio MCP（状態も残る）・数 MB の出力（5 MB で +0.1〜0.3 秒、20 MB で約 2 倍・保持役 190〜460 MB）
- **引き継ぎの前に終わるのを待つ**: 段階 0 の hooks（`PreToolUse` など）・`mcp_message`・HTTP の MCP に、**外部の stdio MCP の処理中の呼び出し**を足す
- **対象外**: `request_user_dialog`（宣言しない限り CLI が出さない）・`oauth_token_refresh`（`getOAuthToken` を渡さない限り出ない）
- **R15**: 段階 2 は起こし直す（約 0.2 秒、状態は消える。起こし直した後の最初の結果にその旨を添える）。保持役の子にすると状態は残るが、旧いクライアントの JSON-RPC の id への応答が新しいクライアントの同じ id にぶつかるので、世代つきの id が揃う段階 3 で
- 2a〜2e に響くこと（控えに `elicitation`・答え済みの `control_request` を流し直さない・記録の上限・`.cmd` を exe に解く・札に `pendingSteers`）は stage2-claude.md「段階 2 の計画（2a〜2e）に響くこと」。下の 2a・2c・2d に反映した

### 2a 保持役（M〜L。**実装済み 2026-10-06**。下の「実装のメモ」）

- `core/holder/`（Node の組み込みだけ。目安 1,000 行以内）。規約 v1（design.md §4.2）、記録・印・ack・控え（`mcp_message` と `elicitation` だけ渡し直す。親が答え済みの `control_request` は再生で流し直さない。2-0）・世代・札・預かり物、木ごとの強制終了、`logs\holder.log`。**JSON-RPC の id の付け替えと `initialize` の答えは持たない**
- 記録の上限（`truncated`）と、ack・印より前を捨てるのを最初から入れる（20 MB の本文のターンで保持役が 460 MB まで膨らんだ。2-0）。行は JSON で包み直さずに送る。`claude.cmd` は包みの `bin/claude.exe` に解いて直に起こす
- 子の stdout・stderr を、親の有無にかかわらず**常に読む**（イベントループを長く止めない）。`detach` の後は、その親からの `write`・`end`・`kill` を転送しない。親が居ないあいだも子の stdin を閉じない
- 起動は `detached: true` + `stdio: 'ignore'` + `windowsHide: true`（段階 1 と同じ起こし方と Job の分岐）
- テスト（`tests/unit/holder-*.mjs`）: 偽の子（行を出す・依頼を出す・止まる・大量に出す）で、切断と付け直し・控えの渡し直し・**stdout を誰も読まない親でも詰まらない**（1 MB 以上）・`detach` 後の `kill` を転送しない・記録の上限（`truncated`）・二重起動の防止・`hello` の `secret` の不一致・世代の古いパイプ

**実装のメモ（2026-10-06。実装済み。2b・2c が使うときの注意と、design.md §4.2 とのずれを含む）**

- **ファイル**（`core/holder/`、合計約 900 行。Node の組み込みと `core/link-codec.mjs`・`core/atomic-file.mjs`・`core/server-log.mjs`・`core/runtime-use.mjs` だけ）: `protocol.mjs`（規約 v1 の定数・パイプ・秘密のファイルの名前）・`holder.mjs`（保持役の本体 `createHolder`）・`main.mjs`（起動口。detached で起こされる）・`client.mjs`（サーバー側の口 `HolderClient`・`connectHolder`・`launchHolder`・`ensureHolder`）。既存のコードの変更は `core/server-log.mjs` の `redirectOutput` に始まりの行の名前（`label`）を足しただけ。**まだサーバーのターンには配線していない**（既定の流れは変わらない）。試験は `tests/unit/holder-{core,handshake,process}.mjs`（93 判定。偽の子は `tests/lib/holder-fake-child.mjs`）
- **規約 v1 の形は `core/holder/protocol.mjs` の頭の注記に固定した**。パイプ `\\.\pipe\pleiad-holder-<データ置き場と利用者名のハッシュ>-v1`、1 行 1 JSON（`core/link-codec.mjs`）。名前と秘密は実行場所の `run\holder-<キー>-v1.json`（権限 0600。保持役が `listen` に成功してから書き、終了で自分のものだけ消す。データ置き場には書かない）。`hello { secret, protocol: [min, max], role: 'server', pid, appVersion }` → `welcome { protocol, generation, range, appVersion, pid, children, stash }`。秘密が合わなければ何も返さず切り、合って版が合わなければ `reject { reason: 'protocol', range, generation }`
- **design.md §4.2 の素描との差**（実装に合わせて §4.2 の表を直した）: 答えの要る依頼の応答（`attached`・`detached`・`replay` の `reqId` つき連続・`error`）・`release`（終わった子の記録を捨てる）・`shutdown`（子を木ごと止めて終わる）・`bye`（`replaced`・`closing`・`leaving`）を足した。`attach` は `{ id, from? }`（from の既定は ack の次）。`overflow` は `{ id, reason: 'record' | 'line' }`（記録から落ちた分・長すぎて捨てた行）。`detach` は `{ id? }`（id 無しは全部）。`mark` の位置の既定は次の行。**世代 = 規約の版**で、`connectHolder({ generation })` が世代ごとに別のパイプ・別のファイルへつなぐ（`[H-1, H]` の 2 世代の保持役は並んで動く）。design.md の「子が 1 つも無く」は「生きている子が 1 つも無く」にした（終わった子の記録は idle の終了で消える）
- **子の stdout は常に読み、親へはカーソルで流す**: 親が読まなければ、書きかけが 4 MB（`highWaterBytes`）を超えた時点で止まり、`drain` で記録から続きを送る（保持役のメモリは記録の上限で止まる）。試験は 3 MB を出す子と、まったく読まない親・一度もつながらない間の 2 MB で、子が詰まらず終わることを見る。記録の上限は子ごとに 32 MB（`maxRecordBytes`）で、超えたら古い行から捨てて `truncated`（`first` が進む。付け直した親には `overflow { reason: 'record', first }`）。子の 1 行の上限は 16 MB（超えた行は捨てて `overflow { reason: 'line' }`）、パイプの 1 行は 64 MB
- **記録の捨て方**: 印（`mark`）と ack の小さい方より前を捨てる（印も ack も無ければ捨てない）。`ack` は戻らず、受け取った行数を越えない。`unmark` で印を外すと ack の次まで捨てる
- **控え**: `claude-control` は `control_request` を `request_id` で控え、`control_response`（親の `write`）か `control_cancel_request`（子）で消す。付け直しで渡し直すのは **`attach` の `from` より前にある `mcp_message` と `elicitation` だけ**（stdio の MCP が出す `elicitation` は `initialize` の応答の控えに入らず CLI が再送しないので、`mcp_message` と同じく要る【2-0】。`can_use_tool` は CLI が `pending_permission_requests` で返し、`hook_callback` は CLI が自分で取り消すので控えない。`from` 以降は記録の再生で届くので重ねて渡さない。`redelivered: true` の `out`。通番の順で、生の出力の続きより前）。`jsonrpc` は `id` と `method` を持つ依頼を控え（key は `JSON.stringify(id)`）、`id` を持つ応答で消す。いずれも保持役は `id` を付け替えない
- **答え済みの `control_request` を流し直さない責任は、サーバー（2b-6 の再生）にある**（2026-10-06 に決めた）。保持役は答え済み・取り消し済みの依頼を**控えから外す**ので、渡し直しには出ない（`mcp_message`・`elicitation`）。一方、記録の行そのもの（`out`・`replay`）は通番が連続する生の行で、保持役は書き換えも飛ばしもしない（ack は uuid の無い制御の行も数えるので、飛ばすと通番が欠ける。保持役はエージェントのプロトコルを解釈しない）。**再生で作る側（サーバー）は、`control_request` の行を SDK の `query` に流さず、状態を組み立てるためだけに読む**。流してよいのは、付け直しの `attached` の `pendingRequests`（答えを待っている依頼）に `requestId` が残っているものだけで、それは `redelivered` の `out` で届く。`attach` の `from`（ack の次）以降に答え済みの依頼が混ざりうるのは、ack が答えより前に止まっているとき（旧サーバーが依頼の行を処理し終えた直後に ack し、答えは後から返した）だけ。サーバーは `attached` の時点の `pendingRequests` に無い `requestId` の `control_request`（`seq` が `attached` の `seq` 以下）を捨て、通番は ack に数える
- **`detach` の後**: その親からの `write`・`end`・`kill`・`ack`・`mark` などは無視され、その親へ `out` も流れない。答え（`detached`）が来た時点で転送は止まっている。**旧サーバーは `detached` を待ってから SDK の `query` を閉じる**。親の `write` は**行になった分だけ**子へ渡し、行の途中で親が切れたら（`detach` でも）捨てる。親が切れても子の stdin は閉じない
- **起こし方**: `launchHolder`（段階 1 と同じ `detached: true`・`stdio: 'ignore'`・`windowsHide: true`。`mode: 'auto'` は `desktop/job.cjs` の `inspectJob`・`decideLaunch` で分け、`breakaway` なら `launchBreakaway`。**抜け道の無い Job は `HOLDER_UNSUPPORTED`**。呼び出し側は保持役を使わない今の流れに落とす）。起こした保持役の環境変数は `PLEIAD_HOLDER_DATA`・`PLEIAD_HOLDER_ROOT`・`PLEIAD_HOLDER_KEY`・`PLEIAD_HOLDER_APP_VERSION`・`PLEIAD_HOLDER_IDLE_MS`（`AGENT_HOST_TOKEN`・`ELECTRON_RUN_AS_NODE` は外す）。**二重起動の防止**: Windows の名前付きパイプは最初のインスタンスしか作れない（libuv。本物のパイプで確かめた）ので、後から立てた保持役は `HOLDER_RUNNING` で、何も書かずに終わる。unix ソケットは、つながるかを先に確かめる
- **2-0 が挙げた 2a の点の確認**（2026-10-06）: 控えの `elicitation`・記録の上限（`truncated`）・ack と印より前を捨てる・答え済みの `control_request` を控えから外す、は実装済みで試験にある。**足していない 2 つ**: (1) 行を JSON で包み直さずに送る形（長さを前に付けた生の行など）は、規約 v1 の `framing: 'lines'` の枠（`spawn` の `framing`。今は `lines` 以外を `invalid` にしている）に別の値を足す形で、規約を変える段で入れる（20 MB の本文で約 2 倍・保持役 190〜460 MB。5 MB で +0.1〜0.3 秒なので、2b・2c の配線の後に実測して要るか決める）。(2) `.cmd` を包みの `bin/claude.exe` に解す処理は、保持役ではなく **2c のサーバー側**（`spawn` に渡す `command` を決める所）に置く。保持役は `command` と `args` を何も解釈せず `shell: false` で起こすので（`.cmd` は Windows の `spawn` が `EINVAL`）、どの CLI の包みかを知っているのはサーバー（`core/cli-installation.mjs` の `cliCommand`）だから
- **ログ**: `logs\holder.log`（`core/server-log.mjs` の書き手。1 MB で `.old`）。子はコマンドのファイル名・pid・policy・終了コードだけを書き、**引数・env・札・秘密は書かない**
- **2b・2c が使うときの注意**: (1) `ensureHolder({ dataDir, root, key, appVersion })`（`key` はサーバーの `AGENT_HOST_RUNTIME_KEY`）が「居れば付ける・居なければ起こす」。戻り値の `client.welcome.children` が付け直しの材料（札・通番・ack・印・控え・`stderr` の末尾）。`HolderClient` の `attach`・`detach`・`replay` は答えを待ち、`requestTimeoutMs`（10 秒）で `HOLDER_TIMEOUT`。(2) `spawn` / `attach` は SDK の最初の stdin の書き込みより前に送る。同じ接続の中の順序は保たれ、答えを待たずに `write` してよい。起こせなかったコマンドは `exit { error: 'ENOENT' }` で届く。(3) ターンの印は `mark(id, name)` をそのターンの最初の `write` より前に送る（位置は次の行）。再生に使う範囲は `replay(id, markSeq, acked)`。**落ちた分があれば `truncated`**（表示の途中の状態をあきらめる。§4.5 の 5）。(4) `ack` は、サーバーがアプリのループで処理し終えた最後の通番にする（SDK の stdout へ流した位置にしない）。(5) 保持役は `PLEIAD_HOLDER_KEY` があれば `run\<版>-<pid>.lock.db` を持つので、**保持役が走っている版の実行場所は掃除されない**。新しい版のサーバーは、世代が同じ保持役をそのまま使うので、保持役は古い版の `core/holder/` で走り続ける（design.md §4.3）。(6) 子の env は `spawn` に全部渡す（保持役は自分の環境を渡さない。`env` を省くと保持役の環境）。秘密はメモリだけ・ログには書かない。(7) Windows の保持役の子は libuv の Job に入るので、保持役が落ちれば子も止まる【Node の仕様。この試験では「保持役の `close` と `shutdown` で子が止まる」までを確かめた】。(8) 親の接続は常に 1 つ（後から合格した方が勝ち、古い方は `bye 'replaced'` で切られて以後何も書けない）。引き継ぎでは、旧サーバーが `detach` した後に新サーバーが `hello` する順にすれば、取り合いにならない。(9) idle で終わった保持役の「終わった子の記録」は消える。`release` は、終わりの記録（`exit`・使用量・完了通知）を処理し終えた後に呼ぶ

### 2b サーバーの「始める」と「動かす」を分ける（L〜XL。一番大きい）

- 最初に、`core/server.mjs` のモジュールの外の変数と `runtime` の全部を、「保存済み／札へ入れる／再生で作る／捨ててよい」に仕分けた表を作る（R8）
- `runTurnInternal` を、準備・起動と、出来事を受けて `endTurn` で締める部分に分ける。後者を付け直しからも呼ぶ
- バックエンドに `adoptTurn`（札と記録の再生から、走っているターンの制御を作る）。まず fake のバックエンド（`core/backends/fake.mjs`）で作り、テストの台本で「途中で引き継ぐ」を書けるようにする
- 起動時の後片付けとぶつかる所（design.md §5.4）を、付け直すターンで外す
- 実行中のスナップショットを再生で作る（再生は uuid で冪等。ack は「アプリのループで処理し終えた最後の行」）

**仕分けの表・切り目・段（2026-10-06。案）**: [stage2-server-state.md](stage2-server-state.md)。表は 144 行（保存済み 17・札 45・再生 20・捨てる 62）。危ない所（§3）の上位は、Claude の SDK の `Query` に乗るコールバック（2c の作り直しで、hooks の登録を前と同じにする材料を札に置く）・委譲の子を待つ `agentTasks` の `execute` の鎖（後半を付け直しから呼ぶ）・5 か所に散った途中送信の「渡った」合図の控え。起動時の後片付けで外す所は 15 か所、旧サーバーで止める所は 6 か所（§5。design.md §5.4 の 4 項目に足した）。2b は次の段に分ける（順序 **2b-1 → (2b-2 ‖ 2b-3) → 2b-4 → [2a] → 2b-5 → 2b-6 → 2b-7**。2b-1〜2b-4 は保持役が無くても単独で取り込め、挙動を変えない）:

| 段 | 中身 | 規模 |
|---|---|---|
| 2b-1 | `runTurnInternal` を `prepareTurn`・`beginTurn`・`launchTurn`・`driveTurn`（出来事を受けて `endTurn` で締める）・`releaseTurn` に分ける。閉包の値を `ctx` に移す。`endTurn` に 1 回だけの印 | M |
| 2b-2 | 札の形（`core/turn-card.mjs`。純関数・版 `v: 1`・秘密の分離・途中送信の枠組み・上限 64 KB）。**実装済み 2026-10-06**（要点は [stage2-server-state.md](stage2-server-state.md) の「2b-2 の実装のメモ」） | S |
| 2b-3 | 会話の MCP の口（ply_agents・ply_computer・ply_browser・ply_control・ply_context）を同じトークンで開き直す `open({ token })`。**実装済み 2026-10-06**（トークンの検査は `core/mcp-token.mjs`、`server.mjs` に `restoreConnection(entry)`。まだ呼ばない。要点と 2b-4 への注意は [stage2-server-state.md](stage2-server-state.md) の「2b-3 の実装のメモ」） | S |
| 2b-4 | 付け直しの入口 `adoptTurn(card, source)`・`makeEmit` の再生の道・起動の順序と後片付けの除外・`backend.adoptTurn` の口。元は既定で空。テストは「終わっていたターン」の札と記録から。**実装済み 2026-10-07**（`core/server.mjs` の `restoreTurn`（後片付けより前に登録）・`adoptTurn`（待ち受けの後に口を同じトークンで開き直し、`driveTurn` で締める）・旧サーバーの口 `handOffTurn`（締めない・流さない）、再生の道と付け直す元の形 `core/adopt.mjs`、fake の `adoptTurn`。付け直せないものは今の restart の中断に落ちる。発言の本文は札に入れずハッシュにした。承認の id は 2b-6。要点と 2b-5 以降への注意は [stage2-server-state.md](stage2-server-state.md) の「2b-4 の実装のメモ」） | M |
| 2b-5 | fake の `adoptTurn`（台本を別プロセスの偽の CLI で走らせ、保持役の子に載せる） | M |
| 2b-6 | スナップショットと承認を再生で作る（ack・uuid の冪等・承認のカードの id を決まった値に・中断の送り直し・ポートが取れないとき） | M |
| 2b-7 | 途中送信と委譲の付け直し（`liveNotices`・`liveInstructions`・`agentTasks` の `steers`、`execute` の後半を `agentTasks.adopt` で） | M |

- テストは fake の「途中で引き継ぐ」台本（準備中・承認待ち・ツールの実行中・渡った合図の前・裏の作業の待ち・委譲の子・中断の最中・終わった直後）で、`turnEnd`・`completedAt`・使用量・完了の知らせが 1 回だけであることを数える（stage2-server-state.md §6.1）。2d の前はサーバー A を強制終了して B を起こす形（2e と同じ）で引き継ぐ
- bot の会話・圧縮のターンは 2b では付け直さない（先送りか中断）

### 2c Claude を保持役に載せる（M〜L）

- `spawnClaudeCodeProcess` で保持役へ。偽の `SpawnedProcess`（`write`・`end`・`kill` を保持役に写し、`detach` の後は転送しない）。**`spawn` / `attach` は SDK の最初の stdin の書き込みより前に送る**
- 付け直し: 同じ CLI に `query` を作り直す（空の入力の流れ）。旧サーバーが手を離す順序は「保持役に `detach` → `query` を閉じる」。途中送信の控え（`pendingSteers`）・裏の作業の追跡（`claude-background.mjs`。生きている作業の一覧は付け直し直後の `background_tasks_changed` で置き換える）・費用の基準（`readCostBase`）・フラグ設定のファイル（`writeClaudeFlagSettings`。ターンの終わりに消す。`detach` の後は旧サーバーが消さず、新しいサーバーの起動時の掃除は札が指すファイルを外す）の札。systemPrompt・skills は札に要らない（CLI が 2 回目の `initialize` の値を使わない。2-0）
- **`host` MCP は in-process のまま**（HTTP に移さない）。引き継ぎは、走っている hooks のコールバックと `mcp_message` のハンドラーが終わるのを（上限つきで）待つ
- 付け直しに使える CLI の版の一覧を別に持つ（`backend-shape-diagnostics.mjs` の `VERIFIED` とは分ける。確かめたのは 2.1.284・2.1.288、`pending_permission_requests` は 2.1.268 から）。外れる版のターンは保持役に載せない
- テスト: fake の CLI（stream-json を話す偽物）で、承認待ち・hooks・`mcp_message` の最中の付け直し。実機は `scripts/zero-downtime/claude/` の本物の CLI

### 2d 引き継ぎ（M）

- 旧サーバー: 開始を止める・短い処理と処理中の HTTP の MCP と hooks・`mcp_message`・外部の stdio MCP の呼び出しを待つ・タイマーを止める・`flushNow`・`detach`・ロックを放す
- 新サーバー（R15）: 外部の stdio MCP は札の束縛から起こし直す（ツールの名前は同じになる。状態は消えるので、起こし直した後の最初の結果にその旨を添える）
- 新サーバー: `acquireDataLock` の待ち（数十 ms 刻み）、預かり物（トークン・ポート）、MCP の束縛を札から戻す、**HTTP の口を待ち受けてから**付け直す・新しい作業を始める、付け直し
- モジュールを先に読み込んでロックを待つ起動（`--handover`）。間の目安を測り直す
- 戻し道（design.md §6 の表）: 前の版のサーバーで付け直す、1 つのターンだけの中断、`AGENT_HOST_HANDOVER=off`
- 段階 1 の先送りの制御（`desktop/switch.cjs`）を、保持役に載るターンは先送りせず引き継ぐ形に拡張する

### 2e サーバーが落ちたときの付け直し（S）

- main がサーバーの切断（`main-leaving` 無し）を見たら、同じ版で起動し直して付け直す。今の「サーバーが終了しました」の致命的なダイアログ（`main.cjs` の `worker.once('exit')`）は、起動し直しにも失敗したときだけ

**実装済み（2026-10-06）**

- **流れ**（`desktop/main.cjs` の `onServerExit`。名前付きパイプの経路だけ。`AGENT_HOST_HANDOVER=off` の `utilityProcess` は今のまま）: つながりが切れたら、(1) `bye 'replaced'` なら静かに終わる（今のまま）、(2) `bye 'closing'` 以外ならまず今の `reattachServer`（サーバーは居てつながりだけ切れた場合。数回・約 1 秒）、(3) 居なければ `desktop/server-restart.cjs` の `restart()` で起こし直し、起こせたら窓を **1 回だけ**読み直す（起こし直したサーバーの `ready` のポート・トークン。同じポートが取れなければ origin が変わる。切り替えの S2 と同じ `reloadWindow`）。切り替えの `once('exit')` の見張りも付け直す。(4) 起こし直しに失敗した・続けて落ちて断られたときだけ致命的なダイアログ（`server.restartFailed`。起こし直しを試みなかった `closing` などは今の `server.exited`）
- **起こし直さない場合**: 切り替えが S1 を手放している間（`serverSwitch.replacing`）、`main-leaving` を送った後（更新で離れる途中。`main-leaving-cancel` で取りやめれば、また起こし直す）、`bye 'closing'`（サーバー自身が終わる）、main が終わる途中（`quitting`・`app.exit`）。起こし直している間に終了が始まったら、起こしたサーバーに `shutdown` を送って終わらせ、窓は読み直さない
- **起こす版・env**: 落ちたサーバーの最後の `ready` の `runtimeKey` の版が実行場所（`runtime.locate`）に残っていればその版、無ければこの main の版（`chooseServer` の `prepared`）。env は切り替えの S2 と同じ `serverEnv` で、**同じトークン・同じポート**（`ready` の値）。落ちたサーバーが残した `main-link.json`・`control.json` は、起こしたプロセスの pid と合うものだけを見る `startAndConnect` が無視する（データ置き場のロックは OS がプロセスの終了で外している）。`ready` を待ってから返す。起こしかけて立たなかったプロセスは止める
- **続けて落ちるとき**: 1 分（`CRASH_WINDOW_MS`）の間に 3 回（`MAX_CRASHES`）落ちたら、3 回目は起こし直さずダイアログ（立ち上がってすぐ落ち続けるサーバーを回し続けない）。窓の外に出た古い落ちは数えない。起こし直しの失敗も 1 回に数える
- **保持役との関係（今）**: 保持役（2a）はまだターンに載っていないので、**落ちたサーバーのターンは中断として残る**（起動時の `restart` の回復のまま。起こし直したサーバーの起動で `interrupted: { reason: 'restart' }` になり、「再開」で続けられる）。落ちて起こし直すだけで、走っていたターンが続くわけではない
- **2b 以降の口**: `createServerRestarter` の `afterRestart(ready)`（起こし直して `ready` が届いた後。窓の読み直しより前）。保持役に載ったターンが付け直される段階（2b の `adoptTurn`・2c）では、新しいサーバーが起動で保持役へ付け直す（2d の引き継ぎと同じ入口）ので、main からは何も足さなくてよい見込み。足す必要が出たらここへ（`main.cjs` は今は渡していない）。そのとき、起動時の後片付け（ターンを `restart` の中断にする所）は、保持役が持つターンを外す（design.md §5.4）
- **残る課題**: 落ちたサーバーの子（Claude の CLI など。保持役に載る前のもの）は main の子でも保持役の子でもなく、サーバーが落ちても残りうる。今は起動時の孤児の掃除に任せる。サーバーが落ちた理由は `logs\server.log` に残る（ダイアログには出さない）
- テスト: `tests/unit/desktop-server-restart.mjs`（起こす版・同じトークン/ポート・起こせない・続けて落ちる・同時・`afterRestart`・**本物のサーバーを強制終了して同じトークン・ポートで起こし直す**）、`tests/unit/desktop-boot.mjs`（main の流れ: 起こし直し・窓 1 回・次の落ちも見張る・ポートが変わる・断られたらダイアログ・起こさない場合）。実機（`desktop:pack` の resources・本物の electron・fake。[dev-verification.md](../dev-verification.md)）: サーバーの強制終了 2 回は同じ origin・トークンで起こし直され窓は各 1 回だけ読み直し（約 1.8 秒）、3 回目は起こし直さずダイアログ（14 / 14）

**段階 2 の完了の条件**: 承認待ち・ツールの実行中・途中送信の直後・裏の作業の待ち・委譲の子が走っている、のそれぞれで Claude のターンを走らせたまま core の違う版へ更新し、ターンが中断されずに続き、承認に答えられ、終わりの記録（完了通知・使用量・`completedAt`）が 1 回だけ残る。引き継ぎの間に当たった HTTP の MCP の呼び出しの失敗を数えて記録する（段階 4 を足すかの根拠）。

---

## 段階 3: Codex・agy・`!` の行（M〜L）

- Codex（M）: 共有の app-server を保持役の子に（`policy: 'jsonrpc'`）。`CodexRpc` の付け直しの始まり方（`initialize` を送らない。送って `Already initialized` を成功とみなしてもよい）。**新しいサーバーの JSON-RPC の id を世代つきの文字列にし、古い世代の応答は捨てる**。スレッドごとの印（ターンの始まり）と再生。サブエージェントの親子は `thread/read` の `parentThreadId` から引き直す。バックグラウンドの端末（`codex-background.mjs`）。**`thread/start` は HTTP の口が立ってから**（口が閉じていると `required: true` で失敗、`false` なら MCP を持たないスレッドになる）
- agy（M）: 会話ごとのプロセスを保持役の子に（`policy: 'none'`）。ターンの印を最初の行に付ける。孤児の掃除と終了時の片付けから外す。`core/agy-context-relay.mjs` に数秒の再試行を足す（段階 0 では動かしていないので、足すときに口を閉じて確かめる）
- `!` の行（S）: `shell-runs.mjs` のシェルを保持役の子に
- 先送りが要らなくなる（保持役に載っていないターンは、古い CLI の版のものだけ）
- 段階 3 の最初に、サブエージェントが走っている Codex の付け直し・承認を数分待たせたとき・本物のモデルでの付け直しを測る（stage0-codex-agy の未確認）

## 段階 4: 待ち受けを保持役が持つ（M。段階 2 の実機の結果しだい）

- 保持役が待ち受けのポート（画面・MCP の口）を持ち、届いた接続をそのときのサーバーへ渡す（L4 の中継）。サーバーが居ない間は接続を待たせる（上限つき。Claude は接続を受けて応答を止めると 30 秒まで待って成功する【実測】）
- 保持役の薄さが崩れる（HTTP は話さないが、ソケットを持つ）。**要るかは段階 2 の実機で決める**: 引き継ぎの間（1〜1.6 秒。モジュールを先に読めば 0.8〜1.1 秒の見込み）に当たった Claude・agy の HTTP の MCP の呼び出しの失敗が、実際の更新で利用者に見える形（ターンが止まる・やり直しが続く）で出たとき。Codex は約 2 秒まで透過に再試行するので対象外

## 段階 5: Electron を再起動しない core だけの更新（任意。L + 署名の設計）

- リリースが `desktop/` と Electron の版を変えないとき、`core`・`web`・`bin` だけの包みを配り、実行場所へ展開して引き継ぐ。main は止めない（内蔵ブラウザー・computer use も切れない）。NSIS の入れ替えは、次に Pleiad を起動し直すときまで先送り
- 包みの署名と検証（今は NSIS のインストーラーの Authenticode だけで確かめている）。アプリに埋め込む公開鍵・鍵の管理・段階配信との組み合わせを、別の ADR で決める

---

## リスク

| # | リスク | 起きたら | 抑え方・段階 0 の結果 |
|---|---|---|---|
| R1 | Claude の再 initialize は「会話に加わるクライアント」向けの口で、stdio を保持役が中継する使い方は公式の想定と完全には同じでない。CLI・SDK の更新で振る舞いが変わる | 付け直しで承認が届かない・hooks が効かない | **2.1.284・2.1.288 で通った**（承認・hooks・in-process MCP）。付け直しを確かめた CLI の版だけを載せる（2c の一覧）。外れたら先送り・中断して更新に落ちる。リリースごとの外部エージェントの版の見直し（`docs/desktop-releases.md`「リリース手順」）に、付け直しの確認を足す |
| R2 | `server.mjs` の分解（始める／動かす）で、ターンの締め（`endTurn`）が走らない・2 回走る | 実行中のまま残る・完了通知が 2 回 | fake のバックエンドで「途中で引き継ぐ」の台本を全部の段階（準備中・承認待ち・途中送信・終わった直後）で書く。付け直したターンにも今の上限（承認の時間切れなど）を掛ける |
| R3 | Windows のプロセスの寿命（Job・Defender・NSIS の名前での停止） | 更新で CLI か保持役が止まる | **detached + `stdio: 'ignore'` で NSIS をまたいで生き残った**。起動時に Job の制限を調べて分岐（1-4。実環境は `BREAKAWAY_OK` だけの Job で、detached 起動で通る【1-0 b】）。`detached` でない子は引き継ぎで止まる（洗い出した結果、段階 1 で直すものは無い【1-0 f】）。実行ファイルの名前を `Ply.exe` にしない。`$INSTDIR` の前方一致を避ける |
| R4 | 保持役は「コマンドを起動する口」で、秘密（トークン）が通る | 同じ PC の別の利用者・別のプロセスが使う | パイプの名前に利用者の SID、`hello` の秘密が合うまで何も送らない、相手のプロセスの利用者を確かめる。記録に秘密を書かない |
| R5 | ディスクと、写しの時間（4,000 ファイル・Defender の検査） | 容量の苦情・起動が遅い | **約 107 MB（最初に約 120 MB）・2 版目は +0.7〜3.5 MB**。ハードリンクで共有し、再起動の速さにも効く。ハッシュと写しは同じ読みで 16 並列。古いサーバーが動いている間に裏で行い、引き継ぎはその後 |
| R6 | 版の組み合わせ（main・サーバー・保持役の規約・引き継ぎの形式）が増える | 組み合わせの穴で付け直せない | どれも「1 版ぶん後ろまで」だけを約束し、外れたら戻し道。事前の確かめで止める前に分かるようにする。握手の最小の部分は固定 |
| R7 | 2 つの更新の道（引き継ぎ・中断して更新）を保ち続ける手間 | 使われない道が腐る | 中断して更新は終了（中断して終了）と同じ部品なので消えない。`AGENT_HOST_HANDOVER=off` でテストを流す（開発の既定の経路でもある） |
| R8 | メモリにだけある状態の見落とし（委譲の完了通知の配達中・送信の途中・screencast・通知の重複） | 引き継ぎで何かが 1 回欠ける・2 回出る | 2b の始めに、`server.mjs` のモジュールの外の変数と `runtime` の全部を、「保存済み／札へ入れる／再生で作る／捨ててよい」に仕分けた表を作る |
| R9 | 引き継ぎの間の記録の溜まり（部分の出力が多いターン） | 保持役のメモリが膨らむ | 記録の上限（`truncated`）。印より前は捨てる。保持役は常に読む（読まないと約 240 KB で CLI が止まる） |
| R10 | macOS は対象の外 | 同じ機能が無い | Windows で固めてから。macOS は今の「中断して更新」のまま |
| R11 | 引き継ぎの間の HTTP の MCP の呼び出し。Claude と agy は即失敗、Codex は約 2 秒を超えると失敗。不通中に始めた Codex のスレッドは MCP を持たない | 呼び出し 1 回の失敗・MCP の無い会話 | 旧サーバーは処理中の呼び出しを待ってから口を閉じる。新しいサーバーは口を立ててからスレッド・ターンを始める。不通を 2 秒以内に。足りなければ段階 4 |
| R12 | 書いたばかりのファイルの最初の読みが遅い（Defender）。新しく写した直後の起動は 3.5〜6.1 秒 | 引き継ぎの断が伸びる | ハードリンクで、読み終えたファイルを共有する。「組む→起こす」の順。逐次で書かない |
| R13 | main が居ない間（本物のインストーラーで 55〜70 秒）の機能の欠け（computer use の停止・内蔵ブラウザーのタブ・通知・スリープ抑止） | 一度切れる | 利用者の承認済みの受け入れ。機能ごとの扱いを 1-5 に。長ければ `SetThreadExecutionState` |
| R14 | 取り込む公式の Node の版と Electron の Node の差・arm64 | ネイティブの読み込みの失敗 | 同じメジャー版。**1-0 の a: x64 は Node 24.21.0 で node-pty・`npm test` とも通った**。arm64 は prebuild と公式の `node.exe` が arm64 で N-API であることまで確認し、動かしていない（実機 16）。Node の取得は SHA-256 で固定 |
| R15 | 外部の stdio MCP（利用者が設定した `node_repl`・`python` などの MCP）は、サーバーの直の子として起こされる（`core/context-bridge.mjs`。detached でない） | 段階 2 の引き継ぎで、走っているターンの外部 MCP が止まり、状態を持つ MCP の状態が消える | 段階 1 は切り替えがターンの 0 件のときだけで影響なし。段階 2 の 2-0・2b で、起こし直す（状態の消失をツールのエラーで返す）か、保持役の子にするかを決める。1-0 f で、サーバーの子の一覧と実験（直の子は必ず死に、孫は起こし方で決まる）を取った |

---

## 実機で確かめる項目

署名した旧版 → 新版の更新で行う（未署名のパッケージは代わりにならない。`docs/desktop-releases.md`「リリース判定」）。「段階」は、その項目が通るべくなる段階。

| # | 項目 | 段階 |
|---|---|---|
| 1 | 走っている Claude（`claude.exe` と npm の `claude.cmd` の両方）・Codex・agy のターンが、`quitAndInstall` → NSIS → 新版の起動の間も進み、中断の印が付かない | 1 |
| 2 | 承認待ちのまま更新し、新しい版の画面とスマホの両方に承認が 1 つだけ出て、答えるとターンが進む | 1 |
| 3 | 更新の間（本物で 55〜70 秒）に、スマホから承認・送信ができる | 1 |
| 4 | 先送りの間、窓に待ちの件数が出て、作業が終わると新しいサーバーに切り替わり、画面が読み直されて下書きが残る。「今すぐ中断して切り替える」が効く | 1 |
| 5 | computer use の操作中に更新すると、オーバーレイが消える前に操作が止まり、エージェントに伝わる。新しい main が付け直した後、承認からやり直せる | 1 |
| 6 | 内蔵ブラウザーで `agent-browser` を使っている会話を更新すると、新しい main がタブを開き直し、次の `agent-browser` の呼び出しが通る | 1 |
| 7 | 実行場所に古い版が残り、使っているシェルが無くなった後の起動で掃除される。`$INSTDIR` が `%LOCALAPPDATA%\agent-host-runtime` の前方一致になる場所のとき、別の場所へ移る | 1 |
| 8 | 形式番号を変える版への更新で、今の「中断して更新」のダイアログが出て、「あとで」では切り替わらない | 1 |
| 9 | 新しいサーバーが立たない版（わざと壊した評価用ビルド）への更新で、前の版のサーバーで動き続け、その旨が出る | 1 |
| 10 | main をタスクマネージャーで止めても、サーバーとターンが残り、起動し直した main が付け直す。アンインストールしても止められず、作業が 0 件で 30 分たつと終わる | 1 |
| 11 | 保持役を止める（タスクマネージャー）と、走っていたターンが `restart` の中断として残り、「再開」で続けられる | 2 |
| 12 | サーバーだけを止めると、main が起動し直し、ターンが続く | 2 |
| 13 | 承認待ち・ツールの実行中・途中送信・裏の作業・委譲の子が走っているときの core の切り替えで、ターンが続き、終わりの記録が 1 回だけ残る | 2 |
| 14 | 引き継ぎの間に MCP（`ply_task_wait`・`ply_delegate`・`set_status`）を呼んでいるターンが、失敗しても止まらない。失敗の数を記録する | 2 |
| 15 | 全ユーザー向けのインストール（`Program Files`）でも 1〜14 が同じ | 1〜 |
| 16 | Windows ARM64 | 1〜 |
