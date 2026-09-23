// `codex app-server` の台本役。テストが渡した frame を**そのまま** stdout に流す。
//
// fake-codex.mjs は「1 ターンの台本」を自分で組み立てるが、こちらは codex-rpc の振り分け
// （どの frame をどのセッションへ渡すか）を測るためのもので、順序も中身もテストが決める。
// frame はテスト側でスキーマの形に揃える。ここは中身を見ない。
//
//   test/push      { frames } frames を 1 行ずつ書いてから応答する（応答が来た時点で全部届いている）
//   test/ask       { frame }  server -> client の request を出し、client の応答を { reply } で返す
//   test/state                { startPending, turns, terminalCalls, terminated }（保留中の thread/start の数、払い出した turn id、端末一覧を引かれた回数、止めろと言われた端末）
//   test/release   { result }  保留していた thread/start に result で応答する
//   test/terminals { pages }  thread/backgroundTerminals/list の応答を順に積む（尽きたら thread not found）
//   test/oldCodex  { on }     backgroundTerminals を持たない古い版（0.147.0）のふりをする
//
// thread/start は test/release まで応答しない（応答待ちの隙間に frame を差し込むため）。
// turn/start は turn id を即答する。ほかの method は {} を返す。
import process from "node:process";

const NL = String.fromCharCode(10);
const send = (frame) => process.stdout.write(JSON.stringify(frame) + NL);
const reply = (id, result) => send({ jsonrpc: "2.0", id, result: result ?? {} });
/**
 * 「そんな method は無い」の実機の形（codex 0.154.0-alpha.6.2 で確認）。
 * JSON-RPC の -32601 ではなく **-32600 + `unknown variant`**。Pleiad はこの文面で見分ける。
 */
const TICK = String.fromCharCode(96);
const unknownVariant = (id, method) => send({ jsonrpc: "2.0", id, error: { code: -32600,
  message: `Invalid request: unknown variant ${TICK}${method}${TICK}, expected one of ${TICK}initialize${TICK}` } });

const pendingStarts = [];      // thread/start の request id
const turns = [];              // turn/start で払い出した turn id
const asks = new Map();        // 出した request の id -> test/ask の request id
const terminalPages = [];      // thread/backgroundTerminals/list が順に返す応答
let terminalCalls = 0;         // 端末一覧を引かれた回数
const terminated = [];         // thread/backgroundTerminals/terminate で止めろと言われたもの
let oldCodex = false;          // true なら backgroundTerminals を持たない古い版のふりをする

function handle(msg) {
  const p = msg.params ?? {};
  switch (msg.method) {
    case "initialize": return reply(msg.id, { userAgent: "scripted-codex/0.0.0" });
    case "test/push":
      for (const f of p.frames ?? []) send({ jsonrpc: "2.0", ...f });
      return reply(msg.id, {});
    case "test/ask":
      asks.set(p.frame.id, msg.id);
      return send({ jsonrpc: "2.0", ...p.frame });
    case "test/state": return reply(msg.id, { startPending: pendingStarts.length, turns, terminalCalls, terminated });
    // 古い codex（0.147.0）の返し方。method が無いときは -32601 ではなく -32600 + unknown variant
    case "test/oldCodex":
      oldCodex = p.on !== false;
      return reply(msg.id, {});
    case "test/terminals":
      terminalPages.push(...(p.pages ?? []));
      return reply(msg.id, {});
    // 実機の形（codex 0.154.0-alpha.6.2 で確認）: { data: [...], nextCursor: 数字の文字列 | null }。
    // 積んだページが尽きたら、ロードされていないスレッドを引いたときと同じエラーを返す
    // （実機もこの形。テストが積んだときだけ照合が動くので、他の判定が照合に揺さぶられない）
    case "thread/backgroundTerminals/list": {
      terminalCalls += 1;
      if (oldCodex) return unknownVariant(msg.id, msg.method);
      const page = terminalPages.shift();
      if (page) return reply(msg.id, page);
      return send({ jsonrpc: "2.0", id: msg.id,
        error: { code: -32600, message: `thread not found: ${p.threadId}` } });
    }
    // 実機は { terminated: boolean } を返す。止めた相手をテストが見られるよう覚えておく
    case "thread/backgroundTerminals/terminate":
      if (oldCodex) return unknownVariant(msg.id, msg.method);
      terminated.push({ threadId: p.threadId, processId: p.processId });
      return reply(msg.id, { terminated: true });
    case "test/release": {
      const id = pendingStarts.shift();
      if (id !== undefined) reply(id, p.result);
      return reply(msg.id, { released: id !== undefined });
    }
    case "thread/start": return void pendingStarts.push(msg.id);
    case "turn/start": {
      const id = `tn_scripted_${turns.length + 1}`;
      turns.push(id);
      return reply(msg.id, { turn: { id, items: [], status: "inProgress" } });
    }
    default: return reply(msg.id, {});
  }
}

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf(NL)) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    // client の応答（こちらが出した承認・質問への答え）。test/ask の応答として返す
    if (msg.id !== undefined && msg.method === undefined) {
      const testId = asks.get(msg.id);
      if (testId === undefined) continue;
      asks.delete(msg.id);
      reply(testId, { reply: msg });
      continue;
    }
    if (msg.id === undefined) continue;   // initialized などの notification
    handle(msg);
  }
});

// 親が消えたら道連れになる（fake-codex.mjs と同じ理由）
process.stdin.on("end", () => process.exit(0));
process.stdin.on("close", () => process.exit(0));
