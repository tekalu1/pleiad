// 外部 MCP の秘密（OAuth のトークン・クライアントシークレット・bearer・ヘッダー値・stdio の env 値）の置き場。
//
// 暗号化は Electron の safeStorage に任せる。ただし safeStorage は main プロセスでしか使えず、
// このサーバーは utilityProcess（desktop/main.cjs → desktop/server.cjs → core/server.mjs）で動くので、
// parentPort で main に encrypt / decrypt を頼む（相手は desktop/secret-bridge.cjs）。
// Electron が無い（npm start）・Linux で basic_text しか無い、など暗号化できないときは
// 権限 0600 の平文で置き、status().encrypted を false にして UI / API から分かるようにする。
//
// 書き込みは一時ファイル＋rename。同じプロセスの中は直列にし、プロセスをまたいでは <file>.lock で排他する
// （開発版と配布版の Pleiad が同じデータ置き場を見ることがある）。
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { t } from './i18n.mjs';

const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * `lockPath` を排他して fn を走らせる。`open(..., 'wx')` で作れた者が持ち主。
 * 持ち主が落ちて残ったロックは staleMs を過ぎたら壊してよいものとみなす。
 */
export async function withFileLock(lockPath, fn, { timeoutMs = 5000, staleMs = 30000, intervalMs = 25 } = {}) {
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  const deadline = Date.now() + timeoutMs;
  let handle;
  for (;;) {
    try { handle = await fs.open(lockPath, 'wx', 0o600); break; }
    catch (e) {
      // Windows では、ウイルス対策や直前の読み書きがロックを掴んでいる間だけ、既に持ち主が居るときの
      // EEXIST ではなく EPERM/EACCES/EBUSY が返る（writeFile の rename と同じ事情）。
      // どちらも「今は取れない」であって「取れない」ではないので、同じように待って取り直す。
      // 権限そのものが無いときもここへ来るが、その場合は待っても取れず deadline で止まる。
      if (!['EEXIST', 'EPERM', 'EACCES', 'EBUSY'].includes(e.code)) throw e;
      const stat = await fs.stat(lockPath).catch(() => null);
      // 壊せなかったときは次の待ちへ回す。掴まれている間は rm も同じ理由で失敗する
      if (stat && Date.now() - stat.mtimeMs > staleMs && await fs.rm(lockPath, { force: true }).then(() => true, () => false)) continue;
      if (Date.now() > deadline) throw Object.assign(new Error(t('secrets.busy')), { cause: e });
      await sleep(intervalMs);
    }
  }
  try {
    await handle.writeFile(`${process.pid}\n`).catch(() => {});
    return await fn();
  } finally {
    await handle.close().catch(() => {});
    await fs.rm(lockPath, { force: true }).catch(() => {});
  }
}

/** 暗号化できないときの置き方。値はそのまま（ファイル権限 0600 だけで守る） */
export const plainCipher = {
  async status() { return { encrypted: false, backend: 'none', reason: t('secrets.plainReason') }; },
  async encrypt() { throw new Error('encryption unavailable'); },
  async decrypt() { throw new Error('encryption unavailable'); },
};

/**
 * main プロセスに safeStorage を頼む暗号器。port は utilityProcess の process.parentPort。
 * main 側は { type:'secret', id, op, value } を受けて { type:'secret', id, ok, value | error } を返す。
 */
export function parentPortCipher(port, { timeoutMs = 10000 } = {}) {
  const waiting = new Map();
  let seq = 0, cached = null;
  port.on('message', event => {
    const data = event?.data ?? event;
    if (data?.type !== 'secret' || !waiting.has(data.id)) return;
    const { resolve, reject, timer } = waiting.get(data.id);
    waiting.delete(data.id); clearTimeout(timer);
    if (data.ok) resolve(data.value); else reject(new Error(data.error || t('secrets.cryptoFailed')));
  });
  const request = (op, value) => new Promise((resolve, reject) => {
    const id = `s${++seq}`;
    const timer = setTimeout(() => { waiting.delete(id); reject(new Error(t('secrets.noResponse'))); }, timeoutMs);
    waiting.set(id, { resolve, reject, timer });
    port.postMessage({ type: 'secret', id, op, ...(value === undefined ? {} : { value }) });
  });
  return {
    async status() {
      // 暗号化の可否は起動中に変わらない。main が答えない（古い版など）のも同じなので、失敗も覚えて平文扱いにする
      // 覚えるのは答えだけ。既定の理由の文は、言語が途中で変わってもよいよう返すたびに引く
      cached ??= request('status').then(
        s => ({ encrypted: Boolean(s?.available), backend: s?.backend ?? 'unknown', ...(s?.available ? {} : { reason: s?.reason }) }),
        e => ({ encrypted: false, backend: 'unknown', reason: e.message }));
      const state = await cached;
      return state.encrypted ? state : { ...state, reason: state.reason ?? t('secrets.osUnavailable') };
    },
    encrypt: value => request('encrypt', value),
    decrypt: value => request('decrypt', value),
  };
}

/** 起動の形に合う暗号器。utilityProcess なら main に頼み、そうでなければ平文 */
export function defaultCipher() {
  return process.parentPort ? parentPortCipher(process.parentPort) : plainCipher;
}

/**
 * 秘密の key-value ストア。値は JSON にしてから 1 件ずつ暗号化する。
 * 形式: { version: 1, entries: { <key>: { enc: 'safeStorage' | 'plain', data: string, at } } }
 */
