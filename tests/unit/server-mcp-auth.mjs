// 担当が Pleiad の外部 MCP をサーバー越しに通す。LLM も本物の agy も使わない（fake バックエンドと tests/lib/fake-agy.mjs）。
//   - Pleiad の MCP 登録の API（秘密を返さない・暗号化の有無が分かる）
//   - 同名なら Pleiad の登録を優先する
//   - 1 件つながらない（要ログイン・起動失敗）ときも会話は進み、状態が会話の記録に残る
//   - antigravity の会話では、担当が Pleiad でもコンテキストを開かない（外部 MCP を起動しない）
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startServer, ROOT } from '../lib/server.mjs';
import { open } from '../lib/ws-client.mjs';

export const name = 'server-mcp-auth';
export const title = 'Pleiad の MCP 登録と認証の API・1 件失敗で会話を止めない・antigravity では Pleiad 担当を開かない';

export default async function (t) {
  const tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ply-mcp-server-')));
  const cwd = path.join(tmp, 'repo'), dataDir = path.join(tmp, 'data'), launches = path.join(tmp, 'launches.txt');
  const write = async (p, s) => { await fs.mkdir(path.dirname(p), { recursive: true }); await fs.writeFile(p, s); };
  let host, client;
  try {
    // 起動されたら印を残す MCP。MARK で「どの登録から起動されたか」が分かる
    const script = path.join(tmp, 'fixture.mjs');
    await write(script, `import fs from 'node:fs';import readline from 'node:readline';fs.appendFileSync(${JSON.stringify(launches)},(process.env.MARK||'?')+'\\n');for await(const line of readline.createInterface({input:process.stdin})){const m=JSON.parse(line);if(m.id===undefined)continue;const result=m.method==='initialize'?{protocolVersion:'2025-06-18',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}}:m.method==='tools/list'?{tools:[{name:'echo',inputSchema:{type:'object'}}]}:{};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');}`);
    await fs.mkdir(path.join(cwd, '.git'), { recursive: true });
    await write(path.join(cwd, '.mcp.json'), JSON.stringify({ mcpServers: {
      fixture: { command: process.execPath, args: [script], env: { MARK: 'native' } },
      broken: { command: process.execPath, args: ['-e', 'process.exit(3)'] },
    } }));

    host = await startServer({ dataDir, timeoutMs: 30_000, env: {
      AGENT_HOST_BACKENDS: 'fake,antigravity',
      AGENT_HOST_AGY_BIN: `node "${path.join(ROOT, 'tests', 'lib', 'fake-agy.mjs')}"`,
    } });
    client = await open(host);

    // ---- 登録の API。秘密は返さない。npm start 相当（Electron 無し）なので「暗号化されていない」と分かる
    const saved = await client.cmd('savePlyMcp', { name: 'fixture', mode: 'add', value: { transport: 'stdio', command: process.execPath, args: [script], env: { MARK: 'ply', API_KEY: 'ENV_SECRET_SENTINEL' } } });
    t.ok('Pleiad に MCP を登録できる', saved.name === 'fixture' && saved.storage?.encrypted === false, JSON.stringify(saved.storage));
    await client.cmd('savePlyMcp', { name: 'remote', mode: 'add', value: { transport: 'http', url: 'http://127.0.0.1:9/mcp', auth: 'oauth' } });
    await client.cmd('savePlyMcp', { name: 'token', mode: 'add', value: { transport: 'http', url: 'https://mcp.example/mcp', auth: 'bearer', bearerToken: 'BEARER_SECRET_SENTINEL' } });
    const list = await client.cmd('listPlyMcp', {});
    t.ok('一覧に秘密の値を含めない', !/SECRET_SENTINEL/.test(JSON.stringify(list)) && list.servers.length === 3, JSON.stringify(list).slice(0, 400));
    t.ok('暗号化されていないことを API で返す', list.storage.encrypted === false && Boolean(list.storage.reason));
    t.ok('OAuth の登録には認証の状態が付く', list.servers.find(s => s.name === 'remote')?.authStatus?.state === 'signed-out');
    const read = await client.cmd('readPlyMcp', { name: 'token' });
    t.ok('編集用の読み出しも伏せ字', read.value.bearerToken === '••••' && !JSON.stringify(read).includes('BEARER_SECRET_SENTINEL'));
    const status = await client.cmd('mcpAuthStatus', { name: 'remote' });
    t.ok('認証状態を個別に引ける', status.servers[0].state === 'signed-out');
    const logout = await client.cmd('mcpAuthLogout', { name: 'remote' });
    t.ok('ログインしていなければログアウトは失効を試みない', logout.revoked === false);
    await client.cmd('deletePlyMcp', { name: 'token' });
    t.ok('登録を消せる', (await client.cmd('listPlyMcp', {})).servers.length === 2);
    const probe = await client.cmd('mcpReconnect', { name: 'remote', cwd });
    t.ok('手動の接続確認: トークンが無ければ要ログイン', probe.status === 'needs-auth', JSON.stringify(probe));

    // ---- 名前の変更・全体の設定・ネイティブ登録の取り込み（API 越し）
    const renamed = await client.cmd('renamePlyMcp', { name: 'remote', to: 'remote2' });
    const afterRename = await client.cmd('listPlyMcp', {});
    t.ok('API で登録名を変えられる', renamed.name === 'remote2' && afterRename.servers.some(s => s.name === 'remote2') && !afterRename.servers.some(s => s.name === 'remote'));
    await client.cmd('renamePlyMcp', { name: 'remote2', to: 'remote' });
    // 名前で外した設定・同じ名前の定義の選択も新しい名前へ追随する（既定と場所の両方）
    const registry = (await client.cmd('listPlyMcp', {})).file ?? (await client.cmd('scanContext', { cwd })).entries.find(e => e.name === 'remote' && e.origins[0].source === 'ply')?.path;
    await client.cmd('setContextSettings', { place: null, kind: 'mcp', value: { owner: 'native', user: null, directory: null, disabled: ['remote'], prefer: { remote: registry, other: path.join(cwd, '.mcp.json') } } });
    await client.cmd('setContextSettings', { cwd, place: cwd, kind: 'mcp', value: { owner: 'native', user: null, directory: null, disabled: ['remote'] } });
    const follow = await client.cmd('renamePlyMcp', { name: 'remote', to: 'remote3' });
    const followView = await client.cmd('contextSettings', { cwd });
    const def = followView.defaults.kinds.mcp.value, here = followView.places.find(p => p.current)?.kinds.mcp.value;
    t.ok('名前を変えると、名前で外した設定も新しい名前で外れる（既定と場所の両方）', follow.settingsUpdated === 3 && def.disabled.includes('remote3') && here?.disabled.includes('remote3'), JSON.stringify({ registry, follow, def, here }));
    t.ok('Pleiad の登録を選んでいた同名の選択は新しい名前へ移り、エージェント側の選択はそのまま', Boolean(registry) && def.prefer.remote3 === registry && !('remote' in def.prefer) && def.prefer.other === path.join(cwd, '.mcp.json'), JSON.stringify(def.prefer));
    await client.cmd('renamePlyMcp', { name: 'remote3', to: 'remote' });
    await client.cmd('setContextSettings', { cwd, place: cwd, remove: true });
    await client.cmd('setContextSettings', { place: null, kind: 'mcp', value: null });
    const setting = await client.cmd('setPlyMcpSettings', { clientMetadataUrl: 'https://ply.example/oauth/client.json' });
    t.ok('Client ID Metadata Document の URL を設定でき、一覧に出る', setting.clientMetadataUrl === 'https://ply.example/oauth/client.json'
      && (await client.cmd('listPlyMcp', {})).settings.clientMetadataUrl === setting.clientMetadataUrl);
    await client.cmd('setPlyMcpSettings', { clientMetadataUrl: null });
    const imported = await client.cmd('importPlyMcp', { items: [{ format: 'claude', scope: 'directory', cwd, name: 'fixture', as: 'imported' }] });
    const importedRow = imported.results[0];
    t.ok('API でこの場所の .mcp.json の登録を取り込める（既定では env の値を写さない）', importedRow.ok && importedRow.pending.join() === 'env:MARK'
      && (await client.cmd('readPlyMcp', { name: 'imported' })).value.env.MARK === null, JSON.stringify(imported));
    await client.cmd('deletePlyMcp', { name: 'imported' });

    // ---- 担当を Pleiad に。ユーザー側は Pleiad の登録だけ、この場所は .mcp.json（Claude 形式）を読む
    // 指示・Skills は探さない。MCP はこの場所だけ Pleiad（ユーザー側の探索元なし＝Pleiad の登録だけ、この場所は Claude 形式）
    for (const kind of ['instruction', 'skill']) await client.cmd('setContextSettings', { place: null, kind, value: { owner: 'native', user: null, directory: null } });
    await client.cmd('setContextSettings', { cwd, place: cwd, kind: 'mcp', value: { owner: 'ply', user: { sources: [], excludePaths: [] }, directory: { sources: ['claude'], excludePaths: [] } } });
    const scan = await client.cmd('scanContext', { cwd });
    const nativeFixture = scan.entries.find(e => e.name === 'fixture' && e.origins[0].source === 'claude');
    t.ok('コンテキスト画面の探索でも、同名のエージェント側の登録は Pleiad に隠れる', nativeFixture?.status === 'shadowed' && scan.entries.some(e => e.name === 'fixture' && e.origins[0].source === 'ply' && e.status === 'candidate'));

    const session = await client.cmd('newSession', { cwd, backend: 'fake' });
    const turn = await client.runTurn({ ...session, prompt: 'echo:hello' }, { ms: 60_000 });
    t.ok('つながらない MCP があっても会話は完了する', turn.outcome === 'ok', JSON.stringify(turn.events.filter(e => e.type === 'turnResult')));
    const record = await client.cmd('sessionContext', { sessionId: turn.sessionId ?? session.sessionId });
    const rows = record?.report?.entries ?? [];
    const plyFixture = rows.find(e => e.name === 'fixture' && e.status === 'connected');
    t.ok('Pleiad の登録が優先されて接続し、ツール数が残る', plyFixture?.tools === 1 && (await fs.readFile(launches, 'utf8')).trim() === 'ply', JSON.stringify(rows.map(e => [e.name, e.status])));
    t.ok('同名のエージェント側の登録は起動しない', rows.some(e => e.name === 'fixture' && e.status === 'shadowed'));
    t.ok('要ログインの MCP は理由付きで記録される', rows.find(e => e.name === 'remote')?.status === 'needs-auth' && Boolean(rows.find(e => e.name === 'remote')?.reason));
    t.ok('起動できない MCP は失敗として記録される', rows.find(e => e.name === 'broken')?.status === 'failed' && Boolean(rows.find(e => e.name === 'broken')?.reason));
    t.ok('会話の記録に秘密の値を含めない', !JSON.stringify(record).includes('ENV_SECRET_SENTINEL'));

    // ---- antigravity の会話。担当が Pleiad でもコンテキストを開かない
    const launchedBefore = await fs.readFile(launches, 'utf8');
    const agy = await client.runTurn({ prompt: 'こんにちは', sessionId: null, cwd, backend: 'antigravity', mode: 'yolo' }, { ms: 60_000 });
    t.ok('antigravity の会話は進む', agy.outcome === 'ok' && Boolean(agy.sessionId), JSON.stringify(agy.events.filter(e => e.type === 'turnResult')));
    t.ok('antigravity では外部 MCP を起動しない', (await fs.readFile(launches, 'utf8')) === launchedBefore);
    const guarded = await client.cmd('sessionContext', { sessionId: agy.sessionId });
    t.ok('エージェント任せとして扱ったことと理由を記録する', guarded?.report?.status === 'native' && guarded.report.guardedBackend === 'antigravity' && /Antigravity/.test(guarded.report.reason ?? '') && guarded.owners.mcp === 'ply', JSON.stringify(guarded?.report));
  } finally {
    client?.close(); await host?.stop();
    await fs.rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}
