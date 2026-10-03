// channels.* の操作（core/ops/channels.mjs）: 主体から発言者を決める・自分の投稿だけ直せる・危険度と口（ui / mcp / cli）・modeGate・辞書の文の失敗。
// サーバーを立てずに、本物のチャンネルのサービス（一時ディレクトリ）と偽の botOfSession で registry.invoke を通す。
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { registry } from '../../core/ops/index.mjs';
import { createChannelService } from '../../core/channels/service.mjs';
import { startServer, ROOT } from '../lib/server.mjs';
import { open } from '../lib/ws-client.mjs';

export const name = 'ops-channels';
export const title = '操作の一覧（チャンネル）: 発言者を主体から決める・自分の投稿だけ・modeGate・口と危険度・失敗の文。サーバー越しの出来事と CLI';
const BIN = path.join(ROOT, 'bin', 'pleiad.mjs');

const HUMAN = { by: 'human', via: 'ui', local: true };
const agent = (sessionId, via = 'mcp') => ({ by: 'agent', via, ...(sessionId ? { sessionId } : {}) });
const IDS = ['list', 'get', 'read', 'search', 'create', 'update', 'archive', 'post', 'edit', 'delete', 'react', 'markRead', 'stopThread', 'wake'].map((v) => `channels.${v}`);

