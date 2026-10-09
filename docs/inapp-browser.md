# ブラウザー

人がページを見るビューアと、エージェントが操作する PC の Chrome を分ける。

## ビューア（人が見る内蔵ブラウザー）

会話の右パネルで Web ページを見る（[ADR 0041](adr/0041-inapp-browser-beside-conversation.md)）。エージェントが立てた開発サーバー（localhost）や会話のリンクを、会話を離れずに開く。機能はタブ・戻る/進む・再読み込み・アドレス欄・DevTools・別の窓に出す・既定のブラウザーで開くに限る。ブックマーク・履歴の検索・拡張・パスワード管理・ダウンロードの管理は持たない。

内蔵ブラウザーは人が見るためのもので、エージェントの操作の口は持たない。

### 使える場所

デスクトップ版のホストの画面（ローカルの窓）だけ。ブラウザーで開いた Pleiad・リモートの窓・スマホには内蔵ブラウザーのモードを出さない（ホストの内蔵ブラウザーを画面の転送で見ることはできる。下の「リモートから見る」）。設定 › ブラウザーはすべての画面に出す。画面は `window.plyDesktop.browser` の有無と `window.plyRemote` が無いことで判断する（`web/browser-panel.mjs` の `browserPanelAvailable`）。リモートの窓の preload（`desktop/remote-preload.cjs`）には口を出さず、main も `ply:browser` を受ける前にローカルの窓の本体フレームかを確かめる（`desktop/window-trust.cjs`）。

### 仕組み

- ページは Electron の `WebContentsView`。本体の窓に重ね、右パネルの本文の枠（`.browser-viewport`）の位置と大きさに合わせる（`desktop/browser-panel.cjs`）。`<webview>` は使わない。
- 画面は枠の位置（CSS の px）を `ply:browser-layout` で送る。ResizeObserver・窓の大きさの変化・パネルの幅の変更（`layout()`）で測り直し、同じ値は送らない。main は画面の倍率を掛け、角の丸み（本文の `--r-m`）も合わせる。広げる・幅の変更・760px 以下の全面表示でも同じ経路で追う。
- タブごとに View を 1 つ持ち、窓に載せるのは今のタブだけ。ほかのタブは外したまま動き続ける。空のタブ（新しいタブ）は View を載せず、画面が「URL を入力して開きます」を出す。
- 保存領域は `persist:pleiad-browser` の 1 つで、権限・UA・ダウンロードの設定は起動で 1 回かける（`desktop/browser-panel.cjs` の `setupSession`）。ポップアップの窓と「このサイトのデータを消す」も同じ session を使う。Pleiad 本体（既定の session）とリモートの窓（`persist:remote-<id>`）から分けるので、ページのスクリプトや Cookie は Pleiad の認証に届かない。一度ログインすれば次回も残る。
- `webPreferences` は `contextIsolation`・`sandbox`・`nodeIntegration: false`、preload なし。権限の要求（カメラ・マイク・位置・通知など）は確認を出さずに断る。UA から `Electron/…` と Pleiad の印を外す（ログインを断るサイトがあるため）。
- `target="_blank"` など通常の新しい窓の要求は新しいタブで開く（opener の関係は保たない、ADR 0041 の通り）。ただし、`window.open` でポップアップ（`features` 付き）として要求された窓は、ログイン等の連携（opener・`window.close()` 等）に要るため、例外として別の小さな窓で開く。どちらもページから `file:` や独自のスキームへは移らない。開けるのは http・https と、画面が明示した `file:`。
- ダウンロードは確かめずに OS の既定のダウンロードの場所へ保存する（同じ名前があれば「名前 (2)」）。
- 閉じる（×・Esc）とパネルを隠すだけで、タブは main に残る。もう一度開くと同じタブが出る。最後のタブを閉じるとパネルも閉じる。会話を切り替えてもブラウザーのパネルは開いたまま（タブの列は切り替わる。次の「会話とタブ」）。

#### ネイティブの View と重なり

View は DOM より上に描かれるので、メニュー・ダイアログ・画面下の知らせが本文の枠に重なると、そのままでは View の下に隠れる。重なっている間は、main が今の見た目を `capturePage` で画像にして画面へ返し、View を外す。画面はその画像を同じ位置に置く（`freeze` / `unfreeze`）。重なりの判定は `dialog[open]`（モーダルなら位置によらず）・`.pop`（メニュー・入力欄の面）・`.file-toast`・`.rm-dialog`・`.fu-drop` のうち、本文の枠と交わる見えているもの。body の直下への追加と `hidden`・`open` の出し入れを MutationObserver で見る（ブラウザーのモードが見えている間だけ）。画像の間はページを操作できない。設定を開く・ほかのモードへ移る・閉じるときは View を外す。

### 画面

入口は会話の頭の行の地球のボタン一つ（`#browserEntry`、`web/header-entries.mjs`。2026-10-09 承認）と、近道 Ctrl+Shift+B（macOS は ⌘⇧B）。どちらも右パネルのブラウザーを開閉する。操作中・依頼待ち・あなたが操作中なら Chrome の固定タブ、それ以外は会話で最後に見た方を開く。開いている間の状態変化では勝手に切り替えない。ビューアを開くときは前のタブをそのまま出し（読み直さない）、タブが無ければ空の新しいタブを作ってアドレス欄にフォーカスを置く。ビューアを開いたままタブの無い会話へ移ったときも空のタブを作る（フォーカスは動かさない）。中身の空のページと、列の選ばれたタブを合わせるため。閉じるとフォーカスはボタンへ戻る。近道は IME の変換中・ダイアログ・設定の画面では効かない。ページにフォーカスがあるときは main がタブの webContents の `before-input-event` でこの近道だけを拾う。開いている間の印は `aria-expanded` と `aria-controls="filePreview"`。

右パネルの 1 つのモード（`web/side-panel.mjs` の `browserSlots`）。見出しの字は出さず、その行にタブ列と広げる・閉じるを置く。Chrome の使えるホストでは先頭に「{エージェント名} の Chrome」の閉じられない固定タブを置く。窓の数（この会話の窓と、直接委譲した子の窓の合計）が二つ以上ならそのタブに札（読み上げは「… · N 窓」）、エージェントが操作中なら弧を出す。ビューアのタブは×で閉じられ、列の＋で増やす。左右・Home・End キーで移る。Tab キーの入口は選ばれたタブ 1 つ（roving tabindex）。選ばれたタブが無い間（Chrome の窓もビューアのタブも無い）は先頭のタブを入口にする。ビューアの道具の列は戻る・進む・再読み込み・アドレス欄・既定のブラウザーで開く・⋯。Chrome の固定タブを選ぶと、列は状態の一行・プロフィール選択 pill（`.cp-profile-slot`）・窓の ⋯ に替わり、効かないビューアの道具は出さない。種類の印・切り替え・ツリーは出さない。形は docs/design-system.md「内蔵ブラウザー」。

アドレス欄（`web/browser-address.mjs`）:

- 入力して Enter で開く。スキームが無ければ https、この PC（`localhost`・`*.localhost`・`127.0.0.0/8`・`[::1]`）は http。`localhost:5173` はスキームではなくホストとポートとして読む。
- 語だけ（ドットの無いもの）・空白を含むもの・http/https/file 以外のスキーム・ユーザー情報付きの URL は開かず、知らせを出す。検索はしない。
- 触れていない間はスキームと残りを弱く、ホスト名を強くする。左の印は https が鍵、この PC が PC の記号、http が注意の円、PC のファイルは紙。

