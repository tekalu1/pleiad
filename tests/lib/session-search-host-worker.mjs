// セッション検索をこのホストの保存先につなぐ部分（core/session-search-host.mjs）。
// store はデータ置き場を読み込み時に決めるので、使い捨ての置き場を持つ別プロセスで確かめる。
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "agent-host-search-"));
process.env.AGENT_HOST_DATA = scratch;
await fs.mkdir(path.join(scratch, "conversations"), { recursive: true });

const NOTICE = "[完了通知] 子の作業が終わりました: 秘密の通知語";
const index = {
  hosted: { backend: "fake", nativeId: null, base: 0, segments: [], info: { title: "保存済みの会話" } },
  empty: { backend: "fake", nativeId: null, base: 0, segments: [], info: { title: "空の会話" } },
};
const stored = {
  hosted: { messages: [
    { role: "user", uuid: "h1", text: "保存分の本文 alpha", at: "2026-10-01T00:00:00Z" },
    { role: "user", uuid: "h2", text: "<command-name>/model</command-name>\n<command-message>model</command-message>", at: "2026-10-01T00:00:01Z" },
    { role: "user", uuid: "h3", text: NOTICE, at: "2026-10-01T00:00:02Z" },
    { role: "assistant", uuid: "h4", text: "", toolCalls: [{ id: "t", name: "Bash", input: { command: "npm test" }, result: { text: "tool-output-word" } }], at: "2026-10-01T00:00:03Z" },
  ] },
};
await fs.writeFile(path.join(scratch, "conversations.json"), JSON.stringify(index));
await fs.writeFile(path.join(scratch, "conversations", "hosted.json"), JSON.stringify(stored.hosted));

const store = await import("../../core/store.mjs");
await store.setSessionData("hosted", "taskNotices", [crypto.createHash("sha256").update(NOTICE).digest("hex")]);
const { createHostSessionSearch } = await import("../../core/session-search-host.mjs");
const { conversation } = await import("../../core/conversations.mjs");

const reads = [];
let nativeText = "ネイティブの本文 beta";
const backend = { async getMessages(id) { reads.push(id); return id === "native" ? [{ role: "user", uuid: "n1", text: nativeText }] : []; } };
const titles = { hosted: "保存済みの会話", empty: "空の会話", native: "native" };
const rows = ["hosted", "empty", "native"].map((id) => ({ id, title: titles[id], status: null, cwd: "D:\dev\app", backend: "fake", lastModified: Date.now() - 60_000, delegation: null }));
const search = createHostSessionSearch({ listSessions: async () => rows, resolveBackend: async () => backend });
await search.search({ query: "" });
await search.idle();
const ids = async (query, filters) => (await search.search({ query, filters })).sessions.map((s) => s.sessionId).sort().join();

assert.equal(await ids("alpha"), "hosted", "Pleiad が持つ会話は保存分から読む");
assert.equal(await ids("beta"), "native", "それ以外の会話はバックエンドの getMessages で読む");
assert.deepEqual(reads.filter((id) => id === "hosted"), [], "保存分があるものはネイティブを読まない");
assert.equal(await ids("秘密の通知語"), "", "委譲の完了通知として送った発言は対象外");
assert.equal(await ids("model"), "", "コマンドの行（kind が付くもの）は対象外");
assert.equal(await ids("tool-output-word", { includeToolInputs: true }), "", "ツールの出力は対象外");
assert.equal(await ids("npm", { includeToolInputs: true }), "hosted", "ツールの入力は含めると当たる");
assert.equal(await ids("npm"), "", "ツールの入力は既定で対象外");
const empty = (await search.search({ query: "空の会話" })).sessions[0];
assert.equal(empty?.sessionId, "empty", "本文の無い会話も題には当たる");
assert.equal(search.status().pending, 0, "全部写した");

// 読んだだけでは conversations の記録に本文を持ち続けない（本文が二重にメモリへ載らない）
const { readStoredMessages } = await import("../../core/conversations.mjs");
assert.equal((await readStoredMessages("hosted")).length, 4);
assert.equal(await readStoredMessages("native"), null, "Pleiad が持たない会話は null");
const record = await conversation("hosted");
assert.equal(record.messages.length, 4, "conversation() は従来どおり読める");

// ターンの終わり（refresh）は全量を読み直して写しを置き換える
nativeText = "ターンで進んだ本文 gamma";
search.refresh("native");
await search.idle();
assert.equal(await ids("gamma"), "native", "refresh で読み直した本文に当たる");
assert.equal(await ids("beta"), "", "置き換えた古い本文には当たらない");
search.stop();
await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
console.log("session search host wiring verified");
