// ルーティンのサービス（core/routines/{store,service,runner}.mjs。ADR 0112）: 保存・予約と発火・取りこぼしは最新の 1 回・一時停止と再開・実行の状態・
// 走っている間の発火はスキップ・承認待ちの期限・イベントのトリガ（bot の会話は対象にしない）・試しの実行・「広げる向き」の判定。
// 時計は手で進める（clock の身代わり）。チャンネルは本物（一時の置き場）、bot・会話・dispatch は身代わり。サーバー越しの確かめは routines-server.mjs。
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { sleep } from '../lib/ws-client.mjs';
import { createChannelService } from '../../core/channels/service.mjs';
import { createRoutineService, RoutineError } from '../../core/routines/service.mjs';
import { createRoutineStore, RoutineStoreError, normalizeRoutine } from '../../core/routines/store.mjs';
import { START_GRACE_MS, DRY_RUN_WAIT_MS, DRY_RUN_APPROVAL_MAX_MIN } from '../../core/routines/runner.mjs';

export const name = 'routines-schedule';
export const title = 'ルーティンのサービス: 予約と発火・取りこぼしは最新 1 回・一時停止と再開・実行の状態・走っている間はスキップ・承認の期限・イベントのトリガ・試しの実行・広げる向き・保存';

const MODES = {
  default: { label: '都度確認', scope: 'workspace', autonomy: 'ask' },
  auto: { label: 'auto', scope: 'workspace', autonomy: 'never' },
  plan: { label: 'plan', scope: 'readonly', autonomy: 'ask' },
  bypass: { label: 'bypass', scope: 'full', autonomy: 'never' },
};
const at = (y, mo, d, h = 0, mi = 0, s = 0) => new Date(y, mo - 1, d, h, mi, s, 0).getTime();
const MIN = 60_000;
const until = async (fn, { ms = 5000, label = '' } = {}) => {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) { last = await fn(); if (last) return last; await sleep(10); }
  throw new Error(`timeout: ${label} ${JSON.stringify(last ?? null)?.slice(0, 400)}`);
};

/** 手で進める時計。advance(to) は途中の予約を時刻順に呼ぶ */
function manualClock(start) {
  const state = { now: start, timers: [] };
  return {
    state,
    clock: {
      now: () => state.now,
      setTimer(fn, delay) { const timer = { at: state.now + delay, fn, off: false }; state.timers.push(timer); return timer; },
      clearTimer(timer) { if (timer) timer.off = true; },
    },
    pending: () => state.timers.filter((x) => !x.off).length,
    async advance(to) {
      for (;;) {
        const due = state.timers.filter((x) => !x.off && x.at <= to).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        state.timers = state.timers.filter((x) => x !== due);
        state.now = Math.max(state.now, due.at);
        due.fn();
        await sleep(40);                    // 発火の後始末（保存・投稿）が済むまで
        // 発火の後始末で次の予約が入るのを待つ。書き込みが 40ms を超えると予約が入る前に続きの advance が空振りし、その時刻の発火が起きない。次の予約を入れない発火（止めた・消した）もあるので上限を付ける
        for (let i = 0; i < 50 && !state.timers.some((x) => !x.off && x.at > due.at); i++) await sleep(20);
      }
      state.now = Math.max(state.now, to);
    },
  };
}

