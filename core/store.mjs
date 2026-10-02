// バックエンドが持たない差分を持つ sidecar ストア。**全バックエンド横断のインデックス**でもある。
//
// v1 では正本を全部 ~/.claude（SDK ネイティブ）に置いていたが、
// codex には等価物が無い（docs/multi-backend.md §2.1 で改訂）。
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
//   readAt          … 確認済みの完了時刻（completedAt のうち人が見たもの）。ホストに 1 つで、どの端末・窓から見ても同じ
//                     （markRead。大きい方だけを採り、completedAt を超えない。docs/design.md「完了・未確認」）
//   routing         … 委譲の子の会話が、どう選ばれたか（ply_delegate の返り値の routing と同じ形。core/delegation-routing.mjs）
//   interrupted     … 中断したまま次のターンが始まっていない印 { at, reason }（reason: user|update|quit|hostAway|restart）。
//                     ターンが中断で終わったら書き、次のターンの開始で null にする（core/server.mjs。docs/design.md「中断と再開」）
//   stops           … 中断（と再起動）で Pleiad が止めたもののうち、まだエージェントに伝えていないもの
//                     { tasks: [{ key, taskId, title, status, unread, restart? }], background: [{ key, id, kind, label }],
//                       approvals: [{ key, tool, target }], dropped, reason }。次のターンで 1 回だけ伝え、渡った分を消す（addStops / takeStops。
//                     docs/design.md「中断と再開」）
//   turnStartedAt   … 走っているターンの開始時刻。終わりで片付ける。起動時に残っていれば、落ちて終わりが記録されなかったターン（restart）
//   agentLocale     … 会話の言語（ja|en）。エージェントに渡す文（指示・ツールの説明・通知）の言語。会話を始めたときに
//                     画面の言語で決め、以後は変えない（core/server.mjs。docs/design.md「多言語対応」）
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { t } from "./i18n.mjs";
import { COMPUTER_APP_LIMIT, computerAppRow, computerUsePrefs } from "../web/computer-prefs.mjs";

const DIR = process.env.AGENT_HOST_DATA ?? path.join(os.homedir(), ".agent-host");
const FILE = path.join(DIR, "sessions.json");
const PREFS = path.join(DIR, "prefs.json");
const STATUSES = path.join(DIR, "statuses.json");

// sidecar が持つメタ情報のうち、外から丸ごと上書きしてよいもの。
// history / parent / mode / model は専用の口があるので、ここには入れない。
const META_KEYS = new Set(["backend", "title", "status", "cwd", "createdAt", "lastModified", "completedAt", "unsent", "interrupted", "turnStartedAt"]);

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

export async function rememberBrowserSite(site) {
  return exclusive(async () => {
    const all = await prefs.read();
    // 鍵はエージェント・プロフィール・origin（ADR 0078）。プロフィールを持たない古い行はメインのもの
    const profileOf = row => row.profile ?? 'main';
    all.agentSitePermissions = [...(all.agentSitePermissions ?? []).filter(row => row.agent !== site.agent || row.origin !== site.origin || profileOf(row) !== profileOf(site)), site];
    await prefs.write();
    return { ...all };
  });
}

/** 内蔵ブラウザーのプロフィールを、その作業フォルダーで最後に使ったものとして覚える（新しい会話の既定。ADR 0078）。古い順に 100 件まで */
export async function rememberBrowserProfile(key, profile) {
  return exclusive(async () => {
    const all = await prefs.read();
    const last = { ...(all.browserLastProfiles ?? {}) };
    if (last[key] === profile) return { ...all };
    delete last[key];
    last[key] = profile;
    const keys = Object.keys(last);
    for (const old of keys.slice(0, Math.max(0, keys.length - 100))) delete last[old];
    all.browserLastProfiles = last;
    await prefs.write();
    return { ...all };
  });
}

