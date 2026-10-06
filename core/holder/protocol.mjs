// ターンの保持役（無停止の更新 段階 2 の 2a。docs/zero-downtime-update/design.md §4、plan.md「2a 保持役」）の規約 v1 と、パイプ・秘密のファイルの名前。
// 保持役（core/holder/holder.mjs）とサーバー側の口（core/holder/client.mjs）が使う。Node の組み込みだけ（bin/pleiad.mjs と同じ縛り）。
//
// 名前付きパイプ \\.\pipe\pleiad-holder-<データ置き場と利用者のハッシュ>-v<規約の版>。1 行 1 JSON（core/link-codec.mjs）。**この形は版をまたいで変えない（v1）**。
//   親 -> 保持役                                              保持役 -> 親
//   hello   { secret, protocol: [min, max], role: 'server', pid, appVersion }   welcome { protocol, generation, range, appVersion, pid, children: [<子の状態>], stash }
//                                                                    reject  { reason: 'protocol', range, generation, appVersion, pid }（秘密が合ったうえで版が合わないときだけ。秘密が合わなければ何も返さず切る）
//   spawn   { id, command, args, cwd, env, framing: 'lines', policy, label }    out     { id, seq, line, redelivered? }（記録の 1 行。通番は子ごとに 1 から）
//   attach  { id, from? }  既存の子に付ける。from の既定は acked + 1       err     { id, chunk }（stderr のかたまり）
//   write   { id, data }  / end { id } / kill { id, tree? }                 exit    { id, code, signal, error? }（その子の out を全部流した後に 1 回）
//   ack     { id, seq }  アプリのループで処理し終えた最後の行               overflow{ id, reason: 'record' | 'line', first?, bytes? }（記録から落ちた分・長すぎて捨てた行）
//   mark    { id, name, seq? } / unmark { id, name }  印（seq の既定は次の行）  attached{ id, ...<子の状態>, from }（attach の答え。この後に控えの渡し直し・記録の続き・exit が続く）
//   label   { id, label }  札を置き直す（不透明な JSON）                    detached{ id?, children: [<子の状態>] }（detach の答え。この時点で転送は止まっている）
//   replay  { id, from, to, reqId }  記録の一部を読み直す                   replay  { id, reqId, lines: [[seq, line]], done, first?, last?, truncated? }
//   stash   { stash }  預かり物を置く（全体の値）                          error   { id?, op, reason }（相手の子が居ない・形が違う など）
//   detach  { id? }  手を離す（id 無しは全部）                              bye     { reason: 'replaced' | 'closing' }
//   release { id }  終わった子の記録を捨てる / shutdown {}  子を木ごと止めて終わる
//   bye     { reason }
// 子の状態 { id, pid, alive, exitCode, signal, error, label, policy, seq, first, acked, marks: { name: seq }, truncated, pendingRequests: [{ requestId, seq, subtype }], stderr }。
// つながっている親は常に 1 つ（後から合格した親が勝ち、古い方へ bye 'replaced'）。知らない t は読み捨てる。
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

/** この版の保持役が話す規約の版（世代）。規約を変えた版だけ上げる（design.md §4.3） */
export const HOLDER_PROTOCOL = 1;
export const HOLDER_RANGE = [HOLDER_PROTOCOL, HOLDER_PROTOCOL];
export const HOLDER_FILE_VERSION = 1;

export const POLICIES = ['claude-control', 'jsonrpc', 'none'];
/** 子の 1 行の上限（超えた行は捨てて overflow）。パイプの 1 行の上限はその 4 倍（JSON の包み・エスケープの分） */
export const DEFAULT_MAX_LINE_BYTES = 16 * 1024 * 1024;
export const DEFAULT_MAX_FRAME_BYTES = 64 * 1024 * 1024;
export const HELLO_MAX_BYTES = 64 * 1024;
export const DEFAULT_HELLO_TIMEOUT_MS = 5000;
/** 子ごとの記録の上限（超えたら古い行から捨てて truncated） */
export const DEFAULT_MAX_RECORD_BYTES = 32 * 1024 * 1024;
/** 親へ流す途中の、書いたまま溜まっている量の上限。超えたら drain まで記録から送らない（親が読まなくても保持役のメモリは増えない） */
export const DEFAULT_HIGH_WATER_BYTES = 4 * 1024 * 1024;
/** 子が 1 つも生きておらず、親が 10 分つながっていなければ終わる（design.md §4.2） */
export const DEFAULT_IDLE_MS = 10 * 60 * 1000;
export const STDERR_TAIL_BYTES = 16 * 1024;
export const STASH_MAX_BYTES = 1024 * 1024;
export const LABEL_MAX_BYTES = 256 * 1024;

function safeUser() {
  try { return os.userInfo().username; } catch { return ''; }
}

/** データ置き場と利用者ごとのキー（パイプの名前・秘密のファイルの名前に入る） */
export function holderKey(dataDir, { platform = process.platform, user = safeUser() } = {}) {
  const resolved = path.resolve(dataDir);
  const key = platform === 'win32' ? resolved.toLowerCase() : resolved;
  return crypto.createHash('sha256').update(`${key}\n${user}`).digest('hex').slice(0, 16);
}

/** Windows は \\.\pipe\pleiad-holder-<キー>-v<版>、それ以外は一時フォルダーの unix ソケット（テスト・開発用） */
export function holderPipeName(dataDir, { protocol = HOLDER_PROTOCOL, platform = process.platform, user, tmpdir = os.tmpdir() } = {}) {
  const key = holderKey(dataDir, { platform, user });
  return platform === 'win32' ? `\\\\.\\pipe\\pleiad-holder-${key}-v${protocol}` : path.join(tmpdir, `pleiad-holder-${key}-v${protocol}.sock`);
}

/**
 * 保持役が書く、名前と秘密のファイル（実行場所の run\。データ置き場には書かない。権限 0600）。run\ の他のファイル（<版>-<pid>.lock.db）と名前が重ならない
 */
export function holderFilePath(root, dataDir, { protocol = HOLDER_PROTOCOL, platform, user } = {}) {
  return path.join(root, 'run', `holder-${holderKey(dataDir, { platform, user })}-v${protocol}.json`);
}

/** 保持役の起動口（core/holder/main.mjs）の環境変数 */
export const ENV = {
  data: 'PLEIAD_HOLDER_DATA',
  root: 'PLEIAD_HOLDER_ROOT',
  key: 'PLEIAD_HOLDER_KEY',
  appVersion: 'PLEIAD_HOLDER_APP_VERSION',
  idleMs: 'PLEIAD_HOLDER_IDLE_MS',
};
