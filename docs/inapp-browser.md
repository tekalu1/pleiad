# 内蔵ブラウザー

会話の右パネルで Web ページを見る（[ADR 0041](adr/0041-inapp-browser-beside-conversation.md)）。エージェントが立てた開発サーバー（localhost）や会話のリンクを、会話を離れずに開く。機能はタブ・戻る/進む・再読み込み・アドレス欄・DevTools・別の窓に出す・既定のブラウザーで開くに限る。ブックマーク・履歴の検索・拡張・パスワード管理・ダウンロードの管理は持たない。

## エージェントの操作

デスクトップ版では、会話ごとに鍵付きの loopback WebSocket CDP 中継を開く（[ADR 0043](adr/0043-agent-browser-via-per-session-cdp-relay.md)）。中継は `webContents.debugger` を使い、その会話の内蔵ブラウザーのタブだけを `Target` として返す。Pleiad 本体の画面や別会話のタブは返さない。接続先の準備（ターンの開始）ではタブを作らず、エージェントが実際に WebSocket でつないだときに、その会話のタブが 0 枚なら空のタブを 1 枚作る（使わないターンや委譲した子の会話で空のタブが増えない）。`Target.createTarget` はその会話の新しいタブを作り、`Browser.close` などブラウザー全体に効くコマンドは拒否する。Electron の `--remote-debugging-port` は開かない。

サーバー（`utilityProcess`、無停止の更新の既定では実行場所の `pleiad-node.exe`）は main への口（parentPort か名前付きパイプ）でメインプロセスに接続先を頼む。`<data>/agent-browser/<会話の初期 ID の SHA-256>/agent-browser.json` に `cdp` URL を書き、エージェントのシェルへ `AGENT_BROWSER_CONFIG` と `AGENT_BROWSER_SESSION` を渡す。デスクトップ版でない `npm start` には渡さない。Claude は SDK の会話別 env、Codex は共有 app-server の `thread/start`・`thread/resume` に渡す会話別の `shell_environment_policy.set`、Antigravity は会話別プロセスの env を使う。接続方法は会話のエージェント向け指示にも入る。`agent-browser` は同梱した OS のネイティブ本体を PATH から呼ぶ。

main の入れ替わり（無停止の更新。パイプの口）: 中継とタブは main のもので、main が居ない間（本物のインストーラーで約 45〜50 秒）は中継が無く、`agent-browser` の呼び出しは約 2 秒でエラーになる（モデルの再試行に任せる）。サーバーが会話ごとの URL・タブの写しと中継の `{ port, 鍵 }` を持ち（main がタブの変化を報告する）、新しい main が付け直したら、写しからタブを URL で開き直し、**同じポートと鍵で**中継を立て直す（`agent-browser` の常駐は同じ pid のまま次の呼び出しで戻る）。中継の待ち受けは、タブを開き直した後（先に待ち受けると、常駐の最初の `getTargets` が `about:blank` を見る）。同じポートが取れなければ別のポートと鍵にして、`agent-browser.json` の `cdp` を書き直す。サーバーの切り替え（新しい版のサーバー）の後も、main が写しと中継の URL を 1 回送り直す。タブの写しはプロフィールを持たない（[ADR 0148](adr/0148-agent-browser-in-chrome.md) で削除）。エージェントの操作が Chrome の専用の窓に移った後の扱いは `docs/zero-downtime-update/design.md` §7.2。

中継を使うと右パネルを開き、操作中のタブに印を付け、道具の列の下に「<エージェント名> が操作中」と「止める」「引き継ぐ」を数秒表示する。「止める」は接続を切り、次の人の送信まで再接続を拒否する。「引き継ぐ」は接続を切って表示を消し、再接続は許す。会話のツール履歴はシェル実行として残る。

デーモンの管理ファイルは Windows では OS の一時領域の `ply-ab-<ハッシュ>/`、Unix では `/tmp/ply-ab-<uid>/<ハッシュ>/` に作り、`AGENT_BROWSER_SOCKET_DIR` で全バックエンドへ渡す。既定の `~/.agent-browser` は Codex の `workspace-write` では書けないため、既定で書ける一時領域を使う。Codex の thread config と turn の sandboxPolicy にブラウザー用の書き込みルートは追加しない。読み取り専用モードでは、ファイルへの書き込みが必要なブラウザー操作はできない旨をエージェントへ指示する。利用者が `exclude_tmpdir_env_var`（Windows の TEMP/TMP を含む）や `exclude_slash_tmp`（Unix）で一時領域を除外した場合、その制限は変更しないため操作できない場合がある。

`AGENT_BROWSER_SESSION` と一時領域のハッシュは設定フォルダーの絶対パスから作り、会話とデータ置き場を区別し、ネイティブ ID の確定後も変えない。Unix では長い TMPDIR による 104 バイトのソケットパス制限を避けるため、常に短い `/tmp` を使う。Windows の agent-browser 0.38.1 は loopback TCP を使い、PID・ポート等のファイルを一時領域に置く。継承した `AGENT_BROWSER_NAMESPACE` は空にして、指定した置き場が変わらないようにする。

agent-browser 0.38.1 の state ルートには専用の変更変数がない。`AGENT_BROWSER_STATE` は読み込む state ファイルの指定であり、保存先の指定ではない。この CDP 接続では自動 state 保存を設定せず、Cookie 等は Electron の保存領域を使う。Claude・Antigravity にも同じ env を渡す。Claude の Bash sandbox を利用者が有効にしている場合、書き込み先と loopback 接続の許可はその sandbox の設定にも必要で、Pleiad は設定を自動で緩めない。

タブの Cookie は会話が違っても共有する（保存領域は 1 つ。下の「仕組み」）。中継は主フレームのページと通常のタブ操作を対象とし、OOPIF・service worker・DevTools の同時接続などを CDP の完全なブラウザーとしては公開しない。Codex の読み込み済みスレッドは `thread/resume` の新しい config を無視する場合がある。新規会話のネイティブ ID が決まった後も、最初に渡した設定ファイルと `AGENT_BROWSER_SESSION` を保ち、接続鍵の変更は同じファイルを書き換えて届ける。

## ply_browser（エージェントへの MCP）

`ply_browser`（`core/browser-bridge.mjs`、`/mcp/browser`）は、エージェントのブラウザー操作の MCP の口の骨組み。内蔵ブラウザーを渡すターン（デスクトップ版で中継がある）にだけ渡す: Claude は `mcpServers`（ツールごとの承認は出さない）、Codex は `mcp_servers`（自動で承認）、Antigravity は stdio の中継 `core/agy-context-relay.mjs --browser`（`PLY_BROWSER_URL`・`PLY_BROWSER_AUTHORIZATION`）。agy は agent.md の `mcpServers` の先頭 1 本しか起こさない（1.2.14 で実測）ので、ply_context・ply_computer と一緒に渡すときは旗を並べた 1 本の中継に束ねる（`--context --computer --browser`。ツール名で振り分ける）。口は会話ごとに鍵付きで開き、会話のあいだ同じ値。

今は載せるツールが無い（`tools/list` は空で、呼び出しは断る）。エージェントの操作を PC の Chrome の専用の窓に移す段で、ツール（Chrome のプロフィールの一覧と切り替え・`hand_to_user`・`close_browser_window`）を足す（[ADR 0148](adr/0148-agent-browser-in-chrome.md)。承認済み）。内蔵ブラウザーのプロフィール（保存領域を名前付きで分ける機能。[ADR 0078](adr/0078-inapp-browser-profiles.md)）は ADR 0148 で削除した。古い `prefs.json` の `browserProfiles` などの値と、メイン以外の保存領域のディレクトリが残っていても読まない。

## Chrome への接続（エージェントのブラウザー）

[ADR 0148](adr/0148-agent-browser-in-chrome.md)・[ADR 0153](adr/0153-chrome-connection-waits-indefinitely-behind-os-layer.md)。PC の Chrome に Pleiad が CDP の接続を 1 本持ち、設定 › ブラウザー › 「エージェントのブラウザー」で**つなぐ・切る**ができる。**エージェントはまだ使わない**（エージェントの操作は上の「エージェントの操作」の内蔵ブラウザーの中継のまま。開発用の環境変数 `AGENT_HOST_AGENT_BROWSER=chrome` のときだけ、下の「Chrome の中継（開発中）」を使う）。

- **対応する OS**: 当面は Windows の Chrome だけ。ほかの OS・koffi を読めない PC・Electron の無いホスト（`npm start`）では「この OS ではまだ使えません」（状態 `unsupported`。ホストの画面の `hostCapabilities.chromeBrowser` は OS の層が使えなければ `unsupported`、Electron の無いホストでは `false` で、後者は節を出さない）。
- **読むものと送るもの**: Chrome の `User Data`（Windows は `%LOCALAPPDATA%\Google\Chrome\User Data`。環境変数 `AGENT_HOST_CHROME_USER_DATA` でこの 1 か所だけに差し替えられる。テストは存在しない一時ディレクトリへ、実機の確かめは `--user-data-dir` を付けて起こした確かめ専用の Chrome へ向ける）の `DevToolsActivePort`（1 行目がポート、2 行目が `/devtools/browser/<id>`）だけ。Cookie・履歴は読まない。`Local State` は、専用の窓を開くプロフィールを決める `profile.last_used` の 1 項目だけ（プロフィール名・アカウント・設定は取り出さず、ログにも出さない）。接続そのものが上りへ送る CDP は `Browser.getVersion` だけ（`Target.*` は送らない。利用者のタブの URL・題を受け取らない）。中継を使うときに送るものは下の「Chrome の中継（開発中）」。
- **接続は 1 本で、会話をまたいで使い回す**。許可の確認（「リモート デバッグを許可しますか？」）は接続ごとに出るので、切れたら自動ではつなぎ直さない（次の `demand()` か「つなぐ」で A か B から）。実装は `core/chrome/connection.mjs`（`createChromeConnection`）。サーバーに 1 つ、Electron のあるデスクトップ版だけ。

| 状態 | 意味 | 入る条件 | 出る先 |
|---|---|---|---|
| `off` | 何もしていない | 起動直後・「切る」・「やめる」・接続が切れた後 | 「つなぐ」→ `setup` か `permission` |
| `setup`（A） | Chrome のトグルがオフか、Chrome が起動していない | `DevToolsActivePort` が無い（`reason` は `null`）、または書かれたポートにつながらない（`reason` は `unreachable`。トグルをオフにしても Chrome を閉じてもファイルは残るので、この 2 つは見分けない） | 1 秒ごとに読み直し、つながれば自動で `permission`。時間では打ち切らない |
| `permission`（B） | 許可の確認が出ている | ws の upgrade を投げた。`dialog` は確認の窓を見つけたか | 許可で `connected`。「キャンセル」・確認の「[設定] でオフにする」で `denied`。トグルを戻した（ポートが閉じた）で `setup` |
| `denied`（C） | Chrome で許可されなかった | 確認が 290 秒より前に断られ、ポートが生きている（「キャンセル」と確認の「[設定] でオフにする」。打ち切りでは入らない） | 「もう一度」→ `setup` / `permission`。「やめる」→ `off`（`declined`） |
| `connected`（D） | つながった | upgrade 成功と `Browser.getVersion` | ws が閉じたら `off` と理由（`chrome-closed`: ファイルが消えた・ポートが変わった・つながらない、`revoked`: ポートは生きている） |

