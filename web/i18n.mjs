// 画面の多言語対応（docs/design.md「多言語対応」）。i18next の初期化・t()・静的 HTML の置き換え・日付と数の書き方。
//
// 言語はサーバーが決める（prefs.json の locale と OS の言語から解決した ja|en。ready と prefs イベントで届く）。
// ここではそれを待たずに、index.html のインライン script が localStorage の写しから先に決めた <html lang> で始める。
// 届いた言語と違えば client.mjs が写しを直してページを読み直す（途中で言語を差し替える経路は持たない）。
//
// 辞書は web/locales/<言語>/<名前空間>.json。画面は ui だけを読む。キーの名前空間を書かなければ ui。
// t() の結果は HTML としてエスケープしない（interpolation.escapeValue: false）。textContent で入れるか、escText を通す。
//
// トップレベルで辞書を読み終えてから抜けるので、import したモジュールは読み込みの時点から t() を使える。
// Node（テスト）では fetch の代わりにファイルを読む。i18next は index.html の import map で /vendor/i18next.mjs に向く。
import i18next from 'i18next';

export const LOCALES = ['ja', 'en'];
export const FALLBACK = 'en';
export const STORE_KEY = 'agent-host-lang';
const NAMESPACES = ['ui'];
const isNode = Boolean(globalThis.process?.versions?.node);

const pickLang = (v) => (LOCALES.includes(v) ? v : null);

/** 今の画面の言語。<html lang> が正（インライン script が写しから入れる）。無ければ日本語 */
export let lang = pickLang(globalThis.document?.documentElement?.lang) ?? 'ja';

const i18n = i18next.createInstance();
const loaded = new Set();

