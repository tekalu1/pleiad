// 会話ごとの専用の Chrome の窓（docs/inapp-browser.md「Chrome の中継（開発中）」、ADR 0148・0154）。中継（core/chrome/relay.mjs）の scope の口。
//
// 窓は最小化しない。画面の外へ置き、タスクバーと Alt+Tab から外し、透明度 0・マウスの素通しにする（OS の層の conceal。desktop/chrome-os/win32.cjs）。
//   - 会話の最初の窓: chrome.exe --profile-directory --new-window（プロフィールは Local State の profile.last_used。AGENT_HOST_CHROME_USER_DATA があれば
//     --user-data-dir を必ず付ける）。題に nonce を持つ data: のページで開き、題の nonce で窓を見つけて隠し、前面を取っていたら直前の前面へ返す。
//     窓が見つからない・chrome.exe を起こせないときは、createTarget の新しい窓に落とす（プロフィールは選べない）
//   - 2 枚目からのタブ: 新しい窓（createTarget に画面の外の位置を渡す。題の nonce で窓を見つけて隠す）。同じ窓へ足すと、裏のタブは hidden になり
//     描画が止まる（agent-browser の tab tN が送る bringToFront は中継が握りつぶすので、前へ出せない）ので、タブごとに窓を持つ
//   - window.open の popup の別窓: 中継が範囲に足したあと adoptPopup。外形（CDP の Browser.getWindowBounds）で窓を見つけて隠す。
//     外形で探すときは、先に CDP でその窓を一意な位置（画面の外）へ置き、つないだ Chrome のプロセスの窓で、開く前の写しに無いものだけを見る
//     （利用者の窓・Edge の窓・別の Chrome の窓を取り違えて隠さない）。プロセスが分からなければ採用しない
//   - Chrome の接続が切れたとき・窓の開きかけに失敗したときは、隠した窓を閉じる（閉じられなければ見える形へ戻す）。見えない窓を残さない
// 引き継ぎ（ADR 0154。control.mjs が呼ぶ）: reveal は会話の窓を見える形に戻して（Pleiad の窓のある画面の中へ）前に出し、conceal は画面の外の見えない窓に戻す。
// 見えている間は、層の前面の見張りがその窓を見ない（層の reveal が窓の隠した印を外す）。見えている間に開いた popup は隠さず、戻すときに探して隠す
// 窓の大きさ（DIP）は Pleiad が決める（Browser.setWindowBounds）。窓の ref は層が出した値で、core は覚えて返すだけ。
// ログには窓の題・URL・プロフィール名を出さない。
import crypto from 'node:crypto';
import { readLastUsedProfile } from './locate.mjs';

/**
 * 窓の大きさ（DIP。外形）。右パネルの映像（第 5 段）の元の大きさで、右パネルの幅（既定で約 430〜540 px）に縮めて映すので、窓が広いほど字が小さくなる。
 * 1100×720（第 4 段の想定）は 0.4〜0.5 倍で本文の 14px が 6px 前後になり読めなかったため、800×800 にした（実機 2026-10-08。理由は docs/inapp-browser.md「窓の大きさ」）。
 * 画面は 800×800 の外形のとき、ページ（viewport）が約 800×660 になる
 */
export const WINDOW_DIP = Object.freeze({ width: 800, height: 800 });
const DEFAULT_TIMING = { hwndWaitMs: 3000, hwndPollMs: 20, targetWaitMs: 8000, targetPollMs: 50, popupWaitMs: 3000, boundsWaitMs: 1000, navigateMs: 15_000 };
/** 外形で探す前に窓を置く、画面の外の位置の揺らぎ（DIP）と、最初の窓の大きさの端数。同時に外形で探す窓同士が同じ外形にならないように */
const MARK_STEP = 8, MARK_SLOTS = 20, MARK_SIZE_EXTRA = { width: 3, height: 5 }, MARK_TOLERANCE = 2;

/** 題に nonce を持つ小さなページ。窓の題が nonce になるので、層が HWND を見つけられる */
export const nonceUrl = nonce => `data:text/html,<title>PLY-${nonce}</title>`;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(check, totalMs, pollMs) {
  const end = Date.now() + totalMs;
  for (;;) {
    let value = null;
    try { value = await check(); } catch { value = null; }
    if (value) return value;
    if (Date.now() >= end) return null;
    await sleep(pollMs);
  }
}

