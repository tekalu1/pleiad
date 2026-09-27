import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { createAgentTasks } from '../../core/agent-tasks.mjs';
import { createAgentBridge, DELEGATING_TOOLS } from '../../core/agent-bridge.mjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

export const name = 'agent-tasks';
export const title = 'Pleiad 委譲の所有権・継続・通知・中断・MCP 名前空間';
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn) { for (let i = 0; i < 200; i++) { if (await fn()) return; await sleep(20); } throw new Error('timeout'); }
export default async function(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-tasks-'));
  let seq = 0, release, rolledBack = 0;
  const calls = [], notifications = [];
  let notifyBlocked = true, retry = true, gated, renameBroken = false;
  // 保存の失敗は rename に差し込む（一時ファイルの名前は毎回変わるので、置き場に物を置いては塞げない）
  const io = { ...fs, rename: async (from, to) => { if (renameBroken) throw Object.assign(new Error('injected'), { code: 'ENOSPC', syscall: 'rename' }); return fs.rename(from, to); } };
  const options = { dataDir: dir, io, log: () => {}, prepare: async (_owner, a) => ({ sessionId: `child-${++seq}`, backend: a.backend }),
    rollback: async () => { rolledBack++; },
    execute: async (r, prompt, signal) => {
      calls.push([r.taskId, prompt]);
      if (prompt === 'retry' && retry) { retry = false; return { requeue: true }; }
      if (prompt === 'hold') await new Promise(resolve => { release = resolve; signal.addEventListener('abort', resolve, { once: true }); });
      if (prompt === 'gate') await Promise.race([gated, new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }))]);
      if (prompt === 'error') throw new Error('fixture failure');
      return { outcome: signal.aborted ? 'aborted' : 'ok', text: prompt === 'large' ? 'x'.repeat(40000) : prompt };
    },
    deliver: async r => { if (notifyBlocked) return 'requeue'; notifications.push([r.taskId, r.result]); return 'ok'; },
  };
  let manager = await createAgentTasks(options);
  const bridge = createAgentBridge({ call: (owner, name, args) => manager.call(owner, name, args) });
  const server = http.createServer(bridge.handle);
  const client = new Client({ name: 'test', version: '1' }, { capabilities: {} });
  try {
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const connection = bridge.open({ origin: `http://127.0.0.1:${server.address().port}`, owner: () => 'parent' });
    await client.connect(new StreamableHTTPClientTransport(new URL(connection.url), { requestInit: { headers: connection.headers } }));
    const tools = (await client.listTools()).tools;
    const names = tools.map(t => t.name);
    t.ok('SDK クライアントから7ツールが見え、native 名と重ならない', names.length === 7 && names.every(n => n.startsWith('ply_')) && !names.includes('spawn_agent'));
    const usageTool = tools.find(t => t.name === 'ply_usage');
    t.ok('ply_usage は backend を任意の文字列で受ける', usageTool?.inputSchema?.properties?.backend?.type === 'string' && usageTool.inputSchema.required.length === 0);
    t.ok('ply_usage は読み取り・計画モードの制限に掛けない', !DELEGATING_TOOLS.includes('ply_usage') && DELEGATING_TOOLS.includes('ply_delegate'));
    const delegateTool = tools.find(t => t.name === 'ply_delegate');
    t.ok('任意の title 引数を公開する', delegateTool?.inputSchema?.properties?.title?.type === 'string' && !delegateTool.inputSchema.required.includes('title'));
    t.ok('backend enum に antigravity が含まれる', delegateTool?.inputSchema?.properties?.backend?.enum?.includes('antigravity'));
    t.ok('backend enum に procway は無い（対応を終えた）', !delegateTool?.inputSchema?.properties?.backend?.enum?.includes('procway'));
    const result = await client.callTool({ name: 'ply_delegate', arguments: { backend: 'codex', task: 'hold' } });
    const job = JSON.parse(result.content[0].text);
    t.ok('結果を待たずに Pleiad の ID を返す', job.taskId.startsWith('ply-task-'));
    t.ok('title 未指定は依頼文に戻して返す', job.title === 'hold');
    await until(() => release);
    const denied = await manager.call('stranger', 'ply_task_status', { taskId: job.taskId }).catch(e => e.message);
    t.ok('別の親からタスクにアクセスできない', typeof denied === 'string');
    await manager.call('parent', 'ply_task_send', { taskId: job.taskId, message: 'second' });
    t.ok('実行中の追加指示は順番を待つ', calls.length === 1);
    release();
    await until(() => manager.get(job.taskId).status === 'completed');
    t.ok('同じ子の会話で追加指示を実行する', calls.length === 2 && manager.get(job.taskId).result === 'second');
    notifyBlocked = false;
    await until(() => manager.get(job.taskId).notification === 'sent');
    await sleep(550);
    t.ok('親が空いてから通知し、重複送信しない', notifications.length === 1);
    await manager.call('parent', 'ply_task_send', { taskId: job.taskId, message: 'retry' });
    await until(() => manager.get(job.taskId).notification === 'sent');
    t.ok('未受領の requeue のみ再試行できる', calls.filter(c => c[1] === 'retry').length === 2);
    const large = await manager.call('parent', 'ply_delegate', { backend: 'codex', task: 'large' });
    await until(() => manager.get(large.taskId).status === 'completed');
    const part = await manager.call('parent', 'ply_task_status', { taskId: large.taskId, offset: 32000 });
    t.ok('長い結果を省略せずページ取得できる', part.resultLength === 40000 && part.result.length === 8000 && part.nextOffset === null);
    release = null;
    const slow = await manager.call('parent', 'ply_delegate', { backend: 'claude', task: 'hold' });
    await until(() => release);
    await manager.call('parent', 'ply_task_cancel', { taskId: slow.taskId });
    await until(() => manager.get(slow.taskId).status === 'cancelled');
    t.ok('停止を実行に伝播する', manager.get(slow.taskId).notification === 'suppressed');
    const failed = await manager.call('parent', 'ply_delegate', { backend: 'codex', task: 'error' });
    await until(() => manager.get(failed.taskId).status === 'failed');
    t.ok('実行失敗を成功として扱わない', manager.get(failed.taskId).error === 'fixture failure');
    manager.close();
    await sleep(100);
    const raw = JSON.parse(await fs.readFile(path.join(dir, 'agent-tasks.json'), 'utf8'));
    raw[slow.taskId].status = 'running'; raw[slow.taskId].notification = 'delivering';
    await fs.writeFile(path.join(dir, 'agent-tasks.json'), JSON.stringify(raw));
    const before = calls.length;
    manager = await createAgentTasks(options);
    t.ok('再起動で実行を再送せず中断・配送不明にする', manager.get(slow.taskId).status === 'interrupted' && manager.get(slow.taskId).notification === 'unknown' && calls.length === before);
    renameBroken = true;
    const count = manager.list().length;
    const rejected = await manager.call('parent', 'ply_delegate', { backend: 'codex', task: 'must not run' }).then(() => false, () => true);
    t.ok('保存失敗で未受領のタスクを実行しない', rejected && manager.list().length === count && rolledBack === 1 && calls.length === before);
    renameBroken = false;
    // 件数・深さ・追加指示に上限は置かない（docs/agent-delegation.md「会話・権限・作業場所」）
    let openGate; gated = new Promise(resolve => { openGate = resolve; });
    const many = [];
    for (let i = 0; i < 12; i++) many.push(await manager.call('parent', 'ply_delegate', { backend: 'codex', task: 'gate' }));
    await until(() => many.every(j => manager.get(j.taskId).status === 'running'));
    t.ok('同時に動く委譲の件数に上限が無い（12 件が同時に実行中）', many.length === 12);
    for (let i = 0; i < 25; i++) await manager.call('parent', 'ply_task_send', { taskId: many[0].taskId, message: `more ${i}` });
    t.ok('追加指示の件数に上限が無い（25 件積める）', manager.get(many[0].taskId).pendingMessages === 25);
    let owner = 'parent', deepest;
    for (let i = 0; i < 6; i++) { deepest = await manager.call(owner, 'ply_delegate', { backend: 'codex', task: 'deep' }); owner = deepest.sessionId; }
    t.ok('委譲の深さに上限が無い（6 階層まで委譲できる）', deepest.depth === 6);
    openGate();
    await until(() => many.every(j => manager.get(j.taskId).status === 'completed'));
    t.ok('積んだ追加指示を順に全部実行する', manager.get(many[0].taskId).result === 'more 24');
    const japanese = '日本語の依頼';
    const payload = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'ply_delegate', arguments: { backend: 'claude', task: japanese } } }));
    const split = payload.indexOf(Buffer.from(japanese)) + 1;
    const chunked = await new Promise((resolve, reject) => {
      const req = http.request(connection.url, { method: 'POST', headers: { ...connection.headers, 'content-type': 'application/json' } }, res => {
        const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => resolve(JSON.parse(Buffer.concat(chunks).toString())));
      });
      req.on('error', reject); req.write(payload.subarray(0, split)); setTimeout(() => req.end(payload.subarray(split)), 20);
    });
    const japaneseTask = JSON.parse(chunked.result.content[0].text);
    t.ok('UTF-8 の文字途中で分割された依頼も保持する', japaneseTask.task === japanese);
    await until(() => manager.get(japaneseTask.taskId).notification === 'sent');
    connection.close();
    t.ok('失効した接続を拒否する', (await fetch(connection.url, { method: 'POST', headers: connection.headers, body: '{}' })).status === 401);
  } finally { manager.close(); await client.close(); server.closeAllConnections(); await new Promise(r => server.close(r)); await fs.rm(dir, { recursive: true, force: true }); }
}
