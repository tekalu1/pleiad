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
  t.ok('旧プロンプトの bot 会話は履歴を保持して文脈を切り替え、以後の引継ぎにも旧メモを混ぜない', child.stdout.includes('bot context contracts passed'), child.stdout + child.stderr);
  t.ok('ADR 0127: 隠れた会話の片付けは、ネイティブの会話を消せるときだけ記録ごと消す（一覧に戻ってこない）', child.stdout.includes('hidden delete contracts passed'), child.stdout + child.stderr);
  t.ok('プロンプトを渡す前に終わったターンの session id は採用を戻し、transcript の無い id の空の会話は新しく始める（本文のある会話は外さない）', child.stdout.includes('abandoned session contracts passed'), child.stdout + child.stderr);
  t.ok('transcript の無い nativeId の会話は、題・状態の変更と削除を Pleiad の記録だけで通す（別の失敗は隠さない）', child.stdout.includes('missing transcript contracts passed'), child.stdout + child.stderr);
  t.ok('ADR 0147: 送った会話の削除は Pleiad の記録だけを消し、ネイティブの会話は残したまま一覧に戻さない（再起動の後も。ネイティブだけの行も消せる）', child.stdout.includes('delete contracts passed'), child.stdout + child.stderr);
  t.ok('分岐した会話は、閉じた Chrome の窓の静止画を自分の置き場へ複製して指す（元の会話の置き場が消えても残る）', child.stdout.includes('window shot fork contracts passed'), child.stdout + child.stderr);
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

