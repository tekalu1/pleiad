// stream-json を話す偽の Claude Code CLI（無停止の更新 段階 2 の 2c のテスト。tests/unit/adopt-claude.mjs）。LLM を呼ばない。
// SDK（@anthropic-ai/claude-agent-sdk）が起こす本物の CLI と同じ口で動く: 標準入力の 1 行 1 JSON（control_request・user）を受け、
// 標準出力へ system/init・stream_event・assistant・user・result と、SDK への依頼（can_use_tool・hook_callback・mcp_message）を出す。
// transcript（<CLAUDE_CONFIG_DIR>/projects/<cwd>/<id>.jsonl。発言と cost-state）も書くので、Pleiad の履歴と使用量の差し引きが本物と同じ道を通る。
// 保持役の子として走り、親（SDK）を付け直されても続く: 2 回目以降の initialize で、答えを待っている承認を pending_permission_requests で返し、
// 走っている hooks のコールバックを control_cancel_request で取り消し、裏の作業の全量を background_tasks_changed で出し直す（stage0-claude.md・stage2-claude.md の実測の形）。
//
// 発言の台本: "script:" + JSON { steps: [...] }。それ以外の発言は "echo: <発言>" と答える。手順:
//   { text }                    本文を書いて内部ターンを終える（result）。台本の最後に置く
//   { tool, input?, result?, ask?, ms?, gate? }   ツールを呼ぶ。ask は承認（can_use_tool）を待つ。ms・gate（AGENT_HOST_FAKE_GATE_DIR のファイル）はツールの実行の長さ
//   { mcp: { server, tool, arguments } }          SDK の MCP（in-process の host など）のツールを mcp_message で呼ぶ
//   { http: { server, tool, arguments } }         --mcp-config の HTTP の MCP（ply_context など）のツールを呼ぶ。tool は説明の頭（"[fixture / count]" など）で探す
//   { compact: true, gate? }    圧縮: PreCompact のコールバック（gate までは答えを待つ形にする）→ compact_boundary → PostCompact
//   { bg: { gate } }            裏のコマンドを始める（gate が開くと終わり、main が再開して一言答える）
// 途中送信（uuid つきの user）は次のツールの区切りで折り込み、isReplay の echo を返し、最後の本文に「受け取った: <本文>」を足す。
// --version は "2.1.288 (Claude Code)"、auth status は ログイン済みの JSON を返す。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const VERSION = process.env.FAKE_CLAUDE_VERSION || '2.1.288';
const argv = process.argv.slice(2);
if (argv.includes('--version')) { process.stdout.write(`${VERSION} (Claude Code)\n`); process.exit(0); }
if (argv[0] === 'auth') { process.stdout.write(`${JSON.stringify({ loggedIn: true, authMethod: 'fake', email: 'fake@example.invalid' })}\n`); process.exit(0); }

