import crypto from 'node:crypto';
import { redactForPeer } from './redact.mjs';

const TOOLS = new Set(['run_command', 'Bash', 'PowerShell', 'commandExecution']);
const DONE = new Set(['completed', 'failed', 'stopped', 'killed', 'declined']);

// 明らかに「待つためのコマンド」（until / while のループ・sleep・gh run watch・--watch など）。子が止まっているのではなく、
// 何かの終わり（テスト・CI・サーバーの起動）を待っているだけなので、長時間・無音の通知の対象にしない（ADR 0136）。
const LEAD = String.raw`(?:^|[\s;&|(\x60'"])`;
const END = String.raw`(?=$|[\s;&|)'"])`;
const WAITING = new RegExp([
  String.raw`${LEAD}(?:sleep|start-sleep|wait-process|wait-job|wait-event|wait)${END}`,
  String.raw`${LEAD}until\s[\s\S]*\bdo\b`,
  String.raw`${LEAD}while\s[\s\S]*\bdo\b[\s\S]*\b(?:sleep|start-sleep)\b`,
  String.raw`\bgh\s+(?:run|workflow)\s+watch\b`,
  String.raw`\bgh\s+pr\s+checks\b[^\n]*--watch\b`,
  String.raw`--watch${END}`,
  String.raw`\btail\s+-[fF]\b`,
  String.raw`\btimeout\s+/t\b`,
  String.raw`\bping\s+-n\s+\d+`,
].join('|'), 'i');
export const isWaitingCommand = text => WAITING.test(String(text ?? ''));
/** 同じ子の同じコマンドを数える印（空白の違いは同じとみなす。長いコマンドは頭だけ） */
export const commandKey = text => String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, 300);
/** 出力が伸びている間（最後の実際の出力から OUTPUT_MOVING_MS 以内）は、待っている先が動いているとみなす */
export const OUTPUT_MOVING_MS = 60000;
export const outputMoving = (row, at, window = OUTPUT_MOVING_MS) => row.lastOutputAt != null && at - row.lastOutputAt < window;

// This clock measures observed execution/waiting, never silence. Approval time is excluded.
export function pauseCommands(row, at, waiting) {
  for (const c of row.activeCommands ?? []) {
    if (c.state === 'unknown') continue;
    if (waiting && c.pausedAt == null) c.pausedAt = at;
    if (!waiting && c.pausedAt != null) {
      c.pausedMs += Math.max(0, at - c.pausedAt);
      c.pausedAt = null;
    }
  }
}

export function commandElapsed(c, at) {
  return Math.max(0, (c.pausedAt ?? at) - (c.startedAt ?? c.observedAt) - c.pausedMs);
}

export function commandView(c, at) {
  const { pausedAt, pausedMs, notified, noticeId, ...rest } = c;
  return { ...rest, state: pausedAt != null ? 'approval' : c.state,
    elapsedMinutes: c.state === 'unknown' ? null : Math.floor(commandElapsed(c, at) / 60000),
    startKnown: c.startedAt != null };
}

export function observeCommand(row, event, at, waiting) {
  pauseCommands(row, at, waiting);
  const commands = row.activeCommands ??= [];
  if (event.type === 'tool.start' && row.status === 'running' && TOOLS.has(event.name) && event.id && !event.input?.rejected) {
    if (commands.some(c => c.toolCallId === event.id)) return;
    const input = event.input ?? {};
    commands.push({ taskId: row.taskId, sessionId: row.sessionId, backend: row.backend,
      turnId: event.turnId ?? null, toolCallId: event.id,
      command: redactForPeer(input.command ?? input.CommandLine ?? '', 2000),
      cwd: redactForPeer(input.cwd ?? input.Cwd ?? row.cwd ?? '', 1000),
      observedAt: at, startedAt: Number.isFinite(event.startedAt) ? event.startedAt : null,
      state: 'running', nativeTaskId: event.nativeTaskId ?? null, processId: event.processId ?? null,
      stopSupported: false, pausedAt: waiting ? at : null, pausedMs: 0,
      noticeId: crypto.randomUUID(), notified: false });
    return;
  }
  const c = commands.find(c => (event.id && c.toolCallId === event.id)
    || (event.nativeTaskId && c.nativeTaskId === event.nativeTaskId));
  if (!c) return;
  if (event.type === 'task.command') {
    if (event.nativeTaskId) c.nativeTaskId = event.nativeTaskId;
    if (event.processId) c.processId = event.processId;
    if (DONE.has(event.state)) commands.splice(commands.indexOf(c), 1);
    else if (['background', 'unknown'].includes(event.state)) c.state = event.state;
  } else if (event.type === 'tool.result') {
    if (!event.commandCompleted && !event.isError && (event.commandBackground || c.state === 'background')) {
      c.state = 'background';
      if (event.nativeTaskId) c.nativeTaskId = event.nativeTaskId;
    } else commands.splice(commands.indexOf(c), 1);
  }
}
