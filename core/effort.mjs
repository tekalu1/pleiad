// Values accepted by the installed adapters; Codex and Claude advertise per-model choices.
//
// 返す形: { '': { label: '既定に従う', note, resolvesTo? }, [level]: { label, note, isDefault? } }
// resolvesTo は「既定に従う」で実際に使われる段（分かるときだけ）。その段には isDefault を付ける。
// 段の候補と既定はモデルの一覧（models()）の efforts / defaultEffort から取る（codex・claude・antigravity・fake）。
// reason は段を選べないときの理由（'' の行に付ける。画面の無効のスライダーの説明）。
import { resolveConnection } from './procway-config.mjs';
const levels = {
  claude: ['low', 'medium', 'high', 'xhigh', 'max'],
  procway: ['minimal', 'low', 'medium', 'high'],
  fake: ['low', 'medium', 'high'],
};
export async function effortOptions(backend, model = '', cwd) {
  let values = levels[backend.id] ?? [];
  let entry = null;
  let reason = null;       // 段を選べない理由（画面の無効のスライダーに出す。分かるときだけ）
  if (backend.id !== 'procway' && typeof backend.models === 'function') {
    const models = await backend.models(cwd);
    entry = models[model] ?? null;
    if (backend.id === 'codex') values = entry?.efforts ?? ['low', 'medium', 'high', 'xhigh'];
    // 一覧がモデルごとの段を持っていればそれ（[] = そのモデルは段を選べない）。
    // antigravity は段違いの id を系統にまとめた段（core/backends/antigravity-models.mjs）
    else if (Array.isArray(entry?.efforts)) values = entry.efforts;
    if (entry?.effortReason) reason = entry.effortReason;
  }
  let fallback = null;
  if (backend.id === 'procway') {
    const config = await resolveConnection(model, cwd).catch(() => null);
    if (!config) return { '': { label: '既定に従う', note: '接続先を設定してください', reason: '接続先を設定してください' } };
    if (config.provider.type === 'cli-agent') { values = []; reason = 'CLI エージェントの接続先は段を選べません（エージェント側の設定に従います）'; }
    // procway-code の設定に段が書いてあればそれが既定（書いていなければ分からない。印は付けない）
    else if (values.includes(config.provider.reasoningEffort)) fallback = config.provider.reasoningEffort;
  } else fallback = values.includes(entry?.defaultEffort) ? entry.defaultEffort : null;
  const levelNote = value => backend.id === 'procway' ? '対応モデルで使用（Anthropic は思考トークン量に変換）'
    : entry?.effortNotes?.[value] ?? '対応するモデルで使用';
  return Object.fromEntries([['', { label: '既定に従う', note: 'エージェント・接続先の設定を使う', ...(fallback ? { resolvesTo: fallback } : {}), ...(reason ? { reason } : {}) }],
    ...values.map(value => [value, { label: value, note: levelNote(value),
      ...(value === fallback ? { isDefault: true } : {}) }])]);
}
export async function validateEffort(backend, value, model, cwd) {
  if (value === '') return value;
  if (typeof value !== 'string' || !Object.hasOwn(await effortOptions(backend, model, cwd), value))
    throw new Error('選択したエフォートは使用できません。選び直してください');
  return value;
}
