// 切り替えを待つ表示への橋（desktop/switch-screen.cjs、docs/zero-downtime-update/design.md §6.1）。
// 状態機械の snapshot → 画面へ渡す形（版 1）・画面が表示を持つかの hello・画面の操作の返し先・表示を持たない画面へのダイアログの切り分け・
// 版の違う画面（口の版が知らない値・hello の来ない画面）。ipcMain・窓は偽物で、実時間を使わない。
// 本物の状態機械と画面の部品の通し（画面の表示）は tests/browser/switch-notice.cjs
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const screen = require('../../desktop/switch-screen.cjs');
const sw = require('../../desktop/switch.cjs');

export const name = 'desktop-switch-screen';
export const title = '切り替えの表示への橋: 状態 → 画面へ渡す形（版 1）・hello で表示を持つ画面だけに任せる・操作の返し先・持たない画面にはダイアログ';

const OLD = { appVersion: '1.0.0', build: 'aaaaaaaaaaaa' };
const NEW = { appVersion: '1.0.1', build: 'bbbbbbbbbbbb' };
const stoppers = [{ kind: 'shell', sessionId: 's9', runId: 'r1', command: 'npm run dev', label: 'npm run dev' }, { kind: 'background', sessionId: 's8', backend: 'codex', id: 'b1', label: 'vite dev' }];
const items = [{ kind: 'turn', sessionId: 's1', backend: 'claude' }, { kind: 'permission', sessionId: 's2', toolName: 'Bash' }];
const base = { server: OLD, target: NEW, waiting: null, reason: null, since: null, interrupt: null, interruptFailed: false, stopped: [], at: null, previous: false };

