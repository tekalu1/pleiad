// procway-code バックエンド。
//
// procway-code の native serve を子プロセスで起こし（procway-serve.mjs）、
//   セッションごとに WebSocket `/ws?token=&session=<id>&cwd=<絶対パス>` を張る。
// MCP でも stdio JSON でもない。ライブラリ直結（createAgentSession）もあるが、
// それを選ぶと procway-code の依存一式が agent-host のプロセスに入ってくるので採らない。
//
// このファイルが引き受けている非対称は 3 つ。
//
//  1. **park（駐車）方式の承認**。procway の承認は Promise でターンを止めない。
//     要求を記録してプレースホルダの tool_result を差し込み、`turn.completed` で
//     ターンを一度畳む。`approve` を受けてから続きが**デタッチで**走り、
//     もう一度 `turn.completed` が来る。agent-host の 1 ターンは
//     「turn.completed が来て、かつ未解決の承認・質問が無い」までで、
//     `turnResult` はその時点で 1 回だけ出す（§park の扱い）。
//
//  2. **UIR（質問）は `interaction.resolve` だけでは会話が進まない**（付録 A.4）。
//     回答を送ったあと、回答文をプロンプトにして `runTurn` を続けて投げる。
//
//  3. **provider / model は WS でもターンでも渡せない**。会話単位の子プロセスに
//     設定を渡し、変更時はその会話の次の送信で入れ替える。別会話に影響させない。
//
// タイトル / 状態タグを procway は持たない（capabilities.title / tag = false）。
// sidecar が正本になる（server.mjs が capabilities を見てネイティブ書き込みを飛ばす）。
//
// **ターンの外でも聞き続ける**（docs/multi-backend.md §2.7）。procway は Pleiad が送っていないターンを
// 自分で始める（wake: バックグラウンドの子が終わると、結果を渡すターンを差し込む）。
// イベントは接続に常駐する振り分け（conn.route）が受け、Pleiad のターンか外部ターン
// （server の externalTurn）に渡す。裏の子の数も同じ場所で数え、server の background へ渡す。
import { cliCommand, spawnCli } from "../cli-installation.mjs";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import WebSocket from "ws";
import { MAX_RESULT_CHARS } from "./shared.mjs";
import { loginOpenAICodex } from "../auth/openai-codex-oauth.mjs";
import * as tokens from "../auth/procway-token-store.mjs";
import { fileURLToPath } from 'node:url';
import { listConnections, resolveConnection, procwaySource } from '../procway-config.mjs';
import { createMcpConfig } from '../mcp-config.mjs';
import { suggestProcwayTitle } from '../procway-title.mjs';
import { createBackgroundTracker } from './procway-background.mjs';

// server が渡す口（attachHost）。ターンの外で起きたこと（裏の子の数、外部ターン）を届ける先。
// 無い（server を通さずに使う）ときは、ターンの外のイベントを今までどおり捨てる。
let host = null;

// 区切り（下の「ターンの運転」）に属するイベント。持ち主の居ない区切りで来たら外部ターンを起こすのは
// 本文・ツール・質問だけ（usage や activity だけで外部ターンを立てない）
const SEGMENT_EVENTS = new Set([
  "assistant.message.delta", "assistant.reasoning.delta", "assistant.message.completed",
  "tool.call.scheduled", "tool.call.started", "tool.call.completed",
  "activity.started", "activity.tick", "activity.stopped", "compact.started", "compact.completed",
  "usage.recorded", "interaction.requested",
]);
const STARTS_SEGMENT = new Set([
  "assistant.message.delta", "assistant.reasoning.delta", "assistant.message.completed",
  "tool.call.scheduled", "tool.call.started", "tool.call.completed", "interaction.requested",
]);

