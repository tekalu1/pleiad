// 外部 MCP の OAuth の残課題（core/mcp-oauth.mjs・core/mcp-url-guard.mjs）。
// 認可サーバーと MCP は tests/lib/mcp-oauth-mock.mjs のモック。実サービスにもブラウザにも触らない。
//   - 127.0.0.1 を拒む AS には localhost で登録し直す（DCR で拒否 / 認可で拒否）。古いクライアントは RFC 7592 で消す
//   - ポートが塞がって DCR をやり直したときも古いクライアントを消す
//   - Client ID Metadata Document（手入力 > メタデータ文書 > DCR）
//   - 403 insufficient_scope のステップアップ
//   - 探索で得た URL の検査（https 必須・内部アドレス・リダイレクト）
//   - 期限の無いトークンの定期リフレッシュ
//   - 旧方式の SSE の MCP でも OAuth が通る
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createSecretStore } from '../../core/secret-store.mjs';
import { createPlyMcp } from '../../core/ply-mcp.mjs';
import { createMcpOAuth } from '../../core/mcp-oauth.mjs';
import { connectServer } from '../../core/context-bridge.mjs';
import { addressKind, createUrlGuard, isLoopbackHost } from '../../core/mcp-url-guard.mjs';
import { pinnedFetch, pinnedLookup } from '../../core/pinned-fetch.mjs';
import { mockOAuth, browse, until, listen } from '../lib/mcp-oauth-mock.mjs';

export const name = 'mcp-oauth-more';
export const title = '外部 MCP の OAuth: localhost への後退と RFC 7592・メタデータ文書・ステップアップ・SSRF の検査・期限の無いトークン・SSE';

