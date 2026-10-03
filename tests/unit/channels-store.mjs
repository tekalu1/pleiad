// チャンネルの保存（core/channels/store.mjs・threads.mjs・service.mjs）: index.json・追記だけの .jsonl と畳み込み・壊れた最後の行・
// 既読・threads.json・サービスの投稿/編集/削除/リアクション/スレッド/検索と出来事。実ファイルを一時ディレクトリに置いて確かめる（サーバーは立てない）。
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createChannelStore, foldLines, foldOp } from '../../core/channels/store.mjs';
import { createThreadStore } from '../../core/channels/threads.mjs';
import { ChannelError, createChannelService, isSingleEmoji, normalizeChannelName } from '../../core/channels/service.mjs';
import { newId } from '../../core/channels/types.mjs';
import { openReadOnly, openRaw, dbPath } from '../../core/db.mjs';

export const name = 'channels-store';
export const title = 'チャンネルの保存: index.json・.jsonl の追記と畳み込み・壊れた行・既読・threads.json・投稿とリアクションと出来事';

const HUMAN = { kind: 'human' };
const BOT = { kind: 'bot', botId: 'b_owl' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const codeOf = async (fn) => { try { await fn(); return null; } catch (e) { return e instanceof ChannelError ? e.code : `other:${e.message}`; } };
const exists = (p) => fs.stat(p).then(() => true, () => false);

export default async function (t) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'channels-store-'));
  const services = [], threadStores = [];
  const makeService = (name, options) => { const service = createChannelService({ dir: path.join(tmp, name, 'channels'), ...options }); services.push(service); return service; };
  try {
    // ---- 畳み込み（純粋）
    const post = (id, over = {}) => ({ op: 'post', post: { id, channelId: 'c_a', threadId: null, author: HUMAN, text: `本文 ${id}`, mentions: [], at: 1000, reactions: {}, ...over } });
    const folded = foldLines([
      JSON.stringify(post('p_1')),
      JSON.stringify({ op: 'edit', id: 'p_1', text: '直した', at: 2000 }),
      JSON.stringify({ op: 'react', id: 'p_1', emoji: '👍', by: HUMAN, on: true, at: 2100 }),
      JSON.stringify({ op: 'react', id: 'p_1', emoji: '👍', by: HUMAN, on: true, at: 2200 }),
      JSON.stringify({ op: 'react', id: 'p_1', emoji: '👍', by: BOT, on: true, at: 2300 }),
      JSON.stringify({ op: 'react', id: 'p_1', emoji: '🎉', by: BOT, on: true, at: 2400 }),
      JSON.stringify({ op: 'react', id: 'p_1', emoji: '🎉', by: BOT, on: false, at: 2500 }),
      JSON.stringify({ op: 'edit', id: 'p_nope', text: 'x', at: 1 }),
      JSON.stringify(post('p_2')),
      JSON.stringify({ op: 'delete', id: 'p_2', at: 3000 }),
      JSON.stringify({ op: 'edit', id: 'p_2', text: '消した後の編集', at: 3100 }),
      JSON.stringify({ op: 'react', id: 'p_2', emoji: '👍', by: HUMAN, on: true, at: 3200 }),
      JSON.stringify(post('p_1', { text: '同じ id の二重の追加は無視' })),
    ].join('\n'));
    const p1 = folded.posts.get('p_1');
    t.ok('畳み込み: 編集は本文と editedAt・同じ発言者の二重の付けは 1 つ・外すと消える', p1.text === '直した' && p1.editedAt === 2000 && p1.reactions['👍']?.length === 2 && !p1.reactions['🎉'], JSON.stringify(p1.reactions));
    t.ok('畳み込み: 無い投稿への操作・同じ id の二重の追加は何もしない', folded.posts.size === 2 && folded.skipped === 0 && p1.at === 1000);
    const p2 = folded.posts.get('p_2');
    t.ok('畳み込み: 削除は本文とリアクションを空にして deletedAt を残し、その後の編集・リアクションは効かない', p2.deletedAt === 3000 && p2.text === '' && Object.keys(p2.reactions).length === 0);
    const noEdit = foldLines([
      JSON.stringify(post('p_h', { text: '人の投稿' })),
      JSON.stringify({ op: 'edit', id: 'p_h', text: '人の投稿', mentions: ['b_owl'], at: 2000 }), // 本文は同じ（付帯情報だけ）
      JSON.stringify({ op: 'edit', id: 'p_h', state: 'done', at: 2100 }),
      JSON.stringify(post('p_t', { author: BOT, text: '…', state: 'working', turn: { botId: 'b_owl', sessionId: 's' } })),
      JSON.stringify({ op: 'edit', id: 'p_t', text: '返答が入る', state: 'done', at: 2200 }), // bot のターンの投稿が埋まるのは編集ではない
    ].join('\n')).posts;
    t.ok('畳み込み: 本文が変わっていない編集（付帯情報だけ）と bot のターンの投稿が埋まる更新は editedAt を立てない',
      noEdit.get('p_h').editedAt === undefined && noEdit.get('p_h').mentions.join() === 'b_owl' && noEdit.get('p_t').editedAt === undefined && noEdit.get('p_t').text === '返答が入る');
    const posts = new Map();
    t.ok('foldOp: 形の違う操作・知らない op は null', foldOp(posts, null) === null && foldOp(posts, { op: 'zzz', id: 'p_1' }) === null && foldOp(posts, { op: 'post', post: {} }) === null);

    // ---- 壊れた行
    const damaged = foldLines(`${JSON.stringify(post('p_a'))}\nこれは JSON ではない\n${JSON.stringify(post('p_b'))}\n[1,2]\n{"op":"post","post":{"id":"p_c","tex`);
    t.ok('壊れた行（途中で切れた最後の行・JSON でない行）は飛ばして数え、前後の行は読む', [...damaged.posts.keys()].join() === 'p_a,p_b' && damaged.skipped === 3, `${[...damaged.posts.keys()]} ${damaged.skipped}`);

    // ---- ChannelStore: index.json
    const dirA = path.join(tmp, 'a');
    const store = createChannelStore({ dir: dirA });
    t.ok('index.json が無ければ空', (await store.channels()).length === 0 && !(await exists(path.join(dirA, 'index.json'))));
    const ch = { id: newId('channel'), kind: 'channel', name: 'general', purpose: '', cwd: null, members: [], memo: '', createdAt: 1, lastPostAt: 1 };
    await store.saveChannel(ch);
    await store.saveChannel({ ...ch, name: 'general2' });
    t.ok('saveChannel は同じ id なら置き換える。index.json に version: 1 で書く', (await store.channels()).length === 1 && (await store.channel(ch.id)).name === 'general2'
      && JSON.parse(await fs.readFile(path.join(dirA, 'index.json'), 'utf8')).version === 1);
    const copy = await store.channel(ch.id);
    copy.name = '書き換え';
    t.ok('返りは写し（呼び出し側が直しても保存の状態は変わらない）', (await store.channel(ch.id)).name === 'general2');
    t.ok('updateChannel は 1 か所だけ直す。無い id は null', (await store.updateChannel(ch.id, (c) => ({ ...c, memo: 'm' }))).memo === 'm' && (await store.updateChannel('c_nope000', (c) => c)) === null);
    t.ok('既読は進める向きにだけ動く', (await store.setReadState(ch.id, { readAt: 500, mentionAt: 400 })).readAt === 500
      && (await store.setReadState(ch.id, { readAt: 100, mentionAt: 900 })).readAt === 500 && (await store.readState(ch.id)).mentionAt === 900 && (await store.readState('c_none0000')).readAt === 0);
    const reopened = createChannelStore({ dir: dirA });
    t.ok('開き直しても定義と既読が残る', (await reopened.channel(ch.id)).memo === 'm' && (await reopened.readState(ch.id)).readAt === 500);

    // ---- ChannelStore: .jsonl（追記・順序・壊れた最後の行）
    const log = path.join(dirA, `${ch.id}.jsonl`);
    const base = { channelId: ch.id, threadId: null, author: HUMAN, mentions: [], reactions: {} };
    await Promise.all(Array.from({ length: 20 }, (_, i) => store.append(ch.id, { op: 'post', post: { ...base, id: `p_${String(i).padStart(2, '0')}`, text: `t${i}`, at: 1000 + i } })));
    const lines = (await fs.readFile(log, 'utf8')).split('\n').filter(Boolean);
    t.ok('並べて追記しても 1 行 1 操作で、呼んだ順に並ぶ（チャンネルごとの直列化）', lines.length === 20 && lines.every((l) => JSON.parse(l).op === 'post') && JSON.parse(lines[7]).post.id === 'p_07');
    const edited = await store.append(ch.id, { op: 'edit', id: 'p_03', text: '直し', at: 5000 });
    t.ok('append は対象の投稿（写し）を返す。snapshot は追記の順の畳んだ並び', edited.text === '直し' && (await store.snapshot(ch.id)).length === 20 && (await store.snapshot(ch.id))[3].text === '直し');
    await fs.appendFile(log, '{"op":"post","post":{"id":"p_cut","te'); // クラッシュで切れた最後の行（改行なし）
    const afterCrash = createChannelStore({ dir: dirA });
    t.ok('最後の行が切れていても、それまでを読み、飛ばした数を出す', (await afterCrash.snapshot(ch.id)).length === 20 && (await afterCrash.stats(ch.id)).skipped === 1);
    await afterCrash.append(ch.id, { op: 'post', post: { ...base, id: 'p_after', text: '壊れた後', at: 9000 } });
    const raw = await fs.readFile(log, 'utf8');
    t.ok('次の追記は先に改行を足し、壊れた行を単独の行にとどめる（新しい操作を巻き込まない）', /te\n\{"op":"post",.*"id":"p_after"/.test(raw), raw.slice(-120));
    const again = createChannelStore({ dir: dirA });
    t.ok('開き直すと、壊れた行 1 つを飛ばして新しい投稿まで読める', (await again.snapshot(ch.id)).at(-1).id === 'p_after' && (await again.stats(ch.id)).skipped === 1);
    t.ok('投稿が無いチャンネルは空（ファイルも作らない）', (await store.snapshot('c_empty000')).length === 0 && !(await exists(path.join(dirA, 'c_empty000.jsonl'))));
    t.ok('不正なチャンネル id は拒む（パスにならない）', (await store.append('../evil', { op: 'post', post: { ...base, id: 'p_x' } }).then(() => 'ok', () => 'rejected')) === 'rejected');

    // ---- index.json の壊れ・読めない版は上書きせずに投げる
    const dirB = path.join(tmp, 'b');
    await fs.mkdir(dirB, { recursive: true });
    await fs.writeFile(path.join(dirB, 'index.json'), '{壊れた');
    const brokenStore = createChannelStore({ dir: dirB });
    t.ok('壊れた index.json は読めずに投げ、ファイルを書き換えない', (await brokenStore.channels().then(() => 'ok', (e) => e.message)).includes('index.json') && (await fs.readFile(path.join(dirB, 'index.json'), 'utf8')) === '{壊れた');
    t.ok('保存も投げて、壊れたファイルを新しい状態で消さない', (await brokenStore.saveChannel(ch).then(() => 'ok', () => 'rejected')) === 'rejected' && (await fs.readFile(path.join(dirB, 'index.json'), 'utf8')) === '{壊れた');
    await fs.writeFile(path.join(dirB, 'index.json'), JSON.stringify({ version: 2, channels: [] }));
    t.ok('知らない版は読み込まない', (await createChannelStore({ dir: dirB }).channels().then(() => 'ok', (e) => e.message)).includes('version 2'));

    // ---- ThreadStore（SQLite の channel_threads。ADR 0115）
    const dirT = path.join(tmp, 't', 'channels');
    const threads = createThreadStore({ dir: dirT, now: () => 777 });
    threadStores.push(threads);
    t.ok('無いスレッドは null・一覧は空', (await threads.get('c_a', 'p_1')) === null && (await threads.list()).length === 0);
    const th1 = await threads.update('c_a', 'p_1', { sessions: { b_owl: 's_1' }, state: 'working', calls: 1 });
    t.ok('update は空の状態から作り、欄を重ねる（sessions は bot ごと）', th1.state === 'working' && th1.sessions.b_owl === 's_1' && th1.calls === 1 && th1.updatedAt === 777 && th1.stopped === null && th1.tokens.input === 0);
    const th2 = await threads.update('c_a', 'p_1', (cur) => ({ sessions: { b_lynx: 's_2' }, tokens: { input: cur.tokens.input + 10, output: 5 }, calls: cur.calls + 1 }));
    t.ok('関数で渡すと今の値から計算できる（トークンの足し算）。sessions は足される', th2.sessions.b_owl === 's_1' && th2.sessions.b_lynx === 's_2' && th2.tokens.input === 10 && th2.tokens.output === 5 && th2.calls === 2);
    t.ok('sessions の null はその bot の会話を外す', !('b_owl' in (await threads.update('c_a', 'p_1', { sessions: { b_owl: null } })).sessions));
    t.ok('不正な state・stopped は投げる（保存しない）', (await threads.update('c_a', 'p_1', { state: 'zzz' }).then(() => 'ok', () => 'rejected')) === 'rejected'
      && (await threads.update('c_a', 'p_1', { stopped: { by: { kind: 'bot' }, at: 1 } }).then(() => 'ok', () => 'rejected')) === 'rejected' && (await threads.get('c_a', 'p_1')).state === 'working');
    // S-3(b): bot が自分のスレッドから起こして新しくできたスレッドの、起こした元（origin）
    const orig = await threads.update('c_a', 'p_child', { origin: { channelId: 'c_a', threadId: 'p_1' } });
    t.ok('origin: { channelId, threadId } を残し、写しを返す。無いスレッドには付かない', orig.origin.threadId === 'p_1' && orig.origin.channelId === 'c_a' && !('origin' in th1) && !('origin' in (await threads.get('c_a', 'p_1'))));
    t.ok('origin は他の更新で消えない・null で外せる', (await threads.update('c_a', 'p_child', { state: 'working' })).origin.threadId === 'p_1' && !('origin' in (await threads.update('c_a', 'p_child', { origin: null }))));
    t.ok('不正な origin は投げる（保存しない）', (await threads.update('c_a', 'p_child', { origin: { channelId: 'c_a' } }).then(() => 'ok', () => 'rejected')) === 'rejected' && !('origin' in (await threads.get('c_a', 'p_child'))));
    await threads.update('c_b', 'p_9', { state: 'waiting' });
    await threads.update('c_a', 'p_child', { state: 'idle' });
    const reThreads = createThreadStore({ dir: dirT });
    threadStores.push(reThreads);
    t.ok('開き直しても残り、channelId で絞れる', (await reThreads.list()).length === 3 && (await reThreads.list('c_b')).length === 1 && (await reThreads.get('c_b', 'p_9')).state === 'waiting');
    const rowReader = openReadOnly(path.join(tmp, 't'));
    try {
      const rows = rowReader.prepare('SELECT thread_key, channel_id FROM channel_threads ORDER BY thread_key').all();
      t.ok('スレッドの状態は DB の 1 スレッド 1 行（threads.json は作らない）', rows.length === 3 && rows.every(row => row.thread_key.startsWith(`${row.channel_id}/`)) && !(await fs.stat(path.join(dirT, 'threads.json')).then(() => true, () => false)));
    } finally { rowReader.close(); }
    const failingTable = createThreadStore({ dir: path.join(tmp, 'blocked', 'channels') });
    threadStores.push(failingTable);
    await failingTable.update('c_z', 'p_1', { state: 'working' });
    const blocker = openRaw(dbPath(path.join(tmp, 'blocked')));
    blocker.exec('BEGIN IMMEDIATE');
    const refused = await failingTable.update('c_z', 'p_1', { state: 'idle' }).then(() => 'ok', () => 'rejected');
    blocker.exec('ROLLBACK'); blocker.close();
    t.ok('DB に書けなければ投げ、メモリのスレッドの状態は書く前のまま（DB を先に書く）', refused === 'rejected' && (await failingTable.get('c_z', 'p_1')).state === 'working');

    // ---- サービス
    let clock = 10_000;
    const events = [];
    const hooked = [];
    const botList = [{ id: 'b_owl', name: 'Owl' }, { id: 'b_lynx', name: 'Lynx' }];
    const svc = makeService('s', { emit: (e) => events.push(e), now: () => (clock += 10), listBots: async () => botList, hooks: { posted: (p, c) => hooked.push([p, c]) } });
    await svc.start();
    const types = (...kinds) => events.filter((e) => kinds.includes(e.type));
    t.ok('名前: 先頭の # と前後の空白を除く・空・改行入り・長すぎるのは断る', normalizeChannelName('  # dev-ops ') === 'dev-ops'
      && [' ', '#', 'a\nb', 'x'.repeat(61)].every((n) => { try { normalizeChannelName(n); return false; } catch (e) { return e.code === 'INVALID'; } }));
    t.ok('絵文字は 1 つだけ（複合の絵文字も 1 つ。文字・2 つ・空白つきは断る）', ['👍', '🎉', '👨‍👩‍👧', '🇯🇵', '❤️'].every(isSingleEmoji) && ['', 'a', '👍👍', '👍 ', ' 👍', 'ok', null].every((v) => !isSingleEmoji(v)));

    const general = await svc.create({ name: '#general', purpose: '雑談', cwd: process.platform === 'win32' ? 'C:\\work' : '/work', members: ['b_owl'] }, HUMAN);
    t.ok('create: id は c_・名前は # を除く・channelsChanged が出る', general.id.startsWith('c_') && general.name === 'general' && general.kind === 'channel' && types('channelsChanged').length === 1 && types('channelsChanged')[0].channel.id === general.id);
    t.ok('同じ名前（大文字小文字・全角半角を区別しない）は CHANNEL_NAME_TAKEN', (await codeOf(() => svc.create({ name: 'GENERAL' }, HUMAN))) === 'CHANNEL_NAME_TAKEN' && (await codeOf(() => svc.create({ name: 'ｇｅｎｅｒａｌ' }, HUMAN))) === 'CHANNEL_NAME_TAKEN');
    t.ok('知らない bot をメンバーにはできない・相対パスの cwd は断る', (await codeOf(() => svc.create({ name: 'x1', members: ['b_nobody'] }, HUMAN))) === 'INVALID' && (await codeOf(() => svc.create({ name: 'x2', cwd: 'rel/path' }, HUMAN))) === 'INVALID');
    const dm = await svc.createDm({ bot: { id: 'b_owl', name: 'Owl', dmChannelId: newId('channel') } });
    t.ok('createDm は bot ごとに 1 つ（もう一度呼んでも同じ。名前が変わっていれば直す）', dm.kind === 'dm' && dm.botId === 'b_owl' && (await svc.createDm({ bot: { id: 'b_owl', name: 'Owl' } })).id === dm.id
      && (await svc.createDm({ bot: { id: 'b_owl', name: 'Owl2' } })).name === 'Owl2' && (await svc.list()).filter((c) => c.kind === 'dm').length === 1);
    const renamed = await svc.update({ channelId: general.id, name: 'main', memo: '決まり' }, HUMAN);
    t.ok('update: 名前・メモを直す。DM でない名前の衝突は断る', renamed.name === 'main' && renamed.memo === '決まり' && (await codeOf(async () => { await svc.create({ name: 'other' }, HUMAN); await svc.update({ channelId: general.id, name: 'other' }, HUMAN); })) === 'CHANNEL_NAME_TAKEN');
    t.ok('無いチャンネルは CHANNEL_NOT_FOUND', (await codeOf(() => svc.get({ channelId: 'c_nope0000' }))) === 'CHANNEL_NOT_FOUND' && (await codeOf(() => svc.post({ channelId: 'c_nope0000', text: 'x' }, HUMAN))) === 'CHANNEL_NOT_FOUND');

    // 投稿
    events.length = 0;
    const root = await svc.post({ channelId: general.id, text: '@Owl これをお願い @あなた にも見せて' }, HUMAN);
    t.ok('post: 本文の @ を投稿の時点で botId と you に解いて保存する・channelPost(add)・posted の口が呼ばれる', root.id.startsWith('p_') && root.threadId === null && root.mentions.join() === 'b_owl,you' && root.proxy === null
      && types('channelPost').length === 1 && types('channelPost')[0].op === 'add' && types('channelPost')[0].post.id === root.id);
    await new Promise((r) => setImmediate(r));
    t.ok('posted は保存の後に（待たずに）呼ばれ、最新の lastPostAt の定義を渡す', hooked.length === 1 && hooked[0][0].id === root.id && hooked[0][1].lastPostAt === root.at);
    const bad1 = [await codeOf(() => svc.post({ channelId: general.id, text: '   ' }, HUMAN)), await codeOf(() => svc.post({ channelId: general.id, text: 'x'.repeat(20001) }, HUMAN)),
      await codeOf(() => svc.post({ channelId: general.id, text: 'x' }, { kind: 'bot' })), await codeOf(() => svc.post({ channelId: general.id, text: 'x', state: 'zzz' }, HUMAN))];
    t.ok('空・長すぎる本文・不正な発言者・不正な状態は INVALID', bad1.every((c) => c === 'INVALID'), bad1.join());
    t.ok('スレッドへの返信は根の投稿 id で。根が無い・返信を根にはできない', (await codeOf(() => svc.post({ channelId: general.id, threadId: 'p_nope0000', text: 'x' }, HUMAN))) === 'POST_NOT_FOUND');
    const reply1 = await svc.post({ channelId: general.id, threadId: root.id, text: '返信 1' }, HUMAN);
    t.ok('返信は threadId を持つ', reply1.threadId === root.id && (await codeOf(() => svc.post({ channelId: general.id, threadId: reply1.id, text: 'x' }, HUMAN))) === 'INVALID');

    // 作業中のターンの投稿は、同じ bot の書き込みで置き換わる（進捗）
    const turn = await svc.post({ channelId: general.id, threadId: root.id, text: '- [ ] 調べる', state: 'working', turn: { botId: 'b_owl', sessionId: 's_o' } }, BOT);
    t.ok('bot の作業中のターンの投稿は state・turn を持つ', turn.state === 'working' && turn.turn.sessionId === 's_o' && turn.author.botId === 'b_owl');
    events.length = 0;
    const progress = await svc.post({ channelId: general.id, threadId: root.id, text: '- [x] 調べる\n- [ ] 直す' }, BOT);
    t.ok('同じスレッドで bot がもう一度書くと、新しい投稿ではなくそのターンの投稿の本文を置き換える（進捗）', progress.id === turn.id && progress.text.includes('直す')
      && (await svc.read({ channelId: general.id, threadId: root.id })).posts.length === 3 && types('channelPost').every((e) => e.op === 'edit'));
    const fresh = await svc.post({ channelId: general.id, threadId: root.id, text: '別の投稿', new: true }, BOT);
    t.ok('new: true なら置き換えずに新しい投稿を作る', fresh.id !== turn.id);
    await svc.edit({ channelId: general.id, postId: turn.id, state: 'done' }, BOT);
    const afterDone = await svc.post({ channelId: general.id, threadId: root.id, text: '終わった後の発言' }, BOT);
    t.ok('ターンが終わった（working でない）後の bot の発言は新しい投稿', afterDone.id !== turn.id);

    // ターンの会話が分かる書き込み（ADR 0116）: ターンの投稿に入れるかは hooks.botPost（dispatch.claimPost）が決める。入れた返事も posted へ渡す
    {
      const asked = [], posted = [];
      let answer = undefined;
      const claimSvc = makeService('claim', { now: () => (clock += 10), listBots: async () => botList,
        hooks: { botPost: (a) => { asked.push(a); return answer; }, posted: (p, c, extra) => posted.push([p, extra]) } });
      await claimSvc.start();
      const ch = await claimSvc.create({ name: 'claim' }, HUMAN);
      const croot = await claimSvc.post({ channelId: ch.id, text: '根' }, HUMAN);
      const cturn = await claimSvc.post({ channelId: ch.id, threadId: croot.id, text: '…', state: 'working', turn: { botId: 'b_owl', sessionId: 's_o' }, new: true }, BOT);
      t.ok('ADR 0116: ターンの投稿そのものを作るときは botPost に聞かない', asked.length === 0);
      answer = { postId: cturn.id };
      await sleep(5);
      posted.length = 0;
      const first = await claimSvc.post({ channelId: ch.id, threadId: croot.id, text: '@Lynx 返事', new: true, bySession: 's_o' }, BOT);
      await sleep(5);
      t.ok('ADR 0116: botPost が返した投稿（ターンの投稿）に、new: true でも返事が入る。呼んだ会話の id が渡る', first.id === cturn.id && first.text === '@Lynx 返事'
        && asked.at(-1).sessionId === 's_o' && asked.at(-1).threadId === croot.id && asked.at(-1).botId === 'b_owl', JSON.stringify(asked.at(-1)));
      t.ok('ADR 0116: 入れた返事も posted へ渡る（extra.filled。@ をここで解く）', posted.length === 1 && posted[0][0].id === cturn.id && posted[0][1].filled === true && posted[0][0].mentions.includes('b_lynx'), JSON.stringify(posted.map((x) => x[1])));
      answer = { postId: null };
      const second = await claimSvc.post({ channelId: ch.id, threadId: croot.id, text: '2 件目', bySession: 's_o' }, BOT);
      t.ok('ADR 0116: botPost が null を返したら、new が無くても新しい投稿（前の返事を同じ id で消さない）', second.id !== cturn.id && (await claimSvc.getPost({ channelId: ch.id, postId: cturn.id })).text === '@Lynx 返事');
    }

    // 作業中の更新は 1 秒に 1 回まで配る
    const slowClock = 50_000; // 時計は動かさない（続きの更新は 1 秒後の実時間のタイマーなので、ここでは出ない）
    const slowSvc = makeService('slow', { emit: (e) => events.push(e), now: () => slowClock });
    await slowSvc.start();
    const sc = await slowSvc.create({ name: 'slow' }, HUMAN);
    const sp = await slowSvc.post({ channelId: sc.id, text: '0', state: 'working', turn: { botId: 'b_owl', sessionId: 's' } }, BOT);
    events.length = 0;
    for (let i = 1; i <= 5; i++) { await slowSvc.edit({ channelId: sc.id, postId: sp.id, text: String(i) }, BOT); }
    t.ok('作業中の投稿の更新は、最初の 1 件だけ即座に配る（続きは 1 秒に 1 回まで）', types('channelPost').length === 1 && types('channelPost')[0].post.text === '1', JSON.stringify(types('channelPost').map((e) => e.post.text)));
    await new Promise((r) => setTimeout(r, 1150));
    t.ok('続きは 1 秒後に最後の 1 件（text 5）だけ配る', types('channelPost').length === 2 && types('channelPost')[1].post.text === '5', JSON.stringify(types('channelPost').map((e) => e.post.text)));
    await slowSvc.edit({ channelId: sc.id, postId: sp.id, state: 'done' }, BOT);
    t.ok('確定した（working でない）更新は待たずに配る', types('channelPost').length === 3 && types('channelPost')[2].post.state === 'done' && types('channelPost')[2].post.text === '5');
    slowSvc.stop();

    // 編集・削除
    events.length = 0;
    const ed = await svc.edit({ channelId: general.id, postId: reply1.id, text: '返信 1（直し） @Lynx' }, HUMAN);
    t.ok('edit: 本文と editedAt を直し、@ も解き直す', ed.text.includes('直し') && ed.editedAt > 0 && ed.mentions.join() === 'b_lynx' && types('channelPost')[0].op === 'edit');
    await svc.remove({ channelId: general.id, postId: reply1.id }, HUMAN);
    const delRead = await svc.read({ channelId: general.id, threadId: root.id });
    const gone = delRead.posts.find((p) => p.id === reply1.id);
    t.ok('remove: 本文を空にして残す（スレッドの形を保つ）・channelPost(delete)・もう一度消しても何も起きない', gone.deletedAt > 0 && gone.text === '' && types('channelPost').at(-1).op === 'delete'
      && (await svc.remove({ channelId: general.id, postId: reply1.id }, HUMAN)) === undefined && (await codeOf(() => svc.edit({ channelId: general.id, postId: reply1.id, text: 'x' }, HUMAN))) === 'POST_NOT_FOUND');

    // リアクション
    events.length = 0;
    const r1 = await svc.react({ channelId: general.id, postId: root.id, emoji: '👍', on: true }, HUMAN);
    await svc.react({ channelId: general.id, postId: root.id, emoji: '👍', on: true }, BOT);
    t.ok('react: 人も bot も付けられ、channelReaction に全体の reactions が載る', r1.reactions['👍'].length === 1 && types('channelReaction').length === 2 && types('channelReaction')[1].reactions['👍'].length === 2 && types('channelReaction')[1].postId === root.id);
    t.ok('react: 同じ発言者の二重の付けは 1 つ・外せる・全部外すと絵文字ごと消える', (await svc.react({ channelId: general.id, postId: root.id, emoji: '👍', on: true }, HUMAN)).reactions['👍'].length === 2
      && (await svc.react({ channelId: general.id, postId: root.id, emoji: '👍', on: false }, HUMAN)).reactions['👍'].length === 1 && !('👍' in (await svc.react({ channelId: general.id, postId: root.id, emoji: '👍', on: false }, BOT)).reactions));
    t.ok('react: 絵文字 1 つでないもの・消えた投稿は断る', (await codeOf(() => svc.react({ channelId: general.id, postId: root.id, emoji: 'ok', on: true }, HUMAN))) === 'INVALID' && (await codeOf(() => svc.react({ channelId: general.id, postId: root.id, emoji: '👍👍', on: true }, HUMAN))) === 'INVALID'
      && (await codeOf(() => svc.react({ channelId: general.id, postId: reply1.id, emoji: '👍', on: true }, HUMAN))) === 'POST_NOT_FOUND');

    // 読む（ページ・スレッド・要約）
    const feedSvc = makeService('feed', { now: () => (clock += 10) });
    await feedSvc.start();
    const fc = await feedSvc.create({ name: 'feed' }, HUMAN);
    const ids = [];
    for (let i = 0; i < 7; i++) ids.push((await feedSvc.post({ channelId: fc.id, text: `流れ ${i}` }, HUMAN)).id);
    await feedSvc.post({ channelId: fc.id, threadId: ids[2], text: 'スレッド 1' }, BOT);
    await feedSvc.post({ channelId: fc.id, threadId: ids[2], text: 'スレッド 2' }, HUMAN);
    await feedSvc.post({ channelId: fc.id, threadId: ids[2], text: 'スレッド 3' }, HUMAN);
    const pg1 = await feedSvc.read({ channelId: fc.id, limit: 3 });
    const pg2 = await feedSvc.read({ channelId: fc.id, limit: 3, before: pg1.nextBefore });
    const pg3 = await feedSvc.read({ channelId: fc.id, limit: 3, before: pg2.nextBefore });
    t.ok('read: 新しい方から limit 件を時間順で返し、nextBefore で前へ。返信は流れに混ざらない', pg1.posts.map((p) => p.text).join() === '流れ 4,流れ 5,流れ 6' && pg2.posts.map((p) => p.text).join() === '流れ 1,流れ 2,流れ 3'
      && pg3.posts.map((p) => p.text).join() === '流れ 0' && pg3.nextBefore === null && pg1.nextBefore === ids[4], pg1.posts.map((p) => p.text).join());
    t.ok('read: 返信のある根に要約（件数・最後の時刻・発言者）が付く', pg2.summaries[ids[2]]?.count === 3 && pg2.summaries[ids[2]].authors.length === 2 && pg1.summaries[ids[2]] === undefined);
    const th = await feedSvc.read({ channelId: fc.id, threadId: ids[2], limit: 2 });
    const th2b = await feedSvc.read({ channelId: fc.id, threadId: ids[2], limit: 2, before: th.nextBefore });
    t.ok('read(threadId): 最初のページは根が先頭、続きは返信だけ。threads に状態（無ければ空）', th.posts.map((p) => p.text).join() === '流れ 2,スレッド 2,スレッド 3' && th.threads[0].state === 'idle' && th2b.posts.map((p) => p.text).join() === 'スレッド 1' && th2b.nextBefore === null);
    t.ok('read: 返信を根に指す・無い before は POST_NOT_FOUND。limit は 100 まで', (await codeOf(() => feedSvc.read({ channelId: fc.id, threadId: 'p_nope0000' }))) === 'POST_NOT_FOUND' && (await codeOf(() => feedSvc.read({ channelId: fc.id, before: 'p_nope0000' }))) === 'POST_NOT_FOUND'
      && (await feedSvc.read({ channelId: fc.id, limit: 9999 })).posts.length === 7);
    const mutated = await feedSvc.read({ channelId: fc.id });
    mutated.posts[0].text = '書き換え';
    t.ok('read の返りは写し（直しても保存の状態は変わらない）', (await feedSvc.read({ channelId: fc.id })).posts[0].text === '流れ 0');

    // 検索
    const hit = await feedSvc.search({ query: 'ＳＬＥＤ', channelId: fc.id });
    t.ok('search: 大文字小文字・全角半角を区別せず、新しい順。消した投稿は出ない', (await feedSvc.search({ query: 'スレッド' })).hits.map((h) => h.snippet).join() === 'スレッド 3,スレッド 2,スレッド 1' && hit.hits.length === 0
      && (await feedSvc.search({ query: '流れ' })).hits.length === 7 && (await svc.search({ query: '返信 1' })).hits.length === 0 && (await feedSvc.search({ query: '   ' })).hits.length === 0 && (await feedSvc.search({ query: '流れ', limit: 2 })).hits.length === 2);

    // 一覧・既読
    const clockBase = clock;
    const unreadSvc = makeService('unread', { emit: (e) => events.push(e), now: () => (clock += 10), listBots: async () => botList });
    await unreadSvc.start();
    const uc = await unreadSvc.create({ name: 'unread' }, HUMAN);
    await unreadSvc.post({ channelId: uc.id, text: '人の投稿は未読に数えない' }, HUMAN);
    await unreadSvc.post({ channelId: uc.id, text: '報告です' }, BOT);
    const mine = await unreadSvc.post({ channelId: uc.id, text: '@あなた 確認してください' }, BOT);
    const ls = (await unreadSvc.list()).find((c) => c.id === uc.id);
    t.ok('list: 未読は既読の後の人以外の投稿・mentions はそのうち @あなた を含むもの', ls.unread === 2 && ls.mentions === 1 && ls.threadsWorking === 0 && ls.lastPostAt === mine.at, JSON.stringify(ls));
    events.length = 0;
    const read = await unreadSvc.markRead({ channelId: uc.id, at: mine.at });
    const ls2 = (await unreadSvc.list()).find((c) => c.id === uc.id);
    t.ok('markRead: 既読にして channelRead を出す。進める向きだけで、戻らない', read.readAt === mine.at && ls2.unread === 0 && ls2.mentions === 0 && events.some((e) => e.type === 'channelRead' && e.channelId === uc.id && e.readAt === mine.at)
      && (await unreadSvc.markRead({ channelId: uc.id, at: 1 })).readAt === mine.at);
    await unreadSvc.threads.update(uc.id, mine.id, { state: 'working' });
    t.ok('list: threadsWorking は state が working のスレッドの数', (await unreadSvc.list()).find((c) => c.id === uc.id).threadsWorking === 1);
    t.ok('markRead: 数でない at は INVALID', (await codeOf(() => unreadSvc.markRead({ channelId: uc.id, at: 'x' }))) === 'INVALID');
    void clockBase;

    // アーカイブ
    const arch = await svc.archive({ channelId: general.id, on: true }, HUMAN);
    t.ok('archive: archivedAt が付き、新しく書けない（一覧には残る）。戻すと書ける。名前を取られていたら戻せない', arch.archivedAt > 0 && (await codeOf(() => svc.post({ channelId: general.id, text: 'x' }, HUMAN))) === 'CHANNEL_ARCHIVED'
      && (await svc.list()).some((c) => c.id === general.id) && !(await svc.archive({ channelId: general.id, on: false }, HUMAN)).archivedAt && !!(await svc.post({ channelId: general.id, text: '戻った' }, HUMAN)));
    await svc.archive({ channelId: general.id, on: true }, HUMAN);
    const taker = await svc.create({ name: 'main' }, HUMAN);
    t.ok('アーカイブしたチャンネルの名前は、別のチャンネルが使える。そのため戻すときは衝突を断る', taker.name === 'main' && (await codeOf(() => svc.archive({ channelId: general.id, on: false }, HUMAN))) === 'CHANNEL_NAME_TAKEN');

    // スレッドを止める
    const stopSvcCalls = [];
    const stopSvc = makeService('stop', { emit: (e) => events.push(e), now: () => (clock += 10), hooks: { stopThread: async (a, by) => { stopSvcCalls.push([a, by]); } } });
    await stopSvc.start();
    const stc = await stopSvc.create({ name: 'stop' }, HUMAN);
    const str = await stopSvc.post({ channelId: stc.id, text: '起点' }, HUMAN);
    events.length = 0;
    const stopped = await stopSvc.stopThread({ channelId: stc.id, threadId: str.id }, BOT);
    t.ok('stopThread: stopped に止めた主体と時刻を残し、channelThread を出して、止める口（S4）へ渡す', stopped.stopped.by.botId === 'b_owl' && stopped.stopped.at > 0 && types('channelThread').length === 1 && types('channelThread')[0].thread.stopped.by.kind === 'bot'
      && stopSvcCalls.length === 1 && stopSvcCalls[0][0].threadId === str.id && stopSvcCalls[0][1].botId === 'b_owl');
    t.ok('stopThread: 根でない投稿・無いスレッドは POST_NOT_FOUND', (await codeOf(() => stopSvc.stopThread({ channelId: stc.id, threadId: 'p_nope0000' }, HUMAN))) === 'POST_NOT_FOUND');
    await stopSvc.post({ channelId: stc.id, threadId: str.id, text: '止めた後の bot の発言' }, BOT);
    t.ok('bot が書いても止めた印は外れない', (await stopSvc.threads.get(stc.id, str.id)).stopped !== null);
    events.length = 0;
    await stopSvc.post({ channelId: stc.id, threadId: str.id, text: '人がまた書く' }, HUMAN);
    t.ok('人が次に書くと止めた印を外し、channelThread を出す', (await stopSvc.threads.get(stc.id, str.id)).stopped === null && types('channelThread').length === 1);
    const failing = makeService('fail', { now: () => (clock += 10), hooks: { stopThread: async () => { throw new Error('abort failed'); } } });
    await failing.start();
    const fch = await failing.create({ name: 'fail' }, HUMAN);
    const fr = await failing.post({ channelId: fch.id, text: '起点' }, HUMAN);
    t.ok('止める口が失敗したら stopThread も失敗する（止まったと見せない）', (await failing.stopThread({ channelId: fch.id, threadId: fr.id }, HUMAN).then(() => 'ok', (e) => e.message)) === 'abort failed');

    // posted の後処理の失敗は投稿を巻き込まない
    const flaky = makeService('flaky', { now: () => (clock += 10), hooks: { posted: () => { throw new Error('dispatch down'); } } });
    await flaky.start();
    const flc = await flaky.create({ name: 'flaky' }, HUMAN);
    const origError = console.error;
    console.error = () => {};
    const survived = await flaky.post({ channelId: flc.id, text: '落ちても保存される' }, HUMAN);
    await new Promise((r) => setImmediate(r));
    console.error = origError;
    t.ok('posted が投げても投稿は保存されている', (await flaky.read({ channelId: flc.id })).posts[0].id === survived.id);

    // 開き直し
    const reopenedSvc = makeService('s', { listBots: async () => botList });
    await reopenedSvc.start();
    t.ok('開き直すと、チャンネル・投稿・リアクション・編集が残っている', (await reopenedSvc.get({ channelId: general.id })).memo === '決まり' && (await reopenedSvc.read({ channelId: general.id })).posts[0].mentions.join() === 'b_owl,you'
      && (await reopenedSvc.read({ channelId: general.id, threadId: root.id })).posts.some((p) => p.id === turn.id && p.state === 'done'));
    svc.stop();
  } finally {
    for (const service of services) await service.close().catch(() => {});
    for (const store of threadStores) await store.close().catch(() => {});
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}
