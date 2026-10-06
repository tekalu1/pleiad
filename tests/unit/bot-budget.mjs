// チャンネルの予算と、使用量の上限の休憩中（ADR 0119）。サーバーも LLM も使わない。
//   core/channels/budget.mjs（形・検査・日付）・core/bots/budget.mjs（週の枠の % の目安で数える・根のスレッドに足す・残り・止めるか）・
//   core/bots/resting.mjs（休憩中・場所ごとに 1 回の知らせ）・core/backends/antigravity-limit.mjs（Antigravity の上限の文）・ThreadState.spend の検査・
//   自発の分（chargeBrain・leftBrain・allowsBrain。家のチャンネルが無い bot も 1 日のトークンの上限で止まる）
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_BUDGET, budgetOf, normalizeBudget, loosensBudget, allowanceOf, dayOf, spentToday } from '../../core/channels/budget.mjs';
import { createBudget, MIN_USED_PERCENT, BRAIN_DAILY_TOKENS } from '../../core/bots/budget.mjs';
import { createBrainStore } from '../../core/brain/store.mjs';
import { createResting } from '../../core/bots/resting.mjs';
import { antigravityLimit } from '../../core/backends/antigravity-limit.mjs';
import { applyThreadPatch, emptyThread } from '../../core/channels/threads.mjs';
import { inputWithCache } from '../../core/usage.mjs';

export const name = 'bot-budget';
export const title = 'チャンネルの予算（週の使用枠の % で数え、使い切ったら bot どうしの呼びかけだけ止める）と、使用量の上限の休憩中';

