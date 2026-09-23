// 入力欄の「/」でスキル候補を出す部分（web/slash-skills.mjs）。
//
// 見張りたいのは 3 つ。
//  1. 文中・複数スキル・カーソル位置で補完し、URL/パスでは開かない
//  2. 候補の並びと、確定したときに入る文字列（`/名前 ` まで）
//  3. 送信キーの扱い。候補が開いていても Ctrl+Enter は送信のまま
import { setupSlashSkills, parseQuery, filterSkills, matchRange } from "../../web/slash-skills.mjs";
import { el } from "../../web/dom.mjs";

export const name = "slash-skills";
export const title = "入力欄の / でスキル候補を出す";

const SKILLS = [
  { name: "visualize", description: "会話の中に図を出す", hint: "", from: "ユーザー" },
  { name: "code-review", description: "差分をレビューする", hint: "[PR番号]", from: "組み込み" },
  { name: "daily-report", description: "進捗報告の下書きを作る。レビュー観点も添える", hint: "<日付>", from: "プロジェクト" },
];

function mount({ cwd = "D:/work", load, now } = {}) {
  const input = el("textarea");
  input.value = "";
  input.setSelectionRange = (start, end) => { input.selectionStart = start; input.selectionEnd = end; };
  const list = el("ul", "clist");
  list.hidden = true;
  const hint = el("div", "slash-hint");
  const calls = [];
  const slash = setupSlashSkills({
    input, list, hint, cwd: () => cwd, now,
    load: async (key) => { calls.push(key); return load ? load(key) : SKILLS; },
  });
  const type = (value, caret = value.length) => { input.value = value; input.setSelectionRange(caret, caret); input.dispatchEvent({ type: "input" }); };
  const key = (k, mods = {}) => {
    let prevented = false;
    const taken = slash.keydown({ key: k, preventDefault: () => { prevented = true; }, ...mods });
    return { taken, prevented };
  };
  // load は async。マイクロタスクを流してから見る
  const settle = () => new Promise((r) => setTimeout(r, 0));
  const options = () => list.children.filter((c) => c.classList.contains("it"));
  return { input, list, hint, calls, slash, type, key, settle, options };
}

