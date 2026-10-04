// bot の予約（ADR 0135）: 作る（時刻の範囲・件数の上限）・時刻が来たら 1 回起こす・止まっていた間に重なった予約は 1 回にまとめて遅れて起こす・
// 再起動しても残る・予算なし・休憩中は捨てずに待つ・止めたスレッドは起こさない・取り消し・タイマー・案内の 1 行。
// チャンネルは本物のサービス、保存は一時のデータ置き場、dispatch は身代わり。
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createChannelService } from '../../core/channels/service.mjs';
import { createBrainStore } from '../../core/brain/store.mjs';
import { createWakes, WakeError, WAKE_PENDING_MAX, WAKE_RETRY_MS, WAKE_TICK_MS } from '../../core/brain/wakes.mjs';
import { createBudget } from '../../core/bots/budget.mjs';
import { normalizePulse } from '../../core/bots/store.mjs';
import { botInstructions } from '../../core/bots/sessions.mjs';

export const name = 'brain-wakes';
export const title = 'bot の予約: 作る・時刻に 1 回起こす・重なった遅れは 1 回・再起動で残る・予算なし／休憩中は待つ・止めたスレッドは起こさない・取り消し・タイマー';

const MIN = 60_000;

export default async function (t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'brain-wakes-'));
  let clock = new Date(2026, 9, 5, 1, 0, 0).getTime();
  const now = () => clock;
  const bot = { id: 'b_sora', name: 'ソラ', icon: '🦊', persona: '', backend: 'fake', model: '', pulse: normalizePulse(null) };
  const bots = { list: async () => [bot], get: async ({ botId }) => (botId === bot.id ? bot : null) };
  const channels = createChannelService({ dir: path.join(dir, 'channels'), now, listBots: bots.list });
  await channels.start();
  const brain = createBrainStore({ dataDir: dir, now });
  const host = { currentLocale: () => 'ja', store: { getPrefs: async () => ({}) }, readQuota: async () => null, usageStore: {} };
  const budget = createBudget({ channels, host, now, brain });
  const calls = [];
  let result = { ok: true };
  let resting = null;
  const dispatch = { wakeReserved: async (args) => { calls.push(args); return result; }, restingUntil: () => resting };
  const timers = [];
  const fakeClock = { now, setTimer: (fn, ms) => { const h = { fn, ms }; timers.push(h); return h; }, clearTimer: (h) => { const i = timers.indexOf(h); if (i >= 0) timers.splice(i, 1); } };
  const events = [];
  const make = () => createWakes({ dataDir: dir, channels, bots, dispatch, budget, clock: fakeClock, now, emit: (e) => events.push(e), localeOf: () => 'ja' });
  let wakes = make();
  const human = { kind: 'human' };
  try {
    const dev = await channels.create({ name: 'dev', members: [bot.id] }, human);
    await channels.update({ channelId: dev.id, budget: { daily: 5 } }, human);
    const root = await channels.post({ channelId: dev.id, text: 'リリースのワークフローを見ておいて' }, human);
    const where = { botId: bot.id, sessionId: 's_thread', channelId: dev.id, threadId: root.id };

    // ---- 作る
    const fails = (args) => { try { wakes.add({ ...where, note: 'x', ...args }); return null; } catch (e) { return e instanceof WakeError ? e.code : String(e); } };
    t.ok('時刻は今から 1 分後〜30 日後まで（過去・近すぎ・遠すぎは WAKE_TIME）', fails({ at: clock - MIN }) === 'WAKE_TIME' && fails({ at: clock + 10_000 }) === 'WAKE_TIME' && fails({ at: clock + 31 * 1440 * MIN }) === 'WAKE_TIME' && fails({ at: NaN }) === 'WAKE_TIME');
    const w1 = wakes.add({ ...where, at: clock + 30 * MIN, note: 'CI の結果を確かめて、通っていたら #dev に知らせる' });
    t.ok('予約は待っている状態で残る（id・時刻・メモ・会話・スレッド）。brainChanged が出る', w1.status === 'pending' && /^w[0-9a-f]{8}$/.test(w1.id) && wakes.list(bot.id)[0].note.includes('CI の結果') && wakes.get(w1.id).threadId === root.id && events.some((e) => e.type === 'brainChanged' && e.botId === bot.id));
    t.ok('置いた後はタイマーが 1 本（長くても確かめる間隔まで眠る）', timers.length === 0 || timers.every((h) => h.ms <= WAKE_TICK_MS));
    await wakes.start();
    t.ok('start でタイマーが 1 本だけ（確かめる間隔以内）', timers.length === 1 && timers[0].ms <= WAKE_TICK_MS);

    // ---- 時刻の前は起こさない
    clock += 10 * MIN;
    t.ok('時刻の前の tick は何もしない', (await wakes.tick()) === 0 && calls.length === 0);

    // ---- 時刻が来たら 1 回起こす
    clock += 21 * MIN;
    t.ok('時刻が来たら、その会話を 1 回起こす', (await wakes.tick()) === 1 && calls.length === 1);
    const c1 = calls[0];
    t.ok('起こし方: 予約した会話・スレッド・チャンネルへ。本文に予約のメモ・黙ってよいこと・続けるならもう一度予約。予算の数え先はそのチャンネル', c1.sessionId === 's_thread' && c1.threadId === root.id && c1.channelId === dev.id && c1.homeChannelId === dev.id
      && c1.text.includes('予約した時刻になったので起きました') && c1.text.includes('CI の結果を確かめて') && c1.text.includes('brain.wakeAdd') && !c1.text.includes('遅れて'));
    t.ok('起こした予約は fired（もう一度は起こさない）', wakes.get(w1.id).status === 'fired' && wakes.get(w1.id).firedAt === clock && (await wakes.tick()) === 0 && calls.length === 1);

    // ---- Pleiad が止まっていた間に重なった予約: 再起動後に、同じ会話は 1 回にまとめて遅れて起こす（何回も重ねない）
    const a = wakes.add({ ...where, at: clock + 5 * MIN, note: '5:13 の確かめ' });
    const b = wakes.add({ ...where, at: clock + 40 * MIN, note: '5:47 の確かめ' });
    const c = wakes.add({ ...where, at: clock + 90 * MIN, note: '6:37 の確かめ' });
    const ops = await channels.create({ name: 'ops', members: [bot.id] }, human);
    const other = wakes.add({ botId: bot.id, sessionId: 's_dm', channelId: ops.id, threadId: null, at: clock + 60 * MIN, note: 'DM で聞いた件' });
    const later = wakes.add({ ...where, at: clock + 10 * 60 * MIN, note: 'まだ先の予約' });
    wakes.close();
    clock += 3 * 60 * MIN;   // 3 時間止まっていた
    calls.length = 0;
    wakes = make();
    await wakes.start();
    await wakes.tick();
    const thread = calls.filter((x) => x.sessionId === 's_thread');
    t.ok('再起動しても予約は残り、止まっていた間に過ぎた同じ会話の 3 件は 1 回にまとめて起こす', thread.length === 1 && ['5:13', '5:47', '6:37'].every((s) => thread[0].text.includes(s)));
    t.ok('遅れて起きたことを本文に書く（いちばん早い予定の時刻）', thread[0].text.includes('遅れて起きました'));
    t.ok('別の会話（DM）の予約は、その会話で別に 1 回', calls.filter((x) => x.sessionId === 's_dm').length === 1 && calls.length === 2);
    t.ok('起こした予約は fired・late・merged の印。まだ先の予約は待ったまま', [a, b, c].every((w) => wakes.get(w.id).status === 'fired' && wakes.get(w.id).late === true && wakes.get(w.id).merged === 3)
      && wakes.get(other.id).status === 'fired' && wakes.get(later.id).status === 'pending');
    await wakes.tick();
    t.ok('次の tick では重ねて起こさない', calls.length === 2);

    // ---- 予算なし: 捨てずに待ち、戻ったら起こす
    calls.length = 0;
    const w2 = wakes.add({ ...where, at: clock + 2 * MIN, note: '予算が無いときの予約' });
    await channels.update({ channelId: dev.id, budget: { daily: 0 } }, human);
    clock += 3 * MIN;
    await wakes.tick();
    t.ok('予算が 0 なら起こさず、待たせる（waiting: budget。見直しは 10 分後）', calls.length === 0 && wakes.get(w2.id).status === 'pending' && wakes.get(w2.id).waiting === 'budget' && wakes.get(w2.id).retryAt === clock + WAKE_RETRY_MS);
    t.ok('待たせている間のタイマーは、過ぎた時刻で 1 秒ごとに起きない（見直しの時刻か確かめる間隔まで眠る）', timers.length === 1 && timers[0].ms === WAKE_TICK_MS);
    await channels.update({ channelId: dev.id, budget: { daily: 5 } }, human);
    clock += MIN;
    await wakes.tick();
    t.ok('見直しの時刻の前は、予算が戻っても待つ', calls.length === 0);
    clock += WAKE_RETRY_MS;
    await wakes.tick();
    t.ok('見直しの時刻に予算が戻っていれば起こす（遅れたことも書く）', calls.length === 1 && wakes.get(w2.id).status === 'fired' && !('waiting' in wakes.get(w2.id)) && calls[0].text.includes('遅れて'));

    // ---- 休憩中（使用量の上限）: 待つ
    calls.length = 0;
    const w3 = wakes.add({ ...where, at: clock + 2 * MIN, note: '休憩中の予約' });
    resting = clock + 60 * MIN;
    clock += 3 * MIN;
    await wakes.tick();
    t.ok('休憩中の bot は起こさず待たせる（waiting: resting）', calls.length === 0 && wakes.get(w3.id).waiting === 'resting' && wakes.get(w3.id).status === 'pending');
    resting = null;
    clock += WAKE_RETRY_MS;
    await wakes.tick();
    t.ok('休憩が明けたら起こす', calls.length === 1 && wakes.get(w3.id).status === 'fired');

    // ---- dispatch が断った: 待てるもの（resting）は待ち、ほかは閉じる
    calls.length = 0;
    const w4 = wakes.add({ ...where, at: clock + 2 * MIN, note: '会話が無くなった' });
    result = { ok: false, reason: 'nosession' };
    clock += 3 * MIN;
    await wakes.tick();
    t.ok('その bot の会話でなくなった予約は閉じる（dropped・理由つき）', wakes.get(w4.id).status === 'dropped' && wakes.get(w4.id).reason === 'nosession');
    result = { ok: true };

    // ---- 止めたスレッド
    calls.length = 0;
    const w5 = wakes.add({ ...where, at: clock + 2 * MIN, note: '止めたスレッド' });
    await channels.threads.update(dev.id, root.id, { stopped: { by: human, at: clock } });
    clock += 3 * MIN;
    await wakes.tick();
    t.ok('人が［止める］を押したスレッドの予約は起こさず閉じる（dropped: stopped）', calls.length === 0 && wakes.get(w5.id).status === 'dropped' && wakes.get(w5.id).reason === 'stopped');
    await channels.threads.update(dev.id, root.id, { stopped: null });

    // ---- 取り消し・件数の上限・消した bot
    const w6 = wakes.add({ ...where, at: clock + 60 * MIN, note: '取り消す予約' });
    t.ok('取り消しは自分の待っている予約だけ（別の bot・起きた予約は null）', wakes.cancel('b_other', w6.id) === null && wakes.cancel(bot.id, w1.id) === null && wakes.cancel(bot.id, w6.id).status === 'cancelled' && wakes.get(w6.id).status === 'cancelled');
    const pending = wakes.list(bot.id, { status: 'pending' }).length;
    for (let i = pending; i < WAKE_PENDING_MAX; i++) wakes.add({ ...where, at: clock + (100 + i) * MIN, note: `予約 ${i}` });
    t.ok(`待っている予約は 1 体 ${WAKE_PENDING_MAX} 件まで（WAKE_LIMIT）`, fails({ at: clock + 500 * MIN }) === 'WAKE_LIMIT');
    clock += 8 * 1440 * MIN;
    wakes.cancel(bot.id, wakes.list(bot.id, { status: 'pending' })[0].id);
    wakes.add({ ...where, at: clock + 60 * MIN, note: '7 日後の予約' });
    t.ok('終わった予約は 7 日で消える（作るときに片付ける）', wakes.get(w1.id) === null && wakes.get(a.id) === null);
    t.ok('bot を消したら予約も消える', wakes.clear(bot.id) > 0 && wakes.list(bot.id).length === 0);

    // ---- タイマー
    wakes.stop();
    t.ok('止めた後は、タイマーが残らない', timers.length === 0);

    // ---- 案内（bot の指示文）
    const guide = botInstructions(bot, 'ja');
    t.ok('bot の指示文で、会話の中のタイマーではなく brain.wakeAdd を使うよう案内する（毎ターン同じバイト列のまま）', guide.includes('brain.wakeAdd') && guide.includes('Cron') && botInstructions(bot, 'ja') === guide && botInstructions(bot, 'en').includes('brain.wakeAdd'));
  } finally {
    wakes.close();
    brain.close();
    await channels.close();
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5 });
  }
}
