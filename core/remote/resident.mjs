// ホストとして常駐する設定（docs/remote.md §6.3）。デスクトップ版のホストだけが使う。
//
//   <data>/remote/resident.json  { keepRunning, sleep }
//     keepRunning  リモートが有効な間、窓を閉じてもホストを続けてトレイに残す（既定 true）
//     sleep        'working'（作業中だけ防ぐ。既定）| 'always'（リモートが有効な間は防ぐ）| 'off'（防がない）
//
// 設定はサーバーに置く（リモートの窓からも見える・触れる）。実際のトレイとスリープの抑止は Electron の main が持つので、
// サーバーは状態が変わるたびに residentSignal を parentPort で送る（desktop/resident.cjs が受ける）。
// npm start のホストは窓が無いので、そのまま常駐と同じ（この設定は使わない）。
import path from 'node:path';
import { readJson, writeJson } from './devices.mjs';

export const SLEEP_MODES = Object.freeze(['working', 'always', 'off']);
export const DEFAULT_RESIDENT = Object.freeze({ keepRunning: true, sleep: 'working' });

/** 読んだ値を正しい形に丸める。知らない値は既定へ */
export function normalizeResident(raw) {
  return {
    keepRunning: typeof raw?.keepRunning === 'boolean' ? raw.keepRunning : DEFAULT_RESIDENT.keepRunning,
    sleep: SLEEP_MODES.includes(raw?.sleep) ? raw.sleep : DEFAULT_RESIDENT.sleep,
  };
}

/** 置き場。値はメモリにも持ち、get() は読み込み前でも既定を返す（状態の組み立てを待たせない） */
export function createResidentPrefs({ dataDir }) {
  const file = path.join(dataDir, 'remote', 'resident.json');
  let current = { ...DEFAULT_RESIDENT };
  let chain = Promise.resolve();
  const loaded = readJson(file, {}).then(raw => { current = normalizeResident(raw); }, () => {});
  return {
    file,
    loaded,
    get: () => ({ ...current }),
    /** { keepRunning?, sleep? }。形の違う値は投げる */
    set(patch = {}) {
      if (patch.keepRunning !== undefined && typeof patch.keepRunning !== 'boolean') throw new TypeError('keepRunning must be a boolean');
      if (patch.sleep !== undefined && !SLEEP_MODES.includes(patch.sleep)) throw new TypeError(`sleep must be one of ${SLEEP_MODES.join(', ')}`);
      const run = chain.catch(() => {}).then(async () => {
        await loaded;
        const next = normalizeResident({ ...current, ...patch });
        await writeJson(file, next);
        current = next;
        return { ...current };
      });
      chain = run;
      return run;
    },
  };
}

/**
 * main（desktop/resident.cjs）へ送る常駐の状態。status は RemoteStatus、work は runningWork() の結果。
 * working = ターンが走っているか承認待ちがある（サブエージェント・委譲の作業も含む。runningWork の count）
 */
export function residentSignal({ status, prefs, work, locale }) {
  const p = normalizeResident(prefs);
  const turns = work?.turns?.length ?? 0;
  const waiting = (work?.permissions ?? []).filter(x => !x.relay).length;
  return {
    remote: status?.enabled === true,
    keepRunning: p.keepRunning,
    sleep: p.sleep,
    working: (work?.count ?? turns + waiting) > 0,
    running: turns,
    waiting,
    devices: (status?.devices ?? []).filter(d => d.connected).length,
    relay: status?.connection?.state ?? 'disabled',
    locale: locale ?? null,
  };
}