async function readBundle(lng, ns) {
  const url = new URL(`./locales/${lng}/${ns}.json`, import.meta.url);
  if (isNode) {
    const [{ readFile }, { fileURLToPath }] = await Promise.all([import('node:fs/promises'), import('node:url')]);
    return JSON.parse(await readFile(fileURLToPath(url), 'utf8'));
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url.pathname}: HTTP ${res.status}`);
  return res.json();
}

/** その言語の辞書を読む（読んだものは覚えておく）。読めなくても画面は動く（キーか英語が出る） */
async function ensure(lng) {
  if (loaded.has(lng)) return;
  loaded.add(lng);
  await Promise.all(NAMESPACES.map(async (ns) => {
    try { i18n.addResourceBundle(lng, ns, await readBundle(lng, ns), true, true); }
    catch (e) { console.warn(`辞書を読めない (${lng}/${ns}): ${e.message}`); }
  }));
}

await i18n.init({
  lng: lang,
  fallbackLng: FALLBACK,
  supportedLngs: LOCALES,
  ns: NAMESPACES,
  defaultNS: 'ui',
  resources: {},
  initAsync: false,
  returnNull: false,
  returnEmptyString: false,
  interpolation: { escapeValue: false },
});
await Promise.all([ensure(lang), ensure(FALLBACK)]);
if (!isNode && globalThis.document?.documentElement) document.documentElement.lang = lang;

/** 訳文。キーは意味のキー（例 'settings.appearance.language.title'）。ui 以外は 'server:…' のように名前空間を付ける */
export function t(key, options) {
  return i18n.t(key, { lng: lang, ...options });
}

/**
 * 言語を切り替える。画面では使わない（読み直す）。テストと、将来の部分的な切り替えのため。
 * @returns 切り替えた後の言語
 */
export async function setLanguage(lng) {
  const next = pickLang(lng) ?? FALLBACK;
  await ensure(next);
  lang = next;
  cache.clear();
  return lang;
}

/** 次に開いたときの最初の描画用に、言語を localStorage へ写す。書けたら true */
export function rememberLang(lng) {
  try {
    localStorage.setItem(STORE_KEY, lng);
    return localStorage.getItem(STORE_KEY) === lng;
  } catch { return false; }
}

/** 言語の名前。既定はその言語自身での名前（日本語 / English）。言語の選択肢に使う */
export function languageName(code, inLang = code) {
  try { return new Intl.DisplayNames([inLang], { type: 'language' }).of(code) ?? code; }
  catch { return code; }
}

const ATTRS = [['i18nTitle', 'title'], ['i18nAriaLabel', 'aria-label'], ['i18nPlaceholder', 'placeholder']];

/**
 * data-i18n（中身の文字）・data-i18n-title・data-i18n-aria-label・data-i18n-placeholder を訳文で埋める。
 * 値はキー。静的な index.html と、あとから innerHTML で作った塊に使う。
 */
export function applyDom(root = globalThis.document) {
  if (!root?.querySelectorAll) return;
  const nodes = [...(root.matches?.('[data-i18n],[data-i18n-title],[data-i18n-aria-label],[data-i18n-placeholder]') ? [root] : []),
    ...root.querySelectorAll('[data-i18n],[data-i18n-title],[data-i18n-aria-label],[data-i18n-placeholder]')];
  for (const node of nodes) {
    if (node.dataset.i18n) node.textContent = t(node.dataset.i18n);
    for (const [key, attr] of ATTRS) if (node.dataset[key]) node.setAttribute(attr, t(node.dataset[key]));
  }
}

// ---------------------------------------------------------------- 日付・数の書き方
// Intl.* を今の言語で包む。書式の組み立ては重いので、言語と指定の組ごとに 1 つだけ作る。

const cache = new Map();
function formatter(Kind, options) {
  const key = `${Kind.name}|${lang}|${JSON.stringify(options ?? {})}`;
  let f = cache.get(key);
  if (!f) cache.set(key, f = new Kind(lang, options));
  return f;
}

function toDate(when) {
  const d = when instanceof Date ? when : new Date(typeof when === 'string' && !/^\d+$/.test(when) ? when : Number(when));
  return Number.isNaN(d.getTime()) ? null : d;
}

// toLocaleString() と同じ並び（年・月・日・時・分・秒）
const DATE_TIME = { year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit' };
const TIME = { hour: '2-digit', minute: '2-digit' };

/** 経過した幅の単位。閾値は秒 */
const STEPS = [[60, 'second', 1], [3600, 'minute', 60], [86400, 'hour', 3600], [Infinity, 'day', 86400]];

export const fmt = {
  /** 数。桁区切りは言語に従う */
  number: (n, options) => formatter(Intl.NumberFormat, options).format(Number(n)),
  /** 日時。既定は年月日と時分秒。日時として読めなければ空 */
  dateTime(when, options = DATE_TIME) {
    const d = toDate(when);
    return d ? formatter(Intl.DateTimeFormat, options).format(d) : '';
  },
  /** 時刻。既定は 2 桁の時・分 */
  time(when, options = TIME) {
    const d = toDate(when);
    return d ? formatter(Intl.DateTimeFormat, options).format(d) : '';
  },
  /** 並べる。「A、B、C」「A, B, and C」 */
  list: (items, options = { type: 'conjunction' }) => formatter(Intl.ListFormat, options).format([...items].map(String)),
  /**
   * 経過した幅。「3分」「5時間」「2日」。ms でも ISO でも受ける。
   * 「〜経過」「〜待っている」のように後ろへ語を続けるときはこちら
   */
  elapsed(when, now = Date.now()) {
    const t0 = typeof when === 'number' ? when : when ? Date.parse(when) : NaN;
    if (!Number.isFinite(t0)) return '';
    const sec = Math.max(0, Math.round((now - t0) / 1000));
    const [, unit, size] = STEPS.find(([limit]) => sec < limit);
    // i18n-dynamic: time.elapsed.
    return t(`time.elapsed.${unit}`, { count: Math.round(sec / size) });
  },
  /** 相対時刻。「たった今」「3分前」。一覧の行と候補の補足に */
  relative(when, now = Date.now()) {
    const t0 = typeof when === 'number' ? when : when ? Date.parse(when) : NaN;
    if (!Number.isFinite(t0)) return '';
    if (now - t0 < 59_500) return t('time.justNow');
    return t('time.ago', { elapsed: fmt.elapsed(t0, now) });
  },
  /** たった今（まだ時刻を持たないもの） */
  justNow: () => t('time.justNow'),
};
