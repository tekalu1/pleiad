import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startServer, ROOT } from '../lib/server.mjs';
import { open, sleep } from '../lib/ws-client.mjs';
import { startFakeChrome } from '../lib/fake-chrome.mjs';
import { readSessions } from '../lib/data-store.mjs';

export const name = 'server-chrome-delegation';
export const title = '委譲の子の Chrome: プロフィール・親の操作待ち・窓一覧・親から閉じる（偽の Chrome と fake の子）';
const ply = (name, args) => `ply:${JSON.stringify({ name, arguments: args })}`;
const browser = (name, args) => `browser:${JSON.stringify({ name, arguments: args })}`;

export default async function (t) {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-chrome-delegation-'));
  const chrome = await startFakeChrome();
  await fs.writeFile(path.join(chrome.userDataDir, 'Local State'), JSON.stringify({ profile: { last_used: 'Default', info_cache: {
    Default: { name: '個人' }, 'Profile 1': { name: '仕事' },
  } } }));
  const dataDir = path.join(scratch, 'data');
  await fs.mkdir(dataDir);
  const server = await startServer({ env: { AGENT_HOST_BACKENDS: 'fake', AGENT_HOST_CHROME_USER_DATA: chrome.userDataDir,
    FAKE_PARENT_PORT_LOG: path.join(scratch, 'parent-port.ndjson') }, dataDir, entry: path.join(ROOT, 'tests/lib/parent-port-server.mjs') });
  const c = await open({ port: server.port, token: server.token });
  const wait = async check => {
    for (let i = 0; i < 300; i++) { const answer = await check(); if (answer) return answer; await sleep(50); }
    throw new Error('timed out waiting for delegated Chrome');
  };
  const run = async args => {
    for (let i = 0; i < 100; i++) {
      try { return await c.runTurn(args); }
      catch (error) { if (!String(error.message).includes('切り替え中') || i === 99) throw error; await sleep(50); }
    }
  };
  try {
    await c.cmd('chromeConnect');
    await wait(() => c.events.some(event => event.type === 'chromeBrowser' && event.state === 'connected'));
    await c.cmd('setPref', { key: 'chromeNewProfile', value: { browser: 'chrome', dir: 'Default' } });
    let parent = (await run({ backend: 'fake', cwd: ROOT, prompt: 'echo:parent' })).sessionId;
    await c.cmd('invoke', { op: 'browser.useProfile', args: { sessionId: parent, profile: 'Profile 1' } });
    for (const title of ['子 A', '子 B']) await run({ sessionId: parent,
      prompt: ply('ply_delegate', { kind: 'mechanical', backend: 'fake', task: `echo:${title}`, title }) });
    let tasks = await wait(async () => { const rows = await c.cmd('agentTasks'); const children = rows.filter(row => row.parentSessionId === parent); return children.length === 2 && children.every(row => row.sessionId) ? children : null; });
    const sessions = readSessions(dataDir);
    assert(tasks.every(row => sessions[row.sessionId]?.chromeProfile?.dir === 'Profile 1'), JSON.stringify(tasks.map(row => sessions[row.sessionId]?.chromeProfile)));
    t.ok('子は作成時の親のプロフィールを継ぐ', true);

    await c.cmd('setPref', { key: 'chromeNewProfile', value: null });
    parent = (await run({ backend: 'fake', cwd: ROOT, prompt: 'echo:browser parent' })).sessionId;
    for (const title of ['窓 A', '窓 B']) await run({ sessionId: parent,
      prompt: ply('ply_delegate', { kind: 'mechanical', backend: 'fake', task: `echo:${title}`, title }) });
    tasks = await wait(async () => { const rows = await c.cmd('agentTasks'); const children = rows.filter(row => row.parentSessionId === parent); return children.length === 2 && children.every(row => row.sessionId) ? children : null; });
    for (const row of tasks) await c.cmd('chromeOpen', { sessionId: row.sessionId, url: `https://site.example/${row.taskId}` });
    const listed = await c.cmd('invoke', { op: 'browser.chromeWindows', args: { sessionId: parent } });
    assert.deepEqual(listed.map(row => row.taskId).sort(), tasks.map(row => row.taskId).sort());
    assert(listed.every(row => row.windows === 1), JSON.stringify(listed));
    t.ok('窓一覧の op は開いている子だけを返す', true);

    await run({ sessionId: parent,
      prompt: ply('ply_task_send', { taskId: tasks[0].taskId, message: browser('hand_to_user', { reason: 'login', message: 'ログインしてください' }) }) });
    const pending = await wait(async () => {
      const rows = (await c.cmd('running')).permissions ?? [];
      const child = rows.filter(row => tasks.some(task => task.sessionId === row.sessionId) && !row.relay);
      const parentCards = rows.filter(row => row.sessionId === parent && row.relay);
      const parentCard = c.events.find(event => event.type === 'permission' && event.id === parentCards[0]?.id);
      return child.length === 1 && parentCards.length === 1 && parentCard?.browserHandoff ? { child, parentCard } : null;
    });
    assert.equal(pending.parentCard.targetSessionId, tasks[0].sessionId);
    const statusFrom = c.mark();
    await run({ sessionId: parent, prompt: ply('ply_task_status', { taskId: tasks[0].taskId }) });
    const statusEvent = await c.waitFor(event => event.type === 'tool.result' && event.sessionId === parent, { from: statusFrom, ms: 10000 });
    const status = JSON.parse(statusEvent.text);
    assert.equal(status.status, 'waiting');
    t.ok('子の操作待ちは親にも届き、親のカードは子の窓を対象にする', true);

    await c.cmd('chromeTakeOver', { sessionId: tasks[0].sessionId, by: 'device', width: 390, height: 700, scale: 2 });
    await c.cmd('chromeResume', { sessionId: tasks[0].sessionId });
    await wait(async () => (await c.cmd('running')).permissions?.every(row => row.sessionId !== tasks[0].sessionId));
    assert(c.events.some(event => event.type === 'permissionSettled' && event.sessionId === tasks[0].sessionId && event.allow));
    assert(c.events.some(event => event.type === 'permissionSettled' && event.sessionId === parent && event.allow));
    t.ok('親から子の窓を戻すと、親と子のカードが同時に済む', true);

    const closed = await run({ sessionId: parent, prompt: browser('close_browser_window', { task: tasks[0].taskId }) });
    assert(closed.events.some(event => event.type === 'tool.result' && event.isError === false));
    const remaining = await c.cmd('invoke', { op: 'browser.chromeWindows', args: { sessionId: parent } });
    assert.deepEqual(remaining.map(row => row.taskId), [tasks[1].taskId]);
    const outsider = (await run({ backend: 'fake', cwd: ROOT, prompt: browser('close_browser_window', { task: tasks[1].taskId }) })).events;
    assert(outsider.some(event => event.type === 'tool.result' && event.isError));
    t.ok('親の close_browser_window({ task }) は自分の子だけ閉じ、別の会話からは断る', true);
  } finally {
    c.close(); await server.stop(); await chrome.stop(); await fs.rm(scratch, { recursive: true, force: true });
  }
}
