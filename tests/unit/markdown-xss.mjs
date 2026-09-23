// md 描画の XSS 監査。ブラウザも LLM も要らないので CI で常時回す。
import { renderMarkdown } from "../../web/render.mjs";
import { audit } from "../lib/audit.mjs";

export const name = "markdown-xss";
export const title = "md 描画が毒を通さない / 普通の記法は壊さない";

const cases = [
  ["XSS: script", `<script>alert(1)</script>`],
  ["XSS: img onerror", `<img src=x onerror=alert(1)>`],
  ["XSS: javascript: link", `[click](javascript:alert(1))`],
  ["XSS: 属性抜け", `[a](https://x.com" onmouseover="alert(1))`],
  ["XSS: コード内", "```\n<script>alert(1)</script>\n```"],
  ["XSS: data: link", `[d](data:text/html,<script>alert(1)</script>)`],
  ["XSS: 生 iframe", `<iframe src="//evil"></iframe>`],
  ["XSS: 画像記法で js", `![x](javascript:alert(1))`],
  ["XSS: 見出しに混入", `# <img src=x onerror=alert(1)>`],
  ["XSS: 表セルに混入", "| a |\n|---|\n| <script>x</script> |"],
  // パスの自動リンク（インラインコード・地の文の Windows の絶対パス）。data-file-path に値として入るだけ
  ["XSS: 地の文のパスに引用符とタグ", String.raw`D:\a\"><script>alert(1)</script>.md と D:\x'onmouseover='alert(1)'.md`],
  ["XSS: インラインコードのパスに引用符", "`D:\\it's\\a&b.md` と `./x'y\" onclick=\"alert(1).md` と `web/a'b.md:3`"],
  ["XSS: 強調の中のパス", String.raw`**D:\a\<img src=x onerror=alert(1)>.md**`],
  ["パスの自動リンク", "`web/render.mjs` と D:\\dev\\a.md と `npm test`"],
  ["見出し", "# h1\n## h2\n### h3"],
  ["表", "| a | b |\n|---|---|\n| 1 | 2 |"],
  ["ネストリスト", "- x\n  - y\n- z"],
  ["番号リスト", "1. one\n2. two"],
  ["コードフェンス", "```js\nconst a = 1 < 2 && 3 > 2;\n```"],
  ["インラインコード", "これは `a < b` です"],
  ["引用", "> quote"],
  ["水平線", "---"],
  ["リンク正常", "[ok](https://example.com)"],
  ["相対リンク", "[rel](./docs/design.md)"],
];

export default async function (t) {
  for (const [label, src] of cases) {
    const out = renderMarkdown(src);
    const problems = audit(out);
    t.ok(label, problems.length === 0, problems.join(" / ") || (label.startsWith("XSS") ? "" : out.replace(/\n/g, "").slice(0, 70)));
    if (problems.length) t.note(`出力: ${out.slice(0, 160)}`);
  }

  // 長文で崩れない（描画が途中で諦めて素通しにしていないか）
  const long = Array.from({ length: 400 }, (_, i) => `- 行 ${i} \`code\` **強調**`).join("\n");
  const out = renderMarkdown(long);
  const li = (out.match(/<li/g) ?? []).length;
  t.ok("長文 400 行でも監査を通る", audit(out).length === 0 && li === 400, `${out.length} 文字 / li ${li} 個`);
}
