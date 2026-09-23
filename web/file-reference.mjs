// Shared by the Markdown renderer and the authenticated file endpoint.
// A reference is a path, never a browser-relative navigation target.
export function fileReference(value) {
  if (typeof value !== 'string') return null;
  let raw = value.trim();
  if (!raw || raw.length > 8192 || /[\u0000-\u001f\u007f]/.test(raw)) return null;
  if (/^\/local-file\?/.test(raw)) {
    try { raw = new URL(raw, 'http://local').searchParams.get('path') ?? ''; } catch { return null; }
  } else if (/^file:/i.test(raw)) {
    try {
      const url = new URL(raw);
      if (url.hostname && url.hostname !== 'localhost') return null;
      raw = decodeURIComponent(url.pathname) + url.hash;
      if (/^\/[a-z]:\//i.test(raw)) raw = raw.slice(1);
    } catch { return null; }
  }
  if (!raw || /^[\\/]{2}/.test(raw) || /[\u0000-\u001f\u007f]/.test(raw)) return null;
  if (/^\/[a-z]:[\\/]/i.test(raw)) raw = raw.slice(1);
  if (/^[#?]/.test(raw)) return null;
  const position = /(?::(\d+)(?::\d+)?|#L(\d+)(?:-L?\d+)?)$/.exec(raw);
  const line = position ? Number(position[1] || position[2]) : null;
  if (position) raw = raw.slice(0, position.index);
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw) && !/^[a-z]:[\\/]/i.test(raw)) return null;
  if (!raw) return null;
  return { path: raw, line: Number.isSafeInteger(line) && line > 0 ? line : null };
}

export function fileDownloadUrl(path) {
  return `/local-file?path=${encodeURIComponent(path)}&download=1`;
}

// ---- 自動リンク用の厳しい判定（docs/mockups/file-actions.html §4）
// fileReference は書き手が明示したリンクの中で使う寛容なもの（サーバーも使う）。地の文やインラインコードに
// そのまま当てると Node.js や and/or までパスになるので、こちらは「パスと断定できるもの」だけを通す。
// 存在は確かめない（押したときに右パネルが確かめる）。

// core/file-preview.mjs の TEXT・IMAGES と PDF、よく使うコードの拡張子
const KNOWN_EXT = new Set(('md markdown mdx txt text log csv tsv html htm css scss less js mjs cjs jsx ts tsx mts cts json jsonc json5 ' +
  'yaml yml toml xml svg py rb rs go java kt swift php lua c h cpp hpp cs sh bash zsh ps1 psm1 bat cmd sql ini cfg conf env ' +
  'vue svelte ipynb lock png jpg jpeg gif webp avif ico pdf').split(' '));
const POSITION = /(?::(\d+)(?::\d+)?|#L(\d+)(?:-L?\d+)?)$/;
const SEGMENT = String.raw`[\p{L}\p{N}_.@+$%&=~-]+`;
const RELATIVE_SHAPE = new RegExp(String.raw`^\/?(?:${SEGMENT}[\\/])+${SEGMENT}$`, 'u');

function withPosition(raw) {
  const m = POSITION.exec(raw);
  const line = m ? Number(m[1] || m[2]) : null;
  return { path: m ? raw.slice(0, m.index) : raw, line: Number.isSafeInteger(line) && line > 0 ? line : null };
}
const hasKnownExt = p => {
  const m = /\.([A-Za-z0-9]{1,8})$/.exec(p.split(/[\\/]/).at(-1) ?? '');
  return !!m && KNOWN_EXT.has(m[1].toLowerCase());
};

/**
 * インラインコードの中身全体が 1 つのパスか。{ path, line } か null。
 * 通すのは (a) ドライブ文字始まり（空白可） (b) ./ ../ 始まり (c) 区切りを含み、最後の要素が既知の拡張子。
 * ~/ ・UNC・スキーム付き・空白（(a) 以外）・<>|"*? を含むものは通さない。
 */
export function looksLikePath(value) {
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  if (!raw || raw.length > 1024 || /[\u0000-\u001f\u007f<>|"*?]/.test(raw)) return null;
  if (/^[\\/]{2}/.test(raw) || raw.startsWith('~')) return null;
  const { path, line } = withPosition(raw);
  if (!path) return null;
  if (/^[A-Za-z]:[\\/][^\\/]/.test(path)) return path.slice(2).includes(':') ? null : { path, line };
  if (/\s/.test(path) || path.includes(':')) return null;
  if (/^\.\.?[\\/][^\\/]/.test(path)) return { path, line };
  // 区切りの間はパスらしい文字だけ（日本語などの文字は通す。記号の多い式・正規表現・末尾の区切りは落とす）
  if (!RELATIVE_SHAPE.test(path)) return null;
  return hasKnownExt(path) ? { path, line } : null;
}

// 地の文の Windows の絶対パス。ASCII のパスの文字で止める（日本語・空白・括弧・引用符で切れる）
// web/render.mjs の inline() も同じ形を 1 つの記法として使う（強調の _ などでパスが途中で切れないように）
export const WINDOWS_PATH_SOURCE = String.raw`(?<![A-Za-z0-9_\\/.:%$&=~@+-])[A-Za-z]:[\\/][A-Za-z0-9_.\\/@+$%&=~-]*(?::\d+(?::\d+)?|#L\d+)?`;
const WINDOWS_PATH = new RegExp(WINDOWS_PATH_SOURCE, 'g');

/**
 * 地の文から Windows の絶対パスを拾う。[{ start, end, path, line }]（end は含まない）。
 * 末尾の . , ; ! は文の句読点として外す。ドライブ直下だけ（D:\）は拾わない。
 */
export function findWindowsPaths(text) {
  const s = String(text ?? '');
  if (s.length > 100_000 || !/[A-Za-z]:[\\/]/.test(s)) return [];
  const found = [];
  for (const m of s.matchAll(WINDOWS_PATH)) {
    const raw = m[0].replace(/[.,;!]+$/, '');
    const { path, line } = withPosition(raw);
    if (!/^[A-Za-z]:[\\/][^\\/]/.test(path) || /[\\/]{2}/.test(path.slice(2))) continue;
    found.push({ start: m.index, end: m.index + raw.length, path, line });
  }
  return found;
}

/** パスの最後の要素（表示名） */
export function baseName(path) {
  return String(path ?? '').replace(/[\\/]+$/, '').split(/[\\/]/).at(-1) || String(path ?? '');
}

/** パスのフォルダー部分（末尾の区切りを残す）。区切りが無ければ空 */
export function dirName(path) {
  const s = String(path ?? '').replace(/[\\/]+$/, '');
  const at = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
  return at < 0 ? '' : s.slice(0, at + 1);
}
