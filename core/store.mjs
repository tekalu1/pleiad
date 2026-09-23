// バックエンドが持たない差分を持つ sidecar ストア。**全バックエンド横断のインデックス**でもある。
//
// v1 では正本を全部 ~/.claude（SDK ネイティブ）に置いていたが、
// codex / procway-code には等価物が無い（docs/multi-backend.md §2.1 で改訂）。
//
//   backend        … このセッションを回すバックエンドの id。これが無いと誰に聞けばよいか分からない
//   title / status … バックエンドがネイティブに持てるなら**そちらが正本**、持てないならここが正本。
//                    書くときは常に両方へ書く（capabilities.title / .tag で読み分ける）
//   cwd / createdAt / lastModified … ネイティブ優先、無ければここ
//   statusChangedAt … tag がいつ変わったか（lastModified はセッション全体の mtime で代用不可）
//   history         … いつ・誰が・何を・なぜ変えたか
//   parent          … fork 元。Claude の forkSession は transcript 内の親子は保つが listSessions に出ない
//   ungrouped       … 人が「グループから外した／解除した」と決めた印。グループは親子と状態から自動で決まるので、
//                     外したことだけを覚える（docs/design-system.md §4.1）
//   mode / model    … 承認モードとモデルの記憶（人間だけが変えられる）
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const DIR = process.env.AGENT_HOST_DATA ?? path.join(os.homedir(), ".agent-host");
const FILE = path.join(DIR, "sessions.json");
const PREFS = path.join(DIR, "prefs.json");
const STATUSES = path.join(DIR, "statuses.json");

// sidecar が持つメタ情報のうち、外から丸ごと上書きしてよいもの。
// history / parent / mode / model は専用の口があるので、ここには入れない。
const META_KEYS = new Set(["backend", "title", "status", "cwd", "createdAt", "lastModified", "completedAt", "unsent"]);

/**
 * JSON ファイル 1 つ。読みは一度きりでキャッシュ、書きは一時ファイルへ書いてから置き換える
 * （書き込み中に落ちても既存を壊さない）。sidecar のファイルは全部この経路を通す。
 * 壊れている・無い・オブジェクトでないときは空から始める。
 */
