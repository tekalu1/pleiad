// 操作させないアプリ（禁止）と、警告付きで聞くアプリ（高リスク）の固定の一覧（docs/computer-use.md「判定の順」、ADR 0071）。
// 出典: Codex の同梱の computer use が操作を拒むアプリの一覧に倣い、Claude Desktop の「シェルと同じことができる」アプリを高リスクに足した。
//
// アプリの id は `aumid:<AUMID>` か `exe:<フルパスを小文字にして \ を / にしたもの>`。照合は exe 名（パスの最後）と AUMID の接頭辞で行う。
// macOS（ADR 0173 §5）は `bundle:<バンドル ID>` で、バンドル ID の接頭辞（小文字）で照合する。バンドルの無いプロセスは `exe:<パス>`。
// 一覧に載せるのは、すべて許可・確認なしでも拒む対象だけ。聞くだけでよいものは高リスクの一覧に置く。

/** 小文字・/ 区切りにそろえた exe の名前（パスの最後）。id が aumid のときは null */
export function exeName(app) {
  const id = String(app?.id ?? '');
  const path = id.startsWith('exe:') ? id.slice(4) : typeof app?.path === 'string' ? app.path.toLowerCase().replaceAll('\\', '/') : '';
  if (!path) return null;
  return path.slice(path.lastIndexOf('/') + 1).toLowerCase();
}

/** 小文字にしたバンドル ID（macOS）。無ければ null */
export function bundleIdOf(app) {
  const id = String(app?.id ?? '');
  const v = id.startsWith('bundle:') ? id.slice(7) : app?.bundleId;
  return typeof v === 'string' && v ? v.toLowerCase() : null;
}

/** 小文字にした AUMID（`<パッケージ家族名>!<アプリ>`）。無ければ null */
export function aumidOf(app) {
  const id = String(app?.id ?? '');
  const v = id.startsWith('aumid:') ? id.slice(6) : app?.aumid;
  return typeof v === 'string' && v ? v.toLowerCase() : null;
}

// exe 名の完全一致
const FORBIDDEN_EXE = new Set([
  // ターミナル
  'windowsterminal.exe', 'wt.exe', 'cmd.exe', 'powershell.exe', 'powershell_ise.exe', 'pwsh.exe', 'conhost.exe', 'openconsole.exe',
  'wsl.exe', 'wslhost.exe', 'wslg.exe', 'bash.exe', 'sh.exe', 'git-bash.exe', 'mintty.exe', 'alacritty.exe', 'wezterm.exe', 'wezterm-gui.exe',
  'kitty.exe', 'hyper.exe', 'tabby.exe', 'putty.exe', 'ubuntu.exe', 'ubuntu2204.exe', 'ubuntu2404.exe', 'debian.exe',
  // パスワード管理
  '1password.exe', 'bitwarden.exe', 'keepass.exe', 'keepassxc.exe', 'dashlane.exe', 'nordpass.exe', 'enpass.exe', 'roboform.exe',
  'keeper.exe', 'lastpass.exe', 'protonpass.exe', 'proton pass.exe',
  // セキュリティソフト
  'securityhealthsystray.exe', 'securityhealthui.exe', 'windowsdefender.exe', 'msascui.exe', 'avastui.exe', 'avgui.exe', 'avira.exe',
  'nortonui.exe', 'mcuicnt.exe', 'avp.exe', 'bdagent.exe', 'egui.exe', 'mbam.exe', 'sophosui.exe', 'csfalconui.exe',
  // Windows の内部
  'lockapp.exe', 'consent.exe', 'logonui.exe', 'winlogon.exe', 'credentialuibroker.exe', 'shellexperiencehost.exe', 'searchhost.exe',
  'searchapp.exe', 'startmenuexperiencehost.exe', 'textinputhost.exe', 'securityhealthhost.exe', 'cloudexperiencehosts.exe',
  // エージェント自身（Pleiad・Claude・Codex・Antigravity）
  'ply.exe', 'pleiad.exe', 'claude.exe', 'claude-code.exe', 'codex.exe', 'chatgpt.exe', 'agy.exe', 'antigravity.exe',
  // macOS のバンドルの無いシェル（exe:<パス> の最後）
  'zsh', 'bash', 'sh', 'fish', 'login', 'claude', 'codex', 'agy',
]);
// exe 名の先頭一致（版・変種のあるもの）
const FORBIDDEN_EXE_PREFIX = ['1password', 'bitwarden', 'keepass', 'avast', 'norton', 'mcafee', 'kaspersky', 'bitdefender', 'malwarebytes', 'sophos', 'crowdstrike', 'sentinelagent'];
// AUMID の接頭辞（小文字）
const FORBIDDEN_AUMID = [
  'microsoft.windowsterminal', 'microsoft.powershell', 'microsoftcorporationii.windowssubsystemforlinux', 'canonicalgrouplimited.ubuntu',
  'agilebits.1password', '1password', 'bitwarden', 'dashlane', 'keepass', 'protonag.protonpass',
  'microsoft.sechealthui', 'microsoft.windowsdefender',
  'microsoft.lockapp', 'microsoft.windows.shellexperiencehost', 'microsoft.windows.startmenuexperiencehost', 'microsoft.windows.search',
  'microsoft.windows.cloudexperiencehost', 'microsoft.windows.securecredentialsui', 'microsoft.aad.brokerplugin', 'microsoftwindows.client.cbs',
  'microsoftwindows.client.core', 'microsoft.windows.secureassessmentbrowser',
  'anthropicpbc.claude', 'claude_', 'openai.codex', 'openai.chatgpt', 'google.antigravity',
];

