// サーバーの起動（NODE_OPTIONS=--loader=…）で、ルーティンの時計だけをファイルで進む時計に差し替える。ほかの時計（バックエンドの待ち時間など）は本物のまま。
export async function resolve(specifier, context, nextResolve) {
  if (context.parentURL?.endsWith('/core/bots-host.mjs') && specifier === './routines/clock.mjs') {
    return { url: new URL('./routines-test-clock.mjs', import.meta.url).href, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
