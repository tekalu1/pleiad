// Claude の 1 ターン（1 回の query()）の中で、main とバックグラウンド作業の状態を追う。
//
// **SDK を import しない**。claude-normalize.mjs と同じく、純粋な関数だけを置き、
// tests/unit/claude-background.mjs から LLM 無しで直接呼ぶ。
//
// 実測（2026-09、SDK 0.3.258 / Claude Code 2.1.268。output/bg-tasks/claude-report.md）で分かったこと:
//   - main が返答を終えると最初の result はすぐ出る。バックグラウンドの subagent が走っていても出る。
//     CLI は subagent の完了通知ごとに main を自動で再開し、そのたびに system/init と result を出す
//   - 2 つ目以降の result は、他のバックグラウンド作業が残っている間は保留されうる。
//     result だけでは「main が止まった」と分からない。partial の message_delta.stop_reason で補う
//   - system/background_tasks_changed が生きているバックグラウンドタスクの全量を毎回運ぶ。置き換えで使う
//
// 判定ルール（report §3）:
//   main 作業中 = query 開始 / 2 回目以降の system/init / トップレベルの message_start / session_state running
//   main 停止   = トップレベルの message_delta で stop_reason が tool_use・pause_turn・null 以外 / result / session_state idle
//   phase       = main 停止中で、バックグラウンドタスクが 1 本でも生きていれば waiting、それ以外は active
//
// **閉じた入力は開き直せない**。SDK は入力の generator が終わると CLI の stdin を閉じ、
// 以後の書き込みを黙って捨てる（ProcessTransport の "Dropping write to ended stdin stream"）。
// host ツール（mcp__host__*）の結果も canUseTool の返事もこの stdin を通るので、まだ続いている
// ターンで閉じると、そこから先の host ツールと承認が軒並み落ちる（実測 2026-09。CLI からは
// "The tool call was interrupted before a result was received" / "AbortError: Stream closed"）。
// CLI 内蔵のツールは stdin を使わないので平気で動き続け、**host の口だけが黙って死ぬ**。
// SDK は最初の result までは閉じるのを遅らせる（waitForFirstResult）ので、事故が起きるのは
// **result を 1 回見た後＝CLI が main を自動で再開しうる場面**に限られる。迷ったら閉じない。
//
// 入力（CLI の stdin）を閉じてよいのは次の 3 つが揃ったときだけ（canCloseInput）:
//   (a) main が止まっている
//   (b) バックグラウンドタスクが 1 本も残っていない
//   (c) 流し込んだメッセージのうち、main がまだ取りかかっていないものが無い
//
// (b) は shell（local_bash）も数える（2026-09 に直した）。以前は shell を数えずに閉じていたが、
// **入力を閉じると CLI は数秒でそのコマンドを kill する**（`.output` に `[killed]` だけが残る）。
// Claude の local_bash は終わると必ず system/task_notification（と background_tasks_changed）を出し、
// CLI はそれで main を自動で再開させるので、待てば「完了の通知が来たら報告します」が本当に果たされる。
// 終わらないコマンド（`npm run dev` など）への逃げ道は、タイムアウトではなく作業ダイアログの停止ボタン
// （claude.mjs の stopBackground -> SDK の Query.stopTask。止めると status: "stopped" の通知が来て閉じられる）。
//
// (b) は ambient を数えない（終わらないものが混じると、ターンが永久に終わらなくなる）。
// そのかわり ambient と完了通知は sawWaitable を立て、**閉じる前の猶予を必ず置かせる**。
// 一覧に出さないことと「CLI がこの後 main を再開するか」は別の話で、後者を取り落とすと
// 猶予ゼロで閉じてしまい、上の事故になる。
//
// (c) の「取りかかった」は、流し込んだ後に main が動き出したこと（トップレベルの message_start、
// または result の後の system/init）で数える。--replay-user-messages の echo（claude.mjs で付けている。
// 途中送信が折り込まれた合図に使う）は、ここでは数えない。echo が来ないまま終わる道が残るため。
// 作業中に流し込んだメッセージを、同じターン内の次のリクエストで「取りかかった」と早めに数えることがあるが、
// 害は無い。stdin に書いた時点で CLI の待ち行列に入っており、CLI は入力が閉じた後もそれを処理してから終わる
// （入力を閉じた後の片付けは hasMainThreadQueued の間は始まらない）。

const KIND = { local_agent: "agent", local_bash: "shell" };

/** SDK の task_type -> 正規化した種類。知らないものは other（ワークフロー・MCP タスクなど） */
export function taskKind(type) {
  return KIND[type] ?? "other";
}

