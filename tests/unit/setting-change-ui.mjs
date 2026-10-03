// 設定の変更の承認カードの中身（web/setting-change.mjs。ADR 0082、docs/design-system.md「設定の変更の承認カード」）と通知の見出し。
// 型は computer use の承認カードと同じ（承認を待っている・太字の一文・設定画面と同じ名前と値・理由・⚠・ボタンは「拒否」と「変更を許可」）。
// 置き場と押したときの動き（受領証つきの resolvePermission・畳み方）は実ブラウザーで見る（tests/browser/setting-approval.cjs）。
//
// DOM シムは tests/run.mjs が入口で入れている。
import { approvalChange, changeBody, changeHeading, changeNotice, changeWord } from "../../web/setting-change.mjs";
import { createCompletionNotifications } from "../../web/notifications.mjs";
import { parseSettingNotices } from "../../web/task-notice.mjs";
import { readFileSync } from "node:fs";

export const name = "setting-change-ui";
export const title = "設定の変更の承認カード: payload の読み方・中身（前後は等幅・理由・⚠）・操作ごとの言葉・通知の見出し・辞書";

const text = (node) => String(node?.textContent ?? "").replace(/\s+/g, " ").trim();
const payload = {
  op: "settings.set", key: "confirmAgentSites", words: "setting", agent: { id: "claude", label: "Claude" }, loosens: true, receipt: "a".repeat(32), reason: "確認が多すぎるため",
  rows: [{ path: "confirmAgentSites", before: "true", after: "false" }],
};

