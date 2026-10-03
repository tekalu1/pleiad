// Pleiad の完了通知（core が依頼元のエージェントへ渡す文。web/locales/<言語>/agent.json の delegation.notice）を読む。
// 画面はこれを「委譲の結果」の 1 行にする（docs/design-system.md「システム側のメッセージ」）。まとめ通知（N 件）と、読めない形は null。
// 文は会話の言語で組まれるので、日本語と英語の両方を読む。

// i18n-ignore: core が会話の言語で組んで依頼元のエージェントへ渡す文を読む正規表現（web/locales/<言語>/agent.json の delegation.notice と対）
const HEAD = /^\[Pleiad (?:タスク完了通知|task completion notice) \/ (ply-task-[0-9a-f-]+)\]/;
const FIELD = (names) => new RegExp(`^(?:${names}): (.*)$`, "m");
const BACKEND = FIELD("実行先|Backend"); // i18n-ignore: 通知の文の見出し（上と同じ）
const STATUS = FIELD("状態|Status"); // i18n-ignore: 通知の文の見出し（上と同じ）
const TASK = FIELD("依頼|Task"); // i18n-ignore: 通知の文の見出し（上と同じ）
const RESULT = /^(?:結果（子エージェントの報告）|Result \(the child agent's report\)):\n([\s\S]*)$/m; // i18n-ignore: 通知の文の見出し（上と同じ）
const TAIL = /\n(?:元の依頼に必要な作業を続けてください。|Continue the work needed for the original request\.)\s*$/; // i18n-ignore: 通知の文の結び（上と同じ）

/**
 * @param {string} text
 * @returns {{taskId:string, backend:string, status:string, task:string, result:string}|null}
 */
export function parseTaskNotice(text) {
  const s = String(text ?? "").trim();
  const head = HEAD.exec(s);
  if (!head) return null;
  const result = RESULT.exec(s)?.[1]?.replace(TAIL, "").trim() ?? "";
  return {
    taskId: head[1],
    backend: BACKEND.exec(s)?.[1]?.trim() ?? "",
    status: STATUS.exec(s)?.[1]?.trim() ?? "",
    task: TASK.exec(s)?.[1]?.trim() ?? "",
    result,
  };
}

// i18n-ignore: core が会話の言語で組んでエージェントへ渡す承認結果を読む正規表現（agent:ops.settingNotice.head / opHead と対）
const SETTING_HEAD = /^\[Pleiad (設定の変更の結果|setting change result|操作の結果|operation result) \/ (setting-[0-9a-f-]+)\]\n(?:結果|Result): (\S+)(?:\n(?:種類|Type): ([a-zA-Z]+))?$/gm;
// i18n-ignore: 結果の語（ops.settingNotice.status）。取り下げ（置き換え・再起動）は 1 つにまとめる
const SETTING_STATUS = { 許可: "allowed", 拒否: "denied", 失敗: "failed", 取り下げ: "withdrawn", allowed: "allowed", denied: "denied", failed: "failed", withdrawn: "withdrawn" };

/**
 * 設定と操作の承認結果（ADR 0088。core の settingNotice）。1 つの通知に複数の節が並ぶことがある。読めなければ空
 * @param {string} text
 * @returns {{requestId:string, outcome:"allowed"|"denied"|"failed"|"withdrawn", kind:"setting"|"op", words:string}[]}
 */
export function parseSettingNotices(text) {
  const s = String(text ?? "").trim();
  if (!s.startsWith("[Pleiad ")) return [];
  return [...s.matchAll(SETTING_HEAD)].map((m) => ({ requestId: m[2], outcome: SETTING_STATUS[m[3]], kind: /^(?:操作の結果|operation result)$/.test(m[1]) ? 'op' : 'setting', words: m[4] ?? '' })).filter((x) => x.outcome);
}
