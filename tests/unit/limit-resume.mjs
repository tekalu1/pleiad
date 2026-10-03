import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { normalizeSdkMessage } from '../../core/backends/claude-normalize.mjs';
import { codexLimitError } from '../../core/backends/codex-limit.mjs';
import { createSchedule } from '../../core/schedule.mjs';
import { createResumeQueue, normalizeLimitResume } from '../../core/resume-queue.mjs';

export const name = 'limit-resume';
export const title = '使用量の上限の正規化・予定の戻し・再開待ち行列';
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

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

  const started = [];
  const guarded = [];
  let percent = 12;
  const queue = createResumeQueue({ start: async row => { started.push(row.sessionId); }, guard: async () => percent,
    guarded: (row, used) => guarded.push([row.sessionId, used]),
    settings: () => normalizeLimitResume({ concurrency: 3, guardPercent: 50 }) });
  for (let i = 1; i <= 5; i++) queue.enqueue({ sessionId: `s${i}`, sentAt: i });
  await wait(110);
  t.ok('最後に送った 3 会話から並行して再開する', started.join() === 's5,s4,s3', started.join());
  percent = 50;
  queue.settled('s5');
  await wait(10);
  t.ok('50% に達したら未開始の再開を止めて一度知らせる', queue.view().paused
    && queue.view().pending.length === 2 && guarded.length === 1 && guarded[0][1] === 50);
  queue.continue();
  await wait(10);
  t.ok('人が続けると次の会話を開始する', started.includes('s2'));
}
