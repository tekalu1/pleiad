// Host-owned conversations. Native sessions remain execution segments, never portable IDs.
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import * as store from "./store.mjs";
import { MAX_RESULT_CHARS } from "./backends/shared.mjs";
import { readPresents, keepPresents } from "./history.mjs";
import { applyRewindMark, markIsLive, nativeUuid, keptPresentIndexes, removedSummary } from "./rewind.mjs";
import { buildItems } from "../web/timeline.mjs";
import { t, agentT } from "./i18n.mjs";
import { writeAtomic } from "./atomic-file.mjs";
import { openData } from "./data-schema.mjs";
import { conversationTable, deletedNativeTable } from "./db.mjs";
import { classifySystemMessages, BOT_RECENT_TAG } from "./system-messages.mjs";
import { promptTitle } from "./prompt-title.mjs";
import { WORK_NOTES_VERSION } from "./brain/inner.mjs";
import { readWithRetry, transientStorageError } from "./history-retry.mjs";

// 会話の索引（本文を除いたメタ情報）は SQLite の conversations（1 会話 1 行。core/db.mjs、ADR 0115）、本文は
// conversations/<id>.json（会話ごとに 1 ファイル）。索引は変えた会話の行だけを書く。本文はまだ変更のたびに 1 会話分を丸ごと書く
// （会話の長さに比例する。tests/unit/data-writes.mjs の許可リストに既知の例外として載せている）
const convDir = path.join(store.dataDir, "conversations");
let records;
let loading;
let table = null;
let handle = null;
let writes = Promise.resolve();
const indexSaved = new Map();   // 索引に最後に書けた JSON（id -> 文字列）。変わった会話だけを書くための比べ元
// 消した会話（deleteConversation）が持っていたネイティブの id。backend -> Set<nativeId>。一覧から隠す（ADR 0147）
const deletedNatives = new Map();
let deletedTable = null;
const isDeletedNative = (backend, nativeId) => Boolean(deletedNatives.get(backend)?.has(nativeId));
const indexOf = ({ messages, presents, _dirty, ...meta }) => JSON.stringify(meta);

/** 引き継ぎの文（HISTORY）が指す、履歴の写しのファイル（会話ごとに 1 つ。次の引き継ぎで書き直す） */
const handoffPath = id => path.join(store.dataDir, `handoff-${crypto.createHash("sha256").update(id).digest("hex")}.json`);

function sessionFilePath(id) {
  const safe = String(id).replace(/[^A-Za-z0-9._-]/g, "_");
  return path.join(convDir, `${safe}.json`);
}

function sanitizeToolResult(result) {
  if (!result || typeof result.text !== "string") return;
  if (result.text.length > 10000 && result.text.includes('"imageGeneration"')) {
    try {
      const parsed = JSON.parse(result.text);
      if (parsed.type === "imageGeneration" && parsed.savedPath && typeof parsed.result === "string" && parsed.result.length > 1000) {
        parsed.result = `[image saved to ${parsed.savedPath}]`;
        result.text = JSON.stringify(parsed);
      }
    } catch {}
  }
}

async function loadSessionFile(id, record) {
  if (Array.isArray(record.messages)) return;
  try {
    const raw = await fs.readFile(sessionFilePath(id), "utf8");
    const data = JSON.parse(raw);
    record.messages = Array.isArray(data.messages) ? data.messages : [];
    if (Array.isArray(data.presents)) record.presents = data.presents;
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
    record.messages = [];
  }
}

async function all() {
  loading ??= (async () => {
    handle = openData(store.dataDir);
    table = conversationTable(handle.db);
    records = {};
    for (const [id, json] of table.loadRows()) { records[id] = JSON.parse(json); indexSaved.set(id, json); }
    deletedTable = deletedNativeTable(handle.db);
    for (const [backend, nativeId] of deletedTable.loadAll()) noteDeleted(backend, nativeId);
    // 既存データのマイグレーション（旧 conversations.json に messages がある場合、個別ファイルへ切り離す）
    let needsMigration = false;
    for (const r of Object.values(records)) {
      if (Array.isArray(r?.messages)) { needsMigration = true; break; }
    }
    if (needsMigration) {
      await fs.mkdir(convDir, { recursive: true });
      const upserts = [];
      for (const [id, r] of Object.entries(records)) {
        const { messages = [], presents, ...meta } = r;
        for (const m of messages) {
          for (const c of m.toolCalls ?? []) if (c.result) sanitizeToolResult(c.result);
        }
        const payload = { messages, ...(presents ? { presents } : {}) };
        await writeAtomic(sessionFilePath(id), JSON.stringify(payload));
        upserts.push([id, JSON.stringify(meta)]);
        records[id] = meta;
      }
      table.save(upserts);
      for (const [id, json] of upserts) indexSaved.set(id, json);
    }
    return records;
  })();
  return loading;
}

async function save(additions = {}) {
  const next = writes.then(async () => {
    const entries = await all();
    Object.assign(entries, additions);
    await fs.mkdir(convDir, { recursive: true });
    const targetIds = new Set(Object.keys(additions));
    const upserts = [];
    for (const [id, r] of Object.entries(entries)) {
      if (r._dirty || targetIds.has(id)) {
        const payload = {
          messages: r.messages ?? [],
          ...(r.presents ? { presents: r.presents } : {}),
        };
        // 一意な一時ファイル＋一時的に開けないときだけ rename をやり直す（core/atomic-file.mjs）
        await writeAtomic(sessionFilePath(id), JSON.stringify(payload));
        r._dirty = false;
        const json = indexOf(r);
        if (indexSaved.get(id) !== json) upserts.push([id, json]);
      }
    }
    const removals = [...indexSaved.keys()].filter(id => !Object.hasOwn(entries, id));
    if (upserts.length || removals.length) {
      try { table.save(upserts, removals); }
      catch (e) {
        // 索引に書けなかった会話は、次の保存で本文と索引をもう一度書く
        for (const [id] of upserts) if (entries[id]) entries[id]._dirty = true;
        throw e;
      }
      for (const [id, json] of upserts) indexSaved.set(id, json);
      for (const id of removals) indexSaved.delete(id);
    }
  });
  writes = next.catch(() => {});
  return next;
}

