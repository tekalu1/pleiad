// デスクトップの本体（main）が出す文言（docs/design.md「多言語対応」）。辞書は web/locales/<言語>/desktop.json。
// i18next のインスタンスはサーバーと同じ core/i18n.mjs を使う（main の中の core/remote/device.mjs も同じものを引く）。
//
// 言語: AGENT_HOST_LOCALE（強制）→ データ置き場の prefs.json の locale（画面の設定）→ OS の表示言語 → en。
// 本体はサーバーとは別のプロセスなので、設定を変えた直後は次の起動（または窓を開き直したとき）から効く。
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let core = null;

/** 画面の言語の設定（prefs.json の locale）。読めなければ auto */
function savedLocaleSetting(env = process.env) {
  try {
    const dir = env.AGENT_HOST_DATA ?? path.join(os.homedir(), '.agent-host');
    const { locale } = JSON.parse(fs.readFileSync(path.join(dir, 'prefs.json'), 'utf8'));
    return typeof locale === 'string' ? locale : 'auto';
  } catch { return 'auto'; }
}

/** core/i18n.mjs を読み、言語を決める。systemLanguage は OS の表示言語（例 ja-JP） */
async function initDesktopI18n({ systemLanguage = '', env = process.env } = {}) {
  core ??= await import('../core/i18n.mjs');
  core.setLocale(core.resolveLocale(savedLocaleSetting(env), { ...env, AGENT_HOST_SYSTEM_LOCALE: systemLanguage || env.AGENT_HOST_SYSTEM_LOCALE || '' }));
  return core.currentLocale();
}

/** 訳文。名前空間は desktop。初期化の前はキーをそのまま返す */
function t(key, options) {
  if (!core) return key;
  return core.t(key, { ns: 'desktop', ...options });
}

/** 今の言語の desktop の辞書を丸ごと返す（同梱の窓へ渡す。キーは t() と同じ書き方）。{{name}} は画面が埋める */
function bundle() {
  if (!core) return { lang: 'en', strings: {} };
  const lng = core.currentLocale();
  return { lang: lng, strings: core.i18n.getResourceBundle(lng, 'desktop') ?? core.i18n.getResourceBundle('en', 'desktop') ?? {} };
}

const currentLocale = () => core?.currentLocale() ?? 'en';

module.exports = { initDesktopI18n, t, bundle, currentLocale, savedLocaleSetting };