/** main が止まったことを表す stop_reason か。tool_use / pause_turn は同じターンが続く */
const stops = (reason) => reason != null && reason !== "tool_use" && reason !== "pause_turn";

const DONE = new Set(["completed", "failed", "killed", "stopped"]);

// サブエージェントの状態（getSubagentState の契約。docs/multi-backend.md §2.3）へ SDK の語彙を写す。
// task_updated の patch.status と task_notification の status の両方をここで受ける。知らない語は写さない
const STATE_OF = {
  completed: "completed",
  failed: "failed",
  killed: "stopped",
  stopped: "stopped",
  pending: "running",
  running: "running",
  paused: "running",
};

/** SDK の状態語 -> running / completed / failed / stopped。知らないものは null */
export function subagentStatus(sdkStatus) {
  return STATE_OF[sdkStatus] ?? null;
}

// 委譲ツールの tool_use_result（sdk-tools.d.ts の AgentOutput）の status のうち、子が**終わった**ことを表すもの。
// 前面で待った子は本物の報告が入って "completed"。裏に回した子は起動した直後に "async_launched" が入る
// （tool_result の本文は "Async agent launched successfully. …"）。teammate_spawned / remote_launched /
// forked（スキルの裏実行）も起動しただけ。実データ（~/.claude/projects の transcript 340 本、
// 2026-09-22）で Agent / Task の結果は completed 22 / async_launched 204 / teammate_spawned 79 / エラー 1 だった
const AGENT_RESULT_DONE = new Set(["completed"]);

/**
 * 1 ターン分の追跡器を作る。
 * observe(SDK メッセージ) が、変化したときだけ正規化イベント（background / phase）を返す。
 */
