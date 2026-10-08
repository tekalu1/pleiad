// Chrome・Edge のプロフィールの、画面とサーバーで共通の形（docs/inapp-browser.md「プロフィール」）。
// プロフィールは { browser: 'chrome' | 'edge', dir: フォルダー名 }。許可の記録などに 1 つの文字列で持つときは 'chrome:Profile 1'（profileKey）。
// 画面の文字は持たない（サーバーも読む）。メニューの中身は web/chrome-profile-menu.mjs

export const PROFILE_BROWSERS = ['chrome', 'edge'];
/** フォルダー名として受け付ける形（core/chrome/locate.mjs の PROFILE_DIR と同じ） */
export const PROFILE_DIR = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/;
const KEY = /^(chrome|edge):([A-Za-z0-9][A-Za-z0-9 ._-]{0,63})$/;
export const NOTE_MAX = 200;
export const NOTES_MAX = 50;

export const profileKey = ({ browser, dir }) => `${browser}:${dir}`;

/** 同名のプロフィールがあれば、選び分けられるようフォルダー名を添える */
export function profileLabel(profile, profiles) {
  const name = profile.name || profile.dir;
  return profiles.filter(p => p.browser === profile.browser && (p.name || p.dir) === name).length > 1 ? `${name} (${profile.dir})` : name;
}

/** 'chrome:Profile 1' → { browser, dir }。形が違えば null */
export function parseProfileKey(key) {
  const m = typeof key === 'string' ? KEY.exec(key) : null;
  return m ? { browser: m[1], dir: m[2] } : null;
}

/** { browser, dir } の形か（余計な項目は持たない） */
export function validProfileRef(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).every(k => k === 'browser' || k === 'dir')
    && PROFILE_BROWSERS.includes(value.browser) && typeof value.dir === 'string' && PROFILE_DIR.test(value.dir);
}

/** プロフィールのメモの一覧（[{ browser, dir, note }]。同じプロフィールは 1 行だけ） */
export function validProfileNotes(value) {
  if (!Array.isArray(value) || value.length > NOTES_MAX) return false;
  const seen = new Set();
  return value.every(row => {
    if (!row || typeof row !== 'object' || Array.isArray(row) || Object.keys(row).some(k => !['browser', 'dir', 'note'].includes(k))) return false;
    if (!validProfileRef({ browser: row.browser, dir: row.dir }) || typeof row.note !== 'string' || row.note.length > NOTE_MAX) return false;
    const key = profileKey(row);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** メモの一覧から、そのプロフィールのメモ（無ければ空） */
export function noteOf(notes, profile) {
  const key = profile ? profileKey(profile) : null;
  return (Array.isArray(notes) ? notes : []).find(row => row && profileKey(row) === key)?.note ?? '';
}

const BROWSER_LABEL = { chrome: 'Chrome', edge: 'Edge' };
export const browserLabel = browser => BROWSER_LABEL[browser] ?? browser;
