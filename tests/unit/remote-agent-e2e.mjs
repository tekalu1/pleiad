// 端末の AI からリモートのホストへ任せる、端末 → 中継 → ホストの往復（docs/remote.md §4.5、docs/agent-delegation.md「リモートのホストへ任せる」、ADR 0141）。
// 本物の中継（relay/server.mjs）をこのプロセスで、ホストと端末のローカルのサーバー（どちらも fake バックエンド）を別プロセスで立てる。
// 端末のサーバーは main の身代わり（tests/lib/remote-agent-parent-port.mjs。本物と同じ橋 core/remote/agent-service.mjs と、本物の端末の部品）を付けて起こす。
// 端末の fake の会話から ply_delegate { host } を呼び、状態・完了通知・追加指示・取り消し・中継された承認と人の答え・オフラインの即失敗・
// つなぎ直しの追いつき・取り消しで止まる・承認モードの引き上げの確かめを確かめる。LLM もネットワークも使わない。
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRelay } from '../../relay/server.mjs';
import { startServer, ROOT } from '../lib/server.mjs';
import { open, sleep } from '../lib/ws-client.mjs';
import { createRemoteDevice, createDeviceStore } from '../../core/remote/device.mjs';

export const name = 'remote-agent-e2e';
export const title = '端末の AI からホストへ任せる（端末のサーバー → main の橋 → 中継 → ホスト）: 委譲・完了通知・承認の中継と答え・オフライン・追いつき・取り消し';

const SECRET = crypto.randomBytes(32).toString('base64url');
const prompt = (name, args) => 'ply:' + JSON.stringify({ name, arguments: args });
const within = (p, ms, label) => {
  let timer;
  return Promise.race([Promise.resolve(p).finally(() => clearTimeout(timer)), new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`${label} が ${ms}ms で終わらない`)), ms); })]);
};
const until = async (fn, ms, label) => {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error(`${label} が ${ms}ms で満たされない`); await sleep(100); }
};

