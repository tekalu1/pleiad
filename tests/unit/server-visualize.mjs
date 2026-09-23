import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startServer, ROOT } from '../lib/server.mjs';
import { open } from '../lib/ws-client.mjs';
import { VISUALIZE_START as S, VISUALIZE_END as E } from '../../web/visualize-reference.mjs';
export const name = 'server-visualize';
export const title = '共通参照の表示・保存・再開とMCP廃止を実際のサーバーで確認';
export default async function(t) {
  const scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ply-viz-server-')));
  const config = { env:{ AGENT_HOST_BACKENDS:'codex', AGENT_HOST_CODEX_BIN:`node "${path.join(ROOT,'tests/lib/fake-codex.mjs')}"` }, dataDir:path.join(scratch,'data') };
  const server = await startServer(config), c = await open({...server,autoAllow:true});
  try {
    const file = path.join(scratch,'chart.html');
    await fs.writeFile(file,'<input type="range"><p>first</p>');
    const id = (await c.cmd('newSession',{backend:'codex',cwd:scratch})).sessionId;
    const prompt = `\n${S}${JSON.stringify({path:file,mode:'wide'})}${E}`;
    const first = await c.runTurn({sessionId:id,prompt});
    const events = first.events.filter(e=>e.type==='present');
    assert.equal(events.length,1); assert.equal(events[0].sessionId,id);
    assert.equal(events[0].kind,'visualization'); assert(events[0].content.includes('first'));
    assert(first.events.indexOf(events[0]) < first.events.findIndex(e=>e.type==='turnEnd'));
    await fs.writeFile(file,'<p>second</p>');
    const second = await c.runTurn({sessionId:id,prompt});
    assert(second.events.some(e=>e.kind==='visualization'&&e.content==='<p>second</p>'));
    await fs.unlink(file);
    const saved = await c.cmd('loadSession',{sessionId:id});
    assert.equal(saved.presents.length,2); assert(saved.presents[0].content.includes('first'));
    assert.equal(saved.presents[1].mode,'wide');
    t.ok('参照を会話に配信し、再開・削除後も各版を保存',true);
    const third = await c.runTurn({sessionId:id,prompt});
    assert(third.events.some(e=>e.kind==='visualization'&&e.error));
    t.ok('欠損ファイルはエラーカードになり、ターンは終了する',true);
    const response = await fetch(`http://127.0.0.1:${server.port}/mcp/ply`,{method:'POST',headers:{Authorization:'Bearer retired'}});
    assert.notEqual(response.status,200);
    t.ok('旧presentのMCPエンドポイントは利用不可',true);
  } finally { c.close(); await server.stop(); await fs.rm(scratch,{recursive:true,force:true}); }
}
