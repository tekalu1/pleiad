// `codex app-server` と話す JSON-RPC 2.0 クライアント（stdio・改行区切り）。
//
// **1 プロセスを全セッションで共有する**（docs/multi-backend.md §2.5）。
// セッションごとに codex を立てると、10 本並行で回したときにプロセスが 10 個増え、
// それぞれが ~/.codex を読み書きする。app-server は threadId で多重化できるので、
// 1 本に集約して threadId で振り分ける。
//
// 起動は遅延。落ちたら次の呼び出しで立て直す（`request` が黙って再起動する）。
// 立て直すと走っていたターンは失われるが、**pending だけは必ず reject する**。
// 握り潰すと runTurn が永久に返らず、server の turns から消えなくなる。
//
// 実行ファイルは AGENT_HOST_CODEX_BIN。既定は `codex`。
// テストのために `node tests/lib/fake-codex.mjs` のような**コマンド文字列**も受ける。
//
// 共有の app-server は、保持役（core/holder/）の子に載せられる（無停止の更新 段階 3。core/backends/codex-held.mjs。docs/zero-downtime-update/stage3-codex.md）。
// 載せたときの違い: 起動と stdin・stdout は保持役の口（held）を通る。付け直した app-server（adopted）には initialize を送らない。依頼の id は世代つきの文字列にして、
// 前のサーバーの依頼の応答（記録に残る）を取り違えない。付け直すスレッドは expect → adoptThread で、記録の再生と預かった frame を順に渡す
import { cliCommand, spawnCli } from "../cli-installation.mjs";
import { t } from "../i18n.mjs";
import { acquireHeldAppServer } from "./codex-held.mjs";

const NL = String.fromCharCode(10);

const CLIENT_INFO = { name: "agent-host", title: "agent-host", version: "0.0.0" };

/** 立ち上がりを待つ上限。codex.exe は 300MB あるので初回は遅い。 */
const START_TIMEOUT_MS = Number(process.env.AGENT_HOST_CODEX_START_MS ?? 60_000);

/** stop() がプロセスの終わりを待つ上限。kill の後はふつう数十ミリ秒で終わる */
const STOP_WAIT_MS = 3_000;

/** thread/start の応答待ちのあいだ預かる frame の上限。溢れた分は受け手の居ないものとして扱う */
const MAX_HELD = 1000;
/** 付け直すスレッドの記録の再生が済むまで預かる frame の上限（落とすと承認の依頼が子に届かず、子が待ち続ける） */
const MAX_HELD_ADOPT = 100_000;
/** 子 -> 親の対応を覚えておく上限。古いものから忘れる（1 本の子は数十バイト） */
const MAX_CHILDREN = 5000;

/** 行き先の決まっていない frame の印（#target の戻り値） */
const HOLD = Symbol("hold");

const threadIdOf = (params) =>
  params?.threadId ?? params?.thread_id ?? params?.conversationId ?? params?.thread?.id ?? null;

export { parseCommand } from "../command-line.mjs";

export function tomlValue(v) {
  if (Array.isArray(v)) return '[' + v.map(tomlValue).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.entries(v).map(([k,s]) => JSON.stringify(k) + '=' + tomlValue(s)).join(',') + '}';
  return JSON.stringify(v);
}
function launch(config = {}) {
  return spawnCli(cliCommand("codex"), ["app-server", ...Object.entries(config).flatMap(([k,v]) => ['-c', `${k}=${tomlValue(v)}`])], { stdio: ["pipe", "pipe", "pipe"] });
}

/** 保持役の口（held。core/backends/codex-held.mjs）を ChildProcess のように見せる（stdin の書き込みと kill だけ） */
function heldProc(held) {
  return {
    exitCode: null,
    signalCode: null,
    stdin: { get writable() { return held.writable; }, write: (text) => held.write(text), end() {} },
    kill: () => held.kill(),
  };
}

