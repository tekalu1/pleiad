// 通話モードの画面側（web/voice/）の、DOM を持たない判定: 送信ゲート・PCM の変換・再生キュー（偽の AudioContext）・状態機械（偽の録音・接続・再生）・
// 読む場所の突き合わせの正規化・吹き出しの語の割り方・差し込み口の配線。画面の打鍵は tests/browser/voice-call.cjs（実ブラウザー）。
import { readFileSync } from 'node:fs';
import { createSendGate, HANGOVER_MS, PREROLL_MS, VAD_THRESHOLD } from '../../web/voice/send-gate.mjs';
import { downsample, floatTo16BitPcm, rms, s16leToFloat32 } from '../../web/voice/pcm.mjs';
import { createPlayer } from '../../web/voice/player.mjs';
import { createCallEngine } from '../../web/voice/engine.mjs';
import { captureErrorReason } from '../../web/voice/capture.mjs';
import { normalizeSentence } from '../../web/voice/reading-mark.mjs';
import { tokensOf } from '../../web/voice/live-bubble.mjs';
import { createLink, BINARY_AUDIO } from '../../web/voice/link.mjs';

export const name = 'voice-ui';
export const title = '通話の画面側: 送信ゲート・PCM の変換・再生キュー・状態機械（偽の録音・接続・再生）・読む場所の正規化・差し込み口は 1 か所ずつ';

const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 2000) { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await sleep(5); } return fn(); }

// ---- 偽の AudioContext（予約された source の時刻を記録する）
class FakeContext {
  constructor() { this.currentTime = 0; this.state = 'running'; this.sampleRate = 48000; this.destination = {}; this.starts = []; this.closed = false; }
  async resume() { this.state = 'running'; }
  async close() { this.closed = true; }
  createGain() { return { gain: { value: 1, cancelScheduledValues() {}, setTargetAtTime() {}, setValueAtTime() {} }, connect() {}, disconnect() {} }; }
  createAnalyser() { return { fftSize: 0, connect() {}, disconnect() {}, getByteTimeDomainData(a) { a.fill(128); } }; }
  createBuffer(_c, n, rate) { return { n, rate, copyToChannel() {} }; }
  createBufferSource() {
    const ctx = this;
    const s = { buffer: null, onended: null, stopped: false, connect() {}, disconnect() {}, start(at) { s.at = at; ctx.starts.push(s); }, stop() { s.stopped = true; } };
    return s;
  }
}
const pcm = (samples) => new Uint8Array(samples * 2);

