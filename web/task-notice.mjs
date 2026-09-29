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
