// bot を起こす・配る（S4。ADR 0109・0108、docs/channels.md「起こし方」）。fake バックエンドのサーバー越しに通す。LLM もネットワークも使わない。
//   「チャンネルに @Owl やって」→ Owl の会話がターンを走らせ、返事がスレッドの投稿になる → Owl が返事で @Lynx と書くと Lynx が起きる → ［止める］で止まる。
//   途中送信（Claude・Codex の形）と、途中送信できない形（Antigravity と同じ。承認待ちの間）のたまった出来事・DM・暗黙では起こさない・再起動での戻し。
//   あわせて inbox.json の保存（状態・壊れたファイル・古いものの整理）を、サーバー無しで確かめる。
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../lib/server.mjs';
import { open, sleep } from '../lib/ws-client.mjs';
import { createInboxStore } from '../../core/bots/inbox.mjs';
import { createDispatcher, PLACEHOLDER, PROGRESS_MIN_CHARS, progressBody } from '../../core/bots/dispatch.mjs';

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
      const world = (steerKind, { realStart = false, more = false, modes = null } = {}) => {
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
            get: async (c, th) => structuredClone(threads[`${c}/${th}`] ?? null), list: async (c) => structuredClone(Object.values(threads).filter((x) => !c || x.channelId === c)),
            update: async (c, th, patch) => {
              const cur = (threads[`${c}/${th}`] ??= { channelId: c, threadId: th, sessions: {}, state: 'idle', tokens: { input: 0, output: 0, cached: 0 }, calls: 0, stopped: null });
              const next = typeof patch === 'function' ? patch(structuredClone(cur)) : patch;
              Object.assign(cur, next);
              return structuredClone(cur);
            },
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
        const BOT_LIST = more ? [{ id: 'b_1', name: 'Owl', icon: '🦉' }, { id: 'b_2', name: 'Lynx', icon: '🐺' }, { id: 'b_3', name: 'Fox', icon: '🦊' }] : [{ id: 'b_1', name: 'Owl', icon: '🦉' }];
        const bots = {
          get: async ({ botId }) => BOT_LIST.find((b) => b.id === botId) ?? null, list: async () => BOT_LIST,
          ...(modes ? { approvalOf: async ({ botId }) => { const b = BOT_LIST.find((x) => x.id === botId); const m = modes[botId]; return b && m ? { ...b, mode: m.id, label: m.label, entry: m } : null; },
            createSession: async ({ botId, threadId }) => { const sessionId = `s_new_${botId}`; sessions[sessionId] = { bot: { botId, kind: 'thread', channelId: 'c_1', threadId, memRev: 0, snapshotDue: false, delivered: [], postCursor: null } }; return { sessionId }; } } : {}),
        };
        const memory = { turnContext: async () => ({ notes: [], memRev: 0, delivered: [], snapshotDue: false }) };
        const d = createDispatcher({ channels, bots, memory, host });
        dRef = d;
        return { d, posts, threads, sessions, steers, emitted, started, aborted, turn, turns, control, channel, host, setAccept: (f) => { accept = f; } };
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

    // ================================================================ 独立レビューの指摘（S-2・S-3・F-1・F-2・S-10）。world は上の「途中送信の形ごとの扱い」の道具を使う
    {
      const ASK = { id: 'default', label: '都度確認', scope: 'workspace', autonomy: 'ask' };
      const FULL = { id: 'bypass', label: '全部自動', scope: 'full', autonomy: 'never' };
      const botPost = (id, mentions, over = {}) => ({ id, channelId: 'c_1', threadId: 'p_root', author: { kind: 'bot', botId: 'b_1' }, text: '@Lynx やって', mentions, state: 'done', at: 5000, reactions: {}, ...over });
      const sysTexts = (w) => w.posts.filter((p) => p.turn === undefined && /起こしていません/.test(p.text));
      const startedFor = (w, sessionId) => w.started.some((s) => s.args.sessionId === sessionId);
      const tick = () => sleep(80);

      // S-2: bot の返事の @ は、動くモードが自分より強い bot を起こさない（起こさなかったことをスレッドで知らせる）。同じか弱い bot は起こす
      {
        const w = world('plain', { more: true, modes: { b_1: ASK, b_2: FULL, b_3: ASK } });
        w.turns.delete('s1');
        w.posts.push(botPost('p_r1', ['b_2']));
        await w.d.onPosted(w.posts.at(-1), w.channel);
        await tick();
        t.ok('S-2: bot の返事が全部自動の bot を @ しても起こさない（出来事も作らない）。スレッドに「起こしていません」の知らせが残る', (await w.d.inbox.list({})).length === 0 && !startedFor(w, 's_new_b_2') && sysTexts(w).length === 1
          && sysTexts(w)[0].text.includes('Lynx') && sysTexts(w)[0].text.includes('全部自動') && sysTexts(w)[0].text.includes('Owl') && sysTexts(w)[0].text.includes('人が @ すると'), JSON.stringify(w.posts.map((p) => p.text)));
        w.posts.push(botPost('p_r2', ['b_3'], { text: '@Fox やって' }));
        await w.d.onPosted(w.posts.at(-1), w.channel);
        await tick();
        t.ok('S-2: 同じ強さの bot への @ は、これまでどおり起こす（呼び合いに上限は置かない）', startedFor(w, 's_new_b_3') && (await w.d.inbox.list({})).some((i) => i.botId === 'b_3' && i.postId === 'p_r2'));
        const human = world('plain', { more: true, modes: { b_1: ASK, b_2: FULL } });
        human.turns.delete('s1');
        human.posts.push(botPost('p_h1', ['b_2'], { author: { kind: 'human' }, text: '@Lynx 人が書く' }));
        await human.d.onPosted(human.posts.at(-1), human.channel);
        await tick();
        t.ok('S-2: 人の投稿の @ は、強い bot でも確認なしで起こす', startedFor(human, 's_new_b_2') && sysTexts(human).length === 0);
        const checked = world('plain', { more: true, modes: { b_1: ASK, b_2: FULL } });
        checked.turns.delete('s1');
        checked.posts.push(botPost('p_c1', ['b_2']));
        await checked.d.onPosted(checked.posts.at(-1), checked.channel, { hold: ['b_2'], checked: true });
        await tick();
        t.ok('S-2: ops が確認済み（hold・checked）の投稿は、hold の bot を起こさず、知らせの投稿も重ねない（承認のカードに回っている）', (await checked.d.inbox.list({})).length === 0 && sysTexts(checked).length === 0);
        const passed = world('plain', { more: true, modes: { b_1: ASK, b_2: FULL } });
        passed.turns.delete('s1');
        passed.posts.push(botPost('p_c2', ['b_2']));
        await passed.d.onPosted(passed.posts.at(-1), passed.channel, { hold: [], checked: true });
        await tick();
        t.ok('S-2: ops が確認済みで hold が空なら（強さは確かめた）、そのまま起こす', startedFor(passed, 's_new_b_2'));
      }

      // channels.wake の本体（dispatch.wakePost）: @ されている bot だけ・止めたスレッドは起こさない
      {
        const w = world('plain', { more: true, modes: { b_1: ASK, b_2: FULL } });
        w.turns.delete('s1');
        w.posts.push(botPost('p_w1', ['b_2']));
        const woken = await w.d.wakePost({ channelId: 'c_1', postId: 'p_w1', botId: 'b_2' });
        await tick();
        t.ok('wakePost: その投稿が @ している bot を起こす（承認のあと）', woken.woken === true && startedFor(w, 's_new_b_2'));
        t.ok('wakePost: @ していない bot・無い投稿は起こさない（notMentioned・notFound）', (await w.d.wakePost({ channelId: 'c_1', postId: 'p_w1', botId: 'b_3' })).reason === 'notMentioned' && (await w.d.wakePost({ channelId: 'c_1', postId: 'p_none', botId: 'b_2' })).reason === 'notFound');
        w.threads['c_1/p_root'].stopped = { by: { kind: 'human' }, at: 1 };
        t.ok('wakePost: 止めたスレッドは、承認されても起こさない（stopped）', (await w.d.wakePost({ channelId: 'c_1', postId: 'p_w1', botId: 'b_2' })).reason === 'stopped');
      }

      // S-3(b): 起こして新しくできたスレッドの origin。［止める］は origin で結ばれた派生のスレッド（孫も）にも届く
      {
        const w = world('plain', { more: true, modes: { b_1: ASK, b_2: ASK, b_3: ASK } });
        w.turns.delete('s1');
        const flow = botPost('p_flow', ['b_2'], { threadId: null, text: '@Lynx 流れへ' });
        w.posts.push(flow);
        await w.d.onPosted(flow, w.channel, { checked: true, hold: [], origin: { channelId: 'c_1', threadId: 'p_root' } });
        await tick();
        t.ok('S-3(b): bot が自分のスレッドから流れへ書いた @ で新しくできたスレッドに、起こした元（origin）が残る', w.threads['c_1/p_flow']?.origin?.threadId === 'p_root' && w.threads['c_1/p_flow'].origin.channelId === 'c_1' && w.threads['c_1/p_flow'].sessions.b_2 === 's_new_b_2', JSON.stringify(w.threads['c_1/p_flow']));
        const plainFlow = botPost('p_flow2', ['b_2'], { threadId: null, author: { kind: 'human' }, text: '@Lynx 人が流れへ' });
        w.posts.push(plainFlow);
        await w.d.onPosted(plainFlow, w.channel);
        await tick();
        t.ok('S-3(b): origin が無い投稿（人の @ など）で作ったスレッドには origin を付けない', w.threads['c_1/p_flow2'] && !('origin' in w.threads['c_1/p_flow2']));

        // 3 世代と無関係の 1 つ: p_root（s1）→ p_t2（s2）→ p_t3（s3）、p_other（s4）
        const x = world('plain', { more: true, modes: { b_1: ASK, b_2: ASK, b_3: ASK } });
        const mkThread = (id, sessionId, botId, origin) => { x.threads[`c_1/${id}`] = { channelId: 'c_1', threadId: id, sessions: { [botId]: sessionId }, state: 'working', tokens: { input: 0, output: 0, cached: 0 }, calls: 1, stopped: null, ...(origin ? { origin } : {}) }; };
        mkThread('p_t2', 's2', 'b_2', { channelId: 'c_1', threadId: 'p_root' });
        mkThread('p_t3', 's3', 'b_3', { channelId: 'c_1', threadId: 'p_t2' });
        mkThread('p_other', 's4', 'b_1', null);
        for (const [sessionId, botId, threadId] of [['s2', 'b_2', 'p_t2'], ['s3', 'b_3', 'p_t3'], ['s4', 'b_1', 'p_other']]) {
          x.sessions[sessionId] = { bot: { botId, kind: 'thread', channelId: 'c_1', threadId, memRev: 0, snapshotDue: false, delivered: [], postCursor: null } };
          x.posts.push({ id: threadId, channelId: 'c_1', threadId: null, author: { kind: 'human' }, text: '根', mentions: [], at: 100, reactions: {} });
        }
        await x.d.turnExtras(x.turn);
        for (const sessionId of ['s2', 's3', 's4']) await x.d.turnExtras({ info: { sessionId }, agentLocale: 'ja', stream: {}, control: {}, ac: { signal: { aborted: false } }, outcome: null, usage: {} });
        const by = { kind: 'human' };
        await x.d.stopThread({ channelId: 'c_1', threadId: 'p_root' }, by);
        const abortedIds = x.aborted.map((a) => a.sessionId).sort().join();
        t.ok('S-3(b): ［止める］は元のスレッドと、origin で結ばれた派生のスレッド（孫も）の走っているターンを止める。無関係のスレッドは止めない', abortedIds === 's1,s2,s3', abortedIds);
        t.ok('S-3(b): 派生のスレッドにも止めた主体の印（stopped）が残り、人が書くまで起こさない。無関係のスレッドには付かない', x.threads['c_1/p_t2'].stopped?.by.kind === 'human' && x.threads['c_1/p_t3'].stopped?.by.kind === 'human' && x.threads['c_1/p_other'].stopped === null);
        t.ok('S-3(b): 派生のスレッドにも「止めました」の投稿が残る', ['p_t2', 'p_t3'].every((id) => x.posts.some((p) => p.threadId === id && /止めました|が止めました/.test(p.text))));
      }

      // F-1: 始められなかったターンの後に、その間にたまった出来事（途中送信できず pending のまま）を取り残さない
      {
        const w = world('plain');
        w.turns.delete('s1');
        let reject;
        const calls = [];
        w.host.runTurn = (args) => { calls.push(args); return calls.length === 1 ? new Promise((_, r) => { reject = r; }) : Promise.resolve('cancelled'); };
        await w.d.wake({ botId: 'b_1', channel: w.channel, threadId: 'p_root', post: w.posts[1] });
        await w.d.wake({ botId: 'b_1', channel: w.channel, threadId: 'p_root', post: w.posts[2] });   // 始めている間に 2 通目: 途中送信できず pending のまま
        t.ok('F-1: 前提: 1 通目が始まる前に 2 通目は pending（まだ配れない）', calls.length === 1 && (await w.d.inbox.list({ status: 'pending' })).some((i) => i.postId === 'p_3'));
        reject(new Error('cwd missing'));
        await sleep(3600);
        t.ok('F-1: 始められなかった後、たまっていた出来事は配り直される（次の @ まで取り残さない）。失敗した 1 通目は結果不明のまま送り直さない', calls.length === 2 && calls[1].prompt.includes('post="p_3"')
          && (await w.d.inbox.list({})).find((i) => i.postId === 'p_2')?.status === 'unknown', JSON.stringify([calls.length, await w.d.inbox.list({})]));
      }

      // F-2: ターンの記録ができた後に始まらず戻された（requeue）とき、delivering のまま固まらず、記録を片付けて配り直す
      {
        const w = world('plain');
        w.turns.delete('s1');
        const calls = [];
        w.host.runTurn = async (args) => {
          calls.push(args);
          await w.d.turnExtras({ info: { sessionId: args.sessionId }, agentLocale: 'ja', stream: {} });
          return calls.length === 1 ? 'requeue' : 'ok';
        };
        await w.d.wake({ botId: 'b_1', channel: w.channel, threadId: 'p_root', post: w.posts[1] });
        await tick();
        const turnPosts = w.posts.filter((p) => p.turn);
        t.ok('F-2: turnExtras の後の requeue でも、出来事は delivering のままにならず pending に戻り、作業中の記録・投稿は片付く', (await w.d.inbox.list({})).find((i) => i.postId === 'p_2')?.status === 'pending' && w.d.activeCount() === 0
          && turnPosts.length === 1 && turnPosts[0].state === 'stopped', JSON.stringify([await w.d.inbox.list({}), w.d.activeCount(), turnPosts.map((p) => p.state)]));
        await sleep(3500);
        t.ok('F-2: 配り直しで新しいターンが始まり、同じ出来事を渡す', calls.length === 2 && calls[1].prompt.includes('post="p_2"'), String(calls.length));
        // 終わりが届かなかった記録（次のターンの turnExtras が片付ける）の途中送信（渡った合図待ち）も、delivering のまま固まらず、次のターンで送り直す
        const c = world('confirm');
        await c.d.turnExtras(c.turn);
        await c.d.onPosted(c.posts[1], c.channel);
        const before = (await c.d.inbox.list({})).find((i) => i.postId === 'p_2')?.status;
        await c.d.turnExtras(c.turn);   // 前のターンの終わりが届かないまま、新しいターンが始まった
        t.ok('F-2: 終わりが届かなかった記録の、合図待ちの途中送信は、次のターンの始まりで pending に戻る（delivering のまま固まらない）', before === 'delivering' && (await c.d.inbox.list({})).find((i) => i.postId === 'p_2')?.status === 'pending' && c.d.activeCount() === 1);
      }

      // L-1: アーカイブされたチャンネルの出来事は配らない（ターンの投稿だけ作れずに走らない）
      {
        const w = world('plain');
        w.turns.delete('s1');
        w.channel.archivedAt = 5000;
        await w.d.wake({ botId: 'b_1', channel: w.channel, threadId: 'p_root', post: w.posts[1] });
        await tick();
        t.ok('L-1: アーカイブされたチャンネルの出来事は、ターンを始めずに捨てる', w.started.length === 0 && (await w.d.inbox.list({})).length === 0);
      }

      // F-3: commit の sidecar の書き込みが終わる前に次のターンが始まっても、古い postCursor を読んで同じ文脈を渡し直さない
      {
        const w = world('plain', { realStart: true });
        w.turns.delete('s1');
        const original = w.host.store.setSessionData;
        w.host.store.setSessionData = async (...a) => { await sleep(200); return original(...a); };   // 書き込みが遅い
        await w.d.wake({ botId: 'b_1', channel: w.channel, threadId: 'p_root', post: w.posts[1] });
        await tick();                                                                                  // ターンの始まり（turnExtras）まで
        w.d.onTurnEvent({ info: { sessionId: 's1' } }, { type: 'text.delta', text: 'x' });            // 「渡った」→ commit（postCursor を p_2 に進める書き込みが走る）
        await w.d.onTurnEnd({ info: { sessionId: 's1' }, usage: {}, agentLocale: 'ja' }, { outcome: 'ok' });
        await w.d.wake({ botId: 'b_1', channel: w.channel, threadId: 'p_root', post: w.posts[2] });  // 書き込みの途中で次の起こし
        await tick();
        const second = w.started.at(-1)?.args.prompt ?? '';
        t.ok('F-3: 次のターンは、commit が進めた postCursor の後ろだけを渡す（前の起こしの投稿を文脈として渡し直さない）', w.started.length === 2 && second.includes('post="p_3"') && !second.includes('post="p_2"'), second);
      }

      // S-10: トークンの足し算を、毎秒の書き換えのたびにしない（数秒に 1 回・ターンの終わりには必ず）
      {
        let clock = 1_000_000;
        const w = world('plain');
        w.turns.delete('s1');
        const d = createDispatcher({ channels: w.d.channels, bots: w.d.bots, memory: w.d.memory, host: w.d.host, now: () => clock });
        let tokenWrites = 0;
        const base = w.d.channels.threads.update;
        w.d.channels.threads.update = async (c, th, patch) => { if (typeof patch === 'function' && 'tokens' in patch({ tokens: { input: 0, output: 0, cached: 0 } })) tokenWrites++; return base(c, th, patch); };
        const turn = { info: { sessionId: 's1' }, agentLocale: 'ja', stream: {}, control: {}, ac: { signal: { aborted: false } }, outcome: null, usage: {} };
        await d.turnExtras(turn);
        for (let i = 1; i <= 8; i++) {
          clock += 1100;
          d.onTurnEvent(turn, { type: 'usage', inputTokens: i * 100, outputTokens: i * 10, cachedTokens: i * 50 });
          d.onTurnEvent(turn, { type: 'text.delta', text: `${i}` });
          await sleep(40);
        }
        const during = tokenWrites;
        t.ok('S-10: 8 秒の間に毎秒書き換えても、トークンの足し算は数秒に 1 回（8 回ではなく 2 回以下）', during >= 1 && during <= 2, String(during));
        w.turns.delete('s1');
        turn.usage = { inputTokens: 900, outputTokens: 90, cachedTokens: 450 };
        await d.onTurnEnd(turn, { outcome: 'ok' });
        const th = w.threads['c_1/p_root'];
        t.ok('S-10: ターンの終わりには残りを必ず足す（途中の分と合わせて、使った分に一致する）', tokenWrites === during + 1 && th.tokens.input === 900 && th.tokens.output === 90 && th.tokens.cached === 450, JSON.stringify(th.tokens));
      }
      // E1-3: 進捗の本文に、断片・短い独り言・道具を呼ぶ前の独り言を出さない（1 秒おきの更新が文の途中に当たって「a」「12」が一瞬出ていた）。最終の返事は今のまま
      {
        const none = (...xs) => xs.every((x) => progressBody({ cur: x, last: '' }) === '' && progressBody({ cur: '', last: x }) === '');
        const sentence = 'この README の最初の行を読んで、そこに書かれている内容を順番に確かめます。';
        t.ok('E1-3: 前提: 例の文は出す長さ（PROGRESS_MIN_CHARS）以上', [...sentence].length >= PROGRESS_MIN_CHARS, String([...sentence].length));
        t.ok('E1-3: progressBody は 1 文字の断片・短い文・英語の短い独り言を出さない', none('a', '12', '0', 'Tool', 'Owl として', '短い独り言。', 'Parameter name is probably `op`.', 'Args go at top level probably.'));
        t.ok('E1-3: 書きかけの文は出さず、文の切れ目（。！？ . ! ? 改行）までを出す。切れ目が無ければ出さない',
          progressBody({ cur: `${sentence}それから`, last: '' }) === sentence && progressBody({ cur: sentence.slice(0, -1), last: '' }) === ''
          && progressBody({ cur: 'Alpha beta gamma delta epsilon zeta eta theta iota kappa. Lam', last: '' }) === 'Alpha beta gamma delta epsilon zeta eta theta iota kappa.'
          && progressBody({ cur: `${sentence.slice(0, -1)}\nそして`, last: '' }) === sentence.slice(0, -1));
        t.ok('E1-3: 書き終えた文章（last）は十分に長ければ出す。開いている文章に切れ目が無いあいだは last を出す', progressBody({ cur: 'ab', last: sentence }) === sentence && progressBody({ cur: '', last: 'ab' }) === '');

        // 投稿の本文の移り変わり: 断片は「…」のまま → 長い独り言は文の切れ目まで → 道具を呼ぶと「…」に戻る → 最終の返事を流す間は文の切れ目まで → 終わりは lastReply
        let clock = 7_000_000;
        const w = world('plain');
        w.turns.delete('s1');
        const d = createDispatcher({ channels: w.d.channels, bots: w.d.bots, memory: w.d.memory, host: w.d.host, now: () => clock });
        const turn = { info: { sessionId: 's1' }, agentLocale: 'ja', stream: {}, control: {}, ac: { signal: { aborted: false } }, outcome: null, usage: {} };
        await d.turnExtras(turn);
        const turnPost = () => w.posts.find((p) => p.turn);
        const feed = async (event) => { clock += 1100; d.onTurnEvent(turn, event); await sleep(70); return turnPost().text; };
        const fragments = [await feed({ type: 'text.delta', text: 'a' }), await feed({ type: 'text.delta', text: 'bc' }), await feed({ type: 'text.delta', text: '12' }), await feed({ type: 'text.end' })];
        t.ok('E1-3: 書き始めの断片（a・abc・abc12）と、短い文章が終わった後も、投稿は「…」のまま', fragments.every((x) => x === PLACEHOLDER), JSON.stringify(fragments));
        const narration = 'まず README を開いて、最初の行がどう書かれているかを、周りの行の書き方と合わせて確かめます。';
        t.ok('E1-3: 長い文章は文の切れ目までが投稿に出る（書きかけの「そして」は出さない）', await feed({ type: 'text.delta', text: `${narration}そして` }) === narration);
        t.ok('E1-3: 道具を呼ぶと、その前の独り言は引っ込めて投稿は「…」に戻る', await feed({ type: 'tool.start', id: 'x', name: 'Read', input: {} }) === PLACEHOLDER);
        t.ok('E1-3: 道具の後の短い断片も出さない', await feed({ type: 'text.delta', text: '12' }) === PLACEHOLDER);
        await feed({ type: 'text.end' });
        const answer = '一行目は中央寄せの画像タグで、そこから先にプロジェクトの紹介と使い方の説明が順に続いています。';
        t.ok('E1-3: 最終の返事を流している間は、文の切れ目まで出す', await feed({ type: 'text.delta', text: `${answer}詳しくは` }) === answer);
        w.turns.delete('s1');
        await d.onTurnEnd(turn, { outcome: 'ok' });
        t.ok('E1-3: 終わりは今までどおり最終の返事（lastReply）に置き換わり、done になる', turnPost().text === '終わり' && turnPost().state === 'done', JSON.stringify(turnPost()));

        // bot 自身が書いた本文（進捗のチェックリスト）は、独り言を引っ込めるときにも上書きしない
        const own = world('plain');
        own.turns.delete('s1');
        const od = createDispatcher({ channels: own.d.channels, bots: own.d.bots, memory: own.d.memory, host: own.d.host, now: () => clock });
        const oturn = { info: { sessionId: 's1' }, agentLocale: 'ja', stream: {}, control: {}, ac: { signal: { aborted: false } }, outcome: null, usage: {} };
        await od.turnExtras(oturn);
        const feedOwn = async (event) => { clock += 1100; od.onTurnEvent(oturn, event); await sleep(70); return own.posts.find((p) => p.turn).text; };
        await feedOwn({ type: 'text.delta', text: `${narration}そして` });
        own.posts.find((p) => p.turn).text = '- [x] 手順 1\n- [ ] 手順 2';   // bot が channels.post で書いた進捗
        t.ok('E1-3: bot が書いたチェックリストは、道具を呼んでも「…」に戻さない', await feedOwn({ type: 'tool.start', id: 'y', name: 'Read', input: {} }) === '- [x] 手順 1\n- [ ] 手順 2');
      }

      // E1-4: 呼ばれて答えたら、返事を呼んだ bot の会話へ「返事」として届けて起こす（暗黙のメンションではなく、呼んだ相手が答えたこと）
      {
        const modes = { b_1: ASK, b_2: ASK };
        const mkWorld = () => {
          const w = world('plain', { more: true, modes, realStart: true });
          w.turns.delete('s1');
          // 実物の channels に合わせる: sessions は足し算・投稿の発言者は渡された author・本文の @ から mentions
          const ch = w.d.channels;
          const update = ch.threads.update;
          ch.threads.update = async (c, th, patch) => (patch && typeof patch === 'object'
            ? update(c, th, (cur) => ({ ...patch, ...(patch.sessions ? { sessions: { ...cur.sessions, ...patch.sessions } } : {}) })) : update(c, th, patch));
          const post = ch.post, edit = ch.edit;
          const atOf = (text) => [...(text.includes('@Owl') ? ['b_1'] : []), ...(text.includes('@Lynx') ? ['b_2'] : [])];
          ch.post = async (a, author) => { const made = await post(a, author); const p = w.posts.find((x) => x.id === made.id); if (author?.kind === 'bot') p.author = author; return structuredClone(p); };
          ch.edit = async (a, author) => { const saved = await edit(a, author); const p = w.posts.find((x) => x.id === a.postId); if (p) p.mentions = atOf(p.text); return structuredClone(p ?? saved); };
          return w;
        };
        const turnOf = (sessionId) => ({ info: { sessionId }, agentLocale: 'ja', stream: {}, control: {}, ac: { signal: { aborted: false } }, outcome: null, usage: {} });
        // B（Lynx）のターンを、返事 text で ok として終える
        const finish = async (w, sessionId, text, outcome = 'ok') => {
          w.host.lastReply = async () => text;
          const turn = turnOf(sessionId);
          w.d.onTurnEvent(turn, { type: 'text.delta', text });
          await w.d.onTurnEnd(turn, { outcome });
          await tick();
        };
        const callOwl = (w, text = '@Lynx 調べて') => { const p = botPost('p_a1', ['b_2'], { text }); w.posts.push(p); return w.d.onPosted(p, w.channel); };
        const itemsOf = async (w, sessionId) => (await w.d.inbox.list({ sessionId }));

        // Owl の返事の @Lynx で Lynx が起き、Lynx のターンが ok で終わると、その返事が Owl の会話へ reply の包みで届いて Owl が起きる
        const w = mkWorld();
        await callOwl(w);
        await tick();
        t.ok('E1-4: 前提: Owl の返事の @Lynx で Lynx の会話が始まる（呼んだ bot が出来事に残る）', startedFor(w, 's_new_b_2') && (await itemsOf(w, 's_new_b_2'))[0]?.caller === 'b_1', JSON.stringify(await itemsOf(w, 's_new_b_2')));
        await finish(w, 's_new_b_2', '調べた結果です');
        const back = (await itemsOf(w, 's1')).filter((i) => i.reply);
        const resultPost = w.posts.find((p) => p.turn?.sessionId === 's_new_b_2');
        t.ok('E1-4: Lynx の返事が、Owl の会話の出来事として届く（reply = Lynx。返事の投稿を指す）', back.length === 1 && back[0].reply === 'b_2' && back[0].postId === resultPost.id && back[0].botId === 'b_1', JSON.stringify(await itemsOf(w, 's1')));
        const owlPrompt = w.started.find((s) => s.args.sessionId === 's1')?.args.prompt ?? '';
        t.ok('E1-4: Owl の会話が新しいターンで起き、包みは reply="true"・from は Lynx・本文は Lynx の返事', owlPrompt.includes(' reply="true"') && owlPrompt.includes('from="🐺 Lynx (bot)"') && owlPrompt.includes('>調べた結果です</pleiad-channel>'), owlPrompt);
        t.ok('E1-4: 起こした回数が増える（呼び合いの回数の上限は置かず、数えるだけ）', w.threads['c_1/p_root'].calls === 2, String(w.threads['c_1/p_root'].calls));

        // 人が @Lynx で直接起こしたときは返さない
        const human = mkWorld();
        const hp = botPost('p_h1', ['b_2'], { author: { kind: 'human' }, text: '@Lynx 人が書く' });
        human.posts.push(hp);
        await human.d.onPosted(hp, human.channel);
        await tick();
        await finish(human, 's_new_b_2', '人への返事');
        t.ok('E1-4: 人が @ で直接起こしたときは、返事を Owl の会話へ返さない', (await itemsOf(human, 's1')).length === 0 && !startedFor(human, 's1') && !(await itemsOf(human, 's_new_b_2'))[0]?.caller);

        // 失敗・止めた（ok でない）ターンは「答えた」ではない
        const failed = mkWorld();
        await callOwl(failed);
        await tick();
        await finish(failed, 's_new_b_2', '途中までです', 'error');
        t.ok('E1-4: ターンが ok で終わらなかったら返さない', (await itemsOf(failed, 's1')).length === 0 && !startedFor(failed, 's1'));

        // Owl のスレッドが止められているとき・［止める］を押したときは返さない
        const stoppedThread = mkWorld();
        await callOwl(stoppedThread);
        await tick();
        stoppedThread.threads['c_1/p_root'].stopped = { by: { kind: 'human' }, at: 1 };
        await finish(stoppedThread, 's_new_b_2', '止めた後の返事');
        t.ok('E1-4: Owl のスレッドが止められている（ThreadState.stopped）ときは返さない', (await itemsOf(stoppedThread, 's1')).length === 0 && !startedFor(stoppedThread, 's1'));
        const pressed = mkWorld();
        await callOwl(pressed);
        await tick();
        await pressed.d.stopThread({ channelId: 'c_1', threadId: 'p_root' }, { kind: 'human' });
        await finish(pressed, 's_new_b_2', '止めた直後の返事');
        t.ok('E1-4: ［止める］を押したスレッドでは、そのとき走っていた Lynx のターンが ok で終わっても返さない', (await itemsOf(pressed, 's1')).length === 0 && !startedFor(pressed, 's1'));

        // Lynx の返事が Owl への @ を含むなら、その @ で Owl が起きる。返事を重ねて届けない
        const mention = mkWorld();
        await callOwl(mention);
        await tick();
        await finish(mention, 's_new_b_2', '@Owl 結果です');
        const owlItems = await itemsOf(mention, 's1');
        t.ok('E1-4: 返事が呼んだ bot への @ を含むときは、@ で 1 回だけ起こす（reply の出来事を重ねない）', owlItems.length === 1 && !owlItems[0].reply && owlItems[0].caller === 'b_2', JSON.stringify(owlItems));

        // 呼び合いは回数の上限なしに続くが、［止める］で止まる: Owl → Lynx → Owl → Lynx …を 3 往復させてから止める
        const loop = mkWorld();
        await callOwl(loop);
        await tick();
        for (let round = 1; round <= 3; round++) {
          await finish(loop, 's_new_b_2', `返事 ${round}`);                  // Lynx が答える → Owl が起きる
          await finish(loop, 's1', '@Lynx もう 1 回', 'ok');                // Owl が答えて、また Lynx を呼ぶ → Lynx が起きる
        }
        const owlStarts = loop.started.filter((s) => s.args.sessionId === 's1').length, lynxStarts = loop.started.filter((s) => s.args.sessionId === 's_new_b_2').length;
        t.ok('E1-4: 3 往復しても止まらない（呼び合いに上限は置かない）', owlStarts === 3 && lynxStarts === 4 && loop.threads['c_1/p_root'].calls === 7, JSON.stringify([owlStarts, lynxStarts, loop.threads['c_1/p_root'].calls]));
        await loop.d.stopThread({ channelId: 'c_1', threadId: 'p_root' }, { kind: 'human' });
        const before = loop.started.length;
        await finish(loop, 's_new_b_2', '止めた後の Lynx の返事');
        await finish(loop, 's1', '@Lynx 止めた後の Owl の返事');
        t.ok('E1-4: ［止める］で呼び合いが止まる（止めた後は、返事も @ も新しいターンを起こさない）', loop.started.length === before && (await loop.d.inbox.list({ status: 'pending' })).length === 0, JSON.stringify([before, loop.started.length]));
        t.ok('E1-4: 止めた後に人が書くと、また起こせる', await (async () => {
          const again = botPost('p_again', ['b_2'], { author: { kind: 'human' }, text: '@Lynx 再開' });
          loop.posts.push(again);
          loop.threads['c_1/p_root'].stopped = null;
          await loop.d.onPosted(again, loop.channel);
          await tick();
          return loop.started.length === before + 1;
        })());
      }

      // E1-5: ［止める］は、ターンの終わった bot の会話にも届く（委譲の子のタスクの取り消しは会話の中断に付いてくる）
      {
        const w = world('plain');
        w.turns.delete('s1');
        await w.d.stopThread({ channelId: 'c_1', threadId: 'p_root' }, { kind: 'human' });
        t.ok('E1-5: 走っているターンが無くても、スレッドの bot の会話を中断として止める（委譲の子のタスクが取り消される）', w.aborted.some((a) => a.sessionId === 's1' && a.reason === 'user'), JSON.stringify(w.aborted));
        const running = world('plain');
        await running.d.turnExtras(running.turn);
        await running.d.stopThread({ channelId: 'c_1', threadId: 'p_root' }, { kind: 'human' });
        t.ok('E1-5: 走っている会話は 1 回だけ止める（二重に止めない）', running.aborted.filter((a) => a.sessionId === 's1').length === 1, JSON.stringify(running.aborted));
      }
      // E1-2（Antigravity）: 会話を続けるときに人格（エージェント定義）を渡し直しても最初の指示のまま動くので、人格を直した後の最初のターンに、新しい人格を末尾の文脈として渡す
      {
        const mk = (backend) => {
          const w = world('plain');
          w.sessions.s1.backend = backend;
          w.d.bots.instructions = (bot) => `PERSONA(${bot.persona ?? ''})`;
          return w;
        };
        const begin = async (w) => (await w.d.turnExtras({ ...w.turn, info: { sessionId: 's1' } })).notes;
        const deliver = async (w) => { w.d.onTurnEvent(w.turn, { type: 'text.delta', text: 'はい' }); await w.d.onTurnEnd(w.turn, { outcome: 'ok' }); await sleep(60); };
        const w = mk('antigravity');
        const owl = await w.d.bots.get({ botId: 'b_1' });
        owl.persona = '一つ目';
        t.ok('E1-2: Antigravity の最初のターンは人格の更新の文を足さない（人格はエージェント定義で渡る）', (await begin(w)).every((n) => !n.includes('PERSONA(')));
        await deliver(w);
        t.ok('E1-2: 渡った人格のハッシュを会話の sidecar に残す（personaKey）', typeof w.sessions.s1.bot.personaKey === 'string' && w.sessions.s1.bot.personaKey.length === 32, JSON.stringify(w.sessions.s1.bot));
        t.ok('E1-2: 人格を直していなければ次のターンも足さない', (await begin(w)).every((n) => !n.includes('PERSONA(')));
        await deliver(w);
        owl.persona = '二つ目';
        const changed = await begin(w);
        t.ok('E1-2: 人格を直した後の最初のターンに、新しい人格を末尾の文脈（pleiad-turn-context）として渡す', changed.length >= 1 && changed[0].startsWith('<pleiad-turn-context>') && changed[0].includes('PERSONA(二つ目)') && !changed.join('').includes('PERSONA(一つ目)') && changed[0].includes('人格の指示が更新されました'), JSON.stringify(changed));
        // 渡る前に失敗したターン（commit しない）は、次のターンもまた渡す
        w.turns.delete('s1');
        const retry = await begin(w);
        t.ok('E1-2: 渡る前に終わったターンの次も、新しい人格をまた渡す（渡ったと分かるまでハッシュを進めない）', retry.some((n) => n.includes('PERSONA(二つ目)')), JSON.stringify(retry));
        await deliver(w);
        t.ok('E1-2: 渡った後はハッシュが進み、次のターンは足さない', (await begin(w)).every((n) => !n.includes('PERSONA(')));
        // Claude・Codex は毎ターンの引数で届くので、この文は足さない
        const other = mk(undefined);
        const owl2 = await other.d.bots.get({ botId: 'b_1' });
        owl2.persona = '一つ目';
        await begin(other); await deliver(other);
        owl2.persona = '二つ目';
        t.ok('E1-2: Antigravity 以外の会話には人格の更新の文を足さない（Claude は毎ターン組み直し、Codex は毎ターン collaborationMode で渡る）', (await begin(other)).every((n) => !n.includes('PERSONA(')) && !('personaKey' in other.sessions.s1.bot));
      }
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


    // ---- K: 独立レビューの指摘をサーバー越しに（S-3・S-2）。bot の会話の AI が ply_control から channels.post を呼ぶ
    {
      // 会話の AI が呼ぶ操作の台本: 本文の @ は \u0040 にして、人の投稿では誰も起こさない
      const AT = String.fromCharCode(92) + 'u0040';   // 台本の JSON の中の「バックスラッシュ + u0040」（読んだ側が @ に戻す）
      const viaBot = (args) => `control:${JSON.stringify({ name: 'call_op', arguments: { op: 'channels.post', args } }).replace(/@/g, AT)}`;
      const flowPosts = async () => (await read(dev.id)).posts.filter((p) => p.author.kind === 'bot' && p.author.botId === owl.id && !p.turn);

      // S-3(a): threadId を落とした channels.post は、その会話のスレッドに書かれる（チャンネルの流れの新しい投稿にならない）
      const flowBefore = (await flowPosts()).length;
      const rootK = await call('channels.post', { channelId: dev.id, text: `@Owl ${viaBot({ channelId: dev.id, text: 'threadId を落とした報告', new: true })}` });
      const k1 = await until(async () => { const r = await read(dev.id, rootK.id); return botPost(r, owl, 'done')[0] && r.posts.some((p) => p.text === 'threadId を落とした報告') ? r : null; }, { label: 'K1 返事' });
      t.ok('S-3(a): threadId を落とした channels.post が、その会話のスレッドに書かれる。チャンネルの流れに新しい投稿が増えない（新しいスレッドができない）', k1.posts.find((p) => p.text === 'threadId を落とした報告').threadId === rootK.id
        && (await flowPosts()).length === flowBefore, JSON.stringify(k1.posts.map((p) => [p.author.kind, p.threadId, p.text.slice(0, 20)])));
      await settled(rootK);

      // S-3(b)・止める: 明示した流れへの投稿で起こした先は、起こした元のスレッドの［止める］で止まる。Lynx は流れの投稿で新しいスレッドを持つ（origin）
      const rootL = await call('channels.post', { channelId: dev.id, text: `@Owl ${viaBot({ channelId: dev.id, threadId: null, new: true, text: '@Lynx slow' })}` });
      const l1 = await until(async () => {
        const r = await read(dev.id);
        const spawned = r.posts.find((p) => p.author.kind === 'bot' && p.author.botId === owl.id && p.threadId === null && p.text === '@Lynx slow');
        if (!spawned) return null;
        const th = r.threads.find((x) => x.threadId === spawned.id);
        const rr = await read(dev.id, spawned.id);
        return th && botPost(rr, lynx, 'working').length ? { spawned, th, rr } : null;
      }, { label: 'L 流れへの @ で新しいスレッド' });
      t.ok('S-3(b): bot が自分のスレッドから、流れへ @ を書いて起こした先は新しいスレッド。起こした元（origin）が ThreadState に残る', l1.th.origin?.threadId === rootL.id && l1.th.origin.channelId === dev.id, JSON.stringify(l1.th));
      const mL = c.mark();
      await call('channels.stopThread', { channelId: dev.id, threadId: rootL.id });
      const l2 = await until(async () => { const rr = await read(dev.id, l1.spawned.id); const l = botPost(rr, lynx)[0]; return l?.state === 'stopped' && rr.threads[0].state === 'idle' ? rr : null; }, { label: 'L 派生のスレッドが止まる' });
      t.ok('S-3(b): 元のスレッドの［止める］が、起こして新しくできたスレッドの Lynx も止める（止めた印と止めた主体）', l2.threads[0].stopped?.by.kind === 'human' && turnEnds(l2.threads[0].sessions[lynx.id], mL).length === 1
        && l2.posts.some((p) => p.author.kind === 'system' && p.text === 'あなた が止めました'), JSON.stringify(l2.threads[0]));
      await settled(rootL);

      // S-2: 動くモードが自分より強い bot を channels.post で @ すると、投稿は残るが起こさず、承認カード（起こしますか）。許可したら起こす
      const wolf = await call('bots.create', { name: 'Wolf', icon: '🐕', backend: 'fake' });
      await call('bots.setMode', { botId: wolf.id, mode: 'bypass' });
      const mW = c.mark();
      const rootW = await call('channels.post', { channelId: dev.id, text: `@Owl ${viaBot({ channelId: dev.id, text: '@Wolf slow', new: true })}` });
      const card = await c.waitFor((e) => e.type === 'permission' && e.settingChange?.op === 'channels.wake', { from: mW, ms: 20_000 });
      const w1 = await until(async () => { const r = await read(dev.id, rootW.id); return r.posts.some((p) => p.text === '@Wolf slow' && p.author.botId === owl.id) && botPost(r, owl, 'done').length
        && r.posts.some((p) => p.author.kind === 'system' && p.text.includes('起こしていません')) ? r : null; }, { label: 'W 投稿と返事と知らせ' });
      t.ok('S-2: 強い bot（Wolf）を @ した投稿は残るが、Wolf は起きず、承認カード（起こしますか・モードの行・loosens）が Owl の会話に出る', botPost(w1, wolf).length === 0 && card.sessionId === w1.threads[0].sessions[owl.id]
        && card.settingChange.note.includes('Wolf') && card.settingChange.note.includes('起こしますか') && card.settingChange.loosens === true && card.settingChange.rows.some((r) => r.path === 'mode'), JSON.stringify(card.settingChange));
      t.ok('S-2: Owl の返事の @Wolf も起こさず、知らせの投稿が残る（返事の @ も同じ確認）', w1.posts.some((p) => p.author.kind === 'system' && p.text.includes('Wolf') && p.text.includes('起こしていません')) && botPost(w1, wolf).length === 0, JSON.stringify(w1.posts.map((p) => [p.author.kind, p.text.slice(0, 40)])));
      await c.cmd('resolvePermission', { id: card.id, allow: true, receipt: card.settingChange.receipt });
      const w2 = await until(async () => { const r = await read(dev.id, rootW.id); return botPost(r, wolf, 'working').length ? r : null; }, { label: 'W 許可のあと Wolf が起きる' });
      t.ok('S-2: 人が許可すると、その投稿の @ で Wolf が起きる（Wolf の会話が作業中になる）', botPost(w2, wolf, 'working').length === 1 && w2.threads[0].sessions[wolf.id] !== undefined);
      await call('channels.stopThread', { channelId: dev.id, threadId: rootW.id });
      await settled(rootW);
    }

    // ---- L: 呼ばれて答えたら返事が返る（E1-4）。人が直接呼んだときは返らない。呼び合いは回数の上限なしに続くが［止める］で止まる。止めると委譲の子も止まる（E1-5）
    {
      const AT6 = String.fromCharCode(92) + 'u0040';   // 台本の JSON の中の「バックスラッシュ + u0040」（読んだ側が @ に戻す）
      const atJson = (obj) => JSON.stringify(obj).replace(/@/g, AT6);
      const inboxItems = async () => JSON.parse(await fs.readFile(path.join(dataDir, 'channels', 'inbox.json'), 'utf8')).items;
      // Owl の返事「@Lynx echo:<Owl への台本>」→ Lynx が echo で返す（本物の @ を含まない）→ 返事が Owl へ返る → Owl が台本どおり「@Lynx slow」と返す → Lynx は slow で作業中
      const toOwl = `steps:${atJson({ steps: [{ text: '@Lynx slow' }] })}`;
      const rootR = await call('channels.post', { channelId: dev.id, text: `@Owl steps:${atJson({ steps: [{ text: `@Lynx echo:${toOwl}` }] })}` });
      const r1 = await until(async () => {
        const r = await read(dev.id, rootR.id);
        return botPost(r, owl, 'done').length === 2 && botPost(r, lynx, 'done').length === 1 && botPost(r, lynx, 'working').length === 1 ? r : null;
      }, { label: 'R Lynx の返事 → Owl が起きて、また Lynx を呼ぶ' });
      const lynxDone = botPost(r1, lynx, 'done')[0];
      t.ok('E1-4: Lynx の返事（呼んだ Owl への答え）で Owl が起き、Owl はその返事を読んでまた Lynx を呼ぶ（Lynx は作業中）', lynxDone.text === toOwl && botPost(r1, owl, 'done').at(-1).text === '@Lynx slow', JSON.stringify(r1.posts.map((p) => [p.author.kind, p.state, p.text.slice(0, 40)])));
      const thR = r1.threads[0];
      const backItem = (await inboxItems()).find((i) => i.sessionId === thR.sessions[owl.id] && i.reply === lynx.id);
      t.ok('E1-4: Owl の会話に、返事の出来事（reply = Lynx・Lynx の返事の投稿）が残り、渡った（sent）', backItem?.postId === lynxDone.id && backItem.status === 'sent', JSON.stringify(backItem));
      const owlEvents = (await history(thR.sessions[owl.id])).filter((m) => m.kind === 'channelEvent');
      t.ok('E1-4: 会話の履歴の包みは、Lynx（bot）の投稿として届いている', owlEvents.some((m) => m.postId === lynxDone.id && m.from === '🐺 Lynx (bot)' && m.body === toOwl), JSON.stringify(owlEvents.map((m) => [m.postId, m.from, String(m.body).slice(0, 40)])));
      t.ok('E1-4: 起こした回数は 4（人→Owl・Owl→Lynx・返事→Owl・Owl→Lynx）。上限は無く、数えるだけ', thR.calls === 4, String(thR.calls));
      // ［止める］で止まる。止めた後は Lynx の返事も新しい Owl のターンを起こさない
      const mR = c.mark();
      await call('channels.stopThread', { channelId: dev.id, threadId: rootR.id });
      const r2 = await until(async () => { const r = await read(dev.id, rootR.id); return botPost(r, lynx, 'stopped').length === 1 && r.threads[0].state === 'idle' ? r : null; }, { label: 'R Lynx が止まる' });
      await sleep(600);
      const r3 = await read(dev.id, rootR.id);
      t.ok('E1-4: ［止める］で呼び合いが止まる（走っていた Lynx は stopped。Owl は新しく起きない）', turnEnds(thR.sessions[lynx.id], mR).length === 1 && botPost(r3, owl, 'done').length === 2 && botPost(r3, owl).length === 2 && r2.threads[0].stopped?.by.kind === 'human', JSON.stringify(r3.posts.map((p) => [p.author.kind, p.state])));

      // 人が @Lynx で直接起こしたときは、返事を Owl へ返さない
      const rootH = await call('channels.post', { channelId: dev.id, text: '@Lynx echo:直接の返事' });
      await until(async () => botPost(await read(dev.id, rootH.id), lynx, 'done').length === 1, { label: 'H 直接呼んだ Lynx の返事' });
      await settled(rootH);
      await sleep(600);
      const rH = await read(dev.id, rootH.id);
      t.ok('E1-4: 人が直接 @ で呼んだ bot の返事は、どの bot にも返さない（Owl は起きない）', botPost(rH, owl).length === 0 && !(await inboxItems()).some((i) => i.threadId === rootH.id && (i.reply || i.botId === owl.id)), JSON.stringify(rH.posts.map((p) => [p.author.kind, p.text.slice(0, 20)])));

      // E1-5: ターンの終わった bot の会話が委譲（ply_delegate）で作った子は、［止める］で取り消される
      const delegate = `ply:${JSON.stringify({ name: 'ply_delegate', arguments: { kind: 'mechanical', backend: 'fake', task: 'slow', title: '長い仕事' } })}`;
      const rootT = await call('channels.post', { channelId: dev.id, text: `@Owl ${delegate}` });
      const tasksOf = async (sessionId) => (await c.cmd('agentTasks')).filter((x) => x.parentSessionId === sessionId);
      const delegated = await until(async () => {
        const r = await read(dev.id, rootT.id);
        const sessionId = r.threads[0]?.sessions?.[owl.id];
        const task = sessionId ? (await tasksOf(sessionId))[0] : null;
        return botPost(r, owl, 'done').length === 1 && task?.status === 'running' ? { r, sessionId, task } : null;
      }, { label: 'T 委譲した子が走っている・Owl のターンは終わっている' });
      t.ok('E1-5: 前提: Owl のターンは終わっていて（done）、Owl の会話が作った子のタスクだけが走っている', botPost(delegated.r, owl, 'done').length === 1 && delegated.task.status === 'running' && !(await c.cmd('running')).sessions?.includes?.(delegated.sessionId));
      await call('channels.stopThread', { channelId: dev.id, threadId: rootT.id });
      const cancelled = await until(async () => (await tasksOf(delegated.sessionId)).find((x) => x.taskId === delegated.task.taskId && x.status === 'cancelled'), { label: 'T 子のタスクが取り消される' });
      t.ok('E1-5: ［止める］が、ターンの終わった bot の会話の委譲の子（走っていたタスク）を取り消す', cancelled.status === 'cancelled', JSON.stringify(cancelled));
      await settled(rootT);
    }

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
