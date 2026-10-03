# 0124 bot の生成画像をスレッドの投稿に付け、画像アイコンを置き場の写しで持つ

- 状態: 提案

## 状況

Codex の画像生成は Chats では `tool.result.images` として表示されるが、bot のスレッドの投稿には `present` だけが集められ、生成した PNG が投稿に出なかった。また bot の定義は絵文字 1 つの `icon` しか持たず、画像を使えなかった。

## 決定

- bot のターンの `tool.result.images` を画像の提示として集め、既存の `Post.presents` に載せる。Claude・Antigravity の `present` も同じ経路に載る。bot の `channels.post` がターンの投稿に入るときは、ADR 0116 の `attachments` も編集操作へ渡す。
- bot の定義に任意の `iconImage` を足す。画面で選んだ PNG・JPEG・WebP（10 MiB 以下）は、ブラウザーの `createImageBitmap` と canvas で 256×256 に切り抜き、WebP にしてから送る。`bots.create`・`bots.update` に渡す画像の絶対パスは、1 MiB 以下で PNG・JPEG・WebP のマジックバイトを持つときだけ受け入れる。ホストは縮小せずに `<データ置き場>/uploads/bot-icons/` へ写す。表示には写しを使い、元のパスへ依存しない。
- 画像は bot のページと `bots.update` から設定する。AI が画像を変えるときは人格の変更と同じ承認を求める。画像を外すと、既存の絵文字を表示する。

## 理由

画像生成の結果を投稿の既存の提示へ載せれば、チャンネルに別の画像保存形式を足さずに済む。画面から選ぶ画像は送信前に小さくし、パスで指定された画像は形式と容量を確かめて写す。bot の定義に画像本体を入れず、画像処理のネイティブ依存も増やさない。AI が外部の文に従って恒久的な見た目を変える操作は、人格の変更と同じ確認を通す。

## 影響

`bots.json` の版と `DATA_SCHEMA` は変えない。古い bot は `iconImage: ''` として読み、絵文字のまま動く。画像を更新・解除・bot を削除すると、古い写しは消す。投稿は従来の `presents` と `attachments` の任意欄を使い、古い投稿の読み方は変わらない。
