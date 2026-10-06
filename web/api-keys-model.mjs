// API キー（設定 › API キー。docs/design.md「API キー」、ADR 0154）の、画面とサーバーが同じに持つ決まり。
// プロバイダーの名前と、接続先（プリセットか URL のホスト）からプロバイダーを決める規則。core/api-keys.mjs も読む。

/** 名前を持つプロバイダー。ここに無いもの（接続先のプリセット名・カスタム）は、キーの名前（label）で見せる */
export const PROVIDER_NAMES = Object.freeze({ openrouter: 'OpenRouter', cerebras: 'Cerebras', zai: 'Z.ai (GLM)', kimi: 'Kimi', deepseek: 'DeepSeek', azure: 'Azure OpenAI', litellm: 'LiteLLM', vllm: 'vLLM' });
export const providerName = provider => PROVIDER_NAMES[provider] ?? '';

/** 通話・判定器に割り当てられるキーのプロバイダー（通話と Jev は OpenRouter、Cerebras の判定器は Cerebras） */
export const USE_PROVIDER = Object.freeze({ voice: 'openrouter', 'judge:jev': 'openrouter', 'judge:cerebras': 'cerebras' });

const PRESET = /^[a-z0-9-]{1,32}$/;

/** 接続先の行から、キーのプロバイダーを決める（プリセットか URL のホスト）。決まらなければ custom */
export function providerOfEndpoint({ preset, baseUrl } = {}) {
  let host = '';
  try { host = new URL(String(baseUrl ?? '')).hostname.toLowerCase(); } catch { /* 読めない URL はプリセットだけで決める */ }
  if (preset === 'openrouter' || /(^|\.)openrouter\.ai$/.test(host)) return 'openrouter';
  if (/(^|\.)cerebras\.ai$/.test(host)) return 'cerebras';
  if (preset && preset !== 'custom' && PRESET.test(preset)) return preset;
  return 'custom';
}
