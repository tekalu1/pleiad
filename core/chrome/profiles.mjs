// Chrome・Edge のプロフィールの一覧（docs/inapp-browser.md「プロフィール」、第 10 段）。
// Local State の profile.info_cache から、フォルダー名（キー）と表示名（name）だけを取り出す。
// アカウント・メールアドレス・アイコン・そのほかの項目は取り出さず、返り値にもログにも載せない。Cookie・履歴・パスワードも読まない。
import fs from 'node:fs/promises';
import path from 'node:path';
import { PROFILE_DIR, DEFAULT_PROFILE } from './locate.mjs';

export const PROFILE_BROWSERS = /** @type {const} */ (['chrome', 'edge']);
const NAME_MAX = 100;

/** 表示名を画面に出せる形にする（制御文字を除き、長さをそろえる。空ならフォルダー名） */
function displayName(value, dir) {
  if (typeof value !== 'string') return dir;
  const name = value.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, '').trim().slice(0, NAME_MAX);
  return name || dir;
}

const byDir = (a, b) => (a.dir === DEFAULT_PROFILE ? -1 : b.dir === DEFAULT_PROFILE ? 1 : a.dir.localeCompare(b.dir, 'en', { numeric: true }));

/**
 * Local State の文字列から、プロフィールの { dir, name } だけを取り出す（Default を先頭に、Profile 2 < Profile 10 の順）。
 * 形が違う・壊れているときは空
 * @returns {{ dir: string, name: string }[]}
 */
export function parseProfiles(text) {
  let cache;
  try { cache = JSON.parse(text)?.profile?.info_cache; } catch { return []; }
  if (!cache || typeof cache !== 'object' || Array.isArray(cache)) return [];
  const rows = [];
  for (const [dir, entry] of Object.entries(cache)) {
    if (!PROFILE_DIR.test(dir) || !entry || typeof entry !== 'object') continue;
    rows.push({ dir, name: displayName(entry.name, dir) });
  }
  return rows.sort(byDir);
}

/** User Data の Local State を読んでプロフィールの一覧を返す。読めなければ空 */
export async function readProfiles(userDataDir) {
  if (!userDataDir) return [];
  try { return parseProfiles(await fs.readFile(path.join(userDataDir, 'Local State'), 'utf8')); }
  catch { return []; }
}

/**
 * 一覧に出すブラウザーごとのプロフィール。connected(browser) が真のブラウザーだけを読む
 * （Edge は接続ができるまで一覧に出さない。読めるだけで開けないプロフィールを選ばせない）
 * @param {{ browser: string, userDataDir: string }[]} homes  core/chrome/locate.mjs の chromeHomes
 * @returns {Promise<{ browser: string, dir: string, name: string }[]>}
 */
export async function listBrowserProfiles({ homes = [], connected = () => true } = {}) {
  const out = [];
  const seen = new Set();
  for (const home of homes) {
    if (!PROFILE_BROWSERS.includes(home?.browser) || seen.has(home.browser) || !connected(home.browser)) continue;
    seen.add(home.browser);
    for (const row of await readProfiles(home.userDataDir)) out.push({ browser: home.browser, ...row });
  }
  return out;
}
