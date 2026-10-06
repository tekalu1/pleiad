// main とサーバーを結ぶ名前付きパイプの口（core/link-codec.mjs・core/main-link.mjs・desktop/server-link.cjs）。
// 符号化の往復（バイナリー・$bin の衝突）・行の分け方（途中で切れた入力・1 行の上限）・握手（版・秘密。合わなければ何も返さず切る）・
// 往復と順序・大きなバイナリー・切断と再接続・本物のパイプで別プロセスのサーバー（core/server.mjs）につなぐ
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { encodeLine, decodeLine, createLineReader, DEFAULT_MAX_LINE_BYTES } from '../../core/link-codec.mjs';
import { createMainLink, mainLinkPipeName, readLinkFile, removeLinkFile, linkFilePath, handoverEnabled, IPC_RANGE, LINK_FILE } from '../../core/main-link.mjs';
import { createMainPort, getMainPort, setMainPortSource } from '../../core/main-port.mjs';
import { writeControlFile, controlFilePath } from '../../core/control-file.mjs';
import { parentPortCipher } from '../../core/secret-store.mjs';
import { startServer } from '../lib/server.mjs';

const require = createRequire(import.meta.url);
const { createServerLink, readLinkInfo } = require('../../desktop/server-link.cjs');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export const name = 'main-link';
export const title = 'main とサーバーの名前付きパイプの口: 符号化・行の分け方・握手・往復と順序・大きなバイナリー・切断と再接続・別プロセスのサーバー';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pleiad-main-link-'));

