// wait_until の問いを決定モデル（perplexity/pplx-decider-v1.1-27b、OpenRouter の decisions）に 1 回聞く（ADR 0165）。
// 送るのは撮った画面（JPEG）と問いだけ。キーは設定 › API キーの割り当て computer:decider（ADR 0155）。
// 失敗は決まった code（timeout / network / http_<status> / bad_response）だけで返し、キー・応答の本文は文にもログにも出さない。
// 応答の読み方は 1 か所（parseDecision）。形は委譲の判定器（core/delegation-judges.mjs の askJev）と同じ answers.<名前>.noul。

export const DECIDER_MODEL = 'perplexity/pplx-decider-v1.1-27b';
/** 1 回の往復の上限（検証の中央値は 898ms） */
export const DECIDER_TIMEOUT_MS = 6000;
/** 送る画面の上限（検証は 1440×900。それより小さいと正答率が 2〜7 ポイント落ちた） */
export const DECIDER_SHOT = Object.freeze({ maxEdge: 1440, maxPixels: 1_300_000, quality: 75 });
/** 問いの上限（文字） */
export const UNTIL_MAX = 500;
const MAX_BODY = 64 * 1024;

// 送り先。AGENT_HOST_OPENROUTER_API はテストの偽物用（本物へは送らない）。判定器と同じ変数
const apiBase = env => String(env.AGENT_HOST_OPENROUTER_API || 'https://openrouter.ai/api').replace(/\/+$/, '');

/** 送る本文。問いは「完了したか」の向き（はい = 完了） */
export function decisionBody(jpegBase64, until) {
  return {
    model: DECIDER_MODEL,
    state: [{ type: 'text', text: 'Screenshot' }, { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${jpegBase64}` } }],
    questions: { done: { type: 'noul', instructions: until, criteria: { true: 'Yes', false: 'No' } } },
  };
}

/** 応答から はい の確率（0〜1）。形が違えば null */
export function parseDecision(data) {
  const answer = data?.answers?.done, p = answer?.noul;
  if (answer?.type !== 'noul' || typeof p !== 'number' || !Number.isFinite(p) || p < 0 || p > 1) return null;
  return Math.round(p * 1000) / 1000;
}

/**
 * 1 回聞く。戻りは { ok: true, p } か { ok: false, code }。投げない
 * @param {object} o
 * @param {string} o.key
 * @param {Uint8Array} o.jpeg
 * @param {string} o.until
 */
export async function askDecider({ key, jpeg, until, fetch: fetchImpl = globalThis.fetch, env = process.env, timeoutMs = DECIDER_TIMEOUT_MS, signal }) {
  const body = JSON.stringify(decisionBody(Buffer.from(jpeg).toString('base64'), until));
  const signals = [AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])];
  let res;
  try {
    res = await fetchImpl(`${apiBase(env)}/alpha/decisions`, { method: 'POST', redirect: 'manual', signal: AbortSignal.any(signals),
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'X-Title': 'Pleiad' }, body });
  } catch (e) {
    return { ok: false, code: e?.name === 'TimeoutError' || e?.name === 'AbortError' ? 'timeout' : 'network' };
  }
  if (!res.ok) { await res.body?.cancel?.().catch(() => {}); return { ok: false, code: `http_${res.status}` }; }
  let text;
  try { text = await res.text(); } catch (e) { return { ok: false, code: e?.name === 'TimeoutError' || e?.name === 'AbortError' ? 'timeout' : 'bad_response' }; }
  if (text.length > MAX_BODY) return { ok: false, code: 'bad_response' };
  let data;
  try { data = JSON.parse(text); } catch { return { ok: false, code: 'bad_response' }; }
  const p = parseDecision(data);
  return p === null ? { ok: false, code: 'bad_response' } : { ok: true, p };
}