export function createTurnTracker({ now = () => new Date() } = {}) {
  let mainActive = true;
  let seenResult = false;
  let sawWaitable = false;          // バックグラウンドタスクをこのターンで一度でも見たか（ambient を含む）
  const bg = new Map();             // task_id -> { id, kind, label }。一覧に出すもの（ambient は出さない）
  const known = new Map();          // task_id -> { kind, label }。前景で始まって後から裏へ回ったものに使う
  const pending = new Set();        // 流し込んだが、main がまだ取りかかっていないもの
  let lastTasks = "[]";
  let lastPhase = "active";
  // task_id -> { status, startedAt, endedAt }。Claude では task_id がサブエージェントの agentId と同じ
  // （subagents/agent-<id>.jsonl・<task-id> で一致を実測）。以前は状態を bg から消すためだけに読んで捨てていた。
  // 追加の I/O はしない。すでに流れている SDK メッセージだけで埋める
  const states = new Map();
  const toolTasks = new Map();      // 委譲ツールの tool_use id -> task_id（task_started から）

  const iso = (v) => {
    const d = v == null ? now() : new Date(v);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  };
  function record(id, status, at) {
    if (!id || !status) return;
    const cur = states.get(id);
    if (status === "running") {
      // 再開された子は running に戻る。開始時刻は最初の分を残す
      states.set(id, { status, startedAt: cur?.startedAt ?? iso(at), endedAt: null });
    } else {
      states.set(id, { status, startedAt: cur?.startedAt ?? null, endedAt: cur?.status === status && cur.endedAt ? cur.endedAt : iso(at) });
    }
  }

  /** 委譲ツールの結果（前面で待った子の完了）。task 系のメッセージが来ない場合の備え */
  function toolResult(m) {
    const r = m.tool_use_result;
    const blocks = Array.isArray(m.message?.content) ? m.message.content : [];
    if (r && typeof r === "object" && typeof r.agentId === "string" && AGENT_RESULT_DONE.has(r.status)) {
      const cur = states.get(r.agentId);
      // 終わった状態（失敗・停止）を完了で上書きしない
      if (!cur || cur.status === "running") record(r.agentId, "completed", m.timestamp);
      return;
    }
    // 前面の子が失敗で返った（中断など）。どの子かは task_started の tool_use_id でしか引けない
    for (const b of blocks) {
      if (b?.type !== "tool_result" || !b.is_error) continue;
      const id = toolTasks.get(b.tool_use_id);
      if (id && states.get(id)?.status === "running") record(id, "failed", m.timestamp);
    }
  }

  const tasks = () => [...bg.values()].map((t) => ({ ...t }));
  const waitable = () => bg.size > 0;
  const phase = () => (!mainActive && waitable() ? "waiting" : "active");

  function start() {
    mainActive = true;
    pending.clear();     // 取りかかった。流し込んだものは全部 CLI の手の中にある
  }

  function add(id, type, label, ambient) {
    if (!id) return;
    const kind = taskKind(type);
    // 一覧に出さない ambient も「CLI が main を再開しうる」印としては数える（上の注意書き）
    sawWaitable = true;
    if (ambient || bg.has(id)) return;
    // waitable は「終わりの通知が必ず来るので待てる」の印。web はこれで終わりの合図が無い裏の作業と
    // 区別し、待っていることを画面に出す（web/work-status.mjs）
    bg.set(id, { id, kind, label: String(label ?? ""), waitable: true });
  }

  function update(m) {
    if (m.type === "system") {
      switch (m.subtype) {
        case "init":
          if (seenResult) start();
          return;
        case "session_state_changed":
          if (m.state === "running") start();
          else if (m.state === "idle") mainActive = false;
          return;
        case "background_tasks_changed":
          bg.clear();
          for (const t of Array.isArray(m.tasks) ? m.tasks : []) {
            if (!t?.task_id) continue;
            known.set(t.task_id, { type: t.task_type, label: t.description });
            add(t.task_id, t.task_type, t.description, Boolean(t.ambient));
          }
          return;
        case "task_started":
          known.set(m.task_id, { type: m.task_type, label: m.description });
          record(m.task_id, "running");
          if (m.tool_use_id) toolTasks.set(m.tool_use_id, m.task_id);
          if (m.is_backgrounded === true) add(m.task_id, m.task_type, m.description, m.ambient || m.skip_transcript);
          return;
        case "task_updated": {
          const p = m.patch ?? {};
          record(m.task_id, subagentStatus(p.status), p.end_time);
          if (DONE.has(p.status)) bg.delete(m.task_id);
          else if (p.is_backgrounded === true) {
            const k = known.get(m.task_id);
            add(m.task_id, k?.type, p.description ?? k?.label, false);
          }
          return;
        }
        case "task_notification":
          // 完了通知が来た＝CLI はこの後 main を再開する。一度も見ていないタスク（ambient）でも同じ
          sawWaitable = true;
          record(m.task_id, subagentStatus(m.status));
          bg.delete(m.task_id);
          return;
      }
      return;
    }
    if (m.type === "stream_event" && m.parent_tool_use_id == null) {
      const ev = m.event;
      if (ev?.type === "message_start") start();
      else if (ev?.type === "message_delta" && stops(ev.delta?.stop_reason)) mainActive = false;
      return;
    }
    if (m.type === "user" && !m.isReplay) {
      toolResult(m);
      return;
    }
    if (m.type === "result") {
      mainActive = false;
      seenResult = true;
    }
  }

  return {
    /** SDK メッセージ 1 件を取り込み、変化した分の正規化イベントを返す（0〜2 件） */
    observe(m) {
      if (!m || typeof m !== "object") return [];
      update(m);
      const out = [];
      const list = tasks();
      const key = JSON.stringify(list);
      if (key !== lastTasks) {
        lastTasks = key;
        out.push({ type: "background", tasks: list });
      }
      const now = phase();
      if (now !== lastPhase) {
        lastPhase = now;
        out.push({ type: "phase", state: now });
      }
      return out;
    },

    /** 開いた入力へメッセージを 1 件流し込んだ */
    pushed() {
      const token = Symbol("pushed");
      pending.add(token);
      return token;
    },

    /** 入力を閉じてよいか（上の (a)(b)(c)） */
    canCloseInput() {
      return !mainActive && !waitable() && pending.size === 0;
    },

    get phase() { return phase(); },
    get tasks() { return tasks(); },
    get mainActive() { return mainActive; },
    get pending() { return pending.size; },
    /** サブエージェント（task_id = agentId）の状態。分からなければ null */
    subagentState(id) {
      const s = states.get(id);
      return s ? { ...s } : null;
    },
    /** バックグラウンド作業（ambient・完了通知を含む）を一度でも見たか。見たターンでは、閉じる前に main の自動再開を待つ */
    get sawWaitable() { return sawWaitable; },
  };
}

/**
 * query() に渡す入力の列。push したものを順に返し、close() で終わる。
 * close 後の push は受け付けない（false）。
 */
export function createInputQueue() {
  const items = [];
  let wake = null;
  let closed = false;
  const notify = () => { const w = wake; wake = null; w?.(); };
  return {
    push(item) {
      if (closed) return false;
      items.push(item);
      notify();
      return true;
    },
    close() {
      if (closed) return;
      closed = true;
      notify();
    },
    get closed() { return closed; },
    get size() { return items.length; },
    async *[Symbol.asyncIterator]() {
      for (;;) {
        if (items.length) { yield items.shift(); continue; }
        if (closed) return;
        await new Promise((resolve) => { wake = resolve; });
      }
    },
  };
}

