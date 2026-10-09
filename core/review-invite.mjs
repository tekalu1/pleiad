#!/usr/bin/env node
// 審査の招待を作る・見る・取り消すコマンド（ADR 0172 の決定 3、docs/play-store/review-host.md）。
//
//   node core/review-invite.mjs init                    審査用のホストの最初の設定（中継の URL と登録用の秘密を設定ファイルへ）
//   node core/review-invite.mjs create [--days 90]      招待を作る（今ある招待は置き換わり、入っていた端末は切れる）
//   node core/review-invite.mjs show [--code-only]     残りの日数・端末の数・ペアリングのコード（pleiad://pair?...）
//   node core/review-invite.mjs revoke                  取り消す（入った端末もすべて切れる）
//   node core/review-invite.mjs serve [--port 8081] [--bind 127.0.0.1]   QR の画像を固定の URL で配る（任意）
//
// 審査モード（AGENT_HOST_REVIEW=1）のときだけ動く。データ置き場は AGENT_HOST_DATA（サーバーと同じ）。
// 取り消し・作り直しは、動いているホストが 10 秒ほどで記録を読み直して端末を切る（ホストが止まっていれば次の起動で）。
// 出力は運用する人が読むもので、英語にそろえてある（画面の文言ではない）。
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { createRemoteStore } from './remote/devices.mjs';
import { defaultCipher } from './secret-store.mjs';
import { pairingPayload, normalizeRelayUrl } from './remote/pairing.mjs';
import { hkdfLabel } from './remote/noise.mjs';
import {
  isReviewMode, createInviteStore, loadInvite, inviteDaysLeft, parseInviteDays, INVITE_MAX_DEVICES, INVITE_DEFAULT_DAYS, INVITE_MAX_DAYS,
} from './remote/review-invite.mjs';
import qrcode from '../web/vendor/qrcode-generator.mjs';

export const REVIEW_HOST_NAME = 'Pleiad Review';

class UsageError extends Error {}

function parseArgs(argv) {
  const flags = {};
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { rest.push(a); continue; }
    const [name, inline] = a.slice(2).split('=', 2);
    if (inline !== undefined) flags[name] = inline;
    else if (['code-only'].includes(name)) flags[name] = true;
    else flags[name] = argv[++i] ?? '';
  }
  return { flags, rest };
}

const dataDirOf = env => path.resolve(env.AGENT_HOST_DATA || path.join(os.homedir(), '.agent-host'));

function requireReviewMode(env) {
  if (!isReviewMode(env)) throw new UsageError('Not in review mode. Set AGENT_HOST_REVIEW=1 (the review invite exists only on a review host).');
}

/** QR の中身（pleiad://pair?...）。中継の URL は設定ファイル、なければ環境変数。ホストの鍵が無ければここで作る（ホストの起動と同じ鍵になる）。 */
async function pairingCode(store, invite, env) {
  const settings = await store.settings();
  const relayUrl = normalizeRelayUrl(settings.relayUrl || env.AGENT_HOST_RELAY_URL || '');
  if (!relayUrl) throw new UsageError('The relay URL is not set. Run "init" first (AGENT_HOST_RELAY_URL).');
  const identity = await store.identity();
  const hostName = settings.hostName || REVIEW_HOST_NAME;
  return { relayUrl, hostId: identity.hostId, hostName, code: pairingPayload({ relayUrl, hostId: identity.hostId, publicKey: identity.publicKey, secret: invite.secret, hostName }) };
}

/** QR の画像（SVG）。 */
export function qrSvg(text) {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  return qr.createSvgTag(8, 16);
}

/** 画像の URL の道（`/qr/<token>.svg`）。招待の秘密から導くので、招待が続く間は変わらず、他人には推測できない。 */
export function qrPathFor(invite) {
  return `/qr/${hkdfLabel(invite.secret, 'pleiad review qr path').subarray(0, 12).toString('base64url')}.svg`;
}