export function createSecretStore({ file, cipher = plainCipher }) {
  let queue = Promise.resolve();
  const lock = `${file}.lock`;
  async function readFile() {
    try {
      const raw = JSON.parse(await fs.readFile(file, 'utf8'));
      if (raw?.version !== 1 || !raw.entries || typeof raw.entries !== 'object' || Array.isArray(raw.entries)) throw new Error('bad');
      return raw;
    } catch (e) {
      if (e.code === 'ENOENT') return { version: 1, entries: {} };
      // 壊れたファイルを黙って空で上書きしない（トークンを失うより、止まって知らせる方がよい）
      throw new Error(t('secrets.fileBroken'));
    }
  }
  async function writeFile(data) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${crypto.randomUUID()}.tmp`;
    try {
      await fs.writeFile(tmp, JSON.stringify(data, null, 2) + '\n', { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      await fs.chmod(tmp, 0o600).catch(() => {});
      // Windows では、ウイルス対策や直前の読み取りがファイルを掴んでいる間だけ rename が EPERM/EBUSY になる。
      // ロックは取れているので書き手どうしの競合ではなく、短く待てば通る。
      for (let attempt = 0; ; attempt++) {
        try { await fs.rename(tmp, file); break; }
        catch (e) {
          if (attempt >= 5 || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) throw e;
          await new Promise(done => setTimeout(done, 20 * (attempt + 1)));
        }
      }
    } finally { await fs.rm(tmp, { force: true }).catch(() => {}); }
  }
  async function open(entry) {
    if (!entry) return undefined;
    if (entry.enc === 'plain') return JSON.parse(entry.data);
    if (entry.enc === 'safeStorage') {
      const state = await cipher.status();
      if (!state.encrypted) throw Object.assign(new Error(t('secrets.locked')), { code: 'SECRET_LOCKED' });
      return JSON.parse(await cipher.decrypt(entry.data));
    }
    throw new Error(t('secrets.unknownFormat'));
  }
  async function seal(value) {
    const text = JSON.stringify(value);
    const state = await cipher.status();
    if (state.encrypted) return { enc: 'safeStorage', data: await cipher.encrypt(text), at: new Date().toISOString() };
    return { enc: 'plain', data: text, at: new Date().toISOString() };
  }
  function serial(fn) {
    const run = queue.catch(() => {}).then(fn);
    queue = run;
    return run;
  }
  return {
    file,
    async status() {
      const state = await cipher.status();
      const data = await readFile().catch(() => ({ entries: {} }));
      const plain = Object.values(data.entries).filter(e => e?.enc === 'plain').length;
      return { encrypted: state.encrypted, backend: state.backend, ...(state.reason ? { reason: state.reason } : {}), file, plainEntries: plain };
    },
    async get(key) {
      await queue.catch(() => {});
      return open((await readFile()).entries[key]);
    },
    async keys(prefix = '') {
      await queue.catch(() => {});
      return Object.keys((await readFile()).entries).filter(k => k.startsWith(prefix));
    },
    /** 読んで・変えて・書くを 1 回の排他の中でやる。fn が undefined を返したら消す */
    update(key, fn) {
      return serial(() => withFileLock(lock, async () => {
        const data = await readFile();
        const before = await open(data.entries[key]);
        const after = await fn(before === undefined ? undefined : structuredClone(before));
        if (after === undefined) delete data.entries[key];
        else data.entries[key] = await seal(after);
        await writeFile(data);
        return after;
      }));
    },
    set(key, value) { return this.update(key, () => value); },
    /** 消すだけなら復号は要らない（復号できない起動でも消せる） */
    delete(key) {
      return serial(() => withFileLock(lock, async () => {
        const data = await readFile();
        if (!Object.hasOwn(data.entries, key)) return undefined;
        delete data.entries[key];
        await writeFile(data);
        return undefined;
      }));
    },
    /**
     * 平文で残っている項目を暗号化し直す。暗号化できる起動になったとき（npm start で作った後に Pleiad デスクトップで開いた、
     * Linux で鍵束が使えるようになった、など）に起動時に 1 回呼ぶ。暗号化できない起動では何もしない。
     * 暗号化済みの項目は触らない（逆向き＝平文へ戻すことはしない）。戻り値は書き直した件数
     */
    migrate() {
      return serial(() => withFileLock(lock, async () => {
        if (!(await cipher.status()).encrypted) return 0;
        const data = await readFile();
        const plain = Object.entries(data.entries).filter(([, e]) => e?.enc === 'plain');
        if (!plain.length) return 0;
        for (const [key, entry] of plain) data.entries[key] = { ...(await seal(JSON.parse(entry.data))), at: entry.at };
        await writeFile(data);
        return plain.length;
      }));
    },
    /**
     * prefix の付いた項目を別の prefix へ移す（MCP の登録名を変えたとき）。中身は復号せずにそのまま移すので、
     * この起動で復号できない（暗号化済みを npm start で開いた）項目も失わない。移し先の古い項目は消す
     */
    move(fromPrefix, toPrefix) {
      return serial(() => withFileLock(lock, async () => {
        const data = await readFile();
        for (const k of Object.keys(data.entries)) if (k.startsWith(toPrefix)) delete data.entries[k];
        let moved = 0;
        for (const [k, entry] of Object.entries(data.entries)) {
          if (!k.startsWith(fromPrefix)) continue;
          delete data.entries[k];
          data.entries[toPrefix + k.slice(fromPrefix.length)] = entry;
          moved++;
        }
        await writeFile(data);
        return moved;
      }));
    },
    /** prefix で始まるものをまとめて消す（MCP の登録を消したとき） */
    deletePrefix(prefix) {
      return serial(() => withFileLock(lock, async () => {
        const data = await readFile();
        for (const k of Object.keys(data.entries)) if (k.startsWith(prefix)) delete data.entries[k];
        await writeFile(data);
      }));
    },
  };
}
