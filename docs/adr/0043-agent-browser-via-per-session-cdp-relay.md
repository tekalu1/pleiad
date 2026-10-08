# 0043 エージェントのブラウザー操作は同梱の agent-browser と会話ごとの中継で行う

- 状態: 承認（2026-09-27）。エージェントの操作の接続先は置換（0148）。内蔵ブラウザーの CDP の中継は 0148 の第 7 段で消した（2026-10-08）

## 状況

内蔵ブラウザー（ADR 0041）をエージェントにも操作させたい（design.md §2.2、人間にできることを AI にもできるようにする）。Claude Code・Codex・Antigravity のどれでも同じに動き、Pleiad 本体の画面（トークンを持つ）には届かない形が要る。ユーザーは実績のある道具を使うよう求め、agent-browser と browser-use を候補に挙げた（2026-09-27）。

## 決定

- 道具は **agent-browser**（vercel-labs、Apache-2.0）を Pleiad に同梱する。各 OS の本体（12〜14 MB）だけを入れる。エージェントは shell から呼ぶ。
- Electron のデバッグポート（`--remote-debugging-port`）は開けない。Pleiad が会話ごとに **CDP の中継** を loopback に立て、`webContents.debugger` でその会話の内蔵ブラウザーのタブだけを「ブラウザー」として見せる。接続先は会話ごとの短い寿命の鍵付き URL。タブの作成・他のターゲットへの接続・ブラウザーを閉じる操作など、ブラウザー全体に効くコマンドは中継で断る。
- 接続先は会話専用の `agent-browser.json`（`cdp` に中継の URL）を `AGENT_BROWSER_CONFIG` で、会話 ID を `AGENT_BROWSER_SESSION` で渡し、使い方は Pleiad が入れる指示で伝える。
- 中継を通るコマンドから「操作中」を出す。「止める」「引き継ぐ」は中継の接続を切る。「エージェントがサイトを使う前に確認」（ADR 0042）が ON のときは、中継と Electron のナビゲーションのイベントでサイトの切り替わりを止めて承認を求める。

## 理由

- 試作（2026-09-27、Electron 44.3）で、デバッグポートをそのまま開けると、保存領域を分けても本体役の画面まで読み書きできた。中継でブラウザー役だけを見せると、agent-browser 0.36 の `tab`・`snapshot -i`・`fill`・`click` と Playwright の `connectOverCDP` が通り、本体役は見えず、`tab new` は断れた。
- agent-browser はアクセシビリティのスナップショットに `@e1` の ref を付けて返し、エージェント自身の LLM で操作する道具型。shell から呼ぶので、バックエンドごとの MCP の登録の違いに左右されない。
- 中継は標準の CDP なので、Playwright や Chrome DevTools MCP も同じ接続先で使える。道具を後から替えられる。
- 採らなかった案: browser-use（主な `Agent` は内部で別の LLM を呼び、Pleiad のエージェントの道具にすると LLM が二重になる。Python 3.11 の実行環境も要る）。Pleiad が自前の MCP ツールを作る（ref・待機・iframe の扱いを作り直すことになる）。内蔵ブラウザーを別プロセスの Chromium にする（隔離は強いが、パネルに映すために画面の転送が要る）。

## 影響

- 中継は CDP の Target・Browser ドメインの一部を自前で実装する。複数タブ・iframe（OOPIF）・ポップアップ・再接続・ページ遷移後の追従は実装時に確かめる。
- 同じ `persist:pleiad-browser` を使う会話は、タブが分かれてもログイン状態を共有する。
- 同梱する版は multi-backend.md の版の表と同じく記録する（ADR 0037）。

## 追記（2026-10-06）: 接続先は Chrome の専用の窓

[ADR 0148](0148-agent-browser-in-chrome.md) で、エージェントの接続先は内蔵ブラウザー（`webContents.debugger`）から PC の Chrome の会話ごとの専用の窓になる。agent-browser・会話ごとの鍵付きの loopback の中継・`agent-browser.json`・会話の束縛は保つが、中継は Target 層を偽装する形から「パススルー + 絞り込み」に作り直す。「引き継ぐ」は接続を切るのではなく、中継の一時停止の状態にして、エージェントに伝える。「止める」は今のとおり。サイトの利用の確認のイベントは [ADR 0042](0042-preview-loads-external-by-default.md) の追記のとおり。
