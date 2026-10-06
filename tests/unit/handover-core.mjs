// 引き継ぎの順序と取り決め（無停止の更新 段階 2 の 2d。core/handover.mjs。docs/zero-downtime-update/plan.md 2d）を、副作用を偽物にして確かめる。
//   - 旧サーバーの順序: hold → 引き継げない作業の確認 → 短い処理を待つ → 処理中の呼び出しを上限まで待つ → タイマー → 札 → detach → 預かり物 → 放す
//   - 取りやめ（rollback）: 引き継げない作業・短い処理が終わらない・札が取れない。hold を戻し、止めたタイマーを戻し、取った札を戻す。放した後は戻さない
//   - 1 つのターンだけ detach できなければ、そのターンだけ中断して終わるのを待つ。ほかは渡す
//   - 処理中の呼び出しは上限を過ぎても進み、待ち切れた数を載せる
//   - 預かり物（トークン・ポート）の形・`--handover` の見分け・スケジュールと圧縮の予約のタイマーの止め戻し
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHandover, waitUntil, stashOf, readStash, handoverStart, HANDOVER_FLAG, STASH_VERSION } from '../../core/handover.mjs';
import { createSchedule } from '../../core/schedule.mjs';
import { createCompactionScheduler } from '../../core/compaction-scheduler.mjs';

export const name = 'handover-core';
export const title = '引き継ぎ（旧サーバーの順序・取りやめ・1 つのターンの中断・預かり物・予定のタイマーの止め戻し）';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** 偽の deps。calls に呼ばれた順を残す。overrides で差し替える */
function fakeDeps(overrides = {}) {
  const calls = [];
  const state = { busy: false, blockers: [], inflight: 0, cards: new Map(), endedKeys: new Set(), detachFails: new Set(), turns: [{ key: 'a', sessionId: 'sa' }, { key: 'b', sessionId: 'sb' }] };
  const deps = {
    log: () => {},
    hold: () => calls.push('hold'),
    unhold: () => calls.push('unhold'),
    settled: () => ({ ok: !state.busy, detail: state.busy ? 'switching' : '' }),
    blockers: () => state.blockers,
    inflight: () => state.inflight,
    turns: () => state.turns,
    stopTimers: () => calls.push('stopTimers'),
    resumeTimers: () => calls.push('resumeTimers'),
    take: item => { calls.push(`take:${item.key}`); return state.cards.has(item.key) && state.cards.get(item.key) === null ? null : { card: { key: item.key } }; },
    untake: item => calls.push(`untake:${item.key}`),
    detach: async item => { calls.push(`detach:${item.key}`); if (state.detachFails.has(item.key)) throw new Error('detach failed'); },
    abortOne: item => { calls.push(`abort:${item.key}`); state.endedKeys.add(item.key); },
    ended: item => state.endedKeys.has(item.key),
    stash: async () => { calls.push('stash'); },
    release: async result => { calls.push('release'); state.released = result; },
    ...overrides,
  };
  return { deps, calls, state };
}

