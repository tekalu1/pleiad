// 設定 › 委譲の思考の強さ（web/delegation-effort.mjs・web/effort-select.mjs・web/delegation-settings.mjs）と、委譲カードの内訳の一言（effortLine）。
// 決め方は core の decideEffort と同じ答えになること（画面が見せる強さ = 子が走る強さ）。DOM は最小のスタブ（開く・選ぶ・保存の送信まで）
import assert from 'node:assert/strict';
import { EFFORT_LEVELS, fitEffort, candidateEffort, tierEffort, withEffort } from '../../web/delegation-effort.mjs';
import { decideEffort, normalizeSettings } from '../../core/delegation-routing.mjs';
import { effortLine, routingDetail, pinnedDetail } from '../../web/delegation-routing-view.mjs';
import { diffFromDefaults, setupDelegationSettings } from '../../web/delegation-settings.mjs';
import { el } from '../../web/dom.mjs';
import { N } from '../lib/dom-stub.mjs';

export const name = 'delegation-effort-view';
export const title = '委譲の思考の強さの画面: 選択肢・由来の文・保存する差分・選べない候補・内訳の一言。決め方は core と同じ答え';

const CLAUDE = { levels: ['low', 'medium', 'high', 'xhigh', 'max'], fixed: null };
const CODEX = { levels: ['low', 'medium', 'high', 'xhigh'], fixed: null };
const SONNET = { levels: ['low', 'medium', 'high', 'max'], fixed: null };
const NONE = { levels: [], fixed: null };
const FIXED = { levels: [], fixed: 'high' };

