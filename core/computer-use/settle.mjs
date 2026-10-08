// wait_until の待ち方（docs/computer-use.md「wait_until の待ち方」、ADR 0165）。
// 小さい灰色の画面を 100ms ごとに撮って前のコマと比べ、「変化してから静止」を待つ。問い（until）があれば、静止するたびに 1 回聞く。
// 画面が動き続けるときも、最後に聞いて（または呼んで）から askEveryMs 静止が来なければ 1 回聞く。
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
  /** 問いがあり、画面が動き続けるとき、最後の答えが返ってから（または呼んでから）これだけ静止が来なければ 1 回聞く */
  askEveryMs: 2000,
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
 * 静止まで待つ。戻りは { end: 'still' | 'due' | 'deadline', sawChange, stable, last, state }（last は最後に撮ったコマ）。
 * - still: 静止した。allowAlreadyStill なら、firstChangeMs の間に変化が無いとき最初から静止していたことにする（sawChange: false）
 * - due: 動いている（最後の変化から stillMs 経っていない）まま、askAt を過ぎた（定期の問い）
 * - deadline: 締め切り。stable は、締め切りの時点で stillMs 以上変わっていなかったか
 * base があれば、それを最初のコマとして比べる（聞いている間に変わった画面を見落とさない）。
 * quietSince は、この回でまだ変化が無いとき「いつから変わっていないか」（締め切りの stable にだけ使う）。
 * resume（前の戻りの state）を渡すと、同じ回を続ける（定期の問いを聞かずに飛ばしたとき）
 */
async function untilStill({ grab, base, deadline, allowAlreadyStill, quietSince, askAt = Infinity, resume, now, sleep, check, o }) {
  const start = resume?.start ?? now();
  let prev = resume?.prev ?? base ?? await grab();
  let lastChange = resume?.lastChange ?? null;
  let next = (resume ? now() : start) + o.intervalMs;
  const state = () => ({ start, prev, lastChange });
  for (;;) {
    const wait = next - now();
    if (wait > 0) await sleep(Math.min(wait, Math.max(0, deadline - now())));
    check();
    const t = now();
    if (t >= deadline) return { end: 'deadline', sawChange: lastChange !== null, stable: t - (lastChange ?? quietSince ?? start) >= o.stillMs, last: prev, state: state() };
    next = Math.max(next + o.intervalMs, t);
    const frame = await grab();
    check();
    const at = now();
    if (changedRatio(prev, frame, o.pixelDelta) >= o.changedRatio) lastChange = at;
    prev = frame;
    if (lastChange !== null && at - lastChange >= o.stillMs) return { end: 'still', sawChange: true, last: prev, state: state() };
    if (lastChange === null && allowAlreadyStill && at - start >= o.firstChangeMs) return { end: 'still', sawChange: false, last: prev, state: state() };
    if (lastChange !== null && at >= askAt) return { end: 'due', sawChange: true, last: prev, state: state() };
  }
}

/**
 * 待つ本体。
 * @param {object} p
 * @param {() => Promise<{ gray: Uint8Array, width: number, height: number }>} p.grab  比べる灰色のコマを撮る
 * @param {(() => Promise<{ ok: true, p: number } | { ok: false, code: string } | { skip: string }>) | null} p.ask
 *   1 回聞く（null なら聞かず、静止で返す）。skip は聞かない理由（前面が送らないアプリ。protected_app）。
 *   静止したときの skip は差分だけで返し（unverified）、定期の問いの skip は聞かずに待ち続ける
 * @param {number} p.timeoutMs
 * @param {() => number} [p.now]
 * @param {(ms: number) => Promise<void>} [p.sleep]
 * @param {() => void} [p.check]  止めた印を見る（止められていれば投げる）
 * @returns {Promise<{ status: 'success'|'timeout'|'unverified'|'error', screen: 'stable'|'changing', answer: 'yes'|'no'|'none',
 *   reason?: string, waitedMs: number, asks: number, p: number|null, sawChange: boolean }>}
 *   reason は unverified（skip の理由）と error（聞けなかった code）のときだけ
 */
export async function settle({ grab, ask = null, timeoutMs, now = Date.now, sleep = ms => new Promise(r => setTimeout(r, ms)), check = () => {}, options = {} }) {
  const o = { ...SETTLE, ...options };
  const start = now();
  const deadline = start + timeoutMs;
  let asks = 0, p = null, sawChange = false, allowAlreadyStill = true, base = null, quietSince = start, resume = null;
  // 定期の問いの起点。呼んだ時と、答えが返った時（聞かずに飛ばした時も）
  let askedAt = start;
  const answer = () => (p === null ? 'none' : p >= o.doneAt ? 'yes' : 'no');
  const out = (status, screen, extra = {}) => ({ status, screen, answer: answer(), waitedMs: Math.max(0, Math.round(now() - start)), asks, p, sawChange, ...extra });
  for (;;) {
    const s = await untilStill({ grab, base, deadline, allowAlreadyStill, quietSince, askAt: ask ? askedAt + o.askEveryMs : Infinity, resume, now, sleep, check, o });
    resume = null;
    sawChange ||= s.sawChange;
    if (s.end === 'deadline') return out('timeout', s.stable ? 'stable' : 'changing');
    const screen = s.end === 'still' ? 'stable' : 'changing';
    if (!ask) return out('success', screen);
    const r = await ask();
    check();
    askedAt = now();
    if (r.skip) {
      if (screen === 'stable') return out('unverified', screen, { reason: r.skip });
      // 動いている間は聞かずに同じ回を続ける（変化の数え方を崩さない）。次の定期の問いでまた前面を見る
      resume = s.state;
      continue;
    }
    asks++;
    if (!r.ok) return out('error', screen, { reason: r.code });
    p = r.p;
    if (p >= o.doneAt) return out('success', screen);
    // いいえ: 次の変化と静止を待って聞き直す（今の静止をもう一度数えない）。
    // 比べる元は聞く前のコマ。聞いている間（往復の数百 ms）に変わって止まった画面も、次の変化として数える
    allowAlreadyStill = false;
    base = s.last;
    quietSince = screen === 'stable' ? -Infinity : (s.state.lastChange ?? askedAt);
    if (now() >= deadline) return out('timeout', screen);
  }
}
