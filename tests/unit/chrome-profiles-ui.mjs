import assert from 'node:assert/strict';
import { N } from '../lib/dom-stub.mjs';
import { setupBrowserSettings } from '../../web/browser-settings.mjs';
import { setupChromeProfilePill } from '../../web/chrome-profile-pill.mjs';
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

  // ---- 道具の列のプロフィール選択 pill とメニュー（第 10 段）
  {
    const slot = new N('div');
    let session = 's1';
    let menuCalls = [];
    let invoked = [];
    let currentProfile = work;
    let currentBusy = null;
    let hostCaps = { chromeBrowser: 'available', chromeWindow: true };

    const testPrefs = { confirmAgentSites: true, chromeNewProfile: work, chromeProfileNotes: [{ ...work, note: '社内サイト用' }] };

    const pill = setupChromeProfilePill({
      slot,
      cmd: async (command, args) => {
        if (command === 'invoke' && args.op === 'browser.listProfiles') {
          if (hostCaps.chromeBrowser === false && hostCaps.chromeWindow === false) {
            throw new Error('UNSUPPORTED');
          }
          invoked.push({ op: args.op, args: args.args });
          return { profiles, current: currentProfile, busy: currentBusy };
        }
        if (command === 'invoke' && args.op === 'browser.useProfile') {
          invoked.push({ op: args.op, args: args.args });
          return { browser: args.args.browser, dir: args.args.profile, name: '個人', changed: true };
        }
        throw new Error('unknown cmd: ' + command);
      },
      showMenu: (x, y, items, title, opts) => {
        menuCalls.push({ x, y, items, title, opts });
      },
      getSessionId: () => session,
      getPrefs: () => testPrefs,
      getHostCaps: () => hostCaps,
      openSettings: () => { writes.push({ action: 'openSettings' }); },
    });

    // 1. 出る条件: Chrome が使える環境で会話があるとき
    await pill.refresh();
    const btn = slot.querySelector('button');
    assert(btn, 'pill の button が slot に生成されること');
    assert.equal(btn.getAttribute('aria-haspopup'), 'menu');
    assert.equal(btn.getAttribute('aria-expanded'), 'false');
    assert.match(btn.textContent, /仕事/);
    assert.match(btn.textContent, /社内サイト用/);

    // 2. 選ぶと op が呼ばれる: クリックでメニューを開き、項目を選ぶと browser.useProfile が呼ばれて表示が変わる
    btn.onclick();
    assert.equal(menuCalls.length, 1);
    assert.equal(btn.getAttribute('aria-expanded'), 'true');
    const menu = menuCalls[0];
    const defaultItem = menu.items.find(i => i.label?.includes('個人'));
    assert(defaultItem, '「個人」のメニュー項目があること');
    await defaultItem.onClick();
    assert.deepEqual(invoked.at(-1), {
      op: 'browser.useProfile',
      args: { sessionId: 's1', browser: 'chrome', profile: 'Default' },
    });
    assert.match(btn.textContent, /個人/);
    // メニューを閉じたときの aria-expanded リセット
    menu.opts.onClose();
    assert.equal(btn.getAttribute('aria-expanded'), 'false');

    // 3. busy のとき: 操作中・依頼待ち・引き継ぎ中は aria-disabled になり、メニューで理由が出る
    currentBusy = 'operating';
    await pill.refresh();
    assert.equal(btn.getAttribute('aria-disabled'), 'true');
    assert.equal(btn.dataset.busy, 'operating');
    menuCalls = [];
    btn.onclick();
    assert.equal(menuCalls.length, 1);
    assert(menuCalls[0].items[0].head, '先頭に busy 理由の見出しがあること');
    assert(menuCalls[0].items.slice(1).filter(i => i.radio).every(i => i.disabled), '各プロフィール項目が disabled であること');

    // 4. イベントで表示が替わる: chromeProfile イベントで即座に反映
    currentBusy = null;
    currentProfile = work;
    pill.onProfileEvent({ sessionId: 's1', profile: { browser: 'chrome', dir: 'Default' } });
    assert.match(btn.textContent, /個人/);
    // 別の会話のイベントは無視される
    pill.onProfileEvent({ sessionId: 's2', profile: { browser: 'chrome', dir: 'Profile 1' } });
    assert.match(btn.textContent, /個人/);

    // 5. 出ない条件:
    // 5a. 会話が無いとき
    session = null;
    await pill.refresh();
    assert.equal(slot.children.length, 0, '会話が無いときはスロットが空になること');

    // 5b. Chrome の層が無いホスト（Windows 以外など）
    session = 's1';
    hostCaps = { chromeBrowser: false, chromeWindow: false };
    await pill.refresh();
    assert.equal(slot.children.length, 0, 'Chrome 層が無いホストではスロットが空になること');

    t.ok('Chrome の固定タブの道具の列で、出る・出ない条件、メニュー選択での op 呼出、busy、イベントによる更新が正しく動く', true);
  }
}
