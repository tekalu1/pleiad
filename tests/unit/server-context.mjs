// 会話ごとのコンテキストの操作をサーバー越しに通す（fake バックエンド。LLM は呼ばない）。
//   - 設定の即時保存（setContextSettings が保存した結果の画面の形を返す）
//   - 「この会話では外す」: 次のターンから接続しない・ツールを出さない。戻すとまたつなぐ
//   - 開始後に変わった指示の検出（更新時刻つき）・差分・「新しい内容で会話を続ける」
//   - エージェント任せの MCP の見比べ（各エージェントの登録を読むだけ）
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../lib/server.mjs';
import { open } from '../lib/ws-client.mjs';

export const name = 'server-context';
export const title = 'この会話のコンテキスト: 即時保存・この会話では外す・読み込み直し・差分・エージェント任せの MCP';

export default async function (t) {
  const tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ply-server-context-')));
  const cwd = path.join(tmp, 'repo'), dataDir = path.join(tmp, 'data'), launches = path.join(tmp, 'launches.txt');
  const write = async (p, s) => { await fs.mkdir(path.dirname(p), { recursive: true }); await fs.writeFile(p, s); };
  const count = async () => (await fs.readFile(launches, 'utf8').catch(() => '')).split('\n').filter(Boolean).length;
  let host, client;
  try {
    const script = path.join(tmp, 'fixture.mjs');
    await write(script, `import fs from 'node:fs';import readline from 'node:readline';fs.appendFileSync(${JSON.stringify(launches)},'launch\\n');for await(const line of readline.createInterface({input:process.stdin})){const m=JSON.parse(line);if(m.id===undefined)continue;const result=m.method==='initialize'?{protocolVersion:'2025-06-18',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}}:m.method==='tools/list'?{tools:[{name:'echo',inputSchema:{type:'object'}}]}:{};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');}`);
    await fs.mkdir(path.join(cwd, '.git'), { recursive: true });
    await write(path.join(cwd, 'AGENTS.md'), 'FIRST_VERSION');
    await write(path.join(cwd, '.mcp.json'), JSON.stringify({ mcpServers: { fixture: { command: process.execPath, args: [script] }, remote: { url: 'https://user:PASS@mcp.example.com/mcp?key=SECRET' } } }));
    await write(path.join(cwd, '.codex/config.toml'), '[mcp_servers.fixture]\ncommand = "node"\n[mcp_servers.codexonly]\ncommand = "node"\n');

    host = await startServer({ dataDir, env: { AGENT_HOST_BACKENDS: 'fake' } });
    client = await open(host);

    // ---- 即時保存。指示は Pleiad（この場所の AGENTS.md だけ）、MCP は Pleiad（この場所の .mcp.json の fixture だけ）
    const none = { sources: [], excludePaths: [] };
    let view = await client.cmd('setContextSettings', { cwd, place: cwd, kind: 'instruction', value: { owner: 'ply', user: none, directory: { sources: ['common'], excludePaths: [] } } });
    t.ok('保存するとその場の画面の形が返る', view.places.find(p => p.current)?.kinds.instruction.override === true && view.places.find(p => p.current)?.overrides === 1, JSON.stringify(view.places.map(p => [p.path, p.overrides])));
    await client.cmd('setContextSettings', { cwd, place: null, kind: 'skill', value: { owner: 'native', user: none, directory: none } });
    view = await client.cmd('setContextSettings', { cwd, place: cwd, kind: 'mcp', value: { owner: 'ply', user: none, directory: { sources: ['claude'], excludePaths: [] }, disabled: ['remote'] } });
    t.ok('既定の変更と場所の変更が別々に残る', view.defaults.kinds.skill.value.user.sources.length === 0 && view.places.find(p => p.current)?.overrides === 2);
    const scan = await client.cmd('scanContext', { cwd });
    t.ok('名前で外した MCP は除外（同じ設定ファイルの他の登録は残る）', scan.entries.find(e => e.name === 'remote')?.status === 'excluded' && scan.entries.find(e => e.name === 'fixture')?.status === 'candidate');
    t.ok('探索結果の接続先はホストとパスだけ', scan.entries.find(e => e.name === 'remote')?.endpoint === 'mcp.example.com/mcp' && !JSON.stringify(scan.entries).includes('PASS') && !JSON.stringify(scan.entries).includes('SECRET'));
    const defaults = await client.cmd('scanContext', { cwd, place: 'default' });
    t.ok('「すべての場所」の探索は場所の上書きを使わない', defaults.entries.find(e => e.name === 'remote')?.status === 'candidate' && !defaults.entries.some(e => e.kind === 'skill'));

    // ---- 会話を始める。fixture がつながる
    const session = await client.cmd('newSession', { cwd, backend: 'fake' });
    let turn = await client.runTurn({ ...session, prompt: 'echo:one' }, { ms: 60_000 });
    let record = await client.cmd('sessionContext', session);
    t.ok('会話が始まり、MCP がつながる', turn.outcome === 'ok' && record.report.entries.find(e => e.name === 'fixture')?.status === 'connected' && await count() === 1);
    const progress = turn.events.filter(e => e.type === 'activity' && e.state === 'preparing');
    t.ok('MCP 接続の進み具合を発言の後に流し、接続後は考え中に戻る',
      progress.some(e => e.current === 1 && e.total === 1)
      && turn.events.findIndex(e => e.type === 'userMessage') < turn.events.indexOf(progress.find(e => e.current === 1))
      && turn.events.some(e => e.type === 'activity' && e.state === 'thinking' && turn.events.indexOf(e) > turn.events.indexOf(progress.find(p => p.current === 1))));
    t.ok('方針を決めた時刻が記録に残る', typeof record.startedAt === 'string' && record.refreshedAt === null);
    const startedAt = record.startedAt;

    // ---- この会話では外す → 次のターンから起動しない。戻すとまたつなぐ
    await client.cmd('setSessionMcp', { ...session, name: 'fixture', removed: true });
    record = await client.cmd('sessionContext', session);
    t.ok('外すとすぐ記録に出る', record.removedMcp.join() === 'fixture' && record.report.entries.find(e => e.name === 'fixture')?.status === 'removed');
    turn = await client.runTurn({ ...session, prompt: 'echo:two' }, { ms: 60_000 });
    record = await client.cmd('sessionContext', session);
    t.ok('外した MCP は次のターンで起動しない', turn.outcome === 'ok' && await count() === 1 && record.report.entries.find(e => e.name === 'fixture')?.status === 'removed');
    const other = await client.cmd('newSession', { cwd, backend: 'fake' });
    await client.runTurn({ ...other, prompt: 'echo:other' }, { ms: 60_000 });
    t.ok('ほかの会話では外れない', (await client.cmd('sessionContext', other)).report.entries.find(e => e.name === 'fixture')?.status === 'connected' && await count() === 2);
    await client.cmd('setSessionMcp', { ...session, name: 'fixture', removed: false });
    turn = await client.runTurn({ ...session, prompt: 'echo:three' }, { ms: 60_000 });
    record = await client.cmd('sessionContext', session);
    t.ok('戻すと次のターンでまたつなぐ', record.removedMcp.length === 0 && record.report.entries.find(e => e.name === 'fixture')?.status === 'connected' && await count() === 3);
    await client.cmd('setSessionMcp', { ...session, name: '../bad', removed: true }).then(() => t.ok('不正な名前は拒む', false), () => t.ok('不正な名前は拒む', true));

    // ---- 開始後に指示が変わった → 変わったファイルと時刻・差分・読み込み直し
    await write(path.join(cwd, 'AGENTS.md'), 'SECOND_VERSION');
    record = await client.cmd('sessionContext', session);
    const changed = record.changed?.files?.[0];
    t.ok('変わったファイルを更新時刻つきで返す', record.changed?.differs === true && changed?.path === path.join(cwd, 'AGENTS.md') && typeof changed.modifiedAt === 'string', JSON.stringify(record.changed));
    const diff = await client.cmd('contextDiff', session);
    t.ok('差分: 開始時の中身と今の中身', diff.files[0]?.before === 'FIRST_VERSION' && diff.files[0]?.after === 'SECOND_VERSION' && !diff.files[0].beforeMissing, JSON.stringify(diff));
    turn = await client.runTurn({ ...session, prompt: 'echo:changed' }, { ms: 60_000 });
    record = await client.cmd('sessionContext', session);
    t.ok('変わっていても送れる（送信時に自動で読み込み直す）', turn.outcome === 'ok' && record.changed?.differs === false && typeof record.refreshedAt === 'string' && record.startedAt === startedAt, JSON.stringify({ outcome: turn.outcome, changed: record.changed, refreshedAt: record.refreshedAt }));
    await write(path.join(cwd, 'AGENTS.md'), 'THIRD_VERSION');
    await client.cmd('refreshContext', session);
    record = await client.cmd('sessionContext', session);
    t.ok('送信を待たずに読み込み直せる（開始時刻は保つ）', record.changed?.differs === false && typeof record.refreshedAt === 'string' && record.startedAt === startedAt);
    turn = await client.runTurn({ ...session, prompt: 'echo:after' }, { ms: 60_000 });
    const messages = (await client.cmd('loadSession', session)).messages;
    t.ok('読み込み直したあとも同じ会話で続けられる（やり取りは引き継ぐ）', turn.outcome === 'ok' && messages.some(m => m.text === 'echo:one') && messages.some(m => m.text === 'echo:after'), JSON.stringify(messages.map(m => m.text)));

    // ---- 再開で作業場所を変える → 止めずに新しい場所の設定で解き直す（担当も探す範囲も新しい場所の設定に従う）
    const moved = path.join(tmp, 'moved');
    await fs.mkdir(path.join(moved, '.git'), { recursive: true });
    await write(path.join(moved, 'AGENTS.md'), 'MOVED_VERSION');
    await client.cmd('setContextSettings', { cwd: moved, place: moved, kind: 'instruction', value: { owner: 'ply', user: none, directory: { sources: ['common'], excludePaths: [] } } });
    await client.cmd('setContextSettings', { cwd: moved, place: moved, kind: 'mcp', value: { owner: 'native', user: none, directory: none } });
    turn = await client.runTurn({ ...session, cwd: moved, prompt: 'echo:moved' }, { ms: 60_000 });
    record = await client.cmd('sessionContext', session);
    const movedReal = await fs.realpath(moved);
    t.ok('共通コンテキストの会話も作業場所を変えて送れる', turn.outcome === 'ok', turn.outcome);
    t.ok('新しい作業場所で指示を探し直す（担当は新しい場所の設定に従う）', record.report.cwd === movedReal && record.report.owners.instruction === 'ply' && record.report.owners.mcp === 'native'
      && record.report.entries.some(e => e.kind === 'instruction' && e.path === path.join(movedReal, 'AGENTS.md'))
      && !record.report.entries.some(e => e.path === path.join(cwd, 'AGENTS.md')) && record.startedAt === startedAt, JSON.stringify(record.report.entries.map(e => e.path)));
    const native = await client.cmd('newSession', { cwd: tmp, backend: 'fake' });
    await client.runTurn({ ...native, prompt: 'echo:native' }, { ms: 60_000 });
    await client.cmd('refreshContext', native).then(() => t.ok('Pleiad がそろえていない会話は読み込み直せない', false), () => t.ok('Pleiad がそろえていない会話は読み込み直せない', true));

    // ---- 設定の変更は、始まっている会話にも次のターンから効く（担当・外部 MCP の有効／無効）
    const follow = path.join(tmp, 'follow');
    await fs.mkdir(path.join(follow, '.git'), { recursive: true });
    await write(path.join(follow, '.mcp.json'), JSON.stringify({ mcpServers: { fixture: { command: process.execPath, args: [script] } } }));
    const fs1 = await client.cmd('newSession', { cwd: follow, backend: 'fake' });
    await client.runTurn({ ...fs1, prompt: 'echo:follow-1' }, { ms: 60_000 });
    record = await client.cmd('sessionContext', fs1);
    const followStarted = record.startedAt;
    t.ok('全体の設定がエージェント任せなら、会話もエージェント任せで始まる', record.report.owners.mcp === 'native' && record.refreshedAt === null);
    const beforeFollow = await count();
    view = await client.cmd('setContextSettings', { cwd: follow, place: null, kind: 'mcp', value: { owner: 'ply', user: none, directory: { sources: ['claude'], excludePaths: [] } } });
    t.ok('全体の設定を変えても、今の場所の設定は増えない', !view.places.some(p => p.saved && p.path === follow) && view.places.find(p => p.current)?.overrides === 0);
    turn = await client.runTurn({ ...fs1, prompt: 'echo:follow-2' }, { ms: 60_000 });
    record = await client.cmd('sessionContext', fs1);
    t.ok('全体の設定の変更が、次のターンから始まっている会話に効く', turn.outcome === 'ok' && record.report.owners.mcp === 'ply'
      && record.report.entries.find(e => e.name === 'fixture')?.status === 'connected' && await count() === beforeFollow + 1, JSON.stringify(record.report.owners));
    t.ok('反映したことを記録する（開始時刻は保つ）', typeof record.refreshedAt === 'string' && record.startedAt === followStarted);
    const history = JSON.parse(await fs.readFile(path.join(dataDir, 'sessions.json'), 'utf8'))[fs1.sessionId]?.history ?? [];
    t.ok('反映したことが会話の履歴に残る', history.some(h => h.field === 'context' && h.reasonKey === 'contextSettingsApplied'), JSON.stringify(history).slice(0, 400));
    await client.cmd('setContextSettings', { cwd: follow, place: null, kind: 'mcp', value: { owner: 'ply', user: none, directory: { sources: ['claude'], excludePaths: [] }, disabled: ['fixture'] } });
    await client.runTurn({ ...fs1, prompt: 'echo:follow-3' }, { ms: 60_000 });
    record = await client.cmd('sessionContext', fs1);
    t.ok('外部 MCP を設定で無効にすると、次のターンから接続しない', record.report.entries.find(e => e.name === 'fixture')?.status === 'excluded' && await count() === beforeFollow + 1);
    await client.cmd('setContextSettings', { cwd: follow, place: null, kind: 'mcp', value: null });

    // ---- エージェント任せの MCP。各エージェントの登録（読むだけ）
    const launchedBefore = await count();
    const agents = await client.cmd('agentMcp', { cwd });
    t.ok('Claude と Codex の登録を別々に返す', agents.agents.claude.some(s => s.name === 'fixture') && agents.agents.codex.some(s => s.name === 'codexonly') && agents.agents.codex.some(s => s.name === 'fixture'));
    t.ok('探索の設定（名前での除外）に関係なく並べる', agents.agents.claude.some(s => s.name === 'remote' && s.endpoint === 'mcp.example.com/mcp'));
    t.ok('エージェント任せの一覧でも起動しない', await count() === launchedBefore);

    // ---- 渡し済みの本文の控え（contextSession.delivered）。ターンをまたいで持ち越し、圧縮・読み込み直し・分岐の引き継ぎ・編集して再送信で捨てる
    const dedup = path.join(tmp, 'dedup');
    await fs.mkdir(path.join(dedup, '.git'), { recursive: true });
    await write(path.join(dedup, 'AGENTS.md'), 'DEDUP_ROOT');
    await write(path.join(dedup, 'sub/AGENTS.md'), 'DEDUP_SUB');
    await client.cmd('setContextSettings', { cwd: dedup, place: dedup, kind: 'instruction', value: { owner: 'ply', user: none, directory: { sources: ['common'], excludePaths: [] } } });
    const ask = (extra = {}) => `context:${JSON.stringify({ name: 'instructions_for_path', arguments: { id: path.join(dedup, 'sub', 'x.ts'), ...extra } })}`;
    const said = r => r.events.filter(e => e.type === 'text.delta').map(e => e.text).join('');
    const fetchSub = async (s, extra) => said(await client.runTurn({ ...s, prompt: ask(extra) }, { ms: 60_000 }));
    // 会話の言語は日本語（テストは AGENT_HOST_LOCALE=ja）。英語の会話では 'Already provided in this conversation: '（tests/unit/i18n-agent.mjs）
    const isShort = text => text.startsWith('この会話で渡し済み: ') && !text.includes('DEDUP_SUB');
    const dd = await client.cmd('newSession', { cwd: dedup, backend: 'fake' });
    t.ok('初回は子階層の指示の本文を渡す', (await fetchSub(dd)).includes('DEDUP_SUB'));
    let text = await fetchSub(dd);
    t.ok('次のターンでも渡し済みを覚えていて、短い一行だけ返す', isShort(text), text);
    t.ok('full: true なら本文を返す', (await fetchSub(dd, { full: true })).includes('DEDUP_SUB'));
    await client.runTurn({ ...dd, prompt: 'compact' }, { ms: 60_000 });
    t.ok('文脈の圧縮（activity compacting）の後は本文を渡し直す', (await fetchSub(dd)).includes('DEDUP_SUB'));
    t.ok('渡し直した後はまた短い一行', isShort(await fetchSub(dd)));
    await client.cmd('refreshContext', dd);
    t.ok('読み込み直しの後は本文を渡し直す', (await fetchSub(dd)).includes('DEDUP_SUB'));
    const ddMessages = (await client.cmd('loadSession', dd)).messages;
    const branch = await client.cmd('fork', { ...dd, upToMessageId: ddMessages.at(-1).uuid });
    t.ok('ホスト側で写した分岐の最初のターン（履歴の引き継ぎ）では本文を渡し直す', (await fetchSub(branch)).includes('DEDUP_SUB'));
    t.ok('分岐先でもその後は短い一行', isShort(await fetchSub(branch)));
    const edited = await client.cmd('fork', { ...dd, beforeMessageId: ddMessages.find(m => m.role === 'user').uuid });
    t.ok('編集して再送信（最初の発言から。引き継ぐ履歴が無い）の分岐では本文を渡し直す', (await fetchSub(edited)).includes('DEDUP_SUB'));
    // 履歴そのものを写すネイティブの分岐（Pleiad の会話の記録を持たない会話。Claude の SDK の分岐と同じ経路）は控えを引き継ぐ
    const nativeTurn = await client.runTurn({ cwd: dedup, backend: 'fake', prompt: ask() }, { ms: 60_000 });
    const nativeFork = await client.cmd('fork', { sessionId: nativeTurn.sessionId, upToMessageId: (await client.cmd('loadSession', { sessionId: nativeTurn.sessionId })).messages.at(-1).uuid });
    text = await fetchSub(nativeFork);
    t.ok('履歴そのものを写す分岐は控えを引き継ぐ', said(nativeTurn).includes('DEDUP_SUB') && isShort(text), text);
  } finally {
    client?.close(); await host?.stop();
    await fs.rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}
