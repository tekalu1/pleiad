// ブラウザ無しで web/render.mjs を動かすための最小 DOM。
// これがあるおかげで、描画の検証は依存もブラウザも要らず素の Node で回る。
//
// textContent と属性値は**本物のブラウザと同じようにエスケープして**直列化する。
// ここで手を抜くと監査（lib/audit.mjs）が意味を失うので、
// esc を通していない出力経路は innerHTML だけにする。

const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ESC[c]);
const VOID = new Set(["br", "hr", "img", "input", "meta", "link"]);

export class N {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.attrs = {};
    this.children = [];
    this.parent = null;
    this._text = null;
    this._html = null;
    this.dataset = new Proxy({}, {
      set: (t, k, v) => {
        this.attrs["data-" + String(k).replace(/[A-Z]/g, (c) => "-" + c.toLowerCase())] = v;
        t[k] = v;
        return true;
      },
      get: (t, k) => t[k],
    });
    // 位置も幅も持たない（測れない）。style は書いた値を覚えるだけ
    this.style = { cssText: "", setProperty(k, v) { this[k] = v; }, getPropertyValue(k) { return this[k] ?? ""; } };
    this.classList = {
      add: (...c) => { this.attrs.class = [...this._classes(), ...c].join(" "); },
      remove: (...c) => { this.attrs.class = this._classes().filter((x) => !c.includes(x)).join(" "); },
      contains: (c) => this._classes().includes(c),
      toggle: (c, force) => {
        const on = force ?? !this._classes().includes(c);
        if (on) this.classList.add(c); else this.classList.remove(c);
        return on;
      },
    };
  }
  _classes() { return String(this.attrs.class ?? "").split(/\s+/).filter(Boolean); }
  set className(v) { this.attrs.class = v; }
  get className() { return this.attrs.class ?? ""; }
  set textContent(v) { this._text = String(v); this.children = []; }
  get textContent() { return this._text ?? this.children.map((c) => c.textContent).join(""); }
  set innerHTML(v) { this._html = String(v); this.children = []; }
  set title(v) { this.attrs.title = v; }
  set open(v) { if (v) this.attrs.open = ""; else delete this.attrs.open; }
  set id(v) { this.attrs.id = v; }
  get id() { return this.attrs.id ?? ""; }
  set tabIndex(v) { this.attrs.tabindex = String(v); }
  setAttribute(k, v) { this.attrs[k] = v; }
  getAttribute(k) { return this.attrs[k]; }
  hasAttribute(k) { return k in this.attrs; }
  removeAttribute(k) { delete this.attrs[k]; }
  // 置いた場所も大きさも無いので、位置を動かす呼び出しは受けるだけ
  scrollIntoView() {}
  focus() {}
  // 手で流すためだけの最小の配線。キャプチャも伝播も持たない
  addEventListener(type, fn) { (this.on ??= {})[type] = [...(this.on[type] ?? []), fn]; }
  removeEventListener(type, fn) { if (this.on?.[type]) this.on[type] = this.on[type].filter((f) => f !== fn); }
  dispatchEvent(ev) { for (const fn of this.on?.[ev.type] ?? []) fn(ev); return true; }
  append(...n) { for (const c of n) { c.parent = this; this.children.push(c); } }
  replaceChildren(...n) { this._text = null; this._html = null; this.children = []; this.append(...n); }
  prepend(...n) { for (const c of n.reverse()) { c.parent = this; this.children.unshift(c); } }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this); }
  get firstChild() { return this.children[0]; }
  get lastChild() { return this.children[this.children.length - 1]; }

  matches(sel) {
    const s = sel.trim();
    return s.startsWith(".") ? this._classes().includes(s.slice(1)) : this.tagName === s.toUpperCase();
  }
  querySelectorAll(sel) {
    const parts = sel.split(",").map((s) => s.trim()).filter(Boolean);
    const out = [];
    const walk = (n) => {
      for (const c of n.children) {
        if (parts.some((p) => c.matches(p))) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] ?? null; }

  get outerHTML() {
    const a = Object.entries(this.attrs)
      .map(([k, v]) => (v === "" ? ` ${k}` : ` ${k}="${esc(v)}"`)).join("");
    const t = this.tagName.toLowerCase();
    if (VOID.has(t)) return `<${t}${a}>`;
    const inner = this._html ?? (this._text != null ? esc(this._text) : this.children.map((c) => c.outerHTML).join(""));
    return `<${t}${a}>${inner}</${t}>`;
  }
  /** 画面に出る文字だけ（属性は含めない）。「何をしたか」が読めるかの確認用。 */
  get shown() { return this._text ?? (this._html ?? "") + this.children.map((c) => c.shown).join(" "); }
}

/**
 * document / location を差し替える。
 * web/render.mjs を読み込む**前**に呼ぶこと（tests/run.mjs が入口で1回だけ呼ぶ）。
 */
export function installDomStub() {
  globalThis.document = { createElement: (t) => new N(t), createElementNS: (_ns, t) => new N(t) };
  globalThis.location = new URL("http://127.0.0.1:8787/index.html");
}
