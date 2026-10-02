// core/server.mjs につなぐ WebSocket クライアント。
//
// 検証スクリプトが各自持っていた定型 —— ready 待ち・command の往復・
// イベントの溜め込み・承認の自動許可・turnEnd 待ち —— をここ1か所に集める。
// 依存は既存の ws だけ（グローバル WebSocket に頼らないので Node 20 でも動く）。
import WebSocket from "ws";

/**
 * 1本つないで ready を受け取るまで待つ。
 * @param onEvent 受け取ったイベントごとに呼ばれる。第2引数はこの接続自身。
 * @param autoAllow 承認要求が来たら即 allow する（承認フロー自体を測らないテスト用）。
 *   fake-codex の既定の台本はコマンドの承認を求めるので、そのターンを走らせるなら付ける。
 *   引数は 1 つだけ: `open({ ...host, autoAllow: true })`（`open(host, { autoAllow: true })` は効かない）。
 */
export async function open({ port, token, host = "127.0.0.1", onEvent, autoAllow = false } = {}) {
  const ws = new WebSocket(`ws://${host}:${port}/ws?token=${token}`);
  const pending = new Map();
  const events = [];
  const watchers = new Set();
  let seq = 0;
  let helloDone = false;
  let resolveHello, rejectHello;
  const hello = new Promise((res, rej) => {
    resolveHello = (m) => { helloDone = true; res(m); };
    rejectHello = rej;
  });

  const cmd = (command, args = {}) =>
    new Promise((res, rej) => {
      const id = String(++seq);
      pending.set(id, { res, rej });
      ws.send(JSON.stringify({ kind: "command", command, id, args }));
    });

  ws.on("message", (raw) => {
    let m;
    try { m = JSON.parse(raw.toString()); } catch { return; }
    if (m.kind === "ready") return resolveHello(m);
    if (m.kind === "response") {
      const p = pending.get(m.id);
      pending.delete(m.id);
      return m.ok ? p?.res(m.result) : p?.rej(new Error(String(m.error)));
    }
    if (m.kind !== "event") return;
    const ev = m.event;
    events.push(ev);
    if (autoAllow && ev.type === "permission") {
      cmd("resolvePermission", { id: ev.id, allow: true }).catch(() => {});
    }
    // onEvent は非同期でもよい（承認を返してから次の指示を出す、など）
    const oops = (err) => console.log(`      onEvent で例外: ${err?.stack ?? err}`);
    try { Promise.resolve(onEvent?.(ev, api)).catch(oops); } catch (err) { oops(err); }
    for (const w of [...watchers]) if (w.pred(ev)) { watchers.delete(w); w.res(ev); }
  });

  // 切断の検証では意図的に切るので、待っている側には例外として伝えて握り潰す
  const fail = (err) => {
    const e = err ?? new Error("接続が閉じた");
    if (!helloDone) rejectHello(e);   // つなげなかった（401 など）ときに待ち続けない
    for (const p of pending.values()) p.rej(e);
    pending.clear();
  };
  ws.on("error", fail);
  ws.on("close", () => fail(new Error("接続が閉じた")));

  const api = {
    ws,
    cmd,
    events,
    /** いまのイベント数。ここから先だけを見たいときの目印にする。 */
    mark: () => events.length,
    since: (from) => events.slice(from),

    /**
     * 条件に合うイベントを待つ。既に来ていればそれを返す。
     * from を渡すと、その目印より後に来たものだけを見る
     * （前のターンの turnEnd を拾ってしまう事故を防ぐ）。
     */
    waitFor(pred, { ms = 300000, from = 0 } = {}) {
      const hit = events.slice(from).find(pred);
      if (hit) return Promise.resolve(hit);
      return new Promise((res, rej) => {
        const w = { pred, res };
        watchers.add(w);
        setTimeout(() => {
          if (watchers.delete(w)) rej(new Error(`waitFor が ${ms}ms で timeout`));
        }, ms).unref?.();
      });
    },

    /**
     * 1ターン走らせて終わるまで待ち、そのターンのあいだに起きたことをまとめて返す。
     * runTurn の応答と turnEnd の両方を見る。断られたときに turnEnd を待ち続けないため。
     * 待つのはこの回の会話の turnEnd だけ。裏で別の会話のターン（委譲の完了通知など）が走っても、その終わりで返らない。
     * 新しい会話は、呼んだ時点までに見ていない ID の session をこの回の会話とする。
     * id が決まる前に終わったターンの turnEnd は sessionId が null なので、そのときは null の turnEnd で返る。
     */
    async runTurn(args, { ms = 300000 } = {}) {
      const from = events.length;
      const known = new Set(events.map((e) => e.sessionId).filter(Boolean));
      let own = args?.sessionId ?? null;
      const mine = (e) => {
        if (!own && e.type === "session" && e.sessionId && !known.has(e.sessionId)) own = e.sessionId;
        return e.type === "turnEnd" && (e.sessionId ?? null) === own;
      };
      const started = cmd("runTurn", args);
      const ended = api.waitFor(mine, { ms, from });
      await Promise.race([ended, started.then(() => ended)]);
      return api.turnResult(from, { sessionId: own });
    },

    /**
     * 目印から後のイベントを、よく見る形に畳んで返す。
     * sessionId を渡すと、会話の ID・モデル・結果はその会話のものを選ぶ（events・tools・permissions は目印から後の全部）。
     */
    turnResult(from, { sessionId } = {}) {
      const slice = events.slice(from);
      const scoped = sessionId === undefined ? slice : slice.filter((e) => e.sessionId === sessionId);
      // プロトコル v2 では生の SDK メッセージは来ない。正規化された tool.start を数える
      const tools = slice.filter((e) => e.type === "tool.start").map((e) => e.name);
      return {
        events: slice,
        tools,
        sessionId: sessionId !== undefined ? sessionId : slice.find((e) => e.type === "session")?.sessionId ?? null,
        permissions: slice.filter((e) => e.type === "permission"),
        // 実際に解決されたモデル。session イベントに乗ってくる（乗せられるバックエンドだけ）。
        // id が決まるのとモデルが分かるのは別のタイミングなので、model を持つ方を探す
        initModel: scoped.find((e) => e.type === "session" && e.model)?.model ?? null,
        outcome: scoped.find((e) => e.type === "turnResult")?.outcome ?? null,
      };
    },

    close() { try { ws.close(); } catch {} },
    /** 行儀よく閉じずに落とす。host が突然消えた状況を作る。 */
    terminate() { try { ws.terminate(); } catch {} },
  };

  api.ready = await hello;
  return api;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
