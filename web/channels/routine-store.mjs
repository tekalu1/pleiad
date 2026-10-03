// ルーティンの一覧の写し。脇（sidebar.mjs）・チャンネルの見出しの［ルーティン n］（feed.mjs）・bot のページ・編集のシートが同じものを読む。
// host ごとに 1 つ（getRoutineStore(host)）。読むのは routines.list、更新は出来事 routinesChanged（routine-sheet.mjs の onEvent が当てる）。
// routines.* の操作が無い版（R1 より前）や接続の前は、読めなくても黙って空のまま（次の出来事で読み直す）。
import { listOf, applyChange } from './routine-model.mjs';

const stores = new WeakMap();
const RELOAD_WAIT_MS = 250;      // 出来事が続けて来たら 1 回にまとめて読み直す（nextAt は読み直しで新しくなる）
const TICK_MS = 60_000;          // 「今日 23:00」「明日 9:00」の言い回しが日をまたいで古くならないように
// 読めなかったときの待ち（ms）。操作が無い版・まだつながっていない間に、出来事のたびに呼び続けないため。使い切ったら最後の長さの間は出来事でも読み直さない
const BACKOFF_MS = Object.freeze([1000, 2000, 4000, 8000, 16000, 30000]);

export function getRoutineStore(host) {
  let store = stores.get(host);
  if (!store) { store = createRoutineStore(host); stores.set(host, store); }
  return store;
}

/** @param {{ now?: () => number, backoff?: number[] }} [opts]  テストが時計と待ちを差し替える */
export function createRoutineStore(host, { now = Date.now, backoff = BACKOFF_MS } = {}) {
  let rows = [];
  let loaded = false, stale = true, loading = null, timer = 0, ticker = 0;
  let fails = 0, lastTry = 0;
  const listeners = new Set();
  const emit = (reason) => { for (const fn of [...listeners]) fn(rows, reason); };

  async function refresh() {
    clearTimeout(timer);
    if (loading) { stale = true; return loading; }
    stale = false;
    lastTry = now();
    loading = (async () => {
      try {
        rows = listOf(await host.invoke('routines.list', {}));
        loaded = true;
        fails = 0;
        emit('load');
      } catch {
        // まだつながっていない・操作が無い。少し待って読み直す（回数に上限あり）。使い切ったら、待ちが明けてからの出来事で読み直す
        stale = true;
        if (fails < backoff.length) timer = setTimeout(refresh, backoff[fails]);
        fails += 1;
        if (!loaded) { loaded = true; emit('load'); }
      } finally {
        loading = null;
      }
    })();
    return loading;
  }
  const refreshSoon = () => { stale = true; clearTimeout(timer); timer = setTimeout(refresh, RELOAD_WAIT_MS); };

  const store = {
    /** 今の一覧（読み取り専用の写し） */
    list: () => rows,
    get: (id) => rows.find((r) => r.id === id) ?? null,
    forChannel: (channelId) => rows.filter((r) => r.channelId === channelId),
    forBot: (botId) => rows.filter((r) => r.botId === botId),
    get loaded() { return loaded; },
    refresh,
    /** 一覧が変わったら呼ぶ。返り値で外す。最初の購読で一覧を読みに行き、1 分ごとの tick も流す */
    subscribe(fn) {
      listeners.add(fn);
      if (!loaded && !loading) refresh();
      if (!ticker) ticker = setInterval(() => emit('tick'), TICK_MS);
      return () => {
        listeners.delete(fn);
        if (!listeners.size && ticker) { clearInterval(ticker); ticker = 0; }
      };
    },
    /** 編集のシートが保存・削除した結果をすぐ反映する（出来事より先に） */
    put(routine) { rows = applyChange(rows, { routine }); emit('put'); },
    drop(id) { rows = applyChange(rows, { removed: id }); emit('drop'); },
    /** WS の出来事。routinesChanged は当てて読み直し、ほかの出来事は読めていなければ読み直す */
    onEvent(ev) {
      if (ev?.type === 'routinesChanged') {
        rows = applyChange(rows, ev);
        emit('event');
        refreshSoon();
      } else if (stale && !loading && listeners.size && now() - lastTry >= (backoff[Math.min(fails, backoff.length) - 1] ?? 0)) refresh();
    },
  };
  return store;
}
