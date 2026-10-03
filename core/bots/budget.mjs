// チャンネルの予算を数えて、bot どうしの呼びかけを止める（ADR 0119。形は core/channels/budget.mjs、使うのは core/bots/dispatch.mjs）。
//
// 数え方: bot のターンが終わるたびに、そのターンのトークンを「その bot のバックエンドの週の使用枠（ply_usage と同じ出どころ）に対する %」の目安にして、
//   スレッドの状態（ThreadState.spend = { day, percent }）に足す。足す先は origin をたどった根のスレッド（bot が流れへ書いて新しいスレッドを作っても、数えるのは 1 か所）。
//   人が呼んだターンも数える。DM（スレッドが無い）は数えない。
//   週の枠 1% あたりのトークン = この PC の Pleiad がその枠の期間（解除の時刻の 7 日前から）に同じバックエンドで使ったトークン ÷ 枠の使用率。
//   枠はその bot のモデルに効く週の枠のうち、いちばん使われているもの（委譲の振り分けと同じ windowsFor）。トークンは入力・出力・キャッシュの合計。
//   枠が読めない・使用率が MIN_USED_PERCENT 未満・記録が無いときは、最後に分かった値を使う。それも無ければ数えない（止めもしない）。
// 止め方: 残り = min(1 スレッドの配分 − 根のスレッドの今日の分, チャンネルの 1 日の予算 − チャンネルの今日の分の合計)。0 になったら、
//   bot どうしの呼びかけ（bot の投稿の @・呼んだ bot へ返す返事）だけ起こさない。人の投稿・人が承認した起こし方は起こす。Pleiad はお知らせを出さない。
//
//   createBudget({ channels, host, now, log }) → Budget
//     host.readQuota(backendId) … 使用枠（server の providerQuota。設定の「使用量」・ply_usage と同じ quotaCache）
//     host.usageStore.tokensSince(backendId, sinceMs) … この PC の記録のトークンの合計
//   Budget:
//     charge({ channelId, threadId, backend, model, usage }): Promise<number|null>   … ターンの終わり。足した %（数えられなかったら null）
//     left({ channelId, threadId, backend?, model? }): Promise<Left|null>           … 予算なし（daily が null）・DM・チャンネルが引けないときは null
//         Left = { daily, perThread, thread, channel, left, known }。thread・channel・left は残りの %。known = その bot の枠を今 % にできるか
//     allows({ channelId, threadId }): Promise<boolean>   … bot どうしの呼びかけを起こしてよいか（残りが 0 より大きい。分からないときは止めない）
//     root(channelId, threadId): Promise<{ channelId, threadId }>
import { windowsFor } from '../delegation-routing.mjs';
import { budgetOf, allowanceOf, dayOf, spentOn, spentToday } from '../channels/budget.mjs';

const WEEK_MINUTES = 10080;
const WEEK_MS = WEEK_MINUTES * 60_000;
/** 使用率がこれ未満の枠からは、1% あたりのトークンを割り出さない（週の始まりの小さな値は、丸めで大きく揺れる） */
export const MIN_USED_PERCENT = 1;
/** ターンの始まりに残りを渡すとき、使用枠の読み取りを待つ上限（ms）。ターンの始まりを遅らせない */
export const LEFT_WAIT_MS = 1500;
const ROOT_HOPS = 20;

const tokensOf = (u) => (u?.inputTokens ?? 0) + (u?.outputTokens ?? 0) + (u?.cachedTokens ?? 0);
const errText = (e) => String(e?.message ?? e);

export function createBudget({ channels, host, now = Date.now, log = () => {} } = {}) {
  const rates = new Map();   // `${backend}:${model}` → 週の枠 1% あたりのトークン（最後に分かった値）
  const keyOf = (backend, model) => `${backend}:${model ?? ''}`;

  /** その bot のモデルに効く週の枠のうち、いちばん使われているもの（効いている枠）。解除の時刻を過ぎた枠は今の値ではないので使わない */
  function weeklyWindow(backend, model, quota, at) {
    const live = windowsFor(backend, model ?? '', quota?.windows ?? [])
      .filter((w) => w.minutes === WEEK_MINUTES && typeof w.usedPercent === 'number' && w.resetsAt && Date.parse(w.resetsAt) > at);
    return live.sort((a, b) => b.usedPercent - a.usedPercent)[0] ?? null;
  }

  async function rateOf(backend, model) {
    const key = keyOf(backend, model);
    try {
      const quota = await host?.readQuota?.(backend);
      const w = quota ? weeklyWindow(backend, model, quota, now()) : null;
      if (w && w.usedPercent >= MIN_USED_PERCENT) {
        const total = await host?.usageStore?.tokensSince?.(backend, Date.parse(w.resetsAt) - WEEK_MS);
        if (total > 0) { const rate = total / w.usedPercent; rates.set(key, rate); return rate; }
      }
    } catch (e) { log('could not read the usage window:', errText(e)); }
    return rates.get(key) ?? null;
  }

  async function root(channelId, threadId) {
    let at = { channelId, threadId };
    for (let i = 0; i < ROOT_HOPS; i++) {
      const origin = (await channels.threads.get(at.channelId, at.threadId).catch(() => null))?.origin;
      if (!origin || (origin.channelId === at.channelId && origin.threadId === at.threadId)) break;
      at = origin;
    }
    return at;
  }

  async function charge({ channelId, threadId, backend, model, usage }) {
    const tokens = tokensOf(usage);
    if (!channelId || !threadId || !backend || !(tokens > 0)) return null;
    const rate = await rateOf(backend, model);
    if (!rate) return null;
    const percent = tokens / rate;
    const at = await root(channelId, threadId);
    const day = dayOf(now());
    await channels.threads.update(at.channelId, at.threadId, (cur) => ({ spend: { day, percent: spentOn(cur, day) + percent } }));
    return percent;
  }

  async function left({ channelId, threadId, backend, model }) {
    if (!channelId || !threadId) return null;
    const at = await root(channelId, threadId);
    const channel = await channels.get({ channelId: at.channelId }).catch(() => null);
    if (!channel || channel.kind !== 'channel') return null;
    const budget = budgetOf(channel);
    if (budget.daily === null) return null;
    const day = dayOf(now());
    const [thread, threads] = await Promise.all([channels.threads.get(at.channelId, at.threadId).catch(() => null), channels.threads.list(at.channelId).catch(() => [])]);
    const threadLeft = Math.max(0, allowanceOf(budget) - spentOn(thread, day));
    const channelLeft = Math.max(0, budget.daily - spentToday(threads, at.channelId, day));
    let known = true;
    if (backend) {
      const cached = rates.get(keyOf(backend, model));
      known = Boolean(cached ?? await Promise.race([rateOf(backend, model), new Promise((r) => { const t = setTimeout(r, LEFT_WAIT_MS, null); t.unref?.(); })]));
    }
    return { ...budget, thread: threadLeft, channel: channelLeft, left: Math.min(threadLeft, channelLeft), known };
  }

  async function allows({ channelId, threadId }) {
    try {
      const l = await left({ channelId, threadId });
      return !l || l.left > 0;
    } catch (e) { log('could not check the budget:', errText(e)); return true; }
  }

  return { charge, left, allows, root };
}
