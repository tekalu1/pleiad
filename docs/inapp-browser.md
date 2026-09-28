# 内蔵ブラウザー

会話の右パネルで Web ページを見る（[ADR 0041](adr/0041-inapp-browser-beside-conversation.md)）。エージェントが立てた開発サーバー（localhost）や会話のリンクを、会話を離れずに開く。機能はタブ・戻る/進む・再読み込み・アドレス欄・DevTools・別の窓に出す・既定のブラウザーで開くに限る。ブックマーク・履歴の検索・拡張・パスワード管理・ダウンロードの管理は持たない。

## エージェントの操作

デスクトップ版では、会話ごとに鍵付きの loopback WebSocket CDP 中継を開く（[ADR 0043](adr/0043-agent-browser-via-per-session-cdp-relay.md)）。中継は `webContents.debugger` を使い、その会話の内蔵ブラウザーのタブだけを `Target` として返す。Pleiad 本体の画面や別会話のタブは返さない。タブが無ければ最初の接続先を準備するときに空のタブを作る。`Target.createTarget` はその会話の新しいタブを作り、`Browser.close` などブラウザー全体に効くコマンドは拒否する。Electron の `--remote-debugging-port` は開かない。

utilityProcess のサーバーは parentPort でメインプロセスに接続先を頼む。`<data>/agent-browser/<会話の初期 ID の SHA-256>/agent-browser.json` に `cdp` URL を書き、エージェントのシェルへ `AGENT_BROWSER_CONFIG` と `AGENT_BROWSER_SESSION` を渡す。デスクトップ版でない `npm start` には渡さない。Claude は SDK の会話別 env、Codex は共有 app-server の `thread/start`・`thread/resume` に渡す会話別の `shell_environment_policy.set`、Antigravity は会話別プロセスの env を使う。接続方法は会話のエージェント向け指示にも入る。`agent-browser` は同梱した OS のネイティブ本体を PATH から呼ぶ。

中継を使うと右パネルを開き、操作中のタブに印を付け、道具の列の下に「<エージェント名> が操作中」と「止める」「引き継ぐ」を数秒表示する。「止める」は接続を切り、次の人の送信まで再接続を拒否する。「引き継ぐ」は接続を切って表示を消し、再接続は許す。会話のツール履歴はシェル実行として残る。

デーモンの管理ファイルは Windows では OS の一時領域の `ply-ab-<ハッシュ>/`、Unix では `/tmp/ply-ab-<uid>/<ハッシュ>/` に作り、`AGENT_BROWSER_SOCKET_DIR` で全バックエンドへ渡す。既定の `~/.agent-browser` は Codex の `workspace-write` では書けないため、既定で書ける一時領域を使う。Codex の thread config と turn の sandboxPolicy にブラウザー用の書き込みルートは追加しない。読み取り専用モードでは、ファイルへの書き込みが必要なブラウザー操作はできない旨をエージェントへ指示する。利用者が `exclude_tmpdir_env_var`（Windows の TEMP/TMP を含む）や `exclude_slash_tmp`（Unix）で一時領域を除外した場合、その制限は変更しないため操作できない場合がある。

`AGENT_BROWSER_SESSION` と一時領域のハッシュは設定フォルダーの絶対パスから作り、会話とデータ置き場を区別し、ネイティブ ID の確定後も変えない。Unix では長い TMPDIR による 104 バイトのソケットパス制限を避けるため、常に短い `/tmp` を使う。Windows の agent-browser 0.38.1 は loopback TCP を使い、PID・ポート等のファイルを一時領域に置く。継承した `AGENT_BROWSER_NAMESPACE` は空にして、指定した置き場が変わらないようにする。

agent-browser 0.38.1 の state ルートには専用の変更変数がない。`AGENT_BROWSER_STATE` は読み込む state ファイルの指定であり、保存先の指定ではない。この CDP 接続では自動 state 保存を設定せず、Cookie 等は Electron の保存領域を使う。Claude・Antigravity にも同じ env を渡す。Claude の Bash sandbox を利用者が有効にしている場合、書き込み先と loopback 接続の許可はその sandbox の設定にも必要で、Pleiad は設定を自動で緩めない。

同じ `persist:pleiad-browser` のタブは会話が違っても Cookie を共有する。中継は主フレームのページと通常のタブ操作を対象とし、OOPIF・service worker・DevTools の同時接続などを CDP の完全なブラウザーとしては公開しない。Codex の読み込み済みスレッドは `thread/resume` の新しい config を無視する場合がある。新規会話のネイティブ ID が決まった後も、最初に渡した設定ファイルと `AGENT_BROWSER_SESSION` を保ち、接続鍵の変更は同じファイルを書き換えて届ける。

