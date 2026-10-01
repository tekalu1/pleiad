# 0070 Windows の computer use を Pleiad の MCP（ply_computer）として渡す

- 状態: 提案

## 状況

Claude・Codex・Antigravity に Windows の PC のアプリを操作させたい。各エージェントにある computer use は、どれも Pleiad の会話では使えないか、使えても形がそろわない。

- Claude の CLI は `computer-use` という内蔵の MCP を持つが、Windows では「macOS only」で落ちる。CLI はこの名前を予約していて、同じ名前で渡すと内蔵の扱い（描画・ロック・指示）に巻き込まれる。
- Codex の同梱の computer use（`cua_repl` / `node_repl`）は ChatGPT のデスクトップアプリのヘルパーに依存し、承認を elicitation で求める。Pleiad は elicitation を断っているので、Pleiad の会話では動かない。
- Antigravity（agy）には computer use が無い。

そのまま使える OSS も無かった。承認・中止・表示はどれもサーバーの中で完結していて、Pleiad の承認カード・会話の中断・リモートからの承認につながらない。Claude Desktop のツールの形を持つのは Python の実装だけで、Python を同梱すると重い。

## 決定

- Pleiad が MCP サーバー `ply_computer` を持ち、会話ごとに 3 つのエージェントへ渡す（`ply_agents` と同じ、Bearer 付きの HTTP。agy は stdio の中継を挟む）。名前は Claude の `computer-use` と Codex の `cua_repl` / `node_repl` を避け、`RESERVED` に足して外部の MCP には付けさせない。
- ツールの形は Claude Desktop（Windows）と API の `computer_toolset_20260801` のメンバー名・引数にそろえる。座標は「最後に撮った全画面のスクリーンショットの画素」で受け、サーバーが物理座標に戻す。全部のツールに `title`（会話の言語の短い説明）を置く。
- MCP の面・方針・ロック・保存は core（utilityProcess）、撮影・入力・オーバーレイは Electron の main に置き、parentPort でつなぐ。Win32 は koffi（MIT、N-API のビルド済み）で直接呼び、画像の縮小と符号化は Electron の `nativeImage` を使う。Python・sharp・nut.js は同梱しない。
- 第 1 段階はデスクトップ版の Windows だけ。Electron が無い起動（`npm start`）と Windows 以外では MCP も指示も渡さない。
- 委譲の子の会話にも渡す（[ADR 0071](0071-computer-use-approval-and-safety.md)）。
- 契約（メッセージ・ツールのスキーマ・イベント・設定の形）は `docs/computer-use.md` の「仕組み」に書く。

## 理由

承認・止める・表示を Pleiad 側に置かないと、3 つのエージェントで同じ体験にできない。どの OSS をフォークしても、その部分はほぼ書き直しになる。必要な Win32 の呼び出しは少なく（SendInput・BitBlt・WindowFromPoint・QueryFullProcessImageNameW など）、検証済みの MIT の実装（sshh12/windows-computer-use-mcp・Jason26214/omni-computer-use）から移植できる。koffi と Electron の標準 API なら追加は数 MB で、ビルド工程も増えない。

ツールの形を Claude Desktop にそろえるのは、Claude がいちばん慣れている形だから。座標の計算をサーバーが持てば、縮小の倍率をモデルに意識させずに済む。

## 影響

- 依存に koffi が増える（版を固定し、`.node` を asar の外に出す）。移植した部分の出典を NOTICE に書く。
- エージェントの指示に computer use の指示文が足され、右パネルの「指示の量」に出る。
- 各エージェントの細部（Codex の同梱を切る書き方、agy に画像が渡るか、長い待ちの扱い）は実測で決め、`docs/computer-use.md`「実測しだいの箇所」の口の値だけを変える。
