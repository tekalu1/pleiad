import { mergeTasks, treeSessions, tasksToFetch, staleTasks } from '../../web/task-cards.mjs';

export const name = 'task-cards';
export const title = '委譲の行: 会話の分に running の短い行を重ねる・読み直す行の選び方';
export default async function(t) {
  const cards = new Map([
    ['a', { taskId: 'a', parentSessionId: 'top', sessionId: 'ca', status: 'running', notification: 'none', routing: { mode: 'auto' }, task: '依頼 a' }],
    ['b', { taskId: 'b', parentSessionId: 'ca', sessionId: 'cb', status: 'completed', notification: 'sent', task: '依頼 b' }],
  ]);
  const live = [{ taskId: 'a', parentSessionId: 'top', sessionId: 'ca', status: 'cancelling', notification: 'none' },
    { taskId: 'z', parentSessionId: 'elsewhere', sessionId: 'cz', status: 'running', notification: 'none' }];
  const merged = mergeTasks(cards, live);
  const a = merged.find((r) => r.taskId === 'a');
  t.ok('running の行が状態を上書きし、会話の分の依頼文・振り分けの記録は残る', a.status === 'cancelling' && a.routing?.mode === 'auto' && a.task === '依頼 a');
  t.ok('running にしか無い行も含める', merged.some((r) => r.taskId === 'z') && merged.length === 3);
  t.ok('木の会話は子孫までたどる', [...treeSessions('top', [...cards.values()])].sort().join() === 'ca,cb,top');

  const fresh = [...live, { taskId: 'c', parentSessionId: 'cb', sessionId: 'cc', status: 'queued', notification: 'none' }];
  t.ok('この会話の木の新しい委譲（孫の下も）を読み、別の会話の分は読まない',
    tasksToFetch({ cards, live: fresh, prevLive: new Map(live.map((r) => [r.taskId, r])), sessionId: 'top' }).join() === 'c');
  const prevLive = new Map([...live, { taskId: 'd', parentSessionId: 'top', sessionId: 'cd', status: 'running', notification: 'none' }].map((r) => [r.taskId, r]));
  t.ok('running から外れた行は、持っていても持っていなくても（木の中なら）読み直す',
    tasksToFetch({ cards, live: [live[1]], prevLive, sessionId: 'top' }).sort().join() === 'a,d');
  t.ok('木の外で外れた行は読まない', !tasksToFetch({ cards, live: [], prevLive, sessionId: 'top' }).includes('z'));
  t.ok('読んでいる間に終わった（まだ走っている形なのに running に無い）行を選ぶ',
    staleTasks([...cards.values(), { taskId: 'p', status: 'completed', notification: 'pending' }], [live[0]]).join() === 'p');
}
