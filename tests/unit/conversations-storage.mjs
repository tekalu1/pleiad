import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const name = "conversations-storage";
export const title = "会話データの個別ファイル分割保存と旧データ自動マイグレーション";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../..");

export default async function(t) {
  const worker = await promisify(execFile)(process.execPath, [path.join(ROOT, "tests/lib/conversations-storage-worker.mjs")]);
  t.ok("ストレージ分割・移行ワーカーが正常終了", worker.stdout.includes("conversations storage split and migration verified"));
}
