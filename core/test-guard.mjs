// テストの間、本物のデータ置き場（利用者の ~/.agent-host など）を開かせないための防御。
//
// tests/run.mjs（tests/lib/test-env.mjs）が PLEIAD_TEST_GUARD_HOME に本物の置き場のパスを入れる（複数なら path.delimiter 区切り）。
// 値がある間、そのパスの中を DB・ロック・形式の移行・設定の JSON で開こうとすると例外にする。子プロセス（サーバー・worker）は
// 環境変数を引き継ぐので、サーバーを立てるテストにも効く。
// 起動したときに形式の移行が走る作りなので、テストが間違って本物を開くと、利用者のデータが書き換わる（2026-10-03 に起きた）。
// 値が無いとき（普段の起動）は何もしない。
import fs from 'node:fs';
import path from 'node:path';

const normalize = target => {
  let resolved = path.resolve(target);
  try { resolved = fs.realpathSync.native(resolved); } catch { /* まだ無い置き場。パスのまま比べる */ }
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
};

/** 守っている置き場のパス（正規化済み）。値が無ければ空 */
export function guardedDirectories(env = process.env) {
  return String(env.PLEIAD_TEST_GUARD_HOME ?? '').split(path.delimiter).map(s => s.trim()).filter(Boolean).map(normalize);
}

/** target（置き場、またはその中のファイル）が守っている置き場の中なら投げる */
export function assertNotGuarded(target, what = 'open', env = process.env) {
  const guarded = guardedDirectories(env);
  if (!guarded.length || !target) return;
  const resolved = normalize(target);
  for (const home of guarded) {
    if (resolved === home || resolved.startsWith(home + path.sep)) {
      throw Object.assign(new Error(`test guard: refusing to ${what} the real data directory during tests: ${target}. Set AGENT_HOST_DATA to a temporary directory.`), { code: 'TEST_GUARD' });
    }
  }
}
