// main が居ない間（更新の約 50 秒・付け直しまで）の、サーバー側の機能ごとの扱い（無停止の更新 段階 1 の 1-5。docs/zero-downtime-update/design.md §7.2）。
// 口は main が付け直す形の偽物（connected・resumable・connect/disconnect）。実時間は短い上限に縮める。
//   secret（待たせる・上限・復号の保持・切れた依頼を戻す・答えを得られなかったときに平文で書かない）・computer use（Esc と同じに止める）・
//   内蔵ブラウザー（中継の URL の写し・タブの写し・戻った main への復元の答え・別ポート）・screencast（ended away）・os-open と openExternal・
//   main-leaving（画面の猶予を数えない）・main-leaving-cancel（更新の取りやめで猶予を数える状態に戻す）・既定（utilityProcess の口）は何も変わらない
//   切り替えで替わったサーバー（空から始まる）: secret は頼み直せば通る・内蔵ブラウザーは main が送り直した写しと中継の URL を取り込む
//   ホストへ任せる口（remote-agent）: 居ない間はホストを全部オフライン扱いにして依頼を待たせず OFFLINE で失敗・戻ったら main が送り直す一覧と ready で元に戻る
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createMainPort } from '../../core/main-port.mjs';
import { createMainAway, createExternalOpener, openableUrl, urlLaunchPlan } from '../../core/main-away.mjs';
import { parentPortCipher, createSecretStore } from '../../core/secret-store.mjs';
import { parentPortComputer, ComputerError } from '../../core/computer-use/driver.mjs';
import { parentPortBrowser, cleanTabState, browserConfigFile } from '../../core/agent-browser.mjs';
import { parentPortRemoteAgent } from '../../core/remote-delegation.mjs';
import { parentPortScreencast, createScreencastHub } from '../../core/browser-screencast.mjs';
import { defaultOpener } from '../../core/os-open.mjs';
import { createHarness, sleep } from '../lib/computer-harness.mjs';

export const name = 'main-away';
export const title = 'main が居ない間の機能ごとの扱い: secret の待ち・computer use の停止・内蔵ブラウザーの写しと復元・screencast・os-open・openExternal・猶予';

/** main が付け直す口の偽物（名前付きパイプの口と同じ形: connected・resumable・connect/disconnect。切れている間の送信は false） */
function linkPort({ connected = true } = {}) {
  const port = new EventEmitter();
  Object.assign(port, { resumable: true, connected, sent: [] });
  port.postMessage = message => { if (!port.connected) return false; port.sent.push(message); return true; };
  port.say = data => port.emit('message', { data });
  port.connect = () => { port.connected = true; port.emit('connect'); };
  port.disconnect = () => { port.connected = false; port.emit('disconnect'); };
  port.take = type => port.sent.filter(m => m.type === type);
  return port;
}
/** utilityProcess の parentPort と同じ形の偽物（切れない・postMessage は何も返さない） */
function parentPort() {
  const port = new EventEmitter();
  port.sent = [];
  port.postMessage = message => { port.sent.push(message); };
  port.say = data => port.emit('message', { data });
  return port;
}

const { attachSecretBridge } = createRequire(import.meta.url)('../../desktop/secret-bridge.cjs');

const KEY = 'a'.repeat(48);
const urlOf = (port, key = KEY) => `ws://127.0.0.1:${port}/devtools/browser/${key}`;

