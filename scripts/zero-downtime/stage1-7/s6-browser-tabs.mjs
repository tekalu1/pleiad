// 実機 6（plan.md「実機で確かめる項目」の段階 1）: 内蔵ブラウザーのタブを開いた会話を更新（A→B。作業は 0 件なのですぐ切り替わる）しても、
// 新しい main がタブを URL で開き直し、同じポート・鍵で中継（CDP）を立て直す。
//   node scripts/zero-downtime/stage1-7/s6-browser-tabs.mjs [--out temporary/zd17/s6]
// 会話は fake の `browser:` のターンで作る（agent-browser.json ができる）。タブは窓の plyDesktop.browser で開き、URL は配信元（17499）のファイル。
// 確かめるのは、更新の前後でタブが同じ数・同じ URL で在ること、agent-browser.json の cdp が同じこと、その cdp の中継に Target.getTargets でつながってタブが見えること
// （本物の agent-browser の呼び出しは、中継に同じ CDP で話すのと同じ。常駐が同じ pid のまま戻ることは 1-5 のハーネスで確かめた）。
import fs from 'node:fs';
import path from 'node:path';
import WebSocket from 'ws';
import { BUILDS, FEED, Timeline, bootApp, copyLogs, freshInstall, isAlive, mainPids, paths, readControl, sleep, startFeed, tryCdp, updaterLog, waitFor, wsOpenServer, ZD } from './zd.mjs';

const arg = name => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : null; };
const out = path.resolve(arg('--out') || path.join(BUILDS, 's6'));
const tl = new Timeline();
const result = { checks: [] };
const check = (label, ok, detail) => { result.checks.push({ label, ok: Boolean(ok), detail }); tl.mark(`${ok ? 'OK ' : 'NG '} ${label}`, detail ?? ''); };
const tabUrls = [`http://127.0.0.1:${ZD.feedPort}/latest.yml?zd=tab1`, `http://127.0.0.1:${ZD.feedPort}/latest.yml?zd=tab2`];

const findConfig = () => {
  const root = path.join(paths.data, 'agent-browser');
  try { for (const dir of fs.readdirSync(root)) { const file = path.join(root, dir, 'agent-browser.json'); if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8')); } } catch { /* まだ無い */ }
  return null;
};
const targets = cdpUrl => new Promise(resolve => {
  const ws = new WebSocket(cdpUrl);
  const timer = setTimeout(() => { ws.terminate(); resolve({ error: 'timeout' }); }, 8000);
  ws.once('error', error => { clearTimeout(timer); resolve({ error: error.message }); });
  ws.once('open', () => ws.send(JSON.stringify({ id: 1, method: 'Target.getTargets' })));
  ws.on('message', raw => { const m = JSON.parse(raw.toString()); if (m.id === 1) { clearTimeout(timer); ws.close(); resolve({ targets: m.result?.targetInfos ?? [] }); } });
});
const tabsOf = async port => {
  const view = await tryCdp(port, 8000);
  if (!view) return null;
  const list = await (await fetch(`http://127.0.0.1:${Number(fs.readFileSync(path.join(paths.userData, 'DevToolsActivePort'), 'utf8').split(String.fromCharCode(10))[0])}/json/list`)).json();
  view.close();
  return list.filter(item => item.type === 'page' && item.url.includes('/latest.yml')).map(item => item.url).sort();
};

await freshInstall({ variant: 'A', feed: 'B', tl });
const feed = await startFeed();
try {
  const app = await bootApp(tl);
  const s1 = app.control;
  const port = new URL(s1.origin).port;
  const client = await wsOpenServer(s1);
  const turn = await client.runTurn({ backend: 'fake', cwd: path.join(ZD.home, 'work'), prompt: 'browser:[{"name":"list_browser_profiles","arguments":{}}]' }, { ms: 30000 });
  const sessionId = turn.sessionId;
  tl.mark('browser turn', { sessionId, outcome: turn.outcome });
  const opened = await app.page.eval(`(async () => {
    const r = [];
    r.push(await plyDesktop.browser.command('context', { sessionId: ${JSON.stringify(sessionId)} }).then(() => 'context', e => 'context error ' + e.message));
    for (const url of ${JSON.stringify(tabUrls)}) r.push(await plyDesktop.browser.command('open', { url, newTab: true }).then(() => 'open', e => 'open error ' + e.message));
    return r;
  })()`);
  tl.mark('open tabs', opened);
  await sleep(4000);
  const before = await tabsOf(port);
  const config1 = findConfig();
  check('更新の前: タブが 2 枚開いている', before?.length === 2, before);
  check('更新の前: agent-browser.json に中継の cdp がある', typeof config1?.cdp === 'string' && config1.cdp.startsWith('ws://'), config1?.cdp?.replace(/\/[^/]+$/, '/…'));
  const t1 = config1?.cdp ? await targets(config1.cdp) : { error: 'no cdp' };
  check('更新の前: 中継（cdp）に Target.getTargets でつながり、タブが見える', (t1.targets ?? []).filter(item => item.type === 'page').length >= 2, t1.error ?? (t1.targets ?? []).map(item => item.url));

  // 更新（作業は 0 件。すぐ切り替わる）
  let last = '';
  await waitFor(async () => { const p = (await app.page.eval(`plyDesktop.update('status')`))?.phase; if (p !== last) { last = p; tl.mark('update phase', p); } if (p === 'unavailable' || p === 'error') throw new Error(`the updater is ${p}`); return p === 'downloaded'; }, { ms: 240000, every: 1000, what: 'downloaded' });
  void app.page.eval(`plyDesktop.update('install')`).catch(() => {});
  tl.mark('click install');
  await waitFor(() => !mainPids().includes(app.mainPid), { ms: 120000, every: 500, what: 'old main gone' });
  const newMain = await waitFor(() => mainPids().find(pid => pid !== app.mainPid), { ms: 300000, every: 1000, what: 'new main' });
  tl.mark('new main started', { pid: newMain });
  const s2 = await waitFor(() => { const c = readControl(); return c?.pid && c.pid !== s1.pid && c.appVersion === '0.10.3' ? c : null; }, { ms: 180000, every: 500, what: 'S2' });
  tl.mark('S2 ready', { pid: s2.pid });
  await waitFor(() => updaterLog(/switch: done/).length > 0, { ms: 30000, every: 500, what: 'switch done' }).catch(() => null);
  await sleep(8000);
  const after = await tabsOf(port);
  const config2 = findConfig();
  check('更新の後: 新しい main がタブを同じ URL で開き直した（2 枚）', JSON.stringify(after) === JSON.stringify(before), { before, after });
  check('更新の後: agent-browser.json の cdp が同じ（同じポート・鍵で中継を立て直した）', config2?.cdp === config1?.cdp, { same: config2?.cdp === config1?.cdp });
  const t2 = config2?.cdp ? await targets(config2.cdp) : { error: 'no cdp' };
  check('更新の後: 中継（cdp）に Target.getTargets でつながり、タブが見える', (t2.targets ?? []).filter(item => item.type === 'page').length >= 2, t2.error ?? (t2.targets ?? []).map(item => item.url));
  check('サーバーは新しい版（S2）に替わった', s2.appVersion === '0.10.3' && !isAlive(s1.pid), { s2: s2.pid });
  client.close();
} finally {
  result.timeline = tl.lines;
  copyLogs(out);
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(result, null, 2));
  await feed.close();
}
const failed = result.checks.filter(c => !c.ok);
console.log(`\nRESULT ${result.checks.length - failed.length}/${result.checks.length} ok`, failed.map(c => c.label));
process.exit(failed.length ? 1 : 0);
