// 長い履歴の実寸の確定（web/history-heights.mjs）。
// 仮の高さ（style.css の content-visibility・160px）の発言のうち、確定するのは見えている所の近くだけで、
// その数は会話の長さによらない。確定で高さが変わっても、見ている位置は動かない（末尾なら末尾に、読み返しなら基準の行の位置に）。
// 行の高さ・#log のスクロールだけを持つ作りものの画面の上で、本物のモジュールと
// client.mjs の historyAnchor を走らせる。本物の Chromium での確認は tests/browser/history-heights.cjs
import fs from "node:fs/promises";
import vm from "node:vm";
import { createHeightSettler, TAIL_MAX_ROWS } from "../../web/history-heights.mjs";

export const name = "history-heights";
export const title = "実寸の確定は見えている所の近くだけ（数は会話の長さによらない）。確定しても見ている位置は動かない";

const PLACEHOLDER = 160, LOG_TOP = 50, VIEW = 900;
const ACTUAL = [90, 420, 1600, 60, 2400, 300, 130, 760];

/**
 * 行の高さと #log のスクロールだけを持つ画面。行は上から積み、まだ確定していない行は仮の高さで並ぶ。
 * ただし画面に入った行は、ブラウザーが実寸で描き直す（shown。content-visibility:auto）。
 * レイアウトを読む操作（rect・offsetHeight・scrollHeight）が、変更の後で最初に起きたときを「強制レイアウト」として数える
 */
export function screen(count, logWidth = 988, { fractional = false, heights = ACTUAL } = {}) {
  const rows = Array.from({ length: count }, (_, i) => {
    const classes = new Set(["mw"]);
    const row = {
      i, actual: heights[i % heights.length] + (fractional ? 0.3 : 0), isConnected: true, shown: false,
      classList: { add: c => { classes.add(c); touch(); }, contains: c => classes.has(c) },
      get height() { return classes.has("height-ready") || row.shown ? row.actual : PLACEHOLDER; },
      get offsetHeight() { read(); return row.height; },
      getBoundingClientRect() {
        read();
        const top = LOG_TOP + offsets()[i] - scrollTop;
        return { top, bottom: top + row.height, height: row.height };
      },
    };
    return row;
  });
  let scrollTop = 0, dirty = false, cache = null, forced = 0, scrolled = false;
  const scrollListeners = [];
  const touch = () => { dirty = true; cache = null; };
  const read = () => { if (dirty) { forced++; dirty = false; } };
  const offsets = () => {
    if (!cache) { cache = []; let y = 0; for (const r of rows) { cache.push(y); y += r.height; } cache.total = y; }
    return cache;
  };
  const log = {
    clientHeight: VIEW,
    get scrollHeight() { read(); offsets(); return cache.total; },
    get scrollTop() { return scrollTop; },
    // 画面の 1px に丸める（本物の #log の scrollTop と同じく、端数の位置には置けない）
    set scrollTop(v) {
      const next = Math.max(0, Math.min(Math.round(v), this.scrollHeight - this.clientHeight));
      if (next !== scrollTop) scrolled = true;
      scrollTop = next;
    },
    addEventListener(type, fn) { if (type === "scroll") scrollListeners.push(fn); },
    getBoundingClientRect: () => { read(); return { top: LOG_TOP, left: 292, width: logWidth, height: VIEW, right: 292 + logWidth, bottom: LOG_TOP + VIEW }; },
  };
  const thread = {
    get childElementCount() { return rows.filter(r => r.isConnected).length + 1; },     // + 筋（.spine）
    querySelectorAll(sel) {
      if (sel === ":scope > .mw") return rows.filter(r => r.isConnected);
      if (sel === ":scope > .mw:not(.activity):not(.height-ready)") return rows.filter(r => r.isConnected && !r.classList.contains("height-ready"));
      throw Error(`想定していないセレクター: ${sel}`);
    },
  };

  // 1 コマ: スクロールの通知 → rAF の仕事 → 描画（画面に入った行はブラウザーが実寸で描く）→ 手が空いたときの仕事
  const queue = [], idleQueue = [];
  const nativeShown = new Set();
  const frame = ({ idle = true } = {}) => {
    // 1 コマの順序（HTML の描画の更新）: スクロールの通知 → rAF → 描画。scrollTop を書いた分のスクロールの通知は次のコマで出る
    if (scrolled) { scrolled = false; for (const fn of scrollListeners) fn(); }
    const work = queue.splice(0);
    for (const cb of work) cb();
    for (let changed = true; changed;) {
      changed = false;
      for (const r of rows) {
        const b = r.getBoundingClientRect();
        // ブラウザーが実寸で描き直すのは、見えている範囲とその上下 1.5 倍（content-visibility:auto の範囲。Chromium で実測: 窓の高さの 1.3〜1.5 倍）
        if (!r.shown && b.bottom > LOG_TOP - VIEW * 1.5 && b.top < LOG_TOP + VIEW * 2.5) {
          r.shown = true; changed = true; touch();
          if (!r.classList.contains("height-ready")) nativeShown.add(r);
        }
      }
    }
    // 手が空いたときの仕事は、1 コマに 1 回ずつ
    const spare = idle ? idleQueue.splice(0) : [];
    for (const cb of spare) cb();
    return work.length + spare.length > 0;
  };
  /** 落ち着くまでコマを進める。仕事が次のコマの仕事を作るので、仕事が無くなるまで */
  const settleFrames = (max = 4000) => {
    for (let n = 0; n < max; n++) {
      const before = rows.filter(r => r.classList.contains("height-ready")).length;
      const worked = frame();
      const after = rows.filter(r => r.classList.contains("height-ready")).length;
      if (!worked && !queue.length && !idleQueue.length && before === after) return n;
    }
    throw Error("落ち着かない");
  };
  return {
    rows, log, thread, queue, idleQueue, frame, settleFrames, nativeShown,
    get forced() { return forced; }, resetCounters() { forced = 0; nativeShown.clear(); },
    ready: () => rows.filter(r => r.classList.contains("height-ready")).length,
    gap: () => log.scrollHeight - log.scrollTop - log.clientHeight,
  };
}

