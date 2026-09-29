// 自分の発言の描画（web/user-message.mjs、ADR 0059）: 印の置き換え・末尾の古い形式・畳み込み・二重に出さない
import { placeAttachments, bodyUnits, foldIndex, userBodyHtml, attachmentName, userTools, attachmentListItem } from "../../web/user-message.mjs";
import { buildItems, inlineAttachments, showsAsCard } from "../../web/timeline.mjs";
import { audit } from "../lib/audit.mjs";

export const name = "user-message";
export const title = "自分の発言: 添付の印を本文の位置に置く・畳む・別カードを二重に出さない";

const IMG = "data:image/png;base64,iVBORw0KGgo=";
const image = (path, extra = {}) => ({ by: "human", kind: "image", path, dataUri: IMG, captionParams: { name: path.split(/[\\/]/).at(-1) }, ...extra });
const file = (path, extra = {}) => ({ by: "human", kind: "file", path, content: "x", captionParams: { name: path.split(/[\\/]/).at(-1) }, ...extra });
const a = image("C:\\up\\a.png"), b = image("C:\\up\\b.png"), c = file("C:\\up\\c.md");
const shape = segments => segments.map(s => (s.type === "text" ? `T(${s.text.replace(/\n/g, "|")})` : `${s.trailing ? "E" : "A"}(${attachmentName(s.present)})`)).join(" ");

