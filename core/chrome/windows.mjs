// 会話ごとの専用の Chrome の窓（docs/inapp-browser.md「Chrome の中継（開発中）」、ADR 0148・0154）。中継（core/chrome/relay.mjs）の scope の口。
//
// 窓は最小化しない。画面の外へ置き、タスクバーと Alt+Tab から外し、透明度 0・マウスの素通しにする（OS の層の conceal。desktop/chrome-os/win32.cjs）。
//   - 会話の最初の窓: chrome.exe --profile-directory --new-window（プロフィールは Local State の profile.last_used。AGENT_HOST_CHROME_USER_DATA があれば
//     --user-data-dir を必ず付ける）。題に nonce を持つ data: のページで開き、題の nonce で窓を見つけて隠し、前面を取っていたら直前の前面へ返す。
//     窓が見つからない・chrome.exe を起こせないときは、createTarget の新しい窓に落とす（プロフィールは選べない）
//   - プロフィール（第 10 段）: 会話のプロフィール（profileFor。選んだもの・新しい会話の既定）があれば、そのプロフィールの窓を開く。
//     そのプロフィールの窓がまだ無ければ chrome.exe --profile-directory で開き、あれば createTarget にその窓の browserContextId を渡して、
//     開いたタブの browserContextId が同じかを確かめる（違えば閉じて chrome.exe で開き直す。どちらもできなければ失敗。違うプロフィールで開かない）。
//     選んでいないときは今まで通りで、最初の窓を開いたプロフィールを profileUsed で会話に覚える。切り替えても前の窓は閉じない
//   - 2 枚目からのタブ: 新しい窓（createTarget に画面の外の位置を渡す。題の nonce で窓を見つけて隠す）。同じ窓へ足すと、裏のタブは hidden になり
//     描画が止まる（agent-browser の tab tN が送る bringToFront は中継が握りつぶすので、前へ出せない）ので、タブごとに窓を持つ
//   - window.open の popup の別窓: 中継が範囲に足したあと adoptPopup。外形（CDP の Browser.getWindowBounds）で窓を見つけて隠す。
//     外形で探すときは、先に CDP でその窓を一意な位置（画面の外）へ置き、つないだ Chrome のプロセスの窓で、開く前の写しに無いものだけを見る
//     （利用者の窓・Edge の窓・別の Chrome の窓を取り違えて隠さない）。プロセスが分からなければ採用しない
//   - Chrome の接続が切れたとき・窓の開きかけに失敗したときは、隠した窓を閉じる（閉じられなければ見える形へ戻す）。見えない窓を残さない
//   - 更新（ADR 0167）: 隠した窓は閉じずに持ち越す。窓ごとの印（os.exportAgent）を snapshot() で接続の子に預け（relay の carry）、新しいサーバーが
//     restore() で受けて、main の層が戻ったら readopt()（os.adoptAgent）で記録を作り直す。層が窓を引き継げなかった窓は readopt() の返り値で relay に渡し、CDP で閉じる
//     main が居ない間（層が pending）に窓を開く・採用する依頼は、readyWaitMs だけ待ち、それでも戻らなければ「更新中」で失敗させる
// 引き継ぎ（ADR 0154。control.mjs が呼ぶ）: reveal は会話の窓を見える形に戻して（Pleiad の窓のある画面の中へ）前に出し、conceal は画面の外の見えない窓に戻す。
// 見えている間は、層の前面の見張りがその窓を見ない（層の reveal が窓の隠した印を外す）。見えている間に開いた popup は隠さず、戻すときに探して隠す
// 窓の大きさ（DIP）は Pleiad が決める（Browser.setWindowBounds）。窓の ref は層が出した値で、core は覚えて返すだけ。
// ログには窓の題・URL・プロフィール名を出さない。
import crypto from 'node:crypto';
import { readLastUsedProfile, PROFILE_DIR } from './locate.mjs';

