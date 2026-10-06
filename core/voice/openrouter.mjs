// 通話モードの OpenRouter への POST（音声認識と読み上げで共有）。
// 出どころ: vtc-web gateway/src/providers/openrouter.ts を .mjs へ移した（ZDR の長い説明と型を外した）。
//
// 失敗の種類（kind）で、呼び出し側が引き直さなくて済むようにする:
//   timeout    ヘッダが headersTimeoutMs 以内に来ない。やり直さない（既に遅い）
//   permanent  429 / 5xx 以外の 4xx（400・401・402 など）。同じ形を送り直しても同じ結果
//   transient  429 / 5xx / つながらない / こちらから中断した。呼び出し側がやり直すかを決める
// 既定では 429・5xx・つながらないを 1 回だけやり直す（Retry-After は上限 2 秒）。音声認識に予備のモデルがあるときは 429 を待たず予備へ送る（retryRateLimited: false）。
//
// キーはヘッダにだけ載せ、ログ・エラーの文・画面へ出さない。エラーの文には上流の応答の先頭 200 字だけを入れ、キーが入っていたら伏せる。

export const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';
const DEFAULT_RETRY_WAIT_MS = 300;
const MAX_RETRY_WAIT_MS = 2000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 通話の送り先。AGENT_HOST_VOICE_API はテストの偽物用（本物へは送らない。tests/lib/server.mjs が既定で閉じたポートを向ける） */
export const voiceBaseUrl = (env = process.env) => (env.AGENT_HOST_VOICE_API || DEFAULT_BASE_URL).replace(/\/+$/, '');

function retryWaitMs(header) {
  if (header === null || header === undefined || String(header).trim() === '') return DEFAULT_RETRY_WAIT_MS;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.min(MAX_RETRY_WAIT_MS, Math.max(0, seconds * 1000));
  const at = Date.parse(header);
  return Number.isNaN(at) ? DEFAULT_RETRY_WAIT_MS : Math.min(MAX_RETRY_WAIT_MS, Math.max(0, at - Date.now()));
}

export class VoiceHttpError extends Error {
  /** @param {string} message @param {'timeout'|'permanent'|'transient'} kind */
  constructor(message, kind, { status = null, retryAfter = null, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'VoiceHttpError';
    this.kind = kind;
    this.status = status;
    this.retryAfter = retryAfter;
    this.rateLimited = status === 429;
  }
}

/** 文の中からキー（と Bearer の値）を伏せる */
export function redactKey(text, apiKey) {
  let out = String(text ?? '');
  if (apiKey && apiKey.length >= 8) out = out.split(apiKey).join('[redacted]');
  return out.replace(/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/g, 'Bearer [redacted]').replace(/sk-or-[A-Za-z0-9_-]{6,}/g, 'sk-or-[redacted]');
}

/**
 * POST して、成功（2xx）の応答を返す。失敗は VoiceHttpError。
 * @param {{ baseUrl: string, apiKey: string, fetch?: typeof fetch }} config
 * @param {string} path  例 '/audio/transcriptions'
 * @param {unknown} body JSON にして送る
 * @param {{ headersTimeoutMs: number, signal?: AbortSignal, retry?: boolean, retryRateLimited?: boolean, onRateLimited?: (retryAfter: string|null, retrying: boolean) => void }} options
 *   headersTimeoutMs は応答のヘッダが来るまでの上限（本文の読み取りには掛からない。読み上げは本文を逐次で読むので、呼び出し側が signal で止める）。
 *   retry: false なら 1 回しか送らない（投機の送信が使う。失敗しても区切ったときに通常の送り方で送り直すため）。
 *   retryRateLimited: false なら 429 だけはやり直さない（音声認識に予備があるときだけ）
 * @returns {Promise<{ response: Response, retried: boolean }>}
 */
export async function postOpenRouter(config, path, body, options) {
  const fetchImpl = config.fetch ?? ((input, init) => fetch(input, init));
  const url = `${config.baseUrl.replace(/\/$/, '')}${path}`;
  const payload = JSON.stringify(body);
  for (let attempt = 0; ; attempt++) {
    const last = attempt > 0 || options.retry === false;
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), options.headersTimeoutMs);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout.signal]) : timeout.signal;
    let response;
    try {
      response = await fetchImpl(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json', 'X-Title': 'Pleiad' },
        body: payload,
        signal,
      });
    } catch (cause) {
      clearTimeout(timer);
      if (timeout.signal.aborted && !options.signal?.aborted) throw new VoiceHttpError(`no response within ${options.headersTimeoutMs}ms`, 'timeout', { cause });
      if (options.signal?.aborted || last) throw new VoiceHttpError(options.signal?.aborted ? 'aborted' : 'connection failed', 'transient', { cause });
      await sleep(DEFAULT_RETRY_WAIT_MS);
      continue;
    }
    clearTimeout(timer);
    if (response.ok) return { response, retried: attempt > 0 };
    const rateLimited = response.status === 429;
    const retryable = !last && ((rateLimited && options.retryRateLimited !== false) || response.status >= 500);
    if (rateLimited) options.onRateLimited?.(response.headers.get('retry-after'), retryable);
    if (retryable) {
      const wait = retryWaitMs(response.headers.get('retry-after'));
      await response.body?.cancel().catch(() => {});
      await sleep(wait);
      continue;
    }
    const detail = redactKey(await response.text().catch(() => ''), config.apiKey).slice(0, 200);
    throw new VoiceHttpError(`upstream returned ${response.status}: ${detail}`, response.status === 429 || response.status >= 500 ? 'transient' : 'permanent',
      { status: response.status, retryAfter: response.headers.get('retry-after') });
  }
}
