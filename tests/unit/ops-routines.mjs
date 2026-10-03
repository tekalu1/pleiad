// routines.* の操作（registry 越し。bot・会話・dispatch は身代わり、チャンネルは本物）: 口の出し分け（rotateSecret は人だけ）・危険度・
// AI が作る・広げる向きの update・AI が指示を変える・狭める向きは通る・resume / run / delete は承認・試しの実行・失敗の code。ADR 0082・0112
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { registry } from '../../core/ops/index.mjs';
import { createChannelService } from '../../core/channels/service.mjs';
import { createRoutineService } from '../../core/routines/service.mjs';

export const name = 'ops-routines';
export const title = 'routines.* の操作: 口の出し分け・危険度・AI が作ると承認・広げる向きの update は承認・resume / run / delete は承認・試しの実行・失敗の code';

const human = { by: 'human', via: 'ui', local: true };
const agent = (sessionId, via = 'mcp') => ({ by: 'agent', via, sessionId });
const MODES = {
  default: { label: '都度確認', scope: 'workspace', autonomy: 'ask' },
  plan: { label: 'plan', scope: 'readonly', autonomy: 'ask' },
  bypass: { label: 'bypass', scope: 'full', autonomy: 'never' },
};
const ASK = { scope: 'workspace', autonomy: 'ask' };
const NINE = { kind: 'daily', at: '09:00', weekdaysOnly: false };