export default async function (t) {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-main-away-'));
  try {
    // ---- 出来事: away・back・main-leaving
    {
      const link = linkPort({ connected: false });
      const away = createMainAway({ mainPort: createMainPort({ parentPort: link }) });
      const events = [];
      away.onAway(() => events.push('away'));
      away.onBack(({ first }) => events.push(first ? 'first' : 'back'));
      link.connect();
      link.disconnect();
      link.say({ type: 'main-leaving', reason: 'update' });
      t.ok('main-leaving の後は、戻るまで画面の猶予を数えない（holdsGrace）', away.leaving?.reason === 'update' && away.holdsGrace() === true);
      link.connect();
      t.ok('出来事: 最初のつながり・切れた・付け直し（first が false）。戻ると main-leaving は忘れる', events.join() === 'first,away,back' && away.holdsGrace() === false && away.connects === 2);
      // 更新を取りやめた（main は居続ける）: 猶予を数える状態に戻す。main-leaving の無いときの取りやめ・切れた後に来た取りやめは何も起こさない
      const stays = [];
      away.onStay(() => stays.push('stay'));
      link.say({ type: 'main-leaving-cancel' });
      t.ok('main-leaving が無いときの取りやめは何も起こさない', stays.length === 0 && away.holdsGrace() === false);
      link.say({ type: 'main-leaving', reason: 'update' });
      link.say({ type: 'main-leaving-cancel' });
      t.ok('main-leaving の後の取りやめで、猶予を数える状態に戻る（onStay が 1 回）', stays.length === 1 && away.leaving === null && away.holdsGrace() === false);
      link.say({ type: 'main-leaving-cancel' });
      t.ok('取りやめを重ねて受けても 1 回', stays.length === 1);
      link.say({ type: 'main-leaving', reason: 'update' });
      link.disconnect();
      link.connect();
      t.ok('取りやめずに戻った main では、main-leaving は忘れている（前からの動き）', away.holdsGrace() === false && stays.length === 1);
      const plain = parentPort();
      const quiet = createMainAway({ mainPort: createMainPort({ parentPort: plain }) });
      plain.say({ type: 'main-leaving', reason: 'update' });
      t.ok('既定（utilityProcess の口）では何も起きない（main-leaving も猶予に効かない）', quiet.holdsGrace() === false && quiet.leaving === null);
    }

    // ---- secret
    {
      const port = linkPort({ connected: false });
      const cipher = parentPortCipher(port, { timeoutMs: 60, connectWaitMs: 400 });
      const first = cipher.decrypt('c1');
      await sleep(30);
      t.ok('main が居ない間の復号は、送らずに待つ', port.sent.length === 0);
      port.connect();
      const asked = port.take('secret');
      t.ok('つながると送られ、答えで解決する', asked.length === 1 && asked[0].op === 'decrypt');
      port.say({ type: 'secret', id: asked[0].id, ok: true, value: 'plain-1' });
      t.ok('復号の答え', await first === 'plain-1');
      const before = port.sent.length;
      port.disconnect();
      t.ok('復号した値はメモリに持ち、main が居なくても同じ秘密は頼まず返す', await cipher.decrypt('c1') === 'plain-1' && port.sent.length === before);
      port.connect();
      t.ok('つながっても同じ秘密は main に頼まない（2 回目から）', await cipher.decrypt('c1') === 'plain-1' && port.sent.length === before);

      // 暗号化した組も覚える（書いた直後の読みは main に頼まない）
      const enc = cipher.encrypt('secret-text');
      const e = port.take('secret').at(-1);
      port.say({ type: 'secret', id: e.id, ok: true, value: 'sealed-text' });
      t.ok('暗号化した値は暗号文と平文の組で覚える', await enc === 'sealed-text' && await cipher.decrypt('sealed-text') === 'secret-text');

      // 送ったのに答えが来ないまま切れた依頼は、つながるまで待つ依頼に戻す（答えの待ち 60 ms を過ぎても失敗にしない）
      const pending = cipher.decrypt('c2');
      const sentOnce = port.take('secret').at(-1);
      port.disconnect();
      await sleep(150);
      const settled = await Promise.race([pending.then(() => 'resolved', () => 'rejected'), sleep(10).then(() => 'pending')]);
      t.ok('送ったのに切れた依頼は、答えの待ちの上限で失敗にせず待つ', settled === 'pending');
      port.connect();
      const resent = port.take('secret').at(-1);
      t.ok('つながると同じ依頼を送り直す', resent.id === sentOnce.id && resent.op === 'decrypt' && resent.value === 'c2');
      port.say({ type: 'secret', id: resent.id, ok: true, value: 'plain-2' });
      t.ok('送り直した依頼が通る', await pending === 'plain-2');

      // 上限（最初に待ち始めた時から数える）
      port.disconnect();
      const limited = await cipher.decrypt('c3').then(() => 'resolved', error => error.message);
      t.ok('main が戻らないまま上限（connectWaitMs）を過ぎたら失敗', limited !== 'resolved' && limited.length > 0);

      // 答えを得られなかったのを「暗号化できない」と取り違えて平文で書かない
      const away = linkPort({ connected: false });
      const sealed = parentPortCipher(away, { timeoutMs: 40, connectWaitMs: 80 });
      const file = path.join(scratch, 'secrets-away.json');
      const store = createSecretStore({ file, cipher: sealed });
      const wrote = await store.set('k', { token: 'tok' }).then(() => 'wrote', error => error.message);
      t.ok('main が戻らないとき、暗号化の可否が分からないまま平文で書かない（失敗にする）', wrote !== 'wrote' && !(await fs.stat(file).catch(() => null)));
      const failed = await sealed.status().then(() => 'ok', () => 'rejected');
      away.connect();
      const status = sealed.status();
      const statusReq = away.take('secret').at(-1);
      away.say({ type: 'secret', id: statusReq.id, ok: true, value: { available: true, backend: 'dpapi' } });
      t.ok('答えを得られなかった status は覚えず、戻ってからの status は通る', failed === 'rejected' && (await status).encrypted === true);

      // 既定（utilityProcess の口）: 失敗も覚えて平文扱い・復号を保持しない（今のまま）
      const plain = parentPort();
      const legacy = parentPortCipher(plain, { timeoutMs: 40 });
      const state = await legacy.status();
      t.ok('既定: main が答えなければ今までどおり平文扱い（失敗も覚える）', state.encrypted === false && plain.sent.filter(m => m.op === 'status').length === 1 && (await legacy.status()).encrypted === false && plain.sent.length === 1);
      const first1 = legacy.decrypt('x');
      plain.say({ type: 'secret', id: plain.sent.at(-1).id, ok: true, value: 'v' });
      await first1;
      const second = legacy.decrypt('x');
      t.ok('既定: 復号は毎回 main に頼む（値を持たない）', plain.sent.filter(m => m.op === 'decrypt').length === 2);
      second.catch(() => {});
    }

    // ---- computer use
    {
      const port = linkPort();
      const driver = parentPortComputer(port, { timeoutMs: 500, launchTimeoutMs: 500, heartbeatMs: 1000 });
      port.say({ type: 'computer-ready', supported: true, displays: [{ id: 'd1', index: 1, bounds: { x: 0, y: 0, width: 100, height: 100 }, scale: 1, primary: true }], displaysVersion: 1 });
      const aways = [];
      driver.onAway(() => aways.push('away'));
      const inflight = driver.call('o1', 'cursor', {}).catch(error => error);
      port.disconnect();
      const err = await inflight;
      t.ok('main が切れたら、待っていた呼び出しは away で失敗し、onAway が呼ばれる', err instanceof ComputerError && err.code === 'away' && aways.length === 1);
      const sentBefore = port.sent.length;
      const later = await driver.call('o1', 'cursor', {}).catch(error => error);
      t.ok('居ない間の呼び出しは、送らずに away で返る（main には何も頼まない）', later.code === 'away' && port.sent.length === sentBefore && driver.state().supported === true);
      port.connect();
      t.ok('つながると computer-ready-request を送り直し、main の computer-ready で使える', port.take('computer-ready-request').length === 2);
      port.say({ type: 'computer-ready', supported: true, displays: [], displaysVersion: 2 });
      const ok = driver.call('o1', 'cursor', {});
      const call = port.take('computer-call').at(-1);
      port.say({ type: 'computer-result', id: call.id, ok: true, data: { x: 1, y: 2 } });
      t.ok('戻った後は普通に呼べる', (await ok).x === 1);
    }
    {
      // Esc と同じに止める: 持ち主・待っているターンに update の印を付け、ツールには更新のための停止を返す。ターンは止めない
      const h = await createHarness({ waitMs: 800 });
      try {
        h.driver.onAway(() => h.lock.stopAll('update'));
        const a = h.connect({ sessionId: 'sa' });
        const b = h.connect({ sessionId: 'sb' });
        const mark = r => a.read(r)?.computer;
        t.ok('away の前は普通に撮れる', mark(await a.call('screenshot', { title: '確かめる' })).state === 'ok');
        const waiting = b.call('screenshot', { title: '待つ' });
        await sleep(50);
        h.driver.goAway();
        const stopped = await a.call('wait', { duration: 0.1, title: '待つ' });
        const callsAfter = h.driver.calls.length;
        t.ok('持ち主のターンは、以後の呼び出しがすぐ stopped / update（main には何も送らない）。文は更新のための停止', mark(stopped).state === 'stopped' && mark(stopped).reason === 'update' && stopped.isError !== undefined
          && a.read(stopped).text.includes('更新') && h.driver.calls.length === callsAfter);
        const waited = await waiting;
        t.ok('ロックを待っていたターンも stopped / update で返る（待ち続けない）', b.read(waited)?.computer?.reason === 'update' && b.read(waited).computer.state === 'stopped');
        a.end(); b.end();
        // 戻った main の後の新しいターンは、承認からやり直して普通に使える（止めた印はターンのもの）
        h.driver.comeBack();
        const c = h.connect({ sessionId: 'sc' });
        t.ok('次のターンは普通に使える（印はターンの終わりで消えている）', mark(await c.call('screenshot', { title: '戻った' })).state === 'ok');
        c.end();
      } finally { await h.close(); }
    }

    // ---- 切り替えで替わったサーバー（空から始まる）: 復号の組は main に頼み直せば通る（safeStorage は main のもので、組は main に残っている）
    {
      const safeStorage = { isEncryptionAvailable: () => true, encryptString: text => Buffer.from(`E:${text}`), decryptString: bytes => bytes.toString().slice(2) };
      let current = null;
      const main = new EventEmitter();     // main から見たサーバーとの口（desktop/server-link.cjs の包み）。つなぎ先が S1 から S2 へ替わる
      main.postMessage = message => current.say(message);
      attachSecretBridge(main, { safeStorage, platform: 'win32' });
      const attachServer = () => {
        const port = linkPort();
        port.postMessage = message => { port.sent.push(message); queueMicrotask(() => main.emit('message', message)); return true; };
        current = port;
        return parentPortCipher(port, { timeoutMs: 200, connectWaitMs: 400 });
      };
      const s1 = attachServer();
      const sealed = await s1.encrypt('token-1');
      const s2 = attachServer();
      const state = await s2.status();
      t.ok('S2 は空から始まり、暗号化の可否を頼み直して得る', state.encrypted === true && state.backend === 'dpapi');
      t.ok('S1 が暗号化した値を、S2 が頼み直して復号できる（復号の組を引き継がなくてよい）', await s2.decrypt(sealed) === 'token-1');
      t.ok('S2 は新しい値も暗号化できる', await s2.decrypt(await s2.encrypt('token-2')) === 'token-2');
    }

    // ---- ホストへ任せる口（サーバー側）: 居ない間は待たせず OFFLINE
    {
      const port = linkPort();
      const bridge = parentPortRemoteAgent(port, { timeoutMs: 5000 });
      const events = [];
      bridge.onState((hostId, st) => events.push(`state:${hostId}:${st.state}`));
      bridge.onReady((hostId, st) => events.push(`ready:${hostId}:${st.state}`));
      const hosts = [{ hostId: 'h1', name: 'Desk', hostName: 'DESK', agentUse: true, state: 'ready', allowed: true }, { hostId: 'h2', name: 'Lap', hostName: 'LAP', agentUse: true, state: 'offline', allowed: false }];
      port.say({ type: 'remote-agent-hosts', hosts });
      const inflight = bridge.request('h1', 'status', {}, null).then(() => 'resolved', error => error.code);
      t.ok('main が居る間は main に頼む（今のとおり）', port.take('remote-agent').at(-1)?.action === 'request');
      port.disconnect();
      t.ok('切れたら、答えを待っていた依頼は OFFLINE で失敗する（待たせない）', await inflight === 'OFFLINE');
      t.ok('ホストは全部オフライン扱いになる（ready だったものだけ状態の便りが出る。許可の印は残す）', bridge.hosts.every(h => h.state === 'offline') && bridge.hosts[0].allowed === true && events.join() === 'state:h1:offline');
      const sent = port.sent.length;
      const later = await bridge.request('h1', 'status', {}, null).then(() => 'resolved', error => error.code);
      const asked = await bridge.answer('h1', { id: 'r1' }).then(() => 'resolved', error => error.code);
      t.ok('居ない間の依頼・承認の答え・同期は、main に送らずすぐ OFFLINE で返る', later === 'OFFLINE' && asked === 'OFFLINE' && await bridge.sync('h1', ['x']).then(() => 'resolved', error => error.code) === 'OFFLINE' && port.sent.length === sent);
      // 戻ったとき: main が一覧と、つながっている線の ready を送り直す
      port.connect();
      port.say({ type: 'remote-agent-hosts', hosts });
      port.say({ type: 'remote-agent-ready', hostId: 'h1', state: 'ready', allowed: true, hostName: 'DESK' });
      t.ok('戻った main の一覧と ready で、ホストが使える状態に戻る（追いつきの ready が走る）', bridge.hosts[0].state === 'ready' && events.at(-1) === 'ready:h1:ready' && bridge.hosts[1].state === 'offline');
      const again = bridge.request('h1', 'status', {}, null);
      const req = port.take('remote-agent').at(-1);
      port.say({ type: 'remote-agent', id: req.id, ok: true, result: { ok: 1 } });
      t.ok('戻った後は main に頼んで答えを受け取れる', req.action === 'request' && (await again).ok === 1);
    }
    {
      // 既定（utilityProcess の口: 切れない・resumable でない）は何も変わらない
      const plain = parentPort();
      const bridge = parentPortRemoteAgent(plain, { timeoutMs: 5000 });
      plain.say({ type: 'remote-agent-hosts', hosts: [{ hostId: 'h1', name: 'Desk', agentUse: true, state: 'ready', allowed: true }] });
      const answer = bridge.request('h1', 'status', {}, null);
      const req = plain.sent.at(-1);
      plain.say({ type: 'remote-agent', id: req.id, ok: true, result: { ok: 2 } });
      t.ok('既定（utilityProcess の口）: 今までどおり main に頼む', req.action === 'request' && (await answer).ok === 2 && bridge.hosts[0].state === 'ready');
      t.ok('main の口が無い起動（Electron でない）は null のまま', parentPortRemoteAgent(null) === null);
    }

    // ---- 内蔵ブラウザー（サーバー側）
    {
      const dataDir = path.join(scratch, 'data-browser');
      const port = linkPort();
      const bridge = parentPortBrowser(port, { timeoutMs: 80, connectWaitMs: 300, dataDir });
      const ask = (sessionId, extra) => bridge.endpoint(sessionId, extra);
      const first = ask('s1');
      const request = port.take('agent-browser-endpoint').at(-1);
      t.ok('main が居る間は main に頼む（今のとおり）', request.sessionId === 's1');
      port.say({ type: 'agent-browser-endpoint', id: request.id, ok: true, url: urlOf(5555) });
      t.ok('答えの URL', await first === urlOf(5555));

      // 居ない間: 写しで答える
      const sent = port.sent.length;
      port.disconnect();
      t.ok('居ない間は、同じ会話に写しの URL（同じポートと鍵）を返す。main には送らない', await ask('s1') === urlOf(5555) && port.sent.length === sent);
      const fresh = await ask('s2');
      const again = await ask('s2');
      t.ok('新しい会話の鍵はここで決める（同じポート・48 桁の 16 進・次も同じ鍵）', /^ws:\/\/127\.0\.0\.1:5555\/devtools\/browser\/[a-f0-9]{48}$/.test(fresh) && fresh !== urlOf(5555) && again === fresh);
      // 送ったのに切れた依頼
      port.connect();
      const inflight = ask('s3');
      port.disconnect();
      const copied = await inflight;
      t.ok('main に送った直後に切れた依頼も、写しで答える', /^ws:\/\/127\.0\.0\.1:5555\/devtools\/browser\/[a-f0-9]{48}$/.test(copied));

      // タブの写しと復元の答え
      port.connect();
      port.say({ type: 'browser-state-report',
        tabs: [{ sessionId: 's1', url: 'https://example.com/a', selected: true }, { sessionId: 's1', url: 'file:///C:/secret.html', selected: false },
          { sessionId: null, url: 'http://localhost:3000/', selected: false }, { sessionId: 'x'.repeat(201), url: 'https://example.com/long' }, { sessionId: 's1', url: 'about:blank' }] });
      port.say({ type: 'browser-restore-request' });
      const restore = port.take('browser-restore').at(-1);
      t.ok('browser-restore: http(s) のタブだけ（file:・空・長すぎる会話の id は落とす）', restore.tabs.length === 2 && restore.tabs[0].url === 'https://example.com/a' && restore.tabs[0].selected === true && restore.tabs[1].sessionId === null
        && !('profile' in restore.tabs[0]) && !('profiles' in restore));
      t.ok('browser-restore: 中継は同じポートと、会話ごとの鍵', restore.relay.port === 5555 && restore.relay.entries.length === 3 && restore.relay.entries.find(row => row.sessionId === 's1').key === KEY);
      t.ok('cleanTabState: 配列でないものは空', JSON.stringify(cleanTabState({ tabs: 'x' })) === '{"tabs":[]}');

      // 別のポートで立った（ポートが取れなかった）: 持っている URL と、設定ファイルの cdp を直す
      const configFile = browserConfigFile(dataDir, 's1');
      await fs.mkdir(path.dirname(configFile), { recursive: true });
      await fs.writeFile(configFile, JSON.stringify({ cdp: urlOf(5555) }));
      port.say({ type: 'agent-browser-endpoint-moved', port: 6001 });
      await sleep(50);
      t.ok('別のポート: 設定ファイルの cdp を新しいポートへ書き直す（鍵は同じ）。設定ファイルが無い会話は作らない', JSON.parse(await fs.readFile(configFile, 'utf8')).cdp === urlOf(6001)
        && !(await fs.stat(browserConfigFile(dataDir, 's2')).catch(() => null)));
      port.disconnect();
      t.ok('別のポートの後の写しも新しいポート', await ask('s1') === urlOf(6001));
      port.say({ type: 'agent-browser-endpoint-moved', port: 70000 });
      t.ok('範囲の外のポートは無視する', await ask('s1') === urlOf(6001));

      // 会話の id が替わったら写しも移る
      bridge.rebind('s1', 's1-native');
      t.ok('rebind: 写しの会話の id も替わる', await ask('s1-native') === urlOf(6001));
      port.connect();
    }
    {
      // 切り替えで替わったサーバー（空から始まる）: main が送り直した報告のタブの写しと中継の URL を取り込み、居ない間はその URL で答える
      const port = linkPort();
      const bridge = parentPortBrowser(port, { timeoutMs: 80, connectWaitMs: 200 });
      port.say({ type: 'browser-state-report', tabs: [{ sessionId: 's1', url: 'https://example.com/a', selected: true }],
        relay: { port: 6000, entries: [{ sessionId: 's1', key: KEY }, { sessionId: 's2', key: 'zz' }, { sessionId: '', key: KEY }, null] } });
      port.disconnect();
      t.ok('main が送り直した中継の URL で、居ない間に答える（形の悪い鍵・空の会話は取り込まない）', await bridge.endpoint('s1') === urlOf(6000));
      port.connect();
      port.say({ type: 'browser-restore-request' });
      const restore = port.take('browser-restore').at(-1);
      t.ok('取り込んだ写しは、次に付け直す main への復元の答えにもなる（タブ・中継のポートと鍵）', restore.tabs.length === 1 && restore.relay.port === 6000 && restore.relay.entries.length === 1 && restore.relay.entries[0].key === KEY);
      port.say({ type: 'browser-state-report', tabs: [], relay: { port: 0, entries: [{ sessionId: 's3', key: KEY }] } });
      port.say({ type: 'browser-state-report', tabs: [] });
      port.say({ type: 'browser-restore-request' });
      const later = port.take('browser-restore').at(-1);
      t.ok('中継の写しが無い・ポートの形が悪い報告は、持っている中継を変えない（写しの上書きは tabs だけ）', later.tabs.length === 0 && later.relay.port === 6000 && later.relay.entries.length === 1);
    }
    {
      // ポートを一度も知らない（main が一度も答えていない）うちは、main が居ない間にサーバーが空きポートを選んで答える。戻った main が立てる
      const port = linkPort({ connected: false });
      let picks = 0;
      const bridge = parentPortBrowser(port, { timeoutMs: 80, connectWaitMs: 200, pickPort: async () => { picks++; return 7003; } });
      const [x, y] = await Promise.all([bridge.endpoint('s9'), bridge.endpoint('s10')]);
      t.ok('ポートを知らなければ空きポートを選んで答える（1 回だけ選ぶ・main には送らない・会話ごとに鍵）',
        /^ws:\/\/127\.0\.0\.1:7003\/devtools\/browser\/[a-f0-9]{48}$/.test(x) && x !== y && y.startsWith('ws://127.0.0.1:7003/') && picks === 1 && port.sent.length === 0);
      port.connect();
      port.say({ type: 'browser-restore-request' });
      const restore = port.take('browser-restore').at(-1);
      t.ok('戻った main への復元の答えは、選んだポートと、答えた会話の鍵', restore.relay.port === 7003 && restore.relay.entries.length === 2 && x.endsWith(restore.relay.entries.find(row => row.sessionId === 's9').key));
      // 空きポートを選べなければ、戻るまで待つ。戻れば送り直され、上限までに戻らなければ失敗
      const stuckPort = linkPort({ connected: false });
      const stuck = parentPortBrowser(stuckPort, { timeoutMs: 80, connectWaitMs: 200, pickPort: async () => { throw new Error('no port'); } });
      const waiting = stuck.endpoint('s11');
      await sleep(40);
      t.ok('空きポートを選べなければ戻るまで待つ（送らない）', stuckPort.sent.length === 0);
      stuckPort.connect();
      const req = stuckPort.take('agent-browser-endpoint').at(-1);
      t.ok('つながると送り直す', req?.sessionId === 's11');
      stuckPort.say({ type: 'agent-browser-endpoint', id: req.id, ok: true, url: urlOf(7001) });
      t.ok('答えで解決する', await waiting === urlOf(7001));
      const lonely = parentPortBrowser(linkPort({ connected: false }), { connectWaitMs: 60, pickPort: async () => { throw new Error('no port'); } });
      const gaveUp = await lonely.endpoint('s9').then(() => 'resolved', error => error.message);
      t.ok('戻らなければ上限で失敗', gaveUp === 'browser relay timeout');
      // 新しい main の橋ができる前に送って落ちた依頼は、browser-restore-request で送り直す
      const p2 = linkPort();
      const b2 = parentPortBrowser(p2, { timeoutMs: 500 });
      const dropped = b2.endpoint('s10');
      const first = p2.take('agent-browser-endpoint').at(-1);
      p2.say({ type: 'browser-restore-request' });
      const second = p2.take('agent-browser-endpoint').at(-1);
      t.ok('browser-restore-request で、答えていない endpoint の依頼を送り直す', p2.take('agent-browser-endpoint').length === 2 && second.id === first.id);
      p2.say({ type: 'agent-browser-endpoint', id: second.id, ok: true, url: urlOf(7002) });
      await dropped;
    }
    {
      // 既定（utilityProcess の口）: 答えが無ければ今までどおり timeout で失敗（写し・待ちは使わない）
      const plain = parentPort();
      const bridge = parentPortBrowser(plain, { timeoutMs: 50 });
      const first = bridge.endpoint('s1');
      plain.say({ type: 'agent-browser-endpoint', id: plain.sent.at(-1).id, ok: true, url: urlOf(5555) });
      await first;
      const lost = await bridge.endpoint('s1').then(() => 'resolved', error => error.message);
      t.ok('既定: 答えが無ければ timeout で失敗（写しで答えない）', lost === 'browser relay timeout');
    }

    // ---- screencast
    {
      const port = linkPort();
      const bridge = parentPortScreencast(port, { timeoutMs: 500 });
      port.say({ type: 'browser-screencast-ready' });
      const hub = createScreencastHub({ bridge });
      const got = [];
      const client = { send: message => got.push(message) };
      const watching = hub.watch(client, 's1', { url: 'https://example.com/' });
      const req = port.take('browser-screencast').at(-1);
      port.say({ type: 'browser-screencast', id: req.id, ok: true, result: { tabId: 't1', state: { loading: false } } });
      await watching;
      const hanging = bridge.request('input', 's1', {}).catch(error => error.message);
      port.disconnect();
      t.ok('main が切れたら、見ている端末へ ended（reason: away）を送り、会話を畳む', got.some(m => m.type === 'ended' && m.reason === 'away' && m.sessionId === 's1') && hub.sessions().length === 0);
      t.ok('待っていた依頼は失敗にし、ready を下げる（新しい main の ready まで使えない）', await hanging === 'main is away' && bridge.ready === false);
      port.connect();
      port.say({ type: 'browser-screencast-ready' });
      t.ok('新しい main の ready で使える', bridge.ready === true);
    }

    // ---- os-open・openExternal
    {
      const port = linkPort();
      const main = createMainPort({ parentPort: port });
      const launched = [];
      const open = defaultOpener({ env: {}, mainPort: main, launchImpl: async plan => { launched.push(plan); } });
      const viaMain = open('reveal', 'C:\\work\\a.txt');
      t.ok('main が居るときは main の shell に頼む（今のとおり）', port.take('os-open').length === 1 && launched.length === 0);
      port.say({ type: 'os-open', id: port.take('os-open')[0].id, ok: true });
      await viaMain;
      port.disconnect();
      // 起動する内容は OS ごとに違う（Linux は xdg-open）。Windows の分岐は platform を渡して見る
      await open('reveal', 'C:\\work\\a.txt', { platform: 'win32' });
      t.ok('main が居ない間は OS に直に頼む（explorer.exe を絶対パスで）', launched.length === 1 && /explorer\.exe$/i.test(launched[0].command) && port.take('os-open').length === 1);
      const legacy = parentPort();
      const legacyOpen = defaultOpener({ env: {}, mainPort: createMainPort({ parentPort: legacy }), launchImpl: async () => { throw new Error('使わない'); } });
      legacyOpen('reveal', 'C:\\work\\a.txt').catch(() => {});
      t.ok('既定（utilityProcess の口）は今までどおり main に頼む', legacy.sent.filter(m => m.type === 'os-open').length === 1);
    }
    {
      t.ok('openableUrl: https と、ループバックの http だけ。認証情報つき・ほかのスキームは開かない', openableUrl('https://example.com/a?b=1') === 'https://example.com/a?b=1' && openableUrl('http://127.0.0.1:8080/cb') === 'http://127.0.0.1:8080/cb'
        && openableUrl('http://example.com/') === null && openableUrl('https://u:p@example.com/') === null && openableUrl('javascript:alert(1)') === null && openableUrl('file:///C:/x') === null);
      const win = urlLaunchPlan('https://example.com/auth?a=1&b=2', { platform: 'win32', env: { SystemRoot: 'C:\\Windows' } });
      t.ok('urlLaunchPlan(win32): explorer.exe の絶対パスに、URL を " で囲んで渡す（シェルを通さない）', win.command === 'C:\\Windows\\explorer.exe' && win.args[0] === '"https://example.com/auth?a=1&b=2"' && win.options.shell === false && win.options.windowsVerbatimArguments === true);
      t.ok('urlLaunchPlan: macOS は open・Linux は xdg-open', urlLaunchPlan('https://example.com/', { platform: 'darwin' }).command === '/usr/bin/open' && urlLaunchPlan('https://example.com/', { platform: 'linux' }).command === 'xdg-open');

      const port = linkPort();
      const spawned = [];
      const spawnImpl = (command, args, options) => { spawned.push({ command, args, options }); return { once() {}, unref() {} }; };
      const opener = createExternalOpener({ mainPort: createMainPort({ parentPort: port }), spawnImpl });
      t.ok('main が居るときは main に頼む', opener('https://example.com/auth') === true && port.take('open-external').length === 1 && spawned.length === 0);
      port.disconnect();
      t.ok('main が居ない間は OS の既定のブラウザーで開く', opener('https://example.com/auth') === true && spawned.length === 1 && spawned[0].args[0].includes('https://example.com/auth'));
      t.ok('開けない URL は開かない', opener('file:///C:/Windows/System32/calc.exe') === false && spawned.length === 1);
      const none = createExternalOpener({ mainPort: createMainPort({}), spawnImpl });
      t.ok('main の下でない起動（npm start）は何もしない（画面の URL から人が開く）', none('https://example.com/auth') === false && spawned.length === 1);
      const legacy = parentPort();
      const legacyOpener = createExternalOpener({ mainPort: createMainPort({ parentPort: legacy }), spawnImpl });
      t.ok('既定（utilityProcess の口）は今までどおり main に送る', legacyOpener('https://example.com/auth') === true && legacy.sent.length === 1 && spawned.length === 1);
    }
  } finally {
    await fs.rm(scratch, { recursive: true, force: true });
  }
}
