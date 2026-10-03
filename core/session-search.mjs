// セッション検索（会話の本文まで）。画面・MCP・CLI が同じ search(input) を呼ぶ（docs/design.md「セッション検索」・ADR 0080）。
//
// 方式: 索引は作らず、本文の写しをメモリに持って都度走査する。
//   - 前半は DOM にも I/O にも触らない純粋な部分（語の解釈・照合・関連度・抜粋）。tests が直接呼ぶ。
//   - 後半 createSessionSearch が写し（Map<id, { sig, msgs }>）を持ち、裏で読み込み、search() に答える。
//     一覧（listSessions）と本文の読み方（readStored / readFull）は呼び出し側が渡す。
//
// 照合: 空白区切りは AND（語ごとに題・状態・場所・どの発言に当たってもよい）。"…" で囲んだ語は畳まずそのまま、
// ほかは NFKC と小文字に畳んだ部分一致。場所は作業ディレクトリのフォルダー名だけに当てる。

const DAY_MS = 86_400_000;
// 新しさの減点の上限（30 日で 1、3 まで = 90 日以上は同じ）
const MAX_AGE_PENALTY = 3;
const MAX_TERMS = 12;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const DEFAULT_HITS = 1;
const MAX_HITS = 10;
// 抜粋: 最初の一致の手前から窓を切る
const EXCERPT_LEAD = 16;
const EXCERPT_LENGTH = 140;
// ツールの入力（既定では対象外）は、短い項目だけを 400 字まで写す
const TOOL_INPUT_KEYS = ["command", "cmd", "file_path", "path", "notebook_path", "pattern", "url"];
const TOOL_INPUT_CHARS = 400;
const MAX_RANGES = 50;
const ABSENT_LISTINGS = 3;

// ------------------------------------------------------------------ 純粋な部分

/** 畳む。全角半角・互換文字を同一視し、大小を区別しない */
export const fold = (s) => String(s ?? "").normalize("NFKC").toLowerCase();

/**
 * 検索語を解く。空白（全角を含む）で区切り、"…" の中は 1 語で畳まない（exact）。
 * 閉じていない " は、そこから最後までを 1 語とする。空の語は捨てる。同じ語は 1 つにする。
 * @returns {Array<{ raw: string, exact: boolean, needle: string }>}
 */
export function parseQuery(query) {
  const s = String(query ?? "");
  const terms = [];
  const seen = new Set();
  const push = (raw, exact) => {
    if (!raw) return;
    const needle = exact ? raw : fold(raw);
    if (!needle) return;
    const key = `${exact ? "e" : "f"}\0${needle}`;
    if (seen.has(key)) return;
    seen.add(key);
    terms.push({ raw, exact, needle });
  };
  let i = 0;
  while (i < s.length) {
    if (/\s/.test(s[i])) { i++; continue; }
    if (s[i] === '"') {
      const close = s.indexOf('"', i + 1);
      const end = close < 0 ? s.length : close;
      push(s.slice(i + 1, end), true);
      i = close < 0 ? s.length : close + 1;
      continue;
    }
    let j = i;
    while (j < s.length && !/\s/.test(s[j]) && s[j] !== '"') j++;
    push(s.slice(i, j), false);
    i = j;
  }
  if (terms.length > MAX_TERMS) throw new RangeError(`too many search terms (max ${MAX_TERMS})`);
  return terms;
}

/** 作業ディレクトリのフォルダー名（絶対パスの途中の語には当てない） */
export function placeName(cwd) {
  if (typeof cwd !== "string") return "";
  const trimmed = cwd.replace(/[\\/]+$/, "");
  const at = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return at < 0 ? trimmed : trimmed.slice(at + 1);
}

/** 場所の絞り込み用。区切りと末尾の区切りの違いだけを吸収する完全一致 */
const samePath = (a, b) => typeof a === "string" && typeof b === "string"
  && a.replace(/\\/g, "/").replace(/\/+$/, "") === b.replace(/\\/g, "/").replace(/\/+$/, "");

