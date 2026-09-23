// 添付の件数に上限が無いこと（2026-09-23 に 20 件の上限を外した。docs/design-system.md「入力欄」）。
//   - 下書き（saveDraft）は 20 件を超えても保存し、札の出どころ（from: host / device）だけを残す
//   - 送信（sendMessage）は 20 件を超えても受け取り、全部を会話に載せる（以前は 21 件目から黙って落としていた）
//   - 形の違う添付（配列でない）は理由の一文で断る。1 件 8MB の上限は残る
// fake バックエンドだけ。LLM は呼ばない。
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startServer, ROOT } from '../lib/server.mjs';
import { open } from '../lib/ws-client.mjs';

export const name = 'attach-no-limit';
export const title = '添付: 件数の上限なし（下書き・送信）・出どころの印・1 件の大きさの上限は残る';

const N = 25;

export default async function (t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-attach-nolimit-'));
  const server = await startServer({ dataDir, env: { AGENT_HOST_BACKENDS: 'fake' } });
  const c = await open({ port: server.port, token: server.token, autoAllow: true });
  try {
    const { sessionId } = await c.cmd('newSession', { backend: 'fake', cwd: ROOT });
    const many = Array.from({ length: N }, (_, i) => ({ name: `f${i}.txt`, path: path.join(ROOT, `f${i}.txt`), kind: 'file', mime: 'text/plain', from: i % 2 ? 'host' : 'device' }));
    many.push({ name: 'odd.txt', path: path.join(ROOT, 'odd.txt'), kind: 'file', from: 'elsewhere' });
    await c.cmd('saveDraft', { sessionId, text: '多い', attached: many });
    const draft = (await c.cmd('loadSession', { sessionId })).draft;
    t.ok(`下書き: ${N + 1} 件の添付をそのまま保存する`, draft?.attached?.length === N + 1, String(draft?.attached?.length));
    t.ok('下書き: 出どころの印は host / device だけ残す', draft.attached[0].from === 'device' && draft.attached[1].from === 'host' && !('from' in draft.attached[N]), JSON.stringify(draft.attached.slice(0, 2).concat(draft.attached[N])));

    const ups = [];
    for (let i = 0; i < N; i++) ups.push(await c.cmd('attachFile', { sessionId, name: `u${i}.txt`, mime: 'text/plain', data: Buffer.from(`x${i}`).toString('base64') }));
    const big = await c.cmd('attachFile', { sessionId, name: 'big.bin', mime: 'application/octet-stream', data: Buffer.alloc(8 * 1024 * 1024 + 1).toString('base64') }).then(() => null, (e) => e.message);
    t.ok('1 件 8MB の上限は残る', /8/.test(big ?? ''), big);

    const bad = await c.cmd('sendMessage', { sessionId, messageId: 'nolimit-bad-01', prompt: 'echo:x', attachments: 'nope' }).then(() => null, (e) => e.message);
    t.ok('送信: 配列でない添付は理由の一文で断る', /添付の形式/.test(bad ?? ''), bad);

    const mark = c.mark();
    await c.cmd('sendMessage', { sessionId, messageId: 'nolimit-0001', prompt: 'echo:たくさん', attachments: ups.map((u, i) => ({ path: u.path, name: `u${i}.txt`, mime: 'text/plain' })) });
    const end = await c.waitFor((e) => e.type === 'turnEnd' && e.sessionId === sessionId, { from: mark, ms: 20_000 });
    const presents = c.events.slice(mark).filter((e) => e.type === 'present' && e.by === 'human' && e.sessionId === sessionId);
    t.ok(`送信: ${N} 件の添付を全部会話に載せる（21 件目から落とさない）`, Boolean(end) && presents.length === N, String(presents.length));
  } finally {
    c.close();
    await server.stop();
    await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
  }
}