⋯ の項目:

- 画面が開いた PC のファイル・可視化の写しのタブだけ、先頭にファイルの操作の群（下の「PC のファイルのタブ」）。
- Chrome で開く（エージェントの窓へ）: Web のページを会話の Chrome の窓へ開く。条件と動きは下の「Chrome で開く」。
- DevTools: そのタブの DevTools を別の窓で開く。
- 別の窓に出す: そのタブの View を独立した窓（道具の列の無い窓）へ移し、パネルの一覧から外す。窓を閉じるとページも閉じる。
- このサイトのデータを消す: 今のページのオリジンの保存領域と、そのページへ送られる Cookie を消して読み直す。

既定のブラウザーで開く は、http・https のページ（`shell.openExternal`）と、画面が明示して開いた `file:` の HTML（右パネルの「ブラウザーで開く」で開いた HTML ファイル・可視化の写し）で押せる。押せるかは main が決め、タブの状態の `external` で画面へ送る。`file:` は、そのタブが画面から開いた URL（`allowFile`）と同じファイルで拡張子が `.html`・`.htm` のときだけで、URL をパスに直し、実体を解決して HTML のファイルであることを確かめてから `shell.openPath` で開く（シェルは通さない）。連打はサーバーの `openPath` と同じく 10 秒に 5 回まで。ページの中で移った先の `file:`、HTML 以外、`about:blank` は押せない。

### PC のファイルのタブ（HTML ファイル・可視化の写し）

承認済み（2026-10-02、[ADR 0079](adr/0079-html-opens-in-inapp-browser.md)）。デスクトップ版のホストの画面で「リンクの開き先: 内蔵ブラウザー」のとき、HTML ファイルのリンク（会話・ツリー・ファイルのカード・Markdown の中）と、可視化のカードの「ブラウザーで開く」は、`file:` の URL を内蔵ブラウザーのタブで開く。入口は今あるファイルリンクのまま、行き先だけを変える。「画面が開いた `file:` のタブ」とは `allowFile`（画面が明示して `file:` を開いたタブ）で今のページがその URL のままのもの。ページの中で別のファイル・サイトへ移った後は含まない。

- **タブの使い回し**: 同じ実体のパス（可視化の写しは会話と記録の id）のタブがその会話にあれば、新しく作らず前に出して読み直す（`open` の `reuse: true`。照合の鍵は main の `fileKey`）。リンクを押すのは「今のファイルを見たい」ときなので、読み直すと入力・スクロールは初期に戻る。タブを一瞬だけ輪で知らせ（`--dur`、動きを減らす設定では出さない）、画面下の知らせ「読み直しました」を出す。押したリンクには、今のプレビューと同じ「表示中」を添える（ブラウザーの今のタブが別のものになるか、ブラウザーを離れたら外す）。別のファイルは別のタブ、別の会話の同じファイルも別のタブ。
- **既定のブラウザー**: Ctrl/⌘+クリックと中クリックは、HTML なら設定によらず既定のブラウザー（Web のリンクと同じ。`openPath` を `returnPath` なしで）。メニューは「ブラウザーで開く」が先頭で、設定の開き先に従う。「右パネルで開く」は HTML では「プレビューで開く」として残る。
- **印**: 開くとき画面が `source` を渡す。ファイルは作業ディレクトリからの相対パス（`label`。`openPath` の返事の `cwd` から）、写しは会話・記録の id・題・元のパス。main は形を確かめて（`cleanSource`）タブの状態の `file` / `snapshot` に載せる。
- **⋯ のファイルの操作**: 先頭に、原文を見る（右パネルをプレビューにして原文で開く。タブは残る）・エクスプローラーで表示（サーバーのある PC の画面だけ）・パスをコピー・相対パスをコピー・保存・会話で使う。写しは原文を見る・元のファイルを開く・エクスプローラーで表示・元のパスをコピー・相対パスをコピー・HTML を保存・会話で使う（元が分かるときだけ元のパスの操作、手元に会話の中身があるときだけ原文と保存）。中身は今のファイルの操作（`fileMenuItems`・`visualizationMenuItems`）と同じ処理を呼ぶ。道具の列は増やさない。会話の中身は、写しを開くとき画面が覚える（画面を読み直すと元のパスの操作だけが残る）。
- **アドレス欄**: PC のファイルは作業ディレクトリからの相対（外なら完全なパス）、写しはデータ置き場のパスを見せず「可視化 · 題」。触れると今どおり URL の全文を出して編集できる。
- **止める**: main は session の `webRequest.onBeforeRequest` を session ごとに 1 度だけ張り（`setupSession`）、要求の持ち主を `details.webContentsId` から引く（`byContents`。別の窓に出したタブも残す）。持ち主が「画面が開いた `file:` のタブ」のときだけ判定し、Web のページ・ページの中で移った先・ポップアップの窓・持ち主が分からない要求・ページ自身の移動（`mainFrame`）は止めない。
  - `file:` の資源: UNC・デバイスパスと Pleiad のデータ置き場（添付の `uploads` を除く。`AGENT_HOST_DATA`、既定 `~/.agent-host`）を、確認の ON/OFF によらず止める（[ADR 0050](adr/0050-local-file-access.md) と同じ範囲。実体を解決して比べ、Windows は大文字小文字を区別しない）。リンクでそこへ移ることも断る。同じフォルダーの相対の資源は読める。
  - http(s) の資源: 「外部の読み込みの前に確認」が ON のとき、「常に」許可した https の出どころと、そのタブだけの一時の許可（「読み込む」）だけ通す。**http は localhost も止める**。ws・wss は http・https と同じに見る。OFF のときは何も止めない（Web のページと同じ扱い。プレビューより緩い）。
  - 設定は core から main へ `browser-load-policy`（`{ confirm, origins }`）で届く（`core/browser-viewer.mjs` の `loadPolicy`、main の橋は `desktop/browser-viewer-bridge.cjs`。設定の変更と起動時の問い合わせに答える）。main の `setLoadPolicy` が受け、もう通る出どころは止めた一覧から外す。
- **止めた件数の一行**: 確認が ON で止めたものがあるタブだけ、道具の列とページの間（ネイティブの View の上ではなく DOM。重なりの画像化が要らない）に「外部の読み込みを N 件止めています / 読み込む / 設定」を、プレビューと同じ語彙で出す（`.preview-blocked.browser-blocked`）。件数は http も数える。「読み込む」は止めた https の出どころを、このタブだけ一時的に通して読み直す（`allowOnce`）。件数が http だけのときは「読み込む」を出さない（設定が ON の間、http は通さない）。「設定」は許可したサイトへ移り、止めた https の出どころが「許可」付きで並ぶ（プレビューが止めたものと同じ一覧）。タブごとの一時の許可は、別のファイルを読むと捨て、同じファイルの読み直しでは残す。
- **可視化の写し**: 写しは meta の CSP が先に止めるので `webRequest` には届かない。止めたものは、内蔵ブラウザーで開く写しにだけ入れる橋（`web/visualize-document.mjs` の `CONSOLE_BRIDGE`。`securitypolicyviolation` を `console.debug('ply-preview-blocked <URL>')` で知らせる。親が無いので `postMessage` は使えない）が知らせ、main が `console-message` で数える。「読み込む」は main が `rewrite` を返し、画面が `openVisualization { returnPath: true, allow: [出どころ] }` で一時の許可付きの写しを書き直し（鍵に許可を含むので別のファイル）、同じ記録のタブを使い回して開き直す。設定の許可は変えない。既定のブラウザーで開く写し・書き出し・リモートの写しには橋を入れない。
- **既知の制約**: `file:` のページと可視化の写しは同じ保存領域（`persist:pleiad-browser`）の `localStorage` を共有し、互いの保存値を読める（確認が OFF なら外へ出せる）。今回は分けていない。「このサイトのデータを消す」が `file:` で何を消すかは確かめていない。

