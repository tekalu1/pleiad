// スマホへの通知を、ホスト（fake バックエンドのサーバー）→ 中継 → 端末の代わりの Node のクライアントで通す（ADR 0086、docs/remote.md §11-5）。
// 端末内プロキシ越しの /ws から通知鍵と設定を登録し、中継の通知の線（/v1/device/notify）で受けた暗号文を端末の鍵で復号する。
// 承認・質問・完了・失敗が届くこと、決着・既読で取り消しが届くこと、見ている会話・切った種類・止めた端末には届かないこと、
// 線が切れている間の通知は溜まってつながったら届くこと、古いホスト（READY に notify が無い）を端末が見分けられることを確かめる。LLM もネットワークも使わない。
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import WebSocket from 'ws';
import { createRelay } from '../../relay/server.mjs';
import { startServer, ROOT } from '../lib/server.mjs';
import { open, sleep } from '../lib/ws-client.mjs';
import { createRemoteDevice } from '../../core/remote/device.mjs';
import { openNotice, BLOB_BYTES } from '../../core/notify/crypto.mjs';

export const name = 'server-push-notify';
export const title = 'スマホへの通知: ホスト → 中継の通知の線 → 端末で復号。承認・質問・完了・失敗・取り消し・見ている会話・止めた端末・溜めて渡す';

const SECRET = crypto.randomBytes(32).toString('base64url');

function within(p, ms, label) {
  let timer;
  return Promise.race([
    Promise.resolve(p).finally(() => clearTimeout(timer)),
    new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`${label} が ${ms}ms で終わらない`)), ms); }),
  ]);
}

/** 端末の通知の線。届いた暗号文を鍵で開いて貯め、ack を返す。 */
function noticeLine({ relayPort, creds, key }) {
  const ids = { hostId: creds.hostId, deviceId: creds.deviceId };
  const ws = new WebSocket(`ws://127.0.0.1:${relayPort}/v1/device/notify`, {
    headers: { authorization: `Bearer ${creds.token}`, 'x-pleiad-host': creds.hostId, 'x-pleiad-device': creds.deviceId },
    perMessageDeflate: false,
  });
  const got = [];
  const raw = [];
  const waiters = new Set();
  let closed = null;
  ws.on('error', () => {});
  ws.on('close', (code) => { closed = code; });
  ws.on('message', (data) => {
    let m; try { m = JSON.parse(data.toString('utf8')); } catch { return; }
    if (m.type !== 'notify') return;
    raw.push(m.blob);
    const notice = openNotice(key, ids, m.blob);
    ws.send(JSON.stringify({ type: 'ack', i: m.i }));
    if (!notice) return;
    got.push(notice);
    for (const w of [...waiters]) if (w.pred(notice)) { waiters.delete(w); w.res(notice); }
  });
  return {
    ws, got, raw,
    get closedCode() { return closed; },
    opened: new Promise((res) => { ws.once('open', () => res(true)); ws.once('error', () => res(false)); ws.once('unexpected-response', () => res(false)); }),
    waitFor(pred, ms = 8000) {
      const hit = got.find(pred);
      if (hit) return Promise.resolve(hit);
      return new Promise((res, rej) => {
        const w = { pred, res };
        waiters.add(w);
        setTimeout(() => { if (waiters.delete(w)) rej(new Error(`通知が ${ms}ms で届かない: ${JSON.stringify(got.map(g => g.kind))}`)); }, ms).unref?.();
      });
    },
    /** ms 待っても条件に合う通知が増えなければ true */
    async quiet(pred, ms = 400) { const before = got.filter(pred).length; await sleep(ms); return got.filter(pred).length === before; },
    close() { try { ws.terminate(); } catch { /* 済み */ } },
  };
}

