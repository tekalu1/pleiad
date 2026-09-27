#!/usr/bin/env node
// Pleiad hook adapter. Pleiad copies this file unchanged next to a copied hook's settings file
// (<settings folder>/pleiad-hooks/hook-adapter-<hash>.mjs). Do not edit a written copy: the hooks that point at it expect this content.
//
// A hook copied to another agent runs through this script (docs/context-management.md "Hooks", ADR 0047):
//   node hook-adapter-<hash>.mjs <from> <to> <event> <timeoutSec> <command as base64url>
// <to> is the agent that runs the hook now and writes its JSON on stdin. <from> is the agent the command was written for.
// The script rewrites the input into the <from> shape, runs the original command with the <from> agent's working folder,
// then rewrites the command's result into what <to> understands. It only uses Node's own modules, so it runs without Pleiad.
//
// Pleiad also runs hooks it registers itself through this script (ADR 0049, "Pleiad manages hooks"):
//   - <from> may equal <to>. The command then gets the runner's input unchanged, in the runner's own working folder
//     (Antigravity: <workspace>/.agents, not Pleiad's temporary folder), and its result goes back unchanged. The one change:
//     an Antigravity PreToolUse that says nothing (exit 0 with no decision) becomes "allow", because Antigravity would deny it.
//   - An optional 6th argument (the registration id) records each run as a JSON line in runs.jsonl next to this file,
//     so Pleiad can show which of its hooks ran (Antigravity reports no hook runs itself).
//
// When the two agents do not mean the same thing, it never swaps in a different meaning. It takes the safe side instead:
//   before a tool (PreToolUse)  -> deny   (ask that the runner cannot ask, updatedInput that agy cannot apply, timeout, start failure,
//                                          and anything agy itself treats as a failure)
//   at stop (Stop)              -> let the agent stop (no continue)
//   after a tool (PostToolUse)  -> nothing
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const AGENTS = ['claude', 'codex', 'antigravity'];
export const EVENTS = ['PreToolUse', 'PostToolUse', 'Stop', 'SessionStart', 'SessionEnd', 'UserPromptSubmit', 'SubagentStart', 'SubagentStop',
  'PermissionRequest', 'PreCompact', 'PostCompact'];
const OUTPUT_LIMIT = 1024 * 1024;
const STOP_LIMIT = 5;
const STOP_TTL = 24 * 60 * 60 * 1000;

// Tool names: Claude Code / Codex -> Antigravity, and back. Names not listed stay as they are
const TO_AGY = { Bash: 'run_command', Write: 'write_to_file', Edit: 'replace_file_content', Read: 'view_file', Grep: 'grep_search', Glob: 'find_by_name',
  WebFetch: 'read_url_content', WebSearch: 'search_web' };
const FROM_AGY = { run_command: 'Bash', write_to_file: 'Write', replace_file_content: 'Edit', multi_replace_file_content: 'Edit', view_file: 'Read',
  grep_search: 'Grep', find_by_name: 'Glob', read_url_content: 'WebFetch', search_web: 'WebSearch' };
// Codex has only the shell among these (file edits are apply_patch, whose input is a patch and cannot be built from agy's arguments)
const CODEX_FROM_AGY = { run_command: 'Bash' };

const record = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = v => (typeof v === 'string' ? v : '');
// Antigravity sends Windows paths with forward slashes (observed 2026-09-27: "D:/dev/..."). Give its commands the same form
const agyPath = p => (typeof p === 'string' && /^[A-Za-z]:[\\/]/.test(p) ? p.replace(/\\/g, '/') : p);
const defined = o => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

