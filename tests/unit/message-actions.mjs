// 発言の操作（web/message-actions.mjs）・長い発言の畳み（web/fold.mjs）・送った直後の画像の枠（web/attachment-frame.mjs）。ADR 0067
import { messageMenuPlan, setupMessageMenu, COPIED_MS, aiReportUrl } from "../../web/message-actions.mjs";
import { frameSize, pendingImageHtml, SLOW_MS } from "../../web/attachment-frame.mjs";
import { revealFold } from "../../web/fold.mjs";
import { postMenu } from "../../web/channels/post-menu.mjs";

export const name = "message-actions";
export const title = "発言のメニュー: 並び・右クリックの譲り方・キーボード / 畳みを開く / 送った直後の画像の枠";

const keys = (plan) => plan.map((p) => p.key).join(",");

// 押した先の入れ物を最小限で真似る。closest(sel) は sel のどれかに当たる自分か祖先を返す
const node = (tag, classes = [], parent = null) => {
  const n = { tag, classes: new Set(classes), parent };
  n.closest = (sel) => {
    const wanted = sel.split(",").map((s) => s.trim());
    for (let x = n; x; x = x.parent) {
      if (wanted.some((w) => (w.startsWith(".") ? x.classes.has(w.slice(1)) : w.startsWith("[") ? x.attrs?.has(w.slice(1, -1)) : x.tag === w))) return x;
    }
    return null;
  };
  return n;
};

