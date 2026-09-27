import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startServer, ROOT } from '../lib/server.mjs';
import { open } from '../lib/ws-client.mjs';

export const name = 'server-compaction';
export const title = '圧縮コマンド・設定・記録をサーバー経由で確かめる';

export default async function (t) {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-compact-'));
  const server = await startServer({ dataDir: path.join(scratch, 'data'),
    env: { AGENT_HOST_BACKENDS: 'fake' }, timeoutMs: 30_000 });
  const c = await open({ port: server.port, token: server.token, autoAllow: true });
  try {
    const initial = await c.runTurn({ prompt: 'echo:first', sessionId: null, cwd: ROOT, backend: 'fake', mode: 'default' }, { ms: 20_000 });
    const id = initial.sessionId;
    await c.waitFor(e => e.type === 'compactionSchedule' && e.sessionId === id && e.at > Date.now(), { ms: 2000 }).catch(() => {});
    t.ok('通常ターンで文脈量と自動圧縮の予定が届く', c.events.some(e => e.type === 'contextWindow' && e.sessionId === id && e.usedTokens === 124000)
      && c.events.some(e => e.type === 'compactionSchedule' && e.sessionId === id && e.at > Date.now()));
    const from = c.mark();
    const result = await c.cmd('compactConversation', { sessionId: id });
    const completed = await c.waitFor(e => e.type === 'compaction' && e.sessionId === id && e.phase === 'complete', { from, ms: 20_000 });
    t.ok('手動コマンドは要約と前後量を持つ完了を返す', result.status === 'started'
      && completed.trigger === 'manual' && completed.beforeTokens === 124000 && completed.afterTokens === 21000
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

  const invalidScratch = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-compact-invalid-'));
  const invalidData = path.join(invalidScratch, 'data');
  await fs.mkdir(invalidData);
  await fs.writeFile(path.join(invalidData, 'prefs.json'), JSON.stringify({ autoCompaction: { minTokens: '40000' } }));
  let recoveredServer, recoveredClient;
  try {
    recoveredServer = await startServer({ dataDir: invalidData, env: { AGENT_HOST_BACKENDS: 'fake' }, timeoutMs: 30_000 });
    recoveredClient = await open({ port: recoveredServer.port, token: recoveredServer.token });
    const prefs = await recoveredClient.cmd('prefs');
    t.ok('不正な保存済み設定でも起動し既定値を返す', prefs.autoCompaction.minTokens === 40_000
      && prefs.autoCompaction.claude.enabled && recoveredServer.tail(200).includes('自動圧縮の保存済み設定が不正'));
    const onDisk = JSON.parse(await fs.readFile(path.join(invalidData, 'prefs.json'), 'utf8'));
    t.ok('不正な保存値を既定値へ修復する', onDisk.autoCompaction.minTokens === 40_000);
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
