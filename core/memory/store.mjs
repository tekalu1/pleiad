// 記憶の正本（ADR 0109）。markdown（<dir>/user.md・<dir>/bots/<botId>.md）と、変更の記録 <dir>/log.jsonl（rev・墓石・誰がしたか）。
// 索引（index.mjs）は派生で、ここが持つのは正本だけ。
//
// markdown の形（docs/channels.md の元の計画 §1.6）:
//   <!-- pleiad-memory v1 layer=user -->
//   # あなたについて
//
//   - 本文 <!-- {"id":"m_…","at":…,"up":…,"by":{…},"why":"…","src":[{…}]} -->
//   1 行 1 件。本文は人が読めて直せる。メタは行末の HTML コメントの JSON（読めない・無い行は「出どころ不明」の人の記憶として読む）。
//   人が markdown を直接直したら、次に読むとき（sync）に差分を人の変更として log.jsonl に記録する。
//
// log.jsonl の 1 行: { rev, at, op: 'add'|'edit'|'forget'|'unforget', layer, id, text, fp, by, via?, entry? }
//   forget は entry（消した記憶の全体）と fp（墓石。正規化した本文の sha256 の先頭 16 字）を残す。unforget は forget の entry から戻し、墓石を外す。
//   via は書いた会話の sessionId（その会話の末尾の差分には同じ記憶を重ねて出さないため）。
// 変更はすべて 1 本のキューで直列にする（rev を欠番なく進めるため）。md を先に書き、log を後に足す。
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { writeAtomic } from '../atomic-file.mjs';
import { newId, isId, isAuthor, authorKey } from '../channels/types.mjs';

export const MEMORY_TEXT_MAX = 300;
export const USER_LAYER = 'user';

/** 層の id か（'user' か bot の id）。ファイル名になるので、それ以外は通さない */
export const isLayer = (layer) => layer === USER_LAYER || isId(layer, 'bot');

/** 指紋用の正規化: NFKC・小文字・空白と記号を落とす（言い回しの細かい違いで墓石をすり抜けない） */
export const fingerprintOf = (text) => crypto.createHash('sha256')
  .update(String(text ?? '').normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '')).digest('hex').slice(0, 16);

/** 本文を 1 行にそろえる（改行・連続の空白を 1 つに） */
export const oneLine = (text) => String(text ?? '').replace(/\s+/g, ' ').trim();

// ------------------------------------------------------------------ markdown
const HEADER = (layer) => `<!-- pleiad-memory v1 layer=${layer} -->`;
// JSON の中の < と > は \u003c \u003e にする（-->  が本文に入っても、行末のコメントを閉じない）
const metaJson = (value) => JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e');

/** 本文だけから決める id（メタの無い手書きの行用。同じ本文は同じ id なので、読むたびに変わらない） */
export const derivedId = (layer, text) => `m_h${crypto.createHash('sha256').update(`${layer}\n${text}`).digest('hex').slice(0, 12)}`;

/** 1 層の markdown を読む。メタの無い・壊れた行は hadMeta: false（出どころ不明の人の記憶） */
export function parseLayer(markdown, layer) {
  const entries = [];
  for (const line of String(markdown ?? '').split(/\r?\n/)) {
    const m = /^[-*]\s+(.*\S)\s*$/.exec(line);
    if (!m) continue;
    let body = m[1];
    let meta = null;
    const open = body.lastIndexOf('<!--');
    if (open >= 0 && /-->$/.test(body)) {
      const inner = /^<!--\s*([\s\S]*?)\s*-->$/.exec(body.slice(open))?.[1] ?? '';
      try { const parsed = JSON.parse(inner); if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) meta = parsed; } catch { /* 壊れたメタは本文だけ残す */ }
      body = body.slice(0, open);
    }
    const text = oneLine(body);
    if (!text) continue;
    const id = isId(meta?.id, 'memory') ? meta.id : derivedId(layer, text);
    entries.push({
      id, layer, text,
      ...(typeof meta?.why === 'string' && meta.why ? { why: meta.why } : {}),
      sources: Array.isArray(meta?.src) ? meta.src.filter((s) => s && typeof s === 'object') : [],
      at: Number.isFinite(meta?.at) ? meta.at : 0,
      updatedAt: Number.isFinite(meta?.up) ? meta.up : Number.isFinite(meta?.at) ? meta.at : 0,
      by: isAuthor(meta?.by) ? meta.by : { kind: 'human' },
      ...(isAuthor(meta?.ob) ? { origBy: meta.ob } : {}),
      hadMeta: Boolean(meta),
    });
  }
  return entries;
}

