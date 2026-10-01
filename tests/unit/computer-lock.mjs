import { createComputerLock, LockError } from '../../core/computer-use/lock.mjs';

export const name = 'computer-lock';
export const title = 'コンピューターの操作のロック: 1 つだけ・FIFO・10 分で busy・待ちを分ける・中断で抜ける・子へ貸す・止めた印';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const gate = () => { let open; const promise = new Promise(r => { open = r; }); return { promise, open }; };
const code = p => p.then(() => 'ok', e => (e instanceof LockError ? e.code : `error:${e?.message}`));

export default async function(t) {
  const make = (opts = {}) => {
    const log = { states: [], arms: [], stops: [] };
    const lock = createComputerLock({ waitMs: 5000, onState: s => log.states.push(s), onArm: o => log.arms.push(o), onStop: o => log.stops.push(o), ...opts });
    const turns = new Map();
    const info = (turnId, sessionId = turnId, extra = {}) => {
      if (!turns.has(turnId)) turns.set(turnId, { turnId, sessionId, title: `会話 ${sessionId}`, ancestors: [], ac: new AbortController(), ...extra });
      const x = turns.get(turnId);
      return { turnId, sessionId, title: x.title, ancestors: x.ancestors, signal: x.ac.signal };
    };
    const abort = turnId => turns.get(turnId).ac.abort();
    const last = (sessionId) => [...log.states].reverse().find(s => s.sessionId === sessionId);
    return { lock, log, info, abort, last };
  };

  // ---- 1 つだけ・FIFO・ターンで持つ
  {
    const { lock, log, info, last } = make();
    const order = [];
    await lock.run(info('A'), async () => { order.push('a1'); });
    t.ok('最初の呼び出しで取り、ターンが終わるまで持つ（呼び出しが終わっても放さない）', lock.holder()?.turnId === 'A' && last('A').state === 'running' && log.arms.at(-1) === 'A');
    const b = lock.run(info('B'), async () => { order.push('b1'); });
    await sleep(30);
    const c = lock.run(info('C'), async () => { order.push('c1'); });
    await sleep(30);
    t.ok('2 つ目は待つ（computer.state waiting と、今の持ち主の会話・タイトルを持つ）', order.join() === 'a1' && last('B').state === 'waiting' && last('B').holder.sessionId === 'A' && last('B').holder.title === '会話 A' && last('C').state === 'waiting');
    t.ok('待っている会話の一覧（再接続で送り直す分）', lock.snapshot().map(s => `${s.sessionId}:${s.state}`).sort().join() === 'A:running,B:waiting,C:waiting');
    t.ok('endTurn は、ロックに関わったターンなら true（main へ turn-ended を送る目印）、知らないターンは false', lock.endTurn('A') === true && lock.endTurn('nobody') === false);
    await b;
    t.ok('持ち主のターンが終わると、列の先頭（B）が取る。C はまだ待つ（FIFO）', order.join() === 'a1,b1' && lock.holder().turnId === 'B' && last('A').state === 'idle' && last('C').state === 'waiting');
    lock.endTurn('B'); await c;
    t.ok('B が終わると C。持ち主が替わるたびに onArm へ（A → B → C）', order.join() === 'a1,b1,c1' && log.arms.join() === 'A,B,C');
    lock.endTurn('C');
    t.ok('全部終われば持ち主なし（arm は null）', lock.holder() === null && log.arms.at(-1) === null && lock.snapshot().length === 0);
  }

  // ---- 同じターンの並列の呼び出しは直列
  {
    const { lock, info } = make();
    const order = [], g = gate();
    const p1 = lock.run(info('A'), async () => { order.push('1 start'); await g.promise; order.push('1 end'); });
    const p2 = lock.run(info('A'), async () => { order.push('2 start'); order.push('2 end'); });
    await sleep(40);
    t.ok('同じターンの 2 つ目は 1 つ目が終わるまで始まらない', order.join() === '1 start');
    g.open(); await Promise.all([p1, p2]);
    t.ok('終われば順に動く', order.join() === '1 start,1 end,2 start,2 end');
    lock.endTurn('A');
  }

  // ---- 10 分（短縮）で busy。ターンの中で最初に待ち始めた時刻から数える
  {
    const { lock, info, last } = make({ waitMs: 120 });
    await lock.run(info('A'), async () => {});
    const t0 = Date.now();
    const r = await code(lock.run(info('B'), async () => {}));
    const took = Date.now() - t0;
    t.ok('上限を過ぎたら busy（列から外れる）', r === 'busy' && took >= 100 && took < 1000 && last('B').state === 'idle', `${r} ${took}ms`);
    const again = lock.run(info('B'), async () => 'ran');
    await sleep(40);
    lock.endTurn('A');
    t.ok('busy の後の次の呼び出しは、新しく並び直して空けば動く', (await again) === 'ran');
    lock.endTurn('B');
  }
  {
    const { lock, info } = make({ waitMs: 80 });
    await lock.run(info('A'), async () => {});
    const r1 = await code(lock.run(info('B'), async () => {}, { sliceMs: 20 }));
    await sleep(120);   // 呼び出しの無い間に上限を過ぎる
    const r2 = await code(lock.run(info('B'), async () => {}));
    t.ok('待ちを分けた後、呼び出しの無い間に上限を過ぎたら、次の呼び出しがすぐ busy（1 回だけ）', r1 === 'slice' && r2 === 'busy');
    lock.endTurn('A'); lock.endTurn('B');
  }

  // ---- 待ちを分ける（waitSliceMs）。列の位置は保つ
  {
    const { lock, info, last } = make();
    await lock.run(info('A'), async () => {});
    const t0 = Date.now();
    const r = await code(lock.run(info('B'), async () => {}, { sliceMs: 40 }));
    t.ok('切れたら slice（ターンの最初の待ち始めから数えるので、待ちの行は waiting のまま）', r === 'slice' && Date.now() - t0 < 1000 && last('B').state === 'waiting');
    const c = lock.run(info('C'), async () => 'c');
    await sleep(20);
    lock.endTurn('A');
    await sleep(20);
    t.ok('分けて返しても列の先頭を譲らない（後から来た C より B が先に持ち主になる）', lock.holder().turnId === 'B' && last('C').state === 'waiting');
    t.ok('B が次の呼び出しをすれば、待たずにすぐ動く', (await lock.run(info('B'), async () => 'b-again')) === 'b-again');
    lock.endTurn('B'); t.ok('B が終われば C', (await c) === 'c'); lock.endTurn('C');
  }

  // ---- 中断で列から抜ける・持ち主の中断で放す
  {
    const { lock, log, info, last, abort } = make();
    await lock.run(info('A'), async () => {});
    const ac = new AbortController();
    const b = code(lock.run(info('B'), async () => 'b', { signal: ac.signal }));
    const c = lock.run(info('C'), async () => 'c');
    await sleep(30);
    ac.abort();
    t.ok('待っている呼び出しの signal が abort したら aborted で返る', (await b) === 'aborted');
    abort('B');   // B のターン自体が中断された
    await sleep(10);
    t.ok('中断したターンは列から抜ける（待っている状態ではなくなる）', last('B').state === 'idle');
    abort('A');   // 持ち主のターンの中断
    t.ok('持ち主のターンの中断で、押したままの入力を離す口（onStop）が呼ばれ、ロックが放される', (await c) === 'c' && log.stops.join() === 'A' && lock.holder().turnId === 'C');
    lock.endTurn('C');
  }
  {
    const { lock, log, info, abort } = make();
    await lock.run(info('A'), async () => {});
    lock.endTurn('A');
    t.ok('持ち主でなかったターン（終わった後・待っていただけ）の中断では onStop を呼ばない', (abort('A'), log.stops.length === 0));
  }

  // ---- 委譲の子へ貸す（ADR 0072）
  {
    const { lock, log, info, last } = make();
    await lock.run(info('P', 'sp'), async () => {});
    const x = lock.run(info('X', 'sx'), async () => 'x');
    await sleep(20);
    const t0 = Date.now();
    const r = await lock.run(info('C', 'sc', { ancestors: ['sp'] }), async () => 'child');
    t.ok('持ち主のターンの子孫は、待たずに借りる（持ち主が呼び出しを実行していない）。無関係の X は待つ', r === 'child' && Date.now() - t0 < 500 && lock.holder().turnId === 'C' && last('sx').state === 'waiting');
    t.ok('貸している間、持ち主（P）は running のまま。借りた子も running', last('sp').state === 'running' && last('sc').state === 'running' && log.arms.at(-1) === 'C');
    const events = [];
    const p2 = lock.run(info('P', 'sp'), async () => { events.push('p call'); return 'p'; });
    await sleep(30);
    t.ok('貸している間、持ち主の呼び出しは子が返すまで待つ（waiting。持ち主＝子の会話）', events.length === 0 && last('sp').state === 'waiting' && last('sp').holder.sessionId === 'sc');
    lock.endTurn('C');
    t.ok('子のターンが終わると持ち主へ返す', (await p2) === 'p' && lock.holder().turnId === 'P' && last('sx').state === 'waiting');
    lock.endTurn('P');
    t.ok('持ち主が終われば無関係の X へ', (await x) === 'x' && lock.holder().turnId === 'X');
    lock.endTurn('X');
  }
  {
    // 持ち主が呼び出しの実行中なら、その呼び出しが終わってから貸す
    const { lock, info } = make();
    const g = gate(), order = [];
    const p = lock.run(info('P', 'sp'), async () => { order.push('p start'); await g.promise; order.push('p end'); });
    await sleep(20);
    const c = lock.run(info('C', 'sc', { ancestors: ['sp'] }), async () => { order.push('c'); });
    await sleep(40);
    t.ok('持ち主が呼び出しを実行している間は、子も待つ', order.join() === 'p start');
    g.open(); await p; await c;
    t.ok('持ち主の呼び出しが終わってから子へ貸す', order.join() === 'p start,p end,c' && lock.holder().turnId === 'C');
    lock.endTurn('C'); lock.endTurn('P');
  }
  {
    // 孫は子から借りる。持ち主が先に終われば、子がそのまま持ち主になる
    const { lock, log, info } = make();
    await lock.run(info('P', 'sp'), async () => {});
    await lock.run(info('C', 'sc', { ancestors: ['sp'] }), async () => {});
    await lock.run(info('G', 'sg', { ancestors: ['sc', 'sp'] }), async () => {});
    t.ok('孫（祖先に子と親を持つ）は、持ち主の子から借りる', lock.holder().turnId === 'G');
    lock.endTurn('P');
    t.ok('持ち主（親）のターンが先に終わっても、借りている孫はそのまま持ち主', lock.holder().turnId === 'G');
    lock.endTurn('G');
    t.ok('孫が終われば子へ返り、親は戻らない（終わっている）', lock.holder().turnId === 'C');
    lock.endTurn('C');
    t.ok('全部終われば空', lock.holder() === null && log.arms.at(-1) === null);
  }
  {
    // 親子の待ち合い（親が子の完了を待っている間に、子がロックを待つ）が起きない
    const { lock, info } = make({ waitMs: 300 });
    await lock.run(info('P', 'sp'), async () => {});
    const child = await code(lock.run(info('C', 'sc', { ancestors: ['sp'] }), async () => {}));
    t.ok('親がロックを持ったまま子の完了を待っていても、子は busy にならず動く', child === 'ok');
    lock.endTurn('C'); lock.endTurn('P');
  }

  // ---- 止めた印（Esc・止める）
  {
    const { lock, info } = make();
    await lock.run(info('P', 'sp'), async () => {});
    await lock.run(info('C', 'sc', { ancestors: ['sp'] }), async () => {});
    const r = lock.stopSession('sp');
    t.ok('computerStop: その会話のターンと、貸している先の子のターンに印を付ける。owner は今の持ち主（main へ computer-stop を送る先）',
      r.stopped === true && r.owner === 'C' && lock.turn(info('P', 'sp')).stopped?.reason === 'stop' && lock.turn(info('C', 'sc', { ancestors: ['sp'] })).stopped?.reason === 'stop');
    lock.endTurn('C'); lock.endTurn('P');
  }
  {
    const { lock, info } = make();
    await lock.run(info('P', 'sp'), async () => {});
    await lock.run(info('C', 'sc', { ancestors: ['sp'] }), async () => {});
    const r = lock.stopSession('sc');
    t.ok('子の会話だけを止めたとき、貸している親には付けない', r.stopped && lock.turn(info('C', 'sc')).stopped && !lock.turn(info('P', 'sp')).stopped);
    lock.endTurn('C'); lock.endTurn('P');
  }
  {
    const { lock, info } = make();
    await lock.run(info('P', 'sp'), async () => {});
    await lock.run(info('C', 'sc', { ancestors: ['sp'] }), async () => {});
    const ok = lock.escape('C');
    t.ok('物理の Esc: 持ち主と、貸し借りでつながる全部のターンに付ける（reason は escape）', ok && lock.turn(info('P', 'sp')).stopped?.reason === 'escape' && lock.turn(info('C', 'sc')).stopped?.reason === 'escape');
    t.ok('今の持ち主でない owner の Esc は、そのターンだけ（知らなければ何もしない）', lock.escape('nobody') === false);
    lock.endTurn('C'); lock.endTurn('P');
  }
  {
    const { lock, info } = make();
    t.ok('ロックに関わっていない会話の「止める」は stopped: false', lock.stopSession('nobody').stopped === false);
    await lock.run(info('A'), async () => {});
    const b = code(lock.run(info('B'), async () => {}));
    await sleep(20);
    lock.stopSession('B');
    t.ok('待っているターンを止めると、待ち（呼び出し）はすぐ stopped で返る', (await b) === 'stopped');
    t.ok('止めた印のあるターンは、ロックが空いても取れない（stopped）', (lock.endTurn('A'), await code(lock.run(info('B'), async () => {}))) === 'stopped');
    lock.endTurn('B');
    t.ok('endTurn で印は消える（次のターンは取れる）', (await code(lock.run(info('B2', 'B'), async () => {}))) === 'ok');
    lock.endTurn('B2');
  }

  // ---- main か core が作り直された
  {
    const { lock, log, info } = make();
    await lock.run(info('A'), async () => {});
    const b = lock.run(info('B'), async () => 'b');
    await sleep(20);
    lock.reset();
    t.ok('computer-ready を受けたら持ち主を外し、待っている先頭に譲る', (await b) === 'b' && lock.holder().turnId === 'B' && log.arms.at(-1) === 'B');
    lock.endTurn('A'); lock.endTurn('B');
  }
}