`off` の `reason` は `chrome-closed`・`revoked`・`disconnected`（自分で切った）・`declined`（「やめる」）・`protocol`（想定外の HTTP の応答）。`setup` の `reason` は上の `unreachable` か `null`。`unsupported` の `reason` は `platform`（Windows でない）・`native`（koffi を読めない）・`no-desktop`（Electron が無い）。

**待ちは無期限**（ADR 0153）。Chrome は確認を約 5 分で打ち切るので、Pleiad が確認を出してから 270 秒（`reissueMs`）で、利用者に見せずに古い確認を `WM_CLOSE` で閉じ、すぐ upgrade し直す（新しい確認が出る。確認は常に 1 つ。画面の状態は B のまま変わらない）。印の無い失敗が確認を出してから 290 秒（`cancelBeforeMs`）より前なら「キャンセル」（`denied`）、以降なら Chrome の打ち切りとして残った確認を閉じて出し直す。失敗の直後に `DevToolsActivePort` を読み直し、無い・つながらないなら `setup`。確認の窓を見つけられていないとき（`dialog: false`）も、出し直しで探して閉じる（**ws だけ閉じても確認は Chrome に残る**ため）。

**前に出す頻度**: Pleiad が確認を前に出す（`raise`）のは、B に入って最初に見つけた 1 回と、「ダイアログを前に出す」だけ。出し直した確認は前に出さず、前面を取っていたら（1 秒の間 200 ms ごとに見る）、直前の前面がブラウザーの窓でなければ `yieldForeground` で返す。「やめる」・「切る」・Pleiad の終了（`shutdown` を受けたとき。2 秒まで）は、出ている確認を閉じてから終える（Chrome に確認を残さない）。

**記録**: 状態の移り変わり（`chrome: state=… reason=…`）・前に出した方法（`chrome: raise method=…`）・返したか（`chrome: yield ok=…`）は、サーバーの標準出力に 1 行ずつ出る。デスクトップ版では、`utilityProcess` の経路は `userData\logs\server.log`（開発版は `server-dev.log`）、無停止の更新の経路は `<実行場所>\logs\server.log`（`AGENT_HOST_SERVER_LOG`。`core/server-log.mjs`）。main の OS の層の行（`[chrome-os] …`）は main の標準エラーで、ファイルには残らない。

### 実機で確かめたこと（Chrome 154・Windows 11、2026-10-06）

- **確認の「[設定] でオフにする」は、トグルを切らない**。`chrome://inspect/#remote-debugging` を新しいタブで開くだけで、確認は閉じて upgrade は断られ、ポートは生きたまま。Pleiad からは「キャンセル」と見分けられないので C（`denied`）になる（ADR 0153 は C を「キャンセルのときだけ」と書くが、実機ではこの押下でも入る）。A になるのは、利用者が開いたページで実際にトグルをオフにした後の「もう一度」で、切らずに押せば B。
- 確認を閉じる（`WM_CLOSE`）・「キャンセル」では、upgrade は **HTTP 403** で断られる（`ws` パッケージでは `unexpected-response` の 403。Node 組み込みの WebSocket では 1006 に見える）。403 は拒否として扱い、それ以外の HTTP の応答は `protocol`。
- 確認を閉じてすぐ upgrade し直すと、新しい確認は 30〜52 ms で出る（8 回）。**出た確認が前面を取ったことは無かった**（前面がほかのアプリ・Pleiad のとき。Chrome の窓が前面のときも変わらなかった）。つまり確認は背後に出るので、最初の 1 回は Pleiad が前に出す必要がある。`AttachThreadInput` 方式の前面化は node のプロセスからも通った。
- Pleiad から ws だけ閉じても、確認は Chrome に残る（`WM_CLOSE` で消える）。
- 確認の窓は、`WS_POPUP` で、**ブラウザーの窓が持ち主**（`GW_OWNER`）、外形は 694×354 物理画素（150% で 463×236 DIP）。ふつうの窓は持ち主が無い。題は日本語の Chrome で「リモート デバッグを許可しますか？」（英語の題は未確認。題が既知でも未知でも、持ち主のある新しい小さな窓が 1 つだけなら確認とみなす）。
- **トグルをオフにしても `DevToolsActivePort` は残る**（中身も更新時刻も変わらず、古いまま）。ポートだけが閉じる。オンに戻すと、同じポートで経路の鍵が書き直される（数秒）。だから「ファイルがある」だけでは足りず、ポートにつながるかも見る（A と判断する）。
- Chrome を閉じたときのファイルの扱いと、Chrome の約 5 分の打ち切りの正確な時間・失敗の見え方は未測（`reissueMs`・`cancelBeforeMs` は前回の観察の約 5 分から決めた値で、Pleiad が先に閉じるので、時計がずれたときだけ Chrome の打ち切りに当たる）。

### 画面と操作

- 設定 › ブラウザーの「エージェントのブラウザー」（`web/browser-settings.mjs`。「エージェントの操作」の行の上）。1 行目は Chrome の印・「Chrome」・状態の字（`role=status`）・右にボタン。`off`: 「つながっていません」＋「つなぐ」（切れた理由があれば 1 行）。`setup`: 手順 2 つ（アドレス `chrome://inspect/#remote-debugging` をコピー → Chrome のアドレス欄に貼り付けて開き「Allow remote debugging for this browser instance」をオン）＋主のボタン「アドレスをコピー」＋「やめる」、弱い字で「オンになったら自動で進みます」。状態の字は、ファイルが無いときは「Chrome の準備が要ります」、ファイルはあるのにつながらない（`unreachable`）ときは「Chrome が起動していないか、リモート デバッグがオフです」と、手順の前に「Chrome を閉じているなら、起動すると自動で進みます」（Chrome を閉じた後の次の接続でトグルの案内だけが出て合わなかったため。2026-10-07）。`permission`: 「Chrome に許可の確認が出ています」＋「ダイアログを前に出す」＋「やめる」、弱い字で「Chrome が確認を出し直しても、そのまま待ちます」（出し直しでは字を変えない）。`denied`: 「Chrome で許可されませんでした」＋「もう一度」＋「やめる」（「キャンセル」と確認の「[設定] でオフにする」を見分けられないので、どちらとも取れる字。2026-10-06）。`connected`: 「つながっています · Chrome 154」＋「切る」、弱い字で、つないでいる間は Chrome の窓に「自動テスト ソフトウェアによって制御されています」の帯が出ることがあること。`unsupported`: 「この OS ではまだ使えません」だけ（OS 以外の理由は「この環境ではまだ使えません」）。承認済み（2026-10-06。UX モックの 09）。
- 操作（`core/ops/browser.mjs`）: `browser.chromeStatus`（read。MCP の catalog・CLI の `pleiad browser status` にも出る）。`browser.chromeConnect`・`browser.chromeDisconnect`・`browser.chromeRaiseDialog`（write。画面だけ・ホストの PC の画面だけ。`hostScreenOnly`）。WS のコマンドは `chromeStatus`・`chromeConnect`・`chromeDisconnect`・`chromeRaiseDialog`（`legacyCommand`）。つなぐ・切る・前に出すを `human-only` にしないのは、`human-only` が ADR 0094 の 5 つだけだから（画面だけに出すのは `surfaces` で決める）。
- 状態の便りは `chromeBrowser` イベント（`{ state, reason, dialog, product }`、`sessionId: null`）。**ホストの PC の画面（`isLocalRequest`）にだけ**流し、リモートの端末には送らない。つないだ画面には今の状態を最初に 1 回送る。

## Chrome の中継（開発中）

[ADR 0148](adr/0148-agent-browser-in-chrome.md)・[ADR 0153](adr/0153-chrome-connection-waits-indefinitely-behind-os-layer.md) の第 3 段。エージェントの agent-browser を、上の「Chrome への接続」の 1 本の上で、**会話の窓の範囲にだけ絞った CDP** につなぐ中継（`core/chrome/relay.mjs`）。**環境変数 `AGENT_HOST_AGENT_BROWSER=chrome` のときだけ**使う（開発と実機の確かめ用。設定にも画面にも出さない）。値が無い・ほかの値のときは、上の「エージェントの操作」の内蔵ブラウザーの道のまま何も変わらない。Electron の無いホスト（`npm start`）では値があっても使わない（接続が無いので内蔵ブラウザーの道のまま）。第 7 段の切り替えで環境変数を消し、この道だけにする。

- **使い方**: `AGENT_HOST_AGENT_BROWSER=chrome npm run desktop`。先に設定 › ブラウザー › 「エージェントのブラウザー」で「つなぐ」を押して許可しておく。エージェントが接続の無いままつなぐと、中継は接続を求めて（Chrome に許可の確認が出る）約 20 秒（`connectWaitMs`）だけ待ち、つながらなければ「まだつながっていない」の失敗を返して待ちを外す（ほかに待つ人がいなければ確認も閉じる）。そのとき接続が `setup` なら「Chrome が起動していないか、リモート デバッグがオフ」、それ以外は「許可を待っている」の文で返す。操作待ちのカード・`hand_to_user` で無期限に待つ形は第 7 段。
- **渡し方**: ターンの開始（`browserEnvironment`）で、端点を parentPort の往復なしに core の中継から取る（`core/agent-browser.mjs` の `chromeRelayBrowser`）。`agent-browser.json` の `cdp`・環境変数は内蔵ブラウザーの道と同じで、`AGENT_BROWSER_PIN_TAB=1` を足す（agent-browser を自分のタブに縛る。3 つのバックエンドの env に入る。Codex は `shell_environment_policy.set` に、この値があるときだけ足す）。端点は `ws://127.0.0.1:<port>/devtools/browser/<鍵 48 桁>`（内蔵ブラウザーの中継と同じ形）。待ち受けのポートは中継に 1 つ、鍵は会話ごと。`Host` が `127.0.0.1:<port>` でない・相手が loopback でない・鍵が違う接続は断る。
- **止める**: `stop(sessionId)` はつないでいる接続を閉じ、次の人の送信（`unlock` の `endpoint`。鍵を作り直す）まで再接続を断る。ターンの終わり（`endTurn`）は、そのタブで出ている確認を取り下げ、エージェントが動かしている印を外す。会話を消すと鍵を捨てる（窓を閉じるのは第 8 段）。画面から止める口は `browser.chromeStop`（下の「止める・引き継ぐ・戻す」）。
- **上りへ送るもの**: 最初のエージェントの接続で `Target.setDiscoverTargets` を 1 回だけ送り、範囲を知るのに使う（利用者のタブの `targetCreated`・`targetInfoChanged` も届くが、範囲の外のものは URL・題を覚えず、ログにも出さず、エージェントへ送らない）。**ブラウザー全体の `Target.setAutoAttach` は一度も送らない**（利用者の全タブに attach するため。エージェントが送ったものは中継の中で範囲のタブにだけ attach して真似る）。エージェントの接続が閉じたら、その接続が attach したセッションを上りで外す。上りが切れたら（Chrome が閉じた・許可の取り消し・「切る」）、エージェントの接続も閉じる（1011）。

### 範囲

範囲は会話の窓（`windowId`）の集合。中継が作った窓のタブと、範囲のタブが開いたタブ（`openerId`。`popup` 指定の `window.open` の別窓は、その窓も範囲に足す）。ほかの経路でその窓に入ったタブは `Browser.getWindowForTarget` で見つける（会話の窓が 1 つも無い間は問い合わせない）。`sessionId` はどのエージェントの接続が attach したものかを覚え（`Target.attachedToTarget` は応答より先に届くので、待っている attach に結ぶ）、ほかの接続・ほかの会話の `sessionId` は断る。セッションの自動 attach で付いた子（iframe・worker）は親と同じ接続のもの。

