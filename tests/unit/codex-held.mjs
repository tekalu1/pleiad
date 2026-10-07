// Codex の共有の app-server を保持役の子に載せる部品（無停止の更新 段階 3。core/backends/codex-rpc.mjs の保持役の口・codex-held.mjs）。保持役の口は偽物（本物の保持役を通す確かめは adopt-codex）。
//   1. 載せるかの切り替え（codexHeldEnabled）: off は載せない・置き場（AGENT_HOST_RUNTIME_ROOT）があれば載せる（書かなくても・on でも）・置き場が無ければ載せない
//   2. CodexRpc: 載せたときの依頼の id は世代つきの文字列（前のサーバーの応答を取り違えない）・付け直した app-server には initialize を送らない・送る側は 1 回だけ
//   3. 付け直すスレッド: 預かった frame を再生の後に順に渡す・記録は全部のスレッドの出力が混ざるのでこのスレッド（と子孫）の分だけ・答えが残っている依頼だけを同じ id で出し直す・
//      親子は通知から学ぶ・全部引き取るまで ack しない
//   4. 手を離す: 待っている依頼を断る・以後は書かない・stop は手を離した子を止めない・同じ tick の全部のターンの札を 1 回で置いて 1 回だけ detach（ack → label → detach の順）
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { CodexRpc } from '../../core/backends/codex-rpc.mjs';
import { HeldAppServer, codexHeldEnabled } from '../../core/backends/codex-held.mjs';

export const name = 'codex-held';
export const title = 'Codex の app-server を保持役に載せる部品: 載せるかの切り替え・世代つきの id・付け直すスレッドの再生と預かり・手を離す';

const line = value => JSON.stringify({ jsonrpc: '2.0', ...value });
const note = (method, params) => line({ method, params });
const tick = () => new Promise(resolve => setImmediate(resolve));

/** 保持役の口の偽物（CodexRpc が見る形。core/backends/codex-held.mjs の HeldAppServer と同じ口） */
function mockHeld({ adopted = false, expected = [] } = {}) {
  const writes = [];
  const acks = [];
  const state = { sink: null, killed: 0, stopped: 0 };
  const held = {
    adopted, expected, writes, acks, state,
    get writable() { return true; },
    write(text) { writes.push(JSON.parse(text)); return true; },
    ack(seq) { acks.push(seq); },
    kill() { state.killed += 1; },
    stop() { state.stopped += 1; return Promise.resolve(); },
    dispose() {},
    run(sink) { state.sink = sink; },
    push(text, seq) { state.sink.line(text, seq); },
  };
  return held;
}

/** スレッドのハンドラー（codex.mjs の runTurn の handlers と同じ形）。届いたものを順に溜める */
function handlers(log, { answer = () => ({ decision: 'accept' }) } = {}) {
  return {
    onNotification: (method, params) => log.push(['n', method, params?.threadId ?? null]),
    onChildNotification: (method, params, child) => log.push(['cn', method, child.threadId]),
    onRequest: async (method, params, child) => { log.push(['r', method, params?.threadId ?? null, child?.threadId ?? null]); return answer(method, params, child); },
  };
}

