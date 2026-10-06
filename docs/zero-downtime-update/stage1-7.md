# 無停止の更新 段階 1 の 1-7: 実機の確認（試験用のインストーラー）と、利用者に頼む確認

- 状態: 実測の記録（2026-10-06）。段階 1 の最後の項目（plan.md 1-7）。測るスクリプトは `scripts/zero-downtime/stage1-7/`
- 管理: [issue #54](https://github.com/tekalu1/pleiad/issues/54)。確かめる項目は [plan.md](plan.md)「実機で確かめる項目」の段階 1（1〜10・15・16）と、1-7 のハーネスの 1〜4
- 印は stage0-*.md と同じ。**【実測】** = 動かして確かめた。**【未確認】** = この PC ではできず、下の「利用者に頼む確認」に手順を書いた
- 測った環境: Windows 11（10.0.26200）・x64・Windows Defender のリアルタイム保護が有効・Electron 44.5.1・同梱の Node 24.21.0。時間は 1 台の PC の値で、ほかの作業が動いている中の測定（揺れは各 run の数値で見る）

## 結論

| # | 確かめたこと | 結果 |
|---|---|---|
| ハーネス 1 | fake のターンを走らせたまま main だけを止め、起動し直した main が付け直し、ターンが最後まで流れる | **通る**【実測】（s4。本物のインストール版の形で。`Stop-Process` で main の 1 プロセスだけを止めた） |
| ハーネス 2 | 版の違う実行場所で、切り替えの待ち → 作業が終わる → 新しいサーバーが同じポート・トークンで立ち、窓が読み直される | **通る**【実測】（s1。本物の NSIS・electron-updater の A → B） |
| ハーネス 3 | 新しいサーバーが立たない版 → 前の版で動き続け、その旨が出る | **通る**【実測】（s3 --to C） |
| ハーネス 4 | main が居ない間の computer use・secret | **通る**【実測】（s4。computer use は「止めた（stopped / update）」・secret は待たされ、付け直した main で通る） |
| 実機 1 | 走っているターンが `quitAndInstall` → NSIS → 新版の起動の間も進み、中断の印が付かない | fake・**Claude（`claude.exe`）・Codex・agy** で **通る**【実測】（s1・s5）。npm の `claude.cmd` は【未確認】 |
| 実機 2 | 承認待ちのまま更新し、新しい main の画面に承認が 1 つだけ出て、答えるとターンが進む | fake・**Claude・Codex** で **通る**【実測】（s2・s5。新しい main の窓の「許可」を押して答えた）。agy は承認のモードが無い。**スマホの画面は【未確認】** |
| 実機 3 | 更新の間にスマホから承認・送信ができる | 【未確認】（スマホが要る。下の U3）。main が居ない時間は **44〜53 秒**【実測】 |
| 実機 4 | 待ちの件数・切り替え・画面の読み直し・下書き・「今すぐ中断して切り替える」 | 待ちの表示・切り替え・読み直しは **通る**【実測】（s1）。下書きは **残る**【実測】。「今すぐ中断して切り替える」は **効く**【実測】（押してから 4.3 秒でターンが止まり、約 1 秒後に新しいサーバー） |
| 実機 5 | computer use の操作中に更新するとオーバーレイが消える前に操作が止まる | main が居ない間の停止は **通る**【実測】（s4）。**本物の画面操作を伴う更新は【未確認】**（U4） |
| 実機 6 | 内蔵ブラウザーのタブを開いた会話を更新すると、新しい main がタブを開き直し、次の呼び出しが通る | **通る**【実測】（s6。タブ 2 枚が同じ URL で戻り、`agent-browser.json` の `cdp` が同じで、その中継に `Target.getTargets` でつながる）。本物の `agent-browser` の呼び出しは、1-5 のハーネスで常駐が同じ pid のまま通ることを確かめた |
| 実機 7 | 実行場所に古い版が残り、掃除される・前方一致になる場所のとき別の場所へ移る | 古い版の掃除は **通る**【実測】（s7）。前方一致の移動は【未確認】（利用者の `jp.ply.desktop` の置き場に触れるので試験用の構成では行わない。単体は `tests/unit/desktop-runtime.mjs`。U9） |
| 実機 8 | 形式番号を変える版への更新で「あとで／中断して更新」が出て、「あとで」では切り替わらない | **通る**【実測】（s3 --to D） |
| 実機 9 | 新しいサーバーが立たない版への更新で、前の版で動き続け、その旨が出る | **通る**【実測】（s3 --to C。起動の失敗を見てから前の版で起こし直すまで約 6 秒） |
| 実機 10 | main を止めても、サーバーとターンが残り、起動し直した main が付け直す。アンインストールしても止められず、作業が 0 件のまま経つと終わる | **通る**【実測】（s4。アンインストール後もサーバーは生き、main を止めてから 186 秒で自分で終わった）。30 分の分（更新のために main が離れたとき）は単体 |
| 実機 15 | 全ユーザー向け（`Program Files`）でも同じ | 【未確認】（昇格が要る。U7） |
| 実機 16 | Windows ARM64 | 【未確認】（ARM64 の PC が要る。U8）。**ARM64 のインストーラー自体が、ARM64 の `.exe`・`.dll` を落とす恐れがある**（下の「見つけて直したこと」の 3） |

**見つけて直したこと（実機の確認で初めて分かった）**:

1. **本物のインストーラーで入れると、実行場所を組めず、無停止の更新が毎回 `utilityProcess` に落ちていた。** NSIS のインストーラーは、x64 の配布物の中の別 CPU の `.exe`・`.dll`（node-pty の `prebuilds\win32-arm64` の `conpty.dll`・`OpenConsole.exe`・`winpty.dll`・`winpty-agent.exe`）を、新しい 7-Zip の ARM64 フィルターで固めるため、インストーラーの古い展開器が読めず（7-Zip 16.04 で `Unsupported Method`）、**黙って落とす**。afterPack の manifest はそれを含むので、インストール後の `resources\app` と合わず `source-missing` で実行場所の準備が失敗した（利用者の今のインストール版にも同じ 4 ファイルが無い）。`desktop:pack` の `win-unpacked` では起きないので、1-3〜1-6 のハーネスでは見えなかった。動かさない OS・CPU の node-pty の prebuild を afterPack が manifest の前に外す（`scripts/pack-runtime.cjs` の `pruneOtherPrebuilds`・`tests/unit/pack-runtime.mjs`）。直した後は、インストールした木が manifest と全ファイル一致する【実測】。リリースの確認にも足した（desktop-releases.md「リリース判定」）
2. 実行場所を組めなくても、`utilityProcess` に落ちて動き、理由は `updater.log` に残った（`runtime preparation failed (source-missing): …`）【実測】。落ちる経路の実機の確認にもなった
3. **ARM64 のインストーラーも同じ理由で壊れている恐れがある**【推測。ARM64 の PC が無く動かしていない】。`--arm64` で作った NSIS のインストーラーの app アーカイブ（`app-arm64.7z`）を 7-Zip 16.04 で調べると、electron 本体の arm64 の `.exe`・`.dll`（`PleiadZdTest.exe`・`ffmpeg.dll`・`d3dcompiler_47.dll`・`vulkan-1.dll` など）と `resources\runtime\node.exe`・node-pty の arm64 の 4 ファイルがすべて `Unsupported Method`（x64 の配布物で黙って落ちたものと同じ ARM64 フィルター）。x64 の PC では arm64 のインストーラーは中身を展開しない（アンインストーラーだけ置いて終わる）ので、実際に落ちるかは確かめられない。electron-builder には `ELECTRON_BUILDER_7Z_FILTER`（`BCJ2` など。アーカイブ全体に指定する 7-Zip のフィルター）があり、リリースのビルドに付ければ直る見込み。ARM64 の PC（U8）で、インストール後の木が manifest と一致するかを見る
4. （確認用の作りの話。製品には影響しない）CDP のポートを固定すると、更新の後の新しい main が取れない。Chromium の待ち受けのソケットを、main が起こした detached のサーバーが継承し、古い main が終わっても掴んだままになる。本物の配布物は Chromium の待ち受けを持たない。確認では `remote-debugging-port=0` にして `DevToolsActivePort` からポートを読む

## 1. 方法

### 1.1 試験用の構成（利用者のインストール版に触れない）

試験用のインストーラーは、名前・場所・ポートを全部別にする（`scripts/zero-downtime/stage1-7/lib.mjs` の `ZD`。使う前に `assertIsolated` が重ならないことを確かめ、`tests/unit/zdtest-isolation.mjs` が守る）:

| | 試験用 | 利用者のインストール版 |
|---|---|---|
| appId | `jp.ply.zdtest` | `jp.ply.desktop` |
| 製品名・実行ファイル | `PleiadZdTest`・`PleiadZdTest.exe` | `Pleiad`・`Ply.exe` |
| インストール先 | `%LOCALAPPDATA%\Programs\PleiadZdTest` | `%LOCALAPPDATA%\Programs\Ply` |
| データ置き場（`AGENT_HOST_DATA`） | `%LOCALAPPDATA%\pleiad-zdtest\data` | `~/.agent-host` |
| 実行場所（`AGENT_HOST_RUNTIME_DIR`） | `%LOCALAPPDATA%\pleiad-zdtest\runtime` | `%LOCALAPPDATA%\agent-host-runtime` |
| userData | `%LOCALAPPDATA%\pleiad-zdtest\userdata` | `%APPDATA%\agent-host` |
| 更新のキャッシュ | `%LOCALAPPDATA%\pleiad-zdtest-updater` | （別） |
| サーバーのポート | 17420 | 7420（利用者の保存したポート） |
| 更新の配信元 | `http://127.0.0.1:17499/`（試験の間だけ） | GitHub Releases |

インストール先と実行場所は、どちらも相手を前方一致で含まない（NSIS が止めるのは `$INSTDIR` の前方一致）。署名なし（`Get-AuthenticodeSignature` が `NotSigned`）。**インストール版の `Ply.exe` のプロセス・インストール先・データ置き場・実行場所・userData は、読む（一覧を見る）ことはあっても書かず、止めず、起こさなかった**。試験で動かした `PleiadZdTest.exe`・`pleiad-node.exe` は、実行ファイルのパスが試験用の場所のものだけを止めた。

### 1.2 作り方と動かし方

- `node scripts/zero-downtime/stage1-7/build-installers.mjs`: 本物の `electron-builder`（`electron-builder.yml` の設定そのまま。`afterPack`・`files`・`asarUnpack`・`installer.nsh`）で、**A**（0.10.2。旧版）を作り、その `win-unpacked` を写して版・manifest を作り直した変種を NSIS にする: **B**（0.10.3。新版。ビルドのハッシュが変わるので切り替えが起きる）・**C**（`core/server.mjs` の頭で throw。新しいサーバーが立たない）・**D**（`DATA_SCHEMA` を 1 つ上げた。形式番号が合わない）・**E**・**F**（B の次の版。掃除を見る）。圧縮は `store`
- 入口（`scripts/zero-downtime/stage1-7/entry.cjs`。試験用のインストーラーだけに入る。本物の配布物の `main` は `desktop/main.cjs` のまま）が、本物の `desktop/main.cjs` の前に、`%LOCALAPPDATA%\pleiad-zdtest\config.json` から env（NSIS が更新後に起こす main は explorer の環境で、環境変数を渡せないため）・userData・AUMID を決める。`AGENT_HOST_HANDOVER` は**渡さない**（既定の on を試す）。外から WS でつなぐため、画面のトークンだけは固定の値（`AGENT_HOST_TOKEN`）にしてある（切り替えが前のサーバーのトークン・ポートを引き継ぐことは、`tests/unit/desktop-switch.mjs` と 1-6 のハーネスが確かめている）。守りとして、データ置き場・実行場所が試験用の home の外・実行ファイルが利用者のインストール先なら動かない
- 更新は `plyDesktop.update('install')`（画面の更新ボタンと同じ IPC。CDP で呼ぶ）→ electron-updater → NSIS → 新しい main。OS のキー入力は使わない。画面の確認は CDP（`Page.captureScreenshot`・DOM）と `PrintWindow`（`printwindow.ps1`）
- シナリオ（それぞれ A を入れ直して始める）: `s1-update-running-turn.mjs`（`--permission`・`--draft`・`--interrupt-now`）・`s3-bad-versions.mjs --to C|D`・`s4-main-down.mjs`・`s5-real-backend.mjs --backend claude|codex|antigravity --mode running|approval`・`s6-browser-tabs.mjs`・`s7-runtime-cleanup.mjs`

## 2. 結果

### 2.1 fake のターンを走らせたまま A → B（s1・s2。本物の NSIS）

- 更新を押してから: 古い main が終わるまで **2.5〜3.3 秒**、新しい main が起動するまでさらに **43.9〜49.5 秒**（合計 47〜53 秒。1-0 d の 49〜53 秒と同じ。main が居ない時間）。この間サーバー（`pleiad-node.exe`・実行場所）は止まらず、ターンは進み続けた【実測】
- 新しい main は付け直し（`server attached`）、この版の実行場所を組む（4,042 ファイル・1 版目 11.9 秒・2 版目は変わった 1 ファイルだけ新しく **5.7 秒**＝ハードリンク）、事前の確かめ（0.1 秒）、待ち（`waiting 1: turn:…`）。待っている間の窓: 脇の下に「Pleiad 0.10.3 への切り替えを待っています／実行中 1 件／作業を見る」（新しい main が古い版の画面へ渡して描かせた）
- 作業が終わった（150 秒のターンの最後）後、`locking` → `stopping` → `starting` → `reloading` → `done` が **約 1.2 秒**。S2 は同じ origin（同じトークン・ポート）・新しい版・別の pid。窓は読み直され、会話の記録に中断の印が無く `completedAt` が残る。ターンの本文は最後（`done`）まで流れた
- 承認待ち（s2・`--permission`）: S1 で承認待ちのまま更新 → 新しい main の窓に「◆ 承認待ち」の行と「承認待ち 1 件」の知らせが出る。**14 / 14** 通過
- 下書き（`--draft`）: 更新の前に書いた下書きは、切り替えで読み直された画面の入力欄に残った【実測】
- 「今すぐ中断して切り替える」（`--interrupt-now`）: 待っている間に押すと、ターンは台本の途中（31 ステップのうち 14 で）**4.3 秒**で止まり、約 1 秒後に S2 へ切り替わって窓が読み直される（`switch: interrupting` → `locking` → … → `done`）。fake は中断を `ok` の終わりで返し中断の印を付けないので、理由 `update` の印は単体（`tests/unit/desktop-switch.mjs`）で見る。fake の 1 ステップが長い（150 秒の 1 回の待ち）と中断は 30 秒待っても止まらず、`interrupting failed` の後に待ちへ戻った（fake はステップの切れ目でしか中断を見ない作り。本物のエージェントは止まる）。**15 / 15**

### 2.2 新しいサーバーが立たない・形式番号が違う（s3）

- **C**: 新しい main が付け直した直後（作業が 0 件）に切り替えを始め、C のサーバーは起動の途中で終わり、約 6 秒後（`switch: fallback — the server exited during startup`）に前の版（A）のサーバーで起こし直した。同じ origin・使える（fake のターンが通る）。窓に「新しい版を起動できなかったため、前の版（0.10.2）で動いています／もう一度試す／閉じる」。**5 / 5**
- **D**: 自動では切り替えず、窓に「Pleiad 0.10.5 に切り替えるには作業を中断します／データの形式が変わるため、自動では切り替わりません／あとで／中断して切り替え」。「あとで」を選んで 20 秒後も S1（版 A）のまま。**2 / 2**

### 2.3 main だけを止める・居ない間・アンインストール（s4）

- fake の 90 秒のターンを走らせたまま main の 1 プロセスを `Stop-Process`: サーバーは生き（同じ pid・control.json）、ターンの接続は切れない
- main が居ない間: computer use のターン（本物の driver・`screenshot`）は `state: stopped / reason: update` で返り、ターンは止まらない。`savePlyMcp`（秘密）は待たされる（8 秒後もまだ返らない）
- main を起動し直す: 同じサーバー（pid・origin が同じ）に付け直し、待たされていた保存が **8.7 秒**（居なかった時間）で通り、`mcp-secrets.json` は `safeStorage` で暗号化されている（平文が無い）。ターンは最後まで終わった
- 作業が 0 件で main を止め、**アンインストール**（約 6 秒。`$INSTDIR` は消えた）: 実行場所のサーバーは止まらず、main を止めてから **186 秒**で自分で終わり、`control.json` も消えた（孤児の見張りの 3 分）。**11 / 11**

### 2.4 本物のエージェント（s5。短いターン。fake ではない）

利用者の CLI の認証（`~/.claude`・`~/.codex`・`~/.gemini`）をそのまま、試験用のデータ置き場から使えた【実測】。ターンは「PowerShell の `Start-Sleep` を 110 秒走らせて、終わったら FINISHED と答える」（何も書かない・消さない）。更新はターンが始まって約 17 秒後に押した。

| エージェント | running（コマンドを走らせたまま更新） | approval（承認待ちのまま更新） |
|---|---|---|
| Claude（`haiku`・`claude.exe`） | **8 / 8**（128 秒のターンが中断されずに終わり、コマンドは最後まで走って `zdtest-slept`・FINISHED。作業が終わった後に S2 へ。会話に中断の印なし） | **9 / 9**（承認待ち（PowerShell）1 件・更新・新しい main の窓で「許可」を押して答え、ターンが進んで終わる。新しい接続から見える承認も 1 件） |
| Codex（`gpt-6.1-sol`） | **8 / 8**（同上。Codex は終わりから S2 まで約 8 秒） | **9 / 9**（承認待ち 1 件・更新・新しい main の窓で「許可」を押して答え、ターンが進んで終わる。新しい接続から見える承認も 1 件） |
| agy | **8 / 8**（同上。ターンは 128 秒） | 承認のモードが無い（yolo だけ）ので対象の外 |

- **学習（夜の整理）に注意**: 本物の Claude を有効にしたアプリは、起動して 1 分ほどで、メモリの学習（`<pleiad-memory-learn>`。Claude の opus を呼ぶ）を走らせる。材料は `~/.claude` の会話の履歴（利用者のもの）で、結果は試験用のデータ置き場に書かれる。最初の Claude の承認の確認は、これが試験用の会話より先に `session` を出したため別の会話を拾って 3 回落ちた（確認の作りの不具合）。試験用のデータ置き場の `prefs.json` に `memoryLearnPaused: true` を最初から置いて止めた（`zd.mjs` の `freshInstall`）。**この 3 回と、その前の Claude の running の確認では、学習が試験用の置き場で走った可能性がある**（試験用の置き場の中だけの書き込みで、置き場は消した）

### 2.5 内蔵ブラウザー（s6）

Fake の `browser:` のターンで会話を作り、窓の `plyDesktop.browser` でタブを 2 枚開いた状態（配信元のファイルの URL）で A → B。更新の前後でタブは同じ 2 枚（同じ URL）、`agent-browser.json` の `cdp` は同じ（同じポート・鍵で中継を立て直した）、その `cdp` に `Target.getTargets` でつなぐとタブが見える。**7 / 7**

### 2.6 実行場所の掃除（s7）

A → B → E → F と、作業が 0 件のまま更新を 3 回重ねた（1 回ごとに main が居ないのは約 55 秒。実行場所の `app\` は 2 → 3 → 4 版）。F の main の起動から約 70 秒後の掃除で、**今の版（F）・直前の版（E）・さらにもう 1 版（B）が残り、いちばん古い A が消えた**（使っているサーバーは無い）。掃除の途中の残り（`.staging`・`.trash-`）は無い。`store`（ハードリンクの実体）は 4 版を通して **122 MiB**（1 版分 + 変わった分。Node は 1 つ）。**4 / 4**

main を**木ごと**止める（`taskkill /PID <main> /T /F`。タスクマネージャーの「プロセスツリーの終了」に近い）と、**サーバーも止まった**【実測】。サーバーは main の子ではないが、起こしたのが main なので `ParentProcessId` が main のままで、`/T` がたどる。main の 1 プロセスだけを止める（クラッシュ・`Stop-Process`。s4）なら残る。木ごとの終了は今の `utilityProcess` でもサーバーが止まるので悪くなってはいないが、plan.md 実機 10 の「タスクマネージャーで止めても残る」は**止め方による**。タスクマネージャーの各操作（アプリのグループの「タスクの終了」・「詳細」の「プロセス ツリーの終了」・1 プロセスの「タスクの終了」）の結果は【未確認】（U12）。サーバーを短い仲介のプロセス（すぐ終わる）経由で起こして `ParentProcessId` を main から外すと木ごとの終了から逃げられる見込みだが、孤児が増える向きなので、段階 2 の保持役とあわせて決める【推測】

## 3. 利用者に頼む確認（この PC・署名なしでは行えないもの）

署名した旧版 → 新版（リリースと同じ署名・配信）で行う。どれも**今の利用者のインストール版とそのデータを使わない**（別の PC・別の Windows ユーザー・別の仮想マシンで行うか、行う前に `~/.agent-host` を退避する）。確認用の署名なしのインストーラーの作り方・動かし方は 1.2。

- **U1（実機 1・2。署名した版）** 署名した旧版 N と新版 N+1 を GitHub Releases（先行版でよい）に出す。N を入れ、`claude`（`claude.exe`・`npm i -g @anthropic-ai/claude-code` の `claude.cmd` の両方。別々に）・Codex・agy のそれぞれで、1〜2 分かかる指示（例「PowerShell で `Start-Sleep -Seconds 100` を走らせて、終わったら FINISHED と答えて」）を送る。ターンの最中に設定の「再起動して更新」を押す。確かめること: 画面が約 1 分切れて戻る・ターンが最後まで終わる・会話に「中断した」の印が付かない・`%APPDATA%\agent-host\logs\updater.log` に `switch: waiting` → `done`・脇の下に待ちの知らせが出てから消える。承認待ち（Claude は「都度確認」、Codex は「確認」のモード）のまま更新して、新しい版の画面で承認が 1 つだけ出て答えられる
- **U2（実機 2・3。スマホ）** リモートを有効にした PC とスマホ。更新の約 1 分の間に、スマホから承認・送信を試す（`docs/remote.md`）。つながり直したときに承認が 1 つだけ（二重でなく）出て、更新の間に送った指示が欠けない・二重にならないこと
- **U3（実機 3）** 上の U2 と同じ。更新の間の長さを測る（`quitAndInstall` → 新しい版の窓。本物で 55〜70 秒の見込み、この PC の試験用では 47〜53 秒）
- **U4（実機 5。本物の画面操作）** 設定で computer use を有効にし、Pleiad に別のアプリ（メモ帳）を操作させている最中に更新を押す。確かめること: オーバーレイが消える前に操作が止まる・エージェントに「Pleiad の更新中のため止めました」が伝わる・更新後、次の呼び出しで承認からやり直せる。**この PC の前面の窓を操作するので、利用者が見ている時に行う**
- **U5（os-open・openExternal の居ない間）** MCP の OAuth の同意画面（外部の MCP の認証）を開く操作を、更新の約 1 分の間に行う。ブラウザーが開くこと（main が居ない間は OS に直に頼む）。ブラウザーが実際に開くので、利用者が見ている時に
- **U6（ホストへ任せる口）** 「この PC の AI から任せる」を有効にした端末とホスト（`docs/remote.md`）。端末側を更新・切り替えしても、タスクと承認が戻る（居ない間は `OFFLINE`・戻ったら `sync`）
- **U7（実機 15）** 全ユーザー向け（`Program Files`。UAC）のインストールで、U1 と同じ更新。実行場所は `%LOCALAPPDATA%\agent-host-runtime`（利用者ごと）のまま、`$INSTDIR` の中ではない
- **U8（実機 16）** Windows ARM64 の PC で U1。まず、インストール後の `resources\app` が manifest と全ファイル一致するか、`PleiadZdTest.exe` 相当の `Ply.exe`・`ffmpeg.dll` などが欠けていないか（上の「見つけて直したこと」の 3）。ARM64 の Node（81.9 MB）で実行場所が組め、`pleiad-node.exe` が動く。欠けていたら、リリースのワークフローに `ELECTRON_BUILDER_7Z_FILTER=BCJ2` を付けて作り直す
- **U9（実機 7 の前方一致）** インストール先を `%LOCALAPPDATA%\agent-host-runtime-app` のように変えて入れ、起動後に `%LOCALAPPDATA%\jp.ply.desktop\runtime`（インストール先と前方一致でない場所）へ実行場所が移ること（`updater.log` の `runtime:`）。既存の `%LOCALAPPDATA%\jp.ply.desktop` に触れるので、別の PC か別の Windows ユーザーで
- **U10（リリースの CI）** `PLEIAD_NODE_CACHE` の `actions/cache`（Node の取得と SHA-256 の照合のキャッシュ。plan.md 1-3「未実施」）をリリースのワークフローに足し、ビルドが取得を省いても照合が通ること。リリースの手順に「インストール後の `resources\app` が manifest と一致する」（`desktop-releases.md`「リリース判定」）を足した
- **U12（実機 10。止め方の違い）** タスクマネージャーで次の 3 つを別々に行い、サーバー（`pleiad-node.exe`）が残るかを見る: アプリのグループ「Pleiad」を「タスクの終了」・「詳細」タブで `Ply.exe`（main）を「プロセス ツリーの終了」・「詳細」タブで main の 1 プロセスだけを「タスクの終了」。残った場合は Pleiad を起動し直して付け直すこと、作業が 0 件のまま 3 分で自分で終わること。この PC の試験では、木ごとの終了（`taskkill /T`）はサーバーも止め、1 プロセスだけの終了は残した
- **U11（スリープ）** 更新の約 1 分の間に、PC が自動でスリープに入らないか（電源設定のスリープを 1 分にして更新）。入るなら `SetThreadExecutionState` をサーバーに足す（plan.md 1-0 d・1-5）。この PC では 47〜53 秒で、既定のスリープには届かなかった

## 4. 後片付け

試験で入れた `PleiadZdTest` はアンインストールし、`%LOCALAPPDATA%\pleiad-zdtest`・`%LOCALAPPDATA%\pleiad-zdtest-updater`・worktree の `temporary/zd17`・`dist-desktop` を消した。Claude の試験の会話（`~/.claude/projects/` の試験用の作業場所）・agy の会話（`~/.gemini/antigravity-cli/`）も、試験用のものだけ消した。
