// 外部 MCP の OAuth で「探索で見つけた URL」を取りに行く前の検査（SSRF 対策）。
//
// 保護リソースメタデータ（PRM）・認可サーバーのメタデータ・token / registration / revocation などの URL は、
// 利用者が登録した MCP の URL ではなく、MCP や認可サーバーが返した値から決まる。悪意のある（または乗っ取られた）
// MCP が、社内のアドレスやクラウドのメタデータ（169.254.169.254 など）を指して Pleiad に取りに行かせることができるので、
// 次の規則で絞る。
//   - https 必須。http はループバック宛てのものだけ、しかも MCP 本体がループバックのときだけ許す
//     （手元で動かす開発用の MCP と認可サーバーの組）。
//   - MCP 本体が公開アドレスなら、探索先がプライベート・リンクローカル・ループバックなどに解決されるものは拒む。
//     MCP 本体が社内（プライベート）にあるなら、認可サーバーも社内にあるのが普通なので解決先は問わない。
//   - リダイレクトは自分で 1 回ずつ検査して追う（GET / HEAD だけ。POST のリダイレクトは追わない）。
//   - 名前を解決して検査したときは、その答え（IP の並び）に固定して接続する（DNS rebinding の対策）。
//     wrap は fetch に init.pinnedAddresses を渡し、core/pinned-fetch.mjs がそのアドレスにだけ接続する。
import dns from 'node:dns/promises';
import net from 'node:net';
import { t } from './i18n.mjs';

const MAX_REDIRECTS = 5;

/** 検査で拒んだ。message は利用者に見せる理由 */
export class UrlRejected extends Error {
  constructor(message) { super(message); this.code = 'MCP_URL_REJECTED'; }
}

const LOOPBACK_NAMES = new Set(['localhost', 'localhost.', 'ip6-localhost', 'ip6-loopback']);
const bareHost = hostname => hostname.replace(/^\[|\]$/g, '').toLowerCase();

