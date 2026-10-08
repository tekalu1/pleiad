# 0145 Windows 版を Microsoft Store から MSIX で配る。更新は Store に任せ、AppData と HKCU の仮想化は切る申請をする

- 状態: 提案

## 状況

Windows 版は NSIS のインストーラーを自己署名の証明書（`CN=Ply Evaluation (hikaru)`）で署名し、GitHub Releases に置いている。インストールのたびに SmartScreen の警告が出る。認証局の署名は、日本の個人が使える安い手段が無い（[desktop-releases.md](../desktop-releases.md)「正式な配布環境」）。
Microsoft Store は個人の登録が無料で、提出された MSIX に Store が署名して配る。Store の EXE・MSI の受け付け（ポリシー 10.2.9）は、認証局の署名を求めるので使えない。

2026-10-06 に MSIX を作って開発者モードで登録し、動きを確かめた（[microsoft-store.md](../microsoft-store.md)「MSIX で動かしたときの違い」）。既定の MSIX（Desktop Bridge）は、アプリと子プロセスの AppData の新しいファイル・フォルダーと HKCU への書き込みを、パッケージごとの場所へ移す。そのため次のことが起きた。

- Electron の userData がパッケージごとの場所に置かれる。safeStorage の鍵（`Local State`）もそこにあり、暗号文は共有の `~/.agent-host` にある。NSIS 版と Store 版で互いに秘密を復号できず、Store 版を消すと鍵が消える。
- エージェントの CLI とシェルもパッケージの中で走る。エージェントが入れた道具・設定のうち、AppData の新しいフォルダーと HKCU に書いたものは、ほかのアプリから見えず、アンインストールで消える。

仮想化を切る `unvirtualizedResources` は制限付きの capability で、Microsoft の文書は「一部のゲームと外部の場所で入れるアプリのためのもので、ほかの用途は想定していない」と書く。

## 決定

- **別の設定で作る**: Store 用は `electron-builder.store.cjs`（`appx` ターゲット）。NSIS の設定と配布の流れは変えない。appId・`Ply.exe`・`agent-host` は NSIS と同じ（[ADR 0019](0019-rename-ply-to-pleiad-keep-identifiers.md)）。Store が割り当てる Identity の値は環境変数で渡し、コードに書かない。Store には正式な版だけを出す（`-beta.N` の版は同じ 4 桁の番号になる）。
- **更新は Store に任せる**: Store の版（焼き込んだ `plyStore: true`、または `process.windowsStore`）では electron-updater を使わない。画面は Store で更新する案内を出す。
- **AUMID とジャンプリスト**: パッケージの識別子があれば `jp.ply.desktop` の AUMID を付けず、Windows が付けるパッケージの AUMID に任せる。ジャンプリストと、外に残す起動口は App Execution Alias（`Ply.exe`）を指す。
- **MCP の貼り付け用設定**: Store 版（`plyStore` または `process.windowsStore`）は manifest の App Execution Alias を起動する。`-e` の入口が起動した現在の版の `process.execPath` から `resources\app\bin\pleiad.mjs` を探す。設定には版ごとの実行ファイルとスクリプトのパスを残さない。
- **生成内容の報告**: AI の返答のメニューから Pleiad 開発者の GitHub Issue 作成画面を開く。Pleiad は利用者自身の AI CLI を動かすホストだが、Store ポリシー 11.16 の報告先はアプリの開発者とする。会話本文は自動で載せず、共有内容は利用者に選んでもらう。開発者は報告を確認し、Pleiad の問題なら直し、モデル・CLI の問題なら提供元への報告を案内する。
- **仮想化は切る申請をする（未決）**: 最初の提出で `unvirtualizedResources` を申請し、`desktop6:FileSystemWriteVirtualization`・`desktop6:RegistryWriteVirtualization` を `disabled` にする。理由として、利用者の PC で利用者の CLI を動かす開発の道具であり、エージェントの作業の結果が利用者のほかのアプリから見える必要があることを書く。
- **却下されたとき（未決）**: 仮想化を残したまま、次の 2 つで補う。
  - userData を AppData の外に置き、NSIS 版の `Local State` を写して safeStorage の鍵を引き継ぐ。
  - エージェントの CLI とシェルを、`PROC_THREAD_ATTRIBUTE_DESKTOP_APP_POLICY`（`BREAKAWAY_ENABLE_PROCESS_TREE`）を付けた `CreateProcessW` で起こす。パッケージの外の実行ファイルに付ければ子も孫もパッケージの外で走ることは確かめた。Node の `child_process` と node-pty はこの属性を渡せないので、起動の部分を作り直す。

## 理由

- Store の署名は利用者の PC に最初から信頼される。SmartScreen の警告を無くす手段のうち、費用が掛からず個人で使えるのはこれだけ。
- 別の設定にするのは、NSIS の配布（署名の検査・更新フィード・段階配信）を Store の都合で崩さないため。
- 更新を止めるのは、MSIX の入れ先が読み取り専用で、electron-updater では更新できないため（NSIS を別に入れることになる）。
- 仮想化を切る案を先にするのは、manifest の数行で、NSIS 版と同じ振る舞い（userData・safeStorage の共有、エージェントの書き込みが本物の場所）になることを確かめたから。却下されたときの案は、エージェントの起動のすべて（Claude の SDK・Codex の app-server・Antigravity・node-pty のシェル・`!` の行）に手が入る。
- 採らなかった案:
  - `uap10:RuntimeBehavior="win32App"`。仮想化が無くなり子プロセスも外で走ったが、Microsoft のメンテナーは `unvirtualizedResources` が要ると述べており、申請の重さは同じ。Store での扱いの文書も少ない。
  - 仮想化を残して何もしない。エージェントが入れた道具・設定が利用者のターミナルから見えないのは、Pleiad の目的（利用者の PC で作業させる）と合わない。

## 影響

- `npm run desktop:store` で Store 用の MSIX を作る。CI のジョブはまだ無い。
- Store の版で新しくコピーする MCP 設定はエイリアスを使う。以前コピーした版番号入りの設定は利用者が貼り直す必要がある。
- 同じ PC に NSIS 版と Store 版を両方入れると、スタートメニューに Pleiad が 2 つ並ぶ。`~/.agent-host` は共有で、同時には 1 つしか動かない。Store へ移った利用者には NSIS 版のアンインストールを案内する。
- 審査では、外部の CLI への依存・生成 AI・computer use・シェルの起動（Windows 10 S）と、AI の返答から報告する手順を説明する（[microsoft-store.md](../microsoft-store.md)「Store の審査とポリシー」）。
