import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { startFakeChrome } from '../lib/fake-chrome.mjs';
import { startHolder, waitFor, sleep } from '../lib/holder-harness.mjs';
import { createCdp } from '../../core/chrome/cdp.mjs';
import { openChromeLink, shutdownHolderIfIdle, chromeLinkEnabled, readLinkCard, LINK_CARD_KIND, LINK_VERSION } from '../../core/chrome/link.mjs';
import { LineReader, peekLine, parseControl, controlLine, linkPipeName, CARRY_MAX_BYTES } from '../../core/chrome/link-wire.mjs';

const OLD_CHILD = fileURLToPath(new URL('../lib/link-old-child.mjs', import.meta.url));

export const name = 'chrome-link';
export const title = '接続の子（Chrome への ws を保持役の子が持つ）: パイプ・引き継ぎ・つなぎ手が居ない間・許可待ちの続き・版の不一致（偽の Chrome・本物の保持役と子。ADR 0167）';

const wsUrl = chrome => `ws://127.0.0.1:${chrome.port}${chrome.wsPath}`;
const opened = socket => new Promise((resolve, reject) => { socket.on('open', () => resolve(socket)); socket.on('close', () => reject(new Error('closed before open'))); });
const closed = socket => new Promise(resolve => socket.on('close', resolve));
const linkChildren = client => (client.welcome?.children ?? []).filter(c => c.label?.kind === LINK_CARD_KIND);

