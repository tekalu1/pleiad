// 段階 0 の探りの共通部品。LLM は呼ばない（偽のモデル提供元 mock-model.mjs）。
// 本物の codex の会話の記録（CODEX_HOME）を汚さないよう、CODEX_HOME は毎回一時フォルダーにする。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startMockModel } from './mock-model.mjs';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const t0 = Date.now();
export const log = (...a) => console.log(`[${String(Date.now() - t0).padStart(6)}ms]`, ...a);

export function codexExe() {
  // 利用者の PATH の codex（共有の app-server を持つインストール版とは別のプロセスとして立てる）
  return process.env.PROBE_CODEX_BIN || 'codex';
}

/** 一時の CODEX_HOME と偽のモデル提供元を用意する。close() で全部消す。 */
export async function makeEnv({ extraConfig = '' } = {}) {
  // codex は一時フォルダー（%TEMP%）の下の CODEX_HOME を断る（helper binaries）。worktree の temporary/（追跡外）に作る
  const base = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1')), '../../../temporary/zdu');
  fs.mkdirSync(base, { recursive: true });
  const home = fs.mkdtempSync(path.join(base, 'codex-home-'));
  const work = fs.mkdtempSync(path.join(base, 'work-'));
  const mock = await startMockModel({ log });
  fs.writeFileSync(path.join(home, 'config.toml'), `model = "mock-model"
model_provider = "mock"
${extraConfig}
[model_providers.mock]
name = "mock"
base_url = "http://127.0.0.1:${mock.port}/v1"
wire_api = "responses"
requires_openai_auth = false
supports_websockets = false
`);
  const env = { ...process.env, CODEX_HOME: home, RUST_LOG: 'warn' };
  delete env.OPENAI_API_KEY; delete env.CODEX_API_KEY;
  return {
    home, work, mock, env,
    async close() {
      mock.close();
      await sleep(300);
      for (const d of [home, work]) { try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch (e) { log('cleanup failed', d, e.message); } }
    },
  };
}

/** 改行区切り JSON-RPC の相手（クライアント）。write は差し替えられる。 */
export class Rpc {
  constructor(name, write) {
    this.name = name; this.write = write; this.nextId = 0; this.pending = new Map(); this.buf = '';
    this.notifications = []; this.serverRequests = []; this.onServerRequest = null; this.raw = [];
  }
  feed(chunk) {
    this.buf += chunk; let i;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).trim(); this.buf = this.buf.slice(i + 1);
      if (!line) continue;
      let m; try { m = JSON.parse(line); } catch { this.raw.push(line); continue; }
      this.dispatch(m);
    }
  }
  dispatch(m) {
    if (m.id !== undefined && m.method === undefined) {
      const p = this.pending.get(m.id); if (!p) { log(`[${this.name}] orphan response`, JSON.stringify(m).slice(0, 200)); return; }
      this.pending.delete(m.id); m.error ? p.resolve({ error: m.error }) : p.resolve({ result: m.result }); return;
    }
    if (m.id !== undefined) { this.serverRequests.push(m); this.onServerRequest?.(m); return; }
    this.notifications.push(m);
  }
  send(frame) { this.write(JSON.stringify(frame) + '\n'); }
  request(method, params = {}, ms = 20000) {
    const id = ++this.nextId;
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this.pending.delete(id); resolve({ timeout: true }); }, ms);
      this.pending.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v); } });
      this.send({ jsonrpc: '2.0', id, method, params });
    });
  }
  notify(method, params) { this.send({ jsonrpc: '2.0', method, params }); }
  respond(id, result) { this.send({ jsonrpc: '2.0', id, result }); }
  async waitFor(pred, ms = 20000, what = '') {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const hit = this.notifications.find(pred) ?? this.serverRequests.find(pred);
      if (hit) return hit;
      await sleep(50);
    }
    log(`[${this.name}] waitFor timeout`, what); return null;
  }
  summary(from = 0) { return this.notifications.slice(from).map((n) => n.method + (n.params?.item?.type ? `(${n.params.item.type})` : '')).join(' '); }
}

export const CLIENT_INFO = { name: 'zdu-probe', title: 'zdu-probe', version: '0.0.0' };
export const INIT_PARAMS = { clientInfo: CLIENT_INFO, capabilities: { experimentalApi: true } };

export async function handshake(rpc) {
  const r = await rpc.request('initialize', INIT_PARAMS);
  rpc.notify('initialized');
  return r;
}

export function spawnAppServer(env, args = [], opts = {}) {
  const child = spawn(codexExe(), ['app-server', ...args], { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: false, ...opts });
  child.stderrBuf = '';
  child.stderr.on('data', (d) => { child.stderrBuf += d; if (child.stderrBuf.length > 20000) child.stderrBuf = child.stderrBuf.slice(-20000); });
  child.exited = new Promise((r) => child.on('exit', (code, sig) => r({ code, sig })));
  return child;
}

export function killTree(child) {
  try { spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch {}
}
