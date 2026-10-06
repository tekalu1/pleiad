// 切り替えの待ちの表示への橋（無停止の更新 段階 1 の 1-6。docs/zero-downtime-update/design.md §6.1、docs/design-system.md「切り替えを待つ表示」）。
// 切り替えの状態機械（desktop/switch.cjs）の snapshot を、窓の画面へ渡し、画面の操作（今すぐ中断・あとで・もう一度試す）を状態機械へ返す。
//
// 待っている間の窓が出しているのは、古い版のサーバー（S1）が配る古い版の web/ の画面。表示のコードは「その版の web/」にあり、
// 更新で入れ替わった新しい main がこの橋で状態を渡す。だから橋は版をまたいで読める形にする:
//   - 橋は版つきの名前で出す（preload の plyDesktop.switch が版 1。口の形を変えるときは switch2 を足し、switch は 1 版ぶん残す）。
//     main は出せる版ごとの形（payload）を同時に送る（BRIDGE_VERSIONS・payloadFor）。画面は自分が読める版の口だけを使う
//   - 画面は読み込むとき、使う口の版を hello で知らせる。**main は hello が来た版の画面にだけ表示を任せる**。
//     hello が来ない画面（この機能を持たない版の画面。この機能を持つ最初の版への更新）には、最小限の main 側のダイアログ
//     （止まるものが残ったとき・合わない版を聞くとき・前の版に戻したとき）を出し、待っている間は何も出さない（ログだけ）。何も出さない理由:
//     待ちは利用者が選んだ「止まらない更新」の続きで、作業が終われば自動で切り替わる。聞くべきことだけをダイアログにする
//   - payload は欠けた項目・知らない項目を許す（読む側は無いものを空として扱う）。v は項目の形が変わったときだけ上げる
const BRIDGE_VERSIONS = [1];
/** 画面の hello を待つ上限（窓の読み込み中に聞く場面が来たとき） */
const HELLO_WAIT_MS = 8000;
const LIST_MAX = 100;

const channelOf = version => (version === 1 ? 'ply:switch-state' : `ply:switch-state-${version}`);
const pickItem = item => ({ kind: item.kind, sessionId: item.sessionId ?? null, backend: item.backend ?? null, label: item.label ?? null });
const pickList = list => (list ?? []).slice(0, LIST_MAX).map(pickItem);

/**
 * snapshot（desktop/switch.cjs）→ 画面へ渡す形（版 1）。phase:
 *   none       何も出さない（切り替えが要らない・始まる前・main が終わる）
 *   waiting    作業が終わるのを待っている（since・items・stoppers。interruptFailed は中断が止まらなかった）
 *   asking     作業が終わり、止まるものだけが残った。「あとで／止めて切り替え」を聞いている（stoppers）
 *   manual     合わない版。「あとで／中断して切り替え」を聞いている（reason は schema・ipc・runtime・job・check。items・stoppers）
 *   held       「あとで」の後（kind: 'stoppers' | 'manual'）。脇の知らせは閉じ、⚙ の点と設定のページに残す
 *   stopping   「今すぐ中断して切り替える」で中断している（interrupt: { done, total }）
 *   switching  S1 を終わらせ、S2 を起こし、窓を読み直している（1〜2 秒）
 *   done       切り替えが済んだ（stopped は切り替えで止めたもの）。読み直した後の新しい画面が受ける
 *   failed     新しい版が起こせず、前の版で動いている（current が動いている版）。「もう一度試す」
 */
