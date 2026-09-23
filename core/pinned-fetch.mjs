// 検査で得た IP アドレスに固定して接続する fetch（DNS rebinding の対策。core/mcp-url-guard.mjs が使う）。
//
// 探索先の URL は、取りに行く前に名前を解決して「内部のアドレスを指していないか」を検査する。ところが Node の fetch は
// 接続のときにもう一度名前を解決するので、検査の後に DNS の答えを内部のアドレスへ差し替えられると（rebinding）、
// 検査を素通りして内部へ接続してしまう。Node の fetch には接続先を固定する口が無い（dispatcher は undici の依存が要る）ので、
// init.pinnedAddresses があるときだけ node:http(s) で自前に要求を出し、名前解決（lookup）を検査で得たアドレスに差し替える。
// TLS の SNI と証明書の検証は URL の名前のまま行う（host に名前を渡し、lookup だけを差し替える）。
// pinnedAddresses が無ければ、ふつうの fetch に渡す。
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { Readable } from 'node:stream';
import { t } from './i18n.mjs';

const NO_BODY = new Set([101, 204, 205, 304]);

/** 名前解決を固定のアドレスに差し替える lookup。net.connect は all: true（autoSelectFamily）でも呼ぶ */
export function pinnedLookup(addresses) {
  const list = addresses.map(address => ({ address, family: net.isIPv6(address) ? 6 : 4 }));
  return (hostname, options, callback) => {
    if (typeof options === 'function') { callback = options; options = {}; }
    const family = typeof options === 'number' ? options : options?.family;
    const usable = family === 4 || family === 6 ? list.filter(a => a.family === family) : list;
    if (!usable.length) {
      const error = Object.assign(new Error(t('net.pinned.noFamily', { host: hostname, family })), { code: 'ENOTFOUND' });
      return process.nextTick(callback, error);
    }
    if (options?.all) return process.nextTick(callback, null, usable);
    process.nextTick(callback, null, usable[0].address, usable[0].family);
  };
}

async function bodyBytes(body, headers) {
  if (body === undefined || body === null) return null;
  if (typeof body === 'string') return Buffer.from(body);
  if (body instanceof URLSearchParams) {
    if (!headers.has('content-type')) headers.set('content-type', 'application/x-www-form-urlencoded;charset=UTF-8');
    return Buffer.from(body.toString());
  }
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  if (ArrayBuffer.isView(body)) return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  if (typeof Blob !== 'undefined' && body instanceof Blob) {
    if (body.type && !headers.has('content-type')) headers.set('content-type', body.type);
    return Buffer.from(await body.arrayBuffer());
  }
  throw new TypeError(t('net.pinned.bodyType'));
}

/**
 * fetch と同じ呼び方。init.pinnedAddresses（検査で得た IP の並び）があれば、そのアドレスにだけ接続する。
 * redirect は追わない（'manual' 相当。検査しながら追うのは呼び出し側 = mcp-url-guard の wrap）
 */
export async function pinnedFetch(input, init = {}, { fetchFn = fetch } = {}) {
  const { pinnedAddresses, ...rest } = init;
  if (!pinnedAddresses?.length) return fetchFn(input, rest);
  const url = new URL(String(input instanceof Request ? input.url : input));
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new TypeError(t('net.pinned.protocol', { protocol: url.protocol }));
  const method = (rest.method ?? 'GET').toUpperCase();
  const headers = new Headers(rest.headers ?? {});
  const body = await bodyBytes(rest.body, headers);
  if (body) headers.set('content-length', String(body.length));
  // 圧縮の展開はしない（fetch と違って自前で展開しないため、圧縮しないよう頼む）
  headers.set('accept-encoding', 'identity');
  if (!headers.has('accept')) headers.set('accept', '*/*');
  const signal = rest.signal ?? undefined;
  signal?.throwIfAborted();
  const lib = url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = lib.request({
      protocol: url.protocol, hostname: url.hostname.replace(/^\[|\]$/g, ''), port: url.port || undefined,
      path: `${url.pathname}${url.search}`, method, headers: Object.fromEntries(headers),
      lookup: pinnedLookup(pinnedAddresses),
      // 接続を使い回さない（使い回すと、別の要求の固定が効かない接続に乗ることがある）
      agent: false,
      ...(url.protocol === 'https:' ? { servername: net.isIP(url.hostname.replace(/^\[|\]$/g, '')) ? undefined : url.hostname } : {}),
      signal,
    }, res => {
      const out = new Headers();
      for (const [key, value] of Object.entries(res.headers)) for (const v of [].concat(value)) out.append(key, v);
      const status = res.statusCode ?? 0;
      const empty = NO_BODY.has(status) || method === 'HEAD';
      if (empty) res.resume();
      let response;
      try { response = new Response(empty ? null : Readable.toWeb(res), { status, statusText: res.statusMessage ?? '', headers: out }); }
      catch (e) { res.destroy(); return reject(e); }
      Object.defineProperty(response, 'url', { value: url.href });
      resolve(response);
    });
    req.on('error', reject);
    if (body) req.end(body); else req.end();
  });
}
