// あなたの声の吹き出し（通話モード。docs/design-system.md「通話モード」）。話している間、聞き取った言葉が 1 つの吹き出しに足されていく。
// 足される語は、ぼかし＋わずかな上下の動きから定位置へ 180ms で溶け込む。途中の文字は弱い字で、確定したら普通の字へ移る。
// 確定で言い直された語（ホストが全体を 1 回で認識した結果が、片をつないだ途中経過と違う所）だけが入れ替わる。左に小さなマイクの印。
//
// まとめ待ち（承認済み 2026-10-07）: 言いよどんで何度か区切られても、組み立て中の文は 1 つの吹き出しに伸びる。吹き出しの下に、送るまでの残りを示す細い線と
// 「まだ聞いています · あと 0.7 秒で送ります」［いま送る］［取り消す］。話している間は線を満たしたままにする。
// 送る時が来たら、いまの送信の経路（会話へは sendMessage、スレッドへは channels.post）へ送り、本物の発言の行が現れた瞬間にこの吹き出しは消える（重ならない）。
// 文字がまだ 1 つも出ていない間は、吹き出しを作らない（雑音の一瞬で出して消すちらつきを避ける）。

const SEGMENTER = typeof Intl?.Segmenter === 'function' ? new Intl.Segmenter(undefined, { granularity: 'word' }) : null;
export const tokensOf = (text) => (SEGMENTER ? [...SEGMENTER.segment(String(text ?? ''))].map((s) => s.segment) : [...String(text ?? '')]);

export function micMark(label) {
  const mark = document.createElement('span');
  mark.className = 'vmark';
  mark.title = label;
  mark.setAttribute('role', 'img');
  mark.setAttribute('aria-label', label);
  mark.innerHTML = '<svg class="i s" viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>';
  return mark;
}

/**
 * @param {object} o
 * @param {() => { el: HTMLElement, body: HTMLElement }} o.createRow  この場所の発言の行（Chats の .m.user・スレッドの .post）。body に語を入れる
 * @param {(row: HTMLElement) => void} o.place  行を会話の列の末尾へ置く
 * @param {string} o.label  マイクの印の名前（音声で話した発言）
 * @param {{ group: string, listening: string, waiting: (seconds: string) => string, finishing: string, sendNow: string, cancel: string }} o.text  まとめ待ちの字（辞書から引いたもの）
 * @param {{ sendNow: () => void, cancel: () => void }} [o.actions]  ［いま送る］［取り消す］
 * @param {() => boolean} o.reduced
 * @param {() => void} [o.follow]  足したあと、末尾にいるなら追従させる
 */
export function createLiveBubble({ createRow, place, label, text = {}, actions = { sendNow() {}, cancel() {} }, reduced = () => false, follow = () => {} }) {
  let row = null, words = null, tokens = [], state = 'idle';   // idle | live | sending
  let hold = null;                                              // { root, bar, text }

  function ensure() {
    if (row) return;
    const made = createRow();
    row = made.el;
    row.classList.add('vc-live');
    row.dataset.vcLive = '';
    const body = made.body;
    body.classList.add('vc-body', 'live');
    body.setAttribute('role', 'group');
    body.setAttribute('aria-label', text.group ?? '');
    words = document.createElement('span');
    words.className = 'vc-words';
    body.append(micMark(label), words);
    hold = buildHold();
    body.append(hold.root);
    tokens = [];
    place(row);
    state = 'live';
    follow();
  }

  function buildHold() {
    const root = document.createElement('div');
    root.className = 'vc-hold';
    const bar = document.createElement('div');
    bar.className = 'vc-bar';
    bar.setAttribute('aria-hidden', 'true');
    bar.append(document.createElement('i'));
    const rowEl = document.createElement('div');
    rowEl.className = 'vc-hrow';
    const status = document.createElement('span');
    status.className = 'vc-ht';
    const button = (cls, name, onclick) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = cls;
      b.textContent = name;
      b.onclick = onclick;
      return b;
    };
    rowEl.append(status, button('vc-mini vc-mini-p', text.sendNow ?? '', () => actions.sendNow()), button('vc-mini vc-mini-q', text.cancel ?? '', () => actions.cancel()));
    root.append(bar, rowEl);
    return { root, bar, text: status, sig: '' };
  }

  const span = (word, partial) => {
    const s = document.createElement('span');
    s.className = `lw${partial ? ' p' : ''}`;
    s.textContent = word;
    return s;
  };

  /** 確定の文字 + 途中の文字を受けて、変わった所だけを入れ替える（共通の頭は触らない） */
  function apply(final, partial) {
    const next = [...tokensOf(final).map((word) => [word, false]), ...tokensOf(partial).map((word) => [word, true])];
    let keep = 0;
    while (keep < tokens.length && keep < next.length && tokens[keep].text === next[keep][0] && tokens[keep].p === next[keep][1]) keep++;
    for (const t of tokens.splice(keep)) {
      if (reduced()) t.el.remove();
      else { t.el.classList.add('out'); setTimeout(() => t.el.remove(), 140); }
    }
    for (const [word, p] of next.slice(keep)) {
      const el = span(word, p);
      words.append(el);
      tokens.push({ text: word, p, el });
    }
    follow();
  }

  function paintHold(view) {
    const left = Math.min(1, Math.max(0, view.fraction ?? 1));
    hold.root.style.setProperty('--left', left.toFixed(3));
    hold.root.dataset.voicing = String(Boolean(view.voicing));
    const status = view.voicing ? text.listening
      : view.waiting || view.leftMs <= 0 ? text.finishing
        : text.waiting?.((Math.max(0, view.leftMs) / 1000).toFixed(1));
    if (hold.sig !== status) { hold.sig = status; hold.text.textContent = status ?? ''; }
  }

  return {
    get active() { return state !== 'idle'; },
    get row() { return row; },
    /** まとめ待ちの組み立て中の文と残り時間（engine の hold イベントの view）。文字が出ていなければ吹き出しは作らず、出ていた文字が消えたら（捨てられた）外す */
    update(view) {
      if (state === 'sending') { if (!view?.text) return; this.remove(); }   // 前の発言の本物の行が現れる前に、次の話が始まった
      if (!view?.text) { if (state === 'live') this.remove(true); return; }
      ensure();
      apply(view.final ?? '', view.partial ?? '');
      paintHold(view);
    },
    /** 送る。言葉を確定の字にして、待ちの線とボタンを外し、本物の行が現れるまで置く。吹き出しが無かったら false（そのまま送る） */
    commit(finalText) {
      if (state === 'idle') return false;
      apply(finalText, '');
      row.classList.remove('live');
      hold?.root.remove();
      hold = null;
      row.querySelector('.vc-body')?.removeAttribute('aria-label');
      if (!reduced()) { row.classList.add('settle'); setTimeout(() => row?.classList.remove('settle'), 400); }
      state = 'sending';
      return true;
    },
    /** 取り消した・雑音だった。静かに消す */
    discard() { this.remove(true); },
    /** 本物の発言の行が現れた・送れなかった。吹き出しを外す */
    remove(fade = false) {
      const r = row;
      row = null; words = null; tokens = []; hold = null; state = 'idle';
      if (!r) return;
      if (fade && !reduced()) { r.classList.add('gone'); setTimeout(() => r.remove(), 260); } else r.remove();
    },
    get sending() { return state === 'sending'; },
  };
}