export default async function (t) {
  // ---------------------------------------------------------------- 形と検査
  t.ok('予算の設定が無いチャンネルは既定（1 日 5%・1 スレッド 50%）', JSON.stringify(budgetOf({})) === JSON.stringify(DEFAULT_BUDGET) && DEFAULT_BUDGET.daily === 5 && DEFAULT_BUDGET.perThread === 50);
  t.ok('daily: null は予算なし（配分も null）', budgetOf({ budget: { daily: null, perThread: 30 } }).daily === null && allowanceOf(budgetOf({ budget: { daily: null } })) === null);
  t.ok('1 スレッドの配分 = 1 日の予算 × 配分の %', allowanceOf({ daily: 4, perThread: 25 }) === 1);
  t.ok('normalizeBudget は渡した欄だけ変える', JSON.stringify(normalizeBudget({ perThread: 20 }, { daily: 3, perThread: 50 })) === JSON.stringify({ daily: 3, perThread: 20 }));
  t.ok('normalizeBudget は範囲の外を断る', [{ daily: -1 }, { daily: 101 }, { perThread: 0 }, { perThread: 'x' }, null].every((b) => { try { normalizeBudget(b, undefined); return false; } catch { return true; } }));
  t.ok('緩める向き: 予算を外す・1 日を上げる・配分を上げる。下げる向きは緩めない',
    loosensBudget({ daily: 5, perThread: 50 }, { daily: null, perThread: 50 }) && loosensBudget({ daily: 5, perThread: 50 }, { daily: 6, perThread: 50 })
    && loosensBudget({ daily: 5, perThread: 50 }, { daily: 5, perThread: 60 }) && !loosensBudget({ daily: 5, perThread: 50 }, { daily: 2, perThread: 10 })
    && !loosensBudget({ daily: null, perThread: 50 }, { daily: 100, perThread: 50 }));
  const day = dayOf(Date.now());
  t.ok('チャンネルの今日の分は、そのチャンネルのスレッドの今日の spend の合計（前の日・別のチャンネルは数えない）',
    spentToday([{ channelId: 'c', spend: { day, percent: 1.5 } }, { channelId: 'c', spend: { day: '2000-01-01', percent: 9 } }, { channelId: 'd', spend: { day, percent: 9 } }, { channelId: 'c' }], 'c', day) === 1.5);
  const th = emptyThread('c', 'p', 1);
  t.ok('ThreadState.spend は { day: YYYY-MM-DD, percent >= 0 } だけ受け付ける', applyThreadPatch(th, { spend: { day, percent: 0.25 } }, 2).spend.percent === 0.25
    && [{ day: 'today', percent: 1 }, { day, percent: -1 }, { day }].every((spend) => { try { applyThreadPatch(th, { spend }, 2); return false; } catch { return true; } }));

  // ---------------------------------------------------------------- 数える・止める（身代わりの channels と使用枠）
  const world = ({ windows, tokens = 10_000, budget } = {}) => {
    const channel = { id: 'c_1', kind: 'channel', name: 'dev', ...(budget !== undefined ? { budget } : {}) };
    const threads = {};
    const channels = {
      get: async ({ channelId }) => (channelId === 'c_1' ? channel : null),
      threads: {
        get: async (c, id) => structuredClone(threads[`${c}/${id}`] ?? null),
        list: async (c) => structuredClone(Object.values(threads).filter((x) => x.channelId === c)),
        update: async (c, id, patch) => {
          const cur = threads[`${c}/${id}`] ??= { channelId: c, threadId: id };
          Object.assign(cur, typeof patch === 'function' ? patch(structuredClone(cur)) : patch);
          return structuredClone(cur);
        },
      },
    };
    const reads = [];
    const host = { readQuota: async (backend) => { reads.push(backend); return windows ? { windows, checkedAt: Date.now() } : { windows: [], checkedAt: null }; }, usageStore: { tokensSince: async () => tokens } };
    return { channel, threads, channels, host, reads, budget: createBudget({ channels, host }) };
  };
  const later = new Date(Date.now() + 86_400_000).toISOString();
  const week = (used, extra = {}) => ({ label: 'week', minutes: 10080, usedPercent: used, resetsAt: later, ...extra });

  {
    const w = world({ windows: [week(10), { label: '5h', minutes: 300, usedPercent: 90, resetsAt: later }], budget: { daily: 2, perThread: 50 } });
    const added = await w.budget.charge({ channelId: 'c_1', threadId: 'p_1', backend: 'codex', model: '', usage: { inputTokens: 300, outputTokens: 100, cachedTokens: 100 } });
    t.ok('1% あたり = 週の枠の期間のトークン ÷ 使用率（5 時間の枠は使わない）。入力・出力・キャッシュの合計を割る', Math.abs(added - 0.5) < 1e-9, String(added));
    t.ok('足す先はスレッドの spend（今日の日付）', w.threads['c_1/p_1'].spend.day === dayOf(Date.now()) && Math.abs(w.threads['c_1/p_1'].spend.percent - 0.5) < 1e-9);
    const left = await w.budget.left({ channelId: 'c_1', threadId: 'p_1', backend: 'codex', model: '' });
    t.ok('残り = min(配分 − スレッドの分, 1 日 − チャンネルの分)。枠が読めれば known', Math.abs(left.thread - 0.5) < 1e-9 && Math.abs(left.channel - 1.5) < 1e-9 && Math.abs(left.left - 0.5) < 1e-9 && left.known, JSON.stringify(left));
    t.ok('残りがあれば bot どうしの呼びかけを起こしてよい', await w.budget.allows({ channelId: 'c_1', threadId: 'p_1' }));
    await w.budget.charge({ channelId: 'c_1', threadId: 'p_1', backend: 'codex', model: '', usage: { inputTokens: 500 } });
    t.ok('配分を使い切ったら起こさない', !(await w.budget.allows({ channelId: 'c_1', threadId: 'p_1' })));
    t.ok('別のスレッドは、チャンネルの残りの範囲で起こせる', await w.budget.allows({ channelId: 'c_1', threadId: 'p_2' }));
    // 派生のスレッド（origin）は根に数える
    w.threads['c_1/p_3'] = { channelId: 'c_1', threadId: 'p_3', origin: { channelId: 'c_1', threadId: 'p_2' } };
    await w.budget.charge({ channelId: 'c_1', threadId: 'p_3', backend: 'codex', model: '', usage: { inputTokens: 500 } });
    t.ok('bot が起こして新しくできたスレッドの分は、origin をたどった根に足す', Math.abs(w.threads['c_1/p_2'].spend.percent - 0.5) < 1e-9 && !w.threads['c_1/p_3'].spend);
    await w.budget.charge({ channelId: 'c_1', threadId: 'p_4', backend: 'codex', model: '', usage: { inputTokens: 500 } });
    t.ok('チャンネルの 1 日の予算を使い切ったら、まだ使っていないスレッドも起こさない', !(await w.budget.allows({ channelId: 'c_1', threadId: 'p_5' })));
  }
  {
    const w = world({ windows: [week(MIN_USED_PERCENT / 2)] });
    t.ok('使用率が小さすぎる枠からは割り出さない（最後の値も無ければ数えない）', (await w.budget.charge({ channelId: 'c_1', threadId: 'p_1', backend: 'codex', model: '', usage: { inputTokens: 500 } })) === null && !w.threads['c_1/p_1']);
    const left = await w.budget.left({ channelId: 'c_1', threadId: 'p_1', backend: 'codex', model: '' });
    t.ok('数えられないときは known: false。止めもしない', left && !left.known && await w.budget.allows({ channelId: 'c_1', threadId: 'p_1' }));
  }
  {
    const w = world({ windows: [week(10)] });
    await w.budget.charge({ channelId: 'c_1', threadId: 'p_1', backend: 'codex', model: '', usage: { inputTokens: 100 } });
    w.host.readQuota = async () => { throw new Error('offline'); };
    t.ok('使用枠が読めなくなったら、最後に分かった 1% あたりで数える', Math.abs((await w.budget.charge({ channelId: 'c_1', threadId: 'p_1', backend: 'codex', model: '', usage: { inputTokens: 1000 } })) - 1) < 1e-9);
  }
  {
    const w = world({ windows: [week(10), week(40, { model: 'opus' })] });
    const added = await w.budget.charge({ channelId: 'c_1', threadId: 'p_1', backend: 'claude', model: 'opus', usage: { inputTokens: 1000 } });
    t.ok('そのモデルに効く週の枠のうち、いちばん使われている枠を使う（Claude の Opus の枠）', Math.abs(added - 4) < 1e-9, String(added));
    const sonnet = await w.budget.charge({ channelId: 'c_1', threadId: 'p_2', backend: 'claude', model: 'sonnet', usage: { inputTokens: 1000 } });
    t.ok('別のモデルの枠は使わない', Math.abs(sonnet - 1) < 1e-9, String(sonnet));
  }
  {
    const none = world({ windows: [week(10)], budget: { daily: null, perThread: 50 } });
    t.ok('予算なしのチャンネルは残りを持たず（null）、止めない', (await none.budget.left({ channelId: 'c_1', threadId: 'p_1' })) === null && await none.budget.allows({ channelId: 'c_1', threadId: 'p_1' }));
    const zero = world({ windows: [week(10)], budget: { daily: 0, perThread: 50 } });
    t.ok('1 日の予算 0 は、bot どうしの呼びかけを最初から起こさない', !(await zero.budget.allows({ channelId: 'c_1', threadId: 'p_1' })));
    t.ok('DM（スレッドが無い）は数えない', (await zero.budget.charge({ channelId: 'c_1', threadId: null, backend: 'codex', model: '', usage: { inputTokens: 100 } })) === null);
  }

  // ---------------------------------------------------------------- 自発の分（心拍・予約。ADR 0126・0140）
  {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bot-budget-brain-'));
    const brain = createBrainStore({ dataDir: dir });
    try {
      const w = world({ windows: [week(10)], budget: { daily: 2, perThread: 50 } });
      const budget = createBudget({ channels: w.channels, host: w.host, brain });
      const today = dayOf(Date.now());
      const noHome = await budget.chargeBrain({ channelId: null, botId: 'b_dm', backend: 'codex', model: '', usage: { inputTokens: 1000, outputTokens: 200, cachedTokens: 1000 } });
      t.ok('家のチャンネルが無い bot（DM だけ）の自発の分も、bot の 1 日のトークンに数える（キャッシュ読みは 1/10。% はどのチャンネルにも足さない）',
        noHome.tokens === 1300 && noHome.percent === null && brain.spentTokens('b_dm', today) === 1300 && brain.spentPercent('c_1', today) === 0, JSON.stringify(noHome));
      const left = await budget.leftBrain({ channelId: null, botId: 'b_dm' });
      t.ok('家が無いときの残りは、1 日のトークンの上限だけ（チャンネルの % は null）', left.tokensLeft === BRAIN_DAILY_TOKENS - 1300 && left.channel === null && left.daily === null, JSON.stringify(left));
      t.ok('上限の内なら、家が無くても自発してよい', await budget.allowsBrain({ channelId: null, botId: 'b_dm' }));
      await budget.chargeBrain({ channelId: null, botId: 'b_dm', usage: { inputTokens: BRAIN_DAILY_TOKENS } });
      t.ok('1 日のトークンの上限を使い切ったら、家が無くても自発しない', !(await budget.allowsBrain({ channelId: null, botId: 'b_dm' })) && (await budget.leftBrain({ channelId: null, botId: 'b_dm' })).tokensLeft === 0);
      await budget.chargeBrain({ channelId: 'c_1', botId: 'b_mix', backend: 'codex', model: '', usage: { inputTokens: 100 } });
      await budget.chargeBrain({ channelId: null, botId: 'b_mix', usage: { inputTokens: 200 } });
      t.ok('同じ bot の、家のチャンネルの分と家が無いときの分は、1 日のトークンでは合わせて数える。チャンネルの % には家の分だけ入る',
        brain.spentTokens('b_mix', today) === 300 && Math.abs(brain.spentPercent('c_1', today) - 0.1) < 1e-9 && (await budget.allowsBrain({ channelId: 'c_1', botId: 'b_mix' })));
      t.ok('指したチャンネルが引けない自発はしない（数える先が無い）。botId が無ければ数えない',
        !(await budget.allowsBrain({ channelId: 'c_missing', botId: 'b_mix' })) && (await budget.chargeBrain({ channelId: null, botId: null, usage: { inputTokens: 10 } })).tokens === 0 && (await budget.leftBrain({ channelId: null, botId: null })) === null);
    } finally {
      brain.close();
      await fs.rm(dir, { recursive: true, force: true, maxRetries: 5 });
    }
  }

  // ---------------------------------------------------------------- スレッドの帯の内訳（channels.threadBudget）
  {
    const w = world({ windows: [week(37)], budget: { daily: 5, perThread: 50 }, tokens: 740_000 });
    w.threads['c_1/p_1'] = { channelId: 'c_1', threadId: 'p_1', sessions: { b_a: 's_a', b_b: 's_b' }, spend: { day: dayOf(Date.now()), percent: 0.04 } };
    w.threads['c_1/p_2'] = { channelId: 'c_1', threadId: 'p_2', sessions: {}, spend: { day: dayOf(Date.now()), percent: 0.5 } };
    const midnight = new Date(); midnight.setHours(0, 0, 0, 0);
    const seen = [];
    w.host.usageStore.records = async ({ sessionIds, since }) => {
      seen.push({ sessionIds, since });
      return [
        { sessionId: 's_a', at: Date.now(), inputTokens: 1000, outputTokens: 100, cachedTokens: 900 },
        { sessionId: 's_a', at: Date.now(), inputTokens: 500, outputTokens: 50, cachedTokens: 0 },
        // キャッシュを入力と分けて数えていた頃の Antigravity の記録（cached が input を超える）は足して読む
        { sessionId: 's_b', at: Date.now(), inputTokens: 100, outputTokens: 20, cachedTokens: 700 },
        { sessionId: 's_other', at: Date.now(), inputTokens: 9999, outputTokens: 9999, cachedTokens: 0 },
      ];
    };
    const bots = [{ id: 'b_a', backend: 'claude', model: '' }, { id: 'b_b', backend: 'antigravity', model: '' }];
    const snap = await w.budget.snapshot({ channelId: 'c_1', threadId: 'p_1', bots, restingOf: (bot) => (bot.id === 'b_b' ? 123 : null) });
    t.ok('分母はこのスレッドの 1 日の配分（1 日 5% × 50% = 2.5%）。使った分は小数のまま（切り捨てない）', snap.allowance === 2.5 && snap.spent === 0.04 && snap.daily === 5 && snap.perThread === 50, JSON.stringify(snap));
    t.ok('今日の 0 時以降の、このスレッドの会話の記録だけを集める', seen[0].since === midnight.getTime() && seen[0].sessionIds.join() === 's_a,s_b');
    const a = snap.bots.find((b) => b.botId === 'b_a'), b = snap.bots.find((x) => x.botId === 'b_b');
    t.ok('bot ごとの今日の使用: 入力はキャッシュ読みを含み、cached はその内訳', a.today.input === 1500 && a.today.output === 150 && a.today.cached === 900, JSON.stringify(a.today));
    t.ok('古い Antigravity の記録（cached > input）は入力にキャッシュを足して読み、割合が 100% を超えない', b.today.input === 800 && b.today.cached === 700 && inputWithCache({ inputTokens: 100, cachedTokens: 700 }) === 800 && inputWithCache({ inputTokens: 1000, cachedTokens: 900 }) === 1000);
    t.ok('bot の上限の目安 = 配分 × 週の枠 1% あたりのトークン（740000 ÷ 37 × 2.5）。週の枠と休憩中の解除時刻も返す', a.allowanceTokens === 50000 && a.window.usedPercent === 37 && a.window.resetsAt === later && b.restingUntil === 123 && a.restingUntil === null, JSON.stringify(a));
    t.ok('チャンネルの今日の分は、スレッド全体の spend の合計', Math.abs(snap.channelSpent - 0.54) < 1e-9 && snap.derived === false);
    const derived = await w.budget.snapshot({ channelId: 'c_1', threadId: 'p_9', bots });
    t.ok('1 日の予算が無いチャンネル・DM は、配分が null / スナップショットが null', (await world({ windows: [week(10)], budget: { daily: null, perThread: 50 } }).budget.snapshot({ channelId: 'c_1', threadId: 'p_1', bots })).allowance === null && (await w.budget.snapshot({ channelId: 'c_nope', threadId: 'p_1', bots })) === null && derived.bots.length === 0);
    const unknown = world({ windows: [], budget: { daily: 5, perThread: 50 } });
    unknown.threads['c_1/p_1'] = { channelId: 'c_1', threadId: 'p_1', sessions: { b_a: 's_a' } };
    const none = await unknown.budget.snapshot({ channelId: 'c_1', threadId: 'p_1', bots });
    t.ok('使用枠を読めない bot は、上限の目安と週の枠が null（0 や NaN にしない）', none.bots[0].allowanceTokens === null && none.bots[0].window === null);
  }

  // ---------------------------------------------------------------- 動いている bot の印（ThreadState.live）
  {
    const th = emptyThread('c', 'p', 1);
    const on = applyThreadPatch(th, { live: { b_a: 'working', b_b: 'waiting' } }, 2);
    t.ok('live は bot ごとの working / waiting', on.live.b_a === 'working' && on.live.b_b === 'waiting');
    t.ok('live は丸ごと置き換える。空で外す', JSON.stringify(applyThreadPatch(on, { live: { b_c: 'working' } }, 3).live) === '{"b_c":"working"}' && applyThreadPatch(on, { live: {} }, 3).live === undefined);
    t.ok('live の不正な形は断る', [{ b: 'idle' }, [], null, 'x'].every((live) => { try { applyThreadPatch(th, { live }, 2); return false; } catch { return true; } }));
  }

  // ---------------------------------------------------------------- 休憩中
  {
    let clock = 1_000_000;
    const changes = [];
    const r = createResting({ now: () => clock, onChange: (k) => changes.push(k) });
    const a = { backend: 'antigravity', model: 'gemini' }, b = { backend: 'antigravity', model: 'gemini' }, c = { backend: 'claude', model: '' };
    t.ok('時刻が分からない・過ぎた上限では休まない', r.rest(a, null) === null && r.rest(a, clock - 1) === null && r.until(a) === null);
    r.rest(a, clock + 60_000);
    t.ok('同じバックエンド・モデルの bot は一緒に休む。別のバックエンドは休まない', r.until(b) === clock + 60_000 && r.until(c) === null && changes.join() === 'antigravity:gemini');
    t.ok('知らせは場所ごとに 1 回', r.noticeOnce(a, 'c/p1') && !r.noticeOnce(b, 'c/p1') && r.noticeOnce(a, 'c/p2'));
    clock += 60_001;
    t.ok('解除の時刻を過ぎたら休憩中でなくなり、知らせも出さない', r.until(a) === null && !r.noticeOnce(a, 'c/p3'));
    r.stop();
  }

  // ---------------------------------------------------------------- Antigravity の上限の文
  {
    const now = 1_000_000;
    const real = antigravityLimit('Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 4h14m6s.', now);
    t.ok('実物の上限の文を見分け、「Resets in 4h14m6s」から解除の時刻を出す', real?.resetsAt === now + ((4 * 60 + 14) * 60 + 6) * 1000, JSON.stringify(real));
    t.ok('解除の時刻が無い上限の文は resetsAt: null', antigravityLimit('RESOURCE_EXHAUSTED: rate limit exceeded', now)?.resetsAt === null);
    t.ok('上限でない失敗は null', antigravityLimit('fetch failed', now) === null && antigravityLimit(undefined, now) === null && antigravityLimit('the file resets in 2h', now) === null);
  }
}
