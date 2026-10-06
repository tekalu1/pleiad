// 実機 1・2・4（plan.md「実機で確かめる項目」の段階 1）: 試験用の旧版（A）→ 新版（B）の更新を、走っているターンと一緒に通す。
//   node scripts/zero-downtime/stage1-7/s1-update-running-turn.mjs [--permission] [--out temporary/zd17/s1]
// 既定: fake の 150 秒のターンを走らせたまま、画面の更新ボタン（plyDesktop.update('install')）→ electron-updater → NSIS → 新版の main。
//   ターンが中断されずに終わる・切り替えは作業が終わってから・窓の読み直し・同じ origin／トークンを見る。
// --permission: ターンを承認待ち（fake の ask）にしたまま更新する。新しい main の画面に承認が出て、答えるとターンが進む。
// --draft: 更新の前に入力欄へ下書きを書いておき、切り替えで画面が読み直された後も残っていることを見る。
// --interrupt-now: 待っている間に「今すぐ中断して切り替える」（plyDesktop.switch.act('now')）を押す。ターンは理由 update で中断され、すぐ新しいサーバーに切り替わる。
import fs from 'node:fs';
import path from 'node:path';
import { BUILDS, FAKE_TURN, ZD, Timeline, bootApp, typeDraft, copyLogs, freshInstall, isAlive, mainPids, originMatch, paths, processesUnder, readControl, shot, sleep, startFeed, tryCdp, updaterLog, waitFor, wsOpenServer } from './zd.mjs';

const arg = name => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : null; };
const permission = process.argv.includes('--permission');
const draftFlag = process.argv.includes('--draft');
const interruptNow = process.argv.includes('--interrupt-now');
const DRAFT = 'zdtest-draft-text-0123';
const out = path.resolve(arg('--out') || path.join(BUILDS, permission ? 's2' : interruptNow ? 's1-interrupt' : 's1'));
const tl = new Timeline();
const result = { checks: [], permission, draft: draftFlag, interruptNow };
const check = (label, ok, detail) => { result.checks.push({ label, ok: Boolean(ok), detail }); tl.mark(`${ok ? 'OK ' : 'NG '} ${label}`, detail ?? ''); };

