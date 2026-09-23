// Values accepted by the installed adapters; Codex and Claude advertise per-model choices.
//
// 返す形: { '': { label: '既定に従う', note, resolvesTo? }, [level]: { label, note, isDefault? } }
// resolvesTo は「既定に従う」で実際に使われる段（分かるときだけ）。その段には isDefault を付ける。
// 段の候補と既定はモデルの一覧（models()）の efforts / defaultEffort から取る（codex・claude・antigravity・fake）。
// reason は段を選べないときの理由（'' の行に付ける。画面の無効のスライダーの説明）。
import { t } from './i18n.mjs';

const levels = {
  claude: ['low', 'medium', 'high', 'xhigh', 'max'],
  fake: ['low', 'medium', 'high'],
};
/**
 * endpoint は会話が選んでいる互換の接続先（core/compat-endpoints.mjs の一覧の行。無ければ公式）。
 * 互換の接続先では既定の段が分からない（design-system の規則どおり「既定」の段を作らない）。
 * Claude の互換の接続先は「思考を送る」がオンのときだけ段を選べる（決定 4。オフなら段を送らない）。
 */
export async function effortOptions(backend, model = '', cwd, endpoint = null) {
  if (endpoint) {
    const off = endpoint.agent === 'claude' && !endpoint.options?.sendThinking;
    const values = off ? [] : endpoint.agent === 'claude' ? levels.claude : ['low', 'medium', 'high'];
    return Object.fromEntries([['', { label: t('models.default'), note: t('effort.useEndpoint'),
      ...(off ? { reason: t('effort.notSent') } : {}) }],
      ...values.map(value => [value, { label: value, note: t('effort.supported') }])]);
  }
  let values = levels[backend.id] ?? [];
  let entry = null;
  let reason = null;       // 段を選べない理由（画面の無効のスライダーに出す。分かるときだけ）
  if (typeof backend.models === 'function') {
    const models = await backend.models(cwd);
    entry = models[model] ?? null;
    if (backend.id === 'codex') values = entry?.efforts ?? ['low', 'medium', 'high', 'xhigh'];
    // 一覧がモデルごとの段を持っていればそれ（[] = そのモデルは段を選べない）。
    // antigravity は段違いの id を系統にまとめた段（core/backends/antigravity-models.mjs）
    else if (Array.isArray(entry?.efforts)) values = entry.efforts;
    if (entry?.effortReason) reason = entry.effortReason;
  }
  const fallback = values.includes(entry?.defaultEffort) ? entry.defaultEffort : null;
  const levelNote = value => entry?.effortNotes?.[value] ?? t('effort.supported');
  return Object.fromEntries([['', { label: t('models.default'), note: t('effort.useAgentEndpoint'), ...(fallback ? { resolvesTo: fallback } : {}), ...(reason ? { reason } : {}) }],
    ...values.map(value => [value, { label: value, note: levelNote(value),
      ...(value === fallback ? { isDefault: true } : {}) }])]);
}
export async function validateEffort(backend, value, model, cwd, endpoint = null) {
  if (value === '') return value;
  if (typeof value !== 'string' || !Object.hasOwn(await effortOptions(backend, model, cwd, endpoint), value))
    throw new Error(t('effort.unavailable'));
  return value;
}
