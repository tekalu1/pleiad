import assert from 'node:assert/strict';
import { N } from '../lib/dom-stub.mjs';
import { setupBrowserSettings, chromeLabel } from '../../web/browser-settings.mjs';

export const name = 'chrome-settings';
export const title = '設定 › ブラウザー › エージェントのブラウザー: 状態ごとの字とボタン・使えない環境（DOM の代役。ADR 0148・0153）';

const buttonsOf = section => section.querySelectorAll('button').map(b => b.textContent);
const statusOf = section => section.querySelectorAll('.stt')[0]?.textContent;
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

export default async function (t) {
  const nodes = { browserTab: new N('button'), browserPanel: new N('section') };
  const savedGet = document.getElementById;
  document.getElementById = id => nodes[id] ?? null;
  const savedNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  try {
    // ---- ホストの画面（available）
    let caps = null;
    const sent = [];
    let status = { state: 'off', reason: null, dialog: false, product: null };
    const settings = setupBrowserSettings({ available: true, cmd: async (command) => { sent.push(command); return command === 'chromeStatus' ? status : undefined; }, getPrefs: () => ({}), getHostCaps: () => caps });
    const section = nodes.browserPanel.querySelector('.browser-chrome-setting');
    t.ok('節は「エージェントの操作」の行の上にあり、状態が分かるまで隠れている', section && section.hidden === true
      && nodes.browserPanel.children.indexOf(section) < nodes.browserPanel.children.findIndex(c => c.className === 'browser-agent-setting'));

    caps = { chromeBrowser: 'available' };
    await settings.hostCapsChanged();
    t.ok('hostCapabilities が届くと chromeStatus を取り、節が出る', sent.join() === 'chromeStatus' && section.hidden === false);
    t.ok('off: 「つながっていません」と主のボタン「つなぐ」', statusOf(section) === 'つながっていません' && buttonsOf(section).join() === 'つなぐ', buttonsOf(section).join());
    section.querySelectorAll('button')[0].onclick();
    t.ok('「つなぐ」は chromeConnect を送る', sent.at(-1) === 'chromeConnect');
    t.ok('Chrome の印は読み上げない（aria-hidden）', section.querySelector('.browser-conn-mark')?.getAttribute('aria-hidden') === 'true');
    t.ok('状態は role=status で読み上げる', section.querySelectorAll('.stt')[0].getAttribute('role') === 'status');

    // ---- A: setup
    settings.chromeEvent({ state: 'setup', reason: null, dialog: false, product: null });
    const text = section.textContent;
    t.ok('setup（A）: 手順 2 つと、アドレス（chrome://inspect/#remote-debugging）', text.includes('次のアドレスをコピーします') && text.includes('Allow remote debugging for this browser instance')
      && section.querySelectorAll('code')[0].textContent === 'chrome://inspect/#remote-debugging', text);
    t.ok('setup: 主のボタンは「アドレスをコピー」、もう 1 つは「やめる」', buttonsOf(section).join() === 'アドレスをコピー,やめる' && section.querySelectorAll('button')[0].className.includes('btn-primary'));
    t.ok('setup: 「オンになったら自動で進みます」を弱い字で', text.includes('オンになったら自動で進みます'));
    section.querySelectorAll('button')[1].onclick();
    t.ok('「やめる」は chromeDisconnect を送る', sent.at(-1) === 'chromeDisconnect');

    // コピー（clipboard が無い・ある）
    Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true });
    section.querySelectorAll('button')[0].onclick();
    await tick();
    t.ok('クリップボードが使えなければ、選んでコピーしてもらう文を出す', section.textContent.includes('コピーできませんでした'));
    let copiedText = null;
    Object.defineProperty(globalThis, 'navigator', { value: { clipboard: { writeText: async v => { copiedText = v; } } }, configurable: true });
    section.querySelectorAll('button')[0].onclick();
    await tick();
    t.ok('アドレスをコピーして、ボタンの字が「コピーしました」になる', copiedText === 'chrome://inspect/#remote-debugging' && buttonsOf(section)[0] === 'コピーしました' && !section.textContent.includes('コピーできませんでした'), buttonsOf(section).join());

    // ---- B: permission
    settings.chromeEvent({ state: 'permission', reason: null, dialog: true, product: null });
    t.ok('permission（B）: 「Chrome に許可の確認が出ています」', statusOf(section) === 'Chrome に許可の確認が出ています');
    t.ok('permission: 「ダイアログを前に出す」「やめる」。弱い字で「Chrome が確認を出し直しても、そのまま待ちます」', buttonsOf(section).join() === 'ダイアログを前に出す,やめる' && section.textContent.includes('Chrome が確認を出し直しても、そのまま待ちます'));
    section.querySelectorAll('button')[0].onclick();
    t.ok('「ダイアログを前に出す」は chromeRaiseDialog を送る', sent.at(-1) === 'chromeRaiseDialog');
    const before = section.textContent;
    settings.chromeEvent({ state: 'permission', reason: null, dialog: false, product: null });
    t.ok('確認を見つけたかどうか（dialog）では字を変えない（出し直しで見た目が動かない）', section.textContent === before);

    // ---- C: denied
    settings.chromeEvent({ state: 'denied', reason: 'cancel', dialog: false, product: null });
    t.ok('denied（C）: 「Chrome で許可されませんでした」（キャンセルと確認の「[設定] でオフにする」を見分けられないので中立の字）と「もう一度」「やめる」', statusOf(section) === 'Chrome で許可されませんでした' && buttonsOf(section).join() === 'もう一度,やめる');
    section.querySelectorAll('button')[0].onclick();
    t.ok('「もう一度」は chromeConnect を送る', sent.at(-1) === 'chromeConnect');
    t.ok('denied に「5 分で切れた」の字は無い', !section.textContent.includes('5 分') && !section.textContent.includes('切れ'));

    // ---- D: connected
    settings.chromeEvent({ state: 'connected', reason: null, dialog: false, product: 'Chrome/154.0.8037.97' });
    t.ok('connected（D）: 「つながっています · Chrome 154」と「切る」', statusOf(section) === 'つながっています · Chrome 154' && buttonsOf(section).join() === '切る', statusOf(section));
    t.ok('connected: 帯が出ることがある、の 1 行', section.textContent.includes('自動テスト ソフトウェアによって制御されています'));
    t.ok('chromeLabel: product から「Chrome 154」を作る。読めなければ「Chrome」', chromeLabel('Chrome/154.0.8037.97') === 'Chrome 154' && chromeLabel('') === 'Chrome' && chromeLabel(null) === 'Chrome');

    // ---- 切れた後の off は理由の 1 行
    settings.chromeEvent({ state: 'off', reason: 'chrome-closed', dialog: false, product: null });
    t.ok('Chrome が閉じて off: 「Chrome が閉じました。」を添える', section.textContent.includes('Chrome が閉じました。') && buttonsOf(section).join() === 'つなぐ');
    settings.chromeEvent({ state: 'off', reason: 'revoked', dialog: false, product: null });
    t.ok('許可の取り消しで off: 「Chrome で許可が取り消されました。」', section.textContent.includes('Chrome で許可が取り消されました。'));
    settings.chromeEvent({ state: 'off', reason: 'disconnected', dialog: false, product: null });
    t.ok('自分で切ったときは理由を出さない', !section.textContent.includes('Chrome が閉じました') && !section.textContent.includes('取り消されました'));
    settings.chromeEvent({ state: 'off', reason: 'declined', dialog: false, product: null });
    t.ok('「やめる」の後も理由を出さない', buttonsOf(section).join() === 'つなぐ' && section.querySelectorAll('.browser-setting-note').filter(n => n.textContent).length === 0);

    // ---- 使えない
    settings.chromeEvent({ state: 'unsupported', reason: 'platform', dialog: false, product: null });
    t.ok('unsupported / platform: 「この OS ではまだ使えません」だけ。ボタンは無い', statusOf(section) === 'この OS ではまだ使えません' && buttonsOf(section).length === 0);
    settings.chromeEvent({ state: 'unsupported', reason: 'native', dialog: false, product: null });
    t.ok('OS 以外の理由（koffi を読めない等）は「この環境ではまだ使えません」', statusOf(section) === 'この環境ではまだ使えません');

    // ---- 失敗は節の中に出す
    const failing = [];
    caps = { chromeBrowser: 'available' };
    const s2nodes = { browserTab: new N('button'), browserPanel: new N('section') };
    document.getElementById = id => s2nodes[id] ?? null;
    const s2 = setupBrowserSettings({ available: true, cmd: async (command) => { failing.push(command); if (command === 'chromeConnect') throw new Error('この環境ではまだ使えません'); return { state: 'off', reason: null, dialog: false, product: null }; }, getPrefs: () => ({}), getHostCaps: () => caps });
    await s2.hostCapsChanged();
    const sec2 = s2nodes.browserPanel.querySelector('.browser-chrome-setting');
    sec2.querySelectorAll('button')[0].onclick();
    await tick();
    t.ok('操作が失敗したら、節の中に理由を出す', sec2.textContent.includes('操作できませんでした: この環境ではまだ使えません'), sec2.textContent.slice(-80));

    // ---- Electron の無いホスト（chromeBrowser: false）では出ない
    const s3nodes = { browserTab: new N('button'), browserPanel: new N('section') };
    document.getElementById = id => s3nodes[id] ?? null;
    const asked = [];
    const s3 = setupBrowserSettings({ available: true, cmd: async c => { asked.push(c); }, getPrefs: () => ({}), getHostCaps: () => ({ chromeBrowser: false }) });
    await s3.hostCapsChanged();
    s3.chromeEvent({ state: 'off', reason: null, dialog: false, product: null });
    t.ok('hostCapabilities.chromeBrowser が false なら、状態を取りにも行かず、節も出さない', asked.length === 0 && s3nodes.browserPanel.querySelector('.browser-chrome-setting').hidden === true);

    // ---- ブラウザーで開いた画面・リモート（available: false）には節そのものが無い
    const s4nodes = { browserTab: new N('button'), browserPanel: new N('section') };
    document.getElementById = id => s4nodes[id] ?? null;
    const s4 = setupBrowserSettings({ available: false, cmd: async () => {}, getPrefs: () => ({}), getHostCaps: () => ({ chromeBrowser: 'available' }) });
    await s4.hostCapsChanged();
    s4.chromeEvent({ state: 'off', reason: null, dialog: false, product: null });
    t.ok('available: false の画面には「エージェントのブラウザー」の節が無い', s4nodes.browserPanel.querySelector('.browser-chrome-setting') === null || s4nodes.browserPanel.querySelector('.browser-chrome-setting').parent === null);
  } finally {
    document.getElementById = savedGet;
    if (savedNavigator) Object.defineProperty(globalThis, 'navigator', savedNavigator);
  }
  assert.ok(true);
}
