// 作業の詳細（読むだけの筋）を running の配信のたびに作り直しても、開いたツールの詳細・ツールのまとまり・長文の畳みが閉じない
// （web/view-state.mjs。client.mjs の refreshDetail が作り直す前に控え、画面に置く前に戻す）。
// 実ブラウザーでの動きは tests/browser/work-dialog-keep-open.cjs。
//
// DOM シムは tests/run.mjs が入口で入れている。
import { el } from "../../web/dom.mjs";
import { Bundle } from "../../web/tool-bundle.mjs";
import { renderToolCall } from "../../web/render.mjs";
import { mountFold } from "../../web/fold.mjs";
import { captureViewState, restoreViewState } from "../../web/view-state.mjs";

export const name = "view-state";
export const title = "作業の詳細の読み直し: 開いたツールの詳細・まとまり・畳みを作り直しの後も同じ所で開いたままにする";

/** 読むだけの筋の小さな作り直し。同じ履歴から作るたびに、新しい DOM ができる */
function thread({ extraCall = false } = {}) {
  const th = el("div", "thread bg-thread");
  const row = (key, ...nodes) => {
    const w = el("div", "mw");
    w.dataset.key = key;
    const body = el("div", "mw-body");
    body.append(...nodes);
    w.append(body);
    th.append(w);
    return w;
  };
  const call = (id, name = "Bash") => renderToolCall(name, { command: `run ${id}` }, { id });

  // m:0 = 依頼（長文の畳み）
  const request = el("div", "m user");
  const rest = el("div", "body");
  mountFold(request, rest);
  row("request", request);
  // m:1 = まとまり（3 件）と、その前に単独の 1 行
  const bundle = new Bundle();
  bundle.addAll([call("c2"), call("c3", "Read"), call("c4", "Grep")]);
  row("m:1", call("c1"), bundle.el);
  // m:2 = 別の発言の単独の行。同じ番号でも持ち主が違えば別の所
  row("m:2", call("c5"), ...(extraCall ? [call("c6")] : []));
  return { th, bundle, request, calls: (id) => th.querySelectorAll(".tc").find((c) => c.dataset.id === id) };
}

const isOpen = (card) => card.querySelector(".tc-details").hasAttribute("open");

export default async function (t) {
  // ---- 開いた所が、作り直した後も開いたまま
  {
    const before = thread();
    before.calls("c1").querySelector(".tc-details").open = true;           // 単独の行の詳細
    before.calls("c3").querySelector(".tc-details").open = true;           // まとまりの中の行の詳細
    before.bundle.toggleAll();                                              // まとまりを全部開く
    before.request.fold.open(false);                                        // 長文の畳みを開く
    const state = captureViewState(before.th);

    const after = thread();
    t.ok("作り直した直後は、どれも閉じている", !isOpen(after.calls("c1")) && !isOpen(after.calls("c3")) && !after.bundle.expanded && !after.request.fold.isOpen());
    restoreViewState(after.th, state);
    t.ok("単独の行の詳細が開いたまま", isOpen(after.calls("c1")));
    t.ok("まとまりの中の行の詳細が開いたまま", isOpen(after.calls("c3")));
    t.ok("まとまりが全部開いたまま（見出しの aria-expanded も）", after.bundle.expanded && after.bundle.head.getAttribute("aria-expanded") === "true"
      && after.bundle.el.querySelectorAll(".hi").every((w) => !w.classList.contains("hid")));
    t.ok("長文の畳みが開いたまま", after.request.fold.isOpen());
    t.ok("開けていない所は閉じたまま", !isOpen(after.calls("c2")) && !isOpen(after.calls("c4")) && !isOpen(after.calls("c5")));
  }

  // ---- 遡った範囲（k）も戻る
  {
    const before = thread();
    before.bundle.step(1);
    const after = thread();
    restoreViewState(after.th, captureViewState(before.th));
    const shown = after.bundle.el.querySelectorAll(".hi").filter((w) => !w.classList.contains("hid")).length;
    t.ok("1 件だけ遡った範囲が戻る（k=1・開いた行は 1 件）", after.bundle.k === 1 && !after.bundle.expanded && shown === 1, `k=${after.bundle.k} shown=${shown}`);
  }

  // ---- 利用者が閉じた所は、既定で開いて作られても閉じたまま
  {
    const before = thread();
    const state = captureViewState(before.th);       // どれも閉じている
    const after = thread();
    after.calls("c5").querySelector(".tc-details").open = true;
    restoreViewState(after.th, state);
    t.ok("控えが「閉じている」なら、作り直しが開いて作った所も閉じる", !isOpen(after.calls("c5")));
  }

  // ---- 履歴が増えても、既存の所は動かない
  {
    const before = thread();
    before.calls("c5").querySelector(".tc-details").open = true;
    const after = thread({ extraCall: true });
    restoreViewState(after.th, captureViewState(before.th));
    t.ok("増えた行（c6）は作ったまま閉じ、前からあった c5 は開いたまま", isOpen(after.calls("c5")) && !isOpen(after.calls("c6")));
  }

  // ---- 持ち主が違えば持ち越さない
  {
    const before = thread();
    before.calls("c1").querySelector(".tc-details").open = true;
    const other = thread();
    // 同じ位置のツールでも、ツールの id が違えば別の行
    for (const card of other.th.querySelectorAll(".tc")) card.dataset.id = `x-${card.dataset.id}`;
    restoreViewState(other.th, captureViewState(before.th));
    t.ok("ツールの id が違う行へは持ち越さない", other.th.querySelectorAll(".tc").every((c) => !isOpen(c)));
  }

  // ---- 入れ子の詳細（入力・出力の JSON の折りたたみ）は、ツール行ごとに数える
  {
    const before = thread();
    const json = before.calls("c2").querySelectorAll("details").find((d) => d.classList.contains("tc-json"));
    json.open = true;
    const after = thread();
    restoreViewState(after.th, captureViewState(before.th));
    const restored = after.calls("c2").querySelectorAll("details").find((d) => d.classList.contains("tc-json"));
    const other = after.calls("c3").querySelectorAll("details").find((d) => d.classList.contains("tc-json"));
    t.ok("開いた「入力・出力（JSON）」は同じ行の分だけ戻る", restored.hasAttribute("open") && !other.hasAttribute("open"));
  }

  // ---- 控えが空・筋が無いときは何もしない
  {
    const fresh = thread();
    restoreViewState(fresh.th, new Map());
    restoreViewState(null, new Map([["x", true]]));
    t.ok("空の控え・筋なしでも落ちず、何も開かない", captureViewState(null).size === 0 && fresh.th.querySelectorAll(".tc").every((c) => !isOpen(c)));
  }
}
