// settings.set: 設定の一覧から作る書き込み（registry 越し。サーバーは身代わりの依存）。ADR 0081・0082。
//   - 全設定 × 全主体の判定表（human / agent の束縛なし・ask・bypass 相当・読み取り）と、関所を緩める向きの riskExamples
//   - 値の検査（INVALID）と、読むだけの設定（SETTING_READ_ONLY）、human-only の設定は agent に無いのと同じ
//   - 承認カード: 待たずに承認待ち（PENDING_APPROVAL・requestId）を返し、許可（proceed）で実行する。受領証（承認のあとに値が変わったら聞き直す）。変わらない設定は聞かない
//   - bypass 相当の会話は承認なしで通り、記録（audit・recordSetting）が残る。束縛なしの guarded は NEEDS_UI
import { registry } from '../../core/ops/index.mjs';
import { decide } from '../../core/ops/policy.mjs';
import { receiptOf, stableStringify } from '../../core/ops/registry.mjs';
import { diffRows } from '../../core/ops/settings.mjs';

export const name = 'ops-settings';
export const title = '設定を書く(settings.set): 全設定 × 全主体の判定・値の検査・承認カードと受領証・記録';

const human = { by: 'human', via: 'ui', local: true };
const unbound = { by: 'agent', via: 'cli' };
const bound = (sessionId) => ({ by: 'agent', via: 'mcp', sessionId });
const MODES = {
  ask: { scope: 'workspace', autonomy: 'ask' },
  bypass: { scope: 'full', autonomy: 'never' },
  plan: { scope: 'readonly', autonomy: 'ask' },
};

/**
 * 身代わりのサーバー: prefs を持ち、書き込みは prefs へ。approve は呼ばれた内容を溜めて、既定では承認待ち（{ pending, requestId }）を返す。
 * 人の許可は allow(i)（i 番目の要求の proceed を呼ぶ。サーバーが許可の後に呼ぶのと同じ）
 */
function fake({ prefs: initial = {}, answers = [] } = {}) {
  const prefs = { ...initial };
  const log = { writes: [], approvals: [], records: [], audits: [] };
  const queue = [...answers];
  const deps = {
    locale: 'ja',
    prefs: async () => ({ ...prefs }),
    compactionSettings: () => prefs.autoCompaction ?? { enabled: true, minTokens: 150000, claude: { enabled: true, delayMinutes: 60 }, codex: { enabled: true, delayMinutes: 60 } },
    routingSettings: () => ({ enabled: false }),
    plyInstructions: () => [],
    contextDefaults: () => null,
    modeOf: async (id) => MODES[id.split(':')[0]],
    host: {
      hasBackend: (id) => ['claude', 'codex', 'fake'].includes(id),
      knows: async (key, value) => (key === 'mode' ? ['default', 'auto', 'plan', 'bypass'].includes(value) : ['fast', 'smart', ''].includes(value)),
      accountIds: async () => ['a1'],
      changePlyInstructions: () => { throw new Error('unused'); },
    },
    writes: {
      pref: async (key, value) => { log.writes.push(['pref', key, value]); if (value === null) delete prefs[key]; else prefs[key] = value; },
      browserPref: async (key, value) => { log.writes.push(['browserPref', key, value]); prefs[key] = value; },
      plyInstructions: async (value) => { log.writes.push(['plyInstructions', value]); },
      compaction: async (value) => { log.writes.push(['compaction', value]); prefs.autoCompaction = value; },
    },
    recordSetting: async (entry) => { log.records.push(entry); },
    audit: async (entry) => { log.audits.push(entry); },
    approve: async (request) => {
      log.approvals.push(request);
      const next = queue.shift();
      return typeof next === 'function' ? next(request, prefs) : next ?? { pending: true, requestId: request.requestId ?? `setting-${log.approvals.length}` };
    },
  };
  const allow = (i = log.approvals.length - 1) => log.approvals[i].proceed();
  return { prefs, log, deps, allow };
}

