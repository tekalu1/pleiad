// 通話の区切り・送信・割り込み（承認済み 2026-10-07。docs/voice-call.md「まとめ待ち」「送信」「話して止める」）。
// 決めた入力（時刻・音量・確定の文字）で、まとめ待ちの結合・言いよどみ・末尾の規則・直列の送信・割り込みの判定・半二重への切り替え・効果音の出し分けを確かめる。
// 実機のスピーカーでの割り込みの閾値（BARGE_THRESHOLD）は、この PC のスピーカーとマイクでは確かめられない（ここは閾値を超える・超えない入力で判定だけを見る）。
import { createTurnHold, holdFor, isFillerOnly, joinText } from '../../web/voice/turn-hold.mjs';
import { createSendQueue } from '../../web/voice/send-queue.mjs';
import { createCallEngine, BARGE_MS, BARGE_THRESHOLD } from '../../web/voice/engine.mjs';
import { createSounds, shouldPlay, SOUNDS } from '../../web/voice/sounds.mjs';
import { createTranscriber } from '../../core/voice/stt.mjs';
import { normalizeVoiceSettings, TURN_HOLD_MS, turnHoldMsOf, DEFAULTS } from '../../core/voice/settings.mjs';
import { toneFrame } from '../lib/fake-openrouter.mjs';

export const name = 'voice-turns';
export const title = '通話の区切り・送信・割り込み: まとめ待ち（言いよどみの結合・末尾の規則・確定待ち）・直列の送信・話して止める（閾値・半二重への切り替え）・効果音・設定';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 2000) { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await sleep(5); } return fn(); }

class FakeContext {
  constructor() { this.currentTime = 0; this.state = 'running'; this.sampleRate = 48000; this.destination = {}; }
  async resume() {}
  async close() {}
}

