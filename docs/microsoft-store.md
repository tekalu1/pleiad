# Microsoft Store 版（MSIX）

Windows 版を Microsoft Store から MSIX で配るための設定と、MSIX で動かしたときの違い。GitHub Releases の NSIS の配布（[desktop-releases.md](desktop-releases.md)）はそのまま残す。
Store は提出された MSIX に自分で署名して配るので、自己署名の証明書による SmartScreen の警告は出ない。まだ Store には出していない（2026-10-06 時点で試作と互換性の確認まで）。方式の決定は [ADR 0145](adr/0145-microsoft-store-msix.md)（提案）。

## 作り方

```
PLY_STORE_IDENTITY_NAME=<Package/Identity/Name> PLY_STORE_PUBLISHER=<Package/Identity/Publisher> PLY_STORE_PUBLISHER_DISPLAY_NAME=<Package/Properties/PublisherDisplayName> PLY_STORE_REQUIRE_IDENTITY=1 npm run desktop:store
```

- 設定は `electron-builder.store.cjs`。`electron-builder.yml` を読み、Windows の対象だけを `appx`（x64・arm64）に替える。出力は `dist-desktop/Pleiad-<版>-store-<arch>.msix`。署名はしない（Store が署名する）。
- `appId: jp.ply.desktop`・実行ファイル名 `Ply.exe`・package.json の `name: agent-host` は NSIS と同じ（[ADR 0019](adr/0019-rename-ply-to-pleiad-keep-identifiers.md)）。MSIX の識別子（Identity の Name・Publisher）はこれとは別に Store が割り当てる。
- Store が割り当てる 3 つの値は環境変数で渡す。Partner Center の「製品の管理」→「製品 ID」にある値をそのまま使う。

  | 環境変数 | manifest の場所 | 無いとき |
  |---|---|---|
  | `PLY_STORE_IDENTITY_NAME` | `Package/Identity/Name` | `PleiadPlaceholder.Pleiad` |
  | `PLY_STORE_PUBLISHER` | `Package/Identity/Publisher`（`CN=` で始まる） | `CN=00000000-0000-0000-0000-000000000000` |
  | `PLY_STORE_PUBLISHER_DISPLAY_NAME` | `Package/Properties/PublisherDisplayName` | `Pleiad` |
  | `PLY_STORE_DISPLAY_NAME` | `Properties/DisplayName`（Store で予約した名前） | `Pleiad` |

  `PLY_STORE_REQUIRE_IDENTITY=1` を付けると、仮の値のままでは作らずに止まる（提出用）。
- manifest は `build/appx-manifest.xml`（electron-builder の雛形に、App Execution Alias を足したもの）。タイルの画像は `build/appx/`（`desktop/icon.png` から作った）。`build/appx/` の中のファイルは全部パッケージの assets に入るので、ほかのファイルを置かない。
- 版は `MAJOR.MINOR.PATCH.0` になる。`-beta.N` の版も同じ `MAJOR.MINOR.PATCH.0` になり、後の正式な版と同じ番号になるので、Store には正式な版だけを出す。
- ビルドは `npm ci` で入れた `node_modules` で行う。メインの作業ディレクトリの `node_modules` へのジャンクションでは、electron-builder が依存をたどれず、パッケージに入る依存が 13 個に減った（正しくは 118 個。2026-10-06）。
- 手元で入れて試すには、自己署名で署名して、その証明書をコンピューターの「信頼されたユーザー」（`LocalMachine\TrustedPeople`。管理者権限が要る）に入れる。ユーザーの証明書ストアでは `0x800B0109` で入らない。署名なしの MSIX（発行元に `OID.2.25.311729368913984317654407730594956997722=1`）は、実行ファイルを持つアプリを入れられない（`0x80073D2B`）。管理者権限が無ければ、開発者モードで展開したフォルダーを登録する（`makeappx unpack` → `Add-AppxPackage -Register <フォルダー>\AppxManifest.xml`）。識別子・仮想化・エイリアスは同じで、置き場だけが WindowsApps ではなくそのフォルダーになる。署名は Windows SDK の `signtool`（10.0.22621）で行う。electron-builder が持ってくる古い `signtool`（winCodeSign 2.6.0）は MSIX に署名できない（`A required function is not present`）。

## 自動更新