export class CodexRpc {
  /** acquire: 保持役の口を取る（async。載せない・載せられないときは null）。共有の app-server だけが渡す */
  constructor(config = {}, { acquire = null } = {}) {
    this.config = config;
    this.acquire = acquire;
    this.heldChannel = null;    // 保持役の口（載せたとき）
    this.idPrefix = null;       // 載せたときの依頼の id の世代（文字列の id にする）
    this.handedOff = false;     // 新しいサーバーへ手を離した（以後この app-server に書かない・読まない）
    this.lastSeq = 0;           // 載せたときに、処理し終えた記録の通番
    this.expecting = new Set(); // 付け直すスレッド。ハンドラーが付くまで、行き先の分からない frame を預かる
    this.proc = null;
    this.ready = null;          // 起動中の Promise。並行して呼ばれても1回しか立てない
    this.nextId = 0;
    this.pending = new Map();   // request id -> { resolve, reject }
    this.buf = "";
    this.stderr = [];           // 落ちたときに理由を言えるように直近だけ残す
    // threadId -> { onNotification(method, params), onRequest(method, params, child), onChildNotification?, onGone? }
    this.threads = new Map();
    // thread/start の応答を待っているセッション。threadId がまだ無いので、何も渡さずに
    // 見知らぬ threadId の frame を held に預かり、adopt で自分の分だけ受け取る
    this.claims = new Set();
    this.held = [];
    // サブエージェント（子スレッド） -> 親。孫は子を指すので、たどって attach 済みの親を探す
    this.parents = new Map();
    // 子スレッド -> { nickname, path, role }。承認カードに「どの子か」を出すため
    this.agents = new Map();
    // スレッドに属さない通知（account/login/completed など）の聞き手
    this.listeners = new Set();
    // プロセスが落ちた・入れ替わったときの聞き手。attach していない見張り（バックグラウンド端末）が使う
    this.downs = new Set();
    // app-server につながった（起こした・付け直した）ときの聞き手。保持役の子を引き継いだとき、前のサーバーの控えを戻すのに使う
    this.starts = new Set();
  }

  /** app-server につながったときに呼ばれる（引数は保持役の口。載せていなければ null）。返り値を呼ぶと外れる */
  onStart(fn) {
    this.starts.add(fn);
    return () => this.starts.delete(fn);
  }

  /** 全部の notification を受け取る。スレッドに属さないもの（ログイン完了）を拾うのに使う。 */
  onNotify(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /**
   * app-server が落ちた・入れ替わったときに呼ばれる。返り値を呼ぶと外れる。
   * `onGone` は attach 済みのスレッドにしか届かないので、ターンの外で見張っている側はこちらを使う
   * （走っていた端末は道連れになる。数えたままにすると印が消えなくなる）。
   */
  onDown(fn) {
    this.downs.add(fn);
    return () => this.downs.delete(fn);
  }

  /** セッションを登録する。返り値を呼ぶと外れる。 */
  attach(threadId, handlers) {
    if (!threadId) return () => {};
    this.threads.set(threadId, handlers);
    return () => { if (this.threads.get(threadId) === handlers) this.threads.delete(threadId); };
  }

  /**
   * thread/start の応答が来るまでの隙間を埋める。返り値を呼ぶと取り下げる。
   *
   * **この間に来た見知らぬ threadId の frame は、誰にも渡さずに預かる。**
   * 以前は全部をこのハンドラへ流していたので、子スレッドの通知、終わったターンに遅れて来る
   * item/completed、別セッションの後片付けが新しい会話に混ざった。
   * 応答で id が分かったら adopt が自分の分だけを順に渡す。残りは最後の取り下げで
   * 受け手の居ないものとして片付ける（request にはエラーを返す。codex を待たせたままにしない）。
   * 同時にいくつ張ってもよい（新規セッションを並行して始めても取り合わない）。
   */
  claimOrphan(handlers) {
    this.claims.add(handlers);
    return () => this.#unclaim(handlers);
  }

  /** thread/start が返した id で attach し、預かっていたその id の frame を届いた順に渡す。 */
  adopt(threadId, handlers) {
    const detach = this.attach(threadId, handlers);
    const mine = this.held.filter((m) => threadIdOf(m.params) === threadId);
    this.held = this.held.filter((m) => !mine.includes(m));
    for (const m of mine) this.#deliver(m, false);
    this.#unclaim(handlers);
    return detach;
  }

  #unclaim(handlers) {
    if (!this.claims.delete(handlers)) return;
    this.#settleHeld();
  }