export default async function (t) {
  const settings = registry.settings;

  // ---- 全設定 × 全主体の判定表: 設定ごとの危険度から、主体ごとの判定が ADR 0082 の表どおり
  const principals = {
    human: human, 'agent-unbound': unbound,
    'agent-ask': { ...bound('ask'), mode: MODES.ask }, 'agent-bypass': { ...bound('bypass'), mode: MODES.bypass }, 'agent-plan': { ...bound('plan'), mode: MODES.plan },
  };
  const expected = {
    read: { human: 'allow', 'agent-unbound': 'allow', 'agent-ask': 'allow', 'agent-bypass': 'allow', 'agent-plan': 'allow' },
    write: { human: 'allow', 'agent-unbound': 'allow', 'agent-ask': 'allow', 'agent-bypass': 'allow', 'agent-plan': 'deny' },
    guarded: { human: 'allow', 'agent-unbound': 'deny', 'agent-ask': 'ask', 'agent-bypass': 'allow', 'agent-plan': 'deny' },
    'human-only': { human: 'allow', 'agent-unbound': 'hidden', 'agent-ask': 'hidden', 'agent-bypass': 'hidden', 'agent-plan': 'hidden' },
  };
  for (const s of settings) {
    for (const risk of s.riskOf ? [s.risk, 'guarded'] : [s.risk]) {
      const got = Object.fromEntries(Object.entries(principals).map(([who, p]) => [who, decide({ by: p.by, sessionId: p.sessionId, mode: p.mode }, risk).decision]));
      t.ok(`判定表 ${s.key}（${risk}）: 主体ごとの判定が ADR 0082 の表どおり`, JSON.stringify(got) === JSON.stringify(expected[risk]), JSON.stringify(got));
    }
  }
  t.ok('危険度の内訳: human-only は承認モードの既定と既定のアカウントだけ（ADR 0094）。guarded は許可の一覧以外の「全体の構成」',
    settings.filter((s) => s.risk === 'human-only').map((s) => s.key).sort().join() === 'claudeAccount,mode'
    && settings.filter((s) => s.risk === 'guarded').map((s) => s.key).sort().join() === 'addedContext,context.default,delegationRouting,launchAtLogin,plyInstructions'
    && settings.filter((s) => s.riskOf).map((s) => s.key).sort().join() === 'agentSitePermissions,computerUse,confirmAgentSites,confirmExternalLoads,externalSitePermissions,voice');

  // ---- riskOf は書いてある例のとおり（関所を緩める向きだけ guarded）
  for (const s of settings.filter((x) => x.riskOf)) {
    for (const e of s.riskExamples) t.ok(`riskOf ${s.key}: ${stableStringify(e.before).slice(0, 40)} → ${stableStringify(e.after).slice(0, 40)} は ${e.risk}`, s.riskOf(e.before, e.after) === e.risk);
    t.ok(`riskOf ${s.key}: 危険度の例に guarded と write の両方がある（向きで分かれる）`, new Set(s.riskExamples.map((e) => e.risk)).size === 2);
  }

  // ---- write の設定（agent が束縛なしでも通る）
  {
    const f = fake();
    const r = await registry.invoke(unbound, 'settings.set', { key: 'locale', value: 'en' }, f.deps);
    t.ok('write の設定は束縛なしの agent も書ける（locale）', r.ok && r.result.changed === true && f.prefs.locale === 'en' && f.log.approvals.length === 0, JSON.stringify(r));
    t.ok('保存は設定の write を通り、記録（recordSetting）に key・前後・理由・主体が渡る', f.log.writes[0].join() === 'pref,locale,en' && f.log.records[0].key === 'locale' && f.log.records[0].after === 'en' && f.log.records[0].actor.via === 'cli');
    const again = await registry.invoke(unbound, 'settings.set', { key: 'locale', value: 'en' }, f.deps);
    t.ok('同じ値を書いても changed: false（記録は残さない）', again.ok && again.result.changed === false && f.log.records.length === 1);
    t.ok('値の検査（locale）は INVALID', (await registry.invoke(unbound, 'settings.set', { key: 'locale', value: 'fr' }, f.deps)).code === 'INVALID');
    t.ok('値を省くと INVALID', (await registry.invoke(unbound, 'settings.set', { key: 'locale' }, f.deps)).code === 'INVALID');
    t.ok('null で消せる設定（instructionBudget）は消え、消せない設定（locale）は INVALID',
      (await registry.invoke(unbound, 'settings.set', { key: 'instructionBudget', value: 8000 }, f.deps)).ok && f.prefs.instructionBudget === 8000
      && (await registry.invoke(unbound, 'settings.set', { key: 'instructionBudget', value: null }, f.deps)).ok && !('instructionBudget' in f.prefs)
      && (await registry.invoke(unbound, 'settings.set', { key: 'locale', value: null }, f.deps)).code === 'INVALID');
    t.ok('範囲の検査（instructionBudget）', (await registry.invoke(unbound, 'settings.set', { key: 'instructionBudget', value: 5 }, f.deps)).code === 'INVALID');
    const model = await registry.invoke(unbound, 'settings.set', { key: 'model', value: 'fast', backend: 'codex' }, f.deps);
    t.ok('model は backend つきで書ける（エージェントごとに覚える）。知らないモデル・エージェントは INVALID', model.ok && f.log.writes.at(-1).join() === 'pref,model,fast'
      && (await registry.invoke(unbound, 'settings.set', { key: 'model', value: 'nope' }, f.deps)).code === 'INVALID'
      && (await registry.invoke(unbound, 'settings.set', { key: 'model', value: 'fast', backend: 'nope' }, f.deps)).code === 'INVALID');
    t.ok('読み取り専用の会話は write も断る（READ_ONLY_MODE）', (await registry.invoke(bound('plan'), 'settings.set', { key: 'locale', value: 'ja' }, f.deps)).code === 'READ_ONLY_MODE');
    t.ok('読むだけの設定（addedContext）は SETTING_READ_ONLY', (await registry.invoke(human, 'settings.set', { key: 'addedContext', value: null }, f.deps)).code === 'SETTING_READ_ONLY');
    t.ok('無い設定は SETTING_NOT_FOUND', (await registry.invoke(human, 'settings.set', { key: 'nothing', value: 1 }, f.deps)).code === 'SETTING_NOT_FOUND');
  }

  // ---- human-only: agent には無いのと同じ。human は書ける
  {
    const f = fake();
    const hidden = await registry.invoke(bound('bypass'), 'settings.set', { key: 'mode', value: 'bypass' }, f.deps);
    const none = await registry.invoke(bound('bypass'), 'settings.set', { key: 'nothing', value: 'x' }, f.deps);
    t.ok('human-only（承認モード）は bypass の会話の agent にも SETTING_NOT_FOUND（無い設定と同じ）。書き込まれない',
      hidden.code === 'SETTING_NOT_FOUND' && none.code === 'SETTING_NOT_FOUND' && hidden.error.replace('mode', 'X') === none.error.replace('nothing', 'X') && !('mode' in f.prefs));
    t.ok('アカウントの既定も同じ（agent に無い）', (await registry.invoke(unbound, 'settings.set', { key: 'claudeAccount', value: 'a1' }, f.deps)).code === 'SETTING_NOT_FOUND');
    t.ok('human は承認モードの既定もアカウントの既定も書ける。知らないアカウントは INVALID',
      (await registry.invoke(human, 'settings.set', { key: 'mode', value: 'auto' }, f.deps)).ok && f.prefs.mode === 'auto'
      && (await registry.invoke(human, 'settings.set', { key: 'claudeAccount', value: 'a1' }, f.deps)).ok
      && (await registry.invoke(human, 'settings.set', { key: 'claudeAccount', value: 'zz' }, f.deps)).code === 'INVALID');
  }

  // ---- guarded（関所を緩める向き）: 会話の承認モードで決まる
  const loosen = { key: 'confirmAgentSites', value: false, reason: 'テストのため' };
  {
    const f = fake({ prefs: { confirmAgentSites: true } });
    const ng = await registry.invoke(unbound, 'settings.set', loosen, f.deps);
    t.ok('束縛なしの agent が確認を切る（関所を緩める）と NEEDS_UI。書かれず、聞かない', ng.code === 'NEEDS_UI' && f.prefs.confirmAgentSites === true && f.log.approvals.length === 0, JSON.stringify(ng));
    const plan = await registry.invoke(bound('plan'), 'settings.set', loosen, f.deps);
    t.ok('読み取り専用の会話は READ_ONLY_MODE（聞かない）', plan.code === 'READ_ONLY_MODE' && f.log.approvals.length === 0);
    const through = await registry.invoke(bound('bypass'), 'settings.set', loosen, f.deps);
    t.ok('bypass（範囲 full・自律 never）の会話は承認なしで通り、記録が残る', through.ok && f.prefs.confirmAgentSites === false && f.log.approvals.length === 0
      && f.log.audits.at(-1).reason === 'mode-never-full' && f.log.records.at(-1).actor.sessionId === 'bypass', JSON.stringify(through));
  }
  {
    // 狭める向き（確認をつける）は write: 承認なしで通る
    const f = fake({ prefs: { confirmAgentSites: false } });
    const ok = await registry.invoke(bound('ask'), 'settings.set', { key: 'confirmAgentSites', value: true }, f.deps);
    t.ok('関所を狭める向きは write として承認なしで通る', ok.ok && f.prefs.confirmAgentSites === true && f.log.approvals.length === 0);
  }

  // ---- 承認カード（待たずに返し、許可で実行する。ADR 0088）
  {
    const f = fake({ prefs: { confirmAgentSites: true } });
    const r = await registry.invoke(bound('ask'), 'settings.set', loosen, f.deps);
    const req = f.log.approvals[0];
    t.ok('ask の会話: 承認を求め、待たずに承認待ち（PENDING_APPROVAL・requestId・文）を返す。まだ書かない', r.ok && r.pending === true && r.result.status === 'pending' && r.result.code === 'PENDING_APPROVAL'
      && r.result.requestId === 'setting-1' && r.result.message.includes('setting-1') && r.result.message.includes('confirmAgentSites')
      && f.prefs.confirmAgentSites === true && f.log.writes.length === 0 && f.log.records.length === 0, JSON.stringify(r));
    t.ok('カードの中身: 操作・項目・前後の値（JSON の文字列）・理由・関所を緩める印・受領証・主体', req.op === 'settings.set' && req.change.key === 'confirmAgentSites'
      && req.change.rows.length === 1 && req.change.rows[0].path === 'confirmAgentSites' && req.change.rows[0].before === 'true' && req.change.rows[0].after === 'false'
      && req.change.loosens === true && req.reason === 'テストのため' && /^[a-f0-9]{32}$/.test(req.receipt) && req.actor.sessionId === 'ask' && !('requestId' in req));
    t.ok('受領証は 操作・引数・承認時の前の値 の印', req.receipt === receiptOf('settings.set', loosen, true));
    const done = await f.allow();
    t.ok('許可（proceed）で実行され、結果を返す', done.ok && done.result.changed === true && f.prefs.confirmAgentSites === false, JSON.stringify(done));
    t.ok('許可のあとに記録が残る（承認を飛ばさない）', f.log.records.length === 1 && f.log.audits.at(-1).reason === 'mode-needs-approval');
    const en = await registry.invoke(bound('ask'), 'settings.set', { ...loosen, value: true }, { ...fake({ prefs: { confirmAgentSites: false } }).deps, locale: 'en' });
    t.ok('狭める向きは承認なし（英語の会話でも同じ）', en.ok && !en.pending);
  }
  {
    // 拒否は proceed を呼ばない（サーバーが結果を会話へ届ける）。承認の口が承認待ちを返さなければ、その code で断る
    const f = fake({ prefs: { confirmAgentSites: true } });
    await registry.invoke(bound('ask'), 'settings.set', loosen, f.deps);
    t.ok('答えが無い・拒否のあいだは何も書かれず、記録も残らない', f.prefs.confirmAgentSites === true && f.log.records.length === 0 && f.log.writes.length === 0 && f.log.audits.length === 0);
    const g = fake({ prefs: { confirmAgentSites: true }, answers: [{ allow: false, code: 'NEEDS_UI' }] });
    const x = await registry.invoke(bound('ask'), 'settings.set', loosen, g.deps);
    t.ok('承認の口が断れば（会話が無いなど）、その code で断り、設定は変わらない', x.code === 'NEEDS_UI' && g.prefs.confirmAgentSites === true && g.log.writes.length === 0);
  }
  {
    // 承認のあとに値が変わった（別の口が先に書いた）→ 受領証が合わず、同じ requestId で聞き直す
    const f = fake({ prefs: { agentSitePermissions: [] } });
    const add = { key: 'agentSitePermissions', value: [{ origin: 'https://a.example', mode: 'always', agent: 'claude' }] };
    const r = await registry.invoke(bound('ask'), 'settings.set', add, f.deps);
    f.prefs.agentSitePermissions = [{ origin: 'https://other.example', mode: 'ask', agent: 'claude' }];
    const again = await f.allow(0);
    t.ok('許可のあとに前の値が変わっていたら、受領証が合わず同じ requestId で聞き直す（まだ書かない）', r.pending && again.pending === true && again.result.requestId === r.result.requestId
      && f.log.approvals.length === 2 && f.log.approvals[1].requestId === r.result.requestId && f.log.approvals[0].receipt !== f.log.approvals[1].receipt && f.log.writes.length === 0, JSON.stringify(again));
    const done = await f.allow(1);
    t.ok('聞き直したカードの許可で実行される', done.ok && JSON.stringify(f.prefs.agentSitePermissions) === JSON.stringify(add.value));
    const g = fake({ prefs: { agentSitePermissions: [] } });
    await registry.invoke(bound('ask'), 'settings.set', add, g.deps);
    let last;
    for (let i = 0; i < 4 && (i === 0 || last?.pending); i++) {
      g.prefs.agentSitePermissions = [{ origin: `https://x${i}.example`, mode: 'ask', agent: 'claude' }];
      last = await g.allow(i);
    }
    t.ok('変わり続けたら STALE で行わない（無限に聞かない）', last.code === 'STALE' && g.log.approvals.length === 3 && g.log.writes.length === 0, JSON.stringify(last));
  }
  {
    // 承認の口が無い呼び出し（単体の検査・古い呼び出し元）は NEEDS_APPROVAL
    const f = fake({ prefs: { confirmAgentSites: true } });
    delete f.deps.approve;
    t.ok('承認の口が無ければ NEEDS_APPROVAL（実行しない）', (await registry.invoke(bound('ask'), 'settings.set', loosen, f.deps)).code === 'NEEDS_APPROVAL' && f.prefs.confirmAgentSites === true);
  }
  {
    // サイトの許可: 足す（always）は guarded、消す・ask に戻すは write
    const f = fake({ prefs: { agentSitePermissions: [{ origin: 'https://a.example', mode: 'always', agent: 'claude' }] } });
    const rm = await registry.invoke(bound('ask'), 'settings.set', { key: 'agentSitePermissions', value: [] }, f.deps);
    t.ok('「常に許可」を消す向きは write（承認なし）', rm.ok && f.log.approvals.length === 0);
    const add = await registry.invoke(bound('ask'), 'settings.set', { key: 'agentSitePermissions', value: [{ origin: 'https://b.example', mode: 'always', agent: 'claude' }] }, f.deps);
    t.ok('「常に許可」を足す向きは承認カード。行は項目名と前後の値', add.pending && f.log.approvals.length === 1 && f.log.approvals[0].change.rows[0].before === '[]' && f.log.approvals[0].change.loosens === true);
    t.ok('サイトの許可の形が違えば INVALID（聞く前に断る）', (await registry.invoke(bound('ask'), 'settings.set', { key: 'agentSitePermissions', value: [{ origin: 'ftp://x', mode: 'always', agent: 'a' }] }, f.deps)).code === 'INVALID' && f.log.approvals.length === 1);
  }
  {
    // 全体の構成（常に guarded）: 値が無効なら聞かない。変わらないなら聞かない
    // plyInstructions の変更後の一覧は host（core/ply-instructions.mjs の changePlyInstructions）が出す。ここでは呼び出しごとに差し替える
    const f = fake();
    let next = () => { throw new Error('no such instruction'); };
    f.deps.host.changePlyInstructions = (action) => next(action);
    const bad = await registry.invoke(bound('ask'), 'settings.set', { key: 'plyInstructions', value: { action: 'toggle', id: 'x' } }, f.deps);
    t.ok('guarded でも無効な値は聞く前に INVALID', bad.code === 'INVALID' && f.log.approvals.length === 0);
    next = () => [];
    const same = await registry.invoke(bound('ask'), 'settings.set', { key: 'plyInstructions', value: { action: 'order', ids: [] } }, f.deps);
    t.ok('変わらない値は聞かない（write と同じ扱いで通り、changed: false）', same.ok && same.result.changed === false && f.log.approvals.length === 0);
    next = () => [{ id: 'x', title: '委譲', enabled: true }];
    const changed = await registry.invoke(bound('ask'), 'settings.set', { key: 'plyInstructions', value: { action: 'toggle', id: 'x' } }, f.deps);
    t.ok('Pleiad の指示の変更は guarded（承認カード）。⚠ の印は付けない（関所を緩める向きではない）', changed.pending && f.log.approvals.length === 1 && f.log.approvals[0].change.loosens === false);
  }
  {
    // computerUse: オブジェクトの設定は変わった項目だけを行にする
    const f = fake({ prefs: { computerUse: { enabled: false, allowAllApps: false } } });
    const r = await registry.invoke(bound('ask'), 'settings.set', { key: 'computerUse', value: { enabled: true } }, f.deps);
    const rows = f.log.approvals[0].change.rows;
    t.ok('computerUse を有効にする: 承認カードの行は変わった項目だけ（computerUse.enabled）', r.pending && rows.length === 1 && rows[0].path === 'computerUse.enabled' && rows[0].before === 'false' && rows[0].after === 'true' && f.log.approvals[0].change.loosens === true, JSON.stringify(rows));
  }

  // ---- 行の作り方
  t.ok('diffRows: スカラーは 1 行・オブジェクトは変わった項目だけ・無かった値は null', JSON.stringify(diffRows('a', 1, 2)) === '[{"path":"a","before":"1","after":"2"}]'
    && JSON.stringify(diffRows('o', { x: 1, y: 2 }, { x: 1, y: 3, z: 4 })) === '[{"path":"o.y","before":"2","after":"3"},{"path":"o.z","before":null,"after":"4"}]');
  t.ok('diffRows: 長い値は切る・行は 8 まで', diffRows('a', 'x'.repeat(500), 'y')[0].before.length <= 160
    && diffRows('o', {}, Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`k${i}`, i]))).length === 8);
  t.ok('stableStringify: キーの順に依らない', stableStringify({ b: 1, a: [2, { d: 1, c: 2 }] }) === stableStringify({ a: [2, { c: 2, d: 1 }], b: 1 }));
}