**窓**: `Target.createTarget` は、context・`newWindow` などの指定を捨てて、`scope.openTab`（`core/chrome/windows.mjs`。下の「専用の窓」）で会話の窓に作る。CDP の `createTarget` には窓を選ぶ引数が無いので、**2 つ目以降のタブは別の窓**になる（同じ会話の範囲には入る）。窓は最小化せず、画面の外の見えない窓に置く。窓を前に出す `Page.bringToFront`・`Target.activateTarget` は、Chrome へ送らずに成功で返す（範囲の外の `targetId` は今までどおり断る）。

| | メソッド（ブラウザーの上） |
|---|---|
| 通す | `Browser.getVersion` |
| 範囲のときだけ通す | `Target.getTargetInfo`・`Target.attachToTarget`（`flatten: true` を強いる）・`Target.detachFromTarget`（自分の接続のセッション）・`Target.closeTarget`・`Target.activateTarget`・`Browser.getWindowForTarget`・`Browser.getWindowBounds`／`Browser.setContentsSize`（会話の窓。agent-browser の `set viewport`） |
| 真似る（上りへ送らない・送り方を変える） | `Target.setDiscoverTargets`（範囲のタブの `targetCreated` を配る）・`Target.getTargets`（範囲のタブだけ）・`Target.setAutoAttach`（範囲のタブにだけ attach）・`Target.getBrowserContexts`（空）・`Target.createTarget`（会話の窓に作る） |
| 断る | 上のどれでもないもの全部。`Browser.close`・`Browser.crash`・`Browser.setDownloadBehavior`・`Browser.setWindowBounds`（窓を戻すと前面を取りうる）・`Browser.grantPermissions` など、`Storage.*`、`Network.getAllCookies`、`Target.createBrowserContext`・`disposeBrowserContext`・`exposeDevToolsProtocol`・`setRemoteLocations`・`sendMessageToTarget`、`SystemInfo.*` |

セッションの上（タブ・iframe・worker）は通すのが既定（agent-browser が使うコマンドを壊さないため。許す一覧の外を断る形には、今は替えない）。**断る一覧の考え方**: ブラウザー全体に効くものに加えて、ドメインとしては通すものでも、**引数でほかの origin・`storageKey`・url を指せて、自分のタブの外に届くコマンドは断る**（内蔵ブラウザーは Pleiad 専用のパーティションで中身が空だったので害が無かったが、利用者の Chrome のプロフィールでは、ほかのサイトの保存データ・ログインに届く）。足すときは Chromium の `/json/protocol` の引数名（`securityOrigin`・`storageKey`・`storageId`・`origin`・`url`・`scopeURL`）から洗う（2026-10-07 に Chromium 151 で洗った）。

| | セッションの上で断るもの |
|---|---|
| ブラウザー全体 | `Target.*`（`Target.setAutoAttach` は iframe のために通す）・`Browser.*`・`Storage.*`・`Extensions.*`・`PWA.*`・`Autofill.*`・`Cast.*`・`SystemInfo.*`・`Tethering.*`・`Network.getAllCookies`・`Network.clearBrowserCookies`・`Network.clearBrowserCache`・`Page.setDownloadBehavior`・`Security.setIgnoreCertificateErrors` |
| ほかの origin の保存データ | `DOMStorage.*`（`storageId.securityOrigin`）・`IndexedDB.*`・`CacheStorage.*`（`securityOrigin`・`storageKey`）・`Database.*`・`FileSystem.*`（`storageKey`）・`ServiceWorker.*`（`origin`・`scopeURL`）・`BackgroundService.*`（記録が全 origin の分） |
| ほかのサイトの Cookie・資格情報・接続 | `Page.deleteCookie`（任意の url）・`Network.loadNetworkResource`（資格情報つきでほかの origin を取れ、サイトの確認を通らない）・`Network.getCertificate`（任意の origin）・`Network.enableDeviceBoundSessions`・`Network.deleteDeviceBoundSession`（全サイトの分） |
| 送り先の差し替え | `Network.setRequestInterception`・`Network.continueInterceptedRequest`（古い横取り。agent-browser は `Fetch` を使う）。`Fetch.continueRequest` の `url` は、止まった要求と同じ origin のときだけ通す（ほかの origin へ替えると、確認を通らずにそのサイトへ届く） |

書き換え・制限: `Page.navigate` は http(s)（認証情報なし）と `about:blank` だけ（ブラウザーの上の `Target.createTarget` の `url` も同じ規則）。`Network.getCookies` は `urls` を外して今のページの分だけにする。`Network.setCookie`・`setCookies`・`deleteCookies` は今のページのホスト（とその親のドメイン）の Cookie だけで、`url` と `domain` は**渡されたものを両方とも**見る（Chrome は `domain` を `url` より優先して使うことがある）。確認が ON の間の「今のページ」は、下の移り終えた先の origin（断った先のエラーのページはどのホストでもない）。

残したもの（洗った上で通す）: `DOM.setFileInputFiles`・`Input.dispatchDragEvent` の `files`（ファイルのアップロードは正当な使い方で、エージェントは元々シェルでローカルのファイルを読める）。`Page.getResourceContent`・`searchInResource`（自分のフレームの資源だけ）、`Network.fetchSchemefulSite`（計算だけ）、`Debugger.setBreakpointByUrl`・`DOMDebugger.setXHRBreakpoint`（自分のページ）、`WebAuthn.*`（仮想の認証器はそのタブだけ）、`FedCm.*`（そのタブに出た画面の操作）、`Tracing.*`（agent-browser の記録が使う）。

### サイトの利用の確認（Chrome）

`confirmAgentSites` が ON のとき、中継が範囲のタブに**自分の**セッションを attach して `Page.enable` と `Fetch.enable({ patterns: [{ urlPattern: '*', resourceType: 'Document', requestStage: 'Request' }] })` をし、主フレームの要求（クリック・リダイレクト・スクリプト・`Page.navigate`）を**要求を出す前に**止めて、内蔵ブラウザーと同じ `createBrowserSiteApprovals`（`core/browser-confirm.mjs`）で聞く。許可で `Fetch.continueRequest`、断られたら `Fetch.failRequest('BlockedByClient')`。OFF にすると中継のセッションを外す（止めている要求は通す）。

- **今の origin は、移り終えた先**: 中継のセッションの `Page.frameNavigated`（主フレーム）の `frame.securityOrigin` で持つ（付けたときは `Page.getFrameTree`）。http(s) だけで、エラーのページ（`unreachableUrl` がある）・`about:blank`・`data:` などは「どの origin でもない」。`targetInfo` の URL は、断った後のエラーのページでも断った URL を指すので使わない（それで比べていた頃は、断った直後に同じ origin へもう一度移ると聞かずに通った。2026-10-07 の受け入れの不具合 4）。
- **聞かないもの**: iframe（**確認はトップフレームの単位**。範囲のタブの中のクロス origin の iframe には聞かずに入る。iframe を読ませないのは各サイトの `X-Frame-Options`・`frame-ancestors` に頼る。内蔵ブラウザーも同じ）・今の origin と同じ・同じ移動（リダイレクトの続き）の中で許可済みの origin・**エージェントが動かしていないタブ**。許可は移り終えた移動にだけ付く（許可したまま移り終えなかった分は、次の新しい移動で捨てる）。
- **エージェントが動かしている印**: エージェントが作ったタブと、エージェントの接続が有効化（`*.enable`・`*.disable`）・`Runtime.runIfWaitingForDebugger`・`Target.setAutoAttach` 以外のコマンドを送ったタブ（DOM の書き換え・`Runtime.runScript`・`Debugger.*` などでも移動はできるため）。ターンの終わりで外れる＝ターンの外の人の操作には確認を挟まない。
- **確認を ON にした直後**: 中継のセッションの準備（`Page.enable`・`Fetch.enable`）が済むまで、エージェントの移動のコマンド（`Input.*`・`Runtime.evaluate`・`callFunctionOn`・`Page.navigate`・`reload`・`navigateToHistoryEntry`）を待たせる（待たずに送ると止まらずに移っていた）。
- **要求を出さずに移ったとき**（`Page.navigateToHistoryEntry`・戻る・進むの bfcache の復元など、`Fetch` が鳴らない移動）: 移り終えた `frameNavigated` で、今の origin と違い確認を通っていない origin なら、**移った後に**聞く。答えを待つ間は、そのタブへのエージェントのコマンドを待たせ（戻ったページを読ませない）、断られたら `about:blank` へ移してから放す。`navigateToHistoryEntry` の応答は、移り終えるのを最長 1 秒待ってから確認の答えを見る。
- **断られた移動の返し方**: `Page.navigate` と、確認が済む前に応答が返った操作のコマンドに、断られた文（確認の答えの文、無ければ「サイトへの移動が許可されませんでした。」）の失敗として返す。断りは、断られた時点で最後に送られていた操作のコマンドに返す（並んで送られたほかの操作には返さない）。URL つきの `Target.createTarget` は、空のタブを作ってから確認を通して移り、断られたら閉じる。

**`window.open` のタブの最初の要求は止められない**（実機。開いた側のセッションの `Fetch` は新しいタブに効かず、後から attach しても間に合わない）。範囲のタブが開いたタブ（`openerId`）は、URL が付いた時点（最初の要求の後）か最初に移り終えた時点の早いほうで、開いたタブの今の origin（移り終えた先）と同じでなければ聞く。答えを待つ間はそのタブへのコマンドを待たせ、断られたら `Target.closeTarget` で閉じる。ON にした人への「Chrome では一部の移動を止められません」の注記は第 7 段で設定に出す。

### agent-browser 0.38.1 の見え方（2026-10-06）

Playwright の Chromium 151（一時のプロフィール。利用者の Chrome ではない）の前に記録用の中継を置いて記録し、偽の Chrome の通しでも同じ流れを確かめた。

- つなぐと `Target.setDiscoverTargets` → `Target.getTargets` → タブに `Target.attachToTarget`（`flatten`）。セッションの上で `Page.enable`・`Runtime.enable`・`Network.enable`・`WebMCP.enable`・`Target.setAutoAttach`（`waitForDebuggerOnStart: true`）・`Runtime.runIfWaitingForDebugger`。コマンドごとに `Browser.getVersion` を送る。
- **ブラウザー全体の `Target.setAutoAttach` は送らない。** `AGENT_BROWSER_PIN_TAB=1` では、つないだ最初に自分のタブを `Target.createTarget`（`about:blank`、`newWindow` なし）で作る。範囲のタブが 0 の新しい会話では最初に 2 つ作る（1 つ目は `about:blank` のまま残る。仮の窓では窓が 2 つ）。
- **`close` は外の Chrome に何も送らない**（`Browser.close` を送らず、中継との接続を切るだけ）。`tab close` は `Target.closeTarget`。`set viewport` は `Emulation.setDeviceMetricsOverride` と `Browser.getWindowForTarget`＋`Browser.setContentsSize`。`cookies` はセッションの `Network.getCookies`（`urls` なし）。

### 専用の窓（ADR 0154。第 4 段）

会話ごとの窓は `core/chrome/windows.mjs`（`createChromeWindows`。中継の `scope`）が開く。窓は**最小化しない**（最小化の窓は描画が止まり、`set viewport` が失敗する）。代わりに、画面の外（仮想デスクトップの右の外）・タスクバーと Alt+Tab から外す（`WS_EX_TOOLWINDOW`、`WS_EX_APPWINDOW` は外す）・透明度 0（`WS_EX_LAYERED`）・マウスの素通し（`WS_EX_TRANSPARENT`）に置く（OS の層の `conceal`）。窓の大きさは Pleiad が決める（`Browser.setWindowBounds` で `WINDOW_DIP` = 800×800 DIP。右パネルの映像の読みやすさで決めた。下の「リモートから見る」の「窓の大きさ」）。

