import fs from "node:fs/promises";
import vm from "node:vm";
import { el } from "../../web/dom.mjs";
import { renderAssistantMarkdown } from "../../web/render.mjs";

export const name = "stream-prefix";
export const title = "閉じた発言の後もストリーミング本文の先頭を保持する";

export default async function (t) {
  // 実際のクライアント関数を実行し、状態遷移による先頭断片の消失を検出する。
  const source = (await fs.readFile(new URL("../../web/client.mjs", import.meta.url), "utf8")).replaceAll("\r\n", "\n");
  const functions = ["appendText", "openTurnEl", "closeTurnEl"].map(name => {
    const start = source.indexOf(`function ${name}(`);
    if (start < 0) throw new Error(`Missing client function: ${name}`);
    return source.slice(start, source.indexOf("\n}", start) + 2);
  }).join("\n");

  for (const closed of [false, true]) {
    const bodies = [];
    const state = { streamEl: null, turnEl: null, turnClosed: closed };
    const context = vm.createContext({
      state, el, renderAssistantMarkdown,
      closeThink() {}, activity: { show() {} }, atBottom: () => false,
      ensureTurnEl: () => ({ append: node => bodies.push(node) }),
    });
    vm.runInContext(functions, context);
    context.chunk = "こんに";
    vm.runInContext("appendText(chunk)", context);
    context.chunk = "ちは！👋";
    vm.runInContext("appendText(chunk)", context);
    t.ok(`先頭から全文を表示する（前の発言が閉じた状態: ${closed}）`,
      bodies.length === 1 && bodies[0]?.outerHTML.includes("こんにちは！👋")
      && state.streamEl.dataset.raw === "こんにちは！👋");

    // text.end と同じ状態から次の本文へ進む。前の本文を壊さず新しく作る。
    state.streamEl = null;
    state.turnClosed = true;
    context.chunk = "次の発言";
    vm.runInContext("appendText(chunk)", context);
    t.ok("次の発言でも null を追加せず、前の全文を保持する",
      bodies.length === 2 && bodies.every(Boolean)
      && bodies[0].outerHTML.includes("こんにちは！👋")
      && bodies[1].outerHTML.includes("次の発言"));
  }
}
