// Codex のバックグラウンド端末（`unified_exec`）を、スレッドごとに数える。
//
// **app-server を import しない**。claude-background.mjs と同じく
// 純粋な部品で、tests/unit/codex-background.mjs から通知の形だけを渡して直接呼べる。
//
// 何が起きるか（issue #6）:
//   - `unified_exec` の端末はターンが終わっても生き続ける（dev サーバ、`python -m http.server` など）
//   - `turn/completed` は端末の終了を待たずに届く
//   - 端末の `item/completed` は**終わったターンの turnId のまま**、数分〜数十時間後に届く
//
// 形は `codex app-server generate-json-schema` が出す JSON Schema で確認した（codex-cli 0.147.0）。
// **推測で足していない**:
//   CommandExecutionThreadItem … { id, type, command, commandActions, cwd, status, processId?, source, exitCode?, aggregatedOutput?, durationMs? }
//   CommandExecutionSource     … agent | userShell | unifiedExecStartup | unifiedExecInteraction
//   CommandExecutionStatus     … inProgress | completed | failed | declined
//   ItemStarted/CompletedNotification … { threadId, turnId, item, startedAtMs / completedAtMs }
//   TerminalInteractionNotification   … { threadId, turnId, itemId, processId, stdin }
//   ThreadActiveFlag           … waitingOnApproval | waitingOnUserInput の 2 つだけ。
//                                「裏で走っている」を表す値は無いので、thread/status/changed では数えられない
//
// 数え方:
//   覚える … `item/started` の commandExecution。`item/commandExecution/terminalInteraction` で
//            processId を後から足す（item/started の時点では null のことがある）
//   足す   … `turn/completed` の時点で終わっていない commandExecution のうち、
//            processId を持つか source が `unifiedExec*` のもの。ターンをまたいで生きる端末はこれだけ
//   引く   … 遅れて届いた `item/completed`（turnId は終わったターンのまま）。
//            reconcile()（`thread/backgroundTerminals/list` との照合）で、取りこぼしたものも引く
//   全部消す … app-server が落ちた・入れ替わった（端末は道連れ）。呼び出し側が clear() する
//
// kind は terminal。AIの結果待ちの衛星とは分け、会話ヘッダーから詳細と停止を提供する。
// ターンの完了とは独立に追跡する。出力は端末ごとに末尾64K文字を保持し、詳細を開いた時だけ返す。

const LABEL_MAX = 120;
const OUTPUT_MAX = 64 * 1024;

function appendOutput(item, text) {
  const output = (item.aggregatedOutput ?? '') + text;
  item.outputTruncated = item.outputTruncated || output.length > OUTPUT_MAX;
  item.aggregatedOutput = output.slice(-OUTPUT_MAX);
}

/** ターンをまたいで生き続けうる commandExecution か。 */
const isTerminal = (item) =>
  Boolean(item?.processId) || String(item?.source ?? "").startsWith("unifiedExec");

/** 端末の見出し。コマンドをそのまま出す（`npm run dev` / `python -m http.server`）。 */
export function terminalLabel(command) {
  const s = String(command ?? "").replace(/\s+/g, " ").trim();
  if (!s) return "バックグラウンド端末";
  return s.length > LABEL_MAX ? `${s.slice(0, LABEL_MAX - 1)}…` : s;
}

/** 走っていない状態。declined も「始まらなかった」なので終わり扱い。 */
const DONE = new Set(["completed", "failed", "declined"]);

/**
 * 1 スレッド分の追跡器。runTurn の attach / detach とは独立に、全部の通知を見る。
 * observe() は「一覧が変わったか」と「裏で終わったアイテム」を返す。
 */
