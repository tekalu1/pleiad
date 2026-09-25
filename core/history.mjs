// 履歴の読み出しと present の永続化。
//
// 通常の会話本文はバックエンド、切り替え済みの会話は conversations.mjs が正本を持つ。
// 読み出しは backend.getMessages に委譲し、ここは形を知らない。
// present だけはどのバックエンドも持たないので sidecar に JSONL で積む。
//   ~/.agent-host/presents/<sessionId>.jsonl
//
// ステータスの候補一覧も「事前定義された設定」ではなく、
// バックエンドの tag と sidecar の history から**既に使われたもの**を集めて作る（設計メモ §6）。
import fs from "node:fs/promises";
import path from "node:path";
import crypto from 'node:crypto';
import * as store from "./store.mjs";

const PRESENT_DIR = path.join(store.dataDir, "presents");

// present の上限。これを超える content/dataUri は落として印だけ残す。
const MAX_INLINE_BYTES = 8 * 1024 * 1024;

/** ファイルごとの追記を直列化する（同一セッションへの並行 present で行が壊れないように）。 */
const appendChains = new Map();

function serialize(key, work) {
  const prev = appendChains.get(key) ?? Promise.resolve();
  const next = prev.then(work, work);
  appendChains.set(key, next.catch(() => {}));
  return next;
}

/** sessionId をそのままファイル名にしない。UUID 以外が来ても外に出さない。 */
function presentFile(sessionId) {
  const safe = String(sessionId).replace(/[^A-Za-z0-9._-]/g, "_");
  return path.join(PRESENT_DIR, `${safe}.jsonl`);
}

// ---------------------------------------------------------------- transcript

/**
 * セッションの会話履歴と、そこで提示された成果物を読み出す。
 * セッションが無くても throw しない（{messages: [], presents: []} を返す）。
 *
 * messages はバックエンドが返す NormalizedMessage:
 *   { role, text, uuid, at, thinking?, tools?, toolCalls? }
 *   tools     … 名前だけの配列（旧形。後方互換で残している）
 *   toolCalls … [{ id, name, input, result: { text, isError, truncated } | null }]
 * ライブと履歴で同じ表示ができるよう、toolCalls は web/render.mjs の
 * renderToolCall / applyToolResult にそのまま渡せる形にしてある。
 */
export async function loadTranscript(sessionId, backend) {
  if (!sessionId) return { messages: [], presents: [] };

  const [messages, presents] = await Promise.all([
    backend?.getMessages ? backend.getMessages(sessionId) : Promise.resolve([]),
    backend?.getPresents ? backend.getPresents(sessionId) : readPresents(sessionId),
  ]);

  const notices = new Set((await store.get(sessionId)).taskNotices ?? []);
  for (const m of messages) if (m.role === 'user' && notices.has(crypto.createHash('sha256').update(m.text ?? '').digest('hex'))) m.internalTaskNotice = true;
  return { messages, presents };
}

// ------------------------------------------------------------------ present

export async function readPresents(sessionId, { strict = false } = {}) {
  await appendChains.get(presentFile(sessionId));
  let raw;
  try {
    raw = await fs.readFile(presentFile(sessionId), "utf8");
  } catch (e) {
    if (strict && e.code !== "ENOENT") throw e;
    return [];
  }
  const out = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch (e) {
      if (strict) throw e;
      // 書き込み途中で落ちた行は捨てる。1行壊れても残りは読める
    }
  }
  return out;
}

/**
 * present を1件記録する。payload は present イベントと同じ形。
 * dataUri は数 MB になるので、上限を超えるものは中身を落として印だけ残す
 * （履歴として「出した」ことは残り、開き直しても一覧が壊れない）。
 */
export async function recordPresent(sessionId, payload) {
  if (!sessionId || !payload) return null;

  const record = {
    at: new Date().toISOString(),
    kind: payload.kind ?? "text",
    caption: payload.caption ?? null,
    // 添付の caption は日本語の文のまま残し、画面はキーで今の言語に訳す（core/server.mjs presentAttachments・web/saved-text.mjs）
    ...(payload.captionKey ? { captionKey: payload.captionKey, captionParams: payload.captionParams ?? null } : {}),
    path: payload.path ?? null,
    // id は写しを後から指すため（core/server.mjs の /visualization-snapshot。別タブで開く）。以前の記録は at で指す
    ...(payload.kind === 'visualization' ? { id: crypto.randomUUID(), mode: payload.mode, error: payload.error, reference: payload.reference } : {}),
    // 誰が置いたか。人間の添付と AI の提示は同じ流れに並ぶので、履歴でも区別できるようにする
    by: payload.by === "human" ? "human" : "ai",
    ...(payload.turnKey ? { turnKey: payload.turnKey } : {}),
  };

  const inline =
    Buffer.byteLength(payload.content ?? "", "utf8") + Buffer.byteLength(payload.dataUri ?? "", "utf8");
  // truncated: 載せる前から中身を外したもの（大きな添付の画像。core/server.mjs の presentAttachments）
  if (inline > MAX_INLINE_BYTES || payload.truncated === true) {
    record.truncated = true;
  } else {
    if (payload.content != null) record.content = payload.content;
    if (payload.dataUri != null) record.dataUri = payload.dataUri;
  }

  const file = presentFile(sessionId);
  await serialize(file, async () => {
    await fs.mkdir(PRESENT_DIR, { recursive: true });
    await fs.appendFile(file, JSON.stringify(record) + "\n", "utf8");
  });
  return record;
}