- **会話の最初の窓**: `chrome.exe --profile-directory=<Local State の profile.last_used> --new-window <題に nonce を持つ data: のページ>`。`AGENT_HOST_CHROME_USER_DATA` があるときは `--user-data-dir=<その値>` を必ず付ける（付けないと既定の Chrome に窓が開く。既定の User Data のときは付けない）。`chrome.exe` の場所は OS の層（Windows はレジストリの App Paths の HKCU → HKLM、無ければ Program Files・Program Files (x86)・LOCALAPPDATA の既定の位置）。題の nonce で HWND を見つけて（20 ms ごと、上限 3 秒）隠し、前面を取っていたら窓を開く前の前面へ返す。そのあと Chrome の側のタブ（nonce のページ）を頼まれた URL へ移す。題で見つからなければ窓の外形（`Browser.getWindowForTarget` の bounds）で探し、それでも見つからなければ「隠せなかった」とログに出して続ける。`chrome.exe` が見つからない・起こせないときは、次の `createTarget` の道に落とす（プロフィールは選べない）。`--window-position`・`--window-size` は付けない（起動中の Chrome に渡す新しい窓では無視される。実機）。
- **2 枚目からのタブ**: 新しい窓（`Target.createTarget({ newWindow: true, background: true, left, top, width, height })`。画面の外の位置を渡し、題の nonce で見つけて隠す）。同じ窓へ足すと、裏のタブは hidden になって描画が間引かれ、`bringToFront` を握りつぶしているので前へ出せないため、タブごとに窓を持つ。
- **window.open**: タブは同じ窓に入る。popup の別窓は、中継が範囲に足したあと（`openerId`）、窓の外形（`Browser.getWindowBounds`）で見つけて同じ置き方にする（`scope.adoptPopup`）。
- **外形で窓を探すとき**（popup・題で見つからない最初の窓）: 利用者の窓・Edge の窓・別の Chrome の窓を取り違えて隠さないよう、(a) つないだ Chrome のプロセス（`DevToolsActivePort` のポートの待ち受け）の窓だけを、窓を開く前の写し（`snapshotWindows`）に無いものに絞る。プロセスを引けなければ採用しない（隠さない）。(b) 探す前に CDP の `Browser.setWindowBounds` でその窓を一意な位置（画面の外。同時に探す窓同士がぶつからないよう位置を揺らす。最初の窓は大きさにも端数を付ける）へ置き、その外形を狭い許容（2 DIP）で探す。置けなければ、今の外形を (a) の絞り込みのうえで 16 DIP で探す。複数合えば曖昧として隠さない。
- **専用の窓だけが閉じられた**: 窓の最後のタブが消えたら窓の記録を捨て（`scope.windowClosed`）、次に窓が要るときに黙って開き直す。**接続が切れた**（Chrome が閉じた・許可の取り消し・利用者が切った）: 窓の記録を全部捨て（`scope.reset`）、そのとき**隠した窓を閉じる**（`closeAgent`。画面の外・透明・マウス素通しの窓は、記録を捨てると誰にも戻せないため。エージェント専用の窓なので、残すより閉じるほうが利用者の驚きが少ない）。Chrome が本当に落ちていて窓がもう無ければ、記録を捨てるだけ。閉じる依頼が出せなければ見える形へ戻し、依頼を出したのに 3 秒経っても残る窓（離れる確認など）も見える形へ戻す。窓を開く途中（隠した後）の失敗も同じく窓を閉じる。会話ごとの `openTab` は順に流す（同時に最初の窓を 2 つ開かない）。
- **Pleiad の終了**: `desktop/main.cjs` が `will-quit`（と、`will-quit` を通らない `app.exit`）で、隠している窓を全部片付ける（`closeAllAgents`。閉じられなければ見える形へ戻す。引き継いだ窓は閉じない）。
- **前面の見張り**（OS の層）: 隠している窓があるあいだ 100 ms ごとに前面を見て、隠した窓が前面を取ったら、**その窓が前面を取る直前の前面**へすぐ返す（隠した直後にも 1 回見る。引き継いで見える形に戻した窓は見ない。下の「止める・引き継ぐ・戻す」）。隠した窓が持ち主の窓（翻訳の確認・権限の確認などの吹き出しは別の最上位の窓として今の画面の位置に出て、前面まで取る）も一緒に隠す。ただし「リモート デバッグを許可しますか？」の確認の窓（層が確認として出した窓・題が既知で小さい窓）は隠さない（利用者が見て、Pleiad が閉じる）。周期の中の失敗はログに残して見張りを続ける。
- **画面の構成の変化**（モニターの増減・解像度・DPI・スリープ復帰）: `desktop/main.cjs` が Electron の `screen` の `display-added`・`display-removed`・`display-metrics-changed` と `powerMonitor` の `resume` で `reconceal` を呼び、隠している窓（吹き出しの窓を含む）を置き直す。Chrome が画面の中へ寄せても、透明度 0・マウス素通しなので見えない。
- **focus emulation**: エージェントのターンの間（`endpoint` を渡してから `endTurn`・止める・消すまで）、会話の窓のタブすべてに、中継自身のセッションで `Emulation.setFocusEmulationEnabled(true)` を保つ（タブが増えたら足す。ターンが終わったら外してセッションも外す）。エージェントのセッションの付け外しでは切れない。Chrome の側で外されたら、ターンの間は付け直す。外すと隠れた窓のページは `hidden`・描画停止に戻る（CPU を使い続けない）。右パネルで映像を見ている間も保つ（理由はターンと映像の 2 つで、どちらも無くなったときだけ外す。下の「リモートから見る」の「focus emulation の数え方」）。

実機（確かめ専用の Chrome 154。2026-10-07。agent-browser 0.38.1）: `open`・`snapshot`・`screenshot`・`click`・`fill`・`scroll`・`set viewport`・`tab new`・`tab tN`・`window.open` の tab と popup が各 3 回とも効き、25〜110 ms（`tab new` は約 350 ms、`window.open` を押す操作は 0.1〜1 秒）。`screenshot` は白紙でない。最初の窓が画面に見えるのは約 95〜110 ms で、前面を取るのは約 125 ms（そのあと開く前の前面へ返す）。2 枚目からの窓は 0〜16 ms。popup は約 60 ms 画面に見え、約 100 ms 前面を取って返す。受け入れで見た「screenshot が 30 秒止まる」は、`chrome.exe --new-window` の窓（90 秒置いても screenshot 約 100 ms）でも、それを最小化した旧設計の窓（screenshot 2.3〜2.7 秒、click 約 0.5 秒）でも再現しなかった。

**既知の制約**: `window.open`（`target="_blank"`）のタブは同じ窓に入り、元のタブが裏になる。agent-browser が元のタブへ `tab tN` で戻しても `bringToFront` は握りつぶすので裏のまま、描画が間引かれて（`requestAnimationFrame` が約 2 fps）`screenshot` が 2.3〜2.5 秒、`click` が約 0.5 秒かかる（効きはする）。`Page.bringToFront`・`Target.activateTarget` は中継が握りつぶすので窓は前面に出ない。隠した窓が前面を取るのは、Chrome 自身の前面化と `window.open` の popup で、約 30〜110 ms で見張りが返す。`WS_EX_NOACTIVATE` を付けても前面は取られた。Pleiad の終了で閉じる依頼（`WM_CLOSE`）は、依頼を出すだけで窓が閉じたかは待たない（離れる確認が出る窓は隠れたまま残りうる。Pleiad が終わった後なので戻せない）。

### 止める・引き継ぐ・戻す（ADR 0148・0154。第 6 段）

窓（会話）ごとの状態は `core/chrome/control.mjs`（`createChromeControl`）が 4 つに分ける。

| 状態 | 意味 |
|---|---|
| `running` | エージェントのターンの間（`endpoint` を渡してから `endTurn` まで。focus emulation の付け外しと同じ合図） |
| `idle` | ターンの外（待機中） |
| `stopped` | 「止める」。接続を閉じ、次の人の送信（`unlock` の `endpoint`）まで再接続を断つ（中継の `stop`。ターンの開始で鍵を作り直す） |
| `paused` | 「引き継ぐ」。エージェントのブラウザーとタブの接続を切り、つなぎ直された接続のコマンドも全部断る |

状態は中継の会話の記録（`turn`・`stopped`・`paused`）が持ち、変わるたびに `relay.onChange(sessionId)` が呼ばれる。control は同じ状態を重ねて配らない。`paused` は `stopped` より優先して見せる。

