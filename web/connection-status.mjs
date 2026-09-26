// 接続の状態の見せ方（docs/design-system.md「接続の状態」）。困っているときだけ、困り方で 2 段に分けて出す。
//
//   切れた（自動で戻る見込みがある）: 1.5 秒続いたら、脇の下と入力欄の上に同じ一行「接続が切れました。再接続しています…」。
//     入力欄の上の一行は脇が見えていないときだけ見せる（style.css の .conn-note）。1.5 秒ごとに開き直す（client.mjs の connect）
//   操作が要る（このページのトークンが古い）: 続けて 2 回開けなかったら HTTP で 1 回だけ確かめる（check）。
//     401 なら再接続をやめ、入力欄の上に強い字の見出しと次の一手（起動時に表示された URL で開き直す）、「再確認」を出す。
//     脇の幅によらず出し、送信は押せなくする（blocksSend）。押したら「確認しています…」→ 確かめた時刻と結果をその場に書く
//
// 読み上げは画面外の role=status（live）1 か所だけ。切れたとき・戻ったとき・案内に替えたとき・確かめた結果を 1 回ずつ読む。
// DOM は触る要素だけ受け取る（tests/unit/connection-status.mjs が最小の DOM で回す）。

/**
 * @param {object} o
 * @param {HTMLElement} o.note      入力欄の上の一行・案内の面（#connNote）
 * @param {HTMLElement} o.sideLine  脇の下の一行（#connLost）
 * @param {HTMLElement} o.live      画面外の role=status（#connLive）
 * @param {(key: string, opts?: object) => string} o.t
 * @param {(ms: number) => string} o.time  確かめた時刻の書き方（HH:MM）
 * @param {() => HTMLElement} o.runMark
 * @param {() => Promise<'ok'|'denied'|'unreachable'>} o.check  今のトークンが HTTP で通るか
 * @param {() => void} o.reconnect  WebSocket を開き直す
 * @param {() => void} [o.onChange] 送信の押せる・押せないが変わったとき
 */
