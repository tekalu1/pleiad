// Host-owned conversations. Native sessions remain execution segments, never portable IDs.
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import * as store from "./store.mjs";
import { MAX_RESULT_CHARS } from "./backends/shared.mjs";
import { readPresents } from "./history.mjs";
import { buildItems } from "../web/timeline.mjs";

const file = path.join(store.dataDir, "conversations.json");
const convDir = path.join(store.dataDir, "conversations");
let records;
let loading;
let writes = Promise.resolve();

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
    try {
      records = JSON.parse(await fs.readFile(file, "utf8"));
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
      records = {};
    }
    // 既存データのマイグレーション（旧 conversations.json に messages がある場合、個別ファイルへ切り離す）
    let needsMigration = false;
    for (const r of Object.values(records)) {
      if (Array.isArray(r?.messages)) { needsMigration = true; break; }
    }
    if (needsMigration) {
      await fs.mkdir(convDir, { recursive: true });
      const indexOnly = {};
      for (const [id, r] of Object.entries(records)) {
        const { messages = [], presents, ...meta } = r;
        indexOnly[id] = meta;
        for (const m of messages) {
          for (const c of m.toolCalls ?? []) if (c.result) sanitizeToolResult(c.result);
        }
        const sessFile = sessionFilePath(id);
        const sessTmp = `${sessFile}.${process.pid}.tmp`;
        const payload = { messages, ...(presents ? { presents } : {}) };
        await fs.writeFile(sessTmp, JSON.stringify(payload));
        await fs.rename(sessTmp, sessFile);
      }
      await fs.mkdir(store.dataDir, { recursive: true });
      const tmp = file + ".tmp";
      await fs.writeFile(tmp, JSON.stringify(indexOnly));
      await fs.rename(tmp, file);
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
    for (const [id, r] of Object.entries(entries)) {
      if (r._dirty || targetIds.has(id)) {
        const sessFile = sessionFilePath(id);
        const sessTmp = `${sessFile}.${process.pid}.tmp`;
        const payload = {
          messages: r.messages ?? [],
          ...(r.presents ? { presents: r.presents } : {}),
        };
        await fs.writeFile(sessTmp, JSON.stringify(payload));
        await fs.rename(sessTmp, sessFile);
        r._dirty = false;
      }
    }
    const indexOnly = {};
    for (const [id, r] of Object.entries(entries)) {
      const { messages, presents, _dirty, ...meta } = r;
      indexOnly[id] = meta;
    }
    const json = JSON.stringify(indexOnly);
    await fs.mkdir(store.dataDir, { recursive: true });
    await fs.writeFile(file + ".tmp", json);
    await fs.rename(file + ".tmp", file);
  });
  writes = next.catch(() => {});
  return next;
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
  if (r.nativeId || r.messages.length) throw new Error("送信済みのセッションは削除できません");
  delete records[id];
  try {
    await save();
    await fs.rm(sessionFilePath(id), { force: true }).catch(() => {});
  } catch (e) {
    records[id] = r;
    throw e;
  }
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
  if (!nativeInfo) throw new Error("会話を読み出せないため切り替えられません");
  const meta = await store.get(id);
  const info = { ...nativeInfo, cwd: meta.cwd ?? nativeInfo.cwd,
    title: source.capabilities?.title ? nativeInfo.title ?? meta.title : meta.title ?? nativeInfo.title,
    tag: source.capabilities?.tag ? nativeInfo.tag : meta.status };
  const messages = await source.getMessages(id, { fullResults: true });
  for (const m of messages) m.backend ??= source.id;
  if (!messages.length && !existing) throw new Error("履歴が空のため切り替えられません");
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