- **引き継ぐ**（`browser.chromeTakeOver`。画面とリモートの端末から。`takeOver`）: (1) 見せられる窓（OS の層が出した ref を持つ窓）が無ければ、何もせず `NO_WINDOW`（一時停止はエージェントの接続を切るので、窓が無いのに切らない）。(2) 中継を `pause`: **エージェントのブラウザーとタブの接続を切る**（上りのセッションを `Target.detachFromTarget` で外し、ws を `1000 paused` で閉じる。Chrome からの通知（`Network.requestWillBeSent` の `postData`・`Fetch.requestPaused` など）がエージェントへ流れ続けず、エージェントが付けていた `Fetch` の横取りもセッションごと外れて人のページが固まらない。戻した後は agent-browser がつなぎ直す）。つなぎ直した接続も受けるが、コマンドは全部 `PAUSED_MESSAGE`「人が Chrome の窓を操作中です（一時停止）。`hand_to_user` を呼んで、戻るのを待ってください」と英語の同じ文で断る（ブラウザーの口でもセッションの口でも。通知の登録（`Target.setDiscoverTargets`・`setAutoAttach`）も付かない）。一時停止中に人が開いたタブにも、エージェントのセッションは付けない。一時停止の間はタブを「エージェントが動かしている」と見なさない（人のページの移動・人のページが開いたポップアップを、サイトの利用の確認にかけない。確認の待ちも取り下げる）。会話の範囲の上りへの送信は、送る直前にもう一度一時停止と接続を見る（確認の待ち・準備の待ちの後ろに並んでいたコマンドが、一時停止の後に Chrome へ届かない。`Target.createTarget` も窓を作る間に引き継がれたら、作った窓を閉じて断る）。エージェントのタブには `Runtime.terminateExecution`（中継自身の一時のセッション）を送って、今走っているスクリプトを止める。**効くのは今走っている同期のスクリプトだけ**で、エージェントが待っている `Runtime.evaluate` の Promise・タイマー・ページ自身のスクリプトの次の実行は止まらない。(3) 窓を戻す画面の手がかりは、**Pleiad 自身の窓**（OS の層の `appWindow`。main の BrowserWindow。引けなければその時の前面）。リモートの端末から押したときも、その時の PC の前面ではなく PC の Pleiad の窓のある画面になる。一時停止に入ってから引く。(4) 会話の窓を全部、見える形に戻し（`reveal`。付けたスタイルだけを外し、手がかりの窓のあるモニターの中へ動かす。隠していたときに一緒に隠した Chrome の吹き出し（許可の確認・パスワードの保存など。持ち主つきの窓）も見える形に戻す）、エージェントが最後に操作したタブの窓を前に出す（`raise`。押された直後の main の前面の権利、通らなければ `AttachThreadInput`）。**リモートの端末から押しても、PC の窓が前に出て PC の前面を取る**（ADR 0148 の「PC で操作する」。PC の前に居る人が操作する前提）。見える形に戻した窓が 1 つも無ければ、一時停止を戻して `NO_WINDOW`。(5) 映像・撮影を断つ（下の「撮影を断つ」）。見えている間は、OS の層の前面の見張りがその窓を見ない（`reveal` が隠した印を外す）ので、人が前面に置いたままにできる。窓が複数あれば全部見える形に戻す（前に出すのは最後に操作した窓）。
- **戻す**（`browser.chromeResume`。「Claude に戻す」）: (1) 引き継ぎの間に人が窓を作り替えた分（タブを引き離して作った窓・窓ごと閉じた）を先に取り込む（`relay.refreshWindows`。タブごとの今の窓を引き直し、新しい窓は範囲に足し、タブの無くなった窓の記録は捨てる）。(2) 窓を画面の外の見えない窓に戻す（`conceal`。引き継いでいる間に開いた popup・人が引き離して作った窓は、人の窓を画面の外へ動かさないよう引き継ぎ中は動かさず、ここで外形で探して隠す。人が前面に置いていた窓が前面のままにならないよう、今の前面（隠す窓でなければ）か Pleiad の窓へ返す）。(3) **隠せなかった窓が 1 つでもあれば、一時停止を解かない**（paused のまま。窓が見えたままエージェントのコマンドを通さない）。`chromeControl` の状態に `error: 'conceal-failed'` を載せて画面へ返し（「窓を隠せなかったので、一時停止のままです。もう一度「戻す」を押してください」）、もう一度「戻す」で試せる。会話の行も残さない。(4) 全部隠せたら一時停止を解く。会話に「あなたが引き継ぎ · Claude に戻しました · 1 分 12 秒」の行（`present` の `kind: 'chromeHandover'`、`chromeHandover: { seconds }`）を残す。
- **止める**（`browser.chromeStop`）: 中継の `stop`。引き継いでいるときは、窓を戻してから止める（窓を隠せなければ止めず、paused のまま `error` を返す）。
- 同じ会話の操作は順に流す（同時に引き継ぐ・戻すが窓を二重に動かさない）。
- **窓を × で閉じられた**: `paused` のまま（つなぎ直したエージェントのコマンドは断る）。「戻す」で解け、次に使うとき第 4 段のとおり黙って開き直す。**Chrome ごと閉じた**: 接続が off になり、中継が `paused` も解く。
- **自動の一時停止は作らない**（ADR 0154。窓が見えるのは引き継ぎのときだけ）。待機中の「Chrome で開く」も置かず、見せるなら引き継ぎ（一時停止）にする。「Claude に戻して続ける」（戻したときにターンが終わっていれば人の送信を送る）と `hand_to_user` は第 7 段。
- **便り**: 状態は `chromeControl` イベント（`{ sessionId, state, since, error }`。`since` は `paused` の始まりの時刻 ms、`error` は戻せなかった理由 `conceal-failed`。無ければ null）、エージェントが押した位置は `chromeTap`（`{ sessionId, x, y, windowId }`。`Input.dispatchMouseEvent` の `mousePressed` の座標だけ）。どちらも会話ごとに全部の接続（ホストの画面とリモートの端末）へ流し、再送の置き場には積まない。画面がつなぎ直したときは、待機中でない会話の今の状態を配る。操作は WS の `chromeTakeOver`・`chromeResume`・`chromeStop`（`{ sessionId }`。`risk: 'write'`、`surfaces` は ui だけで MCP・CLI には出さない。ホストの画面だけには限らない。human-only は [ADR 0094](adr/0094-human-only-five.md) の 5 つに限る）。
- **撮影を断つ**: control は中継の状態の変化（`relay.onChange`）に合わせて、`paused` に入った時に同期で `capture.suspend(sessionId)`（`relay.pause` の中から呼ばれ、窓を見える形に戻す前に効く）、解けた時に `resume(sessionId)` を呼ぶ（`server.mjs` の `createChromeControl({ capture: chromeScreencast })`）。戻す・止める（窓を戻してから止める）・Chrome が閉じた・会話を消す・`rebind` のどれで解けても対になる（中継から消えた会話の分は次の変化で `resume` して片付ける。映像の側も会話を消す・接続の切断で断りを自分で消し、`rebind` で新しい id へ移す）。映像の幕と「映像を止めています」は映像の側（`.cp-veil`）の 1 つだけで、control の層は幕を持たない。
- **実機**（確かめ専用の Chrome 154・agent-browser 0.38.1・本物の OS の層。2026-10-08）: 引き継ぐと窓が画面の中・前面に出て（約 40 ms）、一時停止中のコマンドは 3 つとも `hand_to_user` の文で断られ、窓で人がクリックしても（CDP と本物のマウスの両方）3 秒待っても前面は返らない。映像のフレームは引き継ぐと 0 になり、戻すと 150 フレーム / 2.5 秒で戻る。戻すと窓は隠れて前面は元の窓へ返る。止めると再接続が `Handshake not finished` で断られ、人の送信で解ける。引き継ぎ中に窓を × で閉じても paused のまま、戻すと解けて、次の `tab new` で黙って開き直す。`raise` は前面の権利を持たない呼び出し元では attach 方式になり、まれに失敗と報告する（窓は結果として前面に来る）。
- **画面の部品と差し込み**: `web/chrome-control.mjs`（状態の一行・一時停止中の帯・押した位置の輪、状態の置き場 `chromeControlStore`、会話の行）。`createChromeControlView({ run, getName, onError })` の `root`（状態の一行）を `chromePanel.mountStatus`（映像の上の `.cp-slot`）、`overlay`（輪の層）を `chromePanel.mountOverlay`（映像の箱 `.cp-screen` の中）、`banner`（一時停止中の帯）を会話の側の `#chromeBanner`（入力欄の上）へ入れる（`web/client.mjs`）。一行は、窓がある会話か一時停止中の会話にだけ出す（窓が × で閉じられても、一時停止中は帯から戻せる）。輪の位置は映像の最後のフレームの `metadata.deviceWidth/Height`（`chromePanel.frameSize()`）で割合にする。状態は `chromeControlStore.get(sessionId)`・`onChange`・`onTap` で引き、接続し直したら `clear()` して、サーバーが続けて送る今の状態を待つ。

## OS ごとの層

窓を前に出す・確認の窓を見つけて閉じる、といった OS で違う操作は、`core/chrome/os.mjs` の口（core から見た約束）の向こうの、Electron main の `desktop/chrome-os/<os>.cjs` に閉じ込める（ADR 0153）。`core/chrome/` のほかのファイルは OS の値（窓のハンドルなど）を持たず、窓は不透明な `WindowRef = { id }` で扱う。core と main は parentPort の `chrome-os`（`{ id, action, args }`）⇔ `chrome-os-result`（`{ id, ok, result | error }`）と、`chrome-os-ready { supported, reason, features }`（起動時と `chrome-os-ready-request` への返事）でつなぐ。

| 口 | 意味 | Windows の実装（`desktop/chrome-os/win32.cjs`） |
|---|---|---|
| `capabilities()`・`ready()`・`onReady(fn)` | 層が使えるか・どの機能があるか。使えなければ `supported: false` | koffi を読めたか。今ある機能は `dialog`・`raise` |
| `snapshotWindows()` | 今あるブラウザーの最上位の窓の印（確認の見つけ方の比べ元） | クラス `Chrome_WidgetWin_1` で、実行ファイルが `chrome.exe`・`msedge.exe` の窓（Electron のアプリは除く） |
| `findPermissionDialog({ since, port })` | 確認の窓 | `since` に無い・見えている・最小化でない・外形が 1000×700 DIP 以下。題が既知なら優先、無ければブラウザーの窓が持ち主の窓が 1 つだけのとき。`port`（`DevToolsActivePort` のポート）があれば、そのポートを待ち受けるプロセス（Windows は `GetExtendedTcpTable`）の窓だけ。別の `User Data` の Chrome・Edge・別の `chrome.exe` と取り違えて閉じない（持ち主を引けなければ絞らない） |
| `raise(ref)` | 窓を前に出す（最小化なら戻す） | `SetForegroundWindow`、前面が変わらなければ `AttachThreadInput`＋`BringWindowToTop`＋`SetForegroundWindow`。`method` は `direct`・`attach`・`failed`・`unknown` |
| `yieldForeground(ref, { to })` | `ref` が前面を取っていたら `to` に返す | `raise` と同じ手順で `to` へ |
| `foreground()` | 今の前面の窓（`{ id, browser }`） | `GetForegroundWindow`。`browser` はブラウザー自身の窓か |
| `appWindow()` | Pleiad 自身の窓（引き継ぎで窓を戻す画面の手がかり） | main が渡す BrowserWindow のハンドル（`createChromeOs({ appHwnd })`）。閉じていれば `null`。`foreground()` と同じく層が覚える ref を返す |
| `close(ref)` | 確認の窓を閉じる | `PostMessageW(WM_CLOSE)`。層が確認として出した `ref` で、同じ実行ファイルの窓のときだけ |
| `locateBrowser({ product })` | ブラウザーの実行ファイル（`{ id, product }`。パスは返さない） | レジストリの App Paths（HKCU → HKLM）、無ければ既定の 3 か所。`chrome.exe` で、ファイルがあるものだけ |
| `launchWindow({ browser, profileDir, url, nonce, userDataDir?, position?, size? })` | `--profile-directory --new-window` で窓を開く | 層が出した `browser` の id だけ。プロフィール・nonce・`data:` の URL・`userDataDir`（絶対パス）を検査し、`--user-data-dir` は `userDataDir` があるときだけ付ける。切り離して起こす |
| `findWindowByNonce(nonce)`・`findWindowByBounds({ bounds, port, since, tolerance })` | エージェントの窓を見つける | 題に nonce を持つブラウザーの窓（確認の窓として出した窓は除く）。外形（DIP。DPI で換算、許容は `tolerance`、既定 16・最小 1）が合う、まだ出していない見えている窓がちょうど 1 つのとき。`port` の待ち受けのプロセスの窓だけ（引けなければ `null`）、`since`（`snapshotWindows` の写し）の窓は除く |
| `hiddenSpot()` | 仮想デスクトップの右の外 | 全モニターの右端 + 1000 物理画素（取れなければ 20000） |
| `conceal(ref)`・`reveal(ref, { near })`・`release(ref)` | 隠す・見える形に戻す・記録を捨てる | `conceal` は上の置き方（最初の拡張スタイルを覚え、何度でもかけ直せる。隠して出し直すのはスタイルが変わったときだけ。途中で失敗しても、隠しかけの窓を追える）。`reveal` は付けたスタイルだけを外して元に戻し、`near` のあるモニターの中へ（前には出さない）。隠していない窓には何もしない。エージェントの窓として出した `ref` だけ |
| `closeAgent(ref)` | エージェントの窓を閉じる | `PostMessageW(WM_CLOSE)`。窓がもう無ければ記録を捨てて `true`。依頼が出せなければ見える形へ戻して記録を捨てる（`false`）。依頼を出した窓は窓が無くなるまで見張り、3 秒経っても残れば見える形へ戻す。隠していない窓は閉じない。main だけの口 `closeAllAgents()` は、隠している窓を全部これで片付ける（`will-quit`・`app.exit`） |

