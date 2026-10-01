import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { decideApp, autoGrantKind, normalizeComputerUse, isUnattendedMode } from '../../core/computer-use/policy.mjs';
import { isForbiddenApp, isHighRiskApp } from '../../core/computer-use/apps.mjs';
import { computerMarker, computerDisplay, computerToolInput } from '../../core/computer-use/display.mjs';
import { fitScale, toPhysical, toImage, regionToPhysical, displayAt } from '../../core/computer-use/coords.mjs';
import { createShots, SHOT_ID } from '../../core/computer-use/shots.mjs';
import { FAKE_APPS } from '../../core/computer-use/driver.mjs';

export const name = 'computer-policy';
export const title = 'コンピューターの操作: アプリの判定の順・禁止の一覧・印の行・座標の写像・スクリーンショットの保存と上限';

const exe = (p, extra = {}) => ({ id: `exe:${p.toLowerCase().replaceAll('\\', '/')}`, kind: 'exe', name: p.split('\\').pop(), path: p, elevated: false, self: false, ...extra });
const aumid = (a, extra = {}) => ({ id: `aumid:${a}`, kind: 'aumid', name: a, aumid: a, elevated: false, self: false, ...extra });
const ASK = { scope: 'workspace', autonomy: 'ask' };
const BYPASS = { scope: 'full', autonomy: 'never' };
const notepad = FAKE_APPS.notepad;
// 常に許可の 1 行（設定の画面と同じ検査を通るので、id・name・kind が揃っている）
const row = a => ({ id: a.id, name: a.name, kind: a.kind });

