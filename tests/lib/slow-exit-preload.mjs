// サーバーのプロセスの終わりを遅らせる（NODE_OPTIONS=--import=<このファイル>）。'exit' の最後で PLEIAD_SLOW_EXIT_MS だけ止まり、その間パイプなどの
// 持ち物はプロセスと一緒に残る（負荷でプロセスの後片付けが遅れた形）。ほかの 'exit' の始末（core/data-lock.mjs のロックの手放し）は先に済ませる。
// サーバーの入口（core/server.mjs・tests/lib/adopt-server.mjs）だけに効き、サーバーが起こす子（偽の CLI など）では何もしない。tests/unit/handover-server.mjs が使う
const entry = String(process.argv[1] ?? '').replaceAll('\\', '/');
const ms = Number(process.env.PLEIAD_SLOW_EXIT_MS);
if (ms > 0 && (entry.endsWith('core/server.mjs') || entry.endsWith('tests/lib/adopt-server.mjs'))) {
  const stall = () => {
    const end = Date.now() + ms;
    while (Date.now() < end) { /* 止まる */ }
  };
  process.on('exit', stall);
  // 後から足された 'exit' の始末より後に回る
  process.on('newListener', (event, listener) => {
    if (event !== 'exit' || listener === stall) return;
    queueMicrotask(() => { process.removeListener('exit', stall); process.on('exit', stall); });
  });
}
