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
