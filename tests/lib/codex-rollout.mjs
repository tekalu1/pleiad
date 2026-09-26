// Codex の rollout（~/.codex/sessions/…/rollout-*.jsonl）の行を作る。fake-codex.mjs と単体テストが使う。
//
// 形は codex-cli 0.156.1 の実際の rollout から取った（response_item の custom_tool_call(_output)・function_call(_output)、
// internal_chat_message_metadata_passthrough.turn_id、event_msg の task_started / task_complete）。
// 値（パス・コマンド・id）はすべて作ったもの。実際のパス・ユーザー名・秘密は入れない。
const TICK = String.fromCharCode(96);

/** Rust の Debug 形式の文字列（"…"）にする */
export const rustDebug = s => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t')}"`;

/** Codex が拒否の文でコマンドを描く形（POSIX の語をつなげる。空白などを含む語は "…" で囲む） */
export const renderArgv = argv => argv.map(a => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(a) ? a : `"${a.replace(/(["\\$`])/g, '\\$1')}"`)).join(' ');

/** ポリシーの拒否の文（exec_command failed: CreateProcess { message: "Rejected(\"`…` rejected: …\")" }） */
export function policyRejection(script, { shell = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', reason = 'blocked by policy' } = {}) {
  const inner = `${TICK}${renderArgv([shell, '-Command', script])}${TICK} rejected: ${reason}`;
  return `exec_command failed: CreateProcess { message: ${rustDebug(`Rejected(${rustDebug(inner)})`)} }`;
}

/** プロセス作成の失敗（同じ CreateProcess { … Rejected(…) } に包まれて来る） */
export function spawnRejection(reason = 'The directory name is invalid. (os error 267)') {
  return `exec_command failed: CreateProcess { message: ${rustDebug(`Rejected(${rustDebug(`Failed to create unified exec process: ${reason}`)})`)} }`;
}

const meta = turnId => ({ internal_chat_message_metadata_passthrough: { turn_id: turnId } });
const at = () => new Date().toISOString();
const item = payload => ({ timestamp: at(), type: 'response_item', payload });
const event = payload => ({ timestamp: at(), type: 'event_msg', payload });

export const lines = {
  taskStarted: turnId => event({ type: 'task_started', turn_id: turnId }),
  taskComplete: turnId => event({ type: 'task_complete', turn_id: turnId, last_agent_message: null }),
  userMessage: (turnId, text) => item({ type: 'message', role: 'user', content: [{ type: 'input_text', text }], ...meta(turnId) }),
  assistant: (turnId, text) => item({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }], ...meta(turnId) }),
  // code mode: モデルが custom tool の exec に JS を書き、中で tools.exec_command を呼ぶ
  codeCall: (turnId, callId, script) => item({ type: 'custom_tool_call', call_id: callId, name: 'exec',
    input: `const r = await tools.exec_command(${JSON.stringify({ cmd: script })}); text(r);\n`, ...meta(turnId) }),
  codeOutput: (turnId, callId, error) => item({ type: 'custom_tool_call_output', call_id: callId, output: [
    { type: 'input_text', text: 'Script failed\nWall time 0.1 seconds\nOutput:\n' },
    { type: 'input_text', text: `Script error:\n${error}` },
  ], ...meta(turnId) }),
  // code mode のセルが後から失敗したとき（wait の出力に出る）
  waitCall: (turnId, callId) => item({ type: 'function_call', call_id: callId, name: 'wait',
    arguments: JSON.stringify({ cell_id: '1', yield_time_ms: 1000, max_tokens: 2000 }), ...meta(turnId) }),
  waitOutput: (turnId, callId, error) => item({ type: 'function_call_output', call_id: callId, output: [
    { type: 'input_text', text: 'Script failed\nWall time 1.0 seconds\nOutput:\n' },
    { type: 'input_text', text: `Script error:\n${error}` },
  ], ...meta(turnId) }),
  // exec_command を直接（code mode でないモデル）
  directCall: (turnId, callId, cmd) => item({ type: 'function_call', call_id: callId, name: 'exec_command',
    arguments: JSON.stringify({ cmd, workdir: 'C:\\work\\project' }), ...meta(turnId) }),
  directOutput: (turnId, callId, text) => item({ type: 'function_call_output', call_id: callId, output: text, ...meta(turnId) }),
  // 成功した exec（出力の途中に拒否の文を引用しただけ。拾ってはいけない）
  quotedOutput: (turnId, callId, quoted) => item({ type: 'custom_tool_call_output', call_id: callId, output: [
    { type: 'input_text', text: 'Script completed\nWall time 0.2 seconds\nOutput:\n' },
    { type: 'input_text', text: `issue #24 の本文:\n> 子の報告: ${TICK}${quoted}${TICK} が出た` },
  ], ...meta(turnId) }),
};

/** 1 行 1 JSON の文字列 */
export const jsonl = rows => rows.map(r => JSON.stringify(r) + '\n').join('');
