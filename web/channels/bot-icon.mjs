import { el } from '../dom.mjs';

/** bot の画像があれば写しを表示し、古い bot は絵文字のまま表示する。 */
export function botIcon(bot, className, fallback = '🤖') {
  const root = el('span', className);
  if (bot?.iconImage) {
    const img = el('img', 'bot-icon-image');
    img.src = `/local-file?path=${encodeURIComponent(bot.iconImage)}`;
    img.alt = '';
    img.draggable = false;
    img.onerror = () => { root.textContent = bot?.icon || fallback; };
    root.append(img);
  } else root.textContent = bot?.icon || fallback;
  return root;
}
