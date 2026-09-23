// Claude バックエンドの途中送信の「渡った」合図と、中断（interrupt）の段取り。
// SDK の query を身代わりに差し替え（setClaudeSdkForTest）、CLI も LLM も呼ばない。
import { backend as claude, setClaudeSdkForTest } from "../../core/backends/claude.mjs";

export const name = "claude-steer-stop";
export const title = "Claude: 途中送信の uuid 照合・まとめ取り出し・中断の interrupt とフォールバック";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * SDK の Query の身代わり。流すメッセージはテストが push し、入力（CLI の stdin）に書かれたフレームを frames に集める。
 * 入力が閉じたら（CLI が stdin の EOF を見て）自分で終わる。SDK の abort を引かれたら例外で終わる（SDK と同じ）
 */
function fakeSdk({ interrupt, exitOnEof = true } = {}) {
  const inbox = [];
  let wake = null;
  let ended = false;
  let error = null;
  const poke = () => { const w = wake; wake = null; w?.(); };
  const q = {
    frames: [],
    interrupts: [],
    inputClosed: false,
    sdkAborted: false,
    options: null,
    push(m) { inbox.push(m); poke(); },
    end() { ended = true; poke(); },
    interrupt(arg) {
      q.interrupts.push(arg);
      return interrupt ? interrupt(arg, q) : Promise.resolve({ still_queued: [] });
    },
    close() {},
    async *[Symbol.asyncIterator]() {
      for (;;) {
        if (inbox.length) { yield inbox.shift(); continue; }
        if (error) throw error;
        if (ended) return;
        await new Promise((r) => { wake = r; });
      }
    },
  };
  const query = ({ prompt, options }) => {
    q.options = options;
    options.abortController?.signal.addEventListener("abort", () => {
      q.sdkAborted = true;
      error = new Error("Claude Code process aborted by user");
      poke();
    }, { once: true });
    (async () => {
      for await (const frame of prompt) q.frames.push(frame);
      q.inputClosed = true;
      if (exitOnEof) q.end();
    })();
    return q;
  };
  return { q, restore: setClaudeSdkForTest({ query, executable: () => "claude-fake" }) };
}

/** 1 ターンを走らせる。events に emit を集め、control.steer が開くまで待ってから返す */
async function startTurn(q, { signal = new AbortController() } = {}) {
  const events = [];
  const control = {};
  const done = claude.runTurn({
    prompt: "first", sessionId: null, cwd: process.cwd(), mode: "default",
    emit: (ev) => events.push(ev), askPermission: async () => ({ allow: true }),
    signal, control, hostSessionId: "host-test",
  });
  done.catch(() => {});
  for (let i = 0; i < 200 && !control.steer; i++) await sleep(5);
  return { events, control, done, signal };
}
const steer = (control, id, prompt) => control.steer({ id, args: { prompt } });
const frameOf = (q, text) => q.frames.find((f) => f.message?.content === text);
const delivered = (events) => events.filter((e) => e.type === "userMessage.delivered").map((e) => e.messageId);
const replay = (uuid, content) => ({ type: "user", isReplay: true, ...(uuid ? { uuid } : {}), message: { role: "user", content } });
const result = (subtype = "success") => ({ type: "result", subtype, num_turns: 1 });
const until = async (fn, ms = 2000) => { for (let t = 0; t < ms && !fn(); t += 5) await sleep(5); return fn(); };