const MODEL = 'claude-fake';
const uuid = () => crypto.randomUUID();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const resumeArg = argv.find(a => a.startsWith('--resume='))?.slice(9) ?? (argv.includes('--resume') ? argv[argv.indexOf('--resume') + 1] : null);
const sessionId = resumeArg || uuid();
const cwd = process.cwd();
const configDir = process.env.CLAUDE_CONFIG_DIR;
const transcript = configDir ? path.join(configDir, 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'), `${sessionId}.jsonl`) : null;
const gateDir = process.env.AGENT_HOST_FAKE_GATE_DIR;
// SDK が渡す MCP の設定（--mcp-config <JSON>。HTTP の Pleiad の口の URL とヘッダー）
const mcpConfig = (() => { const i = argv.indexOf('--mcp-config'); try { return i >= 0 ? JSON.parse(argv[i + 1]).mcpServers ?? {} : {}; } catch { return {}; } })();
async function httpMcp(serverName, method, params) {
  const server = mcpConfig[serverName];
  if (!server?.url) throw new Error(`no MCP server ${serverName}`);
  const res = await fetch(server.url, { method: 'POST', headers: { 'content-type': 'application/json', ...(server.headers ?? {}) }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const body = await res.json();
  if (body.error) throw new Error(typeof body.error === 'string' ? `${res.status} ${body.error}` : body.error.message);
  return body.result;
}

let lastWrite = Promise.resolve();
const out = value => { if (process.env.FAKE_CLAUDE_TRACE) log(`> ${value.type}${value.subtype ? '/' + value.subtype : ''}${value.request?.subtype ? ' ' + value.request.subtype : ''}${value.event?.type ? ' ' + value.event.type : ''}`); const line = `${JSON.stringify(value)}\n`; lastWrite = new Promise(resolve => process.stdout.write(line, resolve)); };
const log = text => { if (process.env.FAKE_CLAUDE_LOG) fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, `${new Date().toISOString()} ${process.pid} ${text}\n`); };

// ---- transcript（会話の記録。SDK の getSessionMessages と Pleiad の費用の差し引きが読む）
let parent = null;
function readTail() {
  if (!transcript) return { cost: { totalCostUSD: 0, modelUsage: {} } };
  let cost = { totalCostUSD: 0, modelUsage: {} };
  try {
    for (const line of fs.readFileSync(transcript, 'utf8').split('\n')) {
      if (!line) continue;
      const row = JSON.parse(line);
      if (row.type === 'cost-state') cost = { totalCostUSD: row.totalCostUSD, modelUsage: row.modelUsage };
      if (row.uuid && (row.type === 'user' || row.type === 'assistant')) parent = row.uuid;
    }
  } catch { /* 新しい会話 */ }
  return { cost };
}
const base = readTail().cost;
const record = row => {
  if (!transcript) return;
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  fs.appendFileSync(transcript, `${JSON.stringify({ parentUuid: parent, isSidechain: false, userType: 'external', cwd, sessionId, version: VERSION, timestamp: new Date().toISOString(), ...row })}\n`);
  if (row.uuid && (row.type === 'user' || row.type === 'assistant')) parent = row.uuid;
};
// この CLI のプロセスの使用量（内部ターンごとに足す。result は会話の累計 = 始まりの cost-state + この分）
const spent = { costUSD: 0, inputTokens: 0, outputTokens: 0 };
const cumulative = () => {
  const prev = base.modelUsage?.[MODEL] ?? { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 };
  return {
    totalCostUSD: Math.round(((base.totalCostUSD ?? 0) + spent.costUSD) * 1e9) / 1e9,
    modelUsage: { ...base.modelUsage, [MODEL]: { inputTokens: prev.inputTokens + spent.inputTokens, outputTokens: prev.outputTokens + spent.outputTokens, cacheReadInputTokens: prev.cacheReadInputTokens ?? 0, cacheCreationInputTokens: prev.cacheCreationInputTokens ?? 0 } },
  };
};

// ---- SDK への依頼（答えを待つ）
const waiting = new Map();   // request_id -> { resolve, reject, request }
let hooks = {};              // event -> [callback id]
let initializes = 0;
function ask(request) {
  const id = `req_${uuid().slice(0, 12)}`;
  return new Promise((resolve, reject) => {
    waiting.set(id, { resolve, reject, request });
    out({ type: 'control_request', request_id: id, request });
  });
}
async function fireHook(event, input, { gate = null } = {}) {
  for (const callbackId of hooks[event] ?? []) {
    try {
      const answer = ask({ subtype: 'hook_callback', callback_id: callbackId, input: { hook_event_name: event, session_id: sessionId, cwd, ...input }, tool_use_id: null });
      // gate までは答えを使わない（答えが遅れている形。付け直しで取り消されたら次へ）
      await Promise.all([answer, gate ? waitGate(gate) : null]);
    } catch (error) { log(`hook ${event} cancelled: ${error.message}`); }
  }
}
// 中断（interrupt）でも待ちをやめる
const waitGate = async name => { while (!interrupted && !fs.existsSync(path.join(gateDir ?? '.', name))) await sleep(30); };

// ---- 走っている状態
const queue = [];            // 発言・途中送信 { text, uuid }
let busy = false, ended = false, interrupted = false;
const background = new Map();   // task_id -> { task_id, task_type, description }
let folded = [];             // このターンに折り込んだ途中送信の本文
let lastText = '';

const msg = (type, body) => ({ type, ...body, session_id: sessionId, parent_tool_use_id: null, uuid: uuid() });
const streamEvent = event => out({ type: 'stream_event', event, session_id: sessionId, parent_tool_use_id: null, uuid: uuid() });
const bgChanged = () => out({ type: 'system', subtype: 'background_tasks_changed', tasks: [...background.values()], session_id: sessionId, uuid: uuid() });

function fold() {
  // 区切り: 溜まった途中送信を折り込む（echo は流し込んだ uuid のまま）
  while (queue.length) {
    const item = queue.shift();
    folded.push(item.text);
    out({ type: 'user', message: { role: 'user', content: item.text }, session_id: sessionId, parent_tool_use_id: null, uuid: item.uuid, isReplay: true });
    record({ type: 'user', uuid: item.uuid, message: { role: 'user', content: item.text } });
  }
}

async function say(text, stop = 'end_turn') {
  streamEvent({ type: 'message_start', message: { id: `msg_${uuid().slice(0, 8)}`, role: 'assistant', model: MODEL } });
  streamEvent({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
  const half = Math.ceil(text.length / 2);
  for (const piece of [text.slice(0, half), text.slice(half)]) if (piece) streamEvent({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: piece } });
  const m = msg('assistant', { message: { id: `msg_${uuid().slice(0, 8)}`, type: 'message', role: 'assistant', model: MODEL, content: [{ type: 'text', text }], stop_reason: stop, usage: { input_tokens: 100, output_tokens: 20 } } });
  out(m);
  record({ type: 'assistant', uuid: m.uuid, message: m.message });
  streamEvent({ type: 'message_delta', delta: { stop_reason: stop } });
  lastText = text;
}

async function runTool(step) {
  const id = `toolu_${uuid().slice(0, 12)}`;
  let listError = '';
  const remote = step.http ? (await httpMcp(step.http.server, 'tools/list', {}).catch(error => { listError = error.message; return { tools: [] }; })).tools.find(x => String(x.description ?? '').startsWith(step.http.tool)) : null;
  const name = step.mcp ? `mcp__${step.mcp.server}__${step.mcp.tool}` : step.http ? `mcp__${step.http.server}__${remote?.name ?? 'missing'}` : step.tool;
  const input = step.mcp ? step.mcp.arguments ?? {} : step.http ? step.http.arguments ?? {} : step.input ?? {};
  streamEvent({ type: 'message_start', message: { id: `msg_${uuid().slice(0, 8)}`, role: 'assistant', model: MODEL } });
  const m = msg('assistant', { message: { id: `msg_${uuid().slice(0, 8)}`, type: 'message', role: 'assistant', model: MODEL, content: [{ type: 'tool_use', id, name, input }], stop_reason: 'tool_use', usage: { input_tokens: 100, output_tokens: 20 } } });
  out(m);
  record({ type: 'assistant', uuid: m.uuid, message: m.message });
  streamEvent({ type: 'message_delta', delta: { stop_reason: 'tool_use' } });
  let content = step.result ?? 'ok', isError = false;
  if (step.ask) {
    out({ type: 'system', subtype: 'session_state_changed', state: 'requires_action', session_id: sessionId, uuid: uuid() });
    const answer = await ask({ subtype: 'can_use_tool', tool_name: name, input, tool_use_id: id, permission_suggestions: [] }).catch(() => ({ behavior: 'deny', message: 'cancelled' }));
    out({ type: 'system', subtype: 'session_state_changed', state: 'running', session_id: sessionId, uuid: uuid() });
    if (answer?.behavior !== 'allow') { content = answer?.message || 'denied'; isError = true; }
  }
  if (!isError && step.mcp) {
    const response = await ask({ subtype: 'mcp_message', server_name: step.mcp.server, message: { jsonrpc: '2.0', id: Math.floor(Math.random() * 1e6), method: 'tools/call', params: { name: step.mcp.tool, arguments: input } } })
      .catch(error => ({ mcp_response: { error: { message: error.message } } }));
    const result = response?.mcp_response?.result;
    content = result?.content?.map(c => c.text).join('\n') ?? `mcp error: ${JSON.stringify(response?.mcp_response?.error ?? null)}`;
    isError = !result || Boolean(result.isError);
  }
  if (!isError && step.http) {
    const result = remote ? await httpMcp(step.http.server, 'tools/call', { name: remote.name, arguments: input }).catch(error => ({ isError: true, content: [{ type: 'text', text: error.message }] })) : null;
    content = result?.content?.map(c => c.text).join('\n') ?? `no such tool${listError ? ` (${listError})` : ''}`;
    isError = !result || Boolean(result.isError);
  }
  if (!isError) {
    if (step.ms) await sleep(step.ms);
    if (step.gate) await waitGate(step.gate);
  }
  fold();
  const r = msg('user', { message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }] }, tool_use_result: content });
  out(r);
  record({ type: 'user', uuid: r.uuid, message: r.message });
}

