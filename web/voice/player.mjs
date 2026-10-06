// 読み上げの再生キュー（通話モード）。ホストが流す PCM（24kHz s16le）を、文（seg）の番号どおりに背中合わせで鳴らす。
// 出どころ: vtc-web web/src/lib/audio/tts-player.ts の PCM の経路（キュー共通の時間カーソルへ AudioBufferSource を予約する・最初は currentTime + 20ms・
// 鳴っている source を持っておいて止める）。話者ごとのキュー・端末の声・メディアの経路は要らないので単一キューにした。
//
// 合成は文ごとに並行して進むので、後の文の音が先に届くことがある。前の文が終わる（end が来る）まで、後の文の音は持っておき、順に予約する。
// 文と文の間には 120ms の間を置く。止める（cancel）は、音量を 25ms で絞ってから予約済みの source を全部止める（クリックを避ける）。
//
// イベント（onEvent）: segstart { id } 文の音が鳴り始めた / segend { id } 鳴り終わった / idle 鳴らすものが無くなった / cancel
import { s16leToFloat32 } from './pcm.mjs';

const LEAD_SEC = 0.02;
const FADE_MS = 25;

export function createPlayer({ context, sampleRate = 24000, gapSec = 0.12, onEvent = () => {} }) {
  const out = context.createGain();
  const analyser = context.createAnalyser();
  analyser.fftSize = 512;
  out.connect(analyser);
  analyser.connect(context.destination);
  const levelBuf = new Uint8Array(analyser.fftSize);

  const segs = new Map();     // id -> { id, meta, state, pending, carry, startAt, endAt, samples, complete }
  const order = [];           // 文の id（届いた順 = 読む順）
  const sources = new Set();
  const timers = new Set();
  let cursor = 0;             // 次に予約できる時刻（context の時計）
  let epoch = 0;

  const later = (ms, fn) => { const h = setTimeout(() => { timers.delete(h); fn(); }, Math.max(0, ms)); timers.add(h); };
  const now = () => context.currentTime;

  /** 前の文が終わって、いま予約してよい文（先頭の、まだ予約し終わっていない文） */
  const head = () => order.map((id) => segs.get(id)).find((s) => s && s.state !== 'scheduled' && s.state !== 'failed');

  function schedule(seg, samples) {
    if (samples.length === 0) return;
    const buffer = context.createBuffer(1, samples.length, sampleRate);
    buffer.copyToChannel(samples, 0);
    const src = context.createBufferSource();
    src.buffer = buffer;
    src.connect(out);
    const first = seg.startAt === null;
    const at = Math.max(now() + LEAD_SEC, cursor > 0 && first ? cursor + gapSec : cursor);
    src.start(at);
    sources.add(src);
    src.onended = () => { sources.delete(src); if (!sources.size && !head() && !pendingCount()) onEvent({ type: 'idle' }); };
    cursor = at + samples.length / sampleRate;
    seg.samples += samples.length;
    seg.endAt = cursor;
    if (first) {
      seg.startAt = at;
      const mine = epoch;
      later((at - now()) * 1000, () => { if (mine === epoch) onEvent({ type: 'segstart', id: seg.id }); });
    }
  }

  function flush(seg) {
    for (const samples of seg.pending.splice(0)) schedule(seg, samples);
  }

  /** 先頭の文を進める: 終わっていれば次の文へ移り、持っていた音を予約する */
  function advance() {
    for (let guard = 0; guard < 1000; guard++) {
      const seg = head();
      if (!seg) return;
      if (seg.state === 'waiting') seg.state = 'streaming';
      flush(seg);
      if (!seg.complete) return;
      seg.state = 'scheduled';
      const mine = epoch;
      if (seg.endAt !== null) later((seg.endAt - now()) * 1000, () => { if (mine === epoch) onEvent({ type: 'segend', id: seg.id }); });
      else onEvent({ type: 'segend', id: seg.id });
    }
  }

  const pendingCount = () => order.reduce((n, id) => n + (segs.get(id)?.state === 'waiting' || segs.get(id)?.state === 'streaming' ? 1 : 0), 0);

  return {
    /** 文の始まり（ホストの seg）。音より先に届く */
    seg(id, meta = {}) {
      if (segs.has(id)) return;
      segs.set(id, { id, meta, state: 'waiting', pending: [], carry: null, startAt: null, endAt: null, samples: 0, complete: false });
      order.push(id);
      advance();
    },
    chunk(id, bytes) {
      const seg = segs.get(id);
      if (!seg || seg.complete) return;
      const { samples, carry } = s16leToFloat32(bytes, seg.carry);
      seg.carry = carry;
      if (samples.length === 0) return;
      if (head() === seg) { if (seg.state === 'waiting') seg.state = 'streaming'; schedule(seg, samples); }
      else seg.pending.push(samples);
    },
    end(id) {
      const seg = segs.get(id);
      if (!seg) return;
      seg.complete = true;
      advance();
    },
    /** 1 バイトも流れずに失敗した文（画面の文字だけで見せる）。次の文へ進む */
    fail(id) {
      const seg = segs.get(id);
      if (!seg) return;
      seg.state = 'failed';
      seg.complete = true;
      onEvent({ type: 'segfail', id });
      advance();
      if (!sources.size && !head()) onEvent({ type: 'idle' });
    },
    /** 鳴っている音・順番待ちの音を全部止める（スピーカーのミュート・止める・割り込み・通話の終わり） */
    cancel() {
      epoch++;
      for (const h of timers) clearTimeout(h);
      timers.clear();
      const stopping = [...sources];
      sources.clear();
      segs.clear();
      order.length = 0;
      cursor = 0;
      out.gain.cancelScheduledValues(now());
      out.gain.setTargetAtTime(0, now(), FADE_MS / 3000);
      setTimeout(() => {
        for (const src of stopping) { src.onended = null; try { src.stop(); } catch { /* 鳴り終わっていた */ } src.disconnect(); }
        out.gain.cancelScheduledValues(now());
        out.gain.setValueAtTime(1, now());
      }, FADE_MS + 15);
      onEvent({ type: 'cancel' });
    },
    /** いま耳に届いている文の位置。無ければ null（間・順番待ち）。total は音が出そろうまで null */
    position() {
      const t = now();
      for (const id of order) {
        const seg = segs.get(id);
        if (!seg || seg.startAt === null || t < seg.startAt) continue;
        const end = seg.complete ? seg.endAt : cursor;
        if (t < end || (!seg.complete && seg.state === 'streaming')) return { id, elapsed: Math.max(0, t - seg.startAt), total: seg.complete ? seg.samples / sampleRate : null, complete: seg.complete };
      }
      return null;
    },
    /** 鳴っている・これから鳴る・合成を待っている文がある */
    busy() { return now() < cursor || pendingCount() > 0; },
    /** 出力の音量（0..1。音波の動きに使う） */
    level() {
      analyser.getByteTimeDomainData(levelBuf);
      let sum = 0;
      for (let i = 0; i < levelBuf.length; i++) { const v = (levelBuf[i] - 128) / 128; sum += v * v; }
      return Math.sqrt(sum / levelBuf.length);
    },
    close() { this.cancel(); out.disconnect(); analyser.disconnect(); },
  };
}