export default async function (t) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-mcp-oauth-more-'));
  const mocks = [];
  const mock = async o => { const m = await mockOAuth(o); mocks.push(m); return m; };
  let n = 0;
  /** 1 つの登録ごとにデータ置き場を分けた部品一式 */
  async function setup(value, extra = {}) {
    const dir = path.join(tmp, `d${++n}`);
    const secrets = createSecretStore({ file: path.join(dir, 'mcp-secrets.json') });
    const ply = createPlyMcp({ dataDir: dir, secrets });
    let clock = Date.now();
    const oauth = createMcpOAuth({ secrets, lockDir: path.join(dir, 'mcp-locks'), now: () => clock, ...extra });
    await ply.save({ name: 'srv', mode: 'add', value });
    const def = await ply.registration('srv');
    const login = async () => {
      const started = await oauth.start('srv', def, await ply.connection('srv', tmp));
      const back = await browse(started.url);
      await until(async () => (await oauth.status('srv', def)).state === 'signed-in');
      return { started, back };
    };
    const item = { id: 'srv', name: 'srv', origins: [{ source: 'ply' }], definition: def };
    return { dir, secrets, ply, oauth, def, login, item, advance: ms => { clock += ms; }, state: () => secrets.get('mcp:srv:oauth') };
  }
  try {
    // ================= 1. ループバックの戻り先
    {
      const m = await mock({ rejectLoopbackIp: 'register' });
      const s = await setup({ transport: 'http', url: m.mcpUrl, auth: 'oauth' });
      const { started, back } = await s.login();
      const redirect = new URL(started.redirectUri);
      t.ok('DCR が 127.0.0.1 を拒んだら、localhost の戻り先で登録し直す', redirect.hostname === 'localhost' && m.as.registerAttempts.length === 2 && m.as.registrations.length === 1
        && m.as.registrations[0].redirect_uris[0] === started.redirectUri, JSON.stringify({ redirect: started.redirectUri, attempts: m.as.registerAttempts.map(r => r.redirect_uris) }));
      t.ok('localhost の戻り先でもログインが終わる（待ち受けは 127.0.0.1）', back.status === 200 && (await s.oauth.status('srv', s.def)).state === 'signed-in', String(back.status));
      const again = await s.oauth.start('srv', s.def, await s.ply.connection('srv', tmp));
      t.ok('次のログインは最初から localhost で、登録を使い回す', new URL(again.redirectUri).hostname === 'localhost' && m.as.registerAttempts.length === 2, again.redirectUri);
      // localhost が ::1 に解決される環境向けに、同じポートで ::1 にも待ち受ける（IPv6 が無い環境では確かめられない）
      const v6 = await fetch(`http://[::1]:${new URL(again.redirectUri).port}/callback?state=x`).then(r => r.status, () => null);
      if (v6 === null) t.note('この環境では ::1 に接続できないため、::1 の待ち受けは確かめていない');
      else t.ok('localhost の戻り先では ::1 でも待ち受ける', v6 === 400, String(v6));
      s.oauth.cancel('srv');
    }
    {
      const m = await mock({ rejectLoopbackIp: 'authorize' });
      const s = await setup({ transport: 'http', url: m.mcpUrl, auth: 'oauth' });
      const { started } = await s.login();
      t.ok('認可が 127.0.0.1 を拒むと分かれば、localhost で登録し直してからブラウザを開く', new URL(started.redirectUri).hostname === 'localhost' && new URL(new URL(started.url).searchParams.get('redirect_uri')).hostname === 'localhost'
        && m.as.registrations.length === 2, JSON.stringify({ url: started.url, regs: m.as.registrations.length }));
      t.ok('使わなくなった 127.0.0.1 のクライアントは RFC 7592 で消す', m.as.deleted.includes('dcr-1') && started.removedClients?.[0]?.deleted === true, JSON.stringify({ deleted: m.as.deleted, removed: started.removedClients }));
      t.ok('localhost で認可を通ってログインが終わる', (await s.oauth.status('srv', s.def)).state === 'signed-in');
    }
    {
      // 手入力の clientId が localhost で登録されている AS。認可の前に分かれば localhost に切り替える（DCR はしない）
      const m = await mock({ rejectLoopbackIp: 'authorize', dcr: false });
      const s = await setup({ transport: 'http', url: m.mcpUrl, auth: 'oauth', oauth: { clientId: 'manual-client' } });
      const { started } = await s.login();
      t.ok('手入力の clientId でも localhost に切り替えてログインできる', new URL(started.redirectUri).hostname === 'localhost' && (await s.oauth.status('srv', s.def)).state === 'signed-in' && m.as.registerAttempts.length === 0);
    }
    {
      // ポートが塞がって DCR をやり直したときは、古いクライアントを消す
      const m = await mock();
      const s = await setup({ transport: 'http', url: m.mcpUrl, auth: 'oauth' });
      const first = await s.login();
      const port = Number(new URL(first.started.redirectUri).port);
      const blocker = http.createServer();
      await listen(blocker, port);
      try {
        const second = await s.oauth.start('srv', s.def, await s.ply.connection('srv', tmp));
        t.ok('前回のポートが塞がっていれば、別のポートで DCR をやり直す', Number(new URL(second.redirectUri).port) !== port && m.as.registrations.length === 2);
        t.ok('やり直す前のクライアントは RFC 7592 で消す（registration_access_token を使う）', m.as.deleted.includes('dcr-1') && !m.as.clients.has('dcr-1'), JSON.stringify(m.as.deleted));
        const saved = (await s.state()).client;
        t.ok('新しいクライアントと登録管理の値を保存する', saved.info.client_id === 'dcr-2' && saved.management?.uri?.endsWith('/register/dcr-2') && Boolean(saved.management?.token));
        s.oauth.cancel('srv');
      } finally { blocker.close(); }
    }

    // ================= 3. Client ID Metadata Documents
    {
      const m = await mock({ cimd: true });
      const DOC = 'https://ply.example/oauth/client.json';
      const s = await setup({ transport: 'http', url: m.mcpUrl, auth: 'oauth' }, { clientMetadataUrl: () => DOC });
      const { started } = await s.login();
      t.ok('AS が対応していて URL を設定してあれば、その URL を client_id にする（DCR しない）', new URL(started.url).searchParams.get('client_id') === DOC && m.as.registerAttempts.length === 0, started.url);
      const st = await s.oauth.status('srv', s.def);
      t.ok('状態に client: metadata-document が出る', st.state === 'signed-in' && st.client === 'metadata-document', JSON.stringify(st));
      m.as.access.clear();
      const again = await connectServer(s.item, { cwd: tmp, plyMcp: s.ply, oauth: s.oauth });
      t.ok('メタデータ文書の client_id でリフレッシュできる', again.status === 'connected' && m.as.tokenRequests.at(-1).client_id === DOC, JSON.stringify({ status: again.status, reason: again.reason }));
      await again.client?.close();

      const noSetting = await setup({ transport: 'http', url: m.mcpUrl, auth: 'oauth' });
      await noSetting.login();
      t.ok('URL を設定していなければ DCR', m.as.registrations.length === 1 && (await noSetting.oauth.status('srv', noSetting.def)).client === 'dynamic');
      const manual = await setup({ transport: 'http', url: m.mcpUrl, auth: 'oauth', oauth: { clientId: 'manual-client' } }, { clientMetadataUrl: () => DOC });
      const mStarted = (await manual.login()).started;
      t.ok('手入力の clientId はメタデータ文書より優先', new URL(mStarted.url).searchParams.get('client_id') === 'manual-client' && (await manual.oauth.status('srv', manual.def)).client === 'manual');
      const m2 = await mock({ cimd: false });
      const unsupported = await setup({ transport: 'http', url: m2.mcpUrl, auth: 'oauth' }, { clientMetadataUrl: () => DOC });
      await unsupported.login();
      t.ok('AS が対応を示さなければ、URL を設定していても DCR', m2.as.registrations.length === 1 && (await unsupported.oauth.status('srv', unsupported.def)).client === 'dynamic');
    }
    {
      // 設定値（既定は未設定）と、その検査
      const dir = path.join(tmp, 'settings');
      const ply = createPlyMcp({ dataDir: dir, secrets: createSecretStore({ file: path.join(dir, 's.json') }) });
      t.ok('clientMetadataUrl の既定は未設定', (await ply.settings()).clientMetadataUrl === null);
      let bad;
      try { await ply.setSettings({ clientMetadataUrl: 'http://ply.example/client.json' }); } catch (e) { bad = e; }
      let root;
      try { await ply.setSettings({ clientMetadataUrl: 'https://ply.example/' }); } catch (e) { root = e; }
      t.ok('https でない・パスの無い URL は拒む', /https/.test(bad?.message ?? '') && /パス/.test(root?.message ?? ''));
      await ply.setSettings({ clientMetadataUrl: 'https://ply.example/oauth/client.json' });
      t.ok('設定でき、null で消せる', (await ply.settings()).clientMetadataUrl === 'https://ply.example/oauth/client.json'
        && (await ply.setSettings({ clientMetadataUrl: null })).clientMetadataUrl === null);
      const doc = JSON.parse(await fs.readFile(new URL('../../docs/mcp-oauth-client-metadata.json', import.meta.url), 'utf8'));
      t.ok('公開する文書のひな形がある（戻り先はループバック・公開クライアント）', doc.redirect_uris.every(u => /^http:\/\/(127\.0\.0\.1|localhost)\//.test(u))
        && doc.token_endpoint_auth_method === 'none' && doc.grant_types.includes('refresh_token'), JSON.stringify(doc.redirect_uris));
    }

    // ================= 4. scope のステップアップ
    {
      const m = await mock({ requiredScope: 'write' });
      const s = await setup({ transport: 'http', url: m.mcpUrl, auth: 'oauth' });
      const first = await s.login();
      t.ok('最初は WWW-Authenticate の scope（read）でログイン', new URL(first.started.url).searchParams.get('scope') === 'read');
      const live = await connectServer(s.item, { cwd: tmp, plyMcp: s.ply, oauth: s.oauth });
      let callError;
      try { await live.client.callTool({ name: 'whoami', arguments: {} }); } catch (e) { callError = e; }
      await live.client.close();
      const st = await s.oauth.status('srv', s.def);
      t.ok('403 insufficient_scope を受けると、状態に「追加の権限が必要」が出る', m.rs.forbidden === 1 && Boolean(callError) && st.needsScope === true && st.requiredScope === 'write' && /追加の権限/.test(st.message ?? ''), JSON.stringify(st));
      const second = await s.oauth.start('srv', s.def, await s.ply.connection('srv', tmp));
      t.ok('次のログインは今の scope と合わせて求める', new URL(second.url).searchParams.get('scope') === 'read write', new URL(second.url).searchParams.get('scope'));
      await browse(second.url);
      await until(async () => (await s.oauth.status('srv', s.def)).scope === 'read write');
      const after = await s.oauth.status('srv', s.def);
      t.ok('ログインし直すと「追加の権限が必要」は消える', after.state === 'signed-in' && !after.needsScope && after.scope === 'read write', JSON.stringify(after));
      const retry = await connectServer(s.item, { cwd: tmp, plyMcp: s.ply, oauth: s.oauth });
      const ok = await retry.client.callTool({ name: 'whoami', arguments: {} });
      t.ok('足した権限でツールを呼べる', /token=/.test(ok.content?.[0]?.text ?? ''));
      await retry.client.close();
    }

    // ================= 5. 探索で得た URL の検査
    {
      t.ok('アドレスの種類', addressKind('10.1.2.3') === 'private' && addressKind('172.16.0.1') === 'private' && addressKind('192.168.1.1') === 'private'
        && addressKind('169.254.169.254') === 'link-local' && addressKind('127.0.0.2') === 'loopback' && addressKind('::1') === 'loopback'
        && addressKind('fe80::1') === 'link-local' && addressKind('fd00::1') === 'private' && addressKind('::ffff:10.0.0.1') === 'private'
        && addressKind('::ffff:a00:1') === 'private' && addressKind('100.64.0.1') === 'private' && addressKind('0.0.0.0') === 'unspecified'
        && addressKind('93.184.216.34') === 'public' && addressKind('2606:4700::1111') === 'public' && addressKind('64:ff9b::a9fe:a9fe') === 'link-local');
      t.ok('ループバックの名前', isLoopbackHost('localhost') && isLoopbackHost('127.0.0.1') && isLoopbackHost('[::1]') && isLoopbackHost('app.localhost') && !isLoopbackHost('example.com'));
      const table = { 'mcp.example.com': ['93.184.216.34'], 'as.example.com': ['93.184.216.35'], 'intranet.example.com': ['10.0.0.5'], 'mixed.example.com': ['93.184.216.36', '192.168.0.10'],
        'corp-mcp.internal': ['10.1.1.1'], 'corp-as.internal': ['10.1.1.2'] };
      const lookup = async host => { if (!table[host]) throw new Error('ENOTFOUND'); return table[host].map(address => ({ address })); };
      const reject = async (guard, url) => { try { await guard.check(url); return null; } catch (e) { return e; } };
      const pub = createUrlGuard({ serverUrl: 'https://mcp.example.com/mcp', lookup });
      t.ok('公開の MCP: 公開の https は通す', (await reject(pub, 'https://as.example.com/.well-known/oauth-authorization-server')) === null);
      const toPrivate = await reject(pub, 'https://intranet.example.com/token');
      t.ok('公開の MCP: プライベートに解決される探索先は拒む（理由付き）', toPrivate?.code === 'MCP_URL_REJECTED' && /プライベート/.test(toPrivate.message), toPrivate?.message);
      t.ok('公開の MCP: 解決先の 1 つでも内部なら拒む', Boolean(await reject(pub, 'https://mixed.example.com/')));
      t.ok('公開の MCP: IP 直書きのメタデータ・ループバックも拒む', Boolean(await reject(pub, 'https://169.254.169.254/latest')) && Boolean(await reject(pub, 'https://127.0.0.1/x')) && Boolean(await reject(pub, 'https://[::1]/x')));
      t.ok('https でないものは拒む', /https/.test((await reject(pub, 'http://as.example.com/token'))?.message ?? ''));
      const corp = createUrlGuard({ serverUrl: 'https://corp-mcp.internal/mcp', lookup });
      t.ok('社内（プライベート）の MCP なら、社内の認可サーバーは通す', (await reject(corp, 'https://corp-as.internal/token')) === null);
      const local = createUrlGuard({ serverUrl: 'http://127.0.0.1:9000/mcp', lookup });
      t.ok('ループバックの MCP なら、ループバックの http は通す', (await reject(local, 'http://localhost:9001/token')) === null && (await reject(local, 'http://127.0.0.1:9001/token')) === null);
      t.ok('ループバックの MCP でも、ループバック以外の http は拒む', Boolean(await reject(local, 'http://10.0.0.1/token')));
      const remote = createUrlGuard({ serverUrl: 'https://mcp.example.com/mcp', lookup });
      t.ok('公開の MCP から http のループバックへは誘導されない', Boolean(await reject(remote, 'http://127.0.0.1:9001/token')));

      // リダイレクト: 追う先も同じ規則で検査する
      const hop = http.createServer((req, res) => {
        if (req.url === '/to-metadata') { res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data' }); return res.end(); }
        if (req.url === '/to-local') { res.writeHead(302, { location: '/final' }); return res.end(); }
        if (req.url === '/final') { res.writeHead(200); return res.end('ok'); }
        if (req.url === '/post') { res.writeHead(307, { location: '/final' }); return res.end(); }
        res.writeHead(404); res.end();
      });
      const hopOrigin = await listen(hop);
      try {
        const g = createUrlGuard({ serverUrl: `${hopOrigin}/mcp` }).wrap(fetch, 'テスト');
        const followed = await g(`${hopOrigin}/to-local`);
        t.ok('リダイレクト先が規則に合えば追う', followed.status === 200 && await followed.text() === 'ok');
        let blocked;
        try { await g(`${hopOrigin}/to-metadata`); } catch (e) { blocked = e; }
        t.ok('リダイレクト先が規則に合わなければ止める', blocked?.code === 'MCP_URL_REJECTED', blocked?.message);
        let post;
        try { await g(`${hopOrigin}/post`, { method: 'POST', body: 'x' }); } catch (e) { post = e; }
        t.ok('POST のリダイレクトは追わない', post?.code === 'MCP_URL_REJECTED', post?.message);
      } finally { hop.closeAllConnections(); await new Promise(r => hop.close(r)); }

      // DNS rebinding: 検査で得たアドレスに固定して接続する
      {
        // 1 回目は公開のアドレス、2 回目からは内部のアドレスを返す DNS（検査の後に答えを差し替える攻撃）
        let asked = 0;
        const rebinding = async host => { if (host !== 'rebind.example.com') throw new Error('ENOTFOUND'); asked++; return [{ address: asked === 1 ? '93.184.216.40' : '169.254.169.254' }]; };
        const seen = [];
        const g = createUrlGuard({ serverUrl: 'https://mcp.example.com/mcp', lookup: async host => host === 'mcp.example.com' ? [{ address: '93.184.216.34' }] : rebinding(host) })
          .wrap(async (url, init) => { seen.push({ url, pinned: init.pinnedAddresses }); return new Response('ok'); }, 'テスト');
        await g('https://rebind.example.com/.well-known/oauth-authorization-server');
        t.ok('名前を解決して検査した行き先は、その答えに固定して取りに行く', seen.length === 1 && JSON.stringify(seen[0].pinned) === '["93.184.216.40"]' && asked === 1, JSON.stringify({ seen, asked }));
        seen.length = 0;
        await createUrlGuard({ serverUrl: 'https://mcp.example.com/mcp', lookup: async () => [{ address: '93.184.216.34' }] }).wrap(async (url, init) => { seen.push(init.pinnedAddresses); return new Response('ok'); })('https://93.184.216.41/x');
        const local = [];
        await createUrlGuard({ serverUrl: 'http://127.0.0.1:9000/mcp' }).wrap(async (url, init) => { local.push(init.pinnedAddresses); return new Response('ok'); })('http://localhost:9001/token');
        t.ok('IP の直書きとループバックの開発用の組は固定しない（解決し直さないため）', seen.length === 1 && seen[0] === undefined && local[0] === undefined);

        // pinnedFetch 本体: 名前を DNS に聞かず、固定したアドレスにつなぐ（rebind.invalid は解決できない名前）
        const got = [];
        const target = http.createServer((req, res) => {
          let body = '';
          req.on('data', c => { body += c; });
          req.on('end', () => { got.push({ host: req.headers.host, method: req.method, url: req.url, type: req.headers['content-type'], auth: req.headers.authorization, body }); res.writeHead(201, { 'x-test': 'yes', 'content-type': 'application/json' }); res.end('{"ok":true}'); });
        });
        const origin = await listen(target);
        const port = new URL(origin).port;
        try {
          const res = await pinnedFetch(`http://rebind.invalid:${port}/token?a=1`, { method: 'POST', headers: { authorization: 'Bearer T' }, body: new URLSearchParams({ grant_type: 'refresh_token' }), pinnedAddresses: ['127.0.0.1'] });
          t.ok('固定したアドレスにつなぎ、Host は元の名前のまま（名前は解決し直さない）', res.status === 201 && res.headers.get('x-test') === 'yes' && (await res.json()).ok === true
            && got[0]?.host === `rebind.invalid:${port}` && got[0]?.url === '/token?a=1' && got[0]?.method === 'POST', JSON.stringify(got));
          t.ok('本文と見出しは fetch と同じに送る（URLSearchParams は form の形）', got[0]?.body === 'grant_type=refresh_token' && /x-www-form-urlencoded/.test(got[0]?.type ?? '') && got[0]?.auth === 'Bearer T');
          let failed;
          try { await pinnedFetch(`http://rebind.invalid:${port}/`); } catch (e) { failed = e; }
          t.ok('固定が無ければふつうの fetch（解決できない名前は失敗する）', Boolean(failed));
          const redirect = http.createServer((req, res) => { res.writeHead(302, { location: 'http://169.254.169.254/' }); res.end(); });
          const rOrigin = await listen(redirect);
          try {
            const r = await pinnedFetch(`http://rebind.invalid:${new URL(rOrigin).port}/`, { pinnedAddresses: ['127.0.0.1'] });
            t.ok('固定した取得はリダイレクトを自分では追わない（追うのは検査つきの wrap）', r.status === 302 && r.headers.get('location') === 'http://169.254.169.254/');
          } finally { redirect.closeAllConnections(); await new Promise(r => redirect.close(r)); }
        } finally { target.closeAllConnections(); await new Promise(r => target.close(r)); }
        const both = await new Promise(r => pinnedLookup(['93.184.216.40', '2606:4700::1'])('x', { all: true }, (e, list) => r(list)));
        const v6 = await new Promise(r => pinnedLookup(['93.184.216.40', '2606:4700::1'])('x', { family: 6 }, (e, a, f) => r([a, f])));
        t.ok('lookup の差し替えは all（autoSelectFamily）と family の指定に答える', both.length === 2 && both[1].family === 6 && v6[0] === '2606:4700::1' && v6[1] === 6);
      }

      // 実際のログイン: 保護リソースメタデータが内部の http の認可サーバーを指す
      const m = await mock({ authServers: ['http://10.255.255.1/'] });
      const s = await setup({ transport: 'http', url: m.mcpUrl, auth: 'oauth' });
      let err;
      try { await s.oauth.start('srv', s.def, await s.ply.connection('srv', tmp)); } catch (e) { err = e; }
      const st = await s.oauth.status('srv', s.def);
      t.ok('探索先を拒んだらログインを始めず、理由を状態に出す', err?.code === 'MCP_URL_REJECTED' && /https/.test(st.message ?? '') && st.state === 'signed-out', JSON.stringify({ err: err?.message, st }));
      // 保護リソースメタデータ自体がリダイレクトで内部へ飛ばす。追わずに、MCP の origin を認可サーバーとみなす既定に戻る（そこも無いので失敗）
      const r = await mock({ prmRedirect: 'http://169.254.169.254/latest/meta-data' });
      const s2 = await setup({ transport: 'http', url: r.mcpUrl, auth: 'oauth' });
      let err2;
      try { await s2.oauth.start('srv', s2.def, await s2.ply.connection('srv', tmp)); } catch (e) { err2 = e; }
      t.ok('保護リソースメタデータのリダイレクト先が内部なら取りに行かず、拒んだ理由を出す', /169\.254\.169\.254/.test(err2?.message ?? '') && r.as.authorize.length === 0
        && /169\.254/.test((await s2.oauth.status('srv', s2.def)).message ?? ''), err2?.message);
    }

    // ================= 7. 期限の無いトークン
    {
      const m = await mock({ expiresIn: null });
      const s = await setup({ transport: 'http', url: m.mcpUrl, auth: 'oauth' });
      await s.login();
      const first = (await s.state()).tokens;
      t.ok('期限の無いトークンは expires_at を持たない', first.expires_at === undefined && Boolean(first.refresh_token));
      const calls = m.as.refreshCalls;
      t.ok('取得から 1 時間以内はリフレッシュしない', await s.oauth.accessToken('srv', s.def) === first.access_token && m.as.refreshCalls === calls);
      s.advance(61 * 60_000);
      const renewed = await Promise.all([s.oauth.accessToken('srv', s.def), s.oauth.accessToken('srv', s.def)]);
      t.ok('1 時間を過ぎたら使う前に 1 回だけリフレッシュする', m.as.refreshCalls === calls + 1 && renewed[0] !== first.access_token && renewed[0] === renewed[1], String(m.as.refreshCalls - calls));
      s.advance(61 * 60_000);
      m.as.refresh.clear(); // AS 側でリフレッシュトークンが失効
      const kept = await s.oauth.accessToken('srv', s.def);
      const now = (await s.state()).tokens;
      t.ok('軽いリフレッシュが拒まれても、今のアクセストークンで続ける（リフレッシュトークンだけ捨てる）', kept === renewed[0] && now.access_token === kept && !now.refresh_token);
      t.ok('リフレッシュトークンが無ければ、それ以上は試みない', await s.oauth.accessToken('srv', s.def) === kept && m.as.refreshCalls === calls + 2);
    }

    // ================= 8. 旧方式の SSE
    {
      const m = await mock({ sse: true });
      const s = await setup({ transport: 'sse', url: m.mcpUrl, auth: 'oauth' });
      const before = await connectServer(s.item, { cwd: tmp, plyMcp: s.ply, oauth: s.oauth });
      t.ok('SSE: トークンが無ければ要ログイン', before.status === 'needs-auth' && m.rs.calls === 0);
      const { started } = await s.login();
      t.ok('SSE: GET の 401 から探索してログインできる', new URL(started.url).searchParams.get('resource') === m.mcpUrl && (await s.oauth.status('srv', s.def)).state === 'signed-in');
      const live = await connectServer(s.item, { cwd: tmp, plyMcp: s.ply, oauth: s.oauth });
      t.ok('SSE: 保存したトークンでつながり、ツールが見える', live.status === 'connected' && live.tools.length === 1, JSON.stringify({ status: live.status, reason: live.reason }));
      const called = await live.client?.callTool({ name: 'whoami', arguments: {} }).catch(e => ({ error: e.message }));
      t.ok('SSE: POST（/messages）にもトークンが付く', called?.content?.[0]?.text === 'sse', JSON.stringify(called));
      await live.client?.close();
      m.as.access.clear();
      const calls = m.as.refreshCalls;
      const retried = await connectServer(s.item, { cwd: tmp, plyMcp: s.ply, oauth: s.oauth });
      t.ok('SSE: 401 で 1 回リフレッシュして再送し、つながる', retried.status === 'connected' && m.as.refreshCalls === calls + 1, JSON.stringify({ status: retried.status, reason: retried.reason }));
      await retried.client?.close();
    }
  } finally {
    for (const m of mocks) await m.close();
    await fs.rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}
