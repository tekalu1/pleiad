// core/server.mjs を実データの写しで起動し、待ち受けまで・最初の WS の ready までの時間を測る。
// 続けて、旧サーバーを強制終了 → 新サーバーを同じポート・同じ置き場で起動したときの、画面（WS の接続）から見た断の長さを測る。
//
//   node scripts/zero-downtime/runtime/server-startup.mjs --data <写しのディレクトリ> [--runs 5] [--handovers 3] [--port 17497] [--server-root <core/ の親>]
// --server-root は別の場所（core/ の親）のサーバーを起動する。--fresh-copy-from <app ディレクトリ> は、実行ごとに新しく写した直後のその写しから起動する
// （書いたばかりのファイルの最初の読みの遅さ込みの起動時間。実行場所への写しの直後にサーバーを起こす流れの確認）。既定はこのリポジトリ
//
// 写しは `node scripts/copy-data-dir.mjs temporary/data-copy` で作る（元の ~/.agent-host は読むだけ）。測り終えたら写しを消す。
// 本物のエージェントを起こさないよう、claude / codex / agy の実行ファイルを存在しないパスにし、git の撮影・worktree は止める。
// 時刻は全部この測るプロセスの Date.now()（ミリ秒）。ロックを取った時刻だけは、サーバーが pleiad.lock に書く startedAt（同じ時計）を使う。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../..');
const require = createRequire(import.meta.url);
const { WebSocket } = require(path.join(root, 'node_modules', 'ws'));
const arg = (name, dflt) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : dflt; };
const dataDir = path.resolve(arg('--data'));
const runs = Number(arg('--runs', 5));
const handovers = Number(arg('--handovers', 3));
const port = Number(arg('--port', 17497));
let serverRoot = path.resolve(arg('--server-root', root));
const freshFrom = arg('--fresh-copy-from', null);
const TOKEN = 'zdprobe-token';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const median = a => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];

