// 貼り付けた HTML の画像（https の URL）をホストが取りに行き、添付の置き場へ置く（docs/adr/0141）。
//
// 貼り付けの HTML はコピー元のページが任意に書ける（信頼できない入力）ので、取りに行く先は次の規則で絞る。
//   - https だけ。ユーザー情報つき・非 http(s) は断る。ループバックの http も許さない
//   - 名前を解決した先が公開アドレスだけ（プライベート・ループバック・リンクローカルなどは断る）。解決した答えに接続を固定する（DNS rebinding）。
//     検査器は core/mcp-url-guard.mjs の publicOnly、固定の接続は core/pinned-fetch.mjs
//   - Cookie・Referer・認証ヘッダーを付けない。リダイレクトは 5 回まで、毎回検査して追う
//   - 1 枚 10 MiB・15 秒（名前の解決から読み切るまで）。Content-Length を信じず、読みながら数えて超えたら切る
//   - 先頭のバイトが png・jpeg・gif・webp・avif のものだけ置く。SVG（スクリプト・外部参照を持てる）と、画像でない中身は断る
//   - 同時に取りに行くのは MAX_ACTIVE 件まで（ホスト全体。超えた分は MAX_WAITING 件まで順番を待ち、待つ間も 15 秒に数える）。ファイル名は呼び出し側の名前から作り、URL からは作らない
//   - 画面がやめた（やめるが、取りに行く前・途中・置いた後のどれに届いても）ものは、ファイルを残さない
// 1 回の貼り付けで取り込む枚数（20 枚）は、貼る側（web/html-paste.mjs の PASTE_IMAGE_MAX）が決める。
// 置く場所と返す形は、ファイルの添付（attachFinish）と同じ（{ path, bytes, kind }）。
import fs from 'node:fs/promises';
import path from 'node:path';
import { t } from './i18n.mjs';
import { createUrlGuard, isLoopbackHost } from './mcp-url-guard.mjs';
import { pinnedFetch } from './pinned-fetch.mjs';

export const IMPORT_MAX_BYTES = 10 * 1024 * 1024;
export const IMPORT_TIMEOUT_MS = 15_000;
export const IMPORT_MAX_ACTIVE = 6;
export const IMPORT_MAX_WAITING = 100;   // 枠が空くのを待てる数（超えたら断る）
const IMPORT_MEMORY = 500;             // やめられた id・取れて置いた id を覚えておく数
export const IMPORT_SMALL_PX = 32;   // 縦横とも これ以下の画像（指定が無くても実寸で分かる追跡ピクセル・絵文字）は札にしない（web/html-paste.mjs の SMALL_IMAGE_PX と同じ）
const USER_AGENT = 'Mozilla/5.0 (compatible; Pleiad)';

/**
 * テスト専用の向け替え先（AGENT_HOST_IMAGE_IMPORT_TEST_ORIGIN）。バックエンドが fake だけ（本物のバックエンドと並べたら効かない）で、
 * origin のホストがループバック（127.0.0.1・::1・localhost）のときだけ origin を返す。それ以外は null（検査も向け替えもしない）
 */
export function testImportOrigin(env = process.env) {
  const backends = String(env.AGENT_HOST_BACKENDS ?? '').split(',').map(s => s.trim()).filter(Boolean);
  if (backends.length !== 1 || backends[0] !== 'fake') return null;
  try {
    const u = new URL(String(env.AGENT_HOST_IMAGE_IMPORT_TEST_ORIGIN ?? ''));
    return /^https?:$/.test(u.protocol) && isLoopbackHost(u.hostname) ? u.origin : null;
  } catch { return null; }
}

/** 取れなかった。code は理由の種類（画面には出さない。ログとテストが見分ける） */
export class ImportFailed extends Error {
  constructor(code, message) { super(message ?? code); this.name = 'ImportFailed'; this.code = code; }
}

/** 先頭のバイトで画像の種類を決める。SVG・画像でないものは null */
export function sniffImage(buf) {
  const b = buf;
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return { mime: 'image/png', ext: 'png' };
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { mime: 'image/jpeg', ext: 'jpg' };
  const head = (from, to) => b.subarray(from, to).toString('latin1');
  if (b.length >= 6 && (head(0, 6) === 'GIF87a' || head(0, 6) === 'GIF89a')) return { mime: 'image/gif', ext: 'gif' };
  if (b.length >= 12 && head(0, 4) === 'RIFF' && head(8, 12) === 'WEBP') return { mime: 'image/webp', ext: 'webp' };
  if (b.length >= 16 && head(4, 8) === 'ftyp') {
    // ftyp の箱: 種類（major brand）と、互換の種類の並び。avif / avis があれば AVIF
    const size = Math.min(b.readUInt32BE(0) || 16, b.length);
    const brands = [head(8, 12)];
    for (let i = 16; i + 4 <= size; i += 4) brands.push(head(i, i + 4));
    if (brands.some(x => x === 'avif' || x === 'avis')) return { mime: 'image/avif', ext: 'avif' };
  }
  return null;
}

