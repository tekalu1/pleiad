---
name: visualize
description: Pleiad の会話の中に、操作できる図・グラフ・UI のプレビューを出す。見て分かる説明や検討に使い、通常のプロジェクトのファイルの編集には使わない。
---

# Pleiad での可視化

Pleiad は、すべてのエージェントで Visualize の参照形式に対応している。会話の中に表示を出すには、今の作業ディレクトリの下に UTF-8 の HTML の断片を書き（例 `output/visualizations/comparison.html`）、その後に単独の行として `visualize{"path":"<absolute-path>/comparison.html","title":"Comparison"}` を出力する。ユーザーが表示用に既存の HTML ファイルを渡したときは、作り直さずにそのファイルを直接参照する。

Codex のネイティブの形式 `visualize{"path":"<absolute-path>/comparison.html","title":"Comparison"}` も同じ意味になる。Claude のとき、または経路が特殊な Unicode の印を落とすときは、ASCII の形式を使う。どちらの形式も、まったく同じ描画と保存を使う。

参照はコードの例としてではなく、応答の内容として出力する: バッククォート・Markdown のコードフェンス・字下げ・箇条書きの記号を付けない。Pleiad はフェンスで囲んだ例を意図的に文字のまま残し、そこからは表示を出さない。

実行する側の絶対パスを使う。Windows では / か、JSON でエスケープした \ で区切る。任意の `"mode":"wide"` を付けると、デスクトップのモックアップや関連する複数のパネル向けに、広げられる表示になる。1 つの表示は最大 1 MiB。Pleiad はアシスタントのメッセージの終わりに HTML の写しを会話の履歴に取るので、後でファイルを編集しても過去の表示は変わらない。更新するときは新しい参照を出す。1 ターンの参照は 32 件まで。

インストール済みの Visualize の Skill がデザインの指針を与える場合も、同じ出力の方法を使う。廃止した `present` MCP ツールは使えない。画像はローカルの絶対パスへの通常の Markdown の画像リンク、ファイルは Markdown のリンク、文章は通常の応答で示す。

HTML はそのまま書き、スタイルとスクリプトは範囲を限る。最初の状態はすぐに描く。JavaScript・SVG・canvas・スライダー・ボタン・その場のイベント処理は、隔離された iframe の中で動く。ルートには一意の ID を使う。レスポンシブのレイアウトは 360px に収め、収めるためにラベルを縮めない。操作部品にはアクセシブルな名前を付ける。

ホストは、ライト・ダークの基本のスタイル、共通の `.card`・`.btn` とレイアウトのクラス、`--foreground`、`--background`、`--muted-foreground`、`--border`、`--card`、`--popover`、`--popover-foreground`、`--viz-series-1` から `--viz-series-6` などの可視化用の CSS 変数を用意している。製品のモックアップでは、範囲を限った独自の製品のスタイルを定義する。

静的なスクリプト・スタイル・フォントは、cdnjs.cloudflare.com、esm.sh、cdn.jsdelivr.net、unpkg.com、fonts.googleapis.com、fonts.gstatic.com、fonts.bunny.net から HTTPS で読み込める。ライブラリの版は固定する。インラインのデータと data URI の画像は使える。fetch・XHR・WebSocket・フォーム・入れ子のフレーム・相対パスの資源・親のアプリへのアクセスは使えない。ストレージ、`window.openai`、注釈、Codex の `Tweak` の操作部品に頼らない。その場の操作部品を使い、任意のホストの補助機能は有無を確かめてから使う。表示の中から画面を移動したり、ネットワークへ書き込んだりしない。

単純な比較には通常の Markdown の表を使う。結果を見たり操作したりすることで理解が大きく深まるときに HTML を作る。説明は応答に書き、表示の中には必要なタイトル・ラベル・凡例・操作部品だけを置く。タスクがデータや UI に触れているというだけで表示を作らない。Web サイトやプロジェクトの編集を頼まれたなら、それはプロジェクトの作業のままである。
