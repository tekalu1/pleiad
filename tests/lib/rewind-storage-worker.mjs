// 同じ会話での巻き戻し（core/conversations.mjs の rewind。ADR 0102）の契約。身代わりのネイティブで、
// 保留の印・履歴の見かけ上の切り取り・提示の切り取り・ホスト管理への落とし先を測る。
// 他のテストが store を先に読み込むので、自分のデータ置き場を持つ子プロセスで走らせる（tests/unit/server-rewind.mjs）
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "agent-host-rewind-"));
process.env.AGENT_HOST_DATA = scratch;
const { wrapBackend, conversation } = await import("../../core/conversations.mjs");
const { recordPresent, readPresents } = await import("../../core/history.mjs");
const store = await import("../../core/store.mjs");

const iso = n => new Date(Date.UTC(2026, 9, 3, 10, 0, n)).toISOString();
const msg = (role, uuid, n, extra = {}) => ({ role, uuid, text: `${role}:${uuid}`, at: iso(n), ...extra });
const git = (id, n) => recordPresent(id, { kind: "git", at: iso(n), git: { n }, by: "ai" });
let seq = 0;

/** Claude と同じ形の身代わり: 次のターンが resumeSessionAt / resumeDropsTurn で葉を付け替える */
function claudeLike({ reject = false, failWith = null } = {}) {
  const sessions = new Map();
  const api = {
    id: "claude", calls: [], sessions,
    capabilities: { rewind: "resumeAt", fork: false, title: true },
    listSessions: async () => [...sessions.keys()].map(sessionId => ({ sessionId })),
    getSession: async id => (sessions.has(id) ? { sessionId: id, cwd: scratch, title: "元の題" } : null),
    getMessages: async id => structuredClone(sessions.get(id)?.chain ?? []),
    runTurn: async args => {
      api.calls.push({ sessionId: args.sessionId, prompt: args.prompt, rewind: args.rewind });
      let id = args.sessionId;
      if (!id) { id = `n${++seq}`; sessions.set(id, { chain: [] }); args.emit({ type: "session", sessionId: id, first: true }); }
      const s = sessions.get(id);
      // failWith: 巻き戻しを伴うターンが、拒否の形ではない例外で失敗し続ける（実機の拒否の形が想定と違った場合）
      if (args.rewind && failWith) throw failWith;
      if (args.rewind) {
        const at = s.chain.findIndex(m => m.uuid === args.rewind.drops);
        if (reject || at < 0) throw Object.assign(new Error("Resume rejected by --resume-drops-turn: fake"), { rewindRejected: true });
        assert.equal(s.chain[at - 1]?.uuid, args.rewind.at, "切り口は捨てる発言の直前");
        s.chain = s.chain.slice(0, at);
      }
      const n = ++seq;
      s.chain.push(msg("user", `${id}-u${n}`, 100 + n, { text: args.prompt }), msg("assistant", `${id}-a${n}`, 100 + n));
    },
  };
  return api;
}

/** Codex と同じ形の身代わり: 今すぐスレッドの履歴を置き換える（revert）。mode で fork / 失敗に切り替える */
function codexLike({ how = "revert" } = {}) {
  const threads = new Map();
  const api = {
    id: "codex", calls: [], threads,
    capabilities: { rewind: "thread", fork: false, title: true },
    listSessions: async () => [...threads.keys()].map(sessionId => ({ sessionId })),
    getSession: async id => (threads.has(id) ? { sessionId: id, cwd: scratch, title: "元の題" } : null),
    getMessages: async id => structuredClone(threads.get(id) ?? []),
    rewind: async (id, { beforeMessageId }) => {
      api.calls.push({ rewind: id, beforeMessageId });
      const list = threads.get(id);
      const at = list.findIndex(m => m.uuid === beforeMessageId);
      if (how === "fail") throw new Error("revert refused");
      if (how === "fork") {
        const child = `fork${++seq}`;
        threads.set(child, list.slice(0, at).map(m => ({ ...m, uuid: `${child}-${m.uuid}` })));
        return { sessionId: child, via: "fork" };
      }
      threads.set(id, list.slice(0, at));
      return { sessionId: id, via: "revert" };
    },
    runTurn: async args => {
      api.calls.push({ sessionId: args.sessionId, prompt: args.prompt });
      let id = args.sessionId;
      if (!id) { id = `th${++seq}`; threads.set(id, []); args.emit({ type: "session", sessionId: id, first: true }); }
      const n = ++seq;
      threads.get(id).push(msg("user", `u${n}`, 100 + n, { text: args.prompt }), msg("assistant", `a${n}`, 100 + n));
    },
  };
  return api;
}

