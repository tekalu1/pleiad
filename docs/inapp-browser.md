# 内蔵ブラウザー

会話の右パネルで Web ページを見る（[ADR 0041](adr/0041-inapp-browser-beside-conversation.md)）。エージェントが立てた開発サーバー（localhost）や会話のリンクを、会話を離れずに開く。機能はタブ・戻る/進む・再読み込み・アドレス欄・DevTools・別の窓に出す・既定のブラウザーで開くに限る。ブックマーク・履歴の検索・拡張・パスワード管理・ダウンロードの管理は持たない。

## エージェントの操作

デスクトップ版では、会話ごとに鍵付きの loopback WebSocket CDP 中継を開く（[ADR 0043](adr/0043-agent-browser-via-per-session-cdp-relay.md)）。中継は `webContents.debugger` を使い、その会話の内蔵ブラウザーのタブだけを `Target` として返す。Pleiad 本体の画面や別会話のタブは返さない。接続先の準備（ターンの開始）ではタブを作らず、エージェントが実際に WebSocket でつないだときに、その会話のタブが 0 枚なら空のタブを 1 枚作る（使わないターンや委譲した子の会話で空のタブが増えない）。`Target.createTarget` はその会話の新しいタブを作り、`Browser.close` などブラウザー全体に効くコマンドは拒否する。Electron の `--remote-debugging-port` は開かない。

utilityProcess のサーバーは parentPort でメインプロセスに接続先を頼む。`<data>/agent-browser/<会話の初期 ID の SHA-256>/agent-browser.json` に `cdp` URL を書き、エージェントのシェルへ `AGENT_BROWSER_CONFIG` と `AGENT_BROWSER_SESSION` を渡す。デスクトップ版でない `npm start` には渡さない。Claude は SDK の会話別 env、Codex は共有 app-server の `thread/start`・`thread/resume` に渡す会話別の `shell_environment_policy.set`、Antigravity は会話別プロセスの env を使う。接続方法は会話のエージェント向け指示にも入る。`agent-browser` は同梱した OS のネイティブ本体を PATH から呼ぶ。

中継を使うと右パネルを開き、操作中のタブに印を付け、道具の列の下に「<エージェント名> が操作中」と「止める」「引き継ぐ」を数秒表示する。「止める」は接続を切り、次の人の送信まで再接続を拒否する。「引き継ぐ」は接続を切って表示を消し、再接続は許す。会話のツール履歴はシェル実行として残る。

デーモンの管理ファイルは Windows では OS の一時領域の `ply-ab-<ハッシュ>/`、Unix では `/tmp/ply-ab-<uid>/<ハッシュ>/` に作り、`AGENT_BROWSER_SOCKET_DIR` で全バックエンドへ渡す。既定の `~/.agent-browser` は Codex の `workspace-write` では書けないため、既定で書ける一時領域を使う。Codex の thread config と turn の sandboxPolicy にブラウザー用の書き込みルートは追加しない。読み取り専用モードでは、ファイルへの書き込みが必要なブラウザー操作はできない旨をエージェントへ指示する。利用者が `exclude_tmpdir_env_var`（Windows の TEMP/TMP を含む）や `exclude_slash_tmp`（Unix）で一時領域を除外した場合、その制限は変更しないため操作できない場合がある。

`AGENT_BROWSER_SESSION` と一時領域のハッシュは設定フォルダーの絶対パスから作り、会話とデータ置き場を区別し、ネイティブ ID の確定後も変えない。Unix では長い TMPDIR による 104 バイトのソケットパス制限を避けるため、常に短い `/tmp` を使う。Windows の agent-browser 0.38.1 は loopback TCP を使い、PID・ポート等のファイルを一時領域に置く。継承した `AGENT_BROWSER_NAMESPACE` は空にして、指定した置き場が変わらないようにする。

agent-browser 0.38.1 の state ルートには専用の変更変数がない。`AGENT_BROWSER_STATE` は読み込む state ファイルの指定であり、保存先の指定ではない。この CDP 接続では自動 state 保存を設定せず、Cookie 等は Electron の保存領域を使う。Claude・Antigravity にも同じ env を渡す。Claude の Bash sandbox を利用者が有効にしている場合、書き込み先と loopback 接続の許可はその sandbox の設定にも必要で、Pleiad は設定を自動で緩めない。

