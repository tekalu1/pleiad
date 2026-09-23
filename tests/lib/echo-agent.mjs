// procway-code の `cli-agent` provider から呼ばれる、LLM の代わり。
//
// cli-agent は「1 往復のテキスト生成器」でしかない（ツール呼びも usage も返さない）。
// だからこれは「プロンプトを受け取って stdout に本文を返す」だけでよく、
// procway-code の serve / ブリッジ / セッション永続化を**本物のまま**回せる。
//
// プロンプトは flattenMessagesForCli の出力（"role: 本文" を空行で連結したもの）。
// 最後の `user:` ブロックが、いま人間が送った文。
//
// 受け取り方は 2 通りある（settings の stdinMode で決まる）:
//   argv[2] … provider.args に "{prompt}" を置いた場合
//   stdin   … stdinMode を "none" 以外にした場合
// Windows では cli-agent が cmd.exe 経由で叩くので、改行を含む長いプロンプトは
// コマンドラインに載せられない。テストは stdin 側を使う。
import { readFileSync } from "node:fs";

function readAll() {
  if (typeof process.argv[2] === "string" && process.argv[2].length > 0) return process.argv[2];
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

const prompt = readAll();

// 最後の "user:" ブロックだけを取り出す
const blocks = prompt.split(/\n\n+/);
let last = "";
for (const b of blocks) {
  const m = /^user:\s*([\s\S]*)$/.exec(b.trim());
  if (m) last = m[1].trim();
}
const said = last || prompt.trim();

// 中断を測るための台本。kill されるまで終わらない
if (/^slow\b/.test(said)) {
  setInterval(() => {}, 1000);
} else {
  process.stdout.write(`echo-agent: ${said}`);
}
