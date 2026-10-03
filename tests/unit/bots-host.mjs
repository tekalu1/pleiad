// bot・Channels・ルーティンのつなぎ目（core/bots-host.mjs）と、P0 で足した土台: つなぎ目が空でも何も変えない・例外を外へ出さない・
// 操作の deps・sidecar の許可リスト（bot）・使用量の sessionId・fake の台本（包みを外す・notes・usage）。docs/channels.md
import os from 'node:os';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createBotHost } from '../../core/bots-host.mjs';
import { createUsageStore, usageRecord } from '../../core/usage.mjs';
import { registry } from '../../core/ops/index.mjs';
import { EVENTS } from '../../core/protocol.mjs';
import { scriptOf } from '../../core/backends/fake.mjs';
import { channelEnvelope, memoryCoreEnvelope } from '../../core/channels/types.mjs';
import { readUsage } from '../lib/data-store.mjs';

export const name = 'bots-host';
export const title = 'bot・Channels の土台: つなぎ目は空でも何も変えず・例外を出さない・使用量の sessionId・fake の台本';

export default async function (t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bots-host-'));
  const hosts = [];
  try {
    const events = [];
    const sessions = { s1: { bot: { botId: 'b_x', kind: 'thread' } }, s2: {} };
    const host = createBotHost({ store: { get: async (id) => sessions[id] ?? {} }, dataDir: dir, emitGlobal: (e) => events.push(e) });
    hosts.push(host);

    // ---- 空のつなぎ目: 何も返さず・何も出さない
    t.ok('opsDeps は channels・bots・memory・routines・botOfSession を持つ', ['channels', 'bots', 'memory', 'routines', 'botOfSession'].every((k) => k in host.opsDeps()));
    t.ok('botOfSession は bot の会話だけ SessionBot を返す', (await host.opsDeps().botOfSession('s1')).botId === 'b_x'
      && (await host.opsDeps().botOfSession('s2')) === null && (await host.opsDeps().botOfSession(null)) === null);
    const extras = await host.turnExtras({ info: { sessionId: 's1' } });
    t.ok('turnExtras は空（人格なし・notes なし）', extras.botInstructions === null && extras.notes.length === 0);
    host.onTurnEvent({}, { type: 'text.end' });
    await host.onTurnEnd({}, { outcome: 'ok' });
    host.onPermission({ id: 'p' }, 'open');
    host.onSessionDone('s1', 'ok');
    host.onCompacted('s1');
    t.ok('handleHttp は取らない', (await host.handleHttp({ url: '/hooks/h_x' }, {})) === false);
    await host.start();
    host.stop();
    t.ok('空のままでは何も配らない', events.length === 0);
    t.ok('空の一覧・検索を返す（落ちない）', (await host.opsDeps().channels.list()).length === 0 && (await host.opsDeps().bots.list()).length === 0
      && (await host.opsDeps().memory.search()).length === 0 && (await host.opsDeps().routines.list()).length === 0);

    // ---- つなぎ目は bot の側の失敗でターンを巻き込まない
    const broken = createBotHost({ store: { get: async () => { throw new Error('store down'); } }, dataDir: dir, emitGlobal: () => {} });
    hosts.push(broken);
    t.ok('botOfSession は store が落ちても null', (await broken.opsDeps().botOfSession('s1')) === null);

    // ---- 配線: 出来事・操作の一覧
    const eight = ['channelsChanged', 'channelPost', 'channelReaction', 'channelThread', 'channelRead', 'botsChanged', 'memoryChanged', 'routinesChanged', 'channelEvent'];
    t.ok('WS の出来事が EVENTS にある', eight.every((e) => EVENTS.has(e)));
    t.ok('操作の一覧の登録が壊れていない（空の領域でも）', registry.ops.length > 0);

    // ---- 使用量: sessionId（足す前の記録には無い）
    t.ok('usageRecord は sessionId を残す', usageRecord({ id: 'k', backend: 'fake', sessionId: 's-1', inputTokens: 5 }, 1).sessionId === 's-1');
    t.ok('usageRecord は sessionId が無ければ欄を足さない', !('sessionId' in usageRecord({ id: 'k', backend: 'fake', inputTokens: 5 }, 1)));
    t.ok('usageRecord は不正な sessionId を捨てる', !('sessionId' in usageRecord({ id: 'k', backend: 'fake', sessionId: 'a/b c' }, 1)));
    const usage = createUsageStore(dir);
    await usage.record({ id: 'k1', backend: 'fake', sessionId: 's-1', inputTokens: 10, outputTokens: 2, cachedTokens: 8, costUsd: 0 });
    const raw = readUsage(dir);
    t.ok('使用量の記録（DB の usage_records）に sessionId が入る', JSON.stringify(raw?.records ?? []).includes('"sessionId":"s-1"'));
    const bySession = await usage.records({ sessionIds: ['s-1', 'other'], since: 0 });
    t.ok('usage.records は会話の id で引ける（sessionId を持たない記録は載らない）', bySession.length === 1 && bySession[0].id === 'k1' && (await usage.records({ sessionIds: ['nobody'] })).length === 0);
    await usage.close();

    // ---- fake の台本: 包みを外してから選ぶ
    t.ok('包みの無い prompt は今までどおり', scriptOf('  echo: hi ') === 'echo: hi');
    t.ok('<pleiad-channel> の中身を台本として読む（@名前を除く）', scriptOf(channelEnvelope({ channel: '#c', from: 'あなた', text: '@Owl echo:やった' })) === 'echo:やった');
    t.ok('記憶の包みは台本ではない', scriptOf(memoryCoreEnvelope('x') + channelEnvelope({ channel: '#c', text: 'slow' })) === 'slow');
    t.ok('最近のスレッドの包みも台本ではない', scriptOf('<pleiad-bot-recent>前の話</pleiad-bot-recent>' + channelEnvelope({ channel: '#c', text: 'slow' })) === 'slow');
    t.ok('発言が包みの後ろに続くなら、その発言が台本', scriptOf(channelEnvelope({ channel: '#c', text: 'a' }) + 'notes:') === 'notes:');
  } finally {
    await Promise.all(hosts.map(h => h.close()));
    await fs.rm(dir, { recursive: true, force: true });
  }
}
