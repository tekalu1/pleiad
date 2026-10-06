import { WebSocket } from 'ws';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { startFakeChrome } from '../lib/fake-chrome.mjs';
import { fakeChromeOs } from '../lib/fake-chrome-os.mjs';
import { createChromeConnection } from '../../core/chrome/connection.mjs';
import { createChromeRelay } from '../../core/chrome/relay.mjs';
import { createChromeWindows, nonceUrl, WINDOW_DIP } from '../../core/chrome/windows.mjs';
import { readLastUsedProfile, chromeHomes } from '../../core/chrome/locate.mjs';

export const name = 'chrome-windows';
export const title = '会話ごとの専用の Chrome の窓（ADR 0154）: chrome.exe の最初の窓・2 枚目からの窓・題の nonce で隠す・前面を返す・窓だけ閉じられた／Chrome が閉じた・popup の窓・bringToFront の握りつぶし・focus emulation（ターンの間だけ）（偽の OS の層と偽の Chrome）';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, ms = 3000) {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) return false;
    await sleep(10);
  }
  return true;
}

/** エージェントの側（agent-browser の代わり）。受けた生の文字列も全部残す */
function agent(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const events = [], raw = [], waiting = new Map();
    let next = 0;
    ws.on('message', data => {
      const text = data.toString();
      raw.push(text);
      const msg = JSON.parse(text);
      if (msg.id !== undefined) { waiting.get(msg.id)?.(msg); waiting.delete(msg.id); }
      else events.push(msg);
    });
    ws.once('open', () => resolve({
      ws, events, raw,
      cmd(method, params = {}, sessionId) {
        const id = ++next;
        return new Promise(done => { waiting.set(id, done); ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); });
      },
      closed: new Promise(done => ws.once('close', (code, reason) => done({ code, reason: reason.toString() }))),
      close() { ws.close(); },
    }));
    ws.once('error', reject);
  });
}

const TIMING = { hwndWaitMs: 200, hwndPollMs: 10, targetWaitMs: 500, targetPollMs: 10, popupWaitMs: 200 };

async function rig({ custom = true, localState } = {}) {
  const chrome = await startFakeChrome({ permission: 'auto' });
  if (localState !== undefined) await writeFile(path.join(chrome.userDataDir, 'Local State'), localState);
  const os_ = fakeChromeOs({ chrome });
  const conn = createChromeConnection({ locate: { browser: 'chrome', userDataDir: chrome.userDataDir }, os: os_, pollMs: 20 });
  const logs = [];
  const locate = { browser: 'chrome', userDataDir: chrome.userDataDir, ...(custom ? { custom: true } : {}) };
  const scope = createChromeWindows({ os: os_, locate, log: line => logs.push(line), timing: TIMING });
  const relay = createChromeRelay({ connection: conn, os: os_, locate, scope, log: line => logs.push(line) });
  const live = [];
  return {
    chrome, conn, relay, logs, os: os_, scope, fake: chrome.browser,
    /** 会話の端点につないだエージェント */
    async agent(sessionId, options = {}) {
      const a = await agent(await relay.endpoint(sessionId, options));
      live.push(a);
      return a;
    },
    async stop() { for (const a of live) { try { a.close(); } catch { /* 閉じていてもよい */ } } relay.close(); await conn.close(); await chrome.stop(); },
  };
}

const hwndOf = (r, windowId) => r.os.hwnds().find(h => h.windowId === windowId);
const tabInfo = (r, targetId) => r.fake.targets().find(x => x.targetId === targetId);
const concealedOk = h => h?.concealed === true && h.alpha === 0 && h.ex.toolwindow && h.ex.layered && h.ex.transparent && !h.ex.appwindow;

