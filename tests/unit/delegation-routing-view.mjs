// 委譲カードの振り分けの理由と設定 › 委譲の組み立て（web/delegation-routing-view.mjs・web/delegation-settings.mjs）。DOM の大半は触らず、文と並びだけ見る
import assert from 'node:assert/strict';
import { routingLine, skippedPhrase, judgeLine, tierLine, yesSignals, fallbackText, retryCandidates, usageSummary, isAutoRouting, fallbackName, routingDetail,
  skipText, parseRoutingFailure, groupSkipped, groupText, routingFailureParts } from '../../web/delegation-routing-view.mjs';
import { diffFromDefaults, setupDelegationSettings } from '../../web/delegation-settings.mjs';
import { el } from '../../web/dom.mjs';
import { N } from '../lib/dom-stub.mjs';

export const name = 'delegation-routing-view';
export const title = '委譲カードの理由・内訳の文、やり直しの候補の並び、設定の差分と判定器の面の描き直し';

export default async function (t) {
  const names = { backend: id => ({ codex: 'Codex', claude: 'Claude Code' })[id] ?? id, model: (_b, m) => ({ sonnet: 'Sonnet', 'gpt-6-sol': 'gpt-6-sol' })[m] ?? m };
  const routing = { mode: 'auto', kind: 'implement', judge: 'jev', signals: { diagnose: false, choose: true, long_procedure: false, many_parts: false, writes_shared: true, security_gate: false },
    difficulty: 'mid', baseTier: 't3', tier: 't3', target: { backend: 'codex', model: 'gpt-6-sol', account: null },
    skipped: [{ candidate: 'claude:sonnet', tier: 't3', reason: 'quota_high', window: { label: '週次', minutes: 10080, usedPercent: 73.4 } }], usageAt: '2026-09-26T05:32:08.000Z', fallback: null };
  assert.equal(routingLine(routing, names), '実装・中 → Codex gpt-6-sol · Sonnet は週次 73% で飛ばした');
  assert.equal(routingLine({ ...routing, skipped: [] }, names), '実装・中 → Codex gpt-6-sol');
  assert.equal(skippedPhrase({ candidate: 'claude:sonnet', reason: 'pace_high', window: { label: '週次', pace: 1.83 } }, names), 'Sonnet は週次のペースが 1.83 倍で飛ばした');
  assert.equal(skippedPhrase({ candidate: 'claude:sonnet', reason: 'unavailable' }, names), 'Sonnet は使えないため飛ばした');
  t.ok('1 行の理由は「種類・難しさ → 委譲先」と、飛ばした最初の候補と理由', true);

  assert.equal(judgeLine(routing), 'Jev');
  assert.equal(judgeLine({ ...routing, judge: 'cerebras', fallback: 'timeout' }), 'Cerebras · Jev: 時間切れ');
  assert.equal(judgeLine({ ...routing, judge: 'cerebras', escalated: true }), 'Cerebras（Jev が迷ったので聞き直した）');
  assert.equal(judgeLine({ ...routing, judge: 'none', fallback: 'judge_none' }), '判定しない種類（難しさは中）');
  assert.equal(judgeLine({ ...routing, judge: 'none', fallback: 'no_key' }), '判定できなかった: キーが無い（難しさは中）');
  assert.equal(fallbackText('http_503'), 'HTTP 503');
  assert.equal(fallbackText('something_new'), 'something_new', '知らない理由はコードのまま');
  assert.deepEqual(yesSignals(routing), ['やり方の選択', '共有物への書き込み']);
  assert.equal(tierLine({ ...routing, tier: 't4' }), '段 4（表では 段 3。候補が使えず上げた）');
  t.ok('判定の一行（使った判定器・もう一方に落ちた・聞き直した・判定しない・失敗）と手がかり・段', true);

  assert.equal(isAutoRouting(routing), true);
  assert.equal(isAutoRouting({ ...routing, mode: 'pinned' }), false);
  assert.equal(isAutoRouting({ ...routing, mode: 'manual' }), false, '人が選び直したものは「自動」ではない');
  assert.equal(isAutoRouting(null), false);
  assert.equal(fallbackName('backend', 'claude', 'claude'), 'Claude Code');
  assert.equal(fallbackName('model', 'claude', 'opus'), 'Opus');
  assert.equal(fallbackName('model', 'codex', 'gpt-6-sol'), 'gpt-6-sol');
  t.ok('自動の印は mode: auto だけ。語彙を読めないエージェントの名前を補う', true);

  const cands = [
    { candidate: 'antigravity:gemini-3.8-flash-high', backend: 'antigravity', model: 'gemini-3.8-flash-high', tiers: ['t1', 't2'], usable: true, windows: [] },
    { candidate: 'codex:gpt-6-sol', backend: 'codex', model: 'gpt-6-sol', tiers: ['t3'], usable: true, windows: [] },
    { candidate: 'claude:sonnet', backend: 'claude', model: 'sonnet', tiers: ['t2', 't3'], usable: false, reason: 'quota_high', windows: [] },
    { candidate: 'claude:opus', backend: 'claude', model: 'opus', tiers: ['t4'], usable: true, account: 'work',
      accounts: [{ account: '', windows: [{ label: '週次', usedPercent: 90 }] }, { account: 'work', windows: [{ label: '週次', usedPercent: 12.4 }, { label: '5時間', usedPercent: null }] }] },
    { candidate: 'codex:gpt-6-astra', backend: 'codex', model: 'gpt-6-astra', tiers: ['tv'], usable: true, windows: [] },
  ];
  assert.deepEqual(retryCandidates(cands, routing).map(c => c.candidate), ['claude:opus', 'codex:gpt-6-astra', 'antigravity:gemini-3.8-flash-high'],
    '使えるものだけ・元の委譲先を除く・元の段から上、次に下');
  assert.equal(usageSummary(cands[3]), '週次 12%', 'Claude は使うアカウントの枠。率の分からない枠は出さない');
  t.ok('やり直しの候補は、今使えるものを元の段から上へ、次に下の段の順', true);

  const detail = routingDetail(routing, { names });
  const listed = detail.querySelectorAll('.rt-cand');
  assert.ok(listed.length === 2 && listed[1].className.includes('used') && !listed[0].className.includes('used'), '飛ばした候補と使った候補を順に');
  assert.equal(detail.querySelector('.rt-retry-open'), null, 'onRetry が無ければやり直しの口を出さない');
  t.ok('内訳は試した候補を順に並べ、使ったものに印', true);

  const defaults = { judgeByKind: { trivial: 'jev', visual: 'none' }, tiers: { t1: ['a:b'], t2: ['c:d'] }, avoidPercent: 80 };
  assert.deepEqual(diffFromDefaults({ trivial: 'cerebras', visual: 'none' }, defaults.judgeByKind), { trivial: 'cerebras' });
  assert.equal(diffFromDefaults({ trivial: 'jev', visual: 'none' }, defaults.judgeByKind), null, '全部既定なら null（既定に戻す）');
  assert.deepEqual(diffFromDefaults({ t1: ['a:b'], t2: ['d:e', 'c:d'] }, defaults.tiers), { t2: ['d:e', 'c:d'] });
  t.ok('設定は既定と違う項目だけを送る（既定値を凍らせない）', true);

  failure(t, names);
  await judgePanel(t);
  await effectiveLines(t);
}