// subagent が完了すると、CLI は main を自動で再開させる。実測（2026-09、単発のターン）では
// 0〜80ms だが、混んだセッション（agent teams・長い履歴）では 2.5 秒かかるのを観測した。
// 短すぎると**まだ続くターンの stdin を閉じてしまう**（上の注意書き）。逆に長すぎても、
// 待つのはバックグラウンド作業を使ったターンの末尾だけなので、実害は小さい方に倒す。
export const RESUME_GRACE_MS = 5000;

/**
 * 入力（CLI の stdin）をいつ閉じるかの段取り。
 *
 * 「閉じてよい」（tracker.canCloseInput）が揃ってから、さらに猶予を置いて閉じる。
 * 猶予の間に揃わなくなったら取り消す。**閉じた入力は開き直せない**ので、迷ったら閉じない。
 * 期限は最初に揃った時点から数える（途中で来たメッセージでは伸ばさない。伸ばすと、
 * 何かが定期的に喋り続けるターンで永久に閉じられなくなる）。
 *
 * inflight は「いま host 側で走っていて、答えを CLI へ返さないといけないもの」の数。
 * host ツールの結果も承認の返事も stdin を通るので、0 になるまでは閉じない。
 */
export function createInputCloser({ tracker, close, inflight = () => 0, graceMs = RESUME_GRACE_MS,
  timer = setTimeout, clear = clearTimeout } = {}) {
  let handle = null;
  let closed = false;
  const ready = () => tracker.canCloseInput() && inflight() === 0;
  const cancel = () => { if (handle !== null) { clear(handle); handle = null; } };
  const shut = () => {
    cancel();
    if (closed) return;
    closed = true;
    close();
  };
  return {
    /** SDK メッセージを 1 件見終わるたび、また host 側の応答が終わるたびに呼ぶ */
    settle() {
      if (closed) return;
      if (!ready()) { cancel(); return; }
      if (handle !== null) return;
      handle = timer(() => { handle = null; if (ready()) shut(); }, tracker.sawWaitable ? graceMs : 0);
    },
    /** 中断・後始末。段取りを飛ばして今すぐ閉じる */
    now: shut,
    get closed() { return closed; },
    get armed() { return handle !== null; },
  };
}

/**
 * host ツール（mcp__host__*）と承認の応答を数える。どちらも答えは CLI の stdin を通るので、
 * 走っている間は入力を閉じてはいけない。
 *
 * 閉じた後に終わったものは黙って捨てられる（SDK が捨てる）。せめて気づけるよう log に出す。
 */
export function createHostCalls({ log = console.error, onIdle = null } = {}) {
  let inflight = 0;
  let closed = false;
  let idle = onIdle;
  return {
    get inflight() { return inflight; },
    /** 入力を閉じた。以後の応答は CLI へ届かない */
    markClosed() { closed = true; },
    watch(fn) { idle = fn; },
    async run(label, work) {
      inflight += 1;
      try {
        return await work();
      } finally {
        inflight -= 1;
        if (closed) log(`  [claude] ${label} の結果を CLI へ返せない（入力を閉じた後に終わった）`);
        else if (inflight === 0) idle?.();
      }
    },
  };
}

/**
 * CLI の stderr をサーバのコンソールへ出す関数を作る。行ごとに切り、長い行と行数を抑える。
 * 上限を超えた分は 1 回だけ「省略した」と出して黙る。
 */
export function createStderrLog({ log = console.error, prefix = "  [claude stderr] ", maxLine = 300, maxLines = 40, secrets = [] } = {}) {
  // 会話で選んだアカウントのトークン（core/claude-accounts.mjs）が出力に紛れても記録に残さない。切り詰める前に伏せる
  const hide = (line) => secrets.reduce((s, secret) => secret ? s.split(secret).join("[トークン]") : s, line);
  let count = 0;
  let rest = "";
  return (chunk) => {
    const lines = (rest + String(chunk ?? "")).split(/\r?\n/);
    rest = lines.pop() ?? "";
    if (rest.length > maxLine) { lines.push(rest); rest = ""; }
    for (const raw of lines) {
      const line = hide(raw.trim());
      if (!line) continue;
      count += 1;
      if (count > maxLines) {
        if (count === maxLines + 1) log(`${prefix}（以降の出力は省略）`);
        continue;
      }
      log(prefix + (line.length > maxLine ? line.slice(0, maxLine) + "…" : line));
    }
  };
}
