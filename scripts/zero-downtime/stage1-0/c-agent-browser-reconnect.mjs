// 1-0 c: `agent-browser` の常駐（デーモン）が、CDP 中継の切断から戻るか。
//   env -u ELECTRON_RUN_AS_NODE node scripts/zero-downtime/stage1-0/c-agent-browser-reconnect.mjs [場面ID...]
// 本物の `agent-browser`（node_modules/agent-browser/bin）を、本物の中継（desktop/browser-relay.cjs。待ち受けのポートと鍵だけを
// 環境変数で決められるようにした写し）に向け、中継を止める・同じポートと鍵で立て直す・別のポートと鍵で立てる、を行って、
// 次の呼び出しが通るかを見る。環境変数は core/agent-browser.mjs の browserEnvironment と同じ形（設定ファイルに { cdp } を書く）。
// インストール版 Pleiad の中継・agent-browser の常駐には触れない（セッション名・ソケットの置き場・userData は全部この試験のもの）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, spawnSync, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../..');
const electron = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe');
const abBin = path.join(root, 'node_modules', 'agent-browser', 'bin', 'agent-browser-win32-x64.exe');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'zd-c-'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 23), ...a);

// ---- 中継の写し（ポート・鍵を決められるようにする。1-5 でやる直し方の最小形）
const relaySrc = path.join(work, 'browser-relay.cjs');
{
  let s = fs.readFileSync(path.join(root, 'desktop', 'browser-relay.cjs'), 'utf8');
  const edits = [
    ["require('ws')", `require(${JSON.stringify(path.join(root, 'node_modules', 'ws').replace(/\\/g, '/'))})`],
    ['server.listen(0, ', 'server.listen(Number(process.env.ZD_RELAY_PORT || 0), '],
    ['key: random(),', 'key: process.env.ZD_RELAY_KEY || random(),'],
  ];
  for (const [from, to] of edits) { if (!s.includes(from)) throw new Error(`patch target missing: ${from}`); s = s.replace(from, to); }
  fs.writeFileSync(relaySrc, s);
}

// ---- 試験用のページ
const pageServer = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end('<!doctype html><title>zd page</title><h1 id="h">hello</h1><button id="b" onclick="document.title=\'clicked\'">go</button>'); });
await new Promise(r => pageServer.listen(0, '127.0.0.1', r));
const pageUrl = `http://127.0.0.1:${pageServer.address().port}/`;

