# PleiadのHTML・画像共有調査（2026-09-12）

> 2026-09-14: 公開 `present` MCP は廃止し、[共通 Visualize](visualize.md) に移行した。以下は旧仕様の調査記録。

## 実装後の仕様

Claude・Codex共通の内蔵MCP `ply` が `present` を提供する。設定 → コンテキスト → MCP管理の「Pleiadの成果物提示」で切り替える。既定は有効で、全作業場所の次ターンから反映する。設定は再起動後も保持する。

`kind` はhtml/image/text/file、`path` と `content` はどちらか一方。画像のpathはdata URIへ変換し、直接contentもbase64のdata URIなら対応する。その他はUTF-8文字列。内容は8 MiB以内で、画像は変換後にも検査する。fileはテキストのコード表示であり、汎用バイナリ添付ではない。

共通処理は `core/present.mjs`、接続は `core/ply-mcp.mjs` の `/mcp/ply`（Stateless Streamable HTTP）。Claudeの `mcpServers.ply` とCodexの新規・再開時の `config['mcp_servers.ply']` に実行時注入する。[Codex公式MCP設定](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)。実験的dynamicToolsは使用しない。

認証は会話ごとに発行し、実行中のみ有効。提示先はその会話に固定する。再開時は接続を引き継ぎ、キャッシュされた呼出も無効設定なら拒否する。接続URL・認証値はネイティブ設定ファイルに書かない。外部MCPの編集とは独立したPleiad内蔵の設定で、予約名plyの接続を実行時に使用する。

ファイルは会話の現在の作業場所、アップロード領域、Codex生成画像領域の実パスに限定する。提示は履歴保存後に画面へ流して成功を返す。旧host.presentの履歴描画は維持する。HTMLの静的sandbox、Markdownの画像・ファイルリンク、Visualize参照を変換しない点は下記調査時の仕様を維持する。

通常テストで認証・Origin・入力上限・許可ルート・並行会話・保存失敗・設定保存・再開を検証。実接続の `npm run test:e2e -- present` でClaudeとCodexのHTML/画像、新規と再開、保存後の再読み込みを検証する。

## 以下は実装前の調査記録

以下の「未接続」「未実装」は調査時点の状態。現在は上記の共通MCPで解消している。

対象はこのリポジトリの実装。Claude/Codexのモデル能力ではなく、Pleiadのバックエンド接続と表示経路に差がある。

## 現在使える経路

| 方法 | Claude | Codex | Pleiadでの表示 |
|---|---|---|---|
| `mcp__host__present` / `kind: html` | 利用可 | 未接続 | 会話内のHTMLカード。スクリプトは実行しない |
| `mcp__host__present` / `kind: image` | 利用可 | 未接続 | 会話内の画像カード。クリックで拡大 |
| Markdown画像 `![説明](D:/workspace/image.png)` | 利用可 | 利用可 | 認証付きローカル画像のインライン表示・拡大 |
| Markdownファイルリンク `[HTML](D:/workspace/example.html)` | 利用可 | 利用可 | HTMLはダウンロード。インライン実行しない |
| 画像生成ツールの構造化結果 | 結果形式次第 | 対応経路あり | 対応した画像結果をツール詳細の外に表示 |
| Visualizeの専用参照 | Pleiad側に対応処理なし | Pleiad側に対応処理なし | 参照を貼ってもHTMLカードにならない |

根拠: `core/backends/claude.mjs` の `buildToolServer` と `mcpServers`、`core/backends/codex.mjs` の `capabilities.hostTools: false`、`web/render.mjs` の `renderPresent` / Markdown処理、`core/local-files.mjs`。

Claudeの呼び出し例（このツールが公開されているセッション内で使う）:

```json
{"kind":"html","path":"D:/work/my-app/temporary/example.html","caption":"比較案"}
```