/** Claude Code / Codex tool_input -> Antigravity toolCall.args */
export function argsToAgy(tool, input, cwd) {
  const i = record(input) ? input : {};
  switch (tool) {
    case 'Bash': return defined({ CommandLine: str(i.command), Cwd: cwd });
    case 'Write': return defined({ TargetFile: i.file_path, CodeContent: i.content, Overwrite: true });
    case 'Edit': return defined({ TargetFile: i.file_path, TargetContent: i.old_string, ReplacementContent: i.new_string, AllowMultiple: i.replace_all === true });
    case 'Read': return defined({ AbsolutePath: i.file_path, StartLine: Number.isInteger(i.offset) ? i.offset : undefined,
      EndLine: Number.isInteger(i.offset) && Number.isInteger(i.limit) ? i.offset + i.limit : undefined });
    case 'Grep': return defined({ Query: i.pattern, SearchPath: i.path ?? cwd, IsRegex: true });
    case 'Glob': return defined({ Pattern: i.pattern, SearchDirectory: i.path ?? cwd });
    case 'WebFetch': return defined({ Url: i.url });
    case 'WebSearch': return defined({ query: i.query });
    default: return i;
  }
}
/** Antigravity toolCall.args -> Claude Code / Codex tool_input */
export function argsFromAgy(tool, args) {
  const a = record(args) ? args : {};
  switch (tool) {
    case 'run_command': return { command: str(a.CommandLine) };
    case 'write_to_file': return defined({ file_path: a.TargetFile, content: a.CodeContent });
    case 'replace_file_content': return defined({ file_path: a.TargetFile, old_string: a.TargetContent, new_string: a.ReplacementContent,
      replace_all: a.AllowMultiple === true ? true : undefined });
    case 'multi_replace_file_content': return defined({ file_path: a.TargetFile, edits: Array.isArray(a.ReplacementChunks)
      ? a.ReplacementChunks.map(c => ({ old_string: c?.TargetContent, new_string: c?.ReplacementContent })) : undefined });
    case 'view_file': return defined({ file_path: a.AbsolutePath, offset: a.StartLine, limit: Number.isInteger(a.StartLine) && Number.isInteger(a.EndLine) ? a.EndLine - a.StartLine : undefined });
    case 'grep_search': return defined({ pattern: a.Query, path: a.SearchPath });
    case 'find_by_name': return defined({ pattern: a.Pattern, path: a.SearchDirectory });
    case 'read_url_content': return defined({ url: a.Url });
    case 'search_web': return defined({ query: a.query });
    default: return a;
  }
}

/**
 * The input the runner (to) sent -> the input the original command (from) expects.
 * Returns { input, cwd, env, skip }. skip: the original agent would not have run the command for this input (Claude's PostToolUse is for successes only)
 */