### 設定 › ブラウザー

「リンクの開き先」は「内蔵ブラウザー / 既定のブラウザー」で、既定は内蔵ブラウザー。`prefs.json` の `linkOpen`（`inapp` | `external`）に保存し、`prefs` イベントでほかの画面へ反映する。内蔵ブラウザーの無い画面では選択を出さず、外のブラウザーで開く。既定のブラウザーを選んだ人の HTML ファイルは右パネルのプレビューで開き、そこから外へ出せる。

「外部の読み込みの前に確認」（`confirmExternalLoads`）は既定 OFF。すべての画面で使え、プレビュー・可視化・内蔵ブラウザーで開いた PC の HTML ファイルに効く。Web のページには効かない。ON のときは「許可したサイト」に、止めた https の出どころと、許可の一覧を出す。`externalSitePermissions: [{ origin, mode }]` の `mode` は `always` / `ask`（「常に / 毎回聞く」）。出どころはスキーム・ホスト・ポートの完全一致で、行を消すこともできる。設定は全画面で共通。

「エージェントのブラウザー」の接続と「エージェントのサイト利用」は、下の Chrome の章を参照。

### 画面から呼ぶ口

- `browserPanelAvailable()`: 使える画面か。
- `openInBrowserPanel(url, { newTab, reuse, source })`: 右パネルをブラウザーにして開く。url はアドレス欄と同じ規則で直し、開けなければ何もせず false。url を省くと空の新しいタブ。reuse は同じ実体のファイルのタブを使い回す指定、source は PC のファイル・写しの印。
- アプリの中の外部リンク（会話・作業のダイアログ・右パネルの Markdown の `a.md-link[target=_blank]`。文中の裸の URL・インラインコード全体の URL・取得の見出しを含む。形は docs/design-system.md「文中の URL」）とプレビュー（可視化・HTML ファイル）の中のリンクは、`web/link-open.mjs` の `openExternalLink` に集まり、開き先が内蔵ブラウザーなら新しいタブで開く（ダイアログの中のリンクはダイアログを閉じてから）。Ctrl/⌘+クリックと中クリック（`auxclick`）は既定のブラウザー（ADR 0041）。右クリック・長押し・Shift+F10 のメニュー（`web/link-menu.mjs`）は「内蔵ブラウザーで開く」（`openExternalLink` の `inapp`）と「既定のブラウザーで開く」（`external`）を選べる。既定のブラウザーへは殻の `openExternal`（http/https、userinfo 無し）で渡すので、本体の窓の `setWindowOpenHandler` が通さない http の localhost も開ける。使えない画面（ブラウザーで開いた Pleiad・リモートの窓）は今どおり新しいタブ。
- HTML ファイルのリンクと「ブラウザーで開く」（HTML ファイル・可視化の写し）も「リンクの開き先」に従う。内蔵ブラウザーが使えるホストの画面で設定が内蔵ブラウザーなら、検査済みの HTML ファイル、または会話に保存された可視化の写しを `file:` URL で内蔵ブラウザーのタブに開く（同じファイル・同じ記録のタブは使い回す。上の「PC のファイルのタブ」）。HTML ファイルでは同じフォルダーの相対資源を読める。可視化の写しには文書の meta の CSP が付く。使えない画面と既定のブラウザーを選んだ画面では従来の開き先を使う。アドレス欄は `file:` を「PC のファイル」と表示する。

### main の口

`desktop/preload.cjs` の `plyDesktop.browser`:

- `command(action, args)` → `ply:browser`（invoke）。`open`（`reuse`・`source` を受け、使い回したら `reused: <タブの id>` を返す）・`allowOnce`（止めた https の出どころをそのタブだけ通して読み直す。写しは `rewrite` を返す）・`newTab`・`select`・`close`・`back`・`forward`・`reload`・`stop`・`devtools`・`external`・`detach`・`clearSiteData`・`freeze`・`unfreeze`・`context`・`state`。
- `layout({ visible, rect, radius })` → `ply:browser-layout`。
- `onState(listener)` ← `ply:browser-state`（タブの一覧・今のタブ・URL・題・読み込み中・戻れるか/進めるか。PC のファイルのタブは `file` / `snapshot` と、確認が ON のとき `guard: { blocked, origins }`）。
- `onShortcut(listener)` ← `ply:browser-shortcut`（ページにフォーカスがあるときに押された開閉の近道）。

#### 会話とタブ

タブは開いたときに画面で開いていた会話（`sessionId`）を覚える。画面は開く・会話を切り替えるたびに `context` で今の会話を知らせ、`window.open` で開いたタブは元のタブの会話を引き継ぐ。パネルの一覧（`ply:browser-state` と `state`）と今のタブは、今の会話のタブと、会話に属さないタブ（`sessionId` が null）だけ。会話を切り替えると（`context`）、その会話で最後に選んだタブ、なければ見えるタブの先頭、なければ今のタブなしにし、窓に載せる View も替える。main の `createBrowserPanel` は `tabsFor(sessionId)`（その会話のタブと webContents）を返し、画面の転送（`desktop/browser-screencast.cjs`）がここから webContents の debugger へつなぐ。

### リモートから見る

リモートの端末では、リンクのシートで「この端末で開く / PC のブラウザーで見る」を選ぶ（`web/link-sheet.mjs`）。localhost・ループバックは「PC のブラウザーで見る」だけ。可視化の写しはサーバーで書き出して開き、端末から任意の `file:` URL は受けない。デスクトップ版でないホストでは `hostCapabilities.pcBrowser` が false になり、この選択を出さない。

「PC のブラウザーで見る」は、その会話のビューアを全面に映す（`web/remote-browser.mjs`）。URL があれば新しいタブ、無ければその会話の最初のタブ（無ければ空のタブ）を使う。戻る・進む・再読み込み・止める・URL の入力と、タップ・スクロール・文字入力ができる。

`desktop/browser-screencast.cjs` が `webContents.debugger` で `Page.startScreencast`（JPEG）を始め、ページの大きさを端末に合わせる。パネルに載っていないタブは `panel.pin` で載せ、見ている間は描画の間引きを止める。見るのをやめると元へ戻す。フレームは `core/browser-screencast.mjs` が既存の WS で送り、全端末が描き終えた（返事の上限 3 秒）うえで、自動は 200 ms・低は 500 ms の間隔を空けて次を許す。変化の無い間は送らない。