export default async function (t) {
  const source = (await fs.readFile(new URL("../../web/client.mjs", import.meta.url), "utf8")).replaceAll("\r\n", "\n");
  const start = source.indexOf("function historyAnchor(");
  const anchorSource = start < 0 ? "" : source.slice(start, source.indexOf("\n}", start) + 2);
  const atBottomSource = source.match(/^const atBottom = .*$/m)?.[0];
  t.ok("client.mjs から historyAnchor と atBottom を切り出せる", !!anchorSource && !!atBottomSource);

  /** 画面にモジュールを付ける。historyAnchor と atBottom は client.mjs の本物 */
  const attach = (s, options = {}) => {
    const context = vm.createContext({ log: s.log, thread: s.thread });
    vm.runInContext(`${atBottomSource}\n${anchorSource}\nthis.atBottom = atBottom; this.historyAnchor = historyAnchor;`, context);
    return createHeightSettler({
      log: s.log, thread: s.thread, atBottom: context.atBottom, anchorRow: context.historyAnchor,
      requestAnimationFrame: cb => s.queue.push(cb), idle: cb => s.idleQueue.push(cb), ...options,
    });
  };
  const openAtEnd = (s, settler) => { s.log.scrollTop = s.log.scrollHeight; s.resetCounters(); settler.prepare(); };
  const atLine = s => s.rows.find(r => r.getBoundingClientRect().bottom > LOG_TOP + 80);

  // ---- 開いた直後と、その後の確定の量は、会話の長さによらない
  const opened = {};
  for (const count of [50, 400, 2000]) {
    const s = screen(count), settler = attach(s);
    openAtEnd(s, settler);
    const now = s.ready(), forcedNow = s.forced;
    s.settleFrames();
    opened[count] = { s, now, forcedNow, ready: s.ready(), forced: s.forced, gap: s.gap() };
  }
  t.ok(`開いた直後にその場で確定するのは末尾の近くだけ（${TAIL_MAX_ROWS} 行以内）: 発言 400・2000 とも`,
    opened[400].now <= TAIL_MAX_ROWS && opened[2000].now === opened[400].now, `${opened[400].now} / ${opened[2000].now} 行`);
  t.ok("開いた直後の強制レイアウトは、発言 400 でも 2000 でも同じ回数（発言の数に比例しない）",
    opened[2000].forcedNow === opened[400].forcedNow && opened[2000].forcedNow <= 6, `${opened[400].forcedNow} / ${opened[2000].forcedNow} 回`);
  t.ok("落ち着くまでに確定した行数は、発言 400 でも 2000 でも同じ（近くだけ）",
    opened[2000].ready === opened[400].ready && opened[2000].ready < 120, `${opened[400].ready} / ${opened[2000].ready} 行`);
  t.ok("落ち着くまでの強制レイアウトも、発言 400 と 2000 で同じ回数", opened[2000].forced === opened[400].forced && opened[2000].forced < 100, `${opened[400].forced} / ${opened[2000].forced} 回`);
  t.ok("発言 50 の会話も、確定する行数は同じ程度（会話が短くても、遠くの手前で止まる）", Math.abs(opened[50].ready - opened[2000].ready) <= 6, `${opened[50].ready} / ${opened[2000].ready} 行`);
  t.ok("遠くの行（先頭）は仮の高さのまま", !opened[2000].s.rows[0].classList.contains("height-ready") && !opened[400].s.rows[0].classList.contains("height-ready"));
  t.ok("開いて落ち着いた後も末尾にいる", opened[2000].gap < 40 && opened[400].gap < 40 && opened[50].gap < 40,
    `gap ${opened[50].gap} / ${opened[400].gap} / ${opened[2000].gap}`);
  t.ok("開いた直後の末尾の画面（2 画面分）は実寸になっている: 末尾で開いても、ブラウザーが後から描き直して高さを変える行が出ない",
    opened[2000].s.nativeShown.size === 0, `${opened[2000].s.nativeShown.size} 行が仮の高さのまま描かれた`);

  // ---- 近づいた行だけが確定する
  {
    const s = screen(2000), settler = attach(s);
    openAtEnd(s, settler);
    s.settleFrames();
    const before = s.ready();
    const farIndex = 600;
    t.ok("上の遠い行は確定していない", !s.rows[farIndex].classList.contains("height-ready"));
    // 遠い行の近くまで一気に移る（発言へ飛ぶ・検索・スクロールバーのつまみの操作）
    s.log.scrollTop = 0;
    s.log.scrollTop = s.log.scrollHeight * 0.3;
    const target = atLine(s);
    s.settleFrames();
    const near = s.rows.filter(r => r.classList.contains("height-ready") && Math.abs(r.i - target.i) < 30).length;
    t.ok("近づいた行だけが確定する（着いた先の前後 120 行まで）", s.ready() - before > 0 && s.ready() - before < 120 && near > 0, `+${s.ready() - before} 行、近く ${near}`);
    t.ok("着いた先から遠い行（先頭）は確定しない", !s.rows[0].classList.contains("height-ready"));
    t.ok("着いた先の基準の行は確定している", target.classList.contains("height-ready"));
  }

  // ---- 遠くへ飛んだ直後の 1 コマ: ブラウザーが自分で描き直す前に、見える範囲の周りを確定する
  {
    const s = screen(2000), settler = attach(s);
    openAtEnd(s, settler);
    s.settleFrames();
    s.resetCounters();
    s.log.scrollTop = Math.round(s.log.scrollHeight * 0.3);      // 発言へ飛ぶ・つまみをドラッグする・検索の移動
    const watched = atLine(s), top = watched.getBoundingClientRect().top;
    s.frame({ idle: false });                                    // 飛んだ次の 1 コマだけ（手が空いたときの確定の前）
    const moved = watched.getBoundingClientRect().top - top;
    t.ok("遠くへ飛んだ直後の 1 コマで、見える範囲の上下は確定済み（ブラウザーが仮の高さのまま描き直した行がない）", s.nativeShown.size === 0 && watched.classList.contains("height-ready"), `${s.nativeShown.size} 行が仮の高さのまま描かれた`);
    t.ok("その 1 コマで、飛んだ先の基準の行は動かない", Math.abs(moved) < 1, `動いた量 ${moved}px`);
    s.settleFrames();
    t.ok("飛んだ先が落ち着いた後も、基準の行は動かない", Math.abs(watched.getBoundingClientRect().top - top) < 1);
  }

  // ---- 実寸が仮の高さより小さい行（短い発言）でも: 確定で縮むと、範囲に入る行が増える。増えた分も描画の前に確定する
  {
    const s = screen(2000, 988, { heights: [60, 103, 63, 90] }), settler = attach(s);
    openAtEnd(s, settler);
    s.settleFrames();
    s.resetCounters();
    s.log.scrollTop = Math.round(s.log.scrollHeight * 0.4);
    const watched = atLine(s), top = watched.getBoundingClientRect().top;
    s.frame({ idle: false });
    const moved = watched.getBoundingClientRect().top - top;
    t.ok("短い行の会話でも、遠くへ飛んだ直後の 1 コマで、ブラウザーが仮の高さのまま描き直した行がなく、基準の行も動かない", s.nativeShown.size === 0 && Math.abs(moved) < 1, `${s.nativeShown.size} 行が仮の高さのまま描かれた、動いた量 ${moved}px`);
  }

  // ---- 確定で高さが変わっても、見ている位置は動かない（広い窓・狭い窓）
  for (const width of [2268, 988]) {
    // 途中まで読み返している位置。確定の前後で、#log の上端 + 80px の線にかかる行の位置を比べる
    const s = screen(480, width), settler = attach(s);
    s.log.scrollTop = Math.round(s.log.scrollHeight * 0.4);
    s.frame();        // 見えた行はブラウザーが実寸で描く
    const watched = atLine(s), top = watched.getBoundingClientRect().top;
    s.resetCounters();
    settler.prepare();
    s.settleFrames();
    const moved = watched.getBoundingClientRect().top - top;
    t.ok(`#log 幅 ${width}px: 読み返している位置は、確定の後も動かない`, Math.abs(moved) < 1 && s.gap() > 40, `動いた量 ${moved}px`);
    t.ok(`#log 幅 ${width}px: 読み返している所の近くが確定し、遠くは確定しない`, s.ready() > 0 && s.ready() < 120 && !s.rows[0].classList.contains("height-ready") && !s.rows.at(-1).classList.contains("height-ready"), `${s.ready()} 行`);
  }

  // ---- 行の高さに端数があっても、補正の丸め誤差が積もらない
  {
    const s = screen(2000, 988, { fractional: true }), settler = attach(s);
    s.log.scrollTop = Math.round(s.log.scrollHeight * 0.4);
    s.frame();
    const watched = atLine(s), top = watched.getBoundingClientRect().top;
    settler.prepare();
    s.settleFrames();
    const moved = watched.getBoundingClientRect().top - top;
    t.ok("行の高さに端数があっても、読み返している位置のずれは 1px 未満（補正のたびの丸め誤差が積もらない）", Math.abs(moved) < 1 && s.ready() > 20, `動いた量 ${moved}px、確定 ${s.ready()} 行`);
  }

  // ---- 上へ速くスクロールしても、位置は飛ばず、見える行が仮の高さのまま描かれることもない
  {
    const s = screen(2000), settler = attach(s);
    openAtEnd(s, settler);
    s.settleFrames();
    s.resetCounters();
    let worst = 0, jumps = 0;
    for (let step = 0; step < 60; step++) {
      s.log.scrollTop -= 900;
      s.frame();
      const watched = atLine(s), top = watched.getBoundingClientRect().top;
      s.frame();      // 確定の 1 コマ。基準の行は動かない
      const moved = Math.abs(watched.getBoundingClientRect().top - top);
      worst = Math.max(worst, moved);
      if (moved > 1) jumps++;
    }
    t.ok("上へ 900px ずつ 60 回スクロールしても、確定のコマで基準の行が動かない", jumps === 0, `最大 ${worst}px、${jumps} 回`);
    t.ok("その間に確定した行は、進んだ距離の分だけ（会話全体ではない）", s.ready() < 500, `${s.ready()} 行`);
    t.ok("スクロールで見えた行のうち、仮の高さのまま描かれたものは少ない", s.nativeShown.size <= 8, `${s.nativeShown.size} 行`);
  }

  // ---- 会話を切り替える・行が外れる
  {
    const s = screen(400), settler = attach(s);
    openAtEnd(s, settler);
    settler.cancel();
    const ready = s.ready();
    s.log.scrollTop = 0;
    s.settleFrames();
    t.ok("cancel の後は確定しない（会話を切り替えたら前の行を触らない）", s.ready() === ready);
    settler.prepare();
    for (const r of s.rows.slice(0, 200)) r.isConnected = false;
    s.settleFrames();
    t.ok("外れた行は確定しない", s.rows.slice(0, 200).every(r => !r.classList.contains("height-ready")));
  }

  // ---- 確定が続いているかの知らせ（onBusy。会話の移動の部品が、確定が続く間の同期を間引くのに使う）
  {
    const s = screen(400), calls = [];
    const settler = attach(s, { onBusy: on => calls.push(on) });
    openAtEnd(s, settler);
    t.ok("開くと、確定が続いていると知らせる（続けて同じ値は知らせない）", calls[0] === true && calls.every((v, i) => i === 0 || v !== calls[i - 1]), JSON.stringify(calls));
    s.settleFrames();
    t.ok("落ち着いたら、済んだと知らせる", calls.at(-1) === false && calls.length >= 2, JSON.stringify(calls));
    const before = calls.length;
    s.log.scrollTop = 0;
    s.frame();
    t.ok("スクロールで近づいた行があれば、また続いていると知らせる", calls.length > before && calls.at(-1) === true, JSON.stringify(calls));
    s.settleFrames();
    t.ok("それが落ち着いたら、また済んだと知らせる", calls.at(-1) === false);
    settler.prepare();
    settler.cancel();
    t.ok("cancel（会話の切り替え）では、続いているままにしない", calls.at(-1) === false);
  }
}