/** 使える委譲先が無かった自動の委譲（エージェント向けのエラー文を読み、理由ごとにまとめる） */
function failure(t, names) {
  assert.equal(skipText('unavailable', 'not_installed'), '使えない（未インストール）');
  assert.equal(skipText('unavailable'), '使えない');
  assert.equal(skipText('quota_high', 'not_installed'), '使用量が多い', '中身を添えるのは「使えない」だけ');
  t.ok('「使えない」に中身（無効・未インストール・トークン未登録）を添える', true);

  const ja = ['使える委譲先がありません（種類 mechanical、難しさ mid）。飛ばした候補:',
    '- antigravity:gemini-3.8-flash-high (t2): usage_unknown',
    '- codex:gpt-6-luna (t2): unavailable (disabled)',
    '- claude:sonnet (t2): quota_high 週次 84%',
    '- claude:fable (t4): pace_high 週次 12% pace 1.4',
    '- codex:gpt-6-sol (t3): unavailable (disabled)',
    'backend を指定して固定で頼み直すか、ユーザーに確認してください。'].join('\n');
  const parsed = parseRoutingFailure(ja);
  assert.equal(parsed.kind, 'mechanical');
  assert.equal(parsed.difficulty, 'mid');
  assert.equal(parsed.skipped.length, 5);
  assert.deepEqual(parsed.skipped[1], { candidate: 'codex:gpt-6-luna', tier: 't2', reason: 'unavailable', detail: 'disabled' });
  assert.deepEqual(parsed.skipped[2].window, { label: '週次', usedPercent: 84 });
  assert.deepEqual(parsed.skipped[3].window, { label: '週次', usedPercent: 12, pace: 1.4 });
  const en = 'No delegation target is usable (kind implement, difficulty high). Skipped candidates:\n- claude:opus (t4): unavailable\nRetry with an explicit backend, or ask the user.';
  assert.deepEqual(parseRoutingFailure(en), { kind: 'implement', difficulty: 'high', skipped: [{ candidate: 'claude:opus', tier: 't4', reason: 'unavailable' }] });
  assert.equal(parseRoutingFailure('kind は必須です'), null, '振り分けの失敗でない文は読まない');
  t.ok('エラー文から種類・難しさ・候補の行（理由・中身・枠・ペース）を読む。文の言語によらない', true);

  const groups = groupSkipped(parsed.skipped);
  assert.deepEqual(groups.map(g => g.reason), ['unavailable', 'quota_high', 'pace_high', 'usage_unknown'], '直せば通るもの → 待てば戻るものの順');
  assert.equal(groupText(groups[0], names), 'Codex 2（無効）');
  assert.equal(groupText(groups[1], names), 'Sonnet 週次 84%');
  assert.equal(groupText(groups[2], names), 'fable 週次 1.4 倍');
  t.ok('理由ごとに 1 行。使えないものはエージェントごとの件数、使用量は候補ごとの値', true);

  const opened = [];
  const [why, fold] = routingFailureParts(parsed, { names, open: reason => (reason === 'unavailable' ? { label: 'エージェント設定を開く', run: () => opened.push(reason) } : null) });
  const rows = why.querySelectorAll('li');
  assert.equal(rows.length, 4);
  assert.ok(!why.textContent.includes('unavailable') && !why.textContent.includes('quota_high'), '内部の理由のコードは見える行に出さない');
  rows[0].querySelector('button').onclick({ preventDefault() {}, stopPropagation() {} });
  assert.deepEqual(opened, ['unavailable']);
  assert.equal(fold.tagName.toLowerCase(), 'details');
  assert.equal(fold.querySelectorAll('li').length, 5, '候補ごとの一覧は折りたたみの中');
  t.ok('開かなくても見える理由の行と直す入口、候補ごとの一覧は折りたたむ', true);
}

