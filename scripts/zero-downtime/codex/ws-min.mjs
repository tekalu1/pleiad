// 最小の WebSocket クライアント（テキストフレームだけ）。unix ソケットや `app-server proxy` の stdio の上で話すため。
import crypto from 'node:crypto';

/** write(buf) と、受信を渡す onData を持つ双方向の流れの上に WebSocket を張る。 */
export function wsClient({ write, host = 'localhost', onMessage, onClose }) {
  let buf = Buffer.alloc(0), upgraded = false, closed = false;
  const key = crypto.randomBytes(16).toString('base64');
  write(Buffer.from(`GET / HTTP/1.1\r\nHost: ${host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`));
  let ready; const opened = new Promise((r) => { ready = r; });
  const sendFrame = (opcode, payload) => {
    const mask = crypto.randomBytes(4); const len = payload.length;
    const head = len < 126 ? Buffer.from([0x80 | opcode, 0x80 | len]) : len < 65536 ? Buffer.from([0x80 | opcode, 0x80 | 126, len >> 8, len & 255]) : null;
    const masked = Buffer.from(payload.map((b, i) => b ^ mask[i % 4]));
    write(Buffer.concat([head, mask, masked]));
  };
  return {
    opened,
    feed(chunk) {
      buf = Buffer.concat([buf, chunk]);
      if (!upgraded) {
        const i = buf.indexOf('\r\n\r\n'); if (i < 0) return;
        const head = buf.slice(0, i).toString(); buf = buf.slice(i + 4);
        if (!/ 101 /.test(head.split('\r\n')[0])) { onClose?.('handshake failed: ' + head.split('\r\n')[0]); return; }
        upgraded = true; ready(head);
      }
      for (;;) {
        if (buf.length < 2) return;
        const op = buf[0] & 15; let len = buf[1] & 127, off = 2;
        if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
        else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
        if (buf.length < off + len) return;
        const payload = buf.slice(off, off + len); buf = buf.slice(off + len);
        if (op === 1) onMessage(payload.toString('utf8'));
        else if (op === 9) sendFrame(10, payload);
        else if (op === 8) { closed = true; onClose?.('close frame'); }
      }
    },
    send(text) { sendFrame(1, Buffer.from(text, 'utf8')); },
    close() { if (!closed) { closed = true; try { sendFrame(8, Buffer.alloc(0)); } catch {} } },
  };
}
