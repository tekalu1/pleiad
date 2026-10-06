// 通話 1 本の状態（core/voice/session.mjs）。偽の聞き取り・読み上げ・時計で、プロトコルの一巡と限度・ミュート・止める・遅延の内訳・キーを出さないことを確かめる。
import { BINARY_AUDIO, createVoiceSession } from '../../core/voice/session.mjs';
import { normalizeVoiceSettings } from '../../core/voice/settings.mjs';
import { toneFrame } from '../lib/fake-openrouter.mjs';

export const name = 'voice-session';
export const title = '通話 1 本: hello と限度（キー・1 日・1 回・声が無いまま）・声から確定まで・返事の読み上げ（seg と音）・ミュート・止める・遅延の内訳・キーを出さない';

const KEY = 'sk-or-v1-0123456789abcdef0123456789abcdef';
const PHRASES = { code: 'コードは画面に出しました', table: '表は画面に出しました', log: 'ログは画面に出しました' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 3000) { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await sleep(5); } return fn(); }

function harness({ settings = {}, today = 0, withKey = true, clients = true, idleEndMs, tickMs = 10 } = {}) {
  const sent = [], binary = [], logs = [], usageAdds = [];
  let closed = 0, clock = 1_000_000, n = 0;
  const usage = { add: async (d) => { usageAdds.push(d); }, flush: async () => {}, today: async () => ({ callSeconds: today, sttSeconds: 0, ttsChars: 0 }) };
  const stt = { cooling: () => false, hasFallback: false, transcribe: async (pcm, kind) => ({ text: `聞き取った言葉${n++}`, model: 'stt/m', tookMs: 4, audioMs: 1000, route: 'primary', fallback: false, kind }) };
  const tts = { sampleRate: 24000, synthesize: async (text, { onChunk, signal }) => {
    await sleep(2);
    if (signal.aborted) throw Object.assign(new Error('aborted'), { kind: 'transient' });
    onChunk(new Uint8Array(4800));
    return { audioMs: 100, bytes: 4800, chars: text.length, firstChunkMs: 3, tookMs: 5 };
  } };
  const target = [];
  const session = createVoiceSession({
    send: (o) => sent.push(o), sendBinary: (b) => binary.push(b), close: () => { closed++; },
    log: (line, fields) => logs.push([line, fields]), now: () => clock, tickMs, ...(idleEndMs ? { idleEndMs } : {}),
    clients: clients ? { stt, tts } : {},
    onTarget: (x) => target.push(x),
    hello: async () => ({ settings: normalizeVoiceSettings(settings), config: withKey ? { baseUrl: 'http://x', apiKey: KEY } : null, uiLang: 'ja', phrases: PHRASES, usage, todayCallSeconds: today }),
  });
  const hello = (target = { kind: 'chat', sessionId: 's1' }) => session.onMessage(JSON.stringify({ t: 'hello', target }), false);
  const msg = (type, extra = {}) => session.onMessage(JSON.stringify({ t: type, ...extra }), false);
  const frames = (voiced, count) => { for (let i = 0; i < count; i++) session.onMessage(toneFrame(voiced), true); };
  return { session, sent, binary, logs, usageAdds, hello, msg, frames, advance: (ms) => { clock += ms; }, get closed() { return closed; }, target };
}
const types = (h) => h.sent.map((m) => m.t);

