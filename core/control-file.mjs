// CLI がつなぎ先を見つけるための <データ置き場>/control.json（ADR 0083）。サーバーが起動時に権限 0600 で書き、
// 終了時に pid が自分のときだけ消す。同じ置き場で 2 台立てたときは、後から立てた方が勝つ。
// 中身: { version, pid, origin, cliToken, startedAt, appVersion, kind }。cliToken は画面のトークンとは別の乱数で、効くのは /api/ops だけ。
// このファイルは秘密を含むデータ置き場のファイルとして扱う（ADR 0050 の読ませない対象）。
import fs from 'node:fs';
import path from 'node:path';
import { writeAtomic } from './atomic-file.mjs';

export const CONTROL_FILE = 'control.json';
export const CONTROL_VERSION = 1;
export const controlFilePath = (dataDir) => path.join(dataDir, CONTROL_FILE);

/** kind: デスクトップ版（utilityProcess）は 'desktop'、`npm start` などは 'server' */
export async function writeControlFile({ dataDir, origin, cliToken, startedAt, appVersion, kind, pid = process.pid }) {
  await fs.promises.mkdir(dataDir, { recursive: true });
  await writeAtomic(controlFilePath(dataDir), `${JSON.stringify({ version: CONTROL_VERSION, pid, origin, cliToken, startedAt, appVersion, kind }, null, 2)}\n`, { mode: 0o600 });
}

/** 自分（pid が同じ）が書いたものだけ消す。後から立った別のサーバーのファイルは残す。同期（process.on('exit') から呼ぶ） */
export function removeControlFile({ dataDir, pid = process.pid }) {
  try {
    const file = controlFilePath(dataDir);
    if (JSON.parse(fs.readFileSync(file, 'utf8'))?.pid === pid) fs.rmSync(file, { force: true });
  } catch { /* 無い・読めないものは消さない */ }
}
