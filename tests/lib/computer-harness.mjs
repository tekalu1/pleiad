// ply_computer の単体テストの土台。偽の driver・ロック・保存・承認を組み、会話ごとの接続（connect）から MCP のツールを呼ぶ。
// 実画面にも実際の LLM にも触れない。
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createComputerBridge } from '../../core/computer-bridge.mjs';
import { createComputerLock } from '../../core/computer-use/lock.mjs';
import { fakeComputerDriver } from '../../core/computer-use/driver.mjs';
import { createShots } from '../../core/computer-use/shots.mjs';
import { computerDisplay } from '../../core/computer-use/display.mjs';

const ASK_MODE = { scope: 'workspace', autonomy: 'ask' };
export const BYPASS_MODE = { scope: 'full', autonomy: 'never' };

/**
 * @param waitMs ロックを待つ上限（テストは縮める）
 * @param answers 承認カードの答え。関数（request, index）か配列。既定は「この会話で許可」
 * @param decider wait_until の問いの口 { key(), ask? }（既定はキーを選んでいない）
 * @param platform 操作する PC の OS。偽の driver は Windows のアプリを返すので既定は win32（macOS の CI でも同じ結果にする）
 */
export async function createHarness({ waitMs = 5000, prefs = {}, answers, driverOptions, decider, platform = 'win32' } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-computer-'));
  const driver = fakeComputerDriver(driverOptions);
  const states = [], arms = [], stops = [];
  const lock = createComputerLock({ waitMs, onState: s => states.push(s), onArm: o => arms.push(o), onStop: o => { stops.push(o); driver.stop(o); } });
  driver.onEscape(owner => lock.escape(owner));
  const shots = createShots({ dataDir: dir });
  const db = { prefs: structuredClone(prefs), session: new Map(), always: [], introduced: [] };
  const asked = [];
  const access = {
    getPrefs: async () => structuredClone(db.prefs),
    sessionApps: async id => db.session.get(id) ?? [],
    rememberSession: async (id, ids) => db.session.set(id, [...new Set([...(db.session.get(id) ?? []), ...ids])]),
    rememberAlways: async app => { db.always.push(app); db.prefs.computerUse = { ...(db.prefs.computerUse ?? {}), alwaysAllowed: [...(db.prefs.computerUse?.alwaysAllowed ?? []), app] }; },
    markIntroduced: async () => { db.introduced.push(true); db.prefs.computerUse = { ...(db.prefs.computerUse ?? {}), introduced: true }; },
  };
  const askPermission = async request => {
    asked.push(request);
    const a = typeof answers === 'function' ? await answers(request, asked.length - 1) : Array.isArray(answers) ? answers[asked.length - 1] : undefined;
    return a ?? { allow: true, scope: 'session' };
  };
  const bridge = createComputerBridge({ driver, lock, shots, access, askPermission, translate: (key, params) => `${key}:${JSON.stringify(params)}`, decider, platform });

  const connect = ({ sessionId = 's1', turnId = `turn-${sessionId}`, title = '会話', mode = ASK_MODE, agent = { id: 'claude', label: 'Claude' }, ancestors = [], delivery, locale = 'ja' } = {}) => {
    const ac = new AbortController();
    const state = { turnId, sessionId, title, mode, signal: ac.signal, ancestors, agent };
    const binding = bridge.open({ origin: 'http://127.0.0.1:1', owner: async () => state, locale, agent, delivery });
    let id = 0;
    const rpc = async (method, params) => {
      const body = JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params });
      const req = { method: 'POST', headers: { authorization: binding.headers.Authorization, host: 'x' }, [Symbol.asyncIterator]: async function* () { yield Buffer.from(body); } };
      let out; let status;
      const res = { writeHead(s) { status = s; }, end(x) { out = x === undefined ? undefined : JSON.parse(x); } };
      await bridge.handle(req, res);
      return { status, body: out };
    };
    const api = {
      binding, state, ac, rpc, turnId, sessionId,
      call: async (name, args = {}) => (await rpc('tools/call', { name, arguments: args })).body.result,
      /** 結果の本文（印の行を除く）と印 */
      read: r => computerDisplay(r.content[0].text),
      text: r => r.content[0].text,
      end: () => lock.endTurn(state.turnId),
      newTurn(next) { lock.endTurn(state.turnId); Object.assign(state, { turnId: next }); api.turnId = next; },
    };
    return api;
  };
  return { dir, driver, lock, shots, db, asked, bridge, connect, states, arms, stops,
    inputs: () => driver.calls.filter(c => c.op === 'input').flatMap(c => c.args.actions),
    ops: () => driver.calls.map(c => c.op),
    async close() { await fs.rm(dir, { recursive: true, force: true }); } };
}

export const sleep = ms => new Promise(r => setTimeout(r, ms));

/** 条件が真になるのを待つ（固定の sleep の代わり）。上限を過ぎたら最後の値のまま返す（判定の側が落ちる） */
export async function until(check, ms = 10000) {
  const end = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value || Date.now() > end) return value;
    await sleep(10);
  }
}