export default async function (t) {
  // ---- メニューの並びと文言
  t.ok("自分の発言: コピー・ここから分岐 / 編集して再送信・再送信・原文",
    keys(messageMenuPlan({ kind: "user", source: true })) === "copy,fork,sep,edit,resend,source");
  t.ok("保存前の自分の発言: 編集・再送信は出さない",
    keys(messageMenuPlan({ kind: "user", source: true, editable: false })) === "copy,fork,sep,source");
  t.ok("エージェントの返答: 返答をコピー・ここから分岐・報告", keys(messageMenuPlan({ kind: "ai" })) === "copy,fork,sep,report"
    && messageMenuPlan({ kind: "ai" })[0].label === "返答をコピー");
  t.ok("報告は Pleiad 開発者への Issue を開き、会話本文を自動で含めない", (() => {
    const url = new URL(aiReportUrl());
    return url.origin === 'https://github.com' && url.pathname === '/tekalu1/pleiad/issues/new'
      && url.searchParams.get('title') === 'Pleiad で表示された不適切な AI の内容'
      && url.searchParams.get('body')?.includes('会話本文を自動で添付しません');
  })());
  t.ok("続きの発言を右クリックしたときの分岐は「この発言から分岐」", messageMenuPlan({ kind: "ai", part: true }).find((p) => p.key === "fork").label === "この発言から分岐"
    && messageMenuPlan({ kind: "ai" }).find((p) => p.key === "fork").label === "ここから分岐");
  t.ok("分岐できない返答にも報告は出す", keys(messageMenuPlan({ kind: "ai", canFork: false })) === "copy,sep,report");
  t.ok("`!` の行は「入力欄に写す」を足し、編集・再送信は出さない", keys(messageMenuPlan({ kind: "cmd", shell: true })) === "copy,toComposer,fork");
  const menu = (kind) => postMenu({ post: { author: { kind }, text: 'private content' }, t: () => 'react', name: 'bot', time: '', react: () => {} }).items;
  t.ok("Channels の bot 投稿にも報告を出し、人やシステムの投稿には出さない", menu('bot').some(item => item.label === '不適切な AI の内容を報告')
    && !menu('human').some(item => item.label === '不適切な AI の内容を報告')
    && !menu('system').some(item => item.label === '不適切な AI の内容を報告'));
  t.ok("コピーの印は 1.2 秒", COPIED_MS === 1200);

  // ---- 右クリック・キーボード
  const listeners = {};
  const root = { addEventListener: (type, fn) => { listeners[type] = fn; } };
  const m = node("div", ["m"], null);
  const body = node("div", ["body"], m);
  const link = node("a", [], body);
  const code = node("pre", [], body);
  const more = node("button", ["who-btn"], node("div", ["who"], m));
  const opened = [];
  setupMessageMenu(root, { resolve: (target) => (target.closest(".m") ? { m, part: false } : null), open: (hit, at) => opened.push(at) });
  globalThis.getSelection = () => ({ toString: () => "" });
  try {
    let prevented = 0;
    const context = (target, extra = {}) => listeners.contextmenu({ target, defaultPrevented: false, isTrusted: true, clientX: 30, clientY: 40, preventDefault: () => { prevented++; }, ...extra });
    context(body);
    t.ok("本文の上の右クリックは発言のメニュー（押した位置に出す）", opened.length === 1 && opened[0].x === 30 && opened[0].y === 40 && !opened[0].key && prevented === 1);
    context(link); context(code);
    t.ok("リンクとコードの上は今のメニュー（ブラウザーなど）に譲る", opened.length === 1 && prevented === 1);
    globalThis.getSelection = () => ({ toString: () => "選んだ字" });
    context(body);
    t.ok("字を選んでいるときは譲る", opened.length === 1);
    context(body, { isTrusted: false });
    t.ok("長押し（合成のイベント）は、OS が語を選んでいても開く", opened.length === 2);
    globalThis.getSelection = () => ({ toString: () => "" });
    context(body, { defaultPrevented: true });
    t.ok("ほかが処理したイベントは触らない", opened.length === 2);
    context(more, { clientX: 0, clientY: 0 });
    t.ok("⋯ の上の（座標の無い）メニューキー由来のイベントはキーボードの開き方（⋯ の位置に出す）", opened.length === 3 && opened[2].key === true);
    let keyPrevented = 0;
    const press = (target, key, extra = {}) => listeners.keydown({ target, key, shiftKey: false, defaultPrevented: false, isComposing: false, preventDefault: () => { keyPrevented++; }, ...extra });
    press(more, "F10", { shiftKey: true });
    press(more, "ContextMenu");
    t.ok("Shift+F10 とメニューキーで開く", opened.length === 5 && opened.slice(3).every((a) => a.key) && keyPrevented === 2);
    press(more, "F10");
    press(link, "ContextMenu");
    t.ok("Shift の無い F10・リンクの上のメニューキーは開かない", opened.length === 5);
  } finally { delete globalThis.getSelection; }

  // ---- 畳みの開閉（検索・目次で一致したとき）
  const rest = { closest: (sel) => (sel === ".fold-rest" ? rest : null) };
  const opens = [];
  const host = { fold: { isOpen: () => false, open: (animate) => opens.push(animate) } };
  rest.closest = (sel) => (sel === ".fold-rest" ? rest : sel === ".fold" ? host : null);
  const inside = { closest: (sel) => (sel === ".fold-rest" ? rest : null) };
  t.ok("畳まれた部分の中の一致は、動かさずに開く", revealFold(inside) === true && opens.length === 1 && opens[0] === false);
  host.fold.isOpen = () => true;
  t.ok("開いていれば何もしない", revealFold(inside) === false && opens.length === 1);
  t.ok("畳みの外の要素は対象にしない", revealFold({ closest: () => null }) === false);

  // ---- 送った直後の画像の枠
  const at = (w, h) => frameSize(w, h, 240);
  t.ok("枠の寸法: 縦横から縮小の最大（240 × 144）に収める", JSON.stringify(at(960, 540)) === JSON.stringify({ width: 240, height: 135, known: true })
    && at(300, 600).height === 144 && at(300, 600).width === 72);
  t.ok("枠の寸法: 小さい画像は拡大しない", at(100, 50).width === 100 && at(100, 50).height === 50);
  t.ok("枠の寸法: 縦横が分からなければ 240 × 144（5:3）で、分かっていないことを覚える", JSON.stringify(at(0, 0)) === JSON.stringify({ width: 240, height: 144, known: false }));
  t.ok("枠の寸法: 700px 以下の最大は 220 幅", frameSize(960, 540, 220).width === 220);
  const html = pendingImageHtml({ name: "shot.png", src: "/local-file?path=C%3A%5Cshot.png", path: "C:\\shot.png", width: 960, height: 540 });
  t.ok("枠は role=img と名前「画像を読み込んでいます: 名前」を持つ", html.includes('role="img"') && html.includes('aria-label="画像を読み込んでいます: shot.png"'));
  t.ok("枠の HTML に名前やパスの危険な字は通さない", !pendingImageHtml({ name: '"><script>x</script>', src: "/a", path: "" }).includes("<script>"));
  t.ok("光を出す時間は 150ms", SLOW_MS === 150);
}
