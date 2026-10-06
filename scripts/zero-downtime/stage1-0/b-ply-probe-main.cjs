// 1-0 b: 本物の `npm run desktop:pack` の Ply.exe（electron-builder が作った実行ファイルそのもの）の main の代わりに動く試験用の main。
// 本物の desktop/main.cjs は読まない（データ置き場・userData・単一起動のロックに触れない）。
// 自分が入っている Job の制限・同じ Job の PID・自分の子（detached／detached でない）の Job の所属を、実行ファイルのあるフォルダーの out-<pid>.json に書く。
const { app } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const instDir = path.dirname(process.execPath);
app.setPath('userData', path.join(instDir, '..', 'zd-b-userdata'));
app.setPath('sessionData', path.join(instDir, '..', 'zd-b-userdata', 'session'));
app.on('window-all-closed', () => {});

app.whenReady().then(async () => {
  const koffi = require('koffi');
  const { jobInfo, inJob } = require('./job-info.cjs');
  const out = { pid: process.pid, ppid: process.ppid, exe: path.basename(process.execPath), argv: process.argv.slice(1), job: jobInfo(koffi) };
  const cfg = JSON.parse(fs.readFileSync(path.join(instDir, '..', 'zd-b-config.json'), 'utf8'));
  const spawn = (detached) => { const c = cp.spawn(cfg.node, ['-e', 'setTimeout(()=>{},8000)'], { detached, stdio: 'ignore', windowsHide: true }); c.unref(); return c.pid; };
  const d = spawn(true), a = spawn(false);
  await new Promise(r => setTimeout(r, 800));
  out.children = { detachedNode: { pid: d, inJob: inJob(koffi, d) }, attachedNode: { pid: a, inJob: inJob(koffi, a) } };
  const list = out.job.pids ?? [];
  out.jobMembersAreChromiumChildren = list.filter(p => p !== process.pid).length;
  fs.writeFileSync(path.join(instDir, '..', `zd-b-out-${process.pid}.json`), JSON.stringify(out, null, 1));
  setTimeout(() => app.exit(0), 500);
});
