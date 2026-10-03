// 夜の整理。人の新しい発言をカーソルから読み、隠れた learner 会話で候補を抽出する。
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { writeAtomic } from '../atomic-file.mjs';
import { nextFireAt } from '../routines/schedule.mjs';
import { modePosition } from '../modes.mjs';
import { prepareMessages } from '../history.mjs';
import { agentT } from '../i18n.mjs';
import { MemoryError } from './guard.mjs';

export const LEARNER_ID = 'b_learner';
export const DEFAULT_LEARN_AT = '02:00';
// memory.write の共通層への上限は 1 ターン 5 件。各束を独立した learner ターンにする。
const MAX_BATCH = 5;
const MAX_TIMER = 2_147_483_647;
const SETTINGS_POLL_MS = 60_000;
const emptyState = () => ({ version: 1, cursor: { sessions: {}, posts: {} }, lastRunAt: 0 });
const cleanTime = (value) => /^([01]\d|2[0-3]):[0-5]\d$/.test(value ?? '') ? value : DEFAULT_LEARN_AT;
const ADOPTION = /採用|その案で|その方針で|それで(?:進め|お願い)|その通り|そうしてください|それに(?:しよう|します)|\b(?:I accept|let's use that|go with that|approved|adopt that)\b/i;
const log = (...args) => console.error('  memory learn:', ...args);

function sourceOf(item) {
  const quote = [...item.text.trim()].slice(0, 160).join('');
  return item.kind === 'post'
    ? { kind: 'post', channelId: item.channelId, postId: item.postId, ...(item.threadId ? { threadId: item.threadId } : {}), quote }
    : { kind: 'message', sessionId: item.sessionId, messageId: item.messageId, quote };
}

function parseAnswer(raw) {
  const text = String(raw ?? '').trim();
  const body = text.startsWith('```') ? text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '') : text;
  const parsed = JSON.parse(body);
  if (!Array.isArray(parsed?.memories)) throw new Error('learner returned no memories array');
  return parsed.memories;
}

