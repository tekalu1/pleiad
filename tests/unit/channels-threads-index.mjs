// スレッドの索引（core/channels/service.mjs の threads・setThreadStatus・markRead の threadId。docs/channels.md「操作」）。
// 脇の 2 つの並べ方（チャンネル｜状態）の材料: チャンネルごとの最近のスレッド・件数・未読・状態。実ファイルを一時ディレクトリに置いて確かめる。
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ChannelError, createChannelService, THREADS_PER_CHANNEL } from '../../core/channels/service.mjs';
import { applyThreadPatch, emptyThread, threadTitle } from '../../core/channels/threads.mjs';

export const name = 'channels-threads-index';
export const title = 'スレッドの索引: チャンネルごとの最近のスレッド・件数・未読・状態・スレッドの既読';

const HUMAN = { kind: 'human' };
const BOT = { kind: 'bot', botId: 'b_owl' };
const codeOf = async (fn) => { try { await fn(); return null; } catch (e) { return e instanceof ChannelError ? e.code : `other:${e.message}`; } };

export default async function (t) {
  // ---- 題・状態の欄（純粋）
  t.ok('題は根の最初の行で、先頭の @ を外す', threadTitle('@Owl @Kit  依存を更新して\n詳しく') === '依存を更新して' && threadTitle('\n\n@Owl') === '@Owl' && threadTitle('') === '');
  const base = emptyThread('c_a', 'p_1', 1);
  t.ok('status は付けて・外せる（空・null）', applyThreadPatch(base, { status: ' レビュー ' }, 2).status === 'レビュー'
    && !('status' in applyThreadPatch({ ...base, status: 'x' }, { status: '' }, 2)) && !('status' in applyThreadPatch({ ...base, status: 'x' }, { status: null }, 2)));
  t.ok('status は 60 字まで', (() => { try { applyThreadPatch(base, { status: 'あ'.repeat(61) }, 2); return false; } catch { return true; } })());
  t.ok('readAt は進める向きにだけ動く', applyThreadPatch({ ...base, readAt: 500 }, { readAt: 300 }, 2).readAt === 500 && applyThreadPatch(base, { readAt: 300 }, 2).readAt === 300);

  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'channels-threads-index-'));
  let clock = 1_000;
  const events = [];
  const service = createChannelService({ dir: path.join(tmp, 'channels'), now: () => ++clock, emit: (e) => events.push(e) });
  try {
    await service.start();
    const a = (await service.create({ name: 'alpha' }, HUMAN)).id ?? (await service.list()).find((c) => c.name === 'alpha').id;
    const b = (await service.create({ name: 'beta' }, HUMAN)).id ?? (await service.list()).find((c) => c.name === 'beta').id;
    const post = async (channelId, text, threadId = null, author = HUMAN) => (await service.post({ channelId, threadId, text }, author)).id;
    // alpha: 根 7 本。そのうち 6 本に返信（最後の返信の時刻がばらける）、1 本は返信なし（スレッドではない）
    const roots = [];
    for (let i = 0; i < 7; i++) roots.push(await post(a, `@Owl 仕事 ${i}`));
    for (let i = 0; i < 6; i++) await post(a, `返信 ${i}`, roots[i], BOT);
    await post(a, '最後の返信', roots[2], BOT);
    // beta: 返信 1 本
    const bRoot = await post(b, 'ベータの根');
    await post(b, 'ベータの返信', bRoot, BOT);

    const idx = await service.threadIndex();
    const alpha = idx.threads.filter((x) => x.channelId === a);
    t.ok('返信のある根だけがスレッド（返信の無い根は入れない）', idx.totals[a] === 6 && idx.totals[b] === 1, JSON.stringify(idx.totals));
    t.ok(`チャンネルごとに既定 ${THREADS_PER_CHANNEL} 件・最後の動きの新しい順`, alpha.length === THREADS_PER_CHANNEL && alpha[0].threadId === roots[2]
      && alpha.every((x, i) => i === 0 || alpha[i - 1].lastAt >= x.lastAt), JSON.stringify(alpha.map((x) => x.title)));
    t.ok('行の形: 題（@ を外す）・返信の数・未読・状態', alpha[0].title === '仕事 2' && alpha[0].count === 2 && alpha[0].unread === true && alpha[0].state === 'idle' && Array.isArray(alpha[0].bots));
    t.ok('all で全部', (await service.threadIndex({ all: true })).threads.filter((x) => x.channelId === a).length === 6);
    t.ok('channelId でそのチャンネルだけ', (await service.threadIndex({ channelId: b })).threads.map((x) => x.threadId).join() === bRoot);
    t.ok('知らないチャンネルは断る', await codeOf(() => service.threadIndex({ channelId: 'c_nope' })) === 'CHANNEL_NOT_FOUND');

    // ---- 状態
    const st = await service.setThreadStatus({ channelId: a, threadId: roots[2], status: 'レビュー' }, HUMAN);
    t.ok('状態を付けると索引に出る・出来事 channelThread', st.status === 'レビュー' && (await service.threadIndex({ channelId: a })).threads.find((x) => x.threadId === roots[2]).status === 'レビュー'
      && events.some((e) => e.type === 'channelThread' && e.threadId === roots[2] && e.thread.status === 'レビュー'));
    await service.setThreadStatus({ channelId: a, threadId: roots[2], status: '' }, HUMAN);
    t.ok('空にすると外れる', !('status' in (await service.threadIndex({ channelId: a })).threads.find((x) => x.threadId === roots[2])));
    t.ok('根でない投稿・知らない投稿は断る', await codeOf(() => service.setThreadStatus({ channelId: a, threadId: 'p_nope', status: 'x' }, HUMAN)) === 'POST_NOT_FOUND');
    // 状態だけ付いた（返信の無い）根も、状態を持つのでスレッドとして出る
    await service.setThreadStatus({ channelId: a, threadId: roots[6], status: 'あとで' }, HUMAN);
    t.ok('状態を持つ根は返信が無くても索引に出る', (await service.threadIndex({ channelId: a, all: true })).threads.some((x) => x.threadId === roots[6] && x.status === 'あとで' && x.count === 0));

    // ---- スレッドの既読
    const before = (await service.threadIndex({ channelId: a, all: true })).threads.find((x) => x.threadId === roots[0]);
    await service.markRead({ channelId: a, threadId: roots[0], at: clock });
    const after = await service.threadIndex({ channelId: a, all: true });
    t.ok('スレッドを読むと、その行の未読が消える（チャンネルの既読も同じ値へ進む）', before.unread === true && after.threads.find((x) => x.threadId === roots[0]).unread === false);
    const later = await post(a, '新しい返信', roots[1], BOT);
    t.ok('読んだ後の返信は未読', Boolean(later) && (await service.threadIndex({ channelId: a, all: true })).threads.find((x) => x.threadId === roots[1]).unread === true);
  } finally {
    await service.close().catch(() => {});
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}
