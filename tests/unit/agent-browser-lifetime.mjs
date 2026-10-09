import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { browserConfigFile, browserEnvironment, browserSocketDirectory, BROWSER_IDLE_TIMEOUT_MS, discardBrowserEnvironment, forgetBrowserEnvironment,
  settleBrowserEnvironment, stopBrowserDaemon, sweepBrowserEnvironments } from '../../core/agent-browser.mjs';
import { createAgentTasks } from '../../core/agent-tasks.mjs';

export const name = 'agent-browser-lifetime';
export const title = 'エージェントのブラウザーのデーモンと置き場の寿命（止める・消す・掃除。ADR 0180）';

const sessionName = dir => `ply-${crypto.createHash('sha256').update(path.resolve(dir)).digest('hex').slice(0, 24)}`;
const exists = file => fs.stat(file).then(() => true, () => false);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export default async function (t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pleiad-ab-life-'));
  const socketRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'pleiad-ab-sock-'));
  const socketDirs = new Set();
  // 偽のプロセス表。本物のプロセスは落とさない（kill も偽物）
  const table = new Map();
  const killed = [];
  const fakes = { processes: async () => new Map(table), kill: pid => { killed.push(pid); table.delete(pid); }, isAlive: pid => table.has(pid), waitMs: 300 };
  const bridge = { pinTab: true, endpoint: async () => 'ws://127.0.0.1:1/devtools/browser/key', configSessionId: id => id };
  // デーモンが起きた形を作る（<セッション名>.pid などをソケットの置き場に書く）
  let nextPid = 900001;
  const daemon = async (id, { name = 'agent-browser.exe', running = true } = {}) => {
    const dir = path.dirname(browserConfigFile(dataDir, id));
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'agent-browser.json'), '{}');
    const socketDir = browserSocketDirectory(dir);
    socketDirs.add(socketDir);
    await fs.mkdir(socketDir, { recursive: true });
    const pid = nextPid++;
    for (const ext of ['pid', 'port', 'target']) await fs.writeFile(path.join(socketDir, `${sessionName(dir)}.${ext}`), ext === 'pid' ? `${pid}\n` : '1');
    if (running) table.set(pid, name);
    return { dir, socketDir, pid };
  };
  try {
    // ---- 環境変数: 暇なデーモンを 24 時間で落とす（明示すると --cdp のデーモンにも効く）
    const env = await browserEnvironment({ bridge, dataDir, sessionId: 'env-1' });
    socketDirs.add(env.AGENT_BROWSER_SOCKET_DIR);
    t.ok('AGENT_BROWSER_IDLE_TIMEOUT_MS に 24 時間を渡す', env.AGENT_BROWSER_IDLE_TIMEOUT_MS === String(24 * 60 * 60 * 1000) && BROWSER_IDLE_TIMEOUT_MS === 86_400_000);
    t.ok('Windows ではソケットの置き場を前もって作らない（デーモンが作る）', process.platform !== 'win32' || !(await exists(env.AGENT_BROWSER_SOCKET_DIR)));
    t.ok('設定ファイルはターンの初めに書く（エージェントが最初の agent-browser より前に読む）', await exists(env.AGENT_BROWSER_CONFIG));

    // ---- ターンの終わり: 使わなかったら設定の置き場を消す。使ったら残す
    t.ok('agent-browser を呼ばなかったターンは、終わりに設定の置き場を消す', await settleBrowserEnvironment({ bridge, dataDir, sessionId: 'env-1' }) === true
      && !(await exists(path.dirname(env.AGENT_BROWSER_CONFIG))) && !(await exists(env.AGENT_BROWSER_SOCKET_DIR)));
    const used = await daemon('used-1');
    t.ok('デーモンが起きた会話は、ターンの終わりに消さない（縛りの記録を次のターンへ残す）', await settleBrowserEnvironment({ bridge, dataDir, sessionId: 'used-1' }) === false
      && await exists(used.dir) && await exists(path.join(used.socketDir, `${sessionName(used.dir)}.target`)));
    const again = await browserEnvironment({ bridge, dataDir, sessionId: 'env-2' });
    socketDirs.add(again.AGENT_BROWSER_SOCKET_DIR);
    t.ok('次のターンが始まっていたら（busy）消さない', await settleBrowserEnvironment({ bridge, dataDir, sessionId: 'env-2', busy: () => true }) === false && await exists(again.AGENT_BROWSER_CONFIG));
    // 待たずに走らせた片付けの直後に次のターンが置き場を書いても、書いた設定が消えない（順番待ち）
    const settling = settleBrowserEnvironment({ bridge, dataDir, sessionId: 'env-2' });
    const next = await browserEnvironment({ bridge, dataDir, sessionId: 'env-2' });
    t.ok('片付けの途中に始まった次のターンの設定は消えない', await settling === true && await exists(next.AGENT_BROWSER_CONFIG));

    // ---- 止める: 確かめた pid だけを落とす
    t.ok('pid の記録が無ければ何もしない', await stopBrowserDaemon(path.dirname(again.AGENT_BROWSER_CONFIG), fakes) === 'none' && killed.length === 0);
    const reused = await daemon('reused-1', { name: 'node.exe' });
    t.ok('pid が別のプロセスに使い回されていたら落とさない', await stopBrowserDaemon(reused.dir, fakes) === 'gone' && !killed.includes(reused.pid));
    const dead = await daemon('dead-1', { running: false });
    t.ok('もう居ないデーモンは落とさない', await stopBrowserDaemon(dead.dir, fakes) === 'gone' && !killed.includes(dead.pid));
    const live = await daemon('live-1', { name: 'agent-browser-win32-x64.exe' });
    t.ok('agent-browser のデーモンは落とす（npm の実行ファイル名も）', await stopBrowserDaemon(live.dir, fakes) === 'stopped' && killed.includes(live.pid));
    const linux = await daemon('linux-1', { name: 'agent-browser-l' });
    t.ok('Linux の ps の切れた名前（15 文字）も agent-browser と見る', await stopBrowserDaemon(linux.dir, fakes) === 'stopped' && killed.includes(linux.pid));

    // ---- 子が終わった・会話を消した: 止めてから両方の置き場を消す
    const child = await daemon('child-1');
    t.ok('止めてから、ソケットの置き場と設定の置き場を消す', await discardBrowserEnvironment({ bridge, dataDir, sessionId: 'child-1', ...fakes }) === true
      && killed.includes(child.pid) && !(await exists(child.socketDir)) && !(await exists(child.dir)));
    const stubborn = await daemon('stubborn-1');
    const unkillable = { ...fakes, kill: pid => killed.push(pid) };   // 落ちない
    t.ok('落ちなければ pid の記録を消さない（次の掃除でやり直す）', await discardBrowserEnvironment({ bridge, dataDir, sessionId: 'stubborn-1', ...unkillable }) === false
      && await exists(path.join(stubborn.socketDir, `${sessionName(stubborn.dir)}.pid`)) && await exists(stubborn.dir));
    const blind = await daemon('blind-1');
    t.ok('プロセスの一覧が引けず生きているなら、落とさず消さない', await discardBrowserEnvironment({ bridge, dataDir, sessionId: 'blind-1', ...fakes, processes: async () => null }) === false
      && !killed.includes(blind.pid) && await exists(blind.socketDir));
    const forgotten = [];
    const deleted = await daemon('deleted-1');
    await forgetBrowserEnvironment({ bridge: { ...bridge, forget: id => forgotten.push(id) }, dataDir, sessionId: 'deleted-1', ...fakes });
    t.ok('会話を消すと、デーモンを止めて置き場を消し、id の組も忘れる', killed.includes(deleted.pid) && !(await exists(deleted.dir)) && forgotten.join() === 'deleted-1');
    // ID 確定前の id の置き場（configSessionId）と、今の id の置き場の両方
    const early = await daemon('temp-key-1');
    const late = await daemon('native-1');
    await discardBrowserEnvironment({ bridge: { ...bridge, configSessionId: id => id === 'native-1' ? 'temp-key-1' : id }, dataDir, sessionId: 'native-1', ...fakes });
    t.ok('ID 確定前の id の置き場と今の id の置き場の両方を片付ける', killed.includes(early.pid) && killed.includes(late.pid) && !(await exists(early.dir)) && !(await exists(late.dir)));

    // ---- 掃除
    for (const pid of [...table.keys()]) table.delete(pid);
    killed.length = 0;
    await fs.rm(path.join(dataDir, 'agent-browser'), { recursive: true, force: true });
    const orphan = await daemon('gone-conversation');
    const finished = await daemon('finished-child');
    const running = await daemon('running-child');
    const parent = await daemon('parent-1');
    const bound = await daemon('temp-key-2');
    const unusedOld = path.dirname(browserConfigFile(dataDir, 'parent-2'));
    await fs.mkdir(unusedOld, { recursive: true });
    await fs.writeFile(path.join(unusedOld, 'agent-browser.json'), '{}');
    const old = new Date(Date.now() - 2 * 60 * 60_000);
    await fs.utimes(path.join(unusedOld, 'agent-browser.json'), old, old);
    const unusedNew = path.dirname(browserConfigFile(dataDir, 'parent-3'));
    await fs.mkdir(unusedNew, { recursive: true });
    await fs.writeFile(path.join(unusedNew, 'agent-browser.json'), '{}');
    // この Pleiad の置き場に当たらないソケットの置き場（socketRoot の中だけ。本物の一時領域は試験では触らない）
    const foreignName = process.platform === 'win32' ? hash => `ply-ab-${hash}` : hash => hash;
    const emptyOld = path.join(socketRoot, foreignName('a'.repeat(24))), emptyNew = path.join(socketRoot, foreignName('b'.repeat(24))), busyForeign = path.join(socketRoot, foreignName('c'.repeat(24)));
    for (const d of [emptyOld, emptyNew, busyForeign]) await fs.mkdir(d);
    await fs.writeFile(path.join(busyForeign, 'ply-x.pid'), '1');
    await fs.utimes(emptyOld, old, old); await fs.utimes(busyForeign, old, old);
    let listed = 0;
    const result = await sweepBrowserEnvironments({
      bridge: { ...bridge, bindings: () => [['native-2', 'temp-key-2']] }, dataDir, socketRoot,
      sessions: ['finished-child', 'running-child', 'parent-1', 'native-2', 'parent-2', 'parent-3'],
      finished: id => id === 'finished-child' || id === 'running-child', busy: id => id === 'running-child',
      ...fakes, processes: async () => { listed++; return new Map(table); },
    });
    t.ok('持ち主の会話が無い置き場は、デーモンを止めて消す', killed.includes(orphan.pid) && !(await exists(orphan.dir)) && !(await exists(orphan.socketDir)));
    t.ok('終わった委譲の子の置き場は、デーモンを止めて消す', killed.includes(finished.pid) && !(await exists(finished.dir)));
    t.ok('走っている会話（busy）は終わった子でも触らない', !killed.includes(running.pid) && await exists(running.dir));
    t.ok('依頼元の会話のデーモンは止めない（ID 確定前の id の置き場も持ち主を引く）', !killed.includes(parent.pid) && !killed.includes(bound.pid) && await exists(parent.dir) && await exists(bound.dir));
    t.ok('デーモンが一度も起きていない古い置き場は消し、新しいものは残す', !(await exists(unusedOld)) && await exists(unusedNew));
    t.ok('当たらないソケットの置き場は、空で古いものだけ消す', !(await exists(emptyOld)) && await exists(emptyNew) && await exists(path.join(busyForeign, 'ply-x.pid')));
    t.ok('掃除の数を返し、プロセスの一覧は 1 回だけ引く', result.stopped === 2 && result.removed === 2 && result.unused === 1 && result.empty === 1 && listed === 1, JSON.stringify({ result, listed }));

    // ---- 委譲の子が止まったら ended を呼ぶ（依頼元の会話には呼ばない）
    const tasksDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pleiad-ab-tasks-'));
    const ended = [];
    let seq = 0;
    const manager = await createAgentTasks({
      dataDir: tasksDir, log: () => {}, silenceMinutes: 0, commandMinutes: 0,
      prepare: async (_owner, a) => ({ sessionId: `child-session-${++seq}`, backend: a.backend }),
      execute: async (_task, prompt) => ({ outcome: prompt === 'fail' ? 'error' : 'ok', text: prompt }),
      deliver: async () => 'ok', ended: sessionId => ended.push(sessionId),
    });
    try {
      const ok = await manager.call('owner-1', 'ply_delegate', { backend: 'fake', task: 'done' });
      const ng = await manager.call('owner-1', 'ply_delegate', { backend: 'fake', task: 'fail' });
      for (let i = 0; i < 200 && ended.length < 2; i++) await sleep(20);
      t.ok('子が完了・失敗で止まったら、子の会話の id で ended を呼ぶ', ended.includes(manager.get(ok.taskId).sessionId) && ended.includes(manager.get(ng.taskId).sessionId) && !ended.includes('owner-1'), JSON.stringify(ended));
      t.ok('止まった子の会話の id を返す（掃除の finished）', manager.finishedSessions().has(manager.get(ok.taskId).sessionId));
    } finally {
      await manager.close?.();
      await fs.rm(tasksDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  } finally {
    for (const socketDir of socketDirs) await fs.rm(socketDir, { recursive: true, force: true });
    await fs.rm(dataDir, { recursive: true, force: true });
    await fs.rm(socketRoot, { recursive: true, force: true });
  }
}
