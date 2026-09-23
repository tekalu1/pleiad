// 外部 MCP の秘密の置き場（core/secret-store.mjs）と、main 側の safeStorage 中継（desktop/secret-bridge.cjs）。
// Electron は起動しない。safeStorage と parentPort は身代わりで、暗号化できる / できない（basic_text）/ 復号できない起動を通す。
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { createSecretStore, parentPortCipher, plainCipher, withFileLock } from '../../core/secret-store.mjs';
import { createPlyMcp, splitRegistration, MASK } from '../../core/ply-mcp.mjs';

const require = createRequire(import.meta.url);
const { createSecretHandler, openableAuthUrl } = require('../../desktop/secret-bridge.cjs');

export const name = 'mcp-secret-store';
export const title = '外部 MCP の秘密: safeStorage 経由の暗号化・平文へのフォールバック・排他・Pleiad の登録';

/** main と utility の parentPort を 1 組にした身代わり。postMessage は非同期で相手に届く */
function portPair(handle) {
  const utility = new EventEmitter();
  utility.postMessage = message => setImmediate(() => utility.emit('message', { data: handle(message) }));
  return utility;
}
function fakeSafeStorage({ available = true, backend = 'gnome_libsecret' } = {}) {
  const flip = s => Buffer.from(s, 'utf8').map(b => b ^ 0x5a);
  return {
    isEncryptionAvailable: () => available,
    getSelectedStorageBackend: () => backend,
    encryptString: s => Buffer.concat([Buffer.from('v10'), flip(s)]),
    decryptString: b => { if (b.subarray(0, 3).toString() !== 'v10') throw new Error('bad'); return Buffer.from(flip(b.subarray(3).toString('utf8'))).toString('utf8'); },
  };
}