export default async function (t) {
  // ---- 1. 載せるかの切り替え
  {
    const saved = { runtime: process.env.AGENT_HOST_RUNTIME_ROOT, holder: process.env.AGENT_HOST_CODEX_HOLDER };
    const set = (runtime, holder) => {
      if (runtime === undefined) delete process.env.AGENT_HOST_RUNTIME_ROOT; else process.env.AGENT_HOST_RUNTIME_ROOT = runtime;
      if (holder === undefined) delete process.env.AGENT_HOST_CODEX_HOLDER; else process.env.AGENT_HOST_CODEX_HOLDER = holder;
    };
    try {
      set(undefined, undefined);
      assert.equal(codexHeldEnabled(), false, '置き場が無ければ載せない');
      set(undefined, 'on');
      assert.equal(codexHeldEnabled(), false, 'on でも置き場が無ければ載せない');
      set('C:/runtime', undefined);
      assert.equal(codexHeldEnabled(), true, '置き場があって何も書かなければ載せる（既定は on）');
      set('C:/runtime', 'on');
      assert.equal(codexHeldEnabled(), true);
      set('C:/runtime', 'OFF');
      assert.equal(codexHeldEnabled(), false, 'off（大小を問わない）は今の流れ');
    } finally { set(saved.runtime, saved.holder); }
    t.ok('載せるかの切り替え: off は載せない・置き場があれば既定で載せる・置き場が無ければ載せない', true);
  }

  // ---- 2. 依頼の id と initialize
  {
    const fresh = mockHeld();
    const rpc = new CodexRpc({}, { acquire: async () => fresh });
    const started = rpc.start();
    await tick(); await tick();
    const init = fresh.writes[0];
    assert.equal(init.method, 'initialize', '起こした app-server には initialize を送る');
    assert.equal(typeof init.id, 'string', '載せたときの依頼の id は文字列');
    assert.match(init.id, /^\d+\.[a-z0-9]+\.1$/, '世代（プロセスの pid と起動の時刻）と連番');
    fresh.push(line({ id: 'someone-else.1', result: { ok: false } }), 1);          // 前のサーバーの応答（別の世代）は取り違えない
    fresh.push(line({ id: 1, result: { ok: false } }), 2);                         // 数値の id（前のサーバーが使っていた形）も同じ
    await tick();
    fresh.push(line({ id: init.id, result: { userAgent: 'x' } }), 3);
    await started;
    assert.equal(fresh.writes[1].method, 'initialized');
    const second = rpc.request('thread/list', {});
    await tick();
    assert.match(fresh.writes[2].id, /\.2$/, '2 つ目の依頼の id は連番');
    fresh.push(line({ id: fresh.writes[2].id, result: { data: [] } }), 4);
    assert.deepEqual(await second, { data: [] });
    assert.equal(fresh.state.sink.line !== undefined, true);

    const adopted = mockHeld({ adopted: true });
    const rpc2 = new CodexRpc({}, { acquire: async () => adopted });
    await rpc2.start();
    assert.deepEqual(adopted.writes, [], '付け直した app-server（initialize 済み）には何も送らない');
    t.ok('依頼の id は世代つきの文字列（前のサーバーの応答を取り違えない）。起こした app-server には initialize を送り、付け直した app-server には送らない', true);
  }

  // ---- 3. 付け直すスレッド
  {
    const held = mockHeld({ adopted: true, expected: ['X', 'Y'] });
    const rpc = new CodexRpc({}, { acquire: async () => held });
    await rpc.start();
    const x = [], y = [];
    // 付け直しの前に届いた続き（ack の次から）: どのスレッドも引き取っていないので預かる。子 X1（X のサブエージェント）の依頼も、親が分かるまで預かる
    held.push(note('item/agentMessage/delta', { threadId: 'X', delta: 'live-x1' }), 101);
    held.push(note('item/agentMessage/delta', { threadId: 'Y', delta: 'live-y1' }), 102);
    held.push(line({ id: 7, method: 'item/commandExecution/requestApproval', params: { threadId: 'X1', itemId: 'child-live' } }), 103);
    assert.deepEqual(held.writes, [], '預かっている間は何も返さない');
    assert.deepEqual(held.acks, [], '引き取るまで ack しない');

    // X の記録の再生: X の通知・X の依頼（答えが残っているもの）・答えは旧サーバーが書いたもの・Y の行（X の再生では渡さない）・子 X1 の親子を通知から学ぶ
    const lines = [
      [91, note('turn/started', { threadId: 'X', turn: { id: 'tx' } })],
      [92, note('item/agentMessage/delta', { threadId: 'Y', delta: 'replay-y' })],
      [93, line({ id: 5, method: 'item/commandExecution/requestApproval', params: { threadId: 'X', itemId: 'answered' } })],
      [94, line({ id: 6, method: 'item/commandExecution/requestApproval', params: { threadId: 'X', itemId: 'open' } })],
      [95, note('thread/started', { thread: { id: 'X1', parentThreadId: 'X', agentNickname: 'Planck' } })],
      [96, note('item/started', { threadId: 'X1', item: { id: 'c1', type: 'commandExecution' } })],
      [97, line({ id: 8, method: 'item/commandExecution/requestApproval', params: { threadId: 'X1', itemId: 'child-open' } })],
      [98, line({ id: 1, result: {} })],
    ];
    const pendingKeys = new Set([JSON.stringify(6), JSON.stringify(8)]);
    rpc.adoptThread('X', handlers(x), { lines, pendingKeys });
    await tick();
    // 通知は同期で渡り、依頼は次の microtask で処理する（承認を出す）。どちらも記録の順
    assert.deepEqual(x.map(([kind, method, thread, child]) => `${kind}:${method}:${thread}:${child ?? ''}`), [
      'n:turn/started:X:',
      'cn:thread/started:X1:',                                  // 子の通知は親の onChildNotification へ
      'cn:item/started:X1:',
      'n:item/agentMessage/delta:X:',                           // 預かっていた続き（X の分）は再生の後
      'r:item/commandExecution/requestApproval:X:',             // 答えが残っている依頼だけ出し直す（id 5 は旧サーバーが答えた）
      'r:item/commandExecution/requestApproval:X1:X1',          // 子の依頼は親の onRequest に（child つき）
      'r:item/commandExecution/requestApproval:X1:X1',          // 預かっていた子の依頼（親子が分かったので渡る）
    ], 'X: 再生（X と子孫の分だけ）の後に、預かっていた続きが順に渡る');
    assert.deepEqual(held.writes.map(w => [w.id, w.result?.decision]).filter(([id]) => typeof id === 'number'), [[6, 'accept'], [8, 'accept'], [7, 'accept']], '出し直した依頼には同じ id で答える');
    assert.deepEqual(held.acks, [], 'Y を引き取るまで ack しない');
    rpc.adoptThread('Y', handlers(y), { lines: [lines[1]], pendingKeys });
    await tick();
    assert.deepEqual(y.map(([kind, method, thread]) => `${kind}:${method}:${thread}`), ['n:item/agentMessage/delta:Y', 'n:item/agentMessage/delta:Y'], 'Y: 再生 → 続き');
    assert.deepEqual(held.acks, [103], '全部のスレッドを引き取ったら、処理し終えた最後の行まで ack する');
    held.push(note('item/agentMessage/delta', { threadId: 'X', delta: 'live-x2' }), 104);
    assert.equal(x.at(-1)[1], 'item/agentMessage/delta', '引き取った後は、そのまま流れる');
    await tick();
    assert.deepEqual(held.acks, [103, 104], '続きは行ごとに ack する（保持役の口がまとめて送る）');
    t.ok('付け直すスレッド: 預かった frame を再生の後に順に渡す・再生はそのスレッドと子孫の分だけ・答えが残っている依頼だけを同じ id で出し直す・親子は通知から学ぶ・全部引き取るまで ack しない', true);

    // あきらめたスレッド: 預かった frame は片付き（依頼にはエラーを返す）、待ちが無くなれば ack する
    const gave = mockHeld({ adopted: true, expected: ['Z'] });
    const rpc3 = new CodexRpc({}, { acquire: async () => gave });
    await rpc3.start();
    gave.push(line({ id: 9, method: 'item/commandExecution/requestApproval', params: { threadId: 'Z', itemId: 'z' } }), 5);
    rpc3.unexpect('Z');
    await tick();
    assert.equal(gave.writes[0].id, 9);
    assert.ok(gave.writes[0].error, '付け直しをあきらめたスレッドの依頼にはエラーを返す（app-server を待たせたままにしない）');
    assert.deepEqual(gave.acks, [5]);
    t.ok('付け直しをあきらめたスレッド: 預かった依頼にはエラーを返し、ack を進める', true);
  }

  // ---- 4. 手を離す
  {
    const held = mockHeld();
    const rpc = new CodexRpc({}, { acquire: async () => held });
    const started = rpc.start();
    await tick(); await tick();
    held.push(line({ id: held.writes[0].id, result: {} }), 1);
    await started;
    const pending = rpc.request('thread/read', { threadId: 'X' });
    pending.catch(() => {});
    await tick();
    held.state.sink.handedOff();
    await assert.rejects(pending, /handed over|引き継いだ/, '待っている依頼は、手を離したことで断る');
    await assert.rejects(rpc.start(), /handed over|引き継いだ/, '手を離した後は何も送らない');
    rpc.stop();
    assert.equal(held.state.stopped, 0, 'stop は手を離した子を止めない（新しいサーバーが引き継ぐ）');
    t.ok('手を離す: 待っている依頼を断り、以後は書かず、stop も子を止めない', true);
  }

  // ---- 5. HeldAppServer: 札・ack・同じ tick の全部のターンをまとめて手を離す
  {
    const order = [];
    const client = Object.assign(new EventEmitter(), {
      connected: true,
      write: (...args) => { order.push(['write', args[1]]); return true; },
      ack: (id, seq) => order.push(['ack', seq]),
      mark: (id, name) => order.push(['mark', name]),
      unmark: (id, name) => order.push(['unmark', name]),
      label: (id, label) => order.push(['label', label]),
      detach: async () => { order.push(['detach']); return { children: [] }; },
      kill: () => order.push(['kill']),
      attach: async () => ({ alive: true, pendingRequests: [] }),
    });
    const held = new HeldAppServer({ client, state: { acked: 0, seq: 0, marks: {} }, spawned: true });
    held.metaSnapshot = () => ({ loaded: { X: ['default', 'fp', 'hk'] }, watch: { X: 'session-x' } });
    const seen = [];
    held.run({ line: (text, seq) => seen.push(seq), err() {}, exit() {}, lost() {}, handedOff: () => order.push(['handedOff']) });
    held.markTurn('X');
    held.putCard('X', { sessionId: 'sx' });
    held.putCard('Y', { sessionId: 'sy' });
    held.ack(12);
    await new Promise(resolve => setTimeout(resolve, 5));
    assert.deepEqual(order.filter(([k]) => k !== 'ack').map(([k, v]) => (k === 'label' ? `label:${Object.keys(v.turns).sort()}` : `${k}${typeof v === 'string' ? `:${v}` : ''}`)),
      ['mark:turn:X', 'label:X,Y'], '印はターンの始まり。札はまとめて 1 回で置く');
    order.length = 0;
    // 同じ tick に来た 2 つのターンの手を離す: 札を全部置き、ack を進めてから、1 回だけ detach
    held.putCard('X', { sessionId: 'sx', stopping: true });
    held.ack(20);
    const both = Promise.all([held.handOff(), held.handOff()]);
    await both;
    const kinds = order.map(([k]) => k);
    assert.deepEqual(kinds.filter(k => k === 'detach'), ['detach'], 'detach は 1 回だけ');
    assert.ok(kinds.indexOf('ack') < kinds.indexOf('label') && kinds.indexOf('label') < kinds.indexOf('detach'), 'ack → label → detach の順');
    const label = order.find(([k]) => k === 'label')[1];
    assert.equal(label.k, 'codex-app-server');
    assert.deepEqual(Object.keys(label.turns).sort(), ['X', 'Y']);
    assert.equal(label.turns.X.stopping, true, '札は最後に置いたもの');
    assert.deepEqual(label.watch, { X: 'session-x' });
    assert.equal(order.find(([k]) => k === 'ack')[1], 20, '処理し終えた最後の行まで ack する');
    assert.equal(held.detached, true);
    assert.equal(kinds.at(-1), 'handedOff', '読みの口（CodexRpc）は最後に手放す');
    held.ack(30);
    held.kill();
    await tick();
    assert.equal(order.filter(([k]) => k === 'kill').length, 0, '手を離した後は ack も kill も送らない');
    t.ok('HeldAppServer: 印はターンの始まり・札はまとめて置く・同じ tick の全部のターンは ack → label → detach の順で 1 回だけ手を離し、以後は何も送らない', true);
  }
}
