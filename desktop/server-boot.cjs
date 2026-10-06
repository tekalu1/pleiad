// main がサーバーを見つける・起こす・付け直す（段階 1 の 1-4。docs/zero-downtime-update/plan.md、design.md §3.2・§7.1）。
// AGENT_HOST_HANDOVER=on のときだけ main.cjs が使う。off の経路（utilityProcess）は変わらない。
//
// 流れ（chooseServer が決め、connect() が実行する）:
//   1. 走っているサーバーが居るか: データ置き場の main-link.json（パイプの名前・秘密）のパイプにつながれるか。居れば付け直す（起こさない）
//   2. 居なければ、起こせるかを決める: main の Job の制限（desktop/job.cjs）・版ごとの実行場所（desktop/runtime-boot.cjs）。
//      起こせなければ null（今の utilityProcess に落とす。理由は log に残す）
//   3. 実行場所の pleiad-node.exe で core/server.mjs を、main の子でない形（detached・stdio なし）で起こす。標準出力・標準エラーは
//      サーバー自身が logs\server.log に書く（core/server-log.mjs）。サーバーが書く main-link.json（pid が起こしたプロセスのもの）を待ってつなぐ
// worker と同じ形の包み（desktop/server-link.cjs）を返す。つなぐ前に main.cjs が on('message') を付ける（つながった直後に最新の ready が届く）。
// 画面のトークンとポートは、居るサーバーなら ready から、起こすなら AGENT_HOST_TOKEN・AGENT_HOST_PORT（保存したポート。切り替えは前のサーバーの値）で決まる。
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createServerLink, readLinkInfo } = require('./server-link.cjs');

const START_TIMEOUT_MS = 60_000;
const POLL_MS = 100;
/** 起こしたサーバーが、起動の途中で終わった後に、先に居たサーバーへ付け直せるかを待つ間（データ置き場のロックを取れなかった場合） */
const LATE_ATTACH_MS = 5_000;
const LOG_TAIL_CHARS = 2000;
/** パイプが無い・誰も待っていない・切られた。古い main-link.json として扱い、新しく起こす */
const STALE_CODES = new Set(['ENOENT', 'ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'LINK_CLOSED']);

class ServerBootError extends Error {
  constructor(code, message, extra = {}) { super(message); this.name = 'ServerBootError'; this.code = code; Object.assign(this, extra); }
}

const redact = text => String(text).replace(/token=\S+/g, 'token=[redacted]');

/** データ置き場（サーバーの core/store.mjs と同じ決め方） */
function resolveDataDir({ env = process.env, home = require('node:os').homedir() } = {}) {
  return env.AGENT_HOST_DATA ? path.resolve(env.AGENT_HOST_DATA) : path.join(home, '.agent-host');
}

/** サーバーが書く control.json（pid・origin・appVersion・mainLink）。無い・壊れていれば null。付け直しの判断には使わず、記録・エラー文のため */
function readControl(dataDir) {
  try { return JSON.parse(fs.readFileSync(path.join(dataDir, 'control.json'), 'utf8')); } catch { return null; }
}

function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

/** ログの末尾（トークンは伏せる）。起動の失敗の理由をエラーに出すため */
function readLogTail(file, { chars = LOG_TAIL_CHARS } = {}) {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const { size } = fs.fstatSync(fd);
      const length = Math.min(size, chars * 4);   // UTF-8 は 1 文字が最大 4 バイト
      const buffer = Buffer.alloc(length);
      fs.readSync(fd, buffer, 0, length, size - length);
      return redact(buffer.toString('utf8')).slice(-chars).replace(/^�+/, '').trim();
    } finally { fs.closeSync(fd); }
  } catch { return ''; }
}

/**
 * link を、データ置き場の main-link.json が指す居るサーバーへつなぐ。
 * 戻り値 { attached: true, pid, welcome } / { attached: false, reason }（居ない・古い main-link.json）。
 * つなげたが付け直せないときは ServerBootError: 'ipc'（口の版の範囲が合わない。.server に { range, appVersion, pid }）・'unresponsive'（握手に答えない）
 */
