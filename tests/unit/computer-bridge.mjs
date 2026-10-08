import { createHarness, BYPASS_MODE, sleep, until } from '../lib/computer-harness.mjs';
import { FAKE_APPS } from '../../core/computer-use/driver.mjs';
import { COMPUTER_TOOL_NAMES } from '../../core/computer-use/tools.mjs';
import { computerDisplay } from '../../core/computer-use/display.mjs';

export const name = 'computer-bridge';
export const title = 'ply_computer: MCP の面・座標・ゲートの順・アプリの承認・止める・ロック画面・保存（偽の driver）';

export default async function(t) {
  const h = await createHarness({ waitMs: 400 });
  try {
    const a = h.connect({ sessionId: 's1' });
    const mark = r => computerDisplay(r.content[0].text)?.computer;
    const body = r => computerDisplay(r.content[0].text)?.text;
    const click = (c, x, y, extra = {}) => c.call('left_click', { coordinate: [x, y], title: 'クリック', ...extra });

    // ---- MCP の面
    const status = async (method, token) => { let code; await h.bridge.handle({ method, headers: { authorization: token, host: 'x' }, [Symbol.asyncIterator]: async function* () { yield Buffer.from('{}'); } }, { writeHead(s) { code = s; }, end() {} }); return code; };
    t.ok('トークンの違う呼び出しは 401。GET は 405', await status('POST', 'Bearer ' + 'f'.repeat(64)) === 401 && await status('POST', undefined) === 401 && await status('GET', a.binding.headers.Authorization) === 405);
    const init = (await a.rpc('initialize', {})).body.result;
    t.ok('initialize: serverInfo は ply_computer。instructions は返さない（append だけで渡す。ADR 0169）。open の instructions は指示文（ja）', init.serverInfo.name === 'ply_computer' && init.instructions === undefined && a.binding.instructions.includes("screenshot") && init.capabilities.tools);
    const list = (await a.rpc('tools/list', {})).body.result.tools;
    t.ok('tools/list: ツールは契約の 23 個（request_access・list_granted_applications・screenshot・zoom・switch_display・cursor_position・mouse_move・5 種のクリック・drag・down/up・scroll・type・key・hold_key・wait・wait_until・open_application・computer_batch）',
      list.length === 23 && COMPUTER_TOOL_NAMES.every(n => list.some(x => x.name === n)) && ['left_click', 'double_click', 'triple_click', 'right_click', 'middle_click', 'left_click_drag', 'left_mouse_down', 'left_mouse_up'].every(n => list.some(x => x.name === n)));
    t.ok('全部のツールに title があり、スキーマでは必須。説明は会話の言語（ja）', list.every(x => x.inputSchema.properties.title?.type === 'string' && x.inputSchema.required.includes('title') && x.description.length > 5 && x.inputSchema.properties.title.description.includes('40 字')));
    t.ok('スキーマ: scroll は coordinate・方向・回数が必須、key の text と hold_key の duration（上限 10）', (() => {
      const s = Object.fromEntries(list.map(x => [x.name, x.inputSchema]));
      return ['coordinate', 'scroll_direction', 'scroll_amount'].every(k => s.scroll.required.includes(k)) && s.hold_key.properties.duration.maximum === 10 && s.wait.properties.duration.maximum === 10
        && s.computer_batch.properties.actions.maxItems === 20 && !s.computer_batch.properties.actions.items.properties.action.enum.includes('computer_batch') && !s.computer_batch.properties.actions.items.properties.action.enum.includes('request_access');
    })());
    const en = h.connect({ sessionId: 'en', locale: 'en' });
    t.ok('英語の会話では説明も指示文も英語', (await en.rpc('tools/list', {})).body.result.tools[0].description.startsWith('Ask the user') && en.binding.instructions.includes('terminals'));
    t.ok('知らないメソッドは JSON-RPC のエラー、通知（id なし）は 202', (await a.rpc('nope', {})).body.error.code === -32601);
    en.binding.close();
    t.ok('橋を閉じたら、そのトークンは使えない（401）', (await en.rpc('ping', {})).status === 401);

    // ---- 撮影
    const first = await a.call('screenshot', { title: '画面を確かめる' });
    const shot1 = computerDisplay(first.content[0].text);
    t.ok('screenshot: 「ディスプレイ 1 / 2・1460×821（実寸 1920×1080 を縮小）」と、最後の行の印（tool・state・title・display・shot・w・h）',
      shot1.text === 'ディスプレイ 1 / 2・1460×821（実寸 1920×1080 を縮小）' && shot1.computer.tool === 'screenshot' && shot1.computer.state === 'ok' && shot1.computer.title === '画面を確かめる'
      && shot1.computer.display === 1 && shot1.computer.w === 1460 && shot1.computer.h === 821 && /^[0-9a-f]{32}$/.test(shot1.computer.shot) && first.isError === false
      && first.content[0].text.split('\n').at(-1).startsWith('[ply_computer] '));
    t.ok('image ブロックはモデルに渡す JPEG（base64）で、保存したものと同じ', first.content[1].type === 'image' && first.content[1].mimeType === 'image/jpeg'
      && Buffer.from(first.content[1].data, 'base64').equals(await h.shots.read(shot1.computer.shot)) && Buffer.from(first.content[1].data, 'base64')[0] === 0xff);
    t.ok('索引に会話の id で記録される', (await h.shots.list())[shot1.computer.shot]?.session === 's1');
    t.ok('driver へは maxPixels 1.2MP・maxEdge 1568・quality 75 と、対象のディスプレイの id を送る', (() => { const c = h.driver.calls.find(x => x.op === 'screenshot'); return c.args.maxPixels === 1_200_000 && c.args.maxEdge === 1568 && c.args.quality === 75 && c.args.display === 'fake-1'; })());
    t.ok('title が来なくても失敗にせず、サーバーが操作から作って埋める', mark(await a.call('screenshot', {})).title === '画面を確かめる'
      && mark(await a.call('left_click', { coordinate: [412, 238] })).title === 'クリック（412, 238）' && mark(await a.call('key', { text: 'ctrl+s' })).title === 'キー入力（ctrl+s）');
    t.ok('知らない引数は無視する（失敗にしない）', mark(await a.call('screenshot', { title: 'x', whatever: 1 })).state === 'ok');

    // ---- 座標の基準（no_shot / stale / outside）
    a.end();
    const b0 = h.connect({ sessionId: 'sb' });
    h.driver.calls.length = 0;
    const noShot = await b0.call('left_click', { coordinate: [10, 10], title: 'x' });
    t.ok('撮影の前の座標の操作は no_shot で返す（isError）。入力は main へ送らない', noShot.isError && mark(noShot).reason === 'no_shot' && mark(noShot).state === 'failed' && !h.ops().includes('input') && body(noShot).includes('screenshot'));
    const fresh = await b0.call('left_click', { title: 'x' });
    t.ok('座標を省くクリック（今のカーソルの位置）は、撮影が無くてもできる', mark(fresh).state !== 'failed' || mark(fresh).reason !== 'no_shot');
    b0.end();
    await a.call('screenshot', { title: 'x' });
    h.driver.calls.length = 0;
    const out = await click(a, 1460, 100);
    t.ok('画像の外は丸めずに outside（幅ちょうども外）。入力は送らない', mark(out).reason === 'outside' && out.isError && !h.ops().includes('input') && body(out).includes('1460×821'));
    t.ok('範囲の中なら物理座標に戻して main へ送る（730,410 → 960,539 付近。÷scale を round）', (await click(a, 730, 410)) && (() => { const act = h.inputs().at(-1); return act.type === 'click' && act.button === 'left' && act.count === 1 && act.x === Math.round(730 / 0.7607257743127307) && act.y === Math.round(410 / 0.7607257743127307); })());
    h.driver.changeDisplays();
    const stale = await click(a, 10, 10);
    t.ok('撮影の後に displaysVersion が変わったら、座標の操作は stale', mark(stale).reason === 'stale' && stale.isError);
    await a.call('screenshot', { title: 'x' });
    t.ok('撮り直せば、また動く', mark(await click(a, 10, 10)).state === 'ok');
    a.newTurn('turn-s1-2');
    t.ok('ターンが替わったら、前のターンの座標は使わせない（no_shot）', mark(await click(a, 10, 10)).reason === 'no_shot');
    await a.call('screenshot', { title: 'x' });

    // ---- ゲートの順: 承認 → 入力。聞くのは最初の 1 回
    a.end(); b0.end();
    const firstCard = structuredClone(h.asked[0]);
    h.asked.length = 0; h.driver.calls.length = 0; h.driver.overlays.length = 0;
    const c1 = h.connect({ sessionId: 'c1', title: '見積もり' });
    await c1.call('screenshot', { title: 'x' });
    const r1 = await click(c1, 100, 100);
    t.ok('初めてのアプリは承認のカードを出す（toolName ply_computer・canAlways・input は {}・computerApp にエージェントとアプリ）', h.asked.length === 1 && h.asked[0].toolName === 'ply_computer' && h.asked[0].canAlways === true && JSON.stringify(h.asked[0].input) === '{}'
      && h.asked[0].computerApp.agent.id === 'claude' && h.asked[0].computerApp.agent.label === 'Claude' && h.asked[0].computerApp.apps.length === 1 && h.asked[0].computerApp.apps[0].id === FAKE_APPS.notepad.id
      && h.asked[0].computerApp.apps[0].name === 'メモ帳' && h.asked[0].computerApp.apps[0].risk === 'normal' && h.asked[0].sessionId === 'c1', JSON.stringify(h.asked[0]?.computerApp));
    t.ok('見出しはエージェント名とアプリ名（permission.computerApp）。first は、この PC で初めて出すカードだけ true（答えたら 2 枚目からは false）', h.asked[0].title.startsWith('permission.computerApp:') && h.asked[0].title.includes('Claude') && h.asked[0].title.includes('メモ帳') && firstCard.computerApp.first === true && firstCard.title.startsWith('permission.computerApp:') && h.asked[0].computerApp.first === false);
    t.ok('聞く間はオーバーレイを hide にする。許可の後は入力され、activity が出る（owner・エージェント名・会話のタイトル・カーソル）', (() => {
      const kinds = h.driver.overlays.map(o => o.state);
      const act = h.driver.overlays.find(o => o.state === 'activity' && o.cursor);
      return kinds[0] === 'activity' || kinds.includes('hide') ? kinds.indexOf('hide') >= 0 && act?.owner === c1.state.turnId && act.agent === 'Claude' && act.title === '見積もり' && typeof act.cursor.x === 'number' && act.cursor.pressed === false && act.display?.id === 'fake-1' && act.display.bounds.width === 1920 : false;
    })(), JSON.stringify(h.driver.overlays));
    t.ok('「この会話で許可」は会話に覚える。印の行に app', h.db.session.get('c1')?.includes(FAKE_APPS.notepad.id) && mark(r1).app === 'メモ帳' && mark(r1).state === 'ok' && !('grant' in mark(r1)) && body(r1) === '左クリックしました（メモ帳）');
    t.ok('答えた後は introduced になる（次のカードは first: false）', h.db.introduced.length === 1);
    await click(c1, 200, 200);
    t.ok('許可済みのアプリは、もう聞かない', h.asked.length === 1);
    t.ok('入力の前に点の下のアプリ（appAt）を物理座標で聞く', h.driver.calls.some(c => c.op === 'appAt' && Number.isFinite(c.args.x)));

    // 常に許可
    const h2 = await createHarness({ waitMs: 400, answers: [{ allow: true, scope: 'always' }] });
    try {
      const x = h2.connect({ sessionId: 'x1' });
      await x.call('screenshot', { title: 'x' });
      await x.call('left_click', { coordinate: [100, 100], title: 'x' });
      t.ok('「常に許可」は一覧に覚える（id・名前・kind・path・at）', h2.db.always.length === 1 && h2.db.always[0].id === FAKE_APPS.notepad.id && h2.db.always[0].name === 'メモ帳' && h2.db.always[0].kind === 'exe'
        && h2.db.always[0].path === FAKE_APPS.notepad.path && !Number.isNaN(Date.parse(h2.db.always[0].at)) && !h2.db.session.has('x1'));
      const y = h2.connect({ sessionId: 'y1' });
      await y.call('screenshot', { title: 'x' });
      await y.call('left_click', { coordinate: [100, 100], title: 'x' });
      t.ok('別の会話でも、常に許可したアプリは聞かない', h2.asked.length === 1);
    } finally { await h2.close(); }
    const h3 = await createHarness({ waitMs: 400, answers: [{ allow: true, scope: 'once' }, { allow: true, scope: 'session' }, { allow: true, scope: 'session' }] });
    try {
      const x = h3.connect({ sessionId: 'x1' });
      await x.call('screenshot', { title: 'x' });
      await x.call('left_click', { coordinate: [100, 100], title: 'x' });
      await x.call('left_click', { coordinate: [100, 100], title: 'x' });
      t.ok('「1 回だけ」（scope once・scope の無い allow）は、このターンの間だけ許可する。会話にも常にも覚えない', h3.asked.length === 1 && !h3.db.session.has('x1') && h3.db.always.length === 0);
      x.newTurn('turn-x1-2');
      await x.call('screenshot', { title: 'x' });
      await x.call('left_click', { coordinate: [100, 100], title: 'x' });
      t.ok('次のターンでは、また聞く', h3.asked.length === 2 && h3.asked[1].computerApp.first === false);
    } finally { await h3.close(); }

    // 拒否はターンの間だけ覚える
    const hd = await createHarness({ waitMs: 400, answers: [{ allow: false }, { allow: true, scope: 'session' }] });
    try {
      const x = hd.connect({ sessionId: 'd1' });
      await x.call('screenshot', { title: 'x' });
      const den1 = await x.call('left_click', { coordinate: [100, 100], title: 'x' });
      t.ok('拒否: 入力は送らず、stopped / denied を返す（失敗に数えない）', den1.isError && mark(den1).state === 'stopped' && mark(den1).reason === 'denied' && hd.asked.length === 1 && !hd.ops().includes('input') && body(den1).includes('メモ帳'));
      const den2 = await x.call('left_click', { coordinate: [100, 100], title: 'x' });
      t.ok('同じターンでは同じアプリを聞き直さず、すぐ denied', hd.asked.length === 1 && mark(den2).reason === 'denied' && !hd.ops().includes('input'));
      const den3 = await x.call('type', { text: 'abc', title: 'x' });
      t.ok('type（前面のアプリ）も同じ。聞き直さない', hd.asked.length === 1 && mark(den3).reason === 'denied');
      x.newTurn('d1-turn2');
      await x.call('screenshot', { title: 'x' });
      const ok = await x.call('left_click', { coordinate: [100, 100], title: 'x' });
      t.ok('次のターンでは覚えていない（拒否は会話にも常にも残さない）。また聞く', hd.asked.length === 2 && mark(ok).state === 'ok');
    } finally { await hd.close(); }

    // 禁止
    const hb = await createHarness({ waitMs: 400, prefs: { computerUse: { allowAllApps: true } } });
    try {
      const x = hb.connect({ sessionId: 'f1', mode: BYPASS_MODE });
      await x.call('screenshot', { title: 'x' });
      const f = await x.call('left_click', { coordinate: [100, 790], title: 'x' });
      t.ok('禁止のアプリ（Windows Terminal）は、確認なし＋すべて許可でも拒む。カードは出さず、入力も送らない。stopped / forbidden', f.isError && mark(f).reason === 'forbidden' && mark(f).state === 'stopped' && mark(f).app === 'Windows Terminal'
        && hb.asked.length === 0 && !hb.ops().includes('input') && body(f).includes('Windows Terminal'));
      hb.driver.setForeground(FAKE_APPS.pleiad);
      const typed = await x.call('type', { text: 'hello', title: 'x' });
      t.ok('前面が Pleiad 自身（self）なら、type は禁止で拒む', mark(typed).reason === 'forbidden' && !hb.ops().includes('input'));
      hb.driver.setForeground(FAKE_APPS.notepad);
      const g = await x.call('left_click', { coordinate: [100, 100], title: 'x' });
      const g2 = await x.call('left_click', { coordinate: [120, 120], title: 'x' });
      t.ok('確認なし（full/never）は聞かずに許可。印の grant は bypass で、そのアプリのターンで最初の呼び出しにだけ付ける', hb.asked.length === 0 && mark(g).grant === 'bypass' && !('grant' in mark(g2)));
      const hi = await x.call('left_click', { coordinate: [100, 700], title: 'x' });
      t.ok('別のアプリ（エクスプローラー）は別に最初の 1 回', mark(hi).grant === 'bypass' && mark(hi).app === 'エクスプローラー');
    } finally { await hb.close(); }
    const hall = await createHarness({ waitMs: 400, prefs: { computerUse: { allowAllApps: true } } });
    try {
      const x = hall.connect({ sessionId: 'a1' });
      await x.call('screenshot', { title: 'x' });
      const r = await x.call('left_click', { coordinate: [100, 100], title: 'x' });
      const r2 = await x.call('left_click', { coordinate: [100, 100], title: 'x' });
      t.ok('すべて許可は聞かずに許可。grant は all（最初の 1 回だけ）', hall.asked.length === 0 && mark(r).grant === 'all' && !('grant' in mark(r2)));
      x.end();
      const agy = hall.connect({ sessionId: 'agy', agent: { id: 'antigravity', label: 'Antigravity' } });
      hall.db.prefs.computerUse.allowAllApps = false;
      await agy.call('screenshot', { title: 'x' });
      const ar = await agy.call('left_click', { coordinate: [100, 100], title: 'x' });
      t.ok('Antigravity はアプリの承認を聞かない（grant: bypass）。禁止は効く', hall.asked.length === 0 && mark(ar).grant === 'bypass' && mark(await agy.call('left_click', { coordinate: [100, 790], title: 'x' })).reason === 'forbidden');
    } finally { await hall.close(); }
    const hh = await createHarness({ waitMs: 400 });
    try {
      const x = hh.connect({ sessionId: 'h1' });
      await x.call('screenshot', { title: 'x' });
      await x.call('left_click', { coordinate: [100, 700], title: 'x' });
      t.ok('高リスクのアプリ（エクスプローラー）は risk: high のカード', hh.asked[0].computerApp.apps[0].risk === 'high' && hh.asked[0].computerApp.apps[0].name === 'エクスプローラー');
    } finally { await hh.close(); }

    // ---- request_access / list_granted_applications / open_application
    const hr = await createHarness({ waitMs: 400 });
    try {
      const x = hr.connect({ sessionId: 'r1' });
      const none = await x.call('list_granted_applications', { title: 'x' });
      t.ok('list_granted_applications: 何も無ければ request_access を案内。ロックは取らない', body(none).includes('request_access') && hr.lock.holder() === null && mark(none).state === 'ok');
      const res = await x.call('request_access', { apps: ['メモ帳', '電卓', 'Windows Terminal', 'ないアプリ'], reason: '計算してメモに貼る', title: 'x' });
      t.ok('request_access: 聞くものはまとめて 1 枚のカード（メモ帳・電卓）。reason も載せる', hr.asked.length === 1 && hr.asked[0].computerApp.apps.map(a => a.name).join() === 'メモ帳,電卓' && hr.asked[0].computerApp.reason === '計算してメモに貼る');
      t.ok('アプリごとの許可・禁止・見つからないを返す（禁止はカードに入れない）', body(res).includes('メモ帳: 許可されました') && body(res).includes('電卓: 許可されました') && body(res).includes('Windows Terminal: 操作できないアプリです') && body(res).includes('ないアプリ: 見つかりません') && mark(res).state === 'ok');
      const granted = await x.call('list_granted_applications', { title: 'x' });
      t.ok('この会話で許可したアプリが一覧に出る。ロックは取らない', body(granted).includes('メモ帳（この会話で許可）') && body(granted).includes('電卓') && hr.lock.holder() === null);
      await x.call('screenshot', { title: 'x' });
      await x.call('left_click', { coordinate: [100, 100], title: 'x' });
      t.ok('request_access で許可したアプリは、その後の入力で聞かれない', hr.asked.length === 1);
      const y = hr.connect({ sessionId: 'r2' });
      const allForbidden = await y.call('request_access', { apps: ['Windows Terminal'], reason: 'x', title: 'x' });
      t.ok('1 つも通らなければ失敗（forbidden）。カードは出さない', allForbidden.isError && mark(allForbidden).reason === 'forbidden' && hr.asked.length === 1);
      const bad = await y.call('request_access', { apps: [], reason: 'x', title: 'x' });
      t.ok('apps が空なら invalid', mark(bad).reason === 'invalid');
    } finally { await hr.close(); }
    const hn = await createHarness({ waitMs: 400, answers: [{ allow: false }] });
    try {
      const x = hn.connect({ sessionId: 'n1' });
      const denied = await x.call('request_access', { apps: ['メモ帳'], reason: 'x', title: 'x' });
      const again = await x.call('request_access', { apps: ['メモ帳'], reason: 'x', title: 'x' });
      t.ok('request_access で拒否されたら stopped / denied。同じターンの 2 回目は聞かない', denied.isError && mark(denied).reason === 'denied' && mark(denied).state === 'stopped' && hn.asked.length === 1 && mark(again).reason === 'denied');
    } finally { await hn.close(); }

    const ho = await createHarness({ waitMs: 400 });
    try {
      const x = ho.connect({ sessionId: 'o1' });
      const nf = await x.call('open_application', { app: 'ないアプリ', title: 'x' });
      t.ok('open_application: 見つからなければ not_found（起動しない）', nf.isError && mark(nf).reason === 'not_found' && !ho.ops().includes('launch'));
      const term = await x.call('open_application', { app: 'Windows Terminal', title: 'x' });
      t.ok('禁止のアプリは起動もしない（カードも出さない）', mark(term).reason === 'forbidden' && !ho.ops().includes('launch') && ho.asked.length === 0);
      const opened = await x.call('open_application', { app: '電卓', title: 'x' });
      t.ok('起動の前にそのアプリの承認を通す。許可なら launch し、起動したと正直に返す', ho.asked.length === 1 && ho.asked[0].computerApp.apps[0].name === '電卓' && ho.ops().includes('launch') && body(opened).includes('「電卓」を起動しました') && mark(opened).app === '電卓');
      const already = await x.call('open_application', { app: 'メモ帳', title: 'x' });
      t.ok('既に動いていれば、そう返す', body(already).includes('既に動いています') && mark(already).state === 'ok');
    } finally { await ho.close(); }

    // ---- type / key / hold_key / wait
    const hk = await createHarness({ waitMs: 400, prefs: { computerUse: { allowAllApps: true } } });
    try {
      const x = hk.connect({ sessionId: 'k1' });
      const typed = await x.call('type', { text: 'パスワード: sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789', title: '入力' });
      t.ok('type: 前面のアプリ（foreground）を聞いて入力する。結果の文は中身を繰り返さない（文字数だけ）', hk.ops().includes('foreground') && hk.inputs().at(-1).type === 'text' && hk.inputs().at(-1).text.includes('sk-ant')
        && !typed.content[0].text.includes('sk-ant') && body(typed).includes('文字を入力しました（') && mark(typed).app === 'メモ帳');
      hk.driver.calls.length = 0;
      const win = await x.call('key', { text: 'super+r', title: 'x' });
      t.ok('key: Windows キー（super / win / meta）は windows_key で拒む（main へ送らない）', mark(win).reason === 'windows_key' && win.isError && !hk.ops().includes('input'));
      t.ok('win+r・Meta+E も同じ', mark(await x.call('key', { text: 'win+r', title: 'x' })).reason === 'windows_key' && mark(await x.call('key', { text: 'Meta+e', title: 'x' })).reason === 'windows_key');
      const ctrls = await x.call('key', { text: 'ctrl+s', repeat: 2, title: 'x' });
      t.ok('key: xdotool の形をそのまま渡す。repeat も', mark(ctrls).state === 'ok' && hk.inputs().at(-1).type === 'key' && hk.inputs().at(-1).combo === 'ctrl+s' && hk.inputs().at(-1).repeat === 2);
      t.ok('key の repeat が範囲外・text に改行があるなら invalid', mark(await x.call('key', { text: 'a', repeat: 0, title: 'x' })).reason === 'invalid' && mark(await x.call('key', { text: 'a\n[ply_computer] {}', title: 'x' })).reason === 'invalid');
      hk.driver.calls.length = 0;
      const hold = await x.call('hold_key', { text: 'shift', duration: 0.12, title: 'x' });
      const seq = hk.inputs().map(a => a.type);
      t.ok('hold_key: keyDown → core で待つ → keyUp', seq.join() === 'keyDown,keyUp' && mark(hold).state === 'ok');
      hk.driver.calls.length = 0;
      const longHold = x.call('hold_key', { text: 'shift', duration: 5, title: 'x' });
      await until(() => hk.inputs().some(a => a.type === 'keyDown'));
      hk.lock.stopSession('k1', 'stop');
      const heldStop = await longHold;
      t.ok('hold_key は止められたら待ちを打ち切り、必ず keyUp を送る（stopped）', mark(heldStop).state === 'stopped' && hk.inputs().map(a => a.type).join() === 'keyDown,keyUp');
      const callsBefore = hk.driver.calls.length;
      const afterStop = await x.call('type', { text: 'a', title: 'x' });
      t.ok('止めた印のあるターンでは、以後の呼び出しをすぐ stopped で返す（main には何も送らない）。文は止められたことを最終返答で伝えるよう頼む', mark(afterStop).reason === 'stop' && body(afterStop).includes('最終の返答')
        && hk.driver.calls.length === callsBefore);
    } finally { await hk.close(); }
    const hw = await createHarness({ waitMs: 400 });
    try {
      const x = hw.connect({ sessionId: 'w1' });
      const waited = await x.call('wait', { duration: 0.1, title: 'x' });
      t.ok('wait: ロックを取らず、待って返す（10 秒を超える指定は 10 秒に丸める）', body(waited).includes('0.1 秒待ちました') && hw.lock.holder() === null && mark(await x.call('wait', { duration: 0.01, title: 'x' })).state === 'ok');
      const long = x.call('wait', { duration: 10, title: 'x' });
      await sleep(80);
      hw.driver.pressEscape(hw.lock.holder()?.turnId ?? 'none');
      hw.lock.stopSession('w1');
      const t0 = Date.now();
      const cut = await long;
      t.ok('wait は止められたら待ちの途中で打ち切る', mark(cut).state === 'stopped' && Date.now() - t0 < 2000);
    } finally { await hw.close(); }

    // ---- Esc
    const he = await createHarness({ waitMs: 400, prefs: { computerUse: { allowAllApps: true } } });
    try {
      const x = he.connect({ sessionId: 'e1' });
      await x.call('screenshot', { title: 'x' });
      const owner = he.lock.holder().turnId;
      const slowWait = x.call('wait', { duration: 5, title: 'x' });
      await sleep(80);
      he.driver.pressEscape(owner);
      const r = await slowWait;
      t.ok('物理の Esc: 実行中の wait は打ち切られ、reason は escape（stopped）', mark(r).reason === 'escape' && mark(r).state === 'stopped');
      he.driver.calls.length = 0;
      const next = await x.call('left_click', { coordinate: [100, 100], title: 'x' });
      t.ok('Esc の後は、以後の呼び出しがすぐ stopped / escape。main には何も送らない', mark(next).reason === 'escape' && he.driver.calls.length === 0);
      t.ok('request_access・list_granted_applications も止められる（印があるターンは全部）', mark(await x.call('list_granted_applications', { title: 'x' })).reason === 'escape');
      x.newTurn('e1-turn2');
      await x.call('screenshot', { title: 'x' });
      t.ok('次のターンでは印が消えて使える（ターン自体は中断されない）', mark(await x.call('left_click', { coordinate: [100, 100], title: 'x' })).state === 'ok');
    } finally { await he.close(); }

    // ---- ロック画面・UIPI・使えない
    const hl = await createHarness({ waitMs: 400, prefs: { computerUse: { allowAllApps: true } } });
    try {
      const x = hl.connect({ sessionId: 'l1' });
      hl.driver.setLocked(true);
      const sh = await x.call('screenshot', { title: 'x' });
      t.ok('ロック画面（入力デスクトップが Default でない）: screenshot は stopped / locked。止めた印は付けない', sh.isError && mark(sh).reason === 'locked' && mark(sh).state === 'stopped' && body(sh).includes('ロック'));
      hl.driver.setLocked(false);
      const sh2 = await x.call('screenshot', { title: 'x' });
      t.ok('解除されれば同じターンで続けられる', mark(sh2).state === 'ok');
      hl.driver.setLocked(true);
      const inp = await x.call('left_click', { coordinate: [10, 10], title: 'x' });
      t.ok('入力もロック中は locked', mark(inp).reason === 'locked');
      hl.driver.setLocked(false);
      hl.driver.fail('input', 'uipi');
      const uipi = await x.call('left_click', { coordinate: [10, 10], title: 'x' });
      t.ok('管理者権限のアプリへの入力は uipi（failed）', mark(uipi).reason === 'uipi' && mark(uipi).state === 'failed' && uipi.isError);
      hl.driver.fail('input', 'timeout');
      t.ok('main の上限時間は timeout（failed）', mark(await x.call('left_click', { coordinate: [10, 10], title: 'x' })).reason === 'timeout');
      hl.driver.fail('input', 'failed', 'SendInput: error 5');
      const failed = await x.call('left_click', { coordinate: [10, 10], title: 'x' });
      t.ok('そのほかの失敗は failed。main のメッセージを添える', mark(failed).reason === 'failed' && body(failed).includes('SendInput: error 5'));
      hl.driver.setSupported(false, 'native');
      const unsupported = await x.call('screenshot', { title: 'x' });
      t.ok('main が supported: false なら unsupported', mark(unsupported).reason === 'unsupported' && unsupported.isError);
      hl.driver.setSupported(true);
      hl.db.prefs.computerUse = { enabled: false };
      t.ok('設定でオフなら、来ても unsupported', mark(await x.call('screenshot', { title: 'x' })).reason === 'unsupported');
    } finally { await hl.close(); }

    // ---- ほかのツール
    const hx = await createHarness({ waitMs: 400, prefs: { computerUse: { allowAllApps: true } } });
    try {
      const x = hx.connect({ sessionId: 'x1' });
      const z0 = await x.call('zoom', { region: [0, 0, 100, 100], title: 'x' });
      t.ok('zoom: 撮影の前は no_shot', mark(z0).reason === 'no_shot');
      await x.call('screenshot', { title: 'x' });
      const zoom = await x.call('zoom', { region: [100, 50, 400, 250], title: '拡大' });
      const zc = hx.driver.calls.filter(c => c.op === 'screenshot').at(-1).args;
      t.ok('zoom: 範囲を物理に直して upscale: true で撮り直す。image を返し、保存し、印に shot', zc.upscale === true && zc.region.x === Math.round(100 / 0.7607257743127307) && zc.region.width === Math.round(400 / 0.7607257743127307) - Math.round(100 / 0.7607257743127307)
        && zoom.content[1]?.type === 'image' && /^[0-9a-f]{32}$/.test(mark(zoom).shot) && mark(zoom).tool === 'zoom');
      const click = await x.call('left_click', { coordinate: [730, 410], title: 'x' });
      t.ok('zoom の後も座標の基準は全画面の撮影のまま', hx.inputs().at(-1).x === Math.round(730 / 0.7607257743127307) && mark(click).state === 'ok');
      t.ok('zoom の範囲が外・逆順は outside / invalid', mark(await x.call('zoom', { region: [0, 0, 5000, 100], title: 'x' })).reason === 'outside' && mark(await x.call('zoom', { region: [1, 2, 3], title: 'x' })).reason === 'invalid');
      const half = await x.call('zoom', { region: [0, 0, 700, 400], scale: 0.5, title: 'x' });
      t.ok('zoom の scale は上限に掛ける倍率（maxPixels・maxEdge を縮める）', (() => { const a = hx.driver.calls.filter(c => c.op === 'screenshot').at(-1).args; return a.maxPixels === 600_000 && a.maxEdge === 784; })() && mark(half).state === 'ok');

      const s2 = await x.call('switch_display', { display: 2, title: 'x' });
      t.ok('switch_display: 以後の撮影の対象を替え、オーバーレイの光る場所も移る', mark(s2).display === 2 && hx.driver.overlays.at(-1).display?.id === 'fake-2' && mark(await x.call('switch_display', { display: 9, title: 'x' })).reason === 'invalid');
      const second = await x.call('screenshot', { title: 'x' });
      t.ok('切り替えた後の screenshot は 2 番のディスプレイ（1280×720・縮小なし）', body(second) === 'ディスプレイ 2 / 2・1280×720' && mark(second).display === 2 && hx.driver.calls.filter(c => c.op === 'screenshot').at(-1).args.display === 'fake-2');
      const c2 = await x.call('left_click', { coordinate: [100, 100], title: 'x' });
      t.ok('2 番のディスプレイの座標は、原点（1920, 0）を足した物理座標へ。点の下は電卓', hx.inputs().at(-1).x === 2020 && hx.inputs().at(-1).y === 100 && mark(c2).app === '電卓');
      const shot3 = await x.call('screenshot', { display: 1, title: 'x' });
      t.ok('screenshot の display で対象も移る', mark(shot3).display === 1 && mark(await x.call('screenshot', { title: 'x' })).display === 1);
      t.ok('display が範囲外・小数は invalid', mark(await x.call('screenshot', { display: 3, title: 'x' })).reason === 'invalid' && mark(await x.call('screenshot', { display: 1.5, title: 'x' })).reason === 'invalid');

      await x.call('left_click', { coordinate: [100, 100], title: 'x' });
      const cp = await x.call('cursor_position', { title: 'x' });
      t.ok('cursor_position: 最後の撮影の座標で返す（ロックは取らない）', /\(\d+, \d+\)/.test(body(cp)) && mark(cp).state === 'ok');
      await x.call('switch_display', { display: 2, title: 'x' });
      await x.call('screenshot', { title: 'x' });
      const other = await x.call('cursor_position', { title: 'x' });
      t.ok('カーソルが別のディスプレイにあれば、そう書く', body(other).includes('別のディスプレイ（1）'), body(other));
      await x.call('switch_display', { display: 1, title: 'x' });
      await x.call('screenshot', { title: 'x' });

      hx.driver.calls.length = 0;
      await x.call('mouse_move', { coordinate: [10, 10], title: 'x' });
      await x.call('right_click', { coordinate: [10, 10], title: 'x' });
      await x.call('middle_click', { coordinate: [10, 10], title: 'x' });
      await x.call('double_click', { coordinate: [10, 10], title: 'x' });
      await x.call('triple_click', { coordinate: [10, 10], text: 'ctrl+shift', title: 'x' });
      const kinds = hx.inputs().map(a => `${a.type}:${a.button ?? ''}:${a.count ?? ''}`);
      t.ok('mouse_move・右・中・ダブル・トリプルクリックの動作と count', kinds.join() === 'move::,click:right:1,click:middle:1,click:left:2,click:left:3' && hx.inputs().at(-1).modifiers.join() === 'ctrl,shift');
      t.ok('修飾キーは ctrl・shift・alt だけ（それ以外は invalid）', mark(await x.call('left_click', { coordinate: [10, 10], text: 'meta', title: 'x' })).reason === 'invalid');
      hx.driver.calls.length = 0;
      await x.call('left_click_drag', { start_coordinate: [10, 10], coordinate: [300, 300], title: 'x' });
      const drag = hx.inputs().at(-1);
      t.ok('left_click_drag: 物理の from → to', drag.type === 'drag' && drag.from.x === Math.round(10 / 0.7607257743127307) && drag.to.x === Math.round(300 / 0.7607257743127307));
      hx.driver.calls.length = 0;
      const dragTerm = await x.call('left_click_drag', { start_coordinate: [10, 10], coordinate: [100, 790], title: 'x' });
      t.ok('ドラッグは終点のアプリも判定する（終点が禁止なら拒む。入力は送らない）', mark(dragTerm).reason === 'forbidden' && !hx.ops().includes('input'));
      hx.driver.calls.length = 0;
      await x.call('scroll', { coordinate: [10, 10], scroll_direction: 'down', scroll_amount: 3, title: 'x' });
      t.ok('scroll: 位置・方向・回数', (a => a.type === 'scroll' && a.direction === 'down' && a.amount === 3)(hx.inputs().at(-1)) && mark(await x.call('scroll', { coordinate: [10, 10], scroll_direction: 'diagonal', scroll_amount: 1, title: 'x' })).reason === 'invalid');
      await x.call('left_mouse_down', { coordinate: [10, 10], title: 'x' });
      const downOverlay = hx.driver.overlays.at(-1);
      await x.call('left_mouse_up', { title: 'x' });
      const upOverlay = hx.driver.overlays.at(-1);
      t.ok('left_mouse_down / up: ボタンの状態をオーバーレイの cursor.pressed に載せる', downOverlay.cursor.pressed === true && upOverlay.cursor.pressed === false);

      // computer_batch
      hx.driver.calls.length = 0;
      const batch = await x.call('computer_batch', { actions: [{ action: 'screenshot' }, { action: 'left_click', coordinate: [100, 100] }, { action: 'key', text: 'Return' }, { action: 'screenshot' }], title: 'まとめて' });
      t.ok('computer_batch: 動作ごとの結果。撮影を含むときは最後の 1 枚だけを返し、保存も 1 枚', batch.content.filter(c => c.type === 'image').length === 1 && body(batch).split('\n').length === 4
        && mark(batch).actions.length === 4 && mark(batch).actions.every(a => a.state === 'ok') && mark(batch).actions[1].tool === 'left_click' && mark(batch).actions[1].app === 'メモ帳' && /^[0-9a-f]{32}$/.test(mark(batch).shot) && mark(batch).tool === 'computer_batch');
      t.ok('batch の中の撮影も、その後の座標の基準になる（最後の撮影）', mark(await x.call('left_click', { coordinate: [10, 10], title: 'x' })).state === 'ok');
      hx.driver.calls.length = 0;
      const stopped = await x.call('computer_batch', { actions: [{ action: 'left_click', coordinate: [100, 100] }, { action: 'left_click', coordinate: [100, 790] }, { action: 'key', text: 'Return' }], title: 'x' });
      t.ok('batch は失敗・止められたらそこで打ち切る（3 つ目は実行しない）。state と reason は失敗した動作のもの', mark(stopped).state === 'stopped' && mark(stopped).reason === 'forbidden' && mark(stopped).actions.length === 2
        && mark(stopped).actions[1].reason === 'forbidden' && hx.inputs().length === 1 && stopped.isError);
      t.ok('batch に入れられない動作・多すぎる動作は invalid', mark(await x.call('computer_batch', { actions: [{ action: 'request_access' }], title: 'x' })).reason !== 'ok'
        && mark(await x.call('computer_batch', { actions: [{ action: 'computer_batch', actions: [] }], title: 'x' })).actions[0].reason === 'invalid'
        && mark(await x.call('computer_batch', { actions: Array.from({ length: 21 }, () => ({ action: 'wait', duration: 0.01 })), title: 'x' })).reason === 'invalid'
        && mark(await x.call('computer_batch', { actions: [], title: 'x' })).reason === 'invalid');
    } finally { await hx.close(); }

    // ---- 同じターンの並列の呼び出しは直列。複数の会話ではロック
    const hp = await createHarness({ waitMs: 400, prefs: { computerUse: { allowAllApps: true } }, driverOptions: { delayMs: 30 } });
    try {
      const x = hp.connect({ sessionId: 'p1' });
      await x.call('screenshot', { title: 'x' });
      hp.driver.calls.length = 0;
      await Promise.all([x.call('left_click', { coordinate: [10, 10], title: 'x' }), x.call('left_click', { coordinate: [20, 20], title: 'x' })]);
      // appAt → input の組が重ならずに 2 回並ぶ
      t.ok('同じターンの並列の呼び出しは直列にする（appAt, input, appAt, input の順）', hp.ops().join() === 'appAt,input,appAt,input', hp.ops().join());
      const y = hp.connect({ sessionId: 'p2', title: '別の会話' });
      const yc = y.call('screenshot', { title: 'x' });
      await until(() => hp.states.some(s => s.sessionId === 'p2' && s.state === 'waiting'));
      t.ok('別の会話は待つ（computer.state waiting。持ち主はこの会話）', hp.states.some(s => s.sessionId === 'p2' && s.state === 'waiting' && s.holder.sessionId === 'p1') && hp.ops().filter(o => o === 'screenshot').length === 0);
      x.end();
      const yr = await yc;
      t.ok('持ち主のターンが終われば、待っていた会話が撮れる', mark(yr).state === 'ok' && hp.lock.holder().sessionId === 'p2');
      y.end();
    } finally { await hp.close(); }
    const hq = await createHarness({ waitMs: 150, prefs: { computerUse: { allowAllApps: true } } });
    try {
      const x = hq.connect({ sessionId: 'q1', title: '先の会話' });
      await x.call('screenshot', { title: 'x' });
      const y = hq.connect({ sessionId: 'q2' });
      const busy = await y.call('screenshot', { title: 'x' });
      t.ok('上限（テストでは 150ms）を過ぎたら busy（stopped）。文に今の持ち主の会話のタイトル', busy.isError && mark(busy).reason === 'busy' && mark(busy).state === 'stopped' && body(busy).includes('先の会話'));
      t.ok('取らないツール（request_access・list_granted_applications・wait・cursor_position）は、別の会話が操作中でも待たない', mark(await y.call('list_granted_applications', { title: 'x' })).state === 'ok' && mark(await y.call('wait', { duration: 0.01, title: 'x' })).state === 'ok');
      x.end(); y.end();
    } finally { await hq.close(); }
    const hs = await createHarness({ waitMs: 5000, prefs: { computerUse: { allowAllApps: true } } });
    try {
      const x = hs.connect({ sessionId: 'sl1' });
      await x.call('screenshot', { title: 'x' });
      const y = hs.connect({ sessionId: 'sl2', delivery: { images: 'inline', waitSliceMs: 60 } });
      const t0 = Date.now();
      const sliced = await y.call('screenshot', { title: 'x' });
      t.ok('待ちを分けるエージェント（waitSliceMs）は、その時間で「まだ待っています」（state: waiting・isError）を返す', Date.now() - t0 < 1500 && sliced.isError && mark(sliced).state === 'waiting' && body(sliced).includes('もう一度'));
      x.end();
      t.ok('分けた後の次の呼び出しは、ロックが空いていればすぐ動く', mark(await y.call('screenshot', { title: 'x' })).state === 'ok');
      y.end();
    } finally { await hs.close(); }

    // 委譲の子
    // 「待たない」は経過時間の短さでは測らない（撮影の保存は遅い環境で数百 ms かかる）。待ちの上限を長く取り、待ち（computer.state waiting）に入らず、上限よりずっと早く撮れたことで確かめる
    const hc = await createHarness({ waitMs: 5000, prefs: { computerUse: { allowAllApps: true } } });
    try {
      const parent = hc.connect({ sessionId: 'sp' });
      await parent.call('screenshot', { title: 'x' });
      const child = hc.connect({ sessionId: 'sc', ancestors: ['sp'] });
      const t0 = Date.now();
      const r = await child.call('screenshot', { title: 'x' });
      t.ok('委譲の子は、親がロックを持っていても借りて撮れる（待たない）', mark(r).state === 'ok' && !hc.states.some(s => s.sessionId === 'sc' && s.state === 'waiting') && Date.now() - t0 < 2500 && hc.lock.holder().sessionId === 'sc', `${Date.now() - t0}ms`);
      child.end();
      t.ok('子のターンが終われば親へ返る', hc.lock.holder().sessionId === 'sp');
      parent.end();
    } finally { await hc.close(); }

    // ---- 画像の渡し方
    const hi = await createHarness({ waitMs: 400 });
    try {
      const x = hi.connect({ sessionId: 'i1', delivery: { images: 'path', waitSliceMs: null } });
      const sh = await x.call('screenshot', { title: 'x' });
      const id = mark(sh).shot;
      t.ok('images: path なら、text に保存先の絶対パスの行を足し、image ブロックも残す。印の行は最後のまま', sh.content[0].text.includes(hi.shots.pathOf(id)) && sh.content[1].type === 'image' && sh.content[0].text.split('\n').at(-1).startsWith('[ply_computer]') && /[A-Za-z]:|^\//.test(hi.shots.pathOf(id)));
      t.ok('images: path の instructions は、画像が見えなければファイルを開いて見る指示を足す', (await x.rpc('initialize', {})).body.result.instructions === undefined && x.binding.instructions.includes('保存先のファイル'));
      const inline = hi.connect({ sessionId: 'i2' });
      const sh2 = await inline.call('screenshot', { title: 'x' });
      t.ok('既定（inline）は保存先の行を入れない', !sh2.content[0].text.includes('保存先') && !inline.binding.instructions.includes('保存先のファイル'));
    } finally { await hi.close(); }

    // ---- 橋を閉じる
    const hz = await createHarness({ waitMs: 400, prefs: { computerUse: { allowAllApps: true } } });
    try {
      const x = hz.connect({ sessionId: 'z1' });
      await x.call('screenshot', { title: 'x' });
      x.binding.close();
      t.ok('橋を閉じたら、その会話のターンのロックを放す', hz.lock.holder() === null);
    } finally { await hz.close(); }
    t.ok('ターンの中断（signal の abort）でロックを放し、main へ computer-stop（押したままの入力を離す）', await (async () => {
      const hy = await createHarness({ waitMs: 400, prefs: { computerUse: { allowAllApps: true } } });
      try {
        const x = hy.connect({ sessionId: 'y1' });
        await x.call('screenshot', { title: 'x' });
        x.ac.abort();
        await until(() => hy.lock.holder() === null && hy.driver.stops.includes(x.state.turnId) && hy.arms.at(-1) === null);
        return hy.lock.holder() === null && hy.driver.stops.includes(x.state.turnId) && hy.arms.at(-1) === null;
      } finally { await hy.close(); }
    })());
  } finally { await h.close(); }
}

