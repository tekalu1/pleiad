// ルーティンをサーバー越しに確かめる（fake バックエンド。LLM もネットワークも使わない）。ルーティンの時計だけをファイルで進む時計に差し替える
// （tests/lib/routines-clock-loader.mjs。NODE_OPTIONS=--loader）:
//   「毎分」のルーティンの実行のスレッドが立つ（根の投稿 = routine・bot のそのスレッドの会話・状態 done）→ 一時停止と再開 →
//   Pleiad が止まっていた間の取りこぼしは起動時に 1 回だけ（根の投稿に routine.missed）→ イベントのトリガ（会話の失敗で動き、bot の会話の失敗では動かない）→
//   承認待ちの期限（過ぎたらターンを止め、スレッドに報告）→ 試しの実行（投稿しない）。
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { startServer, ROOT } from '../lib/server.mjs';
import { open, sleep } from '../lib/ws-client.mjs';

export const name = 'routines-server';
export const title = 'ルーティン（サーバー越し）: 毎分の実行のスレッド・取りこぼしは起動時に 1 回・一時停止と再開・イベントのトリガ・承認の期限・試しの実行';

const MIN = 60_000;
const until = async (fn, { ms = 20_000, label = '' } = {}) => {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) { last = await fn(); if (last) return last; await sleep(40); }
  throw new Error(`timeout: ${label} ${JSON.stringify(last ?? null)?.slice(0, 600)}`);
};

