// 入力欄の Markdown 文書モデル（web/md-doc.mjs、ADR 0060）: 往復で文字が変わらない・整形の規則と元に戻す・行の操作・添付の位置
import {
  markdownToDoc, docToMarkdown, classifyLine, parseInline, serializeRuns, sliceRaw, fenceRoles, ensureShape,
  caret, deleteSelection, insertText, insertPlain, enter, backspaceAtStart, deleteAtEnd, insertAtom, removeAtoms, newAtom, atomKeys,
  pasteText, pasteRich, removeAtomsTidy, normalizeFences, applyTriggers, toggleMark, marksInRange, selectionMarkdown, createHistory,
  posToOffset, offsetToPos, runsText, runsLength, normalizeAttachmentPath, docLayout, memoRaw, renumber, indentList, indentLevel, quoteDepth,
} from "../../web/md-doc.mjs";
import { codeFenceMask } from "../../web/render.mjs";

export const name = "md-doc";
export const title = "入力欄の文書モデル: 往復で文字が変わらない・打った直後の整形と元に戻す・行の操作・添付の位置";

const P = "C:\\up\\a.png", Q = "C:\\up\\b.md";
const known = new Set([P, Q].map(p => p.toLowerCase()));
const resolve = (p) => (known.has(p.toLowerCase()) ? { path: p } : null);
const doc = (md) => markdownToDoc(md, { resolve });
const st = (md, b = 0, v = 0) => ({ blocks: doc(md), sel: caret(b, v) });
const md = (state) => docToMarkdown(state.blocks);
const kinds = (state) => state.blocks.map(b => b.kind + (b.pad ? "*" : "")).join(",");
const at = (state) => `${state.sel.s.b}:${state.sel.s.v}`;

/** 決まった乱数（実行のたびに同じ入力にする） */
function rng(seed) { let s = seed; return () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff; }

