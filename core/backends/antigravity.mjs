// Google Antigravity CLI（`agy`）のバックエンド。
//
// これが Pleiad で **Google のサブスク枠（AI Pro / Ultra）を正規の手段で使える唯一の道**。
// gemini-cli の個人向けログインは 2026-06-18 に終了し、Gemini API キーは別建ての従量課金、
// Antigravity SDK は API キーか Vertex しか受けない（docs/multi-backend.md §2.8）。
//
// **代わりに諦めているもの**（プロトコルの制約。こちらの手抜きではない）:
//   1. **ターン中の対話承認が無い。** 公式に非対応。承認が取れないツールは soft-deny され、
//      ターンは止まらない。Pleiad の承認カードは出せず、**承認モードも「全部自動」1 つだけ**
//      （それ以外を選ばせると黙って何もできないだけになる。MODES のコメント参照）
//   2. **思考が流れない。** `thinking_tokens` は完了時の集計にしか出ない
// 本文のデルタは流れ、ツールも「実行中」から出る（同じ step_index で state: ACTIVE -> DONE の
// 2 回来るのを分けている。docs/multi-backend.md §2.8）ので、会話が流れる見た目そのものは
// 他のバックエンドと変わらない。
//
// **出力の打ち切りに気をつける。** agy の `--print-timeout`（既定 5m0s）はターンを打ち切り、
// 本文が空のまま `status:"SUCCESS"` を返す。しかも agy 自身は裏で走り続ける。
// そこで (a) 十分長い `--print-timeout` を渡し（antigravity-cli.mjs）、
// (b) それでも打ち切られたら失敗として畳み、その agy を落とす（onPrintTimeout）。
import { cliCommand, spawnCli } from "../cli-installation.mjs";
import { AgySession, START_TIMEOUT_MS } from "./antigravity-cli.mjs";
import { AGENT_NAME, contextRefusal, prepareAgent, sweep } from "./antigravity-context.mjs";
import * as pids from "./antigravity-pids.mjs";
import * as transcript from "./antigravity-store.mjs";
import { AGY_LEVELS, agyTarget, buildAgyModels, defaultLabelFromLog, parseAgyModels } from "./antigravity-models.mjs";
import { MAX_RESULT_CHARS } from "./shared.mjs";
import { t } from "../i18n.mjs";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * 本文の無い SUCCESS を確定するまでに、打ち切りの印（stderr）を待つ時間。
 * 印は stderr、result は stdout と**別のパイプ**で届くので、着く順は保証されない
 * （agy は印を先に書くが、Linux では result が先に読めることがある）。
 */
const EMPTY_SUCCESS_GRACE_MS = Number(process.env.AGENT_HOST_AGY_EMPTY_SUCCESS_MS ?? 500);
const LATE = Symbol("late");

/**
 * 承認モード。**`yolo` の 1 つだけ**にしてある。
 *
 * `agy --help` には `--mode plan` と `--mode accept-edits` もあるが、**ヘッドレスでは使い物にならない**。
 * ターン中の対話承認がプロトコルに無いため、`--dangerously-skip-permissions` を付けない限り
 * 許可の要るツールは **soft-deny** される（ターンは止まらず、stderr に通知が出るだけ）。
 * しかも `--print` モードは settings.json の `permissions.allow` を見ない（[antigravity-cli#548]）ので、
 * 事前付与で埋めることもできない。
 *
 * つまり plan / accept-edits を選べるようにすると、「モードを選んだのにエージェントが
 * 黙って何もできない」だけになる。**選べる形で出さない**。
 * 同じ理由で「都度確認」も無い（聞くと言って聞かないものを作らない）。
 *
 * [antigravity-cli#548]: https://github.com/google-antigravity/antigravity-cli/issues/548
 */
const MODES = {
  yolo: {
    // label / note はゲッター（サーバーの言語は実行中に変わる。core/i18n.mjs）
    get label() { return t("modes.full"); },
    get note() { return t("antigravity.modes.yolo"); },
    skip: true,
    // 軸（core/modes.mjs）。範囲を絞る手段が無いので full、強制もできない。
    scope: "full",
    autonomy: "never",
    enforced: false,
  },
};

