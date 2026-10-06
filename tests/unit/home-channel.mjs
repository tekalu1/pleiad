// 一時チャットの実体（ADR 0157・docs/channels.md「一時チャット」）: home: true のチャンネルは最初に bot へ話しかけたときにでき、
// op の channelId 'home' がそれを指す。改名・アーカイブはできず、名前 home は人のチャンネルとぶつからない。宛先の bot はメンバーになる。
// 心拍・予約の「家」には選ばない。サーバーを立てずに、本物のチャンネルのサービス（一時ディレクトリ）で registry.invoke を通す。
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { registry } from '../../core/ops/index.mjs';
import { ChannelError, createChannelService } from '../../core/channels/service.mjs';
import { pickHome } from '../../core/brain/pulse.mjs';

export const name = 'home-channel';
export const title = '一時チャットの実体: channelId home・最初の投稿で作る・改名とアーカイブを断る・宛先の bot はメンバー・家に選ばない';

const HUMAN = { by: 'human', via: 'ui', local: true };
const codeOf = async (fn) => { try { await fn(); return null; } catch (e) { return e instanceof ChannelError ? e.code : `other:${e.message}`; } };

export default async function (t) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'home-channel-'));
  try {
    let clock = 5000;
    const channels = createChannelService({ dir: path.join(tmp, 'channels'), now: () => (clock += 10), listBots: async () => [{ id: 'b_owl', name: 'Owl' }, { id: 'b_lynx', name: 'Lynx' }] });
    await channels.start();
    const deps = { locale: 'ja', channels, botOfSession: async () => null, modeOf: async () => ({ scope: 'workspace', autonomy: 'ask' }), audit: () => {} };
    const run = (id, args) => registry.invoke(HUMAN, id, args, deps);

    // ---- まだ無い
    t.ok('最初は一時チャットの実体が無い', (await channels.home()) === null);
    const empty = await run('channels.read', { channelId: 'home' });
    t.ok('無いうちの channels.read home は空の流れ', empty.ok && empty.result.posts.length === 0 && empty.result.nextBefore === null, JSON.stringify(empty));
    const missing = await run('channels.get', { channelId: 'home' });
    t.ok('無いうちの channels.get home は見つからない', !missing.ok && missing.code === 'CHANNEL_NOT_FOUND', JSON.stringify(missing));
    t.ok('読むだけでは作らない', (await channels.home()) === null);

    // ---- bot に話しかける（宛先のチップ）
    const first = await run('channels.post', { channelId: 'home', text: '依存を更新して', to: 'b_owl', clientId: 'home-00000001' });
    const home = await channels.home();
    t.ok('最初の投稿で home: true のチャンネルができ、投稿はそこに入る', first.ok && home?.home === true && home.kind === 'channel' && first.result.channelId === home.id, JSON.stringify(first));
    t.ok('宛先の bot はメンバーになる', home.members.includes('b_owl') && !home.members.includes('b_lynx'));
    t.ok('投稿に宛先が残る', first.result.to === 'b_owl');
    const again = await run('channels.post', { channelId: 'home', text: '依存を更新して', to: 'b_owl', clientId: 'home-00000001' });
    t.ok('同じ clientId の送り直しは同じ投稿（二重に作らない）', again.ok && again.result.id === first.result.id);
    await run('channels.post', { channelId: 'home', text: '別の話', to: 'b_lynx', clientId: 'home-00000002' });
    const after = await channels.home();
    t.ok('2 つ目は同じ実体・宛先の bot がメンバーに足される', after.id === home.id && after.members.includes('b_lynx') && (await channels.list()).filter((c) => c.home).length === 1);
    const unknownBot = await run('channels.post', { channelId: 'home', text: 'x', to: 'b_nope', clientId: 'home-00000003' });
    t.ok('知らない bot を宛先にすると断る（メンバーに足さない）', !unknownBot.ok && !(await channels.home()).members.includes('b_nope'));

    // ---- 呼び名
    const read = await run('channels.read', { channelId: 'home' });
    const got = await run('channels.get', { channelId: 'home' });
    t.ok('channels.read / get の home は実体を指す', read.ok && read.result.posts.length === 2 && got.ok && got.result.id === home.id);
    const reply = await run('channels.post', { channelId: home.id, threadId: first.result.id, text: '続き' });
    t.ok('実体の id でも書ける（スレッドの返信）', reply.ok && reply.result.threadId === first.result.id);

    // ---- 守り
    t.ok('改名は断る', await codeOf(() => channels.update({ channelId: home.id, name: 'renamed' }, { kind: 'human' })) === 'INVALID');
    t.ok('アーカイブは断る', await codeOf(() => channels.archive({ channelId: home.id, on: true }, { kind: 'human' })) === 'INVALID');
    t.ok('目的・メモは変えられる', (await channels.update({ channelId: home.id, purpose: '気軽な相談' }, { kind: 'human' })).purpose === '気軽な相談');
    const named = await run('channels.create', { name: 'home' });
    t.ok('人のチャンネルに home という名前を付けられる（一時チャットの名前とぶつからない）', named.ok && named.result.name === 'home' && !named.result.home && named.result.id !== home.id, JSON.stringify(named));
    const stillHome = await run('channels.get', { channelId: 'home' });
    t.ok('同じ名前のチャンネルができても、channelId home は一時チャットのまま', stillHome.ok && stillHome.result.id === home.id);

    // ---- 家に選ばない（心拍・予約の予算の数え先）
    const list = await channels.list();
    const owlHome = pickHome({ id: 'b_owl' }, list);
    t.ok('一時チャットは bot の家に選ばない（ほかに入っているチャンネルが無ければ家は無い）', owlHome === null, JSON.stringify(owlHome));
    t.ok('pulse.channelId に一時チャットを指していても選ばない', pickHome({ id: 'b_owl', pulse: { channelId: home.id } }, list) === null);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}
