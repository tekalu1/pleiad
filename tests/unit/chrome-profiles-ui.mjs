import assert from 'node:assert/strict';
import { N } from '../lib/dom-stub.mjs';
import { setupBrowserSettings } from '../../web/browser-settings.mjs';
import { profileMenuItems, renderChromeProfileLine } from '../../web/chrome-profile-menu.mjs';
import { validProfileNotes, parseProfileKey } from '../../web/chrome-profile-model.mjs';

export const name = 'chrome-profiles-ui';
export const title = 'プロフィールの設定と共通メニュー: メモ・既定・選択・忙しい理由・会話の記録';
const tick = () => new Promise(resolve => setImmediate(resolve));

export default async function (t) {
  const profiles = [{ browser: 'chrome', dir: 'Default', name: '個人', note: '' }, { browser: 'chrome', dir: 'Profile 1', name: '仕事', note: '社内サイト用' }];
  const work = { browser: 'chrome', dir: 'Profile 1' };
  let picked;
  const items = profileMenuItems({ profiles, current: work, onPick: p => { picked = p; } });
  assert.equal(items[1].checked, true);
  assert.equal(items[1].note, '社内サイト用');
  const sameNames = profileMenuItems({ profiles: profiles.map(p => ({ ...p, name: '同名' })) });
  assert.notEqual(sameNames[0].label, sameNames[1].label);
  items[0].onClick();
  assert.deepEqual(picked, { browser: 'chrome', dir: 'Default' });
  for (const busy of ['operating', 'waiting', 'human']) {
    const blocked = profileMenuItems({ profiles, current: work, busy });
    assert(blocked[0].head && blocked.slice(1).every(i => i.disabled));
  }
  assert.equal(profileMenuItems({ profiles: [] })[0].disabled, true);
  assert.match(renderChromeProfileLine({ chromeProfile: { name: '仕事', agent: 'Claude' } }).textContent, /Claude.*仕事/);
  assert.equal(validProfileNotes([{ ...work, note: 'a' }, { ...work, note: 'b' }]), false);
  assert.equal(parseProfileKey('chrome:../x'), null);
  t.ok('共通メニューが一覧のメモ・選択中・拒否理由を出し、選択を呼び出し側へ返す', true);

  const nodes = { browserTab: new N('button'), browserPanel: new N('section') };
  const original = document.getElementById;
  document.getElementById = id => nodes[id] ?? null;
  const prefs = { confirmAgentSites: true, chromeNewProfile: work, chromeProfileNotes: [{ ...work, note: '社内サイト用' }], agentSitePermissions: [
    { agent: 'fake', profile: 'chrome:Default', origin: 'https://site.example', mode: 'always' },
    { agent: 'fake', profile: 'chrome:Profile 1', origin: 'https://site.example', mode: 'always' },
  ] };
  const writes = [];
  try {
    const settings = setupBrowserSettings({ available: true, getPrefs: () => prefs, getHostCaps: () => ({ chromeBrowser: 'available' }),
      cmd: async (command, args) => {
        if (command === 'chromeStatus') return { state: 'off' };
        if (command === 'invoke') return { profiles, current: null, busy: null };
        if (command === 'setPref') { writes.push(args); prefs[args.key] = args.value; }
      } });
    await settings.hostCapsChanged();
    const section = nodes.browserPanel.querySelector('.browser-profile-setting');
    assert.equal(section.hidden, false);
    const select = section.querySelector('select');
    assert.equal(select.value, 'chrome:Profile 1');
    select.value = ''; select.onchange(); await tick();
    assert.equal(prefs.chromeNewProfile, null);
    const input = section.querySelectorAll('input')[1];
    assert.equal(input.value, '社内サイト用');
    input.value = '法人用'; input.onchange(); await tick();
    assert.deepEqual(prefs.chromeProfileNotes, [{ ...work, note: '法人用' }]);
    const sites = nodes.browserPanel.querySelectorAll('.browser-site');
    const one = sites.find(row => row.textContent.includes('個人'));
    assert(one && sites.some(row => row.textContent.includes('仕事')));
    one.querySelectorAll('button').at(-1).onclick(); await tick();
    assert.deepEqual(prefs.agentSitePermissions.map(row => row.profile), ['chrome:Profile 1']);
    assert(writes.length >= 3);
  } finally { document.getElementById = original; }
  t.ok('設定内だけで既定とメモを編集でき、許可の削除は同じサイトの別プロフィールを残す', true);
}
