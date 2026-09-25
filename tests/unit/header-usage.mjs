import assert from 'node:assert/strict';
import { usedOf, atLimit, percentText, quotaOf, needsAuth, shortLabel, topWindow, groupsOf, chipState, resetText } from '../../web/header-usage.mjs';
import { antigravityQuota } from '../../core/backends/antigravity-usage.mjs';

export const name = 'header-usage';
export const title = 'ヘッダーの使用量: 枠の選び方・アカウント・上限・グループのまとめ';
export default async function(t) {
  const now = Date.parse('2026-09-25T12:00:00Z');
  const at = ms => new Date(now + ms).toISOString();
  const win = (label, used, resetsAt, extra = {}) => ({ label, usedPercent: used, remainingPercent: used == null ? null : Math.max(0, 100 - used), resetsAt, ...extra });

  const five = win('5時間', 38, at(3 * 3600_000 + 10 * 60_000)), week = win('週次（7日間）', 22, at(4 * 86400_000));
  assert.equal(topWindow([five, week], now), five);
  assert.equal(topWindow([win('5時間', 90, at(-1000)), week], now), week, '時刻を過ぎた枠は今の値ではない');
  assert.equal(topWindow([win('5時間', null, null)], now), null);
  assert.equal(usedOf(win('x', 50, at(-1)), now), null);
  assert.deepEqual(chipState({ windows: [five, week] }, now), { kind: 'value', window: five, used: 38, high: false, limit: false });
  assert.equal(chipState({ windows: [win('5時間', 80, at(3600_000))] }, now).high, true);
  t.ok('使用率のいちばん高い枠を選び、時刻を過ぎた枠と不明を除く。80% から強い字', true);

  assert.equal(atLimit(win('5時間', 100, at(42 * 60_000)), now), true);
  assert.equal(atLimit({ label: '5時間', usedPercent: 99.5, remainingPercent: 0, resetsAt: at(60_000) }, now), true);
  assert.equal(atLimit(win('5時間', 100, null), now), false, '回復の時刻が分からなければ率のまま');
  assert.equal(chipState({ windows: [win('5時間', 100, at(60_000))] }, now).limit, true);
  assert.equal(percentText(99.6), '99%');
  assert.equal(percentText(100), '100%');
  assert.equal(percentText(null), '—');
  assert.match(resetText(five, now), /あと 3 時間 10 分で回復/);
  assert.match(resetText(win('5時間', 100, at(42 * 60_000)), now), /に回復（あと 42 分）/);
  assert.match(resetText(week, now), /に回復$/);
  t.ok('上限は回復の時刻が先のときだけ。100 に届かない率を 100% と丸めない。回復の目安', true);

  assert.equal(chipState(null), null);
  assert.equal(chipState({ windows: [], message: '未対応' }), null, '枠の無いエージェントは出さない');
  assert.deepEqual(chipState({ windows: [], needsUsageLogin: true, accountId: 'a' }), { kind: 'auth' });
  assert.deepEqual(chipState({ windows: [win('5時間', null, null)] }), { kind: 'unknown' });
  const quota = { windows: [], accounts: [
    { label: 'ログイン中のアカウント', windows: [five] },
    { label: '仕事', accountId: 'work', windows: [], needsUsageLogin: true },
  ] };
  assert.equal(quotaOf(quota, '').label, 'ログイン中のアカウント');
  assert.equal(quotaOf(quota, 'work').label, '仕事');
  assert.equal(quotaOf(quota, 'gone').label, 'ログイン中のアカウント');
  assert.equal(quotaOf({ windows: [five] }, 'work').windows[0], five);
  assert.equal(needsAuth(quotaOf(quota, 'work')), true);
  t.ok('Claude は会話で使うアカウントの枠。未認可は「使用量 —」、枠の無いものは出さない', true);

  assert.equal(shortLabel(week), '週次');
  assert.equal(shortLabel(win('Opus・週次', 1, null)), 'Opus・週次');
  const agy = antigravityQuota({ status: 'SUCCESS', num_turns: 0, command: { name: 'usage', data: { groups: [
    { name: 'Gemini Flash', buckets: [{ window: '5h', remaining_fraction: .9 }] },
    { name: 'Gemini Pro', buckets: [{ window: '5h', remaining_fraction: .7 }, { window: 'weekly', remaining_fraction: .82 }] },
    { name: 'Claude', buckets: [{ window: '5h', remaining_fraction: .86 }] },
  ] } } });
  assert.equal(agy.windows[1].group, 'Gemini Pro');
  assert.equal(shortLabel(agy.windows[1]), '5時間');
  const grouped = groupsOf(agy.windows, now);
  assert.equal(grouped.group, 'Gemini Pro');
  assert.equal(grouped.windows.length, 2);
  assert.equal(grouped.others, 2);
  assert.equal(grouped.below, 20);
  assert.equal(groupsOf([five, week], now).others, 0);
  t.ok('枠の名前の括弧書きとグループ名を外し、Antigravity はいちばん使っているグループだけを出す', true);
}
