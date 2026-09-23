// 互換の接続先のプリセットと語彙（画面と core/compat-endpoints.mjs の両方が読む。DOM に触らない）。
//
// エージェントごとに形式が決まっている（docs/design.md「互換の接続先」）:
//   claude → Anthropic Messages 互換（Claude Code が {URL}/v1/messages に送る）
//   codex  → OpenAI Responses 互換（Codex が {URL}/responses に送る。Chat Completions だけの先は使えない）
// Codex 側には Responses に対応していない先（DeepSeek・Kimi・Together AI など）を出さない（research §3.2）。
// プリセットのモデル ID は 2026-09 時点の各社の案内に合わせた初期値で、利用者が確認の後に変えられる。
// 表示の文言は読み込みの時点の言語で t() から作る（core も読むが、core が使うのは KIND・ROLE_KEYS・COMPAT_AGENTS だけ）。
import { t } from './i18n.mjs';

export const COMPAT_AGENTS = ['claude', 'codex'];

export const KIND = { claude: 'anthropic-messages', codex: 'openai-responses' };
export const KIND_LABEL = { 'anthropic-messages': t('compat.kind.anthropic'), 'openai-responses': t('compat.kind.responses') };

/** Claude Code の役割。main は会話の既定（ANTHROPIC_MODEL）、haiku は背景の処理とタイトル生成 */
export const CLAUDE_ROLES = [
  { key: 'main', label: t('compat.role.mainLabel'), short: t('compat.role.main') },
  { key: 'opus', label: t('compat.role.opus'), short: t('compat.role.opus') },
  { key: 'sonnet', label: t('compat.role.sonnet'), short: t('compat.role.sonnet') },
  { key: 'haiku', label: t('compat.role.haikuLabel'), short: t('compat.role.haiku') },
];
export const ROLE_KEYS = { claude: CLAUDE_ROLES.map(r => r.key), codex: ['main'] };

/** 認証の送り方。auto は確認のときに Bearer と x-api-key の両方で試して決める（Claude だけ） */
export const AUTH_LABEL = { auto: t('compat.auth.auto'), bearer: 'Bearer', 'x-api-key': 'x-api-key', 'api-key': t('compat.auth.apiKeyHeader'), none: t('compat.auth.none') };

/** 互換の接続先で無くなる・分からなくなるもの（画面 4）。Pleiad の画面に出ているものだけを並べる */
export const LOST = {
  claude: { gone: [t('compat.lost.usage'), 'Fast mode', t('compat.lost.cost')], unknown: [t('compat.lost.webSearch')] },
  codex: { gone: [t('compat.lost.usage'), t('compat.lost.webSearch'), t('compat.lost.cost')], unknown: [] },
};
export function lostText(agent) {
  const l = LOST[agent] ?? LOST.claude;
  return l.gone.join(' · ') + (l.unknown.length ? ' · ' + l.unknown.map(item => t('compat.lost.unknown', { item })).join(' · ') : '');
}

export const CONTEXT_CANDIDATES = [['32768', '32K'], ['131072', '128K'], ['200000', '200K'], ['262144', '256K'], ['1000000', '1M']];

