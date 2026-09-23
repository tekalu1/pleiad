// procway-code の `auth-profiles.json` を、procway と**同じ形式・同じロック**で読み書きする。
//
// 書き先は `~/.procway/ai-agent/auth-profiles.json`（AGENT_HOST_PROCWAY_HOME で差し替え可）。
// agent-host 独自のファイルを作らないのは、ここに書いたトークンを
// **procway-code の openai-codex provider がそのまま読む**ため
// （procway 側は src/auth/{token-store,refresh-guard}.mjs から同じファイルを開く）。
// 別の場所に書くと「agent-host ではログイン済みなのにターンが 401」になる。
//
// procway 側の実装は ai-agent/src/auth/token-store.mjs。以下は必要な部分だけの移植:
//   - `<file>.lock` を `open(…, "wx")` で取るクロスプロセスロック（25ms リトライ / 最大 5 秒）
//   - tmp ファイル + rename のアトミック書き込み、mode 0o600
//   - `updateAuthProfile` は**マージしない**（丸ごと置換。呼び出し側が温存する）
//   - 壊れた JSON は例外。黙って空にしない
import { existsSync } from "node:fs";
import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const AUTH_PROFILES_FILENAME = "auth-profiles.json";
const LOCK_RETRY_DELAY_MS = 25;
const LOCK_MAX_WAIT_MS = 5_000;

/**
 * procway が home とみなす場所。
 * テストで本物の ~/.procway を汚さないために差し替えられる
 * （serve プロセスにも HOME / USERPROFILE として同じ値を渡す。core/backends/procway.mjs）。
 */
export function procwayHome() {
  return process.env.AGENT_HOST_PROCWAY_HOME || os.homedir();
}

export function procwayRoot(homeDir = procwayHome()) {
  return path.join(homeDir, ".procway", "ai-agent");
}

/**
 * 書き先。procway は「workspace に auth-profiles.json が既にあればそちら」を選ぶが、
 * agent-host はセッションごとに cwd が変わるので、**常に user スコープ**に書く
 * （認証はリポジトリ単位ではなくユーザー単位、という procway 自身の方針と同じ結論）。
 */
export function authProfilesPath(homeDir = procwayHome()) {
  return path.join(procwayRoot(homeDir), AUTH_PROFILES_FILENAME);
}

function emptyStore() {
  return { profiles: {} };
}

function sanitize(parsed) {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return emptyStore();
  const profiles = parsed.profiles;
  if (!profiles || typeof profiles !== "object" || Array.isArray(profiles)) return emptyStore();
  const out = emptyStore();
  for (const [id, profile] of Object.entries(profiles)) {
    if (!profile || typeof profile !== "object") continue;
    const provider = typeof profile.provider === "string" ? profile.provider : null;
    const mode = typeof profile.mode === "string" ? profile.mode : null;
    // provider / mode を欠いた行は procway 側も読み込み時に落とす
    if (!provider || !mode) continue;
    out.profiles[id] = {
      provider,
      mode,
      credentials: profile.credentials && typeof profile.credentials === "object" ? profile.credentials : null,
      updatedAt: typeof profile.updatedAt === "string" ? profile.updatedAt : null,
    };
  }
  return out;
}

async function readStoreFile(filePath) {
  if (!existsSync(filePath)) return emptyStore();
  let raw;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return emptyStore();
    throw error;
  }
  if (!raw.trim()) return emptyStore();
  try {
    return sanitize(JSON.parse(raw));
  } catch (error) {
    throw new Error(`auth-profiles.json が JSON として読めない (${filePath}): ${error.message}`, { cause: error });
  }
}

const delay = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

async function acquireLock(filePath) {
  const lockPath = `${filePath}.lock`;
  const deadline = Date.now() + LOCK_MAX_WAIT_MS;
  for (;;) {
    try {
      const handle = await open(lockPath, "wx");
      // 事後調査用に pid だけ置く。読み返さないので形式は問わない
      try { await handle.writeFile(`${process.pid}\n`); } catch { /* best-effort */ }
      await handle.close();
      return {
        async release() {
          try { await rm(lockPath, { force: true }); } catch { /* ignore */ }
        },
      };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      if (Date.now() >= deadline) {
        throw new Error(
          `auth-profiles.json のロック待ちが ${LOCK_MAX_WAIT_MS}ms で timeout した (${lockPath})。` +
          "他のプロセスが持っていないと分かっているなら手で消すこと。",
          { cause: error },
        );
      }
      await delay(LOCK_RETRY_DELAY_MS);
    }
  }
}

async function atomicWriteJson(filePath, data) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmpPath, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600, encoding: "utf8" });
  await rename(tmpPath, filePath);
}

/** ストア全体。ファイルが無くても空の形を返す。 */
export async function readStore({ homeDir, pathOverride } = {}) {
  const filePath = pathOverride ?? authProfilesPath(homeDir ?? procwayHome());
  return { filePath, store: await readStoreFile(filePath) };
}

/** profile を 1 つ読む。無ければ null。 */
export async function readProfile(profileId, options = {}) {
  const { store } = await readStore(options);
  return store.profiles[profileId] ?? null;
}

/**
 * ロックの中で read-modify-write。mutator は現在の profile（無ければ null）を受け取り、
 * 新しい profile を返す。**マージしない**ので、温存したいものは呼び出し側が入れ直す。
 * null を返せば削除。
 */
export async function updateProfile(profileId, mutator, options = {}) {
  const filePath = options.pathOverride ?? authProfilesPath(options.homeDir ?? procwayHome());
  await mkdir(path.dirname(filePath), { recursive: true });
  const lock = await acquireLock(filePath);
  try {
    const store = await readStoreFile(filePath);
    const next = await mutator(store.profiles[profileId] ?? null);
    if (next === null) {
      delete store.profiles[profileId];
    } else {
      store.profiles[profileId] = { ...next, updatedAt: new Date().toISOString() };
    }
    await atomicWriteJson(filePath, store);
    return { filePath, profile: store.profiles[profileId] ?? null };
  } finally {
    await lock.release();
  }
}

/**
 * OAuth のクレデンシャルを 1 件書く。procway の writeOAuthProfile と同じ形:
 *   { provider, mode: "oauth", credentials: { access, refresh, expires, accountId }, updatedAt }
 * `expires` は **epoch ミリ秒**（expires_in 秒ではない）。
 * `provider` の値が procway の refresh ハンドラ選択キーなので "openai-codex" を崩さないこと。
 */
export function writeOAuthProfile(profileId, provider, credentials, options = {}) {
  return updateProfile(profileId, () => ({ provider, mode: "oauth", credentials }), options);
}

/** profile を消す。無ければ何もしない。 */
export function deleteProfile(profileId, options = {}) {
  return updateProfile(profileId, () => null, options);
}
