// 実機 7 の前半（plan.md「実機で確かめる項目」）と、main を木ごと止めたときの実測。
//   node scripts/zero-downtime/stage1-7/s7-runtime-cleanup.mjs [--out temporary/zd17/s7]
// A → B → E → F と、作業が 0 件のまま更新を 3 回重ねる（E・F は build-installers.mjs の変種。A と同じコードで版だけ違う）。
//   - 実行場所の app\ に古い版が残り、掃除（main の起動の約 1 分後。今の版・直前の版・さらにもう 1 版を残し、使っているシェルがある版は消さない）で A が消える
//   - 実行場所に掃除の途中の残り（.staging など）が無い・store が増えすぎない（ハードリンクの共有）
//   - 最後に、main を **木ごと**（taskkill /T = タスクマネージャーの「プロセスツリーの終了」に近い）止めたとき、サーバー（main の子として登録されたままの detached のプロセス）がどうなるかを測る
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { BUILDS, Timeline, VERSIONS, bootApp, copyLogs, feedUse, freshInstall, isAlive, mainPids, paths, readControl, sleep, startFeed, tryCdp, waitFor } from './zd.mjs';

const arg = name => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : null; };
const out = path.resolve(arg('--out') || path.join(BUILDS, 's7'));
const tl = new Timeline();
const result = { checks: [], steps: [] };
const check = (label, ok, detail) => { result.checks.push({ label, ok: Boolean(ok), detail }); tl.mark(`${ok ? 'OK ' : 'NG '} ${label}`, detail ?? ''); };
const appVersions = () => { try { return fs.readdirSync(path.join(paths.runtime, 'app')).sort(); } catch { return []; } };
const sizeOf = dir => { let total = 0; try { for (const e of fs.readdirSync(dir, { withFileTypes: true })) total += e.isDirectory() ? sizeOf(path.join(dir, e.name)) : fs.statSync(path.join(dir, e.name)).size; } catch { /* 無い */ } return total; };

await freshInstall({ variant: 'A', feed: 'B', tl });
const feed = await startFeed();
try {
  let app = await bootApp(tl);
  let current = app.control;
  check('A の版', current.appVersion === VERSIONS.A, current.appVersion);
  for (const next of ['B', 'E', 'F']) {
    feedUse(next);
    const view = app.page;
    let last = '';
    await waitFor(async () => { const p = (await view.eval(`plyDesktop.update('status')`))?.phase; if (p !== last) { last = p; tl.mark(`update phase (${next})`, p); } if (p === 'unavailable' || p === 'error') throw new Error(`the updater is ${p}`); return p === 'downloaded'; }, { ms: 300000, every: 1000, what: `downloaded ${next}` });
    void view.eval(`plyDesktop.update('install')`).catch(() => {});
    tl.mark(`click install (${current.appVersion} -> ${VERSIONS[next]})`);
    await waitFor(() => !mainPids().includes(app.mainPid), { ms: 120000, every: 500, what: 'old main gone' });
    const newMain = await waitFor(() => mainPids().find(pid => pid !== app.mainPid), { ms: 300000, every: 1000, what: 'new main' });
    const server = await waitFor(() => { const c = readControl(); return c?.pid && c.pid !== current.pid && c.appVersion === VERSIONS[next] ? c : null; }, { ms: 240000, every: 500, what: `server ${VERSIONS[next]}` });
    tl.mark(`switched to ${VERSIONS[next]}`, { main: newMain, server: server.pid, appDirs: appVersions() });
    result.steps.push({ version: VERSIONS[next], appDirs: appVersions() });
    // 新しい main の窓（CDP）に付け直す（次の更新を押すため）
    const port = new URL(server.origin).port;
    const page = await waitFor(() => tryCdp(port, 5000), { ms: 60000, every: 1000, what: 'window' });
    await waitFor(() => fs.existsSync(path.join(paths.userData, 'updates.json')), { ms: 60000, every: 500, what: 'boot' });
    app = { mainPid: newMain, control: server, page };
    current = server;
    await sleep(3000);
  }
  // 掃除は main の起動の約 1 分後。F の main が起動してから 70 秒待つ
  await sleep(70000);
  const dirs = appVersions();
  tl.mark('app dirs after cleanup', dirs);
  check('掃除: 今の版（F）・直前の版（E）・さらにもう 1 版（B）が残り、いちばん古い A は消えた', dirs.length === 3 && !dirs.some(name => name.startsWith(VERSIONS.A)) && dirs.some(name => name.startsWith(VERSIONS.F)) && dirs.some(name => name.startsWith(VERSIONS.E)) && dirs.some(name => name.startsWith(VERSIONS.B)), dirs);
  const leftovers = fs.readdirSync(path.join(paths.runtime, 'app')).filter(name => name.startsWith('.'));
  check('掃除の途中の残り（.staging など）が無い', leftovers.length === 0, leftovers);
  const storeBytes = sizeOf(path.join(paths.runtime, 'store'));
  const appBytes = sizeOf(path.join(paths.runtime, 'app')); // ハードリンクは 1 つずつ数えるので、見かけの合計（実際のディスクは store の分 + 変わった分）
  tl.mark('sizes', { storeMiB: Math.round(storeBytes / 1048576), appTreesApparentMiB: Math.round(appBytes / 1048576) });
  result.sizes = { storeMiB: Math.round(storeBytes / 1048576), appTreesApparentMiB: Math.round(appBytes / 1048576) };
  check('store は版の数に比例して増えていない（4 版を通して 1 版分 + 変わった分。約 110〜130 MiB）', storeBytes < 200 * 1048576, `${Math.round(storeBytes / 1048576)} MiB`);

  // main を木ごと止める（タスクマネージャーの「プロセスツリーの終了」に近い）。サーバーは main の子として登録されたままの detached のプロセス
  const server = readControl();
  const killedAt = Date.now();
  const r = spawnSync('taskkill.exe', ['/PID', String(app.mainPid), '/T', '/F'], { encoding: 'utf8' });
  tl.mark('taskkill /T /F main', (r.stdout || '').trim().split(String.fromCharCode(10)).slice(0, 6).join(' | '));
  await sleep(4000);
  result.treeKillKillsServer = !isAlive(server.pid);
  tl.mark('server after tree kill', { alive: isAlive(server.pid), pid: server.pid });
  result.treeKill = { serverAlive: isAlive(server.pid) };
  if (isAlive(server.pid)) {
    await waitFor(() => !isAlive(server.pid), { ms: 300000, every: 2000, what: 'orphan guard exit' });
    tl.mark('server exited by itself', `${((Date.now() - killedAt) / 1000).toFixed(0)}s`);
  }
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
