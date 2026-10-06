// 実機 8・9（plan.md「実機で確かめる項目」の段階 1）と、plan.md 1-7 のハーネス 3 の実機版。
//   node scripts/zero-downtime/stage1-7/s3-bad-versions.mjs --to C|D [--out temporary/zd17/s3-C]
//   --to C  新しいサーバーが立たない版（core/server.mjs の頭で throw）への更新 → 前の版（A）のサーバーで動き続け、その旨が画面に出る
//   --to D  データの形式番号が違う版への更新 → 自動では切り替えず、「あとで／中断して更新」を聞く。「あとで」では切り替わらない
// 作業が 0 件の状態（走っているターン無し）で更新する。切り替えは新しい main が付け直した直後に始まる。
import fs from 'node:fs';
import path from 'node:path';
import { BUILDS, VERSIONS, ZD, Timeline, bootApp, copyLogs, freshInstall, isAlive, mainPids, readControl, shot, sleep, startFeed, tryCdp, updaterLog, waitFor, wsOpenServer } from './zd.mjs';

const arg = name => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : null; };
const to = arg('--to');
if (!['C', 'D'].includes(to)) throw new Error('--to C|D');
const out = path.resolve(arg('--out') || path.join(BUILDS, `s3-${to}`));
const tl = new Timeline();
const result = { to, checks: [] };
const check = (label, ok, detail) => { result.checks.push({ label, ok: Boolean(ok), detail }); tl.mark(`${ok ? 'OK ' : 'NG '} ${label}`, detail ?? ''); };

await freshInstall({ variant: 'A', feed: to, tl });
const feed = await startFeed();
try {
  const app = await bootApp(tl);
  const s1 = app.control;
  await app.page.eval('window.__zdMarker = "before-update"');
  const phase = async () => (await app.page.eval(`plyDesktop.update('status')`))?.phase;
  let last = '';
  await waitFor(async () => { const p = await phase(); if (p !== last) { last = p; tl.mark('update phase', p); } if (p === 'unavailable' || p === 'error') throw new Error(`the updater is ${p}: ${JSON.stringify(await app.page.eval(`plyDesktop.update('status')`))}`); return p === 'downloaded'; }, { ms: 240000, every: 1000, what: 'update downloaded' });
  const clickAt = Date.now();
  tl.mark('click install');
  void app.page.eval(`plyDesktop.update('install')`).catch(() => {});
  await waitFor(() => !mainPids().includes(app.mainPid), { ms: 120000, every: 500, what: 'old main gone' });
  tl.mark('old main gone');
  const newMain = await waitFor(() => mainPids().find(pid => pid !== app.mainPid), { ms: 300000, every: 1000, what: 'new main' });
  tl.mark('new main started', { pid: newMain, afterClick: `${((Date.now() - clickAt) / 1000).toFixed(0)}s` });
  const port = new URL(s1.origin).port;
  const view = await tryCdp(port, 25000);
  result.newMainCdp = Boolean(view);
  tl.mark('new window', { cdp: Boolean(view) });
  const pageText = async () => view ? (await view.eval('document.body.innerText').catch(() => '')).replace(/\s+/g, ' ') : '';

  if (to === 'C') {
    // 切り替えを試みて、新しいサーバーが立たず、前の版（A）で起こし直す
    const control = await waitFor(() => { const c = readControl(); return c?.pid && c.pid !== s1.pid && c.appVersion ? c : null; }, { ms: 180000, every: 500, what: 'server replaced' });
    tl.mark('server replaced', { pid: control.pid, appVersion: control.appVersion });
    check('新しいサーバー（C）は立たず、前の版（A）のサーバーで動いている', control.appVersion === VERSIONS.A, { appVersion: control.appVersion });
    check('古い S1 は終わっている', !isAlive(s1.pid), s1.pid);
    await sleep(4000);
    const v2 = await tryCdp(port, 10000);
    const text = v2 ? (await v2.eval('document.body.innerText')).replace(/\s+/g, ' ') : '';
    const notice = /前の版|起動できなかった|previous version|could not/i.test(text);
    tl.mark('page text (head)', text.slice(0, 200));
    const fallbackLines = updaterLog(/switch: (fallback|failed|started the server|falling)/i);
    result.fallbackLines = fallbackLines;
    if (v2) { check('画面に、新しい版のサーバーを起動できず前の版で動いている旨が出ている', notice, text.slice(0, 160)); await v2.screenshot(path.join(out, 'fallback.png')); }
    else tl.mark('printwindow', shot(newMain, path.join(out, 'fallback-printwindow.png')));
    check('main の記録に、切り替えが前の版へ戻ったこと（switch: fallback）が残っている', fallbackLines.some(line => /fallback/i.test(line)), fallbackLines.map(line => line.slice(0, 120)));
    check('前の版のサーバーは同じ origin・使える（fake のターンが通る）', control.origin === s1.origin && await (async () => {
      const client = await wsOpenServer(control);
      const r = await client.runTurn({ backend: 'fake', cwd: path.join(ZD.home, 'work'), prompt: 'echo:zd' }, { ms: 30000 });
      client.close();
      return r.outcome != null;
    })(), control.origin);
    v2?.close();
  } else {
    // 形式番号が違う: 自動では切り替えない。「あとで」を選ぶと S1 のまま
    await waitFor(async () => view ? /あとで|Later/i.test(await pageText()) : updaterLog(/switch: .*(incompatible|asking|data format|schema)/i).length > 0, { ms: 90000, every: 1000, what: 'incompatible question' }).catch(() => null);
    const text = await pageText();
    tl.mark('page text (head)', text.slice(0, 240));
    const asked = updaterLog(/switch: .*(incompatible|asking|data format|schema)/i);
    result.askedLines = asked;
    check('形式番号が違う版への更新: 自動では切り替えず、聞く（画面の「あとで／中断して更新」・main の記録の incompatible）', view ? /あとで|Later/i.test(text) && /中断|Interrupt|stop/i.test(text) : asked.length > 0, view ? text.slice(0, 200) : asked.map(line => line.slice(0, 140)));
    if (view) await view.screenshot(path.join(out, 'incompatible.png')); else tl.mark('printwindow', shot(newMain, path.join(out, 'incompatible-printwindow.png')));
    const answered = view ? await view.eval(`(async () => { try { await plyDesktop.switch.act('later'); return 'later'; } catch (e) { return 'error ' + e.message; } })()`).catch(error => `error ${error.message}`) : 'no cdp (not answered)';
    tl.mark('answered', answered);
    await sleep(20000);
    const control = readControl();
    check('「あとで」を選んでも切り替わらない（S1 のまま・版は A）', control?.pid === s1.pid && control.appVersion === VERSIONS.A && isAlive(s1.pid), { pid: control?.pid, appVersion: control?.appVersion });
    const after = await pageText();
    result.afterText = after.slice(0, 200);
  }
  view?.close();
} finally {
  result.timeline = tl.lines;
  result.feedHits = feed.hits.length;
  copyLogs(out);
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(result, null, 2));
  await feed.close();
}
const failed = result.checks.filter(c => !c.ok);
console.log(`\nRESULT ${result.checks.length - failed.length}/${result.checks.length} ok`, failed.map(c => c.label));
process.exit(failed.length ? 1 : 0);
