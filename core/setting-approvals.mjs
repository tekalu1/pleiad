// 設定の変更の承認（ADR 0088）。承認を待たずに返した要求の台帳と、決着した結果を会話へ届ける待ち行列。
//
// 承認カード（core/server.mjs の askPermission）はメモリだけで、再起動をまたがない。台帳は <データ置き場>/setting-approvals.json に置き、
// 起動したとき前の起動で待っていた要求を「再起動で取り下げた」結果に変えて届ける（エージェントが待ち続けないように）。
// 届ける本文と届け方（走っているターンへ途中送信か、空いてから新しいターンか）は deliver が決める（委譲の完了通知と同じ経路。ADR 0057）。
//
//   pending  [{ requestId, sessionId, key, op, askedAt }]                  人の答えを待っている要求
//   notices  [{ requestId, sessionId, key, op, outcome, error?, at, state }] 届ける結果。state は queued か delivering
//
// outcome: allowed（許可して変えた）・denied（拒否）・failed（許可したが変えられなかった。error に理由）・
//          superseded（同じ会話・同じ設定への新しい要求に置き換えた）・restart（再起動で取り下げた）
// 届け方は委譲の完了通知と同じく「多くても 1 回」: 送る前に delivering を保存し、送ったか分からないまま落ちたら次の起動で捨てる。
import fs from 'node:fs/promises';
import path from 'node:path';
import { writeAtomic } from './atomic-file.mjs';

export const SETTING_APPROVALS_FILE = 'setting-approvals.json';
export const OUTCOMES = ['allowed', 'denied', 'failed', 'superseded', 'restart'];

/**
 * @param dataDir    データ置き場
 * @param deliver    (sessionId, notices) => 'ok' | 'requeue' | 'error'。requeue は受け取られていない（会話が空いてから送り直す）。
 *                   error は渡ったか分からない（送り直さない）
 * @param intervalMs 届け直しを試す間隔
 */
export async function createSettingApprovals({ dataDir, deliver, now = Date.now, intervalMs = 1000, onError = () => {} }) {
  const file = path.join(dataDir, SETTING_APPROVALS_FILE);
  let pending = [], notices = [];
  try {
    const saved = JSON.parse(await fs.readFile(file, 'utf8'));
    // 前の起動で答えを待っていた要求は、カードがもう無い。取り下げた結果として届ける
    for (const p of Array.isArray(saved?.pending) ? saved.pending : []) {
      if (p?.requestId && p.sessionId) notices.push({ ...pick(p), outcome: 'restart', at: now(), state: 'queued' });
    }
    // 送っている途中で落ちた結果は、渡ったか分からないので送り直さない
    for (const n of Array.isArray(saved?.notices) ? saved.notices : []) {
      if (n?.requestId && n.sessionId && OUTCOMES.includes(n.outcome) && n.state !== 'delivering') notices.push({ ...n, state: 'queued' });
    }
  } catch (e) { if (e?.code !== 'ENOENT') onError(e); }
  /** 起動時に取り下げた要求（ログ用） */
  const restored = notices.filter((n) => n.outcome === 'restart').length;

  let chain = Promise.resolve();
  const save = () => {
    const body = JSON.stringify({ version: 1, pending, notices }, null, 2);
    chain = chain.then(() => writeAtomic(file, body)).catch(onError);
    return chain;
  };
  if (restored || notices.length) await save();

  const sending = new Set();
  async function deliverSession(sessionId) {
    if (sending.has(sessionId)) return;
    const list = notices.filter((n) => n.sessionId === sessionId && n.state === 'queued');
    if (!list.length) return;
    sending.add(sessionId);
    try {
      for (const n of list) n.state = 'delivering';
      await save();
      const outcome = await Promise.resolve().then(() => deliver(sessionId, list.map((n) => ({ ...n })))).catch(() => 'error');
      if (outcome === 'requeue') for (const n of list) n.state = 'queued';
      else notices = notices.filter((n) => !list.includes(n));
      await save();
    } finally { sending.delete(sessionId); }
  }
  let kicking = false;
  async function kick() {
    if (kicking) return;
    kicking = true;
    try { for (const id of new Set(notices.filter((n) => n.state === 'queued').map((n) => n.sessionId))) await deliverSession(id); }
    finally { kicking = false; }
  }
  const timer = setInterval(() => { if (notices.length) kick().catch(onError); }, intervalMs);
  timer.unref?.();

  return {
    restored,
    /** 答えを待つ要求を台帳に足す（同じ requestId は置き換える。受領証が合わず聞き直したとき） */
    add(entry) {
      pending = pending.filter((p) => p.requestId !== entry.requestId);
      pending.push({ ...pick(entry), askedAt: now() });
      return save();
    },
    /** 同じ会話・同じ設定（設定でない操作は同じ操作）で答えを待っている要求 */
    pendingFor: (sessionId, key, op) => pending.filter((p) => p.sessionId === sessionId && p.key === (key ?? null) && p.op === (op ?? null)).map((p) => ({ ...p })),
    has: (requestId) => pending.some((p) => p.requestId === requestId),
    /** 決着。台帳から外し、結果を届ける列に積む。返りは外した要求（無ければ null） */
    async settle(requestId, outcome, extra = {}) {
      const entry = pending.find((p) => p.requestId === requestId);
      if (!entry) return null;
      pending = pending.filter((p) => p !== entry);
      notices.push({ ...pick(entry), outcome, ...(extra.error ? { error: String(extra.error) } : {}), at: now(), state: 'queued' });
      await save();
      kick().catch(onError);
      return { ...entry };
    },
    /** 途中送信で渡した結果が読まれずに捨てられた。もう一度届ける列に戻す */
    async requeue(list) {
      for (const n of list) if (!notices.some((x) => x.requestId === n.requestId && x.outcome === n.outcome)) notices.push({ ...n, state: 'queued' });
      await save();
      kick().catch(onError);
    },
    /** 会話が空いたかもしれない。溜まっている結果を届けてみる */
    changed: () => { if (notices.length) kick().catch(onError); },
    snapshot: () => ({ pending: pending.map((p) => ({ ...p })), notices: notices.map((n) => ({ ...n })) }),
    flush: () => chain,
    close: () => clearInterval(timer),
  };
}

const pick = ({ requestId, sessionId, key, op }) => ({ requestId, sessionId, key: key ?? null, op: op ?? null });