export default async function (t) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ops-channels-'));
  try {
    // ---- 定義
    t.ok('操作は 15 個（集団宛ての wakePreview を含む）', IDS.every((id) => registry.get(id)) && registry.ops.filter((o) => o.id.startsWith('channels.')).length === 15);
    const risk = (id) => registry.get(id).risk;
    t.ok('危険度: 読む 5 つは read・書く 9 つは write・wake は guarded（human-only はない。ADR 0082 の 5 つ以外は AI も使える）', ['list', 'get', 'read', 'search', 'wakePreview'].every((v) => risk(`channels.${v}`) === 'read')
      && ['create', 'update', 'archive', 'post', 'edit', 'delete', 'react', 'markRead', 'stopThread'].every((v) => risk(`channels.${v}`) === 'write') && risk('channels.wake') === 'guarded');
    t.ok('modeGate: false は post・react・stopThread だけ（読み取り・計画の bot も返事・リアクション・停止はできる）', IDS.filter((id) => registry.get(id).modeGate === false).join() === 'channels.post,channels.react,channels.stopThread');
    t.ok('口: どれも画面から。MCP は catalog（直のツールは足さない）。CLI は全部（markRead も AI・CLI に出す）', IDS.every((id) => registry.get(id).surfaces.ui === true && registry.get(id).surfaces.mcp === 'catalog' && registry.get(id).surfaces.cli));
    t.ok('write の理由（riskReason）を持つ', IDS.filter((id) => risk(id) === 'write').every((id) => registry.get(id).riskReason.length > 20));
    t.ok('CLI のコマンド: channels list / get / read / search / create / update / archive / post / edit / delete / react / mark-read 相当（位置引数は post が channelId と text）', registry.get('channels.post').surfaces.cli.positional.join() === 'channelId,text'
      && registry.get('channels.get').surfaces.cli.path.join(' ') === 'channels get');
    const aiSees = registry.describe({ by: 'agent', via: 'cli' }, 'ja').map((o) => o.id);
    t.ok('AI（CLI）の一覧にチャンネルの操作が全部出る。直のツールは 0', IDS.every((id) => aiSees.includes(id)) && registry.describe({ by: 'agent', via: 'mcp' }, 'ja').filter((o) => o.id.startsWith('channels.')).every((o) => o.tool === null));
    t.ok('集団宛てのプレビューは読み取り操作で画面から使える', registry.get('channels.wakePreview').risk === 'read' && registry.get('channels.wakePreview').surfaces.ui);

    // ---- 実行
    let clock = 5000;
    const channels = createChannelService({ dir: path.join(tmp, 'channels'), now: () => (clock += 10), listBots: async () => [{ id: 'b_owl', name: 'Owl' }, { id: 'b_lynx', name: 'Lynx' }] });
    await channels.start();
    const bound = { s_bot: { botId: 'b_owl', kind: 'thread' } };
    const modes = { s_ro: { scope: 'readonly', autonomy: 'ask' }, s_plan: { scope: 'readonly', autonomy: 'ask' } };
    const deps = { locale: 'ja', channels, botOfSession: async (id) => bound[id] ?? null, modeOf: async (id) => modes[id] ?? { scope: 'workspace', autonomy: 'ask' }, audit: () => {} };
    const run = (p, id, args) => registry.invoke(p, id, args, deps);

    const made = await run(HUMAN, 'channels.create', { name: '#ops', purpose: 'テスト' });
    t.ok('create: 画面（人）から作れる', made.ok && made.result.name === 'ops', JSON.stringify(made));
    const cid = made.result.id;
    const groupChannel = await run(HUMAN, 'channels.create', { name: 'group', members: ['b_owl', 'b_lynx'] });
    const gid = groupChannel.result.id;
    const root = await run(HUMAN, 'channels.post', { channelId: gid, text: '集団宛てのスレッド' });
    const emptyHere = await run(HUMAN, 'channels.wakePreview', { channelId: gid, threadId: root.result.id, text: '@here まだ誰もいない' });
    t.ok('まだ bot が話していないスレッドの @here は 0 体', emptyHere.ok && emptyHere.result.required && emptyHere.result.botIds.length === 0);
    await run(agent('s_bot'), 'channels.post', { channelId: gid, threadId: root.result.id, text: 'Owl の返事' });
    const hereArgs = { channelId: gid, threadId: root.result.id, text: '@here 続けて' };
    const here = await run(HUMAN, 'channels.wakePreview', hereArgs);
    t.ok('@here はそのスレッドで話した bot だけを数える', here.ok && here.result.required && here.result.botIds.join() === 'b_owl', JSON.stringify(here));
    t.ok('確認なし・宛先が違う投稿は保存しない', (await run(HUMAN, 'channels.post', hereArgs)).code === 'INVALID'
      && (await run(HUMAN, 'channels.post', { ...hereArgs, confirmedWake: ['b_lynx'] })).code === 'INVALID');
    const confirmedHere = await run(HUMAN, 'channels.post', { ...hereArgs, confirmedWake: here.result.botIds });
    t.ok('確認した @here はその botId を投稿へ保存する', confirmedHere.ok && confirmedHere.result.mentions.join() === 'here,b_owl');
    const everyoneArgs = { channelId: gid, text: '@everyone 集まって' };
    const everyone = await run(HUMAN, 'channels.wakePreview', everyoneArgs);
    const confirmedEveryone = await run(HUMAN, 'channels.post', { ...everyoneArgs, confirmedWake: everyone.result.botIds });
    t.ok('@everyone はチャンネルの bot 全員。確認してから投稿する', everyone.result.botIds.join() === 'b_owl,b_lynx' && confirmedEveryone.result.mentions.join() === 'everyone,b_owl,b_lynx');
    const botGroup = await run(agent('s_bot'), 'channels.post', { channelId: gid, threadId: root.result.id, text: '@everyone 起きて' });
    t.ok('bot が書いた集団宛ては誰も起こさない', botGroup.ok && botGroup.result.mentions.length === 0);
    const aiMade = await run(agent('s_chat'), 'channels.create', { name: 'ai-made' });
    t.ok('create: 会話の AI も作れる（write。人と同じ）', aiMade.ok);
    t.ok('list・get: 画面と AI のどちらにも返る', (await run(HUMAN, 'channels.list', {})).result.channels.length === 3 && (await run(agent('s_chat', 'cli'), 'channels.get', { channelId: cid })).result.name === 'ops');

    // 発言者
    const byHuman = await run(HUMAN, 'channels.post', { channelId: cid, text: '人の投稿 @Owl' });
    t.ok('post: 画面の人は human', byHuman.ok && byHuman.result.author.kind === 'human' && byHuman.result.mentions.join() === 'b_owl', JSON.stringify(byHuman.result));
    const byBot = await run(agent('s_bot'), 'channels.post', { channelId: cid, text: 'bot の返事', threadId: byHuman.result.id });
    t.ok('post: bot の会話に束縛された AI は bot として書く', byBot.ok && byBot.result.author.kind === 'bot' && byBot.result.author.botId === 'b_owl' && byBot.result.threadId === byHuman.result.id, JSON.stringify(byBot));
    const byAgent = await run(agent('s_chat'), 'channels.post', { channelId: cid, text: 'AI の投稿' });
    t.ok('post: bot でない会話の AI は agent（会話の id つき）', byAgent.ok && byAgent.result.author.kind === 'agent' && byAgent.result.author.sessionId === 's_chat');
    const unbound = await run({ by: 'agent', via: 'cli' }, 'channels.post', { channelId: cid, text: '束縛なしの CLI' });
    t.ok('post: 会話に束縛されない CLI は人として書かせず NEEDS_UI（画面へ誘導する文）', !unbound.ok && unbound.code === 'NEEDS_UI' && /画面/.test(unbound.error), unbound.error);
    t.ok('post: 束縛されない CLI の react・stopThread・edit・delete・create・markRead も、発言者が要るものは NEEDS_UI', (await run({ by: 'agent', via: 'cli' }, 'channels.react', { channelId: cid, postId: byHuman.result.id, emoji: '👍' })).code === 'NEEDS_UI'
      && (await run({ by: 'agent', via: 'cli' }, 'channels.stopThread', { channelId: cid, threadId: byHuman.result.id })).code === 'NEEDS_UI');
    t.ok('read・search・markRead は発言者が要らないので束縛なしの CLI でも通る', (await run({ by: 'agent', via: 'cli' }, 'channels.read', { channelId: cid })).ok && (await run({ by: 'agent', via: 'cli' }, 'channels.search', { query: 'AI' })).ok
      && (await run({ by: 'agent', via: 'cli' }, 'channels.markRead', { channelId: cid, at: 1 })).ok);
    const sneaky = await run(agent('s_chat'), 'channels.post', { channelId: cid, text: 'x', state: 'checking' });
    t.ok('post: state: checking は bot だけが付けられる（AI の agent の投稿には付かない）', sneaky.ok && sneaky.result.state === undefined
      && (await run(agent('s_bot'), 'channels.post', { channelId: cid, text: '要確認', state: 'checking', new: true })).result.state === 'checking');

    // 添付（ADR 0116）: 実物の確かめは server.mjs の describeAttachments（ここでは偽）。読めないものがあれば全体を INVALID で断る
    const described = [];
    const attDeps = { ...deps, describeAttachments: async (list) => {
      described.push(list.map((a) => a.path));
      const ok = list.filter((a) => !/missing/.test(a.path));
      return { files: ok.map((a) => ({ path: a.path, name: a.name ?? 'f', kind: 'file', mime: a.mime ?? '', size: 3, origin: 'host' })), rejected: list.filter((a) => /missing/.test(a.path)).map((a) => a.path) };
    } };
    const runAtt = (p, args) => registry.invoke(p, 'channels.post', { channelId: cid, ...args }, attDeps);
    const withAttach = await runAtt(HUMAN, { text: '見て\n[添付] /tmp/a.txt', attachments: [{ path: '/tmp/a.txt', name: 'a.txt' }] });
    t.ok('post: attachments は実物を確かめた形で保存される（本文の印と対）', withAttach.ok && withAttach.result.attachments?.[0]?.path === '/tmp/a.txt' && withAttach.result.attachments[0].origin === 'host'
      && (await channels.getPost({ channelId: cid, postId: withAttach.result.id })).attachments.length === 1, JSON.stringify(withAttach));
    const missing = await runAtt(HUMAN, { text: '読めない添付', attachments: [{ path: '/tmp/a.txt' }, { path: '/tmp/missing.txt' }] });
    t.ok('post: 読めない添付が 1 つでもあれば INVALID（投稿は残らない）', !missing.ok && missing.code === 'INVALID' && /missing\.txt/.test(missing.error)
      && !(await channels.read({ channelId: cid })).posts.some((p) => p.text === '読めない添付'), JSON.stringify(missing));
    const noCheck = await run(HUMAN, 'channels.post', { channelId: cid, text: 'y', attachments: [{ path: '/tmp/a.txt' }] });
    t.ok('post: 確かめる口の無い所（deps に describeAttachments が無い）では添付を断る', !noCheck.ok && noCheck.code === 'INVALID');
    const agentAtt = await runAtt(agent('s_chat'), { text: '資料', attachments: [{ path: '/tmp/a.txt' }] });
    t.ok('post: 会話の AI も添付を付けられる（同じ確かめを通る）', agentAtt.ok && agentAtt.result.attachments.length === 1 && described.length === 3);
    t.ok('post: 添付の件数の上限（50）を超えると断る', !(await runAtt(HUMAN, { text: 'z', attachments: Array.from({ length: 51 }, (_, i) => ({ path: `/tmp/${i}` })) })).ok);

    // modeGate
    const ro = agent('s_ro');
    t.ok('読み取り専用の会話の AI も、post・react は通る（modeGate: false）', (await run(ro, 'channels.post', { channelId: cid, text: '読み取り専用でも返事はする' })).ok && (await run(ro, 'channels.react', { channelId: cid, postId: byHuman.result.id, emoji: '👀' })).ok);
    t.ok('読み取り専用の会話の AI は、stopThread も通る', (await run(ro, 'channels.stopThread', { channelId: cid, threadId: byHuman.result.id })).ok);
    const roDenied = await Promise.all([run(ro, 'channels.create', { name: 'zz' }), run(ro, 'channels.update', { channelId: cid, name: 'zz' }), run(ro, 'channels.archive', { channelId: cid, on: true })]);
    t.ok('読み取り専用の会話の AI は、チャンネルの定義を変えられない（READ_ONLY_MODE）。読むのは通る', roDenied.every((r) => !r.ok && r.code === 'READ_ONLY_MODE') && (await run(ro, 'channels.list', {})).ok);
    t.ok('読み取り専用の会話の AI は、投稿を直す・消すこともできない', (await run(ro, 'channels.edit', { channelId: cid, postId: byAgent.result.id, text: 'x' })).code === 'READ_ONLY_MODE');

    // 自分の投稿だけ
    const edit = await run(HUMAN, 'channels.edit', { channelId: cid, postId: byHuman.result.id, text: '直した' });
    t.ok('edit: 人は自分の投稿を直せる', edit.ok && edit.result.text === '直した' && edit.result.editedAt > 0);
    const notMine = await run(HUMAN, 'channels.edit', { channelId: cid, postId: byBot.result.id, text: '他人の投稿' });
    t.ok('edit: 人は bot の投稿を直せない（NOT_YOUR_POST）', !notMine.ok && notMine.code === 'NOT_YOUR_POST' && /自分の投稿/.test(notMine.error), notMine.error);
    t.ok('edit: bot は自分の投稿は直せて、人の投稿・別の会話の AI の投稿は直せない', (await run(agent('s_bot'), 'channels.edit', { channelId: cid, postId: byBot.result.id, text: '直し' })).ok
      && (await run(agent('s_bot'), 'channels.edit', { channelId: cid, postId: byHuman.result.id, text: 'x' })).code === 'NOT_YOUR_POST' && (await run(agent('s_bot'), 'channels.edit', { channelId: cid, postId: byAgent.result.id, text: 'x' })).code === 'NOT_YOUR_POST');
    t.ok('edit: agent は自分の会話の投稿だけ（別の会話の AI は不可）', (await run(agent('s_chat'), 'channels.edit', { channelId: cid, postId: byAgent.result.id, text: 'AI の直し' })).ok && (await run(agent('s_other'), 'channels.edit', { channelId: cid, postId: byAgent.result.id, text: 'x' })).code === 'NOT_YOUR_POST');
    t.ok('delete: 自分の投稿は消せる（本文は空で形が残る）・他人のは NOT_YOUR_POST・消した投稿は POST_NOT_FOUND', (await run(HUMAN, 'channels.delete', { channelId: cid, postId: byHuman.result.id })).result.deleted === true
      && (await run(HUMAN, 'channels.delete', { channelId: cid, postId: byBot.result.id })).code === 'NOT_YOUR_POST' && (await run(HUMAN, 'channels.delete', { channelId: cid, postId: byHuman.result.id })).code === 'POST_NOT_FOUND');

    // react・既読・止める
    const target = byBot.result.id;
    const on = await run(HUMAN, 'channels.react', { channelId: cid, postId: target, emoji: '👍' });
    t.ok('react: on の既定は true（付ける）。人も bot も同じ操作', on.ok && on.result.reactions['👍'].length === 1 && (await run(agent('s_bot'), 'channels.react', { channelId: cid, postId: target, emoji: '👍', on: true })).result.reactions['👍'].length === 2);
    t.ok('react: on: false で外す。絵文字でないものは INVALID', (await run(HUMAN, 'channels.react', { channelId: cid, postId: target, emoji: '👍', on: false })).result.reactions['👍'].length === 1
      && (await run(HUMAN, 'channels.react', { channelId: cid, postId: target, emoji: 'いいね' })).code === 'INVALID' && (await run(HUMAN, 'channels.react', { channelId: cid, postId: target, emoji: '👍👍' })).code === 'INVALID');
    const mr = await run(HUMAN, 'channels.markRead', { channelId: cid, at: 123456 });
    t.ok('markRead: 画面から。進める向きだけ・at を省けば今', mr.ok && mr.result.readAt === 123456 && (await run(HUMAN, 'channels.markRead', { channelId: cid, at: 5 })).result.readAt === 123456 && (await run(HUMAN, 'channels.markRead', { channelId: cid })).result.readAt > 123456);
    const stop = await run(HUMAN, 'channels.stopThread', { channelId: cid, threadId: byHuman.result.id });
    t.ok('stopThread: 止めた主体（human）が stopped.by に残る', stop.ok && stop.result.stopped.by.kind === 'human');
    const stopBot = await run(agent('s_bot'), 'channels.stopThread', { channelId: cid, threadId: byHuman.result.id });
    t.ok('stopThread: bot が止めると bot が残る', stopBot.ok && stopBot.result.stopped.by.botId === 'b_owl');

    // 読む・探す
    const rd = await run(HUMAN, 'channels.read', { channelId: cid, limit: 2 });
    t.ok('read: posts・threads・summaries・nextBefore を返す。limit は 100 まで', rd.ok && Array.isArray(rd.result.posts) && 'nextBefore' in rd.result && 'summaries' in rd.result && (await run(HUMAN, 'channels.read', { channelId: cid, limit: 101 })).code === 'INVALID');
    t.ok('read(threadId): 根と返信・スレッドの状態（止めた印つき）', (await run(HUMAN, 'channels.read', { channelId: cid, threadId: byHuman.result.id })).result.threads[0].stopped.by.botId === 'b_owl');
    t.ok('search: 本文で探す（チャンネルの名前つき）', (await run(HUMAN, 'channels.search', { query: '読み取り専用でも' })).result.hits[0].channelName === 'ops' && (await run(HUMAN, 'channels.search', { query: '' })).code === 'INVALID');

    // 失敗の文
    const nf = await run(HUMAN, 'channels.get', { channelId: 'c_nope0000' });
    t.ok('失敗は辞書の文（CHANNEL_NOT_FOUND・POST_NOT_FOUND・CHANNEL_NAME_TAKEN・CHANNEL_ARCHIVED）', !nf.ok && nf.code === 'CHANNEL_NOT_FOUND' && /c_nope0000/.test(nf.error) && /channels\.list/.test(nf.error)
      && (await run(HUMAN, 'channels.react', { channelId: cid, postId: 'p_nope0000', emoji: '👍' })).code === 'POST_NOT_FOUND'
      && (await run(HUMAN, 'channels.create', { name: 'OPS' })).code === 'CHANNEL_NAME_TAKEN');
    await run(HUMAN, 'channels.archive', { channelId: cid, on: true });
    const arch = await run(HUMAN, 'channels.post', { channelId: cid, text: 'x' });
    t.ok('アーカイブしたチャンネルへの投稿は CHANNEL_ARCHIVED（戻し方を文で）', !arch.ok && arch.code === 'CHANNEL_ARCHIVED' && /channels\.archive/.test(arch.error), arch.error);
    t.ok('未知の引数・空の本文は INVALID', (await run(HUMAN, 'channels.post', { channelId: cid, text: '' })).code === 'INVALID' && (await run(HUMAN, 'channels.post', { channelId: cid, text: 'x', bogus: 1 })).code === 'INVALID');
    t.ok('英語の文でも出る', (await registry.invoke(HUMAN, 'channels.get', { channelId: 'c_nope0000' }, { ...deps, locale: 'en' })).error.includes('was not found'));
    await channels.close();   // DB の接続（スレッドの状態）を離す

    // ================================================================ 独立レビューの指摘（S-2・S-3・S-4）: 強い bot を起こす確認・スレッドの落ち・作業場所の変更
    {
      const posted = [];
      let tick = 70_000;
      const BOTS = [{ id: 'b_owl', name: 'Owl', icon: '🦉' }, { id: 'b_fox', name: 'Fox', icon: '🦊' }, { id: 'b_lynx', name: 'Lynx', icon: '🐺' }];
      const botModes = { b_owl: 'default', b_fox: 'auto', b_lynx: 'bypass' };            // Owl は都度確認・Fox は聞かずに進む（範囲は同じで自律が上）・Lynx は全部自動
      const MODE_ENTRY = { default: { scope: 'workspace', autonomy: 'ask', label: '都度確認' }, auto: { scope: 'workspace', autonomy: 'judge', label: '自動判断' }, bypass: { scope: 'full', autonomy: 'never', label: '全部自動' }, plan: { scope: 'readonly', autonomy: 'ask', label: '計画' } };
      const reviewChannels = createChannelService({ dir: path.join(tmp, 'review'), now: () => (tick += 10), listBots: async () => BOTS,
        hooks: { posted: async (post, channel, extra) => { posted.push({ post, channel, extra }); } } });
      await reviewChannels.start();
      const made = await reviewChannels.create({ name: 'review' }, { kind: 'human' });
      const root = (await reviewChannels.post({ channelId: made.id, text: '最初の投稿' }, { kind: 'human' }));
      const otherRoot = (await reviewChannels.post({ channelId: made.id, text: '別の話' }, { kind: 'human' }));
      const dm = await reviewChannels.createDm({ bot: { id: 'b_lynx', name: 'Lynx', dmChannelId: '' } });
      const sidecars = {
        s_owl: { botId: 'b_owl', kind: 'thread', channelId: made.id, threadId: root.id },
        s_owl_dm: { botId: 'b_owl', kind: 'dm', channelId: dm.id, threadId: null },
        s_fox: { botId: 'b_fox', kind: 'thread', channelId: made.id, threadId: root.id },
        s_lynx: { botId: 'b_lynx', kind: 'thread', channelId: made.id, threadId: root.id },
        s_plan: { botId: 'b_fox', kind: 'thread', channelId: made.id, threadId: root.id },
      };
      const sessionMode = { s_chat: 'default', s_chat_auto: 'auto', s_owl: 'default', s_owl_dm: 'default', s_fox: 'auto', s_lynx: 'bypass', s_plan: 'plan' };
      const bots = {
        approvalOf: async ({ botId }) => { const b = BOTS.find((x) => x.id === botId); if (!b) return null; const mode = botModes[botId]; return { ...b, mode, label: MODE_ENTRY[mode].label, entry: MODE_ENTRY[mode] }; },
        get: async ({ botId }) => BOTS.find((b) => b.id === botId) ?? null,
      };
      const asked = [], woke = [];
      const rdeps = { locale: 'ja', channels: reviewChannels, bots, botOfSession: async (id) => sidecars[id] ?? null, modeOf: async (id) => MODE_ENTRY[sessionMode[id]] ?? MODE_ENTRY.default, audit: () => {},
        wake: async (a) => { woke.push(a); return { woken: true }; }, approve: async (req) => { asked.push(req); return { pending: true, requestId: `r${asked.length}` }; } };
      const call = (p, id, args, d = rdeps) => registry.invoke(p, id, args, d);
      const lastHook = () => posted.at(-1);
      const settle = () => new Promise((r) => setTimeout(r, 30));

      // S-3(a): bot の会話では threadId を省いたらその会話のスレッド。流れへの新しい投稿は threadId: null と new: true を明示したときだけ
      const dropped = await call(agent('s_owl'), 'channels.post', { channelId: made.id, text: 'threadId を落とした投稿' });
      t.ok('S-3(a): bot の会話が threadId を省くと、その会話のスレッドに書く（新しいスレッドを作らない）', dropped.ok && dropped.result.threadId === root.id, JSON.stringify(dropped.result ?? dropped));
      const explicitNull = await call(agent('s_owl'), 'channels.post', { channelId: made.id, threadId: null, text: 'null だけ' });
      t.ok('S-3(a): threadId: null だけ（new なし）は INVALID（流れへ書くつもりなら new: true も要る、と文で言う）', explicitNull.ok === false && explicitNull.code === 'INVALID' && /new: true/.test(explicitNull.error), explicitNull.error);
      const flow = await call(agent('s_owl'), 'channels.post', { channelId: made.id, threadId: null, new: true, text: '流れへの新しい投稿' });
      await settle();
      t.ok('S-3(a): threadId: null と new: true を明示すればチャンネルの流れへ書ける。起こした元のスレッド（origin）が posted に渡る', flow.ok && flow.result.threadId === null
        && lastHook().extra.origin.threadId === root.id && lastHook().extra.origin.channelId === made.id, JSON.stringify(lastHook()?.extra));
      const other = await call(agent('s_owl'), 'channels.post', { channelId: made.id, threadId: otherRoot.id, text: '別のスレッドへ' });
      t.ok('S-3(a): 明示した別のスレッドにはそのまま書ける', other.ok && other.result.threadId === otherRoot.id);
      const elsewhere = await call(agent('s_owl'), 'channels.post', { channelId: dm.id, text: '会話のチャンネルでない所へ' });
      t.ok('S-3(a): 会話のチャンネルとは別のチャンネルへは既定を補わない（流れ）', elsewhere.ok && elsewhere.result.threadId === null);
      t.ok('S-3(a): DM の会話・bot でない AI・人は、これまでどおり省けば流れ（既定を補わない）', (await call(agent('s_owl_dm'), 'channels.post', { channelId: dm.id, text: 'DM の返事' })).result.threadId === null
        && (await call(agent('s_chat'), 'channels.post', { channelId: made.id, text: 'Chats の AI' })).result.threadId === null
        && (await call(HUMAN, 'channels.post', { channelId: made.id, text: '人' })).result.threadId === null);

      // S-2: 動く承認モードが主体の会話より強い bot を @ すると、投稿は残るが起こさず、承認（channels.wake）を出す
      const mark = asked.length;
      const strong = await call(agent('s_chat'), 'channels.post', { channelId: made.id, text: '@Lynx これを書き換えて' });
      await settle();
      t.ok('S-2: 会話の AI（都度確認）が全部自動の bot を @ すると、投稿は保存されるが posted へは hold 付きで渡る（起こさない・確認済み）', strong.ok && strong.result.text === '@Lynx これを書き換えて'
        && JSON.stringify(lastHook().extra.hold) === '["b_lynx"]' && lastHook().extra.checked === true, JSON.stringify(lastHook()?.extra));
      t.ok('S-2: 承認カード「<bot> は <モード> で動きます。起こしますか」（loosens・モードの行）が出て、起こすのは許可のあと', asked.length === mark + 1 && asked.at(-1).op === 'channels.wake'
        && asked.at(-1).change.note === '🐺 Lynx は 全部自動 で動きます。起こしますか。' && asked.at(-1).change.loosens === true && asked.at(-1).change.rows.some((r) => r.path === 'mode' && r.after === '全部自動') && woke.length === 0);
      t.ok('S-2: 返り値に、承認待ちの bot が分かる wake の欄（status: pending・requestId）が付く', strong.result.wake?.length === 1 && strong.result.wake[0].botId === 'b_lynx' && strong.result.wake[0].status === 'pending' && /r\d+/.test(strong.result.wake[0].requestId), JSON.stringify(strong.result.wake));
      await asked.at(-1).proceed();
      t.ok('S-2: 人が許可すると、その投稿の @ で起こす（postId・botId を渡す）', woke.length === 1 && woke[0].botId === 'b_lynx' && woke[0].postId === strong.result.id && woke[0].channelId === made.id, JSON.stringify(woke));

      const sameMark = asked.length;
      const same = await call(agent('s_chat'), 'channels.post', { channelId: made.id, text: '@Owl 同じ強さ' });
      await settle();
      t.ok('S-2: 同じモードの bot への @ は確認なし（hold は空）。回数の上限も置かない', same.ok && same.result.wake === undefined && asked.length === sameMark && JSON.stringify(lastHook().extra.hold) === '[]');
      const autoOnly = await call(agent('s_chat'), 'channels.post', { channelId: made.id, text: '@Fox 自律だけ強い' });
      t.ok('S-2: 範囲は同じで自律だけ強い bot（Fox）も確認が要る（どちらかの軸が上なら強い）', autoOnly.result.wake?.[0].status === 'pending');
      const weaker = await call(agent('s_chat_auto'), 'channels.post', { channelId: made.id, text: '@Owl 弱い方へ' });
      t.ok('S-2: 自分より弱い bot への @ は確認なし', weaker.ok && weaker.result.wake === undefined);
      const equalFull = await call(agent('s_lynx'), 'channels.post', { channelId: made.id, text: '@Fox 同じか弱い' });
      t.ok('S-2: 全部自動の bot が、同じか弱い bot を @ するのは確認なし', equalFull.ok && equalFull.result.wake === undefined);
      const fromBot = await call(agent('s_owl'), 'channels.post', { channelId: made.id, text: '@Lynx 強い bot へ（bot から）', new: true });
      t.ok('S-2: bot から強い bot への @ も同じ確認（投稿の主体が agent・bot のどちらでも）', fromBot.result.wake?.[0].status === 'pending' && fromBot.result.wake[0].botId === 'b_lynx');
      const humanPost = await call(HUMAN, 'channels.post', { channelId: made.id, text: '@Lynx 人が書く' });
      await settle();
      t.ok('S-2: 人の投稿は確認なし（hold も checked も付けない）', humanPost.result.wake === undefined && lastHook().extra.hold === undefined && lastHook().extra.checked === undefined);
      const roStrong = await call(agent('s_plan'), 'channels.post', { channelId: made.id, text: '@Owl 計画モードから' });
      t.ok('S-2: 読み取りの bot（計画）は、動くモードが上の bot を起こせない。投稿は残り、wake は READ_ONLY_MODE で断られる', roStrong.ok && roStrong.result.wake[0].status === 'denied' && roStrong.result.wake[0].code === 'READ_ONLY_MODE', JSON.stringify(roStrong.result.wake));
      const noCard = await call(agent('s_chat'), 'channels.post', { channelId: made.id, text: '@Lynx 承認の口なし' }, { ...rdeps, approve: undefined });
      t.ok('S-2: 承認の口が無い呼び出しは NEEDS_APPROVAL（起こさない）', noCard.result.wake[0].status === 'denied' && noCard.result.wake[0].code === 'NEEDS_APPROVAL');
      const dmPost = await call(agent('s_chat'), 'channels.post', { channelId: dm.id, text: 'DM の bot（全部自動）へ' });
      t.ok('S-2: DM（@ なしで bot へ届く）も、宛先の bot が強ければ確認が要る', dmPost.result.wake?.[0].status === 'pending' && dmPost.result.wake[0].botId === 'b_lynx');
      // ターンの投稿に入った返事（ADR 0117）も、新しい投稿と同じく強い bot への @ は確認を出す（書いたときに @ を解く）
      const turnPost = await reviewChannels.post({ channelId: made.id, threadId: root.id, text: '…', state: 'working', turn: { botId: 'b_owl', sessionId: 's_owl' }, new: true }, { kind: 'bot', botId: 'b_owl' });
      const progressMark = asked.length;
      const progress = await call(agent('s_owl'), 'channels.post', { channelId: made.id, text: '@Lynx あとで頼む' });
      t.ok('S-2: bot がターンの中で書いた返事がターンの投稿に入っても、強い bot への @ は確認を出す（ADR 0117）', progress.ok && progress.result.id === turnPost.id && progress.result.wake?.[0]?.status === 'pending' && asked.length === progressMark + 1, JSON.stringify(progress.result.wake));

      // channels.wake そのもの
      const wakeMark = asked.length;
      const direct = await call(agent('s_chat'), 'channels.wake', { channelId: made.id, postId: strong.result.id, botId: 'b_lynx' });
      t.ok('channels.wake: AI が呼ぶと承認（guarded）。人が呼べば確認なしで起こす', direct.pending === true && asked.length === wakeMark + 1
        && (await call(HUMAN, 'channels.wake', { channelId: made.id, postId: strong.result.id, botId: 'b_lynx' })).result.woken === true);
      t.ok('channels.wake: 無い bot は BOT_NOT_FOUND', (await call(agent('s_chat'), 'channels.wake', { channelId: made.id, postId: strong.result.id, botId: 'b_nope' })).code === 'BOT_NOT_FOUND');
      const reask = asked.length;
      const first = asked.at(-1);
      botModes.b_lynx = 'auto';                                           // 許可を待つ間に、bot のモードが変わった
      await first.proceed();
      botModes.b_lynx = 'bypass';
      t.ok('channels.wake: 許可のあとに bot のモードが変わっていたら、起こさずに聞き直す（受領証の照合）', asked.length === reask + 1 && woke.length === 2, `${asked.length} ${reask} ${woke.length}`);

      // markRead の at は今を超えない（未来の時刻を入れて、そのチャンネルの未読の印を殺せない）
      const future = await call(agent('s_chat'), 'channels.markRead', { channelId: made.id, at: 9_000_000_000_000_000 });
      t.ok('markRead: at に未来の時刻を入れても、既読の位置は今で頭打ち（AI・CLI も呼べる write なので）', future.ok && future.result.readAt <= Date.now() && future.result.readAt > 0, JSON.stringify(future.result));

      // S-4: AI が作業場所（cwd）を決める・変えるのは承認
      const cwdMark = asked.length;
      const cwdAsk = await call(agent('s_chat'), 'channels.update', { channelId: made.id, cwd: path.join(tmp, 'work') });
      t.ok('S-4: AI が channels.update で cwd を変えるのは承認（before・after の行・loosens）。許可前は変わらない', cwdAsk.pending === true && asked.length === cwdMark + 1 && asked.at(-1).change.rows[0].path === 'cwd'
        && asked.at(-1).change.rows[0].after === path.join(tmp, 'work') && asked.at(-1).change.loosens === true && (await reviewChannels.get({ channelId: made.id })).cwd === null);
      await asked.at(-1).proceed();
      t.ok('S-4: 許可されたら変わる。同じ値・外す（null）・cwd 以外の変更は承認なし', (await reviewChannels.get({ channelId: made.id })).cwd === path.join(tmp, 'work')
        && (await call(agent('s_chat'), 'channels.update', { channelId: made.id, cwd: path.join(tmp, 'work') })).ok === true && (await call(agent('s_chat'), 'channels.update', { channelId: made.id, purpose: '目的だけ' })).ok === true && asked.length === cwdMark + 1
        && (await call(agent('s_chat'), 'channels.update', { channelId: made.id, cwd: null })).ok === true && asked.length === cwdMark + 1);
      t.ok('S-4: 人は cwd を承認なしで変えられる。AI が cwd つきで作るのも承認、cwd なしの作成は承認なし', (await call(HUMAN, 'channels.update', { channelId: made.id, cwd: path.join(tmp, 'work') })).ok === true
        && (await call(agent('s_chat'), 'channels.create', { name: 'with-cwd', cwd: path.join(tmp, 'work') })).pending === true
        && (await call(agent('s_chat'), 'channels.create', { name: 'without-cwd' })).ok === true);

      // ADR 0119: 予算は channels.get が既定を埋めて返す。AI が外す・上げるのは承認、下げるのは承認なし。人はどちらも承認なし
      const shownBudget = await reviewChannels.get({ channelId: made.id });
      t.ok('予算: 設定の無いチャンネルは既定（1 日 5%・1 スレッド 50%）と今日の使用（spentToday）を返す', shownBudget.budget?.daily === 5 && shownBudget.budget?.perThread === 50 && shownBudget.spentToday === 0, JSON.stringify(shownBudget));
      const budgetMark = asked.length;
      const lower = await call(agent('s_chat'), 'channels.update', { channelId: made.id, budget: { daily: 2 } });
      t.ok('予算: AI が下げるのは承認なし（渡した欄だけ変わる）', lower.ok === true && asked.length === budgetMark && (await reviewChannels.get({ channelId: made.id })).budget.daily === 2 && (await reviewChannels.get({ channelId: made.id })).budget.perThread === 50);
      const raise = await call(agent('s_chat'), 'channels.update', { channelId: made.id, budget: { daily: null } });
      t.ok('予算: AI が外す（null）・上げるのは承認（before・after の行）。許可前は変わらない', raise.pending === true && asked.length === budgetMark + 1
        && asked.at(-1).change.rows.some((r) => r.path === 'budget.daily' && r.before === 2 && r.after === null) && (await reviewChannels.get({ channelId: made.id })).budget.daily === 2);
      await asked.at(-1).proceed();
      t.ok('予算: 許可されたら変わる。人は承認なしで上げ下げできる。範囲の外は断る', (await reviewChannels.get({ channelId: made.id })).budget.daily === null
        && (await call(HUMAN, 'channels.update', { channelId: made.id, budget: { daily: 10, perThread: 80 } })).ok === true && asked.length === budgetMark + 1
        && (await call(HUMAN, 'channels.update', { channelId: made.id, budget: { perThread: 0 } })).ok !== true);
      await reviewChannels.close();
    }

    // ---- サーバー越し（fake）: 画面（WS の invoke）の出来事と、CLI（束縛なし・会話に束縛）
    const dataDir = path.join(tmp, 'data');
    const server = await startServer({ env: { AGENT_HOST_BACKENDS: 'fake' }, dataDir, timeoutMs: 60_000 });
    const c = await open({ port: server.port, token: server.token });
    try {
      const call = (op, args) => c.cmd('invoke', { op, args });
      const m0 = c.mark();
      const ch = await call('channels.create', { name: 'e2e', purpose: 'サーバー越し' });
      t.ok('画面の invoke: チャンネルを作ると channelsChanged が全接続へ（sessionId なし）', ch.name === 'e2e'
        && c.since(m0).some((e) => e.type === 'channelsChanged' && e.channel?.id === ch.id && !e.sessionId));
      const m1 = c.mark();
      const p1 = await call('channels.post', { channelId: ch.id, text: 'こんにちは' });
      t.ok('画面の投稿は human で、channelPost(add) が出る', p1.author.kind === 'human' && c.since(m1).some((e) => e.type === 'channelPost' && e.op === 'add' && e.post.id === p1.id && !e.sessionId));
      const m2 = c.mark();
      await call('channels.react', { channelId: ch.id, postId: p1.id, emoji: '👍' });
      t.ok('リアクションで channelReaction が出る', c.since(m2).some((e) => e.type === 'channelReaction' && e.postId === p1.id && e.reactions['👍'].length === 1));
      const m4 = c.mark();
      await call('channels.markRead', { channelId: ch.id, at: 7 });
      t.ok('既読で channelRead が出る（別の端末・窓へ）', c.since(m4).some((e) => e.type === 'channelRead' && e.channelId === ch.id && e.readAt === 7));
      t.ok('定義は <data>/channels/index.json、投稿は <id>.jsonl に追記される', JSON.parse(await fs.readFile(path.join(dataDir, 'channels', 'index.json'), 'utf8')).channels.some((x) => x.id === ch.id)
        && (await fs.readFile(path.join(dataDir, 'channels', `${ch.id}.jsonl`), 'utf8')).split('\n').filter(Boolean).length === 2);

      // 添付つきの投稿（ADR 0116）: 置き場に送ったファイル（device）と読んでよいホストのファイル（host）が載り、データ置き場の中・無いファイルは断る
      const sent = await c.cmd('attachFile', { sessionId: ch.id, name: 'shot.png', mime: 'image/png', data: Buffer.from('png-bytes').toString('base64') });
      const hostFile = path.join(tmp, 'host-note.txt');
      await fs.writeFile(hostFile, 'host file');
      const m6 = c.mark();
      const withFiles = await call('channels.post', { channelId: ch.id, text: `見て\n[添付] ${sent.path}\n[添付] ${hostFile}`, attachments: [{ path: sent.path, mime: 'image/png' }, { path: hostFile }] });
      const [a1, a2] = withFiles.attachments ?? [];
      t.ok('画面の投稿に添付を載せられる: 置き場のファイルは device・画像、ホストのファイルは host（パスのまま）。名前・大きさも入る', a1?.origin === 'device' && a1.kind === 'image' && a1.name === 'shot.png' && a1.size === 9
        && a2?.origin === 'host' && a2.kind === 'file' && a2.path === hostFile && a2.name === 'host-note.txt' && a2.size === 9, JSON.stringify(withFiles.attachments));
      t.ok('添付つきの投稿が channelPost で全接続へ届く（中身は載せない）', c.since(m6).some((e) => e.type === 'channelPost' && e.post.id === withFiles.id && e.post.attachments?.length === 2 && !JSON.stringify(e.post).includes('png-bytes')));
      const secret = await call('channels.post', { channelId: ch.id, text: 'x', attachments: [{ path: path.join(dataDir, 'channels', 'index.json') }] }).then(() => null, (e) => e.message);
      const gone = await call('channels.post', { channelId: ch.id, text: 'x', attachments: [{ path: path.join(tmp, 'no-such-file.txt') }] }).then(() => null, (e) => e.message);
      t.ok('データ置き場の中のファイル・無いファイルは添付できない（INVALID。会話の添付と同じ読み取りの検査）', /cannot attach/.test(secret ?? '') && /cannot attach/.test(gone ?? ''), `${secret} / ${gone}`);

      const env = (extra = {}) => {
        const e = { ...process.env, AGENT_HOST_DATA: dataDir, AGENT_HOST_LOCALE: 'ja', ...extra };
        for (const k of ['PLEIAD_CONTROL_URL', 'PLEIAD_CONTROL_TOKEN']) if (!(k in extra)) delete e[k];
        return e;
      };
      const cli = (args, e) => { const r = spawnSync(process.execPath, [BIN, ...args], { env: e, encoding: 'utf8', timeout: 60_000 }); return { code: r.status, out: r.stdout, err: r.stderr }; };
      const unboundEnv = env();
      const listed = cli(['channels', 'list', '--json'], unboundEnv);
      t.ok('CLI: pleiad channels list（束縛なしでも読める）', listed.code === 0 && JSON.parse(listed.out).channels.some((x) => x.id === ch.id && x.name === 'e2e'), listed.out + listed.err);
      t.ok('CLI: pleiad channels read / search / get', JSON.parse(cli(['channels', 'read', ch.id, '--json'], unboundEnv).out).posts[0].text === 'こんにちは'
        && JSON.parse(cli(['channels', 'search', 'こんにちは', '--json'], unboundEnv).out).hits.length === 1 && JSON.parse(cli(['channels', 'get', ch.id, '--json'], unboundEnv).out).name === 'e2e');
      const noChannel = cli(['channels', 'get', 'c_nope0000'], unboundEnv);
      t.ok('CLI: 無いチャンネルは終了コード 2（文は辞書から）', noChannel.code === 2 && /見つかりません/.test(noChannel.err), `${noChannel.code} ${noChannel.err}`);
      const unboundPost = cli(['call', 'channels.post', '--args', JSON.stringify({ channelId: ch.id, text: '束縛なし' })], unboundEnv);
      t.ok('CLI: 束縛されない pleiad call channels.post は 4（人として書かせない。画面へ誘導）', unboundPost.code === 4 && /画面/.test(unboundPost.err), `${unboundPost.code} ${unboundPost.err}`);

      const turn = await c.runTurn({ prompt: 'control-info', sessionId: null, cwd: ROOT, backend: 'fake', mode: 'default' }, { ms: 30_000 });
      const info = JSON.parse((await c.cmd('loadSession', { sessionId: turn.sessionId })).messages.at(-1).text);
      // 取り違えた会話（裏の会話の返事）で束縛なしの CLI を作ると、NEEDS_UI の別の顔で落ちる。ここで止める
      t.ok('control-info: この会話のシェルへ渡す url・token が取れた（CLI を会話に束縛できる）', typeof info.envUrl === 'string' && typeof info.token === 'string' && info.token.length === 64, JSON.stringify(Object.keys(info)));
      const bound = env({ PLEIAD_CONTROL_URL: info.envUrl, PLEIAD_CONTROL_TOKEN: info.token });
      const m5 = c.mark();
      const posted = cli(['call', 'channels.post', '--args', JSON.stringify({ channelId: ch.id, threadId: p1.id, text: 'CLI から返信' }), '--json'], bound);
      const post = posted.code === 0 ? JSON.parse(posted.out) : null;
      t.ok('CLI: 会話に束縛された pleiad call channels.post は agent として書く（会話の id つき）。channelPost が出る', post?.author.kind === 'agent' && post.author.sessionId === turn.sessionId && post.threadId === p1.id
        && await c.waitFor((e) => e.type === 'channelPost' && e.post.id === post?.id, { from: m5, ms: 5000 }).then(() => true, () => false), posted.out + posted.err);
      const posted2 = cli(['channels', 'post', ch.id, 'もう 1 つ', '--json'], bound);
      t.ok('CLI: 位置引数で pleiad channels post <channelId> <text>', posted2.code === 0 && JSON.parse(posted2.out).text === 'もう 1 つ', posted2.out + posted2.err);
      const reacted = cli(['channels', 'react', ch.id, p1.id, '🎉', '--json'], bound);
      t.ok('CLI: pleiad channels react', reacted.code === 0 && JSON.parse(reacted.out).reactions['🎉'].length === 1, reacted.out + reacted.err);
      const marked = cli(['channels', 'mark-read', ch.id, '--json'], bound);
      t.ok('CLI: 既読も AI・CLI から（pleiad channels mark-read <channelId>）', marked.code === 0 && JSON.parse(marked.out).readAt > 0, marked.out + marked.err);
      const edited = cli(['call', 'channels.edit', '--args', JSON.stringify({ channelId: ch.id, postId: p1.id, text: '人の投稿を直す' })], bound);
      t.ok('CLI: 会話の AI は人の投稿を直せない（終了コード 5・NOT_YOUR_POST の文）', edited.code !== 0 && /自分の投稿/.test(edited.err), `${edited.code} ${edited.err}`);
    } finally {
      c.close();
      await server.stop();
    }
  } finally {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}
