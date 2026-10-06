// テスト用のバックエンド。LLM もネットワークも使わない。
//
// これがあると core/server.mjs 全体（コマンドの往復・承認の保留・実行中一覧・履歴）を
// **数秒で・使用量ゼロで**テストできる。v1 では unit テストが「core/ を読み込まない」
// ことで SDK を避けていたので、server.mjs のロジックは e2e（本物の LLM）でしか触れなかった。
//
// セッションはプロセス内のメモリだけに持つ。サーバを落とせば消えるが、
// テストは1プロセスの寿命の中で完結するので足りる。
//
// 台本は prompt の先頭で選ぶ:
//   "echo:<文字>"  … text.delta を数回 -> turnResult
//   "tool"         … tool.start / tool.result を挟む
//   "ask"          … askPermission（kind:"tool"）を呼び、結果を本文にする
//   "ask-slow"     … "ask" の後、中断されるまで走り続ける（承認の前後で状態が変わるのを測る）
//   "question"     … askPermission（kind:"question"）を呼び、回答を本文にする
//   "slow"         … 中断されるまで待つ
//   "fail"         … 失敗で終わる（outcome: error。離れた端末への「失敗」の通知を測る）
//   "limit <resetsAt>" … 指定時刻に解ける使用量の上限（ISO または Unix ミリ秒）
//   "whoami"       … 渡されたアカウントのトークン（oauthToken）の指紋を本文にする。無ければ account:none
//   "context:<json>" … ply_context（contextRuntime）のツールを { name, arguments } で 1 回呼び、返りを本文にする
//   "computer:<json>" … ply_computer（computerRuntime）のツールを { name, arguments }（配列なら順に）呼び、返りを本文にする。tool.result には印の行から作った images と computer を付ける
//   "computer-hold:<json>" … "computer:" の後、中断されるまで走り続ける（ロックを持ったままのターン）。"computer-instructions" は ply_computer の指示文を返す
//   "browser:<json>" … ply_browser（browserRuntime。内蔵ブラウザーのプロフィール）のツールを { name, arguments }（配列なら順に）呼び、返りを本文にする。
//                     渡っていなければ "browser: unavailable"。"browser-instructions" は渡った内蔵ブラウザーの指示文を返す
//   "control:<json>" … ply_control（controlRuntime。Pleiad の操作の一覧）のツールを { name, arguments }（配列なら順に）呼び、返りを本文にする。渡っていなければ "control: unavailable"。
//                     "control-info" は渡った接続の url・指示文・会話のシェルへ渡す環境変数の名前とトークンを JSON で返す
//   "compact"      … 文脈の圧縮（Claude の activity compacting と同じ形）を流す
//   "bg-shell <本文>" … 本文で返答した後、終わらない裏のコマンド（Claude の local_bash）を抱えて phase: waiting で待つ。
//                    stopBackground で止めると main が再開して一言返し、ターンが終わる
//   "term <本文>"  … 本文で返答して終わり、ターンの外に端末（Codex の unified_exec と同じ kind: terminal）を残す
//   "hook-follow <本文>" … 本文で返答した後、Stop フックに止められて続けた形（ToolSearch と load_skill を呼んで「ナレッジ化対象なし」）。
//                    続きの発言には Claude の履歴と同じ stopHookFollowUp を付ける
//   "steps:<json>" または "steps:@<json ファイルの絶対パス>" … ツールと本文を台本どおりに並べる。{"steps":[{"tool":"Grep","input":{…},"result":"…","error":false,"ms":600,"ask":false},{"text":"…"}]}
//                    ms は結果を返すまでの時間、ask はツールを始めたあと承認（kind:"tool"）を待つ（computerApp を添えるとアプリの承認）、images・computer は ply_computer の結果の画像と印、text は本文を書く（前のツールは同じ発言に入る）、newMessage は発言の切れ目（text.end）だけを出す
//   "bg <本数> gate:<名前>" … "bg" の時間指定の代わりに、ゲート（下の「ゲート」）が開いたときに裏の子が順に終わる（実時間で待たない）
//   "notes:" / "instructions:" … Pleiad が足した notes（記憶・末尾）／ botInstructions（人格）を JSON で返す（bot の会話の検査用）
//   それ以外        … prompt をそのまま echo
// 行頭の <pleiad-channel> などの包み（bot の会話。core/system-messages.mjs の splitLeadingNotes）は外してから台本を選ぶ（scriptOf）。
// 環境変数: AGENT_HOST_FAKE_USAGE=1 … ターンの終わりに固定の usage を流す／AGENT_HOST_FAKE_SLOW_STEER=1 … "slow" が途中送信を受ける／
//   AGENT_HOST_FAKE_QUOTA=<JSON のファイル> … 使用枠（usage()。{ windows: [{ label, usedPercent, resetsAt, minutes }] }）を毎回そのファイルから読む。
//   指定が無いと usage() を持たない（使用量の上限の再開が、解除時刻の分からない上限の空きを確かめる検査用）
//
// ゲート（実時間でなく、テストが終わりを決める待ち。server は別プロセスなので、実体は AGENT_HOST_FAKE_GATE_DIR のディレクトリのファイル）:
//   <dir>/<名前> が在れば開いている。テストが作る（tests/lib/fake-gate.mjs の open）。"bg <本数> gate:<名前>" と途中送信の本文の "HOLD_CONFIRM:<名前>" が待つ。
//   fake は読むだけで、ファイルを書かない。ゲートを待っている間に中断されたら、開かないままでも抜ける
//   AGENT_HOST_FAKE_GATE_DIR が無いのにゲートを使うと、黙って固まらずにエラーにする
//   fake からテストへの合図は server の標準出力の 1 行（SIGNAL_PREFIX + 名前。テストは startServer の tail で待つ）。途中送信を DECLINE_STEER で受理しなかったとき steer-declined を出す
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { undelivered } from "./undelivered.mjs";
import { computerDisplay, computerToolInput } from "../computer-use/display.mjs";

const sessions = new Map();   // sessionId -> { sessionId, title, cwd, createdAt, lastModified, tag, messages, subagents }
const auth = { loggedIn: false, account: null };
// 台本 "bg-shell" の止め口（Pleiad の会話 id -> taskId -> 止める関数）と、台本 "term" が残した端末（会話 id -> 端末の一覧）
const shells = new Map();
const terminals = new Map();
let host = null;   // attachHost で受け取る server の口（ターンの外の background）

const now = () => Date.now();
const iso = () => new Date().toISOString();
const wait = (ms) => new Promise((r) => setTimeout(r, ms).unref?.());