export default async function (t) {
  // ---- 起動の引数・預かり物
  t.ok('起動の引数に --handover があるときだけ新サーバーの起動（node と entry は数えない）', handoverStart(['node', 'server.mjs', HANDOVER_FLAG]) === true && handoverStart(['node', 'server.mjs']) === false && handoverStart(['node', HANDOVER_FLAG]) === false);
  {
    const cli = 'c'.repeat(64);
    const stash = stashOf({ token: 'tok', cliToken: cli, port: 7420, appVersion: '1.2.3', at: 1_000_000 });
    t.ok('預かり物の往復（トークン・CLI のトークン・ポート）', JSON.stringify(readStash(JSON.parse(JSON.stringify(stash)), { now: 1_000_500 })) === JSON.stringify({ token: 'tok', cliToken: cli, port: 7420, at: 1_000_000 }));
    t.ok('前の引き継ぎの古い預かり物（5 分より古い）は使わない', readStash(stash, { now: 1_000_000 + 6 * 60_000 }) === null && readStash(stash, { now: 1_000_000 + 4 * 60_000 }) !== null);
    t.ok('預かり物の形が合わなければ null（起動の変数のまま起動する）', readStash(null) === null && readStash({}) === null && readStash({ v: STASH_VERSION + 1, handover: stash.handover }) === null
      && readStash({ v: STASH_VERSION, handover: { token: '' } }) === null && readStash({ v: STASH_VERSION, handover: { token: 'x' } }) === null);
    const odd = readStash(stashOf({ token: 'tok', cliToken: 'short', port: 99999 }));   // at は今
    t.ok('形の悪い CLI のトークン・ポートは捨て、トークンだけ使う', odd.token === 'tok' && odd.cliToken === null && odd.port === null);
  }
  {
    let now = 0;
    const clock = { now: () => now, sleep: async ms => { now += ms; } };
    let n = 0;
    const done = await waitUntil(() => ++n >= 4, { timeoutMs: 1000, pollMs: 20, ...clock });
    t.ok('waitUntil: 真になるまで刻みで待つ', done.ok === true && done.waitedMs === 60);
    const never = await waitUntil(() => false, { timeoutMs: 100, pollMs: 30, ...clock });
    t.ok('waitUntil: 上限まで待って諦める', never.ok === false && never.waitedMs >= 100 && never.waitedMs < 160);
  }

  // ---- 順序（成功）
  {
    const { deps, calls, state } = fakeDeps();
    const result = await createHandover(deps).run({ drainMs: 200, inflightMs: 200 });
    t.ok('成功: 順序は hold → タイマーを止める → 札を全部取る → detach → 預かり物 → 放す', result.ok === true
      && JSON.stringify(calls) === JSON.stringify(['hold', 'stopTimers', 'take:a', 'take:b', 'detach:a', 'detach:b', 'stash', 'release']), JSON.stringify(calls));
    t.ok('成功: 渡したターンと時間を答える（release に答えを渡す）', JSON.stringify(result.handed) === JSON.stringify(['sa', 'sb']) && result.aborted.length === 0 && result.droppedCalls === 0
      && Number.isFinite(result.ms.drain) && Number.isFinite(result.ms.inflight) && Number.isFinite(result.ms.detach) && state.released === result);
  }

  // ---- 取りやめ
  {
    const { deps, calls, state } = fakeDeps();
    state.blockers = [{ kind: 'turn', sessionId: 'sx' }];
    const result = await createHandover(deps).run({ drainMs: 100 });
    t.ok('引き継げない作業があれば、待たずに断る（hold を戻す。タイマーは止めていない）', result.ok === false && result.reason === 'blocked' && result.detail.includes('turn:sx')
      && JSON.stringify(calls) === JSON.stringify(['hold', 'unhold']), JSON.stringify(calls));
  }
  {
    const { deps, calls, state } = fakeDeps();
    state.busy = true;
    const from = Date.now();
    const result = await createHandover(deps).run({ drainMs: 150 });
    t.ok('短い処理が終わらなければ、上限まで待って断る（busy。何も渡していない）', result.ok === false && result.reason === 'busy' && result.detail === 'switching' && Date.now() - from >= 140
      && JSON.stringify(calls) === JSON.stringify(['hold', 'unhold']), JSON.stringify(calls));
  }
  {
    const { deps, calls, state } = fakeDeps();
    state.cards.set('b', null);
    const result = await createHandover(deps).run({ drainMs: 100, inflightMs: 100 });
    t.ok('札が取れないターンがあれば、取った札を戻し、タイマーと hold も戻して断る（card）', result.ok === false && result.reason === 'card'
      && JSON.stringify(calls) === JSON.stringify(['hold', 'stopTimers', 'take:a', 'take:b', 'untake:a', 'resumeTimers', 'unhold']), JSON.stringify(calls));
  }
  {
    const logs = [];
    const { deps, calls } = fakeDeps({ stash: async () => { throw new Error('boom'); }, log: line => logs.push(line) });
    const result = await createHandover(deps).run({ drainMs: 100, inflightMs: 100 });
    t.ok('預かり物が置けなくても取りやめない（子はもう渡っている。新サーバーは起動の変数のトークン・ポートで起動する）', result.ok === true && calls.at(-1) === 'release' && logs.some(line => line.includes('boom')), JSON.stringify(calls));
  }
  {
    const { deps, calls } = fakeDeps({ release: async () => { throw new Error('release failed'); } });
    const error = await createHandover(deps).run({ drainMs: 100, inflightMs: 100 }).then(() => null, e => e);
    t.ok('放した後の失敗は取りやめない（hold も戻さず、投げる）', error?.message === 'release failed' && !calls.includes('unhold') && !calls.includes('resumeTimers'));
  }
  {
    const { deps } = fakeDeps();
    const handover = createHandover(deps);
    const first = handover.run({ drainMs: 100, inflightMs: 100 });
    const second = await handover.run({ drainMs: 100, inflightMs: 100 });
    await first;
    t.ok('実行中にもう一度頼まれたら busy で断る', second.ok === false && second.reason === 'busy');
  }

  // ---- 処理中の呼び出し（上限を過ぎても進む）
  {
    const { deps, calls, state } = fakeDeps();
    state.inflight = 2;
    const from = Date.now();
    const result = await createHandover(deps).run({ drainMs: 100, inflightMs: 150 });
    t.ok('処理中の呼び出しは上限まで待ち、過ぎても進む（待ち切れた数を載せる）', result.ok === true && result.droppedCalls === 2 && Date.now() - from >= 140 && calls.at(-1) === 'release', JSON.stringify(result));
    const { deps: deps2, state: state2 } = fakeDeps();
    state2.inflight = 1;
    setTimeout(() => { state2.inflight = 0; }, 80);
    const early = await createHandover(deps2).run({ drainMs: 100, inflightMs: 2000 });
    t.ok('上限の前に終われば待ち切れた数は 0', early.ok === true && early.droppedCalls === 0 && early.ms.inflight < 1000);
  }

  // ---- 1 つのターンだけ detach できない
  {
    const { deps, calls, state } = fakeDeps();
    state.detachFails.add('a');
    const result = await createHandover(deps).run({ drainMs: 100, inflightMs: 100 });
    t.ok('detach できないターンだけ中断して（abortOne）終わるのを待ち、ほかは渡す', result.ok === true && JSON.stringify(result.handed) === JSON.stringify(['sb']) && JSON.stringify(result.aborted) === JSON.stringify(['sa'])
      && calls.includes('abort:a') && !calls.includes('abort:b') && calls.at(-1) === 'release', JSON.stringify(calls));
  }

  // ---- 予定のタイマー（schedule.pause / resume）
  {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-handover-core-'));
    try {
      const fired = [];
      const timers = [];
      let now = 1000;
      const schedule = createSchedule({ file: path.join(dir, 'schedule.json'), now: () => now, fire: row => { fired.push(row.id); },
        setTimer: (fn, ms) => { const timer = { fn, ms, cleared: false }; timers.push(timer); return timer; }, clearTimer: timer => { timer.cleared = true; } });
      await schedule.put({ id: 'r1', kind: 'send', sessionId: 's1', at: 5000 });
      t.ok('行を置くとタイマーを 1 つ張る', timers.length === 1 && !timers[0].cleared);
      schedule.pause();
      t.ok('pause でタイマーを止める', timers.every(timer => timer.cleared));
      now = 6000;
      await schedule.check();
      t.ok('pause 中は、時刻が過ぎていても check で撃たない（行は残り、新しいサーバーの restore が見る）', fired.length === 0 && schedule.list().length === 1 && timers.every(timer => timer.cleared));
      schedule.resume();
      t.ok('resume でタイマーを張り直す', timers.filter(timer => !timer.cleared).length === 1 && schedule.firing === false);
      await schedule.check();
      t.ok('resume の後は撃つ', JSON.stringify(fired) === JSON.stringify(['r1']));
    } finally { await fs.rm(dir, { recursive: true, force: true }).catch(() => {}); }
  }

  // ---- 圧縮の予約（stop / resume）
  {
    const timers = new Map();
    let seq = 0, now = 10_000;
    const compacted = [];
    const scheduler = createCompactionScheduler({ now: () => now, setTimer: (fn, ms) => { const id = ++seq; timers.set(id, { fn, ms }); return id; }, clearTimer: id => timers.delete(id),
      canRun: async () => true, compact: async id => { compacted.push(id); } });
    scheduler.schedule('s1', 'native-1', 5000);
    scheduler.schedule('s2', 'native-2', 9000);
    t.ok('予約を 2 つ張るとタイマーが 2 つ', timers.size === 2 && scheduler.entries().length === 2);
    scheduler.stop();
    t.ok('stop でタイマーだけ止め、予約は残る（新しいサーバーが保存から戻す）', timers.size === 0 && scheduler.entries().length === 2 && scheduler.get('s1') === 15_000);
    now += 2000;
    scheduler.resume();
    t.ok('resume で残りの時間のタイマーを張り直す', timers.size === 2 && [...timers.values()].map(timer => timer.ms).sort((a, b) => a - b).join() === '3000,7000', [...timers.values()].map(timer => timer.ms).join());
    scheduler.cancel('s1');
    scheduler.stop();
    scheduler.resume();
    t.ok('取り消した予約は resume で戻らない', timers.size === 1 && scheduler.entries().length === 1);
    await sleep(0);
  }
}
