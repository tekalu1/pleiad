// 通話モードの「失敗の知らせ」の判定（承認済み 2026-10-07。docs/design-system.md「通話モード」）。DOM は触らない。画面（index.mjs）が ui の口で描く。
//
// 知らせは 3 つの場所に分かれる:
//   (a) 聞き取れなかった   会話の末尾の 1 行（声の吹き出しが出るはずだった場所）。別の発話の吹き出しが出ているあいだは、その吹き出しの中の 1 行。
//                         次に話し始めたら畳む。通話を終えたら消す。時間では消さない。続けて失敗したら同じ行を「続けて N 回」に更新し、2 回目から手がかり
//   (a) 読み上げられなかった 返事の下の一行（.vc-hint の fail）。次の発言を送ったら消える
//   (b) 通話の状態         入力欄の下の 1 行（× つき）。状態（権限・キー・上限・始められない）は原因が解けたら、終わった理由（上限・声が聞こえず終了・つながりの切れ）は
//                         別の会話へ移ったら消える。どちらも × と次の通話で消える。時間では消さない
// ホストは失敗の種類（kind・status。本文やキーは渡さない）だけを渡す（core/voice/session.mjs の error）。

/** 聞き取りの失敗の分類。key = キーが拒否された（待っても直らない）、busy = 混み合い、stt = ほか */
export function classifyListenFailure({ code, status } = {}) {
  if (status === 401 || status === 403) return 'key';
  if (code === 'stt-busy' || status === 429) return 'busy';
  return 'stt';
}

/**
 * コードごとの状態の一行。辞書のキー（voice.note.<key>）・［設定を開く］を付けるか・種類・どの出来事で消えるか。
 *   fixed-permission  マイクの許可が下りた      fixed-device  マイクが繋がった（devicechange）
 *   fixed-settings    設定（キー・上限）が変わった
 *   close（×）・start（次の通話を始めた）は、どの知らせでも消える。moved（別の会話へ移った）は終わった理由だけ
 */
export const STATUS_NOTES = {
  'no-key': { key: 'nokey', settings: true, tone: 'state', clears: ['fixed-settings'] },
  'daily-limit': { key: 'dailyLimit', settings: true, tone: 'state', clears: ['fixed-settings'] },
  'limit-daily': { key: 'dailyLimit', settings: true, tone: 'state', clears: ['fixed-settings'] },
  'limit-call': { key: 'callLimit', settings: true, tone: 'ended', clears: ['moved'] },
  'limit-idle': { key: 'idle', settings: false, tone: 'ended', clears: ['moved'] },
  link: { key: 'link', settings: false, tone: 'ended', clears: ['moved'] },
  start: { key: 'start', settings: true, tone: 'state', clears: [] },
  'start-timeout': { key: 'startTimeout', settings: false, tone: 'state', clears: [] },
  // マイクを使えなかった理由（engine.denied）
  denied: { key: 'denied', settings: true, tone: 'state', clears: ['fixed-permission'] },
  'no-device': { key: 'noDevice', settings: true, tone: 'state', clears: ['fixed-device'] },
  busy: { key: 'busy', settings: true, tone: 'state', clears: [] },
};

/** 会話の識別子（index.mjs の keyOf）が「同じ会話」か。新しい会話の id が決まっただけ（chat: → chat:<id>）は同じ */
export function sameConversation(was, now) {
  if (was === now) return true;
  return was === 'chat:' && now.startsWith('chat:') && now !== 'chat:';
}

/**
 * @param {object} ui  画面への口（変わったときだけ呼ぶ）
 * @param {(view: null | { where: 'row'|'bubble', kind: 'stt'|'busy'|'key', count: number }) => void} ui.listen  聞き取れなかった行（null で畳む）
 * @param {(view: null | { code: string, key: string, settings: boolean, tone: 'state'|'ended' }) => void} ui.status  入力欄の下の一行（null で畳む）
 * @param {(on: boolean) => void} ui.ttsFail  返事の下の読み上げの失敗の一行
 * @param {() => boolean} ui.bubbleActive  別の発話の声の吹き出しが出ているか
 */
export function createNotices(ui) {
  let listen = null;      // { where, kind, count } 出ている聞き取れなかった行
  let misses = 0;         // 続けて聞き取れなかった回数（何か 1 つ聞き取れたら 0）
  let status = null;      // { code, ..., anchor } anchor = 終わった理由が出たときに見ていた会話（別の会話へ移ったかの基準）
  let tts = false;

  const setListen = (next) => {
    const same = listen && next && listen.where === next.where && listen.kind === next.kind && listen.count === next.count;
    listen = next;
    if (!same) ui.listen(next ? { ...next } : null);
  };
  const setStatus = (next) => {
    status = next;
    ui.status(next ? { code: next.code, key: next.key, settings: next.settings, tone: next.tone } : null);
  };
  const setTts = (on) => { if (tts === on) return; tts = on; ui.ttsFail(on); };

  return {
    get listening() { return listen; },
    get misses() { return misses; },
    get status() { return status; },
    get ttsFailed() { return tts; },
    /** 終わった理由が出ているあいだ、別の会話へ移ったかを見る基準（null なら見張らない） */
    get anchor() { return status?.anchor ?? null; },

    /** 聞き取りが失敗した（engine の notice stt・stt-busy。kind・status はホストが渡す） */
    listenFailed(info = {}) {
      misses++;
      setListen({ where: ui.bubbleActive() ? 'bubble' : 'row', kind: classifyListenFailure(info), count: misses });
    },
    /** 何か 1 つ聞き取れた（final）。続けて失敗した回数を 0 に戻す。出ている行は話し始めで畳む（ここでは畳まない） */
    heard() { misses = 0; },
    /** 次に話し始めた（聞き取り中になった・声の吹き出しが出た）。聞き取れなかった行を畳む（回数は残る） */
    speaking() { if (listen) setListen(null); },
    /** 読み上げられなかった（tts） */
    ttsFail() { setTts(true); },
    /** 次の発言を送った。読み上げの失敗の一行を消す */
    turnSent() { setTts(false); },
    /** 通話を終えた。聞き取れなかった行・読み上げの失敗を消し、回数を戻す */
    callEnded() { misses = 0; if (listen) setListen(null); setTts(false); },

    /** 通話の状態の一行を出す（code は STATUS_NOTES のキー）。anchor = 見ていた会話の識別子 */
    showStatus(code, anchor = null) {
      const def = STATUS_NOTES[code] ?? STATUS_NOTES.start;
      setStatus({ code, ...def, anchor: def.tone === 'ended' ? anchor : null });
    },
    /** 出来事で消える。close（×）・start・moved・fixed-*。消えたら true */
    clear(event) {
      if (!status) return false;
      if (event !== 'close' && event !== 'start' && !status.clears.includes(event)) return false;
      setStatus(null);
      return true;
    },
    /** いま見ている会話（終わった理由が出ているあいだ、定期的に渡す）。別の会話なら消す */
    watch(key) {
      if (!status || status.anchor === null || sameConversation(status.anchor, key)) return false;
      return this.clear('moved');
    },
    /** 次の通話を始めた */
    callStarted() { misses = 0; if (listen) setListen(null); setTts(false); this.clear('start'); },
  };
}
