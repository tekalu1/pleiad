import fs from 'node:fs';
import readline from 'node:readline';

fs.writeFileSync(process.env.FAKE_BROWSER_ENV_FILE, JSON.stringify({
  config: process.env.AGENT_BROWSER_CONFIG,
  session: process.env.AGENT_BROWSER_SESSION,
  socketDir: process.env.AGENT_BROWSER_SOCKET_DIR,
  namespace: process.env.AGENT_BROWSER_NAMESPACE,
  path: process.env.PATH,
}));
if (process.argv.includes('app-server')) {
  const lines = readline.createInterface({ input: process.stdin });
  for await (const line of lines) {
    const message = JSON.parse(line);
    if (message.id != null) process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {} }) + '\n');
  }
} else {
  process.stdin.resume();
}