function result() {
  spent.costUSD += 0.001; spent.inputTokens += 100; spent.outputTokens += 20;
  const total = cumulative();
  out({ type: 'result', subtype: interrupted ? 'error_during_execution' : 'success', is_error: interrupted, duration_ms: 10, num_turns: 1, result: lastText, session_id: sessionId,
    total_cost_usd: total.totalCostUSD, modelUsage: total.modelUsage, usage: { input_tokens: 100, output_tokens: 20 }, uuid: uuid() });
  // SDK は session_state_changed を一度見たら、idle を見るまで入力の終わり（stdin を閉じる）を待つ
  out({ type: 'system', subtype: 'session_state_changed', state: 'idle', session_id: sessionId, uuid: uuid() });
}

/** 内部ターン 1 つ（発言 1 つと、その間に折り込んだ途中送信） */
async function turn(item) {
  busy = true; interrupted = false; folded = [];
  out({ type: 'system', subtype: 'init', session_id: sessionId, model: MODEL, cwd, tools: [], mcp_servers: [], claude_code_version: VERSION, uuid: uuid() });
  out({ type: 'user', message: { role: 'user', content: item.text }, session_id: sessionId, parent_tool_use_id: null, uuid: item.uuid, isReplay: true });
  record({ type: 'user', uuid: item.uuid, message: { role: 'user', content: item.text } });
  let steps;
  try { steps = item.text.startsWith('script:') ? JSON.parse(item.text.slice(7)).steps : [{ text: `echo: ${item.text}` }]; }
  catch { steps = [{ text: `bad script` }]; }
  for (const step of steps) {
    if (interrupted) break;
    if (step.bg) {
      const id = `bg_${uuid().slice(0, 8)}`;
      const task = { task_id: id, task_type: 'local_bash', description: step.bg.description ?? 'fake background' };
      background.set(id, task);
      out({ type: 'system', subtype: 'task_started', task_id: id, task_type: 'local_bash', description: task.description, is_backgrounded: true, session_id: sessionId, uuid: uuid() });
      bgChanged();
      void waitGate(step.bg.gate).then(() => {
        if (!background.has(id)) return;
        background.delete(id);
        out({ type: 'system', subtype: 'task_notification', task_id: id, status: 'completed', summary: 'done', session_id: sessionId, uuid: uuid() });
        bgChanged();
        enqueue({ text: '<task-notification>', uuid: uuid(), notice: true });
      });
    } else if (step.compact) {
      out({ type: 'system', subtype: 'status', status: 'compacting', session_id: sessionId, uuid: uuid() });
      await fireHook('PreCompact', { trigger: 'manual' }, { gate: step.gate ?? null });
      out({ type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'manual', pre_tokens: 5000, post_tokens: 500 }, session_id: sessionId, uuid: uuid() });
      await fireHook('PostCompact', { trigger: 'manual', compact_summary: 'fake summary' });
    } else if (step.text != null) {
      await say(folded.length ? `${step.text}（受け取った: ${folded.join(' / ')}）` : step.text);
    } else if (step.tool || step.mcp || step.http) {
      await runTool(step);
    }
  }
  if (!interrupted && !steps.some(s => s.text != null)) await say(lastText || 'done');
  result();
  busy = false;
  pump();
}

