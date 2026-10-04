// bot の頭の中の保存（ADR 0126）。SQLite の行（core/db.mjs の brainTable・memoryStateTable。ADR 0115）。
//   brain_stream … 思考の流れ。心拍ごとに 1 行の追記。bot ごとに 30 日・3,000 行まで（それより古い行は追記のたびに落とす）
//   brain_loops  … 気がかり。1 件 1 行。開いているものは 1 体 12 件まで（超えたら、いちばん長く触っていないものを手放す）。手放した・解決したものは 30 日で消す
//   memory_state … kind 'brain'（id = botId）= 心拍の状態（カーソル・次に起きる時刻・欲求の前回値・止めた印）と、kind 'brain.spend'（id = channelId/botId）= 今日使った分
//
//   createBrainStore({ dataDir, now, emit }) → BrainStore
//     append(botId, { kind, text?, refs?, taint?, tokens?, meta? }): Row      … 足した行（seq・at 付き）。kind は STREAM_KINDS
//     list(botId, { before?, limit? }): Row[]（新しい順）・tail(botId, n): Row[]（古い順）・since(botId, at): Row[]・count(botId): number
//     loops(botId, status = 'open'): Loop[]（古い順）・applyLoops(botId, ops, { taint? }): { applied, rejected }
//     state(botId): State・setState(botId, patch): State
//     addSpend(channelId, botId, { day, percent, tokens }): void・spentPercent(channelId, day): number・spentTokens(botId, day): number
//     clear(botId): { stream, loops }   … 人が消す（状態と今日の使った分は残す）
//     close(): void   … DB の接続を離す
//   Row: { seq, botId, at, kind, text, refs, taint, tokens, meta }・Loop: { botId, id, status, text, wakeOn, due, taint, createdAt, updatedAt }
//   emit({ type: 'brainChanged', botId }) を、行・気がかり・状態が変わったときに出す（画面の描き直し）
import crypto from 'node:crypto';
import { openData } from '../data-schema.mjs';
import { brainTable, memoryStateTable } from '../db.mjs';
import { WORK_NOTES_VERSION } from './inner.mjs';

export const STREAM_KINDS = Object.freeze(['think', 'quiet', 'act', 'result', 'loop', 'dream', 'summary']);
export const STREAM_TEXT_MAX = 300;
export const STREAM_KEEP_DAYS = 30;
export const STREAM_KEEP_MAX = 3000;
export const MAX_OPEN_LOOPS = 12;
const PRUNE_EVERY = 50;
const DAY_MS = 86_400_000;

const clip = (value, max) => [...String(value ?? '').replace(/\s+/g, ' ').trim()].slice(0, max).join('');
const taintOf = (v) => (v === 'webhook' || v === 'web' ? v : null);

export const emptyState = () => ({
  cursorAt: null, nextAt: null, reservedAt: null, lastBeatAt: null, lastHumanAt: null,
  sinceMuse: 0, failures: 0, drives: null, paused: false, sleepingSince: null,
});

