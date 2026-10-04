import { mergeMessages } from "../../core/conversations.mjs";
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createConversation, conversation, wrapBackend } from '../../core/conversations.mjs';
import { t as translate } from '../../core/i18n.mjs';
export const name = "conversations";
export const title = "統合履歴は圧縮と繰り返し発言で欠落しない";
export default async function(t) {
  const r = { base: 1, messages: [{ uuid: "old", text: "previous engine" },
    { uuid: "a", role: "user", text: "first request" }], injected: "injected context", original: "original request" };
  mergeMessages(r, [{ uuid: "b", role: "user", text: "later request" }], "codex");
  t.ok("ネイティブで圧縮された発言を残す", r.messages.map(m => m.uuid).join() === "old,a,b");
  t.ok("圧縮後の先頭発言を書き換えない", r.messages[2].text === "later request");
  mergeMessages(r, [{ uuid: "b", role: "user", text: "later request" }], "codex");
  t.ok("同じ履歴の読み直しで重複しない", r.messages.length === 3);
  t.ok("発言の生成元を保存", r.messages[2].backend === "codex");
  const noIds = { base: 0, messages: [] };
  const repeated = [{ role: "user", text: "again" }, { role: "user", text: "again" }];
  mergeMessages(noIds, repeated, "codex");
  mergeMessages(noIds, repeated, "codex");
  t.ok("IDがない同文の発言もそれぞれ残す", noIds.messages.length === 2);
  const reused = { base: 1, nativeId: "child", messages: [{ role: "user", uuid: "u1", text: "prefix" }] };
  mergeMessages(reused, [{ role: "user", uuid: "u1", text: "continuation" }], "codex");
  mergeMessages(reused, [{ role: "user", uuid: "u1", text: "continuation" }], "codex");
  t.ok("別実行の同じネイティブIDを分岐点として区別", reused.messages.length === 2 && reused.messages[1].uuid !== "u1");
  const largeImgMsg = [{ role: "assistant", toolCalls: [{ name: "imageGeneration", result: {
    text: JSON.stringify({ type: "imageGeneration", savedPath: "C:/images/test.png", result: "A".repeat(20000) })
  } }] }];
  mergeMessages(r, largeImgMsg, "codex");
  const parsedRes = JSON.parse(r.messages.at(-1).toolCalls[0].result.text);
  t.ok("画像生成の巨大Base64はサニタイズされる", parsedRes.result === "[image saved to C:/images/test.png]");
  const child = await promisify(execFile)(process.execPath,
    [fileURLToPath(new URL('../lib/conversations-compaction-worker.mjs', import.meta.url))], { timeout: 30000 });
  t.ok('圧縮の ID 変換・未送信・旧来会話・Claude の経路', child.stdout.includes('compaction contracts passed'));
  t.ok('ADR 0127: 隠れた会話の片付けは、ネイティブの会話を消せるときだけ記録ごと消す（一覧に戻ってこない）', child.stdout.includes('hidden delete contracts passed'), child.stdout + child.stderr);
}

