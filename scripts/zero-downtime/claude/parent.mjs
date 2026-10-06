// 親（SDK の query を持つプロセス）の役。run.mjs・run2.mjs が起動し、kill して捨てる。
// 使い方: node parent.mjs <設定の JSON ファイル>
//   role 'first'  : 保持役に CLI を起動させて query を始める
//   role 'second' : 保持役の既存の子に付けて、新しい query（2 回目の initialize）を作る
//   direct: true  : 保持役を使わず SDK に CLI を起動させる（比べるための素の形）
// 出来事は 1 行 1 JSON で stdout に出す（run.mjs が記録して見張る）
// 段階 2-0 で足した設定（どれも省けば段階 0 と同じ）:
//   pleiad       Pleiad の実際のオプションに寄せる（settingSources user/project/local・skills 'all'・systemPrompt のプリセット + append・
//                replay-user-messages・thinking adaptive・フラグ設定）。append は systemPrompt の append
//   tools / model / claudeBin / envOver / compat（core/compat-endpoints.mjs の claudeCompatEnv に渡す接続先）/ settingsFile
//   probeMcp     probe-mcp.mjs を stdio の MCP として CLI に渡す（probeLog に出来事）
//   elicit       'hang' | 'accept'（onElicitation）。dialog: { kinds, mode: 'hang' | 'cancel' }（onUserDialog）。oauth: 'hang' | 'null'（getOAuthToken）
//   steer        { text, onToolUse: true, delayMs } 最初の tool_use を見たら uuid 付き・priority next で流し込む（Pleiad の途中送信と同じ形）
//   pushes       [{ afterResults, text }] result を数えて次の入力を流す（/compact など）
//   compactHookDelayMs  PreCompact のコールバックを遅らせる
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { query, createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { claudePath, connectHolder, makeSpawn, sleep } from './common.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const cfg = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const t0 = Date.now();
const ev = (name, data = {}) => process.stdout.write(JSON.stringify({ ev: name, ms: Date.now() - t0, role: cfg.role, ...data }) + '\n');
process.on('unhandledRejection', e => ev('unhandledRejection', { error: String(e?.stack ?? e).slice(0, 500) }));

const seqOfUuid = new Map();
let procRef = null;
let spawnClaudeCodeProcess;
if (!cfg.direct) {
  const client = await connectHolder(cfg.pipe);
  spawnClaudeCodeProcess = makeSpawn({
    onProcess: p => { procRef = p; },
    onSpawnOptions: o => ev('spawn.options', { command: o.command, args: (o.args ?? []).map(a => String(a).slice(0, 120)) }),
    client, id: cfg.id, mode: cfg.role === 'first' ? 'spawn' : 'attach', from: cfg.from ?? 1, redeliver: Boolean(cfg.redeliver),
    onLine(seq, line, info) {
      let type = '?', uuid = null, rid = null, sub = null;
      try { const m = JSON.parse(line); type = m.type + (m.subtype ? `/${m.subtype}` : ''); uuid = m.uuid ?? null; rid = m.request_id ?? null; sub = m.request?.subtype ?? null; } catch { /* ignore */ }
      if (uuid) seqOfUuid.set(uuid, seq);
      if (cfg.quietPush && type === 'stream_event') return;
      ev('push', { seq, type, uuid, rid, sub: sub ?? undefined, redelivered: info.redelivered ? 1 : undefined, replay: info.replay ? 1 : undefined, bytes: line.length });
    },
    onAttached: m => ev('attached', { seq: m.seq, exit: m.exit, pending: m.pending }),
  });
}

// 入力の流れ（閉じるまで CLI の stdin は閉じない）。uuid・priority を付けた user も流せるよう、メッセージをそのまま積む
const rawQueue = [];
let wakeRaw = null;
const input = {
  closed: false,
  push(m) { rawQueue.push(m); wakeRaw?.(); },
  close() { this.closed = true; wakeRaw?.(); },
  async *[Symbol.asyncIterator]() {
    for (;;) {
      if (rawQueue.length) { yield rawQueue.shift(); continue; }
      if (input.closed) return;
      await new Promise(r => { wakeRaw = r; });
      wakeRaw = null;
    }
  },
};
const pushUser = (text, extra = {}) => input.push({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null, ...extra });

const hooks = {};
if (cfg.hooks) {
  hooks.PreToolUse = [{ hooks: [async i => { ev('hook.pre.start', { tool: i.tool_name }); await sleep(cfg.hookPreDelayMs ?? 0); ev('hook.pre.done', { tool: i.tool_name }); return {}; }] }];
  hooks.PostToolUse = [{ hooks: [async i => { ev('hook.post', { tool: i.tool_name }); return {}; }] }];
}
if (cfg.compactHookDelayMs != null || cfg.pleiad) {
  hooks.PreCompact = [{ hooks: [async i => { ev('hook.precompact.start', { trigger: i.trigger }); await sleep(cfg.compactHookDelayMs ?? 0); ev('hook.precompact.done'); return {}; }] }];
  hooks.PostCompact = [{ hooks: [async i => { ev('hook.postcompact', { trigger: i.trigger, summary: String(i.compact_summary ?? '').slice(0, 80) }); return {}; }] }];
}
const mcpServers = {};
if (cfg.sdkMcp || cfg.pleiad) {
  mcpServers.host = createSdkMcpServer({
    name: 'host', version: '0.0.0',
    tools: [tool('ping', 'Returns a pong text. Takes no arguments.', {}, async () => {
      ev('mcp.ping.start'); await sleep(cfg.mcpDelayMs ?? 0); ev('mcp.ping.done');
      return { content: [{ type: 'text', text: `pong-from-${cfg.role}` }] };
    })],
  });
}
if (cfg.probeMcp) mcpServers.probe = { type: 'stdio', command: process.execPath, args: [path.join(here, 'probe-mcp.mjs')], env: { ...process.env, PROBE_LOG: cfg.probeLog } };

let env = { ...process.env, ...(cfg.envOver ?? {}) };
if (cfg.compat) { const { claudeCompatEnv } = await import('../../../core/compat-endpoints.mjs'); env = { ...claudeCompatEnv(process.env, cfg.compat), ...(cfg.envOver ?? {}) }; }
for (const k of cfg.envDrop ?? []) delete env[k];

const systemPrompt = cfg.pleiad
  ? { type: 'preset', preset: 'claude_code', append: cfg.append ?? 'You are a test fixture. Follow the user instruction literally. Be terse.', ...(cfg.snapshot === false ? { snapshot: false } : {}) }
  : 'You are a test fixture. Follow the user instruction literally. Be terse.' + (cfg.append ? `\n${cfg.append}` : '');

let q;
const options = {
  pathToClaudeCodeExecutable: cfg.claudeBin ?? claudePath(),
  ...(spawnClaudeCodeProcess ? { spawnClaudeCodeProcess } : {}),
  cwd: cfg.cwd,
  ...(cfg.model === null ? {} : { model: cfg.model ?? 'haiku' }),
  settingSources: cfg.pleiad ? ['user', 'project', 'local'] : [],
  ...(cfg.pleiad ? { skills: cfg.skills ?? 'all' } : {}),
  ...(cfg.settingsFile ? { settings: cfg.settingsFile } : cfg.pleiad ? { settings: { disableAllHooks: true } } : {}),
  systemPrompt,
  tools: cfg.tools ?? ['Bash'],
  includePartialMessages: cfg.partial ?? true,
  includeHookEvents: Boolean(cfg.hooks || cfg.pleiad),
  ...(cfg.pleiad && !cfg.compat ? { thinking: { type: 'adaptive' } } : {}),
  env,
  extraArgs: { 'strict-mcp-config': null, ...(cfg.pleiad || cfg.replay ? { 'replay-user-messages': null } : {}) },
  mcpServers,
  ...(Object.keys(hooks).length ? { hooks } : {}),
  permissionMode: cfg.bypass ? 'bypassPermissions' : 'default',
  ...(cfg.bypass ? { allowDangerouslySkipPermissions: true } : {}),
  canUseTool: async (toolName, inp, opts) => {
    ev('canUseTool', { toolName, requestId: opts.requestId, toolUseID: opts.toolUseID, signalAborted: opts.signal?.aborted });
    // 旧サーバーが静かに手を離す場合（clean=1: 手を離してから query を閉じる / clean=2: 手を離さずに閉じる＝対照）
    if (cfg.cleanDetach) setTimeout(() => {
      if (cfg.cleanDetach === 1) procRef.detach();
      ev('closing', { detached: cfg.cleanDetach === 1 });
      try { q.close(); } catch (e) { ev('close.error', { error: String(e) }); }
      setTimeout(() => { ev('closed'); process.exit(0); }, 500);
    }, 500);
    if (cfg.hangPermission) await new Promise(() => {});
    await sleep(cfg.allowDelayMs ?? 0);
    ev('canUseTool.allow', { requestId: opts.requestId });
    return { behavior: 'allow', updatedInput: inp };
  },
  ...(cfg.elicit ? { onElicitation: async (req, opts) => {
    ev('elicitation', { requestId: opts.requestId, server: req.serverName, message: req.message, mode: req.mode });
    if (cfg.elicit === 'hang') await new Promise(() => {});
    ev('elicitation.accept', { requestId: opts.requestId });
    return { action: 'accept', content: { codeword: `CW-${cfg.role}` } };
  } } : {}),
  ...(cfg.dialog ? { supportedDialogKinds: cfg.dialog.kinds, onUserDialog: async (req, opts) => {
    ev('userDialog', { requestId: opts.requestId, kind: req.dialogKind ?? req.dialog_kind, payload: JSON.stringify(req.payload ?? {}).slice(0, 200) });
    if (cfg.dialog.mode === 'hang') await new Promise(() => {});
    ev('userDialog.answer', { requestId: opts.requestId, mode: cfg.dialog.mode });
    return cfg.dialog.answer ?? { behavior: 'cancelled' };
  } } : {}),
  ...(cfg.oauth ? { getOAuthToken: async () => {
    ev('oauthRefresh');
    if (cfg.oauth === 'hang') await new Promise(() => {});
    return null;
  } } : {}),
  stderr: d => ev('cli.stderr', { d: String(d).slice(0, 300) }),
};
q = query({ prompt: input, options });

if (cfg.prompt) setTimeout(() => { ev('prompt.push'); pushUser(cfg.prompt); }, cfg.promptDelayMs ?? 0);
ev('query.created');
if (cfg.interruptAfterMs != null) setTimeout(async () => { const t = Date.now(); try { const r = await q.interrupt(cfg.cancelQueued ? { cancelQueued: true } : undefined); ev('interrupt.done', { took: Date.now() - t, receipt: r }); } catch (e) { ev('interrupt.error', { error: String(e).slice(0, 200) }); } }, cfg.interruptAfterMs);
if (cfg.setModeAfterMs != null) setTimeout(async () => { try { await q.setPermissionMode('acceptEdits'); ev('setPermissionMode.done'); } catch (e) { ev('setPermissionMode.error', { error: String(e).slice(0, 200) }); } }, cfg.setModeAfterMs);
if (cfg.initInfo) q.initializationResult().then(r => ev('init.result', {
  pendingPermission: (r.pending_permission_requests ?? []).length, pendingDialogs: (r.pending_user_dialog_requests ?? []).length,
  commands: (r.commands ?? []).length, agents: (r.agents ?? []).map(a => a.name ?? a).slice(0, 20), hooksApplied: r.hooks_applied,
  keys: Object.keys(r),
})).catch(e => ev('init.error', { error: String(e).slice(0, 200) }));

let steered = false;
const steer = () => {
  if (steered || !cfg.steer) return;
  steered = true;
  setTimeout(() => { const uuid = randomUUID(); ev('steer.push', { uuid, text: cfg.steer.text }); pushUser(cfg.steer.text, { uuid, priority: 'next' }); }, cfg.steer.delayMs ?? 0);
};
if (cfg.steer && !cfg.steer.onToolUse) steer();

let results = 0;
let firstStream = null, lastStream = null, streams = 0;
try {
  for await (const m of q) {
    const base = { type: m.type, subtype: m.subtype, uuid: m.uuid, seq: seqOfUuid.get(m.uuid), ptu: m.parent_tool_use_id ?? undefined };
    if (m.type === 'stream_event') {
      streams++; firstStream ??= Date.now() - t0; lastStream = Date.now() - t0;
      if (!cfg.quietStream) ev('msg', { ...base, event: m.event?.type });
      continue;
    }
    if (m.type === 'assistant') {
      const blocks = (m.message?.content ?? []).map(b => b.type === 'tool_use' ? { tool_use: b.name, input: JSON.stringify(b.input).slice(0, 160) } : { [b.type]: String(b.text ?? '').slice(0, 80), len: String(b.text ?? '').length });
      ev('msg', { ...base, blocks });
      if (blocks.some(b => 'tool_use' in b) && cfg.steer?.onToolUse) steer();
    } else if (m.type === 'user') {
      const content = m.message?.content;
      const blocks = (Array.isArray(content) ? content : []).map(b => b.type === 'tool_result' ? { tool_result: String(typeof b.content === 'string' ? b.content : JSON.stringify(b.content)).slice(0, 200), is_error: b.is_error ?? false } : { [b.type]: '' });
      ev('msg', { ...base, blocks, isReplay: m.isReplay, text: typeof content === 'string' ? content.slice(0, 120) : undefined });
    } else if (m.type === 'result') {
      results++;
      ev('msg', { ...base, is_error: m.is_error, result: String(m.result ?? '').slice(0, 200), resultLen: String(m.result ?? '').length, turns: m.num_turns, cost: m.total_cost_usd, streams, firstStream, lastStream });
      for (const p of cfg.pushes ?? []) if (p.afterResults === results) setTimeout(() => { ev('push.input', { text: p.text }); pushUser(p.text); }, p.delayMs ?? 0);
      if (cfg.exitAfterResult && results >= (cfg.resultsToExit ?? 1)) input.close();
    } else if (m.type === 'system') {
      const extra = m.subtype === 'init' ? { mcp: m.mcp_servers, tools: m.tools, cliVersion: m.claude_code_version, skills: (m.skills ?? []).length, slash: (m.slash_commands ?? []).length, plugins: (m.plugins ?? []).map(p => p.name), agents: m.agents, model: m.model }
        : { raw: JSON.stringify(m).slice(0, 400) };
      ev('msg', { ...base, ...extra });
    } else ev('msg', { ...base, raw: JSON.stringify(m).slice(0, 300) });
  }
  ev('done');
} catch (e) {
  ev('error', { error: String(e?.stack ?? e).slice(0, 600) });
}
await sleep(300);
process.exit(0);
