// 会話の頭の行の、右パネルを開くアイコンボタン（docs/design-system.md「会話の頭の行のアイコン」）。
//   - プラグイン（#contextEntry）: 件数は画面に出さず、title と読み上げの名前にだけ入れる。「変更あり」は右上の点
//   - 内蔵ブラウザー（#browserEntry）: デスクトップ版のホストの画面だけ。右パネルをブラウザーにする・閉じる。
//     近道は Ctrl+Shift+B（macOS は ⌘⇧B）。内蔵ブラウザーのページにフォーカスがあるときは main が拾って知らせる
import { t } from './i18n.mjs';
import { runMark } from './arc.mjs';
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

/**
 * 内蔵ブラウザーのボタン。browser は web/browser-panel.mjs の createBrowserPanel の返り値（使えない画面では null）、
 * preview は web/file-preview.mjs の返り値（openBrowser・browserOpen・close）。
 * bridge は preload の plyDesktop.browser（ページにフォーカスがあるときの近道）。blocked() が true の間は近道を効かせない（設定・ダイアログ）。
 * 使えない画面ではボタンを出さず null を返す
 */
export function setupBrowserEntry({ button, browser, preview, getSessionId = () => null, getAgentName = () => 'Agent', mac = isMac(), bridge = null, blocked = () => false, mark: makeMark = runMark }) {
  if (!button) return null;
  if (!browser) { button.hidden = true; return null; }
  button.hidden = false;
  button.title = t('browser.entry', { keys: browserShortcutLabel(mac) });
  button.setAttribute('aria-keyshortcuts', mac ? 'Meta+Shift+B' : 'Control+Shift+B');

  function paint() {
    const open = !!preview.browserOpen();
    button.setAttribute('aria-pressed', String(open));
    button.classList.toggle('on', open);
    const agent = browser.state?.agent;
    const working = !!agent && agent.sessionId === getSessionId();
    button.setAttribute('aria-label', working ? t('browser.entryWorking', { name: getAgentName() }) : t('browser.entryLabel'));
    // 走っている印は操作中の間だけ DOM に置く（web/arc.mjs）
    const mark = button.querySelector('.entry-run');
    if (working && !mark) {
      const run = makeMark();
      run.classList.add('entry-run');
      run.setAttribute('aria-hidden', 'true');
      button.append(run);
    } else if (!working && mark) mark.remove();
  }

  /** 右パネルがブラウザーなら閉じ、そうでなければブラウザーにする。前のタブがあればそのまま、無ければ空の新しいタブ */
  function toggle() {
    if (preview.browserOpen()) {
      preview.close(false);
      button.focus({ preventScroll: true });
    } else {
      preview.openBrowser(button);
      browser.open();
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
  return { paint, toggle };
}
