// サインイン時の起動の画面（設定 › リモート › 常駐）の表示の決め方。DOM を持たない部分（web/login-item-view.mjs）を確かめる
import { loginItemView } from '../../web/login-item-view.mjs';

export const name = 'login-item-ui';
export const title = 'サインイン時の起動の画面: OS の実際の状態で表示し、使えない構成は出さない・リモート受付がオンでオフなら 1 行すすめる';

export default async function(t) {
  const on = { supported: true, enabled: true, blocked: false };
  const off = { supported: true, enabled: false, blocked: false };
  const blocked = { supported: true, enabled: false, blocked: true };

  t.ok('状態が無い（まだ読めていない）・使えない構成は出さない',
    loginItemView(null).visible === false && loginItemView({ supported: false, reason: 'dev', enabled: false, blocked: false }).visible === false
    && loginItemView({ supported: false, reason: 'store' }, { remoteEnabled: true }).recommend === false);
  t.ok('オンは OS の状態どおりチェックされ、すすめない', (v => v.visible && v.checked === true && v.recommend === false && v.blocked === false)(loginItemView(on, { remoteEnabled: true })));
  t.ok('オフでリモートの受付がオンなら、すすめる（ホストが再起動しても委譲を受けられるように）', (v => v.visible && v.checked === false && v.recommend === true)(loginItemView(off, { remoteEnabled: true })));
  t.ok('オフでもリモートの受付がオフなら、すすめない（画面を増やさない）', loginItemView(off, { remoteEnabled: false }).recommend === false);
  t.ok('OS 側で無効にされていたら blocked（チェックは外れたまま）。すすめる代わりにそれを言う',
    (v => v.visible && v.checked === false && v.blocked === true && v.recommend === false)(loginItemView(blocked, { remoteEnabled: true })));
  t.ok('すすめる条件は「リモートの受付がオン」だけを見る（状態が読めない間は出さない）', loginItemView(undefined, { remoteEnabled: true }).recommend === false);
}
