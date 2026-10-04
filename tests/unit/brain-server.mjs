// 心拍を入れた bot（ADR 0126）をサーバー越しに通す。fake バックエンド（安いモデルの返事は AGENT_HOST_FAKE_PULSE の台本）。LLM もネットワークも使わない。
//   ① 心拍の設定は bots.update の pulse（広げる向きは guarded）。② ［今すぐ］の心拍 → 思考の流れの行・気がかり。③ 引き継ぎ → DM の賢いモデルのターン → 投稿・結果の行・予算。
//   ④ 黙る引き継ぎは投稿を残さない。⑤ 独り言が投稿に写らない。⑥ 呼ばれたターンの末尾に思考の流れの末尾と気がかり（心拍を入れた bot だけ）。
//   ⑦ 隠れた会話（pulse・learner）からの channels.* の書き込みは断る。
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../lib/server.mjs';
import { open, sleep } from '../lib/ws-client.mjs';
import { registry } from '../../core/ops/index.mjs';
import { createBotService } from '../../core/bots/service.mjs';
import { findLeaks } from '../../core/brain/inner.mjs';
import { openReadOnly } from '../../core/db.mjs';

export const name = 'brain-server';
export const title = '心拍を入れた bot: 設定・今すぐの心拍・引き継ぎ（話す・黙る）・予算・独り言が漏れない・呼ばれたターンの末尾・隠れた会話の書き込みの拒否';

const until = async (fn, { ms = 20_000, label = '' } = {}) => {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) { last = await fn(); if (last) return last; await sleep(40); }
  throw new Error(`timeout: ${label} ${JSON.stringify(last ?? null)?.slice(0, 600)}`);
};