function createWorker() {
let runtimeConfig = null;
// この worker（= 1 会話）の Pleiad 側の会話 id。server の externalTurn / background に渡す
let hostId = null;
// Pleiad が最後にこの会話で選んだ承認モード。procway が自分で始めるターン（wake）は runTurn の options を
// 持たず settings.approvalMode で走るので、serve の settings にも同じ値を入れておく（procway-serve.mjs）
let approvalModeNow = "always-ask";
// 裏で動いている子エージェント（procway-background.mjs）。serve の寿命と同じだけ持つ
const behind = createBackgroundTracker();
const reportBackground = () => { if (host && hostId) host.background(hostId, behind.list()); };

// Resolve the installed CLI at launch time; an explicit cli.mjs override is supported.

const SERVE_START_TIMEOUT_MS = Number(process.env.AGENT_HOST_PROCWAY_START_MS ?? 30_000);
const WS_OPEN_TIMEOUT_MS = 15_000;
// 途中送信の受理待ち。bridge は同期に返すので普通は一瞬。返らないまま待つと
// その会話の送信待ちが止まるので、待ちきったら「結果不明」として上へ返す
const STEER_TIMEOUT_MS = 15_000;
// 中断してもターンの後始末（turn.failed）が来ないことがある。畳む最後の砦。
const ABORT_FALLBACK_MS = 5_000;
// procway は turn.completed を出したあと、スナップショットを保存し終えてから runningTurn を下ろす。
// その窓に入った送信は turn_in_progress で撥ねられるので、区切りが走っていないなら撃ち直す。
// 開発機では保存が 15〜20ms を超えると窓に入る。ホストランナーの Windows はここを容易に超える。
// 合計 1.2 秒まで粘る（保存 1.1 秒までを吸収できることを、保存を遅らせた procway で確認した）。
// 区切りが走っていると分かった時点で打ち切るので、本物の wake をこの長さだけ待つことはない。
const HANDOFF_WAIT_MS = 60;
const HANDOFF_RETRIES = 20;
// OAuth ログインを永久に待たない。web 側で放置されたときに authLogin が返らなくなる。
const LOGIN_TIMEOUT_MS = 10 * 60_000;

const AUTH_PROFILE = "codex";
const AUTH_PROVIDER = "openai-codex";
const ORIGINATOR = "agent-host";

// procway の承認モード（ai-agent/src/config/schema.mjs:6）。
// procway 自身の既定は auto-readonly だが、こちらの既定（= 最初のキー）は
// **always-ask にしておく**。server.resolveMode は知らない値を先頭のキーへ落とすので、
// 他バックエンドから引き継いだ prefs（"default" など）が来たときに、
// 黙って自動実行側へ倒れるより、聞かれる側へ倒れるほうが事故が小さい。
// 軸（core/modes.mjs）は procway に sandbox が無いので enforced はすべて false。
const MODES = {
  "always-ask":   { label: "都度確認",   note: "ツールのたびに聞く",                                  scope: "workspace", autonomy: "ask",   enforced: false },
  "auto-readonly":{ label: "読むのは自動", note: "読み取りは自動、書き込みとシェルは聞く（procway の既定）", scope: "readonly",  autonomy: "judge", enforced: false },
  "full-auto":    { label: "全自動",     note: "deny リスト以外は聞かない",                            scope: "workspace", autonomy: "never", enforced: false },
};

// web/render.mjs の TOOL_LABEL を補うヒント。procway のツール名は Claude と全く違うので、
// これが無いと一覧が全部「generic」になる。
const TOOL_HINTS = {
  run_shell:    { label: "実行",   shape: "shell" },
  shell_status: { label: "実行",   shape: "shell" },
  shell_logs:   { label: "実行",   shape: "shell" },
  read_file:    { label: "読む",   shape: "read" },
  view_image:   { label: "読む",   shape: "read" },
  write_file:   { label: "書く",   shape: "write" },
  apply_patch:  { label: "編集",   shape: "edit" },
  edit:         { label: "編集",   shape: "edit" },
  search_files: { label: "探す",   shape: "search" },
  list_files:   { label: "探す",   shape: "search" },
  spawn_agent:  { label: "委譲",   shape: "delegate" },
  web_fetch:    { label: "web",    shape: "web" },
  web_search:   { label: "web",    shape: "web" },
};

const wait = (ms) => new Promise((resolve) => { setTimeout(resolve, ms).unref?.(); });

// ------------------------------------------------------------------ 置き場所

const homeDir = () => tokens.procwayHome();
const sessionsDir = () => path.join(tokens.procwayRoot(homeDir()), "sessions");

async function readJson(file) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- serve 起動

// 1 worker のプロセスは 1 会話専用。別会話とは共有しない。
// key に cwd を含めるのは、**settings は serve の起動 cwd から 1 度だけ読まれる**ため
// （adapters/serve/server.mjs は接続ごとの ?cwd= をセッションに渡すだけで、
//  settings は起動時の 1 つを使い回す）。別プロジェクトの workspace settings を
// 効かせるにはプロセスを入れ替えるしかない。
const serve = {
  proc: null,
  port: 0,
  token: "",
  key: "",
  starting: null,
  log: [],
  approvalMode: null,   // serve の settings に入っている承認モード（applyApprovalMode）
};

let activeTurns = 0;
let connectionSetup = Promise.resolve();

function noteLog(chunk) {
  for (const line of String(chunk).split(/\r?\n/)) {
    if (!line.trim()) continue;
    serve.log.push(line);
    if (serve.log.length > 100) serve.log.shift();
  }
}

const tail = (n = 15) => serve.log.slice(-n).join("\n");

/** 空きポートを OS に選ばせる。0 番で listen して番号だけ取り、すぐ閉じる。 */
function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

function stopServe(reason) {
  for (const conn of [...conns.values()]) conn.dispose(reason ?? "serve を止めた");
  conns.clear();
  const proc = serve.proc;
  serve.proc = null;
  serve.port = 0;
  serve.token = "";
  serve.key = "";
  serve.approvalMode = null;
  // 走っていた job は serve と一緒に失われる。procway は再起動時に failed として復元するだけで、
  // settle も wake も出さない（ai-agent/src/jobs/delegated-jobs.mjs）ので、ここで全部消す
  if (behind.clear()) reportBackground();
  if (proc && proc.exitCode === null && proc.signalCode === null) {
    try { proc.kill(); } catch { /* ignore */ }
  }
}

/**
 * 承認モードを serve の settings へ渡す。wake ターンは runTurn の options を持たないので、
 * procway は settings.approvalMode（ApprovalCoordinator が呼ばれた時点で読む）を使う。
 * serve は Pleiad 専用の起動口（procway-serve.mjs）で動いていて、stdin の 1 行 JSON で書き換えられる。
 * 起動の key には入れない（モードを変えただけで serve を入れ替えると、裏の子が道連れになる）。
 */
function applyApprovalMode(mode) {
  approvalModeNow = mode;
  if (!serve.proc || serve.approvalMode === mode) return;
  try {
    serve.proc.stdin?.write(`${JSON.stringify({ approvalMode: mode })}\n`);
    serve.approvalMode = mode;
  } catch { /* 落ちかけている serve。次に起こすときに env で渡る */ }
}

async function startServe({ cwd, provider, model }) {
  const port = await freePort();
  const token = crypto.randomBytes(24).toString("hex");

  const env = { ...process.env };
  // 必須。空白のみだと startServer が例外を投げて起動しない
  env.PROCWAY_SERVE_TOKEN = token;
  // stderr の「otel を入れてね」1 行を黙らせる
  env.PROCWAY_TELEMETRY_QUIET = "1";
  // 添付転送 API / run 制御 API を agent-host は実装していない。設定すると
  // 該当ツールが実際に HTTP を叩きに行って失敗するので、必ず外す。
  delete env.PROCWAY_DASHBOARD_URL;
  // env も置くが、**これだけでは効かない**。procway の設定マージは
  // 組み込み既定 -> env -> user スコープ -> workspace スコープ -> CLI フラグ の順で、
  // user の settings.json に defaultProvider があると env は負ける
  // （実機で踏んだ: PROCWAY_CODE_PROVIDER=codex が user の "local" に負けて
  //   LM Studio へ繋ぎに行き "fetch failed" になった）。効かせるのは下の CLI フラグ。
  if (provider) env.PROCWAY_CODE_PROVIDER = provider;
  if (model) env.PROCWAY_CODE_MODEL = model;
  // テストで本物の ~/.procway を汚さないための逃がし口。serve 側の os.homedir() を移す。
  if (process.env.AGENT_HOST_PROCWAY_HOME) {
    env.HOME = process.env.AGENT_HOST_PROCWAY_HOME;
    env.USERPROFILE = process.env.AGENT_HOST_PROCWAY_HOME;
  }
  if (runtimeConfig) {
    Object.assign(env, runtimeConfig.env);
    env.PLY_PROCWAY_RUNTIME = Buffer.from(JSON.stringify({ src: runtimeConfig.src, id: runtimeConfig.id, provider: runtimeConfig.provider, limits: runtimeConfig.limits, contextRuntime: runtimeConfig.contextRuntime, agentRuntime: runtimeConfig.agentRuntime, nativeMcp: runtimeConfig.native?.mcpServers, mcpRegistrations: runtimeConfig.mcpRegistrations, plyMcp: runtimeConfig.plyMcp, visualizeInstructions: runtimeConfig.visualizeInstructions, approvalMode: approvalModeNow, port })).toString('base64');
  }

  // CLI フラグはマージ順の最後なので、user / workspace の settings.json より強い。
  const argv = ["serve", "--port", String(port), "--host", "127.0.0.1"];
  if (provider) argv.push("--provider", provider);
  if (model) argv.push("--model", model);

  serve.log.length = 0;
  const proc = spawnCli(runtimeConfig ? [process.execPath, fileURLToPath(new URL('../procway-serve.mjs', import.meta.url))] : cliCommand("procway"), runtimeConfig ? [] : argv, {
    cwd,
    env,
    // stdin は承認モードの書き換え（applyApprovalMode）に使う。procway-serve.mjs だけが読む
    stdio: [runtimeConfig ? "pipe" : "ignore", "pipe", "pipe"],
  });
  proc.stdin?.on("error", () => {});
  proc.stdout.on("data", noteLog);
  proc.stderr.on("data", noteLog);
  proc.on("exit", (code) => {
    // 落ちたら次の呼び出しで起こし直す（ここでは再起動しない。
    // 起動に失敗し続けるプロセスを無限に生やさないため）。
    if (serve.proc === proc) {
      // 予期しない終了。裏の子と走っていた区切りはこれで失われる。何が起きていたか後から言えるよう、直近の出力を残す
      console.error(`  procway: serve が終了した pid=${proc.pid} exit=${code}\n${tail(10).replace(/^/gm, "    ")}`);
      stopServe(`procway-code serve が終了した (exit ${code})`);
    }
  });

  // 起動完了は stdout の 2 行のどちらかで分かる（ai-agent/src/cli.mjs）:
  //   "procway-code serve listening on http://127.0.0.1:<port>"
  //   "Open http://127.0.0.1:<port>/?token=$PROCWAY_SERVE_TOKEN to connect."
  // 取りこぼしても getConn 側の接続リトライが拾う。
  await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`procway-code serve が ${SERVE_START_TIMEOUT_MS}ms で起動しなかった\n${tail()}`)),
      SERVE_START_TIMEOUT_MS,
    );
    const look = (chunk) => {
      if (!/listening on http:\/\/|Open http:\/\//.test(String(chunk))) return;
      clearTimeout(timer);
      proc.stdout.off("data", look);
      resolve();
    };
    proc.stdout.on("data", look);
    proc.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`procway-code serve が起動前に終了した (exit ${code})\n${tail()}`));
    });
  });

  serve.proc = proc;
  serve.port = port;
  serve.token = token;
  serve.approvalMode = runtimeConfig ? approvalModeNow : null;
  // pid を出すのは「誰が孫プロセスを抱えているか」を後から言えるようにするため。
  // Windows の kill() は TerminateProcess なので、agent-host が強制終了されると
  // この子は残る（テストはこの行から pid を拾って自分で片付ける）。
  console.log(`  procway: serve を起動した pid=${proc.pid} port=${port} cwd=${cwd}`);
  return serve;
}

// 行儀よく終わるとき（Ctrl-C の既定終了や process.exit）は道連れにする。
// The exported worker pool owns shutdown and idle eviction.

/**
 * serve を用意する。provider / model / cwd が変わっていて、かつ
 * **ターンが 1 本も走っていなければ**入れ替える（env でしか渡せないため）。
 * 走っているなら今のプロセスを使い続ける（次にアイドルになったときに切り替わる）。
 */
async function ensureServe({ cwd, provider, model }) {
  const revision = runtimeConfig ? crypto.createHash('sha256').update(JSON.stringify(runtimeConfig)).digest('hex') : '';
  const key = `${cwd}\u0000${provider}\u0000${model}\u0000${revision}`;

  if (serve.proc && serve.key !== key) {
    if (activeTurns === 0) {
      console.log(`  procway: 設定が変わったので serve を入れ替える (${serve.key} -> ${key})`);
      stopServe("設定が変わった");
    } else {
      throw new Error('この接続先は使用中です。完了してから再送信してください');
    }
  }
  if (serve.proc) return serve;
  if (serve.starting) return serve.starting;

  serve.starting = startServe({ cwd, provider, model })
    .then((s) => { s.key = key; return s; })
    .finally(() => { serve.starting = null; });
  return serve.starting;
}

// ------------------------------------------------------------------ 接続

const conns = new Map();   // sessionId -> conn

/** `[A-Za-z0-9][A-Za-z0-9_-]{0,99}`。ディレクトリ名になるので余計な字を混ぜない。 */
function newSessionId() {
  return `pw-${Date.now().toString(36)}-${crypto.randomBytes(4).toString("hex")}`;
}