function jsonFile(file) {
  let cache = null;
  return {
    async read() {
      if (cache) return cache;
      try {
        const v = JSON.parse(await fs.readFile(file, "utf8"));
        cache = v && typeof v === "object" && !Array.isArray(v) ? v : {};
      } catch {
        cache = {};
      }
      return cache;
    },
    async write() {
      await fs.mkdir(DIR, { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(cache, null, 2), "utf8");
      await fs.rename(tmp, file);
    },
  };
}

const sessions = jsonFile(FILE);
const prefs = jsonFile(PREFS);
const statuses = jsonFile(STATUSES);

const load = () => sessions.read();
const flush = () => sessions.write();

// 書き込みを直列化する。人間と AI が同時に触っても read-modify-write が交錯しない
let chain = Promise.resolve();

function exclusive(work) {
  const next = chain.then(work, work);
  chain = next.then(() => {}, () => {});
  return next;
}

// ---- 全体の既定 ------------------------------------------------------------
// セッション個別の設定とは別に、「次に新しく始めるときの既定」を覚える。
// 一度 auto を選んだ人に毎回選び直させない。

/** 既定値。ユーザーが一度も選んでいなければこれが使われる。 */
export async function getPrefs() {
  return { ...(await prefs.read()) };
}

/** 既定を上書きする。人間が明示的に選んだときだけ呼ぶ。 */
export async function setPref(key, value, backendId) {
  return exclusive(async () => {
    const all = await prefs.read();
    if (value === null || value === undefined) delete all[key];
    else all[key] = value;
    if (backendId && (key === "mode" || key === "model" || key === "effort")) {
      const previous = all.backends ? all.backends[backendId] : { mode: all.mode, model: all.model };
      all.backends ??= {};
      all.backends[backendId] = { ...previous, [key]: value };
    }
    await prefs.write();
    return { ...all };
  });
}

// ---- 状態グループ（statuses.json） ------------------------------------------
// 状態は SDK の tag（自由文字列）で、事前定義もアイコンも SDK には無い。
// ここには { [status]: { icon?, createdAt? } } を持つ。使われた状態はここに無くても存在する（§6）が、
// **ここにある限り、セッションが 0 件でもグループとして存在する**（人が作った空のグループ）。
// 人間が選んでも AI が渡しても同じ場所に入る（設計メモ 2.2）。

const cleanEntry = (v) => {
  const out = {};
  if (typeof v?.icon === "string" && v.icon) out.icon = v.icon;
  if (typeof v?.createdAt === "string" && v.createdAt) out.createdAt = v.createdAt;
  return out;
};

/** 状態 -> { icon?, createdAt? }。statuses.json にある状態は全部（空のグループも） */
export async function getStatusEntries() {
  const all = await statuses.read();
  const out = {};
  for (const [k, v] of Object.entries(all)) if (k.trim()) out[k] = cleanEntry(v);
  return out;
}

/** グループを作る。既にあれば何もしない。使われる前から一覧に出る */
export async function createStatus(status) {
  return exclusive(async () => {
    const all = await statuses.read();
    if (!all[status]) all[status] = { createdAt: new Date().toISOString() };
    await statuses.write();
    return cleanEntry(all[status]);
  });
}

/** アイコンを設定する。空なら「なし」に戻す（既定）。グループそのものは消さない */
export async function setStatusIcon(status, icon) {
  return exclusive(async () => {
    const all = await statuses.read();
    const v = typeof icon === "string" ? icon.trim() : "";
    const entry = cleanEntry(all[status]);
    if (v) entry.icon = v; else delete entry.icon;
    all[status] = entry;
    await statuses.write();
    return v || null;
  });
}

/**
 * 状態の改名・削除に追従する。to が空なら捨てる（グループの削除）。
 * 改名先が既にあれば合わせる: アイコンは先にあった方を残し、作った時刻は古い方。
 */
export async function moveStatus(from, to) {
  return exclusive(async () => {
    const all = await statuses.read();
    if (!(from in all)) return;
    const entry = cleanEntry(all[from]);
    delete all[from];
    if (to) {
      const dst = cleanEntry(all[to]);
      const merged = { ...entry, ...dst };
      if (entry.createdAt && (!dst.createdAt || entry.createdAt < dst.createdAt)) merged.createdAt = entry.createdAt;
      all[to] = merged;
    }
    await statuses.write();
  });
}

export async function get(sessionId) {
  const all = await load();
  return all[sessionId] ?? { history: [] };
}

export async function getAll() {
  return { ...(await load()) };
}

/** history を後ろから辿って、その field が最後に取った値を返す。 */
function lastValue(entry, field) {
  const history = entry?.history ?? [];
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i]?.field === field) return history[i].to ?? null;
  }
  return null;
}

// アプリの語彙（status / title）と、バックエンドのセッション行のキーの対応。
// 行の形は docs/multi-backend.md §2.3 の listSessions / getSession が返すもの。
const NATIVE_KEY = { status: "tag", title: "title", cwd: "cwd" };

/**
 * 変更前の値を復元する。
 * 呼び出し側は setTag / setTitle の**後**に recordChange を呼ぶので、
 * その時点でバックエンドを読むと既に新しい値になっている。まず自分の history を
 * 一次情報として使い、そこに無いとき（agent-host の外で付けられた分の初回）だけ
 * バックエンドを見る。値が to と同じなら既に上書き済みで前の値は分からないので null。
 */
async function resolveFrom(sessionId, entry, field, to, backend) {
  const prev = lastValue(entry, field);
  if (prev != null) return prev;

  const key = NATIVE_KEY[field];
  if (!key) return null;

  // ネイティブに持てないバックエンドでは sidecar 側の値が唯一の手がかり
  const mine = entry?.[field];
  if (!backend?.getSession) return mine != null && mine !== to ? mine : null;

  try {
    const info = await backend.getSession(sessionId);
    const current = info?.[key] ?? mine ?? null;
    return current != null && current !== to ? current : null;
  } catch {
    return mine != null && mine !== to ? mine : null;
  }
}

/**
 * メタ情報の変更を1件記録する。人間も AI も同じ経路を通る（設計メモ 2.2）。
 * `by` は可読性のためだけに残す。この値で権限を分岐させない。
 * `from` を渡さない（または null の）場合は直前の値をこちらで補う。
 * `backend` はバックエンドのオブジェクト。from の復元と、行がどこのものかの記録に使う。
 */