export function toSourceInput({ from, to, event, input, processCwd = process.cwd(), exists = fs.existsSync }) {
  const i = record(input) ? input : {};
  if (to === 'antigravity') {
    // Antigravity runs hooks in <workspace>/.agents. Claude Code and Codex run them in the project folder
    const cwd = str(i.workspacePaths?.[0]) || (path.basename(processCwd) === '.agents' ? path.dirname(processCwd) : processCwd);
    const out = { session_id: str(i.conversationId), transcript_path: str(i.transcriptPath) || null, cwd, hook_event_name: event };
    if (from === 'codex') Object.assign(out, { turn_id: null, model: str(i.modelName) || null });
    if (event === 'PreToolUse' || event === 'PostToolUse') {
      const name = str(i.toolCall?.name);
      const mapped = (from === 'codex' ? CODEX_FROM_AGY : FROM_AGY)[name];
      Object.assign(out, { tool_name: mapped ?? name, tool_input: mapped ? argsFromAgy(name, i.toolCall?.args) : (record(i.toolCall?.args) ? i.toolCall.args : {}),
        tool_use_id: `${str(i.conversationId)}:${Number.isInteger(i.stepIdx) ? i.stepIdx : ''}` });
      if (event === 'PostToolUse') out.tool_response = from === 'codex' ? '' : {};
    }
    if (event === 'Stop') Object.assign(out, { stop_hook_active: Number.isInteger(i.executionNum) && i.executionNum > 0, last_assistant_message: '' });
    // Claude Code's PostToolUse runs only after a tool succeeded (failures go to PostToolUseFailure). Antigravity's also runs after failures
    const skip = from === 'claude' && event === 'PostToolUse' && str(i.error) !== '';
    return { input: out, cwd, env: from === 'claude' ? { CLAUDE_PROJECT_DIR: cwd } : {}, skip };
  }
  const cwd = str(i.cwd) || processCwd;
  if (from === 'antigravity') {
    const out = { conversationId: str(i.session_id), workspacePaths: [agyPath(cwd)], transcriptPath: agyPath(str(i.transcript_path)), artifactDirectoryPath: '', modelName: str(i.model) };
    if (event === 'PreToolUse' || event === 'PostToolUse') {
      const name = str(i.tool_name);
      out.toolCall = { name: TO_AGY[name] ?? name, args: TO_AGY[name] ? argsToAgy(name, i.tool_input, agyPath(cwd)) : (record(i.tool_input) ? i.tool_input : {}) };
      if (event === 'PostToolUse') out.error = '';
    }
    if (event === 'Stop') Object.assign(out, { executionNum: i.stop_hook_active === true ? 1 : 0, terminationReason: '', error: '', fullyIdle: true });
    const agents = path.join(cwd, '.agents');
    return { input: out, cwd: exists(agents) ? agents : cwd, env: { ANTIGRAVITY_CONVERSATION_ID: str(i.session_id) }, skip: false };
  }
  // Claude Code <-> Codex: the input is nearly the same shape (observed 2026-09-27). Pass it as it is
  return { input: i, cwd, env: from === 'claude' && !process.env.CLAUDE_PROJECT_DIR ? { CLAUDE_PROJECT_DIR: cwd } : {}, skip: false };
}

const parse = text => { try { const v = JSON.parse(text); return record(v) ? v : null; } catch { return null; } };
const firstLine = s => str(s).trim().split(/\r?\n/)[0]?.slice(0, 500) ?? '';

/**
 * What the original command decided, in words shared by all agents.
 * gate (PreToolUse): pass | allow | deny | ask | forceAsk ; stop (Stop): stop | continue ; plus reason and extras.
 * failed: the command did not give a result the original agent would accept (timeout, could not start, and for Antigravity bad JSON or a non-zero exit)
 */
