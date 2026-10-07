// main（desktop/main.cjs の utilityProcess・desktop/server-boot.cjs の serverEnv）がサーバーを起こすときにだけ渡す環境変数。
//
// サーバーは起動の時に読んだら process.env から外す（core/server.mjs の最初）。エージェントの CLI・`!` の行・外部の MCP・git などの子は
// process.env を写す・継ぐので、残すと会話のシェルまで届く。届くと、そのシェルで起こしたサーバー（Pleiad で Pleiad を開発するとき）が
// AGENT_HOST_HANDOVER=on で main のパイプを待って止まる、AGENT_HOST_RUNTIME_KEY でインストール版の実行場所に使用中の印を付ける、
// AGENT_HOST_SERVER_LOG でインストール版の server.log に書く。
// 子へ渡すために main が付けるもの（PLEIAD_CLI_*・agent-browser を足した PATH・utilityProcess の ELECTRON_RUN_AS_NODE）は外さない。
// テストのサーバーの起動（tests/lib/server.mjs）も、この一覧を実行元から継がない。

/**
 * - AGENT_HOST_HANDOVER: 名前付きパイプで main とつなぐか（core/main-link.mjs）。main 自身の切り替えでもある
 * - AGENT_HOST_PORT・AGENT_HOST_BIND・AGENT_HOST_TOKEN: 待ち受けの場所とトークン（切り替えの後の起こし直しは前のトークンを渡す。desktop/switch.cjs）
 * - AGENT_HOST_SYSTEM_LOCALE: main が渡す OS の言語（core/i18n.mjs）
 * - AGENT_HOST_SERVER_LOG: 出力を書くファイル（core/server-log-boot.mjs）
 * - AGENT_HOST_RUNTIME_ROOT・AGENT_HOST_RUNTIME_KEY: 走っている版の実行場所と版の名前（core/runtime-use.mjs）
 * - AGENT_HOST_RUNTIME_RESOURCES・AGENT_HOST_RUNTIME_DIR: main が実行場所を組む元と置き場（desktop/runtime.cjs）。サーバーは読まず、継いでいるだけ
 * - AGENT_HOST_CLAUDE_HOLDER: Claude の CLI を保持役に載せるか（無停止の更新 段階 2 の 2c。core/backends/claude-held.mjs）。会話のシェルで起こしたサーバーに継がせない
 * - AGENT_HOST_SHELL_HOLDER: `!` の行を保持役に載せるか（無停止の更新 段階 3。core/shell-held.mjs）。同じく継がせない
 */
export const BOOT_ENV_NAMES = Object.freeze([
  'AGENT_HOST_HANDOVER',
  'AGENT_HOST_PORT', 'AGENT_HOST_BIND', 'AGENT_HOST_TOKEN',
  'AGENT_HOST_SYSTEM_LOCALE', 'AGENT_HOST_SERVER_LOG',
  'AGENT_HOST_RUNTIME_ROOT', 'AGENT_HOST_RUNTIME_KEY',
  'AGENT_HOST_RUNTIME_RESOURCES', 'AGENT_HOST_RUNTIME_DIR',
  'AGENT_HOST_CLAUDE_HOLDER', 'AGENT_HOST_SHELL_HOLDER',
]);
const NAMES = new Set(BOOT_ENV_NAMES);
// サーバーが起動の時に process.env から外した値。外した後に読むモジュール（段階 2 の保持役の置き場など）はここから読む
let taken = Object.freeze({});

/** 起動用の変数の名前か（Windows は変数名の大小を区別しないので、大文字にそろえて見る） */
export const isBootEnvName = name => NAMES.has(String(name).toUpperCase());

/** env から起動用の変数を外し、その値を一覧の名前で返す（凍らせる）。env を直接書き換える */
export function takeBootEnv(env = process.env) {
  const values = {};
  for (const key of Object.keys(env)) {
    if (!isBootEnvName(key)) continue;
    values[key.toUpperCase()] = env[key];
    delete env[key];
  }
  const frozen = Object.freeze(values);
  if (env === process.env) taken = frozen;
  return frozen;
}

/** process.env から外した起動用の変数（takeBootEnv の前は空）。外していなければ process.env の値 */
export const bootEnv = name => taken[name] ?? process.env[name];

/** env の写しから起動用の変数を除いたもの（env は書き換えない） */
export function withoutBootEnv(env = process.env) {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !isBootEnvName(key)));
}
