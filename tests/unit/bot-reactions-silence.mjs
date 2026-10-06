// bot の投稿へのリアクションと、黙って終えたターン（ADR 0109・0119 の追記）。本物のチャンネルのサービスに身代わりの会話・バックエンドをつなぐ。LLM は使わない。
//   リアクション: 問いかけの投稿に 👍 → その bot が起き、包みに reaction="👍"。付けたのが人でも、ほかの bot・Chats の AI でも同じ（付けた者ごとに 1 回）。
//                 答えでないリアクション・同じ者の 2 度目・予算切れの bot・AI のリアクションは起こさず、次に起きたときに渡す。人のリアクションは予算で止めない。
//                 外したリアクションは渡さない。自分のリアクションは渡さない。DM の投稿も同じだが、DM では bot のリアクションで起こさない。
//   黙る: 文章なし・[[no-reply]] だけ・「（なし）」のような括弧だけの一言で終えたターンは投稿を残さない。本当の返事は消さない。
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { open, sleep } from '../lib/ws-client.mjs';
import { startServer } from '../lib/server.mjs';
import { createChannelService } from '../../core/channels/service.mjs';
import { createDispatcher, QUIET_REACTIONS } from '../../core/bots/dispatch.mjs';
import { isSilentReply, stripSilentMark, SILENT_MARK } from '../../core/bots/silence.mjs';
import { answerOf, asksQuestion } from '../../core/bots/reactions.mjs';

export const name = 'bot-reactions-silence';
export const title = 'bot の投稿へのリアクション（問いへの答えは人・bot・AI のどれでも起こす・bot と AI は予算の内・ほかは次に渡す・付け外しと連打）と、黙って終えたターン（印・括弧だけの一言は投稿しない）';

const until = async (fn, { ms = 5000, label = '' } = {}) => {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) { last = await fn(); if (last) return last; await sleep(20); }
  throw new Error(`timeout: ${label} ${JSON.stringify(last ?? null)?.slice(0, 400)}`);
};