/** 画像の大きさ（縦横の画素）。先頭のヘッダーだけを見る。読めなければ null */
export function imageSize(buf, kind) {
  try {
    switch (kind.ext) {
      case 'png': return buf.length >= 24 ? { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) } : null;
      case 'gif': return buf.length >= 10 ? { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) } : null;
      case 'jpg': {
        // SOF のマーカー（FF C0〜CF。C4・C8・CC は別の印）: 長さ 2・精度 1・高さ 2・幅 2
        let i = 2;
        while (i + 9 < buf.length) {
          if (buf[i] !== 0xff) { i++; continue; }
          const m = buf[i + 1];
          if (m === 0xff) { i++; continue; }
          if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) };
          if (m === 0xd8 || (m >= 0xd0 && m <= 0xd7) || m === 0x01) { i += 2; continue; }
          i += 2 + buf.readUInt16BE(i + 2);
        }
        return null;
      }
      case 'webp': {
        const fmt = buf.toString('latin1', 12, 16);
        if (fmt === 'VP8X' && buf.length >= 30) return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
        if (fmt === 'VP8 ' && buf.length >= 30) return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
        if (fmt === 'VP8L' && buf.length >= 25) { const bits = buf.readUInt32LE(21); return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 }; }
        return null;
      }
      case 'avif': {
        const at = buf.indexOf('ispe', 0, 'latin1');   // 箱: 種類 4・版と旗 4・幅 4・高さ 4
        return at > 0 && at + 16 <= buf.length ? { width: buf.readUInt32BE(at + 8), height: buf.readUInt32BE(at + 12) } : null;
      }
      default: return null;
    }
  } catch { return null; }
}

/** 札の名前になる字（alt など）から、置き場のファイル名の元を作る。拡張子は中身から決めるので落とす */
function baseNameOf(name) {
  const base = String(name ?? '').replace(/\.(?:png|jpe?g|gif|webp|avif|svg)$/i, '').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').replace(/^\.+/, '').trim().slice(0, 60);
  return base || 'image';
}

/**
 * @param {object} o
 * @param {(sessionId: string|null, name: string) => { dir: string, rel: string }} o.target 添付を置く場所（core/server.mjs の attachTarget）
 * @param {(host: string, opts: object) => Promise<Array<{address: string}>>} [o.lookup] 名前解決（テストで差し替える）
 * @param {typeof pinnedFetch} [o.fetchFn] 接続の仕方（テストで差し替える）
 * @param {object} [o.guard] 検査器（テスト専用: 本物の外へ出さずに 127.0.0.1 のテスト用サーバーへ向けるときだけ差し替える）
 * @param {number} [o.timeoutMs] 1 枚の制限時間（テストで縮める）
 */