/** IP アドレスの種類。public 以外は「公開の MCP から誘導されて取りに行ってはいけない」宛先 */
export function addressKind(address) {
  const ip = bareHost(address);
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 127) return 'loopback';
    if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return 'private';
    if (a === 169 && b === 254) return 'link-local';
    if (a === 100 && b >= 64 && b <= 127) return 'private'; // CGNAT（RFC 6598）
    if (a === 0) return 'unspecified';
    if (a >= 224) return 'reserved'; // マルチキャストと予約
    if (a === 192 && b === 0 && ip.startsWith('192.0.0.')) return 'reserved';
    if ((a === 198 && (b === 18 || b === 19))) return 'reserved'; // ベンチマーク用（RFC 2544）
    return 'public';
  }
  if (net.isIPv6(ip)) {
    if (ip === '::1') return 'loopback';
    if (ip === '::') return 'unspecified';
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(ip) ?? /^::(\d+\.\d+\.\d+\.\d+)$/.exec(ip);
    if (mapped) return addressKind(mapped[1]);
    const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(ip);
    if (hex) { const n = (parseInt(hex[1], 16) << 16) | parseInt(hex[2], 16); return addressKind([n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.')); }
    const first = parseInt(ip.split(':')[0] || '0', 16);
    if ((first & 0xfe00) === 0xfc00) return 'private';      // ユニークローカル fc00::/7
    if ((first & 0xffc0) === 0xfe80) return 'link-local';   // fe80::/10
    if ((first & 0xff00) === 0xff00) return 'reserved';     // マルチキャスト
    if (first === 0x2001 && ip.split(':')[1] === 'db8') return 'reserved'; // 文書用
    // NAT64（64:ff9b::/96）は末尾 32 ビットの IPv4 として見る
    if (ip.startsWith('64:ff9b::')) { const tail = ip.split(':'); return addressKind(tail.at(-1).includes('.') ? tail.at(-1) : `::ffff:${tail.slice(-2).join(':')}`); }
    return 'public';
  }
  return 'unknown';
}

/** 名前を解決せずに分かる範囲でループバックか（localhost と 127.0.0.0/8・::1） */
export function isLoopbackHost(hostname) {
  const host = bareHost(hostname);
  return LOOPBACK_NAMES.has(host) || host.endsWith('.localhost') || (net.isIP(host) !== 0 && addressKind(host) === 'loopback');
}

async function resolveAll(hostname, lookup) {
  const host = bareHost(hostname);
  if (net.isIP(host)) return [host];
  const found = await lookup(host, { all: true, verbatim: true });
  return (Array.isArray(found) ? found : [found]).map(a => typeof a === 'string' ? a : a.address);
}

/** アドレスの種類の表示名（net.addressKind.*。知らない種類はそのまま） */
// i18n-dynamic: net.addressKind.
const kindLabel = kind => t(`net.addressKind.${kind}`, { defaultValue: kind });

/**
 * MCP 本体の URL を基準にした検査器。
 * @param {object} o
 * @param {string} o.serverUrl 利用者が登録した MCP の URL
 * @param {(host: string, opts: object) => Promise<Array<{address: string}>>} [o.lookup] 名前解決（テストで差し替える）
 */
export function createUrlGuard({ serverUrl, lookup = dns.lookup }) {
  const server = new URL(serverUrl);
  const serverLoopback = isLoopbackHost(server.hostname);
  let serverPublic;
  async function mcpIsPublic() {
    if (serverLoopback) return false;
    // MCP 本体が解決できないときは、厳しい方（公開）に倒す
    serverPublic ??= resolveAll(server.hostname, lookup).then(list => list.every(a => addressKind(a) === 'public'), () => true);
    return serverPublic;
  }
  /** 検査して、名前を解決して確かめたときはその答えも返す（接続をそのアドレスに固定するため） */
  async function inspect(target, label = t('net.guard.defaultLabel')) {
    let u;
    try { u = new URL(target); } catch { throw new UrlRejected(t('net.guard.invalid', { label })); }
    const shown = `${u.origin}${u.pathname}`.slice(0, 200);
    if (u.username || u.password) throw new UrlRejected(t('net.guard.credentials', { label, url: shown }));
    if (u.protocol === 'http:') {
      if (!(serverLoopback && isLoopbackHost(u.hostname))) throw new UrlRejected(t('net.guard.httpLoopbackOnly', { label, url: shown }));
      return { url: u, addresses: null };
    }
    if (u.protocol !== 'https:') throw new UrlRejected(t('net.guard.notHttps', { label, url: shown }));
    if (await mcpIsPublic()) {
      let addresses;
      try { addresses = await resolveAll(u.hostname, lookup); }
      catch { throw new UrlRejected(t('net.guard.unresolved', { label, url: shown })); }
      const bad = addresses.map(a => [a, addressKind(a)]).find(([, kind]) => kind !== 'public');
      if (bad) throw new UrlRejected(t('net.guard.internal', { label, url: shown, kind: kindLabel(bad[1]), address: bad[0] }));
      // IP の直書きは解決し直されないので固定は要らない
      return { url: u, addresses: net.isIP(bareHost(u.hostname)) ? null : addresses };
    }
    return { url: u, addresses: null };
  }
  const check = async (target, label) => (await inspect(target, label)).url;
  /**
   * fetch を包む。行き先を検査し、リダイレクトは GET / HEAD だけ検査しながら追う。
   * 名前を解決して検査した行き先には init.pinnedAddresses を付ける（fetchFn は core/pinned-fetch.mjs の pinnedFetch を想定）
   */
  function wrap(fetchFn, label) {
    return async (input, init = {}) => {
      let url = String(input instanceof Request ? input.url : input);
      let method = (init.method ?? 'GET').toUpperCase();
      let current = { ...init };
      for (let hop = 0; ; hop++) {
        const { addresses } = await inspect(url, label);
        const res = await fetchFn(url, { ...current, redirect: 'manual', ...(addresses ? { pinnedAddresses: addresses } : {}) });
        if (res.status < 300 || res.status >= 400 || res.status === 304) return res;
        const location = res.headers.get('location');
        if (!location) return res;
        await res.body?.cancel().catch(() => {});
        if (method !== 'GET' && method !== 'HEAD') throw new UrlRejected(t('net.guard.redirect', { label: label ?? t('net.guard.authServer'), method }));
        if (hop >= MAX_REDIRECTS) throw new UrlRejected(t('net.guard.tooManyRedirects'));
        url = new URL(location, url).href;
        current = { ...current, method };
      }
    };
  }
  return { check, inspect, wrap, serverLoopback };
}