export default async function (t) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'routines-server-'));
  const servers = [], clients = [];
  try {
    const dataDir = path.join(tmp, 'data');
    const clockFile = path.join(tmp, 'clock');
    const T0 = Math.floor(Date.now() / MIN) * MIN + 30_000;     // 分の途中（30 秒）から始める
    const setClock = (ms) => fs.writeFile(clockFile, String(ms));
    await setClock(T0);
    const env = {
      AGENT_HOST_BACKENDS: 'fake', TEST_ROUTINES_CLOCK: clockFile,
      NODE_OPTIONS: `--loader="${pathToFileURL(path.join(ROOT, 'tests/lib/routines-clock-loader.mjs')).href}"`,
    };
    const boot = async () => {
      const server = await startServer({ env, dataDir, timeoutMs: 60_000 });
      const c = await open({ port: server.port, token: server.token });
      servers.push(server); clients.push(c);
      return { server, c, call: (op, args) => c.cmd('invoke', { op, args }) };
    };
    let { server, c, call } = await boot();

    const owl = await call('bots.create', { name: 'Owl', icon: '🦉', backend: 'fake' });
    const ops = await call('channels.create', { name: 'ops' });
    const read = (threadId) => call('channels.read', { channelId: ops.id, ...(threadId ? { threadId } : {}) });
    const roots = async (routineId) => (await read()).posts.filter((p) => p.author.kind === 'routine' && (!routineId || p.author.routineId === routineId));
    const settled = async (root, state = 'done') => until(async () => { const p = (await roots()).find((x) => x.id === root.id); return p?.state === state ? p : null; }, { label: `根の投稿が ${state}` });

    // ---- 毎分のルーティン（名前は fake の台本。echo: で始めると、実行の本文がそのまま返事になる）
    const every = await call('routines.create', { name: 'echo:毎分', botId: owl.id, channelId: ops.id, prompt: '集計して', trigger: { kind: 'cron', expr: '* * * * *' } });
    t.ok('作ると次の実行は次の分の頭（nextAt）・routinesChanged が全接続に届く', every.nextAt === T0 + 30_000 && c.events.some((e) => e.type === 'routinesChanged' && e.routine?.id === every.id && e.routine.nextAt === every.nextAt && !e.sessionId), JSON.stringify(every));
    await sleep(300);
    t.ok('時計が進むまでは動かない', (await roots()).length === 0);

    await setClock(T0 + 30_000);
    const first = await until(async () => (await roots(every.id))[0] ?? null, { label: '1 回目の根の投稿' });
    const done1 = await settled(first);
    const thread1 = (await read(first.id)).threads[0];
    t.ok('毎分のルーティン: 時計が次の分に着くと、根の投稿（author.kind: routine・本文は名前と指示・routine { routineId, runId }）が立つ', first.author.routineId === every.id && first.text === 'echo:毎分\n集計して' && first.routine.routineId === every.id
      && /^run_/.test(first.routine.runId) && !first.routine.missed && first.threadId === null, JSON.stringify(first));
    const thread1Posts = (await read(first.id)).posts;
    const botPost1 = thread1Posts.find((p) => p.turn?.botId === owl.id);
    t.ok('そのスレッドで bot が走り、返事がスレッドの投稿になる（実行の履歴 = スレッドの並び）。根の投稿は done（終了）', done1.state === 'done' && botPost1?.state === 'done' && botPost1.text.includes('毎分') && botPost1.threadId === first.id, JSON.stringify(thread1Posts.map((p) => [p.author.kind, p.state, p.text.slice(0, 20)])));
    const sessionId1 = thread1.sessions[owl.id];
    const row1 = (await c.cmd('listSessions')).find((s) => s.id === sessionId1);
    t.ok('実行の会話は bot の会話（kind: routine・根の投稿のスレッド・題「🦉 Owl · #ops › …」）で、承認モードはルーティンの mode', row1?.bot?.kind === 'routine' && row1.bot.threadId === first.id && row1.bot.channelId === ops.id && row1.bot.botId === owl.id
      && row1.title.startsWith('🦉 Owl · #ops › '), JSON.stringify(row1));
    const got1 = await call('routines.get', { routineId: every.id });
    t.ok('last は done・次の実行は次の分（nextAt）・routinesChanged で状態の変化が届く', got1.last.state === 'done' && got1.last.runId === first.routine.runId && got1.last.postId === first.id && got1.nextAt === T0 + 90_000
      && c.events.some((e) => e.type === 'routinesChanged' && e.routine?.id === every.id && e.routine.last?.state === 'done'), JSON.stringify(got1));

    await setClock(T0 + 90_000);
    const second = await until(async () => (await roots(every.id))[1] ?? null, { label: '2 回目の根の投稿' });
    await settled(second);
    const allRoots = await roots(every.id);
    t.ok('次の分でもう 1 回: 実行ごとに新しいスレッドと新しい会話・どちらも done', allRoots.length === 2 && allRoots.every((p) => p.state === 'done') && (await read(second.id)).threads[0].sessions[owl.id] !== sessionId1);

    // ---- 一時停止と再開
    await call('routines.pause', { routineId: every.id });
    await setClock(T0 + 5 * MIN);
    await sleep(400);
    t.ok('一時停止中は時計が進んでも動かない（nextAt は null）', (await roots(every.id)).length === 2 && (await call('routines.get', { routineId: every.id })).nextAt === null);
    await setClock(T0 + 6 * MIN);
    const resumeAsk = await call('routines.resume', { routineId: every.id });
    t.ok('再開（人は承認なし）。止めていた間の分は走らせず、再開した時刻から数え直す（次は次の分）', resumeAsk.paused === false && resumeAsk.nextAt === T0 + 6 * MIN + 30_000 && (await roots(every.id)).length === 2, JSON.stringify(resumeAsk));

    // ---- 取りこぼし: Pleiad が止まっていた間の分は、起動時に最新の 1 回だけ
    c.close();
    await server.stop();
    const beforeMissed = 2;
    await setClock(T0 + 20 * MIN + 10_000);                           // 止まっている間に 14 分すぎた
    ({ server, c, call } = await boot());
    const missed = await until(async () => { const r = await roots(every.id); return r.length > beforeMissed ? r : null; }, { label: '取りこぼしの 1 回' });
    await sleep(1500);
    const afterMissed = await roots(every.id);
    t.ok('起動時、止まっていた間の予定が十数回あっても、最新の 1 回だけ走る（根の投稿が 1 つ増えるだけ）', missed.length === beforeMissed + 1 && afterMissed.length === beforeMissed + 1, String(afterMissed.length));
    const missedRoot = afterMissed.at(-1);
    t.ok('取りこぼしの根の投稿は routine.missed: true（「Pleiad が止まっていた間の分」）・走って done になる', missedRoot.routine.missed === true && (await settled(missedRoot)).state === 'done');
    await setClock(T0 + 21 * MIN + 30_000);
    const normal = await until(async () => { const r = await roots(every.id); return r.length === beforeMissed + 2 ? r.at(-1) : null; }, { label: '取りこぼしの後の普通の実行' });
    t.ok('取りこぼしの後は普通の予約に戻る（次の分に missed なしで走る）', !normal.routine.missed);
    await settled(normal);
    await call('routines.pause', { routineId: every.id });

    // ---- イベントのトリガ: 会話の失敗で動く。bot の会話（ルーティンの実行を含む）の失敗では動かない
    const onFail = await call('routines.create', { name: 'fail', botId: owl.id, channelId: ops.id, prompt: '調べて', trigger: { kind: 'event', on: 'failed', scope: 'all' } });
    t.ok('出来事のトリガは時計で動かない（nextAt は null）', onFail.nextAt === null);
    const chat = await c.runTurn({ prompt: 'fail', sessionId: null, cwd: ROOT, backend: 'fake', mode: 'default' }, { ms: 20_000 });
    const evRoot = await until(async () => (await roots(onFail.id))[0] ?? null, { label: '会話の失敗で動く' });
    t.ok('Chats の会話が失敗すると、on: failed のルーティンが走る（根の投稿にきっかけの出来事が書かれる）', chat.outcome === 'error' && evRoot.text.startsWith('fail\n調べて') && evRoot.text.includes('失敗'), evRoot.text);
    await settled(evRoot, 'failed');          // ルーティン自身の台本も fail なので、実行は failed で終わる
    await sleep(1200);
    t.ok('ルーティンの実行（bot の会話）が失敗しても、自分の出来事では動かない（輪にならない）・走るのは 1 回だけ', (await roots(onFail.id)).length === 1 && evRoot.state !== undefined);
    await call('routines.pause', { routineId: onFail.id });

    // ---- 承認待ちの期限: 過ぎたらターンを止め、スレッドに報告する
    const asky = await call('routines.create', { name: 'ask-slow', botId: owl.id, channelId: ops.id, prompt: '書いて', trigger: { kind: 'daily', at: '03:00', weekdaysOnly: false }, approvalTimeoutMin: 2 });
    const mAsk = c.mark();
    const ranAsk = await call('routines.run', { routineId: asky.id });
    const card = await c.waitFor((e) => e.type === 'permission' && e.sessionId, { from: mAsk, ms: 20_000 });
    const askRoot = (await roots(asky.id))[0];
    const waiting = await until(async () => { const th = (await read(askRoot.id)).threads[0]; return th.state === 'waiting' ? th : null; }, { label: '承認待ち' });
    t.ok('実行が承認で止まる（スレッドは waiting・承認カードは普通の承認と同じ resolvePermission）', ranAsk.postId === askRoot.id && waiting.sessions[owl.id] === card.sessionId);
    await setClock(T0 + 21 * MIN + 30_000 + MIN);          // 1 分たった（期限の 2 分には届かない）
    await sleep(500);
    t.ok('期限（2 分）の前は取り消さない', (await roots(asky.id))[0].state !== 'failed' && !(await read(askRoot.id)).posts.some((p) => p.author.kind === 'system'));
    await setClock(T0 + 21 * MIN + 30_000 + 2 * MIN + 1_000);
    const timedOut = await settled(askRoot, 'failed');
    const reported = (await read(askRoot.id)).posts;
    t.ok('承認が期限を過ぎたら、ターンを止めてスレッドに「承認が無かったので取り消しました」を残す・根の投稿は failed', timedOut.state === 'failed' && reported.some((p) => p.author.kind === 'system' && p.text === '承認が無かったので取り消しました'), JSON.stringify(reported.map((p) => [p.author.kind, p.state, p.text.slice(0, 30)])));
    const ended = await until(async () => c.since(mAsk).find((e) => e.type === 'turnEnd' && e.sessionId === card.sessionId), { label: 'ターンの終わり' });
    t.ok('止めたターンは中断（理由 timeout）として残る', ended.interrupted?.reason === 'timeout' && ended.outcome === 'aborted', JSON.stringify(ended));
    t.ok('承認カードは片付く（running の承認待ちに残らない）', !(await c.cmd('running')).permissions.some((p) => p.sessionId === card.sessionId));

    // ---- 試しの実行（dryRun）: 計画のモードの使い捨ての会話で走り、チャンネルへは投稿しない
    const trial = await call('routines.create', { name: 'echo:試し', botId: owl.id, channelId: ops.id, prompt: '集計して', trigger: { kind: 'daily', at: '03:00', weekdaysOnly: false } });
    const postsBefore = (await read()).posts.length;
    const mDry = c.mark();
    const dry = await call('routines.run', { routineId: trial.id, dryRun: true });      // 走り終えるまで待って返る
    t.ok('試しの実行は走り終えてから、state（done）と summary（返事の最初の 1 行）で返る', dry.state === 'done' && typeof dry.summary === 'string' && dry.summary.length > 0 && c.since(mDry).some((e) => e.type === 'turnEnd' && e.sessionId === dry.sessionId), JSON.stringify(dry));
    await sleep(300);
    const dryRow = (await c.cmd('listSessions')).find((s) => s.id === dry.sessionId);
    t.ok('試しの実行は根の投稿もスレッドも立てず、チャンネルへ投稿しない（last も変えない）', dry.postId === null && dry.dryRun === true && (await read()).posts.length === postsBefore && !(await call('routines.get', { routineId: trial.id })).last, JSON.stringify(dry));
    t.ok('使い捨ての会話は計画（plan）のモード・bot の会話（kind: routine）で、試しの一文と指示を受け取って走った', dry.mode === 'plan' && dryRow?.bot?.kind === 'routine' && !dryRow.bot.threadId
      && JSON.stringify((await c.cmd('loadSession', { sessionId: dry.sessionId })).messages).includes('集計して'), JSON.stringify(dryRow));

    // ---- 消す: 実行の履歴のスレッドは残る
    const sizeBefore = (await roots()).length;
    await call('routines.delete', { routineId: every.id });
    t.ok('ルーティンを消しても、実行の履歴（根の投稿のスレッド）は残る', (await roots()).length === sizeBefore && (await call('routines.list', {})).routines.every((r) => r.id !== every.id));
  } finally {
    for (const c of clients) c.close();
    for (const s of servers) await s.stop().catch(() => {});
    await fs.rm(tmp, { recursive: true, force: true });
  }
}
