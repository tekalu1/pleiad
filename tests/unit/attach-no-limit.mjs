// 添付の件数に上限が無いこと（2026-09-23 に 20 件の上限を外した。docs/design-system.md「入力欄」）。
//   - 下書き（saveDraft）は 20 件を超えても保存し、札の出どころ（from: host / device）だけを残す
//   - 送信（sendMessage）は 20 件を超えても受け取り、全部を会話に載せる（以前は 21 件目から黙って落としていた）
//   - 形の違う添付（配列でない）は理由の一文で断る。中身を 1 通で送る古い口（attachFile）の 8MB は残る（今の画面は断片で 100MB まで。attach-chunked.mjs）
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

    // ADR 0060: 本文は文中の添付の印を含む Markdown（version: 2）で保存する。大きさは分かるときだけ残す
    await c.cmd('saveDraft', { sessionId, text: `x\n[添付] ${many[0].path}\ny`, attached: [{ ...many[0], size: 1234 }, { ...many[1], size: 'x' }], version: 2 });
    const v2 = (await c.cmd('loadSession', { sessionId })).draft;
    t.ok('下書き: 印を含む本文・version: 2・添付の大きさを保存する（数でない大きさは捨てる）', v2?.version === 2 && v2.text.includes('[添付]') && v2.attached[0].size === 1234 && !('size' in v2.attached[1]), JSON.stringify(v2));
    await c.cmd('saveDraft', { sessionId, text: '古い', attached: [] });
    t.ok('下書き: version を送らなければ持たない（印の無い古い形式のまま）', !('version' in (await c.cmd('loadSession', { sessionId })).draft));

    // ADR 0177: 入力欄の「編集中」の状態は下書きと一緒に保存する（会話を切り替えても・読み込み直しても続く）。形の崩れたものは捨てる
    const edit = { v: 1, id: 'msg-1', time: '10:02', quote: '元の文', base: { text: '元の文', paths: [many[0].path] }, stash: { text: '書きかけ', attached: [{ ...many[1] }] }, junk: 'x' };
    await c.cmd('saveDraft', { sessionId, text: '直した文', attached: [many[0]], version: 2, edit });
    const ed = (await c.cmd('loadSession', { sessionId })).draft?.edit;
    t.ok('下書き: 編集中の状態（元の発言の id・時刻・引用・編集前の本文と添付・脇に取った書きかけ）を保存する', ed?.id === 'msg-1' && ed.time === '10:02' && ed.base?.text === '元の文' && ed.base.paths[0] === many[0].path && ed.stash?.text === '書きかけ' && ed.stash.attached?.length === 1 && !('junk' in ed), JSON.stringify(ed));
    await c.cmd('saveDraft', { sessionId, text: '直した文', attached: [], edit: { id: '', stash: {} } });
    t.ok('下書き: 元の発言の id が無い編集中の状態は持たない', !('edit' in (await c.cmd('loadSession', { sessionId })).draft));
    await c.cmd('saveDraft', { sessionId, text: '古い', attached: [] });

    const ups = [];
    for (let i = 0; i < N; i++) ups.push(await c.cmd('attachFile', { sessionId, name: `u${i}.txt`, mime: 'text/plain', data: Buffer.from(`x${i}`).toString('base64') }));
    const big = await c.cmd('attachFile', { sessionId, name: 'big.bin', mime: 'application/octet-stream', data: Buffer.alloc(8 * 1024 * 1024 + 1).toString('base64') }).then(() => null, (e) => e.message);
    t.ok('中身を 1 通で送る古い口（attachFile）は 8MB を超えると断る', /上限 8MB/.test(big ?? ''), big);

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