/** 畳んだ文字の中の一致の位置（重なりを許さず、手前から） */
function occurrences(hay, needle, max = MAX_RANGES) {
  const out = [];
  if (!needle) return out;
  for (let at = hay.indexOf(needle); at >= 0 && out.length < max; at = hay.indexOf(needle, at + needle.length)) out.push([at, at + needle.length]);
  return out;
}

/** 重なる・接する範囲を 1 つにして手前から並べる */
export function mergeRanges(ranges) {
  const sorted = ranges.filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  const out = [];
  for (const [a, b] of sorted) {
    const last = out.at(-1);
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

/**
 * 元の文字を、結合文字（半角カナの濁点・半濁点を含む）までを 1 まとまりに区切って畳み、畳んだ文字の位置から元の位置へ戻す表を作る。
 * 畳むと長さが変わる文字（… → ...・半角カナの濁点）がある発言で、抜粋の位置を合わせるのに使う（一致した発言だけ）。
 */
function foldWithMap(original) {
  const chunks = [];
  let folded = "";
  for (const m of original.matchAll(/[\s\S][\p{M}\uFF9E\uFF9F]*/gu)) {
    const f = fold(m[0]);
    chunks.push({ o0: m.index, o1: m.index + m[0].length, f0: folded.length, f1: folded.length + f.length });
    folded += f;
  }
  const locate = (p) => {
    let lo = 0, hi = chunks.length - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (chunks[mid].f1 > p) hi = mid; else lo = mid + 1; }
    return chunks[lo];
  };
  return {
    folded,
    toOriginal: (a, b) => [locate(a).o0, locate(Math.max(a, b - 1)).o1],
  };
}

/**
 * 1 つの文字（発言の本文・ツールの入力）の中の、語ごとの一致の範囲を元の文字の位置で返す。
 * @param {string} original 元の文字
 * @param {string} folded 畳んだ文字（写しに持っているもの）
 * @param {Array} terms parseQuery の結果
 * @returns {Array<[number, number]>} 重なりを 1 つにした範囲
 */
export function findRanges(original, folded, terms) {
  const ranges = [];
  let map = null;
  for (const term of terms) {
    if (term.exact) { ranges.push(...occurrences(original, term.needle)); continue; }
    if (folded.length === original.length) { ranges.push(...occurrences(folded, term.needle)); continue; }
    map ??= foldWithMap(original);
    for (const [a, b] of occurrences(map.folded, term.needle)) ranges.push(map.toOriginal(a, b));
  }
  return mergeRanges(ranges);
}

/**
 * 抜粋を作る。最初の一致の手前 16 字から約 140 字。改行と連続する空白は 1 つに畳み、範囲も合わせて動かす。
 * @returns {{ excerpt: string, ranges: Array<[number, number]> }}
 */
export function makeExcerpt(original, ranges) {
  const first = ranges[0]?.[0] ?? 0;
  let start = Math.max(0, first - EXCERPT_LEAD);
  // 窓の端でサロゲートペアを割らない
  const isLow = (i) => { const c = original.charCodeAt(i); return c >= 0xdc00 && c <= 0xdfff; };
  if (start > 0 && isLow(start)) start++;
  let end = Math.min(original.length, start + EXCERPT_LENGTH);
  if (end < original.length && isLow(end)) end--;
  let out = "";
  const at = new Int32Array(end - start + 1);   // 元の位置（窓の中）→ 出力の位置
  let space = true;                              // 先頭の空白は捨てる
  for (let i = start; i < end; i++) {
    at[i - start] = out.length;
    if (/\s/.test(original[i])) {
      if (!space) { out += " "; space = true; }
      continue;
    }
    out += original[i];
    space = false;
  }
  at[end - start] = out.length;
  if (out.endsWith(" ")) out = out.slice(0, -1);
  const shown = [];
  for (const [a, b] of ranges) {
    if (b <= start || a >= end) continue;
    const s = at[Math.max(a, start) - start];
    const e = Math.min(at[Math.min(b, end) - start], out.length);
    if (e > s) shown.push([s, e]);
  }
  return { excerpt: out, ranges: mergeRanges(shown) };
}

/**
 * 関連度。題に当たった語 ×4・全部の語が 1 つの発言か題に揃えば +2・log2(1 + 一致した発言の数)・新しさの減点（30 日で 1。上限 3）。
 * 減点に上限があるので、題に当たった古い会話が、新しい本文だけの当たりの下へ沈み続けない。
 */
export function relevanceScore({ titleTerms, allInOne, hitCount, lastModified }, now) {
  const age = Number.isFinite(lastModified) ? Math.max(0, now - lastModified) / DAY_MS : 0;
  return titleTerms * 4 + (allInOne ? 2 : 0) + Math.log2(1 + hitCount) - Math.min(MAX_AGE_PENALTY, age / 30);
}

const timeOf = (at) => {
  if (Number.isFinite(at)) return at;
  const t = typeof at === "string" ? Date.parse(at) : NaN;
  return Number.isFinite(t) ? t : 0;
};

const bits = (mask) => { let n = 0; for (let m = mask; m; m &= m - 1) n++; return n; };

/** ツールの入力のうち、検索に使う短い項目を 1 つの文字にする（なければ ""） */
export function toolInputText(toolCalls) {
  const parts = [];
  for (const call of Array.isArray(toolCalls) ? toolCalls : []) {
    const input = call?.input;
    if (!input || typeof input !== "object") continue;
    for (const key of TOOL_INPUT_KEYS) {
      const v = input[key];
      const s = typeof v === "string" ? v : Array.isArray(v) && v.every((x) => typeof x === "string") ? v.join(" ") : "";
      if (s) parts.push(s.length > TOOL_INPUT_CHARS ? s.slice(0, TOOL_INPUT_CHARS) : s);
    }
  }
  return parts.join("\n");
}

/**
 * 会話の履歴（NormalizedMessage の配列）から、写しに持つ発言を取り出す。
 * 対象は人と AI の本文だけ。thinking・ツールの出力・圧縮の要約・システムの行（kind 付き）・完了通知は持たない。
 * ツールの入力は短い項目だけ別に持つ（includeToolInputs のときだけ当てる）。
 */
export function extractMessages(raw) {
  const msgs = [];
  (Array.isArray(raw) ? raw : []).forEach((m, index) => {
    if (!m || m.kind || m.internalTaskNotice) return;
    if (m.role !== "user" && m.role !== "assistant") return;
    const text = typeof m.text === "string" && m.text.trim() ? m.text : "";
    const tool = m.role === "assistant" ? toolInputText(m.toolCalls) : "";
    if (!text && !tool) return;
    const entry = { uuid: String(m.uuid ?? ""), index, role: m.role, at: m.at ?? null, text, folded: "" };
    if (text) { const f = fold(text); entry.folded = f === text ? text : f; }
    if (tool) { const f = fold(tool); entry.tool = tool; entry.toolFolded = f === tool ? tool : f; }
    msgs.push(entry);
  });
  return msgs;
}

const includesTerm = (term, original, folded) => (term.exact ? original.includes(term.needle) : folded.includes(term.needle));

/**
 * 1 つの会話を語に照らす。全部の語が（題・状態・場所・発言のどこかに）当たらなければ null。
 * @param {{ title, status, cwd }} meta
 * @param {Array} msgs extractMessages の結果
 * @param {Array} terms
 * @param {{ speaker: string, toolInputs: boolean, hits: number }} opts
 */
export function matchSession(meta, msgs, terms, opts) {
  const all = (1 << terms.length) - 1;
  const fields = { title: String(meta.title ?? ""), status: String(meta.status ?? ""), place: placeName(meta.cwd) };
  const folded = { title: fold(fields.title), status: fold(fields.status), place: fold(fields.place) };
  const fieldMask = { title: 0, status: 0, place: 0 };
  terms.forEach((term, i) => {
    for (const key of ["title", "status", "place"]) if (includesTerm(term, fields[key], folded[key])) fieldMask[key] |= 1 << i;
  });
  const titleMask = fieldMask.title;
  let seen = fieldMask.title | fieldMask.status | fieldMask.place;
  let textSeen = 0, toolSeen = 0, allInOne = false, hitCount = 0;
  // 抜粋に選ぶ発言の上位だけを持つ（全部の一致を溜めない）
  const top = [];
  const rank = (h) => [bits(h.mask & ~titleMask), bits(h.mask), timeOf(h.msg.at) || h.msg.index];
  const better = (a, b) => { const x = rank(a), y = rank(b); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i]; return false; };

  if (terms.length) for (const msg of msgs) {
    let mask = 0;
    if (msg.text && (opts.speaker === "any" || opts.speaker === msg.role)) {
      for (let i = 0; i < terms.length; i++) if (includesTerm(terms[i], msg.text, msg.folded)) mask |= 1 << i;
    }
    let toolMask = 0;
    if (opts.toolInputs && msg.tool && (opts.speaker === "any" || opts.speaker === msg.role)) {
      for (let i = 0; i < terms.length; i++) if (includesTerm(terms[i], msg.tool, msg.toolFolded)) toolMask |= 1 << i;
    }
    if (!mask && !toolMask) continue;
    textSeen |= mask; toolSeen |= toolMask;
    hitCount++;
    if ((mask | toolMask) === all) allInOne = true;
    // 本文に当たった発言は本文を、ツールの入力だけに当たった発言はその入力を抜粋にする
    const hit = { msg, mask: mask || toolMask, tool: !mask };
    let at = top.length;
    while (at > 0 && better(hit, top[at - 1])) at--;
    if (at < opts.hits) { top.splice(at, 0, hit); if (top.length > opts.hits) top.pop(); }
  }
  seen |= textSeen | toolSeen;
  if (seen !== all) return null;
  const matched = [];
  if (fieldMask.title) matched.push("title");
  if (fieldMask.status) matched.push("status");
  if (fieldMask.place) matched.push("place");
  if (textSeen) matched.push("message");
  if (toolSeen) matched.push("toolInput");
  // 全部の語が題に揃う会話も「揃う」に数える（古い会話の題の一致が、新しい本文だけの当たりの下へ沈まないように）
  return { titleTerms: bits(titleMask), allInOne: allInOne || (terms.length > 0 && titleMask === all), hitCount, matched, top };
}