export default async function (t) {
  // ---- snapshot → 画面へ渡す形
  const ds = snap => screen.displayState({ ...base, ...snap });
  t.ok('版 1・target と current は版の名前', ds({ state: 'idle' }).v === 1 && ds({ state: 'idle' }).target === '1.0.1' && ds({ state: 'idle' }).current === '1.0.0');
  t.ok('始まる前・切り替えが要らない・main が終わる・起こし直す・どちらも起こせなかった → none（何も出さない）',
    ['idle', 'current', 'preparing', 'checking', 'cancelled', 'restarting', 'failed'].every(state => ds({ state }).phase === 'none'));
  const waiting = ds({ state: 'waiting', since: 123, waiting: { count: 2, items, stoppers } });
  t.ok('待ち: waiting（待ち始めの時刻・作業・止まるもの）', waiting.phase === 'waiting' && waiting.since === 123 && waiting.items.length === 2 && waiting.stoppers.length === 2 && waiting.interruptFailed === false);
  t.ok('作業の項目は必要な項目だけ（コマンド・ツール名など中身は渡さない。止まるものは字だけ）', JSON.stringify(waiting.items[0]) === JSON.stringify({ kind: 'turn', sessionId: 's1', backend: 'claude', label: null })
    && JSON.stringify(waiting.stoppers[0]) === JSON.stringify({ kind: 'shell', sessionId: 's9', backend: null, label: 'npm run dev' }));
  t.ok('ロックを取っている間（locking）は作業が 0 件。切り替え中と同じ（待ちに戻して、空の一覧をちらつかせない）', ds({ state: 'locking', waiting: { count: 0, items: [], stoppers: [] } }).phase === 'switching');
  t.ok('中断が止まらなかった印を渡す（画面が辞書の文言を出す。生の理由は渡さない）', ds({ state: 'waiting', interruptFailed: true, error: 'raw english', waiting: { count: 1, items, stoppers: [] } }).interruptFailed === true
    && !JSON.stringify(ds({ state: 'waiting', interruptFailed: true, error: 'raw english', waiting: { count: 1, items, stoppers: [] } })).includes('raw english'));
  t.ok('止まるものだけが残った: asking', ds({ state: 'asking', reason: 'stoppers', waiting: { count: 0, items: [], stoppers } }).phase === 'asking');
  t.ok('合わない版: manual（理由・作業・止まるもの）', ds({ state: 'incompatible', reason: 'schema', waiting: { count: 1, items, stoppers } }).phase === 'manual' && ds({ state: 'incompatible', reason: 'schema', waiting: { count: 1, items, stoppers } }).reason === 'schema');
  const heldStoppers = ds({ state: 'held', reason: 'stoppers', waiting: { count: 0, items: [], stoppers } });
  const heldManual = ds({ state: 'held', reason: 'schema', waiting: { count: 1, items, stoppers } });
  t.ok('あとでの後: held（止まるものだけが残ったときと、合わない版を区別する）', heldStoppers.phase === 'held' && heldStoppers.kind === 'stoppers' && heldManual.phase === 'held' && heldManual.kind === 'manual');
  t.ok('中断している: stopping（進み）。件数が 0 なら切り替え中と同じ', ds({ state: 'interrupting', interrupt: { done: 1, total: 4 } }).phase === 'stopping' && ds({ state: 'interrupting', interrupt: { done: 0, total: 4 } }).interrupt.total === 4
    && ds({ state: 'interrupting', interrupt: { done: 0, total: 0 } }).phase === 'switching');
  t.ok('S1 を終わらせて S2 を起こし窓を読み直す間は switching', ['locking', 'stopping', 'starting', 'fallback', 'reloading'].every(state => ds({ state }).phase === 'switching'));
  const done = ds({ state: 'done', previous: false, stopped: stoppers, at: 9, server: NEW });
  t.ok('切り替わった: done（止めたもの）', done.phase === 'done' && done.stopped.length === 2 && done.at === 9);
  const failed = ds({ state: 'done', previous: true, at: 10, server: OLD });
  t.ok('前の版で動いている: failed（動いている版と時刻）', failed.phase === 'failed' && failed.current === '1.0.0' && failed.target === '1.0.1' && failed.at === 10);
  t.ok('項目は 100 件までに切る', ds({ state: 'waiting', waiting: { count: 500, items: Array.from({ length: 500 }, (_, i) => ({ kind: 'turn', sessionId: `s${i}` })), stoppers: [] } }).items.length === 100);
  t.ok('版 1 以外の形は出せない（null）', screen.payloadFor({ ...base, state: 'waiting' }, 1)?.v === 1 && screen.payloadFor({ ...base, state: 'waiting' }, 2) === null && screen.BRIDGE_VERSIONS.join() === '1');

  // ---- 偽の窓・ipcMain
  const makeEnv = ({ trustedOk = true } = {}) => {
    const sent = [];
    const win = { isDestroyed: () => false, webContents: { send: (channel, payload) => sent.push({ channel, payload }) } };
    const on = {}, handle = {};
    const ipcMain = { on: (channel, fn) => { on[channel] = fn; }, handle: (channel, fn) => { handle[channel] = fn; } };
    const trusted = () => { if (!trustedOk) throw new Error('untrusted'); };
    const timers = [];
    const bridge = screen.createSwitchScreen({ ipcMain, trusted, getWindow: () => win, helloWaitMs: 8000, setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimer: () => {} });
    return { bridge, sent, on, handle, timers, win };
  };
  // 偽の状態機械（snapshot・onState・answer・interruptNow・retry）
  const fakeControl = (initial = { ...base, state: 'idle' }) => {
    let snap = initial;
    const listeners = [];
    const control = { calls: [], snapshot: () => snap, onState: fn => { listeners.push(fn); return () => {}; },
      answer: value => { control.calls.push(`answer:${value}`); return value === 'now' || value === 'later'; }, retry: () => { control.calls.push('retry'); return true; },
      set: next => { snap = { ...snap, ...next }; for (const fn of listeners) fn(snap); } };
    return control;
  };

  {
    const { bridge, sent, on, handle } = makeEnv();
    const control = fakeControl();
    bridge.attach(control);
    t.ok('attach 直後: 画面から hello が来ていなければ、表示を持つと見なさない', bridge.supported() === false);
    control.set({ state: 'waiting', since: 5, waiting: { count: 1, items, stoppers: [] } });
    t.ok('状態が変わると窓へ版 1 の形で送る（チャンネルは ply:switch-state）', sent.at(-1).channel === 'ply:switch-state' && sent.at(-1).payload.phase === 'waiting' && sent.at(-1).payload.v === 1);
    const count = sent.length;
    control.set({ state: 'waiting', since: 5, waiting: { count: 1, items, stoppers: [] } });
    t.ok('送る形が前と同じなら送らない（2 秒おきの見直しで画面を揺らさない）', sent.length === count);
    on['ply:switch-hello']({}, 1);
    t.ok('hello（版 1）が来たら表示を持つ画面と見なし、今の状態を 1 回送る（変わっていなくても）', bridge.supported() === true && sent.length === count + 1 && sent.at(-1).payload.phase === 'waiting');
    on['ply:switch-hello']({}, 99);
    t.ok('知らない版の hello は無視する（読めない画面には任せない）', bridge.supported() === true);
    bridge.reset();
    on['ply:switch-hello']({}, 99);
    t.ok('窓を読み込み直したら（reset）hello を待ち直す。知らない版の hello では対応にならない', bridge.supported() === false);
    t.ok('state: 画面が今の状態を取る（読み込み直した画面）', (await handle['ply:switch']({}, 'state', 1)).phase === 'waiting');
    t.ok('state: 知らない版は null', (await handle['ply:switch']({}, 'state', 2)) === null);
    t.ok('act: now・later は状態機械の answer へ、retry は retry へ', await handle['ply:switch']({}, 'act', 'now') === true && await handle['ply:switch']({}, 'act', 'later') === true && await handle['ply:switch']({}, 'act', 'retry') === true
      && control.calls.join() === 'answer:now,answer:later,retry');
    t.ok('act: 知らない操作は効かない', await handle['ply:switch']({}, 'act', 'quit') === false && control.calls.length === 3);
    t.ok('act: 知らない種類の呼び出しは false', await handle['ply:switch']({}, 'other', 'now') === false);
  }
  {
    const { handle, on, bridge } = makeEnv({ trustedOk: false });
    bridge.attach(fakeControl());
    let rejected = null;
    try { await handle['ply:switch']({}, 'state', 1); } catch (error) { rejected = error; }
    on['ply:switch-hello']({}, 1);
    t.ok('ローカルの窓の画面以外（リモート・同梱の窓）からの呼び出しは通さない', rejected?.message === 'untrusted' && bridge.supported() === false);
  }
  {
    const { handle } = makeEnv();
    t.ok('状態機械をつなぐ前の state は none（何も出ない）', (await handle['ply:switch']({}, 'state', 1)).phase === 'none');
  }

  // ---- 聞く: 表示を持つ画面は画面が答え、持たない画面にはダイアログ
  {
    const { bridge, on } = makeEnv();
    bridge.attach(fakeControl());
    on['ply:switch-hello']({}, 1);
    let dialog = 0;
    const answer = await bridge.ask({ reason: 'stoppers', waiting: {} }, async () => { dialog++; return 'now'; });
    t.ok('表示を持つ画面: ask は null（ダイアログを出さず、画面が answer で答える）', answer === null && dialog === 0);
  }
  {
    const { bridge, timers } = makeEnv();
    bridge.attach(fakeControl());
    let dialog = 0;
    const pending = bridge.ask({ reason: 'schema', waiting: { count: 1 } }, async info => { dialog++; return info.reason === 'schema' ? 'now' : 'later'; });
    await Promise.resolve();
    t.ok('窓の読み込み中（hello がまだ）は少し待つ（上限は helloWaitMs）', dialog === 0 && timers.length === 1 && timers[0].ms === 8000);
    timers[0].fn();
    t.ok('hello が来なければダイアログ（表示を持たない版の画面）', await pending === 'now' && dialog === 1);
  }
  {
    const { bridge, timers, on } = makeEnv();
    bridge.attach(fakeControl());
    const pending = bridge.ask({ reason: 'stoppers', waiting: {} }, async () => 'later');
    await Promise.resolve();
    on['ply:switch-hello']({}, 1);
    t.ok('待っている間に hello が来たら、ダイアログを出さず画面に任せる', await pending === null && timers.length === 1);
  }

  // ---- 本物の状態機械につなぐ（asking → 画面の答え → 切り替え）
  {
    const calls = [];
    const effects = {
      delay: () => new Promise(resolve => setImmediate(resolve)),
      prepare: async () => ({ ok: true, runtime: { root: 'R', key: 'new' }, mode: 'detached' }), check: async () => ({ check: 1, ipc: [1, 1], dataSchema: 2, dataSchemaFound: 2 }),
      ask: async () => null,
      running: async () => ({ count: 0, turns: [], permissions: [], subagents: [], tasks: [], background: [], shells: [{ sessionId: 'd', runId: 'r', command: 'npm run dev' }], scheduled: {} }),
      abortAll: async () => { calls.push('abortAll'); }, lock: async () => ({ ok: true }), unlock() {}, stopOld: async () => ({ ok: true }), reattachOld: async () => false,
      startNew: async () => ({ type: 'ready', port: 1, token: 't', ...NEW }), startPrevious: async () => ({ type: 'ready', port: 1, token: 't', ...OLD }),
      reload: async () => {}, restart: async () => {}, fallback: async () => {}, failed: async () => {},
    };
    const control = sw.createSwitch({ server: OLD, target: NEW, effects });
    const { bridge, sent, on, handle } = makeEnv();
    bridge.attach(control);
    on['ply:switch-hello']({}, 1);
    const run = control.run();
    for (let i = 0; i < 100 && control.snapshot().state !== 'asking'; i++) await new Promise(resolve => setImmediate(resolve));
    t.ok('本物: 作業が終わって `!` の行だけ残ると、窓に asking と止まるもの 1 件が届く', sent.at(-1).payload.phase === 'asking' && sent.at(-1).payload.stoppers[0].label === 'npm run dev');
    t.ok('本物: 画面の「止めて切り替え」（act now）で切り替わり、done に止めたものが載る', await handle['ply:switch']({}, 'act', 'now') === true);
    await run;
    const last = sent.at(-1).payload;
    t.ok('本物: 最後の状態は done（止めたもの: ! のシェル）。switching・stopping を経ている', last.phase === 'done' && last.stopped[0].kind === 'shell' && sent.some(s => s.payload.phase === 'switching'), sent.map(s => s.payload.phase).join());
  }
}
