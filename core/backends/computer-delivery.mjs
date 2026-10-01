// ply_computer（コンピューターの操作）を 3 つのエージェントへ渡す形と、結果の正規化（docs/computer-use.md「エージェントへの渡し方」
// 「tool.start / tool.result」）。値は 2026-10-01 の実測で決めた（同「エージェントごとの値」）。
import { computerDisplay, computerToolInput, COMPUTER_TOOL_PREFIX } from '../computer-use/display.mjs';
import { agentT } from '../i18n.mjs';

export { computerToolInput, COMPUTER_TOOL_PREFIX };
export const COMPUTER_SERVER = 'ply_computer';
// 1 回の呼び出しの上限（秒）。ロックの待ち（最長 10 分）より少し長くする。Claude は既定 60 秒・無通信 300 秒、Codex は既定 300 秒で切る
export const COMPUTER_CALL_TIMEOUT_SEC = 660;
// agy は MCP の呼び出しを 3 分で切り、設定では伸びない。ロックの待ちはこの長さごとに分けて返す（橋の waitSliceMs）
export const AGY_WAIT_SLICE_MS = 150_000;
// agy はツールの定義をサーバー名の階層なしで ~/.gemini/antigravity-cli/mcp/<ツール>.json に書く。
// screenshot のような一般的な名前は他のサーバーと衝突するので、agy にだけ接頭辞を付けて見せる（core/agy-context-relay.mjs）
export const AGY_TOOL_PREFIX = 'ply_computer_';
// 画像をファイルに退避したことを知らせる、エージェントが足す行。agy は出力の末尾に [Resource offloaded to file:///…] を、
// Claude の CLI（2.1.284）はライブの tool_result に [Image: source: <パス>] の text ブロックを足す（transcript には残らない）
const IMAGE_NOTES = [/^\[Resource offloaded to file:\/\/\/[^\n\]]*\]\s*$/, /^\[Image: source: [^\n\]]*\]\s*$/];

export const isComputerTool = name => typeof name === 'string' && name.startsWith(COMPUTER_TOOL_PREFIX);

/**
 * エージェントに渡す指示文。3 つに共通の文（橋の instructions）に、そのエージェントでの呼び方を足す。
 * agent は codex / antigravity（Claude は足す文が無い）
 */
export function computerPrompt(runtime, { locale, agent } = {}) {
  if (!runtime?.instructions) return null;
  // i18n-dynamic: agent:computerDelivery.
  const extra = agent === 'codex' || agent === 'antigravity' ? agentT(locale, `computerDelivery.${agent}`) : null;
  return [runtime.instructions, extra].filter(Boolean).join('\n');
}

/** MCP の CallToolResult から text ブロックだけをつなぐ。image の base64 は捨てる（表示は印の行から作る） */
export function mcpText(result) {
  return (Array.isArray(result?.content) ? result.content : [])
    .filter(b => b?.type === 'text' && typeof b.text === 'string').map(b => b.text).join('\n');
}

/**
 * ply_computer の結果の text -> tool.result の中身。印の行と画像の退避の行を除いた本文に cut（各エージェントの 2000 字の扱い）を掛け、
 * images と computer を足す。印が無ければ text をそのまま切る
 */
export function computerResult(raw, cut) {
  const shown = computerDisplay(withoutImageNotes(raw));
  if (!shown) return cut(String(raw ?? ''));
  return { ...cut(shown.text), images: shown.images, computer: shown.computer };
}

/** 印の state から isError（state が ok 以外のとき true。橋の isError と同じ） */
export const computerFailed = computer => Boolean(computer && computer.state !== 'ok');

/** Codex の thread/start の config に足すもの（ADR 0074）。runtime が無ければ何も足さない */
export function codexComputerConfig(runtime) {
  if (!runtime) return {};
  return {
    [`mcp_servers.${COMPUTER_SERVER}`]: { url: runtime.url, http_headers: runtime.headers, enabled: true, required: false,
      default_tools_approval_mode: 'approve', startup_timeout_sec: 20, tool_timeout_sec: COMPUTER_CALL_TIMEOUT_SEC },
    // 同梱の computer use を切る。cua_repl を出す側とスキルを出す側の 2 つとも要る。features.computer_use は効かず、
    // mcp_servers.cua_repl.enabled は app-server が拒否する。node_repl は利用者の設定なので触らない
    'plugins.unified-computer-use@openai-bundled.enabled': false,
    'plugins.computer-use@openai-bundled.enabled': false,
  };
}

/** Codex の mcpToolCall が ply_computer のものなら tool.start の名前（mcp__ply_computer__<ツール>）。違えば null */
export function codexComputerName(item) {
  return item?.type === 'mcpToolCall' && item.server === COMPUTER_SERVER && typeof item.tool === 'string' && item.tool
    ? COMPUTER_TOOL_PREFIX + item.tool : null;
}

/**
 * agy の call_mcp_tool の引数（{ ServerName, ToolName, Arguments }）が ply_computer のものなら tool.start の名前。違えば null。
 * ServerName はモデルが埋めないので空のことが多い（実測）。接頭辞の付いた ToolName で見分ける
 */
export function agyComputerName(parameters) {
  const tool = parameters?.ToolName;
  if (typeof tool !== 'string' || !tool) return null;
  if (tool.startsWith(AGY_TOOL_PREFIX) && tool.length > AGY_TOOL_PREFIX.length) return COMPUTER_TOOL_PREFIX + tool.slice(AGY_TOOL_PREFIX.length);
  return parameters?.ServerName === COMPUTER_SERVER ? COMPUTER_TOOL_PREFIX + tool : null;
}

/** 結果の本文から、エージェントが足した画像の退避の行（IMAGE_NOTES）を除く */
export function withoutImageNotes(text) {
  return String(text ?? '').split('\n').filter(line => !IMAGE_NOTES.some(rx => rx.test(line))).join('\n').replace(/\n+$/, '');
}
