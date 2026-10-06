// 保持役（core/holder/）の試験の部品。同じプロセスに保持役を立て（本物の子として tests/lib/holder-fake-child.mjs を起こす）、クライアントをつなぐ。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createHolder } from '../../core/holder/holder.mjs';
import { HolderClient } from '../../core/holder/client.mjs';
import { holderPipeName, holderFilePath } from '../../core/holder/protocol.mjs';

export const FAKE_CHILD = path.join(path.dirname(fileURLToPath(import.meta.url)), 'holder-fake-child.mjs');
export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pleiad-holder-'));
export const removeDir = dir => fs.rmSync(dir, { recursive: true, force: true });

export async function waitFor(check, ms = 8000, label = 'condition') {
  const end = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timeout: ${label}`);
    await sleep(10);
  }
}

export function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

/** 偽の子を起こす spawn の引数 */
export const fakeChild = (id, mode, ...args) => ({ id, command: process.execPath, args: [FAKE_CHILD, mode, ...args.map(String)], env: process.env, policy: 'none' });

/** 保持役を立てる（実行場所の置き場・データ置き場は一時フォルダー。パイプの名前はそこから決まるので並行しても重ならない） */
export async function startHolder(options = {}) {
  const dir = tempDir();
  const dataDir = path.join(dir, 'data');
  const root = path.join(dir, 'runtime');
  const file = holderFilePath(root, dataDir);
  const pipe = holderPipeName(dataDir);
  const logs = [];
  const holder = createHolder({ pipe, file, appVersion: '9.9.9', log: line => logs.push(line), idleMs: 0, exitGraceMs: 300, ...options });
  await holder.listen();
  const clients = new Set();
  return {
    holder, dir, dataDir, root, file, pipe, logs, secret: holder.secret,
    /** 握手の済んだクライアント。events に出来事が溜まる */
    async connect(clientOptions = {}) {
      const client = new HolderClient({ pipe, secret: holder.secret, appVersion: '1.0.0', ...clientOptions });
      const events = collect(client);
      await client.connect();
      clients.add(client);
      return { client, events };
    },
    async stop() {
      for (const client of clients) client.close();
      await holder.close();
      removeDir(dir);
    },
  };
}

/** クライアントの出来事を溜める */
export function collect(client) {
  const events = { out: [], err: [], exit: [], overflow: [], fault: [], disconnect: [] };
  for (const type of Object.keys(events)) client.on(type, value => events[type].push(value));
  events.lines = id => events.out.filter(e => e.id === id && !e.redelivered).map(e => JSON.parse(e.line));
  events.seqs = id => events.out.filter(e => e.id === id && !e.redelivered).map(e => e.seq);
  return events;
}

/** 素のソケットで保持役につなぎ、受けたフレームと閉じたかを見る（握手の拒否・読まない親を作るため） */
export async function rawConnect(pipe) {
  const net = await import('node:net');
  const { encodeLine, decodeLine, createLineReader } = await import('../../core/link-codec.mjs');
  const socket = net.connect(pipe);
  const state = { frames: [], bytes: 0, closed: false };
  const reader = createLineReader({ maxBytes: 128 * 1024 * 1024, onLine: text => state.frames.push(decodeLine(text)) });
  socket.on('data', chunk => { state.bytes += chunk.length; reader.push(chunk); });
  socket.on('error', () => {});
  socket.on('close', () => { state.closed = true; });
  return { socket, state, write: frame => socket.write(`${encodeLine(frame)}\n`) };
}

export const hello = (secret, extra = {}) => ({ t: 'hello', secret, protocol: [1, 1], role: 'server', pid: process.pid, appVersion: '1.0.0', ...extra });
export const randomSecret = () => crypto.randomBytes(8).toString('hex');
