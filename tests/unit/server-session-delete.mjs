// 送った会話の削除（sessions.delete。ADR 0147）をサーバー越しに（fake + 一時リポジトリ。LLM は呼ばない）。
//   - 送った会話が一覧から消え、別の接続（端末）にも sessionsChanged の deleted で届く
//   - 一緒に片付けるデータ（DB の sessions・session_fields・conversations、本文のファイル、presents、git の撮影の ref）が消え、使用量の記録は残る
//   - ネイティブの会話は消さない（fake の deleteSession が呼ばれず、fake の会話が残る）。残したネイティブの会話は一覧に戻らない
//   - 走っている会話・委譲した子が終わっていない会話は断る
//   - AI（会話に束縛された口）からは承認カードを経る。自分の会話は消せない
//   - 委譲の子を消しても親は壊れない。消した子への追加の指示は、子を作り直さずに失敗で返る
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../lib/server.mjs';
import { open, sleep } from '../lib/ws-client.mjs';
import { openReadOnly } from '../../core/db.mjs';
import { COMMANDS } from '../../core/protocol.mjs';

export const name = 'server-session-delete';
export const title = '送った会話の削除: 一覧と別の端末から消える・片付けるデータ・ネイティブの会話は残す・走っている会話は断る・承認カード・委譲の親子';

const sh = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', windowsHide: true }).trim();
const ply = (name, args) => 'ply:' + JSON.stringify({ name, arguments: args });
const exists = (file) => fs.stat(file).then(() => true, () => false);

