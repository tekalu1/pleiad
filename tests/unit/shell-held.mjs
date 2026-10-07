// `!` の行を保持役に載せる部品（無停止の更新 段階 3。core/shell-held.mjs と core/shell-runs.mjs の handOff・adopt・stopAll）。サーバーを立てず、本物の保持役と
// 同じプロセスの 2 つの shell-runs（旧サーバー A・新サーバー B の身代わり。A が手を離した後、保持役への共有の口をつなぎ直して B が付け直す）で確かめる。
//   1. 切り替え（shellHolderEnabled）と札の形（readShellCard）
//   2. 終わりを記録に書いている最中に A が手を離す: handOff は書き終える（子の記録を捨てる）まで待つ。B は付け直さない（終わりが 1 回）
//   3. A が終わりを書いて ack した後、子の記録を捨てる前に居なくなった: B は付け直すが、終わりを書き直さずに子の記録を捨てる
//   4. サーバーの終わり（stopAll）: 札を外して止める。次のサーバーは付け直さない
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { sleep } from '../lib/ws-client.mjs';
import { ensureHolder, connectHolder } from '../../core/holder/client.mjs';
import { holderLink } from '../../core/holder/link.mjs';
import { createShellHolder, shellHolderEnabled, readShellCard, shellCard } from '../../core/shell-held.mjs';
import { createShellRuns } from '../../core/shell-runs.mjs';

export const name = 'shell-held';
export const title = '`!` の行の保持役の部品: 切り替え・札・書いている最中の手離し・ack 済みの終わり・サーバーの終わりで札を外す';

