// 履歴の発言の実寸を確定する（style.css の `#thread > .mw:not(.activity):not(.height-ready)`）。
//
// 画面外の発言は content-visibility:auto と仮の高さ（160px）で並べ、開くときのレイアウトを省く。
// ところが仮の高さと実寸の差が大きいので、スクロールで行が見え始めるたびに高さが変わり、レイアウトが繰り返される。
// そこで、見えている所の近くだけ先に実寸にする（.height-ready を付けて content-visibility を外す）。
//   - 開いた直後: 末尾を見ているなら、末尾の TAIL_SCREENS 画面分だけをその場で確定する
//   - スクロール・ジャンプで見える範囲が変わったコマ: 描画の前に、
//       見えている範囲の上下 URGENT_REACH 画面以内の行をすべて、NEAR_REACH 画面以内の行を 1 コマに BATCH 行まで、確定する。
//     ブラウザーは見えている範囲の上下、窓の高さの 1.3〜1.5 倍ほど（仮の高さで測る。Chromium で実測）の content-visibility:auto の行を自分で実寸に描き直し、
//     そのときの高さの変化は補正できないので、先に済ませる。確定で行の高さが縮むと範囲に入る行が増えるので、なくなるまで繰り返す
//   - 手が空いたとき: FAR_REACH 画面以内の行を、中央に近い順に IDLE_BATCH 行ずつ確定する。速いスクロールに備える
// 確定する行の数は会話の長さによらず、いま見ている所の周りの分だけ。それより遠い行は仮の高さのまま残る。
// 確定で見ている行より上の高さが変わったら、基準の行の位置が動かないよう #log の scrollTop を補正する。
// 末尾にいるなら、補正ではなく末尾に合わせ直す。
// 今の形は docs/design-system.md（スクロール）と docs/design.md（長い履歴の実寸の確定）
export const READY = "height-ready";
export const TAIL_SCREENS = 2;      // 開いた直後に確定する末尾の量（#log の高さの倍数）
export const TAIL_MAX_ROWS = 24;    // その上限（1 行が画面より高くても、その場で確定する行数は頭打ちにする）
export const BATCH = 6;             // 近くの行を、1 回の確定（1 回の強制レイアウト）で扱う行数
export const IDLE_BATCH = 4;        // 手が空いたときに扱う行数（1 回の確定ごとに、まだ実寸でない行の数に比例した作業が走るので、少しまとめる）
export const URGENT_REACH = 2;      // 描画の前にすべて確定する範囲（見えている範囲の上下、#log の高さの倍数。ブラウザー自身の描き直しの範囲（窓の高さの 1.3〜1.5 倍）より広く）
export const NEAR_REACH = 3;        // 1 コマに BATCH 行ずつ確定する範囲
export const FAR_REACH = 30;        // 手が空いたときに確定する範囲
const UNSETTLED = ":scope > .mw:not(.activity):not(.height-ready)";

/**
 * log: スクロールする #log、thread: 会話の列（#thread）、atBottom: 末尾を見ているか、
 * anchorRow(rows): 見ている位置の基準の行（#log の上端近くにある行。rows は上から並んだ全部の発言の行）。
 * 残りは環境（requestAnimationFrame・手が空いたときの呼び出し idle）。テストで差し替える。
 * idle(cb): 手が空いたときに cb を 1 回呼ぶ。続けて呼ばれても間を空けて、主スレッドを占め続けない
 */
