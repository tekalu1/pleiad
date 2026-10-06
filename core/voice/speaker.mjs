// 読み上げの順番待ち（通話モード）。文ごとに合成を頼み、届いた音をそのままクライアントへ流す。
//
// 1 文目が閉じた時点で 1 本目を出し、2 文目以降も閉じたらすぐ合成を始める（合成は実時間の 2〜5 倍速）。音は文の番号（id）つきで流れ、
// 並べる（前の文が終わってから次の文を鳴らす）のはクライアントの再生キュー。同時に飛ぶ合成は concurrency 本まで。
// cancel() は進行中の合成を全部止める（スピーカーのミュート・止める・割り込み）。
//
// send の口: seg(id, text, meta)  文の始まり（合成より先。クライアントが画面の読む場所の印を用意できる）
//            chunk(id, bytes)      PCM（24kHz s16le）
//            end(id, info)         文の終わり（info.partial: 途中で切れた）
//            fail(id, reason)      1 バイトも流す前の失敗（画面の文字だけで見せる）
export function createSpeaker({ tts, send, concurrency = 3, log = () => {}, onMetric = () => {} }) {
  let nextId = 1;
  let epoch = 0;                    // cancel のたびに進める。古い合成の結果は捨てる
  const queue = [];                 // 順番待ち { id, text, meta, epoch }
  const flying = new Map();         // id -> AbortController
  let closed = false;

  async function run(job) {
    const abort = new AbortController();
    flying.set(job.id, abort);
    let sent = 0;
    try {
      const r = await tts.synthesize(job.text, {
        signal: abort.signal,
        onChunk: (bytes) => { if (job.epoch === epoch && !closed) { sent += bytes.length; send.chunk(job.id, bytes); } },
      });
      if (job.epoch === epoch && !closed) { send.end(job.id, { audioMs: r.audioMs }); onMetric({ id: job.id, ...r }); }
    } catch (e) {
      if (job.epoch !== epoch || closed) return;
      if (sent > 0) send.end(job.id, { partial: true });
      else { send.fail(job.id, e?.kind ?? 'error'); log('voice.tts.failed', { id: job.id, kind: e?.kind ?? null, status: e?.status ?? null }); }
    } finally {
      flying.delete(job.id);
      pump();
    }
  }

  function pump() {
    while (!closed && flying.size < concurrency && queue.length) run(queue.shift());
  }

  return {
    /** 1 文を読む。id を返す */
    speak(text, meta = {}) {
      if (closed) return null;
      const id = nextId++;
      send.seg(id, text, meta);
      queue.push({ id, text, meta, epoch });
      pump();
      return id;
    },
    /** 進行中・順番待ちの合成を全部止める（出した文は、クライアントが cancel で捨てる） */
    cancel() {
      epoch++;
      queue.length = 0;
      for (const abort of flying.values()) abort.abort();
      flying.clear();
    },
    close() { closed = true; this.cancel(); },
    pending: () => queue.length + flying.size,
  };
}