同じ `persist:pleiad-browser` のタブは会話が違っても Cookie を共有する。中継は主フレームのページと通常のタブ操作を対象とし、OOPIF・service worker・DevTools の同時接続などを CDP の完全なブラウザーとしては公開しない。Codex の読み込み済みスレッドは `thread/resume` の新しい config を無視する場合がある。新規会話のネイティブ ID が決まった後も、最初に渡した設定ファイルと `AGENT_BROWSER_SESSION` を保ち、接続鍵の変更は同じファイルを書き換えて届ける。

## 使える場所

デスクトップ版のホストの画面（ローカルの窓）だけ。ブラウザーで開いた Pleiad・リモートの窓・スマホには内蔵ブラウザーのモードを出さない（ホストの内蔵ブラウザーを画面の転送で見ることはできる。下の「リモートから見る」）。設定 › ブラウザーはすべての画面に出す。画面は `window.plyDesktop.browser` の有無と `window.plyRemote` が無いことで判断する（`web/browser-panel.mjs` の `browserPanelAvailable`）。リモートの窓の preload（`desktop/remote-preload.cjs`）には口を出さず、main も `ply:browser` を受ける前にローカルの窓の本体フレームかを確かめる（`desktop/window-trust.cjs`）。

## リモートから見る

ホストの画面ではない端末（リモートの窓・モバイル版・LAN のブラウザー）から、ホストの内蔵ブラウザーを見て操作する（ADR 0041 の最後の項、形は docs/design-system.md「リンクの開き先のシート・PC のブラウザーを見る画面」）。ホストがデスクトップ版のときだけ。`npm start` のホストには内蔵ブラウザーが無いので出さない（`hostCapabilities` の `pcBrowser` が false）。

- リンクの開き先: 会話の外部リンク・プレビューの中のリンク・可視化の「ブラウザーで開く」を押すと、下からのシートで「この端末で開く / PC のブラウザーで見る」を選ぶ（`web/link-sheet.mjs` の `linkChoices`）。localhost・ループバックの URL は「PC のブラウザーで見る」だけ（端末で開くと端末自身を指す）。「この端末で開く」は今までの行き先（docs/remote.md §8.5）。可視化の写しは両方を出し、PC で見るときはサーバーが写しを書き出して `file:` で開く（端末から `file:` の URL は受けない）。ホストの画面ではシートを出さない。
- PC のブラウザーで見る: 全面の表示（`web/remote-browser.mjs`）。その会話の内蔵ブラウザーのタブで見る。URL があれば新しいタブで開き、無ければエージェントが操作中のタブか、その会話の最初のタブ（無ければ空のタブを作る）。
- 画面の転送（`desktop/browser-screencast.cjs`）: タブの `webContents.debugger` で `Page.startScreencast`（JPEG）を回す。debugger はエージェントの CDP 中継と共有し、中継はエージェント自身が始めていない画面のフレームを流さない。見ている間はビューポートを端末の表示の大きさにし（`Emulation.setDeviceMetricsOverride`、倍率は画質「自動」で 2 まで・「低」で 1）、`setBackgroundThrottling(false)` で覆われた窓・最小化した窓でも描かせる。タブが窓に載っていないと描かれないので、パネルに出ていないタブは窓の外に 1px で載せる（`panel.pin`）。窓が隠れている（常駐で閉じた）ときは、見られている間だけ最小化で出し、終われば隠し直す。止めるとビューポートと描き方を戻す。別の文書へ移るたびに送信をかけ直す（描く側が替わると止まることがある）。
- 送る頻度（`core/browser-screencast.mjs`）: Chromium は変化があったときだけフレームを出し、ack を返すまで次を出さない。worker は、見ている端末がみな描き終えた（`browserScreencastAck`。返事が無ければ 3 秒）うえで、前のフレームから最短の間隔（自動 200ms・低 500ms）が過ぎたら ack を返す。回線の遅い端末では自然に頻度が下がる。フレームは WS の `{ kind: "screencast" }` で見ている接続にだけ送る。新しいポートは開けず、リモートは中継の既存の WS 経路を通る。
- 入力: タップはマウスの移動・押す・離す、ドラッグとホイールは `mouseWheel`、文字は `Input.insertText`、キーは Enter・Backspace・Tab・Escape・Delete・矢印だけ（`Input.dispatchKeyEvent`）。座標は端末がフレームの `metadata`（`deviceWidth` / `deviceHeight`）と画像の表示の大きさから CSS px に変換する（`toPageCoords`）。ほかに戻る・進む・再読み込み・止める・URL を開く（http・https だけ）。入力と移動は人の操作としてエージェントの操作を解除する（「サイトの利用の確認」）。
- エージェントとの関係: エージェントが中継で操作中（`panel.agentFor`）は、端末では見るだけで、入力と移動は断る（`agent-active`）。端末の「引き継ぐ」でエージェントの接続を切ってから操作できる。「止める」は次の人の送信まで再接続を断る（どちらも「エージェントの操作」と同じ意味）。
- 止める: 端末が閉じる・接続が切れる・見る端末がいなくなると止める。タブが閉じる・DevTools で debugger が外れると端末へ終わりを知らせる。
- 口: WS の `browserScreencast`・`browserScreencastStop`・`browserScreencastAck`・`browserScreencastInput`・`browserScreencastNav`・`browserScreencastAgent`（`core/protocol.mjs`）。リモートの接続（ADR 0010 の `isLocalRequest` が false）からだけ受け、ホストの画面からは `remote-only` で断る。入力・移動・エージェントの操作は、その会話を見ている接続からだけ。worker と main の間は parentPort（`desktop/browser-screencast-bridge.cjs`）。
- 帯域の実測（2026-09-28、390×712 の表示、毎 50ms 数字が変わるページ）: 自動は 1 枚 約 9 KB（780×1424）、約 4 fps、約 290 kbit/s。低は 1 枚 約 3.5 KB（390×712）、約 1.8 fps、約 50 kbit/s。変化の無い間は 0 枚。WS では base64 と JSON で約 1.35 倍になる。
- 画面に映る秘密（ログイン中のページなど）も中継を通る。中身は中継で E2E（docs/remote.md §9）だが、ペアリングした端末はホストのブラウザーのログインをそのまま使える。