export default async function(t) {
  // ---- 判定の順（docs/computer-use.md「判定の順」）
  const d = (over = {}) => decideApp({ app: notepad, prefs: {}, sessionApps: [], deniedThisTurn: new Set(), mode: ASK, ...over });
  t.ok('既定（何も許可していない）は聞く', d() === 'ask');
  t.ok('高リスク（エクスプローラー・設定・IDE・regedit）は警告付きで聞く', ['C:\\Windows\\explorer.exe', 'C:\\Windows\\regedit.exe', 'C:\\Windows\\System32\\taskmgr.exe', 'C:\\Program Files\\Microsoft VS Code\\Code.exe']
    .every(p => d({ app: exe(p) }) === 'ask-high') && d({ app: aumid('windows.immersivecontrolpanel_cw5n1h2txyewy!microsoft.windows.immersivecontrolpanel') }) === 'ask-high');
  t.ok('この会話で許可済みなら許可', d({ sessionApps: [notepad.id] }) === 'allow');
  t.ok('常に許可の一覧にあれば許可', d({ prefs: { computerUse: { alwaysAllowed: [row(notepad)] } } }) === 'allow');
  t.ok('すべて許可のスイッチで許可（高リスクも）', d({ prefs: { computerUse: { allowAllApps: true } } }) === 'allow'
    && d({ app: exe('C:\\Windows\\explorer.exe'), prefs: { computerUse: { allowAllApps: true } } }) === 'allow');
  t.ok('確認なし（範囲 full かつ自律 never）は聞かずに許可', d({ mode: BYPASS }) === 'allow');
  t.ok('範囲が workspace の「聞かずに進む」（Codex の全部自動）は聞く', d({ mode: { scope: 'workspace', autonomy: 'never' } }) === 'ask'
    && !isUnattendedMode({ scope: 'workspace', autonomy: 'never' }) && isUnattendedMode(BYPASS));
  t.ok('Antigravity はいつも聞かずに許可（承認モードが yolo しかない）', d({ agent: 'antigravity', mode: ASK }) === 'allow');
  t.ok('このターンで拒否済みなら、聞き直さずに denied', d({ deniedThisTurn: new Set([notepad.id]) }) === 'denied');
  t.ok('拒否は確認なし・すべて許可・常に許可より先に効く', d({ deniedThisTurn: new Set([notepad.id]), mode: BYPASS }) === 'denied'
    && d({ deniedThisTurn: new Set([notepad.id]), prefs: { computerUse: { allowAllApps: true } } }) === 'denied');
  const terminal = FAKE_APPS.terminal;
  t.ok('禁止のアプリは、確認なし・すべて許可・常に許可・Antigravity でも forbidden', ['forbidden'].every(want =>
    d({ app: terminal, mode: BYPASS }) === want && d({ app: terminal, prefs: { computerUse: { allowAllApps: true } } }) === want
    && d({ app: terminal, sessionApps: [terminal.id] }) === want && d({ app: terminal, agent: 'antigravity' }) === want
    && d({ app: terminal, prefs: { computerUse: { alwaysAllowed: [row(terminal)] } } }) === want));
  t.ok('禁止は拒否済みより先に効く（denied ではなく forbidden）', d({ app: terminal, deniedThisTurn: new Set([terminal.id]) }) === 'forbidden');
  t.ok('Pleiad 自身（self）は禁止', d({ app: FAKE_APPS.pleiad, mode: BYPASS }) === 'forbidden' && isForbiddenApp({ id: 'exe:c:/x/whatever.exe', self: true }));
  t.ok('アプリが分からない（null）は forbidden に倒す', d({ app: null }) === 'forbidden');

  // ---- 禁止の一覧
  const forbidden = [
    'C:\\Windows\\System32\\cmd.exe', 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', 'C:\\Program Files\\PowerShell\\7\\pwsh.exe', 'C:\\Windows\\System32\\conhost.exe',
    'C:\\Windows\\System32\\wsl.exe', 'C:\\Program Files\\Git\\usr\\bin\\bash.exe', 'C:\\Program Files\\Git\\git-bash.exe',
    'C:\\Program Files\\1Password\\app\\8\\1Password.exe', 'C:\\Program Files\\KeePassXC\\KeePassXC.exe', 'C:\\Program Files\\Bitwarden\\Bitwarden.exe',
    'C:\\Program Files\\Avast Software\\Avast\\AvastUI.exe', 'C:\\Windows\\System32\\consent.exe', 'C:\\Windows\\SystemApps\\Microsoft.LockApp_cw5n1h2txyewy\\LockApp.exe',
    'C:\\Windows\\SystemApps\\ShellExperienceHost_cw5n1h2txyewy\\ShellExperienceHost.exe', 'C:\\Windows\\SystemApps\\MicrosoftWindows.Client.CBS_cw5n1h2txyewy\\SearchHost.exe',
    'C:\\Windows\\SystemApps\\StartMenuExperienceHost.exe', 'C:\\Program Files\\Common Files\\microsoft shared\\ink\\TextInputHost.exe',
    'C:\\Users\\x\\AppData\\Local\\Programs\\claude\\claude.exe', 'C:\\Users\\x\\.codex\\bin\\codex.exe', 'C:\\Users\\x\\AppData\\Local\\agy\\agy.exe', 'C:\\Users\\x\\AppData\\Local\\Programs\\Pleiad\\Ply.exe',
  ];
  t.ok('ターミナル・パスワード管理・セキュリティソフト・Windows の内部・エージェント自身の exe は禁止', forbidden.every(p => isForbiddenApp(exe(p))), forbidden.filter(p => !isForbiddenApp(exe(p))).join(', '));
  const forbiddenAumid = ['Microsoft.WindowsTerminal_8wekyb3d8bbwe!App', 'Microsoft.LockApp_cw5n1h2txyewy!WindowsDefaultLockScreen', 'Microsoft.SecHealthUI_8wekyb3d8bbwe!SecHealthUI', 'AgileBits.1Password_abc!App', 'Claude_pzs8sxrjxfjjc!Claude', 'OpenAI.Codex_2p2nqsd0c76g0!App'];
  t.ok('AUMID の接頭辞でも禁止（Windows Terminal・ロック画面・Windows セキュリティ・パスワード管理・Claude・Codex）', forbiddenAumid.every(a => isForbiddenApp(aumid(a))), forbiddenAumid.filter(a => !isForbiddenApp(aumid(a))).join(', '));
  const ordinary = [exe('C:\\Windows\\System32\\notepad.exe'), exe('C:\\Program Files\\Microsoft Office\\root\\Office16\\EXCEL.EXE'), aumid('Microsoft.WindowsCalculator_8wekyb3d8bbwe!App'), exe('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe')];
  t.ok('ふつうのアプリ（メモ帳・Excel・電卓・Chrome）は禁止でも高リスクでもない', ordinary.every(a => !isForbiddenApp(a) && !isHighRiskApp(a)));
  t.ok('名前が似ているだけのアプリは巻き込まない（exe 名の完全一致・接頭辞で見る）', !isForbiddenApp(exe('C:\\Program Files\\Foo\\terminal-notes.exe')) && !isForbiddenApp(exe('C:\\Program Files\\Foo\\bashful.exe')));

  // ---- 確認なし・すべて許可の印（grant）
  t.ok('grant の種類: 確認なしは bypass、すべて許可は all、普通に許可済みは付けない', autoGrantKind({ mode: BYPASS, prefs: {}, app: notepad }) === 'bypass'
    && autoGrantKind({ mode: ASK, prefs: { computerUse: { allowAllApps: true } }, app: notepad }) === 'all'
    && autoGrantKind({ mode: ASK, prefs: { computerUse: { allowAllApps: true, alwaysAllowed: [row(notepad)] } }, app: notepad }) === null
    && autoGrantKind({ mode: ASK, prefs: {}, sessionApps: [notepad.id], app: notepad }) === null
    && autoGrantKind({ agent: 'antigravity', mode: ASK, prefs: {}, app: notepad }) === 'bypass');
  t.ok('prefs.computerUse は足りない項目を既定で埋める（enabled: true・allowAllApps: false・introduced: false・alwaysAllowed: []）',
    JSON.stringify(normalizeComputerUse(undefined)) === JSON.stringify({ enabled: true, allowAllApps: false, introduced: false, alwaysAllowed: [] })
    && normalizeComputerUse({ enabled: false }).enabled === false && normalizeComputerUse({ alwaysAllowed: [1, { id: 'a' }, row(notepad)] }).alwaysAllowed.length === 1);

  // ---- 印の行
  const line = computerMarker({ tool: 'left_click', state: 'ok', title: '保存を押す', app: 'メモ帳', display: 1, grant: undefined, reason: undefined });
  t.ok('印の行は [ply_computer] の後ろに 1 行の JSON（v は 1。undefined の項目は入れない）', line.startsWith('[ply_computer] {"v":1,') && !line.includes('\n') && !line.includes('grant') && JSON.parse(line.slice(15)).title === '保存を押す');
  const shot = 'a'.repeat(32);
  const shown = computerDisplay(`ディスプレイ 1・1460×821\n${computerMarker({ tool: 'screenshot', state: 'ok', title: '確かめる', shot, w: 1460, h: 821, display: 1 })}`);
  t.ok('computerDisplay: 本文は印の行を除き、images は /computer-shot/<id>.jpg、computer は v を除いた印',
    shown.text === 'ディスプレイ 1・1460×821' && shown.images.length === 1 && shown.images[0].url === `/computer-shot/${shot}.jpg` && shown.images[0].width === 1460 && shown.images[0].height === 821
    && shown.computer.v === undefined && shown.computer.tool === 'screenshot' && shown.computer.shot === shot);
  t.ok('撮影でない印は images が空', computerDisplay(`ok\n${computerMarker({ tool: 'type', state: 'ok', title: 't' })}`).images.length === 0);
  t.ok('印が無い・壊れている・v が 1 でないときは null', computerDisplay('ただの文') === null && computerDisplay('[ply_computer] {oops') === null
    && computerDisplay('[ply_computer] {"v":2,"tool":"x"}') === null && computerDisplay(undefined) === null);
  t.ok('shot が 32 桁の hex でなければ捨てる（配信の前の検査と同じ形）', computerDisplay(`x\n[ply_computer] {"v":1,"tool":"zoom","state":"ok","title":"t","shot":"../../etc/passwd"}`).images.length === 0
    && computerDisplay(`x\n[ply_computer] {"v":1,"tool":"zoom","state":"ok","title":"t","shot":"../../etc/passwd"}`).computer.shot === undefined);
  t.ok('知らない項目は残し、読む側が無視できる', computerDisplay(`x\n[ply_computer] {"v":1,"tool":"a","state":"ok","title":"t","future":true}`).computer.future === true);
  t.ok('stopped の印は reason を持つ', computerDisplay(`止めた\n${computerMarker({ tool: 'type', state: 'stopped', reason: 'escape', title: '金額を入力' })}`).computer.reason === 'escape');
  const input = computerToolInput('mcp__ply_computer__type', { text: 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789', title: '入力' });
  t.ok('type の入力は秘密らしいものを伏せる（画面へ流す tool.start 用）。ほかのツールは素通し', !input.text.includes('abcdefghijklmnopqrstuvwxyz') && input.title === '入力'
    && computerToolInput('mcp__ply_computer__key', { text: 'ctrl+s' }).text === 'ctrl+s'
    && computerToolInput('type', { text: 'こんにちは' }).text === 'こんにちは');
  const batch = computerToolInput('mcp__ply_computer__computer_batch', { actions: [{ action: 'type', text: 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789' }, { action: 'key', text: 'Return' }] });
  t.ok('computer_batch の中の type も伏せる', !batch.actions[0].text.includes('abcdefghijklmnopqrstuvwxyz') && batch.actions[1].text === 'Return');

  // ---- 座標（1920×1080 は 1460×821。物理から画像へ ×scale、戻すときは ÷scale して round）
  const s = fitScale(1920, 1080);
  t.ok('倍率: 1920×1080 は 1460×821 になる（1.2MP・長辺 1568 の小さいほう）', Math.floor(1920 * s) === 1460 && Math.floor(1080 * s) === 821, String(s));
  t.ok('倍率: 小さい画面は拡大しない（1.0）。広い画面は長辺 1568 に収まる', fitScale(800, 600) === 1 && Math.max(3840 * fitScale(3840, 2160), 2160 * fitScale(3840, 2160)) <= 1568.0001
    && 3840 * 2160 * fitScale(3840, 2160) ** 2 <= 1_200_000.5);
  const display2 = { scale: s, origin: { x: 1920, y: 0 }, width: 1460, height: 821 };
  const phys = toPhysical(display2, 730, 410);
  t.ok('画像の座標 → 物理座標（原点を足して ÷scale を round）', phys.x === 1920 + Math.round(730 / s) && phys.y === Math.round(410 / s));
  t.ok('範囲の外は丸めずに null（幅・高さちょうども外）', toPhysical(display2, -1, 10) === null && toPhysical(display2, 1460, 10) === null && toPhysical(display2, 10, 821) === null
    && toPhysical(display2, 1459.9, 820.9) !== null && toPhysical(display2, NaN, 1) === null && toPhysical(display2, '5', 5) === null);
  const back = toImage(display2, phys.x, phys.y);
  t.ok('物理 → 画像で往復しても 1 画素以内', Math.abs(back.x - 730) <= 1 && Math.abs(back.y - 410) <= 1);
  t.ok('負の原点（左のモニター）でも写る', (() => { const left = { scale: 1, origin: { x: -1920, y: 0 }, width: 1920, height: 1080 }; const p = toPhysical(left, 10, 20); return p.x === -1910 && p.y === 20; })());
  const region = regionToPhysical(display2, [100, 50, 400, 250]);
  t.ok('zoom の範囲を物理の { x, y, width, height } へ。範囲外・逆順・不正は null', region.x === 1920 + Math.round(100 / s) && region.width === Math.round(400 / s) - Math.round(100 / s)
    && regionToPhysical(display2, [100, 50, 1461, 250]) === null && regionToPhysical(display2, [400, 50, 100, 250]) === null && regionToPhysical(display2, [1, 2, 3]) === null);
  t.ok('点を含むディスプレイ', displayAt([{ id: 'a', bounds: { x: 0, y: 0, width: 100, height: 100 } }, { id: 'b', bounds: { x: 100, y: 0, width: 100, height: 100 } }], 150, 10).id === 'b'
    && displayAt([{ id: 'a', bounds: { x: 0, y: 0, width: 100, height: 100 } }], 500, 5) === null);

  // ---- スクリーンショットの保存
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-shots-'));
  try {
    let at = 1000;
    const jpeg = n => Buffer.alloc(n, 7);
    const shots = createShots({ dataDir: dir, perSession: 3, totalBytes: 100, now: () => at++ });
    const id1 = await shots.save('s1', jpeg(10));
    t.ok('保存: id は 32 桁の hex（乱数 128bit）。JPEG は computer-use/shots/<id>.jpg、索引は shots.json', SHOT_ID.test(id1)
      && (await fs.readFile(path.join(dir, 'computer-use', 'shots', `${id1}.jpg`))).length === 10
      && JSON.parse(await fs.readFile(path.join(dir, 'computer-use', 'shots.json'), 'utf8')).shots[id1].session === 's1');
    t.ok('配信用の読み出し: 形の違う id・索引に無い id は null（パスの文字列を通さない）', (await shots.read(id1)).length === 10 && (await shots.read('../shots')) === null
      && (await shots.read('0'.repeat(32))) === null && (await shots.read(`${id1}.jpg`)) === null);
    const ids = [id1];
    for (let i = 0; i < 3; i++) ids.push(await shots.save('s1', jpeg(10)));
    t.ok('1 会話の上限を超えたら古い順に消す（ファイルも）', (await shots.read(ids[0])) === null && (await shots.read(ids[1])) !== null
      && Object.keys(await shots.list()).length === 3 && await fs.access(path.join(dir, 'computer-use', 'shots', `${ids[0]}.jpg`)).then(() => false, () => true));
    const other = await shots.save('s2', jpeg(10));
    t.ok('別の会話の分は巻き込まない', (await shots.read(other)) !== null && Object.values(await shots.list()).filter(v => v.session === 's1').length === 3);
    const big = await shots.save('s2', jpeg(61));
    const left = await shots.list();
    t.ok('全体の上限（バイト）を超えたら全体で古い順に消す', Object.values(left).reduce((n, v) => n + v.bytes, 0) <= 100 && (await shots.read(big)) !== null && (await shots.read(ids[1])) === null, JSON.stringify(Object.values(left).map(v => v.bytes)));
    const removed = await shots.removeSession('s2');
    t.ok('会話を消したら、その会話の分を消す', removed === 2 && (await shots.read(big)) === null && (await shots.read(other)) === null && Object.values(await shots.list()).every(v => v.session !== 's2'));
    const again = createShots({ dataDir: dir });
    t.ok('索引は再起動をまたいで読める', (await again.list())[ids[3]]?.session === 's1' && (await again.read(ids[3])) !== null);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
}
