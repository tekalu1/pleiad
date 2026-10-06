// 聞こえた投稿が誰との話の続きか（ADR 0128 の追記）。本物のチャンネルのサービスに身代わりの会話をつなぐ。LLM は使わない。
//   引用: 人の投稿の `>` の引用がスレッドの bot の投稿と一致すれば、聞こえた投稿の包みに to="<その bot>" を付ける。
//   引用が無い・当たらない: そのスレッドで直前に人と話していた bot（宛先）を to に付ける。受け取る bot 自身なら付けない。
//   包みに足すのは bot の名前だけで、bot の思考は入らない。
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { sleep } from '../lib/ws-client.mjs';
import { createChannelService } from '../../core/channels/service.mjs';
import { createDispatcher } from '../../core/bots/dispatch.mjs';
import { quoteBlocks, quotedPost, QUOTE_MIN_CHARS } from '../../core/bots/quotes.mjs';

export const name = 'bot-heard-addressee';
export const title = '聞こえた投稿の宛先の手がかり（引用した bot・無ければ直前に話した bot を包みの to に付ける。自分なら付けない。思考は入れない）';

const until = async (fn, { ms = 5000, label = '' } = {}) => {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) { last = await fn(); if (last) return last; await sleep(20); }
  throw new Error(`timeout: ${label} ${JSON.stringify(last ?? null)?.slice(0, 400)}`);
};

