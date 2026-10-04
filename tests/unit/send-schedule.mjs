import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSchedule } from '../../core/schedule.mjs';
import { buildSendRow, decideFire, sendArgs, decorateScheduled, addRecord, parseAt,
  GRACE_MS, MAX_AHEAD_MS, MAX_RECORDS } from '../../core/send-schedule.mjs';
import { presets, dayChips, parseTime, targetAt, spanText, leftText, whenText, hostTimeText } from '../../web/schedule-times.mjs';

export const name = 'send-schedule';
export const title = '送信予定: 行の組み立て・遅れの判定・予定の戻しと二重発火と取り出し・日時の候補と指定';

const HOUR = 3_600_000;

export default async function (t) {
  // ---- 行の組み立て
  const now = Date.UTC(2026, 9, 3, 0, 0, 0);
  const base = { sessionId: 's1', messageId: 'msg-00000001', prompt: '明日の朝、PR を作って', at: now + 7 * HOUR };
  const row = buildSendRow(base, now);
  t.ok('行の id は送信の messageId から決まる（同じ指定は 1 件）', row.id === 'send:msg-00000001' && row.kind === 'send' && row.messageId === 'msg-00000001');
  t.ok('時刻は UTC のミリ秒のまま持つ', row.at === now + 7 * HOUR && row.createdAt === now);
  t.ok('本文・添付・作業場所・モードは args に入る', buildSendRow({ ...base, attachments: [{ path: 'a.txt' }], cwd: '/w', mode: 'plan' }, now).args.mode === 'plan');
  const bad = (patch, text) => { try { buildSendRow({ ...base, ...patch }, now); return false; } catch (e) { return text ? e.message.includes(text) : true; } };
  t.ok('過ぎた時刻・すぐの時刻は予定にできない', bad({ at: now - 1000 }) && bad({ at: now + 500 }));
  t.ok('1 年より先は予定にできない', bad({ at: now + MAX_AHEAD_MS + 1000 }));
  t.ok('読めない時刻・空の本文・不正な送信 ID を断る', bad({ at: 'あした' }) && bad({ prompt: '  ' }) && bad({ messageId: 'x' }));
  t.ok('ISO の文字・数字の文字も時刻として読む', parseAt('2026-10-03T09:00:00Z') === Date.UTC(2026, 9, 3, 9) && parseAt('1790000000000') === 1790000000000 && Number.isNaN(parseAt('')));

  // ---- 遅れの判定（スリープ・閉じていた間に過ぎた予定）
  const due = { ...row, at: now };
  t.ok('時刻どおりなら送る', decideFire(due, now).action === 'send' && decideFire(due, now + 3000).lateMs === 3000);
  t.ok('1 時間以内の遅れなら送る', decideFire(due, now + GRACE_MS).action === 'send');
  t.ok('1 時間を超えたら送らずに確かめる', decideFire(due, now + GRACE_MS + 1).action === 'hold');
  t.ok('outbox に渡す引数に予定の時刻を添える（履歴の「9:00 の予定を 9:32 に送りました」）', sendArgs(row).scheduledFor === row.at && sendArgs(row).prompt === row.args.prompt);

  // ---- 履歴の発言への時刻の付与
  const messages = [
    { role: 'user', text: 'a', at: '2026-10-03T00:00:00Z' },
    { role: 'assistant', text: 'ok', at: '2026-10-03T00:00:05Z' },
    { role: 'user', text: '明日の朝、PR を作って', at: '2026-10-03T09:32:00Z' },
    { role: 'user', text: '明日の朝、PR を作って', at: '2026-10-04T09:00:00Z' },
  ];
  const records = addRecord([], { ...row, at: Date.parse('2026-10-03T09:00:00Z') });
  const decorated = decorateScheduled(messages, records);
  t.ok('本文が同じで予定の後の最初の発言に付く', decorated[2].scheduledFor === Date.parse('2026-10-03T09:00:00Z') && decorated[0].scheduledFor === undefined);
  t.ok('記録は 1 件に 1 発言だけ当てる（同じ本文の次の発言には付けない）', decorated[3].scheduledFor === undefined);
  t.ok('記録が無ければ発言をそのまま返す', decorateScheduled(messages, []) === messages);
  let kept = [];
  for (let i = 0; i < MAX_RECORDS + 5; i++) kept = addRecord(kept, { ...row, at: i, args: { prompt: String(i) } });
  t.ok('会話に覚える記録は古いものから捨てる', kept.length === MAX_RECORDS && kept.at(-1).text === String(MAX_RECORDS + 4));

  // ---- schedule.json: 戻し・取り出し・二重発火・確かめ待ち・失敗の再試行
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-send-schedule-'));
  const file = path.join(scratch, 'schedule.json');
  let clock = 1000;
  const timers = { unref() {} };
  const common = { file, now: () => clock, setTimer: () => timers, clearTimer() {} };
  try {
    const fired = [];
    const one = createSchedule({ ...common, fire: async r => { fired.push(r.id); } });
    await one.put({ id: 'send:a', kind: 'send', sessionId: 's', at: 5000, createdAt: 1, messageId: 'a', args: { prompt: 'a' } });
    await one.put({ id: 'send:b', kind: 'send', sessionId: 's', at: 9000, createdAt: 2, messageId: 'b', args: { prompt: 'b' } });
    const restored = createSchedule({ ...common, fire: async r => { fired.push(`restored:${r.id}`); } });
    await restored.restore();
    t.ok('再起動で予定を戻す（本文も残る）', restored.list().length === 2 && restored.list()[0].args.prompt === 'a');
    t.ok('時刻前は発火しない', fired.length === 0);

    const taken = await restored.take('send:b');
    t.ok('「編集」「今すぐ送る」は予定を取り出す（取り出した後は時刻が来ても動かない）', taken?.args.prompt === 'b' && restored.list().length === 1);
    clock = 12_000;
    await Promise.all([restored.check(), restored.check()]);
    t.ok('時刻が来ると一度だけ発火して予定が消える（二重の確認でも 1 回）', fired.join() === 'restored:send:a' && restored.list().length === 0);
    t.ok('取り出した予定は発火しない', !fired.includes('restored:send:b'));
    t.ok('無い予定の取り出しは null', (await restored.take('send:zzz')) === null);

    // 送らずに確かめを待つ行（hold）は、時刻が過ぎていても二度発火せず、一覧に残る
    let holds = 0;
    const holdFile = path.join(scratch, 'hold.json');
    const holder = createSchedule({ file: holdFile, now: () => clock, setTimer: () => timers, clearTimer() {}, fire: async () => { holds++; return { hold: 'missed' }; } });
    await holder.put({ id: 'send:h', kind: 'send', sessionId: 's', at: 100, createdAt: 3, messageId: 'h', args: { prompt: 'h' } });
    await holder.check(); await holder.check();
    t.ok('過ぎて送らない予定は一覧に残り、held が付く', holds === 1 && holder.list()[0]?.held === 'missed');
    const reloaded = createSchedule({ file: holdFile, now: () => clock, setTimer: () => timers, clearTimer() {}, fire: async () => { holds++; } });
    await reloaded.restore();
    t.ok('再起動しても held の予定は発火しない', holds === 1 && reloaded.list()[0]?.held === 'missed');
    t.ok('patch で行の欄だけ更新する（通知済みの印）', (await reloaded.patch('send:h', { notified: true })) && reloaded.get('send:h').notified === true && reloaded.get('send:h').at === 100);
    t.ok('人が取り消せば消える', (await reloaded.cancel('send:h')) && reloaded.list().length === 0);

    // 失敗した発火は 1 分後に再試行し、予定の時刻（at）は変えない（遅れの判定に使う）
    let attempts = 0;
    const retryFile = path.join(scratch, 'retry.json');
    const retry = createSchedule({ file: retryFile, now: () => clock, setTimer: () => timers, clearTimer() {}, fire: async () => { if (++attempts === 1) throw new Error('busy'); } });
    await retry.put({ id: 'send:r', kind: 'send', sessionId: 's', at: clock - 10, createdAt: 4, messageId: 'r', args: { prompt: 'r' } });
    await retry.check();
    t.ok('失敗した予定は残り、予定の時刻は保つ', attempts === 1 && retry.list()[0].at === clock - 10 && retry.list()[0].retryAt === clock + 60_000);
    await retry.check();
    t.ok('1 分たつまで再試行しない', attempts === 1);
    clock += 61_000;
    await retry.check();
    t.ok('1 分後に再試行して成功すれば消える', attempts === 2 && retry.list().length === 0);

    // 発火の最中に取り消されても、消した予定が戻らない
    const racing = createSchedule({ file: path.join(scratch, 'race.json'), now: () => clock, setTimer: () => timers, clearTimer() {},
      fire: async r => { await racing.cancel(r.id); throw new Error('late failure'); } });
    await racing.put({ id: 'send:x', kind: 'send', sessionId: 's', at: clock - 1, createdAt: 5, messageId: 'x', args: { prompt: 'x' } });
    await racing.check();
    t.ok('発火の最中の取り消しは、失敗の再試行で戻らない', racing.list().length === 0);
  } finally {
    if (path.resolve(scratch).startsWith(path.resolve(os.tmpdir()) + path.sep)) await fs.rm(scratch, { recursive: true, force: true });
  }

  // ---- 日時の候補と指定（見ている端末の時刻帯。ここでは実行環境の時刻帯の同じ壁時計で組む）
  const at = (y, mo, d, h = 0, mi = 0) => new Date(y, mo, d, h, mi).getTime();
  const keys = (n, opts) => presets(n, opts).map(p => p.key).join();
  const sat0149 = at(2026, 9, 3, 1, 49);
  t.ok('朝 6 時前は今朝 9:00・今日 18:00・明日の朝・月曜の朝（土曜）', keys(sat0149) === 'morning,evening,tomorrow,monday', keys(sat0149));
  const ps = presets(sat0149);
  t.ok('候補の時刻は 9:00・18:00・明日 9:00・月曜 9:00', ps[0].at === at(2026, 9, 3, 9) && ps[1].at === at(2026, 9, 3, 18) && ps[2].at === at(2026, 9, 4, 9) && ps[3].at === at(2026, 9, 5, 9));
  t.ok('近い候補は「あと」の長さ、遠い候補は日付を補足に出す', ps[0].hint.includes('7 時間') && ps[2].hint.includes('10/4') && ps[3].hint.includes('10/5'), JSON.stringify(ps.map(p => p.hint)));
  t.ok('朝 6 時を過ぎたら今朝 9:00 は出さない（水曜 7:00）', keys(at(2026, 9, 7, 7)) === 'evening,tomorrow,monday', keys(at(2026, 9, 7, 7)));
  t.ok('18:00 の 10 分前を過ぎたら今日 18:00 は出さない', keys(at(2026, 9, 7, 17, 55)) === 'tomorrow,monday');
  t.ok('火曜は月曜まで遠いので出さない・日曜は明日が月曜なので重ねない', !keys(at(2026, 9, 6, 10)).includes('monday') && !keys(at(2026, 9, 4, 10)).includes('monday'));
  t.ok('「上限の解除後」は候補にしない（上限中に送れば、解除まで送信待ちで同じ動きになる。ADR 0129）', !presets(sat0149, { resetsAt: sat0149 + 41 * 60_000 }).some(p => p.key === 'reset'));

  const days = dayChips(sat0149);
  t.ok('日のチップは 7 日分（今日・明日・以降は日付）', days.length === 7 && days[0].offset === 0 && days[1].sub.includes('10/4') && days[2].label.includes('10/5'));
  t.ok('時刻の欄は 9:00・9・0930・午後を読む', parseTime('9:00')?.h === 9 && parseTime('9')?.h === 9 && parseTime('0930')?.m === 30 && parseTime('9 pm')?.h === 21 && parseTime('12 am')?.h === 0);
  t.ok('読めない時刻は null', parseTime('abc') === null && parseTime('25:00') === null && parseTime('9:60') === null && parseTime('13 pm') === null);
  t.ok('日と時刻から送る時刻を作る', targetAt(1, '9:00', sat0149) === at(2026, 9, 4, 9));
  t.ok('過ぎた時刻・読めない時刻・1 年より先は null', targetAt(0, '1:00', sat0149) === null && targetAt(0, 'x', sat0149) === null && targetAt(400, '9:00', sat0149) === null);
  t.ok('長さの書き方（分・時間と分・日と時間）', spanText(41 * 60_000) === '41 分' && spanText(65 * 60_000) === '1 時間 5 分' && spanText(31 * HOUR) === '1 日 7 時間');
  t.ok('「あと 7 時間 11 分」', leftText(sat0149 + (7 * 60 + 11) * 60_000, sat0149) === 'あと 7 時間 11 分');
  t.ok('今日は時刻だけ、ほかの日は日付つき', !whenText(at(2026, 9, 3, 9), sat0149).includes('10/') && whenText(at(2026, 9, 4, 9), sat0149).includes('10/4'));
  t.ok('ホストと同じ時刻帯なら PC の時刻は添えない', hostTimeText(sat0149, Intl.DateTimeFormat().resolvedOptions().timeZone) === null && hostTimeText(sat0149, null) === null);
  const otherZone = Intl.DateTimeFormat().resolvedOptions().timeZone === 'Asia/Tokyo' ? 'America/New_York' : 'Asia/Tokyo';
  t.ok('時刻帯が違えば、ホストの時刻帯での時刻を添える', typeof hostTimeText(sat0149, otherZone) === 'string' && hostTimeText(sat0149, otherZone).length > 4);
}