function startServer() {
  const t0 = Date.now();
  const missing = path.join(os.tmpdir(), 'zdprobe-no-such-binary.exe');
  const child = spawn(process.execPath, [path.join(serverRoot, 'core', 'server.mjs')], {
    cwd: os.homedir(), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    env: { ...process.env, AGENT_HOST_DATA: dataDir, AGENT_HOST_PORT: String(port), AGENT_HOST_BIND: '127.0.0.1', AGENT_HOST_TOKEN: TOKEN,
      AGENT_HOST_CLAUDE_BIN: missing, AGENT_HOST_CODEX_BIN: missing, AGENT_HOST_AGY_BIN: missing, AGENT_HOST_GIT_SNAPSHOTS: 'off', AGENT_HOST_WORKTREES: 'off', AGENT_HOST_LOCALE: 'ja' },
  });
  const server = { child, t0, out: '', exited: null, listenAt: null, listenPort: null };
  const onData = d => {
    server.out += d.toString();
    if (!server.listenAt) { const m = server.out.match(/agent-host\s+http:\/\/[^:]+:(\d+)\//); if (m) { server.listenAt = Date.now(); server.listenPort = Number(m[1]); } }
  };
  child.stdout.on('data', onData); child.stderr.on('data', onData);
  child.once('exit', () => { server.exited = Date.now(); });
  return server;
}

async function untilListening(server, timeoutMs = 180000) {
  const t = Date.now();
  while (!server.listenAt) { if (server.exited) throw new Error('server exited early:\n' + server.out.slice(-1500)); if (Date.now() - t > timeoutMs) throw new Error('listen timeout:\n' + server.out.slice(-1500)); await sleep(5); }
}

/** WS をつないで ready を待つ。つながらなければ intervalMs ごとにやり直す（画面の自動つなぎ直しと同じ形） */
function connectReady(url, { intervalMs = 25, timeoutMs = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now(); let ws = null, done = false;
    const attempt = () => {
      if (done) return;
      if (Date.now() - t0 > timeoutMs) return reject(new Error('ws ready timeout'));
      ws = new WebSocket(url);
      ws.on('message', raw => { try { if (JSON.parse(raw.toString()).kind === 'ready' && !done) { done = true; resolve({ ws, at: Date.now(), attempts }); } } catch { /* 次へ */ } });
      ws.on('error', () => {});
      ws.on('close', () => { if (!done) setTimeout(attempt, intervalMs); });
      attempts++;
    };
    let attempts = 0;
    attempt();
  });
}

/** ready の後に画面が最初に頼む listSessions の応答までの時間（ms）と、返ってきた会話の数 */
function firstList(ws) {
  return new Promise(resolve => {
    const t0 = Date.now();
    ws.on('message', raw => { try { const m = JSON.parse(raw.toString()); if (m.kind === 'response' && m.id === 1) resolve({ ms: Date.now() - t0, ok: m.ok, count: Array.isArray(m.result) ? m.result.length : (m.result?.sessions?.length ?? null) }); } catch { /* 次へ */ } });
    ws.send(JSON.stringify({ kind: 'command', id: 1, command: 'listSessions', args: {} }));
  });
}

const lockedAt = () => { try { return Date.parse(JSON.parse(fs.readFileSync(path.join(dataDir, 'pleiad.lock'), 'utf8')).startedAt); } catch { return null; } };
const stop = async server => { if (!server.exited) { server.child.kill(); await new Promise(r => server.child.once('exit', r)); } };

const result = { dataDir: '(写し)', node: process.version, runs: [], handovers: [] };

for (let i = 0; i < runs; i++) {
  let freshCopyMs = null, freshDir = null;
  if (freshFrom) {
    freshDir = path.join(process.env.LOCALAPPDATA, 'zdprobe-copytest', `run-${i}`);
    fs.rmSync(freshDir, { recursive: true, force: true });
    const t = Date.now();
    await fs.promises.cp(path.resolve(freshFrom), freshDir, { recursive: true });
    freshCopyMs = Date.now() - t;
    serverRoot = freshDir;
  }
  const s = startServer();
  await untilListening(s);
  const lock = lockedAt();
  const c = await connectReady(`ws://127.0.0.1:${s.listenPort}/ws?token=${TOKEN}`);
  const list = await firstList(c.ws);
  result.runs.push({ run: i + 1, freshCopyMs, listSessions: list, spawnToLockMs: lock ? lock - s.t0 : null, lockToListenMs: lock ? s.listenAt - lock : null, spawnToListenMs: s.listenAt - s.t0, listenToWsReadyMs: c.at - s.listenAt, spawnToWsReadyMs: c.at - s.t0, stdoutNotes: s.out.split('\n').filter(l => /移行|migrated|失敗|error|Error|使えない/i.test(l)).slice(0, 4) });
  c.ws.close(); await stop(s); await sleep(500);
  if (freshDir) fs.rmSync(freshDir, { recursive: true, force: true });
}

for (let i = 0; i < handovers; i++) {
  const s1 = startServer();
  await untilListening(s1);
  const c1 = await connectReady(`ws://127.0.0.1:${s1.listenPort}/ws?token=${TOKEN}`);
  const closed = new Promise(r => c1.ws.once('close', () => r(Date.now())));
  const killAt = Date.now();
  s1.child.kill();
  await new Promise(r => s1.child.once('exit', r));
  const exitAt = s1.exited ?? Date.now();
  const closeAt = await Promise.race([closed, sleep(3000).then(() => null)]);
  // 旧サーバーが居なくなった直後に、新しいサーバーを同じポート・同じ置き場で起こす。画面は 25ms ごとにつなぎ直す
  const s2 = startServer();
  const reconnect = connectReady(`ws://127.0.0.1:${port}/ws?token=${TOKEN}`, { intervalMs: 25 });
  await untilListening(s2);
  const lock = lockedAt();
  const c2 = await reconnect;
  const list2 = await firstList(c2.ws);
  result.handovers.push({ run: i + 1, firstListSessionsMs: list2.ms, screenDownIncludingFirstListMs: c2.at + list2.ms - (closeAt ?? killAt), killToExitMs: exitAt - killAt, screenSawCloseAfterKillMs: closeAt ? closeAt - killAt : null,
    s2SpawnToLockMs: lock ? lock - s2.t0 : null, s2LockToListenMs: lock ? s2.listenAt - lock : null, exitToS2ListenMs: s2.listenAt - exitAt,
    screenDownMs: c2.at - (closeAt ?? killAt), samePort: s2.listenPort === port, portFallbackMessage: /使えない/.test(s2.out), wsAttempts: c2.attempts });
  c2.ws.close(); await stop(s2); await sleep(500);
}

const stat = key => { const v = result.runs.map(r => r[key]).filter(x => x != null); return v.length ? { min: Math.min(...v), median: median(v), max: Math.max(...v) } : null; };
result.summary = Object.fromEntries(['spawnToLockMs', 'lockToListenMs', 'spawnToListenMs', 'listenToWsReadyMs', 'spawnToWsReadyMs'].map(k => [k, stat(k)]));
console.log(JSON.stringify(result, null, 2));