export default async function (t) {
  const c = approvalChange(payload);
  t.ok("payload を表示の形にする（エージェント名・項目・受領証・理由・⚠）", c.agent === "Claude" && c.key === "confirmAgentSites" && c.rows.length === 1 && c.receipt === "a".repeat(32) && c.loosens === true && c.reason === "確認が多すぎるため");
  t.ok("見出しは「{エージェント名} が設定を変えようとしています」", changeHeading(c) === "Claude が設定を変えようとしています", changeHeading(c));
  t.ok("エージェント名が無ければ「エージェント」", approvalChange({ ...payload, agent: undefined }).agent === "エージェント");
  t.ok("項目も説明も無い payload は null（ふつうの承認として出す）", approvalChange({ rows: [] }) === null && approvalChange(null) === null && approvalChange("x") === null);
  t.ok("読めない行は捨てる。前後が文字列でなければ null（未設定）", approvalChange({ ...payload, rows: [{ path: "a", before: 1, after: "x" }, { nope: 1 }] }).rows.length === 1
    && approvalChange({ ...payload, rows: [{ path: "a", before: 1, after: "x" }] }).rows[0].before === null);
  t.ok("通知の見出しは設定画面での名前", changeNotice(c) === "Claude が設定「エージェントがサイトを使う前に確認」の変更の許可を待っています", changeNotice(c));

  t.ok("項目は設定画面の名前・節・値の言い方（オン/オフ）。キーは出さない", c.rows[0].name === "エージェントがサイトを使う前に確認" && c.rows[0].section === "ブラウザー" && c.rows[0].before === "オン" && c.rows[0].after === "オフ" && !c.rows[0].mono);
  t.ok("辞書に無い項目は名前の代わりにキーを等幅で出す。節は分かれば出す", approvalChange({ ...payload, rows: [{ path: "zzz", before: "1", after: "2" }] }).rows[0].mono === true
    && approvalChange({ ...payload, rows: [{ path: "delegationRouting.mode", before: "1", after: "2" }] }).rows[0].section === "委譲");

  const body = changeBody(c);
  const keyEl = body.querySelector(".ap-key");
  t.ok("中身: ラベル・一文・節（1 度）・名前・前後（前は取り消し線・後ろが現在）・理由・⚠", text(body.querySelector(".lbl")) === "設定" && text(body.querySelector(".q")) === "Claude が設定を変えようとしています"
    && text(body).includes("設定 › ブラウザー") && text(keyEl) === "エージェントがサイトを使う前に確認" && !keyEl.className.includes("mono")
    && text(body.querySelector(".ap-was")) === "オン" && text(body.querySelector(".ap-now")) === "オフ"
    && text(body).includes("理由: 確認が多すぎるため") && text(body.querySelector(".warn")) === "⚠ 確認なしでできることが増える変更です。");
  t.ok("キー名と内部の語（関所）は出さない", !text(body).includes("confirmAgentSites") && !text(body).includes("関所") && !text(body).includes("true"));
  t.ok("確認を減らさない変更には ⚠ を出さない。理由が無ければ出さない", changeBody({ ...c, loosens: false, reason: "" }).querySelector(".warn") === null
    && !text(changeBody({ ...c, loosens: false, reason: "" })).includes("理由"));
  const unset = changeBody({ ...c, rows: [{ ...c.rows[0], before: null }] });
  t.ok("無かった値は「未設定」", text(unset.querySelector(".ap-was")) === "未設定" && unset.querySelector(".ap-was").className.includes("ap-unset"));
  t.ok("中継元の会話を見出しの下に弱い字で出せる", text(changeBody(c, "委譲先「経費の入力」").querySelector(".sub")) === "委譲先「経費の入力」");
  const many = approvalChange({ ...payload, key: "computerUse", rows: [
    { path: "computerUse.enabled", before: "false", after: "true" },
    { path: "computerUse.allowAllApps", before: "false", after: "true" },
    { path: "computerUse.alwaysAllowed", before: "[]", after: '[{"id":"exe:a","name":"メモ帳"},{"id":"exe:b","name":"電卓"}]' },
  ] });
  const manyBody = changeBody(many);
  t.ok("項目が複数でも節は 1 度。項目ごとに名前と前後・一覧は追加を言う", text(manyBody).split("設定 › コンピューターの操作").length === 2 && manyBody.querySelectorAll(".ap-key").length === 3
    && text(manyBody).includes("エージェントに PC のアプリを操作させる") && text(manyBody).includes("追加メモ帳、電卓"), text(manyBody));
  const sites = approvalChange({ ...payload, key: "agentSitePermissions", rows: [{ path: "agentSitePermissions", before: '[{"origin":"https://a.example","mode":"always"}]',
    after: '[{"origin":"https://a.example","mode":"always"},{"origin":"https://b.example","mode":"ask"}]' }] });
  t.ok("サイトの一覧は増えた分を「サイト（毎回聞く）」で言う。JSON は出さない", text(changeBody(sites)).includes("追加https://b.example（毎回聞く）") && !text(changeBody(sites)).includes("{") && !text(changeBody(sites)).includes("削除"));
  const unreadable = changeBody({ ...many, rows: [{ ...many.rows[2], list: null, before: "[1", after: "[2" }] });
  t.ok("読めない一覧は生の値で出す", text(unreadable.querySelector(".ap-was")) === "[1");
  t.ok("note(設定以外の操作)は弱い字で出す", text(changeBody({ ...c, rows: [], note: "probe" }).querySelectorAll(".sub")[0]) === "probe");

  // 操作ごとの言葉（defineOp の approvalWords → payload の words。ADR 0088 追記）。組に無い欄・組の無い操作は共通の言葉
  const send = approvalChange({ op: "sessions.send", key: "sessions.send", words: "send", agent: { label: "Claude" }, rows: [], note: "会話「経費」にメッセージを送ります", loosens: true });
  const sendBody = changeBody(send);
  t.ok("送信: 見出し・項目名・許可・畳んだ 1 行・⚠・通知が送信の言葉", text(sendBody.querySelector(".lbl")) === "送信" && text(sendBody.querySelector(".q")) === "Claude が別の会話にメッセージを送ろうとしています"
    && changeWord(send, "allow") === "送信を許可" && changeWord(send, "allowed") === "送信を許可した" && changeWord(send, "failed") === "送れなかった"
    && text(sendBody.querySelector(".warn")) === "⚠ 送り先の会話は、この会話より確認の少ない承認モードで動きます。" && changeNotice(send) === "Claude が別の会話への送信の許可を待っています", text(sendBody));
  const shell = approvalChange({ op: "shell.run", key: "shell.run", words: "shell", agent: { label: "Codex" }, rows: [{ path: "shell.command", after: '"npm test"' }], loosens: true });
  const shellBody = changeBody(shell);
  t.ok("シェル: 「コマンド」「コマンドを実行しようとしています」「実行を許可」と、権限の ⚠", text(shellBody.querySelector(".lbl")) === "コマンド" && changeHeading(shell) === "Codex がコマンドを実行しようとしています"
    && changeWord(shell, "allow") === "実行を許可" && changeWord(shell, "allowed") === "実行を許可した" && text(shellBody.querySelector(".warn")) === "⚠ コマンドは確認なしで、あなたと同じ権限で動きます。", text(shellBody));
  t.ok("シェル: コマンドは単独のコード行。キー・前の値・矢印は出さない", text(shellBody.querySelector("code")) === "npm test"
    && !shellBody.querySelector(".ap-key, .ap-was, .ap-arrow") && !text(shellBody).includes("shell.command"));
  const del = approvalChange({ op: "mcp.delete", key: "mcp.delete", words: "mcpDelete", agent: { label: "Claude" }, rows: [], note: "x", loosens: false });
  t.ok("削除: 「削除しようとしています」「削除を許可」。⚠ は出さない（できることは増えない）", changeHeading(del) === "Claude が MCP サーバーを削除しようとしています" && changeWord(del, "allow") === "削除を許可"
    && changeBody(del).querySelector(".warn") === null);
  const plain = approvalChange({ op: "probe.guarded", key: "probe.guarded", agent: { label: "Claude" }, rows: [], note: "probe", loosens: true });
  t.ok("言葉の組の無い操作は共通の言葉（設定に限らない）", plain.words === "" && changeHeading(plain) === "Claude が操作をしようとしています" && text(changeBody(plain).querySelector(".lbl")) === "操作"
    && changeWord(plain, "allow") === "許可" && changeWord(plain, "allowed") === "許可した" && text(changeBody(plain).querySelector(".warn")) === "⚠ 確認なしでできることが増える操作です。");
  t.ok("知らない組・形の悪い組は共通の言葉。組に無い欄も共通の言葉（送信予定の ⚠）", changeHeading(approvalChange({ ...payload, words: "nope" })) === "Claude が操作をしようとしています"
    && approvalChange({ ...payload, words: "a.b" }).words === "" && changeWord({ words: "schedule" }, "warn") === "⚠ 確認なしでできることが増える操作です。");

  const settingNotice = "[Pleiad 設定の変更の結果 / setting-a]\n結果: 許可\n設定を変更しました。";
  const opNotice = "[Pleiad 操作の結果 / setting-b]\n結果: 許可\n種類: send\n送信しました。";
  const both = parseSettingNotices(`${settingNotice}\n\n${opNotice}`);
  t.ok("通知: 設定と操作の印を読み分け、操作の種類を見出しに渡す", both.length === 2 && both[0].kind === "setting" && both[1].kind === "op" && both[1].words === "send" && both[1].outcome === "allowed");

  // 通知: 画面が見ていない会話の承認待ちを OS の通知にするとき、見出しに誰が何の許可を待っているか
  const shown = [];
  const n = createCompletionNotifications({ host: { plyDesktop: { notifyCompletion: (x) => { shown.push(x); return Promise.resolve(true); } } }, openSession: () => {}, settings: () => ({ reply: true, done: true, failed: true }), isViewing: () => false });
  n.waiting({ type: "permission", id: "p1", notifyReply: true, sessionId: "s1", settingChange: payload, conversationTitle: "会話" }, { title: "会話" });
  t.ok("通知: 設定の変更の承認は見出しに誰が何の許可を待っているか", shown[0]?.title === "Claude が設定「エージェントがサイトを使う前に確認」の変更の許可を待っています", JSON.stringify(shown));

  // 辞書: ja と en に同じキーがある
  const dict = (l) => JSON.parse(readFileSync(new URL(`../../web/locales/${l}/ui.json`, import.meta.url), "utf8")).chat.settingApproval;
  t.ok("辞書: chat.settingApproval の キーが ja と en にそろい、「常に許可」に当たる語は無い", Object.keys(dict("ja")).sort().join() === Object.keys(dict("en")).filter((k) => !k.endsWith("_one")).sort().join() && !("always" in dict("ja")));
  const words = (l) => JSON.parse(readFileSync(new URL(`../../web/locales/${l}/ui.json`, import.meta.url), "utf8")).chat.opApproval;
  const FIELDS = ["label", "question", "allow", "allowed", "failed", "warn", "notice"];
  t.ok("辞書: 共通の言葉（op）は全部の欄を持ち、組は欄の名前だけ（ja と en で同じ欄）", FIELDS.every((f) => typeof words("ja").op[f] === "string" && typeof words("en").op[f] === "string")
    && Object.entries(words("ja")).every(([k, v]) => Object.keys(v).every((f) => FIELDS.includes(f)) && Object.keys(v).sort().join() === Object.keys(words("en")[k] ?? {}).sort().join()));

  const agentWords = (l) => JSON.parse(readFileSync(new URL(`../../web/locales/${l}/agent.json`, import.meta.url), "utf8")).ops.approvalWords;
  t.ok("辞書: エージェント向けの操作名・完了・未実行の言葉は ja/en と全組で揃う", Object.keys(words("ja")).filter((k) => k !== "setting").every((k) => ["target", "done", "notDone", "failed"].every((f) => typeof agentWords("ja")[k]?.[f] === "string" && typeof agentWords("en")[k]?.[f] === "string")));

  // 定義: approvalWords は辞書にある組だけ
  const { registry } = await import("../../core/ops/index.mjs");
  const worded = registry.ops.filter((o) => o.approvalWords);
  t.ok("定義: approvalWords は辞書 chat.opApproval にある組。設定の変更・送信・シェルは固有の言葉", worded.every((o) => o.approvalWords in words("ja"))
    && registry.get("settings.set").approvalWords === "setting" && registry.get("sessions.send").approvalWords === "send" && registry.get("shell.run").approvalWords === "shell",
    worded.filter((o) => !(o.approvalWords in words("ja"))).map((o) => o.id).join());
}
