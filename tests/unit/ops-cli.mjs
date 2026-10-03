// CLI（bin/pleiad.mjs）と pleiad mcp（stdio の MCP）。fake バックエンドのサーバーに、本物のプロセスとしてつなぐ。LLM は呼ばない。
//   - コマンドは操作の一覧から実行時に作る（help・位置引数・--<名前>・型の変換）
//   - 終了コード 0 / 2 / 3 / 4 / 5 / 6（承認待ち）と --json
//   - つなぎ先: control.json（束縛なし）・環境変数（会話に束縛）。居ない・古い・つながらない・401 は 3
//   - pleiad mcp: 同じ生成器で tools/list。未起動なら固定の数本と「未起動」、後から起動したら list_changed
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { spawn, spawnSync } from 'node:child_process';
import { startServer, ROOT } from '../lib/server.mjs';
import { open } from '../lib/ws-client.mjs';
import { controlFilePath } from '../../core/control-file.mjs';
import { EXIT, exitCodeOf, matchCommand, parseArgs, render, runMcp } from '../../bin/pleiad.mjs';
import { registry } from '../../core/ops/index.mjs';
import { HUMAN_ONLY_COMMANDS } from '../../core/ops/policy.mjs';

export const name = 'ops-cli';
export const title = 'CLI（pleiad）と pleiad mcp: サブコマンドの生成・終了コード・つなぎ先・stdio の MCP';