/** 1 層の markdown を作る。title は見出し（辞書の文。呼び出し側が言語を決める） */
export function renderLayer(layer, entries, title) {
  const lines = entries.map((e) => `- ${oneLine(e.text)} <!-- ${metaJson({
    id: e.id, at: e.at, up: e.updatedAt, by: e.by, ...(e.origBy ? { ob: e.origBy } : {}), ...(e.why ? { why: e.why } : {}), src: e.sources ?? [],
  })} -->`);
  return `${HEADER(layer)}\n# ${title}\n\n${lines.join('\n')}${lines.length ? '\n' : ''}`;
}

/** 外へ出す形（hadMeta を落とす） */
const publicEntry = (entry) => { const { hadMeta: _hadMeta, ...rest } = entry; return rest; };

// ------------------------------------------------------------------ store
const sigOf = (st) => `${st.mtimeMs}:${st.size}`;

/**
 * createMemoryStore({ dir, now, titleOf }) — titleOf(layer) は markdown の見出し（無ければ層の名前）
 *   init(): 記録を読み、markdown と突き合わせる（アプリが止まっている間の手書きの直しも拾う）
 *   sync(): markdown の外からの直しを拾って記録する。変わった層の配列を返す（変わらなければ空）
 *   entries(layer?) / get(id) / layers()
 *   add / edit / forget / unforget … 変更。返りは { entry, rev }（forget は { entry, rev, fp }）
 *   rev() / recordsSince(rev) / isTombstoned(fp) / hash(layers?)  … 索引の鮮度の印
 */