async function waitFor(check, ms = 5000, label = 'condition') {
  const end = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timeout: ${label}`);
    await sleep(10);
  }
}

const settled = promise => promise.then(value => ({ value }), error => ({ error }));

/** サーバー側の口の受信・つながりの出来事を溜める */
function watch(link) {
  const seen = { messages: [], events: [] };
  link.port.on('message', ({ data }) => seen.messages.push(data));
  link.port.on('connect', () => seen.events.push('connect'));
  link.port.on('disconnect', () => seen.events.push('disconnect'));
  return seen;
}

/** main 側の包みの受信・exit を溜める */
function watchClient(client) {
  const seen = { messages: [], exits: [] };
  client.on('message', message => seen.messages.push(message));
  client.on('exit', code => seen.exits.push({ code, reason: client.exitReason }));
  return seen;
}

/** パイプへ素のソケットでつなぎ、受け取ったバイト列と閉じたかを見る（握手の拒否を見るため） */
function rawConnect(pipe) {
  const socket = net.connect(pipe);
  const state = { received: Buffer.alloc(0), closed: false };
  socket.on('data', chunk => { state.received = Buffer.concat([state.received, chunk]); });
  socket.on('error', () => {});
  socket.on('close', () => { state.closed = true; });
  return { socket, state, write: frame => socket.write(`${encodeLine(frame)}\n`) };
}

async function startLink(options = {}) {
  const dataDir = tempDir();
  const link = createMainLink({ dataDir, appVersion: '9.9.9', ...options });
  await link.listen();
  return { link, dataDir, seen: watch(link), async stop() { await link.close(); fs.rmSync(dataDir, { recursive: true, force: true }); } };
}

function clientFor(link, options = {}) {
  return createServerLink({ pipe: link.pipe, secret: link.secret, appVersion: '1.2.3', ...options });
}

export default async function (t) {
  // ---- 符号化: バイナリーは { $bin } に包んで往復する
  {
    const jpeg = crypto.randomBytes(5000);
    const value = { type: 'computer-result', id: 'a', ok: true, data: { jpeg, thumb: new Uint8Array([1, 2, 3]), width: 96, list: [Buffer.from('xy'), null, 'z'], deep: { bytes: new Uint8Array(0).buffer } } };
    const line = encodeLine(value);
    const back = decodeLine(line);
    t.ok('符号化: 1 行（改行を含まない）', !line.includes('\n') && !line.includes('\r'));
    t.ok('符号化: Buffer は Uint8Array で戻り、中身が同じ', back.data.jpeg instanceof Uint8Array && Buffer.compare(Buffer.from(back.data.jpeg), jpeg) === 0);
    t.ok('符号化: 小さい Uint8Array・配列の中・空の ArrayBuffer も戻る', Array.from(back.data.thumb).join() === '1,2,3' && back.data.list[0] instanceof Uint8Array && Buffer.from(back.data.list[0]).toString() === 'xy' && back.data.list[1] === null && back.data.list[2] === 'z' && back.data.deep.bytes instanceof Uint8Array && back.data.deep.bytes.length === 0);
    t.ok('符号化: バイナリー以外はそのまま（型・数・真偽・入れ子）', back.type === 'computer-result' && back.ok === true && back.data.width === 96);
    t.ok('符号化: base64 は約 4/3 倍', line.length > jpeg.length * 4 / 3 && line.length < jpeg.length * 4 / 3 + 400);
    const tricky = { $bin: 'AAAA', a: { $esc: { $bin: 'x' } }, list: [{ $bin: 'QQ==' }] };
    const trickyBack = decodeLine(encodeLine(tricky));
    t.ok('符号化: メッセージ自身の $bin・$esc のキーはバイナリーと取り違えない', JSON.stringify(trickyBack) === JSON.stringify(tricky));
    t.ok('符号化: undefined の項目は落ち、Date は文字列', decodeLine(encodeLine({ a: undefined, b: 1, d: new Date(0) })).d === '1970-01-01T00:00:00.000Z' && !('a' in decodeLine(encodeLine({ a: undefined }))));
    t.ok('符号化: 日本語・絵文字・改行を含む文字列が壊れない', decodeLine(encodeLine({ text: 'ログ\n終わり🙂\r\n' })).text === 'ログ\n終わり🙂\r\n');
  }

  // ---- 行の分け方: 途中で切れた入力・多バイトの途中・1 行の上限
  {
    const lines = [];
    const drops = [];
    const reader = createLineReader({ maxBytes: 64, onLine: line => lines.push(line), onDrop: drop => drops.push(drop) });
    const whole = Buffer.from('{"a":"あ"}\n{"b":2}\n\n{"c":3}\n');
    for (let i = 0; i < whole.length; i++) reader.push(whole.subarray(i, i + 1));   // 1 バイトずつ（多バイトの途中で切れる）
    t.ok('行: 1 バイトずつ届いても行に戻る（多バイトの途中・空行は読み捨て）', lines.join('|') === '{"a":"あ"}|{"b":2}|{"c":3}' && reader.pending === 0);
    reader.push(Buffer.from('{"half":'));
    t.ok('行: 改行の来ない行は渡さず溜める', lines.length === 3 && reader.pending === 8);
    reader.reset();
    reader.push(Buffer.from('{"next":1}\n'));
    t.ok('行: reset で途中の行を捨て、次の行から読める', lines.at(-1) === '{"next":1}' && reader.pending === 0);
    reader.push(Buffer.from(`${'x'.repeat(200)}\n{"after":1}\n`));
    t.ok('行: 上限を超えた行は捨て（1 回知らせる）、次の行は読める', drops.length === 1 && drops[0].reason === 'oversize' && lines.at(-1) === '{"after":1}');
    reader.push(Buffer.from('y'.repeat(50)));
    reader.push(Buffer.from('y'.repeat(50)));
    reader.push(Buffer.from('y'.repeat(50)));
    reader.push(Buffer.from('\n{"after2":1}\n'));
    t.ok('行: 上限を超えながら分かれて届いても、1 回だけ知らせて次の行から読める', drops.length === 2 && lines.at(-1) === '{"after2":1}');
    t.ok('行: 既定の上限は 16 MB', DEFAULT_MAX_LINE_BYTES === 16 * 1024 * 1024);
  }

  // ---- 名前・設定・ファイル
  {
    const a = tempDir(), b = tempDir();
    const pipeA = mainLinkPipeName(a), pipeB = mainLinkPipeName(b);
    t.ok('パイプの名前: 同じ置き場なら同じ・違う置き場なら違う', pipeA === mainLinkPipeName(a) && pipeA !== pipeB);
    t.ok('パイプの名前: Windows は \\\\.\\pipe\\pleiad-main-<ハッシュ>', /^\\\\\.\\pipe\\pleiad-main-[0-9a-f]{16}$/.test(mainLinkPipeName(a, { platform: 'win32' })));
    t.ok('パイプの名前: Windows は置き場の大小文字を区別しない', mainLinkPipeName('C:\\Data\\Pleiad', { platform: 'win32', user: 'u' }) === mainLinkPipeName('c:\\data\\pleiad', { platform: 'win32', user: 'u' }));
    t.ok('パイプの名前: 利用者が違えば違う', mainLinkPipeName(a, { user: 'one' }) !== mainLinkPipeName(a, { user: 'two' }));
    t.ok('handoverEnabled: on のときだけ（既定・off・空は使わない）', handoverEnabled({ AGENT_HOST_HANDOVER: 'on' }) && handoverEnabled({ AGENT_HOST_HANDOVER: 'ON' }) && !handoverEnabled({}) && !handoverEnabled({ AGENT_HOST_HANDOVER: 'off' }) && !handoverEnabled({ AGENT_HOST_HANDOVER: '' }));
    t.ok('IPC_RANGE は [1, 1]', IPC_RANGE.join() === '1,1');
    await writeControlFile({ dataDir: a, origin: 'http://127.0.0.1:1', cliToken: 'c', startedAt: 'now', appVersion: '1', kind: 'desktop' });
    t.ok('control.json: パイプを使わなければ mainLink を足さない（今の形のまま）', !('mainLink' in JSON.parse(fs.readFileSync(controlFilePath(a), 'utf8'))));
    await writeControlFile({ dataDir: b, origin: 'http://127.0.0.1:1', cliToken: 'c', startedAt: 'now', appVersion: '1', kind: 'desktop', mainLink: { pipe: pipeB, ipc: [1, 1] } });
    const control = JSON.parse(fs.readFileSync(controlFilePath(b), 'utf8'));
    t.ok('control.json: mainLink に名前と ipc の範囲を足す（version は 1 のまま）', control.mainLink.pipe === pipeB && control.mainLink.ipc.join() === '1,1' && control.version === 1);
    fs.rmSync(a, { recursive: true, force: true }); fs.rmSync(b, { recursive: true, force: true });
  }

  // ---- 口の基本: main-link.json・握手・往復・順序
  {
    const env = await startLink();
    const { link, dataDir, seen } = env;
    const info = readLinkFile(dataDir);
    t.ok('listen: main-link.json に名前・秘密・pid・版・ipc を書く', info?.pipe === link.pipe && info.secret === link.secret && info.pid === process.pid && info.appVersion === '9.9.9' && info.ipc.join() === '1,1' && info.version === 1);
    t.ok('listen: main 側の readLinkInfo で読める', readLinkInfo(dataDir)?.secret === link.secret && readLinkInfo(path.join(dataDir, 'none')) === null);
    if (process.platform !== 'win32') t.ok('main-link.json は 0600', (fs.statSync(linkFilePath(dataDir)).mode & 0o777) === 0o600);
    t.ok('つながる前: connected でなく、送ると false で溜めない', link.port.connected === false && link.port.postMessage({ type: 'locale' }) === false && link.isConnected() === false);

    const client = clientFor(link);
    const clientSeen = watchClient(client);
    t.ok('main 側: 最初につなぐ前の postMessage は溜めて true（utilityProcess.fork の直後と同じ使い方）', client.postMessage({ type: 'queued', n: 1 }) === true && client.postMessage({ type: 'queued', n: 2 }) === true && client.connected === false);
    const welcome = await client.connect();
    t.ok('握手: welcome に ipc・範囲・サーバーの版・pid が載る', welcome.ipc === 1 && welcome.range.join() === '1,1' && welcome.appVersion === '9.9.9' && welcome.pid === process.pid && client.pid === process.pid);
    await waitFor(() => seen.events.includes('connect'), 2000, 'server connect event');
    t.ok('握手: サーバー側が connect を受け、connected・peer（版・ipc）が分かる', link.port.connected === true && link.port.peer.appVersion === '1.2.3' && link.port.peer.ipc.join() === '1,1');

    t.ok('main → サーバー: つなぐ前に溜めた物が、つながった直後に順に届く', (await waitFor(() => seen.messages.length === 2, 2000, 'queued')) && seen.messages.map(m => m.n).join() === '1,2');
    t.ok('main → サーバー: { data } で届き、true を返す', client.postMessage({ type: 'running', n: 1 }) === true && (await waitFor(() => seen.messages.length === 3, 2000, 'm1')) && JSON.stringify(seen.messages[2]) === '{"type":"running","n":1}');
    t.ok('サーバー → main: メッセージそのものが届き、true を返す', link.port.postMessage({ type: 'ready', port: 7 }) === true && (await waitFor(() => clientSeen.messages.length === 1, 2000, 'c1')) && JSON.stringify(clientSeen.messages[0]) === '{"type":"ready","port":7}');

    // 順序: 小さいものと大きいものを交ぜて両方向に流し、番号の並びが保たれる
    const N = 300;
    for (let i = 0; i < N; i++) {
      client.postMessage({ type: 'seq', i, pad: i % 25 === 0 ? crypto.randomBytes(200_000) : undefined });
      link.port.postMessage({ type: 'seq', i, pad: i % 40 === 0 ? crypto.randomBytes(300_000) : undefined });
    }
    await waitFor(() => seen.messages.filter(m => m.type === 'seq').length === N && clientSeen.messages.filter(m => m.type === 'seq').length === N, 15000, 'order');
    const inOrder = list => list.filter(m => m.type === 'seq').every((m, index) => m.i === index);
    t.ok(`順序: 大小を交ぜた ${N} 件ずつが両方向で並びを保つ`, inOrder(seen.messages) && inOrder(clientSeen.messages));
    t.ok('順序: 大きい物の中身が壊れない', seen.messages.filter(m => m.pad).every(m => m.pad.length === 200_000) && clientSeen.messages.filter(m => m.pad).every(m => m.pad.length === 300_000));

    // バイナリー: 4 MB・8 MB が往復する。1 MB の往復の時間を測る（computer use の写真が許容の時間に収まるか）
    const received = [];
    link.port.on('message', ({ data }) => { if (data?.type === 'echo-bin') { received.push(data); link.port.postMessage({ type: 'echo-bin-back', id: data.id, jpeg: data.jpeg }); } });
    const backs = new Map();
    client.on('message', message => { if (message?.type === 'echo-bin-back') backs.set(message.id, message); });
    for (const [id, size] of [['4m', 4 * 1024 * 1024], ['8m', 8 * 1024 * 1024]]) {
      const bytes = crypto.randomBytes(size);
      client.postMessage({ type: 'echo-bin', id, jpeg: bytes });
      const back = await waitFor(() => backs.get(id), 15000, `echo ${id}`);
      t.ok(`大きなバイナリー: ${id} が往復して同じ中身`, back.jpeg instanceof Uint8Array && Buffer.compare(Buffer.from(back.jpeg), bytes) === 0);
    }
    const photo = crypto.randomBytes(1024 * 1024);
    const times = [];
    for (let i = 0; i < 10; i++) {
      const id = `p${i}`;
      const began = process.hrtime.bigint();
      client.postMessage({ type: 'echo-bin', id, jpeg: photo });
      await waitFor(() => backs.get(id), 15000, `echo ${id}`);
      times.push(Number(process.hrtime.bigint() - began) / 1e6);
    }
    const average = times.reduce((sum, n) => sum + n, 0) / times.length;
    t.note(`1 MB の写真の往復（符号化・パイプ・復号 ×2）: 平均 ${average.toFixed(1)} ms、最大 ${Math.max(...times).toFixed(1)} ms`);
    t.ok('大きなバイナリー: 1 MB の往復は平均 500 ms 未満（computer use の 1 往復が数十 ms で足りる）', average < 500, `${average.toFixed(1)} ms`);

    // 1 行の上限: 超える送信は捨てて false、つながりは保つ
    const tooBig = crypto.randomBytes(13 * 1024 * 1024);
    t.ok('1 行の上限: 超える物は送らず false（つながりは保つ）', client.postMessage({ type: 'huge', jpeg: tooBig }) === false && client.connected === true && link.port.postMessage({ type: 'huge', jpeg: tooBig }) === false && link.port.connected === true);
    client.postMessage({ type: 'after-huge' });
    t.ok('1 行の上限: 捨てた後も続きが届く', await waitFor(() => seen.messages.some(m => m.type === 'after-huge'), 2000, 'after-huge').then(() => true, () => false));
    t.ok('送れない値（循環）は false で落ちない', (() => { const loop = {}; loop.self = loop; return client.postMessage(loop) === false && link.port.postMessage(loop) === false; })());
    t.ok('mainPort 越しでも、送れなかった postMessage は false', (() => { const mainPort = createMainPort({ parentPort: link.port }); return mainPort.postMessage({ type: 'huge', jpeg: tooBig }) === false && mainPort.postMessage({ type: 'ok' }) === true; })());

    // 切断: main がやめる → 両側が知り、送信は false
    seen.events.length = 0;
    client.leave();
    await waitFor(() => clientSeen.exits.length === 1 && seen.events.includes('disconnect'), 3000, 'leave');
    t.ok('切断（main がやめる）: main 側は exit(0)、サーバー側は disconnect', clientSeen.exits[0].code === 0 && client.connected === false && link.port.connected === false);
    t.ok('切断の後: 両側とも送ると false', client.postMessage({ type: 'x' }) === false && link.port.postMessage({ type: 'x' }) === false);

    // 再接続: 同じ包み・同じ口。'message' の登録は残る
    const before = { server: seen.messages.length, client: clientSeen.messages.length };
    const again = await client.connect();
    t.ok('再接続: 同じ包みでつなぎ直せる', again.ipc === 1 && client.connected === true && (await waitFor(() => link.port.connected, 2000, 'reconnect')));
    client.postMessage({ type: 'again' });
    link.port.postMessage({ type: 'again-back' });
    await waitFor(() => seen.messages.length > before.server && clientSeen.messages.length > before.client, 3000, 'again');
    t.ok('再接続: 前の登録のまま両方向に届く（connect が 2 回目）', seen.messages.at(-1).type === 'again' && clientSeen.messages.at(-1).type === 'again-back' && seen.events.filter(e => e === 'connect').length === 1);

    // サーバーに切られる: bye(closing) → main は exit
    clientSeen.exits.length = 0;
    await env.link.close();
    await waitFor(() => clientSeen.exits.length === 1, 3000, 'server close');
    t.ok('サーバーが閉じる: main 側に exit（reason は bye の closing）', clientSeen.exits[0].code === 0 && clientSeen.exits[0].reason === 'closing');
    t.ok('サーバーが閉じる: main-link.json を消す', readLinkFile(env.dataDir) === null);
    t.ok('閉じたパイプへは入れない（ENOENT / ECONNREFUSED）', ['ENOENT', 'ECONNREFUSED'].includes((await settled(client.connect())).error?.code));
    fs.rmSync(env.dataDir, { recursive: true, force: true });
  }

  // ---- 握手の拒否: 秘密が合わなければ何も返さず切る。版が合わなければ範囲を返して切る
  {
    const env = await startLink({ helloTimeoutMs: 300 });
    const { link, seen } = env;
    const bad = clientFor(link, { secret: 'wrong' });
    const result = await settled(bad.connect());
    t.ok('秘密の不一致: 握手が LINK_CLOSED で終わり、つながらない', result.error?.code === 'LINK_CLOSED' && bad.connected === false);
    const raw = rawConnect(link.pipe);
    raw.write({ t: 'hello', ipc: [1, 1], appVersion: 'x', secret: 'wrong' });
    await waitFor(() => raw.state.closed, 3000, 'raw wrong secret');
    t.ok('秘密の不一致: 何も返さず（0 バイト）切る', raw.state.received.length === 0);
    const wrongBoth = rawConnect(link.pipe);
    wrongBoth.write({ t: 'hello', ipc: [7, 8], appVersion: 'x', secret: 'wrong' });
    await waitFor(() => wrongBoth.state.closed, 3000, 'raw wrong both');
    t.ok('秘密も版も違う: 版の範囲も返さない（秘密が合う相手にしか見せない）', wrongBoth.state.received.length === 0);
    t.ok('秘密の不一致: サーバーは connect を出さない', link.port.connected === false && seen.events.length === 0);

    const old = clientFor(link, { ipc: [2, 3] });
    const rejected = await settled(old.connect());
    t.ok('ipc の範囲の外: LINK_REJECTED で、サーバーの範囲・版が分かる', rejected.error?.code === 'LINK_REJECTED' && rejected.error.reason === 'ipc' && rejected.error.server.range.join() === '1,1' && rejected.error.server.appVersion === '9.9.9' && old.connected === false);
    const below = await settled(clientFor(link, { ipc: [0, 0] }).connect());
    t.ok('ipc の範囲の外（下側）も拒否', below.error?.code === 'LINK_REJECTED');
    t.ok('ipc の範囲の外: サーバーは connect を出さない', seen.events.length === 0);
    const wide = clientFor(link, { ipc: [0, 5] });
    const accepted = await wide.connect();
    t.ok('ipc の範囲が重なれば、小さい方の上限で合う（1 版ぶん後ろまで話せる）', accepted.ipc === 1);
    wide.leave();
    await waitFor(() => !link.port.connected, 3000, 'wide leave');

    const junk = rawConnect(link.pipe);
    junk.socket.write('これは JSON ではない\n');
    await waitFor(() => junk.state.closed, 3000, 'junk');
    const notHello = rawConnect(link.pipe);
    notHello.write({ t: 'msg', d: { type: 'secret-leak-try' } });
    await waitFor(() => notHello.state.closed, 3000, 'not hello');
    const silent = rawConnect(link.pipe);
    await waitFor(() => silent.state.closed, 3000, 'hello timeout');
    t.ok('握手の前の不正（JSON でない・hello でない・何も送らない）は黙って切る', junk.state.received.length === 0 && notHello.state.received.length === 0 && silent.state.received.length === 0 && seen.messages.length === 0);
    const flood = rawConnect(link.pipe);
    flood.socket.write(Buffer.alloc(100 * 1024, 0x61));
    await waitFor(() => flood.state.closed, 3000, 'flood');
    t.ok('握手の前に大きな行を送る接続は切る', flood.state.received.length === 0);
    await env.stop();
  }

  // ---- 後から来た main が勝つ・途中で切れた行・大きすぎる行・受け手の例外・kill
  {
    const logs = [];
    const env = await startLink({ maxLineBytes: 4096, log: line => logs.push(line) });
    const { link, seen } = env;
    const first = clientFor(link);
    const firstSeen = watchClient(first);
    await first.connect();
    await waitFor(() => seen.events.length === 1, 2000, 'first connect');
    const second = clientFor(link, { appVersion: '4.5.6' });
    const secondSeen = watchClient(second);
    await second.connect();
    await waitFor(() => firstSeen.exits.length === 1 && seen.events.length === 3, 3000, 'replace');
    t.ok('後から来た main が勝つ: 古い方は bye(replaced) で切られ、サーバーは disconnect → connect の順', firstSeen.exits[0].reason === 'replaced' && seen.events.join() === 'connect,disconnect,connect' && link.port.peer.appVersion === '4.5.6');
    second.postMessage({ type: 'from-second' });
    t.ok('後から来た main の送信が届き、古い方は送れない', await waitFor(() => seen.messages.some(m => m.type === 'from-second'), 2000, 'second msg').then(() => true, () => false) && first.postMessage({ type: 'from-first' }) === false);

    // サーバー側の上限: 4096 バイトを超える行は捨てる。つながりと次の行は生きる
    const big = createServerLink({ pipe: link.pipe, secret: link.secret, maxLineBytes: 1024 * 1024 });
    await big.connect();
    await waitFor(() => link.port.peer?.appVersion === '' && secondSeen.exits.length === 1, 2000, 'big peer');
    big.postMessage({ type: 'oversize', blob: 'x'.repeat(8000) });
    big.postMessage({ type: 'small-after' });
    await waitFor(() => seen.messages.some(m => m.type === 'small-after'), 3000, 'small-after');
    t.ok('受け側の上限: 大きすぎる行は捨て、つながりと次の行は生きる', !seen.messages.some(m => m.type === 'oversize') && link.port.connected === true && logs.some(line => line.includes('oversize')));

    // 行の途中で切れた入力は渡さない
    const raw = rawConnect(link.pipe);
    raw.write({ t: 'hello', ipc: [1, 1], appVersion: 'raw', secret: link.secret });
    await waitFor(() => raw.state.received.length > 0, 2000, 'raw welcome');
    const countBefore = seen.messages.length;
    raw.socket.write('{"t":"msg","d":{"type":"half-line","pad":"');
    await sleep(50);
    raw.socket.destroy();
    await waitFor(() => !link.port.connected, 3000, 'raw destroy');
    t.ok('行の途中で切れた入力は渡さず、切断として扱う', seen.messages.length === countBefore && seen.events.at(-1) === 'disconnect');

    // 受け手が例外を投げてもサーバーは落ちず、次の行を受ける
    link.port.on('message', ({ data }) => { if (data?.type === 'boom') throw new Error('受け手の例外'); });
    const third = clientFor(link);
    await third.connect();
    third.postMessage({ type: 'boom' });
    third.postMessage({ type: 'after-boom' });
    await waitFor(() => seen.messages.some(m => m.type === 'after-boom'), 3000, 'after-boom');
    t.ok('message の受け手が例外を投げても口は続く', link.port.connected === true && logs.some(line => line.includes('受け手の例外')));

    // kill = 終わらせる握手: shutdown を送って閉じる
    const watchThird = watchClient(third);
    const shutdownsBefore = seen.messages.filter(m => m.type === 'shutdown').length;
    seen.events.length = 0;
    third.kill();
    await waitFor(() => watchThird.exits.length === 1 && seen.events.includes('disconnect'), 3000, 'kill');
    t.ok('kill: shutdown のメッセージを送ってから閉じる', seen.messages.filter(m => m.type === 'shutdown').length === shutdownsBefore + 1 && watchThird.exits[0].code === 0);
    t.ok('kill の後は送れない', third.postMessage({ type: 'x' }) === false);
    await env.stop();
  }

  // ---- つなぐ前に溜める量の上限と clearQueue
  {
    const lonely = createServerLink({ pipe: 'unused', secret: 'unused' });
    let accepted = 0;
    for (let i = 0; i < 1005; i++) if (lonely.postMessage({ type: 'q', i })) accepted++;
    t.ok('つなぐ前に溜められるのは 1000 件まで（超えた分は false）', accepted === 1000 && lonely.queue.length === 1000);
    lonely.clearQueue();
    t.ok('clearQueue で捨てられる', lonely.queue.length === 0);
  }

  // ---- mainPort につなぐ: hosted・connected・connect/disconnect が口の層から見える
  {
    const env = await startLink();
    const { link } = env;
    const port = createMainPort({ parentPort: link.port });
    const events = [];
    port.on('connect', () => events.push('connect'));
    port.on('disconnect', () => events.push('disconnect'));
    const got = [];
    port.on('message', ({ data }) => got.push(data));
    t.ok('mainPort(パイプ): hosted だが、つながるまで connected でなく、送ると false', port.hosted === true && port.connected === false && port.postMessage({ type: 'resident' }) === false);
    // secret の依頼は、main がつながるまで送らずに待つ（起動直後の status の依頼が捨てられて、平文扱いに固定されないように）
    const cipher = parentPortCipher(port, { timeoutMs: 3000 });
    const encrypting = cipher.encrypt('plain');
    await sleep(100);
    t.ok('secret: つながる前の依頼は、送れないので待つ（つながった口は無く、送らない）', got.length === 0 && link.port.connected === false);
    const client = clientFor(link);
    client.on('message', message => { if (message?.type === 'secret') client.postMessage({ type: 'secret', id: message.id, ok: true, value: `enc:${message.value}` }); });
    await client.connect();
    t.ok('secret: つながると依頼が届き、応答で解決する', await encrypting === 'enc:plain', String(await encrypting.catch(error => error.message)));
    got.length = 0;
    await waitFor(() => port.connected, 2000, 'mainPort connected');
    client.postMessage({ type: 'wake' });
    await waitFor(() => got.length === 1, 2000, 'mainPort message');
    t.ok('mainPort(パイプ): つながると connected・送れる・parentPort と同じ { data } で受ける', events.join() === 'connect' && port.postMessage({ type: 'resident' }) === true && got[0].type === 'wake');
    client.leave();
    await waitFor(() => !port.connected, 2000, 'mainPort leave');
    t.ok('mainPort(パイプ): 切れると disconnect・hosted は変わらず送ると false', events.join() === 'connect,disconnect' && port.hosted === true && port.postMessage({ type: 'resident' }) === false);
    setMainPortSource(link.port);
    const shared = getMainPort();
    t.ok('setMainPortSource: getMainPort がパイプの口を返す（process.parentPort より優先）', shared.hosted === true && getMainPort() === shared);
    setMainPortSource(null);
    t.ok('setMainPortSource(null) で元に戻る', getMainPort() !== shared);
    await env.stop();
  }

  // ---- main-link.json の持ち主・同じ置き場で 2 つ目は立てられない
  {
    const env = await startLink();
    const other = createMainLink({ dataDir: env.dataDir });
    t.ok('同じ置き場で 2 つ目のパイプは立てられない', (await settled(other.listen())).error?.code === 'EADDRINUSE');
    removeLinkFile({ dataDir: env.dataDir, pid: process.pid + 1 });
    t.ok('removeLinkFile: 他のプロセスのファイルは消さない', readLinkFile(env.dataDir) !== null);
    if (process.platform !== 'win32') {
      // unix ソケットはファイル: 持ち主が居れば立てられず、居ない（落ちて残った）ファイルは消して立て直す。生きている持ち主のソケットは横取りしない
      const client = clientFor(env.link);
      t.ok('unix ソケット: 2 つ目が失敗した後も、先のソケットにつながる', await settled(client.connect()).then(r => !r.error));
      client.leave();
      const staleDir = tempDir();
      const stale = createMainLink({ dataDir: staleDir });
      fs.writeFileSync(stale.pipe, '');
      t.ok('unix ソケット: 持ち主の居ない古いファイルは消して立てる', (await settled(stale.listen())).error === undefined);
      await stale.close();
      fs.rmSync(staleDir, { recursive: true, force: true });
    }
    env.link.dispose();
    t.ok('dispose: 自分のファイルは同期で消す', !fs.existsSync(path.join(env.dataDir, LINK_FILE)));
    await env.stop();
  }

  // ---- 別プロセスのサーバー（本物のパイプ）: core/server.mjs を AGENT_HOST_HANDOVER=on で起こす
  {
    const dataDir = tempDir();
    const server = await startServer({ env: { AGENT_HOST_BACKENDS: 'fake', AGENT_HOST_HANDOVER: 'on' }, dataDir, timeoutMs: 60_000 });
    try {
      const info = await waitFor(() => readLinkInfo(dataDir), 5000, 'main-link.json');
      const control = JSON.parse(fs.readFileSync(controlFilePath(dataDir), 'utf8'));
      t.ok('サーバー（on）: control.json に mainLink（名前・ipc）と kind: desktop、main-link.json に秘密', control.mainLink.pipe === info.pipe && control.mainLink.ipc.join() === '1,1' && control.kind === 'desktop' && control.version === 1 && info.secret.length === 64 && info.pid === control.pid);
      const client = createServerLink({ pipe: info.pipe, secret: info.secret, appVersion: '0.0.1' });
      const seen = watchClient(client);
      const welcome = await client.connect();
      t.ok('サーバー（on）: 握手が通り、サーバーの pid・版が分かる', welcome.pid === info.pid && typeof welcome.appVersion === 'string' && welcome.appVersion.length > 0);
      const ready = await waitFor(() => seen.messages.find(m => m.type === 'ready'), 5000, 'ready');
      t.ok('サーバー（on）: つながった直後に最新の ready（port・token）が届く', ready.port === server.port && ready.token === server.token);
      client.postMessage({ type: 'running' });
      const running = await waitFor(() => seen.messages.find(m => m.type === 'running'), 5000, 'running');
      t.ok('サーバー（on）: running の往復（work の件数 0）', running.work?.count === 0);
      client.postMessage({ type: 'update-lock', id: 'u1' });
      const lock = await waitFor(() => seen.messages.find(m => m.type === 'update-lock' && m.id === 'u1'), 5000, 'update-lock');
      client.postMessage({ type: 'update-unlock' });
      t.ok('サーバー（on）: update-lock が取れて ok', lock.ok === true);
      client.postMessage({ type: 'abort', id: 'a1', reason: 'quit' });
      const aborted = await waitFor(() => seen.messages.find(m => m.type === 'abort' && m.id === 'a1'), 5000, 'abort');
      t.ok('サーバー（on）: abort の往復', aborted.id === 'a1');

      // main がやめて、もう一度つなぎ直す（サーバーは動いたまま。つなぎ直しにも ready が届く）
      client.leave();
      await waitFor(() => seen.exits.length === 1, 3000, 'leave');
      seen.messages.length = 0;
      await client.connect();
      const ready2 = await waitFor(() => seen.messages.find(m => m.type === 'ready'), 5000, 'ready 2');
      t.ok('サーバー（on）: main が付け直すと、同じサーバーが最新の ready をもう一度送る', ready2.port === server.port && client.pid === info.pid);

      // 古い秘密（別のサーバー）は通らない
      const wrong = await settled(createServerLink({ pipe: info.pipe, secret: 'stale-secret' }).connect());
      t.ok('サーバー（on）: 古い・違う秘密は通らない', wrong.error?.code === 'LINK_CLOSED');

      // 終わらせる: shutdown の握手でサーバーが終わり、main には exit、control.json・main-link.json は消える
      seen.exits.length = 0;
      client.kill();
      await waitFor(() => seen.exits.length === 1, 10_000, 'server exit');
      await waitFor(() => { try { process.kill(info.pid, 0); return false; } catch { return true; } }, 10_000, 'server process gone');
      t.ok('サーバー（on）: kill（shutdown）でサーバーが終わり、control.json・main-link.json を消す', !fs.existsSync(controlFilePath(dataDir)) && !fs.existsSync(linkFilePath(dataDir)));
    } finally {
      await server.stop();
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  }

  // ---- 既定（off）の起動は変わらない: パイプも main-link.json も作らず、control.json に mainLink を足さない
  {
    const dataDir = tempDir();
    const server = await startServer({ env: { AGENT_HOST_BACKENDS: 'fake' }, dataDir, timeoutMs: 60_000 });
    try {
      const control = await waitFor(() => { try { return JSON.parse(fs.readFileSync(controlFilePath(dataDir), 'utf8')); } catch { return null; } }, 5000, 'control.json');
      t.ok('既定（off）: main-link.json を作らず、control.json は今の形（kind: server・mainLink なし）', !fs.existsSync(linkFilePath(dataDir)) && control.kind === 'server' && !('mainLink' in control));
    } finally {
      await server.stop();
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  }
}