// Run in a child with its own store: other suites import the store before this test runs.
export async function compactionContracts() {
  const calls = [], events = [], permissions = [];
  const boundary = [{ id: 'native-boundary', phase: 'complete' }];
  const native = { id: 'codex', capabilities: { compact: true },
    async compact(args) {
      calls.push(args);
      args.emit({ type: 'compaction', phase: 'complete' });
      args.emit({ type: 'session', sessionId: args.sessionId, first: true });
      args.emit({ type: 'compaction', sessionId: 'other-native', phase: 'start' });
      await args.askPermission({ sessionId: args.sessionId, kind: 'tool' });
      return { done: true };
    },
    async getCompactions(id) { calls.push(id); return boundary; },
  };
  const wrapped = wrapBackend(native);
  const id = await createConversation(native, {});
  const args = { sessionId: id, cwd: 'cwd', trigger: 'manual', hooksRuntime: { marker: true },
    signal: new AbortController().signal, emit: e => events.push(e), askPermission: async e => permissions.push(e) };
  assert.deepEqual(await wrapped.getCompactions(id), []);
  await assert.rejects(wrapped.compact(args), { message: translate('compaction.notStarted') });
  assert.equal(calls.length, 0, 'No native calls before the first turn');
  const entry = await conversation(id);
  entry.nativeId = 'native-thread';
  assert.notEqual(id, entry.nativeId);
  assert.deepEqual(await wrapped.compact(args), { done: true });
  assert.equal(calls[0].sessionId, 'native-thread');
  assert.equal(calls[0].hostSessionId, id);
  assert.equal(calls[0].hostBackend, wrapped);
  for (const key of ['cwd', 'trigger', 'hooksRuntime', 'signal']) assert.equal(calls[0][key], args[key]);
  assert.deepEqual(events.map(e => e.sessionId), [id, id, 'other-native']);
  assert.equal(events[1].first, false);
  assert.equal(permissions[0].sessionId, id);
  assert.deepEqual(await wrapped.getCompactions(id), boundary);
  assert.equal(calls.at(-1), 'native-thread');
  entry.nativeId = null;
  entry.messages = [{ role: 'user', text: 'inherited history' }];
  const beforeHandoff = calls.length;
  await assert.rejects(wrapped.compact(args), { message: translate('compaction.notStarted') });
  assert.deepEqual(await wrapped.getCompactions(id), []);
  assert.equal(calls.length, beforeHandoff, 'A pending handoff must not start a native thread');
  entry.backend = 'claude';
  const before = calls.length;
  await assert.rejects(wrapped.compact(args), { message: translate('conversations.backendMismatch') });
  await assert.rejects(wrapped.getCompactions(id), { message: translate('conversations.backendMismatch') });
  assert.equal(calls.length, before);
  const legacy = { ...args, sessionId: 'legacy-native' };
  await wrapped.compact(legacy);
  assert.equal(calls.at(-1), legacy, 'Legacy arguments pass through unchanged');
  assert.deepEqual(await wrapped.getCompactions('legacy-native'), boundary);
  assert.equal(calls.at(-1), 'legacy-native');

  const turns = [];
  const claude = wrapBackend({ id: 'claude', capabilities: { compact: true },
    async runTurn(args) { turns.push(args); args.emit({ type: 'session', sessionId: 'claude-native' }); },
    async getMessages() { return [{ role: 'user', text: 'hello' }]; },
    async getSession() { return { title: 'hello' }; },
    async getCompactions(id) { assert.equal(id, 'claude-native'); return boundary; },
  });
  assert.equal(claude.compact, undefined, 'Keep the runTurn fallback for Claude');
  const cid = await createConversation(claude, {});
  for (const compact of [undefined, 'manual', 'idle']) {
    await claude.runTurn({ ...args, sessionId: cid, prompt: compact ? '/compact' : 'hello', compact });
  }
  assert.deepEqual(turns.map(a => a.sessionId), [null, 'claude-native', 'claude-native']);
  assert.deepEqual(turns.map(a => a.compact), [undefined, 'manual', 'idle']);
  assert.deepEqual(await claude.getCompactions(cid), boundary);
}

// 隠れた会話（夜の整理・心拍）の片付け（ADR 0127）。ネイティブの会話を消せるときだけ host の記録ごと消す。
// host の記録だけを消すと、隠していたネイティブの会話が一覧に出てくる（wrapBackend の listSessions は記録が持つネイティブの id だけを隠す）
export async function hiddenDeleteContracts() {
  const { deleteHiddenConversation } = await import('../../core/conversations.mjs');
  const deleted = [];
  const natives = new Set(['n-old', 'n-now', 'n-user']);
  const native = { id: 'fakeish', capabilities: {},
    async listSessions() { return [...natives].map(sessionId => ({ sessionId, title: sessionId })); },
    async getSession(id) { return natives.has(id) ? { sessionId: id } : null; },
    async deleteSession(id) { deleted.push(id); natives.delete(id); },
  };
  const wrapped = wrapBackend(native);
  const id = await createConversation(native, { title: 'learner' });
  const entry = await conversation(id);
  entry.nativeId = 'n-now';
  entry.segments = [{ backend: 'fakeish', nativeId: 'n-old' }, { backend: 'fakeish', nativeId: 'n-now' }];
  const before = (await wrapped.listSessions()).map(r => r.sessionId);
  assert.ok(before.includes(id) && !before.includes('n-now') && !before.includes('n-old') && before.includes('n-user'), 'The record hides its native segments');
  assert.equal(await deleteHiddenConversation(id, () => wrapped), true);
  assert.deepEqual(deleted.sort(), ['n-now', 'n-old'], 'Every native segment is deleted');
  assert.equal(await conversation(id), null, 'The host record is gone');
  const after = (await wrapped.listSessions()).map(r => r.sessionId);
  assert.deepEqual(after, ['n-user'], 'Neither the record nor its native sessions come back in the list');

  // ネイティブの会話を消せないバックエンドなら何もしない（記録が残り、ネイティブの会話は隠れたまま）
  const keepNative = { id: 'nodelete', capabilities: {}, async listSessions() { return [{ sessionId: 'k-1' }]; }, async getSession() { return null; } };
  const keepWrapped = wrapBackend(keepNative);
  const kept = await createConversation(keepNative, { title: 'pulse' });
  Object.assign(await conversation(kept), { nativeId: 'k-1', segments: [{ backend: 'nodelete', nativeId: 'k-1' }] });
  assert.equal(await deleteHiddenConversation(kept, () => keepWrapped), false);
  assert.ok(await conversation(kept), 'The record stays');
  assert.ok(!(await keepWrapped.listSessions()).some(r => r.sessionId === 'k-1'), 'Its native session stays hidden');
  // まだ送っていない（ネイティブの会話が無い）なら、消せないバックエンドでも消す
  const unsent = await createConversation(keepNative, {});
  assert.equal(await deleteHiddenConversation(unsent, () => keepWrapped), true);
  assert.equal(await conversation(unsent), null);
}
