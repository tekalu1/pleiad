# 会話内の可視化

Pleiad の可視化は、Claude・Codex 共通の Visualize 参照で表示する。公開 MCP ツール `present` と `/mcp/ply`、その有効化設定は廃止した。外部 MCP の設定は変更しない。旧 `plyPresentEnabled` の値は使用しない。

## 作り方

会話の現在の作業ディレクトリ内に UTF-8 の HTML を作り、回答の独立した行に参照を置く。

```text
visualize{"path":"D:/workspace/output/comparison.html","title":"比較"}
```

Codex の専用形式も同じ経路で受け取る。

```text
visualize{"path":"D:/workspace/output/comparison.html","title":"比較","mode":"wide"}
```

上のコードブロックは説明用。実際の回答ではコードフェンス・インラインコード・リストに入れず出力する。コード例とユーザー発言からファイルを読み込むことはない。Claude の実接続では専用 Unicode 記号が落ちる場合があるため ASCII 形式を使えるようにした。

共通スキルは `skills/visualize/SKILL.md`（英語の会話）と `skills/visualize/SKILL.ja.md`（日本語の会話。参照の形式は同じ。docs/design.md「多言語対応」）。ターン開始時に、会話の言語のものを Claude の system prompt append と Codex の developerInstructions に注入する。ネイティブのスキル・指示は既存のコンテキスト設定に従い、可視化の表示契約を追加する。ユーザーのスキルディレクトリを書き換えたり、OpenAI プラグインのコードをコピーしたりしない。

## 表示・保存

- 1ファイル 1 MiB、1ターン32参照まで。絶対パスと実パスを検査し、会話の作業ディレクトリ外・非 HTML・不正 UTF-8 を拒否する。
- assistant の本文をメッセージ単位で収集し、確定時に読み込む。終了前に保存・配信を待つ。欠損や不正参照は理由を示すカードを履歴に残す。コードフェンスは表示命令に変換しない。
- HTML の内容を `presents/<sessionId>.jsonl` に保存する。ファイルを変更・削除しても過去の表示は変わらない。更新を表示するには新しい参照を回答する。
- 表示は既存の会話タイムラインに統合する。同じ参照が複数ターンに出ても各版を回答順に配置し、再読み込み・分岐・バックエンド切り替えの履歴と共存する。
- `mode: wide` は広い初期表示向け。「サイドパネルに表示」は[会話の横のプレビューパネル](file-preview-proposal.md)で開き、Esc または閉じるで戻る。ファイルと同じ一枚の面を使い、次に開いたものへ差し替わる。広げる・幅変更・狭い画面の全面表示はファイルと共通。パネルでは保存済み HTML を新しく実行するため、操作状態は初期値になる。
- 会話のカードとパネルの両方から、元のパスをコピーし、HTML をダウンロードできる。カードのボタンはパネルの ⋯・下の行と同じ処理（`web/file-actions.mjs` の `copyPathText`、`web/visualize-frame.mjs` の `downloadVisualization`）を呼び、知らせの文言も同じ。落ちるのは会話に残っている内容に表示と同じ包み（CSP・基礎スタイル）を付けたもので、単体で開いても同じに見える。配色は焼き込まず、開いた環境のライト／ダークに従う。ファイル名は元のファイル名、無ければタイトルから作る。
- パネルの**表示の切り替え（プレビュー / 原文）はファイルと同じ**。プレビューは隔離した枠で動かし、原文は会話に残っている HTML を行番号付きで見せる（`web/file-preview.mjs` の `sourceView` をファイルと共有する）。
- パネルの部品は `web/side-panel.mjs` の `visualizationSlots` が決める（design-system.md「右パネルの枠」）。見出しの横に「可視化」の印、見出しの下は元のパス（作業ディレクトリの中なら相対。元が無ければ「会話に保存された表示」）。ツリーの枠は出さない。下の行は保存した時刻（記録の `at`。今日なら時刻だけ）。再読み込みは出さない（取り直す先が無い）。ホスト上の現在のファイルを読むファイルプレビューとは、同じ面でも読む対象が違う。保存もホストへ取りに行かず、会話に残っている内容を渡す。
- 元の在り処が分かるときだけ「パス」「元のファイルを開く」（同じパネルでファイルとして開く）「会話で使う」（元のパスを添付に積む。ファイルと同じ）と、写しであることの注記を出す。元のファイルが消えていても、在り処と作業ディレクトリは `resolvePath` の `lenient` で引く（読まない）。⋯ は元のパスをコピー・相対パスをコピー・ブラウザーで開く・元のファイルを開く・エクスプローラーで表示（サーバーのある PC の画面だけ）・HTML を保存・会話で使う。使えない項目は出さない。
- **「ブラウザーで開く」は写しを新しいタブで開く**（元のファイルではない。元は後から書き換わっていることがある）。Blob の URL は Pleiad と同じオリジンで動き、中のスクリプトが保存領域やトークンに届くので使わない。サーバーの `GET /visualization-snapshot?sessionId=…&id=…`（`id` の無い以前の記録は `at=…`）が、会話の記録（`presents`）から写しを引き、表示と同じ包みで返す。応答ヘッダーは `Content-Security-Policy: sandbox allow-scripts; <枠と同じ CSP>; frame-ancestors 'none'`（`allow-same-origin` は付けない。不透明なオリジンで動く）、`cache-control: private, no-store`、`nosniff`、`referrer-policy: no-referrer`。認証は他の画面と同じトークン（Cookie）で、HTML を画面から受け取らないのでリモートの接続口（GET だけを通す）からも開ける。記録に無い・エラーのカードは 404、指定が無ければ 400。新しい可視化の記録は `id` を持つ（`core/history.mjs`）。
- ポップアップとして止められないよう、押した瞬間に空の窓を開け、`opener` を切ってから行き先を入れる。窓を開けない殻（デスクトップ版は `setWindowOpenHandler` で断る）は、サーバーのある PC の画面なら `openVisualization` コマンドで写しをデータ置き場の `visualization-snapshots/` に書き、既定のブラウザーで開く（ファイルは文書の meta の CSP だけを持つ。1 日より古い写しは書くたびに消す）。どちらもできなければ、開けなかったことを短い知らせで示す。
- 高さの通知だけを iframe から受け取り、送信元の WindowProxy を確認して120〜900pxに制限する。パネルの可視化は面の高さに合わせるため、この通知を使わない。親へのコマンド実行 API は公開しない。

