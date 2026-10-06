// あなたの声の吹き出し（通話モード。docs/design-system.md「通話モード」）。話している間、聞き取った言葉（片）が足されていく。
// 足される語は、ぼかし＋わずかな上下の動きから定位置へ 180ms で溶け込む。途中の文字は弱い字で、確定したら普通の字へ移る。
// 確定で言い直された語（ホストが全体を 1 回で認識した結果が、片をつないだ途中経過と違う所）だけが入れ替わる。左に小さなマイクの印。
// 確定したら、いまの送信の経路（会話へは sendMessage、スレッドへは channels.post）へ送り、本物の発言の行が現れた瞬間にこの吹き出しは消える（重ならない）。
// 片が 1 つも無かった短い発言は、吹き出しを作らずにそのまま送る（確定の一瞬だけ現れて、本物の行に替わるちらつきを避ける）。

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
 * @param {() => boolean} o.reduced
 * @param {() => void} [o.follow]  足したあと、末尾にいるなら追従させる
 */
export function createLiveBubble({ createRow, place, label, reduced = () => false, follow = () => {} }) {
  let row = null, words = null, tokens = [], state = 'idle';   // idle | live | sending

  function ensure() {
    if (row) return;
    const made = createRow();
    row = made.el;
    row.classList.add('vc-live');
    row.dataset.vcLive = '';
    const body = made.body;
    body.classList.add('vc-body', 'live');
    words = document.createElement('span');
    words.className = 'vc-words';
    body.append(micMark(label), words);
    tokens = [];
    place(row);
    state = 'live';
    follow();
  }

  const span = (text, partial) => {
    const s = document.createElement('span');
    s.className = `lw${partial ? ' p' : ''}`;
    s.textContent = text;
    return s;
  };

  /** 全文を受けて、変わった所だけを入れ替える（共通の頭は触らない） */
  function apply(text, partial) {
    const next = tokensOf(text);
    let keep = 0;
    while (keep < tokens.length && keep < next.length && tokens[keep].text === next[keep]) keep++;
    for (const t of tokens.splice(keep)) {
      if (reduced()) t.el.remove();
      else { t.el.classList.add('out'); setTimeout(() => t.el.remove(), 140); }
    }
    for (const word of next.slice(keep)) {
      const el = span(word, partial);
      words.append(el);
      tokens.push({ text: word, el });
    }
    if (!partial) for (const t of tokens) t.el.classList.remove('p');
    follow();
  }

  return {
    get active() { return state !== 'idle'; },
    get row() { return row; },
    /** 片をつないだ途中の文字（全文） */
    partial(text) { if (state === 'sending') return; ensure(); apply(text, true); },
    /** 確定した文字。吹き出しがあれば落ち着かせて true、無ければ false（そのまま送る） */
    settle(text) {
      if (state === 'idle') return false;
      apply(text, false);
      row.classList.remove('live');
      if (!reduced()) { row.classList.add('settle'); setTimeout(() => row?.classList.remove('settle'), 400); }
      state = 'sending';
      return true;
    },
    /** 聞き取った言葉が空・雑音だった（片を出したが確定が無い）。静かに消す */
    discard() { this.remove(true); },
    /** 本物の発言の行が現れた・送れなかった。吹き出しを外す */
    remove(fade = false) {
      const r = row;
      row = null; words = null; tokens = []; state = 'idle';
      if (!r) return;
      if (fade && !reduced()) { r.classList.add('gone'); setTimeout(() => r.remove(), 260); } else r.remove();
    },
    get sending() { return state === 'sending'; },
  };
}