export default async function (t) {
  // ---- 開始と限度
  {
    const h = harness({ withKey: false, clients: false });
    await h.hello();
    t.ok('hello: キーが無ければ no-key（致命）で閉じる。何も送らない', h.sent[0]?.t === 'error' && h.sent[0].code === 'no-key' && h.sent[0].fatal === true && h.closed === 1);
    const d = harness({ today: 120 * 60 });
    await d.hello();
    t.ok('hello: 今日の通話の上限（既定 120 分）に達していれば daily-limit で始めない', d.sent[0]?.code === 'daily-limit' && d.closed === 1);
    const ok = harness({ today: 30 });
    await ok.hello({ kind: 'thread', channelId: 'c_1', threadId: 'p_1' });
    const ready = ok.sent[0];
    t.ok('hello: 準備ができたら ready（モデル・再生のレート 24000・上限・今日の使用）を返す。見る先を覚える', ready?.t === 'ready' && ready.rate === 24000 && ready.sttModel === 'microsoft/mai-transcribe-2' && ready.ttsModel === 'x-ai/grok-voice-tts-1.0'
      && ready.limits.callMinutes === 30 && ready.limits.dailyMinutes === 120 && ready.limits.usedTodaySeconds === 30 && ok.session.target?.kind === 'thread' && ok.session.active);
    const before = ok.sent.length;
    ok.frames(true, 3);
    await sleep(20);
    t.ok('音声フレームを受けても、ready の前の音は何も返さない（ready のあとは受ける）', ok.sent.slice(before).every((m) => m.t === 'speaking' || m.t === 'busy'));
    ok.session.close();
    t.ok('閉じたあとのメッセージは捨てる', (() => { const n = ok.sent.length; ok.frames(true, 20); return ok.sent.length === n; })());
    t.ok('不正な JSON・知らないメッセージ・64KB 超は無視する（落ちない）', await (async () => {
      const x = harness(); await x.hello();
      await x.session.onMessage('{broken', false);
      await x.session.onMessage(JSON.stringify({ t: 'what' }), false);
      await x.session.onMessage('x'.repeat(70_000), false);
      return x.session.active;
    })());
  }

  // ---- 声から確定まで
  {
    const h = harness();
    await h.hello();
    h.frames(false, 3); h.frames(true, 8); h.frames(false, 8);
    await waitFor(() => types(h).includes('final'));
    const ty = types(h);
    t.ok('声 → speaking（声が 200ms に届いたら）→ 区切って speaking off → final（番号・文字・声の終わり→確定の遅れ）', ty.includes('speaking') && h.sent.find((m) => m.t === 'speaking')?.on === true && h.sent.find((m) => m.t === 'final')?.text.startsWith('聞き取った言葉')
      && Number.isFinite(h.sent.find((m) => m.t === 'final').speechEndToFinalMs) && h.sent.find((m) => m.t === 'final').utt === 1, JSON.stringify(ty));
    t.ok('確定は voice.final としてログに残る（文字の長さ・モデル・遅れ。本文は出さない）', h.logs.some(([l, f]) => l === 'voice.final' && f.chars > 0 && f.model === 'stt/m' && !JSON.stringify(f).includes('聞き取った言葉')));

    // ミュート: フレームは捨て、いま話している分は確定させる
    const m = harness();
    await m.hello();
    m.frames(true, 8);
    await m.msg('mute', { on: true });
    await waitFor(() => types(m).includes('final'));
    const mutedAt = m.sent.length;
    m.frames(true, 12); m.frames(false, 10);
    await sleep(40);
    t.ok('ミュート: いま話している分は確定させ、そのあとの音声フレームは捨てる（何も返らない）', types(m).includes('final') && m.sent.length === mutedAt && m.session.state.muted === true);
    await m.msg('mute', { on: false });
    m.frames(true, 8); m.frames(false, 8);
    await waitFor(() => types(m).filter((x) => x === 'final').length === 2);
    t.ok('ミュートを解除すると、また聞き取る', types(m).filter((x) => x === 'final').length === 2);
  }

  // ---- 返事の読み上げ
  {
    const h = harness();
    await h.hello({ kind: 'chat', sessionId: 's1' });
    h.frames(true, 8); h.frames(false, 8);
    await waitFor(() => types(h).includes('final'));
    h.session.onAgentEvent({ type: 'userMessage', sessionId: 's1', text: '聞き取った言葉' });
    t.ok('ユーザーの発言（userMessage）で、前のターンの読み上げを捨てる（cancel）', types(h).at(-1) === 'cancel');
    const reply = '署名の鍵は、リポジトリにあります。次の手順です。\n```\ngh secret set X\n```\n以上です。';
    for (let i = 0; i < reply.length; i += 5) h.session.onAgentEvent({ type: 'text.delta', sessionId: 's1', text: reply.slice(i, i + 5) });
    h.session.onAgentEvent({ type: 'text.end', sessionId: 's1' });
    h.session.onAgentEvent({ type: 'turnEnd', sessionId: 's1' });
    await waitFor(() => h.sent.filter((m) => m.t === 'seg.end').length === 4);
    const segs = h.sent.filter((m) => m.t === 'seg');
    t.ok('文は seg（番号・文字・first）で先に知らせる。コードは読まず、最後に言い添えの文（skip: code）', segs.map((s) => s.text).join('|') === '署名の鍵は、リポジトリにあります。|次の手順です。|以上です。|コードは画面に出しました'
      && segs[0].first === true && segs.at(-1).skip === 'code' && segs.map((s) => s.id).join() === '1,2,3,4', JSON.stringify(segs));
    const audio = h.binary.filter((b) => b[0] === BINARY_AUDIO);
    t.ok('音はバイナリ [1][文の id uint32 LE][PCM 24kHz]。どの文にも 1 つ以上届き、全部の文が seg.end で閉じる', audio.length >= 4 && audio.every((b) => b.length === 5 + 4800) && new Set(audio.map((b) => b.readUInt32LE(1))).size === 4);
    t.ok('ターンの終わりで turn.end（読んだ文があれば spoke: true）', h.sent.some((m) => m.t === 'turn.end' && m.spoke === true));
    const lat = h.sent.find((m) => m.t === 'lat');
    t.ok('遅延の内訳: 確定 → 最初の文字 → 最初の文が閉じる → 最初の音（lat とログ voice.latency）', lat && Number.isFinite(lat.finalToFirstAudioMs) && lat.speechEndToFinalMs >= 0 && lat.finalToFirstTextMs >= 0 && lat.sentenceToFirstAudioMs >= 0
      && h.logs.some(([l, f]) => l === 'voice.latency' && f.finalToFirstAudioMs === lat.finalToFirstAudioMs), JSON.stringify(lat));
    t.ok('遅延: クライアントが測った「確定 → 最初の音」を受けて voice.latency_client に残す', (await h.msg('lat', { sinceFinalMs: 612.4 }), h.logs.some(([l, f]) => l === 'voice.latency_client' && f.finalToSoundMs === 612)));
    t.ok('読み上げた分（字数）と通話の長さは台帳へ足す', h.usageAdds.some((d) => d.ttsChars > 0));

    // 読む文が無いターン
    const quiet = harness();
    await quiet.hello();
    quiet.session.onAgentEvent({ type: 'turnEnd', sessionId: 's1' });
    t.ok('読む文が無いターンは turn.end の spoke: false（画面は「考え中」を終える）', quiet.sent.at(-1)?.t === 'turn.end' && quiet.sent.at(-1).spoke === false);

    // スピーカーのミュート
    const s = harness();
    await s.hello();
    s.session.onAgentEvent({ type: 'text.delta', sessionId: 's1', text: '一つ目の文です。' });
    await s.msg('spk', { on: true });
    t.ok('スピーカーのミュート: 読み上げを止め（cancel）、ミュート中の文は合成を頼まない', types(s).includes('cancel') && s.session.state.spkMuted === true);
    const n = s.sent.filter((m) => m.t === 'seg').length;
    s.session.onAgentEvent({ type: 'text.delta', sessionId: 's1', text: 'ミュート中の文です。' });
    t.ok('ミュート中の文は seg にならない', s.sent.filter((m) => m.t === 'seg').length === n);
    await s.msg('spk', { on: false });
    s.session.onAgentEvent({ type: 'text.delta', sessionId: 's1', text: '解除後の文です。' });
    t.ok('解除すると次の文から読む', s.sent.filter((m) => m.t === 'seg').at(-1)?.text === '解除後の文です。');

    // 止める
    const x = harness();
    await x.hello();
    x.session.onAgentEvent({ type: 'text.delta', sessionId: 's1', text: '読んでいる途中の文です。' });
    await x.msg('halt');
    const k = x.sent.filter((m) => m.t === 'seg').length;
    x.session.onAgentEvent({ type: 'text.delta', sessionId: 's1', text: '止めたあとの文です。' });
    t.ok('止める（halt）: 鳴っている音を捨て（cancel）、このターンの残りは読まない', types(x).includes('cancel') && x.sent.filter((m) => m.t === 'seg').length === k && x.session.state.halted === true);
    x.session.onAgentEvent({ type: 'userMessage', sessionId: 's1' });
    x.session.onAgentEvent({ type: 'text.delta', sessionId: 's1', text: '次のターンの文です。' });
    t.ok('次の発言からは、また読む', x.sent.filter((m) => m.t === 'seg').at(-1)?.text === '次のターンの文です。' && x.session.state.halted === false);
    await x.msg('barge');
    t.ok('barge（話して割り込む 2 段目の口）も halt と同じ', x.session.state.halted === true);
  }

  // ---- まとめ待ちの材料（ready の区切り・busy）と、止めて続きを読む（承認済み 2026-10-07）
  {
    const d = harness();
    await d.hello();
    t.ok('ready: 区切りの長さ（既定 標準 1.2 秒）と、話して止めるが入っているかをクライアントへ渡す', d.sent[0].turnHoldMs === 1200 && d.sent[0].bargeIn === true);
    const c = harness({ settings: { turnHold: 'long', bargeIn: false } });
    await c.hello();
    t.ok('ready: 設定の区切り（長め 2.0 秒）・話して止める（オフ）がそのまま届く', c.sent[0].turnHoldMs === 2000 && c.sent[0].bargeIn === false);
    d.frames(true, 8); d.frames(false, 8);
    await waitFor(() => types(d).includes('final') && d.sent.filter((m) => m.t === 'busy').length >= 2);
    const busy = d.sent.filter((m) => m.t === 'busy');
    const at = (type) => d.sent.findIndex((m) => m.t === type);
    t.ok('busy: 話し始めで on、確定を出したあとで off（まとめ待ちは、これが閉じるまで送らない）', busy[0].on === true && busy.at(-1).on === false && d.sent.indexOf(busy.at(-1)) > at('final') && at('final') > d.sent.indexOf(busy[0]), JSON.stringify(types(d)));

    const h = harness();
    await h.hello();
    const segs = () => h.sent.filter((m) => m.t === 'seg');
    for (const text of ['一つ目の文です。', '二つ目の文です。', '三つ目の文です。']) h.session.onAgentEvent({ type: 'text.delta', sessionId: 's1', text });
    await waitFor(() => h.sent.filter((m) => m.t === 'seg.end').length === 3);
    await h.msg('halt', { id: 2 });
    h.session.onAgentEvent({ type: 'text.delta', sessionId: 's1', text: '止めたあとの文です。' });
    t.ok('止める（id つき）: 鳴っている音を捨て、止めたあとの文は読まずに覚えておく', types(h).includes('cancel') && segs().length === 3 && h.session.state.halted === true);
    await h.msg('resume');
    t.ok('続きを読む（resume）: 止めた文（2 番目）から、止めている間に届いた文までを読み直す（first は元の文のまま）', segs().slice(3).map((x) => `${x.text}:${x.first}`).join('|') === '二つ目の文です。:false|三つ目の文です。:false|止めたあとの文です。:false' && h.session.state.halted === false, JSON.stringify(segs().slice(3)));
    await h.msg('halt');
    const k = segs().length;
    await h.msg('resume');
    t.ok('id が無い止め方（読み直した文がまだ耳に届く前）は、読み直した 3 文を最初から読み直す。前に聞き終えた文には戻らない', segs().slice(k).map((x) => x.text).join('|') === '二つ目の文です。|三つ目の文です。|止めたあとの文です。', JSON.stringify(segs().slice(k)));
    // 再生が始まる前に止めた（先読みの合成だけが進んでいた）: id が無い。耳に届いていない最初の文から読む（最後の文から読んで、前の文を飛ばさない）
    const early = harness();
    await early.hello();
    const earlySegs = () => early.sent.filter((m) => m.t === 'seg');
    for (const text of ['一つ目の文です。', '二つ目の文です。', '三つ目の文です。']) early.session.onAgentEvent({ type: 'text.delta', sessionId: 's1', text });
    await early.msg('halt');
    await early.msg('resume');
    t.ok('再生が始まる前に（id なしで）止めたら、1〜3 の全部を最初から読み直す。最初の文の first は元のまま', earlySegs().slice(3).map((x) => `${x.text}:${x.first}`).join('|') === '一つ目の文です。:true|二つ目の文です。:false|三つ目の文です。:false', JSON.stringify(earlySegs().slice(3)));
    await h.msg('resume');
    t.ok('止めていないときの resume は何もしない', segs().length === k + 3);
    await h.msg('barge', { id: 1 });
    h.session.onAgentEvent({ type: 'userMessage', sessionId: 's1' });
    const j = segs().length;
    await h.msg('resume');
    t.ok('新しい発言（userMessage）が来たら、止めた分は捨てる（resume しても読まない）', segs().length === j && h.session.state.halted === false);
  }

  // ---- まとめ待ちの［取り消す］（discard）: 話している最中の発話も結果を出さずに捨てる
  {
    const h = harness();
    await h.hello();
    h.frames(true, 8);
    await h.msg('discard');
    h.frames(false, 10);
    await sleep(60);
    t.ok('discard: 話している最中の発話は、無音が続いても final にならない（取り消した言葉の後半が届かない）', !types(h).includes('final') && !types(h).includes('partial'), JSON.stringify(types(h)));
    h.frames(true, 8); h.frames(false, 8);
    await waitFor(() => types(h).includes('final'));
    t.ok('discard のあとの声は、新しい発話（番号 2）として確定する', h.sent.find((m) => m.t === 'final')?.utt === 2);
  }

  // ---- 見る先
  {
    const h = harness();
    await h.hello({ kind: 'chat', sessionId: null });
    await h.msg('target', { target: { kind: 'chat', sessionId: 'new-session' } });
    t.ok('見る先の更新（新しい会話の id が決まった）: 受けて host へ知らせる', h.session.target?.sessionId === 'new-session' && h.target.at(-1)?.sessionId === 'new-session');
    await h.msg('target', { target: { kind: 'nonsense' } });
    t.ok('不正な見る先は無視する', h.session.target?.sessionId === 'new-session');
  }

  // ---- 限度（1 回・1 日・声が無いまま）
  {
    const h = harness({ settings: { maxCallMinutes: 1 } });
    await h.hello();
    h.advance(61_000);
    await waitFor(() => types(h).includes('limit'));
    t.ok('1 回の通話の長さの上限に達したら limit: call を送って終える', h.sent.find((m) => m.t === 'limit')?.reason === 'call' && h.closed >= 1 && !h.session.active);
    const d = harness({ settings: { dailyLimitMinutes: 10 }, today: 9 * 60 });
    await d.hello();
    d.advance(61_000);
    await waitFor(() => types(d).includes('limit'));
    t.ok('1 日の上限は、今日の使用量にこの通話の長さを足して見る（limit: daily）', d.sent.find((m) => m.t === 'limit')?.reason === 'daily');
    const idle = harness({ idleEndMs: 60_000 });
    await idle.hello();
    idle.advance(61_000);
    await waitFor(() => types(idle).includes('limit'));
    t.ok('聞き取った言葉も読み上げも無いまま放っておかれた通話は終える（limit: idle）', idle.sent.find((m) => m.t === 'limit')?.reason === 'idle');
    t.ok('通話の長さは台帳へ足す（tick ごと・終わりの端数）', h.usageAdds.some((a) => a.callSeconds > 0) && idle.usageAdds.some((a) => a.callSeconds > 0));
  }

  // ---- キーを出さない
  {
    const h = harness();
    await h.hello();
    h.frames(true, 8); h.frames(false, 8);
    await waitFor(() => types(h).includes('final'));
    h.session.onAgentEvent({ type: 'text.delta', sessionId: 's1', text: '返事です。' });
    await sleep(30);
    const everything = JSON.stringify([h.sent, h.logs, h.binary.map((b) => b.length)]);
    t.ok('キーは、画面へ送るメッセージにも、ログにも出ない', !everything.includes(KEY) && !everything.includes('sk-or'));
  }
}
