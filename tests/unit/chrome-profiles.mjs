import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { parseProfiles, listBrowserProfiles } from '../../core/chrome/profiles.mjs';
import { createProfileChoice } from '../../core/chrome/profile-choice.mjs';
import { createChromeWindows } from '../../core/chrome/windows.mjs';
import { createChromeConnection } from '../../core/chrome/connection.mjs';
import { createChromeRelay } from '../../core/chrome/relay.mjs';
import { createBrowserBridge } from '../../core/browser-bridge.mjs';
import { createBrowserSiteApprovals } from '../../core/browser-confirm.mjs';
import { registry } from '../../core/ops/index.mjs';
import * as store from '../../core/store.mjs';
import { startFakeChrome } from '../lib/fake-chrome.mjs';
import { fakeChromeOs } from '../lib/fake-chrome-os.mjs';
import { startServer, ROOT } from '../lib/server.mjs';
import { open } from '../lib/ws-client.mjs';
import { readSessions } from '../lib/data-store.mjs';

export const name = 'chrome-profiles';
export const title = 'Chrome のプロフィール: 読み取り範囲・切り替えの拒否・保存・窓・許可の鍵・ops と MCP（偽物のみ）';
const personal = { browser: 'chrome', dir: 'Default', name: '個人' };
const work = { browser: 'chrome', dir: 'Profile 1', name: '仕事' };
const ref = p => ({ browser: p.browser, dir: p.dir });
const state = JSON.stringify({ profile: { last_used: 'Default', info_cache: {
  Default: { name: '個人', user_name: 'SECRET-MAIL', gaia_name: 'SECRET-ACCOUNT' },
  'Profile 1': { name: '仕事', avatar_icon: 'SECRET-ICON' },
} }, os_crypt: { encrypted_key: 'SECRET-KEY' } });