const texts = list => list.map(m => m.uuid).join();
const emit = () => {};

// ---- Claude の形: ネイティブだけの会話（記録なし）
{
  const native = claudeLike();
  const backend = wrapBackend(native);
  const id = "claude-bare";
  native.sessions.set(id, { chain: [msg("user", "u1", 1), msg("assistant", "a1", 2), msg("user", "u2", 3), msg("assistant", "a2", 4), msg("user", "u3", 5), msg("assistant", "a3", 6)] });
  for (const n of [0, 2, 4, 6]) await git(id, n);   // 0: u1 の前 / 2: a1 の後 / 4: a2 の後 / 6: 末尾
  assert.equal((await backend.getPresents(id)).length, 4);

  const out = await backend.rewind(id, { beforeMessageId: "u2" });
  assert.deepEqual({ mode: out.mode, renumbered: out.renumbered, removed: out.removed },
    { mode: "resume", renumbered: false, removed: { messages: 4, userMessages: 1, replies: 2 } }, "Claude の形は保留の印を置く");
  assert.deepEqual((await store.get(id)).rewind, { backend: "claude", nativeId: id, at: "a1", drops: "u2" });
  assert.equal(texts(await backend.getMessages(id)), "u1,a1", "次のターンまでは履歴を見かけ上切って返す");
  assert.equal(native.sessions.get(id).chain.length, 6, "JSONL（ネイティブ）はまだ動かない");
  assert.equal(await conversation(id), null, "ネイティブだけの会話に記録は作らない");
  assert.deepEqual((await readPresents(id)).map(p => p.git.n), [0], "切り口（a1）より後に並ぶ提示を捨てる（「ここから分岐」と同じ選び方）");

  await backend.runTurn({ sessionId: id, prompt: "新しい u2", emit });
  assert.deepEqual(native.calls.at(-1).rewind, { at: "a1", drops: "u2" }, "次のターンが resumeSessionAt と resumeDropsTurn を渡す");
  assert.equal(native.calls.at(-1).sessionId, id, "会話の id は変わらない");
  const after = await backend.getMessages(id);
  assert.equal(after.length, 4, "巻き戻した先に新しい発言と返答が続く");
  assert.equal(after[2].text, "新しい u2");
  assert.equal(after.some(m => ["u2", "a2", "u3", "a3"].includes(m.uuid)), false, "捨てた発言は戻らない");
  await backend.runTurn({ sessionId: id, prompt: "その次", emit });
  assert.equal(native.calls.at(-1).rewind, undefined, "葉が移ったあとのターンは巻き戻しを渡さない（古い印で今の会話を切らない）");
  assert.equal((await backend.getMessages(id)).length, 6);
  assert.equal((await store.get(id)).rewind, null, "鎖から消えた印は片付く");
}

// ---- Claude の形: 最初の発言・拒否はホスト管理に落とす
{
  const native = claudeLike();
  const backend = wrapBackend(native);
  const id = "claude-first";
  native.sessions.set(id, { chain: [msg("user", "u1", 1), msg("assistant", "a1", 2), msg("user", "u2", 3), msg("assistant", "a2", 4)] });
  await store.setMeta(id, { title: "最初の発言から付いた題" });
  const out = await backend.rewind(id, { beforeMessageId: "u1" });
  assert.equal(out.mode, "host", "最初の発言の手前には切り口にできる発言が無い");
  const record = await conversation(id);
  assert.equal(record.nativeId, null);
  assert.deepEqual(record.messages, []);
  assert.deepEqual(record.segments, [{ backend: "claude", nativeId: id }], "元のネイティブの id は一覧から隠れる");
  assert.equal((await store.get(id)).title, null, "最初の発言から付いた題は付け直す");
  assert.equal((await backend.listSessions()).filter(s => s.sessionId === id).length, 1, "一覧に二重に出ない");
  await backend.runTurn({ sessionId: id, prompt: "最初からやり直し", emit });
  assert.equal(native.calls.at(-1).sessionId, null, "新しいネイティブの会話を起こす");
  assert.equal(native.calls.at(-1).prompt, "最初からやり直し", "履歴が空なので引き継ぎ文を付けない");
  assert.equal((await conversation(id)).nativeId.startsWith("n"), true);
}
{
  const native = claudeLike({ reject: true });
  const backend = wrapBackend(native);
  const id = "claude-reject";
  native.sessions.set(id, { chain: [msg("user", "u1", 1), msg("assistant", "a1", 2), msg("user", "u2", 3), msg("assistant", "a2", 4)] });
  await backend.rewind(id, { beforeMessageId: "u2" });
  await backend.runTurn({ sessionId: id, prompt: "拒否のあと", emit });
  const calls = native.calls.filter(c => c.prompt?.includes("拒否のあと") || c.rewind);
  assert.equal(calls.length, 2, "拒否は繰り返し再試行しない（拒否された 1 回と、ホスト管理でのやり直し 1 回）");
  assert.deepEqual(calls[0].rewind, { at: "a1", drops: "u2" });
  assert.equal(calls[1].sessionId, null);
  assert.equal(calls[1].rewind, undefined);
  assert.equal(calls[1].prompt.includes("u1") && calls[1].prompt.includes("拒否のあと"), true, "切った履歴を引き継ぎ文で渡す");
  assert.equal(calls[1].prompt.includes("u2") && calls[1].prompt.includes("a2"), false, "捨てた発言は引き継がない");
  const record = await conversation(id);
  assert.equal(record.messages.some(m => m.uuid === "u2" || m.uuid === "a2"), false, "捨てた発言が履歴に戻らない");
  assert.equal((await store.get(id)).rewind, null);
}