export default async function (t) {
  // ===== 0. 部品: 行の分け方・大きい行の種類・切り替え・札 =====
  {
    const lines = [];
    const reader = new LineReader({ onLine: line => lines.push(line.toString('utf8')) });
    reader.push(Buffer.from('{"id":1}\n{"id'));
    reader.push(Buffer.from('":2}\n\n!quit\n'));
    t.ok('LineReader: かたまりをまたぐ行を 1 行にまとめ、空行は捨てる', lines.join('|') === '{"id":1}|{"id":2}|!quit', lines.join('|'));
    const overflow = [];
    const small = new LineReader({ onLine: line => overflow.push(line.toString()), onOverflow: () => overflow.push('overflow'), maxBytes: 10 });
    small.push(Buffer.from('0123456789ABCDEF')); small.push(Buffer.from('GHI\nok\n'));
    t.ok('LineReader: 上限を超えた行は改行まで捨てて、次の行は読む', overflow.join('|') === 'overflow|ok', overflow.join('|'));
    const big = Buffer.from(`{"method":"Page.screencastFrame","params":{"data":"${'A'.repeat(200_000)}"},"sessionId":"S"}`);
    t.ok('peekLine: 大きい行も先頭の数百バイトだけで method を読む', peekLine(big).kind === 'event' && peekLine(big).method === 'Page.screencastFrame');
    t.ok('peekLine: 答えは id', peekLine(Buffer.from('{"id":42,"result":{}}')).id === 42);
    t.ok('parseControl: ! の行は名前と値、CDP の行は null', parseControl(Buffer.from(controlLine('open', { url: 'ws://x', gen: 1 }).trim())).value.gen === 1 && parseControl(Buffer.from('{"id":1}')) === null);
    t.ok('chromeLinkEnabled: 実行場所と引き継ぎが要り、off で使わない', chromeLinkEnabled({ runtimeRoot: 'R', handover: true, env: {} })
      && !chromeLinkEnabled({ runtimeRoot: '', handover: true, env: {} }) && !chromeLinkEnabled({ runtimeRoot: 'R', handover: false, env: {} })
      && !chromeLinkEnabled({ runtimeRoot: 'R', handover: true, env: { AGENT_HOST_CHROME_LINK: 'off' } }));
    t.ok('readLinkCard: 形が合わなければ null', readLinkCard({ kind: 'shell' }) === null && readLinkCard({ kind: LINK_CARD_KIND, v: 1, pipe: 'p', secret: 's' })?.pipe === 'p');
  }

  const holder = await startHolder();
  const chrome = await startFakeChrome({ permission: 'auto' });
  const cleanups = [];
  try {
    const parent = await holder.connect();
    const root = holder.root;

    // ===== 1. 起こす: 保持役の子として走り、札と welcome（idle）が揃う。ws を張り、CDP が往復する =====
    const link1 = await openChromeLink({ holder: parent.client, runtimeRoot: root, runtimeKey: 'k1' });
    t.ok('接続の子を起こす: welcome は idle・版が合う', link1 && link1.welcome.phase === 'idle' && link1.welcome.v === LINK_VERSION, JSON.stringify(link1?.welcome));
    const childId = (await waitFor(() => linkChildren(parent.client).length === 1 || (parent.client.welcome?.children ?? []).length, 1000, 'welcome').catch(() => true), null);
    const ws1 = new link1.WebSocketImpl(wsUrl(chrome));
    await opened(ws1);
    const cdp1 = createCdp(ws1, { firstId: link1.welcome.firstId });
    const version = await cdp1.send('Browser.getVersion');
    t.ok('パイプ越しに ws を張り、Browser.getVersion が往復する', version.product === 'Chrome/154.0.8037.97', JSON.stringify(version));
    const targets = (await cdp1.send('Target.getTargets')).targetInfos.filter(x => x.type === 'page');
    t.ok('Target.getTargets も通る（利用者のタブ 2 つ）', targets.length === 2);
    void childId;

    // ===== 2. 大きい行（映像のフレーム相当）を読み解かずに通す =====
    {
      const session = (await cdp1.send('Target.attachToTarget', { targetId: targets[0].targetId, flatten: true })).sessionId;
      const frames = [];
      cdp1.onSession(session, (method, params) => { if (method === 'Page.screencastFrame') frames.push(params); });
      await cdp1.send('Page.startScreencast', { format: 'jpeg' }, session);
      chrome.browser.screencastFrame(targets[0].targetId);
      await waitFor(() => frames.length >= 1, 3000, 'frame').catch(() => {});
      t.ok('映像のフレーム（Page.screencastFrame）がパイプ越しに届く', frames.length >= 1 && typeof frames[0].data === 'string' && frames[0].data.length > 0);
      await cdp1.send('Page.stopScreencast', {}, session);
    }

    // ===== 3. サーバーが入れ替わる: handOff → 新しいサーバーが同じ接続の子に付く。ws は切れず、確認も増えない =====
    const upgradesBefore = chrome.upgrades;
    cdp1.onClose(() => {});
    link1.setCarry({ v: 1, port: 5555, entries: [{ id: 'e1', key: 'K' }] });
    await link1.handOff();
    await sleep(50);
    const parent2 = await holder.connect();
    const link2 = await openChromeLink({ holder: parent2.client, runtimeRoot: root, runtimeKey: 'k1' });
    t.ok('入れ替わり: 新しいサーバーは同じ接続の子に付く（子は 1 つのまま）', link2 && linkChildren(parent2.client).length === 1 && link2.welcome.phase === 'open', JSON.stringify(link2?.welcome));
    t.ok('入れ替わり: 預けた carry がそのまま戻る', link2.welcome.carry?.port === 5555 && link2.welcome.carry.entries[0].key === 'K', JSON.stringify(link2.welcome.carry));
    t.ok('入れ替わり: firstId は前のサーバーが振った番号より大きい', link2.welcome.firstId > 1000, String(link2.welcome.firstId));
    t.ok('入れ替わり: Chrome への接続は増えない（確認が出ない）', chrome.upgrades === upgradesBefore);
    const ws2 = link2.adopted();
    const cdp2 = createCdp(ws2, { firstId: link2.welcome.firstId });
    const version2 = await cdp2.send('Browser.getVersion');
    t.ok('入れ替わり: 引き継いだ接続で CDP が往復する', version2.product === 'Chrome/154.0.8037.97');
    t.ok('入れ替わり: 前のサーバーが付けたセッションを覚えている（sessions）', Array.isArray(link2.welcome.sessions) && link2.welcome.sessions.length >= 1, JSON.stringify(link2.welcome.sessions));

    // ===== 4. つなぎ手が居ない間の Fetch.requestPaused は failRequest で返す =====
    {
      const page = link2.welcome.sessions.find(s => s.targetId)?.targetId ?? targets[0].targetId;
      const s = (await cdp2.send('Target.attachToTarget', { targetId: page, flatten: true })).sessionId;
      await cdp2.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] }, s);
      await link2.handOff();
      await sleep(50);
      // 別の接続（確認なしの偽の Chrome）から移動させる。止める側（Fetch.enable したセッション）は接続の子のもの
      const { WebSocket } = await import('ws');
      const raw = new WebSocket(wsUrl(chrome));
      await new Promise(resolve => raw.on('open', resolve));
      const other = createCdp(raw);
      const mine = (await other.send('Target.attachToTarget', { targetId: page, flatten: true })).sessionId;
      const nav = await other.send('Page.navigate', { url: 'https://paused.example/x' }, mine);
      t.ok('つなぎ手が居ない間: 止まった移動は BlockedByClient で失敗する（通らない）', /BLOCKED_BY_CLIENT/.test(nav.errorText ?? ''), JSON.stringify(nav));
      t.ok('つなぎ手が居ない間: 偽の Chrome が Fetch.failRequest を受けた', chrome.calls.some(c => c.method === 'Fetch.failRequest'));
      other.close();
      cleanups.push(() => raw.close());
    }

    // ===== 4b. 新しいつなぎ手が付いても、その手が Fetch.enable していないセッションの止まった要求は通さない。大きい行も同じ。答えの無いまま切れたら断る =====
    {
      const page = targets[0].targetId;
      const { WebSocket } = await import('ws');
      const raw = new WebSocket(wsUrl(chrome));
      await new Promise(resolve => raw.on('open', resolve));
      cleanups.push(() => raw.close());
      const other = createCdp(raw);
      const mine = (await other.send('Target.attachToTarget', { targetId: page, flatten: true })).sessionId;
      const within = (promise, ms) => Promise.race([promise, new Promise(resolve => setTimeout(() => resolve({ hung: true }), ms))]);
      const parentB = await holder.connect();
      const linkB = await openChromeLink({ holder: parentB.client, runtimeRoot: root, runtimeKey: 'k1' });
      const cdpB = createCdp(linkB.adopted(), { firstId: linkB.welcome.firstId });
      const nav = await within(other.send('Page.navigate', { url: 'https://between.example/x' }, mine), 3000);
      t.ok('welcome と bind の間: 新しいつなぎ手が Fetch.enable していないセッションの止まった要求は、誰も答えないので断る', /BLOCKED_BY_CLIENT/.test(nav.errorText ?? ''), JSON.stringify(nav));
      const bigNav = await within(other.send('Page.navigate', { url: `https://big.example/${'a'.repeat(70_000)}` }, mine), 3000);
      t.ok('64 KB 以上の requestPaused の行も、requestId を読んで断る', /BLOCKED_BY_CLIENT/.test(bigNav.errorText ?? ''), JSON.stringify(bigNav).slice(0, 200));
      // つなぎ手が自分で Fetch.enable したセッションの止まった要求は、つなぎ手へ流れる。答えずに切れたら断る
      const sessions = linkB.welcome.sessions.filter(x => x.targetId === page).map(x => x.sessionId);
      for (const old of sessions) await cdpB.send('Fetch.disable', {}, old).catch(() => {});
      const own = (await cdpB.send('Target.attachToTarget', { targetId: page, flatten: true })).sessionId;
      const seen = [];
      cdpB.onSession(own, (method, params) => { if (method === 'Fetch.requestPaused') seen.push(params.requestId); });
      await cdpB.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] }, own);
      const navOwn = within(other.send('Page.navigate', { url: 'https://held.example/x' }, mine), 4000);
      await waitFor(() => seen.length === 1, 3000, 'requestPaused to client');
      t.ok('Fetch.enable したセッションの止まった要求は、つなぎ手へ流れる（通る道は塞がない）', seen.length === 1);
      await linkB.handOff();   // 答えずに離れる
      const heldResult = await navOwn;
      t.ok('答えずにつなぎ手が離れたら、流してあった止まった要求を断る', /BLOCKED_BY_CLIENT/.test(heldResult.errorText ?? ''), JSON.stringify(heldResult));
      other.close();
    }

    // ===== 5. 古い id の答えは新しいつなぎ手に届かない =====
    {
      const parent3 = await holder.connect();
      const link3 = await openChromeLink({ holder: parent3.client, runtimeRoot: root, runtimeKey: 'k1' });
      t.ok('3 度目の引き継ぎ: firstId は単調に増える', link3.welcome.firstId > link2.welcome.firstId, `${link2.welcome.firstId} -> ${link3.welcome.firstId}`);
      const ws3 = link3.adopted();
      const cdp3 = createCdp(ws3, { firstId: link3.welcome.firstId });
      const stale = createCdp(link3.adopted ? { on() {}, send() {}, close() {} } : null);
      void stale;
      const msg = [];
      ws3.on('message', m => msg.push(m));
      const v = await cdp3.send('Browser.getVersion');
      t.ok('引き継いだ接続の答えは自分の番号（firstId 以上）だけ', v.product && msg.every(m => { try { return JSON.parse(m).id === undefined || JSON.parse(m).id >= link3.welcome.firstId; } catch { return true; } }));

      // ===== 6. 自分で閉じると、接続の子が ws を閉じる（idle）。次の接続は新しい upgrade =====
      const gone = closed(ws3);
      ws3.terminate();
      await gone;
      await link3.handOff();
      const parent4 = await holder.connect();
      const link4 = await openChromeLink({ holder: parent4.client, runtimeRoot: root, runtimeKey: 'k1' });
      t.ok('terminate: 接続の子は idle に戻る', link4.welcome.phase === 'idle' && link4.adopted() === null, link4.welcome.phase);

      // ===== 7. 許可待ち（upgrading）の途中でサーバーが入れ替わり、続きから許可されると open になる =====
      const holdChrome = await startFakeChrome({ permission: 'hold' });
      cleanups.push(() => holdChrome.stop());
      const wsHold = new link4.WebSocketImpl(wsUrl(holdChrome));
      await waitFor(() => holdChrome.pending() === 1, 5000, 'pending');
      await link4.handOff();
      const parent5 = await holder.connect();
      const link5 = await openChromeLink({ holder: parent5.client, runtimeRoot: root, runtimeKey: 'k1' });
      t.ok('許可待ち: 新しいサーバーは upgrading と upgrade を始めた時刻を受ける', link5.welcome.phase === 'upgrading' && link5.welcome.upgradeAt > 0 && link5.welcome.port === holdChrome.port, JSON.stringify(link5.welcome));
      const adoptedHold = link5.adopted();
      const openPromise = opened(adoptedHold);
      holdChrome.approve();
      await openPromise;
      t.ok('許可待ち: 許可すると引き継いだ接続が open になる（確認は 1 回のまま）', holdChrome.upgrades === 1);
      void wsHold;

      // ===== 8. 許可待ちのキャンセルは 403 で届く =====
      const cdpHold = createCdp(adoptedHold, { firstId: link5.welcome.firstId });
      void cdpHold;
      adoptedHold.terminate();
      const cancelChrome = await startFakeChrome({ permission: 'hold' });
      cleanups.push(() => cancelChrome.stop());
      const wsCancel = new link5.WebSocketImpl(wsUrl(cancelChrome));
      const status = new Promise(resolve => wsCancel.on('unexpected-response', (_req, res) => resolve(res.statusCode)));
      await waitFor(() => cancelChrome.pending() === 1, 5000, 'pending2');
      cancelChrome.cancel();
      t.ok('キャンセル: Chrome の 403 が unexpected-response の statusCode で届く', await status === 403);

      // ===== 9. 版の不一致: 新しいサーバーは古い接続の子を終わらせて起こし直す =====
      const before = linkChildren(parent5.client).map(c => c.id);
      await link5.handOff();
      const parent6 = await holder.connect();
      // 札の版は合っているが、子が返す v をずらす代わりに、サーバー側の期待する版を変えた別のサーバーを真似る
      const old = (parent6.client.welcome?.children ?? []).find(c => c.label?.kind === LINK_CARD_KIND);
      t.ok('版の不一致の前提: 接続の子が 1 つ残っている', before.length === 1 && Boolean(old));
      const link6 = await openChromeLink({ holder: parent6.client, runtimeRoot: root, runtimeKey: 'k1' });
      t.ok('同じ版なら起こし直さない', linkChildren(parent6.client)[0]?.id === old.id && link6.welcome.v === LINK_VERSION);

      // ===== 10. quit: ws を閉じて接続の子が終わる =====
      const wsQuit = new link6.WebSocketImpl(wsUrl(chrome));
      await opened(wsQuit);
      await link6.quit();
      const pipe = readLinkCard(old.label).pipe;
      const reachable = () => new Promise(resolve => { const s = net.connect(pipe); s.on('connect', () => { s.destroy(); resolve(true); }); s.on('error', () => resolve(false)); });
      await waitFor(async () => !(await reachable()), 8000, 'child exit');
      t.ok('quit: 接続の子が終わり、パイプが閉じる', true);
      void wsQuit;

      // ===== 11. 古い版（v: 0）の接続の子が居れば、終わらせて起こし直す =====
      {
        const card = { kind: LINK_CARD_KIND, v: 0, pipe: linkPipeName(`old-${process.pid}`), secret: 'old-secret' };
        const parent7 = await holder.connect();
        parent7.client.spawn({ id: 'chrome-link-old', command: process.execPath, args: [OLD_CHILD, card.pipe, card.secret], env: process.env, policy: 'none', label: card });
        await waitFor(() => (parent7.client.welcome?.children ?? []).some(c => c.id === 'chrome-link-old') || true, 1000, 'spawn');
        await sleep(500);
        const parent8 = await holder.connect();
        const link7 = await openChromeLink({ holder: parent8.client, runtimeRoot: root, runtimeKey: 'k1' });
        t.ok('版の不一致: 古い子を終わらせて起こし直し、新しい子の版で付く', link7 && link7.welcome.v === LINK_VERSION && link7.welcome.phase === 'idle', JSON.stringify(link7?.welcome));
        t.ok('版の不一致: 古い子の預かり物（carry）を新しい子へ引き継ぐ（隠した窓・鍵・止めた印を失わない）', link7.welcome.carry?.port === 7777 && link7.welcome.carry.entries[0]?.stopped === true, JSON.stringify(link7.welcome.carry));
        t.ok('版の不一致: 古い子は残らない', !linkChildren((await holder.connect()).client).some(c => c.id === 'chrome-link-old'));
        await link7?.quit();
      }
    }

    // ===== 12. carry: 一時停止・停止の印は debounce せずすぐ届く。大きすぎる carry は古いものを残さず「無効」の印にする =====
    {
      const crash = async link => { await sleep(40); link.ended = true; link.socket.destroy(); await sleep(60); };   // サーバーが落ちた真似（途中で切れた扱いにならないよう ended を立てる）
      const attach = async () => openChromeLink({ holder: (await holder.connect()).client, runtimeRoot: root, runtimeKey: 'k1' });
      const a = await attach();
      a.setCarry({ v: 1, port: 7001, entries: [] }, { now: true });
      await crash(a);
      const b = await attach();
      t.ok('now: true の carry は、直後にサーバーが落ちても子に届いている', b.welcome.carry?.port === 7001, JSON.stringify(b.welcome.carry));
      t.ok('届いた carry は有効（carryInvalid は立たない）', b.welcome.carryInvalid !== true);
      b.setCarry({ v: 1, port: 7002, entries: [] });
      await crash(b);
      const c = await attach();
      t.ok('now なしの carry は debounce の間に落ちると届かない（前の carry のまま）', c.welcome.carry?.port === 7001, JSON.stringify(c.welcome.carry));
      c.setCarry({ v: 1, port: 7003, entries: [], pad: 'x'.repeat(CARRY_MAX_BYTES + 10) }, { now: true });
      await crash(c);
      const d = await attach();
      t.ok('大きすぎる carry: 古い carry を残さず捨て、carryInvalid を立てる', d.welcome.carry === null && d.welcome.carryInvalid === true, JSON.stringify({ carry: d.welcome.carry, invalid: d.welcome.carryInvalid }));
      d.setCarry({ v: 1, port: 7004, entries: [] }, { now: true });
      await crash(d);
      const e = await attach();
      t.ok('その後に有効な carry が届けば、無効の印は消える', e.welcome.carry?.port === 7004 && e.welcome.carryInvalid !== true, JSON.stringify(e.welcome));
      await e.quit();
    }

    // ===== 13. パイプが途中で切れる（handOff・quit を経ない）: 接続の子を終わらせ、ws を持ったまま残さない =====
    {
      const parentX = await holder.connect();
      let gone = 0;
      const linkX = await openChromeLink({ holder: parentX.client, runtimeRoot: root, runtimeKey: 'k1', onGone: () => { gone += 1; } });
      const pipeX = linkX.pipe;
      const wsX = new linkX.WebSocketImpl(wsUrl(chrome));
      await opened(wsX);
      const upgradesX = chrome.upgrades;
      linkX.socket.destroy();   // 途中で切れた
      await waitFor(() => gone === 1, 5000, 'onGone');
      const reachableX = () => new Promise(resolve => { const s = net.connect(pipeX); s.on('connect', () => { s.destroy(); resolve(true); }); s.on('error', () => resolve(false)); });
      const childAlive = async () => linkChildren((await holder.connect()).client).some(c => c.id === linkX.childId && c.alive);
      t.ok('縁が切れただけでは子は残る（落ちた後に起動する次のサーバーが拾えるように）', await reachableX());
      await linkX.retireChild();
      t.ok('このサーバーが内の ws に落ちるとき（retireChild）、接続の子を終わらせる（ws を持ったまま残らない）', !(await reachableX()) && !(await childAlive()));
      await linkX.retireChild();
      t.ok('retireChild は何度呼んでも壊れない', true);
      void upgradesX;
    }

    // ===== 14. 本当に終わるとき、接続の子のために起こした保持役を終わらせる（ほかの子が居れば、巻き込まない）=====
    {
      const shutdowns = () => holder.logs.filter(line => line.includes('shutdown requested')).length;
      const other = (await holder.connect()).client;
      other.spawn({ id: 'other-child', command: process.execPath, args: ['-e', 'setTimeout(() => {}, 60000)'], policy: 'none' });
      await sleep(300);
      const withOther = (await holder.connect()).client;
      t.ok('ほかの子（app-server・シェルなど）が居れば、保持役は終わらせない', await shutdownHolderIfIdle(withOther, { timeoutMs: 100 }) === false && shutdowns() === 0, String(shutdowns()));
      const attached = (await holder.connect()).client;
      await attached.attach('other-child');
      attached.kill('other-child', { tree: true });
      let alone;
      for (const end = Date.now() + 8000; Date.now() < end;) {
        alone = (await holder.connect()).client;
        if (!(alone.welcome?.children ?? []).some(c => c.id === 'other-child' && c.alive)) break;
        await sleep(100);
      }
      t.ok('接続の子しか居なければ、保持役に shutdown を送る（待つのは timeoutMs まで）', await shutdownHolderIfIdle(alone, { timeoutMs: 100 }) === true && shutdowns() === 1, String(shutdowns()));
      t.ok('つながっていないクライアントには何もしない', await shutdownHolderIfIdle(null) === false);
    }
  } finally {
    for (const fn of cleanups) { try { await fn(); } catch { /* 片付け */ } }
    await chrome.stop();
    await holder.stop();
  }
}