/**
 * WS を開く。受け口（onMessage）は**開く前に**付け、onOpen は "open" と同じ tick で呼ぶ。
 * serve は接続した直後に ready を送る。101 の応答と ready が 1 回の読み込みで届くと
 * （負荷の高い hosted runner では loopback でもそうなる）、ws は "open" を出したのと同じ tick の
 * process.nextTick で ready を "message" として出す。これは await の続き（microtask）より先に走るので、
 * "open" を await してから受け口を付けると ready を取り落とし、WS_OPEN_TIMEOUT_MS 待って失敗する。
 */
function openSocket(url, { onMessage, onOpen }) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.on("message", onMessage);
    const timer = setTimeout(() => {
      try { ws.terminate(); } catch { /* ignore */ }
      reject(new Error(`WS が ${WS_OPEN_TIMEOUT_MS}ms で開かなかった`));
    }, WS_OPEN_TIMEOUT_MS);
    const fail = (err) => { clearTimeout(timer); reject(err ?? new Error("WS が閉じた")); };
    ws.once("open", () => { clearTimeout(timer); ws.off("error", fail); onOpen(ws); resolve(ws); });
    ws.once("error", fail);
  });
}

/**
 * 1 セッション = 1 WS。`?session=<id>` は create-or-resume なので、新規も再開も同じ形。
 * 接続直後の順序は契約で決まっている: ready -> 合成 session.resumed -> todos.updated
 * -> 未解決の approval.requested*。
 */
async function connect(sessionId, cwd) {
  const q = new URLSearchParams({ token: serve.token, session: sessionId, cwd: path.resolve(cwd) });
  // 受け口（下の onMessage / route）と ready 待ちを先に用意してから開く（openSocket の説明）
  let ws = null;

  const conn = {
    ws: null,
    sessionId,
    cwd,
    seq: 0,
    pending: new Map(),        // command id -> { resolve, reject }
    // ready 直後に replay される承認は、まだ受け取る driver が居ない。
    // ここに溜めて次の Pleiad のターンの開始時に渡す。requestId で重複排除する。
    parked: new Map(),         // requestId -> approval.requested イベント
    seenApprovals: new Set(),
    alive: true,
    // ---- 振り分け（下の route）。procway の区切りは同時に 1 本しか走らない
    owner: null,               // Pleiad が送ったターンの driver
    ext: null,                 // 外部ターン（Pleiad が送っていないターン）の driver。server への登録待ちを含む
    segment: null,             // いま走っている区切りの持ち主（driver）
    running: false,            // procway が区切りを走らせている（開始の印から turn.completed / turn.failed まで）
    byRequest: new Map(),      // requestId -> その承認を聞いた driver（承認の続きの区切りはそこへ）
    idleWaiters: [],
  };
  /** 走っている区切りが終わるまで待つ。走っていなければすぐ。 */
  conn.idle = () => (conn.running && conn.alive
    ? new Promise((resolve) => conn.idleWaiters.push(resolve))
    : Promise.resolve());
  const settleIdle = () => {
    conn.running = false;
    for (const resolve of conn.idleWaiters.splice(0)) resolve();
  };
  // 中断しても turn.failed が来なかったとき（ABORT_FALLBACK_MS）に、走っていたことにしたままにしない
  conn.forceIdle = settleIdle;

  conn.send = (command, args) => new Promise((resolve, reject) => {
    if (!conn.alive) return reject(new Error("procway への接続が切れている"));
    const id = `c${++conn.seq}`;
    conn.pending.set(id, { resolve, reject });
    try {
      ws.send(JSON.stringify({ kind: "command", id, command, args }));
    } catch (err) {
      conn.pending.delete(id);
      reject(err);
    }
  });

  conn.dispose = (reason) => {
    if (!conn.alive) return;
    conn.alive = false;
    const err = new Error(reason ?? "procway への接続が閉じた");
    for (const p of conn.pending.values()) p.reject(err);
    conn.pending.clear();
    settleIdle();
    for (const d of new Set([conn.owner, conn.ext, conn.segment])) d?.onEvent({ type: "__closed", reason: err.message });
    conn.owner = conn.ext = conn.segment = null;
    conns.delete(conn.sessionId);
    // 繋がっていない間に終わった子（その wake）は見えない。数えたままにすると印が消えなくなるので、
    // 接続が切れたら数え直す（0 から。次の spawn_agent で増える）。serve が終わったときも同じ
    if (behind.clear()) reportBackground();
    try { ws.close(); } catch { /* ignore */ }
  };

  // ready の待ち時間は開いてから数える（onOpen で timer を張る）。開けなかったときは待たれないので、
  // 未処理の reject として落ちないよう catch を付けておく（await する側には reject がそのまま届く）
  let readyTimer = null;
  const ready = new Promise((resolve, reject) => {
    conn.settleReady = (value, err) => {
      clearTimeout(readyTimer);
      conn.settleReady = null;
      err ? reject(err) : resolve(value);
    };
  });
  ready.catch(() => {});

  const onMessage = (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.kind === "ready") {
      // protocolVersion が範囲外なら黙って動かない（host-contract:319-322）。
      // 欠落は 1 とみなす、というのが契約。
      const v = msg.protocolVersion ?? 1;
      if (v !== 1) {
        conn.settleReady?.(null, new Error(`procway-code の protocolVersion ${v} は未対応（1 のみ）`));
        conn.dispose("protocolVersion 不一致");
        return;
      }
      if (typeof msg.sessionId === "string" && msg.sessionId) conn.sessionId = msg.sessionId;
      // 使える command の一覧（host-contract §4「Ready handshake」）。**知らない command は
      // 応答すら返らない**（parseClientMessage が捨てる）ので、後から足した command は
      // 必ずこれで確かめてから送る。古い procway は載せてこない -> 初期の一覧だけとみなす
      conn.commands = Array.isArray(msg.commands) ? msg.commands.filter(c => typeof c === "string") : null;
      conn.settleReady?.(msg);
      return;
    }

    if (msg.kind === "response") {
      const p = conn.pending.get(msg.id);
      if (!p) return;
      conn.pending.delete(msg.id);
      if (msg.ok) return p.resolve(msg.result);
      // error はオブジェクトのことも文字列のこともある（protocol.mjs:58-64）
      const e = msg.error;
      const err = new Error(typeof e === "string" ? e : (e?.message ?? "procway のコマンドが失敗した"));
      err.code = typeof e === "object" ? e?.code ?? null : null;
      // 応答として撥ねられた = 届いた上で断られた。接続が落ちて結果が分からないのとは別物
      err.rejected = true;
      return p.reject(err);
    }

    if (msg.kind === "error") {
      if (msg.fatal) conn.dispose(String(msg.error ?? "fatal"));
      return;
    }

    if (msg.kind !== "event" || !msg.event) return;
    route(msg.event);
  };

  /**
   * 接続に常駐する振り分け。ターンの外で来たイベントも捨てない。
   *
   * procway の「区切り」は user.prompt.submitted（または park した承認の続き）から turn.completed /
   * turn.failed まで。procway は区切りを同時に 1 本しか走らせない（runningTurn の間は runTurn も approve も撥ねる）。
   * 誰が受け取るか:
   *   user.prompt.submitted（wake なし）… 自分の送信の返りを待っている Pleiad のターン
   *   user.prompt.submitted（wake）   … 受け付け済みの Pleiad のターンがあれば取り込む（承認待ち・質問待ちの途中に来た wake）。
   *                                     無ければ外部ターン
   *   approval.resolved             … その承認を聞いた driver（続きの区切りはそこへ）
   *   区切りのイベント                … いまの区切りの持ち主。居なければ外部ターンを起こす
   *   session.resumed.runningTurn   … 接続した時点で何かが走っている。外部ターンとして受ける
   */
  function route(ev) {
    if (behind.apply(ev)) reportBackground();
    switch (ev.type) {
      case "session.resumed":
        if (ev.runningTurn === true) {
          conn.running = true;
          if (!conn.segment) conn.segment = ensureExternal(conn);
        }
        return;

      case "user.prompt.submitted": {
        conn.running = true;
        const own = conn.owner;
        let to;
        // 途中送信（steer）が区切りに折り込まれた合図。折り込めるのは走っている区切りだけなので、
        // 送った本人（受け付け済みの Pleiad のターン）に返す。expectingPrompt はもう下りている
        if (ev.steer && own?.accepted) {
          to = own;
        } else if (!ev.wake && own?.expectingPrompt) {
          own.expectingPrompt = false;
          own.accepted = true;
          to = own;
        } else if (ev.wake && own?.accepted) {
          to = own;
        } else {
          to = ensureExternal(conn);
        }
        conn.segment = to;
        return to?.onEvent(ev);
      }

      case "approval.requested": {
        if (!ev.requestId || conn.seenApprovals.has(ev.requestId)) return;   // 再接続時の replay を二重に出さない
        conn.seenApprovals.add(ev.requestId);
        const to = conn.segment ?? conn.owner ?? (conn.ext?.done ? null : conn.ext);
        if (!to) { conn.parked.set(ev.requestId, ev); return; }
        conn.byRequest.set(ev.requestId, to);
        return to.onEvent(ev);
      }

      case "approval.resolved": {
        if (!ev.requestId) return;
        conn.parked.delete(ev.requestId);
        const to = conn.byRequest.get(ev.requestId);
        conn.byRequest.delete(ev.requestId);
        // 同じラウンドに park が複数あると、続きを走らせるのは最後の 1 件だけ。
        // ここでは running を立てない（続きの最初のイベントで立つ）
        if (to && !to.done && !conn.running) conn.segment = to;
        return;
      }

      case "steer.dropped":
        // 受理した途中送信を、その区切りが読まないまま終わった（中断・失敗・ラウンド上限）。
        // server はもう送信済みにしているので、送信待ち（保留）へ戻させる。procway はこれを turn.failed の
        // **後**に出すことがあり、そのとき区切りはもう畳まれている。区切りを通さず接続から直接返す
        console.error(`  procway: 途中送信が読まれずに捨てられた (${ev.reason ?? "?"}): ${(ev.clientMessageIds ?? []).join(", ")}`);
        conn.onSteerDropped?.(ev.clientMessageIds ?? []);
        return;

      case "turn.completed":
      case "turn.failed": {
        const to = conn.segment;
        conn.segment = null;
        settleIdle();
        to?.onEvent(ev);
        // 区切りの間を待っていた driver（承認を返したい・質問の回答を送り直したい）を起こす
        for (const d of new Set([conn.owner, conn.ext])) if (d && d !== to) d.poke();
        return;
      }

      default: {
        if (!SEGMENT_EVENTS.has(ev.type)) return;
        let to = conn.segment;
        if (!to && STARTS_SEGMENT.has(ev.type)) to = conn.segment = ensureExternal(conn);
        if (!to) return;
        conn.running = true;
        return to.onEvent(ev);
      }
    }
  }

  try {
    await openSocket(`ws://127.0.0.1:${serve.port}/ws?${q}`, {
      onMessage,
      onOpen: (socket) => {
        ws = conn.ws = socket;
        ws.on("close", () => conn.dispose("procway への接続が閉じた"));
        ws.on("error", (err) => conn.dispose(String(err?.message ?? err)));
        if (conn.settleReady) readyTimer = setTimeout(() => conn.settleReady?.(null, new Error("ready が来なかった")), WS_OPEN_TIMEOUT_MS);
      },
    });
  } catch (err) {
    conn.settleReady?.(null, err);
    throw err;
  }

  try {
    await ready;
  } catch (err) {
    conn.dispose(String(err?.message ?? err));
    throw err;
  }
  conns.set(conn.sessionId, conn);
  return conn;
}

