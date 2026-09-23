// 監査そのものの検査。
//
// audit() が壊れて何も検出しなくなると、XSS のテストは黙って全部通ってしまう。
// 「毒を毒と言えること」と「正常を毒と言わないこと」の両方をここで固定する。
import { audit } from "../lib/audit.mjs";

export const name = "audit-self";
export const title = "監査が毒を見落とさない / 正常を誤検知しない";

const dangerous = [
  ["生 script", `<p>a</p><script>alert(1)</script>`],
  ['SVGのイベント属性', '<svg onload="alert(1)"><path d="M0 0"/></svg>'],
  ['SVGのリンク属性', '<svg><path xlink:href="javascript:alert(1)"/></svg>'],
  ["生 iframe", `<iframe src="//evil"></iframe>`],
  ["イベント属性", `<div onclick="alert(1)">x</div>`],
  ["クォート無しのイベント属性", `<img src=x onerror=alert(1)>`],
  ["javascript: の href", `<a href="javascript:alert(1)">x</a>`],
  ["data:text/html の src", `<span src="data:text/html,<b>x</b>">y</span>`],
];

const clean = [
  ["エスケープ済みの script", `<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>`],
  ["属性値に入った毒", `<span title="&lt;img src=x onerror=alert(1)&gt;">x</span>`],
  ["属性値に onerror= という文字", `<code>onerror=alert(1)</code>`],
  ["href に見える文字列を含む本文", `<p>href="javascript:alert(1)" と書いた</p>`],
  ["普通のリンク", `<a href="https://example.com">ok</a>`],
  ["相対リンク", `<a href="./docs/design.md">rel</a>`],
  ["アンカー", `<a href="#top">top</a>`],
  ["表", `<table><thead><tr><th>a</th></tr></thead><tbody><tr><td>1</td></tr></tbody></table>`],
];

export default async function (t) {
  for (const [label, html] of dangerous) {
    const problems = audit(html);
    t.ok(`見落とさない: ${label}`, problems.length > 0, problems.join(" / ") || "検出できなかった");
  }
  for (const [label, html] of clean) {
    const problems = audit(html);
    t.ok(`誤検知しない: ${label}`, problems.length === 0, problems.join(" / "));
  }
}
