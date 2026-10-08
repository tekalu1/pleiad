# 0173 computer use を macOS でも動かす（Swift のヘルパー）

- 状態: 採用（Mac 実機での動作は未確認）
- 関連: [0070](0070-computer-use-via-ply-computer-mcp.md)（computer use の全体）、[0071](0071-computer-use-approval-and-safety.md)（禁止・高リスクのアプリ）、[0073](0073-computer-use-ui.md)（オーバーレイと Esc）

## 状況

- computer use の main 側（`desktop/computer/*.cjs`）は Windows だけで動く。撮影は BitBlt、入力は SendInput、アプリの特定は Win32 の窓とプロセスで、koffi から呼ぶ（`win32.cjs`）。Windows 以外では `computer-ready { supported: false, reason: 'platform' }` を返す。
- Pleiad は macOS 版（dmg・zip、x64 と arm64）も配っている。リリースのワークフローは Developer ID で署名し、公証する。
- macOS で同じことをするには、撮影（ScreenCaptureKit）・入力（CGEvent）・アプリ（NSWorkspace・Accessibility）の API が要る。どれも Objective-C / Swift の API で、koffi から素直には呼べない。
- macOS は、画面の収録（Screen Recording）と、ほかのアプリの操作（Accessibility）に、利用者の許可（TCC）を求める。許可はアプリのコード署名に結び付く。
- 開発機は Windows で、Mac の実機は無い。確かめられるのは Windows での単体試験と、共通部分の Swift ビルドまで。macos-15 の CI を追加するが、この変更ではまだ実行していない。

## 決定

### 1. 小さな Swift のヘルパーに任せる

- `desktop/computer/mac/` に Swift Package を置き、実行ファイル `pleiad-computer-helper` を作る。x64 と arm64 のユニバーサルバイナリにする（`swift build -c release --arch arm64 --arch x86_64`）。
- main（Electron）はヘルパーを子プロセスとして 1 つだけ起こし、標準入出力の JSON Lines で話す（`desktop/computer/mac-helper.cjs`）。
  - 頼み: `{"id":1,"op":"capture","args":{...}}`
  - 答え: `{"id":1,"ok":true,"data":{...}}` か `{"id":1,"ok":false,"error":{"code":"permission","message":"...","permission":"screen"}}`
  - ヘルパーは起きたら最初に `{"event":"hello","protocol":1,"os":"14.5.0","arch":"arm64"}` を 1 行出す。画像などのバイト列は base64。
  - ヘルパーが落ちたら、待っていた頼みは `failed` で返し、次の頼みで起こし直す。
- Package は 2 つの target に分ける。
  - `ComputerProtocol`: JSON Lines の読み書き・座標の計算・キーコードの表。Foundation だけで書き、Windows の Swift 6.4 でも `swift build` と `swift test` が通る。
  - `pleiad-computer-helper`: macOS の API を呼ぶ本体。`#if canImport(AppKit) && canImport(ScreenCaptureKit)` で囲み、ほかの OS では「unsupported」を返して終わるだけにする。
- `desktop/computer/mac.cjs` は、`win32.cjs` と同じ op の面（displays・screenshot・appAt・foreground・findApp・input・cursor・launch・releaseAll）を darwin で満たす。`service.cjs` は platform で分け、Windows の API と返すデータは変えない。
- koffi で Objective-C を直に呼ぶ案は採らない。ブロックと async の API（ScreenCaptureKit）を呼べず、型の誤りが main を落とす。Electron の `desktopCapturer` で撮る案も採らない。毎回すべての画面とソースを列挙するので遅く、入力とアプリの特定にはどのみちネイティブの部品が要る。

### 2. 撮影は ScreenCaptureKit。macOS 14 以上を対象にする

- `SCScreenshotManager.captureImage(contentFilter:configuration:)` でディスプレイを撮る。`SCDisplay.displayID` と Electron の display.id を対応させ、`sourceRect` はディスプレイ内の point、出力の幅・高さは画素で渡す。カーソルは写さない。
- macOS 13 以前は `loadMac` が Darwin の版を確認して `reason: 'platform'` を返す。ヘルパーを起動しない。Swift Package も最低 macOS 14 とする。古い撮影 API へのフォールバックは、別の許可・撮影経路の実機検証が必要になるため用意しない。
- Intel Mac でも macOS 14 以上なら対象。CPU やメモリ容量だけでは対応可否を決めない。
- 縮小・JPEG 符号化・`wait_until` 用の灰色画素はヘルパーで作る。生の Retina 画像を JSON に載せる通信量を避ける。
- オーバーレイは Pleiad の pid で層が 1000 以上の窓を `SCContentFilter` で除外する。ScreenCaptureKit では `setContentProtection` だけに頼らない。Pleiad 本体は撮影に含める。