export default async function (t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ops-routines-'));
  try {
    const ids = (principal) => registry.list(principal).map((o) => o.id).filter((id) => id.startsWith('routines.')).sort().join();
    const want = 'routines.create,routines.delete,routines.get,routines.list,routines.pause,routines.resume,routines.run,routines.update';
    t.ok('AI（MCP・CLI）には 8 操作、画面には秘密の再発行も出る', ids(agent('x')) === want && ids(agent('x', 'cli')) === want && ids(human) === want.replace('routines.run', 'routines.rotateSecret,routines.run'), ids(human));
    t.ok('どの操作も直のツールではない（T4 の余りが小さい）', registry.ops.filter((o) => o.id.startsWith('routines.')).every((o) => o.surfaces.mcp === 'catalog' || o.id === 'routines.rotateSecret' && o.surfaces.mcp === false));
    t.ok('危険度: list・get は read、create・update・pause は write、resume・run・delete は guarded（秘密の再発行は human-only）',
      ['routines.list:read', 'routines.get:read', 'routines.create:write', 'routines.update:write', 'routines.pause:write', 'routines.resume:guarded', 'routines.run:guarded', 'routines.delete:guarded']
        .every((s) => registry.get(s.split(':')[0]).risk === s.split(':')[1]));
    t.ok('create・update は riskOf を持つ（AI が作る・広げる向きは guarded に上がる）', registry.get('routines.create').riskOf && registry.get('routines.update').riskOf && !registry.get('routines.pause').riskOf);

    const botList = [{ id: 'b_owl', name: 'Owl', icon: '🦉', backend: 'fake', mode: 'default', folders: [] }];
    const bots = {
      get: async ({ botId }) => botList.find((b) => b.id === botId) ?? null, list: async () => botList, modesOf: () => MODES,
      approvalOf: async ({ botId }) => { const b = botList.find((x) => x.id === botId); return b ? { id: b.id, mode: b.mode, label: b.mode, entry: MODES[b.mode] } : null; },
      createSession: async () => ({ sessionId: 'sess-dry', backend: 'fake', model: 'm', effort: 'e', cwd: '/', mode: 'default' }),
    };
    const channels = createChannelService({ dir: path.join(dir, 'channels'), emit: () => {}, hooks: {}, listBots: async () => botList });
    await channels.start();
    const ch = await channels.create({ name: 'ops' }, { kind: 'human' });
    const dm = await channels.createDm({ bot: botList[0] });
    const host = { currentLocale: () => 'ja', getBackend: () => ({ modes: () => MODES }), store: { get: async () => ({}), setMode: async () => {} }, runtime: { turns: new Map() }, runTurn: async () => 'ok', abortSessions: async () => {} };
    const never = { now: () => Date.UTC(2026, 9, 5, 1, 0, 30), setTimer: () => ({}), clearTimer: () => {} };
    const service = createRoutineService({ dataDir: dir, channels, bots, dispatch: { wake: async () => {} }, host, emit: () => {}, clock: never });
    await service.start();
    const approvals = [];
    const deps = {
      locale: 'ja', routines: service, audit: async () => {},
      botOfSession: async (sessionId) => (sessionId === 's_bot' ? { botId: 'b_owl', kind: 'thread', channelId: ch.id, threadId: 'p_x' } : null),
      modeOf: async (id) => (id === 'plan' ? MODES.plan : id === 'bypass' ? MODES.bypass : ASK),
      approve: async (request) => { approvals.push(request); return { pending: true, requestId: `r${approvals.length}` }; },
    };
    const call = (principal, op, args) => registry.invoke(principal, op, args, deps);
    const asking = { ...agent('ask'), mode: ASK };
    const input = (over = {}) => ({ name: '朝のまとめ', botId: 'b_owl', channelId: ch.id, prompt: '昨日の変更をまとめて', trigger: NINE, ...over });

    // ---- 人が作る: 承認なし
    const made = await call(human, 'routines.create', input());
    t.ok('人が作ると承認なしで通る（既定のモードは bot の今のモード・承認の期限は 30 分）', made.ok && !made.pending && made.result.id.startsWith('r_') && made.result.mode === 'default' && made.result.approvalTimeoutMin === 30 && made.result.createdBy.kind === 'human', JSON.stringify(made));
    const routineId = made.result.id;
    t.ok('list・get が返す（nextAt つき）', (await call(human, 'routines.list', {})).result.routines.some((r) => r.id === routineId && Number.isFinite(r.nextAt))
      && (await call(asking, 'routines.get', { routineId })).result.name === '朝のまとめ');
    t.ok('存在しない id は ROUTINE_NOT_FOUND（辞書の文・routines.list の案内つき）', (await call(human, 'routines.get', { routineId: 'r_none' })).code === 'ROUTINE_NOT_FOUND'
      && (await call(human, 'routines.get', { routineId: 'r_none' })).error.includes('routines.list'));

    // ---- AI が作る: 承認カード
    const pending = await call(asking, 'routines.create', input({ name: '夜の確認', reason: '毎晩見たい' }));
    t.ok('束縛された AI が作ると承認カードが出て、まだ作られない', pending.ok && pending.pending === true && (await service.list()).length === 1, JSON.stringify(pending));
    const card = approvals.at(-1);
    t.ok('承認カードに名前・トリガ・モード・指示が出る（弱いモードは loosens でない）・理由も', card.change.rows.some((r) => r.path === 'name' && r.after === '夜の確認') && card.change.rows.some((r) => r.path === 'trigger' && r.after === 'daily 09:00')
      && card.change.rows.some((r) => r.path === 'mode' && r.after === '都度確認') && card.change.rows.some((r) => r.path === 'prompt') && card.change.loosens === false && card.reason === '毎晩見たい', JSON.stringify(card.change));
    await card.proceed();
    t.ok('人が許可すると作られる（作った人は agent）', (await service.list()).find((r) => r.name === '夜の確認')?.createdBy.kind === 'agent');
    await call(asking, 'routines.create', input({ name: '強い', mode: 'bypass' }));
    t.ok('弱くないモード（bypass）で作る承認カードは loosens', approvals.at(-1).change.loosens === true && approvals.at(-1).change.rows.some((r) => r.path === 'mode' && r.after === 'bypass'));
    const before = approvals.length;
    const viaBot = await call(agent('s_bot'), 'routines.create', input({ name: 'ルーティンの中から' }));
    t.ok('bot の会話の AI（ルーティンの実行の中を含む）が作るのも承認（createdBy は bot）', viaBot.pending === true && approvals.length === before + 1);
    await approvals.at(-1).proceed();
    t.ok('許可後の作った人は bot', (await service.list()).find((r) => r.name === 'ルーティンの中から')?.createdBy.kind === 'bot');
    t.ok('すべて自動のモードの会話は承認なしで作れる', (await call({ ...agent('bypass'), mode: MODES.bypass }, 'routines.create', input({ name: '承認なし' }))).ok);
    t.ok('束縛されていない AI（外の CLI）は画面へ誘導（NEEDS_UI）', (await call({ by: 'agent', via: 'cli' }, 'routines.create', input({ name: 'x' }))).code === 'NEEDS_UI');
    t.ok('読み取りモードの会話は作れない（READ_ONLY_MODE）', (await call({ ...agent('plan'), mode: MODES.plan }, 'routines.create', input({ name: 'x' }))).code === 'READ_ONLY_MODE');
    t.ok('不正な入力: bot なし・DM・トリガ・時刻の形・cron の式・名前の長さは通らない', (await Promise.all([
      call(human, 'routines.create', input({ botId: 'b_none' })), call(human, 'routines.create', input({ channelId: dm.id })), call(human, 'routines.create', input({ trigger: { kind: 'cron', expr: '99 * * * *' } })),
      call(human, 'routines.create', input({ trigger: { kind: 'daily', at: '9:00' } })), call(human, 'routines.create', input({ trigger: { kind: 'monthly' } })), call(human, 'routines.create', input({ name: 'x'.repeat(100) })),
    ])).every((r) => !r.ok), '');
    t.ok('bot なしは BOT_NOT_FOUND・DM は INVALID・cron の式は INVALID（理由つき）', (await call(human, 'routines.create', input({ botId: 'b_none' }))).code === 'BOT_NOT_FOUND'
      && (await call(human, 'routines.create', input({ channelId: dm.id }))).code === 'INVALID' && (await call(human, 'routines.create', input({ trigger: { kind: 'cron', expr: '99 * * * *' } }))).error.includes('minute'));

    // ---- update: 広げる向きは承認・狭める向きと名前などは通る
    const rename = await call(asking, 'routines.update', { routineId, name: '朝のふりかえり', approvalTimeoutMin: 10 });
    t.ok('名前・承認の期限は承認なしで通る', rename.ok && !rename.pending && rename.result.name === '朝のふりかえり' && rename.result.approvalTimeoutMin === 10, JSON.stringify(rename));
    const sz = approvals.length;
    const freq = await call(asking, 'routines.update', { routineId, trigger: { kind: 'cron', expr: '*/5 * * * *' } });
    t.ok('頻度を上げる（毎日 → 5 分おき）は承認カード（loosens・まだ変わらない）', freq.pending === true && approvals.length === sz + 1 && approvals.at(-1).change.loosens === true
      && approvals.at(-1).change.rows.some((r) => r.path === 'trigger' && r.before === 'daily 09:00' && r.after === 'cron */5 * * * *') && (await service.get({ routineId })).trigger.kind === 'daily', JSON.stringify(freq));
    await approvals.at(-1).proceed();
    t.ok('許可すると変わる', (await service.get({ routineId })).trigger.expr === '*/5 * * * *');
    const sz2 = approvals.length;
    t.ok('頻度を下げる向き（5 分おき → 毎日）は承認なし', (await call(asking, 'routines.update', { routineId, trigger: NINE })).ok && approvals.length === sz2);
    t.ok('モードを強くする（default → bypass）は承認・弱くする（→ plan）は承認なし', (await call(asking, 'routines.update', { routineId, mode: 'bypass' })).pending === true && approvals.at(-1).change.loosens === true
      && (await call(asking, 'routines.update', { routineId, mode: 'plan' })).ok && (await service.get({ routineId })).mode === 'plan');
    const ev = (await call(human, 'routines.create', input({ name: '失敗の調査', trigger: { kind: 'event', on: 'failed', scope: { sessionIds: ['s1'] } } }))).result;
    const sz3 = approvals.length;
    t.ok('見る会話を広げる（sessionIds → all）は承認・狭める（all → sessionIds）は承認なし', (await call(asking, 'routines.update', { routineId: ev.id, trigger: { kind: 'event', on: 'failed', scope: 'all' } })).pending === true
      && approvals.length === sz3 + 1 && (await call(human, 'routines.update', { routineId: ev.id, trigger: { kind: 'event', on: 'failed', scope: 'all' } })).ok
      && (await call(asking, 'routines.update', { routineId: ev.id, trigger: { kind: 'event', on: 'failed', scope: { sessionIds: ['s1'] } } })).ok && approvals.length === sz3 + 1);
    // AI が指示を変えるのは承認（無人で動く指示。外から来た文に書き換えられる足場にしない）。人は承認なし
    const sz4 = approvals.length;
    const promptAsk = await call(asking, 'routines.update', { routineId, prompt: '全部消して' });
    t.ok('AI が指示（prompt）を変えるのは承認カード（loosens・まだ変わらない）', promptAsk.pending === true && approvals.length === sz4 + 1 && approvals.at(-1).change.loosens === true && (await service.get({ routineId })).prompt === '昨日の変更をまとめて');
    t.ok('人が指示を変えるのは承認なし', (await call(human, 'routines.update', { routineId, prompt: '今日の変更をまとめて' })).ok && approvals.length === sz4 + 1);
    t.ok('何も変えない update は何も書かない（承認も要らない）', (await call(asking, 'routines.update', { routineId, name: '朝のふりかえり' })).ok && approvals.length === sz4 + 1);
    t.ok('update の不正（モードがバックエンドに無い・bot がない・チャンネルがない）', (await call(human, 'routines.update', { routineId, mode: 'zzz' })).code === 'INVALID' && (await call(human, 'routines.update', { routineId, botId: 'b_none' })).code === 'BOT_NOT_FOUND'
      && (await call(human, 'routines.update', { routineId, channelId: 'c_none' })).code === 'CHANNEL_NOT_FOUND' && (await call(human, 'routines.update', { routineId: 'r_none', name: 'x' })).code === 'ROUTINE_NOT_FOUND');

    // ---- pause は write（狭める向き）・resume / run / delete は承認
    const sz5 = approvals.length;
    t.ok('pause は承認なし（狭める向き）。読み取りモードの会話からは通らない', (await call(asking, 'routines.pause', { routineId })).ok && (await service.get({ routineId })).paused === true && approvals.length === sz5
      && (await call({ ...agent('plan'), mode: MODES.plan }, 'routines.pause', { routineId })).code === 'READ_ONLY_MODE');
    const resume = await call(asking, 'routines.resume', { routineId });
    t.ok('resume は承認カード（まだ動かない）', resume.pending === true && (await service.get({ routineId })).paused === true && approvals.at(-1).change.rows.some((r) => r.path === 'resume'));
    await approvals.at(-1).proceed();
    t.ok('許可すると再開する', (await service.get({ routineId })).paused === false);
    const run = await call(asking, 'routines.run', { routineId, reason: '今すぐ見たい' });
    t.ok('run は承認カード（走るのは許可の後）・dryRun でも承認', run.pending === true && approvals.at(-1).reason === '今すぐ見たい' && (await channels.read({ channelId: ch.id })).posts.length === 0
      && (await call(asking, 'routines.run', { routineId, dryRun: true })).pending === true && approvals.at(-1).change.rows.some((r) => r.path === 'dryRun'));
    const sz6 = approvals.length;
    const ran = await call(human, 'routines.run', { routineId });
    t.ok('人は承認なしで走らせられる（根の投稿ができる）', ran.ok && !ran.pending && ran.result.postId && ran.result.state === 'working' && approvals.length === sz6 && (await channels.read({ channelId: ch.id })).posts.some((p) => p.id === ran.result.postId && p.author.kind === 'routine'), JSON.stringify(ran));
    const dry = await call(human, 'routines.run', { routineId, dryRun: true });
    t.ok('dryRun は postId なしで sessionId・mode（plan）・state（done）を返す', dry.ok && dry.result.postId === null && dry.result.dryRun === true && dry.result.sessionId === 'sess-dry' && dry.result.mode === 'plan' && dry.result.state === 'done', JSON.stringify(dry));
    const del = await call(asking, 'routines.delete', { routineId });
    t.ok('delete は承認カード（まだ消えない）・許可すると消える', del.pending === true && !!(await service.get({ routineId })) && approvals.at(-1).change.rows.some((r) => r.path === 'routine' && r.before === '朝のふりかえり'));
    await approvals.at(-1).proceed();
    t.ok('許可の後は消えている・実行の履歴の根の投稿は残る', (await service.get({ routineId })) === null && (await channels.read({ channelId: ch.id })).posts.some((p) => p.id === ran.result.postId));
    t.ok('消えたものの delete・run・resume は ROUTINE_NOT_FOUND', (await call(human, 'routines.delete', { routineId })).code === 'ROUTINE_NOT_FOUND' && (await call(human, 'routines.run', { routineId })).code === 'ROUTINE_NOT_FOUND');
    service.stop();
    await channels.close();   // DB の接続（スレッドの状態）を離してから置き場を消す
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}