/** DB の接続を離す（データ置き場を消す前。テストの後片付け用）。書き込み中の保存を待ってから離す。以後に呼べば開き直す */
export async function closeConversations() {
  await writes;
  handle?.release();
  handle = null; table = null; loading = undefined; records = undefined;
  indexSaved.clear();
  deletedTable = null; deletedNatives.clear();
}

/**
 * Pleiad が持つ会話の保存分の発言を、記録に載せずに読む（セッション検索の最初の読み込み用）。
 * conversation() は読んだ発言を記録に持ち続けるので、全会話を読むと本文が二重にメモリへ載る。
 * ネイティブの末尾は足さない。Pleiad が持つ会話でなければ null。
 */
export async function readStoredMessages(id) {
  const r = (await all())[id];
  if (!r) return null;
  if (Array.isArray(r.messages)) return r.messages;
  try {
    const data = JSON.parse(await fs.readFile(sessionFilePath(id), "utf8"));
    return Array.isArray(data.messages) ? data.messages : [];
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
    return [];
  }
}

export async function conversation(id) {
  const entries = await all();
  if (!Object.hasOwn(entries, id)) return null;
  const r = entries[id];
  await loadSessionFile(id, r);
  return r;
}

/**
 * 次のターンで、これまでの履歴を引き継ぎの文（HISTORY）として渡し直すか。バックエンドの切り替え直後と、
 * ホスト側で履歴を写した分岐の最初のターンがそう（下の runTurn）。相手に届くのは写しの JSON で、長ければ一部だけになり、
 * 元のツールの返りがそのまま手元に残るとは限らない（core/server.mjs が渡し済みの控えを捨てるのに使う）
 */
export async function pendingHandoff(id) {
  const r = id ? await conversation(id) : null;
  return Boolean(r && !r.nativeId && r.messages.length);
}

export async function conversationBackend(id) {
  const entries = await all();
  return entries[id]?.backend;
}

export async function createConversation(backend, info) {
  const id = crypto.randomUUID();
  (await all())[id] = { backend: backend.id, nativeId: null, base: 0, messages: [], segments: [], info, _dirty: true };
  try { await save(); } catch (e) { delete records[id]; throw e; }
  return id;
}

export async function deleteUnsentConversation(id) {
  const r = await conversation(id);
  if (!r) return; // A previous attempt may have saved this file before the sidecar failed.
  if (r.nativeId || r.messages.length) throw new Error(t("conversations.deleteSent"));
  delete records[id];
  try {
    await save();
    await fs.rm(sessionFilePath(id), { force: true }).catch(() => {});
  } catch (e) {
    records[id] = r;
    throw e;
  }
}

function noteDeleted(backend, nativeId) {
  if (!deletedNatives.has(backend)) deletedNatives.set(backend, new Set());
  deletedNatives.get(backend).add(nativeId);
}

/** 会話が持つネイティブの会話（今のものと、エージェントの切り替え・巻き戻しの前の区間）。[[nativeId, backendId]] */
function nativesOf(r) {
  const natives = new Map(r.segments.map(s => [s.nativeId, s.backend]));
  if (r.nativeId) natives.set(r.nativeId, r.backend);
  natives.delete(null); natives.delete(undefined);
  return natives;
}

/**
 * 会話を Pleiad の記録から消す（sessions.delete。送った会話も。ADR 0147）。消したら true、記録が無ければ false。
 * ネイティブの会話（Claude の transcript・Codex の rollout・Antigravity の控え）は消さない（claude --resume・使用量の調査から見えるように）。
 * 残したネイティブの会話が一覧にネイティブだけの行として戻らないよう、持っていたネイティブの id を DB（deleted_natives）に覚えて隠す。
 * Pleiad の記録を持たない会話（ネイティブだけの行。id がネイティブの id）は、nativeBackend（その行のエージェント）で隠す。
 * sidecar（store）と、会話に付いたほかの記録は呼び出し側が消す（core/server.mjs の deleteSessionOf）
 */
export async function deleteConversation(id, nativeBackend = null) {
  const entries = await all();
  const r = entries[id];
  const natives = r ? nativesOf(r) : new Map(nativeBackend ? [[id, nativeBackend]] : []);
  // DB を先に。書けなければ投げて、メモリも会話の記録も変えない
  const rows = [...natives].map(([nativeId, backend]) => [backend, nativeId]);
  if (rows.length) {
    deletedTable.add(rows, id);
    for (const [backend, nativeId] of rows) noteDeleted(backend, nativeId);
  }
  if (!r) return false;
  delete records[id];
  try {
    await save();
    await fs.rm(sessionFilePath(id), { force: true }).catch(() => {});
    await fs.rm(handoffPath(id), { force: true }).catch(() => {});
  } catch (e) {
    records[id] = r;
    throw e;
  }
  return true;
}

/**
 * ネイティブ側に transcript が無くて、会話そのものを読み書き・削除できなかった失敗か。
 * Claude の SDK（@anthropic-ai/claude-agent-sdk 0.3.288）は `~/.claude/projects` 配下の `<id>.jsonl` が無いか 0 バイトのとき、
 * renameSession・tagSession・deleteSession が `Session <id> not found in any project directory`（dir 指定時は `... not found in project directory for <dir>`）を投げる（2026-10-06）。
 * 失敗の種類を示す印が文面しか無いので、ここだけ文面に頼る。ネイティブに書く物が無いだけなので、Pleiad 側の記録（題・状態・会話）は通してよい
 */
function nativeSessionMissing(e) {
  return /not found in (?:any )?project directory/.test(String(e?.message ?? e));
}
async function tolerateMissing(call) {
  try { await call(); } catch (e) { if (!nativeSessionMissing(e)) throw e; }
}

/**
 * 人に見せない隠れた会話（夜の整理・心拍。ADR 0127）を、ネイティブの会話ごと消す。消したら true。
 * ネイティブの会話を消せないバックエンド（deleteSession を持たない）なら何もせず false。host の記録だけを消すと、
 * 隠していたネイティブの会話が一覧に出てくる（wrapBackend の listSessions は、host の記録が持つネイティブの id だけを隠す）。
 * backendOf(id) はバックエンドの id から、deleteSession を持つバックエンドを返す。sidecar（store）は呼び出し側が消す
 */
