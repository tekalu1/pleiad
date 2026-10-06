// 圧縮の区切り（「自動で圧縮しました · 599k → 7k トークン」）が、発言を送るたびに最新の発言の前へ動かない
// （web/client.mjs の userMessage の case・paintCompactions を、最小の DOM で流す）。
//   - 区切りの後ろに発言を 2 通送っても、区切りは元の位置のまま（以前は 2 通目の直前へ移り、今圧縮したように見えた）
//   - 放置中の圧縮で区切りが末尾に付いた後に送った発言では、区切りがその発言の前に残る
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { N } from '../lib/dom-stub.mjs';

export const name = 'compaction-boundary-position';
export const title = '圧縮の区切りは発言を送っても動かない・放置中の圧縮の区切りは次の発言の前に置く';

// dom-stub の N は before() と複合セレクターと open の読み取りを持たないので、このテストに要る分だけ足す
class Node extends N {
  constructor(tag) {
    super(tag);
    const replace = (from, to) => { this.classList.remove(from); this.classList.add(to); };
    this.classList.replace = replace;
  }
  before(n) {
    n.remove();
    n.parent = this.parent;
    this.parent.children.splice(this.parent.children.indexOf(this), 0, n);
  }
  // dom-stub の open は書くだけで読めない。要約の開閉を確かめるので読めるようにする
  get open() { return 'open' in this.attrs; }
  set open(v) { if (v) this.attrs.open = ''; else delete this.attrs.open; }
  matches(sel) { return compound(this, sel.trim()); }
  querySelectorAll(sel) {
    const parts = sel.replace(/^:scope\s+/, '').trim().split(/\s+/);
    const out = [];
    const walk = (n) => {
      for (const c of n.children) {
        if (compound(c, parts.at(-1)) && parts.slice(0, -1).every((p, i) => {
          for (let a = c.parent; a && a !== this; a = a.parent) if (compound(a, p)) return true;
          return false;
        })) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] ?? null; }
}
// タグ・.class・[attr]・:not(...) の連なり 1 つ分
function compound(node, sel) {
  const tokens = sel.match(/:not\([^)]*\)|\.[\w-]+|\[[\w-]+\]|[a-z]+/gi) ?? [];
  return tokens.every(tok => {
    if (tok.startsWith(':not(')) return !compound(node, tok.slice(5, -1));
    if (tok.startsWith('.')) return node._classes().includes(tok.slice(1));
    if (tok.startsWith('[')) return tok.slice(1, -1) in node.attrs;
    return node.tagName === tok.toUpperCase();
  });
}

const at = (n) => new Date(Date.UTC(2026, 8, 29, 0, n)).toISOString();

