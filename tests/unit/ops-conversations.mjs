// 会話・選べるもの・委譲の操作（core/ops/conversations.mjs・agents.mjs・delegation.mjs・statuses.mjs）の中身。
// サーバーを立てずに、偽の依存を渡した invoke で確かめる（サーバー越しの検査は server-ops-conversations）。
//   - 危険度（write・guarded）と、承認モード・アカウント・接続先を AI が渡したら NEEDS_UI
//   - 画面（人）には全量の形（uiHandler）、AI・CLI には上限のある形（一覧は limit / cursor・本文は切る）
//   - abort は AI に理由が必須で、止めた会話の変更の記録に残す
//   - delegation.retry は自分の子だけ・強い承認モードの確認は人だけ
import { registry } from '../../core/ops/index.mjs';
import { pageOf, PAGE_MAX } from '../../core/ops/host.mjs';
import { OUTBOX_CHARS } from '../../core/ops/conversations.mjs';
import { INSTRUCTION_CHARS } from '../../core/ops/delegation.mjs';

export const name = 'ops-conversations';
export const title = '操作の一覧（会話・選べるもの・委譲の続き）: 危険度・人だけの項目・画面と AI の形・理由の記録・自分の子だけ';

const human = { by: 'human', via: 'ui', local: true };
const agent = (sessionId = 'me', via = 'mcp') => ({ by: 'agent', via, sessionId });
const MODE = { scope: 'workspace', autonomy: 'ask' };
const NEVER_FULL = { scope: 'full', autonomy: 'never' };