const hosts = new Set();
let hostSeq = 0;
async function startHost({ port, key, tabUrl } = {}) {
  const n = ++hostSeq;
  const out = path.join(work, `host-${n}.json`);
  const env = { ...process.env, ZD_USERDATA: path.join(work, `ud-${n}`), ZD_OUT: out, ZD_RELAY_SRC: relaySrc };
  delete env.ELECTRON_RUN_AS_NODE;
  if (port) env.ZD_RELAY_PORT = String(port);
  if (key) env.ZD_RELAY_KEY = key;
  if (tabUrl) env.ZD_TAB_URL = tabUrl;
  const t0 = Date.now();
  const child = spawn(electron, [path.join(here, 'c-relay-host.cjs')], { env, stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true });
  const host = { n, child, out, pid: child.pid, exited: false };
  child.on('exit', () => { host.exited = true; });
  hosts.add(host);
  for (let i = 0; i < 300 && !fs.existsSync(out); i++) await sleep(100);
  if (!fs.existsSync(out)) throw new Error('host did not start');
  Object.assign(host, JSON.parse(fs.readFileSync(out, 'utf8')), { startMs: Date.now() - t0 });
  const m = /ws:\/\/127\.0\.0\.1:(\d+)\/devtools\/browser\/([a-f0-9]{48})/.exec(host.url);
  host.port = Number(m[1]); host.key = m[2];
  return host;
}
const hardKill = host => { spawnSync('taskkill', ['/PID', String(host.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); };
async function gracefulClose(host) { host.child.stdin.write('close\n'); for (let i = 0; i < 50 && !host.exited; i++) await sleep(100); if (!host.exited) hardKill(host); }

// ---- agent-browser
function abEnv(name, url) {
  const dir = path.join(work, 'ab', name);
  const socketDir = path.join(work, 'sock', name);
  fs.mkdirSync(dir, { recursive: true }); fs.mkdirSync(socketDir, { recursive: true });
  const file = path.join(dir, 'agent-browser.json');
  return { file, socketDir, session: `zd-${name}`, write(u) { fs.writeFileSync(file, JSON.stringify({ cdp: u })); },
    env: { ...process.env, AGENT_BROWSER_CONFIG: file, AGENT_BROWSER_SESSION: `zd-${name}`, AGENT_BROWSER_SOCKET_DIR: socketDir, AGENT_BROWSER_NAMESPACE: '' } };
}
// 出力はファイルへ。パイプにすると、CLI が起こした常駐がパイプの端を持ち続け、CLI が終わっても execFile が戻らない（40 秒の上限まで待つ）
let abSeq = 0;
function ab(ctx, args, timeoutMs = 40000) {
  return new Promise(resolve => {
    const t = Date.now();
    const base = path.join(work, `ab-${++abSeq}`);
    const o = fs.openSync(`${base}.out`, 'w'), e = fs.openSync(`${base}.err`, 'w');
    const child = spawn(abBin, args, { env: ctx.env, stdio: ['ignore', o, e], windowsHide: true });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
    child.on('exit', code => {
      clearTimeout(timer);
      fs.closeSync(o); fs.closeSync(e);
      const read = f => { try { return fs.readFileSync(f, 'utf8').trim().slice(0, 300); } catch { return ''; } };
      resolve({ args: args.join(' '), ms: Date.now() - t, code: timedOut ? 'timeout' : code, out: read(`${base}.out`), err: read(`${base}.err`) });
    });
  });
}
const procs = () => {
  const r = spawnSync('powershell', ['-NoProfile', '-Command', "Get-CimInstance Win32_Process -Filter \"Name like 'agent-browser%'\" | ForEach-Object { \"$($_.ProcessId)|$($_.ParentProcessId)|$($_.Name)\" }"], { encoding: 'utf8', windowsHide: true });
  return r.stdout.split(/\r?\n/).filter(Boolean).map(l => { const [pid, ppid, name] = l.split('|'); return { pid: Number(pid), ppid: Number(ppid), name }; });
};
const daemonsOf = before => procs().filter(p => !before.has(p.pid));

const results = {};
const record = (scenario, step, r) => { (results[scenario] ??= []).push({ step, ...r }); log(scenario, step, r.code === 0 ? 'OK' : `FAIL(${r.code})`, `${r.ms}ms`, JSON.stringify(r.out || r.err).slice(0, 160)); };

async function daemonLifetime(name, how) {
  const ctx = abEnv(name); const h = await startHost(); ctx.write(h.url);
  const standin = path.join(work, `standin-${name}.mjs`);
  fs.writeFileSync(standin, `import { spawn } from 'node:child_process';
import fs from 'node:fs';
const [bin, url, outFile, how] = process.argv.slice(2);
const o = fs.openSync(outFile, 'w');
const c = spawn(bin, ['open', url], { stdio: ['ignore', o, o], windowsHide: true });   // detached なし = サーバーが起こす CLI と同じ
c.on('exit', code => { fs.writeFileSync(outFile + '.done', String(code)); if (how === 'exit') process.exit(0); setInterval(() => {}, 1000); });
`);
  const outFile = path.join(work, `standin-${name}.out`);
  const sp = spawn(process.execPath, [standin, abBin, pageUrl, outFile, how], { env: ctx.env, detached: true, stdio: 'ignore', windowsHide: true });
  for (let i = 0; i < 100 && !fs.existsSync(outFile + '.done'); i++) await sleep(100);
  const daemons = daemonsOf(before);
  log(name, 'stand-in opened page; daemon pids', JSON.stringify(daemons));
  if (how === 'crash') { spawnSync('taskkill', ['/PID', String(sp.pid), '/F'], { windowsHide: true, stdio: 'ignore' }); }
  else for (let i = 0; i < 50; i++) { try { process.kill(sp.pid, 0); await sleep(100); } catch { break; } }
  await sleep(1500);
  let alive = false; try { process.kill(sp.pid, 0); alive = true; } catch { /* 終わった */ }
  const after = daemonsOf(before);
  log(name, `stand-in (${how}) alive=${alive}; daemon pids after`, JSON.stringify(after));
  results[name] = [{ step: 'daemon-survived', daemonsBefore: daemons.length, daemonsAfter: after.length, standinAlive: alive }];
  record(name, 'get title (CLI called from the test, after the parent is gone)', await ab(ctx, ['get', 'title']));
  await ab(ctx, ['close']); await gracefulClose(h);
}

const SCENARIOS = {
  // 基準: 切らずに続けて呼ぶ
  async s0() {
    const ctx = abEnv('s0'); const h = await startHost(); ctx.write(h.url);
    record('s0', 'open', await ab(ctx, ['open', pageUrl]));
    record('s0', 'get title', await ab(ctx, ['get', 'title']));
    record('s0', 'get title (2)', await ab(ctx, ['get', 'title']));
    await ab(ctx, ['close']); await gracefulClose(h);
  },
  // 本物の障害: main が落ちる（強制終了。TCP は RST）→ 同じポート・鍵で立て直す（タブは URL で開き直した状態）→ すぐ次の呼び出し
  async s1() {
    const ctx = abEnv('s1'); const h1 = await startHost(); ctx.write(h1.url);
    record('s1', 'open', await ab(ctx, ['open', pageUrl]));
    record('s1', 'get title', await ab(ctx, ['get', 'title']));
    const daemon1 = daemonsOf(before).map(p => p.pid);
    hardKill(h1);
    await sleep(3000);
    const h2 = await startHost({ port: h1.port, key: h1.key, tabUrl: pageUrl });
    log('s1', 'host2 same endpoint?', h2.url === h1.url, `startMs=${h2.startMs}`);
    record('s1', 'get title (right after restart)', await ab(ctx, ['get', 'title']));
    record('s1', 'get title (retry)', await ab(ctx, ['get', 'title']));
    record('s1', 'snapshot', await ab(ctx, ['snapshot']));
    record('s1', 'click', await ab(ctx, ['click', '#b']));
    record('s1', 'get title (after click)', await ab(ctx, ['get', 'title']));
    log('s1', 'daemon pids before/after (same daemon reconnected?)', JSON.stringify(daemon1), JSON.stringify(daemonsOf(before).map(p => p.pid)));
    await ab(ctx, ['close']); hardKill(h2);
  },
  // 優しい停止（中継を閉じる。WS は 1000 で閉じる）→ 同じポート・鍵で立て直す
  async s2() {
    const ctx = abEnv('s2'); const h1 = await startHost(); ctx.write(h1.url);
    record('s2', 'open', await ab(ctx, ['open', pageUrl]));
    await gracefulClose(h1);
    await sleep(3000);
    const h2 = await startHost({ port: h1.port, key: h1.key, tabUrl: pageUrl });
    log('s2', 'host2 same endpoint?', h2.url === h1.url);
    record('s2', 'get title (right after restart)', await ab(ctx, ['get', 'title']));
    record('s2', 'get title (retry)', await ab(ctx, ['get', 'title']));
    await ab(ctx, ['close']); hardKill(h2);
  },
  // 今の実装の再現: main が落ちて、別のポート・鍵で立つ。設定ファイルは次のターンの開始で新しい URL に書き換わる
  async s3() {
    const ctx = abEnv('s3'); const h1 = await startHost(); ctx.write(h1.url);
    record('s3', 'open', await ab(ctx, ['open', pageUrl]));
    hardKill(h1);
    await sleep(3000);
    const h2 = await startHost({ tabUrl: pageUrl });
    log('s3', 'new endpoint', h2.port !== h1.port);
    record('s3', 'get title (config still old url)', await ab(ctx, ['get', 'title']));
    ctx.write(h2.url);
    record('s3', 'get title (config rewritten with new url)', await ab(ctx, ['get', 'title']));
    record('s3', 'get title (retry)', await ab(ctx, ['get', 'title']));
    record('s3', 'open again', await ab(ctx, ['open', pageUrl]));
    record('s3', 'get title (after open)', await ab(ctx, ['get', 'title']));
    await ab(ctx, ['close']); hardKill(h2);
  },
  // 同じポート・鍵だが、タブが無い（新しい main がタブを開き直さない場合）
  async s4() {
    const ctx = abEnv('s4'); const h1 = await startHost(); ctx.write(h1.url);
    record('s4', 'open', await ab(ctx, ['open', pageUrl]));
    hardKill(h1);
    await sleep(3000);
    const h2 = await startHost({ port: h1.port, key: h1.key });
    record('s4', 'get url (no tab restored)', await ab(ctx, ['get', 'url']));
    record('s4', 'open', await ab(ctx, ['open', pageUrl]));
    record('s4', 'get title (after open)', await ab(ctx, ['get', 'title']));
    await ab(ctx, ['close']); hardKill(h2);
  },
  // 中継が居ない間（更新の 55〜70 秒の代わりに 20 秒）に呼ぶと、どう失敗し、戻った後に戻るか
  async s5() {
    const ctx = abEnv('s5'); const h1 = await startHost(); ctx.write(h1.url);
    record('s5', 'open', await ab(ctx, ['open', pageUrl]));
    hardKill(h1);
    record('s5', 'get title (relay down)', await ab(ctx, ['get', 'title']));
    await sleep(20000);
    record('s5', 'get title (relay still down, 20s later)', await ab(ctx, ['get', 'title']));
    const h2 = await startHost({ port: h1.port, key: h1.key, tabUrl: pageUrl });
    record('s5', 'get title (after relay back)', await ab(ctx, ['get', 'title']));
    record('s5', 'get title (retry)', await ab(ctx, ['get', 'title']));
    await ab(ctx, ['close']); hardKill(h2);
  },

  // 同じポートだが鍵が替わった（設定ファイルは古いまま）。鍵が本当に要るかを見る
  async s6() {
    const ctx = abEnv('s6'); const h1 = await startHost(); ctx.write(h1.url);
    record('s6', 'open', await ab(ctx, ['open', pageUrl]));
    hardKill(h1);
    await sleep(3000);
    const h2 = await startHost({ port: h1.port, tabUrl: pageUrl });
    log('s6', 'same port, new key', h2.port === h1.port, h2.key !== h1.key);
    record('s6', 'get title (config old key)', await ab(ctx, ['get', 'title']));
    ctx.write(h2.url);
    record('s6', 'get title (config new key)', await ab(ctx, ['get', 'title']));
    await ab(ctx, ['close']); hardKill(h2);
  },
  // 常駐の寿命: 起こした側（サーバーの代わりの Node。agent-browser を detached でなく起こす）が落ちたとき、常駐は生き残り、使えるか。
  // 会話のシェルから呼ばれた agent-browser の常駐が、サーバーの切り替え（旧サーバーの終了）をまたぐかの答え
  async s8() { await daemonLifetime('s8', 'crash'); },
  async s9() { await daemonLifetime('s9', 'exit'); },
};

const want = process.argv.slice(2);
const names = want.length ? want : Object.keys(SCENARIOS);
const before = new Set(procs().map(p => p.pid));
try {
  for (const name of names) { log('=== scenario', name); try { await SCENARIOS[name](); } catch (e) { log(name, 'ERROR', e.message); results[name] = [...(results[name] ?? []), { step: 'error', error: e.message }]; } }
} finally {
  const left = daemonsOf(before);
  log('agent-browser processes left behind by this test:', JSON.stringify(left));
  for (const p of left) spawnSync('taskkill', ['/PID', String(p.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  for (const h of hosts) if (!h.exited) hardKill(h);
  pageServer.close();
  await sleep(500);
  fs.writeFileSync(path.join(work, 'results.json'), JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results, null, 2));
  try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* 掴まれていれば残る（%TEMP% の zd-c-*） */ }
  process.exit(0);
}
