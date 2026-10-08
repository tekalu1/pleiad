import net from 'node:net';
import { startFakeChrome } from '../lib/fake-chrome.mjs';
import { fakeChromeOs } from '../lib/fake-chrome-os.mjs';
import { fakeClock } from '../lib/fake-clock.mjs';
import { startHolder } from '../lib/holder-harness.mjs';
import { createChromeConnection } from '../../core/chrome/connection.mjs';
import { openChromeLink } from '../../core/chrome/link.mjs';

export const name = 'chrome-link-adopt';
export const title = '接続の子から引き継ぐ接続: 入れ替わりで確認が出ない・確認待ちの続き・異常終了・接続の子が居ないとき（本物の保持役と接続の子・偽の Chrome と偽の OS の層。ADR 0167）';

const until = async (cond, ms = 5000, what = '') => {
  const end = Date.now() + ms;
  for (;;) {
    if (await cond()) return true;
    if (Date.now() > end) throw new Error(`timeout: ${what || cond.toString().slice(0, 80)}`);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
};

export default async function (t) {
  const holder = await startHolder();
  const cleanups = [];
  const newServer = async (chrome, os, clock) => {
    const { client } = await holder.connect();
    const link = await openChromeLink({ holder: client, runtimeRoot: holder.root, runtimeKey: 'adopt' });
    const conn = createChromeConnection({ locate: { browser: 'chrome', userDataDir: chrome.userDataDir }, os, clock, link, pollMs: 1000 });
    const states = [];
    conn.onChange(s => states.push(`${s.state}${s.reason ? `/${s.reason}` : ''}${s.state === 'permission' ? (s.dialog ? '+d' : '-d') : ''}`));
    return { link, conn, states };
  };
  const seen = async (chrome, clock) => { await until(() => chrome.pending() >= 1, 5000, 'dialog pending'); await clock.advance(250); };
  /** 前の場面の接続の子を片付ける（場面ごとに別の偽の Chrome につなぐため） */
  const clearChildren = async () => {
    for (let i = 0; i < 30; i++) {
      const { client } = await holder.connect();
      const children = client.welcome?.children ?? [];
      if (!children.length) return;
      for (const child of children) {
        if (!child.alive) { client.release(child.id); continue; }
        await client.attach(child.id).catch(() => null);
        client.kill(child.id, { tree: true });
      }
      await new Promise(resolve => setTimeout(resolve, 150));
    }
    throw new Error('connection child did not go away');
  };
  const startChrome = async () => {
    await clearChildren();
    const chrome = await startFakeChrome({ permission: 'hold' });
    cleanups.push(() => chrome.stop());
    return { chrome, clock: fakeClock(), os: fakeChromeOs({ chrome }) };
  };

  try {
    // ===== 1. 接続の子の経由でつなぐ（許可 → connected）。入れ替わっても確認は出ない =====
    {
      const { chrome, clock, os } = await startChrome();
      const a = await newServer(chrome, os, clock);
      t.ok('接続の子の経由: はじめは何も持っていない（adopt は false・off のまま）', await a.conn.adopt() === false && a.conn.state().state === 'off');
      const first = a.conn.demand();
      await seen(chrome, clock);
      t.ok('接続の子の経由: 確認が出て permission（窓も見つかる）', a.conn.state().state === 'permission' && a.conn.state().dialog === true && chrome.upgrades === 1, JSON.stringify(a.conn.state()));
      chrome.approve();
      const cdp = await first;
      t.ok('接続の子の経由: 許可で connected・product が載る', a.conn.state().state === 'connected' && a.conn.state().product === 'Chrome/154.0.8037.97' && typeof cdp.send === 'function');

      // サーバーの入れ替わり（引き継ぎ）
      a.conn.handOff();
      await a.link.handOff();
      const b = await newServer(chrome, os, clock);
      t.ok('入れ替わり: 新しいサーバーの adopt は true・確認なしで connected', await b.conn.adopt() === true && b.conn.state().state === 'connected' && b.conn.state().product === 'Chrome/154.0.8037.97', JSON.stringify(b.conn.state()));
      t.ok('入れ替わり: Chrome への upgrade は増えない・permission を経ない', chrome.upgrades === 1 && !b.states.some(s => s.startsWith('permission')), `${chrome.upgrades} ${b.states.join()}`);
      const cdp2 = await b.conn.demand();
      const targets = await cdp2.send('Target.getTargets');
      t.ok('入れ替わり: 引き継いだ接続で CDP が往復する（番号は前のサーバーの後から）', targets.targetInfos.length >= 2 && b.link.welcome.firstId > 1000, String(b.link.welcome.firstId));

      // 異常終了（handOff なしでパイプが切れる）→ 次のサーバーが拾う
      b.link.socket.destroy();
      await until(() => b.conn.state().state === 'off', 5000, 'conn off after pipe lost');
      t.ok('異常終了: パイプが切れると接続は off（自動でつなぎ直さない）', b.conn.state().state === 'off' && ['revoked', 'chrome-closed'].includes(b.conn.state().reason), JSON.stringify(b.conn.state()));
      const c = await newServer(chrome, os, clock);
      t.ok('異常終了: 次のサーバーは同じ接続を確認なしで拾う', await c.conn.adopt() === true && c.conn.state().state === 'connected' && chrome.upgrades === 1, `${chrome.upgrades} ${JSON.stringify(c.conn.state())}`);

      // 接続の子との縁が切れたままなら、このプロセスの中の ws に落ちる
      c.link.socket.destroy();
      await until(() => c.conn.state().state === 'off', 5000, 'conn off after pipe lost');
      const d = c.conn.demand();
      await seen(chrome, clock);
      t.ok('縁が切れたまま: このプロセスの ws で張り直す（確認が出る）', chrome.upgrades === 2 && c.conn.state().state === 'permission', `${chrome.upgrades} ${c.conn.state().state}`);
      chrome.approve();
      await d;
      t.ok('縁が切れたまま: 許可で connected', c.conn.state().state === 'connected');
      const pipeAlive = await new Promise(resolve => { const sk = net.connect(c.link.pipe); sk.on('connect', () => { sk.destroy(); resolve(true); }); sk.on('error', () => resolve(false)); });
      t.ok('縁が切れたまま: 内の ws に落ちるとき、接続の子は終わらせる（古い ws を持ったまま残らない）', !pipeAlive);
      await c.conn.close();
    }

    // ===== 2. 確認待ち（permission）の間に入れ替わる: 続きから許可を待つ =====
    {
      const { chrome, clock, os } = await startChrome();
      const a = await newServer(chrome, os, clock);
      const first = a.conn.demand();
      first.catch(() => {});
      await seen(chrome, clock);
      const closesBefore = os.calls('close').length;
      a.conn.handOff();
      await a.link.handOff();
      t.ok('確認待ちの入れ替わり: 出ていく側は確認の窓を閉じない・upgrade を捨てない', os.calls('close').length === closesBefore && chrome.pending() === 1);
      const firstResult = await first.then(() => 'resolved', e => e?.code);
      t.ok('確認待ちの入れ替わり: 出ていく側の待ちは closed で外れる', firstResult === 'closed', String(firstResult));
      const b = await newServer(chrome, os, clock);
      t.ok('確認待ちの入れ替わり: 新しいサーバーの welcome は upgrading', b.link.welcome.phase === 'upgrading' && b.link.welcome.upgradeAt > 0);
      t.ok('確認待ちの入れ替わり: adopt は true・permission を続ける（upgrade は増えない）', await b.conn.adopt() === true && b.conn.state().state === 'permission' && chrome.upgrades === 1, JSON.stringify(b.conn.state()));
      await clock.advance(250);
      await until(() => b.conn.state().dialog === true, 3000, 'dialog found again');
      t.ok('確認待ちの入れ替わり: 確認の窓を探し直して見つける', b.conn.state().dialog === true);
      const waiting = b.conn.demand();
      chrome.approve();
      const cdp = await waiting;
      t.ok('確認待ちの入れ替わり: 許可で connected（確認は 1 回のまま）', b.conn.state().state === 'connected' && chrome.upgrades === 1 && typeof cdp.send === 'function', JSON.stringify(b.conn.state()));
      t.ok('確認待ちの入れ替わり: 許可後の CDP が往復する', (await cdp.send('Browser.getVersion')).product === 'Chrome/154.0.8037.97');
      await b.conn.close();
      await b.link.quit();
    }

    // ===== 3. 確認待ちの入れ替わりの後の「キャンセル」は denied（403 が接続の子を通って届く） =====
    {
      const { chrome, clock, os } = await startChrome();
      const a = await newServer(chrome, os, clock);
      const first = a.conn.demand().catch(e => e);
      await seen(chrome, clock);
      a.conn.handOff();
      await a.link.handOff();
      await first;
      const b = await newServer(chrome, os, clock);
      await b.conn.adopt();
      chrome.cancel();
      await until(() => b.conn.state().state === 'denied', 5000, 'denied');
      t.ok('確認待ちの入れ替わり: 入れ替わった後の「キャンセル」は denied/cancel', b.conn.state().state === 'denied' && b.conn.state().reason === 'cancel', JSON.stringify(b.conn.state()));
      await b.conn.close();
      await b.link.quit();
    }
  } finally {
    for (const fn of cleanups) { try { await fn(); } catch { /* 片付け */ } }
    await holder.stop();
  }
}
