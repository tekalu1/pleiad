// 審査の招待（ADR 0172 の決定 3、core/remote/review-invite.mjs・core/review-invite.mjs・core/remote/connector.mjs の admitInvite）。
// 中継（relay/server.mjs）とホスト（createRemoteHost）をこのプロセスで立て、試験用の端末（tests/lib/remote-device.mjs）で往復する。
// 時計と上限はホストへ注入して、期限と 1 時間の数え方を実時間を待たずに確かめる。LLM もネットワークも使わない。
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import { createRelay } from '../../relay/server.mjs';
import { createRemoteHost } from '../../core/remote/connector.mjs';
import { plainCipher } from '../../core/secret-store.mjs';
import { pairDevice, connectDevice } from '../lib/remote-device.mjs';
import { parsePairingPayload, pairingPayload } from '../../core/remote/pairing.mjs';
import {
  isReviewMode, parseInviteDays, newInviteRecord, loadInvite, checkAdmission, createInviteStore, inviteDaysLeft,
  INVITE_DEFAULT_DAYS, INVITE_MAX_DAYS, INVITE_MAX_DEVICES, INVITE_MAX_PER_HOUR,
} from '../../core/remote/review-invite.mjs';
import { main as cli, qrPathFor, qrSvg, createQrServer } from '../../core/review-invite.mjs';

export const name = 'remote-review-invite';
export const title = '審査の招待: 同じコードで複数台・上限と期限で断る・取り消しで端末も切れる・審査モードでしか作れない';

const SECRET = crypto.randomBytes(32).toString('base64url');
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const rejects = p => p.then(() => null, e => e);
function within(p, ms, label) {
  let timer;
  return Promise.race([
    Promise.resolve(p).finally(() => clearTimeout(timer)),
    new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`${label} が ${ms}ms で終わらない`)), ms); }),
  ]);
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms, label) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`${label} が ${ms}ms で満たされない`);
    await sleep(40);
  }
}

