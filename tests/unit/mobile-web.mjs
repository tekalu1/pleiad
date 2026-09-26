// スマホで使うための画面の手直し（docs/remote.md §8.3・§8.4）のうち、DOM の無い Node で見られるもの。
//  - randomId: crypto.randomUUID の無い（secure context でない）環境でも UUID v4 の形を返す
//  - 長押し: 指を止めたら置いた位置で contextmenu を起こし、受け手が開いたら後の click と OS の contextmenu を捨てる
//  - 「…」のボタン: 押すとボタンの左下でメニューを開き、行の押下へは伝えない
//  - 画面の並び: 引き出し・「…」・16px の入力欄・safe-area の規則が style.css / index.html にある
import fs from "node:fs";
import { randomId, moreButton } from "../../web/dom.mjs";
import { setupLongPress } from "../../web/long-press.mjs";

export const name = "mobile-web";
export const title = "スマホの画面: UUID の代わり・長押し・「…」・狭い画面の規則";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function fakeDoc() {
  const on = {};
  return {
    addEventListener: (type, fn, capture) => { (on[type] ??= []).push({ fn, capture: Boolean(capture) }); },
    // 捕獲 → 受け手 → 泡の順に配る（stopImmediatePropagation で止まる）
    fire(type, e, target) {
      let stopped = false;
      const ev = { type, isTrusted: true, defaultPrevented: false, target, preventDefault() { this.defaultPrevented = true; }, stopImmediatePropagation() { stopped = true; }, ...e };
      for (const l of (on[type] ?? []).filter((l) => l.capture)) { if (stopped) break; l.fn(ev); }
      if (!stopped) target?.handle?.(ev);
      for (const l of (on[type] ?? []).filter((l) => !l.capture)) { if (stopped) break; l.fn(ev); }
      return { ev, stopped };
    },
  };
}