export default async function (t) {
  // ---- 決め方（画面と core が同じ答えを出す）
  const settings = normalizeSettings({ tiers: { t3: ['claude:sonnet', 'codex:gpt-6-sol', 'claude:opus'] }, efforts: { t3: { '*': 'max', 'claude:opus': 'low', 'claude:sonnet': '' } } });
  let same = true;
  for (const [candidate, capability, conversation] of [['claude:sonnet', SONNET, 'high'], ['codex:gpt-6-sol', CODEX, ''], ['claude:opus', CLAUDE, 'high'], ['claude:sonnet', NONE, 'high']]) {
    const ui = candidateEffort({ settings, tier: 't3', candidate, capability, conversation });
    const core = decideEffort({ settings, tier: 't3', candidate, capability });
    const coreValue = core.send === undefined ? (conversation && fitEffort(capability.levels, conversation)) || null : core.effort;
    if (ui.kind === 'none' ? core.source !== 'none' : (ui.value ?? null) !== coreValue || ui.source !== core.source) same = false;
  }
  t.ok('画面が見せる強さは、子を作るときに決まる強さ（decideEffort）と同じ答え', same);
  t.ok('語彙は core と同じ', EFFORT_LEVELS.join() === 'low,medium,high,xhigh,max');
  const base = normalizeSettings({});
  const sonnet = candidateEffort({ settings: base, tier: 't2', candidate: 'claude:sonnet', capability: SONNET, conversation: 'high' });
  t.ok('段の既定のとき: 値・由来 tier・選べる強さはそのモデルが持つものだけ（Sonnet に xhigh は無い）', sonnet.kind === 'level' && sonnet.value === 'medium' && sonnet.source === 'tier'
    && sonnet.options.join() === 'low,medium,high,max' && sonnet.changed === false && sonnet.own === undefined && !('asked' in sonnet));
  const asked = candidateEffort({ settings: normalizeSettings({ efforts: { t3: { '*': 'xhigh' } } }), tier: 't3', candidate: 'claude:sonnet', capability: SONNET, conversation: 'high' });
  t.ok('持たない強さに合わせたら、元の強さ（asked）を持つ（xhigh → high）', asked.value === 'high' && asked.asked === 'xhigh' && asked.source === 'tier');
  const over = candidateEffort({ settings: normalizeSettings({ tiers: { t2: ['claude:sonnet'] }, efforts: { t2: { 'claude:sonnet': 'high' } } }), tier: 't2', candidate: 'claude:sonnet', capability: SONNET });
  t.ok('段の既定と違う上書きは changed（青い字）。段の既定と同じ値の上書きは changed にしない', over.changed === true && over.source === 'override'
    && candidateEffort({ settings: normalizeSettings({ tiers: { t2: ['claude:sonnet'] }, efforts: { t2: { 'claude:sonnet': 'medium' } } }), tier: 't2', candidate: 'claude:sonnet', capability: SONNET }).changed === false);
  const conv = candidateEffort({ settings: normalizeSettings({ tiers: { t2: ['claude:sonnet'] }, efforts: { t2: { 'claude:sonnet': '' } } }), tier: 't2', candidate: 'claude:sonnet', capability: SONNET, conversation: 'high' });
  t.ok('会話の既定に従うとき: 今の会話の既定の値（そのモデルに合わせた値）を出す', conv.source === 'conversation' && conv.value === 'high' && conv.conversationValue === 'high' && conv.changed === true);
  t.ok('会話の既定が未設定なら値は null', candidateEffort({ settings: base, tier: 'tv', candidate: 'codex:gpt-6-astra', capability: CODEX, conversation: '' }).value === null);
  t.ok('強さを持たない候補は none・モデル名に入る候補は fixed（選ばせない）', candidateEffort({ settings: base, tier: 't1', candidate: 'claude:haiku', capability: NONE }).kind === 'none'
    && candidateEffort({ settings: base, tier: 't1', candidate: 'antigravity:gemini-3.8-flash-high', capability: FIXED }).kind === 'fixed'
    && candidateEffort({ settings: base, tier: 't1', candidate: 'antigravity:gemini-3.8-flash-high', capability: FIXED }).value === 'high');
  t.ok('持ち方が分からない候補（使えないエージェント）は語彙全部を選べる', candidateEffort({ settings: base, tier: 't1', candidate: 'claude:x', capability: undefined }).options.join() === EFFORT_LEVELS.join());
  t.ok('段の既定の表示: 値と、既定から外れているか', tierEffort({ settings: normalizeSettings({ efforts: { t3: { '*': 'high' } } }), defaults: base, tier: 't3' }).changed === true
    && tierEffort({ settings: base, defaults: base, tier: 't3' }).changed === false && tierEffort({ settings: base, defaults: base, tier: 'tv' }).value === '');
  const next = withEffort(base.efforts, 't3', 'claude:sonnet', 'low');
  t.ok('上書きを足す・外す（undefined）・会話の既定に従う（空）。元は変えない', next.t3['claude:sonnet'] === 'low' && base.efforts.t3['claude:sonnet'] === undefined
    && !('claude:sonnet' in withEffort(next, 't3', 'claude:sonnet', undefined).t3) && withEffort(base.efforts, 't3', 'claude:sonnet', '').t3['claude:sonnet'] === '');
  t.ok('既定と同じ行は送らず、全部既定なら null（既定値を凍らせない）', diffFromDefaults(base.efforts, base.efforts) === null
    && JSON.stringify(diffFromDefaults({ ...base.efforts, t3: { '*': 'high' } }, base.efforts)) === '{"t3":{"*":"high"}}');

  // ---- 内訳の一言
  const routing = { mode: 'auto', kind: 'implement', difficulty: 'mid', baseTier: 't3', tier: 't3', target: { backend: 'claude', model: 'sonnet', account: '', effort: 'medium' },
    effortSource: 'tier', effortTier: 't3', skipped: [], signals: null };
  t.ok('由来が段の既定: 「medium · 段 3 の既定」', effortLine(routing) === 'medium · 段 3 の既定', effortLine(routing));
  t.ok('上書き・会話の既定・モデル名・調整なし・依頼元が変更', effortLine({ ...routing, effortSource: 'override' }) === 'medium · この候補の設定'
    && effortLine({ ...routing, effortSource: 'conversation', target: { ...routing.target, effort: 'high' } }) === 'high · 会話の既定'
    && effortLine({ ...routing, effortSource: 'conversation', target: { ...routing.target, effort: null } }) === '会話の既定（強さは指定なし）'
    && effortLine({ ...routing, effortSource: 'model', target: { ...routing.target, effort: 'high' } }) === 'high · モデル名で決まる'
    && effortLine({ ...routing, effortSource: 'none', target: { ...routing.target, effort: null } }) === '調整なし'
    && effortLine({ ...routing, effortSource: 'parent', target: { ...routing.target, effort: 'low' } }) === 'low · 依頼元が変更');
  t.ok('合わせたときはその旨を添える（high がこのモデルに無いので medium に合わせた）', effortLine({ ...routing, effortAsked: 'high' }) === 'medium · 段 3 の既定 · high がこのモデルに無いので medium に合わせた');
  t.ok('振り分けが強さを決める前の記録は、強さが分かればその値だけ、無ければ何も出さない', effortLine({ target: { effort: 'high' } }) === 'high' && effortLine({ target: { backend: 'claude', model: 'opus' } }) === '' && effortLine(null) === '');
  const detail = routingDetail(routing, {});
  const facts = detail.querySelectorAll('dt').map(x => x.textContent);
  t.ok('内訳の格子に「思考の強さ」、使った候補の行の右に同じ強さ', facts.includes('思考の強さ') && detail.textContent.includes('medium · 段 3 の既定') && detail.textContent.includes('medium · 使った'));
  t.ok('強さの記録が無い古いタスクの内訳には出さない', !routingDetail({ ...routing, effortSource: undefined, target: { ...routing.target, effort: undefined } }, {}).querySelectorAll('dt').map(x => x.textContent).includes('思考の強さ')
    && routingDetail({ ...routing, effortSource: undefined, target: { ...routing.target, effort: undefined } }, {}).textContent.includes('使った'));
  const manual = pinnedDetail({ mode: 'manual', kind: 'implement', target: { backend: 'claude', model: 'sonnet', effort: 'medium' }, effortSource: 'tier', effortTier: 't3' }, {});
  t.ok('人が選び直した・固定の内訳にも強さを出す', manual.textContent.includes('medium · 段 3 の既定')
    && pinnedDetail({ mode: 'pinned', kind: 'implement', target: { backend: 'claude', model: 'opus', effort: 'low' } }, {}).textContent.includes('low'));

  // ---- 設定 › 委譲の面
  const candidates = [
    { candidate: 'claude:sonnet', backend: 'claude', model: 'sonnet', tiers: ['t2'], usable: true, windows: [], effort: SONNET },
    { candidate: 'claude:haiku', backend: 'claude', model: 'haiku', tiers: ['t1'], usable: true, windows: [], effort: NONE },
    { candidate: 'antigravity:gemini-3.8-flash-high', backend: 'antigravity', model: 'gemini-3.8-flash-high', tiers: ['t1', 't2'], usable: true, windows: [], effort: FIXED },
    { candidate: 'codex:gpt-6-luna', backend: 'codex', model: 'gpt-6-luna', tiers: ['t2'], usable: false, reason: 'unavailable', windows: [] },
  ];
  const tiers = { t1: ['antigravity:gemini-3.8-flash-high', 'claude:haiku'], t2: ['antigravity:gemini-3.8-flash-high', 'codex:gpt-6-luna', 'claude:sonnet'] };
  const defaults = { enabled: true, judgeByKind: { implement: 'jev' }, escalateToCerebras: false, avoidPercent: 80, paceLimit: 1.5, tiers, table: { implement: ['t1', 't2', 't2'] },
    efforts: { t1: { '*': 'low' }, t2: { '*': 'medium' } } };
  let stored = structuredClone(defaults);
  const sent = [];
  const state = () => structuredClone({ settings: stored, defaults, kinds: ['implement'], judges: ['jev', 'cerebras', 'none'], tiers: ['t1', 't2'], candidates,
    conversationEfforts: { claude: 'high', codex: '', antigravity: '' }, keys: { openrouter: { hasKey: true }, cerebras: { hasKey: true } }, storage: { encrypted: true } });
  const cmd = async (name, args) => {
    if (name === 'setDelegationRouting') {
      sent.push(args.settings);
      const { efforts, ...rest } = args.settings;
      if (efforts !== undefined) stored.efforts = efforts === null ? structuredClone(defaults.efforts) : { ...structuredClone(defaults.efforts), ...efforts };
      Object.assign(stored, rest);
    }
    return state();
  };
  const root = el('div'), tab = el('button');
  const saved = { getElementById: document.getElementById, addEventListener: document.addEventListener, removeEventListener: document.removeEventListener, activeElement: document.activeElement, focus: N.prototype.focus };
  document.getElementById = id => ({ delegationPanel: root, delegationTab: tab })[id] ?? null;
  document.addEventListener = () => {}; document.removeEventListener = () => {};
  N.prototype.focus = function () { if (!this.disabled) document.activeElement = this; };
  try {
    const ui = setupDelegationSettings({ cmd, page() {}, showMenu() {}, labelOf: id => id, logo: () => el('span'),
      modelsOf: async () => ({}), modelName: (_b, m) => ({ sonnet: 'Sonnet', haiku: 'Haiku' })[m] ?? m });
    await ui.refresh();
    const tierBlocks = root.querySelectorAll('.rt-tier');
    const heads = tierBlocks.map(b => b.querySelector('.rt-tier-head'));
    t.ok('段の見出しの右に「段の既定」の選択（値が入っている）', heads.length === 2 && heads[0].textContent.includes('段の既定') && heads[0].textContent.includes('low')
      && heads[1].textContent.includes('medium') && heads[0].querySelector('button').getAttribute('aria-haspopup') === 'listbox');
    const rows = tierBlocks[1].querySelectorAll('.rt-cand-row');
    const effortOf = row => row.querySelector('.rt-cand-effort');
    t.ok('候補の行の右に強さの欄。選べる候補は「思考 medium 段の既定」', rows.length === 3 && effortOf(rows[2]).textContent === '思考medium段の既定');
    t.ok('強さを持たないモデルは選択を出さず「調整なし」（警告は出さない）', effortOf(tierBlocks[0].querySelectorAll('.rt-cand-row')[1]).textContent.includes('調整なし')
      && !effortOf(tierBlocks[0].querySelectorAll('.rt-cand-row')[1]).querySelector('button') && !root.textContent.includes('⚠'));
    t.ok('強さがモデル名に入る候補は選択を出さず「high モデル名で決まる」', effortOf(rows[0]).textContent.includes('high') && effortOf(rows[0]).textContent.includes('モデル名で決まる')
      && !effortOf(rows[0]).querySelector('button'));
    t.ok('使えないエージェントの候補も、持ち方が分からないので語彙全部から選べる', effortOf(rows[1]).querySelector('button'));
    t.ok('会話の既定が空のエージェントの候補は「段の既定」の値で出る（medium）', effortOf(rows[1]).textContent.includes('medium'));

    // 段の既定の選択を開く: 会話の既定に従う・語彙全部・推奨
    const tierBtn = heads[1].querySelector('button');
    tierBtn.onclick();
    const options = () => root.querySelectorAll('.li').map(b => b.querySelector('.lbl').textContent);
    t.ok('段の既定の選択: 会話の既定に従う（今は high を出す）・語彙全部・推奨の印', options().join() === '会話の既定に従う,low,medium,high,xhigh,max');
    t.ok('開くと aria-expanded が true。選択肢は option', tierBtn.getAttribute('aria-expanded') === 'true' && root.querySelectorAll('.li')[0].getAttribute('role') === 'option');
    const high = root.querySelectorAll('.li').find(b => b.querySelector('.lbl').textContent === 'high');
    high.onclick();
    await new Promise(r => setImmediate(r));
    t.ok('段の既定を選ぶと、既定との差だけを送る（段の行ごと）', JSON.stringify(sent.at(-1)) === '{"efforts":{"t2":{"*":"high"}}}', JSON.stringify(sent.at(-1)));
    t.ok('段の既定を変えると青い字（changed）になり、候補の行も新しい値になる', root.querySelectorAll('.rt-tier')[1].querySelector('.rt-tier-head').querySelector('.ef-btn').classList.contains('changed')
      && effortOf(root.querySelectorAll('.rt-tier')[1].querySelectorAll('.rt-cand-row')[2]).textContent.includes('high'));

    // 候補の選択: 持つ強さだけ
    const sonnetBtn = effortOf(root.querySelectorAll('.rt-tier')[1].querySelectorAll('.rt-cand-row')[2]).querySelector('button');
    sonnetBtn.onclick();
    const sonnetOptions = options();
    t.ok('候補の選択: 段の既定に従う・会話の既定に従う・そのモデルが持つ強さだけ（Sonnet に xhigh は無い）', sonnetOptions.join() === '段の既定に従う,会話の既定に従う,low,medium,high,max', sonnetOptions.join());
    const hints = root.querySelectorAll('.li').map(b => b.querySelector('.hint')?.textContent ?? '');
    t.ok('「会話の既定に従う（今は high）」を出す', hints[1].includes('high'), hints.join('|'));
    root.querySelectorAll('.li').find(b => b.querySelector('.lbl').textContent === 'low').onclick();
    await new Promise(r => setImmediate(r));
    t.ok('候補の上書きは段の行に候補の id で入れて送る', JSON.stringify(sent.at(-1)) === '{"efforts":{"t2":{"*":"high","claude:sonnet":"low"}}}', JSON.stringify(sent.at(-1)));
    const row = root.querySelectorAll('.rt-tier')[1].querySelectorAll('.rt-cand-row')[2];
    t.ok('上書きした候補は値だけになり（段の既定の語を付けない）、段の既定と違うので青い字', effortOf(row).textContent.includes('low') && !effortOf(row).textContent.includes('段の既定')
      && effortOf(row).querySelector('.ef-btn').classList.contains('changed'));
    // 会話の既定に従う
    effortOf(row).querySelector('button').onclick();
    root.querySelectorAll('.li').find(b => b.querySelector('.lbl').textContent === '会話の既定に従う').onclick();
    await new Promise(r => setImmediate(r));
    t.ok('会話の既定に従う（空）は上書きとして送る', JSON.stringify(sent.at(-1)) === '{"efforts":{"t2":{"*":"high","claude:sonnet":""}}}', JSON.stringify(sent.at(-1)));
    // 段の既定に従う（上書きを外す）
    const row2 = root.querySelectorAll('.rt-tier')[1].querySelectorAll('.rt-cand-row')[2];
    effortOf(row2).querySelector('button').onclick();
    root.querySelectorAll('.li').find(b => b.querySelector('.lbl').textContent === '段の既定に従う').onclick();
    await new Promise(r => setImmediate(r));
    t.ok('段の既定に従うは上書きを外す', JSON.stringify(sent.at(-1)) === '{"efforts":{"t2":{"*":"high"}}}', JSON.stringify(sent.at(-1)));
    // 推奨の値へ戻すと、全部既定なので null
    root.querySelectorAll('.rt-tier')[1].querySelector('.rt-tier-head').querySelector('button').onclick();
    root.querySelectorAll('.li').find(b => b.querySelector('.lbl').textContent === 'medium').onclick();
    await new Promise(r => setImmediate(r));
    t.ok('段の既定を推奨に戻したら、全部既定なので null を送る（保存から消える）', sent.at(-1).efforts === null, JSON.stringify(sent.at(-1)));
    t.ok('保存の途中の描き直しで、前の上書きが残らない（既定に重ねる）', stored.efforts.t2['*'] === 'medium' && Object.keys(stored.efforts.t2).length === 1);
  } finally {
    document.getElementById = saved.getElementById;
    document.addEventListener = saved.addEventListener; document.removeEventListener = saved.removeEventListener;
    document.activeElement = saved.activeElement;
    N.prototype.focus = saved.focus;
  }
}
