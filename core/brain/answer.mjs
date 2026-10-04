// 安いモデルの返事（心拍 1 回分の JSON）の読み取り（ADR 0126）。純粋な関数。型は最小にして、中身は自由。
//
//   parseBeat(raw, { now }) → { do, thought, refs, loops, wakeAt, handoff }   … 読めなければ投げる（Error('pulse returned no JSON object') など）
//     do … 'none' | 'think' | 'act' | 'sleep'（知らない値は 'none'）
//     thought … summary から読む活動の要約（THOUGHT_MAX 字まで。返りの欄名は内部互換）
//     refs … 続きなら前の行（seq）か気がかりの id（5 つまで）
//     loops … [{ op: 'add'|'update'|'resolve'|'drop', id?, text?, wakeOn?, due? }]（4 つまで）。wakeOn・due は parseWakeOn・parseTime で形にする
//     wakeAt … 次に起きたい時刻（ms。wakeAt の時刻・wakeInMin の分のどちらでも）。無ければ null
//     handoff … { why, where? } | null。do が 'act' のときだけ
//   parseWakeOn(value) → { thread?, word?, at? } | null  … 'thread:p_…'・'word:語'・時刻・自由な語（語として）。オブジェクトも受ける
//   parseTime(value, now) → ms | null                    … 数（ms）・ISO・'HH:MM'（今日、過ぎていれば明日）
export const THOUGHT_MAX = 200;
export const LOOP_TEXT_MAX = 200;
export const WHY_MAX = 300;
export const LOOP_OPS = Object.freeze(['add', 'update', 'resolve', 'drop']);
const DOES = Object.freeze(['none', 'think', 'act', 'sleep']);

const clip = (value, max) => [...String(value ?? '').replace(/\s+/g, ' ').trim()].slice(0, max).join('');

export function parseTime(value, now = Date.now()) {
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value : null;
  const text = String(value ?? '').trim();
  if (!text) return null;
  const clock = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(text);
  if (clock) {
    const d = new Date(now);
    d.setHours(Number(clock[1]), Number(clock[2]), 0, 0);
    if (d.getTime() <= now) d.setDate(d.getDate() + 1);
    return d.getTime();
  }
  if (!/\d{4}-\d{2}-\d{2}/.test(text)) return null;
  const at = Date.parse(text);
  return Number.isFinite(at) ? at : null;
}

export function parseWakeOn(value, now = Date.now()) {
  if (value == null || value === '') return null;
  if (typeof value === 'object' && !Array.isArray(value)) {
    const out = {};
    if (typeof value.thread === 'string' && value.thread.trim()) out.thread = value.thread.trim().slice(0, 80);
    if (typeof value.word === 'string' && value.word.trim()) out.word = clip(value.word, 40);
    const at = parseTime(value.at, now);
    if (at) out.at = at;
    return Object.keys(out).length ? out : null;
  }
  const text = String(value).trim();
  if (!text) return null;
  const thread = /^thread:\s*(\S+)$/i.exec(text);
  if (thread) return { thread: thread[1].slice(0, 80) };
  const word = /^word:\s*(.+)$/i.exec(text);
  if (word) return { word: clip(word[1], 40) };
  const at = parseTime(text, now);
  if (at) return { at };
  return { word: clip(text, 40) };
}

function jsonObject(raw) {
  const text = String(raw ?? '').trim();
  const fenced = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
  try { const parsed = JSON.parse(fenced); if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed; } catch { /* 前後に文があるときは下で { } を探す */ }
  const from = fenced.indexOf('{'), to = fenced.lastIndexOf('}');
  if (from >= 0 && to > from) {
    try { const parsed = JSON.parse(fenced.slice(from, to + 1)); if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed; } catch { /* 読めない */ }
  }
  throw new Error('pulse returned no JSON object');
}

export function parseBeat(raw, { now = Date.now() } = {}) {
  const o = jsonObject(raw);
  const action = o.do === 'note' ? 'think' : DOES.includes(o.do) ? o.do : 'none';
  const refs = (Array.isArray(o.refs) ? o.refs : []).map((r) => String(r).trim().slice(0, 40)).filter(Boolean).slice(0, 5);
  const loops = [];
  for (const l of Array.isArray(o.loops) ? o.loops : []) {
    if (!l || !LOOP_OPS.includes(l.op) || loops.length >= 4) continue;
    const id = typeof l.id === 'string' && /^[\w-]{1,40}$/.test(l.id.trim()) ? l.id.trim() : null;
    const text = clip(l.text, LOOP_TEXT_MAX);
    if (l.op === 'add' && !text) continue;
    if (l.op !== 'add' && !id) continue;
    loops.push({ op: l.op, ...(id ? { id } : {}), ...(text ? { text } : {}), ...(l.wakeOn !== undefined ? { wakeOn: parseWakeOn(l.wakeOn, now) } : {}), ...(l.due !== undefined ? { due: parseTime(l.due, now) } : {}) });
  }
  const minutes = Number(o.wakeInMin);
  const wakeAt = Number.isFinite(minutes) && minutes > 0 ? now + minutes * 60_000 : parseTime(o.wakeAt, now);
  const why = clip(o.handoff?.why, WHY_MAX);
  const where = typeof o.handoff?.where === 'string' && o.handoff.where.trim() ? o.handoff.where.trim().slice(0, 80) : null;
  return {
    do: action, thought: clip(o.summary, THOUGHT_MAX), refs, loops, wakeAt: wakeAt ?? null,
    handoff: action === 'act' && why ? { why, ...(where ? { where } : {}) } : null,
  };
}
