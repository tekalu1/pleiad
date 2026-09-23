// tests/unit/mcp-oauth-processes.mjs が 2 本起動する子プロセス。同じデータ置き場を別のプロセスとして開き、
// 親の合図（'go'）で一斉に「期限切れのトークンの取得（＝リフレッシュ）」と「秘密の読んで・変えて・書く」をする。
// 引数: <データ置き場> <時計のずらし（ミリ秒）> <子の番号>
import path from 'node:path';
import { createSecretStore } from '../../core/secret-store.mjs';
import { createPlyMcp } from '../../core/ply-mcp.mjs';
import { createMcpOAuth } from '../../core/mcp-oauth.mjs';

const [dataDir, offset, id] = process.argv.slice(2);
const secrets = createSecretStore({ file: path.join(dataDir, 'mcp-secrets.json') });
const ply = createPlyMcp({ dataDir, secrets });
const oauth = createMcpOAuth({ secrets, lockDir: path.join(dataDir, 'mcp-locks'), now: () => Date.now() + Number(offset) });
const definition = await ply.registration('remote');

process.on('message', async message => {
  if (message !== 'go') return;
  const errors = [];
  const tokens = await Promise.all(Array.from({ length: 5 }, () => oauth.accessToken('remote', definition).catch(e => { errors.push(e.message); return null; })));
  await Promise.all([
    ...Array.from({ length: 10 }, () => secrets.update('counter', v => ({ n: (v?.n ?? 0) + 1 })).catch(e => errors.push(e.message))),
    ...Array.from({ length: 10 }, (_, i) => secrets.set(`child:${id}:${i}`, { i }).catch(e => errors.push(e.message))),
  ]);
  process.send({ tokens, errors }, () => process.exit(0));
});
process.send('ready');