## 使える場所

デスクトップ版のホストの画面（ローカルの窓）だけ。ブラウザーで開いた Pleiad・リモートの窓・スマホでは、ブラウザーのモードも「設定 › ブラウザー」も出さない。画面は `window.plyDesktop.browser` の有無と `window.plyRemote` が無いことで判断する（`web/browser-panel.mjs` の `browserPanelAvailable`）。リモートの窓の preload（`desktop/remote-preload.cjs`）には口を出さず、main も `ply:browser` を受ける前にローカルの窓の本体フレームかを確かめる（`desktop/window-trust.cjs`）。

## 仕組み

- ページは Electron の `WebContentsView`。本体の窓に重ね、右パネルの本文の枠（`.browser-viewport`）の位置と大きさに合わせる（`desktop/browser-panel.cjs`）。`<webview>` は使わない。
- 画面は枠の位置（CSS の px）を `ply:browser-layout` で送る。ResizeObserver・窓の大きさの変化・パネルの幅の変更（`layout()`）で測り直し、同じ値は送らない。main は画面の倍率を掛け、角の丸み（本文の `--r-m`）も合わせる。広げる・幅の変更・760px 以下の全面表示でも同じ経路で追う。
- タブごとに View を 1 つ持ち、窓に載せるのは今のタブだけ。ほかのタブは外したまま動き続ける。空のタブ（新しいタブ）は View を載せず、画面が「URL を入力して開きます」を出す。
- 保存領域は `persist:pleiad-browser`。Pleiad 本体（既定の session）とリモートの窓（`persist:remote-<id>`）から分けるので、ページのスクリプトや Cookie は Pleiad の認証に届かない。一度ログインすれば次回も残る。
- `webPreferences` は `contextIsolation`・`sandbox`・`nodeIntegration: false`、preload なし。権限の要求（カメラ・マイク・位置・通知など）は確認を出さずに断る。UA から `Electron/…` と Pleiad の印を外す（ログインを断るサイトがあるため）。
- `target="_blank"`・`window.open` は新しいタブで開く（opener の関係は保たない）。ページから `file:` や独自のスキームへは移らない。開けるのは http・https と、画面が明示した `file:`。
- ダウンロードは確かめずに OS の既定のダウンロードの場所へ保存する（同じ名前があれば「名前 (2)」）。
- 閉じる（×・Esc）とパネルを隠すだけで、タブは main に残る。もう一度開くと同じタブが出る。最後のタブを閉じるとパネルも閉じる。会話を切り替えてもブラウザーのパネルは開いたまま。

### ネイティブの View と重なり

View は DOM より上に描かれるので、メニュー・ダイアログ・画面下の知らせが本文の枠に重なると、そのままでは View の下に隠れる。重なっている間は、main が今の見た目を `capturePage` で画像にして画面へ返し、View を外す。画面はその画像を同じ位置に置く（`freeze` / `unfreeze`）。重なりの判定は `dialog[open]`（モーダルなら位置によらず）・`.pop`（メニュー・入力欄の面）・`.file-toast`・`.rm-dialog`・`.fu-drop` のうち、本文の枠と交わる見えているもの。body の直下への追加と `hidden`・`open` の出し入れを MutationObserver で見る（ブラウザーのモードが見えている間だけ）。画像の間はページを操作できない。設定を開く・ほかのモードへ移る・閉じるときは View を外す。

## 画面

右パネルの 1 つのモード（`web/side-panel.mjs` の `browserSlots`）。見出し「ブラウザー」、頭の行は広げる・閉じる。見出しの下にタブの列（小さく、×・新しいタブ）。道具の列は戻る・進む・再読み込み（読み込み中は止める）・アドレス欄・既定のブラウザーで開く（常に）・⋯（DevTools・別の窓に出す・このサイトのデータを消す）。種類の印・切り替え・ツリー・下の行は出さない。形は docs/design-system.md「内蔵ブラウザー」。

アドレス欄（`web/browser-address.mjs`）:
- 入力して Enter で開く。スキームが無ければ https、この PC（`localhost`・`*.localhost`・`127.0.0.0/8`・`[::1]`）は http。`localhost:5173` はスキームではなくホストとポートとして読む。
- 語だけ（ドットの無いもの）・空白を含むもの・http/https/file 以外のスキーム・ユーザー情報付きの URL は開かず、知らせを出す。検索はしない。
- 触れていない間はスキームと残りを弱く、ホスト名を強くする。左の印は https が鍵、この PC が PC の記号、http が注意の円、PC のファイルは紙。

