// Claude バックエンドの同じ会話での巻き戻し（resume + resumeSessionAt + resumeDropsTurn。ADR 0091）。
// SDK の query を身代わりに差し替え（setClaudeSdkForTest）、CLI も LLM も呼ばない。
import { backend as claude, setClaudeSdkForTest } from "../../core/backends/claude.mjs";

export const name = "claude-rewind";
export const title = "Claude: 巻き戻しの引数を resume に添える・拒否は失敗として見せず呼び出し側へ返す";

/** 1 回の query を身代わりにする。fail を渡すと、その例外で終わる（CLI が resume を拒否したときの形） */
function fakeSdk({ fail = null, first = false } = {}) {
  const seen = { options: null };
  const query = ({ prompt, options }) => {
    seen.options = options;
    const q = {
      interrupt: async () => ({ still_queued: [] }), close() {},
      async *[Symbol.asyncIterator]() {
        // プロンプトの入力が引かれたら（CLI が stdin を読み始めたら）失敗する / 終わる
        const it = prompt[Symbol.asyncIterator]();
        await it.next();
        // first: CLI から最初のメッセージ（init）が届いてから失敗する
        if (first) yield { type: "system", subtype: "init", session_id: "native-1" };
        if (fail) throw fail;
        yield { type: "result", subtype: "success", num_turns: 1 };
      },
    };
    return q;
  };
  return { seen, restore: setClaudeSdkForTest({ query, executable: () => "claude-fake" }) };
}

const run = async (extra = {}) => {
  const events = [];
  const control = {};
  const outcome = await claude.runTurn({ prompt: "again", sessionId: "native-1", cwd: process.cwd(), mode: "default",
    emit: ev => events.push(ev), askPermission: async () => ({ allow: true }), signal: new AbortController(), control,
    hostSessionId: "host-rewind", ...extra }).then(() => null, error => error);
  return { events, error: outcome };
};

export default async function (t) {
  t.ok("巻き戻せる口を宣言する（resumeAt）", claude.capabilities.rewind === "resumeAt");

  {
    const { seen, restore } = fakeSdk();
    try {
      const { events, error } = await run({ rewind: { at: "u-keep", drops: "u-drop" } });
      t.ok("resume に resumeSessionAt（残す最後の発言）と resumeDropsTurn（捨てる発言）を添える",
        seen.options.resume === "native-1" && seen.options.resumeSessionAt === "u-keep" && seen.options.resumeDropsTurn === "u-drop", JSON.stringify(seen.options.resume));
      t.ok("巻き戻したターンも普通に終わる", !error && events.some(e => e.type === "turnResult" && e.outcome === "ok"), String(error));
    } finally { restore(); }
  }
  {
    const { seen, restore } = fakeSdk();
    try {
      await run();
      t.ok("巻き戻しが無ければ添えない", !("resumeSessionAt" in seen.options) && !("resumeDropsTurn" in seen.options));
    } finally { restore(); }
  }
  {
    const { seen, restore } = fakeSdk();
    try {
      await run({ sessionId: null, rewind: { at: "u-keep", drops: "u-drop" } });
      t.ok("再開するセッションが無ければ（新しい会話）添えない", !("resumeSessionAt" in seen.options));
    } finally { restore(); }
  }
  {
    const { restore } = fakeSdk({ fail: new Error("Resume rejected by --resume-drops-turn: range does not start with the declared turn prompt") });
    try {
      const { events, error } = await run({ rewind: { at: "u-keep", drops: "u-drop" } });
      t.ok("拒否は rewindRejected で呼び出し側へ返す（ホスト管理に落とす）", error?.rewindRejected === true && error.undelivered === true, String(error?.message));
      t.ok("拒否は失敗として画面に見せない（turnResult の error を出さない）", !events.some(e => e.type === "turnResult"), JSON.stringify(events.filter(e => e.type === "turnResult")));
    } finally { restore(); }
  }
  {
    // 拒否の文が SDK の例外に載らない（プロセスが終了コードで落ちると stderr は別に溜まる）。文面に依らず、何も届かないうちの失敗を拒否として返す
    const { restore } = fakeSdk({ fail: new Error("Claude Code process exited with code 1") });
    try {
      const { events, error } = await run({ rewind: { at: "u-keep", drops: "u-drop" } });
      t.ok("拒否の文が無い例外でも、巻き戻しを伴うターンが CLI から何も届かず失敗したら rewindRejected（ホスト管理へ落とす）", error?.rewindRejected === true && error.undelivered === true, String(error?.message));
      t.ok("その失敗は画面に見せない", !events.some(e => e.type === "turnResult"));
    } finally { restore(); }
  }
  {
    const { restore } = fakeSdk({ fail: new Error("API Error: overloaded"), first: true });
    try {
      const { events, error } = await run({ rewind: { at: "u-keep", drops: "u-drop" } });
      t.ok("CLI が動き出してから（init のあと）の失敗は拒否ではなく、普通の失敗として見せる", error && !error.rewindRejected && events.some(e => e.type === "turnResult" && e.outcome === "error"), String(error?.message));
    } finally { restore(); }
  }
  {
    const { restore } = fakeSdk({ fail: new Error("Claude Code process exited with code 1") });
    try {
      const { error } = await run();
      t.ok("巻き戻しを頼んでいないターンの、何も届かないうちの失敗は今までどおり（rewindRejected を付けない）", error && !error.rewindRejected);
    } finally { restore(); }
  }
  {
    const { restore } = fakeSdk({ fail: new Error("Resume rejected by --resume-drops-turn: x") });
    try {
      const { events, error } = await run();
      t.ok("巻き戻しを頼んでいないターンの失敗は今までどおり（失敗として見せる）", error && !error.rewindRejected && events.some(e => e.type === "turnResult" && e.outcome === "error"));
    } finally { restore(); }
  }
}
