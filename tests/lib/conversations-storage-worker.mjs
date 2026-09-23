import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "agent-host-conv-storage-"));
process.env.AGENT_HOST_DATA = scratch;

const convFile = path.join(scratch, "conversations.json");
const oldData = {
  "migrated-1": {
    backend: "fake",
    nativeId: null,
    base: 0,
    segments: [],
    info: { title: "old conversation" },
    messages: [{ role: "user", uuid: "u1", text: "hello old" }],
    presents: [{ path: "one.png" }],
  },
};
await fs.writeFile(convFile, JSON.stringify(oldData), "utf8");

const { conversation, createConversation, deleteUnsentConversation } = await import("../../core/conversations.mjs");

const r = await conversation("migrated-1");
assert.equal(r?.messages?.[0]?.text, "hello old", "旧データが読み出せる");
assert.equal(r?.presents?.[0]?.path, "one.png", "presents も引き継がれる");

// 個別ファイルが存在することを確認
const sessFile = path.join(scratch, "conversations", "migrated-1.json");
const sessRaw = JSON.parse(await fs.readFile(sessFile, "utf8"));
assert.equal(sessRaw.messages?.[0]?.text, "hello old", "個別ファイルに messages が分割保存される");

// インデックスから messages が除外され軽量化されていることを確認
const indexRaw = JSON.parse(await fs.readFile(convFile, "utf8"));
assert.equal(indexRaw["migrated-1"].messages, undefined, "インデックス側には messages が含まれない");

// 新規セッション作成と削除
const newId = await createConversation({ id: "fake" }, { title: "new conv" });
assert(Boolean(newId), "新規セッションが作成できる");
const newSessFile = path.join(scratch, "conversations", `${newId}.json`);
assert.equal(await fs.stat(newSessFile).then(() => true, () => false), true, "新規セッションの個別ファイルが作成される");

await deleteUnsentConversation(newId);
assert.equal(await fs.stat(newSessFile).then(() => false, () => true), true, "未送信セッション削除で個別ファイルが削除される");

await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
console.log("conversations storage split and migration verified");
