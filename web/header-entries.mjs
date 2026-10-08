// 会話の頭の行の、右パネルを開くアイコンボタン（docs/design-system.md「会話の頭の行のアイコン」）。
//   - プラグイン（#contextEntry）: 件数は画面に出さず、title と読み上げの名前にだけ入れる。「変更あり」は右上の点
//   - ブラウザー（#browserEntry）: ホストではビューアと Chrome、リモートでは窓がある会話の Chrome を開閉する。
//     近道は Ctrl+Shift+B（macOS は ⌘⇧B）。内蔵ブラウザーのページにフォーカスがあるときは main が拾って知らせる
import { t } from './i18n.mjs';
import { runMark } from './arc.mjs';
// i18n-dynamic: browser.entryState
// 旧入口の訳語は並行するプロフィール改修との合流まで辞書に残す。
// i18n-dynamic: browser.entry
// i18n-dynamic: browser.chromeWindow.entry
import { isComposingKey } from './keyboard.mjs';

const CTX_KINDS = ['instruction', 'skill', 'mcp'];
// 実際に渡ったものだけ数える。除外・重複・未対応・接続できなかった MCP は数に入れない
const CTX_LOADED = { instruction: ['supplied', 'loaded'], skill: ['available', 'manual-only', 'loaded'], mcp: ['pending', 'connected'] };
// Pleiad が担当する種類だけ数える（エージェント任せの種類は Pleiad が中身を把握していない）
export const contextTotal = (report) => CTX_KINDS.filter((kind) => report?.owners?.[kind] === 'ply')
  .reduce((sum, kind) => sum + (report.entries ?? []).filter((e) => e.kind === kind && CTX_LOADED[kind].includes(e.status)).length, 0);
// エージェント任せの会話（と、Pleiad 担当を受け取れなかった antigravity の会話）
export const isManagedContext = (report) => Boolean(report) && report.status !== 'native';

/**
 * プラグインの入口の名前。report は会話のコンテキストの報告、summary は札と同じ要約（指示 2 · Skills 9 · MCP 1）、
 * changed は次の送信で読み直す変更があるか。件数は Pleiad が管理している会話でだけ入れる
 */
export function contextEntryText({ report, summary = '', changed = false }) {
  const managed = isManagedContext(report);
  const title = [report ? t('session.context.titleWith', { summary }) : t('session.context.title'), changed ? t('session.context.changed') : ''].filter(Boolean).join(' · ');
  const label = [t('session.context.label'), managed ? String(contextTotal(report)) : '', changed ? t('session.context.changed') : ''].filter(Boolean).join(' ');
  return { title, label, changed: !!changed };
}

/** プラグインの入口に名前と「変更あり」の点を当てる。点（.entry-dot）は変更がある間だけ DOM に置く */
export function paintContextEntry(button, { visible, report, summary, changed }) {
  button.hidden = !visible;
  if (!visible) return;
  const text = contextEntryText({ report, summary, changed });
  button.title = text.title;
  button.setAttribute('aria-label', text.label);
  const dot = button.querySelector('.entry-dot');
  if (text.changed && !dot) {
    const mark = document.createElement('span');
    mark.className = 'entry-dot';
    mark.setAttribute('aria-hidden', 'true');
    button.append(mark);
  } else if (!text.changed && dot) dot.remove();
}

const isMac = () => typeof navigator !== 'undefined' && /Mac/.test(navigator.platform);
/** 内蔵ブラウザーの近道か（Ctrl+Shift+B、macOS は ⌘⇧B）。IME の変換中は奪わない */
export function isBrowserShortcut(event, mac = isMac()) {
  if (!event || event.defaultPrevented || isComposingKey(event) || event.altKey || !event.shiftKey) return false;
  if (mac ? !event.metaKey || event.ctrlKey : !event.ctrlKey || event.metaKey) return false;
  return String(event.key ?? '').toLowerCase() === 'b';
}
/** ツールチップに添える近道の書き方 */
export const browserShortcutLabel = (mac = isMac()) => (mac ? '⌘⇧B' : 'Ctrl+Shift+B');

/** 角の印は一つ。操作の依頼を最優先し、次に人の操作、最後にエージェントの操作 */
export const browserEntryMark = ({ requested = false, paused = false, working = false } = {}) =>
  requested ? 'requested' : paused ? 'paused' : working ? 'working' : '';

