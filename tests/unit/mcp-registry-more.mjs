// 外部 MCP の登録と秘密の置き場の残課題（core/secret-store.mjs・core/ply-mcp.mjs・core/mcp-import.mjs）。
//   - 暗号化できる起動になったら平文の項目を暗号化し直す。暗号化済みを読めない起動（npm start）では上書きで消さない
//   - 登録名の変更（秘密・OAuth の状態・ロック名を引き継ぐ）
//   - Claude / Codex の登録の取り込み（トークンは流用しない・秘密は選んだときだけ写す）
// Electron は起動しない（safeStorage は身代わり）。認可サーバーと MCP は tests/lib/mcp-oauth-mock.mjs のモック。
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { createSecretStore, parentPortCipher, plainCipher, withFileLock } from '../../core/secret-store.mjs';
import { createPlyMcp, MASK } from '../../core/ply-mcp.mjs';
import { createMcpOAuth } from '../../core/mcp-oauth.mjs';
import { createMcpConfig } from '../../core/mcp-config.mjs';
import { convertNative, importNativeMcp } from '../../core/mcp-import.mjs';
import { connectServer } from '../../core/context-bridge.mjs';
import { mockOAuth, browse, until, listen } from '../lib/mcp-oauth-mock.mjs';

const require = createRequire(import.meta.url);
const { createSecretHandler } = require('../../desktop/secret-bridge.cjs');

export const name = 'mcp-registry-more';
export const title = '外部 MCP: 平文の暗号化し直しと npm start での保全・登録名の変更・Claude / Codex の登録の取り込み';

