// bot の会話は Chats の一覧に出さず、あなた待ち（承認・質問）のときだけ出す（ADR 0109、docs/channels.md）。
// 一覧に出さない判定の材料（一覧の行の bot・承認待ち）と、検索の除外（includeDelegated で含める）、スマホ通知（完了は送らず、失敗・承認は送る）を、
// fake バックエンドのサーバー → 中継 → 端末の代わりの Node のクライアントで通す。LLM もネットワークも使わない。
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import WebSocket from 'ws';
import { createRelay } from '../../relay/server.mjs';
import { startServer, ROOT } from '../lib/server.mjs';
import { open, sleep } from '../lib/ws-client.mjs';
import { createRemoteDevice } from '../../core/remote/device.mjs';
import { openNotice } from '../../core/notify/crypto.mjs';
import { passesFilters } from '../../core/session-search.mjs';

export const name = 'bot-sessions-list';
export const title = 'bot の会話: 一覧の行に bot・あなた待ちは承認待ちに載る・検索は既定で除く・スマホ通知は完了を送らず失敗と承認は送る';

const SECRET = crypto.randomBytes(32).toString('base64url');
const until = async (fn, { ms = 20_000, label = '' } = {}) => {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) { last = await fn(); if (last) return last; await sleep(40); }
  throw new Error(`timeout: ${label} ${JSON.stringify(last ?? null)?.slice(0, 400)}`);
};

/** 端末の通知の線（server-push-notify.mjs と同じ作り）。届いた暗号文を鍵で開いて貯める */
function noticeLine({ relayPort, creds, key }) {
  const ids = { hostId: creds.hostId, deviceId: creds.deviceId };
  const ws = new WebSocket(`ws://127.0.0.1:${relayPort}/v1/device/notify`, {
    headers: { authorization: `Bearer ${creds.token}`, 'x-pleiad-host': creds.hostId, 'x-pleiad-device': creds.deviceId }, perMessageDeflate: false,
  });
  const got = [];
  ws.on('error', () => {});
  ws.on('message', (data) => {
    let m; try { m = JSON.parse(data.toString('utf8')); } catch { return; }
    if (m.type !== 'notify') return;
    const notice = openNotice(key, ids, m.blob);
    ws.send(JSON.stringify({ type: 'ack', i: m.i }));
    if (notice) got.push(notice);
  });
  return { got, opened: new Promise((res) => { ws.once('open', () => res(true)); ws.once('error', () => res(false)); }), close() { try { ws.terminate(); } catch { /* 済み */ } } };
}

