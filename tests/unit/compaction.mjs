import { createCompactionScheduler, idleCompactionGuards } from '../../core/compaction-scheduler.mjs';
import { normalizeCompactionSettings } from '../../core/compaction-settings.mjs';
import { normalizeSdkMessage, createClaudeCompactDiagnostic, claudeCompactionsFromHistory } from '../../core/backends/claude-normalize.mjs';
import { codexContextWindow, codexCompactionEvent } from '../../core/backends/codex.mjs';
import { mergeCompactionHistory } from '../../core/compaction-history.mjs';
import fs from 'node:fs';

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
  t.ok('既定は Claude のみ 50 分（Codex は切り・25 分）、最小 40k', defaults.enabled && defaults.minTokens === 40000
    && defaults.claude.enabled && defaults.claude.delayMinutes === 50 && !defaults.codex.enabled && defaults.codex.delayMinutes === 25);
  t.ok('設定の入切・待ち時間を保持する', normalizeCompactionSettings({ codex: { enabled: true, delayMinutes: 12 } }).codex.delayMinutes === 12);
  t.ok('不正な設定を拒否する', (() => { try { normalizeCompactionSettings({ minTokens: -1 }); return false; } catch { return true; } })());

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