export default async function (t) {
  const source = (await fs.readFile(new URL('../../web/client.mjs', import.meta.url), 'utf8')).replaceAll('\r\n', '\n');
  const functions = ['wrap', 'place', 'append', 'compactionBoundary', 'paintCompactions', 'acceptCompaction', 'ensureMessageRow'].map(name => {
    const start = source.indexOf(`function ${name}(`);
    if (start < 0) throw new Error(`client.mjs に ${name} が無い`);
    return source.slice(start, source.indexOf('\n}', start) + 2);
  }).join('\n');
  const head = source.indexOf("case 'userMessage': {");
  const tail = source.indexOf("case 'userMessage.delivered'", head);
  if (head < 0 || tail < 0) throw new Error("client.mjs に case 'userMessage' が無い");
  const userMessage = source.slice(head + "case 'userMessage': {".length, tail).trim().replace(/\}$/, '');

  const noop = () => {};
  const el = (tag, cls, text) => { const n = new Node(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
  const userMsg = (text, { at } = {}) => {
    const m = el('div', 'm user');
    if (at) m.dataset.at = at;
    const who = el('div', 'who'); who.append(el('span', 'when'));
    const body = el('div', 'body');
    m.append(who, body);
    return m;
  };
  const assistantMsg = (text, at) => {
    const m = el('div', 'm ai');
    if (at) m.dataset.at = at;
    return m;
  };
  const thread = el('div', 'thread');
  const state = { compactions: [], busy: false, current: 's' };
  const context = vm.createContext({
    state, thread, el, userMsg, t: k => k, noop, log: { scrollTop: 0, scrollHeight: 0, clientHeight: 0 },
    atBottom: () => false, relayoutBranches: noop, canCompactHere: () => false, compactNumber: String, paintContextStrip: noop,
    paintingHistory: false, liveSeq: 0, provisionalByMessage: new Map(),
    activity: { el: null },   // 稼働表示の行（place が使う）。このテストは稼働表示を出さない
    messageRow: (id) => thread.querySelectorAll('.mw').find(w => w.dataset.messageId === id) ?? null,
    closeTurnEl: noop, plainTextHtml: x => x, hhmm: x => x, markDelivery: noop, syncOutboxRows: noop, outboxes: new Map(),
    deliveredEarly: new Set(), voiceDelivery: { owns: () => false, adopt: noop }, document: { createTextNode: x => x },
  });
  vm.runInContext(functions, context);
  vm.runInContext(`function onUserMessage(ev, replay = false) {\n${userMessage}\n}`, context);
  const send = (id, text, when) => { context.ev = { type: 'userMessage', messageId: id, text, at: when }; vm.runInContext('onUserMessage(ev)', context); };
  const history = (id, text, when) => {
    const row = vm.runInContext('append', context)(userMsg(text, { at: when }), `history:${id}`);
    return row;
  };
  const reply = (when) => vm.runInContext('append', context)(assistantMsg('', when), `reply:${when}`);
  const order = () => thread.children.map(w => w.dataset.compactionId ? '[圧縮]' : w.querySelector('.m').dataset.at ? `${w.querySelector('.m').className.includes('user') ? 'U' : 'A'}${new Date(w.querySelector('.m').dataset.at).getUTCMinutes()}` : '?').join(' ');
  const compaction = (id, minute, trigger = 'idle') => ({ id, phase: 'complete', trigger, at: Date.parse(at(minute)), beforeTokens: 599_000, afterTokens: 7_000 });
  const reset = () => { thread.children = []; state.compactions = []; context.liveSeq = 0; };

  // ---------------------------------------------------------------- 区切りが途中にある会話（読み直した後の形）で送る
  reset();
  history('u1', '最初', at(1)); reply(at(2));
  history('u2', '圧縮の後', at(10)); reply(at(11));
  state.compactions = [compaction('c1', 5)];
  vm.runInContext('paintCompactions()', context);
  t.ok('（前提）読み直した形は区切りが圧縮の後の発言の前', order() === 'U1 A2 [圧縮] U10 A11', order());
  send('m1', '1 通目', at(20));
  t.ok('区切りの後ろに 1 通送っても区切りは動かない', order() === 'U1 A2 [圧縮] U10 A11 U20', order());
  send('m2', '2 通目', at(21));
  t.ok('2 通目を送っても区切りは 2 通目の前へ移らない（今圧縮したように見えない）', order() === 'U1 A2 [圧縮] U10 A11 U20 U21', order());
  send('m3', '3 通目', at(22));
  t.ok('何通送っても区切りは元の位置', order() === 'U1 A2 [圧縮] U10 A11 U20 U21 U22', order());

  // ---------------------------------------------------------------- 放置中の圧縮で区切りが末尾に付いた後に送る
  reset();
  history('u1', '最初', at(1)); reply(at(2));
  context.ev = compaction('c1', 30);
  vm.runInContext('acceptCompaction(ev)', context);
  t.ok('（前提）放置中の圧縮の区切りは末尾に付く', order() === 'U1 A2 [圧縮]', order());
  send('m1', '圧縮の後の 1 通目', at(40));
  t.ok('その後に送った発言の前に区切りが残る', order() === 'U1 A2 [圧縮] U40', order());
  send('m2', '2 通目', at(41));
  t.ok('続けて送っても区切りは 1 通目の前のまま', order() === 'U1 A2 [圧縮] U40 U41', order());

  // ---------------------------------------------------------------- 複数の区切り・at の無い発言
  reset();
  history('u1', '最初', at(1)); reply(at(2));
  history('u2', '二つ目の前', at(10));
  state.compactions = [compaction('c1', 5), compaction('c2', 15, 'auto')];
  vm.runInContext('paintCompactions()', context);
  t.ok('（前提）区切りが 2 つ。後の方は末尾', order() === 'U1 A2 [圧縮] U10 [圧縮]', order());
  send('m1', '送る', at(20));
  t.ok('複数の区切りも、それぞれ at で決まる位置に留まる（後ろの区切りは送った発言の前）', order() === 'U1 A2 [圧縮] U10 [圧縮] U20', order());
  send('m2', 'at が無い', undefined);
  t.ok('at の無い発言を送っても区切りは動かない', order().startsWith('U1 A2 [圧縮] U10 [圧縮] U20'), order());

  // ---------------------------------------------------------------- 送信待ちの行の後ろに付いた区切り・開いていた「要約を表示」
  reset();
  history('u1', '最初', at(1)); reply(at(2));
  vm.runInContext('ensureMessageRow', context)('m1', '送信待ち', undefined);   // 圧縮より先に出ていた送信待ちの行（まだ at が無い）
  context.ev = { ...compaction('c1', 30), summary: '要約' };
  vm.runInContext('acceptCompaction(ev)', context);
  t.ok('（前提）送信待ちの行の後ろに区切りが付く', order() === 'U1 A2 ? [圧縮]', order());
  const boundaryNode = () => thread.children.find(w => w.dataset.compactionId);
  boundaryNode().querySelector('details').open = true;
  send('m1', '送信待ち', at(40));
  t.ok('送信待ちだった発言が届くと、区切りはその発言の前へ移る', order() === 'U1 A2 [圧縮] U40', order());
  t.ok('置き直しても、開いていた要約は開いたまま', boundaryNode().querySelector('details').open === true);
  const placed = boundaryNode();
  send('m2', '2 通目', at(41));
  t.ok('区切りがすべて送った発言より前なら、区切りを作り直さない', boundaryNode() === placed && placed.querySelector('details').open === true);
}
