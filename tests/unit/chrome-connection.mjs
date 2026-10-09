import { startFakeChrome } from '../lib/fake-chrome.mjs';
import { fakeChromeOs } from '../lib/fake-chrome-os.mjs';
import { fakeClock } from '../lib/fake-clock.mjs';
import path from 'node:path';
import { createChromeConnection, ChromeConnectionError } from '../../core/chrome/connection.mjs';
import { chromeHomes } from '../../core/chrome/locate.mjs';

export const name = 'chrome-connection';
export const title = 'Chrome への接続: A〜D の状態機械・無期限の待ち・確認の出し直し・OS の層が無いとき（偽の Chrome と偽の OS の層。ADR 0148・0153）';

const until = async (cond, ms = 5000, what = '') => {
  const end = Date.now() + ms;
  for (;;) {
    if (await cond()) return true;
    if (Date.now() > end) throw new Error(`timeout: ${what || cond.toString().slice(0, 80)}`);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
};
const code = p => p.then(() => null, e => e?.code ?? String(e));

async function rig(options = {}) {
  const { permission = 'hold', supported = true, noHome = false, pollMs = 1000, ...rest } = options;
  const chrome = await startFakeChrome({ permission });
  const clock = fakeClock();
  const os = fakeChromeOs({ chrome, supported });
  const conn = createChromeConnection({ locate: noHome ? null : { browser: 'chrome', userDataDir: chrome.userDataDir }, os, clock, pollMs, ...rest });
  const states = [];
  conn.onChange(s => states.push(`${s.state}${s.reason ? `/${s.reason}` : ''}${s.state === 'permission' ? (s.dialog ? '+d' : '-d') : ''}`));
  // 確認が出て、探す側が見つけるまで（探す間隔は偽の時計で進める）
  const seen = async (n = 1) => { await until(() => chrome.pending() >= n, 5000, 'dialog pending'); await clock.advance(250); };
  const stop = async () => { await conn.close(); await chrome.stop(); };
  return { chrome, clock, os, conn, states, seen, stop };
}

export default async function (t) {
  // ===== 1. トグルがオフ → A。オンになれば自動で B。許可で D。時間では打ち切らない =====
  {
    const r = await rig();
    await r.chrome.turnOff();
    const first = r.conn.demand();
    await until(() => r.conn.state().state === 'setup');
    t.ok('DevToolsActivePort が無い → setup（reason は null。トグルを一度もオンにしていない）', r.conn.state().state === 'setup' && r.conn.state().reason === null && r.chrome.upgrades === 0);
    await r.clock.advance(3_600_000);
    t.ok('時計を 1 時間進めても setup のまま（打ち切らない）', r.conn.state().state === 'setup' && r.os.log.length === 0);
    await r.chrome.turnOn();
    await r.clock.advance(1000);
    await until(() => r.chrome.pending() === 1);
    t.ok('ファイルを書く（トグルをオン）→ 押し直さずに permission へ', r.conn.state().state === 'permission' && r.chrome.upgrades === 1);
    await r.clock.advance(250);
    r.chrome.approve();
    const cdp = await first;
    const s = r.conn.state();
    t.ok('approve → connected・product が載る・待っていた demand が cdp で解ける', s.state === 'connected' && s.product === 'Chrome/154.0.8037.97' && typeof cdp.send === 'function', JSON.stringify(s));
    t.ok('第 2 段で上りへ送る CDP は Browser.getVersion だけ（Target.* は送らない）', r.chrome.calls.map(c => c.method).join() === 'Browser.getVersion', r.chrome.calls.map(c => c.method).join());
    await r.stop();
  }

  // ===== 0b. 確認の窓を探すときは、DevToolsActivePort のポートを OS の層へ渡す =====
  {
    const r = await rig();
    const first = r.conn.demand();
    await r.seen();
    r.chrome.approve();
    await first;
    const finds = r.os.calls('findPermissionDialog');
    t.ok('確認の窓を探すときは DevToolsActivePort のポートを渡す（別の User Data の Chrome の窓と取り違えない）', finds.length > 0 && finds.every(e => e.port === r.chrome.port), JSON.stringify(finds.map(e => e.port)));
    await r.stop();
  }

  // ===== 0. User Data の場所: AGENT_HOST_CHROME_USER_DATA があればそれだけ（確かめ・開発用の差し替え） =====
  {
    const win = { LOCALAPPDATA: 'C:\\Users\\x\\AppData\\Local' };
    const def = chromeHomes({ platform: 'win32', env: win });
    t.ok('既定（Windows）は %LOCALAPPDATA%\\Google\\Chrome\\User Data が先頭（接続に使う）', def[0].browser === 'chrome' && def[0].userDataDir === path.join(win.LOCALAPPDATA, 'Google', 'Chrome', 'User Data'), JSON.stringify(def));
    t.ok('2 つ目は Edge の User Data（プロフィールの一覧の口）', def.length === 2 && def[1].browser === 'edge' && def[1].userDataDir === path.join(win.LOCALAPPDATA, 'Microsoft', 'Edge', 'User Data'), JSON.stringify(def));
    const over = chromeHomes({ platform: 'win32', env: { ...win, AGENT_HOST_CHROME_USER_DATA: 'D:\\chrome-test' } });
    t.ok('AGENT_HOST_CHROME_USER_DATA があれば、それだけを返す（既定の場所は混ぜない）', over.length === 1 && over[0].userDataDir === 'D:\\chrome-test', JSON.stringify(over));
    const overLinux = chromeHomes({ platform: 'linux', env: { AGENT_HOST_CHROME_USER_DATA: '/tmp/chrome-test' } });
    t.ok('差し替えは OS に依らない（ほかの OS でも確かめ用に使える）', overLinux.length === 1 && overLinux[0].userDataDir === '/tmp/chrome-test', JSON.stringify(overLinux));
    t.ok('空文字は差し替えとみなさない', chromeHomes({ platform: 'win32', env: { ...win, AGENT_HOST_CHROME_USER_DATA: '' } })[0].userDataDir === def[0].userDataDir);
    t.ok('ほかの OS で差し替えが無ければ使えない（空）', chromeHomes({ platform: 'linux', env: {} }).length === 0);
  }

  // ===== 2. 古い DevToolsActivePort（ポートにつながらない）→ setup =====
  {
    const r = await rig();
    const dead = r.chrome.port;
    await r.chrome.turnOff();
    await r.chrome.writeStale(dead);
    const p = r.conn.demand(); void p.catch(() => {});
    await until(() => r.conn.state().state === 'setup');
    await r.clock.advance(5000);
    t.ok('古いポート（つながらない）→ setup のまま。upgrade は投げない', r.conn.state().state === 'setup' && r.chrome.upgrades === 0);
    t.ok('ファイルはあるのにつながらない setup は reason unreachable（Chrome を閉じた後もファイルは残るので、閉じているだけかもしれない）', r.conn.state().reason === 'unreachable', JSON.stringify(r.conn.state()));
    r.conn.giveUp();
    t.ok('「やめる」で off/declined、待っていた demand は declined で失敗', r.conn.state().state === 'off' && r.conn.state().reason === 'declined' && await code(p) === 'declined');
    await r.stop();
  }

  // ===== 3. demand を 3 人 → upgrade は 1 回、同じ cdp =====
  {
    const r = await rig();
    const all = Promise.all([r.conn.demand(), r.conn.demand(), r.conn.demand()]);
    await r.seen();
    t.ok('3 人が待っていても upgrade は 1 回', r.chrome.upgrades === 1 && r.chrome.pending() === 1);
    r.chrome.approve();
    const [a, b, c] = await all;
    t.ok('3 人とも同じ cdp を受け取る', a === b && b === c);
    const again = await r.conn.demand();
    t.ok('つながった後の demand は upgrade しない', again === a && r.chrome.upgrades === 1);
    await r.stop();
  }

  // ===== 4. B の入り方: snapshot → find → raise（1 回）、「ダイアログを前に出す」でもう一度 =====
  {
    const r = await rig();
    const p = r.conn.demand(); void p.catch(() => {});
    await r.seen();
    const ops = r.os.log.map(e => e.op);
    t.ok('B に入ると snapshotWindows → findPermissionDialog → raise の順で、raise は 1 回', ops.indexOf('snapshotWindows') < ops.indexOf('findPermissionDialog') && ops.indexOf('findPermissionDialog') < ops.indexOf('raise') && r.os.calls('raise').length === 1, ops.join());
    t.ok('確認の窓を見つけたので dialog: true', r.conn.state().dialog === true);
    t.ok('確認の窓は front に出した（偽の前面が確認の窓になる）', r.os.getForeground() === r.chrome.dialogs()[0].id);
    const result = await r.conn.raiseDialog();
    t.ok('raiseDialog() で raise がもう一度', r.os.calls('raise').length === 2 && result.ok === true);
    r.conn.giveUp(); await code(p);
    await r.stop();

    const h = await rig();
    h.os.hideDialogs(true);
    const q = h.conn.demand(); void q.catch(() => {});
    await h.seen();
    await h.clock.advance(4000);
    t.ok('確認が見つからなくても B のまま待つ（dialog: false。raise しない）', h.conn.state().state === 'permission' && h.conn.state().dialog === false && h.os.calls('raise').length === 0);
    h.chrome.approve();
    await q;
    await h.stop();
  }

  // ===== 5. キャンセル → denied、もう一度、やめる =====
  {
    const r = await rig();
    const p = r.conn.demand(); void p.catch(() => {});
    await r.seen();
    r.chrome.cancel();
    await until(() => r.conn.state().state === 'denied');
    t.ok('「キャンセル」（すぐ失敗）→ denied / cancel', r.conn.state().reason === 'cancel' && r.chrome.upgrades === 1);
    await r.conn.retry();
    await until(() => r.chrome.upgrades === 2 && r.chrome.pending() === 1);
    t.ok('retry() でもう一度 upgrade し、B に戻る', r.conn.state().state === 'permission');
    await r.seen();
    r.chrome.cancel();
    await until(() => r.conn.state().state === 'denied');
    r.conn.giveUp();
    t.ok('denied で giveUp() → off、待っていた demand は declined で失敗', r.conn.state().state === 'off' && await code(p) === 'declined');
    t.ok('denied の間に出た確認はもう無い', r.chrome.dialogs().length === 0);
    await r.stop();
  }

  // ===== 5b. 想定外の応答（403 以外の HTTP）は protocol。確認を残さない =====
  {
    const r = await rig({ permission: 'error' });
    const p = r.conn.demand();
    t.ok('403 以外の HTTP の応答は protocol で失敗し、off / protocol（denied にはしない）', await code(p) === 'protocol' && r.conn.state().state === 'off' && r.conn.state().reason === 'protocol', JSON.stringify(r.conn.state()));
    await r.stop();
  }

  // ===== 6. 出し直し: 270 秒ごとに確認を閉じてつなぎ直す。denied にならず、字は変わらない =====
  {
    const r = await rig();
    const demand = r.conn.demand();
    await r.seen();
    const before = r.states.length;
    await r.clock.advance(270_000);
    await until(() => r.chrome.upgrades === 2 && r.chrome.pending() === 1, 5000, 'reissue 1');
    t.ok('270 秒で確認を閉じ（close）、すぐ upgrade し直す。確認は常に 1 つ', r.os.calls('close').length === 1 && r.chrome.upgrades === 2 && r.chrome.dialogs().length === 1);
    t.ok('出し直しでは denied にならず B のまま、onChange は何も足さない', r.conn.state().state === 'permission' && r.states.length === before && r.conn.info().round === 1, `${r.states.join(' ')} round=${r.conn.info().round}`);
    for (let i = 2; i <= 10; i++) {
      await r.clock.advance(270_000);
      await until(() => r.chrome.upgrades === i + 1 && r.chrome.pending() === 1, 5000, `reissue ${i}`);
    }
    t.ok('270 秒ずつ 10 回進めても B のまま、upgrade は 11 回、確認は 1 つ、画面の状態は 1 度も変わらない',
      r.conn.state().state === 'permission' && r.chrome.upgrades === 11 && r.chrome.dialogs().length === 1 && r.states.length === before, `${r.states.join(' ')}`);
    await r.clock.advance(250);
    r.chrome.approve();
    const cdp = await demand;
    t.ok('最後に approve → connected、待っていた demand が解ける', r.conn.state().state === 'connected' && typeof cdp.send === 'function');
    await r.stop();
  }

  // ===== 7. 出し直しでは前に出さない。前面を取られたら返す（直前の前面がブラウザーなら返さない） =====
  {
    const r = await rig();
    const p = r.conn.demand(); void p.catch(() => {});
    await r.seen();
    t.ok('最初の確認は前に出す（raise 1 回）', r.os.calls('raise').length === 1);
    r.os.setForeground('app-notes');
    r.os.dialogStealsForeground(true);
    await r.clock.advance(270_000);
    await until(() => r.chrome.upgrades === 2 && r.chrome.pending() === 1);
    await r.clock.advance(250);
    await until(() => r.os.calls('yieldForeground').length === 1);
    const y = r.os.calls('yieldForeground')[0];
    t.ok('出し直しの確認は raise しない（raise は 1 回のまま）', r.os.calls('raise').length === 1);
    t.ok('出し直しの確認が前面を取ったら、直前の前面（メモ帳）へ yieldForeground で返す', y.to === 'app-notes' && r.os.getForeground() === 'app-notes', JSON.stringify(y));
    r.conn.giveUp(); await code(p);
    await r.stop();

    const b = await rig();
    const q = b.conn.demand(); void q.catch(() => {});
    await b.seen();
    b.os.setForeground('chrome-main', { browser: true });
    b.os.dialogStealsForeground(true);
    await b.clock.advance(270_000);
    await until(() => b.chrome.upgrades === 2 && b.chrome.pending() === 1);
    await b.clock.advance(2000);
    t.ok('直前の前面がブラウザーの窓なら、返さない', b.os.calls('yieldForeground').length === 0 && b.os.calls('raise').length === 1);
    b.conn.giveUp(); await code(q);
    await b.stop();
  }

  // ===== 8. Chrome が先に打ち切る・キャンセルとの見分け =====
  {
    const r = await rig({ reissueMs: 1e9 });
    const p = r.conn.demand(); void p.catch(() => {});
    await r.seen();
    await r.clock.advance(295_000);
    r.chrome.expire();
    await until(() => r.chrome.upgrades === 2 && r.chrome.pending() === 1, 5000, 'expiry reissue');
    t.ok('290 秒以降の失敗（Chrome の打ち切り）は denied にならず、残った確認を閉じて出し直す', r.conn.state().state === 'permission' && r.os.calls('close').length >= 1 && r.chrome.dialogs().length === 1, r.states.join(' '));
    await r.seen(1);
    await r.clock.advance(100_000);
    r.chrome.cancel();
    await until(() => r.conn.state().state === 'denied');
    t.ok('出し直した確認から 290 秒より前の失敗は「キャンセル」（denied）', r.conn.state().reason === 'cancel');
    r.conn.giveUp(); await code(p);
    await r.stop();
  }

  // ===== 9. B の間にトグルをオフにした → A。トグルを戻すと自動で B（最初の 1 回として前に出す） =====
  {
    const r = await rig();
    const p = r.conn.demand(); void p.catch(() => {});
    await r.seen();
    t.ok('前提: 1 回目の B で raise 済み', r.os.calls('raise').length === 1);
    await r.chrome.turnOff();
    await until(() => r.conn.state().state === 'setup');
    t.ok('turnOff()（トグルをオフにした）→ setup。denied にならない', r.conn.state().state === 'setup' && !r.states.includes('denied/cancel'));
    await r.chrome.turnOn();
    await r.clock.advance(1000);
    await r.seen();
    t.ok('トグルを戻す（ファイルが書かれる）→ 自動で B、round は 0 から、最初の 1 回として前に出す（raise が 2 回目）', r.conn.state().state === 'permission' && r.conn.info().round === 0 && r.os.calls('raise').length === 2);
    r.chrome.approve();
    await p;
    await r.stop();
  }

  // ===== 10. つながった後の切れ方。自動ではつなぎ直さない =====
  for (const [label, how, reason] of [
    ['Chrome が閉じた（ファイルが消える）', c => c.stop(), 'chrome-closed'],
    ['Chrome を開き直した（ポートが変わる）', c => c.restart(), 'chrome-closed'],
    ['許可の取り消し（ws だけ閉じる）', async c => c.dropConnections(), 'revoked'],
  ]) {
    const r = await rig({ permission: 'auto' });
    await r.conn.demand();
    await how(r.chrome);
    await until(() => r.conn.state().state === 'off', 5000, label);
    await r.clock.advance(60_000);
    t.ok(`${label} → off / ${reason}。自動ではつなぎ直さない（upgrade 1 回のまま）`, r.conn.state().reason === reason && r.chrome.upgrades <= 1, `${r.conn.state().reason} upgrades=${r.chrome.upgrades}`);
    await r.conn.close();
    if (label.startsWith('Chrome が閉じた')) { /* stop 済み */ } else await r.chrome.stop();
  }

  // ===== 11. 切る・終了は、B の途中でも確認を閉じる =====
  {
    const r = await rig();
    const p = r.conn.demand(); void p.catch(() => {});
    await r.seen();
    r.conn.disconnect();
    await until(() => r.chrome.dialogs().length === 0);
    t.ok('disconnect() は B の途中でも確認を閉じて off、待っていた demand は declined', r.conn.state().state === 'off' && await code(p) === 'declined' && r.chrome.pending() === 0);
    await r.stop();

    const c = await rig();
    const q = c.conn.demand(); void q.catch(() => {});
    await c.seen();
    await c.conn.close();
    t.ok('close()（Pleiad の終了）は B の途中でも確認を閉じる（Chrome に確認を残さない）', c.chrome.dialogs().length === 0 && c.chrome.pending() === 0 && await code(q) === 'closed');
    await c.stop();

    const d = await rig({ permission: 'auto' });
    await d.conn.demand();
    d.conn.disconnect();
    t.ok('つながっているときの「切る」→ off / disconnected、ws は閉じる', d.conn.state().state === 'off' && d.conn.state().reason === 'disconnected');
    await until(() => d.chrome.openCount() === 0);
    await d.stop();
  }

  // ===== 12. demand の abort =====
  {
    const r = await rig();
    const a = new AbortController(), b = new AbortController();
    const pa = r.conn.demand({ signal: a.signal }), pb = r.conn.demand({ signal: b.signal });
    void pa.catch(() => {}); void pb.catch(() => {});
    await r.seen();
    a.abort();
    t.ok('abort はその人だけを外す', await code(pa) === 'aborted' && r.conn.state().state === 'permission');
    b.abort();
    await until(() => r.conn.state().state === 'off');
    t.ok('待つ人がいなくなれば、試行も止めて確認を閉じる', await code(pb) === 'aborted' && r.chrome.dialogs().length === 0);

    // 設定の「つなぐ」から始めた試行は、待つ人が外れても続く
    await r.conn.connect();
    await r.seen();
    const c = new AbortController();
    const pc = r.conn.demand({ signal: c.signal }); void pc.catch(() => {});
    c.abort(); await code(pc);
    await r.clock.advance(1000);
    t.ok('「つなぐ」から始めた試行は、demand が外れても止まらない', r.conn.state().state === 'permission' && r.chrome.dialogs().length === 1);
    r.chrome.approve();
    await until(() => r.conn.state().state === 'connected');
    await r.stop();
  }

  // ===== 13. OS の層が無い・場所の表が空 → unsupported =====
  {
    const r = await rig({ supported: false });
    t.ok('os が unsupported → unsupported で固定', r.conn.state().state === 'unsupported' && r.conn.state().reason === 'platform');
    t.ok('demand() はすぐ unsupported で失敗し、upgrade も OS の層の口も呼ばない', await code(r.conn.demand()) === 'unsupported' && r.chrome.upgrades === 0 && r.os.log.length === 0);
    await r.conn.connect();
    t.ok('connect() は何もしない（upgrade 0 回）', r.chrome.upgrades === 0 && r.conn.state().state === 'unsupported');
    await r.stop();
    const n = await rig({ noHome: true });
    t.ok('場所の表が空（locate: null）でも unsupported / platform、upgrade しない', n.conn.state().state === 'unsupported' && await code(n.conn.demand()) === 'unsupported' && n.chrome.upgrades === 0);
    await n.stop();
  }

  // ===== 13b. つながっている接続は、OS の層が（更新の先で、まだ）付いていなくても渡す。層は待たない（ADR 0167）=====
  {
    const r = await rig({ permission: 'auto' });
    const cdp = await r.conn.demand();
    r.os.opts.readyWaitMs = 5000;   // 層が付くまで ready() は待たされる（本物の口と同じ）
    r.os.setPending(true);
    const got = await Promise.race([r.conn.demand(), new Promise(resolve => setTimeout(() => resolve('waiting'), 500))]);
    t.ok('層が pending の間も、つながっていれば demand() はすぐ同じ接続を返す（層の ready を待たない）', got === cdp && r.conn.state().state === 'connected', String(got));
    r.os.setPending(false);
    await r.stop();
  }

  // ===== 14. 確認を閉じずに ws だけ閉じると確認が残る（実機の事実）→ 確認の窓を見つけていないときの出し直しは、探して閉じる =====
  {
    const r = await rig();
    r.os.hideDialogs(true);
    const p = r.conn.demand(); void p.catch(() => {});
    await r.seen();
    t.ok('前提: 確認は見つかっていない', r.conn.state().dialog === false);
    r.os.hideDialogs(false);
    await r.clock.advance(270_000);
    await until(() => r.chrome.upgrades === 2 && r.chrome.pending() === 1, 5000, 'reissue without dialog');
    t.ok('確認を見つけていなくても、出し直しで古い確認を探して閉じ、確認は 1 つのまま', r.conn.state().state === 'permission' && r.chrome.dialogs().length === 1, JSON.stringify(r.chrome.dialogs()));
    r.conn.giveUp(); await code(p);
    t.ok('ChromeConnectionError は code を持つ', new ChromeConnectionError('declined').code === 'declined');
    await r.stop();
  }
}
