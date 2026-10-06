// OpenRouter の呼び出し（core/voice/openrouter.mjs・stt.mjs・tts.mjs・speaker.mjs）を、偽の HTTP で確かめる。本物へは送らない。
import { createSttClient, createTranscriber } from '../../core/voice/stt.mjs';
import { createTtsClient } from '../../core/voice/tts.mjs';
import { createSpeaker } from '../../core/voice/speaker.mjs';
import { postOpenRouter, redactKey, VoiceHttpError, voiceBaseUrl } from '../../core/voice/openrouter.mjs';
import { startFakeOpenRouter, toneFrame } from '../lib/fake-openrouter.mjs';

export const name = 'voice-openrouter';
export const title = '通話の OpenRouter: やり直しの規則・429 で予備のモデル・冷却・片と投機と確定・順番・失敗の扱い・TTS の検査・キーを出さない';

const KEY = 'sk-or-v1-0123456789abcdef0123456789abcdef';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const res = (status, body = '{}', headers = {}) => new Response(body, { status, headers });

const frames = (tr, voiced, n) => { for (let i = 0; i < n; i++) tr.push(toneFrame(voiced)); };
async function waitFor(fn, ms = 3000) { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await sleep(10); } return fn(); }

export default async function (t) {
  // ---- POST の規則（偽の fetch）
  {
    const calls = [];
    const make = (...answers) => (url, init) => { calls.push({ url, init }); const a = answers.shift(); return typeof a === 'function' ? a(init) : Promise.resolve(a); };
    const config = (fetch) => ({ baseUrl: 'https://example.test/api/v1/', apiKey: KEY, fetch });
    const opts = { headersTimeoutMs: 200 };

    let got = await postOpenRouter(config(make(res(200))), '/audio/speech', { a: 1 }, opts);
    t.ok('POST: 成功の応答を返す。キーはヘッダにだけ載り、本文に載らない', got.response.ok && got.retried === false && calls[0].url === 'https://example.test/api/v1/audio/speech'
      && calls[0].init.headers.Authorization === `Bearer ${KEY}` && !String(calls[0].init.body).includes(KEY));

    calls.length = 0;
    got = await postOpenRouter(config(make(res(429, '{}', { 'retry-after': '0' }), res(200))), '/x', {}, opts);
    t.ok('POST: 429 は 1 回だけやり直す', got.response.ok && got.retried && calls.length === 2);

    calls.length = 0;
    const limited = [];
    const err429 = await postOpenRouter(config(make(res(429, '{}', { 'retry-after': '2' }), res(200))), '/x', {}, { ...opts, retryRateLimited: false, onRateLimited: (ra, retrying) => limited.push([ra, retrying]) }).catch((e) => e);
    t.ok('POST: 予備があるとき（retryRateLimited: false）は 429 を待たずに投げる。Retry-After と「やり直さない」を知らせる', err429 instanceof VoiceHttpError && err429.rateLimited && err429.kind === 'transient' && err429.retryAfter === '2'
      && calls.length === 1 && JSON.stringify(limited) === '[["2",false]]');

    calls.length = 0;
    const err500 = await postOpenRouter(config(make(res(500), res(502))), '/x', {}, opts).catch((e) => e);
    t.ok('POST: 5xx は 1 回やり直し、それでも駄目なら transient', err500.kind === 'transient' && calls.length === 2);

    calls.length = 0;
    const err400 = await postOpenRouter(config(make(res(400, `{"error":"bad key ${KEY}"}`))), '/x', {}, opts).catch((e) => e);
    t.ok('POST: 400 系はやり直さない（permanent）。エラーの文にキーが入っていても伏せる', err400.kind === 'permanent' && err400.status === 400 && calls.length === 1 && !err400.message.includes(KEY) && err400.message.includes('[redacted]'), err400.message);

    calls.length = 0;
    const slow = await postOpenRouter(config(make((init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted')))))), '/x', {}, { headersTimeoutMs: 40 }).catch((e) => e);
    t.ok('POST: ヘッダが期限までに来なければ timeout（やり直さない）', slow.kind === 'timeout' && calls.length === 1);

    const abort = new AbortController();
    const pending = postOpenRouter(config(make((init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted')))))), '/x', {}, { headersTimeoutMs: 5000, signal: abort.signal }).catch((e) => e);
    abort.abort();
    t.ok('POST: こちらから中断したら transient（やり直さない）', (await pending).kind === 'transient');

    calls.length = 0;
    const down = await postOpenRouter(config(make(() => Promise.reject(new Error('ECONNREFUSED')), () => Promise.reject(new Error('ECONNREFUSED')))), '/x', {}, opts).catch((e) => e);
    t.ok('POST: つながらないときも 1 回だけやり直し、transient で終える（キーも詳細も文に出ない）', down.kind === 'transient' && calls.length === 2 && !down.message.includes(KEY));

    calls.length = 0;
    await postOpenRouter(config(make(res(500), res(200))), '/x', {}, { ...opts, retry: false }).catch(() => {});
    t.ok('POST: retry: false なら 1 回だけ送る（投機の送信）', calls.length === 1);

    t.ok('伏せ字: キー・Bearer・sk-or- の形を伏せる', redactKey(`x ${KEY} Bearer abcdefghij12 sk-or-v1-abcdef123`, KEY) === 'x [redacted] Bearer [redacted] sk-or-[redacted]');
    t.ok('送り先: 環境変数で替えられる（末尾の / は落とす）。既定は OpenRouter', voiceBaseUrl({}) === 'https://openrouter.ai/api/v1' && voiceBaseUrl({ AGENT_HOST_VOICE_API: 'http://127.0.0.1:1/' }) === 'http://127.0.0.1:1');
  }

  // ---- STT: 主・予備・冷却・片・投機（偽の OpenRouter）
  {
    const PRIMARY = 'microsoft/mai-transcribe-2', BACKUP = 'assemblyai/universal-3-5-pro';
    const logs = [];
    const log = (line, fields) => logs.push([line, fields]);

    // 主が 429（Retry-After）を返し、予備が受ける
    const busy = await startFakeOpenRouter({ transcripts: (rec) => (rec.model === PRIMARY ? { status: 429, retryAfter: 2 } : '予備の文字です') });
    try {
      const client = createSttClient({ config: { baseUrl: busy.url, apiKey: KEY }, model: PRIMARY, fallbackModel: BACKUP, language: 'ja', log });
      const pcm = Buffer.concat(Array.from({ length: 6 }, () => toneFrame(true)));
      const a = await client.transcribe(pcm, 'final');
      t.ok('STT: 主が 429 なら待たずに予備へ送る（route: after_429）。1 回目の往復で済む', a.text === '予備の文字です' && a.model === BACKUP && a.route === 'after_429' && a.fallback === true
        && busy.records.stt.map((r) => r.model).join() === `${PRIMARY},${BACKUP}`, JSON.stringify(busy.records.stt.map((r) => r.model)));
      t.ok('STT: 送る形は WAV・言語つき・キーはヘッダ（本文・ログに出ない）', busy.records.stt[0].format === 'wav' && busy.records.stt[0].language === 'ja' && busy.records.stt[0].auth === `Bearer ${KEY}`
        && !JSON.stringify(logs).includes(KEY));
      t.ok('STT: 429 を受けたら主を「混んでいる」とみなす（冷却）', client.cooling() === true);
      const before = busy.records.stt.length;
      const piece = await client.transcribe(pcm, 'piece');
      t.ok('STT: 冷却中の片は主を飛ばして予備へ直接送る（route: cooldown）', piece.route === 'cooldown' && busy.records.stt.length === before + 1 && busy.records.stt.at(-1).model === BACKUP);
      const final = await client.transcribe(pcm, 'final');
      t.ok('STT: 冷却中でも確定は主を先に試す（精度の差が大きい）', busy.records.stt.slice(before + 1).map((r) => r.model).join() === `${PRIMARY},${BACKUP}` && final.route === 'after_429');
      const sticky = await client.transcribe(pcm, 'piece', { preferFallback: true });
      t.ok('STT: 前の片が予備へ行った発話の片は、冷却が明けても予備で揃える（route: sticky）', sticky.route === 'sticky');
    } finally { await busy.close(); }

    // 予備なしで 429 ならやり直す。やり直しても駄目なら投げる
    const solo = await startFakeOpenRouter({ transcripts: () => ({ status: 429, retryAfter: 0 }) });
    try {
      const client = createSttClient({ config: { baseUrl: solo.url, apiKey: KEY }, model: PRIMARY, fallbackModel: '', language: 'ja' });
      const e = await client.transcribe(Buffer.alloc(3200), 'final').catch((x) => x);
      t.ok('STT: 予備なしの 429 は Retry-After を待って 1 回やり直し、それでも駄目なら rateLimited で投げる', e.rateLimited === true && solo.records.stt.length === 2 && client.hasFallback === false);
    } finally { await solo.close(); }

    // ---- 通し: 片 → 投機 → 確定（投機の再利用）
    const script = ['こんにちは今日は', '今日はいい天気ですね', 'こんにちは今日はいい天気ですね'];
    const api = await startFakeOpenRouter({ transcripts: (_rec, i) => script[Math.min(i, 2)] });
    try {
      const events = [];
      const client = createSttClient({ config: { baseUrl: api.url, apiKey: KEY }, model: PRIMARY, fallbackModel: BACKUP, language: 'ja', log });
      const tr = createTranscriber({ client, language: 'ja', emit: (e) => events.push(e), log });
      // 実際には声は 85ms ごとに届き、片の結果は区切る前に返る。ここでは片ごとに結果を待ってから続きを入れる
      frames(tr, false, 4);
      frames(tr, true, 14); frames(tr, false, 2);     // 1 つ目の片（息継ぎ）
      await waitFor(() => events.some((e) => e.type === 'partial'));
      frames(tr, true, 14); frames(tr, false, 2);     // 2 つ目の片
      await waitFor(() => events.filter((e) => e.type === 'partial').length === 2);
      frames(tr, false, 6);                           // 無音 600ms → 発話を区切る
      await waitFor(() => events.some((e) => e.type === 'final'));
      const speaking = events.filter((e) => e.type === 'speaking');
      const partials = events.filter((e) => e.type === 'partial').map((e) => e.text);
      const fin = events.find((e) => e.type === 'final');
      t.ok('通し: 声が 200ms に届いたら speaking: true、区切ったら false', speaking[0]?.on === true && speaking.at(-1)?.on === false);
      t.ok('通し: 片は重なりを除いてつなぎ、途中の文字として出る（全文が育つ）', JSON.stringify(partials) === JSON.stringify(['こんにちは今日は', 'こんにちは今日はいい天気ですね']), JSON.stringify(partials));
      t.ok('通し: 確定は発話全体の認識（片のつなぎではない）で、同じ発話の番号', fin?.text === 'こんにちは今日はいい天気ですね' && fin.utt === 1 && events.filter((e) => e.utt !== undefined).every((e) => e.utt === 1));
      t.ok('通し: 区切る前に先に送った見本（投機）の結果を再利用する。送ったのは片 2 + 投機 1 の 3 回だけ', fin?.speculative === true && api.records.stt.length === 3, `${api.records.stt.length} ${fin?.speculative}`);
      t.ok('通し: 声の終わり→確定の遅れを持つ（ログ・画面の開発用の表示に使う）', Number.isFinite(fin?.speechEndToFinalMs) && fin.speechEndToFinalMs >= 0);
      t.ok('通し: 2 つ目の片は頭に直前の音声を付けて送る（1 つ目より長い）', api.records.stt[1].durationMs > api.records.stt[0].durationMs + 500, JSON.stringify(api.records.stt.map((r) => r.durationMs)));
      tr.close();
    } finally { await api.close(); }

    // 投機が外れる（声が戻る）: 見本は捨て、確定は区切ったあとの音声で認識する
    {
      const api2 = await startFakeOpenRouter({ transcripts: (rec, i) => `認識${i}` });
      try {
        const events = [];
        const client = createSttClient({ config: { baseUrl: api2.url, apiKey: KEY }, model: PRIMARY, fallbackModel: '', language: 'ja' });
        const tr = createTranscriber({ client, language: 'ja', emit: (e) => events.push(e), cut: { endSilenceMs: 600, maxUtteranceMs: 15000, speculativeSilenceMs: 300 } });
        frames(tr, true, 5); frames(tr, false, 4);      // 無音 341ms で見本を送る
        await waitFor(() => api2.records.stt.length === 1);
        frames(tr, true, 5);                            // 声が戻る → 見本は捨てる
        frames(tr, false, 8);                           // 区切る
        await waitFor(() => events.some((e) => e.type === 'final'));
        const fin = events.find((e) => e.type === 'final');
        t.ok('投機: 声が戻ったら最初の見本は捨て、戻ったあとの無音で作り直した見本（より長い音声）を確定に使う。外れた分は課金が増える', fin?.text === '認識1' && api2.records.stt.length === 2 && api2.records.stt[1].durationMs > api2.records.stt[0].durationMs, JSON.stringify(api2.records.stt.map((r) => r.durationMs)));
        tr.close();
      } finally { await api2.close(); }
    }

    // 短い声・空の文字は送らない／捨てる
    {
      const api3 = await startFakeOpenRouter({ transcripts: ['。'] });
      try {
        const events = [];
        const client = createSttClient({ config: { baseUrl: api3.url, apiKey: KEY }, model: PRIMARY, language: 'ja' });
        const tr = createTranscriber({ client, language: 'ja', emit: (e) => events.push(e) });
        frames(tr, true, 2); frames(tr, false, 8);
        t.ok('雑音: 声が 200ms に届かない発話は 1 度も送らず、drop を出す', api3.records.stt.length === 0 && events.some((e) => e.type === 'drop') && !events.some((e) => e.type === 'speaking' && e.on));
        frames(tr, true, 6); frames(tr, false, 8);
        await waitFor(() => events.filter((e) => e.type === 'drop').length >= 2);
        t.ok('雑音: 文字が空・記号だけの結果は確定にせず drop する（幻の 1 語を会話へ送らない）', !events.some((e) => e.type === 'final') && events.filter((e) => e.type === 'drop').length === 2);
        tr.close();
      } finally { await api3.close(); }
    }

    // 順番: 先の発話の認識が遅れても、確定は話した順
    {
      const api4 = await startFakeOpenRouter({ transcripts: (_rec, i) => `発話${i}`, sttDelay: (_rec, i) => (i === 0 ? 400 : 0) });
      try {
        const events = [];
        const client = createSttClient({ config: { baseUrl: api4.url, apiKey: KEY }, model: PRIMARY, language: 'ja' });
        const tr = createTranscriber({ client, language: 'ja', emit: (e) => events.push(e), cut: { endSilenceMs: 600, maxUtteranceMs: 15000, speculativeSilenceMs: 0 } });
        frames(tr, true, 5); frames(tr, false, 8);
        frames(tr, true, 5); frames(tr, false, 8);
        await waitFor(() => events.filter((e) => e.type === 'final').length === 2, 4000);
        const finals = events.filter((e) => e.type === 'final');
        t.ok('順番: 後の発話が先に返っても、確定は区切った順に出る（前の結果を待つ）', finals.map((f) => f.utt).join() === '1,2' && finals[0].text === '発話0' && finals[1].text === '発話1', JSON.stringify(finals.map((f) => [f.utt, f.text])));
        tr.close();
      } finally { await api4.close(); }
    }

    // 失敗: 片の途中経過があれば確定させる／無ければ error
    {
      const api5 = await startFakeOpenRouter({ transcripts: (_rec, i) => (i === 0 ? 'こんにちは今日は' : { status: 400 }) });
      try {
        const events = [];
        const client = createSttClient({ config: { baseUrl: api5.url, apiKey: KEY }, model: PRIMARY, language: 'ja' });
        const tr = createTranscriber({ client, language: 'ja', emit: (e) => events.push(e), cut: { endSilenceMs: 600, maxUtteranceMs: 15000, speculativeSilenceMs: 0, pieces: { minMs: 1000, silenceMs: 170, maxMs: 2500, contextMs: 2000 } } });
        frames(tr, true, 14); frames(tr, false, 2);
        await waitFor(() => events.some((e) => e.type === 'partial'));
        frames(tr, true, 4); frames(tr, false, 8);
        await waitFor(() => events.some((e) => e.type === 'final' || e.type === 'error'));
        const fin = events.find((e) => e.type === 'final');
        t.ok('失敗: 全体の認識が失敗しても、出した途中経過をそのまま確定させる（行が確定せずに残らない。degraded）', fin?.text === 'こんにちは今日は' && fin.degraded === true, JSON.stringify(events.slice(-2)));
        tr.close();
      } finally { await api5.close(); }
      const api6 = await startFakeOpenRouter({ transcripts: () => ({ status: 401 }) });
      try {
        const events = [];
        const client = createSttClient({ config: { baseUrl: api6.url, apiKey: KEY }, model: PRIMARY, language: 'ja' });
        const tr = createTranscriber({ client, language: 'ja', emit: (e) => events.push(e) });
        frames(tr, true, 5); frames(tr, false, 8);
        await waitFor(() => events.some((e) => e.type === 'error'));
        const e = events.find((x) => x.type === 'error');
        t.ok('失敗: 途中経過が無ければ error（code・kind・status。キーも本文も含まない）', e?.code === 'stt' && e.kind === 'permanent' && e.status === 401 && !JSON.stringify(e).includes(KEY));
        tr.close();
      } finally { await api6.close(); }
    }

    // 片の重なりが見つからない: その発話の途中経過をあきらめ、確定は出る
    {
      const api7 = await startFakeOpenRouter({ transcripts: (_rec, i) => (i === 0 ? 'こんにちは今日は' : i === 1 ? 'まったく別の言葉です' : 'こんにちは今日は良い天気') });
      try {
        const events = [];
        const client = createSttClient({ config: { baseUrl: api7.url, apiKey: KEY }, model: PRIMARY, language: 'ja' });
        const tr = createTranscriber({ client, language: 'ja', emit: (e) => events.push(e), log, cut: { endSilenceMs: 600, maxUtteranceMs: 15000, speculativeSilenceMs: 0, pieces: { minMs: 1000, silenceMs: 170, maxMs: 2500, contextMs: 2000 } } });
        frames(tr, true, 14); frames(tr, false, 2);
        await waitFor(() => events.some((e) => e.type === 'partial'));
        frames(tr, true, 14); frames(tr, false, 2);
        await waitFor(() => logs.some(([l]) => l === 'voice.stt.pieces_gave_up'));
        frames(tr, false, 8);
        await waitFor(() => events.some((e) => e.type === 'final'));
        t.ok('片: 重なりが見つからない片の文字は使わず、途中経過をあきらめる（二重に出さない）。確定は出る', events.filter((e) => e.type === 'partial').length === 1
          && events.find((e) => e.type === 'final')?.text === 'こんにちは今日は良い天気' && logs.some(([l, f]) => l === 'voice.stt.pieces_gave_up' && f.why === 'overlap'));
        tr.close();
      } finally { await api7.close(); }
    }
  }

  // ---- TTS
  {
    const api = await startFakeOpenRouter({ ttsMsPerChar: 60 });
    const tts = (overrides = {}) => createTtsClient({ config: { baseUrl: api.url, apiKey: KEY }, model: 'x-ai/grok-voice-tts-1.0', voice: 'eve', ...overrides });
    try {
      const chunks = [];
      const r = await tts().synthesize('こんにちは、元気ですか。', { onChunk: (c) => chunks.push(c) });
      const total = chunks.reduce((n, c) => n + c.length, 0);
      t.ok('TTS: PCM を逐次で受け、チャンクは常に偶数バイト（奇数の境で割れても持ち越す）。PCM・声・モデルを指定して頼む', chunks.length > 1 && chunks.every((c) => c.length % 2 === 0) && total === r.bytes
        && api.records.tts[0].format === 'pcm' && api.records.tts[0].voice === 'eve' && api.records.tts[0].model === 'x-ai/grok-voice-tts-1.0' && api.records.tts[0].auth === `Bearer ${KEY}`);
      t.ok('TTS: 最初のバイトまでの時間と音の長さを返す（遅延の計測）', Number.isFinite(r.firstChunkMs) && r.audioMs > 500 && r.chars === 12, JSON.stringify(r));
    } finally { await api.close(); }

    const mp3 = await startFakeOpenRouter({ speechContentType: 'audio/mpeg' });
    try {
      const chunks = [];
      const e = await createTtsClient({ config: { baseUrl: mp3.url, apiKey: KEY }, model: 'm/x', voice: 'v' }).synthesize('テスト', { onChunk: (c) => chunks.push(c) }).catch((x) => x);
      t.ok('TTS: PCM でない形式（mp3）は 1 バイトも流さずに失敗させる', e instanceof VoiceHttpError && e.kind === 'permanent' && chunks.length === 0);
    } finally { await mp3.close(); }
    const rate = await startFakeOpenRouter({ speechContentType: 'audio/pcm;rate=16000' });
    try {
      const chunks = [];
      const e = await createTtsClient({ config: { baseUrl: rate.url, apiKey: KEY }, model: 'm/x', voice: 'v' }).synthesize('テスト', { onChunk: (c) => chunks.push(c) }).catch((x) => x);
      t.ok('TTS: 違うレートは 1 バイトも流さずに失敗させる（声の高さと速さが変わるため）', e.kind === 'permanent' && /rate/.test(e.message) && chunks.length === 0);
    } finally { await rate.close(); }
    const down = await startFakeOpenRouter({ speechStatus: 429 });
    try {
      const e = await createTtsClient({ config: { baseUrl: down.url, apiKey: KEY }, model: 'm/x', voice: 'v' }).synthesize('テスト', { onChunk() {} }).catch((x) => x);
      t.ok('TTS: 上流の失敗は kind 付きで投げる（1 バイトも流す前は、画面の文字だけで見せる）', e.kind === 'transient' && !e.partial && !e.message.includes(KEY));
    } finally { await down.close(); }

    // 中断
    const slow = await startFakeOpenRouter({ ttsMsPerChar: 400, ttsChunkMs: 80 });
    try {
      const abort = new AbortController();
      let got = 0;
      const run = tts2(slow, KEY).synthesize('とても長い文章を読み上げます。', { signal: abort.signal, onChunk: () => { got++; if (got === 2) abort.abort(); } }).catch((x) => x);
      const e = await run;
      t.ok('TTS: 中断すると流れが止まり、途中で切れた印（partial）つきで投げる', e instanceof VoiceHttpError && e.partial === true && got >= 2 && got < 20, `${got} ${e?.message}`);
    } finally { await slow.close(); }
  }

  // ---- Speaker（順番待ち・並行・中断・失敗）
  {
    const sent = [];
    const make = (synth) => createSpeaker({
      tts: { synthesize: synth },
      send: { seg: (id, text, meta) => sent.push(['seg', id, text, meta]), chunk: (id, b) => sent.push(['chunk', id, b.length]), end: (id, info) => sent.push(['end', id, info]), fail: (id, why) => sent.push(['fail', id, why]) },
      concurrency: 2,
    });
    let inflight = 0, peak = 0;
    const synth = async (text, { onChunk, signal }) => {
      inflight++; peak = Math.max(peak, inflight);
      try {
        await sleep(text.length * 5);
        if (signal.aborted) throw new VoiceHttpError('aborted', 'transient');
        onChunk(new Uint8Array(480));
        return { audioMs: 10, bytes: 480, chars: text.length, firstChunkMs: 1, tookMs: 5 };
      } finally { inflight--; }
    };
    const speaker = make(synth);
    const ids = ['一つ目です。', '二つ目です。', '三つ目です。'].map((s, i) => speaker.speak(s, { first: i === 0 }));
    t.ok('読み上げ: 文は先に（音より前に）seg で知らせる。id は順番', JSON.stringify(sent.map((x) => x[0]).slice(0, 3)) === '["seg","seg","seg"]' && ids.join() === '1,2,3' && sent[0][3].first === true);
    await waitFor(() => sent.filter((x) => x[0] === 'end').length === 3);
    t.ok('読み上げ: 合成は文ごとに並行（同時に 2 本まで）して、全部の文が end で閉じる', peak === 2 && sent.filter((x) => x[0] === 'end').length === 3, `peak=${peak}`);
    sent.length = 0;
    const s2 = make(synth);
    s2.speak('止める文です。'); s2.speak('これも止まります。');
    s2.cancel();
    await sleep(200);
    t.ok('読み上げ: cancel で進行中・順番待ちの合成を止め、音も end も流れない', sent.filter((x) => x[0] === 'chunk' || x[0] === 'end').length === 0);
    sent.length = 0;
    const s3 = make(async () => { throw new VoiceHttpError('upstream', 'transient', { status: 500 }); });
    s3.speak('失敗する文です。');
    await waitFor(() => sent.some((x) => x[0] === 'fail'));
    t.ok('読み上げ: 1 バイトも流す前の失敗は fail（画面の文字だけで見せる）', sent.some((x) => x[0] === 'fail' && x[1] === 1 && x[2] === 'transient'));
    s3.close();
    t.ok('読み上げ: 閉じたあとは何も頼まない', s3.speak('もう読めない') === null);
  }
}

function tts2(api, key) { return createTtsClient({ config: { baseUrl: api.url, apiKey: key }, model: 'x-ai/grok-voice-tts-1.0', voice: 'eve' }); }
