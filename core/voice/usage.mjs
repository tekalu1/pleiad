// 通話の使用量の台帳（費用の安全弁。docs/voice-call.md「費用の安全弁」）。
// 日ごと（この PC の日付）の通話の長さ・聞き取りの秒数・読み上げの字数。直近 31 日だけを持つ（それより古い日は書くときに捨てる）ので、大きさは固定の小ささ。
// 書き込みは数秒にまとめ、閉じるときに書き切る。
import fs from 'node:fs/promises';
import { writeAtomic } from '../atomic-file.mjs';

export const KEEP_DAYS = 31;
const WRITE_DELAY_MS = 5000;

const dayKey = (at) => {
  const d = new Date(at);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const blank = () => ({ callSeconds: 0, sttSeconds: 0, ttsChars: 0 });

export function createVoiceUsage({ file, now = Date.now, delayMs = WRITE_DELAY_MS }) {
  let days = null;
  let timer = null;
  let writing = Promise.resolve();

  async function load() {
    if (days) return days;
    try {
      const raw = JSON.parse(await fs.readFile(file, 'utf8'));
      days = raw?.days && typeof raw.days === 'object' && !Array.isArray(raw.days) ? raw.days : {};
    } catch { days = {}; }
    return days;
  }

  function prune() {
    const keys = Object.keys(days).sort();
    for (const k of keys.slice(0, Math.max(0, keys.length - KEEP_DAYS))) delete days[k];
  }

  async function flush() {
    clearTimeout(timer);
    timer = null;
    if (!days) return;
    prune();
    const text = JSON.stringify({ version: 1, days }) + '\n';
    writing = writing.catch(() => {}).then(() => writeAtomic(file, text));
    await writing;
  }

  const schedule = () => { if (!timer) { timer = setTimeout(() => { flush().catch(() => {}); }, delayMs); timer.unref?.(); } };

  return {
    async today() { return { ...blank(), ...((await load())[dayKey(now())] ?? {}) }; },
    /** 足す。値は加算 */
    async add(delta) {
      await load();
      const key = dayKey(now());
      const row = days[key] = { ...blank(), ...(days[key] ?? {}) };
      for (const k of ['callSeconds', 'sttSeconds', 'ttsChars']) if (Number.isFinite(delta?.[k]) && delta[k] > 0) row[k] += delta[k];
      schedule();
    },
    flush,
  };
}