export async function deleteHiddenConversation(id, backendOf) {
  const r = await conversation(id);
  if (!r) return false;
  const natives = nativesOf(r);
  for (const backendId of natives.values()) if (typeof backendOf(backendId)?.deleteSession !== "function") return false;
  // transcript の無いネイティブの会話は、消す物が無いので消せたとみなす（nativeSessionMissing）
  for (const [nativeId, backendId] of natives) await tolerateMissing(() => backendOf(backendId).deleteSession(nativeId));
  delete records[id];
  try {
    await save();
    await fs.rm(sessionFilePath(id), { force: true }).catch(() => {});
  } catch (e) {
    records[id] = r;
    throw e;
  }
  return true;
}

// Preserve messages the native engine has compacted away; refresh matching messages in place.
export function mergeMessages(record, recent, backend) {
  record._dirty = true;
  const segment = record.messages.slice(record.base);
  const used = new Set();
  for (const raw of recent) {
    const m = { ...raw, backend };
    if (Array.isArray(m.toolCalls)) {
      for (const call of m.toolCalls) {
        if (call?.result) sanitizeToolResult(call.result);
      }
    }
    // Native engines may reuse item IDs in a new execution segment.
    if (m.uuid && record.nativeId) m.uuid = `${backend}:${record.nativeId}:${m.uuid}`;
    if (m.role === "user" && m.text === record.injected) m.text = record.original;
    const at = segment.findIndex((old, index) => !used.has(index) && (m.uuid ? old.uuid === m.uuid || old.uuid === raw.uuid :
      !old.uuid && old.role === m.role && old.text === m.text));
    if (at < 0) { segment.push(m); used.add(segment.length - 1); }
    else { m.uuid = segment[at].uuid; segment[at] = m; used.add(at); }
  }
  record.messages = [...record.messages.slice(0, record.base), ...segment];
}

export async function switchBackend(id, source, target) {
  const existing = await conversation(id);
  if ((existing?.backend ?? source.id) === target.id) return;
  const nativeInfo = await source.getSession(id);
  if (!nativeInfo) throw new Error(t("conversations.switchUnreadable"));
  const meta = await store.get(id);
  const info = { ...nativeInfo, cwd: meta.cwd ?? nativeInfo.cwd,
    title: source.capabilities?.title ? nativeInfo.title ?? meta.title : meta.title ?? nativeInfo.title,
    tag: source.capabilities?.tag ? nativeInfo.tag : meta.status };
  const messages = await source.getMessages(id, { fullResults: true });
  for (const m of messages) m.backend ??= source.id;
  if (!messages.length && !existing) throw new Error(t("conversations.switchEmpty"));
  const entry = structuredClone(existing ?? { segments: [{ backend: source.id, nativeId: id }], messages, info });
  entry.messages = messages;
  entry.backend = target.id;
  entry.nativeId = null;
  entry.base = messages.length;
  entry._dirty = true;
  (await all())[id] = entry;
  try { await save(); } catch (e) { if (existing) records[id] = existing; else delete records[id]; throw e; }
  await store.setMeta(id, { backend: target.id, title: info.title, cwd: info.cwd });
  await store.setModel(id, "");
  await store.setSessionData(id, "effort", "");
  await store.setMode(id, Object.keys(target.modes())[0] ?? "default");
}

function hostEvent(event, id, nativeId) {
  return { ...event,
    ...(event.sessionId === undefined || event.sessionId === nativeId ? { sessionId: id } : {}),
    ...(event.type === 'session' ? { first: false } : {}),
  };
}

