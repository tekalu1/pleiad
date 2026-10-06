// 会話ごとの専用の Chrome の窓（docs/inapp-browser.md「Chrome の中継（開発中）」、ADR 0148・0154）。中継（core/chrome/relay.mjs）の scope の口。
//
// 窓は最小化しない。画面の外へ置き、タスクバーと Alt+Tab から外し、透明度 0・マウスの素通しにする（OS の層の conceal。desktop/chrome-os/win32.cjs）。
//   - 会話の最初の窓: chrome.exe --profile-directory --new-window（プロフィールは Local State の profile.last_used。AGENT_HOST_CHROME_USER_DATA があれば
//     --user-data-dir を必ず付ける）。題に nonce を持つ data: のページで開き、題の nonce で窓を見つけて隠し、前面を取っていたら直前の前面へ返す。
//     窓が見つからない・chrome.exe を起こせないときは、createTarget の新しい窓に落とす（プロフィールは選べない）
//   - 2 枚目からのタブ: 新しい窓（createTarget に画面の外の位置を渡す。題の nonce で窓を見つけて隠す）。同じ窓へ足すと、裏のタブは hidden になり
//     描画が止まる（agent-browser の tab tN が送る bringToFront は中継が握りつぶすので、前へ出せない）ので、タブごとに窓を持つ
//   - window.open の popup の別窓: 中継が範囲に足したあと adoptPopup。外形（CDP の Browser.getWindowBounds）で窓を見つけて隠す
// 窓の大きさ（DIP）は Pleiad が決める（Browser.setWindowBounds）。窓の ref は層が出した値で、core は覚えて返すだけ。
// ログには窓の題・URL・プロフィール名を出さない。
import crypto from 'node:crypto';
import { readLastUsedProfile } from './locate.mjs';

/** 窓の大きさ（DIP）。右パネルの映像（第 5 段）の元の大きさ */
export const WINDOW_DIP = Object.freeze({ width: 1100, height: 720 });
const DEFAULT_TIMING = { hwndWaitMs: 3000, hwndPollMs: 20, targetWaitMs: 8000, targetPollMs: 50, popupWaitMs: 3000, navigateMs: 15_000 };

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

  async function openWindow(cdp, entry, url) {
    const nonce = random();
    const features = os.capabilities().features;
    const before = await os.foreground();
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
    if (features.conceal) {
      ref = await waitFor(() => os.findWindowByNonce(nonce), time.hwndWaitMs, time.hwndPollMs);
      if (ref) await hide(ref, before);
    }
    targetId ??= await waitFor(() => findTarget(cdp, nonce), time.targetWaitMs, time.targetPollMs);
    if (!targetId) throw new Error('the agent browser window did not open in Chrome');
    const where = await cdp.send('Browser.getWindowForTarget', { targetId });
    const { windowId } = where;
    if (features.conceal && !ref) {
      // 題で見つからなかった（題が付く前・窓が遅れて出た）。もう一度題で、次に外形で探す
      ref = await os.findWindowByNonce(nonce);
      if (!ref && features.bounds && where.bounds) ref = await os.findWindowByBounds({ bounds: where.bounds });
      if (ref) await hide(ref, before);
      else log('chrome-windows: window not found, so it was not hidden');
    }
    entry.windows.set(windowId, { ref, nonce, role: first ? 'main' : 'extra' });
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
      const ref = await waitFor(async () => {
        const got = await cdp.send('Browser.getWindowBounds', { windowId }).catch(() => null);
        return got?.bounds ? os.findWindowByBounds({ bounds: got.bounds }) : null;
      }, time.popupWaitMs, time.hwndPollMs);
      if (!ref) { log('chrome-windows: popup window not found, so it was not hidden'); return; }
      if (entry.windows.get(windowId) !== record) return;   // 先に閉じられた
      record.ref = ref;
      await hide(ref, null);
    },

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

    /** Chrome の接続が切れた（Chrome が閉じた）。窓はもう無い */
    reset() {
      for (const entry of entries.values()) {
        for (const record of entry.windows.values()) if (record.ref) os.release(record.ref).catch(() => {});
        entry.windows.clear();
      }
    },

    /** 会話を消した。窓を閉じるのは第 8 段なので、記録だけを捨てる（隠した窓の見張りは層が続ける） */
    forget(entryId) { entries.delete(entryId); },

    /** テスト・診断用: 会話の窓（windowId・ref・役割）。窓の題・URL は持たない */
    windows(entryId) { return [...(entries.get(entryId)?.windows ?? [])].map(([windowId, record]) => ({ windowId, ref: record.ref, role: record.role })); },
  };
}
