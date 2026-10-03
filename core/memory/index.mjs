// 記憶の索引（派生。ADR 0097）。node:sqlite の FTS5（tokenize='trigram'）で候補を引き、順位づけは JS で行う。
// node:sqlite は Node 22.5 以降（package.json の engines は >=20.19.0）なので、読み込めない・FTS5 の trigram が無い・ファイルが壊れた
// ときは、メモリ上の走査に切り替える（件数は数百〜数千。ADR 0080 と同じ作り）。どちらの道でも候補は同じ集合になり、
// 最後の絞り込みと順位づけは同じ JS の関数を通るので、結果は同じになる。壊れた索引ファイルは捨てて markdown から作り直す。
//
// createMemoryIndex({ file, loadSqlite, log }) → {
//   sync(entries, hash)                          … 正本の写しを渡す。hash が前と違えば索引を作り直す（sqlite を使うときだけ重い）
//   search({ query, layers?, limit })            … 語を AND で（3 文字未満の語は LIKE）。MemoryEntry[]（順位順）
//   related({ text, layers?, exclude?, limit })  … 文章に関係する記憶（ターンの末尾用）。{ entry, score }[]
//   mode(): 'sqlite' | 'scan' | 'unknown'        … 今どちらの道か（テスト・診断用）
//   close() }
import fs from 'node:fs/promises';

/** 既定の読み込み。AGENT_HOST_MEMORY_NO_SQLITE=1 で、読み込めない状態を作れる（Node 20.19 相当の確認用） */
const defaultLoadSqlite = async () => {
  if (process.env.AGENT_HOST_MEMORY_NO_SQLITE) throw new Error('node:sqlite disabled by AGENT_HOST_MEMORY_NO_SQLITE');
  return import('node:sqlite');
};

/** 照合用の正規化: NFKC・小文字 */
export const fold = (text) => String(text ?? '').normalize('NFKC').toLowerCase();

const MAX_QUERY_TERMS = 8;
const TRIGRAM = 3;
const STOP = new Set(('the and for that with this have from you your are was were will would can could should not but all any one our out use '
  + 'has had its let may how why who what when where which them they then than into about there their been being just also more some such only over').split(' '));
const HIRAGANA_ONLY = /^[\p{Script=Hiragana}ー]+$/u;
const ASCII_ONLY = /^[\x00-\x7f]+$/;

