// wait_until の待ち方（docs/computer-use.md「wait_until の待ち方」、ADR 0165）。
// 小さい灰色の画面を 100ms ごとに撮って前のコマと比べ、「変化してから静止」を待つ。問い（until）があれば、静止するたびに 1 回聞く。
// 撮る・聞く・時計・眠るは呼び出し側が渡す（テストは偽物と仮想の時計で回す）。

export const SETTLE = Object.freeze({
  /** 画素の差（0〜255）がこれを超えたら、その画素は変わった */
  pixelDelta: 6,
  /** 変わった画素がこの割合以上なら、そのコマで画面が変わった */
  changedRatio: 0.02,
  /** 最後の変化からこれだけ変わらなければ静止 */
  stillMs: 400,
  /** 撮る間隔（撮り始めから次の撮り始めまで。撮影が遅ければ間を空けずに次を撮る） */
  intervalMs: 100,
  /** 呼んでからこれだけ変化が無ければ、最初から静止していたことにする（問いの答えが いいえ の後は使わない） */
  firstChangeMs: 1000,
  /** 比べる画面の長辺（画素） */
  frameEdge: 320,
  /** 決定モデルの はい の確率がこれ以上なら終わった */
  doneAt: 0.5,
});

/** 灰色のコマ 2 枚の、変わった画素の割合（0〜1）。大きさが違えば全部変わったことにする */
export function changedRatio(a, b, delta = SETTLE.pixelDelta) {
  if (!a || !b || a.width !== b.width || a.height !== b.height || a.gray.length !== b.gray.length || !a.gray.length) return 1;
  const x = a.gray, y = b.gray;
  let n = 0;
  for (let i = 0; i < x.length; i++) { const d = x[i] - y[i]; if (d > delta || d < -delta) n++; }
  return n / x.length;
}

/**
 * 静止まで待つ。戻りは { settled: true, sawChange } か、締め切りを過ぎたら { settled: false, sawChange }。
 * allowAlreadyStill なら、firstChangeMs の間に変化が無いとき最初から静止していたことにする（sawChange: false）
 */
async function untilStill({ grab, deadline, allowAlreadyStill, now, sleep, check, o }) {
  const start = now();
  let prev = await grab();
  let lastChange = null;
  let next = start + o.intervalMs;
  for (;;) {
    const wait = next - now();
    if (wait > 0) await sleep(Math.min(wait, Math.max(0, deadline - now())));
    check();
    const t = now();
    if (t >= deadline) return { settled: false, sawChange: lastChange !== null };
    next = Math.max(next + o.intervalMs, t);
    const frame = await grab();
    check();
    const at = now();
    if (changedRatio(prev, frame, o.pixelDelta) >= o.changedRatio) lastChange = at;
    prev = frame;
    if (lastChange !== null && at - lastChange >= o.stillMs) return { settled: true, sawChange: true };
    if (lastChange === null && allowAlreadyStill && at - start >= o.firstChangeMs) return { settled: true, sawChange: false };
  }
}

/**
 * 待つ本体。
 * @param {object} p
 * @param {() => Promise<{ gray: Uint8Array, width: number, height: number }>} p.grab  比べる灰色のコマを撮る
 * @param {(() => Promise<{ ok: true, p: number } | { ok: false, code: string } | { skip: string }>) | null} p.ask
 *   静止したときに聞く（null なら聞かず、静止で返す）。skip は聞かずに差分だけで返す理由（前面が送らないアプリ）
 * @param {number} p.timeoutMs
 * @param {() => number} [p.now]
 * @param {(ms: number) => Promise<void>} [p.sleep]
 * @param {() => void} [p.check]  止めた印を見る（止められていれば投げる）
 * @returns {Promise<{ done: boolean, end: 'still'|'yes'|'timeout'|'ask_failed'|'skipped', waitedMs: number, asks: number, p: number|null, sawChange: boolean, code?: string }>}
 */
export async function settle({ grab, ask = null, timeoutMs, now = Date.now, sleep = ms => new Promise(r => setTimeout(r, ms)), check = () => {}, options = {} }) {
  const o = { ...SETTLE, ...options };
  const start = now();
  const deadline = start + timeoutMs;
  let asks = 0, p = null, sawChange = false, allowAlreadyStill = true;
  const out = (done, end, extra = {}) => ({ done, end, waitedMs: Math.max(0, Math.round(now() - start)), asks, p, sawChange, ...extra });
  for (;;) {
    const s = await untilStill({ grab, deadline, allowAlreadyStill, now, sleep, check, o });
    sawChange ||= s.sawChange;
    if (!s.settled) return out(false, 'timeout');
    if (!ask) return out(true, 'still');
    const r = await ask();
    check();
    if (r.skip) return out(true, 'skipped', { code: r.skip });
    asks++;
    if (!r.ok) return out(false, 'ask_failed', { code: r.code });
    p = r.p;
    if (p >= o.doneAt) return out(true, 'yes');
    // いいえ: 次の変化と静止を待って聞き直す（今の静止をもう一度数えない）
    allowAlreadyStill = false;
    if (now() >= deadline) return out(false, 'timeout');
  }
}