/** 設定 › 委譲のスイッチの直下: 効いていない理由だけを出す（平常時・オフのときは何も出さない） */
async function effectiveLines(t) {
  const defaults = { enabled: true, judgeByKind: { implement: 'jev' }, escalateToCerebras: false, tiers: { t1: ['codex:gpt-6-sol'] }, table: { implement: ['t1', 't1', 't1'] },
    avoidPercent: 80, paceLimit: 1.5, staleMinutes: 10 };
  let settings = structuredClone(defaults), hasKey = false, usable = false;
  const state = () => structuredClone({ settings, defaults, kinds: ['implement'], judges: ['jev', 'cerebras', 'none'], tiers: ['t1'],
    candidates: [{ candidate: 'codex:gpt-6-sol', backend: 'codex', model: 'gpt-6-sol', tiers: ['t1'], usable, reason: usable ? null : 'unavailable', detail: 'disabled', windows: [] }],
    keys: { openrouter: { hasKey }, cerebras: { hasKey: false } }, storage: { encrypted: true } });
  const root = el('div'), tab = el('button');
  const saved = document.getElementById;
  document.getElementById = id => ({ delegationPanel: root, delegationTab: tab })[id] ?? null;
  try {
    const ui = setupDelegationSettings({ cmd: async () => state(), page() {}, showMenu() {}, labelOf: id => id, logo: () => el('span'), modelsOf: async () => ({}), modelName: () => '' });
    await ui.refresh();
    const eff = root.querySelector('.rt-eff');
    t.ok('キーが無い・使える候補が無い: スイッチの直下に ⚠ の行が 2 つと直す入口', eff && !eff.hidden && eff.querySelectorAll('p').length === 2
      && eff.querySelectorAll('button').length === 2 && eff.textContent.includes('⚠'));
    t.ok('判定表の下の同じ警告は出さない', !root.querySelector('.rt-judges').textContent.includes('⚠'));
    hasKey = true; usable = true;
    await ui.refresh();
    t.ok('平常時は何も出さない', root.querySelector('.rt-eff').hidden === true);
    hasKey = false; settings.enabled = false;
    await ui.refresh();
    t.ok('スイッチがオフなら何も出さない', root.querySelector('.rt-eff').hidden === true);
    settings.enabled = true; usable = false;
    await ui.refresh();
    const detail = root.querySelector('.rt-advanced').textContent;
    t.ok('詳しい設定の候補の「使えない」に中身を添える', detail.includes('使えない（無効）'));
  } finally {
    document.getElementById = saved;
  }
}

