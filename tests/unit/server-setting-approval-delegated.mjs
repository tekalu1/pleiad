// 委譲の子が出した設定の変更の承認の結果の届け先（ADR 0088「届け先」）。fake バックエンドのサーバー越し。LLM は呼ばない。
//   - 子のタスクが終わった後に許可すると、結果は依頼元の会話に届く（子の会話に新しいターンは立たない）
//   - 子のタスクがまだ動いていれば、子に届く
//   - 再起動で取り下げた結果も同じ規則で依頼元に届く
//   - 台帳の単体: 届け先の関数（route）で会話ごとにまとめる・引けない／失敗は求めた会話・requeue の間に届け先が変わりうる
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startServer, ROOT } from '../lib/server.mjs';
import { open } from '../lib/ws-client.mjs';
import { createSettingApprovals } from '../../core/setting-approvals.mjs';

export const name = 'server-setting-approval-delegated';
export const title = '委譲の子の設定の変更の承認: 子のタスクが終わっていれば結果は依頼元へ・動いていれば子へ・再起動の取り下げも同じ（fake）';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// 届けるたびに台帳を書く（送る前と後）。混んだ CI では決め打ちの時間で済まないので、条件がそろうまで待つ
const until = async (fn, ms = 10_000) => { const end = Date.now() + ms; while (!fn() && Date.now() < end) await sleep(20); return fn(); };
const ply = (name, args) => 'ply:' + JSON.stringify({ name, arguments: args });
const control = (name, args) => 'control:' + JSON.stringify({ name, arguments: args });
const delegate = (task, title) => ply('ply_delegate', { kind: 'mechanical', backend: 'fake', task, title });

