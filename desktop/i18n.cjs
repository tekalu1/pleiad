// Electron の main プロセスの多言語対応（docs/design.md「多言語対応」）。ダイアログ・通知・更新のエラー文。
// 辞書は画面・サーバーと同じ web/locales/<言語>/desktop.json（名前空間 desktop）。main は CJS なので fs で読む。
//
// 言語の決め方（サーバーの core/i18n.mjs の resolveLocale と同じ順）:
//   AGENT_HOST_LOCALE（テスト・手動での強制）
//   → prefs.json の locale（auto 以外。サーバーが起動する前でも、ここを読めば設定どおりに出せる）
//   → OS の言語（main.cjs が app.getPreferredSystemLanguages() / app.getLocale() を渡す。無ければ Node の Intl）
//   → en
// サーバーが起動したら ready の locale（サーバーが解決した ja|en）に合わせ、設定が変わると届く locale メッセージに追従する（main.cjs）。
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const i18next = require('i18next');

const LOCALES = ['ja', 'en'];
const FALLBACK = 'en';
const LOCALES_DIR = path.join(__dirname, '..', 'web', 'locales');

/** 言語タグを ja / en に丸める。空・auto は「決めていない」で null */
function roundLocale(tag) {
  const s = String(tag ?? '').trim().toLowerCase();
  if (!s || s === 'auto') return null;
  return s.split(/[-_.@]/)[0] === 'ja' ? 'ja' : 'en';
}

/** prefs.json の locale（auto|ja|en）。読めなければ null */
function prefsLocale(env = process.env) {
  try {
    const dir = env.AGENT_HOST_DATA ?? path.join(os.homedir(), '.agent-host');
    const value = JSON.parse(fs.readFileSync(path.join(dir, 'prefs.json'), 'utf8'))?.locale;
    return LOCALES.includes(value) ? value : null;
  } catch { return null; }
}

/** 実際に使う言語（ja|en）。system は OS の言語タグ */
function resolveLocale({ env = process.env, setting = prefsLocale(env), system } = {}) {
  let intl = '';
  try { intl = Intl.DateTimeFormat().resolvedOptions().locale; } catch { /* 無くても英語で動く */ }
  return roundLocale(env.AGENT_HOST_LOCALE) ?? (LOCALES.includes(setting) ? setting : null)
    ?? roundLocale(system) ?? roundLocale(env.AGENT_HOST_SYSTEM_LOCALE) ?? roundLocale(intl) ?? FALLBACK;
}

function readBundle(lng) {
  try { return JSON.parse(fs.readFileSync(path.join(LOCALES_DIR, lng, 'desktop.json'), 'utf8')); }
  catch { return {}; }
}

let current = resolveLocale();
const i18n = i18next.createInstance();
i18n.init({
  lng: current,
  fallbackLng: FALLBACK,
  supportedLngs: LOCALES,
  ns: ['desktop'],
  defaultNS: 'desktop',
  resources: Object.fromEntries(LOCALES.map(lng => [lng, { desktop: readBundle(lng) }])),
  initAsync: false,
  returnNull: false,
  returnEmptyString: false,
  interpolation: { escapeValue: false },
});

/** 今の言語 */
const currentLocale = () => current;

/** 言語を変える。AGENT_HOST_LOCALE があればそれが優先（テストを日本語に固定する） */
function setLocale(lng) {
  current = roundLocale(process.env.AGENT_HOST_LOCALE) ?? (LOCALES.includes(lng) ? lng : roundLocale(lng) ?? current);
  return current;
}

/** 訳文。lng を渡せばその言語で */
function t(key, options) {
  return i18n.t(key, { lng: current, ...options });
}

module.exports = { t, setLocale, currentLocale, resolveLocale, roundLocale, prefsLocale, LOCALES };
