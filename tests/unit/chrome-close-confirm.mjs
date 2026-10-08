import { setupChromePanel, createWindowTable } from '../../web/chrome-panel.mjs';
import { paintTaskChrome, closeRiskOf, confirmCloseWindow } from '../../web/task-chrome.mjs';
import { delegatedChromeWindows } from '../../core/chrome/delegation.mjs';
import { N } from '../lib/dom-stub.mjs';

export const name = 'chrome-close-confirm';
export const title = 'Chrome の窓を閉じる前の確かめ: 引き継ぎ中・依頼待ちだけ確かめ、閉じている間は押せない（カードの × と ⋯）';

const words = { 'pending.cancel': 'やめる', 'taskChrome.confirmClose': '窓を閉じる', 'taskChrome.confirmHuman': '引き継ぎ中です', 'taskChrome.confirmWaiting': '待っています',
  'taskChrome.view': '見る', 'taskChrome.close': '閉じる', 'taskChrome.running': '作業中', 'taskChrome.paused': '引き継ぎ中',
  'browser.chromeWindow.windowActions': '窓の操作', 'browser.chromeWindow.close': '窓を閉じる', 'browser.chromeWindow.windowNumber': '窓', 'browser.chromeWindow.windowCurrent': '表示中' };
const tr = key => words[key] ?? key;
const flush = () => new Promise(resolve => setTimeout(resolve, 0));
const el = (tag, cls = null, value = '') => ({ tag, className: cls, textContent: value, children: [], disabled: false,
  append(...children) { this.children.push(...children); }, replaceChildren(...children) { this.children = children; }, setAttribute() {}, removeAttribute() {} });

