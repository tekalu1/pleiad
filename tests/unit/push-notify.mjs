// スマホ（離れた端末）への通知の判定・暗号・取り消し（core/notify/*、ADR 0086）。ネットワークは使わない。
// 種類・抑制（見ている会話・古さ・短さ）・取り消し、暗号化と復号の往復、固定長、Android と共有する例（tests/remote/notify-vectors.json）。
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { sealNotice, openNotice, normalizeNotice, parseNotifyKey, generateNotifyKey, BLOB_BYTES, PLAIN_BYTES } from '../../core/notify/crypto.mjs';
import { decideSend, normalizeDeviceSettings, normalizePcSettings, isViewed, ttlFor, SHORT_TURN_MS, STALE_DONE_MS, PRESENCE_TTL_MS, DEFAULT_DEVICE_SETTINGS } from '../../core/notify/policy.mjs';
import { createPresence } from '../../core/notify/presence.mjs';
import { createPushNotifier } from '../../core/notify/notifier.mjs';
import { createNotifySettings } from '../../core/notify/settings.mjs';
import { createCompletionNotices } from '../../core/completion-notices.mjs';

export const name = 'push-notify';
export const title = 'スマホへの通知: 種類・抑制（見ている会話・古さ・短さ）・取り消し・暗号の往復と固定長・完了と失敗の保留';

const HOST = 'abcdefghijklmnopqrstuvwxyz';
const ids = { hostId: HOST, deviceId: 'dPhone' };