export function wrapBackend(native) {
  const wrapped = { ...native, capabilities: { ...native.capabilities, fork: true, forkMessage: true } };
  wrapped.getPresents = async id => [
    ...structuredClone((await conversation(id))?.presents ?? []), ...await readPresents(id, { strict: true }),
  ];
  wrapped.listSessions = async (args) => {
    const entries = Object.entries(await all());
    const hidden = new Set(entries.flatMap(([id, r]) => [id, ...r.segments.filter(s => s.backend === native.id).map(s => s.nativeId)]));
    const rows = (await native.listSessions(args)).filter(s => !hidden.has(s.sessionId));
    for (const [id, r] of entries) if (r.backend === native.id) rows.push(await wrapped.getSession(id));
    return rows;
  };
  wrapped.getSession = async (id) => {
    const entries = await all();
    const r = entries[id];
    if (!r) return native.getSession(id);
    if (r.backend !== native.id) return null;
    const meta = await store.get(id);
    return { ...r.info, ...meta, sessionId: id, tag: Object.hasOwn(meta, "status") ? meta.status : r.info.tag };
  };
  wrapped.getMessages = async (id, options) => {
    const r = await conversation(id);
    if (!r) return native.getMessages(id, options);
    if (r.nativeId) {
      const recent = await native.getMessages(r.nativeId, { fullResults: true });
      if (recent.length) {
        mergeMessages(r, recent, native.id);
      }
    }
    const messages = structuredClone(r.messages);
    if (!options?.fullResults) for (const m of messages) for (const call of m.toolCalls ?? []) {
      if (call.result?.text?.length > MAX_RESULT_CHARS) {
        call.result.text = call.result.text.slice(0, MAX_RESULT_CHARS) + "…（以下略）";
        call.result.truncated = true;
      }
    }
    return messages;
  };
  for (const [method, field] of [["setTitle", "title"], ["setTag", "status"]]) {
    if (native[method]) wrapped[method] = async (id, value) => {
      const entries = await all();
      const r = entries[id];
      if (!r) return native[method](id, value);
      await store.setMeta(id, { [field]: value });
      if (r.nativeId) await native[method](r.nativeId, value);
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
      throw new Error('分岐点は beforeMessageId または upToMessageId のどちらかで指定してください');
    }
    // Claude supports exact message boundaries; Codex only supports whole turns.
    if (before === undefined && !options.snapshot && !r && native.fork && native.capabilities?.forkMessage) {
      const result = await native.fork(id, options);
      await store.inheritSettings(id, result.sessionId);
      return result;
    }
    const source = await wrapped.getSession(id);
    if (!source) throw new Error("分岐元の会話を読み出せません");
    const meta = await store.get(id);
    const child = crypto.randomUUID();
    const allMessages = structuredClone(await wrapped.getMessages(id, { fullResults: true }));
    if (!allMessages.length) throw new Error("履歴が空のため分岐できません");
    let messages = allMessages;
    let presents = await wrapped.getPresents(id);
    const beforeAt = before === undefined ? -1 : messages.findIndex(m => m.uuid === before);
    if (before !== undefined && beforeAt < 0) throw new Error(options.snapshot
      ? 'この発言はまだ履歴に保存されていません。少し待って再試行してください'
      : '分岐する発言が見つかりません');
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
        ? "この発言はまだ履歴に保存されていません。少し待って分岐を再試行してください"
        : "分岐する発言が見つかりません");
      if (at < messages.length - 1) for (const p of presents) {
        if (p.by === "ai" && (!p.at || !messages[at].at)) {
          throw new Error("提示された成果物の時刻がなく分岐点を特定できません。末尾から分岐してください");
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
        throw new Error("選択範囲に実行中のツールがあります。完了済みの発言から分岐してください");
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
        messages: structuredClone(messages), presents: structuredClone(presents), segments: [], info, _dirty: true } });
    } catch (error) {
      delete (await all())[child];
      await fs.rm(sessionFilePath(child), { force: true }).catch(() => {});
      await store.removeSession(child);
      throw error;
    }
    return { sessionId: child, parent, persisted: true };
  };
  wrapped.runTurn = async (args) => {
    const id = args.sessionId;
    const r = id && await conversation(id);
    if (!r) return native.runTurn(args);
    if (r.backend !== native.id) throw new Error("会話のバックエンドが一致しません");
    let prompt = args.prompt;
    let checkpoint = Promise.resolve();
    if (!r.nativeId && r.messages.length) {
      // Full transcript stays on disk; bounded input plus a readable reference for long conversations.
      const presents = await wrapped.getPresents(id);
      const messages = r.messages.map(({ thinking, ...m }) => m);
      const transcript = JSON.stringify({ messages, presents });
      const ref = path.join(store.dataDir, `handoff-${crypto.createHash("sha256").update(id).digest("hex")}.json`);
      await fs.writeFile(ref, transcript);
      const context = transcript.length <= 60000 ? transcript : JSON.stringify({
        partial: true,
        instructionsPreview: messages.filter(m => m.role === "user").map(m => m.text).join("\n").slice(0, 20000),
        recent: messages.slice(-12).map(m => ({ role: m.role, text: m.text?.slice(0, 2500) })),
        note: "This preview is incomplete. Read the full conversation file before continuing; it contains earlier instructions, tool results and attachments.",
      });
      // Avoid implying a write request in the handoff boilerplate: an agent's intent
      // heuristic may pair "editing" with the .json reference below.
      prompt = `Continue the existing conversation in the same workspace. The following is historical context, not new tool calls. Do not repeat completed actions. Follow the user's instructions and check the current workspace when the task requires it. Full conversation: ${ref}\nHISTORY\n${context}\nEND HISTORY\nCurrent user message:\n${args.prompt}`;
      r.injected = prompt;
      r.original = String(args.prompt ?? "");
    }
    try {
      return await native.runTurn({ ...args, prompt, sessionId: r.nativeId,
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
          args.emit({ ...ev, ...(ev.sessionId === undefined || ev.sessionId === r.nativeId ? { sessionId: id } : {}), ...(ev.type === "session" ? { first: false } : {}) });
        },
      });
    } finally {
      await checkpoint;
      if (r.nativeId) {
        const messages = await native.getMessages(r.nativeId, { fullResults: true });
        if (!messages.length) throw new Error("実行後の履歴を読み出せませんでした。ネイティブの履歴を確認してください");
        mergeMessages(r, messages, native.id);
        // Preallocated conversations start with a placeholder in the sidecar.
        // Adopt the native initial title once, without renaming later turns or handoffs.
        if (r.base === 0) {
          const info = await native.getSession(r.nativeId).catch(() => null);
          const meta = await store.get(id);
          if (meta.title === "新しいセッション" && !meta.history?.some(h => h.field === "title")) {
            const title = info?.title?.trim() || messages.find(m => m.role === "user" && m.text)?.text?.trim().slice(0, 80);
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