export async function recordChange(sessionId, { by, field, from, to, reason, backend }) {
  return exclusive(async () => {
    const all = await load();
    const entry = (all[sessionId] ??= { history: [] });
    entry.history ??= [];

    const resolved = from ?? (await resolveFrom(sessionId, entry, field, to ?? null, backend));
    const at = new Date().toISOString();

    entry.history.push({
      at,
      by,
      field,
      from: resolved ?? null,
      to: to ?? null,
      reason: reason ?? null,
    });
    if (backend?.id) entry.backend = backend.id;
    // ネイティブに持てるバックエンドでも sidecar に写す。
    // 正本がどちらであれ、一覧はここだけを読んでも組めるようにしておく（§2.4）。
    if (field === "status") { entry.status = to ?? null; entry.statusChangedAt = at; }
    if (field === "title") entry.title = to ?? null;
    if (field === "parent") entry.parent = to;
    if (field === "cwd") entry.cwd = to ?? null;
    await flush();
    return entry;
  });
}

/**
 * バックエンド由来のメタ情報（backend / title / status / cwd / createdAt / lastModified）を書く。
 * 変更履歴には残らない。「誰がなぜ変えたか」が要るものは recordChange を通すこと。
 */
export async function setMeta(sessionId, patch) {
  if (!sessionId || !patch) return null;
  return exclusive(async () => {
    const all = await load();
    const entry = (all[sessionId] ??= { history: [] });
    let touched = false;
    for (const [k, v] of Object.entries(patch)) {
      if (!META_KEYS.has(k) || v === undefined) continue;
      if (entry[k] === v) continue;
      entry[k] = v;
      touched = true;
    }
    if (touched) await flush();
    return entry;
  });
}

/**
 * 承認モードを覚える。**人間だけが変えられる**（設計メモ 2.2 の括弧書き:
 * 権限層はセッションのメタ情報とは別の層で、パートナー対称性の対象外）。
 * AI が自分の承認モードを緩められると、承認フローそのものが意味を失う。
 */
export async function setMode(sessionId, mode) {
  // id が決まっていないものは書かない（setMeta と同じ。all[null] を作らせない）
  if (!sessionId) return null;
  return exclusive(async () => {
    const all = await load();
    const entry = (all[sessionId] ??= { history: [] });
    entry.mode = mode;
    await flush();
    return entry;
  });
}

/** 使うモデルを覚える。承認モードと同じく人間の操作からしか来ない。 */
export async function setModel(sessionId, model) {
  // id が決まっていないものは書かない（setMeta と同じ。all[null] を作らせない）
  if (!sessionId) return null;
  return exclusive(async () => {
    const all = await load();
    const entry = (all[sessionId] ??= { history: [] });
    entry.model = model;
    await flush();
    return entry;
  });
}

/** Snapshot execution choices; drafts and unrelated metadata stay with the source. */
export async function inheritSettings(sourceId, childId) {
  return exclusive(async () => {
    const all = await load();
    const source = all[sourceId] ?? {};
    const entry = (all[childId] ??= { history: [] });
    entry.model = source.model ?? "";
    entry.effort = source.effort ?? "";
    entry.mode = source.mode ?? "default";
    entry.nextSettings = structuredClone(source.nextSettings ?? null);
    // Claude のアカウント（core/claude-accounts.mjs）。分岐した先も同じアカウントで続ける
    if (source.claudeAccount) entry.claudeAccount = source.claudeAccount;
    else delete entry.claudeAccount;
    entry.contextSession = structuredClone(source.contextSession ?? null);
    await flush();
  });
}

export async function setParent(sessionId, parent) {
  // id が決まっていないものは書かない（setMeta と同じ。all[null] を作らせない）
  if (!sessionId) return null;
  return exclusive(async () => {
    const all = await load();
    const entry = (all[sessionId] ??= { history: [] });
    entry.parent = parent;
    await flush();
    return entry;
  });
}

export const dataDir = DIR;

/** Host-only data; durable before acknowledging the client. Roll back a failed write. */
export async function setSessionData(sessionId, field, value) {
  if (!sessionId || !["draft", "nextSettings", "outbox", "effort", "procwayLimits", "contextSession", "delegation", "taskNotices", "ungrouped", "claudeAccount"].includes(field)) throw new Error("不正なセッション設定");
  return exclusive(async () => {
    const all = await load();
    const before = all[sessionId];
    const entry = { ...(before ?? { history: [] }), [field]: structuredClone(value) };
    all[sessionId] = entry;
    try { await flush(); } catch (e) { if (before) all[sessionId] = before; else delete all[sessionId]; throw e; }
    return entry[field];
  });
}

export async function removeSession(sessionId) {
  return exclusive(async () => {
    const all = await load(), before = all[sessionId];
    delete all[sessionId];
    try { await flush(); } catch (e) { if (before) all[sessionId] = before; throw e; }
  });
}
