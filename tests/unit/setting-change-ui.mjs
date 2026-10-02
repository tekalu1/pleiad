// 設定の変更の承認カードの中身（web/setting-change.mjs。ADR 0082、docs/design-system.md「設定の変更の承認カード」）と通知の見出し。
// 型は computer use の承認カードと同じ（承認を待っている・太字の一文・等幅の前後・理由・⚠・ボタンは「拒否」と「変更を許可」）。
// 置き場と押したときの動き（受領証つきの resolvePermission・畳み方）は実ブラウザーで見る（tests/browser/setting-approval.cjs）。
//
// DOM シムは tests/run.mjs が入口で入れている。
import { approvalChange, changeBody, changeHeading, changeNotice } from "../../web/setting-change.mjs";
import { createCompletionNotifications } from "../../web/notifications.mjs";
import { readFileSync } from "node:fs";

export const name = "setting-change-ui";
export const title = "設定の変更の承認カード: payload の読み方・中身（前後は等幅・理由・⚠）・通知の見出し・辞書";

const text = (node) => String(node?.textContent ?? "").replace(/\s+/g, " ").trim();
const payload = {
  op: "settings.set", key: "confirmAgentSites", agent: { id: "claude", label: "Claude" }, loosens: true, receipt: "a".repeat(32), reason: "確認が多すぎるため",
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
  t.ok("通知の見出し", changeNotice(c) === "Claude が設定「confirmAgentSites」の変更の許可を待っています", changeNotice(c));

  const body = changeBody(c);
  t.ok("中身: ラベル・一文・項目名（等幅）・前後（等幅。前は取り消し線・後ろが現在）・理由・⚠", text(body.querySelector(".lbl")) === "設定" && text(body.querySelector(".q")) === "Claude が設定を変えようとしています"
    && text(body.querySelector(".ap-key")) === "confirmAgentSites" && body.querySelector(".ap-key").className.includes("mono")
    && text(body.querySelector(".ap-was")) === "true" && text(body.querySelector(".ap-now")) === "false" && body.querySelector(".ap-chg").className.includes("mono")
    && text(body).includes("理由: 確認が多すぎるため") && text(body.querySelector(".warn")) === "⚠ このエージェントの関所を緩める変更です。");
  t.ok("関所を緩めない変更には ⚠ を出さない。理由が無ければ出さない", !body.querySelector(".warn") === false && changeBody({ ...c, loosens: false, reason: "" }).querySelector(".warn") === null
    && !text(changeBody({ ...c, loosens: false, reason: "" })).includes("理由"));
  const unset = changeBody({ ...c, rows: [{ path: "x", before: null, after: "1" }] });
  t.ok("無かった値は「未設定」", text(unset.querySelector(".ap-was")) === "未設定" && unset.querySelector(".ap-was").className.includes("ap-unset"));
  t.ok("中継元の会話を見出しの下に弱い字で出せる", text(changeBody(c, "委譲先「経費の入力」").querySelector(".sub")) === "委譲先「経費の入力」");
  t.ok("JSON のかたまり(入力の dump)は出さない。値は 1 行ずつ", !text(body).includes("{") && changeBody({ ...c, rows: [c.rows[0], { path: "b", before: "1", after: "2" }] }).querySelectorAll(".ap-chg").length === 2);
  t.ok("note(設定以外の操作)は弱い字で出す", text(changeBody({ ...c, rows: [], note: "probe" }).querySelectorAll(".sub")[0]) === "probe");

  // 通知: 画面が見ていない会話の承認待ちを OS の通知にするとき、見出しに誰が何の許可を待っているか
  const shown = [];
  const n = createCompletionNotifications({ host: { plyDesktop: { notifyCompletion: (x) => { shown.push(x); return Promise.resolve(true); } } }, openSession: () => {}, settings: () => ({ reply: true, done: true, failed: true }), isViewing: () => false });
  n.waiting({ type: "permission", id: "p1", notifyReply: true, sessionId: "s1", settingChange: payload, conversationTitle: "会話" }, { title: "会話" });
  t.ok("通知: 設定の変更の承認は見出しに誰が何の許可を待っているか", shown[0]?.title === "Claude が設定「confirmAgentSites」の変更の許可を待っています", JSON.stringify(shown));

  // 辞書: ja と en に同じキーがある
  const dict = (l) => JSON.parse(readFileSync(new URL(`../../web/locales/${l}/ui.json`, import.meta.url), "utf8")).chat.settingApproval;
  t.ok("辞書: chat.settingApproval の キーが ja と en にそろい、「常に許可」に当たる語は無い", Object.keys(dict("ja")).sort().join() === Object.keys(dict("en")).sort().join() && !("always" in dict("ja")));
}
