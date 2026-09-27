import { visibleTaskInstructions } from '../../web/task-instructions.mjs';

export const name = 'task-instructions';
export const title = '追加指示の詳細表示は配送順で履歴との重複を避ける';
export default async function(t) {
  const same = [
    { id: 'one', text: 'same', state: 'delivered' },
    { id: 'two', text: 'same', state: 'sending' },
    { id: 'three', text: 'same', state: 'queued' },
  ];
  const users = n => Array.from({ length: n }, () => ({ role: 'user', text: 'same' }));
  t.ok('送信中でまだ履歴にない指示だけを表示する', visibleTaskInstructions(same, users(2)).map(x => x.id).join() === 'two,three');
  t.ok('同じ本文を続けて送っても配送順で二重表示しない', visibleTaskInstructions(same, users(3)).map(x => x.id).join() === 'three');
  t.ok('孫からの内部通知は配送済みの user 発言に数えない', visibleTaskInstructions(same, [...users(1), { role: 'user', internalTaskNotice: true }]).map(x => x.id).join() === 'two,three');
  t.ok('未配送で終わった本文は残る', visibleTaskInstructions([{ id: 'lost', text: 'lost', state: 'dropped' }], users(1))[0]?.id === 'lost');
}