/** 抜粋に選んだ発言を SearchResult の hit の形にする */
function buildHit({ msg, tool }, terms) {
  const original = tool ? msg.tool : msg.text;
  const folded = tool ? msg.toolFolded : msg.folded;
  const { excerpt, ranges } = makeExcerpt(original, findRanges(original, folded, terms));
  return { uuid: msg.uuid, index: msg.index, role: tool ? "tool" : msg.role, at: msg.at ?? "", excerpt, ranges };
}

const toMillis = (v, name) => {
  if (v === undefined || v === null || v === "") return null;
  const n = typeof v === "number" ? v : Date.parse(v);
  if (!Number.isFinite(n)) throw new TypeError(`invalid filters.${name}`);
  return n;
};

/** 入力の検査と既定値。壊れた入力は黙って直さず TypeError にする */
export function normalizeInput(input) {
  const i = input ?? {};
  if (typeof i !== "object") throw new TypeError("search input must be an object");
  if (i.query !== undefined && typeof i.query !== "string") throw new TypeError("query must be a string");
  const f = i.filters ?? {};
  const list = (v, name) => {
    if (v === undefined || v === null) return null;
    if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) throw new TypeError(`filters.${name} must be an array of strings`);
    return v.length ? new Set(v) : null;
  };
  const speaker = f.speaker ?? "any";
  if (!["any", "user", "assistant"].includes(speaker)) throw new TypeError("invalid filters.speaker");
  const sort = i.sort ?? "relevance";
  if (!["relevance", "recent"].includes(sort)) throw new TypeError("invalid sort");
  const int = (v, def, min, max, name) => {
    if (v === undefined || v === null) return def;
    if (!Number.isFinite(v)) throw new TypeError(`${name} must be a number`);
    return Math.min(max, Math.max(min, Math.floor(v)));
  };
  return {
    terms: parseQuery(i.query ?? ""),
    sort,
    limit: int(i.limit, DEFAULT_LIMIT, 1, MAX_LIMIT, "limit"),
    hitsPerSession: int(i.hitsPerSession, DEFAULT_HITS, 1, MAX_HITS, "hitsPerSession"),
    offset: decodeCursor(i.cursor),
    filters: {
      backends: list(f.backends, "backends"),
      cwd: typeof f.cwd === "string" && f.cwd ? f.cwd : null,
      statusGiven: Object.hasOwn(f, "status") && f.status !== undefined,
      status: f.status === "" ? null : f.status ?? null,
      since: toMillis(f.since, "since"),
      until: toMillis(f.until, "until"),
      speaker,
      includeDelegated: Boolean(f.includeDelegated),
      includeToolInputs: Boolean(f.includeToolInputs),
      sessionIds: list(f.sessionIds, "sessionIds"),
    },
  };
}