export function wrapBackend(native) {
  const wrapped = { ...native, capabilities: { ...native.capabilities, fork: true, forkMessage: true } };
  wrapped.getPresents = async id => [
    ...structuredClone((await conversation(id))?.presents ?? []), ...await readPresents(id, { strict: true }),
  ];
  wrapped.listSessions = async (args) => {
    const entries = Object.entries(await all());
    const hidden = new Set(entries.flatMap(([id, r]) => [id, ...r.segments.filter(s => s.backend === native.id).map(s => s.nativeId)]));
    // 消した会話のネイティブの会話（残してある）も出さない（ADR 0147）
    const rows = (await native.listSessions(args)).filter(s => !hidden.has(s.sessionId) && !isDeletedNative(native.id, s.sessionId));
    for (const [id, r] of entries) if (r.backend === native.id) rows.push(await wrapped.getSession(id));
    return rows;
  };
  wrapped.getSession = async (id) => {
    const entries = await all();
    const r = entries[id];
    if (!r) return isDeletedNative(native.id, id) ? null : native.getSession(id);
    if (r.backend !== native.id) return null;
    const meta = await store.get(id);
    return { ...r.info, ...meta, sessionId: id, tag: Object.hasOwn(meta, "status") ? meta.status : r.info.tag };
  };
  // 保留の巻き戻し（core/rewind.mjs。Claude は次のターンまで JSONL が動かない）。今のネイティブの会話のものだけ
  const pendingMark = async (id, nativeId) => {
    const mark = nativeId ? (await store.get(id)).rewind : null;
    return mark && mark.backend === native.id && mark.nativeId === nativeId ? mark : null;
  };
  // 保留の巻き戻しのうち、捨てる発言がまだ鎖に残っている（次のターンで resumeSessionAt を渡すべき）もの。鎖から消えていれば印を捨てる
  const liveRewindMark = async (id, nativeId) => {
    const mark = await pendingMark(id, nativeId);
    if (!mark) return null;
    const messages = await native.getMessages(nativeId, { fullResults: true }).catch(() => []);
    if (markIsLive(messages, mark)) return mark;
    await store.setSessionData(id, "rewind", null, { durable: true }).catch(() => {});
    return null;
  };
  wrapped.getMessages = async (id, options) => {
    const r = await conversation(id);
    if (!r) return applyRewindMark(await native.getMessages(id, options), await pendingMark(id, id));
    if (r.nativeId) {
      const recent = applyRewindMark(await native.getMessages(r.nativeId, { fullResults: true }), await pendingMark(id, r.nativeId));
      if (recent.length) {
        mergeMessages(r, recent, native.id);
      }
    }
    // 保存分には、見分けを足す前に保存したシステム側の行（圧縮の要約・コマンドの行・中断など）が生のまま残っている。
    // 読むたびに文面で見分ける（core/system-messages.mjs。kind の付いた発言は触らない）
    const messages = classifySystemMessages(structuredClone(r.messages));
    if (!options?.fullResults) for (const m of messages) for (const call of m.toolCalls ?? []) {
      if (call.result?.text?.length > MAX_RESULT_CHARS) {
        call.result.text = call.result.text.slice(0, MAX_RESULT_CHARS) + t("conversations.truncated");
        call.result.truncated = true;
      }
    }
    return messages;
  };
  // 入力欄の `!` をエージェントが走らせるバックエンド（Codex）。会話の id をネイティブの id に訳す。
  // ネイティブの会話がまだ無い（最初の発言の前・切り替えた直後）ときは走らせられない（shellReady が false）
  if (native.shell) {
    wrapped.shellReady = async id => { const r = await conversation(id); return r ? r.backend === native.id && Boolean(r.nativeId) : true; };
    wrapped.shell = async args => {
      const r = args.sessionId && await conversation(args.sessionId);
      if (!r) return native.shell(args);
      if (r.backend !== native.id) throw new Error(t('conversations.backendMismatch'));
      if (!r.nativeId) throw new Error(t('shell.notStarted'));
      return native.shell({ ...args, sessionId: r.nativeId });
    };
  }
  if (native.getCompactions) wrapped.getCompactions = async id => {
    const r = await conversation(id);
    if (!r) return native.getCompactions(id);
    if (r.backend !== native.id) throw new Error(t('conversations.backendMismatch'));
    return r.nativeId ? native.getCompactions(r.nativeId) : [];
  };
  if (native.compact) wrapped.compact = async args => {
    const id = args.sessionId;
    const r = id && await conversation(id);
    if (!r) return native.compact(args);
    if (r.backend !== native.id) throw new Error(t('conversations.backendMismatch'));
    if (!r.nativeId) throw new Error(t('compaction.notStarted'));
    return native.compact({ ...args, sessionId: r.nativeId, hostSessionId: id, hostBackend: wrapped,
      askPermission: req => args.askPermission({ ...req, sessionId: id }),
      emit: event => args.emit(hostEvent(event, id, r.nativeId)),
    });
  };
  for (const [method, field] of [["setTitle", "title"], ["setTag", "status"]]) {
    if (native[method]) wrapped[method] = async (id, value) => {
      const entries = await all();
      const r = entries[id];
      if (!r) return native[method](id, value);
      await store.setMeta(id, { [field]: value });
      // Pleiad 側の記録（上の setMeta）は書けている。transcript の無いネイティブの会話には書く物が無いので、その失敗は見せない（nativeSessionMissing）
      if (r.nativeId) await tolerateMissing(() => native[method](r.nativeId, value));
    };
  }
  for (const method of ["listSubagents", "getSubagentMessages", "getSubagentOrigin", "getSubagentState"]) {
    if (native[method]) wrapped[method] = async (id, ...args) => {
      const entries = await all();
      const r = entries[id];
      if (r && !r.nativeId) return method === "getSubagentOrigin" || method === "getSubagentState" ? null : [];
      return native[method](r?.nativeId ?? id, ...args);
    };
  }
  wrapped.fork = async (id, options = {}) => {
    const r = await conversation(id);
    const before = options.beforeMessageId;
    if (before !== undefined && (typeof before !== 'string' || !before || options.upToMessageId !== undefined)) {
      throw new Error(t('conversations.forkPointAmbiguous'));
    }
    // Claude supports exact message boundaries; Codex only supports whole turns.
    if (before === undefined && !options.snapshot && !r && native.fork && native.capabilities?.forkMessage) {
      const result = await native.fork(id, options);
      await store.inheritSettings(id, result.sessionId);
      return result;
    }
    const source = await wrapped.getSession(id);
    if (!source) throw new Error(t("conversations.forkSourceUnreadable"));
    const meta = await store.get(id);
    const child = crypto.randomUUID();
    const allMessages = structuredClone(await wrapped.getMessages(id, { fullResults: true }));
    if (!allMessages.length) throw new Error(t("conversations.forkEmpty"));
    let messages = allMessages;
    let presents = await wrapped.getPresents(id);
    let beforeAt = before === undefined ? -1 : messages.findIndex(m => m.uuid === before);
    if (before !== undefined && beforeAt < 0) throw new Error(options.snapshot
      ? t('conversations.messageNotSaved')
      : t('conversations.forkMessageNotFound'));
    // bot の会話は 1 つの発言を記憶・文脈・包みの行に分けて持つ（core/system-messages.mjs の groupUuid）。
    // 発言の手前で切るときは、そのまとまりの先頭で切る（分けた兄弟の行を、切り口の前に残さない）
    const group = beforeAt > 0 ? messages[beforeAt].groupUuid : null;
    if (group) beforeAt = Math.max(0, messages.findIndex(m => m.groupUuid === group));
    const cutId = before === undefined ? options.upToMessageId : messages[beforeAt - 1]?.uuid;
    const boundary = cutId ?? messages.at(-1)?.uuid;
    // A live turn may already have published attachments while its messages are
    // not persisted yet. They do not belong to a fork of the pre-turn history.
    if (options.snapshot?.messageIds?.includes(boundary)) presents = structuredClone(options.snapshot.presents);
    if (beforeAt === 0) {
      messages = [];
      presents = [];
    } else if (before !== undefined || cutId) {
      const at = before !== undefined ? beforeAt - 1 : messages.findIndex(m => m.uuid === cutId);
      if (at < 0) throw new Error(options.snapshot
        ? t("conversations.messageNotSavedFork")
        : t("conversations.forkMessageNotFound"));
      if (at < messages.length - 1) for (const p of presents) {
        if (p.by === "ai" && (!p.at || !messages[at].at)) {
          throw new Error(t("conversations.presentNoTime"));
        }
      }
      // Use the same attachment placement as the UI, including attachments emitted after their user message.
      const items = buildItems(messages, presents);
      const end = items.findIndex(item => item.kind === "msg" && item.mi === at);
      if (at < messages.length - 1) presents = items.filter((item, i) => item.kind === "present" &&
        (i < end || item.anchorMi === at)).map(item => item.p);
      messages = messages.slice(0, at + 1);
    }
    if (options.snapshot) {
      // A pending tool is not a completed historical result.
      if (messages.some(m => m.toolCalls?.some(call => !call.result))) {
        throw new Error(t("conversations.toolRunning"));
      }
    }
    const now = Date.now();
    const parent = { sessionId: id, atMessage: cutId ?? null,
      ...(before !== undefined ? { beforeMessage: before } : {}) };
    const info = { ...source, sessionId: child, backend: native.id, parent,
      title: options.title ?? (native.capabilities?.title ? source.title ?? meta.title : meta.title ?? source.title),
      tag: native.capabilities?.tag ? source.tag : meta.status ?? source.tag,
      cwd: meta.cwd ?? source.cwd, createdAt: now, lastModified: now };
    // One atomic record owns the ID, lineage, metadata, complete messages and attachments.
    // Publish only after persistence succeeds: a failed fork cannot appear in the list.
    try {
      await store.inheritSettings(id, child);
      await save({ [child]: { backend: native.id, nativeId: null, base: messages.length,
        messages: structuredClone(messages), presents: structuredClone(presents), segments: [], info,
        ...(r?.contextStart ? { contextStart: Math.min(classifySystemMessages(r.messages.slice(0, r.contextStart)).length, messages.length), contextSince: r.contextSince } : {}), _dirty: true } });
    } catch (error) {
      delete (await all())[child];
      await fs.rm(sessionFilePath(child), { force: true }).catch(() => {});
      await store.removeSession(child);
      throw error;
    }
    return { sessionId: child, parent, persisted: true };
  };
  /**
   * 巻き戻せるかの検証と、切り口・方式の決定（何も変えない）。wrapped.rewind がこれを通ってから書き換える。
   * server は、走っているターンを止める・委譲の子を取り消すより前に wrapped.rewindPlan で断られるかを確かめる（止めてから断られると戻せない）。
   * 断る: 起点が見つからない・同じ id の発言が複数ある（どれか決められない）・自分の発言でない・AI の提示に時刻が無く境界を決められない
   */
  async function planRewind(id, beforeMessageId) {
    if (typeof beforeMessageId !== "string" || !beforeMessageId) throw new Error(t("conversations.rewindMessageNotFound"));
    const existing = await conversation(id);
    if (existing && existing.backend !== native.id) throw new Error(t("conversations.backendMismatch"));
    const full = await wrapped.getMessages(id, { fullResults: true });
    let at = full.findIndex(m => m.uuid === beforeMessageId);
    if (at < 0) throw new Error(t("conversations.rewindMessageNotFound"));
    // ネイティブが item id を使い回すと、どの発言か決められない（最初に当たった発言で切ると、残すべき履歴まで消える）
    if (full.some((m, i) => i !== at && m.uuid === beforeMessageId)) throw new Error(t("conversations.rewindAmbiguous"));
    const target = full[at];
    // bot の会話の、包みだけのまとまり（最後の行がチャンネルの出来事）も自分の発言として扱う（スレッドの送り直し。ADR 9101）
    if ((target.role !== "user" || target.kind) && target.kind !== "channelEvent") throw new Error(t("conversations.rewindNotUser"));
    // 1 つの発言から分けた行（中断の文・記憶・文脈・包み）は、まとまりの先頭で切る。ネイティブの切り口は元の発言の uuid
    const group = target.groupUuid ?? null;
    if (group) at = Math.max(0, full.findIndex(m => m.groupUuid === group));
    const presents = await wrapped.getPresents(id);
    const keep = keptPresentIndexes(full, presents, at - 1);
    const nativeId = existing ? existing.nativeId : id;
    const rawOf = uuid => (existing ? nativeUuid(uuid, native.id, nativeId) : uuid);
    const rawTarget = rawOf(group ?? target.uuid), rawBefore = at > 0 ? rawOf(full[at - 1].groupUuid ?? full[at - 1].uuid) : null;
    const how = native.capabilities?.rewind;
    // Claude の切り口は「残す最後の発言」の uuid。ツール呼びだけの発言は連続するエントリを 1 つに束ねて先頭の uuid を持つので、
    // その後ろが落ちて中途半端な枝から続く。本文のある返答が切り口のときだけ使う（ほかはホスト管理）
    const before = at > 0 ? full[at - 1] : null;
    const cutable = how !== "resumeAt" || Boolean(before?.role === "assistant" && String(before.text ?? "").trim());
    const inSegment = Boolean(nativeId) && at > (existing ? existing.base : 0) && Boolean(rawTarget) && Boolean(rawBefore) && cutable;
    return { existing, full, at, target, keep, nativeId, rawTarget, rawBefore, how, inSegment, removed: removedSummary(full, at), since: Date.parse(target.at ?? "") };
  }
  wrapped.rewindPlan = async (id, { beforeMessageId } = {}) => {
    const { removed, since, inSegment, how } = await planRewind(id, beforeMessageId);
    return { removed, since, mode: inSegment ? (how === "thread" ? "thread" : "resume") : "host" };
  };

  /**
   * 会話を、ある発言（beforeMessageId。自分の発言）の手前まで巻き戻す。会話の id は変わらない（ADR 0102）。
   * 方式はバックエンドで違う（capabilities.rewind）:
   *   resumeAt … Claude。次のターンが resume + resumeSessionAt + resumeDropsTurn で葉を付け替える。それまでの間は保留の印（sidecar の rewind）で
   *              履歴を見かけ上切る
   *   thread   … Codex。今すぐスレッドの履歴を置き換える（thread/revert。legacy のスレッドは thread/fork { beforeTurnId } で別スレッドに差し替える）
   *   無し     … Antigravity。Pleiad の履歴を切り、次のターンで引き継ぐ（ホスト管理）
   * 最初の発言・今のネイティブの区間の外の発言・ネイティブが断ったときも、ホスト管理（nativeId = null + 引き継ぎ）に落とす。
   * 書き込みは、落ちても残すほうに倒れる順（記録の写しを先に切って保存 → 提示 → 保留の印）。途中で落ちたら記録を元に戻して投げる。
   * 返り値 { mode: "resume" | "thread" | "host", renumbered, removed: { messages, userMessages, replies } }。
   * renumbered は残る発言の uuid が変わったか（Codex が別スレッドに差し替えたとき。画面は読み直す）
   */
  wrapped.rewind = async (id, { beforeMessageId } = {}) => {
    const { existing, full, at, keep, nativeId, rawTarget, rawBefore, how, inSegment, removed } = await planRewind(id, beforeMessageId);
    // 提示（記録に写した分と、sidecar の JSONL の分）。記録の分が先頭、続けて JSONL の並び（getPresents と同じ）
    const copied = existing?.presents?.length ?? 0;
    const keptCopied = (existing?.presents ?? []).filter((_, i) => keep.has(i));
    const keepFile = () => keepPresents(id, new Set([...keep].filter(i => i >= copied).map(i => i - copied)));
    let mode = null, renumbered = false, changedNativeId = null;
    if (inSegment && how === "thread") {
      try {
        const result = await native.rewind(nativeId, { beforeMessageId: rawTarget });
        mode = "thread";
        if (result?.sessionId && result.sessionId !== nativeId) { changedNativeId = result.sessionId; renumbered = true; }
      } catch (error) {
        console.error(`  rewind: ${native.id} のスレッドを巻き戻せないのでホスト管理に落とす:`, String(error?.message ?? error).slice(0, 200));
      }
    } else if (inSegment && how === "resumeAt") mode = "resume";
    if (!mode) {
      await becomeHostManaged(id, existing, full.slice(0, at), keptCopied, { firstMessage: at === 0 });
      await keepFile();
      return { mode: "host", renumbered, removed };
    }
    // ネイティブ（Codex）はもう切れている。記録は切った形をメモリに持ち、保存に失敗しても次の保存が直す（_dirty）
    const snapshot = existing && mode === "resume" ? structuredClone({ messages: existing.messages, presents: existing.presents, nativeId: existing.nativeId, base: existing.base, segments: existing.segments }) : null;
    try {
      if (existing) {
        existing.messages = existing.messages.slice(0, existing.messages.findIndex(m => m.uuid === beforeMessageId));
        existing.presents = keptCopied;
        if (changedNativeId) {
          // 差し替えた先のスレッドは、残す分の履歴を丸ごと持つ。今の区間の写しは捨て、読むたびに差し替え先から取り込む
          existing.messages = existing.messages.slice(0, existing.base);
          existing.nativeId = changedNativeId;
          existing.segments.push({ backend: native.id, nativeId: changedNativeId });
        }
        existing._dirty = true;
        await save();
      } else if (changedNativeId) {
        const info = await rewoundInfo(id, false);
        (await all())[id] = { backend: native.id, nativeId: changedNativeId, base: 0, messages: [], segments: [
          { backend: native.id, nativeId: id }, { backend: native.id, nativeId: changedNativeId }], info, _dirty: true };
        try { await save(); } catch (e) { delete records[id]; throw e; }
      }
      await keepFile();
      // 保留の印は最後（先に置くと、記録の写しが切れていない間は捨てた発言が表示に残って次のターンの後ろへ足される）
      if (mode === "resume") await store.setSessionData(id, "rewind", { backend: native.id, nativeId, at: rawBefore, drops: rawTarget }, { durable: true });
    } catch (error) {
      if (snapshot) {
        Object.assign(existing, snapshot, { _dirty: true });
        await save().catch(() => {});
      }
      throw error;
    }
    return { mode, renumbered, removed };
  };

  /** ネイティブだけの会話の、一覧に出す情報（switchBackend と同じ作り）。titleReset なら題を空にする */
  async function rewoundInfo(id, titleReset) {
    const nativeInfo = (await native.getSession(id)) ?? {};
    const meta = await store.get(id);
    const info = { ...nativeInfo, cwd: meta.cwd ?? nativeInfo.cwd,
      title: native.capabilities?.title ? nativeInfo.title ?? meta.title : meta.title ?? nativeInfo.title,
      tag: native.capabilities?.tag ? nativeInfo.tag : meta.status };
    if (titleReset) info.title = null;
    return info;
  }

  /**
   * ホスト管理に変える: 履歴を切って、nativeId = null にする（次のターンが引き継ぎで新しいネイティブの会話を起こす）。
   * 会話の id は変えない。ネイティブだけだった会話は、同じ id の記録を作る（switchBackend と同じ。元のネイティブの id は一覧から隠れる）。
   * 巻き戻しの拒否・失敗で落ちてきた会話（resumeDropsTurn）は、すでに切ってある履歴のまま呼ぶ。
   * 保存に失敗したら、メモリの記録は元のまま（作り替えは複製の上で行う）
   */
  async function becomeHostManaged(id, existing, messages, presents, { firstMessage = false } = {}) {
    const meta = await store.get(id);
    // 最初の発言をやり直したときは、その発言から付いた題を付け直す（人が付けた題は残す）
    const humanTitle = (meta.history ?? []).some(h => h.field === "title" && h.by === "human");
    const titleReset = firstMessage && !humanTitle;
    const nativeId = existing ? existing.nativeId : id;
    const entry = existing ? structuredClone(existing) : { backend: native.id, segments: [{ backend: native.id, nativeId: id }], info: await rewoundInfo(id, titleReset) };
    if (existing?.contextStart) entry.contextStart = Math.min(classifySystemMessages(existing.messages.slice(0, existing.contextStart)).length, messages.length);
    entry.messages = structuredClone(messages);
    entry.presents = structuredClone(presents);
    entry.nativeId = null;
    entry.base = entry.messages.length;
    if (titleReset && existing) entry.info = { ...entry.info, title: null };
    entry._dirty = true;
    (await all())[id] = entry;
    try { await save(); } catch (e) { if (existing) records[id] = existing; else delete records[id]; throw e; }
    await store.setSessionData(id, "rewind", null, { durable: true });
    if (titleReset && meta.title) await store.setMeta(id, { title: null });
    // 生きているネイティブのプロセス（antigravity は 1 会話 1 プロセスを生かしておく）は使わない
    if (nativeId) await Promise.resolve(native.releaseConversation?.(nativeId)).catch(() => {});
  }
  // 巻き戻した次のターン。resumeDropsTurn が拒否したら（切り口が合わない。拒否の文面には依らず、バックエンドが rewindRejected を付けたもの）、
  // ホスト管理に落として一度だけやり直す。拒否は繰り返し再試行しない（SDK の注意）。拒否はプロンプトを渡す前に起きるので、やり直しても二重に送らない
  wrapped.runTurn = async (args) => {
    try { return await runOnce(args); }
    catch (error) {
      if (!error?.rewindRejected || !args.sessionId) throw error;
      console.error("  rewind: 巻き戻しを拒否されたのでホスト管理に落とす:", String(error.message).slice(0, 200));
      await becomeHostManaged(args.sessionId, await conversation(args.sessionId), await wrapped.getMessages(args.sessionId, { fullResults: true }),
        await wrapped.getPresents(args.sessionId));
      return runOnce(args);
    }
  };
  wrapped.prepareTurn = async (id) => {
    const r = id && await conversation(id);
    if (r && r.backend === native.id) {
      const meta = await store.get(id);
      const bot = meta.bot;
      if ((bot?.kind === 'thread' || bot?.kind === 'dm') && bot.workNotesVersion !== WORK_NOTES_VERSION) {
        await wrapped.getMessages(id, { fullResults: true });
        const messages = r.messages;
        if (messages.some((m) => (m.kind === 'contextNote' && m.tag === 'inner') || (m.role === 'user' && /<pleiad-inner(?:\s|>)/.test(m.text ?? '')))) {
          // Preserve the visible history, but start a new execution segment without replaying the legacy prompt.
          const previous = r.nativeId;
          r.messages = messages;
          r.contextStart = messages.length;
          r.contextSince = new Date().toISOString();
          r.base = messages.length;
          r.nativeId = null;
          delete r.injected; delete r.original;
          r._dirty = true;
          await save();
          await store.setSessionData(id, 'rewind', null, { durable: true });
          if (previous) await Promise.resolve(native.releaseConversation?.(previous)).catch(() => {});
          await store.setSessionData(id, 'bot', { ...bot, snapshotDue: true, delivered: [], workNotesVersion: WORK_NOTES_VERSION }, { durable: true });
        } else {
          await store.setSessionData(id, 'bot', { ...bot, workNotesVersion: WORK_NOTES_VERSION }, { durable: true });
        }
      }
    }
  };
  // resume の前に、nativeId の transcript が無いと言い切れるか。読めなかった（例外・不明）ときは「ある」側に倒す（外すと履歴が消えたように見える）
  async function nativeTranscriptMissing(nativeId) {
    const history = await native.getMessages?.(nativeId, { fullResults: true }).catch(() => null);
    if (!Array.isArray(history) || history.length) return false;
    if (typeof native.getSession !== "function") return true;
    return !(await native.getSession(nativeId).catch(() => "unknown"));
  }
  async function runOnce(args) {
    const id = args.sessionId;
    await wrapped.prepareTurn(id);
    const r = id && await conversation(id);
    const mark = id && native.capabilities?.rewind === "resumeAt" ? await liveRewindMark(id, r ? r.nativeId : id) : null;
    // 同じ印で何度も失敗する（拒否の形が想定と違った）ときは、無限に残さずホスト管理に落とす（3 回目は渡さない）
    if (mark && (mark.tries ?? 0) >= 2) throw Object.assign(new Error("rewind kept failing"), { rewindRejected: true });
    if (mark) await store.setSessionData(id, "rewind", { ...mark, tries: (mark.tries ?? 0) + 1 }, { durable: true });
    const rewind = mark ? { at: mark.at, drops: mark.drops } : undefined;
    if (!r) return native.runTurn(rewind ? { ...args, rewind } : args);
    if (r.backend !== native.id) throw new Error(t("conversations.backendMismatch"));
    // 存在しない nativeId を resume し続ける会話の救済。Claude Code は transcript の無い id の resume を `No conversation found with session ID` で断り、
    // 戻る道が無いまま毎回失敗する（下の finally が採用を戻すようになる前に作られた会話。2026-10-06）。
    // 失敗の文面には頼らず、resume の前に transcript があるか確かめる。本文（r.messages）がある会話の nativeId は外さない（履歴が消えたように見えるので、失敗を見せる）。
    // 外した後に採用される id は新しいので、送り直しは 1 度で済む（また空なら finally が戻す）
    if (r.nativeId && native.id === "claude" && !r.messages.length && await nativeTranscriptMissing(r.nativeId)) {
      // i18n-ignore: サーバーのログ
      console.error("  conversations: transcript の無い nativeId を外して新しく始める:", r.nativeId);
      r.segments = (r.segments ?? []).filter(seg => seg.nativeId !== r.nativeId);
      r.nativeId = null;
      r._dirty = true;
      await save();
    }
    let prompt = args.prompt;
    if (!r.nativeId && r.contextStart) {
      const recent = classifySystemMessages(r.messages.slice(0, r.contextStart))
        .filter((m) => m.kind === 'channelEvent' || ((m.role === 'user' || m.role === 'assistant') && !m.kind && m.text && !m.text.startsWith('API Error:')))
        .slice(-12).map((m) => ({ from: m.from ?? m.role, text: String(m.body ?? m.text).slice(0, 2000) }));
      if (recent.length) {
        const body = agentT(args.locale, 'brain.inner.recent', { context: JSON.stringify(recent) }).replace(/</g, '&lt;');
        args = { ...args, notes: [...(args.notes ?? []), `<${BOT_RECENT_TAG}>\n${body}\n</${BOT_RECENT_TAG}>`] };
      }
    }
    let checkpoint = Promise.resolve();
    if (!r.nativeId && r.messages.length > (r.contextStart ?? 0)) {
      // Full transcript stays on disk; bounded input plus a readable reference for long conversations.
      const presents = (await wrapped.getPresents(id)).filter((p) => !r.contextSince || p.at >= r.contextSince);
      const messages = r.messages.slice(r.contextStart ?? 0).map(({ thinking, ...m }) => m);
      const transcript = JSON.stringify({ messages, presents });
      const ref = handoffPath(id);
      await fs.writeFile(ref, transcript);
      const context = transcript.length <= 60000 ? transcript : JSON.stringify({
        partial: true,
        instructionsPreview: messages.filter(m => m.role === "user").map(m => m.text).join("\n").slice(0, 20000),
        recent: messages.slice(-12).map(m => ({ role: m.role, text: m.text?.slice(0, 2500) })),
        note: agentT(args.locale, 'handoff.partialNote'),
      });
      // Avoid implying a write request in the handoff boilerplate: an agent's intent
      // heuristic may pair "editing" with the .json reference below.
      // 引き継ぎの文はエージェントが読むので会話の言語（args.locale。core/server.mjs が渡す）で
      prompt = agentT(args.locale, 'handoff.prompt', { ref, context, prompt: String(args.prompt ?? '') });
      r.injected = prompt;
      r.original = String(args.prompt ?? "");
    }
    // このターンの中で初めて nativeId を採用したか（ターン前に nativeId が無かった）。採用した id の transcript が無ければ戻す（finally）
    const before = { nativeId: r.nativeId, segments: r.segments?.length ?? 0 };
    let turnFailed = false;
    try {
      return await native.runTurn({ ...args, prompt, sessionId: r.nativeId, ...(rewind ? { rewind } : {}),
        hostSessionId: id, hostBackend: wrapped,
        askPermission: req => args.askPermission({ ...req, sessionId: id }),
        emit: ev => {
          if (ev.type === "session" && ev.sessionId && ev.sessionId !== r.nativeId) {
            r.nativeId = ev.sessionId;
            r.segments.push({ backend: native.id, nativeId: ev.sessionId });
            r._dirty = true;
            checkpoint = save();
            checkpoint.catch(() => {});
          }
          args.emit(hostEvent(ev, id, r.nativeId));
        },
      });
    } catch (e) {
      turnFailed = true;
      throw e;
    } finally {
      await checkpoint;
      // ターンの後の取り込み。一時的な SQLite のエラー（Codex の `(code: 1546) disk I/O error`）なら間を空けて読み直し、
      // それでも読めなければ取り込みはこの回は見送る（ターンを失敗にしない。次に会話を読むとき getMessages が取り込む）。
      // 2026-09-27 以降、作業と報告を終えた Codex の委譲の子が、ここで投げたエラーで「失敗」になっていた（core/history-retry.mjs）
      const nativeMessages = r.nativeId ? await readWithRetry(() => native.getMessages(r.nativeId, { fullResults: true }), {
        // i18n-ignore: サーバーのログ
        onRetry: (e, n, ms) => console.error(`  conversations: ターンの後の履歴を読めなかったので ${ms}ms 後に読み直す（${n} 回目）:`, String(e?.message ?? e).slice(0, 300)),
      }).catch((e) => {
        if (!transientStorageError(e)) throw e;
        // i18n-ignore: サーバーのログ
        console.error("  conversations: ターンの後の履歴を読み直しても読めなかったので、取り込みを次に読むときへ回す:", String(e?.message ?? e).slice(0, 300));
        return null;
      }) : null;
      // プロンプトを渡す前に中断・失敗したターンでも、CLI は session_id 付きのメッセージを先に返す（2026-10-06、@anthropic-ai/claude-agent-sdk 0.3.288。
      // 遅らせたプロンプトを渡す前に abort すると、session_id は届くのに ~/.claude/projects/<cwd>/<id>.jsonl は作られない）。
      // その id を採用したままだと、次のターンが無い transcript を resume して毎回落ちる。
      // このターンで初めて採用した id の transcript が無いときは、採用をターン前に戻して保存する。
      // 失敗・中断で終わったターンは元の結果をそのまま返す（historyUnreadable で上書きしない）。成功したのに transcript が無いのだけが historyUnreadable
      const unadopted = Boolean(nativeMessages && !nativeMessages.length && r.nativeId && !before.nativeId);
      if (unadopted) {
        r.nativeId = null;
        r.segments.length = before.segments;
        // i18n-ignore: サーバーのログ
        console.error("  conversations: このターンで採用した nativeId の transcript が無いので、採用を戻した");
        // server は AbortController（turn.ac）を渡す。バックエンドと同じく .signal を見る
        if (!turnFailed && !(args.signal?.signal ?? args.signal)?.aborted) {
          r._dirty = true;
          await save();
          throw new Error(t("conversations.historyUnreadable"));
        }
      }
      // 失敗したターンの後に transcript が空なのは、失敗の結果（例: 無い id の resume を断られた）。取り込まず、元の失敗を historyUnreadable で上書きしない
      if (nativeMessages && !unadopted && !(turnFailed && !nativeMessages.length)) {
        // 巻き戻しを拒否されたターンは、鎖がまだ古い葉のまま。切ってから取り込む（捨てた発言が戻らないように）
        const messages = applyRewindMark(nativeMessages, mark);
        if (!messages.length) throw new Error(t("conversations.historyUnreadable"));
        mergeMessages(r, messages, native.id);
        // Preallocated conversations start with a placeholder in the sidecar.
        // Adopt the native initial title once, without renaming later turns or handoffs.
        if (r.base === 0) {
          const info = await native.getSession(r.nativeId).catch(() => null);
          const meta = await store.get(id);
          if ((!meta.title || meta.title === "新しいセッション") && !meta.history?.some(h => h.field === "title")) { // i18n-ignore: 過去の記録の既定タイトルとの照合
            // 入力欄の `!` の結果は発言の前に渡る（ADR 0054）。その行（<bash-input>・CLI が題に使う `! コマンド`）は題にせず、最初の人の発言を使う
            const nativeTitle = info?.title?.trim();
            const title = (nativeTitle && !/^(<[a-z-]+>|! )/.test(nativeTitle) ? nativeTitle : '')
              || promptTitle(classifySystemMessages(messages).find(m => m.role === "user" && !m.kind && m.text)?.text);
            if (title) await store.setMeta(id, { title });
          }
        }
      }
      r._dirty = true;
      await save();
    }
  };
  return wrapped;
}
