// 入力欄の待ち（docs/design-system.md「入力欄の待ち」）。
//
// 3 つの場面を 1 か所で持つ。どれも disabled は使わない（無効にすると打鍵が黙って捨てられ、スマホのキーボードが閉じ、
// 変換中の IME が切れる）。
//   busy(kind)  書いても保てない間（別の会話を開く = history・初めて接続するまで = connect）。
//               欄は readonly、箱に aria-busy。150ms を越えたら中の字と案内を隠し、弧・待機文言・流れる棒を出す
//   failed()    読み込みに失敗した。欄は書ける。欄の上に理由と「もう一度読む」。送信は読み込めるまで押せない（理由を title に）
//   queue()     新しい会話を作っている間に送信が押された。欄は readonly、150ms を越えたら送信ボタンに弧、
//               欄の上に「会話ができしだい送ります」と「取り消す」
//   hold()      設定（作業ディレクトリなど）を保存できず、解決するまで送らせない。欄は書ける。欄の上に強い字の理由と操作
//               （再試行・選び直す・取り消す）。送信は押せない見た目（aria-disabled）で、押されたらこの一行へフォーカスを移す
// 新しい会話を作っている間そのものは、ここでは何もしない（欄は書けるまま）。
//
// DOM は触る要素だけ受け取る（tests/unit/composer-wait.mjs が最小の DOM で回す）。

/**
 * @param {object} o
 * @param {HTMLElement} o.box       入力の箱（.cbox）。aria-busy と data-wait を付ける
 * @param {HTMLTextAreaElement} o.prompt
 * @param {HTMLButtonElement} o.send
 * @param {HTMLElement} o.note      欄の上の一行（.composer-note）
 * @param {HTMLElement} o.busyLine  箱の中の待機表示（.composer-busy）。子に .composer-busy-text を持つ
 * @param {HTMLElement} o.busyText
 * @param {(key: string) => string} o.t
 * @param {(title?: string) => HTMLElement} o.runMark
 * @param {() => void} [o.onChange] 送信の押せる・押せないが変わったとき（client.mjs の syncRunState）
 */
