import { setupChromePanel, createWindowTable } from '../../web/chrome-panel.mjs';
import { paintTaskChrome, closeRiskOf, confirmCloseWindow } from '../../web/task-chrome.mjs';
import { delegatedChromeWindows } from '../../core/chrome/delegation.mjs';
import { N } from '../lib/dom-stub.mjs';

export const name = 'chrome-close-confirm';
export const title = 'Chrome の窓を閉じる前の確かめ: 引き継ぎ中・依頼待ちだけ確かめ、閉じている間は押せない（カードの × と ⋯）';

const words = { 'pending.cancel': 'やめる', 'taskChrome.confirmClose': 'ウィンドウを閉じる', 'taskChrome.confirmHuman': '引き継ぎ中です', 'taskChrome.confirmWaiting': '待っています',
  'taskChrome.view': '見る', 'taskChrome.close': '閉じる', 'taskChrome.running': '作業中', 'taskChrome.paused': '引き継ぎ中',
  'browser.chromeWindow.windowActions': 'ウィンドウの操作', 'browser.chromeWindow.closeShown': '表示中のウィンドウを閉じる', 'browser.chromeWindow.windowNumber': 'ウィンドウ' };
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
      let toolbar = null, body = null, open = false;
      const preview = { openPanel: opts => { toolbar = opts.toolbar; body = opts.body; open = true; }, panelOpen: () => open, close: () => { open = false; } };
      windows.apply({ sessionId: 'conv', windows: 1, windowIds: [7], currentWindowId: 7 });
      const panel = setupChromePanel({ cmd: async (name, args) => { commands.push([name, args]); return name === 'browserScreencast' ? { state: {} } : {}; },
        preview, browser: {}, session: () => 'conv', windows, closeRisk: () => risk, showMenu: (x, y, items, title) => menus.push({ items, title }) });
      panel.open();
      const dialog = () => body.querySelector('.cp-dlg');
      return { commands, menus, dialog, press: () => toolbar.at(-1).onclick(), closes: () => commands.filter(([name]) => name === 'chromeCloseWindow'),
        card: () => body.querySelector('.cp-dlg-card'), no: () => body.querySelector('.btn-quiet'), yes: () => body.querySelector('.cp-dlg-yes'), note: () => body.querySelector('.cp-dlg-n') };
    };
    for (const risk of ['human', 'waiting', null]) {
      const r = rig(risk);
      await flush();
      r.press();
      t.ok('⋯ の中身は「表示中のウィンドウを閉じる」だけ（子の窓が無いとき。閉じる確かめは出さず、押すまで開かない）',
        r.menus.length === 1 && r.menus[0].items.length === 1 && r.menus[0].items[0].label === '表示中のウィンドウを閉じる' && r.dialog().hidden === true, JSON.stringify(r.menus[0].items.map(i => i.label)));
      r.menus[0].items.at(-1).onClick();
      t.ok(`⋯ の「表示中のウィンドウを閉じる」は、${risk ?? '確かめの要らない'}窓でも送らず、パネルの中の確かめを出す（メニューの確かめは出さない）`,
        r.closes().length === 0 && r.menus.length === 1 && r.dialog().hidden === false && r.card().attrs.role === 'alertdialog');
      t.ok('確かめの題は、窓が 1 つなら番号を入れず、焦点は「やめる」の側にある',
        /閉じますか/.test(r.card().querySelector('.cp-dlg-t').textContent) && !/\d/.test(r.card().querySelector('.cp-dlg-t').textContent) && r.no().textContent.length > 0 && r.yes().textContent === '閉じる');
      t.ok(`注意の一文は引き継ぎ中・依頼待ちのときだけ付く（${risk ?? 'なし'}）`,
        risk === null ? r.note() === null : risk === 'human' ? /引き継ぎ中/.test(r.note().textContent) : /待っています/.test(r.note().textContent));
      r.no().onclick();
      await flush();
      t.ok('「やめる」では閉じない', r.closes().length === 0 && r.dialog().hidden === true);
      r.menus[0].items.at(-1).onClick();
      let prevented = 0;
      r.dialog().onkeydown({ key: 'Escape', preventDefault: () => { prevented++; } });
      t.ok('Esc も「やめる」で、ほかの Esc の処理（プレビューを閉じる）へ渡さない', r.closes().length === 0 && r.dialog().hidden === true && prevented === 1);
      r.menus[0].items.at(-1).onClick();
      r.dialog().onclick({ target: r.dialog() });
      t.ok('外側を押すのも「やめる」', r.closes().length === 0 && r.dialog().hidden === true);
      r.menus[0].items.at(-1).onClick();
      r.yes().onclick();
      await flush();
      t.ok('「閉じる」で初めて、自分の会話の窓を閉じる（窓が 1 つなら windowId は送らない）',
        r.closes().length === 1 && r.closes()[0][1].sessionId === 'conv' && !('windowId' in r.closes()[0][1]) && r.dialog().hidden === true);
    }

    // ⋯ の窓の一覧に、browser.chromeWindows の子の行を足す（押すとその子の会話を開く）
    {
      const menus = [], opened = [], windows = createWindowTable();
      let toolbar = null, open = false, rows = [];
      const preview = { openPanel: opts => { toolbar = opts.toolbar; open = true; }, panelOpen: () => open, close: () => { open = false; } };
      windows.apply({ sessionId: 'conv', windows: 1, windowIds: [7], currentWindowId: 7 });
      const panel = setupChromePanel({ cmd: async name => (name === 'browserScreencast' ? { state: {} } : {}), preview, browser: {}, session: () => 'conv', windows,
        showMenu: (x, y, items, title) => menus.push({ items, title }), children: () => rows, openChild: id => opened.push(id) });
      panel.open();
      await flush();
      toolbar.at(-1).onclick();
      t.ok('子の窓が無ければ、一覧は閉じるだけ（「ウィンドウ n · 表示中」の行は無い）', menus[0].items.length === 1 && menus[0].items[0].label === '表示中のウィンドウを閉じる', JSON.stringify(menus[0].items.map(i => i.label)));
      rows = [{ sessionId: 'conv', taskId: null, title: null, windows: 1, state: 'idle' },
        { sessionId: 'a', taskId: 'ta', title: '調査', windows: 2, profileName: '仕事', state: 'running', waiting: true },
        { sessionId: 'gone', taskId: 'tg', title: '終了', windows: 0, state: 'idle' }];
      toolbar.at(-1).onclick();
      const labels = menus[1].items.map(item => item.label);
      const child = menus[1].items.find(item => /調査/.test(item.label ?? ''));
      t.ok('子の窓の行は、題・プロフィール・状態・依頼待ち・枚数を並べ、自分の行と窓の無い行は足さない',
        !!child && /仕事/.test(child.label) && /作業中/.test(child.label) && /依頼待ち/.test(child.label) && /2 ウィンドウ/.test(child.label)
        && !labels.some(label => /終了/.test(label ?? '')) && labels.filter(label => /子の会話のウィンドウ/.test(label ?? '')).length === 1, JSON.stringify(labels));
      child.onClick();
      t.ok('子の行を押すと、その子の会話を開く', opened.join() === 'a');
      t.ok('「表示中のウィンドウを閉じる」は最後のまま', menus[1].items.at(-1).label === '表示中のウィンドウを閉じる');
    }
  } finally {
    globalThis.requestAnimationFrame = old.raf; N.prototype.getBoundingClientRect = old.rect; N.prototype.toggleAttribute = old.toggle; globalThis.window = old.window;
  }
}
