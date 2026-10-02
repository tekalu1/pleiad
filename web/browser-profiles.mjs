// 内蔵ブラウザーのプロフィール（docs/inapp-browser.md「プロフィール」、ADR 0078）。画面とサーバーが共有する、設定の値の読み方と検査。
//   - 一覧は prefs の browserProfiles（[{ id, name?, memo? }]）。メイン（id: main）は常に先頭にあり、今までの保存領域 persist:pleiad-browser を使う。
//     名前を付けていないメインは画面の言語で「メイン」と出す（name を持たない）
//   - 既定は browserDefaultProfile（無い・消えた id ならメイン）。新しい会話のプロフィールは browserNewProfile（last: 作業フォルダーで最後に使ったもの / default: 既定）
//   - 作業フォルダーごとに最後に使ったものは browserLastProfiles（{ フォルダーの鍵: id }）。サーバーだけが書く
// 保存領域の名前（partition）は main が id から作る（desktop/browser-panel.cjs の partitionOf）。ここでは id の形だけを決める。
export const MAIN_PROFILE = 'main';
export const NEW_PROFILE_RULES = ['last', 'default'];
export const MAX_PROFILES = 20;
export const NAME_MAX = 40;
export const MEMO_MAX = 200;
const ID = /^(?:main|p[0-9a-f]{8,32})$/;

/** プロフィールの id として受けてよいか（main か p + 16 進） */
export const validProfileId = id => typeof id === 'string' && ID.test(id);

/** 新しいプロフィールの id。random は 16 進の文字列を返す関数（画面は crypto.getRandomValues、テストは固定） */
export function newProfileId(random = () => [...crypto.getRandomValues(new Uint8Array(6))].map(b => b.toString(16).padStart(2, '0')).join('')) {
  return `p${random()}`;
}

const cleanText = (value, max) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) : '';

/** 設定の一覧を読む形にそろえる。メインを先頭に必ず置き、形の悪い行・重複は落とす */
export function profileList(prefs = {}) {
  const rows = Array.isArray(prefs.browserProfiles) ? prefs.browserProfiles : [];
  const seen = new Set(), out = [];
  const main = rows.find(row => row?.id === MAIN_PROFILE);
  out.push({ id: MAIN_PROFILE, ...(cleanText(main?.name, NAME_MAX) ? { name: cleanText(main.name, NAME_MAX) } : {}), ...(cleanText(main?.memo, MEMO_MAX) ? { memo: cleanText(main.memo, MEMO_MAX) } : {}) });
  seen.add(MAIN_PROFILE);
  for (const row of rows) {
    if (!row || !validProfileId(row.id) || seen.has(row.id) || out.length >= MAX_PROFILES) continue;
    const name = cleanText(row.name, NAME_MAX);
    if (!name) continue;
    seen.add(row.id);
    out.push({ id: row.id, name, ...(cleanText(row.memo, MEMO_MAX) ? { memo: cleanText(row.memo, MEMO_MAX) } : {}) });
  }
  return out;
}

export const profileIds = prefs => profileList(prefs).map(row => row.id);
export const hasProfile = (prefs, id) => profileIds(prefs).includes(id);

/** 既定のプロフィール。設定に無い・消えた id ならメイン */
export function defaultProfile(prefs = {}) {
  return hasProfile(prefs, prefs.browserDefaultProfile) ? prefs.browserDefaultProfile : MAIN_PROFILE;
}

export const newProfileRule = (prefs = {}) => NEW_PROFILE_RULES.includes(prefs.browserNewProfile) ? prefs.browserNewProfile : 'last';

/** 作業フォルダーの鍵（Windows は大文字と小文字を区別しない）。空なら null */
export function folderKey(cwd, platform = typeof process !== 'undefined' ? process.platform : '') {
  if (typeof cwd !== 'string' || !cwd.trim()) return null;
  const key = cwd.trim().replace(/[\\/]+$/, '') || cwd.trim();
  return platform === 'win32' ? key.replace(/\//g, '\\').toLowerCase() : key;
}

/** 新しい会話（とプロフィールを持たない会話）のプロフィール: 設定が last なら作業フォルダーで最後に使ったもの、無ければ既定 */
export function profileForNew(prefs = {}, cwd = null, platform) {
  if (newProfileRule(prefs) === 'last') {
    const key = folderKey(cwd, platform);
    const last = key ? prefs.browserLastProfiles?.[key] : null;
    if (hasProfile(prefs, last)) return last;
  }
  return defaultProfile(prefs);
}

/** 画面に出す名前。名前を付けていないメインは mainName（画面の言語の「メイン」） */
export function profileName(row, mainName = 'Main') {
  if (!row) return mainName;
  return row.name || (row.id === MAIN_PROFILE ? mainName : row.id);
}

/** 頭文字 1 字（モノグラム）。サロゲートペア・結合文字を割らない */
export function monogram(name) {
  const first = [...String(name ?? '').trim()][0] ?? '?';
  return first.toUpperCase();
}

/** setPref の値の検査。browserProfiles は一覧の形、browserDefaultProfile は一覧にある id、browserNewProfile は 2 択 */
export function validProfilePref(key, value, prefs = {}) {
  if (key === 'browserNewProfile') return NEW_PROFILE_RULES.includes(value);
  if (key === 'browserDefaultProfile') return validProfileId(value) && hasProfile(prefs, value);
  if (key !== 'browserProfiles') return false;
  if (!Array.isArray(value) || value.length > MAX_PROFILES || !value.some(row => row?.id === MAIN_PROFILE)) return false;
  const ids = new Set();
  return value.every(row => {
    if (!row || typeof row !== 'object' || !validProfileId(row.id) || ids.has(row.id)) return false;
    ids.add(row.id);
    if (Object.keys(row).some(k => !['id', 'name', 'memo'].includes(k))) return false;
    if (row.name !== undefined && (typeof row.name !== 'string' || row.name.length > NAME_MAX)) return false;
    if (row.id !== MAIN_PROFILE && !cleanText(row.name, NAME_MAX)) return false;
    if (row.memo !== undefined && (typeof row.memo !== 'string' || row.memo.length > MEMO_MAX)) return false;
    return true;
  });
}

/** 「このサイトは常に」の行がそのプロフィールのものか。プロフィールを持たない古い行はメインのもの（ADR 0078） */
export const siteProfile = row => validProfileId(row?.profile) ? row.profile : MAIN_PROFILE;
