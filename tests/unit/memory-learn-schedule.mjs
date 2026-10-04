// 夜の整理の走り方（ADR 0118）: ほかの会話のターンが走っていても走る・走っている会話は次の回へ・飛ばした回数と理由・失敗の後の間隔・
// 対象を絞った実行・種類と重みを記憶へ渡す・memory.learnStatus の形。
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { backend as fake } from '../../core/backends/fake.mjs';
import { createChannelService } from '../../core/channels/service.mjs';
import { createMemoryService } from '../../core/memory/service.mjs';
import { createMemoryLearner } from '../../core/memory/learn.mjs';
import { openReadOnly } from '../../core/db.mjs';

export const name = 'memory-learn-schedule';
export const title = '夜の整理: ほかのターンで止まらない・走っている会話は次へ・飛ばした回数と理由・失敗の間隔・種類と重み';

const MIN = 60_000;
const DAY = 86_400_000;

export default async function (t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-learn-schedule-'));
  const keepAlive = setInterval(() => {}, 1000);
  try {
    let at = new Date(2026, 9, 4, 3, 0).getTime();   // 現地時刻 03:00（その日の 02:00 の予定を過ぎている）
    const timers = [];
    const clock = { now: () => at, setTimer: (fn) => { timers.push(fn); return fn; }, clearTimer: () => {} };
    const side = new Map();
    const channels = createChannelService({ dir: path.join(dir, 'channels') });
    await channels.start();
    const memory = createMemoryService({ dataDir: dir, channels, now: () => at });
    await memory.start();
    const runFake = async (id, prompt) => fake.runTurn({ sessionId: id, prompt, cwd: dir, mode: 'default', model: '',
      emit: () => {}, onPromptDelivered: () => {}, askPermission: async () => ({ allow: true }) });
    const chat = async (text) => {
      const id = `fake-${crypto.randomUUID()}`;
      await runFake(id, text);
      side.set(id, { backend: 'fake', lastModified: at });
      return id;
    };
    const busy = new Set();
    const host = {
      // 以前の判定が見ていた「全部の走っているターン」。ここに別の会話のターンがあっても走ることを確かめる
      runtime: { turns: new Map([['someone-else', {}]]) },
      sessionBusy: (id) => busy.has(id),
      store: { getAll: async () => Object.fromEntries(side), get: async (id) => side.get(id) ?? {} },
      getBackend: (id) => (id === 'fake' ? fake : null),
      listBackends: () => [fake],
    };
    let prefs = { backend: 'fake' };
    let failNext = false;
    let asks = 0;
    let asked = [];   // 学習の呼び出しに渡った人の発言の本文（呼び出しごと）
    // 学習の会話の代わり: 「覚えて」の発言を候補にし、「やめて」があれば種類 stop、なければ pref。重みは 3
    const ask = async (prompt) => {
      asks++;
      if (failNext) { failNext = false; throw new Error('backend is down'); }
      const line = prompt.split('\n').find((part) => part.startsWith('Human statements: '));
      const statements = JSON.parse(line.slice('Human statements: '.length));
      asked.push(statements.map((item) => item.text));
      return JSON.stringify({ memories: statements.flatMap((item) => {
        const m = /^覚えて[:：]\s*(.{8,300})/u.exec(item.text.trim());
        return m ? [{ action: 'add', layer: 'user', text: m[1], kind: /やめて/.test(m[1]) ? 'stop' : 'pref', weight: 3, sourceIndexes: [item.index] }] : [];
      }) });
    };
    const learner = createMemoryLearner({ dataDir: dir, channels, bots: { get: async () => null }, memory, host, clock, now: () => at,
      readPrefs: async () => prefs, readMessages: async (id) => fake.getMessages(id), ask,
      // fake の一覧はこのプロセスのほかのテストの会話も返すので、この試しの会話だけにする
      listSessions: async () => [...side].map(([id, meta]) => ({ id, ...meta })) });

    // ---- ほかの会話のターンが走っていても、予定の回は走る（以前は全部のターンが 0 になるまで待ち、ずっと走れなかった）
    const quiet = await chat('覚えて: 報告は表と箇条書きで構造的にまとめる');
    const running = await chat('覚えて: 走っている会話のこの発言は次の回に読む');
    busy.add(running);
    const first = await learner.runIfDue();
    t.ok('ほかの会話のターンが走っていても走る', first.read === 1 && first.changed === 1, JSON.stringify(first));
    t.ok('走っているターンの会話は読まずに次の回へ回す', first.deferred === 1 && !(await memory.list({ layer: 'user' })).some((e) => e.text.includes('次の回に読む')));
    const learned = (await memory.list({ layer: 'user' })).find((e) => e.text.includes('構造的に'));
    t.ok('学習の候補の種類・重みが記憶に入る（「覚えて」は強い合図なので重み 3 のまま）', learned.kind === 'pref' && learned.weight === 3 && learned.strength === 3);
    t.ok('同じ日にもう一度は走らない', (await learner.runIfDue()).skipped === 'notDue');
    let status = await learner.status();
    t.ok('様子: 最後に走った時刻・結果・次の予定（翌日 02:00）', status.lastRunAt === at && status.lastResult.read === 1 && status.lastResult.deferred === 1
      && status.skip === null && status.failure === null && status.nextAt === new Date(2026, 9, 5, 2, 0).getTime() && status.at === '02:00' && status.paused === false, JSON.stringify(status));
    const reader = openReadOnly(dir);
    const row = reader.prepare("SELECT value FROM memory_state WHERE kind = 'meta' AND id = 'status'").get();
    reader.close();
    t.ok('様子は DB の memory_state の 1 行（meta / status）', row && JSON.parse(row.value).lastResult.changed === 1);

    // ---- 止めている間は、予定の回ごとに 1 回だけ数える（毎分の確かめで数えない）
    busy.clear();
    side.set(running, { ...side.get(running), lastModified: at + MIN });
    at += DAY;
    prefs = { ...prefs, memoryLearnPaused: true };
    t.ok('止めている間は走らない（理由 paused）', (await learner.runIfDue()).skipped === 'paused');
    at += MIN;
    await learner.runIfDue();
    t.ok('同じ予定の回は 1 回と数える', (await learner.status()).skip.count === 1 && (await learner.status()).skip.reason === 'paused');
    at += DAY;
    await learner.runIfDue();
    status = await learner.status();
    t.ok('次の日の予定も飛ばすと 2 回', status.skip.count === 2 && status.nextAt === null && status.paused === true, JSON.stringify(status));

    // ---- 失敗したら間隔を空けて試し直す（毎分モデルを呼ばない）。成功で印を消す
    prefs = { backend: 'fake' };
    await chat('覚えて: 失敗の後でもこの発言を忘れずに覚える');
    failNext = true;
    const before = asks;
    let error = null;
    try { await learner.runIfDue(); } catch (e) { error = e; }
    status = await learner.status();
    t.ok('失敗は様子に残る（理由の文・回数・次に試す時刻 15 分後）', error && status.failure.message === 'backend is down' && status.failure.count === 1 && status.failure.retryAt === at + 15 * MIN, JSON.stringify(status));
    at += MIN;
    t.ok('間隔の間は試さない（理由 failed）', (await learner.runIfDue()).skipped === 'failed' && asks === before + 1);
    at += 15 * MIN;
    const retried = await learner.runIfDue();
    status = await learner.status();
    t.ok('間隔の後に試し直し、成功で失敗と飛ばした印を消す', retried.changed >= 2 && status.failure === null && status.skip === null, JSON.stringify(retried));
    t.ok('前の回に回した会話の発言も読む', (await memory.list({ layer: 'user' })).some((e) => e.text.includes('次の回に読む')));

    // ---- 対象を絞った実行（スレッドが静かになった後の整理の土台）。予定の回には数えない
    const lastRunAt = learner.state().lastRunAt;
    at += 5 * MIN;
    const target = await chat('覚えて: 絞った実行ではこの会話だけを読む');
    await chat('覚えて: 絞った実行では読まれない会話の発言。金曜のデプロイはやめて');
    const scoped = await learner.runNow({ scope: { sessionIds: [target] } });
    const texts = (await memory.list({ layer: 'user' })).map((e) => e.text);
    t.ok('scope の会話だけを読む', scoped.read === 1 && texts.some((x) => x.includes('この会話だけ')) && !texts.some((x) => x.includes('読まれない')));
    t.ok('絞った実行は lastRunAt を進めない（予定の回は別）', learner.state().lastRunAt === lastRunAt && (await learner.status()).lastResult.scoped === true);
    const rest = await learner.runNow();
    t.ok('予定の回では残りを読む', rest.read === 1 && (await memory.list({ layer: 'user' })).some((e) => e.text.includes('読まれない')));
    const stop = (await memory.list({ layer: 'user' })).find((e) => e.text.includes('読まれない'));
    t.ok('やめたことは種類 stop・強さ 3', stop.kind === 'stop' && stop.strength === 3);
    t.ok('タイマーは毎分の確かめに使うだけ（start しない限り積まれない）', timers.length === 0);
    learner.close();
    memory.stop();
    await channels.close();

    // ---- 読む量の上限: 最後まで読んだ会話は読み直さない・読む範囲より古い発言は読まない・1 回の呼び出しに 40 件、1 回の実行は 5 回（200 件）まで（ADR 0127）
    const dir2 = path.join(dir, 'limits');
    const channels2 = createChannelService({ dir: path.join(dir2, 'channels') });
    await channels2.start();
    const memory2 = createMemoryService({ dataDir: dir2, channels: channels2, now: () => at });
    await memory2.start();
    const convs = new Map();   // id → { meta, messages }
    const said = (n, when) => ({ role: 'user', uuid: `u-${n}`, text: `覚えて: 合成の発言 ${n} 番目のメモです`, at: when });
    convs.set('syn-many', { meta: { backend: 'fake', lastModified: at }, messages: Array.from({ length: 230 }, (_, n) => said(n, at - MIN)) });
    convs.set('syn-old', { meta: { backend: 'fake', lastModified: at - 20 * DAY }, messages: [said('old', at - 20 * DAY)] });
    convs.set('syn-mixed', { meta: { backend: 'fake', lastModified: at }, messages: [said('mixed-old', at - 20 * DAY), said('mixed-new', at - MIN)] });
    let reads = [];
    const host2 = { ...host, store: { getAll: async () => Object.fromEntries([...convs].map(([id, c]) => [id, c.meta])), get: async (id) => convs.get(id)?.meta ?? {} } };
    const learner2 = createMemoryLearner({ dataDir: dir2, channels: channels2, bots: { get: async () => null }, memory: memory2, host: host2, clock, now: () => at,
      readPrefs: async () => ({ backend: 'fake' }), ask,
      readMessages: async (id) => { reads.push(id); return structuredClone(convs.get(id)?.messages ?? []); },
      listSessions: async () => [...convs].map(([id, c]) => ({ id, ...c.meta })) });
    asked = [];
    const capped = await learner2.runNow();
    t.ok('1 回に読むのは 200 件まで。残りがあることを結果に残す', capped.read === 200 && capped.more === true && (await learner2.status()).lastResult.more === true, JSON.stringify(capped));
    t.ok('ADR 0127: 200 件を 40 件ずつ 5 回の呼び出しで渡す（以前は 5 件ずつ 40 回で、呼び出しのたびに隠れた会話と通知ができた）', asked.length === 5 && asked.every((list) => list.length === 40), asked.map((l) => l.length).join());
    t.ok('ADR 0127: 1 回の呼び出しで共通層へ書けるのは 20 件まで（40 件の発言から 20 件。5 件の上限は夜の整理では呼び出しの候補の数に置き換わる）', capped.changed === 100, JSON.stringify(capped));
    const texts2 = () => memory2.list({ layer: 'user' }).then((list) => list.map((e) => e.text).join('\n'));
    t.ok('読む範囲より古い会話は読まない（最初の回は 3 日）', !reads.includes('syn-old') && !(await texts2()).includes('old 番目'));
    asked = [];
    const restRun = await learner2.runNow();
    const restTexts = asked.flat().join('\n');
    t.ok('残りは次の回にカーソルから読む（範囲より古い発言は渡さない）', restRun.read === 31 && !restRun.more && asked.length === 1 && (await memory2.list({ layer: 'user' })).length === 120
      && restTexts.includes('mixed-new') && !restTexts.includes('mixed-old') && !(await texts2()).includes('mixed-old'), JSON.stringify(restRun));
    reads = [];
    const idle = await learner2.runNow();
    t.ok('最後まで読んで変わっていない会話は読み直さない（古い会話も読まない）', idle.read === 0 && reads.length === 0, reads.join());
    convs.get('syn-mixed').messages.push(said('mixed-later', at));
    convs.get('syn-mixed').meta.lastModified = at + MIN;
    reads = [];
    const later = await learner2.runNow();
    t.ok('更新された会話だけを読み、続きの発言だけを渡す（読むのは出どころの確かめを含めてその会話だけ）', later.read === 1 && reads.length > 0 && reads.every((id) => id === 'syn-mixed')
      && (await texts2()).includes('mixed-later'), `${reads.join()} ${JSON.stringify(later)}`);
    learner2.close();
    memory2.stop();
    await channels2.close();
  } finally {
    clearInterval(keepAlive);
    await fs.rm(dir, { recursive: true, force: true });
  }
}
