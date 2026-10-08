# 無停止の更新 段階 1 の 1-0（頭の確認）: 公式 Node・Job・内蔵ブラウザーの再接続・インストーラーの内訳・サーバーの子

> ブラウザーの記述について（2026-10-08）: この文書に残る内蔵ブラウザーのエージェント操作・CDP の中継・中継の復元の計画と計測は、Chrome へ移す前の記録。ADR 0148 の第 7 段で `desktop/browser-relay.cjs`・`browser-navigation.cjs`・`agent-browser-bridge.cjs` と `AGENT_HOST_AGENT_BROWSER` は削除した。現在のエージェント操作は Chrome の中継だけで、ビューアのタブの写しと読み込みの方針は `core/browser-viewer.mjs` と `desktop/browser-viewer-bridge.cjs` が扱う。現在の動きは [ブラウザー](../inapp-browser.md) を参照。

- 状態: 実測の記録（2026-10-06）。コードは変えていない（計画の文書 [plan.md](plan.md)・[design.md](design.md) の直しと、測るスクリプトだけ）。測るスクリプトは `scripts/zero-downtime/stage1-0/`
- 管理: [issue #54](https://github.com/tekalu1/pleiad/issues/54)。確かめる項目は [plan.md](plan.md)「1-0 頭の確認」の a〜f
- 印は stage0-*.md と同じ。**【実測】** = 動かして確かめた（手順と数値を書く）。**【確認】** = コード・テンプレート・実行中のプロセスの形を読んで確かめた。**【推測】** = 動かしていない見込み。**【未確認】** = 測れていない
- 測った環境: Windows 11（10.0.26200）・x64・Windows Defender のリアルタイム保護が有効・Electron 44.5.1・手元の Node 24.14.0。公式の Node は 24.21.0（nodejs.org の `win-x64/node.exe`。SHA-256 は `SHASUMS256.txt` と一致を確かめた）。時間はどれも 1 台の PC の値で、ほかの作業が動いている中で測っている（揺れは各表の複数回の値で見る）
- 守ったこと: インストール版 Pleiad（`%LOCALAPPDATA%\Programs\Ply`）とデータ置き場（`~/.agent-host`）は止めず・書かず。インストーラーの試験は段階 0 と同じ試験用（appId `jp.ply.zdprobe`・製品名と実行ファイル名 `PlyZdProbe`・更新のキャッシュ名も別）だけで行い、終わって消した。OS のキー入力は使っていない。実データの写しは作っていない

## 結論

| # | 確かめたこと | 結果 | 設計・計画が変わるか |
|---|---|---|---|
| a | node-pty が公式の Node で読める・`npm test` がその Node で通る | **通る**【実測】。公式の Node 24.21.0（x64）で、`build/` を除いた（配布物と同じ prebuilds だけの）node-pty が読め、疑似端末（cmd の対話・終了コード・幅 1000 の折り返さない出力・端末の判定・kill）も動いた。`npm test` は **全て通過（302 本・11,588 判定・431.6 秒、`--jobs 2`）**。arm64 の prebuild と公式 `node.exe` は形（N-API・arm64）まで確かめたが、動かしていない【未確認】 | 変わらない（段階 1 の前提が確定） |
| b | `Ply.exe` の Job の制限 | 本物の `npm run desktop:pack` の `Ply.exe`（electron-builder が作ったもの）を explorer 経由で起こすと、**`BREAKAWAY_OK` だけを持つ Job**（`KILL_ON_JOB_CLOSE` なし）に入る【実測】。更新後に NSIS が起こす形（v2）も同じ【実測】。シェルからの直の起動・`cmd /c start` では Job に入らない【実測】。インストール版の `Ply.exe` は main・子とも Job に入っている【確認：読み取りだけ】が、制限の中身は読めていない【推測：同じ起動経路なので同じ】 | 変わらない。1-4 の分岐のうち、実環境が当たるのは「Node の detached 起動」（`KILL_ON_JOB_CLOSE` なし） |
| c | `agent-browser` の常駐が、中継の切断から戻るか | **戻る**【実測】。本物の `agent-browser` と本物の `browser-relay.cjs` で、main が落ちた（強制終了）後に同じポート・同じ鍵で立て直すと、**同じ常駐のプロセスのまま**次の呼び出しが通った（約 30 ms）。別のポート・鍵でも、設定ファイルの `cdp` を書き直せば通る。居ない間は約 2 秒で失敗し、戻れば続けて通る | 変わらない。1-5 の「同じポートと鍵で張り直す」で足りる（中継の待ち受けをサーバーへ移す案は要らない） |
| d | 本物のインストーラーの内訳 | 本物の配布物の形（`desktop:pack` の中身 4,094 ファイル・491.6 MB を `PlyZdProbe` で包み、本物の `installer.nsh`・圧縮は既定）で、`quitAndInstall`（進捗バーあり）から新しい版の main が動くまで **49.3〜52.7 秒**（3 回）。内訳は下の 4.3 | 設計の「55〜70 秒」は妥当（実測 49〜53 秒 + main の起動）。**main が居ない間の長さの根拠が付いた** |
| e | `customCheckAppRunning` を定義した場合 | 定義すると **更新は通り、速くなる**（試験用アプリで 18.1 秒 → 名前だけで止める版 10.9 秒・何もしない版 6.5 秒）が、**何もしない版は普通のアンインストールが壊れる**。配布済みの版の旧アンインストーラーは既定のままなので、最初の更新では効かない【実測】 | **定義しない**（plan.md の「駄目なとき」どおり）。速さは別件の最適化として残す |
| f | サーバーが起こす子の洗い出し | `core/` と、依存が起こす子まで一覧にした（下の 6.1）。**段階 1 で `detached: true` に直すものは無い**（切り替えは作業が 0 件のときだけなので、サーバーと一緒に止まってよい）。新しく分かったこと: 外部の stdio MCP はサーバーの直の子（段階 2 の課題）・agy の relay は今 `$INSTDIR` で走っている・切り替えの「0 件」に数えられないものがある | 1-3・1-6・段階 2 に反映（下の 7・8） |

---

## 1. a: node-pty と `npm test` を公式の Node で

### 1.1 方法

- 公式の Node: `https://nodejs.org/dist/v24.21.0/win-x64/node.exe`（Electron 44.5.1 の Node と同じ版）。SHA-256 `ba4e6d110e8c1592a1ecd390f6b05f3da124b13871a5be62b341a07a853c6c32`・arm64 は `dff59da18b6ffe1bf1ca99e1d2af4906080c481740619f5b5098c0fca28bd9b7`（どちらも同じ版の `SHASUMS256.txt` と一致）。N-API は 10、`process.versions.modules` は 137
- node-pty: `npm ci` で入る 1.1.0。`npm ci` は手元に `build/Release`（ビルドした `.node`）を置き、読み込みは `build/` を `prebuilds/` より先に探す（`node_modules/node-pty/lib/utils.js`）。配布物は `electron-builder.yml` で `build/**` を外し prebuilds だけを持つので、**試験では `build/` を外して**（`npm test` は `node_modules` から動かし、`a-node-pty.mjs` は `build/` を除いた写しと、本物の `desktop:pack` の `win-unpacked` の中の node-pty の両方）読む
- 確かめた中身（`scripts/zero-downtime/stage1-0/a-node-pty.mjs`）: ① `spawn` で `cmd /c echo … & exit 7` の出力と終了コード ② この Node 自身を疑似端末の下で動かし、`isTTY`・`columns`・`rows`・入力の往復 ③ `core/claude-login.mjs` の `ptySpawner`（Claude のログインの経路）で、約 500 文字の 1 行（URL）が折り返されないこと・終了コード ④ 生きている子の kill
- `npm test`: 公式の `node.exe`（24.21.0）を PATH の先頭に置き、Pleiad のシェルが引き継いでいた `AGENT_HOST_PORT`・`PLEIAD_CONTROL_*`・`ELECTRON_RUN_AS_NODE` などを外して `node tests/run.mjs --jobs 2` を流した（テストが起こす子の `node` も 24.21.0）。本物のデータ置き場は `tests/lib/test-env.mjs` が守る

### 1.2 結果【実測】

| 確かめたこと | 結果 |
|---|---|
| 公式の Node 24.21.0 で、`build/` を除いた node-pty を読む | 読めた（`spawn`・`fork`・`createTerminal`・`open`）。リポジトリの node_modules の版でも、`desktop:pack` の `win-unpacked` の版でも同じ |
| 疑似端末で `cmd /c … exit 7` | 終了コード 7・出力あり（約 1.1 秒） |
| 疑似端末の下の Node | `isTTY: true`（stdin・stdout）・`columns: 1000`・`rows: 50`・入力 `ping` が届く |
| `ptySpawner`（claude-login の経路） | 長い 1 行が折り返されず、終了コード 3 が返る |
| kill | 生きている子が終わる。**そのとき node-pty の補助（`conpty_console_list_agent.js`）が `AttachConsole failed` を標準エラーに出す**（`core/claude-login.mjs` の注記と同じ。害は無い） |
| 実行ファイルの名前を `pleiad-node.exe` に変えた Node | 同じに動いた（node-pty は補助を `process.execPath` で起こす。名前に依らない） |
| `npm test`（公式の Node 24.21.0・prebuilds だけ・`--jobs 2`） | **全て通過 11,588 / 11,588 判定・302 本。431.6 秒**（suite の合計 846.6 秒）。本物の Claude Code・Codex の CLI を偽の互換 API へ向ける試験（`server-compat-real-cli`）も通った |

### 1.3 形の確認（動かしていない分）【確認】

`scripts/zero-downtime/stage1-0/pe-check.mjs` で PE ヘッダーを読んだ。

| ファイル | Machine | N-API の入口（`napi_register_module_v1`） |
|---|---|---|
| `node-pty/prebuilds/win32-x64/{pty,conpty,conpty_console_list}.node` | x64 | あり |
| `node-pty/prebuilds/win32-arm64/{pty,conpty,conpty_console_list}.node` | arm64 | あり |
| `win32-arm64/winpty-agent.exe`・`conpty/OpenConsole.exe`・`conpty.dll` | arm64 | — |
| 公式 arm64 の `node.exe`（81.9 MB。x64 は 93.6 MB） | arm64 | — |

arm64 の PC が無いので、arm64 は**読み込めるかを動かしていない**【未確認。plan.md 実機の確認 16】。N-API は ABI が安定なので、Node の版が同じメジャーなら読める見込み【推測】。koffi の arm64 の本体は npm の `@koromix/koffi-win32-arm64`（3.3.2）にある【確認】。

### 1.4 公式の Node の大きさ

x64 の `node.exe` は 93.6 MB。7z（LZMA）で圧縮すると約 22.5 MB【実測】なので、インストーラーは約 22 MB 増える（design.md §9 の「約 30 MB 圧縮後」の見込みより小さい）。arm64 は 81.9 MB。

---

## 2. b: `Ply.exe` の Job Object

### 2.1 方法

- 本物の `npm run desktop:pack` の `win-unpacked` を `%LOCALAPPDATA%\Programs\<試験用の名前>\` へ写し、`resources\app` の main だけを試験用（`scripts/zero-downtime/stage1-0/b-ply-probe-main.cjs`）に替えた。**実行ファイルは electron-builder が作った `Ply.exe` のまま**。本物の `desktop/main.cjs` を読まないので、データ置き場・userData・単一起動のロックに触れない。インストール版の Pleiad（同じ `Ply.exe` の名前・別の場所）は別プロセスで、止めていない（止めるのはこの試験が起こした PID だけ）
- 起こし方を変えて 3 回: ① explorer 経由（利用者がショートカットを押す形） ② Node から `detached` で直に（シェルの子） ③ `cmd /c start`。それぞれ、main が自分の Job の制限・同じ Job の PID・自分が起こした子（detached／detached でない）の所属を koffi（`IsProcessInJob`・`QueryInformationJobObject`。`runtime/job-info.cjs`）で読む
- インストール版の `Ply.exe`（動いている本物）は、`OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION)` と `IsProcessInJob` だけを使い（`b-job-readonly.cjs`）、Job に入っているかだけを読んだ。相手には書き込まず、止めていない

### 2.2 結果

| 起こし方 | main の Job | 同じ Job の PID | main が起こした detached の子 | detached でない子 |
|---|---|---|---|---|
| ① explorer 経由 | **あり。制限は `BREAKAWAY_OK`（0x800）だけ**。`KILL_ON_JOB_CLOSE` なし | main と Chromium の子 2 つ | Job に入る（継承。制限が `KILL_ON_JOB_CLOSE` を持たないので害は無い） | Job に入る（libuv の Job） |
| ② シェルの子 | なし | — | 入らない | 入る（libuv の Job） |
| ③ `cmd /c start` | なし | — | 入らない | 入る |
| 更新後に NSIS が起こした新しい版（d の試験の v2。`StdUtils.ExecShellAsUser`、親は explorer） | あり。`BREAKAWAY_OK` だけ | — | — | — |

【実測】。①は段階 0 の試験用アプリ（stage0-runtime §1.3.2）と同じ結果で、**本物の `Ply.exe` でも同じ**。koffi の `QueryInformationJobObject` は、パッケージ版の Electron の main の中でも動いた（1-4 の `desktop/job.cjs` が使う道が通る）。

**インストール版の `Ply.exe`**【確認：読み取りだけ】: main（`--updated` で explorer が起こした）・GPU・network・NodeService（サーバー）・renderer・サーバーの子の `claude.exe` が、全部「Job に入っている」。制限の中身（`KILL_ON_JOB_CLOSE` の有無）は、その Job のハンドルが無いと読めず、読んでいない【未確認】。同じ起動経路（explorer → `Ply.exe`）の試験の結果から、`BREAKAWAY_OK` だけとみなしている【推測】。直接確かめる道（システムのハンドル一覧から Job を探して、起こした側から複製する）は、explorer のハンドルを触ることになるので使っていない。

### 2.3 分かること・分からないこと

- この PC の Job は、explorer が作っているように見える（シェルの子・`cmd /c start` では付かない）。作り手は特定していない【未確認】。**Job の制限は起こす側で決まる**ので、1-4 は起動のたびに調べて分岐する（設計どおり）
- 実機で `KILL_ON_JOB_CLOSE` を持つ Job に当たるのは、Pleiad を別の仕組み（タスクスケジューラ・企業の管理ツール・ゲーム用のランチャー）から起こした場合などと推測される【推測。この PC では当たらなかった】

---

## 3. c: `agent-browser` の常駐が中継の切断から戻るか

### 3.1 方法

`scripts/zero-downtime/stage1-0/c-agent-browser-reconnect.mjs`（と `c-relay-host.cjs`）。（内蔵ブラウザーの中継を消した第 7 段で、この 2 つの台本も消した。計測は歴史として残る）

- **中継は本物のコード**（`desktop/browser-relay.cjs`）。待ち受けのポートと鍵だけを環境変数で決められるようにした写しを一時に作って使う（1-5 で入れる直しの最小形。`server.listen(0, …)` → ポート指定・`key: random()` → 鍵の指定。直したのは 2 行）。本物の panel（`desktop/browser-panel.cjs`）の代わりに、Electron の非表示の `BrowserWindow` をタブにする最小の panel を渡す（`webContents.debugger` は本物。about:blank を読み込んでおかないと `Page.getFrameTree` が返らず、最初の `Browser.getVersion` から止まる）
- **`agent-browser` は本物**（`node_modules/agent-browser` 0.38.1 の `agent-browser-win32-x64.exe`）。環境変数は `core/agent-browser.mjs` の `browserEnvironment` と同じ形（`AGENT_BROWSER_CONFIG` の JSON に `{ "cdp": <中継の URL> }`・`AGENT_BROWSER_SESSION`・`AGENT_BROWSER_SOCKET_DIR`・`AGENT_BROWSER_NAMESPACE=''`。セッション名・ソケットの置き場は試験用で、インストール版の常駐とは別）
- main が落ちる＝ Electron のプロセスを強制終了（TCP は RST）。「新しい main がタブを URL で開き直した」＝立て直した中継の側が先にそのページのタブを持つ

### 3.2 結果【実測】

| 場面 | 結果 |
|---|---|
| s0 基準（切らずに続けて呼ぶ） | `open` 369 ms・`get title` 20〜30 ms |
| **s1 強制終了 → 3 秒後に同じポート・同じ鍵で立て直し（タブは開き直し済み）** | 最初の `get title` が **28〜33 ms で通った**。続けて `snapshot`・`click` も通り、クリックの結果（タイトルが `clicked`）も見えた。**常駐のプロセスは同じ PID のまま**（`32988` → `32988`）= 張り直しは常駐が自分でやる |
| s2 優しい停止（中継を閉じる）→ 同じポート・鍵で立て直し | 同じに通る |
| s3 強制終了 → **別のポート・別の鍵**で立て直し | 設定ファイルが古い URL のままだと `CDP WebSocket connect failed … (os error 10061)` で約 2 秒で失敗。**設定ファイルの `cdp` を新しい URL に書き直すと次の呼び出しから通る**（同じ常駐。`open` も通る） |
| s4 同じポート・鍵だが、タブを開き直さない | 通るが `get url` は `about:blank`（中継はタブが無いと空のタブを 1 枚作る）。`open` をやり直すと続く |
| s5 中継が居ない間（強制終了のまま 20 秒）に呼ぶ | 直後も 20 秒後も **約 2 秒で失敗**（`os error 10061`）。立て直すと**続けて通る**（常駐の再起動は要らない） |
| s6 同じポートで**鍵だけ**が替わった（設定ファイルは古い） | `WebSocket protocol error: Handshake not finished` で失敗（中継は鍵が違う接続を切る）。設定ファイルを新しい鍵に直すと通る |
| s8・s9 起こした側（サーバーの代わりの Node。`agent-browser` を detached でなく起こす）が落ちた／終わったあと | **常駐は生き残り**、別の CLI からの呼び出しも通った（強制終了でも通常の終了でも） |

### 3.3 分かること

- 常駐は**次の呼び出しの時に張り直す**（待ち構えて再接続するのではない）。中継が居ない間の呼び出しは約 2 秒でエラーになるだけで、常駐は壊れない。更新の間（約 50 秒）に呼んだ `agent-browser` はエラーになり、戻れば次から通る
- 張り直しに要るのは、**同じ URL（ポートと鍵）で中継が立っていること**、または **`AGENT_BROWSER_CONFIG` の `cdp` が新しい URL に書き換わっていること**のどちらか。設定ファイルの置き場は会話ごとに固定（`dataDir\agent-browser\<ハッシュ>\agent-browser.json`）で、`AGENT_BROWSER_CONFIG` はターンの中でも同じパスを指すので、**ターンの途中でも書き換えが効く**。1-5 は「同じポートと鍵」を第一にし、ポートが取れなかったときだけ「別のポート＋設定ファイルの書き換え」に落とす二段にできる
- 中継が空のタブを作る作りなので、**新しい main はタブを開き直してから（または開き直しと同時に）中継の待ち受けを始める**。逆だと、常駐の最初の `getTargets` が空のタブ（`about:blank`）を見る（s4）
- **常駐は、起こした側が落ちても生き残る**（s8・s9）。`agent-browser` の CLI は libuv の Job に入るが、常駐は CLI が起こした孫で、Job を抜ける（libuv の Job は `SILENT_BREAKAWAY_OK` を持つ。6.2 の `cmd` → `ping` と同じ形【推測：仕組み。生き残ることは【実測】】）ので、サーバーが終わる引き継ぎでは止まらない。段階 0 の設計 §3.2 の「`agent-browser` の常駐は引き継ぎで止まる」は、常駐については当たらない（6.2）

### 3.4 道具の注意

`agent-browser` の CLI を `execFile` などのパイプつきで起こすと、**最初の呼び出しだけ**、常駐がパイプの端を持ったまま居続けるので、CLI が終わっても呼び出し側が 40 秒の上限まで戻らない（`open` が 40 秒かかり、出力は正しい）。標準出力・標準エラーをファイルにすると 0.4 秒で戻る。ハーネス（1-7）はファイルにする。

### 3.5 測っていないこと【未確認】

- 呼び出しの**最中**に中継が落ちた場合（実行中のコマンドがどう失敗するか）
- 立て直す前に別のプロセスが同じポートを取った場合（別のポート＋設定ファイルの書き換えに落ちる道は s3 で確かめた）
- 本物の panel（`browser-panel.cjs`）のタブ・screencast・プロフィールを付けた状態（ここは最小の panel）
- 常駐が複数会話ぶん居る場合

---

## 4. d: 本物のインストーラーの内訳

### 4.1 方法

`scripts/zero-downtime/stage1-0/d-installer-breakdown.mjs`。

- 本物の配布物の形: 本物の `npm run desktop:pack` の `win-unpacked`（Electron 本体と `resources\app` の 4,020 ファイル。全体で **4,094 ファイル・491.6 MB**）を写し、`Ply.exe` を `PlyZdProbe.exe` に改名し、`resources\app` の main だけを段階 0 の試験用 main（更新・記録・子の起動）に替える。それを `electron-builder --prepackaged` で、appId `jp.ply.zdprobe`・製品名 `PlyZdProbe`・**本物の `build/installer.nsh`・圧縮は既定**のインストーラー（**137.8 MiB**）にする。1.0.0 と 1.0.1 の 2 版。`--prepackaged` は `app-update.yml` を書かないので、同じ内容を置いた
- 流れ: 1.0.0 をサイレントで入れ → explorer 経由で起動 → electron-updater の `quitAndInstall(false, true)`（**本物と同じ。進捗バーあり**。人の操作は要らない）→ 新しい版の main が動き出すまで。測るのは、起動した試験用アプリの外から、100 ms ごとのプロセス一覧（koffi の `CreateToolhelp32Snapshot`）と 250 ms ごとの `$INSTDIR` のファイル数
- 時刻の基準は `quitAndInstall` を呼んだ時刻（t=0）。本物の Pleiad の main はこの後さらに窓とサーバーを起こす（この試験は窓もサーバーも持たない）

### 4.2 結果【実測】（既定の圧縮・3 回。単位 秒）

| 区間 | 1 回目 | 2 回目 | 3 回目 |
|---|---|---|---|
| ① main が終わる・新しいインストーラーが現れる（`quitAndInstall` から） | 1.1 | 1.2 | 1.1 |
| ② インストーラーの準備 → 旧版のアンインストーラーが現れる | 5.6 | 5.9 | 5.7 |
| ③ 旧版のアンインストーラー（現れる → 終わる） | 5.6 → 19.6 | 5.9 → 17.9 | 5.7 → 17.8 |
| 　うち `$INSTDIR` のファイルが減り始めるまで | 約 9.4 | 約 9.2 | 約 9.1 |
| 　うち `$INSTDIR` が空になる | 17.5 | 15.3 | 14.9 |
| ④ 旧版が消えてから、最初の新しいファイルが出るまで（`$INSTDIR` が空の間） | 17.5 → 29.8（12.3） | 15.3 → 28.2（12.9） | 14.9 → 29.5（14.6） |
| ⑤ 新しいファイルの展開（0 → 全部。4,091 ファイル） | 29.8 → 51.0（21.2） | 28.2 → 49.4（21.2） | 29.5 → 47.8（18.3） |
| ⑥ 展開が終わる → 新しい版の main が動き出す | 51.0 → 52.7 | 49.4 → 52.5 | 47.8 → 49.3 |
| **合計（新しい版の main が動くまで）** | **52.7** | **52.5** | **49.3** |

- 新しいインストーラーのプロセスは 52〜56 秒まで残る（終了処理）。新しい main が動き出してから約 3 秒後に終わる
- 圧縮を `store` にした変種（1 回）: 合計 **40.5 秒**（③ 5.4 → 14.1・④ 約 8〜10・⑤ 約 16.5）。ただし `compression: store` は `7z` の層だけを無圧縮にするので、インストーラーの大きさは変わらない（145.5 MB）。**12 秒短い理由は切り分けられていない**（旧版の削除の揺れだけで 3〜5 秒ある）【未確認】
- 初回インストール（1.0.0 をサイレントで入れる）は 26.5〜32.3 秒

### 4.3 内訳の読み方

| 段階 | 時間（3 回の幅） | 何か | 印 |
|---|---|---|---|
| 終了・インストーラーの起動 | 約 1.1〜1.2 | main の終了と、electron-updater が新しいインストーラーを起こす | 【実測】 |
| **「アプリが動いているか」の確かめ**（インストーラーの前半 約 4.5 秒 + 旧アンインストーラーの前半 約 3.5 秒） | 合わせて約 8 | `CHECK_APP_RUNNING`（PowerShell で `$INSTDIR` 配下のプロセスを探して止める。e で、この確かめが更新の時間のどれほどかを別に測った） | 時刻は【実測】。帰属は e の対照と整合【確認】 |
| 旧版の削除 | 約 6〜8（ファイルが減り始めてから空になるまで）+ 終了まで 約 2〜3 | 旧アンインストーラーが `$INSTDIR` のファイルを 1 つずつ移して消す | 【実測】 |
| 新しいファイルが出る前の空き（`$INSTDIR` が空） | 12.3〜14.6（旧アンインストーラーの終了から数えると 10.2〜11.7） | インストーラーの中身（約 138 MB の 7z）の取り出し・書いた直後の一時ファイルの検査が入ると見られる | **【推測】**（外から時刻しか見ていない） |
| **展開** | 18.3〜21.2 | 4,091 ファイル・491.6 MB を 7z（LZMA）から展開 | 時刻は【実測】。**圧縮の展開が主**（下） |
| 起動 | 1.5〜3.1 | 完了処理（ショートカット・レジストリ）→ `ExecShellAsUser` → 新しい版の main | 【実測】 |

**Defender**【実測】:

- 書いたばかりのファイルの最初の読みは遅い。NSIS が書いた直後の `resources\app`（4,016 ファイル・105.7 MB）を 16 並列で全部読むと **6.8〜7.8 秒**（旧・新どちらも）、2 回目は **0.09〜0.12 秒**。同じ木を `fs.cpSync` で写した直後でも最初の読みは 6.8〜7.0 秒・2 回目は 0.16〜0.19 秒（491.6 MB・4,094 ファイルの素の写しは **2.7〜3.2 秒**）。段階 0 の測り（stage0-runtime §2.3）と合う
- **展開（18〜21 秒）に Defender が占める分は小さい**: 素の写しは 3 秒で済み、書くときに Defender が止めている様子は無い。展開が遅いのは主に LZMA の展開【推測】。Defender の遅さは「書いた後に最初に読むとき」に出る
- したがって、新しい main が動き出した直後に実行場所を組む（ハッシュと写しの最初の読み）は **約 7 秒**かかる見込み（16 並列。設計 §3.3 の見積もりと同じ）。これはサーバー S1 が走っている間の裏の仕事なので、引き継ぎの断には入らない

**main が居ない間**（設計の「55〜70 秒」）: インストーラーの区間は **49〜53 秒**【実測】。本物の Pleiad は、新しい main の起動・サーバーの起動・窓の描画が加わるので、利用者の実測 55〜70 秒と合う【推測】。スリープに入る見込みは小さい（Windows の既定のスリープは数分以上）【推測】ので、`SetThreadExecutionState`（plan.md 1-5）は要らない見込み。

### 4.4 測っていないこと【未確認】

- サイレント更新（`quitAndInstall(true, true)`）の内訳（進捗バーなしの 1 回は stage0 で通っている）
- 署名した本物の旧版 → 新版（署名の検証の時間が加わる）・全ユーザー向け（`Program Files`・UAC）・ARM64
- 企業の EDR・Defender の除外設定がある環境
- `store` の 12 秒の差の理由
- この PC の 3 回の幅（49.3〜52.7）より多い回数の分布

---

## 5. e: `customCheckAppRunning`

### 5.1 方法

`scripts/zero-downtime/stage1-0/e-custom-check-app-running.mjs`。段階 0 の試験用アプリ（`PlyZdProbe`）と `nsis-survival.mjs`・`build-stub.mjs` を使う。`build-stub.mjs` に、出力先の名前（`ZD_WORK_NAME`）と版ごとの NSIS の include（`ZD_INC_V1`・`ZD_INC_V2`）を環境変数で選ぶ口を足した（既定は段階 0 のまま）。

NSIS のテンプレート（`allowOnlyOneInstallerInstance.nsh`）は、`customCheckAppRunning` マクロが定義されていると、**既定の `CHECK_APP_RUNNING` の中身（PowerShell で `$INSTDIR` の前方一致のプロセスを探して止める）をまるごと置き換える**【確認】。インストーラー（`installSection.nsh`）と、その版のアンインストーラー（`uninstaller.nsh` の `un.checkAppRunning`）の両方で使われる。

変種（どれも本物の `build/installer.nsh` を取り込んだうえで）:

| 変種 | 中身 |
|---|---|
| `ctrl` | 定義しない（本物のまま。対照。段階 0 の結果の再現） |
| `noop` | `customCheckAppRunning` を空で定義（何も確かめず、何も止めない）。旧版・新版とも |
| `nameonly` | 定義して、`taskkill /F /IM <実行ファイル名>` で名前だけで止める。旧版・新版とも |
| `mixed` | 旧版（1.0.0）は `ctrl`、新版（1.0.1）は `noop`（**既に配布された版からの最初の更新の形**: 旧アンインストーラーは既定のまま） |

子は段階 0 と同じ: A（`$INSTDIR` の外・detached）・A2（外・detached なし）・B（`utilityProcess` の中から detached）・C（`$INSTDIR` の中の実行ファイル）・D（`$INSTDIR` と前方一致する兄弟のフォルダー）。

### 5.2 結果【実測】

更新（`quitAndInstall` から新しい版の main が動くまで）と、更新後の生き残り（○ = 生きている）:

| 変種 | 更新が通る | `quitAndInstall` → 新しい main | A | A2 | B | C | D |
|---|---|---|---|---|---|---|---|
| `ctrl` | はい | **18.1 秒** | ○ | 死 | ○ | **死** | **死** |
| `noop` | はい | **6.5 秒** | ○ | 死 | ○ | **○** | **○** |
| `nameonly` | はい | **10.9 秒** | ○ | 死 | ○ | **○** | **○** |
| `mixed` | はい | 15.4 秒 | ○ | 死 | ○ | **死** | **死** |

- A2 が死ぬのは `customCheckAppRunning` と関係なく、main が終わるとき（libuv の Job。段階 0 のとおり）
- `noop`・`nameonly` では、**`$INSTDIR` の中で走っている C の実行ファイル（掴まれている）があっても、入れ替えは通った**（旧アンインストーラーは `$INSTDIR` のファイルを一時の場所へ rename してから消す作り（`un.atomicRMDir`）なので、走っている実行ファイルも動かせる【確認】）。C・D とも更新の後も走り続けた
- **`mixed` は `ctrl` と同じ**: 旧アンインストーラー（配布済みの版のもの）が既定のまま C・D を止める。新しい版が `customCheckAppRunning` を持っていても、**最初の更新では旧アンインストーラー側が決める**

アンインストール（C・D などを起こしたまま、起動中の試験用アプリがある状態で、その版のアンインストーラーを走らせる）:

| 変種 | 結果 |
|---|---|
| `ctrl` | きれいに消える（7.9 秒）。C・D は死に、`$INSTDIR` は残らない |
| `noop` | **起動中のアプリを止めないので、実行ファイルと DLL が掴まれたまま残る**（実行ファイル・`resources` が残り、約 62 秒かかる）。壊れたアンインストール |
| `nameonly` | 消える（3.4 秒）。C の実行ファイル 1 つだけが `$INSTDIR` に残る（C が生きているので） |
| `mixed` | 新版のアンインストーラーが `noop` なので `noop` と同じ（残る・約 62 秒） |

**更新が速くなる理由**: PowerShell の呼び出し（`IS_POWERSHELL_AVAILABLE` の 2 回・`FIND_PROCESS`・`KILL_PROCESS`）と `Sleep` が丸ごと消えるため。試験用アプリでは `ctrl` と `nameonly` で 7.2 秒、`noop` で 11.6 秒の差。d の本物の形の内訳（約 8 秒が「確かめ」）とも合う。

### 5.3 判断

- **定義しない**。理由:
  1. 実行場所は `$INSTDIR` の外・名前違いなので、既定の確かめで止められない（段階 0）。survival のために要らない
  2. 配布済みの版の旧アンインストーラーは既定のまま。**この機能を持つ最初の更新（そして実行場所が最初に組まれる更新）では効かない**（`mixed`）
  3. `noop` は普通のアンインストールを壊す。名前だけで止める版（`nameonly`）でも、利用者の絞り込み（`/FI "USERNAME eq %USERNAME%"`）・待ち・リトライ・全ユーザー向けの扱いを自前で書くことになり、既定の安全側の作りを手放す
  4. 得るものは更新の約 7〜8 秒（約 15%）の短縮だけ
- 速さは、無停止の更新が通った後の別件の最適化として残す（候補: `nameonly` に利用者の絞り込みとリトライを付ける）。そのとき**新しい版のインストーラーからしか効かない**ことを前提にする（`docs/desktop-releases.md`「インストーラー画面の手元確認」と同じ理屈）
- plan.md の「駄目なとき」にあった「リリースの確認に『更新で実行場所のプロセスが止まらない』を足す」は、定義しない場合の保険として**そのまま残す**（実機の確認 7・15 と合わせて）

### 5.4 測っていないこと【未確認】

- PowerShell が使えない環境で NSIS が `taskkill /IM <名前>` に落ちる道（`nameonly` はこの道に近いが、PowerShell を無効にした環境では動かしていない）
- 全ユーザー向け（`Program Files`・UAC の内側のインストーラー）・署名した旧版 → 新版

---

## 6. f: サーバーが起こす子の洗い出しと分類

### 6.1 一覧【確認】（`core/` の `child_process` の使い手と、依存が起こす子）

サーバー（`core/server.mjs`。今は main の `utilityProcess`、段階 1 では `pleiad-node.exe`）の子と、その先。「止まる」は、サーバーが終わったとき（切り替え・クラッシュ）の振る舞い。

| 場所 | 何を起こすか | 起こし方 | 寿命 | サーバーが終わると | 段階 1 での扱い | 後の段階 |
|---|---|---|---|---|---|---|
| `core/backends/claude.mjs`（`sdk.query`）→ SDK | Claude の CLI（`claude.exe`、または npm のシム経由） | SDK の `spawn(…, { stdio: pipe×3, windowsHide })`。detached でない | 1 ターン | **止まる**（libuv の Job） | 止めてよい。切り替えは作業が 0 件のときだけ | 段階 2: 保持役の子 |
| `core/backends/claude.mjs`（`probeCatalog`・`suggestTitle`）・`claude-usage.mjs`（`readClaudeUsage`）・`auth/claude-cli.mjs` | 短い CLI（モデル一覧・タイトル・使用量・認可の確認。30 秒以内） | 同上 | 短い | 止まる | 止めてよい | 載せない（design §4.4）。引き継ぎは短く待つ |
| `core/backends/codex-rpc.mjs`（`spawnCli`） | `codex app-server`（全会話で共有 1 本） | `spawn`（detached でない。`.cmd` は `shell: true`） | 常駐 | 止まる | 止めてよい（0 件のときだけ切り替える） | 段階 3: 保持役の子 |
| `core/backends/antigravity-cli.mjs` | `agy`（1 会話 1 本。**ターンの合間も生きている**） | `spawnCli` | 会話の間 | 止まる（終了時の片付け＋次の起動の孤児の掃除。`antigravity-pids.mjs`） | 止めてよい（次のターンで `--conversation` つきで起こし直す） | 段階 3: 保持役の子 |
| 　agy の relay（`core/agy-context-relay.mjs`） | agy が起こす MCP の stdio の橋 | agy の子。**今は `Ply.exe`（`ELECTRON_RUN_AS_NODE`）で `$INSTDIR\resources\app\core\…` を実行**【確認：動いているインストール版で、agy 2 本それぞれの下に 1 本】 | agy と同じ | agy が止まれば止まる | **1-3 で実行場所の `pleiad-node.exe` に変わる**。今の形のままだと、更新（NSIS が `$INSTDIR` 配下を止める）で relay だけ死ぬ | — |
| `core/backends/antigravity-usage.mjs`・`antigravity.mjs`（`spawnModels`） | `agy --version` / `--print /usage` / `models` | `spawnCli` | 短い（上限 25 秒） | 止まる | 止めてよい | — |
| `core/context-bridge.mjs`（`StdioClientTransport`、MCP SDK → `cross-spawn`） | **利用者の外部の stdio MCP サーバー**（`node_repl`・`python`・`cmd`→`node`・`mcp-server-windows` など） | `spawn(…, { stdio: pipe, windowsHide, shell: false })`。**detached でない**。サーバーの直の子【確認：動いているインストール版のサーバーの下に実在】 | その会話の束縛の間（Claude はターン・agy は会話） | **止まる。状態は戻らない** | 止めてよい（束縛が閉じるときに閉じる。次のターンで開き直す） | **段階 2 で要設計**（下 6.3） |
| `core/host-shell.mjs`（`runHostShell`。`!` の行） | 利用者のシェルのコマンド | `spawn(…, { detached: process.platform !== 'win32' })` = **Windows は detached でない** | コマンドの間（長いこともある） | 止まる（`process.on('exit', stopAll)`） | 止めてよい。**ただし切り替えの「0 件」に数えられない**（下 6.4） | 段階 3: 保持役の子 |
| `core/hook-adapter.mjs`（`runCommand`。hooks の元のコマンド） | hooks が呼ぶコマンド | `spawn(…, { shell, detached: process.platform !== 'win32' })` = Windows は detached でない | 短い（上限あり） | 止まる | 止めてよい | — |
| `core/git-info.mjs`（`execFile`）ほか git | `git`（状態・差分・worktree・撮影） | `execFile` | 短い | 止まる | 止めてよい | — |
| `core/claude-login.mjs` | `claude setup-token` の疑似端末（node-pty）。node-pty の補助（`conpty_console_list_agent.js`）は `process.execPath` で `fork`。疑似端末が無いときはパイプ | node-pty / `spawn` | 人が操作する間 | 止まる | 止めてよい（design §4.4「載せないもの」） | — |
| `core/os-open.mjs`（`launch`） | `explorer.exe`（`os-open`。main が居ないときの道） | `spawn(…, { detached: true })` + `unref` | 一瞬 | 影響なし | 変更なし | — |
| `core/backends/antigravity-pids.mjs` | `tasklist`（pid の名前の確認） | `execFile` | 一瞬 | — | — | — |
| hooks のアダプター（`hook-adapter-*.mjs`）を呼ぶ `node` | 利用者の PATH の `node`（`core/hooks-config.mjs` の `findNode`） | CLI が起こす | 短い | — | **実行場所とは無関係**（利用者の Node）。変更なし | — |

サーバーの**孫**（CLI などが起こすもの。サーバーの子としては数えない）:

| 孫 | 起こす側 | サーバーが終わると |
|---|---|---|
| Claude の Bash ツールのコマンド・npm のシム `claude.cmd` の先・`pleiad` CLI | Claude CLI（ネイティブ。Bun）/ シェル | 親の CLI が死ぬときに止まるかは、CLI の実装しだい【未確認】 |
| `agent-browser` の CLI と**常駐** | Claude の Bash ツール | **常駐は生き残る**（3 の s8・s9）。CLI は短い |
| Codex の端末・`node_repl` など | `codex app-server` | app-server が止まれば止まる（`runtime.background`。Pleiad から止める口が無く、`count` に数えない） |

### 6.2 起こし方の実験【実測】（`scripts/zero-downtime/stage1-0/f-descendants.mjs`）

起こす側の代わりの Node（stand-in。サーバーと同じ detached の起動）が木を作り、強制終了／自分で終了して 2 秒後に生きているかを見る:

| 木 | 結果 |
|---|---|
| stand-in → 長く走る `node`（detached なし） | **死ぬ** |
| stand-in → `node`（detached） | 生きる |
| stand-in → `cmd.exe` → `ping.exe` | `cmd` は死ぬが、**孫の `ping` は生きる** |
| stand-in → `node`（detached なし）→ `node`（detached なし） | 子も孫も**死ぬ** |
| stand-in → `node`（detached なし）→ `node`（detached） | 子は死ぬが、**孫は生きる** |

強制終了と通常の終了で同じ。つまり、**サーバー（Node）の直の子は必ず死ぬ**。**子が Node（libuv）で起こした孫は子と一緒に死ぬ**（入れ子の Job）。**libuv を使わない子が起こした孫（`cmd`・ネイティブの CLI の子）は生き残る**（`SILENT_BREAKAWAY_OK`）。

段階 0 の「サーバーの `detached` でない子（`agent-browser` の常駐など）は引き継ぎで止まる」は、常駐については当たらない（3 の s8・s9）。止まるのは**直の子**。

### 6.3 外部の stdio MCP（段階 2 の課題）【確認】

`core/context-bridge.mjs` が、利用者の外部の stdio MCP を MCP SDK の `StdioClientTransport` で**サーバーの直の子**として起こす（`detached` でない）。会話の束縛（`createContextBridge` の `bindings`）が持つ。

- 段階 1 では問題にならない（切り替えはターンが 0 件のときだけで、束縛は閉じる）
- **段階 2 の引き継ぎでは、走っているターンの外部 MCP（`node_repl` など状態を持つもの）が旧サーバーと一緒に止まる**。design §4.6 は「MCP の束縛を札から戻す」としているが、束縛が指す stdio の子は別に起こし直す必要があり、状態は戻らない。選択肢は（ⓐ 新しいサーバーが同じ設定で起こし直し、状態の消失をツールのエラーとして受け入れる ⓑ 外部 stdio MCP も保持役の子にする）。段階 2 の 2-0（頭の測定）か 2b で決める。plan.md にリスク（R15）として足した

### 6.4 切り替えの「作業が 0 件」の数え方【確認】

`runningWork()`（`core/server.mjs`）の `count` は、ターン・承認（中継の複製と期限なしのものを除く）・走っているサブエージェント・委譲のタスクの合計で、**次を数えない**:

- `!` の行（`shellRuns.running()`。`runs.size`）
- ターンの外で裏に残っている端末（`runtime.background`。「Pleiad から止める口が無い」ためコメントで数えない）
- 外部の stdio MCP・ターンの合間の agy・予定された送信（`scheduled`）

今の更新・終了は、これらを数えずに終了で止める（`shellRuns.stopAll`・codex の終了）。**切り替え（S1 の終了）も同じ**で、無停止の約束は「走っているターン」まで。ただし 1-6 の先送りで、`!` の行・裏の端末が走っている間に切り替えて止めるか、待つか、画面に出すかは決めておく（plan.md 1-6 に足した）。

### 6.5 そのほか分かったこと【確認】

- **サーバーの env の漏れ**: 今のサーバーは `desktop/server.cjs` が `ELECTRON_RUN_AS_NODE=1` を立てるので、Pleiad が起こした CLI のシェルに `ELECTRON_RUN_AS_NODE=1`・`AGENT_HOST_PORT`・`AGENT_HOST_BIND` が入っている（AGENTS.md「サーバー起動・確認」の注意と同じ）。`pleiad-node.exe` で走れば `ELECTRON_RUN_AS_NODE` は入らない。`AGENT_HOST_PORT` などは main が env で渡すので残る
- `process.versions.electron` による `ELECTRON_RUN_AS_NODE` の付与は、素の Node では偽（`core/cli-launcher.mjs` の `mcpSetup`・`core/backends/antigravity-context.mjs` の `agentDefinition` の既定の引数）なので付かなくなる。`pleiad-node.exe` で動かして 1-3 のテストで確かめる
- **外の AI に貼る設定（`cliSetup` → `mcpSetup`）が指すパス**: 実行ファイルは `process.execPath`、スクリプトは `CLI_SCRIPT`（`bin/pleiad.mjs`）。サーバーが実行場所で走ると、どちらも**版ごとのパス**（`node\<版>-<sha>\pleiad-node.exe`・`app\<版>\bin\pleiad.mjs`）になり、利用者が外の Claude Code などに貼った設定が、古い版の掃除で壊れる。1-3 で、貼る設定は版に依らない形（`$INSTDIR` の `Ply.exe` と `resources\app\bin\pleiad.mjs`、または実行場所の版に依らない起動口）に固定する
- `bin/pleiad.cmd`・`bin/pleiad` は `..\..\..\Ply.exe` を名指しする（設計 §3.4 のとおり）。実行場所の `app\<版>\bin` から同じ相対パスでは `Ply.exe` が無い

---

## 7. 段階 1 の後続項目への影響

| 項目 | 影響 |
|---|---|
| 1-1 | なし |
| 1-2 | なし（`computer-result` の写真の base64 の往復の時間は、1-2 の試験で測る） |
| 1-3 | ・公式の Node は **24.21.0**、SHA-256 は x64 `ba4e6d11…c6c32`・arm64 `dff59da1…bd9b7`（`scripts/node-runtime.json` に固定）。**インストーラーは x64 で約 22 MB 増える**（arm64 は元の `node.exe` が 81.9 MB）<br>・`pleiad-node.exe` で node-pty・`npm test` が通る（Claude のログインを main に寄せる必要は無い）<br>・`customCheckAppRunning` は**定義しない**（`build/installer.nsh` を変えない）。リリースの確認に「更新で実行場所のプロセスが止まらない」を足す<br>・**agy の relay は今 `$INSTDIR` の `Ply.exe` で走っている**（観測）。実行場所の `pleiad-node.exe` に変わるので、更新で relay だけ死ぬ問題が消える<br>・**外に貼る設定（`mcpSetup`）が指すパスを版に依らない形にする**（6.5）<br>・起動のあとに実行場所を組む最初の読みは約 7 秒（16 並列。裏の仕事） |
| 1-4 | ・main の Job の分岐は、実環境の当たりは「`KILL_ON_JOB_CLOSE` なし」→ Node の detached 起動。`BREAKAWAY_OK` + `KILL_ON_JOB_CLOSE` の道（`CreateProcessW`）は、当たらない環境のための保険としてコードに残す。koffi の Job 調べはパッケージ版の main で動く<br>・サーバーの子は `detached: true` に直すものが無い（6.1）。**孤児の掃除（agy）・外部 stdio MCP の閉じ方は今のまま**でよい<br>・`worker.stdout`・`stderr` を読んでいる所は、`detached` + `stdio: 'ignore'` ではログのファイルに替える（計画どおり） |
| 1-5 | ・内蔵ブラウザーは**同じポートと鍵で張り直せば足りる**。常駐は再起動せず次の呼び出しで戻る。ポートが取れなかったときは、別のポート＋設定ファイルの書き換えに落とせる（二段）<br>・**タブを開き直してから（または同時に）中継を待ち受ける**（逆だと空のタブを見る）<br>・居ない間（約 50 秒）の `agent-browser` は約 2 秒でエラーになる。モデルの再試行に任せる<br>・スリープ抑止（`SetThreadExecutionState`）は要らない見込み（main が居ない時間は約 50 秒） |
| 1-6 | ・main が居ない時間（`quitAndInstall` → 新しい main）は **49〜53 秒**。切り替えの制御の待ちの表示の根拠に使う<br>・`!` の行・Codex の裏の端末は「0 件」に数えられないので、切り替えで止まる。待つか・止めると画面に出すかを決める<br>・新しい main の「実行場所を組む」は、更新の直後の最初の読みが遅い（約 7 秒）ので、事前の確かめ（`handover-check`）の時間にこの分が入る |
| 1-7 | ・ハーネスで `agent-browser` を打つときは、標準出力・標準エラーをファイルにする（3.4）<br>・新しい worktree では `node node_modules/electron/install.js` が要る（`npm ci` の postinstall が走らない環境）<br>・`npm test` は 7 分ほど（`--jobs 2`）<br>・実機の確認 7（古い版の掃除）に「使っているシェルが無くなった後」を保つ |

---

## 8. 反映する点

plan.md・design.md には反映済み（この調べの変更）。以下はその一覧。

**plan.md**

- 段階 0 の表の 0-7・0-9 を、段階 1 の 1-0 で確かめたことに直した
- 1-0 の節: 各行に結果を足し、「出力」の `stage1-checks.md` を `stage1-0.md` に直した
- 1-3: `customCheckAppRunning` は定義しない・公式の Node の版と SHA-256・外に貼る設定のパスを版に依らない形にする・agy の relay が今 `$INSTDIR` で走っていること
- 1-5: 内蔵ブラウザーの再接続が通る結果・タブを先に開き直す順序・二段の落とし方
- 1-6: 切り替えの「0 件」に数えられないものの扱い
- リスク: R15（外部の stdio MCP がサーバーの子）を足し、R3・R14 に結果を書いた

**design.md**

- §1・§3.1: node-pty・`npm test` を公式の Node で確かめた【実測】。同梱する Node は 24.21.0・大きさ
- §3.2: 本物の `Ply.exe` の Job の結果。サーバーの子の洗い出し（子は `detached` に直さなくてよい・常駐は生き残る）
- §3.4: `customCheckAppRunning` の結果（定義しない）。agy の relay の観測
- §4.6: 外部の stdio MCP が旧サーバーの子であること
- §7.2: 内蔵ブラウザーの戻り方の結果・main が居ない時間の内訳
- 「未確認の点」: 確かめた項目を外し、新しい未確認を足した

---

## 9. 残った未確認の点

- **arm64**: node-pty の prebuild・公式の `node.exe`・koffi を実機で動かしていない（形だけ確認）
- **インストール版の `Ply.exe` の Job の制限の中身**（`KILL_ON_JOB_CLOSE` の有無）。Job に入っていることだけ確認した
- **Job の作り手**（explorer と見られるが特定していない）と、explorer 以外から起こされたとき（タスクスケジューラ・管理ツール）の Job
- 内蔵ブラウザー: 呼び出しの最中に中継が落ちた場合・同じポートを別のプロセスが取った場合・本物の panel（screencast・プロフィール）を付けた場合・複数会話の常駐
- インストーラー: サイレント更新の内訳・署名した旧版 → 新版・全ユーザー向け・ARM64・Defender の除外のある環境・`store` で 12 秒短かった理由・④（旧版の削除と展開の間の約 10 秒）の中身
- `customCheckAppRunning`: PowerShell が使えない環境の `taskkill` の道・全ユーザー向け
- サーバーの孫（Claude の Bash ツールのコマンドなど）が、親の CLI の終了で止まるか（CLI の実装しだい）
- 外部の stdio MCP を引き継ぎでどう扱うか（段階 2 の 2-0・2b）
- この PC 以外での、書いた直後の読みの遅さと Job の制限

---

## 再現手順

```
npm ci
node node_modules/electron/install.js                                        # postinstall が走らない環境では
# a（公式の Node を <node.exe> にする。nodejs.org の win-x64 の node.exe）
<node.exe> scripts/zero-downtime/stage1-0/a-node-pty.mjs                     # build/ を除いた node-pty の写しで
<node.exe> scripts/zero-downtime/stage1-0/a-node-pty.mjs --pty <node-pty のフォルダー>
node scripts/zero-downtime/stage1-0/pe-check.mjs <.node / .exe>...           # PE の形（arm64 など）
mv node_modules/node-pty/build <退避先>                                      # 配布物と同じ prebuilds だけにしてから
PATH=<node.exe のフォルダー>:$PATH node tests/run.mjs --jobs 2               # Pleiad のシェルの AGENT_HOST_* などを外して
# b
npm run desktop:pack
env -u ELECTRON_RUN_AS_NODE <node.exe> scripts/zero-downtime/stage1-0/b-ply-job.mjs --node <node.exe>
node scripts/zero-downtime/stage1-0/b-job-readonly.cjs <pid>...              # 読み取りだけ（インストール版にも使える）
# c
env -u ELECTRON_RUN_AS_NODE node scripts/zero-downtime/stage1-0/c-agent-browser-reconnect.mjs [s0 s1 s2 s3 s4 s5 s6 s8 s9]
# d
env -u ELECTRON_RUN_AS_NODE <node.exe> scripts/zero-downtime/stage1-0/d-installer-breakdown.mjs build     # 本物の形の installer（ZD_D_COMPRESSION=store で変種）
env -u ELECTRON_RUN_AS_NODE <node.exe> scripts/zero-downtime/stage1-0/d-installer-breakdown.mjs measure   # 入れて更新して測る（終わると片付ける）
# e
env -u ELECTRON_RUN_AS_NODE <node.exe> scripts/zero-downtime/stage1-0/e-custom-check-app-running.mjs build ctrl noop nameonly
env -u ELECTRON_RUN_AS_NODE <node.exe> scripts/zero-downtime/stage1-0/e-custom-check-app-running.mjs build mixed
env -u ELECTRON_RUN_AS_NODE <node.exe> scripts/zero-downtime/stage1-0/e-custom-check-app-running.mjs ctrl noop nameonly mixed
# f
<node.exe> scripts/zero-downtime/stage1-0/f-descendants.mjs
```

- 試験用アプリは `PlyZdProbe` だけを入れ、終わったら消す（`nsis-survival.mjs cleanup`。`noop` の変種はアンインストールで掴まれたファイルが残るので、起動中の試験用アプリを PID で止めてから消す）。止めるのはこの試験が起こしたプロセスだけ
- Git Bash から `PlyZdProbe-*.exe /S` を直に打たない（`/S` がパスに化ける）。スクリプトは node から起動する
- `desktop:pack` の出力（`dist-desktop/`）・`temporary/` の下の試験用の写しは測り終えたら消す（数 GB）