/** QR の画像を返す HTTP サーバー（listen は呼び手）。道は qrPathFor の 1 本と /healthz だけ。招待が無い・切れていれば 404。 */
export function createQrServer({ store, invites, env = process.env, now = Date.now }) {
  return http.createServer(async (req, res) => {
    try {
      if (req.method === 'GET' && req.url === '/healthz') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end('ok'); }
      const record = await invites.get();
      const invite = record ? loadInvite(record, now()) : null;
      if (req.method === 'GET' && invite && !invite.expired && req.url === qrPathFor(invite)) {
        const { code } = await pairingCode(store, invite, env);
        res.writeHead(200, { 'content-type': 'image/svg+xml', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
        return res.end(qrSvg(code));
      }
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
    } catch { res.writeHead(500, { 'content-type': 'text/plain' }); res.end('error'); }
  });
}

async function describe(store, record, now) {
  const invite = loadInvite(record, now);
  if (!invite) return null;
  const devices = (await store.devices()).filter(d => d.invite === invite.id).length;
  return { invite, devices, line: invite.expired
    ? `Expired at ${new Date(invite.expiresAt).toISOString()}. Create a new one.`
    : `Expires ${new Date(invite.expiresAt).toISOString()} (${inviteDaysLeft(invite, now)} days left). Devices: ${devices}/${INVITE_MAX_DEVICES}.` };
}

const commands = {
  async init({ store, env, out }) {
    requireReviewMode(env);
    const relayUrl = normalizeRelayUrl(env.AGENT_HOST_RELAY_URL || '');
    // 削らずに検査する。削ってから保存すると、削らずに比べる中継と食い違い、「秘密が違う」とだけ出て理由が分からない
    const secret = String(env.AGENT_HOST_RELAY_SECRET || '');
    if (!relayUrl || !secret.trim()) throw new UsageError('Set AGENT_HOST_RELAY_URL and AGENT_HOST_RELAY_SECRET (the review relay) first.');
    if (/\s/.test(secret) || secret.length > 1024) throw new UsageError('AGENT_HOST_RELAY_SECRET must not contain spaces or line breaks (check for a trailing newline).');
    await store.setEnrollSecret(secret);
    await store.saveSettings({ enabled: true, relayUrl, hostName: String(env.AGENT_HOST_REVIEW_NAME || REVIEW_HOST_NAME).trim() || REVIEW_HOST_NAME });
    out(`Remote access is configured for ${relayUrl}.`);
  },

  async create({ store, invites, flags, env, out, now }) {
    requireReviewMode(env);
    let days;
    try { days = parseInviteDays(flags.days); } catch (e) { throw new UsageError(e.message); }
    const record = await invites.create({ now, days });
    const invite = loadInvite(record, now);
    const { code, hostId } = await pairingCode(store, invite, env);
    out(`Created the review invite (${days} days; the previous invite and the devices that entered through it are revoked within about 10 seconds).`);
    out(`Host: ${hostId}`);
    out(`Expires: ${new Date(invite.expiresAt).toISOString()}`);
    out('Pairing code:');
    out(code);
  },

  async show({ store, invites, flags, env, out, now }) {
    requireReviewMode(env);
    const record = await invites.get();
    const info = record ? await describe(store, record, now) : null;
    if (!info) throw new UsageError('There is no review invite. Create one with "create".');
    const { code, hostId, relayUrl } = await pairingCode(store, info.invite, env);
    if (flags['code-only']) return out(code);
    out(info.line);
    out(`Host: ${hostId}  Relay: ${relayUrl}`);
    out(`QR image URL path (when "serve" is exposed): ${qrPathFor(info.invite)}`);
    out('Pairing code (paste this into the Play Console access instructions):');
    out(code);
  },

  async revoke({ invites, env, out }) {
    requireReviewMode(env);
    const had = await invites.revoke();
    out(had ? 'Revoked the review invite. The host cuts the devices that entered through it within about 10 seconds.' : 'There was no review invite.');
  },

  /** QR の画像を HTTP で配る。ホストとは別のプロセスで、招待の記録を読むだけ。 */
  async serve({ store, invites, flags, env, out }) {
    requireReviewMode(env);
    const port = Number(flags.port || env.REVIEW_QR_PORT || 8081);
    const bind = String(flags.bind || '127.0.0.1');
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new UsageError('Invalid --port.');
    const server = createQrServer({ store, invites, env });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, bind, resolve); });
    out(`Serving the QR image on ${bind}:${port}. Run "show" to see its path.`);
    await new Promise(() => {});   // 止められるまで動く
  },
};

/** コマンドを走らせる。試験からも呼べるよう、環境と出力を引数にしてある。 */
export async function main(argv, { env = process.env, out = line => console.log(line), now = Date.now() } = {}) {
  const { flags, rest } = parseArgs(argv);
  const name = rest[0];
  if (!name || !Object.hasOwn(commands, name)) {
    throw new UsageError(`Usage: node core/review-invite.mjs <init|create|show|revoke|serve> [options]\n  create [--days ${INVITE_DEFAULT_DAYS}]  (1 to ${INVITE_MAX_DAYS} days)\n  show [--code-only]\n  serve [--port 8081] [--bind 127.0.0.1]`);
  }
  const store = createRemoteStore({ dataDir: dataDirOf(env), cipher: defaultCipher() });
  await commands[name]({ store, invites: createInviteStore(store.secrets), flags, env, out, now });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    () => process.exit(0),
    e => { console.error(e instanceof UsageError ? e.message : `Error: ${e.message}`); process.exit(e instanceof UsageError ? 2 : 1); },
  );
}