/**
 * @param {object} deps
 * @param deps.os      core/chrome/os.mjs の口（偽物でもよい）
 * @param deps.locate  Chrome の User Data（{ userDataDir, custom? }。core/chrome/locate.mjs の chromeHomes）
 */
export function createChromeWindows({ os, locate, log = () => {}, random = () => crypto.randomBytes(8).toString('hex'), timing = {} }) {
  const time = { ...DEFAULT_TIMING, ...timing };
  const entries = new Map();   // 会話の id -> { windows: Map<windowId, { ref, nonce, role }>, queue: Promise }
  let browser;                 // undefined: まだ探していない / null: 見つからない / { id, product }
  let baseline = null;         // 直近の窓を開く前のブラウザーの窓の写し（snapshotWindows）。popup を外形で探すとき、それ以前からある窓を除く
  let markSeq = 0;

  const entryOf = id => {
    let entry = entries.get(id);
    if (!entry) { entry = { windows: new Map(), queue: Promise.resolve() }; entries.set(id, entry); }
    return entry;
  };

  async function locateBrowser() {
    if (browser === undefined || browser === null) {
      const found = await os.locateBrowser({ product: 'chrome' });
      browser = found ?? null;
      if (!found) log('chrome-windows: chrome.exe not found (opens windows with createTarget)');
    }
    return browser;
  }

  /** 窓を隠す。前面を取っていたら、窓を開く前の前面（before）へ返す。見張り（層）が残りの取りこぼしを拾う */
  async function hide(ref, before) {
    const concealed = await os.conceal(ref);
    if (!concealed) log('chrome-windows: conceal failed');
    if (before && await os.yieldForeground(ref, { to: before })) log('chrome-windows: gave the foreground back');
    return concealed;
  }

  /** 題に nonce を持つタブ（開いた窓の最初のタブ）。上りの全タブの URL は、ここで比べて捨てる */
  async function findTarget(cdp, nonce) {
    const { targetInfos = [] } = await cdp.send('Target.getTargets');
    return targetInfos.find(info => info.type === 'page' && typeof info.url === 'string' && info.url.includes(nonce))?.targetId ?? null;
  }

  async function navigate(cdp, targetId, url) {
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    try { await cdp.send('Page.navigate', { url }, sessionId, { timeoutMs: time.navigateMs }); }
    finally { await cdp.send('Target.detachFromTarget', { sessionId }).catch(() => {}); }
  }

  /**
   * 外形で窓を見つける。つないだ Chrome のプロセス（cdp.port の待ち受け）の窓だけを、呼び出しの前の写し（since）に無いものに絞って探す。
   * 探す前に、CDP でその窓を一意な位置（画面の外）へ置き、その外形でちょうど 1 つの窓を探す（取り違えを避ける。置けなければ、今の外形で探す）
   */
  async function findByBounds(cdp, windowId, since, { resize = false, waitMs = time.boundsWaitMs } = {}) {
    const port = cdp.port ?? null;
    if (!port) return null;   // つないだ Chrome のプロセスが分からない
    const current = (await cdp.send('Browser.getWindowBounds', { windowId }).catch(() => null))?.bounds;
    if (!current || ![current.width, current.height].every(Number.isFinite)) return null;
    let marked = false;
    const spot = await os.hiddenSpot();
    if (spot) {
      const size = resize ? { width: WINDOW_DIP.width + MARK_SIZE_EXTRA.width, height: WINDOW_DIP.height + MARK_SIZE_EXTRA.height } : { width: current.width, height: current.height };
      const mark = { left: spot.x + (markSeq++ % MARK_SLOTS) * MARK_STEP, top: spot.y, ...size };
      marked = await cdp.send('Browser.setWindowBounds', { windowId, bounds: mark }).then(() => true, () => false);
    }
    const now = marked ? (await cdp.send('Browser.getWindowBounds', { windowId }).catch(() => null))?.bounds ?? current : current;
    return waitFor(async () => {
      if (marked) {
        const exact = await os.findWindowByBounds({ bounds: now, port, since: since ?? [], tolerance: MARK_TOLERANCE });
        if (exact) return exact;
      }
      return since ? os.findWindowByBounds({ bounds: now, port, since }) : null;   // 写しが無ければ、ゆるい外形では探さない
    }, waitMs, time.hwndPollMs);
  }

  async function openWindow(cdp, entry, url) {
    const nonce = random();
    const features = os.capabilities().features;
    const before = await os.foreground();
    const since = features.conceal && features.bounds ? await os.snapshotWindows() : null;
    baseline = since;
    const first = entry.windows.size === 0;
    const spot = features.conceal ? await os.hiddenSpot() : null;
    let targetId = null;
    let launched = false;
    if (first && features.launch) {
      const found = await locateBrowser();
      if (found) {
        const profileDir = await readLastUsedProfile(locate?.userDataDir);
        const result = await os.launchWindow({ browser: found, profileDir, url: nonceUrl(nonce), nonce,
          ...(locate?.custom ? { userDataDir: locate.userDataDir } : {}) });   // --window-position・--window-size は付けない（起動中の Chrome に渡す新しい窓では無視される。実機）
        launched = result?.ok === true;
        if (!launched) log('chrome-windows: launching chrome.exe failed (opens the window with createTarget)');
      }
    }
    if (!launched) {
      ({ targetId } = await cdp.send('Target.createTarget', { url: nonceUrl(nonce), newWindow: true, background: true, ...(spot ? { left: spot.x, top: spot.y, ...WINDOW_DIP } : {}) }));
    }
    let ref = null;
    let windowId;
    try {
      if (features.conceal) {
        ref = await waitFor(() => os.findWindowByNonce(nonce), time.hwndWaitMs, time.hwndPollMs);
        if (ref) await hide(ref, before);
      }
      targetId ??= await waitFor(() => findTarget(cdp, nonce), time.targetWaitMs, time.targetPollMs);
      if (!targetId) throw new Error('the agent browser window did not open in Chrome');
      ({ windowId } = await cdp.send('Browser.getWindowForTarget', { targetId }));
      if (features.conceal && !ref) {
        // 題で見つからなかった（題が付く前・窓が遅れて出た）。もう一度題で、次に外形で探す
        ref = await os.findWindowByNonce(nonce);
        if (!ref && features.bounds) ref = await findByBounds(cdp, windowId, since, { resize: true });
        if (ref) await hide(ref, before);
        else log('chrome-windows: window not found, so it was not hidden');
      }
      entry.windows.set(windowId, { ref, nonce, role: first ? 'main' : 'extra' });
    } catch (error) {
      // 隠した窓の記録だけを残さない（見えない窓が、誰にも戻せないまま残る）。閉じる（だめなら戻す）
      if (ref) await os.closeAgent(ref).catch(() => {});
      throw error;
    }
    await cdp.send('Browser.setWindowBounds', { windowId, bounds: { ...WINDOW_DIP } }).catch(() => {});
    await navigate(cdp, targetId, url);
    return { targetId, windowId };
  }

  return {
    /**
     * 会話の窓にタブを 1 つ作る（中継の scope の口）。会話に窓が無ければ chrome.exe で最初の窓を開き（窓だけ閉じられた後も、黙って開き直す）、
     * あれば新しい窓に作る。同じ会話の呼び出しは順に流す（同時に最初の窓を 2 つ開かない）
     * @returns {Promise<{ targetId: string, windowId: number }>}
     */
    openTab({ cdp, url = 'about:blank', entryId }) {
      const entry = entryOf(entryId);
      const run = entry.queue.then(() => openWindow(cdp, entry, url));
      entry.queue = run.catch(() => {});
      return run;
    },

    /** 範囲のタブが window.open の popup で開いた別窓。外形で窓を見つけて、同じ置き方を当てる */
    async adoptPopup({ cdp, entryId, windowId }) {
      const entry = entryOf(entryId);
      if (entry.windows.has(windowId)) return;
      const record = { ref: null, nonce: null, role: 'popup' };
      entry.windows.set(windowId, record);
      const features = os.capabilities().features;
      if (!features.conceal || !features.bounds) return;
      if (entry.revealed) return;   // 人が引き継いでいる間。人の窓を画面の外へ動かさない（戻すときに探して隠す）
      const ref = await findByBounds(cdp, windowId, baseline, { waitMs: time.popupWaitMs });
      if (!ref) { log('chrome-windows: popup window not found, so it was not hidden'); return; }
      if (entry.windows.get(windowId) !== record) { await os.closeAgent(ref).catch(() => {}); return; }   // 先に閉じられた
      record.ref = ref;
      await hide(ref, null);
    },

    /**
     * 引き継ぎ: 会話の窓を見える形に戻し、near（層が出した ref。Pleiad の窓）のある画面の中へ置き、front（windowId。無ければ最初の窓）を前に出す。
     * 見える形に戻せた窓が無ければ revealed: 0（呼び出し側が引き継ぎをやめる）
     * @returns {Promise<{ revealed: number, raised: boolean }>}
     */
    async reveal({ entryId, near = null, front = null } = {}) {
      const entry = entries.get(entryId);
      if (!entry) return { revealed: 0, raised: false };
      const records = [...entry.windows.entries()].filter(([, record]) => record.ref);
      if (!records.length) return { revealed: 0, raised: false };
      entry.near = near;
      entry.revealed = true;
      const shown = [];
      for (const [windowId, record] of records) if (await os.reveal(record.ref, { near })) shown.push([windowId, record]);
      if (!shown.length) { entry.revealed = false; entry.near = null; return { revealed: 0, raised: false }; }
      const target = (shown.find(([windowId]) => windowId === front) ?? shown.find(([, record]) => record.role === 'main') ?? shown[0])[1];
      const raised = (await os.raise(target.ref))?.ok === true;
      return { revealed: shown.length, raised };
    },

    /**
     * 引き継ぎを終える: 窓を画面の外の見えない窓に戻す。人が前面に置いていた窓が前面のままにならないよう、今の前面（隠す窓でなければ。
     * 隠す窓なら引き継ぎを始めたときの前面）へ返す。見えている間に開いた popup は、ここで探して隠す。cdp は popup を探すのに使う
     * @returns {Promise<{ concealed: number }>}
     */
    async conceal({ entryId, cdp = null } = {}) {
      const entry = entries.get(entryId);
      if (!entry) return { concealed: 0 };
      entry.revealed = false;
      const near = entry.near ?? null;
      entry.near = null;
      const records = [...entry.windows];
      const own = new Set(records.filter(([, record]) => record.ref).map(([, record]) => record.ref.id));
      const fg = await os.foreground();
      const to = fg && !own.has(fg.id) ? fg : near;
      const features = os.capabilities().features;
      let concealed = 0;
      for (const [windowId, record] of records) {
        if (record.ref) {
          if (await hide(record.ref, to)) concealed += 1;
        } else if (record.role === 'popup' && cdp && features.conceal && features.bounds) {
          const ref = await findByBounds(cdp, windowId, baseline, { waitMs: time.popupWaitMs }).catch(() => null);
          if (!ref) { log('chrome-windows: popup window not found, so it was not hidden'); continue; }
          record.ref = ref;
          if (await hide(ref, to)) concealed += 1;
        }
      }
      return { concealed };
    },

    /** 見える形に戻してあるか（引き継ぎ中） */
    isRevealed(entryId) { return entries.get(entryId)?.revealed === true; },

    /** 窓のタブがすべて無くなった（窓だけ閉じられた）。窓の記録を捨てる。次のタブは、窓が無ければ開き直す */
    windowClosed(entryId, windowId) {
      const entry = entries.get(entryId);
      const record = entry?.windows.get(windowId);
      if (!record) return;
      entry.windows.delete(windowId);
      if (record.ref) os.release(record.ref).catch(() => {});
    },

    /** 新しい会話の id が決まった */
    rebind(from, to) {
      const entry = entries.get(from);
      if (!entry || entries.has(to)) return;
      entries.delete(from); entries.set(to, entry);
    },

    /**
     * Chrome の接続が切れた（Chrome が閉じた・許可の取り消し・利用者が切った）。窓が本当に無ければ記録を捨てるだけだが、Chrome が生きていれば、
     * 隠した窓（画面の外・透明・マウス素通し）が残って誰にも戻せなくなる。エージェント専用の窓なので閉じる（閉じられなければ層が見える形へ戻す）
     */
    reset() {
      for (const entry of entries.values()) {
        for (const record of entry.windows.values()) if (record.ref) os.closeAgent(record.ref).catch(() => {});
        entry.windows.clear();
        entry.revealed = false; entry.near = null;   // 引き継ぎ中だった窓ももう無い
      }
    },

    /** 会話を消した。窓を閉じるのは第 8 段なので、記録だけを捨てる（隠した窓の見張りは層が続ける） */
    forget(entryId) { entries.delete(entryId); },

    /** テスト・診断用: 会話の窓（windowId・ref・役割）。窓の題・URL は持たない */
    windows(entryId) { return [...(entries.get(entryId)?.windows ?? [])].map(([windowId, record]) => ({ windowId, ref: record.ref, role: record.role })); },
  };
}