どの口も、使えない OS・使えない機能・時間切れでは投げずに `null` / `false` を返す。層は自分が出した `ref` だけを覚え、**知らない値には何もしない**（ほかのアプリの窓を前に出す・閉じることが起きない）。koffi を読むのは `desktop/computer/win32.cjs` だけで、`desktop/main.cjs` が 1 回だけ読み、コンピューターの操作と Chrome の OS の層で表を共有する。読めなければ両方が unsupported。

ほかの OS を足すとき: `desktop/chrome-os/<os>.cjs` を書いて `index.cjs` の `createChromeOs` で選ぶ（口の表の全部）。`core/chrome/locate.mjs` の `chromeHomes` の表に、その OS の Chrome の `User Data` を 1 行足す。接続・状態機械・設定の画面は変えない。機能の有無は `capabilities().features`（`dialog`・`raise`・`launch`・`conceal`・`watch`・`bounds`）で示す。画面の構成が変わったときの置き直し（`reconceal`）は core から呼ぶ口ではなく、main が Electron のイベントで層を直に呼ぶ。

## 使える場所

デスクトップ版のホストの画面（ローカルの窓）だけ。ブラウザーで開いた Pleiad・リモートの窓・スマホには内蔵ブラウザーのモードを出さない（ホストの内蔵ブラウザーを画面の転送で見ることはできる。下の「リモートから見る」）。設定 › ブラウザーはすべての画面に出す。画面は `window.plyDesktop.browser` の有無と `window.plyRemote` が無いことで判断する（`web/browser-panel.mjs` の `browserPanelAvailable`）。リモートの窓の preload（`desktop/remote-preload.cjs`）には口を出さず、main も `ply:browser` を受ける前にローカルの窓の本体フレームかを確かめる（`desktop/window-trust.cjs`）。

## リモートから見る

画面の転送で見るものは 2 つある。**内蔵ブラウザー**（人が見るビューア。ホストの画面ではない端末から見て操作する）と、**エージェントの Chrome の窓**（エージェントが操作する専用の窓。ホストの画面もリモートの端末も、見るだけ）。どちらも `core/browser-screencast.mjs` の同じハブ（`createScreencastHub`）でフレームを配り、間引く。違うのは映像の出どころ（bridge）と、受ける接続・入力の可否。画面の側は、映像の描画と ack を `web/screencast-frame.mjs`（`createFrameSink`）で共有する。

### 内蔵ブラウザー（ビューア）

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

### Chrome の窓（エージェント。[ADR 0148](adr/0148-agent-browser-in-chrome.md) 第 5 段）

会話の専用の Chrome の窓（上の「専用の窓」。画面の外の見えない窓）の「今のタブ」の映像を、右パネルの「Chrome の窓」に映す。**見るだけ**: 押す・打つは何も送らず、「見るだけ · 操作は引き継いでから」と出すだけ（タッチでは常に出す。操作を引き継ぐのは第 6 段）。**環境変数 `AGENT_HOST_AGENT_BROWSER=chrome` のときだけ**で、窓のある会話にだけ入口が出る（環境変数が無いときの画面は変わらない）。内蔵ブラウザーの映像と違い、**ホストの画面もリモートの端末も**見られる。

- **映像の出どころ**（`core/chrome/screencast.mjs`。`createChromeScreencast`。`createScreencastHub` の bridge と同じ形）: 会話の「今のタブ」（エージェントが最後にコマンドを送ったタブ。`Target.createTarget`・`attachToTarget` でも覚える。無い・閉じていれば窓の最初のタブ）に、中継自身のセッション（`relay.view.attach`。エージェントのセッションとは別）を付け、`Page.startScreencast`（JPEG。大きさの上限は表示の箱 × 倍率、画質は自動 55・低 30）を回す。フレームの `metadata`（`deviceWidth`・`deviceHeight` など）はそのまま端末へ。URL・題は状態にも載せない（状態は `{ tabId, agent（エージェントが操作中か）, suspended, tabs }`）。
- **今のタブを追う**: エージェントが別のタブにコマンドを送る・新しいタブを開くと、映像のセッションを付け替える（前のタブの screencast と映像のセッションを外してから新しいタブへ）。窓のタブが 1 つも無くなる（窓だけ閉じられた）・Chrome との接続が切れる・会話を消すと、`ended`（`closed`）を端末へ送って手放す。
- **focus emulation の数え方**: 隠した窓のページは focus emulation が無いと描かれない（`Emulation.setFocusEmulationEnabled`。付けないとフレームが出ない）。理由は 2 つ: エージェントのターンの間（ADR 0154）と、映像を見ている間（`relay.view.focus`）。**Chrome は focus emulation をページに 1 つの状態として持ち、あるセッションが `enabled: false` にするか detach すると、ほかのセッションが有効にしていても外れる**（実機 2026-10-08。ターンの終わりで外したら映像のセッションが有効にしていても `document.hasFocus()` が false になった）。だから外すセッションを 1 タブ 1 本（relay の `tab.fe`）にして、**ターンと映像のどちらの理由も無くなったときだけ**外す。映像のセッションは focus emulation を触らない。映像を見るのをやめる・ターンが終わるだけでは、もう一方が残っていれば外れない。映像の理由は**映像の見張り（watch）ごとの札**で数える（`view.focus` の `owner`）ので、閉じてすぐ開き直しても、古い見張りの「手放す」が新しい見張りの理由を消さない。付け外しはタブごとに 1 つずつ順に流し、流す時に理由を見直す（「外す」が後から届いて「付ける」を打ち消さない）。会話を消す・id が替わる（rebind）と、その会話のタブの映像の理由は relay が全部手放す。Chrome の側で映像のセッションが外れたときも、そのタブの理由を手放してから付け直す。
- **送る頻度**: 内蔵ブラウザーと同じ（上の「送る頻度」。自動 200 ms・低 500 ms の間隔、見ている端末が描き終えるまで ack しない）。`createScreencastHub` に `source: 'chrome'` を渡すと、配るメッセージに `source: 'chrome'` が付き、画面が内蔵ブラウザーの映像と取り違えない。見る端末がいなくなれば（閉じる・接続が切れる）止めて、映像のセッションを外す。
- **撮影を断つ口**（第 6 段の control が、一時停止（paused）の間だけ呼ぶ。上の「止める・引き継ぐ・戻す」）: `bridge.suspend(sessionId[, windowId])`・`resume(同じ引数)`・`isSuspended`（`createChromeScreencast` の戻り値。`server.mjs` では `chromeScreencast`）。`windowId` があればその窓が今のタブの窓のときだけ、無ければ会話の窓すべて。断っている間は `Page.stopScreencast` で撮るのをやめ、映像のセッションを外し（ターンも無ければ focus emulation も外れる）、届いたフレームも流さず、見ている端末へ `state.suspended: true` を送る（画面は薄い幕と「映像を止めています」を出す）。`resume` で付け直す。**`suspend` と `resume` は呼ぶ側が対にする**。`suspend` は呼んだ時に同期で効き（付け替え・開始の順番待ちの途中でも、断った後に届いたフレームは流さない。フレームを配る所でも断りの鍵を直に見る）、見る前に断っていれば見始めても付けない。断りは会話の寿命と結ぶ: 会話を消す・Chrome の接続が切れると消え、id が替わると新しい id へ付け替わる。`windowId` なしの `resume` は、その会話の窓ごとの断りも全部外す。
- **口**: WS の `browserScreencast`・`browserScreencastStop`・`browserScreencastAck` に `source: 'chrome'` を付ける（`core/browser-screencast.mjs` の `screencastCommand` の `chrome = { hub, bridge }`）。ホストの画面（local）からも受ける（内蔵ブラウザーは `remote-only`）。`browserScreencastInput`・`Nav`・`Agent` と、`url`・`visualization` を開く指定は `view-only` で断る。窓の無い会話は `no-window`。エージェントの Chrome の窓の映像を持たないホストは `unavailable`。`hostCapabilities` の `chromeWindow` が、この映像を見られるか。
- **窓の有無と操作中の印**: サーバーが WS の `chromeWindow` イベント（`{ sessionId, windows, operating }`）を、**リモートの端末も含む全部の接続**へ流す（変わったときだけ。接続の直後に今の分を続けて送る。溜めない）。`operating` は、ターンの間にエージェントがタブを動かしている間（relay の `tab.active`）。頭の行の入口はこれで出し、操作中は走っている弧を出す（第 6 段が、窓ごとの running / idle / stopped / paused に置き換える）。
- **画面**（`web/chrome-panel.mjs`・`web/chrome-panel.css`・`web/header-entries.mjs` の `setupChromeEntry`）: 頭の行の入口（`#chromeEntry`。窓のある会話だけ。481px 以上は頭に、480px 以下は「…」の先頭の「開く」の下）から右パネルを「Chrome の窓」にする。パネルは、上に**状態の一行の差し込み口**（`.cp-slot`。空の間は場所を取らない。第 6 段が `chromePanel.mountStatus(node)` で自分の部品を差し込む）、その下に映像（箱は窓の縦横比に合わせる。名前は「{エージェント名} の Chrome の窓の映像（見るだけ）」）、下の行に fps。撮影を断っている間は映像に薄い幕。窓が閉じたら映像を薄くして「Chrome の窓が閉じました」。表示の箱の大きさが 24px 以上変わったら、350 ms 置いて映像の大きさを取り直す。会話が替わる・閉じるとパネルは閉じて止める。
- **窓の大きさ**（ADR 0148 の残る項目 2）: 窓の外形の既定を**800×800 DIP**にした（`core/chrome/windows.mjs` の `WINDOW_DIP`。以前は 1100×720）。右パネルの映像の箱は 430〜540 px 前後（既定の幅は画面の 40%。広げれば増える）で、窓の幅に縮めて映すので、1100 では 0.4〜0.5 倍になり本文の 14px が 6px 前後で読めない。実機（確かめ専用の Chrome 154、`set viewport` で viewport を変えて 12 秒ずつ、箱 430×692 の Chromium で撮った）: 1101×578 は本文が読めない、900×621 は本文が辛うじて読める、801×701 は本文・11px の注意書きの語が読める、701×761 はさらに読める（フレームは 430×226・296・376・467）。**ページの形を変えない**ため `Emulation.setDeviceMetricsOverride` は使わず（窓の大きさだけを決める）、`Page.captureScreenshot` の周期取得も採らない（`startScreencast` で足りた）。800 を選んだのは、読みやすさと、サイトの多くが 768〜1024 px の境でレイアウトを替えるので 800 ならタブレットの形で済むこと。高さは画面に収まる範囲で縦に使う（800 の外形の viewport は約 800×660）。エージェントの `screenshot` も 800×660 になる。右パネルを「広げる」と 0.7 倍前後になる。
- **実機の結果**（確かめ専用の Chrome 154.0.8037.98・agent-browser 0.38.1・fake の会話・箱 430×692 の Chromium、2026-10-08）: フレームは **4.1〜4.3 fps**（自動の間隔 200 ms が上限。5 回の 12 秒の測定）、1 枚 **11〜31 KB**（viewport と内容による。1100 は 12 KB・900 は 20 KB・800×700 は 25 KB・700×760 は 31 KB。既定の 800×800 は 24 KB）、窓の四角の色が変わってから端末で見えるまで **20〜236 ms**（中央値 129〜220 ms。ack の間隔を含む。既定は 159 ms）。`tab new`・`tab tN` で映像が新しいタブに付いてきた。**focus emulation**（`document.visibilityState`・`hasFocus()` を eval で見た）: ターンの間に映像を見る → visible・true、ターンの間にパネルを閉じる → 残る（true）、**ターンが終わっても映像を見ていれば残る**（true。外すセッションを分けていた最初の実装は、ここで false になった）、ターンも映像も無い → hidden・false、映像を開き直す → visible・true、閉じる → hidden・false。**前面**: 前面を 50 ms ごとに記録し、映像を見ている間（パネルを開く・閉じる・`tab new`・`tab tN`・12 秒のフレーム）に前面を奪われたことは一度も無かった。奪ったのは最初の窓を開く約 123 ms だけで、第 4 段のとおり開く前の前面（自作の窓）へ返した。**残る確認**: 実機の画面は 2880×1800（倍率 約 2）の PC で、右パネルの映像の鮮明さ（倍率 2 のフレーム）は確かめていない（Chromium の倍率 1 の箱で確かめた）。リモートの端末（携帯）の実機の見え方も未確認（単体と偽の WS で、窓の有無・映像・見るだけは確かめた）。

