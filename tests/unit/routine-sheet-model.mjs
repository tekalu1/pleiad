// ルーティンの編集のシート・脇・見出しの決まりごと（web/channels/routine-model.mjs・routine-store.mjs。DOM に触れない）と、入口の配線。
// 画面の打鍵は tests/browser/routine-sheet.cjs。
import { readFileSync } from 'node:fs';
import {
  KINDS, DISABLED_KINDS, defaultTrigger, defaultRoutineMode, validRoutineMode, newDraft, fromRoutine, switchKind, fieldsOf, sameDraft, validate,
  parseCron, nextCron, describeCron, nextRun, dayKind, sortForSide, lastFailed, listOf, applyChange, minutesText, triggerText, daysText, timeText,
} from '../../web/channels/routine-model.mjs';
import { createRoutineStore } from '../../web/channels/routine-store.mjs';

export const name = 'routine-sheet-model';
export const title = 'ルーティンの編集: 検査・保存する欄・cron の見積もり・脇の並べ方・一覧の写し・入口の配線';

const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');
const at = (y, mo, d, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();
const fmtTime = (ms) => { const d = new Date(ms); return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`; };

// 辞書の代わり（キーと変数をそのまま並べる）
const tt = (key, vars = {}) => `${key.replace('channels:routines.', '')}${Object.keys(vars).length ? `(${Object.entries(vars).map(([k, v]) => `${k}=${v}`).join(',')})` : ''}`;

const MODES = { default: { scope: 'workspace', autonomy: 'ask' }, plan: { scope: 'none', autonomy: 'ask' }, bypass: { scope: 'full', autonomy: 'never' } };

export default async function (t) {
  // ---- 種類・既定
  t.ok('種類は 6 つで、webhook は今は選べない', KINDS.join() === 'daily,weekly,interval,cron,event,webhook' && DISABLED_KINDS.join() === 'webhook');
  t.ok('種類ごとの既定のトリガ', defaultTrigger('daily').at === '09:00' && defaultTrigger('weekly').days.join() === '1' && defaultTrigger('interval').minutes === 30
    && defaultTrigger('cron').expr === '0 9 * * 1-5' && defaultTrigger('event').on === 'failed' && defaultTrigger('event').scope === 'all');
  t.ok('種類を替えても時刻は引き継ぐ（毎日 → 毎週）。同じ種類なら同じもの', switchKind({ kind: 'daily', at: '07:30', weekdaysOnly: true }, 'weekly').at === '07:30'
    && switchKind({ kind: 'interval', minutes: 5 }, 'cron').kind === 'cron' && switchKind(defaultTrigger('cron'), 'cron').expr === '0 9 * * 1-5');

  // ---- 承認モードの既定: 無人で動くので「確認なし・制限なし」は写さない
  t.ok('bot が都度確認ならそれを使う', defaultRoutineMode(MODES, 'default') === 'default' && defaultRoutineMode(MODES, 'plan') === 'plan');
  t.ok('bot が全部自動なら、語彙の既定（default）にする', defaultRoutineMode(MODES, 'bypass') === 'default');
  t.ok('語彙に default が無ければ強くないものの先頭。Antigravity（全部自動だけ）はそれしか無い', defaultRoutineMode({ ask: MODES.default, yolo: MODES.bypass }, 'yolo') === 'ask'
    && defaultRoutineMode({ yolo: MODES.bypass }, 'yolo') === 'yolo' && defaultRoutineMode({}, 'x') === '');
  t.ok('バックエンドを替えて語彙に無いモードは語彙の既定へ。あれば保つ', validRoutineMode(MODES, 'plan') === 'plan' && validRoutineMode({ yolo: MODES.bypass }, 'default') === 'yolo');

  // ---- 検査
  const base = () => ({ ...newDraft({ botId: 'b_owl', channelId: 'c_daily', mode: 'default' }), name: '朝のまとめ', prompt: '失敗した会話をまとめて' });
  t.ok('そろっていれば保存できる', validate(base()).ok);
  const bad = (patch) => validate({ ...base(), ...patch }).errors;
  t.ok('名前・指示が空（空白だけ）は落とす', bad({ name: '  ' }).name === 'name' && bad({ prompt: '\n' }).prompt === 'prompt');
  t.ok('bot・チャンネルが無いのは落とす', bad({ botId: '' }).bot === 'bot' && bad({ channelId: '' }).channel === 'channel');
  t.ok('時刻が空・形が違うのは落とす', bad({ trigger: { kind: 'daily', at: '', weekdaysOnly: false } }).trigger === 'time' && bad({ trigger: { kind: 'daily', at: '24:00', weekdaysOnly: false } }).trigger === 'time');
  t.ok('毎週は曜日が 1 つ以上要る', bad({ trigger: { kind: 'weekly', days: [], at: '09:00' } }).trigger === 'days' && !bad({ trigger: { kind: 'weekly', days: [0], at: '09:00' } }).trigger);
  t.ok('間隔は 1 分以上。時間帯は両端があり、違う時刻', bad({ trigger: { kind: 'interval', minutes: 0 } }).trigger === 'minutes'
    && bad({ trigger: { kind: 'interval', minutes: 30, window: { from: '09:00', to: '09:00' } } }).trigger === 'window'
    && bad({ trigger: { kind: 'interval', minutes: 30, window: { from: '09:00', to: '' } } }).trigger === 'window'
    && !bad({ trigger: { kind: 'interval', minutes: 30, window: { from: '22:00', to: '06:00' } } }).trigger);
  t.ok('cron は 5 欄で読めるものだけ', bad({ trigger: { kind: 'cron', expr: '0 9 * *' } }).trigger === 'cron' && bad({ trigger: { kind: 'cron', expr: '61 9 * * *' } }).trigger === 'cron'
    && bad({ trigger: { kind: 'cron', expr: '*/0 * * * *' } }).trigger === 'cron' && !bad({ trigger: { kind: 'cron', expr: '*/15 9-17 * * 1-5' } }).trigger);
  t.ok('イベントは 3 つのどれか。webhook は作れない', !bad({ trigger: { kind: 'event', on: 'waiting', scope: 'all' } }).trigger && bad({ trigger: { kind: 'event', on: 'x', scope: 'all' } }).trigger === 'event'
    && bad({ trigger: { kind: 'webhook', hookId: '' } }).trigger === 'kind');

  // ---- 保存する欄
  const f = fieldsOf({ ...base(), name: ' 朝のまとめ ', prompt: ' 調べて\n', trigger: { kind: 'weekly', days: [0, 3, 1, 3], at: '09:00', extra: 1 }, approvalTimeoutMin: 0 });
  t.ok('保存する欄: 前後の空白を除き、曜日は重複なく昇順、余計な欄は持たない、期限が無ければ 30 分', f.name === '朝のまとめ' && f.prompt === '調べて' && f.trigger.days.join() === '0,1,3' && !('extra' in f.trigger) && f.approvalTimeoutMin === 30);
  t.ok('間隔の時間帯が片方だけなら持たない', !('window' in fieldsOf({ ...base(), trigger: { kind: 'interval', minutes: 30, window: { from: '09:00', to: '' } } }).trigger));
  t.ok('cron は空白を 1 つに畳む', fieldsOf({ ...base(), trigger: { kind: 'cron', expr: '  0   9 *  * 1-5 ' } }).trigger.expr === '0 9 * * 1-5');
  const routine = { id: 'r_1', name: '夜の見回り', botId: 'b_owl', channelId: 'c_daily', prompt: '見回って', trigger: { kind: 'daily', at: '23:00', weekdaysOnly: false }, mode: 'default', approvalTimeoutMin: 15, paused: false, createdBy: { kind: 'human' }, createdAt: 1 };
  const d1 = fromRoutine(routine);
  t.ok('ルーティンから下書きを作ると、直さない限り同じ内容。直すと違う', sameDraft(d1, fromRoutine(routine)) && !sameDraft({ ...d1, prompt: '別' }, fromRoutine(routine)));
  d1.trigger.at = '08:00';
  t.ok('下書きはルーティンと領域を共有しない（直しても元は変わらない）', routine.trigger.at === '23:00');

  // ---- cron
  const c = parseCron('*/15 9-17 * * 1-5');
  t.ok('cron: 一覧・範囲・刻みを解く。曜日 7 は日曜', c.minute.size === 4 && c.hour.size === 9 && c.dow.size === 5 && parseCron('0 0 * * 7').dow.has(0) && parseCron('5/20 * * * *').minute.has(45));
  t.ok('cron: 読めない式は null', parseCron('') === null && parseCron('* * * *') === null && parseCron('0-70 * * * *') === null && parseCron('a * * * *') === null && parseCron('5-3 * * * *') === null);
  // 2026-10-03 は土曜日
  t.ok('cron: 平日の 9:00 の次は、土曜からなら月曜 10/5', fmtTime(nextCron('0 9 * * 1-5', at(2026, 10, 3, 10, 0))) === '10/5 9:00', fmtTime(nextCron('0 9 * * 1-5', at(2026, 10, 3, 10, 0))));
  t.ok('cron: 今ちょうどの分は含めない（その次）', fmtTime(nextCron('30 9 * * *', at(2026, 10, 5, 9, 30))) === '10/6 9:30' && fmtTime(nextCron('30 9 * * *', at(2026, 10, 5, 9, 29))) === '10/5 9:30');
  t.ok('cron: 日と曜日の両方を指定したときはどちらかに合えばよい（OR）', fmtTime(nextCron('0 0 1 * 1', at(2026, 10, 3, 0, 0))) === '10/5 0:00' && fmtTime(nextCron('0 0 1 * 1', at(2026, 10, 30, 12, 0))) === '11/1 0:00');
  t.ok('cron: 月の指定・うるう日（2/29）を見る。1 年先までに無ければ null', fmtTime(nextCron('0 12 29 2 *', at(2027, 12, 1))) === '2/29 12:00' && nextCron('0 12 31 2 *', at(2026, 3, 1)) === null && nextCron('0 12 29 2 *', at(2026, 3, 1)) === null);
  t.ok('cron: 読めない式は null', nextCron('x', 0) === null);
  t.ok('cron の読み下し: 毎日・平日・曜日の指定。それ以外は null', JSON.stringify(describeCron('0 9 * * *')) === '{"kind":"daily","at":"09:00"}'
    && JSON.stringify(describeCron('30 7 * * 1-5')) === '{"kind":"weekdays","at":"07:30"}' && JSON.stringify(describeCron('0 9 * * 1,4')) === '{"kind":"weekly","at":"09:00","days":[1,4]}'
    && describeCron('*/5 * * * *') === null && describeCron('0 9 1 * *') === null && describeCron('0 9 * 3 *') === null);

  // ---- 毎日・毎週の次の時刻
  const sat = at(2026, 10, 3, 10, 0);
  t.ok('毎日: 今日の時刻がまだ先なら今日、過ぎていれば明日', fmtTime(nextRun({ kind: 'daily', at: '23:00', weekdaysOnly: false }, sat)) === '10/3 23:00' && fmtTime(nextRun({ kind: 'daily', at: '09:00', weekdaysOnly: false }, sat)) === '10/4 9:00');
  t.ok('毎日（平日だけ）: 土曜の朝なら月曜', fmtTime(nextRun({ kind: 'daily', at: '09:00', weekdaysOnly: true }, sat)) === '10/5 9:00');
  t.ok('毎週: 指定の曜日だけ。日曜と木曜なら土曜からは日曜', fmtTime(nextRun({ kind: 'weekly', days: [0, 4], at: '09:00' }, sat)) === '10/4 9:00' && nextRun({ kind: 'weekly', days: [], at: '09:00' }, sat) === null);
  t.ok('間隔・イベント・webhook・時刻が不正なものは見積もらない', nextRun({ kind: 'interval', minutes: 5 }, sat) === null && nextRun({ kind: 'event', on: 'done', scope: 'all' }, sat) === null && nextRun({ kind: 'daily', at: '', weekdaysOnly: false }, sat) === null);
  t.ok('今日・明日・それ以外', dayKind(at(2026, 10, 3, 23, 0), sat) === 'today' && dayKind(at(2026, 10, 4, 0, 5), sat) === 'tomorrow' && dayKind(at(2026, 10, 6, 9, 0), sat) === 'date' && dayKind(at(2026, 10, 2, 9, 0), sat) === 'date');

  // ---- 脇の並べ方
  const rs = [
    { id: 'p', name: '依存の更新', paused: true, nextAt: 5 },
    { id: 'e', name: 'イベント', nextAt: null },
    { id: 'b', name: 'b', nextAt: 300 },
    { id: 'a', name: 'a', nextAt: 100 },
    { id: 'a2', name: 'A2', nextAt: 100 },
  ];
  t.ok('脇: 次の時刻の近い順 → 時刻の無いもの → 一時停止。同じ時刻は名前順', sortForSide(rs).map((r) => r.id).join() === 'a,a2,b,e,p');
  t.ok('脇: 入力を変えない・空でも落ちない', rs[0].id === 'p' && sortForSide(undefined).length === 0);
  t.ok('直近の失敗だけ「失敗」', lastFailed({ last: { state: 'failed' } }) && !lastFailed({ last: { state: 'done' } }) && !lastFailed({}) && !lastFailed(null));

  // ---- 一覧の写し
  t.ok('routines.list の返りは { routines } でも配列でも読む。id の無い行は捨てる', listOf({ routines: [{ id: 'r_1' }, { name: 'x' }, null] }).length === 1 && listOf([{ id: 'r_2' }]).length === 1 && listOf(null).length === 0 && listOf({}).length === 0);
  let list = [{ id: 'r_1', name: 'a', nextAt: 10 }];
  list = applyChange(list, { routine: { id: 'r_1', name: 'b' } });
  t.ok('出来事: 同じ id は上書き。nextAt が来なければ古い値を保つ', list.length === 1 && list[0].name === 'b' && list[0].nextAt === 10);
  list = applyChange(list, { routine: { id: 'r_1', nextAt: 99 } });
  t.ok('出来事: nextAt が来たら新しい値', list[0].nextAt === 99);
  list = applyChange(list, { routine: { id: 'r_2', name: 'c' } });
  t.ok('出来事: 知らない id は足す。removed は外す。どちらも無ければそのまま', list.length === 2 && applyChange(list, { removed: 'r_1' }).length === 1 && applyChange(list, {}) === list);

  // ---- 文言（辞書の代わりの t）
  t.ok('分の読み方: 分・時間・日', minutesText(30, tt) === 'unit.minutes(count=30)' && minutesText(120, tt) === 'unit.hours(count=2)' && minutesText(1440, tt) === 'unit.days(count=1)' && minutesText(90, tt) === 'unit.minutes(count=90)');
  t.ok('時刻は先頭の 0 を落とす', timeText('09:05') === '9:05' && timeText('23:00') === '23:00' && timeText('') === '');
  t.ok('曜日は月から日の順に並べて区切る', daysText([0, 3, 1], tt) === 'day.1daySepday.3daySepday.0');
  t.ok('トリガの読み', triggerText({ kind: 'daily', at: '09:00', weekdaysOnly: true }, tt).startsWith('text.weekdays') && triggerText({ kind: 'daily', at: '09:00', weekdaysOnly: false }, tt).startsWith('text.daily')
    && triggerText({ kind: 'interval', minutes: 30, window: { from: '09:00', to: '19:00' } }, tt).includes('text.window') && triggerText({ kind: 'cron', expr: '0 9 * * *' }, tt).includes('expr=0 9 * * *')
    && triggerText({ kind: 'event', on: 'failed', scope: 'all' }, tt) === 'text.event.failed' && triggerText({ kind: 'webhook', hookId: 'h' }, tt) === 'text.webhook');

  // ---- 一覧の写し（store）: 読めなくても黙って空・出来事で更新・購読の後始末
  const calls = [];
  let fail = true;
  const host = { invoke: async (op, args) => { calls.push(op); if (fail) throw new Error('unknown op'); return { routines: [{ id: 'r_1', name: 'a', botId: 'b_owl', channelId: 'c_1', nextAt: 5 }, { id: 'r_2', name: 'b', botId: 'b_lynx', channelId: 'c_1' }] }; } };
  const store = createRoutineStore(host);
  let notified = 0;
  const off = store.subscribe(() => { notified += 1; });
  await new Promise((r) => setTimeout(r, 20));
  t.ok('routines.list が使えない（R1 より前）ときは空のまま、読めた扱い・落ちない', store.list().length === 0 && store.loaded && calls[0] === 'routines.list' && notified === 1);
  fail = false;
  store.onEvent({ type: 'channelPost' });   // 読めていなければ、ほかの出来事でも読み直す
  await new Promise((r) => setTimeout(r, 20));
  t.ok('次の出来事で読み直す。チャンネル・bot ごとに引ける', store.list().length === 2 && store.forChannel('c_1').length === 2 && store.forBot('b_owl').length === 1 && store.get('r_2')?.name === 'b');
  store.onEvent({ type: 'routinesChanged', routine: { id: 'r_3', name: 'c', botId: 'b_owl', channelId: 'c_2' } });
  t.ok('routinesChanged はその場で当てる', store.list().length === 3 && store.forChannel('c_2').length === 1);
  store.onEvent({ type: 'routinesChanged', removed: 'r_3' });
  store.put({ id: 'r_1', name: 'a2' });
  store.drop('r_2');
  t.ok('removed・put・drop', store.list().length === 1 && store.get('r_1').name === 'a2' && store.get('r_1').nextAt === 5);
  off();

  // ---- 配線（ソースの文字列。画面を持たないテストで、つなぎ忘れを見つける）
  const index = read('web/channels/index.mjs'), sidebar = read('web/channels/sidebar.mjs'), feed = read('web/channels/feed.mjs'), sheet = read('web/channels/routine-sheet.mjs');
  t.ok('入口: index.mjs が部品を並べる・脇が行と＋を持つ・見出しがボタンを置く', /parts\.push\(createRoutineSheet\(host\)\)/.test(index) && /openRoutine\(\{ routineId/.test(sidebar) && /sortForSide/.test(sidebar) && /headingButton\(host, ch\)/.test(feed));
  t.ok('シートは routines.* の操作だけを呼ぶ（新しい WS コマンドを足さない）', ['create', 'update', 'pause', 'resume', 'delete', 'run', 'get'].every((op) => sheet.includes(`routines.${op}`)) && !/cmd\('(?!modes)/.test(sheet.replace(/host\.cmd\('modes'/g, '')));
  t.ok('試しに動かすは dryRun: true で呼ぶ', /routines\.run', \{ routineId: id, dryRun: true \}/.test(sheet));
  t.ok('webhook は選べない形だけ（今は disabled）', /DISABLED_KINDS/.test(sheet));
}
