// 夜の整理。人の新しい発言をカーソルから読み、隠れた learner 会話で候補を抽出する。
//
// いつ走るか（ADR 0118）: 予定の時刻（既定 02:00）を過ぎて、その日の分がまだなら走る。ほかの会話のターンが走っていても待たない
// （learner は自分の隠れた会話で走り、ターンの同時の数に上限は無い。以前は Chats を含む全部のターンが 0 になるまで待ち、ずっと走れなかった）。
// 走っているターンの会話だけは読まずに次の回へ回す（deferred）。待つのは、learner 自身が走っている間・止めている間・失敗の後の間隔だけ。
// 読む量の上限: 最後まで読んだ会話は、その時の更新時刻（cursor.seen）から変わるまで読み直さない。読むのは 14 日以内（最初の回は 3 日）の発言・投稿だけ。
// 1 回に 40 束（200 件）まで読み、残りは次の回（lastResult.more）。
// 走った・飛ばした・失敗したことは DB の memory_state の meta 'status' の 1 行に残し、memory.learnStatus（bot のページの記憶の見出し）で見せる。
//
// runNow({ scope? }) … scope は { sessionIds?, channelIds? }。渡すとその会話・チャンネルだけを読む（スレッドが静かになった後の整理のため。
//   予定の分の実行には数えず、lastRunAt を進めない）。省くと全部（予定の分の実行）。
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { openData } from '../data-schema.mjs';
import { memoryStateTable } from '../db.mjs';
import { nextFireAt } from '../routines/schedule.mjs';
import { modePosition } from '../modes.mjs';
import { prepareMessages } from '../history.mjs';
import { agentT } from '../i18n.mjs';
import { MemoryError } from './guard.mjs';
import { isMemoryKind, isMemoryStatus, isWeight } from './strength.mjs';

export const LEARNER_ID = 'b_learner';
export const DEFAULT_LEARN_AT = '02:00';
// memory.write の共通層への上限は 1 ターン 5 件。各束を独立した learner ターンにする。
const MAX_BATCH = 5;
const MAX_TIMER = 2_147_483_647;
const SETTINGS_POLL_MS = 60_000;
/** 失敗した後に次を試すまでの間隔（15 分から倍に、6 時間まで）。失敗のたびにモデルを毎分呼ばないため */
const RETRY_FIRST_MS = 15 * 60_000;
const RETRY_MAX_MS = 6 * 3600_000;
const ERROR_MAX = 300;
/** 読む範囲。これより古い発言・投稿は読まない。一度も走っていない置き場の最初の回は 3 日（全部の履歴を読まないため。
 *  2026-10-04 の実データの写しで、人の発言は全部で約 2,700・14 日で約 2,100（1 日に約 150）あった） */
