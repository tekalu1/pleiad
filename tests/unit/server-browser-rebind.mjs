import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startServer, ROOT } from '../lib/server.mjs';
import { open } from '../lib/ws-client.mjs';

export const name = 'server-browser-rebind';
export const title = '内蔵ブラウザーの中継: 新規会話の最初のターンのキーを、会話 ID が決まったとき本物へ付け替える（fake + parentPort の身代わり）';

export default async function(t) {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-browser-rebind-'));
  const log = path.join(scratch, 'parent-port.ndjson');
  const dataDir = path.join(scratch, 'data');
  await fs.mkdir(dataDir);
  const server = await startServer({ env: { AGENT_HOST_BACKENDS: 'fake', FAKE_PARENT_PORT_LOG: log }, dataDir, entry: path.join(ROOT, 'tests', 'lib', 'parent-port-server.mjs') });
  let c;
  const messages = async () => (await fs.readFile(log, 'utf8').catch(() => '')).split('\n').filter(Boolean).map(l => JSON.parse(l));
  try {
    c = await open({ port: server.port, token: server.token, autoAllow: true });
    const first = await c.runTurn({ backend: 'fake', cwd: ROOT, prompt: 'ok' });
    const sessionId = first.sessionId;
    let seen = await messages();
    const endpoint1 = seen.find(m => m.type === 'agent-browser-endpoint');
    t.ok('新規会話の最初のターンは turn.key（new:…）で中継へ頼む', /^new:/.test(endpoint1?.sessionId ?? ''), JSON.stringify(endpoint1));
    const rebind = seen.find(m => m.type === 'agent-browser-rebind');
    t.ok('会話 ID が決まったら、中継へ渡したキーから本物の ID へ付け替える（AGENT_BROWSER_SESSION の名前ではない）', rebind?.from === endpoint1?.sessionId && rebind?.to === sessionId, JSON.stringify(rebind));

    await c.runTurn({ backend: 'fake', cwd: ROOT, sessionId, prompt: 'ok' });
    seen = await messages();
    const endpoints = seen.filter(m => m.type === 'agent-browser-endpoint');
    t.ok('次のターンは本物の ID で頼む（付け替え済みの同じ中継に当たる）', endpoints.at(-1)?.sessionId === sessionId && seen.filter(m => m.type === 'agent-browser-rebind').length === 1);
  } finally { c?.close?.(); await server.stop(); await fs.rm(scratch, { recursive: true, force: true }); }
}