export default async function (t) {
  // ── 暗号 ──
  const key = generateNotifyKey();
  const base = { kind: 'done', seq: 11, at: 1000, hostId: HOST, host: 'main-pc', session: 's1', title: 'ログの検索を計測する' };
  const blob = sealNotice(key, ids, base);
  t.ok('暗号文は固定の大きさ（種類・題の長さで変わらない）', Buffer.from(blob, 'base64url').length === BLOB_BYTES
    && Buffer.from(sealNotice(key, ids, { ...base, kind: 'cancel', cancel: 'seen', title: '' }), 'base64url').length === BLOB_BYTES
    && Buffer.from(sealNotice(key, ids, { ...base, title: 'あ'.repeat(500) }), 'base64url').length === BLOB_BYTES);
  const opened = openNotice(key, ids, blob);
  t.ok('同じ鍵・hostId・deviceId で復号でき、中身が往復する', opened?.kind === 'done' && opened.title === base.title && opened.seq === 11 && opened.host === 'main-pc' && opened.session === 's1' && opened.v === 1);
  t.ok('同じ内容でも暗号文は毎回違う（nonce）', sealNotice(key, ids, base) !== blob);
  t.ok('平文の中身（会話名・種類）は暗号文に現れない', !Buffer.from(blob, 'base64url').toString('latin1').includes('main-pc') && !Buffer.from(blob, 'base64url').toString('latin1').includes('done'));
  t.ok('別の鍵では開けない', openNotice(generateNotifyKey(), ids, blob) === null);
  t.ok('別のホスト・別の端末への付け替えでは開けない（AAD）', openNotice(key, { ...ids, hostId: 'zzzzzzzzzzzzzzzzzzzzzzzzzz' }, blob) === null && openNotice(key, { ...ids, deviceId: 'dOther' }, blob) === null);
  const flipped = Buffer.from(blob, 'base64url'); flipped[40] ^= 1;
  t.ok('改ざんされた暗号文は開けない', openNotice(key, ids, flipped.toString('base64url')) === null);
  t.ok('大きさの違う入力・壊れた入力は null', openNotice(key, ids, 'abc') === null && openNotice(key, ids, '') === null && openNotice(key, ids, null) === null);
  const long = openNotice(key, ids, sealNotice(key, ids, { ...base, title: 'あ'.repeat(500), host: 'h'.repeat(300) }));
  t.ok('長い会話名・ホスト名は収まるまで詰める', long && [...long.title].length <= 120 && [...long.host].length <= 48);
  let bad = 0;
  for (const n of [{ ...base, kind: 'bogus' }, { ...base, seq: 0 }, { ...base, kind: 'cancel' }, null]) { try { normalizeNotice(n); } catch { bad++; } }
  t.ok('種類・通し番号・取り消しの対象が不正なら投げる', bad === 4);
  t.ok('通知鍵は base64url の 32 バイトだけ', parseNotifyKey(key.toString('base64url'))?.equals(key) && parseNotifyKey('short') === null && parseNotifyKey(123) === null && PLAIN_BYTES === 512);

  // Android と共有する例
  const vec = JSON.parse(await fs.readFile(new URL('../remote/notify-vectors.json', import.meta.url), 'utf8'));
  const vkey = Buffer.from(vec.key, 'hex');
  const vids = { hostId: vec.hostId, deviceId: vec.deviceId };
  t.ok('共有の例（Android も読む）が今の実装で復号できる', vec.cases.length >= 5 && vec.cases.every(c => {
    const n = openNotice(vkey, vids, c.blob);
    return n && JSON.stringify(n) === JSON.stringify(c.notice);
  }));
  t.ok('共有の例を同じ nonce で作り直すと同じ暗号文になる', vec.cases.every(c => sealNotice(vkey, vids, c.notice, { nonce: Buffer.from(c.nonce, 'hex') }) === c.blob));

  // ── 設定の形 ──
  t.ok('端末の設定の既定: 切・返事待ち/失敗/完了は入・ロック画面の会話名は切・PC で見ていれば送らないは入',
    JSON.stringify(normalizeDeviceSettings({})) === JSON.stringify({ enabled: false, reply: true, failed: true, done: true, lockNames: false, skipPc: true }));
  t.ok('端末の設定は真偽だけを受け、知らない項目は捨てる', JSON.stringify(normalizeDeviceSettings({ enabled: 'yes', reply: false, extra: 1 })) === JSON.stringify({ ...DEFAULT_DEVICE_SETTINGS, reply: false }));
  t.ok('PC の設定の既定は 3 つとも入', JSON.stringify(normalizePcSettings(undefined)) === JSON.stringify({ done: true, reply: true, failed: true }));
  t.ok('寿命: 完了は 2 分、ほかは長い', ttlFor('done') === STALE_DONE_MS && ttlFor('approval') > STALE_DONE_MS && ttlFor('cancel') > STALE_DONE_MS);

  // ── 判定 ──
  const now = 1_000_000;
  const device = (over = {}, id = 'dPhone') => ({ id, muted: false, settings: { ...DEFAULT_DEVICE_SETTINGS, enabled: true, ...over } });
  const decide = (kind, over = {}, extra = {}) => decideSend({ kind, device: device(over), sessionId: 's1', completedAt: now - 1000, durationMs: 60_000, presence: [], now, ...extra });
  t.ok('通知が切の端末には送らない', decide('approval', { enabled: false }).reason === 'off');
  t.ok('ホスト側で止めた端末には送らない', decideSend({ kind: 'done', device: { ...device(), muted: true }, sessionId: 's1', presence: [], now }).reason === 'muted');
  t.ok('返事が要るとき（承認・質問）は reply の設定に従う', decide('approval').send && decide('question').send && !decide('approval', { reply: false }).send && !decide('question', { reply: false }).send);
  t.ok('失敗は failed の設定に従う', decide('failed').send && !decide('failed', { failed: false }).send);
  t.ok('再開待ち行列の歯止めは失敗通知の設定に従う', decide('limitGuarded').send && !decide('limitGuarded', { failed: false }).send);
  t.ok('送信予定を過ぎて送らなかった通知は失敗通知の設定に従う', decide('scheduleMissed').send && !decide('scheduleMissed', { failed: false }).send);
  t.ok('完了は done の設定に従う', decide('done').send && !decide('done', { done: false }).send);
  t.ok('知らない種類は送らない', decide('weird').reason === 'kind');
  t.ok('2 分より古い完了は送らない（失敗・返事待ちには効かない）', decide('done', {}, { completedAt: now - STALE_DONE_MS - 1 }).reason === 'stale'
    && decide('done', {}, { completedAt: now - STALE_DONE_MS }).send && decide('failed', {}, { completedAt: now - STALE_DONE_MS * 5 }).send);
  t.ok('30 秒未満のターンの完了は送らない（失敗には効かない）', decide('done', {}, { durationMs: SHORT_TURN_MS - 1 }).reason === 'short'
    && decide('done', {}, { durationMs: SHORT_TURN_MS }).send && decide('failed', {}, { durationMs: 1000 }).send);
  t.ok('短さの下限は差し替えられる（試験用）', decide('done', {}, { durationMs: 1000, shortTurnMs: 0 }).send);
  const seen = (over = {}) => ({ deviceId: null, visible: true, sessionId: 's1', at: now - 1000, ...over });
  t.ok('PC（端末でない画面）がその会話を見ていれば送らない（既定）', decide('approval', {}, { presence: [seen()] }).reason === 'viewing' && decide('done', {}, { presence: [seen()] }).reason === 'viewing');
  t.ok('PC で見ていても、設定を切れば送る', decide('approval', { skipPc: false }, { presence: [seen()] }).send);
  t.ok('その端末自身の画面が見ていれば、設定によらず送らない', decide('approval', { skipPc: false }, { presence: [seen({ deviceId: 'dPhone' })] }).reason === 'viewing');
  t.ok('別の会話を見ている・見えていない・古い印は数えない', decide('approval', {}, { presence: [seen({ sessionId: 's2' }), seen({ visible: false }), seen({ at: now - PRESENCE_TTL_MS - 1 })] }).send);
  t.ok('別の端末が見ている会話も、設定が許すなら送らない（その端末自身ではないので skipPc に従う）',
    isViewed([seen({ deviceId: 'dTablet' })], { sessionId: 's1', deviceId: 'dPhone', skipOthers: true, now })
    && !isViewed([seen({ deviceId: 'dTablet' })], { sessionId: 's1', deviceId: 'dPhone', skipOthers: false, now }));

  // ── presence ──
  let clock = 5000;
  const presence = createPresence({ now: () => clock });
  const wsA = {}, wsB = {};
  presence.set(wsA, { visible: true, sessionId: 's1' });
  presence.set(wsB, { deviceId: 'dPhone', platform: 'android', visible: false, sessionId: 's1' });
  t.ok('presence: 可視でその会話を開いている印だけが見ている', presence.viewing('s1') && presence.entries().length === 2);
  clock += PRESENCE_TTL_MS + 1;
  t.ok('presence: 更新が無い印は期限で消える', !presence.viewing('s1') && presence.entries().length === 0);
  presence.set(wsA, { visible: true, sessionId: 's1' });
  presence.clear(wsA);
  t.ok('presence: 接続を閉じたら消える', presence.entries().length === 0);
  presence.set(wsA, { visible: true, sessionId: '' });
  t.ok('presence: 会話が空なら見ていない', !presence.viewing(''));

  // ── notifier ──
  const keys = { dPhone: generateNotifyKey(), dTablet: generateNotifyKey() };
  const targets = [
    { id: 'dPhone', platform: 'android', key: keys.dPhone, settings: { ...DEFAULT_DEVICE_SETTINGS, enabled: true }, muted: false },
    { id: 'dTablet', platform: 'android', key: keys.dTablet, settings: { ...DEFAULT_DEVICE_SETTINGS, enabled: true, done: false }, muted: false },
  ];
  const sent = [];
  const sentAt = [];
  let nowMs = 2_000_000;
  const pres = createPresence({ now: () => nowMs });
  let online = true;
  const notifier = createPushNotifier({
    devices: () => targets, presence: pres, now: () => nowMs,
    send: (id, b, ttl) => { if (!online) return false; sent.push({ id, ttl, notice: openNotice(keys[id], { hostId: HOST, deviceId: id }, b) }); return true; },
    host: () => ({ hostId: HOST, hostName: 'main-pc' }),
    onSent: (id, at) => sentAt.push([id, at]),
  });
  const reset = () => { sent.length = 0; sentAt.length = 0; };

  notifier.approval({ id: 'p1', sessionId: 's1', kind: 'tool', title: 'マイグレーション' });
  t.ok('承認: 通知を受ける全端末へ、種類 approval・会話名・id を暗号化して送る',
    sent.length === 2 && sent.every(s => s.notice?.kind === 'approval' && s.notice.title === 'マイグレーション' && s.notice.id === 'p1' && s.notice.session === 's1' && s.notice.host === 'main-pc' && s.notice.hostId === HOST)
    && sent[0].ttl === ttlFor('approval') && sentAt.length === 2);
  t.ok('通し番号は単調に増える', sent[1].notice.seq > sent[0].notice.seq);
  reset();
  notifier.approval({ id: 'p2', sessionId: 's1', kind: 'question', title: '' });
  t.ok('質問は question で送る', sent.length === 2 && sent[0].notice.kind === 'question');
  reset();
  notifier.approvalResolved({ id: 'p1', sessionId: 's1' });
  t.ok('承認が決着したら、送った端末へ取り消し（approval・id 付き）を送る', sent.length === 2 && sent.every(s => s.notice.kind === 'cancel' && s.notice.cancel === 'approval' && s.notice.id === 'p1'));
  reset();
  notifier.approvalResolved({ id: 'p1', sessionId: 's1' });
  t.ok('同じ承認の取り消しは二度送らない', sent.length === 0);
  notifier.approvalResolved({ id: 'never', sessionId: 's9' });
  t.ok('通知していない承認の取り消しは送らない', sent.length === 0);
  notifier.approvalResolved({ id: 'p2', sessionId: 's1' });
  reset();

  nowMs += 100;
  notifier.finished({ sessionId: 's2', outcome: 'ok', completedAt: nowMs - 1000, startedAt: nowMs - 120_000, title: '完了した会話' });
  t.ok('完了: done を設定が入の端末にだけ送る（tablet は done を切っている）', sent.length === 1 && sent[0].id === 'dPhone' && sent[0].notice.kind === 'done' && sent[0].notice.title === '完了した会話' && sent[0].ttl === ttlFor('done'));
  reset();
  notifier.finished({ sessionId: 's3', outcome: 'ok', completedAt: nowMs - 1000, startedAt: nowMs - 5_000, title: '短い' });
  t.ok('完了: 30 秒未満のターンは送らない', sent.length === 0);
  notifier.finished({ sessionId: 's3', outcome: 'ok', completedAt: nowMs - STALE_DONE_MS - 5000, startedAt: nowMs - 600_000, title: '古い' });
  t.ok('完了: 2 分より古いものは送らない', sent.length === 0);
  notifier.finished({ sessionId: 's3', outcome: 'aborted', completedAt: nowMs, startedAt: nowMs - 600_000, title: '中断' });
  t.ok('中断は送らない（ok と error だけ）', sent.length === 0);
  notifier.finished({ sessionId: 's4', outcome: 'error', completedAt: nowMs, startedAt: nowMs - 2000, title: '失敗した' });
  t.ok('失敗: 短いターンでも failed を送る（tablet にも。failed は入）', sent.length === 2 && sent.every(s => s.notice.kind === 'failed' && s.notice.title === '失敗した'));
  reset();
  notifier.limitGuarded({ sessionId: 's8', title: '確認する会話' });
  t.ok('歯止めで止まったらスマホに確認を知らせる', sent.length === 2 && sent.every(s => s.notice.kind === 'limitGuarded'));
  reset();
  notifier.scheduleMissed({ sessionId: 's9', title: '送れなかった会話' });
  t.ok('送信予定を過ぎたらスマホに確認を知らせる', sent.length === 2 && sent.every(s => s.notice.kind === 'scheduleMissed'));
  reset();
  notifier.viewed('s2');
  t.ok('完了を見たら、出ている完了の通知を消す（seen）', sent.length === 1 && sent[0].id === 'dPhone' && sent[0].notice.cancel === 'seen' && sent[0].notice.session === 's2');
  reset();
  notifier.viewed('s2');
  t.ok('見た印の二重送信はしない', sent.length === 0);
  notifier.viewed('s4');
  t.ok('失敗の通知も、見たら消す', sent.length === 2 && sent.every(s => s.notice.cancel === 'seen'));
  reset();

  // 見ている会話は送らない
  pres.set({}, { deviceId: null, visible: true, sessionId: 's5' });
  notifier.approval({ id: 'p5', sessionId: 's5', kind: 'tool', title: 'PC で見ている' });
  t.ok('PC がその会話を見ていれば承認も送らない', sent.length === 0);
  notifier.finished({ sessionId: 's5', outcome: 'ok', completedAt: nowMs, startedAt: nowMs - 100_000, title: '見ている' });
  t.ok('見ている会話の完了も送らない', sent.length === 0);

  // 設定の変更・ホスト側の停止
  targets[0].muted = true;
  notifier.approval({ id: 'p6', sessionId: 's6', kind: 'tool', title: 'x' });
  t.ok('ホスト側で止めた端末には送らず、ほかには送る', sent.length === 1 && sent[0].id === 'dTablet');
  targets[0].muted = false;
  reset();
  online = false;
  notifier.approval({ id: 'p7', sessionId: 's7', kind: 'tool', title: 'x' });
  t.ok('送れなかったら最後に送った時刻は進めない', sent.length === 0 && sentAt.length === 0);
  online = true;
  t.ok('ホストの identity が無い間は送らない', (() => {
    const quiet = createPushNotifier({ devices: () => targets, presence: pres, send: () => { throw new Error('should not send'); }, host: () => null });
    return quiet.approval({ id: 'z', sessionId: 'zz', kind: 'tool', title: '' }).length === 0;
  })());

  // ── 完了と失敗の保留（画面が居なくても、落ち着いたら 1 回） ──
  const readyCalls = [], screen = [];
  const busy = { v: false, connected: true };
  const notices = createCompletionNotices({
    busy: () => busy.v,
    send: ev => { if (!busy.connected) return false; screen.push(ev); return true; },
    ready: info => readyCalls.push(info),
  });
  notices.finished('a', 'ok', 10, { startedAt: 1 });
  t.ok('完了: 落ち着いていれば画面と離れた端末の両方へ 1 回', screen.length === 1 && screen[0].outcome === 'ok' && readyCalls.length === 1 && readyCalls[0].startedAt === 1 && readyCalls[0].outcome === 'ok');
  notices.finished('b', 'error', 20, { startedAt: 5 });
  t.ok('失敗も同じく知らせる（outcome: error）', screen.length === 2 && screen[1].outcome === 'error' && readyCalls[1].outcome === 'error');
  notices.finished('c', 'aborted', 30);
  t.ok('中断は知らせない', screen.length === 2 && readyCalls.length === 2);
  busy.v = true;
  notices.finished('d', 'ok', 40);
  t.ok('子が動いている間は保留（離れた端末にも出さない）', screen.length === 2 && readyCalls.length === 2);
  busy.v = false; busy.connected = false;
  notices.changed('d');
  t.ok('画面が居なくても、落ち着いた時点で離れた端末へ 1 回（画面の分は保留のまま）', readyCalls.length === 3 && readyCalls[2].sessionId === 'd' && screen.length === 2);
  notices.changed('d'); notices.changed();
  t.ok('離れた端末への通知は二重にならない', readyCalls.length === 3);
  busy.connected = true;
  notices.changed();
  t.ok('画面がつながったら、保留していた分が 1 回届く', screen.length === 3 && screen[2].sessionId === 'd' && readyCalls.length === 3);
  const throwing = createCompletionNotices({ busy: () => false, send: () => true, ready: () => { throw new Error('boom'); } });
  let thrown = false;
  try { throwing.finished('x', 'ok', 1); } catch { thrown = true; }
  t.ok('離れた端末への通知が投げても、画面への通知は止まらない', !thrown);

  // ── この PC の設定の保存 ──
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pleiad-notify-settings-'));
  try {
    const s = createNotifySettings({ dataDir: dir });
    t.ok('PC の設定の既定は 3 つとも入', JSON.stringify(await s.pc()) === JSON.stringify({ done: true, reply: true, failed: true }));
    await s.set({ failed: false });
    await s.set({ done: false, junk: 1 });
    const again = createNotifySettings({ dataDir: dir });
    t.ok('PC の設定は書いた項目だけ置き換わり、保存されて読み直せる', JSON.stringify(await again.pc()) === JSON.stringify({ done: false, reply: true, failed: false }));
    await fs.writeFile(path.join(dir, 'notify.json'), '{ broken');
    t.ok('壊れたファイルは既定に戻る', JSON.stringify(await createNotifySettings({ dataDir: dir }).pc()) === JSON.stringify({ done: true, reply: true, failed: true }));
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
  void crypto;
}