export default async function (t) {
  const scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'agent-host-push-notify-')));
  const relay = createRelay({ enrollSecret: SECRET, trustProxy: false, logger: () => {} });
  const relayPort = (await relay.listen(0, '127.0.0.1')).port;
  const server = await startServer({
    env: { AGENT_HOST_BACKENDS: 'fake', AGENT_HOST_NOTIFY_MIN_TURN_MS: '0' },
    dataDir: path.join(scratch, 'data'), timeoutMs: 30_000,
  });
  const host = await within(open({ port: server.port, token: server.token }), 10_000, 'サーバーへの接続');
  const device = createRemoteDevice({ dir: path.join(scratch, 'device'), app: 'test', name: 'Pixel Test', platform: 'android',
    proxyOptions: { backoff: { minMs: 200, maxMs: 1000, stableMs: 1000 }, connectTimeoutMs: 5000, requestWaitMs: 5000 } });
  let phone = null, c = null;
  try {
    t.ok('READY に notify: 1 がある（古いホストはこの欄が無いので、端末は鍵の登録を送らない）', host.ready.notify === 1);

    let from = host.mark();
    await host.cmd('setRemoteSettings', { relayUrl: `http://127.0.0.1:${relayPort}`, enrollSecret: SECRET, enabled: true, hostName: 'push-host' });
    await host.waitFor((e) => e.type === 'remoteStatus' && e.status.connection.state === 'connected', { from, ms: 10_000 });
    const offer = await host.cmd('remotePairingStart');
    from = host.mark();
    const pairing = device.pair(offer.payload);
    pairing.catch(() => {});
    const req = await host.waitFor((e) => e.type === 'remotePairing' && e.phase === 'request', { from, ms: 10_000 });
    await host.cmd('remotePairingApprove', { id: req.request.id });
    const { hostId } = await within(pairing, 15_000, 'ペアリング');
    const proxy = await within(device.open(hostId), 10_000, 'プロキシを開く');
    await within(new Promise((resolve) => {
      const on = (s) => { if (s.hostId === hostId && s.state === 'connected') { device.off('status', on); resolve(); } };
      device.on('status', on);
      device.proxy(hostId).then((px) => { if (px?.status.state === 'connected') { device.off('status', on); resolve(); } });
    }), 10_000, 'つながる');
    c = await within(open({ port: proxy.port, token: proxy.token }), 10_000, 'プロキシ経由の /ws');
    const creds = await device.store.credentials(hostId);

    // ---- 登録
    const key = crypto.randomBytes(32);
    const cmd = (command, args) => within(c.cmd(command, args), 15_000, command);
    t.ok('ホストの PC の画面（端末でない接続）からは通知鍵を登録できない',
      await host.cmd('notifyRegister', { key: key.toString('base64url'), settings: { enabled: true } }).then(() => false, () => true));
    t.ok('形の違う通知鍵は断る', await cmd('notifyRegister', { key: 'short', settings: { enabled: true } }).then(() => false, () => true));
    const settings = { enabled: true, reply: true, failed: true, done: true, lockNames: false, skipPc: true };
    const reg = await cmd('notifyRegister', { key: key.toString('base64url'), settings });
    t.ok('中継越しの端末の画面から通知鍵と設定を登録できる', reg.registered === true && reg.enabled === true && reg.muted === false);
    const st0 = await host.cmd('notifyStatus');
    const row0 = st0.devices.find((d) => d.id === creds.deviceId);
    t.ok('設定 › 通知のスマホの一覧に、端末名・通知の状態が出る（鍵は出ない）',
      st0.pc.done === true && st0.relayConnected === true && row0?.name === 'Pixel Test' && row0.notify.enabled === true && row0.notify.lastSentAt === null
      && !JSON.stringify(st0).includes(key.toString('base64url')));
    const secretsText = await fs.readFile(path.join(scratch, 'data', 'remote', 'secrets.json'), 'utf8').catch(() => '');
    const devicesText = await fs.readFile(path.join(scratch, 'data', 'remote', 'devices.json'), 'utf8');
    t.ok('通知鍵は devices.json に平文で置かない（秘密の置き場へ）', !devicesText.includes(key.toString('base64url')) && JSON.parse(devicesText).devices[0].notify.settings.enabled === true && secretsText.length > 0);

    // ---- 通知の線を張る
    phone = noticeLine({ relayPort, creds, key });
    t.ok('端末の通知の線がつながる', await phone.opened);
    await sleep(100);

    const turn = (prompt, extra = {}) => host.cmd('runTurn', { prompt, sessionId: null, cwd: ROOT, backend: 'fake', mode: 'default', ...extra });

    // ---- 承認 → 通知 → 決着で取り消し
    from = host.mark();
    turn('ask');
    const perm = await host.waitFor((e) => e.type === 'permission', { from, ms: 10_000 });
    const approval = await phone.waitFor((n) => n.kind === 'approval');
    t.ok('承認を求めると、画面が居なくても端末へ approval が届く（会話名・ホスト名・会話 ID 付き）',
      approval.session === perm.sessionId && approval.id === perm.id && approval.host === 'push-host' && approval.hostId === hostId && approval.v === 1);
    t.ok('暗号文は固定の大きさ', phone.raw.every((b) => Buffer.from(b, 'base64url').length === BLOB_BYTES));
    await host.cmd('resolvePermission', { id: perm.id, allow: true });
    const cancel = await phone.waitFor((n) => n.kind === 'cancel' && n.cancel === 'approval');
    t.ok('承認が決着すると、出ている通知の取り消しが届く', cancel.id === perm.id && cancel.session === perm.sessionId && cancel.seq > approval.seq);
    await host.waitFor((e) => e.type === 'turnEnd' && e.sessionId === perm.sessionId, { from, ms: 15_000 });

    // ---- 質問
    from = host.mark();
    turn('question');
    const q = await host.waitFor((e) => e.type === 'permission' && e.kind === 'question', { from, ms: 10_000 });
    const qn = await phone.waitFor((n) => n.kind === 'question');
    t.ok('質問は question で届く', qn.id === q.id);
    const answers = Object.fromEntries((q.questions ?? []).map((x) => [x.question, x.options?.[0]?.label ?? '']));
    await host.cmd('resolvePermission', { id: q.id, allow: true, answers });
    await host.waitFor((e) => e.type === 'turnEnd' && e.sessionId === q.sessionId, { from, ms: 15_000 });

    // ---- 完了（30 秒未満でも通す下限の上書きで）。会話名は題
    from = host.mark();
    const doneId = (await host.cmd('newSession', { backend: 'fake', cwd: ROOT })).sessionId;
    const done = await host.runTurn({ prompt: 'echo:終わった', sessionId: doneId, cwd: ROOT, backend: 'fake', mode: 'default' }, { ms: 20_000 });
    const doneNotice = await phone.waitFor((n) => n.kind === 'done' && n.session === done.sessionId);
    t.ok('完了すると端末へ done が届く（会話名は題）', doneNotice.title === 'echo:終わった' && doneNotice.host === 'push-host', JSON.stringify(doneNotice.title));
    const st1 = await host.cmd('notifyStatus');
    t.ok('最後に送った時刻が一覧に出る', typeof st1.devices.find((d) => d.id === creds.deviceId).notify.lastSentAt === 'string');

    // どこかで見たら取り消し
    const endAt = host.since(from).find((e) => e.type === 'turnEnd' && e.sessionId === done.sessionId)?.completedAt;
    await host.cmd('markRead', { reads: [[done.sessionId, endAt]] });
    const seen = await phone.waitFor((n) => n.kind === 'cancel' && n.cancel === 'seen' && n.session === done.sessionId);
    t.ok('別の画面で完了を確認すると、出ている完了の通知の取り消しが届く', seen.seq > doneNotice.seq);

    // ---- 失敗
    from = host.mark();
    const failed = await host.runTurn({ prompt: 'fail', sessionId: null, cwd: ROOT, backend: 'fake', mode: 'default' }, { ms: 20_000 });
    const failNotice = await phone.waitFor((n) => n.kind === 'failed' && n.session === failed.sessionId);
    t.ok('失敗すると端末へ failed が届く', failNotice.kind === 'failed');
    const ready = await host.waitFor((e) => e.type === 'completionReady' && e.sessionId === failed.sessionId, { from, ms: 5000 });
    t.ok('画面の完了の知らせにも失敗が出る（completionReady の outcome: error）', ready.outcome === 'error');

    // ---- 見ている会話には送らない
    const watched = (await host.cmd('newSession', { backend: 'fake', cwd: ROOT })).sessionId;
    await host.cmd('presence', { visible: true, sessionId: watched });
    const before = phone.got.length;
    from = host.mark();
    await host.runTurn({ prompt: 'echo:見ている会話', sessionId: watched, cwd: ROOT, backend: 'fake', mode: 'default' }, { ms: 20_000 });
    t.ok('PC がその会話を見ている間は、完了を送らない', await phone.quiet((n) => n.session === watched && n.kind === 'done', 500));
    await host.cmd('presence', { visible: false, sessionId: watched });
    await host.runTurn({ prompt: 'echo:もう見ていない', sessionId: watched, cwd: ROOT, backend: 'fake', mode: 'default' }, { ms: 20_000 });
    await phone.waitFor((n) => n.kind === 'done' && n.session === watched);
    t.ok('見るのをやめれば送る', phone.got.length > before);

    // ---- 種類を切る・端末ごとに止める
    await cmd('notifyRegister', { key: key.toString('base64url'), settings: { ...settings, done: false } });
    await host.runTurn({ prompt: 'echo:完了を切った', sessionId: watched, cwd: ROOT, backend: 'fake', mode: 'default' }, { ms: 20_000 });
    t.ok('完了を切った端末には完了を送らない', await phone.quiet((n) => n.kind === 'done' && n.title === '完了を切った', 500)
      && !phone.got.some((n) => n.kind === 'done' && n.title === '完了を切った'));
    await cmd('notifyRegister', { key: key.toString('base64url'), settings });
    await host.cmd('setNotifyDevice', { id: creds.deviceId, muted: true });
    await host.runTurn({ prompt: 'fail', sessionId: watched, cwd: ROOT, backend: 'fake', mode: 'default' }, { ms: 20_000 });
    const mutedCount = phone.got.filter((n) => n.kind === 'failed').length;
    await sleep(400);
    t.ok('ホストで止めた端末には送らない（一覧は muted）', phone.got.filter((n) => n.kind === 'failed').length === mutedCount
      && (await host.cmd('notifyStatus')).devices.find((d) => d.id === creds.deviceId).notify.muted === true);
    await host.cmd('setNotifyDevice', { id: creds.deviceId, muted: false });

    // ---- 線が切れている間は中継が溜め、つながったら渡す（ack しなかった分は送り直し）
    phone.close();
    await sleep(200);
    const offlineSession = (await host.cmd('newSession', { backend: 'fake', cwd: ROOT })).sessionId;
    await host.runTurn({ prompt: 'fail', sessionId: offlineSession, cwd: ROOT, backend: 'fake', mode: 'default' }, { ms: 20_000 });
    await sleep(200);
    phone = noticeLine({ relayPort, creds, key });
    await phone.opened;
    const late = await phone.waitFor((n) => n.kind === 'failed' && n.session === offlineSession);
    t.ok('端末が切れている間の通知は、つながったら届く', late.kind === 'failed');

    // ---- 取り消された端末には送らない・線も切れる
    await host.cmd('remoteRevoke', { id: creds.deviceId });
    await within((async () => { while (phone.closedCode == null) await sleep(50); })(), 5000, '線が閉じる');
    t.ok('取り消された端末の通知の線は閉じる（4401）', phone.closedCode === 4401);
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
