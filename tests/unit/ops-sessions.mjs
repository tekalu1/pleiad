// sessions.*・settings.*・delegation.* の中身（core/ops/）。サーバーを立てずに、純粋な部分と、偽の依存を渡した invoke で確かめる。
//   - sessions.list: 絞り込み・新しい順・ページ送り（cursor は更新時刻と id）・壊れた cursor
//   - sessions.read: messageId の前後・末尾・上限（件数・1 件の字数・合計）・見つからない発言
//   - sessions.setTitle / setStatus: AI は sessionId を省けば自分の会話・人間は省けない・見つからない会話
//   - settings.*: human-only は agent に出ない・値の既定・危険度の riskOf（広げる向きだけ guarded）
//   - delegation.*: 本文を載せない一覧・offset で読む結果
import { registry } from '../../core/ops/index.mjs';
import { OpError } from '../../core/ops/registry.mjs';
import { LIST_DEFAULT, LIST_MAX, READ_CHARS_DEFAULT, READ_CHARS_MAX, READ_SIDE_MAX, READ_TOTAL_MAX, decodeCursor, listRowOf, pageSessions, readWindow } from '../../core/ops/sessions.mjs';
import { settings } from '../../core/ops/settings.mjs';
import { taskRow } from '../../core/ops/delegation.mjs';

export const name = 'ops-sessions';
export const title = '操作の一覧（会話・設定・委譲）: 一覧のページ送り・本文の範囲と上限・題と状態・設定の見え方';

const row = (id, over = {}) => ({ id, title: `会話 ${id}`, backend: 'claude', status: null, cwd: 'D:\\dev\\pleiad', lastModified: 1000, createdAt: '2026-10-01T00:00:00Z', parent: null, delegation: null, claudeAccount: 'acct', compatEndpoint: 'ep', ...over });
const msgs = (n, over = () => ({})) => Array.from({ length: n }, (_, i) => ({ uuid: `m${i}`, role: i % 2 ? 'assistant' : 'user', text: `本文 ${i}`, at: `2026-10-01T00:00:${String(i).padStart(2, '0')}Z`, ...over(i) }));
const throwsCode = (fn) => { try { fn(); return null; } catch (e) { return e instanceof OpError ? e.code : `other:${e.message}`; } };