/** そのセッションの接続を用意する。落ちていたら張り直す。 */
async function getConn(sessionId, cwd, { provider, model }) {
  await ensureServe({ cwd: path.resolve(cwd), provider, model });
  const have = conns.get(sessionId);
  if (have?.alive && path.resolve(have.cwd) === path.resolve(cwd)) return have;
  have?.dispose("作業ディレクトリを変更した");
  return connect(sessionId, cwd);
}

// 接続を確保してから実行中に数える。準備中の自分で serve の切り替えを妨げず、
// 別ターンの接続準備とも直列化して、使い始めた serve を止めない。
function acquireTurnConnection(sessionId, cwd, settings) {
  const work = connectionSetup.catch(() => {}).then(async () => {
    const conn = await getConn(sessionId, cwd, settings);
    activeTurns += 1;
    return conn;
  });
  connectionSetup = work;
  return work;
}

// ---------------------------------------------------------------- 正規化

/** tool.call.completed の result を、web に出せる 1 本の文字列にする。 */
function resultText(result) {
  if (result == null) return "";
  const summary = typeof result.summary === "string" ? result.summary : "";
  const data = result.data;
  let body = "";
  if (typeof data === "string") body = data;
  else if (data != null) {
    try { body = JSON.stringify(data, null, 2); } catch { body = String(data); }
  }
  if (summary && body) return `${summary}\n${body}`;
  return summary || body || "";
}

function cut(text) {
  const s = String(text ?? "");
  return s.length > MAX_RESULT_CHARS
    ? { text: `${s.slice(0, MAX_RESULT_CHARS)}…（以下略）`, truncated: true }
    : { text: s, truncated: false };
}

/**
 * UIR の spec（request_user_action の引数。ai-agent/src/tools/registry.mjs:233）を
 * agent-host の質問カードの形へ落とす:
 *   questions: [{ question, header?, multiSelect?, options: [{ label, description?, preview? }] }]
 *
 *   survey   : { questions: [{ id, prompt, type: 'single'|'multi'|'text', options?: [{label,value,recommended?,description?}] }] }
 *   env_vars : { keys: [{ key, label?, isSecret?, ... }] }   → 「値を入れて」の自由記述にする
 *   approval : { subject, detail?, ... }                     → はい / いいえ の 2 択にする
 */
function specToQuestions(kind, summary, spec) {
  const head = (s) => String(s ?? "").slice(0, 12) || "質問";

  if (kind === "survey" && Array.isArray(spec?.questions)) {
    return spec.questions.map((q) => ({
      question: String(q?.prompt ?? q?.id ?? summary ?? "?"),
      header: head(q?.id ?? kind),
      multiSelect: q?.type === "multi",
      options: (Array.isArray(q?.options) ? q.options : []).map((o) => ({
        label: String(o?.label ?? o?.value ?? ""),
        description: o?.recommended ? `おすすめ${o?.description ? ` — ${o.description}` : ""}`
                                    : (o?.description ? String(o.description) : undefined),
      })).filter((o) => o.label),
    }));
  }

  if (kind === "env_vars" && Array.isArray(spec?.keys)) {
    return spec.keys.map((k) => ({
      question: `${String(k?.label ?? k?.key ?? "")} を設定して`,
      header: head(k?.key),
      multiSelect: false,
      // 値そのものは web の自由記述で受ける。選択肢は「設定した / しない」だけ。
      options: [{ label: "設定した" }, { label: "設定しない" }],
    }));
  }

  if (kind === "approval") {
    return [{
      question: String(spec?.subject ?? summary ?? "承認しますか？"),
      header: "承認",
      multiSelect: false,
      options: [
        { label: "承認する", description: spec?.detail ? String(spec.detail) : undefined },
        { label: "承認しない" },
      ],
    }];
  }

  // 未知の kind。中身は分からないので、自由記述で受けられる 1 問に落とす。
  return [{
    question: String(summary || `${kind} の入力が要る`),
    header: head(kind),
    multiSelect: false,
    options: [{ label: "OK" }],
  }];
}

/** 質問カードの回答（{ [question]: "A, B" }）を procway に返す形にする。 */
function answersToResponse(questions, answers) {
  const map = answers && typeof answers === "object" ? answers : {};
  const out = {};
  for (const q of questions ?? []) out[q.question] = map[q.question] ?? "";
  return { answers: out };
}

