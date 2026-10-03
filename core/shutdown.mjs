// Electron can stop its utility process without delivering Node's exit event.
// Persist pending session changes before deciding whether active work keeps it alive.
export function finishShutdown(flushNow, isBusy, exit = code => process.exit(code)) {
  flushNow();
  if (!isBusy()) exit(0);
}