export default async function (t) {
  // ---- 上限が定義に書いてある
  t.ok('上限: 一覧は既定 30・最大 100、本文は前後 20 件・1 件 8000 字・合計 40000 字', LIST_DEFAULT === 30 && LIST_MAX === 100 && READ_SIDE_MAX === 20 && READ_CHARS_MAX === 8000 && READ_CHARS_DEFAULT === 2000 && READ_TOTAL_MAX === 40000);
  const readOp = registry.get('sessions.read');
  const shape = readOp.input.shape;
  t.ok('入力のスキーマも上限を持つ（before・after は 20、maxChars は 8000 まで）', !shape.before.safeParse(21).success && shape.before.safeParse(20).success && !shape.maxChars.safeParse(8001).success && !shape.after.safeParse(-1).success);
  t.ok('sessions.list の limit は 100 まで', !registry.get('sessions.list').input.shape.limit.safeParse(101).success);

  // ---- 一覧: 絞り込み
  const rows = [
    row('a', { lastModified: 5000, title: 'ネイティブの検索', status: '進行中', backend: 'codex', cwd: 'D:/dev/other' }),
    row('b', { lastModified: 4000, status: '進行中' }),
    row('c', { lastModified: 3000, parent: 'b', delegation: { taskId: 't' } }),
    row('d', { lastModified: 3000, title: 'Docs の修正' }),
    row('x', { lastModified: 100, unsent: true }),
    row('e', { lastModified: 2000, cwd: 'D:\\dev\\pleiad\\sub', parent: { sessionId: 'b' } }),
  ];
  const ids = (page) => page.sessions.map((s) => s.id).join();
  t.ok('新しい順、同じ時刻は id の昇順。まだ送っていない下書きは出さない', ids(pageSessions(rows, {})) === 'a,b,c,d,e', ids(pageSessions(rows, {})));
  t.ok('total は絞った件数', pageSessions(rows, {}).total === 5 && pageSessions(rows, { status: '進行中' }).total === 2);
  t.ok('backend・状態・親・題で絞る（題は大文字小文字・全角半角を区別しない）', ids(pageSessions(rows, { backend: 'codex' })) === 'a' && ids(pageSessions(rows, { status: '進行中' })) === 'a,b'
    && ids(pageSessions(rows, { parent: 'b' })) === 'c,e' && ids(pageSessions(rows, { query: 'docs' })) === 'd' && ids(pageSessions(rows, { query: 'ＤＯＣＳ' })) === 'd');
  t.ok('状態が空の文字列なら状態の無い会話', ids(pageSessions(rows, { status: '' })) === 'c,d,e');
  t.ok('場所はそのフォルダーとその下（区切りと大文字小文字を区別しない）。前方一致で別のフォルダーを拾わない',
    ids(pageSessions(rows, { cwd: 'd:/DEV/pleiad' })) === 'b,c,d,e' && ids(pageSessions(rows, { cwd: 'D:\\dev\\plei' })) === '');
  t.ok('委譲の子を除ける', ids(pageSessions(rows, { includeDelegated: false })) === 'a,b,d,e');
  t.ok('出す欄は決まっていて、アカウント・接続先・下書きなどは出さない', Object.keys(listRowOf(rows[0])).join() === 'id,title,backend,status,cwd,parent,delegated,lastModified,createdAt');

  // ---- 一覧: ページ送り
  const many = Array.from({ length: 7 }, (_, i) => row(`s${i}`, { lastModified: 9000 - Math.floor(i / 2) * 10 }));
  const p1 = pageSessions(many, { limit: 3 });
  const p2 = pageSessions(many, { limit: 3, cursor: p1.next });
  const p3 = pageSessions(many, { limit: 3, cursor: p2.next });
  t.ok('cursor で続きから返し、全部をちょうど 1 回ずつ読める（時刻が同じ会話をまたいでも）',
    ids(p1) === 's0,s1,s2' && ids(p2) === 's3,s4,s5' && ids(p3) === 's6' && p3.next === null && p1.total === 7, [ids(p1), ids(p2), ids(p3)].join(' | '));
  const grown = [row('s9', { lastModified: 9999 }), ...many];
  t.ok('間に会話が増えても、続きは重複しない（cursor は位置ではなく更新時刻と id）', ids(pageSessions(grown, { limit: 3, cursor: p1.next })) === 's3,s4,s5');
  t.ok('最後の行を超える cursor は空', pageSessions(many, { cursor: encode('s6', many) }).sessions.length === 0);
  t.ok('壊れた cursor は INVALID', throwsCode(() => pageSessions(many, { cursor: 'zzz' })) === 'INVALID' && decodeCursor('zzz') === null && decodeCursor(Buffer.from('[1]').toString('base64url')) === null);

  // ---- 本文: 範囲
  const all = msgs(30);
  const mid = readWindow(all, { messageId: 'm10', before: 2, after: 3 });
  t.ok('messageId の前後だけを返し、位置と全体の数・続きの有無を添える', mid.messages.map((m) => m.uuid).join() === 'm8,m9,m10,m11,m12,m13' && mid.total === 30 && mid.from === 8 && mid.to === 13 && mid.hasMoreBefore && mid.hasMoreAfter);
  const tail = readWindow(all, {});
  t.ok('messageId を省くと末尾を中心にする（既定は前 4 件）', tail.messages.map((m) => m.uuid).join() === 'm25,m26,m27,m28,m29' && !tail.hasMoreAfter && tail.hasMoreBefore);
  t.ok('先頭・末尾を超えない', readWindow(all, { messageId: 'm0', before: 5, after: 1 }).messages.length === 2 && !readWindow(all, { messageId: 'm0' }).hasMoreBefore);
  t.ok('見つからない発言は MESSAGE_NOT_FOUND', throwsCode(() => readWindow(all, { messageId: 'nope' })) === 'MESSAGE_NOT_FOUND');
  t.ok('空の会話は空', readWindow([], {}).messages.length === 0 && readWindow([], {}).total === 0);
  t.ok('人とエージェントの発言だけ（システムの行・ツールの行は数えない）', readWindow([{ uuid: 's', role: 'system', text: 'x' }, ...msgs(2)], {}).total === 2);
  const withTools = readWindow(msgs(2, (i) => (i === 1 ? { toolCalls: [{ name: 'Read' }, { name: 'Grep' }] } : {})), {});
  t.ok('ツールは名前だけ載せる（入力・結果は載せない）', withTools.messages[1].tools.join() === 'Read,Grep' && !JSON.stringify(withTools).includes('input'));

  // ---- 本文: 上限
  const long = msgs(3, () => ({ text: 'あ'.repeat(5000) }));
  const cut = readWindow(long, { maxChars: 100 });
  t.ok('1 件は maxChars 字で切り、切ったことを truncated で知らせる', cut.messages.every((m) => m.text.length === 100 && m.truncated === true));
  const fits = readWindow(msgs(2), { maxChars: 100 });
  t.ok('収まるものは truncated: false', fits.messages.every((m) => m.truncated === false));
  const big = readWindow(msgs(30, () => ({ text: 'x'.repeat(8000) })), { messageId: 'm0', after: 20, maxChars: 8000 });
  const total = big.messages.reduce((n, m) => n + m.text.length, 0);
  t.ok('返り全体の本文は 40000 字まで。超えた分は返さず hasMoreAfter で知らせる', total <= READ_TOTAL_MAX && big.messages.length === 5 && big.hasMoreAfter === true && big.to === 4, `${total} 字・${big.messages.length} 件`);

  // ---- invoke: 偽の依存（会話の本体はサーバーが渡す）
  const human = { by: 'human', via: 'ui', local: true };
  const agent = (sessionId) => ({ by: 'agent', via: 'mcp', sessionId });
  const calls = [];
  const sessionsDep = {
    list: async () => rows,
    get: async (id) => (id === 'a' || id === 'me' ? { row: row(id, { mode: 'default', model: 'smart', effort: '' }), children: ['c'], history: Array.from({ length: 12 }, (_, i) => ({ at: `2026-10-0${1 + (i % 9)}T00:00:00Z`, by: i === 11 ? 'agent' : 'human', ...(i === 11 ? { via: 'mcp', bySession: 'me' } : {}), field: 'title', from: `t${i}`, to: `t${i + 1}`, reason: null })) } : null),
    read: async (id) => (id === 'a' ? all : null),
    setTitle: async (id, title, opts) => { calls.push(['title', id, title, opts]); },
    setStatus: async (id, status, opts) => { calls.push(['status', id, status, opts]); return ['k']; },
  };
  const deps = { locale: 'ja', sessions: sessionsDep, modeOf: async () => ({ scope: 'workspace', autonomy: 'ask' }), audit: () => {} };
  const run = (p, id, args) => registry.invoke(p, id, args, deps);

  const list = await run(agent('me'), 'sessions.list', { limit: 2 });
  t.ok('sessions.list は件数・行・next を返す', list.ok && list.result.sessions.length === 2 && list.result.total === 5 && typeof list.result.next === 'string');
  const bad = await run(agent('me'), 'sessions.list', { cursor: 'zzz' });
  t.ok('壊れた cursor は INVALID（文は辞書から）', !bad.ok && bad.code === 'INVALID' && /cursor/.test(bad.error), bad.error);
  const got = await run(agent('me'), 'sessions.get', { sessionId: 'a' });
  t.ok('sessions.get はメタ・子・最近の変更（新しい方から 10 件）を返し、変えた主体と口と会話を残す', got.ok && got.result.children.join() === 'c' && got.result.changes.length === 10
    && got.result.changes[0].by === 'agent' && got.result.changes[0].via === 'mcp' && got.result.changes[0].bySession === 'me' && got.result.mode === 'default', JSON.stringify(got.result?.changes?.[0]));
  const miss = await run(human, 'sessions.get', { sessionId: 'nope' });
  t.ok('無い会話は SESSION_NOT_FOUND', !miss.ok && miss.code === 'SESSION_NOT_FOUND' && miss.error.includes('nope'));
  const read = await run(human, 'sessions.read', { sessionId: 'a', messageId: 'm5', before: 1, after: 1 });
  t.ok('sessions.read は範囲を返す', read.ok && read.result.messages.map((m) => m.uuid).join() === 'm4,m5,m6' && read.result.sessionId === 'a');
  t.ok('sessions.read の無い会話は SESSION_NOT_FOUND、無い発言は MESSAGE_NOT_FOUND', (await run(human, 'sessions.read', { sessionId: 'z' })).code === 'SESSION_NOT_FOUND'
    && (await run(human, 'sessions.read', { sessionId: 'a', messageId: 'zz' })).code === 'MESSAGE_NOT_FOUND');
  t.ok('上限を超える入力は INVALID', (await run(human, 'sessions.read', { sessionId: 'a', after: 99 })).code === 'INVALID');

  const own = await run(agent('me'), 'sessions.setTitle', { title: '  新しい題  ', reason: '整理' });
  t.ok('AI は sessionId を省けば自分の会話の題を変える（前後の空白は削る）', own.ok && own.result.sessionId === 'me' && own.result.title === '新しい題' && calls[0].join('|').startsWith('title|me|新しい題'), JSON.stringify(calls[0]));
  t.ok('変えた主体（actor）が本体へ渡る（by・via・会話）', calls[0][3].actor.by === 'agent' && calls[0][3].actor.via === 'mcp' && calls[0][3].actor.sessionId === 'me' && calls[0][3].reason === '整理');
  const other = await run(agent('me'), 'sessions.setTitle', { sessionId: 'a', title: '別の会話' });
  t.ok('別の会話の題も変えられる（write。どの会話の AI かは actor で残る）', other.ok && calls[1][1] === 'a' && calls[1][3].actor.sessionId === 'me');
  const needId = await run(human, 'sessions.setTitle', { title: 'x' });
  t.ok('人間（画面）は sessionId を省けない', !needId.ok && needId.code === 'INVALID');
  t.ok('束縛されない CLI も省けない', (await run({ by: 'agent', via: 'cli' }, 'sessions.setStatus', { status: 'x' })).code === 'INVALID');
  t.ok('空の題・長すぎる題は INVALID', (await run(human, 'sessions.setTitle', { sessionId: 'a', title: '   ' })).code === 'INVALID' && (await run(human, 'sessions.setTitle', { sessionId: 'a', title: 'x'.repeat(201) })).code === 'INVALID');
  t.ok('無い会話は SESSION_NOT_FOUND で、書かない', (await run(human, 'sessions.setTitle', { sessionId: 'nope', title: 'x' })).code === 'SESSION_NOT_FOUND' && calls.length === 2);
  const st = await run(agent('me'), 'sessions.setStatus', { sessionId: 'a', status: '完了', alone: true });
  t.ok('sessions.setStatus は移した会話の id を返す', st.ok && st.result.moved.join() === 'k' && calls[2][3].alone === true);
  const ro = await registry.invoke(agent('me'), 'sessions.setTitle', { title: 'x' }, { ...deps, modeOf: async () => ({ scope: 'readonly', autonomy: 'ask' }) });
  t.ok('読み取り専用の会話の AI は題を変えられない（READ_ONLY_MODE）。読むのは通る', ro.code === 'READ_ONLY_MODE'
    && (await registry.invoke(agent('me'), 'sessions.list', {}, { ...deps, modeOf: async () => ({ scope: 'readonly', autonomy: 'ask' }) })).ok);

  // ---- 設定
  const prefs = { linkOpen: 'external', agentSitePermissions: [{ origin: 'https://a.example', mode: 'always', token: 'SECRET-X' }], mode: 'bypass' };
  const sdeps = { locale: 'ja', prefs: async () => prefs, compactionSettings: () => ({ enabled: false, minTokens: 200000 }) };
  const listed = (await registry.invoke(agent(undefined), 'settings.list', {}, sdeps)).result.settings.map((s) => s.key);
  t.ok('settings.list は agent から human-only（承認モード）を除く。human には出す', !listed.includes('mode') && listed.includes('linkOpen') && listed.includes('compaction.auto')
    && (await registry.invoke(human, 'settings.list', {}, sdeps)).result.settings.some((s) => s.key === 'mode'));
  t.ok('settings.list は prefix で絞る', (await registry.invoke(human, 'settings.list', { prefix: 'compaction.' }, sdeps)).result.settings.map((s) => s.key).join() === 'compaction.auto');
  const hidden = await registry.invoke(agent(undefined), 'settings.get', { key: 'mode' }, sdeps);
  const unknownKey = await registry.invoke(agent(undefined), 'settings.get', { key: 'nothing' }, sdeps);
  t.ok('agent が human-only の設定を引くと、無い設定と同じ SETTING_NOT_FOUND', hidden.code === 'SETTING_NOT_FOUND' && unknownKey.code === 'SETTING_NOT_FOUND' && hidden.error.replace('mode', 'X') === unknownKey.error.replace('nothing', 'X'));
  t.ok('human は承認モードの既定を読める', (await registry.invoke(human, 'settings.get', { key: 'mode' }, sdeps)).result.value === 'bypass');
  const got1 = await registry.invoke(agent(undefined), 'settings.get', { key: 'linkOpen' }, sdeps);
  t.ok('settings.get は現在値・既定値・危険度・読むだけか（書ける設定は false）を返す', got1.result.value === 'external' && got1.result.default === 'inapp' && got1.result.risk === 'write' && got1.result.readOnly === false);
  t.ok('未設定は既定値を返す', (await registry.invoke(agent(undefined), 'settings.get', { key: 'locale' }, sdeps)).result.value === 'auto');
  t.ok('モジュールが持つ値（自動圧縮）はその値を返す', (await registry.invoke(agent(undefined), 'settings.get', { key: 'compaction.auto' }, sdeps)).result.value.minTokens === 200000);
  const masked = await registry.invoke(agent(undefined), 'settings.get', { key: 'agentSitePermissions' }, sdeps);
  t.ok('秘密らしい名前の欄は伏せて返す（最後の網）', !JSON.stringify(masked.result).includes('SECRET-X') && masked.result.value[0].token === '••••');
  const sch = await registry.invoke(agent(undefined), 'settings.schema', { key: 'linkOpen' }, sdeps);
  t.ok('settings.schema は JSON Schema と既定値を返す', sch.result.settings[0].schema.enum.join() === 'inapp,external' && sch.result.settings[0].default === 'inapp');
  t.ok('settings.schema は key を省くと全部（agent には human-only を除く）', (await registry.invoke(agent(undefined), 'settings.schema', {}, sdeps)).result.settings.length === settings.length - settings.filter((s) => s.risk === 'human-only').length);

  // 広げる向きだけ guarded（settings.set の規則。書く側の検査は ops-settings）
  const def = (key) => registry.getSetting(key);
  t.ok('確認を切る向きは guarded、付ける向きは write（confirmAgentSites・confirmExternalLoads）', ['confirmAgentSites', 'confirmExternalLoads'].every((k) => def(k).riskOf(true, false) === 'guarded' && def(k).riskOf(false, true) === 'write' && def(k).riskOf(true, true) === 'write'));
  t.ok('computer use は有効にする・全アプリを許可する・常に許可を足す向きだけ guarded', def('computerUse').riskOf({ enabled: false }, { enabled: true }) === 'guarded'
    && def('computerUse').riskOf({}, { allowAllApps: true }) === 'guarded' && def('computerUse').riskOf({ alwaysAllowed: [] }, { alwaysAllowed: [{ id: 'x' }] }) === 'guarded'
    && def('computerUse').riskOf({ enabled: true }, { enabled: false }) === 'write' && def('computerUse').riskOf({ alwaysAllowed: [{ id: 'x' }] }, { alwaysAllowed: [] }) === 'write');
  t.ok('承認モードとアカウントは human-only。秘密を持つものは設定に無い', def('mode').risk === 'human-only' && def('claudeAccount').risk === 'human-only' && !settings.some((s) => /key|token|secret|password/i.test(s.key)));
  t.ok('書ける設定は、前の版の名残の addedContext 以外の全部', settings.filter((s) => s.readOnly).map((s) => s.key).join() === 'addedContext');

  // ---- 委譲
  const tasks = [
    { taskId: 't1', title: '調査', status: 'running', backend: 'codex', model: 'm', cwd: '/x', parentSessionId: 'p', sessionId: 'c1', createdAt: 10, updatedAt: 20, result: 'long result', queue: [{ text: 'secret prompt' }], instructions: [], context: 'ctx', routing: { kind: 'investigate', mode: 'auto', target: { backend: 'codex', model: 'm', account: 'acct' } } },
    { taskId: 't2', status: 'completed', parentSessionId: 'q', createdAt: 30 },
    { taskId: 't3', status: 'completed', parentSessionId: 'p', createdAt: 20 },
  ];
  const ddeps = { locale: 'ja', delegation: { list: (owner) => tasks.filter((r) => !owner || r.parentSessionId === owner), get: (id, offset) => { const r = tasks.find((x) => x.taskId === id); return r ? { ...r, result: (r.result ?? '').slice(offset), resultOffset: offset, resultLength: (r.result ?? '').length, nextOffset: null } : null; } } };
  const dl = await registry.invoke(agent('me'), 'delegation.tasks', { status: 'completed' }, ddeps);
  t.ok('delegation.tasks は新しい順で、状態・依頼元で絞れる', dl.result.tasks.map((x) => x.taskId).join() === 't2,t3' && (await registry.invoke(agent('me'), 'delegation.tasks', { parentSessionId: 'p' }, ddeps)).result.total === 2);
  const row1 = (await registry.invoke(agent('me'), 'delegation.tasks', { parentSessionId: 'p', limit: 1 }, ddeps)).result.tasks[0];
  t.ok('一覧の行は依頼・結果・コンテキストを載せず、振り分けの要約だけ（アカウントは載せない）', row1.taskId === 't3' && !('result' in row1) && !('queue' in row1) && taskRow(tasks[0]).routing.backend === 'codex' && !JSON.stringify(taskRow(tasks[0])).includes('acct') && !JSON.stringify(taskRow(tasks[0])).includes('secret prompt'));
  const ds = await registry.invoke(human, 'delegation.status', { taskId: 't1', offset: 5 }, ddeps);
  t.ok('delegation.status は結果を offset から返す', ds.ok && ds.result.result === 'result' && ds.result.resultOffset === 5 && ds.result.resultLength === 11);
  t.ok('無いタスクは TASK_NOT_FOUND', (await registry.invoke(human, 'delegation.status', { taskId: 'zz' }, ddeps)).code === 'TASK_NOT_FOUND');

  // ---- 一覧: どの口に出すか
  const direct = registry.list({ by: 'agent', via: 'mcp' }).filter((o) => o.surfaces.mcp === 'direct').map((o) => o.id).filter((id) => id !== 'sessions.search').sort().join();
  t.ok('MCP に直に出す操作は 会話の取得・本文・設定の読み書き（検索 sessions.search は別の定義）', direct === 'sessions.get,sessions.read,settings.get,settings.set', direct);
}

function encode(id, rows) {
  const r = rows.find((x) => x.id === id);
  return Buffer.from(JSON.stringify([r.lastModified, r.id])).toString('base64url');
}
