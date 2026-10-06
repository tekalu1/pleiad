// 通話モードの中核（core/voice/）の純粋な部分: PCM の道具・発話の区切りと片と投機・片の重なりの除去・設定の検査・使用量の台帳。
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createEvenChunker, createLeadingSilenceTrimmer, durationMsOfS16, rmsOfS16, wavFromS16 } from '../../core/voice/pcm.mjs';
import { createUtteranceCutter, DEFAULT_CUT, MIN_VOICED_MS, TAIL_KEEP_MS } from '../../core/voice/cutter.mjs';
import { cleanPieceText, joinPiece, removeOverlap } from '../../core/voice/piece-text.mjs';
import { DEFAULTS, languageOf, loosensLimits, normalizeVoiceSettings, VoiceSettingsError } from '../../core/voice/settings.mjs';
import { createVoiceUsage, KEEP_DAYS } from '../../core/voice/usage.mjs';
import { toneFrame } from '../lib/fake-openrouter.mjs';

export const name = 'voice-core';
export const title = '通話モードの中核: PCM・WAV・区切り（無音・短い声・投機・片）・片の重なりの除去・設定の検査・使用量の台帳';

const feed = (cutter, voiced, count) => {
  const out = [];
  for (let i = 0; i < count; i++) { const r = cutter.push(toneFrame(voiced)); if (r) out.push(r); }
  return out;
};