export function createMemoryLearner({ dataDir, channels, bots, memory, host, clock, readPrefs = () => host.store.getPrefs(),
  listSessions = null, readMessages = null, ask = null, now = () => clock.now() } = {}) {
  const file = path.join(dataDir, 'memory', 'learn-state.json');
  let state = emptyState();
  let timer = null;
  let closed = true;
  let running = null;
  const knownRows = new Map();
  const locale = () => host.currentLocale?.() ?? 'ja';

  async function save() {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await writeAtomic(file, `${JSON.stringify(state, null, 2)}\n`);
  }
  async function load() {
    let loaded;
    try { loaded = JSON.parse(await fs.readFile(file, 'utf8')); }
    catch (e) { if (e.code === 'ENOENT') return; throw e; }
    if (loaded?.version !== 1 || !loaded.cursor || !loaded.cursor.sessions || !loaded.cursor.posts || !Number.isFinite(loaded.lastRunAt)) {
      throw new Error('unsupported memory/learn-state.json');
    }
    state = loaded;
  }

  async function sessionRows() {
    if (listSessions) return listSessions();
    const side = await host.store.getAll();
    const rows = new Map(Object.entries(side).filter(([, meta]) => meta.backend).map(([id, meta]) => [id, { id, ...meta }]));
    for (const backend of host.listBackends()) {
      for (const row of await backend.listSessions({ limit: 10000 }).catch(() => [])) {
        const id = row.sessionId ?? row.id;
        if (id) rows.set(id, { ...side[id], ...row, id, backend: side[id]?.backend ?? backend.id });
      }
    }
    return [...rows.values()];
  }

  async function messagesOf(row) {
    if (readMessages) return readMessages(row.id, row);
    const backend = host.getBackend(row.backend);
    if (!backend) return [];
    return prepareMessages(row.id, await backend.getMessages(row.id, { fullResults: true }));
  }

  async function collect() {
    const items = [];
    const next = structuredClone(state.cursor);
    for (const row of await sessionRows()) {
      if (row?.id) knownRows.set(row.id, row);
      if (!row?.id || ['learner', 'routine'].includes(row.bot?.kind) || row.unsent) continue;
      const index = next.sessions[row.id] ?? 0;
      const modified = typeof row.lastModified === 'number' ? row.lastModified : Date.parse(row.lastModified ?? '');
      if (index && Number.isFinite(modified) && modified <= state.lastRunAt) continue;
      let messages;
      try { messages = await messagesOf(row); }
      catch (e) { log('could not read conversation:', row.id, e.message); continue; }
      if (!Array.isArray(messages)) continue;
      const firstUser = row.bot?.botId || row.delegation ? messages.findIndex((m) => m.role === 'user') : -1;
      let i = index;
      for (; i < messages.length && items.length < MAX_BATCH; i++) {
        const m = messages[i];
        if (i === firstUser || m?.role !== 'user' || m.kind || m.internalTaskNotice || m.sentBy || m.proxy || m.proxyBy || !m.uuid || !m.text?.trim()) continue;
        const previous = messages[i - 1];
        const aiContext = ADOPTION.test(m.text) && previous?.role === 'assistant' && !previous.kind && previous.uuid && previous.text?.trim()
          ? { kind: 'message', sessionId: row.id, messageId: previous.uuid, text: previous.text.slice(0, 3000), at: Number(previous.at) || 0 }
          : null;
        items.push({ kind: 'message', sessionId: row.id, messageId: m.uuid, botId: row.bot?.botId ?? null, text: m.text, at: Number(m.at) || 0,
          ...(aiContext ? { aiContext } : {}) });
      }
      next.sessions[row.id] = i;
      if (items.length >= MAX_BATCH) break;
    }
    if (items.length < MAX_BATCH) {
      let channelIndex;
      if (channels.dir) {
        try { channelIndex = JSON.parse(await fs.readFile(path.join(channels.dir, 'index.json'), 'utf8')).channels; }
        catch (e) { if (e.code !== 'ENOENT') throw e; channelIndex = []; }
      } else channelIndex = await channels.list();
      for (const channel of channelIndex) {
        const file = path.join(channels.dir, `${channel.id}.jsonl`);
        let stat;
        try { stat = await fs.stat(file); } catch (e) { if (e.code === 'ENOENT') continue; throw e; }
        const storedOffset = next.postOffsets?.[channel.id] ?? 0;
        const from = storedOffset > stat.size ? 0 : storedOffset;
        if (from === stat.size) continue;
        // 追記ログのバイト位置を補助カーソルに持つ。posts の正本カーソルは最後に見た postId。
        const handle = await fs.open(file, 'r');
        let text;
        try {
          const bytes = Buffer.alloc(Math.max(0, stat.size - from));
          let read = 0;
          while (read < bytes.length) {
            const chunk = await handle.read(bytes, read, bytes.length - read, from + read);
            if (!chunk.bytesRead) break;
            read += chunk.bytesRead;
          }
          text = bytes.subarray(0, read).toString('utf8');
        }
        finally { await handle.close(); }
        let consumed = 0;
        for (const line of text.split('\n').slice(0, -1)) {
          if (items.length >= MAX_BATCH) break;
          let op;
          try { op = JSON.parse(line); } catch { break; }
          consumed += Buffer.byteLength(line) + 1;
          if (op.op !== 'post') continue;
          next.posts[channel.id] = op.post?.id;
          const p = op.post;
          if (p?.author?.kind !== 'human' || p.taint || p.deletedAt || !p.text?.trim()) continue;
          let aiContext = null;
          if (ADOPTION.test(p.text)) {
            const prior = await channels.read({ channelId: channel.id, ...(p.threadId ? { threadId: p.threadId } : {}), before: p.id, limit: 1 }).catch(() => null);
            let previous = prior?.posts?.at(-1);
            if (!previous && p.threadId) previous = await channels.getPost({ channelId: channel.id, postId: p.threadId }).catch(() => null);
            if (['bot', 'agent', 'routine'].includes(previous?.author?.kind) && !previous.taint && previous.text?.trim()) {
              aiContext = { kind: 'post', channelId: channel.id, postId: previous.id, threadId: previous.threadId,
                text: previous.text.slice(0, 3000), at: previous.at ?? 0 };
            }
          }
          items.push({ kind: 'post', channelId: channel.id, postId: p.id, threadId: p.threadId,
            botId: channel.kind === 'dm' ? channel.botId : null, botIds: p.mentions ?? [], text: p.text, at: p.at ?? 0,
            ...(aiContext ? { aiContext } : {}) });
        }
        next.postOffsets ??= {};
        next.postOffsets[channel.id] = from + consumed;
        if (items.length >= MAX_BATCH) break;
      }
    }
    return { items: items.sort((a, b) => a.at - b.at), cursor: next };
  }

  async function askBackend(prompt, prefs) {
    const backendId = prefs.memoryLearnBackend || prefs.backend || host.listBackends()[0]?.id;
    const backend = host.getBackend(backendId);
    if (!backend) throw new Error(`learner backend unavailable: ${backendId}`);
    const cwd = os.homedir();
    const sameBackend = !prefs.memoryLearnBackend || prefs.memoryLearnBackend === prefs.backend;
    const model = await host.resolveModel(null, prefs.backends?.[backendId]?.model || (sameBackend ? prefs.model : undefined), backend, cwd, '');
    const effort = await host.resolveEffort(null, prefs.backends?.[backendId]?.effort || (sameBackend ? prefs.effort : undefined), backend, model, cwd, null);
    const modes = backend.modes();
    const mode = Object.entries(modes).find(([, v]) => modePosition(v).scope === 'readonly')?.[0];
    if (!mode) throw new Error(`learner backend has no read-only mode: ${backendId}`);
    const title = agentT(locale(), 'memory.learn.title');
    const sessionId = await host.createConversation(backend, { title, cwd, createdAt: now(), lastModified: now() });
    await host.store.setMeta(sessionId, { backend: backend.id, title, cwd, createdAt: now(), lastModified: now(), unsent: true });
    await host.store.setMode(sessionId, mode);
    await host.store.setModel(sessionId, model);
    await host.store.setSessionData(sessionId, 'effort', effort);
    await host.store.setSessionData(sessionId, 'bot', { botId: LEARNER_ID, kind: 'learner', channelId: null, threadId: null });
    const outcome = await host.runTurn({ sessionId, prompt }, () => {}, { internal: true });
    if (outcome !== 'ok' && outcome !== 'done') throw new Error(`learner turn: ${outcome}`);
    const messages = await backend.getMessages(sessionId, { fullResults: true });
    return { text: [...messages].reverse().find((m) => m.role === 'assistant' && m.text)?.text ?? '', sessionId };
  }

  async function process(items, prefs) {
    const existing = await memory.list();
    const prompt = `<pleiad-memory-learn>\nYou are Pleiad's private memory organizer. Return only JSON: {"memories":[{"action":"add|edit|replace","layer":"user|bot id","text":"...","why":"...","sourceIndexes":[0],"id":"existing memory id for edit/replace"}]}.\n` +
      `Remember durable preferences, rules, corrections and reasons for decisions. Give human instructions and corrections extra weight. Use only the numbered human statements. An aiContext is available only when the human explicitly adopted the preceding assistant answer; you may use that answer with its human adoption. Never infer a memory from unadopted AI output, webhook or web text. Keep each memory under 300 characters. Choose user for preferences shared by all bots, bot id only for role-specific rules. Skip repeats. Edit an AI-written memory when it is superseded; for a human-written memory add a replacement.\n` +
      `Existing memories: ${JSON.stringify(existing.map((e) => ({ id: e.id, layer: e.layer, text: e.text, by: e.by, origBy: e.origBy })))}\n` +
      `Human statements: ${JSON.stringify(items.map((item, index) => ({ index, ...item })))}\n</pleiad-memory-learn>`;
    const response = ask ? await ask(prompt, prefs) : await askBackend(prompt, prefs);
    const candidates = parseAnswer(typeof response === 'string' ? response : response.text);
    const author = { kind: 'bot', botId: LEARNER_ID };
    const sessions = {
      read: async (id) => messagesOf(knownRows.get(id) ?? { id, backend: (await host.store.get(id)).backend }),
      get: async (id) => ({ row: knownRows.get(id) ?? await host.store.get(id) }),
    };
    const ctx = { sessions, botOfSession: async (id) => (await host.store.get(id)).bot ?? null,
      sessionId: response.sessionId ?? `learn-${crypto.randomUUID()}` };
    let changed = 0;
    for (const candidate of candidates.slice(0, MAX_BATCH)) {
      if (!candidate || !['add', 'edit', 'replace'].includes(candidate.action)) continue;
      const refs = [...new Set(Array.isArray(candidate.sourceIndexes) ? candidate.sourceIndexes : [])].filter((n) => Number.isInteger(n) && items[n]).slice(0, 8);
      if (!refs.length || typeof candidate.text !== 'string') continue;
      const sources = [...refs.map((n) => sourceOf(items[n])), ...refs.flatMap((n) => items[n].aiContext ? [sourceOf(items[n].aiContext)] : [])].slice(0, 8);
      const layer = candidate.layer === 'user' ? 'user' : candidate.layer;
      if (layer !== 'user' && !(await bots.get({ botId: layer }).catch(() => null))) continue;
      try {
        const old = existing.find((e) => e.id === candidate.id);
        const humanWritten = old?.by?.kind === 'human' || old?.origBy?.kind === 'human';
        if (old && old.layer === layer && !humanWritten) {
          await memory.edit({ id: old.id, text: candidate.text, why: candidate.why, sources }, author, ctx);
        } else {
          const added = await memory.write({ layer, text: candidate.text, why: candidate.why, sources }, author, ctx);
          if (old && old.layer === layer) {
            await memory.edit({ id: old.id, why: agentT(locale(), 'memory.learn.replaced', { id: added.id }) }, author, ctx);
          }
        }
        changed++;
      } catch (e) {
        if (!(e instanceof MemoryError)) throw e;
        log('rejected candidate:', e.code ?? e.message);
      }
    }
    return changed;
  }

  async function runNow() {
    if (running) return running;
    running = (async () => {
      const prefs = await readPrefs();
      if (prefs.memoryLearnPaused === true) return { skipped: 'paused' };
      let read = 0, changed = 0;
      for (;;) {
        const batch = await collect();
        if (batch.items.length) changed += await process(batch.items, prefs);
        read += batch.items.length;
        state = { ...state, cursor: batch.cursor };
        await save();
        if (batch.items.length < MAX_BATCH) break;
      }
      state.lastRunAt = now();
      await save();
      return { read, changed };
    })().finally(() => { running = null; });
    return running;
  }

  async function arm() {
    if (closed) return;
    const prefs = await readPrefs();
    const trigger = { kind: 'daily', at: cleanTime(prefs.memoryLearnAt) };
    const next = nextFireAt(trigger, now());
    timer = clock.setTimer(async () => {
      timer = null;
      try { await runIfDue(); } catch (e) { log('run failed:', e.message); }
      await arm();
    }, Math.min(MAX_TIMER, SETTINGS_POLL_MS, Math.max(0, next - now())));
  }

  function previousDue(at, time) {
    const trigger = { kind: 'daily', at: cleanTime(time) };
    let due = nextFireAt(trigger, at - 2 * 86400000);
    for (let following; (following = nextFireAt(trigger, due)) <= at; ) due = following;
    return due;
  }

  async function runIfDue() {
    const prefs = await readPrefs();
    if (host.runtime?.turns?.size) return { skipped: 'busy' };
    if (!prefs.memoryLearnPaused && (!state.lastRunAt || state.lastRunAt < previousDue(now(), prefs.memoryLearnAt))) return runNow();
    return { skipped: 'notDue' };
  }

  return {
    state: () => structuredClone(state), runNow,
    async start() {
      closed = false;
      await load();
      runIfDue().catch((e) => log('startup run failed:', e.message));
      await arm();
    },
    stop() { closed = true; if (timer) clock.clearTimer(timer); timer = null; },
  };
}