### 3. 入力は CGEvent

- `CGEvent` を作り、`.cghidEventTap` に送る。マウスの移動は、ボタンを押している間は `leftMouseDragged` などにする（macOS は押したままの移動を drag として受け取る）。ダブル・トリプルクリックは `mouseEventClickState` に 2・3 を入れる。スクロールは行単位（`scrollWheelEvent2`）。
- 修飾キーは、キーの押し下げに加えて、以後のすべての事象の `flags` に載せる（macOS のアプリはキーの状態より事象の flags を見る）。
- 文字は `keyboardSetUnicodeString` で打つ。日本語入力などの入力ソースが選ばれていると変換に取り込まれるので、打つ間だけ ASCII の入力ソースに切り替えて戻す（Windows の IME を閉じるのと同じ考え）。
- キーの名前（xdotool の形）は JS（`desktop/computer/mac-keymap.cjs`）で仮想キーコード（`kVK_*`）にする。1 文字のキーはヘルパーが今のキー配列（`UCKeyTranslate`）で引き、引けなければ US 配列の表に倒す。
- 押したままのキーとボタンは JS とヘルパーの両方で覚え、`releaseAll` で離す。

### 4. ⌘ キーを使えるようにし、OS の機能を呼ぶ組み合わせは拒む

- Windows では Windows キーを拒む（`windows_key`）。macOS では ⌘ が普通の操作（コピー・保存）に要るので、`cmd`・`command`・`super`・`meta` を ⌘ として通す。core の Windows キーの検査は Windows のときだけにする。
- 代わりに、Windows キーと「ファイル名を指定して実行」と同じ働きをする組み合わせを拒む。新しい code `system_key`。
  - ⌘Space・⌥⌘Space（Spotlight・Finder の検索。アプリやコマンドを起こせる）
  - ⌥⌘Esc（強制終了）、⌃⌘Q（画面のロック）、⇧⌘Q（ログアウト）（電源キーの名前自体も受け付けない）
- 指示文は macOS 用を別に持つ（`computer.instructionsMac`）。「Windows の画面」を「Mac の画面」に、Windows キーの行を Spotlight の行にする。

### 5. アプリの特定は NSWorkspace と Accessibility

- AppInfo は `kind: 'bundle'`、`id: 'bundle:<バンドル ID>'`、`bundleId`、`path`（`.app` のパス）、`name`（表示名）、`pid`。バンドルの無いプロセスは `exe:<実行ファイルのパス>` にする。`elevated` は常に false（macOS に UIPI に当たる仕組みは無い）。
- 点の下のアプリ（appAt・入力の前の判定）: `AXUIElementCopyElementAtPosition` で要素を引き、その pid にする。引けなければ `CGWindowListCopyWindowInfo` を前から見て、点を含む窓の持ち主にする（オーバーレイは外す）。
- 前面のアプリ: `NSWorkspace.shared.frontmostApplication`。ヘルパーはメインの run loop を回し、標準入力は別のスレッドで読む（回さないと値が古いまま残る）。
- 名前での検索（findApp）: 動いている通常のアプリと、`/Applications`・`/Applications/Utilities`・`/System/Applications`・`/System/Applications/Utilities`・`~/Applications` の `.app` から探す。点数の付け方は Windows と同じ形にする。
- 起動（launch）: `NSWorkspace.openApplication(at:configuration:)`。動いていれば前に出す。
- Pleiad 自身（self）: 同じ pid、Pleiad の `.app` の中の実行ファイル、バンドル ID が Pleiad のもの（`jp.ply.desktop` とその Helper）。
- 禁止・高リスクの一覧（core/computer-use/apps.mjs）に、バンドル ID の一覧を足す。
  - 禁止: ターミナル（Terminal・iTerm2・Warp・Alacritty・kitty・WezTerm・Ghostty）、パスワード管理（1Password・Bitwarden・KeePassXC・キーチェーンアクセス・パスワード）、セキュリティの画面（SecurityAgent・loginwindow）、スクリプトの道具（スクリプトエディタ・Automator・ショートカット）、エージェント自身（Pleiad・Claude・ChatGPT・Codex・Antigravity）
  - 高リスク: Finder、システム設定、アクティビティモニタ、VS Code・Cursor・Windsurf・Zed・Xcode・JetBrains の IDE
