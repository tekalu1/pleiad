import { taskTitle } from '../../core/task-title.mjs';
import { backgroundTitle, taskTree, nativeChildren, backgroundTotals, backgroundKind, backgroundSummary, groupByOwner, visibleRows } from '../../web/background-model.mjs';

export const name = 'background-model';
export const title = 'バックグラウンドのタイトル・集計・子孫の順序・入口の種類のまとめ';
export default async function(t) {
  t.ok('明示タイトルの空白を詰めて 40 文字に切る', taskTitle('  alpha\n  beta   ' + 'x'.repeat(50), 'fallback') === ('alpha beta ' + 'x'.repeat(50)).slice(0, 40));
  t.ok('絵文字を途中で切らず 40 文字にする', taskTitle('🚀'.repeat(40), 'fallback') === '🚀'.repeat(40));
  t.ok('未指定・空タイトルは依頼の最初の空でない行へ戻る', taskTitle('', '\n \n  first   line  \nsecond') === 'first line'
    && backgroundTitle({ task: '\n  old   task\nmore' }) === 'old task');
  const tasks = [
    { taskId: 'root-old', parentSessionId: 'top', sessionId: 'a', createdAt: 1, status: 'completed' },
    { taskId: 'grandchild', parentSessionId: 'b', sessionId: 'c', createdAt: 3, status: 'running' },
    { taskId: 'child', parentSessionId: 'a', sessionId: 'b', createdAt: 2, status: 'completed' },
    { taskId: 'root-new', parentSessionId: 'top', sessionId: 'd', createdAt: 4, status: 'running' },
    { taskId: 'elsewhere', parentSessionId: 'other', sessionId: 'e', createdAt: 5, status: 'completed' },
  ];
  const tree = taskTree(tasks, 'top');
  t.ok('新しい根を先にし、孫を親の直後に深さ付きで並べる', tree.map(x => `${x.task.taskId}:${x.depth}`).join() === 'root-new:0,root-old:0,child:1,grandchild:2');
  t.ok('直下の委譲数と根の状態を子孫へ渡す', tree[1].childCount === 1 && tree[2].childCount === 1 && tree[3].rootLive === false);
  // ---- 委譲した子の会話のネイティブの孫（走っている分は配信・終わった分は読み出し済み）
  const subs = [{ id: 'g1', sessionId: 'kid', origin: 'tool-1', startedAt: 1000, status: 'running' }, { id: 'x', sessionId: 'someone-else', origin: 'tool-9' }];
  const past = [{ id: 'g1-old', sessionId: 'kid', origin: 'tool-1', startedAt: 1000, status: 'completed' }, { id: 'g0', sessionId: 'kid', origin: 'tool-0', startedAt: 500, status: 'completed' },
    { id: 'g2', sessionId: 'kid', origin: 'tool-2', startedAt: 2000, status: 'completed' }];
  t.ok('子の会話の孫は、配信の分と読み出し済みの分を合わせ、同じ呼び出し（origin）は配信を取り、新しい順に並べる',
    nativeChildren('kid', subs, past).map(a => a.id).join() === 'g2,g1,g0');
  t.ok('別の会話の子・会話の無いタスク・配信の無い状態は孫に入れない', nativeChildren('kid', [{ id: 'x', sessionId: 'other' }]).length === 0
    && nativeChildren(null, subs, past).length === 0 && nativeChildren('kid', undefined, undefined).length === 0);
  const totals = backgroundTotals([{ group: 'agent', live: true }, { group: 'agent', live: false }, { group: 'agent', live: false }, { group: 'command', live: true }]);
  t.ok('稼働中は全種、完了はサブエージェントと Pleiad タスクを数える', totals.live === 2 && totals.ended === 2);
  const stale = backgroundTotals([{ group: 'agent', live: true }, { group: 'agent', live: false, hostStale: true }, { group: 'agent', live: false }]);
  t.ok('しばらく読めていないホストの孫の行（hostStale）は、稼働中にも完了にも数えない', stale.live === 1 && stale.ended === 1);

  // ---- 入口のチップ（docs/design-system.md「入力欄の上の帯」）
  const agent = (backend, extra = {}) => ({ group: 'agent', backend, live: true, ...extra });
  const command = () => ({ group: 'command', live: true });
  t.ok('種類: ロゴのある接続先はそのまま、それ以外の接続先は互換、コマンドは term',
    backgroundKind(agent('claude')) === 'claude' && backgroundKind(agent('codex')) === 'codex' && backgroundKind(agent('antigravity')) === 'antigravity'
    && backgroundKind(agent('openrouter')) === 'compat' && backgroundKind({ group: 'agent', live: true }) === 'compat' && backgroundKind(command()) === 'term');
  const mixed = backgroundSummary([agent('claude'), agent('claude'), agent('codex'), command(), agent('claude', { live: false })]);
  t.ok('種類ごとにまとめ、並びは Claude・Codex・ターミナル（終わったものは数えない）',
    mixed.live === 4 && mixed.groups.map(g => `${g.kind}:${g.n}`).join() === 'claude:2,codex:1,term:1' && mixed.visible.length === 3 && mixed.hidden === 0 && mixed.ended === 1);
  const reversed = backgroundSummary([command(), agent('codex'), agent('claude')]);
  t.ok('入れた順に依らず並びは固定', reversed.groups.map(g => g.kind).join() === 'claude,codex,term');
  const many = backgroundSummary([agent('claude'), agent('codex'), agent('antigravity'), agent('openrouter'), command(), command()]);
  t.ok('4 種類以上は 3 つまで並べ、残りの種類の数を hidden に', many.groups.length === 5 && many.visible.map(g => g.kind).join() === 'claude,codex,antigravity' && many.hidden === 2);
  const waiting = backgroundSummary([agent('claude'), agent('codex'), agent('antigravity'), agent('openrouter', { waiting: true }), command()]);
  t.ok('承認待ちを含む種類は先頭へ寄せ、「+N」に隠さない', waiting.visible[0].kind === 'compat' && waiting.visible[0].waiting === 1 && waiting.visible.length === 3 && waiting.hidden === 2);
  const allWaiting = backgroundSummary([agent('claude', { waiting: true }), agent('codex', { waiting: true }), agent('antigravity', { waiting: true }), agent('openrouter', { waiting: true }), agent('x')]);
  t.ok('承認待ちの種類が 3 を超えても全部出す', allWaiting.visible.length === 4 && allWaiting.visible.every(g => g.waiting) && allWaiting.hidden === 0);
  const ended = backgroundSummary([agent('claude', { live: false }), agent('codex', { live: false }), { group: 'command', live: false }]);
  t.ok('終わったものだけなら種類は出さず、完了の数だけ（コマンドは数えない）', ended.live === 0 && ended.groups.length === 0 && ended.ended === 2);

  // ---- Channels のスレッドの一覧: bot（根の会話）ごとに分け、終わった親は limit 件までなど
  const row = (key, owner, live, extra = {}) => ({ key, group: 'agent', owner, live, ...extra });
  const items = [row('a1', 'owl', true, { rootLive: true }), row('l1', 'lynx', false, { rootLive: false }), row('a1c', 'owl', true, { depth: 1, rootLive: true }),
    row('a2', 'owl', false, { rootLive: false }), { key: 'cmd', group: 'command', owner: 'owl', live: true }, row('l2', 'lynx', true, { rootLive: true })];
  const groups = groupByOwner(items);
  t.ok('bot（根の会話）ごとに分け、出てくる順・中の順は元のまま。コマンドは入れない', [...groups.keys()].join() === 'owl,lynx'
    && groups.get('owl').map(x => x.key).join() === 'a1,a1c,a2' && groups.get('lynx').map(x => x.key).join() === 'l1,l2');
  const rows = [row('r1', 'o', true, { rootLive: true }), row('r2', 'o', false, { rootLive: false }), row('r2c', 'o', false, { depth: 1, rootLive: false }),
    row('r3', 'o', false, { rootLive: false }), row('r3c', 'o', false, { depth: 1, rootLive: false })];
  const two = visibleRows(rows, 1);
  t.ok('動いている親は全部・終わった親は limit 件まで（子孫は親に付く）・残りの数を返す', two.rows.map(x => x.key).join() === 'r1,r2,r2c' && two.remaining === 1);
  const all = visibleRows(rows, 10);
  t.ok('limit 内なら全部出し、残りは 0', all.rows.length === 5 && all.remaining === 0);
  t.ok('根が動いていれば、終わった子孫も動いている親と一緒に出す', visibleRows([row('p', 'o', false, { rootLive: true }), row('c', 'o', false, { depth: 1, rootLive: true })], 0).rows.length === 2);
}
