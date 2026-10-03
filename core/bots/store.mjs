// bot の定義の保存（<data>/bots.json。`{ version: 1, bots: Bot[] }`）。形の正本は core/channels/types.mjs の Bot。
// 保存は core/atomic-file.mjs の writeAtomic、書き込みは全体で 1 本の直列化キュー。読めない版・壊れた JSON は読み込まずに止める
// （`BotStoreError`。上書きして消さない。hooks.json の parseConfig と同じ方針）。
//
//   createBotStore({ file }) → BotStore
//     load(): Promise<void>                … 読む（無ければ空）。読めなければ BotStoreError を投げ、以後の書き込みも断る
//     list(): Bot[]・get(id): Bot|null・byName(name): Bot|null（名前は nameKey で比べる）
//     put(bot): Promise<Bot>               … 追加か置き換え（id で）
//     update(id, fn): Promise<Bot>         … fn(現在の bot の写し) が返した bot で置き換える。直列化の中で読み直すので、競合しない
//     remove(id): Promise<Bot|null>
import fs from 'node:fs/promises';
import path from 'node:path';
import { writeAtomic } from '../atomic-file.mjs';
import { EMOJI_RE } from '../../web/emoji.mjs';

export const BOTS_VERSION = 1;
// ウイルス対策などが一時的に開いている間の読み取りの失敗（再試行で通ることが多い）
const TRANSIENT_READ = new Set(['EBUSY', 'EACCES', 'EPERM', 'EMFILE', 'ENFILE']);
const READ_RETRIES = [60, 200, 500];
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** code は BOTS_CORRUPT・BOTS_UNSUPPORTED_VERSION・BOTS_UNREADABLE（読めない。読み取りの失敗も含む）／ BOT_NOT_FOUND・BOT_NAME_TAKEN・BOT_INVALID・INVALID（操作の失敗。ops が OpError にする） */
export class BotStoreError extends Error {
  constructor(code, message, extra = {}) { super(message); this.name = 'BotStoreError'; this.code = code; Object.assign(this, extra); }
}

/** 名前の比較キー（NFKC・大小を区別しない。@ の解析と同じ規則）。名前はチャンネルを通して一意 */
export const nameKey = (name) => String(name ?? '').normalize('NFKC').trim().toLowerCase();

/** `@あなた` / `@you` は人への呼びかけなので、bot の名前にはできない */
export const RESERVED_NAMES = Object.freeze(['you', 'あなた']);   // i18n-ignore: @あなた は @ の解析が受ける語（名前の予約。表示しない）
export const NAME_MAX = 32;
// 空白・@・タグの記号・文の区切りは、@ の解析（名前の後ろは空白・句読点・行末）と食い違うので名前に入れない
const NAME_RX = /^[^\s@<>"'`.,;:!?、。，．！？：；()（）[\]{}「」『』]+$/u;
export const PERSONA_MAX_CHARS = 6000;   // 人格は 1.5k トークンまで（estimateTokens の上限の目安。日本語は 1 字 ≒ 1 トークン弱なので字数でも抑える）
export const FOLDERS_MAX = 20;
export const SEND_TARGETS_MAX = 100;

const oneEmoji = (s) => { const m = String(s ?? '').match(EMOJI_RE); return Boolean(m) && m.length === 1 && m[0] === s; };

/** 名前の検査。問題があれば理由の文（英語の短い説明。画面・ops が INVALID の detail に使う）、無ければ null */
export function nameProblem(name) {
  if (typeof name !== 'string' || !name.trim()) return 'name: required';
  if (name !== name.trim()) return 'name: must not start or end with a space';
  if ([...name].length > NAME_MAX) return `name: at most ${NAME_MAX} characters`;
  if (!NAME_RX.test(name)) return 'name: must not contain spaces, @, quotes, brackets or sentence punctuation';
  if (RESERVED_NAMES.includes(nameKey(name))) return 'name: reserved (you)';
  return null;
}
export const iconProblem = (icon) => (oneEmoji(icon) ? null : 'icon: a single emoji');
export const personaProblem = (persona) => (typeof persona !== 'string' ? 'persona: string'
  : [...persona].length > PERSONA_MAX_CHARS ? `persona: at most ${PERSONA_MAX_CHARS} characters` : null);

const str = (v, d = '') => (typeof v === 'string' ? v : d);
const num = (v, d) => (Number.isFinite(v) ? v : d);

/** フォルダーの並び（先頭が既定の作業場所）。パスの重複（区切り・末尾の / ・Windows の大小）は先のものを残す */
export function normalizeFolders(list) {
  const seen = new Set(), out = [];
  for (const f of Array.isArray(list) ? list : []) {
    const p = typeof f === 'string' ? f : f?.path;
    if (typeof p !== 'string' || !p.trim()) continue;
    const key = folderKey(p);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ path: p.trim(), access: f?.access === 'ro' ? 'ro' : 'rw' });
  }
  return out.slice(0, FOLDERS_MAX);
}
/** パスの比較キー。Windows は大小を区別せず、区切りと末尾の区切りを揃える */
export function folderKey(p) {
  let s = path.normalize(String(p).trim());
  if (s.length > 1) s = s.replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? s.toLowerCase() : s;
}