## 仕組み

- ページは Electron の `WebContentsView`。本体の窓に重ね、右パネルの本文の枠（`.browser-viewport`）の位置と大きさに合わせる（`desktop/browser-panel.cjs`）。`<webview>` は使わない。
- 画面は枠の位置（CSS の px）を `ply:browser-layout` で送る。ResizeObserver・窓の大きさの変化・パネルの幅の変更（`layout()`）で測り直し、同じ値は送らない。main は画面の倍率を掛け、角の丸み（本文の `--r-m`）も合わせる。広げる・幅の変更・760px 以下の全面表示でも同じ経路で追う。
- タブごとに View を 1 つ持ち、窓に載せるのは今のタブだけ。ほかのタブは外したまま動き続ける。空のタブ（新しいタブ）は View を載せず、画面が「URL を入力して開きます」を出す。
- 保存領域は `persist:pleiad-browser` の 1 つで、権限・UA・ダウンロードの設定は起動で 1 回かける（`desktop/browser-panel.cjs` の `setupSession`）。ポップアップの窓と「このサイトのデータを消す」も同じ session を使う。Pleiad 本体（既定の session）とリモートの窓（`persist:remote-<id>`）から分けるので、ページのスクリプトや Cookie は Pleiad の認証に届かない。一度ログインすれば次回も残る。
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
- 画面が開いた PC のファイル・可視化の写しのタブだけ、先頭にファイルの操作の群（下の「PC のファイルのタブ」）。
- DevTools: そのタブの DevTools を別の窓で開く。
- 別の窓に出す: そのタブの View を独立した窓（道具の列の無い窓）へ移し、パネルの一覧から外す。窓を閉じるとページも閉じる。
- このサイトのデータを消す: 今のページのオリジンの保存領域と、そのページへ送られる Cookie を消して読み直す。

既定のブラウザーで開く は、http・https のページ（`shell.openExternal`）と、画面が明示して開いた `file:` の HTML（右パネルの「ブラウザーで開く」で開いた HTML ファイル・可視化の写し）で押せる。押せるかは main が決め、タブの状態の `external` で画面へ送る。`file:` は、そのタブが画面から開いた URL（`allowFile`）と同じファイルで拡張子が `.html`・`.htm` のときだけで、URL をパスに直し、実体を解決して HTML のファイルであることを確かめてから `shell.openPath` で開く（シェルは通さない）。連打はサーバーの `openPath` と同じく 10 秒に 5 回まで。ページの中で移った先の `file:`、HTML 以外、`about:blank` は押せない。

## PC のファイルのタブ（HTML ファイル・可視化の写し）

承認済み（2026-10-02、[ADR 0079](adr/0079-html-opens-in-inapp-browser.md)）。デスクトップ版のホストの画面で「リンクの開き先: 内蔵ブラウザー」のとき、HTML ファイルのリンク（会話・ツリー・ファイルのカード・Markdown の中）と、可視化のカードの「ブラウザーで開く」は、`file:` の URL を内蔵ブラウザーのタブで開く。入口は今あるファイルリンクのまま、行き先だけを変える。「画面が開いた `file:` のタブ」とは `allowFile`（画面が明示して `file:` を開いたタブ）で今のページがその URL のままのもの。ページの中で別のファイル・サイトへ移った後と、エージェントが開いたタブは含まない。

- **タブの使い回し**: 同じ実体のパス（可視化の写しは会話と記録の id）のタブがその会話にあれば、新しく作らず前に出して読み直す（`open` の `reuse: true`。照合の鍵は main の `fileKey`）。リンクを押すのは「今のファイルを見たい」ときなので、読み直すと入力・スクロールは初期に戻る。タブを一瞬だけ輪で知らせ（`--dur`、動きを減らす設定では出さない）、画面下の知らせ「読み直しました」を出す。押したリンクには、今のプレビューと同じ「表示中」を添える（ブラウザーの今のタブが別のものになるか、ブラウザーを離れたら外す）。別のファイルは別のタブ、別の会話の同じファイルも別のタブ。
- **既定のブラウザー**: Ctrl/⌘+クリックと中クリックは、HTML なら設定によらず既定のブラウザー（Web のリンクと同じ。`openPath` を `returnPath` なしで）。メニューは「ブラウザーで開く」が先頭で、設定の開き先に従う。「右パネルで開く」は HTML では「プレビューで開く」として残る。
- **印**: 開くとき画面が `source` を渡す。ファイルは作業ディレクトリからの相対パス（`label`。`openPath` の返事の `cwd` から）、写しは会話・記録の id・題・元のパス。main は形を確かめて（`cleanSource`）タブの状態の `file` / `snapshot` に載せる。
- **⋯ のファイルの操作**: 先頭に、原文を見る（右パネルをプレビューにして原文で開く。タブは残る）・エクスプローラーで表示（サーバーのある PC の画面だけ）・パスをコピー・相対パスをコピー・保存・会話で使う。写しは原文を見る・元のファイルを開く・エクスプローラーで表示・元のパスをコピー・相対パスをコピー・HTML を保存・会話で使う（元が分かるときだけ元のパスの操作、手元に会話の中身があるときだけ原文と保存）。中身は今のファイルの操作（`fileMenuItems`・`visualizationMenuItems`）と同じ処理を呼ぶ。道具の列は増やさない。会話の中身は、写しを開くとき画面が覚える（画面を読み直すと元のパスの操作だけが残る）。
- **アドレス欄**: PC のファイルは作業ディレクトリからの相対（外なら完全なパス）、写しはデータ置き場のパスを見せず「可視化 · 題」。触れると今どおり URL の全文を出して編集できる。
- **止める**: main は session の `webRequest.onBeforeRequest` を session ごとに 1 度だけ張り（`setupSession`）、要求の持ち主を `details.webContentsId` から引く（`byContents`。別の窓に出したタブも残す）。持ち主が「画面が開いた `file:` のタブ」のときだけ判定し、Web のページ・ページの中で移った先・ポップアップの窓・持ち主が分からない要求・ページ自身の移動（`mainFrame`）は止めない。
  - `file:` の資源: UNC・デバイスパスと Pleiad のデータ置き場（添付の `uploads` を除く。`AGENT_HOST_DATA`、既定 `~/.agent-host`）を、確認の ON/OFF によらず止める（[ADR 0050](adr/0050-local-file-access.md) と同じ範囲。実体を解決して比べ、Windows は大文字小文字を区別しない）。リンクでそこへ移ることも断る。同じフォルダーの相対の資源は読める。
  - http(s) の資源: 「外部の読み込みの前に確認」が ON のとき、「常に」許可した https の出どころと、そのタブだけの一時の許可（「読み込む」）だけ通す。**http は localhost も止める**。ws・wss は http・https と同じに見る。OFF のときは何も止めない（Web のページと同じ扱い。プレビューより緩い）。
  - 設定は core から main へ `browser-load-policy`（`{ confirm, origins }`）で届く（`core/agent-browser.mjs` の `loadPolicy`。設定の変更と起動時の問い合わせに答える）。main の `setLoadPolicy` が受け、もう通る出どころは止めた一覧から外す。
- **止めた件数の一行**: 確認が ON で止めたものがあるタブだけ、道具の列とページの間（ネイティブの View の上ではなく DOM。重なりの画像化が要らない）に「外部の読み込みを N 件止めています / 読み込む / 設定」を、プレビューと同じ語彙で出す（`.preview-blocked.browser-blocked`）。件数は http も数える。「読み込む」は止めた https の出どころを、このタブだけ一時的に通して読み直す（`allowOnce`）。件数が http だけのときは「読み込む」を出さない（設定が ON の間、http は通さない）。「設定」は許可したサイトへ移り、止めた https の出どころが「許可」付きで並ぶ（プレビューが止めたものと同じ一覧）。タブごとの一時の許可は、別のファイルを読むと捨て、同じファイルの読み直しでは残す。
- **可視化の写し**: 写しは meta の CSP が先に止めるので `webRequest` には届かない。止めたものは、内蔵ブラウザーで開く写しにだけ入れる橋（`web/visualize-document.mjs` の `CONSOLE_BRIDGE`。`securitypolicyviolation` を `console.debug('ply-preview-blocked <URL>')` で知らせる。親が無いので `postMessage` は使えない）が知らせ、main が `console-message` で数える。「読み込む」は main が `rewrite` を返し、画面が `openVisualization { returnPath: true, allow: [出どころ] }` で一時の許可付きの写しを書き直し（鍵に許可を含むので別のファイル）、同じ記録のタブを使い回して開き直す。設定の許可は変えない。既定のブラウザーで開く写し・書き出し・リモートの写しには橋を入れない。
- **既知の制約**: `file:` のページと可視化の写しは同じ保存領域（`persist:pleiad-browser`）の `localStorage` を共有し、互いの保存値を読める（確認が OFF なら外へ出せる）。今回は分けていない。「このサイトのデータを消す」が `file:` で何を消すかは確かめていない。

## 設定 › ブラウザー

見出しは「外部の読み込み」（確認のスイッチ）と、デスクトップ版のホストの画面だけ「リンクの開き先」「エージェントのサイト利用」。ページの説明は画面ごとに変わる: ホストの画面は「会話やプレビューのリンクを開く場所、外部の読み込みの確認を選びます。」、それ以外（リモート・ブラウザーで開いた画面）は「外部の読み込みの確認を選びます。リンクの開き先は PC（ホスト）の画面で選びます。」。スイッチの下に、確認が効く範囲（プレビュー・内蔵ブラウザーで開いた PC の HTML ファイル・可視化の写し。Web のページには効かない。すべての画面で共通の設定）を弱い字で書く（承認済み、2026-10-02）。

「リンクの開き先: 内蔵ブラウザー / 既定のブラウザー」。既定は内蔵ブラウザー。内蔵ブラウザーのときは HTML ファイルもここで開く（上の「PC のファイルのタブ」）。既定のブラウザーを選んだ人の HTML ファイルは、右パネルのプレビューのまま（⋯・Ctrl/⌘+クリック・「ブラウザーで開く」で既定のブラウザーへ出せる。外のブラウザーには確認の設定を効かせられない）。値はサーバーの `prefs.json` の `linkOpen`（`inapp` | `external`）で、`setPref` で保存し、`prefs` イベントでほかの画面にも届く。内蔵ブラウザーを使えない画面ではリンクの開き先の選択を出さない。リンクの開き先は `linkOpenTarget({ available, prefs })` で決め、使えない画面では設定によらず `external`（今どおり新しいタブか既定のブラウザー）。「エージェントのブラウザー」（PC の Chrome への接続のつなぐ・切る。ホストの画面だけ。上の「Chrome への接続」）の下に、「エージェントの操作」として同梱した `agent-browser` の版を示す。