export default async function (t) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'routines-schedule-'));
  const channelServices = [];   // 後片付けで DB の接続（スレッドの状態）を離す
  let n = 0;
  try {
    /** 1 つの世界: 本物のチャンネル・ルーティンのサービス、身代わりの bot・会話・dispatch */
    const world = async ({ start = at(2026, 10, 5, 10, 0, 30), dataDir = path.join(tmp, `w${++n}`), modes = MODES, botMode = 'default' } = {}) => {
      await fs.mkdir(dataDir, { recursive: true });
      const mc = manualClock(start);
      const events = [];
      const botList = [{ id: 'b_owl', name: 'Owl', icon: '🦉', backend: 'fake', mode: botMode, folders: [] }, { id: 'b_agy', name: 'Agy', icon: '🐧', backend: 'agy', mode: 'yolo', folders: [] }];
      const bots = {
        get: async ({ botId }) => botList.find((b) => b.id === botId) ?? null,
        list: async () => botList,
        modesOf: (backend) => (backend === 'agy' ? { yolo: { label: 'yolo', scope: 'full', autonomy: 'never' } } : modes),
        approvalOf: async ({ botId }) => { const b = botList.find((x) => x.id === botId); return b ? { id: b.id, mode: b.mode, label: b.mode, entry: modes[b.mode] } : null; },
        sessions: [],
        async createSession(args) { const sessionId = `sess-${bots.sessions.length + 1}`; bots.sessions.push({ sessionId, ...args }); return { sessionId, backend: 'fake', model: 'm', effort: 'e', cwd: '/', mode: botList.find((b) => b.id === args.botId)?.mode ?? 'default' }; },
      };
      const channels = createChannelService({ dir: path.join(dataDir, 'channels'), emit: (e) => events.push(e), hooks: {}, listBots: async () => botList });
      channelServices.push(channels);
      await channels.start();
      const hostSessions = {};
      const host = {
        currentLocale: () => 'ja',
        getBackend: (id) => (id === 'agy' ? { modes: () => bots.modesOf('agy') } : { modes: () => modes }),
        store: { get: async (id) => hostSessions[id] ?? {}, async setMode(id, mode) { (host.modeSet ??= []).push([id, mode]); } },
        runtime: { turns: new Map() },
        aborts: [],
        async abortSessions(args) { host.aborts.push(args); },
        runs: [],
        async runTurn(args) { host.runs.push(args); return host.outcome ?? 'ok'; },
        async lastReply() { return host.reply ?? null; },
      };
      const wakes = [];
      const dispatch = {
        async wake(args) { wakes.push(args); const sid = (await channels.threads.get(args.channel.id, args.threadId))?.sessions?.[args.botId]; if (sid) host.runtime.turns.set(sid, {}); },
      };
      const service = createRoutineService({ dataDir, channels, bots, dispatch, host, emit: (e) => events.push(e), clock: mc.clock });
      const channel = (await channels.list()).find((c) => c.kind === 'channel' && c.name === 'ops') ?? await channels.create({ name: 'ops' }, { kind: 'human' });
      const dm = await channels.createDm({ bot: botList[0] });
      const roots = async () => (await channels.read({ channelId: channel.id })).posts.filter((p) => p.author.kind === 'routine');
      const threadPosts = async (root) => (await channels.read({ channelId: channel.id, threadId: root.id })).posts;
      /** その実行（根の投稿）の会話のターンを終わらせる */
      const endTurn = async (root, end = { outcome: 'ok', interrupted: null }) => {
        // 根の投稿ができてから、会話をスレッドに登録して bot を起こすまでは少し間がある
        const sessionId = await until(async () => (await channels.threads.get(channel.id, root.id))?.sessions?.b_owl, { label: 'スレッドの会話' });
        host.runtime.turns.delete(sessionId);
        await service.onTurnEnd({ info: { sessionId } }, end);
        return sessionId;
      };
      const stateOf = async (root) => (await channels.getPost({ channelId: channel.id, postId: root.id })).state;
      return { mc, events, bots, channels, host, hostSessions, wakes, service, channel, dm, dataDir, botList, roots, threadPosts, endTurn, stateOf };
    };
    const everyMinute = { kind: 'cron', expr: '* * * * *' };
    const base = (w, over = {}) => ({ name: '毎分のまとめ', botId: 'b_owl', channelId: w.channel.id, prompt: 'まとめて', trigger: everyMinute, ...over });

    // ================================================================ 作る・検査
    {
      const w = await world();
      await w.service.start();
      const bad = async (input, code) => w.service.create(input, { kind: 'human' }).then(() => null, (e) => (e instanceof RoutineError ? e.code : e.message));
      t.ok('create: 存在しない bot は BOT_NOT_FOUND・存在しないチャンネルは CHANNEL_NOT_FOUND', await bad(base(w, { botId: 'b_x' })) === 'BOT_NOT_FOUND' && await bad(base(w, { channelId: 'c_x' })) === 'CHANNEL_NOT_FOUND');
      t.ok('create: DM のチャンネルは INVALID（ルーティンはチャンネルに投稿する）・アーカイブ済みは CHANNEL_ARCHIVED', await bad(base(w, { channelId: w.dm.id })) === 'INVALID'
        && await (async () => { const a = await w.channels.create({ name: 'old' }, { kind: 'human' }); await w.channels.archive({ channelId: a.id, on: true }, { kind: 'human' }); return bad(base(w, { channelId: a.id })); })() === 'CHANNEL_ARCHIVED');
      t.ok('create: 名前が空・複数行・長すぎる、指示が空、トリガが不正、承認の期限が範囲外は INVALID', await bad(base(w, { name: ' ' })) === 'INVALID' && await bad(base(w, { name: 'a\nb' })) === 'INVALID' && await bad(base(w, { name: 'x'.repeat(81) })) === 'INVALID'
        && await bad(base(w, { prompt: '' })) === 'INVALID' && await bad(base(w, { trigger: { kind: 'cron', expr: 'x' } })) === 'INVALID' && await bad(base(w, { approvalTimeoutMin: 0 })) === 'INVALID');
      t.ok('create: bot のバックエンドに無いモードは INVALID', await bad(base(w, { mode: 'nope' })) === 'INVALID');
      const made = await w.service.create(base(w), { kind: 'human' });
      t.ok('create: id は r_・既定のモードは bot の今のモード・承認の期限は 30 分・一時停止でない・次の実行は次の分の頭（nextAt）', made.id.startsWith('r_') && made.mode === 'default' && made.approvalTimeoutMin === 30 && made.paused === false
        && made.nextAt === at(2026, 10, 5, 10, 1) && made.createdBy.kind === 'human' && !made.last, JSON.stringify(made));
      t.ok('create: routinesChanged が出る（nextAt つき）・routines.json に保存される', w.events.some((e) => e.type === 'routinesChanged' && e.routine?.id === made.id && e.routine.nextAt === made.nextAt)
        && JSON.parse(await fs.readFile(path.join(w.dataDir, 'routines.json'), 'utf8')).routines[0].id === made.id);
      const strong = await w.service.create(base(w, { name: '強い', mode: 'bypass' }), { kind: 'agent', sessionId: 's' });
      t.ok('create: モードを指定でき、作った人（createdBy）が残る', strong.mode === 'bypass' && strong.createdBy.kind === 'agent');
      t.ok('create の承認カード用: 弱くないモード（bypass）は loosens・既定の弱いモードは loosens でない', (await w.service.planCreate(base(w, { mode: 'bypass' }))).loosens === true && (await w.service.planCreate(base(w))).loosens === false);
      w.service.stop();
    }

    // ================================================================ 毎分の発火・実行の状態
    {
      const w = await world();
      await w.service.start();
      const r = await w.service.create(base(w, { name: '毎分のまとめ', prompt: 'まとめて' }), { kind: 'human' });
      t.ok('予約: 作っただけでは動かない（次の分の頭まで）', (await w.roots()).length === 0 && w.mc.pending() === 1);
      await w.mc.advance(at(2026, 10, 5, 10, 1));
      // 根の投稿は会話を作って bot を起こす前に書かれる。起こし（wake）まで待ってから確かめる
      const root1 = (await until(async () => (w.wakes.length >= 1 ? (await w.roots())[0] : null), { label: '1 回目の根の投稿と起こし' }));
      const posts1 = await w.roots();
      t.ok('発火: 根の投稿は author.kind: routine・本文は名前と指示・state working・routine { routineId, runId }（missed でない）', posts1.length === 1 && root1.author.routineId === r.id && root1.text === '毎分のまとめ\nまとめて' && root1.state === 'working'
        && root1.routine.routineId === r.id && /^run_/.test(root1.routine.runId) && !root1.routine.missed && root1.threadId === null, JSON.stringify(root1));
      t.ok('発火: bot のそのスレッドの会話（kind: routine・routineId・根の投稿のスレッド）を作り、承認モードはルーティンの mode、スレッドに登録して bot を起こす',
        w.bots.sessions.length === 1 && w.bots.sessions[0].kind === 'routine' && w.bots.sessions[0].routineId === r.id && w.bots.sessions[0].threadId === root1.id
        && (await w.channels.threads.get(w.channel.id, root1.id)).sessions.b_owl === 'sess-1' && w.wakes.length === 1 && w.wakes[0].threadId === root1.id && w.wakes[0].botId === 'b_owl' && w.wakes[0].post.id === root1.id);
      const got1 = await w.service.get({ routineId: r.id });
      t.ok('発火: last は working・次の実行は次の分（走り終えるのを待たずに予約し直す）', got1.last.state === 'working' && got1.last.runId === root1.routine.runId && got1.last.postId === root1.id && got1.last.at === at(2026, 10, 5, 10, 1) && got1.nextAt === at(2026, 10, 5, 10, 2), JSON.stringify(got1));
      await w.endTurn(root1);
      t.ok('終わり: ok なら根の投稿は done（緑の「成功」ではなく「終了」）・last も done', await until(async () => (await w.stateOf(root1)) === 'done', { label: 'done' }) && (await w.service.get({ routineId: r.id })).last.state === 'done');
      await w.mc.advance(at(2026, 10, 5, 10, 2));
      const two = await until(async () => ((await w.roots()).length === 2 && w.wakes.length >= 2 ? await w.roots() : null), { label: '2 回目' });
      t.ok('次の分でもう 1 回: 実行ごとに新しいスレッド（根の投稿が増える）・新しい会話', two[0].id !== two[1].id && w.bots.sessions.length === 2 && w.bots.sessions[1].threadId === two[1].id);
      // 走っている間に来た発火（3 分目）はスキップ。スキップの投稿は 1 つの走っている間に 1 回だけ
      await w.mc.advance(at(2026, 10, 5, 10, 3));
      const three = await until(async () => ((await w.roots()).length === 3 ? await w.roots() : null), { label: 'スキップの投稿' });
      t.ok('走っている間の発火は「スキップ（previousRunning）」の根の投稿・会話は作らない・bot も起こさない', three[2].state === 'skipped' && three[2].routine.reason === 'previousRunning' && w.bots.sessions.length === 2 && w.wakes.length === 2);
      await w.mc.advance(at(2026, 10, 5, 10, 4));
      await sleep(80);
      t.ok('スキップの投稿は走っている間に 1 回だけ（毎分のルーティンが遅い実行を待つたびに並べない）・last は走っている実行のまま', (await w.roots()).length === 3 && (await w.service.get({ routineId: r.id })).last.runId === two[1].routine.runId);
      await w.endTurn(two[1], { outcome: 'ok', interrupted: null });
      await until(async () => (await w.stateOf(two[1])) === 'done', { label: '2 回目 done' });
      await w.mc.advance(at(2026, 10, 5, 10, 5));
      await until(async () => (await w.roots()).length === 4 && w.wakes.length >= 3, { label: '走り終えた後はまた動く' });
      t.ok('走り終えた後の発火は、また走る（4 つ目のスレッドと会話）', w.bots.sessions.length === 3);

      w.service.stop();
    }

    // 状態の決まり方（実行を 1 つずつ作って終わらせる。手で走らせる。間は一時停止にして予約が重ならないようにする）
    {
      const w = await world();
      await w.service.start();
      const r = await w.service.create(base(w, { name: '状態', trigger: { kind: 'daily', at: '09:00', weekdaysOnly: false } }), { kind: 'human' });
      const one = async (end, prep) => {
        const before = (await w.roots()).length;
        const started = await w.service.run({ routineId: r.id }, { kind: 'human' });
        const roots = await until(async () => { const x = await w.roots(); return x.length === before + 1 ? x : null; }, { label: '手の実行' });
        const root = roots.find((x) => x.id === started.postId);
        if (prep) await prep(root);
        await w.endTurn(root, end);
        return until(async () => { const s = await w.stateOf(root); return s !== 'working' ? s : null; }, { label: '終わりの状態' });
      };
      t.ok('状態: ok は done', await one({ outcome: 'ok', interrupted: null }) === 'done');
      t.ok('状態: bot が thread に state: checking の投稿を付けて終われば checking（要確認）', await one({ outcome: 'ok', interrupted: null }, (root) => w.channels.post({ channelId: w.channel.id, threadId: root.id, text: '数字が合わない', state: 'checking' }, { kind: 'bot', botId: 'b_owl' })) === 'checking');
      t.ok('状態: 失敗（error）は failed', await one({ outcome: 'error', interrupted: null }) === 'failed');
      t.ok('状態: 人が止めた・更新のため止まった（interrupted: user・update）は stopped', await one({ outcome: 'aborted', interrupted: { at: 1, reason: 'user' } }) === 'stopped' && await one({ outcome: 'aborted', interrupted: { at: 1, reason: 'update' } }) === 'stopped');
      t.ok('状態: 使用量の上限（limited・interrupted: limit）は failed', await one({ outcome: 'limited', interrupted: { at: 1, reason: 'limit' } }) === 'failed');
      t.ok('手の実行（routines.run）は予約とは別: 毎日 9:00 の予約は 1 つのまま・last は最後の実行', w.mc.pending() === 1 && (await w.service.get({ routineId: r.id })).last.state === 'failed');
      // 一時停止中でも手では走らせられる
      await w.service.pause({ routineId: r.id });
      const paused = await w.service.run({ routineId: r.id }, { kind: 'human' });
      t.ok('一時停止中でも手では走らせられる（run は予約と別）', paused.state === 'working' && paused.postId);
      w.service.stop();
    }

    // ================================================================ スキップの理由・実行を始められない
    {
      const w = await world();
      await w.service.start();
      const r = await w.service.create(base(w, { name: 'スキップ', trigger: { kind: 'daily', at: '09:00', weekdaysOnly: false } }), { kind: 'human' });
      w.botList.splice(0, 1);          // bot が消えた
      const gone = await w.service.run({ routineId: r.id }, { kind: 'human' });
      const root = (await w.roots())[0];
      t.ok('bot が居なければ「スキップ（botMissing）」の根の投稿・会話は作らない・last も skipped', gone.state === 'skipped' && gone.reason === 'botMissing' && root.state === 'skipped' && root.routine.reason === 'botMissing' && w.bots.sessions.length === 0
        && (await w.service.get({ routineId: r.id })).last.state === 'skipped');
      w.botList.unshift({ id: 'b_owl', name: 'Owl', icon: '🦉', backend: 'fake', mode: 'default', folders: [] });
      await w.channels.archive({ channelId: w.channel.id, on: true }, { kind: 'human' });
      const arch = await w.service.run({ routineId: r.id }, { kind: 'human' });
      t.ok('チャンネルがアーカイブされていれば投稿できないので、投稿なしで last だけ skipped（reason は channelArchived）', arch.state === 'skipped' && arch.reason === 'channelArchived' && arch.postId === null && (await w.roots()).length === 1);
      await w.channels.archive({ channelId: w.channel.id, on: false }, { kind: 'human' });
      // 会話を作れなかった: 根の投稿は failed・スレッドに理由
      const w2 = await world();
      await w2.service.start();
      const r2 = await w2.service.create(base(w2, { name: '失敗', trigger: { kind: 'daily', at: '09:00', weekdaysOnly: false } }), { kind: 'human' });
      w2.bots.createSession = async () => { throw new Error('backend is off'); };
      await w2.service.run({ routineId: r2.id }, { kind: 'human' });
      const failed = await until(async () => { const x = (await w2.roots())[0]; return x?.state === 'failed' ? x : null; }, { label: '会話を作れない' });
      t.ok('会話を作れなかったら根の投稿は failed・スレッドに理由・次の実行を妨げない', (await w2.threadPosts(failed)).some((p) => p.author.kind === 'system' && p.text.includes('backend is off')) && !w2.service.isRunning(r2.id));
      // 起こしたのにターンが走り始めない: 一定時間後に failed
      const w3 = await world();
      await w3.service.start();
      const r3 = await w3.service.create(base(w3, { name: '始まらない', trigger: { kind: 'daily', at: '09:00', weekdaysOnly: false } }), { kind: 'human' });
      w3.wakes.length = 0;
      await w3.service.run({ routineId: r3.id }, { kind: 'human' });
      const root3 = (await w3.roots())[0];
      w3.host.runtime.turns.clear();   // ターンは走り始めなかった
      await w3.mc.advance(w3.mc.state.now + START_GRACE_MS + 1000);
      t.ok(`bot を起こしてから ${START_GRACE_MS / 1000} 秒たってもターンが走っていなければ、根の投稿を failed にして終える（作業中のまま残さない）`, await until(async () => (await w3.stateOf(root3)) === 'failed', { label: '始まらない' }) && !w3.service.isRunning(r3.id));
      w.service.stop(); w2.service.stop(); w3.service.stop();
    }

    // ================================================================ 一時停止・再開（止めていた間の予定は数えない）・トリガを変える・消す
    {
      const w = await world();
      await w.service.start();
      const r = await w.service.create(base(w), { kind: 'human' });
      await w.service.pause({ routineId: r.id });
      const got = await w.service.get({ routineId: r.id });
      t.ok('pause: 予約が外れ（nextAt は null）、動かない', got.paused === true && got.nextAt === null && w.mc.pending() === 0);
      await w.mc.advance(at(2026, 10, 5, 10, 30));
      t.ok('pause: 時間がたっても根の投稿は立たない', (await w.roots()).length === 0);
      await w.service.resume({ routineId: r.id });
      const resumed = await w.service.get({ routineId: r.id });
      t.ok('resume: 再開した時刻から数え直す（止めていた間の分は走らせず、次の分から）', resumed.paused === false && resumed.nextAt === at(2026, 10, 5, 10, 31) && (await w.roots()).length === 0);
      await w.service.remove({ routineId: r.id });
      t.ok('remove: 消すと予約も外れ、routinesChanged { removed }・実行の履歴のスレッドは残る', w.mc.pending() === 0 && w.events.some((e) => e.type === 'routinesChanged' && e.removed === r.id) && (await w.service.list()).length === 0);
      t.ok('消えたルーティンの操作は ROUTINE_NOT_FOUND', await w.service.pause({ routineId: r.id }).then(() => null, (e) => e.code) === 'ROUTINE_NOT_FOUND' && await w.service.get({ routineId: r.id }) === null);
      w.service.stop();
    }

    // ================================================================ 取りこぼし: 起動時に最新の 1 回だけ
    {
      const dataDir = path.join(tmp, 'missed');
      const w = await world({ dataDir });
      await w.service.start();
      const every = await w.service.create(base(w, { name: '毎分' }), { kind: 'human' });
      const daily = await w.service.create(base(w, { name: '毎日', trigger: { kind: 'daily', at: '09:00', weekdaysOnly: false } }), { kind: 'human' });
      const pausedOne = await w.service.create(base(w, { name: '停止中', paused: true }), { kind: 'human' });
      const ev = await w.service.create(base(w, { name: '出来事', trigger: { kind: 'event', on: 'failed', scope: 'all' } }), { kind: 'human' });
      w.service.stop();
      // 10 分後（Pleiad が止まっていた間に毎分の予定が 9 回、毎日 9:00 の予定は無い）に立ち上げ直す
      const w2 = await world({ dataDir, start: at(2026, 10, 5, 10, 10, 10) });
      await w2.service.start();
      const roots = await until(async () => { const x = await w2.roots(); return x.length ? x : null; }, { label: '取りこぼしの 1 回' });
      await sleep(150);
      const after = await w2.roots();
      t.ok('起動時、止まっていた間の予定が何回あっても、最新の 1 回だけ走らせる（毎分のルーティンが 9 回ぶんではなく 1 回）', after.length === 1 && roots[0].text.startsWith('毎分\n'), JSON.stringify(after.map((p) => p.text)));
      t.ok('取りこぼしの実行は根の投稿に routine.missed: true', after[0].routine.missed === true && after[0].routine.routineId === every.id);
      t.ok('まだ予定の来ていない毎日 9:00・一時停止・出来事のルーティンは走らせない', !after.some((p) => /^(毎日|停止中|出来事)/.test(p.text)));
      const got = await w2.service.get({ routineId: every.id });
      t.ok('取りこぼしの後は予約が普通に続く（次は 10:11）', got.nextAt === at(2026, 10, 5, 10, 11) && got.last.at === at(2026, 10, 5, 10, 10, 10));
      await w2.mc.advance(at(2026, 10, 5, 10, 11));
      await until(async () => (await w2.roots()).length >= 2, { ms: 15_000, label: '10:11 のスキップの投稿' });
      t.ok('次の分は普通の実行（missed でない）。走っている間なのでスキップの投稿', (await w2.roots()).length === 2 && (await w2.roots())[1].routine.missed !== true);
      // 取りこぼしの判定は「最後に動いた後」: last.at が新しければ走らせない
      w2.service.stop();
      const w3 = await world({ dataDir, start: at(2026, 10, 5, 10, 10, 40) });
      await w3.service.start();
      await sleep(150);
      t.ok('last.at の後に予定が無ければ（再起動を急いだ）取りこぼしの実行は無い', (await w3.roots()).length === 2);
      w3.service.stop();
      // 止めていた間に動いていた分は、再開した時刻から数える
      const w4 = await world({ dataDir: path.join(tmp, 'missed-paused'), start: at(2026, 10, 5, 8, 0) });
      await w4.service.start();
      const p = await w4.service.create(base(w4, { name: '再開', trigger: { kind: 'daily', at: '09:00', weekdaysOnly: false } }), { kind: 'human' });
      await w4.service.pause({ routineId: p.id });
      w4.service.stop();
      const w5 = await world({ dataDir: path.join(tmp, 'missed-paused'), start: at(2026, 10, 7, 12, 0) });
      await w5.service.start();
      await sleep(150);
      t.ok('一時停止のルーティンは、止めていた間の予定があっても起動時に走らせない', (await w5.roots()).length === 0);
      await w5.service.resume({ routineId: p.id });
      await sleep(100);
      t.ok('再開した直後も、止めていた間の分は走らせない（次は翌日 9:00）', (await w5.roots()).length === 0 && (await w5.service.get({ routineId: p.id })).nextAt === at(2026, 10, 8, 9));
      w5.service.stop();
      void [daily, pausedOne, ev];
    }

    // ================================================================ 終わりが記録されなかった実行（Pleiad が止まった）は stopped
    {
      const dataDir = path.join(tmp, 'lost');
      const w = await world({ dataDir });
      await w.service.start();
      const r = await w.service.create(base(w, { name: '途中', trigger: { kind: 'daily', at: '09:00', weekdaysOnly: false } }), { kind: 'human' });
      await w.service.run({ routineId: r.id }, { kind: 'human' });
      const root = (await w.roots())[0];
      w.service.stop();     // 終わりを記録せずに止まった
      const w2 = await world({ dataDir });
      await w2.service.start();
      await until(async () => (await w2.stateOf(root)) === 'stopped', { label: '起動時に stopped' });
      t.ok('起動時、作業中のまま残った実行の根の投稿を stopped にし、last も stopped にする（作業中のまま残さない）', (await w2.service.get({ routineId: r.id })).last.state === 'stopped');
      w2.service.stop();
    }

    // ================================================================ 承認待ちの期限
    {
      const w = await world();
      await w.service.start();
      const r = await w.service.create(base(w, { name: '承認', approvalTimeoutMin: 5, trigger: { kind: 'daily', at: '09:00', weekdaysOnly: false } }), { kind: 'human' });
      await w.service.run({ routineId: r.id }, { kind: 'human' });
      const root = (await w.roots())[0];
      const sessionId = (await w.channels.threads.get(w.channel.id, root.id)).sessions.b_owl;
      w.service.onPermission({ id: 'card-1', sessionId, kind: 'tool', toolName: 'Bash' }, 'open');
      await w.mc.advance(w.mc.state.now + 4 * MIN);
      t.ok('承認待ちの期限の前（4 分）は何もしない', w.host.aborts.length === 0);
      w.service.onPermission({ id: 'card-1', sessionId }, 'settled');
      await w.mc.advance(w.mc.state.now + 4 * MIN);
      t.ok('期限の前に決着したら、期限が来ても止めない（タイマーを外す）', w.host.aborts.length === 0);
      w.service.onPermission({ id: 'card-2', sessionId, kind: 'tool', toolName: 'Bash' }, 'open');
      await w.mc.advance(w.mc.state.now + 5 * MIN + 1);
      await until(async () => w.host.aborts.length === 1, { label: '期限で止める' });
      t.ok('承認が approvalTimeoutMin を過ぎたら、その会話のターンを理由 timeout で止める', w.host.aborts[0].sessionId === sessionId && w.host.aborts[0].reason === 'timeout');
      const posts = await w.threadPosts(root);
      t.ok('スレッドに「承認が無かったので取り消しました」を残す（システムの投稿）', posts.some((p) => p.author.kind === 'system' && p.text === '承認が無かったので取り消しました'), JSON.stringify(posts.map((p) => p.text)));
      await w.endTurn(root, { outcome: 'aborted', interrupted: { at: 1, reason: 'timeout' } });
      t.ok('止めた後の根の投稿は failed（取り消した実行を「終了」と見せない）', await until(async () => (await w.stateOf(root)) === 'failed', { label: '期限の後の状態' }));
      // bot の会話でない承認は期限の対象外
      w.service.onPermission({ id: 'card-3', sessionId: 'sess-chat', kind: 'tool' }, 'open');
      await w.mc.advance(w.mc.state.now + 60 * MIN);
      t.ok('実行の会話でない承認（Chats の会話）は、期限で止めない', w.host.aborts.length === 1);
      w.service.stop();
    }

    // ================================================================ イベントのトリガ
    {
      const w = await world();
      await w.service.start();
      const onFail = await w.service.create(base(w, { name: '失敗の調査', trigger: { kind: 'event', on: 'failed', scope: 'all' } }), { kind: 'human' });
      const onDone = await w.service.create(base(w, { name: '完了のまとめ', trigger: { kind: 'event', on: 'done', scope: { sessionIds: ['s_only'] } } }), { kind: 'human' });
      const onWait = await w.service.create(base(w, { name: '待ちの知らせ', trigger: { kind: 'event', on: 'waiting', scope: 'all' } }), { kind: 'human' });
      const paused = await w.service.create(base(w, { name: '停止の調査', trigger: { kind: 'event', on: 'failed', scope: 'all' }, paused: true }), { kind: 'human' });
      t.ok('出来事のトリガは時刻で動かない（予約は無く、nextAt は null）', w.mc.pending() === 0 && (await w.service.get({ routineId: onFail.id })).nextAt === null);
      w.hostSessions.s_chat = { title: 'ビルドの会話' };
      w.hostSessions.s_only = { title: '対象の会話' };
      w.hostSessions.s_bot = { title: '🦉 Owl', bot: { botId: 'b_owl', kind: 'thread' } };
      w.hostSessions.s_routine = { title: 'ルーティンの会話', bot: { botId: 'b_owl', kind: 'routine', routineId: onFail.id } };
      w.hostSessions.s_child = { title: '子', delegation: { parent: 's_chat' } };
      w.service.onSessionDone('s_chat', 'error');
      const first = await until(async () => { const x = await w.roots(); return x.length ? x : null; }, { label: '失敗の出来事' });
      await sleep(100);
      t.ok('会話の失敗（error）で on: failed のルーティンだけが走る（all は全部・一時停止は走らない）', (await w.roots()).length === 1 && first[0].text.startsWith('失敗の調査\n'));
      t.ok('根の投稿に、きっかけの会話の題と出来事が書かれる', first[0].text.includes('ビルドの会話') && first[0].text.includes('失敗'), first[0].text);
      await w.endTurn(first[0]);
      w.service.onSessionDone('s_chat', 'ok');
      await sleep(100);
      t.ok('完了（ok）の出来事は scope に入っていない会話では走らない（on: done は s_only だけ）', (await w.roots()).length === 1);
      w.service.onSessionDone('s_only', 'ok');
      await until(async () => (await w.roots()).length === 2, { label: 'scope の会話の完了' });
      t.ok('scope の sessionIds に入っている会話の完了では走る', (await w.roots())[1].text.startsWith('完了のまとめ\n'));
      await w.endTurn((await w.roots())[1]);
      const countBefore = (await w.roots()).length;
      w.service.onSessionDone('s_bot', 'error');
      w.service.onSessionDone('s_routine', 'error');
      w.service.onSessionDone('s_child', 'error');
      w.service.onPermission({ id: 'c-bot', sessionId: 's_bot', kind: 'tool' }, 'open');
      await sleep(150);
      t.ok('bot・ルーティンの会話・委譲の子から来た出来事は対象にしない（自分の実行の失敗で自分が動く輪を作らない）', (await w.roots()).length === countBefore);
      w.service.onPermission({ id: 'c-chat', sessionId: 's_chat', kind: 'tool', toolName: 'Bash' }, 'open');
      await until(async () => (await w.roots()).length === countBefore + 1, { label: 'あなた待ち' });
      t.ok('あなた待ち（承認を開いた）で on: waiting のルーティンが走る', (await w.roots()).at(-1).text.startsWith('待ちの知らせ\n'));
      w.service.onPermission({ id: 'c-chat', sessionId: 's_chat' }, 'settled');
      await sleep(100);
      t.ok('決着（settled）では走らない', (await w.roots()).length === countBefore + 1);
      void [onDone, onWait, paused];
      w.service.stop();
    }

    // ================================================================ 試しの実行
    {
      const w = await world();
      await w.service.start();
      const r = await w.service.create(base(w, { name: '試し', trigger: { kind: 'daily', at: '09:00', weekdaysOnly: false } }), { kind: 'human' });
      w.host.reply = '\n集計しました。\n詳細は省略';
      const out = await w.service.run({ routineId: r.id, dryRun: true }, { kind: 'human' });
      t.ok('dryRun: チャンネルへ投稿せず（根の投稿・スレッドが立たない）・last も変えない', (await w.roots()).length === 0 && out.postId === null && out.dryRun === true && !(await w.service.get({ routineId: r.id })).last);
      t.ok('dryRun: 使い捨ての会話を計画（読み取り）のモードで走らせる（承認モードは plan・routineId つき・スレッドなし）', out.mode === 'plan' && w.host.modeSet.some(([id, mode]) => id === out.sessionId && mode === 'plan')
        && w.bots.sessions.at(-1).kind === 'routine' && w.bots.sessions.at(-1).threadId === null && w.bots.sessions.at(-1).routineId === r.id);
      t.ok('dryRun: 試しの指示は「投稿しない」の一文＋ルーティンの指示で、内部のターンとして走る', w.host.runs[0].sessionId === out.sessionId && w.host.runs[0].prompt.includes('まとめて') && w.host.runs[0].prompt.includes('投稿せず'));
      t.ok('dryRun: 走り終えるまで待ち、state（done）と summary（返事の最初の空でない 1 行）を返す', out.state === 'done' && out.summary === '集計しました。', JSON.stringify(out));
      w.host.outcome = 'error';
      t.ok('dryRun: ターンが失敗で終われば state は failed', (await w.service.run({ routineId: r.id, dryRun: true }, { kind: 'human' })).state === 'failed');
      w.host.outcome = 'aborted';
      t.ok('dryRun: 止められたら stopped', (await w.service.run({ routineId: r.id, dryRun: true }, { kind: 'human' })).state === 'stopped');
      w.host.outcome = 'ok';
      const realRunTurn = w.host.runTurn;
      w.host.runTurn = async () => { throw new Error('boom'); };
      const thrown = await w.service.run({ routineId: r.id, dryRun: true }, { kind: 'human' });
      t.ok('dryRun: 始められなかったら failed と理由（summary）', thrown.state === 'failed' && thrown.summary === 'boom');
      w.host.runTurn = realRunTurn;
      // 試しの実行の会話でも、実行の記録（根の投稿・last）には何も触れない。承認待ちには本番と同じ期限が付く
      let release;
      w.host.runTurn = (args) => { w.host.runs.push(args); return new Promise((resolve) => { release = resolve; }); };
      w.host.abortSessions = async () => { release('aborted'); };
      const ranBefore = w.host.runs.length;
      const pending = w.service.run({ routineId: r.id, dryRun: true }, { kind: 'human' });
      const sessionId = await until(async () => (w.host.runs.length > ranBefore ? w.host.runs.at(-1).sessionId : null), { label: '試しのターン' });
      w.service.onPermission({ id: 'dry-card', sessionId, kind: 'tool', toolName: 'Bash' }, 'open');
      await w.mc.advance(w.mc.state.now + (DRY_RUN_APPROVAL_MAX_MIN - 1) * MIN);
      t.ok(`dryRun: 承認待ちの期限は本番より短く（最大 ${DRY_RUN_APPROVAL_MAX_MIN} 分）、その前は止めない`, (w.host.aborts ?? []).length === 0);
      await w.mc.advance(w.mc.state.now + 2 * MIN);
      const timedOut = await pending;
      t.ok('dryRun: 承認が期限（approvalTimeoutMin。最大 5 分）を過ぎたらターンを止め、failed と「承認が無かったので取り消しました」を返す（根の投稿は無い）', timedOut.state === 'failed' && timedOut.summary === '承認が無かったので取り消しました' && (await w.roots()).length === 0);
      w.host.runTurn = (args) => { w.host.runs.push(args); return new Promise(() => {}); };
      const ranBefore2 = w.host.runs.length;
      const capped = w.service.run({ routineId: r.id, dryRun: true }, { kind: 'human' });
      await until(async () => w.host.runs.length > ranBefore2, { label: '試しのターン（上限）' });
      await w.mc.advance(w.mc.state.now + DRY_RUN_WAIT_MS + 1000);
      const cappedOut = await capped;
      t.ok(`dryRun: 走り終えるのを ${DRY_RUN_WAIT_MS / MIN} 分までしか待たず、過ぎたら state: working と「まだ走っています」で返す`, cappedOut.state === 'working' && cappedOut.summary.includes('走っています'), JSON.stringify(cappedOut));
      // 計画のモードを持たないバックエンド
      const agy = await w.service.create(base(w, { name: 'agy', botId: 'b_agy', trigger: { kind: 'daily', at: '09:00', weekdaysOnly: false } }), { kind: 'human' });
      t.ok('計画のモードを持たないバックエンド（Antigravity は yolo だけ）の試しは INVALID（安全に試せない）', await w.service.run({ routineId: agy.id, dryRun: true }, { kind: 'human' }).then(() => null, (e) => e.code) === 'INVALID');
      w.service.stop();
    }

    // ================================================================ 広げる向きの判定（planUpdate）
    {
      const w = await world();
      await w.service.start();
      const daily = await w.service.create(base(w, { name: '毎日', trigger: { kind: 'daily', at: '09:00', weekdaysOnly: false } }), { kind: 'human' });
      const plan = (patch, id = daily.id) => w.service.planUpdate({ routineId: id, ...patch });
      t.ok('更新: 頻度を上げる（毎日 → 毎時の cron）は広げる向き（frequency）', (await plan({ trigger: { kind: 'cron', expr: '0 * * * *' } })).reasons.includes('frequency'));
      t.ok('更新: 頻度を下げる（毎日 → 週 2 回）・同じ頻度で時刻だけ変える・名前だけは広げる向きではない', !(await plan({ trigger: { kind: 'weekly', days: [1, 4], at: '09:00' } })).loosens && !(await plan({ trigger: { kind: 'daily', at: '21:00', weekdaysOnly: false } })).loosens && !(await plan({ name: '新しい名前' })).loosens);
      t.ok('更新: 平日だけ → 毎日は頻度が上がる（週 5 → 7）', (await plan({ trigger: { kind: 'daily', at: '09:00', weekdaysOnly: false } }, (await w.service.create(base(w, { name: '平日', trigger: { kind: 'daily', at: '09:00', weekdaysOnly: true } }), { kind: 'human' })).id)).loosens);
      t.ok('更新: モードを強くする（default → bypass）は広げる向き（mode）・弱くする（→ plan）はそうでない', (await plan({ mode: 'bypass' })).reasons.includes('mode') && !(await plan({ mode: 'plan' })).loosens);
      t.ok('更新: 同じ強さの別のモード（auto: 範囲は同じで自律が上）は強い向き', (await plan({ mode: 'auto' })).reasons.includes('mode'));
      t.ok('更新: そのバックエンドに無いモードは INVALID', await plan({ mode: 'nope' }).then(() => null, (e) => e.code) === 'INVALID');
      t.ok('更新: 時刻のトリガから出来事に変えるのは頻度の上限が無くなるので広げる向き', (await plan({ trigger: { kind: 'event', on: 'failed', scope: 'all' } })).reasons.includes('frequency'));
      const ev = await w.service.create(base(w, { name: '出来事', trigger: { kind: 'event', on: 'failed', scope: { sessionIds: ['a'] } } }), { kind: 'human' });
      t.ok('更新: 対象を広げる（sessionIds → all・sessionIds に足す）は広げる向き（scope）・狭める（→ 減らす）・on を変えるだけは違う', (await plan({ trigger: { kind: 'event', on: 'failed', scope: 'all' } }, ev.id)).reasons.includes('scope')
        && (await plan({ trigger: { kind: 'event', on: 'failed', scope: { sessionIds: ['a', 'b'] } } }, ev.id)).reasons.includes('scope')
        && !(await plan({ trigger: { kind: 'event', on: 'failed', scope: { sessionIds: ['a'] } } }, ev.id)).loosens && !(await plan({ trigger: { kind: 'event', on: 'done', scope: { sessionIds: ['a'] } } }, ev.id)).loosens);
      t.ok('更新: 出来事（all）→ 出来事（sessionIds）は狭める向き', !(await plan({ trigger: { kind: 'event', on: 'failed', scope: { sessionIds: ['x'] } } }, (await w.service.create(base(w, { name: '全部', trigger: { kind: 'event', on: 'failed', scope: 'all' } }), { kind: 'human' })).id)).loosens);
      const changed = await w.service.update({ routineId: daily.id, trigger: { kind: 'daily', at: '21:00', weekdaysOnly: false }, name: '夜のまとめ', prompt: '夜にまとめて' }, { kind: 'human' });
      t.ok('update: 保存され、トリガを変えたら基準を今にし直す（次は今夜 21:00）。routinesChanged が出る', changed.name === '夜のまとめ' && changed.prompt === '夜にまとめて' && changed.trigger.at === '21:00' && changed.nextAt === at(2026, 10, 5, 21) && changed.armedAt === at(2026, 10, 5, 10, 0, 30));
      t.ok('update: 何も変わらない更新は何も書かない（rows が空）', (await plan({ name: '夜のまとめ' })).rows.length === 0);
      t.ok('update: bot を替えてモードがそのバックエンドに無ければ、新しい bot のモードにそろえる', (await w.service.update({ routineId: daily.id, botId: 'b_agy' }, { kind: 'human' })).mode === 'yolo');
      w.service.stop();
    }

    // ================================================================ 保存（routines.json）
    {
      const file = path.join(tmp, 'store', 'routines.json');
      const store = createRoutineStore({ file });
      await store.load();
      const routine = { id: 'r_000000000aaaaaa', name: 'x', botId: 'b_1', channelId: 'c_1', prompt: 'p', trigger: { kind: 'daily', at: '09:00', weekdaysOnly: false }, mode: 'default', approvalTimeoutMin: 30, paused: false, createdBy: { kind: 'human' }, createdAt: 1, armedAt: 2, last: { at: 3, runId: 'run_1', state: 'done', postId: 'p_1' } };
      await store.put(routine);
      const again = createRoutineStore({ file });
      await again.load();
      t.ok('保存: routines.json（version 1）に書かれ、読み直しても同じ（armedAt・last.postId も）', JSON.parse(await fs.readFile(file, 'utf8')).version === 1 && JSON.stringify(again.get(routine.id)) === JSON.stringify(routine));
      t.ok('保存: update の fn が null を返したら書かずに今の値を返す', JSON.stringify(await again.update(routine.id, () => null)) === JSON.stringify(routine));
      t.ok('保存: 知らない id の update は ROUTINE_NOT_FOUND', await again.update('r_none', (r) => r).then(() => null, (e) => (e instanceof RoutineStoreError ? e.code : e.message)) === 'ROUTINE_NOT_FOUND');
      t.ok('整える: 必須の欄が足りない・トリガが読めない行は読み込まない（null）', normalizeRoutine({ ...routine, botId: '' }) === null && normalizeRoutine({ ...routine, trigger: { kind: 'x' } }) === null && normalizeRoutine({ ...routine, name: '' }) === null && normalizeRoutine({ ...routine, prompt: ' ' }) === null);
      t.ok('整える: 承認の期限が不正なら既定の 30 分・paused は真偽・last の state が不明なら stopped', normalizeRoutine({ ...routine, approvalTimeoutMin: 0 }).approvalTimeoutMin === 30 && normalizeRoutine({ ...routine, paused: 'yes' }).paused === false
        && normalizeRoutine({ ...routine, last: { at: 1, runId: 'r', state: 'weird' } }).last.state === 'stopped');
      const broken = path.join(tmp, 'store-broken');
      await fs.mkdir(broken, { recursive: true });
      await fs.writeFile(path.join(broken, 'routines.json'), '{ nope');
      const bs = createRoutineStore({ file: path.join(broken, 'routines.json') });
      t.ok('壊れた routines.json は読み込まず、上書きもしない（ROUTINES_CORRUPT）', await bs.load().then(() => null, (e) => e.code) === 'ROUTINES_CORRUPT'
        && await bs.put(routine).then(() => null, (e) => e.code) === 'ROUTINES_CORRUPT' && (await fs.readFile(path.join(broken, 'routines.json'), 'utf8')) === '{ nope');
      const future = path.join(tmp, 'store-future');
      await fs.mkdir(future, { recursive: true });
      await fs.writeFile(path.join(future, 'routines.json'), JSON.stringify({ version: 2, routines: [] }));
      t.ok('読めない版は読み込まない（ROUTINES_UNSUPPORTED_VERSION）', await createRoutineStore({ file: path.join(future, 'routines.json') }).load().then(() => null, (e) => e.code) === 'ROUTINES_UNSUPPORTED_VERSION');
      // サービスは壊れた保存でも立ち上がり（ルーティンは止まる）、上書きしない
      const dataDir = path.join(tmp, 'service-broken');
      await fs.mkdir(dataDir, { recursive: true });
      await fs.writeFile(path.join(dataDir, 'routines.json'), '{ nope');
      const w = await world({ dataDir });
      await w.service.start();
      t.ok('壊れた保存でもサービスは立ち上がる（ルーティンは止まり、ファイルは上書きしない）', (await w.service.list()).length === 0 && (await fs.readFile(path.join(dataDir, 'routines.json'), 'utf8')) === '{ nope'
        && await w.service.create(base(w), { kind: 'human' }).then(() => null, (e) => e.code) === 'ROUTINES_CORRUPT');
      w.service.stop();
    }
  } finally {
    for (const channels of channelServices) await channels.close();
    await fs.rm(tmp, { recursive: true, force: true });
  }
}
