// エージェントのブラウザー（PC の Chrome）の「人を待つ」場面の台帳（ADR 0148・0153・0168、docs/inapp-browser.md）。
//   - 接続の案内（connect）: Chrome の許可の確認を待つ。中継（core/chrome/relay.mjs）が、接続が無いまま 20 秒抱えるときに出す。
//     Chrome の状態 A〜D（setup / permission / denied）はカードの中身として写し、つながったら決着する
//   - 人への依頼（ask）: ログイン・CAPTCHA・2 段階認証・支払いなど。ply_browser の hand_to_user から出す。
//     「Chrome で操作する」（一時停止）→「Claude に戻す」（再開）は第 6 段の core/chrome/control.mjs が持ち、ここは control の変化を見て決着させる
// 待ちは askPermission の outlivesTurn（ターンが終わっても残る。ADR 0168）で出す。カードの id は替えず、中身は onOpen の update で差し替える。
// 会話ごとに開いている依頼は 1 つまで。決着したとき、待っている hand_to_user があればそこへ答え、無くてターンが走っていれば次の wait のために置き、
// ターンが終わっていれば（かつ切り替え・分岐の最中でなければ）会話へ「続けてください」を 1 回だけ送る。
//
// control の形（差し込む口。第 6 段の core/chrome/control.mjs が合わせる）:
//   state(sessionId) -> { state: 'running'|'idle'|'stopped'|'paused', by?: 'pc'|'device', url?, title? }
//   onChange(fn(sessionId | { sessionId, ... })) -> off（core/chrome/control.mjs は状態そのものを配る）
//   takeOver(sessionId, opts)・resume(sessionId) はカードのボタンが ops から呼ぶので、ここでは使わない
// control は中継の後に作られる（中継はこの台帳を受け取る）ので、後から useControl(control) で差し込める。
import crypto from 'node:crypto';

export const HANDOFF_REASONS = ['login', 'captcha', 'two_factor', 'payment', 'other'];
const MESSAGE_MAX = 200;
const CONNECT_STATES = new Set(['setup', 'permission', 'denied']);

