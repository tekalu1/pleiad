// bot の予約（ADR 0140）をサーバー越しに。fake バックエンドの bot が自分で ply_control の brain.wakeAdd を呼び、
// テストの時計（tests/lib/routines-clock-loader.mjs）を進めると、bot のターンが走っていなくても、予約した会話（スレッド）で起きて話す。
// Pleiad を止めている間に過ぎた予約は、起動後に 1 回だけ遅れて起きる（同じ会話の分は 1 回にまとめる）。LLM もネットワークも使わない。
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { startServer, ROOT } from '../lib/server.mjs';
import { open, sleep } from '../lib/ws-client.mjs';

export const name = 'brain-wakes-server';
export const title = 'bot の予約をサーバー越しに: bot が brain.wakeAdd で予約・時刻にスレッドで起きる・止めていた間の予約は起動後に 1 回・一覧と取り消し';

const MIN = 60_000;
const until = async (fn, { ms = 20_000, label = '' } = {}) => {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) { last = await fn(); if (last) return last; await sleep(40); }
  throw new Error(`timeout: ${label} ${JSON.stringify(last ?? null)?.slice(0, 600)}`);
};

export default async function (t) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'brain-wakes-server-'));
  const servers = [], clients = [];
  try {
    const dataDir = path.join(tmp, 'data');
    const clockFile = path.join(tmp, 'clock');
    const T0 = new Date(2026, 9, 5, 4, 50, 0).getTime();
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
    const dev = await call('channels.create', { name: 'dev', members: [owl.id] });
    const thread = async (rootId) => (await call('channels.read', { channelId: dev.id, threadId: rootId, limit: 100 })).posts;
    const botPosts = async (rootId) => (await thread(rootId)).filter((p) => p.author.kind === 'bot' && p.state !== 'working');
    const op = (id, args) => ({ name: 'call_op', arguments: { op: id, args } });

    // ---- bot が自分で予約する（ply_control の call_op。読み取りのモードの bot でも通る）
    const ask = await call('channels.post', { channelId: dev.id, text: `@Owl control:${JSON.stringify(op('brain.wakeAdd', { inMin: 30, note: 'echo:CI の結果を確かめました' }))}` });
    const made = await until(async () => (await botPosts(ask.id))[0], { label: '予約の返事' });
    const wake = JSON.parse(made.text);
    t.ok('bot は自分の会話から brain.wakeAdd で予約できる（行き先はこのスレッド。時刻は今から 30 分後）', /^w[0-9a-f]{8}$/.test(wake.id) && wake.status === 'pending' && wake.threadId === ask.id && wake.channelId === dev.id && wake.at === T0 + 30 * MIN, made.text);
    const listed = await call('brain.wakeList', { botId: owl.id });
    t.ok('予約は一覧に出る（人の画面からも bot の id で読める）', listed.wakes.length === 1 && listed.wakes[0].id === wake.id && listed.wakes[0].note.includes('CI の結果'));
    const sessionId = (await call('channels.read', { channelId: dev.id, threadId: ask.id })).threads[0].sessions[owl.id];
    const noConv = await call('brain.wakeAdd', { inMin: 10, note: 'x' }).then(() => null, (e) => e.code);
    t.ok('bot の会話でない主体（人の画面）からは作れない（WAKE_CONVERSATION）', noConv === 'WAKE_CONVERSATION');

    // ---- 時刻の前は起きない。時刻が来たら、ターンが走っていなくてもスレッドで起きる
    await setClock(T0 + 29 * MIN);
    await sleep(400);
    t.ok('時刻の前は起きない', (await botPosts(ask.id)).length === 1);
    await setClock(T0 + 30 * MIN + 5_000);
    const woke = await until(async () => (await botPosts(ask.id)).find((p) => p.text === 'CI の結果を確かめました' && p.state === 'done'), { label: '予約で起きた返事' });
    t.ok('予約の時刻に、予約したスレッドで起きて話す（予約のメモを持って）', woke.threadId === ask.id);
    const history = (await c.cmd('loadSession', { sessionId })).messages;
    const note = history.find((m) => m.kind === 'contextNote' && m.tag === 'inner' && m.innerKind === 'wake');
    t.ok('bot の会話の履歴に「予約した時刻に起きました」の行（<pleiad-inner kind="wake">）が残る', Boolean(note) && note.body.includes('予約した時刻になったので起きました') && note.body.includes('CI の結果'), JSON.stringify(history.filter((m) => m.role === 'system').map((m) => [m.kind, m.tag, m.innerKind])));
    t.ok('起きた予約は fired になり、待っている一覧から消える', (await call('brain.wakeList', { botId: owl.id })).wakes.length === 0 && (await call('brain.wakeList', { botId: owl.id, all: true })).wakes[0].status === 'fired');

    // ---- 夜のあいだ Pleiad が止まっていた: 3 件の予約は、起動後に 1 回だけ遅れて起きる
    const t1 = T0 + 40 * MIN;
    await setClock(t1);
    const night = await call('channels.post', { channelId: dev.id, text: `@Owl control:${JSON.stringify([
      op('brain.wakeAdd', { inMin: 33, note: 'echo:5:23 の見回り' }), op('brain.wakeAdd', { inMin: 57, note: 'echo:5:47 の見回り' }), op('brain.wakeAdd', { inMin: 107, note: 'echo:6:37 の見回り' }),
      op('brain.wakeAdd', { inMin: 600, note: 'echo:まだ先' })])}` });
    const madeNight = await until(async () => (await botPosts(night.id))[0], { label: '夜の予約の返事' });
    const ids = madeNight.text.split('\n').map((line) => JSON.parse(line).id);
    t.ok('1 ターンで 4 件を予約できる', ids.length === 4 && ids.every((id) => /^w[0-9a-f]{8}$/.test(id)), madeNight.text);
    c.close?.();
    await server.stop();
    await setClock(t1 + 3 * 60 * MIN);   // 3 時間止まっていた
    ({ server, c, call } = await boot());
    const late = await until(async () => (await botPosts(night.id)).find((p) => p.text === '5:23 の見回り' && p.state === 'done'), { label: '起動後の遅れた 1 回' });
    await sleep(1500);
    const after = await botPosts(night.id);
    t.ok('止まっていた間に過ぎた同じスレッドの 3 件は、起動後に 1 回だけ起きる（何回も重ねない）', Boolean(late) && after.length === 2, JSON.stringify(after.map((p) => p.text)));
    const all = (await call('brain.wakeList', { botId: owl.id, all: true })).wakes;
    t.ok('3 件とも fired・late の印。まだ先の予約は待ったまま', ids.slice(0, 3).every((id) => all.find((w) => w.id === id)?.status === 'fired' && all.find((w) => w.id === id)?.late === true)
      && all.find((w) => w.id === ids[3])?.status === 'pending', JSON.stringify(all.map((w) => [w.id, w.status, w.late])));

    // ---- 取り消し（人の画面から。bot の会話からも同じ操作）
    const cancelled = await call('brain.wakeCancel', { botId: owl.id, id: ids[3] });
    t.ok('待っている予約は取り消せる', cancelled.status === 'cancelled' && (await call('brain.wakeList', { botId: owl.id })).wakes.length === 0);
    const again = await call('brain.wakeCancel', { botId: owl.id, id: ids[3] }).then(() => null, (e) => e.code);
    t.ok('取り消した・起きた予約はもう取り消せない（WAKE_NOT_FOUND）', again === 'WAKE_NOT_FOUND');
  } finally {
    for (const c of clients) c.close?.();
    for (const s of servers) await s.stop().catch(() => {});
    await fs.rm(tmp, { recursive: true, force: true, maxRetries: 5 });
  }
}
