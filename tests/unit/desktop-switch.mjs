// 新しい版のサーバーへの切り替え（無停止の更新 1-6。desktop/switch.cjs、docs/zero-downtime-update/plan.md 1-6）。
// 状態機械は副作用を偽物にして、実時間・実プロセスなしで確かめる:
//   - 切り替えるか（版・ビルド）・待つ作業の数え方（`!` の行と裏の作業は切り替えで止まるもの。外部の stdio MCP・送信予定は数えない）・事前の確かめの判定
//   - 待ち → update-lock → S1 の終わり → S2 → 窓の読み直し。ロックが取れない・ロックの後に新しい作業・S1 が終わらない
//   - 止まるものだけが残ったとき（Z）: 自動では切り替えず「あとで／止めて切り替え」を聞く。あとで → held（止まるものが無くなれば切り替わる）・
//     止めて切り替え・画面が答える（answer）・待ち始めの時刻（since）・中断の進み・切り替えで止めたもの（stopped）
//   - 切り替えに失敗して前の版で動いている → もう一度試す（retry）
//   - S2 が立たない → 前の版、どちらも駄目 → failed
//   - 形式番号が違う版は自動で切り替えない（あとで → held、中断して更新）・起こせない版は main を起動し直す
//   - 「今すぐ中断して切り替える」・main の終了・S1 を手放している間（replacing）
//   - 引き継ぎ（段階 2 の 2d）: 保持役に載ったターン（held）は待たず、update-lock も取らずに effects.handover へ進む（作業の最中でも切り替わる）。
//     載っていないターンが残れば待つ・新しい版か旧サーバーが引き継ぎの形を持たなければ今までの先送り・断られたら待ち直す（間を延ばす）・
//     S2 を起こせなければ S1 のまま・S1 が渡して終わったのに S2 が立たなければ前の版で起こし直す
// 副作用の組み立て（createSwitchEffects）: S1 の終わりを待つ・付け直し・前の版の場所・ready の待ち。
// preload の名前は前の版の画面が使う分を残す（新しい main が古い版の画面を出す間。design.md §7.1）
// 本物: 別プロセスのサーバー（S1）に付けた包みのまま、S1 を終わらせて同じトークン・ポートで S2 を起こし、同じ包みでつながる
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const sw = require('../../desktop/switch.cjs');
const boot = require('../../desktop/server-boot.cjs');
const { createServerLink } = require('../../desktop/server-link.cjs');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export const name = 'desktop-switch';
export const title = '新しい版のサーバーへの切り替え: 作業が 0 件まで待つ・止まるものが残れば聞く・ロック・S1 の終わり・S2・読み直し・前の版へ戻す・もう一度試す・合わない版は聞く・今すぐ中断';

const tick = () => new Promise(resolve => setImmediate(resolve));
const OLD = { appVersion: '1.0.0', build: 'aaaaaaaaaaaa' };
const NEW = { appVersion: '1.0.1', build: 'bbbbbbbbbbbb' };
const idle = (extra = {}) => ({ count: 0, turns: [], permissions: [], subagents: [], tasks: [], background: [], shells: [], scheduled: { send: 0, resume: 0 }, ...extra });
const busy = () => idle({ count: 1, turns: [{ sessionId: 's1', backend: 'fake' }] });

/** 偽の副作用。works は running() が順に返す値（尽きたら最後の値） */
function fakeEffects({ works = [idle()], prepare = { ok: true, runtime: { root: 'R', key: 'new' }, mode: 'detached' }, check = { check: 1, ipc: [1, 1], dataSchema: 2, dataSchemaFound: 2 },
  locks = [{ ok: true }], stops = [{ ok: true }], startNew = async () => ({ type: 'ready', port: 7420, token: 'tok', ...NEW }), startPrevious = async () => ({ type: 'ready', port: 7420, token: 'tok', ...OLD }),
  ask = 'later', reattach = true, abortAll = async () => {}, now, handover = async () => ({ ready: { type: 'ready', port: 7420, token: 'tok', ...NEW }, timing: { ms: 12, gapMs: 3 } }) } = {}) {
  const calls = [];
  const delays = [];
  let w = 0, l = 0, s = 0;
  const effects = {
    delays,
    delay: ms => { delays.push(ms); return tick(); },
    handover: async (runtime, mode) => { calls.push(`handover:${runtime.key}:${mode}`); return handover(); },
    prepare: async () => { calls.push('prepare'); return prepare; },
    check: async runtime => { calls.push(`check:${runtime.key}`); if (check instanceof Error) throw check; return check; },
    ask: async info => { calls.push(`ask:${info.reason}`); effects.asked = info; return typeof ask === 'function' ? ask(info) : ask; },
    running: async () => { calls.push('running'); const value = works[Math.min(w++, works.length - 1)]; if (value instanceof Error) throw value; return value; },
    abortAll: async onProgress => { calls.push('abortAll'); return abortAll(onProgress); },
    lock: async () => { calls.push('lock'); return locks[Math.min(l++, locks.length - 1)]; },
    unlock: () => { calls.push('unlock'); },
    stopOld: async () => { calls.push('stopOld'); return stops[Math.min(s++, stops.length - 1)]; },
    reattachOld: async () => { calls.push('reattachOld'); return reattach; },
    startNew: async (runtime, mode) => { calls.push(`startNew:${runtime.key}:${mode}`); return startNew(); },
    startPrevious: async (runtime, mode) => { calls.push(`startPrevious:${mode}`); return startPrevious(); },
    reload: async ready => { calls.push(`reload:${ready.port}:${ready.token}`); },
    restart: async () => { calls.push('restart'); },
    fallback: async () => { calls.push('fallback'); },
    failed: async () => { calls.push('failed'); },
  };
  return { effects, calls };
}

function machine(options = {}, { server = OLD, target = NEW } = {}) {
  const { effects, calls } = fakeEffects(options);
  const control = sw.createSwitch({ server, target, effects, ...(options.now ? { now: options.now } : {}) });
  const states = [];
  control.onState(s => states.push(s.state));
  return { control, effects, calls, states };
}

async function waitState(control, state, rounds = 200) {
  for (let i = 0; i < rounds && control.snapshot().state !== state; i++) await tick();
  return control.snapshot().state === state;
}

