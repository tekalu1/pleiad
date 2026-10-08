// hostCapabilities.computerUse（docs/computer-use.md「hostCapabilities」）。設定の画面が、使えないときにスイッチを止めて理由を書くのに使う。
// reason: desktop（Electron でない）/ platform（Windows・macOS でない）/ native（main が Win32 の部品・macOS のヘルパーを読めない）。
// macOS の許可（画面収録・アクセシビリティ）が無いだけなら使えるものとして扱い、使うときに求める（ADR 0173 §6）。
// ready は main の computer-ready メッセージ（{ supported, reason? }）。まだ届いていなければ null で、使えるものとして扱う

/** @returns {{ supported: boolean, reason?: 'desktop'|'platform'|'native' }} */
export function computerUseCapability({ hasParentPort, platform = process.platform, ready = null } = {}) {
  if (!hasParentPort) return { supported: false, reason: 'desktop' };
  if (platform !== 'win32' && platform !== 'darwin') return { supported: false, reason: 'platform' };
  if (ready && ready.supported !== true) return { supported: false, reason: ready.reason === 'platform' ? 'platform' : 'native' };
  return { supported: true };
}
