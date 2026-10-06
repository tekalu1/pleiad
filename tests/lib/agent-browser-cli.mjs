// 同梱の agent-browser の本物（node_modules/agent-browser）を、会話の環境変数で 1 回走らせる（tests/unit/chrome-relay.mjs の通し）。
// デーモンは AGENT_BROWSER_SOCKET_DIR の下に立ち、close で終わる（外の Chrome には何もしない。中継との接続を切るだけ）。CLI 自身が約 30 秒で読むのをやめるので、こちらの上限はその少し上。
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const WRAPPER = path.join(path.dirname(require.resolve('agent-browser/package.json')), 'bin', 'agent-browser.js');

/** @returns {Promise<{ status: number|null, stdout: string, stderr: string }>} */
export function runAgentBrowser(args, env, { timeoutMs = 45_000 } = {}) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [WRAPPER, ...args], { env: { ...process.env, ...env }, windowsHide: true });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const timer = setTimeout(() => child.kill(), timeoutMs);
    // 'close' ではなく 'exit' で終わる（CLI が起こしたデーモンが stdio を継いで開いたままにするため）。出力の残りを少し待つ
    child.on('exit', status => { clearTimeout(timer); setTimeout(() => resolve({ status, stdout, stderr }), 50); });
    child.on('error', error => { clearTimeout(timer); resolve({ status: null, stdout, stderr: String(error) }); });
  });
}