export function createHeightSettler({
  log, thread, atBottom, anchorRow,
  requestAnimationFrame: raf = cb => globalThis.requestAnimationFrame(cb),
  idle = idleWhenFree(),
  tailScreens = TAIL_SCREENS, tailMaxRows = TAIL_MAX_ROWS, batch = BATCH, idleBatch = IDLE_BATCH,
  urgentReach = URGENT_REACH, nearReach = NEAR_REACH, farReach = FAR_REACH,
}) {
  let version = 0, active = false, frameQueued = false, idleQueued = false;
  // scrollTop は画面の 1px に丸められる。補正のたびに丸めた分（端数）が積もって位置がずれないよう、丸めきれなかった分は次の補正に足す
  let carry = 0;

  const isSettled = row => row.classList.contains(READY);

  /** 全部の発言の行（上から順）。増えたときと外れたときだけ取り直す */
  let allCache = null, allCount = -1;
  function allRows() {
    const count = thread.childElementCount;
    if (!allCache || count !== allCount || !allCache.at(-1)?.isConnected || !allCache[0]?.isConnected) {
      allCache = [...thread.querySelectorAll(":scope > .mw")];
      allCount = count;
    }
    return allCache;
  }

  /** rows を実寸にする。見ている位置は、末尾なら末尾、読み返しなら基準の行の位置を保つ */
  function settle(rows) {
    rows = rows.filter(row => row.isConnected && !isSettled(row));
    if (!rows.length) return;
    const pinEnd = atBottom();
    const anchor = pinEnd ? null : anchorRow(allRows());
    const anchorTop = anchor?.getBoundingClientRect().top;
    for (const row of rows) row.classList.add(READY);
    void rows.at(-1).offsetHeight;
    if (pinEnd) { log.scrollTop = log.scrollHeight; carry = 0; }
    else if (anchor?.isConnected) {
      const want = anchor.getBoundingClientRect().top - anchorTop + carry;
      const from = log.scrollTop;
      if (want) { log.scrollTop = from + want; carry = Math.max(-1, Math.min(1, want - (log.scrollTop - from))); }
    }
  }

  /** 開いた直後: 末尾の TAIL_SCREENS 画面分（上限 TAIL_MAX_ROWS 行）を確定する。末尾を見ていないときは何もしない（あとの確定に任せる） */
  function settleTail(rows) {
    if (!atBottom()) return;
    const need = tailScreens * log.clientHeight;
    let covered = 0, end = rows.length;
    while (end > 0 && covered < need && rows.length - end < tailMaxRows) {
      const start = Math.max(0, end - batch);
      const part = rows.slice(start, end);
      end = start;
      settle(part);
      for (const row of part) covered += row.offsetHeight;
    }
  }

  /**
   * 見えている範囲の上下 reach 画面以内の、まだ確定していない行を、中央に近い順に返す。
   * 行は上から順に並んでいるので、範囲の端は二分探索で見つけ、範囲の中だけ数える（レイアウトを読むのは log2(件数) + 範囲の行数回）
   */
  function unsettledWithin(reach) {
    const rows = allRows();
    if (!rows.length) return [];
    const box = log.getBoundingClientRect();
    const from = box.top - reach * box.height, to = box.bottom + reach * box.height, center = box.top + box.height / 2;
    let a = 0, b = rows.length;
    while (a < b) { const mid = (a + b) >> 1; if (rows[mid].getBoundingClientRect().bottom > from) b = mid; else a = mid + 1; }
    const found = [];
    for (let i = a; i < rows.length; i++) {
      const row = rows[i], r = row.getBoundingClientRect();
      if (r.top >= to) break;
      if (!isSettled(row) && !row.classList.contains("activity") && row.isConnected) found.push([row, Math.abs((r.top + r.bottom) / 2 - center)]);
    }
    return found.sort((x, y) => x[1] - y[1]).map(x => x[0]);
  }

  /**
   * スクロールしたコマの描画の前: 見える範囲の周りを確定する。
   * 上下 urgentReach 画面以内は全部、それより外の nearReach 画面以内は batch 行まで（残りは次のコマ）。
   * 確定は 1 回の強制レイアウトで済ませる（レイアウトを読むたびに、まだ実寸でない行の数に比例した作業が走る）。
   * 確定で行が縮むと範囲に入る行が増えるので、範囲の中が空になるまで繰り返す（2 回目からは範囲の中だけ）
   */
  function frameWork() {
    frameQueued = false;
    let extra = batch;
    for (let pass = 0; pass < 4; pass++) {
      const near = unsettledWithin(nearReach);
      const box = log.getBoundingClientRect();
      const reach = urgentReach * box.height;
      const urgent = [], rest = [];
      for (const row of near) {
        const r = row.getBoundingClientRect();
        (r.bottom > box.top - reach && r.top < box.bottom + reach ? urgent : rest).push(row);
      }
      const list = [...urgent, ...rest.slice(0, extra)];
      if (!list.length) break;
      extra = 0;
      settle(list);
    }
    if (unsettledWithin(nearReach).length) scheduleFrame();
    scheduleIdle();
  }

  function scheduleFrame() {
    if (!active || frameQueued) return;
    frameQueued = true;
    const at = version;
    raf(() => { if (at === version) frameWork(); else frameQueued = false; });
  }

  /** 手が空いたとき: 少し遠くの行を近い順に idleBatch 行ずつ確定する。近くの行が残っている間は待つ */
  function scheduleIdle() {
    if (!active || idleQueued) return;
    idleQueued = true;
    const at = version;
    idle(() => {
      idleQueued = false;
      if (at !== version) return;
      if (frameQueued) { scheduleIdle(); return; }
      const far = unsettledWithin(farReach);
      if (!far.length) return;
      settle(far.slice(0, idleBatch));
      if (far.length > idleBatch) scheduleIdle();
    });
  }

  log.addEventListener?.("scroll", scheduleFrame, { passive: true });

  return {
    /** 履歴を描き終えたとき。末尾の近くを確定し、あとは近づいた分から確定する */
    prepare() {
      cancel();
      carry = 0;
      active = true;
      allCache = null;
      const rows = [...thread.querySelectorAll(UNSETTLED)];
      if (!rows.length) return;
      settleTail(rows);
      scheduleFrame();
    },
    /** 会話を切り替える・描き直すとき */
    cancel,
  };

  function cancel() {
    version++;
    active = false;
    frameQueued = idleQueued = false;
  }
}

/**
 * 手が空いたときに呼ぶ（requestIdleCallback。無い環境では少し待って呼ぶ）。
 * 前の 1 回にかかった時間の 2 倍は間を空け、続けて呼ばれても主スレッドの 3 分の 1 までしか使わない
 */
function idleWhenFree() {
  let took = 0;
  return cb => {
    const run = () => { const t0 = performance.now(); try { cb(); } finally { took = performance.now() - t0; } };
    setTimeout(() => {
      if (globalThis.requestIdleCallback) globalThis.requestIdleCallback(run, { timeout: 1000 });
      else run();
    }, Math.max(30, took * 2));
  };
}
