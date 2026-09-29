# ランディングサイト

Pleiad の紹介ページ。ビルドは無く、このディレクトリをそのまま静的に配る。

```bash
python -m http.server 8799 --directory site   # http://127.0.0.1:8799/
```

- `index.html`・`styles.css`・`main.js`: ページと、スクロールで場面を切り替えるアプリ画面の再現。
- `hero.js`: ヒーローの星図（three.js。版は `index.html` の importmap で固定）。星 = 会話の節、線 = 分岐、青 = 今いる枝、赤紫の ◆ = 承認待ち、回る弧 = 実行中。色と印の意味はアプリと同じ（`docs/design-system.md`）。
- WebGL が無い環境では `assets/sky.webp`（星図を焼いた一枚）を出す。`assets/og.png` は共有用の画像。どちらも星図の形を変えたら撮り直す。
- 書体は使う字だけに削った woff2（`assets/fonts/`、OFL）。文言を変えたら `python site/tools/subset-fonts.py` で作り直す。
- 動きは `prefers-reduced-motion` で止まる。
