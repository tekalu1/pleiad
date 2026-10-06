// 保持役（core/holder/）の試験用の偽の子。node tests/lib/holder-fake-child.mjs <モード> [引数]。標準出力は 1 行 1 JSON。
//   lines N [間隔ms]   {"n":1} … {"n":N} を出して、その後は echo のように生きる（stdin が閉じたら {"stdin":"closed"} を出して終わる）
//   echo               stdin の行を {"echo":"<行>"} で返す。stdin が閉じたら {"stdin":"closed"} を出して終わる
//   request            control_request（mcp_message・can_use_tool・hook_callback）を出す。control_response が来たら {"answered":"<request_id>"} を返す。他は echo
//   jsonrpc            id と method を持つ依頼（c1）と、id の無い通知を出す。id を持つ応答が来たら {"answered":<id>} を返す。他は echo
//   cancel             control_request（req-cancel）を出し、続けて control_cancel_request で取り消す
//   flood KB           1 KB の行を KB 本、stdout へ出し切って {"done":true} で終わる（stdout が詰まれば終わらない）
//   big BYTES          BYTES の長さの 1 行を出して、echo のように生きる
//   tail               改行の無い最後の行 {"tail":1} を出して終わる
//   grandchild         孫（node。寿命は長い）を起こして {"grandchild":<pid>} を出し、生きる
//   stderr TEXT        stderr に TEXT を出して echo のように生きる
//   exit CODE          すぐ終わる
// 起動したら最初に {"ready":true,"pid":<pid>} を出す（lines・flood・big・tail・exit を除く）。
import { spawn } from 'node:child_process';

const [mode = 'echo', arg1, arg2] = process.argv.slice(2);
const emit = value => process.stdout.write(`${typeof value === 'string' ? value : JSON.stringify(value)}\n`);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function listen(onLine) {
  let buffer = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (line) onLine(line);
    }
  });
  process.stdin.on('end', () => {
    emit({ stdin: 'closed' });
    setTimeout(() => process.exit(0), 20);
  });
}

function echo(extra) {
  listen(line => {
    let m = null;
    try { m = JSON.parse(line); } catch { /* 行ではない */ }
    if (extra?.(line, m)) return;
    emit({ echo: line });
  });
}

const request = (request_id, subtype) => ({ type: 'control_request', request_id, request: { subtype } });

switch (mode) {
  case 'lines': {
    const count = Number(arg1 ?? 10);
    const gap = Number(arg2 ?? 0);
    for (let i = 1; i <= count; i++) { emit({ n: i }); if (gap) await sleep(gap); }
    echo();
    break;
  }
  case 'echo': emit({ ready: true, pid: process.pid }); echo(); break;
  case 'request':
    emit({ ready: true, pid: process.pid });
    emit(request('req-mcp', 'mcp_message'));
    emit(request('req-tool', 'can_use_tool'));
    emit(request('req-hook', 'hook_callback'));
    echo((line, m) => { if (m?.type === 'control_response') { emit({ answered: m.response?.request_id }); return true; } return false; });
    break;
  case 'jsonrpc':
    emit({ ready: true, pid: process.pid });
    emit({ jsonrpc: '2.0', id: 'c1', method: 'item/commandExecution/requestApproval', params: { id: 'inner' } });
    emit({ jsonrpc: '2.0', method: 'item/agentMessage/delta', params: { id: 'x', delta: 'a' } });
    echo((line, m) => { if (m && m.id !== undefined && m.method === undefined) { emit({ answered: m.id }); return true; } return false; });
    break;
  case 'cancel':
    emit({ ready: true, pid: process.pid });
    emit(request('req-cancel', 'mcp_message'));
    emit({ type: 'control_cancel_request', request_id: 'req-cancel' });
    echo();
    break;
  case 'flood': {
    const count = Number(arg1 ?? 1024);
    const row = JSON.stringify({ pad: 'x'.repeat(1000) });
    for (let i = 0; i < count; i++) {
      if (!process.stdout.write(`${row}\n`)) await new Promise(resolve => process.stdout.once('drain', resolve));
    }
    emit({ done: true });
    break;
  }
  case 'big': emit({ ready: true, pid: process.pid }); process.stdout.write(`${JSON.stringify({ big: 'y'.repeat(Number(arg1)) })}\n`); echo(); break;
  case 'tail': process.stdout.write('{"tail":1}'); break;
  case 'grandchild': {
    const grand = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
    emit({ ready: true, pid: process.pid });
    emit({ grandchild: grand.pid });
    echo();
    break;
  }
  case 'stderr': emit({ ready: true, pid: process.pid }); process.stderr.write(String(arg1 ?? 'oops')); echo(); break;
  case 'exit': process.exit(Number(arg1 ?? 0)); break;
  default: echo();
}