## 仕組み

- ページは Electron の `WebContentsView`。本体の窓に重ね、右パネルの本文の枠（`.browser-viewport`）の位置と大きさに合わせる（`desktop/browser-panel.cjs`）。`<webview>` は使わない。
- 画面は枠の位置（CSS の px）を `ply:browser-layout` で送る。ResizeObserver・窓の大きさの変化・パネルの幅の変更（`layout()`）で測り直し、同じ値は送らない。main は画面の倍率を掛け、角の丸み（本文の `--r-m`）も合わせる。広げる・幅の変更・760px 以下の全面表示でも同じ経路で追う。
- タブごとに View を 1 つ持ち、窓に載せるのは今のタブだけ。ほかのタブは外したまま動き続ける。空のタブ（新しいタブ）は View を載せず、画面が「URL を入力して開きます」を出す。
- 保存領域は `persist:pleiad-browser`。Pleiad 本体（既定の session）とリモートの窓（`persist:remote-<id>`）から分けるので、ページのスクリプトや Cookie は Pleiad の認証に届かない。一度ログインすれば次回も残る。
- `webPreferences` は `contextIsolation`・`sandbox`・`nodeIntegration: false`、preload なし。権限の要求（カメラ・マイク・位置・通知など）は確認を出さずに断る。UA から `Electron/…` と Pleiad の印を外す（ログインを断るサイトがあるため）。
- `target="_blank"` など通常の新しい窓の要求は新しいタブで開く（opener の関係は保たない、ADR 0041 の通り）。ただし、`window.open` でポップアップ（`features` 付き）として要求された窓は、ログイン等の連携（opener・`window.close()` 等）に要るため、例外として別の小さな窓で開く。どちらもページから `file:` や独自のスキームへは移らない。開けるのは http・https と、画面が明示した `file:`。
- ダウンロードは確かめずに OS の既定のダウンロードの場所へ保存する（同じ名前があれば「名前 (2)」）。
- 閉じる（×・Esc）とパネルを隠すだけで、タブは main に残る。もう一度開くと同じタブが出る。最後のタブを閉じるとパネルも閉じる。会話を切り替えてもブラウザーのパネルは開いたまま（タブの列は切り替わる。次の「会話とタブ」）。

