import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { normalizeSdkMessage } from '../../core/backends/claude-normalize.mjs';
import { codexLimitError, codexResetOf } from '../../core/backends/codex-limit.mjs';
import { createSchedule } from '../../core/schedule.mjs';
import { POLL_MS, resumePlan, limitHolds, limitOpen } from '../../core/limit-resume.mjs';

export const name = 'limit-resume';
export const title = '使用量の上限の正規化・予定の戻しと再予約・自動再開の時刻と使用量の判断・Codex の解除時刻';

export default async function (t) {
  // 2026-10-02 16:43Z の transcript の assistant 行から、本文と識別子を除いた形。
  const transcript = { type: 'assistant', error: 'rate_limit', isApiErrorMessage: true,
    apiErrorStatus: 429, quotaLimits: { status: 'rejected', resetsAt: 1790962200,
      rateLimitType: 'five_hour' }, message: { model: '<synthetic>', content: [{ type: 'text', text: '' }] } };
  const event = normalizeSdkMessage(transcript).find(e => e.type === 'limit');
  t.ok('実例の assistant error から解除時刻と枠が取れる', event?.resetsAt === 1790962200000 && event.window === 'five_hour');
  const live = normalizeSdkMessage({ type: 'rate_limit_event', rate_limit_info: transcript.quotaLimits });
  t.ok('SDK の rate_limit_event は同じ形になる', live[0]?.type === 'limit' && live[0].resetsAt === event.resetsAt);
  t.ok('Codex の上限の失敗文だけを拾う', codexLimitError({ message: "You've hit your usage limit" })
    && !codexLimitError({ message: 'Tool failed: invalid argument' }));

  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-limit-schedule-'));
  const file = path.join(scratch, 'schedule.json');
  let now = 1000;
  let fired = 0;
  const timer = () => ({ unref() {} });
  try {
    const one = createSchedule({ file, now: () => now, setTimer: timer, clearTimer() {}, fire: async () => { fired++; } });
    await one.put({ id: 'resume:a', kind: 'resume', sessionId: 'a', at: 2000, createdAt: 1000, by: 'limit' });
    const saved = JSON.parse(await fs.readFile(file, 'utf8'));
    t.ok('予定は schedule.json に保存される', saved.entries.length === 1 && saved.entries[0].kind === 'resume');
    const restored = createSchedule({ file, now: () => now, setTimer: timer, clearTimer() {}, fire: async () => { fired++; } });
    await restored.restore();
    t.ok('起動時に未来の予定を戻す', restored.list().length === 1 && fired === 0);
    now = 2100;
    await Promise.all([restored.check(), restored.check()]);
    t.ok('解除後の確認と二重の確認でも一度だけ発火する', fired === 1 && restored.list().length === 0, String(fired));
  } finally {
    if (path.resolve(scratch).startsWith(path.resolve(os.tmpdir()) + path.sep)) await fs.rm(scratch, { recursive: true, force: true });
  }

  // ---- 予定: 解除時刻が分からない上限は、同じ行のまま 30 分後に確かめ直す（fire の { reschedule }）
  const scratch2 = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-limit-poll-'));
  try {
    let clock = 10_000;
    let answers = [{ reschedule: clock + POLL_MS }, undefined];
    const fires = [];
    const poll = createSchedule({ file: path.join(scratch2, 'schedule.json'), now: () => clock, setTimer: timer, clearTimer() {},
      fire: async row => { fires.push(row.at); return answers.shift(); } });
    await poll.put({ id: 'resume:p', kind: 'resume', sessionId: 'p', at: clock, createdAt: 1, by: 'limit', poll: true });
    await poll.check();
    t.ok('空いていなければ行を残して 30 分後に確かめ直す', poll.list().length === 1 && poll.list()[0].at === 10_000 + POLL_MS && poll.list()[0].poll === true, JSON.stringify(poll.list()));
    await poll.check();
    t.ok('30 分たつまでは確かめない', fires.length === 1);
    clock += POLL_MS;
    await poll.check();
    t.ok('空いたら行を消す', fires.length === 2 && poll.list().length === 0);
    const reloaded = createSchedule({ file: path.join(scratch2, 'schedule.json'), now: () => clock, setTimer: timer, clearTimer() {}, fire: async () => {} });
    await poll.put({ id: 'resume:q', kind: 'resume', sessionId: 'q', at: clock + 5, createdAt: 2, by: 'limit', poll: true });
    await reloaded.restore();
    t.ok('確かめ直しの行も schedule.json から戻る（poll の印つき）', reloaded.list().length === 1 && reloaded.list()[0].poll === true);
  } finally {
    if (path.resolve(scratch2).startsWith(path.resolve(os.tmpdir()) + path.sep)) await fs.rm(scratch2, { recursive: true, force: true });
  }

  // ---- 自動再開の時刻（12 時間の線は無い）
  const base = Date.parse('2026-10-04T10:00:00Z');
  const week = base + 3 * 24 * 60 * 60_000;
  t.ok('解除が 12 時間より先（週の上限）でも、その時刻に予定を置く', resumePlan(week, base).at === week && resumePlan(week, base).poll === false && resumePlan(week, base).resetsAt === week);
  t.ok('解除時刻が分からないなら 30 分後から確かめる', resumePlan(null, base).poll === true && resumePlan(null, base).at === base + POLL_MS && resumePlan(null, base).resetsAt === null);
  t.ok('解除時刻がもう過ぎている（取得元が古い）ときも、すぐ再開せず 30 分後に確かめる', resumePlan(base - 1, base).poll === true && resumePlan(base - 1, base).at === base + POLL_MS);
  t.ok('解除前は送信待ち。解除時刻を過ぎたら待ちを解く', limitHolds({ resetsAt: base + 1000 }, base) && !limitHolds({ resetsAt: base }, base) && !limitHolds({ resetsAt: base - 1 }, base));
  t.ok('解除時刻が分からない上限は、自動再開が入っている間だけ待ち、外したら待たない', limitHolds({ resetsAt: null, autoResume: true }, base) && !limitHolds({ resetsAt: null, autoResume: false }, base));

  // ---- 使用量で空きを確かめる（解除時刻が分からない上限）
  const win = (usedPercent, over = {}) => ({ label: 'x', usedPercent, resetsAt: null, minutes: 300, ...over });
  t.ok('枠が 100% 未満なら空いた', limitOpen({ windows: [win(40)] }, {}, base) === true);
  t.ok('100% のままならまだ上限', limitOpen({ windows: [win(100)] }, {}, base) === false);
  t.ok('5 時間枠で止まったなら、週の枠が 100% でも 5 時間枠だけを見る', limitOpen({ windows: [win(30), win(100, { minutes: 10080 })] }, { window: 'five_hour' }, base) === true);
  t.ok('どの枠か分からないなら、100% の枠が 1 つでもあれば上限', limitOpen({ windows: [win(30), win(100, { minutes: 10080 })] }, {}, base) === false);
  t.ok('解除時刻を過ぎた枠は、使用率が古いので空いたものとして数える', limitOpen({ windows: [win(100, { resetsAt: new Date(base - 1000).toISOString() })] }, {}, base) === true);
  t.ok('枠が無い・使用率が数でないときは読めない（次の確認まで待つ）', limitOpen({ windows: [] }, {}, base) === null && limitOpen({ windows: [win(null)] }, {}, base) === null && limitOpen(null, {}, base) === null);
  const accounts = { accounts: [{ accountId: 'a', windows: [win(100)] }, { accountId: 'b', windows: [win(10)] }] };
  t.ok('Claude の複数アカウントは、止まったアカウントの枠を見る', limitOpen(accounts, { account: 'a' }, base) === false && limitOpen(accounts, { account: 'b' }, base) === true);

  // ---- Codex の解除時刻: 使い切った枠のうち最も遅く解ける時刻
  const iso = ms => new Date(ms).toISOString();
  const five = { label: '5 時間', usedPercent: 100, resetsAt: iso(base + 3 * 3600_000) };
  const weekly = { label: '週', usedPercent: 100, resetsAt: iso(base + 2 * 24 * 3600_000) };
  t.ok('Codex は 5 時間枠も週の枠も使い切っているなら、週の解除時刻を使う', codexResetOf([five, weekly], base)?.resetsAt === Date.parse(weekly.resetsAt) && codexResetOf([five, weekly], base).window === '週');
  t.ok('Codex は使い切った枠だけを見る（5 時間枠だけが 100% なら、使っていない週の枠は関係しない）',
    codexResetOf([five, { ...weekly, usedPercent: 40 }], base)?.resetsAt === Date.parse(five.resetsAt));
  t.ok('Codex はどれも 100% でなければ、一番早く解ける枠のまま', codexResetOf([{ ...five, usedPercent: 60 }, { ...weekly, usedPercent: 20 }], base)?.resetsAt === Date.parse(five.resetsAt));
  t.ok('Codex は過ぎた枠・時刻のない枠を数えない', codexResetOf([{ ...weekly, resetsAt: iso(base - 1) }, { label: 'x', usedPercent: 100, resetsAt: null }], base) === null && codexResetOf(undefined, base) === null);
}