/**
 * `--effort` の値（`agy --help` で確認）。画面に出す段の候補はモデル一覧の efforts から取る（core/effort.mjs）。
 * agy の段は「段違いの id を選ぶ」ことなので、`--effort` はそのまま渡さない（antigravity-models.mjs の agyTarget）
 */
const EFFORTS = AGY_LEVELS;

/**
 * ツールの表示ヒント。`agy` は `tool_name` を素の文字列で出す
 * （実機の例では `run_command`）。よく出るものだけ名前で拾い、残りは総称にする。
 */
// label はゲッター（共有キー tools.*。言語は実行中に変わる）
// i18n-dynamic: tools.
const hint = (key, shape) => ({ get label() { return t(`tools.${key}`); }, shape });
const TOOL_HINTS = {
  run_command:   hint("run", "shell"),
  read_file:     hint("read", "read"),
  write_file:    hint("write", "write"),
  edit_file:     hint("edit", "edit"),
  replace:       hint("edit", "edit"),
  grep_search:   hint("search", "search"),
  find_by_name:  hint("find", "search"),
  list_dir:      hint("list", "read"),
  read_url:      hint("fetch", "web"),
  search_web:    hint("webSearch", "web"),
};

/** 会話ごとの生きたプロセス。**1 プロセス = 1 会話**（antigravity-cli.mjs 冒頭）。 */
const live = new Map();   // conversationId -> AgySession

// 前の起動が残した孤児を掃除する（強制終了・クラッシュでは下の exit が走らないため）。
// 待たない。**実行ファイル名を確かめたものしか落とさない**（antigravity-pids.mjs）
const reaped = pids.reap().catch(() => []);
// 前の起動が残した、Pleiad のコンテキストを渡すためのエージェント定義も消す（antigravity-context.mjs）
sweep();

/** 会話から手を引く。生かしている印（live / pid の控え）を揃って落とす。 */
function release(conversationId, session) {
  if (conversationId && live.get(conversationId) === session) live.delete(conversationId);
  if (session?.pid) pids.forget(session.pid);
}

/** 直近に引けたモデル一覧。`agy models` は認証が要るので、引けたときだけ覚える。 */
let modelCache = null;

/** ログインを 2 本同時に走らせないための印。 */
let pendingAuth = null;

/** 端末でのログインを待つ上限。 */
const LOGIN_TIMEOUT_MS = Number(process.env.AGENT_HOST_AGY_LOGIN_MS ?? 10 * 60_000);

/** 待っている間に `agy models` を叩く間隔。 */
const LOGIN_POLL_MS = Number(process.env.AGENT_HOST_AGY_POLL_MS ?? 3_000);

const cut = (s) => {
  const text = String(s ?? "");
  return text.length > MAX_RESULT_CHARS
    ? { text: text.slice(0, MAX_RESULT_CHARS) + t("antigravity.truncated"), truncated: true }
    : { text, truncated: false };
};

const modeFor = (id) => (Object.hasOwn(MODES, id) ? id : "yolo");
const effortFor = (e) => (EFFORTS.includes(e) ? e : "");

/** `result.status` -> turnResult（公式ドキュメントの 7 値）。 */
function turnResultFor(result) {
  const status = result?.status;
  if (status === "SUCCESS") return { type: "turnResult", outcome: "ok", turns: result?.num_turns ?? 1 };
  if (status === "CANCELED" || status === "INTERRUPTED") return { type: "turnResult", outcome: "aborted", turns: 1 };
  return {
    type: "turnResult", outcome: "error", turns: result?.num_turns ?? 1,
    error: String(result?.error || t("antigravity.errors.endedWith", { status: status ?? t("antigravity.errors.unknownStatus") })),
  };
}

/** `result.usage` -> Pleiad の usage イベント。 */
function usageFor(usage) {
  if (!usage) return null;
  const n = (v) => (Number.isFinite(v) ? v : 0);
  return {
    type: "usage",
    inputTokens: n(usage.input_tokens),
    outputTokens: n(usage.output_tokens),
    cachedTokens: n(usage.cache_read_tokens),
  };
}

