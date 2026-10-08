// macOS の境界を偽のヘルパーで確かめる。画面収録・OS の入力・TCC の変更はしない。
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { toPhysical, regionToPhysical } from '../../core/computer-use/coords.mjs';
import { computerUseCapability } from '../../core/computer-use-capability.mjs';
import { isForbiddenApp, isHighRiskApp } from '../../core/computer-use/apps.mjs';
import { parentPortComputer } from '../../core/computer-use/driver.mjs';
import { createHarness } from '../lib/computer-harness.mjs';

const require = createRequire(import.meta.url);
const { createHelperClient, parseLine, createLineReader } = require('../../desktop/computer/mac-helper.cjs');
const { loadMac, planCapture, listMacDisplays, createMacCapture, withPermissionPrompt } = require('../../desktop/computer/mac.cjs');
const { createMacInput } = require('../../desktop/computer/mac-input.cjs');
const { createMacApps } = require('../../desktop/computer/mac-apps.cjs');
const { parseCombo, KVK } = require('../../desktop/computer/mac-keymap.cjs');
const { ComputerError } = require('../../desktop/computer/errors.cjs');
const { createComputerService } = require('../../desktop/computer/service.cjs');
export const name = 'computer-mac';
export const title = 'macOS: JSON 行・TCC・Retina・アプリ・入力の中断・platform の分岐';
const tick = () => new Promise(resolve => setImmediate(resolve));
const code = wanted => error => error instanceof ComputerError && error.code === wanted;

function fakeChild({ hello = { event: 'hello', protocol: 1 }, respond = request => ({ id: request.id, ok: true, data: request.args }) } = {}) {
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
  child.requests = [];
  child.stdin.on('data', createLineReader(line => {
    const request = JSON.parse(line); child.requests.push(request);
    const answer = respond(request);
    if (answer) queueMicrotask(() => child.stdout.write(JSON.stringify(answer) + '\n'));
  }));
  child.kill = () => child.emit('exit', 0);
  child.stdin.on('finish', () => child.emit('exit', 0));
  if (hello) queueMicrotask(() => child.stdout.write(JSON.stringify(hello) + '\n'));
  return child;
}

const screen = {
  getPrimaryDisplay: () => ({ id: 1 }),
  getAllDisplays: () => [
    { id: 2, bounds: { x: -1920, y: -100, width: 1920, height: 1080 }, scaleFactor: 1 },
    { id: 1, bounds: { x: 0, y: 0, width: 1440, height: 900 }, scaleFactor: 2 },
  ],
  getCursorScreenPoint: () => ({ x: -100, y: 50 }),
};

