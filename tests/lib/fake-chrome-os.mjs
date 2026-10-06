// 偽の OS の層（core/chrome/os.mjs の口）。偽の Chrome（tests/lib/fake-chrome.mjs）の確認の窓を findPermissionDialog で返し、
// close(ref) で偽の Chrome の保留を壊す（本物の WM_CLOSE と同じ）。前面は setForeground で操り、呼び出しは log に残す。
export function fakeChromeOs({ chrome = null, supported = true, reason = 'platform', features } = {}) {
  const caps = Object.freeze({
    supported, ...(supported ? {} : { reason }),
    features: features ?? { dialog: supported, raise: supported, launch: false, watch: false, bounds: false },
  });
  const log = [];
  const windows = new Map([['chrome-main', { browser: true }], ['app-notes', { browser: false }]]);
  let fg = 'app-notes';
  let stealing = false;
  let hideDialogs = false;
  const listeners = new Set();
  const isDialog = id => chrome?.dialogs().some(d => d.id === id);
  const note = entry => { log.push(entry); };
  if (chrome) chrome.onDialog(id => { if (stealing) fg = id; });
  const self = {
    kind: 'fake',
    log,
    calls: name => log.filter(e => e.op === name),
    capabilities: () => caps,
    ready: async () => caps,
    onReady(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    async snapshotWindows() { note({ op: 'snapshotWindows' }); return [...windows.keys(), ...(chrome?.dialogs().map(d => d.id) ?? [])]; },
    async findPermissionDialog({ since = [] } = {}) {
      note({ op: 'findPermissionDialog', since });
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
    async foreground() { note({ op: 'foreground' }); return { id: fg, browser: isDialog(fg) || windows.get(fg)?.browser === true }; },
    async close(ref) { note({ op: 'close', ref: ref?.id }); return chrome ? chrome.closeDialog(ref?.id) : false; },
    // ---- テストの操作
    setForeground(id, { browser = false } = {}) { if (!windows.has(id)) windows.set(id, { browser }); fg = id; },
    getForeground: () => fg,
    /** 新しく出る確認が前面を取る（本物の Chrome が自分で前に出すことがある） */
    dialogStealsForeground(on) { stealing = on; },
    /** 確認の窓を見つけられない（findPermissionDialog が null） */
    hideDialogs(on) { hideDialogs = on; },
  };
  return self;
}
