// bot を起こす・配る（S4。ADR 0096・0095、docs/channels.md「起こし方」）。fake バックエンドのサーバー越しに通す。LLM もネットワークも使わない。
//   「チャンネルに @Owl やって」→ Owl の会話がターンを走らせ、返事がスレッドの投稿になる → Owl が返事で @Lynx と書くと Lynx が起きる → ［止める］で止まる。
//   途中送信（Claude・Codex の形）と、途中送信できない形（Antigravity と同じ。承認待ちの間）のたまった出来事・DM・暗黙では起こさない・再起動での戻し。
//   あわせて inbox.json の保存（状態・壊れたファイル・古いものの整理）を、サーバー無しで確かめる。
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../lib/server.mjs';
import { open, sleep } from '../lib/ws-client.mjs';
import { createInboxStore } from '../../core/bots/inbox.mjs';
import { createDispatcher, PLACEHOLDER } from '../../core/bots/dispatch.mjs';

export const name = 'bot-dispatch';
export const title = 'bot を起こす・配る: @ で起こす・返事の @ で連鎖・止める・途中送信とたまった出来事・DM・暗黙では起こさない・再起動の戻し・inbox.json';

const until = async (fn, { ms = 20_000, label = '' } = {}) => {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) { last = await fn(); if (last) return last; await sleep(40); }
  throw new Error(`timeout: ${label} ${JSON.stringify(last ?? null)?.slice(0, 600)}`);
};

