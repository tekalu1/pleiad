// 画面の殻を端末に持つ（docs/remote.md §8.6、ADR 0181）。束の形（core/remote/static-bundle.mjs）、
// ホストの口（core/static-bundle.mjs・GET /static-bundle）、端末内プロキシの保存と配り（core/remote/static-cache.mjs・device-proxy.mjs）。
// 中継をこのプロセスで、fake バックエンドのサーバーを別プロセスで立てる。LLM もネットワークも使わない。
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { createRelay } from '../../relay/server.mjs';
import { startServer, ROOT } from '../lib/server.mjs';
import { open } from '../lib/ws-client.mjs';
import { createRemoteDevice } from '../../core/remote/device.mjs';
import { encodeBundle, decodeBundle, bundleKey } from '../../core/remote/static-bundle.mjs';
import { createStaticBundle } from '../../core/static-bundle.mjs';

export const name = 'remote-static-bundle';
export const title = '画面の殻を端末に持つ: 束の形と検証・ホストの /static-bundle（認証・304・縮め・開発中の読み直し）・端末の保存と配り・古いホストと古いアプリ';

const SECRET = crypto.randomBytes(32).toString('base64url');
const MIME = { '.html': 'text/html; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8' };

function within(p, ms, label) {
  let timer;
  return Promise.race([
    Promise.resolve(p).finally(() => clearTimeout(timer)),
    new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`${label} が ${ms}ms で終わらない`)), ms); }),
  ]);
}
const throws = fn => { try { fn(); return null; } catch (e) { return e; } };

function request(port, pathname, { method = 'GET', headers = {}, timeoutMs = 15_000 } = {}) {
  return within(new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: pathname, agent: false, headers }, res => {
      const parts = [];
      res.on('data', c => parts.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(parts) }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  }), timeoutMs, `${method} ${pathname}`);
}

/** プロキシがホストへ流した要求（パスと応答の状態）を記録する。チャネルを張り直したら付け直す */
function recordHostRequests(proxy, { rewrite = p => p } = {}) {
  const seen = [];
  const ch = proxy.link.channel;
  const orig = ch.openHttp.bind(ch);
  ch.openHttp = opts => {
    const entry = { path: opts.path, status: null, acceptEncoding: opts.headers?.['accept-encoding'] ?? null, contentEncoding: null };
    seen.push(entry);
    const stream = orig({ ...opts, path: rewrite(opts.path) });
    stream.on('response', h => {
      entry.status = h?.status ?? null;
      entry.contentEncoding = Object.entries(h?.headers ?? {}).find(([k]) => k.toLowerCase() === 'content-encoding')?.[1] ?? null;
    });
    return stream;
  };
  return seen;
}

function waitConnected(device, hostId, ms = 10_000) {
  return within(new Promise(resolve => {
    const on = s => { if (s.hostId === hostId && s.state === 'connected') { device.off('status', on); resolve(); } };
    device.on('status', on);
    device.proxy(hostId).then(px => { if (px?.status.state === 'connected') { device.off('status', on); resolve(); } });
  }), ms, 'つながる');
}