export default async function (t) {
  // ---- (a) uuid 付きの replay で delivered
  {
    const { q, restore } = fakeSdk();
    try {
      const { events, control, done } = await startTurn(q);
      t.ok("control.steer が開き、渡った合図を約束する", typeof control.steer === "function" && control.steerConfirms === true);
      t.ok("途中送信を受理する", await steer(control, "m-a", "Msg A"));
      await until(() => frameOf(q, "Msg A"));
      const f = frameOf(q, "Msg A");
      t.ok("途中送信のフレームに毎回新しい uuid を付ける", /^[0-9a-f-]{36}$/.test(f?.uuid ?? "") && f.priority === "next", JSON.stringify(f));
      await steer(control, "m-a2", "Msg A");
      await until(() => q.frames.length >= 3);
      t.ok("同じ本文でも uuid は別", q.frames[2]?.uuid && q.frames[2].uuid !== f.uuid);
      // 本文を CLI が変えても（pasted_content の展開など）uuid で当たる
      q.push(replay(f.uuid, "Msg A (展開済み)"));
      await until(() => delivered(events).length >= 1);
      t.ok("(a) uuid の一致で delivered を出す", JSON.stringify(delivered(events)) === '["m-a"]', JSON.stringify(delivered(events)));
      q.push(replay(null, "first"));   // 最初のプロンプトの replay は素通り
      q.push(replay(q.frames[2].uuid, "Msg A"));
      await until(() => delivered(events).length >= 2);
      t.ok("最初のプロンプトの replay では何も出さない", JSON.stringify(delivered(events)) === '["m-a","m-a2"]', JSON.stringify(delivered(events)));
      q.push(result());
      q.end();
      await done;
      t.ok("普通に終われば ok の turnResult を 1 回だけ出す",
        events.filter((e) => e.type === "turnResult").map((e) => e.outcome).join() === "ok");
    } finally { restore(); }
  }

  // ---- (b) まとめて取り出された replay（最後のメンバーの uuid、本文は \n でつないだもの）
  {
    const { q, restore } = fakeSdk();
    try {
      const { events, control, done } = await startTurn(q);
      await steer(control, "m-b1", "Msg A: say A-ACK.");
      await steer(control, "m-b2", "Msg B: say B-ACK.  \n");
      await until(() => q.frames.length >= 3);
      const last = frameOf(q, "Msg B: say B-ACK.  \n");
      q.push(replay(last.uuid, "Msg A: say A-ACK.\nMsg B: say B-ACK.  \n"));
      await until(() => delivered(events).length >= 2);
      t.ok("(b) まとめた replay 1 本で各メンバーが delivered になる（uuid あり）",
        JSON.stringify(delivered(events)) === '["m-b1","m-b2"]', JSON.stringify(delivered(events)));
      // uuid を返さない CLI でも、本文のつなぎ目で拾う
      await steer(control, "m-b3", "C one");
      await steer(control, "m-b4", "D two");
      await until(() => q.frames.length >= 5);
      q.push(replay(null, "C one\nD two"));
      await until(() => delivered(events).length >= 4);
      t.ok("(b) uuid の無い、本文をつないだ replay でも全件 delivered", JSON.stringify(delivered(events).slice(2)) === '["m-b3","m-b4"]', JSON.stringify(delivered(events)));
      // 当てはまらない本文では何も出さない（途中まで一致しただけで取り出さない）
      await steer(control, "m-b5", "E three");
      await until(() => q.frames.length >= 6);
      q.push(replay(null, "E three\nsomething else"));
      await sleep(30);
      t.ok("最後まで当てはまらない replay では取り出さない", delivered(events).length === 4, JSON.stringify(delivered(events)));
      q.push(result());
      q.end();
      await done;
    } finally { restore(); }
  }

  // ---- (c) replay が来ないまま次の CLI の内部ターンが始まった
  {
    const { q, restore } = fakeSdk();
    try {
      const { events, control, done } = await startTurn(q);
      await steer(control, "m-c1", "late one");
      await steer(control, "m-c2", "late two");
      await until(() => q.frames.length >= 3);
      q.push(result());                      // 内部ターンが終わった（区切りが来なかった）
      await sleep(20);
      await steer(control, "m-c3", "after result");   // result の後に送った分はまだ取り出されていない
      await until(() => q.frames.length >= 4);
      t.ok("result だけではまだ delivered を出さない", delivered(events).length === 0);
      q.push({ type: "system", subtype: "init", model: "claude-test" });   // 次の内部ターン
      await until(() => delivered(events).length >= 2);
      t.ok("(c) 次の内部ターンが始まったら、その前から残っていた分を delivered にする",
        JSON.stringify(delivered(events)) === '["m-c1","m-c2"]', JSON.stringify(delivered(events)));
      q.push(result());
      q.push({ type: "system", subtype: "init" });
      await until(() => delivered(events).length >= 3);
      t.ok("result の後に送った分は、その次の内部ターンで delivered", delivered(events)[2] === "m-c3", JSON.stringify(delivered(events)));
      q.push(result());
      q.end();
      await done;
      t.ok("内部ターンの result は保留し、最後に ok を 1 回だけ出す",
        events.filter((e) => e.type === "turnResult").map((e) => e.outcome).join() === "ok");
    } finally { restore(); }
  }

  // ---- (d) 中断: interrupt を送り、取り消された途中送信は dropped、結果は aborted
  {
    let cancelUuid = null;
    const { q, restore } = fakeSdk({
      interrupt: async (_arg, q) => {
        // CLI は interrupt の応答（受領）を、打ち切った内部ターンの result より先に書く
        setTimeout(() => q.push(result("error_during_execution")), 5);
        return { still_queued: [], cancelled: [cancelUuid, "not-ours"] };
      },
    });
    const restoreTiming = setClaudeSdkForTest({ stopAckMs: 5000, stopExitMs: 5000 });
    try {
      const { events, control, done, signal } = await startTurn(q);
      await steer(control, "m-d1", "folded");
      await steer(control, "m-d2", "still queued");
      await until(() => q.frames.length >= 3);
      q.push(replay(frameOf(q, "folded").uuid, "folded"));
      cancelUuid = frameOf(q, "still queued").uuid;
      await until(() => delivered(events).length >= 1);
      t.ok("SDK には server の AbortController を渡さない（中断で stdin を即座に閉じさせない）",
        q.options.abortController && q.options.abortController !== signal);
      const t0 = Date.now();
      signal.abort();
      t.ok("中断の直後は途中送信を受け付けない", (await steer(control, "m-d3", "too late")) === false);
      await done;
      const ms = Date.now() - t0;
      t.ok("(d) 中断で interrupt を cancelQueued 付きで送る", q.interrupts.length === 1 && q.interrupts[0]?.cancelQueued === true, JSON.stringify(q.interrupts));
      t.ok("interrupt の後は入力を閉じ、SDK の abort は引かない", q.inputClosed && !q.sdkAborted);
      t.ok("(d) interrupt で終わっても turnResult は aborted だけ",
        events.filter((e) => e.type === "turnResult").map((e) => e.outcome).join() === "aborted",
        JSON.stringify(events.filter((e) => e.type === "turnResult")));
      t.ok("取り消された途中送信に userMessage.dropped を出す（知らない uuid は無視）",
        JSON.stringify(events.filter((e) => e.type === "userMessage.dropped").map((e) => e.messageId)) === '["m-d2"]',
        JSON.stringify(events.filter((e) => e.type === "userMessage.dropped")));
      t.ok("すぐ止まる（上限を待たない）", ms < 1000, `${ms}ms`);
    } finally { restoreTiming(); restore(); }
  }

  // ---- (e) interrupt が応答しないときは、上限の後で入力を閉じて SDK の abort に落とす
  {
    const { q, restore } = fakeSdk({ interrupt: () => new Promise(() => {}) });
    const restoreTiming = setClaudeSdkForTest({ stopAckMs: 150, stopExitMs: 150 });
    try {
      const { events, done, signal } = await startTurn(q);
      const t0 = Date.now();
      signal.abort();
      await sleep(50);
      t.ok("上限までは SDK の abort を引かない", !q.sdkAborted && q.interrupts.length === 1);
      await done;
      const ms = Date.now() - t0;
      t.ok("(e) 応答が無ければ SDK の abort に落ちる", q.sdkAborted && q.inputClosed, `${ms}ms`);
      t.ok("(e) フォールバックでも turnResult は aborted", events.filter((e) => e.type === "turnResult").map((e) => e.outcome).join() === "aborted");
    } finally { restoreTiming(); restore(); }
  }

  // ---- interrupt は受領したが CLI が終わらない: stopExitMs の後で同じく落とす
  {
    const { q, restore } = fakeSdk({ exitOnEof: false });   // 入力が閉じても終わらない CLI
    const restoreTiming = setClaudeSdkForTest({ stopAckMs: 5000, stopExitMs: 120 });
    try {
      const { events, done, signal } = await startTurn(q);
      signal.abort();
      await done;
      t.ok("受領の後に終わらない CLI も SDK の abort で止める", q.interrupts.length === 1 && q.sdkAborted
        && events.filter((e) => e.type === "turnResult").map((e) => e.outcome).join() === "aborted");
    } finally { restoreTiming(); restore(); }
  }
}
