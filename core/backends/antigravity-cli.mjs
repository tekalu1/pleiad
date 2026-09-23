// Antigravity CLI（`agy`）のヘッドレス接続。
//
// **なぜ ACP ではないのか**: `agy` は ACP を話さない（[antigravity-cli#31] は要望のまま）。
// 公式のプログラム向け口は `--print= --input-format stream-json --output-format stream-json` で、
// 行区切り JSON（NDJSON）を stdin から受け、stdout へ流す。
//
// **codex / gemini との決定的な違い: 1 プロセス = 1 会話。**
// stream-json は「1 行 1 プロンプト、1 行につき 1 ターン」を**同じ会話の中で**回す。
// 会話ごとに独立したプロセスを立て、生かしたまま次のターンを待つ。
//
// 実機（agy 1.2.4 / windows-x64）で確かめたこと:
//   - **`--print` は次のフラグを prompt として飲み込む。** `--print` と書くと
//     `--input-format` が prompt 扱いになり、`agy` 自身がそう警告してくる。
//     **`--print=`（空値を付ける）が正しい**
//   - 未ログインだと stderr に OAuth の URL を出し、**stdin で認可コードを待つ**（既定 60 秒）。
//     つまりログインもここから駆動できる（認可コードの手貼りの経路に載る）
//   - 認証に失敗しても `{"event":"result","result":{…,"status":"ERROR","error":…}}` は必ず出る
//   - **`--print-timeout`（既定 5m0s）がターンを打ち切る。** 打ち切られると stderr に
//     `[agy] print timeout after 5m0s with turn in progress; returning partial output` を出し、
//     **`status:"SUCCESS"` / `response:""` / `usage` 全 0** の `result` を吐く。
//     しかも agy 本体はその後も裏でターンを回し続ける（実例では 3 時間）。
//     そこで **明示的に長い値を渡し**、それでも打ち切られたら `onPrintTimeout` で気づけるようにする
//
// イベントは 3 種類（公式ドキュメント。`result` は実機でも確認）:
//   {"event":"init","conversation_id":…,"init":{"cwd","tools","permission_mode","model","agent"}}
//   {"event":"step_update","step_update":{"conversation_id","step_index","state","step_type",…}}
//   {"event":"result","result":{"conversation_id","status","response","duration_seconds","num_turns","usage"}}
//
// 実行ファイルは AGENT_HOST_AGY_BIN。既定は `agy`。
import { cliCommand, spawnCli } from "../cli-installation.mjs";

const NL = String.fromCharCode(10);

/** 認可コードの入力待ちに見える stderr の印（実機の文面）。 */
const AUTH_URL_RE = /(https:\/\/accounts\.google\.com\/o\/oauth2\/auth\?\S+)/;

/** 出力を打ち切ったときの stderr の印（実機の文面）。 */
const PRINT_TIMEOUT_RE = /print timeout after .* with turn in progress/i;

/**
 * `--print-timeout` に渡す値。**Go の duration 文字列**（`24h` / `90m` / `5m0s` など）。
 *
 * agy の既定は `5m0s` で、5 分を超えたターンは本文が空のまま「成功」で返る（上のコメント）。
 * 打ち切らせないために十分長い値を既定にする。
 */
const PRINT_TIMEOUT = String(process.env.AGENT_HOST_AGY_PRINT_TIMEOUT ?? "24h");

/** 立ち上がりと最初のイベントを待つ上限。`agy` は 190MB の単一バイナリで初回は遅い。 */
const START_TIMEOUT_MS = Number(process.env.AGENT_HOST_AGY_START_MS ?? 120_000);

/**
 * 1 会話ぶんの `agy` プロセス。
 *
 * ターンごとに `send()` で 1 行流し、`result` が来るまで待つ。
 * 中断の口はプロトコルに無い（公式ドキュメントにも記載が無い）ので、**プロセスを落とす**。
 * 会話はサーバ側に残っていて `--conversation <id>` で拾い直せるので、これで失われない。
 */
export class AgySession {
  constructor({ cwd, conversationId = null, model, effort, mode, skipPermissions, addDirs = [], agent = null, env = null, onGone = null }) {
    this.cwd = cwd;
    this.conversationId = conversationId;
    this.model = model;
    this.effort = effort;
    this.mode = mode;
    this.skipPermissions = skipPermissions;
    this.addDirs = addDirs;
    this.agent = agent;        // `--agent`。Pleiad のコンテキストを渡すときのカスタムエージェント（antigravity-context.mjs）
    this.env = env;            // agy に足す環境変数（ply_context の接続先とトークン）
    this.onGone = onGone;      // プロセスが終わった・落とした後の片付け（1 回だけ呼ぶ）

    this.proc = null;
    this.pid = null;           // 起こした agy の pid。**落とした後も残す**（孤児の掃除に使う）
    this.buf = "";
    this.stderr = [];
    this.exited = null;        // 落ちた理由（Error）。落ちていなければ null

    this.onEvent = null;       // (event) => void
    this.onAuthUrl = null;     // (url) => void
    this.onPrintTimeout = null; // () => void
    this.onExit = null;        // (err) => void
  }

