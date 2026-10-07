// まとめ待ち（通話モード。承認済み 2026-10-07。docs/voice-call.md「まとめ待ち」）。純粋な状態（DOM・タイマーを持たない。時刻は呼ぶ側が渡す）。
//
// ホストは声を短く区切り（約 0.7 秒の無音ごと）、区切るたびに確定の文字を返す。それをそのまま 1 通ずつ送ると、言いよどみ（「で、あのー、」「あ、なんか、」）が何通にも分かれる。
// ここでは確定を溜めて 1 つの文にし、最後の声から待ち時間（既定 1.2 秒）のあいだ声が戻らず、ホストの確定も出そろったら 1 通として送る。
//   声が戻る       待ち時間は最後の声から数え直す（話が続く間は送らない）
//   確定の待ち     ホストが「まだ文字が出そろっていない」（busy）間は、待ち時間が過ぎても送らない。確定が出たら送る（返事の始まりは、待ち時間と確定の遅い方）
//   末尾の規則     文が「、」・つなぎ語・助詞で終わっていれば長めに、文末（。・？・〜です・〜して）なら短めに待つ
//   言いよどみだけ 「えーと」「あのー」だけの文は送らず、長めに待って、それでも次が無ければ捨てる
// 区切り（待ち時間）は設定（core/voice/settings.mjs の TURN_HOLD_MS。ready の turnHoldMs）。
export const VOICING_GAP_MS = 350;      // 最後の声からこれだけは「いま話している」（残りの線を満たしたままにする）
const BUSY_MAX_MS = 20_000;             // ホストの busy が閉じないまま（応答が詰まった）この長さを超えたら、出ている確定だけで送る
const MIN_HOLD_MS = 500;
const MAX_HOLD_MS = 3200;
const LONG_FACTOR = 1.5;
const SHORT_FACTOR = 0.65;
const FILLER_FACTOR = 2;

/** 末尾が「まだ続きそう」: 読点・つなぎ語・助詞・言いよどみ */
const OPEN_END = /(?:[、，,…ー〜]|えーと|えーっと|えっと|ええと|あのー?|その|なんか|まあ|まぁ|で|けど|けれど|けれども|が|から|ので|のに|って|とか|それで|あと|でも|を|は|に|も|と|um|uh|and|but|so|because|then)$/i;
/** 末尾が文末 */
const CLOSED_END = /(?:[。．.！!？?]|して|ください|下さい|です|ます|でした|ました|ですか|ますか|だよ|だね|かな|お願い|おねがい)$/i;
/** 言いよどみだけの文（語の並び）。区切り・空白・記号は読み飛ばす */
const FILLER_WORD = /^(?:えーと|えーっと|えっと|ええと|えー|あのー?|あー|あぁ|うーん|んー|そのー?|まあ|まぁ|なんか|um+|uh+|er+|erm|hmm+|ah+)$/i;
const SEPARATORS = /[\s、。，．,.!?！？…~\-]+/u;

/** 言いよどみだけの文か（記号・区切りを除いて、語が全部「えーと」「あの」の類） */
export function isFillerOnly(text) {
  const words = String(text ?? '').split(SEPARATORS).filter(Boolean);
  if (!words.length) return false;
  // 区切りの無い日本語（「えーとあの」）は、先頭から言いよどみ語で食い切れるかで見る
  return words.every((w) => FILLER_WORD.test(w) || /^(?:えーと|えーっと|えっと|ええと|えー|あのー?|あー|うーん|そのー?|まあ|まぁ|なんか)+$/.test(w));
}

/** 待ち時間の倍率（末尾の規則）。base × 倍率 を MIN〜MAX に収める */
export function holdFor(text, baseMs) {
  const t = String(text ?? '').trim();
  let factor = 1;
  if (!t) factor = 1;
  else if (isFillerOnly(t)) factor = FILLER_FACTOR;
  else if (OPEN_END.test(t)) factor = LONG_FACTOR;
  else if (CLOSED_END.test(t)) factor = SHORT_FACTOR;
  return Math.round(Math.min(MAX_HOLD_MS, Math.max(MIN_HOLD_MS, baseMs * factor)));
}

const CJK_EDGE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}、。，．！？「」『』（）…ー〜]/u;
/** 2 つの文をつなぐ。日本語（どちらかの境が CJK・全角の記号）は詰め、それ以外は空白を 1 つ */
export function joinText(a, b) {
  if (!a) return b;
  if (!b) return a;
  const left = a.at(-1), right = b[0];
  if (/\s/.test(left) || /\s/.test(right)) return a + b;
  return CJK_EDGE.test(left) || CJK_EDGE.test(right) ? a + b : `${a} ${b}`;
}

/**
 * @param {object} o
 * @param {number} [o.holdMs]  待ち時間の基準（設定の区切り）
 * @param {(a: string, b: string) => string} [o.join]
 */
