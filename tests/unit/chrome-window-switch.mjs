import { setupChromePanel, createWindowTable } from '../../web/chrome-panel.mjs';
import { N } from '../lib/dom-stub.mjs';

export const name = 'chrome-window-switch';
export const title = '右パネル「Chrome の映像」の見るウィンドウの切り替え: 番号のチップ・固定と追う・印の移動・閉じたウィンドウからの戻り・引き継ぎ中の無効・閉じる確かめ（DOM の代役）';

const flush = () => new Promise(resolve => setTimeout(resolve, 0));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

function rig({ paused = false, risk = null, failPin = false } = {}) {
  const commands = [], menus = [];
  const windows = createWindowTable();
  let body = null, toolbar = null, panelOpen = false, isPaused = paused;
  const preview = { openPanel: opts => { body = opts.body; toolbar = opts.toolbar; panelOpen = true; }, panelOpen: () => panelOpen, close: () => { panelOpen = false; } };
  const panel = setupChromePanel({
    cmd: async (name, args) => {
      commands.push([name, args]);
      if (name === 'browserScreencast') return { state: { suspended: false } };
      if (name === 'chromePinWindow') { if (failPin) throw new Error('pin failed'); return { pinnedWindowId: args.windowId }; }
      return {};
    },
    preview, browser: {}, session: () => 'conv', windows, paused: () => isPaused, closeRisk: () => risk,
    showMenu: (x, y, items, title) => menus.push({ items, title }),
  });
  const ev = (ids, current, extra = {}) => ({ sessionId: 'conv', windows: ids.length, windowIds: ids, currentWindowId: current, ...extra });
  const send = (...args) => { const e = ev(...args); panel.windowEvent(e); return e; };
  const chips = () => body.querySelectorAll('.cp-sw-chip');
  const selected = () => chips().filter(chip => chip.attrs['aria-selected'] === 'true').map(chip => chip.querySelector('.cp-sw-num').textContent);
  const agentChips = () => chips().filter(chip => 'data-agent' in chip.attrs).map(chip => chip.querySelector('.cp-sw-num').textContent);
  return { panel, windows, commands, menus, ev, send, chips, selected, agentChips, body: () => body, toolbar: () => toolbar,
    root: () => body.querySelector('.cp-sw'), screen: () => body.querySelector('.cp-screen'), follow: () => body.querySelector('.cp-sw-follow'),
    pins: () => commands.filter(([name]) => name === 'chromePinWindow').map(([, args]) => args), setPaused: value => { isPaused = value; },
    frame: seq => panel.onMessage({ source: 'chrome', sessionId: 'conv', type: 'frame', seq, data: 'AAAA', metadata: { deviceWidth: 390, deviceHeight: 700 } }),
    dialog: () => body.querySelector('.cp-dlg'), yes: () => body.querySelector('.cp-dlg-yes'), no: () => body.querySelector('.btn-quiet') };
}