export default async function (t) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-secrets-'));
  try {
    // ---- 暗号化できる起動（main が safeStorage で答える）
    const encFile = path.join(tmp, 'enc', 'mcp-secrets.json');
    const cipher = parentPortCipher(portPair(createSecretHandler({ safeStorage: fakeSafeStorage(), platform: 'win32' })));
    const enc = createSecretStore({ file: encFile, cipher });
    await enc.set('mcp:a:oauth', { tokens: { access_token: 'ACCESS_SENTINEL', refresh_token: 'REFRESH_SENTINEL' } });
    const raw = await fs.readFile(encFile, 'utf8');
    t.ok('暗号化できる起動では値を平文で書かない', !raw.includes('ACCESS_SENTINEL') && !raw.includes('REFRESH_SENTINEL') && raw.includes('"safeStorage"'));
    t.ok('暗号化した値を読み戻せる', (await enc.get('mcp:a:oauth')).tokens.refresh_token === 'REFRESH_SENTINEL');
    const encStatus = await enc.status();
    t.ok('状態に「暗号化あり」が出る', encStatus.encrypted === true && encStatus.backend === 'dpapi', JSON.stringify(encStatus));

    // ---- 暗号化して保存したものを、暗号化できない起動（npm start）で読む
    const locked = createSecretStore({ file: encFile, cipher: plainCipher });
    let lockedError;
    try { await locked.get('mcp:a:oauth'); } catch (e) { lockedError = e; }
    t.ok('暗号化済みの値は npm start では復号できないと分かる', lockedError?.code === 'SECRET_LOCKED', lockedError?.message);

    // ---- Linux の basic_text は暗号化とみなさない
    const linux = createSecretHandler({ safeStorage: fakeSafeStorage({ backend: 'basic_text' }), platform: 'linux' });
    const basic = linux({ type: 'secret', id: 1, op: 'status' });
    t.ok('basic_text は「暗号化できない」と答える', basic.ok && basic.value.available === false && /basic_text/.test(basic.value.reason), JSON.stringify(basic));
    t.ok('basic_text では暗号化の依頼を断る', linux({ type: 'secret', id: 2, op: 'encrypt', value: 'x' }).ok === false);
    const plainFile = path.join(tmp, 'plain', 'mcp-secrets.json');
    const fallback = createSecretStore({ file: plainFile, cipher: parentPortCipher(portPair(linux)) });
    await fallback.set('mcp:b:static', { bearer: 'BEARER_SENTINEL' });
    const plainStatus = await fallback.status();
    t.ok('basic_text の起動では平文に切り替え、「暗号化されていない」と分かる', plainStatus.encrypted === false && plainStatus.plainEntries === 1 && /basic_text/.test(plainStatus.reason ?? ''), JSON.stringify(plainStatus));
    t.ok('平文でも読み戻せる', (await fallback.get('mcp:b:static')).bearer === 'BEARER_SENTINEL');
    if (process.platform !== 'win32') t.ok('平文のファイルは所有者だけが読める（0600）', ((await fs.stat(plainFile)).mode & 0o777) === 0o600);
    else t.note('Windows ではファイルの mode を確かめない（POSIX の権限が無い）');
    const unavailable = createSecretHandler({ safeStorage: fakeSafeStorage({ available: false }), platform: 'darwin' });
    t.ok('safeStorage が使えなければ「暗号化できない」と答える', unavailable({ type: 'secret', id: 3, op: 'status' }).value.available === false);
    t.ok('復号の失敗は値を含まない固定の文で返す', !JSON.stringify(createSecretHandler({ safeStorage: fakeSafeStorage(), platform: 'win32' })({ type: 'secret', id: 4, op: 'decrypt', value: Buffer.from('SECRET_TEXT').toString('base64') })).includes('SECRET_TEXT'));

    // ---- main が答えない（古い版）なら平文扱いにして止まらない
    const silent = new EventEmitter(); silent.postMessage = () => {};
    const quiet = parentPortCipher(silent, { timeoutMs: 50 });
    t.ok('main が答えなければ平文扱い', (await quiet.status()).encrypted === false);

    // ---- 同時の書き込みで取りこぼさない（同じプロセスの中と、別の「プロセス」＝別のストア）
    const shared = path.join(tmp, 'shared', 'mcp-secrets.json');
    const one = createSecretStore({ file: shared }), two = createSecretStore({ file: shared });
    await Promise.all(Array.from({ length: 20 }, (_, i) => (i % 2 ? one : two).set(`k${i}`, { i })));
    t.ok('別々のストアから同時に書いても全部残る', (await one.keys('k')).length === 20);
    await Promise.all(Array.from({ length: 10 }, () => one.update('counter', v => ({ n: (v?.n ?? 0) + 1 }))).concat(Array.from({ length: 10 }, () => two.update('counter', v => ({ n: (v?.n ?? 0) + 1 })))));
    t.ok('読んで・変えて・書くが排他される', (await one.get('counter')).n === 20, JSON.stringify(await one.get('counter')));
    const leftovers = (await fs.readdir(path.dirname(shared))).filter(f => f.endsWith('.tmp') || f.endsWith('.lock'));
    t.ok('一時ファイルとロックを残さない', leftovers.length === 0, leftovers.join(','));
    // 落ちたプロセスのロックは古くなれば壊してよい
    const stale = path.join(tmp, 'stale.lock');
    await fs.writeFile(stale, '1');
    const old = new Date(Date.now() - 60_000); await fs.utimes(stale, old, old);
    t.ok('古いロックは壊して進む', await withFileLock(stale, async () => 'ran', { timeoutMs: 200, staleMs: 1000 }) === 'ran');
    await fs.writeFile(path.join(tmp, 'broken.json'), '{not json');
    let broken;
    try { await createSecretStore({ file: path.join(tmp, 'broken.json') }).set('x', 1); } catch (e) { broken = e; }
    t.ok('壊れたファイルを黙って空で上書きしない', Boolean(broken) && (await fs.readFile(path.join(tmp, 'broken.json'), 'utf8')) === '{not json');

    // ---- ブラウザで開いてよい URL
    t.ok('同意画面は https とループバックの http だけ開く', openableAuthUrl('https://as.example/authorize') && openableAuthUrl('http://127.0.0.1:9/authorize')
      && !openableAuthUrl('http://as.example/authorize') && !openableAuthUrl('file:///etc/passwd') && !openableAuthUrl('https://u:p@as.example/'));

    // ---- Pleiad の登録。秘密は登録ファイルに書かず、画面にも返さない
    const plyStore = createSecretStore({ file: path.join(tmp, 'ply', 'mcp-secrets.json') });
    const ply = createPlyMcp({ dataDir: path.join(tmp, 'ply'), secrets: plyStore });
    await ply.save({ name: 'remote', mode: 'add', value: { transport: 'http', url: 'https://mcp.example/mcp?key=QUERY_SENTINEL', auth: 'headers', headers: { 'X-Api-Key': 'HEADER_SENTINEL' } } });
    await ply.save({ name: 'local', mode: 'add', value: { transport: 'stdio', command: 'node', args: ['x.mjs'], env: { API_KEY: 'ENV_SENTINEL' } } });
    const regFile = await fs.readFile(ply.file, 'utf8');
    t.ok('登録ファイルに秘密の値を書かない', !regFile.includes('HEADER_SENTINEL') && !regFile.includes('ENV_SENTINEL') && regFile.includes('X-Api-Key'));
    const listed = JSON.stringify(await ply.list());
    t.ok('一覧は秘密と URL のクエリを返さない', !/HEADER_SENTINEL|ENV_SENTINEL|QUERY_SENTINEL/.test(listed), listed);
    const opened = await ply.read('remote');
    t.ok('編集欄では秘密を伏せ字にする', opened.value.headers['X-Api-Key'] === MASK && !JSON.stringify(opened).includes('HEADER_SENTINEL'));
    await ply.save({ name: 'remote', mode: 'edit', value: opened.value });
    const conn = await ply.connection('remote', tmp);
    t.ok('伏せ字のまま保存し直すと前の値と URL が残る', conn.headers['X-Api-Key'] === 'HEADER_SENTINEL' && conn.url.endsWith('QUERY_SENTINEL'));
    t.ok('stdio の env の値は接続のときだけ読む', (await ply.connection('local', tmp)).env.API_KEY === 'ENV_SENTINEL');
    await plyStore.set('mcp:remote:oauth', { serverUrl: 'x', tokens: { access_token: 'a' } });
    const reset = await ply.save({ name: 'remote', mode: 'edit', value: { transport: 'http', url: 'https://other.example/mcp', auth: 'oauth' } });
    t.ok('接続先や方式を変えたら OAuth の状態を捨てる', reset.oauthReset === true && await plyStore.get('mcp:remote:oauth') === undefined);
    const rejects = (label, value) => { try { splitRegistration(value); t.ok(label, false); } catch (e) { t.ok(label, e.code === 'INVALID', e.message); } };
    rejects('改行を含むヘッダー値は受け付けない', { transport: 'http', url: 'https://x.example', auth: 'headers', headers: { A: 'x\r\nB: y' } });
    rejects('Host などのヘッダーは指定できない', { transport: 'http', url: 'https://x.example', auth: 'headers', headers: { Host: 'evil' } });
    rejects('URL に認証情報を含めない', { transport: 'http', url: 'https://u:p@x.example', auth: 'none' });
    rejects('clientSecret だけの指定は受け付けない', { transport: 'http', url: 'https://x.example', auth: 'oauth', oauth: { clientSecret: 's' } });
    await ply.remove('local');
    t.ok('登録を消すと秘密も消える', (await plyStore.keys('mcp:local:')).length === 0);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}
