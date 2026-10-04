// 委譲カードの振り分けの理由と設定 › 委譲の組み立て（web/delegation-routing-view.mjs・web/delegation-settings.mjs）。DOM の大半は触らず、文と並びだけ見る
import assert from 'node:assert/strict';
import { routingLine, skippedPhrase, judgeLine, tierLine, yesSignals, fallbackText, retryCandidates, retryPanel, usageRows, usageSummary, isAutoRouting, fallbackName, routingDetail, pinnedDetail,
  skipText, parseRoutingFailure, groupSkipped, groupText, routingFailureParts } from '../../web/delegation-routing-view.mjs';
import { diffFromDefaults, setupDelegationSettings } from '../../web/delegation-settings.mjs';
import { el } from '../../web/dom.mjs';
import { N } from '../lib/dom-stub.mjs';
import { readFileSync } from 'node:fs';

export const name = 'delegation-routing-view';
export const title = '委譲カードの理由・内訳の文、やり直しの候補の並び、設定の差分と判定器の面の描き直し';

export default async function (t) {
  const names = { backend: id => ({ codex: 'Codex', claude: 'Claude Code' })[id] ?? id, model: (_b, m) => ({ sonnet: 'Sonnet', 'gpt-6-sol': 'gpt-6-sol' })[m] ?? m };
  const routing = { mode: 'auto', kind: 'implement', judge: 'jev', signals: { diagnose: false, choose: true, long_procedure: false, many_parts: false, writes_shared: true, security_gate: false },
    difficulty: 'mid', baseTier: 't3', tier: 't3', target: { backend: 'codex', model: 'gpt-6-sol', account: null },
    skipped: [{ candidate: 'claude:sonnet', tier: 't3', reason: 'quota_high', window: { label: '週次', minutes: 10080, usedPercent: 73.4 } }], usageAt: '2026-09-26T05:32:08.000Z', fallback: null };
  assert.equal(routingLine(routing, names), '実装・中 → Codex gpt-6-sol · Sonnet は週次 73% で飛ばした');
  assert.equal(routingLine({ ...routing, skipped: [] }, names), '実装・中 → Codex gpt-6-sol');
  assert.equal(routingLine({ ...routing, selectedWithLowHeadroom: { reason: 'quota_high', window: { label: '週次', usedPercent: 83 }, avoidPercent: 70 } }, names),
    '実装・中 → Codex gpt-6-sol · 使用量が多いが選んだ（週次 83%・線 70%）');
  assert.equal(routingLine({ ...routing, baseTier: 't4', tier: 't3', skipped: [] }, names), '実装・中 → Codex gpt-6-sol · 下の段から選んだ');
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
  assert.equal(tierLine({ ...routing, tier: 't4' }), '段 4（表では 段 3。余裕ありの候補が無く上げた）');
  assert.equal(tierLine({ ...routing, baseTier: 't4' }), '段 3（表では 段 4。下の段から選んだ）');
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
    { candidate: 'claude:sonnet', backend: 'claude', model: 'sonnet', tiers: ['t2', 't3'], usable: true, deferred: true, reason: 'quota_high', windows: [] },
    { candidate: 'claude:opus', backend: 'claude', model: 'opus', tiers: ['t4'], usable: true, account: 'work',
      accounts: [{ account: '', label: 'main', usable: true, deferred: true, reason: 'quota_high', windows: [{ label: '週次', usedPercent: 90 }] },
        { account: 'work', label: 'work', usable: true, windows: [{ label: '週次', usedPercent: 12.4 }, { label: '5時間', usedPercent: null }] },
        { account: 'blocked', label: 'blocked', usable: false, reason: 'quota_full', windows: [{ label: '5時間', usedPercent: 100 }] }] },
    { candidate: 'codex:gpt-6-astra', backend: 'codex', model: 'gpt-6-astra', tiers: ['tv'], usable: true, windows: [] },
  ];
  assert.deepEqual(retryCandidates(cands, routing).map(c => c.candidate), ['claude:sonnet', 'claude:opus', 'claude:opus', 'codex:gpt-6-astra', 'antigravity:gemini-3.8-flash-high'],
    '使えるものだけ・元の委譲先を除く・元の段から上、次に下');
  assert.deepEqual(retryCandidates(cands, { ...routing, target: { backend: 'claude', model: 'opus', account: 'work' } })
    .filter(c => c.candidate === 'claude:opus').map(c => c.account), [''], '同じモデルでも別の認証はやり直しに残す');
  assert.equal(usageSummary(cands[3]), '週次 12%', 'Claude は使うアカウントの枠。率の分からない枠は出さない');
  const bars = usageRows([{ label: '5時間', minutes: 300, usedPercent: 87 }, { label: '週次', minutes: 10080, usedPercent: 83 }], { avoidPercent: 70 });
  assert.equal(bars.querySelectorAll('.usage-bar').filter(bar => bar.classList.contains('high')).length, 1, '5 時間は線を超えても強調せず、週次は強調する');
  const retry = retryPanel({ candidates: retryCandidates(cands, routing), running: false, names, run: async () => ({}), close() {} });
  assert.ok(retry.textContent.includes('余裕が少ない（使用量が多い）'), '後回しの候補も選択肢に理由を添える');
  let retryArgs;
  const claudeRetry = retryPanel({ candidates: retryCandidates(cands, routing).filter(c => c.candidate === 'claude:opus'), running: false, names,
    run: async args => { retryArgs = args; return {}; }, close() {} });
  assert.ok(claudeRetry.textContent.includes('main') && claudeRetry.textContent.includes('work') && !claudeRetry.textContent.includes('blocked'),
    '認証を別々の候補として表示し、使えない認証は除く');
  claudeRetry.querySelectorAll('input')[1].onchange();
  await claudeRetry.querySelector('.btn-primary').onclick();
  assert.deepEqual(retryArgs, { candidate: 'claude:opus', account: 'work' }, '選んだ認証をサーバーへ渡す');
  t.ok('やり直しの候補は、今使えるものを元の段から上へ、次に下の段の順', true);

  const detail = routingDetail(routing, { names });
  const listed = detail.querySelectorAll('.rt-cand');
  assert.ok(listed.length === 2 && listed[1].className.includes('used') && !listed[0].className.includes('used'), '飛ばした候補と使った候補を順に');
  const accountDetail = routingDetail({ ...routing, target: { backend: 'claude', model: 'opus', account: 'oz', accountLabel: 'OZ' },
    skipped: [{ candidate: 'claude:opus', tier: 't4', account: '', accountLabel: 'main', reason: 'quota_full', window: { label: '5時間', usedPercent: 100 } },
      { candidate: 'claude:opus', tier: 't4', account: 'second', accountLabel: 'second', reason: 'quota_high', window: { label: '週次', usedPercent: 83 } }] }, { names });
  assert.equal(accountDetail.querySelectorAll('.rt-cand').length, 3, 'Claude の認証を使ったものも含めて個別のカードにする');
  assert.ok(accountDetail.querySelectorAll('.rt-cand')[0].textContent.includes('main')
    && accountDetail.querySelectorAll('.rt-cand')[1].textContent.includes('second')
    && accountDetail.querySelectorAll('.rt-cand')[2].textContent.includes('OZ'));
  assert.equal(detail.querySelector('.rt-retry-open'), null, 'onRetry が無ければやり直しの口を出さない');
  t.ok('内訳は試した候補を順に並べ、使ったものに印', true);

  // 依頼元が委譲先を書いた（固定の）委譲: 自動と同じ「委譲」の形で、1 行は「種類 → 委譲先」。内訳は種類・委譲先・承認モード・作業場所だけ
  const pinned = { mode: 'pinned', kind: 'implement', difficulty: null, tier: null, target: { backend: 'codex', model: null }, skipped: [] };
  assert.equal(routingLine(pinned, names), '実装 → Codex');
  assert.equal(routingLine({ ...pinned, target: { backend: 'codex', model: 'gpt-6-sol' } }, names), '実装 → Codex gpt-6-sol');
  // 依頼元が子の設定を替えた（ADR 0134）: 行き先は新しい委譲先で、元の委譲先を添える。自動でも飛ばした候補の一言は出さない（替える前の選び方なので）
  const changed = { by: 'parent', at: '2026-10-04T00:00:00.000Z', from: { backend: 'claude', model: 'sonnet' }, count: 1 };
  assert.equal(routingLine({ ...pinned, target: { backend: 'codex', model: 'gpt-6-sol' }, changed }, names), '実装 → Codex gpt-6-sol · 依頼元が変更（元: Claude Code Sonnet）');
  assert.equal(routingLine({ ...routing, changed }, names), '実装・中 → Codex gpt-6-sol · 依頼元が変更（元: Claude Code Sonnet）');
  t.ok('依頼元が替えた委譲は、新しい委譲先と元の委譲先を 1 行に出す', true);
  const facts = pinnedDetail(pinned, { names, mode: '都度確認', cwd: String.raw`D:\dev\pleiad` });
  const factText = facts.textContent;
  assert.ok(factText.includes('Codex（依頼元が指定）') && factText.includes('都度確認') && factText.includes('pleiad'), factText);
  assert.equal(facts.querySelectorAll('.rt-cand').length, 0, '候補は出さない');
  assert.equal(facts.querySelector('.rt-retry-open'), null, 'やり直しは出さない');
  t.ok('固定の委譲の 1 行と内訳（判定・候補・やり直しは出さない）', true);

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
  const perAccount = parseRoutingFailure('使える委譲先がありません（種類 design、難しさ mid、後回しの線 70%）。候補とアカウントごとの理由:\n- claude:opus [first] (t4): quota_full 週次 100%\n- claude:opus [oz] (t4): quota_full 5時間 100%');
  assert.deepEqual(perAccount.skipped.map(a => [a.accountLabel, a.window.label]), [['first', '週次'], ['oz', '5時間']]);
  const [fullReasons, fullCandidates] = routingFailureParts(perAccount, { names });
  assert.ok(fullReasons.textContent.includes('週次 100%') && fullCandidates.textContent.includes('oz') && fullCandidates.textContent.includes('5時間 100%')
    && fullCandidates.querySelectorAll('li').length === 2);
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
    avoidPercent: 80, paceLimit: 1.5 };
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
  const defaults = { enabled: true, judgeByKind: judgeDefaults, escalateToCerebras: false, tiers: { t1: ['claude:haiku'] }, table: { implement: ['t1', 't1', 't1'], review: ['t1', 't1', 't1'] },
    avoidPercent: 80, paceLimit: 1.5 };
  let settings = structuredClone(defaults);
  let candidates = [{ candidate: 'claude:haiku', backend: 'claude', usable: true, checkedAt: '2026-09-27T00:00:00Z', windows: [] }];
  const state = () => structuredClone({ settings, defaults, kinds: ['implement', 'review'], judges: ['jev', 'cerebras', 'none'], tiers: ['t1'], candidates,
    keys: { openrouter: { hasKey: true }, cerebras: { hasKey: true } }, storage: { encrypted: true } });
  const releases = [], sent = [];
  const cmd = async (name, args) => {
    if (name === 'setDelegationRouting') {
      sent.push(args.settings);
      await new Promise((resolve, reject) => { releases.push({ resolve, reject }); });
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
    t.ok('押した瞬間に選択が変わり、ほかの判定器も押せる', control('implement:cerebras').classList.contains('on') && !control('review:none').disabled);
    control('review:none').onclick();
    t.ok('保存中の次の変更もすぐ表示し、送信は最初の保存を待つ', control('review:none').classList.contains('on') && sent.length === 1);
    releases.shift().resolve(); await tick();
    t.ok('2 件目は 1 件目の完了後に送る', sent.length === 2 && sent[1].judgeByKind.review === 'none');
    releases.shift().resolve(); await tick();
    const after = control('implement:cerebras');
    t.ok('押した判定器に選択が移る', after.classList.contains('on') && after.getAttribute('aria-pressed') === 'true'
      && !control('implement:jev').classList.contains('on') && settings.judgeByKind.implement === 'cerebras' && settings.judgeByKind.review === 'none');

    // 別の画面から変わった（delegationRoutingChanged）ときも、フォーカスが面の中にあっても描き直す
    settings.judgeByKind.review = 'jev';
    await ui.refresh();
    t.ok('フォーカスが面の中にあっても、届いた設定を描き直す', control('review:jev').classList.contains('on'));

    const box = control('escalate');
    document.activeElement = box;
    box.checked = true;
    box.onchange();
    releases.shift().resolve(); await tick();
    t.ok('聞き直しのチェックも保存して描き直し、フォーカスを戻す', control('escalate').checked === true && settings.escalateToCerebras === true && document.activeElement === control('escalate'));
    control('review:none').onclick();
    t.ok('失敗する保存も先に画面へ反映する', control('review:none').classList.contains('on'));
    releases.shift().reject(new Error('denied')); await tick();
    t.ok('保存に失敗した値だけを巻き戻し、理由を 1 行に出す', control('review:jev').classList.contains('on') && root.querySelector('.rm-state').textContent.includes('denied'));

    const row = root.querySelector('.rt-cand-row');
    const input = root.querySelector('.rt-number').querySelector('input');
    input.value = '73'; document.activeElement = input;
    candidates = [{ ...candidates[0], usable: false, reason: 'quota_high' }];
    await ui.event({ type: 'delegationRoutingChanged', change: 'usage' });
    t.ok('使用量だけの知らせで候補の行・入力とフォーカスを保ち、使えるかどうかだけを変える',
      root.querySelector('.rt-cand-row') === row && row.classList.contains('off') && input.value === '73' && document.activeElement === input);
    candidates = [{ ...candidates[0], usable: true, deferred: true, reason: 'quota_high' }];
    await ui.event({ type: 'delegationRoutingChanged', change: 'usage' });
    t.ok('余裕が少ない候補は選べる状態で理由を表示する', !row.classList.contains('off') && row.textContent.includes('余裕が少ない（使用量が多い）'));
    candidates = [{ ...candidates[0], usable: true, deferred: false, reason: null, accounts: [
      { account: '', label: 'main', usable: false, reason: 'quota_full', windows: [{ label: '5時間', usedPercent: 100 }] },
      { account: 'oz', label: 'OZ', usable: true, deferred: true, reason: 'quota_high', windows: [{ label: '週次', usedPercent: 83 }] },
    ] }];
    await ui.event({ type: 'delegationRoutingChanged', change: 'usage' });
    t.ok('設定の候補は Claude の認証ごとに状態と理由を別行に出す', row.querySelectorAll('small').length === 2
      && row.textContent.includes('main · 使用枠を使い切った') && row.textContent.includes('OZ · 余裕が少ない（使用量が多い）'));
  } finally {
    document.getElementById = saved.getElementById;
    document.activeElement = saved.activeElement;
    N.prototype.focus = saved.focus;
  }

  // ---- 配線（client.mjs）: 失敗したカードも入力・出力を「入力・出力（JSON）」の折りたたみの奥へ
  {
    const client = readFileSync(new URL('../../web/client.mjs', import.meta.url), 'utf8');
    const failed = client.slice(client.indexOf('function decorateFailedDelegate('), client.indexOf('function paintRouteLine('));
    const ok = client.slice(client.indexOf('function decorateDelegateCard('), client.indexOf('function decorateFailedDelegate('));
    t.ok('自動の委譲が失敗したカードも、成功・固定のカードと同じく JSON を折りたたみの奥へ（開くとそのまま出ていた）',
      /foldDelegateJson\(card\);/.test(failed) && /foldDelegateJson\(card\);/.test(ok));
  }
}
