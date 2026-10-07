// 通話の設定（prefs.json の voice。設定 › 通話）。値の検査と既定。キーは含めない（OpenRouter のキーはホストの秘密の置き場だけ。docs/voice-call.md「キー」）。
// 設定の一覧（core/ops/settings.mjs の defineSetting）と、通話の開始（core/voice/host.mjs）が同じ normalize を通る。

export const DEFAULTS = Object.freeze({
  sttModel: 'microsoft/mai-transcribe-2',               // 聞き取り。日本語の文字誤り 0.5%・往復 0.4〜0.5 秒。混む時間帯は 429 が出るので予備を持つ
  sttFallbackModel: 'assemblyai/universal-3-5-pro',     // 429 のときの予備（空にすると予備なし）
  ttsModel: 'x-ai/grok-voice-tts-1.0',                  // 読み上げ。逐次の PCM で最初のバイトまで約 0.35 秒
  ttsVoice: 'eve',
  language: 'auto',                                     // auto は画面の言語（ja・en）。聞き取りの言語の指定
  maxCallMinutes: 30,                                   // 1 回の通話の長さの上限（分）。超えたら終える
  dailyLimitMinutes: 120,                               // 1 日（この PC の日付）の通話の長さの上限（分）。超えたら始められない
  echoCancellation: true,                               // ブラウザーのエコー除去・ノイズ抑制・自動音量
  turnHold: 'standard',                                 // 話の区切り（まとめ待ち）。最後の声から送るまでの待ち。short・standard・long（TURN_HOLD_MS）
  bargeIn: true,                                        // 話して読み上げを止める。エコー除去が効いているときだけ働く（効かなければ半二重のまま）
  sounds: 'off',                                        // 効果音。off・few（送った音と止めた音だけ）・all
  ackPhrase: true,                                      // 受け取りの一言。声で送った 1 通が AI に渡って 1.5 秒たっても返事が始まらないとき、決まった一言を読む（docs/voice-call.md「待ちの声」）
  narration: true,                                      // 待ちの実況。ツールを使っている無音が続くとき、ツールの種類から決まった短い文を読む
});

/** 区切り（まとめ待ち）の長さ（ms）。最後の声から数える。標準は考えながら話す人が 1 通にまとまる長さ（docs/voice-call.md「まとめ待ち」） */
export const TURN_HOLD_MS = Object.freeze({ short: 700, standard: 1200, long: 2000 });
export const SOUND_LEVELS = Object.freeze(['off', 'few', 'all']);

export const LIMITS = Object.freeze({ maxCallMinutes: [1, 480], dailyLimitMinutes: [1, 1440] });

export class VoiceSettingsError extends Error {
  constructor(code, detail) { super(`${code}${detail ? `: ${detail}` : ''}`); this.name = 'VoiceSettingsError'; this.code = code; this.detail = detail; }
}

const MODEL = /^[a-z0-9][a-z0-9._-]*\/[A-Za-z0-9._:-]{1,80}$/;
const VOICE = /^[A-Za-z0-9._ -]{1,40}$/;
const LANG = /^[a-z]{2}(?:-[A-Za-z]{2,4})?$/;

/**
 * 保存されている値（欠けた欄・壊れた欄を含む）を、検査して全部の欄がそろった形にする。
 * strict: false（読むとき）は、不正な欄を既定に戻す。strict: true（書くとき）は VoiceSettingsError で断る
 */
export function normalizeVoiceSettings(raw, { strict = false } = {}) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const out = { ...DEFAULTS };
  const bad = (key, why) => { if (strict) throw new VoiceSettingsError('invalid', `${key}: ${why}`); };
  for (const key of Object.keys(src)) if (strict && !Object.hasOwn(DEFAULTS, key)) bad(key, 'unknown');
  const text = (key, ok, allowEmpty = false) => {
    if (!Object.hasOwn(src, key) || src[key] === undefined) return;
    const v = src[key];
    if (typeof v === 'string' && ((allowEmpty && v === '') || ok.test(v))) out[key] = v;
    else bad(key, 'format');
  };
  text('sttModel', MODEL);
  text('sttFallbackModel', MODEL, true);
  text('ttsModel', MODEL);
  text('ttsVoice', VOICE);
  if (Object.hasOwn(src, 'language') && src.language !== undefined) {
    if (src.language === 'auto' || (typeof src.language === 'string' && LANG.test(src.language))) out.language = src.language; else bad('language', 'format');
  }
  for (const key of Object.keys(LIMITS)) {
    if (!Object.hasOwn(src, key) || src[key] === undefined) continue;
    const [lo, hi] = LIMITS[key];
    if (Number.isInteger(src[key]) && src[key] >= lo && src[key] <= hi) out[key] = src[key]; else bad(key, `${lo}..${hi}`);
  }
  if (Object.hasOwn(src, 'echoCancellation') && src.echoCancellation !== undefined) {
    if (typeof src.echoCancellation === 'boolean') out.echoCancellation = src.echoCancellation; else bad('echoCancellation', 'boolean');
  }
  if (Object.hasOwn(src, 'bargeIn') && src.bargeIn !== undefined) {
    if (typeof src.bargeIn === 'boolean') out.bargeIn = src.bargeIn; else bad('bargeIn', 'boolean');
  }
  if (Object.hasOwn(src, 'turnHold') && src.turnHold !== undefined) {
    if (typeof src.turnHold === 'string' && Object.hasOwn(TURN_HOLD_MS, src.turnHold)) out.turnHold = src.turnHold; else bad('turnHold', Object.keys(TURN_HOLD_MS).join('|'));
  }
  for (const key of ['ackPhrase', 'narration']) {
    if (Object.hasOwn(src, key) && src[key] !== undefined) {
      if (typeof src[key] === 'boolean') out[key] = src[key]; else bad(key, 'boolean');
    }
  }
  if (Object.hasOwn(src, 'sounds') && src.sounds !== undefined) {
    if (SOUND_LEVELS.includes(src.sounds)) out.sounds = src.sounds; else bad('sounds', SOUND_LEVELS.join('|'));
  }
  return out;
}

/** 区切りの長さ（ms）。壊れた値は標準 */
export const turnHoldMsOf = (settings) => TURN_HOLD_MS[settings?.turnHold] ?? TURN_HOLD_MS.standard;

/** 聞き取りの言語（ISO-639-1）。auto は画面の言語 */
export const languageOf = (settings, uiLang) => (settings.language === 'auto' ? (uiLang === 'en' ? 'en' : 'ja') : settings.language.split('-')[0]);

/** 費用の安全弁を緩める向き（上限を上げる）か。設定の一覧の riskOf が使う（緩める向きは guarded） */
export const loosensLimits = (before, after) => after.maxCallMinutes > before.maxCallMinutes || after.dailyLimitMinutes > before.dailyLimitMinutes;
