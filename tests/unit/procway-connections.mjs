import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import { startServer, PROCWAY_CLI } from '../lib/server.mjs';
import { open } from '../lib/ws-client.mjs';
import { validateLimits } from '../../web/procway-limits.mjs';
import { prepareRequest, applyLimits } from '../../core/procway-runtime.mjs';
import { titleProvider } from '../../core/procway-title.mjs';

export const name = 'procway-connections';
export const title = 'API 接続・資格情報・容量・会話の分離';
const CLI = PROCWAY_CLI;
const limits = validateLimits({ context: 128000, output: 4096, compact: false, threshold: 90000, keep: 10, condense: false, recent: 10, chars: 6000 });
export default async function(t) {
  assert.throws(() => validateLimits({ context: 1000, output: 2000 }));
  assert.throws(() => validateLimits({ context: 1000, output: 200, compact: true, threshold: 900 }));
  assert.throws(() => prepareRequest({ messages: [{ content: 'x'.repeat(6000) }] }, 'openai', { context: 1000, output: 200 }));
  assert.equal(prepareRequest({}, 'openai', limits).max_completion_tokens, 4096);
  assert.equal(prepareRequest({}, 'openai-compatible', limits).max_tokens, 4096);
  assert.equal(prepareRequest({}, 'anthropic', limits).max_tokens, 4096);
  assert.equal(prepareRequest({}, 'openai-codex', limits).max_output_tokens, undefined);
  t.ok('容量と出力の整合性・接続方式別の送信フィールド', true);
  const applied = applyLimits({ providers: {}, session: { autoCompact: { strategy: 'llm-summary' } }, tools: { staleToolResults: { enabled: true } } }, 'test', { type: 'anthropic' }, limits);
  assert.equal(applied.session.autoCompact.estimatedTokens, 90000); assert.equal(applied.tools.staleToolResults.enabled, false);
  t.ok('自動要約とツール保持を実行設定に反映', true);
  const compatible = titleProvider({ type: 'openai-compatible', defaultModel: 'qwen-3.8-27b', reasoningEffort: 'high' });
  assert.equal(compatible.defaultModel, 'qwen-3.8-27b'); assert.equal(compatible.reasoningEffort, undefined); assert.equal(compatible.maxRetries, 0);
  assert.equal(titleProvider({ type: 'openai-codex', defaultModel: 'gpt-5.6' }).defaultModel, 'gpt-5.6-luna');
  assert.equal(titleProvider({ type: 'openai', defaultModel: 'gpt-5.4' }).defaultModel, 'gpt-5.4-nano');
  const anthropic = titleProvider({ type: 'anthropic', defaultModel: 'claude-sonnet-4-6', reasoningEffort: 'high' });
  assert.equal(anthropic.defaultModel, 'claude-haiku-4-5'); assert.equal(anthropic.reasoningEffort, undefined); assert.equal(anthropic.maxTokens, 256);
  t.ok('タイトル生成は公式接続で最軽量モデル、互換接続では選択中のモデルを使う', true);
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-connections-'));
  const requests = [];
  const api = http.createServer(async (req,res) => {
    const key = req.headers.authorization;
    if (key === 'Bearer invalid') { res.writeHead(401).end('do not expose invalid'); return; }
    if (req.url === '/models') { res.setHeader('Content-Type','application/json'); res.end(JSON.stringify({ data: [{ id: 'model-a' }, { id: 'model-b' }] })); return; }
    let body=''; for await (const b of req) body += b;
    const data = JSON.parse(body); requests.push({ key, ...data });
    await new Promise(r => setTimeout(r, 200));
    res.writeHead(200, { 'Content-Type':'text/event-stream' });
    res.end('data: '+JSON.stringify({ choices: [{ delta: { content: 'API success '+data.model }, finish_reason: null }] })+'\n\ndata: '+JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 50, completion_tokens: 5, total_tokens: 55 } })+'\n\ndata: [DONE]\n\n');
  });
  await new Promise(r => api.listen(0,'127.0.0.1',r));
  const server = await startServer({ dataDir:path.join(scratch,'data'), env: { AGENT_HOST_BACKENDS:'procway', AGENT_HOST_PROCWAY_CODE:CLI, AGENT_HOST_PROCWAY_HOME:path.join(scratch,'home'), PLY_TEST_KEY:'second-key' } });
  t.note('test server ready');
  const a = await open({ port:server.port, token:server.token }), b = await open({ port:server.port, token:server.token });
  try {
    const connection = { name:'互換 API', type:'openai-compatible', baseUrl:`http://127.0.0.1:${api.address().port}`, model:'model-a', apiKey:process.platform === 'win32' ? 'first-key' : '', apiKeyEnv:process.platform === 'win32' ? '' : 'PLY_TEST_KEY' };
    await assert.rejects(a.cmd('procwayCheck', { connection: { ...connection, apiKey:'invalid' } }), /認証/);
    t.note('invalid credential rejected');
    await assert.rejects(a.cmd('procwaySave', { connection, receipt:'no-proof' }), /確認/);
    const checked = await a.cmd('procwayCheck', { connection });
    t.note('model check complete');
    await assert.rejects(a.cmd('procwaySave', { connection: { ...connection, model:'model-b' }, receipt:checked.receipt }), /確認/);
    const saved = await a.cmd('procwaySave', { connection, receipt:checked.receipt });
    t.note('protected credential saved');
    const second = { ...connection, name:'別の接続', model:'model-b', apiKey:'', apiKeyEnv:'PLY_TEST_KEY' };
    const proof = await a.cmd('procwayCheck', { connection:second });
    const saved2 = await a.cmd('procwaySave', { connection:second, receipt:proof.receipt });
    const listed = await a.cmd('procwayConnections', { cwd:scratch });
    const disk = await fs.readFile(path.join(scratch,'data/procway-connections.json'),'utf8');
    assert(!disk.includes('first-key')); assert(!JSON.stringify(listed).includes('first-key')); assert(!JSON.stringify(listed).includes('second-key'));
    t.ok('接続確認後のみ保存でき、キーは一覧・設定 JSON に平文で出ない', true);
    const sessionA = (await a.cmd('newSession', { backend:'procway', cwd:scratch })).sessionId;
    const sessionB = (await b.cmd('newSession', { backend:'procway', cwd:scratch })).sessionId;
    await a.cmd('setTurnSettings', { sessionId:sessionA, model:saved.id+'/model-a', effort:"high", procwayLimits:limits });
    await b.cmd('setTurnSettings', { sessionId:sessionB, model:saved2.id+'/model-b', procwayLimits:{ ...limits, output:2048 } });
    async function run(client, sessionId) {
      const from = client.mark();
      await Promise.all([client.cmd('runTurn',{sessionId,prompt:'reply',cwd:scratch}), client.waitFor(e=>e.type==='turnEnd' && e.sessionId===sessionId,{ms:60000,from})]);
      const events=client.since(from).filter(e=>e.sessionId===sessionId);
      return {events,outcome:events.find(e=>e.type==='turnResult')?.outcome};
    }
    const turns = await Promise.all([run(a,sessionA),run(b,sessionB)]);
    assert(turns.every(v => v.outcome === 'ok'), JSON.stringify(turns.map(v=>v.events.filter(e=>e.type==='error'||e.type==='turnResult'))));
    const ra=requests.find(r=>r.model==='model-a'), rb=requests.find(r=>r.model==='model-b');
    assert(ra && rb, JSON.stringify({ models:requests.map(r=>r.model), results:turns.map(v=>v.events.filter(e=>e.type==='text.delta'||e.type==='turnResult')), log:server.tail(20) }));
    assert.equal(ra.reasoning_effort,"high"); assert.equal(rb.reasoning_effort,undefined);
    assert.equal(ra.max_tokens,4096); assert.equal(rb.max_tokens,2048); assert.equal(rb.key,'Bearer second-key');
    if(process.platform==='win32')assert.equal(ra.key,'Bearer first-key');
    t.ok('並行する会話に別々の接続先・キー・出力上限で送信',true);
    await a.cmd('setTurnSettings',{sessionId:sessionA,effort:"",procwayLimits:{...limits,output:8192}});
    const resumed=await run(a,sessionA);assert.equal(resumed.outcome,'ok');
    const last=requests.filter(r=>r.model==='model-a').at(-1);
    assert.equal(last.reasoning_effort,undefined);
    assert.equal(last.max_tokens,8192);assert(JSON.stringify(last.messages).includes('API success model-a'));
    t.ok('同じ会話の容量変更で実行設定を更新し、過去の文脈を維持',true);
    await a.cmd('procwayModelLimits', { model:saved.id+'/model-a', limits:{ ...limits, context:200000 }, cwd:scratch });
    const before=await a.cmd('procwaySettings',{sessionId:sessionA,cwd:scratch});assert.equal(before.limits.context,128000);
    await a.cmd('setTurnSettings',{sessionId:sessionA,procwayLimits:{...limits,context:250000}});
    assert.equal((await a.cmd('procwaySettings',{sessionId:sessionA,cwd:scratch})).limits.context,250000);
    await a.cmd('setTurnSettings',{sessionId:sessionA,cancel:true});
    assert.equal((await a.cmd('procwaySettings',{sessionId:sessionA,cwd:scratch})).limits.context,128000);
    t.ok('モデルの既定変更は既存会話に影響せず、予約を取り消せる',true);
    const next=await a.cmd('setTurnSettings',{sessionId:sessionA,model:saved2.id+'/model-b'});assert.equal(next.procwayLimits,undefined);
    t.ok('接続先変更で以前の容量予約を持ち越さない',true);
    const file = path.join(scratch,'data/procway-connections.json');
    if (process.platform === 'win32') {
      // キー欄を空のまま編集する。保存済みのキーで確認でき、保存後もキーは残る
      const keep = { ...connection, name:'名前を変えた接続', model:'model-b', apiKey:'', apiKeyEnv:'' };
      const keepProof = await a.cmd('procwayCheck', { connection:keep, id:saved.id });
      const kept = await a.cmd('procwaySave', { connection:keep, receipt:keepProof.receipt, id:saved.id });
      assert.equal(kept.id, saved.id);
      const raw = JSON.parse(await fs.readFile(file,'utf8')).connections[saved.id];
      assert.equal(raw.name,'名前を変えた接続'); assert.equal(raw.defaultModel,'model-b'); assert(raw.secret);
      t.ok('キー未入力の編集は保存済みキーで確認・保存でき、id もキーも変わらない',true);
    }
    // レシートは確認した id にだけ効く（別 id・新規・別内容へ流用できない）
    const edit = { ...connection, name:'編集した接続', model:'model-b', apiKey:'', apiKeyEnv:'PLY_TEST_KEY' };
    await assert.rejects(a.cmd('procwayCheck', { connection:edit, id:'ply-missing' }), /接続先/);
    const editProof = await a.cmd('procwayCheck', { connection:edit, id:saved.id });
    await assert.rejects(a.cmd('procwaySave', { connection:edit, receipt:editProof.receipt }), /確認/);
    await assert.rejects(a.cmd('procwaySave', { connection:edit, receipt:editProof.receipt, id:saved2.id }), /確認/);
    await assert.rejects(a.cmd('procwaySave', { connection:{ ...edit, model:'model-a' }, receipt:editProof.receipt, id:saved.id }), /確認/);
    const edited = await a.cmd('procwaySave', { connection:edit, receipt:editProof.receipt, id:saved.id });
    assert.equal(edited.id, saved.id);
    const afterEdit = await a.cmd('procwayConnections', { cwd:scratch });
    const editedCard = afterEdit.connections.find(c => c.id === saved.id);
    assert.equal(editedCard.name,'編集した接続'); assert.equal(editedCard.model,'model-b'); assert.equal(editedCard.managed,true);
    assert.equal(afterEdit.connections.length, listed.connections.length);
    const editedDisk = await fs.readFile(file,'utf8');
    assert(!editedDisk.includes('first-key')); assert(!editedDisk.includes('second-key'));
    assert(!JSON.stringify(afterEdit).includes('first-key')); assert(!JSON.stringify(afterEdit).includes('second-key'));
    t.ok('既存の接続先を上書き編集でき、レシートは他へ流用できず、キーは平文で出ない',true);
    // 削除。既定とモデル別の容量設定も一緒に片付く
    const spare = { ...connection, name:'削除する接続', model:'model-a', apiKey:'', apiKeyEnv:'PLY_TEST_KEY' };
    const spareProof = await a.cmd('procwayCheck', { connection:spare });
    const spareSaved = await a.cmd('procwaySave', { connection:spare, receipt:spareProof.receipt });
    await a.cmd('procwayDefault', { id:spareSaved.id, cwd:scratch });
    await a.cmd('procwayModelLimits', { model:spareSaved.id+'/model-a', limits, cwd:scratch });
    assert.equal((await a.cmd('procwayConnections',{cwd:scratch})).defaultId, spareSaved.id);
    await a.cmd('procwayDelete', { id:spareSaved.id, cwd:scratch });
    const afterDelete = await a.cmd('procwayConnections', { cwd:scratch });
    assert(!afterDelete.connections.some(c => c.id === spareSaved.id));
    assert.notEqual(afterDelete.defaultId, spareSaved.id);
    assert(!Object.keys(afterDelete.defaults).some(k => k === spareSaved.id || k.startsWith(spareSaved.id+'/')));
    assert(!Object.hasOwn(JSON.parse(await fs.readFile(file,'utf8')).connections, spareSaved.id));
    await assert.rejects(a.cmd('procwayDelete', { id:spareSaved.id, cwd:scratch }), /削除/);
    const native = afterDelete.connections.find(c => !c.managed);
    assert(native, '比較対象の native 接続が見つからない');
    await assert.rejects(a.cmd('procwayDelete', { id:native.id, cwd:scratch }), /削除/);
    t.ok('Pleiad が保存した接続先だけ削除でき、既定と容量設定も外れる',true);
  } finally {
    a.close(); b.close(); await server.stop(); api.closeAllConnections(); await new Promise(r=>api.close(r));
    for(const m of server.tail(200).matchAll(/serve を起動した pid=(\d+)/g)) { try { process.kill(Number(m[1])); } catch {} }
    await fs.rm(scratch,{recursive:true,force:true,maxRetries:10,retryDelay:100});
  }
}
