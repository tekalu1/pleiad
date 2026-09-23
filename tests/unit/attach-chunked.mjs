// 添付を断片で送る（1 件 100MB まで。core/server.mjs の attachStart / attachChunk / attachFinish、web/attach-upload.mjs）。
//   - サーバー: ちょうど 100MB を 512 KiB の断片で受けて置き場に置く・100MB + 1 バイトは断る・抜けのある断片は書かずに今の位置・
//     空の断片で今の位置を聞ける・やめたら途中のものを捨てる・知らない uploadId は断る
//   - 会話に載せるとき: 大きな画像は data URI にせずパスだけ（省略の印）、文字のファイルは先頭だけ読む
//   - 画面の送り手（sendAttachment）: 断片の並行・途中で切れたらつながり直すのを待って続きから・やめたら attachCancel
// fake バックエンドだけ。LLM は呼ばない。
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startServer, ROOT } from '../lib/server.mjs';
import { open } from '../lib/ws-client.mjs';
import { sendAttachment, ATTACH_MAX_BYTES } from '../../web/attach-upload.mjs';

export const name = 'attach-chunked';
export const title = '添付の断片送り: 100MB ちょうどは通り、1 バイト超えは断る・大きな画像は会話にパスだけ・切れても続きから';

const MB = 1024 * 1024;
const CHUNK = 512 * 1024;

/** Node には FileReader が無い。web/folder-upload.mjs の readChunk が使う readAsDataURL だけを Blob から作る */
function installFileReader() {
  if (globalThis.FileReader) return () => {};
  globalThis.FileReader = class {
    readAsDataURL(blob) {
      blob.arrayBuffer().then((ab) => { this.result = `data:application/octet-stream;base64,${Buffer.from(ab).toString('base64')}`; this.onload?.(); },
        (e) => { this.error = e; this.onerror?.(); });
    }
  };
  return () => { delete globalThis.FileReader; };
}

