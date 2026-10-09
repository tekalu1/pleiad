// 設定 › コンピューターの操作（docs/computer-use.md「設定と会話のデータ」）。
// prefs の検査と既定・store の remember/forget・hostCapabilities.computerUse の判定・設定の節の動き・setPref をサーバー越しに確かめる。
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { N } from '../lib/dom-stub.mjs';
import { startServer, ROOT } from '../lib/server.mjs';
import { open } from '../lib/ws-client.mjs';
import { computerAppRow, computerUsePrefs, validComputerUse, COMPUTER_APP_LIMIT } from '../../web/computer-prefs.mjs';
import { computerUseCapability } from '../../core/computer-use-capability.mjs';
import { setupComputerSettings, appLocation } from '../../web/computer-settings.mjs';

export const name = 'computer-settings';
export const title = 'computer use の設定: 検査・既定・store・節の動き・setPref';

const NOTEPAD = { id: 'exe:c:/windows/system32/notepad.exe', name: 'メモ帳', kind: 'exe', path: 'C:\\Windows\\System32\\notepad.exe', at: '2026-10-01T09:00:00.000Z' };
const CALC = { id: 'aumid:Microsoft.WindowsCalculator_8wekyb3d8bbwe!App', name: '電卓', kind: 'aumid', at: '2026-10-01T09:05:00.000Z' };

const storeScript = `
const store = await import(process.env.STORE_URL);
const out = {};
out.empty = await store.forgetComputerApp('exe:x');
await store.rememberComputerApp({ id: 'exe:c:/a.exe', name: 'A', kind: 'exe', path: 'C:\\\\a.exe' });
await store.rememberComputerApp({ id: 'aumid:B!App', name: 'B', kind: 'aumid' });
const again = await store.rememberComputerApp({ id: 'exe:c:/a.exe', name: 'A2', kind: 'exe', path: 'C:\\\\a.exe' });
out.rows = again.computerUse.alwaysAllowed.map(r => [r.id, r.name]);
out.bad = (await store.rememberComputerApp({ id: 'exe:c:/z.exe', name: '', kind: 'exe' })).computerUse.alwaysAllowed.length;
await store.setPref('computerUse', { enabled: false, allowAllApps: true, introduced: true, alwaysAllowed: again.computerUse.alwaysAllowed });
const after = await store.forgetComputerApp('aumid:B!App');
out.after = { ...after.computerUse, alwaysAllowed: after.computerUse.alwaysAllowed.map(r => r.id) };
console.log(JSON.stringify(out));
`;

