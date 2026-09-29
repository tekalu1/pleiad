// 返答の本文は 1 コマに 1 回だけ描き直す（web/client.mjs の appendText・flushStream）。
// デルタごとに Markdown を最初から作り直し、会話全体のレイアウトを強制すると、スマホの CPU では
// デルタの間隔に追いつかず、数秒〜十数秒コマが出なかった（issue #37）。時間ではなく、変換と筋の貼り直しの回数で見る。
// rAF は手で進める。流れが終わる所（text.end・ツール・発言を閉じる）と会話の切り替えでは、貯めた分を取りこぼさず、別の会話へ描かない。
import fs from "node:fs/promises";
import vm from "node:vm";

export const name = "stream-frames";
export const title = "text.delta は 1 コマに 1 回だけ描く。流れの終わりでは描き切り、会話を切り替えたら別の会話へ描かない";

export default async function (t) {
  const source = (await fs.readFile(new URL("../../web/client.mjs", import.meta.url), "utf8")).replaceAll("\r\n", "\n");
  const functions = ["appendText", "flushStream", "cancelStream", "endStream", "closeTurnEl", "clearThread"].map(name => {
    const start = source.indexOf(`function ${name}(`);
    return start < 0 ? "" : source.slice(start, source.indexOf("\n}", start) + 2);
  });
  t.ok("client.mjs から本文まわりの関数を切り出せる", functions.every(Boolean));

  const noop = () => {};
  /** 1 つの画面。frames は rAF に積まれたもの、渡す atBottom で末尾にいるかを決める */
  const screen = ({ bottom = true } = {}) => {
    const frames = [];
    const c = { conversions: 0, layouts: 0, shows: 0, ids: 0 };
    const log = { scrollTop: 0, scrollHeight: 1000 };
    const state = { streamEl: null, turnEl: null, turnClosed: false, thinkEl: null, toolCards: new Map() };
    const activity = { el: null, text: "", show(text) { this.text = text; this.el = { isConnected: true }; c.shows++; }, hide: noop };
    const context = vm.createContext({
      state, log, activity,
      requestAnimationFrame: cb => { frames.push(cb); return frames.length; },
      cancelAnimationFrame: id => { frames[id - 1] = null; },
      streamFrame: 0, streamTarget: null,
      atBottom: () => bottom,
      relayoutBranches: () => { c.layouts++; },
      renderAssistantMarkdown: raw => { c.conversions++; return `<p>${raw}</p>`; },
      ACTIVITY_LABEL: { writing: "writing", stopping: "stopping" }, stoppingHere: () => false,
      closeThink: noop, closeBundle: noop,
      el: () => ({ dataset: {}, isConnected: true, innerHTML: "" }),
      openTurnEl: () => (state.turnEl ??= { append: noop }),
      heightPreparationVersion: 0, heightPreparationTimer: null,
      thread: { replaceChildren: noop, classList: { remove: noop } },
      spine: noop,
    });
    vm.runInContext(functions.join("\n"), context);
    const deltas = (texts) => { for (const x of texts) { context.text = x; vm.runInContext("appendText(text)", context); } };
    const run = code => vm.runInContext(code, context);
    /** 次のコマ: 積まれた rAF を 1 回ずつ進める */
    const frame = () => { const cbs = frames.splice(0); for (const cb of cbs) cb?.(); };
    return { c, log, state, activity, deltas, run, frame, frames };
  };

  // 1. 同じコマの中のデルタ 100 回で、Markdown の変換は 1 回、筋の貼り直しは 1 回以下
  {
    const s = screen();
    s.deltas(Array.from({ length: 100 }, (_, i) => `${i},`));
    const body = s.state.streamEl;
    t.ok("コマが来るまで、デルタは変換も筋の貼り直しもしない", s.c.conversions === 0 && s.c.layouts === 0 && body.innerHTML === "");
    t.ok("デルタは本文の正本（dataset.raw）へ貯める", body.dataset.raw === Array.from({ length: 100 }, (_, i) => `${i},`).join(""));
    t.ok("100 デルタで積む rAF は 1 つ", s.frames.length === 1);
    s.frame();
    t.ok("コマが来ると、Markdown の変換は 1 回、筋の貼り直しは 1 回以下", s.c.conversions === 1 && s.c.layouts <= 1, `変換 ${s.c.conversions} 回、貼り直し ${s.c.layouts} 回`);
    t.ok("コマで描いた本文に最後の文字まで入っている", body.innerHTML === `<p>${body.dataset.raw}</p>` && body.innerHTML.includes("99,"));
    t.ok("稼働表示の更新は最初の 1 回だけ（文言が変わったときだけ）", s.c.shows === 1, `${s.c.shows} 回`);
    // 次のコマ: 続きのデルタがまた 1 回にまとまる
    s.deltas(["a", "b", "c"]);
    s.frame();
    t.ok("次のコマも 1 回にまとまり、続きまで描かれる", s.c.conversions === 2 && body.innerHTML.endsWith("abc</p>"));
    s.frame();
    t.ok("デルタが無ければ、コマが来ても描かない", s.c.conversions === 2);
  }

  // 2. 稼働表示の文言が変わったら更新する（考え中 → 書いている）
  {
    const s = screen();
    s.deltas(["x"]);
    s.activity.text = "thinking";
    s.deltas(["y"]);
    t.ok("稼働表示の文言が変わったときは更新する", s.c.shows === 2 && s.activity.text === "writing");
    s.activity.el = null;
    s.deltas(["z"]);
    t.ok("稼働表示の行が外れたときも出し直す", s.c.shows === 3);
  }

  // 3. text.end などで流れが終わるときは、コマを待たずに最後の文字まで同期で描く
  {
    const s = screen();
    s.deltas(["あ", "い", "う"]);
    const body = s.state.streamEl;
    s.run("endStream()");
    t.ok("endStream は貯めた分を同期で最後の文字まで描き切る", body.innerHTML === "<p>あいう</p>" && s.c.conversions === 1);
    t.ok("描き切った後、本文の要素の参照は外れる", s.state.streamEl === null);
    s.frame();
    t.ok("描き切った後にコマが来ても、二重には描かない", s.c.conversions === 1);
    s.deltas(["え"]);
    t.ok("次の本文は新しい要素へ貯まる（前の要素は書き換えない）", s.state.streamEl !== body && body.innerHTML === "<p>あいう</p>");
    s.run("closeTurnEl()");
    t.ok("closeTurnEl（ツール・中断・ターン終了の前）も貯めた分を描き切る", s.state.streamEl === null && s.c.conversions === 2);
  }

  // 4. 会話を切り替えたら、前の会話の文字を新しい会話へ描かない
  {
    const s = screen();
    s.deltas(["古い会話の文字"]);
    const old = s.state.streamEl;
    old.isConnected = false;                  // 筋ごと捨てられた（thread.replaceChildren）
    s.run("clearThread()");
    s.frame();
    t.ok("切り替えの前に描かれなかった分は、捨てた本文に描かない", s.c.conversions === 0 && old.innerHTML === "");
    t.ok("clearThread は積んでいたコマを取り消す", s.frames.every(f => !f));
    s.deltas(["新しい会話の文字"]);
    s.frame();
    const fresh = s.state.streamEl;
    t.ok("新しい会話の本文には、新しい会話の文字だけが描かれる", fresh !== old && fresh.innerHTML === "<p>新しい会話の文字</p>" && old.innerHTML === "");
  }
  {
    // clearThread を通らずに要素だけ外れても（枝の切り替えで行が剥がれる）、筋の貼り直しも末尾への追従もしない
    const s = screen();
    s.deltas(["外れる"]);
    const gone = s.state.streamEl;
    gone.isConnected = false;
    const before = s.log.scrollTop;
    s.frame();
    t.ok("外れた本文では、筋を貼り直さず、末尾へも飛ばない", s.c.layouts === 0 && s.log.scrollTop === before);
  }

  // 5. 末尾を見ているときだけ末尾へ追う
  {
    const s = screen({ bottom: true });
    s.deltas(["a"]);
    s.frame();
    t.ok("末尾を見ていれば、描いた後に末尾へ追う", s.log.scrollTop === s.log.scrollHeight);
    const r = screen({ bottom: false });
    r.deltas(["a"]);
    r.frame();
    t.ok("読み返しているときは、勝手に末尾へ飛ばさない", r.log.scrollTop === 0);
    r.deltas(["b"]);
    r.run("endStream()");
    t.ok("描き切るときも、読み返している位置は動かさない", r.log.scrollTop === 0);
  }

  // 6. 中断を頼んだ後は、稼働表示が「中断している」のままなので、デルタごとには更新し直さない
  {
    const s = screen();
    s.run("stoppingHere = () => true");
    s.activity.show = function (text) { this.text = "stopping"; this.el = { isConnected: true }; s.c.shows++; };
    s.deltas(["a", "b", "c", "d"]);
    t.ok("中断している間、稼働表示はデルタごとに更新し直さない", s.c.shows === 1, `${s.c.shows} 回`);
  }
}