WS の口は `browserScreencast`・`browserScreencastStop`・`browserScreencastAck`・`browserScreencastInput`・`browserScreencastNav`。リモートの接続だけが使え、入力・移動はその会話を見ている接続に限る。main への橋は `desktop/browser-screencast-bridge.cjs`。タブ・接続が閉じるか、見る端末がいなくなると映像を止める。ペアリングした端末にはログイン中のページも映る（通信は [remote.md](remote.md) の E2E）。

### 検証

`tests/unit/inapp-browser.mjs`（タブ・配置・リンク・PC のファイルの守りと外部読み込み）・`remote-browser-view.mjs`（転送・入力・リモートだけの口）・`file-actions.mjs`・`server-visualize.mjs`（HTML と可視化の開き先）・`server-ux.mjs`（設定の保存）。

### 更新時のタブの写し

`core/browser-viewer.mjs` と `desktop/browser-viewer-bridge.cjs` が読み込みの方針とタブの写しを受け渡す。無停止の更新では、main が http(s) のタブの会話・URL・選択をサーバーへ報告し、付け直した main が URL から開き直す。`file:`・空のタブ・ページ内の入力途中の状態は戻さない。サーバーが替わったときは main が写しを送り直す。

## エージェントのブラウザー（Chrome）

エージェントの `agent-browser` は、PC の Chrome の専用の窓を会話ごとに使う（[ADR 0148](adr/0148-agent-browser-in-chrome.md)）。使えるのは Windows のデスクトップ版で、Chrome の OS の層が使えるホスト。Windows 以外・Electron の無い `npm start` では、ブラウザー用の環境変数・指示・`ply_browser` をエージェントへ渡さない。内蔵ブラウザーへの切り替えは無い。

### Chrome への接続

設定 › ブラウザー › 「エージェントのブラウザー」で「つなぐ」を押す。初めて使うときは、PC の Chrome のアドレス欄に `chrome://inspect/#remote-debugging` を貼り付けて開き、「Allow remote debugging for this browser instance」をオンにする。Chrome の確認で「許可する」を押すとつながる。Pleiad はこの確認に自動で答えない。エージェントが先に使おうとした場合も、会話に接続の案内を出して人の許可を待つ。

`core/chrome/locate.mjs` が既定では Windows の `%LOCALAPPDATA%/Google/Chrome/User Data` の `DevToolsActivePort` を読み、`core/chrome/connection.mjs` が CDP の接続を持つ。ファイルが残っていても、ポートにつながらなければ準備待ちにする。

| 状態 | 意味と次の動き |
|---|---|
| `off` | 未接続。「つなぐ」で準備へ進む。「切る」「やめる」や接続の切断で戻る |
| `setup`（A） | Chrome の準備待ち。起動とトグルを案内する。ファイルが無い、またはポートにつながらない間は 1 秒ごとに調べ、自動で B へ進む |
| `permission`（B） | Chrome に許可を求めている。許可で D、確認を断られると C、ポートが閉じれば A |
| `denied`（C） | Chrome で許可されなかった。「もう一度」で試し直し、「やめる」で待ちを終える |
| `connected`（D） | 許可され、`Browser.getVersion` まで成功した。状態に Chrome の版を出す。「切る」で接続を閉じる |
| `unsupported` | OS の層が使えない。理由は `platform`（Windows 以外）・`native`（koffi を読めない）・`no-desktop`（Electron が無い） |

待ちは無期限（[ADR 0153](adr/0153-chrome-connection-waits-indefinitely-behind-os-layer.md)）。Chrome の確認の打ち切りを避け、270 秒で古い確認を閉じて出し直す。確認を出してから 290 秒より前の拒否は C、以降は打ち切りとして出し直す。確認の「[設定] でオフにする」も C になる。トグルを実際にオフにしてポートが閉じれば A に戻る。

確認を前に出すのは最初に見つけた 1 回と、人が「ダイアログを前に出す」を押したときだけ。出し直しでは前面を取らせず、B の表示も変えない。「やめる」「切る」では確認を閉じる。つないでいる間、Chrome に自動テストの帯が出ることがある。

`browser.chromeConnect`・`browser.chromeDisconnect`・`browser.chromeRaiseDialog` はホストの PC の画面だけから呼べる。`browser.chromeStatus` は MCP の catalog と CLI の `pleiad browser status` にも出る。`chromeBrowser` イベント（`state, reason, dialog, product`）はホストの画面だけへ配る。接続の案内のカードは会話へ届くが、スマホで Chrome 自身の許可に答えることはできない。

### 接続の子（更新を越える Chrome への接続。[ADR 0167](adr/0167-chrome-connection-held-across-updates.md)）

Chrome への ws（`core/chrome/connection.mjs` の接続）は、サーバーでも main でもなく**接続の子**（保持役の子。`core/chrome/link-child.mjs`）が持つ。サーバーは名前付きパイプ（`core/chrome/link.mjs`）で子とつなぎ、`WebSocketImpl` として `connection.mjs` に渡す。サーバーの入れ替えでも main の入れ替えでも ws は切れず、許可の確認は出直さない。

- **パイプ**: 1 行 1 メッセージ。CDP の行はそのまま通し、制御の行は `!名前 JSON`（サーバー→子: `!hello`・`!open`・`!close`・`!carry`・`!quit`、子→サーバー: `!welcome`・`!opened`・`!fail`・`!closed`）。映像のような大きい行（64 KB 以上）は JSON として読まず、先頭 256 バイトだけ見て Buffer のまま通す（64 MB を超える行は捨てる）。
- **つなぎ手が居ない間**: 子は Chrome からの `Fetch.requestPaused` に `Fetch.failRequest(BlockedByClient)` で答える（止まったままのリクエストを残さない）。CDP の番号は `firstId = 最大の番号 + 1000` から始め直す。
- **引き継ぎ**: 古いサーバーは中継の状態（`relay.snapshot()`。会話の id・鍵・待ち受けのポート・隠した窓の印）を `!carry` で預け（200 ms でまとめる。引き継ぎの直前に確定させる。256 KB まで）、新しいサーバーは `welcome` で受けて `relay.restore` で同じポート・同じ鍵を立てる。確認待ちのまま入れ替わったら、`connection.adopt()` が確認の続きを引き取る。
- **止める・引き継ぐ（第 6 段）を越える**: carry は会話ごとに `stopped`（止めた印）と `paused`（引き継ぎ中の印。`at` と、あれば `by`）を持ち、見せている窓の会話には `revealed` を付ける。新しいサーバーは `relay.restore` で一時停止のまま会話を戻すので、つなぎ直したエージェントのコマンドは `PAUSED_MESSAGE` で断られ、人が操作している窓へ通らない。control は作られたとき（と restore のあと）に撮影を断ち直す。見せている窓は `adoptAgent(token, { revealed: true })` で、隠さず見張りにも入れずに引き継ぐ（戻すときの `conceal` で隠す）。引き継げなかった窓でも、見せている窓のタブは CDP で閉じない（人の窓。記録だけ捨てる）。見せている間に開いた popup は印が無いので、窓の ID と役割だけ預けて範囲に戻す。端末から引き継いでいる間（第 7 段 C）は `paused` に `by: 'device'` と映像の箱（`viewport`）も載り、新しい control が端末の印を立て直して箱を映像に伝え直す（撮影は断たない）。`openForConversation` は restore 後の同じポート・同じ鍵の待ち受けでそのまま動く。
- **隠した窓**: main の層（`desktop/chrome-os`）が `exportAgent`（`"<hwnd>:<元のスタイル>:<pid>"`）で出した印を `core/chrome/windows.mjs` が窓ごとに持ち、新しい層が `adoptAgent` で記録を作り直す。隠した窓かは拡張スタイルで見て、位置は問わない（Chrome が画面の中へ動かした透明の窓も引き継いで隠し直す。ADR 0167）。更新のあいだ窓は閉じない（`desktop/main.cjs` の `closeAgentWindows` は更新で離れるときは何もしない）。引き継げなかった窓は、Chrome の接続が付いたとき CDP でタブを閉じる。
- **更新の後の範囲の戻し**: 新しいサーバーは、持ち越した窓があれば `relay.rejoin()` で（`server.mjs` が `adopt` の後に）エージェントがつながる前に上りをつなぎ、窓のタブを会話の範囲へ戻す。接続の子の ws は Chrome から見て発見中のままで、`Target.setDiscoverTargets` は既存のタブを送り直さないため、`bind` が `Target.getTargets` で今あるタブを引いて戻す。窓の印（token）は、大きさを決めて隠し直した後に作る（最大化で開いた最初の窓は、通常に戻ると画面の中へ動くため）。
- **層（main）が後から付くとき**: OS の層は新しいサーバーが待ち受けた後で付くので、`connection.demand()` は、つながっている CDP があれば層を待たずに返し、`relay.readopt()` は（直列で）失われた窓が無くても必ず今ある窓のタブを戻す。層の `chrome-os-ready` が 2 回届いても（`epoch` が同じなら）処理中の `adoptAgent` は失敗にならない。main が入れ替わった間の引き継ぎは中断として次の ready でやり直し、窓は閉じない。窓を開く最中に入れ替わった場合の余りの窓（題だけの見える窓）は、その呼び出しの nonce のものだけを閉じる（[ADR 0167](adr/0167-chrome-connection-held-across-updates.md) の第 4 節）。
- **子の寿命**: サーバーが 10 分つながらなければ、保持役が止める。Pleiad の終了（`shutdown`・孤児の見張り）では `!quit` で終える。
- **切り替え**: `AGENT_HOST_CHROME_LINK=off`（または実行場所の置き場が無い・子につなげない）なら、サーバーの中で ws を張る今の形。