export default async function (t) {
  // ---- 既定と検査 ----
  t.ok('prefs が無いときの既定（オン・すべて許可はオフ・未説明・空）', JSON.stringify(computerUsePrefs({})) === JSON.stringify({ enabled: true, allowAllApps: false, introduced: false, alwaysAllowed: [] }));
  t.ok('壊れた行・重複・型違いの項目は読むときに捨てる',
    computerUsePrefs({ computerUse: { enabled: 'no', allowAllApps: true, alwaysAllowed: [NOTEPAD, { ...NOTEPAD, name: 'dup' }, { id: 'exe:x', name: '', kind: 'exe' }, { id: 'exe:y', name: 'y', kind: 'aumid' }, 5] } }).alwaysAllowed.length === 1
    && computerUsePrefs({ computerUse: { enabled: 'no' } }).enabled === true);
  t.ok('行は id の接頭辞と kind が一致し、at は日時でなければならない',
    computerAppRow(NOTEPAD)?.path === NOTEPAD.path && !computerAppRow({ ...NOTEPAD, kind: 'aumid' }) && !computerAppRow({ ...NOTEPAD, at: 'yesterday' }) && !computerAppRow({ ...NOTEPAD, id: 'exe:' }) && !computerAppRow({ ...NOTEPAD, path: 3 }));
  const current = { enabled: true, allowAllApps: false, introduced: true, alwaysAllowed: [] };
  t.ok('setPref の値は形を検査し、渡さなかった項目は保存済みの値を残す',
    validComputerUse({ enabled: false }, current).introduced === true
    && validComputerUse({ allowAllApps: true, alwaysAllowed: [NOTEPAD, CALC], extra: 1 }, current).alwaysAllowed.length === 2
    && !('extra' in validComputerUse({ allowAllApps: true, extra: 1 }, current)));
  t.ok('型違い・配列でない・上限超え・壊れた行は断る',
    validComputerUse({ enabled: 'true' }, current) === null && validComputerUse([], current) === null && validComputerUse(null, current) === null
    && validComputerUse({ alwaysAllowed: 'x' }, current) === null && validComputerUse({ alwaysAllowed: [{ id: 'x' }] }, current) === null
    && validComputerUse({ alwaysAllowed: Array.from({ length: COMPUTER_APP_LIMIT + 1 }, (_, i) => ({ ...NOTEPAD, id: `exe:c:/${i}.exe` })) }, current) === null);

  // ---- hostCapabilities.computerUse ----
  const cap = computerUseCapability;
  t.ok('使えない理由: Electron でない → desktop / Windows・macOS でない → platform / main が読めない → native',
    cap({ hasParentPort: false, platform: 'win32' }).reason === 'desktop' && cap({ hasParentPort: true, platform: 'linux' }).reason === 'platform'
    && cap({ hasParentPort: true, platform: 'win32', ready: { supported: false, reason: 'native' } }).reason === 'native'
    && cap({ hasParentPort: true, platform: 'win32', ready: { supported: false } }).reason === 'native');
  t.ok('Windows の Electron では使える（computer-ready の前も後も）',
    cap({ hasParentPort: true, platform: 'win32' }).supported === true && cap({ hasParentPort: true, platform: 'win32', ready: { supported: true } }).supported === true);

  // ---- store ----
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-computer-prefs-'));
  try {
    const stdout = await new Promise((res, rej) => execFile(process.execPath, ['--input-type=module', '-e', storeScript], {
      env: { ...process.env, AGENT_HOST_DATA: dir, STORE_URL: pathToFileURL(path.join(ROOT, 'core', 'store.mjs')).href },
    }, (err, out, errOut) => err ? rej(new Error(`${err.message}\n${errOut}`)) : res(out)));
    const r = JSON.parse(stdout.trim().split(/\r?\n/).pop());
    t.ok('rememberComputerApp: 追加・同じ id は新しくする・形が違えば足さない', JSON.stringify(r.rows) === JSON.stringify([['aumid:B!App', 'B'], ['exe:c:/a.exe', 'A2']]) && r.bad === 2, JSON.stringify(r));
    t.ok('forgetComputerApp: 1 行だけ消し、ほかの項目と無い id には触らない', JSON.stringify(r.after) === JSON.stringify({ enabled: false, allowAllApps: true, introduced: true, alwaysAllowed: ['exe:c:/a.exe'] }) && r.empty.computerUse === undefined, JSON.stringify(r.after));
    const saved = JSON.parse(await fs.readFile(path.join(dir, 'prefs.json'), 'utf8'));
    t.ok('prefs.json に computerUse が残る', saved.computerUse?.alwaysAllowed?.[0]?.id === 'exe:c:/a.exe');
  } finally { await fs.rm(dir, { recursive: true, force: true }).catch(() => {}); }

  // ---- 設定の節 ----
  const get = document.getElementById;
  const nodes = { computerPanel: new N('section') };
  document.getElementById = id => nodes[id];
  let prefs = { computerUse: { enabled: true, allowAllApps: false, introduced: true, alwaysAllowed: [NOTEPAD, CALC] } };
  let caps = { computerUse: { supported: true } }, calls = [], failNext = false, view;
  const all = sel => nodes.computerPanel.querySelectorAll(sel);
  try {
    view = setupComputerSettings({
      getPrefs: () => prefs, getHostCaps: () => caps,
      cmd: async (command, args) => {
        calls.push([command, args]);
        if (failNext) { failNext = false; throw new Error('disk full'); }
        prefs = { ...prefs, [args.key]: args.value }; view.paint();
      },
    });
    const apps = () => all('.cu-app');
    t.ok('常に許可の一覧は名前と所在（パスか AUMID）を出す', apps().length === 2 && apps()[0].textContent.includes('メモ帳') && apps()[0].textContent.includes('C:\\Windows\\System32\\notepad.exe')
      && appLocation(CALC) === 'Microsoft.WindowsCalculator_8wekyb3d8bbwe!App' && apps()[1].textContent.includes('Microsoft.WindowsCalculator_8wekyb3d8bbwe!App'));
    t.ok('操作できないアプリは 5 分類を読み取りで出す', all('.cu-deny-row').length === 5 && all('.cu-deny-rows')[0].textContent.includes('パスワード管理'));
    const mainSwitch = all('.cx-sw')[0], allSwitch = all('.cx-sw')[1];
    t.ok('全体のスイッチの既定はオンで、下の面が見える', mainSwitch.getAttribute('aria-checked') === 'true' && !all('.cu-body')[0].hidden);

    allSwitch.onclick(); await Promise.resolve(); await new Promise(r => setImmediate(r));
    const sent = calls.at(-1)[1];
    t.ok('すべて許可を押すと全体を渡して保存し、一覧は薄くなって「すべて許可中」が出る',
      sent.key === 'computerUse' && sent.value.allowAllApps === true && sent.value.introduced === true && sent.value.alwaysAllowed.length === 2
      && all('.cu-apps')[0].classList.contains('dim') && all('.cu-tag')[0].hidden === false && all('.cu-apps')[0].getAttribute('aria-disabled') === 'true');
    t.ok('薄い間は「消す」を押せない', apps().every(a => a.querySelectorAll('.btn')[0].disabled === true));
    allSwitch.onclick(); await new Promise(r => setImmediate(r));
    t.ok('オフに戻すと一覧は元どおり（消していない）', !all('.cu-apps')[0].classList.contains('dim') && all('.cu-tag')[0].hidden === true && apps().length === 2);

    apps()[0].querySelectorAll('.btn')[0].onclick(); await new Promise(r => setImmediate(r));
    t.ok('「消す」は確認なしでその 1 行だけを消し、ほかの項目を保つ',
      prefs.computerUse.alwaysAllowed.map(r => r.id).join() === CALC.id && prefs.computerUse.introduced === true && apps().length === 1);
    apps()[0].querySelectorAll('.btn')[0].onclick(); await new Promise(r => setImmediate(r));
    t.ok('空なら「まだありません」', apps().length === 0 && all('.cu-empty')[0].textContent === 'まだありません');

    mainSwitch.onclick(); await new Promise(r => setImmediate(r));
    t.ok('全体をオフにすると下の面を隠すが、許可は残す', prefs.computerUse.enabled === false && all('.cu-body')[0].hidden === true && prefs.computerUse.allowAllApps === false);
    mainSwitch.onclick(); await new Promise(r => setImmediate(r));
    t.ok('オンに戻せる', prefs.computerUse.enabled === true && all('.cu-body')[0].hidden === false);

    failNext = true; mainSwitch.onclick(); await new Promise(r => setImmediate(r)); await new Promise(r => setImmediate(r));
    t.ok('保存に失敗したら理由を出し、画面は保存済みの値に戻る', all('.rm-strong').some(n => n.textContent === '保存できませんでした: disk full') && mainSwitch.getAttribute('aria-checked') === 'true');

    caps = { computerUse: { supported: false, reason: 'desktop' } }; view.paint();
    t.ok('Electron が無い起動では、スイッチを止めて理由を書き、下の面を隠す',
      mainSwitch.disabled === true && all('.cu-unsupported')[0].hidden === false && all('.cu-unsupported')[0].textContent.includes('デスクトップ版') && all('.cu-body')[0].hidden === true);
    calls.length = 0; mainSwitch.onclick(); await new Promise(r => setImmediate(r));
    t.ok('止めたスイッチは押しても保存しない', calls.length === 0);
    caps = { computerUse: { supported: false, reason: 'platform' } }; view.paint();
    t.ok('対象外の OS の理由', all('.cu-unsupported')[0].textContent === 'Windows または macOS 14 以上の PC で使えます。');
    caps = null; view.paint();
    t.ok('hostCapabilities が届く前は使えるものとして描く', mainSwitch.disabled === false && all('.cu-unsupported')[0].hidden === true);
  } finally { document.getElementById = get; }

  // ---- wait_until の問いに使うキー（設定 › API キーの割り当て computer:decider） ----
  const keyNodes = { computerPanel: new N('section'), computerTab: new N('button') };
  document.getElementById = id => keyNodes[id];
  const docAdd = document.addEventListener, docRemove = document.removeEventListener;
  document.addEventListener = () => {}; document.removeEventListener = () => {};
  const hadCss = 'CSS' in globalThis;
  if (!hadCss) globalThis.CSS = { escape: v => String(v) };
  const OR1 = { id: 'k1', provider: 'openrouter', label: '', lastCheck: { ok: true, at: '2026-10-07T00:00:00.000Z' } };
  const CB = { id: 'k2', provider: 'custom', label: '社内' };
  let list = { migration: { state: 'done' }, storage: 'safeStorage', keys: [OR1, CB], uses: { voice: null, 'judge:jev': null, 'computer:decider': null } };
  const keyCalls = [];
  const opened = [];
  try {
    const kv = setupComputerSettings({
      getPrefs: () => ({ computerUse: { enabled: true } }), getHostCaps: () => ({ computerUse: { supported: true } }), openPage: name => opened.push(name),
      cmd: async (command, args) => {
        keyCalls.push([command, args]);
        if (command === 'invoke' && args.op === 'apiKeys.list') return structuredClone(list);
        if (command === 'setApiKeyUse') { list.uses[args.use] = args.id; return { ok: true }; }
        return {};
      },
    });
    const q = sel => keyNodes.computerPanel.querySelectorAll(sel);
    const flush = async () => { for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r)); };
    t.ok('開く前はキーを読まない（何も送らない）', keyCalls.length === 0);
    keyNodes.computerTab.on.click.forEach(fn => fn());
    await flush();
    const note = q('.mp-note').map(n => n.textContent);
    t.ok('ページを開くとキーを読み、見出し・「使うキー」・未選択の文・注意書きを出す（通話と同じ部品）',
      keyCalls.some(([c, a]) => c === 'invoke' && a.op === 'apiKeys.list') && q('.nf-section')[0]?.querySelectorAll('h4')[0]?.textContent === 'wait_until の問いに使うキー'
      && q('.mp-card-info')[0]?.querySelectorAll('strong')[0]?.textContent === '使うキー' && q('.mp-card-info')[0]?.querySelectorAll('small')[0]?.textContent.includes('キーを選ぶまで')
      && note.includes('wait_until に問いを付けたとき、撮った画面が OpenRouter（Perplexity）へ送られます'), JSON.stringify(note));
    const btn = q('.ak-selbtn')[0];
    t.ok('選ぶ欄は OpenRouter のキーだけで、未選択は「使わない」', btn?.getAttribute('aria-label')?.startsWith('wait_until の問いに使うキー: '));
    btn.onclick();
    const options = q('.li');
    t.ok('候補は OpenRouter のキーと「使わない」（OpenRouter 以外のキーは出さない）', options.length === 2);
    options[0].onclick();
    await flush();
    t.ok('選ぶと setApiKeyUse { use: computer:decider, id } を送り、状態の行と管理へのリンクが出る',
      keyCalls.some(([c, a]) => c === 'setApiKeyUse' && a.use === 'computer:decider' && a.id === 'k1') && q('.ak-link').length === 1 && q('p').some(n => n.getAttribute('role') === 'status' && n.textContent.includes('wait_until の問いに使います')));
    q('.ak-link')[0].onclick();
    t.ok('「管理」から設定 › API キーへ移る', opened.join() === 'apiKeys');
    list = { ...list, uses: { ...list.uses, 'computer:decider': null } };
    const before = keyCalls.length;
    kv.event({ type: 'apiKeysChanged' });
    await flush();
    t.ok('apiKeysChanged で読み直す（ほかで外されたら未選択に戻る）', keyCalls.length > before && q('.ak-link').length === 0 && q('.mp-card-info')[0]?.querySelectorAll('small')[0]?.textContent.includes('キーを選ぶまで'));
    list = { ...list, migration: { state: 'deferred' } };
    kv.event({ type: 'apiKeysChanged' });
    await flush();
    t.ok('移行を保留している間は選べない（選ぶ欄と注意書きを出さない）', q('.ak-selbtn').length === 0 && q('.mp-note').length === 0);
  } finally { document.getElementById = get; document.addEventListener = docAdd; document.removeEventListener = docRemove; if (!hadCss) delete globalThis.CSS; }

  // ---- サーバー越し ----
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-computer-e-'));
  const server = await startServer({ dataDir: path.join(scratch, 'data'), env: { AGENT_HOST_BACKENDS: 'fake' }, timeoutMs: 30_000 });
  const c = await open({ port: server.port, token: server.token });
  try {
    const caps = await c.cmd('hostCapabilities');
    t.ok('hostCapabilities.computerUse: Electron でない起動は desktop で使えない', caps.computerUse?.supported === false && caps.computerUse.reason === 'desktop', JSON.stringify(caps));
    const from = c.mark();
    const saved = await c.cmd('setPref', { key: 'computerUse', value: { enabled: true, allowAllApps: true, alwaysAllowed: [NOTEPAD], extra: 1 } });
    const event = await c.waitFor(e => e.type === 'prefs' && e.prefs?.computerUse?.allowAllApps === true, { from, ms: 5000 });
    t.ok('setPref computerUse は検査して保存し、prefs を全画面へ流す（知らない項目は保存しない）',
      saved.computerUse.allowAllApps === true && saved.computerUse.alwaysAllowed[0].id === NOTEPAD.id && !('extra' in saved.computerUse) && event.prefs.computerUse.introduced === false);
    const mark = c.mark();
    await c.cmd('setPref', { key: 'computerUse', value: { allowAllApps: true } });
    await new Promise(r => setTimeout(r, 200));
    t.ok('変わらない値は流し直さない', !c.events.slice(mark).some(e => e.type === 'prefs'));
    let refused = null;
    try { await c.cmd('setPref', { key: 'computerUse', value: { enabled: 'yes' } }); } catch (e) { refused = e; }
    t.ok('形が違う値は断り、保存済みを変えない', refused && (await c.cmd('prefs'))?.computerUse?.enabled === true, String(refused?.message));
  } finally {
    c.close();
    await server.stop();
    await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}
