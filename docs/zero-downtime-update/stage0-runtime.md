# 無停止の更新 段階 0（実測）: 実行場所・NSIS の入れ替え・サーバーの起動時間

- 状態: 実測の記録（2026-10-06）。コードは変えていない。測るスクリプトは `scripts/zero-downtime/runtime/`
- 管理: [issue #54](https://github.com/tekalu1/pleiad/issues/54)（「まだ確かめていないこと」のうち、実行場所のプロセスが NSIS の入れ替えをまたいで生き残るか・実データでの起動時間）
- 印: **【実測】** = 動かして確かめた（手順と数値を書く）。**【確認】** = コード・テンプレートを読んで確かめた。**【推測】** = 動かしていない見込み。**【未確認】** = 測れていない
- 測った環境: Windows 11（10.0.26200）・x64・Node 24.14.0（手元）・Electron 44.5.1（同梱の Node は 24.21.0）・Windows Defender のリアルタイム保護が有効。時間はどれも 1 台の PC の値で、ほかの作業が動いている中で測っている（揺れは各表の min/max で見る）

## 結論

| # | 確かめること | 結果 |
|---|---|---|
| 1 | `$INSTDIR` の外で、`Ply.exe` 以外の名前（`pleiad-node.exe`）で起こした detached のプロセスが、更新・アンインストールをまたいで生き残るか | **生き残る**【実測】。`app.quit`・NSIS の更新（3 回）・アンインストールのどれでも、止まらず（拍の最大の空き 0.3 秒）、新しい版の main からも見えた。`$INSTDIR` の中の実行ファイルと、`$INSTDIR` と同じ文字列で始まる兄弟のフォルダーの実行ファイルは **止められた**（対照）。**`detached: true` は必須**: 付けない子は main が終わると道連れになる |
| 1 | Electron が Job Object に子を入れて道連れにならないか | **ならない**【実測】。ただし条件が 2 つある（下の 1.2）。`CREATE_BREAKAWAY_FROM_JOB` はこの環境では要らない |
| 2 | 実データでのサーバーの起動 | 待ち受けまで **1.17〜1.27 秒**・最初の WS の `ready` まで **1.20〜1.31 秒**・最初の `listSessions`（1,440 会話）の応答まで +0.4 秒。書いたばかりの写しから起こすと **3.5〜6.1 秒**【実測】 |
| 2 | データ置き場のロックの引き継ぎ | 旧が放してから新が取るまで **最大 18.6 ms**（90 回）。同じポートに **3/3 回とも**張り直せた【実測】 |
| 3 | 実行場所への写し | `resources/app` は **107 MB・4,017 ファイル**（設計の 345 MB は Claude の同梱バイナリーを外す前の値）。普通に写して 1.1〜2.0 秒。**ハードリンクは時間では得をしないが、ディスクと「書いた直後の読みの遅さ」で大きく効く**【実測】 |
| 4 | NSIS の試験 | 試験用アプリ（`PlyZdProbe`）だけで行い、インストール版 Pleiad には触れていない |

設計（design.md）を変える点は末尾の「設計への反映」。

---

## 1. 実行場所のプロセスは更新をまたいで生き残るか

### 1.1 方法

`scripts/zero-downtime/runtime/build-stub.mjs` が、本物の `build/installer.nsh` と同じ NSIS の設定・本物の electron-updater（配信は手元の HTTP）で、試験用アプリを 2 版（1.0.0 → 1.0.1）作る。

- appId `jp.ply.zdprobe`・製品名と実行ファイル名 `PlyZdProbe`・更新のキャッシュ名・userData が本物と違う。インストール先は `%LOCALAPPDATA%\Programs\PlyZdProbe`。**インストール版 Pleiad（`Ply.exe`）とそのデータ置き場には触れない**。NSIS が名前で止める fallback（`taskkill /IM <実行ファイル名>`）が本物の `Ply.exe` に当たらないよう、実行ファイル名も変えた
- 窓は作らない。起動すると、`%LOCALAPPDATA%\zdprobe-runtime`（`$INSTDIR` の外）へ置いた `pleiad-node.exe`（手元の公式 `node.exe` の改名）で `heartbeat.mjs` を起こす。`heartbeat.mjs` は 200 ms ごとに時刻を 1 行書き、最初の 1 行に自分の Job Object の所属を書く（koffi の `IsProcessInJob`・`QueryInformationJobObject`）
- 起こし方の違いで 5 つ:

| ラベル | 起こし方 | 置き場 | 見たいこと |
|---|---|---|---|
| A | main から `child_process.spawn`（`detached: true`・`stdio: 'ignore'`） | `$INSTDIR` の外 | 本命 |
| A2 | 同じだが `detached` なし | `$INSTDIR` の外 | `detached` の要否 |
| B | main が起こした `utilityProcess`（今のサーバーの置き方）の中から detached で起動 | `$INSTDIR` の外 | 今の構造のまま起こしても生きるか |
| C | A と同じ起こし方 | `$INSTDIR` の中（`zd-ctl-node.exe`） | 対照: NSIS が止めるか |
| D | A と同じ起こし方 | `$INSTDIR` + `-runtime`（兄弟のフォルダー） | 対照: 前方一致で止められるか |

- 更新は electron-updater の `quitAndInstall(true, true)`（`--updated /S --force-run`）。本物の Pleiad は `quitAndInstall(false, true)`（進捗バーあり）なので、それも 1 回流した。**どちらも人の操作は要らない**（OS のキー入力は使っていない）
- 起動は `explorer.exe <exe>` 経由（利用者がショートカットを押す形）。`--from-shell` でこのシェルの子としても 1 回流した

### 1.2 結果【実測】

**(a) `app.quit`**（2 回: explorer 経由・シェルの子）

| | A | A2 | B | C | D |
|---|---|---|---|---|---|
| main が終わった 4 秒後 | 生存 | **死亡** | 生存 | 生存 | 生存 |

NSIS が関わらない終了では C・D も生きる。**A2 だけが死ぬ**。

**(b) NSIS の更新**（3 回: サイレント 2・進捗バーあり 1。結果は同じ）

| | A | A2 | B | C | D |
|---|---|---|---|---|---|
| 新しい版の main の起動直後・3 秒後・終了前 | 生存 | 死亡 | 生存 | **死亡** | **死亡** |

- A・B は途中で 1 度も止まらなかった。拍の最大の空きは 311 ms（35 秒の間）。止まっていれば新しい版の main が見たときに `lastBeatAgo` が大きくなる
- 新しい版の main（`--updated` 付きで起動）から、A・B の PID が生きていることと拍が続いていることが見えた。つまり**新しい main は古い版のプロセスを見つけて付け直せる**前提が成り立つ
- 試験用アプリでの `quitAndInstall` → 新しい版の起動までは 17.2〜19.3 秒（Electron 本体だけ・無圧縮）。本物の 55〜70 秒は圧縮の展開とファイル数による。ここでは測っていない
- 更新の中で旧版のアンインストーラーも走る（`uninstallOldVersion`）【確認】。そこでも A・B は止められなかった

**(c) アンインストール**（現行版の `Uninstall PlyZdProbe.exe /S /currentuser`、約 10 秒）

| | A | A2 | B | C | D |
|---|---|---|---|---|---|
| アンインストールの後 | 生存 | 死亡 | 生存 | **死亡** | **死亡** |

`$INSTDIR` は残らず削除できた（掴まれているファイルは無かった）。拍の最大の空きは 1.4 秒（アンインストーラーの負荷による。止まりはしなかった）。

**止められる条件**【確認＋実測】: NSIS（`allowOnlyOneInstallerInstance.nsh`）は PowerShell があれば `Path.StartsWith($INSTDIR, 大小無視)` のプロセスを止める。C は「`$INSTDIR` の中」、D は「前方一致」で止められた。設計の「`$INSTDIR` と同じ文字列で始まる場所に置かない」は**実測で裏付けられた**（`…\Programs\PlyZdProbe` と `…\Programs\PlyZdProbe-runtime`）。

### 1.3 Job Object

`scripts/zero-downtime/runtime/launch-job-probe.mjs`・`nsis-survival.mjs`・`job-breakaway.mjs`【実測】。

**1.3.1 子が道連れになる仕組み**

- Node の `child_process` は、`detached` でない子を **libuv の Job（`KILL_ON_JOB_CLOSE`・`BREAKAWAY_OK`・`SILENT_BREAKAWAY_OK`）に入れ、親自身もそのJobに入る**。親が終わると Job が閉じて子が死ぬ。A2 が死んだのはこれ。素の Node で `spawnSync` した子でも同じ（`launch-job-probe.mjs`）
- `detached: true` の子はこの Job に入らない。Node は `CREATE_BREAKAWAY_FROM_JOB` を付けない（libuv の仕様）が、Job が `KILL_ON_JOB_CLOSE` を持たなければ問題にならない

**1.3.2 Electron main の Job**

- explorer 経由（ショートカットを押す形。更新後に NSIS が起こす形も同じ）で起動した main は、**`BREAKAWAY_OK` だけを持つ Job**（`KILL_ON_JOB_CLOSE` なし）に入っていた。同じ Job に main の子（Chromium の子・A・B・C・D の全部）が入る。`KILL_ON_JOB_CLOSE` が無いので、main が終わっても道連れにならない。シェルの子として起動すると main はどの Job にも入らない
- この Job を作るのが何か（explorer のシェルか、この PC の別の仕組みか）は**特定できていない**【未確認】。素の Node を `cmd` や PowerShell の `Start-Process` で起こしても Job は付かない
- **インストール版の `Ply.exe` の Job は調べていない**（触れない取り決めのため）。同じ Electron で、同じ explorer 経由の起動なので同じになる見込み【推測】

**1.3.3 Job の制限と起動のしかた（`job-breakaway.mjs`）**

子を起こす側が入っている Job の制限ごとに、「Node の detached 起動」と「`CreateProcessW` + `CREATE_BREAKAWAY_FROM_JOB`」が、Job を閉じた後に生き残るか:

| 親の Job の制限 | Node の detached 起動 | `CREATE_BREAKAWAY_FROM_JOB` 付きの `CreateProcessW` |
|---|---|---|
| `KILL_ON_JOB_CLOSE` のみ | **死ぬ** | **失敗**（`ERROR_ACCESS_DENIED` = 5）。逃げる道が無い |
| + `BREAKAWAY_OK` | **死ぬ** | 生き残る |
| + `SILENT_BREAKAWAY_OK` | 生き残る | 生き残る |

- 上の表の最初の 2 行が起きる環境（`KILL_ON_JOB_CLOSE` を持つ Job の中で Pleiad が起動された）では、Node の起動では生き残れない。この環境の explorer 経由の起動はこれに当たらない
- 生き残る起動のしかた: **`detached: true` + `stdio: 'ignore'`（パイプを持たない）+ `windowsHide: true`**。`CREATE_BREAKAWAY_FROM_JOB` は不要
- `BREAKAWAY_OK` だけがある Job で `KILL_ON_JOB_CLOSE` もある環境に備えるなら、koffi（main が持っている）で `CreateProcessW` に `CREATE_BREAKAWAY_FROM_JOB` を付ければ逃げられる（上の表の 2 行目）。起動の前に自分の Job の制限を見て、逃げられない組み合わせ（1 行目）なら無停止の更新を使わず「中断して更新」へ落とす

### 1.4 ここで測れていないこと【未確認】

- `customCheckAppRunning`（design.md §3.3）を定義した場合の NSIS の振る舞い
- PowerShell が使えない環境で NSIS が `taskkill /IM <実行ファイル名>` に落ちる道（コードを読んだだけ。`pleiad-node.exe` は名前が違うので当たらない）
- 全ユーザー向けのインストール（`Program Files`・昇格したインストーラー）
- 署名した本物の旧版 → 新版の更新、Windows ARM64、macOS
- 本物の Pleiad の main・サーバーでの確認（試験用アプリは窓もサーバーも持たない）

---

## 2. 実データでのサーバーの起動時間

### 2.1 方法

`scripts/zero-downtime/runtime/server-startup.mjs`・`handover-lock.mjs`。

- 実データの写し: `node scripts/copy-data-dir.mjs temporary/data-copy`（元は読み取り専用で、DB は `VACUUM INTO`。`remote/`・`*-secrets.json` は写さない）。**916 MB・4,399 ファイル・会話 1,438 件**（写すのに 2.6 秒）。測り終えたので写しは消した（トークンなど秘密を含むため）
- `core/server.mjs` を素の Node で `AGENT_HOST_DATA=<写し>`・別ポート（17497）・固定トークンで起動。claude / codex / agy の実行ファイルは存在しないパス、git の撮影・worktree は止めた（本物のエージェントを起こさない）。**そのため起動の裏でエージェントの一覧を引く分（`warmModels`）は含まない**
- 時刻は測るプロセスの `Date.now()`。ロックを取った時刻は、サーバーが `pleiad.lock` に書く `startedAt`（同じ時計）。待ち受けは起動ログの URL の行。`ready` は WS をつないで最初に届くメッセージ。`listSessions` は画面が最初に頼むコマンド

### 2.2 起動時間【実測】（5 回。2 回目以降の定常。単位 ms）

| 区間 | min | median | max |
|---|---|---|---|
| 起動 → ロックを取る（モジュールの読み込み） | 461 | 464 | 514 |
| ロックを取る → 待ち受け（DB・store・形式の確認ほか） | 709 | 718 | 761 |
| **起動 → 待ち受け** | 1,171 | 1,182 | 1,269 |
| 待ち受け → 最初の WS の `ready` | 29 | 32 | 36 |
| **起動 → `ready`** | 1,202 | 1,216 | 1,305 |
| `ready` → `listSessions` の応答（1,438〜1,442 件） | 378 | 383 | 416 |

- 設計の「0.54〜0.62 秒（空の置き場）」は、実データで **約 1.2 秒**。plan.md の「3 秒以内」は満たす
- ロックを取った後の 0.7 秒が、新しいサーバーが先にモジュールを読み込んでおけない部分。**モジュールの読み込み（0.46 秒）をロック待ちの前に終えておけば、旧が放してから `ready` まで約 0.75 秒**の見込み【推測: 実測は強制終了ベースの下の値。先に読み込んでロックを待つ起動は `core/` にまだ無い】
- 写しを作った直後の最初の 1 回だけ、起動 → 待ち受けが 5.5 秒だった（このリポジトリの `node_modules` を久しぶりに読んだため。2.3 と同じ原因【推測】）

### 2.3 書いたばかりのファイルから起こすと遅い【実測】

Windows Defender のリアルタイム保護が有効な環境で、**書いたばかりのファイルの最初の読みが遅い**。

- `resources/app`（4,017 ファイル）を新しく写した直後に全部読む: **最初 5.1〜5.8 秒（16 並列）／21.7〜22.8 秒（逐次）、2 回目 0.07〜0.1 秒／0.56〜0.66 秒**。1 ファイルあたり約 1.3 ms
- NSIS が書いた直後の試験用アプリ（329 ファイル・3.9 MB）でも、最初の読みが 357・409 ms、2 回目が 89・91 ms（約 4.5 倍）。**NSIS が書いたファイルも同じ**
- 新しく写した `resources/app` から、写した直後にサーバーを起こす（4 回）: コピー 4.1〜4.3 秒 + 起動 → 待ち受け **3.8〜6.1 秒**（起動 → ロックが 2.9〜5.2 秒。モジュールの読み込みで読み遅れる）。`cp -r` で写してから起動した場合は 1.21〜1.34 秒（写し終えてから起動までに検査が済んでいたと見られる【推測】）
- **ハードリンクで組んだ木はこの遅さを受けない**（3.2）

### 2.4 引き継ぎの断【実測】（旧を強制終了 → 直後に新を同じポート・同じ置き場で起動。画面は 25 ms ごとにつなぎ直す。3 回）

| | 1 回目 | 2 回目 | 3 回目 |
|---|---|---|---|
| 旧の強制終了 → プロセス終了 | 22 ms | 24 ms | 17 ms |
| 旧の終了 → 新が待ち受け | 1,182 ms | 1,196 ms | 1,162 ms |
| 画面が切れた → 画面が `ready` を受けた | 1,221 ms | 1,205 ms | 1,165 ms |
| → 最初の `listSessions` の応答まで | 1,626 ms | 1,559 ms | 1,542 ms |

- 同じポートに **3/3 回とも**張り直せた（「使えない」の案内は出ない）。旧に WS が張られたまま強制終了しても同じ
- 画面から見た断は **約 1.2 秒（`ready`）〜1.6 秒（一覧が出るまで）**。design.md §5.1 の「1 秒前後」は近い。モジュールを先に読めば 0.8〜1.1 秒の見込み
- **この測りの限界**: 旧を強制終了（Windows では `kill` は即終了でハンドラーが動かない）にしているので、旧が `flushNow` してロックを放して終わる本来の形ではなく、新の起動に DB の後始末（WAL）が含まれる。旧が静かに放す形は `core/` に無く、測れていない【未確認】

### 2.5 データ置き場のロックの引き継ぎ【実測】（`handover-lock.mjs`。放し方ごとに 30 回。待ち手は取れるまで隙間なく試す）

| 旧の放し方 | 旧が放してから新が取るまで（median / max、ms） |
|---|---|
| `release()`（プロセスは残る） | 15.0 / 16.5 |
| `process.exit(0)`（`'exit'` で閉じる） | 16.8 / 17.8 |
| 強制終了（OS が外す） | 17.4 / 18.6 |

- どの放し方でもほぼ同じ。**OS はプロセスの終了と同時にロックを外す**。遅れは放す側ではなく、待ち手の試行の間隔による: 取れない試行 1 回が **約 30 ms**（22〜31 ms。SQLite の Windows のロックのリトライ）なので、遅れの上限は約 31 ms
- design.md §5.2 の「上限まで待つ」は、数十 ms 刻みの試行で足りる

---

## 3. 実行場所への写し

`scripts/zero-downtime/runtime/runtime-copy.mjs`・`hardlink-start.mjs`（`npm run desktop:pack` の `dist-desktop/win-unpacked/resources/app`。写し先は `%LOCALAPPDATA%` の下の一時フォルダー。測り終えて消した）。

### 3.1 大きさ【実測】

- `resources/app`: **107.4 MB（クラスター丸めで 117.7 MB）・4,017 ファイル**（`node_modules` が 108 MB のうち大半。`core` 3.6 MB・`web` 4.2 MB）。design.md §3.2 の 345 MB・4,021 ファイルは、Claude Code の同梱バイナリー（約 238 MB）を外す前の値

### 3.2 写す時間（同じ内容を 3 回ずつ。単位 ms）

| 方式 | 時間 |
|---|---|
| そのまま写す（`fs.cpSync`・逐次） | 1,934 / 1,946 / 2,030 |
| そのまま写す（`fs.copyFile`・16 並列） | 1,102 / 1,136 / 1,160 |
| store に置いてハードリンクで組む・1 版目（逐次） | 7,285（ハッシュ 584 + store へ 4,265 + リンク 2,436） |
| 同・1 版目（16 並列） | 4,026（ハッシュ 128 + store へ 2,244 + リンク 1,654） |

- 1 版目の store 方式は普通の写しより遅い（ハッシュ・store への写し・リンクの 3 段）が、**S1 が走っている間に裏で行う**ので引き継ぎの断には入らない

### 3.3 2 版目（ハードリンクで前の版と共有）

旧タグの `core`・`web`・`desktop`・`bin` に差し替えた版を 2 版目にして、1 版目の store を使って組む（16 並列）。

| 1 版目との差 | 変わったファイル | 増えた中身 | 組む時間（ハッシュ + store + リンク） | 比べるもの: 全部写す |
|---|---|---|---|---|
| v0.9.0（1 つ前の版） | 5 | 0.7 MB | 7.5 秒※ | 1.2 秒・+118 MB |
| v0.8.1 | 28 | 2.3 MB | 7.0 秒※ | 1.3 秒・+118 MB |
| v0.7.2 | 81 | 3.3 MB | 6.7 秒※ | 1.1 秒・+118 MB |

※ 時間の大半（5.1〜6.0 秒）は、**書いたばかりの 2 版目の元を読んでハッシュを取る**ときの Defender の最初の読みの遅さ（2.3）。実際の流れでは元は NSIS が書いたファイルで、同じ遅さがあり得る。ハッシュを取る読みを、写す読みと同じ 1 回にまとめれば二重に払わない【推測】。変わったファイルを store へ写す時間は 0.2〜0.3 秒、リンクは 1.3〜1.8 秒（4,017 本）。

- **ディスク**: 1 版目は store に約 116 MB（一意な中身のクラスター丸め）。2 版目は **+0.7〜3.5 MB**。全部写すと版ごとに +118 MB。リンクの管理情報の分は、空きの差（揺れ ±数十 MB）に埋もれる大きさだった
- 組んだ木の抜き取り検査（42 ファイル）は元と一致。`nlink` は 2
- 組んだ版の削除は 0.44〜0.51 秒
- **書いた直後に全部読む時間**（2 版目の木）: ハードリンクで組んだ木は **0.11〜0.25 秒**、同じ木を新しく写した場合は **5.1〜5.5 秒**。変わっていないファイルは、使っている版（1 版目）がもう読み終えて検査も済んでいるため
- **サーバーの初回起動**（`hardlink-start.mjs`。1 版目の木で一度起動して使っている版にしてから、v0.9.0 の差で 2 版目を組んですぐ起動。3 回）:

| | 起動 → ロック | ロック → 待ち受け | 起動 → 待ち受け |
|---|---|---|---|
| ハードリンクで組んだ 2 版目 | 520〜586 ms | 701〜719 ms | **1,221〜1,298 ms**（定常と同じ） |
| 2 版目を新しく写した直後（対照） | 2,781〜3,721 ms | 750〜826 ms | **3,531〜4,525 ms** |
| 1 版目を初めて起動（store に書いた直後） | 3,680 ms | 873 ms | 4,553 ms（定常 1,237 ms） |

---

## 設計への反映

design.md を次のように直すのがよい（この調べでは design.md は変えていない）。

1. **§3.2 の大きさと R5**: `resources\app` は 345 MB → **約 107 MB・4,017 ファイル**。実行場所は最初に約 120 MB・版ごとに差分（数 MB）。R5 の「約 350 MB」を直す
2. **§3.2 のハードリンクは「ディスクの節約」だけでなく、再起動の速さの理由になる**。使っている版の読み終えたファイルへリンクするので、新しい版の初回起動が Defender の再検査を受けず、1.2〜1.3 秒に収まる（写し直しだと 3.5〜4.5 秒）。「推測」の印を「実測」に変え、ハードリンクを推奨に格上げする。ただし組む時間は普通の写しより短くならない（リンクだけで 1.3〜1.8 秒）。1 版目（store が空）は 4〜7 秒かかるので、S1 が走っている間に裏で行う前提のままにする
3. **§3.2 の写しの検査**: manifest との突き合わせのために元をハッシュするとき、書いたばかりのファイルの最初の読みが 5〜22 秒かかる。**ハッシュと写しを同じ読みで行い、16 並列程度で読む**。逐次の実装にしない
4. **§4・§6「保持役が落ちた」と §5「引き継ぎ」の子の寿命**: `detached` でない子は、親が終わると必ず道連れになる（libuv の Job）。保持役の子の CLI が保持役と一緒に止まる【推測】は **実測で裏付けられた**。逆に、**S1 が起こした `detached` でない子（agent-browser の常駐など）は、S1 が終わる引き継ぎで止まる**。引き継ぎをまたいで残したい常駐物は `detached: true` で起こすか、新しいサーバーが起こし直す。S1 の子を洗い出して分類する作業を段階 1 に足す
5. **§3.3 / 段階 0-4 の起動のしかた**: `detached: true` + `stdio: 'ignore'` + `windowsHide: true` で足りる。`CREATE_BREAKAWAY_FROM_JOB` は要らない。**main が起動時に自分の Job の制限を調べ**、`KILL_ON_JOB_CLOSE` を持ち抜け道が無い（`BREAKAWAY_OK` が無い）なら、無停止の更新を使わず「中断して更新」へ落とす。`BREAKAWAY_OK` だけで逃げられる環境なら koffi の `CreateProcessW` で逃げる（段階 1 の起動のコードに足す。`scripts/zero-downtime/runtime/job-breakaway.mjs` に動く例）
6. **§3.1 の「Electron main の子にしない」の理由**: 今の `utilityProcess` の中から detached で起こしたプロセスも更新をまたいで生き残った（B）。子にしない理由は「生き残るため」ではなく、「サーバーを main と別の寿命・別の版にする」ため、と書き直す（`utilityProcess` のままでも NSIS では止まらない）
7. **§5.1 の起動の重さ**: 「実データではもっとかかる」→ 実データで **1.2〜1.3 秒（`ready`）・一覧まで約 1.6 秒**。断の目安は **1.2〜1.6 秒**（先にモジュールを読めば 0.8〜1.1 秒の見込み）。plan.md 0-6 の「3 秒以内」は通る。ただし**新しく写した直後に起こすと 3.5〜6 秒**（2.3）なので、段階 1 の更新の流れは「写す（ハードリンク）→ 起こす」の順を守り、写しを逐次で書かない
8. **§5.2 のロックの待ち**: 取れるまでの遅れは約 31 ms（試行 1 回の長さ）が上限。上限 30 秒の待ちは数十 ms 刻みで足りる
9. **§1 の「55〜70 秒」**: 試験用アプリでは 17〜19 秒（Electron 本体のみ・無圧縮）。本物の 55〜70 秒の内訳（展開・旧版の削除・Defender）は測っていない。main が居ない時間の設計の根拠なので、段階 1 で本物のインストーラーを同じ流れで測る

## 残った未確認の点

- 1.4 の項目（`customCheckAppRunning`・PowerShell 無しの fallback・全ユーザー向け・署名した旧版→新版・ARM64・macOS・本物の Pleiad）
- 本物の `Ply.exe` の Job の所属と、explorer 経由の起動で付く Job の作り手
- 旧サーバーが静かに放す形（`flushNow` → ロックを明示して放す）での引き継ぎの時間。強制終了ベースの値しかない
- モジュールを先に読み込んでロックを待つ起動の実測（`core/` に無い）
- node-pty を公式の Node で読み込めるか（koffi は 24.14.0 で動いた。サーバーのテスト `npm test` を素の Node で通す件も未実施）
- 本物のエージェントを起こす経路・ロックを取った後の裏の処理（`warmModels` など）を含む起動の重さ
- この PC 以外（企業の EDR・Defender の除外設定がある環境）での、書いた直後の読みの遅さと Job の制限

## 再現手順

```
npm ci
node node_modules/electron/install.js                         # postinstall が走らない環境では
env -u ELECTRON_RUN_AS_NODE node scripts/zero-downtime/runtime/build-stub.mjs   # 試験用アプリを 2 版（temporary/zdprobe/）
env -u ELECTRON_RUN_AS_NODE node scripts/zero-downtime/runtime/nsis-survival.mjs all   # 準備 → 導入 → (a)(b)(c) → 後始末
node scripts/zero-downtime/runtime/job-breakaway.mjs
node scripts/zero-downtime/runtime/launch-job-probe.mjs
node scripts/copy-data-dir.mjs temporary/data-copy
node scripts/zero-downtime/runtime/server-startup.mjs --data temporary/data-copy --runs 5 --handovers 3
node scripts/zero-downtime/runtime/handover-lock.mjs --reps 30
npm run desktop:pack
node scripts/zero-downtime/runtime/runtime-copy.mjs
node scripts/zero-downtime/runtime/hardlink-start.mjs --data temporary/data-copy
```

- 試験用アプリは `PlyZdProbe` だけを入れ、`nsis-survival.mjs cleanup` で消す（子のプロセス・`%LOCALAPPDATA%\zdprobe-*`・`%TEMP%\zdprobe`・アンインストール）。止めるのはこの試験が起こしたプロセスだけ
- Git Bash から `PlyZdProbe-*.exe /S` を直に打たない（`/S` がパスに化けてインストーラーの窓が開く）。スクリプトは node から起動する
- 写しは測り終えたら消す（トークンなどを含む）