### ネイティブの View と重なり

View は DOM より上に描かれるので、メニュー・ダイアログ・画面下の知らせが本文の枠に重なると、そのままでは View の下に隠れる。重なっている間は、main が今の見た目を `capturePage` で画像にして画面へ返し、View を外す。画面はその画像を同じ位置に置く（`freeze` / `unfreeze`）。重なりの判定は `dialog[open]`（モーダルなら位置によらず）・`.pop`（メニュー・入力欄の面）・`.file-toast`・`.rm-dialog`・`.fu-drop` のうち、本文の枠と交わる見えているもの。body の直下への追加と `hidden`・`open` の出し入れを MutationObserver で見る（ブラウザーのモードが見えている間だけ）。画像の間はページを操作できない。設定を開く・ほかのモードへ移る・閉じるときは View を外す。

## 画面

入口は会話の頭の行の地球のボタン（`#browserEntry`、`web/header-entries.mjs`。見た目は [design-system](design-system.md)「会話の頭の行のアイコン」）と、近道 Ctrl+Shift+B（macOS は ⌘⇧B）。どちらも右パネルのブラウザーを開閉する。開くときは前のタブをそのまま出し（読み直さない）、タブが無ければ空の新しいタブを作ってアドレス欄にフォーカスを置く。閉じるとフォーカスはボタンへ戻る。近道は IME の変換中・ダイアログ・設定の画面では効かない。ページにフォーカスがあるときは main がタブの webContents の `before-input-event` でこの近道だけを拾って `preventDefault` し（離したとき・押しっぱなしの繰り返し・ほかのキーはページへ渡す。別の窓に出したタブでは拾わない）、本体の画面へフォーカスを戻して `ply:browser-shortcut` で知らせる。ボタンはブラウザーを表示中は `aria-pressed`、エージェントがこの会話のタブを操作している間は走っている弧を付ける。

右パネルの 1 つのモード（`web/side-panel.mjs` の `browserSlots`）。見出し「ブラウザー」、頭の行は広げる・閉じる。見出しの下にタブの列（小さく、×・新しいタブ）。道具の列は戻る・進む・再読み込み（読み込み中は止める）・アドレス欄・既定のブラウザーで開く（常に）・⋯（DevTools・別の窓に出す・このサイトのデータを消す）。種類の印・切り替え・ツリー・下の行は出さない。形は docs/design-system.md「内蔵ブラウザー」。

アドレス欄（`web/browser-address.mjs`）:
- 入力して Enter で開く。スキームが無ければ https、この PC（`localhost`・`*.localhost`・`127.0.0.0/8`・`[::1]`）は http。`localhost:5173` はスキームではなくホストとポートとして読む。
- 語だけ（ドットの無いもの）・空白を含むもの・http/https/file 以外のスキーム・ユーザー情報付きの URL は開かず、知らせを出す。検索はしない。
- 触れていない間はスキームと残りを弱く、ホスト名を強くする。左の印は https が鍵、この PC が PC の記号、http が注意の円、PC のファイルは紙。

⋯ の項目:
- DevTools: そのタブの DevTools を別の窓で開く。
- 別の窓に出す: そのタブの View を独立した窓（道具の列の無い窓）へ移し、パネルの一覧から外す。窓を閉じるとページも閉じる。
- このサイトのデータを消す: 今のページのオリジンの保存領域と、そのページへ送られる Cookie を消して読み直す。

既定のブラウザーで開く は、http・https のページ（`shell.openExternal`）と、画面が明示して開いた `file:` の HTML（右パネルの「ブラウザーで開く」で開いた HTML ファイル・可視化の写し）で押せる。押せるかは main が決め、タブの状態の `external` で画面へ送る。`file:` は、そのタブが画面から開いた URL（`allowFile`）と同じファイルで拡張子が `.html`・`.htm` のときだけで、URL をパスに直し、実体を解決して HTML のファイルであることを確かめてから `shell.openPath` で開く（シェルは通さない）。連打はサーバーの `openPath` と同じく 10 秒に 5 回まで。ページの中で移った先の `file:`、HTML 以外、`about:blank` は押せない。

## 設定 › ブラウザー