export default async function (t) {
  // ---- 検索の絞り込みの純粋な部分
  const row = { id: 's', backend: 'fake', cwd: null, lastModified: 1 };
  const f = { includeDelegated: false };
  t.ok('検索: 委譲の子と bot の会話は既定で除き、includeDelegated で含める',
    passesFilters(row, f) && !passesFilters({ ...row, delegation: { parentSessionId: 'p' } }, f) && !passesFilters({ ...row, bot: { botId: 'b_x', kind: 'thread' } }, f)
    && passesFilters({ ...row, bot: { botId: 'b_x', kind: 'dm' } }, { includeDelegated: true }));

  const scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'bot-sessions-list-')));
  const relay = createRelay({ enrollSecret: SECRET, trustProxy: false, logger: () => {} });
  const relayPort = (await relay.listen(0, '127.0.0.1')).port;
  const server = await startServer({ env: { AGENT_HOST_BACKENDS: 'fake', AGENT_HOST_NOTIFY_MIN_TURN_MS: '0' }, dataDir: path.join(scratch, 'data'), timeoutMs: 30_000 });
  const host = await open({ port: server.port, token: server.token });
  const device = createRemoteDevice({ dir: path.join(scratch, 'device'), app: 'test', name: 'Pixel Test', platform: 'android',
    proxyOptions: { backoff: { minMs: 200, maxMs: 1000, stableMs: 1000 }, connectTimeoutMs: 5000, requestWaitMs: 5000 } });
  let phone = null, c = null;
  try {
    const call = (op, args) => host.cmd('invoke', { op, args });
    // ---- スマホ（端末の代わり）を登録して通知の線を張る
    let from = host.mark();
    await host.cmd('setRemoteSettings', { relayUrl: `http://127.0.0.1:${relayPort}`, enrollSecret: SECRET, enabled: true, hostName: 'bot-host' });
    await host.waitFor((e) => e.type === 'remoteStatus' && e.status.connection.state === 'connected', { from, ms: 10_000 });
    const offer = await host.cmd('remotePairingStart');
    from = host.mark();
    const pairing = device.pair(offer.payload);
    pairing.catch(() => {});
    const req = await host.waitFor((e) => e.type === 'remotePairing' && e.phase === 'request', { from, ms: 10_000 });
    await host.cmd('remotePairingApprove', { id: req.request.id });
    const { hostId } = await pairing;
    const proxy = await device.open(hostId);
    await new Promise((resolve) => {
      const on = (s) => { if (s.hostId === hostId && s.state === 'connected') { device.off('status', on); resolve(); } };
      device.on('status', on);
      device.proxy(hostId).then((px) => { if (px?.status.state === 'connected') { device.off('status', on); resolve(); } });
    });
    c = await open({ port: proxy.port, token: proxy.token });
    const creds = await device.store.credentials(hostId);
    const key = crypto.randomBytes(32);
    await c.cmd('notifyRegister', { key: key.toString('base64url'), settings: { enabled: true, reply: true, failed: true, done: true, lockNames: false, skipPc: true } });
    phone = noticeLine({ relayPort, creds, key });
    t.ok('端末の通知の線がつながる', await phone.opened);
    await sleep(100);

    // ---- bot とチャンネル
    const owl = await call('bots.create', { name: 'Owl', icon: '🦉', backend: 'fake' });
    const dev = await call('channels.create', { name: 'dev' });
    const read = (channelId, threadId) => call('channels.read', { channelId, ...(threadId ? { threadId } : {}) });
    const botPost = (r, state) => r.posts.filter((p) => p.turn?.botId === owl.id && (!state || p.state === state));
    const plain = (await host.runTurn({ prompt: 'echo:普通の会話', sessionId: null, cwd: ROOT, backend: 'fake', mode: 'default' }, { ms: 20_000 })).sessionId;

    // ---- 完了: 返事を出すだけでは、スマホへ done を送らない（スレッドで見える）。普通の会話は送る
    const root1 = await call('channels.post', { channelId: dev.id, text: '@Owl echo:zzmarker 終わり' });
    await until(async () => botPost(await read(dev.id, root1.id), 'done').length === 1, { label: '完了' });
    const th1 = (await read(dev.id, root1.id)).threads[0];
    const botSession = th1.sessions[owl.id];
    await sleep(600);
    t.ok('bot の会話の done はスマホへ送らない（スレッドで見える）', !phone.got.some((n) => n.session === botSession), JSON.stringify(phone.got.map((n) => [n.kind, n.session])));
    const plainRun = await host.runTurn({ prompt: 'echo:もう 1 回', sessionId: plain, cwd: ROOT, backend: 'fake', mode: 'default' }, { ms: 20_000 });
    await until(() => phone.got.some((n) => n.kind === 'done' && n.session === plainRun.sessionId), { label: '普通の会話の完了通知' });
    t.ok('普通の会話の完了は今までどおり送る', true);

    // ---- 一覧の行: bot の会話は bot を持ち、普通の会話は持たない
    const rows = await host.cmd('listSessions');
    const botRow = rows.find((r) => r.id === botSession);
    t.ok('一覧の行: bot の会話は { botId, kind, channelId, threadId } を持つ（Chats の一覧はこれで除く）', botRow?.bot?.botId === owl.id && botRow.bot.kind === 'thread' && botRow.bot.channelId === dev.id && botRow.bot.threadId === root1.id, JSON.stringify(botRow?.bot));
    t.ok('一覧の行: 普通の会話の bot は null', rows.find((r) => r.id === plain)?.bot === null);

    // ---- 検索: 既定では除く・includeDelegated で含める
    const search = (args) => call('sessions.search', args);
    const settled = async (args) => { for (let i = 0; i < 100; i++) { const r = await search(args); if (!r.partial) return r; await sleep(100); } throw new Error('partial のまま'); };
    const without = await settled({ query: 'zzmarker' });
    const withBots = await settled({ query: 'zzmarker', filters: { includeDelegated: true } });
    t.ok('検索: bot の会話は既定で除き、includeDelegated で含める', !without.sessions.some((s) => s.sessionId === botSession) && withBots.sessions.some((s) => s.sessionId === botSession),
      JSON.stringify([without.sessions.map((s) => s.sessionId), withBots.sessions.map((s) => s.sessionId)]));

    // ---- 承認待ち: あなた待ちの材料（running の承認待ちに載る）。スマホへ approval。スレッドからも Chats からも同じ resolvePermission
    from = host.mark();
    const root2 = await call('channels.post', { channelId: dev.id, text: '@Owl ask' });
    const perm = await host.waitFor((e) => e.type === 'permission', { from, ms: 15_000 });
    const th2 = await until(async () => { const r = await read(dev.id, root2.id); return r.threads[0]?.sessions?.[owl.id] ? r : null; }, { label: 'スレッドの会話' });
    const askSession = th2.threads[0].sessions[owl.id];
    t.ok('承認の出来事は bot の会話の id で出る（あなた待ちの印の元）', perm.sessionId === askSession && perm.toolName === 'fake_write');
    const running = await host.cmd('running');
    t.ok('running の承認待ちに bot の会話が載る（Chats の一覧はこれで仮の行を出す）', running.permissions.some((p) => p.sessionId === askSession && p.id === perm.id), JSON.stringify(running.permissions));
    const approval = await until(() => phone.got.find((n) => n.kind === 'approval' && n.session === askSession), { label: '承認の通知' });
    t.ok('承認はスマホへ approval を送る（bot の会話でも）', approval.id === perm.id);
    const waitingPost = await until(async () => botPost(await read(dev.id, root2.id), 'waiting')[0], { label: 'スレッドの承認待ち' });
    t.ok('スレッドの投稿も waiting（同じ承認をスレッドからも押せる）', waitingPost.state === 'waiting');
    await host.cmd('resolvePermission', { id: perm.id, allow: true });
    await until(async () => botPost(await read(dev.id, root2.id), 'done').length === 1, { label: '承認後の完了' });
    t.ok('承認すると続きが走り、投稿は done', true);

    // ---- 失敗: スマホへ failed を送る
    const root3 = await call('channels.post', { channelId: dev.id, text: '@Owl fail' });
    const failSession = (await until(async () => { const r = await read(dev.id, root3.id); return botPost(r, 'failed').length ? r : null; }, { label: '失敗' })).threads[0].sessions[owl.id];
    const fail = await until(() => phone.got.find((n) => n.kind === 'failed' && n.session === failSession), { label: '失敗の通知' });
    t.ok('失敗は bot の会話でもスマホへ failed を送る', fail.kind === 'failed');
  } finally {
    phone?.close();
    try { c?.close(); } catch { /* 済み */ }
    host.close();
    await device.closeAll().catch(() => {});
    await server.stop();
    await relay.close();
    await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}