export default async function (t) {
  // ---- PCM
  {
    const loud = toneFrame(true), quiet = toneFrame(false);
    t.ok('RMS: 声は閾値（0.012）を超え、無音は 0', rmsOfS16(loud) > 0.12 && rmsOfS16(quiet) === 0);
    t.ok('長さ: 1365 サンプル @16kHz は約 85.3ms', Math.abs(durationMsOfS16(loud, 16000) - 85.3125) < 0.01);
    const wav = wavFromS16(new Uint8Array(3200), 16000);
    const dv = new DataView(wav.buffer);
    t.ok('WAV: RIFF/WAVE ヘッダ・16kHz・モノラル・16bit・データ長', String.fromCharCode(...wav.subarray(0, 4)) === 'RIFF' && String.fromCharCode(...wav.subarray(8, 12)) === 'WAVE'
      && dv.getUint32(24, true) === 16000 && dv.getUint16(22, true) === 1 && dv.getUint16(34, true) === 16 && dv.getUint32(40, true) === 3200 && wav.length === 3244);
    t.ok('WAV: 奇数バイトのデータは偶数に切る', wavFromS16(new Uint8Array(7), 16000).length === 44 + 6);
    const even = createEvenChunker();
    const a = even(Uint8Array.of(1, 2, 3)), b = even(Uint8Array.of(4, 5));
    t.ok('奇数バイトの持ち越し: 境でサンプルを割らず、次のチャンクの頭へ回す', a.length === 2 && b.length === 2 && b[0] === 3 && b[1] === 4);
    // 先頭の無音を詰める（声の 80ms 前まで）。声が来ない応答はそのまま流す
    const rate = 24000, sil = (ms) => new Uint8Array(Math.floor(rate * ms / 1000) * 2);
    const voice = new Uint8Array(rate * 2 / 10);
    for (let i = 0; i < voice.length; i += 2) new DataView(voice.buffer).setInt16(i, 8000, true);
    const trim = createLeadingSilenceTrimmer(rate);
    const flushed = [trim.push(sil(200)), trim.push(voice)];
    t.ok('先頭の無音: 200ms の無音を詰め、声の 80ms 前から流す', flushed[0].length === 0 && flushed[1].length === (rate * 0.08 + rate * 0.1) * 2 && Math.abs(trim.trimmedMs() - 120) <= 1, `${flushed[1].length} ${trim.trimmedMs()}`);
    const hush = createLeadingSilenceTrimmer(rate);
    hush.push(sil(100));
    t.ok('先頭の無音: 声が一度も来なかった応答は finish でそのまま流す（失敗に変えない）', hush.finish().length > 0);
    const long = createLeadingSilenceTrimmer(rate);
    const out = long.push(sil(700));
    t.ok('先頭の無音: 600ms を超える無音は詰め物ではなく意図した間なのでそのまま流す', out.length === sil(700).length);
  }

  // ---- 区切り
  {
    const cut = () => createUtteranceCutter({ ...DEFAULT_CUT, pieces: undefined }, 16000);
    let c = cut();
    feed(c, false, 4);
    const res = [...feed(c, true, 8), ...feed(c, false, 8)];
    const utt = res.find((r) => r.kind === 'utterance')?.utterance;
    t.ok('発話: 声のあと無音 600ms（8 フレーム）で区切る。前の無音（プリロール）と後ろの無音（200ms）を付ける', utt && utt.reason === 'silence' && Math.abs(utt.voicedMs - 8 * 85.3125) < 1
      && utt.pcm.length > 8 * 2730 && utt.pcm.length <= (8 + 4 + 3) * 2730, utt ? `${utt.pcm.length} ${utt.voicedMs}` : 'no utterance');
    t.ok('発話: 区切ったあとは話していない', !c.speaking());
    c = cut();
    const dropped = [...feed(c, true, 2), ...feed(c, false, 8)].find((r) => r.kind === 'dropped');
    t.ok(`声が ${MIN_VOICED_MS}ms に届かない発話（咳・物音）は送らず捨てる`, dropped && dropped.voicedMs < MIN_VOICED_MS);
    c = cut();
    const long = feed(c, true, 190).find((r) => r.kind === 'utterance');
    t.ok('最長 15 秒で区切る（reason: max）', long?.utterance.reason === 'max' && long.utterance.pcm.length <= 15500 * 32);
    c = cut();
    feed(c, true, 5);
    const finished = c.finish();
    t.ok('finish: 声の途中でも今の発話を終わらせる（reason: finish）', finished?.kind === 'utterance' && finished.utterance.reason === 'finish' && c.finish() === null);
  }

  // ---- 投機
  {
    const c = createUtteranceCutter({ ...DEFAULT_CUT, pieces: undefined }, 16000);
    feed(c, true, 6);
    feed(c, false, 3);
    t.ok('投機: 無音が 300ms に届く前は見本を作らない', c.speculate() === null);
    feed(c, false, 1);
    const sample = c.speculate();
    t.ok('投機: 無音が 341ms（4 フレーム）に届いたら、区切ったときと同じ音声の見本を 1 回だけ作る', sample?.reason === 'speculative' && sample.speculationId === 1 && c.speculate() === null && c.speculationId() === 1);
    const done = feed(c, false, 4).find((r) => r.kind === 'utterance')?.utterance;
    t.ok('投機: 声が戻らなければ、区切った発話は見本と同じ音声（speculationId が一致し、バイトも同じ）', done?.speculationId === 1 && Buffer.compare(Buffer.from(done.pcm), Buffer.from(sample.pcm)) === 0);
    const c2 = createUtteranceCutter({ ...DEFAULT_CUT, pieces: undefined }, 16000);
    feed(c2, true, 6); feed(c2, false, 4);
    const first = c2.speculate();
    feed(c2, true, 1);
    t.ok('投機: 声が戻ったら見本は無効（speculationId が null に戻る）', first && c2.speculationId() === null);
    feed(c2, false, 4);
    const again = c2.speculate();
    t.ok('投機: 次の無音でまた 1 回作る（id は新しい）', again && again.speculationId === 2);
    const used = feed(c2, false, 4).find((r) => r.kind === 'utterance')?.utterance;
    t.ok('投機: 声が戻ったあとに区切った発話は、古い見本の id を持たない', used?.speculationId === 2 && used.voicedMs > first.voicedMs);
    t.ok(`投機: 後ろの無音を ${TAIL_KEEP_MS}ms に満たない設定で先に送らない（区切りと音声が食い違わない）`, (() => {
      const c3 = createUtteranceCutter({ ...DEFAULT_CUT, speculativeSilenceMs: 100, pieces: undefined }, 16000);
      feed(c3, true, 6); feed(c3, false, 2);
      return c3.speculate() === null;
    })());
  }

  // ---- 片
  {
    const c = createUtteranceCutter(DEFAULT_CUT, 16000);
    const r1 = [...feed(c, true, 14), ...feed(c, false, 2)].filter((r) => r.kind === 'piece');
    t.ok('片: 声の頭から 1.0 秒を超えたあと無音 171ms（息継ぎ）で切る。最初の片は直前の音声を付けない', r1.length === 1 && r1[0].piece.end === 'breath' && r1[0].piece.index === 0 && r1[0].piece.contextMs === 0);
    const r2 = [...feed(c, true, 14), ...feed(c, false, 2)].filter((r) => r.kind === 'piece');
    t.ok('片: 2 つ目の片は頭に直前の音声（最大 2 秒）を付ける。付けた長さを contextMs で持つ', r2.length === 1 && r2[0].piece.index === 1 && r2[0].piece.contextMs > 1000 && r2[0].piece.contextMs <= 2000
      && r2[0].piece.pcm.length > 14 * 2730, r2[0] ? String(r2[0].piece.contextMs) : 'none');
    const tail = feed(c, false, 8).find((r) => r.kind === 'utterance');
    t.ok('片: 息継ぎで切ったあとも発話は続き、無音が続けば発話全体として区切る', tail?.utterance.reason === 'silence');
    const forced = feed(createUtteranceCutter(DEFAULT_CUT, 16000), true, 40).filter((r) => r.kind === 'piece');
    t.ok('片: 息継ぎが来ないまま 2.5 秒に届いたら強制で切る（end: forced）', forced.length >= 1 && forced[0].piece.end === 'forced');
    const short = createUtteranceCutter(DEFAULT_CUT, 16000);
    const noPiece = [...feed(short, true, 6), ...feed(short, false, 2)].filter((r) => r.kind === 'piece');
    t.ok('片: 声の頭から 1.0 秒に届かない短い発話は片を作らない', noPiece.length === 0);
    const off = createUtteranceCutter({ ...DEFAULT_CUT, pieces: { ...DEFAULT_CUT.pieces, minMs: 0 } }, 16000);
    t.ok('片: minMs が 0 なら片を作らない', feed(off, true, 40).every((r) => r.kind !== 'piece'));
  }

  // ---- 片の重なりの除去
  {
    const lang = 'ja';
    const ok = removeOverlap('鍵はどこで', 'どこで更新する', 2000, lang);
    t.ok('重なり: 前の片の末尾と返った文字の頭が重なる分を除く', ok.ok && ok.text === '更新する' && ok.overlapChars === 3, JSON.stringify(ok));
    t.ok('重なり: 句読点・空白・大小の違いは無視して突き合わせる', removeOverlap('今日は、晴れです。', '晴れですね、明日は', 2000, lang).text === 'ね、明日は');
    t.ok('重なり: 付けていない（contextMs が 0）・前の文字が無いときは全部使う', removeOverlap('はい', 'ええ', 0, lang).text === 'ええ' && removeOverlap('', 'ええ', 2000, lang).text === 'ええ');
    t.ok('重なり: 見つからなければ ok: false（二重に読むより、その発話の途中経過をあきらめる）', removeOverlap('こんにちは', 'まったく別の言葉です', 2000, lang).ok === false);
    t.ok('重なり: 返った文字が空（無音）なら空を返す', removeOverlap('こんにちは', '。', 2000, lang).text === '');
    t.ok('重なり: 前の文字が 2 字以下なら、全部が一致したときだけ重なりと見なす', removeOverlap('はい', 'はいそうですね', 2000, lang).text === 'そうですね' && removeOverlap('はい', 'ええそうですね', 2000, lang).ok === false);
    t.ok('足し方: 日本語は詰める・英語は空白を 1 つ挟む', joinPiece('こんにちは', '今日は', 'ja') === '今日は' && joinPiece('hello', 'everyone', 'en') === ' everyone');
    t.ok('足し方: 前が句読点で終わり、足す分も句読点で始まるなら足す分の頭の句読点を捨てる', joinPiece('読み返し。', '、てみた', 'ja') === 'てみた');
    t.ok('掃除: 終わりのハイフン類（語の途中で切れた片の印）と前後の空白を落とす', cleanPieceText(' 話- ') === '話' && cleanPieceText('話—') === '話');
  }

  // ---- 設定
  {
    t.ok('設定: 既定は全部の欄がそろう', JSON.stringify(normalizeVoiceSettings(undefined)) === JSON.stringify(DEFAULTS) && DEFAULTS.sttModel === 'microsoft/mai-transcribe-2' && DEFAULTS.ttsModel === 'x-ai/grok-voice-tts-1.0');
    t.ok('設定: 読むときは不正な欄を既定に戻し、正しい欄は残す', (() => { const s = normalizeVoiceSettings({ sttModel: 'bad model', ttsVoice: 'ara', maxCallMinutes: -3 }); return s.sttModel === DEFAULTS.sttModel && s.ttsVoice === 'ara' && s.maxCallMinutes === DEFAULTS.maxCallMinutes; })());
    const bad = (value) => { try { normalizeVoiceSettings(value, { strict: true }); return null; } catch (e) { return e instanceof VoiceSettingsError ? e.message : String(e); } };
    t.ok('設定: 書くときは不正な欄・知らない欄を断る', bad({ sttModel: 'x' }) && bad({ maxCallMinutes: 0 }) && bad({ maxCallMinutes: 9999 }) && bad({ surprise: 1 }) && bad({ language: 'Japanese' }) && bad({ echoCancellation: 'yes' }), `${bad({ maxCallMinutes: 0 })}`);
    t.ok('設定: 予備のモデルは空にできる（予備なし）', normalizeVoiceSettings({ sttFallbackModel: '' }, { strict: true }).sttFallbackModel === '');
    t.ok('設定: 言語は auto なら画面の言語・指定すればその言語（地域は落とす）', languageOf({ language: 'auto' }, 'en') === 'en' && languageOf({ language: 'auto' }, 'ja') === 'ja' && languageOf({ language: 'ja' }, 'en') === 'ja' && languageOf({ language: 'en-US' }, 'ja') === 'en');
    t.ok('設定: 上限を上げる向きだけ「緩める」', loosensLimits(DEFAULTS, { ...DEFAULTS, dailyLimitMinutes: 999 }) && loosensLimits(DEFAULTS, { ...DEFAULTS, maxCallMinutes: 99 })
      && !loosensLimits(DEFAULTS, { ...DEFAULTS, maxCallMinutes: 5 }) && !loosensLimits(DEFAULTS, { ...DEFAULTS, ttsVoice: 'ara' }));
    t.ok('設定: キーの欄は無い（秘密の置き場だけ）', !Object.keys(DEFAULTS).some((k) => /key|secret|token/i.test(k)));
  }

  // ---- 使用量の台帳
  {
    const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'agent-host-voice-usage-')));
    try {
      const file = path.join(dir, 'voice-usage.json');
      let at = new Date(2026, 9, 6, 12, 0, 0).getTime();
      const usage = createVoiceUsage({ file, now: () => at, delayMs: 10_000 });
      await usage.add({ callSeconds: 61, sttSeconds: 30, ttsChars: 120 });
      await usage.add({ callSeconds: 59, ttsChars: 80, sttSeconds: -5, bogus: 7 });
      const today = await usage.today();
      t.ok('台帳: 今日の通話の長さ・聞き取りの秒数・読み上げの字数を足していく（負・未知の欄は無視）', today.callSeconds === 120 && today.sttSeconds === 30 && today.ttsChars === 200, JSON.stringify(today));
      await usage.flush();
      const saved = JSON.parse(await fs.readFile(file, 'utf8'));
      t.ok('台帳: 書き出しは日付ごと・形式番号つき', saved.version === 1 && saved.days['2026-10-06']?.callSeconds === 120);
      at += 24 * 3600_000;
      t.ok('台帳: 日が替わると、今日の分は 0 から', (await usage.today()).callSeconds === 0);
      for (let d = 0; d < KEEP_DAYS + 9; d++) { at += 24 * 3600_000; await usage.add({ callSeconds: 1 }); }
      await usage.flush();
      t.ok(`台帳: 直近 ${KEEP_DAYS} 日だけを持つ（大きさは固定の小ささ）`, Object.keys(JSON.parse(await fs.readFile(file, 'utf8')).days).length === KEEP_DAYS);
      const reopened = createVoiceUsage({ file, now: () => at });
      t.ok('台帳: 開き直しても今日の分を読み戻す', (await reopened.today()).callSeconds === 1);
      await fs.writeFile(file, '{broken');
      t.ok('台帳: 壊れたファイルは空から始める（通話を止めない）', (await createVoiceUsage({ file, now: () => at }).today()).callSeconds === 0);
    } finally { await fs.rm(dir, { recursive: true, force: true }).catch(() => {}); }
  }
}
