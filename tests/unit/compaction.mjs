import { createCompactionScheduler } from '../../core/compaction-scheduler.mjs';
import { normalizeCompactionSettings } from '../../core/compaction-settings.mjs';
import { normalizeSdkMessage, claudeCompactionsFromHistory } from '../../core/backends/claude-normalize.mjs';
import { codexContextWindow, codexCompactionEvent } from '../../core/backends/codex.mjs';
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
  const nativeClaude = claudeCompactionsFromHistory([{ type: 'system', uuid: 'b1', timestamp: '2026-09-27T00:00:00Z',
    message: { subtype: 'compact_boundary', compact_metadata: { trigger: 'manual', pre_tokens: 182000, post_tokens: 21000 } } }]);
  t.ok('Claude のネイティブ履歴から境界を復元する', nativeClaude[0]?.nativeId === 'b1'
    && nativeClaude[0]?.trigger === 'manual' && nativeClaude[0]?.beforeTokens === 182000);
  t.ok('Codex の通知と item を圧縮完了にする', codexCompactionEvent('thread/compacted', { turnId: 't1' })?.phase === 'complete'
    && codexCompactionEvent('item/completed', { item: { type: 'contextCompaction', id: 'i1' } })?.nativeId === 'i1');
  t.ok('Codex の last から文脈量を読む', codexContextWindow({ last: { totalTokens: 124000 }, modelContextWindow: 200000 })?.usedTokens === 124000);

  const defaults = normalizeCompactionSettings();
  t.ok('既定は Claude のみ 50 分、最小 40k', defaults.enabled && defaults.minTokens === 40000
    && defaults.claude.enabled && defaults.claude.delayMinutes === 50 && !defaults.codex.enabled);
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

  const ja = JSON.parse(fs.readFileSync(new URL('../../web/locales/ja/ui.json', import.meta.url), 'utf8'));
  const en = JSON.parse(fs.readFileSync(new URL('../../web/locales/en/ui.json', import.meta.url), 'utf8'));
  t.ok('プラグイン改名と窓の語は分かれている', ja.settings.nav.context === 'プラグイン' && en.settings.nav.context === 'Plugins'
    && ja.session.context.label === 'プラグイン' && JSON.stringify(ja).includes('"context":"コンテキスト長"')
    && JSON.stringify(ja).includes('"context":"プラグイン長"') === false);
}