function enqueue(item) {
  queue.push(item);
  pump();
}
async function pump() {
  if (busy) return;
  const item = queue.shift();
  if (item) {
    if (item.notice) { busy = true; out({ type: 'system', subtype: 'init', session_id: sessionId, model: MODEL, cwd, tools: [], uuid: uuid() }); await say('裏の作業が終わった'); result(); busy = false; return pump(); }
    return turn(item);
  }
  if (ended && !background.size) finish();
}

let finishing = false;
async function finish() {
  if (finishing) return;
  finishing = true;
  const total = cumulative();
  if (transcript) fs.mkdirSync(path.dirname(transcript), { recursive: true });
  if (transcript) fs.appendFileSync(transcript, `${JSON.stringify({ type: 'cost-state', totalCostUSD: total.totalCostUSD, modelUsage: total.modelUsage, version: VERSION, sessionId })}\n`);
  await lastWrite;
  process.exit(0);
}

function onControlRequest(m) {
  const req = m.request ?? {};
  const reply = response => out({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response } });
  switch (req.subtype) {
    case 'initialize': {
      initializes++;
      hooks = Object.fromEntries(Object.entries(req.hooks ?? {}).map(([event, list]) => [event, list.flatMap(x => x.hookCallbackIds ?? [])]));
      const pending = [];
      if (initializes > 1) {
        // 付け直し: 答えを待っている承認は送り直し、走っている hooks のコールバックは取り消す（答えは使わない）
        for (const [id, w] of waiting) {
          if (w.request.subtype === 'can_use_tool') pending.push({ type: 'control_request', request_id: id, request: w.request });
          else if (w.request.subtype === 'hook_callback') {
            waiting.delete(id);
            out({ type: 'control_cancel_request', request_id: id });
            w.reject(new Error('The SDK host reconnected before its hook answered'));
          }
        }
      }
      log(`initialize #${initializes} pending=${pending.length}`);
      reply({ commands: [], agents: [], models: [{ value: 'default', displayName: 'Default', description: 'fake' }], account: {}, output_style: 'default', available_output_styles: ['default'],
        hooks_applied: true, ...(pending.length ? { pending_permission_requests: pending } : {}) });
      if (initializes > 1) bgChanged();
      return;
    }
    case 'interrupt': {
      interrupted = true;
      const cancelled = queue.filter(x => !x.notice).map(x => x.uuid);
      queue.length = 0;
      for (const [id, w] of waiting) { waiting.delete(id); w.reject(new Error('interrupted')); }
      reply({ cancelled });
      return;
    }
    case 'get_context_usage': reply({ totalTokens: 1000, rawMaxTokens: 200_000, memoryFiles: [] }); return;
    case 'mcp_status': reply({ mcpServers: [] }); return;
    case 'get_settings': reply({ applied: {} }); return;
    default: reply({}); return;
  }
}