export const encodeCursor = (offset) => Buffer.from(JSON.stringify({ o: offset })).toString("base64url");
function decodeCursor(cursor) {
  if (cursor === undefined || cursor === null || cursor === "") return 0;
  try {
    const o = JSON.parse(Buffer.from(String(cursor), "base64url").toString("utf8"))?.o;
    if (Number.isInteger(o) && o >= 0) return o;
  } catch {}
  throw new TypeError("invalid cursor");
}

/** 会話の行（一覧の 1 行）が、本文を見ない絞り込みに合うか */
export function passesFilters(row, f) {
  if (f.sessionIds && !f.sessionIds.has(row.id)) return false;
  // 委譲の子と bot の会話（Channels のスレッド・DM。ADR 0109）は既定で除く。includeDelegated で含める
  if (!f.includeDelegated && (row.delegation || row.bot)) return false;
  if (f.backends && !f.backends.has(row.backend)) return false;
  if (f.cwd && !samePath(row.cwd, f.cwd)) return false;
  if (f.statusGiven && (row.status ?? null) !== f.status) return false;
  if (f.since !== null || f.until !== null) {
    const at = row.lastModified;
    if (!Number.isFinite(at)) return false;
    if (f.since !== null && at < f.since) return false;
    if (f.until !== null && at > f.until) return false;
  }
  return true;
}

