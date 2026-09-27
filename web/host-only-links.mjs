// ホストの PC でしか意味を持たないリンク（localhost・ループバック）を、ほかの端末の画面で押したときに止めて知らせる
// （docs/remote.md §8.5）。リモートの窓でも LAN のブラウザーでも、その URL は端末自身を指してしまう。
// 同じ判定を殻も持つ（desktop/remote-windows.cjs の linkTarget、Android の LinkPolicy）。
import { t } from './i18n.mjs';

const LOOPBACK_V4 = /^127(?:\.\d{1,3}){3}$/;

/** href がループバックの http(s) で、この画面のオリジンではないか。hostname は URL が正規化したもの（10 進の IPv4 なども 127.x になる） */
export function isHostOnlyUrl(href, pageOrigin) {
  let u;
  try { u = new URL(href, pageOrigin); } catch { return false; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  if (u.origin === pageOrigin) return false;
  const h = u.hostname.toLowerCase().replace(/\.$/, '');
  return h === 'localhost' || h.endsWith('.localhost') || LOOPBACK_V4.test(h) || h === '0.0.0.0'
    || h === '[::1]' || h === '[::]' || /^\[::ffff:(?:127\.|7f)/.test(h);
}

/**
 * 画面の中のリンクの押下を見張る（取り込みの段階で、ほかの処理より先に）。
 * onHostScreen() が true（サーバーのある PC の画面）なら何もしない。iframe の中のリンクはここに来ない
 */
export function watchHostOnlyLinks({ onHostScreen, notify, root = document, origin = () => location.origin }) {
  const handler = event => {
    if (event.defaultPrevented || (event.type === 'auxclick' && event.button !== 1) || onHostScreen()) return;
    const a = event.target?.closest?.('a[href]');
    if (!a || !isHostOnlyUrl(a.getAttribute('href'), origin())) return;
    event.preventDefault();
    notify(t('timeline.link.hostOnly'));
  };
  root.addEventListener('click', handler, true);
  root.addEventListener('auxclick', handler, true);
  return () => { root.removeEventListener('click', handler, true); root.removeEventListener('auxclick', handler, true); };
}
