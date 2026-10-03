import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { startServer, ROOT } from "../lib/server.mjs";
import { open } from "../lib/ws-client.mjs";

export const name = "server-rewind";
export const title = "同じ会話で巻き戻して送り直す（sendMessage の rewind。ADR 0091）";

// 巻き戻しの契約（保留の印・提示・ホスト管理への落とし先）は、自分のデータ置き場を持つ子プロセスで（tests/lib/rewind-storage-worker.mjs）
async function worker(t) {
  const out = await promisify(execFile)(process.execPath, [path.join(ROOT, "tests/lib/rewind-storage-worker.mjs")], { timeout: 60_000 });
  t.ok("巻き戻しの契約（Claude・Codex・ホスト管理の形、拒否の落とし先、提示の切り取り）", out.stdout.includes("rewind contracts passed"), out.stdout.slice(-300));
}

const said = events => events.filter(e => e.type === "text.delta").map(e => e.text).join("");

export default async function(t) {
  await worker(t);
  // 形ごとに別のサーバー（FAKE_REWIND）: resumeAt（Claude）・reject（拒否されてホスト管理へ）・thread（Codex）・off（Antigravity）
  for (const form of ["resumeAt", "reject", "thread", "off"]) {
    const scratch = await fs.mkdtemp(path.join(os.tmpdir(), `agent-host-rewind-${form}-`));
    const server = await startServer({ dataDir: scratch, env: { AGENT_HOST_BACKENDS: "fake", FAKE_REWIND: form } });
    const c = await open({ port: server.port, token: server.token, autoAllow: true });
    const label = text => `[${form}] ${text}`;
    try {
      const first = await c.runTurn({ backend: "fake", cwd: ROOT, prompt: "echo:one" });
      const id = first.sessionId;
      await c.runTurn({ sessionId: id, prompt: "echo:two" });
      await c.runTurn({ sessionId: id, prompt: "echo:three" });
      const before = await c.cmd("loadSession", { sessionId: id });
      const users = before.messages.filter(m => m.role === "user");
      t.ok(label("前提: 3 往復"), before.messages.length === 6 && users.length === 3);
      const sessionsBefore = (await c.cmd("listSessions")).length;

      // 同じ messageId の再送は巻き戻し直さない（応答が届かず送り直した場合）ので、messageId は 1 回ごとに変える
      const send = async (prompt, beforeMessageId, extra = {}, messageId = crypto.randomUUID()) => {
        const from = c.mark();
        const result = await c.cmd("sendMessage", { sessionId: id, messageId, prompt, rewind: { beforeMessageId, ...extra } });
        // 止めた前のターンの turnEnd を拾わないよう、この発言のターンが始まってから後の turnEnd を待つ
        await c.waitFor(e => e.type === "userMessage" && e.messageId === messageId, { from });
        const started = c.events.findIndex((e, i) => i >= from && e.type === "userMessage" && e.messageId === messageId);
        const ended = await c.waitFor(e => e.type === "turnEnd" && e.sessionId === id, { from: started });
        return { result, ended, from, messageId };
      };
      const run = await send("echo:TWO-again", users[1].uuid);
      const after = await c.cmd("loadSession", { sessionId: id });
      t.ok(label("同じ会話のまま、切り口より後が消えて新しい発言と返答が続く"),
        after.messages.length === 4 && after.messages[0].uuid === before.messages[0].uuid && after.messages[1].uuid === before.messages[1].uuid
        && after.messages[2].text === "echo:TWO-again" && after.messages[3].role === "assistant"
        && !after.messages.some(m => /two|three/.test(m.text ?? "") && m.text !== "echo:TWO-again"), after.messages.map(m => m.text).join(" | "));
      t.ok(label("応答に巻き戻しの方式と消えた件数を返す"),
        run.result.rewind?.removed.messages === 4 && run.result.rewind.removed.userMessages === 1
        && run.result.rewind.mode === ({ resumeAt: "resume", reject: "resume", thread: "thread", off: "host" })[form], JSON.stringify(run.result.rewind));
      t.ok(label("rewind イベントで他の画面にも知らせる"), c.since(run.from).some(e => e.type === "rewind" && e.sessionId === id));
      t.ok(label("会話は増えない（子の会話を作らない）"), (await c.cmd("listSessions")).length === sessionsBefore);
      t.ok(label("送り直した発言は 1 件だけ送信済みになる"),
        (await c.cmd("listMessages", { sessionId: id })).filter(m => m.status === "sent").length >= 1
        && (await c.cmd("listMessages", { sessionId: id })).every(m => ["sent", "cancelled"].includes(m.status)));
      t.ok(label("次の発言も同じ会話で続けられる（古い印で今の会話を切らない）"), await (async () => {
        await c.runTurn({ sessionId: id, prompt: "echo:next" });
        return (await c.cmd("loadSession", { sessionId: id })).messages.length === 6;
      })());

      // 同じ messageId の再送（応答が届かず送り直した）は巻き戻し直さない: 起点の発言はもう無いので、巻き戻し直せば断られる
      const again = crypto.randomUUID();
      const afterNext = (await c.cmd("loadSession", { sessionId: id })).messages;
      await send("echo:dup", afterNext[2].uuid, {}, again);
      const afterDup = (await c.cmd("loadSession", { sessionId: id })).messages;
      const replay = await c.cmd("sendMessage", { sessionId: id, messageId: again, prompt: "echo:dup", rewind: { beforeMessageId: afterNext[2].uuid } }).then(() => "ok", e => e.message);
      t.ok(label("同じ messageId の再送は巻き戻し直さない"), replay === "ok" && (await c.cmd("loadSession", { sessionId: id })).messages.length === afterDup.length, String(replay));

      // 検査: 自分の発言以外・存在しない発言は断り、会話は変わらない
      const snapshot = JSON.stringify((await c.cmd("loadSession", { sessionId: id })).messages);
      const reject = (prompt, beforeMessageId) => c.cmd("sendMessage", { sessionId: id, messageId: crypto.randomUUID(), prompt, rewind: { beforeMessageId } }).then(() => null, e => e.message);
      t.ok(label("返答は巻き戻しの起点にできない"), /自分の発言/.test(await reject("x", (await c.cmd("loadSession", { sessionId: id })).messages[1].uuid)));
      t.ok(label("存在しない発言は断る"), /見つかりません/.test(await reject("x", "no-such-message")));
      t.ok(label("指定が空なら断る"), /指定が正しくありません/.test(await reject("x", "")));
      t.ok(label("断られた巻き戻しは会話を変えない"), JSON.stringify((await c.cmd("loadSession", { sessionId: id })).messages) === snapshot);

      // 実行中: stopRunning が無ければ断る。あれば止めてから巻き戻し、中断の印は残さない
      const base = (await c.cmd("loadSession", { sessionId: id })).messages;
      const target = base.filter(m => m.role === "user")[1];
      await c.cmd("runTurn", { sessionId: id, prompt: "slow" });
      await c.cmd("sendMessage", { sessionId: id, messageId: crypto.randomUUID(), prompt: "echo:queued behind" });
      const refused = await reject("echo:stop-me", target.uuid);
      t.ok(label("実行中に stopRunning なしで送り直すと断る"), /実行中/.test(refused ?? ""), String(refused));
      t.ok(label("断られても実行中のターンは止まらない"), (await c.cmd("running")).turns.some(turn => turn.sessionId === id));
      const stopped = await send("echo:after-stop", target.uuid, { stopRunning: true });
      t.ok(label("止めて巻き戻して送り直す"), stopped.ended.type === "turnEnd");
      const restarted = await c.cmd("loadSession", { sessionId: id });
      t.ok(label("止めたあとの履歴は巻き戻した先から続く"),
        restarted.messages.length === 4 && restarted.messages[2].text === "echo:after-stop" && restarted.messages[3].role === "assistant",
        restarted.messages.map(m => m.text).join(" | "));
      t.ok(label("中断の印は残らない"), !restarted.interrupted);
      t.ok(label("止めた時に溜まっていた送信待ちは取り消される"), (await c.cmd("listMessages", { sessionId: id })).every(m => ["sent", "cancelled"].includes(m.status)));
      t.ok(label("送信待ちだった発言は履歴に出ない"), !restarted.messages.some(m => /queued behind/.test(m.text ?? "")));

      if (form === "resumeAt") {
        // R2: 検証で断られる（AI の提示に時刻が無い）なら、「止めて送り直す」でも走っているターンを止めない・何も変えない
        const s2 = await c.runTurn({ backend: "fake", cwd: ROOT, prompt: "echo:first" });
        const sid = s2.sessionId;
        await c.runTurn({ sessionId: sid, prompt: "echo:second" });
        const before2 = (await c.cmd("loadSession", { sessionId: sid })).messages;
        await fs.mkdir(path.join(scratch, "presents"), { recursive: true });
        await fs.appendFile(path.join(scratch, "presents", `${sid}.jsonl`), JSON.stringify({ kind: "text", by: "ai", content: "時刻の無い提示" }) + "\n");
        await c.cmd("runTurn", { sessionId: sid, prompt: "slow" });
        const refusedAt = await c.cmd("sendMessage", { sessionId: sid, messageId: crypto.randomUUID(), prompt: "x",
          rewind: { beforeMessageId: before2.filter(m => m.role === "user")[1].uuid, stopRunning: true } }).then(() => null, e => e.message);
        t.ok(label("検証で断られる送り直しは「止めて送り直す」でも走っているターンを止めない"), /時刻/.test(refusedAt ?? "") && (await c.cmd("running")).turns.some(turn => turn.sessionId === sid), String(refusedAt));
        await c.cmd("abort", { sessionId: sid });
        await c.waitFor(e => e.type === "turnEnd" && e.sessionId === sid, { from: c.mark() - 1 }).catch(() => {});
        await c.cmd("abort", { sessionId: sid }).catch(() => {});

        // M6・M7: 切り口より後の「渡さなかった `!` の行」は捨て、文脈量の表示は捨てる
        const s3 = await c.runTurn({ backend: "fake", cwd: ROOT, prompt: "echo:alpha" });
        const kid = s3.sessionId;
        await c.runTurn({ sessionId: kid, prompt: "echo:beta" });
        await c.cmd("runShell", { sessionId: kid, runId: "shell-rewind-0001", command: "echo held-back", cwd: ROOT });
        await c.waitFor(e => e.type === "shell.done" && e.runId === "shell-rewind-0001", { from: 0, ms: 20_000 });
        await c.cmd("skipShell", { sessionId: kid, runId: "shell-rewind-0001", skip: true });
        await c.runTurn({ sessionId: kid, prompt: "echo:gamma" });
        const sidecar = async () => JSON.parse(await fs.readFile(path.join(scratch, "sessions.json"), "utf8"))[kid] ?? {};
        t.ok(label("前提: 渡さなかった ! の行が会話に残り、文脈量を持っている"), (await sidecar()).shellKept?.length === 1 && Boolean((await sidecar()).contextWindow));
        const betaId = (await c.cmd("loadSession", { sessionId: kid })).messages.filter(m => m.role === "user" && !m.kind)[1].uuid;
        const keepId = crypto.randomUUID();
        const keepFrom = c.mark();
        await c.cmd("sendMessage", { sessionId: kid, messageId: keepId, prompt: "slow", rewind: { beforeMessageId: betaId } });
        await c.waitFor(e => e.type === "userMessage" && e.messageId === keepId, { from: keepFrom });
        const after3 = await sidecar();
        t.ok(label("切り口より後の渡さなかった ! の行は捨てる"), !after3.shellKept?.length, JSON.stringify(after3.shellKept));
        t.ok(label("古い文脈量の表示は捨てる（新しいターンの値で上書きされるまで古いままにしない）"), !after3.contextWindow, JSON.stringify(after3.contextWindow));
        await c.cmd("abort", { sessionId: kid });
      }
    } finally { c.close(); await server.stop(); await fs.rm(scratch, { recursive: true, force: true }).catch(() => {}); }
  }

  // 本物の Codex アダプターと身代わりの app-server（tests/lib/fake-codex.mjs）: paginated のスレッドは thread/revert、
  // legacy のスレッドは thread/fork { beforeTurnId } で別スレッドに差し替える（会話の id は同じ）
  for (const form of ["revert", "legacy"]) {
    const scratch = await fs.mkdtemp(path.join(os.tmpdir(), `agent-host-rewind-codex-${form}-`));
    const log = path.join(scratch, "fake-codex.log");
    const server = await startServer({ dataDir: scratch, env: { AGENT_HOST_BACKENDS: "codex", FAKE_CODEX_UNIQUE_IDS: "1", FAKE_CODEX_LOG: log,
      FAKE_CODEX_LEGACY: form === "legacy" ? "1" : "0", AGENT_HOST_CODEX_BIN: `node "${path.join(ROOT, "tests/lib/fake-codex.mjs")}"` } });
    const c = await open({ port: server.port, token: server.token, autoAllow: true });
    const label = text => `[codex ${form}] ${text}`;
    const calls = async () => (await fs.readFile(log, "utf8").catch(() => "")).split("\n").filter(Boolean).map(line => JSON.parse(line));
    try {
      const first = await c.runTurn({ backend: "codex", cwd: ROOT, prompt: "prefix violet" });
      const id = first.sessionId;
      await c.runTurn({ sessionId: id, prompt: "excluded amber" });
      await c.runTurn({ sessionId: id, prompt: "third turn" });
      const before = await c.cmd("loadSession", { sessionId: id });
      const users = before.messages.filter(m => m.role === "user");
      t.ok(label("前提: 3 ターン"), users.length === 3, before.messages.map(m => m.uuid).join());
      const sessionsBefore = (await c.cmd("listSessions")).length;
      const messageId = crypto.randomUUID();
      const from = c.mark();
      const sent = await c.cmd("sendMessage", { sessionId: id, messageId, prompt: "replacement text", rewind: { beforeMessageId: users[1].uuid } });
      await c.waitFor(e => e.type === "userMessage" && e.messageId === messageId, { from });
      const started = c.events.findIndex((e, i) => i >= from && e.type === "userMessage" && e.messageId === messageId);
      await c.waitFor(e => e.type === "turnEnd" && e.sessionId === id, { from: started });
      const after = await c.cmd("loadSession", { sessionId: id });
      t.ok(label("同じ会話で巻き戻して送り直す"), after.messages.length === 4 && after.messages[0].text === "prefix violet"
        && after.messages[2].text === "replacement text" && !after.messages.some(m => /amber|third/.test(m.text ?? "")), after.messages.map(m => m.text).join(" | "));
      t.ok(label("会話は増えない"), (await c.cmd("listSessions")).length === sessionsBefore);
      const names = (await calls()).map(x => x.method);
      if (form === "revert") {
        t.ok(label("thread/revert で巻き戻す"), names.includes("thread/revert") && !names.includes("thread/fork"), names.join());
        t.ok(label("thread id は変わらない"), sent.rewind.mode === "thread" && sent.rewind.renumbered === false);
      } else {
        const fork = (await calls()).find(x => x.method === "thread/fork");
        t.ok(label("断られたら thread/fork { beforeTurnId } で別スレッドに差し替える"), Boolean(fork?.beforeTurnId) && names.includes("thread/revert"), names.join());
        t.ok(label("差し替えたことを返す（画面は履歴を読み直す）"), sent.rewind.mode === "thread" && sent.rewind.renumbered === true);
      }
      // ターンの途中に差し込んだ発言・最初の発言はスレッドを切れないので、ホスト管理（引き継ぎ）に落とす
      const firstOut = await c.cmd("sendMessage", { sessionId: id, messageId: crypto.randomUUID(), prompt: "from the very beginning",
        rewind: { beforeMessageId: after.messages[0].uuid } });
      t.ok(label("最初の発言はホスト管理に落とす"), firstOut.rewind.mode === "host");
    } finally { c.close(); await server.stop(); await fs.rm(scratch, { recursive: true, force: true }).catch(() => {}); }
  }

  // M5: item id を使い回すネイティブ（身代わりの Codex は既定でターンごとに同じ id）では、どの発言か決められないので断る。最初に当たった発言で切らない
  {
    const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "agent-host-rewind-codex-dup-"));
    const server = await startServer({ dataDir: scratch, env: { AGENT_HOST_BACKENDS: "codex", AGENT_HOST_CODEX_BIN: `node "${path.join(ROOT, "tests/lib/fake-codex.mjs")}"` } });
    const c = await open({ port: server.port, token: server.token, autoAllow: true });
    try {
      const first = await c.runTurn({ backend: "codex", cwd: ROOT, prompt: "first dup" });
      await c.runTurn({ sessionId: first.sessionId, prompt: "second dup" });
      const before = (await c.cmd("loadSession", { sessionId: first.sessionId })).messages;
      const users = before.filter(m => m.role === "user");
      const error = await c.cmd("sendMessage", { sessionId: first.sessionId, messageId: crypto.randomUUID(), prompt: "x", rewind: { beforeMessageId: users[1].uuid } }).then(() => null, e => e.message);
      t.ok("[codex duplicate ids] 同じ id の発言が複数あるときは、送り直す発言を決められないと断る", users.length === 2 && users[0].uuid === users[1].uuid && /同じ ID/.test(error ?? ""), String(error));
      t.ok("[codex duplicate ids] 断られた送り直しは履歴を変えない", JSON.stringify((await c.cmd("loadSession", { sessionId: first.sessionId })).messages) === JSON.stringify(before));
    } finally { c.close(); await server.stop(); await fs.rm(scratch, { recursive: true, force: true }).catch(() => {}); }
  }

  // M8: 委譲された作業の会話（子）は、同じ会話では送り直せない（委譲タスクの結果・状態が巻き戻した履歴と食い違う）。分岐して送るだけ
  {
    const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "agent-host-rewind-child-"));
    const server = await startServer({ dataDir: scratch, env: { AGENT_HOST_BACKENDS: "fake" } });
    const c = await open({ port: server.port, token: server.token, autoAllow: true });
    try {
      const delegate = "ply:" + JSON.stringify({ name: "ply_delegate", arguments: { kind: "mechanical", backend: "fake", task: "echo:CHILD_RESULT" } });
      await c.runTurn({ backend: "fake", cwd: ROOT, prompt: delegate }, { ms: 60_000 });
      let child = null;
      for (let i = 0; i < 400 && !child; i++) {
        child = (await c.cmd("agentTasks")).find(row => row.sessionId && row.status === "completed") ?? null;
        if (!child) await new Promise(resolve => setTimeout(resolve, 50));
      }
      const messages = child ? (await c.cmd("loadSession", { sessionId: child.sessionId })).messages : [];
      const error = child ? await c.cmd("sendMessage", { sessionId: child.sessionId, messageId: crypto.randomUUID(), prompt: "x",
        rewind: { beforeMessageId: messages.find(m => m.role === "user").uuid } }).then(() => null, e => e.message) : "no child";
      t.ok("[delegated child] 委譲された作業の会話は同じ会話では送り直せない（分岐して送るだけ）", /委譲された会話/.test(error ?? ""), String(error));
      t.ok("[delegated child] 断られても子の履歴は変わらない", child && JSON.stringify((await c.cmd("loadSession", { sessionId: child.sessionId })).messages) === JSON.stringify(messages));
      const branch = child ? await c.cmd("fork", { sessionId: child.sessionId, beforeMessageId: messages.find(m => m.role === "user").uuid }).then(r => r, () => null) : null;
      t.ok("[delegated child] 分岐して送る（fork の beforeMessageId）は使える", Boolean(branch?.sessionId));
    } finally { c.close(); await server.stop(); await fs.rm(scratch, { recursive: true, force: true }).catch(() => {}); }
  }
}