export default async function (t) {
  t.ok('引き継ぎ中は human、依頼待ちは waiting、それ以外は確かめない',
    closeRiskOf({ state: 'paused' }) === 'human' && closeRiskOf({ state: 'running', waiting: true }) === 'waiting'
    && closeRiskOf({ state: 'paused', waiting: true }) === 'human' && closeRiskOf({ state: 'running' }) === null && closeRiskOf() === null);

  {
    const menus = [];
    let ran = 0;
    const showMenu = (x, y, items, title) => menus.push({ x, y, items, title });
    const anchor = { getBoundingClientRect: () => ({ left: 40, bottom: 20 }) };
    confirmCloseWindow({ risk: null, run: () => { ran++; }, showMenu, anchor, t: tr });
    t.ok('確かめが要らない窓は、そのまま閉じる', ran === 1 && menus.length === 0);
    confirmCloseWindow({ risk: 'human', run: () => { ran++; }, showMenu, anchor, t: tr });
    t.ok('引き継ぎ中の窓は、閉じずに確かめを出す（押した場所の下・全文を折り返す見出し）', ran === 1 && menus.length === 1 && menus[0].x === 40 && menus[0].y === 24
      && menus[0].title.text === '引き継ぎ中です' && menus[0].title.wrap === true);
    menus[0].items[0].onClick();
    t.ok('「やめる」では閉じない', ran === 1);
    menus[0].items[1].onClick();
    t.ok('「窓を閉じる」で初めて閉じる', ran === 2);
    confirmCloseWindow({ risk: 'waiting', run: () => { ran++; }, showMenu, anchor, t: tr });
    t.ok('依頼待ちの窓は、依頼待ちの文で確かめる', menus[1].title.text === '待っています' && ran === 2);
  }

  {
    const card = { chromeLine: null, querySelector(selector) { return selector === ':scope > .tc-task-chrome' ? this.chromeLine : selector === ':scope > .tc-details' ? { after: line => { this.chromeLine = line; } } : null; } };
    const calls = [];
    const row = { sessionId: 'a', taskId: 'ta', windows: 1, state: 'running' };
    paintTaskChrome(card, row, { el, open: () => {}, close: (r, anchor) => calls.push([r.sessionId, anchor]), busy: id => id === 'a', t: tr });
    const dismiss = card.chromeLine.children.at(-1);
    t.ok('閉じている最中の窓の × は押せない', dismiss.disabled === true);
    paintTaskChrome(card, row, { el, open: () => {}, close: (r, anchor) => calls.push([r.sessionId, anchor]), busy: () => false, t: tr });
    const again = card.chromeLine.children.at(-1);
    again.onclick();
    t.ok('閉じていなければ押せ、確かめの足場になる ×（anchor）を渡す', again.disabled === false && calls.length === 1 && calls[0][0] === 'a' && calls[0][1] === again);
  }

  {
    const rows = [{ taskId: 'ta', parentSessionId: 'parent', sessionId: 'a' }, { taskId: 'tb', parentSessionId: 'parent', sessionId: 'b' }];
    const listing = delegatedChromeWindows('parent', { rows: () => rows, sessions: () => ['a', 'b'], summary: () => ({ windows: 1 }), profile: () => null,
      state: () => 'running', waiting: id => id === 'b' });
    t.ok('窓の一覧は、人への依頼を待っている窓に waiting の印を付ける', listing.find(r => r.sessionId === 'a').waiting === false && listing.find(r => r.sessionId === 'b').waiting === true);
  }

  // 右パネルの ⋯「窓を閉じる」
  const old = { raf: globalThis.requestAnimationFrame, rect: N.prototype.getBoundingClientRect, toggle: N.prototype.toggleAttribute, window: globalThis.window };
  globalThis.requestAnimationFrame = fn => { queueMicrotask(fn); return 1; };
  N.prototype.getBoundingClientRect = () => ({ left: 10, top: 0, right: 400, bottom: 30, width: 400, height: 30 });
  N.prototype.toggleAttribute = function (name, on) { if (on) this.setAttribute(name, ''); else this.removeAttribute(name); };
  globalThis.window = { innerHeight: 800, devicePixelRatio: 1 };
  try {
    const rig = risk => {
      const commands = [], menus = [], windows = createWindowTable();
      let toolbar = null, open = false;
      const preview = { openPanel: opts => { toolbar = opts.toolbar; open = true; }, panelOpen: () => open, close: () => { open = false; } };
      windows.apply({ sessionId: 'conv', windows: 1, windowIds: [7], currentWindowId: 7 });
      const panel = setupChromePanel({ cmd: async (name, args) => { commands.push([name, args]); return name === 'browserScreencast' ? { state: {} } : {}; },
        preview, browser: {}, session: () => 'conv', windows, closeRisk: () => risk, showMenu: (x, y, items, title) => menus.push({ items, title }) });
      panel.open();
      return { commands, menus, press: () => toolbar.at(-1).onclick(), closes: () => commands.filter(([name]) => name === 'chromeCloseWindow') };
    };
    for (const risk of ['human', 'waiting']) {
      const r = rig(risk);
      await flush();
      r.press();
      r.menus[0].items.at(-1).onClick();
      t.ok(`⋯ の「窓を閉じる」は、${risk === 'human' ? '引き継ぎ中' : '依頼待ち'}なら送らず確かめを出す`, r.closes().length === 0 && r.menus.length === 2 && r.menus[1].title.wrap === true);
      r.menus[1].items[0].onClick();
      await flush();
      t.ok('「やめる」では閉じない', r.closes().length === 0);
      r.menus[1].items[1].onClick();
      await flush();
      t.ok('確かめに答えると、自分の会話の窓を閉じる', r.closes().length === 1 && r.closes()[0][1].sessionId === 'conv');
    }
    const r = rig(null);
    await flush();
    r.press();
    r.menus[0].items.at(-1).onClick();
    await flush();
    t.ok('確かめが要らない窓は、⋯ からそのまま閉じる', r.menus.length === 1 && r.closes().length === 1);
  } finally {
    globalThis.requestAnimationFrame = old.raf; N.prototype.getBoundingClientRect = old.rect; N.prototype.toggleAttribute = old.toggle; globalThis.window = old.window;
  }
}
