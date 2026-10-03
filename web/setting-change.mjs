// 設定の変更の承認カード（permission の settingChange。ADR 0082・0088、docs/design-system.md「設定の変更の承認カード」）の中身。
// 型は computer use の承認カード（web/computer-use.mjs の approvalBody）と同じ: 「承認を待っている」の見出し・太字の一文・弱い字・理由・⚠ と強い字の一言・「拒否」と塗りのボタン。
// 項目と値は、設定画面と同じ名前（辞書）と値の言い方（オン/オフ・サイトの一覧）で出す。設定のキーは出さない（辞書に無い設定だけ、名前の代わりに等幅で出す）。
// 「常に許可」は出さない（設定の変更は、その 1 回の内容を見て決める）。置き場とボタンの動きは web/client.mjs の settingChangeApproval。ここは数え方（純粋）と中身の DOM。
// 設定の変更のほかの guarded の操作（別の会話への送信・コマンドの実行・削除など）も同じカードに出る。見出し・項目名・許可のボタン・畳んだ 1 行・⚠・通知は、
// 操作の言葉の組（defineOp の approvalWords → payload の words。辞書 chat.opApproval.<組>）で言い分け、組に無い欄は共通の言葉（op）にする（ADR 0088 追記）。
//
// i18n-dynamic: chat.opApproval.
import { el } from "./dom.mjs";
import { has, t } from "./i18n.mjs";

const hasText = (v) => typeof v === "string" && v.trim();
const WORDS_RX = /^[a-z][a-zA-Z]*$/;

/** 承認カードの言葉（field: label・question・allow・allowed・failed・warn・notice）。操作の言葉の組に無ければ共通の言葉 */
export function changeWord(change, field) {
  const set = change?.words && has(`chat.opApproval.${change.words}.${field}`) ? change.words : "op";
  return t(`chat.opApproval.${set}.${field}`, { agent: change?.agent ?? "", name: change?.name ?? "" });
}

// 設定画面の節の名前（設定 › {節}）。辞書から引くので、画面と同じ言い方になる
const SECTIONS = {
  browser: () => t("settings.nav.browser"),
  computer: () => t("settings.nav.computer"),
  delegation: () => t("settings.nav.delegation"),
  context: () => t("settings.nav.context"),
};
// 設定のキー（computerUse.enabled のような項目の path）→ 設定画面での名前・節・値の種類（flag: オン/オフ、sites・profiles・apps: 一覧）
const LABELS = {
  confirmExternalLoads: { section: "browser", name: () => t("settings.browser.confirm.external"), kind: "flag" },
  confirmAgentSites: { section: "browser", name: () => t("settings.browser.confirm.agent"), kind: "flag" },
  externalSitePermissions: { section: "browser", name: () => `${t("settings.browser.confirm.sites")} · ${t("settings.browser.confirm.externalList")}`, kind: "sites" },
  agentSitePermissions: { section: "browser", name: () => `${t("settings.browser.confirm.sites")} · ${t("settings.browser.confirm.agentList")}`, kind: "sites" },
  browserProfiles: { section: "browser", name: () => t("settings.browser.profiles.title"), kind: "profiles" },
  "computerUse.enabled": { section: "computer", name: () => t("settings.computer.enable"), kind: "flag" },
  "computerUse.allowAllApps": { section: "computer", name: () => t("settings.computer.allowAll"), kind: "flag" },
  "computerUse.alwaysAllowed": { section: "computer", name: () => t("settings.computer.allowedTitle"), kind: "apps" },
  plyInstructions: { section: "context", name: () => t("context.ply.title"), kind: "raw" },
};
// 項目の名前が辞書に無い設定でも、節だけは分かる（委譲の自動振り分け・コンテキストの既定。MCP・Hooks・コンテキストの操作の行。ADR 0095）
const SECTION_OF_ROOT = { delegationRouting: "delegation", "context.default": "context", addedContext: "context", context: "context", mcp: "context", hooks: "context", plyInstructions: "context" };