/** 「続けてください」の送信の id。カードの id から決まる UUID の形の値（同じ id・同じ引数の outbox.accept は 1 件にまとまる） */
export function continuationMessageId(cardId) {
  const hex = crypto.createHash('sha256').update(`chrome-handoff:${cardId}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

const cleanMessage = value => {
  const text = typeof value === 'string' ? value.trim().slice(0, MESSAGE_MAX) : '';
  return text || null;
};

/**
 * @param {object} deps
 * @param deps.askPermission  server の askPermission（outlivesTurn・onOpen・onSettle を使う）
 * @param deps.connection     core/chrome/connection.mjs（state()・demand({ signal })・onChange）
 * @param [deps.control]      第 6 段の control（上の形）。無ければ「あなたが操作中」は出ない
 * @param deps.sessionBusy    ターン・切り替え・分岐の最中か
 * @param [deps.turnLive]     この会話のターンが走っているか（既定は sessionBusy）
 * @param [deps.turnSignal]   (sessionId) => 走っているターンの中断の合図（人の「止める」・子の取り消しで待ちを片付ける）。ターンの終わりでは abort されない
 * @param deps.continueTurn   (sessionId, { kind, messageId }) => Promise。会話へ「続けてください」を送る（outbox.accept）
 * @param [deps.titleFor]     ({ reason, message }) => カードの題（通知の一覧・端末の通知に出る）
 */
export function createChromeHandoffs({ askPermission, connection, control: initialControl = null, sessionBusy, turnLive = sessionBusy, turnSignal = () => undefined, continueTurn, titleFor = () => '', now = () => new Date(), log = () => {} }) {
  const open = new Map();      // sessionId -> Handoff（決着するまで）
  const unclaimed = new Map(); // sessionId -> 決着した答え（ターンの中で、まだ誰にも返していないもの）
  let closed = false;

  const connectPayload = () => {
    const status = connection.state();
    return { state: CONNECT_STATES.has(status.state) ? status.state : 'setup', dialog: status.dialog === true };
  };

  /** カードの中身を差し替える。onOpen の前（askPermission が祖先を読んでいる間）の分はためておく */
  const patch = (h, fields) => {
    if (h.done) return;
    h.shown = { ...h.shown, ...fields };
    if (h.card) h.card.update(fields); else h.queued = { ...h.queued, ...fields };
  };

  function create(sessionId, reason, message, browserHandoff) {
    const h = { sessionId, reason, message, card: null, queued: null, shown: browserHandoff, ac: new AbortController(), waiters: new Set(), done: false,
      operating: false, window: { url: null, title: null }, early: null, startedAt: now().getTime() };
    open.set(sessionId, h);
    h.answer = askPermission({
      kind: 'tool', toolName: 'ply_browser', input: { reason, message }, title: titleFor({ reason, message }), sessionId,
      browserHandoff: { ...browserHandoff, turnLive: turnLive(sessionId), windowTitle: null, by: null },
      outlivesTurn: true,
      signal: turnSignal(sessionId),
      onOpen: card => {
        h.card = card;
        if (h.queued) { card.update(h.queued); h.queued = null; }
        if (h.early) card.settle(h.early);
      },
      onSettle: raw => finish(h, raw),
    }).then(() => { if (!h.done) finish(h, null); }, () => { if (!h.done) finish(h, null); });
    return h;
  }

  /** 決着。raw は askPermission の答え（messageKey 付き）。無いのは待ちを出さずに断られた場合 */
  function finish(h, raw) {
    if (h.done) return;
    h.done = true;
    if (open.get(h.sessionId) === h) open.delete(h.sessionId);
    h.ac.abort();
    let result;
    // 接続の案内は、本当につながったときだけ「つながった」を返す。外から来た allow:true（端末の中継など）では決着させない（偽の「つながりました」を子に返さない）
    const forged = raw?.allow === true && h.reason === 'connect' && connection.state().state !== 'connected';
    if (raw?.allow === true && !forged) {
      const response = raw.response ?? {};
      result = { kind: response.kind ?? (h.reason === 'connect' ? 'connected' : 'resumed'), at: response.at ?? now().toISOString(), url: response.url ?? h.window.url, title: response.title ?? h.window.title, continued: false };
      if (!h.waiters.size) {
        if (turnLive(h.sessionId)) unclaimed.set(h.sessionId, result);
        else if (response.continued !== false && !sessionBusy(h.sessionId)) {
          result.continued = true;
          Promise.resolve(continueTurn(h.sessionId, { kind: result.kind, messageId: continuationMessageId(h.card?.id ?? `${h.sessionId}:${result.at}`) }))
            .catch(error => log(`chrome: handoff continue failed: ${error?.message ?? error}`));
        }
      }
    } else {
      // 人の「断る」だけが declined。中断（止める・子の取り消し・host が離れた）は aborted（何も送らない）
      const declined = Boolean(raw) && !forged && !['aborted', 'hostAway', 'turnEnded', 'hiddenConversation'].includes(raw.messageKey);
      // 依頼元の端末の人が「Chrome を使わずに続けてもらう」を選んだ（子には、断られたのではなく Chrome 抜きで進めてよいと返す）
      result = { kind: declined ? 'declined' : 'aborted', ...(declined && raw.messageKey === 'chromeSkipped' ? { skipped: true } : {}) };
    }
    const waiters = [...h.waiters];
    h.waiters.clear();
    for (const waiter of waiters) waiter(result);
  }

  /** 戻した・つながった。外から決着させる（resolvePermission を通さない） */
  function resolveWith(h, kind) {
    if (h.done) return;
    const continued = !h.waiters.size && !turnLive(h.sessionId) && !sessionBusy(h.sessionId);
    const answer = { allow: true, always: false, scope: 'once', response: { kind, at: now().toISOString(), url: h.window.url, title: h.window.title, continued } };
    if (h.card) h.card.settle(answer); else h.early = answer;
  }

  function startConnect(sessionId) {
    const h = create(sessionId, 'connect', null, { reason: 'connect', message: null, ...connectPayload() });
    // 中継の 20 秒の待ちが外れても試行は止めない。カードが待つ人になる（core/chrome/connection.mjs の demand）
    connection.demand({ signal: h.ac.signal }).then(
      () => resolveWith(h, 'connected'),
      error => {
        if (error?.code === 'declined') { const answer = { allow: false, messageKey: 'userDenied' }; if (h.card) h.card.settle(answer); else h.early = answer; }
      });
    return h;
  }

  const offConnection = connection.onChange?.(status => {
    for (const h of [...open.values()]) {
      if (h.reason !== 'connect' || h.done) continue;
      if (status.state === 'connected') resolveWith(h, 'connected');
      else if (CONNECT_STATES.has(status.state)) patch(h, { state: status.state, dialog: status.dialog === true });
    }
  });

  let control = null;
  let offControl = null;
  const onControlChange = change => {
    const sessionId = typeof change === 'string' ? change : change?.sessionId;
    const h = open.get(sessionId);
    if (!h || h.done || h.reason === 'connect') return;
    const status = control.state(sessionId) ?? {};
    if (status.state === 'paused') {
      h.operating = true;
      h.window = { url: status.url ?? h.window.url, title: status.title ?? h.window.title };
      patch(h, { state: 'operating', by: status.by ?? 'pc', windowTitle: h.window.title });
    } else if (h.operating) {
      resolveWith(h, 'resumed');
    }
  };
  /** control を差し込む・差し替える（前の聞き手は外す） */
  const useControl = next => {
    offControl?.();
    control = next ?? null;
    offControl = control?.onChange?.(onControlChange) ?? null;
  };
  useControl(initialControl);

  return {
    useControl(next) { if (!closed) useControl(next); },

    /** 接続の案内を出す（開いていれば何もしない。つながっていれば出さない）。中継の upFor から */
    connect(sessionId) {
      if (closed || !sessionId) return null;
      const existing = open.get(sessionId);
      if (existing) return existing;
      // ターンの外の接続（終わったターンの後ろに残った agent-browser など）は、頼んだ人が居ない。案内を出すと、つながった時に誰も頼んでいない「続けてください」が飛ぶ
      if (!turnLive(sessionId)) return null;
      const status = connection.state();
      if (status.state === 'connected' || status.state === 'unsupported') return null;
      return startConnect(sessionId);
    },

    /** 人への依頼を出す。開いている依頼（接続の案内・操作中）があれば新しく出さずにそれを返す。hand_to_user から */
    ask(sessionId, { reason, message } = {}) {
      if (closed || !sessionId) return null;
      const existing = open.get(sessionId);
      if (existing) return existing;
      // 決着した答えが、まだ誰にも返されていない（呼ぶ前に人が済ませた）。新しく頼まず、wait がその答えを返す
      if (unclaimed.has(sessionId)) return null;
      const status = connection.state();
      if (status.state === 'unsupported') return null;
      // 窓が無いと「Chrome で操作する」が押せない。接続の案内に読み替える
      if (status.state !== 'connected') return startConnect(sessionId);
      const kind = HANDOFF_REASONS.includes(reason) ? reason : 'other';
      const text = cleanMessage(message);
      const h = create(sessionId, kind, text, { reason: kind, message: text, state: 'asked', dialog: false });
      // 人が先に「引き継ぐ」を押していた（一時停止中）なら、「あなたが操作中」から始める
      const paused = control?.state?.(sessionId);
      if (paused?.state === 'paused') {
        h.operating = true;
        h.window = { url: paused.url ?? null, title: paused.title ?? null };
        patch(h, { state: 'operating', by: paused.by ?? 'pc', windowTitle: h.window.title });
      }
      return h;
    },

    /**
     * 今の依頼を待つ。{ kind: 'resumed'|'connected'|'declined'|'aborted'|'waiting'|'none', at?, url?, title?, continued? }。
     * sliceMs で返すときは waiting（カードは残る。呼び直すと同じ依頼に戻る）、signal（ターンの中断）で返すときは aborted
     */
    wait(sessionId, { sliceMs, signal } = {}) {
      const result = unclaimed.get(sessionId);
      if (result) { unclaimed.delete(sessionId); return Promise.resolve(result); }
      const h = open.get(sessionId);
      if (!h || h.done) return Promise.resolve({ kind: 'none' });
      return new Promise(resolve => {
        let timer = null;
        const done = value => {
          clearTimeout(timer);
          signal?.removeEventListener?.('abort', onAbort);
          h.waiters.delete(done);
          resolve(value);
        };
        const onAbort = () => done({ kind: 'aborted' });
        if (signal?.aborted) return resolve({ kind: 'aborted' });
        signal?.addEventListener?.('abort', onAbort, { once: true });
        // 待った長さ（分）は子へ返す。子が「まだ待つか、Chrome を使わずに進めるか」を決める手がかり
        if (sliceMs > 0) timer = setTimeout(() => done({ kind: 'waiting', minutes: Math.max(1, Math.round((now().getTime() - h.startedAt) / 60_000)) }), sliceMs);
        h.waiters.add(done);
      });
    },

    /** ターンの始まり・終わり。開いている依頼のカードのボタン（Claude に戻す／戻して続ける）を替える。終わりでは置いた答えを捨てる */
    turnChanged(sessionId, live) {
      const h = open.get(sessionId);
      if (h) patch(h, { turnLive: Boolean(live) });
      if (!live) unclaimed.delete(sessionId);
    },

    /** 会話を消した。開いている依頼は中断として片付ける */
    forget(sessionId) {
      unclaimed.delete(sessionId);
      const h = open.get(sessionId);
      if (!h) return;
      const answer = { allow: false, messageKey: 'aborted' };
      if (h.card) h.card.settle(answer); else h.early = answer;
    },

    /** 今、開いている依頼の中身（試験・診断用） */
    current(sessionId) { const h = open.get(sessionId); return h ? { reason: h.reason, ...h.shown } : null; },

    close() {
      closed = true;
      offConnection?.();
      offControl?.();
      for (const h of [...open.values()]) { if (h.card) h.card.settle({ allow: false, messageKey: 'aborted' }); else h.ac.abort(); }
      open.clear();
      unclaimed.clear();
    },
  };
}