画像なら `kind: image` と実ファイルへの `path`。HTML・テキストは `content` で直接渡すこともできる。画像は `path` 経路がdata URIへの変換を行うため確実。`image` に任意の `content` を渡しても画像用データとしては描画されない。

## 制約と保存

- `present` はイベントを送るだけで終わらず、`core/server.mjs` → `core/history.mjs` で `~/.agent-host/presents/<sessionId>.jsonl` に保存する。再読み込みでも表示できる。
- HTMLは `iframe srcdoc`、空の `sandbox` 属性。CSPは `default-src 'none'; img-src data:; style-src 'unsafe-inline'`。自己完結したHTML/CSS・data URI画像向け。JavaScript、外部CSS・CDN、相対パス画像、親アプリへのアクセスを前提にしたHTMLはそのまま動かない。高さは小240/中440/大760pxを選べる。
- Claudeの `present(path)` は元ファイル8MiB上限。履歴にも独立した上限があり、大きいcontent/data URIは省略される（base64化でサイズが増える）。汎用バイナリの `kind: file` はダウンロード添付ではなくUTF-8のコード表示である。
- Markdownのローカルパスは `/local-file` 経路に変換する。認証必須で、登録済み作業ディレクトリ・添付置き場・Codex画像置き場など許可ルート内のみ。realpathで検証し、ファイル32MiB上限。PNG/JPEG/GIF/WebP/AVIF/ICOは画像、それ以外（HTML・SVGを含む）はダウンロード扱い。
- 相対パスや `sandbox:` のリンクはこのローカルパス経路と同じとは限らない。Pleiadで確実に渡すには許可ルート内の絶対パスを使う。公開URLを作る機能ではなく、Pleiadに接続したユーザーへ共有する機能。

## 今回のHTMLが表示されなかった理由

前の会話はCodexで実行され、`present` は公開されていなかった。Visualizeスキルのファイル参照はPleiadの `present` イベントには変換されない。したがって参照の貼り直しだけでは解決しない。

さらに既存の `temporary/visualizations/blue-unread-options.html` は、サイズ別サンプル生成にJavaScript、調整にホスト提供の `Tweak` を使う。仮に現在の `present` に渡しても、その部分は動かない。静的HTML/CSSに展開して渡すか、対応する別の表示環境が必要。

## 改善案（本調査では未実装）

推奨は、Pleiad共通の `present` 処理を作り、ClaudeとCodexの両方から同じカード・保存経路を呼べるようにすること。Claude内のファイル読み込み・検証・イベント発行を共通化し、Codex側にツール接続を加える。ローカルファイル配信との許可ルート・サイズ制限も揃える。

Codexへの接続は、共通MCPサーバーを接続する案、App Serverのdynamic toolをPleiadが処理する案がある。[OpenAI公式 App Server仕様](https://learn.chatgpt.com/docs/app-server#dynamic-tool-calls-experimental)では `dynamicTools` と `item/tool/call` の往復を提供しているが実験的API。採用時には導入済みCLIのスキーマ、既存スレッド再開、新規スレッド、切断時の挙動を実接続で検証する必要がある。現在のPleiadはこの提示ツールを登録・処理していない。

まず静的HTMLと画像の共通提示を揃える。動くHTMLが必要なら、それとは別に隔離した表示環境・許可する通信・親アプリとのAPIを設計する。Visualizeの参照文字列を直接実行するだけでは、ホスト側のランタイムが揃わない。

## 調査の確認範囲

ソースコード、既存の画像表示調査、公式App Server仕様を照合。通常テスト510件が通過。隔離したfakeサーバーをPlaywright CLIで開き、実際の `renderPresent` でHTML/CSS表示・スクリプト禁止・画像読み込みを確認した。MarkdownのローカルHTMLリンクがHTTP 200のダウンロード応答になることも確認した。実際のLLMへ新しい提示を依頼するテストや、CodexへのMCPブリッジ追加は本調査の対象外。
