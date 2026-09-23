// 外部 MCP の秘密の暗号化を、本物の Electron で確かめるスモーク（npm test には入れない。Electron の起動が要る）。
//
//   npx electron tests/desktop/safe-storage-smoke.cjs            （Linux の CI では --no-sandbox と xvfb-run を足す）
//
// 本物の safeStorage を持つ main（このファイル）と、本物の utilityProcess（safe-storage-worker.cjs）を起動し、
// desktop/secret-bridge.cjs の attachSecretBridge（desktop/main.cjs と同じ配線）を通して、
// core/secret-store.mjs の parentPortCipher で暗号化・復号が往復することを見る。ウィンドウは出さない。
// Pleiad 本体のデータ置き場・プロフィールには触らない（userData も秘密のファイルも一時ディレクトリ）。
//
// 期待する結果は SMOKE_EXPECT_ENCRYPTED で指定する（1 = 暗号化できるはず、0 = できないはず）。
// 未指定なら Windows と macOS は 1、Linux は結果を報告するだけで成否は問わない。
// 結果は 1 行の JSON で標準出力に出し、終了コードは 0 = 期待どおり、1 = 期待と違う、2 = 途中で止まった。
const { app, utilityProcess, safeStorage } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { attachSecretBridge } = require('../../desktop/secret-bridge.cjs');

// ELECTRON_RUN_AS_NODE=1 のまま起動すると Electron が素の Node として動き、app も safeStorage も無い（Pleiad の中の端末など）
if (!app) {
  process.stdout.write(`${JSON.stringify({ ok: false, error: 'Electron が Node として起動しました。ELECTRON_RUN_AS_NODE を外して実行してください' })}\n`);
  process.exit(2);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ply-safe-storage-'));
app.setPath('userData', path.join(tmp, 'user-data'));
app.setName('Pleiad Secret Smoke');
app.disableHardwareAcceleration();

let finished = false;
function finish(code, report) {
  if (finished) return;
  finished = true;
  process.stdout.write(`${JSON.stringify(report)}\n`);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  app.exit(code);
}

const expected = process.env.SMOKE_EXPECT_ENCRYPTED === '1' ? true : process.env.SMOKE_EXPECT_ENCRYPTED === '0' ? false
  : process.platform === 'linux' ? null : true;

app.on('window-all-closed', () => {}); // ウィンドウは作らない。閉じても終わらせない
app.whenReady().then(() => {
  const timer = setTimeout(() => finish(2, { ok: false, error: 'timeout: the utility process did not report' }), 60_000);
  const worker = utilityProcess.fork(path.join(__dirname, 'safe-storage-worker.cjs'), [path.join(tmp, 'data')], { stdio: 'pipe', serviceName: 'Pleiad secret smoke' });
  let stderr = '';
  worker.stderr.on('data', d => { stderr = (stderr + d).slice(-2000); });
  worker.stdout.on('data', () => {});
  attachSecretBridge(worker, { safeStorage });
  worker.on('message', message => {
    if (message?.type !== 'smoke-result') return;
    clearTimeout(timer);
    const r = message.result;
    const backend = process.platform === 'linux' ? safeStorage.getSelectedStorageBackend?.() ?? 'unknown' : null;
    const checks = r.error ? [['worker', false]] : r.status.encrypted
      ? [['roundtrip', r.roundtrip], ['no plaintext on disk', !r.plaintextOnDisk], ['entry sealed with safeStorage', r.entryEnc === 'safeStorage'],
        ['npm start cannot decrypt (SECRET_LOCKED)', r.lockedCode === 'SECRET_LOCKED'], ['plain entries re-encrypted', r.migrated === 1 && r.plainAfterMigrate === 0 && r.migratedReadable]]
      : [['roundtrip', r.roundtrip], ['reason shown', Boolean(r.status.reason)], ['stored as plain', r.entryEnc === 'plain'], ['no re-encryption', r.migrated === 0]];
    const failed = checks.filter(([, pass]) => !pass).map(([label]) => label);
    const matches = expected === null || r.status?.encrypted === expected;
    finish(failed.length || !matches ? 1 : 0, {
      ok: !failed.length && matches, platform: process.platform, electron: process.versions.electron, expectedEncrypted: expected,
      encrypted: r.status?.encrypted ?? null, backend: r.status?.backend ?? null, linuxBackend: backend, reason: r.status?.reason ?? null,
      checks: Object.fromEntries(checks), ...(failed.length ? { failed } : {}), ...(r.error ? { error: r.error, stderr } : {}),
    });
  });
  worker.on('exit', code => { clearTimeout(timer); finish(2, { ok: false, error: `utility process exited (${code}) before reporting`, stderr }); });
});
