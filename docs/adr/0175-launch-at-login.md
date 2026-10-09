# ADR 0175: OS にサインインしたら Pleiad を起動する

- 状態: 採用
- 日付: 2026-10-09
- 関連: [ADR 0146](0146-remote-agent-delegation.md)、[ADR 0167](0167-chrome-connection-held-across-updates.md)、[無停止の更新](../zero-downtime-update/design.md)、[remote.md §6.3](../remote.md)、[desktop-releases.md](../desktop-releases.md)

## 背景

PC を委譲のホストにしていると（ADR 0146）、その PC が再起動したあと Pleiad が起動しない限り、依頼元の委譲は止まったままになる。これまで自動起動は無く、remote.md §6.3 に「まだ作っていない」とだけ書いていた。

## 決定

1. 設定は 1 つだけ。設定 › リモート › 常駐の「サインイン時に Pleiad を起動する」。既定はオフ。ローカルのデスクトップ窓だけに出し、リモートの窓・Store 版・開発起動・Linux には出さない。
2. 持ち主は OS。`app.setLoginItemSettings` で登録し、画面の状態は開くたびに `app.getLoginItemSettings` で読み直す。Pleiad は別に覚えないので、設定アプリ・タスクマネージャー・レジストリの削除で外されれば画面もオフになる。タスクマネージャーで無効にされているときは「オフ」と別に、その旨の一文を出す。
3. 登録するのは版に依らない起動用の exe（`process.execPath` = インストーラーが置く `$INSTDIR\Ply.exe`）と引数 `--hidden`。無停止の更新（ADR 0167）でも main は同じ `Ply.exe` から起動し、版ごとの実行場所（`agent-host-runtime\app\<版>`）で動くのはサーバーだけなので、更新しても登録は無効にならない。それでも入れ先を変えた再インストールで古いパスが残る場合に備え、起動のたびに、自分の値（名前が AUMID・user スコープ）のパスや引数が今と違えば今のものへ書き直す。登録が無い人には書かない。無効にされた登録は無効のまま直す。
4. `--hidden` の起動は窓を前面に出さない。トレイに残る状態（リモート常駐・ルーティン）なら窓は出さず、トレイが無ければ最小化してタスクバーに置く（通常の `show()` は呼ばない）。2 つ目の起動（`second-instance`）が `--hidden` のときも窓を出さない。`app.relaunch` は `--hidden` を引き継がない（画面から再起動したときは窓を出す）。macOS は引数を持たないので `wasOpenedAtLogin` で判定する。
5. `ply_control` の設定 `launchAtLogin`（真偽）でも読み書きできる。サーバーは main に `{ type:'login-item' }` で頼む（`core/login-item.mjs` ↔ `desktop/login-item.cjs`）。常駐の入口を増やす設定なので risk は `guarded`。使えない構成でのオンは INVALID で断る。
6. リモートの受付がオンでサインイン時の起動がオフなら、同じ欄に 1 行だけすすめる。別の画面や確認は足さない。

## 対象外

- Microsoft Store（MSIX）の版: スタートアップはパッケージの宣言で決まり、Run には書けない。
- 更新後にインストーラーが起こす Pleiad は `--hidden` なしで窓を出す（更新の完了を見せるため）。
- NSIS のアンインストールで Run の値を消す処理は足していない。Electron の登録値の名前を実機で確かめられないため。残っても `Ply.exe` が無ければ何も起きない。
