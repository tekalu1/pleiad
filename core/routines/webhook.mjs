// POST /hooks/<hookId> は画面の認証より前で受け、成否にかかわらず空の 202 を返す。
// 署名は生のバイト列で検査する。受信口のログや HTTP の応答に秘密や本文を載せない。
import crypto from 'node:crypto';
import path from 'node:path';
import { createSecretStore, defaultCipher } from '../secret-store.mjs';
import { createRateLimit } from '../os-open.mjs';
import { routinePayloadEnvelope } from '../channels/types.mjs';
import { agentT } from '../i18n.mjs';

export const BODY_MAX = 256 * 1024;
export const CLOCK_WINDOW_MS = 5 * 60_000;
export const REPLAY_WINDOW_MS = 10 * 60_000;

function readBody(req) {
  return new Promise((resolve) => {
    let chunks = [], size = 0;
    const finish = (body) => {
      clearTimeout(timer);
      req.off('data', data); req.off('end', end); req.off('error', error); req.off('aborted', error);
      chunks = [];
      req.resume();
      resolve(body);
    };
    const data = (chunk) => {
      size += chunk.length;
      if (size > BODY_MAX) finish(null);
      else chunks.push(chunk);
    };
    const end = () => finish(Buffer.concat(chunks, size));
    const error = () => finish(null);
    const timer = setTimeout(error, 10_000);
    timer.unref?.();
    req.on('data', data); req.once('end', end); req.once('error', error); req.once('aborted', error);
  });
}

export function createWebhookReceiver({ dataDir, routines, host, now = Date.now, cipher = defaultCipher() } = {}) {
  const secrets = createSecretStore({ file: path.join(dataDir, 'webhook-secrets.json'), cipher });
  const slots = new Map();
  let closed = false;
  const accept = (res) => {
    if (!res.headersSent && !res.destroyed) {
      res.writeHead(202, { 'content-length': '0', 'cache-control': 'no-store' });
      res.end();
    }
  };
  return {
    start: () => secrets.migrate(),
    stop() { closed = true; slots.clear(); },
    async handle(req, res) {
      const pathname = String(req.url ?? '').split('?')[0];
      if (pathname !== '/hooks' && !pathname.startsWith('/hooks/')) return false;
      req.on('error', () => {});
      try {
        const match = /^\/hooks\/(h_[a-z0-9]+)$/.exec(pathname);
        if (closed || req.method !== 'POST' || !match) { req.resume(); accept(res); return true; }
        const hookId = match[1];
        const list = await routines.list();
        const hooks = new Set(list.filter((r) => r.trigger.kind === 'webhook').map((r) => r.trigger.hookId));
        for (const id of slots.keys()) if (!hooks.has(id)) slots.delete(id);
        const routine = list.find((r) => r.trigger.kind === 'webhook' && r.trigger.hookId === hookId);
        if (!routine) { req.resume(); accept(res); return true; }
        let slot = slots.get(hookId);
        if (!slot) { slot = { allow: createRateLimit({ limit: 30, windowMs: 60_000, now }), seen: new Map() }; slots.set(hookId, slot); }
        if (!slot.allow() || Number(req.headers['content-length']) > BODY_MAX) { req.resume(); accept(res); return true; }
        const body = await readBody(req);
        accept(res);
        if (closed || !body) return true;
        const secret = await secrets.get(hookId);
        if (typeof secret !== 'string' || !secret) return true;
        const pleiad = req.headers['x-pleiad-signature'];
        const signature = pleiad ?? req.headers['x-hub-signature-256'];
        if (typeof signature !== 'string' || !/^sha256=[a-fA-F0-9]{64}$/.test(signature)) return true;
        const mac = crypto.createHmac('sha256', secret);
        if (pleiad !== undefined) {
          const timestamp = req.headers['x-pleiad-timestamp'];
          // Unix time in seconds. The exact header text is part of the signature.
          if (typeof timestamp !== 'string' || !/^\d{1,12}$/.test(timestamp) || Math.abs(now() - Number(timestamp) * 1000) > CLOCK_WINDOW_MS) return true;
          mac.update(`${timestamp}.`);
        }
        const expected = mac.update(body).digest();
        const actual = Buffer.from(signature.slice(7), 'hex');
        if (!crypto.timingSafeEqual(expected, actual)) return true;
        const key = actual.toString('hex');
        for (const [value, at] of slot.seen) if (now() - at >= REPLAY_WINDOW_MS) slot.seen.delete(value);
        if (slot.seen.has(key)) return true;
        slot.seen.set(key, now()); // Reserve before awaiting fire, including paused/skipped executions.
        const note = `${agentT(host?.currentLocale?.() ?? 'ja', 'routine.payloadNote')}\n${routinePayloadEnvelope({ source: 'webhook', hook: hookId, at: new Date(now()).toISOString(), text: body.toString('utf8') })}`;
        await routines.fire(routine.id, { source: 'webhook', note });
      } catch {
        req.resume();
        accept(res);
      }
      return true;
    },
  };
}
