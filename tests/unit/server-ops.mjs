// WS の汎用コマンド invoke（core/ops/）をサーバー越しに通す。fake バックエンドで、LLM もネットワークも要らない。
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../lib/server.mjs';
import { open } from '../lib/ws-client.mjs';
import { PROTOCOL_VERSION } from '../../core/protocol.mjs';

export const name = 'server-ops';
export const title = 'WS の invoke: app.status・見つからない・引数の誤りを code で返す';

export default async function (t) {
  const scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'agent-host-ops-')));
  const server = await startServer({ env: { AGENT_HOST_BACKENDS: 'fake' }, dataDir: path.join(scratch, 'data'), timeoutMs: 30_000 });
  const c = await open({ port: server.port, token: server.token });
  try {
    const status = await c.cmd('invoke', { op: 'app.status', args: {} });
    t.ok('app.status は版・プロトコル・起動時刻・言語・走っている作業の数を返す',
      typeof status.version === 'string' && status.protocolVersion === PROTOCOL_VERSION && status.startedAt > 0
      && status.locale.lang === 'ja' && status.running === 0, JSON.stringify(status));
    t.ok('args を省いても {} として通る', (await c.cmd('invoke', { op: 'app.status' })).running === 0);

    const miss = await c.cmd('invoke', { op: 'nothing.here', args: {} }).catch((e) => e);
    t.ok('無い操作は NOT_FOUND（code 付きの失敗）', miss.code === 'NOT_FOUND' && miss.message.includes('nothing.here'), `${miss.code} ${miss.message}`);

    const bad = await c.cmd('invoke', { op: 'app.status', args: { surprise: 1 } }).catch((e) => e);
    t.ok('未知の引数は INVALID と issues（path・code・message）', bad.code === 'INVALID' && bad.issues?.[0]?.code === 'unrecognized_keys' && 'path' in bad.issues[0], JSON.stringify(bad.issues));

    const none = await c.cmd('invoke', {}).catch((e) => e);
    t.ok('op が無い invoke は NOT_FOUND（落ちない）', none.code === 'NOT_FOUND');
    const lone = await c.cmd('invoke').catch((e) => e);
    t.ok('args ごと無い invoke も NOT_FOUND（落ちない）', lone.code === 'NOT_FOUND');

    // 接続が生きている（上の失敗でサーバーが落ちていない）
    t.ok('失敗の後も接続は生きている', (await c.cmd('invoke', { op: 'app.status' })).version === status.version);
  } finally {
    c.close();
    await server.stop();
    await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}