const WAIT_MS = 20_000;
const backend = { id: 'fake', capabilities: { shell: 'host' } };
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };
async function until(check, ms, label) {
  const end = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timeout: ${label}`);
    await sleep(25);
  }
}

/** 会話の記録の身代わり。gate() の間は setSessionData を止める（終わりを書いている最中を作る） */
function memoryStore() {
  const data = {};
  let held = null;
  const store = {
    writes: 0,
    waiting: false,
    async get(id) { return data[id] ?? {}; },
    async setSessionData(id, key, value) {
      if (held) { store.waiting = true; await held.promise; store.waiting = false; }
      store.writes++;
      data[id] = { ...data[id], [key]: value };
    },
    gate() { let open; held = { promise: new Promise(resolve => { open = resolve; }) }; return () => { const h = held; held = null; open(); return h; }; },
    data,
  };
  return store;
}

export default async function (t) {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-shell-held-'));
  const dataDir = path.join(scratch, 'data');
  const root = path.join(scratch, 'runtime');
  let holderPid = null;
  const childPids = new Set();
  const saved = { root: process.env.AGENT_HOST_RUNTIME_ROOT, flag: process.env.AGENT_HOST_SHELL_HOLDER };
  // 保持役への共有の口をつなぎ直す（A が居なくなり、B がつなぐ）。welcome は最新の子の状態
  const reconnect = async () => {
    const client = await holderLink({ dataDir, root, launch: false });
    client.close();
    await until(() => !client.connected, WAIT_MS, '口が閉じる');
    return holderLink({ dataDir, root, launch: false });
  };
  const shellChildren = client => client.welcome.children.filter(c => c.id.startsWith('shell-'));
  try {
    // ---- 1. 切り替えと札
    {
      delete process.env.AGENT_HOST_RUNTIME_ROOT;
      delete process.env.AGENT_HOST_SHELL_HOLDER;
      const none = shellHolderEnabled();
      process.env.AGENT_HOST_RUNTIME_ROOT = root;
      const on = shellHolderEnabled();
      process.env.AGENT_HOST_SHELL_HOLDER = 'OFF';
      const off = shellHolderEnabled();
      t.ok('切り替え: 実行場所の置き場があれば既定で載せる・無ければ載せない・AGENT_HOST_SHELL_HOLDER=off は載せない', !none && on && !off);
      const card = shellCard({ sessionId: 's1', runId: 'run-0001', command: 'ls', cwd: '/x', at: '2026-10-07T00:00:00.000Z', backend: 'fake', skip: true, stdout: 'big' });
      assert.deepEqual(readShellCard(card), { sessionId: 's1', runId: 'run-0001', command: 'ls', cwd: '/x', at: '2026-10-07T00:00:00.000Z', backend: 'fake', skip: true });
      assert.equal(card.stdout, undefined, '札に出力は入れない');
      assert.equal(readShellCard({ ...card, v: 2 }), null);
      assert.equal(readShellCard({ ...card, kind: 'turn' }), null);
      assert.equal(readShellCard({ ...card, runId: '' }), null);
      t.ok('札: 行の形（出力は入れない）を戻せる。版・種類・欠けた札は読まない', true);
    }

    const found = await ensureHolder({ dataDir, root, mode: 'detached', idleMs: 20_000, timeoutMs: 20_000 });
    holderPid = found.pid;
    found.client.close();
    const holder = () => createShellHolder({ dataDir, root, enabled: () => true, log: () => {} });

    // ---- 2. 終わりを書いている最中に手を離す
    {
      const store = memoryStore();
      const events = [];
      const a = createShellRuns({ store, emit: e => events.push(e), holder: holder() });
      const open = store.gate();
      await a.start({ sessionId: 's2', runId: 'run-finishing-01', command: 'echo done-a; exit 7', cwd: scratch, backend });
      await until(() => store.waiting, WAIT_MS, '終わりを書き始める');
      assert.equal(a.list().length, 0, '終わった行は走っている一覧に無い');
      let handed = false;
      const handing = a.handOff().then(() => { handed = true; });
      await sleep(100);
      assert.equal(handed, false, '書き終えるまで手を離さない');
      open();
      await handing;
      assert.equal(events.filter(e => e.type === 'shell.done' && e.runId === 'run-finishing-01').length, 1);
      assert.equal(store.data.s2.shellPending.length, 1);
      assert.equal(store.data.s2.shellPending[0].exitCode, 7);
      const client = await reconnect();
      assert.equal(shellChildren(client).length, 0, '子の記録は捨ててある（B は付け直さない）');
      const b = createShellRuns({ store: memoryStore(), emit: () => {}, holder: holder() });
      assert.equal(b.adopt(await holder().adoptable()), 0);
      t.ok('終わりを書いている最中の手離し: handOff は書き終える（子の記録を捨てる）まで待ち、B は付け直さない（終わりは A の 1 回）', true);
    }

    // ---- 3. 終わりを書いて ack した後、子の記録を捨てる前に A が居なくなった
    {
      const storeA = memoryStore();
      const eventsA = [];
      const a = createShellRuns({ store: storeA, emit: e => eventsA.push(e), holder: holder() });
      const client = await holderLink({ dataDir, root, launch: false });
      const release = client.release;
      client.release = () => true;     // 捨てる依頼だけが届かない（A が落ちた）
      try {
        await a.start({ sessionId: 's3', runId: 'run-acked-00001', command: 'echo acked; exit 2', cwd: scratch, backend });
        await until(() => eventsA.some(e => e.type === 'shell.done'), WAIT_MS, 'A の終わり');
        await until(() => storeA.data.s3?.shellPending?.length === 1, WAIT_MS, 'A が書く');
      } finally { client.release = release; }
      const next = await reconnect();
      const left = shellChildren(next);
      assert.equal(left.length, 1, '子の記録が残っている');
      assert.ok(left[0].acked >= left[0].seq, `終わりの行まで ack 済み: ${left[0].acked}/${left[0].seq}`);
      const storeB = memoryStore();
      const eventsB = [];
      const b = createShellRuns({ store: storeB, emit: e => eventsB.push(e), holder: holder() });
      assert.equal(b.adopt(await holder().adoptable()), 1, 'B は札のある子を引き取る');
      await until(() => b.list().length === 0, WAIT_MS, 'B が締める');
      assert.equal(eventsB.filter(e => e.type === 'shell.done').length, 0, 'B は終わりを出さない');
      assert.equal(storeB.writes, 0, 'B は終わりを書かない');
      const after = await reconnect();
      assert.equal(shellChildren(after).length, 0, 'B が子の記録を捨てる');
      t.ok('ack 済みの終わり: A が書いて ack した終わりを、B は書き直さずに子の記録だけ捨てる', true);
    }

    // ---- 4. サーバーの終わり: 札を外して止める
    {
      const store = memoryStore();
      const events = [];
      const a = createShellRuns({ store, emit: e => events.push(e), holder: holder() });
      await a.start({ sessionId: 's4', runId: 'run-abandon-001', command: 'echo going; sleep 600', cwd: scratch, backend });
      await until(() => events.some(e => e.type === 'shell.output' && e.text.includes('going')), WAIT_MS, '出力');
      assert.equal(a.list()[0]?.held, true);
      a.stopAll();
      // プロセスの終わりの身代わり: このまま口を閉じる（A は続きを読まない）
      const client = await holderLink({ dataDir, root, launch: false });
      client.close();
      await until(() => !client.connected, WAIT_MS, '口が閉じる');
      const next = await until(async () => {
        const probe = await holderLink({ dataDir, root, launch: false });
        const child = shellChildren(probe).find(c => c.alive === false);
        if (child) return probe;
        probe.close();
        await until(() => !probe.connected, WAIT_MS, '口が閉じる');
        return null;
      }, WAIT_MS, '止めた子が終わる');
      const child = shellChildren(next)[0];
      assert.equal(child.label, null, '札を外してある');
      const b = createShellRuns({ store: memoryStore(), emit: () => {}, holder: holder() });
      assert.equal(b.adopt(await holder().adoptable()), 0, '次のサーバーは付け直さない');
      t.ok('サーバーの終わり（stopAll）: 保持役の子は札を外して止める（次のサーバーは引き取らない）', true);
    }
  } finally {
    if (saved.root === undefined) delete process.env.AGENT_HOST_RUNTIME_ROOT; else process.env.AGENT_HOST_RUNTIME_ROOT = saved.root;
    if (saved.flag === undefined) delete process.env.AGENT_HOST_SHELL_HOLDER; else process.env.AGENT_HOST_SHELL_HOLDER = saved.flag;
    const shared = await holderLink({ dataDir, root, launch: false }).catch(() => null);
    shared?.close();
    if (holderPid) {
      // 終わるのを待つのは、今の時点で保持役が生きていると言う子だけ（終わった子の pid は使い回されうる）
      const probe = await connectHolder({ dataDir, root }).catch(() => null);
      if (probe) for (const child of probe.welcome.children) if (child.pid && child.alive) childPids.add(child.pid);
      probe?.shutdown();
      probe?.close();
      await until(() => !alive(holderPid), 10_000, '保持役が終わる').catch(() => { try { process.kill(holderPid); } catch { /* 既に終わっている */ } });
      for (const pid of childPids) await until(() => !alive(pid), 10_000, `包み（${pid}）が終わる`).catch(() => { try { process.kill(pid); } catch { /* 既に終わっている */ } });
    }
    await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}
