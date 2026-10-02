// セッション検索を保存先（conversations/<id>.json・バックエンドの getMessages・store）につなぐ部分。別プロセスで確かめる。
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const name = "session-search-host";
export const title = "セッション検索の読み込み元: 保存分は直接・それ以外は getMessages・完了通知とコマンドの行は写さない";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export default async function (t) {
  const worker = await promisify(execFile)(process.execPath, [path.join(ROOT, "tests/lib/session-search-host-worker.mjs")], { timeout: 30_000 });
  t.ok("読み込み元のワーカーが正常終了", worker.stdout.includes("session search host wiring verified"), worker.stderr);
}