export default async function (t) {
  // ------------------------------------------------------------ 往復
  const samples = [
    "", "a", "a\nb", "# 見出し\n\n本文の**太字**と*斜体*と`code`と[リンク](https://x.y/z)", "- a\n- b\n  - c\n1. one\n2) two", "> 引用\n> > 入れ子",
    "```js\nconst a = 1;\n```\n後ろ", "```\n閉じない", "~~~\nx\n~~~", "**a****b**", "``a`b``", "` `` `", "\\*not em\\*", "_snake_case_ と *x*",
    `[添付] ${P}\n本文\n[添付] ${Q}`, "* item\n\n  継続\n\n---\n| 表 | b |\n|---|---|", "<b>html</b> &amp; 記号", "末尾に空行\n\n", "\n先頭に空行",
  ];
  const bad = samples.filter(s => docToMarkdown(markdownToDoc(s, { resolve })) !== s);
  t.ok("代表的な Markdown は往復で 1 文字も変わらない", bad.length === 0, JSON.stringify(bad));
  const pieces = ["a", "b", " ", "*", "**", "_", "__", "`", "``", "```", "[", "]", "(", ")", "#", "- ", "> ", "1. ", "\n", "\\", "é", "日本", "!", "~~~", "http://x.y", "  ", "[添付] C:\\up\\a.png"];
  const rnd = rng(20260929);
  let broken = null;
  for (let n = 0; n < 6000 && !broken; n++) {
    let s = "";
    for (let i = 0, len = 1 + Math.floor(rnd() * 14); i < len; i++) s += pieces[Math.floor(rnd() * pieces.length)];
    if (docToMarkdown(markdownToDoc(s, { resolve })) !== s) broken = s;
  }
  t.ok("でたらめな 6,000 件の文字列（記号・改行・添付の印・日本語）も往復で変わらない", !broken, JSON.stringify(broken));
  t.ok("CRLF は LF に正規化して読む", docToMarkdown(doc("a\r\nb")) === "a\nb");

  // ------------------------------------------------------------ 分類
  const kind = (line) => classifyLine(line, { resolve }).kind;
  t.ok("行の種類: # 見出し・- * + と 1. 1) の箇条書き・> 引用・普通の行", kind("## a") === "h" && kind("- a") === "ul" && kind("* a") === "ul" && kind("+ a") === "ul"
    && kind("1. a") === "ol" && kind("1) a") === "ol" && kind("> a") === "quote" && kind("a") === "p" && kind("#a") === "p" && kind("-a") === "p");
  t.ok("添付の印は、結び付く添付があるときだけ原子。無ければ平文の行のまま", kind(`[添付] ${P}`) === "att" && kind("[添付] C:\\other\\x.png") === "p" && kind("[Attachment] C:\\UP\\A.PNG") === "att");
  t.ok("コードフェンスの中の行（印・記号）は code。フェンスは codeFenceMask と同じ範囲",
    kinds({ blocks: doc(`\`\`\`\n# x\n[添付] ${P}\n\`\`\`\n# y`) }) === "code,code,code,code,h");
  const roleSamples = ["```js\na\n```\nb", "```\nopen", "~~~\nx\n~~~\n```\ny\n```", "  ```\n  z\n  ```", "````\n```\n````"];
  t.ok("fenceRoles は web/render.mjs の codeFenceMask と同じ範囲を返す",
    roleSamples.every(s => JSON.stringify(fenceRoles(s.split("\n")).map(Boolean)) === JSON.stringify(codeFenceMask(s.split("\n")))));
  t.ok("フェンスの外の行は分類し直し、中に入った行は code にする（normalizeFences）", (() => {
    const s = st("a\n- b\nc"); s.blocks[0].runs = [{ text: "```", marks: [] }];
    return normalizeFences(s.blocks) && kinds(s) === "code,code,code" && (() => { s.blocks[0].runs = []; return normalizeFences(s.blocks) && kinds(s) === "p,ul,p"; })();
  })());

  // ------------------------------------------------------------ インライン
  const inl = (text) => parseInline(text).map(r => `${r.marks.map(m => m.t).join("+") || "-"}:${r.text}`).join("|");
  t.ok("**太字**・__太字__・*斜体*・_斜体_・`code`・[文字](URL)を読む",
    inl("a **b** c __d__ *e* _f_ `g` [h](http://x.y)") === "-:a |strong:b|-: c |strong:d|-: |em:e|-: |em:f|-: |code:g|-: |link:h");
  t.ok("入れ子（太字の中の斜体・リンクの中の太字）", inl("**a *b* c**") === "strong:a |strong+em:b|strong: c" && inl("[**x**](http://x.y)") === "link+strong:x");
  t.ok("閉じないもの・空白で始まるもの・単語の中の _・エスケープは平文のまま",
    inl("**a") === "-:**a" && inl("* a *") === "-:* a *" && inl("snake_case_x") === "-:snake_case_x" && inl("\\*a\\*") === "-:\\*a\\*" && inl("![alt](http://x.y)") === "-:![alt](http://x.y)");
  t.ok("コードスパンの中は解釈しない・` を含む中身は区切りを増やして書く", inl("`**x**`") === "code:**x**"
    && (() => { const runs = parseInline("a"); runs[0].marks = [{ id: 9001, t: "code", d: "`" }]; runs[0].text = "x`y"; return serializeRuns(runs) === "``x`y``"; })());
  t.ok("往復: 開きの区切りの種類（* と _）と URL を覚えている", ["*a*", "_a_", "**a**", "__a__", "[a](http://x.y)"].every(s => serializeRuns(parseInline(s)) === s));

  // ------------------------------------------------------------ 打った直後の整形
  // 1 字打った直後の状態（キャレットは字の直後）を作り、整形を当てる。整えた直後は、字が強調の外へ入る（編集欄と同じ）
  const type = (state, ch) => {
    const typed = state.sel.after ? insertPlain(state, ch) : insertText(state, ch);
    return { typed, trig: applyTriggers(typed, ch) };
  };
  const typeAll = (start, text) => { let s = start; const log = []; for (const ch of text) { const r = type(s, ch); s = r.trig ? r.trig.state : r.typed; if (r.trig) log.push(r.trig.kind); } return { s, log }; };
  let r = typeAll(st(""), "# ");
  t.ok("行頭の `# ` で見出し（記号は行の種類に移り、字は空）", kinds(r.s) === "h" && md(r.s) === "# " && r.log[0] === "block");
  t.ok("`- `・`* `・`1. `・`> ` で箇条書き・番号・引用", ["- ", "* ", "1. ", "> "].map(k => kinds(typeAll(st(""), k).s)).join(",") === "ul,ul,ol,quote");
  t.ok("文の途中の `# ` は見出しにしない・見出し以外の行の中でも整えない", kinds(typeAll(st("a", 0, 1), "# ").s) === "p" && kinds(typeAll(st("# x", 0, 3), "- ").s) === "h");
  t.ok("行頭で `# ` を打つと、その行が見出しになる（字は残る）", (() => { const x = typeAll(st("a"), "# ").s; return kinds(x) === "h" && md(x) === "# a"; })());
  r = typeAll(st(""), "a **b** c");
  t.ok("`**b**` は閉じた時点で太字になり、キャレットはその外", md(r.s) === "a **b** c" && r.s.blocks[0].runs.map(x => x.marks.length).join("") === "010" && r.log.join() === "inline");
  t.ok("`*i*`・`_i_`・`` `c` ``・[t](url) も閉じた時点で整う", ["*i*", "_i_", "`c`", "[t](http://x.y)"].every(s => typeAll(st(""), s).log.join() === "inline" && md(typeAll(st(""), s).s) === s));
  t.ok("二重の区切りを打っている途中（`**b*`）は斜体にしない・`a * b * c` は整えない", typeAll(st(""), "**b*").log.length === 0 && typeAll(st(""), "a * b * c").log.length === 0);
  t.ok("空のコード・空の太字・エスケープした区切りは整えない", typeAll(st(""), "``").log.length === 0 && typeAll(st(""), "****").log.length === 0 && typeAll(st(""), "\\*a*").log.length === 0);
  r = typeAll(st(""), "```");
  t.ok("行頭の ``` でコードブロック（閉じも足す・キャレットは開きの行の末尾）", md(r.s) === "```\n\n```" && kinds(r.s) === "code,code,code,p*" && at(r.s) === "0:3");
  t.ok("フェンスの中では整えない", typeAll({ blocks: doc("```\n\n```"), sel: caret(1, 0) }, "**a**").log.length === 0);
  t.ok("複数選択（範囲）のときは整えない・平文（シェルの形）のときは整えない",
    applyTriggers({ blocks: doc("# "), sel: { s: { b: 0, v: 0 }, e: { b: 0, v: 1 } } }, " ") === null && applyTriggers(type(st(""), " ").typed, " ", { plain: true }) === null);

  // ------------------------------------------------------------ 元に戻す
  const h = createHistory({ now: () => 0 });
  let cur = st("");
  h.reset(cur);
  const play = (text) => { for (const ch of text) { const rr = type(cur, ch); if (rr.trig) { h.push(rr.typed, "type"); cur = rr.trig.state; h.push(cur, "format"); } else { cur = rr.typed; h.push(cur, "type"); } } };
  play("# Hi");
  t.ok("整えた後の文字を打つと、元に戻すはその文字から", md(cur) === "# Hi" && md(h.undo()) === "# ");
  const symbols = h.undo();
  t.ok("もう一度で、整える前の記号のまま（行の種類は本文。勝手に見出しに戻らない）", md(symbols) === "# " && kinds(symbols) === "p");
  const redone = h.redo();
  t.ok("やり直しで整えた状態へ", kinds(redone) === "h" && md(h.redo()) === "# Hi");
  t.ok("戻した後に打つと、やり直しの先は捨てる", (() => { h.undo(); h.push(st("x"), "type"); return h.redo() === null; })());
  const h2 = createHistory({ now: (() => { let n = 0; return () => (n += 100); })() });
  h2.reset(st(""));
  for (const ch of "abc") { const s = st("abc".slice(0, "abc".indexOf(ch) + 1), 0, "abc".indexOf(ch) + 1); h2.push(s, "type"); }
  t.ok("続けて打った字は 1 つの戻す単位にまとめる（同じ行・1 秒以内）", h2.size === 2, String(h2.size));
  const h3 = createHistory({ now: (() => { let n = 0; return () => (n += 5000); })() });
  h3.reset(st(""));
  h3.push(st("a", 0, 1), "type"); h3.push(st("ab", 0, 2), "type");
  t.ok("間が空けば別の単位", h3.size === 3);

  // ------------------------------------------------------------ Enter
  let s = enter(st("- a", 0, 3));
  t.ok("箇条書きの Enter は次の行も箇条書き・番号は 1 つ進む・空の項目で抜ける", md(s) === "- a\n- " && at(s) === "1:0" && md(enter(st("1. a", 0, 4))) === "1. a\n2. "
    && md(enter(st("- a\n- ", 1, 0))) === "- a\n" && kinds(enter(st("- a\n- ", 1, 0))) === "ul,p");
  t.ok("引用の Enter は引用のまま・見出しの Enter は本文の行", md(enter(st("> a", 0, 3))) === "> a\n> " && kinds(enter(st("## a", 0, 4))) === "h,p");
  t.ok("行の途中の Enter は割る（書式は引き継ぐ）", md(enter(st("**ab**", 0, 1))) === "**a**\n**b**" && md(enter(st("- ab", 0, 1))) === "- a\n- b");
  t.ok("見出しの頭の Enter は上に空行を足す", md(enter(st("## a", 0, 0))) === "\n## a");
  const code = st("```\nx = 1\n```", 1, 3);
  t.ok("コードの Enter は次のコード行（字下げを引き継ぐ）・閉じフェンスの末尾の Enter で抜ける",
    md(enter({ blocks: doc("```\n  a\n```"), sel: caret(1, 3) })) === "```\n  a\n  \n```" && kinds(enter({ blocks: code.blocks, sel: caret(2, 3) })) === "code,code,code,p");
  t.ok("添付の入っていない pad は Enter で本物の行になる（空行を重ねない）", (() => {
    const x = enter({ blocks: insertAtom(st("a", 0, 1), newAtom({ path: P })).blocks, sel: caret(1, 0) });
    return kinds(x) === "p,att,p" && at(x) === "2:0";
  })());

  // ------------------------------------------------------------ Backspace / Delete
  t.ok("行頭の Backspace: 見出し・箇条書き・引用は本文に戻す（字は残る）", ["## a", "- a", "1. a", "> a"].every(l => { const x = backspaceAtStart(st(l, 0, 0)); return md(x) === "a" && kinds(x) === "p"; }));
  t.ok("本文の行頭の Backspace は前の行につなぐ（キャレットはつなぎ目）", (() => { const x = backspaceAtStart(st("ab\ncd", 1, 0)); return md(x) === "abcd" && at(x) === "0:2"; })());
  t.ok("添付の次の行頭の Backspace は、その添付を外す（本文はつながない）", (() => {
    const x = backspaceAtStart(st(`a\n[添付] ${P}\nb`, 2, 0));
    return md(x) === "a\nb" && kinds(x) === "p,p" && at(x) === "1:0" && atomKeys(x.blocks).size === 0;
  })());
  t.ok("行末の Delete は次の行をつなぐ・次が添付ならその添付を外す", md(deleteAtEnd(st("ab\ncd", 0, 2))) === "abcd" && md(deleteAtEnd(st(`a\n[添付] ${P}\nb`, 0, 1))) === "a\nb");
  t.ok("行をまたぐ選択の削除: 最初の行の頭と最後の行の後ろをつなぐ・全部消せば空の本文の行", (() => {
    const a = deleteSelection({ blocks: doc("abc\ndef\nghi"), sel: { s: { b: 0, v: 1 }, e: { b: 2, v: 2 } } });
    const all = deleteSelection({ blocks: doc("# a\n- b"), sel: { s: { b: 0, v: 0 }, e: { b: 1, v: 1 } } });
    return md(a) === "ai" && at(a) === "0:1" && md(all) === "" && kinds(all) === "p";
  })());
  t.ok("選択の中の添付も消える", (() => { const x = deleteSelection({ blocks: doc(`a\n[添付] ${P}\nb`), sel: { s: { b: 0, v: 0 }, e: { b: 2, v: 1 } } }); return md(x) === "" && atomKeys(x.blocks).size === 0; })());

  // ------------------------------------------------------------ 添付（原子）
  const atom = newAtom({ path: P, locale: "ja" });
  t.ok("空の行に入れると、その行を添付に置き換える（次の行にキャレット・末尾なら pad を足す）", (() => {
    const x = insertAtom(st(""), atom);
    return md(x) === `[添付] ${P}` && kinds(x) === "p*,att,p*" && at(x) === "2:0";
  })());
  t.ok("行の途中に入れると前後に割る（後ろの行は同じ種類）", (() => {
    const x = insertAtom(st("- abcd", 0, 2), atom);
    return md(x) === `- ab\n[添付] ${P}\n- cd` && kinds(x) === "ul,att,ul" && at(x) === "2:0";
  })());
  t.ok("行末・行頭・コードの中（閉じの後ろ）", (() => {
    const end = insertAtom(st("ab", 0, 2), atom), head = insertAtom(st("ab", 0, 0), atom);
    const inCode = insertAtom({ blocks: doc("```\nx\n```\nafter"), sel: caret(1, 1) }, atom);
    return md(end) === `ab\n[添付] ${P}` && md(head) === `[添付] ${P}\nab` && md(inCode) === `\`\`\`\nx\n\`\`\`\n[添付] ${P}\nafter`;
  })());
  t.ok("続けて入れると隙間の無い並び（間に本文の行を挟まない）", (() => {
    let x = insertAtom(st(""), newAtom({ path: P }));
    x = insertAtom(x, newAtom({ path: Q }));
    return md(x) === `[添付] ${P}\n[添付] ${Q}` && kinds(x).replace(/\*/g, "") === "p,att,att,p";
  })());
  t.ok("pad は Markdown に出ない（読み直しても文字が変わらない）", (() => {
    const x = insertAtom(st("a", 0, 1), atom);
    return md(x) === `a\n[添付] ${P}` && md({ blocks: doc(md(x)) }) === md(x) && x.blocks.at(-1).pad === true;
  })());
  t.ok("送っている途中の添付（仮の ID）は Markdown に出ない・キーは i:ID", (() => {
    const x = insertAtom(st("a", 0, 1), newAtom({ pid: "u1" }));
    return md(x) === "a" && [...atomKeys(x.blocks)].join() === "i:u1";
  })());
  t.ok("添付を外す（条件）・同じパスは 1 つのキー", (() => {
    const x = removeAtoms(st(`a\n[添付] ${P}\n[添付] ${Q}\nb`), b => b.path === P);
    return md(x) === `a\n[添付] ${Q}\nb` && [...atomKeys(x.blocks)].join() === `p:${normalizeAttachmentPath(Q)}`;
  })());

  // ------------------------------------------------------------ 貼り付け・コピー
  t.ok("1 行の貼り付けは今の行へ（記法は整える）", md(pasteText(st("ab", 0, 1), "**x**")) === "a**x**b" && pasteText(st("ab", 0, 1), "**x**").blocks[0].runs.some(x => x.marks.length));
  t.ok("複数行は行ごとに分類・空の行なら置き換え・行の途中なら前後をつなぐ", (() => {
    const a = pasteText(st(""), "# H\n- a\n- b");
    const b = pasteText(st("xy", 0, 1), "1\n2\n3");
    return md(a) === "# H\n- a\n- b" && kinds(a) === "h,ul,ul" && md(b) === "x1\n2\n3y" && at(b) === "2:1";
  })());
  t.ok("貼り付けた添付の印は、結び付く添付があれば原子・コードの中では文字のまま", (() => {
    const a = pasteText(st(""), `a\n[添付] ${P}\nb`, { resolve });
    const b = pasteText({ blocks: doc("```\n\n```"), sel: caret(1, 0) }, `[添付] ${P}\nx`, { resolve });
    return kinds(a).replace(/\*/g, "") === "p,att,p" && kinds(b).replace(/\*/g, "") === "code,code,code,code,p" && md(b).includes(`[添付] ${P}`) && atomKeys(b.blocks).size === 0;
  })());
  t.ok("コピーは Markdown（全部入る強調は区切りごと・一部だけなら区切りは付けない・行は記号ごと）", (() => {
    const s0 = { blocks: doc("a **bold** c\n- item"), sel: { s: { b: 0, v: 0 }, e: { b: 1, v: 4 } } };
    const mid = { blocks: doc("a **bold** c"), sel: { s: { b: 0, v: 3 }, e: { b: 0, v: 5 } } };
    const whole = { blocks: doc("a **bold** c"), sel: { s: { b: 0, v: 2 }, e: { b: 0, v: 6 } } };
    return selectionMarkdown(s0) === "a **bold** c\n- item" && selectionMarkdown(mid) === "ol" && selectionMarkdown(whole) === "**bold**" && sliceRaw(parseInline("**ab**"), 0, 1) === "a";
  })());

  // ------------------------------------------------------------ 書式バー
  t.ok("選択に太字を付ける・すべて付いていれば外す・コードは他の印を外す・リンクは URL を持つ", (() => {
    const sel = { s: { b: 0, v: 2 }, e: { b: 0, v: 4 } };
    const bold = toggleMark({ blocks: doc("abcdef"), sel }, "strong");
    const off = toggleMark(bold, "strong");
    const link = toggleMark({ blocks: doc("abcdef"), sel }, "link", { url: "http://x.y" });
    return md(bold) === "ab**cd**ef" && md(off) === "abcdef" && marksInRange(bold).has("strong") && md(link) === "ab[cd](http://x.y)ef"
      && md(toggleMark({ blocks: doc("a**b**c"), sel: { s: { b: 0, v: 0 }, e: { b: 0, v: 3 } } }, "code")) === "`abc`";
  })());
  t.ok("範囲が行をまたぐ・空のときは何もしない", md(toggleMark({ blocks: doc("a\nb"), sel: { s: { b: 0, v: 0 }, e: { b: 1, v: 1 } } }, "strong")) === "a\nb"
    && md(toggleMark(st("abc", 0, 1), "strong")) === "abc");

  // ------------------------------------------------------------ 位置の対応（selectionStart / End・スキル候補）
  const layout = doc("# H\n**ab**cd\n- x");
  t.ok("見える位置 → 文字列の位置（記号・区切りを数える）", posToOffset(layout, { b: 0, v: 1 }) === 3 && posToOffset(layout, { b: 1, v: 1 }) === 7, String(posToOffset(layout, { b: 1, v: 1 })));
  t.ok("文字列の位置 → 見える位置（記号の中は手前の文字へ寄せる）と往復", (() => {
    const back = offsetToPos(layout, posToOffset(layout, { b: 1, v: 3 }));
    const inMarker = offsetToPos(layout, 0);
    return back.b === 1 && back.v === 3 && inMarker.b === 0 && inMarker.v === 0;
  })());
  t.ok("送っていない添付・空の pad は文字列に無い（位置が詰まる）", (() => {
    const x = insertAtom(st("a", 0, 1), newAtom({ pid: "u1" }));
    return posToOffset(x.blocks, { b: 1, v: 0 }) === 1 && docToMarkdown(x.blocks) === "a";
  })());
  // 長い下書きで 1 打鍵ごとに全体を計算し直さないための使い回し（web/md-editor.mjs が、変わらないブロックの分を使い回す）
  t.ok("docLayout に memo を渡しても結果は同じで、変わらないブロックは使い回す", (() => {
    const blocks = doc("# H\n**ab**cd\n- x");
    const memo = new WeakMap();
    const a = docLayout(blocks, memo), b = docLayout(blocks);
    const same = JSON.stringify(a) === JSON.stringify(b);
    const first = memo.get(blocks[1]);
    const replaced = blocks.slice(); replaced[1] = doc("**ab**cdX")[0];
    const c = docLayout(replaced, memo);
    return same && memo.get(blocks[1]) === first && c.lines[1].raw === "**ab**cdX" && c.lines[2].start === a.lines[2].start + 1 && JSON.stringify(c.lines[0].map) === JSON.stringify(a.lines[0].map);
  })());
  t.ok("posToOffset・offsetToPos は計算済みの layout を渡しても同じ", (() => {
    const blocks = doc("# H\n**ab**cd\n- x"), lay = docLayout(blocks);
    return posToOffset(blocks, { b: 1, v: 3 }, lay) === posToOffset(blocks, { b: 1, v: 3 }) && JSON.stringify(offsetToPos(blocks, 9, lay)) === JSON.stringify(offsetToPos(blocks, 9));
  })());
  t.ok("memoRaw は同じブロックの raw を使い回し、normalizeFences に渡しても結果は同じ", (() => {
    const cache = new WeakMap(), raw = memoRaw(cache);
    const a = doc("x\n```\ny\n```"), b = doc("x\n```\ny\n```");
    const c1 = normalizeFences(a, { resolve, raw }), c2 = normalizeFences(b, { resolve });
    return raw(a[0]) === "x" && cache.has(a[0]) && c1 === c2 && JSON.stringify(a) === JSON.stringify(b);
  })());
  t.ok("履歴はブロックを共有しても、配列の差し替えに影響されない（元に戻すで前の状態が返る）", (() => {
    const hh = createHistory({ now: () => 0 });
    hh.reset(st("a\nb"));
    const s1 = st("a\nbX", 1, 2);
    hh.push(s1, "edit");
    s1.blocks[1] = doc("changed")[0];   // 積んだ後に配列の要素を差し替えても、履歴の中の並びは変わらない
    const back = hh.undo(), fwd = hh.redo();
    return md(back) === "a\nb" && md(fwd) === "a\nbX";
  })());
  t.ok("同じ文書を積み直しても増えない（同じブロックは参照で同じと見る）", (() => {
    const hh = createHistory({ now: () => 0 });
    const s1 = st("a\nb");
    hh.reset(s1);
    return hh.push({ blocks: s1.blocks.slice(), sel: caret(1, 1) }, "type") === false && hh.size === 1;
  })());
  t.ok("ensureShape: 先頭・末尾が添付なら pad を足す・閉じたコードの後ろにも足す", (() => {
    const a = ensureShape([{ kind: "att", marker: "", runs: [], raw: `[添付] ${P}`, path: P }]);
    const c = ensureShape(doc("```\nx\n```"));
    return a.length === 3 && a[0].pad && a.at(-1).pad && c.at(-1).pad === true;
  })());
  t.ok("insertText は選択を消して字を入れる・insertPlain は書式を引き継がない", (() => {
    const x = insertText({ blocks: doc("a**b**c"), sel: { s: { b: 0, v: 1 }, e: { b: 0, v: 2 } } }, "X");
    const y = insertPlain({ blocks: doc("**b**"), sel: caret(0, 1) }, "X");
    return md(x) === "aXc" && md(y) === "**b**X" && runsLength(x.blocks[0].runs) === 3;
  })());

  // ------------------------------------------------------------ 貼り付けの HTML（pasteRich。web/html-paste.mjs の結果を入れる。ADR 0141）
  const pAtom = (pid) => ({ atom: newAtom({ pid }) });
  const rich = (md0, b, v, parts) => pasteRich(st(md0, b, v), parts, { resolve });
  t.ok("pasteRich: 1 行のふつうの字は今の行へ（記法は整える・字の途中でも）", (() => {
    const r = rich("ab", 0, 1, [{ md: "**x**" }]);
    return md(r) === "a**x**b" && r.blocks.length === 1 && r.blocks[0].runs.some(x => x.marks.some(m => m.t === "strong"));
  })());
  t.ok("pasteRich: 見出し 1 行は、空の行を見出しの行に置き換える（記号の字のまま入れない）", (() => {
    const r = rich("", 0, 0, [{ md: "## 題" }]);
    return md(r) === "## 題" && r.blocks[0].kind === "h" && r.blocks.length === 1;
  })());
  t.ok("pasteRich: 行の途中に貼る見出し・リストは、次の行から始める（前の字につなげない）。後ろの字は最後の行へ", (() => {
    const r = rich("前後", 0, 1, [{ md: "## 題" }, { md: "- a" }]);
    return md(r) === "前\n## 題\n- a後" && kinds(r) === "p,h,ul";
  })());
  t.ok("pasteRich: 先頭がふつうの段落なら今の行につなぐ", (() => {
    const r = rich("前後", 0, 1, [{ md: "一" }, { md: "二" }]);
    return md(r) === "前一\n二後" && r.sel.s.b === 1 && r.sel.s.v === 1;
  })());
  t.ok("pasteRich: 文・添付・文を、位置どおりの行にする（添付は pid の仮の札）。選択は消してから", (() => {
    const r = pasteRich({ blocks: doc("A選択B"), sel: { s: { b: 0, v: 1 }, e: { b: 0, v: 3 } } }, [{ md: "前" }, pAtom("p1"), { md: "後" }], { resolve });
    return kinds(r) === "p,att,p" && r.blocks[1].pid === "p1" && md(r) === "A前\n後B" && atomKeys(r.blocks).has("i:p1");
  })());
  t.ok("pasteRich: 画像が連続しても札は隣り合う（間に空行を足さない）・先頭・末尾の札には pad が付く", (() => {
    const r = rich("", 0, 0, [pAtom("a"), pAtom("b"), pAtom("c")]);
    return kinds(r) === "p*,att,att,att,p*" && md(r) === "";
  })());
  t.ok("pasteRich: コードの行はコードのまま（フェンスの中の空行・字下げ）。リスト・引用・表は平文の行の規則どおり", (() => {
    const r = rich("", 0, 0, [{ md: "```sh" }, { md: "a" }, { md: "" }, { md: "  b" }, { md: "```" }, { md: "> 引" }, { md: "| a | b |" }]);
    return kinds(r) === "code,code,code,code,code,quote,p" && md(r) === "```sh\na\n\n  b\n```\n> 引\n| a | b |";
  })());
  t.ok("pasteRich: 空の並びは何も変えない", md(rich("x", 0, 1, [])) === "x");

  // ---- 取れなかった画像の札を何も残さず外す（removeAtomsTidy・history.rewrite）
  t.ok("removeAtomsTidy: 札を外すと、札の隣だった余白の行も残らない（途中の字は残る）", (() => {
    const start = pasteRich(st("", 0, 0), [{ md: "前" }, pAtom("x"), { md: "後" }], { resolve });
    const tail = pasteRich(st("", 0, 0), [{ md: "字" }, pAtom("y")], { resolve });
    const only = pasteRich(st("", 0, 0), [pAtom("z")], { resolve });
    const a = removeAtomsTidy(start, (b) => b.pid === "x"), b = removeAtomsTidy(tail, (b) => b.pid === "y"), c = removeAtomsTidy(only, (b) => b.pid === "z");
    return md(a) === "前\n後" && kinds(a) === "p,p" && md(b) === "字" && kinds(b) === "p" && kinds(c) === "p" && c.sel.s.b === 0;
  })());
  t.ok("removeAtomsTidy: 閉じたコードの後ろの pad・ほかの札の隣の pad は残す", (() => {
    const s = pasteRich(st("", 0, 0), [{ md: "```" }, { md: "x" }, { md: "```" }, pAtom("q"), pAtom("r")], { resolve });
    const r = removeAtomsTidy(s, (b) => b.pid === "q");
    return kinds(r) === "code,code,code,att,p*" && atomKeys(r.blocks).has("i:r");
  })());
  t.ok("history.rewrite: 札を履歴のすべての状態から消し、同じになった記録は畳む。位置は同じ記録を指す", (() => {
    const hh = createHistory({ now: () => 0 });
    const s0 = st("", 0, 0);
    hh.reset(s0);
    const pasted = pasteRich(s0, [{ md: "前" }, pAtom("x"), { md: "後" }], { resolve });
    hh.push(pasted, "paste");
    const typed = insertText({ blocks: pasted.blocks, sel: caret(2, 1) }, "字");
    hh.push(typed, "type");
    const gone = (state) => removeAtomsTidy(state, (b) => b.pid === "x");
    hh.rewrite(gone);
    const now = hh.undo();   // 打つ前 = 貼った直後（札は無い）
    const first = hh.undo(), none = hh.undo();
    return md(now) === "前\n後" && md(first) === "" && none === null && hh.size === 3 && hh.canRedo && md(hh.redo()) === "前\n後" && md(hh.redo()) === "前\n後字";
  })());
  t.ok("history.rewrite: 札だけの貼り付けは、外すと貼る前と同じになり、記録は畳まれる（元に戻すで何も起きない記録を残さない）", (() => {
    const hh = createHistory({ now: () => 0 });
    const s0 = st("", 0, 0);
    hh.reset(s0);
    hh.push(pasteRich(s0, [pAtom("x")], { resolve }), "paste");
    hh.rewrite((state) => removeAtomsTidy(state, (b) => b.pid === "x"));
    return hh.size === 1 && !hh.canUndo && !hh.canRedo;
  })());

  // ------------------------------------------------------------ 箇条書き・引用の続き（承認済み 2026-10-09: docs/design-system.md）
  t.ok("・ • ･ の行は Enter で同じ字のまま続く（種類は本文のまま・本文は打ったとおり）", ["・", "•", "･"].every(c => {
    const s = enter(st(`${c}りんご`, 0, 4));
    return md(s) === `${c}りんご\n${c}` && kinds(s) === "p,p" && at(s) === `1:${c.length}` && md(enter(st(`${c} りんご`, 0, 5))) === `${c} りんご\n${c} `;
  }));
  t.ok("・ の空の項目で Enter すると字が消えて抜ける・字の手前の Enter は普通の行", md(enter(st("・a\n・", 1, 1))) === "・a\n" && at(enter(st("・a\n・", 1, 1))) === "1:0"
    && md(enter(st("・a", 0, 0))) === "\n・a");
  t.ok("・ を打っただけでは変換しない（半角の記号とは違い、打った直後の整形なし）", applyTriggers(st("・", 0, 1), " ") === null && applyTriggers(st("・ ", 0, 2), " ") === null
    && kinds(st("・a")) === "p");
  t.ok("行の途中の ・ の Enter は右を次の行へ（・ を付けて）", md(enter(st("・ab", 0, 2))) === "・a\n・b");
  t.ok("全角の ＞ も引用・入れ子の深さを数える（往復で文字は変わらない）", kinds(st("＞ a")) === "quote" && quoteDepth("> ＞ ") === 2 && md(st("＞ a\n> ＞ b")) === "＞ a\n> ＞ b");
  t.ok("入れ子の引用の Enter は同じ深さで続く・空の行は 1 段戻り、最後の 1 段で抜ける", (() => {
    const a = enter(st("> > a", 0, 5));
    const b = enter({ blocks: a.blocks, sel: caret(1, 0) });
    const c = enter({ blocks: b.blocks, sel: caret(1, 0) });
    return md(a) === "> > a\n> > " && md(b) === "> > a\n> " && kinds(b) === "quote,quote" && md(c) === "> > a\n" && kinds(c) === "quote,p";
  })());
  t.ok("引用の行頭で ＞ か > を打つと 1 段深くなる・行頭の ＞ は引用になる（> に直す）", (() => {
    const run = (text) => ({ text, marks: [] });
    const deep = applyTriggers({ blocks: [{ kind: "quote", marker: "> ", runs: [run("> ")] }], sel: caret(0, 2) }, " ");
    const none = applyTriggers({ blocks: [{ kind: "quote", marker: "> ", runs: [run("a >")] }], sel: caret(0, 3) }, " ");
    const wide = applyTriggers({ blocks: [{ kind: "p", marker: "", runs: [run("＞ ")] }], sel: caret(0, 2) }, " ");
    return deep?.kind === "block" && md(deep.state) === "> > " && none === null && md(wide.state) === "> " && kinds(wide.state) === "quote";
  })());
  t.ok("チェック欄: [ ] も [x] も次の項目は [ ] から・空の [ ] で抜ける・字下げは 1 段戻る", (() => {
    const a = enter(st("- [ ] 牛乳", 0, 8));
    const b = enter(st("- [x] パン", 0, 8));
    const c = enter({ blocks: a.blocks, sel: caret(1, 4) });
    const d = enter({ blocks: doc("- a\n  - [ ] "), sel: caret(1, 4) });
    return md(a) === "- [ ] 牛乳\n- [ ] " && at(a) === "1:4" && md(b) === "- [x] パン\n- [ ] " && md(c) === "- [ ] 牛乳\n" && kinds(c) === "ul,p"
      && md(d) === "- a\n- [ ] " && at(d) === "1:4";
  })());
  t.ok("チェック欄の途中は [ ] を付けて割る・[ ] の中の Enter は付けずに割る", md(enter(st("- [ ] ab", 0, 5))) === "- [ ] a\n- [ ] b" && md(enter(st("- [ ] ab", 0, 2))) === "- [ \n- ] ab");
  t.ok("Tab: 箇条書き・番号の行だけ 1 段深くなる（番号は 1 から）・最深・本文の行・最上段の Shift+Tab は null", (() => {
    const a = indentList(st("- a\n- b", 1, 1), 1);
    const o = indentList(st("1. a\n2. b", 1, 1), 1);
    const back = indentList({ blocks: a.blocks, sel: caret(1, 1) }, -1);
    const deepest = st("        - x", 0, 0);
    return md(a) === "- a\n  - b" && at(a) === "1:1" && md(o) === "1. a\n  1. b" && md(back) === "- a\n- b"
      && indentLevel("        - x") === 4 && indentList(deepest, 1) === null && indentList(st("a"), 1) === null && indentList(st("- a"), -1) === null && indentList(st("> q"), 1) === null;
  })());
  t.ok("Tab は選択にかかる行をまとめて動かし、番号を数え直す", (() => {
    const s = { blocks: doc("1. a\n2. b\n3. c"), sel: { s: { b: 1, v: 0 }, e: { b: 2, v: 1 } } };
    return md(indentList(s, 1)) === "1. a\n  1. b\n  2. c";
  })());
  t.ok("番号: Enter・削除・字下げで数え直す（先頭の数に従う・同じ段の並びだけ・貼り付けは触らない）", (() => {
    const mid = enter(st("1. a\n2. b\n3. c", 0, 4));
    const del = backspaceAtStart({ blocks: doc("1. a\n2. b\n3. c"), sel: caret(1, 0) });
    const del2 = deleteAtEnd(st("1. a\n2. \n3. c", 1, 0));
    const start = enter(st("5. a\n6. b", 0, 4));
    const sub = renumber(doc("1. a\n  1. x\n  5. y\n2. b"));
    const split = doc("1. a\n- x\n7. b");
    renumber(split);
    const pasted = pasteText(st("", 0, 0), "1. a\n3. b\n9. c", { resolve });
    return md(mid) === "1. a\n2. \n3. b\n4. c" && md(del) === "1. a\nb\n3. c" && md(del2) === "1. a\n2. c" && md(start) === "5. a\n6. \n7. b"
      && sub === true && docToMarkdown(split) === "1. a\n- x\n7. b" && md(pasted) === "1. a\n3. b\n9. c";
  })());
  t.ok("番号: 深い段は同じ段の並びの中だけ数える・浅い段が来たら閉じ、その後の深い段は自分の最初の数から", (() => {
    const blocks = doc("1. a\n  1. x\n  3. y\n2. b\n  3. z");
    const changed = renumber(blocks);
    return changed && docToMarkdown(blocks) === "1. a\n  1. x\n  2. y\n2. b\n  3. z";
  })());
  t.ok("Shift+Enter: 箇条書き・番号は項目の中の改行（字下げした続きの行・往復で文字は変わらない）", (() => {
    const a = enter(st("- ab", 0, 3), { soft: true });
    const b = enter(st("1. ab", 0, 5), { soft: true });
    const c = enter(st("  - ab", 0, 5), { soft: true });
    return md(a) === "- ab\n  " && kinds(a) === "ul,cont" && at(a) === "1:0" && md(b) === "1. ab\n  " && md(c) === "  - ab\n    " && kinds(c) === "ul,cont"
      && kinds(st("- ab\n  c")) === "ul,cont" && md(st("- ab\n  c\n  d")) === "- ab\n  c\n  d" && kinds(st("- ab\n  c\n  d")) === "ul,cont,cont" && kinds(st("a\n  c")) === "p,p";
  })());
  t.ok("続きの行の Enter は次の項目（親と同じ記号・番号は進む）・空の続きの行の Enter は抜ける・Shift+Enter はもう 1 行", (() => {
    const next = enter({ blocks: doc("1. ab\n  cd"), sel: caret(1, 2) });
    const out = enter({ blocks: enter(st("- ab", 0, 3), { soft: true }).blocks, sel: caret(1, 0) });
    const more = enter({ blocks: doc("- ab\n  cd"), sel: caret(1, 2) }, { soft: true });
    return md(next) === "1. ab\n  cd\n2. " && kinds(next) === "ol,cont,ol" && md(out) === "- ab\n" && kinds(out) === "ul,p" && md(more) === "- ab\n  cd\n  " && kinds(more) === "ul,cont,cont";
  })());
  t.ok("Shift+Enter: 引用は引用のまま続く（空で Enter すると抜ける）・本文の行は普通の改行", (() => {
    const q = enter(st("> a", 0, 3), { soft: true });
    const p = enter(st("ab", 0, 1), { soft: true });
    return md(q) === "> a\n> " && kinds(q) === "quote,quote" && md(p) === "a\nb" && kinds(p) === "p,p" && md(enter({ blocks: q.blocks, sel: caret(1, 0) })) === "> a\n";
  })());
  t.ok("続きの行の行頭の Backspace は本文の行に戻る", kinds(backspaceAtStart({ blocks: doc("- a\n  b"), sel: caret(1, 0) })) === "ul,p");
  t.ok("平文の間（plain）は今までどおり記号を続けない", md(enter(st("- a", 0, 3), { plain: true })) === "- a\n" && kinds(enter(st("・a", 0, 2), { plain: true })) === "p,p"
    && md(enter(st("・a", 0, 2), { plain: true })) === "・a\n");
}