// ---- Claude の形: 記録のある会話（ネイティブの区間の中）
{
  const native = claudeLike();
  const backend = wrapBackend(native);
  const { createConversation } = await import("../../core/conversations.mjs");
  const id = await createConversation(native, { title: "T" });
  const run = prompt => backend.runTurn({ sessionId: id, prompt, emit: () => {} });
  await run("一つ目"); await run("二つ目"); await run("三つ目");
  const record = await conversation(id);
  assert.ok(record.nativeId, "ターンのあいだにネイティブの id が決まる");
  const messages = await backend.getMessages(id);
  const second = messages.filter(m => m.role === "user")[1];
  assert.ok(second.uuid.startsWith(`claude:${record.nativeId}:`), "記録の発言の uuid は接頭辞付き");
  await git(id, 0);
  const out = await backend.rewind(id, { beforeMessageId: second.uuid });
  assert.equal(out.mode, "resume");
  const mark = (await store.get(id)).rewind;
  assert.equal(mark.nativeId, record.nativeId);
  assert.equal(mark.drops, second.uuid.slice(`claude:${record.nativeId}:`.length), "ネイティブには接頭辞を外した uuid を渡す");
  assert.equal((await backend.getMessages(id)).length, 2, "記録の履歴も切る");
  assert.equal((await conversation(id)).messages.length, 2);
  await run("二つ目をやり直し");
  assert.deepEqual(native.calls.at(-1).rewind, { at: mark.at, drops: mark.drops });
  const final = await backend.getMessages(id);
  assert.deepEqual([final[0].text, final[2].text], ["一つ目", "二つ目をやり直し"]);
  assert.equal(final.length, 4, "捨てた発言が取り込み直しで戻らない");
  assert.equal(final.some(m => m.text === "三つ目"), false);
}

// ---- Codex の形: 今すぐ巻き戻す（revert）・別スレッドに差し替える（fork）・落とす
for (const how of ["revert", "fork", "fail"]) {
  const native = codexLike({ how });
  const backend = wrapBackend(native);
  const id = `codex-${how}`;
  native.threads.set(id, [msg("user", "u1", 1), msg("assistant", "a1", 2), msg("user", "u2", 3), msg("assistant", "a2", 4)]);
  const out = await backend.rewind(id, { beforeMessageId: "u2" });
  if (how === "revert") {
    assert.deepEqual({ mode: out.mode, renumbered: out.renumbered }, { mode: "thread", renumbered: false });
    assert.equal(texts(await backend.getMessages(id)), "u1,a1", "今すぐ履歴が切れる");
    assert.equal(await conversation(id), null, "thread id が変わらなければ記録は作らない");
  } else if (how === "fork") {
    assert.deepEqual({ mode: out.mode, renumbered: out.renumbered }, { mode: "thread", renumbered: true }, "別スレッドに差し替えたら uuid が変わる");
    const record = await conversation(id);
    assert.equal(record.nativeId.startsWith("fork"), true);
    assert.deepEqual(record.segments.map(s => s.nativeId), [id, record.nativeId], "元のスレッドも差し替え先も一覧から隠れる");
    const messages = await backend.getMessages(id);
    assert.equal(messages.length, 2, "差し替え先の履歴を取り込む");
    await backend.runTurn({ sessionId: id, prompt: "続き", emit });
    assert.equal(native.calls.at(-1).sessionId, record.nativeId, "続きは差し替え先のスレッドで走る");
    assert.equal((await backend.getMessages(id)).length, 4);
  } else {
    assert.equal(out.mode, "host", "巻き戻せなければホスト管理に落とす");
    assert.deepEqual((await conversation(id)).messages.map(m => m.uuid), ["u1", "a1"]);
    assert.equal((await conversation(id)).nativeId, null);
  }
}
{
  // ターンの途中の発言・最初の発言は、Codex でもホスト管理
  const native = codexLike();
  const backend = wrapBackend(native);
  native.threads.set("codex-first", [msg("user", "u1", 1), msg("assistant", "a1", 2)]);
  assert.equal((await backend.rewind("codex-first", { beforeMessageId: "u1" })).mode, "host");
  assert.equal(native.calls.some(c => c.rewind), false, "切り口が無ければスレッドには触らない");
}