// ---------------------------------------------------------------- ターンの運転
//
// Pleiad の 1 ターン分を運ぶ。procway の区切り（connect の route の説明）を 1 つ以上またぐ:
// park した承認の続き、質問の回答を投げ直した区切り、承認待ちの途中に来た wake の取り込み。
// Pleiad が送ったターン（runTurn）と、procway が自分で始めたターン（外部ターン）の両方がこれを使う。
// 外部ターンは server に登録されるまで（attach まで）出したイベントを溜めておく。
//
// Pleiad の 1 ターンは「区切りが終わっていて（turn.completed）、かつ未解決の承認・質問が無い」まで。
// turnResult はその時点で 1 回だけ出す（冒頭の §park の扱い）。
function createDriver(conn, { external = false, permissionSessionId = null } = {}) {
  let emit = null;
  let askPermission = null;
  let signal = null;
  const backlog = [];
  const out = (ev) => (emit ? emit(ev) : backlog.push(ev));
  let markAttached;
  const attached = new Promise((resolve) => { markAttached = resolve; });

  const st = {
    done: false,
    settled: false,     // turn.completed が来て、続きを送ってよい状態か
    busy: false,
    aborting: false,
    thinking: false,
    seenTools: new Set(),
    streamed: new Set(),      // 本文 delta が流れた messageId
    reasoned: new Set(),      // 思考 delta が流れた messageId
    approvals: new Map(),     // requestId -> { decision: null | "allow"|"deny"|"always-allow" }
    interactions: new Map(),  // requestId -> { response: null | object, reply: string }
    costUsd: 0,
    usage: {},
    turns: 0,
    pendingCommand: null,     // 走らせている runTurn コマンドの Promise
  };

  const d = {
    external,
    expectingPrompt: false,   // 自分が投げた runTurn の user.prompt.submitted を待っている
    accepted: false,          // 自分の最初の送信を procway が受け付けた（以降に来た wake は取り込む）
    get done() { return st.done; },
    onEvent,
    poke: () => { step().catch(() => {}); },
  };

  let finish;
  d.ended = new Promise((resolve) => {
    finish = (outcome, error, { silent = false } = {}) => {
      if (st.done) return;
      st.done = true;
      signal?.signal?.removeEventListener?.("abort", onAbort);
      if (conn.owner === d) conn.owner = null;
      if (conn.segment === d) conn.segment = null;
      if (!silent) {
        out({
          type: "turnResult",
          outcome,
          turns: st.turns || 1,
          costUsd: Number(st.costUsd.toFixed(6)),
          ...(error ? { error: String(error) } : {}),
        });
      }
      resolve(outcome);
    };
  });

  /** server の口をつなぐ。外部ターンは登録された時点で、溜めていたイベントを流す。 */
  d.attach = (hooks) => {
    emit = hooks.emit;
    askPermission = hooks.askPermission;
    signal = hooks.signal;
    const queued = backlog.splice(0);
    if (external && !queued.length && !st.done) out({ type: "activity", state: "running" });
    for (const ev of queued) emit(ev);
    markAttached();
    // Pleiad のターンが走り出す前に中断されていた: procway に何も投げずに畳む
    if (signal?.signal?.aborted) return external ? onAbort() : finish("aborted");
    signal?.signal?.addEventListener?.("abort", onAbort, { once: true });
  };

  /** Pleiad の送信を procway に投げる。 */
  d.start = (text) => {
    out({ type: "activity", state: "thinking" });
    runProcwayTurn(text);
  };

  /**
   * procway は Pleiad が送っていない区切り（wake など）を走らせていて、送信は届かなかった（届けなかった）。
   * その区切りを外部ターンとして見せ、この送信は server に「送信待ちへ戻す」と伝える（runTurn の requeue）。
   * 何も出さずに畳む（turnResult を出すと web が失敗の一行を出す）。
   */
  d.requeue = () => {
    if (!host || !hostId) return finish("error", "procway が別のターンを実行中です。終わってから送り直してください");
    conn.running = true;   // turn_in_progress がその証拠。区切りの終わりで route が戻す
    if (!conn.segment || conn.segment === d) conn.segment = ensureExternal(conn);
    finish("requeue", null, { silent: true });
  };

  /** server に登録できなかった外部ターン。黙って捨てる（イベントは今までどおり表示されない）。 */
  d.abandon = () => finish("error", null, { silent: true });

  /**
   * ターンの途中に利用者が送った 1 通を、いま走っている区切りの継ぎ目へ差し込む（serve の steer）。
   * true = 受理（procway が保留に積んだ。読まれたかは別で、user.prompt.submitted の steer で返る）、
   * false = 受理できない（server が送信待ちへ戻し、ターンが終わってから普通に送る）、
   * throw = 結果不明（通信断。送り直すと二重になるので自動では送り直さない）。
   *
   * **自分の送信を procway が受け付けるまでは差し込まない**。受け付ける前に走っているのは
   * Pleiad が始めていない区切り（wake）で、そこへ差し込むと利用者の発言が別のターンに紛れる。
   */
  d.steer = async (item) => {
    const prompt = String(item?.args?.prompt ?? "");
    if (!prompt || !d.accepted || st.done || st.aborting || !conn.alive) return false;
    // 知らない command は**応答すら返らない**（parseClientMessage が捨てる）ので、
    // ready が知らせてきた一覧で確かめてから送る。古い procway は一覧を載せてこない
    if (!conn.commands?.includes("steer")) return false;
    let result;
    try {
      result = await Promise.race([
        conn.send("steer", { prompt, clientMessageId: String(item.id) }),
        wait(STEER_TIMEOUT_MS).then(() => { throw new Error("procway が途中送信に応答しなかった"); }),
      ]);
    } catch (err) {
      // 応答として撥ねられた（no_active_turn / invalid_args）なら何も受け取られていない
      if (err?.rejected) return false;
      throw err;
    }
    return result?.queued === true;
  };

  /** 承認と質問を捌いてから、続きを送るか、ターンを畳むか決める。 */
  async function step() {
    if (st.done || st.aborting || !st.settled || st.busy) return;
    // 別の区切り（wake など）が走っている間は、承認も回答も procway に撥ねられる。
    // その区切りが終わったら route が poke する
    if (conn.running) return;
    // まだ人間の答えを待っているものがあるなら、ターンは終わっていない
    for (const a of st.approvals.values()) if (a.decision === null) return;
    for (const i of st.interactions.values()) if (i.response === null) return;

    st.busy = true;
    try {
      if (st.approvals.size > 0) {
        // 走らせた runTurn コマンドの応答は「ターンが本当に畳まれた」同期点
        // （bridge が session.runTurn を await したあとに返す）。approve は
        // その後でないと resolveParkedApproval が runningTurn で撥ねる。
        if (st.pendingCommand) await st.pendingCommand.catch(() => {});
        st.settled = false;
        const entries = [...st.approvals];
        st.approvals.clear();
        // 同じラウンドに複数の park があるとき、**続きを走らせるのは最後の 1 件**
        // （conversation.mjs: parkedApprovals.size > 0 のあいだは畳んだまま）。
        // だから順に送る。続きは非同期に流れてくるので待たない。
        let delivered = false;
        for (const [requestId, a] of entries) delivered = await sendApprove(requestId, a.decision);
        if (!delivered) finish("error", "承認を procway に渡せなかった");
        return;
      }

      if (st.interactions.size > 0) {
        st.settled = false;
        const entries = [...st.interactions];
        st.interactions.clear();
        const replies = [];
        for (const [requestId, i] of entries) {
          await conn.send("interaction.resolve", { requestId, response: i.response }).catch(() => {});
          if (i.reply) replies.push(i.reply);
        }
        // **interaction.resolve だけでは会話が進まない**（付録 A.4）。
        // 回答を新しいプロンプトとして投げ直すのが本体。
        runProcwayTurn(replies.join("\n") || "（回答しました）");
        return;
      }

      // runTurn コマンドの応答は turn.completed イベントより**後**に返る
      // （bridge が session.runTurn を await し、その中で snapshot / index が保存される）。
      // ここで待たないと、直後の listSessions がタイトル無しの行を読むことがある。
      if (st.pendingCommand) await st.pendingCommand.catch(() => {});
      // 待っている間に次の区切りがこのターンに来た（取り込んだ wake）。その終わりでもう一度見る
      if (!st.settled || conn.segment === d) return;
      finish("ok");
    } finally {
      st.busy = false;
      // busy のあいだに turn.completed が来ていたら、もう一度見る
      if (st.settled && !st.done) queueMicrotask(() => { step().catch(() => {}); });
    }
  }

  /**
   * approve は「区切りが走っていない」ときしか通らない（resolveParkedApproval は
   * runningTurn なら false を返す）。別の区切り（wake）が走っていればその終わりを待つ。
   * turn.completed の発火と runningTurn=false のあいだにも僅かな窓があるので、
   * accepted:false は少しだけ待って撃ち直す。
   */
  async function sendApprove(requestId, decision) {
    for (let i = 0; i < 20; i += 1) {
      if (conn.running) await conn.idle();
      if (!conn.alive || st.aborting) return false;
      const r = await conn.send("approve", { requestId, decision }).catch(() => null);
      if (r?.accepted) return true;
      await wait(150);
    }
    console.error(`  procway: 承認 ${requestId} を渡せなかった`);
    return false;
  }

  function runProcwayTurn(text, retries = HANDOFF_RETRIES) {
    d.expectingPrompt = true;
    st.pendingCommand = conn
      .send("runTurn", { prompt: text, options: { approvalMode: approvalModeNow } })
      .then(() => { st.pendingCommand = null; })
      .catch((err) => {
        st.pendingCommand = null;
        // 中断で殺されたときは turn.failed 側で畳む
        if (st.aborting || st.done) return;
        if (err?.code === "turn_in_progress") {
          d.expectingPrompt = false;
          // 最初の送信: procway は何も受け取っていない。
          // ただし turn_in_progress は「別の区切りが走っている」とは限らない。procway は
          // turn.completed を出したあとスナップショットを保存し終えてから runningTurn を下ろすので、
          // 直前のターンの後始末に当たっただけのことがある（sendApprove が待っているのと同じ窓）。
          // その窓なら区切りは終わっていて conn.running も segment も下りているので、
          // 少しだけ撃ち直す。本物の区切りが走っていると分かっているときは今までどおり送信待ちへ戻す。
          if (!d.accepted) {
            if (conn.running || conn.segment || retries <= 0) return d.requeue();
            return wait(HANDOFF_WAIT_MS).then(() => {
              if (st.done || st.aborting || !conn.alive) return;
              if (conn.running || conn.segment) return d.requeue();
              runProcwayTurn(text, retries - 1);
            });
          }
          // 質問の回答を投げ直す途中で wake に割り込まれた。その区切りが終わってから送り直す
          (conn.running ? conn.idle() : wait(150)).then(() => {
            if (!st.done && !st.aborting) runProcwayTurn(text);
          });
          return;
        }
        finish("error", err?.message ?? err);
      });
  }

  function onApproval(ev) {
    if (st.approvals.has(ev.requestId)) return;
    st.approvals.set(ev.requestId, { decision: null });
    out({ type: "activity", state: "waiting", label: ev.kind ?? null });
    // 外部ターンは server に登録されるまで聞けない。登録されたらすぐ聞く（次の送信まで park に置かない）
    attached.then(() => askPermission({
      // procway の kind はツール名そのもの（run_shell / write_file / mcp …）
      toolName: ev.kind ?? "tool",
      input: ev.payload ?? { summary: ev.summary ?? "" },
      sessionId: permissionSessionId,
      toolUseID: ev.requestId,
      title: ev.summary ?? null,
      signal: signal?.signal,
      canAlways: true,
      kind: "tool",
      questions: null,
    }))
      .then((answer) => {
        const entry = st.approvals.get(ev.requestId);
        if (!entry) return;
        entry.decision = answer?.allow ? (answer.always ? "always-allow" : "allow") : "deny";
      })
      .catch(() => {
        const entry = st.approvals.get(ev.requestId);
        if (entry) entry.decision = "deny";
      })
      .then(() => step().catch(() => {}));
  }

  function onInteraction(ev) {
    if (st.interactions.has(ev.requestId)) return;
    const questions = specToQuestions(ev.kind, ev.summary, ev.spec);
    st.interactions.set(ev.requestId, { response: null, reply: "" });
    out({ type: "activity", state: "waiting", label: ev.kind ?? null });
    attached.then(() => askPermission({
      toolName: "request_user_action",
      input: ev.spec ?? { summary: ev.summary ?? "" },
      sessionId: permissionSessionId,
      toolUseID: ev.requestId,
      title: ev.summary ?? null,
      signal: signal?.signal,
      canAlways: false,
      kind: "question",
      questions,
    }))
      .then((answer) => {
        const entry = st.interactions.get(ev.requestId);
        if (!entry) return;
        // response はバックエンドが自分の形へ戻す（server は素通し）。
        // procway 側は任意 JSON を受けるので、String 化しないこと。
        entry.response = answer?.response ?? answersToResponse(questions, answer?.answers);
        entry.reply = Object.entries(entry.response.answers ?? {})
          .map(([q, a]) => `${q}: ${a}`)
          .join("\n");
      })
      .catch(() => {
        const entry = st.interactions.get(ev.requestId);
        if (entry) { entry.response = { cancelled: true }; entry.reply = "（回答せずに進めます）"; }
      })
      .then(() => step().catch(() => {}));
  }

  function onEvent(ev) {
    if (st.done) return;
    switch (ev.type) {
      case "__closed":
        return finish("error", ev.reason);

      case "user.prompt.submitted":
        // 途中送信が会話に入った（procway が区切りの継ぎ目で折り込んだ）。吹き出しは
        // server が受理の時点で出しているので出し直さない。出すのは「渡った」の合図だけ
        if (ev.steer) {
          if (ev.clientMessageId) out({ type: "userMessage.delivered", messageId: String(ev.clientMessageId) });
          return;
        }
        st.settled = false;
        // procway が自分で差し込んだ再開（wake）。本文は利用者の発言ではない（丸ごと <system-reminder>）ので出さない。
        // 代わりに「再開した」の一行（正規化イベント resumed）。Pleiad の送信の返り（wake なし）は何も出さない
        if (ev.wake) {
          out({ type: "resumed" });
          out({ type: "activity", state: "thinking" });
        }
        return;

      case "assistant.message.delta":
        st.streamed.add(String(ev.messageId ?? ""));
        return out({ type: "text.delta", text: String(ev.deltaText ?? "") });

      case "assistant.reasoning.delta": {
        st.reasoned.add(String(ev.messageId ?? ""));
        if (!st.thinking) { st.thinking = true; out({ type: "thinking.start" }); }
        return out({ type: "thinking.delta", text: String(ev.deltaText ?? "") });
      }

      case "assistant.message.completed": {
        const key = String(ev.messageId ?? "");
        // **ストリームしない provider がある**（cli-agent は runProvider に stream を
        // 渡してもらえないので delta が 1 つも流れない）。その場合は completed の
        // content が本文の唯一の出どころなので、ここで delta として吐き直す。
        if (!st.reasoned.has(key) && typeof ev.reasoningContent === "string" && ev.reasoningContent) {
          if (!st.thinking) { st.thinking = true; out({ type: "thinking.start" }); }
          out({ type: "thinking.delta", text: ev.reasoningContent });
        }
        if (!st.streamed.has(key)) {
          const text = (Array.isArray(ev.content) ? ev.content : [])
            .filter((b) => b?.kind === "text" && typeof b.text === "string")
            .map((b) => b.text)
            .join("");
          if (text) out({ type: "text.delta", text });
        }
        st.streamed.delete(key);
        st.reasoned.delete(key);
        st.thinking = false;
        return out({ type: "text.end" });
      }

      case "tool.call.scheduled":
      case "tool.call.started": {
        // scheduled と started は同じ toolCallId で 2 回来る。1 回に畳む
        const key = String(ev.toolCallId ?? "");
        if (!key || st.seenTools.has(key)) return;
        st.seenTools.add(key);
        return out({ type: "tool.start", id: key, name: String(ev.name ?? "tool"), input: ev.args ?? {} });
      }

      case "tool.call.completed": {
        const { text, truncated } = cut(resultText(ev.result));
        return out({
          type: "tool.result",
          id: String(ev.toolCallId ?? ""),
          text,
          isError: ev.ok === false,
          truncated,
        });
      }

      case "activity.started":
        return out({ type: "activity", state: "running", label: ev.detail || ev.label || null });

      case "compact.started":
        return out({ type: "activity", state: "compacting" });

      case "usage.recorded":
        if (Number.isFinite(ev.costUsd)) st.costUsd += ev.costUsd;
        for (const key of ['inputTokens', 'outputTokens', 'costUsd']) {
          if (Number.isFinite(ev[key]) && ev[key] >= 0) st.usage[key] = (st.usage[key] ?? 0) + ev[key];
        }
        out({ type: 'usage', ...st.usage });
        return;

      case "approval.requested":
        return onApproval(ev);

      case "interaction.requested":
        return onInteraction(ev);

      case "turn.completed":
        st.turns = Number.isFinite(ev.round) ? ev.round + 1 : st.turns + 1;
        st.settled = true;
        step().catch(() => {});
        return;

      case "turn.failed": {
        // 中断の統一形（ai-agent/src/agent/abort.mjs）: code === "interrupted"
        const code = ev.error?.code ?? "";
        if (st.aborting || code === "interrupted" || code === "USER_INTERRUPT") return finish("aborted");
        return finish("error", ev.error?.message ?? "turn failed");
      }

      default:
        return;
    }
  }

  function onAbort() {
    if (st.done) return;
    st.aborting = true;
    conn.send("abort", {}).catch(() => {});
    // turn.failed が来ればそこで畳む。来なくても放置しない
    setTimeout(() => {
      if (st.done) return;
      if (conn.segment === d) { conn.segment = null; conn.forceIdle?.(); }
      finish("aborted");
    }, ABORT_FALLBACK_MS).unref?.();
  }

  return d;
}