/** computer use の「常に許可」に 1 行足す（同じ id は名前・パス・日時を新しくする）。形が違えば足さない。一覧が上限なら古い順に落とす */
export async function rememberComputerApp(app) {
  return exclusive(async () => {
    const all = await prefs.read();
    const row = computerAppRow({ id: app?.id, name: app?.name, kind: app?.kind, ...(app?.path ? { path: app.path } : {}), at: new Date().toISOString() });
    if (!row) return { ...all };
    const current = computerUsePrefs(all);
    const rows = [...current.alwaysAllowed.filter(r => r.id !== row.id), row];
    all.computerUse = { ...current, alwaysAllowed: rows.slice(-COMPUTER_APP_LIMIT) };
    await prefs.write();
    return { ...all };
  });
}

/** 「常に許可」から 1 行消す。次にそのアプリを触るとまた聞かれる */
export async function forgetComputerApp(id) {
  return exclusive(async () => {
    const all = await prefs.read();
    const current = computerUsePrefs(all);
    if (!current.alwaysAllowed.some(r => r.id === id)) return { ...all };
    all.computerUse = { ...current, alwaysAllowed: current.alwaysAllowed.filter(r => r.id !== id) };
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
export async function recordChange(sessionId, { by, field, from, to, reason, reasonKey, reasonParams, backend }) {
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
      // 新しい記録は理由をキーでも持つ（画面が今の言語で出す。web/saved-text.mjs）。reason は従来どおりの日本語の文
      ...(reasonKey ? { reasonKey, ...(reasonParams ? { reasonParams } : {}) } : {}),
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
    // 互換の接続先（core/compat-endpoints.mjs）。分岐は同じエージェントなので、同じ接続先で続ける
    if (source.compatEndpoint) entry.compatEndpoint = source.compatEndpoint;
    else delete entry.compatEndpoint;
    // 会話の言語（エージェントに渡す文の言語。core/server.mjs）。分岐・切り替えた先も同じ言語で続ける（履歴と同じ言語のまま）
    if (source.agentLocale) entry.agentLocale = source.agentLocale;
    else delete entry.agentLocale;
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
  if (!sessionId || !["draft", "nextSettings", "outbox", "effort", "contextSession", "delegation", "taskNotices", "ungrouped", "claudeAccount", "compatEndpoint", "agentLocale", "routing", "compactions", "contextWindow", "autoCompactionOff", "compacted", "hookRuns", "shellPending", "shellExits", "shellKept", "computerApps", "browserProfile"].includes(field)) throw new Error(t("store.invalidSessionField"));
  return exclusive(async () => {
    const all = await load();
    const before = all[sessionId];
    const entry = { ...(before ?? { history: [] }), [field]: structuredClone(value) };
    all[sessionId] = entry;
    try { await flush(); } catch (e) { if (before) all[sessionId] = before; else delete all[sessionId]; throw e; }
    return entry[field];
  });
}

/**
 * 完了を確認した印（readAt）を付ける。reads は [[sessionId, completedAt], ...]。
 * 何度送っても同じで（冪等）、巻き戻らない（大きい方だけ）。記録に無い会話・完了していない会話には付けず、
 * その会話の completedAt を超える値は completedAt に丸める（先の完了まで見たことにさせない）。
 * 変わった分だけを [[sessionId, readAt], ...] で返す。1 件でも変われば 1 回だけ書く。
 */
export async function markRead(reads) {
  const list = Array.isArray(reads) ? reads : [];
  return exclusive(async () => {
    const all = await load();
    const changed = new Map(), before = new Map();
    for (const pair of list) {
      const [id, at] = Array.isArray(pair) ? pair : [];
      if (typeof id === "string" && Object.hasOwn(all, id) && Number.isFinite(at) && at > 0) {
        const entry = all[id];
        if (!Number.isFinite(entry?.completedAt)) continue;
        const next = Math.min(at, entry.completedAt);
        if (next <= (Number.isFinite(entry.readAt) ? entry.readAt : 0)) continue;
        if (!before.has(id)) before.set(id, entry.readAt);
        entry.readAt = next;
        changed.set(id, next);
      }
    }
    // 書けなければ元に戻す（確認済みと答えたのに再起動で戻る、を作らない）
    if (changed.size) {
      try { await flush(); } catch (e) {
        for (const [id, prev] of before) { if (prev === undefined) delete all[id].readAt; else all[id].readAt = prev; }
        throw e;
      }
    }
    return [...changed];
  });
}

/**
 * 起動時に 1 回。turnStartedAt が完了（completedAt）より新しい会話は、走っている間に Pleiad が落ちた・強制終了された
 * （終わりが記録されなかった）ので、中断（reason: restart）にする。completedAt も同じ時刻にする: 終わったターンとして数え、
 * 確認済みの印（readAt。markRead は completedAt で丸める）が中断の時刻まで届くようにするため。
 * turnStartedAt は片付ける。変えた会話の id を返す
 */
export async function recoverInterruptedTurns(at = Date.now()) {
  return exclusive(async () => {
    const all = await load();
    const changed = [];
    let touched = false;
    for (const [id, entry] of Object.entries(all)) {
      if (!entry || entry.turnStartedAt == null) continue;
      const started = entry.turnStartedAt;
      if (Number.isFinite(started) && started > (Number.isFinite(entry.completedAt) ? entry.completedAt : 0)) {
        entry.interrupted = { at, reason: "restart" };
        entry.completedAt = at;
        changed.push(id);
      }
      entry.turnStartedAt = null;
      touched = true;
    }
    if (touched) await flush();
    return changed;
  });
}

// 「止めたもの」の種類ごとの上限。超えた分は数だけ残す（dropped）
const STOPS_MAX = 30;
const STOP_LISTS = ["tasks", "background", "approvals"];

/**
 * 中断で止めたもの（stops）を会話に足す。同じ key のものは新しい方で置き換える（同じタスクを 2 度止めても 1 件）。
 * patch: { tasks?, background?, approvals? }（それぞれ key を持つ項目の配列）。会話の行が無ければ書かない
 */
export async function addStops(sessionId, patch) {
  if (!sessionId || !patch) return null;
  return exclusive(async () => {
    const all = await load();
    const entry = all[sessionId];
    if (!entry) return null;
    const next = structuredClone(entry.stops ?? {});
    let touched = false;
    for (const name of STOP_LISTS) {
      const items = Array.isArray(patch[name]) ? patch[name].filter(x => x?.key) : [];
      if (!items.length) continue;
      const list = (next[name] ?? []).filter(x => !items.some(y => y.key === x.key));
      list.push(...structuredClone(items));
      if (list.length > STOPS_MAX) next.dropped = (next.dropped ?? 0) + list.length - STOPS_MAX;
      next[name] = list.slice(-STOPS_MAX);
      touched = true;
    }
    if (!touched) return entry.stops ?? null;
    // 理由は最後に止めたときのもの（伝える文の見出しに使う）
    if (patch.reason) next.reason = patch.reason;
    entry.stops = next;
    await flush();
    return structuredClone(next);
  });
}

/**
 * エージェントに伝えた分（keys）を stops から消す。伝えている間に足された分は残る。空になれば null。
 * dropped（上限で落とした数）も伝えた（dropped: true）なら消す
 */
export async function takeStops(sessionId, keys, { dropped = false } = {}) {
  if (!sessionId) return null;
  const done = new Set(keys ?? []);
  return exclusive(async () => {
    const all = await load();
    const entry = all[sessionId];
    if (!entry?.stops) return null;
    const next = {};
    for (const name of STOP_LISTS) {
      const list = (entry.stops[name] ?? []).filter(x => !done.has(x.key));
      if (list.length) next[name] = list;
    }
    if (!dropped && entry.stops.dropped) next.dropped = entry.stops.dropped;
    if (Object.keys(next).length && entry.stops.reason) next.reason = entry.stops.reason;
    entry.stops = Object.keys(next).length ? next : null;
    await flush();
    return entry.stops;
  });
}

export async function removeSession(sessionId) {
  return exclusive(async () => {
    const all = await load(), before = all[sessionId];
    delete all[sessionId];
    try { await flush(); } catch (e) { if (before) all[sessionId] = before; throw e; }
  });
}
