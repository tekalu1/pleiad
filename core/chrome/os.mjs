// OS ごとの層の口（docs/inapp-browser.md「OS ごとの層」、ADR 0153）。
//
// 窓を前に出す・確認の窓を見つけて閉じる、といった OS で違う操作は、すべてこの口の向こう（Electron main の desktop/chrome-os/<os>.cjs）に
// 閉じ込める。core/chrome/ のほかのファイルは OS の値（窓のハンドルなど）を解釈せず、この口だけを呼ぶ。
// 実装があるのは Windows だけ。ほかの OS・Electron の無いホストでは capabilities().supported が false になり、
// エージェントのブラウザーは「この OS ではまだ使えません」になる。
//
// どの口も、使えない OS・使えない機能・時間切れでは投げずに null / false を返す（呼び出し側は、層が無くても進める作りにする）。
//
// @typedef {{ id: string }} WindowRef   層が出した値。core は覚える・比べる・返すだけ（Windows は窓のハンドルの 10 進）。層が出していない値には何もしない
// @typedef {{ supported: boolean, reason?: string, features: { dialog: boolean, raise: boolean, launch: boolean, conceal: boolean, watch: boolean, bounds: boolean } }} Capabilities
//
// capabilities()                         → Capabilities（同期。main の chrome-os-ready を受けるまでは pending）
// ready()                                → Promise<Capabilities>（main の返事を待つ。返事が無ければ supported: false）
// onReady(fn)                            → 外す関数。層が作り直された（main の再起動）ときも呼ぶ
// snapshotWindows()                      → Promise<string[] | null>  今あるブラウザーの最上位の窓の印（findPermissionDialog の比べ元。中身は層だけが解く）
// findPermissionDialog({ since, port })  → Promise<WindowRef | null>  since に無い、見えている、小さい（外形が 1000×700 DIP 以下）ブラウザーの窓＝リモート デバッグの確認。
//                                          port（DevToolsActivePort のポート）があれば、その待ち受けのプロセスの窓だけ（別の User Data の Chrome と取り違えない）
// raise(ref)                             → Promise<{ ok: boolean, method: string }>  窓を前に出す（最小化なら戻す）。method は direct・attach・failed など
// yieldForeground(ref, { to })           → Promise<boolean>  ref が前面を取っていたら to（直前の前面）に返す
// foreground()                           → Promise<{ id: string, browser: boolean } | null>  今の前面の窓。browser はブラウザー自身の窓か
// appWindow()                            → Promise<WindowRef | null>  Pleiad 自身の窓（Electron main の窓）。引き継ぎで窓を戻す画面を、押した時の前面でなく Pleiad の窓のある画面にする
// generation()                           → number  層が入れ替わった（main が替わった・main との縁が切れた）回数。引き継ぎの途中で層が入れ替わり、呼び出しが「聞けなかった」だけなのを、
//                                          「見つからなかった」と取り違えないために使う（windows.mjs の readopt）
// close(ref)                             → Promise<boolean>  確認の窓を閉じる（層が確認として出した ref だけ）
//
// エージェントの専用の窓（ADR 0154。core/chrome/windows.mjs が使う）。層が出した ref・browser 以外には何もしない
// locateBrowser({ product })             → Promise<{ id, product } | null>  ブラウザーの実行ファイル（Windows はレジストリの App Paths → 既定の 3 か所）。id は launchWindow だけが使える
// launchWindow({ browser, profileDir, url, nonce, userDataDir?, position?, size? })
//                                        → Promise<{ ok: boolean }>  chrome.exe --profile-directory --new-window。url は題に nonce を持つ data: のページ。
//                                          userDataDir があれば --user-data-dir を必ず付ける（無ければ既定の User Data）。position（物理画素）・size（DIP）は一瞬見えるのを避ける
// findWindowByNonce(nonce)               → Promise<WindowRef | null>  題に nonce を持つブラウザーの窓
// findWindowByBounds({ bounds, port, since, tolerance })
//                                        → Promise<WindowRef | null>  外形が bounds（CDP の Browser.getWindowBounds。DIP）に合う、まだ出していない窓がちょうど 1 つのとき（popup の別窓）。
//                                          port（つないだ Chrome の DevToolsActivePort）の待ち受けのプロセスの窓だけ。持ち主が分からなければ null（利用者の窓・Edge の窓を取り違えて隠さない）。
//                                          since（snapshotWindows の写し）の窓は除く。tolerance は位置・大きさの許容（DIP。既定 16、最小 1）
// hiddenSpot()                           → Promise<{ x, y } | null>  仮想デスクトップの右の外（物理画素）。createTarget の left・top と --window-position に使う
// conceal(ref)                           → Promise<boolean>  画面の外へ置き、タスクバーと Alt+Tab から外し、透明度 0・マウスの素通しにする。最小化はしない。かけ直せる
//                                          隠している間、層が前面の見張りを持ち、隠した窓が前面を取ったら直前の前面へ返す（第 6 段の引き継ぎの外）
// reveal(ref, { near })                  → Promise<boolean>  conceal の逆。near（層が出した ref）のあるモニターの中へ戻す。前には出さない（第 6 段の「引き継ぐ」）
// release(ref)                           → Promise<boolean>  窓の記録だけを捨てる（窓には触らない。窓が閉じた）
// closeAgent(ref)                        → Promise<boolean>  エージェントの窓を閉じる（WM_CLOSE）。窓がもう無ければ記録を捨てて true。閉じる依頼が出せなければ見える形へ戻して false
//                                          （画面の外・透明のまま誰にも戻せない窓を残さない）。Chrome との接続が切れたとき・窓の開きかけの失敗に使う。
//                                          main は Pleiad の終了でも、隠している窓を全部これと同じに片付ける（closeAllAgents。main の中だけの口で、core からは呼ばない）
// exportAgent(ref)                      → Promise<string | null>  隠している窓を main の入れ替わりを越えて渡す印にする（窓は閉じない・戻さない。ADR 0167）。隠していない窓には null
// adoptAgent(token, { revealed })        → Promise<WindowRef | null>  印から窓の記録を作り直す（新しい main の層）。窓がもう無い・ブラウザーの窓でなければ null。作った窓は隠しているものとして見張る（revealed: true は人が操作中の見せている窓。隠さず見張らない）
// 画面の構成が変わったときの置き直し（reconceal）は main が Electron の screen のイベントで呼ぶので、core から呼ぶ口は無い

