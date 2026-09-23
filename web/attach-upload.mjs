// この端末のファイルを添付として送る（1 件 100MB まで。core/server.mjs の attachStart / attachChunk / attachFinish）。
//
// 中身は 512 KiB の断片を base64 にして送る（手元のフォルダーを送る口 web/folder-upload.mjs と同じ仕組み・同じ断片）。
// 1 通で丸ごと送らないので、このブラウザー・端末内プロキシ・中継・サーバーのどこも 1 件を丸ごと抱えない。
// 同時に投げる断片は IN_FLIGHT 本まで（応答が背圧になる）。切れたら、つながり直すのを待って受け取り済みの位置から続ける。
import { readChunk } from './folder-upload.mjs';
import { t } from './i18n.mjs';

/** 1 件の添付の上限（core/server.mjs の ATTACH_MAX_BYTES と同じ） */
export const ATTACH_MAX_BYTES = 100 * 1024 * 1024;
const IN_FLIGHT = 4;
const RETRIES = 5;

/**
 * @param {object} o
 * @param {(command: string, args?: object) => Promise<any>} o.cmd
 * @param {File|Blob} o.file
 * @param {string|null} o.sessionId
 * @param {(sent: number, size: number) => void} [o.onProgress]
 * @param {() => boolean} [o.cancelled] true になったら止めて置き場の途中のものを捨てる
 * @param {(error: Error) => Promise<void>} [o.online] 断片が失敗したとき。切れていればつながり直すまで待つ。
 *   つながっている（切れたのではない失敗）なら error で reject する。無ければすぐ失敗にする
 * @returns {Promise<{ path: string, bytes: number, kind: 'image'|'file' } | null>} やめたら null
 */
export async function sendAttachment({ cmd, file, sessionId, onProgress = () => {}, cancelled = () => false, online = null }) {
  const size = file.size;
  const start = await cmd('attachStart', { sessionId, name: file.name ?? 'file', mime: file.type ?? '', size });
  const id = start.uploadId;
  const chunk = start.chunkBytes || 512 * 1024;
  let received = start.received ?? 0;
  const drop = () => cmd('attachCancel', { uploadId: id }).catch(() => {});
  onProgress(received, size);
  try {
    for (let attempt = 0; received < size; attempt++) {
      if (cancelled()) { await drop(); return null; }
      if (attempt > RETRIES) throw new Error(t('upload.stalled'));
      const before = received;
      const offsets = [];
      for (let off = received; off < size; off += chunk) offsets.push(off);
      let k = 0, failure = null;
      await Promise.all(Array.from({ length: Math.min(IN_FLIGHT, offsets.length) }, async () => {
        while (k < offsets.length && !failure && !cancelled()) {
          const off = offsets[k++];
          let data;
          try { data = await readChunk(file.slice(off, Math.min(off + chunk, size))); }
          catch { failure = Object.assign(new Error(t('chat.attach.readFailed')), { local: true }); break; }
          try {
            const r = await cmd('attachChunk', { uploadId: id, offset: off, data });
            // 位置は先頭から続いた分だけ進む（抜けがあれば書かずに今の位置が返る。次の周で送り直す）
            if (r.received > received) { received = r.received; onProgress(received, size); }
          } catch (e) { failure = e; }
        }
      }));
      if (cancelled()) { await drop(); return null; }
      if (failure) {
        // 切れた: つながり直すのを待ち、サーバーの位置を聞き直して続ける。待てない・手元で読めないなら失敗
        if (!online || failure.local) throw failure;
        await online(failure);
        const r = await cmd('attachChunk', { uploadId: id, offset: 0, data: '' });
        received = r.received;
        onProgress(received, size);
      }
      // 進んだ周は数えない（断片の読み出しが前後して抜けができただけ）。進まない周が続いたら諦める
      if (received > before) attempt = -1;
    }
    return await cmd('attachFinish', { uploadId: id });
  } catch (e) {
    await drop();
    throw e;
  }
}