- 理由: ターミナルと同じことができる道具は禁止にそろえる。

### 6. 許可（TCC）は、使うときに確かめて設定のペインへ案内する

- 撮影の前に `CGPreflightScreenCaptureAccess()`、入力・点の下のアプリの前に `AXIsProcessTrusted()` で確かめる。無ければ新しい code `permission`（`permission: 'screen' | 'accessibility'`）で返す。
- 初めて `permission` を返すとき、main はヘルパーに `request` を頼む。`CGRequestScreenCaptureAccess()` と `AXIsProcessTrustedWithOptions(prompt: true)` は、システム設定の一覧に Pleiad を載せ、初回だけ OS の確認を出す。続けて、システム設定の該当のペインを開く（`x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture` / `?Privacy_Accessibility`）。開くのは、同じ許可について 60 秒に 1 回まで。
- エージェントには「Pleiad に画面収録（またはアクセシビリティ）の許可が要る。システム設定で許可してもらうよう利用者に伝える」という文を返す（`agent:computer.errors.permission`）。
- 画面収録の許可は、許可した後にアプリを起こし直すまで効かないことがある。`permission` を返した後は、次の頼みの前にヘルパーを起こし直す。それでも効かなければ Pleiad の再起動を案内する。
- `hostCapabilities.computerUse` は、許可が無いだけなら `supported: true` のままにする。許可は使うときに求める（設定の画面のスイッチは止めない）。

### 7. 許可は署名に結び付く。ヘルパーはアプリの中に置き、同じ Team ID で署名する

- TCC は「責任のあるプロセス」の署名で許可を覚える。アプリの中に置いたヘルパーをアプリが起こすと、Pleiad を責任のあるプロセスとして扱わせる構成にする。実際の TCC の表示名・許可の帰属は署名済みの実機で確かめる。
- ヘルパーは `Pleiad.app/Contents/Helpers/pleiad-computer-helper` に置く（electron-builder の `mac.extraFiles`）。Apple は実行ファイルを `Contents/Resources` に置かないよう求めている（署名の検証で不具合になる）。
- electron-builder はアプリの中の Mach-O をすべて同じ Developer ID（同じ Team ID）・Hardened Runtime で署名する。ヘルパーは `mac.binaries` にも指定して署名対象にする。computer use 固有の entitlement は足さない。画面収録・アクセシビリティは entitlement ではなく TCC で守られている（サンドボックスの無いアプリの場合）。`build/entitlements.mac.plist` には足さない理由だけを書く。
- Developer ID で署名した版は、同じ署名要件を保って更新すれば、許可を引き継げる構成にできる。Team ID と識別子を変えない。許可の維持は実機で確認する。
- 署名していない版・ad-hoc 署名の版（手元の `npm run desktop:dist`、`CSC_IDENTITY_AUTO_DISCOVERY=false` の CI の成果物）は、ビルドのたびに署名の中身（cdhash）が変わり、許可が外れることがある。そのときはシステム設定で Pleiad を一度消して入れ直すか、`tccutil reset ScreenCapture jp.ply.desktop` と `tccutil reset Accessibility jp.ply.desktop` で消してから許可し直す。
- ソースから動かす（`npm run desktop`）ときは、ヘルパーを `desktop/computer/mac/dist/`（無ければ Swift のビルド出力）から使う。許可は Electron.app や起動元のターミナルに付く場合があり、実機で確認する。

### 8. 座標は CoreGraphics のグローバル座標（point）

- 契約の「物理座標」は、darwin では CoreGraphics のグローバル座標（主ディスプレイの左上が原点、y は下向き、単位は point）にする。CGEvent も `CGDisplayBounds` も Electron の `screen`（mac では DIP = point）も、この座標で一致する。
- 画素（point × 倍率）にそろえる案は採らない。倍率の違うディスプレイを並べると、画素の座標が重なったり隙間ができたりして、1 つの平面にならない。
- ディスプレイの一覧は Electron の `screen.getAllDisplays()` から作る（同期で取れ、表示の変化の事象も同じ）。`bounds` は point、`scale` は Retina の倍率（`backingScaleFactor`、2 など）、`id` は CGDirectDisplayID の文字列。番号の付け方は Windows と同じ（主ディスプレイが 1、残りは左から右・上から下）。
- 撮影の倍率: 実の画素（point × scale）を上限（1,200,000 画素・長辺 1568）まで縮めた大きさで撮る。結果の `scale` は「画像の画素 / point」なので、Retina の zoom では 1 より大きくなりうる。core の座標の戻し（`toPhysical`）はそのまま使える。
- オーバーレイ（computer-overlay.cjs）は、darwin では物理座標をそのまま DIP として扱う。`screen.dipToScreenRect` と `screen.screenToDipPoint` は Windows にしか無い。