export function createConnectionStatus({ note, sideLine, live, t, time, runMark, check, reconnect, onChange = () => {},
  delay = 1500, retryMs = 1500, minBusy = 500, doneMs = 6000, setTimer = setTimeout, clearTimer = clearTimeout, now = () => Date.now() }) {
  let phase = 'online';     // online | down（自動で戻る見込み）| stale（トークンが古い）
  let shown = false;        // 切れた一行を出したか（1.5 秒続いた）
  let socketOpen = false;   // 今の WebSocket が一度でも開いたか
  let failedOpens = 0;      // 続けて開けなかった回数
  let checking = false;
  let reason = null;        // リモートの窓で、中継・ホストにつながらない理由（relay | host）
  let result = null;        // 案内の中の確認の結果 { kind: checking | stale | unreachable, at }
  let manual = false;       // 「再確認」から戻ろうとしている
  let done = null;          // 「再確認」から戻った時刻（しばらく出して消す）
  let showTimer = null, retryTimer = null, doneTimer = null;

  // 案内の面は作り置き、文言だけ替える（押したボタンからフォーカスを落とさない）
  const title = document.createElement('b');
  const body = document.createElement('div');
  const status = document.createElement('div');
  status.className = 'conn-result';
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'btn';
  button.onclick = () => recheck();
  const panelText = document.createElement('div');
  panelText.append(title, body, status);

  const lostText = () => (reason === 'relay' ? t('app.connLostRelay') : reason === 'host' ? t('app.connLostHost') : t('app.connLost'));
  const staleText = () => `${t('app.authStale.title')} ${t('app.authStale.body')}`;
  function resultText() {
    if (!result) return '';
    if (result.kind === 'checking') return t('app.authStale.checking');
    const at = { time: time(result.at) };
    return result.kind === 'stale' ? t('app.authStale.stillStale', at) : t('app.authStale.unreachable', at);
  }
  function announce(text) { live.textContent = text; }

  function render() {
    if (phase === 'stale') {
      sideLine.textContent = t('app.authStale.title');
      sideLine.dataset.kind = 'stale';
      sideLine.hidden = false;
    } else {
      delete sideLine.dataset.kind;
      sideLine.removeAttribute('data-kind');
      sideLine.hidden = !(phase === 'down' && shown);
      if (!sideLine.hidden) sideLine.textContent = lostText();
    }
    if (phase === 'stale') {
      title.textContent = t('app.authStale.title');
      body.textContent = t('app.authStale.body');
      status.textContent = resultText();
      status.hidden = !result;
      button.textContent = t('app.authStale.recheck');
      button.setAttribute('aria-disabled', String(result?.kind === 'checking'));
      if (note.dataset.kind !== 'stale') note.replaceChildren(panelText, button);
      note.dataset.kind = 'stale';
      note.hidden = false;
      return;
    }
    const line = phase === 'down' && shown ? lostText() : done ? t('app.reconnectedAt', { time: time(done) }) : '';
    if (!line) { note.replaceChildren(); note.hidden = true; delete note.dataset.kind; note.removeAttribute('data-kind'); return; }
    const span = document.createElement('span');
    span.textContent = line;
    note.replaceChildren(...(phase === 'down' ? [runMark()] : []), span);
    note.dataset.kind = phase === 'down' ? 'lost' : 'done';
    note.hidden = false;
  }

  function scheduleReconnect(ms = retryMs) {
    clearTimer(retryTimer);
    retryTimer = setTimer(() => { retryTimer = null; if (phase !== 'stale') reconnect(); }, ms);
  }

  function goStale() {
    const was = phase;
    phase = 'stale';
    shown = false;
    clearTimer(showTimer); showTimer = null;
    clearTimer(retryTimer); retryTimer = null;
    render();
    if (was !== 'stale') announce(staleText());
    onChange();
  }

  /** 続けて開けなかった。トークンが通るかを HTTP で 1 回だけ確かめる */
  async function autoCheck() {
    checking = true;
    let answer;
    try { answer = await check(); } catch { answer = 'unreachable'; }
    checking = false;
    if (phase !== 'down') return;
    if (answer === 'denied') return goStale();
    scheduleReconnect();
  }

  /** 案内の「再確認」。確かめている間は「確認しています…」、終わったら時刻と結果 */
  async function recheck() {
    if (phase !== 'stale' || result?.kind === 'checking') return;
    result = { kind: 'checking' };
    render();
    const started = now();
    let answer;
    try { answer = await check(); } catch { answer = 'unreachable'; }
    // 一瞬で終わっても「確認しています…」を読めるだけ残す
    const wait = minBusy - (now() - started);
    if (wait > 0) await new Promise((resolve) => setTimer(resolve, wait));
    if (phase !== 'stale') return;
    if (answer === 'ok') {
      // トークンが通った。案内をたたみ、切れた一行のまま開き直す（戻れば「再接続しました」）
      const hadFocus = document.activeElement === button;
      result = null;
      phase = 'down';
      shown = true;
      manual = true;
      failedOpens = 0;
      render();
      // 押したボタンは消える。フォーカスを body に落とさず、同じ場所の一行に置く（キーボードは出さない）
      if (hadFocus) { note.tabIndex = -1; note.focus?.({ preventScroll: true }); }
      onChange();
      reconnect();
      return;
    }
    result = { kind: answer === 'denied' ? 'stale' : 'unreachable', at: now() };
    render();
    announce(resultText());
  }

  return {
    /** WebSocket が開いた（ready の前） */
    opened() { socketOpen = true; failedOpens = 0; },
    /** ready が届いた。切れた一行・案内を消し、出していたなら「再接続しました」を読む */
    ready() {
      const wasVisible = shown || phase === 'stale';
      const byHand = manual;
      phase = 'online';
      shown = false; manual = false; result = null; failedOpens = 0;
      clearTimer(showTimer); showTimer = null;
      clearTimer(retryTimer); retryTimer = null;
      clearTimer(doneTimer); doneTimer = null;
      done = null;
      if (byHand) {
        done = now();
        doneTimer = setTimer(() => { doneTimer = null; done = null; render(); }, doneMs);
      }
      render();
      if (wasVisible) announce(t('app.reconnected'));
      onChange();
    },
    /** WebSocket が閉じた。開き直すのはここ（トークンが古いと分かったら開き直さない） */
    closed() {
      const wasOpen = socketOpen;
      socketOpen = false;
      if (phase === 'stale') return;
      if (!wasOpen) failedOpens++;
      if (phase === 'online') {
        phase = 'down';
        clearTimer(doneTimer); doneTimer = null; done = null;
        render();
        clearTimer(showTimer);
        showTimer = setTimer(() => {
          showTimer = null;
          if (phase !== 'down') return;
          shown = true;
          render();
          announce(lostText());
        }, delay);
      }
      if (!checking && failedOpens >= 2 && failedOpens % 2 === 0) { autoCheck(); return; }
      if (!checking) scheduleReconnect();
    },
    /** リモートの窓の理由（中継・ホストにつながらない）。一行の文言をバッジと同じ理由の語にそろえる */
    setReason(next) {
      const value = next === 'relay' || next === 'host' ? next : null;
      if (value === reason) return;
      reason = value;
      render();
    },
    recheck,
    /** トークンが古いと分かった間は送信を押せない（押しても届かない口を残さない） */
    blocksSend: () => phase === 'stale',
    get phase() { return phase; },
  };
}
