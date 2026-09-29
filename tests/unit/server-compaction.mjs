import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { startServer, ROOT } from '../lib/server.mjs';
import { open, sleep } from '../lib/ws-client.mjs';

export const name = 'server-compaction';
export const title = '圧縮コマンド・設定・記録・予約の保存と復元をサーバー経由で確かめる';
const ply = (name, args) => 'ply:' + JSON.stringify({ name, arguments: args });
// 依頼元 parent の委譲タスクのうち fn を満たすものが現れるまで待つ
async function pollTask(c, parent, fn, ms = 30_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const found = (await c.cmd('agentTasks')).find(row => row.parentSessionId === parent && fn(row));
    if (found) return found;
    await sleep(50);
  }
  throw new Error('委譲タスクが条件を満たさなかった');
}

export default async function (t) {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-compact-'));
  const server = await startServer({ dataDir: path.join(scratch, 'data'),
    env: { AGENT_HOST_BACKENDS: 'fake' }, timeoutMs: 30_000 });
  const c = await open({ port: server.port, token: server.token, autoAllow: true });
  try {
    const initial = await c.runTurn({ prompt: 'echo:first', sessionId: null, cwd: ROOT, backend: 'fake', mode: 'default' }, { ms: 20_000 });
    const id = initial.sessionId;
    await c.waitFor(e => e.type === 'compactionSchedule' && e.sessionId === id && e.at > Date.now(), { ms: 2000 }).catch(() => {});
    t.ok('通常ターンで文脈量と自動圧縮の予定が届く', c.events.some(e => e.type === 'contextWindow' && e.sessionId === id && e.usedTokens === 164000)
      && c.events.some(e => e.type === 'compactionSchedule' && e.sessionId === id && e.at > Date.now()));
    const from = c.mark();
    const result = await c.cmd('compactConversation', { sessionId: id });
    const completed = await c.waitFor(e => e.type === 'compaction' && e.sessionId === id && e.phase === 'complete', { from, ms: 20_000 });
    // 完了はターンの途中で出る。後始末（保存）が終わって turnEnd が出るまで会話は準備中の印が付いたままで、次の runTurn は断られる
    await c.waitFor(e => e.type === 'turnEnd' && e.sessionId === id, { from, ms: 20_000 });
    t.ok('手動コマンドは要約と前後量を持つ完了を返す', result.status === 'started'
      && completed.trigger === 'manual' && completed.beforeTokens === 164000 && completed.afterTokens === 21000
      && Boolean(completed.summary));
    const opened = await c.cmd('loadSession', { sessionId: id });
    t.ok('開き直した履歴に区切りと文脈量が残る', opened.compactions?.some(x => x.phase === 'complete' && x.summary)
      && opened.contextWindow?.usedTokens === 21000);
    const toggled = await c.cmd('setConversationAutoCompaction', { sessionId: id, off: true });
    t.ok('会話ごとの自動圧縮停止を保存する', toggled.off && (await c.cmd('loadSession', { sessionId: id })).autoCompactionOff);
    const settings = await c.cmd('setAutoCompaction', { settings: { enabled: false, minTokens: 60000,
      claude: { enabled: true, delayMinutes: 15 }, codex: { enabled: false, delayMinutes: 50 } } });
    t.ok('全体設定が保存される', !settings.enabled && (await c.cmd('prefs')).autoCompaction.minTokens === 60000);
    const from2 = c.mark();
    await new Promise(r => setTimeout(r, 50));
    await c.runTurn({ prompt: 'echo:second', sessionId: id, cwd: ROOT, backend: 'fake', mode: 'default' }, { ms: 20_000 });
    t.ok('設定で切った後はタイマーを仕掛けない', !c.since(from2).some(e => e.type === 'compactionSchedule' && e.at));
    const row = (await c.cmd('listSessions')).find(x => x.id === id);
    t.ok('次の送信で圧縮済みの印が消える', row?.compacted === false);
    await c.cmd('setConversationAutoCompaction', { sessionId: id, off: false });
    await c.cmd('setAutoCompaction', { settings: { enabled: true, minTokens: 1000,
      claude: { enabled: true, delayMinutes: 50 }, codex: { enabled: false, delayMinutes: 50 } } });
    const autoFrom = c.mark();
    await c.runTurn({ prompt: 'compact', sessionId: id, cwd: ROOT, backend: 'fake', mode: 'default' }, { ms: 20_000 });
    await new Promise(r => setTimeout(r, 30));
    t.ok('バックエンドが自動圧縮したターンの後は予約し直さない', c.since(autoFrom).some(e => e.type === 'compaction' && e.phase === 'complete')
      && !c.since(autoFrom).some(e => e.type === 'compactionSchedule' && e.at));
    const failFrom = c.mark();
    await c.runTurn({ prompt: 'compact-fail', sessionId: id, cwd: ROOT, backend: 'fake', mode: 'default' }, { ms: 20_000 });
    await new Promise(r => setTimeout(r, 30));
    t.ok('圧縮の失敗後も自動予約を繰り返さない', c.since(failFrom).some(e => e.type === 'compaction' && e.phase === 'failed')
      && !c.since(failFrom).some(e => e.type === 'compactionSchedule' && e.at));
  } finally {
    c.close();
    await server.stop();
    await fs.rm(scratch, { recursive: true, force: true });
  }

  // 委譲の完了通知で始まったターン（internal）の後にも予約する。委譲の子の会話には置かない（ADR 0067）
  const noticeScratch = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-compact-notice-'));
  const noticeServer = await startServer({ dataDir: path.join(noticeScratch, 'data'),
    env: { AGENT_HOST_BACKENDS: 'fake' }, timeoutMs: 30_000 });
  const nc = await open({ port: noticeServer.port, token: noticeServer.token, autoAllow: true });
  try {
    const delegate = ply('ply_delegate', { kind: 'mechanical', backend: 'fake', task: 'bg 1 1.5' });
    const parent = (await nc.runTurn({ prompt: delegate, sessionId: null, cwd: ROOT, backend: 'fake', mode: 'default' }, { ms: 20_000 })).sessionId;
    await nc.waitFor(e => e.type === 'compactionSchedule' && e.sessionId === parent && e.at, { ms: 5000 });
    const noticeFrom = nc.mark();
    const child = await pollTask(nc, parent, task => task.notification === 'sent');
    await nc.waitFor(e => e.type === 'turnEnd' && e.sessionId === parent, { from: noticeFrom, ms: 20_000 });
    const rescheduled = await nc.waitFor(e => e.type === 'compactionSchedule' && e.sessionId === parent && e.at, { from: noticeFrom, ms: 5000 })
      .catch(() => null);
    const events = nc.since(noticeFrom).filter(e => e.type === 'compactionSchedule' && e.sessionId === parent);
    t.ok('完了通知のターンが始まると予約を取り消し、正常に終わった後に予約し直す',
      events[0]?.at === null && Boolean(rescheduled) && events.at(-1).at > Date.now()
      && (await nc.cmd('listSessions')).find(row => row.id === parent)?.compactionAt === events.at(-1).at);
    t.ok('委譲の子の会話には予約を置かない', Boolean(child.sessionId) && child.sessionId !== parent
      && !nc.events.some(e => e.type === 'compactionSchedule' && e.sessionId === child.sessionId && e.at)
      && (await nc.cmd('listSessions')).find(row => row.id === child.sessionId)?.compactionAt == null);
  } finally {
    nc.close();
    await noticeServer.stop();
    await fs.rm(noticeScratch, { recursive: true, force: true });
  }

  // 予約はファイルに残り、同じデータ置き場で立て直すと戻る。猶予（8 分）を過ぎたものは戻らず、ファイルからも消える（ADR 0068）
  const restartScratch = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-compact-restart-'));
  const restartData = path.join(restartScratch, 'data');
  const clock = path.join(restartScratch, 'clock');
  const scheduleFile = path.join(restartData, 'compaction-schedule.json');
  await fs.writeFile(clock, String(Date.now()));
  const restartEnv = { AGENT_HOST_BACKENDS: 'fake', TEST_COMPACTION_CLOCK: clock,
    NODE_OPTIONS: `--loader="${pathToFileURL(path.join(ROOT, 'tests/lib/compaction-clock-loader.mjs')).href}"` };
  const boot = async () => {
    const server = await startServer({ dataDir: restartData, env: restartEnv, timeoutMs: 30_000 });
    return { server, client: await open({ port: server.port, token: server.token, autoAllow: true }) };
  };
  const savedSchedule = async () => { try { return JSON.parse(await fs.readFile(scheduleFile, 'utf8')); } catch { return null; } };
  const savedWhen = async (ok) => {
    for (let i = 0; i < 100; i++) { const saved = await savedSchedule(); if (ok(saved)) return saved; await sleep(50); }
    return await savedSchedule();
  };
  let running = null;
  try {
    running = await boot();
    const id = (await running.client.runTurn({ prompt: 'echo:first', sessionId: null, cwd: ROOT, backend: 'fake', mode: 'default' }, { ms: 20_000 })).sessionId;
    const scheduled = await running.client.waitFor(e => e.type === 'compactionSchedule' && e.sessionId === id && e.at, { ms: 5000 });
    const saved = await savedWhen(s => s?.entries?.[id]?.at === scheduled.at);
    t.ok('見えている予約を compaction-schedule.json に保存する', saved?.version === 1
      && saved.entries[id].at === scheduled.at && saved.entries[id].backend === 'fake' && saved.entries[id].usedTokens === 164000);
    const from = running.client.mark();
    await running.client.cmd('cancelCompaction', { sessionId: id });
    t.ok('取り消すとファイルからも消える', (await savedWhen(s => !s?.entries?.[id]))?.entries?.[id] === undefined
      && running.client.since(from).some(e => e.type === 'compactionSchedule' && e.sessionId === id && e.at === null));
    await running.client.runTurn({ prompt: 'echo:again', sessionId: id, cwd: ROOT, backend: 'fake', mode: 'default' }, { ms: 20_000 });
    const again = await running.client.waitFor(e => e.type === 'compactionSchedule' && e.sessionId === id && e.at, { from, ms: 5000 });
    await savedWhen(s => s?.entries?.[id]?.at === again.at);
    running.client.close();
    await running.server.stop();

    running = await boot();
    const restored = (await running.client.cmd('listSessions')).find(row => row.id === id);
    t.ok('立て直したサーバーが予約を同じ時刻で戻す', restored?.compactionAt === again.at, String(restored?.compactionAt));
    running.client.close();
    await running.server.stop();

    await fs.writeFile(clock, String(again.at + 8 * 60_000 + 1000));
    running = await boot();
    const late = (await running.client.cmd('listSessions')).find(row => row.id === id);
    t.ok('猶予を過ぎた予約は戻さず、ファイルからも消す', !late?.compactionAt
      && (await savedWhen(s => !s?.entries?.[id]))?.entries?.[id] === undefined);
    running.client.close();
    await running.server.stop();

    await fs.writeFile(scheduleFile, '{ not json');
    await fs.writeFile(clock, String(Date.now()));
    running = await boot();
    t.ok('壊れたファイルは空として扱い、起動を止めない', Array.isArray(await running.client.cmd('listSessions')));
  } finally {
    running?.client.close();
    await running?.server.stop();
    await fs.rm(restartScratch, { recursive: true, force: true });
  }

  const invalidScratch =await fs.mkdtemp(path.join(os.tmpdir(), 'ply-compact-invalid-'));
  const invalidData = path.join(invalidScratch, 'data');
  await fs.mkdir(invalidData);
  await fs.writeFile(path.join(invalidData, 'prefs.json'), JSON.stringify({ autoCompaction: { minTokens: '40000' } }));
  let recoveredServer, recoveredClient;
  try {
    recoveredServer = await startServer({ dataDir: invalidData, env: { AGENT_HOST_BACKENDS: 'fake' }, timeoutMs: 30_000 });
    recoveredClient = await open({ port: recoveredServer.port, token: recoveredServer.token });
    const prefs = await recoveredClient.cmd('prefs');
    t.ok('不正な保存済み設定でも起動し既定値を返す', prefs.autoCompaction.minTokens === 150_000
      && prefs.autoCompaction.claude.enabled && recoveredServer.tail(200).includes('自動圧縮の保存済み設定が不正'));
    const onDisk = JSON.parse(await fs.readFile(path.join(invalidData, 'prefs.json'), 'utf8'));
    t.ok('不正な保存値を既定値へ修復する', onDisk.autoCompaction.minTokens === 150_000);
    let rejected = false;
    try { await recoveredClient.cmd('setAutoCompaction', { settings: { minTokens: '40000' } }); }
    catch { rejected = true; }
    t.ok('保存時の不正値は引き続き拒否する', rejected);
  } finally {
    recoveredClient?.close();
    await recoveredServer?.stop();
    await fs.rm(invalidScratch, { recursive: true, force: true });
  }
}
