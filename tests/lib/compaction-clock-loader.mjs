// Redirect only the server's scheduler import; backend RPC timeouts keep real time.
export async function resolve(specifier, context, nextResolve) {
  if (context.parentURL?.endsWith('/core/server.mjs') && specifier === './compaction-scheduler.mjs') {
    return { url: new URL('./compaction-test-clock.mjs', import.meta.url).href, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