export default async function (t) {
  try { execFileSync('git', ['--version'], { windowsHide: true }); } catch { t.skip('git が無い'); return; }
  const scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ply-session-delete-')));
  const repo = path.join(scratch, 'repo');
  const dataDir = path.join(scratch, 'data');
  await fs.mkdir(repo, { recursive: true });
  sh(repo, 'init', '-q', '-b', 'main');
  await fs.writeFile(path.join(repo, 'a.txt'), 'one\n');
  sh(repo, 'add', '.'); sh(repo, 'commit', '-q', '-m', 'first');

  const server = await startServer({ env: { AGENT_HOST_BACKENDS: 'fake', AGENT_HOST_GIT_SNAPSHOTS: 'on', AGENT_HOST_FAKE_USAGE: '1' }, dataDir, timeoutMs: 30_000 });
  const c = await open({ port: server.port, token: server.token });
  const other = await open({ port: server.port, token: server.token });   // 別の端末（同じホストの別の画面・リモート）
  const refsOf = (sid) => sh(repo, 'for-each-ref', '--format=%(refname)', `refs/pleiad/turn/${sid}/`).split('\n').filter(Boolean);
  const rows = (sql, ...args) => { const db = openReadOnly(dataDir); try { return db.prepare(sql).all(...args); } finally { db.close(); } };
  const nativeOf = (sid) => JSON.parse(rows('SELECT data FROM conversations WHERE id = ?', sid)[0]?.data ?? '{}').nativeId ?? null;
  const listed = async (client, id) => (await client.cmd('listSessions')).some((s) => s.id === id);
  const fakeNatives = async () => JSON.parse((await c.runTurn({ backend: 'fake', cwd: scratch, prompt: 'deleted-natives' })).events.filter((e) => e.type === 'text.delta').map((e) => e.text).join(''));
  const awaitTasks = async (fn) => {
    const deadline = Date.now() + 60_000;
    let list;
    while (Date.now() < deadline) { list = await c.cmd('agentTasks'); if (fn(list)) return list; await sleep(50); }
    throw new Error('task timeout: ' + JSON.stringify(list));
  };
  const turnWithChanges = async (args, change) => {
    const from = c.mark();
    const running = c.runTurn(args);
    await c.waitFor((e) => e.type === 'tool.start', { from });
    await change();
    return running;
  };
  try {
    t.ok('WS のコマンド deleteSession を protocol に登録している', COMMANDS.has('deleteSession'));

    // ---- 1. 送った会話（画面の新しい会話。Pleiad の記録を持つ。git の撮影と present・使用量の記録がある）
    const steps = { steps: [{ tool: 'Bash', input: { command: 'echo x > b.txt' }, result: 'ok', ms: 400 }, { text: '直しました' }] };
    const { sessionId: sid } = await c.cmd('newSession', { backend: 'fake', cwd: repo });
    await turnWithChanges({ sessionId: sid, prompt: `steps:${JSON.stringify(steps)}` }, () => fs.writeFile(path.join(repo, 'b.txt'), 'x\n'));
    const nativeId = nativeOf(sid);
    const presents = path.join(dataDir, 'presents', `${sid}.jsonl`);
    const body = path.join(dataDir, 'conversations', `${sid}.json`);
    const usageCount = () => rows("SELECT COUNT(*) AS n FROM usage_records WHERE json_extract(data, '$.sessionId') = ?", sid)[0].n;
    let usageBefore = usageCount();
    t.ok('前提: 送った会話の記録（DB の行・本文・presents・git の撮影の ref・使用量）がある', Boolean(nativeId)
      && rows('SELECT 1 FROM sessions WHERE session_id = ?', sid).length === 1 && rows('SELECT 1 FROM session_fields WHERE session_id = ?', sid).length > 0
      && await exists(body) && await exists(presents) && refsOf(sid).length > 0 && usageBefore > 0,
    JSON.stringify({ nativeId, refs: refsOf(sid), usageBefore, presents: await exists(presents) }));

    // ---- 2. 走っている会話は断る
    let from = c.mark();
    const slow = c.runTurn({ sessionId: sid, prompt: 'slow' });
    await c.waitFor((e) => e.type === 'session' && e.sessionId === sid, { from, ms: 10_000 }).catch(() => null);
    await sleep(200);
    const refused = await c.cmd('deleteSession', { sessionId: sid }).then(() => null, (e) => e);
    t.ok('走っている会話は消せない（CANNOT_DELETE。止めてから消すよう伝える）', refused?.code === 'CANNOT_DELETE' && /止める/.test(refused.message) && await listed(c, sid), String(refused?.message));
    await c.cmd('abort', { sessionId: sid });
    await slow.catch(() => {});
    await sleep(300);
    usageBefore = usageCount();

    // ---- 3. 画面から消す。一覧と別の端末から消える
    from = other.mark();
    const result = await c.cmd('deleteSession', { sessionId: sid });
    const notice = await other.waitFor((e) => e.type === 'sessionsChanged' && e.deleted === sid, { from, ms: 10_000 }).catch(() => null);
    t.ok('画面（人）は承認カードなしで消せる。別の端末にも sessionsChanged の deleted で届く', result === 'deleted' && Boolean(notice));
    t.ok('どちらの端末の一覧からも消え、ネイティブの会話もネイティブだけの行として戻らない',
      !(await listed(c, sid)) && !(await listed(other, sid)) && !(await listed(other, nativeId)));
    t.ok('DB の sessions・session_fields・context_entry_refs・conversations の行が消える',
      ['sessions', 'session_fields', 'context_entry_refs'].every((table) => rows(`SELECT 1 FROM ${table} WHERE session_id = ?`, sid).length === 0)
      && rows('SELECT 1 FROM conversations WHERE id = ?', sid).length === 0);
    t.ok('本文のファイル（conversations/<id>.json）と提示の記録（presents）が消える', !(await exists(body)) && !(await exists(presents)));
    let refsGone = false;
    for (let i = 0; i < 50 && !refsGone; i++) { refsGone = refsOf(sid).length === 0; if (!refsGone) await sleep(100); }
    t.ok('git の撮影の ref（refs/pleiad/turn/<id>/）が消える', refsGone, refsOf(sid).join(','));
    t.ok('使用量の記録は集計の履歴として残る', usageCount() === usageBefore);
    t.ok('消した会話のネイティブの id を覚える（deleted_natives）', rows('SELECT session_id FROM deleted_natives WHERE native_id = ?', nativeId)[0]?.session_id === sid);
    const natives = await fakeNatives();
    t.ok('ネイティブの会話は消さない（fake の deleteSession が呼ばれず、fake の会話が残る）', natives.deleted.length === 0 && natives.live.includes(nativeId), JSON.stringify(natives));
    const again = await c.cmd('deleteSession', { sessionId: sid }).then(() => null, (e) => e);
    t.ok('消した会話をもう一度消すと SESSION_NOT_FOUND', again?.code === 'SESSION_NOT_FOUND', String(again?.code));

    // Pleiad の記録を持たない会話（ネイティブだけの行。id がネイティブの id）も消せる。ネイティブの会話は残し、一覧に戻らない
    const bare = (await c.runTurn({ backend: 'fake', cwd: scratch, prompt: 'echo:ネイティブだけ' })).sessionId;
    const bareNatives = await c.cmd('deleteSession', { sessionId: bare }).then(() => fakeNatives());
    t.ok('ネイティブだけの会話も消せる（一覧から消え、fake の会話は残る）', !(await listed(c, bare)) && bareNatives.live.includes(bare) && bareNatives.deleted.length === 0
      && rows('SELECT 1 FROM deleted_natives WHERE native_id = ?', bare).length === 1, JSON.stringify(bareNatives));

    // ---- 4. AI（会話に束縛された口）からは承認カードを経る
    const startBound = async () => {
      const turn = await c.runTurn({ prompt: 'control-info', sessionId: null, cwd: scratch, backend: 'fake', mode: 'default' }, { ms: 30_000 });
      const loaded = await c.cmd('loadSession', { sessionId: turn.sessionId });
      return { sessionId: turn.sessionId, info: JSON.parse(loaded.messages.at(-1).text) };
    };
    const api = (s, op, payload) => fetch(`http://127.0.0.1:${server.port}/api/ops/${op}`, { method: 'POST', headers: { authorization: `Bearer ${s.info.token}`, 'content-type': 'application/json' }, body: JSON.stringify(payload) })
      .then(async (r) => ({ status: r.status, body: await r.json() }));
    const asker = await startBound();
    const target = (await c.runTurn({ backend: 'fake', cwd: scratch, prompt: 'echo:消される会話' })).sessionId;
    from = c.mark();
    const asked = await api(asker, 'sessions.delete', { sessionId: target });
    const card = await c.waitFor((e) => e.type === 'permission' && e.settingChange && e.sessionId === asker.sessionId, { from, ms: 15_000 }).catch(() => null);
    t.ok('AI の sessions.delete は承認待ちで返り、依頼した会話に承認カードが出る（まだ消えない）', asked.status === 202 && Boolean(card) && card.settingChange.words === 'conversationDelete'
      && await listed(c, target), JSON.stringify({ status: asked.status, body: asked.body, words: card?.settingChange?.words }));
    from = c.mark();
    await c.cmd('resolvePermission', { id: card.id, allow: true, receipt: card.settingChange.receipt });
    const removed = await c.waitFor((e) => e.type === 'sessionsChanged' && e.deleted === target, { from, ms: 15_000 }).catch(() => null);
    t.ok('許可すると消える', Boolean(removed) && !(await listed(c, target)));
    const self = await api(asker, 'sessions.delete', { sessionId: asker.sessionId });
    t.ok('自分の会話は消せない（DELETE_SELF。承認カードを出さない）', self.body?.code === 'DELETE_SELF' && await listed(c, asker.sessionId), JSON.stringify(self.body));

    // ---- 5. 委譲の親子
    const parentTurn = await c.runTurn({ backend: 'fake', cwd: scratch, prompt: ply('ply_delegate', { kind: 'mechanical', backend: 'fake', task: 'slow', title: '終わらない子' }) });
    const parent = parentTurn.sessionId;
    let tasks = await awaitTasks((list) => list.some((r) => r.parentSessionId === parent && r.status === 'running'));
    const busyChild = tasks.find((r) => r.parentSessionId === parent);
    const busyParent = await c.cmd('deleteSession', { sessionId: parent }).then(() => null, (e) => e);
    t.ok('委譲した子が終わっていない親は消せない', busyParent?.code === 'CANNOT_DELETE' && /委譲/.test(busyParent.message), String(busyParent?.message));
    const busyKid = await c.cmd('deleteSession', { sessionId: busyChild.sessionId }).then(() => null, (e) => e);
    t.ok('走っている委譲の子も消せない', busyKid?.code === 'CANNOT_DELETE', String(busyKid?.message));
    await c.cmd('cancelAgentTask', { taskId: busyChild.taskId });
    await awaitTasks((list) => list.some((r) => r.taskId === busyChild.taskId && !['queued', 'running', 'cancelling'].includes(r.status)));

    const doneTurn = await c.runTurn({ backend: 'fake', cwd: scratch, prompt: ply('ply_delegate', { kind: 'mechanical', backend: 'fake', task: 'echo:CHILD_RESULT', title: '終わる子' }) });
    const owner = doneTurn.sessionId;
    tasks = await awaitTasks((list) => list.some((r) => r.parentSessionId === owner && r.notification === 'sent'));
    const child = tasks.find((r) => r.parentSessionId === owner);
    await sleep(300);
    t.ok('終わった子は消せる。タスクの記録は履歴として残る', await c.cmd('deleteSession', { sessionId: child.sessionId }) === 'deleted'
      && !(await listed(c, child.sessionId)) && (await c.cmd('agentTasks')).some((r) => r.taskId === child.taskId && r.sessionId === child.sessionId));
    const ownerHistory = await c.cmd('loadSession', { sessionId: owner }).then((r) => r, () => null);
    t.ok('子を消しても親は開ける（子の結果の通知は親の履歴に残る）', Boolean(ownerHistory?.messages?.some((m) => m.internalTaskNotice)));
    await c.runTurn({ sessionId: owner, prompt: ply('ply_task_send', { taskId: child.taskId, message: 'echo:AGAIN' }) });
    tasks = await awaitTasks((list) => list.some((r) => r.taskId === child.taskId && r.status === 'failed'));
    t.ok('消した子への追加の指示は、子を作り直さずに失敗で返る', /削除/.test(tasks.find((r) => r.taskId === child.taskId).error ?? '')
      && !(await listed(c, child.sessionId)) && rows('SELECT 1 FROM sessions WHERE session_id = ?', child.sessionId).length === 0,
    JSON.stringify(tasks.find((r) => r.taskId === child.taskId)));
    await awaitTasks((list) => list.filter((r) => r.parentSessionId === owner).every((r) => r.notification === 'sent' || r.notification === 'read'));
    await sleep(300);
    t.ok('子の終わった親は消せる', await c.cmd('deleteSession', { sessionId: owner }) === 'deleted' && !(await listed(c, owner)));
    t.ok('親を消しても、残った子の会話とタスクの一覧は読める（サーバーが落ちない）', Array.isArray(await c.cmd('agentTasks')) && Array.isArray(await c.cmd('listSessions'))
      && (await c.cmd('running')).turns !== undefined);
  } finally {
    c.close(); other.close();
    await server.stop();
    await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}
