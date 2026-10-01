// スクリーンショットの保存・配信・掃除（docs/computer-use.md「スクリーンショットの保存」、ADR 0075）。
// 置き場: <データ置き場>/computer-use/shots/<id>.jpg（モデルに渡したものと同じ JPEG）と、索引 shots.json。
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { writeAtomic } from '../atomic-file.mjs';

export const SHOT_ID = /^[0-9a-f]{32}$/;
export const MAX_SHOTS_PER_SESSION = 300;
export const MAX_SHOTS_BYTES = 1024 ** 3;

export function createShots({ dataDir, perSession = MAX_SHOTS_PER_SESSION, totalBytes = MAX_SHOTS_BYTES, now = () => Date.now() } = {}) {
  const root = path.join(dataDir, 'computer-use');
  const dir = path.join(root, 'shots');
  const indexFile = path.join(root, 'shots.json');
  let index = null;                 // { <id>: { session, at, bytes } }
  let queue = Promise.resolve();    // 索引の読み書きと削除を 1 本の列にする
  const serial = fn => { const run = queue.catch(() => {}).then(fn); queue = run; return run; };
  const fileOf = id => path.join(dir, `${id}.jpg`);

  async function load() {
    if (index) return index;
    try {
      const raw = JSON.parse(await fs.readFile(indexFile, 'utf8'));
      index = raw?.version === 1 && raw.shots && typeof raw.shots === 'object' ? raw.shots : {};
    } catch { index = {}; }
    return index;
  }
  const flush = () => writeAtomic(indexFile, JSON.stringify({ version: 1, shots: index }, null, 2) + '\n');
  const drop = async ids => { for (const id of ids) { delete index[id]; await fs.rm(fileOf(id), { force: true }).catch(() => {}); } };

  /** 上限を超えた分を古い順に消す。session は直前に保存した会話（その会話の上限を先に見る） */
  async function prune(session) {
    const mine = Object.entries(index).filter(([, v]) => v.session === session).sort((a, b) => a[1].at - b[1].at);
    if (mine.length > perSession) await drop(mine.slice(0, mine.length - perSession).map(([id]) => id));
    let sum = Object.values(index).reduce((n, v) => n + (v.bytes || 0), 0);
    if (sum > totalBytes) {
      const all = Object.entries(index).sort((a, b) => a[1].at - b[1].at);
      const victims = [];
      for (const [id, v] of all) { if (sum <= totalBytes) break; victims.push(id); sum -= v.bytes || 0; }
      await drop(victims);
    }
  }

  return {
    dir, indexFile,
    /** JPEG を保存して id を返す。保存に失敗したら例外 */
    save(sessionId, jpeg) {
      return serial(async () => {
        await load();
        const id = crypto.randomBytes(16).toString('hex');
        const bytes = Buffer.from(jpeg);
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(fileOf(id), bytes);
        index[id] = { session: sessionId ?? null, at: now(), bytes: bytes.length };
        try { await prune(sessionId ?? null); await flush(); }
        catch (e) { delete index[id]; await fs.rm(fileOf(id), { force: true }).catch(() => {}); throw e; }
        return id;
      });
    },
    /** 配信用。id の形が違う・索引に無い・ファイルが無いときは null */
    read(id) {
      if (typeof id !== 'string' || !SHOT_ID.test(id)) return Promise.resolve(null);
      return serial(async () => {
        await load();
        if (!index[id]) return null;
        try { return await fs.readFile(fileOf(id)); } catch { return null; }
      });
    },
    /** 保存先の絶対パス（delivery.images が path のとき、モデルへ伝える） */
    pathOf: id => fileOf(id),
    /** 会話を消したときに、その会話の分を消す */
    removeSession(sessionId) {
      return serial(async () => {
        await load();
        const ids = Object.entries(index).filter(([, v]) => v.session === sessionId).map(([id]) => id);
        if (!ids.length) return 0;
        await drop(ids);
        await flush();
        return ids.length;
      });
    },
    /** 索引（テスト・確認用） */
    list: () => serial(async () => ({ ...(await load()) })),
  };
}