export default async function (t) {
  // ================================================================ 部品（純粋）
  {
    const silent = ['', '   ', SILENT_MARK, '[[ NO_REPLY ]]', '（なし）', '(no reply)', '（特になし）', '[no reply]', '…', '...', '。'];
    const spoken = ['なし', 'はい', '「はい」', '(a) と (b) です', '（なし）\n理由は次のとおり', '(see https://example.com)', '(@Owl に任せます)',
      '（返信なしでよいかどうか、もう一度確かめてから決めたいので少し待ってください）', '？', '👍', 'OK', '（なし）ではなく、見つかったのは 3 件です'];
    t.ok('黙ったことを表すだけの文: 空・印・括弧だけの短い一言・省略の記号', silent.every(isSilentReply), JSON.stringify(silent.filter((s) => !isSilentReply(s))));
    t.ok('本当の返事は黙ったことにしない（括弧の外の字・改行・URL・@・長いもの・かぎ括弧・疑問符・絵文字）', spoken.every((s) => !isSilentReply(s)), JSON.stringify(spoken.filter(isSilentReply)));
    t.ok('印は本文から外す（前後の空白も）', stripSilentMark(`了解しました。 ${SILENT_MARK}`) === '了解しました。' && stripSilentMark('a') === 'a');
    t.ok('答えのリアクション: 承諾と断り（肌の色・異体字・性別の印を外して比べる）。ほかは答えではない',
      ['👍', '👍🏽', '✅', '✔️', '👌', '🙆‍♂️', '⭕'].every((e) => answerOf(e) === 'yes') && ['👎', '❌', '🙅‍♀️', '🚫'].every((e) => answerOf(e) === 'no')
      && ['🎉', '😂', '👀', '❤️', ''].every((e) => answerOf(e) === null));
    t.ok('問いかけの投稿: 疑問符か、問いの言い回しで終わる行',
      ['main に入れてよいですか？', 'Shall I merge it?', 'main に入れてよいか', 'このまま進めてもいいですか', '方針を 2 つ考えました。\nどちらにしますか。'].every(asksQuestion)
      && !['マージしました。', 'URL: https://example.com/?a=1', '```\nif (a?.b) run()\n```', '> 入れてよい？\n入れました。', '`a ? b : c` を直しました'].some(asksQuestion));
  }

  // ================================================================ 本物のチャンネルのサービスと身代わりの会話
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'bot-reactions-'));
  const human = { kind: 'human' };
  const BOTS = [
    { id: 'b_owl', name: 'Owl', icon: '🦉', dmChannelId: null, dmSessionId: 's_dm' },
    { id: 'b_lynx', name: 'Lynx', icon: '🐺', dmChannelId: null, dmSessionId: null },
  ];
  const sessions = {};
  const started = [];     // runTurn に渡った { sessionId, prompt }
  const turns = new Map();
  let d = null;
  const channels = createChannelService({
    dir: path.join(tmp, 'channels'), listBots: async () => BOTS,
    hooks: {
      posted: (...a) => d.onPosted(...a), reacted: (...a) => d.onReacted(...a),
      stopThread: (...a) => d.stopThread(...a), botPost: (a) => d.claimPost(a),
    },
  });
  const host = {
    dataDir: tmp,
    store: { get: async (id) => structuredClone(sessions[id] ?? {}), setSessionData: async (id, f, v) => { sessions[id] = { ...sessions[id], [f]: v }; } },
    runtime: { turns }, noticeTarget: async () => null, noticeBlocked: async () => false,
    agentLocaleFor: async () => 'ja', currentLocale: () => 'ja', emitSession: () => {}, abortSessions: async () => {},
    // 本物の runTurn と同じく、始まったら turnExtras を呼ぶ。ターンの中身と終わりはテストが onTurnEvent・onTurnEnd で進める
    runTurn: async (args) => {
      const turn = { info: { sessionId: args.sessionId }, agentLocale: 'ja', usage: {}, stream: {} };
      turns.set(args.sessionId, turn);
      // ターンの記録ができてから数える（先に数えると、記録ができる前にテストが onTurnEnd を呼び、終わりが捨てられて投稿が working のまま残る）
      await d.turnExtras(turn);
      started.push({ sessionId: args.sessionId, prompt: args.prompt, turn });
      return 'ok';
    },
  };
  const bots = {
    get: async ({ botId }) => BOTS.find((b) => b.id === botId) ?? null, list: async () => BOTS,
    createSession: async ({ botId, channel, threadId }) => {
      const sessionId = `s_${botId}_${threadId}`;
      sessions[sessionId] = { bot: { botId, kind: 'thread', channelId: channel.id, threadId, memRev: 0, snapshotDue: false, delivered: [], postCursor: null } };
      return { sessionId };
    },
    ensureDmSession: async () => ({ sessionId: 's_dm' }),
  };
  const memory = { turnContext: async () => ({ notes: [], memRev: 0, delivered: [], snapshotDue: false }) };
  d = createDispatcher({ channels, bots, memory, host });
  await channels.start();
  await d.start();

  /** 走っているターンを、文章 texts を書いて終える（texts は道具を挟んだ別々の文章） */
  const finish = async (run, texts, outcome = 'ok') => {
    for (const text of texts) {
      d.onTurnEvent(run.turn, { type: 'text.delta', text });
      d.onTurnEvent(run.turn, { type: 'text.end' });
    }
    turns.delete(run.sessionId);
    await d.onTurnEnd(run.turn, { outcome });
  };
  const nextStart = (n, label) => until(() => started.length > n && started[n], { label });
  const quietWait = () => sleep(150);
  const turnPosts = async (channelId, threadId) => (await channels.read({ channelId, threadId, limit: 100 })).posts.filter((p) => p.turn && !p.deletedAt);

  try {
    const channel = await channels.create({ name: 'dev', members: ['b_owl', 'b_lynx'] }, human);
    const root = await channels.post({ channelId: channel.id, text: '@Owl リリースの準備をして' }, human);
    const first = await nextStart(0, 'Owl が @ で起きる');
    await finish(first, ['準備ができました。main に入れてよいですか？']);
    const [question] = await turnPosts(channel.id, root.id);
    t.ok('前提: bot の問いかけがターンの投稿になる', question?.text === '準備ができました。main に入れてよいですか？' && question.state === 'done', JSON.stringify(question));

    // ---- 問いへの人の答え（👍）は bot を起こす
    await channels.react({ channelId: channel.id, postId: question.id, emoji: '👍', on: true }, human);
    const second = await nextStart(1, '👍 で Owl が起きる');
    t.ok('問いかけの投稿に人が 👍 → その bot の同じ会話が起きる', second.sessionId === first.sessionId, second.sessionId);
    t.ok('包みに reaction="👍"・付けた人・投稿の id と書き出しが入る', second.prompt.includes('reaction="👍"') && second.prompt.includes(`post="${question.id}"`)
      && second.prompt.includes('from="あなた"') && second.prompt.includes('main に入れてよいですか？'), second.prompt);

    // ---- 黙って終えた（括弧だけの一言）: 投稿は残らない
    await finish(second, ['（なし）']);
    t.ok('「（なし）」だけで終えたターンは投稿を残さない', (await turnPosts(channel.id, root.id)).length === 1, JSON.stringify(await turnPosts(channel.id, root.id)));

    // ---- 同じ人の 2 度目の答え・答えでないリアクション・自分のリアクションは起こさない
    await channels.react({ channelId: channel.id, postId: question.id, emoji: '✅', on: true }, human);
    await channels.react({ channelId: channel.id, postId: question.id, emoji: '🎉', on: true }, human);
    await channels.react({ channelId: channel.id, postId: question.id, emoji: '👀', on: true }, { kind: 'bot', botId: 'b_owl' });
    await quietWait();
    t.ok('同じ投稿への人の 2 度目の答え（✅）・🎉・自分の 👀 では起きない', started.length === 2, JSON.stringify(started.map((s) => s.sessionId)));
    const quiet = (await d.inbox.list({ sessionId: first.sessionId, status: 'pending' })).filter((i) => i.reaction);
    t.ok('起こさないリアクションは次に渡す出来事として待つ（自分のリアクションは積まない）', quiet.length === 2 && quiet.every((i) => i.reaction.quiet)
      && !quiet.some((i) => i.reaction.byKey === 'bot:b_owl'), JSON.stringify(quiet));

    // ---- 外したら取り消す・付け直しても重ねない・連打しても 1 件
    await channels.react({ channelId: channel.id, postId: question.id, emoji: '🎉', on: false }, human);
    await channels.react({ channelId: channel.id, postId: question.id, emoji: '✅', on: false }, human);
    await channels.react({ channelId: channel.id, postId: question.id, emoji: '✅', on: true }, human);
    await quietWait();
    const after = (await d.inbox.list({ sessionId: first.sessionId, status: 'pending' })).filter((i) => i.reaction);
    t.ok('外したリアクションは取り消し、付け直しても 1 件のまま。起きない', started.length === 2 && after.length === 1
      && after[0].reaction.emoji === '✅' && after[0].reaction.quiet, JSON.stringify(after));

    // ---- ほかの bot の 👍 は、人が先に起こした投稿でも起こす（付けた者ごとに 1 回）。待っていた人の ✅ も一緒に渡る
    await channels.react({ channelId: channel.id, postId: question.id, emoji: '👍', on: true }, { kind: 'bot', botId: 'b_lynx' });
    const third = await nextStart(2, 'Lynx の 👍 で Owl が起きる');
    t.ok('問いかけの投稿にほかの bot が 👍 → 人が先に起こした後でも、その bot の同じ会話が起きる', third.sessionId === first.sessionId
      && third.prompt.includes('reaction="👍"') && third.prompt.includes('from="🐺 Lynx (bot)"') && third.prompt.includes('reaction="✅"'), third.prompt);
    await finish(third, ['（なし）']);

    // ---- 同じ bot の 2 度目の答えは起こさない。次に起きたとき（人の @）に、待っていたリアクションがまとめて渡る
    await channels.react({ channelId: channel.id, postId: question.id, emoji: '✅', on: true }, { kind: 'bot', botId: 'b_lynx' });
    await channels.react({ channelId: channel.id, postId: question.id, emoji: '🎉', on: true }, human);
    await channels.react({ channelId: channel.id, postId: question.id, emoji: '🎉', on: false }, human);
    await quietWait();
    t.ok('同じ bot の 2 度目の答え（✅）では起きない', started.length === 3, JSON.stringify(started.map((s) => s.sessionId)));
    await channels.post({ channelId: channel.id, threadId: root.id, text: '@Owl ついでにタグも' }, human);
    const fourth = await nextStart(3, '@ で Owl が起きる');
    t.ok('次に起きたとき、待っていたリアクションが包みで渡る（外した 🎉 は渡らない）', fourth.prompt.includes('reaction="✅"')
      && fourth.prompt.includes('from="🐺 Lynx (bot)"') && !fourth.prompt.includes('🎉') && fourth.prompt.includes('ついでにタグも'), fourth.prompt);
    t.ok('渡したリアクションは待ちから外れる', (await d.inbox.list({ sessionId: first.sessionId, status: 'pending' })).length === 0);

    // ---- 黙る印・本当の返事
    await finish(fourth, ['タグを付けました。', SILENT_MARK]);
    const posts3 = await turnPosts(channel.id, root.id);
    t.ok('文章の後ろの印だけを外し、本当の返事は残す', posts3.length === 2 && posts3.at(-1).text === 'タグを付けました。', JSON.stringify(posts3.at(-1)));
    await channels.post({ channelId: channel.id, threadId: root.id, text: '@Owl 確認だけ' }, human);
    const fifth = await nextStart(4, '@ で Owl が起きる');
    await finish(fifth, [SILENT_MARK]);
    t.ok('印だけで終えたターンは投稿を残さない', (await turnPosts(channel.id, root.id)).length === 2);
    await channels.post({ channelId: channel.id, threadId: root.id, text: '@Owl 件数は？' }, human);
    const sixth = await nextStart(5, '@ で Owl が起きる');
    await finish(sixth, ['（なし）ではなく、見つかったのは 3 件です']);
    t.ok('括弧で始まっても続きのある返事は消さない', (await turnPosts(channel.id, root.id)).at(-1)?.text === '（なし）ではなく、見つかったのは 3 件です');
    // channels.post で返事を入れた後に「(no reply)」で終えた: 書いた返事だけが残る
    await channels.post({ channelId: channel.id, threadId: root.id, text: '@Owl まとめて' }, human);
    const seventh = await nextStart(6, '@ で Owl が起きる');
    await channels.post({ channelId: channel.id, threadId: root.id, text: 'まとめました: 3 件', bySession: seventh.sessionId }, { kind: 'bot', botId: 'b_owl' });
    await finish(seventh, ['(no reply)']);
    t.ok('channels.post で書いた返事の後ろに、黙る一言を足さない', (await turnPosts(channel.id, root.id)).at(-1)?.text === 'まとめました: 3 件', JSON.stringify((await turnPosts(channel.id, root.id)).at(-1)));

    // ---- 問いかけでない投稿への 👍 は起こさない（次に渡す）
    const statement = (await turnPosts(channel.id, root.id)).find((p) => p.text === 'タグを付けました。');
    await channels.react({ channelId: channel.id, postId: statement.id, emoji: '👍', on: true }, human);
    await quietWait();
    t.ok('問いかけでない投稿への 👍 は起こさない（次に渡す）', started.length === 7
      && (await d.inbox.list({ sessionId: first.sessionId, status: 'pending' })).some((i) => i.postId === statement.id && i.reaction?.quiet));

    // ---- 人の投稿へのリアクションは bot へ渡さない
    await channels.react({ channelId: channel.id, postId: root.id, emoji: '👍', on: true }, human);
    await quietWait();
    t.ok('人の投稿へのリアクションは bot へ渡さない', !(await d.inbox.list({})).some((i) => i.postId === root.id && i.reaction));

    // ---- 止めたスレッドでは起こさない
    const root2 = await channels.post({ channelId: channel.id, text: '@Owl もう一つ' }, human);
    const eighth = await nextStart(7, '@ で Owl が起きる');
    await finish(eighth, ['進めてよいですか？']);
    const [q2] = await turnPosts(channel.id, root2.id);
    await channels.stopThread({ channelId: channel.id, threadId: root2.id }, human);
    await channels.react({ channelId: channel.id, postId: q2.id, emoji: '👍', on: true }, human);
    await quietWait();
    t.ok('止めたスレッドの問いへの 👍 では起きない', started.length === 8);

    // ---- 人でない者（bot・Chats の AI）のリアクションは、予算が残っている間だけ起こす。人のリアクションは予算で止めない
    const root3 = await channels.post({ channelId: channel.id, text: '@Owl 三つ目' }, human);
    const ninth = await nextStart(8, '@ で Owl が起きる');
    await finish(ninth, ['タグを打ってよいですか？']);
    const [q3] = await turnPosts(channel.id, root3.id);
    const systemPosts = async () => (await channels.read({ channelId: channel.id, limit: 100 })).posts.filter((p) => p.author?.kind === 'system').length
      + (await channels.read({ channelId: channel.id, threadId: root3.id, limit: 100 })).posts.filter((p) => p.author?.kind === 'system').length;
    await channels.update({ channelId: channel.id, budget: { daily: 0 } }, human);
    const notices = await systemPosts();
    await channels.react({ channelId: channel.id, postId: q3.id, emoji: '👍', on: true }, { kind: 'bot', botId: 'b_lynx' });
    await quietWait();
    t.ok('予算を使い切ったら、ほかの bot の 👍 では起きず、次に渡す（お知らせも出さない）', started.length === 9 && (await systemPosts()) === notices
      && (await d.inbox.list({ sessionId: ninth.sessionId, status: 'pending' })).some((i) => i.postId === q3.id && i.reaction?.byKey === 'bot:b_lynx' && i.reaction.quiet),
    JSON.stringify(await d.inbox.list({ sessionId: ninth.sessionId })));
    await channels.update({ channelId: channel.id, budget: { daily: 5 } }, human);
    await channels.react({ channelId: channel.id, postId: q3.id, emoji: '✅', on: true }, { kind: 'agent', sessionId: 's_chat' });
    const tenth = await nextStart(9, 'Chats の AI の ✅ で Owl が起きる');
    t.ok('予算が残っていれば、Chats の AI の ✅ でも起きる（待っていた bot の 👍 も一緒に渡る）', tenth.sessionId === ninth.sessionId
      && tenth.prompt.includes('reaction="✅"') && tenth.prompt.includes('reaction="👍"'), tenth.prompt);
    await finish(tenth, ['（なし）']);
    await channels.update({ channelId: channel.id, budget: { daily: 0 } }, human);
    await channels.react({ channelId: channel.id, postId: q3.id, emoji: '👍', on: true }, human);
    const eleventh = await nextStart(10, '人の 👍 で Owl が起きる');
    t.ok('AI の答えが先に起こした投稿でも人の 👍 はまた起こし、予算を使い切っていても止めない', eleventh.sessionId === ninth.sessionId
      && eleventh.prompt.includes('reaction="👍"') && eleventh.prompt.includes('from="あなた"'), eleventh.prompt);
    await finish(eleventh, ['（なし）']);
    await channels.update({ channelId: channel.id, budget: { daily: 5 } }, human);

    // ---- 起こさないリアクションは会話ごとに上限まで
    const s1 = first.sessionId;
    for (let i = 0; i < QUIET_REACTIONS + 5; i++) {
      await d.onReacted({ ...statement, reactions: {} }, await channels.get({ channelId: channel.id }), { emoji: '🎉', on: true, by: { kind: 'agent', sessionId: `s_agent_${i}` } });
    }
    t.ok(`起こさずに待たせるリアクションは会話ごとに ${QUIET_REACTIONS} 件まで`, (await d.inbox.list({ sessionId: s1, status: 'pending' })).filter((i) => i.reaction?.quiet).length === QUIET_REACTIONS);

    // ---- DM: bot の問いかけへの 👍 で DM の会話が起きる
    const dm = await channels.createDm({ bot: BOTS[0] });
    BOTS[0].dmChannelId = dm.id;
    sessions.s_dm = { bot: { botId: 'b_owl', kind: 'dm', channelId: dm.id, threadId: null, memRev: 0, snapshotDue: false, delivered: [], postCursor: null } };
    const dmQ = await channels.post({ channelId: dm.id, text: '明日の予定を入れておきましょうか？', turn: { botId: 'b_owl', sessionId: 's_dm' }, state: 'done' }, { kind: 'bot', botId: 'b_owl' });
    // DM には予算の数え先が無いので、ほかの bot の 👍 では起こさず次に渡す
    await channels.react({ channelId: dm.id, postId: dmQ.id, emoji: '👍', on: true }, { kind: 'bot', botId: 'b_lynx' });
    await quietWait();
    t.ok('DM の bot の問いかけへのほかの bot の 👍 では起きず、次に渡す', started.length === 11
      && (await d.inbox.list({ sessionId: 's_dm', status: 'pending' })).some((i) => i.postId === dmQ.id && i.reaction?.byKey === 'bot:b_lynx' && i.reaction.quiet));
    await channels.react({ channelId: dm.id, postId: dmQ.id, emoji: '🙆', on: true }, human);
    const dmRun = await nextStart(11, 'DM の 🙆 で Owl が起きる');
    t.ok('DM の bot の問いかけへの人の 🙆 で DM の会話が起きる（待っていた bot の 👍 も一緒に渡る）', dmRun.sessionId === 's_dm' && dmRun.prompt.includes('reaction="🙆"')
      && dmRun.prompt.includes('reaction="👍"'), dmRun.prompt);
    await finish(dmRun, []);
    const dmPosts = (await channels.read({ channelId: dm.id, limit: 100 })).posts.filter((p) => p.turn && !p.deletedAt);
    t.ok('文章を書かずに終えた DM のターンは投稿を残さない', dmPosts.length === 1 && dmPosts[0].id === dmQ.id, JSON.stringify(dmPosts));
  } finally {
    d.stop();
    await channels.close();
  }

  // ================================================================ サーバー越し（bots-host の配線。fake の bot）
  let server = null, c = null;
  try {
    server = await startServer({ env: { AGENT_HOST_BACKENDS: 'fake' }, dataDir: path.join(tmp, 'data'), timeoutMs: 60_000 });
    c = await open({ port: server.port, token: server.token });
    const call = (op, args) => c.cmd('invoke', { op, args });
    const owl = await call('bots.create', { name: 'Owl', icon: '🦉', backend: 'fake' });
    const dev = await call('channels.create', { name: 'dev' });
    const replies = async (rootId) => (await call('channels.read', { channelId: dev.id, threadId: rootId })).posts.filter((p) => p.turn?.botId === owl.id && !p.deletedAt);
    // 起こした回数（calls）が n に届き、idle に戻るまで待つ（投稿の直後はまだ起きていないことがある）
    const idle = (rootId, calls) => until(async () => { const th = (await call('channels.read', { channelId: dev.id, threadId: rootId })).threads[0]; return th?.state === 'idle' && th.calls >= calls; }, { ms: 20_000, label: 'thread idle' });

    const root = await call('channels.post', { channelId: dev.id, text: '@Owl echo:main に入れてよいですか？' });
    const asked = await until(async () => (await replies(root.id)).find((p) => p.state === 'done'), { ms: 20_000, label: '問いかけの返事' });
    await idle(root.id, 1);
    await call('channels.react', { channelId: dev.id, postId: asked.id, emoji: '👍' });
    // fake は包みの本文をそのまま返す: 2 つ目の返事に、リアクションの説明が入っていれば起きている
    const woke = await until(async () => (await replies(root.id)).find((p) => p.id !== asked.id && p.state === 'done'), { ms: 20_000, label: '👍 で起きた返事' });
    t.ok('サーバー越し: 人が channels.react で問いに 👍 → bot が起き、リアクションが届く', woke.text.includes('👍 が付きました') && woke.text.includes('main に入れてよいですか？'), woke.text);
    await idle(root.id, 2);

    const before = (await replies(root.id)).length;
    await call('channels.post', { channelId: dev.id, threadId: root.id, text: '@Owl echo:（なし）' });
    await idle(root.id, 3);
    t.ok('サーバー越し: 「（なし）」だけで終えたターンは投稿を残さない', (await replies(root.id)).length === before, JSON.stringify(await replies(root.id)));
    await call('channels.post', { channelId: dev.id, threadId: root.id, text: `@Owl echo:${SILENT_MARK}` });
    await idle(root.id, 4);
    t.ok('サーバー越し: 印だけで終えたターンは投稿を残さない', (await replies(root.id)).length === before);
  } finally {
    c?.close?.();
    await server?.stop?.();
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}
