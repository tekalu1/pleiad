// API キー（設定 › API キー。docs/design.md「API キー」、ADR 0155）の、画面とサーバーが同じに持つ決まり。
// プロバイダーの名前と、接続先（プリセットか URL のホスト）からプロバイダーを決める規則。core/api-keys.mjs も読む。

/** 名前を持つプロバイダー。ここに無いもの（接続先のプリセット名・カスタム）は、キーの名前（label）で見せる */
export const PROVIDER_NAMES = Object.freeze({ openrouter: 'OpenRouter', zai: 'Z.ai (GLM)', kimi: 'Kimi', deepseek: 'DeepSeek', azure: 'Azure OpenAI', litellm: 'LiteLLM', vllm: 'vLLM' });
export const providerName = provider => PROVIDER_NAMES[provider] ?? '';

/** 通話・判定器・wait_until の問いに割り当てられるキーのプロバイダー（どれも OpenRouter。判定器の Jev・Qwen は judge:jev のキーを使う） */
export const USE_PROVIDER = Object.freeze({ voice: 'openrouter', 'judge:jev': 'openrouter', 'computer:decider': 'openrouter' });

const PRESET = /^[a-z0-9-]{1,32}$/;

/** 送り先のホストが決まっているプロバイダー（キーにホストを持たせない）。それ以外のキーは、使った接続先のホストに結び付ける */
export const FIXED_HOST_PROVIDERS = new Set(['openrouter']);

/** URL のホスト（小文字）。読めなければ '' */
export function hostOf(url) {
  try { return new URL(String(url ?? '')).hostname.toLowerCase(); } catch { return ''; }
}

/**
 * 接続先の行から、キーのプロバイダーを決める（URL のホストが先。プリセットは自前のものだけ）。決まらなければ custom。
 * OpenRouter は URL のホストが openrouter.ai のときだけ（プリセットを選んだまま URL を別のホストへ変えたら、別のホストなので custom）
 */
export function providerOfEndpoint({ preset, baseUrl } = {}) {
  const host = hostOf(baseUrl);
  if (/(^|\.)openrouter\.ai$/.test(host)) return 'openrouter';
  if (preset && preset !== 'custom' && preset !== 'openrouter' && PRESET.test(preset)) return preset;
  return 'custom';
}

/**
 * キーをその接続先で選んでよいか。プロバイダーが同じで、ホストが決まっていないプロバイダーのキーは、元のホストと同じ接続先だけ
 * （まだどのホストにも結び付いていないキー（host なし）は、選んだ時に結び付く）。別のホスト用のキーを黙って送らない
 */
export function keyFitsEndpoint(key, endpoint) {
  if (!key || key.provider !== providerOfEndpoint(endpoint)) return false;
  return FIXED_HOST_PROVIDERS.has(key.provider) || !key.host || key.host === hostOf(endpoint.baseUrl);
}

/** 既定で選んでよいほど確かか（ホストが一致する・ホストの決まったプロバイダー）。結び付いていないキーは選べるが既定にしない */
export const keyMatchesEndpoint = (key, endpoint) => keyFitsEndpoint(key, endpoint) && (FIXED_HOST_PROVIDERS.has(key.provider) || key.host === hostOf(endpoint.baseUrl));
