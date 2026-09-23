// 生成された HTML の監査。md 描画とツール表示の両方から使う。
//
// 見るのは「危険な文字列が含まれるか」ではなく「タグ位置・属性位置に入るか」。
// エスケープ済みのテキストとして `<script>` が現れるのは正常なので、
// 文字列一致で NG にすると監査そのものが嘘になる。
//
// ツール表示は毒を title 属性などに**値として**入れるので、
// 「タグ全体に onerror= が現れるか」では誤検知する。属性を分解して名前の位置だけを見る。

const ALLOWED_TAGS = new Set([
  "p", "h1", "h2", "h3", "h4", "ul", "ol", "li", "code", "pre", "div", "span",
  "table", "thead", "tbody", "tr", "th", "td", "blockquote", "hr", "a",
  "strong", "em", "br", "del", "details", "summary", "button", "svg", "path",
]);
const SAFE_HREF = /^(https?:\/\/|\/|#|\.{0,2}\/|[^:\s]*$)/i;
const ATTR = /([a-zA-Z_:][\w:.\-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
const ENT = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'" };
const unesc = (s) => String(s).replace(/&(amp|lt|gt|quot|#39);/g, (m) => ENT[m]);

/** 問題があれば説明の配列を返す。空配列なら安全。 */
export function audit(html) {
  const problems = [];
  for (const m of html.matchAll(/<\/?([a-zA-Z][\w-]*)\b/g)) {
    if (!ALLOWED_TAGS.has(m[1].toLowerCase())) problems.push(`許可外タグ <${m[1]}>`);
  }
  for (const tag of html.matchAll(/<[a-zA-Z][\w-]*((?:"[^"]*"|'[^']*'|[^>"'])*)>/g)) {
    for (const a of tag[1].matchAll(ATTR)) {
      const name = a[1].toLowerCase();
      const value = unesc(a[2] ?? a[3] ?? a[4] ?? "");
      if (/^on\w+$/.test(name)) problems.push(`イベント属性: ${name}=${value.slice(0, 40)}`);
      if ((name === "href" || name === "xlink:href") && !SAFE_HREF.test(value)) problems.push(`危険な href: ${value.slice(0, 60)}`);
      if ((name === "src" || name === "srcdoc") && /^\s*(javascript|data:text\/html)/i.test(value)) {
        problems.push(`危険な ${name}: ${value.slice(0, 40)}`);
      }
    }
  }
  return problems;
}
