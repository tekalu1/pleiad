// prefs.json の computerUse（docs/computer-use.md「設定と会話のデータ」）。画面とサーバーで同じ検査と既定を使う。
// 形を検査して作り直す（知らない項目は捨てる）ので、画面から来た値をそのまま保存しない。

export const COMPUTER_APP_LIMIT = 500;
const ID_LIMIT = 1000;

export const DEFAULT_COMPUTER_USE = Object.freeze({ enabled: true, allowAllApps: false, introduced: false, alwaysAllowed: Object.freeze([]) });

/** 常に許可の 1 行。形が違えば null。kind は id の接頭辞（aumid: / exe:）と一致していなければならない */
export function computerAppRow(row) {
  if (!row || typeof row !== 'object') return null;
  const { id, name, kind, path, at } = row;
  if (typeof id !== 'string' || id.length > ID_LIMIT || typeof name !== 'string' || !name || name.length > 200) return null;
  const prefix = /^(exe|aumid):\S/.exec(id)?.[1];
  if (!prefix || kind !== prefix) return null;
  const out = { id, name, kind };
  if (path !== undefined) { if (typeof path !== 'string' || path.length > ID_LIMIT) return null; if (path) out.path = path; }
  if (at !== undefined) { if (typeof at !== 'string' || Number.isNaN(Date.parse(at))) return null; out.at = at; }
  return out;
}

/** 保存してある値（無い・壊れているときは既定）。読む側（画面・方針）はこれを通す */
export function computerUsePrefs(prefs) {
  const raw = prefs?.computerUse;
  const rows = [];
  if (raw && typeof raw === 'object' && Array.isArray(raw.alwaysAllowed)) {
    for (const row of raw.alwaysAllowed) {
      const clean = computerAppRow(row);
      if (clean && !rows.some(r => r.id === clean.id)) rows.push(clean);
    }
  }
  const flag = (key, fallback) => typeof raw?.[key] === 'boolean' ? raw[key] : fallback;
  return {
    enabled: flag('enabled', DEFAULT_COMPUTER_USE.enabled),
    allowAllApps: flag('allowAllApps', DEFAULT_COMPUTER_USE.allowAllApps),
    introduced: flag('introduced', DEFAULT_COMPUTER_USE.introduced),
    alwaysAllowed: rows.slice(0, COMPUTER_APP_LIMIT),
  };
}

/**
 * setPref { key: 'computerUse', value } の検査。渡された項目だけを current に重ねて作り直す。
 * 形が違えば null。渡されなかった項目（introduced など）は保存してある値を残す
 */
export function validComputerUse(value, current = DEFAULT_COMPUTER_USE) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const next = { ...current };
  for (const key of ['enabled', 'allowAllApps', 'introduced']) {
    if (value[key] === undefined) continue;
    if (typeof value[key] !== 'boolean') return null;
    next[key] = value[key];
  }
  if (value.alwaysAllowed !== undefined) {
    if (!Array.isArray(value.alwaysAllowed) || value.alwaysAllowed.length > COMPUTER_APP_LIMIT) return null;
    const rows = [];
    for (const row of value.alwaysAllowed) {
      const clean = computerAppRow(row);
      if (!clean) return null;
      if (!rows.some(r => r.id === clean.id)) rows.push(clean);
    }
    next.alwaysAllowed = rows;
  }
  return next;
}