// ------------------------------------------------------------------ 写しを持つ部分

/**
 * @param {object} deps
 * @param {() => Promise<Array>} deps.listSessions 会話の一覧（{ id, title, status, cwd, backend, lastModified, delegation, parent }）
 * @param {(id: string) => Promise<Array|null>} [deps.readStored] Pleiad が持つ会話の保存分を読む（無ければ null。ネイティブの末尾は足さない）
 * @param {(id: string) => Promise<Array>} deps.readFull 履歴を全部読む（ネイティブの末尾を含む）
 * @param {number} [deps.concurrency] 裏の読み込みの並列数
 * @param {number} [deps.staleWaitMs] search が、写しより新しい会話の読み直しを待つ長さ
 * @param {number} [deps.rereadCooldownMs] 同じ会話を読み直す間隔の下限（走っているターンで更新が続く会話を読み続けない）
 * @param {number} [deps.retryFailedMs] 読めなかった会話をもう一度読むまでの間
 * @param {() => number} [deps.now]
 */
export function createSessionSearch({ listSessions, readStored = async () => null, readFull, concurrency = 2,
  staleWaitMs = 1500, rereadCooldownMs = 2000, retryFailedMs = 60_000, now = Date.now, onError = () => {} }) {
  const copies = new Map();     // id -> { sig, msgs }
  const failed = new Map();     // id -> 失敗した時刻
  const absent = new Map();     // id -> 一覧に無かった回数
  const waiting = [];           // 読み込みの待ち { id, full }（先頭から読む）
  const inflight = new Map();   // id -> Promise（読んでいる最中）
  let rows = [];                // 最後に見た一覧
  let updatedAt = null;
  let starting = null;
  let stopped = false;
  let running = 0;
  const idleWaiters = [];

  const settleIdle = () => { if (!running && !waiting.length) for (const f of idleWaiters.splice(0)) f(); };

  function put(id, raw, sig) {
    const prev = copies.get(id);
    if (prev && prev.sig > sig) return false;   // もっと新しい写しがある（遅れて届いた読み込みで巻き戻さない）
    copies.set(id, { sig, msgs: extractMessages(raw) });
    failed.delete(id);
    updatedAt = now();
    return true;
  }

  async function load(id, full) {
    const sig = now();
    let raw = null;
    if (!full && !copies.has(id)) raw = await readStored(id);
    raw ??= await readFull(id);
    put(id, raw, sig);
  }

  function pump() {
    while (!stopped && running < concurrency && waiting.length) {
      const { id, full } = waiting.shift();
      if (inflight.has(id)) continue;
      running++;
      const p = (async () => {
        try { await load(id, full); }
        catch (e) { failed.set(id, now()); onError(id, e); }
      })().finally(() => {
        inflight.delete(id); running--;
        // 事を一度ほどいて、JSON を解く間に止まっていた入出力を通す
        setImmediate(() => { pump(); settleIdle(); });
      });
      inflight.set(id, p);
    }
    settleIdle();
  }

  /** 読み込みを頼む。読んでいる最中・待ちの中のものは重ねない。front は待ちの先頭へ（探されている会話） */
  function request(id, { full = false, front = false } = {}) {
    if (stopped || inflight.has(id)) return;
    const at = waiting.findIndex((w) => w.id === id);
    if (at >= 0) {
      if (full) waiting[at].full = true;
      if (front && at > 0) waiting.unshift(...waiting.splice(at, 1));
    } else if (front) waiting.unshift({ id, full });
    else waiting.push({ id, full });
    pump();
  }

  const settled = (id) => new Promise((resolve) => {
    const tick = () => (inflight.has(id) || waiting.some((w) => w.id === id) ? setTimeout(tick, 15) : resolve());
    tick();
  });

  async function refreshRows() {
    try {
      rows = (await listSessions()).map((r) => ({ ...r, id: r.id ?? r.sessionId }));
    } catch (e) { onError(null, e); }
    // 一覧から消えた会話の写しは捨てる。ネイティブの一覧を一時的に読めなかった回で捨てないよう、続けて消えていたときだけ
    const live = new Set(rows.map((r) => r.id));
    for (const id of [...copies.keys(), ...failed.keys()]) {
      if (live.has(id)) { absent.delete(id); continue; }
      const n = (absent.get(id) ?? 0) + 1;
      if (n >= ABSENT_LISTINGS) { absent.delete(id); copies.delete(id); failed.delete(id); } else absent.set(id, n);
    }
    return rows;
  }

  const isMissing = (row) => !copies.has(row.id) && !(failed.has(row.id) && now() - failed.get(row.id) < retryFailedMs);
  const isStale = (row) => {
    const c = copies.get(row.id);
    return Boolean(c) && Number.isFinite(row.lastModified) && row.lastModified > c.sig && now() - c.sig >= rereadCooldownMs;
  };

  /** 一覧を読み、まだ写しの無い会話を新しい順に裏で読み込む（起動後に 1 回。何度呼んでもよい） */
  function start() {
    starting ??= (async () => {
      const list = await refreshRows();
      for (const row of [...list].sort((a, b) => (b.lastModified ?? 0) - (a.lastModified ?? 0))) if (isMissing(row)) request(row.id);
    })();
    return starting;
  }

  /**
   * 読んだ履歴を写しに入れる（loadSession・ターンの終わりなど、呼び出し側がもう全量を読んだとき）。
   * sig は読み始めた時刻。それより新しい写しがあれば入れない。
   */
  function ingest(id, raw, { sig = now() } = {}) {
    if (stopped || !id || !Array.isArray(raw)) return false;
    return put(id, raw, sig);
  }

  /** この会話の写しを全部読み直す（ターンの終わり）。待たずに返る */
  function refresh(id) {
    if (stopped || !id) return;
    request(id, { full: true });
  }

  async function search(input) {
    const q = normalizeInput(input);
    const f = q.filters;
    // 最初の 1 回は start の一覧をそのまま使う（二重に読まない）
    const first = !starting;
    await start();
    const list = first ? rows : await refreshRows();
    const scope = list.filter((r) => passesFilters(r, f));

    // 探されている会話を先に読む。写しより新しい会話は少しだけ待って読み直す
    const pendingReads = [];
    for (const row of scope) {
      if (isMissing(row)) request(row.id, { front: true });
      else if (isStale(row)) { request(row.id, { full: true, front: true }); pendingReads.push(settled(row.id)); }
    }
    if (pendingReads.length) {
      let timer;
      await Promise.race([Promise.all(pendingReads), new Promise((r) => { timer = setTimeout(r, staleWaitMs); })]);
      clearTimeout(timer);
    }
    const partial = scope.some((r) => isMissing(r) || isStale(r));

    const t = now();
    const opts = { speaker: f.speaker, toolInputs: f.includeToolInputs, hits: q.hitsPerSession };
    const found = [];
    for (const row of scope) {
      const copy = copies.get(row.id);
      const m = matchSession(row, copy?.msgs ?? [], q.terms, opts);
      if (!m) continue;
      found.push({ row, m, score: relevanceScore({ ...m, lastModified: row.lastModified }, t) });
    }
    const recent = (a, b) => (b.row.lastModified ?? 0) - (a.row.lastModified ?? 0) || (a.row.id < b.row.id ? -1 : 1);
    found.sort(q.sort === "recent" || !q.terms.length ? recent : (a, b) => b.score - a.score || recent(a, b));

    const page = found.slice(q.offset, q.offset + q.limit);
    const next = q.offset + page.length;
    return {
      total: found.length,
      partial,
      ...(next < found.length ? { nextCursor: encodeCursor(next) } : {}),
      sessions: page.map(({ row, m, score }) => {
        const parent = row.delegation ? row.delegation.parentSessionId ?? row.parent : null;
        return {
          sessionId: row.id,
          title: row.title ?? "", status: row.status ?? null, cwd: row.cwd ?? "", backend: row.backend ?? "",
          lastModified: row.lastModified ?? 0,
          ...(parent ? { parentSessionId: parent } : {}),
          score,
          matched: m.matched,
          hitCount: m.hitCount,
          hits: m.top.map((h) => buildHit(h, q.terms)),
        };
      }),
    };
  }

  function status() {
    const pending = rows.filter(isMissing).length + rows.filter(isStale).length;
    return { indexed: copies.size, pending, updatedAt };
  }

  /** 裏の読み込みが全部終わるまで待つ（tests と計測用） */
  const idle = () => new Promise((resolve) => { if (!running && !waiting.length) resolve(); else idleWaiters.push(resolve); });

  function stop() { stopped = true; waiting.length = 0; settleIdle(); }

  return { search, status, start, ingest, refresh, idle, stop };
}