export default async function(t) {
  {
    const lines = [], read = createLineReader(line => lines.push(JSON.parse(line)));
    const bytes = Buffer.from('{"name":"日本語😀"}\r\n\n{"id":2}\n');
    for (const byte of bytes) read(Buffer.from([byte]));
    assert.deepEqual(lines, [{ name: '日本語😀' }, { id: 2 }]);
    assert.equal(parseLine('invalid'), null);
    const error = parseLine('{"id":1,"ok":false,"error":{"code":"permission","permission":"screen"}}').error;
    assert.ok(code('permission')(error)); assert.equal(error.permission, 'screen');
    assert.equal(parseLine('{"id":2,"ok":false,"error":{"code":"unknown"}}').error.code, 'failed');
    t.ok('分割された UTF-8・CRLF・不正な JSON・許可のエラーを扱う', true);
  }
  {
    let child;
    const client = createHelperClient({ command: 'fake', spawn: () => (child = fakeChild()) });
    assert.deepEqual(await client.call('echo', { text: '日本語' }), { text: '日本語' });
    assert.equal(child.requests[0].id, 1);
    child.emit('exit', 2);
    assert.deepEqual(await client.call('echo', { x: 2 }), { x: 2 });
    client.stop();
    for (const hello of [{ event: 'hello', protocol: 99 }, { event: 'hello', protocol: 1, supported: false }]) {
      const bad = createHelperClient({ command: 'fake', spawn: () => fakeChild({ hello }) });
      await assert.rejects(bad.call('ping'), code('unsupported')); bad.stop();
    }
    const slow = createHelperClient({ command: 'fake', spawn: () => fakeChild({ respond: () => null }), timeouts: { request: 20 } });
    await assert.rejects(slow.call('ping'), code('timeout')); assert.equal(slow.running, false);
    const starting = createHelperClient({ command: 'fake', spawn: () => fakeChild({ hello: null }) });
    const pending = starting.call('ping'); starting.stop();
    await assert.rejects(pending, code('failed'));
    const ac = new AbortController();
    const cancelled = createHelperClient({ command: 'fake', spawn: () => (child = fakeChild()) });
    const input = cancelled.call('key', {}, { signal: ac.signal }); ac.abort();
    await assert.rejects(input, code('stopped')); assert.equal(child.requests.length, 0); cancelled.stop();
    t.ok('hello の版・再起動・タイムアウト・起動待ちの停止と入力中断', true);
  }
  {
    const displays = listMacDisplays(screen);
    assert.deepEqual(displays.map(d => d.id), ['1', '2']);
    const retina = planCapture({ region: { x: 100, y: 200, width: 200, height: 100 } }, displays[0]);
    assert.equal(retina.width, 400); assert.equal(retina.scale, 2);
    const shot = { ...retina, origin: { x: 100, y: 200 } };
    assert.deepEqual(toPhysical(shot, 100, 60), { x: 150, y: 230 });
    assert.deepEqual(regionToPhysical(shot, [0, 0, 100, 60]), { x: 100, y: 200, width: 50, height: 30 });
    const left = planCapture({ region: { x: -100, y: -50, width: 200, height: 100 } }, displays[1]);
    assert.equal(left.wanted.width, 100); assert.equal(left.wanted.x, -100);
    assert.throws(() => planCapture({ region: { x: 0, y: 0, width: 10, height: 10 } }, displays[1]), code('outside'));
    const capture = createMacCapture({ helper: { call: async (op, args) => ({ gray: Buffer.alloc(args.width * args.height).toString('base64'), width: args.width, height: args.height }) } });
    const image = await capture.screenshot({ display: '1', gray: true, maxEdge: 30 }, { displays, displaysVersion: 3 });
    assert.equal(image.gray.length, image.width * image.height); assert.equal(image.displaysVersion, 3);
    t.ok('Retina・負の座標・倍率が違うディスプレイ・zoom・灰色画像の契約', true);
  }
  {
    let requests = 0, stops = 0, opened = 0, now = 100;
    const helper = withPermissionPrompt({ stop: () => stops++, call: async op => {
      if (op === 'request') { requests++; return {}; }
      throw new ComputerError('permission', 'denied', { permission: 'accessibility' });
    } }, { openExternal: async url => { assert.ok(url.endsWith('Privacy_Accessibility')); opened++; }, now: () => now });
    await assert.rejects(helper.call('mouse'), code('permission'));
    await assert.rejects(helper.call('mouse'), code('permission'));
    assert.equal(stops, 1); assert.equal(requests, 1); assert.equal(opened, 1);
    now += 60_000; await assert.rejects(helper.call('mouse'), code('permission')); assert.equal(opened, 2);
    const waitingForUser = withPermissionPrompt({ stop() {}, call: async op => {
      if (op === 'request') return new Promise(() => {});
      throw new ComputerError('permission', 'denied', { permission: 'screen' });
    } }, { openExternal: async () => {} });
    await assert.rejects(waitingForUser.call('capture'), code('permission'));
    t.ok('TCC の案内は 60 秒に 1 回、再試行ではヘルパーを起こし直す', true);
  }
  {
    assert.throws(() => loadMac({ platform: 'linux' }), e => e.reason === 'platform');
    assert.throws(() => loadMac({ platform: 'darwin', osRelease: '22.6.0', screen }), e => e.reason === 'platform');
    assert.throws(() => loadMac({ platform: 'darwin', osRelease: '23.0.0', screen, exists: () => false }), e => e.reason === 'native');
    const backend = loadMac({ platform: 'darwin', osRelease: '23.0.0', screen, helperPath: '/fake/helper', spawn: () => fakeChild() });
    const service = createComputerService({ backend, post: () => {} });
    assert.equal(service.supported, true); service.dispose();
    assert.equal(computerUseCapability({ hasParentPort: true, platform: 'darwin' }).supported, true);
    assert.equal(computerUseCapability({ hasParentPort: true, platform: 'darwin', ready: { supported: false, reason: 'platform' } }).supported, false);
    assert.equal(computerUseCapability({ hasParentPort: true, platform: 'linux' }).reason, 'platform');
    let serviceRef;
    const port = new EventEmitter();
    port.postMessage = message => serviceRef.handleMessage(message);
    serviceRef = createComputerService({ backend: { ...backend, desktop: { check: async () => { throw new ComputerError('permission', 'denied', { permission: 'screen' }); } } }, post: message => port.emit('message', message) });
    const driver = parentPortComputer(port);
    await assert.rejects(driver.call('owner', 'screenshot', {}), e => e.code === 'permission' && e.permission === 'screen');
    serviceRef.dispose();
    t.ok('OS・古い macOS・ヘルパー不在の分岐と、main から core への permission の伝達', true);
  }
  {
    const apps = createMacApps({ helper: {}, selfPid: 99, selfExe: '/Applications/Pleiad.app/Contents/MacOS/Pleiad' });
    const info = apps.toAppInfo({ pid: 5, bundleId: 'com.apple.TextEdit', bundlePath: '/System/Applications/TextEdit.app', name: 'テキストエディット' });
    assert.equal(info.id, 'bundle:com.apple.TextEdit'); assert.equal(info.self, false);
    assert.equal(apps.toAppInfo({ pid: 99, executable: '/dev/Electron' }).self, true);
    assert.equal(apps.toAppInfo({ bundleId: 'jp.ply.desktop.helper', executable: '/helper' }).self, true);
    for (const bundle of ['com.apple.Terminal', 'com.apple.keychainaccess', 'com.apple.shortcuts', 'com.openai.chat']) assert.equal(isForbiddenApp({ id: `bundle:${bundle}` }), true);
    assert.equal(isHighRiskApp({ id: 'bundle:com.apple.finder' }), true);
    t.ok('bundle の識別・Pleiad 自身・禁止と高リスクのアプリ', true);
  }
  {
    for (const combo of ['cmd+space', 'alt+cmd+Escape', 'ctrl+cmd+q', 'shift+cmd+q', 'cmd+space+a', 'space+cmd']) assert.throws(() => parseCombo(combo), code('system_key'));
    const calls = [];
    const helper = { call: async (op, args) => { calls.push({ op, ...args }); return op === 'keys' ? { keys: args.chars.map(() => ({ code: 0, shift: false })) } : {}; } };
    const input = createMacInput({ helper, sleep: async () => {} });
    await input.perform({ type: 'key', combo: 'cmd+a' });
    assert.deepEqual(calls.filter(c => c.op === 'key').map(c => [c.code, c.down]), [[KVK.COMMAND, true], [0, true], [0, false], [KVK.COMMAND, false]]);
    await input.perform({ type: 'keyDown', combo: 'cmd' });
    await assert.rejects(input.perform({ type: 'key', combo: 'space' }), code('system_key'));
    input.releaseAll();
    let resume;
    const stalled = createMacInput({ helper, sleep: () => new Promise(resolve => { resume = resolve; }) });
    const action = stalled.perform({ type: 'down', x: 1, y: 1 });
    await tick(); stalled.releaseAll(); const before = calls.length; resume();
    await assert.rejects(action, code('stopped')); assert.equal(calls.length, before);
    assert.deepEqual(stalled.pressed(), { keys: [], buttons: [] });
    t.ok('⌘・OS のキーの拒否・押したままの修飾キー・移動待ち中の Esc で入力を再開しない', true);
  }
  {
    const h = await createHarness({ platform: 'darwin' });
    try {
      const c = h.connect();
      assert.ok(c.binding.instructions.includes('Mac'));
      await c.call('screenshot', { title: '画面を見る' });
      const result = await c.call('key', { text: 'cmd+s', title: '保存' });
      assert.notEqual(result.isError, true);
      assert.ok(h.inputs().some(a => a.combo === 'cmd+s'));
    } finally { await h.close(); }
    t.ok('macOS の MCP 指示と cmd の入力が core を通る', true);
  }
  {
    let resume, sent = 0;
    const replies = [];
    const service = createComputerService({ post: reply => replies.push(reply), backend: {
      platform: 'darwin', listDisplays: () => listMacDisplays(screen), cursor: () => ({ x: 0, y: 0 }),
      desktop: { check: async () => ({ locked: false }) },
      apps: { inspectForeground: () => new Promise(resolve => { resume = resolve; }) },
      input: { validate() {}, releaseAll: () => [], perform: async (action, signal) => { if (signal.aborted) throw new ComputerError('stopped'); sent++; } },
    } });
    service.handleMessage({ type: 'computer-arm', owner: 'o1' });
    service.handleMessage({ type: 'computer-call', id: 1, owner: 'o1', op: 'input', args: { actions: [{ type: 'key', combo: 'cmd+s' }] } });
    await tick();
    service.handleMessage({ type: 'computer-turn-ended', owner: 'o1' });
    resume(null); await tick();
    assert.equal(sent, 0); assert.equal(replies.find(r => r.id === 1)?.error.code, 'stopped');
    service.dispose();
    t.ok('アプリの特定を待つ間にターンが終わっても、後から入力を始めない', true);
  }
}
