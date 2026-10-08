// ルーティンの保存（<data>/routines.json。`{ version: 1, routines: Routine[] }`）。形の正本は core/channels/types.mjs の Routine。
// 保存は core/atomic-file.mjs の writeAtomic、書き込みは全体で 1 本の直列化キュー。読めない版・壊れた JSON は読み込まずに止める
// （`RoutineStoreError`。上書きして消さない。bots.json と同じ方針）。最後に動いた時刻（last）もここに入る（取りこぼしの判定に使う）。
//
//   createRoutineStore({ file }) → RoutineStore
//     load(): Promise<void>               … 読む（無ければ空）。読めなければ RoutineStoreError を投げ、以後の書き込みも断る
//     list(): Routine[]・get(id): Routine|null
//     put(routine): Promise<Routine>      … 追加か置き換え（id で）
//     update(id, fn): Promise<Routine>    … fn(現在の写し) が返したもので置き換える。直列化の中で読み直すので競合しない。fn が null を返したら書かずに今の値を返す
//     remove(id): Promise<Routine|null>
//
// Routine に足した任意の欄（docs/channels.md）: armedAt（予定を数え始める基準の時刻。作った・再開した・トリガを変えた・発火した時刻）。
// last に足した任意の欄: postId（その実行の根の投稿。Pleiad が止まって終わりを記録できなかった実行を、起動時に stopped にするのに使う）。
import fs from 'node:fs/promises';
import path from 'node:path';
import { writeAtomic } from '../atomic-file.mjs';
import { isAuthor, POST_STATES } from '../channels/types.mjs';
import { validateTrigger, TriggerError } from './schedule.mjs';

export const ROUTINES_VERSION = 1;
export const APPROVAL_TIMEOUT_DEFAULT_MIN = 30;
export const APPROVAL_TIMEOUT_MAX_MIN = 24 * 60;
export const NAME_MAX = 80;
export const PROMPT_MAX = 12000;
const TRANSIENT_READ = new Set(['EBUSY', 'EACCES', 'EPERM', 'EMFILE', 'ENFILE']);
const READ_RETRIES = [60, 200, 500];
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** code は ROUTINES_CORRUPT・ROUTINES_UNSUPPORTED_VERSION・ROUTINES_UNREADABLE（読めない）／ ROUTINE_NOT_FOUND・ROUTINE_INVALID（操作の失敗。ops が OpError にする） */
export class RoutineStoreError extends Error {
  constructor(code, message, extra = {}) { super(message); this.name = 'RoutineStoreError'; this.code = code; Object.assign(this, extra); }
}

const str = (v, d = '') => (typeof v === 'string' ? v : d);

/** 名前・指示・待つ時間の検査。問題があれば理由の文（英語の短い説明。ops が INVALID の detail に使う）、無ければ null */
export function nameProblem(name) {
  if (typeof name !== 'string' || !name.trim()) return 'name: required';
  if (/[\r\n]/.test(name)) return 'name: must be a single line';
  if ([...name.trim()].length > NAME_MAX) return `name: at most ${NAME_MAX} characters`;
  return null;
}
export const promptProblem = (prompt) => (typeof prompt !== 'string' || !prompt.trim() ? 'prompt: required'
  : [...prompt].length > PROMPT_MAX ? `prompt: at most ${PROMPT_MAX} characters` : null);
export const timeoutProblem = (min) => (Number.isInteger(min) && min >= 1 && min <= APPROVAL_TIMEOUT_MAX_MIN ? null : `approvalTimeoutMin: an integer 1-${APPROVAL_TIMEOUT_MAX_MIN}`);

function normalizeLast(last) {
  if (!last || typeof last !== 'object' || !Number.isFinite(last.at) || typeof last.runId !== 'string') return undefined;
  return {
    at: last.at, runId: last.runId, state: POST_STATES.includes(last.state) ? last.state : 'stopped',
    ...(typeof last.postId === 'string' && last.postId ? { postId: last.postId } : {}),
  };
}

/** 読んだ 1 件を Routine の形に整える。必須の欄が足りない・トリガが読めないものは null（読み込まず、ログへ出す） */
export function normalizeRoutine(raw, now = Date.now()) {
  if (!raw || typeof raw !== 'object') return null;
  if (typeof raw.id !== 'string' || !raw.id || nameProblem(raw.name) || typeof raw.botId !== 'string' || !raw.botId
    || typeof raw.channelId !== 'string' || !raw.channelId || promptProblem(raw.prompt)) return null;
  let trigger;
  try { trigger = validateTrigger(raw.trigger); } catch (e) { if (e instanceof TriggerError) return null; throw e; }
  const createdAt = Number.isFinite(raw.createdAt) ? raw.createdAt : now;
  const last = normalizeLast(raw.last);
  return {
    id: raw.id, name: raw.name.trim(), botId: raw.botId, channelId: raw.channelId, prompt: raw.prompt, trigger,
    mode: str(raw.mode),
    approvalTimeoutMin: timeoutProblem(raw.approvalTimeoutMin) ? APPROVAL_TIMEOUT_DEFAULT_MIN : raw.approvalTimeoutMin,
    paused: raw.paused === true,
    createdBy: isAuthor(raw.createdBy) ? raw.createdBy : { kind: 'human' },
    createdAt,
    ...(Number.isFinite(raw.armedAt) ? { armedAt: raw.armedAt } : {}),
    ...(last ? { last } : {}),
  };
}

