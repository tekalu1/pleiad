// 5 欄の cron 式の解析と次の時刻・トリガの検査・次の発火・頻度の目安・イベントの選び方（core/routines/{cron,schedule,events}.mjs。ADR 0112）。
// 時刻は PC の現地時刻（テストも new Date(年, 月, 日, 時, 分) の現地時刻で書くので、どのタイムゾーンでも同じ結果になる）。
import { parseCron, cronProblem, nextCron, CronError } from '../../core/routines/cron.mjs';
import { validateTrigger, TriggerError, nextFireAt, firesPerWeek, isTimed } from '../../core/routines/schedule.mjs';
import { eventOfOutcome, fromBotSide, matchingRoutines } from '../../core/routines/events.mjs';

export const name = 'routines-cron';
export const title = 'ルーティンの式: cron の解析と次の時刻・毎日/毎週/間隔（時間帯つき）の次の発火・トリガの検査・頻度の目安・イベントの選び方';

const at = (y, mo, d, h = 0, mi = 0, s = 0) => new Date(y, mo - 1, d, h, mi, s, 0).getTime();
const fmt = (ms) => (ms === null ? 'null' : (() => { const d = new Date(ms); return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`; })());
const next = (expr, after) => nextCron(parseCron(expr), after);

export default async function (t) {
  // ---- 解析
  const spec = parseCron('*/15 9-17 * * 1-5');
  t.ok('解析: */15 は 0・15・30・45 分、9-17 は 9〜17 時、1-5 は月〜金', [...spec.minute].join() === '0,15,30,45' && spec.hour.size === 9 && spec.hour.has(9) && spec.hour.has(17) && [...spec.dow].join() === '1,2,3,4,5');
  t.ok('解析: 曜日の 7 は日曜（0）・英語の 3 字（mon・jan）も読める', parseCron('0 0 * * 7').dow.has(0) && parseCron('0 0 1 jan mon').month.has(1) && parseCron('0 0 1 jan mon').dow.has(1));
  t.ok('解析: a/n は a から最後まで n おき、a,b,c と範囲の混在', [...parseCron('5/20 * * * *').minute].join() === '5,25,45' && [...parseCron('1,3-5,10 * * * *').minute].join() === '1,3,4,5,10');
  for (const [expr, why] of [['* * * *', '4 欄'], ['* * * * * *', '6 欄（秒）'], ['60 * * * *', '分の範囲外'], ['* 24 * * *', '時の範囲外'], ['* * 0 * *', '日の下限'], ['* * * 13 *', '月の範囲外'],
    ['* * * * 8', '曜日の範囲外'], ['5-3 * * * *', '逆向きの範囲'], ['*/0 * * * *', 'step 0'], ['a * * * *', '読めない語'], ['1,,2 * * * *', '空の項目'], ['', '空'], ['1/2/3 * * * *', 'step が 2 つ']]) {
    t.ok(`解析: 不正な式を断る（${why}）`, cronProblem(expr) !== null && (() => { try { parseCron(expr); return false; } catch (e) { return e instanceof CronError; } })());
  }
  t.ok('解析: 前後・間の余分な空白は許す', cronProblem('  0   9  *  *  1-5 ') === null && parseCron('  0   9  *  *  1-5 ').expr === '0 9 * * 1-5');

  // ---- 次の時刻
  t.ok('毎分: 12:00:30 の次は 12:01:00（秒以下は 0）', next('* * * * *', at(2026, 10, 5, 12, 0, 30)) === at(2026, 10, 5, 12, 1));
  t.ok('毎分: ちょうど 12:01:00 の次は 12:02（自分自身は含まない）', next('* * * * *', at(2026, 10, 5, 12, 1)) === at(2026, 10, 5, 12, 2));
  t.ok('毎日 9:00: 8:59 の次は当日 9:00、9:00 の次は翌日 9:00', next('0 9 * * *', at(2026, 10, 5, 8, 59)) === at(2026, 10, 5, 9) && next('0 9 * * *', at(2026, 10, 5, 9)) === at(2026, 10, 6, 9));
  t.ok('月末をまたぐ: 10/31 23:59 の次の毎日 0:00 は 11/1', next('0 0 * * *', at(2026, 10, 31, 23, 59)) === at(2026, 11, 1));
  t.ok('年をまたぐ: 12/31 23:59 → 1/1 0:00', next('0 0 * * *', at(2026, 12, 31, 23, 59)) === at(2027, 1, 1));
  // 2026-10-05 は月曜
  t.ok('平日だけ 9:00: 金曜 10:00 の次は月曜 9:00（週末を飛ばす）', next('0 9 * * 1-5', at(2026, 10, 9, 10)) === at(2026, 10, 12, 9), fmt(next('0 9 * * 1-5', at(2026, 10, 9, 10))));
  t.ok('曜日: 月曜 8:00 の次の「日曜 7:30」は 10/11', next('30 7 * * 0', at(2026, 10, 5, 8)) === at(2026, 10, 11, 7, 30));
  t.ok('日と曜日の両方を絞ると「どちらかに当たれば」: 13 日か金曜', next('0 0 13 * 5', at(2026, 10, 5)) === at(2026, 10, 9) && next('0 0 13 * 5', at(2026, 10, 9, 0, 0, 1)) === at(2026, 10, 13));
  t.ok('月の絞り: 3 月 1 日 0:00（10 月からは翌年）', next('0 0 1 3 *', at(2026, 10, 5)) === at(2027, 3, 1));
  t.ok('2 月 29 日は次のうるう年（2028）', next('0 0 29 2 *', at(2026, 10, 5)) === at(2028, 2, 29));
  t.ok('存在しない日（2 月 30 日）は null（8 年探して諦める）', next('0 0 30 2 *', at(2026, 10, 5)) === null);
  t.ok('時間帯を絞った毎分: 9:00〜9:02 の間の毎分、9:02 の次は翌日 9:00', next('0-2 9 * * *', at(2026, 10, 5, 9, 2)) === at(2026, 10, 6, 9));
  t.ok('*/n の刻み: 12:07 の次の */10 は 12:10', next('*/10 * * * *', at(2026, 10, 5, 12, 7)) === at(2026, 10, 5, 12, 10));

  // ---- トリガの検査
  const bad = (trigger) => { try { validateTrigger(trigger); return false; } catch (e) { return e instanceof TriggerError; } };
  t.ok('検査: daily は HH:MM（24 時間）・weekdaysOnly は真偽', validateTrigger({ kind: 'daily', at: '09:00', weekdaysOnly: true }).weekdaysOnly === true && validateTrigger({ kind: 'daily', at: '09:00' }).weekdaysOnly === false
    && bad({ kind: 'daily', at: '9:00' }) && bad({ kind: 'daily', at: '24:00' }) && bad({ kind: 'daily' }));
  t.ok('検査: weekly は曜日 0〜6 の重複なし・昇順', JSON.stringify(validateTrigger({ kind: 'weekly', days: [3, 1, 3], at: '07:30' }).days) === '[1,3]' && bad({ kind: 'weekly', days: [], at: '07:30' }) && bad({ kind: 'weekly', days: [7], at: '07:30' }));
  t.ok('検査: interval は分が整数 1〜10080・window は from と to が違う HH:MM', validateTrigger({ kind: 'interval', minutes: 30, window: { from: '09:00', to: '18:00' } }).window.to === '18:00'
    && bad({ kind: 'interval', minutes: 0 }) && bad({ kind: 'interval', minutes: 1.5 }) && bad({ kind: 'interval', minutes: 10081 }) && bad({ kind: 'interval', minutes: 5, window: { from: '09:00', to: '09:00' } }));
  t.ok('検査: cron は式を整えて持つ・不正は断る', validateTrigger({ kind: 'cron', expr: ' 0  9 * * 1-5 ' }).expr === '0 9 * * 1-5' && bad({ kind: 'cron', expr: '99 * * * *' }));
  t.ok('検査: event は on が done / failed / waiting・scope は all か空でない sessionIds（重複なし）', validateTrigger({ kind: 'event', on: 'failed' }).scope === 'all'
    && JSON.stringify(validateTrigger({ kind: 'event', on: 'done', scope: { sessionIds: ['a', 'a', 'b'] } }).scope) === '{"sessionIds":["a","b"]}'
    && bad({ kind: 'event', on: 'stopped' }) && bad({ kind: 'event', on: 'done', scope: { sessionIds: [] } }) && bad({ kind: 'event', on: 'done', scope: 'some' }));
  t.ok('検査: webhook は hookId だけ（受け口は P3。型と分岐の入れ物）。知らない種類・余計な欄は断る／落とす', validateTrigger({ kind: 'webhook', hookId: 'h_x', extra: 1 }).hookId === 'h_x' && !('extra' in validateTrigger({ kind: 'webhook', hookId: 'h_x', extra: 1 }))
    && bad({ kind: 'webhook' }) && bad({ kind: 'monthly' }) && bad(null) && bad('daily'));
  t.ok('時刻で動くのは daily・weekly・interval・cron だけ', ['daily', 'weekly', 'interval', 'cron'].every((kind) => isTimed({ kind })) && !isTimed({ kind: 'event' }) && !isTimed({ kind: 'webhook' }));

  // ---- 次の発火
  const daily = { kind: 'daily', at: '09:00', weekdaysOnly: false };
  t.ok('毎日: 基準の後の次の 9:00（現地時刻）', nextFireAt(daily, at(2026, 10, 5, 8)) === at(2026, 10, 5, 9) && nextFireAt(daily, at(2026, 10, 5, 9, 0, 0)) === at(2026, 10, 6, 9));
  t.ok('毎日（平日だけ）: 金曜の 9:00 の次は月曜の 9:00', nextFireAt({ ...daily, weekdaysOnly: true }, at(2026, 10, 9, 9)) === at(2026, 10, 12, 9));
  t.ok('毎週: 水・金 07:30、月曜の基準なら次は水曜', nextFireAt({ kind: 'weekly', days: [3, 5], at: '07:30' }, at(2026, 10, 5, 8)) === at(2026, 10, 7, 7, 30));
  t.ok('時刻で動かないトリガ（event・webhook）の次の発火は null', nextFireAt({ kind: 'event', on: 'done', scope: 'all' }, 0) === null && nextFireAt({ kind: 'webhook', hookId: 'h' }, 0) === null);
  const every30 = { kind: 'interval', minutes: 30 };
  t.ok('間隔: 基準（前に動いた時刻）から minutes 後', nextFireAt(every30, at(2026, 10, 5, 12, 0)) === at(2026, 10, 5, 12, 30));
  const window = { kind: 'interval', minutes: 30, window: { from: '09:00', to: '18:00' } };
  t.ok('間隔（時間帯つき）: 帯の中ならそのまま', nextFireAt(window, at(2026, 10, 5, 12, 0)) === at(2026, 10, 5, 12, 30));
  t.ok('間隔（時間帯つき）: 帯の前（8:00 + 30 分 = 8:30）は当日の帯の頭 9:00', nextFireAt(window, at(2026, 10, 5, 8, 0)) === at(2026, 10, 5, 9, 0));
  t.ok('間隔（時間帯つき）: 帯の終わり 18:00 までは動き、その次（18:30）は翌日の 9:00', nextFireAt(window, at(2026, 10, 5, 17, 30)) === at(2026, 10, 5, 18, 0) && nextFireAt(window, at(2026, 10, 5, 18, 0)) === at(2026, 10, 6, 9, 0));
  const overnight = { kind: 'interval', minutes: 60, window: { from: '22:00', to: '02:00' } };
  t.ok('間隔（夜をまたぐ帯 22:00〜02:00）: 23:00 → 0:00（帯の中）、2:00 → 3:00 は帯の外なので当日の 22:00', nextFireAt(overnight, at(2026, 10, 5, 23, 0)) === at(2026, 10, 6, 0, 0) && nextFireAt(overnight, at(2026, 10, 6, 2, 0)) === at(2026, 10, 6, 22, 0));
  t.ok('基準が数でないなら null', nextFireAt(daily, NaN) === null);

  // ---- 頻度の目安（update が「頻度を上げる」かの判定）
  const per = (trigger) => firesPerWeek(trigger);
  t.ok('頻度: 毎日 = 週 7 回・平日だけ = 週 5 回・週 2 回 = 2', per(daily) === 7 && per({ ...daily, weekdaysOnly: true }) === 5 && per({ kind: 'weekly', days: [1, 4], at: '07:00' }) === 2);
  t.ok('頻度: 毎分の cron は週 10080 回（数える上限）・時間帯つきの 30 分おきは 1 日 19 回 × 7', per({ kind: 'cron', expr: '* * * * *' }) === 10080 && per(window) === 19 * 7, String(per(window)));
  t.ok('頻度: 30 分おきより 60 分おきは少ない・出来事は数えない（null）', per({ kind: 'interval', minutes: 60 }) < per(every30) && per({ kind: 'event', on: 'done', scope: 'all' }) === null);

  // ---- イベントの選び方
  t.ok('出来事: ok → done・error → failed・それ以外は無し', eventOfOutcome('ok') === 'done' && eventOfOutcome('error') === 'failed' && eventOfOutcome('aborted') === null);
  t.ok('出来事: bot の会話（thread・dm・routine・learner のどれも）から来たものは対象にしない', ['thread', 'dm', 'routine', 'learner'].every((kind) => fromBotSide({ botId: 'b_1', kind })) && !fromBotSide(null) && !fromBotSide(undefined));
  const routines = [
    { id: 'r1', paused: false, trigger: { kind: 'event', on: 'failed', scope: 'all' } },
    { id: 'r2', paused: false, trigger: { kind: 'event', on: 'failed', scope: { sessionIds: ['s1'] } } },
    { id: 'r3', paused: true, trigger: { kind: 'event', on: 'failed', scope: 'all' } },
    { id: 'r4', paused: false, trigger: { kind: 'event', on: 'done', scope: 'all' } },
    { id: 'r5', paused: false, trigger: { kind: 'daily', at: '09:00', weekdaysOnly: false } },
  ];
  t.ok('出来事: on が合い・一時停止でなく・scope に当たるものだけ（all は全部、sessionIds は含むものだけ）', matchingRoutines(routines, { on: 'failed', sessionId: 's1' }).map((r) => r.id).join() === 'r1,r2'
    && matchingRoutines(routines, { on: 'failed', sessionId: 's2' }).map((r) => r.id).join() === 'r1' && matchingRoutines(routines, { on: 'done', sessionId: 's1' }).map((r) => r.id).join() === 'r4'
    && matchingRoutines(routines, { on: 'waiting', sessionId: 's1' }).length === 0);
}
