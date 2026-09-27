// 内蔵ブラウザーのアドレス欄（docs/inapp-browser.md）。DOM を使わない部分: 入力を URL に直す・見せ方に分ける・リンクの開き先。

/** この PC を指すホスト名（localhost・127.0.0.0/8・::1・0.0.0.0） */
export function isLocalHost(hostname) {
  const h = String(hostname ?? '').toLowerCase().replace(/^\[|\]$/g, '');
  return h === 'localhost' || h.endsWith('.localhost') || h === '::1' || h === '0.0.0.0' || /^127(?:\.\d{1,3}){3}$/.test(h);
}

/**
 * アドレス欄の入力を開く URL に直す。開けなければ null。
 * スキームが無ければ https。この PC（localhost:5173 など）は http。検索はしない（語だけの入力は null）
 */
export function normalizeAddress(input) {
  const text = String(input ?? '').trim();
  if (!text || /\s/.test(text)) return null;
  // localhost:5173 は「localhost」というスキームに読めるので、ホスト:ポートの形を先に見る
  const hostPort = /^(?:\[[0-9a-f:]+\]|[a-z0-9.-]+):\d{1,5}(?:[/?#]|$)/i.test(text);
  const scheme = !hostPort && /^([a-z][a-z0-9+.-]*):/i.exec(text)?.[1].toLowerCase();
  if (scheme) {
    if (scheme !== 'http' && scheme !== 'https' && scheme !== 'file') return null;
    try {
      const u = new URL(text);
      if (u.username || u.password) return null;
      if (scheme !== 'file' && !u.hostname) return null;
      return u.href;
    } catch { return null; }
  }
  let u;
  try { u = new URL(`http://${text}`); } catch { return null; }
  if (u.username || u.password || !u.hostname) return null;
  const local = isLocalHost(u.hostname);
  // ドットの無い語（検索語かもしれない）は開かない。localhost とポート付きは通す
  if (!local && !u.hostname.includes('.') && !hostPort) return null;
  if (!local) u.protocol = 'https:';
  return u.href;
}

/**
 * 見せ方。kind は secure（https）・local（この PC）・insecure（http）・file（PC のファイル）・blank（空のタブ）。
 * アドレス欄はスキームと残りを弱く、ホスト名を強くする
 */
export function addressParts(url) {
  if (!url) return { kind: 'blank', scheme: '', host: '', rest: '' };
  let u;
  try { u = new URL(url); } catch { return { kind: 'insecure', scheme: '', host: String(url), rest: '' }; }
  if (u.protocol === 'file:') {
    let file = decodeURIComponent(u.pathname);
    if (/^\/[a-z]:\//i.test(file)) file = file.slice(1);
    return { kind: 'file', scheme: '', host: '', rest: file };
  }
  const rest = `${u.pathname === '/' && !u.search && !u.hash ? '' : u.pathname}${u.search}${u.hash}`;
  const kind = isLocalHost(u.hostname) ? 'local' : u.protocol === 'https:' ? 'secure' : 'insecure';
  return { kind, scheme: `${u.protocol}//`, host: u.host, rest };
}

/** タブの見出し。題が無ければホスト名、それも無ければ空（呼び出し側が「新しいタブ」にする） */
export function tabLabel(tab) {
  if (tab?.title && tab.title !== tab.url) return tab.title;
  const parts = addressParts(tab?.url);
  return parts.kind === 'file' ? parts.rest.split('/').at(-1) : parts.host;
}

/** 設定の値（prefs.json の linkOpen）。既定は内蔵ブラウザー */
export const LINK_OPEN_VALUES = ['inapp', 'external'];
export function linkOpenPref(prefs) {
  return prefs?.linkOpen === 'external' ? 'external' : 'inapp';
}
/**
 * リンクの開き先。内蔵ブラウザーはデスクトップ版のホストの画面だけ（available）。
 * それ以外の画面では設定によらず external（今どおり新しいタブか既定のブラウザー）
 */
export function linkOpenTarget({ available = false, prefs } = {}) {
  return available && linkOpenPref(prefs) === 'inapp' ? 'inapp' : 'external';
}