export const PRESETS = {
  claude: [
    { id: 'openrouter', name: 'OpenRouter', hint: t('compat.preset.openrouter'), urls: [{ value: 'https://openrouter.ai/api', hint: t('compat.preset.urlPreset') }], auth: 'bearer',
      roles: { main: '~anthropic/claude-sonnet-latest', opus: '~anthropic/claude-opus-latest', sonnet: '~anthropic/claude-sonnet-latest', haiku: '~anthropic/claude-haiku-latest' } },
    { id: 'zai', name: 'Z.ai (GLM)', hint: 'GLM Coding Plan', urls: [{ value: 'https://api.z.ai/api/anthropic', hint: t('compat.preset.international') }, { value: 'https://open.bigmodel.cn/api/anthropic', hint: t('compat.preset.china') }], auth: 'bearer',
      roles: { main: 'glm-5.3', opus: 'glm-5.3', sonnet: 'glm-5.3', haiku: 'glm-5.3-flash' } },
    { id: 'kimi', name: 'Kimi', hint: 'Moonshot AI', urls: [{ value: 'https://api.moonshot.ai/anthropic', hint: t('compat.preset.urlPreset') }], auth: 'bearer', thinking: true,
      roles: { main: 'kimi-k2.7-code', opus: 'kimi-k2.7-code', sonnet: 'kimi-k2.7-code', haiku: 'kimi-k2.7-turbo' } },
    { id: 'deepseek', name: 'DeepSeek', hint: 'api.deepseek.com', urls: [{ value: 'https://api.deepseek.com/anthropic', hint: t('compat.preset.urlPreset') }], auth: 'x-api-key',
      roles: { main: 'deepseek-v4-pro', opus: 'deepseek-v4-pro', sonnet: 'deepseek-flash', haiku: 'deepseek-flash' } },
    { id: 'litellm', name: 'LiteLLM', hint: t('compat.preset.selfProxy'), urls: [{ value: 'http://localhost:4000', hint: t('compat.preset.urlPreset') }], auth: 'bearer', roles: {} },
    { id: 'ollama', name: 'Ollama', hint: t('compat.preset.localNoKey'), urls: [{ value: 'http://localhost:11434', hint: t('compat.preset.urlPreset') }], auth: 'none', nokey: true, roles: {}, context: '32768' },
    { id: 'custom', name: t('compat.preset.custom'), hint: t('compat.preset.anthropicUrl'), urls: [], auth: 'auto', roles: {} },
  ],
  codex: [
    { id: 'openrouter', name: 'OpenRouter', hint: t('compat.preset.openrouter'), urls: [{ value: 'https://openrouter.ai/api/v1', hint: t('compat.preset.urlPreset') }], auth: 'bearer', roles: {} },
    { id: 'azure', name: 'Azure OpenAI', hint: t('compat.preset.azure'), urls: [{ value: t('compat.preset.azureUrl'), hint: t('compat.preset.urlPreset') }], auth: 'api-key', roles: {} },
    { id: 'ollama', name: 'Ollama', hint: t('compat.preset.localNoKey'), urls: [{ value: 'http://localhost:11434/v1', hint: t('compat.preset.urlPreset') }], auth: 'none', nokey: true, roles: {}, context: '32768' },
    { id: 'lmstudio', name: 'LM Studio', hint: t('compat.preset.localNoKey'), urls: [{ value: 'http://localhost:1234/v1', hint: t('compat.preset.urlPreset') }], auth: 'none', nokey: true, roles: {}, context: '32768' },
    { id: 'vllm', name: 'vLLM', hint: t('compat.preset.selfServer'), urls: [{ value: 'http://localhost:8000/v1', hint: t('compat.preset.urlPreset') }], auth: 'bearer', roles: {} },
    { id: 'litellm', name: 'LiteLLM', hint: t('compat.preset.selfProxy'), urls: [{ value: 'http://localhost:4000/v1', hint: t('compat.preset.urlPreset') }], auth: 'bearer', roles: {} },
    { id: 'custom', name: t('compat.preset.custom'), hint: t('compat.preset.responsesUrl'), urls: [], auth: 'bearer', roles: {} },
  ],
};

export function presetOf(agent, id) {
  return (PRESETS[agent] ?? []).find(p => p.id === id) ?? (PRESETS[agent] ?? []).find(p => p.id === 'custom') ?? null;
}

/** URL の候補（combo）。選んだプリセットの URL を先に、他のプリセットの URL を後に */
export function urlCandidates(agent, presetId) {
  const own = presetOf(agent, presetId)?.urls ?? [];
  const rest = (PRESETS[agent] ?? []).flatMap(p => p.urls).filter(u => !own.some(o => o.value === u.value)).map(u => ({ value: u.value, hint: '' }));
  return [...own, ...rest];
}

/** URL の入力に添える一文（画面 3 の②）。間違いに見えるときだけ。正しそうなら ''（説明文は出さない） */
export function urlHelp(agent, url) {
  const v = String(url ?? '').trim();
  if (/<[^>]+>/.test(v)) return t('compat.urlHelp.placeholder');
  if (agent === 'claude' && /\/v1\/?$/.test(v)) return t('compat.urlHelp.trailing', { suffix: '/v1' });
  if (agent === 'codex' && /\/responses\/?$/.test(v)) return t('compat.urlHelp.trailing', { suffix: '/responses' });
  return '';
}

// モデル ID の表示の形（名前空間と [1m] の扱い）は web/compat-models.mjs の compatModelLabel