export async function botContextContracts() {
  const store = await import('../../core/store.mjs');
  const legacy = [{ role: 'user', uuid: 'old-input', text: '<pleiad-inner kind="tail">legacy-private-note</pleiad-inner>\n<pleiad-channel from="human">public-request</pleiad-channel>' },
    { role: 'assistant', uuid: 'old-answer', text: 'public-response' }];
  const histories = new Map([['old-bot-native', legacy], ['user-native', legacy]]);
  const turns = [], released = [];
  let seq = 0;
  const native = { id: 'fake',
    async getMessages(id) { return histories.get(id) ?? []; },
    async getSession() { return { title: 'Bot conversation' }; },
    async releaseConversation(id) { released.push(id); },
    async runTurn(args) {
      turns.push(args);
      const id = args.sessionId ?? `new-native-${++seq}`;
      const rows = histories.get(id) ?? [];
      rows.push({ role: 'user', uuid: `input-${turns.length}`, text: [...(args.notes ?? []), args.prompt].join('\n') }, { role: 'assistant', uuid: `answer-${turns.length}`, text: 'done' });
      histories.set(id, rows);
      args.emit({ type: 'session', sessionId: id });
      return 'ok';
    },
  };
  const wrapped = wrapBackend(native);
  const id = await createConversation(native, { title: 'Bot conversation' });
  const record = await conversation(id);
  record.nativeId = 'old-bot-native';
  record.segments.push({ backend: 'fake', nativeId: 'old-bot-native' });
  await store.setSessionData(id, 'bot', { botId: 'b_legacy', kind: 'thread', channelId: 'c_1', threadId: 'p_1', postCursor: 'p_2' }, { durable: true });
  const args = { sessionId: id, prompt: 'current-request', locale: 'en', emit() {}, askPermission: async () => ({ behavior: 'deny' }) };
  await wrapped.prepareTurn(id);
  assert.equal((await store.get(id)).bot.snapshotDue, true);
  assert.deepEqual((await store.get(id)).bot.delivered, []);
  assert.equal((await (await import('../../core/conversations.mjs')).pendingHandoff(id)), true);
  await wrapped.runTurn({ ...args, notes: ['<pleiad-turn-context>current memory</pleiad-turn-context>'] });
  assert.equal(turns[0].sessionId, null);
  assert.equal(turns[0].prompt.includes('legacy-private-note'), false);
  assert.equal(turns[0].prompt, 'current-request');
  assert.ok(turns[0].notes.join().includes('public-request') && turns[0].notes.join().includes('public-response'));
  assert.equal(turns[0].notes.join().includes('legacy-private-note'), false);
  const visible = await wrapped.getMessages(id, { fullResults: true });
  assert.ok(visible.some((m) => m.kind === 'contextNote' && m.tag === 'bot-recent'));
  assert.ok(visible.filter((m) => m.role === 'user' && !m.kind).every((m) => !m.text.includes('public-request')));
  assert.ok((await wrapped.getMessages(id, { fullResults: true })).some((m) => m.kind === 'contextNote' && m.body.includes('legacy-private-note')));
  assert.deepEqual(released, ['old-bot-native']);
  assert.equal((await store.get(id)).bot.postCursor, 'p_2');
  assert.equal((await store.get(id)).bot.workNotesVersion, 1);
  assert.equal((await store.get(id)).bot.snapshotDue, true);
  await wrapped.runTurn({ ...args, prompt: 'next-request' });
  assert.equal(turns[1].sessionId, 'new-native-1');
  assert.equal(turns[1].prompt, 'next-request');
  assert.deepEqual(released, ['old-bot-native']);
  const { closeConversations } = await import('../../core/conversations.mjs');
  await closeConversations();
  const restored = await conversation(id);
  assert.equal(restored.contextStart, 2);
  restored.base = restored.messages.length;
  restored.nativeId = null;
  await wrapped.runTurn({ ...args, prompt: 'handoff-request' });
  assert.equal(turns[2].prompt.includes('legacy-private-note'), false);
  assert.ok(turns[2].prompt.includes('next-request'));
  const fork = await wrapped.fork(id);
  const forked = await conversation(fork.sessionId);
  assert.ok(forked.contextStart > 2, 'Fork maps the raw boundary to classified visible rows');
  const beforeForkTurn = turns.length;
  await wrapped.runTurn({ ...args, sessionId: fork.sessionId, prompt: 'fork-request' });
  assert.equal(turns[beforeForkTurn].prompt.includes('legacy-private-note'), false);
  assert.equal(turns[beforeForkTurn].notes.join().includes('legacy-private-note'), false);
  assert.ok(turns[beforeForkTurn].prompt.includes('next-request'));
  const user = await createConversation(native, {});
  (await conversation(user)).nativeId = 'user-native';
  await wrapped.runTurn({ ...args, sessionId: user });
  assert.equal(turns.at(-1).sessionId, 'user-native', 'User conversations keep their execution context');
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

// 送った会話の削除（sessions.delete。ADR 0147）。Pleiad の記録（索引・本文のファイル）だけを消し、ネイティブの会話は消さない（deleteSession を呼ばない）。
// 残したネイティブの会話は、消した印（DB の deleted_natives）で一覧から隠す。再起動（接続の開き直し）の後も隠れたまま
export async function deleteContracts() {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const store = await import('../../core/store.mjs');
  const { deleteConversation, closeConversations } = await import('../../core/conversations.mjs');
  const deleted = [];
  const natives = new Set(['d-old', 'd-now', 'd-cli', 'd-other']);
  const native = { id: 'keeper', capabilities: {},
    async listSessions() { return [...natives].map(sessionId => ({ sessionId, title: sessionId })); },
    async getSession(id) { return natives.has(id) ? { sessionId: id, title: id } : null; },
    async deleteSession(id) { deleted.push(id); natives.delete(id); },
  };
  const wrapped = wrapBackend(native);
  const id = await createConversation(native, { title: 'sent' });
  Object.assign(await conversation(id), { nativeId: 'd-now', segments: [{ backend: 'keeper', nativeId: 'd-old' }, { backend: 'keeper', nativeId: 'd-now' }],
    messages: [{ role: 'user', uuid: 'u1', text: 'hello' }], _dirty: true });
  await createConversation(native, { title: 'flush' });   // 本文のファイルを書かせる（save は _dirty の会話を書く）
  const file = path.join(store.dataDir, 'conversations', `${id}.json`);
  assert.ok(await fs.stat(file).then(() => true, () => false), 'The body file exists before deleting');
  assert.equal(await deleteConversation(id), true);
  assert.deepEqual(deleted, [], 'The native conversations are not deleted');
  assert.ok(natives.has('d-old') && natives.has('d-now'), 'The native transcripts stay');
  assert.equal(await conversation(id), null, 'The host record is gone');
  assert.ok(!(await fs.stat(file).then(() => true, () => false)), 'The body file is gone');
  let listed = (await wrapped.listSessions()).map(r => r.sessionId);
  assert.ok(!listed.includes(id) && !listed.includes('d-old') && !listed.includes('d-now') && listed.includes('d-cli'), `Deleted natives do not come back: ${listed}`);
  assert.equal(await wrapped.getSession('d-now'), null, 'A deleted native id is not found by id either');
  // ネイティブだけの行（Pleiad の記録が無い。id がネイティブの id）も消せる
  assert.equal(await deleteConversation('d-cli', 'keeper'), false);
  listed = (await wrapped.listSessions()).map(r => r.sessionId);
  assert.ok(!listed.includes('d-cli') && listed.includes('d-other') && natives.has('d-cli'), `A native-only row is hidden and kept: ${listed}`);
  // 開き直し（再起動）の後も隠れたまま
  await closeConversations();
  listed = (await wrapped.listSessions()).map(r => r.sessionId);
  assert.ok(!['d-old', 'd-now', 'd-cli'].some(x => listed.includes(x)) && listed.includes('d-other'), `Still hidden after reopening: ${listed}`);
  assert.deepEqual(deleted, []);
}

// Claude Code は、プロンプトを渡す前に中断されたターンでも session_id を先に返すが、その transcript は作られない（core/conversations.mjs の runOnce）。
// 採用した id を残すと、次のターンが `No conversation found with session ID` で毎回落ちる。身代わりは transcript の有無だけを持つ
export async function abandonedSessionContracts() {
  const sessions = new Map(), calls = [];
  let seq = 0;
  const native = { id: 'claude', capabilities: {},
    async getMessages(id) { return structuredClone(sessions.get(id) ?? []); },
    async getSession(id) { return sessions.has(id) ? { sessionId: id } : null; },
    async runTurn(args) {
      calls.push({ sessionId: args.sessionId, prompt: args.prompt });
      if (args.sessionId && !sessions.has(args.sessionId)) throw new Error(`Claude Code returned an error result: No conversation found with session ID: ${args.sessionId}`);
      const id = args.sessionId ?? `claude-native-${++seq}`;
      if (!args.sessionId) args.emit({ type: 'session', sessionId: id, first: true });
      if (args.abandon) return { sessionId: id };       // プロンプトを渡す前に中断。transcript は作られない
      const rows = sessions.get(id) ?? [];
      rows.push({ role: 'user', uuid: `u${calls.length}`, text: args.prompt }, { role: 'assistant', uuid: `a${calls.length}`, text: 'done' });
      sessions.set(id, rows);
      return { sessionId: id };
    },
  };
  const wrapped = wrapBackend(native);
  const base = { emit() {}, askPermission: async () => ({ behavior: 'deny' }) };
  // server と同じく AbortController を渡す（core/server.mjs の signal: turn.ac）
  const abort = new AbortController(); abort.abort();

  // (a) 最初のターンが session id だけ出して、プロンプトを渡さずに終わる。nativeId は残らず、次のターンは resume を付けずに新規で走る
  const id = await createConversation(native, {});
  const aborted = await wrapped.runTurn({ ...base, sessionId: id, prompt: 'first', abandon: true, signal: abort });
  assert.equal(aborted.sessionId, 'claude-native-1', '中断は中断のまま返る（historyUnreadable で上書きしない）');
  const record = await conversation(id);
  assert.equal(record.nativeId, null);
  assert.deepEqual(record.segments, []);
  // 失敗で終わるターンも元のエラーのまま
  const failing = wrapBackend({ ...native, async runTurn(args) { args.emit({ type: 'session', sessionId: 'claude-native-x', first: true }); throw new Error('boom before prompt'); } });
  const failId = await createConversation(native, {});
  await assert.rejects(failing.runTurn({ ...base, sessionId: failId, prompt: 'x' }), { message: 'boom before prompt' });
  assert.equal((await conversation(failId)).nativeId, null);
  await wrapped.runTurn({ ...base, sessionId: id, prompt: 'second' });
  assert.deepEqual(calls.map(c => c.sessionId), [null, null], '次のターンは resume を付けない');
  assert.equal(record.nativeId, 'claude-native-2');
  assert.deepEqual(record.segments.map(s => s.nativeId), ['claude-native-2']);
  assert.ok(sessions.has('claude-native-2') && record.messages.some(m => m.text === 'second'));
  // ターンが成功したのに transcript が無いのは、これまでどおり historyUnreadable
  const silent = wrapBackend({ ...native, async runTurn(args) { args.emit({ type: 'session', sessionId: 'claude-native-ok', first: true }); return {}; } });
  const silentId = await createConversation(native, {});
  await assert.rejects(silent.runTurn({ ...base, sessionId: silentId, prompt: 'x' }), { message: translate('conversations.historyUnreadable') });

  // ターン前から nativeId があって transcript もある会話は、今までどおり
  calls.length = 0;
  await wrapped.runTurn({ ...base, sessionId: id, prompt: 'third' });
  assert.deepEqual(calls.map(c => c.sessionId), ['claude-native-2']);
  assert.equal(record.nativeId, 'claude-native-2');

  // (b) すでに transcript の無い nativeId を持つ空の会話は、次のターンで新規に始まる（壊れた会話の救済）
  const broken = await createConversation(native, {});
  Object.assign(await conversation(broken), { nativeId: 'ghost', segments: [{ backend: 'claude', nativeId: 'ghost' }] });
  calls.length = 0;
  await wrapped.runTurn({ ...base, sessionId: broken, prompt: 'rescue' });
  assert.deepEqual(calls.map(c => c.sessionId), [null], 'resume を付けずに新しい session で始める');
  const rescued = await conversation(broken);
  assert.equal(rescued.nativeId, 'claude-native-3');
  assert.deepEqual(rescued.segments.map(s => s.nativeId), ['claude-native-3']);
  // それでも空で終わるなら、無限に繰り返さず採用を戻す（送り直しは 1 回だけ）
  const stuck = await createConversation(native, {});
  Object.assign(await conversation(stuck), { nativeId: 'ghost-2', segments: [{ backend: 'claude', nativeId: 'ghost-2' }] });
  calls.length = 0;
  await wrapped.runTurn({ ...base, sessionId: stuck, prompt: 'again', abandon: true, signal: abort });
  assert.equal(calls.length, 1);
  assert.equal((await conversation(stuck)).nativeId, null);

  // (c) 本文のある会話の nativeId は外さない（履歴が消えたように見えるので、失敗をそのまま見せる）
  const full = await createConversation(native, {});
  Object.assign(await conversation(full), { nativeId: 'ghost-3', segments: [{ backend: 'claude', nativeId: 'ghost-3' }], messages: [{ role: 'user', uuid: 'old', text: 'kept' }] });
  calls.length = 0;
  await assert.rejects(wrapped.runTurn({ ...base, sessionId: full, prompt: 'x' }), /No conversation found with session ID: ghost-3/);
  assert.deepEqual(calls.map(c => c.sessionId), ['ghost-3']);
  assert.equal((await conversation(full)).nativeId, 'ghost-3');
  // transcript を読めなかった（例外）ときも外さない
  let reads = 0;
  const unknown = wrapBackend({ ...native, async getMessages() { if (!reads++) throw new Error('disk'); return []; } });
  const unknownId = await createConversation(native, {});
  Object.assign(await conversation(unknownId), { nativeId: 'ghost-4', segments: [{ backend: 'claude', nativeId: 'ghost-4' }] });
  calls.length = 0;
  await assert.rejects(unknown.runTurn({ ...base, sessionId: unknownId, prompt: 'x' }), /ghost-4/);
  assert.equal((await conversation(unknownId)).nativeId, 'ghost-4');
}

// transcript の無い nativeId を持つ会話の、題・状態の変更と削除（core/conversations.mjs の nativeSessionMissing）。
// SDK は transcript が無いと renameSession・tagSession・deleteSession を `Session <id> not found in any project directory` で断る。Pleiad の記録だけで通す
export async function missingTranscriptContracts() {
  const store = await import('../../core/store.mjs');
  const { deleteHiddenConversation } = await import('../../core/conversations.mjs');
  const gone = id => Object.assign(new Error(`Session ${id} not found in any project directory`), { code: 'ENOENT' });
  const calls = [];
  const native = { id: 'claude', capabilities: { title: true, tag: true },
    async setTitle(id) { calls.push(['setTitle', id]); throw gone(id); },
    async setTag(id) { calls.push(['setTag', id]); throw gone(id); },
    async deleteSession(id) { calls.push(['deleteSession', id]); throw gone(id); },
  };
  const wrapped = wrapBackend(native);
  for (const messages of [[], [{ role: 'user', uuid: 'old', text: 'kept' }]]) {
    calls.length = 0;
    const id = await createConversation(native, { title: 'old title' });
    Object.assign(await conversation(id), { nativeId: 'ghost-m', segments: [{ backend: 'claude', nativeId: 'ghost-m' }], messages });
    await wrapped.setTag(id, 'doing');
    await wrapped.setTitle(id, 'new title');
    const meta = await store.get(id);
    assert.equal(meta.status, 'doing', '状態は Pleiad の記録に残る');
    assert.equal(meta.title, 'new title', '題は Pleiad の記録に残る');
    assert.deepEqual(calls, [['setTag', 'ghost-m'], ['setTitle', 'ghost-m']], 'ネイティブへは書こうとして、断られても失敗にしない');
    assert.equal(await deleteHiddenConversation(id, () => wrapped), true, 'ネイティブに消す物が無ければ消せたとみなす');
    assert.equal(await conversation(id), null);
  }
  // 別の失敗は隠さない
  const broken = wrapBackend({ ...native, async setTag() { throw new Error('EPERM: operation not permitted'); }, async deleteSession() { throw new Error('EPERM: operation not permitted'); } });
  const id = await createConversation(native, {});
  Object.assign(await conversation(id), { nativeId: 'real', segments: [{ backend: 'claude', nativeId: 'real' }] });
  await assert.rejects(broken.setTag(id, 'x'), /EPERM/);
  await assert.rejects(deleteHiddenConversation(id, () => broken), /EPERM/);
  assert.ok(await conversation(id), '消せなかった会話は残る');
}

// 分岐した会話は、閉じた Chrome の窓の静止画を自分の置き場へ複製して指す（元の会話を消すと置き場も消えるため。core/chrome/window-shots.mjs）
export async function windowShotForkContracts() {
  const store = await import('../../core/store.mjs');
  const { windowShotFolder } = await import('../../core/chrome/window-shots.mjs');
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const native = { id: 'shots', capabilities: {},
    async getMessages() { return []; },
    async getSession() { return { title: 'window shots' }; } };
  const wrapped = wrapBackend(native);
  const id = await createConversation(native, { title: 'window shots' });
  const entry = await conversation(id);
  const folder = windowShotFolder(store.dataDir, id);
  await fs.mkdir(folder, { recursive: true });
  const file = path.join(folder, '1-aaa.png');
  await fs.writeFile(file, 'PNG-BYTES');
  entry.backend = native.id;
  entry.messages = [{ role: 'user', uuid: 'u1', text: 'open it', at: '2026-01-01T00:00:00.000Z' }, { role: 'assistant', uuid: 'a1', text: 'done', at: '2026-01-01T00:00:01.000Z' }];
  entry.base = entry.messages.length;
  entry.presents = [{ kind: 'chromeClosed', by: 'ai', at: '2026-01-01T00:00:02.000Z', path: file, chromeClosed: { by: 'agent' } },
    { kind: 'chromeClosed', by: 'ai', at: '2026-01-01T00:00:03.000Z', path: path.join(store.dataDir, 'uploads', 'chrome-window', 'elsewhere', 'x.png'), chromeClosed: { by: 'agent' } }];
  const child = (await wrapped.fork(id)).sessionId;
  const shots = (await conversation(child)).presents.filter(p => p.kind === 'chromeClosed');
  const mine = windowShotFolder(store.dataDir, child);
  assert.equal(path.dirname(shots[0].path), mine, '分岐した会話の置き場を指す');
  assert.equal(await fs.readFile(shots[0].path, 'utf8'), 'PNG-BYTES', '中身を複製する');
  assert.equal(await fs.readFile(file, 'utf8'), 'PNG-BYTES', '元の画像は残る');
  assert.equal(shots[1].path, null, '元の置き場の外のパスは複製せず、指さない');
  // 元の会話の置き場を消しても、分岐した会話の画像は残る
  await fs.rm(folder, { recursive: true, force: true });
  assert.equal(await fs.readFile(shots[0].path, 'utf8'), 'PNG-BYTES');
}
