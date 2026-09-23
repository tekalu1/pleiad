// サーバー側の多言語対応（docs/design.md「多言語対応」）。辞書は画面と同じ web/locales/<言語>/<名前空間>.json を読む。
// i18next のインスタンスは画面（web/i18n.mjs）とは別。サーバーは全体で 1 つの言語を持つ（ローカルの 1 人の利用者が前提）。
//
// 言語の解決（resolveLocale）:
//   AGENT_HOST_LOCALE（テスト・手動での強制。設定より優先）
//   → prefs.json の locale（auto 以外）
//   → AGENT_HOST_SYSTEM_LOCALE（デスクトップ版が OS の言語を渡す。desktop/main.cjs）
//   → Node の Intl が知っている OS の言語
//   → en
// どれも先頭の言語サブタグで ja / en に丸める。ja 以外の言語は英語で出す。
//
// 名前空間: server（画面へ返す文言。既定）・agent（エージェントに渡す文）・desktop（Electron）・ui（画面）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import i18next from 'i18next';

export const LOCALES = ['ja', 'en'];
export const LOCALE_SETTINGS = ['auto', ...LOCALES];
export const FALLBACK = 'en';
export const LOCALES_DIR = fileURLToPath(new URL('../web/locales/', import.meta.url));

/** 言語タグを ja / en に丸める。空・auto は「決めていない」で null */
export function roundLocale(tag) {
  const s = String(tag ?? '').trim().toLowerCase();
  if (!s || s === 'auto') return null;
  return s.split(/[-_.@]/)[0] === 'ja' ? 'ja' : 'en';
}

/** OS の言語（設定と強制を見ない） */
export function systemLocale(env = process.env) {
  let intl = '';
  try { intl = Intl.DateTimeFormat().resolvedOptions().locale; } catch { /* Intl が無くても英語で動く */ }
  return roundLocale(env.AGENT_HOST_SYSTEM_LOCALE) ?? roundLocale(intl) ?? FALLBACK;
}

/** 実際に使う言語（ja|en）。setting は prefs.json の locale */
export function resolveLocale(setting, env = process.env) {
  return roundLocale(env.AGENT_HOST_LOCALE) ?? (LOCALES.includes(setting) ? setting : null) ?? systemLocale(env);
}

/** 画面へ配る形。setting は設定値（無ければ auto）、lang は解決後 */
export function localeInfo(prefs, env = process.env) {
  const setting = LOCALE_SETTINGS.includes(prefs?.locale) ? prefs.locale : 'auto';
  return { setting, lang: resolveLocale(setting, env) };
}

/** 辞書を全部読む。{ ja: { server: {...}, ... }, en: {...} } */
export function readResources(dir = LOCALES_DIR) {
  const resources = {};
  for (const lng of LOCALES) {
    resources[lng] = {};
    let files = [];
    try { files = fs.readdirSync(path.join(dir, lng)).filter((f) => f.endsWith('.json')); } catch { /* 無ければ空 */ }
    for (const f of files) resources[lng][f.slice(0, -5)] = JSON.parse(fs.readFileSync(path.join(dir, lng, f), 'utf8'));
  }
  return resources;
}

const resources = readResources();
const i18n = i18next.createInstance();
i18n.init({
  lng: resolveLocale('auto'),
  fallbackLng: FALLBACK,
  supportedLngs: LOCALES,
  ns: [...new Set(Object.values(resources).flatMap((r) => Object.keys(r)))],
  defaultNS: 'server',
  resources,
  initAsync: false,
  returnNull: false,
  returnEmptyString: false,
  interpolation: { escapeValue: false },
});

let current = resolveLocale('auto');

/** 今の言語 */
export const currentLocale = () => current;

/** サーバーの言語を変える（起動時と設定を変えたとき）。丸めてから持つ */
export function setLocale(lng) {
  current = LOCALES.includes(lng) ? lng : roundLocale(lng) ?? FALLBACK;
  return current;
}

/** 訳文。名前空間を書かなければ server。lng を渡せばその言語で */
export function t(key, options) {
  return i18n.t(key, { lng: current, ...options });
}

export { i18n };