const LOOKBACK_MS = 14 * 86_400_000;
const FIRST_LOOKBACK_MS = 3 * 86_400_000;
/** 1 回に読む束の上限（5 件ずつで 200 件。1 束が学習の会話 1 回）。残りはカーソルから次の回に読む */
const MAX_BATCHES = 40;
/** ms の時刻（数・ISO の文字列）。読めなければ 0 */
const timeOf = (value) => { const n = typeof value === 'number' ? value : Date.parse(value ?? ''); return Number.isFinite(n) ? n : 0; };
// status: 最後の結果 lastResult { at, read, changed, deferred, scoped? }・その日の予定を飛ばした印 skip { due, reason, count, at }
// （count は予定の回の数。同じ回を毎分数えない）・失敗 failure { at, message, count, retryAt }。成功で skip と failure を消す
const emptyStatus = () => ({ lastResult: null, skip: null, failure: null });
const emptyState = () => ({ version: 1, cursor: { sessions: {}, posts: {} }, lastRunAt: 0, status: emptyStatus() });
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
  let state = emptyState();
  let timer = null;
  let closed = true;
  let running = null;
  const knownRows = new Map();
  const locale = () => host.currentLocale?.() ?? 'ja';

  // 進みは SQLite の memory_state（会話・チャンネルごとのカーソルを 1 件 1 行。core/db.mjs、ADR 0115）。以前は memory/learn-state.json で、
  // 会話の数だけ増えるカーソルの全体を、束ごとに書き直していた。変わった行だけを書く
  let handle = null;
  let table = null;
  let saved = new Map();   // 最後に DB へ書けた値（'kind\u0000id' -> JSON の文字列）。変わった行だけを書くための比べ元
  const open = () => { if (!handle) { handle = openData(dataDir); table = memoryStateTable(handle.db); } return table; };
  const rowsOf = (s) => [
    ...Object.entries(s.cursor ?? {}).flatMap(([group, map]) => Object.entries(map ?? {}).map(([id, value]) => [`cursor.${group}`, id, value])),
    ['meta', 'lastRunAt', s.lastRunAt],
    ['meta', 'status', s.status],
  ];
  async function save() {
    const rows = open();
    const next = new Map(rowsOf(state).map(([kind, id, value]) => [`${kind}\u0000${id}`, { kind, id, value, json: JSON.stringify(value) }]));
    const changes = [];
    for (const [key, row] of next) if (saved.get(key) !== row.json) changes.push([row.kind, row.id, row.value]);
    for (const key of saved.keys()) if (!next.has(key)) { const [kind, id] = key.split('\u0000'); changes.push([kind, id, undefined]); }
    rows.save(changes);
    saved = new Map([...next].map(([key, row]) => [key, row.json]));
  }
  async function load() {
    const rows = open().loadAll();
    const loaded = emptyState();
    for (const [kind, map] of Object.entries(rows)) {
      if (kind === 'meta') {
        if (Number.isFinite(map.lastRunAt)) loaded.lastRunAt = map.lastRunAt;
        if (map.status && typeof map.status === 'object') loaded.status = { ...emptyStatus(), ...map.status };
      }
      else if (kind.startsWith('cursor.')) loaded.cursor[kind.slice('cursor.'.length)] = map;
    }
    state = loaded;
    saved = new Map(rowsOf(state).map(([kind, id, value]) => [`${kind}\u0000${id}`, JSON.stringify(value)]));
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

  /** 走っているターンの会話か（host.sessionBusy。無ければ走っていない扱い） */
  const sessionRunning = (id) => Boolean(host.sessionBusy?.(id));

  async function collect(scope = null) {
    const items = [];
    const deferred = new Set();
    const next = structuredClone(state.cursor);
    next.seen ??= {};
    const since = now() - (state.lastRunAt ? LOOKBACK_MS : FIRST_LOOKBACK_MS);
    const sessionScope = scope ? new Set(scope.sessionIds ?? []) : null;
    const channelScope = scope ? new Set(scope.channelIds ?? []) : null;
    for (const row of sessionScope?.size === 0 ? [] : await sessionRows()) {
      if (row?.id) knownRows.set(row.id, row);
      if (!row?.id || ['learner', 'routine'].includes(row.bot?.kind) || row.unsent) continue;
      if (sessionScope && !sessionScope.has(row.id)) continue;
      // 走っている会話は読まずに次の回へ（カーソルを進めない。予定の回の lastRunAt は始めた時刻なので、ターンが終わった更新で次に拾える）
      if (sessionRunning(row.id)) { deferred.add(row.id); continue; }
      const index = next.sessions[row.id] ?? 0;
      const modified = timeOf(row.lastModified);
      const seenAt = next.seen[row.id];
      // 最後まで読んだ後に変わっていない会話は読み直さない（束ごと・夜ごとに全部の会話を読み直さない）
      if (modified && seenAt === modified) continue;
      // 読む範囲より古い会話は読まずに印だけ付ける（後で更新されたら、範囲の中の発言だけを読む）
      if (modified && modified < since) { next.seen[row.id] = modified; continue; }
      let messages;
      try { messages = await messagesOf(row); }
      catch (e) { log('could not read conversation:', row.id, e.message); continue; }
      if (!Array.isArray(messages)) continue;
      const firstUser = row.bot?.botId || row.delegation ? messages.findIndex((m) => m.role === 'user') : -1;
      let i = index;
      for (; i < messages.length && items.length < MAX_BATCH; i++) {
        const m = messages[i];
        if (i === firstUser || m?.role !== 'user' || m.kind || m.internalTaskNotice || m.sentBy || m.proxy || m.proxyBy || !m.uuid || !m.text?.trim()) continue;
        if (timeOf(m.at) && timeOf(m.at) < since) continue;   // 読む範囲より古い発言
        const previous = messages[i - 1];
        const aiContext = ADOPTION.test(m.text) && previous?.role === 'assistant' && !previous.kind && previous.uuid && previous.text?.trim()
          ? { kind: 'message', sessionId: row.id, messageId: previous.uuid, text: previous.text.slice(0, 3000), at: timeOf(previous.at) }
          : null;
        items.push({ kind: 'message', sessionId: row.id, messageId: m.uuid, botId: row.bot?.botId ?? null, text: m.text, at: timeOf(m.at),
          ...(aiContext ? { aiContext } : {}) });
      }
      next.sessions[row.id] = i;
      if (i >= messages.length && modified) next.seen[row.id] = modified;
      if (items.length >= MAX_BATCH) break;
    }
    if (items.length < MAX_BATCH) {
      let channelIndex;
      if (channels.dir) {
        try { channelIndex = JSON.parse(await fs.readFile(path.join(channels.dir, 'index.json'), 'utf8')).channels; }
        catch (e) { if (e.code !== 'ENOENT') throw e; channelIndex = []; }
      } else channelIndex = await channels.list();
      for (const channel of channelIndex) {
        if (channelScope && !channelScope.has(channel.id)) continue;
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
          if (timeOf(p.at) && timeOf(p.at) < since) continue;   // 読む範囲より古い投稿
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
    return { items: items.sort((a, b) => a.at - b.at), cursor: next, deferred };
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
    await host.store.setSessionData(sessionId, 'bot', { botId: LEARNER_ID, kind: 'learner', channelId: null, threadId: null }, { durable: true });
    const outcome = await host.runTurn({ sessionId, prompt }, () => {}, { internal: true });
    if (outcome !== 'ok' && outcome !== 'done') throw new Error(`learner turn: ${outcome}`);
    const messages = await backend.getMessages(sessionId, { fullResults: true });
    return { text: [...messages].reverse().find((m) => m.role === 'assistant' && m.text)?.text ?? '', sessionId };
  }

  async function process(items, prefs) {
    const existing = await memory.list();
    const prompt = `<pleiad-memory-learn>\nYou are Pleiad's private memory organizer. Return only JSON: {"memories":[{"action":"add|edit|replace","layer":"user|bot id","text":"...","why":"...","kind":"stop|promise|decision|share|pref|note","weight":1,"status":"open|done","sourceIndexes":[0],"id":"existing memory id for edit/replace"}]}.\n` +
      `Remember durable preferences, rules, corrections and reasons for decisions. Give human instructions and corrections extra weight. Use only the numbered human statements. An aiContext is available only when the human explicitly adopted the preceding assistant answer; you may use that answer with its human adoption. Never infer a memory from unadopted AI output, webhook or web text. Keep each memory under 300 characters. Choose user for preferences shared by all bots, bot id only for role-specific rules. Skip repeats. Edit an AI-written memory when it is superseded; for a human-written memory add a replacement.\n` +
      `Give each memory a kind: stop (something the human told us to stop or not to do again), promise (something to do later; status open, or done once it is kept), decision (an agreed choice and its reason), share (who does what), pref (a preference or correction), note (anything else). Give a weight from 1 to 3 for how strong the impression is: 3 when the human said "remember", "never", "always", "absolutely" or showed strong feeling, or for stop, promise and decision; 2 for ordinary preferences and roles; 1 for minor notes. When a statement repeats an existing memory, edit that memory (when AI-written) with a higher weight instead of adding a new one.\n` +
      `Existing memories: ${JSON.stringify(existing.map((e) => ({ id: e.id, layer: e.layer, text: e.text, by: e.by, origBy: e.origBy, kind: e.kind, weight: e.weight, status: e.status })))}\n` +
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
      // 種類・重み・状態は正しい値だけ渡す（重みの上限は memory.write / edit の capWeight が根拠を見て決める）
      const tags = {
        ...(isMemoryKind(candidate.kind) ? { kind: candidate.kind } : {}),
        ...(isWeight(candidate.weight) ? { weight: candidate.weight } : {}),
        ...(isMemoryStatus(candidate.status) ? { status: candidate.status } : {}),
      };
      try {
        const old = existing.find((e) => e.id === candidate.id);
        const humanWritten = old?.by?.kind === 'human' || old?.origBy?.kind === 'human';
        if (old && old.layer === layer && !humanWritten) {
          await memory.edit({ id: old.id, text: candidate.text, why: candidate.why, sources, ...tags }, author, ctx);
        } else {
          const added = await memory.write({ layer, text: candidate.text, why: candidate.why, sources, ...tags }, author, ctx);
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

  const retryDelay = (count) => Math.min(RETRY_MAX_MS, RETRY_FIRST_MS * 2 ** Math.max(0, count - 1));

  async function runNow({ scope = null } = {}) {
    if (running) return running;
    running = (async () => {
      const prefs = await readPrefs();
      if (prefs.memoryLearnPaused === true) return { skipped: 'paused' };
      // 予定の回の lastRunAt は始めた時刻（走っている間に更新された会話・後へ回した会話を、次の回で読み落とさない）
      const startedAt = now();
      let read = 0, changed = 0, batches = 0, more = false;
      const deferred = new Set();
      try {
        for (;;) {
          const batch = await collect(scope);
          for (const id of batch.deferred) deferred.add(id);
          if (batch.items.length) changed += await process(batch.items, prefs);
          read += batch.items.length;
          state = { ...state, cursor: batch.cursor };
          await save();
          if (batch.items.length < MAX_BATCH) break;
          if (++batches >= MAX_BATCHES) { more = true; break; }
        }
      } catch (e) {
        const count = (state.status.failure?.count ?? 0) + 1;
        const at = now();
        state.status = { ...state.status, failure: { at, message: String(e?.message ?? e).slice(0, ERROR_MAX), count, retryAt: at + retryDelay(count) } };
        await save().catch((err) => log('could not save status:', err.message));
        throw e;
      }
      const result = { at: now(), read, changed, deferred: deferred.size, ...(more ? { more: true } : {}), ...(scope ? { scoped: true } : {}) };
      if (!scope) state.lastRunAt = startedAt;
      state.status = { lastResult: result, skip: scope ? state.status.skip : null, failure: null };
      await save();
      return { read, changed, deferred: deferred.size, ...(more ? { more: true } : {}) };
    })().finally(() => { running = null; });
    return running;
  }

  /** 予定の回を飛ばした印。同じ回（due）の同じ理由は書き直さない（毎分の確かめで DB を書かない） */
  async function noteSkip(due, reason) {
    const prev = state.status.skip;
    if (prev?.due === due && prev.reason === reason) return { skipped: reason };
    const count = (prev?.count ?? 0) + (prev?.due === due ? 0 : 1);
    state.status = { ...state.status, skip: { due, reason, count, at: now() } };
    await save();
    return { skipped: reason };
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

  // ほかの会話のターンが走っていても待たない（上の冒頭の説明）。待つのは learner 自身・止めている間・失敗の後の間隔だけ
  async function runIfDue() {
    const prefs = await readPrefs();
    const due = previousDue(now(), prefs.memoryLearnAt);
    if (state.lastRunAt && state.lastRunAt >= due) return { skipped: 'notDue' };
    if (prefs.memoryLearnPaused === true) return noteSkip(due, 'paused');
    if (running) return { skipped: 'running' };
    const failure = state.status.failure;
    if (failure && now() < failure.retryAt) return noteSkip(due, 'failed');
    return runNow();
  }

  /** 画面・AI へ見せる今の様子（memory.learnStatus） */
  async function status() {
    const prefs = await readPrefs();
    const at = now();
    const time = cleanTime(prefs.memoryLearnAt);
    const due = previousDue(at, time);
    const overdue = !state.lastRunAt || state.lastRunAt < due;
    const failure = state.status.failure;
    const nextAt = prefs.memoryLearnPaused === true ? null
      : overdue ? Math.max(at, failure?.retryAt ?? 0)
      : nextFireAt({ kind: 'daily', at: time }, at);
    return {
      at: time, paused: prefs.memoryLearnPaused === true, running: Boolean(running),
      lastRunAt: state.lastRunAt || null, nextAt,
      lastResult: state.status.lastResult ?? null,
      skip: state.status.skip ? { reason: state.status.skip.reason, count: state.status.skip.count, at: state.status.skip.at } : null,
      failure: failure ? { message: failure.message, count: failure.count, at: failure.at, retryAt: failure.retryAt } : null,
    };
  }

  return {
    state: () => structuredClone(state), runNow, runIfDue, status,
    async start() {
      closed = false;
      await load();
      runIfDue().catch((e) => log('startup run failed:', e.message));
      await arm();
    },
    stop() { closed = true; if (timer) clock.clearTimer(timer); timer = null; },
    /** stop に加えて、DB の接続を離す（データ置き場を消す前。テストの後片付け用） */
    close() { this.stop(); handle?.release(); handle = null; table = null; },
  };
}