  /** 組み立てた引数。`--print=` の空値がここの肝（上のコメント参照）。 */
  args() {
    const out = [
      "--print=", "--input-format", "stream-json", "--output-format", "stream-json",
      // 既定の 5m0s だと長いターンが空の SUCCESS で打ち切られる（冒頭のコメント）
      "--print-timeout", PRINT_TIMEOUT,
    ];
    if (this.conversationId) out.push("--conversation", this.conversationId);
    if (this.model) out.push("--model", this.model);
    if (this.effort) out.push("--effort", this.effort);
    // `--mode` は accept-edits / plan の 2 つだけ（`agy --help` で確認）。
    // 「全部自動」は --mode ではなく --dangerously-skip-permissions
    if (this.mode) out.push("--mode", this.mode);
    if (this.skipPermissions) out.push("--dangerously-skip-permissions");
    for (const dir of this.addDirs) out.push("--add-dir", dir);
    if (this.agent) out.push("--agent", this.agent);
    return out;
  }

  start() {
    if (this.proc) return;
    const proc = spawnCli(cliCommand("antigravity"), this.args(), {
      cwd: this.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      ...(this.env ? { env: { ...process.env, ...this.env } } : {}),
    });
    this.proc = proc;
    this.pid = proc.pid ?? null;

    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (chunk) => this.#feed(chunk));

    proc.stderr.setEncoding("utf8");
    proc.stderr.on("data", (chunk) => {
      const text = String(chunk);
      this.stderr.push(text);
      if (this.stderr.length > 60) this.stderr.shift();
      // 未ログインのときはここに OAuth の URL が出る。認可コードは stdin で受ける
      const hit = AUTH_URL_RE.exec(text);
      if (hit) this.onAuthUrl?.(hit[1]);
      // 打ち切られた。この後の `result` は SUCCESS でも信じてはいけない
      if (PRINT_TIMEOUT_RE.test(text)) this.onPrintTimeout?.();
    });

    const die = (why) => {
      if (this.proc !== proc) return;
      this.proc = null;
      this.exited = new Error(`agy が終了した: ${why}${this.stderr.length ? NL + this.stderr.join("") : ""}`);
      this.onExit?.(this.exited);
    };
    proc.on("exit", (code, sig) => die(`exit=${code} signal=${sig}`));
    proc.on("error", (err) => die(String(err?.message ?? err)));
    // 片付けはプロセスが本当に終わってから（kill() の後でも exit は来る。die は来ない）
    proc.once("exit", () => this.#gone());
    proc.once("error", () => { if (proc.exitCode === null && !proc.pid) this.#gone(); });
  }

  /** 片付けを今すぐ走らせる（サーバの終了時。exit を待てないため）。2 回目以降は何もしない */
  cleanup() {
    this.#gone();
  }

  #gone() {
    const done = this.onGone;
    this.onGone = null;
    try { done?.(); } catch {}
  }

  /** 1 ターンぶんのプロンプトを流す。`agy` は 1 行につき 1 ターンを回す。 */
  prompt(text) {
    this.#write(JSON.stringify({ event: "user", message: { content: String(text ?? "") } }));
  }

  /** 未ログインのときに stdin で待っている認可コードを渡す。 */
  submitAuthCode(code) {
    this.#write(String(code ?? "").trim());
  }

  #write(line) {
    const proc = this.proc;
    if (!proc?.stdin?.writable) throw new Error("agy につながっていない");
    proc.stdin.write(line + NL);
  }

  /** stdin を閉じる。`agy` は走っているターンを終えてから落ちる（公式の畳み方）。 */
  close() {
    try { this.proc?.stdin?.end(); } catch {}
  }

  /** 中断と後片付け。プロトコルに中断が無いので落とす。 */
  kill() {
    const proc = this.proc;
    this.proc = null;
    try { proc?.stdin?.end(); } catch {}
    try { proc?.kill(); } catch {}
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
        // JSON でない行（バナー・更新の案内）は落とす。止まる理由にはしない
        continue;
      }
      try {
        this.onEvent?.(msg);
      } catch (err) {
        console.error("  agy イベントの処理で例外:", String(err?.message ?? err));
      }
    }
  }
}

export { START_TIMEOUT_MS, PRINT_TIMEOUT, PRINT_TIMEOUT_RE };