export default async function (t) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'bot-dispatch-'));
  const servers = [], clients = [];
  try {
    // ================================================================ inbox.json（サーバー無し）
    {
      const dir = path.join(tmp, 'inbox');
      let clock = 1000;
      const inbox = createInboxStore({ dir, now: () => clock++ });
      const a = await inbox.add({ sessionId: 's1', botId: 'b_x', channelId: 'c_x', threadId: 'p_1', postId: 'p_2' });
      const b = await inbox.add({ sessionId: 's2', botId: 'b_y', channelId: 'c_x', threadId: null, postId: 'p_3' });
      t.ok('inbox: pending で保存される（id は i_）', a.status === 'pending' && a.id.startsWith('i_') && (await inbox.list({ status: 'pending' })).length === 2);
      await inbox.mark([a.id], 'delivering');
      const reread = createInboxStore({ dir });
      t.ok('inbox: ファイルに書かれ、読み直しても同じ', (await reread.list({ sessionId: 's1' }))[0].status === 'delivering'
        && JSON.parse(await fs.readFile(path.join(dir, 'inbox.json'), 'utf8')).version === 1);
      const recovered = await reread.recover();
      t.ok('inbox: 起動の戻しは delivering を unknown に（送り直さない）、pending の会話を返す', recovered.demoted === 1 && recovered.sessions.join() === 's2'
        && (await reread.list({ sessionId: 's1' }))[0].status === 'unknown' && (await reread.list({ sessionId: 's2' }))[0].id === b.id);
      for (let i = 0; i < 130; i++) { const x = await inbox.add({ sessionId: 's3', botId: 'b_x', channelId: 'c_x', postId: `p_${i}` }); await inbox.mark([x.id], 'sent'); }
      const kept = await inbox.list({});
      t.ok('inbox: 送り終えたものは新しい 100 件だけ残し、pending は消えない', kept.filter((i) => i.status === 'sent').length === 100 && kept.some((i) => i.id === b.id));
      t.ok('inbox: remove は消した数を返す', (await inbox.remove([b.id])) === 1 && (await inbox.list({ status: 'pending' })).length === 0);
      const broken = path.join(tmp, 'inbox-broken');
      await fs.mkdir(broken, { recursive: true });
      await fs.writeFile(path.join(broken, 'inbox.json'), '{ not json');
      t.ok('inbox: 壊れたファイルは上書きせずに投げる', await createInboxStore({ dir: broken }).add({ sessionId: 's', botId: 'b', channelId: 'c', postId: 'p' }).then(() => false, (e) => /inbox\.json/.test(e.message))
        && (await fs.readFile(path.join(broken, 'inbox.json'), 'utf8')) === '{ not json');
      const future = path.join(tmp, 'inbox-future');
      await fs.mkdir(future, { recursive: true });
      await fs.writeFile(path.join(future, 'inbox.json'), JSON.stringify({ version: 2, items: [] }));
      t.ok('inbox: 読めない版は読み込まない', await createInboxStore({ dir: future }).list({}).then(() => false, (e) => /version 2/.test(e.message)));
    }

    // ================================================================ 空の入れ物（P0 のつなぎ目と同じく、bot の会話でなければ何もしない）
    {
      const sessions = { plain: {} };
      const d = createDispatcher({ channels: { dir: path.join(tmp, 'stub'), threads: { get: async () => null, update: async () => ({}) } }, bots: { get: async () => null, list: async () => [] }, memory: {}, host: { store: { get: async (id) => sessions[id] ?? {} } } });
      const extras = await d.turnExtras({ info: { sessionId: 'plain' } });
      d.onTurnEvent({ info: { sessionId: 'plain' } }, { type: 'text.delta', text: 'x' });
      await d.onTurnEnd({ info: { sessionId: 'plain' } }, { outcome: 'ok' });
      d.onPermission({ id: 'p', sessionId: 'plain' }, 'open');
      await d.onCompacted('plain');
      await d.onPosted({ id: 'p_1', author: { kind: 'system' }, text: '@Owl' }, { id: 'c_1', kind: 'channel' });
      t.ok('bot の会話でなければ turnExtras は空・つなぎ目は何もしない', extras.botInstructions === null && extras.notes.length === 0 && d.activeCount() === 0);
      t.ok('PLACEHOLDER は言語を持たない印', PLACEHOLDER === '…');
    }

    // ================================================================ 途中送信の形ごとの扱い（身代わりのサービス・バックエンド）
    {
      let worlds = 0;
      const world = (steerKind, { realStart = false } = {}) => {
        let dRef = null;
        const posts = [
          { id: 'p_root', channelId: 'c_1', threadId: null, author: { kind: 'human' }, text: '根', mentions: ['b_1'], at: 1000, reactions: {} },
          { id: 'p_2', channelId: 'c_1', threadId: 'p_root', author: { kind: 'human' }, text: '追記 2', mentions: [], at: 2000, reactions: {} },
          { id: 'p_3', channelId: 'c_1', threadId: 'p_root', author: { kind: 'human' }, text: '追記 3', mentions: [], at: 3000, reactions: {} },
        ];
        const threads = { 'c_1/p_root': { channelId: 'c_1', threadId: 'p_root', sessions: { b_1: 's1' }, state: 'idle', tokens: { input: 0, output: 0, cached: 0 }, calls: 0, stopped: null } };
        const sessions = { s1: { bot: { botId: 'b_1', kind: 'thread', channelId: 'c_1', threadId: 'p_root', memRev: 0, snapshotDue: false, delivered: [], postCursor: 'p_root' } } };
        const steers = [], emitted = [], started = [], aborted = [];
        let accept = async () => true;
        const control = steerKind === 'none' ? {} : { steer: async (m) => { steers.push(m); return accept(m); }, ...(steerKind === 'confirm' ? { steerConfirms: true } : {}) };
        const turn = { info: { sessionId: 's1' }, control, ac: { signal: { aborted: false } }, outcome: null, usage: {}, agentLocale: 'ja' };
        const turns = new Map([['s1', turn]]);
        const channel = { id: 'c_1', kind: 'channel', name: 'dev' };
        const channels = {
          dir: path.join(tmp, `stub-${steerKind}-${++worlds}`),
          get: async () => channel, getPost: async ({ postId }) => structuredClone(posts.find((x) => x.id === postId) ?? null),
          read: async () => ({ posts: structuredClone(posts) }),
          post: async (a) => { const post = { id: `p_t${posts.length}`, channelId: a.channelId, threadId: a.threadId, author: { kind: 'bot', botId: 'b_1' }, text: a.text, state: a.state, turn: a.turn, mentions: [], at: 4000, reactions: {} }; posts.push(post); return post; },
          edit: async (a) => { const post = posts.find((x) => x.id === a.postId); Object.assign(post, ...[a.text !== undefined && { text: a.text }, a.state && { state: a.state }].filter(Boolean)); return structuredClone(post); },
          remove: async () => {},
          threads: {
            get: async (c, th) => structuredClone(threads[`${c}/${th}`] ?? null), list: async () => [],
            update: async (c, th, patch) => { const cur = threads[`${c}/${th}`]; const next = typeof patch === 'function' ? patch(structuredClone(cur)) : patch; Object.assign(cur, next); return structuredClone(cur); },
          },
        };
        const host = {
          dataDir: tmp, store: { get: async (id) => structuredClone(sessions[id] ?? {}), setSessionData: async (id, f, v) => { sessions[id] = { ...sessions[id], [f]: v }; } },
          runtime: { turns }, noticeTarget: async () => (control.steer ? turn : null), noticeBlocked: async () => false,
          agentLocaleFor: async () => 'ja', currentLocale: () => 'ja', emitSession: (id, e) => emitted.push({ id, ...e }),
          abortSessions: async (a) => { aborted.push(a); },
          // realStart: 本物の runTurn と同じく、始まったら turnExtras を呼ぶ（始まったターンは starting を受け取る）
          runTurn: async (args, _onStarted, hooks) => { started.push({ args, hooks }); if (realStart) await dRef.turnExtras({ info: { sessionId: args.sessionId }, agentLocale: 'ja', stream: {} }); return 'ok'; },
          lastReply: async () => '終わり',
        };
        const bots = { get: async ({ botId }) => (botId === 'b_1' ? { id: 'b_1', name: 'Owl', icon: '🦉' } : null), list: async () => [{ id: 'b_1', name: 'Owl', icon: '🦉' }] };
        const memory = { turnContext: async () => ({ notes: [], memRev: 0, delivered: [], snapshotDue: false }) };
        const d = createDispatcher({ channels, bots, memory, host });
        dRef = d;
        return { d, posts, threads, sessions, steers, emitted, started, aborted, turn, turns, control, channel, setAccept: (f) => { accept = f; } };
      };
      const statusOf = async (w, postId) => (await w.d.inbox.list({})).find((i) => i.postId === postId)?.status;
      const tick = () => sleep(60);

      // 「渡った」合図を後から出すバックエンド（Codex の形。steerConfirms）
      {
        const w = world('confirm');
        await w.d.turnExtras(w.turn);
        await w.d.onPosted(w.posts[1], w.channel);
        t.ok('途中送信: 受理したら delivering のまま合図を待つ（画面へはまだ出さない）。包みは投稿 1 件だけで、末尾は付けない', w.steers.length === 1 && w.steers[0].id.startsWith('channel-i_') && w.steers[0].args.prompt.startsWith('<pleiad-channel ')
          && w.steers[0].args.prompt.includes('post="p_2"') && w.steers[0].args.prompt.includes('channel-id="c_1"') && !w.steers[0].args.prompt.includes('pleiad-turn-context')
          && await statusOf(w, 'p_2') === 'delivering' && !w.emitted.some((e) => e.type === 'channelEvent'), w.steers[0]?.args.prompt);
        w.d.onTurnEvent(w.turn, { type: 'userMessage.delivered', messageId: w.steers[0].id });
        await tick();
        t.ok('途中送信: 合図（userMessage.delivered）で sent になり、会話の画面へ channelEvent を出し、postCursor を進める', await statusOf(w, 'p_2') === 'sent'
          && w.emitted.some((e) => e.type === 'channelEvent' && e.id === 's1' && e.rows.some((r) => r.postId === 'p_2')) && w.sessions.s1.bot.postCursor === 'p_2', JSON.stringify(w.sessions.s1.bot));
        await w.d.onPosted(w.posts[2], w.channel);
        w.d.onTurnEvent(w.turn, { type: 'userMessage.dropped', messageId: w.steers[1].id });
        await tick();
        t.ok('途中送信: 読まれずに捨てられた（dropped）ものは pending に戻る（画面へは出さない）。postCursor は進めない', await statusOf(w, 'p_3') === 'pending'
          && w.emitted.filter((e) => e.type === 'channelEvent').length === 1 && w.sessions.s1.bot.postCursor === 'p_2');
        // ターンの終わりまでに合図が来なかったものも pending に戻り、新しいターンで 1 通にまとめて渡る
        w.turns.delete('s1');
        await w.d.onTurnEnd(w.turn, { outcome: 'ok' });
        await tick();
        t.ok('ターンが終わると pending は新しいターン（internal）で渡る。文脈には自分のターンの投稿を入れない', w.started.length === 1 && w.started[0].hooks.internal === true && w.started[0].args.sessionId === 's1'
          && w.started[0].args.prompt.includes('post="p_3"') && !w.started[0].args.prompt.includes('post="p_t'), w.started[0]?.args.prompt);
      }

      // 受理されない・結果不明
      {
        const w = world('plain');
        await w.d.turnExtras(w.turn);
        w.setAccept(async () => false);
        await w.d.onPosted(w.posts[1], w.channel);
        t.ok('受理されなければ pending のまま、ターンの終わりに渡す', await statusOf(w, 'p_2') === 'pending' && w.emitted.length === 0);
        w.turns.delete('s1');
        await w.d.onTurnEnd(w.turn, { outcome: 'ok' });
        await tick();
        t.ok('受理されなかったものは、ターンの終わりに新しいターンで渡る', w.started.length === 1 && w.started[0].args.prompt.includes('post="p_2"'));
        const x = world('plain');
        await x.d.turnExtras(x.turn);
        x.setAccept(async () => { throw new Error('steer failed'); });
        await x.d.onPosted(x.posts[1], x.channel);
        t.ok('結果不明（throw）は unknown', await statusOf(x, 'p_2') === 'unknown' && x.emitted.length === 0);
        x.setAccept(async () => true);
        await x.d.onPosted(x.posts[2], x.channel);
        x.turns.delete('s1');
        await x.d.onTurnEnd(x.turn, { outcome: 'ok' });
        await tick();
        t.ok('結果不明は自動では送り直さない（ターンの終わりに渡るのは pending だけ）', await statusOf(x, 'p_2') === 'unknown' && await statusOf(x, 'p_3') === 'sent' && x.started.length === 0, JSON.stringify(await x.d.inbox.list({})));
      }

      // 途中送信を持たないバックエンド（Antigravity）: たまって、ターンの終わりにまとめて 1 通
      {
        const w = world('none', { realStart: true });
        await w.d.turnExtras(w.turn);
        await w.d.onPosted(w.posts[1], w.channel);
        await w.d.onPosted(w.posts[2], w.channel);
        t.ok('途中送信できないバックエンドでは、書き足しは pending のまま', w.steers.length === 0 && await statusOf(w, 'p_2') === 'pending' && await statusOf(w, 'p_3') === 'pending');
        w.turns.delete('s1');
        await w.d.onTurnEnd(w.turn, { outcome: 'ok' });
        await tick();
        const prompt = w.started[0]?.args.prompt ?? '';
        t.ok('まとめて 1 通（1 つの新しいターン）で渡り、投稿の順に並ぶ', w.started.length === 1 && prompt.indexOf('post="p_2"') > 0 && prompt.indexOf('post="p_2"') < prompt.indexOf('post="p_3"'), prompt);
        w.d.onTurnEvent({ info: { sessionId: 's1' } }, { type: 'text.delta', text: 'x' });
        await tick();
        t.ok('新しいターンに渡った最初の合図で、渡した印（sent）と postCursor（最後の投稿）が確定する', w.sessions.s1.bot.postCursor === 'p_3' && await statusOf(w, 'p_2') === 'sent' && await statusOf(w, 'p_3') === 'sent', JSON.stringify([w.sessions.s1.bot, await w.d.inbox.list({})]));
      }

      // ［止める］: 保留中の出来事を取り消し、走っているターンを止め、止めた主体を残す。止めたスレッドは起こさない
      {
        const w = world('none');
        await w.d.turnExtras(w.turn);
        await w.d.onPosted(w.posts[1], w.channel);
        w.threads['c_1/p_root'].stopped = { by: { kind: 'human' }, at: 5000 };
        await w.d.stopThread({ channelId: 'c_1', threadId: 'p_root' }, { kind: 'human' });
        t.ok('止める: 保留中の出来事を取り消し・走っているターンを止める（理由は user）', (await w.d.inbox.list({})).length === 0 && w.aborted.length === 1 && w.aborted[0].sessionId === 's1' && w.aborted[0].reason === 'user', JSON.stringify([await w.d.inbox.list({}), w.aborted]));
        w.turns.delete('s1');
        await w.d.onTurnEnd(w.turn, { outcome: 'aborted', interrupted: { reason: 'user' } });
        await w.d.onPosted(w.posts[2], w.channel);
        t.ok('止めたスレッドへの @ なしの書き足しは、誰も起こさない', (await w.d.inbox.list({})).length === 0 && w.started.length === 0, JSON.stringify([await w.d.inbox.list({}), w.started]));
        const done = w.posts.find((p) => p.turn);
        t.ok('止めたターンの投稿は stopped', done?.state === 'stopped', JSON.stringify(done));
      }

      // 圧縮のターンの間にたまった出来事は、圧縮が終わったときに渡る
      {
        const w = world('plain');
        const compact = { info: { sessionId: 's1' }, compactTrigger: 'manual', control: {}, ac: { signal: { aborted: false } }, outcome: null, usage: {} };
        w.turns.set('s1', compact);
        w.d.host.noticeTarget = async () => null;
        await w.d.onPosted({ ...w.posts[1], mentions: ['b_1'] }, w.channel);
        t.ok('圧縮のターンには途中送信しない（pending）。末尾も人格も足さない', (await w.d.turnExtras(compact)).notes.length === 0 && await statusOf(w, 'p_2') === 'pending' && w.steers.length === 0);
        w.turns.delete('s1');
        await w.d.onTurnEnd(compact, { outcome: 'ok' });
        await tick();
        t.ok('圧縮が終わると、たまった出来事を新しいターンで渡す', w.started.length === 1 && w.started[0].args.prompt.includes('post="p_2"'));
      }
    }

    // ================================================================ サーバー越し
    const boot = async (dataDir, env = {}) => {
      const server = await startServer({ env: { AGENT_HOST_BACKENDS: 'fake', AGENT_HOST_FAKE_USAGE: '1', AGENT_HOST_FAKE_SLOW_STEER: '1', ...env }, dataDir, timeoutMs: 60_000 });
      const c = await open({ port: server.port, token: server.token });
      servers.push(server); clients.push(c);
      const call = (op, args) => c.cmd('invoke', { op, args });
      return { server, c, call };
    };
    const dataDir = path.join(tmp, 'data');
    const { c, call, server } = await boot(dataDir);

    const owl = await call('bots.create', { name: 'Owl', icon: '🦉', backend: 'fake', persona: '調べ物が得意' });
    const lynx = await call('bots.create', { name: 'Lynx', icon: '🐺', backend: 'fake' });
    const dev = await call('channels.create', { name: 'dev', purpose: 'テスト' });
    const read = (channelId, threadId) => call('channels.read', { channelId, ...(threadId ? { threadId } : {}) });
    const botPost = (r, bot, state) => r.posts.filter((p) => p.turn?.botId === bot.id && (!state || p.state === state));
    const threadOf = async (root) => (await read(dev.id, root.id)).threads[0];
    const settled = (root) => until(async () => { const th = await threadOf(root); return th.state === 'idle' ? th : null; }, { label: 'thread idle' });
    const turnEnds = (sessionId, from = 0) => c.since(from).filter((e) => e.type === 'turnEnd' && e.sessionId === sessionId);
    const history = async (sessionId) => (await c.cmd('loadSession', { sessionId })).messages;

    // ---- A: チャンネルに @Owl やって → Owl の会話がターンを走らせ、返事がスレッドの投稿になる
    const mA = c.mark();
    const rootA = await call('channels.post', { channelId: dev.id, text: '@Owl echo:やった' });
    const a = await until(async () => { const r = await read(dev.id, rootA.id); const p = botPost(r, owl, 'done')[0]; return p ? { r, p } : null; }, { label: '返事の投稿' });
    t.ok('@Owl で Owl のターンが走り、返事がそのスレッドの投稿になる（根は @ した投稿）', a.p.text === 'やった' && a.p.threadId === rootA.id && a.p.author.kind === 'bot' && a.p.author.botId === owl.id && a.p.turn.botId === owl.id, JSON.stringify(a.p));
    const thA = await settled(rootA);
    const sessionA = thA.sessions[owl.id];
    t.ok('スレッドの状態: Owl の会話・起こした回数 1・止めた印なし・idle に戻る', typeof sessionA === 'string' && thA.calls === 1 && thA.stopped === null && thA.state === 'idle', JSON.stringify(thA));
    t.ok('スレッドの使用量に、Owl のターンの分が積まれる（入力 1000・出力 200・キャッシュ 900）', thA.tokens.input === 1000 && thA.tokens.output === 200 && thA.tokens.cached === 900, JSON.stringify(thA.tokens));
    const posts = c.since(mA).filter((e) => e.type === 'channelPost' && e.channelId === dev.id);
    t.ok('投稿は作業中（working）で作られ、同じ投稿を編集して done にする（全接続へ・sessionId なし）', posts.some((e) => e.op === 'add' && e.post.id === a.p.id && e.post.state === 'working' && e.post.text === PLACEHOLDER && !e.sessionId)
      && posts.some((e) => e.op === 'edit' && e.post.id === a.p.id && e.post.state === 'done') && botPost((await read(dev.id, rootA.id)), owl).length === 1);
    t.ok('thread の状態の変化も出来事で配る（working → idle）', c.since(mA).filter((e) => e.type === 'channelThread' && e.threadId === rootA.id).some((e) => e.thread.state === 'working')
      && c.since(mA).filter((e) => e.type === 'channelThread' && e.threadId === rootA.id).at(-1).thread.state === 'idle');
    const meta = (await c.cmd('listSessions')).find((s) => s.id === sessionA);
    t.ok('会話は bot の会話（kind: thread・スレッド・題「🦉 Owl · #dev › …」）で、Chats の一覧の行に bot が付く', meta?.bot?.botId === owl.id && meta.bot.kind === 'thread' && meta.bot.threadId === rootA.id && meta.bot.channelId === dev.id
      && meta.title.startsWith('🦉 Owl · #dev › '), JSON.stringify(meta));
    const histA = await history(sessionA);
    const evA = histA.filter((m) => m.kind === 'channelEvent');
    t.ok('会話の履歴の先頭は包み（channelEvent）で、人の吹き出しにならない。本文・投稿 id・チャンネルが入る', evA.some((m) => m.body.includes('echo:やった') && m.postId === rootA.id && m.threadId === rootA.id && m.channel === '#dev' && m.from === 'あなた')
      && !histA.some((m) => m.role === 'user' && !m.kind && String(m.text).includes('<pleiad-channel')), JSON.stringify(evA));
    t.ok('包みの channel-id は操作へ渡す id（channels.post の引数に使える）', (await fs.stat(dataDir)) && JSON.stringify(c.since(mA).filter((e) => e.type === 'channelEvent')).includes('"channel":"#dev"'));
    const inboxA = JSON.parse(await fs.readFile(path.join(dataDir, 'channels', 'inbox.json'), 'utf8'));
    t.ok('届ける前の出来事は inbox.json に残り、渡った印（sent）になる', inboxA.items.length === 1 && inboxA.items[0].status === 'sent' && inboxA.items[0].postId === rootA.id && inboxA.items[0].sessionId === sessionA);

    // ---- 同じスレッドで 2 回目: 同じ会話を使う・文脈は postCursor の後ろだけ
    const mA2 = c.mark();
    const reply = await call('channels.post', { channelId: dev.id, threadId: rootA.id, text: '@Owl echo:2 回目' });
    await until(async () => botPost(await read(dev.id, rootA.id), owl, 'done').length === 2, { label: '2 回目の返事' });
    const thA2 = await settled(rootA);
    t.ok('同じ bot・同じスレッドは同じ会話（ThreadState.sessions）。起こした回数は 2', thA2.sessions[owl.id] === sessionA && thA2.calls === 2 && turnEnds(sessionA, mA2).length === 1);
    const histA2 = (await history(sessionA)).filter((m) => m.kind === 'channelEvent');
    t.ok('2 回目の包みは新しい投稿だけ（自分のターンの投稿は文脈に入れない）', histA2.filter((m) => m.postId === reply.id).length === 1 && histA2.filter((m) => m.history).length === 0, JSON.stringify(histA2.map((m) => [m.postId, m.history])));

    // ---- B: Owl が返事の中で @Lynx と書くと Lynx が起きる（Lynx の会話は文脈を受け取る）。［止める］で止まる
    const mB = c.mark();
    // 人の投稿には @Lynx を書かない（@ は台本が @ に戻す）。Owl の返事の @Lynx だけで Lynx が起きることを確かめる
    const rootB = await call('channels.post', { channelId: dev.id, text: '@Owl steps:{"steps":[{"text":"\\u0040Lynx slow"}]}' });
    const b = await until(async () => {
      const r = await read(dev.id, rootB.id);
      const o = botPost(r, owl, 'done')[0], l = botPost(r, lynx, 'working')[0];
      return o && l ? { r, o, l } : null;
    }, { label: 'Owl の返事 → Lynx が作業中' });
    t.ok('Owl の返事は @Lynx を含み、Lynx が同じスレッドで作業中になる', b.o.text === '@Lynx slow' && b.o.mentions.includes(lynx.id) && b.l.threadId === rootB.id && b.l.author.botId === lynx.id);
    const thB = await threadOf(rootB);
    t.ok('スレッドは working で、Owl と Lynx の会話が別々。起こした回数は 2（呼び合いに上限は無い）', thB.state === 'working' && thB.sessions[owl.id] && thB.sessions[lynx.id] && thB.sessions[owl.id] !== thB.sessions[lynx.id] && thB.calls === 2, JSON.stringify(thB));
    const lynxEvents = await until(async () => { const rows = (await history(thB.sessions[lynx.id])).filter((m) => m.kind === 'channelEvent'); return rows.length >= 2 ? rows : null; }, { label: 'Lynx の包み' });
    t.ok('Lynx の最初の包みは、スレッドのそれまでの投稿（根の投稿。history: true）と、起こした Owl の返事（bot の投稿も届く）', lynxEvents.some((m) => m.history && m.body.includes('steps:') && m.body.includes('channel-id="'))
      && lynxEvents.some((m) => !m.history && m.from === '🦉 Owl (bot)' && m.body === '@Lynx slow'), JSON.stringify(lynxEvents.map((m) => [m.history, m.from, m.body.slice(0, 80)])));
    const mStop = c.mark();
    const stopped = await call('channels.stopThread', { channelId: dev.id, threadId: rootB.id });
    t.ok('［止める］は止めた主体（人）を残す', stopped.stopped?.by?.kind === 'human' && typeof stopped.stopped.at === 'number', JSON.stringify(stopped));
    const bStopped = await until(async () => {
      const r = await read(dev.id, rootB.id);
      const l = botPost(r, lynx)[0];
      return l?.state === 'stopped' && r.threads[0].state === 'idle' ? r : null;
    }, { label: 'Lynx が止まる' });
    t.ok('走っていた Lynx のターンが止まり、投稿は stopped・スレッドは idle', turnEnds(thB.sessions[lynx.id], mStop).length === 1 && botPost(bStopped, lynx)[0].state === 'stopped' && bStopped.threads[0].stopped.by.kind === 'human');
    const sys = bStopped.posts.find((p) => p.author.kind === 'system');
    t.ok('システムの投稿「<誰>が止めました」がスレッドに残る', sys?.text === 'あなた が止めました' && sys.threadId === rootB.id, JSON.stringify(sys));
    t.ok('止めた後は、bot の投稿の @ で起こさない（止めたスレッドは人が次に書くまで新しく起こさない）', await (async () => {
      await sleep(300);
      return botPost(await read(dev.id, rootB.id), owl).length === 1 && botPost(await read(dev.id, rootB.id), lynx).length === 1;
    })());
    // 人が書くと、また起こせる
    await call('channels.post', { channelId: dev.id, threadId: rootB.id, text: '@Owl echo:再開' });
    const resumed = await until(async () => { const r = await read(dev.id, rootB.id); return botPost(r, owl, 'done').length === 2 ? r : null; }, { label: '人が書いて再開' });
    t.ok('人が次に書くと止めた印が外れ、起こせる', resumed.threads[0].stopped === null && botPost(resumed, owl, 'done').at(-1).text === '再開');
    await settled(rootB);

    // ---- C: 同じ投稿で 2 体を起こし、［止める］で両方止まる
    const rootC = await call('channels.post', { channelId: dev.id, text: '@Owl @Lynx slow' });
    const c1 = await until(async () => { const r = await read(dev.id, rootC.id); return botPost(r, owl, 'working').length && botPost(r, lynx, 'working').length ? r : null; }, { label: '2 体が作業中' });
    t.ok('1 つの投稿の 2 つの @ で、2 体がそれぞれ別の会話で起きる', c1.threads[0].state === 'working' && c1.threads[0].calls === 2 && Object.keys(c1.threads[0].sessions).length === 2);
    const mC = c.mark();
    await call('channels.stopThread', { channelId: dev.id, threadId: rootC.id });
    const c2 = await until(async () => { const r = await read(dev.id, rootC.id); return botPost(r, owl, 'stopped').length && botPost(r, lynx, 'stopped').length && r.threads[0].state === 'idle' ? r : null; }, { label: '2 体が止まる' });
    t.ok('［止める］で走っていた 2 体のターンが両方止まる', turnEnds(c2.threads[0].sessions[owl.id], mC).length === 1 && turnEnds(c2.threads[0].sessions[lynx.id], mC).length === 1);

    // ---- D: 作業中に同じスレッドへ書き足すと、途中送信で渡る（Claude・Codex の形）
    const rootD = await call('channels.post', { channelId: dev.id, text: '@Owl slow' });
    const d1 = await until(async () => { const r = await read(dev.id, rootD.id); return botPost(r, owl, 'working').length ? r : null; }, { label: 'Owl が作業中' });
    const sessionD = d1.threads[0].sessions[owl.id];
    await until(async () => (await history(sessionD)).some((m) => m.kind === 'channelEvent'), { label: '最初の包みが渡る' });
    const mD = c.mark();
    const extra = await call('channels.post', { channelId: dev.id, threadId: rootD.id, text: 'ついでに README も' });
    const steered = await until(async () => (await history(sessionD)).find((m) => m.kind === 'channelEvent' && m.postId === extra.id), { label: '途中送信' });
    t.ok('@ の無い人の投稿は、作業中の bot が 1 体ならその会話へ書き足される（包みだけ。新しいターンは走らない）', steered.body === 'ついでに README も'
      && turnEnds(sessionD, mD).length === 0 && !(await history(sessionD)).some((m) => m.kind === 'contextNote' && m.body.includes('ついでに')), JSON.stringify(steered));
    t.ok('書き足しは会話の画面へも channelEvent で出る', c.since(mD).some((e) => e.type === 'channelEvent' && e.sessionId === sessionD && e.rows.some((r) => r.postId === extra.id)));
    const inboxD = JSON.parse(await fs.readFile(path.join(dataDir, 'channels', 'inbox.json'), 'utf8'));
    t.ok('渡した書き足しは sent（出来事の一覧に残る）', inboxD.items.find((i) => i.postId === extra.id)?.status === 'sent');
    await call('channels.stopThread', { channelId: dev.id, threadId: rootD.id });
    await settled(rootD);

    // ---- E: 暗黙では起こさない
    const rootE = await call('channels.post', { channelId: dev.id, text: '@Owl echo:E' });
    await until(async () => botPost(await read(dev.id, rootE.id), owl, 'done').length === 1, { label: 'E 返事' });
    await settled(rootE);
    const mE = c.mark();
    await call('channels.post', { channelId: dev.id, threadId: rootE.id, text: '誰にも宛てていない（作業中の bot も居ない）' });
    await call('channels.post', { channelId: dev.id, threadId: rootE.id, text: '@あなた へ' });
    await call('channels.post', { channelId: dev.id, text: '流れに書いただけ（@ なし）' });
    await call('channels.post', { channelId: dev.id, text: 'コードの中 `@Owl` と引用\n> @Lynx' });
    await call('channels.post', { channelId: dev.id, threadId: rootE.id, text: 'mail a@Owl.com' });
    await sleep(500);
    const eRead = await read(dev.id, rootE.id);
    t.ok('明示の @ が無ければ起こさない（人の名前・コード・引用・メールの形・流れへの @ なし投稿・作業中の bot が無いスレッド）', botPost(eRead, owl).length === 1 && botPost(eRead, lynx).length === 0
      && !c.since(mE).some((e) => e.type === 'turnEnd' && e.sessionId === eRead.threads[0].sessions[owl.id]) && (await read(dev.id)).posts.every((p) => !p.turn));
    // 自分への @ は数えない・bot の返事の @ は同じ規則（Owl が自分に @Owl と書いても起きない）
    const rootSelf = await call('channels.post', { channelId: dev.id, text: '@Owl echo:自分に @Owl と書く' });
    await until(async () => botPost(await read(dev.id, rootSelf.id), owl, 'done').length === 1, { label: '自分への @' });
    await sleep(500);
    t.ok('自分自身への @ は数えない（呼び合いの輪にならない）', botPost(await read(dev.id, rootSelf.id), owl).length === 1);

    // ---- F: DM（@ 不要・スレッドは作らない・会話は 1 本）
    const dm = await call('channels.get', { channelId: owl.dmChannelId });
    t.ok('bot の DM のチャンネルがある', dm.kind === 'dm' && dm.botId === owl.id);
    const mF = c.mark();
    await call('channels.post', { channelId: dm.id, text: 'echo:DM です' });
    const f = await until(async () => { const r = await read(dm.id); return botPost(r, owl, 'done')[0] ? r : null; }, { label: 'DM の返事' });
    t.ok('DM は @ なしで bot へ。返事は DM の流れ（threadId なし）に出る', botPost(f, owl, 'done')[0].text === 'DM です' && botPost(f, owl, 'done')[0].threadId === null);
    const owlNow = (await call('bots.get', { botId: owl.id }));
    const dmSession = owlNow.dmSessionId;
    t.ok('DM の会話は bot ごとに 1 本（Bot.dmSessionId・kind: dm）', typeof dmSession === 'string' && (await c.cmd('listSessions')).find((s) => s.id === dmSession)?.bot?.kind === 'dm');
    await call('channels.post', { channelId: dm.id, text: 'echo:もう 1 回' });
    await until(async () => botPost(await read(dm.id), owl, 'done').length === 2, { label: 'DM の 2 回目' });
    t.ok('2 回目も同じ会話', (await call('bots.get', { botId: owl.id })).dmSessionId === dmSession && turnEnds(dmSession, mF).length === 2);
    await call('channels.post', { channelId: dm.id, text: 'echo:@Lynx 起きて' });
    await until(async () => botPost(await read(dm.id), owl, 'done').length === 3, { label: 'DM の 3 回目' });
    await sleep(400);
    t.ok('DM の中の他の bot への @ は起こさない（DM は 1 対 1）', (await read(lynx.dmChannelId)).posts.length === 0 && !(await c.cmd('listSessions')).some((s) => s.bot?.botId === lynx.id && s.bot.kind === 'dm'));

    // ---- G: 末尾（記憶の核の写しは始まりだけ・毎ターン時刻・差分）と圧縮の後の取り直し
    await call('memory.write', { layer: 'user', text: 'PR は小さく、テストを先に書く', sources: [] });
    const rootG = await call('channels.post', { channelId: dev.id, text: '@Lynx notes:' });
    const g1 = await until(async () => { const r = await read(dev.id, rootG.id); return botPost(r, lynx, 'done')[0] ?? null; }, { label: 'G 1 回目' });
    const notes1 = JSON.parse(g1.text);
    t.ok('最初のターンの notes は、核の記憶の写し（<pleiad-memory-core>）と今回の末尾（<pleiad-turn-context>）', notes1.length === 2 && notes1[0].startsWith('<pleiad-memory-core>') && notes1[0].includes('PR は小さく') && notes1[1].startsWith('<pleiad-turn-context>'), g1.text);
    await settled(rootG);
    await call('channels.post', { channelId: dev.id, threadId: rootG.id, text: '@Lynx notes:' });
    const g2 = await until(async () => { const r = await read(dev.id, rootG.id); return botPost(r, lynx, 'done')[1] ?? null; }, { label: 'G 2 回目' });
    const notes2 = JSON.parse(g2.text);
    t.ok('2 回目は核の写しを繰り返さず、末尾（時刻）だけ。キャッシュの並び（人格・核・履歴・末尾）を壊さない', notes2.length === 1 && notes2[0].startsWith('<pleiad-turn-context>') && !notes2[0].includes('PR は小さく'), g2.text);
    await settled(rootG);
    await call('memory.write', { layer: 'user', text: '金曜に本番へ出さない', sources: [] });
    await call('channels.post', { channelId: dev.id, threadId: rootG.id, text: '@Lynx notes:' });
    const g3 = await until(async () => { const r = await read(dev.id, rootG.id); return botPost(r, lynx, 'done')[2] ?? null; }, { label: 'G 3 回目' });
    t.ok('記憶の差分（前のターンの後に増えたもの）は末尾に出る', JSON.parse(g3.text).length === 1 && JSON.parse(g3.text)[0].includes('金曜に本番へ出さない'), g3.text);
    await settled(rootG);
    const sessionG = (await threadOf(rootG)).sessions[lynx.id];
    await call('channels.post', { channelId: dev.id, threadId: rootG.id, text: '@Lynx compact' });
    await until(async () => botPost(await read(dev.id, rootG.id), lynx, 'done').length === 4, { label: 'G 圧縮' });
    await settled(rootG);
    t.ok('圧縮が終わると核の写しを取り直す（snapshotDue）', (await c.cmd('listSessions')) && await (async () => {
      await call('channels.post', { channelId: dev.id, threadId: rootG.id, text: '@Lynx notes:' });
      const g5 = await until(async () => botPost(await read(dev.id, rootG.id), lynx, 'done')[4] ?? null, { label: 'G 5 回目' });
      const n = JSON.parse(g5.text);
      return n.length === 2 && n[0].startsWith('<pleiad-memory-core>') && n[0].includes('PR は小さく') && n[0].includes('金曜に本番へ出さない');
    })());
    t.ok('人格は並びの最後に毎ターン同じ（変わるのは末尾だけ）', await (async () => {
      await settled(rootG);
      await call('channels.post', { channelId: dev.id, threadId: rootG.id, text: '@Lynx instructions:' });
      const a1 = await until(async () => botPost(await read(dev.id, rootG.id), lynx, 'done')[5] ?? null, { label: '人格 1' });
      await settled(rootG);
      await call('channels.post', { channelId: dev.id, threadId: rootG.id, text: '@Lynx instructions:' });
      const a2 = await until(async () => botPost(await read(dev.id, rootG.id), lynx, 'done')[6] ?? null, { label: '人格 2' });
      return a1.text === a2.text && a1.text.includes('Lynx');
    })());
    void sessionG;

    // ---- H: 途中送信できないとき（Antigravity と同じ形。ここでは承認待ちの間）はたまり、ターンの終わりにまとめて新しいターンで渡る
    const rootH = await call('channels.post', { channelId: dev.id, text: '@Owl ask' });
    const ask = await c.waitFor((e) => e.type === 'permission' && e.sessionId && e.sessionId !== sessionA, { from: c.mark() - 1, ms: 20_000 }).catch(() => null);
    t.ok('承認待ちが出る（bot の会話の承認は普通の承認カード。Chats からもスレッドからも同じ resolvePermission）', ask?.toolName === 'fake_write', JSON.stringify(ask));
    const hWait = await until(async () => { const r = await read(dev.id, rootH.id); return botPost(r, owl, 'waiting').length && r.threads[0].state === 'waiting' ? r : null; }, { label: '承認待ちの状態' });
    t.ok('承認待ちの間は、ターンの投稿もスレッドも waiting', hWait.threads[0].state === 'waiting');
    const sessionH = hWait.threads[0].sessions[owl.id];
    const lst = (await c.cmd('listSessions')).find((s) => s.id === sessionH);
    const running = await c.cmd('running');
    t.ok('Chats には承認待ちのときだけ出る材料: 一覧の行に bot、running の承認待ちにその会話', lst.bot.botId === owl.id && running.permissions.some((p) => p.sessionId === sessionH), JSON.stringify(running.permissions));
    const queued = await call('channels.post', { channelId: dev.id, threadId: rootH.id, text: 'echo:たまった投稿' });
    await sleep(500);
    const pend = JSON.parse(await fs.readFile(path.join(dataDir, 'channels', 'inbox.json'), 'utf8')).items.filter((i) => i.sessionId === sessionH);
    t.ok('途中送信できない間は pending のまま（新しいターンは走らない）', pend.some((i) => i.postId === queued.id && i.status === 'pending') && turnEnds(sessionH).length === 0);
    await c.cmd('resolvePermission', { id: ask.id, allow: true });
    const h2 = await until(async () => { const r = await read(dev.id, rootH.id); return botPost(r, owl, 'done').length === 2 && r.threads[0].state === 'idle' ? r : null; }, { label: 'ターンの終わりにまとめて渡る' });
    t.ok('ターンが終わると、たまった投稿が新しいターンで渡り、返事が出る', botPost(h2, owl, 'done')[0].text.startsWith('許可された') && botPost(h2, owl, 'done')[1].text === 'たまった投稿' && turnEnds(sessionH).length === 2);
    t.ok('渡ったら sent', JSON.parse(await fs.readFile(path.join(dataDir, 'channels', 'inbox.json'), 'utf8')).items.filter((i) => i.sessionId === sessionH).every((i) => i.status === 'sent'));

    // ---- I: 失敗は投稿を failed にしてスレッドを failed に
    const rootI = await call('channels.post', { channelId: dev.id, text: '@Owl fail' });
    const i1 = await until(async () => { const r = await read(dev.id, rootI.id); return botPost(r, owl, 'failed').length && r.threads[0].state === 'failed' ? r : null; }, { label: '失敗' });
    t.ok('ターンが失敗すると、投稿は failed（理由つき）・スレッドは failed', botPost(i1, owl, 'failed')[0].text.includes('fake: failure') && i1.threads[0].state === 'failed', JSON.stringify(botPost(i1, owl)));

    // ================================================================ 再起動での戻し
    // J: 承認待ちのまま落とす → 作業中の印は stopped に・たまっていた出来事は起動後に配り直される
    const rootJ = await call('channels.post', { channelId: dev.id, text: '@Owl ask' });
    const askJ = await c.waitFor((e) => e.type === 'permission', { from: c.mark(), ms: 20_000 }).catch(() => null);
    const jRead = await until(async () => { const r = await read(dev.id, rootJ.id); return botPost(r, owl, 'waiting').length ? r : null; }, { label: 'J 承認待ち' });
    const pendingJ = await call('channels.post', { channelId: dev.id, threadId: rootJ.id, text: 'echo:落とす前にたまった投稿' });
    await until(async () => JSON.parse(await fs.readFile(path.join(dataDir, 'channels', 'inbox.json'), 'utf8')).items.some((i) => i.postId === pendingJ.id && i.status === 'pending'), { label: 'J pending' });
    void askJ;
    c.terminate();
    await server.stop();
    const second = await boot(dataDir);
    const j2 = await until(async () => {
      const r = await second.call('channels.read', { channelId: dev.id, threadId: rootJ.id });
      const posts = r.posts.filter((p) => p.turn?.botId === owl.id);
      return posts.some((p) => p.text === '落とす前にたまった投稿' && p.state === 'done') ? { r, posts } : null;
    }, { label: '再起動後に配り直す' });
    t.ok('再起動: 落ちたときの作業中の印は stopped になり、たまっていた pending の出来事は新しいターンで配り直される', j2.posts.some((p) => p.id === jRead.posts.find((x) => x.turn?.botId === owl.id).id && p.state === 'stopped')
      && j2.r.threads[0].state === 'idle', JSON.stringify(j2.posts.map((p) => [p.state, p.text])));
    const inboxJ = JSON.parse(await fs.readFile(path.join(dataDir, 'channels', 'inbox.json'), 'utf8')).items.find((i) => i.postId === pendingJ.id);
    t.ok('配り直したものは sent。結果不明（delivering で落ちたもの）は送り直さない', inboxJ.status === 'sent');
    t.ok('サーバーのログに例外が出ていない', !/Unhandled|TypeError|ReferenceError/.test(`${server.tail(80)}\n${second.server.tail(80)}`), `${server.tail(30)}\n${second.server.tail(30)}`);
  } finally {
    for (const c of clients) c.close();
    for (const s of servers) await s.stop().catch(() => {});
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}