export function createRoutineStore({ file } = {}) {
  if (!file) throw new Error('createRoutineStore: file is required');
  let routines = [];
  let loaded = false;           // load() が一度成功したか。まだなら、書き込みは先に読む（読む前に書くと、ファイルの既存の行を消す）
  let broken = null;            // 読めなかった理由（RoutineStoreError）。立っている間は書かない
  let queue = Promise.resolve();
  const serial = (fn) => { const task = queue.catch(() => {}).then(fn); queue = task; return task; };
  const copy = (r) => structuredClone(r);
  const guard = () => { if (broken) throw broken; };
  // 書き込みの前に、まだ読んでいなければ読む（キューの中で呼ぶ）。起動の load より先に来た作成が、ファイルの既存の行を上書きして消さない
  const ready = async () => { if (!loaded && !broken) await load(); guard(); };
  const save = async () => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await writeAtomic(file, `${JSON.stringify({ version: ROUTINES_VERSION, routines }, null, 2)}\n`);
  };

  // 読み込みも書き込みと同じ直列化キューに並べる。キューの外で走ると、起動中に作られた行（put が mkdir を待っている間）や、読んでいる間に作られた行を、読み込みの結果で丸ごと置き換えて消す
  const load = async () => {
    let text;
    for (let attempt = 0; ; attempt++) {
      try { text = await fs.readFile(file, 'utf8'); break; }
      catch (e) {
        if (e.code === 'ENOENT') { routines = []; broken = null; loaded = true; return; }
        if (TRANSIENT_READ.has(e.code) && attempt < READ_RETRIES.length) { await wait(READ_RETRIES[attempt]); continue; }
        // 読めなかっただけで「ルーティンが 0 件」と見なさない（次の保存で routines.json を空で上書きしてしまう）。読み直すには再起動する
        broken = new RoutineStoreError('ROUTINES_UNREADABLE', `routines.json could not be read (${e.code ?? e.message}); check whether another program has it open: ${file}`);
        throw broken;
      }
    }
    let data;
    try { data = JSON.parse(text); }
    catch { broken = new RoutineStoreError('ROUTINES_CORRUPT', `routines.json is not valid JSON: ${file}`); throw broken; }
    if (data?.version !== ROUTINES_VERSION || !Array.isArray(data.routines)) {
      broken = new RoutineStoreError('ROUTINES_UNSUPPORTED_VERSION', `routines.json has an unsupported version (${data?.version}): ${file}`);
      throw broken;
    }
    broken = null;
    loaded = true;
    routines = data.routines.map((r) => normalizeRoutine(r)).filter(Boolean);
    if (routines.length < data.routines.length) console.error(`  routines: ${data.routines.length - routines.length} row(s) of routines.json could not be read and were dropped: ${file}`);
  };

  return {
    file,
    get problem() { return broken; },
    load: () => serial(load),
    list: () => routines.map(copy),
    get: (id) => { const r = routines.find((x) => x.id === id); return r ? copy(r) : null; },
    put(routine) {
      return serial(async () => {
        await ready();
        const next = normalizeRoutine(routine, routine?.createdAt);
        if (!next) throw new RoutineStoreError('ROUTINE_INVALID', 'routine is missing a required field or has an unreadable trigger');
        const i = routines.findIndex((x) => x.id === next.id);
        const before = routines;
        routines = i < 0 ? [...routines, next] : routines.map((x, j) => (j === i ? next : x));
        try { await save(); } catch (e) { routines = before; throw e; }
        return copy(next);
      });
    },
    update(id, fn) {
      return serial(async () => {
        await ready();
        const i = routines.findIndex((x) => x.id === id);
        if (i < 0) throw new RoutineStoreError('ROUTINE_NOT_FOUND', `no such routine: ${id}`, { id });
        const changed = await fn(copy(routines[i]));
        if (changed === null || changed === undefined) return copy(routines[i]);
        const next = normalizeRoutine(changed, routines[i].createdAt);
        if (!next || next.id !== id) throw new RoutineStoreError('ROUTINE_INVALID', 'update must keep a valid routine with the same id');
        const before = routines;
        routines = routines.map((x, j) => (j === i ? next : x));
        try { await save(); } catch (e) { routines = before; throw e; }
        return copy(next);
      });
    },
    remove(id) {
      return serial(async () => {
        await ready();
        const found = routines.find((x) => x.id === id);
        if (!found) return null;
        const before = routines;
        routines = routines.filter((x) => x.id !== id);
        try { await save(); } catch (e) { routines = before; throw e; }
        return copy(found);
      });
    },
  };
}
