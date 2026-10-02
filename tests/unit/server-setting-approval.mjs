// 設定の変更の承認は待たずに返り、カードは期限なしで残り、結果は会話へ届く（ADR 0088）。fake バックエンドのサーバー越し。LLM は呼ばない。
//   - ターンの中の set_setting は承認待ちで返り、ターンが終わってもカードは残る。後で許可しても効き、結果は空いた会話に新しいターンで届く
//   - ターンを中断してもカードは取り下げない
//   - 走っているターンへは途中送信で届く（新しいターンを起こさない）
//   - 同じ会話・同じ設定の新しい要求は古いカードを置き換え、古い方の結果（取り下げ）を届ける
//   - 許可のあとに値が変わっていたら、同じ requestId で聞き直す
//   - 再起動をまたがない: 待っていた要求は次の起動で取り下げ、その結果を届ける
//   - 台帳（setting-approvals.json）の単体: 起動時の取り下げ・送り途中の結果は送り直さない・requeue
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startServer, ROOT } from '../lib/server.mjs';
import { open } from '../lib/ws-client.mjs';
import { createSettingApprovals, SETTING_APPROVALS_FILE } from '../../core/setting-approvals.mjs';

export const name = 'server-setting-approval';
export const title = '設定の変更の承認: 待たずに返る・期限なしのカード・結果を会話へ届ける（ターンの終わり・中断・途中送信・置き換え・聞き直し・再起動）';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const control = (name, args) => 'control:' + JSON.stringify({ name, arguments: args });

