// 画面の localStorage（確認済みの印・テーマ・開いていた会話・下書き）は origin ごとに分かれる。
// 起動のたびに空きポートを取り直すと origin が変わり、更新や再起動で全部消えて見える。
// 前回のポートを覚えて次も同じポートで待ち受け、塞がっているときだけサーバー側が空きポートへ逃がす。
const fs = require('node:fs');

function savedPort(file) {
  try {
    const { port } = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : 0;
  } catch { return 0; }
}

function rememberPort(file, port) {
  if (!Number.isInteger(port) || port === savedPort(file)) return;
  try { fs.writeFileSync(file, JSON.stringify({ port })); } catch { /* 覚えられなくても今回は動く */ }
}

module.exports = { savedPort, rememberPort };