function fakeTarget({ skip = false, handles = true } = {}) {
  const got = [];
  return {
    got, isConnected: true,
    closest: () => (skip ? {} : null),
    handle(ev) { got.push(ev.type); if (handles && ev.type === "contextmenu") ev.preventDefault(); },
    dispatchEvent(ev) { got.push(`${ev.type}@${ev.clientX},${ev.clientY}`); if (handles) ev.preventDefault(); return !ev.defaultPrevented; },
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export default async function (t) {
  // ---------------------------------------------------------------- randomId
  t.ok("randomUUID があればそれを使う", randomId({ randomUUID: () => "from-crypto" }) === "from-crypto");
  const filled = randomId({ getRandomValues: (b) => { b.fill(0xff); return b; } });
  t.ok("randomUUID が無ければ getRandomValues で v4 の形", UUID.test(filled) && filled.startsWith("ffffffff-ffff-4fff-bfff-"), filled);
  t.ok("randomUUID が投げても（secure context でない）代わりを返す", UUID.test(randomId({ randomUUID: () => { throw new Error("insecure"); }, getRandomValues: (b) => b })));
  t.ok("crypto が無くても形は保つ", UUID.test(randomId(null)));
  t.ok("毎回違う", new Set(Array.from({ length: 50 }, () => randomId())).size === 50);

  // ---------------------------------------------------------------- 長押し
  const hadMouseEvent = "MouseEvent" in globalThis;
  const saved = globalThis.MouseEvent;
  globalThis.MouseEvent = class { constructor(type, o) { Object.assign(this, o, { type, defaultPrevented: false }); } preventDefault() { this.defaultPrevented = true; } };
  try {
    {
      const doc = fakeDoc(), target = fakeTarget();
      setupLongPress({ doc, delay: 20 });
      doc.fire("pointerdown", { pointerType: "touch", isPrimary: true, clientX: 30, clientY: 40 }, target);
      await sleep(40);
      t.ok("指を止めると置いた位置で contextmenu", target.got.includes("contextmenu@30,40"), target.got.join(" "));
      doc.fire("pointerup", {}, target);
      const os = doc.fire("contextmenu", {}, target);
      t.ok("開いたあとに OS が出す contextmenu は捨てる", os.stopped && os.ev.defaultPrevented);
      const click = doc.fire("click", {}, target);
      t.ok("指を離したあとの click（開いたメニューの上）を捨てる", click.stopped && click.ev.defaultPrevented);
      const next = doc.fire("click", {}, target);
      t.ok("次の click は通す", !next.stopped);
    }
    {
      const doc = fakeDoc(), target = fakeTarget();
      setupLongPress({ doc, delay: 20 });
      doc.fire("pointerdown", { pointerType: "touch", isPrimary: true, clientX: 0, clientY: 0 }, target);
      doc.fire("pointermove", { clientX: 0, clientY: 30 }, target);
      await sleep(40);
      t.ok("動かした（スクロール）なら起こさない", !target.got.some((g) => g.startsWith("contextmenu@")));
    }
    {
      const doc = fakeDoc(), target = fakeTarget();
      setupLongPress({ doc, delay: 20 });
      doc.fire("pointerdown", { pointerType: "mouse", clientX: 0, clientY: 0 }, target);
      await sleep(40);
      const skipDoc = fakeDoc(), field = fakeTarget({ skip: true });
      setupLongPress({ doc: skipDoc, delay: 20 });
      skipDoc.fire("pointerdown", { pointerType: "touch", isPrimary: true, clientX: 0, clientY: 0 }, field);
      await sleep(40);
      t.ok("マウス・入力欄・「…」では起こさない", ![...target.got, ...field.got].some((g) => g.startsWith("contextmenu")));
    }
    {
      const doc = fakeDoc(), target = fakeTarget();
      setupLongPress({ doc, delay: 30 });
      doc.fire("pointerdown", { pointerType: "touch", isPrimary: true, clientX: 5, clientY: 5 }, target);
      await sleep(5);
      const os = doc.fire("contextmenu", {}, target);   // Android: OS が先に出す
      await sleep(50);
      t.ok("OS が先に出したら（Android）そちらを通し、こちらは起こさない", !os.stopped && target.got.filter((g) => g.startsWith("contextmenu")).join() === "contextmenu");
      doc.fire("pointerup", {}, target);
      t.ok("OS の長押しでメニューが開いたときも後の click を捨てる", doc.fire("click", {}, target).stopped);
    }
    {
      const doc = fakeDoc(), target = fakeTarget({ handles: false });
      setupLongPress({ doc, delay: 20 });
      doc.fire("pointerdown", { pointerType: "touch", isPrimary: true, clientX: 1, clientY: 1 }, target);
      await sleep(40);
      doc.fire("pointerup", {}, target);
      t.ok("受け手が無い場所（本文）では click を奪わない", !doc.fire("click", {}, target).stopped);
    }
  } finally {
    if (hadMouseEvent) globalThis.MouseEvent = saved; else delete globalThis.MouseEvent;
  }

  // ---------------------------------------------------------------- 「…」
  {
    const opened = [];
    const b = moreButton("row-more", "「題」の操作", (x, y) => opened.push([x, y]));
    b.getBoundingClientRect = () => ({ left: 100, bottom: 50, right: 130, top: 20 });
    let stopped = 0;
    b.onclick({ stopPropagation: () => { stopped++; }, preventDefault() {} });
    t.ok("「…」: 押すとボタンの左下で開き、行へは伝えない", opened.length === 1 && opened[0][0] === 100 && opened[0][1] === 54 && stopped === 1);
    t.ok("「…」: 名前と、メニューを開くことを読み上げる", b.attrs["aria-label"] === "「題」の操作" && b.attrs["aria-haspopup"] === "menu" && b.className.includes("more-btn"));
  }

  // ---------------------------------------------------------------- 規則が載っているか（見た目は tests/browser と手で確かめる）
  const css = fs.readFileSync(new URL("../../web/style.css", import.meta.url), "utf8");
  const html = fs.readFileSync(new URL("../../web/index.html", import.meta.url), "utf8");
  t.ok("viewport-fit=cover", /name="viewport"[^>]*viewport-fit=cover/.test(html));
  t.ok("safe-area と 100dvh", css.includes("env(safe-area-inset-bottom") && css.includes("env(safe-area-inset-top") && css.includes("100dvh"));
  t.ok("700px 以下で脇を引き出しに（:root.side-open で開く）", /@media \(max-width:700px\)\{[^@]*position:fixed[^@]*:root\.side-open body:not\(\.settings\) > #sidebar/s.test(css));
  t.ok("引き出しは開くとき visibility を遷移させない（隠れたままで閉じるボタンにフォーカスが入らず body に落ちていた）",
    /@media \(max-width:700px\)\{[^@]*:root\.side-open body:not\(\.settings\) > #sidebar\{transition:transform var\(--dur\) var\(--ease-out\),visibility 0s\}/s.test(css));
  const client = fs.readFileSync(new URL("../../web/client.mjs", import.meta.url), "utf8");
  const drawer = client.slice(client.indexOf("function setDrawer("), client.indexOf("function setSidebar("));
  t.ok("引き出しを開いたら閉じるボタンへ。置けなければ次のフレームで置き直す",
    /close\.focus\(\{ preventScroll: true \}\);\s*if \(document\.activeElement !== close\) requestAnimationFrame\(/.test(drawer));
  t.ok("pointer:coarse で入力欄を 16px 以上", /@media \(pointer:coarse\)\{[^@]*font-size:max\(16px/s.test(css));
  t.ok("hover:none で「…」と ＋ を常に見せる", /@media \(hover:none\)\{[^@]*\.row-more[^@]*\.grp-add\{opacity:1\}/s.test(css));
  t.ok("モバイル版の殻の帯（.host-bar）", css.includes(":root.remote-mobile .host-bar"));
}