/**
 * procway が Pleiad の送っていない区切りを走らせている。外部ターンとして server に登録する
 * （server が同じ会話の Pleiad のターンの終わりを待ってから登録し、run を呼ぶ）。
 * 登録を待つ間のイベントは driver が溜める。server が無ければ null（今までどおり捨てる）。
 */
function ensureExternal(conn) {
  if (conn.ext && !conn.ext.done) return conn.ext;
  if (!host || !hostId) return null;
  const d = createDriver(conn, { external: true, permissionSessionId: hostId });
  conn.ext = d;
  Promise.resolve()
    .then(() => host.externalTurn(hostId, async (hooks) => {
      d.attach(hooks);
      await d.ended;
    }))
    .catch((err) => console.error(`  procway: 外部ターンを登録できなかった: ${String(err?.message ?? err)}`))
    .finally(() => {
      d.abandon();
      if (conn.ext === d) conn.ext = null;
    });
  return d;
}

// ---------------------------------------------------------------- backend

/** index.json / meta.json の 1 行をバックエンド共通のセッション行にする。 */
function toRow(sessionId, meta) {
  if (!sessionId || !meta) return null;
  return {
    sessionId,
    // procway はタイトルを持つ（最初のプロンプトから作る）が、書き換える口が無い。
    // capabilities.title は false なので、書くのは sidecar。読むのはここを優先する。
    title: typeof meta.title === "string" && meta.title ? meta.title : null,
    cwd: meta.cwd ?? null,
    createdAt: meta.createdAt ?? null,
    lastModified: meta.updatedAt ?? meta.createdAt ?? null,
    tag: null,      // procway に状態タグは無い
  };
}

