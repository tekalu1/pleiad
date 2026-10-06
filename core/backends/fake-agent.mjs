// fake の台本 "held:<台本>" の偽の CLI（無停止の更新 段階 2 の 2b-5。取り決めは core/backends/fake-held.mjs の頭）。保持役の子として走る別プロセス。
// 最初の stdin の行 start で fake の runTurn（core/backends/fake.mjs）をそのまま走らせ、出来事を 1 行 1 JSON で標準出力へ出す。
// 承認（askPermission）は cli.ask を出して stdin の permission.answer を待ち、途中送信（control.steer）は stdin の steer を渡し、interrupt で中断する。
// ターンが終わったら終了コード 0（失敗は 1）で終わる。起こしたサーバーが落ちても、保持役が居る限り走り続ける
import { backend } from './fake.mjs';

let lastWrite = Promise.resolve();
const out = value => { lastWrite = new Promise(resolve => process.stdout.write(`${JSON.stringify(value)}\n`, resolve)); };
// fake の合図（announce の console.log）は、記録の行にして旧サーバー・新サーバーの標準出力へ出し直してもらう
console.log = (...args) => out({ type: 'cli.log', text: args.join(' ') });

const abort = new AbortController();
const control = {};
const asks = new Map();    // requestId -> 答えを待っている resolve
let started = false;

const askPermission = request => new Promise(resolve => {
  const { signal: _signal, ...plain } = request;
  asks.set(request.toolUseID, resolve);
  out({ type: 'cli.ask', requestId: request.toolUseID, request: plain });
});

async function run(start) {
  out({ type: 'cli.start', text: start.userText ?? start.prompt });
  let code = 0;
  try {
    await backend.runTurn({
      prompt: start.prompt, sessionId: start.sessionId, cwd: start.cwd, mode: start.mode, model: start.model, notes: start.notes ?? [],
      // session は呼び出し側が出す（起こす前に会話の id が決まっている）。渡った合図も呼び出し側が出す
      emit: event => { if (event?.type !== 'session') out(event); }, onPromptDelivered: () => {}, askPermission, signal: abort, control,
    });
  } catch { code = 1; }
  await lastWrite;
  process.exit(code);
}

async function onLine(line) {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  switch (message?.type) {
    case 'start': if (!started) { started = true; run(message); } break;
    case 'permission.answer': {
      const resolve = asks.get(message.requestId);
      if (!resolve) break;
      asks.delete(message.requestId);
      out({ type: 'cli.settled', requestId: message.requestId });
      resolve(message.answer);
      break;
    }
    case 'steer': {
      let accepted = false;
      try { accepted = Boolean(await control.steer?.(message.item)); } catch { /* 受理できなかった */ }
      out({ type: 'cli.steer-result', id: message.item?.id, accepted });
      break;
    }
    case 'interrupt':
      abort.abort();
      for (const [requestId, resolve] of asks) { asks.delete(requestId); out({ type: 'cli.settled', requestId }); resolve({ allow: false, message: 'interrupted' }); }
      break;
    default: break;
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
    if (line) void onLine(line);
  }
});
process.stdin.on('end', () => { if (!started) process.exit(0); });