⋯ の項目:
- DevTools: そのタブの DevTools を別の窓で開く。
- 別の窓に出す: そのタブの View を独立した窓（道具の列の無い窓）へ移し、パネルの一覧から外す。窓を閉じるとページも閉じる。
- このサイトのデータを消す: 今のページのオリジンの保存領域と、そのページへ送られる Cookie を消して読み直す。

既定のブラウザーで開く は http・https のページだけ（`shell.openExternal`）。

## 設定 › ブラウザー

「リンクの開き先: 内蔵ブラウザー / 既定のブラウザー」。既定は内蔵ブラウザー。値はサーバーの `prefs.json` の `linkOpen`（`inapp` | `external`）で、`setPref` で保存し、`prefs` イベントでほかの画面にも届く。使えない画面では脇の項目も出さない。リンクの開き先は `linkOpenTarget({ available, prefs })` で決め、使えない画面では設定によらず `external`（今どおり新しいタブか既定のブラウザー）。「エージェントの操作」には同梱した `agent-browser` の版を示す。

## 画面から呼ぶ口

- `browserPanelAvailable()`: 使える画面か。
- `openInBrowserPanel(url, { newTab })`: 右パネルをブラウザーにして開く。url はアドレス欄と同じ規則で直し、開けなければ何もせず false。url を省くと空の新しいタブ。
- 会話の外部リンクとプレビュー（可視化・HTML ファイル）の中のリンクは、`web/link-open.mjs` の `openExternalLink` に集まり、開き先が内蔵ブラウザーなら新しいタブで開く。Ctrl/⌘+クリックと中クリック（`auxclick`）は既定のブラウザー（ADR 0041）。既定のブラウザーへは殻の `openExternal`（http/https、userinfo 無し）で渡すので、本体の窓の `setWindowOpenHandler` が通さない http の localhost も開ける。使えない画面（ブラウザーで開いた Pleiad・リモートの窓）は今どおり新しいタブ。
- 「ブラウザーで開く」（HTML ファイル・可視化の写し）も「リンクの開き先」に従う。内蔵ブラウザーが使えるホストの画面で設定が内蔵ブラウザーなら、検査済みの HTML ファイル、または会話に保存された可視化の写しを `file:` URL で新しいタブに開く。HTML ファイルでは同じフォルダーの相対資源を読める。可視化の写しには文書の meta の CSP が付く。使えない画面と既定のブラウザーを選んだ画面では従来の開き先を使う。アドレス欄は `file:` を「PC のファイル」と表示する。

## main の口

`desktop/preload.cjs` の `plyDesktop.browser`:
- `command(action, args)` → `ply:browser`（invoke）。`open`・`newTab`・`select`・`close`・`back`・`forward`・`reload`・`stop`・`devtools`・`external`・`detach`・`clearSiteData`・`freeze`・`unfreeze`・`context`・`state`・`agentStop`・`agentTakeOver`。
- `layout({ visible, rect, radius })` → `ply:browser-layout`。
- `onState(listener)` ← `ply:browser-state`（タブの一覧・今のタブ・URL・題・読み込み中・戻れるか/進めるか・操作中のエージェント）。

### 会話とタブ

タブは開いたときに画面で開いていた会話（`sessionId`）を覚える。画面は開く・会話を切り替えるたびに `context` で今の会話を知らせ、`window.open` で開いたタブは元のタブの会話を引き継ぐ。main の `createBrowserPanel` は `tabsFor(sessionId)`（その会話のタブと webContents）と `contentsOf(tabId)` を返し、会話別の CDP 中継はここから webContents の debugger へつなぐ（[ADR 0043](adr/0043-agent-browser-via-per-session-cdp-relay.md)）。

## 検証

`tests/unit/inapp-browser.mjs`（右パネルの表・アドレス欄・リンクの開き先・使える画面・preload・偽の electron での main のタブと位置）と `tests/unit/server-ux.mjs`（`linkOpen` の保存）。実機は fake バックエンドのデスクトップ版を別のデータ置き場と userData で起動し、http://example.com と手元の localhost のページで、タブ・戻る/進む・新しい窓・DevTools・既定のブラウザーで開く（呼ばれたことだけを記録）・メニューとの重なり・幅の変更・全面表示・別の窓を確かめた（2026-09-27）。
