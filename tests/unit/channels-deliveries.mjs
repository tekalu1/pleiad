// エージェントに渡した原文（channels.deliveries。ADR 9101・docs/channels.md「操作」）: スレッドの各 bot の会話の履歴から、
// その投稿を運んだ発言を、包みを分ける前の生の本文で返す。聞こえた投稿（heard="true"）はその印。人だけ。
// 本物のチャンネルのサービス（一時ディレクトリ）と、偽の会話の履歴（rawMessages）で registry.invoke を通す。
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { registry } from '../../core/ops/index.mjs';
import { createChannelService } from '../../core/channels/service.mjs';

export const name = 'channels-deliveries';
export const title = 'エージェントに渡した原文: 投稿を運んだ発言を生の本文で・bot ごと・聞こえた投稿の印・DM・人だけ';

const HUMAN = { by: 'human', via: 'ui', local: true };

export default async function (t) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'channels-deliveries-'));
  try {
    let clock = 5000;
    const channels = createChannelService({ dir: path.join(tmp, 'channels'), now: () => (clock += 10), listBots: async () => [{ id: 'b_owl', name: 'Owl' }, { id: 'b_lynx', name: 'Lynx' }] });
    await channels.start();
    const dev = await channels.create({ name: 'dev', members: ['b_owl', 'b_lynx'] }, { kind: 'human' });
    const root = await channels.post({ channelId: dev.id, text: '@Owl 調べて' }, { kind: 'human' });
    const reply = await channels.post({ channelId: dev.id, threadId: root.id, text: 'もう少し' }, { kind: 'human' });
    await channels.threads.update(dev.id, root.id, { sessions: { b_owl: 's_owl', b_lynx: 's_lynx' } });
    const histories = {
      s_owl: [
        { role: 'user', at: '2026-10-07T01:00:00Z', text: `<pleiad-channel-thread channel="#dev" thread="${root.id}">\n<pleiad-channel post="${root.id}" from="あなた">@Owl 調べて</pleiad-channel>\n</pleiad-channel-thread>` },
        { role: 'assistant', text: '調べます' },
        { role: 'user', at: '2026-10-07T01:05:00Z', text: `<pleiad-channel channel="#dev" thread="${root.id}" post="${reply.id}" from="あなた">もう少し</pleiad-channel>` },
      ],
      s_lynx: [
        { role: 'user', at: '2026-10-07T01:05:01Z', text: `<pleiad-channel channel="#dev" thread="${root.id}" post="${reply.id}" from="あなた" heard="true">もう少し</pleiad-channel>` },
      ],
      s_dm: [{ role: 'user', at: '2026-10-07T02:00:00Z', text: '<pleiad-channel channel="DM" post="DMPOST" from="あなた">やあ</pleiad-channel>' }],
    };
    const deps = { locale: 'ja', channels, botOfSession: async () => null, modeOf: async () => ({ scope: 'workspace', autonomy: 'ask' }), audit: () => {},
      rawMessages: async (id) => histories[id] ?? [], bots: { get: async ({ botId }) => (botId === 'b_owl' ? { id: 'b_owl', dmSessionId: 's_dm' } : null) } };
    const run = (p, args) => registry.invoke(p, 'channels.deliveries', args, deps);

    const a = await run(HUMAN, { channelId: dev.id, postId: reply.id });
    const byBot = Object.fromEntries((a.result?.deliveries ?? []).map((d) => [d.botId, d]));
    t.ok('返信を運んだ発言を bot ごとに返す（生の本文。包みを分けない）', a.ok && byBot.b_owl?.text.startsWith('<pleiad-channel ') && byBot.b_owl.text.includes(`post="${reply.id}"`) && byBot.b_lynx?.sessionId === 's_lynx', JSON.stringify(a));
    t.ok('聞こえた投稿（heard="true"）はその印', byBot.b_lynx.heard === true && byBot.b_owl.heard === false);
    t.ok('時刻は発言の時刻', byBot.b_owl.at === '2026-10-07T01:05:00Z');
    const r = await run(HUMAN, { channelId: dev.id, postId: root.id });
    t.ok('根の投稿は、スレッドのはじめに渡した包み（pleiad-channel-thread）の発言', r.ok && r.result.deliveries.length === 1 && r.result.deliveries[0].text.startsWith('<pleiad-channel-thread'), JSON.stringify(r.result));
    const none = await channels.post({ channelId: dev.id, threadId: root.id, text: 'まだ届いていない' }, { kind: 'human' });
    t.ok('まだ届いていない投稿は空', (await run(HUMAN, { channelId: dev.id, postId: none.id })).result.deliveries.length === 0);
    // DM は bot の DM の会話から
    const dm = await channels.createDm({ bot: { id: 'b_owl', name: 'Owl' } });
    const dmPost = await channels.post({ channelId: dm.id, text: 'やあ' }, { kind: 'human' });
    histories.s_dm[0].text = histories.s_dm[0].text.replace('DMPOST', dmPost.id);
    const d = await run(HUMAN, { channelId: dm.id, postId: dmPost.id });
    t.ok('DM は bot の DM の会話から', d.ok && d.result.deliveries.length === 1 && d.result.deliveries[0].sessionId === 's_dm', JSON.stringify(d));
    // 人だけ・知らない投稿
    const ai = await run({ by: 'agent', via: 'cli', sessionId: 's_x' }, { channelId: dev.id, postId: reply.id });
    t.ok('AI からは使えない', !ai.ok, JSON.stringify(ai));
    const gone = await run(HUMAN, { channelId: dev.id, postId: 'p_nope' });
    t.ok('知らない投稿は POST_NOT_FOUND', !gone.ok && gone.code === 'POST_NOT_FOUND', JSON.stringify(gone));
  } finally {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}
