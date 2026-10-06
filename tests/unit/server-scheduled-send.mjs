import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startServer, ROOT } from '../lib/server.mjs';
import { open, sleep } from '../lib/ws-client.mjs';

export const name = 'server-scheduled-send';
export const title = '送信予定: 時刻に送信待ちへ入る・編集と今すぐ送る・取り消し・再起動で戻る・遅れの扱い・上限との組み合わせ';

const HOUR = 3_600_000;

export default async function (t) {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-server-send-'));
  const dataDir = path.join(scratch, 'data');
  let server = await startServer({ env: { AGENT_HOST_BACKENDS: 'fake' }, dataDir });
  let c = await open({ port: server.port, token: server.token });
  const op = (name, args = {}) => c.cmd('invoke', { op: name, args });
  const until = async (check, ms = 12000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await check()) return true; await sleep(150); } return false; };
  const userTexts = async (sessionId) => (await c.cmd('loadSession', { sessionId })).messages.filter(m => m.role === 'user').map(m => m.text);
  try {
    t.ok('fake サーバーを起動', Number.isFinite(server.port), server.tail());
    const { sessionId } = await c.cmd('newSession', { backend: 'fake', cwd: ROOT });

    // ---- 時刻が来たら、ふつうの送信と同じ送信待ちへ入って送られる
    const from = c.mark();
    const at = Date.now() + 1800;
    const placed = await op('sessions.scheduleSend', { sessionId, prompt: 'echo:scheduled-one', at, messageId: 'sched-00000001' });
    t.ok('予定を置くと id・時刻・messageId が返る', placed.id === 'send:sched-00000001' && placed.at === at && placed.messageId === 'sched-00000001', JSON.stringify(placed));
    let plans = await op('sessions.schedules', { sessionId });
    t.ok('予定は schedule.json の一覧にある（本文つき）', plans.length === 1 && plans[0].kind === 'send' && plans[0].args.prompt === 'echo:scheduled-one');
    t.ok('送信待ちの順番を塞がない（outbox には入らない）', (await c.cmd('listMessages', { sessionId })).length === 0);
    const again = await op('sessions.scheduleSend', { sessionId, prompt: 'echo:scheduled-one', at, messageId: 'sched-00000001' });
    t.ok('同じ指定の置き直しは 1 件のまま', again.id === placed.id && (await op('sessions.schedules', { sessionId })).length === 1);
    let conflict = null;
    await op('sessions.scheduleSend', { sessionId, prompt: 'echo:other', at, messageId: 'sched-00000001' }).catch(e => { conflict = e; });
    t.ok('同じ messageId で内容を変えた置き直しは断る', Boolean(conflict));
    await sleep(500);
    t.ok('時刻の前は送らない', !c.since(from).some(e => e.type === 'userMessage' && e.messageId === 'sched-00000001'));
    const sent = await c.waitFor(e => e.type === 'turnEnd' && e.sessionId === sessionId && e.outcome === 'ok', { from, ms: 10000 });
    t.ok('時刻が来ると送られて作業が終わる', sent.outcome === 'ok');
    const event = c.since(from).find(e => e.type === 'userMessage' && e.messageId === 'sched-00000001');
    t.ok('送った発言の知らせに予定の時刻が添う', event?.scheduledFor === at, JSON.stringify(event));
    t.ok('送った後は予定が消える', (await op('sessions.schedules', { sessionId })).length === 0);
    const loaded = (await c.cmd('loadSession', { sessionId })).messages.find(m => m.role === 'user' && m.text === 'echo:scheduled-one');
    t.ok('開き直した履歴の発言にも予定の時刻が付く', loaded?.scheduledFor === at, JSON.stringify(loaded));

    // ---- 入れられない指定
    const fail = async (args) => { try { await op('sessions.scheduleSend', { sessionId, ...args }); return false; } catch { return true; } };
    t.ok('過ぎた時刻・すぐの時刻・読めない時刻・空の本文は断る', await fail({ prompt: 'x', at: Date.now() - 1000 }) && await fail({ prompt: 'x', at: Date.now() + 500 })
      && await fail({ prompt: 'x', at: 'あした' }) && await fail({ prompt: '   ', at: Date.now() + HOUR }));
    t.ok('1 年より先は断る', await fail({ prompt: 'x', at: Date.now() + 400 * 24 * HOUR }));
    t.ok('無い会話は断る', await op('sessions.scheduleSend', { sessionId: 'nope', prompt: 'x', at: Date.now() + HOUR }).then(() => false, () => true));

    // ---- 取り消す・編集（取り出して本文を返す）・今すぐ送る
    const far = Date.now() + 2 * HOUR;
    const p1 = await op('sessions.scheduleSend', { sessionId, prompt: 'echo:to-cancel', at: far });
    const cancelled = await op('sessions.cancelSchedule', { id: p1.id });
    t.ok('取り消すと予定が消え、取り出した行（本文と時刻）が返る', cancelled.cancelled && cancelled.entry?.args.prompt === 'echo:to-cancel' && cancelled.entry.at === far
      && (await op('sessions.schedules', { sessionId })).length === 0);
    t.ok('取り消した予定をもう一度取り消しても何も起きない', (await op('sessions.cancelSchedule', { id: p1.id })).cancelled === false);

    const p2 = await op('sessions.scheduleSend', { sessionId, prompt: 'echo:now-please', at: far });
    const nowFrom = c.mark();
    const nowResult = await op('sessions.sendScheduledNow', { id: p2.id });
    t.ok('今すぐ送ると予定が消えて送られる', nowResult.sent && (await op('sessions.schedules', { sessionId })).length === 0);
    await c.waitFor(e => e.type === 'turnEnd' && e.sessionId === sessionId && e.outcome === 'ok', { from: nowFrom, ms: 10000 });
    t.ok('今すぐ送った発言が一度だけ会話に入る', (await userTexts(sessionId)).filter(x => x === 'echo:now-please').length === 1);
    t.ok('もう一度「今すぐ送る」は断る（二重に送らない）', await op('sessions.sendScheduledNow', { id: p2.id }).then(() => false, () => true));

    // ---- 走っている会話に時刻が来たら、ふつうの送信待ちで終わるのを待つ
    const busyFrom = c.mark();
    c.cmd('runTurn', { sessionId, prompt: 'slow' }).catch(() => {});
    await c.waitFor(e => e.type === 'running' && e.turns?.some(x => x.sessionId === sessionId), { from: busyFrom, ms: 5000 }).catch(() => null);
    await op('sessions.scheduleSend', { sessionId, prompt: 'echo:after-slow', at: Date.now() + 1500, messageId: 'sched-00000002' });
    await sleep(2200);
    const waiting = (await c.cmd('listMessages', { sessionId })).find(m => m.id === 'sched-00000002');
    t.ok('走っている会話では「作業が終わると自動で送信」で待つ', waiting?.status === 'queued' && waiting.waiting?.reason === 'turn', JSON.stringify(waiting));
    await c.cmd('abort', { sessionId }).catch(() => {});
    t.ok('中断した会話の送信待ちは保留になり、勝手に送らない（ADR 0036）', await until(async () => (await c.cmd('listMessages', { sessionId })).find(m => m.id === 'sched-00000002')?.status === 'paused'));
    await until(async () => !(await c.cmd('running')).turns.some(x => x.sessionId === sessionId));
    await c.cmd('resume', { sessionId });
    t.ok('再開すると予定だった発言が送られる', await until(async () => (await c.cmd('listMessages', { sessionId })).find(m => m.id === 'sched-00000002')?.status === 'sent'));

    // ---- 上限で止まっている会話に時刻が来たら、解除まで待つ（API に流さない）
    const limited = (await c.cmd('newSession', { backend: 'fake', cwd: ROOT })).sessionId;
    const resetsAt = Date.now() + 4200;
    await c.runTurn({ sessionId: limited, prompt: `limit ${resetsAt}` }, { ms: 3000 });
    const limitFrom = c.mark();
    await op('sessions.scheduleSend', { sessionId: limited, prompt: 'echo:after-limit', at: Date.now() + 1200, messageId: 'sched-00000003' });
    await sleep(1900);
    const held = (await c.cmd('listMessages', { sessionId: limited })).find(m => m.id === 'sched-00000003');
    t.ok('上限中の会話では、時刻が来ても解除まで送信待ちで待つ', held?.waiting?.reason === 'limit' && !c.since(limitFrom).some(e => e.type === 'userMessage' && e.messageId === 'sched-00000003'), JSON.stringify(held));
    await c.waitFor(e => e.type === 'turnEnd' && e.sessionId === limited && e.outcome === 'ok', { from: limitFrom, ms: 15000 });
    t.ok('解除の後に一度だけ送られる', (await userTexts(limited)).filter(x => x === 'echo:after-limit').length === 1);

    // ---- 再起動: 予定は戻り、1 時間以内の遅れなら送る・それより遅れたら送らずに確かめる
    const idle = (await c.cmd('newSession', { backend: 'fake', cwd: ROOT })).sessionId;
    c.close(); await server.stop();
    const nowMs = Date.now();
    await fs.writeFile(path.join(dataDir, 'schedule.json'), JSON.stringify({ version: 1, entries: [
      { id: 'send:late-0000001', kind: 'send', sessionId: idle, messageId: 'late-0000001', at: nowMs - 10 * 60_000, createdAt: nowMs - 3 * HOUR, by: 'human', args: { prompt: 'echo:ten-minutes-late' } },
      { id: 'send:miss-0000001', kind: 'send', sessionId: idle, messageId: 'miss-0000001', at: nowMs - 2 * HOUR, createdAt: nowMs - 3 * HOUR, by: 'human', args: { prompt: 'echo:two-hours-late' } },
      { id: 'send:ahead-000001', kind: 'send', sessionId: idle, messageId: 'ahead-000001', at: nowMs + 3 * HOUR, createdAt: nowMs - HOUR, by: 'human', args: { prompt: 'echo:still-ahead' } },
    ] }, null, 2));
    server = await startServer({ env: { AGENT_HOST_BACKENDS: 'fake' }, dataDir });
    c = await open({ port: server.port, token: server.token });
    await sleep(600);
    const restored = await op('sessions.schedules', { sessionId: idle });
    const byId = Object.fromEntries(restored.map(r => [r.id, r]));
    t.ok('再起動した後も未来の予定は残る', byId['send:ahead-000001']?.at === nowMs + 3 * HOUR && !byId['send:ahead-000001'].held);
    t.ok('1 時間より遅れた予定は送らず、確かめを待つ印が付く', byId['send:miss-0000001']?.held === 'missed' && !(await userTexts(idle)).includes('echo:two-hours-late'));
    t.ok('1 時間以内の遅れなら送る', await until(async () => (await userTexts(idle)).includes('echo:ten-minutes-late')), JSON.stringify(await userTexts(idle)));
    const late = (await c.cmd('loadSession', { sessionId: idle })).messages.find(m => m.role === 'user' && m.text === 'echo:ten-minutes-late');
    t.ok('遅れて送った発言には予定の時刻が付く（画面が「予定を 〜 に送りました」を出す）', late?.scheduledFor === nowMs - 10 * 60_000, JSON.stringify(late));
    t.ok('送った予定は一覧から消え、過ぎた予定と未来の予定が残る', !(await op('sessions.schedules', { sessionId: idle })).some(r => r.id === 'send:late-0000001')
      && (await op('sessions.schedules', { sessionId: idle })).length === 2);
    await until(async () => !(await c.cmd('running')).turns.some(x => x.sessionId === idle));
    await op('sessions.sendScheduledNow', { id: 'send:miss-0000001' });
    t.ok('確かめを待つ予定は「今すぐ送る」で送れる', await until(async () => (await userTexts(idle)).includes('echo:two-hours-late')));
    t.ok('送る中身のある会話は未送信として消せない（予定のある会話を消さない）', await c.cmd('deleteUnsentSession', { sessionId: idle }).then(() => false, () => true));
    const sleeper = (await c.cmd('newSession', { backend: 'fake', cwd: ROOT })).sessionId;
    await op('sessions.scheduleSend', { sessionId: sleeper, prompt: 'echo:later', at: Date.now() + 5 * HOUR });
    t.ok('予定のある未送信の会話は消せない', await c.cmd('deleteUnsentSession', { sessionId: sleeper }).then(() => false, () => true));
    const running = await c.cmd('running');
    t.ok('終了の確認に送信予定の件数と次の時刻が載る', running.scheduled.send === 2 && Number.isFinite(running.scheduled.nextSendAt) && running.scheduled.held === 0, JSON.stringify(running.scheduled));

    // ---- スレッドへの返信の予定（channels.schedulePost。kind 'post'。ADR 0157）と、clientId で二重に投稿しない
    const ch = await op('channels.create', { name: 'sched-post' });
    const root = await op('channels.post', { channelId: ch.id, text: '根' });
    const once = await op('channels.post', { channelId: ch.id, threadId: root.id, text: '一度だけ', clientId: 'client-0000001' });
    const twice = await op('channels.post', { channelId: ch.id, threadId: root.id, text: '一度だけ', clientId: 'client-0000001' });
    const replies = async () => (await op('channels.read', { channelId: ch.id, threadId: root.id })).posts.filter((p) => p.threadId === root.id);
    t.ok('同じ clientId の投稿は 2 つ目を作らず、最初の投稿を返す', once.id === twice.id && (await replies()).length === 1);
    const postAt = Date.now() + 1500;
    const placedPost = await op('channels.schedulePost', { channelId: ch.id, threadId: root.id, text: 'あとで送る返信', at: postAt, clientId: 'client-0000002' });
    t.ok('返信の予定を置くと id と時刻が返り、予定の一覧に kind post で載る', placedPost.id === 'post:client-0000002'
      && (await op('sessions.schedules', {})).some((r) => r.kind === 'post' && r.threadId === root.id && r.args.prompt === 'あとで送る返信'));
    t.ok('時刻の前は投稿しない', (await replies()).length === 1);
    t.ok('時刻が来ると人の投稿として 1 回だけ投稿される', await until(async () => (await replies()).some((p) => p.text === 'あとで送る返信' && p.author.kind === 'human' && p.clientId === 'client-0000002')));
    t.ok('投稿したら予定の一覧から消える', !(await op('sessions.schedules', {})).some((r) => r.id === 'post:client-0000002'));
    await op('channels.schedulePost', { channelId: ch.id, threadId: root.id, text: '取り消す返信', at: Date.now() + 5 * HOUR, clientId: 'client-0000003' });
    const takenPost = await op('sessions.cancelSchedule', { id: 'post:client-0000003' });
    t.ok('返信の予定も取り消すと取り出して返す（入力欄へ戻せる）', takenPost.cancelled && takenPost.entry?.args.prompt === '取り消す返信');
    await op('channels.schedulePost', { channelId: ch.id, threadId: root.id, text: '今すぐの返信', at: Date.now() + 5 * HOUR, clientId: 'client-0000004' });
    await op('sessions.sendScheduledNow', { id: 'post:client-0000004' });
    t.ok('返信の予定も「今すぐ送る」で投稿できる', (await replies()).some((p) => p.text === '今すぐの返信'));
  } finally {
    c.close(); await server.stop();
    if (path.resolve(scratch).startsWith(path.resolve(os.tmpdir()) + path.sep)) await fs.rm(scratch, { recursive: true, force: true });
  }
}