export function createBrainStore({ dataDir, now = Date.now, emit = () => {} } = {}) {
  let handle = null, stream = null, states = null;
  const appends = new Map();
  const open = () => {
    if (!handle) { handle = openData(dataDir); stream = brainTable(handle.db); states = memoryStateTable(handle.db); }
    return stream;
  };
  const changed = (botId) => { try { emit({ type: 'brainChanged', botId }); } catch { /* 画面への知らせの失敗で保存を戻さない */ } };

  function prune(botId) {
    const t = open();
    t.prune(botId, now() - STREAM_KEEP_DAYS * DAY_MS, STREAM_KEEP_MAX);
    t.pruneLoops(botId, now() - STREAM_KEEP_DAYS * DAY_MS);
  }

  const service = {
    append(botId, { kind, text = '', refs = [], taint = null, tokens = null, meta = null } = {}) {
      if (!STREAM_KINDS.includes(kind)) throw new Error(`brain stream kind must be one of ${STREAM_KINDS.join(' / ')}: ${kind}`);
      const at = now();
      const data = {
        text: clip(text, STREAM_TEXT_MAX),
        ...(refs.length ? { refs: refs.map(String).slice(0, 5) } : {}),
        ...(taintOf(taint) ? { taint: taintOf(taint) } : {}),
        ...(tokens ? { tokens } : {}),
        ...(meta ? { meta } : {}),
      };
      const seq = open().append(botId, at, kind, data);
      const n = (appends.get(botId) ?? 0) + 1;
      appends.set(botId, n);
      if (n % PRUNE_EVERY === 0) prune(botId);
      changed(botId);
      return { seq, botId, at, kind, ...data, text: data.text, refs: data.refs ?? [], taint: data.taint ?? null };
    },
    list: (botId, opts) => open().list(botId, opts),
    tail: (botId, n) => open().tail(botId, n),
    since: (botId, at, limit) => open().since(botId, at, limit),
    count: (botId) => open().count(botId),

    loops: (botId, status = 'open') => open().loops(botId, status),
    /**
     * 気がかりの足す・直す・手放す。add の id が既にあれば直す。開いているものが MAX_OPEN_LOOPS を超えるときは、いちばん長く触っていないものを手放す。
     * taint（外から来た文を材料にした）は一度付いたら外れない。返りの applied は { op, id, text, evicted? }（流れに 1 行ずつ残す材料）
     */
    applyLoops(botId, ops, { taint = null, workNotesVersion = WORK_NOTES_VERSION } = {}) {
      const t = open();
      const applied = [];
      let rejected = 0;
      t.transaction(() => {
        for (const op of ops ?? []) {
          const at = now();
          const current = op.id ? t.loop(botId, op.id) : null;
          if (op.op === 'add' && !(current && current.status === 'open')) {
            const id = op.id && !current ? op.id : `l${crypto.randomBytes(3).toString('hex')}`;
            const open_ = t.loops(botId, 'open');
            let evicted = null;
            if (open_.length >= MAX_OPEN_LOOPS) {
              const oldest = [...open_].sort((a, b) => a.updatedAt - b.updatedAt)[0];
              t.putLoop(botId, oldest.id, 'dropped', at, loopData(oldest));
              evicted = oldest.id;
            }
            t.putLoop(botId, id, 'open', at, loopData({ text: clip(op.text, 200), wakeOn: op.wakeOn ?? null, due: op.due ?? null, taint: taintOf(taint), createdAt: at, workNotesVersion }));
            applied.push({ op: 'add', id, text: clip(op.text, 200), ...(evicted ? { evicted } : {}) });
            continue;
          }
          const target = current ?? null;
          if (!target || (target.status !== 'open' && op.op !== 'add')) { rejected++; continue; }
          if (op.op === 'resolve' || op.op === 'drop') {
            t.putLoop(botId, target.id, op.op === 'resolve' ? 'resolved' : 'dropped', at, loopData(target));
            applied.push({ op: op.op, id: target.id, text: target.text });
          } else {   // update（と、開いている id への add）
            const next = { ...target, text: op.text ? clip(op.text, 200) : target.text, ...(op.wakeOn !== undefined ? { wakeOn: op.wakeOn } : {}), ...(op.due !== undefined ? { due: op.due } : {}),
              taint: target.taint ?? taintOf(taint), workNotesVersion: op.text ? workNotesVersion : target.workNotesVersion ?? null };
            t.putLoop(botId, target.id, 'open', at, loopData(next));
            applied.push({ op: 'update', id: target.id, text: next.text });
          }
        }
      });
      if (applied.length) changed(botId);
      return { applied, rejected };
    },

    state(botId) {
      open();
      return { ...emptyState(), ...(states.get('brain', botId) ?? {}) };
    },
    setState(botId, patch) {
      open();
      const next = { ...service.state(botId), ...patch };
      states.save([['brain', botId, next]]);
      changed(botId);
      return next;
    },

    addSpend(channelId, botId, { day, percent = 0, tokens = 0 }) {
      open();
      const id = `${channelId}/${botId}`;
      const cur = states.get('brain.spend', id);
      const base = cur?.day === day ? cur : { day, percent: 0, tokens: 0 };
      states.save([['brain.spend', id, { day, percent: base.percent + percent, tokens: base.tokens + tokens }]]);
    },
    spentPercent(channelId, day) {
      open();
      return Object.values(states.ofKind('brain.spend', `${channelId}/`)).filter((v) => v.day === day).reduce((n, v) => n + (v.percent ?? 0), 0);
    },
    spentTokens(botId, day) {
      open();
      return Object.entries(states.ofKind('brain.spend')).filter(([id, v]) => id.endsWith(`/${botId}`) && v.day === day).reduce((n, [, v]) => n + (v.tokens ?? 0), 0);
    },

    clear(botId) {
      const t = open();
      const out = { stream: t.clearStream(botId), loops: t.clearLoops(botId) };
      changed(botId);
      return out;
    },
    close() { handle?.release(); handle = null; stream = null; states = null; },
  };
  return service;
}

/** brain_loops の data 列に入れる欄（id・status・updatedAt は列に持つ） */
function loopData(l) {
  return { text: l.text ?? '', wakeOn: l.wakeOn ?? null, due: l.due ?? null, taint: l.taint ?? null, createdAt: l.createdAt ?? l.updatedAt ?? 0, ...(l.workNotesVersion ? { workNotesVersion: l.workNotesVersion } : {}) };
}