### 中継とエージェントへの渡し方

`core/chrome/relay.mjs` が Chrome への接続の上で、会話の範囲に絞った CDP を中継する。待ち受けは loopback の 1 ポートで、会話ごとに鍵付きの `ws://127.0.0.1:<port>/devtools/browser/<鍵 48 桁>` を出す。相手・Host が一致しない接続や、鍵の違う接続は断る。Electron の remote-debugging-port は開かない。

`core/agent-browser.mjs` の `chromeRelayBrowser` と `browserEnvironment` が、会話ごとの `agent-browser.json` に `cdp` を書く。シェルには `AGENT_BROWSER_CONFIG`・`AGENT_BROWSER_SESSION`・`AGENT_BROWSER_SOCKET_DIR`・`AGENT_BROWSER_PIN_TAB=1` を渡す。会話のネイティブ ID が決まっても設定の場所と名前は変えない。デーモンの管理ファイルは OS の一時領域の `ply-ab-<ハッシュ>` に置き、Codex の書き込みの許可は増やさない。

`AGENT_BROWSER_PIN_TAB=1` の縛りは、その置き場の `<セッション名>.target` とデーモンの中に残る。縛ったタブが消えると、次の `open` からも `tab_gone` で断られ続ける。そのため会話のタブがエージェントの外で全部無くなったら（窓を閉じる操作・人が窓を閉じた・Chrome が切れた）、中継の `onTabsLost` を受けて `.target` を消し、消したときだけ中継がエージェントの接続を切る（縛りの無いエージェントの接続は切らず、次の `Target.createTarget` で黙って窓を開き直す。ADR 0154）。デーモンはつなぎ直すときに記録を読み直し、縛りが無いので新しいタブ（新しい専用窓）を作る。エージェント自身がタブを閉じた場合は縛りを外さない。

Claude は会話の env、Codex は共有 app-server のスレッドごとの `shell_environment_policy.set`、Antigravity は会話のプロセスの env で受け取る。`agent-browser` は同梱の本体を PATH から呼び、接続先を手で指定する必要はない。ターン終了でサイトの確認を取り下げ、エージェントが動かしている印を外す。

#### 会話の範囲と断る一覧

範囲は中継が作った会話の窓と、その窓のタブ・iframe・worker、そこから `openerId` で開いたタブや popup。普段使う窓・別会話の窓のタブは一覧にもイベントにも出さず、URL・題を覚えずログにも出さない。CDP の `sessionId` も attach した接続ごとに持ち、別の接続のものは断る。

ブラウザー全体の `Target.setAutoAttach` は Chrome へ送らず、範囲のタブへの attach として中継で真似る。`Page.bringToFront`・`Target.activateTarget` は範囲を確かめたうえで成功だけ返し、窓を前面に出さない。

| 口 | 通す・制限するもの |
|---|---|
| ブラウザー全体 | `Browser.getVersion`。範囲のタブの情報・attach/detach・close、会話の窓の `getWindowForTarget`・`getWindowBounds`・`setContentsSize`。対象の一覧・発見・自動 attach・タブの作成は範囲に絞って真似る。`getBrowserContexts` は空を返す。それ以外は断る |
| タブのセッション | 通すのが既定。`Target.*` は iframe 用の `setAutoAttach` だけ通す。`Browser.*`・`Storage.*`・`Extensions.*`・`PWA.*`・`Autofill.*`・`Cast.*`・`SystemInfo.*`・`Tethering.*` は断る |
| ほかの origin の保存データ | `DOMStorage.*`・`IndexedDB.*`・`CacheStorage.*`・`Database.*`・`FileSystem.*`・`ServiceWorker.*`・`BackgroundService.*` は断る |
| Cookie・資格情報・ブラウザー全体への操作 | `Network.getAllCookies`・`clearBrowserCookies`・`clearBrowserCache`・`loadNetworkResource`・`getCertificate`・`enableDeviceBoundSessions`・`deleteDeviceBoundSession`、`Page.deleteCookie`・`setDownloadBehavior`、`Security.setIgnoreCertificateErrors` は断る |
| 要求の差し替え | `Network.setRequestInterception`・`continueInterceptedRequest` は断る。`Fetch.continueRequest` の URL の差し替えは止まった要求と同じ origin に限る |

`Page.navigate` と `Target.createTarget` の URL は、認証情報の無い http(s) と `about:blank` だけ。`Network.getCookies` は `urls` を外して今のページの分にする。Cookie の書き込み・削除は今のページのホストと親ドメインだけで、指定された `url` と `domain` の両方を調べる。ファイルのアップロード（`DOM.setFileInputFiles` など）は通す。

#### サイトの利用の確認

設定 › ブラウザーの「エージェントがサイトを使う前に確認」（`confirmAgentSites`）は既定 OFF。ON では、エージェントが動かしているタブの主フレームの要求を中継自身の `Fetch` セッションで止め、`core/browser-confirm.mjs` が会話で「一度だけ / このサイトは常に / 断る」を聞く（[ADR 0042](adr/0042-preview-loads-external-by-default.md)）。許可なら要求を続け、断られたら失敗として返す。

