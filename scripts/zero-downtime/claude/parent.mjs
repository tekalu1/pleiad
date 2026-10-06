// 親（SDK の query を持つプロセス）の役。run.mjs が起動し、kill して捨てる。
// 使い方: node parent.mjs <設定の JSON ファイル>
//   role 'first'  : 保持役に CLI を起動させて query を始める
//   role 'second' : 保持役の既存の子に付けて、新しい query（2 回目の initialize）を作る
// 出来事は 1 行 1 JSON で stdout に出す（run.mjs が記録して見張る）
import fs from 'node:fs';
import { query, createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { claudePath, connectHolder, makeSpawn, createInput, sleep } from './common.mjs';

const cfg = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const t0 = Date.now();
const ev = (name, data = {}) => process.stdout.write(JSON.stringify({ ev: name, ms: Date.now() - t0, role: cfg.role, ...data }) + '\n');
process.on('unhandledRejection', e => ev('unhandledRejection', { error: String(e?.stack ?? e).slice(0, 500) }));

const client = await connectHolder(cfg.pipe);
const seqOfUuid = new Map();
let procRef = null;
const spawnClaudeCodeProcess = makeSpawn({
  onProcess: p => { procRef = p; },
  client, id: cfg.id, mode: cfg.role === 'first' ? 'spawn' : 'attach', from: cfg.from ?? 1, redeliver: Boolean(cfg.redeliver),
  onLine(seq, line, info) {
    let type = '?', uuid = null, rid = null;
    try { const m = JSON.parse(line); type = m.type + (m.subtype ? `/${m.subtype}` : ''); uuid = m.uuid ?? null; rid = m.request_id ?? null; } catch { /* ignore */ }
    if (uuid) seqOfUuid.set(uuid, seq);
    ev('push', { seq, type, uuid, rid, redelivered: info.redelivered ? 1 : undefined, replay: info.replay ? 1 : undefined, bytes: line.length });
  },
  onAttached: m => ev('attached', { seq: m.seq, exit: m.exit, pending: m.pending }),
});

const input = createInput();
const hooks = cfg.hooks ? {
  PreToolUse: [{ hooks: [async i => { ev('hook.pre.start', { tool: i.tool_name }); await sleep(cfg.hookPreDelayMs ?? 0); ev('hook.pre.done', { tool: i.tool_name }); return {}; }] }],
  PostToolUse: [{ hooks: [async i => { ev('hook.post', { tool: i.tool_name }); return {}; }] }],
} : undefined;
const mcpServers = cfg.sdkMcp ? {
  host: createSdkMcpServer({
    name: 'host', version: '0.0.0',
    tools: [tool('ping', 'Returns a pong text. Takes no arguments.', {}, async () => {
      ev('mcp.ping.start'); await sleep(cfg.mcpDelayMs ?? 0); ev('mcp.ping.done');
      return { content: [{ type: 'text', text: `pong-from-${cfg.role}` }] };
    })],
  }),
} : {};

const q = query({
  prompt: input,
  options: {
    pathToClaudeCodeExecutable: claudePath(),
    spawnClaudeCodeProcess,
    cwd: cfg.cwd,
    model: 'haiku',
    settingSources: [],
    systemPrompt: 'You are a test fixture. Follow the user instruction literally. Be terse.',
    tools: ['Bash'],
    includePartialMessages: true,
    includeHookEvents: Boolean(cfg.hooks),
    env: { ...process.env },
    extraArgs: { 'strict-mcp-config': null },
    mcpServers,
    ...(hooks ? { hooks } : {}),
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
    stderr: d => ev('cli.stderr', { d: String(d).slice(0, 300) }),
  },
});

if (cfg.prompt) setTimeout(() => { ev('prompt.push'); input.push(cfg.prompt); }, cfg.promptDelayMs ?? 0);
ev('query.created');
if (cfg.interruptAfterMs != null) setTimeout(async () => { const t = Date.now(); try { await q.interrupt(); ev('interrupt.done', { took: Date.now() - t }); } catch (e) { ev('interrupt.error', { error: String(e).slice(0, 200) }); } }, cfg.interruptAfterMs);
if (cfg.setModeAfterMs != null) setTimeout(async () => { try { await q.setPermissionMode('acceptEdits'); ev('setPermissionMode.done'); } catch (e) { ev('setPermissionMode.error', { error: String(e).slice(0, 200) }); } }, cfg.setModeAfterMs);

let results = 0;
try {
  for await (const m of q) {
    const base = { type: m.type, subtype: m.subtype, uuid: m.uuid, seq: seqOfUuid.get(m.uuid) };
    if (m.type === 'stream_event') { ev('msg', { ...base, event: m.event?.type }); continue; }
    if (m.type === 'assistant') {
      const blocks = (m.message?.content ?? []).map(b => b.type === 'tool_use' ? { tool_use: b.name, input: JSON.stringify(b.input).slice(0, 120) } : { [b.type]: String(b.text ?? '').slice(0, 80) });
      ev('msg', { ...base, blocks });
    } else if (m.type === 'user') {
      const blocks = (Array.isArray(m.message?.content) ? m.message.content : []).map(b => b.type === 'tool_result' ? { tool_result: String(typeof b.content === 'string' ? b.content : JSON.stringify(b.content)).slice(0, 200), is_error: b.is_error ?? false } : { [b.type]: '' });
      ev('msg', { ...base, blocks, isReplay: m.isReplay });
    } else if (m.type === 'result') {
      results++;
      ev('msg', { ...base, is_error: m.is_error, result: String(m.result ?? '').slice(0, 200), turns: m.num_turns, cost: m.total_cost_usd });
      if (cfg.exitAfterResult && results >= (cfg.resultsToExit ?? 1)) input.close();
    } else ev('msg', { ...base, ...(m.subtype === 'init' ? { mcp: m.mcp_servers, tools: m.tools, cliVersion: m.claude_code_version } : {}) });
  }
  ev('done');
} catch (e) {
  ev('error', { error: String(e?.stack ?? e).slice(0, 600) });
}
await sleep(300);
process.exit(0);