const toolName = (name) => (name && Object.hasOwn(TOOL_HINTS, name) ? name : name || "tool");

// ---------------------------------------------------------------- backend

export const backend = {
  id: "antigravity",
  label: "Antigravity",
  get description() { return t("antigravity.description"); },

  async usage() { return (await import('./antigravity-usage.mjs')).readAntigravityUsage(); },

  capabilities: {
    title: false,       // タイトルの口が無い -> sidecar が正本
    tag: false,         // 状態タグも無い -> sidecar が正本
    fork: false,        // 分岐の口が無い -> Pleiad の写しで分ける
    subagents: false,
    liveModel: false,   // 起動時の --model だけ。走らせたままは変えられない
    liveMode: false,    // --mode も同じ
    hostTools: false,
    // Pleiad 担当のコンテキスト（ply_context）は、Pleiad の置き場に作ったカスタムエージェント経由で渡す（antigravity-context.mjs）。
    // agy は会話のあいだ 1 本のプロセスを生かすので、ply_context のトークンもターンごとではなく会話ごと（'conversation'）
    plyContext: "conversation",
    alwaysAllow: false, // **対話承認そのものが無い**
    login: true,
  },

  toolHints: TOOL_HINTS,

  /** 担当の組み合わせで Pleiad のコンテキストを渡せないときの理由（渡せるなら null）。server が見る */
  plyContextRefusal: (owners) => contextRefusal(owners),

  // skip は agy の内部事情なので出さない。語彙と軸だけを返す。
  modes: () => Object.fromEntries(Object.entries(MODES).map(([id, m]) => [id, { label: m.label, note: m.note, scope: m.scope, autonomy: m.autonomy, enforced: m.enforced }])),

  /**
   * モデル一覧。段違い（-low / -medium / -high）は系統ごとに 1 行にまとめ、段はエフォートで選ぶ（antigravity-models.mjs）。
   * 段の候補も各行の efforts に載せる（core/effort.mjs がそれを読む）。
   * 既定のモデルは `agy models` を起こしたときのログから読む（listModels）。一覧を引けていなければ「既定（agy の設定）」だけ
   */
  async models() {
    return modelCache ?? buildAgyModels([], null);
  },

  // ---- 実行 ---------------------------------------------------------------

  async runTurn({ prompt, sessionId, cwd, mode, model, effort, emit, signal, control, contextRuntime }) {
    const m = MODES[modeFor(mode)];

    // **控えはターンの終わりに書くが、送信の時刻はここで取る。**
    // 終わりの時刻で打つと、長いターンでは送信が数分ずれて見えるうえ、
    // ターンの途中で出た提示（visualization は生成時刻を持つ）がユーザー発言より前に並ぶ。
    // その並びは分岐の切り口にそのまま効く（core/conversations.mjs の buildItems）ので、
    // ユーザー発言で切った枝に、まだ走っていないはずの成果物が入り込む。
    const sentAt = Date.now();

    let conversationId = sessionId ?? null;
    let sawText = false;
    let text = "";                 // 控えに残す本文
    const toolCalls = [];          // 控えに残すツール呼び出し
    let settle = null;
    let failed = null;
    let timedOut = false;          // agy が出力を打ち切った（下の onPrintTimeout）
    const started = new Map();     // tool.start を出した step -> { name, input }
    let closed = false;            // このターンを畳み終えた（settle 済み）
    const finished = new Promise((resolve) => { settle = () => { closed = true; resolve(); }; });

    // 生きているプロセスを使い回す。落ちていれば立て直す（会話は --conversation で拾える）
    let session = conversationId ? live.get(conversationId) : null;
    if (session && !session.proc) { live.delete(conversationId); session = null; }
    // Pleiad のコンテキストは起動時にしか渡せない（エージェント定義と env）。起動時と違う渡し方になるなら起こし直す
    const contextKey = contextRuntime?.headers?.Authorization ?? null;
    if (session && (session.contextKey ?? null) !== contextKey) { session.kill(); release(conversationId, session); session = null; }

    const fresh = !session;
    if (fresh) {
      // 会話ごとのエージェント定義（Pleiad の置き場）と、中継に渡す接続先・トークン（env）
      const agent = contextRuntime ? await prepareAgent({ owners: contextRuntime.owners, prompt: contextRuntime.prompt, cwd, url: contextRuntime.url, authorization: contextKey }) : null;
      session = new AgySession({
        cwd,
        conversationId,
        // --model と --effort は同時に渡さない。段は同じ系統の段違いの id に解決する（antigravity-models.mjs）
        ...agyTarget(model, effortFor(effort), modelCache ?? {}),
        mode: m.flag,
        skipPermissions: Boolean(m.skip),
        // agy のヘッドレスは cwd だけではワークスペースを設定しないため、--add-dir で渡す
        addDirs: cwd ? [cwd] : [],
        ...(agent ? { addDirs: [...(cwd ? [cwd] : []), agent.home], agent: AGENT_NAME, env: agent.env, onGone: agent.cleanup } : {}),
      });
      session.contextKey = contextKey;
    }

    const handle = (ev) => {
      switch (ev?.event) {
        case "init": {
          const id = ev.conversation_id ?? ev.init?.conversation_id ?? null;
          if (!id) return;
          const isNew = !conversationId;
          conversationId = id;
          live.set(id, session);
          if (isNew) {
            // **これを出さないと web が id を受け取れない。**`first: true` は
            // 「id が確定した最初の1本」の印で、再開ターンでは出さない
            emit({
              type: "session", sessionId: id, first: true,
              ...(ev.init?.model ? { model: ev.init.model } : {}),
            });
          }
          return;
        }

        case "step_update": {
          const s = ev.step_update ?? {};
          if (s.step_type === "agent_response") {
            const delta = s.text_delta;
            if (!delta) return;
            if (!sawText) { sawText = true; emit({ type: "activity", state: "writing" }); }
            text += delta;
            return emit({ type: "text.delta", text: String(delta) });
          }
          if (s.step_type === "tool") {
            // **同じ step_index で 2 回来る**: `ACTIVE`（output 無し）-> `DONE`（output あり）。
            // 開始と完了に分ける。同じに扱うとツールが二重に並び、1 つ目は結果が空になる
            // （実測。docs/multi-backend.md §2.8）
            const id = `${conversationId ?? "agy"}:${s.step_index ?? started.size}`;
            const prev = started.get(id);
            const name = toolName(s.tool_name ?? s.tool_info?.name ?? prev?.name);
            const input = s.tool_info?.parameters ?? prev?.input ?? {};
            const output = s.tool_info?.output;
            const state = String(s.state ?? "").toUpperCase();
            // 知らない state・state 無しでも取りこぼさない: output があれば完了、無ければ開始
            const done = state === "ACTIVE" ? false
              : state === "DONE" ? true
              : output !== undefined && output !== null && output !== "";

            if (!started.has(id)) {
              started.set(id, { name, input });
              emit({ type: "activity", state: "running", label: t("activity.tool", { label: TOOL_HINTS[name]?.label ?? name }) });
              emit({ type: "tool.start", id, name, input });
            }
            if (!done) return;
            const r = cut(typeof output === "string" ? output : JSON.stringify(output ?? ""));
            emit({ type: "tool.result", id, ...r, isError: false });
            toolCalls.push({ id, name, input, result: { ...r, isError: false } });
            return;
          }
          // user_input / checkpoint。会話には出さない
          return;
        }

        case "result": {
          // 打ち切られた後の result は SUCCESS でも信じない（onPrintTimeout が畳んでいる）
          if (timedOut || closed) return;
          const r = ev.result ?? {};
          // 本文の無い SUCCESS は、打ち切り（onPrintTimeout）と見分けがつかない。印が遅れて
          // 届く分だけ待ってから確定する。その間に印が来れば onPrintTimeout が失敗として畳む
          if (!ev[LATE] && !sawText && !r.response && String(r.status ?? "").toUpperCase() === "SUCCESS") {
            setTimeout(() => handle({ ...ev, [LATE]: true }), EMPTY_SUCCESS_GRACE_MS);
            return;
          }
          conversationId ||= r.conversation_id || null;
          if (sawText) emit({ type: "text.end" });
          const usage = usageFor(r.usage);
          if (usage) emit(usage);
          const outcome = turnResultFor(r);
          if (outcome.outcome === "error") failed = new Error(outcome.error);
          emit(outcome);
          return settle?.();
        }

        default:
          return;
      }
    };
    session.onEvent = handle;

    // 未ログインのままターンを投げた。**ここから Pleiad がログインを回すことはできない**
    // （認可コードは端末からしか読まれない。auth.login のコメント参照）。
    // 出た URL ではなく、端末で叩くコマンドを案内する。このターン自体は 60 秒で失敗する
    session.onAuthUrl = () => {
      const argv = cliCommand("antigravity");
      emit({
        type: "auth", backend: "antigravity", phase: "url",
        url: argv ? argv.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(" ") : "agy",
        message: t("antigravity.auth.notLoggedInTurn"),
      });
    };

    /**
     * agy が出力を打ち切った（`--print-timeout`）。**ここが空の SUCCESS を撥ねる保険。**
     *
     * 打ち切られた agy は本文が空のまま `status:"SUCCESS"` を吐くので、そのまま写すと
     * 「正常に終わったのに何も言わない」ターンになる。`--print-timeout` は長く渡している
     * （antigravity-cli.mjs）が、値を変えれば同じ穴が開くので、文言でも気づけるようにする。
     */
    session.onPrintTimeout = () => {
      if (timedOut || failed || closed) return;
      timedOut = true;
      if (sawText) emit({ type: "text.end" });
      const message = t("antigravity.errors.printTimeout");
      failed = new Error(message);
      emit({ type: "turnResult", outcome: "error", error: message });
      // **裏で走り続ける agy を残さない。** 放っておくと Pleiad の見ていない所でファイルを
      // 書き換え、Google の枠も食い続ける。会話は `--conversation <id>` で拾い直せる
      session.kill();
      release(conversationId, session);
      settle?.();
    };

    session.onExit = (err) => {
      release(conversationId, session);
      // ターンの途中で落ちた。中断（kill）なら abort 側が畳むので、ここでは失敗にしない
      if (signal?.signal?.aborted) return settle?.();
      failed = err;
      emit({ type: "turnResult", outcome: "error", error: String(err?.message ?? err) });
      settle?.();
    };

    // 中断はプロセスを落とすしかない（プロトコルに中断が無い）。
    // **落としたことを自分で畳む。** kill() は先に proc を手放すので exit の通知は来ない
    // （来ないのが正しい。立て直しの die と取り違えないため）。ここで settle しないと
    // runTurn が返らず、server の実行中一覧から消えなくなる
    const abort = () => {
      session.kill();
      release(conversationId, session);
      settle?.();
    };
    if (signal?.signal?.aborted) abort();
    else signal?.signal?.addEventListener?.("abort", abort, { once: true });

    const timer = setTimeout(() => {
      if (!conversationId) { failed = new Error(t("antigravity.errors.startTimeout", { ms: START_TIMEOUT_MS })); abort(); settle?.(); }
    }, START_TIMEOUT_MS);
    timer.unref?.();

    try {
      if (fresh) {
        await reaped;   // 前の孤児を掃除し終えてから起こす（自分のを巻き込まない）
        session.start();
        // 強制終了で取り残されたときに、次の起動が掃除できるように控える
        pids.remember(session.pid);
      }
      if (control) control.handle = { get conversationId() { return conversationId; } };
      control?.onReady?.();
      emit({ type: "activity", state: "thinking" });
      session.prompt(prompt);
      await finished;

      if (signal?.signal?.aborted) {
        emit({ type: "turnResult", outcome: "aborted" });
        return { sessionId: conversationId };
      }
      if (failed) throw failed;

      // **控えは Pleiad が書く。**agy に履歴の取り出し口が無い（antigravity-store.mjs 冒頭）
      // 時刻は発言ごとに変える: ユーザーは送信時、AI は完了時。提示はこの間に入る
      const doneAt = Date.now();
      await transcript.appendMessages(conversationId, {
        cwd,
        messages: [
          { role: "user", text: String(prompt ?? ""), uuid: `${conversationId}:u${sentAt}`, at: new Date(sentAt).toISOString() },
          ...(text || toolCalls.length ? [{
            role: "assistant", text, uuid: `${conversationId}:a${doneAt}`, at: new Date(doneAt).toISOString(),
            ...(toolCalls.length ? { tools: toolCalls.map((c) => c.name), toolCalls } : {}),
          }] : []),
        ],
      }).catch((err) => console.error("  agy の控えを書けなかった:", String(err?.message ?? err)));
    } finally {
      clearTimeout(timer);
      if (control) { control.handle = null; control.steer = null; }
    }

    return { sessionId: conversationId };
  },

  // ---- セッション管理 -----------------------------------------------------
  //
  // `agy` に一覧も履歴も無い（サブコマンドを実機で確認）。Pleiad の控えが唯一の情報源。

  async listSessions({ limit = 100 } = {}) {
    return transcript.listRecords({ limit });
  },

  async getSession(sessionId) {
    const record = await transcript.getRecord(sessionId);
    return record ? transcript.toRow(record) : null;
  },

  async getMessages(sessionId, options) {
    return transcript.getMessages(sessionId, options ?? {});
  },

  // ---- 認証 ---------------------------------------------------------------
  //
  // `agy` は login サブコマンドを持たない。**ヘッドレスで走らせたときに、未ログインなら
  // stderr へ OAuth の URL を出し、stdin で認可コードを待つ**（実機で確認）。
  // つまりログイン専用の口は要らず、ターンを 1 本起こせばその経路に乗る。

  auth: {
    /**
     * ログインしているか。
     *
     * 資格情報は **OS の資格情報ストア**にある（macOS のキーチェーン: service `gemini` /
     * account `antigravity`）。ファイルとして読めないので、**`agy models` に聞く**。
     * 未ログインなら「Please sign in」で落ちる（実機で確認）。
     */
    async status() {
      try {
        rememberModels(await listModels());
        return { loggedIn: true, account: t("antigravity.auth.account"), detail: t("antigravity.auth.detail") };
      } catch (err) {
        const message = String(err?.message ?? err);
        if (/sign in/i.test(message)) {
          return { loggedIn: false, account: null, detail: t("antigravity.auth.notLoggedIn") };
        }
        // 落ちた理由が分からないときは「ログインしていない」と断定しない
        return { loggedIn: false, account: null, detail: message.slice(0, 200) };
      }
    },

    /**
     * ログイン。**Pleiad からは OAuth を回せない。** 端末でのサインインを案内し、終わるのを待つ。
     *
     * 実機（agy 1.2.4）で確かめたこと:
     *   - ヘッドレスで未ログインだと stderr に認可 URL を出し、
     *     「Or, paste the authorization code here and press Enter:」と促す
     *   - **その入力は端末からしか読まない。** パイプした stdin に認可コードを書いても
     *     完全に無視され、60 秒で `authentication failed or timed out` になる（実測）
     * 公式も同じことを書いている:
     *   > Headless mode uses your cached credentials. Authenticate once with an interactive
     *   > `agy` session first.
     *
     * そこで Pleiad は**自分で回そうとしない**。端末で叩くコマンドを案内し、
     * `agy models` が通るようになるまで見張る（利用者は「再確認」を押さなくてよい）。
     */
    async login({ emit }) {
      if (pendingAuth) throw new Error(t("antigravity.auth.loginRunning"));
      pendingAuth = {};
      try {
        if (await signedIn()) {
          emit?.({ type: "auth", phase: "done", message: t("antigravity.auth.alreadyLoggedIn") });
          return;
        }

        const argv = cliCommand("antigravity");
        // PATH に載っていないこともある（インストーラが PATH を書いても、
        // 起動済みの端末や Pleiad には届かない）。そのまま貼れる形で出す
        const command = argv ? argv.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(" ") : "agy";
        emit?.({
          type: "auth", phase: "url", url: command,
          message: t("antigravity.auth.runCommand"),
        });

        const until = Date.now() + LOGIN_TIMEOUT_MS;
        while (Date.now() < until) {
          await new Promise((r) => { const t = setTimeout(r, LOGIN_POLL_MS); t.unref?.(); });
          if (await signedIn()) {
            emit?.({ type: "auth", phase: "done", message: t("antigravity.auth.loggedIn") });
            return;
          }
        }
        const message = t("antigravity.auth.loginTimeout");
        emit?.({ type: "auth", phase: "error", message });
        throw new Error(message);
      } finally {
        pendingAuth = null;
      }
    },

    /**
     * ログアウト。`agy` に口が無く、資格情報は OS の資格情報ストアにある。
     * Pleiad からは消せないので、そのことを伝える。
     */
    async logout() {
      throw new Error(t("antigravity.auth.logoutInAgy"));
    },
  },
};

