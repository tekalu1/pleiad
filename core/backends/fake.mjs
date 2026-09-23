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
//   "whoami"       … 渡されたアカウントのトークン（oauthToken）の指紋を本文にする。無ければ account:none
//   "context:<json>" … ply_context（contextRuntime）のツールを { name, arguments } で 1 回呼び、返りを本文にする
//   "compact"      … 文脈の圧縮（Claude の activity compacting と同じ形）を流す
//   それ以外        … prompt をそのまま echo
import crypto from "node:crypto";
import { undelivered } from "./undelivered.mjs";

const sessions = new Map();   // sessionId -> { sessionId, title, cwd, createdAt, lastModified, tag, messages, subagents }
const auth = { loggedIn: false, account: null };

const now = () => Date.now();
const iso = () => new Date().toISOString();
const wait = (ms) => new Promise((r) => setTimeout(r, ms).unref?.());

const MODES = {
  default: { label: "都度確認", short: "都度", note: "全部聞く",     scope: "workspace", autonomy: "ask",   enforced: false },
  auto:    { label: "auto",     note: "聞かずに進む", scope: "workspace", autonomy: "never", enforced: false },
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

const STEER_LATENCY_MS = 300;
// 途中送信を「受理」してから「渡った」までの間を作る（ミリ秒）。指定したときだけ steerConfirms を立て、
// 本物（claude / codex）と同じ pending → userMessage.delivered の順で流す。画面の確認とテスト用
const STEER_CONFIRM_MS = Number(process.env.AGENT_HOST_FAKE_STEER_CONFIRM_MS) || 0;

/**
 * 台本 "bg [本数] [秒]"。Claude のバックグラウンド subagent と同じ形のイベントを流す（docs/multi-backend.md §2.2）。
 * main は先に返答し、phase: waiting で裏の完了を待つ。完了ごとに main が再開して一言返す。
 * 待っている間の途中送信（control.steer）には、main がその場で答える。
 * 中断されたら true（呼び出し側はそこで終わる）。
 */
async function background(text, { s, out, emit, signal, control }) {
  const [, nArg, secArg] = text.split(/\s+/);
  const n = Math.max(1, Math.min(5, Math.floor(Number(nArg)) || 2));
  const total = Math.max(0.2, Number(secArg) || 6) * 1000;
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
          await Promise.race([wait(STEER_CONFIRM_MS), aborted]);
          if (signal?.signal?.aborted) continue;
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
  }
  // 発言は都度履歴に積んだ。runTurn の最後で二重に積まないよう空にしておく
  out.text = "";
  out.toolCalls = null;
  return false;
}

export const backend = {
  id: "fake",
  label: "Fake (test)",
  description: "テスト用のダミー。LLM は呼ばない",

  // 出し分けの経路を全部通せるように、hostTools 以外は持てることにする。
  // hostTools だけ false なのは、AI 側から present / set_status を呼ぶ口が無い
  // バックエンド（codex）と同じ形を、テストでも踏むため。
  capabilities: {
    title: true,
    tag: true,
    fork: true,
    forkMessage: true,
    subagents: true,
    liveModel: true,
    liveMode: true,
    hostTools: false,
    alwaysAllow: true,
    login: true,
    // Claude と同じく会話ごとのアカウントを受け取れることにする（server の配線と画面をテストで通すため）
    claudeAccounts: true,
  },

  subagentTools: ["Agent"],
  toolHints: TOOL_HINTS,

  modes: () => MODES,
  models: async () => MODELS,

  async runTurn({ prompt, sessionId, cwd, mode, model, emit, onPromptDelivered, askPermission, signal, control, agentRuntime, contextRuntime, oauthToken }) {
    // プロンプトを渡す前に失敗する台本（claude のネイティブ指示を止められなかったときと同じ形）。会話にも記録しない
    if (String(prompt ?? "").trim().startsWith("undelivered")) {
      const error = "fake: failed before the prompt was delivered";
      emit({ type: "turnResult", outcome: "error", error });
      throw undelivered(new Error(error));
    }
    const id = sessionId ?? `fake-${crypto.randomUUID()}`;
    const s = ensure(id, cwd);
    // claude と同じ形にする: 再開ターンでも session を 1 本出し、
    // 「id が確定した」ときだけ first を付ける。形が違うと、
    // 「再開ターンの session を新規待ちのタブが掴む」不具合が unit で踏めない。
    emit({ type: "session", sessionId: id, ...(sessionId ? {} : { first: true }), model: model ?? "" });

    // 実行中の切り替えが効いたことを確かめられるよう、handle にも今の値を持たせる
    const handle = { sessionId: id, mode, model };
    if (control) control.handle = handle;

    push(s, { role: "user", text: String(prompt ?? "") });
    onPromptDelivered?.();
    emit({ type: "activity", state: "thinking" });

    const text = String(prompt ?? "").trim();
    // 発言の id は先に決めておき、text.end に載せる（履歴と同じ id で分岐の起点になる）
    const out = { uuid: crypto.randomUUID(), role: "assistant", text: "", toolCalls: null };

    try {
      if (text.startsWith("slow")) {
        // 中断できることを測るための台本。signal が来るまで終わらない
        await new Promise((resolve) => {
          if (signal?.signal?.aborted) return resolve();
          signal?.signal?.addEventListener?.("abort", () => resolve(), { once: true });
        });
        emit({ type: "turnResult", outcome: "aborted" });
        return { sessionId: id };
      }

      if (text.startsWith('ply:')) {
        const params = JSON.parse(text.slice(4));
        const callId = crypto.randomUUID();
        emit({ type: 'tool.start', id: callId, name: `mcp__ply_agents__${params.name}`, input: params.arguments });
        const response = await fetch(agentRuntime.url, { method: 'POST', headers: { ...agentRuntime.headers, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params }) });
        const result = (await response.json()).result;
        out.text = result.content[0].text;
        emit({ type: 'tool.result', id: callId, text: out.text, isError: Boolean(result.isError) });
        out.toolCalls = [{ id: callId, name: `mcp__ply_agents__${params.name}`, input: params.arguments, result: { text: out.text, isError: Boolean(result.isError) } }];
        await say(emit, out.text, out.uuid);
      } else if (/(^|\n)context:[^\n]*$/.test(text)) {   // 分岐した会話の最初のターンは履歴の引き継ぎ文の末尾に来る
        const params = JSON.parse(text.slice(text.lastIndexOf('context:') + 8));
        const response = await fetch(contextRuntime.url, { method: 'POST', headers: { ...contextRuntime.headers, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params }) });
        out.text = (await response.json()).result.content[0].text;
        await say(emit, out.text, out.uuid);
      } else if (text === 'compact') {
        emit({ type: 'activity', state: 'compacting' });
        out.text = 'compacted';
        await say(emit, out.text, out.uuid);
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
      } else if (/^bg(\s|$)/.test(text)) {
        if (await background(text, { s, out, emit, signal, control })) return { sessionId: id };
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
    emit({ type: "turnResult", outcome: "ok", turns: 1, costUsd: 0 });
    return { sessionId: id };
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

  async setTag(sessionId, tag) {
    ensure(sessionId).tag = tag || null;
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
