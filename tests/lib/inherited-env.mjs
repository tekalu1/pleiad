// 実行元（インストール版 Pleiad の会話のシェルなど）から継いだ Pleiad の環境変数を、テストへ持ち込まない。
//
// 一覧を手で並べると、Pleiad が新しい変数を渡すようになるたびに漏れる（AGENT_HOST_SERVER_LOG が漏れて、テストのサーバーの出力が
// インストール版の server.log へ流れ、起動の合図が見えず「サーバが 90000ms で起動しなかった」になった。2026-10-07）。
// だから接頭辞で外し、テストの実行に要る変数だけを KEPT に並べて残す。テストが子プロセスへ明示して渡す値には影響しない
// （継いだ値を外すだけ。テストが自分で足すものは、この後で env に入る）。
//
// - tests/lib/test-env.mjs が、テストのプロセスの最初に process.env から外す（run.mjs・worker）。子プロセスは process.env を引き継ぐので全部きれいになる
// - tests/lib/server.mjs の startServer も、サーバーの env を組むときに同じ関数を通す（test-env を読まない tests/e2e.mjs も同じ口になる）

/** Pleiad・agent-browser・Pleiad の制御の口の変数は、この接頭辞で外す */
export const SCRUBBED_PREFIXES = ['AGENT_HOST_', 'PLEIAD_', 'PLY_', 'AGENT_BROWSER_'];

/**
 * 接頭辞に当たっても残す変数（テストの実行に要り、利用者が意図して付けるもの）。インストール版 Pleiad は、どれも会話のシェルへ渡さない。
 * - AGENT_HOST_DATA: テストのデータ置き場。無ければ test-env が一時ディレクトリにする（本物の置き場は core/test-guard.mjs が守る。run.mjs の worker は親の値を外してから起こす）
 * - AGENT_HOST_LOCALE: テストの言語（run.mjs が ja にそろえる。英語で確かめる利用者の上書き）
 * - AGENT_HOST_CLAUDE_BIN・AGENT_HOST_CODEX_BIN・AGENT_HOST_AGY_BIN・AGENT_HOST_GIT_BIN: 利用者が試験用に渡す実行ファイルの上書き（docs/dev-verification.md）
 * - AGENT_HOST_TASK_SILENCE_MINUTES・AGENT_HOST_TASK_COMMAND_MINUTES: 委譲のタスクの待ち時間の調整（core/agent-tasks.mjs）
 * - AGENT_HOST_CHROME_USER_DATA: 利用者の本物の Chrome を読まないための差し替え先（test-env が無ければ存在しない一時ディレクトリを入れる）
 * - PLEIAD_TEST_*: テストの走らせ手が自分の worker へ渡す印（PLEIAD_TEST_GUARD_HOME・PLEIAD_TEST_WORKER_TAG）
 */
export const KEPT_ENV = new Set([
  'AGENT_HOST_DATA', 'AGENT_HOST_LOCALE',
  'AGENT_HOST_CLAUDE_BIN', 'AGENT_HOST_CODEX_BIN', 'AGENT_HOST_AGY_BIN', 'AGENT_HOST_GIT_BIN',
  'AGENT_HOST_TASK_SILENCE_MINUTES', 'AGENT_HOST_TASK_COMMAND_MINUTES',
  'AGENT_HOST_CHROME_USER_DATA',
]);
const KEPT_PREFIXES = ['PLEIAD_TEST_'];

/** この名前は、実行元から継いだものとして外すか（Windows は変数名の大小を区別しないので、大文字にそろえて見る） */
export function isInheritedEnvName(name) {
  const upper = String(name).toUpperCase();
  if (KEPT_ENV.has(upper) || KEPT_PREFIXES.some((p) => upper.startsWith(p))) return false;
  return SCRUBBED_PREFIXES.some((p) => upper.startsWith(p));
}

/** env（既定は process.env）から外し、外した名前を返す（値は返さない）。env を直接書き換える */
export function scrubInheritedEnv(env = process.env) {
  const removed = Object.keys(env).filter(isInheritedEnvName);
  for (const k of removed) delete env[k];
  return removed;
}