export default async function (t) {
  assert.deepEqual(parseProfiles(state), [{ dir: 'Default', name: '個人' }, { dir: 'Profile 1', name: '仕事' }]);
  assert.deepEqual(parseProfiles('{'), []);
  assert.deepEqual(parseProfiles(JSON.stringify({ profile: { info_cache: { '../bad': { name: 'bad' }, 'Profile 2': { name: ' X\u0000\u2028 ' }, 'Profile 10': { name: '' } } } })), [{ dir: 'Profile 2', name: 'X' }, { dir: 'Profile 10', name: 'Profile 10' }]);
  t.ok('Local State から名前とフォルダー名だけを返し、秘密の項目・壊れた値・パスを落とす', true);

  const meta = new Map([['s', {}], ['new', {}], ['real', {}]]), records = [], saves = [];
  let controlState = 'idle', waiting = false, operating = false;
  let rows = [personal, work];
  const prefs = { chromeNewProfile: ref(work), chromeProfileNotes: [{ ...ref(work), note: '社内サイト用' }] };
  const choice = createProfileChoice({ list: async () => rows, peek: id => meta.get(id),
    save: async (id, p) => { meta.get(id).chromeProfile = p; saves.push(id); }, getPrefs: async () => prefs,
    control: { state: () => ({ state: controlState }) }, handoffs: { current: () => waiting },
    operating: () => operating, record: async r => records.push(r) });
  await choice.startNew('new');
  assert.deepEqual(meta.get('new').chromeProfile, ref(work));
  await choice.startNew('temp');
  assert(!saves.includes('temp'));
  choice.rebind('temp', 'real');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(meta.get('real').chromeProfile, ref(work));
  assert.equal(choice.current('temp'), null);
  prefs.chromeNewProfile = { browser: 'chrome', dir: 'Missing' };
  await choice.startNew('missing');
  assert.equal(choice.current('missing'), null);
  assert.equal((await choice.list({ sessionId: 's' })).profiles[1].note, '社内サイト用');
  await choice.use({ sessionId: 's', profile: '仕事', by: 'agent' });
  assert.deepEqual(meta.get('s').chromeProfile, ref(work));
  assert.equal(records.length, 1);
  assert.equal((await choice.use({ sessionId: 's', profile: work.dir, by: 'agent' })).changed, false);
  assert.equal(records.length, 1);
  for (const reason of ['operating', 'waiting', 'human']) {
    operating = reason === 'operating'; waiting = reason === 'waiting'; controlState = reason === 'human' ? 'paused' : 'idle';
    for (const by of ['human', 'agent']) await assert.rejects(choice.use({ sessionId: 's', profile: 'Default', by }), e => e.code === 'BUSY' && e.detail.reason === reason);
  }
  operating = waiting = false; controlState = 'running';
  await assert.rejects(choice.use({ sessionId: 's', profile: 'Default' }), e => e.code === 'BUSY');
  await choice.use({ sessionId: 's', profile: 'Default', by: 'agent' });
  controlState = 'idle';
  await assert.rejects(choice.use({ sessionId: 's', profile: 'Missing' }), e => e.code === 'NOT_FOUND');
  rows = [personal, work, { ...work, dir: 'Profile 2' }];
  await assert.rejects(choice.use({ sessionId: 's', profile: '仕事' }), e => e.code === 'AMBIGUOUS');
  rows = [personal, work];
  const racing = createProfileChoice({ list: async () => { waiting = true; return rows; }, peek: () => ({}), save: async () => assert.fail('busy write'), getPrefs: async () => ({}), handoffs: { current: () => waiting } });
  await assert.rejects(racing.use({ sessionId: 's', profile: 'Default' }), e => e.code === 'BUSY');
  waiting = false;
  t.ok('既定・メモ・仮 id の移行・切り替えの記録と、操作中／待ち／引き継ぎ／読み取り中の競合を検証', true);

  const deps = { locale: 'ja', chromeProfiles: choice, chrome: { status: () => ({ state: 'off' }) }, modeOf: async () => ({ scope: 'readonly', autonomy: 'ask' }) };
  const agent = { by: 'agent', via: 'mcp', sessionId: 's' };
  assert.equal((await registry.invoke(agent, 'browser.useProfile', { profile: 'Profile 1' }, deps)).ok, true);
  assert.equal((await registry.invoke(agent, 'browser.useProfile', { sessionId: 'other', profile: 'Default' }, deps)).code, 'INVALID');
  assert.equal((await registry.invoke(agent, 'browser.useProfile', { profile: 'Missing' }, deps)).code, 'PROFILE_NOT_FOUND');
  const human = { by: 'human', via: 'ui', local: true };
  const settingsDeps = { locale: 'ja', prefs: async () => prefs, writes: { pref: async (key, value) => { prefs[key] = value; } } };
  const set = (key, value) => registry.invoke(human, 'settings.set', { key, value }, settingsDeps);
  assert.equal((await set('chromeNewProfile', ref(work))).ok, true);
  assert.equal((await set('chromeNewProfile', null)).ok, true);
  assert.equal((await set('chromeNewProfile', { browser: 'chrome', dir: '../bad' })).code, 'INVALID');
  assert.equal((await set('chromeProfileNotes', [{ ...ref(work), note: 'x'.repeat(201) }])).code, 'INVALID');
  assert.equal((await set('chromeProfileNotes', [{ ...ref(work), note: '社内サイト用' }])).ok, true);
  t.ok('ops は自分の会話だけを切り替え、読み取りモードでも通る。設定は値を検査する', true);

  const bridge = createBrowserBridge({ handoffs: {} });
  bridge.useProfiles({ list: id => choice.list({ sessionId: id, by: 'agent' }), use: (id, args) => choice.use({ sessionId: id, ...args, by: 'agent' }) });
  const rpcServer = http.createServer((req, res) => bridge.handle(req, res));
  await new Promise(resolve => rpcServer.listen(0, '127.0.0.1', resolve));
  try {
    const binding = bridge.open({ origin: `http://127.0.0.1:${rpcServer.address().port}`, owner: () => ({ sessionId: 's' }), locale: 'ja' });
    const rpc = async (method, params) => (await (await fetch(binding.url, { method: 'POST', headers: { ...binding.headers, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json()).result;
    const tools = (await rpc('tools/list')).tools.map(x => x.name);
    assert(tools.includes('list_browser_profiles') && tools.includes('use_browser_profile'));
    const listed = await rpc('tools/call', { name: 'list_browser_profiles' });
    assert.equal(JSON.parse(listed.content[0].text).profiles[1].note, '社内サイト用');
    assert.equal((await rpc('tools/call', { name: 'use_browser_profile', arguments: { profile: 'Default' } })).isError, false);
    waiting = true;
    assert.equal((await rpc('tools/call', { name: 'use_browser_profile', arguments: { profile: 'Profile 1' } })).isError, true);
    waiting = false;
    binding.close();
  } finally { rpcServer.close(); rpcServer.closeAllConnections(); }
  t.ok('ply_browser が一覧・切り替え・待ち中の拒否を返す', true);

  let asks = 0;
  const allowed = [];
  const authorize = createBrowserSiteApprovals({ getPrefs: async () => ({ confirmAgentSites: true, agentSitePermissions: allowed }), getAgent: async () => ({ id: 'fake', label: 'Fake' }), translate: () => 'site', askPermission: async () => { asks++; return { allow: true, always: true }; }, remember: async row => allowed.push(row) });
  for (const profile of ['chrome:Default', 'chrome:Default', 'chrome:Profile 1']) await authorize({ sessionId: 's', url: 'https://site.example/path', profile });
  assert.equal(asks, 2);
  assert.deepEqual(allowed.map(r => r.profile), ['chrome:Default', 'chrome:Profile 1']);
  allowed.push({ agent: 'fake', origin: 'https://old.example', mode: 'always' });
  await authorize({ sessionId: 's', url: 'https://old.example', profile: 'chrome:Profile 1' });
  assert.equal(asks, 2);
  const oldPrefs = await store.getPrefs();
  try {
    for (const row of allowed) await store.rememberBrowserSite(row);
    assert.equal((await store.getPrefs()).agentSitePermissions.filter(r => r.agent === 'fake').length, 3);
  } finally { await store.setPref('agentSitePermissions', oldPrefs.agentSitePermissions ?? []); }
  t.ok('サイト許可をプロフィール別に覚え、古いプロフィールなしの許可はどちらにも効く', true);

  const chrome = await startFakeChrome();
  await fs.writeFile(path.join(chrome.userDataDir, 'Local State'), state);
  const fakeOs = fakeChromeOs({ chrome });
  const locate = { browser: 'chrome', userDataDir: chrome.userDataDir, custom: true };
  const conn = createChromeConnection({ locate, os: fakeOs, pollMs: 10 });
  let selected = ref(personal);
  const scope = createChromeWindows({ os: fakeOs, locate, profileFor: () => selected, timing: { hwndWaitMs: 150, targetWaitMs: 300 } });
  const relay = createChromeRelay({ connection: conn, os: fakeOs, locate, scope });
  try {
    assert.deepEqual(await listBrowserProfiles({ homes: [locate, { browser: 'edge', userDataDir: chrome.userDataDir }], connected: b => b === 'chrome' }), [personal, work]);
    await relay.endpoint('s');
    const cdp = await conn.demand();
    const first = await scope.openTab({ cdp, entryId: 's' });
    selected = ref(work);
    const second = await scope.openTab({ cdp, entryId: 's' });
    assert.deepEqual(fakeOs.calls('launchWindow').map(c => c.args.profileDir), ['Default', 'Profile 1']);
    assert.equal(scope.profileOf('s', first), 'chrome:Default');
    assert.equal(scope.profileOf('s', second), 'chrome:Profile 1');
    assert.equal(scope.windows('s').length, 2);
    await scope.openTab({ cdp, entryId: 's' });
    assert.equal(fakeOs.calls('launchWindow').length, 2);
    chrome.browser.ignoreTargetContext(true);
    const fallback = await scope.openTab({ cdp, entryId: 's' });
    assert.equal(fakeOs.calls('launchWindow').length, 3);
    assert.equal(scope.profileOf('s', fallback), 'chrome:Profile 1');
    fakeOs.opts.launchFails = true;
    await assert.rejects(scope.openTab({ cdp, entryId: 's' }), /selected Chrome profile/);
    assert.equal(scope.windows('s').length, 4);
  } finally { relay.close(); await conn.close(); await chrome.stop(); }
  t.ok('次の窓だけ指定プロフィールで開き、CDP が別プロフィールに開いたら閉じて起動し直す。失敗時に別プロフィールで続けない', true);

  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-profile-server-'));
  const userData = path.join(scratch, 'chrome');
  await fs.mkdir(userData);
  await fs.writeFile(path.join(userData, 'Local State'), state);
  const dataDir = path.join(scratch, 'data');
  const server = await startServer({ dataDir, entry: path.join(ROOT, 'tests/lib/parent-port-server.mjs'), env: { AGENT_HOST_BACKENDS: 'fake', AGENT_HOST_CHROME_USER_DATA: userData } });
  let client;
  try {
    client = await open({ port: server.port, token: server.token, autoAllow: true });
    await client.cmd('setPref', { key: 'chromeNewProfile', value: ref(work) });
    await client.cmd('setPref', { key: 'chromeProfileNotes', value: [{ ...ref(work), note: '社内サイト用' }] });
    const direct = await client.runTurn({ backend: 'fake', cwd: scratch, prompt: 'hello' });
    assert.deepEqual(readSessions(dataDir)[direct.sessionId].chromeProfile, ref(work), 'id が後から決まる会話も永続化する');
    const { sessionId } = await client.cmd('newSession', { backend: 'fake', cwd: scratch });
    assert.deepEqual(readSessions(dataDir)[sessionId].chromeProfile, ref(work));
    const listed = await client.cmd('invoke', { op: 'browser.listProfiles', args: { sessionId } });
    assert.deepEqual(listed.current, ref(work));
    assert.equal(listed.profiles[1].note, '社内サイト用');
    const turn = await client.runTurn({ backend: 'fake', cwd: scratch, sessionId, prompt: 'browser:{"name":"use_browser_profile","arguments":{"profile":"Default"}}' });
    assert.equal(turn.events.find(e => e.type === 'tool.result')?.isError, false);
    assert.deepEqual(readSessions(dataDir)[sessionId].chromeProfile, ref(personal));
    assert(client.events.some(e => e.type === 'present' && e.kind === 'chromeProfile' && e.chromeProfile.dir === 'Default'));
    assert(!JSON.stringify(listed).includes('SECRET'));
  } finally { client?.close(); await server.stop(); await fs.rm(scratch, { recursive: true, force: true }); }
  t.ok('サーバー越しに新規会話の既定を保存し、ツールの切り替えと会話の記録を画面に配る', true);
}