/** 開く瞬間に選ぶ中身。開いた後の状態変化では呼ばない */
export const browserViewToOpen = ({ viewer = false, chrome = false, urgent = false, last = null } = {}) =>
  chrome && (urgent || last === 'chrome' || !viewer) ? 'chrome' : viewer ? 'viewer' : null;

/**
 * 統合したブラウザーのボタン。browser は web/browser-panel.mjs の createBrowserPanel の返り値（使えない画面では null）、
 * preview は web/file-preview.mjs の返り値（openBrowser・browserOpen・close）。
 * bridge は preload の plyDesktop.browser（ページにフォーカスがあるときの近道）。blocked() が true の間は近道を効かせない（設定・ダイアログ）。
 * ビューアも Chrome の窓も無い画面では隠す
 */
export function setupBrowserEntry({ button, browser, preview, chrome = () => null, windows = null, getSessionId = () => null,
  getAgentName = () => 'Claude', getChromeState = () => 'idle', waiting = () => false, chromeAvailable = () => false,
  mac = isMac(), bridge = null, blocked = () => false, mark: makeMark = runMark }) {
  if (!button) return null;
  if (!browser && !windows) { button.hidden = true; return null; }
  button.setAttribute('aria-keyshortcuts', mac ? 'Meta+Shift+B' : 'Control+Shift+B');
  const lastView = new Map();
  const activeId = () => getSessionId() ?? null;
  const chromeOpen = () => chrome()?.isOpen() === true;
  const open = () => preview.browserOpen() || chromeOpen();

  function paint() {
    const id = activeId();
    const hasWindow = Boolean(id && chromeAvailable() && windows?.has(id));
    button.hidden = !browser && !hasWindow;
    button.toggleAttribute('data-mobile-chrome', hasWindow);
    if (button.hidden) return;
    if (id && chromeOpen()) lastView.set(id, 'chrome');
    else if (id && preview.browserOpen()) lastView.set(id, 'viewer');
    const requested = Boolean(id && chromeAvailable() && waiting(id));
    const paused = Boolean(id && chromeAvailable() && getChromeState(id) === 'paused');
    const working = Boolean(id && chromeAvailable() && (windows?.operating(id) || getChromeState(id) === 'running'));
    const state = browserEntryMark({ requested, paused, working });
    const label = [t('browser.unifiedEntryLabel'), state ? t(`browser.entryState.${state}`, { name: getAgentName() || 'Claude' }) : ''].filter(Boolean).join(' · ');
    button.title = `${label}（${browserShortcutLabel(mac)}）`;
    button.setAttribute('aria-label', label);
    button.setAttribute('aria-expanded', String(open()));
    button.classList.toggle('on', open());
    button.querySelector('.entry-browser-mark')?.remove();
    if (state) {
      const mark = state === 'working' ? makeMark() : document.createElement('span');
      mark.classList.add('entry-browser-mark', state === 'working' ? 'entry-run' : `entry-${state}`);
      mark.setAttribute('aria-hidden', 'true');
      button.append(mark);
    }
  }

  /** 開いたときだけ、Chrome の動き・依頼待ちを優先する。開いている間の切り替えはタブから行う */
  function toggle() {
    if (open()) {
      preview.close(false);
      button.focus({ preventScroll: true });
    } else {
      const id = activeId();
      const state = id ? getChromeState(id) : 'idle';
      const urgent = id && (waiting(id) || windows?.operating(id) || state === 'running' || state === 'paused');
      const view = browserViewToOpen({ viewer: !!browser, chrome: chromeAvailable() && !!id, urgent, last: lastView.get(id) });
      if (view === 'chrome') chrome()?.open(button);
      else if (view === 'viewer') { preview.openBrowser(button); browser.open(); }
    }
    paint();
  }

  button.addEventListener('click', toggle);
  document.addEventListener('keydown', (event) => {
    if (!isBrowserShortcut(event, mac) || button.hidden || blocked()) return;
    event.preventDefault();
    toggle();
  });
  // 内蔵ブラウザーのページにフォーカスがあるときの近道（desktop/browser-panel.cjs の before-input-event）
  bridge?.onShortcut?.(() => { if (!button.hidden && !blocked()) toggle(); });
  paint();
  return { paint, toggle, lastView };
}