export function readResult({ from, event, result }) {
  const { code = 0, stdout = '', stderr = '', timedOut = false, startError = null } = result ?? {};
  if (timedOut || startError || result?.overflow) return { failed: true, why: timedOut ? 'timeout' : result?.overflow ? 'output' : 'start',
    reason: timedOut ? 'Hook timed out' : result?.overflow ? 'Hook output exceeded 1 MiB' : `Hook could not start: ${startError}` };
  if (from === 'antigravity') {
    // Antigravity needs JSON on stdout and stops the tool on a non-zero exit or bad JSON (observed 2026-09-27)
    const out = code === 0 ? parse(stdout.trim() || '{}') : null;
    if (!out) return { failed: true, why: code === 0 ? 'output' : 'exit', reason: firstLine(stderr) || `Hook exited with ${code}` };
    if (event === 'PreToolUse') {
      const d = str(out.decision);
      const map = { allow: 'allow', deny: 'deny', ask: 'ask', force_ask: 'forceAsk', deny_unless_prior_grant: 'deny' };
      if (!map[d]) return { failed: true, why: 'output', reason: `Unknown decision "${d}"` };
      return { gate: map[d], reason: str(out.reason), dropped: out.permissionOverrides ? ['permissionOverrides'] : [] };
    }
    if (event === 'Stop') return { stop: out.decision === 'continue' ? 'continue' : 'stop', reason: str(out.reason) };
    return { gate: 'pass' };
  }
  // Claude Code / Codex: exit 2 blocks (before a tool) or continues (at stop), with stderr as the reason. Other non-zero exits are
  // non-blocking errors in both agents, so the command's decision is "no opinion"
  if (code === 2) return event === 'Stop' ? { stop: 'continue', reason: firstLine(stderr) } : { gate: 'deny', reason: firstLine(stderr) || 'Blocked by hook' };
  if (code !== 0) {
    if (event === 'PreToolUse' && ([126, 127, 9009].includes(code) || /(?:認識されていません|not recognized as an internal or external command|command not found|permission denied)/i.test(stderr)))
      return { failed: true, why: 'start', reason: firstLine(stderr) || `Hook exited with ${code}` };
    return event === 'Stop' ? { stop: 'stop' } : { gate: 'pass' };
  }
  // exit 0: JSON is read; plain text is not a decision (both agents accept plain output)
  const out = parse(stdout.trim()) ?? {};
  const hso = record(out.hookSpecificOutput) ? out.hookSpecificOutput : {};
  if (event === 'Stop') {
    if (out.continue === false) return { stop: 'stop' };
    return out.decision === 'block' ? { stop: 'continue', reason: str(out.reason) } : { stop: 'stop' };
  }
  if (event !== 'PreToolUse') return { gate: 'pass', raw: out };
  // continue: false stops the whole agent in Claude Code. Before a tool, the closest safe meaning is to deny this tool
  if (out.continue === false) return { gate: 'deny', reason: str(out.stopReason) || str(out.reason) || 'Stopped by hook', raw: out };
  const legacy = { approve: 'allow', block: 'deny' }[str(out.decision)];
  const d = str(hso.permissionDecision) || legacy || '';
  const gate = { allow: 'allow', deny: 'deny', ask: 'ask', defer: 'defer' }[d] ?? 'pass';
  return { gate, reason: str(hso.permissionDecisionReason) || str(out.reason), updatedInput: record(hso.updatedInput) ? hso.updatedInput : null, raw: out };
}

const denyFor = (agent, reason) => agent === 'antigravity' ? { decision: 'deny', reason }
  : { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } };

/** The decision -> the JSON the runner (to) understands. Always exit 0 with JSON (the runner's own failure rules do not come into play) */
export function toTargetOutput({ from, to, event, decision }) {
  const d = decision ?? {};
  if (event === 'PostToolUse' || !['PreToolUse', 'Stop'].includes(event)) {
    // After a tool and the other events: Antigravity reads nothing back. Claude Code <-> Codex pass the command's JSON on
    return to === 'antigravity' || !d.raw ? {} : d.raw;
  }
  if (event === 'Stop') {
    if (d.failed || d.stop !== 'continue') return to === 'antigravity' ? { decision: 'stop' } : {};
    const reason = d.reason || 'Continue (hook)';
    return to === 'antigravity' ? { decision: 'continue', reason } : { decision: 'block', reason };
  }
  // PreToolUse
  const note = s => (d.reason ? `${d.reason} (${s})` : s);
  if (d.failed) return denyFor(to, note(`${d.why === 'timeout' ? 'timed out' : 'failed'}; denied by the Pleiad hook adapter`));
  if (to === 'antigravity') {
    // Antigravity cannot rewrite a tool's input. Running the unrewritten input could do what the hook meant to prevent
    if (d.updatedInput) return { decision: 'deny', reason: note('updatedInput is not supported by Antigravity; denied') };
    switch (d.gate) {
      case 'deny': return { decision: 'deny', reason: d.reason || 'Denied by hook' };
      case 'ask': case 'defer': return { decision: 'ask', ...(d.reason ? { reason: d.reason } : {}) };
      // Claude Code's allow skips the permission prompt; Antigravity's allow still goes through its own permissions (observed). No output = pass
      default: return { decision: 'allow', ...(d.reason ? { reason: d.reason } : {}) };
    }
  }
  if (to === 'codex') {
    // Codex does not support ask (it would be a hook failure and the tool would run)
    if (['ask', 'forceAsk', 'defer'].includes(d.gate)) return denyFor('codex', note('Codex cannot ask; denied'));
    if (d.gate === 'deny') return denyFor('codex', d.reason || 'Denied by hook');
    const base = from === 'claude' && d.raw ? { ...d.raw } : {};
    delete base.decision; delete base.reason; delete base.continue; delete base.stopReason;
    const hso = record(base.hookSpecificOutput) ? { ...base.hookSpecificOutput } : {};
    if (d.gate === 'allow' && from === 'claude') { hso.hookEventName = 'PreToolUse'; hso.permissionDecision = 'allow'; if (d.reason) hso.permissionDecisionReason = d.reason; }
    if (d.updatedInput && from === 'claude') { hso.hookEventName = 'PreToolUse'; hso.updatedInput = d.updatedInput; }
    if (Object.keys(hso).length) base.hookSpecificOutput = hso; else delete base.hookSpecificOutput;
    return base;
  }
  // to Claude Code
  if (d.gate === 'deny') return denyFor('claude', d.reason || 'Denied by hook');
  if (d.gate === 'ask' || d.gate === 'forceAsk') return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', ...(d.reason ? { permissionDecisionReason: d.reason } : {}) } };
  // Antigravity's allow does not grant permissions (observed). Pass, so Claude Code's own permission check still applies
  return {};
}