「リンクの開き先: 内蔵ブラウザー / 既定のブラウザー」。既定は内蔵ブラウザー。値はサーバーの `prefs.json` の `linkOpen`（`inapp` | `external`）で、`setPref` で保存し、`prefs` イベントでほかの画面にも届く。内蔵ブラウザーを使えない画面ではリンクの開き先の選択を出さない。リンクの開き先は `linkOpenTarget({ available, prefs })` で決め、使えない画面では設定によらず `external`（今どおり新しいタブか既定のブラウザー）。「エージェントの操作」には同梱した `agent-browser` の版を示す。


### 確認

「外部の読み込みの前に確認」（`confirmExternalLoads`）と「エージェントがサイトを使う前に確認」（`confirmAgentSites`）は既定 OFF。後者とリンクの開き先は内蔵ブラウザーがある画面だけに出す。外部読み込みの確認はブラウザーで開いた画面・リモート・デスクトップでないホストでも使える。

ON のとき「許可したサイト」を表示し、止めた出どころを「許可」付きで上に並べ、その下に外部の読み込みとエージェントの利用の一覧を分ける。各行は「常に / 毎回聞く」と「消す」。前者は `externalSitePermissions: [{origin, mode}]`、後者は `agentSitePermissions: [{agent, origin, mode}]`（`mode` は `always` / `ask`）に保存する。origin はスキーム・ホスト・ポートの完全一致で、外部資源は HTTPS のみ、サイトの利用は HTTP も含む。設定は `setPref` で保存し、接続中の画面にも反映する。

### サイトの利用の確認

ON のとき、エージェントが別の origin へ移る前に中継の `Page.navigate` と新しいタブの作成を保留する。ページ内の遷移・リダイレクト・新しい窓は Electron の `will-frame-navigate`・`will-redirect`・`setWindowOpenHandler` で止め、承認後に移動する。確認は `desktop/browser-navigation.cjs`、会話への受け渡しは `core/browser-confirm.mjs` が担当する。

会話の承認カードに「<エージェント名> が <サイト> を使おうとしています」と「一度だけ / このサイトは常に / 断る」を出す。ログイン中のアカウント名が分かるときだけ「（ログイン済み: <アカウント>）」を添える。現在は GitHub の表示名 Cookie とログイン済みの印から読む。他のサイトの認証 Cookie から名前を推測しない。

「一度だけ」はその移動を通す。同じ origin 内の移動は聞き直さず、離れて戻れば再度聞く。「このサイトは常に」はエージェントの種類と origin の組で記録し、同じエージェントの別の会話にも効く。「断る」は中継の失敗として返す。承認待ちは通常の permission と同じ管理に入り、委譲元にもカードを出し、委譲の待機時計も承認待ちとして扱う。中断・タブの破棄・「止める」「引き継ぐ」では保留を取り消す。

人がアドレス欄・戻る/進む・再読み込みを操作したときや、ページへ入力したときはエージェントの操作を解除し、人の遷移には確認を挟まない。ターン終了でも解除する。送信・購入・削除などの操作ごとの確認は持たない（[ADR 0042](adr/0042-preview-loads-external-by-default.md)）。

## 画面から呼ぶ口

- `browserPanelAvailable()`: 使える画面か。
- `openInBrowserPanel(url, { newTab })`: 右パネルをブラウザーにして開く。url はアドレス欄と同じ規則で直し、開けなければ何もせず false。url を省くと空の新しいタブ。
- アプリの中の外部リンク（会話・作業のダイアログ・右パネルの Markdown の `a.md-link[target=_blank]`。文中の裸の URL・インラインコード全体の URL・取得の見出しを含む。形は docs/design-system.md「文中の URL」）とプレビュー（可視化・HTML ファイル）の中のリンクは、`web/link-open.mjs` の `openExternalLink` に集まり、開き先が内蔵ブラウザーなら新しいタブで開く（ダイアログの中のリンクはダイアログを閉じてから）。Ctrl/⌘+クリックと中クリック（`auxclick`）は既定のブラウザー（ADR 0041）。右クリック・長押し・Shift+F10 のメニュー（`web/link-menu.mjs`）は「内蔵ブラウザーで開く」（`openExternalLink` の `inapp`）と「既定のブラウザーで開く」（`external`）を選べる。既定のブラウザーへは殻の `openExternal`（http/https、userinfo 無し）で渡すので、本体の窓の `setWindowOpenHandler` が通さない http の localhost も開ける。使えない画面（ブラウザーで開いた Pleiad・リモートの窓）は今どおり新しいタブ。
- 「ブラウザーで開く」（HTML ファイル・可視化の写し）も「リンクの開き先」に従う。内蔵ブラウザーが使えるホストの画面で設定が内蔵ブラウザーなら、検査済みの HTML ファイル、または会話に保存された可視化の写しを `file:` URL で新しいタブに開く。HTML ファイルでは同じフォルダーの相対資源を読める。可視化の写しには文書の meta の CSP が付く。使えない画面と既定のブラウザーを選んだ画面では従来の開き先を使う。アドレス欄は `file:` を「PC のファイル」と表示する。