export function createTerminalTracker() {
  const live = new Map();   // itemId -> ThreadItem（このターンで走っている commandExecution）
  const bg = new Map();     // itemId -> { id, command, processId }（ターンをまたいだ端末）

  const list = () => [...bg.values()].map((x) => ({
    id: x.id, kind: "terminal", label: terminalLabel(x.command),
  }));

  function promote() {
    let changed = false;
    for (const [id, item] of live) {
      if (!isTerminal(item) || bg.has(id)) continue;
      bg.set(id, { ...item });
      changed = true;
    }
    // 終わったターンのアイテムは持ち越さない。裏に回ったものは bg が持っている
    live.clear();
    return changed;
  }

  function observe(method, params) {
    const none = { changed: false, finished: null };
    const item = params?.item;

    switch (method) {
      case "item/started":
        if (item?.type === "commandExecution" && item.id) {
          const tracked = { ...item, startedAtMs: params.startedAtMs ?? null, aggregatedOutput: '' };
          appendOutput(tracked, item.aggregatedOutput ?? '');
          live.set(item.id, tracked);
        }
        return none;

      case "item/commandExecution/outputDelta": {
        const tracked = bg.get(params?.itemId) ?? live.get(params?.itemId);
        if (tracked && typeof params.delta === 'string') appendOutput(tracked, params.delta);
        return none;
      }

      // 端末への書き込み。item/started が processId を持たなかった分をここで補う
      case "item/commandExecution/terminalInteraction": {
        const id = params?.itemId;
        const known = id ? bg.get(id) ?? live.get(id) : null;
        if (known && params?.processId) known.processId = params.processId;
        return none;
      }

      case "item/completed": {
        if (item?.type !== "commandExecution" || !item.id) return none;
        live.delete(item.id);
        if (!bg.has(item.id)) return none;          // ターンの中で終わった。runTurn 側が結果を出す
        bg.delete(item.id);
        // 裏で終わった。呼び出し側がツールカードに結果を反映する
        return { changed: true, finished: item };
      }

      case "turn/completed":
        return { changed: promote(), finished: null };

      default:
        return none;
    }
  }

  return {
    observe,
    list,
    detail(id) {
      const item = bg.get(id);
      return item ? {
        id, kind: 'terminal', command: item.command ?? '', cwd: item.cwd ?? '',
        output: item.aggregatedOutput ?? '', outputTruncated: Boolean(item.outputTruncated),
        startedAtMs: item.startedAtMs, status: 'running',
      } : null;
    },

    /**
     * ターンが終わった。走ったままの端末を裏へ回す。
     * `turn/completed` が来ない終わり方（error 通知・中断）でも呼び出し側が閉じられるように出しておく。
     * 何度呼んでも足し直さない。
     */
    endTurn: promote,

    /**
     * `thread/backgroundTerminals/list` の `data`（全ページ分）と突き合わせる。取りこぼした終了を引く。
     *
     * 入れ物が `{ data, nextCursor }` であることは実機で確かめたが（codex-cli 0.154.0-alpha.6.2）、
     * **要素の形はまだ分かっていない**（端末を 1 本起こすには実ターンが要る）。
     * そこで各要素から `itemId` / `id` / `processId` を拾い、**1 つも拾えなければ何もしない**
     * （間違って印を消す方が、消し忘れるより悪い）。understood が偽なら呼び出し側が形を報告する。
     */
    reconcile(entries) {
      if (!Array.isArray(entries)) return { changed: false, understood: false };
      const alive = new Set();
      for (const e of entries) {
        if (!e || typeof e !== "object") continue;
        for (const key of [e.itemId, e.id, e.processId]) if (typeof key === "string" && key) alive.add(key);
      }
      // 空でない応答から 1 つも id を拾えなかった = 形が違う。消さずに諦める
      if (entries.length && !alive.size) return { changed: false, understood: false };

      let changed = false;
      for (const [id, x] of [...bg]) {
        if (alive.has(id) || (x.processId && alive.has(x.processId))) continue;
        bg.delete(id);
        changed = true;
      }
      return { changed, understood: true };
    },

    /** 全部消す。消したものがあれば true。 */
    clear() {
      live.clear();
      if (!bg.size) return false;
      bg.clear();
      return true;
    },

    get size() { return bg.size; },
    /** そのアイテムを裏の端末として数えているか（遅れた item/completed の見分けに使う） */
    has(id) { return bg.has(id); },
    /**
     * itemId -> processId。止めるときに使う（codex が求めるのは itemId ではなく processId）。
     * 分からなければ null。`item/started` に無くても terminalInteraction で補えていることがある。
     */
    processIdOf(id) { return bg.get(id)?.processId ?? null; },
  };
}
