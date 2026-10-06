// スレッドの帯の予算メーター（web/channels/thread-budget.mjs）と、流れの要約の「作業中の bot」の選び方（web/channels/post.mjs）の、画面を持たない判定。
// 描画（棒・内訳の面・押して開く）は tests/browser/channels.cjs。数え方（分母・bot ごとの内訳）は tests/unit/bot-budget.mjs。
import { readFileSync } from 'node:fs';
import { meterOf, tokenSplit, tokensShort, weeklyText, MIN_FILL } from '../../web/channels/thread-budget.mjs';
import { liveBotIds } from '../../web/channels/post.mjs';

export const name = 'thread-budget-ui';
export const title = 'スレッドの予算メーター（分母は 1 スレッドの 1 日の配分・小数を切り捨てない）・トークンの分け方（キャッシュは別）・要約の作業中の bot の選び方';

const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');

export default function (t) {
  const now = new Date(2026, 9, 4, 12, 0).getTime();
  const day = '2026-10-04';
  const budget = { daily: 5, perThread: 50 };   // 配分は 2.5%

  // ---- メーター
  const m = meterOf(budget, { spend: { day, percent: 0.04 } }, now);
  t.ok('分母は 1 スレッドの配分（5% × 50% = 2.5%）。使った分 ÷ 配分', m.allowance === 2.5 && Math.abs(m.ratio - 0.016) < 1e-9 && m.spent === 0.04, JSON.stringify(m));
  t.ok('週の枠の 0.04% でも、配分の 1.6% として棒が動く（0 に張り付かない）', m.fill >= MIN_FILL && m.text === '2%', `${m.fill} ${m.text}`);
  const tiny = meterOf(budget, { spend: { day, percent: 0.0004 } }, now);
  t.ok('配分の 1% 未満は「<1%」。棒は最小の長さで見える', tiny.text === '<1%' && tiny.fill === MIN_FILL);
  const none = meterOf(budget, { spend: { day, percent: 0 } }, now);
  t.ok('まだ使っていなければ 0%・棒は空', none.text === '0%' && none.fill === 0 && none.high === false);
  t.ok('前の日の分は数えない', meterOf(budget, { spend: { day: '2026-10-03', percent: 2 } }, now).text === '0%');
  const near = meterOf(budget, { spend: { day, percent: 2 } }, now);
  t.ok('80% 以上は high（強い字）。使い切っても 100% で止まる', near.high && near.text === '80%' && meterOf(budget, { spend: { day, percent: 9 } }, now).text === '100%' && meterOf(budget, { spend: { day, percent: 9 } }, now).fill === 100);
  t.ok('99% を超えても、使い切るまでは 100% と書かない', meterOf(budget, { spend: { day, percent: 2.49 } }, now).text === '99%');
  t.ok('予算の無いチャンネル・DM・配分 0 は null', meterOf({ daily: null, perThread: 50 }, null, now) === null && meterOf(null, null, now) === null && meterOf({ daily: 0, perThread: 50 }, null, now) === null);

  // ---- 数の書き方
  t.ok('トークンの短い書き方', tokensShort(0) === '0' && tokensShort(999) === '999' && tokensShort(1234) === '1.2k' && tokensShort(150_000) === '150k' && tokensShort(1_940_000) === '1.9M' && tokensShort(250_000_000) === '250M');
  t.ok('週の枠に対する % は 0.04 のような小さな値も 0 にしない', weeklyText(0.0369) === '0.04%' && weeklyText(2.5) === '2.5%' && weeklyText(37) === '37%' && weeklyText(0) === '0%' && weeklyText(0.001) === '<0.01%');

  // ---- トークンの分け方: キャッシュ読みは入力に含まれる。数字には含めず、別に見せる
  const split = tokenSplit({ input: 2_942_000, output: 4_000, cached: 2_700_000 });
  t.ok('新しい入力 = 入力 − キャッシュ読み。合計にキャッシュを入れない', split.fresh === 242_000 && split.output === 4_000 && split.cached === 2_700_000 && split.total === 246_000, JSON.stringify(split));
  const legacy = tokenSplit({ input: 100, output: 20, cached: 700 });
  t.ok('キャッシュが入力より大きい古い Antigravity の形は、入力をキャッシュを含まない数として読む（キャッシュ 100% にも負の数にもならない）', legacy.fresh === 100 && legacy.cached === 700 && legacy.total === 120, JSON.stringify(legacy));
  t.ok('空・欠けた値でも落ちない', tokenSplit(undefined).total === 0 && tokenSplit({ input: 5 }).fresh === 5);

  // ---- 要約: 作業中の bot は ThreadState.live から選ぶ
  const live = { b_mike: 'working', b_hana: 'waiting', b_taro: 'working' };
  t.ok('作業中の要約は、working の bot だけ（waiting の bot は含めない）。印の並び', liveBotIds({ state: 'working', live }).join() === 'b_mike,b_taro');
  t.ok('あなた待ちの要約は、waiting の bot', liveBotIds({ state: 'waiting', live }).join() === 'b_hana');
  t.ok('印が無い・空なら空（返信した最後の bot や最初の会話の bot を名前にしない）', liveBotIds({ state: 'working' }).length === 0 && liveBotIds({ state: 'working', live: {} }).length === 0 && liveBotIds(null).length === 0);
  const post = read('web/channels/post.mjs');
  t.ok('要約は返信した最後の bot（s.authors）と th.sessions の最初のキーを使わない', !/s\.authors/.test(post.slice(post.indexOf('export function renderSummary'))) && !/Object\.keys\(th\?\.sessions/.test(post));

  // ---- 配線
  const thread = read('web/channels/thread.mjs');
  t.ok('帯は予算の文字列でなくメーター（Chats の文脈のメーターと同じ部品）を使う', /createBudgetMeter/.test(thread) && !/th-band-budget/.test(thread) && /context-meter/.test(read('web/channels/thread-budget.mjs')));
  t.ok('トークンは tokenSplit の合計（キャッシュ読みを除く）', /tokenSplit\(th\?\.tokens\)/.test(thread));
}