## 実行範囲

新しい `kind: visualization` は `sandbox="allow-scripts"` の iframe で動く。`allow-same-origin`、ポップアップ、親画面の遷移、フォーム送信は許可しない。親の DOM・Cookie・ストレージにはアクセスできない。CSP はモデルの HTML より前に挿入し、fetch/XHR/WebSocket、子フレーム、object、base の指定を禁止する。

スクリプト・CSS・フォントは HTTPS の cdnjs.cloudflare.com、esm.sh、cdn.jsdelivr.net、unpkg.com、fonts.googleapis.com、fonts.gstatic.com、fonts.bunny.net から読み込める。画像は data/blob URI。CDN への静的リソース取得は通信を伴う。モデルの指示にもネットワーク書き込みやページ遷移を行わないよう記載する。

ライト/ダークの基礎スタイルと可視化用 CSS 変数を提供する。JavaScript、SVG、canvas、ローカルの入力操作に対応する。Codex の `window.openai`、注釈、`Tweak` の専用 UI は提供しない。対応していない機能を使うコードは共通スキルで避ける。

右パネルの HTML ファイルプレビューも同じ sandbox・`allow` 指定・CSP で動かす（[ファイルプレビュー](file-preview-proposal.md)）。

旧 `kind: html` の履歴は従来の空 sandbox のまま、JavaScript を実行しない。画像・添付と旧 `host.present` / `ply.present` の履歴描画も維持する。新しい画像は Markdown の画像リンク、ファイルは通常のリンク、テキストは通常の回答を使う。

## 検証

`npm test` は分割参照、コード例、不正入力、サイズ・パス制限、保存と再開、タイムライン、旧 HTML と新しい可視化の隔離を検証する。`npm run test:e2e -- visualize` は Claude・Codex の実サービスに接続して新規・再開・履歴の各版と旧ツールを使わないことを確認する。

`tests/unit/side-panel.mjs` はモードごとの部品の表・渡さない部品を隠すこと（ファイルの次に可視化を開いてもツリーが残らない）・可視化の ⋯ を、`tests/unit/server-visualize.mjs` は `/visualization-snapshot` の応答ヘッダー・認証・不明・別の会話と、殻向けの `openVisualization` を検証する。

ブラウザーでは操作、親 DOM と fetch の遮断、旧 HTML のスクリプト禁止、パネルで開く・広げる・Esc・狭い画面、パスのコピーと保存の中身、ファイルとの往復で残らないこと（保存用 URL の解放を含む）を確認する。過去の `docs/artifact-sharing-investigation.md` は移行前の調査記録として残す。