const HIGH_EXE = new Set([
  'explorer.exe', 'systemsettings.exe', 'control.exe', 'regedit.exe', 'mmc.exe', 'taskmgr.exe',
  'code.exe', 'code - insiders.exe', 'devenv.exe', 'cursor.exe', 'windsurf.exe', 'zed.exe',
  'idea64.exe', 'pycharm64.exe', 'webstorm64.exe', 'rider64.exe', 'clion64.exe', 'goland64.exe', 'datagrip64.exe', 'phpstorm64.exe',
  'rubymine64.exe', 'studio64.exe', 'fleet.exe',
]);
const HIGH_AUMID = ['windows.immersivecontrolpanel', 'microsoft.windows.explorer', 'microsoft.visualstudiocode', 'jetbrains.'];

// macOS のバンドル ID の接頭辞（小文字）。完全一致させたいものは末尾まで書く（'com.apple.terminal' は 'com.apple.terminal.' 始まりも含む）
const FORBIDDEN_BUNDLE = [
  // ターミナル
  'com.apple.terminal', 'com.googlecode.iterm2', 'dev.warp.', 'org.alacritty', 'io.alacritty', 'net.kovidgoyal.kitty', 'com.github.wez.wezterm',
  'com.mitchellh.ghostty', 'co.zeit.hyper', 'org.tabby',
  // パスワード管理（キーチェーンアクセス・パスワードを含む）
  'com.1password.', 'com.agilebits.onepassword', 'com.bitwarden.', 'org.keepassxc.', 'com.apple.keychainaccess', 'com.apple.passwords',
  'com.dashlane.', 'me.proton.pass',
  // 認証・ログインの画面
  'com.apple.securityagent', 'com.apple.loginwindow', 'com.apple.screensaver.engine',
  // スクリプトの道具（シェルと同じことができる）
  'com.apple.scripteditor2', 'com.apple.automator', 'com.apple.shortcuts',
  // エージェント自身（Pleiad・Claude・ChatGPT・Codex・Antigravity）
  'jp.ply.desktop', 'com.anthropic.claude', 'com.openai.chat', 'com.openai.codex', 'com.google.antigravity',
];
const HIGH_BUNDLE = [
  'com.apple.finder', 'com.apple.systempreferences', 'com.apple.settings', 'com.apple.activitymonitor',
  'com.microsoft.vscode', 'com.todesktop.230313mzl4w4u92', 'com.exafunction.windsurf', 'dev.zed.', 'com.apple.dt.xcode', 'com.jetbrains.',
];

/** 操作させないアプリか。Pleiad 自身（self）を含む */
export function isForbiddenApp(app) {
  if (!app) return false;
  if (app.self === true) return true;
  const exe = exeName(app);
  if (exe && (FORBIDDEN_EXE.has(exe) || FORBIDDEN_EXE_PREFIX.some(p => exe.startsWith(p)))) return true;
  const aumid = aumidOf(app);
  if (aumid && FORBIDDEN_AUMID.some(p => aumid.startsWith(p))) return true;
  const bundle = bundleIdOf(app);
  return Boolean(bundle && FORBIDDEN_BUNDLE.some(p => bundle.startsWith(p)));
}

/** 警告付きで聞くアプリか（許可はできる） */
export function isHighRiskApp(app) {
  if (!app) return false;
  const exe = exeName(app);
  if (exe && HIGH_EXE.has(exe)) return true;
  const aumid = aumidOf(app);
  if (aumid && HIGH_AUMID.some(p => aumid.startsWith(p))) return true;
  const bundle = bundleIdOf(app);
  return Boolean(bundle && HIGH_BUNDLE.some(p => bundle.startsWith(p)));
}
