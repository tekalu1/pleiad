// ツールの結果の最後の行に入れる「印の行」の作成と読み取り（docs/computer-use.md「印の行」、ADR 0075）。
// 橋が作り（computerMarker）、3 つのエージェントの正規化と履歴の読み直しが読む（computerDisplay・computerToolInput）。
import { redactSecrets } from '../redact.mjs';

export const MARKER_PREFIX = '[ply_computer] ';
export const COMPUTER_TOOL_PREFIX = 'mcp__ply_computer__';
const SHOT_ID = /^[0-9a-f]{32}$/;

/** 印の行を作る。fields は { tool, state, reason?, title, app?, display?, shot?, w?, h?, grant?, actions? }。undefined の項目は入れない */
export function computerMarker(fields) {
  const body = { v: 1 };
  for (const [k, v] of Object.entries(fields ?? {})) if (v !== undefined && v !== null) body[k] = v;
  return MARKER_PREFIX + JSON.stringify(body);
}

/**
 * 結果の text から印の行を読む。印が無い・壊れている・v が 1 でないときは null。
 * 戻り: { text（印の行を除いた本文）, images: [{ url, shot, width, height }], computer（印の JSON から v を除いたもの） }
 */
export function computerDisplay(text) {
  const raw = String(text ?? '');
  const lines = raw.split('\n');
  let at = -1;
  for (let i = lines.length - 1; i >= 0; i--) if (lines[i].trimEnd().startsWith(MARKER_PREFIX.trimEnd())) { at = i; break; }
  if (at < 0) return null;
  let mark;
  try { mark = JSON.parse(lines[at].trim().slice(MARKER_PREFIX.trimEnd().length)); } catch { return null; }
  if (!mark || typeof mark !== 'object' || Array.isArray(mark) || mark.v !== 1) return null;
  const { v, ...computer } = mark;
  if (computer.shot !== undefined && !(typeof computer.shot === 'string' && SHOT_ID.test(computer.shot))) delete computer.shot;
  const body = [...lines.slice(0, at), ...lines.slice(at + 1)].join('\n').replace(/\n+$/, '');
  const images = computer.shot ? [{ url: `/computer-shot/${computer.shot}.jpg`, shot: computer.shot, width: computer.w, height: computer.h }] : [];
  return { text: body, images, computer };
}

/**
 * 画面へ流す tool.start の入力から、type で打つ文字列の秘密らしいものを伏せる。
 * tool は `mcp__ply_computer__type` でも `type` でもよい。computer_batch の中の type も伏せる
 */
export function computerToolInput(tool, input) {
  if (!input || typeof input !== 'object') return input;
  const name = String(tool ?? '').startsWith(COMPUTER_TOOL_PREFIX) ? String(tool).slice(COMPUTER_TOOL_PREFIX.length) : String(tool ?? '');
  const hide = x => (x && typeof x === 'object' && typeof x.text === 'string' ? { ...x, text: redactSecrets(x.text) } : x);
  if (name === 'type') return hide(input);
  if (name === 'computer_batch' && Array.isArray(input.actions)) return { ...input, actions: input.actions.map(a => (a?.action === 'type' ? hide(a) : a)) };
  return input;
}