/**
 * 窓の大きさ（DIP。外形）。右パネルの映像（第 5 段）の元の大きさで、右パネルの幅（既定で約 430〜540 px）に縮めて映すので、窓が広いほど字が小さくなる。
 * 1100×720（第 4 段の想定）は 0.4〜0.5 倍で本文の 14px が 6px 前後になり読めなかったため、800×800 にした（実機 2026-10-08。理由は docs/inapp-browser.md「窓の大きさ」）。
 * 画面は 800×800 の外形のとき、ページ（viewport）が約 800×660 になる
 */
export const WINDOW_DIP = Object.freeze({ width: 800, height: 800 });
const DEFAULT_TIMING = { hwndWaitMs: 3000, hwndPollMs: 20, targetWaitMs: 8000, targetPollMs: 50, popupWaitMs: 3000, boundsWaitMs: 1000, navigateMs: 15_000, readyWaitMs: 20_000 };
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
 * @param [deps.profileFor]   会話の id → 窓を開くプロフィール（{ browser: 'chrome', dir } | null。null は今まで通り profile.last_used）
 * @param [deps.profileUsed]  (会話の id, { browser, dir }) 選んでいない会話の最初の窓を開いたプロフィール（会話に覚えさせる）
 */
export function createChromeWindows({ os, locate, log = () => {}, random = () => crypto.randomBytes(8).toString('hex'), timing = {}, profileFor = () => null, profileUsed = () => {} }) {
  const time = { ...DEFAULT_TIMING, ...timing };
  // 会話の id -> { windows: Map<windowId, { ref, nonce, role, token, profile, context }>, queue: Promise }
  // profile: 窓のプロフィールのフォルダー名（分からなければ null）。context: 窓の最初のタブの browserContextId（同じプロフィールに窓を足すときに渡す）
  const entries = new Map();
  let browser;                 // undefined: まだ探していない / null: 見つからない / { id, product }
  let baseline = null;         // 直近の窓を開く前のブラウザーの窓の写し（snapshotWindows）。popup を外形で探すとき、それ以前からある窓を除く
  let markSeq = 0;
  const listeners = new Set();
  const changed = () => { for (const fn of [...listeners]) { try { fn(); } catch { /* 聞き手の失敗は窓の管理を壊さない */ } } };

  /** main の層が居ない間（pending。更新で main が入れ替わる間）は、戻るのを readyWaitMs だけ待つ。戻らなければ更新中の失敗 */
  async function osReady() {
    if (os.capabilities().reason !== 'pending') return;
    let off = () => {};
    let timer = null;
    const ready = await Promise.race([
      new Promise(resolve => { off = os.onReady(() => resolve(true)); }),
      new Promise(resolve => { timer = setTimeout(() => resolve(false), time.readyWaitMs); }),
    ]);
    off(); clearTimeout(timer);
    if (!ready && os.capabilities().reason === 'pending') throw new Error('Pleiad is updating. Retry in a minute.');
  }

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

  /**
   * 最大化・最小化・全画面の窓を通常の状態へ戻し、戻ったのを確かめる（短く待つ）。Browser.setWindowBounds は、通常でない窓に windowState: normal（省いたときの既定）を
   * 受けると戻すだけで大きさを当てない（Chromium の chrome/browser/devtools/protocol/browser_handler.cc の SetWindowBounds。大きさと normal 以外の状態は一緒に送れない）。
   * 大きさを送る前に呼ぶ。戻ったか分からなくても投げない（大きさが当たらないだけ）
   */
  async function normalize(cdp, windowId) {
    const state = (await cdp.send('Browser.getWindowBounds', { windowId }).catch(() => null))?.bounds?.windowState;
    if (!state || state === 'normal') return;
    await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } }).catch(() => {});
    const normal = await waitFor(async () => (await cdp.send('Browser.getWindowBounds', { windowId }))?.bounds?.windowState === 'normal', time.boundsWaitMs, time.hwndPollMs);
    if (!normal) log('chrome-windows: the window did not return to the normal state');
  }

  /** chrome.exe で新しい窓を開く（--profile-directory。起こせなければ false） */
  async function launch(cdp, features, nonce, profileDir) {
    if (!features.launch) return false;
    const found = await locateBrowser();
    if (!found) return false;
    const layer = os.generation?.() ?? 0;
    const result = await os.launchWindow({ browser: found, profileDir, url: nonceUrl(nonce), nonce,
      ...(locate?.custom ? { userDataDir: locate.userDataDir } : {}) });   // --window-position・--window-size は付けない（起動中の Chrome に渡す新しい窓では無視される。実機）
    if (result?.ok !== true) {
      log('chrome-windows: launching chrome.exe failed');
      // 呼び出しの途中で層が入れ替わった・切れたなら、返事を聞けなかっただけで、chrome.exe は窓を開いている（隠せず、どの記録にも載らない窓になる）。
      // この呼び出しが付けた題（nonce）の窓だけを CDP で閉じる
      if ((os.generation?.() ?? 0) !== layer) await closeStray(cdp, nonce);
      return false;
    }
    return true;
  }

  /** 題の nonce の窓（この呼び出しが開いたもの）を CDP で閉じる。ほかの窓には触らない */
  async function closeStray(cdp, nonce) {
    const targetId = await waitFor(() => findTarget(cdp, nonce), time.targetWaitMs, time.targetPollMs);
    if (targetId) await cdp.send('Target.closeTarget', { targetId }).catch(() => {});
  }

  const contextOf = async (cdp, targetId) => (await cdp.send('Target.getTargetInfo', { targetId }).catch(() => null))?.targetInfo?.browserContextId ?? null;

  /** 会話のプロフィール（Chrome のものだけ。Edge への接続はまだ無い） */
  function wantedProfile(entryId) {
    let want = null;
    try { want = profileFor(entryId); } catch { want = null; }
    return want?.browser === 'chrome' && typeof want.dir === 'string' && PROFILE_DIR.test(want.dir) ? want.dir : null;
  }

  async function openWindow(cdp, entryId, entry, url) {
    await osReady();
    const layer = os.generation?.() ?? 0;
    let nonce = random();
    const features = os.capabilities().features;
    const before = await os.foreground();
    const since = features.conceal && features.bounds ? await os.snapshotWindows() : null;
    baseline = since;
    const want = wantedProfile(entryId);
    const records = [...entry.windows.values()];
    const first = want ? !records.some(record => record.profile === want) : entry.windows.size === 0;
    const spot = features.conceal ? await os.hiddenSpot() : null;
    const create = context => cdp.send('Target.createTarget', { url: nonceUrl(nonce), newWindow: true, background: true, ...(spot ? { left: spot.x, top: spot.y, ...WINDOW_DIP } : {}), ...(context ? { browserContextId: context } : {}) });
    let targetId = null;
    let launched = false;
    let profile = null;
    if (want) {
      // 選んだプロフィール: その窓があれば同じ browserContextId に足して確かめ、無い・違えば chrome.exe で開く
      const known = records.find(record => record.profile === want && record.context)?.context ?? null;
      if (known) {
        targetId = (await create(known).catch(() => null))?.targetId ?? null;
        if (targetId && await contextOf(cdp, targetId) !== known) {
          log('chrome-windows: the new window opened in another profile, so it was closed');
          await cdp.send('Target.closeTarget', { targetId }).catch(() => {});
          targetId = null;
        }
      }
      if (!targetId) {
        nonce = random();
        launched = await launch(cdp, features, nonce, want);
        if (!launched) throw new Error('could not open a window in the selected Chrome profile');
      }
      profile = want;
    } else {
      if (first) {
        const profileDir = await readLastUsedProfile(locate?.userDataDir);
        launched = await launch(cdp, features, nonce, profileDir);
        if (launched) profile = profileDir;
      }
      if (!launched) ({ targetId } = await create(null));
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
        else if ((os.generation?.() ?? 0) !== layer) throw new Error('Pleiad is updating. Retry in a minute.');   // 層が入れ替わる間に探せなかった。隠せていない窓を残さず、閉じて失敗にする（下の catch）
        else log('chrome-windows: window not found, so it was not hidden');
      }
      // 大きさを決める。最大化のまま開いた窓（前回の最大化がプロフィールに残っている chrome.exe の最初の窓）には、先に通常へ戻してから大きさを送る（normalize）。
      // 通常に戻った窓は Chrome が保存していた画面の中の位置へ動くので、隠し直してから印（token）を作る。Chrome が後から動かした分は、層の見張りが隠し直す
      await normalize(cdp, windowId);
      await cdp.send('Browser.setWindowBounds', { windowId, bounds: { ...WINDOW_DIP } }).catch(() => {});
      if (ref) await os.conceal(ref);
      const token = ref ? await os.exportAgent(ref) : null;
      const context = await contextOf(cdp, targetId);
      if (!profile && context) profile = records.find(record => record.context === context && record.profile)?.profile ?? null;
      entry.windows.set(windowId, { ref, nonce, role: first ? 'main' : 'extra', token, profile, context });
      changed();
      if (!want && launched) {
        const id = [...entries].find(([, value]) => value === entry)?.[0] ?? entryId;   // 開く間に新しい会話の id が決まっていれば、その id
        try { profileUsed(id, { browser: 'chrome', dir: profile }); } catch { /* 覚えられなくても窓は使える */ }
      }
    } catch (error) {
      // 隠した窓の記録だけを残さない（見えない窓が、誰にも戻せないまま残る）。閉じる（だめなら戻す）
      if (ref) await os.closeAgent(ref).catch(() => {});
      else if (targetId) await cdp.send('Target.closeTarget', { targetId }).catch(() => {});   // 隠せていない新しい窓（まだ題のページだけ）を残さない
      throw error;
    }
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
      const run = entry.queue.then(() => openWindow(cdp, entryId, entry, url));
      entry.queue = run.catch(() => {});
      return run;
    },

    /** 範囲のタブが window.open の popup で開いた別窓。外形で窓を見つけて、同じ置き方を当てる */
    async adoptPopup({ cdp, entryId, windowId }) {
      const entry = entryOf(entryId);
      if (entry.windows.has(windowId)) return;
      const record = { ref: null, nonce: null, role: 'popup', token: null, profile: null, context: null };
      entry.windows.set(windowId, record);
      try { await osReady(); } catch (error) { log(`chrome-windows: ${error.message}`); return; }
      const features = os.capabilities().features;
      if (!features.conceal || !features.bounds) return;
      if (entry.revealed) return;   // 人が引き継いでいる間。人の窓を画面の外へ動かさない（戻すときに探して隠す）
      const ref = await findByBounds(cdp, windowId, baseline, { waitMs: time.popupWaitMs });
      if (!ref) { log('chrome-windows: popup window not found, so it was not hidden'); return; }
      if (entry.windows.get(windowId) !== record) { await os.closeAgent(ref).catch(() => {}); return; }   // 先に閉じられた
      record.ref = ref;
      await hide(ref, null);
      record.token = await os.exportAgent(ref);
      changed();
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
      changed();   // 見せている窓の印を預け直す（サーバーが入れ替わっても、人が操作している窓を隠さない）
      return { revealed: shown.length, raised };
    },

    /**
     * 引き継ぎを終える: 窓を画面の外の見えない窓に戻す。人が前面に置いていた窓が前面のままにならないよう、今の前面（隠す窓でなければ。
     * 隠す窓なら引き継ぎを始めたときの前面）へ返す。見えている間に開いた popup（人がタブを引き離して作った窓も含む）は、ここで探して隠す。cdp は popup を探すのに使う
     * @returns {Promise<{ concealed: number, failed: number }>} failed: 隠せなかった窓（隠す処理が失敗した・popup の窓を見つけられなかった）の数。0 でなければ、呼び出し側は引き継ぎを解かない
     */
    async conceal({ entryId, cdp = null } = {}) {
      const entry = entries.get(entryId);
      if (!entry) return { concealed: 0, failed: 0 };
      entry.revealed = false;
      const near = entry.near ?? null;
      entry.near = null;
      const records = [...entry.windows];
      const own = new Set(records.filter(([, record]) => record.ref).map(([, record]) => record.ref.id));
      const fg = await os.foreground();
      const to = fg && !own.has(fg.id) ? fg : near;
      const features = os.capabilities().features;
      let concealed = 0, failed = 0;
      for (const [windowId, record] of records) {
        if (record.ref) {
          if (await hide(record.ref, to)) concealed += 1; else failed += 1;
        } else if (record.role === 'popup') {
          const ref = cdp && features.conceal && features.bounds ? await findByBounds(cdp, windowId, baseline, { waitMs: time.popupWaitMs }).catch(() => null) : null;
          if (!ref) { log('chrome-windows: popup window not found, so it was not hidden'); failed += 1; continue; }
          record.ref = ref;
          if (await hide(ref, to)) { concealed += 1; record.token = await os.exportAgent(ref); } else failed += 1;
        }
      }
      changed();
      return { concealed, failed };
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
      changed();
    },

    /** 新しい会話の id が決まった */
    rebind(from, to) {
      const entry = entries.get(from);
      if (!entry || entries.has(to)) return;
      entries.delete(from); entries.set(to, entry);
      changed();
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
      changed();
    },

    /** CDP で閉じた後も残った、この会話の専用窓だけを OS の層で閉じる。 */
    async closeRemaining(entryId) {
      const entry = entries.get(entryId);
      if (!entry) return { closed: 0, failed: 0 };
      await osReady();
      let count = 0, failed = 0;
      for (const [windowId, record] of [...entry.windows]) {
        if (!record.ref) continue;
        // 引き継ぎで見せた窓も、閉じると決めた後は層の管理下で隠してから閉じる。
        if (entry.revealed) await os.conceal(record.ref).catch(() => {});
        if (await os.closeAgent(record.ref).catch(() => false)) count += 1;
        else failed += 1;
        entry.windows.delete(windowId);
      }
      entry.revealed = false; entry.near = null;
      changed();
      return { closed: count, failed };
    },
    /** 会話を消した。窓を閉じた後に記録を捨てる。 */
    forget(entryId) { if (entries.delete(entryId)) changed(); },

    /** 窓の記録が変わった（relay が carry を預け直す） */
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },

    /** 更新を越えて持ち越す窓の印（会話の id → 窓。隠している窓だけ）。ref は main が入れ替わると意味を持たないので、層の印（token）だけを預ける */
    snapshot() {
      const out = [];
      for (const [id, entry] of entries) {
        // 見せている間に開いた popup は、まだ層の印が無い（戻すときに外形で探して隠す）。窓の ID だけ預けて、新しいサーバーでも範囲に戻す
        const windows = [...entry.windows].filter(([, record]) => record.token || record.role === 'popup').map(([windowId, record]) => ({ windowId, role: record.role, token: record.token ?? null,
          ...(record.profile ? { profile: record.profile } : {}), ...(record.context ? { context: record.context } : {}) }));
        if (windows.length) out.push({ id, ...(entry.revealed ? { revealed: true } : {}), windows });
      }
      return out;
    },

    /** 前のサーバーが預けた窓の印を受ける（記録だけ。窓には触らない。引き継ぎは readopt） */
    restore(saved) {
      for (const item of Array.isArray(saved) ? saved : []) {
        if (typeof item?.id !== 'string' || !Array.isArray(item.windows)) continue;
        const entry = entryOf(item.id);
        if (item.revealed === true) entry.revealed = true;   // 人が操作している窓。隠さない・戻すまで popup も隠さない
        for (const w of item.windows) {
          const popup = w?.role === 'popup' && w.token == null;
          if (!Number.isSafeInteger(w?.windowId) || (typeof w.token !== 'string' && !popup) || entry.windows.has(w.windowId)) continue;
          entry.windows.set(w.windowId, { ref: null, nonce: null, role: typeof w.role === 'string' ? w.role : 'extra', token: popup ? null : w.token,
            profile: typeof w.profile === 'string' && PROFILE_DIR.test(w.profile) ? w.profile : null,
            context: typeof w.context === 'string' && w.context.length <= 128 ? w.context : null });
        }
      }
    },

    /**
     * 印を持つ窓を層に引き継がせて、記録の ref を作り直す（サーバーの入れ替わり後・main の層が入れ替わった後）。
     * 層が引き継げなかった窓（窓が無い・ブラウザーの窓でない）は記録を捨て、{ entryId, windowId } で返す（relay が CDP で閉じる）。層が使えなければ何もしない。
     * 引き継ぎの途中で層が入れ替わった・切れた（呼び出しが聞けなかっただけ。窓が無いとは分からない）ときは、その窓の記録を残して途中でやめ、返す配列の interrupted を true にする
     * （層が戻れば onReady でもう一度呼ばれる）
     */
    async readopt({ cdp = null } = {}) {
      if (!os.capabilities().supported) return [];
      const lost = [];
      const features = os.capabilities().features;
      const layer = os.generation?.() ?? 0;
      const cut = () => !os.capabilities().supported || (os.generation?.() ?? 0) !== layer;
      scan: for (const [entryId, entry] of [...entries]) {
        for (const [windowId, record] of [...entry.windows]) {
          if (!record.token) {
            // main が居ない間に開いた popup（隠せず、窓の ID だけ残っている）。層が戻ったので、外形で探して隠す。探せない・cdp が無いなら、見える窓を残さないよう lost で返して閉じさせる
            if (record.role !== 'popup' || record.ref || entry.revealed) continue;
            const ref = cdp && features.conceal && features.bounds ? await findByBounds(cdp, windowId, baseline, { waitMs: time.popupWaitMs }).catch(() => null) : null;
            if (ref) { record.ref = ref; await hide(ref, null); record.token = await os.exportAgent(ref); changed(); }
            else if (cut()) { lost.interrupted = true; break scan; }
            else { entry.windows.delete(windowId); lost.push({ entryId, windowId, revealed: false }); }
            continue;
          }
          // 見せている窓は、層に「隠していない窓」として引き継がせる（前面の見張りが人の窓を画面の外へ戻さない）
          const ref = await os.adoptAgent(record.token, { revealed: entry.revealed === true }).catch(() => null);
          if (ref) record.ref = ref;
          else if (cut()) { lost.interrupted = true; break scan; }
          else { entry.windows.delete(windowId); lost.push({ entryId, windowId, revealed: entry.revealed === true }); }
        }
      }
      if (lost.length) { log(`chrome-windows: ${lost.length} window(s) could not be taken over`); changed(); }
      return lost;
    },

    /**
     * Chrome に接続できないまま層が戻ったとき（main が居ない間に接続が切れた）: 隠した窓を閉じる。窓の記録を引き継いだだけで接続が無いので、誰にも戻せない。
     * 人が操作している窓（revealed）は閉じない（記録だけ捨てる）。閉じた数を返す
     */
    async closeHidden() {
      let closed = 0;
      for (const entry of entries.values()) {
        for (const [windowId, record] of [...entry.windows]) {
          if (entry.revealed) { entry.windows.delete(windowId); continue; }
          if (record.ref) { await os.closeAgent(record.ref).catch(() => {}); closed += 1; }
          entry.windows.delete(windowId);
        }
      }
      if (closed) log(`chrome-windows: closed ${closed} hidden window(s) left without a Chrome connection`);
      changed();
      return closed;
    },

    /**
     * タブのプロフィール（サイトの許可の鍵。'chrome:<フォルダー名>'）。窓の記録に無ければ、同じ browserContextId の窓から引く（popup は開いた窓と同じ）。
     * 分からなければ null
     */
    profileOf(entryId, { windowId = null, context = null } = {}) {
      const entry = entries.get(entryId);
      if (!entry) return null;
      const own = entry.windows.get(windowId)?.profile
        ?? (context ? [...entry.windows.values()].find(record => record.context === context && record.profile)?.profile : null);
      return own ? `chrome:${own}` : null;
    },

    /** テスト・診断用: 会話の窓（windowId・ref・役割）。窓の題・URL は持たない */
    windows(entryId) { return [...(entries.get(entryId)?.windows ?? [])].map(([windowId, record]) => ({ windowId, ref: record.ref, role: record.role, profile: record.profile ?? null })); },
  };
}
