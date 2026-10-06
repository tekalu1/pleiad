// 1-0 a: node-pty を、同梱する公式の Node（node.exe）で読み込み、疑似端末を実際に起こす。
//   <公式の node.exe> scripts/zero-downtime/stage1-0/a-node-pty.mjs [--pty <node-pty のフォルダー>]
// --pty を省くと、リポジトリの node_modules/node-pty から build/ を除いた写しを一時フォルダーに作って使う
// （配布物は electron-builder.yml が build/** を外し、prebuilds だけを持つ。build/Release があると prebuilds より先に読まれる）。
// core/claude-login.mjs の ptySpawner（claude-login の疑似端末の経路）で、cmd の対話と終了コード・幅の広い折り返さない出力・kill を確かめる。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../..');
const argAfter = name => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : null; };

let ptyDir = argAfter('--pty');
let tmp = null;
if (!ptyDir) {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zd-pty-'));
  ptyDir = path.join(tmp, 'node_modules', 'node-pty');
  fs.cpSync(path.join(root, 'node_modules', 'node-pty'), ptyDir, { recursive: true, filter: src => !/[\\/]node-pty[\\/]build([\\/]|$)/.test(src) });
}
const out = { node: process.version, modules: process.versions.modules, napi: process.versions.napi, arch: process.arch, ptyDir: tmp ? '<tmp copy without build/>' : ptyDir, hasBuildDir: fs.existsSync(path.join(ptyDir, 'build')) };
const require = createRequire(path.join(ptyDir, 'x.cjs'));
const pty = require(ptyDir);
out.exports = Object.keys(pty);
out.nativeDir = pty.native?.dir ?? null;

const collect = (p) => new Promise((resolve) => {
  let data = '';
  p.onData(d => { data += d; });
  p.onExit(e => resolve({ ...e, data }));
});
const strip = s => s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07/g, '');
const withTimeout = (pr, ms, what) => Promise.race([pr, new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout ${what}`)), ms))]);

// 1. cmd /c で終了コードと出力
{
  const t = Date.now();
  const p = pty.spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/c', 'echo hello-pty & exit 7'], { name: 'xterm-256color', cols: 1000, rows: 50, cwd: os.tmpdir(), env: process.env });
  const r = await withTimeout(collect(p), 15000, 'cmd-exit');
  out.cmdExit = { ms: Date.now() - t, exitCode: r.exitCode, hasEcho: strip(r.data).includes('hello-pty') };
}

// 2. 対話: 入力を書いて、この Node 自身を疑似端末の下で動かし、isTTY と幅が見えること（claude-login が頼る「端末が付く」条件）
{
  const probe = 'process.stdout.write(JSON.stringify({isTTY:process.stdout.isTTY, stdinTTY:process.stdin.isTTY, cols:process.stdout.columns, rows:process.stdout.rows})+"\\n");' +
    'process.stdin.setEncoding("utf8");process.stdin.once("data",d=>{process.stdout.write("got:"+d.trim()+"\\n");process.exit(0)});';
  const p = pty.spawn(process.execPath, ['-e', probe], { name: 'xterm-256color', cols: 1000, rows: 50, cwd: os.tmpdir(), env: process.env });
  let seen = '';
  p.onData(d => { seen += d; });
  const done = collect(p);
  await new Promise(r => setTimeout(r, 1200));
  p.write('ping\r');
  const r = await withTimeout(done, 15000, 'interactive');
  const text = strip(seen);
  const tty = text.match(/\{[^\n]*\}/)?.[0];
  out.interactive = { exitCode: r.exitCode, tty: tty ? JSON.parse(tty) : null, gotInput: /got:ping/.test(text) };
}

// 3. core/claude-login.mjs の ptySpawner（Claude のログインの経路）。長い 1 行（URL）が折り返されない
{
  const { ptySpawner } = await import(pathToFileURL(path.join(root, 'core', 'claude-login.mjs')).href);
  const spawn = ptySpawner(pty);
  const longUrl = 'https://claude.example/oauth/authorize?' + 'a=b&'.repeat(120);
  const script = `process.stdout.write(${JSON.stringify(longUrl)}+"\\n");setTimeout(()=>process.exit(3),300)`;
  const s = spawn([process.execPath], ['-e', script], { env: process.env, cwd: os.tmpdir() });
  let data = '';
  s.onData(d => { data += d; });
  const r = await withTimeout(new Promise(res => s.onExit(res)), 15000, 'ptySpawner');
  out.ptySpawner = { code: r.code, longLineIntact: strip(data).replace(/[\r\n]/g, '').includes(longUrl) };
  // kill
  const s2 = spawn([process.execPath], ['-e', 'setInterval(()=>{},1000)'], { env: process.env, cwd: os.tmpdir() });
  const exited = new Promise(res => s2.onExit(res));
  await new Promise(r => setTimeout(r, 500));
  s2.kill();
  const r2 = await withTimeout(exited, 15000, 'kill');
  out.kill = { exited: true, code: r2.code };
}

console.log(JSON.stringify(out, null, 2));
if (tmp) try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 掴まれていれば残す */ }
process.exit(0);