### 確認

「外部の読み込みの前に確認」（`confirmExternalLoads`）と「エージェントがサイトを使う前に確認」（`confirmAgentSites`）は既定 OFF。後者とリンクの開き先は内蔵ブラウザーがある画面だけに出す。外部読み込みの確認はブラウザーで開いた画面・リモート・デスクトップでないホストでも使え、プレビュー・可視化に加えて内蔵ブラウザーの PC のファイルのタブにも効く（設定は `prefs.json` の 1 つで全画面共通）。

ON のとき「許可したサイト」を表示し、止めた出どころを「許可」付きで上に並べ、その下に外部の読み込みとエージェントの利用の一覧を分ける。各行は「常に / 毎回聞く」と「消す」。前者は `externalSitePermissions: [{origin, mode}]`、後者は `agentSitePermissions: [{agent, origin, mode}]`（`mode` は `always` / `ask`。プロフィールのあった頃の行に残る `profile` は見ない）に保存する。origin はスキーム・ホスト・ポートの完全一致で、外部資源は HTTPS のみ、サイトの利用は HTTP も含む。設定は `setPref` で保存し、接続中の画面にも反映する。

### サイトの利用の確認

ON のとき、エージェントが別の origin へ移る前に中継の `Page.navigate` と新しいタブの作成を保留する。ページ内の遷移・リダイレクト・新しい窓は Electron の `will-frame-navigate`・`will-redirect`・`setWindowOpenHandler` で止め、承認後に移動する。確認は `desktop/browser-navigation.cjs`、会話への受け渡しは `core/browser-confirm.mjs` が担当する。

会話の承認カードに「<エージェント名> が <サイト> を使おうとしています」と「一度だけ / このサイトは常に / 断る」を出す。ログイン中のアカウント名（「ログイン済み」）は出さない（Chrome の Cookie を読まないので、内蔵ブラウザーの道でも Cookie を読まずに同じ形にした。[ADR 0153](adr/0153-chrome-connection-waits-indefinitely-behind-os-layer.md)）。Chrome の中継での止め方は上の「サイトの利用の確認（Chrome）」。

「一度だけ」はその移動を通す。同じ origin 内の移動は聞き直さず、離れて戻れば再度聞く。「このサイトは常に」はエージェントの種類と origin の組で記録し、同じエージェントの別の会話にも効く。「断る」は中継の失敗として返す。承認待ちは通常の permission と同じ管理に入り、委譲元にもカードを出し、委譲の待機時計も承認待ちとして扱う。中断・タブの破棄・「止める」「引き継ぐ」では保留を取り消す。

人がアドレス欄・戻る/進む・再読み込みを操作したときや、ページへ入力したときはエージェントの操作を解除し、人の遷移には確認を挟まない。ターン終了でも解除する。送信・購入・削除などの操作ごとの確認は持たない（[ADR 0042](adr/0042-preview-loads-external-by-default.md)）。

## 画面から呼ぶ口

- `browserPanelAvailable()`: 使える画面か。
- `openInBrowserPanel(url, { newTab, reuse, source })`: 右パネルをブラウザーにして開く。url はアドレス欄と同じ規則で直し、開けなければ何もせず false。url を省くと空の新しいタブ。reuse は同じ実体のファイルのタブを使い回す指定、source は PC のファイル・写しの印。
- アプリの中の外部リンク（会話・作業のダイアログ・右パネルの Markdown の `a.md-link[target=_blank]`。文中の裸の URL・インラインコード全体の URL・取得の見出しを含む。形は docs/design-system.md「文中の URL」）とプレビュー（可視化・HTML ファイル）の中のリンクは、`web/link-open.mjs` の `openExternalLink` に集まり、開き先が内蔵ブラウザーなら新しいタブで開く（ダイアログの中のリンクはダイアログを閉じてから）。Ctrl/⌘+クリックと中クリック（`auxclick`）は既定のブラウザー（ADR 0041）。右クリック・長押し・Shift+F10 のメニュー（`web/link-menu.mjs`）は「内蔵ブラウザーで開く」（`openExternalLink` の `inapp`）と「既定のブラウザーで開く」（`external`）を選べる。既定のブラウザーへは殻の `openExternal`（http/https、userinfo 無し）で渡すので、本体の窓の `setWindowOpenHandler` が通さない http の localhost も開ける。使えない画面（ブラウザーで開いた Pleiad・リモートの窓）は今どおり新しいタブ。
- HTML ファイルのリンクと「ブラウザーで開く」（HTML ファイル・可視化の写し）も「リンクの開き先」に従う。内蔵ブラウザーが使えるホストの画面で設定が内蔵ブラウザーなら、検査済みの HTML ファイル、または会話に保存された可視化の写しを `file:` URL で内蔵ブラウザーのタブに開く（同じファイル・同じ記録のタブは使い回す。上の「PC のファイルのタブ」）。HTML ファイルでは同じフォルダーの相対資源を読める。可視化の写しには文書の meta の CSP が付く。使えない画面と既定のブラウザーを選んだ画面では従来の開き先を使う。アドレス欄は `file:` を「PC のファイル」と表示する。

## main の口

`desktop/preload.cjs` の `plyDesktop.browser`:
- `command(action, args)` → `ply:browser`（invoke）。`open`（`reuse`・`source` を受け、使い回したら `reused: <タブの id>` を返す）・`allowOnce`（止めた https の出どころをそのタブだけ通して読み直す。写しは `rewrite` を返す）・`newTab`・`select`・`close`・`back`・`forward`・`reload`・`stop`・`devtools`・`external`・`detach`・`clearSiteData`・`freeze`・`unfreeze`・`context`・`state`・`agentStop`・`agentTakeOver`。
- `layout({ visible, rect, radius })` → `ply:browser-layout`。
- `onState(listener)` ← `ply:browser-state`（タブの一覧・今のタブ・URL・題・読み込み中・戻れるか/進めるか・操作中のエージェント。PC のファイルのタブは `file` / `snapshot` と、確認が ON のとき `guard: { blocked, origins }`）。
- `onShortcut(listener)` ← `ply:browser-shortcut`（ページにフォーカスがあるときに押された開閉の近道）。

### 会話とタブ

タブは開いたときに画面で開いていた会話（`sessionId`）を覚える。画面は開く・会話を切り替えるたびに `context` で今の会話を知らせ、`window.open` で開いたタブは元のタブの会話を引き継ぐ。パネルの一覧（`ply:browser-state` と `state`）と今のタブは、今の会話のタブと、会話に属さないタブ（`sessionId` が null）だけ。会話を切り替えると（`context`）、その会話で最後に選んだタブ、なければ見えるタブの先頭、なければ今のタブなしにし、窓に載せる View も替える。別の会話のタブをエージェントが作る・前に出しても、今の画面のタブと窓は動かない。新しい会話の最初のターンは会話 ID が無いので、タブは `turn.key` の会話に付き、ID が決まったところで本物の ID へ付け替える（`rebind`。画面も同じ時点で `context` を本物の ID に替える）。main の `createBrowserPanel` は `tabsFor(sessionId)`（その会話のタブと webContents）と `contentsOf(tabId)` を返し、会話別の CDP 中継はここから webContents の debugger へつなぐ（[ADR 0043](adr/0043-agent-browser-via-per-session-cdp-relay.md)）。

## 検証

`tests/unit/inapp-browser.mjs`（右パネルの表・アドレス欄・リンクの開き先・使える画面・preload・偽の electron での main のタブと位置・session は 1 つ・仮のキーからの付け替え・タブの列にプロフィールの選択が無いこと）と `tests/unit/server-ux.mjs`（`linkOpen` の保存）。Chrome への接続は `tests/unit/chrome-connection.mjs`（状態機械・出し直し・前に出す頻度・unsupported。偽の Chrome `tests/lib/fake-chrome.mjs`・偽の OS の層 `fake-chrome-os.mjs`・偽の時計。本物の Chrome・本物の `LOCALAPPDATA` は読まない。`tests/lib/test-env.mjs` が `AGENT_HOST_CHROME_USER_DATA` を存在しない場所に向ける）・`tests/unit/chrome-os.mjs`（偽の Win32 の表と parentPort の往復）・`tests/unit/server-chrome.mjs`（サーバー越し）・`tests/unit/chrome-settings.mjs`（設定の画面の字とボタン）。Chrome の中継は `tests/unit/chrome-relay.mjs`（範囲・利用者のタブの URL がエージェントの ws とログに出ないこと・断る一覧・`sessionId` の持ち主・上りへブラウザー全体の `setAutoAttach` を送らないこと・Fetch の確認と `window.open` の後追い・止める・鍵・上りが無い／切れたとき・`AGENT_BROWSER_PIN_TAB` の受け渡し、**同梱の agent-browser の本物を偽の Chrome＋中継につないだ通し**（`open`→`snapshot`→`click`→`tab new`→`close`。`tests/lib/agent-browser-cli.mjs`））。偽の Chrome の中身（窓・タブ・flatten のセッション・Fetch・ページの小さな型）は `tests/lib/fake-chrome-browser.mjs`。`ply_browser` の骨組みは `tests/unit/browser-bridge.mjs`（鍵付きの口・ツールが無い間の断り方・サーバー越しにプロフィールの設定・コマンド・会話のメタ・中継の準備が無いこと・agy の束ね）。実機は fake バックエンドのデスクトップ版を別のデータ置き場と userData で起動し、http://example.com と手元の localhost のページで、タブ・戻る/進む・新しい窓・DevTools・既定のブラウザーで開く（呼ばれたことだけを記録）・メニューとの重なり・幅の変更・全面表示・別の窓を確かめた（2026-09-27）。`file:` の HTML（相対の CSS 付き）では、既定のブラウザーで開くが押せて実体のパスで `shell.openPath` が呼ばれること（呼ばれたことだけを記録）、ページのリンクで別の `file:` へ移った後と `.png` では押せないことを確かめた（2026-09-28）。

PC のファイルのタブ（2026-10-02）は `tests/unit/inapp-browser.mjs`（`webRequest` の判定・使い回し・一時の許可・写しの書き直し・データ置き場と UNC・移った先と Web のページに効かせないこと・止めた件数の一行・⋯ のファイルの操作・アドレス欄・設定の説明）と `tests/unit/file-actions.mjs`・`tests/unit/server-visualize.mjs`・`tests/unit/browser-confirm.mjs`・`tests/unit/agent-browser-relay.mjs`。実機は fake バックエンドのデスクトップ版を別のデータ置き場と userData で起動し、確認の ON/OFF・読み込む・設定・タブの使い回し・⋯・可視化のカード・`file:` の資源（データ置き場・uploads・UNC）・リモート 360 幅のプレビューと設定を確かめた。

リモートから見るは `tests/unit/remote-browser-view.mjs`（間引き・止める条件・ローカルの接続と見ていない接続とエージェント操作中の断り・入力の変換・座標の変換・シートの出し分け）。実機は fake バックエンドのデスクトップ版を一時のデータ置き場と userData で起動し、`X-Forwarded-For` を足すプロキシ越しに携帯の大きさの Chromium で開いて、シートの出し分け・画面が届く・タップでボタンが押せる・文字と Enter・戻る・ドラッグでスクロール・アドレス欄・画質の切り替え・閉じると止まる・ローカルの接続からは断ることを確かめた（2026-09-28）。