export function createMemoryStore({ dir, now = Date.now, titleOf = (layer) => layer } = {}) {
  const logFile = path.join(dir, 'log.jsonl');
  const layerFile = (layer) => (layer === USER_LAYER ? path.join(dir, 'user.md') : path.join(dir, 'bots', `${layer}.md`));
  /** @type {Map<string, any[]>} */
  const cache = new Map();           // layer → entries（hadMeta を持つ）
  const sigs = new Map();            // layer → ファイルの印（mtime:size）。自分で書いた後の値を入れる
  const known = new Map();           // id → { layer, text }（記録から組んだ「記録が知っている今の記憶」。手書きの直しの差分を取る相手）
  const forgotten = new Map();       // id → 最後の forget の記録（unforget の元）
  const tombstones = new Map();      // fp → forget した記憶の id
  let records = [];
  let rev = 0;
  let queue = Promise.resolve();
  let ready = false;

  /** 変更・読み込みを 1 本に並べる */
  const serial = (fn) => { const run = queue.then(fn, fn); queue = run.catch(() => {}); return run; };

  function apply(rec) {
    if (rec.op === 'add' || rec.op === 'edit' || rec.op === 'unforget') {
      known.set(rec.id, { layer: rec.layer, text: rec.text });
      if (rec.op === 'unforget') {
        forgotten.delete(rec.id);
        if (rec.fp && tombstones.get(rec.fp) === rec.id) tombstones.delete(rec.fp);
      }
    } else if (rec.op === 'forget') {
      known.delete(rec.id);
      forgotten.set(rec.id, rec);
      if (rec.fp) tombstones.set(rec.fp, rec.id);
    }
  }

  async function readLog() {
    let raw = '';
    try { raw = await fs.readFile(logFile, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    records = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const rec = JSON.parse(line);
        if (Number.isInteger(rec?.rev) && typeof rec.op === 'string') records.push(rec);
      } catch { /* 最後の行が書きかけで壊れていたら捨てる */ }
    }
    known.clear(); forgotten.clear(); tombstones.clear();
    for (const rec of records) apply(rec);
    rev = records.reduce((max, r) => Math.max(max, r.rev), 0);
  }

  /** 最後の 1 バイトが改行か（ファイルが無い・空なら真）。追記の途中で落ちた壊れた行の後ろに、次の行をつなげないため（channels/store.mjs と同じ） */
  async function endsWithNewline() {
    const st = await fs.stat(logFile).catch(() => null);
    if (!st || st.size === 0) return true;
    const fh = await fs.open(logFile, 'r');
    try {
      const buf = Buffer.alloc(1);
      await fh.read(buf, 0, 1, st.size - 1);
      return buf[0] === 0x0a;
    } finally { await fh.close(); }
  }

  async function appendLog(rec) {
    const full = { rev: rev + 1, at: now(), ...rec };
    await fs.mkdir(dir, { recursive: true });
    const lead = (await endsWithNewline()) ? '' : '\n';
    await fs.appendFile(logFile, `${lead}${JSON.stringify(full)}\n`, 'utf8');
    rev = full.rev;
    records.push(full);
    apply(full);
    return full;
  }

  async function listLayerNames() {
    const names = [];
    try { await fs.access(path.join(dir, 'user.md')); names.push(USER_LAYER); } catch { /* 無ければ空の層 */ }
    try {
      for (const f of await fs.readdir(path.join(dir, 'bots'))) {
        const id = f.endsWith('.md') ? f.slice(0, -3) : null;
        if (id && isId(id, 'bot')) names.push(id);
      }
    } catch { /* bots/ が無い */ }
    return names;
  }

  async function writeLayer(layer) {
    const file = layerFile(layer);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await writeAtomic(file, renderLayer(layer, cache.get(layer) ?? [], titleOf(layer)));
    sigs.set(layer, sigOf(await fs.stat(file)));
  }

  /** 1 層を読み直す。手書きの直しは記録に足す（by: 人）。メタの無い行には id と at を付けて書き戻す */
  async function reload(layer, changedLayers) {
    const file = layerFile(layer);
    let raw = null, st = null;
    try { raw = await fs.readFile(file, 'utf8'); st = await fs.stat(file); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    const parsed = raw === null ? [] : parseLayer(raw, layer);
    const seen = new Set();
    const entries = [];
    let rewrite = false;
    for (const e of parsed) {
      if (seen.has(e.id)) continue;   // 手でコピーした行の重複は 1 つにする
      seen.add(e.id);
      if (!e.hadMeta) { e.at = e.updatedAt = now(); e.by = { kind: 'human' }; rewrite = true; }
      entries.push(e);
    }
    if (parsed.length !== entries.length) rewrite = true;
    cache.set(layer, entries);
    // 記録が知っている今の記憶と比べる
    let changed = false;
    for (const e of entries) {
      const k = known.get(e.id);
      if (!k) { await appendLog({ op: 'add', layer, id: e.id, text: e.text, fp: fingerprintOf(e.text), by: { kind: 'human' } }); changed = true; }
      else if (k.text !== e.text || k.layer !== layer) { await appendLog({ op: 'edit', layer, id: e.id, text: e.text, fp: fingerprintOf(e.text), by: { kind: 'human' } }); changed = true; }
    }
    for (const [id, k] of [...known]) {
      if (k.layer !== layer || seen.has(id)) continue;
      const gone = { id, layer, text: k.text, sources: [], at: 0, updatedAt: now(), by: { kind: 'human' } };
      await appendLog({ op: 'forget', layer, id, text: k.text, fp: fingerprintOf(k.text), by: { kind: 'human' }, entry: gone });
      changed = true;
    }
    if (rewrite) await writeLayer(layer);
    else if (st) sigs.set(layer, sigOf(st));
    else sigs.delete(layer);
    if (changed || rewrite) changedLayers.add(layer);
  }

  async function syncNow() {
    const changedLayers = new Set();
    const names = new Set([...(await listLayerNames()), ...cache.keys(), ...[...known.values()].map((k) => k.layer)]);
    for (const layer of names) {
      let st = null;
      try { st = await fs.stat(layerFile(layer)); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      const sig = st ? sigOf(st) : null;
      if (cache.has(layer) && (sigs.get(layer) ?? null) === sig) continue;
      await reload(layer, changedLayers);
    }
    return [...changedLayers];
  }

  const ensureReady = async () => {
    if (ready) return;
    await readLog();
    ready = true;
  };

  const entriesOf = (layer) => (cache.get(layer) ?? []).map(publicEntry);

  return {
    /** 起動時: 記録を読み、markdown と突き合わせる。直された層の配列 */
    init: () => serial(async () => { ready = false; await ensureReady(); return syncNow(); }),
    sync: () => serial(async () => { await ensureReady(); return syncNow(); }),
    entries: (layer) => (layer ? entriesOf(layer) : [...cache.keys()].flatMap(entriesOf)),
    get: (id) => { for (const list of cache.values()) { const e = list.find((x) => x.id === id); if (e) return publicEntry(e); } return null; },
    layers: () => [...cache.keys()],
    rev: () => rev,
    recordsSince: (since) => records.filter((r) => r.rev > since),
    isTombstoned: (fp) => tombstones.has(fp),
    /** 忘れた直後で、戻せる記憶（最後の操作が forget）の写し。無ければ null */
    forgottenEntry: (id) => { const gone = forgotten.get(id); return gone?.entry && !known.has(id) ? publicEntry(gone.entry) : null; },
    /** 索引の鮮度の印（全層の entries の内容から） */
    hash: () => crypto.createHash('sha256').update(JSON.stringify([...cache.keys()].sort().map((l) => [l, cache.get(l).map((e) => [e.id, e.text, e.why ?? '', e.updatedAt])]))).digest('hex'),

    /** 追加。by は発言者、via は書いた会話。entry は id・at 以外が入った形 */
    add: ({ layer, text, why, sources = [], by, via, unique = false }) => serial(async () => {
      await ensureReady(); await syncNow();
      // 同じ文を同時に 2 回書いても、直列化の中で見れば後の 1 つは弾ける（呼び出し側の事前の検査は直列化の外）
      if (unique && (cache.get(layer) ?? []).some((e) => fingerprintOf(e.text) === fingerprintOf(text))) return { duplicate: true };
      const at = now();
      const entry = { id: newId('memory', at), layer, text: oneLine(text), ...(why ? { why } : {}), sources, at, updatedAt: at, by, hadMeta: true };
      cache.set(layer, [...(cache.get(layer) ?? []), entry]);
      await writeLayer(layer);
      const rec = await appendLog({ op: 'add', layer, id: entry.id, text: entry.text, fp: fingerprintOf(entry.text), by, ...(via ? { via } : {}) });
      return { entry: publicEntry(entry), rev: rec.rev };
    }),

    /** 本文・理由・出どころを直す。無い id は null */
    edit: ({ id, text, why, sources, by, via }) => serial(async () => {
      await ensureReady(); await syncNow();
      for (const [layer, list] of cache) {
        const i = list.findIndex((e) => e.id === id);
        if (i < 0) continue;
        const old = list[i];
        const entry = {
          ...old,
          ...(text !== undefined ? { text: oneLine(text) } : {}),
          ...(why !== undefined ? (why ? { why } : { why: undefined }) : {}),
          sources: sources ? [...old.sources, ...sources] : old.sources,
          updatedAt: now(), by,
        };
        // 書き手が替わったら、元の書き手を残す（人の行を AI が直したときに、元が人だったと分かるように）。by は今の本文を書いた者
        if (authorKey(old.by) !== authorKey(by)) entry.origBy = old.origBy ?? old.by;
        if (!entry.why) delete entry.why;
        const next = [...list]; next[i] = entry;
        cache.set(layer, next);
        await writeLayer(layer);
        const rec = await appendLog({ op: 'edit', layer, id, text: entry.text, fp: fingerprintOf(entry.text), by, ...(entry.origBy ? { origBy: entry.origBy } : {}), ...(via ? { via } : {}) });
        return { entry: publicEntry(entry), rev: rec.rev };
      }
      return null;
    }),

    /** 忘れる（墓石を残す）。無い id は null */
    forget: ({ id, by, via }) => serial(async () => {
      await ensureReady(); await syncNow();
      for (const [layer, list] of cache) {
        const old = list.find((e) => e.id === id);
        if (!old) continue;
        cache.set(layer, list.filter((e) => e !== old));
        await writeLayer(layer);
        const fp = fingerprintOf(old.text);
        const rec = await appendLog({ op: 'forget', layer, id, text: old.text, fp, by, ...(via ? { via } : {}), entry: publicEntry(old) });
        return { entry: publicEntry(old), rev: rec.rev, fp };
      }
      return null;
    }),

    /** 忘れたものを戻す（人の操作の取り消しとして記録）。墓石も外す。戻せるもの（最後の操作が forget）が無ければ null */
    unforget: ({ id, by, via }) => serial(async () => {
      await ensureReady(); await syncNow();
      const gone = forgotten.get(id);
      if (!gone?.entry || known.has(id)) return null;
      const layer = gone.layer;
      const at = now();
      const entry = { ...gone.entry, updatedAt: at, by, hadMeta: true };
      cache.set(layer, [...(cache.get(layer) ?? []), entry]);
      await writeLayer(layer);
      const rec = await appendLog({ op: 'unforget', layer, id, text: entry.text, fp: gone.fp ?? fingerprintOf(entry.text), by, ...(via ? { via } : {}) });
      return { entry: publicEntry(entry), rev: rec.rev };
    }),
  };
}