今の origin は `Page.frameNavigated` の移り終えた先で持つ。同じ origin、同じ移動の中で許可済みの origin、iframe、人が引き継いだ間の操作は聞かない。「常に」は `agentSitePermissions: [{ agent, profile?, origin, mode }]` にエージェントの種類・プロフィール・origin の組で保存し、同じプロフィールを使う同じエージェントの別会話にも効く。`profile` は `chrome:Profile 1` の形で、移動するタブの窓から引く（会話の次の窓の設定とは別）。旧版の `profile` が無い行はどのプロフィールにも効く。「一度だけ」はその移動だけで、離れて戻れば聞き直す。設定の一覧では「常に / 毎回聞く」と削除を選べる。ログイン済みのアカウント名は出さない。

**Chrome では一部の移動を要求前に止められない。** `window.open` の最初の要求は開いた後に確認し、返事までエージェントのコマンドを待たせ、断られたらタブを閉じる。bfcache など要求を出さない移動も移った後に確認し、断られたら `about:blank` へ戻す。送信・購入・削除など操作ごとの確認は、この設定では扱わない。

### 専用の窓

`core/chrome/windows.mjs` が会話ごとに窓を持つ。最小化は描画が止まるため使わず、画面の外・透明・マウスを素通しにし、タスクバーと Alt+Tab から外す（[ADR 0154](adr/0154-agent-window-hidden-off-screen.md)）。窓の外形の既定は 800×800 DIP。通常はページの大きさの emulation を使わず、窓の大きさで右パネルの読みやすさを保つ。

最初の窓は会話で選んだプロフィール（未選択なら Chrome の最後に使ったもの）を `--profile-directory` に渡し、`chrome.exe --new-window` から開く。題の nonce で窓を見つけて隠す。未選択で起こせなければ `Target.createTarget` を使う。選択済みの場合は、別のプロフィールで開く代わりに失敗を返す。2 枚目以降も、裏のタブの描画が間引かれないよう別の窓に作る。agent-browser はつないだとき会話にタブが無いと空のタブを 1 つ作り、続けて自分のタブを作る。中継は、同じ接続が次のタブを作った時点で、まだ `about:blank` のままの最初のタブを閉じる。最初の `open` で開く窓は 1 つになる。ページが `window.open` で開いたタブは同じ窓に入ることがあり、popup の別窓は範囲に取り込んで隠す。

OS の層は、隠した窓が前面を取ったら直前の前面へ返す。モニター・DPI の変更やスリープ復帰では置き直す。Chrome が隠した窓を画面の中へ動かしたときも、見張りが 1 秒以内に隠し直す。最大化のまま開いた窓は、先に通常へ戻してから大きさを決める（`Browser.setWindowBounds` は最大化の窓に大きさを当てない）。窓が見つからなければ隠せなかったことをログに残す。起動や popup で短く窓が見える場合があり、裏になったタブの撮影や操作が遅くなる場合もある。

窓だけを閉じた場合は記録を捨て、次に必要になったとき開き直す。接続が切れた場合は、隠した窓を閉じ、閉じられない窓は見える形へ戻す。Pleiad の終了でも隠した窓を片付ける。人へ引き継いだ窓はこの片付けで閉じない。

#### OS ごとの層

`core/chrome/os.mjs` が OS の口を定め、Windows の実装は `desktop/chrome-os/` に置く。窓は core では不透明な `WindowRef` で扱う。main との `chrome-os` / `chrome-os-result` の往復で、確認の発見・前面化・隠す・戻すを頼む。OS の層が使えなければ `unsupported` を返す。

確かめ専用の Chrome は `AGENT_HOST_CHROME_USER_DATA` で User Data を差し替える。このとき窓の起動にも同じ `--user-data-dir` を渡す。試験は偽の Chrome・OS の層、または専用のプロフィールを使い、利用者の Chrome を操作しない。

### プロフィール

`core/chrome/profiles.mjs` は Local State の `profile.info_cache` のキー（フォルダー名）と `name`（表示名）だけを取り出す。ファイルを JSON として解析するが、メールアドレス・アカウント・画像などの項目は参照せず、出力・記録・ログに載せない。最初の窓の既定に使う `profile.last_used` は従来の `locate.mjs` が読む。Cookie・履歴・パスワードのファイルは読まない。

設定 › ブラウザーには `chromeProfileNotes: [{ browser, dir, note }]`（メモは200字まで）と `chromeNewProfile: { browser, dir } | null`（新しい会話の既定）を置く。メモはエージェントのプロフィール一覧にも載る。既定が一覧から消えていたら適用せず、Chrome の最後に使ったものを使う。会話の選択はメタの `chromeProfile: { browser, dir }` に保存し、既存の会話の選択は設定の既定を変えても変わらない。新規会話で id が決まるまでは仮の id に持ち、確定時に `rebind` で保存する。

`ply_browser.list_browser_profiles` は `{ profiles: [{ browser, dir, name, note }], current, busy }` を返す。`use_browser_profile({ profile, browser? })` はフォルダー名を優先し、表示名でも探す。同名が複数ならフォルダー名での指定を求める。対応する ops は `browser.listProfiles`（read）と `browser.useProfile`（write、`modeGate: false`）。エージェントは自分の会話だけを指定でき、読み取りモードでも選べる。

切り替えは Chrome の操作中・人への依頼待ち・人への引き継ぎ中には断る。人からの切り替えはエージェントのターン中も断る。エージェント自身は、まだ Chrome を操作していないターンなら選べる。エージェントが変えたときは `present` の `chromeProfile` に名前とエージェント名を残して画面へ配る。選択の変更は `chromeProfile { sessionId, profile }` でも知らせる。

開いている窓はそのままで、次の窓から選択を適用する。同じプロフィールの窓の `browserContextId` が分かれば `Target.createTarget` へ渡し、作成したタブの値が一致するか確かめる。一致しなければそのタブを閉じ、`--profile-directory` で開き直す。実際の Chrome でのプロフィール間の接続と起動の挙動は、専用PCでの確認が残る。自動試験は偽の Chrome と OS の層で、別プロフィールで続行しないことを確かめる。

一覧の読み取りと保存の形は Chrome・Edge 共通。現在の接続・窓の起動は Chrome のみなので、Edge は一覧に出さない。Edge を有効にするには接続先の選択、Edge の実行ファイルによる窓の起動、実機でのプロフィール確認が要る。

**画面の部品の口**: `web/chrome-profile-pill.mjs`（`setupChromeProfilePill`）が「Claude の Chrome」固定タブの道具の列（`web/chrome-panel.mjs` の `.cp-profile-slot`）へプロフィールの pill を差し込む。pill は今のプロフィールの名前（メモがあれば弱い字）を出し、押すと `web/chrome-profile-menu.mjs` の `profileMenuItems({ profiles, notes?, current, busy, onPick, onManage? })` によるメニュー（`web/context-menu.mjs`）を開く。`profiles/current/busy` は `browser.listProfiles({ sessionId })` から取得し、`onPick({ browser, dir })` で `browser.useProfile({ sessionId, browser, profile: dir })` を呼ぶ。`onManage` は設定 › ブラウザーを開く。切り替えられない状態（`busy`: エージェント操作中・依頼待ち・人が引き継ぎ中）では pill に `aria-disabled="true"` を付け、メニューの先頭に理由を掲示して各項目を無効化する。選択の表示と取り直しは `chromeProfile { sessionId, profile }` イベントで即時反映し、操作待ち・引き継ぎ状態変化時にも一覧を取り直す。Chrome のタブが選ばれていないときや Chrome 層の無いホスト（Windows 以外・リモート端末等で op が呼べない環境）では出さない。狭い幅（360px）ではメモを隠し名前を省略して道具の列が溢れないようにする。