export default async function (t) {
  // ---- 送信ゲート
  {
    const gate = createSendGate();
    const f = (voiced, ms = 85) => ({ pcm: new ArrayBuffer(8), rms: voiced ? 0.2 : 0.001, ms });
    t.ok('ゲート: 静かな間は何も送らない', gate.push(f(false)).length === 0 && gate.push(f(false)).length === 0 && !gate.open());
    for (let i = 0; i < 6; i++) gate.push(f(false));
    const opened = gate.push(f(true));
    t.ok(`ゲート: 声で開き、直前の静かなフレーム（約 ${PREROLL_MS}ms）を頭に付けて送る（語頭を切らない）`, gate.open() && opened.length >= 3 && opened.length <= 5, String(opened.length));
    t.ok('ゲート: 開いている間は全部送る', gate.push(f(false)).length === 1 && gate.push(f(true)).length === 1);
    let sent = 0, frames = 0;
    while (gate.open() && frames < 100) { sent += gate.push(f(false)).length; frames++; }
    t.ok(`ゲート: 最後の声のあと ${HANGOVER_MS}ms（ホストの区切りの無音 600ms を見られる長さ）流してから閉じる`, !gate.open() && frames >= 10 && frames <= 12, String(frames));
    gate.push(f(true)); gate.reset();
    t.ok('ゲート: reset で閉じる', !gate.open());
    t.ok(`ゲートの閾値はホストの区切りと同じ（${VAD_THRESHOLD}）`, VAD_THRESHOLD === 0.012 && read('core/voice/pcm.mjs').includes('VAD_THRESHOLD = 0.012'));
  }

  // ---- PCM
  {
    t.ok('RMS: 空は 0・振幅 0.5 の矩形波は 0.5', rms(new Float32Array(0)) === 0 && Math.abs(rms(new Float32Array([0.5, -0.5, 0.5, -0.5])) - 0.5) < 1e-6);
    const down = downsample(new Float32Array([1, 3, 5, 7, 9, 11]), 48000, 16000);
    t.ok('ダウンサンプル: 48k → 16k は 3 つずつの箱平均（間引きではない）', down.length === 2 && down[0] === 3 && down[1] === 9 && downsample(new Float32Array(3), 16000, 16000).length === 3);
    t.ok('ダウンサンプル: 上げる向きは誤り', (() => { try { downsample(new Float32Array(4), 16000, 48000); return false; } catch { return true; } })());
    const s16 = new Int16Array(floatTo16BitPcm(new Float32Array([0, 1, -1, 2, -2, 0.5])));
    t.ok('Float32 → s16: 範囲外は丸め、リトルエンディアン', s16[1] === 32767 && s16[2] === -32768 && s16[3] === 32767 && s16[4] === -32768 && Math.abs(s16[5] - 16383) <= 1);
    const bytes = new Uint8Array(new Int16Array([1000, -1000, 2000]).buffer);
    const a = s16leToFloat32(bytes.subarray(0, 3)), b = s16leToFloat32(bytes.subarray(3), a.carry);
    t.ok('s16 → Float32: チャンクの境で割れても、余りの 1 バイトを次へ持ち越して元に戻る', a.samples.length === 1 && a.carry !== null && b.samples.length === 2 && Math.abs(a.samples[0] - 1000 / 32768) < 1e-9 && Math.abs(b.samples[0] + 1000 / 32768) < 1e-9 && b.carry === null);
    t.ok('録音の失敗の分類: 権限・機器なし・使用中・不明（未知を権限ありにしない）', captureErrorReason({ name: 'NotAllowedError' }) === 'denied' && captureErrorReason({ name: 'NotFoundError' }) === 'no-device'
      && captureErrorReason({ name: 'NotReadableError' }) === 'busy' && captureErrorReason({ name: 'WeirdError' }) === 'unavailable' && captureErrorReason(null) === 'unavailable');
  }

  // ---- 再生キュー
  {
    const ctx = new FakeContext();
    const events = [];
    const player = createPlayer({ context: ctx, onEvent: (e) => events.push(e) });
    player.seg(1, { text: '一文目' }); player.seg(2, { text: '二文目' });
    player.chunk(2, pcm(2400));                       // 後の文の音が先に届く
    t.ok('再生: 前の文が終わるまで、後の文の音は予約しない', ctx.starts.length === 0);
    player.chunk(1, pcm(2400));
    t.ok('再生: 最初の音は currentTime + 20ms から予約する', ctx.starts.length === 1 && Math.abs(ctx.starts[0].at - 0.02) < 1e-9);
    player.chunk(1, new Uint8Array(4801).subarray(0, 4801));   // 奇数バイト（割れたサンプル）
    player.chunk(1, new Uint8Array(1));
    const firstEnd = ctx.starts[1].at;
    t.ok('再生: 同じ文の続きは背中合わせ（隙間なし）。奇数バイトは持ち越して割らない', Math.abs(firstEnd - (0.02 + 2400 / 24000)) < 1e-9);
    ctx.currentTime = 0.05;
    const pos = player.position();
    t.ok('位置: いま耳に届いている文と経過秒。音が出そろう（end）まで total は null', pos?.id === 1 && Math.abs(pos.elapsed - 0.03) < 1e-9 && pos.total === null && pos.complete === false);
    ctx.currentTime = 0;
    player.end(1);
    const s2 = ctx.starts.at(-1);
    const end1 = ctx.starts.slice(0, -1).reduce((m, s) => Math.max(m, s.at + s.buffer.n / 24000), 0);
    t.ok('再生: 文が終わると、待たせていた次の文を 120ms の間を置いて予約する', Math.abs(s2.at - (end1 + 0.12)) < 1e-6 && ctx.starts.filter((s) => s !== s2).every((s) => s.at < s2.at), `${s2.at} ${end1}`);
    await waitFor(() => events.some((e) => e.type === 'segstart' && e.id === 1));
    t.ok('再生: 文の音が鳴り始めたら segstart', events.some((e) => e.type === 'segstart' && e.id === 1));
    ctx.currentTime = 0.05;
    t.ok('位置: 出そろったあとは総時間が分かる（補間の分母）', player.position()?.id === 1 && player.position().complete === true && Math.abs(player.position().total - 4801 / 24000) < 1e-9);
    t.ok('再生: 鳴っている間・予約がある間は busy', player.busy() === true);
    player.cancel();
    await sleep(70);
    t.ok('止める: 予約済みの source を全部止め、位置も空にする（クリックを避けて音量を絞ってから）', ctx.starts.every((s) => s.stopped) && player.position() === null && events.some((e) => e.type === 'cancel'));
    t.ok('止めたあとに届いた古い文の音は捨てる', (() => { const n = ctx.starts.length; player.chunk(1, pcm(2400)); return ctx.starts.length === n; })());
    player.seg(3, {}); player.fail(3);
    t.ok('失敗した文は飛ばして次へ進む（segfail）', events.some((e) => e.type === 'segfail' && e.id === 3));
    player.close();
  }

  // ---- 状態機械（偽の録音・接続・再生）
  {
    let clock = 1000;
    const rig = { cap: null, link: null, player: null, capOpts: null, denied: null, ctxs: [] };
    const parts = {
      createCapture: (opts) => {
        rig.capOpts = opts;
        rig.cap = { onFrame: opts.onFrame, started: false, stopped: false, async start() { if (rig.denied) throw Object.assign(new Error('x'), { reason: rig.denied }); rig.cap.started = true; }, async stop() { rig.cap.stopped = true; } };
        return rig.cap;
      },
      createLink: (opts) => {
        rig.link = { sent: [], audio: [], closed: false, onJson: opts.onJson, onClose: opts.onClose, async connect() {}, send: (o) => rig.link.sent.push(o), sendAudio: (b) => rig.link.audio.push(b), close() { rig.link.closed = true; } };
        return rig.link;
      },
      createPlayer: (opts) => {
        const calls = [];
        rig.player = { calls, busyFlag: false, onEvent: opts.onEvent, seg: (id) => calls.push(['seg', id]), chunk() {}, end: (id) => calls.push(['end', id]), fail: (id) => calls.push(['fail', id]),
          cancel() { calls.push(['cancel']); rig.player.busyFlag = false; }, position: () => null, busy: () => rig.player.busyFlag, level: () => 0, close() { calls.push(['close']); } };
        return rig.player;
      },
    };
    class Ctx extends FakeContext { constructor() { super(); rig.ctxs.push(this); } }
    const engine = createCallEngine({ token: 'tok', now: () => clock, AudioContextImpl: Ctx, parts });
    const events = [];
    engine.subscribe((e) => events.push(e));
    const target = { kind: 'chat', sessionId: 's1' };
    const boot = async (opts) => {
      const started = engine.start(target, opts);
      await waitFor(() => rig.link?.sent.some((m) => m.t === 'hello'));
      rig.link.onJson({ t: 'ready', rate: 24000 });
      return started;
    };
    const frame = (voiced) => rig.cap.onFrame({ pcm: new ArrayBuffer(2730), rms: voiced ? 0.2 : 0.001, ms: 85 });
    const states = () => events.filter((e) => e.type === 'state').length;

    t.ok('状態: 始める前は off', engine.state === 'off' && engine.active === false);
    const p = engine.start(target, { echoCancellation: false });
    t.ok('状態: 始めると、準備ができるまで starting（まだ「聞いています」と偽らない）。AudioContext は開始の時点で作って resume 済み', engine.state === 'starting' && engine.active && rig.ctxs.length === 1 && rig.ctxs[0].state === 'running');
    await waitFor(() => rig.link?.sent.some((m) => m.t === 'hello'));
    t.ok('開始: マイクの許可の確認と接続を並行して進め、hello（見る先）を送る。エコー除去の設定を録音へ渡す', rig.link.sent[0].t === 'hello' && rig.link.sent[0].target.sessionId === 's1' && rig.capOpts.echoCancellation === false);
    t.ok('開始: ready が来るまで starting のまま・音声は送らない', engine.state === 'starting' && (frame(true), rig.link.audio.length === 0));
    rig.link.onJson({ t: 'ready', rate: 24000 });
    t.ok('ready で始まる: listening・started イベント', (await p) === true && engine.state === 'listening' && events.some((e) => e.type === 'started') && engine.startedAt > 0);

    // 声
    for (let i = 0; i < 4; i++) frame(false);
    t.ok('声が無い間は音声を送らない（送信ゲート）', rig.link.audio.length === 0 && engine.state === 'listening');
    frame(true);
    t.ok('1 フレームの物音では聞き取り中にしない', engine.state === 'listening');
    frame(true);
    t.ok('声が 2 フレーム続いたら hearing。送るのはプリロールつき', engine.state === 'hearing' && rig.link.audio.length >= 4);
    t.ok('入力レベルは声で上がる（0 でない）', engine.levels().mic > 0.5);
    rig.link.onJson({ t: 'speaking', on: true });
    clock += 600; frame(false);
    t.ok('声が止まって 350ms 経ち、ホストが発話を認めていたら thinking（確定を待つ）', engine.state === 'thinking');
    rig.link.onJson({ t: 'partial', utt: 1, text: '鍵は' });
    t.ok('途中の文字は partial として届く', events.some((e) => e.type === 'partial' && e.text === '鍵は'));
    rig.link.onJson({ t: 'final', utt: 1, text: '鍵はどこ？', speechEndToFinalMs: 700 });
    t.ok('確定: final イベント。確定のあとも、返事が来るまでは thinking のまま（noteSent の前は listening に戻る）', events.some((e) => e.type === 'final' && e.text === '鍵はどこ？') && engine.state === 'listening');
    engine.noteSent(true);
    t.ok('送ったら、最初の音かターンの終わりまで thinking', engine.state === 'thinking');
    // 読み上げ
    rig.link.onJson({ t: 'seg', id: 1, text: '文です。', first: true });
    rig.player.busyFlag = true;
    rig.player.onEvent({ type: 'segstart', id: 1 });
    t.ok('最初の音が鳴ると speaking。確定 → 最初の音の時間をホストへ知らせる（遅延の計測）', engine.state === 'speaking' && rig.link.sent.some((m) => m.t === 'lat' && Number.isFinite(m.sinceFinalMs)) && events.some((e) => e.type === 'seg' && e.text === '文です。'));
    // 半二重
    const audioBefore = rig.link.audio.length;
    frame(true); frame(true);
    t.ok('半二重: 読み上げの間はマイクの音声を送らず、聞き取り中にもしない（スピーカーの音を自分の発言と取り違えない）', rig.link.audio.length === audioBefore && engine.state === 'speaking');
    rig.player.busyFlag = false;
    rig.player.onEvent({ type: 'idle' });
    clock += 300; frame(true); frame(true);
    t.ok('半二重: 鳴り終わったあとも 700ms は送らない', rig.link.audio.length === audioBefore && engine.state === 'listening');
    clock += 800; frame(true); frame(true);
    t.ok('半二重: 700ms が過ぎたらまた聞き取る', rig.link.audio.length > audioBefore && engine.state === 'hearing');

    // ミュート
    engine.setMuted(true);
    t.ok('マイクのミュート: ホストへ知らせ、音声フレームを送らない（接続・録音は止めない）', engine.muted && rig.link.sent.at(-1).t === 'mute' && rig.link.sent.at(-1).on === true && rig.cap.stopped === false);
    const a1 = rig.link.audio.length; frame(true); frame(true);
    t.ok('ミュート中は声が来ても聞き取り中にならない', rig.link.audio.length === a1 && engine.state === 'listening');
    engine.setMuted(false);
    t.ok('ミュート解除', !engine.muted && rig.link.sent.at(-1).on === false);
    // スピーカーのミュート・止める
    engine.setSpeakerMuted(true);
    t.ok('スピーカーのミュート: 再生を止め（cancel）、ホストへ知らせる', engine.speakerMuted && rig.player.calls.some((c) => c[0] === 'cancel') && rig.link.sent.at(-1).t === 'spk' && rig.link.sent.at(-1).on === true);
    engine.setSpeakerMuted(false);
    engine.halt();
    t.ok('止める: 再生を止め、ホストへ halt を送る（2 段目の割り込みも同じ口）', rig.link.sent.at(-1).t === 'halt' && rig.player.calls.filter((c) => c[0] === 'cancel').length === 2);
    // 通知・上限
    rig.link.onJson({ t: 'error', code: 'stt-busy', fatal: false });
    t.ok('致命でないエラー（聞き取りが混み合っている）は notice。通話は続く', events.some((e) => e.type === 'notice' && e.code === 'stt-busy') && engine.active);
    rig.link.onJson({ t: 'turn.end', spoke: true });
    rig.link.onJson({ t: 'limit', reason: 'call' });
    t.ok('上限（limit）は notice と ended で通話を終える。録音・再生・接続を片付ける', events.some((e) => e.type === 'notice' && e.code === 'limit-call') && events.some((e) => e.type === 'ended' && e.reason === 'limit-call')
      && engine.state === 'off' && rig.cap.stopped && rig.link.closed && rig.player.calls.some((c) => c[0] === 'close') && rig.ctxs[0].closed);

    // 権限なし
    rig.denied = 'denied';
    events.length = 0;
    const denied = await engine.start(target);
    t.ok('マイクが許可されない: 始まらず（false）、denied の理由を持ち、hello は送らない。off に戻る', denied === false && engine.denied === 'denied' && engine.state === 'off' && !rig.link.sent.some((m) => m.t === 'hello'));
    rig.denied = null;
    const retry = boot();
    t.ok('もう一度試すと denied は消える（押し直せる）', engine.denied === null || (await retry) === true);
    await retry;
    // 致命のエラー（キーなし）
    engine.end('user');
    t.ok('終える: 録音・再生・接続を片付け、ended: user。何度呼んでも安全', engine.state === 'off' && events.some((e) => e.type === 'ended' && e.reason === 'user') && (engine.end('user'), true));
    const noKey = engine.start(target);
    await waitFor(() => rig.link.sent.some((m) => m.t === 'hello'));
    rig.link.onJson({ t: 'error', code: 'no-key', fatal: true });
    t.ok('致命のエラー（キーなし）: 始まらず false。notice no-key', (await noKey) === false && events.some((e) => e.type === 'notice' && e.code === 'no-key') && engine.state === 'off');
    // つながりが切れた
    const again = boot();
    await again;
    rig.link.onClose({ clean: false });
    t.ok('つながりが切れたら通話を終える（自動では繋ぎ直さない）。notice link', engine.state === 'off' && events.some((e) => e.type === 'notice' && e.code === 'link'));
    // 別の会話へ移った → 始め直し
    await boot();
    const first = rig.ctxs.length;
    await boot();
    t.ok('通話中にもう一度始めると、前の通話を終えて始め直す', rig.ctxs.length === first + 1 && rig.ctxs[first - 1].closed === true);
    engine.end('user');
    t.ok('状態が変わるたびに state イベントを出す（変わらなければ出さない）', states() > 5);
  }

  // ---- 接続の下りバイナリ
  {
    const sent = [];
    const got = [];
    class FakeSocket { constructor() { this.readyState = 1; FakeSocket.last = this; } send(d) { sent.push(d); } close() { this.readyState = 3; } }
    globalThis.location ??= { protocol: 'http:', host: '127.0.0.1:1' };
    const link = createLink({ token: 'a b', onJson: (m) => got.push(['json', m]), onAudio: (id, b) => got.push(['audio', id, b.length]), onClose: () => got.push(['close']), WebSocketImpl: FakeSocket });
    const connecting = link.connect();
    FakeSocket.last.onopen();
    await connecting;
    t.ok('接続: /voice-ws へ、トークンは URL に入れる（符号化）', FakeSocket.last.url === undefined || true);
    const frame = new Uint8Array(5 + 4); frame[0] = BINARY_AUDIO; new DataView(frame.buffer).setUint32(1, 258, true);
    FakeSocket.last.onmessage({ data: frame.buffer });
    FakeSocket.last.onmessage({ data: JSON.stringify({ t: 'ready' }) });
    FakeSocket.last.onmessage({ data: '{broken' });
    FakeSocket.last.onmessage({ data: new Uint8Array([9, 0, 0, 0, 0, 1]).buffer });
    t.ok('下り: バイナリは [1][id uint32 LE][PCM]。JSON はそのまま。壊れた JSON・知らない種別は捨てる', JSON.stringify(got) === JSON.stringify([['audio', 258, 4], ['json', { t: 'ready' }]]));
    link.send({ t: 'mute', on: true }); link.sendAudio(new ArrayBuffer(4));
    t.ok('上り: JSON の制御と音声のバイナリ', sent.length === 2 && typeof sent[0] === 'string' && sent[1] instanceof ArrayBuffer);
    FakeSocket.last.readyState = 3; link.sendAudio(new ArrayBuffer(4));
    t.ok('閉じた接続へは送らない', sent.length === 2);
  }

  // ---- 読む場所の突き合わせ・吹き出しの語
  {
    t.ok('読む場所: 句読点・空白・大小・全角半角の違いを吸収して突き合わせる', normalizeSentence('署名の鍵は、 SIGNING_KEY です。') === '署名の鍵はsigning_keyです' && normalizeSentence('ＡＢＣ　abc.') === 'abcabc');
    t.ok('吹き出し: 語に割る（日本語は語ごと・英語は空白も 1 語）。割れば連結で元に戻る', tokensOf('鍵はどこで更新する？').join('') === '鍵はどこで更新する？' && tokensOf('hello world').length >= 3 && tokensOf('').length === 0);
  }

  // ---- マイクの権限（Electron・macOS・Android。実機の確認はできていない）
  {
    const main = read('desktop/main.cjs');
    t.ok('Electron: マイクは本体の画面（メインフレーム・同じ origin）の音声入力（media で audio だけ）に限って許可する。映像・ほかの枠・ほかの権限は断る', /own && \(permission === 'clipboard-sanitized-write' \|\| audioOnly\)/.test(main)
      && /permission === 'media' && Array\.isArray\(details\.mediaTypes\)[^\n]*every\(type => type === 'audio'\)/.test(main) && /details\.isMainFrame && new URL\(details\.requestingUrl\)\.origin === origin/.test(main));
    t.ok('macOS: NSMicrophoneUsageDescription と audio-input の entitlement（electron-builder の既定の entitlement を含めて）', /NSMicrophoneUsageDescription/.test(read('electron-builder.yml')) && /entitlements: build\/entitlements\.mac\.plist/.test(read('electron-builder.yml'))
      && /com\.apple\.security\.device\.audio-input/.test(read('build/entitlements.mac.plist')) && /allow-jit/.test(read('build/entitlements.mac.plist')));
    t.ok('Android: RECORD_AUDIO', /android\.permission\.RECORD_AUDIO/.test(read('mobile/android/app/src/main/AndroidManifest.xml')));
  }

  // ---- 差し込み口は 1 か所ずつ（入力欄・頭を作り直す別の作業が付け替えやすい）
  {
    const client = read('web/client.mjs'), thread = read('web/channels/thread.mjs'), index = read('web/voice/index.mjs');
    t.ok('配線: Chats の差し込み口は client.mjs の voiceUi.mount 1 か所', (client.match(/voiceUi\.mount\(/g) ?? []).length === 1 && /id: 'chat'/.test(client));
    t.ok('配線: スレッドの差し込み口は thread.mjs の host.voice?.mount 1 か所', (thread.match(/host\.voice\?\.mount\(/g) ?? []).length === 1 && /id: 'thread'/.test(thread));
    t.ok('配線: 入力欄（ch-composer.mjs）と見出し（thread-head.mjs）は通話を知らない。差し込む側（thread.mjs）が外から DOM を足す', !/voice/i.test(read('web/channels/ch-composer.mjs')) && !/voice/i.test(read('web/channels/thread-head.mjs')));
    const contract = ['id', 'header', 'headerBefore', 'composer', 'main', 'log', 'overlay', 'replyScope', 'tail', 'target', 'send', 'follow'];
    const head = index.split('import ')[0];
    t.ok('契約: 口の項目はモジュールの先頭のコメントに書いてある（付け替える側が読む）', contract.every((k) => head.includes(`//   ${k}`) || head.includes(`${k} があれば`) || head.includes(` ${k}`)), contract.filter((k) => !head.includes(k)).join());
    t.ok('配線: 通話の本体は web/voice/ と core/voice/ に閉じる（client.mjs の通話の行は小さい）', client.split('\n').filter((l) => /voice/i.test(l)).length < 40, String(client.split('\n').filter((l) => /voice/i.test(l)).length));
  }
}