const FEATURES_NONE = Object.freeze({ dialog: false, raise: false, launch: false, conceal: false, watch: false, bounds: false });

/** テストとほかの OS の既定。どの口も null / false を返す */
export function unsupportedChromeOs(reason = 'platform') {
  const caps = Object.freeze({ supported: false, reason, features: FEATURES_NONE });
  return {
    kind: 'unsupported',
    capabilities: () => caps,
    ready: async () => caps,
    onReady: () => () => {},
    generation: () => 0,
    snapshotWindows: async () => null,
    findPermissionDialog: async () => null,
    raise: async () => ({ ok: false, method: 'unsupported' }),
    yieldForeground: async () => false,
    foreground: async () => null,
    appWindow: async () => null,
    close: async () => false,
    locateBrowser: async () => null,
    launchWindow: async () => ({ ok: false }),
    findWindowByNonce: async () => null,
    findWindowByBounds: async () => null,
    hiddenSpot: async () => null,
    conceal: async () => false,
    reveal: async () => false,
    release: async () => false,
    closeAgent: async () => false,
    exportAgent: async () => null,
    adoptAgent: async () => null,
  };
}

const READY_WAIT_MS = 5000;
const CALL_TIMEOUT_MS = 5000;

/**
 * parentPort 越しの口。port が無い（Electron でない）ときは no-desktop の口を返す。
 * main が `chrome-os-ready { supported, reason, features, epoch }` を返すまで capabilities() は pending（supported: false, reason: 'pending'）。
 * epoch は main の起動ごとの印。起動時の ready と chrome-os-ready-request への返事は同じ main から重なって届くので、epoch が同じ ready では待っている呼び出しを失敗にしない
 */
