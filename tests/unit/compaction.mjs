import { createCompactionScheduler, idleCompactionGuards } from '../../core/compaction-scheduler.mjs';
import { normalizeCompactionSettings, delegatedCompactWindow, delegatedCompactPlan } from '../../core/compaction-settings.mjs';
import { createContextBases } from '../../core/context-bases.mjs';
import { backend as claude, setClaudeSdkForTest } from '../../core/backends/claude.mjs';
import { normalizeSdkMessage, createClaudeCompactDiagnostic, claudeCompactionsFromHistory } from '../../core/backends/claude-normalize.mjs';
import { codexContextWindow, codexCompactionEvent } from '../../core/backends/codex.mjs';
import { mergeCompactionHistory } from '../../core/compaction-history.mjs';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const name = 'compaction';
export const title = '圧縮イベント・文脈量・自動圧縮の時計';

export default async function (t) {
  const boundary = normalizeSdkMessage({ type: 'system', subtype: 'compact_boundary', uuid: 'b1',
    compact_metadata: { trigger: 'manual', pre_tokens: 182000, post_tokens: 21000 } });
  t.ok('Claude の境界に手動・前後トークンが載る', boundary[0]?.phase === 'complete' && boundary[0].trigger === 'manual'
    && boundary[0].beforeTokens === 182000 && boundary[0].afterTokens === 21000);
  const failed = normalizeSdkMessage({ type: 'system', subtype: 'status', status: null,
    compact_result: 'failed', compact_error: 'network' });
  t.ok('Claude の失敗理由を正規化する', failed.some(x => x.type === 'compaction' && x.phase === 'failed' && x.reason === 'network'));
  const unavailable = { type: 'system', subtype: 'local_command_output', content: "/compact isn't available in this environment." };
  const diagnostic = createClaudeCompactDiagnostic();
  diagnostic.observe(unavailable);
  diagnostic.observe({ type: 'result', subtype: 'success' });
  t.ok('圧縮が CLI の local_command 出力だけで終わればその文を失敗理由にする',
    diagnostic.reason() === unavailable.content);
  diagnostic.observe({ type: 'system', subtype: 'compact_boundary' });
  t.ok('境界が届いた圧縮は CLI 出力を失敗理由にしない', diagnostic.reason() === '');
  const answered = createClaudeCompactDiagnostic();
  answered.observe(unavailable);
  answered.observe({ type: 'assistant', message: { content: [{ type: 'text', text: 'done' }] } });
  t.ok('Claude の応答があれば local_command 出力だけの失敗とは扱わない', answered.reason() === '');
  const nativeClaude = claudeCompactionsFromHistory([{ type: 'system', uuid: 'b1', timestamp: '2026-09-27T00:00:00Z',
    message: { subtype: 'compact_boundary', compact_metadata: { trigger: 'manual', pre_tokens: 182000, post_tokens: 21000 } } }]);
  t.ok('Claude のネイティブ履歴から境界を復元する', nativeClaude[0]?.nativeId === 'b1'
    && nativeClaude[0]?.trigger === 'manual' && nativeClaude[0]?.beforeTokens === 182000);
  t.ok('Codex の通知と item を圧縮完了にする', codexCompactionEvent('thread/compacted', { turnId: 't1' })?.phase === 'complete'
    && codexCompactionEvent('thread/compacted', { turnId: 't1' })?.turnId === 't1'
    && codexCompactionEvent('item/completed', { item: { type: 'contextCompaction', id: 'i1' } })?.nativeId === 'i1');
  t.ok('Codex の last から文脈量を読む', codexContextWindow({ last: { totalTokens: 124000 }, modelContextWindow: 200000 })?.usedTokens === 124000);
  const native = [{ id: 'native:item-1', nativeId: 'item-1', turnId: 'turn-1', phase: 'complete', trigger: 'auto', at: 100_000 }];
  const withoutId = [{ id: 'saved-1', turnId: 'turn-1', phase: 'complete', trigger: 'manual', at: 101_000, summary: '要約' }];
  const sameTurn = mergeCompactionHistory(native, withoutId);
  t.ok('ID の無い sidecar と同じターンのネイティブ item は一つにまとめる', sameTurn.length === 1
    && sameTurn[0].id === 'native:item-1' && sameTurn[0].summary === '要約' && sameTurn[0].trigger === 'manual');
  t.ok('古い ID 無し記録も近い時刻なら一つにまとめる',
    mergeCompactionHistory(native, [{ id: 'old', phase: 'complete', at: 99_000 }]).length === 1);
  t.ok('別ターンと離れた時刻の境界は別々に残す',
    mergeCompactionHistory(native, [{ id: 'other-turn', turnId: 'turn-2', phase: 'complete', at: 100_500 },
      { id: 'far', phase: 'complete', at: 500_000 }]).length === 3);
  t.ok('失敗の sidecar は近いネイティブ境界に吸収しない',
    mergeCompactionHistory(native, [{ id: 'failed', phase: 'failed', at: 100_500 }]).length === 2);

  const defaults = normalizeCompactionSettings();
  t.ok('既定は Claude のみ 50 分（Codex は切り・25 分）、最小 150k', defaults.enabled && defaults.minTokens === 150000
    && defaults.claude.enabled && defaults.claude.delayMinutes === 50 && !defaults.codex.enabled && defaults.codex.delayMinutes === 25);
  t.ok('設定の入切・待ち時間を保持する', normalizeCompactionSettings({ codex: { enabled: true, delayMinutes: 12 } }).codex.delayMinutes === 12);
  t.ok('不正な設定を拒否する', (() => { try { normalizeCompactionSettings({ minTokens: -1 }); return false; } catch { return true; } })());

  // 委譲の子の閾値 = 固定の部分 + 空き（delegatedHeadroom。ADR 0166）: 既定 10 万・0 はオフ・0 以外は 3 万〜100 万
  const rejects = (input) => { try { normalizeCompactionSettings(input); return false; } catch { return true; } };
  t.ok('委譲の子の空きは既定 10 万で、保存済みの設定（項目なし）にも既定が入る',
    defaults.delegatedHeadroom === 100000 && normalizeCompactionSettings({ enabled: false, minTokens: 60000 }).delegatedHeadroom === 100000);
  t.ok('委譲の子の空きは 0（オフ）と 3 万〜100 万を受け、それ以外は拒否する',
    normalizeCompactionSettings({ delegatedHeadroom: 0 }).delegatedHeadroom === 0 && normalizeCompactionSettings({ delegatedHeadroom: 30000 }).delegatedHeadroom === 30000
    && normalizeCompactionSettings({ delegatedHeadroom: 1_000_000 }).delegatedHeadroom === 1_000_000
    && rejects({ delegatedHeadroom: 29999 }) && rejects({ delegatedHeadroom: 1_000_001 }) && rejects({ delegatedHeadroom: -1 })
    && rejects({ delegatedHeadroom: 1.5 }) && rejects({ delegatedHeadroom: '100000' }));
  const legacy = normalizeCompactionSettings({ delegatedTokens: 180000, minTokens: 60000 });
  t.ok('前の版の delegatedTokens（ADR 0163）が残っていても読めて、結果には残さない（空きは既定に戻る）',
    !('delegatedTokens' in legacy) && legacy.delegatedHeadroom === 100000 && legacy.minTokens === 60000
    && normalizeCompactionSettings({ delegatedTokens: 'x' }).delegatedHeadroom === 100000);

  t.ok('子の窓は閾値 + 33000 で、閾値は 7 万に上げ、窓は 100 万に丸める',
    delegatedCompactWindow(150000, {}) === '183000' && delegatedCompactWindow(70000, {}) === '103000'
    && delegatedCompactWindow(40000, {}) === '103000' && delegatedCompactWindow(5_000_000, {}) === '1000000');
  t.ok('閾値が無い（0・不正）なら子の窓を付けない', delegatedCompactWindow(0, {}) === null && delegatedCompactWindow(null, {}) === null
    && delegatedCompactWindow(1.5, {}) === null);
  t.ok('利用者が同名の環境変数を置いていたらそちらを優先する（空文字は無いものとして扱う）',
    delegatedCompactWindow(150000, { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '400000' }) === null
    && delegatedCompactWindow(150000, { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '' }) === '183000');

  const plan = (settings, base, env = {}) => delegatedCompactPlan(normalizeCompactionSettings(settings), base, env);
  const measured = plan({}, { tokens: 71000, source: 'own' });
  t.ok('閾値は固定の部分 + 空き（7.1 万 + 10 万 → 17.1 万・窓 204000）で、内訳と出どころを返す',
    measured?.threshold === 171000 && measured.window === '204000' && measured.base === 71000 && measured.source === 'own' && measured.headroom === 100000);
  const unknown = plan({}, null);
  t.ok('固定の部分をまだ測っていなければ 7 万で見積もる（default）',
    unknown?.threshold === 170000 && unknown.window === '203000' && unknown.base === 70000 && unknown.source === 'default');
  t.ok('同じ作業場所・同じモデル（same）・直近（recent）の出どころをそのまま返し、不正な値は default にする',
    plan({}, { tokens: 80000, source: 'same' })?.source === 'same' && plan({}, { tokens: 60000, source: 'recent' })?.threshold === 160000
    && plan({}, { tokens: 0, source: 'same' })?.source === 'default' && plan({}, { tokens: 1_500_000, source: 'own' })?.base === 70000);
  t.ok('空きを足しても 7 万に満たない・100 万を超える閾値は、CLI が使う値（丸めた後）を返す',
    plan({ delegatedHeadroom: 30000 }, { tokens: 20000, source: 'own' })?.threshold === 70000
    && plan({ delegatedHeadroom: 1_000_000 }, { tokens: 71000, source: 'own' })?.threshold === 967000);
  t.ok('空きが 0（オフ）か利用者の環境変数があれば計画を作らない',
    plan({ delegatedHeadroom: 0 }, { tokens: 71000, source: 'own' }) === null
    && plan({}, { tokens: 71000, source: 'own' }, { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '400000' }) === null);

  // 直近の固定の部分（core/context-bases.mjs）: 同じ作業場所・同じモデル → 直近 → 無し。再起動をまたいで context-bases.json に残る
  const basesDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ply-context-bases-'));
  try {
    const file = path.join(basesDir, 'context-bases.json');
    let clock = 1;
    const bases = createContextBases({ file, limit: 3, now: () => clock++, log: () => {} });
    await bases.load();
    t.ok('何も測っていなければ見積もりは無い', bases.estimate({ cwd: basesDir, model: 'opus' }) === null);
    await bases.remember({ cwd: path.join(basesDir, 'a'), model: 'opus', tokens: 71000 });
    await bases.remember({ cwd: path.join(basesDir, 'b'), model: 'opus', tokens: 65000 });
    const same = bases.estimate({ cwd: path.join(basesDir, 'a'), model: 'opus' });
    const otherModel = bases.estimate({ cwd: path.join(basesDir, 'a'), model: 'sonnet' });
    t.ok('同じ作業場所・同じモデルの値を先に使い、無ければ直近の値を使う',
      same?.tokens === 71000 && same.source === 'same' && otherModel?.tokens === 65000 && otherModel.source === 'recent');
    if (process.platform === 'win32')
      t.ok('Windows では作業場所の大文字・小文字を区別しない', bases.estimate({ cwd: path.join(basesDir, 'A').toUpperCase(), model: 'opus' })?.source === 'same');
    await bases.remember({ cwd: path.join(basesDir, 'a'), model: 'opus', tokens: 72000 });
    t.ok('同じ作業場所・同じモデルの前の値は置き換える', bases.entries().length === 2
      && bases.estimate({ cwd: path.join(basesDir, 'a'), model: 'opus' })?.tokens === 72000 && bases.estimate({ cwd: basesDir, model: 'x' })?.tokens === 72000);
    await bases.remember({ cwd: path.join(basesDir, 'a'), model: 'opus', tokens: 0 });
    await bases.remember({ cwd: path.join(basesDir, 'c'), model: '', tokens: 50000 });
    await bases.remember({ cwd: path.join(basesDir, 'd'), model: '', tokens: 52000 });
    t.ok('不正な値は覚えず、上限を超えたら古いものから捨てる', bases.entries().length === 3
      && bases.entries().every(e => e.tokens !== 0) && !bases.entries().some(e => e.cwd.endsWith('b')));
    await bases.settled();
    const reloaded = createContextBases({ file, limit: 3, log: () => {} });
    await reloaded.load();
    t.ok('保存した値を次の起動で読み直す', reloaded.estimate({ cwd: path.join(basesDir, 'c'), model: '' })?.tokens === 50000
      && reloaded.estimate({ cwd: basesDir, model: 'x' })?.tokens === 52000);
    await fsp.writeFile(file, '{ broken');
    const broken = createContextBases({ file, log: () => {} });
    await broken.load();
    t.ok('壊れたファイルは空から始める', broken.estimate({ cwd: basesDir, model: '' }) === null);
  } finally {
    await fsp.rm(basesDir, { recursive: true, force: true });
  }

  // Claude の接続部: 新しい会話の最初の返答の usage の入力の合計（キャッシュの作成・読み出しを含む）を固定の部分として 1 度だけ出す（SDK は身代わり）
  const claudeDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ply-context-base-claude-'));
  const prevConfig = process.env.CLAUDE_CONFIG_DIR;
  let restoreSdk = null;
  try {
    process.env.CLAUDE_CONFIG_DIR = claudeDir;
    const inbox = [];
    let options = null;
    restoreSdk = setClaudeSdkForTest({ executable: () => 'claude-fake', query: ({ prompt, options: o }) => {
      options = o;
      (async () => { for await (const _ of prompt) { /* 入力は読み捨てる */ } })();
      return { close() {}, interrupt: async () => ({}), async *[Symbol.asyncIterator]() { yield* inbox; } };
    } });
    const usage = (input, created, read) => ({ input_tokens: input, cache_creation_input_tokens: created, cache_read_input_tokens: read, output_tokens: 10 });
    const said = (u, extra = {}) => ({ type: 'assistant', session_id: 'new-1', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }], usage: u }, ...extra });
    const done = { type: 'result', subtype: 'success', num_turns: 1, session_id: 'new-1', total_cost_usd: 0 };
    const runClaude = async (sessionId, messages, extra = {}) => {
      inbox.splice(0, inbox.length, ...messages);
      const events = [];
      await claude.runTurn({ prompt: 'x', sessionId, cwd: claudeDir, mode: 'default', emit: e => events.push(e), askPermission: async () => ({ allow: true }),
        signal: new AbortController(), control: {}, hostSessionId: 'h', ...extra });
      return events.filter(e => e.type === 'contextBase');
    };
    const fresh = await runClaude(null, [said(usage(9, 0, 0), { parent_tool_use_id: 'tool-1' }), said(usage(3, 1000, 70000)), said(usage(5, 2000, 80000)), done],
      { autoCompactWindow: '203000' });
    t.ok('新しい会話の最初の返答（サブエージェントを除く）の入力の合計を 1 度だけ出す',
      fresh.length === 1 && fresh[0].tokens === 71003, JSON.stringify(fresh));
    t.ok('渡された窓を CLAUDE_CODE_AUTO_COMPACT_WINDOW にする', options?.env?.CLAUDE_CODE_AUTO_COMPACT_WINDOW === '203000');
    t.ok('再開した会話（2 ターン目から）は出さない', (await runClaude('sess-old', [said(usage(3, 1000, 90000), { session_id: 'sess-old' }), { ...done, session_id: 'sess-old' }])).length === 0);
    t.ok('窓が無ければ環境変数を付けない', !('CLAUDE_CODE_AUTO_COMPACT_WINDOW' in (options?.env ?? {})) || options.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW === process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW);
  } finally {
    restoreSdk?.();
    if (prevConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = prevConfig;
    await fsp.rm(claudeDir, { recursive: true, force: true });
  }

  let time = 1000, serial = 0;
  const timers = new Map(), changed = [], run = [];
  const scheduler = createCompactionScheduler({ now: () => time,
    setTimer: fn => { const id = ++serial; timers.set(id, fn); return id; },
    clearTimer: id => timers.delete(id),
    canRun: async () => true, compact: async (id, sessionId) => run.push([id, sessionId]),
    changed: (id, at) => changed.push([id, at]) });
  const first = scheduler.schedule('a', 'native-a', 3000);
  const old = timers.values().next().value;
  const second = scheduler.schedule('a', 'native-a', 4000);
  t.ok('予約は一会話に一本で前を置き換える', first === 4000 && second === 5000 && timers.size === 1);
  time = 5000;
  await old();
  t.ok('古いタイマーは何もしない', run.length === 0);
  await timers.values().next().value();
  t.ok('予定時刻で一度だけ走り、再予約しない', run.length === 1 && scheduler.get('a') === null && timers.size === 1);
  scheduler.schedule('b', 'native-b', 1000);
  const late = [...timers.values()].at(-1);
  time += 1000 + 8 * 60000 + 1;
  await late();
  t.ok('スリープ明けの期限外は表示せず走らない', run.length === 1 && scheduler.get('b') === null && changed.at(-1)[1] === null);
  scheduler.schedule('c', 'native-c', 1000);
  t.ok('取消で予約が消える', scheduler.cancel('c') && scheduler.get('c') === null);

  const deferred = () => {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
  };
  const previousTurnRead = deferred();
  const oldRevision = scheduler.revision('race');
  const finishPreviousTurn = (async () => {
    await previousTurnRead.promise;
    scheduler.schedule('race', 'native-race', 1000, oldRevision);
  })();
  scheduler.cancel('race'); // The next message was accepted before the previous turn finished reading its settings.
  previousTurnRead.resolve();
  await finishPreviousTurn;
  t.ok('次の送信が先なら前のターンの終了処理は予約できない', scheduler.get('race') === null);

  const canRunGate = deferred();
  const fireTimers = new Map();
  let nextTimer = 0, starts = 0;
  const guarded = createCompactionScheduler({ now: () => 1000,
    setTimer: fn => { const id = ++nextTimer; fireTimers.set(id, fn); return id; },
    clearTimer: id => fireTimers.delete(id),
    canRun: () => canRunGate.promise,
    compact: async (_id, _sessionId, current) => { if (current()) starts++; } });
  guarded.schedule('during-check', 'native-check', 0);
  const firing = [...fireTimers.values()].at(-1)();
  guarded.cancel('during-check');
  canRunGate.resolve(true);
  await firing;
  t.ok('canRun 待ちの予約は送信やキャンセルで止まる', starts === 0 && guarded.get('during-check') === null);

  const beforeStart = deferred();
  let enteredStart;
  const starting = new Promise(done => { enteredStart = done; });
  const finalGuard = createCompactionScheduler({ now: () => 1000,
    setTimer: fn => { const id = ++nextTimer; fireTimers.set(id, fn); return id; },
    clearTimer: id => fireTimers.delete(id), canRun: async () => true,
    compact: async (_id, _sessionId, current) => {
      if (!current()) return;
      enteredStart();
      await beforeStart.promise;
      if (current()) starts++;
    } });
  finalGuard.schedule('before-start', 'native-start', 0);
  const startingFire = [...fireTimers.values()].at(-1)();
  await starting;
  finalGuard.cancel('before-start');
  beforeStart.resolve();
  await startingFire;
  t.ok('準備に入った後でも圧縮開始の直前に取消を再確認する', starts === 0);
  let ownBusy = false, stillCurrent = true;
  const guards = idleCompactionGuards(() => stillCurrent, () => ownBusy);
  const canEnter = guards.canStart();
  ownBusy = true; // The idle turn itself now owns the running slot.
  t.ok('圧縮自身の実行中印で開始直前の検査を落とさない', canEnter && guards.canInvoke());
  stillCurrent = false;
  t.ok('圧縮の準備中に取消された世代は開始しない', !guards.canInvoke());

  const settingsGate = deferred();
  let settingsEntered;
  const settingsStarted = new Promise(done => { settingsEntered = done; });
  const settingsScheduler = createCompactionScheduler({ now: () => 1000,
    setTimer: fn => { const id = ++nextTimer; fireTimers.set(id, fn); return id; },
    clearTimer: id => fireTimers.delete(id), canRun: async () => true,
    compact: async (_id, _sessionId, current) => {
      settingsEntered();
      await settingsGate.promise;
      if (current()) starts++;
    } });
  settingsScheduler.schedule('settings-off', 'native-settings', 0, settingsScheduler.revision('settings-off'), 124_000);
  const settingsFire = [...fireTimers.values()].at(-1)();
  await settingsStarted;
  settingsScheduler.cancelFiring(({ usedTokens }) => usedTokens < 200_000);
  settingsGate.resolve();
  await settingsFire;
  t.ok('最小サイズを超えた設定変更は発火中の予約も取り消す', starts === 0);

  const stillEligibleGate = deferred();
  let eligibleEntered;
  const eligibleStarted = new Promise(done => { eligibleEntered = done; });
  const stillEligible = createCompactionScheduler({ now: () => 1000,
    setTimer: fn => { const id = ++nextTimer; fireTimers.set(id, fn); return id; },
    clearTimer: id => fireTimers.delete(id), canRun: async () => true,
    compact: async (_id, _sessionId, current) => {
      eligibleEntered();
      await stillEligibleGate.promise;
      if (current()) starts++;
    } });
  stillEligible.schedule('still-eligible', 'native-settings', 0, stillEligible.revision('still-eligible'), 124_000);
  const eligibleFire = [...fireTimers.values()].at(-1)();
  await eligibleStarted;
  stillEligible.cancelFiring(({ usedTokens }) => usedTokens < 40_000);
  stillEligibleGate.resolve();
  await eligibleFire;
  t.ok('対象のままの設定変更は発火中の予約を残す', starts === 1);

  const ja = JSON.parse(fs.readFileSync(new URL('../../web/locales/ja/ui.json', import.meta.url), 'utf8'));
  const en = JSON.parse(fs.readFileSync(new URL('../../web/locales/en/ui.json', import.meta.url), 'utf8'));
  t.ok('プラグイン改名と窓の語は分かれている', ja.settings.nav.context === 'プラグイン' && en.settings.nav.context === 'Plugins'
    && ja.session.context.label === 'プラグイン' && JSON.stringify(ja).includes('"context":"コンテキスト長"')
    && JSON.stringify(ja).includes('"context":"プラグイン長"') === false);
}