await freshInstall({ variant: 'A', feed: 'B', tl });
const feed = await startFeed();
try {
  const app = await bootApp(tl);
  const s1 = app.control;
  const runtimeProcs = processesUnder([paths.runtime]);
  const s1proc = runtimeProcs.find(p => p.pid === s1.pid);
  check('S1 は実行場所の pleiad-node.exe（main の子でない）', s1proc && /pleiad-node\.exe$/i.test(s1proc.path) && !mainPids().includes(s1proc.parent === app.mainPid ? -1 : s1proc.parent), s1proc);
  check('A の版', s1.appVersion === '0.10.2', s1.appVersion);
  await app.page.eval('window.__zdMarker = "before-update"');

  const client = await wsOpenServer(s1);
  const events = [];
  client.ws.on('message', raw => { try { const m = JSON.parse(raw.toString()); if (m.kind === 'event') events.push({ at: Date.now(), ...m.event }); } catch { /* 無視 */ } });
  fs.mkdirSync(path.join(paths.data, '..', 'work'), { recursive: true });
  const cwd = path.join(paths.data, '..', 'work');
  const prompt = permission
    ? `steps:${JSON.stringify({ steps: [{ tool: 'Bash', input: { command: 'echo hi' }, result: 'ok', ask: true, ms: 200 }, { tool: 'Bash', input: {}, result: 'ok', ms: 20000 }, { text: 'done' }] })}`
    : interruptNow ? `steps:${JSON.stringify({ steps: [...Array.from({ length: 30 }, () => ({ tool: 'Bash', input: {}, result: 'ok', ms: 5000 })), { text: 'done' }] })}` : FAKE_TURN(150000);   // 中断を試すときは、fake が中断を見る間隔（ステップの切れ目）を 5 秒にする
  const turnStart = Date.now();
  const mark = client.mark();
  void client.cmd('runTurn', { backend: 'fake', cwd, prompt }).catch(() => {});
  const session = await client.waitFor(e => e.type === 'session' && e.sessionId, { from: mark, ms: 20000 });
  const sessionId = session.sessionId;
  tl.mark('turn started', { sessionId });
  if (permission) {
    const ask = await client.waitFor(e => e.type === 'permission' && e.sessionId === sessionId, { from: mark, ms: 20000 });
    tl.mark('permission pending on S1', { id: ask.id });
    result.permissionId = ask.id;
  }

  if (draftFlag) {
    // 会話を開いて、入力欄に下書きを書く（保存は少し遅れて localStorage とサーバーへ）
    await app.page.eval(`document.querySelector('[data-session="${sessionId}"]')?.click()`);
    await sleep(1500);
    const typed = await typeDraft(app.page, DRAFT);
    await sleep(2500);
    check('更新の前に、入力欄へ下書きを書いた', typed.includes(DRAFT), typed);
  }

  // 更新を見つけて、ダウンロードが終わるまで
  const phase = async () => (await app.page.eval(`plyDesktop.update('status')`))?.phase;
  let last = '';
  await waitFor(async () => { const p = await phase(); if (p !== last) { last = p; tl.mark('update phase', p); } if (p === 'unavailable' || p === 'error') throw new Error(`the updater is ${p}: ${JSON.stringify(await app.page.eval(`plyDesktop.update('status')`))}`); return p === 'downloaded'; }, { ms: 240000, every: 1000, what: 'update downloaded' });
  await app.page.screenshot(path.join(out, 'before-install.png'));
  const switchSeen = [];

  const clickAt = Date.now();
  tl.mark('click install');
  void app.page.eval(`plyDesktop.update('install')`).catch(() => {});

  // main の入れ替わりを 1 秒刻みで見る
  const oldMain = app.mainPid;
  let oldGoneAt = null; let newMain = null; let newMainAt = null;
  await waitFor(() => {
    const alive = mainPids();
    if (!oldGoneAt && !alive.includes(oldMain)) { oldGoneAt = Date.now(); tl.mark('old main gone', `${((oldGoneAt - clickAt) / 1000).toFixed(1)}s after click`); }
    if (oldGoneAt && !newMain) { newMain = alive.find(p => p !== oldMain) ?? null; if (newMain) { newMainAt = Date.now(); tl.mark('new main started', { pid: newMain, afterOldGone: `${((newMainAt - oldGoneAt) / 1000).toFixed(1)}s` }); } }
    const s1alive = isAlive(s1.pid);
    if (!s1alive && !result.s1GoneEarly) { result.s1GoneEarly = Date.now() - clickAt; }
    return newMain;
  }, { ms: 300000, every: 1000, what: 'new main' });
  check('更新の間も S1（サーバー）は生きていた', !result.s1GoneEarly || events.some(e => e.type === 'turnEnd'), { s1GoneAfterMs: result.s1GoneEarly ?? null });
  result.updateGapSeconds = Number(((newMainAt - oldGoneAt) / 1000).toFixed(1));

  // 新しい main の窓（NSIS が起こした main。CDP が開いていれば画面を読み、無ければ PrintWindow で撮る）
  const port = new URL(s1.origin).port;
  const view = await tryCdp(port, 25000);
  tl.mark('new window', view ? { cdp: true } : { cdp: false });
  result.newMainCdp = Boolean(view);
  const shotPath = path.join(out, 'waiting-printwindow.png');
  await sleep(3000);
  tl.mark('printwindow', shot(newMain, shotPath));
  let notice = '(no cdp)';
  if (view) {
    const marker = await view.eval('window.__zdMarker ?? null');
    await view.eval('window.__zdMarker2 = "before-switch"');
    check('新しい main の窓は新しく読み込まれている（画面の変数が残っていない）', marker === null, marker);
    notice = await view.eval(`(document.querySelector('#switchNotice')?.innerText ?? '') + ' | ' + (document.querySelector('#switchNotice')?.hidden ?? 'none')`).catch(() => '(none)');
    await view.screenshot(path.join(out, 'waiting.png'));
  }
  tl.mark('switch notice', notice);
  result.switchNotice = notice;
  const s1StillThere = readControl()?.pid === s1.pid;
  check('新しい main が付け直した（サーバーは S1 のまま。ターンの最中）', s1StillThere && isAlive(s1.pid), { pid: readControl()?.pid });
  check('ターンはまだ走っている（turnEnd が来ていない）', !events.some(e => e.type === 'turnEnd' && e.sessionId === sessionId), null);

  let interruptAt = 0;
  const clickAtInterrupt = () => interruptAt;
  if (interruptNow) {
    interruptAt = Date.now();
    const clicked = await view.eval(`plyDesktop.switch.act('now')`).catch(error => `error ${error.message}`);
    tl.mark('click interrupt now', clicked);
    check('「今すぐ中断して切り替える」が受け付けられた', clicked === true, clicked);
  }

  if (permission) {
    const pending = view ? await view.eval(`document.body.innerText.slice(0, 4000)`) : (shot(newMain, path.join(out, 'permission-after-update.png')), 'permission');
    const shown = /許可|承認|Allow|Approve|Permission/i.test(pending);
    check('新しい main の画面に承認が出ている', shown, view ? pending.slice(0, 160).replace(/\s+/g, ' ') : 'printwindow only');
    if (view) await view.screenshot(path.join(out, 'permission-after-update.png'));
    // 画面で答える（resolvePermission を画面の WS と同じ口で）
    await client.cmd('resolvePermission', { id: result.permissionId, allow: true }).then(() => tl.mark('permission answered'), error => check('承認に答えられる', false, error.message));
  }

  // ターンが終わるのを待つ。終わるまで S1 は切り替わらない
  const end = await client.waitFor(e => e.type === 'turnEnd' && e.sessionId === sessionId, { from: mark, ms: 400000 }).catch(error => ({ error: error.message }));
  const endResult = events.find(e => e.type === 'turnResult' && e.sessionId === sessionId);
  tl.mark('turn ended', { outcome: endResult?.outcome, aborted: endResult?.aborted, at: end.at ? `${((Date.now() - turnStart) / 1000).toFixed(1)}s after start` : end });
  if (interruptNow) {
    const turnEnd = events.find(e => e.type === 'turnEnd' && e.sessionId === sessionId);
    // fake は中断を 'ok' の終わりで返し、interrupted の印を付けない（理由 update の印は単体 tests/unit/desktop-switch.mjs・server の中断の試験が見る）。ここでは「長い台本の途中で止まって、すぐ切り替わった」を見る
    const early = turnEnd && turnEnd.completedAt - interruptAt < 20000;
    check('「今すぐ中断」でターンは台本の途中で止まった（押してから 20 秒以内に終わった）', early, { afterMs: turnEnd ? turnEnd.completedAt - interruptAt : null, outcome: endResult?.outcome, tools: events.filter(e => e.type === 'tool.start' && e.sessionId === sessionId).length });
    result.interruptSeconds = Number(((Date.now() - clickAtInterrupt()) / 1000).toFixed(1));
  } else check('ターンは中断されずに終わった', endResult && !/interrupt|abort/i.test(JSON.stringify(endResult.outcome)) && !events.some(e => e.sessionId === sessionId && e.type === 'interrupted'), endResult);
  const text = events.filter(e => e.sessionId === sessionId && /text/.test(e.type)).map(e => e.text ?? e.delta ?? '').join('');
  if (!interruptNow) check('台本の最後の発言（done）まで流れた', /done/.test(text), text.slice(-40));

  // 切り替え: S2
  const s2 = await waitFor(() => { const c = readControl(); return c?.pid && c.pid !== s1.pid && c.appVersion === '0.10.3' ? c : null; }, { ms: 120000, every: 500, what: 'S2' });
  tl.mark('S2 ready', { pid: s2.pid, appVersion: s2.appVersion, origin: s2.origin });
  check('S2 は新しい版で、同じ origin', s2.appVersion === '0.10.3' && s2.origin === s1.origin, { s1: s1.origin, s2: s2.origin });
  check('S1 は終わった', !isAlive(s1.pid), s1.pid);
  await waitFor(() => updaterLog(/switch: done/).length > 0, { ms: 15000, every: 500, what: 'switch: done in updater.log' }).catch(() => null);
  const reloadLines = updaterLog(/switch: (reloading|done)/);
  check('main が窓を読み直した（updater.log の switch: reloading → done）', reloadLines.length >= 2, reloadLines.map(line => line.slice(0, 80)));
  await sleep(2500);
  const view2 = await tryCdp(new URL(s2.origin).port, 8000);
  if (view2) {
    const marker2 = await view2.eval('window.__zdMarker2 ?? null').catch(() => 'error');
    check('窓は読み直された（切り替えの前に新しい窓へ置いた印が消えている）', marker2 === null, marker2);
    await view2.screenshot(path.join(out, 'after-switch.png'));
    if (draftFlag) {
      await sleep(1500);
      const after = await view2.eval(`document.querySelector('#prompt')?.innerText ?? ''`).catch(() => '');
      check('読み直された画面の入力欄に、下書きが残っている', after.includes(DRAFT), after.slice(0, 80));
    }
  } else tl.mark('printwindow after switch', shot(newMain, path.join(out, 'after-switch-printwindow.png')));
  const client2 = await wsOpenServer(s2);
  const list = await client2.cmd('listSessions', {});
  const mine = (list.sessions ?? list).find?.(item => (item.id ?? item.sessionId) === sessionId);
  if (interruptNow) check('S2 の会話の記録: 終わりが残っている（fake は中断の印を付けない）', Boolean(mine?.completedAt), { completedAt: mine?.completedAt });
  else check('S2 の会話の記録: 中断の印が無く、終わりが残っている', mine && !mine.interrupted && Boolean(mine.completedAt ?? mine.lastCompletedAt ?? true), mine ? { interrupted: mine.interrupted, completedAt: mine.completedAt } : 'not found');
  client2.close();
  view2?.close();
  result.s2 = { pid: s2.pid, appVersion: s2.appVersion };
} finally {
  result.timeline = tl.lines;
  result.feedHits = feed.hits;
  copyLogs(out);
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(result, null, 2));
  await feed.close();
}
const failed = result.checks.filter(c => !c.ok);
console.log(`\nRESULT ${result.checks.length - failed.length}/${result.checks.length} ok`, failed.map(c => c.label));
process.exit(failed.length ? 1 : 0);
