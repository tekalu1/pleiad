// ターン途中に送ったメッセージを、procway のその区切りへ差し込む（serve の steer コマンド）。
//
// procway serve の身代わり（tests/lib/fake-procway）を使う。本物の procway-code は cli-agent でしか
// LLM 無しに動かせず、cli-agent はツールを呼ばないので「区切りの継ぎ目」が 1 度も来ない。
// 身代わり側は本物と同じ形だけを守る: 受理は { queued: true }（= 積んだだけ）で、会話に入った合図は
// user.prompt.submitted（steer:true, clientMessageId 付き）。Pleiad 側（core/backends/procway.mjs の
// control.steer・振り分け・正規化、server の送信待ちと userMessage の pending）は本物のまま通る。
//
// steer を知らない procway（ready に commands を載せてこない古い版）では、途中送信は今までどおり
// 送信待ちになり、ターンが終わってから普通に送られる — それも同じ台本で確かめる。
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startServer, ROOT } from "../lib/server.mjs";
import { open } from "../lib/ws-client.mjs";

export const name = "server-procway-steer";
export const title = "ターン途中の送信を、そのターンの中で読ませる";

const FAKE = path.join(ROOT, "tests", "lib", "fake-procway", "cli.mjs");
const servePids = (text) => [...String(text).matchAll(/procway: serve を起動した pid=(\d+)/g)].map((m) => Number(m[1]));

/** 使い捨ての home / cwd / dataDir で server を起こし、中身を走らせてから確実に片づける。 */
async function withServer(t, tag, env, body) {
  const scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), `ply-pw-steer-${tag}-`)));
  const home = path.join(scratch, "home");
  const cwd = path.join(scratch, "work");
  await fs.mkdir(home, { recursive: true });
  await fs.mkdir(cwd, { recursive: true });
  const server = await startServer({
    env: { AGENT_HOST_BACKENDS: "procway", AGENT_HOST_PROCWAY_CODE: FAKE, AGENT_HOST_PROCWAY_HOME: home, ...env },
    dataDir: path.join(scratch, "data"),
    timeoutMs: 30_000,
  });
  const c = await open(server);
  try {
    await body({ c, cwd });
  } finally {
    // 落ちたときに Pleiad と serve の側で何が起きていたか言えるように
    if (t.failures.length) t.note(server.tail(60).split("\n").join("\n      "));
    c.close();
    const pids = servePids(server.tail(400));
    await server.stop();
    for (const pid of pids) { try { process.kill(pid); } catch { /* もう居ない */ } }
    if (process.env.AGENT_HOST_KEEP_SCRATCH) t.note(`使い捨てを残した: ${scratch}`);
    else await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}