// ---- ネイティブが巻き戻せない形（Antigravity）: ホスト管理
{
  const native = { id: "antigravity", capabilities: {}, released: [], listSessions: async () => [],
    getSession: async id => ({ sessionId: id, cwd: scratch, title: "agy" }),
    getMessages: async () => [msg("user", "u1", 1), msg("assistant", "a1", 2), msg("user", "u2", 3), msg("assistant", "a2", 4)],
    releaseConversation(id) { native.released.push(id); },
    runTurn: async () => {} };
  const backend = wrapBackend(native);
  const out = await backend.rewind("agy-1", { beforeMessageId: "u2" });
  assert.equal(out.mode, "host");
  assert.deepEqual(native.released, ["agy-1"], "生きているプロセスは使わない");
  const record = await conversation("agy-1");
  assert.deepEqual(record.messages.map(m => m.uuid), ["u1", "a1"]);
  assert.equal(record.nativeId, null);
  assert.equal(record.base, 2);
  // 引き継ぎ済み（ネイティブの区間より前の発言）もホスト管理のまま切る
  const again = await backend.rewind("agy-1", { beforeMessageId: "a1" }).catch(e => e);
  assert.match(String(again.message), /自分の発言/, "自分の発言以外は断る");
  await assert.rejects(backend.rewind("agy-1", { beforeMessageId: "nope" }), /見つかりません/);
}

// ---- 失敗の場面（レビューの指摘の再現）
const index = path.join(scratch, "conversations.json");
const blockIndex = async () => { await fs.rename(index, index + ".aside"); await fs.mkdir(index); };
const unblockIndex = async () => { await fs.rmdir(index); await fs.rename(index + ".aside", index); };

// R1: 拒否の形ではない例外で失敗し続けても、印を残さずホスト管理に落とす（3 回目は印を渡さない）
{
  const native = claudeLike({ failWith: new Error("boom: exit code 1") });
  const backend = wrapBackend(native);
  const id = "claude-fails";
  native.sessions.set(id, { chain: [msg("user", "u1", 1), msg("assistant", "a1", 2), msg("user", "u2", 3), msg("assistant", "a2", 4)] });
  await backend.rewind(id, { beforeMessageId: "u2" });
  await assert.rejects(backend.runTurn({ sessionId: id, prompt: "1 回目", emit }), /boom/);
  assert.equal((await store.get(id)).rewind.tries, 1, "失敗した回数を印に数える");
  await assert.rejects(backend.runTurn({ sessionId: id, prompt: "2 回目", emit }), /boom/);
  assert.equal((await store.get(id)).rewind.tries, 2);
  native.calls.length = 0;
  await backend.runTurn({ sessionId: id, prompt: "3 回目", emit });
  assert.equal(native.calls.length, 1, "3 回目は巻き戻しを渡さずにホスト管理で走る");
  assert.equal(native.calls[0].rewind, undefined);
  assert.equal(native.calls[0].sessionId, null);
  assert.equal((await store.get(id)).rewind, null, "印を残さない");
  assert.equal((await conversation(id)).nativeId?.startsWith("n"), true);
  assert.equal((await backend.getMessages(id)).some(m => m.uuid === "u2" || m.uuid === "a2"), false);
}