/** 項目（path）の表示用の名前・節・値の種類。辞書に無ければ名前は path のまま（等幅で出す。mono: true） */
export function labelOf(path) {
  const known = LABELS[path];
  if (known) return { name: known.name(), section: SECTIONS[known.section](), kind: known.kind, mono: false };
  const root = Object.keys(SECTION_OF_ROOT).find((r) => path === r || path.startsWith(`${r}.`));
  return { name: path, section: root ? SECTIONS[SECTION_OF_ROOT[root]]() : "", kind: "raw", mono: true };
}

function readJson(text) {
  try { return { ok: true, value: JSON.parse(text) }; } catch { return { ok: false, value: null }; }
}

const SITES_SHOWN = 3;
/** 一覧の 1 件の言い方（サイトは「https://… （常に）」、プロフィール・アプリは名前）。読めなければ null */
function itemText(kind, item) {
  if (!item || typeof item !== "object") return typeof item === "string" ? item : null;
  if (kind === "sites") return hasText(item.origin) ? `${item.origin}${item.mode === "always" ? `（${t("settings.browser.confirm.always")}）` : item.mode === "ask" ? `（${t("settings.browser.confirm.ask")}）` : ""}` : null;
  const name = item.name ?? item.label ?? item.id;
  return hasText(name) ? String(name) : null;
}

/** 一覧を読む。配列で全部の件が読めれば文字の配列、そうでなければ null（生の値で出す） */
function listOf(kind, text) {
  if (text === null) return [];
  const json = readJson(text);
  if (!json.ok || !Array.isArray(json.value)) return null;
  const items = json.value.map((item) => itemText(kind, item));
  return items.every((x) => x !== null) ? items : null;
}

/** 一覧の言い方: 3 件まで並べ、残りは「ほか N 件」 */
const listText = (items) => {
  const shown = items.slice(0, SITES_SHOWN).join(t("chat.settingApproval.join"));
  return items.length > SITES_SHOWN ? `${shown} ${t("chat.settingApproval.more", { count: items.length - SITES_SHOWN })}` : shown;
};

/** 1 つの値の言い方。flag は「オン」「オフ」、無かった値は null のまま（呼び出し側が「未設定」にする）。読めなければ生の文字 */
function valueText(kind, text) {
  if (text === null) return null;
  if (kind === "flag") {
    const json = readJson(text);
    if (json.ok && typeof json.value === "boolean") return json.value ? t("chat.settingApproval.on") : t("chat.settingApproval.off");
  }
  return text;
}

/** 承認の payload（settingChange）を表示に使える形へ。項目が 1 つも読めなくて説明も無ければ null */
export function approvalChange(settingChange) {
  if (!settingChange || typeof settingChange !== "object") return null;
  const rows = (Array.isArray(settingChange.rows) ? settingChange.rows : [])
    .filter((r) => r && typeof r === "object" && hasText(r.path))
    .map((r) => {
      const before = typeof r.before === "string" ? r.before : null;
      const after = typeof r.after === "string" ? r.after : null;
      const label = labelOf(String(r.path));
      const mark = label.kind === "sites" || label.kind === "profiles" || label.kind === "apps" ? { was: listOf(label.kind, before), now: listOf(label.kind, after) } : null;
      // 一覧は、前後で増えた件・減った件で言う（件数が多くても、変わった所が見える）。読めない一覧は生の値
      const list = mark?.was && mark?.now ? {
        added: mark.now.filter((x) => !mark.was.includes(x)),
        removed: mark.was.filter((x) => !mark.now.includes(x)),
      } : null;
      return {
        path: String(r.path), ...label, list,
        before: valueText(label.kind, before), after: valueText(label.kind, after),
        raw: { before, after },
      };
    });
  const note = hasText(settingChange.note) ? String(settingChange.note).trim() : "";
  if (!rows.length && !note) return null;
  const key = hasText(settingChange.key) ? String(settingChange.key) : "";
  return {
    op: hasText(settingChange.op) ? String(settingChange.op) : "",
    // 言葉の組（defineOp の approvalWords）。無い・読めなければ共通の言葉
    words: typeof settingChange.words === "string" && WORDS_RX.test(settingChange.words) ? settingChange.words : "",
    agent: hasText(settingChange.agent?.label) ? String(settingChange.agent.label).trim() : t("chat.settingApproval.agent"),
    key,
    // 通知と見出しに出す、設定の名前（設定画面での名前。分からなければキー）
    name: rows[0]?.name ?? (key ? labelOf(key).name : ""),
    rows, note,
    reason: hasText(settingChange.reason) ? String(settingChange.reason).trim() : "",
    loosens: settingChange.loosens === true,
    receipt: typeof settingChange.receipt === "string" ? settingChange.receipt : "",
    // 決着（settingApproval イベント）とカードを結ぶ印。聞き直したカードも同じ requestId
    requestId: typeof settingChange.requestId === "string" ? settingChange.requestId : "",
  };
}