## main の口

`desktop/preload.cjs` の `plyDesktop.browser`:
- `command(action, args)` → `ply:browser`（invoke）。`open`・`newTab`・`select`・`close`・`back`・`forward`・`reload`・`stop`・`devtools`・`external`・`detach`・`clearSiteData`・`freeze`・`unfreeze`・`context`・`state`・`agentStop`・`agentTakeOver`。
- `layout({ visible, rect, radius })` → `ply:browser-layout`。
- `onState(listener)` ← `ply:browser-state`（タブの一覧・今のタブ・URL・題・読み込み中・戻れるか/進めるか・操作中のエージェント）。
- `onShortcut(listener)` ← `ply:browser-shortcut`（ページにフォーカスがあるときに押された開閉の近道）。

### 会話とタブ

タブは開いたときに画面で開いていた会話（`sessionId`）を覚える。画面は開く・会話を切り替えるたびに `context` で今の会話を知らせ、`window.open` で開いたタブは元のタブの会話を引き継ぐ。パネルの一覧（`ply:browser-state` と `state`）と今のタブは、今の会話のタブと、会話に属さないタブ（`sessionId` が null）だけ。会話を切り替えると（`context`）、その会話で最後に選んだタブ、なければ見えるタブの先頭、なければ今のタブなしにし、窓に載せる View も替える。別の会話のタブをエージェントが作る・前に出しても、今の画面のタブと窓は動かない。新しい会話の最初のターンは会話 ID が無いので、タブは `turn.key` の会話に付き、ID が決まったところで本物の ID へ付け替える（`rebind`。画面も同じ時点で `context` を本物の ID に替える）。main の `createBrowserPanel` は `tabsFor(sessionId)`（その会話のタブと webContents）と `contentsOf(tabId)` を返し、会話別の CDP 中継はここから webContents の debugger へつなぐ（[ADR 0043](adr/0043-agent-browser-via-per-session-cdp-relay.md)）。

## 検証

`tests/unit/inapp-browser.mjs`（右パネルの表・アドレス欄・リンクの開き先・使える画面・preload・偽の electron での main のタブと位置）と `tests/unit/server-ux.mjs`（`linkOpen` の保存）。実機は fake バックエンドのデスクトップ版を別のデータ置き場と userData で起動し、http://example.com と手元の localhost のページで、タブ・戻る/進む・新しい窓・DevTools・既定のブラウザーで開く（呼ばれたことだけを記録）・メニューとの重なり・幅の変更・全面表示・別の窓を確かめた（2026-09-27）。`file:` の HTML（相対の CSS 付き）では、既定のブラウザーで開くが押せて実体のパスで `shell.openPath` が呼ばれること（呼ばれたことだけを記録）、ページのリンクで別の `file:` へ移った後と `.png` では押せないことを確かめた（2026-09-28）。

リモートから見るは `tests/unit/remote-browser-view.mjs`（間引き・止める条件・ローカルの接続と見ていない接続とエージェント操作中の断り・入力の変換・座標の変換・シートの出し分け）。実機は fake バックエンドのデスクトップ版を一時のデータ置き場と userData で起動し、`X-Forwarded-For` を足すプロキシ越しに携帯の大きさの Chromium で開いて、シートの出し分け・画面が届く・タップでボタンが押せる・文字と Enter・戻る・ドラッグでスクロール・アドレス欄・画質の切り替え・閉じると止まる・ローカルの接続からは断ることを確かめた（2026-09-28）。
