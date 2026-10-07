import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startServer, ROOT } from '../lib/server.mjs';
import { open, sleep } from '../lib/ws-client.mjs';
import { readSessions, writeSessions } from '../lib/data-store.mjs';

export const name = 'server-limit-resume';
export const title = '上限で中断しても自動では再開しない。上限中に送った指示は解除時刻に流れ（解除時刻が分からなければすぐ送る）、人の「再開」は解除の後に効く。古い自動再開の予定と印は読まない';

const HOUR = 3_600_000;

export default async function (t) {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-server-limit-'));
  const dataDir = path.join(scratch, 'data');
  const launch = () => startServer({ env: { AGENT_HOST_BACKENDS: 'fake' }, dataDir });
  let server = await launch();
  t.ok('fake サーバーを起動', Number.isFinite(server.port), server.tail());
  let c = await open({ port: server.port, token: server.token, autoAllow: true });
  t.ok('fake サーバーに接続', Boolean(c.ready));
  const op = (name, args = {}) => c.cmd('invoke', { op: name, args });
  const info = async id => (await c.cmd('listSessions')).find(s => s.id === id);
  const userTexts = async id => (await c.cmd('loadSession', { sessionId: id })).messages.filter(m => m.role === 'user').map(m => m.text);
  const newSession = async () => (await c.cmd('newSession', { backend: 'fake', cwd: ROOT })).sessionId;
  const idle = async id => (await c.cmd('running')).turns.every(x => x.sessionId !== id);
  try {
    // ---- 1. 上限で止まった会話は、予定を置かない。上限中に送った指示は送信待ちで、解除時刻に一度だけ流れる
    const sessionId = await newSession();
    t.ok('会話を作成', Boolean(sessionId), sessionId);
    const resetsAt = Date.now() + 2300;
    const from = c.mark();
    const result = await c.runTurn({ sessionId, prompt: `limit ${resetsAt}` }, { ms: 3000 })
      .catch(err => { throw new Error(`${err.message}\n${JSON.stringify(c.since(from))}\n${server.tail()}`); });
    const end = c.since(from).find(e => e.type === 'turnEnd' && e.sessionId === sessionId);
    t.ok('上限は完了・失敗ではなく limited', result.outcome === 'limited' && end?.interrupted?.reason === 'limit', JSON.stringify(end));
    t.ok('解除時刻と枠が会話に残り、自動再開の印は付かない', end.interrupted.resetsAt === resetsAt && end.interrupted.window === 'five_hour' && !('autoResume' in end.interrupted));
    t.ok('完了通知は出ない', !c.since(from).some(e => e.type === 'completionReady' && e.sessionId === sessionId));
    t.ok('再開の予定を置かない', (await op('sessions.schedules', { sessionId })).length === 0);
    t.ok('上限の会話の自動再開の切り替え（sessions.setAutoResume）は無い', await op('sessions.setAutoResume', { sessionId, enabled: false }).then(() => false, () => true));
    t.ok('解除の前は、人の再開は断られる', await op('sessions.resume', { sessionId }).then(() => false, e => /解除|reset/i.test(String(e.message))));

    const id = 'limitqueued0001';
    await c.cmd('sendMessage', { sessionId, messageId: id, prompt: 'echo:after-reset' });
    let items = await c.cmd('listMessages', { sessionId });
    t.ok('解除前は API に渡さず limit で待つ', items.find(m => m.id === id)?.waiting?.reason === 'limit', JSON.stringify(items));
    await sleep(150);
    t.ok('解除前に新しい指示を流さない', !c.since(from).some(e => e.type === 'userMessage' && e.messageId === id));
    const again = await c.waitFor(e => e.type === 'turnEnd' && e.sessionId === sessionId && e.outcome === 'ok', { from, ms: 10000 });
    items = await c.cmd('listMessages', { sessionId });
    const messages = await userTexts(sessionId);
    t.ok('解除時刻に、待っていた指示を一度だけ送る', again.interrupted === null && items.find(m => m.id === id)?.status === 'sent'
      && messages.filter(x => x === 'echo:after-reset').length === 1, JSON.stringify(messages));
    t.ok('最初の上限を出した指示は送り直さず、続けての文も足さない', messages.length === 2 && messages.filter(x => x === `limit ${resetsAt}`).length === 1, JSON.stringify(messages));

    // ---- 2. 何も送っていない会話は、解除時刻を過ぎても自分では動かない。解除の後は人の「再開」で続く
    const manual = await newSession();
    await c.runTurn({ sessionId: manual, prompt: `limit ${Date.now() + 1500}` });
    await sleep(2300);
    t.ok('解除時刻を過ぎても自動では再開しない', (await info(manual)).interrupted?.reason === 'limit' && await idle(manual)
      && (await userTexts(manual)).length === 1);
    const manualFrom = c.mark();
    const manualResult = await op('sessions.resume', { sessionId: manual });
    t.ok('解除の後は人の「再開」が効く', manualResult.sent === 'text');
    await c.waitFor(e => e.type === 'turnEnd' && e.sessionId === manual && e.outcome === 'ok', { from: manualFrom, ms: 10000 });
    t.ok('再開すると中断の印が消える', (await info(manual)).interrupted === null);

    // ---- 3. 解除が遠い先（週の上限など）でも予定は置かず、終了の確認に再開の件数は無い
    const weekly = await newSession();
    const farAt = Date.now() + 3 * 24 * HOUR;
    await c.runTurn({ sessionId: weekly, prompt: `limit ${farAt}` });
    t.ok('遠い先の解除時刻も会話に残す', (await info(weekly)).interrupted?.resetsAt === farAt);
    t.ok('遠い先の解除でも予定を置かない', (await op('sessions.schedules', { sessionId: weekly })).length === 0);
    t.ok('終了の確認に再開の件数を載せない', !('resume' in (await c.cmd('running')).scheduled));

    // ---- 4. 解除時刻が分からない上限は待たせない。送った指示はすぐ送られ、人の「再開」も断らない
    const unknown = await newSession();
    await c.runTurn({ sessionId: unknown, prompt: 'limit unknown' });
    const stopped = (await info(unknown)).interrupted;
    t.ok('解除時刻が分からない上限も中断として残る（予定は置かない）', stopped?.reason === 'limit' && stopped.resetsAt === null
      && (await op('sessions.schedules', { sessionId: unknown })).length === 0);
    const unknownFrom = c.mark();
    await c.cmd('sendMessage', { sessionId: unknown, messageId: 'unknownq000001', prompt: 'echo:right-away' });
    t.ok('解除時刻が分からない上限の会話に送った指示は、待たずにすぐ送られる',
      await c.waitFor(e => e.type === 'turnEnd' && e.sessionId === unknown && e.outcome === 'ok', { from: unknownFrom, ms: 10000 }).then(() => true, () => false)
      && (await userTexts(unknown)).includes('echo:right-away'));
    const unknownAgain = await newSession();
    await c.runTurn({ sessionId: unknownAgain, prompt: 'limit unknown' });
    t.ok('解除時刻が分からない上限は、人の「再開」を断らない', (await op('sessions.resume', { sessionId: unknownAgain })).sent === 'text');

    // ---- 5. アカウントを替えて送ると、止まった枠の待ちは解ける（解除時刻まで待たない）
    const switched = await newSession();
    await c.runTurn({ sessionId: switched, prompt: `limit ${Date.now() + 3 * HOUR}` });
    const account = await c.cmd('saveClaudeAccount', { name: '別のアカウント', token: 'sk-ant-oat01-' + 'Y'.repeat(48) });
    await c.cmd('sendMessage', { sessionId: switched, messageId: 'switchedq00001', prompt: 'echo:before-switch' });
    t.ok('替える前は、解除時刻まで送信待ち', (await c.cmd('listMessages', { sessionId: switched })).find(m => m.id === 'switchedq00001')?.waiting?.reason === 'limit');
    const switchedFrom = c.mark();
    await c.cmd('setTurnSettings', { sessionId: switched, account: account.id });
    t.ok('アカウントを替えると、待っていた指示がすぐ送られる', await c.waitFor(e => e.type === 'turnEnd' && e.sessionId === switched && e.outcome === 'ok', { from: switchedFrom, ms: 10000 }).then(() => true, () => false));
    t.ok('替えた会話は、解除時刻まで待たずに続く（印は消える）', (await info(switched)).interrupted === null);
    const switchedAgain = await newSession();
    await c.runTurn({ sessionId: switchedAgain, prompt: `limit ${Date.now() + 3 * HOUR}` });
    // 新しい会話の既定のアカウントは、さっき選んだ別のアカウント。ログイン中のアカウント（''）へ替える
    await c.cmd('setTurnSettings', { sessionId: switchedAgain, account: '' });
    t.ok('替えた会話の中断の印は残る', (await info(switchedAgain)).interrupted?.reason === 'limit');
    t.ok('替えた後は、解除時刻の前でも人の「再開」が通る', (await op('sessions.resume', { sessionId: switchedAgain })).sent === 'text');

    // ---- 6. 古いデータ: 保存済みの自動再開の予定（kind: resume）と会話の印は読まない。送信予定は残る
    const legacy = await newSession();
    await c.runTurn({ sessionId: legacy, prompt: `limit ${Date.now() + 1000}` });
    const sendRow = { id: 'send:legacy-keep', kind: 'send', sessionId: legacy, at: Date.now() + 24 * HOUR, createdAt: Date.now(), by: 'human',
      messageId: 'legacysend0001', prompt: 'echo:scheduled' };
    c.close(); await server.stop();
    const sessions = readSessions(dataDir);
    sessions[legacy] = { ...sessions[legacy], interrupted: { ...sessions[legacy].interrupted, autoResume: true }, autoResumeOff: false };
    writeSessions(dataDir, sessions);
    const stoppedAt = sessions[legacy].interrupted.at;
    await fs.writeFile(path.join(dataDir, 'schedule.json'), JSON.stringify({ version: 1, entries: [
      { id: `resume:${legacy}`, kind: 'resume', sessionId: legacy, at: Date.now() - 1000, createdAt: stoppedAt, by: 'limit', account: '' },
      { id: `resume:${unknown}`, kind: 'resume', sessionId: unknown, at: Date.now() - 1000, createdAt: 1, by: 'limit', poll: true },
      sendRow,
    ] }));
    await sleep(1200);
    server = await launch(); c = await open({ port: server.port, token: server.token, autoAllow: true });
    await sleep(1500);
    const rows = await op('sessions.schedules');
    t.ok('古い kind: resume の予定は読まず、送信予定は残る', rows.length === 1 && rows[0].id === sendRow.id, JSON.stringify(rows));
    const legacyInfo = await info(legacy);
    t.ok('古い自動再開の印は読まず、解除時刻を過ぎても会話は動かない', legacyInfo.interrupted?.reason === 'limit' && !('autoResume' in legacyInfo.interrupted)
      && await idle(legacy) && (await userTexts(legacy)).length === 1, JSON.stringify(legacyInfo.interrupted));
    t.ok('古い印の残った会話も、人の「再開」で続く', (await op('sessions.resume', { sessionId: legacy })).sent === 'text');
  } finally {
    c.close(); await server.stop();
    if (path.resolve(scratch).startsWith(path.resolve(os.tmpdir()) + path.sep)) await fs.rm(scratch, { recursive: true, force: true });
  }
}