**委譲への引き継ぎ**: 子の会話を作るとき、親の `chromeProfile` をその時点で子へ写す。親が未選択なら `chromeNewProfile` を適用する。親が後で替えても子には波及せず、子は `use_browser_profile` で独立に替えられる。子の変更は子の会話に記録され、親の委譲カードの Chrome の行にも反映される。

### 映像と右パネルの「Chrome の窓」

ホストの画面では地球のボタンから Chrome の固定タブを開く。ビューアの無いリモート・スマホでは、Chrome の窓がある会話でだけ同じ地球のボタンを頭の行に出し、押すと Chrome の映像を開く（タブの切り替えは出さない）。ホストの画面とリモートの端末のどちらでも、右パネルでエージェントが最後に操作したタブを見られる（`web/chrome-panel.mjs`）。見出しの字を出さず、道具の列に状態の一行・プロフィールの口・窓の ⋯ を置き、映像と fps の行が続く。通常は見るだけで、押す・打つ・ホイールでは「見るだけ · 操作は引き継いでから」と案内する。

`core/chrome/screencast.mjs` がエージェントとは別のセッションで `Page.startScreencast` を使う。今のタブが替われば付け替える。大きさは表示の箱と倍率から決め、画質は自動 55・低 30。フレームの間隔と ack はビューアと同じで、見る画面が無くなれば止める。隠したページを描かせる focus emulation はタブごとに 1 本で持ち、ターンと映像のどちらの理由も無くなったときだけ外す。

WS の `browserScreencast`・`browserScreencastStop`・`browserScreencastAck` に `source: 'chrome'` を付け、ビューアと分ける。URL を開く指定と `browserScreencastNav` は断る。入力は下の端末への引き継ぎ中だけ。窓の有無は `chromeWindow`（`sessionId, windows, operating, windowIds, currentWindowId`）で全画面へ知らせ、入口と操作中の弧を更新する。入口には窓の数を出さない。映像の状態には URL・題を載せない。

### 状態の一行と止める・引き継ぐ・戻す

`core/chrome/control.mjs` が会話ごとに状態を持ち、`web/chrome-control.mjs` が映像の上に一行を出す。`chromeControl`（`sessionId, state, since, error, by`）はホストとリモートの端末へ届く。

| 状態 | 表示と操作 |
|---|---|
| `running` | 「{エージェント名} が操作中」。「止める」「引き継ぐ」 |
| `idle` | 「待機中」。「引き継ぐ」 |
| `stopped` | 「止めました」。「引き継ぐ」。次の人の送信まで再接続を断る |
| `paused` | 「あなたが操作中」。「{エージェント名} に戻す」。`by` は `pc` / `device` |

「止める」（`browser.chromeStop`）はエージェントの接続を切る。次の人の送信で鍵を作り直して再接続を許す。「引き継ぐ」（`browser.chromeTakeOver`）は接続を切って一時停止し、PC で操作する場合は会話の窓を見える形へ戻して、Pleiad の窓のある画面で最後に操作した窓を前に出す。見せられる窓が無ければ `NO_WINDOW` を返す。

一時停止ではエージェントが attach したセッションを外し、通知と Fetch の横取りも止める。つなぎ直してもコマンドは断り、`hand_to_user` で待つよう返す。実行中の同期スクリプトには、それを始めたエージェントのセッションから `Runtime.terminateExecution` を送る。Promise・タイマー・ページ自身の次の実行まで止めるものではない。

PC に引き継いだ間は、窓を見せる前に撮影を止め、映像に「映像を止めています」の幕を出す。「戻す」（`browser.chromeResume`）は人が引き離したタブなども取り込んで窓を隠し、全部隠せてから一時停止を解く。隠せなければ `conceal-failed` として停止を保ち、もう一度「戻す」を押せる。引き継いでいた時間は会話に一行で残る。

会話の入力欄の上にも一時停止中の帯と戻すボタンを出す。窓を × で閉じても paused のままで、この帯から戻せる。Chrome ごと閉じて接続が切れると一時停止も解く。引き継ぎ・戻す・止めるは同じ会話では順に行い、先に引き継いだ状態を後の押下で取り替えない。これらの操作は画面専用で MCP・CLI には出さない。

### Chrome の窓の上端のピル

PC へ引き継いでいる間（`paused`・`by: 'pc'`）に、その会話の見える Chrome の窓が前面なら、上端に「あなたが操作中 · {エージェント名} に戻す」のピルを重ねる。押すと右パネルの `browser.chromeResume` と同じように窓を隠して一時停止を解く。ほかの窓が前面になったとき、Chrome の窓を閉じたとき、Chrome の接続が閉じたとき、戻したときは消す。端末への引き継ぎでは PC の窓を見せないので出さない。

`desktop/chrome-pill.cjs` のクリックを受ける小さな Electron 窓で、ページには何も差し込まない。ページのアクセシビリティの木には入らず、Esc も取らない。ピルの窓だけ `setContentProtection(true)` で撮影から外す。画面共有・録画・`ply_computer` のスクリーンショットには写らない（点の下には在るので、`ply_computer` の押す動作 click・down・drag は、点の下が Pleiad の窓なら `self` で断る。キーと同じ）。OS の層の `watch` で前面を追い、`bounds(ref)` が Win32 の物理矩形の左上を Electron の画面 DIP へ変換し、窓の `GetDpiForWindow` で幅と高さを換算する。前面の間は位置を更新し、移動・大きさ・モニター・DPI の変更に追従する。

ADR 0148 にある「{エージェント名} が操作中「題」· 止める · 引き継ぐ」は出さない。ADR 0154 でエージェントの窓は引き継ぐまで画面外にあり、その文言を窓の上に見せる場面がなくなった。通常時の止める・引き継ぐは右パネルの状態の一行から操作する。

### 操作待ちのカードと hand_to_user

`core/chrome/handoff.mjs` と `web/browser-handoff-card.mjs` が、接続の案内とログインなどの依頼を会話に出す。1 会話に開くカードは 1 枚で、`permissionUpdate` で同じ id の中身を替える。`askPermission` の `outlivesTurn` を使い、ターンが普通に終わってもカードを残す。ターンが走っている間は `detached` と違って承認待ちとして数えるため、委譲の待機と通知にも載る（[ADR 0168](adr/0168-permission-wait-outlives-turn.md)）。

接続の無いままエージェントが中継へつなぐと、A〜C の案内を出す。中継自身の待ちは 20 秒で区切って失敗を返すが、カードが接続を待ち続ける。つながるとカードは決着する。ターンの外に残ったデーモンの接続だけでは、新しい案内を出さない。

`ply_browser`（`core/browser-bridge.mjs`、`/mcp/browser`）の `hand_to_user` は、`reason`（`login`・`captcha`・`two_factor`・`payment`・`other`）と `message` を受ける。文は最大 200 文字。依頼のカードの「Chrome で操作する」は引き継ぎを呼び、「あなたが操作中」へ替わる。「Claude に戻す」で一時停止が解けると待っていた呼び出しに返る。接続前なら接続の案内に読み替え、すでにカードがあれば同じカードを待つ。

