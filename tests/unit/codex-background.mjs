// Codex のバックグラウンド端末の数え方（core/backends/codex-background.mjs）。
//
// codex は起こさない。通知の形だけを渡して、純粋な部品として測る。
// frame の形は `codex app-server generate-json-schema` が出す JSON Schema に合わせた
// （CommandExecutionThreadItem の processId / source / status、ItemCompletedNotification の turnId、
// TerminalInteractionNotification の itemId / processId）。
import { createTerminalTracker, terminalLabel } from "../../core/backends/codex-background.mjs";

export const name = "codex-background";
export const title = "Codex のバックグラウンド端末を、ターンをまたいで数える";

const THREAD = "01a09d8b-f417-7ce1-abab-8f4cbf938c49";
const CWD = "/repo";

/** CommandExecutionThreadItem。source の既定はスキーマどおり agent。 */
const cmd = (id, command, extra = {}) => ({
  id, type: "commandExecution", command, commandActions: [], cwd: CWD,
  status: "inProgress", source: "agent", processId: null, ...extra,
});

const started = (item, turnId = "tn_1") =>
  ["item/started", { threadId: THREAD, turnId, startedAtMs: Date.now(), item }];

const completed = (item, turnId = "tn_1") =>
  ["item/completed", { threadId: THREAD, turnId, completedAtMs: Date.now(), item }];

const turnDone = (turnId = "tn_1") =>
  ["turn/completed", { threadId: THREAD, turn: { id: turnId, items: [], status: "completed" } }];

const interaction = (itemId, processId, turnId = "tn_1") =>
  ["item/commandExecution/terminalInteraction", { threadId: THREAD, turnId, itemId, processId, stdin: "q\n" }];

const ids = (tracker) => tracker.list().map((x) => x.id).join(",");

