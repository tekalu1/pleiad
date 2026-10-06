// main の起動後に、版ごとの実行場所を裏で組み、少し後に使われていない古い版を掃除する
// （docs/zero-downtime-update/plan.md 1-3。desktop/runtime.cjs の使い方）。
// 組むのは「サーバーを起こす前に新しい版が揃っていること」のため（1-4 がここで組んだ pleiad-node.exe でサーバーを起こす）。
// AGENT_HOST_HANDOVER=on のときだけ main.cjs が呼ぶ。失敗しても起動は止めず、記録だけ残す。
const path = require('node:path');
const defaultRuntime = require('./runtime.cjs');

/** main の起動から掃除までの間（起動の重い時間を避ける） */
const CLEANUP_DELAY_MS = 60_000;

/**
 * 実行場所を組み、掃除を予約する。戻り値は組んだ結果（install の戻り値。失敗・組めない環境なら null）
 *   resourcesPath  配布物の resources\（process.resourcesPath）
 *   execPath       main の実行ファイル（process.execPath。$INSTDIR を知るため）
 */
async function prepareRuntime({ resourcesPath, execPath, env = process.env, log = () => {}, runtime = defaultRuntime, setTimer = setTimeout, cleanupDelayMs = CLEANUP_DELAY_MS } = {}) {
  try {
    const { root, moved } = runtime.resolveRuntimeRoot({ installDir: path.dirname(execPath), env });
    if (moved) log(`the runtime location moved to ${root} (the default one starts with the install directory)`);
    const result = await runtime.install({ root, resourcesDir: resourcesPath });
    log(`runtime ${result.key} ${result.reused ? 'already in place' : `built (${result.stats.files} files, ${result.stats.stored} new, ${result.stats.linked} linked, ${result.stats.copied} copied, ${result.stats.ms} ms)`} at ${result.appDir}`);
    const timer = setTimer(() => {
      runtime.cleanup({ root, currentKey: result.key }).then(
        swept => { if (swept.removed.length || swept.node.length) log(`runtime cleanup removed ${[...swept.removed, ...swept.node].join(', ')}`); },
        error => log(`runtime cleanup failed: ${error.message}`),
      );
    }, cleanupDelayMs);
    timer?.unref?.();
    return { ...result, root };
  } catch (error) {
    log(`runtime preparation failed (${error.code ?? 'error'}): ${error.message}`);
    return null;
  }
}

module.exports = { prepareRuntime, CLEANUP_DELAY_MS };
