// bot の予約（自分で決めた時刻に、決めた会話で、メモを持って起きる。ADR 0136）。心拍（pulse.mjs）より軽い、1 回きりの「後で起きる」。
// 会話の中のタイマー（Claude Code の Cron・sleep）は、その会話のプロセスが動いている間しか鳴らず、夜のあいだ 1 回も動かずに消えた。
// ここは Pleiad 本体（サーバー）が持つので、bot のターンが走っていなくても時刻になれば起きる。心拍の ON・OFF には依らない。
//
// 守っていること:
//   - 予約は DB の行（brain_wakes。ADR 0115）。再起動しても残る。待っているものは 1 体 WAKE_PENDING_MAX 件まで、終わったものは WAKE_KEEP_MS で消す
//   - 時刻は今から WAKE_MIN_LEAD_MS 以上・WAKE_MAX_AHEAD_MS 以内。1 回きり（繰り返しはルーティン）
//   - 起こし方は心拍の引き継ぎと同じ道（dispatch.wakeReserved → inbox の inner → pump → startTurn）。承認・強い bot の確認・［止める］・休憩中がそのまま効く
//   - Pleiad が止まっていた間に時刻を過ぎた予約は、起動後に遅れて 1 回だけ起きる。同じ会話の予約が重なっていたら 1 回にまとめる（何十回も重ねない）
//   - 自発の分なので予算から引く（心拍と同じ。スレッドならそのチャンネル、DM なら bot の家のチャンネル）。予算が無い・休憩中は捨てずに待ち、WAKE_RETRY_MS ごとに見直す
//   - 止めたスレッド・アーカイブしたチャンネル・消した bot・もう無い会話の予約は起こさず、理由を付けて閉じる
//
//   createWakes({ dataDir, channels, bots, dispatch, budget, clock, now, emit, localeOf, tickMs }) → Wakes
//     dispatch … { wakeReserved({ botId, sessionId, channelId, threadId, why, text, homeChannelId, taint }) → { ok, reason? }, restingUntil(bot) }
//     budget … createBudget の返り（allowsBrain）
//   Wakes:
//     add({ botId, sessionId, channelId, threadId, at, note, taint }): Wake   … 投げる: WakeError（code: 'WAKE_TIME' | 'WAKE_LIMIT'）
//     list(botId, { status? }): Wake[]・get(id): Wake | null
//     cancel(botId, id): Wake | null   … 待っているものだけ。別の bot の予約は null
//     clear(botId): number   … bot を消したとき
//     tick(): Promise<number>   … 時刻の来た予約を起こす（起こした回数）。テストが直に呼ぶ
//     start()・stop()・close()
//   Wake: { id, botId, status: 'pending' | 'fired' | 'cancelled' | 'dropped', at, note, sessionId, channelId, threadId, createdAt, taint,
//           firedAt?, late?, reason?, retryAt?, waiting? }
//   emit({ type: 'brainChanged', botId }) を、予約が変わったときに出す
import crypto from 'node:crypto';
import { agentT } from '../i18n.mjs';
import { openData } from '../data-schema.mjs';
import { wakeTable } from '../db.mjs';
import { whenOf } from './inner.mjs';
import { pickHome } from './pulse.mjs';

const MIN = 60_000;
const DAY = 86_400_000;
export const WAKE_NOTE_MAX = 500;
export const WAKE_PENDING_MAX = 20;
export const WAKE_MIN_LEAD_MS = MIN;
export const WAKE_MAX_AHEAD_MS = 30 * DAY;
export const WAKE_KEEP_MS = 7 * DAY;
/** 時刻を確かめる間隔の上限（PC のスリープでタイマーが遅れても、起きてからこの間に気付く） */
export const WAKE_TICK_MS = 30_000;
/** 予算なし・休憩中で待たせた予約を見直す間隔 */
export const WAKE_RETRY_MS = 10 * MIN;
/** これ以上遅れて起きたら「遅れた」と書く */
export const WAKE_LATE_MS = 2 * MIN;