const BIN = path.join(ROOT, 'bin', 'pleiad.mjs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export default async function (t) {
  // ---- 純粋な部分
  t.ok('終了コード: 0 成功・2 入力の誤り・3 未起動・4 拒否・5 その他・6 承認待ち', EXIT.ok === 0 && EXIT.usage === 2 && EXIT.notRunning === 3 && EXIT.refused === 4 && EXIT.other === 5 && EXIT.pending === 6);
  t.ok('失敗の code → 終了コード（入力の誤りは 2、拒否・画面での操作は 4、知らないものは 5）', ['INVALID', 'NOT_FOUND', 'SESSION_NOT_FOUND', 'SETTING_NOT_FOUND'].every((c) => exitCodeOf(c) === 2)
    && ['NEEDS_UI', 'NEEDS_APPROVAL', 'READ_ONLY_MODE', 'HOST_SCREEN_ONLY', 'DENIED', 'STALE', 'SETTING_READ_ONLY'].every((c) => exitCodeOf(c) === 4) && exitCodeOf('SOMETHING') === 5 && exitCodeOf(undefined) === 5);
  const entry = { id: 'x.go', cli: { path: ['x', 'go'], positional: ['name', 'count'] }, input: { properties: {
    name: { type: 'string' }, count: { type: 'integer' }, flag: { type: 'boolean' }, ratio: { type: 'number' }, tags: { type: 'array' }, deepKey: { type: 'string' }, filters: { type: 'object' } } } };
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  t.ok('位置引数は cli.positional の順、型は JSON Schema で変換する', same(parseArgs(entry, ['abc', '3']), { name: 'abc', count: 3 }));
  t.ok('--<名前> は kebab でも camel でもよい。真偽は値なしで true、=false と false', same(parseArgs(entry, ['--deep-key', 'a', '--flag', '--ratio=1.5']), { deepKey: 'a', flag: true, ratio: 1.5 })
    && parseArgs(entry, ['--flag', 'false']).flag === false && parseArgs(entry, ['--flag=false']).flag === false && parseArgs(entry, ['--deepKey', 'b']).deepKey === 'b');
  t.ok('配列はコンマ区切りか JSON、オブジェクトは JSON', same(parseArgs(entry, ['--tags', 'a,b']).tags, ['a', 'b']) && same(parseArgs(entry, ['--tags', '["x","y"]']).tags, ['x', 'y']) && same(parseArgs(entry, ['--filters', '{"a":1}']).filters, { a: 1 }));
  t.ok('--args の JSON を土台に、--<名前> で重ねる', same(parseArgs(entry, ['--args', '{"name":"n","count":1}', '--count', '2']), { name: 'n', count: 2 }));
  const usageError = (rest) => { try { parseArgs(entry, rest); return null; } catch (e) { return e.constructor.name; } };
  t.ok('誤り（知らない --名前・型が違う・多すぎる位置引数・--args が壊れている）は UsageError', ['--nope', '--count', 'x', 'a', '1', 'extra', '--args', '{', '--args', '[1]'].length > 0
    && usageError(['--nope', '1']) === 'UsageError' && usageError(['--count', 'x']) === 'UsageError' && usageError(['a', '1', 'extra']) === 'UsageError' && usageError(['--args', '{']) === 'UsageError' && usageError(['--args', '[1]']) === 'UsageError' && usageError(['--count']) === 'UsageError' && usageError(['--count', '1.5']) === 'UsageError');
  t.ok('-- の後ろは位置引数（--で始まる題も渡せる）', same(parseArgs(entry, ['--', '--odd']), { name: '--odd' }));
  const catalog = [{ id: 'a.b', cli: { path: ['a'] } }, { id: 'a.c', cli: { path: ['a', 'c'] } }, { id: 'n.o', cli: null }];
  t.ok('コマンドは最も長く合う操作（a c は a.c、a x は a.b と残り x）', matchCommand(catalog, ['a', 'c', '1']).entry.id === 'a.c' && matchCommand(catalog, ['a', 'c', '1']).rest.join() === '1'
    && matchCommand(catalog, ['a', 'x']).entry.id === 'a.b' && matchCommand(catalog, ['z']) === null);
  t.ok('表示: スカラーは key: value、オブジェクトの配列は表', render({ total: 2, items: [{ id: 'a', n: 1 }, { id: 'bb', n: 22 }] }).split('\n').join('|') === 'total: 2|items:|  id  n|  a   1|  bb  22', render({ total: 2, items: [{ id: 'a', n: 1 }, { id: 'bb', n: 22 }] }));

  // ---- 起動していない（サーバーを立てる前に）
  const scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'agent-host-ops-cli-')));
  const emptyDir = path.join(scratch, 'empty');
  await fs.mkdir(emptyDir, { recursive: true });
  const baseEnv = (dir, extra = {}) => {
    const env = { ...process.env, AGENT_HOST_DATA: dir, AGENT_HOST_LOCALE: 'ja', ...extra };
    for (const k of ['PLEIAD_CONTROL_URL', 'PLEIAD_CONTROL_TOKEN']) if (!(k in extra)) delete env[k];
    return env;
  };
  const cli = (args, env, input) => { const r = spawnSync(process.execPath, [BIN, ...args], { env, encoding: 'utf8', input, timeout: 60_000 }); return { code: r.status, out: r.stdout, err: r.stderr }; };

  const none = cli(['status'], baseEnv(emptyDir));
  t.ok('起動していない（control.json が無い）: 終了コード 3 と起動の仕方', none.code === 3 && /起動していません/.test(none.err) && /npm start/.test(none.err), `${none.code} ${none.err}`);
  t.ok('起動していなくても、引数なしと --help は使い方を出す（終了コード 0）', cli([], baseEnv(emptyDir)).code === 0 && /使い方/.test(cli(['--help'], baseEnv(emptyDir)).out));
  t.ok('English: --lang en で文も英語', /not running/i.test(cli(['status', '--lang', 'en'], baseEnv(emptyDir)).err) && /Usage/.test(cli(['--lang', 'en'], baseEnv(emptyDir)).out));
  await fs.writeFile(controlFilePath(emptyDir), JSON.stringify({ version: 1, pid: 99999999, origin: 'http://127.0.0.1:1', cliToken: 'a'.repeat(64), startedAt: 1, appVersion: '0', kind: 'server' }));
  t.ok('古い control.json（pid が死んでいる）は未起動として 3', cli(['status'], baseEnv(emptyDir)).code === 3);
  await fs.writeFile(controlFilePath(emptyDir), JSON.stringify({ version: 1, pid: process.pid, origin: 'http://127.0.0.1:9', cliToken: 'a'.repeat(64), startedAt: 1, appVersion: '0', kind: 'server' }));
  t.ok('pid は生きていてもつながらなければ 3', cli(['status'], baseEnv(emptyDir)).code === 3);
  await fs.writeFile(controlFilePath(emptyDir), '{壊れた');
  t.ok('壊れた control.json は未起動として 3（落ちない）', cli(['status'], baseEnv(emptyDir)).code === 3);
  t.ok('環境変数の接続先につながらなくても 3', cli(['status'], baseEnv(emptyDir, { PLEIAD_CONTROL_URL: 'http://127.0.0.1:9', PLEIAD_CONTROL_TOKEN: 'b'.repeat(64) })).code === 3);

  // ---- 起動しているサーバー
  const dataDir = path.join(scratch, 'data');
  const server = await startServer({ env: { AGENT_HOST_BACKENDS: 'fake' }, dataDir, timeoutMs: 60_000 });
  const c = await open({ port: server.port, token: server.token });
  const env = baseEnv(dataDir);
  let mcpAfter = null;
  try {
    const run = (...args) => cli(args, env);
    const s = run('status');
    t.ok('status: つながり先の版・起動時刻・走っている作業の数（操作の一覧から作ったコマンド）', s.code === 0 && /version:/.test(s.out) && /running: 0/.test(s.out), s.out + s.err);
    const sj = run('status', '--json');
    t.ok('--json は JSON を出す', sj.code === 0 && JSON.parse(sj.out).running === 0 && JSON.parse(sj.out).locale.lang === 'ja');
    t.ok('引数なしはコマンドの一覧（操作の一覧から作る）とつなぎ先', (() => { const o = run().out; return /sessions list/.test(o) && /settings get/.test(o) && /つなぎ先: http:\/\/127\.0\.0\.1:\d+（会話に束縛されない）/.test(o); })());
    t.ok('ops: 使える操作の一覧（--json は id・説明・危険度・CLI の形）', /sessions\.list/.test(run('ops').out) && JSON.parse(run('ops', '--json').out).some((o) => o.id === 'sessions.read' && o.cli.path.join(' ') === 'sessions read'));
    t.ok('human-only の代役は CLI の一覧に出ない', !/probe\.humanOnly/.test(run('ops').out));
    // human-only は 5 つだけ（ADR 0094）。外した操作は CLI のコマンドになり、5 つに当たる操作は出ない
    const cliOps = JSON.parse(run('ops', '--json').out);
    t.ok('human-only から外した操作（モデル・分けた作業場所・通知・Hooks の読み出し・接続先・computer の停止）が CLI の一覧に出る',
      ['sessions.setModel', 'worktrees.setSettings', 'worktrees.archive', 'notify.setPc', 'hooks.readPly', 'compatEndpoints.recheck', 'compatEndpoints.delete', 'computer.stop'].every((id) => cliOps.some((o) => o.id === id)));
    t.ok('CLI の一覧に、human-only の 5 つに当たる操作は無い', !cliOps.some((o) => o.risk === 'human-only' || HUMAN_ONLY_COMMANDS.has(registry.get(o.id)?.legacyCommand)));
    t.ok('worktrees settings true / false: 束縛されない CLI から「いつも分ける」を変えられる（write）', run('worktrees', 'settings', 'true').code === 0 && (await c.cmd('worktreeSettings')).always === true
      && run('worktrees', 'settings', 'false').code === 0 && (await c.cmd('worktreeSettings')).always === false);
    t.ok('CLI に 5 つのコマンドは無い（mode・accounts の類は知らないコマンドで 2）', run('call', 'setMode').code === 2 && run('call', 'remoteDevices').code === 2);
    t.ok('--help（コマンドの後ろ）はそのコマンドの引数', (() => { const o = run('sessions', 'read', '--help').out; return /pleiad sessions read <sessionId>/.test(o) && /--message-id/.test(o) && /--before integer/.test(o); })());
    t.ok('途中までのコマンド（sessions）は配下を一覧にして 2', (() => { const r = run('sessions'); return r.code === 2 && /sessions list/.test(r.out) && /sessions rename/.test(r.out); })());
    t.ok('知らないコマンドは 2', run('nothing').code === 2 && /nothing/.test(run('nothing').err));

    const turn = await c.runTurn({ prompt: 'control-info', sessionId: null, cwd: ROOT, backend: 'fake', mode: 'default' }, { ms: 30_000 });
    const info = JSON.parse((await c.cmd('loadSession', { sessionId: turn.sessionId })).messages.at(-1).text);
    const plan = await c.runTurn({ prompt: 'control-info', sessionId: null, cwd: ROOT, backend: 'fake', mode: 'plan' }, { ms: 30_000 });
    const planInfo = JSON.parse((await c.cmd('loadSession', { sessionId: plan.sessionId })).messages.at(-1).text);
    const list = run('sessions', 'list', '--json');
    t.ok('sessions list --json: 会話の一覧', list.code === 0 && JSON.parse(list.out).sessions.some((x) => x.id === turn.sessionId), list.out.slice(0, 200));
    t.ok('sessions list --limit 1 で絞り、next で続き（--cursor）', (() => { const a = JSON.parse(run('sessions', 'list', '--limit', '1', '--json').out); const b = JSON.parse(run('sessions', 'list', '--limit', '1', '--cursor', a.next, '--json').out); return a.sessions.length === 1 && b.sessions.length === 1 && a.sessions[0].id !== b.sessions[0].id; })());
    t.ok('位置引数: sessions get <id>', JSON.parse(run('sessions', 'get', turn.sessionId, '--json').out).id === turn.sessionId);
    t.ok('位置引数と --<名前>: sessions read <id> --after 0 --before 0', JSON.parse(run('sessions', 'read', turn.sessionId, '--before', '0', '--after', '0', '--json').out).messages.length === 1);
    t.ok('settings get <key> と settings list --prefix', /value: external|value: inapp/.test(run('settings', 'get', 'linkOpen').out) && /compaction\.auto/.test(run('settings', 'list', '--prefix', 'compaction.').out) && !/linkOpen/.test(run('settings', 'list', '--prefix', 'compaction.').out));

    // 終了コード
    t.ok('無い会話は 2（SESSION_NOT_FOUND）。文は標準エラーへ', (() => { const r = run('sessions', 'get', 'nope'); return r.code === 2 && /見つかりません/.test(r.err) && r.out === ''; })());
    t.ok('型の違う引数は 2 で、そのコマンドの引数の説明を添える', (() => { const r = run('sessions', 'list', '--limit', 'x'); return r.code === 2 && /--limit/.test(r.err) && /pleiad sessions list/.test(r.err); })());
    t.ok('サーバーが INVALID を返しても 2（上限を超える limit）。どの項目かを出す', (() => { const r = run('sessions', 'list', '--limit', '1000'); return r.code === 2 && /limit/.test(r.err); })());
    t.ok('--json の失敗も JSON（code・error・issues）で、終了コードは同じ', (() => { const r = run('sessions', 'list', '--limit', '1000', '--json'); return r.code === 2 && JSON.parse(r.out).code === 'INVALID' && JSON.parse(r.out).issues[0].path === 'limit'; })());
    t.ok('call: 無い操作は 2、op 無しは 2', run('call', 'nothing.here').code === 2 && run('call').code === 2);
    t.ok('call <op> --args で呼べる', JSON.parse(run('call', 'sessions.get', '--args', JSON.stringify({ sessionId: turn.sessionId }), '--json').out).id === turn.sessionId
      && JSON.parse(run('call', 'sessions.list', '--limit', '1', '--json').out).sessions.length === 1);
    t.ok('call --help <op> は入力の JSON Schema', JSON.parse(run('call', 'sessions.read', '--help').out).input.properties.messageId.type === 'string');
    const guarded = run('probe', 'guarded');
    t.ok('束縛されない CLI の guarded は 4（画面へ誘導する文）', guarded.code === 4 && /画面/.test(guarded.err), guarded.err);

    // 会話に束縛された CLI（環境変数）
    const bound = baseEnv(dataDir, { PLEIAD_CONTROL_URL: info.envUrl, PLEIAD_CONTROL_TOKEN: info.token });
    t.ok('環境変数の接続先は「この会話に束縛」と出す', /この会話に束縛/.test(cli([], bound).out));
    const renamed = cli(['sessions', 'rename', '--title', 'CLI から束縛'], bound);
    t.ok('束縛された CLI は sessionId を省けば、その会話の題を変える（--title）', renamed.code === 0 && /CLI から束縛/.test(renamed.out)
      && (await c.cmd('listSessions')).find((x) => x.id === turn.sessionId)?.title === 'CLI から束縛', renamed.out + renamed.err);
    const change = JSON.parse(cli(['sessions', 'get', turn.sessionId, '--json'], bound).out).changes.find((x) => x.to === 'CLI から束縛');
    t.ok('記録は by: agent・via: cli・その会話', change?.by === 'agent' && change.via === 'cli' && change.bySession === turn.sessionId);
    const ro = cli(['sessions', 'rename', '--title', 'x'], baseEnv(dataDir, { PLEIAD_CONTROL_URL: planInfo.envUrl, PLEIAD_CONTROL_TOKEN: planInfo.token }));
    t.ok('読み取り専用の会話に束縛された CLI の write は 4（READ_ONLY_MODE）', ro.code === 4 && /読み取り専用/.test(ro.err), ro.err);
    // 承認が要る会話に束縛された CLI の guarded は、会話に承認カードを出して待たずに 6（承認待ち）で返る。結果は会話に届く（ADR 0088）
    const cliAsync = (args, env) => new Promise((resolve) => {
      const child = spawn(process.execPath, [BIN, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '', err = '';
      child.stdout.on('data', (d) => { out += d; });
      child.stderr.on('data', (d) => { err += d; });
      child.on('close', (code) => resolve({ code, out, err }));
    });
    const cardOf = (from) => c.waitFor((e) => e.type === 'permission' && e.settingChange && e.sessionId === turn.sessionId, { from, ms: 15_000 });
    const noticeOf = (requestId, from) => c.waitFor((e) => e.type === 'taskNotice' && e.sessionId === turn.sessionId && String(e.text).includes(requestId), { from, ms: 30_000 });
    let from = c.mark();
    const pendingResult = await cliAsync(['probe', 'guarded'], bound);
    const card = await cardOf(from);
    const requestId = card.settingChange.requestId;
    t.ok('束縛された CLI の guarded は承認カードを出し、待たずに 6（承認待ち。requestId と文を出す）', pendingResult.code === 6 && /^setting-/.test(requestId)
      && pendingResult.out.includes(requestId) && /承認を待っています/.test(pendingResult.out), JSON.stringify(pendingResult));
    await c.cmd('resolvePermission', { id: card.id, allow: false, messageKey: 'userDenied', receipt: card.settingChange.receipt });
    const deniedNotice = await noticeOf(requestId, from);
    t.ok('拒否の結果は、その会話へ通知として届く（結果: 拒否）', /結果: 拒否/.test(deniedNotice.text), deniedNotice.text);
    from = c.mark();
    const allowedResult = await cliAsync(['probe', 'guarded', '--json'], bound);
    const card2 = await cardOf(from);
    const pendingJson = JSON.parse(allowedResult.out);
    t.ok('--json の承認待ちも 6 で、status: pending・code・requestId', allowedResult.code === 6 && pendingJson.status === 'pending' && pendingJson.code === 'PENDING_APPROVAL' && pendingJson.requestId === card2.settingChange.requestId, allowedResult.out);
    await c.cmd('resolvePermission', { id: card2.id, allow: true, receipt: card2.settingChange.receipt });
    const allowedNotice = await noticeOf(pendingJson.requestId, from);
    t.ok('許可すると実行され、その結果（結果: 許可）が会話に届く', /結果: 許可/.test(allowedNotice.text), allowedNotice.text);

    // settings set（値は JSON として読み、読めなければ文字列）
    const setOk = run('settings', 'set', 'linkOpen', 'external');
    t.ok('settings set <key> <value>: 文字列の値（束縛されない CLI の write は通る）', setOk.code === 0 && /changed: true/.test(setOk.out) && (await c.cmd('prefs')).linkOpen === 'external', setOk.out + setOk.err);
    t.ok('settings set: 真偽・数は JSON として読む。同じ値は changed: false', run('settings', 'set', 'confirmAgentSites', 'true').code === 0 && (await c.cmd('prefs')).confirmAgentSites === true
      && run('settings', 'set', 'instructionBudget', '9000').code === 0 && (await c.cmd('prefs')).instructionBudget === 9000 && /changed: false/.test(run('settings', 'set', 'instructionBudget', '9000').out));
    const loosen = run('settings', 'set', 'confirmAgentSites', 'false');
    t.ok('束縛されない CLI が関所を緩める設定（確認を切る）を変えると 4（NEEDS_UI。画面へ誘導）。値は変わらない', loosen.code === 4 && /画面/.test(loosen.err) && (await c.cmd('prefs')).confirmAgentSites === true, loosen.err);
    t.ok('settings set: 値の誤りは 2、知らないキーは 2', run('settings', 'set', 'linkOpen', 'javascript:').code === 2 && run('settings', 'set', 'nothing', '1').code === 2 && run('settings', 'set', 'mode', 'auto').code === 2);
    t.ok('settings set --help は json の value を示す', /<value> json/.test(run('settings', 'set', '--help').out));
    t.ok('間違ったトークンは未起動と同じ 3', cli(['status'], baseEnv(dataDir, { PLEIAD_CONTROL_URL: info.envUrl, PLEIAD_CONTROL_TOKEN: 'e'.repeat(64) })).code === 3);
    t.ok('英語の文（--lang en）: サーバーが返す説明と失敗も英語', /Return|version/i.test(run('status', '--lang', 'en').out) && /No conversation found/.test(run('sessions', 'get', 'nope', '--lang', 'en').err));

    // ---- pleiad mcp（本物のプロセス・stdio）
    const rpc = (messages, mcpEnv) => new Promise((resolve) => {
      const child = spawn(process.execPath, [BIN, 'mcp'], { env: mcpEnv, stdio: ['pipe', 'pipe', 'ignore'] });
      let out = '';
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (d) => { out += d; });
      for (const m of messages) child.stdin.write(`${JSON.stringify(m)}\n`);
      const want = messages.filter((m) => m.id !== undefined).length;
      const timer = setInterval(() => { if (out.split('\n').filter(Boolean).filter((l) => JSON.parse(l).id !== undefined).length >= want) { clearInterval(timer); child.kill(); resolve(out.split('\n').filter(Boolean).map((l) => JSON.parse(l))); } }, 50);
      setTimeout(() => { clearInterval(timer); child.kill(); resolve(out.split('\n').filter(Boolean).map((l) => JSON.parse(l))); }, 20_000).unref();
    });
    const j = (replies, id) => replies.find((m) => m.id === id)?.result;
    const text = (replies, id) => JSON.parse(j(replies, id).content[0].text);
    const replies = await rpc([
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'get_session', arguments: { sessionId: turn.sessionId } } },
      { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'call_op', arguments: { op: 'sessions.list', args: { limit: 1 } } } },
      { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'call_op', arguments: { op: 'probe.guarded', args: {} } } },
      { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'list_ops', arguments: {} } },
      { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'call_op', arguments: { op: 'sessions.get', args: { sessionId: 'nope' } } } },
    ], env);
    t.ok('pleiad mcp: initialize は serverInfo・listChanged・指示文（pleiad の外の AI へ）', j(replies, 1).serverInfo.name === 'pleiad' && j(replies, 1).capabilities.tools.listChanged === true && /list_ops/.test(j(replies, 1).instructions), JSON.stringify(j(replies, 1)));
    const toolNames = j(replies, 2).tools.map((x) => x.name);
    t.ok('pleiad mcp: tools/list は ply_control と同じ生成器（直に出す操作・list_ops・call_op）', toolNames.at(-2) === 'list_ops' && toolNames.at(-1) === 'call_op' && toolNames.includes('search_sessions') && toolNames.includes('get_session') && toolNames.includes('read_session') && toolNames.includes('get_setting'), toolNames.join());
    t.ok('pleiad mcp: 直に出すツールで読める', text(replies, 3).id === turn.sessionId);
    t.ok('pleiad mcp: call_op で呼べる', text(replies, 4).sessions.length === 1);
    t.ok('pleiad mcp: 会話に束縛されない（mcp-stdio）ので guarded は NEEDS_UI の isError', j(replies, 5).isError === true && text(replies, 5).code === 'NEEDS_UI');
    t.ok('pleiad mcp: human-only は list_ops に出ない', !text(replies, 6).ops.some((o) => o.id === 'probe.humanOnly') && text(replies, 6).ops.some((o) => o.id === 'sessions.list'));
    t.ok('pleiad mcp: list_ops に外した操作（sessions.setModel・worktrees.setSettings）があり、5 つに当たる操作は無い', text(replies, 6).ops.some((o) => o.id === 'sessions.setModel') && text(replies, 6).ops.some((o) => o.id === 'worktrees.setSettings')
      && !text(replies, 6).ops.some((o) => HUMAN_ONLY_COMMANDS.has(registry.get(o.id)?.legacyCommand)));
    t.ok('pleiad mcp: 失敗は code で返る（SESSION_NOT_FOUND）', j(replies, 7).isError === true && text(replies, 7).code === 'SESSION_NOT_FOUND');
    // 会話に束縛された環境変数で動かした pleiad mcp は、その会話に束縛される（トークンが会話のもの。承認モードを迂回できない）。ask の会話なので承認カードを出す
    from = c.mark();
    const stdioReply = (await rpc([{ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'call_op', arguments: { op: 'probe.guarded', args: {} } } }], bound)).find((m) => m.id === 1).result;
    const card3 = await cardOf(from);
    t.ok('pleiad mcp: 会話に束縛された環境変数なら、その会話の承認モードに従う（ask の会話は承認カードを出し、isError でない承認待ちで返る）', stdioReply.isError !== true
      && JSON.parse(stdioReply.content[0].text).requestId === card3.settingChange.requestId, JSON.stringify(stdioReply));
    await c.cmd('resolvePermission', { id: card3.id, allow: false, messageKey: 'userDenied', receipt: card3.settingChange.receipt });
    await noticeOf(card3.settingChange.requestId, from);

    // 未起動 → 起動で list_changed。本物のサーバーを止めたら元に戻る
    const offline = await rpc([
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }, { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'call_op', arguments: { op: 'sessions.list' } } },
    ], baseEnv(emptyDir));
    t.ok('pleiad mcp（未起動）: 固定の数本（list_ops・call_op）だけを出す', j(offline, 2).tools.map((x) => x.name).join() === 'list_ops,call_op' && /not running/i.test(j(offline, 1).instructions));
    t.ok('pleiad mcp（未起動）: 呼ぶと「未起動」（code: NOT_RUNNING の isError）', j(offline, 3).isError === true && text(offline, 3).code === 'NOT_RUNNING' && /起動していません/.test(text(offline, 3).error));

    const lateDir = path.join(scratch, 'late');
    await fs.mkdir(lateDir, { recursive: true });
    const input = new PassThrough(), output = new PassThrough();
    const seen = [];
    output.setEncoding('utf8');
    let buffer = '';
    output.on('data', (d) => { buffer += d; const lines = buffer.split('\n'); buffer = lines.pop(); for (const l of lines) if (l) seen.push(JSON.parse(l)); });
    const mcpRun = runMcp({ env: baseEnv(lateDir), input, output, lang: 'ja', pollMs: 150 });
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })}\n`);
    for (let i = 0; i < 100 && !seen.length; i++) await sleep(30);
    t.ok('pleiad mcp（後から起動）: 最初は固定の数本', seen[0]?.result?.capabilities?.tools?.listChanged === true);
    const late = await startServer({ env: { AGENT_HOST_BACKENDS: 'fake' }, dataDir: lateDir, timeoutMs: 60_000 });
    try {
      for (let i = 0; i < 200 && !seen.some((m) => m.method === 'notifications/tools/list_changed'); i++) await sleep(50);
      t.ok('pleiad mcp（後から起動）: Pleiad が起動したら notifications/tools/list_changed を出す', seen.some((m) => m.method === 'notifications/tools/list_changed'));
      input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })}\n`);
      for (let i = 0; i < 100 && !seen.some((m) => m.id === 2); i++) await sleep(30);
      t.ok('pleiad mcp（後から起動）: 出し直した一覧に直に出すツールが載る', seen.find((m) => m.id === 2)?.result?.tools?.some((x) => x.name === 'get_session'));
    } finally {
      const before = seen.filter((m) => m.method === 'notifications/tools/list_changed').length;
      await late.stop();
      for (let i = 0; i < 200 && seen.filter((m) => m.method === 'notifications/tools/list_changed').length === before; i++) await sleep(50);
      t.ok('pleiad mcp: Pleiad が止まったら（古い control.json が残っても pid で見分けて）また list_changed を出す', seen.filter((m) => m.method === 'notifications/tools/list_changed').length > before);
    }
    input.end();
    await Promise.race([mcpRun, sleep(3000)]);
    mcpAfter = true;
  } finally {
    c.close();
    await server.stop();
    await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
  t.ok('（確認）pleiad mcp の検査が最後まで走った', mcpAfter === true);
}