// R2: 検証で断られるときは、何も変えない（rewindPlan は何も書かない。presentNoTime など）
{
  const native = claudeLike();
  const backend = wrapBackend(native);
  const id = "claude-notime";
  native.sessions.set(id, { chain: [msg("user", "u1", 1), msg("assistant", "a1", 2), msg("user", "u2", 3), msg("assistant", "a2", 4)] });
  const planned = await backend.rewindPlan(id, { beforeMessageId: "u2" });
  assert.deepEqual({ mode: planned.mode, removed: planned.removed }, { mode: "resume", removed: { messages: 2, userMessages: 0, replies: 1 } });
  assert.equal(planned.since, Date.parse(iso(3)));
  assert.equal((await store.get(id)).rewind, undefined, "検証だけでは印を置かない");
  await fs.mkdir(path.join(scratch, "presents"), { recursive: true });
  await fs.appendFile(path.join(scratch, "presents", `${id}.jsonl`), JSON.stringify({ kind: "text", by: "ai", content: "時刻の無い提示" }) + "\n");
  await assert.rejects(backend.rewindPlan(id, { beforeMessageId: "u2" }), /時刻/, "AI の提示に時刻が無ければ検証で断る");
  await assert.rejects(backend.rewind(id, { beforeMessageId: "u2" }), /時刻/);
  assert.equal((await store.get(id)).rewind, undefined, "断られたら印も置かない");
  assert.equal(texts(await backend.getMessages(id)), "u1,a1,u2,a2", "履歴は変わらない");
  assert.equal((await readPresents(id)).length, 1, "提示も切らない");
}

// M1・M2: 保存の失敗で記録が割れない（メモリは元のまま・印は置かない）
{
  const native = claudeLike();
  const backend = wrapBackend(native);
  const { createConversation } = await import("../../core/conversations.mjs");
  const id = await createConversation(native, { title: "T" });
  const run = prompt => backend.runTurn({ sessionId: id, prompt, emit: () => {} });
  await run("一つ目"); await run("二つ目"); await run("三つ目");
  const before = structuredClone(await conversation(id));
  const second = (await backend.getMessages(id)).filter(m => m.role === "user")[1];
  await blockIndex();
  await assert.rejects(backend.rewind(id, { beforeMessageId: second.uuid }));
  assert.deepEqual((await conversation(id)).messages, before.messages, "巻き戻し（resume）の保存に失敗しても、記録の写しは切れたままにならない");
  assert.equal((await store.get(id)).rewind ?? null, null, "印も置かない");
  const first = (await backend.getMessages(id)).find(m => m.role === "user");
  await assert.rejects(backend.rewind(id, { beforeMessageId: first.uuid }));
  const kept = await conversation(id);
  assert.equal(kept.nativeId, before.nativeId, "ホスト管理に落とす保存に失敗しても、メモリの記録は元のまま（ネイティブの id を失わない）");
  assert.equal(kept.messages.length, before.messages.length);
  await unblockIndex();
  assert.equal((await backend.rewind(id, { beforeMessageId: second.uuid })).mode, "resume", "保存できるようになれば巻き戻せる");
}

// M4: 切り口の直前がツール呼びだけの発言（束ねた先頭の uuid）なら、ホスト管理（中途半端な枝から続けない）
{
  const native = claudeLike();
  const backend = wrapBackend(native);
  const id = "claude-tool-end";
  native.sessions.set(id, { chain: [msg("user", "u1", 1), msg("assistant", "a1", 2), msg("user", "u2", 3),
    { ...msg("assistant", "tools", 4), text: "", toolCalls: [{ id: "c1", name: "Bash", input: {}, result: null }] }, msg("user", "u3", 5), msg("assistant", "a3", 6)] });
  assert.equal((await backend.rewindPlan(id, { beforeMessageId: "u3" })).mode, "host", "ツール呼びで終わった返答の後ろは Claude の切り口にしない");
  assert.equal((await backend.rewind(id, { beforeMessageId: "u3" })).mode, "host");
  assert.deepEqual((await conversation(id)).messages.map(m => m.uuid), ["u1", "a1", "u2", "tools"]);
}

// M5: 同じ id の発言が複数あるときは、どれか決められないので断る（最初に当たった発言で切らない）
{
  const native = claudeLike();
  const backend = wrapBackend(native);
  const id = "claude-dup";
  native.sessions.set(id, { chain: [msg("user", "same", 1), msg("assistant", "a1", 2), msg("user", "same", 3), msg("assistant", "a2", 4)] });
  await assert.rejects(backend.rewind(id, { beforeMessageId: "same" }), /同じ ID/);
  assert.equal(texts(await backend.getMessages(id)), "same,a1,same,a2");
  assert.equal((await store.get(id)).rewind, undefined);
}

await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
console.log("rewind contracts passed");