export function createImageImporter({ target, lookup, fetchFn = pinnedFetch, guard = null, timeoutMs = IMPORT_TIMEOUT_MS, maxActive = IMPORT_MAX_ACTIVE, maxWaiting = IMPORT_MAX_WAITING }) {
  const urlGuard = guard ?? createUrlGuard({ publicOnly: true, ...(lookup ? { lookup } : {}) });
  const guarded = urlGuard.wrap(fetchFn, t('attach.import.label'));
  const entries = new Map();      // importId -> AbortController（順番待ちも含む。やめるときの宛先）
  const completed = new Map();    // importId -> 置いたファイル（取れた後に画面が捨てたとき、消すため。古いものから捨てる）
  const cancelled = new Set();    // 取り込みが始まる前にやめられた importId（あとから届いても取りに行かない。古いものから捨てる）
  const queue = [];               // 順番待ちの { resolve }
  let running = 0;

  const remember = (collection, key, value) => {
    if (collection instanceof Map) collection.set(key, value); else collection.add(key);
    if (collection.size > IMPORT_MEMORY) collection.delete(collection.keys().next().value);
  };

  /** 同時に取りに行く枠。空いていなければ順番を待つ（待つ間も 1 枚の制限時間に数える）。返す関数で枠を返す */
  function acquire(signal, stopped) {
    const release = () => {
      const next = queue.shift();
      if (next) next.resolve(release);   // 枠はそのまま次へ渡す
      else running--;
    };
    if (running < maxActive) { running++; return Promise.resolve(release); }
    return new Promise((resolve, reject) => {
      const waiter = { resolve };
      queue.push(waiter);
      signal.addEventListener('abort', () => {
        const i = queue.indexOf(waiter);
        if (i >= 0) { queue.splice(i, 1); reject(stopped()); }
      }, { once: true });
    });
  }

  async function readLimited(res, signal) {
    const declared = Number(res.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > IMPORT_MAX_BYTES) { await res.body?.cancel().catch(() => {}); throw new ImportFailed('too-large', t('attach.import.tooLarge')); }
    if (!res.body) return Buffer.alloc(0);
    const reader = res.body.getReader();
    const chunks = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > IMPORT_MAX_BYTES) throw new ImportFailed('too-large', t('attach.import.tooLarge'));
        chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
        signal.throwIfAborted();
      }
    } finally {
      reader.cancel().catch(() => {});
    }
    return Buffer.concat(chunks, total);
  }

  /**
   * 1 枚を取りに行って置く。取れなければ ImportFailed（code あり）。やめたら code: 'cancelled'。
   * 枠（同時 maxActive 件）が空くまで順番を待つ。待ちが maxWaiting を超えたら 'busy'。制限時間（timeoutMs）は待つ間・名前の解決も含めて数える
   * @returns {Promise<{ path: string, bytes: number, kind: 'image', mime: string, name: string }>}
   */
  async function importImage({ url, sessionId = null, name = '', importId = null }) {
    const id = importId ?? Symbol('import');
    if (entries.has(id)) throw new ImportFailed('duplicate', t('attach.import.busy'));
    if (cancelled.has(id)) throw new ImportFailed('cancelled', t('attach.import.cancelled'));
    if (running >= maxActive && queue.length >= maxWaiting) throw new ImportFailed('busy', t('attach.import.busy'));
    const abort = new AbortController();
    entries.set(id, abort);
    // 制限時間は自前のタイマーで数える（AbortSignal.timeout のタイマーは unref で、他に動くものが無いと待ちごと終わってしまう）
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; abort.abort(); }, timeoutMs);
    const signal = abort.signal;
    const stopped = () => (timedOut ? new ImportFailed('timeout', t('attach.import.timeout')) : new ImportFailed('cancelled', t('attach.import.cancelled')));
    let release = null;
    try {
      release = await acquire(signal, stopped);
      if (signal.aborted) throw stopped();
      let res;
      try {
        // 名前の解決は止められないので、時間切れ・やめたときは待たずに失敗にして枠を返す（遅れて来た応答は捨てる）
        const call = guarded(String(url), {
          signal, method: 'GET',
          // Cookie・Referer・認証は付けない（fetch は既定で持たない。ここで足さない）
          headers: { 'user-agent': USER_AGENT, accept: 'image/avif,image/webp,image/png,image/jpeg,image/gif;q=0.9,*/*;q=0.1' },
        });
        call.then((late) => { if (signal.aborted) late.body?.cancel().catch(() => {}); }, () => {});
        res = await Promise.race([call, new Promise((_, reject) => {
          if (signal.aborted) reject(stopped());
          else signal.addEventListener('abort', () => reject(stopped()), { once: true });
        })]);
      } catch (e) {
        if (e instanceof ImportFailed) throw e;
        if (signal.aborted) throw stopped();
        // 検査で断った理由は MCP 用の文言なので、取り込み用の文言に替える（画面には出さない）
        if (e?.code === 'MCP_URL_REJECTED') throw new ImportFailed('rejected', t('attach.import.rejected'));
        throw new ImportFailed('network', t('attach.import.network'));
      }
      if (!res.ok) { await res.body?.cancel().catch(() => {}); throw new ImportFailed('http-status', t('attach.import.status', { status: res.status })); }
      let buf;
      try { buf = await readLimited(res, signal); }
      catch (e) {
        if (e instanceof ImportFailed) throw e;
        if (signal.aborted) throw stopped();
        throw new ImportFailed('network', t('attach.import.network'));
      }
      const kind = sniffImage(buf);
      if (!kind) throw new ImportFailed('not-image', t('attach.import.notImage'));
      const size = imageSize(buf, kind);
      if (size && size.width <= IMPORT_SMALL_PX && size.height <= IMPORT_SMALL_PX) throw new ImportFailed('too-small', t('attach.import.tooSmall'));
      if (signal.aborted) throw stopped();
      const fileName = `${baseNameOf(name)}.${kind.ext}`;
      const { dir, rel } = target(sessionId, fileName);
      await fs.mkdir(dir, { recursive: true });
      // 同じ名前・同じ時刻の取り込みが並んだら、枝番を付けて置く（上書きしない）
      let file = path.join(dir, rel);
      for (let n = 2; ; n++) {
        try { await fs.writeFile(file, buf, { flag: 'wx' }); break; }
        catch (e) { if (e?.code !== 'EEXIST' || n > 20) throw e; file = path.join(dir, rel.replace(/(\.[^.]*)$/, `-${n}$1`)); }
      }
      // 書いている間にやめられた: 画面は結果を捨てるので、置いたファイルも残さない
      if (signal.aborted) { await fs.unlink(file).catch(() => {}); throw stopped(); }
      if (importId) remember(completed, importId, file);
      return { path: file, bytes: buf.length, kind: 'image', mime: kind.mime, name: fileName };
    } finally {
      clearTimeout(timer);
      release?.();
      entries.delete(id);
    }
  }

  /**
   * やめる。順番待ち・取りに行っている途中なら切る。もう取れて置いてあるなら、そのファイルを消す（画面は結果を捨てた）。
   * まだ届いていない importId は覚えておく（あとから届いても取りに行かない）。止めたか消したら true
   */
  function cancel(importId) {
    const abort = entries.get(importId);
    if (abort) { abort.abort(); return true; }
    const file = completed.get(importId);
    if (file) {
      completed.delete(importId);
      fs.unlink(file).catch(() => {});
      return true;
    }
    remember(cancelled, importId);
    return false;
  }

  return { importImage, cancel, get activeCount() { return running; }, get waitingCount() { return queue.length; } };
}