export default async function (t) {
  // ---- 末尾の規則・結合（純粋）
  {
    t.ok('待つ長さ: 「、」やつなぎ語で終われば長く（×1.5）、文末（。・です・して）なら短く（×0.65）、そうでなければ基準のまま', holdFor('で、あのー、', 1200) === 1800 && holdFor('これを', 1200) === 1800
      && holdFor('見てください。', 1200) === 780 && holdFor('これを直して', 1200) === 780 && holdFor('テストの失敗', 1200) === 1200);
    t.ok('待つ長さ: 言いよどみだけ（えーと・あの）は 2 倍。0.5〜3.2 秒に収める', holdFor('えーと', 1200) === 2400 && holdFor('えっと、あのー', 700) === 1400 && holdFor('あ。', 700) === 500 && holdFor('えーと', 2000) === 3200);
    t.ok('言いよどみだけの判定: 語が全部「えーと」「あの」の類。「はい」「うん」は答えなので違う', isFillerOnly('えーと、あのー') && isFillerOnly('えーとあの') && isFillerOnly('Um, uh') && !isFillerOnly('はい') && !isFillerOnly('うん') && !isFillerOnly('あの件です'));
    t.ok('結合: 日本語は詰める・英語は空白 1 つ', joinText('で、あのー、', 'あ、なんか、') === 'で、あのー、あ、なんか、' && joinText('Hello', 'world') === 'Hello world' && joinText('', 'a') === 'a');
  }

  // ---- まとめ待ち: 言いよどみの結合（時刻を決めて流す。utt ごとに「声の終わり」「確定」の時刻）
  {
    const hold = createTurnHold({ holdMs: 1200 });
    const sends = [];
    // 声: 0.4〜1.5 秒「で、あのー、」、2.25〜2.9 秒「あ、なんか、」、3.72〜6.5 秒「この前の PR のテスト、落ちてるやつを見てほしいんだけど」
    const voice = [[400, 1500], [2250, 2900], [3720, 6500]];
    const finals = [[1500 + 1130, 1, 'で、あのー、'], [2900 + 1130, 2, 'あ、なんか、'], [6500 + 1130, 3, 'この前の PR のテスト、落ちてるやつを見てほしいんだけど']];   // [時刻, 発話の番号, 確定の文字]
    const busy = [[400, true], [1500 + 680, false], [2250, true], [2900 + 680, false], [3720, true], [6500 + 680, false]];   // 区切った（話していない）あとは、確定を待つ間 inflight で busy のまま
    let inflight = 0, speaking = false;
    for (let ms = 0; ms <= 12000; ms += 20) {
      if (voice.some(([a, b]) => ms >= a && ms < b)) hold.voice(ms);
      for (const [at, utt, text] of finals) if (ms === at - (at % 20)) { hold.final(utt, text); inflight--; }
      for (const [at, on] of busy) if (ms === at - (at % 20)) { if (on) { speaking = true; } else { speaking = false; inflight++; } }
      hold.setBusy(speaking || inflight > 0, ms);
      const r = hold.tick(ms);
      if (r?.send) sends.push([ms, r.send]);
    }
    t.ok('言いよどみ（3 回の区切り）は 1 通にまとめる。3 通に割れない', sends.length === 1 && sends[0][1] === 'で、あのー、あ、なんか、この前の PR のテスト、落ちてるやつを見てほしいんだけど', JSON.stringify(sends));
    // 最後の声 6.5 秒 + 末尾「けど」で長め（1.8 秒）= 8.3 秒、確定は 7.63 秒に出そろう
    t.ok('送る時は、最後の声から待ち時間（末尾が「けど」なので 1.8 秒）が過ぎたとき（確定が先に出そろっている）', sends[0][0] >= 8280 && sends[0][0] <= 8320, String(sends[0][0]));
  }

  // ---- まとめ待ちの細かい動き
  {
    const hold = createTurnHold({ holdMs: 1200 });
    hold.voice(1000); hold.setBusy(true, 1000);
    hold.partial(1, 'テストの');
    let v = hold.view(1100);
    t.ok('途中の文字（partial）は組み立て中の文の途中の字（弱い字）として view に出る。話している間は残りを満たしたまま', v.partial === 'テストの' && v.final === '' && v.voicing === true && v.fraction === 1);
    hold.final(1, 'テストの失敗'); hold.setBusy(false, 1200);
    v = hold.view(1000 + 600);
    t.ok('最後の声から 600ms（1.2 秒の半分）で、残りは半分（線と弧が同じ長さで減る）', v.voicing === false && Math.abs(v.fraction - 0.5) < 0.02 && v.leftMs === 600 && v.waiting === false, JSON.stringify(v));
    t.ok('待ち時間の途中は送らない', hold.tick(1000 + 1100) === null);
    hold.voice(2300);   // 声が戻った
    t.ok('声が戻ったら待ち時間は最後の声から数え直す（話が続く間は送らない）', hold.tick(1000 + 1300) === null && hold.tick(2300 + 1100) === null && hold.tick(2300 + 1200)?.send === 'テストの失敗');
    t.ok('送ったあとは空に戻る（次の発話からまた始まる）', hold.active === false && hold.view(5000).text === '' && hold.tick(9000) === null);

    // 確定の待ち: 待ち時間が過ぎても、ホストがまだ文字を出していれば送らない
    const h2 = createTurnHold({ holdMs: 700 });
    h2.voice(0); h2.setBusy(true, 0); h2.final(1, '短い話');
    t.ok('待ち時間が過ぎても、ホストが文字を出している最中（busy）は送らない。view は waiting', h2.tick(3000) === null && h2.view(3000).waiting === true);
    h2.setBusy(false, 3000);
    t.ok('確定が出そろったら（busy が閉じたら）すぐ送る', h2.tick(3000)?.send === '短い話');
    // busy が閉じないまま詰まったとき
    const h3 = createTurnHold({ holdMs: 700 });
    h3.voice(0); h3.setBusy(true, 0); h3.final(1, '詰まった');
    t.ok('busy が閉じないまま 20 秒を超えたら、出ている確定だけで送る（応答が詰まっても発言を失わない）', h3.tick(19000) === null && h3.tick(20500)?.send === '詰まった');

    // いま送る・取り消す
    const h4 = createTurnHold({ holdMs: 1200 });
    h4.voice(0); h4.final(1, 'すぐ送って');
    t.ok('［いま送る］: 待ち時間を待たずに送る', h4.tick(100) === null && (h4.sendNow(), h4.tick(120)?.send === 'すぐ送って'));
    const h5 = createTurnHold({ holdMs: 1200 });
    h5.voice(0); h5.setBusy(true, 0); h5.final(1, '待って');
    h5.sendNow();
    t.ok('［いま送る］でも、確定が出そろうまでは待つ', h5.tick(100) === null && (h5.setBusy(false, 200), h5.tick(200)?.send === '待って'));
    const h6 = createTurnHold({ holdMs: 1200 });
    h6.voice(0); h6.final(1, '間違えた');
    h6.cancel();
    t.ok('［取り消す］: 溜めた言葉を捨てる。送らない', h6.tick(5000) === null && h6.view(5000).text === '' && h6.active === false);

    // 言いよどみだけ
    const h7 = createTurnHold({ holdMs: 1200 });
    h7.voice(0); h7.final(1, 'えーと、');
    t.ok('言いよどみだけは単独で送らない。長め（2 倍）に待って、次が無ければ捨てる', h7.tick(1300) === null && h7.tick(2300) === null && h7.tick(2500)?.discard === true && h7.tick(9000) === null);
    const h8 = createTurnHold({ holdMs: 1200 });
    h8.voice(0); h8.final(1, 'えーと、'); h8.voice(2000); h8.final(2, 'このテストを見て');
    t.ok('言いよどみの次に言葉が続けば、1 通にまとまる（言いよどみを単独で送らない）', h8.tick(2000 + 1100) === null && h8.tick(2000 + 1250)?.send === 'えーと、このテストを見て');

    // 順番: 後の発話の途中の文字が、前の確定より先に届く
    const h9 = createTurnHold({ holdMs: 1200 });
    h9.voice(0); h9.setBusy(true, 0);
    h9.partial(2, 'あとの話');
    t.ok('後の発話の途中の文字が先に届いても、話した順に並べる（前の確定が来たら前に入る）', h9.view(10).text === 'あとの話' && (h9.final(1, 'まえの話。'), h9.view(10).final === 'まえの話。' && h9.view(10).partial === 'あとの話'));
    h9.final(2, 'あとの話です'); h9.setBusy(false, 20);
    t.ok('確定した順ではなく、話した順（番号順）で 1 通にする', h9.tick(5000)?.send === 'まえの話。あとの話です');
    // 捨てられた発話（雑音・失敗）
    const h10 = createTurnHold({ holdMs: 1200 });
    h10.voice(0); h10.partial(1, 'ぼそ'); h10.drop(1);
    t.ok('捨てられた発話は、途中の文字ごと消える。文字が無いまま待ち時間が過ぎたら静かに閉じる', h10.view(10).text === '' && h10.tick(1000) === null && h10.active === true && h10.tick(2000) === null && h10.active === false);
    // 取り消したあとに、認識を待っていた発話の確定が届く
    const h11 = createTurnHold({ holdMs: 1200 });
    h11.voice(0); h11.setBusy(true, 0, 1); h11.partial(1, '途中');
    h11.cancel();
    h11.final(1, '後から届いた確定'); h11.setBusy(false, 10, 1);
    t.ok('［取り消す］のあとに、認識を待っていた発話の確定が届いても送らない（取り消した時点までの番号は捨てる）', h11.tick(5000) === null && h11.view(5000).text === '' && h11.active === false);
    h11.voice(6000); h11.setBusy(true, 6000, 2); h11.final(2, '次の話'); h11.setBusy(false, 6100, 2);
    t.ok('取り消したあとの新しい発話（次の番号）は、ふつうに送る', h11.tick(6100 + 1250)?.send === '次の話');
  }

  // ---- 直列の送信
  {
    const queue = createSendQueue();
    const order = [];
    const delay = (ms, label, fail) => () => new Promise((resolve, reject) => setTimeout(() => { order.push(label); fail ? reject(new Error(label)) : resolve(label); }, ms));
    const results = await Promise.all([
      queue.push(delay(40, 'A')).catch((e) => `ng:${e.message}`),
      queue.push(delay(5, 'B', true)).catch((e) => `ng:${e.message}`),
      queue.push(delay(1, 'C')).catch((e) => `ng:${e.message}`),
    ]);
    t.ok('直列の送信: 連続した 3 通は、先の送信が遅くても話した順に 1 通ずつ（後が追い越さない）', order.join('') === 'ABC', order.join(''));
    t.ok('直列の送信: 途中の失敗は、その 1 通の失敗として返り、後ろは続く', results.join() === 'A,ng:B,C', results.join());
  }

  // ---- 設定（区切り・話して止める・効果音）
  {
    t.ok('設定の既定: 区切り 標準（1.2 秒）・話して止める オン・効果音 オフ（承認 2026-10-07）', DEFAULTS.turnHold === 'standard' && DEFAULTS.bargeIn === true && DEFAULTS.sounds === 'off' && turnHoldMsOf(DEFAULTS) === 1200);
    t.ok('区切りの長さ: 短め 0.7・標準 1.2・長め 2.0 秒。壊れた値は標準', TURN_HOLD_MS.short === 700 && TURN_HOLD_MS.long === 2000 && turnHoldMsOf({ turnHold: 'x' }) === 1200);
    t.ok('読むとき: 不正な値は既定に戻す', (() => { const s = normalizeVoiceSettings({ turnHold: 'tiny', bargeIn: 'yes', sounds: 'loud' }); return s.turnHold === 'standard' && s.bargeIn === true && s.sounds === 'off'; })());
    t.ok('書くとき: 有効な値は通り、不正な値は invalid で断る', normalizeVoiceSettings({ turnHold: 'long', bargeIn: false, sounds: 'few' }, { strict: true }).turnHold === 'long'
      && ['turnHold', 'bargeIn', 'sounds'].every((key) => { try { normalizeVoiceSettings({ [key]: 'bad' }, { strict: true }); return false; } catch (e) { return e.code === 'invalid'; } }));
  }

  // ---- 効果音の出し分け
  {
    t.ok('効果音: オフは鳴らさない・少なめは「送った」と「止めた」だけ・すべては全部', Object.keys(SOUNDS).every((n) => !shouldPlay(n, 'off'))
      && Object.keys(SOUNDS).filter((n) => shouldPlay(n, 'few')).sort().join() === 'barge,sent' && Object.keys(SOUNDS).every((n) => shouldPlay(n, 'all')));
    const made = [];
    class Osc { constructor() { this.frequency = { setValueAtTime() {}, exponentialRampToValueAtTime() {} }; } connect(x) { return x; } start() { made.push('osc'); } stop() {} }
    class Ctx { constructor() { this.currentTime = 0; this.state = 'running'; this.destination = {}; } createOscillator() { return new Osc(); } createGain() { return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect(x) { return x; } }; } async resume() {} async close() {} }
    let level = 'few', speaking = false;
    const sounds = createSounds({ level: () => level, speaking: () => speaking, AudioContextImpl: Ctx });
    t.ok('効果音: 少なめで「送った」は鳴る（1 音）・「待ち」は鳴らない', sounds.play('sent') === true && made.length === 1 && sounds.play('wait') === false);
    speaking = true;
    t.ok('効果音: 読み上げ中は鳴らさない。ただし「読み上げを止めた」音だけは鳴る', sounds.play('sent') === false && sounds.play('barge') === true);
    level = 'off';
    t.ok('効果音: オフに替えるとその場で鳴らなくなる', sounds.play('barge') === false);
    t.ok('効果音: どの音も約 200ms 以内（音の長さと明示した間の合計）', Object.values(SOUNDS).every((s) => s.seq.reduce((sum, n) => sum + n.d + (n.gap ?? 0), 0) <= 0.21));
  }

  // ---- 聞き取りの busy（まとめ待ちが「確定が出そろうまで待つ」ための材料）
  {
    const events = [];
    const client = { cooling: () => false, hasFallback: false, transcribe: async () => { await sleep(30); return { text: 'こんにちは', model: 'm', tookMs: 30, audioMs: 1000, route: 'primary', fallback: false }; } };
    const tr = createTranscriber({ client, language: 'ja', emit: (e) => events.push(e), cut: { endSilenceMs: 600, maxUtteranceMs: 30000, speculativeSilenceMs: 0 } });
    for (let i = 0; i < 4; i++) tr.push(toneFrame(false));
    for (let i = 0; i < 8; i++) tr.push(toneFrame(true));
    t.ok('busy: 声が始まったら on（確定が出るまで続く）', events.find((e) => e.type === 'busy')?.on === true);
    for (let i = 0; i < 8; i++) tr.push(toneFrame(false));
    await waitFor(() => events.some((e) => e.type === 'final'));
    await waitFor(() => events.filter((e) => e.type === 'busy').at(-1)?.on === false);
    const seq = events.filter((e) => ['busy', 'final'].includes(e.type)).map((e) => (e.type === 'busy' ? `busy:${e.on}` : 'final'));
    t.ok('busy: 区切ったあとも確定を待つ間は on のまま。確定を出してから off（確定を受けてから「まだ」が解ける）', seq.join() === 'busy:true,final,busy:false', seq.join());
    // 雑音（短い声）: drop のあとで off
    const noise = [];
    const tr2 = createTranscriber({ client, language: 'ja', emit: (e) => noise.push(e), cut: { endSilenceMs: 600, maxUtteranceMs: 30000, speculativeSilenceMs: 0 } });
    for (let i = 0; i < 2; i++) tr2.push(toneFrame(true));
    for (let i = 0; i < 9; i++) tr2.push(toneFrame(false));
    await waitFor(() => noise.some((e) => e.type === 'drop'));
    t.ok('busy: 声が短すぎて捨てられたら drop のあとに off（まとめ待ちが「まだ」のまま残らない）', noise.filter((e) => ['busy', 'drop'].includes(e.type)).map((e) => (e.type === 'busy' ? `busy:${e.on}` : 'drop')).join() === 'busy:true,drop,busy:false', JSON.stringify(noise.map((e) => e.type)));
    tr.close(); tr2.close();
  }

  // ---- 状態機械: まとめ待ち・割り込み・半二重（偽の録音・接続・再生）
  {
    let clock = 1000;
    const rig = { cap: null, link: null, player: null, ctxs: [] };
    const parts = {
      createCapture: (opts) => { rig.cap = { onFrame: opts.onFrame, async start() {}, async stop() {} }; return rig.cap; },
      createLink: (opts) => {
        rig.link = { sent: [], audio: [], onJson: opts.onJson, async connect() {}, send: (o) => rig.link.sent.push(o), sendAudio: (b) => rig.link.audio.push(b), close() {} };
        return rig.link;
      },
      createPlayer: (opts) => {
        const calls = [];
        rig.player = { calls, busyFlag: false, pos: null, onEvent: opts.onEvent, seg: (id) => calls.push(['seg', id]), chunk() {}, end() {}, fail() {},
          cancel() { calls.push(['cancel']); rig.player.busyFlag = false; rig.player.pos = null; }, position: () => rig.player.pos, busy: () => rig.player.busyFlag, level: () => 0, close() {} };
        return rig.player;
      },
    };
    class Ctx extends FakeContext { constructor() { super(); rig.ctxs.push(this); } }
    const engine = createCallEngine({ token: 'tok', now: () => clock, AudioContextImpl: Ctx, parts });
    const events = [];
    engine.subscribe((e) => events.push(e));
    const boot = async (opts, ready = {}) => {
      events.length = 0;
      const started = engine.start({ kind: 'chat', sessionId: 's1' }, opts);
      await waitFor(() => rig.link?.sent.some((m) => m.t === 'hello'));
      rig.link.onJson({ t: 'ready', rate: 24000, turnHoldMs: 1200, bargeIn: true, ...ready });
      await started;
    };
    const frame = (rms, ms = 85) => rig.cap.onFrame({ pcm: new ArrayBuffer(2730), rms, ms });
    const turns = () => events.filter((e) => e.type === 'turn');
    const J = (o) => rig.link.onJson(o);

    // まとめ待ち（言いよどみ 3 回 → 1 通）
    await boot({ echoCancellation: true });
    for (let i = 0; i < 12; i++) { clock += 85; frame(0.2); }   // 1 つ目
    J({ t: 'speaking', on: true }); J({ t: 'busy', on: true });
    J({ t: 'partial', utt: 1, text: 'で、あの' });
    t.ok('まとめ待ち（状態）: 話している間は hearing。吹き出しの材料は hold の view（組み立て中の文）', engine.state === 'hearing' && events.filter((e) => e.type === 'hold').at(-1)?.view.partial === 'で、あの');
    for (let i = 0; i < 6; i++) { clock += 85; frame(0.001); }
    J({ t: 'final', utt: 1, text: 'で、あのー、' }); J({ t: 'busy', on: false });
    t.ok('間（言いよどみ）: 「考え中」へ戻らず hold のまま。1 通目をまだ送らない', engine.state === 'hold' && turns().length === 0);
    clock += 200;
    for (let i = 0; i < 6; i++) { clock += 85; frame(0.2); }   // 2 つ目
    J({ t: 'busy', on: true });
    for (let i = 0; i < 9; i++) { clock += 85; frame(0.001); }
    J({ t: 'final', utt: 2, text: 'あ、なんか、' }); J({ t: 'busy', on: false });
    clock += 300;
    for (let i = 0; i < 20; i++) { clock += 85; frame(0.2); }   // 3 つ目
    J({ t: 'busy', on: true });
    for (let i = 0; i < 9; i++) { clock += 85; frame(0.001); }
    J({ t: 'final', utt: 3, text: '見てほしいんだ。' }); J({ t: 'busy', on: false });
    t.ok('連続した確定（3 つ）が届いても、待ち時間の間は 1 通も送らない', turns().length === 0 && engine.state === 'hold');
    for (let i = 0; i < 14; i++) { clock += 85; frame(0.001); }
    t.ok('最後の声から待ち時間（末尾が「。」で短め）が過ぎたら、3 つを 1 通にして turn を 1 回だけ出す', turns().length === 1 && turns()[0].text === 'で、あのー、あ、なんか、見てほしいんだ。', JSON.stringify(turns()));
    t.ok('送ったあとの状態: 「考え中」は noteSent のあとだけ（送る前には出ない）', engine.state === 'listening' && (engine.noteSent(true), engine.state === 'thinking'));

    // 「いま送る」「取り消す」とミュートでの確定
    for (let i = 0; i < 6; i++) { clock += 85; frame(0.2); }
    J({ t: 'busy', on: true }); J({ t: 'final', utt: 4, text: '急ぎです' }); J({ t: 'busy', on: false });
    engine.sendNow();
    t.ok('［いま送る］: 待ち時間を待たずに turn', turns().length === 2 && turns()[1].text === '急ぎです');
    for (let i = 0; i < 6; i++) { clock += 85; frame(0.2); }
    J({ t: 'busy', on: true }); J({ t: 'final', utt: 5, text: '間違い' }); J({ t: 'busy', on: false });
    engine.cancelTurn();
    clock += 5000; frame(0.001);
    t.ok('［取り消す］: 送らず、組み立て中の文を空にする', turns().length === 2 && events.filter((e) => e.type === 'hold').at(-1)?.view.text === '');
    for (let i = 0; i < 6; i++) { clock += 85; frame(0.2); }
    J({ t: 'busy', on: true }); J({ t: 'final', utt: 6, text: 'ミュートします' }); J({ t: 'busy', on: false });
    engine.setMuted(true);
    t.ok('ミュート: 溜めた言葉は、確定が出そろっていればすぐ送る（待たせたまま失わない）', turns().length === 3 && turns()[2].text === 'ミュートします');
    engine.setMuted(false);
    engine.end('user');

    // 話して止める: 閾値と時間
    const speak = (id = 7) => { rig.player.busyFlag = true; rig.player.pos = { id }; rig.player.onEvent({ type: 'segstart', id }); };
    await boot({ echoCancellation: true });
    t.ok('割り込み（準備）: 設定が入っていてエコー除去が効いていれば、読み上げ中もマイクを聞く（bargeActive）', engine.bargeActive === true);
    speak(7);
    const audio0 = rig.link.audio.length;
    for (let i = 0; i < 12; i++) { clock += 85; frame(BARGE_THRESHOLD * 0.8); }
    t.ok('割り込み: 通常の声の閾値（0.012）は超えても、読み上げ用の高い閾値（3 倍）を超えない音（スピーカーの回り込み）では止めない。送りもしない', rig.player.calls.every((c) => c[0] !== 'cancel') && rig.link.audio.length === audio0 && !rig.link.sent.some((m) => m.t === 'barge'));
    clock += 85; frame(BARGE_THRESHOLD * 2); clock += 85; frame(BARGE_THRESHOLD * 2);
    t.ok(`割り込み: 高い閾値を超える声が ${BARGE_MS}ms に満たない間（2 フレーム = 170ms）は止めない`, rig.player.calls.every((c) => c[0] !== 'cancel'));
    clock += 85; frame(0.001);
    clock += 85; frame(BARGE_THRESHOLD * 2);
    t.ok('割り込み: 途切れたあとの声は、積算が減っているので 1 フレームでは止めない', rig.player.calls.every((c) => c[0] !== 'cancel'));
    clock += 85; frame(BARGE_THRESHOLD * 2);
    clock += 85; frame(BARGE_THRESHOLD * 2);
    t.ok('割り込み: 声が 250ms（3 フレーム）続いたら読み上げを止め（cancel）、barge を鳴っていた文の番号つきで送る', rig.player.calls.some((c) => c[0] === 'cancel') && rig.link.sent.some((m) => m.t === 'barge' && m.id === 7) && events.some((e) => e.type === 'barge' && e.id === 7));
    t.ok('割り込み: 止める前に持っていた音（頭）も送る。話し始めが欠けない', rig.link.audio.length > audio0 + 2, `${rig.link.audio.length - audio0}`);
    t.ok('割り込み: そのまま聞き取りへ移る（hearing）。半二重の待ち（300ms）は挟まない', engine.state === 'hearing');
    const audio1 = rig.link.audio.length;
    clock += 85; frame(0.2);
    t.ok('割り込み: 止めたあとの声はすぐ送る', rig.link.audio.length > audio1);
    engine.end('user');

    // エコー除去が効かない・設定オフ → 半二重のまま
    for (const [label, opts, ready] of [['エコー除去がオフ', { echoCancellation: false }, {}], ['設定の「話して止める」がオフ', { echoCancellation: true }, { bargeIn: false }]]) {
      await boot(opts, ready);
      speak(3);
      t.ok(`半二重（${label}）: 読み上げ中のマイクは閉じている（bargeActive は false）`, engine.bargeActive === false);
      const before = rig.link.audio.length;
      for (let i = 0; i < 6; i++) { clock += 85; frame(0.5); }
      t.ok(`半二重（${label}）: 強い声が続いても止めず、音声も送らない（スピーカーの音を自分の発言と取り違えない）`, rig.player.calls.every((c) => c[0] !== 'cancel') && rig.link.audio.length === before && !rig.link.sent.some((m) => m.t === 'barge') && engine.state === 'speaking',
        JSON.stringify({ calls: rig.player.calls, audio: rig.link.audio.length - before, sent: rig.link.sent.map((m) => m.t), state: engine.state }));
      rig.player.busyFlag = false;
      clock += 100; frame(0.5);
      t.ok(`半二重（${label}）: 鳴り終わって 300ms 以内は送らない。過ぎたらまた聞く（700ms から短縮）`, rig.link.audio.length === before && (clock += 300, frame(0.5), frame(0.5), rig.link.audio.length > before));
      engine.end('user');
    }

    // 止めるボタン: 鳴っている文の番号を送り、halt を出す
    await boot({ echoCancellation: true });
    speak(5);
    engine.halt();
    t.ok('止めるボタン: halt に鳴っていた文の番号を載せ、止めたことを halt イベントで知らせる（続きを読むの始まり）', rig.link.sent.some((m) => m.t === 'halt' && m.id === 5) && events.some((e) => e.type === 'halt' && e.id === 5));
    engine.resume();
    t.ok('続きを読む: resume をホストへ送る', rig.link.sent.at(-1)?.t === 'resume');
    engine.end('user');
  }

  // ---- 割り込みの閾値（通常の声の 3 倍。承認済みの値）
  t.ok('割り込みの閾値: 通常（0.012）の 3 倍・250ms', Math.abs(BARGE_THRESHOLD - 0.036) < 1e-9 && BARGE_MS === 250);
}