function onLine(line) {
  let m;
  try { m = JSON.parse(line); } catch { return; }
  if (process.env.FAKE_CLAUDE_TRACE) log(`< ${m.type} ${m.request?.subtype ?? m.response?.subtype ?? ''}`);
  if (m.type === 'control_request') return onControlRequest(m);
  if (m.type === 'control_response') {
    const r = m.response ?? {};
    const w = waiting.get(r.request_id);
    if (!w) return;   // 取り消した依頼・二重の答え
    waiting.delete(r.request_id);
    if (r.subtype === 'success') w.resolve(r.response ?? {}); else w.reject(new Error(r.error ?? 'error'));
    return;
  }
  if (m.type === 'user') {
    const content = m.message?.content;
    const text = typeof content === 'string' ? content : Array.isArray(content) ? content.map(c => c.text ?? '').join('') : '';
    if (m.shouldQuery === false) return;
    enqueue({ text, uuid: m.uuid ?? uuid() });
  }
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (line.trim()) onLine(line);
  }
});
process.stdin.on('end', () => { ended = true; log('stdin end'); pump(); });
log(`start ${sessionId} resume=${Boolean(resumeArg)} ppid=${process.ppid}`);
process.on('uncaughtException', error => { log(`uncaught: ${error?.stack ?? error}`); process.exit(1); });
process.on('unhandledRejection', error => { log(`unhandled: ${error?.stack ?? error}`); process.exit(1); });
