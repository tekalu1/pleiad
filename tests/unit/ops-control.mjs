// 操作の一覧をサーバー越しに（fake バックエンド。LLM もネットワークも要らない）。
//   - control.json: 場所・中身・権限・pid・種類。終了時に自分のものだけ消す
//   - HTTP の認証: トークン無し・知らないトークン・画面のトークン・別の口のトークンは通らない。CLI 用トークンは /api/ops だけに効く
//   - 会話への束縛: ply_control の接続は全会話に渡り、同じトークンで CLI（環境変数）も同じ会話に束縛される。会話ごとに別
//   - 権限の配線: 会話の承認モード（bypass・ask・plan）→ policy。束縛なしは NEEDS_UI。human-only は agent に見えない
//   - human-only は 5 つだけ（ADR 0094）: 外した操作は agent の一覧に出て呼べ（同じ本体・記録は by: agent）、5 つは一覧にも呼び出しにも出ない
//   - 承認カード: ask の会話の guarded は会話にカード（settingChange）を出し、待たずに承認待ち（202・requestId）で返る。許可・拒否・受領証の不一致。
//     結果は会話へ届く（ターンの終わり・途中送信・置き換え・聞き直し・再起動は server-setting-approval）。settings.set の実物と settingsChanged の配信
//   - 記録: by: 'agent'・via・どの会話の AI か。人間の操作は by: 'human' のまま
//   - T6 伏せ字: 秘密に目印を入れた使い捨てのデータ置き場で、全 read 操作を呼んでも目印が出ない
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startServer, ROOT } from '../lib/server.mjs';
import { open } from '../lib/ws-client.mjs';
import { controlFilePath, removeControlFile, writeControlFile, CONTROL_VERSION } from '../../core/control-file.mjs';
import { registry } from '../../core/ops/index.mjs';
import { HUMAN_ONLY_COMMANDS, HUMAN_ONLY_SETTINGS } from '../../core/ops/policy.mjs';

export const name = 'ops-control';
export const title = '操作の一覧をサーバー越しに: control.json・HTTP の認証・会話への束縛・権限の配線・記録・伏せ字';

const MARKER = 'SECRET-MARKER-5c1d9';
const pkg = JSON.parse(await fs.readFile(path.join(ROOT, 'package.json'), 'utf8'));