export default async function (t) {
  await ledger(t);

  const scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'agent-host-setting-approval-')));
  const dataDir = path.join(scratch, 'data');
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(path.join(dataDir, 'prefs.json'), JSON.stringify({ confirmAgentSites: true, agentSitePermissions: [] }));
  let server = await startServer({ env: { AGENT_HOST_BACKENDS: 'fake' }, dataDir, timeoutMs: 60_000 });
  let c = await open({ port: server.port, token: server.token });
  try {
    const start = async () => {
      const turn = await c.runTurn({ prompt: 'control-info', sessionId: null, cwd: ROOT, backend: 'fake', mode: 'default' }, { ms: 30_000 });
      const loaded = await c.cmd('loadSession', { sessionId: turn.sessionId });
      return { sessionId: turn.sessionId, info: JSON.parse(loaded.messages.at(-1).text) };
    };
    const api = (s, op, body) => fetch(`http://127.0.0.1:${server.port}/api/ops/${op}`, { method: 'POST', headers: { authorization: `Bearer ${s.info.token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) })
      .then(async (r) => ({ status: r.status, body: await r.json() }));
    const cardFor = (sessionId, from, pred = () => true) => c.waitFor((e) => e.type === 'permission' && e.settingChange && e.sessionId === sessionId && pred(e), { from, ms: 15_000 });
    const noticeFor = (sessionId, requestId, from) => c.waitFor((e) => e.type === 'taskNotice' && e.sessionId === sessionId && String(e.text).includes(requestId), { from, ms: 30_000 });
    const turnEnds = (sessionId, from) => c.since(from).filter((e) => e.type === 'turnEnd' && e.sessionId === sessionId);
    const resolve = (card, allow) => c.cmd('resolvePermission', { id: card.id, allow, receipt: card.settingChange.receipt, ...(allow ? {} : { messageKey: 'userDenied' }) });
    const loosen = { key: 'confirmAgentSites', value: false };

    // ---- ターンの中の set_setting: 待たずに返り、ターンが終わってもカードは残る
    const a = await start();
    let from = c.mark();
    const turn = await c.runTurn({ prompt: control('set_setting', { ...loosen, reason: 'テスト' }), sessionId: a.sessionId }, { ms: 30_000 });
    const card = await cardFor(a.sessionId, from);
    const toolOut = JSON.parse(turn.events.find((e) => e.type === 'tool.result')?.text ?? 'null');
    t.ok('ターンの中の set_setting は承認待ち（pending と requestId）で返り、ターンはそのまま終わる', toolOut?.status === 'pending' && toolOut.requestId === card.settingChange.requestId
      && turnEnds(a.sessionId, from).length === 1, JSON.stringify(toolOut));
    await sleep(300);
    const running = await c.cmd('running');
    const listed = running.permissions.find((p) => p.id === card.id);
    t.ok('ターンが終わってもカードは残る（期限なし。終了・更新を止める数には入れない）', listed?.detached === true && running.count === 0 && (await c.cmd('prefs')).confirmAgentSites === true, JSON.stringify(running.permissions));
    const reopened = await c.cmd('loadSession', { sessionId: a.sessionId, live: true });
    t.ok('会話を開き直しても、待っているカードが返る', reopened.permissions?.some((p) => p.id === card.id && p.settingChange?.requestId === card.settingChange.requestId));
    from = c.mark();
    await resolve(card, true);
    const allowed = await noticeFor(a.sessionId, card.settingChange.requestId, from);
    t.ok('ターンが終わった後に許可しても効き、結果（許可）が届く', (await c.cmd('prefs')).confirmAgentSites === false && /結果: 許可/.test(allowed.text), allowed.text);
    await c.waitFor((e) => e.type === 'turnEnd' && e.sessionId === a.sessionId, { from, ms: 30_000 });
    const history = await c.cmd('loadSession', { sessionId: a.sessionId });
    const noticeMsg = history.messages.find((m) => m.role === 'user' && String(m.text).includes(card.settingChange.requestId));
    t.ok('空いた会話には新しいターンで届き、履歴では人の発言ではなく通知として見分けられる', noticeMsg?.internalTaskNotice === true && turnEnds(a.sessionId, from).length === 1, JSON.stringify(noticeMsg));
    await c.cmd('setPref', { key: 'confirmAgentSites', value: true });

    // ---- 中断してもカードは取り下げない
    const b = await start();
    from = c.mark();
    const slow = c.runTurn({ prompt: 'slow', sessionId: b.sessionId }, { ms: 30_000 });
    await c.waitFor((e) => e.type === 'running' || (e.type === 'session' && e.sessionId === b.sessionId), { from, ms: 5000 }).catch(() => null);
    await sleep(300);
    const duringSlow = await api(b, 'settings.set', loosen);
    const cardB = await cardFor(b.sessionId, from);
    await c.cmd('abort', { sessionId: b.sessionId });
    await slow.catch(() => {});
    await sleep(300);
    t.ok('ターンを中断しても、設定の変更のカードは取り下げない', duringSlow.status === 202 && (await c.cmd('running')).permissions.some((p) => p.id === cardB.id));
    from = c.mark();
    await resolve(cardB, false);
    const deniedB = await noticeFor(b.sessionId, cardB.settingChange.requestId, from);
    t.ok('中断の後に拒否すると、結果（拒否）が届き、設定は変わらない', /結果: 拒否/.test(deniedB.text) && (await c.cmd('prefs')).confirmAgentSites === true, deniedB.text);
    await c.waitFor((e) => e.type === 'turnEnd' && e.sessionId === b.sessionId, { from, ms: 30_000 });

    // ---- 走っているターンへは途中送信で届く
    const d = await start();
    from = c.mark();
    const bg = c.runTurn({ prompt: 'bg 1 6', sessionId: d.sessionId }, { ms: 30_000 });
    await c.waitFor((e) => e.type === 'phase' && e.sessionId === d.sessionId && e.state === 'waiting', { from, ms: 15_000 });
    await api(d, 'settings.set', loosen);
    const cardD = await cardFor(d.sessionId, from);
    await resolve(cardD, false);
    const steered = await noticeFor(d.sessionId, cardD.settingChange.requestId, from);
    await bg;
    await sleep(500);
    const dHistory = await c.cmd('loadSession', { sessionId: d.sessionId });
    t.ok('走っているターンには途中送信で届き、同じターンで答える（新しいターンを起こさない）', /結果: 拒否/.test(steered.text) && turnEnds(d.sessionId, from).length === 1
      && dHistory.messages.some((m) => m.role === 'assistant' && String(m.text).includes('受け取った:') && String(m.text).includes(cardD.settingChange.requestId)), JSON.stringify(turnEnds(d.sessionId, from)));

    // ---- 同じ会話・同じ設定の新しい要求は、古いカードを置き換える
    const e = await start();
    from = c.mark();
    const first = await api(e, 'settings.set', { ...loosen, reason: '1 回目' });
    const card1 = await cardFor(e.sessionId, from);
    const mid = c.mark();
    const second = await api(e, 'settings.set', { ...loosen, reason: '2 回目' });
    const card2 = await cardFor(e.sessionId, mid, (ev) => ev.id !== card1.id);
    const replaced = await c.waitFor((ev) => ev.type === 'settingApproval' && ev.requestId === first.body.result.requestId, { from, ms: 15_000 });
    t.ok('同じ設定の新しい要求は古いカードを取り下げ（superseded）、古いカードへの答えは受け取らない', replaced.outcome === 'superseded' && card2.settingChange.requestId === second.body.result.requestId
      && await resolve(card1, true).then(() => false, () => true) && (await c.cmd('prefs')).confirmAgentSites === true);
    const supersededNotice = await noticeFor(e.sessionId, first.body.result.requestId, from);
    t.ok('古い要求の結果（取り下げ）が会話に届く', /結果: 取り下げ/.test(supersededNotice.text) && /新しい要求/.test(supersededNotice.text), supersededNotice.text);
    await c.waitFor((ev) => ev.type === 'turnEnd' && ev.sessionId === e.sessionId, { from, ms: 30_000 });
    const other = await api(e, 'settings.set', { key: 'agentSitePermissions', value: [{ origin: 'https://keep.example', mode: 'always', agent: 'fake' }] });
    t.ok('別の設定の要求は置き換えない（両方のカードが残る）', other.status === 202 && (await c.cmd('running')).permissions.filter((p) => p.sessionId === e.sessionId).length === 2);

    // ---- 許可のあとに値が変わっていたら、同じ requestId で聞き直す
    from = c.mark();
    const cardSites = (await c.cmd('running')).permissions.find((p) => p.sessionId === e.sessionId && p.id !== card2.id);
    const sitesEv = (await c.cmd('loadSession', { sessionId: e.sessionId, live: true })).permissions.find((p) => p.id === cardSites.id);
    await c.cmd('setPref', { key: 'agentSitePermissions', value: [{ origin: 'https://other.example', mode: 'ask', agent: 'fake' }] });
    await resolve(sitesEv, true);
    const again = await cardFor(e.sessionId, from, (ev) => ev.settingChange.requestId === other.body.result.requestId);
    t.ok('許可のあとに前の値が変わっていたら、同じ requestId の新しいカードで聞き直す（まだ書かない）', again.id !== sitesEv.id && again.settingChange.receipt !== sitesEv.settingChange.receipt
      && !(await c.cmd('prefs')).agentSitePermissions.some((x) => x.origin === 'https://keep.example'));
    await resolve(again, true);
    const reasked = await noticeFor(e.sessionId, other.body.result.requestId, from);
    t.ok('聞き直したカードの許可で書かれ、結果（許可）が 1 回届く', /結果: 許可/.test(reasked.text) && (await c.cmd('prefs')).agentSitePermissions.some((x) => x.origin === 'https://keep.example'), reasked.text);
    await c.waitFor((ev) => ev.type === 'turnEnd' && ev.sessionId === e.sessionId, { from, ms: 30_000 });

    // ---- 再起動をまたがない: 待っていた要求は、次の起動で取り下げた結果として届く
    const pendingId = card2.settingChange.requestId;
    const saved = JSON.parse(await fs.readFile(path.join(dataDir, SETTING_APPROVALS_FILE), 'utf8'));
    t.ok('答えを待つ要求は台帳に残る', saved.pending.some((p) => p.requestId === pendingId && p.sessionId === e.sessionId && p.key === 'confirmAgentSites'));
    c.close?.();
    await server.stop();
    server = await startServer({ env: { AGENT_HOST_BACKENDS: 'fake' }, dataDir, timeoutMs: 60_000 });
    c = await open({ port: server.port, token: server.token });
    const afterRestart = await noticeFor(e.sessionId, pendingId, 0);
    t.ok('再起動の後、待っていた要求の結果（取り下げ・再起動）が会話に届く', /結果: 取り下げ/.test(afterRestart.text) && /再起動/.test(afterRestart.text), afterRestart.text);
    await c.waitFor((ev) => ev.type === 'turnEnd' && ev.sessionId === e.sessionId, { from: 0, ms: 30_000 });
    await sleep(300);
    const left = JSON.parse(await fs.readFile(path.join(dataDir, SETTING_APPROVALS_FILE), 'utf8'));
    t.ok('届けたら台帳は空になり、カードも残らない', left.pending.length === 0 && left.notices.length === 0 && (await c.cmd('running')).permissions.length === 0, JSON.stringify(left));
  } finally {
    c?.close?.();
    await server.stop();
    await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}

/** 台帳の単体（サーバーなし） */
async function ledger(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'setting-approvals-'));
  try {
    const file = path.join(dir, SETTING_APPROVALS_FILE);
    await fs.writeFile(file, JSON.stringify({ version: 1,
      pending: [{ requestId: 'setting-a', sessionId: 's1', key: 'k', op: 'settings.set' }],
      notices: [{ requestId: 'setting-b', sessionId: 's1', key: 'k', op: 'settings.set', outcome: 'denied', state: 'delivering' },
        { requestId: 'setting-c', sessionId: 's2', key: null, op: 'probe.guarded', outcome: 'allowed', state: 'queued' }] }));
    const delivered = [];
    let answer = 'requeue';
    const ap = await createSettingApprovals({ dataDir: dir, intervalMs: 20, deliver: async (sessionId, list) => { delivered.push([sessionId, list.map((n) => `${n.requestId}:${n.outcome}`)]); return answer; } });
    t.ok('起動時: 前の起動で待っていた要求は取り下げ（restart）に変え、送り途中（delivering）の結果は送り直さない', ap.restored === 1
      && JSON.stringify(ap.snapshot().notices.map((n) => `${n.requestId}:${n.outcome}`).sort()) === JSON.stringify(['setting-a:restart', 'setting-c:allowed']) && ap.snapshot().pending.length === 0);
    await sleep(120);
    t.ok('受け取られない（requeue）間は列に残り、何度も試す', delivered.length >= 2 && ap.snapshot().notices.length === 2);
    answer = 'ok';
    await sleep(120);
    t.ok('受け取られたら列から外し、会話ごとにまとめて届ける', ap.snapshot().notices.length === 0 && delivered.some(([id, l]) => id === 's1' && l.join() === 'setting-a:restart'));
    await ap.add({ requestId: 'setting-d', sessionId: 's3', key: 'x', op: 'settings.set' });
    await ap.add({ requestId: 'setting-e', sessionId: 's3', key: null, op: 'probe.guarded' });
    t.ok('pendingFor は同じ会話・同じ設定（設定でない操作は同じ操作）だけ', ap.pendingFor('s3', 'x', 'settings.set').length === 1 && ap.pendingFor('s3', null, 'probe.guarded').length === 1
      && ap.pendingFor('s3', 'y', 'settings.set').length === 0 && ap.pendingFor('s4', 'x', 'settings.set').length === 0);
    answer = 'error';
    const settled = await ap.settle('setting-d', 'denied');
    await sleep(80);
    t.ok('settle は外した要求を返し、結果を届ける。渡ったか分からない（error）ものは送り直さない', settled?.requestId === 'setting-d' && (await ap.settle('setting-d', 'denied')) === null
      && ap.snapshot().notices.length === 0 && delivered.filter(([, l]) => l.includes('setting-d:denied')).length === 1);
    answer = 'ok';
    await ap.requeue([{ requestId: 'setting-d', sessionId: 's3', key: 'x', op: 'settings.set', outcome: 'denied', state: 'delivering' }]);
    await sleep(80);
    t.ok('requeue（途中送信が捨てられた）で列に戻して送り直す', delivered.filter(([, l]) => l.includes('setting-d:denied')).length === 2);
    await ap.flush();
    t.ok('台帳はファイルに残る（待っている要求）', JSON.parse(await fs.readFile(file, 'utf8')).pending.map((p) => p.requestId).join() === 'setting-e');
    ap.close();
  } finally { await fs.rm(dir, { recursive: true, force: true }).catch(() => {}); }
}