function displayState(snap) {
  const base = { v: 1, phase: 'none', target: snap?.target?.appVersion ?? null, current: snap?.server?.appVersion ?? null };
  const lists = () => ({ items: pickList(snap.waiting?.items), stoppers: pickList(snap.waiting?.stoppers) });
  switch (snap?.state) {
    case 'waiting': case 'locking':
      return { ...base, phase: 'waiting', since: snap.since ?? null, interruptFailed: snap.interruptFailed === true, ...lists() };
    case 'asking':
      return { ...base, phase: 'asking', ...lists() };
    case 'incompatible':
      return { ...base, phase: 'manual', reason: snap.reason, ...lists() };
    case 'held':
      return { ...base, phase: 'held', kind: snap.reason === 'stoppers' ? 'stoppers' : 'manual', reason: snap.reason, ...lists() };
    case 'interrupting':
      return (snap.interrupt?.total ?? 0) > 0 ? { ...base, phase: 'stopping', interrupt: snap.interrupt } : { ...base, phase: 'switching' };
    case 'stopping': case 'starting': case 'fallback': case 'reloading':
      return { ...base, phase: 'switching' };
    case 'done':
      return snap.previous ? { ...base, phase: 'failed', at: snap.at ?? null } : { ...base, phase: 'done', at: snap.at ?? null, stopped: pickList(snap.stopped) };
    default:
      return base;
  }
}

/** 版ごとの payload。出せない版は null */
function payloadFor(snap, version) {
  return version === 1 ? displayState(snap) : null;
}

/**
 * 画面との橋。ipcMain の口を作り、状態機械（attach）の変化を窓へ送る。
 *   ipcMain / trusted   electron の ipcMain と、ローカルの窓の画面からの呼び出しかを確かめる関数（main.cjs の trusted）
 *   getWindow           表示を出す窓（ローカルの窓だけ。リモートの窓・スマホの画面には出さない）
 */
function createSwitchScreen({ ipcMain, trusted, getWindow, helloWaitMs = HELLO_WAIT_MS, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let control = null;
  let screenVersion = null;
  const last = new Map();
  const waiters = new Set();

  const send = (version, force = false) => {
    const win = getWindow();
    if (!control || !win || win.isDestroyed()) return;
    const payload = payloadFor(control.snapshot(), version);
    const text = JSON.stringify(payload);
    if (!force && last.get(version) === text) return;
    last.set(version, text);
    win.webContents.send(channelOf(version), payload);
  };
  const publish = () => { for (const version of BRIDGE_VERSIONS) send(version); };

  ipcMain.on('ply:switch-hello', (event, version) => {
    try { trusted(event); } catch { return; }
    if (!BRIDGE_VERSIONS.includes(version)) return;
    screenVersion = version;
    for (const wake of [...waiters]) wake();
    // 読み込み直した画面は、今の状態を取り直す（getState）ほかに、変わらないままでも 1 回は受け取る
    send(version, true);
  });
  ipcMain.handle('ply:switch', (event, action, value) => {
    trusted(event);
    if (action === 'state') return payloadFor(control?.snapshot() ?? null, Number(value) || 1);
    if (action !== 'act' || !control) return false;
    if (value === 'retry') return control.retry();
    return control.answer(value);
  });

  return {
    /** 状態機械をつなぐ。状態が変わるたびに窓へ送る */
    attach(next) {
      control = next;
      next.onState(publish);
      publish();
    },
    /** 窓を読み込み直す（別の版の画面になりうる）。その画面の hello が来るまで、表示を持つかは分からない */
    reset() { screenVersion = null; last.clear(); },
    /** 窓の画面が、切り替えの表示を持つ（hello が来た）か */
    supported() { return screenVersion !== null; },
    /**
     * effects.ask: 表示を持つ画面なら null（画面が control.answer で答える）、持たなければ dialogFor(info) のダイアログ。
     * 窓が読み込み中で hello がまだなら、少し待つ
     */
    async ask(info, dialogFor) {
      if (screenVersion === null) {
        await new Promise(resolve => {
          const wake = () => { clearTimer(timer); waiters.delete(wake); resolve(); };
          const timer = setTimer(wake, helloWaitMs);
          waiters.add(wake);
        });
      }
      return screenVersion !== null ? null : dialogFor(info);
    },
  };
}

module.exports = { BRIDGE_VERSIONS, HELLO_WAIT_MS, displayState, payloadFor, createSwitchScreen };
