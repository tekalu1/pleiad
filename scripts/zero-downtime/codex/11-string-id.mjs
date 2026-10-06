// 世代つきの文字列の id（"g2-17"）を codex app-server が受けて、そのまま応答に返すか。
// 返せば、保持役が JSON-RPC の id を付け替えなくても、親の世代ごとに id の名前空間を分けられる。
import { makeEnv, Rpc, handshake, spawnAppServer, killTree, log, sleep } from './lib.mjs';
const E = await makeEnv();
const child = spawnAppServer(E.env);
const rpc = new Rpc('c', (s) => child.stdin.write(s));
child.stdout.setEncoding('utf8'); child.stdout.on('data', (d) => rpc.feed(d));
try {
  await handshake(rpc);
  for (const id of ['g2-17', 7, '7']) {
    const got = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve('TIMEOUT'), 5000);
      rpc.pending.set(id, { resolve: (v) => { clearTimeout(timer); resolve(JSON.stringify(v).slice(0, 120)); } });
      rpc.send({ jsonrpc: '2.0', id, method: 'thread/loaded/list', params: {} });
    });
    log(`request id ${JSON.stringify(id)} ->`, got);
  }
} finally { killTree(child); await sleep(600); await E.close(); }