export default async function (t) {
  await ledger(t);

  const scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'agent-host-setting-approval-child-')));
  const dataDir = path.join(scratch, 'data');
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(path.join(dataDir, 'prefs.json'), JSON.stringify({ confirmAgentSites: true, agentSitePermissions: [] }));
  let server = await startServer({ env: { AGENT_HOST_BACKENDS: 'fake' }, dataDir, timeoutMs: 60_000 });
  let c = await open({ port: server.port, token: server.token });
  try {
    const tasksOf = async (parent) => (await c.cmd('agentTasks')).filter((r) => r.parentSessionId === parent);
    const awaitTask = async (parent, fn, ms = 30_000) => {
      const end = Date.now() + ms; let rows = [];
      while (Date.now() < end) { rows = await tasksOf(parent); if (rows[0] && fn(rows[0])) return rows[0]; await sleep(50); }
      throw new Error('task timeout: ' + JSON.stringify(rows.map(({ status, notification }) => ({ status, notification }))));
    };
    const resolve = (card, allow) => c.cmd('resolvePermission', { id: card.id, allow, receipt: card.settingChange.receipt });
    const noticesOf = (sessionId, requestId, from) => c.since(from).filter((e) => e.type === 'taskNotice' && e.sessionId === sessionId && String(e.text).includes(requestId));
    const turnEnds = (sessionId, from) => c.since(from).filter((e) => e.type === 'turnEnd' && e.sessionId === sessionId);
    /** 依頼元が子を作り、子が set_setting で承認待ちを受けて終わるまで。子の完了通知が依頼元のターンで読まれるまで待つ */
    const childAsks = async (label, taskPrompt = control('set_setting', { key: 'confirmAgentSites', value: false, reason: 'テスト' })) => {
      const from = c.mark();
      const parent = (await c.runTurn({ backend: 'fake', cwd: ROOT, mode: 'default', prompt: delegate(taskPrompt, label) }, { ms: 30_000 })).sessionId;
      const card = await c.waitFor((e) => e.type === 'permission' && e.settingChange, { from, ms: 20_000 });
      const task = await awaitTask(parent, (r) => r.status === 'completed' && r.notification === 'sent');
      await c.waitFor((e) => e.type === 'turnEnd' && e.sessionId === parent, { from, ms: 20_000 });
      await sleep(300);
      return { parent, card, task, child: task.sessionId };
    };

    // ---- 子のタスクが終わった後に許可すると、結果は依頼元の会話に届き、子には新しいターンが立たない
    const a = await childAsks('設定を緩める子');
    t.ok('子が set_setting で承認待ちを受けて終わる（カードは子の会話のもの）', a.card.sessionId === a.child && a.task.status === 'completed' && (await c.cmd('prefs')).confirmAgentSites === true);
    let from = c.mark();
    await resolve(a.card, true);
    await c.waitFor((e) => e.type === 'taskNotice' && e.sessionId === a.parent && String(e.text).includes(a.card.settingChange.requestId), { from, ms: 30_000 });
    const noticeA = noticesOf(a.parent, a.card.settingChange.requestId, from)[0];
    t.ok('許可すると設定が変わり、結果（許可）は依頼元の会話に届く', (await c.cmd('prefs')).confirmAgentSites === false && /結果: 許可/.test(noticeA.text), noticeA.text);
    t.ok('文には、どの子（題・taskId）が求めた、どの設定かを、画面のラベルとキーで書く',
      noticeA.text.includes('設定を緩める子') && noticeA.text.includes(a.task.taskId) && noticeA.text.includes('エージェントがサイトを使う前に確認') && noticeA.text.includes('confirmAgentSites')
      && noticeA.text.includes('ply_task_send'), noticeA.text);
    await c.waitFor((e) => e.type === 'turnEnd' && e.sessionId === a.parent, { from, ms: 30_000 });
    await sleep(500);
    const parentHistory = await c.cmd('loadSession', { sessionId: a.parent });
    t.ok('依頼元の履歴では通知として描かれ、依頼元がそれを読んで答える',
      parentHistory.messages.some((m) => m.role === 'user' && m.internalTaskNotice === true && String(m.text).includes(a.card.settingChange.requestId))
      && parentHistory.messages.some((m) => m.role === 'assistant' && String(m.text).includes(a.card.settingChange.requestId)));
    t.ok('子の会話には結果が届かず、新しいターンも立たない', noticesOf(a.child, a.card.settingChange.requestId, from).length === 0 && turnEnds(a.child, from).length === 0
      && !c.since(from).some((e) => e.sessionId === a.child && e.type === 'running'));
    const left = JSON.parse(await fs.readFile(path.join(dataDir, 'setting-approvals.json'), 'utf8'));
    t.ok('届けたら台帳は空になる', left.pending.length === 0 && left.notices.length === 0, JSON.stringify(left));
    await c.cmd('setPref', { key: 'confirmAgentSites', value: true });

    // ---- 操作を求めた子が終わっていたら、依頼元へ操作の言葉で届ける
    const opChild = await childAsks('コマンドの子', control('call_op', { op: 'shell.run', args: { command: 'echo child', waitMs: 0 } }));
    from = c.mark();
    await resolve(opChild.card, false);
    const opNotice = await c.waitFor((e) => e.type === 'taskNotice' && e.sessionId === opChild.parent && String(e.text).includes(opChild.card.settingChange.requestId), { from, ms: 30_000 });
    t.ok('終わった子のコマンドの拒否は依頼元へ「操作の結果」「実行していない」と届く', opNotice.text.includes('[Pleiad 操作の結果 /')
      && opNotice.text.includes('コマンドの子') && opNotice.text.includes(opChild.task.taskId) && opNotice.text.includes('Pleiad は実行していません。')
      && !opNotice.text.includes('設定は変わっていません'), opNotice.text);
    await c.waitFor((e) => e.type === 'turnEnd' && e.sessionId === opChild.parent, { from, ms: 30_000 });

    // ---- 子のタスクが動いている間は、子に届く（追加の指示で動き出した子）
    const b = await childAsks('動いている子');
    await c.runTurn({ sessionId: b.parent, prompt: ply('ply_task_send', { taskId: b.task.taskId, message: 'bg 1 8' }) }, { ms: 30_000 });
    await awaitTask(b.parent, (r) => r.status === 'running');
    from = c.mark();
    await resolve(b.card, false);
    const childNotice = await c.waitFor((e) => e.type === 'taskNotice' && e.sessionId === b.child && String(e.text).includes(b.card.settingChange.requestId), { from, ms: 30_000 });
    await sleep(500);
    t.ok('子のタスクが動いている間は、結果（拒否）は求めた子に届き、依頼元には届かない', /結果: 拒否/.test(childNotice.text) && !childNotice.text.includes('ply_task_send')
      && noticesOf(b.parent, b.card.settingChange.requestId, from).length === 0, childNotice.text);
    await awaitTask(b.parent, (r) => r.status === 'completed' && r.notification === 'sent', 40_000);
    await sleep(500);

    // ---- 再起動で取り下げた結果も同じ規則: 子のタスクが終わっていれば依頼元へ
    const d = await childAsks('再起動をまたぐ子');
    const pendingId = d.card.settingChange.requestId;
    c.close?.();
    await server.stop();
    server = await startServer({ env: { AGENT_HOST_BACKENDS: 'fake' }, dataDir, timeoutMs: 60_000 });
    c = await open({ port: server.port, token: server.token });
    const restarted = await c.waitFor((e) => e.type === 'taskNotice' && e.sessionId === d.parent && String(e.text).includes(pendingId), { from: 0, ms: 30_000 });
    await sleep(500);
    t.ok('再起動で取り下げた結果も、子のタスクが終わっていれば依頼元の会話に届く（子の題・taskId つき）',
      /結果: 取り下げ/.test(restarted.text) && /再起動/.test(restarted.text) && restarted.text.includes('再起動をまたぐ子') && restarted.text.includes(d.task.taskId), restarted.text);
    t.ok('子の会話には届かない', c.since(0).filter((e) => e.type === 'taskNotice' && e.sessionId === d.child && String(e.text).includes(pendingId)).length === 0
      && c.since(0).filter((e) => e.type === 'turnEnd' && e.sessionId === d.child).length === 0);
  } finally {
    c?.close?.();
    await server.stop();
    await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}

