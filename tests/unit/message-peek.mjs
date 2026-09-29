// ホバーの無い端末で、発言を押すと時刻を数秒だけ出す（web/message-peek.mjs、ADR 0067）
import { peekTarget, setupMessagePeek, PEEK_MS } from "../../web/message-peek.mjs";

export const name = "message-peek";
export const title = "発言を押すと時刻が出る: リンク・ボタン・コード・字の選択の上では出さない・時間で消える";

// 押した先の入れ物（.m）と、その中の要素を最小限で真似る。closest(sel) は sel のどれかに当たる自分か祖先を返す
const node = (classes, parent = null, extra = {}) => {
  const n = { classes: new Set(classes), parent, list: new Set(classes), ...extra };
  n.closest = (sel) => {
    const wanted = sel.split(",").map((s) => s.trim());
    for (let x = n; x; x = x.parent) {
      if (wanted.some((w) => (w.startsWith(".") && x.classes.has(w.slice(1))) || (!w.startsWith(".") && x.tag === w))) return x;
    }
    return null;
  };
  return n;
};

export default async function (t) {
  const m = node(["m", "ai"]);
  m.querySelector = (sel) => (sel === ":scope > .who .when" ? {} : null);
  m.classList = { add: (c) => m.classes.add(c), remove: (c) => m.classes.delete(c) };
  const body = node(["abody"], m);
  const link = node([], body, { tag: "a" });
  const button = node([], body, { tag: "button" });
  const code = node(["code-block"], body);
  const bare = node(["m"]);
  bare.querySelector = () => null;

  t.ok("本文を押すと、その発言が対象", peekTarget(body) === m);
  t.ok("リンク・ボタン・コードブロックの上は対象にしない", peekTarget(link) === null && peekTarget(button) === null && peekTarget(code) === null);
  t.ok("字を選んでいる間は対象にしない", peekTarget(body, { hasSelection: true }) === null);
  t.ok("時刻の無い発言（発言者の行が無い）は対象にしない", peekTarget(bare) === null);

  // ---- 押すと peek が付き、時間が来たら外れる。ホバーのある端末では何もしない
  const listeners = {};
  const root = { addEventListener: (type, fn) => { listeners[type] = fn; } };
  const timers = [];
  const realSet = globalThis.setTimeout, realClear = globalThis.clearTimeout;
  globalThis.setTimeout = (fn, ms) => { timers.push({ fn, ms }); return timers.length; };
  globalThis.clearTimeout = () => {};
  globalThis.getSelection = () => ({ toString: () => "" });
  try {
    setupMessagePeek(root, { hoverless: () => false });
    listeners.click({ target: body });
    t.ok("ホバーのある端末では押しても出さない", !m.classes.has("peek") && !timers.length);
    setupMessagePeek(root, { hoverless: () => true });
    listeners.click({ target: body });
    t.ok("タッチで押すと peek が付き、4 秒後に外れる", m.classes.has("peek") && timers.at(-1).ms === PEEK_MS && PEEK_MS === 4000);
    timers.at(-1).fn();
    t.ok("時間が来たら peek が外れる", !m.classes.has("peek"));
    listeners.click({ target: link });
    t.ok("リンクを押しても出さない", !m.classes.has("peek"));
  } finally {
    globalThis.setTimeout = realSet; globalThis.clearTimeout = realClear;
    delete globalThis.getSelection;
  }
}