export default async function (t) {
  const restore = installFileReader();
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-attach-chunked-'));
  const server = await startServer({ dataDir, env: { AGENT_HOST_BACKENDS: 'fake' } });
  const c = await open({ port: server.port, token: server.token, autoAllow: true });
  try {
    t.ok('上限は 100MB（画面とサーバーで同じ）', ATTACH_MAX_BYTES === 100 * MB);
    const { sessionId } = await c.cmd('newSession', { backend: 'fake', cwd: ROOT });

    // ---- ちょうど 100MB を、画面と同じ送り手で送る（Node の Blob を File の代わりに使う）
    const big = Buffer.alloc(100 * MB);
    for (let i = 0; i < big.length; i += 4096) big.writeUInt32LE(i, i);   // 位置の写しで中身の取り違えを見抜く
    const blob = new Blob([big]);
    Object.defineProperty(blob, 'name', { value: 'big.bin' });
    const seen = [];
    const started = Date.now();
    const r = await sendAttachment({ cmd: c.cmd, file: blob, sessionId, onProgress: (sent) => seen.push(sent) });
    const ms = Date.now() - started;
    const onDisk = await fs.readFile(r.path);
    t.ok(`100MB ちょうど: 断片で送り、置き場に同じ中身で置く（${(ms / 1000).toFixed(1)} 秒）`, r.bytes === 100 * MB && onDisk.length === 100 * MB && onDisk.equals(big) && r.kind === 'file');
    t.ok('置き場は添付の置き場（会話ごと）で、途中の置き場は残らない', r.path.startsWith(path.join(dataDir, 'uploads') + path.sep) && path.basename(path.dirname(r.path)) === sessionId
      && (await fs.readdir(path.join(dataDir, 'uploads', '.partial')).catch(() => [])).length === 0, r.path);
    t.ok('進み具合は増えるだけで最後は 100MB', seen.length > 10 && seen.every((v, i) => i === 0 || v >= seen[i - 1]) && seen.at(-1) === 100 * MB);

    // ---- 1 バイト超えは断る（始める前に。中身は送らない）
    const over = await c.cmd('attachStart', { sessionId, name: 'over.bin', mime: '', size: 100 * MB + 1 }).then(() => null, (e) => e.message);
    t.ok('100MB + 1 バイトは attachStart で断る（上限 100MB の文言）', /100MB/.test(over ?? ''), over);
    const bad = await c.cmd('attachStart', { sessionId, name: 'x', size: -1 }).then(() => null, (e) => e.message);
    t.ok('大きさが負・数でないものは断る', Boolean(bad));

    // ---- 抜け・今の位置・やめる
    const s = await c.cmd('attachStart', { sessionId, name: 'gap.bin', mime: 'application/octet-stream', size: CHUNK * 3 });
    const part = Buffer.alloc(CHUNK, 7).toString('base64');
    const ahead = await c.cmd('attachChunk', { uploadId: s.uploadId, offset: CHUNK, data: part });
    t.ok('抜けのある断片は書かずに今の位置（0）を返す', ahead.received === 0);
    await c.cmd('attachChunk', { uploadId: s.uploadId, offset: 0, data: part });
    const where = await c.cmd('attachChunk', { uploadId: s.uploadId, offset: 0, data: '' });
    t.ok('空の断片で今の位置を聞ける（つなぎ直した後）', where.received === CHUNK);
    const early = await c.cmd('attachFinish', { uploadId: s.uploadId }).then(() => null, (e) => e.message);
    t.ok('揃う前の attachFinish は断る', Boolean(early));
    await c.cmd('attachCancel', { uploadId: s.uploadId });
    const gone = await c.cmd('attachChunk', { uploadId: s.uploadId, offset: CHUNK, data: part }).then(() => null, (e) => e.message);
    t.ok('やめたら途中のものを捨て、同じ uploadId は使えない', Boolean(gone) && (await fs.readdir(path.join(dataDir, 'uploads', '.partial')).catch(() => [])).length === 0);
    const folderId = await c.cmd('attachChunk', { uploadId: 'f'.repeat(32), offset: 0, data: '' }).then(() => null, (e) => e.message);
    t.ok('知らない uploadId（フォルダーを送る口のものを含む）は断る', Boolean(folderId));

    // ---- 会話に載せるとき: 大きな画像はパスだけ、文字は先頭だけ
    const img = new Blob([Buffer.alloc(7 * MB, 1)], { type: 'image/png' });
    Object.defineProperty(img, 'name', { value: 'large.png' });
    const upImg = await sendAttachment({ cmd: c.cmd, file: img, sessionId });
    const text = new Blob([Buffer.alloc(300 * 1024, 0x61)], { type: 'text/plain' });
    Object.defineProperty(text, 'name', { value: 'long.txt' });
    const upText = await sendAttachment({ cmd: c.cmd, file: text, sessionId });
    t.ok('画像の添付は kind: image', upImg.kind === 'image' && upText.kind === 'file');
    const mark = c.mark();
    await c.cmd('sendMessage', { sessionId, messageId: 'chunked-0001', prompt: 'echo:大きな添付',
      attachments: [{ path: upImg.path, name: 'large.png', mime: 'image/png' }, { path: upText.path, name: 'long.txt', mime: 'text/plain' }] });
    await c.waitFor((e) => e.type === 'turnEnd' && e.sessionId === sessionId, { from: mark, ms: 30_000 });
    const presents = c.events.slice(mark).filter((e) => e.type === 'present' && e.by === 'human');
    const pImg = presents.find((e) => e.kind === 'image'), pText = presents.find((e) => e.kind === 'file');
    t.ok('6MB を超える画像は data URI にしない（省略の印とパスだけ）', pImg && !pImg.dataUri && pImg.truncated === true && pImg.path === upImg.path, JSON.stringify({ ...pImg, dataUri: pImg?.dataUri?.length }));
    t.ok('文字のファイルは先頭の 2 万字だけ', pText && pText.content.length === 20000);
    const loaded = await c.cmd('loadSession', { sessionId });
    t.ok('履歴にも省略の印で残る（読み直しても 7MB を送らない）', JSON.stringify(loaded).length < 2 * MB, String(JSON.stringify(loaded).length));

    // ---- 画面の送り手: 途中で切れたら、つながり直すのを待って続きから
    let calls = 0, cut = false, cancels = 0;
    const flaky = async (command, args) => {
      if (command === 'attachChunk' && args.data && ++calls === 3 && !cut) { cut = true; throw new Error('切れた'); }
      if (command === 'attachCancel') cancels++;
      return c.cmd(command, args);
    };
    let waited = 0;
    const small = new Blob([Buffer.alloc(CHUNK * 6 + 10, 3)]);
    Object.defineProperty(small, 'name', { value: 'resume.bin' });
    const resumed = await sendAttachment({ cmd: flaky, file: small, sessionId, online: async () => { waited++; } });
    t.ok('切れたらつながり直すのを待ち、サーバーの位置から続けて送り終える', resumed?.bytes === CHUNK * 6 + 10 && waited === 1 && cancels === 0
      && (await fs.stat(resumed.path)).size === CHUNK * 6 + 10);
    const noWait = await sendAttachment({ cmd: async (command, args) => { if (command === 'attachChunk') throw new Error('だめ'); if (command === 'attachCancel') cancels++; return c.cmd(command, args); },
      file: small, sessionId, online: async (e) => { throw e; } }).then(() => null, (e) => e.message);
    t.ok('つながっているのに失敗したら（切れたのではない）続けずに失敗にし、途中のものを捨てる', noWait === 'だめ' && cancels === 1);
    let stop = false;
    const stopped = await sendAttachment({ cmd: async (command, args) => { if (command === 'attachChunk') stop = true; if (command === 'attachCancel') cancels++; return c.cmd(command, args); },
      file: small, sessionId, cancelled: () => stop });
    t.ok('やめたら null を返し、attachCancel で途中のものを捨てる', stopped === null && cancels === 2);
  } finally {
    restore();
    c.close();
    await server.stop();
    await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
  }
}