/**
 * 会話に保存された可視化の写しを 1 つ探す（別タブで開く /visualization-snapshot）。
 * id（新しい記録）か at（id の無い以前の記録。同じ時刻が複数あれば最初）で指す。中身の無いもの・エラーのカードは null
 */
export async function findVisualization(sessionId, backend, { id, at } = {}) {
  if (!sessionId || (!id && !at)) return null;
  const presents = backend?.getPresents ? await backend.getPresents(sessionId) : await readPresents(sessionId);
  const found = presents.find(p => p?.kind === 'visualization' && (id ? p.id === id : p.at === at));
  return found && typeof found.content === 'string' && !found.error ? found : null;
}

/** Bind human attachments to a durable message UUID (some agents do not record timestamps). */
export async function anchorAttachments(sessionId, turnKey, messageId) {
  if (!messageId) return;
  const file = presentFile(sessionId);
  await serialize(file, async () => {
    let raw;
    try { raw = await fs.readFile(file, "utf8"); }
    catch (e) { if (e.code === "ENOENT") return; throw e; }
    const rows = raw.split("\n").filter(Boolean).map(line => JSON.parse(line));
    for (const row of rows) if (row.turnKey === turnKey && row.by === "human") row.messageId = messageId;
    await fs.writeFile(file + ".tmp", rows.map(row => JSON.stringify(row)).join("\n") + "\n");
    await fs.rename(file + ".tmp", file);
  });
}

// ----------------------------------------------------------------- statuses

/**
 * これまで使われた状態の一覧 [{ status, count, firstUsedAt, lastUsedAt, icon, kept }]。
 * 既出順（初めて使われた順、firstUsedAt）。一覧のグループも候補もこの順で出す。並べ直すのはここだけ。
 * **事前定義された選択肢ではない。** 既出のものを補完候補として出すだけで、
 * 人間も AI も新しい語をその場で作ってよい（設計メモ §6）。
 *
 * 候補とグループは違う。ここに出る状態が全部グループになるわけではない:
 *   候補   … ここに出るもの全部（履歴にだけ残っている旧名も。語彙は消さない）
 *   グループ … 今どれかのセッションに付いている状態、または kept（statuses.json にある = 人が作った器）
 * グループの削除は「付いているセッションの状態を外し、器を捨てる」。履歴は残るので候補には残る
 * （web/side.mjs の groupOrder がこの規則で出し分ける）。
 *
 * 集める先は2つ:
 *   sidecar history         … いつ変えたかが分かる。同じ状態を何度使ったかも数えられる
 *   バックエンドの tag       … 公式 CLI など agent-host の外で付けたものも拾える
 *                              （ネイティブに tag を持てるバックエンドだけ）
 */
export async function listStatuses(backends = []) {
  const [side, entries, ...lists] = await Promise.all([
    store.getAll().catch(() => ({})),
    store.getStatusEntries().catch(() => ({})),
    ...backends.map((b) =>
      b.capabilities?.tag ? b.listSessions({ limit: 500 }).catch(() => []) : Promise.resolve([]),
    ),
  ]);

  const seen = new Map(); // status -> { status, count, firstUsedAt, lastUsedAt }

  const bump = (status, at) => {
    if (typeof status !== "string" || !status.trim()) return;
    const hit = seen.get(status);
    if (!hit) {
      seen.set(status, { status, count: 1, firstUsedAt: at ?? null, lastUsedAt: at ?? null });
      return;
    }
    hit.count += 1;
    if (at && (!hit.lastUsedAt || at > hit.lastUsedAt)) hit.lastUsedAt = at;
    if (at && (!hit.firstUsedAt || at < hit.firstUsedAt)) hit.firstUsedAt = at;
  };

  // 1) sidecar の history。ここが「いつ・何度」の一次情報
  const recorded = new Map(); // sessionId -> Set<status>
  for (const [sessionId, entry] of Object.entries(side)) {
    const names = new Set();
    for (const h of entry?.history ?? []) {
      if (h?.field !== "status") continue;
      bump(h.to, h.at);
      if (typeof h.to === "string") names.add(h.to);
    }
    recorded.set(sessionId, names);
  }

  // 2) バックエンドの tag。history に無い分だけ足す（同じ変更を二重に数えない）
  for (const sessions of lists) {
    for (const s of sessions) {
      if (!s.tag) continue;
      if (recorded.get(s.sessionId)?.has(s.tag)) continue;
      const at = side[s.sessionId]?.statusChangedAt ?? isoOrNull(s.lastModified);
      bump(s.tag, at);
    }
  }

  // 3) statuses.json。人が作った（まだ誰も付いていない）グループはここにしか無い。
  //    ある限り存在する（count 0、firstUsedAt は作った時刻）。アイコンも合流。付いていない状態は icon: null
  for (const [status, e] of Object.entries(entries)) {
    const hit = seen.get(status);
    if (!hit) seen.set(status, { status, count: 0, firstUsedAt: e.createdAt ?? null, lastUsedAt: null });
    else if (e.createdAt && (!hit.firstUsedAt || e.createdAt < hit.firstUsedAt)) hit.firstUsedAt = e.createdAt;
  }
  const out = [...seen.values()].map((s) => ({ ...s, icon: entries[s.status]?.icon ?? null, kept: Boolean(entries[s.status]) }));
  // 既出順。いつ使われたか分からないものは後ろ
  return out.sort(
    (a, b) => String(a.firstUsedAt ?? "￿").localeCompare(String(b.firstUsedAt ?? "￿")),
  );
}

function isoOrNull(ms) {
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}