export default async function (t) {
  // ---- 一覧の面の行: 出どころ・大きさは core が載せた present から出す（画像の dataUri からの見積もりより先）
  const host = attachmentListItem({ ...file("D:\\work\\確認項目.md"), origin: "host", size: 4096 }, 0);
  t.ok("present の origin・size を一覧の行に出す（ホストのファイルはパスで渡した印）", host.origin === "host" && host.size === 4096 && host.status === "パスで渡す", JSON.stringify(host));
  t.ok("size が無い present は、画像なら dataUri から見積もり、ファイルなら出さない", attachmentListItem(image("C:\\up\\a.png"), 0).size > 0 && attachmentListItem(file("C:\\up\\c.md"), 0).size === null);

  // ---- 印の置き換え: 位置・一致しないパス・コードブロック内
  const mid = "説明1\n[添付] C:\\up\\a.png\n\n説明2\n[添付] C:\\up\\b.png\n\n確認項目\n[添付] C:\\up\\c.md\n\n- 箇条書き";
  t.ok("印の行は本文の位置に置く（前後の文字はそのまま）",
    shape(placeAttachments(mid, [a, b, c])) === "T(説明1) A(a.png) T(|説明2) A(b.png) T(|確認項目) A(c.md) T(|- 箇条書き)");

  t.ok("パスの区切り・ドライブの大小文字は吸収する",
    shape(placeAttachments("x\n[添付] c:/UP/a.png", [a])) === "T(x) A(a.png)");
  t.ok("英語の印（[Attachment]）も置く", shape(placeAttachments("x\n[Attachment] C:\\up\\a.png", [a])) === "T(x) A(a.png)");

  t.ok("結び付いた添付とパスが一致しない印は消さない（本文のまま）",
    shape(placeAttachments("x\n[添付] C:\\other\\z.png\ny", [a])) === "T(x|[添付] C:\\other\\z.png|y) E(a.png)");
  t.ok("添付が 1 件も結び付いていなければ何も置き換えない",
    shape(placeAttachments("x\n[添付] C:\\up\\a.png", [])) === "T(x|[添付] C:\\up\\a.png)");

  const fenced = "例:\n```\n[添付] C:\\up\\a.png\n```\n~~~md\n[添付] C:\\up\\a.png\n~~~\n本物\n[添付] C:\\up\\a.png";
  const fs = placeAttachments(fenced, [a]);
  t.ok("コードブロックの中の印は消さず、外の印だけを置く",
    shape(fs) === "T(例:|```|[添付] C:\\up\\a.png|```|~~~md|[添付] C:\\up\\a.png|~~~|本物) A(a.png)", shape(fs));

  t.ok("同じ添付は 1 か所（同じパスの印が続いても present の数だけ）",
    shape(placeAttachments("[添付] C:\\up\\a.png\n[添付] C:\\up\\a.png", [a])) === "A(a.png) T([添付] C:\\up\\a.png)");
  t.ok("同じパスの present が 2 件なら印の 2 か所へ", shape(placeAttachments("[添付] C:\\up\\a.png\n[添付] C:\\up\\a.png", [a, { ...a }])) === "A(a.png) A(a.png)");

  // ---- 古い形式（印が末尾にまとまる）と、印の無い present
  const legacy = "確認してください\n\n[添付] C:\\up\\a.png\n[添付] C:\\up\\b.png\n[添付] C:\\up\\c.md";
  const ls = placeAttachments(legacy, [a, b, c]);
  t.ok("印が末尾にまとまる古い形式は、本文の後ろに同じ順で並ぶ", shape(ls) === "T(確認してください|) A(a.png) A(b.png) A(c.md)", shape(ls));
  const units = bodyUnits(ls);
  t.ok("間に本文の無い添付は 1 つのまとまり（画像を横に並べる）",
    units.length === 2 && units[0].kind === "md" && units[1].kind === "atts" && units[1].items.length === 3);
  const legacyHtml = userBodyHtml(legacy, [a, b, c]);
  t.ok("末尾の印の行は画面に残らない", !legacyHtml.html.includes("[添付]") && legacyHtml.placed === 3 && legacyHtml.attachments === 3, legacyHtml.html.slice(0, 200));
  t.ok("印の無い present は位置を作らず末尾に並べる",
    shape(placeAttachments("本文だけ", [a, c])) === "T(本文だけ) E(a.png) E(c.md)");

  // ---- 描画（HTML）
  const html = userBodyHtml("# 見出し\n\n**行間**を詰める。\n[添付] C:\\up\\a.png\n[添付] C:\\up\\b.png\n\n資料\n[添付] C:\\up\\c.md\n\n```css\n.x{}\n```", [a, b, c]);
  t.ok("Markdown で描く（見出し・強調・コード）", html.html.includes("<h1>見出し</h1>") && html.html.includes("<strong>行間</strong>") && html.html.includes("code-block"));
  t.ok("画像は縮小の figure（押すと拡大するボタンと名前）",
    (html.html.match(/<figure class="msg-att msg-att-img">/g) ?? []).length === 2 && html.html.includes('class="msg-att-zoom"') && html.html.includes("<figcaption>a.png</figcaption>"));
  t.ok("連続する画像は 1 つの msg-atts の中（横並び）", html.html.includes('<div class="msg-atts"><figure') && html.html.split('<div class="msg-atts">').length - 1 === 2);
  t.ok("ファイルは文中の札（ファイルリンク。押すと右パネルで開く）",
    html.html.includes('class="md-link file-link msg-att msg-att-file"') && html.html.includes('data-file-path="C:\\up\\c.md"'));
  t.ok("置き換えた印は画面に出ない", !html.html.includes("[添付]") && html.placed === 3);
  const plain = userBodyHtml("x\n[添付] C:\\up\\a.png", [a], { markdown: false });
  t.ok("markdown: false は今までの平文（印は残り、添付は置かない）", plain.html.includes("[添付]") && !plain.html.includes("msg-att") && plain.attachments === 0);

  // ---- 危険な入力は通さない
  const evil = userBodyHtml("<script>alert(1)</script>\n[添付] C:\\up\\e.png\n[添付] C:\\up\\f.md",
    [image("C:\\up\\e.png", { captionParams: { name: '"><img src=x onerror=alert(1)>.png' } }), file("C:\\up\\f.md", { captionParams: { name: "<b onmouseover=alert(1)>f</b>.md" } })]);
  const problems = audit(evil.html);
  t.ok("発言の生の HTML も、添付の名前の HTML も実行されない", problems.length === 0, problems.join(" / ") || evil.html.slice(0, 200));
  t.ok("画像として載せられない present（中身を外した大きな画像）は、/local-file を指す画像になる",
    userBodyHtml("[添付] C:\\up\\big.png", [{ by: "human", kind: "image", path: "C:\\up\\big.png", truncated: true }]).html.includes("/local-file?path=C%3A%5Cup%5Cbig.png"));

  // ---- 畳み込み
  const md = lines => ({ kind: "md", lines, html: "" });
  const atts = () => ({ kind: "atts", items: [a] });
  t.ok("短い発言は畳まない", foldIndex([md(3), atts(), md(4)]) === -1);
  t.ok("ちょうど境目の直後で畳む（段落・添付のまとまりの境目）", foldIndex([md(4), md(4), md(2), md(2), md(2)]) === 2);
  t.ok("畳む位置の直後の添付は、直前の段落に付いたものとして見せる", foldIndex([md(4), md(4), atts(), md(3), md(3)]) === 3);
  t.ok("畳まれる側の本文が 3 行に満たなければ畳まない", foldIndex([md(4), md(4), md(2)]) === -1);
  t.ok("添付だけが後ろに残るなら畳まない", foldIndex([md(4), md(5), atts()]) === -1);
  t.ok("最初の添付のまとまりが 8 行以内にあれば、そこまで見せる", foldIndex([md(9), md(3), atts(), md(2), md(4)]) === 3);
  t.ok("最初の添付のまとまりが遠ければ、そこまでは見せない", foldIndex([md(9), md(9), atts(), md(2), md(4)]) === 1);
  const long = Array.from({ length: 30 }, (_, i) => `行 ${i}`).join("\n\n");
  const folded = userBodyHtml(long, []);
  t.ok("長い発言は details で畳み、続きを開閉できる", folded.folded && folded.html.includes('<details class="msg-more">') && folded.html.includes("続きを表示") && folded.html.includes("折りたたむ"));
  t.ok("畳んだ側にも本文が残る（原文は削らない）", folded.html.includes("行 29") && folded.html.indexOf("行 29") > folded.html.indexOf("<details"));

  // ---- 発言の下の行
  t.ok("添付が無い発言には下の行を出さない", userTools({ raw: "x", presents: [] }) === null);
  const rawText = "x\n[添付] C:\\up\\a.png";
  const tools = userTools({ raw: rawText, presents: [a, b] });
  t.ok("添付の入口（字は件数だけ。名前と title は「添付 2 件の一覧を開く」）と原文の入口（原文は送った本文そのまま・初めは閉じている）",
    tools.row.querySelectorAll(".msg-tool").length === 2 && !tools.row.shown.includes("添付") && tools.row.querySelector(".msg-tool-n")?.textContent === "2"
    && tools.row.querySelector(".msg-tool-atts")?.attrs.title === "添付 2 件の一覧を開く" && tools.source.hidden === true && tools.source.textContent === rawText);

  // ---- 発言に結び付いた present を別カードとして二重に出さない
  const messages = [
    { role: "user", text: "見て\n[添付] C:\\up\\a.png", at: "2026-09-29T10:00:00.000Z" },
    { role: "assistant", text: "はい", at: "2026-09-29T10:00:05.000Z" },
  ];
  const presents = [
    { ...a, at: "2026-09-29T10:00:00.500Z" },
    { by: "human", kind: "image", path: "C:\\elsewhere\\lost.png", dataUri: IMG, at: "2026-09-29T10:00:01.000Z" },
    { by: "ai", kind: "image", path: "C:\\out\\ai.png", dataUri: IMG, at: "2026-09-29T10:00:06.000Z" },
  ];
  const items = buildItems(messages, presents);
  const owned = inlineAttachments(items);
  t.ok("発言に結び付いた human の present だけが取り込み対象", owned.size === 1 && owned.get(0)?.length === 1 && owned.get(0)[0].path === a.path);
  const cards = inlined => items.filter(i => i.kind === "present" && showsAsCard(i, inlined)).map(i => i.p.path);
  t.ok("取り込んだ発言の添付は別カードにしない", !cards(new Set([0])).includes(a.path));
  t.ok("結び付かなかった human の present と AI の present は今までどおりカード", cards(new Set([0])).join() === "C:\\elsewhere\\lost.png,C:\\out\\ai.png", cards(new Set([0])).join());
  t.ok("発言を本文に取り込めなかった（描いていない）なら、添付はカードで残る", cards(new Set()).includes(a.path));
  const visual = buildItems([{ role: "user", text: "x", at: "2026-09-29T10:00:00Z" }, { role: "assistant", text: "visualize{\"path\":\"D:/v.html\"}", at: "2026-09-29T10:00:01Z" }],
    [{ by: "ai", kind: "visualization", reference: "visualize{\"path\":\"D:/v.html\"}", at: "2026-09-29T10:00:02Z" }]);
  t.ok("AI の可視化は発言に取り込む対象にならない", inlineAttachments(visual).size === 0 && showsAsCard(visual.find(i => i.kind === "present"), new Set([0, 1])));
}