  /** 誰も待っていなくなった（claim も付け直しの待ちも無い）。預かり物は、今の振り分けで行き先があればそこへ、無ければ捨てる */
  #settleHeld() {
    if (this.claims.size || this.expecting.size) return;
    for (const m of this.held.splice(0)) this.#deliver(m, false);
  }

  /**
   * 付け直すスレッドの待ち（保持役の子を引き継いだとき）。adoptThread か unexpect で外れるまで、行き先の分からない frame を預かり、
   * 記録の読み込み（ack）も進めない（付け直す先に渡る前の frame を、次のサーバーが落ちたときに失わないため）
   */
  expect(threadId) {
    if (threadId) this.expecting.add(threadId);
  }

  /** 付け直しをあきらめた・済んだ。待ちが無くなったら、預かった frame を片付けて ack する */
  unexpect(threadId) {
    if (!this.expecting.delete(threadId)) return;
    this.#settleHeld();
    this.#ackIfSettled();
  }

  /**
   * 付け直すスレッドを引き取る。記録の再生（lines = 印から ack までの [通番, 行]）を、ハンドラーへ順に渡し、預かっていた続きの frame を渡す。
   * 再生では、答えが残っている依頼（pendingKeys = 保持役の控えの鍵。JSON.stringify(id)）だけを渡し直す（旧サーバーが答えたものは出し直さない）。
   * 通知は全部の聞き手にも渡す（第 3 引数 { replay: true }）。返り値を呼ぶと外れる。同期（再生と預かりの引き渡しの間に、新しい frame は割り込まない）
   */
  adoptThread(threadId, handlers, { lines = [], pendingKeys = new Set() } = {}) {
    this.threads.set(threadId, handlers);
    for (const [, line] of lines) this.#replayLine(line, pendingKeys, threadId);
    this.expecting.delete(threadId);
    const held = this.held;
    this.held = [];
    for (const m of held) this.#deliver(m, true);
    this.#settleHeld();
    this.#ackIfSettled();
    return () => { if (this.threads.get(threadId) === handlers) this.threads.delete(threadId); };
  }

  /** 記録の 1 行を再生する。記録は全部のスレッドの出力が混ざるので、このスレッド（と子孫のサブエージェント）の分だけ渡す */
  #replayLine(line, pendingKeys, root) {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (!msg?.method) return;                     // 応答は、付け直す前のサーバーが受け取った
    // 子スレッドの親子は、通知から先に覚える（その子の以後の行を、親の分として選べるように）
    if (msg.id === undefined) this.#learn(msg.method, msg.params);
    const id = threadIdOf(msg.params);
    if (!id || (id !== root && this.#rootOf(id) !== root)) return;
    if (msg.id !== undefined) {
      if (pendingKeys.has(JSON.stringify(msg.id))) this.#deliver(msg, false);
      return;
    }
    for (const fn of [...this.listeners]) {
      try { fn(msg.method, msg.params ?? {}, { replay: true }); } catch {}
    }
    this.#deliver(msg, false);
  }

  /** 子スレッドの親子を直に覚える（印より前に生まれた子を、thread/list の parentThreadId から引き直すとき） */
  learnChild(id, parent, info = {}) {
    this.#child(id, parent, info, true);
  }

  /** 新しいサーバーへ手を離した（保持役に detach した）。以後この app-server には何も書かず、何も読まない。待っている依頼は手を離したことで断る */
  #handedOff() {
    this.handedOff = true;
    this.proc = null;
    this.ready = null;
    this.heldChannel = null;
    const err = new Error(t("codex.errors.handedOff"));
    for (const [, p] of [...this.pending]) p.reject(err);
    this.pending.clear();
    this.held = [];
    this.expecting.clear();
  }

  async start() {
    if (this.handedOff) throw new Error(t("codex.errors.handedOff"));
    if (this.proc && this.proc.exitCode === null && this.proc.signalCode === null) return this.ready;
    if (this.ready) return this.ready;

    this.ready = (async () => {
      // 保持役の子に載せる（共有の app-server だけ）。載せられなければ今の形で起こす
      const held = this.acquire ? await this.acquire(this.config).catch((err) => {
        console.error("  codex: 保持役に載せられないので今の形で app-server を起こす:", String(err?.message ?? err));   // i18n-ignore: サーバーのログ
        return null;
      }) : null;
      const proc = held ? heldProc(held) : launch(this.config);
      this.proc = proc;
      this.heldChannel = held;
      this.idPrefix = held ? `${process.pid}.${Date.now().toString(36)}.` : null;
      this.buf = "";
      this.stderr = [];

      const die = (why) => {
        if (this.proc !== proc) return;
        this.proc = null;
        this.ready = null;
        this.heldChannel?.dispose();
        this.heldChannel = null;
        const err = new Error(t("codex.errors.appServerDied", { why }) + (this.stderr.length ? NL + this.stderr.join("") : ""));
        // 待っている request を必ず片付ける。ここを握り潰すと runTurn が返らない
        for (const [, p] of [...this.pending]) p.reject(err);
        this.pending.clear();
        // 預かっていた frame は落ちたプロセスのもの。立て直した先に応答を返すと id を取り違える
        this.held = [];
        this.expecting.clear();
        for (const [, h] of [...this.threads]) h.onGone?.(err);
        for (const fn of [...this.downs]) { try { fn(err); } catch {} }
      };
      if (held) {
        for (const threadId of held.expected ?? []) this.expect(threadId);   // 付け直すスレッド（引き継いだ子の札）。ハンドラーが付くまで frame を預かる
        held.run({
          line: (text, seq) => this.#lineIn(text, seq),
          err: (chunk) => {
            this.stderr.push(String(chunk));
            if (this.stderr.length > 40) this.stderr.shift();
          },
          exit: (info) => die(info.error ? String(info.error) : `exit=${info.code} signal=${info.signal}`),
          lost: (reason) => die(String(reason)),
          handedOff: () => this.#handedOff(),
        });
      } else {
        proc.stdout.setEncoding("utf8");
        proc.stdout.on("data", (chunk) => this.#feed(chunk));
        proc.stderr.setEncoding("utf8");
        proc.stderr.on("data", (chunk) => {
          this.stderr.push(String(chunk));
          if (this.stderr.length > 40) this.stderr.shift();
        });
        proc.on("exit", (code, sig) => die(`exit=${code} signal=${sig}`));
        proc.on("error", (err) => die(String(err?.message ?? err)));
      }
      for (const fn of [...this.starts]) { try { fn(held); } catch {} }
      // 付け直した子は initialize 済み（段階 0: 2 回目の initialize は Already initialized を返すだけ。送らない）
      if (held?.adopted) return { adopted: true };

      // initialize -> notification initialized。この 2 手を踏まないと以降が通らない。
      const info = await this.#request("initialize", {
        clientInfo: CLIENT_INFO,
        capabilities: { experimentalApi: true },
      }, START_TIMEOUT_MS);
      this.#send({ jsonrpc: "2.0", method: "initialized" });
      return info;
    })();

    try {
      return await this.ready;
    } catch (err) {
      this.ready = null;
      try { this.proc?.kill(); } catch {}
      this.proc = null;
      throw err;
    }
  }

  /** 1 往復。起動していなければ起動する。落ちていたら立て直す。 */
  async request(method, params = {}, timeoutMs = 0) {
    await this.start();
    return this.#request(method, params, timeoutMs);
  }

  /** notification を送る（応答を待たない）。 */
  async notify(method, params = {}) {
    await this.start();
    this.#send({ jsonrpc: "2.0", method, params });
  }

  #request(method, params, timeoutMs) {
    const id = this.idPrefix ? `${this.idPrefix}${++this.nextId}` : ++this.nextId;
    return new Promise((resolve, reject) => {
      let timer = null;
      const done = (fn) => (v) => { if (timer) clearTimeout(timer); this.pending.delete(id); fn(v); };
      this.pending.set(id, { resolve: done(resolve), reject: done(reject) });
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          const p = this.pending.get(id);
          if (p) p.reject(new Error(t("codex.errors.timeout", { method, ms: timeoutMs })));
        }, timeoutMs);
        timer.unref?.();
      }
      try {
        this.#send({ jsonrpc: "2.0", id, method, params });
      } catch (err) {
        this.pending.get(id)?.reject(err);
      }
    });
  }

  #send(frame) {
    const proc = this.proc;
    if (!proc?.stdin?.writable) throw new Error(t("codex.errors.notConnected"));
    proc.stdin.write(JSON.stringify(frame) + NL);
  }

  /** 保持役の記録の 1 行（行ごとに通番がある）。処理し終えたら通番を覚える（ack は付け直す先が全部のスレッドを引き取った後） */
  #lineIn(text, seq) {
    const line = text.trim();
    if (line) {
      let msg = null;
      try { msg = JSON.parse(line); } catch { /* JSON でない行は落とす */ }
      if (msg) this.#dispatch(msg);
    }
    this.lastSeq = seq;
    this.#ackIfSettled();
  }

  #ackIfSettled() {
    if (!this.expecting.size) this.heldChannel?.ack(this.lastSeq);
  }

  #feed(chunk) {
    this.buf += chunk;
    let i;
    while ((i = this.buf.indexOf(NL)) >= 0) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        // JSON でない行（起動時のバナーなど）は落とす。止まる理由にはしない
        continue;
      }
      this.#dispatch(msg);
    }
  }

  #dispatch(msg) {
    // 1) こちらが出した request の応答
    if (msg.id !== undefined && msg.method === undefined) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      if (msg.error) p.reject(Object.assign(new Error(`codex ${msg.error.code}: ${msg.error.message ?? ""}`), { code: msg.error.code }));
      else p.resolve(msg.result);
      return;
    }

    if (!msg.method) return;

    // 2) notification。threadId を持たないもの（ログイン完了）は listeners が拾う。
    // 子スレッドの親子関係は、振り分けより先に覚える（同じ frame の振り分けから効かせる）
    if (msg.id === undefined) {
      this.#learn(msg.method, msg.params);
      for (const fn of [...this.listeners]) {
        try { fn(msg.method, msg.params ?? {}); } catch {}
      }
    }
    // 3) notification と server -> client の request（承認・質問）を、threadId でセッションへ
    this.#deliver(msg, true);
  }

  /** frame を行き先へ渡す。canHold が偽なら預からない（預かり物を出すときに使う）。 */
  #deliver(msg, canHold) {
    const to = this.#target(msg.params);
    if (to === HOLD && canHold && this.held.length < (this.expecting.size ? MAX_HELD_ADOPT : MAX_HELD)) {
      this.held.push(msg);
      return;
    }
    const h = to === HOLD ? null : to?.h ?? null;
    const child = to === HOLD ? null : to?.child ?? null;

    // request には必ず応答を返す
    if (msg.id !== undefined) {
      Promise.resolve()
        .then(() => {
          if (!h?.onRequest) throw new Error(t("codex.errors.noHandler", { method: msg.method }));
          return h.onRequest(msg.method, msg.params ?? {}, child);
        })
        .then(
          (result) => this.#send({ jsonrpc: "2.0", id: msg.id, result: result ?? {} }),
          (err) => this.#send({
            jsonrpc: "2.0", id: msg.id,
            error: { code: -32000, message: String(err?.message ?? err) },
          }),
        )
        .catch(() => {});   // 応答自体が書けない（プロセスが落ちた）ときは諦める
      return;
    }

    try {
      // 子の通知は親の本文・ツールとは別の口へ。親の onNotification に入れると親の発言として出てしまう
      if (child) h?.onChildNotification?.(msg.method, msg.params ?? {}, child);
      else h?.onNotification?.(msg.method, msg.params ?? {});
    } catch (err) {
      console.error("  codex 通知の処理で例外:", String(err?.message ?? err));
    }
  }

  /**
   * params の threadId から行き先を決める。
   *   - attach 済みのスレッド -> { h }
   *   - その子孫（サブエージェント）で、たどった先の親が attach 済み -> { h: 親, child }
   *   - 子孫だが親がもう居ない（ターンが終わった） -> null（request はエラー、通知は捨てる）
   *   - 見知らぬ threadId で thread/start の応答待ちがある -> HOLD（自分のものかもしれない）
   */
  #target(params) {
    const id = threadIdOf(params);
    if (!id) {
      // threadId を持たない通知（起動時の告知など）は、走っているものが1本ならそこへ。
      // 2本以上あるときは取り違えるより落とす。どのスレッドのものか分からないので預からない
      return this.threads.size === 1 ? { h: [...this.threads.values()][0] } : null;
    }
    if (this.threads.has(id)) return { h: this.threads.get(id) };
    if (this.parents.has(id)) {
      const root = this.#rootOf(id);
      if (root) return { h: this.threads.get(root), child: { threadId: id, ...this.agents.get(id) } };
      // 親がまだ付かない（付け直し）。付くまで預かる
      return this.expecting.size ? HOLD : null;
    }
    return this.claims.size || this.expecting.size ? HOLD : null;
  }

  /** 子から親をたどり、attach 済みのものを返す。孫の承認も会話を持つ最上位の親へ出す。 */
  #rootOf(id) {
    const seen = new Set([id]);
    for (let cur = this.parents.get(id); cur && !seen.has(cur); cur = this.parents.get(cur)) {
      if (this.threads.has(cur)) return cur;
      seen.add(cur);
    }
    return null;
  }

  /**
   * 通知から子スレッドの親を覚える（スキーマと、Pleiad が gpt-6-astra で動かした rollout の形）。
   *   - thread/started: thread.parentThreadId か source.subAgent.thread_spawn.parent_thread_id。名前もここにある
   *   - collabAgentToolCall(spawnAgent): receiverThreadIds が新しい子、senderThreadId が親
   *   - subAgentActivity: 親のターンに記録される。agentThreadId が子、agentPath が名前
   * thread/started が正。ほかは知らない子のときだけ足す（send_message などで兄弟を親と取り違えない）。
   */
  #learn(method, params) {
    if (method === "thread/started") {
      const t = params?.thread;
      const spawn = t?.source?.subAgent?.thread_spawn;
      this.#child(t?.id, t?.parentThreadId ?? spawn?.parent_thread_id, {
        nickname: t?.agentNickname ?? spawn?.agent_nickname,
        path: spawn?.agent_path,
        role: t?.agentRole ?? spawn?.agent_role,
      }, true);
      return;
    }
    if (method !== "item/started" && method !== "item/completed") return;
    const item = params?.item;
    if (item?.type === "collabAgentToolCall" && item.tool === "spawnAgent") {
      for (const id of item.receiverThreadIds ?? []) this.#child(id, item.senderThreadId ?? params?.threadId);
    } else if (item?.type === "subAgentActivity") {
      this.#child(item.agentThreadId, params?.threadId, { path: item.agentPath });
    }
  }

  #child(id, parent, info = {}, sure = false) {
    if (!id || !parent || id === parent) return;
    if (sure || !this.parents.has(id)) this.parents.set(id, parent);
    const known = this.agents.get(id) ?? {};
    for (const [k, v] of Object.entries(info)) if (v) known[k] = v;
    this.agents.set(id, known);
    while (this.parents.size > MAX_CHILDREN) {
      const oldest = this.parents.keys().next().value;
      this.parents.delete(oldest);
      this.agents.delete(oldest);
    }
  }

  /**
   * プロセスを止める（ターン用の app-server の片付け・テスト・プロセス終了）。返りはプロセスが終わったら（長くても waitMs で）解ける。
   * 待つのは、止めたプロセスが履歴の DB を開いたまま、共有の app-server が同じ DB を読むと、Windows で
   * `(code: 1546) disk I/O error` になることがあるため（core/history-retry.mjs）。呼び出し側は待たなくてもよい
   */
  stop({ waitMs = STOP_WAIT_MS } = {}) {
    const proc = this.proc;
    const channel = this.heldChannel;
    this.proc = null;
    this.ready = null;
    this.heldChannel = null;
    // 保持役の子は、手を離していれば止めない（新しいサーバーが引き継ぐ。stop は終了の時にも呼ばれる）
    if (channel) return channel.stop({ waitMs });
    const exited = !proc || proc.exitCode !== null || proc.signalCode !== null ? Promise.resolve() : new Promise((resolve) => {
      const timer = setTimeout(resolve, waitMs);
      timer.unref?.();
      proc.once("exit", () => { clearTimeout(timer); resolve(); });
    });
    try { proc?.stdin?.end(); } catch {}
    try { proc?.kill(); } catch {}
    return exited;
  }
}

export const rpc = new CodexRpc({}, { acquire: acquireHeldAppServer });
process.once('exit', () => rpc.stop());