export default async function (t) {
  // ---- 出す条件（純関数）
  t.ok("/ だけのときは空の問い合わせ", parseQuery("/") === "");
  t.ok("/da は問い合わせ da", parseQuery("/da") === "da");
  t.ok("名前の後ろに空白が入ったら候補を出さない", parseQuery("/daily-report ") === null);
  t.ok("行の途中の / では出さない", parseQuery("見て /tmp/x") === null && parseQuery("a/b") === null);
  t.ok("空の入力では出さない", parseQuery("") === null && parseQuery(null) === null);
  t.ok("先頭の / の直後に / が来たら出さない", parseQuery("//x") === null);
  t.ok("文中・改行・日本語直後で候補を出す", parseQuery("これを /vi") === "vi"
    && parseQuery("これを/vi") === "vi" && parseQuery("調査\n/vi") === "vi");
  t.ok("複数のスキルの最後だけを検索する", parseQuery("/visualize と /co") === "co");
  t.ok("URL・パス・日付を候補にしない", ["https://example", "C:/work", "./foo", "../foo", "a/b", "9/14", "/tmp/x"].every(v => parseQuery(v) === null));
  t.ok("選択範囲があるときは補完しない", parseQuery("/code", 2, 5) === null);
  t.ok("名前の途中のカーソルで検索する", parseQuery("/code-review して", 3) === "co");

  // ---- 一致の範囲と並び
  t.ok("一致した範囲を返す", String(matchRange("daily-report", "rep")) === "6,9");
  t.ok("一致しなければ空", matchRange("daily-report", "zz").length === 0 && matchRange("daily", "").length === 0);

  const filt = filterSkills(SKILLS, "re");
  t.ok("名前の前方一致を先に並べる", filt.map((s) => s.name).join() === "code-review,daily-report",
    filt.map((s) => s.name).join());
  const byDesc = filterSkills(SKILLS, "図");
  t.ok("説明だけの一致も拾う", byDesc.length === 1 && byDesc[0].name === "visualize");
  const byName = filterSkills(SKILLS, "review");
  t.ok("名前の部分一致は説明の一致より先", byName.map((s) => s.name).join() === "code-review",
    byName.map((s) => s.name).join());
  t.ok("大文字小文字は区別しない", filterSkills(SKILLS, "VIS").map((s) => s.name).join() === "visualize");
  t.ok("空の問い合わせは全件（件数は絞らない）", filterSkills(SKILLS, "").length === SKILLS.length);

  // ---- 画面。作業ディレクトリごとに 1 回だけ取りに行く
  const m = mount();
  t.ok("最初は閉じている", m.list.hidden === true && m.slash.isOpen() === false);

  m.type("/");
  await m.settle();
  t.ok("作業ディレクトリを渡して候補を取りに行く", m.calls.join() === "D:/work", m.calls.join());
  t.ok("候補が開く", m.slash.isOpen() === true && m.list.hidden === false);
  t.ok("全件を出す", m.options().length === 3, String(m.options().length));
  t.ok("見出しに件数を出す", m.list.querySelector(".head").textContent === "スキル3");
  t.ok("aria を一致させる", m.input.getAttribute("aria-expanded") === "true"
    && m.input.getAttribute("aria-activedescendant") === "slash-option-0");
  const first = m.options()[0];
  t.ok("1 行目に /名前・引数・見つかった場所", first.querySelector(".name").textContent === "/visualize"
    && first.querySelector(".from").textContent === "ユーザー");
  t.ok("2 行目に説明", first.querySelector(".desc").textContent === "会話の中に図を出す");

  m.type("/re");
  await m.settle();
  t.ok("絞り込む（再取得しない）", m.calls.length === 1 && m.options().length === 2, m.calls.join());
  t.ok("一致した文字だけ印を付ける", m.options()[0].querySelector(".name").querySelector("b").textContent === "re");

  m.type("/zzz");
  await m.settle();
  t.ok("一致が無くても閉じない", m.slash.isOpen() === true && m.options().length === 0);
  t.ok("一致が無いと伝える", m.list.querySelector(".none").textContent === "一致するスキルがありません");

  // ---- 確定
  m.type("/re");
  await m.settle();
  const down = m.key("ArrowDown");
  t.ok("↓ で次の候補に移る", down.taken && down.prevented
    && m.input.getAttribute("aria-activedescendant") === "slash-option-1");
  const enter = m.key("Enter");
  t.ok("Enter で確定し、そのキーは他へ渡さない", enter.taken && enter.prevented);
  t.ok("名前の後ろに空白まで入る", m.input.value === "/daily-report ", JSON.stringify(m.input.value));
  t.ok("選んだ直後に引数の書き方を出す", m.hint.textContent === "引数  <日付>", m.hint.textContent);
  t.ok("確認後は閉じる", m.slash.isOpen() === false);
  t.ok("引数を打ち始めたらヒントを消す", (() => {
    m.type("/daily-report 9/14");
    return m.hint.textContent === "";
  })());
  t.ok("引数を打っている間は候補を出さない", m.slash.isOpen() === false);

  m.type("これを/vi");
  m.key("Enter");
  t.ok("日本語の前文を残して確定", m.input.value === "これを/visualize ");
  m.type(m.input.value + "と /co");
  m.key("Tab");
  t.ok("2つ目を確定しても1つ目と文章が残る", m.input.value === "これを/visualize と /code-review ");
  t.ok("文中でも引数ヒントが出る", m.hint.textContent === "引数  [PR番号]");
  m.type("前文 /co 後文 /visualize", 6);
  m.options()[0].onmousedown({ preventDefault() {} });
  t.ok("クリック確定も前後を保ち余分な空白を増やさない", m.input.value === "前文 /code-review 後文 /visualize");
  t.ok("カーソルは補完したスキルの直後", m.input.selectionStart === "前文 /code-review ".length);
  m.type("前文 /code-review 後文", 6);
  m.key("Tab");
  t.ok("名前の途中からの補完で古い語尾を残さない", m.input.value === "前文 /code-review 後文");
  m.type("/vi 後文");
  m.input.setSelectionRange(3, 3);
  m.input.dispatchEvent({ type: "keyup", key: "ArrowLeft" });
  t.ok("カーソルを戻した位置で候補が開く", m.slash.isOpen());
  m.input.setSelectionRange(6, 6);
  m.input.dispatchEvent({ type: "click" });
  t.ok("カーソルがスキルを離れると閉じる", !m.slash.isOpen());

  // ---- キーの扱い
  const m2 = mount();
  m2.type("/");
  await m2.settle();
  t.ok("Ctrl+Enter は候補が開いていても送信のまま", m2.key("Enter", { ctrlKey: true }).taken === false);
  t.ok("変換中のキーは取らない", m2.key("Enter", { isComposing: true }).taken === false);
  t.ok("Tab は確定に使う", (() => {
    m2.type("/code");
    return m2.key("Tab").taken && m2.input.value === "/code-review ";
  })(), m2.input.value);
  t.ok("Esc で閉じる", (() => {
    m2.type("/");
    const esc = m2.key("Escape");
    return esc.taken && m2.slash.isOpen() === false;
  })());
  t.ok("閉じたあとの ↓ は取らない", m2.key("ArrowDown").taken === false);
  let finishLoad;
  const delayed = mount({ load: () => new Promise(resolve => { finishLoad = resolve; }) });
  delayed.type("/");
  delayed.key("Escape");
  finishLoad(SKILLS);
  await delayed.settle();
  t.ok("読み込み中に閉じた候補を再表示しない", !delayed.slash.isOpen());

  // ---- 使い回しと取り直し
  let clock = 1000;
  const m3 = mount({ now: () => clock });
  m3.type("/");
  await m3.settle();
  m3.type("/v");
  m3.type("/");
  await m3.settle();
  t.ok("同じ作業ディレクトリの間は取り直さない", m3.calls.length === 1, m3.calls.join());
  clock += 61_000;
  m3.type("/v");
  await m3.settle();
  t.ok("古くなったら取り直す（編集中に足したスキルを拾う）", m3.calls.length === 2, m3.calls.join());

  // ---- 取得できないとき
  const m4 = mount({ load: async () => { throw new Error("落ちた"); } });
  m4.type("/");
  await m4.settle();
  t.ok("取れなかったことを出して、閉じない", m4.list.querySelector(".none").textContent === "スキル一覧を取得できませんでした"
    && m4.slash.isOpen() === true);
}