export function parentPortChromeOs(port, { timeoutMs = CALL_TIMEOUT_MS, readyWaitMs = READY_WAIT_MS } = {}) {
  if (!port) return unsupportedChromeOs('no-desktop');
  const pending = new Map();
  const listeners = new Set();
  let caps = Object.freeze({ supported: false, reason: 'pending', features: FEATURES_NONE });
  let isReady = false;
  let epoch = null;        // 最後に受けた ready の main の印
  let generation = 0;      // 層が入れ替わった回数
  let next = 0;
  let readyWaiters = [];

  const fire = () => { for (const fn of [...listeners]) { try { fn(caps); } catch { /* 聞き手の失敗は口を壊さない */ } } };
  const failAll = () => { for (const [id, item] of [...pending]) { pending.delete(id); clearTimeout(item.timer); item.resolve(item.fallback); } };

  port.on('message', event => {
    const message = event?.data ?? event;
    if (message?.type === 'chrome-os-ready') {
      // main が作り直された（epoch が替わった）。待っていた呼び出しはもう返らない。同じ main の ready が重なっただけ（起動時の ready と依頼への返事）なら、待っている呼び出しは生きている
      const ownEpoch = typeof message.epoch === 'string' ? message.epoch : null;
      if (isReady && ownEpoch && epoch && ownEpoch !== epoch) { generation += 1; failAll(); }
      if (ownEpoch) epoch = ownEpoch;
      isReady = true;
      const features = { ...FEATURES_NONE, ...(message.features ?? {}) };
      caps = Object.freeze({ supported: message.supported === true, ...(message.reason ? { reason: String(message.reason) } : {}), features });
      const waiters = readyWaiters; readyWaiters = [];
      for (const w of waiters) { clearTimeout(w.timer); w.resolve(caps); }
      fire();
    } else if (message?.type === 'chrome-os-result') {
      const item = pending.get(message.id);
      if (!item) return;
      pending.delete(message.id); clearTimeout(item.timer);
      item.resolve(message.ok ? (message.result ?? item.fallback) : item.fallback);
    }
  });
  const requestReady = () => { try { port.postMessage({ type: 'chrome-os-ready-request' }); } catch { /* main に届かなければ、つながり直したときに求め直す */ } };
  requestReady();
  if (port.resumable) {
    // main が付け直す口（名前付きパイプ）。main が居ない間（更新）は、待っていた呼び出しを失敗で返し、層は pending に戻す。
    // 戻ったら chrome-os-ready を求め直す（新しい main の層が答える）。docs/zero-downtime-update/design.md §7.2
    port.on('disconnect', () => {
      isReady = false;
      generation += 1;
      caps = Object.freeze({ supported: false, reason: 'pending', features: FEATURES_NONE });
      failAll();
    });
    port.on('connect', requestReady);
  }

  const call = (action, args, fallback) => {
    if (!caps.supported) return Promise.resolve(fallback);
    return new Promise(resolve => {
      const id = `co${++next}`;
      const timer = setTimeout(() => { pending.delete(id); resolve(fallback); }, timeoutMs);
      pending.set(id, { resolve, timer, fallback });
      let sent = false;
      try { sent = port.postMessage({ type: 'chrome-os', id, action, args }) !== false; } catch { /* 送れなかった */ }
      if (!sent) { pending.delete(id); clearTimeout(timer); resolve(fallback); }
    });
  };

  return {
    kind: 'electron',
    capabilities: () => caps,
    ready() {
      if (isReady) return Promise.resolve(caps);
      return new Promise(resolve => {
        const waiter = { resolve, timer: setTimeout(() => {
          readyWaiters = readyWaiters.filter(w => w !== waiter);
          resolve(Object.freeze({ supported: false, reason: 'no-desktop', features: FEATURES_NONE }));
        }, readyWaitMs) };
        readyWaiters.push(waiter);
      });
    },
    onReady(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    generation: () => generation,
    snapshotWindows: () => call('snapshotWindows', {}, null),
    findPermissionDialog: ({ since, port } = {}) => call('findPermissionDialog', { since: since ?? [], port: port ?? null }, null),
    raise: ref => call('raise', { ref }, { ok: false, method: 'failed' }),
    yieldForeground: (ref, { to } = {}) => call('yieldForeground', { ref, to }, false),
    foreground: () => call('foreground', {}, null),
    appWindow: () => call('appWindow', {}, null),
    close: ref => call('close', { ref }, false),
    locateBrowser: ({ product = 'chrome' } = {}) => call('locateBrowser', { product }, null),
    launchWindow: ({ browser, profileDir, url, nonce, userDataDir = null, position = null, size = null } = {}) =>
      call('launchWindow', { browser, profileDir, url, nonce, userDataDir, position, size }, { ok: false }),
    findWindowByNonce: nonce => call('findWindowByNonce', { nonce }, null),
    findWindowByBounds: ({ bounds, port = null, since = [], tolerance = null } = {}) => call('findWindowByBounds', { bounds, port, since, tolerance }, null),
    hiddenSpot: () => call('hiddenSpot', {}, null),
    conceal: ref => call('conceal', { ref }, false),
    reveal: (ref, { near = null } = {}) => call('reveal', { ref, near }, false),
    release: ref => call('release', { ref }, false),
    closeAgent: ref => call('closeAgent', { ref }, false),
    exportAgent: ref => call('exportAgent', { ref }, null),
    adoptAgent: (token, options = {}) => call('adoptAgent', { token, revealed: options.revealed === true }, null),
  };
}
