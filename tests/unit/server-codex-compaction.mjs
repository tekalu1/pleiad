import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { startServer, ROOT } from '../lib/server.mjs';
import { open } from '../lib/ws-client.mjs';

export const name = 'server-codex-compaction';
export const title = 'Codex の圧縮後に別のサーバーで同じ会話を再開する';

const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

export default async function (t) {
  const scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ply-codex-compact-')));
  const home = path.join(scratch, 'home'), state = path.join(scratch, 'state');
  await fs.mkdir(home); await fs.mkdir(state);
  const log = path.join(scratch, 'rpc.jsonl'), control = path.join(scratch, 'control'), clock = path.join(scratch, 'clock');
  await fs.writeFile(control, ''); await fs.writeFile(clock, String(Date.now()));
  const server = await startServer({ dataDir: path.join(scratch, 'data'), env: {
    AGENT_HOST_BACKENDS: 'codex', AGENT_HOST_CODEX_BIN: `node "${path.join(ROOT, 'tests/lib/fake-codex.mjs')}"`,
    HOME: home, USERPROFILE: home, CODEX_HOME: path.join(home, '.codex'), CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
    FAKE_CODEX_STATE_DIR: state, FAKE_CODEX_LOG: log, FAKE_CODEX_CONTROL: control,
    TEST_COMPACTION_CLOCK: clock,
    NODE_OPTIONS: `--loader="${pathToFileURL(path.join(ROOT, 'tests/lib/compaction-clock-loader.mjs')).href}"`,
  } });
  const c = await open({ ...server, onEvent: async (event, client) => {
    if (event.type === 'permission') await client.cmd('resolvePermission', { id: event.id, allow: true });
  } });
  const records = async () => (await fs.readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  const compact = async sid => {
    const from = c.mark();
    await c.cmd('compactConversation', { sessionId: sid });
    await c.waitFor(e => e.type === 'turnEnd' && e.sessionId === sid, { from, ms: 20_000 });
    return c.since(from);
  };
  try {
    const none = { sources: [], excludePaths: [] };
    for (const kind of ['instruction', 'skill', 'mcp']) {
      await c.cmd('setContextSettings', { place: scratch, kind, value: { owner: 'ply', user: none, directory: none } });
    }
    await c.cmd('setAutoCompaction', { settings: { enabled: true, minTokens: 40000, codex: { enabled: true, delayMinutes: 25 } } });
    const { sessionId: sid } = await c.cmd('newSession', { backend: 'codex', cwd: scratch, mode: 'yolo' });
    const turn = await c.runTurn({ sessionId: sid, prompt: 'first', cwd: scratch }, { ms: 20_000 });
    t.ok('専用サーバーで最初のターンを送れる', turn.outcome === 'ok');
    const events = await compact(sid);
    const rpc = await records(), first = rpc.find(e => e.method === 'thread/start' && !e.ephemeral);
    const compaction = rpc.find(e => e.method === 'thread/compact/start');
    t.ok('手動圧縮が完了する', events.some(e => e.type === 'compaction' && e.phase === 'complete'));
    const launch = rpc.find(e => e.method === 'initialize' && e.pid === compaction?.pid);
    t.ok('圧縮にもネイティブの指示・Skill・MCP を止める起動設定が渡る',
      compaction?.pid !== first?.pid && launch?.args.some(x => x === 'project_doc_max_bytes=0')
      && launch.args.some(x => x.startsWith('skills.config=')) && launch.args.some(x => x.startsWith('mcp_servers=')));
    t.ok('圧縮のターンが終わる前に専用サーバーを終了する', Boolean(compaction) && !alive(compaction.pid));
    t.ok('手動圧縮の後に同じ会話へ送れる', (await c.runTurn({ sessionId: sid, prompt: 'large-context', cwd: scratch }, { ms: 20_000 })).outcome === 'ok');
    const scheduled = await c.waitFor(e => e.type === 'compactionSchedule' && e.sessionId === sid && e.at, { ms: 5000 });
    const from = c.mark();
    await fs.writeFile(clock, String(scheduled.at));
    await c.waitFor(e => e.type === 'turnEnd' && e.sessionId === sid, { from, ms: 20_000 });
    t.ok('自動圧縮が完了する', c.since(from).some(e => e.type === 'compaction' && e.phase === 'complete' && e.trigger === 'idle'));
    t.ok('自動圧縮の後に同じ会話へ送れる', (await c.runTurn({ sessionId: sid, prompt: 'after-idle', cwd: scratch }, { ms: 20_000 })).outcome === 'ok');
    await fs.writeFile(control, 'compact-fail');
    const failed = await compact(sid), last = (await records()).filter(e => e.method === 'thread/compact/start').at(-1);
    t.ok('圧縮失敗でも専用サーバーを終了する', failed.some(e => e.type === 'compaction' && e.phase === 'failed') && !alive(last.pid));
    await fs.writeFile(control, '');
    t.ok('圧縮失敗の後に同じ会話へ送れる', (await c.runTurn({ sessionId: sid, prompt: 'after-failure', cwd: scratch }, { ms: 20_000 })).outcome === 'ok');
  } finally {
    c.close(); await server.stop();
    await fs.rm(scratch, { recursive: true, force: true });
  }
}
