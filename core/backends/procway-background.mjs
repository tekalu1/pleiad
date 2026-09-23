// procway の裏の作業（バックグラウンドの子エージェント）を、serve のイベントから数える。
//
// serve には「裏で動いている job の一覧」を返すコマンドもイベントも無い
// （output/bg-tasks/procway-report.md §2）。だから間接的な印から推し量る。
// WS にも procway にも依存しない純粋な部品（tests/unit/procway-background.mjs）。
//
//   足す     … tool.call.completed の spawn_agent 結果で data.background === true のもの
//              （id は data.jobId、見出しは data.task）
//   引く     … agent_job の結果: status / wait が running 以外を返した・jobId が見つからない、kill した、
//              list に running として載っていない
//              wake ターンの本文（`- child agent <jobId> — <status>` の行）。**文面は procway の内部仕様で
//              契約ではない**ので、読めなくても壊れないようにする（読めたものだけ引く）
//   全部消す … serve が終わった・入れ替わった（走っていた job は失われ、settle も wake も来ない）。呼び出し側が clear() する
//
// 裏のシェル（run_shell の runInBackground）は数えない。終わったことを知らせる信号が serve に無く
// （shell_job で見に行ったときにしか分からない）、主な用途が dev サーバのような終わらないものなので、
// 数えると印が消えなくなる。Claude も shell は「裏を待っている」に数えない（claude-background.mjs）。

const LABEL_MAX = 120;

/** user.prompt.submitted の content（ContentBlock[]）から本文だけを取り出す。 */
export function promptText(content) {
  return (Array.isArray(content) ? content : [])
    .filter((b) => b?.kind === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("\n");
}

/**
 * wake ターンの本文から、settle した子の jobId と status を拾う。拾えなければ空の配列。
 * procway の今の文面は `- child agent <jobId> — <status>`（ai-agent/src/agent/wake-supervisor.mjs の
 * describeAgentItem）。ダッシュの種類と空白の数には寛容にしておく。
 */
export function settledFromWake(text) {
  const out = [];
  for (const m of String(text ?? "").matchAll(/child agent\s+(\S+)\s+[—–-]+\s+([A-Za-z][\w-]*)/g)) {
    out.push({ jobId: m[1], status: m[2] });
  }
  return out;
}

function label(task) {
  const s = String(task ?? "").replace(/\s+/g, " ").trim();
  if (!s) return "サブエージェント";
  return s.length > LABEL_MAX ? `${s.slice(0, LABEL_MAX - 1)}…` : s;
}

export function createBackgroundTracker() {
  const tasks = new Map();   // jobId -> { id, kind: "agent", label }
  const drop = (id) => tasks.delete(String(id));

  function applyResult(result) {
    if (result?.kind !== "spawn_agent") return false;
    const d = result.data;
    if (!d || typeof d !== "object") return false;
    const id = typeof d.jobId === "string" && d.jobId ? d.jobId : null;

    if (d.background === true && id) {
      if (typeof d.status === "string" && d.status !== "running") return false;
      tasks.set(id, { id, kind: "agent", label: label(d.task) });
      return true;
    }
    if (d.tool === "agent_kill" && id) return drop(id);
    if ((d.tool === "agent_wait" || d.tool === "agent_status") && id) {
      // 承認で撥ねられた呼び出し（makeSkippedResult）は status も error も持たない。何も分からないので触らない。
      // wait の時間切れは status: running のまま返る
      if (d.error || (typeof d.status === "string" && d.status !== "running")) return drop(id);
      return false;
    }
    if (d.tool === "agent_list" && Array.isArray(d.jobs)) {
      // list はこの会話の job を settle 済みも含めて返す（終端から 30 分で消える）。
      // 載っていない＝もう居ない、running 以外＝終わった
      let changed = false;
      for (const known of [...tasks.keys()]) {
        const job = d.jobs.find((j) => j?.jobId === known);
        if (!job || job.status !== "running") changed = drop(known) || changed;
      }
      return changed;
    }
    return false;
  }

  function applyWake(content) {
    const settled = settledFromWake(promptText(content));
    let changed = false;
    for (const s of settled) changed = drop(s.jobId) || changed;
    // 文面が読めなかった。wake は「この会話の、wake 印の付いた job が settle した」ときにしか来ず、
    // その印が付くのはバックグラウンドの子だけ（Pleiad は run の wake を送らない）。
    // 1 本しか数えていなければ、終わったのはそれ
    if (!settled.length && tasks.size === 1) {
      tasks.clear();
      changed = true;
    }
    return changed;
  }

  return {
    /** serve のイベントを 1 つ見る。一覧が変わったら true。 */
    apply(ev) {
      if (ev?.type === "tool.call.completed") return applyResult(ev.result);
      if (ev?.type === "user.prompt.submitted" && ev.wake === true) return applyWake(ev.content);
      return false;
    },
    /** 全部消す。消したものがあれば true。 */
    clear() {
      if (!tasks.size) return false;
      tasks.clear();
      return true;
    },
    /** 正規化イベント background の tasks と同じ形。 */
    list() {
      return [...tasks.values()].map(({ id, kind, label: l }) => ({ id, kind, label: l }));
    },
    get size() { return tasks.size; },
  };
}
