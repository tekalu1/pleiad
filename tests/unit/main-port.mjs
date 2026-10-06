// main への口（core/main-port.mjs）。parentPort をそのまま包む形（今の utilityProcess の経路）と、
// main が居ない起動・つながっていない口に送っても落ちないこと。パイプの口（段階 1 の 1-2）が差し込める形もここで押さえる
import { EventEmitter } from 'node:events';
import { createMainPort, getMainPort } from '../../core/main-port.mjs';
import { parentPortCipher, defaultCipher, plainCipher } from '../../core/secret-store.mjs';
import { defaultOpener } from '../../core/os-open.mjs';

export const name = 'main-port';
export const title = 'main への口: parentPort の素通し・main が居ない起動・つながっていない口・差し込める形';

/** utilityProcess の parentPort と同じ形の身代わり（受けた物を sent に溜め、emitMessage で { data } を流す） */
function fakeParentPort() {
  const port = new EventEmitter();
  port.sent = [];
  port.postMessage = message => { port.sent.push(message); };
  port.emitMessage = data => port.emit('message', { data });
  return port;
}

export default async function (t) {
  // ---- parentPort を入れた口: 挙動は parentPort のまま
  const parent = fakeParentPort();
  const port = createMainPort({ parentPort: parent });
  t.ok('main の下の起動: hosted・connected', port.hosted === true && port.connected === true);
  t.ok('postMessage は parentPort へそのまま渡り、送れたことを返す', port.postMessage({ type: 'locale', locale: 'ja' }) === true && JSON.stringify(parent.sent) === '[{"type":"locale","locale":"ja"}]');
  const got = [];
  const onMessage = event => got.push(event.data);
  port.on('message', onMessage);
  parent.emitMessage({ type: 'wake' });
  t.ok('on(message) は parentPort と同じ { data } を受ける', JSON.stringify(got) === '[{"type":"wake"}]');
  port.off('message', onMessage);
  parent.emitMessage({ type: 'wake' });
  t.ok('off で外れる', got.length === 1 && parent.listenerCount('message') === 0);
  port.on('other', () => {});
  t.ok('知らない種類の登録は parentPort へ渡さない', parent.eventNames().length === 0);

  // ---- main が居ない起動（npm start）
  const none = createMainPort({});
  t.ok('main が居ない起動: hosted でも connected でもない', none.hosted === false && none.connected === false);
  t.ok('送っても落ちず、送れなかったと返す', none.postMessage({ type: 'ready' }) === false);
  none.on('message', () => { throw new Error('呼ばれない'); });
  none.off('message', () => {});
  t.ok('on / off も落ちない', true);

  // ---- つながっていない口（パイプの口が切れている間）。hosted は変わらず、送らず false
  const link = fakeParentPort();
  link.connected = false;
  const down = createMainPort({ parentPort: link });
  t.ok('切れている口: hosted のまま connected でない', down.hosted === true && down.connected === false);
  t.ok('切れている間の送信は何もせず false（溜めない）', down.postMessage({ type: 'resident' }) === false && link.sent.length === 0);
  const refusing = fakeParentPort();
  refusing.postMessage = () => false;
  t.ok('実体の postMessage が false（パイプの口が捨てた）なら false を返す', createMainPort({ parentPort: refusing }).postMessage({ type: 'x' }) === false);
  const events = [];
  down.on('connect', () => events.push('connect'));
  down.on('disconnect', () => events.push('disconnect'));
  link.connected = true;
  link.emit('connect');
  link.emit('disconnect');
  t.ok('connect / disconnect は実体の口から届く', events.join() === 'connect,disconnect');
  t.ok('つなぎ直した後は送れる', down.connected === true && down.postMessage({ type: 'resident' }) === true && link.sent.length === 1);
  const offlineOff = fakeParentPort();
  offlineOff.off = undefined;
  offlineOff.removeListener = EventEmitter.prototype.removeListener;
  const viaRemove = createMainPort({ parentPort: offlineOff });
  const fn = () => {};
  viaRemove.on('message', fn);
  viaRemove.off('message', fn);
  t.ok('off が無い口は removeListener で外す', offlineOff.listenerCount('message') === 0);

  // ---- process.parentPort からの共有の口
  const saved = process.parentPort;
  try {
    process.parentPort = undefined;
    const a = getMainPort();
    t.ok('process.parentPort が無ければ hosted でない口。同じ間は同じ口', a.hosted === false && getMainPort() === a);
    const shared = fakeParentPort();
    process.parentPort = shared;
    const b = getMainPort();
    t.ok('process.parentPort が入ると、その口を包んだ新しい口になる', b !== a && b.hosted === true && getMainPort() === b);
    b.postMessage({ type: 'ready' });
    t.ok('共有の口から送ると process.parentPort へ届く', shared.sent.length === 1 && shared.sent[0].type === 'ready');

    // ---- defaultCipher・defaultOpener は起動の形に合う実装を選ぶ
    t.ok('defaultCipher: main の下なら main に頼む暗号器（平文でない）', defaultCipher() !== plainCipher);
    const cipher = parentPortCipher(b);
    cipher.encrypt('x').catch(() => {});
    t.ok('parentPortCipher は口にも使える（secret を口へ送る）', shared.sent.at(-1).type === 'secret');
    process.parentPort = undefined;
    t.ok('defaultCipher: main が居なければ平文', defaultCipher() === plainCipher);
    const dry = defaultOpener({ env: { AGENT_HOST_OS_OPEN: 'dry' } });
    t.ok('defaultOpener: dry は口を使わず成功する', (await dry('open', 'x')) === undefined);
    const viaPort = fakeParentPort();
    const opener = defaultOpener({ env: {}, mainPort: createMainPort({ parentPort: viaPort }) });
    opener('open', 'file.txt', { directory: true }).catch(() => {});
    t.ok('defaultOpener: main が居れば os-open を口へ送る', viaPort.sent.length === 1 && viaPort.sent[0].type === 'os-open' && viaPort.sent[0].directory === true);
  } finally {
    process.parentPort = saved;
  }
}