function encryptingCipher() {
  const flip = s => Buffer.from(s, 'utf8').map(b => b ^ 0x5a);
  const safeStorage = { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'gnome_libsecret',
    encryptString: s => Buffer.concat([Buffer.from('v10'), flip(s)]), decryptString: b => Buffer.from(flip(b.subarray(3).toString('utf8'))).toString('utf8') };
  const handle = createSecretHandler({ safeStorage, platform: 'win32' });
  const port = new EventEmitter();
  port.postMessage = message => setImmediate(() => port.emit('message', { data: handle(message) }));
  return parentPortCipher(port);
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const sha = s => crypto.createHash('sha256').update(s).digest('hex');

export default async function (t) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-mcp-registry-'));
  const mocks = [];
  try {
    // ================= 6. 暗号化の切り替え
    {
      const file = path.join(tmp, 'switch', 'mcp-secrets.json');
      const plain = createSecretStore({ file, cipher: plainCipher });
      await plain.set('mcp:a:static', { bearer: 'PLAIN_SENTINEL_A' });
      await plain.set('mcp:b:oauth', { tokens: { refresh_token: 'PLAIN_SENTINEL_B' } });
      t.ok('npm start では平文で置く', (await fs.readFile(file, 'utf8')).includes('PLAIN_SENTINEL_A'));
      t.ok('暗号化できない起動では、暗号化し直さない', await plain.migrate() === 0);
      const desktop = createSecretStore({ file, cipher: encryptingCipher() });
      const migrated = await desktop.migrate();
      const raw = await fs.readFile(file, 'utf8');
      t.ok('暗号化できる起動になったら、平文の項目を暗号化し直す', migrated === 2 && !raw.includes('PLAIN_SENTINEL') && !raw.includes('"plain"'), `${migrated} ${raw.slice(0, 200)}`);
      t.ok('暗号化し直した値を読める', (await desktop.get('mcp:b:oauth')).tokens.refresh_token === 'PLAIN_SENTINEL_B' && (await desktop.status()).plainEntries === 0);
      t.ok('2 回目は何もしない', await desktop.migrate() === 0);

      // 同時に書き込みがあっても取りこぼさない（ロックの中で読み直す）
      await plain.set('mcp:c:static', { bearer: 'PLAIN_SENTINEL_C' });
      await Promise.all([desktop.migrate(), plain.set('mcp:d:static', { bearer: 'PLAIN_SENTINEL_D' })]);
      await desktop.migrate();
      t.ok('暗号化し直しと別の書き込みが重なっても全部残る', (await desktop.keys('mcp:')).length === 4 && (await desktop.get('mcp:d:static')).bearer === 'PLAIN_SENTINEL_D');

      // ---- 暗号化済みを読めない起動（npm start）。上書きで消さない
      const before = JSON.parse(await fs.readFile(file, 'utf8')).entries;
      const locked = createSecretStore({ file, cipher: plainCipher });
      await locked.set('mcp:e:static', { bearer: 'NEW_PLAIN' });
      const after = JSON.parse(await fs.readFile(file, 'utf8')).entries;
      t.ok('npm start で別の項目を書いても、暗号化済みの項目はそのまま残る', ['mcp:a:static', 'mcp:b:oauth', 'mcp:c:static', 'mcp:d:static'].every(k => JSON.stringify(after[k]) === JSON.stringify(before[k])));
      let err;
      try { await locked.update('mcp:b:oauth', v => ({ ...v, tokens: {} })); } catch (e) { err = e; }
      t.ok('読めない項目の書き換えは SECRET_LOCKED で止まり、元の値を消さない', err?.code === 'SECRET_LOCKED' && /Pleiad デスクトップ/.test(err.message)
        && JSON.stringify(JSON.parse(await fs.readFile(file, 'utf8')).entries['mcp:b:oauth']) === JSON.stringify(before['mcp:b:oauth']));
      const ply = createPlyMcp({ dataDir: path.dirname(file), secrets: locked });
      await fs.writeFile(ply.file, JSON.stringify({ version: 1, servers: { a: { transport: 'http', url: 'https://mcp.example/mcp', auth: 'bearer', enabled: true } } }));
      let editErr;
      try { await ply.save({ name: 'a', mode: 'edit', value: { transport: 'http', url: 'https://mcp.example/mcp', auth: 'bearer', bearerToken: MASK } }); } catch (e) { editErr = e; }
      t.ok('npm start で暗号化済みの登録を編集しようとしても、秘密を消さずに止まる', editErr?.code === 'SECRET_LOCKED' && JSON.stringify(JSON.parse(await fs.readFile(file, 'utf8')).entries['mcp:a:static']) === JSON.stringify(before['mcp:a:static']));
      const oauth = createMcpOAuth({ secrets: locked, lockDir: path.join(tmp, 'switch', 'locks') });
      await locked.delete('mcp:e:static');
      const state = await oauth.status('b', { auth: 'oauth', url: 'https://mcp.example/mcp' });
      t.ok('状態は locked で「Pleiad デスクトップで開いてください」', state.state === 'locked' && /Pleiad デスクトップ/.test(state.message ?? ''), JSON.stringify(state));
      await locked.move('mcp:c:', 'mcp:c2:');
      t.ok('npm start でも、暗号化済みの項目を復号せずに名前だけ移せる', JSON.stringify(JSON.parse(await fs.readFile(file, 'utf8')).entries['mcp:c2:static']) === JSON.stringify(before['mcp:c:static'])
        && (await desktop.get('mcp:c2:static')).bearer === 'PLAIN_SENTINEL_C');
    }

    // ================= 13. 登録名の変更
    {
      const m = await mockOAuth(); mocks.push(m);
      const dir = path.join(tmp, 'rename');
      const secrets = createSecretStore({ file: path.join(dir, 'mcp-secrets.json') });
      const ply = createPlyMcp({ dataDir: dir, secrets });
      let clock = Date.now();
      const lockDir = path.join(dir, 'mcp-locks');
      const oauth = createMcpOAuth({ secrets, lockDir, now: () => clock });
      await ply.save({ name: 'old', mode: 'add', value: { transport: 'http', url: m.mcpUrl, auth: 'oauth', oauth: { scope: 'read' } } });
      const def = await ply.registration('old');
      const started = await oauth.start('old', def, await ply.connection('old', tmp));
      await browse(started.url);
      await until(async () => (await oauth.status('old', def)).state === 'signed-in');
      await ply.save({ name: 'hdr', mode: 'add', value: { transport: 'http', url: 'https://mcp.example/h', auth: 'headers', headers: { 'X-Key': 'HDR_SENTINEL' } } });

      // リフレッシュのロック（別のプロセスがリフレッシュ中の代わり）を持っている間は、名前の変更は待つ
      const lockFile = path.join(lockDir, `${sha('old').slice(0, 24)}.lock`);
      let released = 0;
      const holder = withFileLock(lockFile, async () => { await sleep(300); released = Date.now(); });
      await sleep(30);
      let doneAt = 0;
      const renaming = ply.rename('old', 'new', { guard: (d, fn) => oauth.rename('old', 'new', d, fn) }).then(r => { doneAt = Date.now(); return r; });
      await holder;
      const renamed = await renaming;
      t.ok('リフレッシュのロックを持っている間は、名前の変更を待つ', released > 0 && doneAt >= released, `${doneAt - released}`);
      const moved = await ply.registration('new');
      const list = await ply.list();
      t.ok('名前が変わり、古い名前は消える', renamed.name === 'new' && renamed.from === 'old' && list.servers.map(s => s.name).join() === 'hdr,new');
      t.ok('ロック名（lockId）を引き継ぎ、画面には出さない', moved.lockId === 'old' && !('lockId' in list.servers.find(s => s.name === 'new')));
      t.ok('OAuth の状態を引き継ぐ（ログイン済みのまま）', (await oauth.status('new', moved)).state === 'signed-in' && await secrets.get('mcp:old:oauth') === undefined);
      clock += 3600_000;
      const calls = m.as.refreshCalls;
      const item = { id: 'new', name: 'new', origins: [{ source: 'ply' }], definition: moved };
      const live = await connectServer(item, { cwd: tmp, plyMcp: ply, oauth });
      t.ok('名前を変えたあとも同じロックでリフレッシュしてつながる', live.status === 'connected' && m.as.refreshCalls === calls + 1, JSON.stringify({ status: live.status, reason: live.reason }));
      await live.client?.close();
      await ply.save({ name: 'new', mode: 'edit', value: (await ply.read('new')).value });
      t.ok('編集してもロック名は変わらない', (await ply.registration('new')).lockId === 'old');
      await ply.rename('hdr', 'hdr2');
      t.ok('静的な秘密も引き継ぐ', (await ply.connection('hdr2', tmp)).headers['X-Key'] === 'HDR_SENTINEL' && (await secrets.keys('mcp:hdr:')).length === 0);
      const errors = [];
      for (const [from, to] of [['new', 'hdr2'], ['missing', 'x'], ['new', 'ply'], ['new', 'bad name']]) { try { await ply.rename(from, to); errors.push(null); } catch (e) { errors.push(e.code); } }
      t.ok('既にある名前・無い登録・予約名・不正な名前には変えられない', errors.every(c => c === 'INVALID'), JSON.stringify(errors));
    }

    // ================= 9. ネイティブ登録の取り込み
    {
      const m = await mockOAuth(); mocks.push(m);
      const open = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}'); });
      const openOrigin = await listen(open);
      try {
        const home = path.join(tmp, 'home'), codexHome = path.join(home, '.codex'), cwd = path.join(tmp, 'proj');
        await fs.mkdir(codexHome, { recursive: true }); await fs.mkdir(cwd, { recursive: true });
        const claudeJson = { oauthAccount: { emailAddress: 'someone@example.com' }, mcpServers: {
          'claude-hdr': { type: 'http', url: 'https://mcp.example/h', headers: { Authorization: 'Bearer ${TEST_TOKEN}', 'X-Team': 'team-1' } },
          'claude-oauth': { type: 'http', url: m.mcpUrl, oauth: { clientId: 'native-client', callbackPort: 38123 } },
          'claude-stdio': { command: 'node', args: ['server.mjs'], env: { API_KEY: 'STDIO_SENTINEL' } },
          'claude-plain': { type: 'http', url: m.mcpUrl },
          'claude-open': { type: 'sse', url: `${openOrigin}/sse` },
        }, projects: { [cwd]: { mcpServers: { 'claude-local': { type: 'http', url: 'https://local.example/mcp' } } } } };
        await fs.writeFile(path.join(home, '.claude.json'), JSON.stringify(claudeJson));
        await fs.writeFile(path.join(codexHome, 'config.toml'), [
          '[mcp_servers.codex-bearer]', 'url = "https://mcp.example/c"', 'bearer_token_env_var = "TEST_CODEX_TOKEN"', 'tool_timeout_sec = 90', '',
          '[mcp_servers.codex-oauth]', `url = "${m.mcpUrl}"`, 'scopes = ["read", "write"]', `oauth_resource = "${m.mcpUrl}"`, '',
          '[mcp_servers.codex-env]', 'url = "https://mcp.example/e"', 'env_http_headers = { "X-Api-Key" = "TEST_MISSING_VAR" }', '',
          '[mcp_servers.codex-stdio]', 'command = "node"', 'args = ["s.mjs"]', 'env_vars = ["TEST_CODEX_TOKEN"]', 'enabled = false', '',
        ].join('\n'));
        const nativeBefore = await Promise.all([fs.readFile(path.join(home, '.claude.json'), 'utf8'), fs.readFile(path.join(codexHome, 'config.toml'), 'utf8')]);
        const env = { TEST_TOKEN: 'CLAUDE_TOKEN_SENTINEL', TEST_CODEX_TOKEN: 'CODEX_TOKEN_SENTINEL' };
        const dir = path.join(tmp, 'import');
        const secrets = createSecretStore({ file: path.join(dir, 'mcp-secrets.json') });
        const ply = createPlyMcp({ dataDir: dir, secrets });
        const oauth = createMcpOAuth({ secrets, lockDir: path.join(dir, 'locks') });
        const mcpConfig = createMcpConfig({ home, codexHome });
        const items = ['claude-hdr', 'claude-oauth', 'claude-stdio', 'claude-plain', 'claude-open'].map(n => ({ format: 'claude', scope: 'user', cwd, name: n }))
          .concat(['codex-bearer', 'codex-oauth', 'codex-env', 'codex-stdio'].map(n => ({ format: 'codex', scope: 'user', cwd, name: n })))
          .concat([{ format: 'claude', scope: 'local', cwd, name: 'claude-local' }, { format: 'claude', scope: 'user', cwd, name: 'nothing' }]);
        const result = await importNativeMcp({ items, mcpConfig, plyMcp: ply, detect: d => oauth.detect(d), env, home });
        const by = Object.fromEntries(result.results.map(r => [r.name, r]));
        t.ok('1 回の操作でまとめて取り込み、失敗した 1 件は理由付きで返す', result.imported === 10 && by.nothing.ok === false && Boolean(by.nothing.error), JSON.stringify(result.results.filter(r => !r.ok)));
        const secretsRaw = await fs.readFile(secrets.file, 'utf8').catch(() => '');
        t.ok('既定では秘密の値を写さない（未入力として登録）', !/SENTINEL/.test(secretsRaw) && by['claude-hdr'].pending.join() === 'header:Authorization,header:X-Team'
          && by['claude-stdio'].pending.join() === 'env:API_KEY' && by['codex-bearer'].pending.join() === 'bearer', JSON.stringify([by['claude-hdr'].pending, by['claude-stdio'].pending, by['codex-bearer'].pending]));
        const hdrItem = { id: 'h', name: 'claude-hdr', origins: [{ source: 'ply' }], definition: await ply.registration('claude-hdr') };
        const pendingConn = await connectServer(hdrItem, { cwd, plyMcp: ply, oauth });
        t.ok('未入力の値がある登録にはつながず、理由を出す', pendingConn.status === 'needs-auth' && /未入力/.test(pendingConn.reason), JSON.stringify(pendingConn));
        const editable = await ply.read('claude-hdr');
        t.ok('編集欄では未入力が null で出る', editable.value.headers.Authorization === null && editable.value.headers['X-Team'] === null);
        await ply.save({ name: 'claude-hdr', mode: 'edit', value: { ...editable.value, headers: { Authorization: 'Bearer typed', 'X-Team': null } } });
        const partly = await ply.registration('claude-hdr');
        t.ok('値を入れたものだけ埋まり、null のままのものは未入力で残る', partly.pending.join() === 'header:X-Team');
        await ply.save({ name: 'claude-hdr', mode: 'edit', value: { ...(await ply.read('claude-hdr')).value, headers: { Authorization: MASK, 'X-Team': 't' } } });
        t.ok('全部入れると未入力が消え、つなげる形になる', !(await ply.registration('claude-hdr')).pending && (await ply.connection('claude-hdr', cwd)).headers.Authorization === 'Bearer typed');

        const co = await ply.registration('claude-oauth');
        t.ok('Claude の oauth（clientId・callbackPort）を取り込み、未ログインから始まる', co.auth === 'oauth' && co.oauth.clientId === 'native-client' && co.oauth.callbackPort === 38123
          && by['claude-oauth'].needsLogin === true && (await oauth.status('claude-oauth', co)).state === 'signed-out');
        const xo = await ply.registration('codex-oauth');
        t.ok('Codex の scopes・oauth_resource を取り込む', xo.auth === 'oauth' && xo.oauth.scope === 'read write' && xo.oauth.resource === m.mcpUrl, JSON.stringify(xo.oauth));
        t.ok('エージェントのトークンは流用しない（OAuth の状態を作らない）', (await secrets.keys('')).every(k => !k.endsWith(':oauth')));
        t.ok('手がかりの無い HTTP は、MCP が Bearer の 401 を返せば OAuth', (await ply.registration('claude-plain')).auth === 'oauth' && /OAuth/.test(by['claude-plain'].notes.join()));
        t.ok('401 を返さなければ認証なし（SSE の形も保つ）', (await ply.registration('claude-open')).auth === 'none' && (await ply.registration('claude-open')).transport === 'sse');
        const xb = await ply.registration('codex-bearer');
        t.ok('Codex の bearer_token_env_var は bearer、tool_timeout_sec も写す', xb.auth === 'bearer' && xb.tool_timeout_sec === 90);
        const xs = await ply.registration('codex-stdio');
        t.ok('Codex の env_vars は env のキー、enabled=false も写す', xs.transport === 'stdio' && xs.envKeys.join() === 'TEST_CODEX_TOKEN' && xs.enabled === false);
        t.ok('Claude の「このディレクトリだけ」の登録も取り込める', (await ply.registration('claude-local')).url === 'https://local.example/mcp');
        const after = await Promise.all([fs.readFile(path.join(home, '.claude.json'), 'utf8'), fs.readFile(path.join(codexHome, 'config.toml'), 'utf8')]);
        t.ok('エージェントの設定ファイルは書き換えない', after[0] === nativeBefore[0] && after[1] === nativeBefore[1]);

        // 秘密も写すと選んだとき。Claude の ${VAR} は Pleiad を動かす環境から展開する。見つからない変数は未入力にする
        const again = await importNativeMcp({ items: [
          { format: 'claude', scope: 'user', cwd, name: 'claude-hdr', as: 'hdr-with' },
          { format: 'claude', scope: 'user', cwd, name: 'claude-stdio', as: 'stdio-with' },
          { format: 'codex', scope: 'user', cwd, name: 'codex-bearer', as: 'bearer-with' },
          { format: 'codex', scope: 'user', cwd, name: 'codex-env', as: 'env-with' },
          { format: 'claude', scope: 'user', cwd, name: 'claude-hdr' },
        ], includeSecrets: true, mcpConfig, plyMcp: ply, env, home });
        const g = Object.fromEntries(again.results.map(r => [r.name, r]));
        t.ok('秘密も写すと選べば、ヘッダー・env・bearer の値を写す（${VAR} を展開）', (await ply.connection('hdr-with', cwd)).headers.Authorization === 'Bearer CLAUDE_TOKEN_SENTINEL'
          && (await ply.connection('stdio-with', cwd)).env.API_KEY === 'STDIO_SENTINEL' && (await ply.connection('bearer-with', cwd)).headers.Authorization === 'Bearer CODEX_TOKEN_SENTINEL');
        t.ok('環境変数が見つからない値は未入力にして、そう伝える', g['env-with'].pending.join() === 'header:X-Api-Key' && /TEST_MISSING_VAR/.test(g['env-with'].notes.join()));
        t.ok('同名が既にあれば取り込まない（上書きしない）', g['claude-hdr'].ok === false && (await ply.connection('claude-hdr', cwd)).headers.Authorization === 'Bearer typed');
        const direct = convertNative('claude', { type: 'http', url: 'https://x.example/m', oauth: { clientId: 'c', authServerMetadataUrl: 'https://as.example' }, headers: { A: 'b' } });
        t.ok('取り込めない項目とヘッダーの併用は、外したことを伝える', direct.value.auth === 'oauth' && direct.notes.some(s => /authServerMetadataUrl/.test(s)) && direct.notes.some(s => /併用/.test(s)), JSON.stringify(direct.notes));
      } finally { open.closeAllConnections(); await new Promise(r => open.close(r)); }
    }
  } finally {
    for (const m of mocks) await m.close();
    await fs.rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}