export default async function (t) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'brain-server-'));
  const servers = [], clients = [];
  try {
    // ================================================================ bots.update の pulse（サーバー無し）
    {
      const bots = createBotService({ dataDir: path.join(tmp, 'plain'), channels: null });
      await bots.start();
      const bot = await bots.create({ name: 'Owl', backend: 'fake' }, { kind: 'human' });
      t.ok('新しい bot の心拍は止まっている（on: false・10 分・安いモデルも家のチャンネルも空）', JSON.stringify(bot.pulse) === JSON.stringify({ on: false, everyMin: 10, backend: '', model: '', channelId: '' }));
      const on = await bots.planUpdate({ botId: bot.id, pulse: { on: true } });
      t.ok('心拍を入れるのは広げる向き（AI が頼むと承認が要る）', on.loosens === true && on.reasons.includes('pulse') && on.rows[0].path === 'pulse' && on.next.pulse.on === true);
      await bots.update({ botId: bot.id, pulse: { on: true, everyMin: 30 } }, { kind: 'human' });
      t.ok('渡した欄だけ変わる（on と間隔）', (await bots.get({ botId: bot.id })).pulse.everyMin === 30 && (await bots.get({ botId: bot.id })).pulse.on === true);
      t.ok('止める・間隔を延ばすのは広げない', (await bots.planUpdate({ botId: bot.id, pulse: { on: false } })).loosens === false && (await bots.planUpdate({ botId: bot.id, pulse: { everyMin: 60 } })).loosens === false);
      t.ok('間隔を縮めるのは広げる向き', (await bots.planUpdate({ botId: bot.id, pulse: { everyMin: 10 } })).loosens === true);
      const bad = async (pulse) => bots.planUpdate({ botId: bot.id, pulse }).then(() => false, (e) => e.code === 'INVALID');
      t.ok('間隔は 5〜60 分の整数・知らないバックエンド・チャンネルでないものは断る', await bad({ everyMin: 4 }) && await bad({ everyMin: 61 }) && await bad({ everyMin: 7.5 }) && await bad({ on: 'yes' }) && await bad({ backend: 'nope' }) && await bad('x'));
      bots.stop();
    }

    // ================================================================ 隠れた会話（pulse・learner）からのチャンネルの書き込み（サーバー無し）
    {
      const calls = [];
      const channels = { post: async (a) => { calls.push('post'); return { id: 'p_1', ...a }; }, react: async () => { calls.push('react'); return {}; }, markRead: async () => { calls.push('markRead'); return {}; },
        stopThread: async () => { calls.push('stopThread'); return {}; }, create: async () => { calls.push('create'); return {}; }, update: async () => { calls.push('update'); return {}; },
        get: async () => ({ id: 'c_000000000aaaaaa', kind: 'channel', members: [] }), mentionsOf: async () => [], getPost: async () => null };
      const kinds = { s_pulse: { botId: 'b_1', kind: 'pulse' }, s_learner: { botId: 'b_learner', kind: 'learner' }, s_thread: { botId: 'b_1', kind: 'thread', threadId: 'p_t', channelId: 'c_000000000aaaaaa' } };
      const readonly = { scope: 'readonly', autonomy: 'ask' };
      const deps = { locale: 'ja', channels, botOfSession: async (id) => kinds[id] ?? null, modeOf: async () => readonly, audit: () => {}, bots: { approvalOf: async () => null } };
      const as = (sessionId) => ({ by: 'agent', via: 'mcp', sessionId });
      const cid = 'c_000000000aaaaaa';
      const writes = [['channels.post', { channelId: cid, text: 'こんにちは', threadId: 'p_t' }], ['channels.react', { channelId: cid, postId: 'p_x', emoji: '👍' }], ['channels.markRead', { channelId: cid }],
        ['channels.stopThread', { channelId: cid, threadId: 'p_t' }], ['channels.create', { name: 'x' }], ['channels.update', { channelId: cid, memo: 'x' }]];
      for (const session of ['s_pulse', 's_learner']) {
        const results = [];
        for (const [id, args] of writes) results.push([id, await registry.invoke(as(session), id, args, deps)]);
        t.ok(`隠れた会話（${session}）からのチャンネルの書き込みは、読み取りのモードでも通る post・react・stopThread も含めて全部断る（HIDDEN_CONVERSATION か READ_ONLY_MODE）`,
          results.every(([, r]) => r.ok === false && ['HIDDEN_CONVERSATION', 'READ_ONLY_MODE'].includes(r.code)), JSON.stringify(results.map(([id, r]) => [id, r.code])));
        t.ok(`  … modeGate: false の post・react・stopThread は、操作の本体に届く前に HIDDEN_CONVERSATION（${session}）`,
          results.filter(([id]) => ['channels.post', 'channels.react', 'channels.stopThread'].includes(id)).every(([, r]) => r.code === 'HIDDEN_CONVERSATION' && /隠れた会話/.test(r.error)));
      }
      t.ok('チャンネルの書き込みの本体は 1 度も呼ばれない', calls.length === 0, calls.join());
      const ok = await registry.invoke(as('s_thread'), 'channels.post', { channelId: cid, text: 'こんにちは', threadId: 'p_t' }, deps);
      const react = await registry.invoke(as('s_thread'), 'channels.react', { channelId: cid, postId: 'p_x', emoji: '👍' }, deps);
      t.ok('ふつうの bot の会話（thread）は、読み取りのモードでも今までどおり返事・リアクションできる', ok.ok === true && react.ok === true && calls.join() === 'post,react', JSON.stringify([ok, react]));
      const read = await registry.invoke(as('s_pulse'), 'channels.read', { channelId: cid }, { ...deps, channels: { ...channels, read: async () => ({ posts: [], threads: [], summaries: {}, nextBefore: null }) } });
      t.ok('読むことは隠れた会話にも許す（書き込みだけ断る）', read.ok === true);
    }

    // ================================================================ サーバー越し
    const dataDir = path.join(tmp, 'data');
    const script = path.join(tmp, 'pulse-answers.json');
    const why = 'echo:資料の進み具合はどうですか？';
    // 道具を 1 回使って、文章は書かずに終える（fake の台本 steps:。賢いモデルが黙る形）
    const silentWhy = 'steps:{"steps":[{"tool":"Grep","input":{"pattern":"資料"},"result":"確かめた"}]}';
    await fs.writeFile(script, JSON.stringify([
      { do: 'think', thought: '来週の発表の資料が気になる。進み具合を聞きたい', loops: [{ op: 'add', id: 'doc', text: '発表の資料の様子を聞く', wakeOn: 'word:資料' }] },
      { do: 'act', thought: '聞いてみよう', refs: ['doc'], handoff: { why } },
      { do: 'act', thought: '今回は黙って見ておく', handoff: { why: silentWhy } },
    ]));
    const server = await startServer({ env: { AGENT_HOST_BACKENDS: 'fake', AGENT_HOST_FAKE_USAGE: '1', AGENT_HOST_FAKE_PULSE: script }, dataDir, timeoutMs: 60_000 });
    const c = await open({ port: server.port, token: server.token });
    servers.push(server); clients.push(c);
    const call = (op, args) => c.cmd('invoke', { op, args });
    const owl = await call('bots.create', { name: 'Owl', icon: '🦉', backend: 'fake', persona: '調べ物が得意' });
    const lynx = await call('bots.create', { name: 'Lynx', icon: '🐺', backend: 'fake' });
    const dev = await call('channels.create', { name: 'dev', members: [owl.id, lynx.id] });
    const read = (channelId, threadId) => call('channels.read', { channelId, ...(threadId ? { threadId } : {}), limit: 100 });
    const view = (botId) => call('brain.view', { botId, limit: 100 });

    // ---- ① 設定
    const onBot = await call('bots.update', { botId: owl.id, pulse: { on: true } });
    t.ok('画面（人）から心拍を入れる。Lynx は止めたまま', onBot.pulse.on === true && (await call('bots.get', { botId: lynx.id })).pulse.on === false);
    const v0 = await view(owl.id);
    t.ok('brain.view: 流れ・気がかりは空。状態に家のチャンネル（入っている最初のチャンネル）と予算が出る', v0.stream.length === 0 && v0.loops.length === 0 && v0.status.on === true && v0.status.home.id === dev.id && v0.status.budget.tokensLeft === 1_500_000 && v0.status.budget.daily === 5);

    // ---- ② ［今すぐ］の心拍 → 思考の流れ・気がかり
    const human1 = await call('channels.post', { channelId: dev.id, text: '来週の発表の資料、まだ決まっていないんだよね' });
    const m1 = c.mark();
    const beat1 = await call('brain.beat', { botId: owl.id });
    t.ok('今すぐの心拍は、ふるいを通って安いモデルを 1 回呼ぶ（forced）', beat1.ran === true && beat1.gate.reason === 'forced' && beat1.did === 'think', JSON.stringify(beat1));
    const v1 = await view(owl.id);
    const think = v1.stream.find((r) => r.kind === 'think');
    t.ok('思考の流れに 1 行（独り言・使ったトークン・隠れた会話の id）。気がかりが開く（起こす条件つき）', think.text.includes('資料が気になる') && think.tokens.input > 0 && typeof think.meta.session === 'string' && v1.loops.length === 1 && v1.loops[0].id === 'doc' && v1.loops[0].wakeOn.word === '資料');
    t.ok('画面へ brainChanged が出る', c.since(m1).some((e) => e.type === 'brainChanged' && e.botId === owl.id));
    const hidden = (await c.cmd('listSessions')).filter((s) => s.bot?.kind === 'pulse');
    t.ok('安いモデルの隠れた会話は bot の会話（kind: pulse。画面は bot の会話を Chats の一覧に出さない）で、読み取りのモード（plan）。1 回の心拍に 1 つ', hidden.length === 1 && hidden[0].bot.botId === owl.id && hidden[0].mode === 'plan' && hidden[0].title.includes('Owl'));

    // ---- ③ 引き継ぎ → DM の賢いモデルのターン
    const beat2 = await call('brain.beat', { botId: owl.id });
    t.ok('2 回目の心拍は「確かめる・話す」。頼んだ行が流れに残る', beat2.did === 'act' && (await view(owl.id)).stream.some((r) => r.kind === 'act' && r.text === why));
    const dmId = (await call('bots.get', { botId: owl.id })).dmChannelId;
    const spoke = await until(async () => (await read(dmId)).posts.find((p) => p.author?.kind === 'bot' && p.state === 'done' && p.text) ?? null, { label: 'DM の投稿' });
    t.ok('賢いモデルが bot の DM（行き先が決まらなければ自分の DM）で起きて、今の言葉で話す（投稿になる）', spoke.text === '資料の進み具合はどうですか？' && spoke.author.botId === owl.id);
    const afterSpoke = await until(async () => { const v = await view(owl.id); return v.stream.find((r) => r.kind === 'result' && r.text.includes('話しかけた')) ? v : null; }, { label: '結果の行' });
    const act = afterSpoke.stream.find((r) => r.kind === 'act');
    const result = afterSpoke.stream.find((r) => r.kind === 'result');
    t.ok('結果の行（話しかけた：…）が、頼んだ行につながって流れに残る', result.text.includes('資料の進み具合はどうですか？') && result.refs.join() === String(act.seq) && result.meta.by === 'pulse');
    const dmSession = (await call('bots.get', { botId: owl.id })).dmSessionId;
    const hist = (await c.cmd('loadSession', { sessionId: dmSession })).messages;
    const innerRow = hist.find((m) => m.kind === 'contextNote' && m.tag === 'inner');
    t.ok('賢いモデルの会話の履歴には <pleiad-inner> の行（人の吹き出しにならない）。理由・思考の流れの末尾・気がかり・「そのまま写さない」が入る',
      innerRow && innerRow.body.includes(why) && innerRow.body.includes('聞いてみよう') && innerRow.body.includes('(doc)') && innerRow.body.includes('そのまま投稿に写さず') && !hist.some((m) => m.role === 'user' && !m.kind && String(m.text).includes('pleiad-inner')), JSON.stringify(innerRow)?.slice(0, 300));
    const rowsNow = (await view(owl.id)).stream;
    t.ok('独り言が投稿に写らない（思考の行の 40 字以上が投稿の本文にない）', findLeaks(rowsNow.slice().reverse(), spoke.text).length === 0 && !spoke.text.includes('聞いてみよう'));
    t.ok('起きたターンの投稿は DM の流れにあり、スレッドは作られない（DM の根の投稿）', spoke.threadId === null);

    // ---- ④ 黙る引き継ぎは投稿を残さない
    const beat3 = await call('brain.beat', { botId: owl.id });
    t.ok('3 回目の心拍も引き継ぎ（賢いモデルは道具を使うだけで、文章を書かずに終える）', beat3.did === 'act');
    const silent = await until(async () => { const v = await view(owl.id); return v.stream.find((r) => r.kind === 'result' && r.text.includes('黙った')) ? v : null; }, { label: '黙った行' });
    const dmPosts = (await read(dmId)).posts.filter((p) => p.author?.kind === 'bot' && !p.deletedAt);
    t.ok('黙って終えたターンは投稿を残さない。結果の行は「黙った」', dmPosts.length === 1 && silent.stream.some((r) => r.text === '（黙った）'));

    // ---- ⑤ 予算: 自発の分も数える
    const budget = (await view(owl.id)).status.budget;
    // 安いモデル 3 回 + 引き継ぎのターン 2 回。fake の usage は 1 回 入力 1000・出力 200・キャッシュ読み 900（読みは 1/10 で数える）
    t.ok('予算: 心拍と引き継ぎの分がトークンの 1 日の上限から引かれる（5 回分）', budget.tokensLeft <= 1_500_000 - 5 * 1290 && budget.tokensLeft > 1_500_000 - 6 * 1290, JSON.stringify(budget));
    const info = await call('channels.get', { channelId: dev.id });
    t.ok('チャンネルの予算の定義は変わらない（今日の分は頭の中の行に持つ。スレッドの行を作らない）', info.budget === undefined || info.budget.daily === 5);

    // ---- ⑥ 呼ばれたターンの末尾
    const asked = await call('channels.post', { channelId: dev.id, text: '@Owl notes:' });
    const noted = await until(async () => (await read(dev.id, asked.id)).posts.find((p) => p.author?.botId === owl.id && p.state === 'done' && p.text) ?? null, { label: 'Owl の notes' });
    const notes = JSON.parse(noted.text);
    const inner = notes.find((n) => n.startsWith('<pleiad-inner kind="tail"'));
    t.ok('心拍を入れた bot は、呼ばれたターンの末尾に思考の流れの末尾と気がかり（<pleiad-inner kind="tail">）が付く', inner && inner.includes('資料が気になる') && inner.includes('(doc) 発表の資料の様子を聞く') && inner.includes('そのまま投稿に写さず'), JSON.stringify(notes).slice(0, 300));
    const lynxAsked = await call('channels.post', { channelId: dev.id, text: '@Lynx notes:' });
    const lynxNoted = await until(async () => (await read(dev.id, lynxAsked.id)).posts.find((p) => p.author?.botId === lynx.id && p.state === 'done' && p.text) ?? null, { label: 'Lynx の notes' });
    t.ok('心拍を入れていない bot には付かない（今までと同じ）', !lynxNoted.text.includes('pleiad-inner'));
    const answered = await until(async () => { const v = await view(owl.id); return v.stream.find((r) => r.kind === 'result' && r.text.includes('呼ばれて答えた')) ?? null; }, { label: '呼ばれた結果の行' });
    t.ok('呼ばれたターンの後も、結果の 1 行が流れにつながる（呼ばれて答えた：#dev — …）', answered.text.includes('#dev') && answered.meta.threadId === asked.id);
    t.ok('心拍を入れていない bot の流れには何も足さない', (await view(lynx.id)).stream.length === 0);

    // ---- 行き先のスレッドへの引き継ぎ・走っているターンには途中送信しない・［止める］で取り消す
    const answers = JSON.parse(await fs.readFile(script, 'utf8'));
    const turnsOf = (sessionId) => c.since(0).filter((e) => e.type === 'turnEnd' && e.sessionId === sessionId).length;
    await fs.writeFile(script, JSON.stringify([...answers, { do: 'act', thought: 'スレッドで続けよう', handoff: { why: 'echo:スレッドの続きです', where: asked.id } }]));
    const owlThread = (await read(dev.id, asked.id)).threads[0].sessions[owl.id];
    const before = turnsOf(owlThread);
    await call('brain.beat', { botId: owl.id });
    const inThread = await until(async () => (await read(dev.id, asked.id)).posts.find((p) => p.author?.botId === owl.id && p.text === 'スレッドの続きです') ?? null, { label: 'スレッドの投稿' });
    t.ok('行き先（where）のスレッドに bot の会話があれば、その会話で起きる（DM ではなくそのスレッドの投稿になる）', inThread.threadId === asked.id && turnsOf(owlThread) === before + 1);
    const slow = await call('channels.post', { channelId: dev.id, text: '@Lynx slow' });
    await until(async () => (await read(dev.id, slow.id)).posts.find((p) => p.author?.botId === lynx.id && p.state === 'working') ?? null, { label: 'Lynx が作業中' });
    await call('bots.update', { botId: lynx.id, pulse: { on: true } });
    await fs.writeFile(script, JSON.stringify([...answers, { do: 'act', thought: 'スレッドで続けよう', handoff: { why: 'echo:スレッドの続きです', where: asked.id } }, { do: 'act', thought: '走っている最中のスレッドへ', handoff: { why: 'echo:止められるはず', where: slow.id } }]));
    await call('brain.beat', { botId: lynx.id });
    const items = async () => JSON.parse(await fs.readFile(path.join(dataDir, 'channels', 'inbox.json'), 'utf8')).items.filter((i) => i.inner && i.botId === lynx.id);
    const pending = await until(async () => { const list = await items(); return list.length ? list : null; }, { label: '引き継ぎの出来事' });
    t.ok('走っているターンには途中送信せず、pending のまま待つ（inner は新しいターンで渡す）', pending[0].status === 'pending' && pending[0].threadId === slow.id && pending[0].postId === null);
    await call('channels.stopThread', { channelId: dev.id, threadId: slow.id });
    await until(async () => (await read(dev.id, slow.id)).threads[0].state === 'idle' ? true : null, { label: 'スレッドが止まる' });
    await sleep(300);
    t.ok('［止める］で、待っていた引き継ぎの出来事も取り消され、新しいターンは走らない', (await items()).length === 0 && !(await read(dev.id, slow.id)).posts.some((p) => p.text === '止められるはず'));

    // ---- 人が気がかりを足す・手放す・眠らせる・消す
    const added = await call('brain.loopAdd', { botId: owl.id, text: '金曜までに確認', wakeOn: 'thread:p_9', due: '2099-12-31T10:00' });
    t.ok('気がかりを足せる（人）。起こす条件・期限が形になる', added.id && (await view(owl.id)).loops.some((l) => l.id === added.id && l.wakeOn.thread === 'p_9' && l.due > 0));
    await call('brain.loopResolve', { botId: owl.id, id: added.id, status: 'dropped' });
    const afterDrop = await view(owl.id);
    t.ok('手放すと開いている一覧から外れ、閉じたものに移る', !afterDrop.loops.some((l) => l.id === added.id) && afterDrop.closed.some((l) => l.id === added.id && l.status === 'dropped'));
    const paused = await call('brain.pause', { botId: owl.id, paused: true });
    t.ok('眠らせると、状態に出て、［今すぐ］でも動かない（paused）', paused.paused === true && (await view(owl.id)).status.paused === true && (await call('brain.beat', { botId: owl.id })).gate.reason === 'paused');
    await call('brain.pause', { botId: owl.id, paused: false });
    const cleared = await call('brain.clear', { botId: owl.id });
    const v9 = await view(owl.id);
    t.ok('流れを消す（人）。気がかりも消え、予算の使った分は残る', cleared.stream > 0 && v9.stream.length === 0 && v9.loops.length === 0 && v9.status.budget.tokensLeft < 1_500_000);
    void human1;

    // ---- DB の形: 追記の行・JSON のファイルを増やさない
    const files = await fs.readdir(dataDir);
    t.ok('保存は pleiad.db の行で、頭の中の JSON ファイルを作らない', !files.some((f) => /brain|stream|loops/.test(f)));

    // ---- bot を消すと、その bot の思考の流れ・気がかりも消える
    const gone = await call('bots.create', { name: 'Tmp', icon: '🐭', backend: 'fake' });
    await call('brain.loopAdd', { botId: gone.id, text: '消える前のメモ' });
    await call('bots.delete', { botId: gone.id });
    await c.close();
    clients.length = 0;
    await servers.pop().stop();
    const db = openReadOnly(dataDir);
    const left = (table) => Number(db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE bot_id = ?`).get(gone.id).n);
    t.ok('bot を消すと、その bot の気がかりも思考の流れも消える', left('brain_loops') === 0 && left('brain_stream') === 0);
    db.close();
  } finally {
    for (const c of clients) { try { c.close(); } catch { /* 閉じるだけ */ } }
    for (const s of servers) await s.stop?.();
    await fs.rm(tmp, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
  }
}