export default async function (t) {
  const old = { raf: globalThis.requestAnimationFrame, rect: N.prototype.getBoundingClientRect, toggle: N.prototype.toggleAttribute, window: globalThis.window };
  globalThis.requestAnimationFrame = fn => { queueMicrotask(fn); return 1; };
  N.prototype.getBoundingClientRect = () => ({ left: 0, top: 0, right: 400, bottom: 300, width: 400, height: 300 });
  N.prototype.toggleAttribute = function (name, on) { if (on) this.setAttribute(name, ''); else this.removeAttribute(name); };
  globalThis.window = { innerHeight: 800, devicePixelRatio: 1 };
  try {
    // 窓が 1 つなら何も足さない。2 つ以上で番号のチップが出る
    {
      const r = rig();
      r.windows.apply(r.ev([7], 7));
      r.panel.open();
      await flush();
      t.ok('窓が 1 つなら、チップの列は開かない（何も足さない）', r.chips().length <= 1 && !('data-open' in r.root().attrs));
      r.send([7, 9], 7);
      t.ok('窓が 2 つになると、番号のチップの列が開く', 'data-open' in r.root().attrs && r.chips().length === 2);
      t.ok('チップは 1、2 の番号で、tablist の中の tab', r.chips().map(chip => chip.querySelector('.cp-sw-num').textContent).join() === '1,2'
        && r.chips().every(chip => chip.attrs.role === 'tab') && r.body().querySelector('.cp-sw-list').attrs.role === 'tablist');
      t.ok('追っている間は、エージェントのいるウィンドウが選ばれ、そのチップに印が付く', r.selected().join() === '1' && r.agentChips().join() === '1');
      t.ok('固定の印は出さない', !('data-pinned' in r.screen().attrs));
      t.ok('選ばれたチップだけがタブ移動の対象（roving tabindex）', r.chips().map(chip => chip.attrs.tabindex).join() === '0,-1');
      t.ok('追う側のボタンは「追っている」状態（aria-pressed）', r.follow().attrs['aria-pressed'] === 'true' && r.follow().classList.contains('on'));
    }

    // 押すと固定して映像が替わる。追うを押すと解ける
    {
      const r = rig();
      r.windows.apply(r.ev([7, 9], 7));
      r.panel.open();
      await flush();
      r.frame(1);
      r.chips()[1].onclick();
      t.ok('チップを押すと、そのウィンドウを固定する命令を送る', JSON.stringify(r.pins()) === JSON.stringify([{ sessionId: 'conv', windowId: 9 }]));
      t.ok('サーバーの知らせを待たず、押したチップが選ばれ、固定の印が出る', r.selected().join() === '2' && 'data-pinned' in r.screen().attrs);
      await flush();
      r.send([7, 9], 7, { pinnedWindowId: 9 });
      t.ok('サーバーから固定が届いても、選びは変わらない', r.selected().join() === '2' && 'data-pinned' in r.screen().attrs);
      t.ok('固定中は、選ばれたチップの読み上げに「固定中」が入る', /固定/.test(r.chips()[1].attrs['aria-label']));
      t.ok('固定中は、追うボタンは「追っていない」状態', r.follow().attrs['aria-pressed'] === 'false' && !r.follow().classList.contains('on') && 'data-away' in r.follow().attrs);

      // 固定している間にエージェントが別のウィンドウへ移っても、映像は動かない。印だけ移って 1 回光る
      r.send([7, 9], 9, { pinnedWindowId: 9 });
      r.send([7, 9], 7, { pinnedWindowId: 9 });
      t.ok('固定中にエージェントが移っても、映像のウィンドウは動かず、印だけ移る', r.selected().join() === '2' && r.agentChips().join() === '1');
      t.ok('印が移ったチップは 1 回光る', r.chips()[0].classList.contains('flash'));

      r.follow().onclick();
      t.ok('追うボタンで固定を解く命令を送る（windowId は null）', JSON.stringify(r.pins().at(-1)) === JSON.stringify({ sessionId: 'conv', windowId: null }));
      await flush();
      r.send([7, 9], 7, { pinnedWindowId: null });
      t.ok('固定を解くと、エージェントのウィンドウに戻る', r.selected().join() === '1' && !('data-pinned' in r.screen().attrs));
      t.ok('戻りの動きとして、追うボタンが 1 回光る', r.follow().classList.contains('flash'));
      r.follow().onclick();
      t.ok('追っている間に追うボタンを押すと、映っているウィンドウを固定する（承認済みのモックと同じ）', JSON.stringify(r.pins().at(-1)) === JSON.stringify({ sessionId: 'conv', windowId: 7 }));
    }

    // 矢印キー
    {
      const r = rig();
      r.windows.apply(r.ev([7, 9, 11], 7));
      r.panel.open();
      await flush();
      let prevented = 0;
      r.chips()[0].onkeydown({ key: 'ArrowRight', preventDefault: () => { prevented++; } });
      r.chips()[1].onkeydown({ key: 'End', preventDefault: () => { prevented++; } });
      r.chips()[2].onkeydown({ key: 'Home', preventDefault: () => { prevented++; } });
      r.chips()[0].onkeydown({ key: 'ArrowLeft', preventDefault: () => { prevented++; } });
      t.ok('→ ・End ・Home ・← で、隣・端のウィンドウを選ぶ（左端で ← は動かない）', r.pins().map(p => p.windowId).join() === '9,11,7,7' && prevented === 4);
      r.chips()[0].onkeydown({ key: 'a', preventDefault: () => { prevented++; } });
      t.ok('ほかのキーは奪わない', prevented === 4 && r.pins().length === 4);
    }

    // 引き継ぎ中は切り替えられない
    {
      const r = rig({ paused: true });
      r.windows.apply(r.ev([7, 9], 7));
      r.panel.open();
      await flush();
      t.ok('引き継ぎ中は、チップも追うボタンも押せず、列を薄くする', r.chips().every(chip => chip.disabled === true) && r.follow().disabled === true && 'data-paused' in r.root().attrs);
      r.chips()[1].onclick();
      r.follow().onclick();
      t.ok('引き継ぎ中に押しても、何も送らない', r.pins().length === 0);
      r.setPaused(false);
      r.panel.refresh();
      t.ok('引き継ぎが終わると、押せるようにもどる', r.chips().every(chip => chip.disabled === false) && r.follow().disabled === false && !('data-paused' in r.root().attrs));
      r.panel.setOperating(true);
      t.ok('この端末から操作している間も、切り替えられない', r.chips().every(chip => chip.disabled === true));
      r.panel.setOperating(false);
    }

    // 固定が失敗したら知らせて、選びを実際の状態に戻す
    {
      const r = rig({ failPin: true });
      // 知らせ（file-actions の notify）は document に直に出すので、代役の本体を用意する
      const saved = { body: document.body, query: document.querySelector };
      document.body = new N('body'); document.querySelector = sel => document.body.querySelector(sel);
      r.windows.apply(r.ev([7, 9], 7));
      r.panel.open();
      await flush();
      r.chips()[1].onclick();
      t.ok('押した直後は押したチップが選ばれる', r.selected().join() === '2');
      await flush();
      await flush();
      t.ok('固定できなかったら知らせ、選びは実際の状態に戻る', document.body.querySelector('.file-toast')?.textContent === 'pin failed' && r.selected().join() === '1' && !('data-pinned' in r.screen().attrs));
      document.body = saved.body; document.querySelector = saved.query;
    }

    // 見ているウィンドウが閉じたら、約 1 秒薄くして残し、追う側に戻る
    {
      const r = rig();
      r.windows.apply(r.ev([7, 9], 7));
      r.panel.open();
      await flush();
      r.frame(1);
      r.chips()[1].onclick();
      await flush();
      r.send([7, 9], 7, { pinnedWindowId: 9 });
      r.send([7], 7);
      t.ok('見ていたウィンドウが閉じると、映像を薄くして残す（閉じたチップも残る）', r.screen().classList.contains('ended') && r.chips().length === 2
        && r.chips()[1].classList.contains('ghost') && r.chips()[1].disabled === true);
      t.ok('薄くしている間は、固定の印も外れている（固定は解けている）', !('data-pinned' in r.screen().attrs));
      await wait(1100);
      t.ok('約 1 秒後に、追う側（残った窓）に戻る', !r.screen().classList.contains('ended') && r.chips().length <= 1 && !('data-open' in r.root().attrs));
    }
    {
      const r = rig();
      r.windows.apply(r.ev([7, 9], 7));
      r.panel.open();
      await flush();
      r.frame(1);
      r.send([9], 9);
      t.ok('追っていたウィンドウが閉じたときも、同じく薄くして残す', r.screen().classList.contains('ended'));
      await wait(1100);
      t.ok('1 秒後は列が閉じ、残ったウィンドウを映す', !r.screen().classList.contains('ended') && !('data-open' in r.root().attrs));
    }

    // ⋯ の「表示中のウィンドウを閉じる」: 映像に映っているウィンドウ（固定していればそれ）を、確かめてから閉じる
    {
      const r = rig({ risk: 'human' });
      r.windows.apply(r.ev([7, 9], 7));
      r.panel.open();
      await flush();
      r.chips()[1].onclick();
      await flush();
      r.send([7, 9], 7, { pinnedWindowId: 9 });
      r.toolbar().at(-1).onclick();
      const item = r.menus[0].items.at(-1);
      t.ok('⋯ の最後は「表示中のウィンドウを閉じる」。ウィンドウ n の行は無い', r.menus[0].items.length === 1 && item.label.length > 0);
      item.onClick();
      t.ok('確かめにはウィンドウの番号が入り、引き継ぎ中の注意が付く', r.dialog().hidden === false && /2/.test(r.body().querySelector('.cp-dlg-t').textContent)
        && r.body().querySelector('.cp-dlg-n') !== null);
      r.yes().onclick();
      await flush();
      const closes = r.commands.filter(([name]) => name === 'chromeCloseWindow');
      t.ok('「閉じる」で、固定している（映っている）ウィンドウだけを閉じる', closes.length === 1 && closes[0][1].windowId === 9 && closes[0][1].sessionId === 'conv');
    }
    {
      const r = rig();
      r.windows.apply(r.ev([7, 9], 9));
      r.panel.open();
      await flush();
      r.toolbar().at(-1).onclick();
      r.menus[0].items.at(-1).onClick();
      r.yes().onclick();
      await flush();
      const closes = r.commands.filter(([name]) => name === 'chromeCloseWindow');
      t.ok('固定していなければ、エージェントのいるウィンドウを閉じる', closes.length === 1 && closes[0][1].windowId === 9);
    }

    // 窓の番号は会話の中で安定する（閉じても詰めない）
    {
      const windows = createWindowTable();
      windows.apply({ sessionId: 'a', windows: 2, windowIds: [7, 9], currentWindowId: 7 });
      windows.apply({ sessionId: 'a', windows: 1, windowIds: [9], currentWindowId: 9 });
      windows.apply({ sessionId: 'a', windows: 2, windowIds: [9, 11], currentWindowId: 9 });
      t.ok('番号は出た順に付き、窓が閉じても詰めず、新しい窓は次の番号', windows.list('a').map(row => row.number).join() === '2,3');
      windows.apply({ sessionId: 'a', windows: 2, windowIds: [9, 11], currentWindowId: 9, pinnedWindowId: 11 });
      t.ok('固定したウィンドウをテーブルが覚える', windows.pinned('a') === 11 && windows.list('a').find(row => row.windowId === 11).pinned === true);
      windows.apply({ sessionId: 'a', windows: 1, windowIds: [9], currentWindowId: 9, pinnedWindowId: 11 });
      t.ok('ウィンドウに無い固定は無かったことにする', windows.pinned('a') === null);
    }
  } finally {
    globalThis.requestAnimationFrame = old.raf; N.prototype.getBoundingClientRect = old.rect; N.prototype.toggleAttribute = old.toggle; globalThis.window = old.window;
  }
}
