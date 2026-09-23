// 多言語対応の server 段階（docs/design.md「多言語対応」）。
// core が画面へ返す文言が実行中の言語の切り替えに追従すること、desktop の main の辞書、
// 保存される文言（変更の理由・添付の見出し・既定のタイトル）の新しい形と、過去の記録をそのまま出すこと。
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import { t as serverT, setLocale, currentLocale } from "../../core/i18n.mjs";
import { MODES } from "../../core/backends/claude.mjs";
import * as ui from "../../web/i18n.mjs";
import { savedReason, savedCaption, savedEvent, savedTitle } from "../../web/saved-text.mjs";
import { startServer, ROOT } from "../lib/server.mjs";
import { open, sleep } from "../lib/ws-client.mjs";

const require = createRequire(import.meta.url);

export const name = "i18n-server";
export const title = "core・desktop の文言の言語切り替えと、保存される文言（理由・添付・既定のタイトル）";

export default async function (t) {
  // ---- core: 読み込んだ後で言語を変えても追従する（表はゲッター）
  const before = currentLocale();
  try {
    setLocale("en");
    t.ok("core のエラー文が英語になる", serverT("session.notFound") === "Session not found.");
    t.ok("承認モードの表示名も読み込み後の切り替えに追従する", MODES.default.label === "Ask each time" && MODES.acceptEdits.label === "Auto-accept edits");
    t.ok("件数は英語の複数形", serverT("updateLock.turns", { count: 1 }) === "1 conversation is running." && serverT("updateLock.turns", { count: 2 }) === "2 conversations are running.");
    setLocale("ja");
    t.ok("日本語に戻すと今の文言と同じ", serverT("session.notFound") === "セッションが見つかりません" && MODES.default.label === "都度確認"
      && serverT("updateLock.turns", { count: 3 }) === "実行中の会話が 3 件あります");
  } finally { setLocale(before); }

  // ---- desktop: main の辞書（AGENT_HOST_LOCALE の強制を外して切り替える）
  const desktop = require("../../desktop/i18n.cjs");
  const forced = process.env.AGENT_HOST_LOCALE;
  try {
    t.ok("desktop は AGENT_HOST_LOCALE に従う", desktop.currentLocale() === "ja" && desktop.t("notifications.completed") === "作業が完了しました");
    delete process.env.AGENT_HOST_LOCALE;
    desktop.setLocale("en");
    t.ok("desktop の文言が英語になる", desktop.t("quit.busyTitle") === "Work is still running" && desktop.t("update.busy") === "An update is in progress. Wait for it to finish.");
    const { AUTH_MESSAGE, authMessage } = require("../../desktop/update-auth.cjs");
    t.ok("更新の認証の文も今の言語", AUTH_MESSAGE === authMessage() && authMessage().startsWith("Checking for updates requires GitHub authentication."));
    t.ok("OS の言語で決める（設定・強制が無いとき）", desktop.resolveLocale({ env: {}, setting: null, system: "ja-JP" }) === "ja"
      && desktop.resolveLocale({ env: {}, setting: "en", system: "ja-JP" }) === "en" && desktop.resolveLocale({ env: { AGENT_HOST_LOCALE: "ja" }, setting: "en" }) === "ja");
    // 通知の見出しは画面が作って渡したもの。無いときだけ main の言語の既定
    const { createDesktopNotifications } = require("../../desktop/notifications.cjs");
    const shown = [];
    class Notice extends EventEmitter {
      static isSupported() { return true; }
      constructor(options) { super(); shown.push(options); }
      show() {}
    }
    const notify = createDesktopNotifications({ Notification: Notice, icon: "i.png", getWindow: () => null });
    notify({ sessionId: "a", completedAt: 1, title: "Finished", body: "x" });
    notify({ sessionId: "b", completedAt: 1, body: "y" });
    t.ok("通知の見出しは画面から渡された title を使う", shown[0]?.title === "Finished" && shown[1]?.title === "Work finished", JSON.stringify(shown));
  } finally {
    if (forced === undefined) delete process.env.AGENT_HOST_LOCALE; else process.env.AGENT_HOST_LOCALE = forced;
    desktop.setLocale("ja");
  }

  // ---- 画面: 保存される文言。キーがあれば今の言語、過去の記録は保存された文のまま
  const uiBefore = ui.lang;
  try {
    await ui.setLanguage("en");
    const row = { reason: "a.md・b.md ほか 2 件", reasonKey: "contextChangedMore", reasonParams: { names: ["a.md", "b.md"], count: 2 } };
    t.ok("理由はキーで今の言語に（配列は言語の区切り）", savedReason(row) === "a.md, b.md and 2 more", savedReason(row));
    t.ok("過去の記録（キー無し）は保存された文のまま", savedReason({ reason: "再開時に変更" }) === "再開時に変更" && savedReason({}) === "");
    t.ok("辞書に無いキーは保存された文へ落ちる", savedReason({ reason: "元の文", reasonKey: "noSuchKey" }) === "元の文");
    t.ok("添付の見出しもキーで訳す", savedCaption({ caption: "添付: x.png", captionKey: "attachment", captionParams: { name: "x.png" } }) === "Attachment: x.png");
    const ev = { type: "status", reason: "グループを作った", reasonKey: "createdGroup" };
    t.ok("イベントは複製して訳す（元は変えない）", savedEvent(ev).reason === "Created group" && ev.reason === "グループを作った" && savedEvent({ type: "x" }).type === "x");
    t.ok("既定のタイトルは空なら今の言語の既定名", savedTitle("") === "New session" && savedTitle("(no title)") === "New session" && savedTitle("作業") === "作業");
    await ui.setLanguage("ja");
    t.ok("日本語ではキーの訳が保存された文と同じ", savedReason(row) === row.reason && savedTitle("") === "新しいセッション");
  } finally { await ui.setLanguage(uiBefore); }

  // ---- サーバー: 新しい記録の形（fake バックエンド）
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "ply-i18n-server-"));
  let server, client;
  try {
    server = await startServer({ dataDir, env: { AGENT_HOST_BACKENDS: "fake" } });
    client = await open({ port: server.port, token: server.token });
    const { sessionId } = await client.cmd("newSession", { backend: "fake", cwd: ROOT });
    const listed = (await client.cmd("listSessions")).find((s) => s.id === sessionId);
    t.ok("新しいセッションは既定のタイトルを保存しない（空）", listed?.title === "", JSON.stringify(listed?.title));
    const mark = client.mark();
    await client.cmd("setStatus", { sessionId, status: "作業中", reasonKey: "menu", alone: true });
    await client.cmd("setStatus", { sessionId, status: "保留", reason: "自由な理由", alone: true });
    await client.cmd("setStatus", { sessionId, status: "完了", reason: "偽のキー", reasonKey: "../x", alone: true });
    await client.cmd("createStatus", { status: "新しい器" });
    await sleep(100);
    const events = client.since(mark).filter((e) => e.type === "status");
    t.ok("理由のキーはイベントにも載り、reason は日本語の文", events[0]?.reasonKey === "menu" && events[0]?.reason === "メニューから変更", JSON.stringify(events[0]));
    t.ok("キーの無い理由は文字列のまま", events[1]?.reason === "自由な理由" && !events[1]?.reasonKey);
    t.ok("辞書に無いキーは受けず、文字列の理由を使う", events[2]?.reason === "偽のキー" && !events[2]?.reasonKey);
    t.ok("グループを作った知らせもキー付き", events[3]?.reasonKey === "createdGroup" && events[3]?.reason === "グループを作った");
    const sessions = JSON.parse(await fs.readFile(path.join(dataDir, "sessions.json"), "utf8"));
    const history = sessions[sessionId]?.history?.filter((h) => h.field === "status") ?? [];
    t.ok("変更履歴に reason（日本語）と reasonKey が残る", history[0]?.reason === "メニューから変更" && history[0]?.reasonKey === "menu"
      && history[1]?.reason === "自由な理由" && !("reasonKey" in history[1]), JSON.stringify(history));
    const res = await fetch(`http://127.0.0.1:${server.port}/`, { headers: { connection: "close" } }).catch(() => null);
    t.ok("認証なしの応答は今の言語（日本語）", res?.status === 401 && (await res.text()) === "トークンが要る（起動時に出た URL を使う）");
  } finally {
    client?.close();
    await server?.stop();
    await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
  }
}