Store の版は Store が更新する。electron-updater の確認もダウンロードもしない（`desktop/updates.cjs` の `updaterEnabled`）。

- Store の版の見分けは 2 つ。Store 用の設定が package.json に焼き込む `plyStore: true` と、Electron の `process.windowsStore`（パッケージの識別子で立つ。パスでは決まらない。2026-10-06 に実測）。どちらかが立てば止める。`plyRelease`・`app-update.yml` があっても止める。
- 設定の「アプリ情報・更新」には「Microsoft Store から更新されます」と、Store の「ライブラリ」で更新を取る案内を出す。確認のボタンと受け取る更新の設定は出さない。
- MSIX の入れ先は読み取り専用で、electron-updater は NSIS のインストーラーを別に入れようとする。Store のポリシー（7.20）が自己更新をはっきり禁じているのはゲームと Xbox だけ（10.2.5）だが、どのみち動かない。

## MSIX で動かしたときの違い

2026-10-06 に、x64 の MSIX を開発者モードで登録し（WindowsApps ではない）、App Execution Alias から起動して確かめた。「実測」はそのときの結果。

| 項目 | 結果 | 直し方・状態 |
|---|---|---|
| App Execution Alias（`%LOCALAPPDATA%\Microsoft\WindowsApps\Ply.exe`） | 動く（実測）。引数・環境変数・標準入出力が通り、識別子が付く。`ELECTRON_RUN_AS_NODE=1` も効く | manifest に入れた |
| パッケージの中の実行ファイルを直に起動 | 動くが識別子が付かない（実測）。userData が別の場所になる。WindowsApps の中の実行ファイルも、外から絶対パスで起動できる（一覧は拒否。同じ PC の winget で確認） | 起動口を残す箇所はエイリアスを指す |
| `process.execPath` のパス | `<入れ先>\app\Ply.exe`。Store の入れ先は `C:\Program Files\WindowsApps\<パッケージ名>_<版>_<arch>__<発行元の印>\` で、版ごとに変わる | 下の各行 |
| 　`core/cli-launcher.mjs` の `mcpSetup`（設定の「MCP の設定をコピー」） | 版ごとの実行ファイルと `pleiad.mjs` を貼ると更新後に切れる | Store 版は App Execution Alias を貼り、起動時に現在の版の `pleiad.mjs` を見つける |
| 　`core/backends/codex.mjs`・`context-options.mjs` | `enabled: false` の置き場の値で、起動しない。影響なし | 不要 |
| 　`core/backends/antigravity-context.mjs` | ターンごとに書き直すので動く。agy は Pleiad の子で、パッケージの中の Ply.exe を絶対パスで起こせる | 不要 |
| 　`desktop/main.cjs` の `setAppUserModelId`・`setAppDetails` | 窓に `jp.ply.desktop` が付き、スタートメニューのタイル（`<パッケージファミリー名>!Pleiad`）と別のアプリとして並ぶ（実測）。パッケージのアプリは自分の AUMID しか使えない（Microsoft の文書） | 直した。識別子があれば付けない（`desktop/msix.cjs`）。窓の AUMID が空になり、パッケージの AUMID で並ぶことを実測 |
| 　`desktop/remote-windows.cjs` の `setUserTasks`（ジャンプリスト） | パッケージの中の実行ファイルはジャンプリストから直に起こせない（自分の exe の絶対パスは例外。Microsoft の文書） | 直した。エイリアスを起動口にする。2 回目の起動（`--remote-hosts`）が動いている方に渡ることを実測 |
| 通知 | パッケージの AUMID で届く（実測） | 不要 |
| Electron の userData | 新しく入れると `%LOCALAPPDATA%\Packages\<パッケージファミリー名>\LocalCache\Roaming\agent-host` に置かれる（実測）。アンインストールで消える。NSIS 版の `%APPDATA%\agent-host` が先にあれば、その中のファイルは本物を読み書きする（既存のフォルダーへの書き込みは本物へ。実測） | 下の「仮想化」 |
| 　`updates.json` | 仮想化された userData に置かれる（実測）。Store の版では使わない値だけ | 不要 |
| 　safeStorage | 鍵（userData の `Local State` の `os_crypt.encrypted_key`）が仮想化された側に別に作られる（実測）。暗号文は `~/.agent-host` の `*-secrets.json` で共有なので、NSIS 版と Store 版で互いに復号できず、Store 版を消すと鍵も消える（鍵の置き場は実測、復号の失敗は推定） | 下の「仮想化」 |
| 　単一起動の鍵 | Chromium は userData のパスの文字列で相手を探すので、NSIS 版が動いていれば Store 版はそちらに引き渡して終わる（推定） | 同じ PC で両方を使わない案内 |
| `~/.agent-host`（データ置き場） | 仮想化されない（ホームの直下は対象外。実測）。NSIS 版と共有。同時に 2 台はデータ置き場のロックで立たない | 不要 |
| 外部の CLI（claude・codex・agy・git・gh） | パッケージの中から起動できる（実測。2.1.284・0.160.0・1.2.17） | 不要 |
| 子プロセスの書き込み | 子プロセスもパッケージの中で走り（実測）、AppData の新しいフォルダーと HKCU への書き込みが仮想化される（実測。`reg add` の値が外から見えない）。エージェントのシェルで入れた道具・設定（例: 初めての `gh auth login` の `%APPDATA%\GitHub CLI`、`setx`）がほかのアプリから見えず、アンインストールで消える | 下の「仮想化」 |
| node-pty（ConPTY） | `cmd.exe` を起こしてエコーが返る（実測） | 不要 |
| computer use（koffi） | koffi の読み込みと Win32 の呼び出しが動く（実測）。撮影・入力は同じ medium IL の Win32 なので変わらない見込み（未実測） | 不要 |
| agent-browser（`scripts/pack-agent-browser.cjs`） | `resources\agent-browser\agent-browser.exe` が動く（実測）。サーバーの PATH に入るのは版ごとのフォルダーだが、起動ごとに渡し直す | 不要 |
| `bin/` の pleiad CLI | パッケージの中の `pleiad.cmd` が内蔵の Node で動く（実測。未起動なら終了コード 3）。外のシェルへ `bin/` のパスを恒久登録する機能は無い | 会話中のシェルの PATH は起動ごとに作り直す。外の AI へ貼る MCP 設定は上のエイリアスを使う |
| capability | 上の全部が `runFullTrust` だけで動く。full trust のアプリにネットワークの capability は要らない | 仮想化を切るなら `unvirtualizedResources` |

まだ確かめていないこと: WindowsApps に入れた状態（管理者権限が要る）、arm64、Store が署名した版、Windows App Certification Kit（WACK）。

### 仮想化

既定（`EntryPoint="Windows.FullTrustApplication"`）の MSIX は、アプリと子プロセスの AppData の新しいファイル・フォルダーと HKCU への書き込みを、パッケージごとの場所へ移す。Pleiad はエージェントに利用者の PC で作業させるので、上の表の safeStorage・子プロセスの行が効いてくる。
切る方法は 2 つあり、どちらも制限付きの capability `unvirtualizedResources` が要る（Microsoft の文書では、一部のゲームと外部の場所で入れるアプリのためのもので、ほかの用途は想定していない）。

- `desktop6:FileSystemWriteVirtualization` と `desktop6:RegistryWriteVirtualization` を `disabled` にする。試した manifest の差分:

  ```xml
  <Package ... xmlns:desktop6="http://schemas.microsoft.com/appx/manifest/desktop/windows10/6" IgnorableNamespaces="uap3 desktop6">
    <Properties>
      ...
      <desktop6:FileSystemWriteVirtualization>disabled</desktop6:FileSystemWriteVirtualization>
      <desktop6:RegistryWriteVirtualization>disabled</desktop6:RegistryWriteVirtualization>
    </Properties>
    <Capabilities>
      <rescap:Capability Name="runFullTrust"/>
      <rescap:Capability Name="unvirtualizedResources"/>
    </Capabilities>
  ```

  アプリ・子プロセスの書き込みも userData も本物の場所になった（実測。userData は `%APPDATA%\agent-host` で NSIS 版と同じ）。
- `Application` を `uap10:RuntimeBehavior="win32App" uap10:TrustLevel="mediumIL"` にする。識別子は付いたまま仮想化が無くなり、子プロセスはパッケージの外で走った（実測）。開発者モードでは `unvirtualizedResources` 無しで登録できたが、Microsoft のメンテナーは要ると述べている（WindowsAppSDK の議論 #410、2021-02）。

capability を使わずに子プロセスだけを外に出す方法として、`CreateProcessW` の `PROC_THREAD_ATTRIBUTE_DESKTOP_APP_POLICY` に `PROCESS_CREATION_DESKTOP_APP_BREAKAWAY_ENABLE_PROCESS_TREE` を付ける API がある。パッケージの外の実行ファイル（`node.exe`）に付けると、その子も孫もパッケージの外で走り、書き込みは本物の場所に行った（実測）。パッケージの中の実行ファイル（`Ply.exe`）に付けても、その子は中のままだった（実測）。Node の `child_process` と node-pty はこの属性を渡せないので、使うなら起動の部分を作り直す（[ADR 0145](adr/0145-microsoft-store-msix.md)）。

### 実行ファイルのパス

外のプログラムに残る起動口（`mcpSetup` の貼り付け用の設定・ジャンプリスト）は、manifest の App Execution Alias `Ply.exe`（通常は `%LOCALAPPDATA%\Microsoft\WindowsApps\Ply.exe`）を指す。`LOCALAPPDATA` が無ければエイリアス名を使う。エイリアスから起動した `Ply.exe` の `process.execPath` は今の版の本物のパスになる（開発者モードで実測）。

Store 版の MCP 設定は `command` をこのエイリアスにし、`args` の `-e` で現在の `process.execPath` の隣の `resources\app\bin\pleiad.mjs` を探して読み込む。貼る設定に版番号入りのパスは残さない。判定は `plyStore` または `process.windowsStore` に揃え、エイリアスが利用者の Windows で無効なら設定は起動できないので有効化が要る。既に貼った古い設定は自動更新できないため、Store 版で「MCP の設定をコピー」をもう一度使う。

ほかの `process.execPath` の用途も確認した。Codex の MCP 設定に置く `enabled: false` の値は起動されず、Antigravity の relay と computer use の自己プロセス判定は起動中のプロセスに閉じる。hooks の設定は Pleiad の実行ファイルの絶対パスを書き出さない。ジャンプリストは既にエイリアスを使用し、`setAppDetails` の再起動コマンドは MSIX では設定しない。会話中のシェルに渡す `bin/` の PATH は起動ごとに再生成される。

## Store の審査とポリシー

2026-10-06 に Microsoft の公式文書で確かめた（Store のポリシーは 7.20、2026-09-14 版）。

| 項目 | 内容 | Pleiad で要ること |
|---|---|---|
| 外部ソフトへの依存（10.2.4） | 主な機能が別のソフト・サービスに依るなら、説明の冒頭に書く | Claude Code・Codex・Antigravity の CLI とそのアカウントが要ることを、掲載情報の説明の冒頭に書く |
| 動的なコード（10.2.2） | 説明した機能から外れるコードを、後から取り込んで動かしてはいけない | エージェントが利用者の指示でコマンド・スクリプトを走らせることを、説明した機能として掲載情報に書く |
| Windows の設定の変更（10.2.8） | 支持された方法と利用者の同意が要る。アクセシビリティ API などで変えてはいけない | computer use が設定の画面を操作しうる。操作の前に承認を取ること（[ADR 0071](adr/0071-computer-use-approval-and-safety.md)）を審査メモに書く |
| 試せること（10.3・10.3.1） | 審査で試せなければ落ちる。ログインが要るなら試用のアカウントを審査メモに | 外部の CLI とアカウントが無いと会話できない。審査メモに入れ方と試し方を書く |
| プライバシーポリシー（10.5.1） | Desktop Bridge・Win32 の製品は常に要る | プライバシーポリシーの URL を用意する |
| 生成 AI（11.16） | 掲載情報と Partner Center で生成 AI の使用を申告し、不適切な内容を開発者へ報告する手段を製品に置き、報告に応じて対処する | Chats と Channels の AI 返答のメニューから Pleiad の GitHub Issue 作成画面を開く。返答本文は自動送信しない |
| capability（10.6・制限付きの承認） | 宣言する capability は機能に正当に関係すること。制限付きは提出時に理由を書いて承認を受ける | `runFullTrust` の理由。`unvirtualizedResources` を使うならその理由（想定外の用途とされている） |
| カスタムの AUMID・ジャンプリスト | パッケージの AUMID しか使えない。ジャンプリストはエイリアスを指す | 直した |
| コマンドの起動と Windows 10 S | MSIX の準備の文書は、Store のアプリは Windows 10 S（S モード）で動くこと、`cmd.exe`・PowerShell の起動を避けることを求めている | シェルと外部 CLI の起動は Pleiad の中心なので、S モードでは使えない。審査で問われうる |
| きれいなアンインストール（10.2.7） | アンインストールできることを示す | 仮想化を切ると `%APPDATA%\agent-host`・`~/.agent-host` が残る。消し方を案内する |
| アカウントの種類（10.14） | 個人の開発者は個人のアカウントでよい。製品名・発行元名が会社に見えるなら会社のアカウント | 個人の登録で出す |

出典:

- [Microsoft Store Policies](https://learn.microsoft.com/en-us/windows/apps/publish/store-policies)
- [App capability declarations](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/app-capability-declarations)（`runFullTrust`・`unvirtualizedResources`・承認の流れ）
- [Prepare to package a desktop application](https://learn.microsoft.com/en-us/windows/msix/desktop/desktop-to-uwp-prepare)（AUMID・ジャンプリスト・コマンドの起動・AppData の共有）
- [Understanding how packaged desktop apps run on Windows](https://learn.microsoft.com/en-us/windows/msix/desktop/desktop-to-uwp-behind-the-scenes)（AppData・HKCU の仮想化）
- [Flexible virtualization](https://learn.microsoft.com/en-us/windows/msix/desktop/flexible-virtualization)（`desktop6` の要素）
- [Test your Windows app for Windows 10 S](https://learn.microsoft.com/en-us/windows/msix/desktop/desktop-to-uwp-test-windows-s)
- [UpdateProcThreadAttribute](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-updateprocthreadattribute)（`PROC_THREAD_ATTRIBUTE_DESKTOP_APP_POLICY`）
- [Application（uap10:RuntimeBehavior）](https://learn.microsoft.com/en-us/uwp/schemas/appxpackage/uapmanifestschema/element-application)
- [MSIX: containerized or not?（WindowsAppSDK #410）](https://github.com/microsoft/WindowsAppSDK/discussions/410)（win32App と `unvirtualizedResources`。Microsoft のメンテナーの発言で、文書ではない）

### 生成内容の報告と審査メモ

Pleiad は利用者が用意した Claude Code・Codex・Antigravity の CLI の返答を表示する。モデルの提供元ではないが、Pleiad 内で見た不適切な生成内容は開発者へ報告できるようにする。返答の `⋯` →「不適切な AI の内容を報告」は Pleiad の公開 GitHub Issue 作成画面を開く。GitHub アカウントが必要で、本文の共有範囲と送信は利用者が決める。会話・添付・作業パスは自動で付けない。開発者は報告を確認し、Pleiad の表示・制御に原因があれば修正し、モデルや CLI に起因するものは該当する提供元への報告を案内する。公開 Issue に秘密を書かないよう、作成画面の本文で注意を出す。

Notes for certification に記す内容: "In Chats and Channels, open the menu (⋯) on an AI response and select 'Report inappropriate AI content'. This opens a new issue in the Pleiad developer's GitHub repository. No conversation text is uploaded automatically; the user chooses what to submit. The developer reviews reports and fixes Pleiad issues or directs model/CLI concerns to the relevant provider."

## Partner Center でやること

アカウントの操作は利用者が行う。

1. 個人の開発者アカウントを登録する（無料。本人確認がある）。
2. 製品名「Pleiad」を予約する。
3. 「製品の管理」→「製品 ID」の `Package/Identity/Name`・`Package/Identity/Publisher`・`Package/Properties/PublisherDisplayName` を控え、上の環境変数で渡して作る。
4. 価格と提供する市場、年齢区分（IARC の質問票）を決める。
5. プライバシーポリシーの URL を入れる。
6. 掲載情報（日本語・英語）を書く。説明の冒頭に外部の CLI とアカウントへの依存、生成 AI の使用、エージェントがコマンドを走らせ PC を操作することを書く。スクリーンショットを付ける。
7. 提出で生成 AI の使用を申告し、制限付きの capability（`runFullTrust`、使うなら `unvirtualizedResources`）の理由を書く。
8. 審査メモ（Notes for certification）に、外部の CLI の入れ方と試し方、computer use の承認を書く。
9. x64 と arm64 の `.msix` をアップロードする。