const GATE_DIR = process.env.AGENT_HOST_FAKE_GATE_DIR || null;
const GATE_POLL_MS = 20;
const gateFile = (name) => {
  if (!GATE_DIR) throw new Error("fake: AGENT_HOST_FAKE_GATE_DIR is not set");
  if (!/^[\w.-]+$/.test(name)) throw new Error(`fake: bad gate name: ${name}`);
  return path.join(GATE_DIR, name);
};
/** ゲートが開くのを待ち、開いたら onOpen を 1 回呼ぶ。待つのをやめる関数を返す */
function watchGate(name, onOpen) {
  const file = gateFile(name);
  if (fs.existsSync(file)) { onOpen(); return () => {}; }
  const timer = setInterval(() => { if (fs.existsSync(file)) { clearInterval(timer); onOpen(); } }, GATE_POLL_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}
/** ゲートが開くか aborted が解けるまで待つ */
const gateWait = (name, aborted) => new Promise((resolve) => {
  const stop = watchGate(name, resolve);
  aborted?.then(() => { stop(); resolve(); });
});
/** テストへの合図。server の標準出力に 1 行出すだけ（startServer が直近の行を持つ）。ファイルは書かない */
const SIGNAL_PREFIX = "fake-signal: ";
const announce = (name) => console.log(`  ${SIGNAL_PREFIX}${name}`);

const MODES = {
  default: { label: "都度確認", short: "都度", note: "全部聞く",     scope: "workspace", autonomy: "ask",   enforced: false },
  auto:    { label: "auto",     note: "聞かずに進む", scope: "workspace", autonomy: "never", enforced: false },
  // 操作の一覧の権限（ADR 0082）を会話の承認モードごとに確かめる。読み取り専用と、確認なし・制限なし（Claude の bypass 相当）
  plan:    { label: "plan",     note: "読むだけ",     scope: "readonly",  autonomy: "ask",   enforced: false },
  bypass:  { label: "bypass",   note: "全部通す",     scope: "full",      autonomy: "never", enforced: false },
};

// 画面の確かめ用に、本物と同じ形（版付きの名前・モデルごとの段と既定・既定がどれに当たるか）を持たせる。
// tiny は段を選べないモデル（Claude の Haiku に当たる）
const MODELS = {
  "":     { label: "既定に従う", note: "テスト用の既定", resolvesTo: "smart", efforts: ["low", "medium", "high"], defaultEffort: "medium" },
  fast:   { label: "Fast 2.1",  note: "速い", efforts: ["low", "medium", "high"], defaultEffort: "low" },
  smart:  { label: "Smart 3.5", note: "賢い", efforts: ["low", "medium", "high"], defaultEffort: "medium" },
  tiny:   { label: "Tiny 1.0",  note: "軽い。段を選べない", efforts: [], defaultEffort: null },
};

const TOOL_HINTS = {
  fake_shell: { label: "実行", shape: "shell" },
  fake_write: { label: "書く", shape: "write" },
};

function ensure(sessionId, cwd) {
  let s = sessions.get(sessionId);
  if (!s) {
    s = { sessionId, title: null, cwd: cwd ?? null, createdAt: iso(), lastModified: now(), tag: null, messages: [], subagents: [] };
    sessions.set(sessionId, s);
  }
  if (cwd && !s.cwd) s.cwd = cwd;
  return s;
}

function push(s, msg) {
  const m = { uuid: crypto.randomUUID(), at: iso(), ...msg };
  s.messages.push(m);
  s.lastModified = now();
  return m;
}

/** 本文を数回に分けて流す。ライブ表示（text.delta の積み上げ）を実際に通す。 */
async function say(emit, text, uuid) {
  emit({ type: "activity", state: "writing" });
  const chunks = String(text).match(/[\s\S]{1,8}/g) ?? [];
  for (const c of chunks) {
    emit({ type: "text.delta", text: c });
    await wait(1);
  }
  emit({ type: "text.end", ...(uuid ? { uuid } : {}) });
}

// main が途中送信を受けてから本文を返すまで（phase: active の間）。テストでこの間に次の送信を重ねるときに延ばす
const STEER_LATENCY_MS = Number(process.env.AGENT_HOST_FAKE_STEER_LATENCY_MS) || 300;
// 途中送信を「受理」してから「渡った」までの間を作る（ミリ秒）。指定したときだけ steerConfirms を立て、
// 本物（claude / codex）と同じ pending → userMessage.delivered の順で流す。画面の確認とテスト用
const STEER_CONFIRM_MS = Number(process.env.AGENT_HOST_FAKE_STEER_CONFIRM_MS) || 0;
// 1 のとき、台本 "slow" のターンも途中送信（control.steer）を受ける（bot への書き足しの検査用。既存のテストの挙動を変えないため既定は受けない）
const SLOW_STEER = process.env.AGENT_HOST_FAKE_SLOW_STEER === "1";
// 1 のとき、ターンの終わりに固定の usage（入力 1000・出力 200・キャッシュ読み出し 900）を流す。既存のテストの usage.json を変えないため既定は流さない
const FAKE_USAGE = process.env.AGENT_HOST_FAKE_USAGE === "1";
// 心拍の安いモデルの台本（core/brain/pulse.mjs が聞く <pleiad-pulse> の返事）。ファイルは毎回読み直す（確かめる側が途中で差し替えられる）
let pulseCalls = 0;
function nextPulseAnswer() {
  let list = [];
  try { list = JSON.parse(fs.readFileSync(process.env.AGENT_HOST_FAKE_PULSE ?? '', 'utf8')); } catch { /* 台本が無ければ何もしない返事 */ }
  const answer = Array.isArray(list) && list.length ? list[Math.min(pulseCalls, list.length - 1)] : { do: 'none' };
  pulseCalls++;
  return typeof answer === 'string' ? answer : JSON.stringify(answer);
}

// bot の会話の user の行の先頭に付く包み（core/system-messages.mjs の LEADING_TAGS と同じ）。台本の接頭辞はこれを外してから判定する。
// <pleiad-channel> は中身が発言なので、@名前 の呼びかけを除いて台本として読む（"@Owl echo:やった"）。記憶・スレッドの履歴・中断の文は台本ではない
const LEADING_WRAPPER = /^\s*<(pleiad-interruption|pleiad-memory-core|pleiad-bot-recent|pleiad-turn-context|pleiad-inner|pleiad-channel-thread|pleiad-channel)(?=[\s>])[^>]*>([\s\S]*?)<\/\1>\s*/;
// 聞こえただけの投稿（heard="true"。ADR 0128）は、台本が "chime:<文字>" なら echo のように話し、ほかは黙る（文章なしで終える）
export function scriptOf(prompt) {
  let rest = String(prompt ?? "");
  let said = null;
  let heard = false;
  for (let hit; (hit = LEADING_WRAPPER.exec(rest));) {
    rest = rest.slice(hit[0].length);
    if (hit[1] === "pleiad-channel") { said = hit[2]; heard = /^<pleiad-channel\b[^>]*\sheard="true"/.test(hit[0]); }
    // 心拍から自分で起きたターン（ADR 0126）: 本文の「理由: …」を台本にする（"echo:こんにちは" なら話す。何も無ければ黙る）
    // 予約した時刻に起きたターン（kind="wake"。ADR 0136）: 最初の予約のメモを台本にする
    else if (hit[1] === "pleiad-inner") { const why = /(?:理由|Reason|予約のメモ|Note of the reservation for [^:]*): (.*)/.exec(hit[2])?.[1]; if (why) said = why; }
  }
  const script = rest.trim() || (said ?? "").replace(/^\s*(?:@\S+\s+)+/, "").trim();
  if (heard && !rest.trim()) return script.startsWith("chime-steps:") ? `steps:${script.slice(12)}` : script.startsWith("chime:") ? `echo:${script.slice(6)}` : "echo:";
  return script;
}

/**
 * 台本 "bg [本数] [秒]"。Claude のバックグラウンド subagent と同じ形のイベントを流す（docs/multi-backend.md §2.2）。
 * main は先に返答し、phase: waiting で裏の完了を待つ。完了ごとに main が再開して一言返す。
 * 秒の代わりに "gate:<名前>" を書くと、時間でなくゲートが開いたときに（開くまでの間の途中送信には答えながら）本数ぶんが順に終わる。
 * 待っている間の途中送信（control.steer）には、main がその場で答える。
 * 中断されたら true（呼び出し側はそこで終わる）。
 */
async function background(text, { s, out, emit, signal, control }) {
  const [, nArg, secArg] = text.split(/\s+/);
  const n = Math.max(1, Math.min(5, Math.floor(Number(nArg)) || 2));
  const gate = /^gate:(.+)$/.exec(secArg ?? "")?.[1] ?? null;
  const total = gate ? 0 : Math.max(0.2, Number(secArg) || 6) * 1000;
  const live = Array.from({ length: n }, (_, i) => ({ id: `fake-task-${i + 1}`, kind: "agent", label: `サブエージェント ${i + 1}` }));
  // Claude と同じく、委譲ツールを呼んでからサブエージェントが生まれる。server は見出しを tool_use id で引く
  for (const x of live) {
    const call = crypto.randomUUID();
    emit({ type: "tool.start", id: call, name: "Agent", input: { description: x.label } });
    // status / startedAt / endedAt は getSubagentState が返す（Claude は SDK の task_* から取る）
    x.agent = { id: `fake-agent-${crypto.randomUUID().slice(0, 8)}`, toolUseId: call,
      status: "running", startedAt: iso(), endedAt: null,
      messages: [{ uuid: crypto.randomUUID(), role: "assistant", text: `${x.label} を始めた`, at: iso() }] };
    s.subagents.push(x.agent);
    emit({ type: "tool.result", id: call, text: "裏で始めた", isError: false, truncated: false });
  }
  const inbox = [];
  let wake = null;
  let done = false;
  const poke = () => { const w = wake; wake = null; w?.(); };
  const aborted = new Promise((resolve) => {
    if (signal?.signal?.aborted) return resolve();
    signal?.signal?.addEventListener?.("abort", () => { resolve(); poke(); }, { once: true });
  });
  if (control) {
    // 受け取るのは outbox の item（{ id, args }）。既定では steerConfirms を立てない＝受理した時点で
    // 渡ったものとして扱う（画面に「まだ渡っていない」の一言を出さない）
    if (STEER_CONFIRM_MS) control.steerConfirms = true;
    control.steer = async (item) => {
      if (done || signal?.signal?.aborted) return false;
      // テスト用: 完了通知（core/server.mjs の steerNotice。id が task-notice-）と追加指示（steerInstruction。id が task-send-）の
      // 本文に DECLINE_STEER があれば受理しない（Claude が入力を閉じた終わり際のように、受理できずに空いてからの新しいターンへ回る形）。
      // THROW_STEER なら例外（結果不明）
      if (/^task-(notice|send)-/.test(String(item?.id ?? "")) && String(item?.args?.prompt ?? "").includes("DECLINE_STEER")) { announce("steer-declined"); return false; }
      if (String(item?.id ?? "").startsWith("task-send-") && String(item?.args?.prompt ?? "").includes("THROW_STEER")) throw new Error("steer failed");
      inbox.push({ id: item?.id ?? null, text: String(item?.args?.prompt ?? "") });
      poke();
      return true;
    };
    control.onReady?.();
  }
  // turnResult は出さない。claude と同じく、ターン（query）の終わりに 1 回だけ（runTurn の最後）
  const reply = async (said) => {
    const m = { uuid: crypto.randomUUID(), role: "assistant", text: said };
    await say(emit, m.text, m.uuid);
    push(s, m);
  };

  let gateOpen = !gate;
  const stopGate = gate ? watchGate(gate, () => { gateOpen = true; poke(); }) : () => {};
  const shown = () => live.map(({ agent, ...x }) => ({ ...x }));
  emit({ type: "background", tasks: shown() });
  await reply(`裏で ${n} 本を動かした`);
  const started = Date.now();
  let finished = 0;
  emit({ type: "phase", state: "waiting" });
  try {
    while (live.length) {
      if (signal?.signal?.aborted) {
        for (const x of live) Object.assign(x.agent, { status: "stopped", endedAt: iso() });
        emit({ type: "turnResult", outcome: "aborted" });
        return true;
      }
      if (inbox.length) {
        const { id: steeredId, text: said } = inbox.shift();
        if (STEER_CONFIRM_MS) {
          // 本文の HOLD_CONFIRM:<ゲート> は、ゲートが開くまで「渡った」を出さない（受理してから渡るまでの間を、テストが好きなだけ見られる）。名前が不正ならエラー
          const hold = /(?:^|\s)HOLD_CONFIRM:(\S+)/.exec(said)?.[1];
          if (hold) await gateWait(hold, aborted);
          await Promise.race([wait(STEER_CONFIRM_MS), aborted]);
          if (signal?.signal?.aborted) continue;
          // テスト用: 本文の DROP_STEER は読まれずに捨てられた合図（userMessage.dropped）、SILENT_STEER は合図を出さず読みもしない
          if (said.includes("DROP_STEER")) { emit({ type: "userMessage.dropped", messageId: steeredId }); continue; }
          if (said.includes("SILENT_STEER")) continue;
          emit({ type: "userMessage.delivered", messageId: steeredId });
        }
        push(s, { role: "user", text: said });
        emit({ type: "phase", state: "active" });
        emit({ type: "activity", state: "thinking" });
        // 本物は受け取ってから本文が出るまで 1 秒近くかかる。すぐ返すと、server が送信済み（userMessage）を
        // 配るより先に本文が流れ、画面で順序が入れ替わる
        await wait(STEER_LATENCY_MS);
        await reply(`受け取った: ${said}`);
        emit({ type: "phase", state: "waiting" });
        continue;
      }
      if (!gateOpen) {
        await Promise.race([new Promise((resolve) => { wake = resolve; }), aborted]);
        continue;
      }
      const left = started + total * (finished + 1) / n - Date.now();
      if (left > 0) {
        await Promise.race([wait(left), new Promise((resolve) => { wake = resolve; }), aborted]);
        continue;
      }
      const task = live.shift();
      finished += 1;
      Object.assign(task.agent, { status: "completed", endedAt: iso() });
      emit({ type: "background", tasks: shown() });
      emit({ type: "phase", state: "active" });
      emit({ type: "activity", state: "thinking" });
      await reply(`${task.label} が終わった`);
      if (live.length) emit({ type: "phase", state: "waiting" });
    }
  } finally {
    done = true;
    stopGate();
  }
  // 発言は都度履歴に積んだ。runTurn の最後で二重に積まないよう空にしておく
  out.text = "";
  out.toolCalls = null;
  return false;
}

/**
 * 台本 "bg-shell <本文>"。Claude で、裏へ回ったコマンドが終わらないまま main が返答を終えた形
 * （local_bash の完了通知が来ないので、入力を閉じられずターンが続く）。本文で返答し、phase: waiting で待つ。
 * stopBackground（Query.stopTask に当たる）で止めると、完了通知で main が再開して一言返し、ターンが終わる。
 * "active-shell" は報告せず、main が結果を待っている形（phase: active）。
 * 中断されたら true。
 */
async function hangingShell(text, { s, out, emit, signal, keys }) {
  const reported = !text.startsWith("active-shell");
  const task = { id: `fake-shell-${crypto.randomUUID().slice(0, 8)}`, kind: "shell", label: "cat >> /dev/null", waitable: true };
  let stopped = false, wake = null;
  const poke = () => { const w = wake; wake = null; w?.(); };
  const stop = () => { stopped = true; poke(); };
  for (const key of keys) { if (!shells.has(key)) shells.set(key, new Map()); shells.get(key).set(task.id, stop); }
  signal?.signal?.addEventListener?.("abort", poke, { once: true });
  try {
    emit({ type: "tool.start", id: task.id, name: "Bash", input: { command: task.label, run_in_background: true } });
    emit({ type: "tool.result", id: task.id, text: "launched", commandBackground: true, nativeTaskId: task.id });
    emit({ type: "background", tasks: [task] });
    if (reported) {
      const report = { uuid: crypto.randomUUID(), role: "assistant", text: text.replace(/^bg-shell\s*/, "") || "終わった" };
      await say(emit, report.text, report.uuid);
      push(s, report);
      emit({ type: "phase", state: "waiting" });
    } else emit({ type: "phase", state: "active" });
    while (!stopped && !signal?.signal?.aborted) await new Promise((resolve) => { wake = resolve; });
    if (signal?.signal?.aborted) { emit({ type: "turnResult", outcome: "aborted" }); return true; }
    emit({ type: "background", tasks: [] });
    emit({ type: "phase", state: "active" });
    const resumed = { uuid: crypto.randomUUID(), role: "assistant", text: "裏のコマンドが止められた" };
    await say(emit, resumed.text, resumed.uuid);
    push(s, resumed);
  } finally {
    emit({ type: "task.command", id: task.id, state: "stopped" });
    for (const key of keys) { shells.get(key)?.delete(task.id); if (!shells.get(key)?.size) shells.delete(key); }
  }
  out.text = "";
  out.toolCalls = null;
  return false;
}

export const backend = {
  id: "fake",
  label: "Fake (test)",
  description: "テスト用のダミー。LLM は呼ばない",
  ...(process.env.AGENT_HOST_FAKE_QUOTA ? { async usage() {
    try { return JSON.parse(fs.readFileSync(process.env.AGENT_HOST_FAKE_QUOTA, 'utf8')); } catch { return { windows: [], message: 'no quota file' }; }
  } } : {}),

  // 出し分けの経路を全部通せるように、hostTools 以外は持てることにする。
  // hostTools だけ false なのは、AI 側から present / set_status を呼ぶ口が無い
  // バックエンド（codex）と同じ形を、テストでも踏むため。
  capabilities: {
    compact: true,
    title: true,
    tag: true,
    fork: true,
    forkMessage: true,
    // 同じ会話での巻き戻し（core/conversations.mjs の rewind）。FAKE_REWIND で形を切り替える:
    //   resumeAt（既定）… Claude と同じ。次のターンが drops の手前で切る / reject … 次のターンが拒否する（ホスト管理へ落とす経路） /
    //   thread … Codex と同じ。rewind() が今すぐ切る / off … 巻き戻す口が無い（Antigravity と同じ。ホスト管理）
    get rewind() { const v = process.env.FAKE_REWIND; return v === 'off' ? undefined : v === 'thread' ? 'thread' : 'resumeAt'; },
    subagents: true,
    liveModel: true,
    liveMode: true,
    hostTools: false,
    plyAgents: true,
    alwaysAllow: true,
    login: true,
    // Claude と同じく会話ごとのアカウントを受け取れることにする（server の配線と画面をテストで通すため）
    claudeAccounts: true,
    // 入力欄の `!` は Claude と同じく Pleiad がホストで走らせる。渡した行は発言として履歴に残す（Claude の transcript と同じ形）
    shell: 'host',
    // ply_computer の渡し方（テストが環境変数で切り替える。FAKE_COMPUTER_USE=off で対応しない）
    get computerUse() {
      if (process.env.FAKE_COMPUTER_USE === 'off') return false;
      return { images: process.env.FAKE_COMPUTER_IMAGES === 'path' ? 'path' : 'inline', waitSliceMs: Number(process.env.FAKE_COMPUTER_SLICE_MS) > 0 ? Number(process.env.FAKE_COMPUTER_SLICE_MS) : null };
    },
  },

  subagentTools: ["Agent"],
  toolHints: TOOL_HINTS,

  modes: () => MODES,
  models: async () => MODELS,

  async compact({ sessionId, emit }) {
    const s = ensure(sessionId);
    emit({ type: 'compaction', phase: 'start', trigger: 'manual' });
    await wait(350);
    s.contextTokens = 21_000;
    emit({ type: 'compaction', phase: 'complete', trigger: 'manual', beforeTokens: 164_000,
      afterTokens: 21_000, summary: '会話一覧に検索を追加しました。次は狭い画面で結果を確認します。' });
    emit({ type: 'contextWindow', usedTokens: 21_000, windowTokens: 200_000 });
  },

  async runTurn({ prompt, sessionId, cwd, mode, model, emit, onPromptDelivered, askPermission, signal, control, agentRuntime, contextRuntime, computerRuntime, browserRuntime, controlRuntime, browserInstructions, oauthToken, hostSessionId, shellAppends = [], notes = [], botInstructions = null, rewind = null }) {
    // プロンプトを渡す前に失敗する台本（claude のネイティブ指示を止められなかったときと同じ形）。会話にも記録しない
    if (scriptOf(prompt).startsWith("undelivered")) {
      const error = "fake: failed before the prompt was delivered";
      emit({ type: "turnResult", outcome: "error", error });
      throw undelivered(new Error(error));
    }
    const id = sessionId ?? `fake-${crypto.randomUUID()}`;
    const s = ensure(id, cwd);
    // 巻き戻して送り直す（resumeSessionAt + resumeDropsTurn）。捨てる発言が無ければ、Claude と同じく何も渡る前に拒否する
    if (rewind && sessionId) {
      const at = s.messages.findIndex(m => m.uuid === rewind.drops);
      if (process.env.FAKE_REWIND === 'reject' || at < 0) throw Object.assign(new Error('Resume rejected by --resume-drops-turn: fake'), { rewindRejected: true, undelivered: true });
      s.messages.length = at;
    }
    // claude と同じ形にする: 再開ターンでも session を 1 本出し、
    // 「id が確定した」ときだけ first を付ける。形が違うと、
    // 「再開ターンの session を新規待ちのタブが掴む」不具合が unit で踏めない。
    emit({ type: "session", sessionId: id, ...(sessionId ? {} : { first: true }), model: model ?? "" });

    // 実行中の切り替えが効いたことを確かめられるよう、handle にも今の値を持たせる
    const handle = { sessionId: id, mode, model };
    if (control) control.handle = handle;

    // 入力欄の `!` の結果（Claude の shouldQuery: false の行と同じく、返答を起こさずに履歴へ積む）
    for (const text of shellAppends) push(s, { role: "user", text });
    // 中断の後に Pleiad が添える文は、Claude の別の text ブロックをつないだ履歴と同じく、発言の前に置く
    push(s, { role: "user", text: [...notes, String(prompt ?? "")].join("") });
    // silent: は渡った合図を出さないバックエンド（antigravity）の代わり。server は返答の中身で渡ったとみなす
    if (!scriptOf(prompt).startsWith("silent:")) onPromptDelivered?.();
    emit({ type: "activity", state: "thinking" });

    const text = scriptOf(prompt);
    if (text.startsWith('limit ')) {
      const raw = text.slice(6).trim();
      const resetsAt = /^\d+$/.test(raw) ? Number(raw) : Date.parse(raw);
      emit({ type: 'turnResult', outcome: 'limited', resetsAt: Number.isFinite(resetsAt) ? resetsAt : null,
        window: 'five_hour' });
      if (control) { control.handle = null; control.steer = null; control.steerConfirms = false; }
      return { sessionId: id };
    }
    // 発言の id は先に決めておき、text.end に載せる（履歴と同じ id で分岐の起点になる）
    const out = { uuid: crypto.randomUUID(), role: "assistant", text: "", toolCalls: null };

    try {
      if (text.startsWith("slow")) {
        // 中断できることを測るための台本。signal が来るまで終わらない
        if (SLOW_STEER && control) {
          // AGENT_HOST_FAKE_SLOW_STEER=1 のとき: 途中送信を受理して履歴に積む（bot への書き足しの検査用。終わりは finally が外す）
          control.steer = async (item) => {
            if (signal?.signal?.aborted) return false;
            push(s, { role: "user", text: String(item?.args?.prompt ?? "") });
            return true;
          };
          control.onReady?.();
        }
        await new Promise((resolve) => {
          if (signal?.signal?.aborted) return resolve();
          signal?.signal?.addEventListener?.("abort", () => resolve(), { once: true });
        });
        emit({ type: "turnResult", outcome: "aborted" });
        return { sessionId: id };
      }

      if (text.startsWith('<pleiad-pulse>')) {
        // 心拍の安いモデル（ADR 0126）。台本は AGENT_HOST_FAKE_PULSE の JSON ファイル（返事の配列。1 回ごとに順に使い、尽きたら最後を繰り返す）。無ければ何もしない返事
        out.text = nextPulseAnswer();
        await say(emit, out.text, out.uuid);
      } else if (text.startsWith('<pleiad-memory-learn>')) {
        // L1 の学習会話。固定台本で、人の「覚えて:」だけを候補にする。
        const line = text.split('\n').find((part) => part.startsWith('Human statements: '));
        const statements = JSON.parse(line?.slice('Human statements: '.length) ?? '[]');
        out.text = JSON.stringify({ memories: statements.flatMap((item) => {
          const match = /^覚えて[:：]\s*(.{8,300})/u.exec(item.text.trim());
          const learned = match?.[1] ?? item.aiContext?.text;
          return learned ? [{ action: 'add', layer: 'user', text: learned, sourceIndexes: [item.index] }] : [];
        }) });
        await say(emit, out.text, out.uuid);
      } else if (text.startsWith('ply:')) {
        const params = JSON.parse(text.slice(4));
        const callId = crypto.randomUUID();
        emit({ type: 'tool.start', id: callId, name: `mcp__ply_agents__${params.name}`, input: params.arguments });
        const response = await fetch(agentRuntime.url, { method: 'POST', headers: { ...agentRuntime.headers, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params }) });
        const result = (await response.json()).result;
        out.text = result.content[0].text;
        emit({ type: 'tool.result', id: callId, text: out.text, isError: Boolean(result.isError) });
        out.toolCalls = [{ id: callId, name: `mcp__ply_agents__${params.name}`, input: params.arguments, result: { text: out.text, isError: Boolean(result.isError) } }];
        await say(emit, out.text, out.uuid);
      } else if (text.startsWith('computer:') || text.startsWith('computer-hold:')) {
        // ply_computer の呼び出し。表示は他のエージェントの正規化と同じく、印の行から images と computer を作る（docs/computer-use.md「正規化イベントと履歴」）
        if (!computerRuntime) out.text = 'computer: unavailable';
        else {
          out.toolCalls = []; const texts = [];
          for (const params of [].concat(JSON.parse(text.slice(text.indexOf(':') + 1)))) {
            const callId = crypto.randomUUID();
            const toolName = `mcp__ply_computer__${params.name}`;
            emit({ type: 'tool.start', id: callId, name: toolName, input: computerToolInput(toolName, params.arguments) });
            const response = await fetch(computerRuntime.url, { method: 'POST', headers: { ...computerRuntime.headers, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params }) });
            const result = (await response.json()).result;
            const raw = result.content[0].text;
            const shown = computerDisplay(raw);
            emit({ type: 'tool.result', id: callId, text: shown?.text ?? raw, isError: Boolean(result.isError), ...(shown ? { images: shown.images, computer: shown.computer } : {}) });
            out.toolCalls.push({ id: callId, name: toolName, input: params.arguments, result: { text: shown?.text ?? raw, isError: Boolean(result.isError) } });
            texts.push(shown?.text ?? raw);
          }
          out.text = texts.join('\n');
        }
        await say(emit, out.text, out.uuid);
        if (text.startsWith('computer-hold:')) {
          await new Promise(resolve => { if (signal?.signal?.aborted) return resolve(); signal?.signal?.addEventListener?.('abort', resolve, { once: true }); });
          emit({ type: 'turnResult', outcome: 'aborted' });
          return { sessionId: id };
        }
      } else if (text.startsWith('browser:')) {
        // ply_browser の呼び出し（ADR 0078）。ほかの MCP と同じく mcp__ply_browser__<ツール> の行で残す
        if (!browserRuntime) out.text = 'browser: unavailable';
        else {
          out.toolCalls = []; const texts = [];
          for (const params of [].concat(JSON.parse(text.slice('browser:'.length)))) {
            const callId = crypto.randomUUID();
            const toolName = `mcp__ply_browser__${params.name}`;
            emit({ type: 'tool.start', id: callId, name: toolName, input: params.arguments ?? {} });
            const response = await fetch(browserRuntime.url, { method: 'POST', headers: { ...browserRuntime.headers, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params }) });
            const result = (await response.json()).result;
            const raw = result.content[0].text;
            emit({ type: 'tool.result', id: callId, text: raw, isError: Boolean(result.isError) });
            out.toolCalls.push({ id: callId, name: toolName, input: params.arguments ?? {}, result: { text: raw, isError: Boolean(result.isError) } });
            texts.push(raw);
          }
          out.text = texts.join('\n');
        }
        await say(emit, out.text, out.uuid);
      } else if (text.startsWith("notes:") || text.startsWith("instructions:")) {
        // bot の会話の検査用。Pleiad が足した notes（記憶・末尾）／ botInstructions（人格）を JSON で返す
        out.text = JSON.stringify(text.startsWith("notes:") ? notes : botInstructions);
        await say(emit, out.text, out.uuid);
      } else if (text.startsWith('control:')) {
        // ply_control（操作の一覧。ADR 0081）の呼び出し。ほかの MCP と同じく mcp__ply_control__<ツール> の行で残す。渡っていなければ "control: unavailable"
        if (!controlRuntime) out.text = 'control: unavailable';
        else {
          out.toolCalls = []; const texts = [];
          for (const params of [].concat(JSON.parse(text.slice('control:'.length)))) {
            const callId = crypto.randomUUID();
            const toolName = `mcp__ply_control__${params.name}`;
            emit({ type: 'tool.start', id: callId, name: toolName, input: params.arguments ?? {} });
            const response = await fetch(controlRuntime.url, { method: 'POST', headers: { ...controlRuntime.headers, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params }) });
            const result = (await response.json()).result;
            const raw = result.content[0].text;
            emit({ type: 'tool.result', id: callId, text: raw, isError: Boolean(result.isError) });
            out.toolCalls.push({ id: callId, name: toolName, input: params.arguments ?? {}, result: { text: raw, isError: Boolean(result.isError) } });
            texts.push(raw);
          }
          out.text = texts.join('\n');
        }
        await say(emit, out.text, out.uuid);
      } else if (text === 'control-info') {
        // 実際に渡った ply_control の接続（url・指示文・会話のシェルへ渡す環境変数の名前とトークン）。テストが会話に束縛した呼び出しを作るのに使う
        out.text = controlRuntime ? JSON.stringify({ url: controlRuntime.url, instructions: controlRuntime.instructions, env: Object.keys(controlRuntime.env ?? {}),
          envUrl: controlRuntime.env?.PLEIAD_CONTROL_URL, token: controlRuntime.env?.PLEIAD_CONTROL_TOKEN, sameToken: controlRuntime.env?.PLEIAD_CONTROL_TOKEN === controlRuntime.headers?.Authorization?.replace('Bearer ', '') }) : 'control: unavailable';
        await say(emit, out.text, out.uuid);
      } else if (text === 'browser-instructions') {
        out.text = browserInstructions ?? '(none)';
        await say(emit, out.text, out.uuid);
      } else if (text === 'computer-instructions') {
        out.text = computerRuntime?.instructions ?? '(none)';
        await say(emit, out.text, out.uuid);
      } else if (/(^|\n)context:[^\n]*$/.test(text)) {   // 分岐した会話の最初のターンは履歴の引き継ぎ文の末尾に来る
        const params = JSON.parse(text.slice(text.lastIndexOf('context:') + 8));
        const response = await fetch(contextRuntime.url, { method: 'POST', headers: { ...contextRuntime.headers, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params }) });
        out.text = (await response.json()).result.content[0].text;
        await say(emit, out.text, out.uuid);
      } else if (text === 'instructions') {
        // 実際に渡った ply_agents の instructions（Pleiad が入れた指示を含む）をそのまま返す。親と子で中身が違うことを確かめる台本
        out.text = agentRuntime?.instructions ?? '(none)';
        await say(emit, out.text, out.uuid);
      } else if (text === 'compact' || text === '/compact') {
        emit({ type: 'activity', state: 'compacting' });
        emit({ type: 'compaction', phase: 'start', trigger: 'auto' });
        await wait(350);
        s.contextTokens = 21_000;
        emit({ type: 'compaction', phase: 'complete', trigger: 'auto', beforeTokens: 182_000,
          afterTokens: 21_000, summary: '会話一覧に検索を追加しました。次は狭い画面で結果を確認します。' });
        emit({ type: 'contextWindow', usedTokens: 21_000, windowTokens: 200_000 });
        out.text = 'compacted';
        await say(emit, out.text, out.uuid);
      } else if (text === 'hookruns') {
        // Claude の hooks の発火の通知（hook_started / hook_response を正規化した hookRun）の台本。完了・失敗・開始だけの 3 通り
        emit({ type: 'hookRun', phase: 'started', hookId: 'h1', name: 'PreToolUse:Bash', event: 'PreToolUse' });
        await wait(20);
        emit({ type: 'hookRun', phase: 'response', hookId: 'h1', name: 'PreToolUse:Bash', event: 'PreToolUse', outcome: 'success', exitCode: 0 });
        emit({ type: 'hookRun', phase: 'started', hookId: 'h2', name: 'PostToolUse:Bash', event: 'PostToolUse' });
        emit({ type: 'hookRun', phase: 'response', hookId: 'h2', name: 'PostToolUse:Bash', event: 'PostToolUse', outcome: 'error', exitCode: 1 });
        emit({ type: 'hookRun', phase: 'started', hookId: 'h3', name: 'Stop', event: 'Stop' });
        out.text = 'hooks';
        await say(emit, out.text, out.uuid);
      } else if (text === 'compact-fail') {
        emit({ type: 'compaction', phase: 'start', trigger: 'auto' });
        await wait(350);
        emit({ type: 'compaction', phase: 'failed', trigger: 'auto', reason: '接続が切れました' });
        out.text = 'failed';
        await say(emit, out.text, out.uuid);
      } else if (text.startsWith("steps:")) {
        // ツールの続き方（まとまり・入れ替わり・失敗・承認待ち）を画面で確かめるための台本
        // 委譲の子へは、依頼の後ろに Pleiad の指示（「---」の区切りの後ろ）が足されることがある。台本は区切りの前まで
        const rawFull = text.slice(6).trim();
        const cut = rawFull.indexOf("\n\n---\n");
        const raw = cut > 0 ? rawFull.slice(0, cut) : rawFull;
        const script = JSON.parse(raw.startsWith("@") ? (await import("node:fs")).readFileSync(raw.slice(1), "utf8") : raw);
        let calls = [];
        for (const step of script.steps ?? []) {
          if (signal?.signal?.aborted) break;
          if (step.newMessage) {
            // Claude は本文の無い（ツールだけの）発言ごとに text.end を出す。履歴は連続するツールだけの発言を 1 つに合成するので、calls は続ける
            emit({ type: "text.end", uuid: crypto.randomUUID() });
            continue;
          }
          if (step.text != null) {
            const uuid = crypto.randomUUID();
            await say(emit, step.text, uuid);
            push(s, { uuid, role: "assistant", text: String(step.text), ...(calls.length ? { tools: calls.map((c) => c.name), toolCalls: calls } : {}) });
            calls = [];
            continue;
          }
          const callId = crypto.randomUUID();
          emit({ type: "tool.start", id: callId, name: step.tool, input: step.input ?? {} });
          if (step.ask) {
            const answer = await askPermission({ toolName: step.tool, input: step.input ?? {}, sessionId: id, toolUseID: callId, title: null, signal: signal?.signal, canAlways: true, kind: "tool", questions: null,
              ...(step.computerApp ? { computerApp: step.computerApp } : {}) });
            if (!answer?.allow) {
              const denied = { text: "user denied", isError: true, truncated: false };
              emit({ type: "tool.result", id: callId, ...denied });
              calls.push({ id: callId, name: step.tool, input: step.input ?? {}, result: denied });
              continue;
            }
          }
          await wait(step.ms ?? 300);
          // images / computer は ply_computer の結果（tool.result の images と computer。docs/computer-use.md）。画面の確認用に台本から渡せる
          const result = { text: String(step.result ?? ""), isError: Boolean(step.error), truncated: false,
            ...(step.images ? { images: step.images } : {}), ...(step.computer ? { computer: step.computer } : {}) };
          emit({ type: "tool.result", id: callId, ...result });
          calls.push({ id: callId, name: step.tool, input: step.input ?? {}, result });
        }
        out.toolCalls = calls.length ? calls : null;
        out.text = "";
      } else if (text.startsWith("tool")) {
        const callId = crypto.randomUUID();
        emit({ type: "tool.start", id: callId, name: "fake_shell", input: { command: "echo hi" } });
        await wait(1);
        emit({ type: "tool.result", id: callId, text: "hi", isError: false, truncated: false });
        out.toolCalls = [{ id: callId, name: "fake_shell", input: { command: "echo hi" },
                           result: { text: "hi", isError: false, truncated: false } }];
        out.text = "ツールを呼んだ";
        await say(emit, out.text, out.uuid);
      } else if (text.startsWith("ask")) {
        emit({ type: "activity", state: "waiting" });
        const answer = await askPermission({
          toolName: "fake_write",
          input: { path: "a.txt", content: "x" },
          sessionId: id,
          toolUseID: crypto.randomUUID(),
          title: null,
          signal: signal?.signal,
          canAlways: true,
          kind: "tool",
          questions: null,
        });
        out.text = answer?.allow ? `許可された${answer.always ? "（常に）" : ""}` : `拒否された: ${answer?.message ?? ""}`;
        await say(emit, out.text, out.uuid);
        if (text.startsWith("ask-slow")) {
          // 承認が済んだ後も走り続ける。「承認待ち」が解けたことを状態で測れるようにする
          await new Promise((resolve) => {
            if (signal?.signal?.aborted) return resolve();
            signal?.signal?.addEventListener?.("abort", () => resolve(), { once: true });
          });
          push(s, out);
          emit({ type: "turnResult", outcome: "aborted" });
          return { sessionId: id };
        }
      } else if (text.startsWith("question")) {
        emit({ type: "activity", state: "waiting" });
        const answer = await askPermission({
          toolName: "AskUserQuestion",
          input: {},
          sessionId: id,
          toolUseID: crypto.randomUUID(),
          title: null,
          signal: signal?.signal,
          canAlways: false,
          kind: "question",
          questions: [{
            question: "どれにする？",
            header: "選択",
            multiSelect: false,
            options: [{ label: "A", description: "一つ目" }, { label: "B" }],
          }],
        });
        out.text = `回答: ${JSON.stringify(answer?.answers ?? {})}`;
        await say(emit, out.text, out.uuid);
      } else if (/(^|\n)whoami$/.test(text)) {   // 分岐した会話の最初のターンは履歴の引き継ぎ文の末尾に来る
        // トークンそのものは出さない。同じトークンかどうかだけ分かる指紋
        out.text = oauthToken ? `account:${crypto.createHash("sha256").update(oauthToken).digest("hex").slice(0, 12)}` : "account:none";
        await say(emit, out.text, out.uuid);
      } else if (/^fail(\s|$)/.test(text)) {
        throw new Error('fake: failure');
      } else if (/^bg(\s|$)/.test(text)) {
        if (await background(text, { s, out, emit, signal, control })) return { sessionId: id };
      } else if (/^(?:bg-shell|active-shell)(\s|$)/.test(text)) {
        if (await hangingShell(text, { s, out, emit, signal, keys: [...new Set([hostSessionId, id].filter(Boolean))] })) return { sessionId: id };
      } else if (/^hook-follow(\s|$)/.test(text)) {
        const report = { uuid: crypto.randomUUID(), role: "assistant", text: text.replace(/^hook-follow\s*/, "") || "報告" };
        await say(emit, report.text, report.uuid);
        push(s, report);
        // Stop フックの続き。調べものだけをして一言書く（claude-normalize.mjs の stopHookFollowUps が印を付ける形）
        const calls = ["ToolSearch", "mcp__ply_context__load_skill"].map((name) => ({ id: crypto.randomUUID(), name, input: {}, result: { text: "ok", isError: false, truncated: false } }));
        for (const call of calls) {
          emit({ type: "tool.start", id: call.id, name: call.name, input: call.input });
          emit({ type: "tool.result", id: call.id, text: "ok", isError: false, truncated: false });
        }
        push(s, { role: "assistant", text: "", tools: calls.map((c) => c.name), toolCalls: calls, stopHookFollowUp: true });
        const follow = { uuid: crypto.randomUUID(), role: "assistant", text: "ナレッジ化対象なし", stopHookFollowUp: true };
        await say(emit, follow.text, follow.uuid);
        push(s, follow);
      } else if (/^term(\s|$)/.test(text)) {
        out.text = text.replace(/^term\s*/, "") || "端末を残した";
        await say(emit, out.text, out.uuid);
        // Codex と同じく、端末はターンが終わっても残る。server へはターンの外の background で渡す
        const key = hostSessionId ?? id;
        const list = [...(terminals.get(key) ?? []), { id: `fake-term-${crypto.randomUUID().slice(0, 8)}`, kind: "terminal", label: "npm run dev" }];
        emit({ type: "tool.start", id: list.at(-1).id, name: "commandExecution", input: { command: list.at(-1).label, cwd }, startedAt: Date.now() });
        terminals.set(key, list);
        host?.background(key, list);
      } else {
        out.text = text.startsWith("echo:") ? text.slice(5).trim() : text;
        await say(emit, out.text, out.uuid);
      }
    } catch (err) {
      emit({ type: "turnResult", outcome: "error", error: String(err?.message ?? err) });
      throw err;
    } finally {
      if (control) { control.handle = null; control.steer = null; control.steerConfirms = false; }
    }

    if (out.text || out.toolCalls) push(s, out);
    emit({ type: 'contextWindow', usedTokens: s.contextTokens ?? 164_000, windowTokens: 200_000 });
    if (FAKE_USAGE) emit({ type: "usage", inputTokens: 1000, outputTokens: 200, cachedTokens: 900, costUsd: 0 });
    emit({ type: "turnResult", outcome: "ok", turns: 1, costUsd: 0 });
    return { sessionId: id };
  },

  attachHost(h) { host = h; },

  // 台本 "bg-shell" の裏のコマンドと、台本 "term" の端末だけを止められる。ほかは止められない（サブエージェントなど）
  async stopBackground(sessionId, taskId) {
    const stop = shells.get(sessionId)?.get(taskId);
    if (stop) { stop(); return { stopped: true }; }
    const list = terminals.get(sessionId) ?? [];
    if (list.some((x) => x.id === taskId)) {
      const rest = list.filter((x) => x.id !== taskId);
      if (rest.length) terminals.set(sessionId, rest); else terminals.delete(sessionId);
      host?.event?.(sessionId, { type: "task.command", id: taskId, state: "stopped" });
      host?.background(sessionId, rest);
      return { stopped: true };
    }
    throw new Error("fake: このタスクは止められません");
  },

  async setModelLive(handle, model) {
    if (!handle) return false;
    handle.model = model;
    return true;
  },

  async setModeLive(handle, mode) {
    if (!handle) return false;
    handle.mode = mode;
    return true;
  },

  async listSessions({ limit = 100 } = {}) {
    return [...sessions.values()]
      .sort((a, b) => b.lastModified - a.lastModified)
      .slice(0, limit)
      .map((s) => ({
        sessionId: s.sessionId, title: s.title, cwd: s.cwd,
        createdAt: s.createdAt, lastModified: s.lastModified, tag: s.tag,
      }));
  },

  async getSession(sessionId) {
    const s = sessions.get(sessionId);
    if (!s) return null;
    return {
      sessionId: s.sessionId, title: s.title, cwd: s.cwd,
      createdAt: s.createdAt, lastModified: s.lastModified, tag: s.tag,
    };
  },

  async getMessages(sessionId) {
    return (sessions.get(sessionId)?.messages ?? []).map((m) => ({ ...m }));
  },

  async setTitle(sessionId, title) {
    ensure(sessionId).title = title;
  },

  // 隠れた会話の片付け（core/conversations.mjs の deleteHiddenConversation）。Claude の deleteSession と同じく会話を消す
  async deleteSession(sessionId) {
    sessions.delete(sessionId);
  },

  async setTag(sessionId, tag) {
    ensure(sessionId).tag = tag || null;
  },

  // 今すぐ切る形の巻き戻し（FAKE_REWIND=thread。Codex の thread/revert と同じ）
  async rewind(sessionId, { beforeMessageId } = {}) {
    const s = sessions.get(sessionId);
    const at = s?.messages.findIndex(m => m.uuid === beforeMessageId) ?? -1;
    if (at < 0) throw new Error('fake: rewind target not found');
    s.messages.length = at;
    return { sessionId, via: 'revert' };
  },

  async fork(sessionId, { upToMessageId, title } = {}) {
    const src = sessions.get(sessionId);
    const child = `fake-${crypto.randomUUID()}`;
    const s = ensure(child, src?.cwd ?? null);
    s.title = title ?? (src?.title ? `${src.title} (fork)` : null);
    const cut = upToMessageId ? src?.messages.findIndex((m) => m.uuid === upToMessageId) : -1;
    s.messages = (src?.messages ?? []).slice(0, cut >= 0 ? cut + 1 : undefined).map((m) => ({ ...m }));
    return { sessionId: child };
  },

  // 前のターンの分も含めて全部返す（Claude の listSubagents と同じ）。並びは作った順の逆。
  // Claude も readdir の順で、起動順とは限らない。順番で見出しを当てると外れる形をテストで踏む
  async listSubagents(sessionId) {
    return (sessions.get(sessionId)?.subagents ?? []).map((a) => a.id).reverse();
  },
  async getSubagentMessages(sessionId, agentId) {
    return (sessions.get(sessionId)?.subagents.find((a) => a.id === agentId)?.messages ?? []).map((m) => ({ ...m }));
  },
  async getSubagentState(sessionId, agentId) {
    const a = sessions.get(sessionId)?.subagents.find((x) => x.id === agentId);
    return a?.status ? { status: a.status, startedAt: a.startedAt ?? null, endedAt: a.endedAt ?? null } : null;
  },
  async getSubagentOrigin(sessionId, agentId) {
    return sessions.get(sessionId)?.subagents.find((a) => a.id === agentId)?.toolUseId ?? null;
  },

  async suggestTitle({ transcript }) {
    // LLM は呼ばない。冒頭の一行を切って返すだけ（整形規則は server 側で効く）
    return String(transcript ?? "").split("\n").find((l) => l.trim())?.slice(0, 20) ?? "無題";
  },

  auth: {
    async status() {
      return { loggedIn: auth.loggedIn, account: auth.account, detail: "テスト用のダミー" };
    },
    async login({ emit }) {
      emit?.({ type: "auth", backend: "fake", phase: "url", url: "https://example.invalid/login" });
      auth.loggedIn = true;
      auth.account = "tester";
      emit?.({ type: "auth", backend: "fake", phase: "done", message: "ログインした" });
    },
    async logout() {
      auth.loggedIn = false;
      auth.account = null;
    },
  },
};

/** テストから状態を消したいとき用。サーバ側からは使わない。 */
export function reset() {
  sessions.clear();
  auth.loggedIn = false;
  auth.account = null;
}