export default async function (t) {
  // ===== 1. 最初の窓: chrome.exe（--user-data-dir・プロフィール・画面の外の位置と大きさ）→ 題の nonce で見つけて隠す =====
  {
    const r = await rig();
    try {
      const a = await r.agent('one');
      const before = r.os.getForeground();
      const created = await a.cmd('Target.createTarget', { url: 'about:blank' });
      const tabId = created.result?.targetId;
      const launches = r.os.calls('launchWindow');
      t.ok('会話の最初の窓は chrome.exe で開く（launchWindow 1 回。Chrome へ createTarget の新しい窓は頼まない）', !!tabId && launches.length === 1 && !r.chrome.calls.some(c => c.method === 'Target.createTarget'), JSON.stringify(created));
      const args = launches[0]?.args ?? {};
      t.ok('AGENT_HOST_CHROME_USER_DATA があるとき（locate.custom）は --user-data-dir にその User Data を渡す', args.userDataDir === r.chrome.userDataDir, JSON.stringify(args));
      t.ok('プロフィールは Local State が無ければ Default', args.profileDir === 'Default');
      t.ok('窓の位置・大きさは、仮想デスクトップの右の外と決めた大きさ（DIP）を渡す（一瞬見えるのを避ける）', args.position?.x === 6000 && args.size?.width === WINDOW_DIP.width && args.size?.height === WINDOW_DIP.height, JSON.stringify(args));
      t.ok('URL は題に nonce を持つ data: のページで、nonce が渡される', args.url === nonceUrl(args.nonce) && /^[a-f0-9]{16}$/.test(args.nonce), String(args.url));
      const tab = tabInfo(r, tabId);
      t.ok('窓は最小化せず、画面の外の決めた大きさ', r.fake.windows().find(w => w.windowId === tab?.windowId)?.state === 'normal' && r.fake.windowBounds(tab.windowId).left === 6000 && r.fake.windowBounds(tab.windowId).width === 1100);
      const hw = hwndOf(r, tab?.windowId);
      t.ok('題の nonce で窓を見つけて隠す（画面の外・タスクバーと Alt+Tab から外す・透明度 0・マウスの素通し）', concealedOk(hw) && hw.agent, JSON.stringify(hw));
      t.ok('最初のタブは nonce のページでなく、頼まれた URL（about:blank）', tab?.url === 'about:blank' && !a.raw.some(text => text.includes('PLY-')) && !r.logs.some(line => line.includes(args.nonce)));
      t.ok('エージェントには自分のタブだけが見える', JSON.stringify((await a.cmd('Target.getTargets')).result.targetInfos.map(x => x.targetId)) === JSON.stringify([tabId]));
      t.ok('前面は取られていない（最初から前に戻す対象が無いか、取られても返す）', r.os.getForeground() === before);
      t.ok('窓を 1 つだけ開く', r.fake.windows().filter(w => w.windowId !== r.fake.userWindow).length === 1);

      // 2 枚目のタブ: 新しい窓（createTarget に画面の外の位置・大きさ。題の nonce で見つけて隠す）
      const second = await a.cmd('Target.createTarget', { url: 'about:blank' });
      const secondTab = tabInfo(r, second.result?.targetId);
      const newWindowCalls = r.chrome.calls.filter(c => c.method === 'Target.createTarget');
      t.ok('2 枚目のタブは新しい窓（createTarget の newWindow・background。画面の外の位置と大きさ）。chrome.exe は起こさない', !!secondTab && secondTab.windowId !== tab.windowId
        && newWindowCalls.length === 1 && newWindowCalls[0].params.newWindow === true && newWindowCalls[0].params.background === true && newWindowCalls[0].params.left === 6000 && newWindowCalls[0].params.width === 1100
        && r.os.calls('launchWindow').length === 1, JSON.stringify(newWindowCalls));
      t.ok('その窓も隠す', concealedOk(hwndOf(r, secondTab?.windowId)));
      t.ok('createTarget には nonce の data: のページで頼み、頼まれた URL へ移してから返す', newWindowCalls[0].params.url.startsWith('data:text/html,<title>PLY-') && secondTab.url === 'about:blank');
      t.ok('どの窓も最小化・復元の windowState を上りへ送っていない', !r.chrome.calls.some(c => c.method === 'Browser.setWindowBounds' && c.params.bounds?.windowState));

      // 別の会話は別の窓
      const b = await r.agent('two');
      const other = await b.cmd('Target.createTarget', { url: 'about:blank' });
      t.ok('別の会話は別の最初の窓（chrome.exe をもう 1 回）', !!other.result?.targetId && r.os.calls('launchWindow').length === 2 && tabInfo(r, other.result.targetId).windowId !== tab.windowId);
      t.ok('会話の窓は会話ごとに分かれる（窓の記録）', r.scope.windows('one').length === 2 && r.scope.windows('two').length === 1 && r.scope.windows('one').every(w => w.ref?.id));
    } finally { await r.stop(); }
  }

  // ===== 2. 既定の User Data のときは --user-data-dir を付けない。Local State は profile.last_used だけ読む =====
  {
    const secret = 'alice-secret@example.com';
    const state = JSON.stringify({ profile: { last_used: 'Profile 2', info_cache: { 'Profile 2': { name: 'Work', user_name: secret, gaia_name: 'Alice Secret' } } }, os_crypt: { encrypted_key: 'SECRET-KEY' } });
    const r = await rig({ custom: false, localState: state });
    try {
      const a = await r.agent('one');
      await a.cmd('Target.createTarget', { url: 'about:blank' });
      const args = r.os.calls('launchWindow')[0]?.args ?? {};
      t.ok('既定の User Data（custom でない）のときは --user-data-dir を付けない', args.userDataDir == null && !JSON.stringify(args).includes('user-data-dir') && !JSON.stringify(args).includes(r.chrome.userDataDir), JSON.stringify(args));
      t.ok('プロフィールは Local State の profile.last_used', args.profileDir === 'Profile 2');
      t.ok('プロフィール名・アカウント・鍵は、ログにも OS の層にも出ない', ![secret, 'Alice Secret', 'SECRET-KEY', 'Work'].some(s => JSON.stringify(r.os.log).includes(s) || r.logs.join('\n').includes(s)));
    } finally { await r.stop(); }
    const dir = (await startFakeChrome({ permission: 'auto' }));
    try {
      const read = async text => { await writeFile(path.join(dir.userDataDir, 'Local State'), text); return readLastUsedProfile(dir.userDataDir); };
      t.ok('壊れた JSON・last_used が無い・形が違う値は Default', await read('{broken') === 'Default' && await read('{}') === 'Default' && await read('{"profile":{"last_used":42}}') === 'Default'
        && await read('{"profile":{"last_used":"..\\\\x"}}') === 'Default' && await read('{"profile":{"last_used":"--evil"}}') === 'Default');
      t.ok('Profile 1 のような名前はそのまま', await read('{"profile":{"last_used":"Profile 1"}}') === 'Profile 1');
      t.ok('Local State が無い User Data も Default', await readLastUsedProfile(path.join(dir.userDataDir, 'nothing')) === 'Default');
    } finally { await dir.stop(); }
    t.ok('chromeHomes は環境変数で差し替えたときだけ custom', chromeHomes({ platform: 'win32', env: { LOCALAPPDATA: 'C:\\L', AGENT_HOST_CHROME_USER_DATA: 'D:\\t' } })[0].custom === true && chromeHomes({ platform: 'win32', env: { LOCALAPPDATA: 'C:\\L' } })[0].custom === undefined);
  }

  // ===== 3. 窓が見つからない・隠せない・chrome.exe が使えない =====
  {
    const r = await rig();
    try {
      r.os.opts.hideNonce = true;
      const a = await r.agent('one');
      const created = await a.cmd('Target.createTarget', { url: 'about:blank' });
      const tab = tabInfo(r, created.result?.targetId);
      t.ok('題で見つからなくても、窓の外形（Browser.getWindowForTarget の bounds）で見つけて隠す', !!tab && concealedOk(hwndOf(r, tab.windowId)) && r.os.calls('findWindowByBounds').length >= 1);
      r.os.opts.hideBounds = true;
      const second = await a.cmd('Target.createTarget', { url: 'about:blank' });
      const secondTab = tabInfo(r, second.result?.targetId);
      t.ok('題でも外形でも見つからなければ、隠せなかったとログに出して続ける（エージェントの操作は止めない・窓は隠れない）', !!secondTab && hwndOf(r, secondTab.windowId)?.concealed === false
        && r.logs.some(line => line.includes('window not found, so it was not hidden')), r.logs.join(' | '));
      t.ok('隠せなかった窓もエージェントの範囲に入る', (await a.cmd('Target.getTargets')).result.targetInfos.length === 2);
    } finally { await r.stop(); }
  }
  {
    const r = await rig();
    try {
      r.os.opts.concealFails = true;
      const a = await r.agent('one');
      const created = await a.cmd('Target.createTarget', { url: 'about:blank' });
      t.ok('conceal が失敗しても続ける（ログに残す）', !!created.result?.targetId && r.logs.some(line => line.includes('conceal failed')));
    } finally { await r.stop(); }
  }
  {
    const r = await rig();
    try {
      r.os.opts.launchFails = true;
      const a = await r.agent('one');
      const created = await a.cmd('Target.createTarget', { url: 'about:blank' });
      const tab = tabInfo(r, created.result?.targetId);
      t.ok('chrome.exe を起こせなければ、createTarget の新しい窓に落とす（隠す・ログに残す）', !!tab && r.os.calls('launchWindow').length === 1
        && r.chrome.calls.filter(c => c.method === 'Target.createTarget').length === 1 && concealedOk(hwndOf(r, tab.windowId)) && r.logs.some(line => line.includes('launching chrome.exe failed')));
    } finally { await r.stop(); }
  }
  {
    const r = await rig();
    try {
      r.os.opts.chromeMissing = true;
      const a = await r.agent('one');
      const created = await a.cmd('Target.createTarget', { url: 'about:blank' });
      const tab = tabInfo(r, created.result?.targetId);
      t.ok('chrome.exe が見つからなければ chrome.exe は起こさず createTarget の新しい窓（隠す）', !!tab && r.os.calls('launchWindow').length === 0 && r.os.calls('locateBrowser').length === 1 && concealedOk(hwndOf(r, tab.windowId))
        && r.logs.some(line => line.includes('chrome.exe not found')));
    } finally { await r.stop(); }
  }
  {
    // 窓が開かない（nonce のタブが現れない）ときは失敗を返す
    const r = await rig();
    try {
      const a = await r.agent('one');
      r.os.opts.launchFails = true;
      const original = r.os.launchWindow;
      r.os.launchWindow = async args => { await original(args); return { ok: true }; };   // 起こせたと言うが、窓は出ない（launchFails で偽の Chrome に窓ができない）
      const created = await a.cmd('Target.createTarget', { url: 'about:blank' });
      t.ok('窓が現れなければ createTarget はエラーで返す（エージェントを黙って待たせない）', !!created.error && /did not open/.test(created.error.message), JSON.stringify(created));
    } finally { await r.stop(); }
  }

  // ===== 4. 前面を取られたら返す =====
  {
    const r = await rig();
    try {
      r.os.windowsStealForeground(true);
      r.os.setForeground('app-notes');
      const a = await r.agent('one');
      await a.cmd('Target.createTarget', { url: 'about:blank' });
      t.ok('最初の窓が前面を取っても、直前の前面（開く前に前面だった窓）へ返す', r.os.getForeground() === 'app-notes' && r.os.calls('yieldForeground').length >= 1, `${r.os.getForeground()} ${JSON.stringify(r.os.calls('yieldForeground'))}`);
      const yielded = r.os.calls('yieldForeground').at(-1);
      t.ok('返す先は開く前の前面（foreground() で受けた ref）', yielded.to === 'app-notes', JSON.stringify(yielded));
      await a.cmd('Target.createTarget', { url: 'about:blank' });
      t.ok('2 枚目の窓も同じ', r.os.getForeground() === 'app-notes');
      t.ok('前面を返すとき、窓を前に出す raise は一度も呼ばない', r.os.calls('raise').length === 0);
    } finally { await r.stop(); }
  }
  {
    const r = await rig();
    try {
      r.os.setForeground('app-notes');
      const a = await r.agent('one');
      await a.cmd('Target.createTarget', { url: 'about:blank' });
      t.ok('前面を取られていなければ、前面はそのまま', r.os.getForeground() === 'app-notes');
    } finally { await r.stop(); }
  }

  // ===== 5. 同じ会話の同時の createTarget は最初の窓を 1 つだけ開く。会話の id の付け替え =====
  {
    const r = await rig();
    try {
      const a = await r.agent('one');
      const [x, y] = await Promise.all([a.cmd('Target.createTarget', { url: 'about:blank' }), a.cmd('Target.createTarget', { url: 'about:blank' })]);
      t.ok('同時に頼まれても最初の窓（chrome.exe）は 1 回だけ、窓は 2 つ', !x.error && !y.error && r.os.calls('launchWindow').length === 1 && r.scope.windows('one').length === 2, JSON.stringify([x, y]));
      r.relay.rebind('one', 'real-id');
      t.ok('会話の id が決まっても窓の記録は付いてくる', r.scope.windows('one').length === 0 && r.scope.windows('real-id').length === 2);
      r.relay.forget('real-id');
      t.ok('会話を消したら記録を捨てる（窓を閉じるのは第 8 段）', r.scope.windows('real-id').length === 0 && r.fake.windows().filter(w => w.windowId !== r.fake.userWindow).length === 2);
    } finally { await r.stop(); }
  }

  // ===== 6. 専用の窓だけが閉じられた → 次に使うときに黙って開き直す。Chrome が閉じた → 窓の記録を捨てる =====
  {
    const r = await rig();
    try {
      const a = await r.agent('one');
      const first = await a.cmd('Target.createTarget', { url: 'about:blank' });
      const firstWindow = tabInfo(r, first.result.targetId).windowId;
      await a.cmd('Target.setDiscoverTargets', { discover: true });
      r.fake.closeWindow(firstWindow);
      t.ok('窓を閉じると、その窓の記録を捨てて ref を手放す（release）', await until(() => r.scope.windows('one').length === 0 && r.os.calls('release').length === 1));
      t.ok('範囲からも消え、エージェントに targetDestroyed が届く', await until(() => a.events.some(e => e.method === 'Target.targetDestroyed' && e.params.targetId === first.result.targetId)) && (await a.cmd('Target.getTargets')).result.targetInfos.length === 0);
      t.ok('窓が閉じても、中継の接続は生きている（エージェントの接続は切れない・接続の状態は connected のまま）', r.conn.state().state === 'connected' && a.ws.readyState === 1);
      const again = await a.cmd('Target.createTarget', { url: 'about:blank' });
      t.ok('次に使うときに黙って開き直す（chrome.exe をもう 1 回・新しい窓も隠す）', !again.error && r.os.calls('launchWindow').length === 2 && concealedOk(hwndOf(r, tabInfo(r, again.result.targetId)?.windowId)), JSON.stringify(again));
      // 別の窓が残っていれば、最初の窓が閉じられても新しいタブはその会話の窓として足される（chrome.exe は起こさない）
      const extra = await a.cmd('Target.createTarget', { url: 'about:blank' });
      const mainWindow = r.scope.windows('one').find(w => w.role === 'main')?.windowId;
      r.fake.closeWindow(mainWindow);
      await until(() => r.scope.windows('one').length === 1);
      const third = await a.cmd('Target.createTarget', { url: 'about:blank' });
      t.ok('別の窓が残っている間は、最初の窓が閉じられても chrome.exe は起こさない', !extra.error && !third.error && r.os.calls('launchWindow').length === 2);
    } finally { await r.stop(); }
  }
  {
    const r = await rig();
    try {
      const a = await r.agent('one');
      await a.cmd('Target.createTarget', { url: 'about:blank' });
      await a.cmd('Target.createTarget', { url: 'about:blank' });
      await r.chrome.restart();   // Chrome を閉じて開き直した（ポートと経路が変わる。接続が切れる）
      const closed = await a.closed;
      t.ok('Chrome が閉じたら、エージェントの接続を閉じる（1011）', closed.code === 1011);
      t.ok('接続は off（chrome-closed）になる', await until(() => r.conn.state().state === 'off' && r.conn.state().reason === 'chrome-closed'), JSON.stringify(r.conn.state()));
      t.ok('窓の記録を全部捨てて ref を手放す（窓はもう無い）', r.scope.windows('one').length === 0 && r.os.calls('release').length === 2);
      const b = await r.agent('one');
      const created = await b.cmd('Target.createTarget', { url: 'about:blank' });
      t.ok('つなぎ直せば最初の窓から開き直す（chrome.exe をもう 1 回）', !created.error && r.os.calls('launchWindow').length === 2, JSON.stringify(created));
    } finally { await r.stop(); }
  }

  // ===== 7. window.open: タブは同じ窓。popup の別窓は範囲に足し、同じ置き方を当てる =====
  {
    const r = await rig();
    try {
      r.fake.setPage('https://open.example/', { title: 'Opener', elements: [
        { role: 'link', name: 'tab', open: { url: 'https://open.example/tab' } },
        { role: 'link', name: 'popup', open: { url: 'https://open.example/popup', popup: true } },
      ] });
      r.os.windowsStealForeground(true);
      r.os.setForeground('app-notes');
      const a = await r.agent('one');
      const created = await a.cmd('Target.createTarget', { url: 'https://open.example/' });
      const tabId = created.result.targetId;
      const sid = (await a.cmd('Target.attachToTarget', { targetId: tabId, flatten: true })).result.sessionId;
      await a.cmd('Target.setDiscoverTargets', { discover: true });
      const hwndsBefore = r.os.hwnds().length;
      await a.cmd('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 20, y: 40, button: 'left' }, sid);   // 1 つ目（同じ窓のタブ）
      t.ok('window.open のタブは同じ窓に入る（範囲に入り、窓も HWND も増えない）', await until(() => a.events.some(e => e.method === 'Target.targetCreated' && e.params.targetInfo.openerId === tabId)) && r.os.hwnds().length === hwndsBefore && r.os.calls('findWindowByBounds').length === 0);
      await a.cmd('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 20, y: 70, button: 'left' }, sid);   // 2 つ目（popup の別窓）
      const popupTab = await until(() => r.fake.targets().some(x => x.url === 'https://open.example/popup'));
      const popup = r.fake.targets().find(x => x.url === 'https://open.example/popup');
      t.ok('popup の別窓ができる（偽の Chrome の既定で左上・324×298）', popupTab && JSON.stringify(r.fake.windowBounds(popup.windowId)).includes('"width":324'));
      t.ok('popup の窓を、外形（Browser.getWindowBounds）で見つけて隠す', await until(() => concealedOk(hwndOf(r, popup?.windowId))), JSON.stringify(hwndOf(r, popup?.windowId)));
      t.ok('popup の窓も会話の範囲に入る（窓の大きさを見られる）', !(await a.cmd('Browser.getWindowBounds', { windowId: popup.windowId })).error && r.scope.windows('one').some(w => w.windowId === popup.windowId && w.role === 'popup'));
      t.ok('窓が前面を取っても（popup は前面を取る）、見張りの層に任せて core は raise しない', r.os.calls('raise').length === 0);

      // popup の窓が見つからない・窓が閉じられた
      r.os.opts.hideBounds = true;
      await a.cmd('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 20, y: 70, button: 'left' }, sid);
      t.ok('popup の窓が見つからなければ、ログに出して続ける（投げない）', await until(() => r.logs.some(line => line.includes('popup window not found'))));
    } finally { await r.stop(); }
  }

  // ===== 8. Page.bringToFront・Target.activateTarget は Chrome へ送らずに成功で返す =====
  {
    const r = await rig();
    try {
      const a = await r.agent('one');
      const created = await a.cmd('Target.createTarget', { url: 'about:blank' });
      const tabId = created.result.targetId;
      const sid = (await a.cmd('Target.attachToTarget', { targetId: tabId, flatten: true })).result.sessionId;
      const userTab = r.fake.targets().find(x => x.windowId === r.fake.userWindow).targetId;
      const callsBefore = r.chrome.calls.length;
      const bring = await a.cmd('Page.bringToFront', {}, sid);
      const activate = await a.cmd('Target.activateTarget', { targetId: tabId });
      const foreign = await a.cmd('Target.activateTarget', { targetId: userTab });
      const missing = await a.cmd('Target.activateTarget', {});
      t.ok('bringToFront は {} で成功を返す', !bring.error && JSON.stringify(bring.result) === '{}');
      t.ok('範囲のタブへの activateTarget は {} で成功を返す', !activate.error && JSON.stringify(activate.result) === '{}');
      t.ok('範囲の外（利用者のタブ）・targetId が無い activateTarget は今までどおり断る', !!foreign.error && !!missing.error);
      t.ok('どれも Chrome（上り）へ送らない', !r.chrome.calls.slice(callsBefore).some(c => c.method === 'Page.bringToFront' || c.method === 'Target.activateTarget'));
      t.ok('窓の状態（最小化・戻す）も変わらない', r.fake.windows().find(w => w.windowId === tabInfo(r, tabId).windowId)?.state === 'normal' && concealedOk(hwndOf(r, tabInfo(r, tabId).windowId)));
      const b = await r.agent('two');
      const otherSid = (await b.cmd('Target.attachToTarget', { targetId: tabId, flatten: true }));
      t.ok('ほかの会話のタブ・セッションには効かない（今までどおり断る）', !!otherSid.error && !!(await b.cmd('Page.bringToFront', {}, sid)).error);
    } finally { await r.stop(); }
  }

  // ===== 9. focus emulation: ターンの間だけ、窓のタブすべてに、中継自身のセッションで保つ =====
  {
    const r = await rig();
    try {
      const feSessions = () => r.fake.sessions().filter(s => s.fe);
      const a = await r.agent('one');   // endpoint() がターンの始まり
      const first = (await a.cmd('Target.createTarget', { url: 'about:blank' })).result.targetId;
      t.ok('ターンの間に作ったタブには、中継のセッションで Emulation.setFocusEmulationEnabled(true) が付く', await until(() => r.fake.focusEmulated(first)));
      const second = (await a.cmd('Target.createTarget', { url: 'about:blank' })).result.targetId;
      t.ok('タブが増えたら足す', await until(() => r.fake.focusEmulated(second)) && r.fake.focusEmulated(first));
      const agentSession = (await a.cmd('Target.attachToTarget', { targetId: first, flatten: true })).result.sessionId;
      t.ok('FE はエージェントのセッションではなく、中継自身のセッション（エージェントの sessionId とは別）', feSessions().length === 2 && !feSessions().some(s => s.id === agentSession));
      await a.cmd('Target.detachFromTarget', { sessionId: agentSession });
      t.ok('エージェントのセッションを外しても FE は切れない', r.fake.focusEmulated(first) && feSessions().length === 2);
      const again = (await a.cmd('Target.attachToTarget', { targetId: first, flatten: true })).result.sessionId;
      t.ok('付け直しても FE はそのまま（セッションを増やさない・2 本）', !!again && feSessions().length === 2 && r.fake.focusEmulated(first));
      a.close();
      await sleep(50);
      t.ok('エージェントの接続が閉じても、ターンの間は FE を保つ', r.fake.focusEmulated(first) && r.fake.focusEmulated(second));

      r.relay.endTurn('one');
      t.ok('ターンが終わったら FE を外し、中継のセッションも外す', await until(() => !r.fake.focusEmulated(first) && !r.fake.focusEmulated(second) && feSessions().length === 0 && r.fake.sessions().length === 0), JSON.stringify(r.fake.sessions()));
      t.ok('FE を外すとき Emulation.setFocusEmulationEnabled(false) も送る', r.chrome.calls.some(c => c.method === 'Emulation.setFocusEmulationEnabled' && c.params.enabled === false));

      await r.relay.endpoint('one');   // 次のターンの始まり
      t.ok('次のターンの始まりで、前からある窓のタブに FE を付け直す', await until(() => r.fake.focusEmulated(first) && r.fake.focusEmulated(second)));
      r.relay.stop('one');
      t.ok('止める（stop）と FE を外す', await until(() => !r.fake.focusEmulated(first) && !r.fake.focusEmulated(second) && feSessions().length === 0));
      await r.relay.endpoint('one');
      t.ok('止めている間は、端点を取っても FE は付かない（次の人の送信で開けるまで）', !r.fake.focusEmulated(first));
      await r.relay.endpoint('one', { unlock: true });
      t.ok('人の送信で開け直すと、また付く', await until(() => r.fake.focusEmulated(first)));

      // Chrome の側が FE のセッションを外したら、ターンの間は付け直す
      const [victim] = feSessions().filter(s => s.targetId === first);
      r.fake.detachSession(victim.id);
      t.ok('Chrome の側で FE のセッションが外されたら、ターンの間は付け直す', await until(() => r.fake.focusEmulated(first) && feSessions().filter(s => s.targetId === first).length === 1 && feSessions().find(s => s.targetId === first).id !== victim.id));

      // タブが閉じられたら消える（残骸・エラーにならない）
      const b = await r.agent('one');
      await b.cmd('Target.closeTarget', { targetId: second });
      t.ok('タブを閉じても、ほかのタブの FE は残り、閉じたタブの分は消える', await until(() => feSessions().length === 1) && r.fake.focusEmulated(first));
      t.ok('FE の失敗はログに出ない（正常な道）', !r.logs.some(line => line.includes('focus emulation failed')), r.logs.join(' | '));
    } finally { await r.stop(); }
  }
  {
    // ターンの外で作った窓には付けない。popup のタブにも、ターンの間は付ける。会話ごとに別
    const r = await rig();
    try {
      r.fake.setPage('https://fe.example/', { title: 'FE', elements: [{ role: 'link', name: 'pop', open: { url: 'https://fe.example/pop', popup: true } }] });
      const url = await r.relay.endpoint('one');      // ターンの始まり
      const a = await agent(url);
      const one = (await a.cmd('Target.createTarget', { url: 'https://fe.example/' })).result.targetId;
      const sid = (await a.cmd('Target.attachToTarget', { targetId: one, flatten: true })).result.sessionId;
      await a.cmd('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 20, y: 40, button: 'left' }, sid);
      const pop = await until(() => r.fake.targets().find(x => x.url === 'https://fe.example/pop'));
      const popId = r.fake.targets().find(x => x.url === 'https://fe.example/pop')?.targetId;
      t.ok('ターンの間に開いた popup のタブにも FE を付ける', pop && await until(() => r.fake.focusEmulated(popId)));
      const b = await r.agent('two', {});
      const other = (await b.cmd('Target.createTarget', { url: 'about:blank' })).result.targetId;
      r.relay.endTurn('two');
      await until(() => !r.fake.focusEmulated(other));
      t.ok('会話ごとに別（two のターンが終わっても one の FE は残る）', r.fake.focusEmulated(one) && !r.fake.focusEmulated(other));
      const c = await agent(await r.relay.endpoint('three'));
      r.relay.endTurn('three');
      const late = (await c.cmd('Target.createTarget', { url: 'about:blank' })).result.targetId;
      await sleep(80);
      t.ok('ターンが終わった会話が後からタブを作っても FE は付かない（ターンの外）', !r.fake.focusEmulated(late));
      a.close(); b.close(); c.close();
    } finally { await r.stop(); }
  }
}