export function createTurnHold({ holdMs = 1200, join = joinText } = {}) {
  let base = holdMs;
  const entries = new Map();            // utt -> { text, final }
  let lastVoiceAt = -Infinity;          // クライアントが最後に声を聞いた時刻
  let busy = false, busySince = 0;      // ホストが「文字がまだ出そろっていない」か
  let lastUtt = 0, ignoreUpTo = 0;      // 知っている発話の番号の最大。取り消したら、そこまでの発話の（後から届く）文字は捨てる
  let active = false;                   // 声を聞き始めてから、送る・捨てるまで
  let flush = false;                    // 「いま送る」: 待ち時間は待たない（確定が出そろうのは待つ）
  let version = 0;

  const ordered = () => [...entries.entries()].sort((a, b) => a[0] - b[0]).map(([, e]) => e);

  /** 確定の文字（先頭から途切れず確定している分）と、そのあとの途中の文字 */
  function parts() {
    let final = '', partial = '', open = false;
    for (const e of ordered()) {
      if (!e.text) continue;
      if (!open && e.final) final = join(final, e.text);
      else { open = true; partial = join(partial, e.text); }
    }
    return { final, partial };
  }
  const fullText = () => { const p = parts(); return join(p.final, p.partial); };
  const unsettled = () => ordered().some((e) => !e.final);

  const touch = () => { version++; };

  return {
    get version() { return version; },
    get active() { return active; },
    get busy() { return busy; },
    setHold(ms) { base = ms; touch(); },
    get holdMs() { return base; },
    /** クライアントが声を聞いた（送信ゲートの前のフレームで測った音量。話している間は毎フレーム）。t は now() */
    voice(t) { active = true; lastVoiceAt = t; flush = false; touch(); },
    /** ホストの busy（話している・区切って確定を待っている） */
    setBusy(on, t, last) {
      if (Number.isInteger(last)) lastUtt = Math.max(lastUtt, last);
      if (on === busy) return;
      busy = on; busySince = t; if (on) active = true; touch();
    },
    partial(utt, text) {
      lastUtt = Math.max(lastUtt, utt);
      if (utt <= ignoreUpTo) return;
      const e = entries.get(utt);
      if (e?.final) return;
      entries.set(utt, { text: String(text ?? ''), final: false });
      active = true; touch();
    },
    final(utt, text) {
      lastUtt = Math.max(lastUtt, utt);
      if (utt <= ignoreUpTo) return;
      entries.set(utt, { text: String(text ?? '').trim(), final: true });
      active = true; touch();
    },
    /** 捨てられた発話（雑音・空・失敗）。途中の文字ごと消す */
    drop(utt) { if (entries.delete(utt)) touch(); },
    /** いま送る（待ち時間は待たない）。確定が出そろうまでは待つ */
    sendNow() { if (active) { flush = true; touch(); } },
    /** 取り消す（溜めた文字を捨てる） */
    cancel() { entries.clear(); ignoreUpTo = lastUtt; active = false; flush = false; touch(); },
    /**
     * 通話を終えるとき、まだ送っていない言葉。言いよどみだけ・空なら null。画面に出ている文字（確定と途中）をそのまま送る
     * （吹き出しに見えていた言葉が、黙って消えないように）。送ったら溜めた文字は空になる
     */
    leftover() {
      const text = fullText().trim();
      if (!active || !text || isFillerOnly(text)) return null;
      this.cancel();
      return text;
    },
    /** 通話の終わり・初期化 */
    reset() { this.cancel(); busy = false; lastVoiceAt = -Infinity; lastUtt = ignoreUpTo = 0; },
    /**
     * 画面に出すもの。t は now()。
     * waiting: 待ち時間は過ぎたが、ホストの確定を待っている
     */
    view(t) {
      const { final, partial } = parts();
      const text = join(final, partial);
      const total = holdFor(text, base);
      const voicing = t - lastVoiceAt < VOICING_GAP_MS;
      const sinceVoice = t - lastVoiceAt;
      const leftMs = voicing ? total : Math.max(0, total - sinceVoice);
      return {
        active, final, partial, text, voicing, leftMs, totalMs: total,
        fraction: total > 0 ? Math.min(1, leftMs / total) : 0,
        waiting: active && leftMs === 0 && (busy || unsettled()),
      };
    },
    /**
     * 時計を進める。送る時は { send: text }、言いよどみだけで終わったら { discard: true }、まだなら null。
     * 送ったら（捨てたら）溜めた文字は空になり、次の発話からまた始まる
     */
    tick(t) {
      if (!active) return null;
      const stuck = busy && t - busySince >= BUSY_MAX_MS;
      if ((busy && !stuck) || (unsettled() && !stuck)) return null;
      const text = fullText().trim();
      if (!text) {
        // 声はあったが文字が出なかった（雑音）。待ち時間が過ぎたら静かに閉じる
        if (t - lastVoiceAt >= holdFor('', base) && !busy) { this.cancel(); }
        return null;
      }
      if (t - lastVoiceAt < VOICING_GAP_MS && !flush) return null;
      if (!flush && t - lastVoiceAt < holdFor(text, base)) return null;
      const filler = isFillerOnly(text);
      this.cancel();
      return filler ? { discard: true } : { send: text };
    },
  };
}
