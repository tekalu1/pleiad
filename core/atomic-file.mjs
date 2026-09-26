// ファイルを丸ごと置き換える保存（一時ファイルに書いて rename）。
// Windows では、別のプロセス（ウイルス対策・索引・PowerShell の Get-Content など）が置き換え先を開いている間だけ、
// rename が EPERM / EBUSY / EACCES になる。短く待てば通るので、その 3 つに限ってやり直す（graceful-fs と同じ扱い）。
// 一時ファイルの名前は毎回変える。固定の名前だと、同じ置き場を使う別の書き手と一時ファイルを取り合う。
import fs from 'node:fs/promises';
import crypto from 'node:crypto';

export const TRANSIENT_RENAME = ['EPERM', 'EBUSY', 'EACCES'];
// 待つ時間（ms）。数十 ms から伸ばし、合計 1.1 秒ほどで諦める
export const RENAME_DELAYS = [20, 40, 80, 160, 320, 480];

/** rename を、一時的に開けないときだけ待ってやり直す。io はテストで失敗を差し込むためのもの */
export async function renameRetry(from, to, { io = fs, delays = RENAME_DELAYS } = {}) {
  for (let attempt = 0; ; attempt++) {
    try { return await io.rename(from, to); }
    catch (e) {
      if (attempt >= delays.length || !TRANSIENT_RENAME.includes(e?.code)) throw e;
      await new Promise(done => setTimeout(done, delays[attempt]));
    }
  }
}

/** 一意な一時ファイルに書いてから置き換える。失敗しても一時ファイルは残さない */
export async function writeAtomic(file, data, { io = fs, delays = RENAME_DELAYS } = {}) {
  const tmp = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    await io.writeFile(tmp, data, { encoding: 'utf8', flag: 'wx' });
    await renameRetry(tmp, file, { io, delays });
  } finally { await io.rm(tmp, { force: true }).catch(() => {}); }
}
