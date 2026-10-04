import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startServer, ROOT } from '../lib/server.mjs';
import { open, sleep } from '../lib/ws-client.mjs';

export const name = 'server-limit-resume';
export const title = '上限で中断し、解除の時刻（遠い先も・不明も・閉じている間に過ぎた分も）に自動で再開する。外した会話は人の「再開」で続く';

const HOUR = 3_600_000;

export default async function (t) {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-server-limit-'));
  const dataDir = path.join(scratch, 'data');
  const quotaFile = path.join(scratch, 'quota.json');
  const writeQuota = percent => fs.writeFile(quotaFile, JSON.stringify({ windows: [{ label: '5 時間', usedPercent: percent, resetsAt: null, minutes: 300 }] }));
  await writeQuota(100);
  const launch = () => startServer({ env: { AGENT_HOST_BACKENDS: 'fake', AGENT_HOST_FAKE_QUOTA: quotaFile }, dataDir });
  let server = await launch();
  t.ok('fake サーバーを起動', Number.isFinite(server.port), server.tail());
  let c = await open({ port: server.port, token: server.token });
  t.ok('fake サーバーに接続', Boolean(c.ready));
  const op = (name, args = {}) => c.cmd('invoke', { op: name, args });
  const until = async (fn, ms = 10_000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn().catch(() => false)) return true; await sleep(100); } return false; };
  const info = async id => (await c.cmd('listSessions')).find(s => s.id === id);
  const userTexts = async id => (await c.cmd('loadSession', { sessionId: id })).messages.filter(m => m.role === 'user').map(m => m.text);
  const newSession = async () => (await c.cmd('newSession', { backend: 'fake', cwd: ROOT })).sessionId;
  const restart = async () => { c.close(); await server.stop(); server = await launch(); c = await open({ port: server.port, token: server.token }); };
  const readRows = async () => JSON.parse(await fs.readFile(path.join(dataDir, 'schedule.json'), 'utf8')).entries;
  try {
    // ---- 1. 解除時刻に一度だけ自動で再開する。上限中に送った指示は送信待ちで、解除後に流れる
    const sessionId = await newSession();
    t.ok('会話を作成', Boolean(sessionId), sessionId);
    const resetsAt = Date.now() + 2300;
    const from = c.mark();
    const result = await c.runTurn({ sessionId, prompt: `limit ${resetsAt}` }, { ms: 3000 })
      .catch(err => { throw new Error(`${err.message}\n${JSON.stringify(c.since(from))}\n${server.tail()}`); });
    const end = c.since(from).find(e => e.type === 'turnEnd' && e.sessionId === sessionId);
    t.ok('上限は完了・失敗ではなく limited', result.outcome === 'limited' && end?.interrupted?.reason === 'limit', JSON.stringify(end));
    t.ok('解除時刻と枠が会話に残り、自動で再開する印が付く', end.interrupted.resetsAt === resetsAt && end.interrupted.window === 'five_hour' && end.interrupted.autoResume === true);
    t.ok('完了通知は出ない', !c.since(from).some(e => e.type === 'completionReady' && e.sessionId === sessionId));
    const plan = await op('sessions.schedules', { sessionId });
    t.ok('再開予定が schedule.json にある', plan.length === 1 && plan[0].kind === 'resume' && plan[0].at === resetsAt && !plan[0].poll);

    const id = 'limitqueued0001';
    await c.cmd('sendMessage', { sessionId, messageId: id, prompt: 'echo:after-reset' });
    let items = await c.cmd('listMessages', { sessionId });
    t.ok('解除前は API に渡さず limit で待つ', items.find(m => m.id === id)?.waiting?.reason === 'limit', JSON.stringify(items));
    await sleep(150);
    t.ok('解除前に新しい指示を流さない', !c.since(from).some(e => e.type === 'userMessage' && e.messageId === id));
    const again = await c.waitFor(e => e.type === 'turnEnd' && e.sessionId === sessionId && e.outcome === 'ok', { from, ms: 10000 });
    items = await c.cmd('listMessages', { sessionId });
    const messages = await userTexts(sessionId);
    t.ok('解除後に待っていた指示を一度だけ送る', again.interrupted === null && items.find(m => m.id === id)?.status === 'sent'
      && messages.filter(x => x === 'echo:after-reset').length === 1, JSON.stringify(messages));
    t.ok('最初の上限を出した指示は送り直さない', messages.filter(x => x === `limit ${resetsAt}`).length === 1);
    t.ok('再開の予定を消す', (await op('sessions.schedules', { sessionId })).length === 0);

    // ---- 2. 解除が 12 時間より先（週の上限など）でも予定を置き、会話は自動で再開する印のまま
    const weekly = await newSession();
    const farAt = Date.now() + 3 * 24 * HOUR;
    await c.runTurn({ sessionId: weekly, prompt: `limit ${farAt}` });
    const farRow = (await op('sessions.schedules', { sessionId: weekly }))[0];
    t.ok('12 時間より先の解除でも、その時刻に再開の予定を置く', farRow?.kind === 'resume' && farRow.at === farAt, JSON.stringify(farRow));
    t.ok('会話は自動で再開する印のまま（失敗として数えない）', (await info(weekly))?.interrupted?.autoResume === true && (await info(weekly)).interrupted.resetsAt === farAt);
    t.ok('終了の確認に再開の件数が載る', (await c.cmd('running')).scheduled.resume >= 1);

    // ---- 3. 会話ごとに自動を外す。解除の前は人の再開も断り、解除の後は待っていた指示が流れ、人の「再開」も効く
    const off = await newSession();
    await c.runTurn({ sessionId: off, prompt: `limit ${Date.now() + 2300}` });
    const setting = await op('sessions.setAutoResume', { sessionId: off, enabled: false });
    t.ok('会話ごとに自動再開を外せる', setting.enabled === false && !(await op('sessions.schedules', { sessionId: off })).length
      && (await info(off)).interrupted.autoResume === false);
    t.ok('解除の前は、外した会話でも人の再開は断られる', await op('sessions.resume', { sessionId: off }).then(() => false, e => /解除|reset/i.test(String(e.message))));
    const offFrom = c.mark();
    await c.cmd('sendMessage', { sessionId: off, messageId: 'offqueued00001', prompt: 'echo:after-release' });
    t.ok('外した会話の指示も解除までは送信待ち', (await c.cmd('listMessages', { sessionId: off })).find(m => m.id === 'offqueued00001')?.waiting?.reason === 'limit');
    t.ok('解除時刻を過ぎたら、待っていた指示が人の操作なしで送られる',
      await c.waitFor(e => e.type === 'turnEnd' && e.sessionId === off && e.outcome === 'ok', { from: offFrom, ms: 10000 }).then(() => true, () => false));
    t.ok('送ったのは待っていた指示で、続けての文は足されない', (await userTexts(off)).filter(x => x === 'echo:after-release').length === 1 && (await info(off)).interrupted === null);

    const manual = await newSession();
    await c.runTurn({ sessionId: manual, prompt: `limit ${Date.now() + 1800}` });
    await op('sessions.setAutoResume', { sessionId: manual, enabled: false });
    await sleep(2100);
    t.ok('自動を外した会話は解除の後も自分では動かない', (await info(manual)).interrupted?.reason === 'limit'
      && (await c.cmd('running')).turns.every(x => x.sessionId !== manual));
    const manualFrom = c.mark();
    const manualResult = await op('sessions.resume', { sessionId: manual });
    t.ok('解除の後は人の「再開」が効く', manualResult.sent === 'text');
    await c.waitFor(e => e.type === 'turnEnd' && e.sessionId === manual && e.outcome === 'ok', { from: manualFrom, ms: 10000 });
    t.ok('再開すると中断の印が消える', (await info(manual)).interrupted === null);
    t.ok('上限でない会話の切り替えは断る', await op('sessions.setAutoResume', { sessionId: manual, enabled: true }).then(() => false, () => true));

    // ---- 4. 解除時刻が分からない上限は、30 分ごとに使用量を確かめ、空いたら再開する
    const unknown = await newSession();
    await c.runTurn({ sessionId: unknown, prompt: 'limit unknown' });
    const stopped = (await info(unknown)).interrupted;
    const pollRow = (await op('sessions.schedules', { sessionId: unknown }))[0];
    t.ok('解除時刻が分からなくても自動で再開する印が付く', stopped.resetsAt === null && stopped.autoResume === true);
    t.ok('確かめ直しの予定は 30 分後に置かれる', pollRow?.poll === true && pollRow.at - Date.now() > 29 * 60_000 && pollRow.at - Date.now() <= 30 * 60_000, JSON.stringify(pollRow));
    await c.cmd('sendMessage', { sessionId: unknown, messageId: 'unknownq000001', prompt: 'echo:after-poll' });
    t.ok('解除時刻が分からない間（確認中）も、送った指示は送信待ち',
      (await c.cmd('listMessages', { sessionId: unknown })).find(m => m.id === 'unknownq000001')?.waiting?.reason === 'limit');
    // 30 分が過ぎたことにして（Pleiad を閉じている間に過ぎたのと同じ）、まだ上限なら次の確認へ
    const due = async () => { const rows = await readRows(); await fs.writeFile(path.join(dataDir, 'schedule.json'),
      JSON.stringify({ version: 1, entries: rows.map(r => ({ ...r, at: Date.now() - 1000, retryAt: undefined })) })); };
    c.close(); await server.stop(); await due();
    server = await launch(); c = await open({ port: server.port, token: server.token });
    await sleep(800);
    const still = (await op('sessions.schedules', { sessionId: unknown }))[0];
    t.ok('まだ上限（100%）なら再開せず、次の確認を 30 分後に置く', (await info(unknown)).interrupted?.reason === 'limit'
      && still?.poll === true && still.at - Date.now() > 29 * 60_000, JSON.stringify(still));
    await writeQuota(30);
    c.close(); await server.stop(); await due();
    server = await launch(); c = await open({ port: server.port, token: server.token });
    t.ok('枠が空いたら再開し、待っていた指示を送る', await until(async () => (await info(unknown)).interrupted === null && (await userTexts(unknown)).includes('echo:after-poll')),
      JSON.stringify(await userTexts(unknown)));
    t.ok('再開したら予定は消える', !(await op('sessions.schedules', { sessionId: unknown })).length);
    await writeQuota(100);

    // ---- 5. 閉じている間に解除時刻が過ぎた会話は、予定の行が無くても起動時に再開する
    const away = await newSession();
    await c.runTurn({ sessionId: away, prompt: `limit ${Date.now() + 1200}` });
    c.close(); await server.stop();
    await fs.rm(path.join(dataDir, 'schedule.json'), { force: true });
    await sleep(1500);
    server = await launch(); c = await open({ port: server.port, token: server.token });
    t.ok('起動時に、解除時刻を過ぎた上限の会話を再開する（schedule.json の行が無くても）',
      await until(async () => (await info(away)).interrupted === null && (await userTexts(away)).length === 2), JSON.stringify(await userTexts(away)));
    t.ok('起動時の再開も続けての文を一度だけ送る', (await userTexts(away)).filter(x => !x.startsWith('limit ')).length === 1);
  } finally {
    c.close(); await server.stop();
    if (path.resolve(scratch).startsWith(path.resolve(os.tmpdir()) + path.sep)) await fs.rm(scratch, { recursive: true, force: true });
  }
}
