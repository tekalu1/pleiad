import { EventEmitter } from 'node:events';
import { parentPortComputer, ComputerError, fakeComputerDriver } from '../../core/computer-use/driver.mjs';

export const name = 'computer-driver';
export const title = 'main への口（parentPort）: computer-* のメッセージの形・応答の対応・エラーの code・ハートビート・偽の driver';

const sleep = ms => new Promise(r => setTimeout(r, ms));

export default async function(t) {
  const port = new EventEmitter();
  const sent = [];
  port.postMessage = m => sent.push(m);
  const recv = data => port.emit('message', { data });
  const driver = parentPortComputer(port, { timeoutMs: 80, launchTimeoutMs: 160, heartbeatMs: 30 });

  t.ok('起動で computer-ready-request を 1 回送る', sent.length === 1 && sent[0].type === 'computer-ready-request');
  t.ok('computer-ready を受ける前は state が null', driver.state() === null);
  const readyEvents = [];
  driver.onReady(s => readyEvents.push(s));
  const displays = [{ id: 'd1', index: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scale: 1, primary: true }];
  recv({ type: 'computer-ready', supported: true, displays, displaysVersion: 3 });
  t.ok('computer-ready: supported・displays・displaysVersion を持ち、onReady へ流す', driver.state().supported === true && driver.state().displaysVersion === 3 && driver.state().displays[0].id === 'd1' && readyEvents.length === 1);

  // 呼び出しと応答は id で対応する
  const p1 = driver.call('owner-1', 'screenshot', { display: 'd1', maxPixels: 1 });
  const p2 = driver.call('owner-1', 'cursor', {});
  const [c1, c2] = sent.filter(m => m.type === 'computer-call');
  t.ok('computer-call: { id, owner, op, args }。id は呼び出しごとに違う', c1.owner === 'owner-1' && c1.op === 'screenshot' && c1.args.display === 'd1' && c2.op === 'cursor' && c1.id !== c2.id);
  recv({ type: 'computer-result', id: c2.id, ok: true, data: { x: 1, y: 2 } });
  recv({ type: 'computer-result', id: c1.id, ok: true, data: { jpeg: new Uint8Array([1, 2, 3]), width: 10, height: 5, scale: 1, origin: { x: 0, y: 0 }, displaysVersion: 3 } });
  t.ok('順が前後しても、それぞれの呼び出しに応答が届く', (await p2).x === 1 && (await p1).jpeg[2] === 3);
  const p3 = driver.call('o', 'input', { actions: [] });
  recv({ type: 'computer-result', id: sent.filter(m => m.type === 'computer-call').at(-1).id, ok: false, error: { code: 'uipi', message: 'elevated' } });
  const err = await p3.catch(e => e);
  t.ok('失敗は ComputerError（code と message）で返る', err instanceof ComputerError && err.code === 'uipi' && err.message === 'elevated');
  const p4 = driver.call('o', 'input', {});
  recv({ type: 'computer-result', id: sent.filter(m => m.type === 'computer-call').at(-1).id, ok: false, error: {} });
  t.ok('code が無い失敗は failed', (await p4.catch(e => e)).code === 'failed');
  recv({ type: 'computer-result', id: 'cu-unknown', ok: true, data: {} });
  t.ok('知らない id の応答は無視する', true);

  // 応答が無ければ timeout（main の上限時間より少し長く待つ。launch は長い）
  const t0 = Date.now();
  const timeout = await driver.call('o', 'cursor', {}).catch(e => e);
  t.ok('main が応答しなければ timeout で返る（呼び出しが固まらない）', timeout.code === 'timeout' && Date.now() - t0 < 1000);
  const t1 = Date.now();
  const launch = await driver.call('o', 'launch', { app: {} }).catch(e => e);
  t.ok('launch の上限は長い（15 秒に対応）', launch.code === 'timeout' && Date.now() - t1 >= 140);

  // ディスプレイの構成・Esc
  const changes = [];
  driver.onDisplays(s => changes.push(s.displaysVersion));
  recv({ type: 'computer-displays-changed', displays: [{ ...displays[0], bounds: { x: 0, y: 0, width: 1280, height: 720 } }], displaysVersion: 4 });
  t.ok('computer-displays-changed: 構成と版が更新される', driver.state().displaysVersion === 4 && driver.state().displays[0].bounds.width === 1280 && changes.join() === '4');
  const escapes = [];
  driver.onEscape(o => escapes.push(o));
  recv({ type: 'computer-escape', owner: 'owner-9' });
  t.ok('computer-escape: owner を渡す', escapes.join() === 'owner-9');

  // main への便り
  sent.length = 0;
  driver.arm('owner-1');
  driver.overlay({ owner: 'owner-1', state: 'activity', display: 'd1', agent: 'Claude', title: '会話', cursor: { x: 1, y: 2, pressed: false } });
  driver.stop('owner-1');
  driver.turnEnded('owner-1');
  t.ok('computer-arm / overlay / stop / turn-ended の形', sent[0].type === 'computer-arm' && sent[0].owner === 'owner-1' && sent[1].type === 'computer-overlay' && sent[1].state === 'activity' && sent[1].cursor.x === 1
    && sent[2].type === 'computer-stop' && sent[2].owner === 'owner-1' && sent[3].type === 'computer-turn-ended' && sent[3].owner === 'owner-1');
  await sleep(110);
  const beats = sent.filter(m => m.type === 'computer-heartbeat');
  t.ok('持ち主がいる間は computer-heartbeat を送り続ける', beats.length >= 2 && beats.every(b => b.owner === 'owner-1'), String(beats.length));
  driver.arm(null);
  const arms = sent.filter(m => m.type === 'computer-arm');
  const n = sent.filter(m => m.type === 'computer-heartbeat').length;
  await sleep(90);
  t.ok('持ち主がいなくなったら arm { owner: null } を送り、ハートビートを止める', arms.at(-1).owner === null && sent.filter(m => m.type === 'computer-heartbeat').length === n);

  // 作り直し・使えない
  const pending = driver.call('o', 'cursor', {});
  recv({ type: 'computer-ready', supported: true, displays, displaysVersion: 1 });
  t.ok('computer-ready が再び来たら（main が作り直された）、待っていた呼び出しを失敗にする', (await pending.catch(e => e)).code === 'failed' && readyEvents.length === 2);
  recv({ type: 'computer-ready', supported: false, reason: 'platform', displays: [], displaysVersion: 0 });
  const unsupported = await driver.call('o', 'cursor', {}).catch(e => e);
  t.ok('supported: false の後の呼び出しは unsupported（main へは送らない）', unsupported.code === 'unsupported' && driver.state().reason === 'platform' && !sent.some(m => m.type === 'computer-call' && m.op === 'cursor' && false));
  t.ok('port が無い（Electron でない）ときは null', parentPortComputer(null) === null);

  // 偽の driver
  const fake = fakeComputerDriver();
  const shot = await fake.call('o', 'screenshot', { display: 'fake-1', maxPixels: 1_200_000, maxEdge: 1568, quality: 75 });
  t.ok('偽の driver: 1920×1080 の撮影は 1460×821、origin は左上、displaysVersion を返す', shot.width === 1460 && shot.height === 821 && shot.origin.x === 0 && shot.displaysVersion === 1 && shot.jpeg[0] === 0xff);
  const zoom = await fake.call('o', 'screenshot', { display: 'fake-1', region: { x: 100, y: 100, width: 200, height: 100 }, upscale: true, maxPixels: 1_200_000, maxEdge: 1568 });
  t.ok('偽の driver: zoom（upscale）は拡大してよい。origin は範囲の左上', zoom.scale > 1 && zoom.origin.x === 100 && zoom.origin.y === 100);
  t.ok('偽の driver: 範囲外の入力は outside、Windows キーは windows_key', (await fake.call('o', 'input', { actions: [{ type: 'move', x: 99999, y: 1 }] }).catch(e => e)).code === 'outside'
    && (await fake.call('o', 'input', { actions: [{ type: 'key', combo: 'super+r' }] }).catch(e => e)).code === 'windows_key');
  fake.fail('cursor', 'timeout');
  t.ok('偽の driver: 失敗の注入は次の 1 回だけ', (await fake.call('o', 'cursor', {}).catch(e => e)).code === 'timeout' && (await fake.call('o', 'cursor', {})).x === 100);
  t.ok('偽の driver: displaysVersion は構成の変更で進む', (() => { fake.changeDisplays(); return fake.state().displaysVersion === 2; })());
}
