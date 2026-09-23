// 多言語対応の土台（docs/design.md「多言語対応」）。
// 言語の解決（強制 → 設定 → OS → en）、画面の書式（fmt）の ja / en の出力、辞書の引き当て、
// サーバーの setPref locale と ready・prefs イベントに言語が載ること。
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { roundLocale, resolveLocale, systemLocale, localeInfo, t as serverT, setLocale, currentLocale } from "../../core/i18n.mjs";
import * as ui from "../../web/i18n.mjs";
import { startServer } from "../lib/server.mjs";
import { open } from "../lib/ws-client.mjs";

export const name = "i18n";
export const title = "言語の解決・日付と数の書き方（ja / en）・setPref locale と ready";

/** クッキーのトークンを付けて GET。fetch は使わない（終了時に keep-alive の接続が残り、Windows の Node が落ちる） */
function get(port, pathname, token) {
  return new Promise((resolve, reject) => {
    http.get({ host: "127.0.0.1", port, path: pathname, agent: false, headers: { cookie: `agent_host_token=${token}` } }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (d) => { body += d; });
      res.on("end", () => resolve({ ok: res.statusCode === 200, type: res.headers["content-type"] ?? "", body }));
    }).on("error", reject);
  });
}

export default async function (t) {
  // ---- 言語の解決
  t.ok("言語タグを ja / en に丸める", roundLocale("ja-JP") === "ja" && roundLocale("ja_JP.UTF-8") === "ja" && roundLocale("en-GB") === "en" && roundLocale("fr-FR") === "en");
  t.ok("空と auto は決めていない扱い", roundLocale("") === null && roundLocale("auto") === null && roundLocale(undefined) === null);
  t.ok("強制（AGENT_HOST_LOCALE）は設定より優先", resolveLocale("ja", { AGENT_HOST_LOCALE: "en" }) === "en");
  t.ok("設定が auto 以外ならそれを使う", resolveLocale("en", { AGENT_HOST_SYSTEM_LOCALE: "ja-JP" }) === "en");
  t.ok("auto はデスクトップが渡す OS の言語", resolveLocale("auto", { AGENT_HOST_SYSTEM_LOCALE: "ja-JP" }) === "ja" && resolveLocale("auto", { AGENT_HOST_SYSTEM_LOCALE: "en-US" }) === "en");
  t.ok("ja / en 以外の OS は英語", resolveLocale("auto", { AGENT_HOST_SYSTEM_LOCALE: "de-DE" }) === "en");
  const intl = roundLocale(Intl.DateTimeFormat().resolvedOptions().locale) ?? "en";
  t.ok("OS の言語が渡されなければ Node の Intl から", systemLocale({}) === intl && resolveLocale(undefined, {}) === intl, intl);
  t.ok("画面へ配る形は設定値と解決後", JSON.stringify(localeInfo({ locale: "en" }, {})) === JSON.stringify({ setting: "en", lang: "en" })
    && localeInfo({}, { AGENT_HOST_SYSTEM_LOCALE: "ja" }).setting === "auto" && localeInfo({ locale: "xx" }, {}).setting === "auto");

  // ---- サーバーの辞書
  const before = currentLocale();
  setLocale("en");
  const en = serverT("errors.unknownLocale", { value: "fr" });
  setLocale("ja");
  const ja = serverT("errors.unknownLocale", { value: "fr" });
  setLocale(before);
  t.ok("サーバーの t() は言語ごとに引ける", en === "Unknown language: fr" && ja === "知らない言語: fr", `${en} / ${ja}`);

  // ---- 画面の書式。ja は今までの表記を保つ
  const now = Date.UTC(2026, 8, 23, 3, 0, 0);
  const at = new Date(2026, 8, 23, 9, 5, 7);
  try {
    await ui.setLanguage("ja");
    const rel = [ui.fmt.relative(now - 5_000, now), ui.fmt.relative(now - 3 * 60_000, now), ui.fmt.relative(now - 5 * 3600_000, now), ui.fmt.relative(now - 2 * 86400_000, now)].join(",");
    t.ok("ja: たった今 / N分前 / N時間前 / N日前", rel === "たった今,3分前,5時間前,2日前", rel);
    t.ok("ja: 経過した幅は「45秒」「3分」", ui.fmt.elapsed(now - 45_000, now) === "45秒" && ui.fmt.elapsed(now - 3 * 60_000, now) === "3分");
    t.ok("ja: 数は桁区切り", ui.fmt.number(1234567) === "1,234,567");
    t.ok("ja: 日時は toLocaleString('ja-JP') と同じ", ui.fmt.dateTime(at) === at.toLocaleString("ja-JP"), ui.fmt.dateTime(at));
    t.ok("ja: 時刻は 2 桁の時:分", ui.fmt.time(at) === "09:05", ui.fmt.time(at));
    t.ok("ja: 月/日 時:分", ui.fmt.dateTime(at, { month: "numeric", day: "numeric", hour: "numeric", minute: "2-digit" }) === "9/23 9:05");
    t.ok("日時として読めないものは空", ui.fmt.dateTime("not a date") === "" && ui.fmt.relative(undefined) === "");
    t.ok("ja: 辞書を引ける", ui.t("settings.appearance.language.title") === "言語");

    await ui.setLanguage("en");
    t.ok("en: just now / 3m ago", ui.fmt.relative(now - 5_000, now) === "just now" && ui.fmt.relative(now - 3 * 60_000, now) === "3m ago", ui.fmt.relative(now - 3 * 60_000, now));
    // AM の前の空白は ICU の版で違う（通常の空白か U+202F）ので、同じ Node の toLocaleString と比べる
    t.ok("en: 日時は英語の並び", ui.fmt.dateTime(at) === at.toLocaleString("en") && /^9\/23\/2026, 9:05:07\sAM$/u.test(ui.fmt.dateTime(at)), ui.fmt.dateTime(at));
    t.ok("en: 並べる", ui.fmt.list(["a", "b", "c"]) === "a, b, and c");
    t.ok("en: 差し込み", ui.t("settings.appearance.language.current", { lang: "English" }) === "Showing in English");
    t.ok("言語の名前はその言語自身で", ui.languageName("ja") === "日本語" && ui.languageName("en") === "English");
    t.ok("知らない言語は英語へ", (await ui.setLanguage("fr")) === "en");
  } finally {
    await ui.setLanguage("ja");
  }

  // ---- サーバー: ready・setPref locale・prefs イベント
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "agent-host-i18n-"));
  // 強制を外し、OS の言語をデスクトップ版と同じ経路で渡す
  const server = await startServer({ dataDir: scratch, env: { AGENT_HOST_BACKENDS: "fake", AGENT_HOST_LOCALE: "", AGENT_HOST_SYSTEM_LOCALE: "en-US" } });
  const c = await open({ port: server.port, token: server.token });
  try {
    t.ok("ready に言語が載る（auto で OS の英語）", c.ready.locale?.setting === "auto" && c.ready.locale?.lang === "en", JSON.stringify(c.ready.locale));
    const from = c.mark();
    const prefs = await c.cmd("setPref", { key: "locale", value: "ja" });
    t.ok("setPref locale を保存する", prefs.locale === "ja");
    const ev = await c.waitFor((e) => e.type === "prefs", { from, ms: 5000 });
    t.ok("prefs イベントに設定値と解決後が載る", ev.locale?.setting === "ja" && ev.locale?.lang === "ja", JSON.stringify(ev.locale));
    const saved = JSON.parse(await fs.readFile(path.join(scratch, "prefs.json"), "utf8"));
    t.ok("prefs.json に locale", saved.locale === "ja");
    const bad = await c.cmd("setPref", { key: "locale", value: "fr" }).then(() => null, (e) => e.message);
    t.ok("知らない値は断る（サーバーの言語で）", bad === "知らない言語: fr", bad);
    await c.cmd("setPref", { key: "locale", value: "auto" });
    const again = await open({ port: server.port, token: server.token });
    t.ok("auto に戻すと OS の言語", again.ready.locale?.setting === "auto" && again.ready.locale?.lang === "en", JSON.stringify(again.ready.locale));
    again.close();
  } finally {
    c.close();
    await server.stop();
  }
  // 強制は設定より強い（テストの既定の AGENT_HOST_LOCALE=ja）
  const forced = await startServer({ dataDir: scratch, env: { AGENT_HOST_BACKENDS: "fake", AGENT_HOST_LOCALE: "ja", AGENT_HOST_SYSTEM_LOCALE: "en-US" } });
  const f = await open({ port: forced.port, token: forced.token });
  try {
    t.ok("AGENT_HOST_LOCALE=ja は OS が英語でも日本語", f.ready.locale?.lang === "ja", JSON.stringify(f.ready.locale));
    const res = await get(forced.port, "/locales/en/ui.json", forced.token);
    t.ok("辞書を JSON として配る", res.ok && /application\/json/.test(res.type) && JSON.parse(res.body).time?.justNow === "just now", res.type);
    const lib = await get(forced.port, "/vendor/i18next.mjs", forced.token);
    t.ok("i18next を配る", lib.ok && /javascript/.test(lib.type) && /createInstance/.test(lib.body), lib.type);
  } finally {
    f.close();
    await forced.stop();
    await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}
