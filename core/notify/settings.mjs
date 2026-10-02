// この PC の通知の設定（設定 › 通知 › この PC。ADR 0086）。<data>/notify.json に { pc: { done, reply, failed } }。
// スマホの設定は端末ごと（端末が持ち、ホストの端末一覧 devices.json にも写す）なので、ここには置かない。
import fs from 'node:fs/promises';
import path from 'node:path';
import { writeAtomic } from '../atomic-file.mjs';
import { DEFAULT_PC_SETTINGS, normalizePcSettings } from './policy.mjs';

export function createNotifySettings({ dataDir }) {
  const file = path.join(dataDir, 'notify.json');
  let cache = null;
  let queue = Promise.resolve();
  const load = async () => {
    if (cache) return cache;
    try {
      const raw = JSON.parse(await fs.readFile(file, 'utf8'));
      cache = { pc: normalizePcSettings(raw?.pc) };
    } catch { cache = { pc: { ...DEFAULT_PC_SETTINGS } }; }
    return cache;
  };
  return {
    async pc() { return { ...(await load()).pc }; },
    /** 書いた項目だけ置き換える。 */
    set(patch) {
      const run = queue.catch(() => {}).then(async () => {
        const cur = await load();
        const next = { pc: normalizePcSettings(patch, cur.pc) };
        await writeAtomic(file, JSON.stringify(next, null, 2) + '\n');
        cache = next;
        return { ...next.pc };
      });
      queue = run;
      return run;
    },
  };
}
