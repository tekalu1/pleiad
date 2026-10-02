// 設定の変更の承認カード（permission の settingChange。ADR 0082、docs/design-system.md「設定の変更の承認カード」）の中身。
// 型は computer use の承認カード（web/computer-use.mjs の approvalBody）と同じ: 「承認を待っている」の見出し・太字の一文・等幅の弱い字・理由・⚠ と強い字の一言・「拒否」と塗りのボタン。
// 「常に許可」は出さない（設定の変更は、その 1 回の内容を見て決める）。置き場とボタンの動きは web/client.mjs の settingChangeApproval。ここは数え方（純粋）と中身の DOM。
import { el } from "./dom.mjs";
import { t } from "./i18n.mjs";

const hasText = (v) => typeof v === "string" && v.trim();

/** 承認の payload（settingChange）を表示に使える形へ。項目が 1 つも読めなくて説明も無ければ null */
export function approvalChange(settingChange) {
  if (!settingChange || typeof settingChange !== "object") return null;
  const rows = (Array.isArray(settingChange.rows) ? settingChange.rows : [])
    .filter((r) => r && typeof r === "object" && hasText(r.path))
    .map((r) => ({ path: String(r.path), before: typeof r.before === "string" ? r.before : null, after: typeof r.after === "string" ? r.after : null }));
  const note = hasText(settingChange.note) ? String(settingChange.note).trim() : "";
  if (!rows.length && !note) return null;
  return {
    agent: hasText(settingChange.agent?.label) ? String(settingChange.agent.label).trim() : t("chat.settingApproval.agent"),
    key: hasText(settingChange.key) ? String(settingChange.key) : "",
    rows, note,
    reason: hasText(settingChange.reason) ? String(settingChange.reason).trim() : "",
    loosens: settingChange.loosens === true,
    receipt: typeof settingChange.receipt === "string" ? settingChange.receipt : "",
  };
}

/** 見出しの一文。決着後の 1 行にも使う */
export const changeHeading = (change) => t("chat.settingApproval.question", { agent: change.agent });

/** 通知の本文用の語 */
export const changeNotice = (change) => t("notify.settingApproval", { agent: change.agent, key: change.key });

/** 前後の 1 行。値は JSON の文字列（等幅）。無かった値は「未設定」 */
function changeLine(row) {
  const unset = t("chat.settingApproval.unset");
  const line = el("div", "sub mono ap-chg");
  line.setAttribute("aria-label", `${row.path}: ${row.before ?? unset} → ${row.after ?? unset}`);
  line.append(
    el("span", `ap-was${row.before === null ? " ap-unset" : ""}`, row.before ?? unset),
    el("span", "ap-arrow", "→"),
    el("span", `ap-now${row.after === null ? " ap-unset" : ""}`, row.after ?? unset),
  );
  return line;
}

/** 承認カードの中身（見出しの一文・項目と前後の値・理由・⚠）。extra は見出しの下の 1 行（中継元の会話）。置き場は呼び出し側 */
export function changeBody(change, extra = "") {
  const box = el("div", "cu-ap");
  const ln = el("div", "ln");
  ln.append(el("span", "lbl", t("chat.settingApproval.label")));
  const q = el("span", "q");
  q.append(el("span", "qt", changeHeading(change)));
  ln.append(q);
  box.append(ln);
  if (extra) box.append(el("div", "sub", extra));
  for (const row of change.rows) {
    box.append(el("div", "sub mono ap-key", row.path), changeLine(row));
  }
  if (change.note) box.append(el("div", "sub", change.note));
  if (change.reason) box.append(el("div", "sub", t("chat.settingApproval.reason", { reason: change.reason })));
  if (change.loosens) box.append(el("div", "warn", t("chat.settingApproval.warn")));
  return box;
}