export default async function (t) {
  // ---- 切り替えるか
  t.ok('ビルドが違えば切り替える（版が同じでも）', sw.needsSwitch({ appVersion: '1', build: 'a'.repeat(12) }, { appVersion: '1', build: 'b'.repeat(12) }));
  t.ok('版とビルドが同じなら切り替えない', !sw.needsSwitch(OLD, { ...OLD }));
  t.ok('ビルドが分からない古いサーバーは版で比べる', sw.needsSwitch({ appVersion: '1.0.0', build: null }, NEW) && !sw.needsSwitch({ appVersion: '1.0.1', build: null }, NEW));
  t.ok('この版が分からない（manifest が読めない）なら切り替えない', !sw.needsSwitch(OLD, null));

  // ---- 待つ作業（plan.md 1-6「数えない作業の扱い」）
  const work = idle({
    count: 3,
    turns: [{ sessionId: 'a', backend: 'claude' }],
    permissions: [{ sessionId: 'b', toolName: 'Bash' }, { sessionId: 'a', toolName: 'Bash', relay: true }, { sessionId: 'c', toolName: 'settings', detached: true }],
    subagents: [{ sessionId: 'a', id: 'x', status: 'running' }, { sessionId: 'a', id: 'y', status: 'completed' }],
    tasks: [{ sessionId: 'a', taskId: 't1', status: 'running' }],
    shells: [{ sessionId: 'd', runId: 'r1', command: 'npm run dev' }],
    background: [{ sessionId: 'e', backend: 'codex', tasks: [{ id: 'b1', kind: 'terminal', label: 'vite' }, { id: 'b2', kind: 'terminal', label: 'tsc -w' }] }],
    scheduled: { send: 4, resume: 2, held: 0, nextSendAt: 1 },
  });
  const blockers = sw.switchBlockers(work);
  t.ok('待つ作業の数は running の count（`!` の行・裏の作業は足さない）', blockers.count === 3, JSON.stringify(blockers));
  t.ok('`!` の行は切り替えで止まるもの（stoppers。コマンドを字にする）', blockers.stoppers.some(i => i.kind === 'shell' && i.command === 'npm run dev' && i.label === 'npm run dev') && !blockers.items.some(i => i.kind === 'shell'));
  t.ok('ターンの外に残っている裏の作業（Codex の裏の端末）も止まるもの', blockers.stoppers.filter(i => i.kind === 'background').length === 2 && blockers.stoppers.find(i => i.id === 'b1').label === 'vite');
  t.ok('止まるものの字は長さに上限がある', sw.switchBlockers(idle({ shells: [{ sessionId: 'd', runId: 'r', command: 'x'.repeat(1000) }] })).stoppers[0].label.length === 200);
  t.ok('中継の複製・設定の変更の承認・終わったサブエージェントは一覧に出さない', !blockers.items.some(i => i.kind === 'permission' && i.sessionId !== 'b') && !blockers.items.some(i => i.id === 'y'));
  t.ok('ターンの走っている会話の委譲タスクは重ねて出さない', !blockers.items.some(i => i.kind === 'task'));
  t.ok('送信予定・上限の解除後の再開は数えない（S2 が予定を戻す。断の数秒は送信の猶予 1 時間に収まる）', sw.switchBlockers(idle({ scheduled: { send: 3, resume: 1, held: 0, nextSendAt: Date.now() + 1000 } })).count === 0);
  t.ok('外部の stdio MCP は running に無く、数えない（作業が 0 件なら呼び出しの途中のものは無い。S2 が次に起こし直す）', sw.switchBlockers(idle()).count === 0);
  t.ok('running が取れなければ null（待ちを続ける）', sw.switchBlockers(null) === null);

  // ---- 事前の確かめ
  t.ok('形式番号・口の版が合えば ok', sw.judgeCheck({ check: 1, ipc: [1, 1], dataSchema: 2, dataSchemaFound: 2 }).ok);
  t.ok('データの形式番号が変わる版は schema', sw.judgeCheck({ check: 1, ipc: [1, 1], dataSchema: 3, dataSchemaFound: 2 }).reason === 'schema');
  t.ok('置き場の形式番号が読めない（null）なら形式では止めない', sw.judgeCheck({ check: 1, ipc: [1, 1], dataSchema: 3, dataSchemaFound: null }).ok);
  t.ok('main との口の版の範囲が重ならなければ ipc', sw.judgeCheck({ check: 1, ipc: [2, 3], dataSchema: 2, dataSchemaFound: 2 }).reason === 'ipc' && sw.judgeCheck({ check: 1, ipc: [0, 1], dataSchema: 2, dataSchemaFound: 2 }).ok);
  t.ok('確かめが走らない・形が違えば check', sw.judgeCheck({ error: 'spawn failed' }).reason === 'check' && sw.judgeCheck({ check: 2 }).reason === 'check' && sw.judgeCheck(null).reason === 'check');

  // ---- 版が同じなら何もしない
  {
    const { control, calls } = machine({}, { server: NEW });
    const snap = await control.run();
    t.ok('版が同じなら current で、何も起こさない', snap.state === 'current' && calls.length === 0);
  }

  // ---- 待ち → ロック → S1 の終わり → S2 → 読み直し
  {
    const { control, calls, states } = machine({ works: [busy(), busy(), idle(), idle()] });
    const seen = [];
    control.onState(s => { if (s.state === 'waiting') seen.push(s.waiting); });
    const snap = await control.run();
    t.ok('作業がある間は waiting（件数と一覧を渡す）', seen[0]?.count === 1 && seen[0].items[0].kind === 'turn' && seen[0].items[0].sessionId === 's1');
    t.ok('0 件になったらロック → S1 の終わり → S2（新しい版の実行場所・Job の分岐）→ 読み直し', calls.join(' ').endsWith('lock running stopOld startNew:new:detached reload:7420:tok'), calls.join(' '));
    t.ok('切り替え終わりは done（前の版ではない）', snap.state === 'done' && snap.previous === false && snap.server.build === NEW.build);
    t.ok('事前の確かめは新しい版の実行場所で走らせる', calls.includes('check:new') && calls.indexOf('check:new') < calls.indexOf('lock'));
    t.ok('状態の順: preparing → checking → waiting → locking → stopping → starting → reloading → done',
      ['preparing', 'checking', 'waiting', 'locking', 'stopping', 'starting', 'reloading', 'done'].every((s, i, a) => i === 0 || states.indexOf(s) > states.indexOf(a[i - 1])), states.join(' '));
  }
  // ---- 止まるものだけが残ったとき（Z。docs/design-system.md「切り替えを待つ表示」）
  const dev = () => idle({ shells: [{ sessionId: 'd', runId: 'r', command: 'npm run dev' }] });
  const codexTerminal = () => idle({ background: [{ sessionId: 'e', backend: 'codex', tasks: [{ id: 'b', label: 'vite dev' }] }] });
  {
    const { control, calls, effects } = machine({ works: [dev()], ask: 'now' });
    await control.run();
    t.ok('`!` の行が残っていれば自動では切り替えず聞く（待ちにも入らない）。「止めて切り替え」で ロック → S1 の終わり → S2', calls.includes('ask:stoppers') && effects.asked.waiting.stoppers[0].command === 'npm run dev'
      && calls.indexOf('ask:stoppers') < calls.indexOf('lock') && calls.includes('startNew:new:detached') && control.snapshot().state === 'done');
    t.ok('切り替えで止めたものを done に残す（切り替わった後の知らせに「止めたもの」を出す）', control.snapshot().stopped.length === 1 && control.snapshot().stopped[0].kind === 'shell');
  }
  {
    const { control, calls, states } = machine({ works: [codexTerminal()], ask: 'now' });
    await control.run();
    t.ok('裏の作業（Codex の端末）が残っていても同じ（asking を経て切り替える）', states.includes('asking') && !states.includes('waiting') && calls.includes('startNew:new:detached') && control.snapshot().stopped[0].kind === 'background');
  }
  {
    const { control, calls, states } = machine({ works: [dev(), dev(), dev(), idle()], ask: 'later' });
    const run = control.run();
    t.ok('「あとで」は held（reason: stoppers）。自動では切り替えない', await waitState(control, 'held') && control.snapshot().reason === 'stoppers' && !calls.includes('lock'));
    for (let i = 0; i < 20; i++) await tick();
    t.ok('「あとで」の間は聞き直さない', calls.filter(c => c === 'ask:stoppers').length === 1);
    await run;
    t.ok('止まるものが自然に無くなれば（「あとで」の後）、そのまま切り替わる。止めたものは無い', control.snapshot().state === 'done' && calls.includes('startNew:new:detached') && control.snapshot().stopped.length === 0 && calls.filter(c => c === 'ask:stoppers').length === 1, states.join(' '));
  }
  {
    const { control, calls } = machine({ works: [dev(), dev(), busy(), busy(), dev()], ask: 'later' });
    const run = control.run();
    await waitState(control, 'held');
    for (let i = 0; i < 30 && !calls.includes('lock'); i++) await tick();
    t.ok('「あとで」の後に作業が増えたら待ちに戻る（止まるものの「あとで」は終わり）。0 件になったらまた聞く', calls.filter(c => c === 'ask:stoppers').length === 2, calls.join(' '));
    control.cancel();
    await run;
  }
  {
    const { control, calls, effects } = machine({ works: [dev()], ask: null });
    const run = control.run();
    t.ok('ask が答えを返さなければ（画面が答える）、answer() を待つ', await waitState(control, 'asking') && control.snapshot().waiting.stoppers.length === 1);
    t.ok('answer(later) は held。answer は聞いていないとき false', control.answer('later') === true && await waitState(control, 'held') && control.answer('later') === false);
    t.ok('held からも answer(now)（interruptNow）が効く', control.answer('now') === true);
    effects.running = async () => idle();
    await run;
    t.ok('「止めて切り替え」で切り替わる（abortAll を呼ぶ）', control.snapshot().state === 'done' && calls.includes('abortAll'));
  }
  {
    const { control } = machine({ works: [dev()], ask: null });
    const run = control.run();
    await waitState(control, 'asking');
    t.ok('asking の interruptNow は「止めて切り替え」と同じ', control.interruptNow() === true);
    await run;
    t.ok('切り替わった', control.snapshot().state === 'done');
  }
  {
    const { control, calls } = machine({ works: [dev()], ask: null });
    const run = control.run();
    await waitState(control, 'asking');
    control.cancel();
    const snap = await run;
    t.ok('main が終わるなら asking の問いをやめる（ロックも S1 の終了もしない）', snap.state === 'cancelled' && !calls.includes('lock') && !calls.includes('stopOld'));
  }
  {
    const { control, calls } = machine({ works: [idle({ shells: [{ sessionId: 'd', runId: 'r', command: 'sleep 30' }] }), busy(), idle()] });
    await control.run();
    t.ok('待っている間に止まるものが出ても、作業が終われば（あとでの既定）聞く', calls.includes('ask:stoppers'));
  }
  {
    // since: 待ち始めた時刻。待ちでない状態から入ったときに決め、待っている間・ロックが取れず戻ったときは変えない
    let clock = 1000;
    const { control } = machine({ works: [busy(), busy(), idle()], locks: [{ ok: false, reason: 'busy' }, { ok: true }], now: () => clock++ });
    const sinces = [];
    control.onState(s => { if (s.state === 'waiting') sinces.push(s.since); });
    await control.run();
    t.ok('待ち始めの時刻（since）は待っている間・ロックの取り直しで変わらない', sinces.length >= 2 && new Set(sinces).size === 1 && Number.isFinite(sinces[0]), JSON.stringify(sinces));
  }
  {
    const { control, calls } = machine({ works: [idle({ scheduled: { send: 2, resume: 1 } })] });
    await control.run();
    t.ok('送信予定があっても待たない', calls.filter(c => c === 'running').length === 2 && calls.includes('startNew:new:detached'));
  }
  {
    const { control, calls } = machine({ works: [new Error('no answer'), idle()] });
    await control.run();
    t.ok('running が取れないときは待ちを続ける（切り替えない）', calls.indexOf('lock') > 1 && control.snapshot().state === 'done');
  }

  // ---- ロック
  {
    const { control, calls } = machine({ works: [idle()], locks: [{ ok: false, reason: '切り替えの最中' }, { ok: true }] });
    const blocked = [];
    control.onState(s => { if (s.blockedBy) blocked.push(s.blockedBy); });
    await control.run();
    t.ok('ロックが取れない（短い処理の最中）なら待ちに戻って取り直す', calls.filter(c => c === 'lock').length === 2 && blocked.includes('切り替えの最中') && control.snapshot().state === 'done');
  }
  {
    const { control, calls } = machine({ works: [idle(), busy(), busy(), idle(), idle()] });
    await control.run();
    t.ok('待っている間に新しい作業が始まった（ロックの直後に数え直して 1 件）なら、ロックを放して待ちに戻る',
      calls.indexOf('unlock') > calls.indexOf('lock') && calls.filter(c => c === 'lock').length === 2 && calls.indexOf('stopOld') > calls.lastIndexOf('lock'), calls.join(' '));
  }

  // ---- S1 の終わり
  {
    const { control, calls } = machine({ stops: [{ ok: false, error: 'did not stop' }, { ok: true }], reattach: true });
    await control.run();
    t.ok('S1 が 30 秒で終わらなければ付け直し、ロックを放して待ちからやり直す', calls.join(' ').includes('stopOld reattachOld unlock') && calls.filter(c => c === 'stopOld').length === 2 && control.snapshot().state === 'done');
  }
  {
    const { control, calls } = machine({ stops: [{ ok: false, error: 'gone' }], reattach: false });
    await control.run();
    t.ok('S1 が居なくなっていれば（付け直せない）そのまま S2 を起こす', calls.join(' ').includes('stopOld reattachOld startNew'));
  }

  // ---- S2 が立たない
  {
    const { control, calls } = machine({ startNew: async () => { throw new Error('exited'); } });
    const snap = await control.run();
    t.ok('S2 が立たなければ前の版で起こし直し、窓を読み直して知らせる', calls.join(' ').includes('startNew:new:detached startPrevious:detached reload') && calls.at(-1) === 'fallback');
    t.ok('前の版で動いている（previous）', snap.state === 'done' && snap.previous === true && snap.server.build === OLD.build);
  }
  {
    // もう一度試す（前の版で動いている間。画面の「もう一度試す」）
    let tries = 0;
    const { control, calls, states } = machine({ startNew: async () => { if (tries++ === 0) throw new Error('exited'); return { type: 'ready', port: 7420, token: 'tok', ...NEW }; }, works: [dev(), idle()], ask: 'now' });
    await control.run();
    t.ok('もう一度試すは、前の版で動いているときだけ（それ以外は false）', control.snapshot().previous === true && control.retry() === true);
    for (let i = 0; i < 200 && control.snapshot().state !== 'done'; i++) await tick();
    t.ok('やり直しは準備から同じ流れ（作業が残っていればまた待つ）で、今度は新しい版で動く', control.snapshot().state === 'done' && control.snapshot().previous === false && control.snapshot().server.build === NEW.build
      && calls.filter(c => c === 'check:new').length === 2, calls.join(' '));
    t.ok('やり直しの状態は idle から始まる（前の失敗を引きずらない）', states.lastIndexOf('idle') > states.indexOf('done') && control.retry() === false);
  }
  {
    const { control } = machine({ works: [busy(), busy()] });
    void control.run();
    await waitState(control, 'waiting');
    t.ok('待っている間の retry は何もしない', control.retry() === false);
    control.cancel();
  }
  {
    const { control, calls } = machine({ startNew: async () => { throw new Error('exited'); }, startPrevious: async () => { throw new Error('also exited'); } });
    const snap = await control.run();
    t.ok('前の版も立たなければ failed（窓は読み直さない）', snap.state === 'failed' && calls.at(-1) === 'failed' && !calls.some(c => c.startsWith('reload')));
  }

  // ---- 合わない版
  {
    const { control, calls, effects } = machine({ check: { check: 1, ipc: [1, 1], dataSchema: 3, dataSchemaFound: 2 }, works: [busy()], ask: 'later' });
    const run = control.run();
    t.ok('形式番号が変わる版は自動で切り替えず「あとで／中断して更新」を聞く', await waitState(control, 'held') && calls.includes('ask:schema') && effects.asked.waiting.count === 1);
    for (let i = 0; i < 20; i++) await tick();
    t.ok('「あとで」は held のまま。ロックも S1 の終了もしない', control.snapshot().state === 'held' && !calls.includes('lock') && !calls.includes('stopOld'));
    t.ok('held からも「今すぐ中断して切り替える」が効く', control.interruptNow() === true);
    effects.running = async () => idle();
    await run;
    t.ok('中断して切り替える: 全部を中断してから、同じ流れ（実行場所で起こし直す）で切り替える', calls.indexOf('abortAll') > calls.indexOf('ask:schema') && calls.includes('startNew:new:detached') && control.snapshot().state === 'done');
  }
  {
    const { control, calls } = machine({ check: { check: 1, ipc: [1, 1], dataSchema: 3, dataSchemaFound: 2 }, ask: 'now' });
    await control.run();
    t.ok('「中断して更新」: 全部を中断 → ロック → S1 の終わり → S2（S2 が形式を移行する）', calls.join(' ').includes('ask:schema') && calls.indexOf('abortAll') < calls.indexOf('lock') && calls.includes('startNew:new:detached'));
  }
  {
    const { control, calls } = machine({ prepare: { ok: false, reason: 'runtime', detail: 'manifest mismatch' }, ask: 'now' });
    const snap = await control.run();
    t.ok('実行場所を組めない版: 聞いてから、中断 → S1 を止めて main を起動し直す（S2 は起こさない）', calls.includes('ask:runtime') && calls.includes('stopOld') && calls.at(-1) === 'restart' && !calls.some(c => c.startsWith('startNew')) && snap.state === 'restarting');
  }
  {
    const { control, calls } = machine({ prepare: { ok: false, reason: 'job', detail: 'KILL_ON_JOB_CLOSE' }, ask: 'later' });
    void control.run();
    await waitState(control, 'held');
    t.ok('Job が起こすのを許さない版も聞く（あとでなら held）', calls.includes('ask:job') && control.snapshot().state === 'held');
    control.cancel();
  }
  {
    const { control, calls } = machine({ check: new Error('spawn ENOENT'), ask: 'later' });
    void control.run();
    t.ok('事前の確かめが走らない版も自動では切り替えない', await waitState(control, 'held') && calls.includes('ask:check') && !calls.includes('lock'));
    control.cancel();
  }

  // ---- 今すぐ中断して切り替える
  {
    const shellOnly = idle({ shells: [{ sessionId: 'd', runId: 'r', command: 'npm run dev' }] });
    const { control, calls } = machine({ works: [busy(), busy(), shellOnly] });
    const progress = [];
    control.onState(s => { if (s.state === 'interrupting') progress.push(s.interrupt); });
    const run = control.run();
    await waitState(control, 'waiting');
    t.ok('待ちの間だけ interruptNow が効く', control.interruptNow() === true);
    await run;
    t.ok('今すぐ中断: 全部を update で中断し、`!` の行・裏の作業が残っていても聞かずに切り替える（S1 と一緒に止まる）', calls.includes('abortAll') && calls.includes('stopOld') && !calls.includes('ask:stoppers') && control.snapshot().state === 'done');
    t.ok('切り替えで止めたもの（stopped）に `!` の行が残る', control.snapshot().stopped.length === 1 && control.snapshot().stopped[0].kind === 'shell');
    t.ok('中断の進み（interrupt: { done, total }）は total が中断を始めた時点の件数', progress[0]?.total === 1 && progress[0].done === 0);
    t.ok('終わった後の interruptNow は何もしない', control.interruptNow() === false);
  }
  {
    // 中断の進み: abortAll が見るたびに onProgress(work) を呼ぶ。止まった数は戻らない
    const seen = [];
    const { control } = machine({ works: [idle({ count: 4, turns: [{ sessionId: 'a' }, { sessionId: 'b' }, { sessionId: 'c' }, { sessionId: 'd' }] }), idle()],
      abortAll: async onProgress => { onProgress(idle({ count: 3, turns: [{}, {}, {}] })); onProgress(idle({ count: 4, turns: [{}, {}, {}, {}] })); onProgress(idle({ count: 1, turns: [{}] })); } });
    control.onState(s => { if (s.state === 'interrupting') seen.push(s.interrupt.done); });
    const run = control.run();
    await waitState(control, 'waiting');
    control.interruptNow();
    await run;
    t.ok('中断の進みは 0 → 1 → 3（途中で件数が増えても戻らない）', seen.join() === '0,1,3', seen.join());
  }
  {
    let first = true;
    const { control, calls } = machine({ works: [busy(), busy(), busy(), idle()], abortAll: async () => { if (first) { first = false; throw new Error('2 件が止まらない'); } } });
    const errors = [];
    control.onState(s => { if (s.error) errors.push(s.error); });
    const run = control.run();
    await waitState(control, 'waiting');
    control.interruptNow();
    await run;
    t.ok('中断が 30 秒で終わらなければ、理由を出して待ちに戻る（中断はやめる）', errors.includes('2 件が止まらない') && calls.filter(c => c === 'abortAll').length === 1 && control.snapshot().state === 'done');
    t.ok('止まらなかった印（interruptFailed）が立つ（画面は生の理由でなく辞書の文言を出す）', control.snapshot().interruptFailed === true);
  }

  // ---- main の終了・S1 を手放している間
  {
    const { control, calls } = machine({ works: [busy()] });
    const run = control.run();
    await waitState(control, 'waiting');
    control.cancel();
    const snap = await run;
    t.ok('main が終わるなら待ちをやめる（ロックも S1 の終了もしない）', snap.state === 'cancelled' && !calls.includes('lock') && !calls.includes('stopOld'));
  }
  {
    const replacing = [];
    let control;
    const { effects } = fakeEffects();
    for (const name of ['stopOld', 'startNew', 'reload']) {
      const original = effects[name];
      effects[name] = async (...args) => { replacing.push(`${name}:${control.replacing}`); return original(...args); };
    }
    control = sw.createSwitch({ server: OLD, target: NEW, effects });
    await control.run();
    t.ok('S1 の終わり・S2・読み直しの間は replacing（「サーバーが終了しました」を出さない）。終わったら外れる', replacing.every(s => s.endsWith(':true')) && replacing.length === 3 && control.replacing === false, replacing.join(' '));
  }

  // ---- target を後から読む
  {
    const { effects, calls } = fakeEffects();
    const control = sw.createSwitch({ server: OLD, target: async () => null, effects });
    const snap = await control.run();
    t.ok('この版の manifest が読めなければ切り替えない', snap.state === 'current' && calls.length === 0);
  }

  // ---- 引き継ぎ（段階 2 の 2d）
  {
    const handoverCheck = { check: 1, ipc: [1, 1], dataSchema: 2, dataSchemaFound: 2, handover: [1, 1], holder: [1, 1] };
    const heldWork = (extra = {}) => idle({ count: 2, turns: [{ sessionId: 'h1', backend: 'fake', held: true }], permissions: [{ sessionId: 'h1', toolName: 'Bash', held: true }], handover: { v: 1, holder: 1, held: 2, blocking: 0 }, ...extra });
    const blockedWork = () => idle({ count: 3, turns: [{ sessionId: 'h1', backend: 'fake', held: true }, { sessionId: 'x1', backend: 'codex' }], permissions: [{ sessionId: 'h1', toolName: 'Bash', held: true }],
      handover: { v: 1, holder: 1, held: 2, blocking: 1 } });
    const asBlockers = sw.switchBlockers(blockedWork(), { handover: true });
    t.ok('引き継ぎ: 待つ作業は held でないものだけ（count は blocking。保持役に載ったターンとその承認待ちは待たない）', asBlockers.count === 1 && asBlockers.items.length === 1 && asBlockers.items[0].sessionId === 'x1' && asBlockers.handover.held === 2, JSON.stringify(asBlockers));
    t.ok('引き継ぎでなければ今までどおり全部数える（held の印は見ない）', sw.switchBlockers(blockedWork()).count === 3 && sw.switchBlockers(blockedWork()).items.length === 3);
    // 保持役の子の app-server が持つ Codex の裏の端末（held: 引き継ぎで止まらない）は、止まるものとして聞かない（段階 3）
    const bgWork = () => idle({ background: [{ sessionId: 'e', backend: 'codex', held: true, tasks: [{ id: 'b1', label: 'vite' }] }, { sessionId: 'f', backend: 'codex', tasks: [{ id: 'b2', label: 'tsc -w' }] }], handover: { v: 1, holder: 1, held: 0, blocking: 0 } });
    t.ok('引き継ぎ: 保持役に載った Codex の裏の端末（held）は止まるものに入れない。載っていない裏の作業は止まるもの', sw.switchBlockers(bgWork(), { handover: true }).stoppers.map(x => x.id).join() === 'b2', JSON.stringify(sw.switchBlockers(bgWork(), { handover: true }).stoppers));
    t.ok('引き継ぎでなければ held の印は見ず、裏の端末は全部止まるもの', sw.switchBlockers(bgWork()).stoppers.map(x => x.id).join() === 'b1,b2');
    t.ok('引き継ぎで切り替えるか: 新しい版の handover の範囲に旧サーバーの版が入る・旧サーバーが載せている保持役の世代が新しい版の範囲に入る',
      sw.handoverMode(heldWork(), { handover: [1, 2], holder: [1, 1] }) === true
      && sw.handoverMode(heldWork(), { handover: [2, 3], holder: [1, 1] }) === false
      && sw.handoverMode(heldWork(), { handover: [1, 1], holder: [2, 2] }) === false
      && sw.handoverMode(idle({ handover: { v: 1, holder: 1, held: 0, blocking: 0 } }), { handover: [1, 1], holder: [2, 2] }) === true
      && sw.handoverMode(idle(), { handover: [1, 1], holder: [1, 1] }) === false
      && sw.handoverMode(heldWork(), { handover: null, holder: null }) === false);
    t.ok('事前の確かめ: handover・holder の範囲を持つ版はそれを返し、持たない版は null', sw.judgeCheck(handoverCheck).handover.join() === '1,1' && sw.judgeCheck(handoverCheck).holder.join() === '1,1'
      && sw.judgeCheck({ check: 1, ipc: [1, 1], dataSchema: 2, dataSchemaFound: 2 }).handover === null);

    // 保持役に載ったターンしか無い: 待たず、update-lock も取らず、引き継ぐ
    {
      const m = machine({ works: [heldWork()], check: handoverCheck });
      const snap = await m.control.run();
      t.ok('引き継ぎ: held のターンしか無ければ待たずに effects.handover へ進み（lock・stopOld・startNew は使わない）、窓を読み直して done',
        snap.state === 'done' && snap.previous === false && m.calls.includes('handover:new:detached') && !m.calls.includes('lock') && !m.calls.includes('stopOld') && !m.calls.some(c => c.startsWith('startNew'))
        && m.calls.at(-1) === 'reload:7420:tok' && snap.handover?.gapMs === 3 && m.states.includes('handing'), JSON.stringify({ calls: m.calls, states: m.states }));
      t.ok('引き継ぎ: 切り替えを待つ表示は出さない（作業の最中でも待ちに入らない）', !m.states.includes('waiting') && !m.states.includes('locking'));
    }
    // 載っていないターンが残る間は待つ。終わったら（held のターンは残ったまま）引き継ぐ
    {
      const m = machine({ works: [blockedWork(), blockedWork(), heldWork()], check: handoverCheck });
      const snap = await m.control.run();
      const waiting = m.states.indexOf('waiting');
      t.ok('引き継ぎ: 載っていないターンが残る間は待ち、無くなれば（held は残っていても）引き継ぐ', snap.state === 'done' && waiting >= 0 && m.states.indexOf('handing') > waiting && !m.calls.includes('lock'), JSON.stringify(m.states));
    }
    // 新しい版・旧サーバーが引き継ぎの形を持たない → 今までの先送り
    {
      const m = machine({ works: [heldWork({ count: 0, handover: undefined }), idle()], check: { check: 1, ipc: [1, 1], dataSchema: 2, dataSchemaFound: 2 } });
      const snap = await m.control.run();
      t.ok('引き継ぎの形を持たない版への切り替えは、今までの先送り（lock → stopOld → startNew）', snap.state === 'done' && m.calls.includes('lock') && m.calls.includes('stopOld') && m.calls.some(c => c.startsWith('startNew')) && !m.calls.some(c => c.startsWith('handover')));
      const legacy = machine({ works: [idle()], check: handoverCheck });
      const done = await legacy.control.run();
      t.ok('旧サーバーの running が handover を載せていなければ、新しい版が持っていても今までの先送り', done.state === 'done' && legacy.calls.includes('lock') && !legacy.calls.some(c => c.startsWith('handover')));
    }
    // 断られた: S1 は元のまま。待ち直す。続けて断られると間を延ばす
    {
      let n = 0;
      const m = machine({ works: [heldWork()], check: handoverCheck, handover: async () => (++n < 3 ? { declined: true, reason: 'blocked', detail: 'turn:x' } : { ready: { type: 'ready', port: 7420, token: 'tok', ...NEW }, timing: { ms: 1 } }) });
      const snap = await m.control.run();
      const waits = m.effects.delays.filter(ms => ms >= 2000);
      t.ok('引き継ぎ: S1 に断られたら待ち（blockedBy に理由）、また頼む。続けて断られると間を延ばす（2 秒 → 4 秒）', snap.state === 'done' && n === 3 && waits.join() === '2000,4000' && m.calls.filter(c => c.startsWith('handover:')).length === 3, JSON.stringify({ n, waits }));
    }
    // S2 を起こせなかった: S1 は何も渡していない。そのまま動かし続ける（previous）
    {
      const m = machine({ works: [heldWork()], check: handoverCheck, handover: async () => ({ stay: new Error('spawn failed') }) });
      const snap = await m.control.run();
      t.ok('引き継ぎ: S2 を起こせなければ S1 のまま（前の版で動いている印。窓は読み直さない）', snap.state === 'done' && snap.previous === true && /spawn failed/.test(snap.error) && m.calls.includes('fallback') && !m.calls.some(c => c.startsWith('reload')) && !m.calls.some(c => c.startsWith('startPrevious')));
      t.ok('S1 のままのとき retry でやり直せる', m.control.retry() === true);
    }
    // S1 は渡して終わったのに S2 が立たなかった: 前の版で起こし直す
    {
      const m = machine({ works: [heldWork()], check: handoverCheck, handover: async () => ({ failed: new Error('the new server exited') }) });
      const snap = await m.control.run();
      t.ok('引き継ぎ: S1 が渡して終わったのに S2 が立たなければ、前の版で起こし直し（前の版が札を読んで付け直す）、前の版で動いている旨を出す',
        snap.state === 'done' && snap.previous === true && m.calls.some(c => c.startsWith('startPrevious')) && m.calls.includes('fallback') && m.calls.at(-2).startsWith('reload'), JSON.stringify(m.calls));
      const both = machine({ works: [heldWork()], check: handoverCheck, handover: async () => ({ failed: new Error('x') }), startPrevious: async () => { throw new Error('y'); } });
      const failed = await both.control.run();
      t.ok('引き継ぎ: 前の版も起こせなければ failed', failed.state === 'failed' && both.calls.includes('failed'));
    }
    // 引き継ぎの間（S1 を手放している間）は「サーバーが終了しました」を出さない
    {
      let release;
      const m = machine({ works: [heldWork()], check: handoverCheck, handover: () => new Promise(resolve => { release = () => resolve({ ready: { type: 'ready', port: 1, token: 't', ...NEW }, timing: {} }); }) });
      const running = m.control.run();
      await waitState(m.control, 'handing');
      t.ok('引き継ぎの間は replacing（main の「サーバーが終了しました」を出さない）', m.control.replacing === true);
      release();
      await running;
      t.ok('終われば replacing でなくなる', m.control.replacing === false);
    }
  }

  // ---- 副作用の組み立て
  {
    const link = new EventEmitter();
    Object.assign(link, { pid: 4100, connected: true, messages: [], postMessage(m) { this.messages.push(m); return true; } });
    let clock = 0;
    let aliveUntil = 3;
    const effects = sw.createSwitchEffects({ link, ready: { port: 7420, token: 'tok', runtimeKey: 'old-key', pid: 4100 }, prepared: Promise.resolve(null), dataDir: 'D', resourcesPath: 'R', execPath: 'E',
      request: async type => ({ type, ok: true }), runningWork: async () => idle(), abortAll: async reason => { effects.aborted = reason; },
      alive: () => clock++ < aliveUntil, sleep: async () => {}, now: () => clock * 1000, stopTimeoutMs: 10_000,
      job: () => ({ inspectJob: () => ({}), decideLaunch: () => ({ mode: 'detached', reason: 'test' }) }),
      runtimeLib: () => ({ locate: async () => null, stableCliEnv: () => ({}) }) });
    const stopped = await effects.stopOld();
    t.ok('stopOld: shutdown を送り、S1 のプロセスが終わるまで待つ', stopped.ok === true && link.messages.at(-1).type === 'shutdown');
    clock = 0; aliveUntil = 1000;
    const late = await effects.stopOld();
    t.ok('stopOld: 上限までに終わらなければ ok: false', late.ok === false && /did not stop/.test(late.error));
    t.ok('reattachOld: S1 がまだつながっていれば付け直したことにする', await effects.reattachOld() === true);
    t.ok('prepare: 実行場所を組めなければ runtime', (await effects.prepare()).reason === 'runtime');
    await effects.abortAll();
    t.ok('abortAll は update の理由で中断する', effects.aborted === 'update');
    effects.unlock();
    t.ok('unlock は update-unlock を送る', link.messages.at(-1).type === 'update-unlock');
    const missing = await effects.startPrevious({ root: 'R' }, 'detached').then(() => null, error => error);
    t.ok('前の版が実行場所に無ければ startPrevious は失敗する', /previous version/.test(missing?.message ?? ''));
  }
  {
    const link = new EventEmitter();
    const waiting = sw.waitForReady(link, 1000);
    link.emit('message', { type: 'resident' });
    link.emit('message', { type: 'ready', port: 1 });
    const ready = await waiting.promise;
    t.ok('waitForReady: 次の ready を待ち、待ち終わったら登録を外す', ready.port === 1 && link.listenerCount('message') === 0);
    const timeout = await sw.waitForReady(new EventEmitter(), 5).promise.then(() => null, error => error);
    t.ok('waitForReady: 上限で timeout', timeout?.code === 'timeout');
  }
  {
    const prepared = { root: 'R', key: 'k' };
    const effects = sw.createSwitchEffects({ link: new EventEmitter(), ready: {}, prepared: Promise.resolve(prepared), dataDir: 'D',
      job: () => ({ inspectJob: () => ({}), decideLaunch: () => ({ mode: 'unsupported', reason: 'KILL_ON_JOB_CLOSE only' }) }) });
    const result = await effects.prepare();
    t.ok('prepare: Job が抜け道を許さなければ job', result.ok === false && result.reason === 'job');
  }

  // ---- 合わない版のダイアログ
  {
    const shown = [];
    const dialog = { showMessageBox: async (...args) => { shown.push(args.at(-1)); return { response: 1 }; } };
    const ask = sw.incompatibleDialog({ dialog, getWindow: () => null, t: (key, values) => (values ? `${key}:${JSON.stringify(values)}` : key) });
    const answer = await ask({ reason: 'schema', waiting: { count: 2, items: [] } });
    t.ok('ダイアログ: 理由・止まる件数・「あとで」の意味を出し、ボタンは「あとで／中断して更新」', answer === 'now' && shown[0].message.includes('switch.reasonSchema') && shown[0].message.includes('switch.incompatibleWork:{"count":2}')
      && shown[0].buttons.join() === 'switch.later,switch.interruptAndUpdate' && shown[0].cancelId === 0);
    await ask({ reason: 'runtime', waiting: { count: 0, items: [] } });
    t.ok('ダイアログ: 作業が無ければボタンは「今すぐ更新」', shown[1].buttons[1] === 'switch.updateNow' && shown[1].message.includes('switch.reasonRuntime'));
    const stoppers = await ask({ reason: 'stoppers', waiting: { count: 0, items: [], stoppers: [{ kind: 'shell' }, { kind: 'background' }] } });
    t.ok('ダイアログ（画面が表示を持たない版）: 止まるものが残ったときは「あとで／止めて切り替え」', stoppers === 'now' && shown[2].message.includes('switch.stoppersMessage:{"count":2}') && shown[2].message.includes('switch.stoppersLater')
      && shown[2].buttons.join() === 'switch.later,switch.stopAndSwitch' && shown[2].title === 'switch.stoppersTitle');
  }

  // ---- 付け直しの比べ方の材料（startSwitch）
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pleiad-switch-'));
    try {
      const link = new EventEmitter();
      Object.assign(link, { serverInfo: { appVersion: '1.0.1' }, postMessage: () => true });
      const logs = [];
      const control = sw.startSwitch({ linked: { link, prepared: Promise.resolve(null) }, ready: { port: 1, token: 't' }, resourcesPath: dir, log: line => logs.push(line),
        readManifest: async () => ({ appVersion: '1.0.1', buildHash: 'c'.repeat(64) }), request: async () => ({}), runningWork: async () => idle(), abortAll: async () => {} });
      await control.run();
      t.ok('startSwitch: ready にビルドが無い古いサーバーは welcome の版と比べる（同じ版なら切り替えない）', control.snapshot().state === 'current');
      const broken = sw.startSwitch({ linked: { link, prepared: Promise.resolve(null) }, ready: { port: 1, token: 't', appVersion: '0.9.0' }, resourcesPath: dir, log: line => logs.push(line),
        request: async () => ({}), runningWork: async () => idle(), abortAll: async () => {} });
      await broken.run();
      t.ok('startSwitch: この版の manifest が読めなければ切り替えない（理由を記録する）', broken.snapshot().state === 'current' && logs.some(line => /manifest of this version could not be read/.test(line)));
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }

  // ---- 本物: S1 → S2（同じトークン・ポート・同じ包み）
  {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pleiad-switch-data-'));
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pleiad-switch-root-'));
    fs.writeFileSync(path.join(dataDir, 'prefs.json'), JSON.stringify({ memoryLearnPaused: true }));
    const baseEnv = { ...process.env, AGENT_HOST_DATA: dataDir, AGENT_HOST_BACKENDS: 'fake', AGENT_HOST_ANTHROPIC_API: 'off', AGENT_HOST_ROUTING_USAGE: 'off', AGENT_HOST_OPENROUTER_API: 'http://127.0.0.1:9',
      AGENT_HOST_CEREBRAS_API: 'http://127.0.0.1:9', AGENT_HOST_GIT_SNAPSHOTS: 'off', AGENT_HOST_WORKTREES: 'off', AGENT_HOST_LOCALE: 'ja' };
    delete baseEnv.AGENT_HOST_TOKEN;
    const pids = [];
    const link = createServerLink({ appVersion: '0.0.1' });
    const messages = [];
    link.on('message', m => messages.push(m));
    const request = type => new Promise((resolve, reject) => {
      const id = `${type}-${Math.random()}`;
      const timer = setTimeout(() => { link.off('message', on); reject(new Error(`${type}: no answer`)); }, 10_000);
      const on = m => { if (m.type === type && m.id === id) { clearTimeout(timer); link.off('message', on); resolve(m); } };
      link.on('message', on);
      link.postMessage({ type, id });
    });
    const runningWork = () => new Promise((resolve, reject) => {
      const timer = setTimeout(() => { link.off('message', on); reject(new Error('running: no answer')); }, 10_000);
      const on = m => { if (m.type === 'running') { clearTimeout(timer); link.off('message', on); resolve(m.work); } };
      link.on('message', on);
      link.postMessage({ type: 'running' });
    });
    try {
      const s1Env = boot.serverEnv({ baseEnv, root, key: 'test-old', logFile: boot.serverLogFile(root), port: 0 });
      const first = await boot.startAndConnect({ link, dataDir, logFile: boot.serverLogFile(root), timeoutMs: 60_000,
        launch: () => boot.launchServer({ mode: 'detached', nodeExe: process.execPath, args: [path.join(ROOT, 'core', 'server.mjs')], cwd: ROOT, env: s1Env }) });
      pids.push(first.pid);
      let s1Ready = null;
      for (let i = 0; i < 300 && !(s1Ready = messages.find(m => m.type === 'ready')); i++) await new Promise(resolve => setTimeout(resolve, 50));
      t.ok('本物: main への ready に版・ビルド・pid・実行場所の版の名前が載る', s1Ready?.appVersion === JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version
        && 'build' in s1Ready && s1Ready.pid === first.pid && s1Ready.runtimeKey === 'test-old', JSON.stringify({ ...s1Ready, token: undefined }));
      const work = await runningWork();
      t.ok('本物: running に `!` の行の一覧（shells）が載る', Array.isArray(work.shells) && work.shells.length === 0 && work.count === 0);

      const reloaded = [];
      const rearmed = [];
      const effects = sw.createSwitchEffects({ link, ready: s1Ready, prepared: Promise.resolve({ root, key: 'test-new', appDir: ROOT, nodeExe: process.execPath, agentBrowserDir: null }),
        dataDir, resourcesPath: ROOT, execPath: process.execPath, cwd: ROOT, env: baseEnv, request, runningWork, abortAll: async () => {},
        job: () => ({ inspectJob: () => ({}), decideLaunch: () => ({ mode: 'detached', reason: 'test' }) }),
        reload: async ready => { reloaded.push(ready); }, rearm: () => rearmed.push(true), restart: async () => {}, fallback: async () => {}, failed: async () => {}, ask: async () => 'later' });
      const control = sw.createSwitch({ server: { appVersion: s1Ready.appVersion, build: 'a'.repeat(12) }, target: { appVersion: s1Ready.appVersion, build: 'b'.repeat(12) }, effects });
      const snap = await control.run();
      const s2Ready = reloaded[0];
      if (s2Ready?.pid) pids.push(s2Ready.pid);
      t.ok('本物: 切り替えが終わり（done）、S1 は終わっている', snap.state === 'done' && snap.previous === false && !boot.isAlive(first.pid), JSON.stringify({ state: snap.state, error: snap.error }));
      t.ok('本物: S2 は同じトークン・同じポートで立ち、別のプロセス・新しい版の名前', s2Ready && s2Ready.token === s1Ready.token && s2Ready.port === s1Ready.port && s2Ready.pid !== first.pid && s2Ready.runtimeKey === 'test-new');
      t.ok('本物: 同じ包みが S2 につながり（つなぎ直しの見張りも付け直す）、control.json は S2 のもの', link.connected && link.pid === s2Ready.pid && rearmed.length === 1 && boot.readControl(dataDir)?.pid === s2Ready.pid);
      const again = await runningWork();
      t.ok('本物: S2 とも running が往復する（message の登録はそのまま）', again.count === 0);
      link.kill();
      for (let i = 0; i < 300 && boot.isAlive(s2Ready.pid); i++) await new Promise(resolve => setTimeout(resolve, 50));
      t.ok('本物: S2 も終わらせる握手で終わる', !boot.isAlive(s2Ready.pid));
    } finally {
      for (const pid of pids) if (boot.isAlive(pid)) { try { process.kill(pid); } catch { /* 済み */ } }
      await new Promise(resolve => setTimeout(resolve, 300));
      fs.rmSync(dataDir, { recursive: true, force: true });
      fs.rmSync(root, { recursive: true, force: true });
    }
  }

  // ---- preload: 前の版の画面が使う名前を残す
  {
    // 新しい main は、切り替えを待つ間、古い版のサーバーの画面を出す（design.md §7.1・§8）。名前を変えるときは、前の名前をこの一覧ごと 1 版残す
    const PREVIOUS_NAMES = ['platform', 'setTitleBar', 'notifyCompletion', 'onNotificationClick', 'chooseFolder', 'openRemoteHosts', 'update', 'onUpdate',
      'browser.command', 'browser.layout', 'browser.onState', 'browser.onShortcut',
      // 切り替えを待つ表示（版 1。web/switch-notice.mjs。desktop/switch-screen.cjs の頭の注記: 口の形を変えるときは switch2 を足し、この switch は 1 版残す）
      'switch.version', 'switch.hello', 'switch.state', 'switch.onState', 'switch.act'];
    const exposed = {};
    const electron = { contextBridge: { exposeInMainWorld: (key, api) => { exposed[key] = api; } }, ipcRenderer: { send() {}, invoke() {}, on() {}, removeListener() {} } };
    const source = fs.readFileSync(new URL('../../desktop/preload.cjs', import.meta.url), 'utf8');
    vm.runInNewContext(source, { require: id => (id === 'electron' ? electron : null), process: { platform: 'win32' } });
    const names = [];
    for (const [key, value] of Object.entries(exposed.plyDesktop ?? {})) {
      if (value && typeof value === 'object') for (const sub of Object.keys(value)) names.push(`${key}.${sub}`);
      else names.push(key);
    }
    const missing = PREVIOUS_NAMES.filter(n => !names.includes(n));
    t.ok('preload は前の版の画面が使う名前を全部残している', missing.length === 0, `missing: ${missing.join(', ')}`);
  }
}
