// 長い履歴を開いたあと、仮の高さ（style.css の content-visibility・160px）の発言を実寸に確定しても、
// 見ている位置が動かないこと（web/client.mjs の prepareHistoryHeights）。
// client.mjs の関数を切り出し、行の高さと #log のスクロールだけを持つ作りものの画面の上で走らせる。
// 列（.thread の max-width:860px）より #log がずっと広い窓（2,268px）でも、狭い窓でも同じ結果になることを見る。
// 本物の Chromium での確認は tests/browser/history-heights.cjs
import fs from "node:fs/promises";
import vm from "node:vm";

export const name = "history-heights";
export const title = "履歴の実寸を確定しても、末尾にいれば末尾に、読み返し中ならその位置に留まる";

const PLACEHOLDER = 160, THREAD_WIDTH = 860, LOG_TOP = 50, LOG_LEFT = 292, VIEW = 900;

/**
 * 行の高さと #log のスクロールだけを持つ画面。行は上から積み、まだ確定していない行は仮の高さで並ぶ。
 * ただし一度画面に入った行は、ブラウザーが実寸で描いている（shown）
 */
function layout(logWidth, heights) {
  const rows = heights.map((actual, i) => {
    const classes = new Set(["mw"]);
    const row = {
      i, actual, isConnected: true, shown: false,
      classList: { add: c => classes.add(c), contains: c => classes.has(c) },
      get height() { return classes.has("height-ready") || row.shown ? actual : PLACEHOLDER; },
      get offsetHeight() { return this.height; },
      closest: sel => sel === ".mw" ? row : null,
      getBoundingClientRect() {
        let y = 0;
        for (const r of rows) { if (r === row) break; y += r.height; }
        const top = LOG_TOP + y - log.scrollTop;
        return { top, bottom: top + row.height, left: LOG_LEFT + 8, right: LOG_LEFT + 8 + THREAD_WIDTH, height: row.height };
      },
    };
    return row;
  });
  let scrollTop = 0;
  const log = {
    clientHeight: VIEW,
    get scrollHeight() { return rows.reduce((s, r) => s + r.height, 0); },
    get scrollTop() { return scrollTop; },
    set scrollTop(v) { scrollTop = Math.max(0, Math.min(v, this.scrollHeight - this.clientHeight)); },
    getBoundingClientRect: () => ({ top: LOG_TOP, left: LOG_LEFT, width: logWidth, height: VIEW, right: LOG_LEFT + logWidth, bottom: LOG_TOP + VIEW }),
    addEventListener() {},
    closest: () => null,
  };
  const thread = {
    querySelectorAll(sel) {
      if (sel === ":scope > .mw") return rows;
      if (sel === ":scope > .mw:not(.activity):not(.height-ready)") return rows.filter(r => !r.classList.contains("height-ready"));
      throw Error(`想定していないセレクター: ${sel}`);
    },
  };
  // 点で当てると、列の中なら行、列の外（列の右の空白）なら #log そのもの
  const elementFromPoint = (x, y) => {
    if (x < LOG_LEFT + 8 || x > LOG_LEFT + 8 + THREAD_WIDTH) return log;
    return rows.find(r => { const b = r.getBoundingClientRect(); return b.top <= y && y < b.bottom; }) ?? log;
  };
  // 画面に入っている行を実寸で描く。伸びると画面に入る行が変わるので、落ち着くまで繰り返す
  const paint = keepEnd => {
    for (let changed = true; changed;) {
      changed = false;
      if (keepEnd) log.scrollTop = log.scrollHeight;
      for (const r of rows) {
        const b = r.getBoundingClientRect();
        if (!r.shown && b.bottom > LOG_TOP && b.top < LOG_TOP + VIEW) { r.shown = true; changed = true; }
      }
    }
  };
  return { rows, log, thread, elementFromPoint, paint };
}

export default async function (t) {
  const source = (await fs.readFile(new URL("../../web/client.mjs", import.meta.url), "utf8")).replaceAll("\r\n", "\n");
  const cut = name => {
    const start = source.indexOf(`function ${name}(`);
    if (start < 0) return "";
    return source.slice(start, source.indexOf("\n}", start) + 2);
  };
  const atBottom = source.match(/^const atBottom = .*$/m)?.[0];
  t.ok("client.mjs から atBottom と prepareHistoryHeights を切り出せる", !!atBottom && !!cut("prepareHistoryHeights"));

  /** 画面を作って履歴の確定を最後まで走らせる。before でスクロール位置を決め、確定の前後の様子を返す */
  const run = (logWidth, heights, before) => {
    const screen = layout(logWidth, heights);
    const timers = [];
    let now = 1000;
    const context = vm.createContext({
      log: screen.log, thread: screen.thread,
      document: { elementFromPoint: screen.elementFromPoint },
      performance: { now: () => now },
      requestAnimationFrame: cb => timers.push(cb),
      setTimeout: cb => { timers.push(cb); return timers.length; },
      clearTimeout() {},
      heightPreparationVersion: 0, heightPreparationTimer: null, lastHistoryInput: -Infinity,
    });
    vm.runInContext(`${atBottom}\n${cut("historyAnchor")}\n${cut("prepareHistoryHeights")}\nthis.prepare = prepareHistoryHeights;`, context);
    const watched = before(screen);
    const top = watched?.getBoundingClientRect().top;
    context.prepare();
    for (let n = 0; timers.length && n < 10000; n++) { now += 5; timers.shift()(); }
    const { log, rows } = screen;
    return {
      ready: rows.every(r => r.classList.contains("height-ready")),
      gap: log.scrollHeight - log.scrollTop - log.clientHeight,
      moved: watched ? watched.getBoundingClientRect().top - top : 0,
    };
  };

  // 493 行ほどの長い会話に似せる。実寸は仮の高さより大きいものも小さいものもある
  const heights = Array.from({ length: 480 }, (_, i) => [90, 420, 1600, 60, 2400, 300, 130, 760][i % 8]);
  const toEnd = ({ paint }) => { paint(true); return null; };
  // 途中まで読み返した位置。#log の上端 + 80px の線にかかる行を見張る
  const midway = ({ log, rows, paint }) => {
    log.scrollTop = Math.round(log.scrollHeight * 0.4);
    paint(false);
    return rows.find(r => r.getBoundingClientRect().bottom > LOG_TOP + 80);
  };

  for (const width of [2268, 988]) {
    const end = run(width, heights, toEnd);
    t.ok(`#log 幅 ${width}px: 末尾で開くと、全部の行を確定した後も末尾にいる`, end.ready && end.gap < 40, `gap ${end.gap}px`);
    const mid = run(width, heights, midway);
    t.ok(`#log 幅 ${width}px: 読み返している位置は、確定の後も動かない`, mid.ready && Math.abs(mid.moved) < 1 && mid.gap > 40, `動いた量 ${mid.moved}px`);
  }
}