export default async function (t) {
  // ---- 純粋な部品
  t.ok('審査モードの判定は AGENT_HOST_REVIEW=1 だけ', isReviewMode({ AGENT_HOST_REVIEW: '1' }) === true
    && [{}, { AGENT_HOST_REVIEW: '0' }, { AGENT_HOST_REVIEW: 'true' }, { AGENT_HOST_REVIEW: '' }].every(e => isReviewMode(e) === false));
  t.ok('日数: 既定 90・最大 180。0・181・小数・文字は断る',
    parseInviteDays(undefined) === INVITE_DEFAULT_DAYS && INVITE_DEFAULT_DAYS === 90 && parseInviteDays('180') === 180 && INVITE_MAX_DAYS === 180
    && ['0', '181', '1.5', 'x', '-3'].every(v => { try { parseInviteDays(v); return false; } catch { return true; } }));
  t.ok('既定の上限は 8 台・1 時間 4 台', INVITE_MAX_DEVICES === 8 && INVITE_MAX_PER_HOUR === 4);
  {
    const rec = newInviteRecord({ now: 1_000_000, days: 90 });
    const inv = loadInvite(rec, 1_000_000);
    t.ok('招待の記録: 32 バイトの秘密・期限は日数どおり・同じ記録から同じ入場券',
      Buffer.from(rec.secret, 'base64url').length === 32 && inv.expiresAt - inv.createdAt === 90 * DAY
      && loadInvite(rec, 5).ticketHash.equals(inv.ticketHash) && inviteDaysLeft(inv, 1_000_000) === 90
      && newInviteRecord({}).secret !== newInviteRecord({}).secret);
    t.ok('期限を過ぎると expired・壊れた記録は null',
      loadInvite(rec, inv.expiresAt).expired === true && loadInvite(rec, inv.expiresAt - 1).expired === false
      && loadInvite({ ...rec, secret: 'x' }) === null && loadInvite(null) === null && loadInvite({ ...rec, version: 2 }) === null);
    t.ok('判定: 台数が先、次に 1 時間の数',
      checkAdmission({ live: 7, recent: 3 }).ok === true && checkAdmission({ live: 8, recent: 0 }).reason === 'devices'
      && checkAdmission({ live: 2, recent: 4 }).reason === 'rate' && checkAdmission({ live: 8, recent: 9 }).reason === 'devices');
  }

  // ---- 審査モードでなければ作れない
  const scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'agent-host-review-')));
  const dataDir = path.join(scratch, 'data');
  await fs.mkdir(dataDir, { recursive: true });
  const outputs = [];
  const run = async (args, { env = {}, now } = {}) => {
    const lines = [];
    const e = await rejects(cli(args, { env: { AGENT_HOST_DATA: dataDir, ...env }, out: l => lines.push(l), ...(now ? { now } : {}) }));
    outputs.push(...lines);
    return { lines, error: e };
  };
  const REVIEW = { AGENT_HOST_REVIEW: '1' };
  for (const cmd of ['create', 'show', 'revoke', 'init']) {
    const r = await run([cmd]);
    t.ok(`審査モードでなければ ${cmd} は断る`, r.error && /review mode/i.test(r.error.message) && r.lines.length === 0, r.error?.message);
  }
  t.ok('審査モードでなければ招待の記録は作られない', !(await fs.stat(path.join(dataDir, 'remote', 'secrets.json')).catch(() => null)));
  t.ok('使い方の誤りは UsageError（引数なし・知らないコマンド）', (await run(['nope'], { env: REVIEW })).error?.message.startsWith('Usage:')
    && (await run([], { env: REVIEW })).error?.message.startsWith('Usage:'));
  t.ok('--days が範囲外なら断る', /days must be/.test((await run(['create', '--days', '400'], { env: { ...REVIEW, AGENT_HOST_RELAY_URL: 'http://127.0.0.1:1' } })).error?.message ?? ''));

  // ---- 中継とホスト
  const relay = createRelay({ enrollSecret: SECRET, trustProxy: false, logger: () => {}, pairingAttempts: 1000 });
  const relayPort = (await within(relay.listen(0, '127.0.0.1'), 5000, '中継の起動')).port;
  const relayUrl = `http://127.0.0.1:${relayPort}`;
  // ホストの転送先は使わない（admit までを見る）。HELLO まで通れば十分
  const targetServer = http.createServer((q, s) => { s.end('ok'); });
  await new Promise(r => targetServer.listen(0, '127.0.0.1', r));
  const target = () => ({ host: '127.0.0.1', port: targetServer.address().port });

  let clock = Date.now();
  const logs = [];
  const hostEnv = { ...REVIEW };
  const host = createRemoteHost({
    dataDir, cipher: plainCipher, target, token: 'tok', env: hostEnv, log: l => logs.push(l), now: () => clock,
    backoff: { minMs: 50, maxMs: 200 }, reviewLimits: { maxDevices: 3, perHour: 4 },
  });
  const live = [];
  try {
    const init = await run(['init'], { env: { ...REVIEW, AGENT_HOST_RELAY_URL: relayUrl, AGENT_HOST_RELAY_SECRET: SECRET, AGENT_HOST_REVIEW_NAME: 'Pleiad Review' } });
    t.ok('init で中継の設定が入る', !init.error && /configured/.test(init.lines.join()), init.error?.message);
    const s0 = await run(['show'], { env: REVIEW });
    t.ok('招待が無いうちの show は断る', /no review invite/i.test(s0.error?.message ?? ''));

    await within(host.start(), 10_000, 'ホストの開始');
    await until(async () => (await host.status()).connection.state === 'connected', 10_000, '中継につながる');
    const addErr = await rejects(host.startPairing());
    t.ok('審査モードのホストは「端末を追加」を断る（入場券は 1 枚だけで、置き換わると招待が使えなくなる）', Boolean(addErr) && /審査/.test(addErr.message), addErr?.message);

    // ---- 作る・見る
    const created = await run(['create', '--days', '90'], { env: REVIEW, now: clock });
    const code = created.lines.find(l => l.startsWith('pleiad://pair?'));
    // 動いているホストは 10 秒ごと（INVITE_POLL_MS）に記録を読み直す。試験は待たずに読み直させる
    await within(host.reconcileReviewInvite(), 10_000, '招待の読み直し');
    t.ok('create はペアリングのコードを出す', !created.error && Boolean(code), created.error?.message);
    const shown = await run(['show', '--code-only'], { env: REVIEW, now: clock });
    t.ok('show --code-only は同じコードを出す', shown.lines[0] === code);
    const parsed = parsePairingPayload(code);
    const hostStatus = await host.status();
    t.ok('コードの hostId・中継・ホスト名はホストと合う', parsed.hostId === hostStatus.hostId && parsed.relayUrl === relayUrl && parsed.hostName === 'Pleiad Review');
    const showText = await run(['show'], { env: REVIEW, now: clock });
    t.ok('show は残り日数・台数・QR の道を出す', /90 days left/.test(showText.lines[0]) && /0\/8/.test(showText.lines[0]) && showText.lines.some(l => l.includes('/qr/')), showText.lines[0]);
    // QR の画像は固定の道で配る（serve）。招待が続く間は同じ URL
    const qrServer = createQrServer({ store: host.store, invites: createInviteStore(host.store.secrets), env: REVIEW, now: () => clock });
    await new Promise(r => qrServer.listen(0, '127.0.0.1', r));
    try {
      const qrPath = showText.lines.find(l => l.includes('/qr/')).match(/\/qr\/\S+\.svg/)[0];
      const get = async p => { const r = await fetch(`http://127.0.0.1:${qrServer.address().port}${p}`); return { status: r.status, type: r.headers.get('content-type'), body: await r.text() }; };
      const img = await get(qrPath);
      t.ok('serve: show が出した道で QR の SVG が返る', img.status === 200 && img.type === 'image/svg+xml' && img.body.startsWith('<svg'), `${img.status} ${img.type}`);
      t.ok('serve: 道を知らなければ 404・/healthz は 200', (await get('/qr/zzzzzzzzzzzzzzzz.svg')).status === 404 && (await get('/')).status === 404 && (await get('/healthz')).status === 200);
    } finally { await new Promise(r => qrServer.close(r)); }
    const secretsText = await fs.readFile(path.join(dataDir, 'remote', 'secrets.json'), 'utf8');
    t.ok('招待の記録は秘密の置き場に 1 件', secretsText.includes('reviewInvite'));

    // ---- 同じコードで複数台（承認の画面なし）
    const credsOf = async (n, c = code) => {
      const p = pairDevice({ payload: c, name: `Review phone ${n}`, platform: 'android' });
      const r = await within(p.result, 15_000, `端末 ${n} のペアリング`).catch(e => ({ error: e }));
      return r;
    };
    const a = await credsOf(1);
    t.ok('招待のコードは人の承認なしで通り、deviceId とトークンが渡る', a.deviceId && /^[A-Za-z0-9_-]{43}$/.test(a.token ?? ''), JSON.stringify(a).slice(0, 100));
    const stA = await host.status();
    t.ok('承認待ちは作られない', stA.pairing.requests.length === 0);
    t.ok('端末一覧に招待で入った印がつく', stA.devices.length === 1 && stA.devices[0].invite === true);
    const devFile = JSON.parse(await fs.readFile(path.join(dataDir, 'remote', 'devices.json'), 'utf8'));
    t.ok('devices.json にも招待の印（招待の id）が残る', Array.isArray(devFile.devices) ? typeof devFile.devices[0].invite === 'string' : JSON.stringify(devFile).includes('"invite"'), JSON.stringify(devFile).slice(0, 200));
    const dA = await connectDevice(a);
    live.push(dA);
    t.ok('入った端末は IK でつながる', dA.hello.hostName === 'Pleiad Review');

    // 入場券は使うたびに置き直される。同じコードで 2 台目も通る
    const b = await credsOf(2);
    t.ok('同じコードで 2 台目も通る（入場券が使うたびに置き直される）', b.deviceId && b.deviceId !== a.deviceId, JSON.stringify(b).slice(0, 100));
    const dB = await connectDevice(b);
    live.push(dB);
    const c3 = await credsOf(3);
    t.ok('3 台目も通る', c3.deviceId && !c3.error, c3.error?.message);
    t.ok('ホストの一覧は 3 台', (await host.status()).devices.filter(d => d.invite).length === 3);

    // ---- 台数の上限（試験では 3 台）
    const full = await credsOf(4);
    t.ok('台数の上限に達したら断る（denied）。承認待ちに残さない', full.denied === true && full.type === 'denied', JSON.stringify(full).slice(0, 120));
    t.ok('断っても承認待ちは増えず、端末の数も変わらない', (await host.status()).pairing.requests.length === 0 && (await host.status()).devices.length === 3);
    t.ok('台数で断ったことが記録に出る', logs.some(l => /refus/i.test(l) && /device/i.test(l)), logs.join(' | ').slice(-300));

    // 台数が空けば、1 時間の枠の中でまた通る（4 件目まで）
    await host.revoke(c3.deviceId);
    const d4 = await credsOf(5);
    t.ok('端末を 1 台外すと、また通る（1 時間 4 台のうち 4 件目）', d4.deviceId && !d4.error && !d4.denied, JSON.stringify(d4).slice(0, 120));

    // ---- 1 時間あたりの上限
    await host.revoke(d4.deviceId);
    const rate = await credsOf(6);
    t.ok('1 時間に 4 台を超えたら、台数が空いていても断る', rate.denied === true, JSON.stringify(rate).slice(0, 120));
    t.ok('1 時間の上限で断ったことが記録に出る', logs.some(l => /hourly/i.test(l)), logs.join(' | ').slice(-300));
    clock += HOUR + 1000;
    const later = await credsOf(7);
    t.ok('1 時間たてばまた通る', later.deviceId && !later.denied, JSON.stringify(later).slice(0, 120));
    await host.revoke(later.deviceId);

    // ---- 取り消し: CLI が記録を消す → ホストが読み直して端末を切る
    const beforeRevoke = (await host.status()).devices.map(d => d.id).sort();
    t.ok('取り消しの前は 2 台', beforeRevoke.length === 2 && beforeRevoke.includes(a.deviceId) && beforeRevoke.includes(b.deviceId));
    const rv = await run(['revoke'], { env: REVIEW });
    t.ok('revoke は取り消したと言う', /Revoked/.test(rv.lines[0] ?? ''), rv.error?.message);
    await within(host.reconcileReviewInvite(), 10_000, '招待の読み直し');
    t.ok('取り消すと、招待で入った端末は端末一覧から消える', (await host.status()).devices.length === 0);
    const cut = await within(Promise.all([dA.closed, dB.closed]), 5000, '取り消された端末の接続が切れる').catch(() => null);
    t.ok('取り消すと、つないでいた端末の接続も切れる', Boolean(cut));
    const afterA = await rejects(connectDevice(a));
    t.ok('取り消された端末はつながらない', Boolean(afterA), 'まだつながる');
    const old = await credsOf(8);
    t.ok('取り消した後は、同じコードでも入れない（入場券を置いていない）', Boolean(old.error) || old.denied === true, JSON.stringify(old).slice(0, 100));
    t.ok('取り消した後の show は断る', /no review invite/i.test((await run(['show'], { env: REVIEW })).error?.message ?? ''));
    t.ok('もう一度 revoke しても落ちない', /no review invite/i.test((await run(['revoke'], { env: REVIEW })).lines[0] ?? ''));
    for (const d of live.splice(0)) d.close();

    // ---- 作り直し: 古い招待の端末は切れ、古いコードは使えない
    clock += 10 * 1000;
    const c1 = await run(['create', '--days', '30'], { env: REVIEW, now: clock });
    const code1 = c1.lines.find(l => l.startsWith('pleiad://pair?'));
    await within(host.reconcileReviewInvite(), 10_000, '招待の読み直し');
    const e1 = await credsOf(9, code1);
    t.ok('作り直した招待で入れる', e1.deviceId && !e1.error && !e1.denied, JSON.stringify(e1).slice(0, 100));
    const c2 = await run(['create', '--days', '30'], { env: REVIEW, now: clock });
    const code2 = c2.lines.find(l => l.startsWith('pleiad://pair?'));
    t.ok('作り直すとコードが変わる', code1 && code2 && code1 !== code2);
    await within(host.reconcileReviewInvite(), 10_000, '招待の読み直し');
    t.ok('作り直すと、前の招待で入った端末は切れる', (await host.status()).devices.length === 0);
    const oldCode = await credsOf(10, code1);
    t.ok('前のコードでは入れない', Boolean(oldCode.error) || oldCode.denied === true, JSON.stringify(oldCode).slice(0, 100));
    const e2 = await credsOf(11, code2);
    t.ok('新しいコードで入れる', e2.deviceId && !e2.error && !e2.denied, JSON.stringify(e2).slice(0, 100));

    // ---- 期限
    clock += 30 * DAY + 1000;
    await within(host.reconcileReviewInvite(), 10_000, '招待の読み直し');
    t.ok('期限が来ると、招待で入った端末は切れる', (await host.status()).devices.length === 0);
    const expired = await credsOf(12, code2);
    t.ok('期限が過ぎたコードでは入れない', Boolean(expired.error) || expired.denied === true, JSON.stringify(expired).slice(0, 100));
    const sx = await run(['show'], { env: REVIEW, now: clock });
    t.ok('期限切れの show は「Expired」と言う', /Expired/.test(sx.lines[0] ?? ''), sx.lines[0] ?? sx.error?.message);

    // ---- 起動の記録（残り日数と台数）
    logs.length = 0;
    clock += 1000;
    await run(['create', '--days', '120'], { env: REVIEW, now: clock });
    await within(host.reconcileReviewInvite(), 10_000, '招待の読み直し');
    t.ok('招待の入れ替わりで、残り日数と台数が記録に出る', logs.some(l => /120 days left/.test(l) && /0\/\d+ devices/.test(l)), logs.join(' | ').slice(-300));
    t.ok('記録に秘密（コードの s=）を出さない', !logs.join('\n').includes(parsePairingPayload(code2).secret.toString('base64url')));

    // ---- 再起動しても招待は続く
    const e3code = (await run(['show', '--code-only'], { env: REVIEW, now: clock })).lines[0];
    const e3 = await credsOf(13, e3code);
    t.ok('新しい招待で入る', e3.deviceId && !e3.error && !e3.denied, JSON.stringify(e3).slice(0, 100));
    host.stop();
    const host2 = createRemoteHost({ dataDir, cipher: plainCipher, target, token: 'tok', env: hostEnv, log: l => logs.push(l), now: () => clock, backoff: { minMs: 50, maxMs: 200 } });
    try {
      logs.length = 0;
      await within(host2.start(), 10_000, 'ホストの再開');
      await until(async () => (await host2.status()).connection.state === 'connected', 10_000, '中継に再びつながる');
      t.ok('再起動すると起動の記録に残り日数と台数が出る', logs.some(l => /120 days left/.test(l) && /1\/8 devices/.test(l)), logs.join(' | ').slice(-300));
      const e4 = await credsOf(14, e3code);
      t.ok('再起動しても同じコードで入れる', e4.deviceId && !e4.error && !e4.denied, JSON.stringify(e4).slice(0, 100));
      const dE3 = await connectDevice(e3);
      t.ok('再起動前に入った端末は再起動後もつながる', dE3.hello.hostName === 'Pleiad Review');
      dE3.close();
    } finally {
      host2.stop();
    }
  } finally {
    for (const d of live) d.close();
    host.stop();
    await relay.close();
    await new Promise(r => targetServer.close(r));
  }

  // ---- 審査モードでないホストは、記録があっても招待の入場券を置かない
  {
    const relay2 = createRelay({ enrollSecret: SECRET, trustProxy: false, logger: () => {}, pairingAttempts: 1000 });
    const url2 = `http://127.0.0.1:${(await relay2.listen(0, '127.0.0.1')).port}`;
    const normal = createRemoteHost({ dataDir, cipher: plainCipher, target, token: 'tok', env: {}, now: () => clock, backoff: { minMs: 50, maxMs: 200 } });
    try {
      await normal.setSettings({ relayUrl: url2, enrollSecret: SECRET, enabled: true });
      await until(async () => (await normal.status()).connection.state === 'connected', 10_000, '通常のホストが中継につながる');
      const rec = await createInviteStore(normal.store.secrets).get();
      const inv = loadInvite(rec, clock);
      const id = await normal.store.identity();
      const payload = pairingPayload({ relayUrl: url2, hostId: id.hostId, publicKey: id.publicKey, secret: inv.secret, hostName: 'x' });
      const r = await within(pairDevice({ payload, name: 'x', platform: 'android', timeoutMs: 3000 }).result.catch(e => ({ error: e })), 10_000, '通常のホストへの招待');
      t.ok('審査モードでないホストには、招待のコードでは入れない', Boolean(r.error) && !r.deviceId, JSON.stringify(r).slice(0, 120));
      t.ok('通常のホストの端末は増えない', (await normal.status()).devices.length === 0);
    } finally {
      normal.stop();
      await relay2.close();
    }
  }

  // ---- QR の画像の道
  {
    const inv = loadInvite(newInviteRecord({ now: 1 }), 1);
    const other = loadInvite(newInviteRecord({ now: 1 }), 1);
    t.ok('QR の画像の道は招待ごとに決まり、他と重ならない', qrPathFor(inv) === qrPathFor(inv) && qrPathFor(inv) !== qrPathFor(other) && /^\/qr\/[A-Za-z0-9_-]{16}\.svg$/.test(qrPathFor(inv)));
    t.ok('qrSvg は SVG を返す', qrSvg('pleiad://pair?v=1').startsWith('<svg'));
  }
  await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
}
