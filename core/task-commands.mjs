import crypto from 'node:crypto';
import { redactForPeer } from './redact.mjs';

const TOOLS = new Set(['run_command', 'Bash', 'PowerShell', 'commandExecution']);
const DONE = new Set(['completed', 'failed', 'stopped', 'killed', 'declined']);

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