const log = (...a) => console.error('  wakes:', ...a);
const errText = (e) => String(e?.message ?? e);
const clip = (s, n) => [...String(s ?? '').replace(/\r\n/g, '\n').trim()].slice(0, n).join('');
const taintOf = (v) => (v === 'webhook' || v === 'web' ? v : null);
/** 起こせなかったときに、閉じずに待たせる理由（時間が経てば起こせる） */
const TRANSIENT = new Set(['resting', 'budget', 'closed']);

export class WakeError extends Error {
  constructor(code, detail = {}) { super(code); this.code = code; this.detail = detail; }
}

export function createWakes({ dataDir, channels, bots, dispatch, budget, clock, now = () => clock.now(), emit = () => {}, localeOf = () => 'ja', tickMs = WAKE_TICK_MS } = {}) {
  let handle = null, table = null;
  let timer = null;
  let closed = true;
  let running = null;
  const open = () => { if (!table) { handle = openData(dataDir); table = wakeTable(handle.db); } return table; };
  const changed = (botId) => { try { emit({ type: 'brainChanged', botId }); } catch { /* 画面への知らせの失敗で保存を戻さない */ } };
  const save = (w) => { const { id, botId, status, at, ...data } = w; open().put(id, botId, status, at, data); return w; };

  function add({ botId, sessionId, channelId, threadId = null, at, note, taint = null }) {
    const t = open();
    const current = now();
    if (!Number.isFinite(at) || at < current + WAKE_MIN_LEAD_MS - 1000 || at > current + WAKE_MAX_AHEAD_MS) {
      throw new WakeError('WAKE_TIME', { min: Math.round(WAKE_MIN_LEAD_MS / MIN), maxDays: Math.round(WAKE_MAX_AHEAD_MS / DAY) });
    }
    if (t.countPending(botId) >= WAKE_PENDING_MAX) throw new WakeError('WAKE_LIMIT', { max: WAKE_PENDING_MAX });
    const wake = save({ id: `w${crypto.randomBytes(4).toString('hex')}`, botId, status: 'pending', at, note: clip(note, WAKE_NOTE_MAX), sessionId, channelId, threadId: threadId ?? null, createdAt: current, ...(taintOf(taint) ? { taint: taintOf(taint) } : {}) });
    t.prune(current - WAKE_KEEP_MS);
    changed(botId);
    arm();
    return wake;
  }

  function cancel(botId, id) {
    const w = open().get(id);
    if (!w || w.botId !== botId || w.status !== 'pending') return null;
    const next = save({ ...w, status: 'cancelled', reason: 'cancelled', closedAt: now() });
    changed(botId);
    return next;
  }

  /** 閉じる（起こさない）。reason は残す */
  const drop = (w, reason) => save({ ...w, status: 'dropped', reason, closedAt: now() });

  /** 待たせる（予算なし・休憩中）。WAKE_RETRY_MS 後に見直す */
  const wait = (w, reason) => save({ ...w, waiting: reason, retryAt: now() + WAKE_RETRY_MS });

  /** 起こす文（`<pleiad-inner kind="wake">` の中身）。重なった予約はまとめて 1 回 */
  function wakeText(list, at) {
    const l = localeOf();
    const first = Math.min(...list.map((w) => w.at));
    const lines = [agentT(l, 'brain.wake.intro')];
    for (const w of list) lines.push(agentT(l, 'brain.wake.item', { at: whenOf(w.at, at), note: w.note || '—' }));
    if (at - first > WAKE_LATE_MS) lines.push(agentT(l, 'brain.wake.late', { at: whenOf(first, at) }));
    if (list.some((w) => w.taint)) lines.push(agentT(l, 'brain.wake.taint'));
    lines.push(agentT(l, 'brain.wake.after'));
    return lines.join('\n');
  }

  /** 同じ会話へ起こす予約の組（時刻の順）を、1 回で起こす */
  async function fireGroup(list) {
    const head = list[0];
    const bot = await bots.get({ botId: head.botId }).catch(() => null);
    if (!bot) { for (const w of list) drop(w, 'nobot'); return false; }
    const channel = await channels.get({ channelId: head.channelId }).catch(() => null);
    if (!channel || channel.archivedAt) { for (const w of list) drop(w, 'archived'); return false; }
    if (head.threadId) {
      const th = await channels.threads.get(head.channelId, head.threadId).catch(() => null);
      if (th?.stopped) { for (const w of list) drop(w, 'stopped'); return false; }
    }
    if (dispatch.restingUntil?.(bot)) { for (const w of list) wait(w, 'resting'); return false; }
    // 予算: スレッドならそのチャンネル、DM なら bot の家のチャンネル。家が無い DM だけの bot は数える先が無いので止めない（DM は予算に数えない。ADR 0119）
    const home = channel.kind === 'channel' ? channel : pickHome(bot, await channels.list().catch(() => []));
    if (home && !(await budget.allowsBrain({ channelId: home.id, botId: bot.id }))) { for (const w of list) wait(w, 'budget'); return false; }
    const at = now();
    const result = await dispatch.wakeReserved({
      botId: bot.id, sessionId: head.sessionId, channelId: head.channelId, threadId: head.threadId ?? null,
      why: list.map((w) => w.note).filter(Boolean).join(' / '), text: wakeText(list, at), homeChannelId: home?.id ?? null, taint: list.find((w) => w.taint)?.taint ?? null,
    }).catch((e) => ({ ok: false, reason: errText(e) }));
    if (!result?.ok) {
      const reason = result?.reason ?? 'failed';
      for (const w of list) (TRANSIENT.has(reason) ? wait(w, reason) : drop(w, reason));
      return false;
    }
    for (const w of list) {
      const { waiting: _w, retryAt: _r, ...rest } = w;
      save({ ...rest, status: 'fired', firedAt: at, ...(at - w.at > WAKE_LATE_MS ? { late: true } : {}), ...(list.length > 1 ? { merged: list.length } : {}) });
    }
    return true;
  }

  async function runTick() {
    const t = open();
    const at = now();
    const due = t.due(at).filter((w) => !(w.retryAt > at));
    if (!due.length) return 0;
    const groups = new Map();
    for (const w of due) {
      const key = `${w.botId}\u0000${w.sessionId}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(w);
    }
    let fired = 0;
    const touched = new Set();
    for (const list of groups.values()) {
      if (closed) break;
      try { if (await fireGroup(list)) fired++; }
      catch (e) { log('could not wake a bot:', errText(e)); }
      touched.add(list[0].botId);
    }
    for (const botId of touched) changed(botId);
    return fired;
  }

  /** 時刻の来た予約を起こす。重ねて呼ばれても 1 本だけ走る */
  function tick() {
    if (!running) running = runTick().catch((e) => { log('tick failed:', errText(e)); return 0; }).finally(() => { running = null; arm(); });
    return running;
  }

  /** 次の予約の時刻まで（長くても tickMs）眠る */
  function arm() {
    if (closed) return;
    if (timer) clock.clearTimer(timer);
    timer = null;
    // 待たせている予約（予算なし・休憩中）は retryAt まで数えない（過ぎた時刻のまま 1 秒ごとに起きない）
    let next = null;
    try {
      for (const w of open().due(now() + tickMs)) { const at = Math.max(w.at, w.retryAt ?? 0); if (next == null || at < next) next = at; }
    } catch (e) { log('could not read the next wake:', errText(e)); }
    const delay = next == null ? tickMs : Math.max(1000, Math.min(tickMs, next - now()));
    timer = clock.setTimer(() => { timer = null; tick(); }, delay);
    timer?.unref?.();
  }

  return {
    add, cancel, tick,
    now: () => now(),
    get: (id) => open().get(id),
    list: (botId, { status = null } = {}) => open().list(botId, status),
    clear(botId) { const n = open().clear(botId); changed(botId); return n; },
    // 起動: 止まっていた間に過ぎた予約は、すぐに 1 回だけ起こす（tick が同じ会話の分をまとめる）。dispatch の配り直し（start の setTimeout 0）の後に回す
    async start() {
      closed = false;
      arm();
      const first = setTimeout(() => { if (!closed) tick(); }, 0);
      first.unref?.();
    },
    stop() { closed = true; if (timer) clock.clearTimer(timer); timer = null; },
    close() { this.stop(); handle?.release(); handle = null; table = null; },
  };
}