const backend = {
  async usage(args) { return (await import('./procway-usage.mjs')).readProcwayUsage(args); },
  id: "procway",
  label: "procway-code",
  description: "ローカル・独自の接続先を設定して使う",

  capabilities: {
    title: false,      // 書き換える口が無い -> sidecar が正本
    tag: false,        // 状態タグ自体が無い -> sidecar が正本
    fork: false,
    subagents: false,  // spawn_agent はあるが、走っている子を列挙する口が無い
    liveModel: false,  // provider は serve の env。走っている最中には変えられない
    liveMode: false,
    hostTools: false,  // set_status / set_title / fork は未接続。可視化は共通の参照形式で提供
    alwaysAllow: true, // approve の decision に always-allow がある
    login: true,       // codex OAuth を agent-host が代行して auth-profiles.json に書く
    // MCP の担当がエージェントでも、同名の Pleiad の登録の接続先と資格情報を serve 子が Pleiad から引く（core/mcp-credential-bridge.mjs）
    plyMcpNative: true,
  },

  subagentTools: [],
  toolHints: TOOL_HINTS,

  modes: () => MODES,

  suggestTitle: suggestProcwayTitle,

  /**
   * 既存の provider id を保ちつつ、provider/model も受け付ける。
   * UI は接続先と自由入力可能なモデルを分け、送信時にこの形式へまとめる。
   */
  async models(cwd) {
    const config = await listConnections(cwd);
    const out = { '': { label: '既定に従う', note: '接続設定の既定' } };
    for (const c of config.connections) {
      out[c.id] = { label: c.name, note: [c.type, c.model].filter(Boolean).join(' · ') };
      if (c.model) out[c.id + '/' + c.model] = { label: c.name + ' / ' + c.model, note: c.type };
    }
    return out;
  },
  async validModel(model, cwd) {
    if (typeof model !== 'string' || model.length > 400 || /[\r\n\x00]/.test(model)) return false;
    if (!model) return true;
    const config = await listConnections(cwd);
    return config.connections.some(c => c.id === model.split('/')[0]);
  },

  // ---- 実行 ---------------------------------------------------------------

  async runTurn({ prompt, sessionId, cwd, mode, model, effort, procwayLimits, visualizeInstructions, emit, askPermission, signal, control, contextRuntime, agentRuntime, plyMcpAccess }) {
    const mcp = createMcpConfig(process.env.AGENT_HOST_PROCWAY_HOME ? { home: homeDir(), codexHome: path.join(homeDir(), '.codex') } : {});
    const nativeMcp = contextRuntime?.owners.mcp !== 'ply';
    runtimeConfig = { ...await resolveConnection(model, cwd, procwayLimits), src: await procwaySource(),
      mcpRegistrations: nativeMcp ? await mcp.runtimeServers(cwd) : [],
      // 担当がエージェントでも、同名の Pleiad の登録の接続先と資格情報は Pleiad から引く（core/mcp-credential-bridge.mjs）。
      // servers の中身（名前と更新時刻）が変われば serve を起こし直す（下の revision）。秘密は含まない
      ...(nativeMcp && plyMcpAccess?.servers?.length ? { plyMcp: plyMcpAccess } : {}),
      visualizeInstructions, agentRuntime };
    if (effort) runtimeConfig.provider = { ...runtimeConfig.provider, reasoningEffort: effort };
    if (contextRuntime) runtimeConfig.contextRuntime = { owners: contextRuntime.owners, url: contextRuntime.url, headers: contextRuntime.headers };
    const approvalMode = MODES[mode] ? mode : "always-ask";
    // 次に procway が自分で始めるターン（wake）にも同じモードが効くよう、serve の settings にも入れる
    applyApprovalMode(approvalMode);
    const provider = runtimeConfig.id, modelName = runtimeConfig.model;
    const wantId = sessionId || newSessionId();

    let conn;
    try {
      conn = await acquireTurnConnection(wantId, cwd, { provider, model: modelName });
    } catch (err) {
      emit({ type: "turnResult", outcome: "error", error: String(err?.message ?? err) });
      throw err;
    }

    // ready が返した id を正とする（`?session=` は create-or-resume なので普通は同じ）。
    const id = conn.sessionId || wantId;
    // 新規セッションは id をこちらで決めている（Claude と違って走り出す前に確定する）。
    // **id が決まった最初の 1 本だけ** `first: true` を付けて出す。web の isMine は
    // これでしか新規 id を採用しないので、出さないと web が id を受け取れない。
    // 逆に、再開ターンでは出さない。sessionId が空の session は絶対に出さない
    // （sidecar に "null" 行が生える）。
    if (!sessionId) emit({ type: "session", sessionId: id, first: true });
    if (control) control.handle = { conn, sessionId: id };
    // 接続を用意する間に serve が入れ替わっていても、ここで同じモードが届いている
    applyApprovalMode(approvalMode);

    const d = createDriver(conn, { permissionSessionId: id });
    conn.owner = d;
    d.attach({ emit, askPermission, signal });
    if (!d.done) {
      // 再接続時に replay された承認（まだ誰も答えていない park）を先に流し込む
      for (const ev of [...conn.parked.values()]) {
        conn.parked.delete(ev.requestId);
        conn.byRequest.set(ev.requestId, d);
        d.onEvent(ev);
      }
      // procway は Pleiad が送っていない区切り（wake など）を走らせている。送っても turn_in_progress で
      // 撥ねられるだけなので、送らずに送信待ちへ戻す（その区切りは外部ターンとして見せる）
      if (conn.running && conn.segment && conn.segment !== d) d.requeue();
      else d.start(String(prompt ?? ""));
    }
    // ターンの途中に来た送信は、この区切りの継ぎ目へ差し込む（送信待ちにしない）。
    // 受理は「積んだ」でしかないので、渡った合図を後から出せることを steerConfirms で伝える
    if (control && !d.done) {
      control.steer = d.steer;
      control.steerConfirms = true;
      // 捨てられた合図はターンが終わった後に届くことがあるので、finally では外さない（次のターンが張り替える）
      conn.onSteerDropped = (ids) => { for (const id of ids) emit({ type: "userMessage.dropped", messageId: String(id) }); };
    }

    let outcome;
    try {
      outcome = await d.ended;
    } finally {
      activeTurns -= 1;
      // steerConfirms は消さない。受理の直後に走る server の delivered がこれを読む
      if (control) { control.handle = null; control.steer = null; }
    }
    // 中断も失敗も turnResult で伝えてある。ここで throw すると server が
    // reply(false, …) を二重に送るだけなので投げない（P1 §5.1）。
    // requeue は「何も届いていない。送信待ちへ戻して」の合図（server の runTurn が outbox に戻す）
    return { sessionId: id, ...(outcome === "requeue" ? { requeue: true } : {}) };
  },

  // ---- セッション管理 -----------------------------------------------------

  /**
   * `listSessions` コマンドではなく `~/.procway/ai-agent/sessions/index.json` を直接読む。
   * 理由: WS 経由の listSessions は**接続時に解決した cwd で絞られる**（付録 A.7）ので、
   * 別プロジェクトで作ったセッションが一覧から消える。agent-host の一覧は
   * バックエンド横断の「全部の会話」なので、絞られると穴が開く。
   * ついでに、一覧を出すだけで serve プロセスを起こさずに済む。
   */
  async listSessions({ limit = 100 } = {}) {
    const index = await readJson(path.join(sessionsDir(), "index.json"));
    const rows = Object.entries(index?.sessions ?? {})
      .map(([id, meta]) => toRow(id, meta))
      .filter(Boolean);
    rows.sort((a, b) => String(b.lastModified ?? "").localeCompare(String(a.lastModified ?? "")));
    return rows.slice(0, limit);
  },

  async getSession(sessionId) {
    if (!sessionId) return null;
    const safe = String(sessionId);
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(safe)) return null;
    const meta = await readJson(path.join(sessionsDir(), safe, "meta.json"));
    if (meta) return toRow(safe, meta);
    // meta.json がまだ書かれていない（作りかけ）ときは index を見る
    const index = await readJson(path.join(sessionsDir(), "index.json"));
    return toRow(safe, index?.sessions?.[safe] ?? null);
  },

  /**
   * snapshot.json の messages（射影ではなく生のメッセージ）を NormalizedMessage にする。
   * 射影（session.resumed の transcriptFromMessages）を採らないのは、
   * **本文とツール呼びが同時にある assistant からツール呼びが落ちる**ため（付録 A.5）。
   * 生メッセージなら tool_use と tool_result が両方そろう。
   *
   * 注意: 生 messages は snapshot 時点のもので、その後の events.jsonl の分は入らない
   * （procway 自身の resume は snapshot + 追い足しの再生でこれを埋める）。
   * 履歴表示としては「直近の 1 ターンが欠けることがある」を許容する。
   */
  async getMessages(sessionId, { fullResults = false } = {}) {
    const safe = String(sessionId ?? "");
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(safe)) return [];
    // Detached approval continuations can emit completion while procway is replacing the snapshot.
    // Retry a transient partial JSON file; a persistently unreadable history must still fail.
    let snap;
    for (let attempt = 0; ; attempt++) {
      try {
        snap = JSON.parse(await fs.readFile(path.join(sessionsDir(), safe, "snapshot.json"), "utf8"));
        break;
      } catch (e) {
        if (attempt >= 9 || (!(e instanceof SyntaxError) && e.code !== "ENOENT")) throw e;
        await wait(50);
      }
    }
    if (!Array.isArray(snap?.messages)) throw new Error("procway の履歴を読み出せません");
    const raw = snap.messages;

    const messages = [];
    const calls = new Map();   // toolCallId -> toolCall（結果は後の tool メッセージで埋める）
    let resumeNext = false;

    for (const m of raw) {
      // system プロンプトは会話ではない
      if (m?.role === "system") continue;
      // procway が自分で差し込んだ再開の合図（wake ターンの user メッセージ。本文は丸ごと <system-reminder>）。
      // 利用者の発言ではないので吹き出しにしない。直後の返答に resumed を付け、web が「再開した」の一行を出す
      if (m?.role === "user" && m.wake === true) { resumeNext = true; continue; }
      const content = Array.isArray(m?.content) ? m.content : [];

      let text = "";
      const toolCalls = [];
      for (const b of content) {
        if (b?.kind === "text" && typeof b.text === "string") text += b.text;
        else if (b?.kind === "tool_use") {
          const call = {
            id: b.toolCallId ? String(b.toolCallId) : null,
            name: String(b.name ?? "tool"),
            input: b.args && typeof b.args === "object" ? b.args : {},
            result: null,
          };
          toolCalls.push(call);
          if (call.id) calls.set(call.id, call);
        } else if (b?.kind === "tool_result") {
          const call = calls.get(String(b.toolCallId ?? ""));
          const { text: t, truncated } = cut(resultText(b.result));
          if (call) call.result = { text: fullResults ? resultText(b.result) : t, isError: b.ok === false, truncated: fullResults ? false : truncated };
        }
      }

      // tool_result だけの行は発言ではない。上で紐づけたので捨てる
      const thinking = typeof m?.meta?.reasoningContent === "string" ? m.meta.reasoningContent : null;
      if (!text && !thinking && toolCalls.length === 0) continue;

      const msg = {
        role: m.role === "user" ? "user" : "assistant",
        text,
        uuid: m.id ?? null,
        // procway は生メッセージに時刻を持たない。セッションの更新時刻で代用しない
        // （行ごとに違う時刻を捏造すると履歴の並びが嘘になる）
        at: null,
      };
      if (thinking) msg.thinking = thinking;
      if (toolCalls.length) {
        msg.tools = toolCalls.map((c) => c.name);
        msg.toolCalls = toolCalls;
      }
      if (resumeNext && msg.role === "assistant") msg.resumed = true;
      resumeNext = false;
      messages.push(msg);
    }

    return messages;
  },

  // ---- 認証 ---------------------------------------------------------------
  //
  // procway-code の codex provider は auth-profiles.json のプロファイル `codex` を読む。
  // ログインは `procway-code auth login codex` でもできるが、agent-host から
  // 端末を触らずに済ませられるよう、同じ OAuth を移植して同じファイルに書く。

  auth: {
    async status() {
      const available = await listConnections().catch(() => ({ connections: [] }));
      const apiReady = available.connections.some(c => c.ready && c.type !== 'openai-codex');
      const profile = await tokens.readProfile(AUTH_PROFILE).catch(() => null);
      const cred = profile?.credentials;
      if (!cred?.access) return { loggedIn: apiReady, oauthLoggedIn: false, account: apiReady ? 'API 接続を設定済み' : null };
      const account = typeof cred.accountId === "string" ? cred.accountId : "";
      return {
        loggedIn: true,
        oauthLoggedIn: true,
        // シークレットは出さない。accountId も先頭 4 + 末尾 4 だけ
        account: account.length > 8 ? `${account.slice(0, 4)}…${account.slice(-4)}` : (account || null),
        detail: Number.isFinite(cred.expires)
          ? `有効期限 ${new Date(cred.expires).toLocaleString()}`
          : null,
      };
    },

    /**
     * 127.0.0.1:1455 にコールバックを立てて待つ。
     * ポートが塞がっていたら phase:"url" の message で手貼りを促し、
     * `authSubmit` コマンド（-> submitCode）で完了させる。
     */
    async login({ emit }) {
      if (pendingManual) throw new Error("ログインが既に走っている");
      let hand;
      pendingManual = new Promise((resolve) => { hand = resolve; });
      submitManual = hand;

      const timer = setTimeout(() => hand?.(null), LOGIN_TIMEOUT_MS);
      timer.unref?.();

      try {
        const creds = await loginOpenAICodex({
          originator: ORIGINATOR,
          onAuth: ({ url, instructions }) => emit?.({ type: "auth", phase: "url", url, message: instructions ?? null }),
          // ブラウザ待ちと並走する手貼り。先に決着したほうが勝つ
          onManualCodeInput: () => pendingManual.then((v) => {
            if (v == null) throw new Error("ログインが時間切れになった");
            return v;
          }),
          // ブラウザ待ちが空振りしたときの最後の手段
          onPrompt: () => pendingManual.then((v) => {
            if (v == null) throw new Error("ログインが時間切れになった");
            return v;
          }),
        });
        await tokens.writeOAuthProfile(AUTH_PROFILE, AUTH_PROVIDER, creds);
        emit?.({ type: "auth", phase: "done", message: "codex にログインした" });
      } catch (err) {
        emit?.({ type: "auth", phase: "error", message: String(err?.message ?? err) });
        throw err;
      } finally {
        clearTimeout(timer);
        pendingManual = null;
        submitManual = null;
      }
    },

    /** 手貼りされたリダイレクト URL / code を login の待ちへ渡す。 */
    async submitCode(input) {
      if (!submitManual) throw new Error("いまログインを待っていない");
      const value = String(input ?? "").trim();
      if (!value) throw new Error("貼り付ける内容が空");
      submitManual(value);
    },

    async logout() {
      await tokens.deleteProfile(AUTH_PROFILE);
    },
  },
};

