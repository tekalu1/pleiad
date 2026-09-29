// 履歴を描く間、1 行足すたびに筋（#thread）の子孫を探し回らないこと（web/client.mjs の place）。
// 稼働表示の行を毎回 querySelector で探すと、件数 × DOM の量で伸びて、スマホで長い会話を開くのに数十秒かかった（issue #37）。
// 時間ではなく、筋への querySelector の回数が件数に比例しないことで見る。
import fs from "node:fs/promises";
import vm from "node:vm";

export const name = "place-scan";
export const title = "履歴を描く間、1 行ごとに筋を探し回らない（稼働表示の行は activity.el で持つ）";

export default async function (t) {
  const source = (await fs.readFile(new URL("../../web/client.mjs", import.meta.url), "utf8")).replaceAll("\r\n", "\n");
  const cut = name => {
    const start = source.indexOf(`function ${name}(`);
    return start < 0 ? "" : source.slice(start, source.indexOf("\n}", start) + 2);
  };
  t.ok("client.mjs から wrap・place・append を切り出せる", !!cut("wrap") && !!cut("place") && !!cut("append"));

  /** 筋の身代わり。子は配列で持ち、筋への querySelector の呼び出しを数える */
  const screen = () => {
    const rows = [];
    let queries = 0;
    const thread = {
      querySelector() { queries++; return null; },
      querySelectorAll() { queries++; return []; },
      append(w) { const i = rows.indexOf(w); if (i >= 0) rows.splice(i, 1); rows.push(w); },
    };
    // wrap が使うのは matches・classList・append・dataset だけ
    const el = (tag, cls = "") => {
      const classes = new Set(cls.split(" ").filter(Boolean));
      const e = {
        classes, dataset: {}, children: [], isConnected: true,
        classList: { add: c => classes.add(c), contains: c => classes.has(c) },
        matches(sel) {
          if (sel === ".m:not(.sys):not(.cont):not(.activity)") return classes.has("m") && !["sys", "cont", "activity"].some(c => classes.has(c));
          return sel.split(".").filter(Boolean).every(c => classes.has(c));
        },
        append(...xs) { e.children.push(...xs); },
        // 稼働表示の手前へ入れる
        before(x) { const j = rows.indexOf(x); if (j >= 0) rows.splice(j, 1); rows.splice(rows.indexOf(e), 0, x); },
        closest(sel) { return sel === ".mw" ? e.wrapper ?? null : null; },
      };
      return e;
    };
    const activity = { el: null };
    const context = vm.createContext({ thread, el, log: {}, atBottom: () => false, relayoutBranches() {}, state: { busy: true }, activity });
    vm.runInContext(`let paintingHistory = true;\n${cut("wrap")}\n${cut("place")}\n${cut("append")}\nthis.append = append;`, context);
    return { rows, el, activity, append: context.append, queries: () => queries };
  };

  const count = n => {
    const s = screen();
    for (let i = 0; i < n; i++) s.append(s.el("div", "m user"), `m:${i}`);
    return s.queries();
  };
  const few = count(50), many = count(500);
  t.ok("発言 50 件と 500 件で、筋への querySelector の回数が変わらない", many === few, `50 件 ${few} 回、500 件 ${many} 回`);
  t.ok("履歴を描く間、筋への querySelector は 1 件あたり 1 回未満", many < 500, `${many} 回`);

  // 稼働表示の行があるときは、新しい行がその手前に入る（稼働表示は常に一番下）
  const s = screen();
  const m = s.el("div", "m activity");
  const aw = s.append(m, "activity");
  m.wrapper = aw;
  s.activity.el = m;
  const first = s.append(s.el("div", "m user"), "m:0");
  const second = s.append(s.el("div", "m ai"), "m:1");
  t.ok("稼働表示の行があれば、あとから足した行はその手前に入る",
    s.rows.at(-1) === aw && s.rows.indexOf(first) < s.rows.indexOf(second) && s.rows.indexOf(second) < s.rows.indexOf(aw));
  t.ok("稼働表示の行があっても、筋の子孫は探さない", s.queries() === 0, `${s.queries()} 回`);

  // 外れた稼働表示（筋を作り直したあと）は無いものとして、末尾に足す
  m.isConnected = false;
  const third = s.append(s.el("div", "m ai"), "m:2");
  t.ok("外れた稼働表示は無いものとして、末尾に足す", s.rows.at(-1) === third);
}