/** 台帳の単体（サーバーなし）: 届け先の関数 */
async function ledger(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'setting-approvals-route-'));
  try {
    const delivered = [];
    let routeOf = (n) => (n.sessionId === 'child' ? { sessionId: 'parent', via: { taskId: 'task-1', title: '子', status: 'completed' } } : null);
    let answer = 'requeue';
    const ap = await createSettingApprovals({ dataDir: dir, intervalMs: 20, route: (n) => routeOf(n),
      deliver: async (sessionId, list) => { delivered.push([sessionId, list.map((n) => `${n.requestId}:${n.sessionId}:${n.via?.taskId ?? ''}`)]); return answer; } });
    await ap.add({ requestId: 'r1', sessionId: 'child', key: 'k', op: 'settings.set' });
    await ap.add({ requestId: 'r2', sessionId: 'other', key: 'k', op: 'settings.set' });
    await ap.add({ requestId: 'r3', sessionId: 'parent', key: 'k2', op: 'settings.set' });
    await ap.settle('r1', 'allowed'); await ap.settle('r2', 'denied'); await ap.settle('r3', 'denied');
    const seen = (id) => delivered.filter(([s, l]) => s === id).flatMap(([, l]) => l);
    const together = () => delivered.some(([s, l]) => s === 'parent' && l.includes('r1:child:task-1') && l.includes('r3:parent:'));
    await until(() => seen('parent').includes('r1:child:task-1') && seen('other').includes('r2:other:') && together());
    t.ok('終わった子の結果は依頼元の会話へ（via に子のタスクを添える）、ほかは求めた会話へ', seen('parent').includes('r1:child:task-1') && seen('other').includes('r2:other:') && !seen('child').length);
    t.ok('依頼元の会話の結果と、子の結果は同じ届け先なら 1 回でまとめて渡す', together());
    t.ok('渡す結果の sessionId は求めた会話のまま、台帳に via は残さない', ap.snapshot().notices.every((n) => !('via' in n)) && ap.snapshot().notices.find((n) => n.requestId === 'r1')?.sessionId === 'child');
    // 届くまでの間に子が動き出した（追加の指示）: 次の試みでは子へ届く
    routeOf = () => null;
    delivered.length = 0;
    await until(() => seen('child').includes('r1:child:'));
    t.ok('受け取られない間も届け先は試みごとに決め直す（動き出した子には子へ）', seen('child').includes('r1:child:'));
    // route が落ちる・不明な値は求めた会話
    routeOf = () => { throw new Error('boom'); };
    delivered.length = 0; answer = 'ok';
    await until(() => seen('child').includes('r1:child:') && ap.snapshot().notices.length === 0);
    t.ok('route が失敗しても求めた会話へ届ける', seen('child').includes('r1:child:') && ap.snapshot().notices.length === 0);
    await ap.flush();
    ap.close();
  } finally { await fs.rm(dir, { recursive: true, force: true }).catch(() => {}); }
}