async function attachRunning({ link, dataDir, readLink = readLinkInfo, log = () => {} }) {
  const info = readLink(dataDir);
  if (!info) return { attached: false, reason: 'no main-link.json' };
  try {
    const welcome = await link.connect({ pipe: info.pipe, secret: info.secret });
    log(`attached to the running server (pid ${welcome.pid}, version ${welcome.appVersion || '?'}, ipc ${welcome.ipc})`);
    return { attached: true, pid: welcome.pid, welcome };
  } catch (error) {
    if (error.code === 'LINK_REJECTED') throw new ServerBootError('ipc', error.message, { server: error.server ?? null });
    if (STALE_CODES.has(error.code)) return { attached: false, reason: `stale main-link.json (${error.code})` };
    throw new ServerBootError('unresponsive', error.message, { cause: error });
  }
}

/** パイプにつなげる（握手はしない）か。居るサーバーが居るかだけを見る。切るとサーバー側は握手の前の接続として捨てる */
function probeRunning({ dataDir, readLink = readLinkInfo, netConnect = require('node:net').connect, timeoutMs = 1500 }) {
  const info = readLink(dataDir);
  if (!info) return Promise.resolve(false);
  return new Promise(resolve => {
    const socket = netConnect(info.pipe);
    const done = alive => { clearTimeout(timer); socket.destroy(); resolve(alive); };
    const timer = setTimeout(() => done(false), timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

/**
 * サーバーを起こす。戻り値 { pid }（detached は子の PID。起動口が成功したとき）。
 *   mode 'detached'  Node の child_process（detached・stdio なし・windowsHide）
 *   mode 'breakaway' koffi の CreateProcessW + CREATE_BREAKAWAY_FROM_JOB（desktop/job.cjs）
 */
async function launchServer({ mode, nodeExe, args, cwd, env, spawnProcess = spawn, breakaway = options => require('./job.cjs').launchBreakaway(options) }) {
  if (mode === 'breakaway') return breakaway({ exe: nodeExe, args, cwd, env });
  const child = spawnProcess(nodeExe, args, { cwd, env, detached: true, stdio: 'ignore', windowsHide: true });
  await new Promise((resolve, reject) => { child.once('error', reject); child.once('spawn', resolve); });
  child.on('error', () => {});   // 起こした後の失敗は、サーバーが居ないこと（main-link.json が現れない・PID が居ない）で分かる
  child.unref();
  return { pid: child.pid };
}

/** サーバーに渡す env。ELECTRON_RUN_AS_NODE は外す（pleiad-node.exe は素の Node。残すと会話のシェルへ漏れる） */
function serverEnv({ baseEnv = process.env, agentBrowserDir = null, root, key, logFile, port = 0, token = null, systemLocale = '', execPath = process.execPath, resourcesPath = process.resourcesPath, stableCliEnv = {} } = {}) {
  const env = { ...baseEnv };
  delete env.ELECTRON_RUN_AS_NODE;
  const pathKey = Object.keys(env).find(name => name.toLowerCase() === 'path') ?? 'PATH';
  if (agentBrowserDir) env[pathKey] = `${agentBrowserDir}${path.delimiter}${env[pathKey] || ''}`;
  Object.assign(env, stableCliEnv, {
    AGENT_HOST_HANDOVER: 'on', AGENT_HOST_BIND: '127.0.0.1', AGENT_HOST_PORT: String(port || 0), AGENT_HOST_SYSTEM_LOCALE: systemLocale,
    AGENT_HOST_SERVER_LOG: logFile, AGENT_HOST_RUNTIME_ROOT: root, AGENT_HOST_RUNTIME_KEY: key,
  });
  if (token) env.AGENT_HOST_TOKEN = token;
  return env;
}

const serverLogFile = root => path.join(root, 'logs', 'server.log');

/**
 * サーバーを起こして、パイプにつなぐまで待つ。起こしたプロセス（pid）が書いた main-link.json だけを見る（前のサーバーの古いものを掴まない）。
 * 待つ間に起こしたプロセスが終わったら、ログの末尾を持つ ServerBootError('exited')。上限を超えたら 'timeout'
 */
async function startAndConnect({ link, dataDir, launch, logFile, readLink = readLinkInfo, log = () => {}, timeoutMs = START_TIMEOUT_MS, lateAttachMs = LATE_ATTACH_MS, pollMs = POLL_MS,
  alive = isAlive, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), now = () => Date.now() }) {
  let started;
  try { started = await launch(); }
  catch (error) { throw new ServerBootError('launch', `could not start the server: ${error.message}`, { cause: error, detail: error.message }); }
  log(`started the server (pid ${started.pid})`);
  const deadline = now() + timeoutMs;
  for (;;) {
    const info = readLink(dataDir);
    if (info?.pid === started.pid) {
      try {
        const welcome = await link.connect({ pipe: info.pipe, secret: info.secret });
        log(`connected to the new server (pid ${welcome.pid}, ipc ${welcome.ipc})`);
        return { attached: false, pid: started.pid, welcome };
      } catch (error) {
        if (error.code === 'LINK_REJECTED') throw new ServerBootError('ipc', error.message, { server: error.server ?? null });
        if (!STALE_CODES.has(error.code)) throw new ServerBootError('unresponsive', error.message, { cause: error });
      }
    }
    if (!alive(started.pid)) {
      // 前の main が起こしたサーバーがまだ起動の途中で、データ置き場を持っていたのかもしれない。付け直せるなら付け直す
      const lateDeadline = now() + lateAttachMs;
      for (;;) {
        const late = await attachRunning({ link, dataDir, readLink, log }).catch(() => ({ attached: false }));
        if (late.attached) return late;
        if (now() >= lateDeadline) break;
        await sleep(pollMs);
      }
      throw new ServerBootError('exited', 'the server exited during startup', { detail: readLogTail(logFile) });
    }
    if (now() >= deadline) throw new ServerBootError('timeout', 'the server did not come up in time', { detail: readLogTail(logFile) });
    await sleep(pollMs);
  }
}

/**
 * 付いていた main とのつながりだけが切れたとき（サーバーが落ちたのではなく、パイプが切れた・別の main に替わりかけた）、同じ包みでつなぎ直す。
 * つながれば true。居なければ（ENOENT など）false で、呼び出し側が「サーバーが終了しました」にする
 */
async function reattachServer({ link, dataDir, attempts = 3, delayMs = 500, readLink = readLinkInfo, log = () => {}, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const result = await attachRunning({ link, dataDir, readLink, log }).catch(error => ({ attached: false, reason: error.message }));
    if (result.attached) return true;
    if (attempt < attempts) await sleep(delayMs);
  }
  return false;
}

/**
 * 起動の失敗を、利用者向けの文にする（t は desktop/i18n.cjs の t）
 */
function describeBootError(error, t) {
  switch (error?.code) {
    case 'ipc': return t('server.linkRejected', { version: error.server?.appVersion || '?' });
    case 'exited': return t('server.startFailed', { detail: error.detail });
    case 'timeout': return `${t('server.startTimeout')}${error.detail ? `\n${error.detail}` : ''}`;
    case 'launch': return t('server.launchFailed', { detail: error.detail });
    case 'unresponsive': return t('server.unresponsive', { detail: error.cause?.message ?? error.message });
    default: return error?.message ?? String(error);
  }
}

/**
 * どのサーバーを使うかを決める。戻り値:
 *   null（今の utilityProcess に落とす。log に理由）か、
 *   { link, connect, logFile, root }  link は worker と同じ形の包み（まだつながっていない）。connect() で付け直す・起こす
 *     connect() の戻り値 { attached, pid, welcome }。失敗は ServerBootError（describeBootError で文にする）
 * 引数:
 *   resourcesPath・execPath  配布物の resources\ と main の実行ファイル（process.resourcesPath・process.execPath）。1-3 の実行場所を組む
 *   appVersion               この main の版（hello に載せる）
 *   port・token              起こすときの画面のポートとトークン（token は切り替えで前のサーバーのものを引き継ぐとき。無ければサーバーが決める）
 */
async function chooseServer({ resourcesPath, execPath, dataDir = resolveDataDir(), appVersion = '', systemLocale = '', port = 0, token = null, cwd = undefined, env = process.env,
  log = () => {}, prepareRuntime = options => require('./runtime-boot.cjs').prepareRuntime(options), inspectJob = () => require('./job.cjs').inspectJob(),
  decideLaunch = info => require('./job.cjs').decideLaunch(info), stableCliEnv = options => require('./runtime.cjs').stableCliEnv(options), probe = probeRunning,
  launch = launchServer, createLink = createServerLink, resolveRoot = options => require('./runtime.cjs').resolveRuntimeRoot(options), readLink = readLinkInfo, link = null, startTimeoutMs = START_TIMEOUT_MS } = {}) {
  const prepareOptions = { resourcesPath, execPath, env, log: line => log(`runtime: ${line}`) };
  // サーバーのログ（起動の失敗の理由を読む）は実行場所の置き場の下。置き場が決まらなければ無い（その環境ではどのみち起こさない）
  let root = null;
  try { root = resolveRoot({ installDir: path.dirname(execPath), env }).root; } catch { /* 起こす段で落とす */ }
  const logFile = root ? serverLogFile(root) : null;
  const alive = await probe({ dataDir, readLink });
  let plan = null;
  if (alive) {
    const control = readControl(dataDir);
    log(`a server is running${control ? ` (pid ${control.pid}, version ${control.appVersion || '?'})` : ''}`);
    // 居るサーバーに付け直す。この版の実行場所は裏で組む（無停止の切り替えで使う）。待たない
    Promise.resolve(prepareRuntime(prepareOptions)).catch(() => {});
  } else {
    const job = decideLaunch(inspectJob());
    log(`job: ${job.mode} (${job.reason})`);
    if (job.mode === 'unsupported') { log('zero-downtime update is not used: falling back to the utility process'); return null; }
    const runtime = await prepareRuntime(prepareOptions);
    if (!runtime) { log('zero-downtime update is not used: the runtime location could not be prepared; falling back to the utility process'); return null; }
    plan = { mode: job.mode, runtime };
  }
  const serverLink = link ?? createLink({ appVersion, log: line => log(`link: ${line}`) });
  return {
    link: serverLink, logFile, root,
    async connect() {
      const attached = await attachRunning({ link: serverLink, dataDir, readLink, log });
      if (attached.attached) return attached;
      if (!plan) throw new ServerBootError('gone', `the running server went away (${attached.reason})`);
      log(`no running server (${attached.reason}); starting one`);
      const { runtime, mode } = plan;
      const startEnv = serverEnv({ baseEnv: env, agentBrowserDir: runtime.agentBrowserDir, root: runtime.root, key: runtime.key, logFile: serverLogFile(runtime.root), port, token, systemLocale, execPath, resourcesPath,
        stableCliEnv: stableCliEnv({ execPath, resourcesPath }) });
      return startAndConnect({ link: serverLink, dataDir, logFile: serverLogFile(runtime.root), readLink, log, timeoutMs: startTimeoutMs,
        launch: () => launch({ mode, nodeExe: runtime.nodeExe, args: [path.join(runtime.appDir, 'core', 'server.mjs')], cwd, env: startEnv }) });
    },
  };
}

module.exports = {
  ServerBootError, START_TIMEOUT_MS, LATE_ATTACH_MS, STALE_CODES,
  resolveDataDir, readControl, isAlive, readLogTail, attachRunning, probeRunning, launchServer, serverEnv, serverLogFile, startAndConnect, reattachServer, describeBootError, chooseServer,
};