/** 設定 › 委譲の判定器の面。押したボタンにフォーカスが残っていても、選び直しが画面に出てフォーカスが戻る */
async function judgePanel(t) {
  const judgeDefaults = { implement: 'jev', review: 'jev' };
  const defaults = { enabled: true, judgeByKind: judgeDefaults, escalateToCerebras: false, tiers: { t1: [] }, table: { implement: ['t1', 't1', 't1'], review: ['t1', 't1', 't1'] },
    avoidPercent: 80, paceLimit: 1.5, staleMinutes: 10 };
  let settings = structuredClone(defaults);
  const state = () => structuredClone({ settings, defaults, kinds: ['implement', 'review'], judges: ['jev', 'cerebras', 'none'], tiers: ['t1'], candidates: [],
    keys: { openrouter: { hasKey: true }, cerebras: { hasKey: true } }, storage: { encrypted: true } });
  let release = null;
  const cmd = async (name, args) => {
    if (name === 'setDelegationRouting') {
      await new Promise(r => { release = r; });
      const { judgeByKind, ...rest } = args.settings;
      if (judgeByKind !== undefined) settings.judgeByKind = { ...judgeDefaults, ...(judgeByKind ?? {}) };
      Object.assign(settings, rest);
    }
    return state();
  };
  const root = el('div'), tab = el('button');
  const saved = { getElementById: document.getElementById, activeElement: document.activeElement, focus: N.prototype.focus };
  document.getElementById = id => ({ delegationPanel: root, delegationTab: tab })[id] ?? null;
  N.prototype.focus = function () { if (!this.disabled) document.activeElement = this; };
  try {
    const ui = setupDelegationSettings({ cmd, page() {}, showMenu() {}, labelOf: id => id, logo: () => el('span'), modelsOf: async () => ({}), modelName: () => '' });
    await ui.refresh();
    // 並びで引く（種類の行 × 判定器のボタン、聞き直しは面の最初の入力欄）
    const control = key => {
      if (key === 'escalate') return root.querySelector('.rt-judges').querySelector('input');
      const [kind, judge] = key.split(':');
      const row = root.querySelectorAll('.rt-judge-row')[['implement', 'review'].indexOf(kind)];
      return row.querySelector('.rt-seg').children[['jev', 'cerebras', 'none'].indexOf(judge)];
    };
    const tick = () => new Promise(r => setImmediate(r));

    // クリックでボタンにフォーカスが移る（Chromium）。その状態で保存が返ってくる
    const cerebras = control('implement:cerebras');
    document.activeElement = cerebras;
    cerebras.onclick();
    t.ok('保存中は判定器のボタンを押せない', control('implement:cerebras').disabled === true && control('review:none').disabled === true);
    release(); await tick();
    const after = control('implement:cerebras');
    t.ok('押した判定器に選択が移る', after.classList.contains('on') && after.getAttribute('aria-pressed') === 'true'
      && !control('implement:jev').classList.contains('on') && settings.judgeByKind.implement === 'cerebras');
    t.ok('描き直した後も押したボタンにフォーカスが残る', document.activeElement === after);

    // 別の画面から変わった（delegationRoutingChanged）ときも、フォーカスが面の中にあっても描き直す
    settings.judgeByKind.review = 'none';
    await ui.refresh();
    t.ok('フォーカスが面の中にあっても、届いた設定を描き直す', control('review:none').classList.contains('on') && document.activeElement === control('implement:cerebras'));

    const box = control('escalate');
    document.activeElement = box;
    box.checked = true;
    box.onchange();
    release(); await tick();
    t.ok('聞き直しのチェックも保存して描き直し、フォーカスを戻す', control('escalate').checked === true && settings.escalateToCerebras === true && document.activeElement === control('escalate'));
  } finally {
    document.getElementById = saved.getElementById;
    document.activeElement = saved.activeElement;
    N.prototype.focus = saved.focus;
  }
}