// login と submitCode をつなぐ 1 本きりの待ち合わせ。
// 同時に 2 つのログインを走らせない（1455 番も 1 つしか取れない）。
let pendingManual = null;
let submitManual = null;
return { backend, dispose: () => stopServe('接続を終了した'), setHostId: (id) => { if (id) hostId = id; } };
}

// Separate processes per active conversation: changing one connection or budget
// cannot silently borrow another conversation's credentials or interrupt it.
const base = createWorker();
const workers = new Map();
export const backend = {
  ...base.backend,
  /**
   * server から、ターンの外で起きたことを届ける口を受け取る（docs/multi-backend.md §2.7）。
   *   background(sessionId, tasks)  … 裏で動いている子の全量（空で消える）
   *   externalTurn(sessionId, run)  … procway が自分で始めたターン（wake）を Pleiad のターンとして走らせる
   */
  attachHost(h) { host = h; },
  // Only the dedicated worker for this host conversation, including its native background jobs.
  stopSession(id) { const worker = workers.get(id); if (worker) { worker.dispose(); workers.delete(id); } },
  async runTurn(args) {
    const id = args.hostSessionId || args.sessionId;
    const worker = id ? workers.get(id) || createWorker() : createWorker();
    const temporaryId = id || crypto.randomUUID();
    workers.set(temporaryId, worker);
    worker.setHostId(id);
    return worker.backend.runTurn({ ...args, emit(event) {
      if (!id && event.type === 'session' && event.sessionId) {
        workers.delete(temporaryId); workers.set(event.sessionId, worker);
        worker.setHostId(event.sessionId);
      }
      args.emit(event);
    } });
  },
};
process.once('exit', () => { for (const worker of workers.values()) worker.dispose(); });
