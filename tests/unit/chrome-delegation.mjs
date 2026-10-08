import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createProfileChoice } from '../../core/chrome/profile-choice.mjs';
import { delegatedChromeTarget, delegatedChromeWindows } from '../../core/chrome/delegation.mjs';
import { createChromeLoginGroups } from '../../core/chrome/login-groups.mjs';
import { createChromeConnection } from '../../core/chrome/connection.mjs';
import { createChromeRelay } from '../../core/chrome/relay.mjs';
import { createChromeWindows } from '../../core/chrome/windows.mjs';
import { createChromeControl } from '../../core/chrome/control.mjs';
import { createChromeHandoffs } from '../../core/chrome/handoff.mjs';
import { startFakeChrome } from '../lib/fake-chrome.mjs';
import { fakeChromeOs } from '../lib/fake-chrome-os.mjs';
import { browserHandoffView } from '../../web/browser-handoff-card.mjs';
import { paintTaskChrome } from '../../web/task-chrome.mjs';

export const name = 'chrome-delegation';
export const title = 'Chrome の委譲: プロフィールの写し、親だけの窓操作、2 人の子の同じサイトのログイン待ち、窓ごとの停止（偽の Chrome）';

export default async function (t) {
  const refs = [{ browser: 'chrome', dir: 'Default', name: '個人' }, { browser: 'chrome', dir: 'Profile 1', name: '仕事' }];
  const meta = new Map([['parent', {}], ['a', {}], ['b', {}], ['other', {}]]);
  const choice = createProfileChoice({ list: async () => refs, peek: id => meta.get(id), save: async (id, ref) => { meta.get(id).chromeProfile = ref; },
    getPrefs: async () => ({ chromeNewProfile: { browser: 'chrome', dir: 'Default' } }) });
  await choice.use({ sessionId: 'parent', profile: 'Profile 1' });
  await choice.inherit('parent', 'a');
  await choice.inherit('parent', 'b');
  assert.deepEqual(choice.current('a'), { browser: 'chrome', dir: 'Profile 1' });
  await choice.use({ sessionId: 'parent', profile: 'Default' });
  assert.deepEqual(choice.current('a'), { browser: 'chrome', dir: 'Profile 1' }, '親の後の変更は子へ波及しない');
  await choice.use({ sessionId: 'a', profile: 'Default', by: 'agent' });
  assert.deepEqual(choice.current('b'), { browser: 'chrome', dir: 'Profile 1' }, '子が選び直しても兄弟には波及しない');
  await choice.inherit('other', 'other-child');
  assert.deepEqual(choice.current('other-child'), { browser: 'chrome', dir: 'Default' }, '親が未選択なら設定の既定');
  t.ok('親のプロフィールを作成時に写し、親・兄弟の後の変更と切り離す', true);

  const rows = [
    { taskId: 'ta', parentSessionId: 'parent', sessionId: 'a', title: 'A' },
    { taskId: 'tb', parentSessionId: 'parent', sessionId: 'b', title: 'B' },
    { taskId: 'remote', parentSessionId: 'parent', sessionId: 'remote-child', host: { id: 'elsewhere' } },
    { taskId: 'grandchild', parentSessionId: 'a', sessionId: 'grandchild' },
  ];
  meta.get('a').delegation = { taskId: 'ta', parentSessionId: 'parent' };
  meta.get('b').delegation = { taskId: 'tb', parentSessionId: 'parent' };
  const deps = { task: id => rows.find(row => row.taskId === id), meta: async id => meta.get(id) };
  assert.equal(await delegatedChromeTarget('parent', 'ta', deps), 'a');
  for (const id of ['remote', 'grandchild', 'unknown']) await assert.rejects(delegatedChromeTarget('parent', id, deps));
  await assert.rejects(delegatedChromeTarget('elsewhere', 'ta', deps));
  meta.get('b').delegation.taskId = 'stale';
  await assert.rejects(delegatedChromeTarget('parent', 'tb', deps), '孤立した台帳は使わない');
  meta.get('b').delegation.taskId = 'tb';
  const listing = delegatedChromeWindows('parent', { rows: () => rows, sessions: () => ['parent', 'a', 'b'], summary: id => ({ windows: id === 'parent' ? 1 : 2 }),
    profile: id => choice.current(id), state: id => id === 'a' ? 'paused' : 'running' });
  assert.deepEqual(listing.map(row => row.taskId), [null, 'ta', 'tb']);
  assert.equal(listing[1].state, 'paused');
  t.ok('親の直接の子だけを閉じる対象にでき、リモート・孫・別の親・孤立した記録を断る。窓一覧は開いている分だけ', true);

  const el = (tag, cls = null, value = '') => ({ tag, className: cls, textContent: value, children: [],
    append(...children) { this.children.push(...children); }, replaceChildren(...children) { this.children = children; },
    setAttribute() {}, removeAttribute() {} });
  const commands = [];
  const handoffCard = browserHandoffView({ id: 'parent-card', sessionId: 'parent', targetSessionId: 'a',
    browserHandoff: { reason: 'login', state: 'asked', waitingTasks: [{ taskId: 'ta', title: 'A' }, { taskId: 'tb', title: 'B' }] } },
  { el, t: key => key, cmd: async (name, args) => { commands.push([name, args]); } });
  assert.deepEqual(handoffCard.body.children.find(child => child.tag === 'ul')?.children.map(child => child.textContent), ['A', 'B']);
  await handoffCard.buttons.at(-1).onclick();
  handoffCard.update({ state: 'operating' });
  await handoffCard.buttons.at(-1).onclick();
  assert.deepEqual(commands, [['chromeTakeOver', { sessionId: 'a' }], ['chromeResume', { sessionId: 'a' }]]);
  t.ok('親の 1 枚のカードに 2 つの作業を並べ、引き継ぎと戻すを子の会話へ送る', true);

  let chromeLine = null;
  const card = { querySelector(selector) { return selector === ':scope > .tc-task-chrome' ? chromeLine : selector === ':scope > .tc-details' ? { after(line) { chromeLine = line; } } : null; } };
  const rowActions = [];
  const rowWords = { 'taskChrome.view': 'Chrome の窓を見る', 'taskChrome.close': '子の Chrome の窓を閉じる',
    'taskChrome.running': '作業中', 'taskChrome.paused': '引き継ぎ中' };
  const paintRow = row => paintTaskChrome(card, row, { el, open: id => rowActions.push(['open', id]), close: id => rowActions.push(['close', id]), t: key => rowWords[key] });
  paintRow({ sessionId: 'a', windows: 1, profileName: '仕事', state: 'running' });
  assert.deepEqual(chromeLine.children.map(child => child.textContent), ['Chrome', '仕事', '作業中', 'Chrome の窓を見る', '×']);
  chromeLine.children.at(-2).onclick();
  chromeLine.children.at(-1).onclick();
  paintRow({ sessionId: 'a', windows: 1, profileName: '個人', state: 'paused' });
  assert.deepEqual(rowActions, [['open', 'a'], ['close', 'a']]);
  assert.equal(chromeLine.children[1].textContent, '個人');
  t.ok('委譲カードの細い行は子の会話と窓を操作し、子のプロフィール変更を表示する', true);

  const chrome = await startFakeChrome();
  await fs.writeFile(path.join(chrome.userDataDir, 'Local State'), JSON.stringify({ profile: { last_used: 'Default', info_cache: {
    Default: { name: '個人' }, 'Profile 1': { name: '仕事' },
  } } }));
  const os = fakeChromeOs({ chrome });
  const locate = { browser: 'chrome', userDataDir: chrome.userDataDir, custom: true };
  const connection = createChromeConnection({ locate, os, pollMs: 20 });
  const groups = createChromeLoginGroups();
  const cards = [];
  let relay;
  const askPermission = async opts => {
    const targetId = relay.view.current(opts.sessionId);
    const info = await relay.cdp.send('Target.getTargetInfo', { targetId });
    const origin = new URL(info.targetInfo.url).origin;
    const windowId = relay.view.tabs(opts.sessionId).find(tab => tab.targetId === targetId)?.windowId;
    const dir = relay.scope.windows(opts.sessionId).find(window => window.windowId === windowId)?.profile;
    const key = groups.key({ parent: 'parent', profile: dir ? { browser: 'chrome', dir } : null, origin, reason: opts.browserHandoff.reason });
    const { group, joined } = groups.prepare(key);
    return new Promise(resolve => {
      const card = { sessionId: opts.sessionId, parent: !joined, settled: false };
      cards.push(card);
      const settle = answer => {
        if (card.settled) return;
        card.settled = true;
        groups.finish(key, group, opts.sessionId, answer);
        opts.onSettle(answer);
        resolve(answer);
      };
      group.members.set(opts.sessionId, { sessionId: opts.sessionId, settle });
      opts.onOpen({ id: `card-${opts.sessionId}`, update: () => {}, settle });
    });
  };
  const handoffs = createChromeHandoffs({ askPermission, connection, sessionBusy: () => false, turnLive: () => true, continueTurn: async () => {} });
  const scope = createChromeWindows({ os, locate, profileFor: () => ({ browser: 'chrome', dir: 'Profile 1' }), timing: { hwndWaitMs: 200, hwndPollMs: 10, targetWaitMs: 500, targetPollMs: 10, popupWaitMs: 200, boundsWaitMs: 100 } });
  relay = createChromeRelay({ connection, os, locate, scope, handoff: handoffs, turnLive: () => true });
  const control = createChromeControl({ relay, os });
  handoffs.useControl(control);
  try {
    await connection.connect();
    await relay.openForConversation('a', 'https://site.example/login');
    await relay.openForConversation('b', 'https://site.example/account');
    assert(['a', 'b'].every(id => scope.windows(id).some(window => window.profile === 'Profile 1')));
    handoffs.ask('a', { reason: 'login', message: 'ログイン' });
    handoffs.ask('b', { reason: 'login', message: 'ログイン' });
    const wa = handoffs.wait('a');
    const wb = handoffs.wait('b');
    for (let i = 0; cards.length < 2 && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(cards.length, 2);
    assert.equal(cards.filter(card => card.parent).length, 1, '親のカードは 1 枚');
    const first = cards.find(card => card.parent).sessionId;
    await control.takeOver(first);
    assert.equal(control.state(first).state, 'paused');
    assert.notEqual(control.state(first === 'a' ? 'b' : 'a').state, 'paused', '引き継ぎはその子だけ');
    await control.resume(first);
    assert.equal((await wa).kind, 'resumed');
    assert.equal((await wb).kind, 'resumed');
    assert(cards.every(card => card.settled), '両方の子のカードが済む');
    await control.stop('a');
    assert.equal(control.state('a').state, 'stopped');
    assert.notEqual(control.state('b').state, 'stopped', '停止はその子だけ');
    assert.equal(groups.key({ parent: 'parent', profile: { browser: 'chrome', dir: 'Profile 1' }, origin: 'https://site.example', reason: 'login' }),
      groups.key({ parent: 'parent', profile: { browser: 'chrome', dir: 'Profile 1' }, origin: 'https://site.example', reason: 'login' }));
    assert.notEqual(groups.key({ parent: 'parent', profile: { browser: 'chrome', dir: 'Default' }, origin: 'https://site.example', reason: 'login' }),
      groups.key({ parent: 'parent', profile: { browser: 'chrome', dir: 'Profile 1' }, origin: 'https://site.example', reason: 'login' }));
    assert.notEqual(groups.key({ parent: 'parent', profile: { browser: 'chrome', dir: 'Profile 1' }, origin: 'https://other.example', reason: 'login' }),
      groups.key({ parent: 'parent', profile: { browser: 'chrome', dir: 'Profile 1' }, origin: 'https://site.example', reason: 'login' }));
    assert.equal(groups.key({ parent: 'parent', profile: { browser: 'chrome', dir: 'Profile 1' }, origin: 'https://site.example', reason: 'captcha' }), null);
    const abortKey = groups.key({ parent: 'parent', profile: { browser: 'chrome', dir: 'Profile 1' }, origin: 'https://site.example', reason: 'login' });
    const abortGroup = groups.prepare(abortKey).group;
    let resumed = 0;
    abortGroup.members.set('a', { sessionId: 'a', settle: () => { throw new Error('stopped child resumed'); } });
    abortGroup.members.set('b', { sessionId: 'b', settle: () => { resumed++; } });
    assert.equal(groups.finish(abortKey, abortGroup, 'a', { allow: false, messageKey: 'aborted' }).sessionId, 'b');
    assert.equal(abortGroup.members.size, 1);
    groups.finish(abortKey, abortGroup, 'b', { allow: true });
    assert.equal(resumed, 0, '止めた子の待ちを別の子の決着で再開しない');
    t.ok('偽の Chrome の 2 つの子: 同じプロフィール・origin のログイン待ちは親 1 枚。戻すと両方再開し、引き継ぎ・停止は窓ごと', true);
    t.ok('最初の子が中断しても別の子の待ちは残り、ログイン以外は束ねない', true);
  } finally {
    handoffs.close(); control.close(); relay.close(); await connection.close(); await chrome.stop();
  }
}