export default async function (t) {
  // ---- 束の形
  const files = [
    { path: '/index.html', type: MIME['.html'], body: Buffer.from('<!doctype html><title>x</title>') },
    { path: '/a/b.mjs', type: MIME['.mjs'], body: Buffer.from('export const x = 1;\n') },
    { path: '/empty.css', type: MIME['.css'], body: Buffer.alloc(0) },
  ];
  const enc = encodeBundle(files);
  const dec = decodeBundle(enc.body);
  t.ok('束を作って読み戻すと、パス・型・中身が同じで key も合う',
    dec.key === enc.key && dec.key === bundleKey(files) && dec.files.size === 3 && dec.files.get('/a/b.mjs').body.equals(files[1].body)
    && dec.files.get('/empty.css').body.length === 0 && dec.files.get('/index.html').type === MIME['.html']);
  const flipped = Buffer.from(enc.body); flipped[flipped.length - 3] ^= 1;
  const truncated = enc.body.subarray(0, enc.body.length - 1);
  const evil = encodeBundle([{ path: '/../secret', type: 'text/plain', body: Buffer.from('x') }]);
  t.ok('中身が 1 バイト違う・途中で切れた・パスに .. がある束は読まない',
    /key mismatch/.test(throws(() => decodeBundle(flipped))?.message) && throws(() => decodeBundle(truncated)) != null
    && throws(() => decodeBundle(evil.body)) != null && throws(() => decodeBundle(Buffer.from('nope'))) != null);
  t.ok('key は中身だけで決まる（同じ中身なら同じ、1 字違えば違う）',
    bundleKey(files) === bundleKey(files.map(f => ({ ...f, body: Buffer.from(f.body) })))
    && bundleKey(files) !== bundleKey([files[0], { ...files[1], body: Buffer.from('export const x = 2;\n') }, files[2]]));

  const scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'agent-host-static-bundle-')));
  try {
    // ---- ホストの束（web/ をディスクから読み直す開発の流れ）
    const web = path.join(scratch, 'web');
    await fs.mkdir(path.join(web, 'locales', 'ja'), { recursive: true });
    await fs.writeFile(path.join(web, 'index.html'), '<meta name="pleiad-build" content="">');
    await fs.writeFile(path.join(web, 'app.mjs'), 'export default 1;\n');
    await fs.writeFile(path.join(web, 'locales', 'ja', 'ui.json'), '{"a":"あ"}');
    await fs.writeFile(path.join(web, 'README.md'), 'not served in the bundle');
    const vendor = path.join(scratch, 'vendor.mjs');
    await fs.writeFile(vendor, 'export const i18n = 1;\n');
    const sb = createStaticBundle({
      webDir: web, mime: MIME,
      extra: () => [{ path: '/vendor/i18next.mjs', file: vendor, type: MIME['.mjs'] }],
      transform: (p, body) => (p === '/index.html' ? Buffer.from(String(body).replace('content=""', 'content="9.9.9+b"')) : body),
    });
    const b1 = await sb.current();
    const d1 = decodeBundle(b1.body);
    t.ok('束には MIME の分かる web/ のファイルと /vendor/i18next.mjs が入り、それ以外（README.md）は入らない',
      [...d1.files.keys()].sort().join(',') === '/app.mjs,/index.html,/locales/ja/ui.json,/vendor/i18next.mjs', [...d1.files.keys()].join(','));
    t.ok('index.html は配るときと同じく版を埋めてから束ねる', d1.files.get('/index.html').body.toString() === '<meta name="pleiad-build" content="9.9.9+b">');
    t.ok('変わっていなければ同じ束を使い回す', (await sb.current()) === b1);
    await new Promise(r => setTimeout(r, 20));
    await fs.writeFile(path.join(web, 'app.mjs'), 'export default 2;\n');
    const b2 = await sb.current();
    t.ok('web/ のファイルを書き換えると、再起動なしで次の束の key が変わり、中身も新しい',
      b2.key !== b1.key && decodeBundle(b2.body).files.get('/app.mjs').body.toString() === 'export default 2;\n');
    await fs.writeFile(path.join(web, 'new.css'), 'a{}');
    const b3 = await sb.current();
    t.ok('ファイルを足しても key が変わる', b3.key !== b2.key && decodeBundle(b3.body).files.has('/new.css'));

    // ---- 本物のホスト・中継・端末
    const relay = createRelay({ enrollSecret: SECRET, trustProxy: false, logger: () => {} });
    const relayPort = (await relay.listen(0, '127.0.0.1')).port;
    const server = await startServer({ env: { AGENT_HOST_BACKENDS: 'fake' }, dataDir: path.join(scratch, 'data'), timeoutMs: 30_000 });
    const c = await within(open({ port: server.port, token: server.token }), 10_000, 'サーバーへの接続');
    const cmd = (command, args = {}) => within(c.cmd(command, args), 15_000, `コマンド ${command}`);
    const devices = [];
    const newDevice = (dir, proxyOptions = {}) => {
      const d = createRemoteDevice({ dir, app: 'test', name: 'phone', platform: 'android',
        proxyOptions: { backoff: { minMs: 200, maxMs: 1000, stableMs: 1000 }, connectTimeoutMs: 5000, requestWaitMs: 5000, ...proxyOptions } });
      devices.push(d);
      return d;
    };
    try {
      // ホストの口（直の接続）: 認証・304・縮め。ふつうの静的ファイルの応答は変わらない
      const noAuth = await request(server.port, '/static-bundle');
      t.ok('/static-bundle もホストの UI トークンが無ければ 401', noAuth.status === 401, String(noAuth.status));
      const auth = { cookie: `agent_host_token=${encodeURIComponent(server.token)}` };
      const full = await request(server.port, '/static-bundle', { headers: auth });
      const hostBundle = decodeBundle(full.body);
      const clientFile = await fs.readFile(path.join(ROOT, 'web', 'client.mjs'));
      t.ok('200 で束が返り、key の見出しと中身（client.mjs・辞書・i18next・版を埋めた index.html）が合う',
        full.status === 200 && full.headers['x-pleiad-bundle-key'] === hostBundle.key && !full.headers['content-encoding']
        && hostBundle.files.get('/client.mjs').body.equals(clientFile) && hostBundle.files.has('/locales/ja/ui.json') && hostBundle.files.has('/vendor/i18next.mjs')
        && /<meta name="pleiad-build" content="[^"]+">/.test(hostBundle.files.get('/index.html').body.toString()), `${full.status} ${full.body.length}`);
      const gzipped = await request(server.port, '/static-bundle', { headers: { ...auth, 'accept-encoding': 'gzip, deflate' } });
      t.ok('accept-encoding に gzip があれば /bulk/ と同じく content-encoding: gzip で縮めて返し、戻すと同じ束',
        gzipped.headers['content-encoding'] === 'gzip' && /accept-encoding/i.test(gzipped.headers.vary ?? '')
        && gzipped.body.length < full.body.length / 2 && zlib.gunzipSync(gzipped.body).equals(full.body), `${gzipped.body.length}/${full.body.length}`);
      const same = await request(server.port, `/static-bundle?have=${hostBundle.key}`, { headers: auth });
      t.ok('have が今の key なら 304（本文なし）', same.status === 304 && same.body.length === 0 && same.headers['x-pleiad-bundle-key'] === hostBundle.key, String(same.status));
      const direct = await request(server.port, '/client.mjs', { headers: auth });
      t.ok('直の接続（デスクトップ・ブラウザー）の静的ファイルは今までどおり 1 本ずつ同じ応答', direct.status === 200 && direct.body.equals(clientFile)
        && direct.headers['content-type'] === 'text/javascript; charset=utf-8' && !direct.headers['x-pleiad-bundle-key']);

      let from = c.mark();
      await cmd('setRemoteSettings', { relayUrl: `http://127.0.0.1:${relayPort}`, enrollSecret: SECRET, enabled: true, hostName: 'desk-test' });
      await c.waitFor(e => e.type === 'remoteStatus' && e.status.connection.state === 'connected', { from, ms: 10_000 });

      async function pairDevice(device) {
        const offer = await cmd('remotePairingStart');
        from = c.mark();
        const pairing = device.pair(offer.payload);
        pairing.catch(() => {});
        const req = await c.waitFor(e => e.type === 'remotePairing' && e.phase === 'request', { from, ms: 10_000 });
        await cmd('remotePairingApprove', { id: req.request.id });
        return (await within(pairing, 15_000, 'ペアリング')).hostId;
      }

      // ---- 新しいアプリ × 新しいホスト: 1 回目は束を取り、以後は端末から配る
      const deviceDir = path.join(scratch, 'device');
      const device = newDevice(deviceDir);
      const hostId = await pairDevice(device);
      const proxy = await within(device.open(hostId), 10_000, 'プロキシを開く');
      await waitConnected(device, hostId);
      const seen = recordHostRequests(proxy);
      const root = await request(proxy.port, `/?token=${proxy.token}`, { headers: { accept: 'text/html' } });
      const setCookie = [root.headers['set-cookie'] ?? []].flat().join('\n');
      t.ok('最初の読み込み: ホストへは束の 1 本だけ（have なし・gzip で）流し、画面は束の index.html',
        seen.length === 1 && seen[0].path === '/static-bundle?have=' && seen[0].status === 200
        && seen[0].acceptEncoding === 'gzip' && seen[0].contentEncoding === 'gzip'
        && root.status === 200 && root.body.equals(hostBundle.files.get('/index.html').body), JSON.stringify(seen));
      t.ok('端末が配るときも ?token= で HttpOnly・SameSite=Strict の Cookie（プロキシのトークン）を返し、ホストのトークンは出ない',
        /pleiad_remote_token=[^;]+; HttpOnly; SameSite=Strict; Path=\//.test(setCookie) && !setCookie.includes('agent_host_token') && !root.body.includes(server.token), setCookie);
      const saved = path.join(deviceDir, 'static', `${hostId}.bin`);
      t.ok('束は端末の置き場にホストごとに保存される', decodeBundle(await fs.readFile(saved)).key === hostBundle.key);
      const cookie = `pleiad_remote_token=${encodeURIComponent(proxy.token)}`;
      const asset = await request(proxy.port, '/client.mjs', { headers: { cookie } });
      const dict = await request(proxy.port, '/locales/ja/ui.json', { headers: { cookie } });
      const head = await request(proxy.port, '/client.mjs', { method: 'HEAD', headers: { cookie } });
      t.ok('読み込みの後の静的ファイル（js・辞書・HEAD）はホストへ流さず端末から返す',
        seen.length === 1 && asset.status === 200 && asset.body.equals(clientFile) && asset.headers['content-type'] === 'text/javascript; charset=utf-8'
        && dict.status === 200 && dict.headers['content-type'] === 'application/json; charset=utf-8' && head.status === 200 && head.body.length === 0
        && Number(head.headers['content-length']) === clientFile.length && !asset.headers['set-cookie'], JSON.stringify(seen));
      const noCookie = await request(proxy.port, '/client.mjs');
      const badCookie = await request(proxy.port, '/client.mjs', { headers: { cookie: 'pleiad_remote_token=wrong' } });
      t.ok('端末から配るものもプロキシのトークンが無い・違えば 401', noCookie.status === 401 && badCookie.status === 401 && seen.length === 1);
      const withQuery = await request(proxy.port, '/client.mjs?v=2', { headers: { cookie } });
      const preview = await request(proxy.port, '/file-preview?path=x', { headers: { cookie } });
      const missing = await request(proxy.port, '/not-in-bundle.mjs', { headers: { cookie } });
      t.ok('束に無いもの・クエリの付いたもの（/file-preview など）はホストへ流す',
        seen.slice(1).map(s => s.path).join(',') === '/client.mjs?v=2,/file-preview?path=x,/not-in-bundle.mjs'
        && withQuery.status === 200 && preview.status !== 200 && missing.status === 404, JSON.stringify(seen));

      const reload = await request(proxy.port, `/?token=${proxy.token}`, { headers: { accept: 'text/html' } });
      const last = seen.at(-1);
      t.ok('読み込み直すたびに版だけ確かめ、同じなら 304（往復 1 回・本文なし）',
        last.path === `/static-bundle?have=${hostBundle.key}` && last.status === 304 && reload.status === 200, JSON.stringify(last));

      // ---- ポートが変わっても（新しいプロキシ・新しいトークン）、保存した束を使う
      await within(device.close(hostId), 5000, 'プロキシを閉じる');
      await device.store.updateHost(hostId, { port: 0 });
      const device2 = newDevice(deviceDir);
      const proxy2 = await within(device2.open(hostId), 10_000, '開き直す');
      await waitConnected(device2, hostId);
      const seen2 = recordHostRequests(proxy2);
      const root2 = await request(proxy2.port, `/?token=${proxy2.token}`, { headers: { accept: 'text/html' } });
      t.ok('開き直して origin（ポート）が変わっても、保存した束の版を見せて 304 で済む',
        proxy2.port !== proxy.port && seen2.length === 1 && seen2[0].path === `/static-bundle?have=${hostBundle.key}` && seen2[0].status === 304
        && root2.body.equals(hostBundle.files.get('/index.html').body), `${proxy.port}->${proxy2.port} ${JSON.stringify(seen2)}`);

      // ---- 版が変わったら必ず取り直す（保存した束が別の版）
      const stale = encodeBundle([{ path: '/index.html', type: MIME['.html'], body: Buffer.from('old ui') }, { path: '/client.mjs', type: MIME['.mjs'], body: Buffer.from('old') }]);
      await within(device2.close(hostId), 5000, 'プロキシを閉じる');
      await fs.writeFile(saved, stale.body);
      const device3 = newDevice(deviceDir);
      const proxy3 = await within(device3.open(hostId), 10_000, '開き直す');
      await waitConnected(device3, hostId);
      const seen3 = recordHostRequests(proxy3);
      const root3 = await request(proxy3.port, `/?token=${proxy3.token}`, { headers: { accept: 'text/html' } });
      const asset3 = await request(proxy3.port, '/client.mjs', { headers: { cookie: `pleiad_remote_token=${encodeURIComponent(proxy3.token)}` } });
      t.ok('保存した束の版がホストと違えば、その場で取り直して新しい画面を返し、保存も差し替える',
        seen3[0]?.path === `/static-bundle?have=${stale.key}` && seen3[0].status === 200 && !root3.body.includes('old ui')
        && asset3.body.equals(clientFile) && decodeBundle(await fs.readFile(saved)).key === hostBundle.key, JSON.stringify(seen3));

      // ---- 保存が壊れていたら使わない（取り直す）
      await within(device3.close(hostId), 5000, 'プロキシを閉じる');
      const broken = Buffer.from(await fs.readFile(saved)); broken[broken.length - 1] ^= 0xff;
      await fs.writeFile(saved, broken);
      const device4 = newDevice(deviceDir);
      const proxy4 = await within(device4.open(hostId), 10_000, '開き直す');
      await waitConnected(device4, hostId);
      const seen4 = recordHostRequests(proxy4);
      const root4 = await request(proxy4.port, `/?token=${proxy4.token}`, { headers: { accept: 'text/html' } });
      t.ok('保存した束が壊れていれば持っていないものとして取り直す', seen4[0]?.path === '/static-bundle?have=' && seen4[0].status === 200 && root4.status === 200, JSON.stringify(seen4));

      // ---- 新しいアプリ × 古いホスト（束の口が無く 404）: 今までどおり 1 本ずつ流す
      await within(device4.close(hostId), 5000, 'プロキシを閉じる');
      const device5 = newDevice(deviceDir);
      const proxy5 = await within(device5.open(hostId), 10_000, '開き直す');
      await waitConnected(device5, hostId);
      // 古いホストは /static-bundle を知らず、ふつうの静的ファイルとして探して 404 を返す。同じ形の口の無いパスに差し替えて試す
      const seen5 = recordHostRequests(proxy5, { rewrite: p => p.replace('/static-bundle', '/static-bundle-unknown') });
      const root5 = await request(proxy5.port, `/?token=${proxy5.token}`, { headers: { accept: 'text/html' } });
      const asset5 = await request(proxy5.port, '/client.mjs', { headers: { cookie: `pleiad_remote_token=${encodeURIComponent(proxy5.token)}` } });
      t.ok('束の口が無いホスト（404）では、画面も静的ファイルも今までどおりホストから 1 本ずつ取る',
        seen5.map(s => `${s.path.split('?')[0]}:${s.status}`).join(',') === '/static-bundle:404,/:200,/client.mjs:200'
        && root5.status === 200 && asset5.body.equals(clientFile), JSON.stringify(seen5));

      // ---- 古いアプリ（束を持たないプロキシ）× 新しいホスト: 今までどおり
      await within(device5.close(hostId), 5000, 'プロキシを閉じる');
      const device6 = newDevice(deviceDir, { staticCacheFile: null });
      const proxy6 = await within(device6.open(hostId), 10_000, '開き直す');
      await waitConnected(device6, hostId);
      const seen6 = recordHostRequests(proxy6);
      const root6 = await request(proxy6.port, `/?token=${proxy6.token}`, { headers: { accept: 'text/html' } });
      const asset6 = await request(proxy6.port, '/client.mjs', { headers: { cookie: `pleiad_remote_token=${encodeURIComponent(proxy6.token)}` } });
      t.ok('束を知らないプロキシ（古いアプリ）は新しいホストから今までどおり 1 本ずつ取れる',
        seen6.map(s => `${s.path}:${s.status}`).join(',') === '/:200,/client.mjs:200' && root6.body.equals(hostBundle.files.get('/index.html').body)
        && asset6.body.equals(clientFile), JSON.stringify(seen6));

      // ---- 忘れると束も消える
      await within(device6.remove(hostId), 5000, 'ホストを忘れる');
      t.ok('ホストを忘れると、そのホストの束も消える', await fs.stat(saved).then(() => false, () => true));
    } finally {
      for (const d of devices) await within(d.closeAll(), 5000, 'プロキシを閉じる').catch(e => t.note(e.message));
      c.close();
      await within(server.stop(), 15_000, 'サーバーの停止').catch(e => t.note(e.message));
      await within(relay.close(), 5000, '中継の停止').catch(e => t.note(e.message));
    }
  } finally {
    await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}
