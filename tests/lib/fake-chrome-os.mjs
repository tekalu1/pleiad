// 偽の OS の層（core/chrome/os.mjs の口）。偽の Chrome（tests/lib/fake-chrome.mjs）の確認の窓を findPermissionDialog で返し、
// close(ref) で偽の Chrome の保留を壊す（本物の WM_CLOSE と同じ）。前面は setForeground で操り、呼び出しは log に残す。
//
// エージェントの窓（ADR 0154）: 偽の Chrome の窓ができるたびに偽の HWND を作る（hwnds()）。窓の題は偽の Chrome の窓の最後のタブの題、
// 外形は偽の Chrome の窓の bounds。launchWindow は偽の Chrome に窓を作り（位置・大きさは honorPosition のとき守る）、findWindowByNonce は題で、
// findWindowByBounds は外形で窓を見つけ、conceal・reveal・release は HWND のスタイル・位置を替える。
// 前面の見張りは持たない（層のテストが偽の Win32 の表で見る）。stealsForeground(true) の間に出た窓は前面を取り、prevFg に前の前面を覚える。
export function fakeChromeOs({ chrome = null, supported = true, reason = 'platform', features } = {}) {
  const caps = Object.freeze({
    supported, ...(supported ? {} : { reason }),
    features: features ?? { dialog: supported, raise: supported, launch: supported, conceal: supported, watch: supported, bounds: supported },
  });
  const log = [];
  const windows = new Map([['chrome-main', { browser: true }], ['app-notes', { browser: false }]]);
  let fg = 'app-notes';
  let stealing = false;
  let windowStealing = false;
  let hideDialogs = false;
  const listeners = new Set();
  const hw = new Map();   // hwnd -> { id, windowId, rect(DIP), concealed, agent, alpha, ex, prevFg }
  let hwSeq = 100;
  const opts = { launchFails: false, chromeMissing: false, hideNonce: false, hideBounds: false, concealFails: false, honorPosition: true };
  const OFFSCREEN = Object.freeze({ x: 6000, y: 0 });
  const isDialog = id => chrome?.dialogs().some(d => d.id === id);
  const note = entry => { log.push(entry); };
  const titleOf = h => chrome?.browser.windowTitle(h.windowId) ?? '';
  if (chrome) chrome.onDialog(id => { if (stealing) fg = id; });
  if (chrome) chrome.browser.onWindow(({ windowId, bounds }) => {
    const id = `hw${++hwSeq}`;
    const h = { id, windowId, rect: { ...bounds }, concealed: false, agent: false, released: false, alpha: 255, ex: { toolwindow: false, layered: false, transparent: false, appwindow: true }, prevFg: null };
    hw.set(id, h);
    if (windowStealing) { h.prevFg = fg; fg = id; }
  });
  const known = ref => (ref && typeof ref.id === 'string' ? hw.get(ref.id) : undefined);
  const knownAgent = ref => { const h = known(ref); return h?.agent && !h.released ? h : undefined; };
  const near = (a, b) => Math.abs(a - b) <= 16;

  const self = {
    kind: 'fake',
    log,
    opts,
    calls: name => log.filter(e => e.op === name),
    capabilities: () => caps,
    ready: async () => caps,
    onReady(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    async snapshotWindows() { note({ op: 'snapshotWindows' }); return [...windows.keys(), ...(chrome?.dialogs().map(d => d.id) ?? [])]; },
    async findPermissionDialog({ since = [], port = null } = {}) {
      note({ op: 'findPermissionDialog', since, port });
      if (hideDialogs || !chrome) return null;
      const d = chrome.dialogs().find(x => !since.includes(x.id));
      return d ? { id: d.id } : null;
    },
    async raise(ref) { note({ op: 'raise', ref: ref?.id }); fg = ref?.id ?? fg; return { ok: true, method: 'direct' }; },
    async yieldForeground(ref, { to } = {}) {
      note({ op: 'yieldForeground', ref: ref?.id, to: to?.id });
      if (fg !== ref?.id || !to?.id) return false;
      fg = to.id; return true;
    },
    async foreground() { note({ op: 'foreground' }); return { id: fg, browser: isDialog(fg) || hw.has(fg) || windows.get(fg)?.browser === true }; },
    async close(ref) { note({ op: 'close', ref: ref?.id }); return chrome ? chrome.closeDialog(ref?.id) : false; },

    // ---- エージェントの窓
    async locateBrowser({ product = 'chrome' } = {}) { note({ op: 'locateBrowser', product }); return opts.chromeMissing ? null : { id: 'fake-browser', product }; },
    async launchWindow(args = {}) {
      note({ op: 'launchWindow', args: JSON.parse(JSON.stringify({ ...args, browser: args.browser?.id ?? null })) });
      if (opts.launchFails || args.browser?.id !== 'fake-browser' || !chrome) return { ok: false };
      const position = opts.honorPosition && args.position ? { left: args.position.x, top: args.position.y } : {};
      const size = opts.honorPosition && args.size ? { width: args.size.width, height: args.size.height } : {};
      chrome.browser.launchWindow({ url: args.url, bounds: { ...position, ...size } });
      return { ok: true };
    },
    async findWindowByNonce(nonce) {
      note({ op: 'findWindowByNonce' });
      if (opts.hideNonce || typeof nonce !== 'string') return null;
      const h = [...hw.values()].find(x => !x.released && titleOf(x).includes(nonce));
      if (!h) return null;
      h.agent = true;
      return { id: h.id };
    },
    async findWindowByBounds({ bounds } = {}) {
      note({ op: 'findWindowByBounds', bounds });
      if (!bounds || opts.hideBounds) return null;
      const hits = [...hw.values()].filter(x => !x.agent && !x.concealed && !x.released
        && near(x.rect.left, bounds.left) && near(x.rect.top, bounds.top) && near(x.rect.width, bounds.width) && near(x.rect.height, bounds.height));
      if (hits.length !== 1) return null;
      hits[0].agent = true;
      return { id: hits[0].id };
    },
    async hiddenSpot() { note({ op: 'hiddenSpot' }); return { ...OFFSCREEN }; },
    async conceal(ref) {
      note({ op: 'conceal', ref: ref?.id });
      const h = knownAgent(ref);
      if (!h || opts.concealFails) return false;
      h.concealed = true; h.rect = { ...h.rect, left: OFFSCREEN.x, top: OFFSCREEN.y };
      h.alpha = 0; h.ex = { toolwindow: true, layered: true, transparent: true, appwindow: false };
      return true;
    },
    async reveal(ref, { near: nearRef = null } = {}) {
      note({ op: 'reveal', ref: ref?.id, near: nearRef?.id ?? null });
      const h = knownAgent(ref);
      if (!h) return false;
      h.concealed = false; h.rect = { ...h.rect, left: 100, top: 100 };
      h.alpha = 255; h.ex = { toolwindow: false, layered: false, transparent: false, appwindow: true };
      return true;
    },
    async release(ref) { note({ op: 'release', ref: ref?.id }); const h = knownAgent(ref); if (!h) return false; h.released = true; return true; },

    // ---- テストの操作
    setForeground(id, { browser = false } = {}) { if (!windows.has(id)) windows.set(id, { browser }); fg = id; },
    getForeground: () => fg,
    /** 新しく出る確認が前面を取る（本物の Chrome が自分で前に出すことがある） */
    dialogStealsForeground(on) { stealing = on; },
    /** 新しく出る Chrome の窓（launchWindow・createTarget の newWindow・popup）が前面を取る */
    windowsStealForeground(on) { windowStealing = on; },
    /** 確認の窓を見つけられない（findPermissionDialog が null） */
    hideDialogs(on) { hideDialogs = on; },
    /** 偽の HWND の今の姿（題・外形 DIP・隠しているか・スタイル・透明度）。窓の題は偽の Chrome の窓の最後のタブの題 */
    hwnds: () => [...hw.values()].map(h => ({ id: h.id, windowId: h.windowId, title: titleOf(h), rect: { ...h.rect }, concealed: h.concealed, agent: h.agent, released: h.released, alpha: h.alpha, ex: { ...h.ex }, prevFg: h.prevFg })),
    hwndOfWindow: windowId => { const h = [...hw.values()].find(x => x.windowId === windowId); return h ? { id: h.id } : null; },
  };
  return self;
}
