// utilityProcess の中から、$INSTDIR の外の node を detached で起こす（今のサーバーの置き方に近い形の確認）
const cp = require('node:child_process');
const [exe, heartbeat, hbDir, label, koffiDir] = process.argv.slice(2);
const c = cp.spawn(exe, [heartbeat, hbDir, label], { detached: true, stdio: 'ignore', windowsHide: true, env: { ...process.env, ZD_KOFFI: koffiDir } });
c.unref();
process.parentPort.postMessage({ childPid: c.pid });
setInterval(() => {}, 1000);   // サーバーのように居続ける