/** 読んだ 1 件を Bot の形に整える（足りない欄は既定、知らない欄は捨てる）。id と name が無ければ null */
export function normalizeBot(raw, now = Date.now()) {
  if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || !raw.id || typeof raw.name !== 'string' || !raw.name) return null;
  return {
    id: raw.id, name: raw.name, icon: str(raw.icon, '🤖'), persona: str(raw.persona),
    backend: str(raw.backend), model: str(raw.model), effort: str(raw.effort), mode: str(raw.mode),
    folders: normalizeFolders(raw.folders),
    sendToOthers: raw.sendToOthers !== false,
    sendTargets: [...new Set((Array.isArray(raw.sendTargets) ? raw.sendTargets : []).filter((s) => typeof s === 'string' && s))].slice(0, SEND_TARGETS_MAX),
    dmChannelId: str(raw.dmChannelId), dmSessionId: typeof raw.dmSessionId === 'string' && raw.dmSessionId ? raw.dmSessionId : null,
    createdAt: num(raw.createdAt, now), updatedAt: num(raw.updatedAt, num(raw.createdAt, now)),
  };
}

export function createBotStore({ file } = {}) {
  if (!file) throw new Error('createBotStore: file is required');
  let bots = [];
  let broken = null;            // 読めなかった理由（BotStoreError）。立っている間は書かない
  let queue = Promise.resolve();
  const serial = (fn) => { const task = queue.catch(() => {}).then(fn); queue = task; return task; };
  const copy = (b) => structuredClone(b);
  const guard = () => { if (broken) throw broken; };
  // 名前はチャンネルを通して一意。直列化の中で確かめるので、同時の作成でも重ならない
  const taken = (bot) => {
    if (bots.some((x) => x.id !== bot.id && nameKey(x.name) === nameKey(bot.name))) throw new BotStoreError('BOT_NAME_TAKEN', `the name is already used: ${bot.name}`, { name: bot.name });
  };
  const save = async () => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await writeAtomic(file, `${JSON.stringify({ version: BOTS_VERSION, bots }, null, 2)}\n`);
  };

  return {
    file,
    /** 読めなかった理由（BotStoreError）。読めているなら null。画面へ出して止める材料 */
    get problem() { return broken; },
    async load() {
      let text;
      for (let attempt = 0; ; attempt++) {
        try { text = await fs.readFile(file, 'utf8'); break; }
        catch (e) {
          if (e.code === 'ENOENT') { bots = []; broken = null; return; }
          if (TRANSIENT_READ.has(e.code) && attempt < READ_RETRIES.length) { await wait(READ_RETRIES[attempt]); continue; }
          // 読めなかっただけで「bot が 0 件」と見なさない（次の保存で bots.json を空の一覧で上書きしてしまう）。読み直すには再起動する
          broken = new BotStoreError('BOTS_UNREADABLE', `bots.json could not be read (${e.code ?? e.message}); check whether another program has it open: ${file}`);
          throw broken;
        }
      }
      let data;
      try { data = JSON.parse(text); }
      catch { broken = new BotStoreError('BOTS_CORRUPT', `bots.json is not valid JSON: ${file}`); throw broken; }
      if (data?.version !== BOTS_VERSION || !Array.isArray(data.bots)) {
        broken = new BotStoreError('BOTS_UNSUPPORTED_VERSION', `bots.json has an unsupported version (${data?.version}): ${file}`);
        throw broken;
      }
      broken = null;
      bots = data.bots.map((b) => normalizeBot(b)).filter(Boolean);
      // id か name が無い行は読み込まれず、次の保存で消える。黙って消さずにログへ残す
      if (bots.length < data.bots.length) console.error(`  bots: ${data.bots.length - bots.length} row(s) of bots.json have no id or name and were dropped: ${file}`);
    },
    list: () => bots.map(copy),
    get: (id) => { const b = bots.find((x) => x.id === id); return b ? copy(b) : null; },
    byName: (name) => { const key = nameKey(name); const b = key ? bots.find((x) => nameKey(x.name) === key) : null; return b ? copy(b) : null; },
    put(bot) {
      return serial(async () => {
        guard();
        const next = normalizeBot(bot, bot?.createdAt);
        if (!next) throw new BotStoreError('BOT_INVALID', 'bot needs id and name');
        taken(next);
        const i = bots.findIndex((x) => x.id === next.id);
        const before = bots;
        bots = i < 0 ? [...bots, next] : bots.map((x, j) => (j === i ? next : x));
        try { await save(); } catch (e) { bots = before; throw e; }
        return copy(next);
      });
    },
    update(id, fn) {
      return serial(async () => {
        guard();
        const i = bots.findIndex((x) => x.id === id);
        if (i < 0) throw new BotStoreError('BOT_NOT_FOUND', `no such bot: ${id}`);
        const next = normalizeBot(await fn(copy(bots[i])), bots[i].createdAt);
        if (!next || next.id !== id) throw new BotStoreError('BOT_INVALID', 'update must keep the bot id');
        taken(next);
        const before = bots;
        bots = bots.map((x, j) => (j === i ? next : x));
        try { await save(); } catch (e) { bots = before; throw e; }
        return copy(next);
      });
    },
    remove(id) {
      return serial(async () => {
        guard();
        const found = bots.find((x) => x.id === id);
        if (!found) return null;
        const before = bots;
        bots = bots.filter((x) => x.id !== id);
        try { await save(); } catch (e) { bots = before; throw e; }
        return copy(found);
      });
    },
  };
}
