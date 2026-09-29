// 中断で Pleiad が止めたもの（stops）の形と、再開後の最初のターンでエージェントへ添える文（docs/design.md「中断と再開」）。
//
// 止めたものは会話の行（sidecar の stops。core/store.mjs の addStops / takeStops）に残す:
//   - 委譲タスク: 取り消したもの（止めた時点の状態）・終わっていたが完了通知が届いていなかったもの（unread）・再起動で止まったもの（restart）
//   - バックグラウンドの作業: ターンが抱えていたもの（Claude の run_in_background の Bash・サブエージェント）。CLI の終了で止まる
//   - 承認待ち: 却下扱いにしたもの（ツール名と対象の要約）
// 次のターン（人の発言・再開の文・送り直し・完了通知のどれでも。圧縮は除く）の始めに、文を 1 つ作って発言の前に添える。
// 添えた文は <pleiad-interruption> で囲む。履歴はこの印で人の発言から切り分け、システム側の 1 行として描く（splitInterruptionNote）。
// SDK も DOM も import しない。
import { agentT } from './i18n.mjs';
import { redactForPeer } from './redact.mjs';
import { INTERRUPTION_TAG } from './system-messages.mjs';

const OPEN = `<${INTERRUPTION_TAG}>`, CLOSE = `</${INTERRUPTION_TAG}>`;
const TEXT_MAX = 200;
const REASONS = new Set(['user', 'update', 'quit', 'hostAway', 'restart']);

const oneLine = (s, max = TEXT_MAX) => redactForPeer(String(s ?? '').replace(/\s+/g, ' ').trim(), max) ?? '';

/** 取り消した委譲タスク（agentTasks.cancelOwner・cancel・restored の項目）を stops の形にする */
export function taskStop(x, { restart = false } = {}) {
  return { key: `task:${x.taskId}`, taskId: x.taskId, title: oneLine(x.title, 80), status: String(x.status ?? ''),
    unread: Boolean(x.unread), ...(restart ? { restart: true } : {}) };
}

/** ターンが抱えていたバックグラウンドの作業（turn.info.background の行） */
export function backgroundStop(x) {
  return { key: `bg:${x.id}`, id: String(x.id), kind: ['agent', 'shell', 'terminal'].includes(x.kind) ? x.kind : 'other', label: oneLine(x.label) };
}

/** 承認待ちの対象の要約。コマンド・パス・URL を優先し、無ければ入力を JSON で（秘密は伏せる） */
function approvalTarget(payload) {
  if (payload?.kind === 'question') return oneLine(payload.questions?.[0]?.question ?? '');
  const input = payload?.input;
  if (!input || typeof input !== 'object') return '';
  for (const k of ['command', 'file_path', 'path', 'notebook_path', 'url', 'pattern', 'query', 'description']) {
    if (typeof input[k] === 'string' && input[k].trim()) return oneLine(input[k]);
  }
  const json = JSON.stringify(input);
  return json && json !== '{}' ? oneLine(json) : '';
}

/** 却下扱いにした承認待ち（runtime.waiting の行。id はカードの id） */
export function approvalStop(id, payload) {
  return { key: `ap:${id}`, tool: oneLine(payload?.toolName ?? '', 80), target: approvalTarget(payload) };
}

/**
 * エージェントへ添える文。止めたものが無ければ null。
 * 返り: { text, body, keys, dropped }。text はエージェントへ渡す文（印で囲む）、body は画面に出す中身。
 * keys は伝えた項目（渡ったら takeStops で消す）
 */
export function interruptionNote(lng, stops, reason = null) {
  if (!stops) return null;
  const tasks = stops.tasks ?? [], background = stops.background ?? [], approvals = stops.approvals ?? [];
  const cancelled = tasks.filter(x => !x.unread && !x.restart), unread = tasks.filter(x => x.unread), restarted = tasks.filter(x => x.restart && !x.unread);
  if (!tasks.length && !background.length && !approvals.length) return null;
  const item = x => agentT(lng, 'stops.taskItem', { taskId: x.taskId, title: x.title || '-', status: x.status || '-' });
  const sections = [];
  if (cancelled.length) sections.push(agentT(lng, 'stops.cancelled', { items: cancelled.map(item).join('\n') }));
  if (unread.length) sections.push(agentT(lng, 'stops.unread', { items: unread.map(x =>
    agentT(lng, 'stops.unreadItem', { taskId: x.taskId, title: x.title || '-', status: x.status || '-' })).join('\n') }));
  if (restarted.length) sections.push(agentT(lng, 'stops.restarted', { items: restarted.map(item).join('\n') }));
  if (background.length) sections.push(agentT(lng, 'stops.background', { items: background.map(x =>
    // i18n-dynamic: agent:stops.kind.
    agentT(lng, 'stops.backgroundItem', { id: x.id, kind: agentT(lng, `stops.kind.${x.kind}`), label: x.label || '-' })).join('\n') }));
  if (approvals.length) sections.push(agentT(lng, 'stops.approvals', { items: approvals.map(x =>
    agentT(lng, 'stops.approvalItem', { tool: x.tool || '-', target: x.target || '-' })).join('\n') }));
  if (stops.dropped) sections.push(agentT(lng, 'stops.dropped', { count: stops.dropped }));
  // i18n-dynamic: agent:stops.reason.
  const why = REASONS.has(reason) ? agentT(lng, `stops.reason.${reason}`) : agentT(lng, 'stops.reason.unknown');
  const body = [agentT(lng, 'stops.heading', { reason: why }), ...sections, agentT(lng, 'stops.footer')].join('\n\n');
  // 後ろを空けておく（人の発言と 1 つの文につながる履歴でも、読みやすく切れる）
  return { text: `${OPEN}\n${body}\n${CLOSE}\n\n`, body, keys: [...tasks, ...background, ...approvals].map(x => x.key), dropped: Boolean(stops.dropped) };
}
