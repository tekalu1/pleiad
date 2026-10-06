// Chrome の User Data の場所と、DevToolsActivePort の読み取り（docs/inapp-browser.md「Chrome への接続」、ADR 0148・0153）。
// OS で違うのは場所の表だけ。ほかの OS を足すときはここの表に 1 行足す（層の実装は desktop/chrome-os/<os>.cjs）。
// Pleiad が読む Chrome のファイルは DevToolsActivePort と、Local State の profile.last_used（専用の窓を開くプロフィール。第 4 段）だけ。
// プロフィール名の一覧（profile.info_cache の name）は第 9 段。Cookie・履歴・パスワードは読まない。
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

/** 環境変数 AGENT_HOST_CHROME_USER_DATA があればそれだけ（テスト用。OS に依らない） */
const TEST_ENV = 'AGENT_HOST_CHROME_USER_DATA';

/**
 * 今の OS で使える Chrome の User Data（今は Windows だけ。ほかの OS は空 = 使えない）
 * custom は環境変数で差し替えた User Data（chrome.exe に --user-data-dir を付ける。付けないと既定の User Data の Chrome に窓が開く）
 * @returns {{ browser: 'chrome', userDataDir: string, custom?: true }[]}
 */
export function chromeHomes({ platform = process.platform, env = process.env } = {}) {
  if (env[TEST_ENV]) return [{ browser: 'chrome', userDataDir: env[TEST_ENV], custom: true }];
  if (platform === 'win32') {
    const base = env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return [{ browser: 'chrome', userDataDir: path.join(base, 'Google', 'Chrome', 'User Data') }];
  }
  return [];
}

const WS_PATH = /^\/devtools\/browser\/[A-Za-z0-9-]+$/;

/**
 * `chrome://inspect/#remote-debugging` をオンにした Chrome が書くファイル。1 行目がポート、2 行目が ws の経路。
 * 形が合わなければ null（ファイルが無い・形が違う・ポートが範囲外のどれも「準備ができていない」と同じに扱う）
 * @returns {Promise<{ port: number, path: string } | null>}
 */
export async function readActivePort(userDataDir) {
  let text;
  try { text = await fs.readFile(path.join(userDataDir, 'DevToolsActivePort'), 'utf8'); }
  catch { return null; }
  const [first = '', second = ''] = text.split(/\r?\n/);
  if (!/^\d{1,5}$/.test(first.trim())) return null;
  const port = Number(first.trim());
  const wsPath = second.trim();
  if (port < 1 || port > 65535 || !WS_PATH.test(wsPath)) return null;
  return { port, path: wsPath };
}

const PROFILE_DIR = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/;
export const DEFAULT_PROFILE = 'Default';

/**
 * 専用の窓を開くプロフィールのフォルダー名。Local State の `profile.last_used`（最後に使ったプロフィール）だけを読む。
 * ほかの項目（プロフィール名・アカウント・設定）は取り出さない。読めない・形が違うときは Default
 */
export async function readLastUsedProfile(userDataDir) {
  try {
    const state = JSON.parse(await fs.readFile(path.join(userDataDir, 'Local State'), 'utf8'));
    const value = state?.profile?.last_used;
    return typeof value === 'string' && PROFILE_DIR.test(value) ? value : DEFAULT_PROFILE;
  } catch { return DEFAULT_PROFILE; }
}
