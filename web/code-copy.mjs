import { copyIcon, checkIcon } from './icons.mjs';
import { t } from './i18n.mjs';

// 結果を1.8秒だけボタンに出し、元のアイコンとラベルへ戻す。
// 連打しても最後の1回だけが残るよう、タイマーはボタンに持たせる。
function flash(button, { icon, title, restoreIcon = copyIcon, restoreTitle }) {
  const label = (node, text) => { node.title = text; node.setAttribute('aria-label', text); };
  button.innerHTML = icon;
  label(button, title);
  clearTimeout(button.copyTimer);
  button.copyTimer = setTimeout(() => { button.innerHTML = restoreIcon; label(button, restoreTitle); }, 1800);
}

/**
 * 文字列をクリップボードへ。コードと違い選択させる元の要素が無いので、
 * 失敗はその場でボタンに出す（黙って何も起きない、を作らない）。
 */
export async function copyText(button, text, label) {
  try {
    if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable');
    await navigator.clipboard.writeText(String(text ?? ''));
    flash(button, { icon: checkIcon, title: t('timeline.code.copied'), restoreTitle: label });
  } catch {
    flash(button, { icon: copyIcon, title: t('timeline.code.copyFailed'), restoreTitle: label });
  }
}

// ストリーム中にブロックが置き換わっても、会話・ツール・設定で同じ操作を使える。
export function setupCodeCopy(root = document) {
  root.addEventListener('click', async event => {
    const button = event.target.closest?.('.code-copy');
    const code = button?.closest('.code-block')?.querySelector('pre code');
    if (!code) return;
    try {
      if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable');
      await navigator.clipboard.writeText(code.textContent);
      flash(button, { icon: checkIcon, title: t('timeline.code.copied'), restoreTitle: t('timeline.code.copy') });
    } catch {
      const selection = getSelection(), range = document.createRange();
      range.selectNodeContents(code);
      selection.removeAllRanges();
      selection.addRange(range);
      flash(button, { icon: copyIcon, title: t('timeline.code.selected'), restoreTitle: t('timeline.code.copy') });
    }
  });
}
