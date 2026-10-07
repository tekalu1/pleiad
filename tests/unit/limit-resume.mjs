import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { normalizeSdkMessage } from '../../core/backends/claude-normalize.mjs';
import { codexLimitError, codexResetOf } from '../../core/backends/codex-limit.mjs';
import { createSchedule } from '../../core/schedule.mjs';
import { limitHolds, limitResetsAt } from '../../core/limit-resume.mjs';

export const name = 'limit-resume';
export const title = '使用量の上限の正規化・古い自動再開の予定を戻さない・送信待ちを待たせるかの判断・Codex の解除時刻';

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

  // ---- 予定: 自動再開の予定（kind: resume。ADR 0161 で廃止）は戻さない。送信予定は戻す
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-limit-schedule-'));
  const file = path.join(scratch, 'schedule.json');
  let fired = 0;
  const timer = () => ({ unref() {} });
  try {
    await fs.writeFile(file, JSON.stringify({ version: 1, entries: [
      { id: 'resume:a', kind: 'resume', sessionId: 'a', at: 500, createdAt: 100, by: 'limit' },
      { id: 'resume:b', kind: 'resume', sessionId: 'b', at: 5000, createdAt: 100, by: 'limit', poll: true },
      { id: 'send:c', kind: 'send', sessionId: 'c', at: 5000, createdAt: 100, by: 'human', messageId: 'm-c' },
    ] }));
    const restored = createSchedule({ file, now: () => 1000, setTimer: timer, clearTimer() {}, fire: async () => { fired++; } });
    await restored.restore();
    t.ok('古い kind: resume の行は読まず、時刻を過ぎていても撃たない', fired === 0 && restored.list().map(r => r.id).join() === 'send:c', JSON.stringify(restored.list()));
    t.ok('kind: resume の行は新しく置けない', await restored.put({ id: 'resume:d', kind: 'resume', sessionId: 'd', at: 2000 }).then(() => false, () => true));
    await restored.put({ id: 'send:e', kind: 'send', sessionId: 'e', at: 9000, messageId: 'm-e' });
    const saved = JSON.parse(await fs.readFile(file, 'utf8'));
    t.ok('次に保存したファイルには古い行が残らない', saved.entries.every(r => r.kind === 'send') && saved.entries.length === 2, JSON.stringify(saved.entries));
  } finally {
    if (path.resolve(scratch).startsWith(path.resolve(os.tmpdir()) + path.sep)) await fs.rm(scratch, { recursive: true, force: true });
  }

  // ---- 解除時刻の判断（自動では再開しない。上限中に送った指示を待たせるかだけ）
  const base = Date.parse('2026-10-04T10:00:00Z');
  t.ok('解除前は送信待ち。解除時刻を過ぎたら待ちを解く', limitHolds({ resetsAt: base + 1000 }, base) && !limitHolds({ resetsAt: base }, base) && !limitHolds({ resetsAt: base - 1 }, base));
  t.ok('解除時刻が分からない上限は待たせない（古い自動再開の印が残っていても）', !limitHolds({ resetsAt: null }, base) && !limitHolds({ resetsAt: null, autoResume: true }, base) && !limitHolds(null, base));
  t.ok('保存する解除時刻は未来のときだけ。過ぎた・分からないなら null', limitResetsAt(base + 5, base) === base + 5 && limitResetsAt(base, base) === null && limitResetsAt(undefined, base) === null);

  // ---- Codex の解除時刻: 使い切った枠のうち最も遅く解ける時刻
  const iso = ms => new Date(ms).toISOString();
  const five = { label: '5 時間', usedPercent: 100, resetsAt: iso(base + 3 * 3600_000) };
  const weekly = { label: '週', usedPercent: 100, resetsAt: iso(base + 2 * 24 * 3600_000) };
  t.ok('Codex は 5 時間枠も週の枠も使い切っているなら、週の解除時刻を使う', codexResetOf([five, weekly], base)?.resetsAt === Date.parse(weekly.resetsAt) && codexResetOf([five, weekly], base).window === '週');
  t.ok('Codex は使い切った枠だけを見る（5 時間枠だけが 100% なら、使っていない週の枠は関係しない）',
    codexResetOf([five, { ...weekly, usedPercent: 40 }], base)?.resetsAt === Date.parse(five.resetsAt));
  t.ok('Codex はどれも 100% でなければ、一番早く解ける枠のまま', codexResetOf([{ ...five, usedPercent: 60 }, { ...weekly, usedPercent: 20 }], base)?.resetsAt === Date.parse(five.resetsAt));
  const sparkWeek = { label: 'Spark 週', usedPercent: 100, resetsAt: iso(base + 72 * 3600_000), limitId: 'spark', limitName: 'GPT-5-Codex-Spark' };
  t.ok('Codex は別のバケット（Spark の週枠）が 100% でも、主の枠を使う会話の解除時刻は主の枠のまま',
    codexResetOf([{ ...five, limitId: 'codex' }, sparkWeek], base, 'gpt-5-codex')?.resetsAt === Date.parse(five.resetsAt)
    && codexResetOf([{ ...five, limitId: 'codex' }, sparkWeek], base)?.resetsAt === Date.parse(five.resetsAt));
  t.ok('Codex はそのモデルに当たるバケットなら、そのバケットの解除時刻', codexResetOf([{ ...five, limitId: 'codex' }, sparkWeek], base, 'gpt-5-codex-spark')?.resetsAt === Date.parse(sparkWeek.resetsAt) - 0
    || codexResetOf([{ ...five, limitId: 'codex' }, sparkWeek], base, 'gpt-5-codex-spark')?.resetsAt === Date.parse(sparkWeek.resetsAt));
  t.ok('Codex は過ぎた枠・時刻のない枠を数えない', codexResetOf([{ ...weekly, resetsAt: iso(base - 1) }, { label: 'x', usedPercent: 100, resetsAt: null }], base) === null && codexResetOf(undefined, base) === null);
}