export default async function (t) {
  const calls = [];
  const audits = [];
  const rec = (name, ret) => async (...a) => { calls.push([name, ...a]); return typeof ret === 'function' ? ret(...a) : ret; };
  const sessionRow = (id, over = {}) => ({ id, title: `会話 ${id}`, backend: 'claude', status: null, cwd: 'D:\\dev\\a', lastModified: 1, parent: null, delegation: null, ...over });
  const family = [sessionRow('root'), sessionRow('kid', { parent: { sessionId: 'root' } }), sessionRow('me', { parent: { sessionId: 'root' } })];
  const owned = { taskId: 'ply-task-own', status: 'running', parentSessionId: 'me', backend: 'codex', model: 'm', title: 't' };
  const foreign = { taskId: 'ply-task-other', status: 'running', parentSessionId: 'someone', backend: 'codex', model: 'm', title: 't' };
  const deps = (mode = MODE) => ({
    locale: 'ja', modeOf: async () => mode, audit: (e) => audits.push([e.op, e.risk]), approve: undefined,
    sessions: {
      list: async () => family,
      rows: async () => family,
      get: async (id) => (family.some((r) => r.id === id) ? { row: family.find((r) => r.id === id), children: [], history: [] } : id === 'draft' ? { row: sessionRow('draft', { unsent: true, title: '下書き' }), children: [], history: [] } : null),
      history: async (id) => (id === 'me' ? Array.from({ length: 5 }, (_, i) => ({ at: `a${i}`, by: 'human', field: 'title', from: `t${i}`, to: `t${i + 1}`, reason: null, reasonKey: 'menu' })) : null),
    },
    conversations: {
      create: rec('create', { sessionId: 'new1' }), deleteUnsent: rec('deleteUnsent', undefined), delete: rec('delete', 'deleted'),
      // 消せない会話（走っている など）はサーバーが CANNOT_DELETE で断る
      canDelete: async (id) => { calls.push(['canDelete', id]); if (id === 'kid') throw Object.assign(new Error('実行中'), { code: 'CANNOT_DELETE' }); },
      abort: rec('abort', (a) => ({ aborted: 1, reason: a.kind ?? 'user' })), resume: rec('resume', { sent: 'text', count: 1 }),
      compact: rec('compact', { status: 'started' }), cancelCompaction: rec('cancelCompaction', { cancelled: true }),
      setAutoCompaction: rec('setAutoCompaction', (id, off) => ({ off })), setTurnSettings: rec('setTurnSettings', { backend: 'claude', model: 'm', effort: '' }),
      suggestTitle: rec('suggestTitle', { title: '題' }),
      outbox: async () => Array.from({ length: 40 }, (_, i) => ({ id: `q${i}`, status: 'queued', at: 'a', args: { prompt: 'あ'.repeat(i === 0 ? 2000 : 5), attached: i === 1 ? [{}] : [] } })),
    },
    statuses: { list: async () => Array.from({ length: 120 }, (_, i) => ({ status: `s${i}`, count: 1, firstUsedAt: null, lastUsedAt: null, icon: null, kept: false })), rename: rec('rename', { moved: 2 }) },
    agents: {
      list: async () => [{ id: 'claude', label: 'Claude', description: 'x'.repeat(500), capabilities: { fork: true, compact: false, login: true } }],
      models: async () => ({ backend: 'claude', models: Object.fromEntries(Array.from({ length: 150 }, (_, i) => [`m${i}`, { label: `M${i}`, note: 'n'.repeat(400) }])) }),
      modes: async () => ({ backend: 'claude', modes: { default: { label: 'D', note: 'n' } } }),
      efforts: async () => ({ backend: 'claude', efforts: { '': { label: '既定', resolvesTo: 'high' }, low: { label: 'low' } } }),
      authStatus: async () => ({ backend: 'claude', status: { supported: true, installed: true, loggedIn: false, pending: true, account: 'x@example.invalid', detail: 'd' } }),
    },
    delegation: {
      list: () => [owned, foreign], get: (id) => [owned, foreign].find((r) => r.taskId === id) ?? null,
      call: rec('call', { stopped: true }), cancel: rec('cancel', owned),
      instructions: (id) => (id === 'ply-task-own' ? { taskId: id, revision: 3, instructions: Array.from({ length: 3 }, (_, i) => ({ id: `i${i}`, text: 'あ'.repeat(i === 0 ? 5000 : 3), at: i, state: 'queued' })) } : null),
      retry: rec('retry', (a) => (a.candidate === 'strong:model' ? { confirm: { agent: 'Strong', mode: 'bypass' } } : { task: { ...owned, taskId: 'ply-task-new' } })),
      routing: async ({ refresh }) => ({ settings: { enabled: true }, defaults: { big: 1 }, kinds: ['a'], warnings: [], keys: { openrouter: { hasKey: true } }, candidates: Array.from({ length: 60 }, (_, i) => ({ candidate: `c:${i}` })), refresh }),
      providerUsage: rec('providerUsage', { backend: 'codex', label: 'Codex', quota: {}, local: {} }),
    },
  });
  const run = (p, id, args, d = deps()) => registry.invoke(p, id, args ?? {}, d);

  // ---- 危険度（定義）
  const risk = (id) => registry.get(id).risk;
  t.ok('書く操作は write、消す sessions.deleteUnsent・sessions.delete は guarded、読むものは read',
    ['sessions.new', 'sessions.abort', 'sessions.resume', 'sessions.compact', 'sessions.cancelCompaction', 'sessions.setAutoCompaction', 'sessions.setTurnSettings', 'statuses.rename', 'delegation.retry'].every((id) => risk(id) === 'write')
    && risk('sessions.deleteUnsent') === 'guarded' && risk('sessions.delete') === 'guarded'
    && ['sessions.suggestTitle', 'sessions.listMessages', 'sessions.changes', 'sessions.lineage', 'statuses.list', 'agents.list', 'agents.models', 'agents.modes', 'agents.efforts', 'agents.authStatus', 'delegation.instructions', 'delegation.routing'].every((id) => risk(id) === 'read'));
  t.ok('legacyCommand: 移した WS コマンドが操作に結ばれている（別の入口は settings.set の別名）',
    registry.get('sessions.new').legacyCommand === 'newSession' && registry.get('sessions.list').legacyCommand === 'listSessions' && registry.get('app.running').legacyCommand === 'running'
    && registry.get('delegation.taskCancel').legacyCommand === 'cancelAgentTask' && registry.get('delegation.usage').legacyCommand === 'providerUsage'
    && registry.get('settings.set').legacyAliases.join() === 'setAutoCompaction,setDelegationRouting');
  t.ok('setDelegationRouting は設定の delegationRouting（guarded）と同じ定義を通る。別の write の口は無い', registry.getSetting('delegationRouting').risk === 'guarded'
    && !registry.ops.some((o) => o.legacyCommand === 'setDelegationRouting'));

  // ---- sessions.new: 人だけの項目
  const created = await run(agent(), 'sessions.new', { cwd: 'D:\\dev\\a', draft: '見直しを頼む' });
  t.ok('sessions.new は AI も通る（下書きの会話ができるだけ）', created.ok && created.result.sessionId === 'new1' && calls.some((c) => c[0] === 'create' && c[1].draft === '見直しを頼む'));
  t.ok('承認モード・接続先を AI が渡すと NEEDS_UI（作らない）', (await run(agent(), 'sessions.new', { mode: 'bypass' })).code === 'NEEDS_UI' && (await run(agent(), 'sessions.new', { endpoint: 'ep' })).code === 'NEEDS_UI'
    && calls.filter((c) => c[0] === 'create').length === 1);
  t.ok('人（画面）は承認モードも渡せる', (await run(human, 'sessions.new', { mode: 'default' })).ok && calls.at(-1)[1].mode === 'default');

  // ---- sessions.deleteUnsent: guarded
  const del = await run(agent(), 'sessions.deleteUnsent', { sessionId: 'draft' });
  t.ok('sessions.deleteUnsent は AI には承認が要る（承認の口が無ければ NEEDS_APPROVAL。消さない）', !del.ok && del.code === 'NEEDS_APPROVAL' && !calls.some((c) => c[0] === 'deleteUnsent'));
  t.ok('束縛されない CLI は NEEDS_UI', (await run({ by: 'agent', via: 'cli' }, 'sessions.deleteUnsent', { sessionId: 'draft' })).code === 'NEEDS_UI');
  t.ok('承認なしのモード（full・never）では通り、記録が残る', (await run(agent(), 'sessions.deleteUnsent', { sessionId: 'draft' }, deps(NEVER_FULL))).ok && calls.some((c) => c[0] === 'deleteUnsent' && c[1] === 'draft') && audits.some((a) => a[0] === 'sessions.deleteUnsent' && a[1] === 'guarded'));
  t.ok('人（画面）はそのまま消せる。無い会話は承認前に SESSION_NOT_FOUND', (await run(human, 'sessions.deleteUnsent', { sessionId: 'draft' })).ok
    && (await run(agent(), 'sessions.deleteUnsent', { sessionId: 'nope' })).code === 'SESSION_NOT_FOUND');

  // ---- sessions.delete: 送った会話も消す。guarded（ADR 0147）
  const gone = await run(agent(), 'sessions.delete', { sessionId: 'root' });
  t.ok('sessions.delete は AI には承認が要る（承認の口が無ければ NEEDS_APPROVAL。消さない）', !gone.ok && gone.code === 'NEEDS_APPROVAL' && !calls.some((c) => c[0] === 'delete'));
  t.ok('sessions.delete: 束縛されない CLI は NEEDS_UI', (await run({ by: 'agent', via: 'cli' }, 'sessions.delete', { sessionId: 'root' })).code === 'NEEDS_UI' && !calls.some((c) => c[0] === 'delete'));
  t.ok('sessions.delete: 承認なしのモード（full・never）では通り、記録が残る', (await run(agent(), 'sessions.delete', { sessionId: 'root' }, deps(NEVER_FULL))).ok
    && calls.some((c) => c[0] === 'delete' && c[1] === 'root') && audits.some((a) => a[0] === 'sessions.delete' && a[1] === 'guarded'));
  const humanDelete = await run(human, 'sessions.delete', { sessionId: 'root' });
  t.ok('sessions.delete: 人（画面）はそのまま消せる', humanDelete.ok && humanDelete.result.deleted === true);
  calls.length = 0;
  const busyDelete = await run(agent(), 'sessions.delete', { sessionId: 'kid' }, deps(NEVER_FULL));
  t.ok('sessions.delete: 消せない会話（走っている など）は、承認カードを出す前にサーバーの理由（CANNOT_DELETE）で断る', busyDelete.code === 'CANNOT_DELETE' && /実行中/.test(busyDelete.error) && !calls.some((c) => c[0] === 'delete'));
  t.ok('sessions.delete: 無い会話は承認前に SESSION_NOT_FOUND、自分の会話は DELETE_SELF', (await run(agent(), 'sessions.delete', { sessionId: 'nope' })).code === 'SESSION_NOT_FOUND'
    && (await run(agent('me'), 'sessions.delete', { sessionId: 'me' }, deps(NEVER_FULL))).code === 'DELETE_SELF' && !calls.some((c) => c[0] === 'delete'));

  // ---- sessions.abort: 理由が必須
  calls.length = 0;
  t.ok('AI の abort は理由が無いと INVALID（止めない）', (await run(agent(), 'sessions.abort', { sessionId: 'kid' })).code === 'INVALID' && !calls.some((c) => c[0] === 'abort'));
  const stopped = await run(agent(), 'sessions.abort', { sessionId: 'kid', reason: '暴走していたので止めた' });
  const abortCall = calls.find((c) => c[0] === 'abort')?.[1];
  t.ok('AI の abort は止めた会話・理由・誰が（actor）を本体へ渡す（種類は user に固定）', stopped.ok && abortCall.sessionId === 'kid' && abortCall.note === '暴走していたので止めた'
    && abortCall.kind === 'user' && abortCall.actor.by === 'agent' && abortCall.actor.sessionId === 'me');
  t.ok('無い会話は SESSION_NOT_FOUND（止めない）', (await run(agent(), 'sessions.abort', { sessionId: 'nope', reason: 'x' })).code === 'SESSION_NOT_FOUND');
  t.ok('sessionId を省いた AI は自分の会話。束縛されない CLI は省けない', (await run(agent(), 'sessions.abort', { reason: 'x' })).ok && calls.at(-1)[1].sessionId === 'me'
    && (await run({ by: 'agent', via: 'cli' }, 'sessions.abort', { reason: 'x' })).code === 'INVALID');
  calls.length = 0;
  t.ok('人（画面）は sessionId を省くと全部止められ、理由は要らない（種類 update・quit）', (await run(human, 'sessions.abort', { kind: 'update' })).ok && calls[0][1].sessionId === undefined && calls[0][1].kind === 'update' && calls[0][1].note === undefined);
  t.ok('読み取りの会話の AI は止められない（write）', (await run(agent(), 'sessions.abort', { sessionId: 'kid', reason: 'x' }, deps({ scope: 'readonly', autonomy: 'ask' }))).code === 'READ_ONLY_MODE');

  // ---- sessions.setTurnSettings: 作業フォルダー・エージェントは guarded、人だけの項目
  calls.length = 0;
  t.ok('モデルと強さの予約は write（承認なしで通る）', (await run(agent(), 'sessions.setTurnSettings', { model: 'm', effort: 'low' })).ok && calls[0][1].sessionId === 'me');
  t.ok('作業フォルダーを替えるのは AI には承認が要る', (await run(agent(), 'sessions.setTurnSettings', { cwd: 'D:\\x' })).code === 'NEEDS_APPROVAL');
  t.ok('エージェントを替えるのも承認が要る。取り消し（cancel）は要らない', (await run(agent(), 'sessions.setTurnSettings', { backend: 'codex' })).code === 'NEEDS_APPROVAL'
    && (await run(agent(), 'sessions.setTurnSettings', { cwd: 'D:\\x', cancel: true })).ok);
  t.ok('承認モード・アカウント・接続先・既定として覚えるは AI には NEEDS_UI（予約しない）', (await Promise.all([{ mode: 'bypass' }, { account: 'a' }, { endpoint: 'e' }, { rememberMode: true }, { rememberModel: true }, { rememberEffort: true }]
    .map((a) => run(agent(), 'sessions.setTurnSettings', a)))).every((r) => r.code === 'NEEDS_UI') && calls.filter((c) => c[0] === 'setTurnSettings').length === 2);
  t.ok('人（画面）は全部渡せて、そのまま通る', (await run(human, 'sessions.setTurnSettings', { sessionId: 'me', cwd: 'D:\\x', mode: 'default', account: 'a', rememberMode: true })).ok);

  // ---- 画面（人）と AI の形
  const listHuman = await run(human, 'sessions.list', {});
  t.ok('sessions.list: 画面には全部の欄の行（ページ送りなし）、AI には決まった欄だけ', Array.isArray(listHuman.result) && listHuman.result[0].claudeAccount === undefined
    && Object.keys((await run(agent(), 'sessions.list', {})).result.sessions[0]).join() === 'id,title,backend,status,cwd,parent,delegated,lastModified,createdAt');

  const outHuman = await run(human, 'sessions.listMessages', { sessionId: 'me' });
  const outAgent = await run(agent(), 'sessions.listMessages', { limit: 5 });
  t.ok('sessions.listMessages: 画面には送信待ちの行そのもの、AI には本文を 500 字に切った行と件数・next',
    outHuman.result.length === 40 && outHuman.result[0].args.prompt.length === 2000
    && outAgent.result.total === 40 && outAgent.result.messages.length === 5 && outAgent.result.messages[0].text.length === OUTBOX_CHARS && outAgent.result.messages[0].truncated === true
    && outAgent.result.messages[1].attachments === 1 && typeof outAgent.result.next === 'string');
  const outPage2 = await run(agent(), 'sessions.listMessages', { limit: 5, cursor: outAgent.result.next });
  t.ok('cursor で続きを返し、最後は next が null', outPage2.result.messages[0].id === 'q5' && (await run(agent(), 'sessions.listMessages', { limit: 100 })).result.next === null);
  t.ok('壊れた cursor は INVALID（文は辞書から）', (await run(agent(), 'sessions.listMessages', { cursor: '!!' })).code === 'INVALID');

  const chHuman = await run(human, 'sessions.changes', { sessionId: 'me' });
  const chAgent = await run(agent(), 'sessions.changes', { limit: 2 });
  t.ok('sessions.changes: 画面には記録の順のまま・定型理由のキーも、AI には新しい方から limit 件', chHuman.result.changes.length === 5 && chHuman.result.changes[0].to === 't1' && chHuman.result.changes[0].reasonKey === 'menu'
    && chAgent.result.changes.map((c) => c.to).join() === 't5,t4' && chAgent.result.total === 5 && typeof chAgent.result.next === 'string');
  t.ok('無い会話の記録は AI には SESSION_NOT_FOUND、画面には空', (await run(agent(), 'sessions.changes', { sessionId: 'nope' })).code === 'SESSION_NOT_FOUND' && (await run(human, 'sessions.changes', { sessionId: 'nope' })).result.changes.length === 0);

  const linHuman = await run(human, 'sessions.lineage', { sessionId: 'kid' });
  const linAgent = await run(agent(), 'sessions.lineage', { sessionId: 'kid' });
  t.ok('sessions.lineage: 根と家族（画面は行そのもの、AI は決まった欄）', linHuman.result.rootId === 'root' && linHuman.result.sessions.length === 3 && linAgent.result.rootId === 'root' && linAgent.result.total === 3
    && linAgent.result.sessions[0].id === 'root' && linAgent.result.sessions[0].delegated === false);
  t.ok('無い会話の系譜は SESSION_NOT_FOUND', (await run(agent(), 'sessions.lineage', { sessionId: 'nope' })).code === 'SESSION_NOT_FOUND');

  const stHuman = await run(human, 'statuses.list', {});
  const stAgent = await run(agent(), 'statuses.list', {});
  t.ok('statuses.list: 画面には全件（配列）、AI は既定 30 件ずつ（limit は 100 まで）', Array.isArray(stHuman.result) && stHuman.result.length === 120 && stAgent.result.statuses.length === 30 && stAgent.result.total === 120
    && !registry.get('statuses.list').input.shape.limit.safeParse(PAGE_MAX + 1).success);
  t.ok('statuses.rename は write（AI の呼び出しは actor を渡す）', (await run(agent(), 'statuses.rename', { from: 'a', to: 'b' })).result.moved === 2 && calls.at(-1)[3].by === 'agent');

  // ---- agents.*
  const aList = await run(agent(), 'agents.list', {});
  t.ok('agents.list: AI には id・名前・説明（200 字まで）・できること（真の名前）だけ。画面には従来の配列', aList.result.agents[0].description.length === 200 && aList.result.agents[0].features.join() === 'fork,login'
    && Array.isArray((await run(human, 'agents.list', {})).result) && (await run(human, 'agents.list', {})).result[0].capabilities.compact === false);
  const aModels = await run(agent(), 'agents.models', { limit: 10 });
  t.ok('agents.models: AI には配列（注は 200 字まで・10 件ずつ・cursor）、画面には従来の id → 行の表', aModels.result.models.length === 10 && aModels.result.total === 150 && aModels.result.models[0].note.length === 200 && typeof aModels.result.next === 'string'
    && Object.keys((await run(human, 'agents.models', {})).result).length === 150);
  t.ok('agents.modes・efforts は配列（resolvesTo を残す）、画面には表', (await run(agent(), 'agents.efforts', {})).result.efforts[0].resolvesTo === 'high' && (await run(human, 'agents.modes', {})).result.default.label === 'D'
    && (await run(agent(), 'agents.modes', {})).result.modes[0].id === 'default');
  t.ok('agents.authStatus: AI にはログインの状態だけ（メールアドレス・詳細は返さない）', JSON.stringify((await run(agent(), 'agents.authStatus', {})).result) === '{"backend":"claude","supported":true,"installed":true,"loggedIn":false,"pending":true}'
    && (await run(human, 'agents.authStatus', {})).result.account === 'x@example.invalid');

  // ---- delegation.*
  const ins = await run(agent(), 'delegation.instructions', { taskId: 'ply-task-own', limit: 2 });
  t.ok('delegation.instructions: AI には新しい順・本文を 1000 字に切る・件数と next、画面にはそのまま', ins.result.instructions.length === 2 && ins.result.instructions[0].id === 'i2' && ins.result.total === 3 && typeof ins.result.next === 'string'
    && (await run(agent(), 'delegation.instructions', { taskId: 'ply-task-own' })).result.instructions[2].text.length === INSTRUCTION_CHARS && (await run(human, 'delegation.instructions', { taskId: 'ply-task-own' })).result.instructions[0].text.length === 5000);
  t.ok('無いタスクは TASK_NOT_FOUND', (await run(agent(), 'delegation.instructions', { taskId: 'nope' })).code === 'TASK_NOT_FOUND' && (await run(human, 'delegation.instructions', { taskId: 'nope' })).code === 'TASK_NOT_FOUND');
  const route = await run(agent(), 'delegation.routing', { limit: 20 });
  t.ok('delegation.routing: AI には設定・警告・キーの有無・候補の一部（20 件ずつ）だけ。語彙（defaults・kinds）は画面だけ', route.result.candidates.length === 20 && route.result.total === 60 && route.result.keys.openrouter.hasKey === true
    && route.result.defaults === undefined && (await run(human, 'delegation.routing', {})).result.defaults.big === 1 && (await run(human, 'delegation.routing', { refresh: true })).result.refresh === true);
  t.ok('delegation.usage（providerUsage）: 画面には使用枠と実績。AI は従来の ply_usage', (await run(human, 'delegation.usage', { backend: 'codex' })).result.label === 'Codex'
    && (await run(agent(), 'delegation.usage', {})).result.stopped === true);

  // ---- delegation.retry: 自分の子だけ・人だけの項目・強い承認モードは NEEDS_UI
  calls.length = 0;
  const retried = await run(agent(), 'delegation.retry', { taskId: 'ply-task-own', candidate: 'codex:other', stop: true });
  t.ok('自分の子はやり直せる（AI には決まった欄のタスク）', retried.ok && retried.result.task.taskId === 'ply-task-new' && calls[0][1].stop === true);
  t.ok('他の会話の子は TASK_NOT_FOUND（やり直さない）', (await run(agent(), 'delegation.retry', { taskId: 'ply-task-other', candidate: 'codex:other' })).code === 'TASK_NOT_FOUND' && calls.length === 1);
  t.ok('アカウント・確認済み（approved）を AI が渡すと NEEDS_UI', (await run(agent(), 'delegation.retry', { taskId: 'ply-task-own', candidate: 'x:y', approved: true })).code === 'NEEDS_UI'
    && (await run(agent(), 'delegation.retry', { taskId: 'ply-task-own', candidate: 'x:y', account: 'a' })).code === 'NEEDS_UI' && calls.length === 1);
  t.ok('依頼元より強い承認モードになる（確認が要る）やり直しは、AI には NEEDS_UI。人（画面）には { confirm } がそのまま返る',
    (await run(agent(), 'delegation.retry', { taskId: 'ply-task-own', candidate: 'strong:model' })).code === 'NEEDS_UI'
    && (await run(human, 'delegation.retry', { taskId: 'ply-task-other', candidate: 'strong:model' })).result.confirm.mode === 'bypass');
  t.ok('束縛されない CLI は NEEDS_UI。読み取りの会話は断る（write）', (await run({ by: 'agent', via: 'cli' }, 'delegation.retry', { taskId: 'ply-task-own', candidate: 'a:b' })).code === 'NEEDS_UI'
    && (await run(agent(), 'delegation.retry', { taskId: 'ply-task-own', candidate: 'a:b' }, deps({ scope: 'readonly', autonomy: 'ask' }))).code === 'READ_ONLY_MODE');
  t.ok('人（画面）はどの子の止める・やり直すも通る（uiHandler）。AI の止めるは従来どおり自分の子だけ（ply_task_cancel）', (await run(human, 'delegation.taskCancel', { taskId: 'ply-task-other' })).ok
    && calls.some((c) => c[0] === 'cancel' && c[1] === 'ply-task-other') && (await run(agent(), 'delegation.taskCancel', { taskId: 'ply-task-own' })).result.stopped === true);

  // ---- 部品
  const ctx = { locale: 'ja' };
  const page = pageOf(ctx, Array.from({ length: 7 }, (_, i) => i), { limit: 3 });
  t.ok('pageOf: 件数・続き・最後の next は null', page.items.join() === '0,1,2' && page.total === 7 && pageOf(ctx, [0, 1, 2, 3, 4, 5, 6], { limit: 3, cursor: page.next }).items.join() === '3,4,5'
    && pageOf(ctx, [0, 1, 2, 3, 4, 5, 6], { limit: 3, cursor: pageOf(ctx, [0, 1, 2, 3, 4, 5, 6], { limit: 3, cursor: page.next }).next }).next === null);

  // ---- list_ops: prefix で絞れる
  const { callMcpTool } = await import('../../core/ops/surfaces/mcp.mjs');
  const catalog = registry.describe({ by: 'agent', via: 'mcp' }, 'ja');
  const listed = JSON.parse((await callMcpTool({ catalog, texts: {}, name: 'list_ops', args: { prefix: 'agents.' }, invoke: async () => ({ ok: true, result: {} }) })).text);
  t.ok('list_ops は prefix で絞れる（agents. は agents.* だけ）。全部を返す呼びは操作が増えても同じ形', listed.ops.length === 5 && listed.ops.every((o) => o.id.startsWith('agents.'))
    && JSON.parse((await callMcpTool({ catalog, texts: {}, name: 'list_ops', args: {}, invoke: async () => ({ ok: true, result: {} }) })).text).ops.length === catalog.length);
}