export default async function (t) {
  const scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'agent-host-remote-agent-e2e-')));
  const hostDir = path.join(scratch, 'host');
  const termDir = path.join(scratch, 'term');
  const devDir = path.join(scratch, 'device');
  let relay = createRelay({ enrollSecret: SECRET, trustProxy: false, logger: () => {} });
  const relayPort = (await relay.listen(0, '127.0.0.1')).port;
  const restartRelay = async () => { await within(relay.close(), 5000, '中継の停止'); relay = createRelay({ enrollSecret: SECRET, trustProxy: false, logger: () => {} }); await within(relay.listen(relayPort, '127.0.0.1'), 5000, '中継の立て直し'); };
  // 設定の変更の承認（hostOnly の確かめ）が出るよう、ホストの設定は既定のまま（confirmAgentSites を明示する）
  await fs.mkdir(hostDir, { recursive: true });
  await fs.writeFile(path.join(hostDir, 'prefs.json'), JSON.stringify({ confirmAgentSites: true, agentSitePermissions: [] }));
  const host = await startServer({ env: { AGENT_HOST_BACKENDS: 'fake' }, dataDir: hostDir, timeoutMs: 30_000 });
  const ch = await open({ port: host.port, token: host.token });
  const hostCmd = (command, args = {}) => within(ch.cmd(command, args), 15_000, `ホストの ${command}`);
  let term = null, ct = null;
  try {
    // ---- ホストを有効にして、端末（デスクトップ版）をペアリングする
    await hostCmd('setRemoteSettings', { relayUrl: `http://127.0.0.1:${relayPort}`, enrollSecret: SECRET, enabled: true, hostName: 'desk-test' });
    await ch.waitFor(e => e.type === 'remoteStatus' && e.status.connection.state === 'connected', { from: 0, ms: 10_000 });
    const offer = await hostCmd('remotePairingStart');
    const dev = createRemoteDevice({ dir: devDir, app: 'test', name: 'laptop-test', platform: 'desktop' });
    const from = ch.mark();
    const paired = dev.pair(offer.payload, { onCode: () => {} });
    const req = await ch.waitFor(e => e.type === 'remotePairing' && e.phase === 'request', { from, ms: 10_000 });
    await hostCmd('remotePairingApprove', { id: req.request.id });
    const rec = await within(paired, 20_000, 'ペアリング');
    await dev.closeAll();
    const hostId = rec.hostId;
    const devices = await hostCmd('remoteDevices');
    const deviceId = devices[0].id;
    const deviceStore = createDeviceStore({ dir: devDir });

    // ---- 端末のローカルのサーバーを main の身代わり付きで起こす
    term = await startServer({ env: { AGENT_HOST_BACKENDS: 'fake', FAKE_REMOTE_DEVICE_DIR: devDir }, dataDir: termDir, entry: path.join(ROOT, 'tests', 'lib', 'remote-agent-parent-port.mjs'), timeoutMs: 60_000 });
    ct = await open({ port: term.port, token: term.token });
    const termCmd = (command, args = {}) => within(ct.cmd(command, args), 15_000, `端末の ${command}`);
    // 完了通知で始まった依頼元のターンが走っている間は、同じ会話に次のターンを始められない（切り替え中）。空くまで待ってやり直す
    const tool = async (sessionId, name, args, extra = {}) => {
      for (let i = 0; ; i++) {
        try { return await ct.runTurn({ ...(sessionId ? { sessionId } : { backend: 'fake', cwd: ROOT }), ...extra, prompt: prompt(name, args) }, { ms: 60_000 }); }
        catch (e) {
          if (i < 40 && /切り替え中/.test(e.message)) { await sleep(250); continue; }
          e.message = `${name} ${JSON.stringify(args).slice(0, 80)}: ${e.message}`;
          throw e;
        }
      }
    };
    const toolResult = r => { const e = r.events.findLast(x => x.type === 'tool.result'); return { isError: Boolean(e?.isError), text: e?.text ?? '', json: (() => { try { return JSON.parse(e?.text); } catch { return null; } })() }; };
    const tRows = () => termCmd('agentTasks');
    const hRows = () => hostCmd('agentTasks');

    // ---- 両側オフのうちは host を出さない・ホストの許可を入れても端末側がオフなら使えない
    const first = await tool(null, 'ply_delegate', { host: 'desk-test', kind: 'mechanical', backend: 'fake', task: 'echo:NO' });
    const sid = first.sessionId;
    t.ok('既定（両側オフ）では ply_delegate に host の引数が無い（書くと不正な引数）', toolResult(first).isError === true && (await tRows()).length === 0, toolResult(first).text);
    await hostCmd('setRemoteDeviceAgent', { id: deviceId, enabled: true });
    await sleep(500);
    const hostOnly = toolResult(await tool(sid, 'ply_delegate', { host: 'desk-test', kind: 'mechanical', backend: 'fake', task: 'echo:NO' }));
    t.ok('ホストだけがオンでも、端末側がオフなら host は出ない', hostOnly.isError === true && (await tRows()).length === 0);

    // ---- 端末側もオン（窓のスイッチの代わりに hosts.json の agentUse）
    await deviceStore.updateHost(hostId, { agentUse: true });
    const readyBy = async () => { const r = toolResult(await tool(sid, 'ply_delegate', { host: 'desk-test', kind: 'mechanical', backend: 'fake', task: 'echo:REMOTE_HELLO', title: 'ホストで挨拶' })); return r.isError ? null : r; };
    const started = await until(readyBy, 30_000, '両側オンで host が使える');
    t.ok('両側オンになると host が使え、taskId・host の名前・状態が返る', /^ply-task-/.test(started.json?.taskId ?? '') && started.json.host === 'desk-test' && started.json.title === 'ホストで挨拶', started.text.slice(0, 200));
    const taskId = started.json.taskId;
    const done = await until(async () => (await tRows()).find(r => r.taskId === taskId && r.status === 'completed' && r.notification === 'sent'), 30_000, '完了と完了通知');
    t.ok('端末の台帳にホストのタスクの写しがあり、完了して結果が写る', done.host?.name === 'desk-test' && done.result === 'REMOTE_HELLO' && done.parentSessionId === sid, JSON.stringify([done.host, done.result]));
    const hostRow = (await hRows()).find(r => r.taskId === taskId);
    t.ok('ホストの台帳は同じ taskId で、親は仮の ID（端末の会話）', hostRow?.parentSessionId === `remote:${deviceId}:${sid}` && hostRow.result === 'REMOTE_HELLO' && hostRow.requester?.sessionId === sid);
    const parent = await termCmd('loadSession', { sessionId: sid });
    t.ok('完了通知は端末の依頼元の会話に届く（人間の発言と区別される）', parent.messages.filter(m => m.internalTaskNotice).length === 1);
    const hostChild = (await hostCmd('listSessions')).find(s => s.id === hostRow.sessionId);
    t.ok('ホストの子の会話に出どころ（どの端末の・どの会話の AI か）が残る', hostChild?.delegation?.remote?.deviceId === deviceId && hostChild.delegation.remote.sessionId === sid);

    // ---- status・send・list・wait・cancel
    const st = toolResult(await tool(sid, 'ply_task_status', { taskId }));
    t.ok('ply_task_status は同じ taskId でホストの結果を返す', st.json?.result === 'REMOTE_HELLO' && st.json.host === 'desk-test' && st.json.status === 'completed', st.text.slice(0, 200));
    const send = toolResult(await tool(sid, 'ply_task_send', { taskId, message: 'echo:SECOND' }));
    t.ok('ply_task_send でホストの子に追加の指示が届く', !send.isError, send.text.slice(0, 200));
    await until(async () => (await tRows()).find(r => r.taskId === taskId && r.result === 'SECOND' && r.status === 'completed'), 30_000, '追加の指示の完了');
    t.ok('追加の指示の結果が写る', true);
    const sendCfg = toolResult(await tool(sid, 'ply_task_send', { taskId, message: 'x', model: 'fast' }));
    t.ok('ホストのタスクの設定の変更（model など）は初版では使えない', sendCfg.isError === true, sendCfg.text);
    const list = toolResult(await tool(sid, 'ply_task_list', {}));
    t.ok('ply_task_list にホストのタスクが載り、host の名前が付く', list.json?.tasks?.some(r => r.taskId === taskId && (r.host === 'desk-test' || r.host?.name === 'desk-test')), list.text.slice(0, 200));
    const slow = toolResult(await tool(sid, 'ply_delegate', { host: 'desk-test', kind: 'mechanical', backend: 'fake', task: 'slow' }));
    const slowId = slow.json.taskId;
    await until(async () => (await tRows()).find(r => r.taskId === slowId && r.status === 'running'), 20_000, '実行中');
    const waited = toolResult(await tool(sid, 'ply_task_wait', { taskId: slowId, seconds: 1 }));
    t.ok('ply_task_wait は動いている間は running を返す', waited.json?.status === 'running', waited.text.slice(0, 160));
    const cancel = toolResult(await tool(sid, 'ply_task_cancel', { taskId: slowId }));
    t.ok('ply_task_cancel でホストのタスクが止まる', !cancel.isError && (await hRows()).find(r => r.taskId === slowId)?.status === 'cancelled', cancel.text.slice(0, 160));
    await until(async () => (await tRows()).find(r => r.taskId === slowId)?.status === 'cancelled', 10_000, '写しも cancelled');
    const other = toolResult(await tool(null, 'ply_task_status', { taskId }));
    t.ok('別の会話の AI は、ホストのタスクを見られない（所有の判定）', other.isError === true);

    // ---- 承認の中継: 端末の会話に出て、そこで答えられる
    const askStart = toolResult(await tool(sid, 'ply_delegate', { host: 'desk-test', kind: 'mechanical', backend: 'fake', task: 'ask' }));
    const askId = askStart.json.taskId;
    const card = await ct.waitFor(e => e.type === 'permission' && e.remote?.relayId && e.sessionId === sid, { from: 0, ms: 30_000 });
    t.ok('ホストの子の承認が、端末の依頼元の会話の中継のカードとして出る（⇄ ホスト名・常に許可は無し）', card.remote.hostName === 'desk-test' && card.canAlways === false && card.toolName === 'fake_write' && /委譲先/.test(card.title ?? ''), JSON.stringify({ r: card.remote, t: card.title }));
    const rowWaiting = await until(async () => { const l = toolResult(await tool(sid, 'ply_task_status', { taskId: askId })); return l.json?.status === 'waiting' ? l : null; }, 15_000, 'waiting');
    t.ok('承認待ちの間、ply_task_status は waiting を返す', Boolean(rowWaiting));
    const run1 = await termCmd('running');
    t.ok('端末の実行中の一覧にも、中継のカード（remote のホスト名・オンライン）が載る', run1.permissions.some(p => p.id === card.id && p.relay === true && p.remote?.hostName === 'desk-test' && p.remote.online === true));
    const askChild = hostChildOf(await hRows(), askId);
    const hostCard = await until(async () => (await hostCmd('running')).permissions.find(p => p.sessionId === askChild && !p.relay), 15_000, 'ホストの承認カード');
    t.ok('ホストの画面にも子の会話の承認カードが出る', Boolean(hostCard));
    // 端末の AI は、中継されたカードに答えられない（承認の答えは画面の人の経路だけ。human-only の resolvePermission は AI の操作の一覧に無い）
    const viaControl = await (async () => {
      for (let i = 0; ; i++) {
        try { return await ct.runTurn({ sessionId: sid, prompt: 'control:' + JSON.stringify({ name: 'call_op', arguments: { op: 'resolvePermission', args: { id: card.id, allow: true } } }) }, { ms: 60_000 }); }
        catch (e) { if (i < 40 && /切り替え中/.test(e.message)) { await sleep(250); continue; } throw e; }
      }
    })();
    t.ok('端末の AI は ply_control から承認の答え（resolvePermission）を呼べず、カードは待ち続ける',
      !/許可された/.test(JSON.stringify(viaControl.events.filter(e => e.type === 'tool.result').map(e => e.text))) && (await termCmd('running')).permissions.some(p => p.id === card.id), JSON.stringify(viaControl.events.filter(e => e.type === 'tool.result').map(e => String(e.text).slice(0, 200))));
    const mark = ct.mark();
    await termCmd('resolvePermission', { id: card.id, allow: true });
    const ended = await ct.waitFor(e => e.type === 'permissionRelayEnd' && e.id === card.id, { from: mark, ms: 15_000 });
    t.ok('端末で答えると、決着（by: device）で端末のカードが畳まれる', ended.by === 'device' && ended.allow === true && ended.hostName === 'desk-test');
    await until(async () => (await tRows()).find(r => r.taskId === askId && r.status === 'completed' && r.result === '許可された'), 30_000, '承認後の完了');
    t.ok('許可はホストの子の承認として効き、子が続きを走らせる', true);
    t.ok('ホストの承認カードも消える（先に答えた方で決着）', !(await hostCmd('running')).permissions.some(p => p.id === hostCard.id));
    const answeredTwice = await termCmd('resolvePermission', { id: card.id, allow: false }).then(() => null, e => e);
    t.ok('決着したカードへもう一度答えると、処理済みと返る', Boolean(answeredTwice));

    // ---- ホストで先に答える
    const mark2 = ct.mark();
    const ask2 = toolResult(await tool(sid, 'ply_delegate', { host: 'desk-test', kind: 'mechanical', backend: 'fake', task: 'ask' })).json.taskId;
    const card2 = await ct.waitFor(e => e.type === 'permission' && e.remote?.relayId && e.sessionId === sid, { from: mark2, ms: 30_000 });
    const hostChild2 = (await hRows()).find(r => r.taskId === ask2).sessionId;
    const hc2 = await until(async () => (await hostCmd('running')).permissions.find(p => p.sessionId === hostChild2 && !p.relay), 15_000, 'ホストの 2 件目のカード');
    const mark3 = ct.mark();
    await hostCmd('resolvePermission', { id: hc2.id, allow: false });
    const ended2 = await ct.waitFor(e => e.type === 'permissionRelayEnd' && e.id === card2.id, { from: mark3, ms: 15_000 });
    t.ok('ホストの画面で先に答えると、端末のカードが畳まれる（by: host）', ended2.by === 'host' && ended2.allow === false && ended2.hostName === 'desk-test', JSON.stringify(ended2));
    await until(async () => (await tRows()).find(r => r.taskId === ask2 && r.status === 'completed'), 30_000, '拒否の後の完了');

    // ---- オフライン: 即座に失敗する・走っている途中で切れてもホストで続き、つながり直すと追いつく
    const steps = JSON.stringify({ steps: [{ tool: 'Grep', input: {}, result: 'x', ms: 2500 }, { text: 'DONE_WHILE_OFFLINE' }] });
    const catchStart = toolResult(await tool(sid, 'ply_delegate', { host: 'desk-test', kind: 'mechanical', backend: 'fake', task: `steps:${steps}` })).json.taskId;
    await until(async () => (await tRows()).find(r => r.taskId === catchStart && r.status === 'running'), 20_000, '追いつきの試験の実行中');
    const ask3 = toolResult(await tool(sid, 'ply_delegate', { host: 'desk-test', kind: 'mechanical', backend: 'fake', task: 'ask' })).json.taskId;
    const card3 = await until(async () => (await termCmd('running')).permissions.find(p => p.relay && p.remote && p.remote.online && p.id !== card.id && p.id !== card2.id), 30_000, '3 件目の中継のカード');
    const markOff = ct.mark();
    await within(relay.close(), 5000, '中継の停止');
    await ct.waitFor(e => e.type === 'permissionRelayState' && e.id === card3.id && e.online === false, { from: markOff, ms: 15_000 });
    t.ok('ホストがオフラインの間、中継のカードはオフラインの印になる（permissionRelayState）', (await termCmd('running')).permissions.find(p => p.id === card3.id)?.remote?.online === false);
    const offAnswer = await termCmd('resolvePermission', { id: card3.id, allow: true }).then(() => null, e => e);
    t.ok('オフラインの間は答えを送れず、理由を返す（カードは残る）', /オフライン/.test(offAnswer?.message ?? '') && (await termCmd('running')).permissions.some(p => p.id === card3.id), offAnswer?.message);
    const t0 = Date.now();
    const offDelegate = toolResult(await tool(sid, 'ply_delegate', { host: 'desk-test', kind: 'mechanical', backend: 'fake', task: 'echo:OFFLINE' }));
    t.ok('オフラインのホストへの ply_delegate は、待たずに失敗する', offDelegate.isError === true && /オフライン/.test(offDelegate.text) && Date.now() - t0 < 5000, `${Date.now() - t0}ms ${offDelegate.text.slice(0, 120)}`);
    const offStatus = toolResult(await tool(sid, 'ply_task_status', { taskId: catchStart }));
    t.ok('オフラインの間の ply_task_status は、最後に分かっている状態を返す（hostOffline）', offStatus.json?.hostOffline === true && !offStatus.isError, offStatus.text.slice(0, 200));
    const offSend = toolResult(await tool(sid, 'ply_task_send', { taskId: catchStart, message: 'x' }));
    t.ok('オフラインの間の ply_task_send は失敗する', offSend.isError === true);
    await sleep(3200);   // 切れている間に、ホストの子は終わる
    t.ok('切れている間も、ホストの子は続けて終わる', (await hRows()).find(r => r.taskId === catchStart)?.status === 'completed');
    const markOn = ct.mark();
    await within((async () => { relay = createRelay({ enrollSecret: SECRET, trustProxy: false, logger: () => {} }); await relay.listen(relayPort, '127.0.0.1'); })(), 5000, '中継の立て直し');
    const caught = await until(async () => (await tRows()).find(r => r.taskId === catchStart && r.status === 'completed' && r.result === 'DONE_WHILE_OFFLINE'), 40_000, 'つなぎ直しの追いつき');
    t.ok('つなぎ直すと、状態と結果に追いつく（完了通知も届く）', Boolean(caught));
    await ct.waitFor(e => e.type === 'permissionRelayState' && e.id === card3.id && e.online === true, { from: markOn, ms: 20_000 });
    t.ok('つなぎ直すと、中継のカードがオンラインに戻る', (await termCmd('running')).permissions.find(p => p.id === card3.id)?.remote?.online === true);
    const markAns = ct.mark();
    await termCmd('resolvePermission', { id: card3.id, allow: true });
    await ct.waitFor(e => e.type === 'permissionRelayEnd' && e.id === card3.id, { from: markAns, ms: 15_000 });
    await until(async () => (await tRows()).find(r => r.taskId === ask3 && r.status === 'completed'), 30_000, 'つなぎ直した後の答えの完了');
    t.ok('戻った後は答えを送れ、ホストの子が続く', true);

    // ---- 質問のカードの中継: 端末の会話で選んで答え、選んだ項目がホストの子へ届く
    const markQ = ct.mark();
    const qId = toolResult(await tool(sid, 'ply_delegate', { host: 'desk-test', kind: 'mechanical', backend: 'fake', task: 'question' })).json.taskId;
    const qCard = await ct.waitFor(e => e.type === 'permission' && e.remote?.relayId && e.kind === 'question' && e.sessionId === sid, { from: markQ, ms: 30_000 });
    t.ok('ホストの子の質問が、端末の依頼元の会話に質問のカード（選択肢つき・⇄ ホスト名）として出る', qCard.remote.hostName === 'desk-test' && qCard.questions?.[0]?.question === 'どれにする？' && qCard.canAlways === false, JSON.stringify(qCard).slice(0, 240));
    const markQa = ct.mark();
    await termCmd('resolvePermission', { id: qCard.id, allow: true, answers: { 'どれにする？': 'B' } });
    await ct.waitFor(e => e.type === 'permissionRelayEnd' && e.id === qCard.id, { from: markQa, ms: 15_000 });
    const qDone = await until(async () => (await tRows()).find(r => r.taskId === qId && r.status === 'completed'), 30_000, '質問後の完了');
    t.ok('端末で選んだ項目がホストの子へ届き、子が続きを走らせる', qDone.result === '回答: {"どれにする？":"B"}', qDone.result);

    // ---- 設定の変更の承認: 端末のカードには答えるボタンが無く、AI にも「ホストの画面で答える」と伝わる。ホストで答えるとカードが畳まれる
    const markH = ct.mark();
    const hoId = toolResult(await tool(sid, 'ply_delegate', { host: 'desk-test', kind: 'mechanical', backend: 'fake', task: 'control:' + JSON.stringify({ name: 'set_setting', arguments: { key: 'confirmAgentSites', value: false, reason: 'テスト' } }) })).json.taskId;
    const hoCard = await ct.waitFor(e => e.type === 'permission' && e.remote?.hostOnly === true && e.sessionId === sid, { from: markH, ms: 30_000 });
    t.ok('設定の変更の承認は、端末に答えられない「ホストの画面で答える」カード（hostOnly）として出る', hoCard.remote.hostName === 'desk-test' && hoCard.canAlways === false, JSON.stringify(hoCard.remote));
    const hoAns = await termCmd('resolvePermission', { id: hoCard.id, allow: true }).then(() => null, e => e);
    t.ok('端末からは答えを送れない（カードは残る）', Boolean(hoAns) && (await termCmd('running')).permissions.some(p => p.id === hoCard.id));
    const hoStatus = toolResult(await tool(sid, 'ply_task_status', { taskId: hoId }));
    t.ok('AI へ返る状態に、ホストの画面で答える旨（hostOnlyApproval）が付く', /desk-test/.test(hoStatus.json?.hostOnlyApproval ?? ''), hoStatus.text.slice(0, 200));
    const hoHost = await ch.waitFor(e => e.type === 'permission' && e.settingChange, { from: 0, ms: 15_000 });
    const markHe = ct.mark();
    await hostCmd('resolvePermission', { id: hoHost.id, allow: false, receipt: hoHost.settingChange.receipt });
    const hoEnd = await ct.waitFor(e => e.type === 'permissionRelayEnd' && e.id === hoCard.id, { from: markHe, ms: 15_000 });
    t.ok('ホストの画面で答えると、端末のカードが畳まれる（by: host）', hoEnd.by === 'host');

    // ---- オフライン中の「止める」: 止める予定として残り、つながり直したらホストへ届く（ホストの便りで走り直した状態に戻らない）
    const pendId = toolResult(await tool(sid, 'ply_delegate', { host: 'desk-test', kind: 'mechanical', backend: 'fake', task: 'slow' })).json.taskId;
    await until(async () => (await tRows()).find(r => r.taskId === pendId && r.status === 'running'), 20_000, '止める予定の試験の実行中');
    await within(relay.close(), 5000, '中継の停止（止める予定の試験）');
    await until(async () => (await termCmd('hosts').catch(() => null)) !== undefined, 1000, 'x').catch(() => {});
    const offCancel = toolResult(await tool(sid, 'ply_task_cancel', { taskId: pendId }));
    const pendRow = (await tRows()).find(r => r.taskId === pendId);
    t.ok('オフライン中の ply_task_cancel は止める予定になる（端末の写しは cancelled・cancelPending。ホストはまだ走っている）', !offCancel.isError && pendRow?.status === 'cancelled' && pendRow.cancelPending === true && ['running', 'queued'].includes((await hRows()).find(r => r.taskId === pendId)?.status), JSON.stringify([offCancel.text.slice(0, 120), pendRow?.status, pendRow?.cancelPending]));
    const pendStatus = toolResult(await tool(sid, 'ply_task_status', { taskId: pendId }));
    t.ok('オフライン中の ply_task_status は、止める依頼がまだ届いていないと伝える（cancelPending）', pendStatus.json?.cancelPending === true && /desk-test/.test(pendStatus.json?.note ?? ''), pendStatus.text.slice(0, 200));
    await within((async () => { relay = createRelay({ enrollSecret: SECRET, trustProxy: false, logger: () => {} }); await relay.listen(relayPort, '127.0.0.1'); })(), 5000, '中継の立て直し（止める予定の試験）');
    await until(async () => (await hRows()).find(r => r.taskId === pendId)?.status === 'cancelled', 40_000, 'つなぎ直しで止める依頼が届く');
    t.ok('つなぎ直すと止める依頼がホストへ届き、止める予定が外れる', await until(async () => { const r = (await tRows()).find(x => x.taskId === pendId); return r && r.cancelPending === undefined && r.status === 'cancelled'; }, 30_000, '予定が外れる').then(() => true, () => false));

    // ---- 承認モードの引き上げ: 依頼元の会話が「聞かずに進む」で、ホストの委譲先が収まらないとき、依頼元の会話で 1 回だけ確かめる
    const markE = ct.mark();
    const escTurn = tool(null, 'ply_delegate', { host: 'desk-test', kind: 'mechanical', backend: 'fake', task: 'echo:ESC' }, { mode: 'auto' });
    const escCard = await ct.waitFor(e => e.type === 'permission' && /desk-test/.test(e.title ?? ''), { from: markE, ms: 30_000 });
    t.ok('引き上げが要るときは、依頼元の会話で 1 回だけ確かめる（見出しにホスト名・常に許可なし）', escCard.canAlways === false && escCard.toolName === 'ply_delegate' && !escCard.remote, JSON.stringify(escCard.title));
    await termCmd('resolvePermission', { id: escCard.id, allow: true });
    const escRes = toolResult(await escTurn);
    t.ok('許可すると同じ鍵で確定し、ホストに子が作られる（承認モードは依頼元に合わせた auto）', Boolean(escRes.json?.taskId) && (await hRows()).find(r => r.taskId === escRes.json.taskId)?.mode === 'auto', escRes.text.slice(0, 160));
    const markD = ct.mark();
    const denyTurn = tool(null, 'ply_delegate', { host: 'desk-test', kind: 'mechanical', backend: 'fake', task: 'echo:ESC2' }, { mode: 'auto' });
    const denyCard = await ct.waitFor(e => e.type === 'permission' && /desk-test/.test(e.title ?? ''), { from: markD, ms: 30_000 });
    await termCmd('resolvePermission', { id: denyCard.id, allow: false });
    const denied = toolResult(await denyTurn);
    t.ok('断ると委譲は失敗し、ホストに子は作られない', denied.isError === true && !(await hRows()).some(r => r.task === 'echo:ESC2'), denied.text.slice(0, 120));

    // ---- ホストが許可を切って入れ直す: 切っている間は任せられず、入れ直すと端末の線が開き直してまた使える
    await hostCmd('setRemoteDeviceAgent', { id: deviceId, enabled: false });
    const cut = await until(async () => { const r = toolResult(await tool(sid, 'ply_delegate', { host: 'desk-test', kind: 'mechanical', backend: 'fake', task: 'echo:CUT' })); return r.isError ? r : null; }, 20_000, '許可を切ったホストへは任せられない');
    t.ok('ホストが許可を切ると、端末の AI は任せられない（host の引数も出なくなる）', cut.isError === true);
    await hostCmd('setRemoteDeviceAgent', { id: deviceId, enabled: true });
    const back = await until(async () => { const r = toolResult(await tool(sid, 'ply_delegate', { host: 'desk-test', kind: 'mechanical', backend: 'fake', task: 'echo:BACK_AGAIN' })); return r.isError ? null : r; }, 40_000, '入れ直した後に任せられる');
    t.ok('ホストが許可を入れ直すと、端末の線が開き直してまた任せられる', /^ply-task-/.test(back.json?.taskId ?? ''), back.text.slice(0, 160));

    // ---- 取り消し: 任された作業は止まり、端末の写しはもう追えない
    const slow2 = toolResult(await tool(sid, 'ply_delegate', { host: 'desk-test', kind: 'mechanical', backend: 'fake', task: 'slow' })).json.taskId;
    await until(async () => (await tRows()).find(r => r.taskId === slow2 && r.status === 'running'), 20_000, '取り消し前の実行中');
    await hostCmd('remoteRevoke', { id: deviceId });
    await until(async () => (await hRows()).find(r => r.taskId === slow2)?.status === 'cancelled', 20_000, 'ホストで止まる');
    t.ok('端末を取り消すと、任された作業はホストで止まる', true);
    const lost = await until(async () => (await tRows()).find(r => r.taskId === slow2 && ['failed', 'cancelled'].includes(r.status)), 30_000, '端末の写しが止まる');
    t.ok('端末の写しは止まった状態になる（もう追えない）', Boolean(lost), JSON.stringify(lost && [lost.status, lost.error]));
  } catch (e) {
    // 待ちが尽きたとき、どちらのサーバーが何を言っていたかが分かるよう、直近の出力を添える
    t.note(`端末のサーバー:
${term?.tail(40) ?? '(未起動)'}
ホスト:
${host.tail(20)}`);
    throw e;
  } finally {
    ct?.close();
    ch.close();
    await within(term?.stop() ?? Promise.resolve(), 15_000, '端末のサーバーの停止').catch(e => t.note(e.message));
    await within(host.stop(), 15_000, 'ホストの停止').catch(e => t.note(e.message));
    await within(relay.close(), 5000, '中継の停止').catch(e => t.note(e.message));
    await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}

const hostChildOf = (rows, taskId) => rows?.find(r => r.taskId === taskId)?.sessionId ?? null;
