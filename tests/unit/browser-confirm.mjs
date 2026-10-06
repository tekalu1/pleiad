import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { N } from '../lib/dom-stub.mjs';
import { previewCsp, previewPolicy, validBrowserPref, blockedOrigin, externalOrigin } from '../../web/browser-confirm-policy.mjs';
import { VISUALIZE_CSP, visualizationDocument } from '../../web/visualize-document.mjs';
import { snapshotResponse, writeSnapshotFile } from '../../core/visualize.mjs';
import { createBrowserSiteApprovals } from '../../core/browser-confirm.mjs';
import { configurePreviewConfirmation, confirmedPreview, receivePreviewViolation, refreshPreviewConfirmation, blockedPreviewOrigins, noteBlockedOrigins } from '../../web/preview-confirm.mjs';
import { setupBrowserSettings } from '../../web/browser-settings.mjs';
const { createBrowserNavigation } = createRequire(import.meta.url)('../../desktop/browser-navigation.cjs');
export const name = 'browser-confirm';
export const title = 'Preview CSP, per-display grants, site approval and navigation';
const tick = () => new Promise(resolve => setImmediate(resolve));

export default async function(t) {
  assert.equal(previewCsp(), VISUALIZE_CSP);
  assert.match(previewCsp(), /connect-src https:/);
  const prefs = { confirmExternalLoads: true, externalSitePermissions: [{ origin: 'https://cdn.example', mode: 'always' }, { origin: 'https://ask.example', mode: 'ask' }] };
  const csp = previewCsp(previewPolicy(prefs));
  assert.match(csp, /connect-src https:\/\/cdn.example;/); assert(!csp.includes('ask.example'));
  assert(!previewCsp({ confirm: true, origins: ['https://ok.example/evil; *', 'http://bad.example', 'https://user:pass@bad.example'] }).includes('bad.example'));
  assert(!validBrowserPref('externalSitePermissions', [{ origin: 'https://ok.example/; *', mode: 'always' }]));
  assert(!validBrowserPref('confirmAgentSites', 'true'));
  const record = { content: '<img src="https://ask.example/a.png">', caption: 'Demo' };
  assert(snapshotResponse(record, prefs).headers['content-security-policy'].includes(csp));
  assert(snapshotResponse(record, prefs).body.includes(csp));
  assert(visualizationDocument(record.content, { policy: previewPolicy(prefs) }).indexOf('securitypolicyviolation') < visualizationDocument(record.content).indexOf('<img'));
  const dir = await mkdtemp(path.join(os.tmpdir(), 'preview-confirm-'));
  try { assert((await readFile(await writeSnapshotFile(record, dir, { prefs }), 'utf8')).includes(csp)); } finally { await rm(dir, { recursive: true, force: true }); }
  t.ok('OFF preserves HTTPS; ON limits every snapshot and frame to exact allowed origins', true);

  let currentPrefs = { confirmExternalLoads: true }, opened = 0;
  configurePreviewConfirmation({ getPrefs: () => currentPrefs, openSettings: () => opened++ });
  const host = new N('div'), frames = [new N('iframe'), new N('iframe')];
  for (const frame of frames) {
    frame.contentWindow = {}; frame.after = bar => host.append(bar);
    confirmedPreview(frame, policy => visualizationDocument(record.content, { policy })); host.append(frame);
  }
  const originalQuery = document.querySelectorAll;
  document.querySelectorAll = () => frames;
  try {
    const data = { type: 'ply-preview-blocked', url: 'https://assets.example/chart.svg' };
    assert.equal(receivePreviewViolation({ source: {}, data }), false);
    assert.equal(receivePreviewViolation({ source: frames[0].contentWindow, data }), true);
    receivePreviewViolation({ source: frames[0].contentWindow, data });
    const bar = host.querySelector('.preview-blocked'); assert(bar.textContent.includes('1'));
    bar.children[2].onclick(); assert.equal(opened, 1);
    bar.children[1].onclick(); assert(frames[0].srcdoc.includes('connect-src https://assets.example;')); assert(!frames[1].srcdoc.includes('connect-src https://assets.example;'));
    currentPrefs = { ...currentPrefs, externalSitePermissions: [{ origin: 'https://persist.example', mode: 'always' }] };
    refreshPreviewConfirmation(); assert(frames.every(frame => frame.srcdoc.includes('https://persist.example')));
    assert(frames[0].srcdoc.includes('https://assets.example')); assert(!frames[1].srcdoc.includes('https://assets.example'));
    currentPrefs = {}; refreshPreviewConfirmation(); assert(frames.every(frame => frame.srcdoc.includes('connect-src https:;')));
  } finally { document.querySelectorAll = originalQuery; configurePreviewConfirmation({ getPrefs: () => ({}), openSettings() {} }); }
  t.ok('Only mounted sender accepted; deduplicated count; Load affects its own display; prefs repaint', true);

  // http も数える（止めた件数）。許可に加えられる・読み込めるのは https だけ
  assert.equal(blockedOrigin('http://127.0.0.1:8080/a.png'), 'http://127.0.0.1:8080'); assert.equal(externalOrigin('http://127.0.0.1:8080/a.png'), null);
  assert.equal(blockedOrigin('javascript:1'), null); assert.equal(blockedOrigin('http://u:p@x.example/'), null);
  assert.match(visualizationDocument('x'), /\^https\?:/, '写しの枠の橋は http も知らせる');
  assert(!visualizationDocument('x', { resize: false }).includes('console.debug') && visualizationDocument('x', { resize: false, report: true }).includes("console.debug('ply-preview-blocked "), 'console の橋は内蔵ブラウザーの写し（report）だけ');
  assert(!visualizationDocument('x', { report: true }).includes('console.debug'), '枠（親に知らせられる）には console の橋を足さない');
  {
    currentPrefs = { confirmExternalLoads: true };
    configurePreviewConfirmation({ getPrefs: () => currentPrefs, openSettings() {} });
    const host2 = new N('div'), frame = new N('iframe');
    frame.contentWindow = {}; frame.after = bar => host2.append(bar);
    confirmedPreview(frame, policy => visualizationDocument(record.content, { policy })); host2.append(frame);
    const saved = document.querySelectorAll; document.querySelectorAll = () => [frame];
    try {
      const send = url => receivePreviewViolation({ source: frame.contentWindow, data: { type: 'ply-preview-blocked', url } });
      assert.equal(send('http://127.0.0.1:8080/a.png'), true);
      const bar = host2.querySelector('.preview-blocked');
      assert(bar.textContent.includes('1')); assert.equal(bar.children[1].hidden, true, 'http だけなら「読み込む」を出さない');
      assert(!blockedPreviewOrigins().some(origin => origin.startsWith('http:')), '設定の止めた出どころに http は載せない');
      assert.equal(send('https://s.example/a.png'), true);
      assert(bar.textContent.includes('2'), 'http も数える'); assert.equal(bar.children[1].hidden, false);
      assert(blockedPreviewOrigins().includes('https://s.example'));
      bar.children[1].onclick();
      assert(frame.srcdoc.includes('connect-src https://s.example;') && !frame.srcdoc.includes('127.0.0.1'), '読み込むは https だけを通す');
    } finally { document.querySelectorAll = saved; currentPrefs = {}; configurePreviewConfirmation({ getPrefs: () => ({}), openSettings() {} }); }
    let heard = 0;
    // 内蔵ブラウザーの file: のタブが止めた https の出どころも、設定の「止めた出どころ」に並ぶ
    noteBlockedOrigins(['https://tab.example', 'http://tab-http.example', 'https://tab.example/path', 'nope']);
    assert(blockedPreviewOrigins().includes('https://tab.example')); assert(!blockedPreviewOrigins().some(origin => /tab-http|path|nope/.test(origin)));
  }
  t.ok('Blocked count includes http, Load and the allow list take https only, tab origins reach Settings', true);

  const get = document.getElementById, nodes = { browserPanel: new N('section'), browserTab: new N('button') };
  document.getElementById = id => nodes[id];
  let saved = {}, settings;
  try {
    settings = setupBrowserSettings({ available: true, getPrefs: () => saved, cmd: async (_name, { key, value }) => { saved[key] = value; settings.paint(); } });
    const toggles = nodes.browserPanel.querySelectorAll('input'); assert.equal(toggles.length, 2); assert(toggles.every(toggle => !toggle.checked));
    toggles[0].checked = true; await toggles[0].onchange(); assert.equal(saved.confirmExternalLoads, true);
    const subheads = () => nodes.browserPanel.querySelectorAll('h4').map(h => h.textContent);
    assert(subheads().includes('止めた出どころ') && !subheads().includes('外部の読み込み'), '許可したサイトが無いとき、中身の無い小見出し「外部の読み込み」を出さない');
    assert(!subheads().includes('エージェントの利用'), '一覧が空のエージェントの小見出しも出さない');
    const permit = nodes.browserPanel.querySelectorAll('button').find(button => button.textContent === '許可'); await permit.onclick();
    assert(subheads().includes('外部の読み込み'), '許可したサイトが 1 件でもあれば小見出しを出す');
    assert.equal(saved.externalSitePermissions[0].mode, 'always');
    await nodes.browserPanel.querySelectorAll('button').find(button => button.textContent === '毎回聞く').onclick(); assert.equal(saved.externalSitePermissions[0].mode, 'ask');
    await nodes.browserPanel.querySelectorAll('button').find(button => button.textContent === '消す').onclick(); assert.equal(saved.externalSitePermissions.length, 0);
  } finally { document.getElementById = get; }
  t.ok('Settings default OFF and save allow / ask / remove through setPref', true);

  let sitePrefs = {}, asked = [], answer = { allow: false };
  const authorize = createBrowserSiteApprovals({ getPrefs: async () => sitePrefs, getAgent: async id => ({ id, label: id }), translate: (_key, vars) => JSON.stringify(vars),
    askPermission: async request => { asked.push(request); return answer; }, remember: async row => { sitePrefs.agentSitePermissions = [...(sitePrefs.agentSitePermissions || []), row]; } });
  assert((await authorize({ sessionId: 'codex', url: 'https://example.org/a' })).allow); assert.equal(asked.length, 0);
  sitePrefs.confirmAgentSites = true;
  assert(!(await authorize({ sessionId: 'codex', url: 'https://example.org/a' })).allow);
  // 「ログイン済み」（アカウント名）は出さない（ADR 0153）。渡されても題・payload に載せない
  answer = { allow: true }; assert((await authorize({ sessionId: 'codex', url: 'https://example.org/a', account: 'alice' })).allow);
  assert(!asked.at(-1).title.includes('alice') && !('account' in asked.at(-1).browserSite));
  await authorize({ sessionId: 'codex', url: 'https://example.org/b' }); assert.equal(asked.length, 3);
  answer = { allow: true, always: true }; await authorize({ sessionId: 'codex', url: 'https://example.org/' });
  await authorize({ sessionId: 'codex', url: 'https://example.org/next' }); assert.equal(asked.length, 4);
  await authorize({ sessionId: 'claude', url: 'https://example.org/' }); assert.equal(asked.length, 5);
  t.ok('Site approvals: deny, once, persistent agent × origin, never an account name', true);

  let enabled = true, resolve, askedCount = 0, sent = 0, url = 'https://one.example';
  const c = new EventEmitter(); c.getURL = () => url; c.isDestroyed = () => false; c.loadURL = async next => { url = next; c.emit('did-navigate', {}, next); };
  const tab = { id: 'tab', sessionId: 'codex', webContents: c };
  const gate = createBrowserNavigation({ enabled: () => enabled, authorize: () => { askedCount++; return new Promise(r => { resolve = r; }); } }); gate.watch(tab);
  const go = next => gate.run(tab, 'Page.navigate', { url: next }, async () => { sent++; await c.loadURL(next); return {}; });
  const first = go('https://two.example'); await tick(); assert.equal(sent, 0); resolve({ allow: true }); await first; assert.equal(url, 'https://two.example');
  await go('https://two.example/path'); assert.equal(askedCount, 1);
  const denied = go('https://three.example'); await tick(); resolve({ allow: false }); await assert.rejects(denied); assert.equal(sent, 2);
  let blocked = false;
  c.emit('will-frame-navigate', { url: 'https://four.example', isMainFrame: true, preventDefault() { blocked = true; } }); assert(blocked); await tick(); resolve({ allow: true }); await tick(); assert.equal(url, 'https://four.example');
  blocked = false; c.emit('will-redirect', { url: 'https://five.example', isMainFrame: true, preventDefault() { blocked = true; } }); assert(blocked); await tick(); resolve({ allow: true }); await tick(); assert.equal(url, 'https://five.example');
  let popup = false; assert(gate.popup(tab, 'https://popup.example', () => { popup = true; })); await tick(); assert(!popup); resolve({ allow: true }); await tick(); assert(popup);
  gate.human(tab); blocked = false;
  c.emit('will-frame-navigate', { url: 'https://human.example', isMainFrame: true, preventDefault() { blocked = true; } }); assert(!blocked);
  enabled = false; await go('https://off.example'); assert.equal(url, 'https://off.example');
  enabled = true;
  const cancelled = go('https://cancelled.example'); await tick(); gate.cancel('codex'); resolve({ allow: true }); await assert.rejects(cancelled);
  assert.equal(url, 'https://off.example');
  c.emit('before-input-event'); blocked = false;
  c.emit('will-frame-navigate', { url: 'https://human.example', isMainFrame: true, preventDefault() { blocked = true; } }); assert(!blocked);
  t.ok('Agent navigate is held, deny fails, same-origin passes; page navigation, redirect, popup guarded; human and OFF pass', true);
}
