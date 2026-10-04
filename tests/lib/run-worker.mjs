// tests/run.mjs --jobs N の子プロセス。親から 1 本ずつ suite を頼まれ、走らせて結果を返す（同時に 2 本は走らせない）。
//
// 最初の import は test-env（tests/run.mjs と同じ理由）。親の AGENT_HOST_DATA は渡されない（渡っていたら動かさない）ので、
// ここで worker ごとの一時ディレクトリができる。終わりにその置き場を消す。
process.env.AGENT_HOST_LOCALE ||= "ja";
import { cleanupTestData, testDataDir, testDataOwned } from "./test-env.mjs";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { installDomStub } from "./dom-stub.mjs";
import { killOwnTree } from "./process-reap.mjs";
import { createGuardedRunner, serializeSuite } from "./runner.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const parentData = process.argv[2] || "";

const send = (msg) => { if (process.connected) process.send(msg); };

if (!process.send) {
  console.error("tests/lib/run-worker.mjs は tests/run.mjs が起動するもの（IPC が無い）");
  process.exit(2);
}
// 親の置き場を使っていたら、worker 同士・親と DB を取り合う。動かさない
if (!testDataOwned || (parentData && path.resolve(parentData).toLowerCase() === path.resolve(testDataDir).toLowerCase())) {
  send({ type: "fatal", message: `worker のデータ置き場が一時の専用でない: ${testDataDir}` });
  process.exit(3);
}
// 親が死んだ（外から止められた）ら、自分と、自分が起こした子孫（suite のサーバーなど）を残さない。親はもう居ないので、worker 自身が止める
process.on("disconnect", () => killOwnTree());

installDomStub();
const guard = createGuardedRunner({ root: ROOT, parallel: true });
await guard.prime();

/** suite の出力（console.log・process.stdout/stderr.write）を、その suite の結果と一緒に親へ渡す */
async function captured(fn) {
  const out = process.stdout.write;
  const err = process.stderr.write;
  const grab = (chunk, encoding, cb) => {
    send({ type: "out", text: Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk) });
    if (typeof encoding === "function") encoding();
    else if (typeof cb === "function") cb();
    return true;
  };
  process.stdout.write = grab;
  process.stderr.write = grab;
  try { return await fn(); } finally { process.stdout.write = out; process.stderr.write = err; }
}

let busy = false;
process.on("message", async (msg) => {
  if (msg?.type === "exit") {
    await cleanupTestData();
    process.exit(0);
  }
  if (msg?.type !== "run") return;
  if (busy) { send({ type: "fatal", message: "suite の実行中に次の suite を頼まれた" }); process.exit(5); }
  busy = true;
  const suite = await captured(async () => {
    try {
      const mod = await import(pathToFileURL(msg.file).href);
      if (typeof mod.default !== "function") throw new Error(`${msg.file}: default export が関数でない`);
      return await guard.run(mod, msg.name);
    } catch (error) {
      // 読み込みの失敗。この suite だけの失敗にして、worker は続ける
      console.log(`\n── ${msg.name}`);
      console.log(`  NG  読み込みで例外 — ${error?.stack ?? error}`);
      return { name: msg.name, title: msg.name, results: [], error: String(error?.stack ?? error), skipped: null, ms: 0 };
    }
  });
  send({ type: "result", requested: msg.name, suite: serializeSuite(suite) });
  busy = false;
});

// 自分の生まれた時刻（ms）。親が、pid の使い回しと見分けるのに使う
send({ type: "ready", dataDir: testDataDir, pid: process.pid, bornAt: Date.now() - process.uptime() * 1000 });
