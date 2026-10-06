# 無停止の更新 — 段階に分けた実装計画

- 状態: 確定（2026-10-06）。段階 0 は完了し、その実測で段階 1 以降を直した
- 設計: [design.md](design.md)。決定: [ADR 0137](../adr/0137-zero-downtime-update.md)。実測の記録: [stage0-claude.md](stage0-claude.md)・[stage0-codex-agy.md](stage0-codex-agy.md)・[stage0-runtime.md](stage0-runtime.md)・[stage1-0.md](stage1-0.md)（段階 1 の 1-0）。管理: [issue #54](https://github.com/tekalu1/pleiad/issues/54)
- 規模の目安: S = 2 日まで、M = 3〜5 日、L = 1〜2 週、XL = 3 週以上（1 人。テストと文書を含む）。段階 0 の前の見積もりを、実測で分かったことに合わせて見直した（下の表）

## 全体

| 段階 | 中身 | 利用者に見える価値 | 規模（段階 0 の前 → 後） |
|---|---|---|---|
| 0 | 実測 | なし | M → **完了** |
| 1 | 実行場所を `$INSTDIR` の外へ。サーバーを main から切り離す。新しい main が古いサーバーに付け直す。サーバーの切り替えは作業が終わるまで先送り | **更新を押しても作業が止まらない**（core の切り替えは作業が終わってから。design.md §6.1） | L（2〜3 週）→ **L〜XL（4〜5 週）** |
| 2 | 保持役 + Claude。引き継ぎ。付け直し（再生） | **Claude の作業は core の切り替えでも止まらない**。サーバーが落ちても Claude の作業が続く | XL（4〜6 週）→ XL（4〜6 週。増減が相殺） |
| 3 | Codex・agy・`!` の行を保持役へ | 全部のバックエンドで止まらない。先送りが要らなくなる | L（2〜3 週）→ **M〜L（2 週前後）** |
| 4 | （測って要れば）待ち受けを保持役が持つ | 引き継ぎの 1 秒前後の間の MCP の呼び出しも落ちない | M（段階 2 の実機の数え方しだい） |
| 5 | （任意）Electron を再起動しない core だけの更新 | 内蔵ブラウザー・computer use も切れない。更新が数秒で終わる | L + 署名の設計 |

見直しの理由:

- **段階 1 が増えた**: 実行場所の組み立てを「ハードリンク + 同じ読みで 16 並列のハッシュと写し」にする（Defender の遅い最初の読みを避ける）、起動時に main の Job を調べて分岐する、サーバーが起こす `detached` でない子（引き継ぎで止まる）の洗い出し、起動の失敗の理由を出すサーバーのログ、main との口がバイナリー（computer use の画面の写真）を運ぶ符号化、main が居ない間の機能ごとの扱いと内蔵ブラウザーの中継の一覧、切り替えの待ちの表示（モックの承認が要る）。いずれも下書きの段階 1 に無かった
- **段階 2 は増減が相殺する**: 減った — `host` MCP を HTTP に移さない、保持役が JSON-RPC の id を付け替えない・`initialize` の答えを作らない。増えた — `detach` が済んでから SDK の `query` を閉じる順序、走っている hooks・`mcp_message` のハンドラーを待つ引き継ぎ、再生の uuid の冪等、未測定の Claude の場面（サブエージェント・裏のコマンド・途中送信・圧縮）の測定
- **段階 3 が減った**: Codex は付け直しに握手が要らず（`initialize` を送らない）、id の付け替えも要らない。agy も握手が要らない

**最初に価値が出るのは段階 1**。段階 1 だけで「更新を押しても作業が止まらない」は成り立つ（core の切り替えが作業の終わりまで先送りになるだけ。ADR 0137 で、ADR 0036 の「終わったら更新する」予約とは別のものとして承認済み）。ただし、委譲・bot・ルーティンで作業が絶えない使い方では新しい core がなかなか当たらないので、段階 1 は目的ではなく踏み台で、段階 2・3 までで目的に届く。段階 1 の先送りは、段階 3 の後も戻し道として残る。

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

- **途中の merge は機能を有効にしない**。環境変数 `AGENT_HOST_HANDOVER` で切り替える（`on` = 実行場所 + 名前付きパイプ + 先送り、`off` = 今の `utilityProcess`）。段階 1 の途中は既定を `off` にし、1-7 の最後の項目で、パッケージ版の既定を `on` にする。`off` の経路（今の形）は、開発（`npm run desktop`）と、合わない更新の戻し道（design.md §6）として残り、テストを流し続ける（R7）
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

### 1-2 名前付きパイプの口（M）

運ぶメッセージの型は今の parentPort のもの（design.md §7.1）。

- core 側 `core/main-link.mjs`: パイプ（`\\.\pipe\pleiad-main-<データ置き場のハッシュ>`）を作って待ち受け、`hello { ipc: [min, max], appVersion, secret }` が合った接続だけを `mainPort` につなぐ。`secret` は起動時に作り、データ置き場の権限 0600 のファイル（`control.json` と同じ置き方。`core/atomic-file.mjs`）に書く。パイプの名前と `ipc` の範囲は `control.json` に足す（`CONTROL_VERSION` は上げず、足すだけ。読む側は無いキーを許す）
- **符号化**: 1 行 1 JSON。`Uint8Array` / `Buffer`（`computer-result` の画面の写真）は `{ "$bin": "<base64>" }` に包み、受ける側で戻す。1 行の大きさの上限（既定 16 MB）を決め、超えたら落とす。写真が増やす量（約 4/3 倍）で computer use の往復が許容の時間に収まることを確かめる
- main 側 `desktop/server-link.cjs`: パイプにつなぎ、`worker`（`on('message')`・`off`・`once('exit')`・`postMessage`・`kill`）と同じ形の包みを返す。**切断を `exit` として知らせる**（`computer/service.cjs` の `releaseAll`・`computer-overlay.cjs` の `hideAll` が `once('exit')` で後始末するため）。`desktop/*-bridge.cjs`・`computer/service.cjs`・`resident.cjs` は変えない（`worker.on('message')` と `worker.postMessage` だけを使う）
- 接続が切れたあいだ、サーバーから main へ送るものは、機能ごとの扱い（1-5）に任せる。口の層は溜めずに捨てる（送れなかったことを呼び出し側に返す）
- 握手の最小の部分（版を聞く・引き継ぎを頼む・終わらせる）は、版をまたいで形を変えない。ここで形を決めて固定する（`ipc` の版 1）
- テスト: `tests/unit/main-link.mjs`（符号化の往復・バイナリー・1 行の上限・行の途中で切れた入力・`secret` の不一致で何も返さず切る・`ipc` の範囲の外・切断と再接続）。本物のパイプで 2 つのプロセスを立てる

### 1-3 実行場所（M）

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

### 1-4 main がサーバーを起こす・見つける・付け直す（M）

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
- テスト: `tests/unit/desktop-boot.mjs`（vm で `main.cjs` を評価する既存の作り。`desktop-exit-dialog.mjs` と同じ）に、サーバーの選び方（無い・生きている・古い制御ファイル・`ipc` の範囲の外）と Job の分岐の純関数のテストを足す。選び方と Job の判定は `desktop/` の純関数に切り出す

### 1-5 main が居ない間の機能ごとの扱い（M〜L）

design.md §7.2 の表のとおり。サーバー側が「main に頼むもの」を、main が居ない間は機能ごとに扱う。口の層（1-2）は捨てるだけなので、ここで決める。

- **secret**（`core/secret-store.mjs`）: 復号の依頼は main が戻るまで待たせる（上限 5 分。超えたら失敗）。復号した値はメモリに持ち続け、同じ秘密は 2 回目から main に頼まない。暗号化の依頼も同じ待ち
- **computer use**（`core/computer-use/driver.mjs`・`core/computer-use/*`）: main の切断を Esc と同じに扱い、使用を止める（持ち主のロックを解き、進行中の呼び出しは `ComputerError('failed', …)` で返す）。ツールには「Pleiad の更新中のため止めました」（辞書の文言）と返す。ターンは止めない。戻った main には、止めたことを送り直さず、次の呼び出しで承認からやり直す
- **内蔵ブラウザー**（`core/agent-browser.mjs`・`core/browser-profiles.mjs`・`core/browser-screencast.mjs` と `desktop/browser-relay.cjs`・`browser-panel.cjs`・`agent-browser-bridge.cjs`）: サーバーが中継の一覧（会話・ポート・鍵・プロフィール・開いていた URL）を持ち、新しい main が付け直したとき、**同じポートと鍵で**中継を立て直し、タブを URL で開き直す。ポート・鍵が今は main の側で都度決まる（`browser-relay.cjs` の `server.listen(0, …)`・`random()`）ので、サーバーが決めて渡す形に直す。**1-0 の c で、同じポート・同じ鍵なら常駐は次の呼び出しで戻る**（同じ PID のまま）。ポートが取れなかったときは、別のポートと鍵にして、会話ごとの設定ファイル（`agent-browser.json` の `cdp`）を書き直せば、ターンの途中でも通る（二段の落とし方）。**中継の待ち受けは、タブを URL で開き直してから**（中継は、タブが無いと空のタブを 1 枚作る。先に待ち受けると、常駐の最初の `getTargets` が `about:blank` を見る）。居ない間（約 50 秒）の `agent-browser` は約 2 秒でエラーになる（モデルの再試行に任せる）
- **resident**（`desktop/resident.cjs`）: 戻った main に `resident` を送り直す。居ない間は何もしない（スリープ抑止は無くなる。入れ替えの間に入る見込みは小さい）。長い入れ替えでスリープに入るなら、サーバーが `SetThreadExecutionState`（koffi）で同じ間だけ抑える（1-0 の d: main が居ない時間は約 50 秒で、Windows の既定のスリープには届かない見込みなので、要らない【推測】）
- **wake**: main が付け直したら必ず 1 回 `wake` を送る
- **openExternal**: 非 Electron の開き方（`core/os-open.mjs` の `defaultOpener`）で開く
- **PC の通知**: 居ない間に溜まった完了の通知のうち、まだ見られていないものを、戻った main が出す
- **locale**: 付け直しで送り直す
- **`main-leaving`**: サーバーは受けたら、`hostAway` の猶予（`HOST_GRACE_MS`）を数えない（画面が居ない間の既存の仕組みと別に、main が居ないことを持つ）
- テスト: `tests/unit/main-away.mjs`（口を切って、secret の待ちと上限・復号した値の保持・computer use の停止と戻った後の承認からのやり直し・resident の送り直し・wake・通知の溜まり）。内蔵ブラウザーは `tests/browser/` の既存の作りか、ハーネスで

### 1-6 更新の流れ・切り替えの先送り・画面の読み直し（M）

design.md §5.1・§6.1・§8。

- `desktop/main.cjs` の `installUpdate`（`AGENT_HOST_HANDOVER=on`）: 作業を止めず・サーバーをロックせず、`main-leaving { reason: 'update' }` を送って `quitAndInstall` する（今の `workerRequest('update-lock')` と `abortAll` を通らない）。`off` では今のまま。画面の「中断して更新」のダイアログ（`web/interrupt.mjs`・`web/client.mjs`）は `off` と、合わない更新のときだけ
- 新しい main が起動して走っているサーバーに付け直したとき（`--updated` の有無によらず、サーバーの `appVersion` と自分の版・ビルドのハッシュが違えば）、**切り替えの制御**（`desktop/switch.cjs` 新規。純粋な状態機械 + 副作用を注入）を始める:
  1. 事前の確かめ: 新しい版の実行場所へ組み（1-3）、`pleiad-node.exe app\<新>\core\handover-check.mjs` を走らせる（新規 `core/handover-check.mjs`。データの形式番号・`ipc` の範囲を JSON で出す）。データの形式番号が変わる・`ipc` の範囲の外・manifest の不一致 → 自動の切り替えをせず、「あとで／中断して更新」のダイアログ（今の ADR 0036 の形）。「あとで」は S1 のまま動かし続け、勝手には切り替えない
  2. 待ち: 走っている作業（`running` の `count`）が 0 になるのを、数秒おきに見る（サーバーの `running` の通知がある間はそれも使う）。**`count` は `!` の行（`shellRuns.running()`）・Codex の裏の端末（`runtime.background`）・外部の stdio MCP・予定された送信を数えず、S1 の終了で止まる**（今の更新・終了と同じ。1-0 f）。切り替えで止める・待つ・画面に出すのどれにするかをここで決め、テストに書く。窓の表示は「新しい版への切り替えを待っています（N 件）」と「今すぐ中断して切り替える」（下の 1-6 の表示）
  3. 作業が 0 件になったら `update-lock`（`updateGate.acquire`）を取る。取れなければ（短い処理の最中）待ちに戻る。取れたら、サーバーに `shutdown`（`flushNow`・ロックを放して終わる）を頼み、終わるのを待つ（上限 30 秒）
  4. 新しいサーバーを同じ `AGENT_HOST_TOKEN`・`AGENT_HOST_PORT` で起こし、`ready` を待つ。窓を読み直す（同じ origin ならそのまま `loadURL`。ポートが変われば `window-trust` の origin も登録し直す）
  5. 新しいサーバーが立たなければ、前の版（`app\<旧>`）で起こし直し、窓に「新しい版のサーバーを起動できなかったので、前の版で動いています」。ログを残す
  - 「今すぐ中断して切り替える」: 全部を `update` で中断（今の `abortAll('update')`）→ 3 以降
  - 切り替えの制御は、`running` の `count`・ロックの取得・サーバーの終了・起動を引数で受ける純粋な状態機械にして、実時間・実プロセスなしでテストする
- `core/server.mjs`: `ready` に `appVersion`（とビルドのハッシュ。`package.json` の `version` と `manifest.json` の先頭のハッシュ）を足す（`core/protocol.mjs` の `READY` の注記も）。`protocolVersion` は変えない
- `web/client.mjs`: `ready` の `appVersion` が、自分を配った版（HTML に埋めた版）と違えば、入力欄の下書きを保存して 1 回だけ読み直す（sessionStorage に「この版で読み直した」を残し、繰り返さない）。`protocolVersion` の不一致の扱いは今のまま
- **切り替えの待ちの表示**（新しい UI）: `docs/design-system.md` の決まりに従い、ux-improve の手順で AsIs / ToBe のモックを作って承認を取ってから実装する。出すもの: 待ちの件数と、止めている作業の一覧（今の更新ダイアログの「止まる作業」と同じ行）、「今すぐ中断して切り替える」。文言は辞書（`web/locales/{ja,en}/desktop.json`・`ui.json`、訳語は `docs/i18n-glossary.md`）。承認後に形と日付を `docs/design-system.md` に書く
- main が出す文言（ダイアログ）も `web/locales/{ja,en}/desktop.json`（`desktop/i18n.cjs` が読む）
- 新しい main の preload は、古い画面（先送りの間に出す S1 の画面）が使う名前を 1 版ぶん残す（`desktop/preload.cjs`）
- テスト: `tests/unit/desktop-switch.mjs`（状態機械: 待ち・ロックが取れない・サーバーの終了の待ち・起動の失敗から前の版へ戻る・形式番号が違う版は自動で切り替えない・「あとで」・「今すぐ中断」・待っている間に新しい作業が始まる）。`tests/unit/web-interrupt.mjs` に読み直しの判定。`handover-check` の出力は `tests/unit/handover-check.mjs`

### 1-7 テスト・文書・実機・既定を `on` に（M）

- 通常テスト（`tests/unit/`）は各項目に書いたとおり。実時間に頼らない（時計・プロセスは注入）。`AGENT_HOST_HANDOVER=off` の経路の既存の試験は変えずに通す
- デスクトップのハーネス（`docs/dev-verification.md`「デスクトップ版（Electron）」の作り）で、`AGENT_HOST_HANDOVER=on`・`AGENT_HOST_RUNTIME_DIR=<一時>`・`AGENT_HOST_RUNTIME_NODE=<素の Node>`・`AGENT_HOST_BACKENDS=fake` を決め、次を確かめる（パッケージ版でなくても動くように、`isPackaged` に依らない上書きを持たせる）:
  1. fake の遅い台本のターンを走らせたまま、main だけを止めて（`app.exit`）起動し直し、サーバーが生き残り、新しい main が付け直し、ターンが最後まで流れる
  2. サーバーの版を替えた実行場所を作り、切り替えの待ち → 作業が終わる → 新しいサーバーが同じポート・トークンで立ち、窓が読み直される
  3. 新しいサーバーが立たない版（わざと壊した）→ 前の版で動き続け、その旨が出る
  4. main が居ない間に computer use（fake の driver）・secret を使うターンが、待つ・止めるの扱いになる
- 実機（署名なしの評価版でよいものと、署名した旧版→新版が要るもの。「実機で確かめる項目」の 1〜5・7〜9・11・12 の段階 1 の部分）
- 文書（実装と同じ変更で書き換える。ADR 0137「影響」の段階 1 の分）
- 最後に、パッケージ版の `AGENT_HOST_HANDOVER` の既定を `on` にする（env が無ければ `on`）

**段階 1 の完了の条件**: 署名した旧版 → 新版の更新を、fake ではない Claude・Codex・agy のターンを走らせたまま行い、**ターンが中断されずに終わる**（core の切り替えは作業が終わった後）。承認待ちのまま更新しても、新しい main に承認が出て答えられる。npm で入れた `claude` でも同じ。更新の間にスマホから承認・送信ができる。

---

## 段階 2: 保持役 + Claude（XL）

段階 1 の「サーバーの切り替えを先送りする」を、保持役の付け直しに替えていく。着手の最初に、未測定の Claude の場面を測る。

### 2-0 頭の測定（S〜M）

`scripts/zero-downtime/claude/` の作りで、次の最中に付け直したときの振る舞いを測る（stage0-claude の未確認）: サブエージェント・裏のコマンド（`background_tasks_changed`）・途中送信（`pendingSteers`）・圧縮（`PreCompact`）・`elicitation`・`request_user_dialog`・`oauth_token_refresh`・Pleiad の実際のオプション（`systemPrompt` のプリセット・`settingSources`・`skills`・プラグイン・互換の接続先）・npm で入れた `claude`（`pleiad-node.exe` で走らせる形）・数 MB の出力を流したときの保持役の遅さ・**外部の stdio MCP（`core/context-bridge.mjs` がサーバーの直の子として起こす）の扱い**（引き継ぎで旧サーバーと一緒に止まり、状態は戻らない。起こし直すか保持役の子にするか。R15）。**駄目な場面は「引き継ぎの前に終わるのを待つ」か「その場面のターンは保持役に載せない」に倒す**（design.md §4.4）。結果は `docs/zero-downtime-update/stage2-claude.md`

### 2a 保持役（M〜L）

- `core/holder/`（Node の組み込みだけ。目安 1,000 行以内）。規約 v1（design.md §4.2）、記録・印・ack・控え（`mcp_message` だけ渡し直す）・世代・札・預かり物、木ごとの強制終了、`logs\holder.log`。**JSON-RPC の id の付け替えと `initialize` の答えは持たない**
- 子の stdout・stderr を、親の有無にかかわらず**常に読む**（イベントループを長く止めない）。`detach` の後は、その親からの `write`・`end`・`kill` を転送しない。親が居ないあいだも子の stdin を閉じない
- 起動は `detached: true` + `stdio: 'ignore'` + `windowsHide: true`（段階 1 と同じ起こし方と Job の分岐）
- テスト（`tests/unit/holder-*.mjs`）: 偽の子（行を出す・依頼を出す・止まる・大量に出す）で、切断と付け直し・控えの渡し直し・**stdout を誰も読まない親でも詰まらない**（1 MB 以上）・`detach` 後の `kill` を転送しない・記録の上限（`truncated`）・二重起動の防止・`hello` の `secret` の不一致・世代の古いパイプ

### 2b サーバーの「始める」と「動かす」を分ける（L〜XL。一番大きい）

- 最初に、`core/server.mjs` のモジュールの外の変数と `runtime` の全部を、「保存済み／札へ入れる／再生で作る／捨ててよい」に仕分けた表を作る（R8）
- `runTurnInternal` を、準備・起動と、出来事を受けて `endTurn` で締める部分に分ける。後者を付け直しからも呼ぶ
- バックエンドに `adoptTurn`（札と記録の再生から、走っているターンの制御を作る）。まず fake のバックエンド（`core/backends/fake.mjs`）で作り、テストの台本で「途中で引き継ぐ」を書けるようにする
- 起動時の後片付けとぶつかる所（design.md §5.4）を、付け直すターンで外す
- 実行中のスナップショットを再生で作る（再生は uuid で冪等。ack は「アプリのループで処理し終えた最後の行」）

### 2c Claude を保持役に載せる（M〜L）

- `spawnClaudeCodeProcess` で保持役へ。偽の `SpawnedProcess`（`write`・`end`・`kill` を保持役に写し、`detach` の後は転送しない）。**`spawn` / `attach` は SDK の最初の stdin の書き込みより前に送る**
- 付け直し: 同じ CLI に `query` を作り直す（空の入力の流れ）。旧サーバーが手を離す順序は「保持役に `detach` → `query` を閉じる」。途中送信の控え（`pendingSteers`）・裏の作業の追跡（`claude-background.mjs`）・費用の基準（`readCostBase`）・フラグ設定のファイル（`writeClaudeFlagSettings`。ターンの終わりに消す）の札
- **`host` MCP は in-process のまま**（HTTP に移さない）。引き継ぎは、走っている hooks のコールバックと `mcp_message` のハンドラーが終わるのを（上限つきで）待つ
- 付け直しに使える CLI の版の一覧を別に持つ（`backend-shape-diagnostics.mjs` の `VERIFIED` とは分ける。確かめたのは 2.1.284・2.1.288、`pending_permission_requests` は 2.1.268 から）。外れる版のターンは保持役に載せない
- テスト: fake の CLI（stream-json を話す偽物）で、承認待ち・hooks・`mcp_message` の最中の付け直し。実機は `scripts/zero-downtime/claude/` の本物の CLI

### 2d 引き継ぎ（M）

- 旧サーバー: 開始を止める・短い処理と処理中の HTTP の MCP と hooks・`mcp_message` を待つ・タイマーを止める・`flushNow`・`detach`・ロックを放す
- 新サーバー: `acquireDataLock` の待ち（数十 ms 刻み）、預かり物（トークン・ポート）、MCP の束縛を札から戻す、**HTTP の口を待ち受けてから**付け直す・新しい作業を始める、付け直し
- モジュールを先に読み込んでロックを待つ起動（`--handover`）。間の目安を測り直す
- 戻し道（design.md §6 の表）: 前の版のサーバーで付け直す、1 つのターンだけの中断、`AGENT_HOST_HANDOVER=off`
- 段階 1 の先送りの制御（`desktop/switch.cjs`）を、保持役に載るターンは先送りせず引き継ぐ形に拡張する

### 2e サーバーが落ちたときの付け直し（S）

- main がサーバーの切断（`main-leaving` 無し）を見たら、同じ版で起動し直して付け直す。今の「サーバーが終了しました」の致命的なダイアログ（`main.cjs` の `worker.once('exit')`）は、起動し直しにも失敗したときだけ

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
