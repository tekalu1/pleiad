// 通話モード（core/voice/）の確認用の偽の OpenRouter。本物へは送らない（AGENT_HOST_VOICE_API にこの URL を渡す）。
//   POST /audio/transcriptions  WAV（JSON の input_audio）を受け、台本の文字を返す。受けた長さ・モデル・キーを records に残す
//   POST /audio/speech          文字の長さに比例した正弦波の PCM（24kHz s16le）を、実時間より速く逐次で返す
//   GET  /key                   キーの確認（既定は 200。keyStatus で 401 などにできる）
// 台本: transcripts は (request, index) => text | { status, retryAfter } を返す関数か、順に返す文字の配列（尽きたら最後を繰り返す）。
import http from 'node:http';

const wavInfo = (b64) => {
  const bytes = Buffer.from(b64, 'base64');
  const rate = bytes.length >= 28 ? bytes.readUInt32LE(24) : 16000;
  return { bytes: bytes.length, durationMs: Math.round(((bytes.length - 44) / 2 / rate) * 1000) };
};

export async function startFakeOpenRouter({ transcripts = ['こんにちは'], sttDelay = null, ttsChunkMs = 5, ttsMsPerChar = 90, ttsFirstByteDelayMs = 0, keyStatus = 200, speechContentType = 'audio/pcm;rate=24000;channels=1', speechStatus = 200 } = {}) {
  const records = { stt: [], tts: [], key: 0 };
  const script = typeof transcripts === 'function' ? transcripts : (_req, i) => transcripts[Math.min(i, transcripts.length - 1)];
  let sttCount = 0;
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      const url = new URL(req.url, 'http://x');
      const auth = req.headers.authorization ?? '';
      let body = null;
      try { body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null; } catch { /* 空 */ }
      if (url.pathname === '/key') { records.key++; res.writeHead(keyStatus, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ data: { label: 'fake' } })); }
      if (url.pathname === '/audio/transcriptions') {
        const info = wavInfo(body?.input_audio?.data ?? '');
        const rec = { model: body?.model, language: body?.language, format: body?.input_audio?.format, auth, ...info, at: Date.now() };
        records.stt.push(rec);
        const index = sttCount++;
        const out = script(rec, index);
        const wait = sttDelay ? sttDelay(rec, index) : 0;
        if (wait) await new Promise((r) => setTimeout(r, wait));
        if (out && typeof out === 'object') {
          res.writeHead(out.status ?? 500, { 'content-type': 'application/json', ...(out.retryAfter ? { 'retry-after': String(out.retryAfter) } : {}) });
          return res.end(JSON.stringify({ error: { message: 'scripted failure' } }));
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ text: out ?? '', usage: { seconds: info.durationMs / 1000, cost: 0.00003 } }));
      }
      if (url.pathname === '/audio/speech') {
        const rec = { model: body?.model, voice: body?.voice, format: body?.response_format, input: body?.input, auth, at: Date.now() };
        records.tts.push(rec);
        if (speechStatus !== 200) { res.writeHead(speechStatus, { 'content-type': 'application/json' }); return res.end('{"error":"scripted"}'); }
        res.writeHead(200, { 'content-type': speechContentType });
        if (ttsFirstByteDelayMs) await new Promise((r) => setTimeout(r, ttsFirstByteDelayMs));
        const ms = Math.max(200, String(body?.input ?? '').length * ttsMsPerChar);
        const samples = Math.floor(24000 * ms / 1000);
        const pcm = Buffer.alloc(samples * 2);
        for (let i = 0; i < samples; i++) pcm.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / 24000) * 0.2 * 32767), i * 2);
        // 偶数でない境で切って送る（受け手の奇数バイトの持ち越しを確かめる）
        const step = 4801;
        for (let at = 0; at < pcm.length; at += step) {
          res.write(pcm.subarray(at, Math.min(pcm.length, at + step)));
          await new Promise((r) => setTimeout(r, ttsChunkMs));
        }
        return res.end();
      }
      res.writeHead(404).end();
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return { url: `http://127.0.0.1:${port}`, port, records, close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }) };
}

/** 声の代わりの音声フレーム（16kHz s16le）。voiced なら正弦波（RMS ≈ 0.14）、そうでなければ無音。ms は 85.3ms に近い 1365 サンプルの倍数 */
export function toneFrame(voiced, samples = 1365) {
  const out = Buffer.alloc(samples * 2);
  if (voiced) for (let i = 0; i < samples; i++) out.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 220 * i) / 16000) * 0.2 * 32767), i * 2);
  return out;
}
