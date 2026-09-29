import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startServer, ROOT } from '../lib/server.mjs';
import { open } from '../lib/ws-client.mjs';

export const name = 'server-session-changes';
export const title = '変更の記録（sessionChanges）: 時刻・誰が・前 → 後・理由を古い順に返す。人が変えた状態には AI の印（statusByAi）を付けない（ADR 0067）';

export default async function (t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-host-changes-'));
  const server = await startServer({ dataDir, env: { AGENT_HOST_BACKENDS: 'fake' } });
  const c = await open({ port: server.port, token: server.token, autoAllow: true });
  try {
    const { sessionId } = await c.cmd('newSession', { backend: 'fake', cwd: ROOT });
    await c.cmd('setStatus', { sessionId, status: '進行中', reasonKey: 'menu' });
    await c.cmd('setTitle', { sessionId, title: '会話の地図', reasonKey: 'manual' });
    await c.cmd('setStatus', { sessionId, status: '保留', reasonKey: 'menu' });
    const { changes } = await c.cmd('sessionChanges', { sessionId });
    const status = changes.filter(x => x.field === 'status');
    t.ok('状態・タイトルの変更が古い順に並ぶ', status.length === 2 && changes.some(x => x.field === 'title') && status[0].to === '進行中' && status[1].to === '保留');
    t.ok('前の値・誰が・理由のキーが付く', status[1].from === '進行中' && status[1].by === 'human' && status[1].reasonKey === 'menu');
    const row = (await c.cmd('listSessions')).find(s => s.id === sessionId);
    t.ok('人が変えた状態には AI の印を付けない', row.status === '保留' && row.statusByAi === null);
    let refused = false;
    await c.cmd('sessionChanges', {}).catch(() => { refused = true; });
    t.ok('会話の指定が無ければ断る', refused);
  } finally { c.close(); await server.stop(); }
}