/** Runs the original command in a shell. Kills it (and its children) after timeoutMs */
export function runCommand(command, { input, cwd, env, timeoutMs }) {
  return new Promise(resolve => {
    let child;
    const bash = process.env.CLAUDE_CODE_GIT_BASH_PATH || ['C:/Program Files/Git/bin/bash.exe', 'C:/Program Files/Git/usr/bin/bash.exe'].find(fs.existsSync);
    const systemRoot = process.env.SystemRoot || 'C:/Windows';
    const shell = process.platform === 'win32' ? env?.__pleiadFrom === 'claude' ? bash
      : env?.__pleiadFrom === 'codex' ? path.join(systemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe')
        : process.env.ComSpec || path.join(systemRoot, 'System32/cmd.exe') : true;
    if (!shell) { resolve({ startError: 'Git Bash was not found' }); return; }
    const childEnv = { ...process.env, ...env };
    delete childEnv.__pleiadFrom;
    try { child = spawn(command, { cwd, env: childEnv, shell, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] }); }
    catch (e) { resolve({ startError: String(e?.message ?? e) }); return; }
    let stdout = '', stderr = '', done = false, timedOut = false, overflow = false;
    const finish = r => { if (done) return; done = true; clearTimeout(timer); resolve(r); };
    const kill = () => {
      if (process.platform === 'win32' && child.pid) spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
      else if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }
      child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
      finish({ timedOut: true, stdout, stderr });
    }, timeoutMs);
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    const append = (which, chunk) => {
      if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) + Buffer.byteLength(chunk) > OUTPUT_LIMIT) {
        overflow = true; kill(); finish({ overflow: true, stdout, stderr }); return;
      }
      if (which === 'stdout') stdout += chunk; else stderr += chunk;
    };
    child.stdout.on('data', b => append('stdout', b));
    child.stderr.on('data', b => append('stderr', b));
    child.on('error', e => finish({ startError: String(e?.message ?? e), stdout, stderr }));
    child.on('close', code => { if (!timedOut) finish({ code: code ?? 1, stdout, stderr, overflow }); });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(input));
  });
}

