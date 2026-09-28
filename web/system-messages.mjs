// 履歴に残ったシステム側のメッセージの見せ方（docs/design-system.md「システム側のメッセージ」、ADR 0053）。
// 見分けはサーバー（core/system-messages.mjs）が済ませ、発言に kind を付けて渡す。ここは kind ごとの中身の DOM だけを作る。
// 発言者の見出し・筋の節・操作（分岐・入力欄に写す）は client.mjs が付ける。
import { el, svgEl } from "./dom.mjs";
import { t } from "./i18n.mjs";

// 流れている出力の末尾の改行は行に数えない
const lineCount = (s) => String(s ?? "").replace(/\n$/, "").split("\n").length;

/**
 * 閉じた折りたたみ（tools.css の .tc-fold と同じ ▸）。wide は折り返さず横にスクロールする（`!` の出力。罫線の表が多い）。
 * open はいま走らせた `!` の行（開いたまま流す。開き直すと閉じる）
 */
function fold(summary, text, { wide = false, open = false, stream = null } = {}) {
  const d = el("details", "tc-fold cmd-fold");
  if (open) d.open = true;
  if (stream) d.dataset.stream = stream;
  const s = el("summary");
  s.append(...summary.map((part) => typeof part === "string" ? el("span", null, part) : part));
  const body = el("div", "tc-fold-body");
  body.append(el("pre", wide ? "cmd-out wide" : "cmd-out", text));
  d.append(s, body);
  return d;
}

/** 1 行目の見出し。stderr の中身の見当が付くように（開かなくても読める） */
const firstLine = (text) => String(text ?? "").split("\n").find((line) => line.trim())?.trim() ?? "";

/**
 * コマンド（kind: 'command'）・`!` モード（kind: 'shell'）の中身。吹き出しは付けない。
 * - コマンド: 「コマンド  /model opus」＋出力があれば閉じた「出力」
 * - シェル: 「シェル  ! git status」＋閉じた「出力 · N 行」「エラー出力 · 1 行目」。stderr は失敗扱いにしない。
 *   出力が両方空なら行の右に「出力なし」。
 *   終了コードが分かるとき（Codex・Pleiad が走らせた分）だけ右端に「exit 0」、0 以外は「✕ 失敗 · exit N」（行の面は client.mjs が持ち上げる）。
 *   分からないとき（CLI の記録）は何も書かない。走っている間（running）は弧と「実行中 · 経過」「止める」（onStop）
 */
export function commandParts(m, { onStop = null } = {}) {
  const shell = m.kind === "shell";
  const line = el("div", "cmdline");
  line.append(el("span", "tc-label", shell ? t("chat.system.shell") : t("chat.system.command")));
  if (m.command) line.append(el("span", "cmd-text", shell ? `! ${m.command}` : m.command));
  const parts = [line];
  if (!shell) {
    if (m.output) parts.push(fold([t("chat.system.output")], m.output));
    return parts;
  }
  // いま走らせた行（live）は開いたまま。描き直しでは人が閉じた折りたたみを閉じたままにする（openStreams）
  const open = (stream) => Boolean(m.live) && (m.openStreams?.[stream] ?? true);
  if (m.stdout) parts.push(fold([t("chat.system.outputLines", { count: lineCount(m.stdout) })], m.stdout, { wide: true, open: open("stdout"), stream: "stdout" }));
  if (m.stderr) parts.push(fold([`${t("chat.system.errorOutput")} · `, el("span", "first", firstLine(m.stderr))], m.stderr, { wide: true, open: open("stderr"), stream: "stderr" }));
  const res = shellResult(m, onStop);
  if (res) line.append(res);
  if (m.truncated) parts.push(el("div", "cmd-note", t("chat.shell.truncated")));
  if (m.error) parts.push(el("div", "cmd-note strong", t("chat.shell.runFailed", { error: m.error })));
  return parts;
}

/** 経過の字（3s・2m 05s） */
export function elapsedText(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

/** 0 以外の終了コードが分かっている（✕ 失敗の形にする） */
export const shellFailed = (m) => m?.kind === "shell" && !m.running && Number.isInteger(m.exitCode) && m.exitCode !== 0;

/** `!` の行の右端（tc-res と同じ位置）。何も書かないときは null */
function shellResult(m, onStop) {
  const noOutput = !m.stdout && !m.stderr;
  if (m.running) {
    const res = el("span", "cmd-res running");
    const arc = svgEl("svg", { class: "arc", viewBox: "0 0 16 16" });
    arc.append(svgEl("path", { d: "M8 2a6 6 0 1 1-6 6" }));
    res.append(arc, el("span", "elapsed", t("chat.shell.running", { elapsed: elapsedText(Date.now() - Date.parse(m.at ?? 0)) })));
    if (onStop) {
      const stop = el("button", "btn stop", t("chat.shell.stop"));
      stop.type = "button";
      stop.onclick = onStop;
      res.append(stop);
    }
    return res;
  }
  if (m.error) return null;
  const tail = noOutput ? [t("chat.system.noOutput")] : [];
  if (m.timedOut) return el("span", "cmd-res", [t("chat.shell.timedOut", { minutes: Math.round((m.timeoutMs ?? 600000) / 60000) }), ...tail].join(" · "));
  if (m.stopped) return el("span", "cmd-res", [t("chat.shell.stopped"), ...tail].join(" · "));
  if (shellFailed(m)) return el("span", "cmd-res", t("chat.shell.failed", { code: m.exitCode }));
  if (Number.isInteger(m.exitCode)) return el("span", "cmd-res", [t("chat.shell.exit", { code: m.exitCode }), ...tail].join(" · "));
  return noOutput ? el("span", "cmd-res", t("chat.system.noOutput")) : null;
}

/**
 * 開ける出来事の一行（.m.sys の中の details）。teammate の知らせと Pleiad の完了通知。既定は閉じた状態
 * @param label 見出しの字
 * @param body 開いたときの本文（そのままの字）
 * @param at 時刻の字（無ければ出さない）
 */
export function sysFold(label, body, at = "") {
  const m = el("div", "m sys");
  const d = el("details", "sys-fold");
  const s = el("summary");
  s.append(el("span", null, label));
  if (at) s.append(el("span", "t", at));
  d.append(s, el("div", "sys-body", body));
  m.append(d);
  return m;
}

/** agent teams の teammate の知らせ（kind: 'teammate'）。待機だけの知らせはサーバーが落としてある */
export function teammateNode(m, at = "") {
  return sysFold(m.from ? t("chat.system.teammateFrom", { from: m.from }) : t("chat.system.teammate"), m.body ?? "", at);
}
