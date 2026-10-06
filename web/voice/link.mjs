// 通話の接続（/voice-ws。docs/voice-call.md「プロトコル」）。上りは音声のバイナリと JSON の制御、下りは JSON とバイナリ（[1][文の id uint32 LE][PCM 24kHz s16le]）。
// 切れたら通話を終える（自動では繋ぎ直さない。マイクと再生の状態を、サーバー側の状態と食い違わせないため）。
export const BINARY_AUDIO = 1;

/**
 * @param {{ token: string, onJson: (msg: object) => void, onAudio: (id: number, bytes: Uint8Array) => void, onClose: (info: { clean: boolean }) => void, WebSocketImpl?: typeof WebSocket }} o
 */
export function createLink({ token, onJson, onAudio, onClose, WebSocketImpl = WebSocket }) {
  let ws = null, closed = false;
  return {
    /** 開くまで待つ。失敗は投げる */
    connect() {
      return new Promise((resolve, reject) => {
        const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
        ws = new WebSocketImpl(`${scheme}://${location.host}/voice-ws?token=${encodeURIComponent(token)}`);
        ws.binaryType = 'arraybuffer';
        ws.onopen = () => resolve();
        ws.onerror = () => { if (ws.readyState !== 1) reject(new Error('voice link failed')); };
        ws.onclose = (e) => { if (ws.readyState === 3 && !closed) { closed = true; onClose({ clean: e.code === 1000 }); } reject(new Error('voice link closed')); };
        ws.onmessage = (e) => {
          if (typeof e.data === 'string') { try { onJson(JSON.parse(e.data)); } catch { /* 壊れた JSON は捨てる */ } return; }
          const bytes = new Uint8Array(e.data);
          if (bytes[0] !== BINARY_AUDIO || bytes.length < 5) return;
          const id = new DataView(e.data).getUint32(1, true);
          onAudio(id, bytes.subarray(5));
        };
      });
    },
    send(obj) { if (ws?.readyState === 1) ws.send(JSON.stringify(obj)); },
    /** 音声フレーム（16kHz s16le）。まだ繋がっていなければ捨てる（ready の前の音声は送らない） */
    sendAudio(buffer) { if (ws?.readyState === 1) ws.send(buffer); },
    get open() { return ws?.readyState === 1; },
    close() { closed = true; try { ws?.close(1000); } catch { /* 閉じていた */ } },
  };
}