export default async function (t) {
  // ================================================================ 引用の読み方（純粋）
  {
    t.ok('引用のまとまり: `>` の行を印と空白を外してつなぐ。空行で分かれたら別のまとまり。コードの囲みの中は数えない',
      JSON.stringify(quoteBlocks('> 手順は\n> 3 段に分ける\n\nそれで\n>> 入れ子の引用です\n```\n> コードの中\n```')) === JSON.stringify(['手順は3段に分ける', '入れ子の引用です']),
      JSON.stringify(quoteBlocks('> 手順は\n> 3 段に分ける\n\nそれで\n>> 入れ子の引用です\n```\n> コードの中\n```')));
    t.ok(`${QUOTE_MIN_CHARS} 字に満たない引用は手がかりにしない`, quoteBlocks('> はい\n> \nOK').length === 0);
    const posts = [
      { id: 'a', author: { kind: 'bot', botId: 'b_mike' }, text: '**デプロイ**は 3 段に\n分けるのがよいと思います。' },
      { id: 'b', author: { kind: 'bot', botId: 'b_hana' }, text: 'テストは先に流しておきます。' },
      { id: 'c', author: { kind: 'bot', botId: 'b_taro' }, text: 'テストは先に流しておきます。' },
    ];
    t.ok('強調の印・改行・全角半角の違いがあっても、表示された文を写した引用は当たる', quotedPost('> デプロイは 3 段に分けるのがよいと思います。\nそれで', posts)?.id === 'a');
    t.ok('同じ文の投稿が複数なら、いちばん新しいもの', quotedPost('> テストは先に流しておきます\nありがとう', posts)?.id === 'c');
    t.ok('まとまりが複数なら、後ろのまとまりから見る', quotedPost('> デプロイは 3 段に分ける\n前半はよい\n\n> テストは先に流して\nこちらは待って', posts)?.id === 'c');
    t.ok('当たらない・引用が無いなら null', quotedPost('> だれも書いていない文です\nどう？', posts) === null && quotedPost('テストは先に流しておきます。', posts) === null);
  }

  // ================================================================ 本物のチャンネルのサービスと身代わりの会話
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'bot-heard-'));
  const human = { kind: 'human' };
  const BOTS = [
    { id: 'b_mike', name: 'Michael', icon: '🦁', dmChannelId: null, dmSessionId: null },
    { id: 'b_hana', name: 'Hanako', icon: '🌸', dmChannelId: null, dmSessionId: null },
    { id: 'b_taro', name: 'Taro', icon: '🐯', dmChannelId: null, dmSessionId: null },
  ];
  const label = (id) => { const b = BOTS.find((x) => x.id === id); return `${b.icon} ${b.name} (bot)`; };
  const sessions = {};
  const started = [];     // runTurn に渡った { sessionId, prompt, turn }
  const turns = new Map();
  let d = null;
  const channels = createChannelService({
    dir: path.join(tmp, 'channels'), listBots: async () => BOTS,
    hooks: { posted: (...a) => d.onPosted(...a), reacted: (...a) => d.onReacted(...a), stopThread: (...a) => d.stopThread(...a), botPost: (a) => d.claimPost(a) },
  });
  const host = {
    dataDir: tmp,
    store: { get: async (id) => structuredClone(sessions[id] ?? {}), setSessionData: async (id, f, v) => { sessions[id] = { ...sessions[id], [f]: v }; } },
    runtime: { turns }, noticeTarget: async () => null, noticeBlocked: async () => false,
    agentLocaleFor: async () => 'ja', currentLocale: () => 'ja', emitSession: () => {}, abortSessions: async () => {},
    // ターンの記録ができてから数える。ターンの中身と終わりはテストが onTurnEvent・onTurnEnd で進める
    runTurn: async (args) => {
      const turn = { info: { sessionId: args.sessionId }, agentLocale: 'ja', usage: {}, stream: {} };
      turns.set(args.sessionId, turn);
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

  const finish = async (run, texts, { thinking = '' } = {}) => {
    if (thinking) d.onTurnEvent(run.turn, { type: 'thinking.delta', text: thinking });
    for (const text of texts) {
      d.onTurnEvent(run.turn, { type: 'text.delta', text });
      d.onTurnEvent(run.turn, { type: 'text.end' });
    }
    turns.delete(run.sessionId);
    await d.onTurnEnd(run.turn, { outcome: 'ok' });
  };
  const runOf = (botId, after, what) => until(() => started.slice(after).find((s) => s.sessionId.startsWith(`s_${botId}_`)), { label: `${what}: ${botId}` });
  const toAttr = (prompt) => /<pleiad-channel [^>]*heard="true"[^>]*>/.exec(prompt)?.[0].match(/ to="([^"]*)"/)?.[1] ?? null;

  try {
    const channel = await channels.create({ name: 'dev', members: BOTS.map((b) => b.id) }, human);
    const root = await channels.post({ channelId: channel.id, text: '@Michael @Hanako @Taro リリースの段取りを決めたい' }, human);
    await until(() => started.length >= 3, { label: '3 体が @ で起きる' });
    const said = { b_mike: 'デプロイは 3 段に分けるのがよいと思います。', b_hana: 'テストは先に流しておきます。', b_taro: '了解です。' };
    for (const id of ['b_mike', 'b_hana', 'b_taro']) await finish(await runOf(id, 0, '最初のターン'), [said[id]], { thinking: `${id} のひみつの考え` });
    const thread = (await channels.read({ channelId: channel.id, threadId: root.id, limit: 100 })).posts.filter((p) => p.turn && !p.deletedAt);
    t.ok('前提: 3 体の返事が並び、最後に話したのは Taro', thread.length === 3 && thread.at(-1).author.botId === 'b_taro', JSON.stringify(thread.map((p) => [p.author.botId, p.text])));

    // ---- 引用で Michael 宛てと分かる: 宛先（最後に話した Taro）は今までどおり受け、聞こえた Hanako の包みに to="Michael"、Michael 自身には付けない
    let mark = started.length;
    await channels.post({ channelId: channel.id, threadId: root.id, text: `> ${said.b_mike}\nそれでお願いします` }, human);
    const taro1 = await runOf('b_taro', mark, '宛先の Taro');
    t.ok('宛先（直前に話した bot）は今までどおり自分あてで受ける（heard も to も付かない）', !taro1.prompt.includes('heard="true"') && !taro1.prompt.includes(' to="'), taro1.prompt);
    await finish(taro1, []);
    const hana1 = await runOf('b_hana', mark, '聞こえた Hanako'), mike1 = await runOf('b_mike', mark, '聞こえた Michael');
    t.ok('引用が Michael の投稿と一致する: 聞こえた Hanako の包みに to="🦁 Michael (bot)"', toAttr(hana1.prompt) === label('b_mike'), hana1.prompt);
    t.ok('手がかりが自分（Michael）なら to は付けない（heard="true" のまま）', mike1.prompt.includes('heard="true"') && !mike1.prompt.includes(' to="'), mike1.prompt);
    t.ok('包みに bot の思考は入らない', ![hana1, mike1].some((r) => r.prompt.includes('ひみつの考え')));
    await finish(hana1, []);
    await finish(mike1, []);

    // ---- 引用が無い: 直前に人と話していた bot（Taro）を to に付ける
    mark = started.length;
    await channels.post({ channelId: channel.id, threadId: root.id, text: '次はどうしますか' }, human);
    const taro2 = await runOf('b_taro', mark, '宛先の Taro');
    await finish(taro2, ['タグを打ちます。']);
    const hana2 = await runOf('b_hana', mark, '聞こえた Hanako'), mike2 = await runOf('b_mike', mark, '聞こえた Michael');
    t.ok('引用が無ければ、直前に話していた Taro の名前が聞こえた投稿の to に付く（Hanako・Michael とも）', toAttr(hana2.prompt) === label('b_taro') && toAttr(mike2.prompt) === label('b_taro'),
      `${hana2.prompt}\n----\n${mike2.prompt}`);
    await finish(hana2, []);
    await finish(mike2, []);

    // ---- 引用がどの bot の投稿にも当たらない: 直前に話していた bot（Taro）に戻る
    mark = started.length;
    await channels.post({ channelId: channel.id, threadId: root.id, text: '> だれも書いていない文を引用します\nこれはどう？' }, human);
    const taro3 = await runOf('b_taro', mark, '宛先の Taro');
    await finish(taro3, []);
    const hana3 = await runOf('b_hana', mark, '聞こえた Hanako');
    t.ok('引用がどの bot の投稿にも当たらなければ、直前に話していた bot を to に付ける', toAttr(hana3.prompt) === label('b_taro'), hana3.prompt);
    await finish(hana3, []);
    await finish(await runOf('b_mike', mark, '聞こえた Michael'), []);
    const items = await d.inbox.list({});
    t.ok('出来事の heardTo は聞こえた投稿にだけ残り、受け取る bot 自身の id は残さない', items.filter((i) => i.heardTo).every((i) => i.heard && i.heardTo !== i.botId)
      && items.some((i) => i.botId === 'b_hana' && i.heardTo === 'b_mike') && !items.some((i) => !i.heard && i.heardTo), JSON.stringify(items.map((i) => [i.botId, i.heard ?? false, i.heardTo ?? null])));
  } finally {
    d.stop();
    await channels.close();
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}