/** 見出しの一文。決着後の 1 行にも使う */
export const changeHeading = (change) => changeWord(change, "question");

/** 通知の見出し */
export const changeNotice = (change) => changeWord(change, "notice");

/** 前後の 1 行。前は取り消し線の弱い字、後ろが現在。無かった値は「未設定」 */
function changeLine(row) {
  const unset = t("chat.settingApproval.unset");
  const line = el("div", `sub ap-chg${row.mono ? " mono" : ""}`);
  line.append(
    el("span", `ap-was${row.before === null ? " ap-unset" : ""}`, row.before ?? unset),
    el("span", "ap-arrow", "→"),
    el("span", `ap-now${row.after === null ? " ap-unset" : ""}`, row.after ?? unset),
  );
  return line;
}

/** 一覧の増減の行（追加・削除）。items は言い方の配列 */
function listLine(tag, items) {
  const line = el("div", "sub ap-chg");
  line.append(el("span", "ap-tag", tag), el("span", "ap-now", listText(items)));
  return line;
}

/** 1 項目の行: 名前・前後（一覧は追加・削除）。節が項目ごとに違うときだけ、節の行を添える（同じなら見出しの下に 1 度） */
function changeRow(row, withWhere) {
  const box = el("div", "ap-row");
  const name = el("div", `sub ap-key${row.mono ? " mono" : ""}`, row.name);
  box.append(name);
  if (withWhere && row.section) box.append(el("div", "sub", t("chat.settingApproval.where", { section: row.section })));
  const lines = [];
  if (row.list) {
    if (row.list.added.length) lines.push(listLine(t("chat.settingApproval.added"), row.list.added));
    if (row.list.removed.length) lines.push(listLine(t("chat.settingApproval.removed"), row.list.removed));
  }
  if (!lines.length) lines.push(changeLine(row));
  box.append(...lines);
  const was = row.before ?? t("chat.settingApproval.unset"), now = row.after ?? t("chat.settingApproval.unset");
  box.setAttribute("role", "group");
  box.setAttribute("aria-label", row.list ? `${row.name}: ${lines.map((l) => l.textContent).join(" / ")}` : `${row.name}: ${was} → ${now}`);
  return box;
}

/** 承認カードの中身（見出しの一文・設定の節・項目と前後の値・理由・⚠）。extra は見出しの下の 1 行（中継元の会話）。置き場は呼び出し側 */
export function changeBody(change, extra = "") {
  const box = el("div", "cu-ap");
  const ln = el("div", "ln");
  ln.append(el("span", "lbl", changeWord(change, "label")));
  const q = el("span", "q");
  q.append(el("span", "qt", changeHeading(change)));
  ln.append(q);
  box.append(ln);
  if (extra) box.append(el("div", "sub", extra));
  const sections = [...new Set(change.rows.map((r) => r.section))];
  const together = sections.length === 1 && sections[0];
  if (together) box.append(el("div", "sub", t("chat.settingApproval.where", { section: together })));
  for (const row of change.rows) box.append(changeRow(row, !together));
  if (change.note) box.append(el("div", "sub", change.note));
  if (change.reason) box.append(el("div", "sub", t("chat.settingApproval.reason", { reason: change.reason })));
  if (change.loosens) box.append(el("div", "warn", changeWord(change, "warn")));
  return box;
}
