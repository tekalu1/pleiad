import { readFileSync } from 'node:fs';
import { overlaySessions, rollbackSessions, currentRows } from '../../web/pending-sidebar.mjs';

export const name = 'pending-sidebar';
export const title = '脇の楽観的な更新・失敗時の巻き戻し・削除確認';

export default function (t) {
  const old = [{ id: 'a', status: '進行中', ungrouped: false }, { id: 'b', status: '進行中', ungrouped: false }];
  const patches = new Map([['a', { status: '確認待ち' }], ['b', { status: '確認待ち', ungrouped: true }]]);
  const visible = overlaySessions(old, patches);
  t.ok('古い一覧が返っても保存中の移動先を保つ', visible.every(s => s.status === '確認待ち') && visible[1].ungrouped);
  t.ok('サーバーからの行と元の行を書き換えない', old.every(s => s.status === '進行中') && visible[0] !== old[0]);
  const before = old.map(s => ({ sessionId: s.id, status: s.status, ungrouped: s.ungrouped }));
  const restored = rollbackSessions(visible, before);
  t.ok('失敗時は状態とグループ所属を両方戻す', restored.every(s => s.status === '進行中' && !s.ungrouped));
  t.ok('巻き戻しで保存中の表示用配列は変えない', visible.every(s => s.status === '確認待ち'));
  t.ok('再試行は置換済みの行を ID で引き直す', currentRows([visible[0]], restored)[0] === restored[0]);
  const deleting = overlaySessions([], new Map(), new Map([['a', old[0]]]));
  t.ok('削除応答より先に来た一覧で行を消さない', deleting.length === 1 && deleting[0].id === 'a');
  const confirmation = ['ja', 'en'].map(locale => JSON.parse(readFileSync(new URL(`../../web/locales/${locale}/ui.json`, import.meta.url), 'utf8')).pending.deleteStatusConfirm);
  t.ok('状態削除の確認に件数と移り先を含める', confirmation.every(s => ['{{count}}', '{{destination}}'].every(key => s.includes(key))));
}
