// 段階 1 の 1-7 の実機の確認用の入口（試験用のインストーラーだけに入る。本物の配布物は package.json の main が desktop/main.cjs のまま）。
// 本物の desktop/main.cjs を、利用者のインストール版と重ならないデータ置き場・実行場所・userData・AUMID で動かす。
// NSIS が更新後に起こす main は explorer の環境で動き、環境変数を渡せないので、設定は %LOCALAPPDATA%\pleiad-zdtest\config.json から読む:
//   { "env": { "AGENT_HOST_BACKENDS": "fake", ... } }   値が null の変数は外す。ここの値が環境変数より優先する
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const home = path.join(process.env.LOCALAPPDATA || '', 'pleiad-zdtest');
const target = file => path.join(home, file);
let config = {};
try { config = JSON.parse(fs.readFileSync(target('config.json'), 'utf8')); } catch { /* 設定が無ければ既定 */ }

// Pleiad のシェルから引き継がれた変数（別のサーバーのポート・制御の口）を外す
for (const key of Object.keys(process.env)) if (/^(AGENT_HOST_|PLEIAD_|AGENT_BROWSER_)/.test(key)) delete process.env[key];
const env = {
  AGENT_HOST_DATA: target('data'), AGENT_HOST_RUNTIME_DIR: target('runtime'), AGENT_HOST_BACKENDS: 'fake', AGENT_HOST_WORKTREES: 'off',
  ...config.env,
};
for (const [key, value] of Object.entries(env)) { if (value === null) delete process.env[key]; else process.env[key] = String(value); }

// 守り: 利用者のデータ置き場・実行場所を指していたら動かさない
const inside = dir => { const rel = path.relative(home, path.resolve(dir)); return !rel.startsWith('..') && !path.isAbsolute(rel); };
if (!inside(process.env.AGENT_HOST_DATA) || !inside(process.env.AGENT_HOST_RUNTIME_DIR) || /[\\/]Programs[\\/]Ply[\\/]/i.test(process.execPath)) {
  console.error('[zdtest] refusing to run: the data or runtime dir is outside', home);
  app.exit(2);
}

app.setPath('userData', target('userdata'));
// 前回のポートを決めておく（無ければ、利用者の既定の 7420 を取りに行かない）。userData の server-port.json は main が読み書きする
try {
  const file = path.join(target('userdata'), 'server-port.json');
  if (!fs.existsSync(file)) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify({ port: Number(config.port) || 17420 })); }
} catch { /* 取れなくても空きポートへ */ }

// 利用者の Pleiad と同じ AUMID にならない（タスクバー・通知がまとまらない）ようにする
const aumid = id => (id === 'jp.ply.desktop' ? 'jp.ply.zdtest' : id);
const setId = app.setAppUserModelId.bind(app);
app.setAppUserModelId = id => setId(aumid(id));
const setDetails = BrowserWindow.prototype.setAppDetails;
if (setDetails) BrowserWindow.prototype.setAppDetails = function (details) { return setDetails.call(this, { ...details, appId: aumid(details?.appId), relaunchDisplayName: 'Pleiad ZdTest' }); };

// 画面の確認用（CDP で窓の読み直し・表示を見る）。config.json の debugPort があるときだけ。
// Chromium の記録（devtools の待ち受けの失敗など）は chromium.log へ。ほかの窓に覆われても描かれるよう、窓の遮蔽の判定を切る
if (config.debugPort) {
  app.commandLine.appendSwitch('remote-debugging-port', String(config.debugPort));
  app.commandLine.appendSwitch('enable-logging', 'file');
  app.commandLine.appendSwitch('log-file', target('chromium.log'));
  app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
}
const note = (...parts) => { try { fs.appendFileSync(target('entry.log'), `${new Date().toISOString()} pid ${process.pid} ${parts.join(' ')}
`); } catch { /* 記録できなくても動く */ } };
note('start', process.execPath, process.argv.slice(1).join(' '), 'handover', process.env.AGENT_HOST_HANDOVER ?? '(default)', 'backends', process.env.AGENT_HOST_BACKENDS);
console.warn('[zdtest] home', home, 'data', process.env.AGENT_HOST_DATA, 'runtime', process.env.AGENT_HOST_RUNTIME_DIR, 'handover', process.env.AGENT_HOST_HANDOVER ?? '(default)');
if (config.debugPort) {
  const net = require('node:net');
  app.whenReady().then(() => setTimeout(() => {
    const socket = net.connect(Number(config.debugPort), '127.0.0.1');
    socket.once('connect', () => { note('debug port', config.debugPort, 'is listening'); socket.destroy(); });
    socket.once('error', error => note('debug port', config.debugPort, 'is NOT listening:', error.code));
  }, 4000));
}
require('../../../desktop/main.cjs');
