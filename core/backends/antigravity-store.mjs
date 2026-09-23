// Antigravity の会話の控え。**Pleiad が自分で書く。**
//
// **なぜ Pleiad が持つのか**（docs/multi-backend.md §2.8）:
// `agy` には一覧も履歴の取り出し口も無い。`agy --help` のサブコマンドは
// `agent(s)` / `models` / `mcp` / `plugin` / `remote-control` / `update` / `changelog` /
// `install` / `help` だけで、会話を列挙するものが無い（実機で確認）。
// 会話そのものは `~/.gemini/antigravity-cli/` に残るが、要約は SQLite
// （`conversation_summaries.db`、スキーマ非公開）で、読み方の保証が無い。
//
// gemini では本体が書いた記録を**読んだ**（gemini-sessions.mjs）。
// agy では読めるものが無いので、**ターンの最中に見た正規化メッセージをそのまま控える**。
// 置き場は Pleiad の sidecar と同じ `AGENT_HOST_DATA`（既定 `~/.agent-host`）。
//
// 控えなので、`agy` 側で消えた会話が残ることはありうる。`--conversation <id>` が
// 撥ねられた時点で分かるので、そのときに落とす（runTurn の責任）。
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MAX_RESULT_CHARS } from "./shared.mjs";
import { t } from "../i18n.mjs";

/** 控えの置き場。**agy がらみの控えはすべてここに揃える**（pid の控えも: antigravity-pids.mjs）。 */
export function dir() {
  const base = process.env.AGENT_HOST_DATA ?? path.join(os.homedir(), ".agent-host");
  return path.join(base, "antigravity");
}

/** conversation_id はサーバ生成の id。念のためファイル名に使える文字だけに落とす。 */
function fileFor(conversationId) {
  const safe = String(conversationId).replace(/[^A-Za-z0-9._-]/g, "_");
  if (!safe || safe === "." || safe === "..") throw new Error(t("antigravity.errors.badConversationId", { id: conversationId }));
  return path.join(dir(), `${safe}.json`);
}

async function read(conversationId) {
  try {
    const raw = JSON.parse(await fs.readFile(fileFor(conversationId), "utf8"));
    // 控えの形をしていないものは「控えが無い」と同じに扱う。
    // 同じ置き場には pid の控え（antigravity-pids.mjs）も入るので、一覧が拾わないように
    if (!raw || typeof raw !== "object" || Array.isArray(raw) || !Array.isArray(raw.messages)) return null;
    return {
      conversationId: raw.conversationId ?? conversationId,
      cwd: raw.cwd ?? null,
      createdAt: raw.createdAt ?? null,
      lastModified: raw.lastModified ?? null,
      messages: raw.messages,
    };
  } catch {
    return null;   // 無い・壊れている。どちらも「控えが無い」と同じ
  }
}

/** 一時ファイルへ書いてから置き換える。途中で落ちても前のものを壊さない。 */
async function write(record) {
  await fs.mkdir(dir(), { recursive: true });
  const target = fileFor(record.conversationId);
  const tmp = `${target}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(record, null, 2), "utf8");
  await fs.rename(tmp, target);
}

/**
 * 1 ターンぶんの発言を控えに足す。
 *
 * `messages` は正規化済みの NormalizedMessage（history.mjs と同じ形）。
 * 同じ uuid が既にあれば差し替える（ターンの途中でやり直しても二重にならない）。
 */
export async function appendMessages(conversationId, { cwd, messages }) {
  if (!conversationId || !messages?.length) return;
  const now = new Date().toISOString();
  const record = (await read(conversationId)) ?? {
    conversationId, cwd: cwd ?? null, createdAt: now, lastModified: now, messages: [],
  };
  if (cwd) record.cwd = cwd;
  record.lastModified = now;

  for (const message of messages) {
    const at = message.uuid ? record.messages.findIndex((m) => m.uuid === message.uuid) : -1;
    if (at >= 0) record.messages[at] = message;
    else record.messages.push(message);
  }
  await write(record);
}

/** 1 本ぶんの控え。無ければ null。 */
export async function getRecord(conversationId) {
  return conversationId ? read(conversationId) : null;
}

/** 控えの本文。長いツール結果は表示用に切る（fullResults なら切らない）。 */
export async function getMessages(conversationId, { fullResults = false } = {}) {
  const record = await read(conversationId);
  if (!record) return [];
  const messages = structuredClone(record.messages);
  if (!fullResults) {
    for (const m of messages) {
      for (const call of m.toolCalls ?? []) {
        if (call.result?.text?.length > MAX_RESULT_CHARS) {
          call.result.text = call.result.text.slice(0, MAX_RESULT_CHARS) + t("antigravity.truncated");
          call.result.truncated = true;
        }
      }
    }
  }
  return messages;
}

/** 控えのある会話を新しい順に返す。 */
export async function listRecords({ limit = 100 } = {}) {
  let names;
  try {
    names = await fs.readdir(dir());
  } catch {
    return [];
  }
  const rows = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const record = await read(name.slice(0, -".json".length));
    if (!record) continue;
    rows.push(toRow(record));
  }
  return rows
    .sort((a, b) => (b.lastModified ?? 0) - (a.lastModified ?? 0))
    .slice(0, limit);
}

/** 控えを捨てる（`agy` 側にもう無い会話）。 */
export async function forget(conversationId) {
  if (!conversationId) return;
  await fs.rm(fileFor(conversationId), { force: true }).catch(() => {});
}

const toMs = (v) => {
  if (!v) return null;
  const ms = new Date(v).getTime();
  return Number.isFinite(ms) ? ms : null;
};

/** 控え -> バックエンド共通のセッション行。 */
export function toRow(record) {
  return {
    sessionId: record.conversationId,
    // agy にタイトルの口は無い。最初の発言を見出しに使う（sidecar が正本）
    title: firstUserText(record.messages).slice(0, 80) || null,
    cwd: record.cwd ?? null,
    createdAt: record.createdAt ?? null,
    lastModified: toMs(record.lastModified ?? record.createdAt),
    tag: null,   // 状態タグも持てない。sidecar が正本
  };
}

function firstUserText(messages) {
  for (const m of messages) {
    if (m?.role === "user" && String(m.text ?? "").trim()) return String(m.text).trim();
  }
  return "";
}