/** memory.search の語: 空白で分け、前後の引用符・括弧を落とす */
export function queryTerms(query) {
  const terms = fold(query).split(/\s+/).map((w) => w.replace(/^["'「『(（]+|["'」』)）]+$/g, '')).filter(Boolean);
  return [...new Set(terms)].slice(0, MAX_QUERY_TERMS);
}

/** 文章から、記憶と突き合わせる語を取る。英数字の語（3 字以上・重み 2）と、日本語などの 3 文字の窓（ひらがなだけのものは除く・重み 1） */
export function relatedTerms(text, max = 48) {
  const terms = new Map();
  const add = (term, weight) => { if (terms.size < max && !terms.has(term)) terms.set(term, weight); };
  for (const word of fold(text).match(/[\p{L}\p{N}_]+/gu) ?? []) {
    if (ASCII_ONLY.test(word)) {
      if (word.length >= TRIGRAM && !STOP.has(word) && !/^\d+$/.test(word)) add(word, 2);
      continue;
    }
    const chars = [...word];
    for (let i = 0; i + TRIGRAM <= chars.length; i++) {
      const gram = chars.slice(i, i + TRIGRAM).join('');
      if (!HIRAGANA_ONLY.test(gram)) add(gram, 1);
    }
  }
  return terms;
}

const RELATED_MIN_SCORE = 2;
const hayOf = (entry) => ({ text: fold(entry.text), why: fold(entry.why ?? '') });
const occurrences = (hay, term) => { let n = 0; for (let i = hay.indexOf(term); i >= 0 && n < 5; i = hay.indexOf(term, i + term.length)) n++; return n; };
const byRecency = (a, b) => (b.updatedAt - a.updatedAt) || (b.at - a.at) || (a.id < b.id ? -1 : 1);

/** AND 検索の最後の絞り込みと順位。全部の語を含むものだけ。本文での一致を理由での一致より重く */
export function rankSearch(entries, terms) {
  if (!terms.length) return [];
  return entries.map((entry) => {
    const hay = hayOf(entry);
    let score = 0;
    for (const t of terms) {
      const inText = occurrences(hay.text, t), inWhy = occurrences(hay.why, t);
      if (!inText && !inWhy) return null;
      score += inText * 3 + inWhy;
    }
    return { entry, score };
  }).filter(Boolean).sort((a, b) => (b.score - a.score) || byRecency(a.entry, b.entry));
}

/** 関係する記憶の最後の絞り込みと順位。重みの合計が RELATED_MIN_SCORE 以上 */
export function rankRelated(entries, terms) {
  return entries.map((entry) => {
    const hay = hayOf(entry);
    let score = 0;
    for (const [term, weight] of terms) if (hay.text.includes(term) || hay.why.includes(term)) score += weight;
    return score >= RELATED_MIN_SCORE ? { entry, score } : null;
  }).filter(Boolean).sort((a, b) => (b.score - a.score) || byRecency(a.entry, b.entry));
}

const ftsPhrase = (term) => `"${term.replace(/"/g, '""')}"`;
const likePattern = (term) => `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

export function createMemoryIndex({ file, loadSqlite = defaultLoadSqlite, log = () => {} } = {}) {
  let db = null;
  let state = 'unknown';          // 'unknown' | 'sqlite' | 'scan'
  let entries = [];               // 正本の写し（どちらの道でも最後の絞り込みに使う）
  let byId = new Map();
  let stale = false;              // 実行時に壊れたと分かった（次の sync で作り直す）

  const removeFiles = () => Promise.all(['', '-wal', '-shm', '-journal'].map((suffix) => fs.rm(`${file}${suffix}`, { force: true }).catch(() => {})));

  async function openDb() {
    let DatabaseSync;
    try { ({ DatabaseSync } = await loadSqlite()); } catch (e) { log(`memory index: node:sqlite is unavailable (falling back to a scan): ${e?.message ?? e}`); return null; }
    if (typeof DatabaseSync !== 'function') return null;
    for (let attempt = 0; attempt < 2; attempt++) {
      let handle = null;
      try {
        handle = new DatabaseSync(file);
        handle.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS mem USING fts5(id UNINDEXED, layer UNINDEXED, text, why, tokenize='trigram')`);
        handle.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)');
        handle.prepare('SELECT count(*) AS n FROM mem').get();
        return handle;
      } catch (e) {
        try { handle?.close(); } catch { /* 閉じられなくてもよい */ }
        if (attempt === 0) { log(`memory index: rebuilding the index: ${e?.message ?? e}`); await removeFiles(); continue; }
        log(`memory index: sqlite is unavailable (falling back to a scan): ${e?.message ?? e}`);
        return null;
      }
    }
    return null;
  }

  async function ensureOpen() {
    if (state !== 'unknown') return;
    db = await openDb();
    state = db ? 'sqlite' : 'scan';
  }

  /** sqlite の中身を entries で置き換える。失敗（壊れた）したら 1 度だけファイルを捨てて作り直し、それでも駄目なら走査へ */
  async function rebuild(hash) {
    for (let attempt = 0; attempt < 2 && db; attempt++) {
      try {
        db.exec('BEGIN');
        db.exec('DELETE FROM mem');
        const insert = db.prepare('INSERT INTO mem (id, layer, text, why) VALUES (?, ?, ?, ?)');
        for (const e of entries) insert.run(e.id, e.layer, fold(e.text), fold(e.why ?? ''));
        db.prepare("INSERT INTO meta (key, value) VALUES ('hash', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(hash);
        db.exec('COMMIT');
        return;
      } catch (e) {
        try { db.exec('ROLLBACK'); } catch { /* 始まっていない */ }
        try { db.close(); } catch { /* 閉じられなくてもよい */ }
        log(`memory index: write failed (${e?.message ?? e})`);
        await removeFiles();
        db = attempt === 0 ? await openDb() : null;
      }
    }
    if (!db) state = 'scan';
  }

  /** 候補の id（sqlite の道）。null は「走査」（全部が候補） */
  function candidateIds({ match, likes, layers }) {
    if (state !== 'sqlite' || !db) return null;
    try {
      const where = [];
      const params = [];
      if (match) { where.push('mem MATCH ?'); params.push(match); }
      for (const like of likes) { where.push('(text LIKE ? ESCAPE \'\\\' OR why LIKE ? ESCAPE \'\\\')'); params.push(likePattern(like), likePattern(like)); }
      if (layers?.length) { where.push(`layer IN (${layers.map(() => '?').join(',')})`); params.push(...layers); }
      const sql = `SELECT id FROM mem${where.length ? ` WHERE ${where.join(' AND ')}` : ''}`;
      return new Set(db.prepare(sql).all(...params).map((r) => r.id));
    } catch (e) {
      // 実行時に壊れた。次の sync で作り直す（それまで今回は走査で答える）
      log(`memory index: search failed (${e?.message ?? e}); it is rebuilt on the next sync`);
      stale = true;
      return null;
    }
  }

  const inLayers = (layers) => (layers?.length ? entries.filter((e) => layers.includes(e.layer)) : entries);
  const pick = (ids, layers) => (ids ? inLayers(layers).filter((e) => ids.has(e.id)) : inLayers(layers));

  return {
    mode: () => state,

    async sync(list, hash) {
      entries = list; byId = new Map(list.map((e) => [e.id, e]));
      await ensureOpen();
      if (state !== 'sqlite') return;
      let stored = null;
      try { stored = db.prepare("SELECT value FROM meta WHERE key = 'hash'").get()?.value ?? null; } catch { stored = null; }
      if (stored !== hash || stale) { stale = false; await rebuild(hash); }
    },

    async search({ query, layers, limit = 5 } = {}) {
      const terms = queryTerms(query);
      if (!terms.length) return [];
      await ensureOpen();
      const long = terms.filter((t) => [...t].length >= TRIGRAM);
      const short = terms.filter((t) => [...t].length < TRIGRAM);
      const ids = candidateIds({ match: long.length ? long.map(ftsPhrase).join(' AND ') : null, likes: short, layers });
      return rankSearch(pick(ids, layers), terms).slice(0, limit).map((r) => r.entry);
    },

    async related({ text, layers, exclude = [], limit = 5 } = {}) {
      const terms = relatedTerms(text);
      if (!terms.size) return [];
      await ensureOpen();
      const skip = new Set(exclude);
      const ids = candidateIds({ match: [...terms.keys()].map(ftsPhrase).join(' OR '), likes: [], layers });
      return rankRelated(pick(ids, layers).filter((e) => !skip.has(e.id)), terms).slice(0, limit);
    },

    get: (id) => byId.get(id) ?? null,
    close() { try { db?.close(); } catch { /* 閉じられなくてもよい */ } db = null; state = 'unknown'; stale = false; },
  };
}