const sha = text => crypto.createHash('sha256').update(text).digest('hex');
function stopState(session, command, stateDir = os.tmpdir()) {
  if (!session) return null;
  const file = path.join(stateDir, `pleiad-hook-stop-${sha(`${session}\0${command}`).slice(0, 24)}.json`);
  try {
    const stat = fs.statSync(file);
    if (Date.now() - stat.mtimeMs > STOP_TTL) return { file, count: 0 };
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { file, count: Number.isInteger(data.count) && data.count >= 0 ? Math.min(data.count, STOP_LIMIT) : 0 };
  } catch { return { file, count: 0 }; }
}
function saveStop(state, count) {
  if (!state) return false;
  try { fs.writeFileSync(state.file, JSON.stringify({ count }), { mode: 0o600 }); return true; } catch { return false; }
}
function validSelf(file) {
  const name = path.basename(file);
  if (name === 'hook-adapter.mjs') return true; // The repository source has no hash in its name.
  const match = /^hook-adapter-([0-9a-f]{12})\.mjs$/.exec(name);
  return Boolean(match) && sha(fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n')).startsWith(match[1]);
}

export function decodeCommand(text) {
  return Buffer.from(String(text ?? ''), 'base64url').toString('utf8');
}

/**
 * The same agent on both sides (Pleiad's own registrations, ADR 0049): the command gets the input unchanged in the runner's working folder,
 * and its output and exit code go back unchanged. Antigravity: a PreToolUse with no decision becomes allow (Antigravity denies on "{}").
 */
export function sameAgentRun({ to, event, input, processCwd = process.cwd(), exists = fs.existsSync }) {
  if (to === 'antigravity') {
    const workspace = str(input.workspacePaths?.[0]) || (path.basename(processCwd) === '.agents' ? path.dirname(processCwd) : processCwd);
    const agents = path.join(workspace, '.agents');
    return { cwd: exists(agents) ? agents : workspace, env: { ANTIGRAVITY_CONVERSATION_ID: str(input.conversationId) } };
  }
  const cwd = str(input.cwd) || processCwd;
  return { cwd, env: to === 'claude' && !process.env.CLAUDE_PROJECT_DIR ? { CLAUDE_PROJECT_DIR: cwd } : {} };
}
export function sameAgentOutput({ to, event, result }) {
  const { code = 0, stdout = '', stderr = '', timedOut = false, startError = null, overflow = false } = result ?? {};
  if (timedOut || startError || overflow) {
    const why = timedOut ? 'Hook timed out' : overflow ? 'Hook output exceeded 1 MiB' : `Hook could not start: ${startError}`;
    // Antigravity stops the tool on a failed hook; the others treat it as a non-blocking error. Keep each agent's own rule
    return { stdout: '', stderr: `${why}\n`, code: 1 };
  }
  if (to === 'antigravity' && event === 'PreToolUse' && code === 0) {
    const out = parse(String(stdout).trim() || '{}');
    if (out && !str(out.decision)) return { stdout: JSON.stringify({ ...out, decision: 'allow' }), stderr: str(stderr), code: 0 };
  }
  return { stdout: str(stdout), stderr: str(stderr), code: Number.isInteger(code) ? code : 1 };
}

const RECORD_ID = /^[A-Za-z0-9_-]{1,64}$/;
/** One line per run in runs.jsonl next to this file. Never the command's input or output (they can hold secrets) */
function recordRun(selfPath, line) {
  try { fs.appendFileSync(path.join(path.dirname(selfPath), 'runs.jsonl'), `${JSON.stringify(line)}\n`, { mode: 0o600 }); } catch {}
}

/** One run: stdin JSON in, JSON out. Returns { stdout, stderr, code } */
export async function adapt({ argv, stdin, run = runCommand, processCwd = process.cwd(), stateDir = os.tmpdir(), selfPath = fileURLToPath(import.meta.url) }) {
  const [from, to, event, timeoutText, encoded, recordId] = argv;
  const record = RECORD_ID.test(recordId ?? '') ? recordId : null;
  const runId = record ? crypto.randomUUID() : null;
  const at = Date.now();
  if (record) recordRun(selfPath, { phase: 'started', runId, id: record, event, at });
  const out = await adaptOnce({ from, to, event, timeoutText, encoded, stdin, run, processCwd, stateDir, selfPath });
  if (record) recordRun(selfPath, { phase: 'response', runId, id: record, event, at: Date.now(), ms: Date.now() - at, ...(out.outcome ?? {}) });
  return { stdout: out.stdout, stderr: out.stderr, code: out.code };
}
async function adaptOnce({ from, to, event, timeoutText, encoded, stdin, run, processCwd, stateDir, selfPath }) {
  const timeout = Number(timeoutText);
  // A broken call (hand-edited settings) fails the safe way for the runner
  const broken = why => ({ stdout: JSON.stringify(toTargetOutput({ from: from ?? 'claude', to: AGENTS.includes(to) ? to : 'claude', event, decision: { failed: true, why: 'start', reason: why } })), stderr: `pleiad hook adapter: ${why}\n`, code: 0, outcome: { outcome: 'error' } });
  if (!AGENTS.includes(from) || !AGENTS.includes(to) || !EVENTS.includes(event)) return broken('bad arguments');
  const command = decodeCommand(encoded);
  if (!command.trim() || !Number.isInteger(timeout) || timeout < 1 || timeout > 86400) return broken('bad arguments');
  try { if (!validSelf(selfPath)) return broken('adapter content hash mismatch'); }
  catch { return broken('adapter content could not be checked'); }
  const input = parse(String(stdin ?? '').trim());
  if (!input) return broken('the agent did not send JSON');
  if (from === to) {
    const where = sameAgentRun({ to, event, input, processCwd });
    const result = await run(command, { input, cwd: where.cwd, env: { ...where.env, __pleiadFrom: from }, timeoutMs: timeout * 1000 });
    const out = sameAgentOutput({ to, event, result });
    return { ...out, outcome: { outcome: result.timedOut ? 'cancelled' : out.code === 0 ? 'success' : 'error', exitCode: result.code ?? null } };
  }
  const src = toSourceInput({ from, to, event, input, processCwd });
  const session = str(input.session_id) || str(input.conversationId);
  const state = event === 'Stop' ? stopState(session, command, stateDir) : null;
  if (event === 'Stop' && !state) return broken('Stop session id is missing');
  if (event === 'Stop' && from === 'antigravity') src.input.executionNum = Math.max(src.input.executionNum ?? 0, state.count);
  if (event === 'Stop' && from !== 'antigravity' && state.count > 0) src.input.stop_hook_active = true;
  if (src.skip) return { stdout: JSON.stringify(toTargetOutput({ from, to, event, decision: { gate: 'pass', stop: 'stop' } })), stderr: '', code: 0, outcome: { outcome: 'success', skipped: true } };
  const result = await run(command, { input: src.input, cwd: src.cwd, env: { ...src.env, __pleiadFrom: from }, timeoutMs: timeout * 1000 });
  const decision = readResult({ from, event, result });
  if (event === 'Stop') {
    if (decision.stop === 'continue' && !decision.failed) {
      if (state.count >= STOP_LIMIT || !saveStop(state, state.count + 1)) decision.stop = 'stop';
    } else saveStop(state, 0);
  }
  return { stdout: JSON.stringify(toTargetOutput({ from, to, event, decision })), stderr: str(result.stderr), code: 0,
    outcome: { outcome: result.timedOut ? 'cancelled' : decision.failed ? 'error' : 'success', exitCode: result.code ?? null } };
}

async function main() {
  let stdin = '';
  for await (const chunk of process.stdin) stdin += chunk;
  const out = await adapt({ argv: process.argv.slice(2), stdin });
  if (out.stderr) process.stderr.write(out.stderr);
  process.stdout.write(out.stdout, () => process.exit(out.code));
}

// Run only when started as a script (tests import the functions). Compare real paths, ignoring case on Windows
const real = p => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
const key = p => (process.platform === 'win32' ? real(p).toLowerCase() : real(p));
if (process.argv[1] && key(process.argv[1]) === key(fileURLToPath(import.meta.url))) await main();
