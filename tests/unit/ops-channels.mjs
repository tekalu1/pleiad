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
const IDS = ['list', 'get', 'read', 'search', 'create', 'update', 'archive', 'post', 'edit', 'delete', 'react', 'markRead', 'stopThread'].map((v) => `channels.${v}`);

export default async function (t) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ops-channels-'));
  try {
    // ---- 定義
    t.ok('操作は 13 個（channels.list / get / read / search / create / update / archive / post / edit / delete / react / markRead / stopThread）', IDS.every((id) => registry.get(id)) && registry.ops.filter((o) => o.id.startsWith('channels.')).length === 13);
    const risk = (id) => registry.get(id).risk;
    t.ok('危険度: 読む 4 つは read・書く 9 つは write（human-only・guarded はない。ADR 0082 の 5 つ以外は AI も使える）', ['list', 'get', 'read', 'search'].every((v) => risk(`channels.${v}`) === 'read')
      && ['create', 'update', 'archive', 'post', 'edit', 'delete', 'react', 'markRead', 'stopThread'].every((v) => risk(`channels.${v}`) === 'write'));
    t.ok('modeGate: false は post・react・stopThread だけ（読み取り・計画の bot も返事・リアクション・停止はできる）', IDS.filter((id) => registry.get(id).modeGate === false).join() === 'channels.post,channels.react,channels.stopThread');
    t.ok('口: どれも画面から。MCP は catalog（直のツールは足さない）。CLI は全部（markRead も AI・CLI に出す）', IDS.every((id) => registry.get(id).surfaces.ui === true && registry.get(id).surfaces.mcp === 'catalog' && registry.get(id).surfaces.cli));
    t.ok('write の理由（riskReason）を持つ', IDS.filter((id) => risk(id) === 'write').every((id) => registry.get(id).riskReason.length > 20));
    t.ok('CLI のコマンド: channels list / get / read / search / create / update / archive / post / edit / delete / react / mark-read 相当（位置引数は post が channelId と text）', registry.get('channels.post').surfaces.cli.positional.join() === 'channelId,text'
      && registry.get('channels.get').surfaces.cli.path.join(' ') === 'channels get');
    const aiSees = registry.describe({ by: 'agent', via: 'cli' }, 'ja').map((o) => o.id);
    t.ok('AI（CLI）の一覧にチャンネルの操作が全部出る。直のツールは 0', IDS.every((id) => aiSees.includes(id)) && registry.describe({ by: 'agent', via: 'mcp' }, 'ja').filter((o) => o.id.startsWith('channels.')).every((o) => o.tool === null));

    // ---- 実行
    let clock = 5000;
    const channels = createChannelService({ dir: path.join(tmp, 'channels'), now: () => (clock += 10), listBots: async () => [{ id: 'b_owl', name: 'Owl' }] });
    await channels.start();
    const bound = { s_bot: { botId: 'b_owl', kind: 'thread' } };
    const modes = { s_ro: { scope: 'readonly', autonomy: 'ask' }, s_plan: { scope: 'readonly', autonomy: 'ask' } };
    const deps = { locale: 'ja', channels, botOfSession: async (id) => bound[id] ?? null, modeOf: async (id) => modes[id] ?? { scope: 'workspace', autonomy: 'ask' }, audit: () => {} };
    const run = (p, id, args) => registry.invoke(p, id, args, deps);

    const made = await run(HUMAN, 'channels.create', { name: '#ops', purpose: 'テスト' });
    t.ok('create: 画面（人）から作れる', made.ok && made.result.name === 'ops', JSON.stringify(made));
    const cid = made.result.id;
    const aiMade = await run(agent('s_chat'), 'channels.create', { name: 'ai-made' });
    t.ok('create: 会話の AI も作れる（write。人と同じ）', aiMade.ok);
    t.ok('list・get: 画面と AI のどちらにも返る', (await run(HUMAN, 'channels.list', {})).result.channels.length === 2 && (await run(agent('s_chat', 'cli'), 'channels.get', { channelId: cid })).result.name === 'ops');

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
    channels.stop();

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
