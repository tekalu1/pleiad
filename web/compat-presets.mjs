// 互換の接続先のプリセットと語彙（画面と core/compat-endpoints.mjs の両方が読む。DOM に触らない）。
//
// エージェントごとに形式が決まっている（docs/design.md「互換の接続先」）:
//   claude → Anthropic Messages 互換（Claude Code が {URL}/v1/messages に送る）
//   codex  → OpenAI Responses 互換（Codex が {URL}/responses に送る。Chat Completions だけの先は使えない）
// Codex 側には Responses に対応していない先（DeepSeek・Kimi・Together AI など）を出さない（research §3.2）。
// プリセットのモデル ID は 2026-09 時点の各社の案内に合わせた初期値で、利用者が確認の後に変えられる。

export const COMPAT_AGENTS = ['claude', 'codex'];

export const KIND = { claude: 'anthropic-messages', codex: 'openai-responses' };
export const KIND_LABEL = { 'anthropic-messages': 'Anthropic 互換', 'openai-responses': 'Responses 互換' };

/** Claude Code の役割。main は会話の既定（ANTHROPIC_MODEL）、haiku は背景の処理とタイトル生成 */
export const CLAUDE_ROLES = [
  { key: 'main', label: 'メイン（会話の既定）', short: 'メイン' },
  { key: 'opus', label: 'Opus 相当', short: 'Opus 相当' },
  { key: 'sonnet', label: 'Sonnet 相当', short: 'Sonnet 相当' },
  { key: 'haiku', label: 'Haiku 相当（背景の処理・タイトル生成）', short: 'Haiku 相当' },
];
export const ROLE_KEYS = { claude: CLAUDE_ROLES.map(r => r.key), codex: ['main'] };

/** 認証の送り方。auto は確認のときに Bearer と x-api-key の両方で試して決める（Claude だけ） */
export const AUTH_LABEL = { auto: '自動（確認で判定）', bearer: 'Bearer', 'x-api-key': 'x-api-key', 'api-key': 'api-key ヘッダー', none: 'キー不要' };

/** 互換の接続先で無くなる・分からなくなるもの（画面 4）。Pleiad の画面に出ているものだけを並べる */
export const LOST = {
  claude: { gone: ['使用量', 'Fast mode', '料金の目安'], unknown: ['Web 検索'] },
  codex: { gone: ['使用量', 'Web 検索', '料金の目安'], unknown: [] },
};
export function lostText(agent) {
  const l = LOST[agent] ?? LOST.claude;
  return l.gone.join(' · ') + (l.unknown.length ? ' · ' + l.unknown.map(x => x + '（不明）').join(' · ') : '');
}

export const CONTEXT_CANDIDATES = [['32768', '32K'], ['131072', '128K'], ['200000', '200K'], ['262144', '256K'], ['1000000', '1M']];

export const PRESETS = {
  claude: [
    { id: 'openrouter', name: 'OpenRouter', hint: 'openrouter.ai · 多数のモデル', urls: [{ value: 'https://openrouter.ai/api', hint: 'プリセット' }], auth: 'bearer',
      roles: { main: '~anthropic/claude-sonnet-latest', opus: '~anthropic/claude-opus-latest', sonnet: '~anthropic/claude-sonnet-latest', haiku: '~anthropic/claude-haiku-latest' } },
    { id: 'zai', name: 'Z.ai (GLM)', hint: 'GLM Coding Plan', urls: [{ value: 'https://api.z.ai/api/anthropic', hint: '海外' }, { value: 'https://open.bigmodel.cn/api/anthropic', hint: '中国本土' }], auth: 'bearer',
      roles: { main: 'glm-5.3', opus: 'glm-5.3', sonnet: 'glm-5.3', haiku: 'glm-5.3-flash' } },
    { id: 'kimi', name: 'Kimi', hint: 'Moonshot AI', urls: [{ value: 'https://api.moonshot.ai/anthropic', hint: 'プリセット' }], auth: 'bearer', thinking: true,
      roles: { main: 'kimi-k2.7-code', opus: 'kimi-k2.7-code', sonnet: 'kimi-k2.7-code', haiku: 'kimi-k2.7-turbo' } },
    { id: 'deepseek', name: 'DeepSeek', hint: 'api.deepseek.com', urls: [{ value: 'https://api.deepseek.com/anthropic', hint: 'プリセット' }], auth: 'x-api-key',
      roles: { main: 'deepseek-v4-pro', opus: 'deepseek-v4-pro', sonnet: 'deepseek-flash', haiku: 'deepseek-flash' } },
    { id: 'litellm', name: 'LiteLLM', hint: '自前のプロキシ', urls: [{ value: 'http://localhost:4000', hint: 'プリセット' }], auth: 'bearer', roles: {} },
    { id: 'ollama', name: 'Ollama', hint: 'ローカル · キー不要', urls: [{ value: 'http://localhost:11434', hint: 'プリセット' }], auth: 'none', nokey: true, roles: {}, context: '32768' },
    { id: 'custom', name: 'カスタム', hint: 'Anthropic 互換の URL', urls: [], auth: 'auto', roles: {} },
  ],
  codex: [
    { id: 'openrouter', name: 'OpenRouter', hint: 'openrouter.ai · 多数のモデル', urls: [{ value: 'https://openrouter.ai/api/v1', hint: 'プリセット' }], auth: 'bearer', roles: {} },
    { id: 'azure', name: 'Azure OpenAI', hint: 'デプロイ名がモデル', urls: [{ value: 'https://<リソース名>.openai.azure.com/openai/v1', hint: 'プリセット' }], auth: 'api-key', roles: {} },
    { id: 'ollama', name: 'Ollama', hint: 'ローカル · キー不要', urls: [{ value: 'http://localhost:11434/v1', hint: 'プリセット' }], auth: 'none', nokey: true, roles: {}, context: '32768' },
    { id: 'lmstudio', name: 'LM Studio', hint: 'ローカル · キー不要', urls: [{ value: 'http://localhost:1234/v1', hint: 'プリセット' }], auth: 'none', nokey: true, roles: {}, context: '32768' },
    { id: 'vllm', name: 'vLLM', hint: '自前のサーバー', urls: [{ value: 'http://localhost:8000/v1', hint: 'プリセット' }], auth: 'bearer', roles: {} },
    { id: 'litellm', name: 'LiteLLM', hint: '自前のプロキシ', urls: [{ value: 'http://localhost:4000/v1', hint: 'プリセット' }], auth: 'bearer', roles: {} },
    { id: 'custom', name: 'カスタム', hint: 'Responses 互換の URL', urls: [], auth: 'bearer', roles: {} },
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
  if (/<[^>]+>/.test(v)) return '<リソース名> を実際の値に置き換えてください。';
  if (agent === 'claude' && /\/v1\/?$/.test(v)) return '末尾の /v1 は要りません。';
  if (agent === 'codex' && /\/responses\/?$/.test(v)) return '末尾の /responses は要りません。';
  return '';
}

// モデル ID の表示の形（名前空間と [1m] の扱い）は web/compat-models.mjs の compatModelLabel