export default async function (t) {
  const scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'agent-host-ops-control-')));
  const dataDir = path.join(scratch, 'data');
  await fs.mkdir(dataDir, { recursive: true });
  // 秘密の場所に目印を入れておく。どの read 操作の返りにも出ないこと（T6）
  await fs.writeFile(path.join(dataDir, 'mcp-secrets.json'), JSON.stringify({ version: 1, secrets: { 'mcp:x:static': MARKER } }));
  await fs.writeFile(path.join(dataDir, 'compat-endpoint-secrets.json'), JSON.stringify({ 'delegation-routing:jev': { key: MARKER } }));
  await fs.writeFile(path.join(dataDir, 'claude-accounts.json'), JSON.stringify({ accounts: [{ id: 'a1', name: 'main', token: MARKER }] }));
  await fs.writeFile(path.join(dataDir, 'prefs.json'), JSON.stringify({
    agentSitePermissions: [{ origin: 'https://a.example', mode: 'always', token: MARKER, apiKey: MARKER }],
    computerUse: { enabled: true, secret: MARKER }, delegationRouting: { enabled: false, apiKey: MARKER }, linkOpen: 'external',
  }));

  const server = await startServer({ env: { AGENT_HOST_BACKENDS: 'fake' }, dataDir, timeoutMs: 60_000 });
  const c = await open({ port: server.port, token: server.token });
  const base = `http://127.0.0.1:${server.port}`;
  try {
    // ---- control.json
    const file = JSON.parse(await fs.readFile(controlFilePath(dataDir), 'utf8'));
    t.ok('control.json: version・pid・origin・cliToken・startedAt・appVersion・kind', file.version === CONTROL_VERSION && Number.isInteger(file.pid) && file.origin === base && /^[a-f0-9]{64}$/.test(file.cliToken)
      && file.startedAt > 0 && file.appVersion === pkg.version && file.kind === 'server', JSON.stringify({ ...file, cliToken: '…' }));
    t.ok('control.json: pid は生きているプロセス（CLI が古いファイルを見分ける）', (() => { try { process.kill(file.pid, 0); return true; } catch { return false; } })());
    if (process.platform !== 'win32') t.ok('control.json: 権限 0600（秘密を含む）', ((await fs.stat(controlFilePath(dataDir))).mode & 0o777) === 0o600);
    t.ok('CLI 用トークンは画面のトークンと別', file.cliToken !== server.token);

    const api = async (token, method, p, body, headers = {}) => {
      const res = await fetch(base + p, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers }, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
      return { status: res.status, body: await res.json().catch(() => null) };
    };
    const cli = file.cliToken;

    // ---- 認証
    t.ok('トークン無しは 401', (await api(null, 'GET', '/api/ops')).status === 401 && (await api(null, 'POST', '/api/ops/app.status', {})).status === 401);
    t.ok('知らないトークンは 401', (await api('f'.repeat(64), 'GET', '/api/ops')).status === 401);
    t.ok('画面のトークンは Bearer でも ?token= でも通らない', (await api(server.token, 'GET', '/api/ops')).status === 401 && (await api(null, 'GET', `/api/ops?token=${server.token}`)).status === 401);
    t.ok('CLI 用トークンは画面（静的ファイル）・MCP の口・WS に効かない', (await fetch(`${base}/?token=${cli}`)).status === 401 && (await api(cli, 'POST', '/mcp/control', { jsonrpc: '2.0', id: 1, method: 'ping' })).status === 401
      && (await fetch(`${base}/index.html`, { headers: { authorization: `Bearer ${cli}` } })).status === 401);
    t.ok('画面のトークンは ply_control の口に効かない', (await api(server.token, 'POST', '/mcp/control', { jsonrpc: '2.0', id: 1, method: 'ping' })).status === 401);
    const wsRejected = await open({ port: server.port, token: cli }).then(() => false, () => true);
    t.ok('CLI 用トークンでは WS につながらない', wsRejected);
    t.ok('メソッドの違いは 405（GET /api/ops/<id>・POST /api/ops・DELETE）', (await api(cli, 'GET', '/api/ops/app.status')).status === 405 && (await api(cli, 'POST', '/api/ops', {})).status === 405 && (await api(cli, 'DELETE', '/api/ops')).status === 405);
    t.ok('壊れたパーセント符号のパスは 404（例外でサーバーが落ちない）', (await api(cli, 'POST', '/api/ops/%E0%A4%A', {})).status === 404 && (await api(cli, 'GET', '/api/ops')).status === 200);
    t.ok('別のページ（Origin が違う）からは 403', (await api(cli, 'GET', '/api/ops', undefined, { origin: 'http://evil.example' })).status === 403);

    // ---- 一覧と呼び出し（会話に束縛されない CLI）
    const listed = await api(cli, 'GET', '/api/ops');
    const ids = listed.body.result.ops.map((o) => o.id);
    t.ok('GET /api/ops: 版・言語・面・操作（id・説明・危険度・入力の JSON Schema・CLI の形）', listed.status === 200 && /^[a-f0-9]{16}$/.test(listed.body.result.revision) && listed.body.result.surface === 'cli'
      && listed.body.result.ops.every((o) => o.id && o.summary && o.risk && o.input?.type === 'object' && 'cli' in o) && ids.includes('sessions.list') && ids.includes('settings.get'));
    t.ok('GET /api/ops: 言語は x-pleiad-locale で決める（ja と en で説明が違う）', (await api(cli, 'GET', '/api/ops', undefined, { 'x-pleiad-locale': 'en' })).body.result.ops.find((o) => o.id === 'app.status').summary
      !== listed.body.result.ops.find((o) => o.id === 'app.status').summary);
    t.ok('GET /api/ops?surface=mcp: pleiad mcp 用（直に出す操作にツール名）', (await api(cli, 'GET', '/api/ops?surface=mcp')).body.result.ops.some((o) => o.mcp === 'direct' && o.tool));
    t.ok('human-only の代役（probe.humanOnly）は agent の一覧に出ない', !ids.includes('probe.humanOnly') && !(await api(cli, 'GET', '/api/ops?surface=mcp')).body.result.ops.some((o) => o.id === 'probe.humanOnly'));
    const status = await api(cli, 'POST', '/api/ops/app.status', {});
    t.ok('POST /api/ops/<id>: app.status', status.status === 200 && status.body.ok === true && status.body.result.version === pkg.version);
    t.ok('本文が空でも {} として通る', (await api(cli, 'POST', '/api/ops/app.status')).status === 200);
    const notFound = await api(cli, 'POST', '/api/ops/nothing.here', {});
    t.ok('無い操作は 404 と code: NOT_FOUND', notFound.status === 404 && notFound.body.code === 'NOT_FOUND' && notFound.body.ok === false);
    t.ok('human-only を呼ぶと、無い操作と同じ 404（在ることを明かさない）', (await api(cli, 'POST', '/api/ops/probe.humanOnly', {})).status === 404);
    const invalid = await api(cli, 'POST', '/api/ops/sessions.list', { limit: 1000 });
    t.ok('引数の誤りは 400 と code: INVALID と issues', invalid.status === 400 && invalid.body.code === 'INVALID' && invalid.body.issues[0].path === 'limit');
    t.ok('本文が JSON でない・オブジェクトでないと 400', (await api(cli, 'POST', '/api/ops/app.status', '{')).status === 400 && (await api(cli, 'POST', '/api/ops/app.status', [1])).status === 400);
    t.ok('本文が大きすぎると 413', (await api(cli, 'POST', '/api/ops/app.status', { pad: 'x'.repeat(300_000) })).status === 413);
    const guarded = await api(cli, 'POST', '/api/ops/probe.guarded', {});
    t.ok('束縛されない CLI の guarded は 403 と NEEDS_UI（画面へ誘導）', guarded.status === 403 && guarded.body.code === 'NEEDS_UI', JSON.stringify(guarded.body));
    t.ok('束縛されない主体では write は通る（会話の id を省けないので INVALID）', (await api(cli, 'POST', '/api/ops/sessions.setTitle', { title: 'x' })).body.code === 'INVALID');

    // ---- 会話に束縛された接続（ply_control は全会話に渡る）
    const start = async (mode) => {
      const turn = await c.runTurn({ prompt: 'control-info', sessionId: null, cwd: ROOT, backend: 'fake', mode }, { ms: 30_000 });
      const loaded = await c.cmd('loadSession', { sessionId: turn.sessionId });
      return { sessionId: turn.sessionId, info: JSON.parse(loaded.messages.at(-1).text) };
    };
    const ask = await start('default'), bypass = await start('bypass'), plan = await start('plan');
    // 承認カードを出す会話（結果の通知でターンが増えるので、後で本文を読む ask とは分ける）
    const asker = await start('default');
    t.ok('全会話に ply_control が渡り、環境変数（PLEIAD_CONTROL_URL・TOKEN）と指示文がある', ask.info.url === `${base}/mcp/control` && ask.info.env.join() === 'PLEIAD_CONTROL_URL,PLEIAD_CONTROL_TOKEN'
      && ask.info.envUrl === base && ask.info.sameToken === true && /list_ops/.test(ask.info.instructions) && /^[a-f0-9]{64}$/.test(ask.info.token));
    t.ok('会話ごとに別のトークン（CLI 用トークンとも別）', new Set([ask.info.token, bypass.info.token, plan.info.token, asker.info.token, cli]).size === 5);
    const again = await c.runTurn({ prompt: 'control-info', sessionId: ask.sessionId, cwd: ROOT, backend: 'fake', mode: 'default' }, { ms: 30_000 });
    t.ok('同じ会話の次のターンも同じ接続（会話のあいだ同じ口。agy は起動時にしか渡せない）', JSON.parse((await c.cmd('loadSession', { sessionId: again.sessionId })).messages.at(-1).text).token === ask.info.token);
    t.ok('指示文は 3〜4 行（会話の言語）', ask.info.instructions.split('\n').length >= 3 && ask.info.instructions.split('\n').length <= 4);

    const bound = (s) => s.info.token;
    const boundList = await api(bound(ask), 'GET', '/api/ops');
    t.ok('会話の接続のトークンでも /api/ops が使える（CLI として。環境変数 PLEIAD_CONTROL_TOKEN）', boundList.status === 200 && boundList.body.result.surface === 'cli');
    t.ok('会話の接続のトークンは surface=mcp を名乗れない（pleiad mcp は束縛されない用）', (await api(bound(ask), 'GET', '/api/ops?surface=mcp')).body.result.surface === 'cli');

    // 書く操作: 束縛された会話（sessionId を省いた先）。記録は by: 'agent'・via・どの会話か
    const wrote = await api(bound(ask), 'POST', '/api/ops/sessions.setTitle', { title: '束縛された題', reason: '整理' });
    t.ok('束縛された CLI は、sessionId を省けばその会話の題を変える', wrote.status === 200 && wrote.body.result.sessionId === ask.sessionId && wrote.body.result.title === '束縛された題', JSON.stringify(wrote.body));
    const got = await api(cli, 'POST', '/api/ops/sessions.get', { sessionId: ask.sessionId });
    const titleChange = got.body.result.changes.find((x) => x.field === 'title' && x.to === '束縛された題');
    t.ok('記録: by: agent・via: cli・どの会話の AI か・理由', titleChange?.by === 'agent' && titleChange.via === 'cli' && titleChange.bySession === ask.sessionId && titleChange.reason === '整理', JSON.stringify(titleChange));
    t.ok('記録: 呼んだ操作が会話の記録に残る（field: op）', got.body.result.changes.some((x) => x.field === 'op' && x.to === 'sessions.setTitle' && x.by === 'agent' && x.via === 'cli'));
    t.ok('一覧の題も変わる（人間の操作と同じ store）', (await c.cmd('listSessions')).find((s) => s.id === ask.sessionId)?.title === '束縛された題');
    t.ok('題の変更が画面へイベントで届く（by: agent）', c.events.some((e) => e.type === 'title' && e.sessionId === ask.sessionId && e.by === 'agent' && e.title === '束縛された題'));
    const otherTitle = await api(bound(bypass), 'POST', '/api/ops/sessions.setTitle', { sessionId: ask.sessionId, title: '別の会話から' });
    const afterOther = (await api(cli, 'POST', '/api/ops/sessions.get', { sessionId: ask.sessionId })).body.result;
    t.ok('別の会話の題も変えられ（write）、どの会話の AI かが残る', otherTitle.status === 200 && afterOther.title === '別の会話から' && afterOther.changes.find((x) => x.to === '別の会話から')?.bySession === bypass.sessionId);
    const viaMcp = await api(bound(plan), 'POST', '/mcp/control', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'call_op', arguments: { op: 'sessions.list', args: { limit: 1 } } } });
    t.ok('ply_control の MCP でも同じトークンで呼べる（読む操作は読み取りの会話でも通る）', viaMcp.body.result.isError !== true && JSON.parse(viaMcp.body.result.content[0].text).sessions.length === 1);

    // 人間の操作は by: human のまま
    await c.cmd('invoke', { op: 'sessions.setTitle', args: { sessionId: bypass.sessionId, title: '人間が変えた題' } });
    await c.cmd('setTitle', { sessionId: plan.sessionId, title: '昔のコマンドで変えた題' });
    const humanRow = (await api(cli, 'POST', '/api/ops/sessions.get', { sessionId: bypass.sessionId })).body.result.changes.find((x) => x.to === '人間が変えた題');
    const legacyRow = (await api(cli, 'POST', '/api/ops/sessions.get', { sessionId: plan.sessionId })).body.result.changes.find((x) => x.to === '昔のコマンドで変えた題');
    t.ok('人間の操作（WS の invoke・昔の setTitle コマンド）は by: human で、via・bySession を持たない', humanRow?.by === 'human' && !('via' in humanRow) && legacyRow?.by === 'human' && !('via' in legacyRow));
    t.ok('人間の画面からは sessionId を省けない（INVALID）', await c.cmd('invoke', { op: 'sessions.setTitle', args: { title: 'x' } }).then(() => false, (e) => e.code === 'INVALID'));

    // 状態
    const setStatus = await api(bound(ask), 'POST', '/api/ops/sessions.setStatus', { status: '進行中', reason: 'テスト' });
    const statusRow = (await c.cmd('listSessions')).find((s) => s.id === ask.sessionId);
    t.ok('sessions.setStatus: 状態が変わり、一覧の「AI が変更」の印（statusByAi）になる', setStatus.status === 200 && statusRow.status === '進行中' && statusRow.statusByAi?.reason === 'テスト', JSON.stringify(statusRow?.statusByAi));

    // ---- 権限の配線（会話の承認モード → policy）
    const guard = (s) => api(bound(s), 'POST', '/api/ops/probe.guarded', {});
    const allowed = await guard(bypass);
    t.ok('承認なしの会話（bypass: 範囲 full・自律 never）の guarded は通る', allowed.status === 200 && allowed.body.result.done === true, JSON.stringify(allowed.body));
    t.ok('その記録が会話に残る（by: agent・via・field: op）', (await api(cli, 'POST', '/api/ops/sessions.get', { sessionId: bypass.sessionId })).body.result.changes.some((x) => x.field === 'op' && x.to === 'probe.guarded' && x.by === 'agent'));
    // 承認が要る会話: 会話に承認カード（settingChange）を出し、待たずに承認待ちで返る（ADR 0088）
    const cardFor = (sessionId, from) => c.waitFor((e) => e.type === 'permission' && e.settingChange && e.sessionId === sessionId, { from, ms: 15_000 });
    const noticeFor = (sessionId, requestId, from) => c.waitFor((e) => e.type === 'taskNotice' && e.sessionId === sessionId && String(e.text).includes(requestId), { from, ms: 30_000 });
    const settledFor = (requestId, from) => c.waitFor((e) => e.type === 'settingApproval' && e.requestId === requestId, { from, ms: 15_000 });
    let from = c.mark();
    const asked = await guard(asker);
    const card = await cardFor(asker.sessionId, from);
    t.ok('承認が要る会話の guarded は、待たずに 202 と承認待ち（pending・PENDING_APPROVAL・requestId・文）で返る', asked.status === 202 && asked.body.ok === true && asked.body.pending === true
      && asked.body.result.status === 'pending' && asked.body.result.code === 'PENDING_APPROVAL' && /^setting-/.test(asked.body.result.requestId) && asked.body.result.message.includes(asked.body.result.requestId), JSON.stringify(asked.body));
    t.ok('会話に承認カードを出す（操作・受領証・requestId・エージェント。「常に許可」は無い）', card.toolName === 'ply_control' && card.canAlways === false
      && card.settingChange.op === 'probe.guarded' && /^[a-f0-9]{32}$/.test(card.settingChange.receipt) && card.settingChange.requestId === asked.body.result.requestId
      && card.settingChange.agent.id === 'fake' && card.settingChange.note === 'probe', JSON.stringify(card.settingChange));
    const runningNow = (await api(cli, 'POST', '/api/ops/app.running', {})).body.result;
    t.ok('待っているカードは承認待ちに数えるが、走っている作業（終了・更新を止める数）には数えない', runningNow.waiting >= 1 && runningNow.count === 0, JSON.stringify(runningNow));
    t.ok('受領証の無い・合わない答えは断られ、カードは残る（別の変更への答えを受けない）',
      await c.cmd('resolvePermission', { id: card.id, allow: true }).then(() => false, (e) => e.code === 'RECEIPT_MISMATCH')
      && await c.cmd('resolvePermission', { id: card.id, allow: true, receipt: '0'.repeat(32) }).then(() => false, (e) => e.code === 'RECEIPT_MISMATCH'));
    await c.cmd('resolvePermission', { id: card.id, allow: true, receipt: card.settingChange.receipt });
    const allowedNotice = await noticeFor(asker.sessionId, card.settingChange.requestId, from);
    t.ok('許可すると実行され、結果（許可）がその会話へ通知として届く', /結果: 許可/.test(allowedNotice.text)
      && (await settledFor(card.settingChange.requestId, from)).outcome === 'allowed'
      && (await api(cli, 'POST', '/api/ops/sessions.get', { sessionId: asker.sessionId })).body.result.changes.some((x) => x.field === 'op' && x.to === 'probe.guarded'), allowedNotice.text);
    t.ok('同じカードへの再送は受け取られない（もう決着している）', await c.cmd('resolvePermission', { id: card.id, allow: true, receipt: card.settingChange.receipt }).then(() => false, () => true));
    await c.waitFor((e) => e.type === 'turnEnd' && e.sessionId === asker.sessionId, { from, ms: 30_000 });
    from = c.mark();
    await guard(asker);
    const card2 = await cardFor(asker.sessionId, from);
    await c.cmd('resolvePermission', { id: card2.id, allow: false, messageKey: 'userDenied', receipt: card2.settingChange.receipt });
    const deniedNotice = await noticeFor(asker.sessionId, card2.settingChange.requestId, from);
    t.ok('拒否すると実行されず、結果（拒否）がその会話へ届く。画面へは決着（denied）が届く', /結果: 拒否/.test(deniedNotice.text) && (await settledFor(card2.settingChange.requestId, from)).outcome === 'denied', deniedNotice.text);
    await c.waitFor((e) => e.type === 'turnEnd' && e.sessionId === asker.sessionId, { from, ms: 30_000 });
    t.ok('読み取り専用の会話（plan）の guarded は READ_ONLY_MODE', (await guard(plan)).body.code === 'READ_ONLY_MODE');
    const planWrite = await api(bound(plan), 'POST', '/api/ops/sessions.setTitle', { title: 'x' });
    t.ok('読み取り専用の会話の write も READ_ONLY_MODE。題は変わらない', planWrite.status === 403 && planWrite.body.code === 'READ_ONLY_MODE'
      && (await c.cmd('listSessions')).find((s) => s.id === plan.sessionId)?.title === '昔のコマンドで変えた題');
    t.ok('束縛されない CLI の guarded は NEEDS_UI（bypass の会話の接続とは別）', (await api(cli, 'POST', '/api/ops/probe.guarded', {})).body.code === 'NEEDS_UI');
    t.ok('human-only は束縛された会話にも出ない（bypass でも）', !(await api(bound(bypass), 'GET', '/api/ops')).body.result.ops.some((o) => o.id === 'probe.humanOnly') && (await api(bound(bypass), 'POST', '/api/ops/probe.humanOnly', {})).status === 404);
    const hiddenList = await api(bound(bypass), 'POST', '/mcp/control', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_ops', arguments: {} } });
    const hiddenCall = await api(bound(bypass), 'POST', '/mcp/control', { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'call_op', arguments: { op: 'probe.humanOnly', args: {} } } });
    t.ok('human-only は ply_control の list_ops に現れず、call_op でも NOT_FOUND',
      !JSON.parse(hiddenList.body.result.content[0].text).ops.some((o) => o.id === 'probe.humanOnly')
      && hiddenCall.body.result.isError === true && JSON.parse(hiddenCall.body.result.content[0].text).code === 'NOT_FOUND');
    t.ok('人間（画面）は guarded も human-only も通る', (await c.cmd('invoke', { op: 'probe.guarded', args: {} })).done === true && (await c.cmd('invoke', { op: 'probe.humanOnly', args: {} })).done === true);
    from = c.mark();
    const mcpPending = await api(bound(asker), 'POST', '/mcp/control', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'call_op', arguments: { op: 'probe.guarded' } } });
    const card5 = await cardFor(asker.sessionId, from);
    t.ok('MCP の承認待ちは isError ではなく、status: pending と requestId', mcpPending.body.result.isError !== true && JSON.parse(mcpPending.body.result.content[0].text).requestId === card5.settingChange.requestId, JSON.stringify(mcpPending.body));
    await c.cmd('resolvePermission', { id: card5.id, allow: false, messageKey: 'userDenied', receipt: card5.settingChange.receipt });
    await noticeFor(asker.sessionId, card5.settingChange.requestId, from);
    await c.waitFor((e) => e.type === 'turnEnd' && e.sessionId === asker.sessionId, { from, ms: 30_000 });

    // ---- human-only は 5 つだけ（ADR 0094）
    const MOVED = ['worktrees.split', 'worktrees.discard', 'worktrees.keep', 'worktrees.archive', 'worktrees.restore', 'worktrees.setSettings', 'notify.setPc', 'notify.setDevice',
      'hooks.read', 'hooks.readPly', 'compatEndpoints.recheck', 'compatEndpoints.delete', 'sessions.setModel', 'computer.stop'];
    const cliIds = (await api(cli, 'GET', '/api/ops')).body.result.ops.map((o) => o.id);
    const boundOps = (await api(bound(bypass), 'GET', '/api/ops')).body.result.ops;
    const listedOps = JSON.parse(hiddenList.body.result.content[0].text).ops;
    t.ok('human-only から外した 14 の操作は、外の CLI・会話の CLI・ply_control の list_ops に出る', MOVED.every((id) => cliIds.includes(id) && boundOps.some((o) => o.id === id) && listedOps.some((o) => o.id === id)),
      MOVED.filter((id) => !listedOps.some((o) => o.id === id)).join(' '));
    const ofFive = (o) => o.risk === 'human-only' || HUMAN_ONLY_COMMANDS.has(registry.get(o.id)?.legacyCommand);
    t.ok('5 つ（承認モード・秘密の値・アカウント・接続先の既定・リモートのペアリング）に当たる操作は、どの agent の一覧にも無い', !boundOps.some(ofFive) && !listedOps.some(ofFive));
    const callCode = async (op, args = {}) => JSON.parse((await api(bound(bypass), 'POST', '/mcp/control', { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'call_op', arguments: { op, args } } })).body.result.content[0].text).code;
    t.ok('5 つのコマンドの名前で call_op を呼んでも NOT_FOUND（setMode・resolvePermission・claudeAccounts・remoteDevices・compatEndpointDefault・setRemoteSettings・compatEndpointSave）',
      (await Promise.all(['setMode', 'resolvePermission', 'claudeAccounts', 'remoteDevices', 'compatEndpointDefault', 'setRemoteSettings', 'compatEndpointSave'].map((n) => callCode(n)))).every((code) => code === 'NOT_FOUND'));
    const agentSettings = (await api(bound(bypass), 'POST', '/api/ops/settings.list', {})).body.result.settings.map((x) => x.key);
    t.ok('agent の settings.list に、承認モードの既定（mode）と既定のアカウント（claudeAccount）は無い', [...HUMAN_ONLY_SETTINGS].every((k) => !agentSettings.includes(k)) && agentSettings.includes('model'));
    t.ok('agent が設定 mode を get しても SETTING_NOT_FOUND（ply_control の call_op）', (await callCode('settings.get', { key: 'mode' })) === 'SETTING_NOT_FOUND');

    // 外した操作を agent が呼ぶ。画面のコマンドと同じ本体・同じ配信を通る
    from = c.mark();
    const always = await api(bound(ask), 'POST', '/api/ops/worktrees.setSettings', { always: true });
    t.ok('worktrees.setSettings: ask の会話の agent が承認なしで「いつも分ける」を変え、画面へ worktreeSettings が届く', always.status === 200 && always.body.result.always === true
      && (await c.cmd('worktreeSettings')).always === true && Boolean(await c.waitFor((e) => e.type === 'worktreeSettings' && e.always === true, { from, ms: 5_000 })), JSON.stringify(always.body));
    t.ok('画面の setWorktreeSettings（昔のコマンド）も同じ操作を通る。真偽でなければ拒否', (await c.cmd('setWorktreeSettings', { always: false })).always === false
      && await c.cmd('setWorktreeSettings', { always: 'yes' }).then(() => false, () => true));
    t.ok('読み取り専用の会話（plan）の worktrees.setSettings は READ_ONLY_MODE', (await api(bound(plan), 'POST', '/api/ops/worktrees.setSettings', { always: true })).body.code === 'READ_ONLY_MODE');
    t.ok('worktrees.keep: 無い作業場所は 404 と WORKTREE_NOT_FOUND', (await api(bound(ask), 'POST', '/api/ops/worktrees.keep', { id: 'nope' })).body.code === 'WORKTREE_NOT_FOUND');
    const prefsBefore = JSON.stringify((await c.cmd('prefs')).backends ?? null);
    from = c.mark();
    const model = await api(bound(ask), 'POST', '/api/ops/sessions.setModel', { model: 'tiny', reason: '軽い作業なので' });
    t.ok('sessions.setModel: agent が自分の会話のモデルを替える（sessionId を省ける）', model.status === 200 && model.body.result.sessionId === ask.sessionId && model.body.result.model === 'tiny', JSON.stringify(model.body));
    const modelChange = (await api(cli, 'POST', '/api/ops/sessions.get', { sessionId: ask.sessionId })).body.result.changes.find((x) => x.field === 'model' && x.to === 'tiny');
    t.ok('sessions.setModel: 記録は by: agent・via・どの会話か・理由。画面へ model のイベント（by: agent）', modelChange?.by === 'agent' && modelChange.via === 'cli' && modelChange.bySession === ask.sessionId && modelChange.reason === '軽い作業なので'
      && Boolean(await c.waitFor((e) => e.type === 'model' && e.sessionId === ask.sessionId && e.model === 'tiny' && e.by === 'agent', { from, ms: 5_000 })), JSON.stringify(modelChange));
    t.ok('sessions.setModel: agent の変更は新しい会話の既定のモデルにしない', JSON.stringify((await c.cmd('prefs')).backends ?? null) === prefsBefore);
    t.ok('sessions.setModel: 知らないモデルは INVALID・知らない会話は SESSION_NOT_FOUND', (await api(bound(ask), 'POST', '/api/ops/sessions.setModel', { model: 'nope' })).body.code === 'INVALID'
      && (await api(bound(ask), 'POST', '/api/ops/sessions.setModel', { sessionId: 'nope', model: 'tiny', backend: 'fake' })).body.code === 'SESSION_NOT_FOUND');
    t.ok('画面の setModel（昔のコマンド）は同じ操作を通り、人間の変更は既定のモデルとして覚える', (await c.cmd('setModel', { sessionId: ask.sessionId, model: 'smart' })).live === false
      && (await c.cmd('prefs')).backends?.fake?.model === 'smart');
    t.ok('computer.stop: agent は自分の会話を止められる（使っていなければ stopped: false）。読み取り専用の会話からも呼べる', (await api(bound(plan), 'POST', '/api/ops/computer.stop', {})).body.result?.stopped === false);
    t.ok('notify.setDevice: 一覧に無い端末は DEVICE_NOT_FOUND（端末の一覧は返さない）', (await api(bound(ask), 'POST', '/api/ops/notify.setDevice', { id: 'nope', muted: true })).body.code === 'DEVICE_NOT_FOUND');
    const pc = await api(bound(ask), 'POST', '/api/ops/notify.setPc', { done: false });
    t.ok('notify.setPc: この PC の通知の設定だけを返す（スマホの一覧を混ぜない）', pc.status === 200 && JSON.stringify(Object.keys(pc.body.result).sort()) === '["done","failed","reply"]' && pc.body.result.done === false
      && (await c.cmd('notifyStatus')).pc.done === false, JSON.stringify(pc.body));
    await c.cmd('setNotifyPc', { done: true });
    t.ok('compatEndpoints.delete: 承認なしのモードの会話は通る（無い接続先は ENDPOINT_NOT_FOUND）', (await api(bound(bypass), 'POST', '/api/ops/compatEndpoints.delete', { id: 'nope' })).body.code === 'ENDPOINT_NOT_FOUND');
    from = c.mark();
    const deleting = await api(bound(asker), 'POST', '/api/ops/compatEndpoints.delete', { id: 'nope', reason: '使っていない' });
    const card7 = await cardFor(asker.sessionId, from);
    t.ok('compatEndpoints.delete: ask の会話は承認カード（取り返しがつかない削除。guarded）', deleting.status === 202 && card7.settingChange.op === 'compatEndpoints.delete' && /nope/.test(card7.settingChange.note ?? ''), JSON.stringify(card7.settingChange));
    await c.cmd('resolvePermission', { id: card7.id, allow: false, messageKey: 'userDenied', receipt: card7.settingChange.receipt });
    await noticeFor(asker.sessionId, card7.settingChange.requestId, from);
    await c.waitFor((e) => e.type === 'turnEnd' && e.sessionId === asker.sessionId, { from, ms: 30_000 });

    // ---- settings.set の実物（設定の一覧 → 画面と同じ保存・配信）
    await c.cmd('setPref', { key: 'confirmAgentSites', value: true });
    t.ok('画面の setPref（昔のコマンド）は settings.set を通り、prefs と settingsChanged が届く（by: human）', (await c.cmd('prefs')).confirmAgentSites === true
      && c.events.some((e) => e.type === 'settingsChanged' && e.keys?.join() === 'confirmAgentSites' && e.by === 'human'));
    t.ok('画面の setPref の失敗: 知らないキー・不正な値は拒否される', await c.cmd('setPref', { key: 'nope', value: 1 }).then(() => false, (e) => e.code === 'SETTING_NOT_FOUND')
      && await c.cmd('setPref', { key: 'linkOpen', value: 'javascript:' }).then(() => false, (e) => e.code === 'INVALID'));
    const wrote2 = await api(bound(ask), 'POST', '/api/ops/settings.set', { key: 'linkOpen', value: 'inapp', reason: 'テスト' });
    t.ok('write の設定は ask の会話の agent も承認なしで書ける（settings.set）', wrote2.status === 200 && wrote2.body.result.changed === true && (await c.cmd('prefs')).linkOpen === 'inapp');
    t.ok('配信: settingsChanged が by: agent・via・どの会話かつきで届く', c.events.some((e) => e.type === 'settingsChanged' && e.keys?.join() === 'linkOpen' && e.by === 'agent' && e.via === 'cli' && e.bySession === ask.sessionId));
    t.ok('記録: 呼んだ会話の変更の記録に、設定の前後と理由が残る（by: agent）', (await api(cli, 'POST', '/api/ops/sessions.get', { sessionId: ask.sessionId })).body.result.changes
      .some((x) => x.field === 'setting' && x.by === 'agent' && x.bySession === ask.sessionId && x.reason === 'テスト' && x.to?.key === 'linkOpen' && x.from?.value === '"external"'));
    t.ok('human-only（承認モード）は set でも agent に NOT_FOUND 系。承認モードは変わらない', (await api(bound(bypass), 'POST', '/api/ops/settings.set', { key: 'mode', value: 'bypass' })).body.code === 'SETTING_NOT_FOUND');
    t.ok('束縛されない CLI が確認を切る（関所を緩める）と NEEDS_UI。prefs は変わらない', (await api(cli, 'POST', '/api/ops/settings.set', { key: 'confirmAgentSites', value: false })).body.code === 'NEEDS_UI'
      && (await c.cmd('prefs')).confirmAgentSites === true);
    from = c.mark();
    const loosening = await api(bound(asker), 'POST', '/api/ops/settings.set', { key: 'confirmAgentSites', value: false, reason: '確認が多すぎるため' });
    const card6 = await cardFor(asker.sessionId, from);
    const sc = card6.settingChange;
    t.ok('確認を切る(settings.set)は承認カード: 項目・前後の値（JSON）・AI が書いた理由・関所を緩める印', loosening.status === 202 && sc.op === 'settings.set' && sc.key === 'confirmAgentSites' && sc.rows[0].path === 'confirmAgentSites' && sc.rows[0].before === 'true' && sc.rows[0].after === 'false'
      && sc.reason === '確認が多すぎるため' && sc.loosens === true && loosening.body.result.message.includes('confirmAgentSites'), JSON.stringify(sc));
    t.ok('カードのあいだ、設定はまだ変わっていない', (await c.cmd('prefs')).confirmAgentSites === true);
    await c.cmd('resolvePermission', { id: card6.id, allow: true, receipt: sc.receipt });
    const loosened = await noticeFor(asker.sessionId, sc.requestId, from);
    t.ok('許可すると書かれ、prefs イベントが届き、結果が会話に届く', (await c.cmd('prefs')).confirmAgentSites === false && c.since(from).some((e) => e.type === 'prefs') && /結果: 許可/.test(loosened.text) && /confirmAgentSites/.test(loosened.text), loosened.text);
    await c.waitFor((e) => e.type === 'turnEnd' && e.sessionId === asker.sessionId, { from, ms: 30_000 });
    await c.cmd('setPref', { key: 'confirmAgentSites', value: true });
    const bypassWrite = await api(bound(bypass), 'POST', '/api/ops/settings.set', { key: 'confirmAgentSites', value: false });
    t.ok('bypass の会話は承認カードなしで通り、記録が残る', bypassWrite.status === 200 && (await c.cmd('prefs')).confirmAgentSites === false
      && (await api(cli, 'POST', '/api/ops/sessions.get', { sessionId: bypass.sessionId })).body.result.changes.some((x) => x.field === 'setting' && x.to?.key === 'confirmAgentSites'));
    t.ok('context.default は設定の一覧から書け、配信の無かった設定にも settingsChanged が届く', (await api(bound(bypass), 'POST', '/api/ops/settings.set', { key: 'context.default', value: { kind: 'skill', value: { owner: 'native', user: { sources: ['common'], excludePaths: [] }, directory: { sources: ['common'], excludePaths: [] } } } })).body.ok === true
      && c.events.some((e) => e.type === 'settingsChanged' && e.keys?.join() === 'context.default'));
    await c.cmd('setPref', { key: 'linkOpen', value: 'external' });

    // ---- 会話を分ける・状態のグループ（write）
    const forked = await api(bound(ask), 'POST', '/api/ops/sessions.fork', { title: '分けた会話' });
    const childRow = forked.body.ok ? (await api(cli, 'POST', '/api/ops/sessions.get', { sessionId: forked.body.result.sessionId })).body.result : null;
    t.ok('sessions.fork: 束縛された会話は sessionId を省けばその会話を分け、新しい会話の親になる。承認は要らない（write）', forked.status === 200 && forked.body.result.parent === ask.sessionId
      && childRow?.parent === ask.sessionId && childRow.id !== ask.sessionId, JSON.stringify(forked.body));
    t.ok('sessions.fork: 分けた会話の記録は by: agent・via・どの会話の AI か。fork イベントが届く', childRow.changes.some((x) => x.field === 'parent' && x.by === 'agent' && x.via === 'cli' && x.bySession === ask.sessionId)
      && c.events.some((e) => e.type === 'fork' && e.sessionId === forked.body.result.sessionId));
    t.ok('sessions.fork: 読み取り専用の会話は READ_ONLY_MODE。無い会話は SESSION_NOT_FOUND', (await api(bound(plan), 'POST', '/api/ops/sessions.fork', {})).body.code === 'READ_ONLY_MODE'
      && (await api(cli, 'POST', '/api/ops/sessions.fork', { sessionId: 'nope' })).body.code === 'SESSION_NOT_FOUND');
    t.ok('昔の fork コマンド（画面）も同じ経路で分けられる', typeof (await c.cmd('fork', { sessionId: ask.sessionId })).sessionId === 'string');
    const made = await api(cli, 'POST', '/api/ops/statuses.create', { status: 'レビュー待ち' });
    const iconed = await api(bound(ask), 'POST', '/api/ops/statuses.setIcon', { status: 'レビュー待ち', icon: '◐' });
    await c.waitFor((e) => e.type === 'statusIcon' && e.status === 'レビュー待ち', { from: 0, ms: 5000 }).catch(() => null);
    t.ok('statuses.create / setIcon: AI も状態のグループを作りアイコンを付けられる（write）', made.body.result?.status === 'レビュー待ち' && iconed.body.result?.icon === '◐', JSON.stringify([made.body, iconed.body]));
    t.ok('statuses: statusIcon と status（by: agent）のイベントが画面へ届く', c.events.some((e) => e.type === 'statusIcon' && e.status === 'レビュー待ち') && c.events.some((e) => e.type === 'status' && e.status === 'レビュー待ち' && e.by === 'agent'), JSON.stringify(c.events.filter((e) => e.status === 'レビュー待ち')));
    t.ok('statuses.setIcon: 名前が空なら INVALID。読み取り専用の会話は断る', (await api(cli, 'POST', '/api/ops/statuses.setIcon', { status: ' ', icon: 'x' })).body.code === 'INVALID'
      && (await api(bound(plan), 'POST', '/api/ops/statuses.create', { status: 'x' })).body.code === 'READ_ONLY_MODE');

    // ---- 読む操作
    const sessions = await api(cli, 'POST', '/api/ops/sessions.list', {});
    t.ok('sessions.list は会話を返す（題・状態・場所・エージェント）', sessions.body.result.total >= 3 && sessions.body.result.sessions.some((s) => s.id === ask.sessionId && s.status === '進行中' && s.backend === 'fake' && s.cwd === ROOT));
    const page = await api(cli, 'POST', '/api/ops/sessions.list', { limit: 2 });
    const rest = await api(cli, 'POST', '/api/ops/sessions.list', { limit: 100, cursor: page.body.result.next });
    t.ok('ページ送り: 続きは重複なく、全部を 1 回ずつ', page.body.result.sessions.length === 2 && page.body.result.next && new Set([...page.body.result.sessions, ...rest.body.result.sessions].map((s) => s.id)).size === 2 + rest.body.result.sessions.length
      && 2 + rest.body.result.sessions.length === sessions.body.result.total);
    const found = await api(cli, 'POST', '/api/ops/sessions.search', { query: '別の会話から' });
    t.ok('sessions.search（別の定義）も同じ入口から呼べ、題に当たった会話を返す。その hit の会話を sessions.read で読める', found.status === 200 && found.body.result.sessions.some((x) => x.sessionId === ask.sessionId && x.matched.includes('title'))
      && (await api(cli, 'POST', '/api/ops/sessions.read', { sessionId: found.body.result.sessions[0].sessionId })).body.ok === true, JSON.stringify(found.body).slice(0, 300));
    const read = await api(cli, 'POST', '/api/ops/sessions.read', { sessionId: ask.sessionId });
    t.ok('sessions.read は会話の本文を返す（末尾を中心に）', read.body.result.total >= 2 && read.body.result.messages.at(-1).role === 'assistant' && /list_ops/.test(read.body.result.messages.at(-1).text), JSON.stringify(read.body.result).slice(0, 300));
    const firstUuid = read.body.result.messages[0].uuid;
    t.ok('sessions.read は messageId の前後（uuid で指す）', (await api(cli, 'POST', '/api/ops/sessions.read', { sessionId: ask.sessionId, messageId: firstUuid, before: 0, after: 0 })).body.result.messages.length === 1);
    t.ok('sessions.get / read の無い会話は 404 SESSION_NOT_FOUND', (await api(cli, 'POST', '/api/ops/sessions.get', { sessionId: 'nope' })).body.code === 'SESSION_NOT_FOUND' && (await api(cli, 'POST', '/api/ops/sessions.read', { sessionId: 'nope' })).status === 404);
    const setting = await api(cli, 'POST', '/api/ops/settings.get', { key: 'linkOpen' });
    t.ok('settings.get は実際の prefs の値を返す', setting.body.result.value === 'external' && setting.body.result.default === 'inapp');
    t.ok('settings.get: 承認モードの既定は agent に出ない（human-only）。human（WS）には出る', (await api(cli, 'POST', '/api/ops/settings.get', { key: 'mode' })).body.code === 'SETTING_NOT_FOUND'
      && (await c.cmd('invoke', { op: 'settings.get', args: { key: 'mode' } })).key === 'mode');
    t.ok('settings.get: 自動圧縮・コンテキストの既定・委譲の振り分け（秘密以外）が読める', ['compaction.auto', 'context.default', 'delegationRouting', 'computerUse'].every(() => true)
      && (await api(cli, 'POST', '/api/ops/settings.get', { key: 'compaction.auto' })).body.result.value.minTokens === 150000
      && (await api(cli, 'POST', '/api/ops/settings.get', { key: 'context.default' })).body.ok === true
      && (await api(cli, 'POST', '/api/ops/settings.get', { key: 'delegationRouting' })).body.result.value.enabled === false);
    const running = await api(cli, 'POST', '/api/ops/app.running', {});
    t.ok('app.running: 走っている作業の数と中身', running.body.result.count === 0 && Array.isArray(running.body.result.turns) && running.body.result.waiting === 0);
    const slow = c.runTurn({ prompt: 'slow', sessionId: null, cwd: ROOT, backend: 'fake', mode: 'default' }, { ms: 30_000 });
    let during = null;
    for (let i = 0; i < 100 && !(during?.body?.result?.count > 0); i++) { await new Promise((r) => setTimeout(r, 50)); during = await api(cli, 'POST', '/api/ops/app.running', {}); }
    t.ok('app.running: 走っているターンが数に入り、会話の id・エージェント・題が出る', during.body.result.count === 1 && during.body.result.turns[0].backend === 'fake' && typeof during.body.result.turns[0].sessionId === 'string', JSON.stringify(during.body.result));
    await c.cmd('abort', { sessionId: during.body.result.turns[0].sessionId }).catch(() => {});
    await slow.catch(() => {});
    const tasks = await api(cli, 'POST', '/api/ops/delegation.tasks', {});
    t.ok('delegation.tasks: 委譲が無ければ空', tasks.body.result.total === 0 && tasks.body.result.tasks.length === 0 && (await api(cli, 'POST', '/api/ops/delegation.status', { taskId: 'none' })).body.code === 'TASK_NOT_FOUND');

    // ---- T6 伏せ字: 秘密に目印を入れたデータ置き場で、全 read 操作と全設定を呼ぶ
    const everything = [];
    for (const o of listed.body.result.ops.filter((x) => x.risk === 'read')) {
      const required = o.input.required ?? [];
      const inputs = o.id === 'settings.get' || o.id === 'settings.schema'
        ? (await api(cli, 'POST', '/api/ops/settings.list', {})).body.result.settings.map((s) => ({ key: s.key }))
        : o.id === 'sessions.get' || o.id === 'sessions.read' ? [{ sessionId: ask.sessionId }] : ['delegation.status', 'delegation.taskStatus', 'delegation.taskWait'].includes(o.id) ? [{ taskId: 'none' }] : o.id === 'sessions.search' ? [{ query: 'control' }, { query: MARKER }]
        : o.id === 'hooks.readPly' ? [{ id: 'none' }] : o.id === 'hooks.read' ? [{ agent: 'claude', scope: 'project', base: scratch, loc: { event: 'PreToolUse', group: 0, handler: 0 } }] : required.length ? null : [{}];
      if (!inputs) { t.ok(`T6 ${o.id}: 必須の引数の例がある`, false); continue; }
      for (const args of inputs) everything.push([o.id, args, JSON.stringify((await api(cli, 'POST', `/api/ops/${o.id}`, args)).body)]);
    }
    t.ok('T6 全 read 操作・全設定の返りに、秘密の目印が出ない', everything.length > 20 && everything.every(([, , body]) => !body.includes(MARKER)), everything.filter(([, , body]) => body.includes(MARKER)).map(([id, args]) => `${id} ${JSON.stringify(args)}`).join(', '));
    t.ok('T6 伏せ字は秘密らしい名前の欄に効いている（agentSitePermissions の token）', (await api(cli, 'POST', '/api/ops/settings.get', { key: 'agentSitePermissions' })).body.result.value[0].token === '••••');
    const files = await Promise.all((await fs.readdir(dataDir)).map(async (f) => [f, await fs.readFile(path.join(dataDir, f), 'utf8').catch(() => '')]));
    t.ok('（確認）目印は秘密の置き場に実際に入っている', files.filter(([, text]) => text.includes(MARKER)).length >= 4);
    t.ok('control.json の cliToken は ply_control や /api/ops の返りに出ない', everything.every(([, , body]) => !body.includes(cli)));
  } finally {
    c.close();
    await server.stop();
  }

  // ---- 終了時の後始末（pid が自分のときだけ消す）と、デスクトップ版の印
  const dir2 = path.join(scratch, 'data2');
  await writeControlFile({ dataDir: dir2, origin: 'http://127.0.0.1:1', cliToken: 'x'.repeat(64), startedAt: 1, appVersion: '0', kind: 'server', pid: 99999999 });
  removeControlFile({ dataDir: dir2 });
  t.ok('別のサーバー（pid が違う）のファイルは消さない', await fs.stat(controlFilePath(dir2)).then(() => true, () => false));
  await writeControlFile({ dataDir: dir2, origin: 'http://127.0.0.1:1', cliToken: 'x'.repeat(64), startedAt: 1, appVersion: '0', kind: 'server' });
  removeControlFile({ dataDir: dir2 });
  t.ok('自分（pid が同じ）のファイルは消す', await fs.stat(controlFilePath(dir2)).then(() => false, () => true));
  removeControlFile({ dataDir: path.join(scratch, 'nothing') });
  t.ok('ファイルが無くても、壊れていても落ちない', true);
  await fs.mkdir(dir2, { recursive: true }); await fs.writeFile(controlFilePath(dir2), '{broken');
  removeControlFile({ dataDir: dir2 });
  t.ok('壊れたファイルは消さない（持ち主が分からない）', (await fs.readFile(controlFilePath(dir2), 'utf8')) === '{broken');

  const desktopDir = path.join(scratch, 'desktop-data');
  const desktop = await startServer({ env: { AGENT_HOST_BACKENDS: 'fake' }, dataDir: desktopDir, entry: path.join(ROOT, 'tests', 'lib', 'parent-port-server.mjs'), timeoutMs: 60_000 });
  try {
    const written = JSON.parse(await fs.readFile(controlFilePath(desktopDir), 'utf8'));
    t.ok('デスクトップ版（utilityProcess。process.parentPort がある）は kind: desktop', written.kind === 'desktop' && written.origin === `http://127.0.0.1:${desktop.port}`);
  } finally { await desktop.stop(); }
  await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
}