委譲した子の依頼は親の会話にも複製される。親のカードの操作対象は子の会話 ID なので、親から子の窓を引き継ぎ、戻せる。子のカードも同時に済む。`reason: login` の子が並行したときだけ、直接の親・現在のタブを含む窓の実際のプロフィール・呼び出し時の現在のタブの origin がすべて同じなら、親のカードを 1 枚にまとめる。カードには待っている子の作業を並べ、最初の子の窓を操作対象にする。戻すと各子の待ちを解き、各自が `snapshot` からやり直す。origin または窓のプロフィールが読めない場合は別のカードにする。

MCP の口は会話ごとの Bearer で守る。Claude・Codex は HTTP の MCP、Antigravity は `core/agy-context-relay.mjs --browser` を使い、コンテキスト・コンピューターの操作と一緒に渡す場合は 1 本の stdio の中継に束ねる。

#### 区切って返す・「続けてください」

`hand_to_user` の 1 回の待ちは Claude・Codex が 600 秒、Antigravity が 150 秒。呼び出しの上限に達する前に `waiting`（失敗ではない）を返し、エージェントが呼び直すと同じカードの待ちへ戻る。時間が過ぎただけで依頼を消したり、新しいカードを重ねたりしない。

人が戻したとき、待機中の呼び出しがあればそこへ結果を返す。呼び出しが無くてもターンが走っていれば、次の待ちへ返すため結果を置く。ターンが終わっていて切り替え・分岐の途中でなければ、会話へ「続けてください」を 1 回送る。カードのボタンも「Claude に戻して続ける」になる。接続の案内がターン終了後につながった場合も同じ。送信の id はカードから決め、重複を防ぐ。

「できない」は断った結果を返す。会話の中断・子の取り消し・会話の削除では待ちを取り下げ、「続けてください」は送らない。戻した結果には時刻・URL・題があれば含める。接続完了・待機継続は成功、拒否・中断は失敗として MCP へ返す。

### 端末から操作する

リモートの端末の依頼カードには「この端末で操作する」と「PC で操作する」を出す。「この端末で操作する」は Chrome の映像を開き、`browser.chromeTakeOver` に `by: 'device'` と映像の箱の `width, height, scale` を渡す。

端末へ引き継ぐとエージェントの接続は切るが、PC の窓は隠したままで映像を止めない。ページの大きさを端末に合わせ、映像を見ながらタップ・スクロール・文字・Enter などを送れる（`core/chrome/input.mjs`）。入力はリモートでその会話を見ている接続から、端末への引き継ぎ中だけ受け、映像のセッションで送る。専用のアドレス欄や戻る・進むは持たない。

「戻す」はページの大きさを元に戻してから一時停止を解く。「PC で操作する」は PC の窓を見せて映像を止める。Chrome 自身の接続の許可は PC で行い、端末へ渡るのはページの映像と入力だけ。

### Chrome で開く

ビューアの ⋯「Chrome で開く（エージェントの窓へ）」は `browser.chromeOpen`（`core/ops/browser.mjs`）を呼ぶ。ホストの PC の画面専用で、その会話の Chrome の窓に認証情報の無い http(s) の URL を開く。`file:` や空のタブには使わない。Chrome につながっていなければ接続の許可を待ち、右パネルに接続待ちを示す（操作待ちのカードは出さない）。開いたら右パネルを Chrome の映像へ替える。

開いてもエージェントへ自動でメッセージは送らない。続けて操作してほしい内容は会話で頼む。この項目は URL を開くもので、隠した窓を人へ見せる操作は「引き継ぐ」。

### 窓を閉じる

`ply_browser.close_browser_window` は引数なしなら呼び出した会話の専用窓を閉じる。`{ task: '<taskId>' }` なら、この会話が直接委譲したローカルの子の窓を閉じる。タスクと子の会話メタの親子関係を両方確かめ、別の親・孫・リモートのホストの子・孤立した記録は断る。右パネルでは Chrome の道具の列の ⋯ に窓の一覧（この会話の窓と、直接委譲した子の窓。子の項目は押すとその子の会話の Chrome を開く）と「窓を閉じる」を置き、後者は `browser.chromeCloseWindow` を呼ぶ。PC の画面とリモートの端末で使える。MCP と CLI の ops には出さない。窓は使い終えたときに閉じられるが、続きに使う画面やログイン中の窓は開いたままにできる。閉じた後にブラウザーを使うと新しい専用窓が黙って開く（agent-browser の縛りを外してつなぎ直させる。「中継とエージェントへの渡し方」）。

親の委譲カードの下には、子の窓が開いている間だけ Chrome の印・プロフィール・状態・子の会話を開く操作・窓を閉じる × を出す。`browser.chromeWindows({ sessionId })` は、この会話と直接委譲した子の開いている窓を `{ sessionId, taskId, title, windows, profile, profileName, state, waiting }[]` で返す（この会話の行は `taskId: null`。`waiting` は人への依頼待ち）。タブの窓の数と ⋯ の一覧は、この読み取り口を使う。窓が開閉したら `chromeWindow`、プロフィールが替わったら `chromeProfile`、操作状態が替わったら `chromeControl` で読み直す。

閉じる直前の `Page.captureScreenshot` を `<data>/uploads/chrome-window/<会話 ID の SHA-256>/<時刻>-<UUID>.png` に置き、会話の `chromeClosed` の行にファイルのパスだけを記録する。人が Chrome の × で直接閉じたときと、撮影できないときは最後に受けた映像の JPEG を `.jpg` として残す。画像が無いときも閉じた行は残る。会話を消すと、窓とその会話の静止画を片付ける。分岐した会話は、写した `chromeClosed` の行の静止画を自分の置き場へ複製して指す（元の会話を消しても残る。ネイティブの分岐も同じ。docs/message-fork.md）。

窓の全タブを `Target.closeTarget` で先に閉じる。破棄の通知を 500 ms 待ち、層に記録が残った専用窓だけ `closeAgent` で閉じる。引き継ぎ中なら一時停止と操作待ちのカードを片付ける。Chrome の接続が途中で切れたときは既存の切断処理が接続を off に戻し、専用窓と一時停止を片付ける。更新の carry と、層が引き継げなかった窓の orphans は、閉じた会話の窓の記録だけを外して保つ。

### 検証

`tests/unit/chrome-connection.mjs`・`chrome-os.mjs`・`server-chrome.mjs`・`chrome-settings.mjs` が接続と OS の層、`chrome-relay.mjs` が範囲・断る一覧・サイトの確認、`chrome-windows.mjs` が専用の窓を確かめる。映像は `chrome-screencast.mjs`・`server-chrome-screencast.mjs`、引き継ぎは `chrome-control.mjs`・`chrome-control-ui.mjs`。窓を閉じる流れは `chrome-close-window.mjs`。操作待ちと端末入力は `chrome-handoff.mjs`・`chrome-handoff-flow.mjs`・`chrome-device.mjs`・`browser-bridge.mjs`。委譲は `chrome-delegation.mjs` がプロフィール・窓の所有関係・同じサイトを待つ 2 つの子・窓ごとの停止を確かめる。いずれも偽の Chrome・OS の層で、本物の利用者の Chrome は使わない。
