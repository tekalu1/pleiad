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
  const config = { env:{ AGENT_HOST_BACKENDS:'codex', AGENT_HOST_CODEX_BIN:`node "${path.join(ROOT,'tests/lib/fake-codex.mjs')}"`, AGENT_HOST_OS_OPEN:'dry' }, dataDir:path.join(scratch,'data') };
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

    // 右パネルの「ブラウザーで開く」: 写しをサーバーの記録から、sandbox の応答ヘッダー付きで返す
    const base = `http://127.0.0.1:${server.port}/visualization-snapshot`;
    const auth = { headers:{ cookie:`agent_host_token=${server.token}` } };
    assert(saved.presents[0].id, '新しい可視化の記録は id を持つ');
    const byId = await fetch(`${base}?sessionId=${id}&id=${saved.presents[0].id}`, auth);
    assert.equal(byId.status, 200);
    const csp = byId.headers.get('content-security-policy');
    assert.match(csp, /^sandbox allow-scripts;/); assert(!/allow-same-origin/.test(csp));
    assert.match(csp, /connect-src 'none'/); assert.match(csp, /frame-ancestors 'none'/);
    assert.match(byId.headers.get('content-type'), /^text\/html/);
    assert.equal(byId.headers.get('cache-control'), 'private, no-store');
    assert.equal(byId.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(byId.headers.get('referrer-policy'), 'no-referrer');
    const html = await byId.text();
    assert(html.includes('first') && html.includes('Content-Security-Policy'), '中身は会話に残った最初の版（ファイルは消えている）');
    assert(!html.includes('ply-visualize-height'), '単体では高さを知らせるスクリプトを持たない');
    const byAt = await fetch(`${base}?sessionId=${id}&at=${encodeURIComponent(saved.presents[1].at)}`, auth);
    assert.equal(byAt.status, 200); assert((await byAt.text()).includes('second'), 'id の無い以前の記録は at で指す');
    assert.equal((await fetch(`${base}?sessionId=${id}&id=${saved.presents[0].id}`)).status, 401, '認証が無ければ断る');
    assert.equal((await fetch(`${base}?sessionId=${id}&id=missing`, auth)).status, 404);
    assert.equal((await fetch(`${base}?sessionId=other&id=${saved.presents[0].id}`, auth)).status, 404, '別の会話からは引けない');
    assert.equal((await fetch(`${base}?sessionId=${id}`, auth)).status, 400);
    t.ok('写しを sandbox allow-scripts の CSP で返す（認証・不明・別の会話・指定なし）', true);
    // 殻（デスクトップ版）は新しい窓を開かないので、写しをファイルにして既定のブラウザーへ渡す（OS の起動は dry）
    const opened = await c.cmd('openVisualization', { sessionId:id, id:saved.presents[0].id });
    assert(opened.path.startsWith(path.join(scratch,'data')), '写しはデータ置き場に書く');
    const written = await fs.readFile(opened.path, 'utf8');
    assert(written.includes('first') && written.includes('Content-Security-Policy'));
    await assert.rejects(c.cmd('openVisualization', { sessionId:id, id:'missing' }));
    // 元のファイルが消えていても、在り処と作業ディレクトリは分かる（見出しの下の相対パス）
    const where = await c.cmd('resolvePath', { path:file, sessionId:id, lenient:true });
    assert.equal(path.resolve(where.path), path.resolve(file)); assert.equal(path.resolve(where.cwd), path.resolve(scratch));
    await assert.rejects(c.cmd('resolvePath', { path:file, sessionId:id }), '読むときは今までどおり実在を確かめる');
    t.ok('殻向けに写しをファイルで開き、消えた元のファイルも在り処だけは引ける', true);
    const third = await c.runTurn({sessionId:id,prompt});
    assert(third.events.some(e=>e.kind==='visualization'&&e.error));
    t.ok('欠損ファイルはエラーカードになり、ターンは終了する',true);
    const response = await fetch(`http://127.0.0.1:${server.port}/mcp/ply`,{method:'POST',headers:{Authorization:'Bearer retired'}});
    assert.notEqual(response.status,200);
    t.ok('旧presentのMCPエンドポイントは利用不可',true);
  } finally { c.close(); await server.stop(); await fs.rm(scratch,{recursive:true,force:true}); }
}