### 9. 複数のディスプレイ

- ディスプレイごとに撮る（`SCDisplay` を displayID で選ぶ）。座標はグローバルの point なので、負の座標（主ディスプレイの左や上）もそのまま通る。
- 入力の座標は、どれかのディスプレイの中でなければ拒む（`outside`。Windows と同じ）。
- 表示の追加・取り外し・並びの変更は、Electron の `screen` の事象で `computer-displays-changed` を送る（Windows と同じ）。

### 10. Esc とオーバーレイ

- Esc は Windows と同じく、オーバーレイが操作中の間だけ `globalShortcut` で握る。登録の成否は Electron の返り値で扱う。⌘ を押したままの間に Esc が合わなくならないよう、`Command+Escape` も握る（⌥⌘Esc は強制終了なので握らない）。
- エージェントが Esc を送るときは、Windows と同じく握るのを外してから送る（`escape.suspend`）。
- オーバーレイの窓は、darwin では `setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })` も掛け、フルスクリーンのアプリの上にも出す。
- 画面のロック（`CGSessionCopyCurrentDictionary` の `CGSSessionScreenIsLocked`）とログイン画面は `locked` にする。安全な入力（パスワードの欄・ターミナルの「セキュアキーボード入力」。`IsSecureEventInputEnabled()`）の間は、キーの入力を新しい code `secure_input` で拒む（CGEvent のキーが届かないため）。

### 11. 試験と CI

- Windows で回す単体試験（`tests/unit/computer-mac.mjs`）: JSON Lines の契約（ヘルパーの入出力を模したストリーム）、座標の変換、エラーの型、platform の分岐、キーの表、アプリの特定と self の判定。
- `swift build`（と `swift test`）は Windows でも `ComputerProtocol` について通す。
- `.github/workflows/computer-mac-helper.yml` で、macos-15 でユニバーサルバイナリをビルドし、`lipo -archs` で x86_64 と arm64 を確かめる（paths で絞る）。
- `electron-builder.yml` の `beforePack`（`scripts/build-computer-mac.cjs`）でビルドする。手元・CI・リリースのすべての macOS パッケージに適用し、Windows では Swift を呼ばない。

## 理由

- ヘルパーを分けると、macOS の API の呼び出しは Swift の型の検査を通り、落ちても main は落ちない。標準入出力の JSON Lines は、Windows の単体試験で偽のヘルパーに置き換えられる。
- 座標を point にすれば、CGEvent・CoreGraphics・Electron の screen が同じ値で話し、変換が 1 か所（撮影の倍率）で済む。core の座標の扱いは変えずに済む。
- 許可を使うときに求めるのは、computer use を使わない人に許可の確認を出さないため。設定のペインを開くのは、どこで許可するかを人が探さずに済むため。

## 影響

- `desktop/computer/` に `mac.cjs`・`mac-helper.cjs`・`mac-keymap.cjs`・`mac/`（Swift Package）が増える。`service.cjs` は platform の部品（backend）を受け取る形になる。Windows の API と返すデータは変えない。
- エラーの code に `permission`・`secure_input`・`system_key` が増える（core の失敗の理由と、agent.json の文も）。
- アプリの id に `bundle:` が増える。設定の画面のアプリの一覧（`web/computer-prefs.mjs`・`web/computer-settings.mjs`・`web/computer-use.mjs`）は `bundle:` を受ける。
- `core/computer-use-capability.mjs` は darwin を受ける。
- macOS 版のパッケージは、ヘルパーのビルドに Xcode（Swift 6）が要る。ヘルパーが無いパッケージでは `reason: 'native'` で使えない。
- 実機の Mac では確かめていない。確かめていないことは `docs/computer-use.md` の「macOS」に挙げる。

## 参照

- [SCScreenshotManager](https://developer.apple.com/documentation/screencapturekit/scscreenshotmanager)
- [Apple: Code Signing In Depth](https://developer.apple.com/library/archive/technotes/tn2206/)（入れ子のヘルパーの配置・署名）
- [electron-builder v26: macOS](https://www.electron.build/v26/docs/mac/)（extraFiles・binaries・entitlements）
