// 脇の検索の、手元で即座に出す部分（web/session-find.mjs）。照合の規則は core/session-search.mjs と同じでなければならない
// （手元の結果とサーバーの結果で、行が現れたり消えたりしないように）。同じ入力を両方に通して揃いを確かめる。
import { parseTerms, placeName, findRanges, matchLocal, localOrder, periodSince, pushRecentSearch, isSearchShortcut, searchShortcutLabel } from "../../web/session-find.mjs";
import * as core from "../../core/session-search.mjs";

export const name = "session-find";
export const title = "脇の検索の手元の照合: core と同じ規則・期間・最近の検索・近道";

const DAY = 86_400_000;

export default async function (t) {
  const queries = ["ci", "ＣＩ", "有料 翻訳", '"E2E_PORT_OFFSET"', '"e2e_port_offset"', "dev", "vtc-web", "進行中 gateway", 'foo "bar baz', '"" a a "a"', "ｶﾞｲﾄﾞ", "  ", "gateway  ログ"];
  t.ok("検索語の解釈が core の parseQuery と同じ", queries.every((q) => JSON.stringify(parseTerms(q)) === JSON.stringify(core.parseQuery(q))), queries.filter((q) => JSON.stringify(parseTerms(q)) !== JSON.stringify(core.parseQuery(q))).join("|"));
  t.ok("場所はフォルダー名（core と同じ）", ["D:\dev\pleiad\\", "/home/u/dev/app", "", null, "single"].every((p) => placeName(p) === core.placeName(p)));

  // 題・状態・場所だけの照合は、core の matchSession（発言なし）と同じ当たり方
  const sessions = [
    { title: "gateway のログが重複する", status: "進行中", cwd: "D:\dev\vtc-web" },
    { title: "有料モードの切り替え", status: "レビュー待ち", cwd: "D:\dev\vtc-web" },
    { title: "E2E_PORT_OFFSET の話", status: null, cwd: "D:\dev\pleiad" },
    { title: "ＣＩ の設定", status: "完了", cwd: "/home/u/dev/app" },
    { title: "ガイド", status: "完了", cwd: "D:\dev\homepage" },
    { title: "", status: null, cwd: null },
  ];
  const diffs = [];
  for (const q of queries) {
    const terms = core.parseQuery(q);
    for (const s of sessions) {
      const mine = matchLocal(s, parseTerms(q)) !== null;
      const theirs = terms.length ? core.matchSession(s, [], terms, { speaker: "any", toolInputs: false, hits: 1 }) !== null : true;
      if (terms.length && mine !== theirs) diffs.push(`${q} / ${s.title}`);
    }
  }
  t.ok("題・状態・場所の当たり方が core と同じ（全角半角・AND・\"…\"・場所はフォルダー名）", diffs.length === 0, diffs.join("; "));
  t.ok("語が無ければ当たりを返さない扱い（呼び出し側は語があるときだけ使う）", matchLocal(sessions[0], []) !== null);

  // 一致の範囲は元の文字の位置（畳むと長さが変わる文字があっても）
  const cases = [["gateway のログ", "GATEWAY"], ["ＣＩ の設定 ci", "ci"], ["ｶﾞｲﾄﾞ を読む", "ガイド"], ["Hello World", '"Hello World"'], ["Hello World", '"hello"'], ["abc … ABC", "abc"]];
  const same = cases.every(([text, q]) => {
    const terms = parseTerms(q);
    const folded = core.fold(text);
    return JSON.stringify(findRanges(text, terms)) === JSON.stringify(core.findRanges(text, folded, core.parseQuery(q)));
  });
  t.ok("一致の範囲が core の findRanges と同じ", same);
  t.ok("範囲は元の文字を指す（ＣＩ が ci に当たる）", (() => { const r = findRanges("ＣＩ の設定", parseTerms("ci")); return r.length === 1 && "ＣＩ の設定".slice(...r[0]) === "ＣＩ"; })());

  // 並び: 題に当たった語・新しさ（上限 3）・新しい順
  const now = Date.UTC(2026, 9, 3, 12);
  const row = (title, days, titleTerms, allInTitle) => ({ session: { title, lastModified: now - days * DAY }, titleTerms, allInTitle });
  const rows = [row("fresh body", 1, 0, false), row("old title", 400, 1, true), row("mid title", 30, 1, true)];
  t.ok("関連度: 題に当たった古い会話も、減点が頭打ちなので題に当たらない会話より先", localOrder(rows, "relevance", now).map((r) => r.session.title).join() === "mid title,old title,fresh body");
  t.ok("新しい順: lastModified の降順", localOrder(rows, "recent", now).map((r) => r.session.title).join() === "fresh body,mid title,old title");

  // 期間・最近の検索
  const at = Date.UTC(2026, 9, 3, 15, 30);
  t.ok("期間: 0 は絞らない・7 日と 30 日は今から遡る", periodSince(0, at) === null && periodSince(7, at) === at - 7 * DAY && periodSince(30, at) === at - 30 * DAY);
  const today = periodSince(1, at);
  t.ok("期間: 今日はローカルの 0 時から", new Date(today).getHours() === 0 && at - today < DAY && today <= at);
  let list = [];
  for (const q of ["a", "b", "c", "d", "e", "f", " a ", ""]) list = pushRecentSearch(list, q);
  t.ok("最近の検索: 5 件まで・同じ語は先頭へ寄せる・空は足さない", list.join() === "a,f,e,d,c", list.join());

  // 近道
  const ev = (o) => ({ key: "F", ctrlKey: false, metaKey: false, shiftKey: true, altKey: false, defaultPrevented: false, isComposing: false, ...o });
  t.ok("Ctrl+Shift+F（Windows・Linux）", isSearchShortcut(ev({ ctrlKey: true }), false) && isSearchShortcut(ev({ ctrlKey: true, key: "f" }), false));
  t.ok("⌘⇧F（macOS）。macOS の Ctrl+Shift+F は奪わない", isSearchShortcut(ev({ metaKey: true }), true) && !isSearchShortcut(ev({ ctrlKey: true }), true));
  t.ok("Ctrl+F（会話の中の検索）・Alt 付き・IME の変換中・止められた後は取らない",
    !isSearchShortcut(ev({ ctrlKey: true, shiftKey: false }), false) && !isSearchShortcut(ev({ ctrlKey: true, altKey: true }), false)
    && !isSearchShortcut(ev({ ctrlKey: true, isComposing: true }), false) && !isSearchShortcut(ev({ ctrlKey: true, defaultPrevented: true }), false));
  t.ok("近道の書き方", searchShortcutLabel(false) === "Ctrl+Shift+F" && searchShortcutLabel(true) === "⌘⇧F");
}