export function createComposerWait({ box, prompt, send, note, busyLine, busyText, t, runMark, onChange = () => {},
  delay = 150, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let mode = null;          // null | 'history' | 'connect' | 'failed'
  let queued = null;        // { onCancel }
  let busyTimer = null, queueTimer = null;
  let sendIcon = null;      // 弧に差し替える前の送信ボタンの中身
  let sendTitle = null;     // failed の間に差し替える前の title
  let held = null;          // hold() の { text, actions }。予約・読み込みの失敗の一行が優先し、それが消えたら出し直す
  let heldTitle = null;     // hold の間に差し替える前の送信の title

  const syncReadOnly = () => { prompt.readOnly = mode === 'history' || mode === 'connect' || Boolean(queued); };

  function clearBusy() {
    clearTimer(busyTimer); busyTimer = null;
    box.removeAttribute('aria-busy');
    delete box.dataset.wait;
    box.removeAttribute('data-wait');
    prompt.removeAttribute('aria-describedby');
    busyLine.hidden = true;
    // 弧は走っている間だけ DOM に置く（arc.mjs）
    for (const c of [...busyLine.children]) if (c !== busyText) c.remove();
  }
  function clearFailed() {
    if (mode !== 'failed') return;
    if (sendTitle !== null) { send.setAttribute('title', sendTitle); sendTitle = null; }
    if (!queued) clearNote();
  }
  function clearNote() { note.replaceChildren(); note.hidden = true; delete note.dataset.kind; note.removeAttribute('data-kind'); note.setAttribute('role', 'status'); paintHeld(); }
  /** 保留の一行を出す（予約・読み込みの失敗の一行が出ていないときだけ） */
  function paintHeld() {
    if (!held || queued || mode === 'failed' || (note.dataset.kind && note.dataset.kind !== 'held')) return;
    note.replaceChildren();
    const b = document.createElement('b');
    b.className = 'composer-note-strong';
    b.textContent = held.text;
    note.append(b, ...held.actions.map((a) => noteButton(a.label, a.onClick)));
    note.dataset.kind = 'held';
    note.setAttribute('role', 'alert');
    note.setAttribute('tabindex', '-1');
    note.hidden = false;
  }
  function noteButton(label, onClick) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn composer-note-action';
    b.textContent = label;
    b.onclick = onClick;
    return b;
  }

  /** 書いても保てない間。kind は history（会話を開いている）か connect（初めて接続するまで） */
  function busy(kind) {
    clearFailed();
    clearBusy();
    mode = kind;
    syncReadOnly();
    box.setAttribute('aria-busy', 'true');
    busyText.textContent = kind === 'connect' ? t('chat.composer.connecting') : t('chat.composer.historyLoading');
    // 読み上げは箱の aria-busy と、欄の説明（待機文言）で伝える
    prompt.setAttribute('aria-describedby', busyText.id);
    busyTimer = setTimer(() => {
      busyTimer = null;
      if (mode !== kind) return;
      box.dataset.wait = kind;
      busyLine.prepend(runMark());
      const bar = document.createElement('span');
      bar.className = 'composer-busy-bar';
      busyLine.append(bar);
      busyLine.hidden = false;
    }, delay);
    paintHeld();
    onChange();
  }

  /** 待ちを解く。失敗の表示も消す（送信の予約は残す） */
  function idle() {
    clearFailed();
    clearBusy();
    mode = null;
    syncReadOnly();
    paintHeld();
    onChange();
  }

  /** 読み込みに失敗した。欄は書ける。欄の上に理由と「もう一度読む」、送信の title に理由 */
  function failed(retry) {
    clearBusy();
    mode = 'failed';
    syncReadOnly();
    const text = t('chat.composer.historyNotLoaded');
    if (!queued) {
      note.replaceChildren();
      const span = document.createElement('span');
      span.textContent = text;
      note.append(span, noteButton(t('chat.composer.historyRetry'), () => retry()));
      note.dataset.kind = 'failed';
      note.hidden = false;
    }
    if (sendTitle === null) sendTitle = send.getAttribute('title') ?? '';
    send.setAttribute('title', text);
    onChange();
  }

  /** 新しい会話ができるまで送信を待たせる。onCancel は「取り消す」で呼ぶ */
  function queue(onCancel) {
    if (queued) return;
    queued = { onCancel };
    syncReadOnly();
    clearTimer(queueTimer);
    queueTimer = setTimer(() => {
      queueTimer = null;
      if (!queued) return;
      sendIcon = [...send.children];
      send.classList.add('wait');
      send.replaceChildren(runMark(t('chat.composer.queued')));
      note.replaceChildren();
      const b = document.createElement('b');
      b.textContent = t('chat.composer.queued');
      note.append(runMark(), b, noteButton(t('chat.composer.queuedCancel'), () => { cancel(); prompt.focus?.(); }));
      note.dataset.kind = 'queued';
      note.hidden = false;
    }, delay);
  }
  /** 予約を解く（送った・作れなかった・取り消した）。欄は書けるように戻す（字はそのまま） */
  function unqueue() {
    if (!queued) return;
    queued = null;
    clearTimer(queueTimer); queueTimer = null;
    if (sendIcon) { send.replaceChildren(...sendIcon); sendIcon = null; }
    send.classList.remove('wait');
    clearNote();
    syncReadOnly();
  }
  function cancel() {
    const q = queued;
    unqueue();
    q?.onCancel?.();
  }

  /** 送らせない理由と操作を欄の上に出す。text は強い字の理由、actions は [{ label, onClick }] */
  function hold(text, actions = []) {
    held = { text, actions };
    if (heldTitle === null) heldTitle = send.getAttribute('title') ?? '';
    send.setAttribute('title', text);
    send.setAttribute('aria-disabled', 'true');
    send.classList.add('blocked');
    if (note.dataset.kind === 'held') delete note.dataset.kind;
    paintHeld();
    onChange();
  }
  /** 保留を解く */
  function release() {
    if (!held) return;
    held = null;
    if (heldTitle !== null) { send.setAttribute('title', heldTitle); heldTitle = null; }
    send.removeAttribute('aria-disabled');
    send.classList.remove('blocked');
    if (note.dataset.kind === 'held') clearNote();
    onChange();
  }
  /** 保留の間に送信が押された。理由の一行へフォーカスを移して知らせる */
  function point() {
    if (note.dataset.kind !== 'held') return;
    note.classList.remove('flash');
    void note.offsetWidth;
    note.classList.add('flash');
    note.focus?.();
  }

  return {
    busy, idle, failed, queue, unqueue, cancel, hold, release, point,
    /** 設定を保存できず送らせない間 */
    get held() { return Boolean(held); },
    get mode() { return mode; },
    get queued() { return Boolean(queued); },
    /** 送信を押せない（書けない待ち・読み込みの失敗） */
    blocksSend: () => mode !== null,
    /** 欄に字・添付を足してよいか */
    accepts: () => (mode === null || mode === 'failed') && !queued,
  };
}