export default async function (t) {
  // ---- 対応している procway: 途中送信はそのターンの中で読まれる
  await withServer(t, "on", { AGENT_HOST_FAKE_PROCWAY_STEER: "1" }, async ({ c, cwd }) => {
    const at = (ev) => c.events.indexOf(ev);
    const { sessionId: id } = await c.cmd("newSession", { backend: "procway", cwd });
    const from = c.mark();
    await c.cmd("sendMessage", { sessionId: id, messageId: "s-00000001", prompt: "steer 1500" });
    // 区切りが走り出した印。ここまで来ていれば control.steer が張られている
    await c.waitFor((e) => e.type === "tool.start" && e.sessionId === id, { from, ms: 20_000 });

    await c.cmd("sendMessage", { sessionId: id, messageId: "s-00000002", prompt: "ついでにログも見て" });
    const bubble = await c.waitFor((e) => e.type === "userMessage" && e.messageId === "s-00000002", { from, ms: 10_000 });
    t.ok("途中送信は送信待ちにならず、その場で吹き出しになる", Boolean(bubble));
    t.ok("まだ渡っていないので pending が立つ（steerConfirms）", bubble.pending === true, JSON.stringify(bubble));

    const delivered = await c.waitFor((e) => e.type === "userMessage.delivered" && e.messageId === "s-00000002", { from, ms: 20_000 });
    const end = await c.waitFor((e) => e.type === "turnEnd" && e.sessionId === id, { from, ms: 20_000 });
    t.ok("「渡った」合図はターンが終わる前に来る", at(delivered) < at(end));

    const said = c.since(from).filter((e) => e.type === "text.delta" && e.sessionId === id).map((e) => e.text).join("");
    t.ok("同じターンの返答に途中送信の内容が入る", said.includes("+ ついでにログも見て"), said);
    t.ok("ターンは 1 本で終わる（2 本目を立てない）",
      c.since(from).filter((e) => e.type === "turnEnd" && e.sessionId === id).length === 1);
    t.ok("失敗の turnResult は出ない", !c.since(from).some((e) => e.type === "turnResult" && e.outcome !== "ok"),
      JSON.stringify(c.since(from).filter((e) => e.type === "turnResult")));

    // ---- 履歴: 差し込んだ発言は、読まれた場所に普通の user 発言として並ぶ
    const loaded = await c.cmd("loadSession", { sessionId: id });
    const users = loaded.messages.filter((m) => m.role === "user").map((m) => m.text);
    t.ok("履歴に 2 つの発言がこの順で残る", users.join("|") === "steer 1500|ついでにログも見て", users.join("|"));
    t.ok("差し込んだ発言は最初の返答より後ろに並ぶ",
      loaded.messages.findIndex((m) => m.text === "ついでにログも見て") > loaded.messages.findIndex((m) => m.role === "assistant"),
      loaded.messages.map((m) => m.role).join(","));
    t.ok("履歴では再開の一行（wake 扱い）にならない", !loaded.messages.some((m) => m.resumed));
  });

  // ---- 読まれないままターンが死んだ: 吹き出しを下げ、送信待ち（保留）へ戻す
  await withServer(t, "dropped", { AGENT_HOST_FAKE_PROCWAY_STEER: "1" }, async ({ c, cwd }) => {
    const { sessionId: id } = await c.cmd("newSession", { backend: "procway", cwd });
    const from = c.mark();
    await c.cmd("sendMessage", { sessionId: id, messageId: "d-00000001", prompt: "steer 8000" });
    await c.waitFor((e) => e.type === "tool.start" && e.sessionId === id, { from, ms: 20_000 });
    await c.cmd("sendMessage", { sessionId: id, messageId: "d-00000002", prompt: "読まれない発言" });
    await c.waitFor((e) => e.type === "userMessage" && e.messageId === "d-00000002", { from, ms: 10_000 });

    await c.cmd("abort", { sessionId: id });
    const dropped = await c.waitFor((e) => e.type === "userMessage.dropped" && e.messageId === "d-00000002", { from, ms: 20_000 });
    t.ok("捨てられた合図が画面へ届く（turn.failed の後に来ても落とさない）", Boolean(dropped));
    const back = await c.waitFor((e) => e.type === "outbox" && e.sessionId === id
      && e.messages.find((m) => m.id === "d-00000002")?.status === "paused", { from, ms: 10_000 });
    t.ok("送信済みのまま消えず、保留として送信待ちへ戻る", Boolean(back));
    t.ok("渡った合図は出ない", !c.since(from).some((e) => e.type === "userMessage.delivered" && e.messageId === "d-00000002"));
  });

  // ---- steer を知らない procway: 今までどおり送信待ち -> ターンの後で送られる
  await withServer(t, "off", {}, async ({ c, cwd }) => {
    const at = (ev) => c.events.indexOf(ev);
    const { sessionId: id } = await c.cmd("newSession", { backend: "procway", cwd });
    const from = c.mark();
    await c.cmd("sendMessage", { sessionId: id, messageId: "o-00000001", prompt: "steer 800" });
    await c.waitFor((e) => e.type === "tool.start" && e.sessionId === id, { from, ms: 20_000 });

    await c.cmd("sendMessage", { sessionId: id, messageId: "o-00000002", prompt: "後で読んで" });
    const waiting = await c.waitFor((e) => e.type === "outbox" && e.sessionId === id
      && e.messages.find((m) => m.id === "o-00000002")?.status === "queued", { from, ms: 10_000 });
    t.ok("知らない相手には送らない（応答が返らないので待ちもしない）", Boolean(waiting));

    const end = await c.waitFor((e) => e.type === "turnEnd" && e.sessionId === id, { from, ms: 20_000 });
    const bubble = await c.waitFor((e) => e.type === "userMessage" && e.messageId === "o-00000002", { from, ms: 20_000 });
    t.ok("送信待ちはターンが終わってから送られる", at(bubble) > at(end));
    t.ok("渡った合図を出せない相手では pending を立てない", bubble.pending === undefined, JSON.stringify(bubble));
    await c.waitFor((e) => e.type === "turnEnd" && e.sessionId === id && c.events.indexOf(e) > at(bubble), { from, ms: 20_000 });
    const resent = c.since(at(bubble)).filter((e) => e.type === "text.delta").map((e) => e.text).join("");
    t.ok("送り直した発言にも返答が来る", resent.includes("echo: 後で読んで"), resent);
  });
}