// ---------------------------------------------------------------- 小道具

/** ログイン済みか。`agy models` が通れば通っている（資格情報は OS の資格情報ストアにあり読めない）。 */
async function signedIn() {
  try {
    rememberModels(await listModels());
    return true;
  } catch {
    return false;
  }
}

/**
 * `agy models` の出力（`id<TAB>表示名` の行。antigravity-models.mjs の parseAgyModels）と、
 * そのとき agy が選んでいた既定のモデルの表示名。既定は設定ファイルに出ないので、
 * `--log-file` で置き場を決めたログから読む（defaultLabelFromLog。読めなければ null）。
 * @returns {Promise<{ rows: {id:string,label:string}[], defaultLabel: string|null }>}
 */
function listModels() {
  return new Promise((resolve, reject) => {
    let out = "", err = "";
    let proc;
    const log = path.join(os.tmpdir(), `ply-agy-models-${process.pid}-${crypto.randomUUID()}.log`);
    const readDefault = () => {
      try { return defaultLabelFromLog(fs.readFileSync(log, "utf8")); }
      catch { return null; }
      finally { fs.rm(log, { force: true }, () => {}); }
    };
    try {
      proc = spawnModels(log);
    } catch (e) {
      return reject(e);
    }
    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (c) => { out += c; });
    proc.stderr.setEncoding("utf8");
    proc.stderr.on("data", (c) => { err += c; });
    proc.on("error", reject);
    proc.on("exit", () => {
      const text = out + err;
      const defaultLabel = readDefault();
      if (/sign in/i.test(text)) return reject(new Error(text.trim()));
      // 一覧は stdout から読む。stdout に何も無いときだけ stderr も見る（以前の読み方）
      const fromOut = parseAgyModels(out);
      const rows = fromOut.length ? fromOut : parseAgyModels(text);
      if (!rows.length) return reject(new Error(text.trim() || t("antigravity.errors.noModels")));
      resolve({ rows, defaultLabel });
    });
  });
}

function spawnModels(log) {
  // `--log-file` は agy 全体のフラグなのでサブコマンドより前。既定のモデルを読むためだけに使い、読んだら消す
  return spawnCli(cliCommand("antigravity"), ["--log-file", log, "models"], { stdio: ["ignore", "pipe", "pipe"] });
}

/** 引けた一覧だけを覚える（失敗は覚えない。前に引けた一覧を残す） */
function rememberModels(list) {
  if (!list?.rows?.length) return;
  modelCache = buildAgyModels(list.rows, list.defaultLabel);
}

// サーバが終わったら、生かしている agy を道連れにする。
// **SIGINT / SIGTERM のハンドラは足さない**（server はワーカースレッドでも動く。
// 既定の終了挙動を変えないため、`exit` の範囲に留める）。
process.once("exit", () => {
  const gone = [];
  for (const session of live.values()) {
    try { session.kill(); } catch {}
    // Pleiad のコンテキストを渡したエージェント定義も消す（agy の exit はもう受け取れない）
    session.cleanup();
    if (session.pid) gone.push(session.pid);
  }
  live.clear();
  pids.forget(...gone);
});

export { MODES, TOOL_HINTS, turnResultFor, usageFor };