export default async function (t) {
  {
    const bg = createTerminalTracker();
    bg.observe(...started(cmd('details', 'python -m http.server 5191', { processId: '5228' })));
    const delta = text => bg.observe('item/commandExecution/outputDelta', { itemId: 'details', delta: text });
    delta('Listening\n');
    bg.endTurn();
    delta('GET /preview.html 200\n');
    const detail = bg.detail('details');
    t.ok('詳細はターン前後の出力・コマンド・作業場所を持つ',
      detail.output === 'Listening\nGET /preview.html 200\n' && detail.command.endsWith('5191') && detail.cwd === CWD);
    t.ok('詳細を読む操作では端末を終了しない', bg.size === 1 && bg.detail('details').status === 'running');
    t.ok('他の端末の詳細を返さない', bg.detail('unknown') === null);
    delta('x'.repeat(70_000));
    t.ok('長時間の出力は末尾64K文字に制限する', bg.detail('details').output.length === 65_536 && bg.detail('details').outputTruncated);
    bg.observe(...interaction('details', 'new-process'));
    t.ok('ターン後に分かったprocessIdでも停止先を更新する', bg.processIdOf('details') === 'new-process');
    bg.observe(...completed(cmd('details', '', { status: 'completed' })));
    t.ok('終了した端末を稼働中として返さない', bg.detail('details') === null);
  }
  // ---- 1. ターンの中で終わったものは裏に残らない
  {
    const bg = createTerminalTracker();
    const item = cmd("call_1", "npm test");
    bg.observe(...started(item));
    bg.observe(...completed({ ...item, status: "completed", exitCode: 0 }));
    const after = bg.observe(...turnDone());
    t.ok("ターンの中で終わったコマンドは裏に回らない", !after.changed && bg.size === 0);
  }

  // ---- 2. ターンをまたいだ端末を数え、遅れて届いた完了で消す
  {
    const bg = createTerminalTracker();
    const dev = cmd("call_dev", "npm run dev", { processId: "pty_1", source: "unifiedExecStartup" });
    const test = cmd("call_test", "npm test");
    bg.observe(...started(dev));
    bg.observe(...started(test));
    bg.observe(...completed({ ...test, status: "completed", exitCode: 0 }));

    const end = bg.observe(...turnDone());
    t.ok("turn/completed の時点で走っている端末だけを裏に回す", end.changed && ids(bg) === "call_dev", ids(bg));
    t.ok("見出しはコマンドそのもの", bg.list()[0].label === "npm run dev", JSON.stringify(bg.list()));
    t.ok("kind は terminal（shell は web が数えないので使えない）", bg.list()[0].kind === "terminal");

    // 数時間後。turnId は終わったターンのまま
    const late = bg.observe(...completed({ ...dev, status: "completed", exitCode: 0, aggregatedOutput: "bye" }, "tn_1"));
    t.ok("遅れて届いた item/completed で一覧から消える", late.changed && bg.size === 0);
    t.ok("終わったアイテムを返す（ツールカードに結果を差し込むため）",
      late.finished?.id === "call_dev" && late.finished.aggregatedOutput === "bye", JSON.stringify(late.finished));
  }

  // ---- 3. processId が後から分かる端末（item/started では null）
  {
    const bg = createTerminalTracker();
    const serve = cmd("call_serve", "python -m http.server");
    bg.observe(...started(serve));
    t.ok("processId も unifiedExec も無いうちは、ターンが終われば裏に回らない",
      !createTerminalTracker().observe(...turnDone()).changed);
    bg.observe(...interaction("call_serve", "pty_9"));
    const end = bg.observe(...turnDone());
    t.ok("terminalInteraction で processId が分かれば裏に回る", end.changed && ids(bg) === "call_serve", ids(bg));
  }

  // ---- 4. 終わったターンのアイテムは、ターンの中で終わったものとして二重に出さない
  {
    const bg = createTerminalTracker();
    const dev = cmd("call_dev", "npm run dev", { processId: "pty_1", source: "unifiedExecStartup" });
    bg.observe(...started(dev));
    bg.observe(...turnDone());
    // 次のターンが始まって、無関係なコマンドが走って終わる
    const other = cmd("call_other", "git status");
    bg.observe(...started(other, "tn_2"));
    const inside = bg.observe(...completed({ ...other, status: "completed" }, "tn_2"));
    t.ok("次のターンの中で終わったコマンドは finished にしない", !inside.changed && !inside.finished);
    t.ok("数えている端末は次のターンをまたいでも残る", ids(bg) === "call_dev", ids(bg));
    const end2 = bg.observe(...turnDone("tn_2"));
    t.ok("2 度目の turn/completed で同じ端末を足し直さない", !end2.changed && bg.size === 1);
  }

  // ---- 5. 中断・エラーで turn/completed が来なかったターン
  {
    const bg = createTerminalTracker();
    const dev = cmd("call_dev", "npm run dev", { processId: "pty_1", source: "unifiedExecStartup" });
    bg.observe(...started(dev));
    t.ok("endTurn() でも裏へ回せる（turn/completed の来ない終わり方）", bg.endTurn() && bg.size === 1);
    t.ok("もう一度呼んでも増えない", !bg.endTurn() && bg.size === 1);
  }

  // ---- 6. thread/backgroundTerminals/list との照合
  {
    const bg = createTerminalTracker();
    const a = cmd("call_a", "npm run dev", { processId: "pty_a", source: "unifiedExecStartup" });
    const b = cmd("call_b", "python -m http.server", { processId: "pty_b", source: "unifiedExecStartup" });
    bg.observe(...started(a));
    bg.observe(...started(b));
    bg.observe(...turnDone());
    t.ok("2 本数えている", bg.size === 2, ids(bg));

    let r = bg.reconcile([{ itemId: "call_a", processId: "pty_a" }]);
    t.ok("照合で、もう居ない端末を引く", r.changed && r.understood && ids(bg) === "call_a", ids(bg));

    r = bg.reconcile([{ processId: "pty_a" }]);
    t.ok("processId だけでも照合できる", !r.changed && ids(bg) === "call_a", ids(bg));

    r = bg.reconcile([{ somethingElse: 1 }]);
    t.ok("形が読めない応答では消さず、understood: false を返す",
      !r.changed && !r.understood && ids(bg) === "call_a", JSON.stringify(r));

    r = bg.reconcile(null);
    t.ok("応答が配列でなければ何もしない", !r.changed && !r.understood && bg.size === 1);

    r = bg.reconcile([]);
    t.ok("空の応答は「1 本も残っていない」。全部引く", r.changed && r.understood && bg.size === 0);
  }

  // ---- 7. app-server が落ちた
  {
    const bg = createTerminalTracker();
    bg.observe(...started(cmd("call_dev", "npm run dev", { processId: "pty_1" })));
    bg.observe(...turnDone());
    t.ok("clear() で全部消える", bg.clear() && bg.size === 0);
    t.ok("空で呼んでも変わったとは言わない", !bg.clear());
  }

  // ---- 8. 見出しの整え方
  t.ok("空のコマンドにも見出しを付ける", terminalLabel("") === "バックグラウンド端末");
  t.ok("改行と連続する空白は 1 つに畳む", terminalLabel("npm  run\n  dev") === "npm run dev");
  t.ok("長いコマンドは切り詰める", terminalLabel("x".repeat(300)).length === 120);
}
